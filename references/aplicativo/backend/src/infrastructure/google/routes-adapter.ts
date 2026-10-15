import { mapConcurrent } from '../runtime/concurrency.js';
import { recordCost } from '../cost/cost-context.js';
import { attachDeadline } from '../runtime/deadline.js';
import axios, { type AxiosInstance } from 'axios';
import type { RouteMatrix, RouteSegment, RoutesPort } from '../../domain/ports.js';
import type { Coordinate, TravelMode } from '../../domain/value-objects.js';
import type { CachePort } from '../../domain/cache.js';
import { haversineMeters } from '../../domain/value-objects.js';
import { hashKey, quantizeCoordinate, withCache } from '../cache/with-cache.js';

const FIELD_MASK = 'originIndex,destinationIndex,duration,distanceMeters,condition';
const ROUTES_MATRIX_TTL_SECONDS = 90 * 24 * 60 * 60;

const MODE_MAP: Record<TravelMode, string> = {
  car: 'DRIVE',
  transit: 'TRANSIT',
  walk: 'WALK',
};

// Limite de elementos (origens × destinos) por requisição da Route Matrix:
// 625 para DRIVE/WALK; 100 para TRANSIT (Google Routes API).
const MATRIX_ELEMENT_LIMITS: Record<TravelMode, number> = {
  car: 625,
  transit: 100,
  walk: 625,
};

// Quando o Google não traça rota de carro (POI sem acesso rodoviário, como
// uma trilha dentro de um parque, ou coordenada fora de via), estimamos por
// linha reta a uma velocidade média plausível. Isso mantém a matriz sã — o
// que importa é o solver saber se a atividade cabe no dia, não a navegação.
const ESTIMATE_SPEED_KMPH = 40;
const ESTIMATE_SPEED_MPS = (ESTIMATE_SPEED_KMPH * 1000) / 3600;

/**
 * Componentes conexas das posições roteáveis sob o limiar de distância: existe
 * aresta entre dois pontos quando a linha reta entre eles é ≤ maxRouted. Como
 * todo par abaixo do limiar fica na mesma componente, pedir a submatriz cheia
 * de cada componente cobre todos os pares que a resposta realmente aproveita.
 */
export function routableClusters(
  coordinates: Coordinate[],
  routable: number[],
  maxRouted: number,
): number[][] {
  if (!Number.isFinite(maxRouted)) return [routable];
  const n = routable.length;
  const parent = routable.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[i] !== root) {
      const next = parent[i]!;
      parent[i] = root;
      i = next;
    }
    return root;
  };
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = coordinates[routable[i]!]!;
      const b = coordinates[routable[j]!]!;
      if (haversineMeters(a, b) > maxRouted) continue;
      const ra = find(i);
      const rb = find(j);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    const bucket = byRoot.get(root);
    if (bucket) bucket.push(routable[i]!);
    else byRoot.set(root, [routable[i]!]);
  }
  return Array.from(byRoot.values());
}

function estimateDurationSeconds(distanceMeters: number): number {
  return Math.round(distanceMeters / ESTIMATE_SPEED_MPS);
}

interface RawCell {
  originIndex?: number;
  destinationIndex?: number;
  duration?: string;
  distanceMeters?: number;
  condition?: string;
}

export class GoogleRoutesAdapter implements RoutesPort {
  private readonly client: AxiosInstance;

  constructor(private readonly apiKey: string, private readonly cache?: CachePort) {
    this.client = axios.create({
      baseURL: 'https://routes.googleapis.com',
      timeout: 30_000,
    });
    attachDeadline(this.client);
  }

  async computeMatrix(input: {
    coordinates: Coordinate[];
    mode: TravelMode;
    maxRoutedDistanceMeters?: number;
  }): Promise<RouteMatrix> {
    // Canonicaliza posições únicas antes da chave; remapeia cada índice na saída.
    const keys = input.coordinates.map((c) => `${quantizeCoordinate(c.latitude, 4)},${quantizeCoordinate(c.longitude, 4)}`);
    const uniqueKeys = [...new Set(keys)].sort();
    const canonicalCoordinates = uniqueKeys.map((key) => {
      const [latitude, longitude] = key.split(',').map(Number);
      return { latitude: latitude!, longitude: longitude! };
    });
    const indices = new Map(uniqueKeys.map((key, index) => [key, index]));
    const mapping = keys.map((key) => indices.get(key)!);
    const matrix = await this.computeCanonicalMatrix({ ...input, coordinates: canonicalCoordinates });
    const fallbacks = new Map(matrix.fallbackPairs.map((pair) => [`${pair.originIndex}:${pair.destinationIndex}`, pair.reason]));
    return {
      durationsSeconds: mapping.map((from) => mapping.map((to) => matrix.durationsSeconds[from]![to]!)),
      distancesMeters: mapping.map((from) => mapping.map((to) => matrix.distancesMeters[from]![to]!)),
      fallbackPairs: mapping.flatMap((from, i) => mapping.flatMap((to, j) => {
        const reason = fallbacks.get(`${from}:${to}`);
        return reason ? [{ originIndex: i, destinationIndex: j, reason }] : [];
      })),
    };
  }

