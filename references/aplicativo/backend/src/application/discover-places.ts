import { mapConcurrent } from '../infrastructure/runtime/concurrency.js';
import type { PlacesPort } from '../domain/ports.js';
import type { PlaceSummary } from '../domain/place.js';
import type { Coordinate, Viewport } from '../domain/value-objects.js';
import { haversineMeters } from '../domain/value-objects.js';
import { createPopularityScore, isNonAttraction } from './place-ranking.js';

// O searchNearby do Google limita cada busca a um círculo de 50km de raio.
// Para cobrir raios maiores (até 100km) sem buracos, dividimos a área num
// círculo central de 50km mais N satélites de 50km num anel ao redor. Os
// satélites ficam a distância (R-50km)*1.5 para que a sobreposição feche também
// a borda externa entre eles; o excedente que cai fora do raio pedido é
// descartado depois por distância. 6 satélites cobrem até 90km; acima disso a
// borda exige 7. Verificado numericamente em latitudes de 0° a 70°.
const NEARBY_MAX_RADIUS_METERS = 50_000;
const SATELLITE_DISTANCE_FACTOR = 1.5;
const SEVEN_SATELLITE_THRESHOLD_METERS = 90_000;
const EARTH_RADIUS_METERS = 6_371_000;

interface SearchCircle {
  center: Coordinate;
  radiusMeters: number;
}

function offsetCoordinate(origin: Coordinate, distanceMeters: number, bearingDegrees: number): Coordinate {
  const angular = distanceMeters / EARTH_RADIUS_METERS;
  const bearing = (bearingDegrees * Math.PI) / 180;
  const lat = (origin.latitude * Math.PI) / 180;
  const lng = (origin.longitude * Math.PI) / 180;
  const nextLat = Math.asin(
    Math.sin(lat) * Math.cos(angular) + Math.cos(lat) * Math.sin(angular) * Math.cos(bearing),
  );
  const nextLng =
    lng +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat),
      Math.cos(angular) - Math.sin(lat) * Math.sin(nextLat),
    );
  return {
    latitude: (nextLat * 180) / Math.PI,
    longitude: (nextLng * 180) / Math.PI,
  };
}

export { haversineMeters };

// Decompõe o raio pedido em círculos de busca de no máximo 50km. Para R<=50km,
// um único círculo central. Para R>50km, centro de 50km + N satélites de 50km
// num anel à distância min((R-50km)*1.5, R-3km), garantindo cobertura de 100%
// do disco de raio R.
export function buildSearchCircles(center: Coordinate, radiusMeters: number): SearchCircle[] {
  if (radiusMeters <= NEARBY_MAX_RADIUS_METERS) {
    return [{ center, radiusMeters }];
  }
  const ring = radiusMeters - NEARBY_MAX_RADIUS_METERS;
  const satelliteDistance = Math.min(ring * SATELLITE_DISTANCE_FACTOR, radiusMeters - 3_000);
  const satelliteCount = radiusMeters > SEVEN_SATELLITE_THRESHOLD_METERS ? 7 : 6;
  const circles: SearchCircle[] = [{ center, radiusMeters: NEARBY_MAX_RADIUS_METERS }];
  for (let i = 0; i < satelliteCount; i += 1) {
    const bearing = (360 / satelliteCount) * i;
    circles.push({
      center: offsetCoordinate(center, satelliteDistance, bearing),
      radiusMeters: NEARBY_MAX_RADIUS_METERS,
    });
  }
  return circles;
}

// O Nearby Search usa restrição de raio: nada além do círculo entra, o que
// esconde âncoras regionais (ex.: Torres del Paine a 300km de Punta Arenas).
// O Text Search usa *bias* (preferência suave): atrações de alta relevância
// regional retornam mesmo distantes. As queries abaixo capturam essa camada.
export const REGIONAL_BUCKET_ID = '__regional__';
const REGIONAL_QUERIES = [
  (destination: string) => `melhores atrações turísticas na região de ${destination}`,
  (destination: string) => `atrações naturais e parques nacionais perto de ${destination}`,
];
const REGIONAL_RESULTS_PER_QUERY = 15;

// Teto de sanidade geográfica. A busca textual (camada regional e por nome)
// usa bias suave e ocasionalmente retorna homônimos em outro continente
// (um "Puerto Madero" em Miami numa viagem a Buenos Aires), que envenenam a
// matriz de distância. O teto é ABSOLUTO (não escala com o raio de descoberta,
// que pode ser pequeno numa cidade-base compacta): precisa cortar o homônimo a
// milhares de km mas manter day-trips regionais legítimos (Torres del Paine a
// ~90km de Puerto Natales, Teotihuacán a ~50km da CDMX, Jökulsárlón a ~80km de
// Höfn). 250km cobre os maiores day-trips reais sem deixar passar absurdos.
const GEO_SANITY_MAX_DISTANCE_METERS = 250_000;

