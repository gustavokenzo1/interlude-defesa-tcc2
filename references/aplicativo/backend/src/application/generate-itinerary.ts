import { checkDeadline } from '../infrastructure/runtime/deadline.js';
import type {
  PlacesPort,
  RoutesPort,
  SolverPayload,
  SolverPort,
  SolverResponse,
} from '../domain/ports.js';
import type { EnrichedPlace, OpeningHours, PlaceInsight, PlaceSummary } from '../domain/place.js';
import type {
  FlightAnchor,
  DayPlan,
  ItineraryLegRequest,
  ItineraryLegSummary,
  ItineraryRequest,
  ItinerarySolution,
  LodgingStay,
  MealAnchor,
  MealCandidate,
  RouteLeg,
  RouteStep,
  SolverTrace,
  TransitionLeg,
  UnassignedStop,
  AnchorExperienceSelection,
} from '../domain/itinerary.js';
import {
  ABSOLUTE_DAY_START_SECONDS,
  CATEGORY_TO_SLOTS,
  COMFORT_DAY_SECONDS,
  DEFAULT_PACE,
  DEFAULT_SERVICE_TIME_SECONDS,
  FIXED_TRAVEL_MODE,
  FULL_DAY_THRESHOLD_RATIO,
  MAX_SOLVER_DAYS,
  MEAL_SLOT_ORDER,
  MEAL_SLOT_PROFILES,
  NORMAL_SERVICE_CAP_SECONDS,
  OPERATING_HORIZON_SECONDS,
  PACE_PROFILES,
  RESERVATION_SLACK_SECONDS,
  type MealCategory,
  type MealSlot,
  type PaceProfile,
} from '../domain/value-objects.js';
import { haversineMeters } from '../domain/value-objects.js';
import type { Coordinate } from '../domain/value-objects.js';

// Sem pace, o teto de paradas por dia é um guarda-corpo fixo (o solver decide
// quantas cabem via tempo); o piso garante que nenhum dia fique vazio.
const FIXED_MIN_STOPS_PER_DAY = 1;
const FIXED_MAX_STOPS_PER_DAY = 8;
// Janela operacional do dia: começa cedo (6h) para acomodar passeios com
// abertura matinal e vai até o fim do horizonte. O horário de início real
// emerge das janelas das atrações, não de uma preferência do usuário.
const DAY_WINDOW_START_SECONDS = 0;
const DAY_WINDOW_END_SECONDS = OPERATING_HORIZON_SECONDS;

// Slots de refeição gerados automaticamente (fillers). Apenas o almoço: cai no
// meio do dia ativo e conflita com atrações. Café/jantar nas pontas não viram
// bloco forçado (distorciam o horário do dia).
const AUTO_FILLER_SLOTS: MealSlot[] = ['lunch'];

// Acima desta distância em linha reta, a Routes API não é consultada para o par
// (usa-se Haversine): dois pontos a >120km não são visitados em sequência num
// dia, então a precisão da rota entre eles não muda o roteiro. Day-trips
// legítimos (hotel → atração a ~90km) ficam abaixo do teto e mantêm rota real.
const ROUTED_PAIR_MAX_DISTANCE_METERS = 120_000;

const ARRIVAL_AIRPORT_STOP_ID = '__arrival_airport__';
const DEPARTURE_AIRPORT_STOP_ID = '__departure_airport__';

// Logs de diagnóstico do pipeline (ITINERARY_DEBUG=1). Cobrem os pontos onde
// bugs de roteiro se originam: janelas de tempo dos stops, refeições
// (alternativas × fillers), âncoras de transição e o que o solver descartou.
const ITINERARY_DEBUG = process.env.ITINERARY_DEBUG === '1';

function ilog(message: string): void {
  if (ITINERARY_DEBUG) console.log(`[itinerary] ${message}`);
}

function debugHhmm(secondsFromOperatingStart: number): string {
  const total = secondsFromOperatingStart + ABSOLUTE_DAY_START_SECONDS;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function describeStop(stop: InternalStop): string {
  const kind = stop.isDepot
    ? stop.transitionMode
      ? `anchor/${stop.transitionDirection}(${stop.transitionMode})`
      : 'depot'
    : stop.isMeal
      ? stop.mealMetadata?.positional
        ? `meal~${stop.mealMetadata.slot}`
        : `meal=${stop.mealMetadata?.slot}`
      : stop.fullDay
        ? 'attraction(FULL-DAY)'
        : 'attraction';
  const window = `${debugHhmm(stop.timeWindowStart)}-${debugHhmm(stop.timeWindowEnd)}`;
  const service = Math.round(stop.serviceTimeSeconds / 60);
  const fixed = stop.fixedDay !== undefined ? ` fixedDay=${stop.fixedDay}` : '';
  return `${kind} "${stop.name}" janela=${window} serviço=${service}min prio=${stop.priority}${fixed}`;
}

function lodgingStopId(legIndex: number, lodgingId: string, dayIndex = 0): string {
  return `__lodging_${legIndex}_${lodgingId}_day${dayIndex}__`;
}

function mealAltStopId(candidateId: string, dayOffset: number, slot: MealSlot): string {
  return `__meal_alt__${candidateId}__d${dayOffset}__${slot}__`;
}

// Fillers têm uma alternativa por "host" (atração ou hotel onde a refeição se
// co-localiza); o grupo de disjunção garante no máximo uma escolhida por slot.
function mealFillerStopId(legIndex: number, dayOffset: number, slot: MealSlot, hostIndex: number): string {
  return `__meal_filler__l${legIndex}__d${dayOffset}__${slot}__h${hostIndex}__`;
}

function parseMealAltId(stopId: string): { candidateId: string; dayOffset: number; slot: MealSlot } | null {
  const match = stopId.match(/^__meal_alt__(.+)__d(\d+)__(breakfast|lunch|snack|dinner)__$/);
  if (!match) return null;
  return {
    candidateId: match[1]!,
    dayOffset: Number(match[2]),
    slot: match[3] as MealSlot,
  };
}

function parseMealFillerId(stopId: string): { legIndex: number; dayOffset: number; slot: MealSlot } | null {
  const match = stopId.match(/^__meal_filler__l(\d+)__d(\d+)__(breakfast|lunch|snack|dinner)__h(\d+)__$/);
  if (!match) return null;
  return {
    legIndex: Number(match[1]),
    dayOffset: Number(match[2]),
    slot: match[3] as MealSlot,
  };
}

interface DayContext {
  date: Date | null;
  windowStartSeconds: number;
  windowEndSeconds: number;
  legId: string;
  legIndex: number;
  dayOffsetInLeg: number;
  globalDayIndex: number;
  isTransitDay?: boolean;
}

interface LegSegmentResult {
  days: DayPlan[];
  totalDistanceMeters: number;
  totalTimeSeconds: number;
  unassigned: UnassignedStop[];
  pois: PlaceSummary[];
  summary: ItineraryLegSummary;
  solverTrace: SolverTrace;
}

function mergeSolverTraces(traces: SolverTrace[]): SolverTrace {
  return {
    source: 'solver',
    engine: 'Google OR-Tools',
    model: 'VRPTW',
    generatedAt: new Date().toISOString(),
    solveDurationMs: traces.reduce((sum, trace) => sum + trace.solveDurationMs, 0),
    nodeCount: traces.reduce((sum, trace) => sum + trace.nodeCount, 0),
    consideredDirectedEdges: traces.reduce((sum, trace) => sum + trace.consideredDirectedEdges, 0),
    matrixFallbackPairs: traces.reduce((sum, trace) => sum + trace.matrixFallbackPairs, 0),
    baselineDistanceMeters: traces.reduce((sum, trace) => sum + trace.baselineDistanceMeters, 0),
    optimizedDistanceMeters: traces.reduce((sum, trace) => sum + trace.optimizedDistanceMeters, 0),
    minStopsPerDay: Math.min(...traces.map((trace) => trace.minStopsPerDay)),
    maxStopsPerDay: Math.max(...traces.map((trace) => trace.maxStopsPerDay)),
    horizonSeconds: Math.max(...traces.map((trace) => trace.horizonSeconds)),
    nodes: traces.flatMap((trace) => trace.nodes),
    solutionEdges: traces.flatMap((trace) => trace.solutionEdges),
    candidateEdges: traces.flatMap((trace) => trace.candidateEdges),
  };
}

function alignTraceToMergedDays(
  trace: SolverTrace,
  days: DayPlan[],
  originalSummaries: ItineraryLegSummary[],
  mergedSummaries: ItineraryLegSummary[],
): SolverTrace {
  const assignments = new Map<string, SolverTrace['nodes'][number]['assignments']>();
  for (const day of days) {
    for (const step of day.steps) {
      const current = assignments.get(step.stopId) ?? [];
      current.push({
        dayIndex: day.dayIndex,
        arrivalSeconds: step.arrivalSeconds,
        departureSeconds: step.departureSeconds,
      });
      assignments.set(step.stopId, current);
    }
  }
  const shiftByLeg = new Map(originalSummaries.flatMap((original) => {
    const merged = mergedSummaries.find((summary) => summary.legId === original.legId);
    return merged ? [[original.legId, merged.dayIndexStart - original.dayIndexStart] as const] : [];
  }));
  const solutionEdges = days.flatMap((day) =>
    day.legs.map((edge) => ({ ...edge, dayIndex: day.dayIndex })),
  );
  return {
    ...trace,
    optimizedDistanceMeters: solutionEdges.reduce((sum, edge) => sum + edge.distanceMeters, 0),
    nodes: trace.nodes.map((node) => {
      const shift = shiftByLeg.get(node.legId) ?? 0;
      return {
        ...node,
        assignments: assignments.get(node.stopId) ?? [],
        fixedDayIndex: node.fixedDayIndex === undefined ? undefined : node.fixedDayIndex + shift,
        allowedDayIndices: node.allowedDayIndices?.map((dayIndex) => dayIndex + shift),
      };
    }),
    solutionEdges,
  };
}

function baselineDistanceForResponse(
  payload: SolverPayload,
  response: SolverResponse,
  distances: number[][],
): number {
  const indexById = new Map(payload.stops.map((stop, index) => [stop.id, index]));
  let total = 0;
  for (const day of response.days) {
    if (day.steps.length < 2) continue;
    const startId = day.steps[0]!.stop_id;
    const endId = day.steps.at(-1)!.stop_id;
    const interior = new Set(day.steps.slice(1, -1).map((step) => step.stop_id));
    const ordered = payload.stops.filter((stop) => interior.has(stop.id)).map((stop) => stop.id);
    const sequence = [startId, ...ordered, endId];
    for (let index = 0; index < sequence.length - 1; index += 1) {
      const from = indexById.get(sequence[index]!);
      const to = indexById.get(sequence[index + 1]!);
      if (from === undefined || to === undefined) continue;
      total += distances[from]?.[to] ?? 0;
    }
  }
  return total;
}

function buildSolverTrace(input: {
  payload: SolverPayload;
  response: SolverResponse;
  days: DayPlan[];
  stops: InternalStop[];
  distances: number[][];
  durations: number[][];
  matrixFallbackPairs: number;
  solveDurationMs: number;
  baseDayIndex: number;
  legId: string;
}): SolverTrace {
  const assignments = new Map<string, SolverTrace['nodes'][number]['assignments']>();
  for (const day of input.days) {
    for (const step of day.steps) {
      const values = assignments.get(step.stopId) ?? [];
      values.push({
        dayIndex: day.dayIndex,
        arrivalSeconds: step.arrivalSeconds,
        departureSeconds: step.departureSeconds,
      });
      assignments.set(step.stopId, values);
    }
  }
  const unassignedIds = new Set(input.response.unassigned.map((stop) => stop.stop_id));
  const nodes: SolverTrace['nodes'] = input.stops.map((stop) => {
    const stopAssignments = assignments.get(stop.id) ?? [];
    const internalAlternative = Boolean(parseMealAltId(stop.id) || parseMealFillerId(stop.id));
    const kind = stop.isDepot
      ? 'depot'
      : stop.isMeal
        ? 'meal'
        : stop.anchorMetadata
          ? 'anchor'
          : 'attraction';
    return {
      stopId: stop.id,
      name: stop.name,
      coordinate: stop.coordinate,
      legId: input.legId,
      kind,
      status: stopAssignments.length > 0
        ? 'assigned'
        : internalAlternative && !unassignedIds.has(stop.id)
          ? 'alternative'
          : 'unassigned',
      assignments: stopAssignments,
      serviceTimeSeconds: stop.serviceTimeSeconds,
      timeWindowStartSeconds: ABSOLUTE_DAY_START_SECONDS + stop.timeWindowStart,
      timeWindowEndSeconds: ABSOLUTE_DAY_START_SECONDS + stop.timeWindowEnd,
      preferredTimeWindowStartSeconds: stop.preferredTimeWindow
        ? ABSOLUTE_DAY_START_SECONDS + stop.preferredTimeWindow.start
        : undefined,
      preferredTimeWindowEndSeconds: stop.preferredTimeWindow
        ? ABSOLUTE_DAY_START_SECONDS + stop.preferredTimeWindow.end
        : undefined,
      preferredTimeWindowStrength: stop.preferredTimeWindow?.strength,
      priority: stop.priority,
      fixedDayIndex: stop.fixedDay === undefined ? undefined : input.baseDayIndex + stop.fixedDay,
      allowedDayIndices: stop.allowedDays?.map((day) => input.baseDayIndex + day),
      importance: stop.importance,
      seasonalSuitability: stop.seasonalSuitability,
      reason: stop.unavailabilityReason ?? (stopAssignments.length === 0 && !internalAlternative ? 'capacity' : undefined),
      internalAlternative: internalAlternative || undefined,
    };
  });
  const solutionEdges: SolverTrace['solutionEdges'] = input.days.flatMap((day) =>
    day.legs.map((edge) => ({ ...edge, dayIndex: day.dayIndex })),
  );
  const candidateEdges: SolverTrace['candidateEdges'] = [];
  const graphNodeIndices = input.stops.flatMap((stop, index) => {
    const internal = Boolean(parseMealAltId(stop.id) || parseMealFillerId(stop.id));
    return !internal || (assignments.get(stop.id)?.length ?? 0) > 0 ? [index] : [];
  });
  for (const from of graphNodeIndices) {
    const nearest = graphNodeIndices
      .map((to) => ({ to, distanceMeters: input.distances[from]?.[to] ?? 0 }))
      .filter((edge) => edge.to !== from && edge.distanceMeters > 0)
      .sort((left, right) => left.distanceMeters - right.distanceMeters)
      .slice(0, 5);
    for (const edge of nearest) {
      candidateEdges.push({
        fromStopId: input.stops[from]!.id,
        toStopId: input.stops[edge.to]!.id,
        distanceMeters: edge.distanceMeters,
        durationSeconds: input.durations[from]?.[edge.to] ?? 0,
      });
    }
  }
  return {
    source: 'solver',
    engine: 'Google OR-Tools',
    model: 'VRPTW',
    generatedAt: new Date().toISOString(),
    solveDurationMs: input.solveDurationMs,
    nodeCount: input.stops.length,
    consideredDirectedEdges: input.stops.length * Math.max(0, input.stops.length - 1),
    matrixFallbackPairs: input.matrixFallbackPairs,
    baselineDistanceMeters: baselineDistanceForResponse(input.payload, input.response, input.distances),
    optimizedDistanceMeters: input.days.reduce((sum, day) => sum + day.distanceMeters, 0),
    minStopsPerDay: input.payload.min_stops_per_day ?? 0,
    maxStopsPerDay: input.payload.max_stops_per_day ?? 0,
    horizonSeconds: input.payload.horizon_seconds,
    nodes,
    solutionEdges,
    candidateEdges,
  };
}

function diffInDays(startDate: string, endDate: string): number {
  const start = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);
  if (!start || !end) return 1;
  const diff = (end.getTime() - start.getTime()) / 86_400_000;
  return Math.max(1, Math.round(diff) + 1);
}