  private async computeCanonicalMatrix(input: Parameters<RoutesPort['computeMatrix']>[0]): Promise<RouteMatrix> {
    const size = input.coordinates.length;
    if (size < 2) {
      return {
        durationsSeconds: Array.from({ length: size }, () => [0]),
        distancesMeters: Array.from({ length: size }, () => [0]),
        fallbackPairs: [],
      };
    }

    // Coordenadas repetidas (nós co-localizados, ex. alternativa de refeição
    // na mesma posição de uma atração) não custam elementos: só o primeiro
    // índice de cada posição vai à Routes API; os clones copiam a linha/coluna.
    const quantKeys = input.coordinates.map(
      (c) => `${quantizeCoordinate(c.latitude, 4)},${quantizeCoordinate(c.longitude, 4)}`,
    );
    const repByKey = new Map<string, number>();
    const repOf = quantKeys.map((qk, index) => {
      const existing = repByKey.get(qk);
      if (existing !== undefined) return existing;
      repByKey.set(qk, index);
      return index;
    });
    const routable = Array.from(repByKey.values());
    const maxRouted = input.maxRoutedDistanceMeters ?? Number.POSITIVE_INFINITY;

    // Pares acima de maxRouted são descartados na leitura da resposta (ficam na
    // baseline Haversine), então pedi-los ao Google é elemento pago e jogado
    // fora. Agrupamos as posições em componentes conexas sob o limiar: se dois
    // pontos estão a ≤ maxRouted, existe aresta entre eles e caem no mesmo
    // grupo, logo nenhum par aproveitável deixa de ser consultado. Pares entre
    // grupos distintos estão todos acima do limiar — exatamente os que já eram
    // descartados. Numa cidade só, o resultado é um grupo e nada muda.
    const clusters = routableClusters(input.coordinates, routable, maxRouted);

    // A Route Matrix é cobrada por elemento: cada grupo pede |grupo|² elementos.
    const matrixElements = clusters.reduce(
      (sum, cluster) => (cluster.length >= 2 ? sum + cluster.length * cluster.length : sum),
      0,
    );
    const key = `routes:matrix:v3:${hashKey([
      input.mode,
      String(maxRouted),
      quantKeys.join('|'),
    ])}`;
    return withCache(this.cache, key, ROUTES_MATRIX_TTL_SECONDS, async () => {
      // Baseline: toda a matriz por linha reta. Os pares "próximos" entre
      // posições únicas são então sobrescritos com a rota real do Google. O
      // resto (pares distantes) fica na linha reta — não custa elemento.
      const durations = this.zeroMatrix(size);
      const distances = this.zeroMatrix(size);
      for (let i = 0; i < size; i += 1) {
        for (let j = 0; j < size; j += 1) {
          if (i === j) continue;
          const straight = haversineMeters(input.coordinates[i]!, input.coordinates[j]!);
          distances[i]![j] = Math.round(straight);
          durations[i]![j] = estimateDurationSeconds(straight);
        }
      }

      const fallbackPairs: RouteMatrix['fallbackPairs'] = [];
      if (routable.length >= 2) {
        for (const cluster of clusters) {
          if (cluster.length < 2) continue;
          await this.fetchRoutableMatrix({
            coordinates: input.coordinates,
            routable: cluster,
            maxRouted,
            mode: input.mode,
            durations,
            distances,
            fallbackPairs,
          });
        }
        // Propaga os valores roteados para os índices clones (mesma posição).
        for (let i = 0; i < size; i += 1) {
          for (let j = 0; j < size; j += 1) {
            if (i === j) continue;
            const ri = repOf[i]!;
            const rj = repOf[j]!;
            if (ri === i && rj === j) continue;
            if (ri === rj) continue;
            durations[i]![j] = durations[ri]![rj]!;
            distances[i]![j] = distances[ri]![rj]!;
          }
        }
      }

      return { durationsSeconds: durations, distancesMeters: distances, fallbackPairs };
    }, matrixElements > 0 ? { sku: 'routes.matrix', calls: matrixElements, recordMiss: false } : undefined);
  }