const DEFAULT_POI_TYPES = [
  'tourist_attraction',
  'museum',
  'park',
  'art_gallery',
  'historical_landmark',
  'amusement_park',
  'aquarium',
  'zoo',
  'church',
  'monument',
];

const HOTEL_TYPES = ['lodging', 'hotel', 'hostel', 'motel', 'guest_house'];

// Apenas hospedagem é filtrada no servidor: é o caso onde a sobreposição
// com `tourist_attraction` causa contaminação real (hotéis famosos).
// Restante do filtro (lojas, bancos, etc.) acontece no cliente via
// `isNonAttraction` — passar lista grande pro Google causa zero resultados
// em certas combinações.
const ATTRACTION_EXCLUDED_TYPES = [
  'bed_and_breakfast',
  'budget_japanese_inn',
  'camping_cabin',
  'campground',
  'cottage',
  'extended_stay_hotel',
  'farmstay',
  'guest_house',
  'hostel',
  'hotel',
  'inn',
  'japanese_inn',
  'lodging',
  'mobile_home_park',
  'motel',
  'private_guest_room',
  'resort_hotel',
  'rv_park',
];

export class DiscoverPlacesUseCase {
  constructor(private readonly places: PlacesPort) {}

  attractions(input: {
    viewport?: Viewport;
    location?: Coordinate;
    radiusMeters?: number;
    maxResultCount?: number;
    includedTypes?: string[];
  }): Promise<PlaceSummary[]> {
    return this.places.searchNearby({
      viewport: input.viewport,
      location: input.location,
      radiusMeters: input.radiusMeters ?? 10_000,
      maxResultCount: input.maxResultCount ?? 20,
      includedTypes: input.includedTypes ?? DEFAULT_POI_TYPES,
    });
  }

  lodging(input: {
    viewport?: Viewport;
    location?: Coordinate;
    radiusMeters?: number;
    maxResultCount?: number;
  }): Promise<PlaceSummary[]> {
    return this.places.searchNearby({
      viewport: input.viewport,
      location: input.location,
      radiusMeters: input.radiusMeters ?? 5_000,
      maxResultCount: input.maxResultCount ?? 15,
      includedTypes: HOTEL_TYPES,
    });
  }

  searchByText(input: {
    query: string;
    location?: Coordinate;
    radiusMeters?: number;
    maxResultCount?: number;
  }): Promise<PlaceSummary[]> {
    return this.places.searchText({
      query: input.query,
      location: input.location,
      radiusMeters: input.radiusMeters,
      maxResultCount: input.maxResultCount ?? 15,
    });
  }