export class GenerateItineraryUseCase {
  constructor(
    private readonly routes: RoutesPort,
    private readonly solver: SolverPort,
    private readonly places?: PlacesPort,
  ) {}

  async execute(request: ItineraryRequest): Promise<ItinerarySolution> {
    if (request.legs.length === 0) {
      throw new Error('at least one leg is required');
    }

    // Quando dois legs compartilham um dia (fim de A = início de B), cada leg
    // roda seu solver com sua data original; depois mesclamos o dia
    // compartilhado em um único DayPlan que mostra: atrações de A na manhã,
    // saída, trajeto, chegada em B, atrações de B na tarde/noite.
    const normalizedLegs = dedupeCandidatesAcrossLegs(request.legs).map(dedupeCandidatesWithinLeg);

    ilog(
      `request: ${normalizedLegs.length} leg(s) [${normalizedLegs
        .map((l) => `${l.destinationName} ${l.startDate}→${l.endDate}`)
        .join(' | ')}], ${request.transitions?.length ?? 0} transição(ões), ` +
        `${request.mealCandidates?.length ?? 0} meal candidate(s)`,
    );
    for (const t of request.transitions ?? []) {
      ilog(
        `  transição ${t.fromLegId}→${t.toLegId} modo=${t.mode} ` +
          `saída=${t.departureLocalIso ?? '?'} chegada=${t.arrivalLocalIso ?? '?'}`,
      );
    }

    let globalDayIndex = 0;
    const legResults: LegSegmentResult[] = [];

    for (let legIndex = 0; legIndex < normalizedLegs.length; legIndex += 1) {
      checkDeadline();
      const leg = normalizedLegs[legIndex]!;
      const isFirstLeg = legIndex === 0;
      const isLastLeg = legIndex === normalizedLegs.length - 1;
      let legResult: LegSegmentResult;
      try {
        legResult = await this.solveLeg(
          request,
          leg,
          legIndex,
          globalDayIndex,
          isFirstLeg,
          isLastLeg,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'erro desconhecido';
        const enriched = new Error(
          `Não conseguimos gerar roteiro para ${leg.destinationName}: ${message}`,
        );
        (enriched as { cause?: unknown }).cause = error;
        throw enriched;
      }
      legResults.push(legResult);
      globalDayIndex += legResult.days.length;
    }

    const transitionSegments = this.computeTransitionSegments(request);
    const mergedDays = mergeSharedDays(legResults, request.transitions ?? [], transitionSegments ?? []);
    const totalDistance = legResults.reduce((sum, r) => sum + r.totalDistanceMeters, 0);
    const totalTime = legResults.reduce((sum, r) => sum + r.totalTimeSeconds, 0);
    const allUnassigned = legResults.flatMap((r) => r.unassigned);
    const allPois = legResults.flatMap((r) => r.pois);
    const solverTrace = alignTraceToMergedDays(
      mergeSolverTraces(legResults.map((result) => result.solverTrace)),
      mergedDays.days,
      legResults.map((result) => result.summary),
      mergedDays.legs,
    );

    return {
      transitionSegments,
      totalDistanceMeters: totalDistance,
      totalTimeSeconds: totalTime,
      days: mergedDays.days,
      unassigned: allUnassigned,
      pois: dedupePois(allPois),
      legs: mergedDays.legs,
      solverTrace,
    };
  }

  private async solveLeg(
    request: ItineraryRequest,
    leg: ItineraryLegRequest,
    legIndex: number,
    baseDayIndex: number,
    isFirstLeg: boolean,
    isLastLeg: boolean,
  ): Promise<LegSegmentResult> {
    const selectedAnchors = (request.anchorExperiences ?? []).filter((anchor) => anchor.legId === leg.legId);
    if (leg.candidates.length === 0 && selectedAnchors.length === 0) {
      throw new Error(`leg ${leg.legId}: at least one candidate place is required`);
    }
    const days = diffInDays(leg.startDate, leg.endDate);
    if (days < 1 || days > MAX_SOLVER_DAYS) {
      throw new Error(`leg ${leg.legId}: days must be between 1 and ${MAX_SOLVER_DAYS}`);
    }

    // Hospedagem é opcional: sem nenhuma estadia, usa o centro da cidade como
    // depósito sintético (ponto de partida/retorno de cada dia). A partir daqui
    // o resto do pipeline trata `leg` normalmente.
    leg = ensureLodging(leg);

    const paceProfile = this.paceProfileFor(request, leg);

    ilog(
      `leg "${leg.destinationName}" (${leg.legId}): ${days} dia(s), ` +
        `${leg.candidates.length} candidato(s), ${leg.lodgings.length} hospedagem(ns), ` +
        `modo=${leg.travelMode ?? FIXED_TRAVEL_MODE}, primeiro=${isFirstLeg}, último=${isLastLeg}`,
    );

    const dayContexts = this.buildDayContexts(leg, baseDayIndex, legIndex);
    const lodgingByDay = mapLodgingToDays(leg.lodgings, dayContexts, legIndex);
    applyAnchorDepotOverrides(
      lodgingByDay,
      (request.anchorExperiences ?? []).filter((anchor) => anchor.legId === leg.legId),
      dayContexts,
    );
    applyLodgingTimeWindows(dayContexts, lodgingByDay);
    // Um horário manual continua sendo um limite mesmo sem aeroporto/local.
    const arrivalIso = isFirstLeg ? request.flightPlan?.arrival?.scheduledLocalIso
      : request.transitions?.find(t => t.toLegId === leg.legId)?.arrivalLocalIso;
    const departureIso = isLastLeg ? request.flightPlan?.departure?.scheduledLocalIso
      : request.transitions?.find(t => t.fromLegId === leg.legId)?.departureLocalIso;
    const firstDay = dayContexts[0]!;
    const lastDay = dayContexts[dayContexts.length - 1]!;
    if (arrivalIso) {
      firstDay.windowStartSeconds = Math.max(firstDay.windowStartSeconds,
        secondsFromOperatingDayStart(arrivalIso, firstDay.windowStartSeconds));
      firstDay.windowEndSeconds = Math.max(firstDay.windowEndSeconds, firstDay.windowStartSeconds);
    }
    if (departureIso) {
      lastDay.windowEndSeconds = Math.min(lastDay.windowEndSeconds,
        secondsFromOperatingDayStart(departureIso, lastDay.windowEndSeconds));
      if (lastDay.windowEndSeconds < lastDay.windowStartSeconds) {
        throw new Error('O horário de saída é anterior à chegada ou ao check-in neste dia. Revise os horários da viagem e da hospedagem.');
      }
    }


    const { stops, candidateGroups, fillerGroups } = await this.buildStops(
      request,
      leg,
      legIndex,
      dayContexts,
      lodgingByDay,
      isFirstLeg,
      isLastLeg,
    );
    if (ITINERARY_DEBUG) {
      for (const context of dayContexts) {
        ilog(
          `  dia ${context.dayOffsetInLeg} (${context.date ? formatLocalDate(context.date) : '?'}): ` +
            `janela operacional ${debugHhmm(context.windowStartSeconds)}-${debugHhmm(context.windowEndSeconds)}` +
            `${context.isTransitDay ? ' [transição]' : ''}`,
        );
      }
      const mealCount = stops.filter((stop) => stop.isMeal).length;
      ilog(`  ${stops.length} stop(s) montado(s) (${mealCount} alternativas de refeição):`);
      for (const stop of stops) {
        if (stop.isMeal && stop.mealMetadata?.positional) continue;
        ilog(`    ${describeStop(stop)}`);
      }
      ilog(
        `  grupos de refeição: candidatos ${
          candidateGroups.length > 0 ? candidateGroups.map((g) => `[${g.length} alt]`).join(' ') : 'nenhum'
        } · fillers ${
          fillerGroups.length > 0 ? fillerGroups.map((g) => `[${g.length} host]`).join(' ') : 'nenhum'
        }`,
      );
    }

    const coordinates = stops.map((stop) => ({
      latitude: stop.coordinate.latitude,
      longitude: stop.coordinate.longitude,
    }));

    // Pares muito distantes (não visitáveis no mesmo dia) usam linha reta; as
    // alternativas de refeição co-localizadas repetem coordenadas de atrações e
    // são deduplicadas pelo adapter — não custam elementos extras na Routes API.
    const matrix = await this.routes.computeMatrix({
      // Modo preferido da cidade aproxima os tempos (transit/a pé são bem mais
      // lentos que carro); carro é o padrão quando o usuário não escolheu.
      mode: leg.travelMode ?? FIXED_TRAVEL_MODE,
      coordinates,
      maxRoutedDistanceMeters: ROUTED_PAIR_MAX_DISTANCE_METERS,
    });

    const hasArrivalAirport = stops.some((s) => s.id === ARRIVAL_AIRPORT_STOP_ID);
    const hasDepartureAirport = stops.some((s) => s.id === DEPARTURE_AIRPORT_STOP_ID);
    const vehicleStartIds: string[] = lodgingByDay.map((stay, dayIndex) => {
      if (dayIndex === 0 && hasArrivalAirport) return ARRIVAL_AIRPORT_STOP_ID;
      return lodgingStopId(legIndex, stay.start.id, dayIndex);
    });
    const vehicleEndIds: string[] = lodgingByDay.map((stay, dayIndex) => {
      if (dayIndex === lodgingByDay.length - 1 && hasDepartureAirport) {
        return DEPARTURE_AIRPORT_STOP_ID;
      }
      return lodgingStopId(legIndex, stay.end.id, dayIndex);
    });

    const depotId = vehicleStartIds[0] ?? lodgingStopId(legIndex, leg.lodgings[0]!.id);
    const payload: SolverPayload = {
      stops: stops.map((stop) => ({
        id: stop.id,
        name: stop.name,
        latitude: stop.coordinate.latitude,
        longitude: stop.coordinate.longitude,
        service_time_seconds: stop.serviceTimeSeconds,
        time_window_start_seconds: stop.timeWindowStart,
        time_window_end_seconds: stop.timeWindowEnd,
        is_depot: stop.isDepot ?? false,
        is_meal: stop.isMeal ?? false,
        meal_slot: stop.mealMetadata?.slot,
        meal_category: stop.mealMetadata?.category,
        meal_candidate_id: stop.mealMetadata?.candidateId,
        fixed_day: stop.fixedDay,
        allowed_days: stop.allowedDays,
        day_time_windows: stop.dayTimeWindows?.map((window) => ({
          day_index: window.dayIndex,
          start_seconds: window.start,
          end_seconds: window.end,
        })),
        preferred_time_window_start_seconds: stop.preferredTimeWindow?.start,
        preferred_time_window_end_seconds: stop.preferredTimeWindow?.end,
        preferred_time_window_strength: stop.preferredTimeWindow?.strength,
        priority: stop.priority,
        full_day: stop.fullDay ?? false,
        importance: stop.importance ?? 0,
        seasonal_suitability: stop.seasonalSuitability ?? 1,
      })),
      depot_id: depotId,
      max_days: days,
      vehicle_start_ids: vehicleStartIds,
      vehicle_end_ids: vehicleEndIds,
      horizon_seconds: OPERATING_HORIZON_SECONDS,
      min_stops_per_day: Math.max(FIXED_MIN_STOPS_PER_DAY, paceProfile.minStopsPerDay),
      max_stops_per_day: Math.min(FIXED_MAX_STOPS_PER_DAY, paceProfile.maxStopsPerDay),
      distance_matrix: matrix.distancesMeters,
      time_matrix: matrix.durationsSeconds,
      meal_candidate_groups: candidateGroups,
      meal_filler_groups: fillerGroups,
    };

    ilog(
      `  matriz ${coordinates.length}x${coordinates.length}, ` +
        `veículos: start=[${vehicleStartIds.join(', ')}] end=[${vehicleEndIds.join(', ')}]`,
    );

    const solveStartedAt = Date.now();
    const response = await this.solver.solve(payload);
    const solveDurationMs = Date.now() - solveStartedAt;

    if (ITINERARY_DEBUG) {
      ilog(`  solver: ${response.days.length} dia(s) retornado(s), ${response.unassigned.length} não atribuído(s)`);
      response.days.forEach((day, i) => {
        const sequence = day.steps
          .map((s) => `${debugHhmm(s.arrival_seconds)} ${s.name ?? s.stop_id}`)
          .join(' → ');
        ilog(`    dia ${i}: ${sequence}`);
      });
      for (const u of response.unassigned) {
        ilog(`    DROP: ${u.name ?? u.stop_id} (prio=${u.priority})`);
      }
    }

    const baseDays = this.toDays(
      response,
      stops,
      matrix.distancesMeters,
      matrix.durationsSeconds,
      dayContexts,
      leg.legId,
    );


    const stopByIdAll = new Map(stops.map((stop) => [stop.id, stop]));
    const seenCandidateIds = new Set<string>();
    const unassigned: UnassignedStop[] = [];
    for (const item of response.unassigned) {
      const alt = parseMealAltId(item.stop_id);
      if (alt) {
        if (seenCandidateIds.has(alt.candidateId)) continue;
        seenCandidateIds.add(alt.candidateId);
        const sourceStop = stopByIdAll.get(item.stop_id);
        const meta = sourceStop?.mealMetadata;
        unassigned.push({
          stopId: alt.candidateId,
          name: item.name ?? undefined,
          coordinate: { latitude: item.latitude, longitude: item.longitude },
          priority: item.priority,
          kind: 'meal',
          mealCategory: meta?.category,
        });
        continue;
      }
      const filler = parseMealFillerId(item.stop_id);
      if (filler) {
        // Filler não vai ao usuário como pendência, mas o drop fica registrado:
        // um dia sem almoço deve ser visível no diagnóstico, não silencioso.
        ilog(`  dia d${filler.dayOffset} ficou sem ${filler.slot} (filler dropado pelo solver)`);
        continue;
      }
      unassigned.push({
        stopId: item.stop_id,
        name: item.name ?? undefined,
        coordinate: { latitude: item.latitude, longitude: item.longitude },
        priority: item.priority,
        kind: stopByIdAll.get(item.stop_id)?.anchorMetadata ? 'anchor' : 'attraction',
        reason: stopByIdAll.get(item.stop_id)?.unavailabilityReason ?? 'capacity',
      });
    }

    const summary: ItineraryLegSummary = {
      legId: leg.legId,
      color: leg.color,
      destinationName: leg.destinationName,
      startDate: leg.startDate,
      endDate: leg.endDate,
      dayIndexStart: baseDayIndex,
      dayIndexEnd: baseDayIndex + baseDays.length - 1,
    };

    return {
      days: baseDays,
      totalDistanceMeters: baseDays.reduce((sum, d) => sum + d.distanceMeters, 0),
      totalTimeSeconds: response.total_time_seconds,
      unassigned,
      pois: leg.candidates.map((candidate) => candidate.place),
      summary,
      solverTrace: buildSolverTrace({
        payload,
        response,
        days: baseDays,
        stops,
        distances: matrix.distancesMeters,
        durations: matrix.durationsSeconds,
        matrixFallbackPairs: matrix.fallbackPairs.length,
        solveDurationMs,
        baseDayIndex,
        legId: leg.legId,
      }),
    };
  }

  // Ritmo (pace) sobrevive sob a arquitetura de janela fixa do solver: em vez
  // de mexer no horizonte do dia, ele aperta/afrouxa o teto de paradas por dia
  // e multiplica o tempo de serviço, de modo que um ritmo relaxado encaixe
  // menos atrações e um intenso encaixe mais. Leg manda na request global.
  private paceProfileFor(request: ItineraryRequest, leg: ItineraryLegRequest): PaceProfile {
    const pace = leg.preferences?.pace ?? request.preferences?.pace ?? DEFAULT_PACE;
    return PACE_PROFILES[pace];
  }

  private buildDayContexts(
    leg: ItineraryLegRequest,
    baseDayIndex: number,
    legIndex: number,
  ): DayContext[] {
    const baseDate = parseLocalDate(leg.startDate);
    const days = diffInDays(leg.startDate, leg.endDate);
    return Array.from({ length: days }, (_, dayOffset) => {
      const date = baseDate ? addDays(baseDate, dayOffset) : null;
      return {
        date,
        windowStartSeconds: DAY_WINDOW_START_SECONDS,
        windowEndSeconds: DAY_WINDOW_END_SECONDS,
        legId: leg.legId,
        legIndex,
        dayOffsetInLeg: dayOffset,
        globalDayIndex: baseDayIndex + dayOffset,
      };
    });
  }

  private async buildStops(
    request: ItineraryRequest,
    leg: ItineraryLegRequest,
    legIndex: number,
    dayContexts: DayContext[],
    lodgingByDay: { start: LodgingStay; end: LodgingStay }[],
    isFirstLeg: boolean,
    isLastLeg: boolean,
  ): Promise<{ stops: InternalStop[]; candidateGroups: string[][]; fillerGroups: string[][] }> {
    const operatingStart = dayContexts[0]?.windowStartSeconds ?? 0;
    const operatingEnd = dayContexts[0]?.windowEndSeconds ?? OPERATING_HORIZON_SECONDS;

    const priorityOrder = new Map(request.preferenceOrder.map((id, index) => [id, index]));
    const attractionPriority = new Map(
      (request.attractionPriority ?? []).map((id, index) => [id, index]),
    );
    const fixedDayByPlaceId = new Map(
      (request.attractionDayAssignments ?? [])
        .filter((assignment) => assignment.legId === leg.legId)
        .map((assignment) => [assignment.placeId, assignment.dayOffset]),
    );
    const serviceMultiplier = this.paceProfileFor(request, leg).serviceTimeMultiplier;
    const candidates = leg.candidates
      .map((candidate, index) =>
        this.toStop(
          candidate,
          priorityOrder,
          attractionPriority,
          index,
          dayContexts,
          serviceMultiplier,
          fixedDayByPlaceId.get(candidate.place.placeId),
        ),
      )
      .filter((stop): stop is InternalStop => stop !== null);
    const anchorStops = this.buildAnchorStops(request, leg, dayContexts);

    const fallbackLodging = leg.lodgings[0]!;

    // Aeroporto/ponto de chegada do leg:
    // - 1º leg: usa flightPlan.arrival (voo internacional/inicial)
    // - Demais: usa o anchor da transição entrando neste leg, se houver
    let arrivalAnchorToUse: FlightAnchor | undefined;
    let arrivalTransitionMode: TransitionLeg['mode'] | undefined;
    if (isFirstLeg) {
      arrivalAnchorToUse = request.flightPlan?.arrival;
      if (arrivalAnchorToUse) arrivalTransitionMode = 'flight';
    } else {
      const incoming = (request.transitions ?? []).find((t) => t.toLegId === leg.legId);
      if (incoming) {
        // Para modos terrestres (car/bus/train), o "ponto de chegada" é a
        // própria hospedagem do leg de destino. Para voo/barco, é o aeroporto/
        // porto vindo do flightDetails. Sem isso, o solver desenha rotas
        // gigantes entre a hospedagem e uma coord placeholder.
        const isGround = incoming.mode === 'car' || incoming.mode === 'estimate';
        const arrivalFallback = isGround
          ? fallbackLodging.coordinate
          : leg.destinationCoordinate;
        arrivalAnchorToUse = transitionToArrivalAnchor(incoming, arrivalFallback);
        arrivalTransitionMode = incoming.mode;
      }
    }
    const arrivalAirport = arrivalAnchorToUse
      ? await this.toAirportStop(
          ARRIVAL_AIRPORT_STOP_ID,
          arrivalAnchorToUse,
          true,
          operatingEnd,
          arrivalTransitionMode,
        )
      : null;
    if (arrivalAirport && arrivalTransitionMode) {
      arrivalAirport.transitionMode = arrivalTransitionMode;
      arrivalAirport.transitionDirection = 'arrival';
    }

    // Aeroporto/ponto de saída do leg:
    // - Último leg: usa flightPlan.departure
    // - Demais: usa o anchor da transição saindo deste leg, se houver
    let departureAnchorToUse: FlightAnchor | undefined;
    let departureTransitionMode: TransitionLeg['mode'] | undefined;
    if (isLastLeg) {
      departureAnchorToUse = request.flightPlan?.departure;
      if (departureAnchorToUse) departureTransitionMode = 'flight';
    } else {
      const outgoing = (request.transitions ?? []).find((t) => t.fromLegId === leg.legId);
      if (outgoing) {
        const isGround = outgoing.mode === 'car' || outgoing.mode === 'estimate';
        const departureFallback = isGround
          ? fallbackLodging.coordinate
          : leg.destinationCoordinate;
        departureAnchorToUse = transitionToDepartureAnchor(outgoing, departureFallback);
        departureTransitionMode = outgoing.mode;
      }
    }
    const departureAirport = departureAnchorToUse
      ? await this.toAirportStop(
          DEPARTURE_AIRPORT_STOP_ID,
          departureAnchorToUse,
          false,
          operatingStart,
          departureTransitionMode,
        )
      : null;
    if (departureAirport && departureTransitionMode) {
      departureAirport.transitionMode = departureTransitionMode;
      departureAirport.transitionDirection = 'departure';
    }

    // Quando há aeroporto sintético, garante que a janela operacional do dia
    // engloba a janela do aeroporto. Sem isso, o solver não consegue encaixar
    // saídas/chegadas fora da janela padrão do dia, nem do checkInTime/
    // checkOutTime do lodging (que já foram aplicados acima).
    if (arrivalAirport && dayContexts[0]) {
      const first = dayContexts[0];
      const isGroundArrival =
        arrivalTransitionMode === 'car' || arrivalTransitionMode === 'estimate';
      first.windowStartSeconds = Math.max(
        0,
        Math.max(first.windowStartSeconds, arrivalAirport.timeWindowStart),
      );
      first.windowEndSeconds = Math.min(
        OPERATING_HORIZON_SECONDS,
        Math.max(first.windowEndSeconds, arrivalAirport.timeWindowEnd),
      );
      // Modos terrestres: o dia da chegada só "começa" após o anchor de
      // chegada — restringe windowStart para coincidir, evitando que o
      // solver tente encaixar POIs antes da chegada física.
      if (isGroundArrival) {
        first.windowStartSeconds = Math.max(first.windowStartSeconds, arrivalAirport.timeWindowStart);
      }
      ilog(
        `  âncora chegada (${arrivalTransitionMode}): "${arrivalAirport.name}" ` +
          `janela=${debugHhmm(arrivalAirport.timeWindowStart)}-${debugHhmm(arrivalAirport.timeWindowEnd)} → ` +
          `dia 0 ajustado para ${debugHhmm(first.windowStartSeconds)}-${debugHhmm(first.windowEndSeconds)}`,
      );
    }
    if (departureAirport && dayContexts.length > 0) {
      const last = dayContexts[dayContexts.length - 1]!;
      const isGroundDeparture =
        departureTransitionMode === 'car' || departureTransitionMode === 'estimate';
      last.windowStartSeconds = Math.max(
        0,
        Math.min(last.windowStartSeconds, departureAirport.timeWindowStart),
      );
      last.windowEndSeconds = Math.min(
        OPERATING_HORIZON_SECONDS,
        Math.max(last.windowEndSeconds, departureAirport.timeWindowEnd),
      );
      // Modos terrestres: o dia da saída acaba quando o veículo sai.
      if (isGroundDeparture) {
        last.windowEndSeconds = Math.min(last.windowEndSeconds, departureAirport.timeWindowEnd);
      }
      ilog(
        `  âncora saída (${departureTransitionMode}): "${departureAirport.name}" ` +
          `janela=${debugHhmm(departureAirport.timeWindowStart)}-${debugHhmm(departureAirport.timeWindowEnd)} → ` +
          `último dia ajustado para ${debugHhmm(last.windowStartSeconds)}-${debugHhmm(last.windowEndSeconds)}`,
      );
    }

    const mealCandidatesForLeg = (request.mealCandidates ?? []).filter(
      (candidate) => candidate.legId === leg.legId,
    );
    const mealPriorityOrder = new Map(
      (request.mealPriority ?? []).map((id, index) => [id, index]),
    );
    // Hosts das refeições posicionais: hotel + atrações normais do leg. Uma
    // refeição sem local definido é co-localizada num host (comer perto de
    // onde se está), com arcos reais — nunca "teleporta". Atividades de dia
    // inteiro ficam de fora: durante uma trilha de 8h não há parada externa.
    const mealHosts: Coordinate[] = [
      fallbackLodging.coordinate,
      ...candidates.filter((stop) => !stop.fullDay).map((stop) => stop.coordinate),
    ];
    const { stops: mealStops, candidateGroups, fillerGroups } = this.buildMealStops(
      legIndex,
      mealCandidatesForLeg,
      dayContexts,
      fallbackLodging,
      mealPriorityOrder,
      mealHosts,
    );
    // Depósitos por dia: a janela de check-in/chegada não pode ser perdida
    // nem aplicada aos outros dias que compartilham a mesma hospedagem.
    const lodgingStops: InternalStop[] = lodgingByDay.flatMap((stay, dayIndex) => {
      const context = dayContexts[dayIndex]!;
      const unique = new Map([[stay.start.id, stay.start], [stay.end.id, stay.end]]);
      return [...unique.values()].map(lodging => ({
        id: lodgingStopId(legIndex, lodging.id, dayIndex),
        name: lodging.name, coordinate: lodging.coordinate, serviceTimeSeconds: 0,
        timeWindowStart: context.windowStartSeconds,
        timeWindowEnd: context.windowEndSeconds,
        priority: 1, isDepot: true,
      }));
    });
    return {
      stops: [
        ...lodgingStops,
        ...(arrivalAirport ? [arrivalAirport] : []),
        ...(departureAirport ? [departureAirport] : []),
        ...mealStops,
        ...anchorStops,
        ...candidates,
      ],
      candidateGroups,
      fillerGroups,
    };
  }

  private buildAnchorStops(
    request: ItineraryRequest,
    leg: ItineraryLegRequest,
    dayContexts: DayContext[],
  ): InternalStop[] {
    const selected = (request.anchorExperiences ?? []).filter((anchor) => anchor.legId === leg.legId);
    const stops: InternalStop[] = [];
    const occupiedDays = new Set<number>();
    for (const anchor of selected) {
      if (anchor.dayOffset + anchor.durationDays > dayContexts.length) {
        throw new Error(
          `A experiência “${anchor.title}” precisa de ${anchor.durationDays} dias consecutivos a partir do dia ${anchor.dayOffset + 1}.`,
        );
      }
      for (let segmentIndex = 0; segmentIndex < anchor.durationDays; segmentIndex += 1) {
        const occupiedDay = anchor.dayOffset + segmentIndex;
        if (occupiedDays.has(occupiedDay)) {
          throw new Error(`As experiências-âncora selecionadas se sobrepõem no dia ${occupiedDay + 1}.`);
        }
        occupiedDays.add(occupiedDay);
        const context = dayContexts[anchor.dayOffset + segmentIndex]!;
        const segment = anchor.segments?.[segmentIndex];
        const start = localTimeToOperatingSeconds(segment?.startTime ?? anchor.startTime) ?? 0;
        const latestStart = localTimeToOperatingSeconds(anchor.latestStartTime) ?? start;
        const month = context.date ? context.date.getUTCMonth() + 1 : null;
        const isAvailable = !month || !anchor.availableMonths?.length || anchor.availableMonths.includes(month);
        const isAvoidMonth = Boolean(month && anchor.avoidMonths?.includes(month));
        const serviceTimeSeconds = Math.min(
          OPERATING_HORIZON_SECONDS,
          (segment?.durationMinutes ?? anchor.dailyDurationMinutes) * 60,
        );
        stops.push({
          id: anchorStopId(anchor.id, segmentIndex),
          name: segment?.title ?? anchor.title,
          coordinate: segment?.coordinate ?? anchor.coordinate,
          serviceTimeSeconds,
          timeWindowStart: start,
          timeWindowEnd: Math.max(start, latestStart),
          priority: 1,
          fixedDay: anchor.dayOffset + segmentIndex,
          allowedDays: isAvailable ? [anchor.dayOffset + segmentIndex] : [],
          dayTimeWindows: isAvailable
            ? [{ dayIndex: anchor.dayOffset + segmentIndex, start, end: Math.max(start, latestStart) }]
            : [],
          fullDay: true,
          importance: 1,
          seasonalSuitability: isAvoidMonth ? 0.5 : 1,
          unavailabilityReason: isAvailable ? undefined : 'seasonal',
          anchorMetadata: {
            id: anchor.id,
            dayNumber: segmentIndex + 1,
            totalDays: anchor.durationDays,
            guide: anchor.guide,
            reservation: anchor.reservation,
            logistics: anchor.logistics,
          },
        });
      }
    }
    return stops;
  }

  private buildMealStops(
    legIndex: number,
    candidates: MealCandidate[],
    dayContexts: DayContext[],
    fallbackLodging: LodgingStay,
    mealPriorityOrder: Map<string, number>,
    mealHosts: Coordinate[],
  ): { stops: InternalStop[]; candidateGroups: string[][]; fillerGroups: string[][] } {
    const stops: InternalStop[] = [];
    const candidateGroups: string[][] = [];
    const fillerGroups: string[][] = [];

    for (const candidate of candidates) {
      const allowedSlots = CATEGORY_TO_SLOTS[candidate.category];
      const reservationSlot = candidate.reservationLocalIso
        ? inferSlotFromIso(candidate.reservationLocalIso)
        : null;
      const slotsToTry = reservationSlot && allowedSlots.includes(reservationSlot)
        ? [reservationSlot]
        : allowedSlots;
      const groupIds: string[] = [];
      const priorityRank = mealPriorityOrder.get(candidate.id);
      const priority = priorityRank !== undefined ? priorityRank + 1 : 100;

      for (let dayOffset = 0; dayOffset < dayContexts.length; dayOffset += 1) {
        // Dia fixado pelo usuário: só gera a alternativa nesse dia, então o
        // solver não tem como encaixar a refeição em outro. Sem fixar, gera em
        // todos os dias e o grupo de disjunção deixa o solver escolher um.
        if (candidate.dayOffset !== undefined && candidate.dayOffset !== dayOffset) continue;
        const dayContext = dayContexts[dayOffset]!;
        if (dayContext.isTransitDay) continue;
        for (const slot of slotsToTry) {
          const profile = MEAL_SLOT_PROFILES[slot];
          const serviceSeconds =
            candidate.serviceTimeSeconds && candidate.serviceTimeSeconds > 0
              ? candidate.serviceTimeSeconds
              : profile.defaultServiceSeconds;
          const slotWindow = mealSlotWindow(profile, dayContext);
          const reservation = candidate.reservationLocalIso && slot === reservationSlot
            ? reservationWindow(candidate.reservationLocalIso, serviceSeconds)
            : null;
          const opening = candidate.openingHours
            ? openingHoursWindowForDay(candidate.openingHours, dayContext, serviceSeconds)
            : null;
          const window = intersectWindows([slotWindow, reservation, opening].filter(isWindow));
          if (!window) {
            ilog(
              `  meal "${candidate.placeName}" d${dayOffset}/${slot}: SEM JANELA ` +
                `(slot=${debugHhmm(slotWindow.start)}-${debugHhmm(slotWindow.end)}` +
                `${reservation ? ` reserva=${debugHhmm(reservation.start)}-${debugHhmm(reservation.end)}` : ''}` +
                `${opening ? ` abertura=${debugHhmm(opening.start)}-${debugHhmm(opening.end)}` : candidate.openingHours ? ' abertura=incompatível' : ''})`,
            );
            continue;
          }
          // Restaurante real (anchor 'place' com coordenada) entra como parada
          // geográfica normal. Sem local definido, ancora na hospedagem — com
          // arcos reais, para o deslocamento até lá contar no cronograma.
          const isPositional = candidate.anchor !== 'place' || !candidate.coordinate;
          const coordinate = candidate.coordinate ?? fallbackLodging.coordinate;
          const stopId = mealAltStopId(candidate.id, dayOffset, slot);
          stops.push({
            id: stopId,
            name: candidate.placeName,
            coordinate,
            serviceTimeSeconds: serviceSeconds,
            timeWindowStart: window.start,
            timeWindowEnd: window.end,
            priority,
            isMeal: true,
            fixedDay: dayOffset,
            mealMetadata: {
              slot,
              category: candidate.category,
              anchor: isPositional ? 'nearby' : 'place',
              positional: isPositional,
              placeId: candidate.placeId,
              candidateId: candidate.id,
              reservationLocalIso: candidate.reservationLocalIso,
            },
          });
          groupIds.push(stopId);
        }
      }

      if (groupIds.length > 0) {
        candidateGroups.push(groupIds);
        ilog(
          `  meal candidate "${candidate.placeName}" (${candidate.category}, anchor=${candidate.anchor}): ` +
            `${groupIds.length} alternativa(s) em [${slotsToTry.join(', ')}]` +
            `${candidate.dayOffset !== undefined ? ` dia fixo=${candidate.dayOffset}` : ''}`,
        );
      } else {
        ilog(`  meal candidate "${candidate.placeName}": ZERO alternativas geradas — será dropado silenciosamente`);
      }
    }

    const coveredSlots = new Set<string>();
    for (const group of candidateGroups) {
      for (const stopId of group) {
        const parsed = parseMealAltId(stopId);
        if (parsed) coveredSlots.add(slotCoverageKey(parsed.dayOffset, parsed.slot));
      }
    }
    // Slots cobertos por candidato não recebem filler; o solver vai decidir qual
    // alternativa entra ou se nenhuma cabe — neste caso, sobra o slot sem refeição,
    // mas como ainda há outras alternativas no grupo o filler causaria duplicação.

    // Só o almoço vira bloco posicional automático: ele cai no meio do dia
    // ativo e conflita com atrações, então reservar tempo evita roteiro sem
    // pausa. Café e jantar acontecem nas pontas (hotel/região) e, como slots
    // forçados, distorciam o horário — um jantar fixo às 19-21h empurrava o
    // dia inteiro para a tarde. O usuário ainda pode adicionar refeições
    // explícitas em qualquer slot via mealCandidates.
    for (let dayOffset = 0; dayOffset < dayContexts.length; dayOffset += 1) {
      const dayContext = dayContexts[dayOffset]!;
      if (dayContext.isTransitDay) continue;
      for (const slot of AUTO_FILLER_SLOTS) {
        if (coveredSlots.has(slotCoverageKey(dayOffset, slot))) {
          ilog(`  filler d${dayOffset}/${slot}: coberto por candidato explícito, não gerado`);
          continue;
        }
        const profile = MEAL_SLOT_PROFILES[slot];
        const slotWindow = mealSlotWindow(profile, dayContext);
        if (slotWindow.end - slotWindow.start < profile.defaultServiceSeconds) {
          ilog(
            `  filler d${dayOffset}/${slot}: NÃO CABE na janela do dia ` +
              `(slot∩dia=${debugHhmm(slotWindow.start)}-${debugHhmm(slotWindow.end)}, ` +
              `precisa ${Math.round(profile.defaultServiceSeconds / 60)}min) — dia fica sem ${slot}`,
          );
          continue;
        }
        // Uma alternativa co-localizada em cada host; o solver escolhe a que
        // está no caminho do dia (arcos reais — comer perto de onde se está).
        const groupIds: string[] = [];
        mealHosts.forEach((host, hostIndex) => {
          const stopId = mealFillerStopId(legIndex, dayOffset, slot, hostIndex);
          stops.push({
            id: stopId,
            name: defaultMealLabel(slot),
            coordinate: host,
            serviceTimeSeconds: profile.defaultServiceSeconds,
            timeWindowStart: slotWindow.start,
            timeWindowEnd: slotWindow.end,
            priority: 1,
            isMeal: true,
            fixedDay: dayOffset,
            mealMetadata: {
              slot,
              category: slot === 'breakfast' || slot === 'snack' ? 'coffee' : 'restaurant',
              anchor: 'nearby',
              positional: true,
            },
          });
          groupIds.push(stopId);
        });
        if (groupIds.length > 0) fillerGroups.push(groupIds);
      }
    }

    return { stops, candidateGroups, fillerGroups };
  }

  private toStop(
    candidate: EnrichedPlace,
    priorityOrder: Map<string, number>,
    attractionPriority: Map<string, number>,
    fallbackIndex: number,
    dayContexts: DayContext[],
    serviceMultiplier: number,
    fixedDay?: number,
  ): InternalStop | null {
    const place = candidate.place;
    if (!place.placeId) return null;
    const minutes = candidate.insight?.averageMinutes ?? null;
    const visitService = minutes && minutes > 0 ? Math.round(minutes * 60) : DEFAULT_SERVICE_TIME_SECONDS;
    const planningBuffer = Math.max(0, Math.min(120, candidate.insight?.planningBufferMinutes ?? 0)) * 60;
    const rawService = visitService + planningBuffer;
    const minimumService = candidate.insight?.minimumRecommendedMinutes;
    const pacedService = Math.max(
      minimumService && minimumService > 0 ? Math.round(minimumService * 60) : 0,
      Math.round(visitService * serviceMultiplier),
    ) + planningBuffer;
    // Uma atividade que sozinha ocupa a maior parte de um dia confortável é
    // tratada como dia inteiro: escapa do teto normal e ocupa o dia sozinha.
    const fullDay = rawService >= FULL_DAY_THRESHOLD_RATIO * COMFORT_DAY_SECONDS;
    const serviceTimeSeconds = fullDay
      ? Math.min(pacedService, OPERATING_HORIZON_SECONDS)
      : Math.min(pacedService, NORMAL_SERVICE_CAP_SECONDS);
    const userPriority = attractionPriority.get(place.placeId);
    let priority: number;
    if (userPriority !== undefined) {
      priority = userPriority + 1;
    } else {
      const preferencePosition = this.preferenceFor(place, priorityOrder);
      priority = preferencePosition >= 0 ? preferencePosition + 1 : fallbackIndex + 100;
    }
    const schedule = attractionScheduleForTrip(
      place.businessStatus,
      place.openingHours,
      candidate.insight,
      dayContexts,
      serviceTimeSeconds,
    );
    // A janela do solver limita a CHEGADA. Uma atividade de dia inteiro precisa
    // começar cedo o bastante para caber num dia confortável (tours reais de
    // trilha/salar saem de manhã) — sem este teto, o solver chegava 11h numa
    // trilha de 8h e "voltava" às 21h37, coisa que nenhuma excursão real faz.
    const windowEnd = fullDay
      ? Math.max(
          schedule.window.start,
          Math.min(
            schedule.window.end,
            schedule.window.start + Math.max(0, COMFORT_DAY_SECONDS - serviceTimeSeconds),
          ),
        )
      : schedule.window.end;
    const dayTimeWindows = fullDay
      ? schedule.dayTimeWindows.map((window) => ({
          ...window,
          end: Math.max(
            window.start,
            Math.min(
              window.end,
              window.start + Math.max(0, COMFORT_DAY_SECONDS - serviceTimeSeconds),
            ),
          ),
        }))
      : schedule.dayTimeWindows;
    return {
      id: place.placeId,
      name: place.name,
      coordinate: place.coordinate,
      serviceTimeSeconds,
      timeWindowStart: schedule.window.start,
      timeWindowEnd: windowEnd,
      allowedDays: schedule.allowedDays,
      dayTimeWindows,
      preferredTimeWindow: schedule.preferredTimeWindow,
      seasonalSuitability: schedule.seasonalSuitability,
      unavailabilityReason: schedule.unavailabilityReason,
      priority,
      fixedDay,
      fullDay,
      importance: attractionImportance(place.userRatingCount, fullDay),
    };
  }

  private preferenceFor(place: PlaceSummary, priorityOrder: Map<string, number>): number {
    if (priorityOrder.size === 0) return -1;
    const candidates = [place.primaryType, ...(place.types ?? [])];
    let best = -1;
    for (const type of candidates) {
      if (!type) continue;
      const position = priorityOrder.get(type);
      if (position === undefined) continue;
      if (best === -1 || position < best) best = position;
    }
    return best;
  }

  private async toAirportStop(
    id: string,
    anchor: FlightAnchor | undefined,
    isArrival: boolean,
    fallbackBoundSeconds: number,
    transitionMode?: TransitionLeg['mode'],
  ): Promise<InternalStop | null> {
    if (!anchor) return null;
    const coordinate = anchor.coordinate ?? (await this.resolveAirportCoordinate(anchor));
    if (!coordinate) return null;
    const airportLabel = anchor.airportCode
      ? `${anchor.airportCode} · ${anchor.airportName ?? 'Aeroporto'}`
      : anchor.airportName ?? 'Aeroporto';
    const target = secondsFromOperatingDayStart(anchor.scheduledLocalIso, fallbackBoundSeconds);
    // Voo: ±2h de slack (check-in, atraso). Modos terrestres: ±15min (horário
    // mais previsível, e o usuário definiu manualmente).
    const isGround = transitionMode === 'car' || transitionMode === 'estimate';
    const slack = isGround ? 15 * 60 : 2 * 3600;
    const start = isArrival ? Math.max(0, target) : Math.max(0, target - slack);
    const end = isArrival
      ? Math.min(OPERATING_HORIZON_SECONDS, target + slack)
      : Math.min(OPERATING_HORIZON_SECONDS, target);
    return {
      id,
      name: airportLabel,
      coordinate,
      serviceTimeSeconds: 0,
      timeWindowStart: start,
      timeWindowEnd: end,
      priority: 1,
      isDepot: true,
    };
  }

  private async resolveAirportCoordinate(anchor: FlightAnchor): Promise<Coordinate | undefined> {
    if (!this.places) return undefined;
    return resolveAirportCoordinate(this.places, anchor.airportCode, anchor.airportName);
  }

  // Registra as transições entre legs para que o mobile ligue as cidades com
  // linha reta no mapa do dia. Sem traçado real (Directions API) — a navegação
  // fica a cargo do usuário, que pode abrir a rota num app de mapas externo.
  private computeTransitionSegments(
    request: ItineraryRequest,
  ): import('../domain/itinerary.js').TransitionSegment[] | undefined {
    const transitions = request.transitions ?? [];
    if (transitions.length === 0) return undefined;
    const legById = new Map(request.legs.map((leg) => [leg.legId, leg]));
    const segments: import('../domain/itinerary.js').TransitionSegment[] = [];
    for (const transition of transitions) {
      const fromLeg = legById.get(transition.fromLegId);
      const toLeg = legById.get(transition.toLegId);
      if (!fromLeg || !toLeg) continue;
      segments.push({ fromLegId: fromLeg.legId, toLegId: toLeg.legId });
    }
    return segments;
  }

  private toDays(
    response: SolverResponse,
    stops: InternalStop[],
    distances: number[][],
    durations: number[][],
    dayContexts: DayContext[],
    legId: string,
  ): DayPlan[] {
    const stopIndex = new Map(stops.map((stop, index) => [stop.id, index]));
    const stopById = new Map(stops.map((stop) => [stop.id, stop]));

    return response.days.slice(0, dayContexts.length).map((day, normalisedIndex) => {
      const context = dayContexts[normalisedIndex]!;
      const steps: RouteStep[] = day.steps.map((step) => {
        const internal = stopById.get(step.stop_id);
        const meal = internal?.mealMetadata;
        const positional = meal?.positional ?? false;
        return {
          stopId: step.stop_id,
          name: positional ? positionalMealLabel(meal!.slot) : step.name ?? internal?.name,
          coordinate: { latitude: step.latitude, longitude: step.longitude },
          order: step.order,
          arrivalSeconds: ABSOLUTE_DAY_START_SECONDS + step.arrival_seconds,
          departureSeconds: ABSOLUTE_DAY_START_SECONDS + step.departure_seconds,
          isDepot: step.is_depot,
          isMeal: step.is_meal ?? false,
          mealSlot: meal?.slot,
          mealCategory: meal?.category,
          mealAnchor: meal?.anchor,
          mealPositional: positional || undefined,
          mealPlaceId: meal?.placeId,
          mealCandidateId: meal?.candidateId,
          reservationLocalIso: meal?.reservationLocalIso,
          transitionMode: internal?.transitionMode,
          transitionDirection: internal?.transitionDirection,
          isAnchor: Boolean(internal?.anchorMetadata),
          anchorId: internal?.anchorMetadata?.id,
          anchorDayNumber: internal?.anchorMetadata?.dayNumber,
          anchorTotalDays: internal?.anchorMetadata?.totalDays,
          anchorGuide: internal?.anchorMetadata?.guide,
          anchorReservation: internal?.anchorMetadata?.reservation,
          anchorLogistics: internal?.anchorMetadata?.logistics,
        };
      });

      // Refeição posicional é co-localizada num host (atração/hotel), então os
      // trechos de/para ela vêm direto da matriz, como qualquer parada.
      const legs: RouteLeg[] = [];
      for (let i = 0; i < steps.length - 1; i += 1) {
        const from = steps[i]!;
        const to = steps[i + 1]!;
        const fromIdx = stopIndex.get(from.stopId);
        const toIdx = stopIndex.get(to.stopId);
        if (fromIdx === undefined || toIdx === undefined) continue;
        legs.push({
          fromStopId: from.stopId,
          toStopId: to.stopId,
          distanceMeters: distances[fromIdx]?.[toIdx] ?? 0,
          durationSeconds: durations[fromIdx]?.[toIdx] ?? 0,
        });
      }

      const dayDistanceMeters = legs.reduce((sum, lg) => sum + lg.distanceMeters, 0);

      return {
        dayIndex: context.globalDayIndex,
        legId,
        date: context.date ? formatLocalDate(context.date) : undefined,
        distanceMeters: dayDistanceMeters,
        totalTimeSeconds: day.total_time_seconds,
        steps,
        legs,
        isTransitDay: context.isTransitDay,
      };
    });
  }
}

interface MealMetadata {
  slot: MealSlot;
  category: MealCategory;
  anchor: MealAnchor;
  positional?: boolean;
  placeId?: string;
  candidateId?: string;
  reservationLocalIso?: string;
}

interface InternalStop {
  id: string;
  name: string;
  coordinate: { latitude: number; longitude: number };
  serviceTimeSeconds: number;
  timeWindowStart: number;
  timeWindowEnd: number;
  priority: number;
  isDepot?: boolean;
  isMeal?: boolean;
  fullDay?: boolean;
  importance?: number;
  fixedDay?: number;
  allowedDays?: number[];
  dayTimeWindows?: { dayIndex: number; start: number; end: number }[];
  preferredTimeWindow?: {
    start: number;
    end: number;
    strength: 'strong' | 'soft';
  };
  seasonalSuitability?: number;
  unavailabilityReason?: 'closed' | 'seasonal' | 'schedule';
  mealMetadata?: MealMetadata;
  transitionMode?: import('../domain/itinerary.js').TransitionMode;
  transitionDirection?: 'arrival' | 'departure';
  anchorMetadata?: {
    id: string;
    dayNumber: number;
    totalDays: number;
    guide: AnchorExperienceSelection['guide'];
    reservation: AnchorExperienceSelection['reservation'];
    logistics: string[];
  };
}

function anchorStopId(anchorId: string, segmentIndex: number): string {
  return `__anchor__${anchorId}__d${segmentIndex}__`;
}

function slotCoverageKey(dayOffset: number, slot: MealSlot): string {
  return `${dayOffset}:${slot}`;
}

function inferSlotFromIso(iso: string): MealSlot | null {
  const match = iso.match(/(?:T|\s)(\d{2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const hours = hour + minute / 60;
  for (const slot of MEAL_SLOT_ORDER) {
    const profile = MEAL_SLOT_PROFILES[slot];
    if (hours >= profile.windowStartHour && hours <= profile.windowEndHour) {
      return slot;
    }
  }
  return null;
}

// Garante ao menos uma hospedagem no leg. Quando o usuário não informa nenhuma,
// cria uma estadia sintética no centro da cidade cobrindo todo o leg (check-out
// no dia seguinte ao fim), para o solver ter um depósito de partida/retorno.
function ensureLodging(leg: ItineraryLegRequest): ItineraryLegRequest {
  if (leg.lodgings.length > 0) return leg;
  const end = parseLocalDate(leg.endDate);
  const checkOut = end ? formatLocalDate(addDays(end, 1)) : leg.endDate;
  const synthetic: LodgingStay = {
    id: `__city_center_${leg.legId}__`,
    name: leg.destinationName,
    coordinate: leg.destinationCoordinate,
    checkInDate: leg.startDate,
    checkOutDate: checkOut,
  };
  return { ...leg, lodgings: [synthetic] };
}

// Mapeia cada dia do leg para a hospedagem ativa: start = lodging do início,
// end = lodging do fim (igual ao start, exceto no dia da troca que termina no
// próximo). Assume hospedagens em ordem cronológica e cobrindo o leg inteiro.
function mapLodgingToDays(
  lodgings: LodgingStay[],
  dayContexts: DayContext[],
  _legIndex: number,
): { start: LodgingStay; end: LodgingStay }[] {
  const sorted = [...lodgings].sort((a, b) => a.checkInDate.localeCompare(b.checkInDate));
  if (sorted.length === 0) return [];
  const firstLodging = sorted[0]!;
  return dayContexts.map((context) => {
    const date = context.date ? formatLocalDate(context.date) : null;
    const startLodging = date
      ? findLodgingForDate(sorted, date) ?? firstLodging
      : firstLodging;
    const nextDate = context.date ? formatLocalDate(addDays(context.date, 1)) : null;
    const endLodging = nextDate
      ? findLodgingForDate(sorted, nextDate) ?? startLodging
      : startLodging;
    return { start: startLodging, end: endLodging };
  });
}

/**
 * Travessias consecutivas não retornam ao hotel entre etapas. Cada dia usa
 * um depósito sintético na coordenada final daquele segmento; o tempo da
 * caminhada já faz parte do serviço da experiência, portanto não criamos um
 * arco de carro fictício entre início e fim da trilha.
 *
 * O dia anterior termina no ponto de entrada e o dia posterior começa no
 * último ponto, preservando também a troca de base ao redor da travessia.
 */
function applyAnchorDepotOverrides(
  lodgingByDay: { start: LodgingStay; end: LodgingStay }[],
  anchors: AnchorExperienceSelection[],
  dayContexts: DayContext[],
): void {
  for (const anchor of anchors) {
    if (anchor.durationDays <= 1) continue;
    const segments = anchor.segments ?? [];
    if (segments.length !== anchor.durationDays) {
      throw new Error(`A travessia “${anchor.title}” precisa descrever todas as ${anchor.durationDays} etapas.`);
    }
    const firstDate = dayContexts[anchor.dayOffset]?.date;
    const entry: LodgingStay = {
      id: `__anchor_entry_${anchor.id}__`,
      name: `Entrada · ${anchor.title}`,
      coordinate: anchor.coordinate,
      checkInDate: firstDate ? formatLocalDate(firstDate) : '1970-01-01',
      checkOutDate: firstDate ? formatLocalDate(addDays(firstDate, 1)) : '1970-01-02',
    };
    if (anchor.dayOffset > 0 && lodgingByDay[anchor.dayOffset - 1]) {
      lodgingByDay[anchor.dayOffset - 1]!.end = entry;
    }
    segments.forEach((segment, segmentIndex) => {
      const dayOffset = anchor.dayOffset + segmentIndex;
      const contextDate = dayContexts[dayOffset]?.date;
      const stage: LodgingStay = {
        id: `__anchor_stage_${anchor.id}_${segmentIndex}__`,
        name: `Etapa ${segmentIndex + 1} · ${anchor.title}`,
        coordinate: segment.coordinate,
        checkInDate: contextDate ? formatLocalDate(contextDate) : '1970-01-01',
        checkOutDate: contextDate ? formatLocalDate(addDays(contextDate, 1)) : '1970-01-02',
      };
      if (lodgingByDay[dayOffset]) lodgingByDay[dayOffset] = { start: stage, end: stage };
    });
    const nextDay = anchor.dayOffset + anchor.durationDays;
    const lastSegment = segments[segments.length - 1];
    if (lastSegment && lodgingByDay[nextDay]) {
      lodgingByDay[nextDay]!.start = {
        id: `__anchor_exit_${anchor.id}__`,
        name: `Saída · ${anchor.title}`,
        coordinate: lastSegment.coordinate,
        checkInDate: lodgingByDay[nextDay]!.start.checkInDate,
        checkOutDate: lodgingByDay[nextDay]!.start.checkOutDate,
      };
    }
  }
}

function findLodgingForDate(lodgings: LodgingStay[], date: string): LodgingStay | null {
  for (const lodging of lodgings) {
    if (lodging.checkInDate <= date && date < lodging.checkOutDate) {
      return lodging;
    }
  }
  return null;
}

// Aperta a janela operacional do dia em duas situações:
// - dia de check-in (primeiro dia da estadia atual): atividades só podem
//   começar a partir do checkInTime, se informado.
// - dia de check-out (dia em que termina a estadia): atividades têm que
//   acabar até o checkOutTime, se informado.
function applyLodgingTimeWindows(
  dayContexts: DayContext[],
  lodgingByDay: { start: LodgingStay; end: LodgingStay }[],
): void {
  for (let i = 0; i < dayContexts.length; i += 1) {
    const context = dayContexts[i]!;
    const stay = lodgingByDay[i];
    if (!stay) continue;
    const date = context.date ? formatLocalDate(context.date) : undefined;
    const isCheckInDay = date === stay.start.checkInDate;
    if (isCheckInDay && stay.start.checkInTime) {
      const seconds = hhmmToSeconds(stay.start.checkInTime);
      if (seconds !== null) {
        context.windowStartSeconds = Math.max(
          context.windowStartSeconds,
          Math.min(context.windowEndSeconds, seconds - ABSOLUTE_DAY_START_SECONDS),
        );
      }
    }

    const isCheckOutDay = date === stay.end.checkOutDate;
    if (isCheckOutDay && stay.end.checkOutTime) {
      const seconds = hhmmToSeconds(stay.end.checkOutTime);
      if (seconds !== null) {
        context.windowEndSeconds = Math.min(
          context.windowEndSeconds,
          Math.max(context.windowStartSeconds, seconds - ABSOLUTE_DAY_START_SECONDS),
        );
      }
    }
  }
}

function hhmmToSeconds(value: string): number | null {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 3600 + minute * 60;
}

// Converte uma transição num FlightAnchor "fake" para reusar a infra de
// aeroporto do solver. A coordenada usa a `arrivalAnchor.coordinate` se houver
// (caso de voo com lookup IATA), senão cai pro fallback (geralmente a cidade).
function transitionToArrivalAnchor(
  transition: TransitionLeg,
  fallbackCoordinate: Coordinate,
): FlightAnchor | undefined {
  if (!transition.arrivalLocalIso) return undefined;
  return {
    airportCode: transition.arrivalAnchor?.airportCode,
    airportName: transition.arrivalAnchor?.airportName ?? labelForTransitionMode(transition.mode, 'arrival'),
    scheduledLocalIso: transition.arrivalLocalIso,
    coordinate: transition.arrivalAnchor?.coordinate ?? fallbackCoordinate,
  };
}

function transitionToDepartureAnchor(
  transition: TransitionLeg,
  fallbackCoordinate: Coordinate,
): FlightAnchor | undefined {
  if (!transition.departureLocalIso) return undefined;
  return {
    airportCode: transition.flightDetails?.airportCode,
    airportName: transition.flightDetails?.airportName ?? labelForTransitionMode(transition.mode, 'departure'),
    scheduledLocalIso: transition.departureLocalIso,
    coordinate: transition.flightDetails?.coordinate ?? fallbackCoordinate,
  };
}

function labelForTransitionMode(
  mode: TransitionLeg['mode'],
  direction: 'departure' | 'arrival',
): string {
  const verb = direction === 'departure' ? 'Saída' : 'Chegada';
  switch (mode) {
    case 'flight':
      return `${verb} aérea`;
    case 'car':
      return `${verb} terrestre`;
    case 'estimate':
      return verb;
  }
}

// A descoberta do Google devolve com frequência o mesmo lugar sob placeIds
// diferentes (entradas em idiomas distintos, "X" e "X Parking") — sem dedupe o
// roteiro visita a mesma cachoeira duas vezes em sequência. Nome normalizado
// igual + proximidade física = mesmo lugar; fica o de mais avaliações.
const DUPLICATE_NAME_MAX_DISTANCE_METERS = 500;

function normalizePlaceName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function dedupeCandidatesWithinLeg(leg: ItineraryLegRequest): ItineraryLegRequest {
  const sorted = [...leg.candidates].sort(
    (a, b) => (b.place.userRatingCount ?? 0) - (a.place.userRatingCount ?? 0),
  );
  const kept: EnrichedPlace[] = [];
  const keptIds = new Set<string>();
  for (const candidate of sorted) {
    if (keptIds.has(candidate.place.placeId)) continue;
    const name = normalizePlaceName(candidate.place.name);
    const duplicate = kept.find(
      (other) =>
        normalizePlaceName(other.place.name) === name &&
        haversineMeters(other.place.coordinate, candidate.place.coordinate) <=
          DUPLICATE_NAME_MAX_DISTANCE_METERS,
    );
    if (duplicate) {
      ilog(
        `leg ${leg.legId}: candidato duplicado "${candidate.place.name}" (${candidate.place.placeId}) ` +
          `descartado em favor de ${duplicate.place.placeId}`,
      );
      continue;
    }
    kept.push(candidate);
    keptIds.add(candidate.place.placeId);
  }
  if (kept.length === leg.candidates.length) return leg;
  // Restaura a ordem original entre os mantidos (a ordenação por avaliações
  // era só para escolher o representante da duplicata).
  const keptSet = new Set(kept.map((c) => c.place.placeId));
  return { ...leg, candidates: leg.candidates.filter((c) => keptSet.has(c.place.placeId)) };
}

// O mesmo placeId em dois legs (parque na fronteira entre duas bases, caso
// Torres del Paine entre El Calafate e Puerto Natales) seria visitado duas
// vezes na mesma viagem. Fica apenas no leg cuja cidade-base está mais perto.
function dedupeCandidatesAcrossLegs(legs: ItineraryLegRequest[]): ItineraryLegRequest[] {
  if (legs.length < 2) return legs;
  const bestLegByPlace = new Map<string, { legIndex: number; distance: number }>();
  legs.forEach((leg, legIndex) => {
    for (const candidate of leg.candidates) {
      const distance = haversineMeters(candidate.place.coordinate, leg.destinationCoordinate);
      const current = bestLegByPlace.get(candidate.place.placeId);
      if (!current || distance < current.distance) {
        bestLegByPlace.set(candidate.place.placeId, { legIndex, distance });
      }
    }
  });
  return legs.map((leg, legIndex) => {
    const kept = leg.candidates.filter((candidate) => {
      const best = bestLegByPlace.get(candidate.place.placeId);
      const keep = !best || best.legIndex === legIndex;
      if (!keep) {
        ilog(
          `leg ${leg.legId}: "${candidate.place.name}" removido — mais perto de ` +
            `${legs[best!.legIndex]!.destinationName}, fica lá`,
        );
      }
      return keep;
    });
    return kept.length === leg.candidates.length ? leg : { ...leg, candidates: kept };
  });
}

function dedupePois(pois: PlaceSummary[]): PlaceSummary[] {
  const seen = new Set<string>();
  const result: PlaceSummary[] = [];
  for (const poi of pois) {
    if (seen.has(poi.placeId)) continue;
    seen.add(poi.placeId);
    result.push(poi);
  }
  return result;
}

function secondsFromOperatingDayStart(value: string, fallback: number): number {
  const match = value.match(/(?:T|\s)(\d{2}):(\d{2})/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return fallback;
  const seconds = hour * 3600 + minute * 60 - ABSOLUTE_DAY_START_SECONDS;
  return Math.max(0, Math.min(OPERATING_HORIZON_SECONDS, seconds));
}

function addOneDayIso(iso: string): string {
  const parsed = parseLocalDate(iso);
  if (!parsed) return iso;
  return formatLocalDate(addDays(parsed, 1));
}

function parseLocalDate(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date: Date, amount: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + amount);
  return result;
}

function formatLocalDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

interface ResolvedWindow {
  start: number;
  end: number;
}

function isWindow(value: ResolvedWindow | null): value is ResolvedWindow {
  return value !== null;
}

function intersectWindows(windows: ResolvedWindow[]): ResolvedWindow | null {
  if (windows.length === 0) return null;
  let start = windows[0]!.start;
  let end = windows[0]!.end;
  for (let i = 1; i < windows.length; i += 1) {
    start = Math.max(start, windows[i]!.start);
    end = Math.min(end, windows[i]!.end);
  }
  if (end <= start) return null;
  return { start, end };
}

function mealSlotWindow(
  profile: { windowStartHour: number; windowEndHour: number },
  dayContext: DayContext,
): ResolvedWindow {
  const start = Math.max(
    dayContext.windowStartSeconds,
    Math.round(profile.windowStartHour * 3600) - ABSOLUTE_DAY_START_SECONDS,
  );
  const end = Math.min(
    dayContext.windowEndSeconds,
    Math.round(profile.windowEndHour * 3600) - ABSOLUTE_DAY_START_SECONDS,
  );
  return { start, end };
}

function reservationWindow(iso: string, serviceSeconds: number): ResolvedWindow | null {
  const target = secondsFromOperatingDayStart(iso, -1);
  if (target < 0) return null;
  return {
    start: Math.max(0, target - RESERVATION_SLACK_SECONDS),
    end: Math.min(OPERATING_HORIZON_SECONDS, target + RESERVATION_SLACK_SECONDS + serviceSeconds),
  };
}

function openingHoursWindowForDay(
  hours: OpeningHours,
  dayContext: DayContext,
  serviceSeconds: number,
): ResolvedWindow | null {
  if (!hours.periods?.length || !dayContext.date) return null;
  const weekday = dayContext.date.getUTCDay();
  const operatingStart = dayContext.windowStartSeconds;
  const operatingEnd = dayContext.windowEndSeconds;
  if (hours.periods.length === 1 && !hours.periods[0]?.close) {
    const end = operatingEnd - serviceSeconds;
    return end >= operatingStart ? { start: operatingStart, end } : null;
  }
  let best: ResolvedWindow | null = null;
  for (const period of hours.periods) {
    if (!period.open) continue;
    const opensToday = period.open.day === weekday;
    const carriesFromPreviousDay =
      period.close?.day === weekday && period.open.day !== weekday;
    if (!opensToday && !carriesFromPreviousDay) continue;
    const openSec = opensToday
      ? period.open.hour * 3600 + period.open.minute * 60 - ABSOLUTE_DAY_START_SECONDS
      : operatingStart;
    let closeSec = OPERATING_HORIZON_SECONDS;
    if (period.close && period.close.day === weekday) {
      closeSec = period.close.hour * 3600 + period.close.minute * 60 - ABSOLUTE_DAY_START_SECONDS;
    }
    const start = Math.max(operatingStart, openSec);
    // A dimensão de tempo representa o INÍCIO da visita. Portanto, o último
    // início permitido é fechamento - duração, nunca o próprio fechamento.
    const end = Math.min(operatingEnd - serviceSeconds, closeSec - serviceSeconds);
    if (end < start) continue;
    if (best === null || end - start > best.end - best.start) {
      best = { start, end };
    }
  }
  return best;
}

function defaultMealLabel(slot: MealSlot): string {
  switch (slot) {
    case 'breakfast':
      return 'Café da manhã';
    case 'lunch':
      return 'Almoço';
    case 'snack':
      return 'Lanche da tarde';
    case 'dinner':
      return 'Jantar';
  }
}

function positionalMealLabel(slot: MealSlot): string {
  return `${defaultMealLabel(slot)} em algum local próximo`;
}

// Importância turística (0..1) que escala a resistência do POI ao corte no
// solver. Proxy: volume de avaliações em escala log (1k→0.5, 100k→1.0), com
// piso alto para atividades de dia inteiro — o destaque da viagem (uma trilha
// icônica) não deve ser dropado em favor de vários pontos menores.
function attractionImportance(userRatingCount: number | undefined, fullDay: boolean): number {
  // Atividade de dia inteiro é o destaque inequívoco da viagem (a trilha, a
  // subida ao vulcão): praticamente intocável, custe o que custar em tempo.
  if (fullDay) return 1.0;
  const reviews = userRatingCount ?? 0;
  // log10(1+reviews)/5 satura ~1.0 em 100k avaliações.
  return Math.min(1, Math.log10(1 + reviews) / 5);
}

interface AttractionSchedule {
  window: ResolvedWindow;
  allowedDays: number[];
  dayTimeWindows: { dayIndex: number; start: number; end: number }[];
  preferredTimeWindow?: {
    start: number;
    end: number;
    strength: 'strong' | 'soft';
  };
  seasonalSuitability: number;
  unavailabilityReason?: 'closed' | 'seasonal' | 'schedule';
}

function attractionScheduleForTrip(
  businessStatus: PlaceSummary['businessStatus'],
  openingHours: OpeningHours | undefined,
  insight: PlaceInsight | undefined,
  dayContexts: DayContext[],
  serviceTimeSeconds: number,
): AttractionSchedule {
  const fallback: ResolvedWindow = {
    start: dayContexts[0]?.windowStartSeconds ?? 0,
    end: Math.max(
      dayContexts[0]?.windowStartSeconds ?? 0,
      (dayContexts[0]?.windowEndSeconds ?? OPERATING_HORIZON_SECONDS) - serviceTimeSeconds,
    ),
  };
  const visitWindow = insight?.recommendedVisitWindow;
  const recommendedStart = visitWindow
    ? localTimeToOperatingSeconds(visitWindow.earliestStartLocalTime)
    : null;
  const recommendedEnd = visitWindow
    ? localTimeToOperatingSeconds(visitWindow.latestStartLocalTime)
    : null;
  const requiredWindow =
    visitWindow?.strength === 'required' && recommendedStart !== null && recommendedEnd !== null
      ? { start: recommendedStart, end: recommendedEnd }
      : null;

  const dayTimeWindows: AttractionSchedule['dayTimeWindows'] = [];
  for (const context of dayContexts) {
    if (businessStatus === 'CLOSED_TEMPORARILY' || businessStatus === 'CLOSED_PERMANENTLY') {
      continue;
    }
    if (!isSeasonallyAvailable(insight, context.date)) continue;
    const opening = openingHours?.periods?.length
      ? openingHoursWindowForDay(openingHours, context, serviceTimeSeconds)
      : {
          start: context.windowStartSeconds,
          end: Math.max(context.windowStartSeconds, context.windowEndSeconds - serviceTimeSeconds),
        };
    if (!opening) continue;
    const window = requiredWindow
      ? intersectWindows([opening, requiredWindow])
      : opening;
    if (!window || window.end < window.start) continue;
    dayTimeWindows.push({
      dayIndex: context.dayOffsetInLeg,
      start: window.start,
      end: window.end,
    });
  }

  const window = dayTimeWindows.length > 0
    ? {
        start: Math.min(...dayTimeWindows.map((item) => item.start)),
        end: Math.max(...dayTimeWindows.map((item) => item.end)),
      }
    : fallback;
  const preferredTimeWindow =
    visitWindow &&
    visitWindow.strength !== 'required' &&
    recommendedStart !== null &&
    recommendedEnd !== null
      ? {
          start: recommendedStart,
          end: recommendedEnd,
          strength: visitWindow.strength,
        }
      : undefined;
  const datedMonths = dayContexts
    .map((context) => context.date?.getUTCMonth() !== undefined
      ? (context.date?.getUTCMonth() ?? 0) + 1
      : null)
    .filter((month): month is number => month !== null);
  const avoidMonths = new Set(insight?.seasonality?.avoidMonths ?? []);
  const seasonalSuitability =
    datedMonths.length > 0 && datedMonths.every((month) => avoidMonths.has(month)) ? 0.6 : 1;
  let unavailabilityReason: AttractionSchedule['unavailabilityReason'];
  if (dayTimeWindows.length === 0) {
    if (businessStatus === 'CLOSED_TEMPORARILY' || businessStatus === 'CLOSED_PERMANENTLY') {
      unavailabilityReason = 'closed';
    } else if (
      dayContexts.length > 0 &&
      dayContexts.every((context) => !isSeasonallyAvailable(insight, context.date))
    ) {
      unavailabilityReason = 'seasonal';
    } else {
      unavailabilityReason = 'schedule';
    }
  }

  return {
    window,
    allowedDays: dayTimeWindows.map((item) => item.dayIndex),
    dayTimeWindows,
    preferredTimeWindow,
    seasonalSuitability,
    unavailabilityReason,
  };
}

function localTimeToOperatingSeconds(value: string): number | null {
  const seconds = hhmmToSeconds(value);
  if (seconds === null) return null;
  return Math.max(0, Math.min(OPERATING_HORIZON_SECONDS, seconds - ABSOLUTE_DAY_START_SECONDS));
}

function isSeasonallyAvailable(insight: PlaceInsight | undefined, date: Date | null): boolean {
  if (!date || !insight || insight.confidence === 'low') return true;
  const seasonality = insight.seasonality;
  if (seasonality?.availability !== 'seasonal' || !seasonality.availableMonths?.length) {
    return true;
  }
  return seasonality.availableMonths.includes(date.getUTCMonth() + 1);
}

function mergeSharedDays(
  legResults: LegSegmentResult[],
  transitions: TransitionLeg[],
  segments: import('../domain/itinerary.js').TransitionSegment[],
): { days: DayPlan[]; legs: ItineraryLegSummary[] } {
  if (legResults.length === 0) return { days: [], legs: [] };

  const merged: DayPlan[] = [];
  const updatedSummaries = legResults.map((r) => ({ ...r.summary }));

  for (let i = 0; i < legResults.length; i += 1) {
    const result = legResults[i]!;
    const previousResult = i > 0 ? legResults[i - 1] : null;
    const previousLastDay = previousResult?.days[previousResult.days.length - 1];
    const firstDay = result.days[0];

    if (
      previousResult &&
      previousLastDay?.date &&
      firstDay?.date &&
      previousLastDay.date === firstDay.date
    ) {
      const transition = transitions.find(
        (t) => t.fromLegId === previousResult.summary.legId && t.toLegId === result.summary.legId,
      );
      const segment = segments.find(
        (s) => s.fromLegId === previousResult.summary.legId && s.toLegId === result.summary.legId,
      );
      const dayA = merged.pop()!; // remove o último dia do leg anterior, vai virar fundido
      ilog(
        `merge dia compartilhado ${firstDay.date}: ` +
          `${previousResult.summary.legId} (${dayA.steps.length} steps) + ` +
          `${result.summary.legId} (${firstDay.steps.length} steps), ` +
          `transição=${transition?.mode ?? 'AUSENTE'} segment=${segment ? 'sim' : 'não'}`,
      );
      const mergedDay = mergeDayPlans(dayA, firstDay, transition, segment);
      ilog(
        `  dia fundido: ${mergedDay.steps
          .map((s) => `${s.name ?? s.stopId}${s.transitionMode ? ` [${s.transitionMode}/${s.transitionDirection}]` : ''}`)
          .join(' → ')}`,
      );
      merged.push(mergedDay);
      // Atualiza dayIndexStart do leg atual para apontar pro dia fundido
      const sharedDayIndex = merged.length - 1;
      updatedSummaries[i] = { ...updatedSummaries[i]!, dayIndexStart: sharedDayIndex };
      // Atualiza dayIndexEnd do leg anterior para apontar pro dia fundido
      updatedSummaries[i - 1] = { ...updatedSummaries[i - 1]!, dayIndexEnd: sharedDayIndex };
      // Adiciona os demais dias do leg atual (pulando o primeiro que foi fundido)
      for (let d = 1; d < result.days.length; d += 1) {
        merged.push({ ...result.days[d]!, dayIndex: merged.length });
      }
      updatedSummaries[i] = {
        ...updatedSummaries[i]!,
        dayIndexEnd: merged.length - 1,
      };
    } else {
      if (previousResult) {
        ilog(
          `legs ${previousResult.summary.legId}→${result.summary.legId}: sem dia compartilhado ` +
            `(${previousLastDay?.date ?? '?'} ≠ ${firstDay?.date ?? '?'}), dias mantidos separados`,
        );
      }
      for (const day of result.days) {
        merged.push({ ...day, dayIndex: merged.length });
      }
      updatedSummaries[i] = {
        ...updatedSummaries[i]!,
        dayIndexStart: merged.length - result.days.length,
        dayIndexEnd: merged.length - 1,
      };
    }
  }

  return { days: merged, legs: updatedSummaries };
}

function mergeDayPlans(
  dayA: DayPlan,
  dayB: DayPlan,
  _transition: TransitionLeg | undefined,
  segment: import('../domain/itinerary.js').TransitionSegment | undefined,
): DayPlan {
  // Combina steps: A (sem hospedagem final) + B (sem hospedagem inicial).
  // O depot inicial de B é descartado porque o roteiro do dia continua a
  // partir do "Chegada" do leg B, que já existe na lista.
  const stepsA = dayA.steps.slice();
  const stepsB = dayB.steps.slice();

  // Remove o último step de A se for depot (hospedagem de check-out).
  // Mantém arrival/departure transitions.
  if (stepsA.length > 0) {
    const last = stepsA[stepsA.length - 1]!;
    if (last.isDepot && !last.transitionMode) {
      stepsA.pop();
    }
  }
  // Remove o primeiro step de B se for depot (hospedagem de check-in da
  // manhã) — a "chegada" do leg B vem depois e ela é o início real do dia em B.
  if (stepsB.length > 0) {
    const first = stepsB[0]!;
    if (first.isDepot && !first.transitionMode) {
      stepsB.shift();
    }
  }

  const combinedSteps: RouteStep[] = [...stepsA, ...stepsB].map((step, idx) => ({
    ...step,
    order: idx,
  }));

  // Recalcula legs (segmentos) entre os steps fundidos.
  const combinedLegs: RouteLeg[] = [];
  for (let i = 0; i < combinedSteps.length - 1; i += 1) {
    const from = combinedSteps[i]!;
    const to = combinedSteps[i + 1]!;
    // Trecho entre saída de A e chegada de B = transition segment (real)
    const isTransitionLeg = Boolean(from.transitionMode);
    if (isTransitionLeg && to.transitionMode && segment) {
      combinedLegs.push({
        fromStopId: from.stopId,
        toStopId: to.stopId,
        distanceMeters: segment.distanceMeters ?? 0,
        durationSeconds: segment.durationSeconds ?? 0,
      });
    } else {
      // Reaproveita o leg original se já existir em dayA ou dayB
      const existing =
        dayA.legs.find((l) => l.fromStopId === from.stopId && l.toStopId === to.stopId) ??
        dayB.legs.find((l) => l.fromStopId === from.stopId && l.toStopId === to.stopId);
      if (existing) {
        combinedLegs.push(existing);
      } else {
        combinedLegs.push({
          fromStopId: from.stopId,
          toStopId: to.stopId,
          distanceMeters: 0,
          durationSeconds: 0,
        });
      }
    }
  }

  return {
    dayIndex: dayA.dayIndex,
    legId: dayA.legId, // legId do leg A (origem) — mas o dia tem POIs dos dois
    date: dayA.date,
    distanceMeters: (dayA.distanceMeters ?? 0) + (dayB.distanceMeters ?? 0) + (segment?.distanceMeters ?? 0),
    totalTimeSeconds: (dayA.totalTimeSeconds ?? 0) + (dayB.totalTimeSeconds ?? 0) + (segment?.durationSeconds ?? 0),
    steps: combinedSteps,
    legs: combinedLegs,
    isTransitDay: true,
  };
}

export async function resolveAirportCoordinate(
  places: PlacesPort,
  airportCode?: string,
  airportName?: string,
): Promise<Coordinate | undefined> {
  const code = airportCode?.trim();
  const name = airportName?.trim();
  const looksLikeCodeOnly = !!name && !!code && name.toUpperCase() === code.toUpperCase();
  const queries: string[] = [];
  if (name && !looksLikeCodeOnly) queries.push(`${name} airport`);
  if (code) queries.push(`${code} airport`);
  if (name && !looksLikeCodeOnly && code) queries.push(`${name} (${code})`);

  const filterCombinations: Array<string[] | undefined> = [['airport'], undefined];
  for (const query of queries) {
    for (const includedTypes of filterCombinations) {
      try {
        const [match] = await places.searchText({
          query,
          maxResultCount: 1,
          includedTypes,
        });
        if (match?.coordinate) return match.coordinate;
      } catch {
        // try next query/type combination
      }
    }
  }
  return undefined;
}