  // Busca no Google só a sub-matriz dos índices roteáveis, em blocos que
  // respeitam o limite de elementos. Sobrescreve a baseline Haversine apenas
  // para pares cuja distância em linha reta está dentro de maxRouted (pares
  // distantes não valem o custo — a precisão da rota não muda o roteiro).
  private async fetchRoutableMatrix(input: {
    coordinates: Coordinate[];
    routable: number[];
    maxRouted: number;
    mode: TravelMode;
    durations: number[][];
    distances: number[][];
    fallbackPairs: RouteMatrix['fallbackPairs'];
  }): Promise<void> {
    const { routable, coordinates, mode, durations, distances, fallbackPairs, maxRouted } = input;
    type Pair = { durationSeconds: number; distanceMeters: number };
    const coordinateKey = (index: number) => `${quantizeCoordinate(coordinates[index]!.latitude, 4)},${quantizeCoordinate(coordinates[index]!.longitude, 4)}`;
    const pairKey = (from: number, to: number) => `routes:pair:v1:${mode}:${coordinateKey(from)}:${coordinateKey(to)}`;
    const pairs = routable.flatMap((from) => routable.filter((to) => from !== to && distances[from]![to]! <= maxRouted).map((to) => ({ from, to, key: pairKey(from, to) })));
    const chunks = [];
    for (let index = 0; index < pairs.length; index += 1000) chunks.push(pairs.slice(index, index + 1000));
    const cached = (await mapConcurrent(chunks, 4, async (chunk) => {
      if (!this.cache) return chunk.map(() => null);
      if (this.cache.getMany) return this.cache.getMany<Pair>(chunk.map((pair) => pair.key)).catch(() => chunk.map(() => null));
      return mapConcurrent(chunk, 8, (pair) => this.cache!.get<Pair>(pair.key).catch(() => null));
    })).flat();
    const missingByOrigin = new Map<number, number[]>();
    let hits = 0;
    pairs.forEach((pair, index) => {
      const hit = cached[index];
      if (hit) { durations[pair.from]![pair.to] = hit.durationSeconds; distances[pair.from]![pair.to] = hit.distanceMeters; hits++; }
      else { const missing = missingByOrigin.get(pair.from) ?? []; missing.push(pair.to); missingByOrigin.set(pair.from, missing); }
    });
    if (hits) recordCost({ sku: 'routes.matrix', calls: hits, cached: true });
    // Origens com os mesmos destinos pendentes compartilham um bloco. Em cache
    // frio, incluir a diagonal permite uma única matriz compacta, sem N requests.
    const fullyCold = missingByOrigin.size === routable.length && [...missingByOrigin.values()].every((missing) => missing.length === routable.length - 1);
    const groups = new Map<string, { origins: number[]; destinations: number[] }>();
    for (const [origin, missing] of missingByOrigin) {
      const destinations = fullyCold ? routable : missing;
      const key = destinations.join(',');
      const group = groups.get(key) ?? { origins: [], destinations };
      group.origins.push(origin); groups.set(key, group);
    }
    const limit = MATRIX_ELEMENT_LIMITS[mode];
    for (const group of groups.values()) {
      for (let destinationStart = 0; destinationStart < group.destinations.length; destinationStart += limit) {
        const destIndices = group.destinations.slice(destinationStart, destinationStart + limit);
        const originBlockSize = Math.max(1, Math.floor(limit / destIndices.length));
        for (let originStart = 0; originStart < group.origins.length; originStart += originBlockSize) {
          const originIndices = group.origins.slice(originStart, originStart + originBlockSize);
          recordCost({ sku: 'routes.matrix', calls: originIndices.length * destIndices.length, cached: false });
          const block = await this.fetchMatrixBlock(originIndices.map((i) => coordinates[i]!), destIndices.map((i) => coordinates[i]!), mode);
          const fresh: { key: string; value: Pair }[] = [];
          for (const cell of block) {
            const from = originIndices[cell.localOrigin];
            const to = destIndices[cell.destination];
            if (from === undefined || to === undefined || from === to) continue;
            if (cell.condition !== 'ROUTE_EXISTS' || cell.duration === undefined) {
              fallbackPairs.push({ originIndex: from, destinationIndex: to, reason: cell.condition ?? 'NO_ROUTE' });
              continue;
            }
            const value = { durationSeconds: this.parseDurationSeconds(cell.duration), distanceMeters: cell.distanceMeters ?? distances[from]![to]! };
            durations[from]![to] = value.durationSeconds; distances[from]![to] = value.distanceMeters;
            fresh.push({ key: pairKey(from, to), value });
          }
          if (this.cache?.setMany) await this.cache.setMany(fresh, ROUTES_MATRIX_TTL_SECONDS).catch(() => undefined);
          else await mapConcurrent(fresh, 8, async ({ key, value }) => { await this.cache?.set(key, value, ROUTES_MATRIX_TTL_SECONDS).catch(() => undefined); });
        }
      }
    }
  }