  async discover(input: {
    viewport?: Viewport;
    location?: Coordinate;
    radiusMeters?: number;
    buckets: Array<{ id: string; types: string[] }>;
    includeSurprise: boolean;
    destinationName?: string;
  }): Promise<Array<{ id: string; places: PlaceSummary[] }>> {
    const radiusMeters = input.radiusMeters ?? 10_000;
    // Quando temos um centro explícito, decompomos o raio pedido em N círculos
    // de busca (1 se <=50km; centro + 6 satélites se maior). Cada círculo é uma
    // chamada cacheada por centro+raio. Sem centro (só viewport), mantemos uma
    // única busca pelo viewport.
    const circles: SearchCircle[] = input.location
      ? buildSearchCircles(input.location, radiusMeters)
      : [];

    const searchBucket = async (includedTypes: string[]): Promise<PlaceSummary[]> => {
      if (circles.length === 0) {
        return this.places.searchNearby({
          viewport: input.viewport,
          radiusMeters,
          maxResultCount: 20,
          includedTypes,
          excludedTypes: ATTRACTION_EXCLUDED_TYPES,
        });
      }
      const merged = new Map<string, PlaceSummary>();
      // Centro primeiro. Expansão só quando ainda faltam opções nesta categoria.
      for (const circle of circles) {
        const found = await this.places.searchNearby({
          location: circle.center, radiusMeters: circle.radiusMeters,
          maxResultCount: 20, includedTypes, excludedTypes: ATTRACTION_EXCLUDED_TYPES,
        }).catch(() => [] as PlaceSummary[]);
        for (const place of found) {
          if (!input.location || haversineMeters(input.location, place.coordinate) <= radiusMeters) merged.set(place.placeId, place);
        }
        if (merged.size >= 20) break;
      }
      const all = Array.from(merged.values());
      // Multi-círculo: os satélites buscam além do raio pedido para fechar a
      // borda. Descarta o excedente para o resultado coincidir com o círculo
      // que o usuário viu no mapa.
      if (circles.length > 1 && input.location) {
        const origin = input.location;
        return all.filter((place) => haversineMeters(origin, place.coordinate) <= radiusMeters);
      }
      return all;
    };

    const bucketRequests = mapConcurrent(input.buckets, 3, async (bucket) => {
      try {
        const places = await searchBucket(bucket.types);
        return { id: bucket.id, places };
      } catch {
        return { id: bucket.id, places: [] };
      }
    });

    const surpriseRequest = input.includeSurprise
      ? searchBucket(DEFAULT_POI_TYPES)
          .then((places) => ({ id: '__surprise__', places }))
          .catch(() => ({ id: '__surprise__', places: [] as PlaceSummary[] }))
      : null;

    const regionalRequest =
      input.destinationName && input.location
        ? Promise.all(
            REGIONAL_QUERIES.map((buildQuery) =>
              this.places
                .searchText({
                  query: buildQuery(input.destinationName as string),
                  location: input.location,
                  radiusMeters: NEARBY_MAX_RADIUS_METERS,
                  maxResultCount: REGIONAL_RESULTS_PER_QUERY,
                })
                .catch(() => [] as PlaceSummary[]),
            ),
          ).then((results) => {
            const merged = new Map<string, PlaceSummary>();
            for (const places of results) {
              for (const place of places) merged.set(place.placeId, place);
            }
            return { id: REGIONAL_BUCKET_ID, places: Array.from(merged.values()) };
          })
        : null;

    const bucketResults = await bucketRequests;
    const surpriseResult = surpriseRequest ? await surpriseRequest : null;
    const regionalResult = regionalRequest ? await regionalRequest : null;

    const seen = new Set<string>();
    const ranked: Array<{ id: string; places: PlaceSummary[] }> = [];
    for (const bucket of bucketResults) {
      const unique = bucket.places.filter((place) => {
        if (seen.has(place.placeId)) return false;
        seen.add(place.placeId);
        return true;
      });
      ranked.push({ id: bucket.id, places: unique });
    }
    if (surpriseResult) {
      const unique = surpriseResult.places.filter((place) => {
        if (seen.has(place.placeId)) return false;
        seen.add(place.placeId);
        return true;
      });
      ranked.push({ id: surpriseResult.id, places: unique });
    }
    if (regionalResult) {
      const unique = regionalResult.places.filter((place) => {
        if (seen.has(place.placeId)) return false;
        seen.add(place.placeId);
        return true;
      });
      ranked.push({ id: regionalResult.id, places: unique });
    }

    // Sanidade geográfica: descarta homônimos absurdamente distantes que a
    // busca textual ocasionalmente retorna e que arruinariam a matriz.
    if (input.location) {
      const origin = input.location;
      for (const bucket of ranked) {
        bucket.places = bucket.places.filter(
          (place) => haversineMeters(origin, place.coordinate) <= GEO_SANITY_MAX_DISTANCE_METERS,
        );
      }
    }

    // Filtro de qualidade + ranking no servidor: remove não-atrações (agências
    // de turismo, bares, terminais, lojas) e ordena cada bucket por relevância
    // turística (popularidade bayesiana + iconicidade − gravidade de distância).
    // Antes isso vivia só no cliente, o que tornava a qualidade dependente do
    // bundle do app; centralizando aqui, qualquer cliente recebe o conjunto já
    // limpo e ordenado. Os tipos pedidos pelo usuário (buckets) isentam o que
    // foi escolhido explicitamente (ex.: quem busca "vinícola" recebe vinícola).
    const selectedTypes = new Set<string>();
    for (const bucket of input.buckets) {
      for (const type of bucket.types) selectedTypes.add(type);
    }
    const scoreOrigin = input.location
      ? { center: input.location, radiusMeters }
      : undefined;
    for (const bucket of ranked) {
      const clean = bucket.places.filter((place) => !isNonAttraction(place, selectedTypes));
      const score = createPopularityScore(clean, scoreOrigin);
      bucket.places = clean.slice().sort((a, b) => score(b) - score(a));
    }

    return ranked;
  }
}