  private async fetchMatrixBlock(
    originCoordinates: Coordinate[],
    destinationCoordinates: Coordinate[],
    mode: TravelMode,
  ): Promise<{ localOrigin: number; destination: number; duration?: string; distanceMeters?: number; condition?: string }[]> {
    const origins = originCoordinates.map((coordinate) => ({ waypoint: { location: { latLng: coordinate } } }));
    const destinations = destinationCoordinates.map((coordinate) => ({ waypoint: { location: { latLng: coordinate } } }));
    const body: Record<string, unknown> = {
      origins,
      destinations,
      travelMode: MODE_MAP[mode],
    };
    const { data } = await this.client.post('/distanceMatrix/v2:computeRouteMatrix', body, {
      headers: {
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
        'Content-Type': 'application/json',
      },
    });
    const cells = (data ?? []) as RawCell[];
    return cells
      .filter((cell) => cell.originIndex !== undefined && cell.destinationIndex !== undefined)
      .map((cell) => ({
        localOrigin: cell.originIndex!,
        destination: cell.destinationIndex!,
        duration: cell.duration,
        distanceMeters: cell.distanceMeters,
        condition: cell.condition,
      }));
  }


  async computeSegment(input: {
    origin: Coordinate;
    destination: Coordinate;
    mode: TravelMode;
  }): Promise<RouteSegment | null> {
    const key = `routes:segment:v1:${hashKey([
      input.mode,
      quantizeCoordinate(input.origin.latitude, 5),
      quantizeCoordinate(input.origin.longitude, 5),
      quantizeCoordinate(input.destination.latitude, 5),
      quantizeCoordinate(input.destination.longitude, 5),
    ])}`;
    return withCache(
      this.cache,
      key,
      365 * 24 * 60 * 60,
      () => this.fetchSegment(input),
      { sku: 'routes.segment' },
    );
  }

  private async fetchSegment(input: {
    origin: Coordinate;
    destination: Coordinate;
    mode: TravelMode;
  }): Promise<RouteSegment | null> {
    const body: Record<string, unknown> = {
      origin: { location: { latLng: input.origin } },
      destination: { location: { latLng: input.destination } },
      travelMode: MODE_MAP[input.mode],
      polylineEncoding: 'ENCODED_POLYLINE',
    };

    try {
      const { data } = await this.client.post('/directions/v2:computeRoutes', body, {
        headers: {
          'X-Goog-Api-Key': this.apiKey,
          'X-Goog-FieldMask':
            'routes.polyline.encodedPolyline,routes.duration,routes.distanceMeters',
          'Content-Type': 'application/json',
        },
      });
      const route = (data?.routes ?? [])[0] as
        | {
            polyline?: { encodedPolyline?: string };
            duration?: string;
            distanceMeters?: number;
          }
        | undefined;
      const encoded = route?.polyline?.encodedPolyline;
      if (!encoded) return null;
      const segment: RouteSegment = {
        polyline: encoded,
        durationSeconds: this.parseDurationSeconds(route?.duration ?? '0s'),
        distanceMeters: route?.distanceMeters ?? 0,
      };
      return segment;
    } catch {
      return null;
    }
  }

  private zeroMatrix(size: number): number[][] {
    return Array.from({ length: size }, () => Array.from({ length: size }, () => 0));
  }

  private parseDurationSeconds(duration: string): number {
    const numeric = duration.endsWith('s') ? duration.slice(0, -1) : duration;
    const value = Number.parseFloat(numeric);
    return Number.isFinite(value) ? Math.round(value) : 0;
  }
}
