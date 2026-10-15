import type { Coordinate, MealCategory, MealSlot, Pace, TravelMode } from './value-objects.js';
import type { EnrichedPlace, OpeningHours, PlaceSummary } from './place.js';

export interface FlightAnchor {
  airportCode?: string;
  airportName?: string;
  scheduledLocalIso: string;
  coordinate?: Coordinate;
}

export interface FlightPlan {
  arrival?: FlightAnchor;
  departure?: FlightAnchor;
}

export interface LodgingStay {
  id: string;
  placeId?: string;
  name: string;
  coordinate: Coordinate;
  formattedAddress?: string;
  checkInDate: string;
  checkOutDate: string;
  checkInTime?: string;
  checkOutTime?: string;
}

export interface ItineraryPreferences {
  pace?: Pace;
}

// 'nearby': refeição sem local definido — apenas um bloco de tempo posicional
// inserido onde o roteiro já está. 'place': restaurante real escolhido.
export type MealAnchor = 'nearby' | 'place';

export interface MealCandidate {
  id: string;
  legId: string;
  category: MealCategory;
  anchor: MealAnchor;
  placeId?: string;
  placeName: string;
  coordinate?: Coordinate;
  openingHours?: OpeningHours;
  reservationLocalIso?: string;
  serviceTimeSeconds?: number;
  suggestionType?: string;
  // Dia (offset 0-based dentro do leg) ao qual o usuário fixou a refeição.
  // Ausente: o solver escolhe o melhor dia entre as alternativas geradas.
  dayOffset?: number;
}

export interface ItineraryLegRequest {
  legId: string;
  destinationName: string;
  destinationCoordinate: Coordinate;
  startDate: string;
  endDate: string;
  lodgings: LodgingStay[];
  candidates: EnrichedPlace[];
  color: string;
  preferences?: ItineraryPreferences;
  /** Meio de locomoção preferido nesta cidade. Ausente: carro (padrão). */
  travelMode?: TravelMode;
}

export interface AnchorExperienceSelection {
  id: string;
  legId: string;
  title: string;
  summary?: string;
  coordinate: Coordinate;
  dayOffset: number;
  durationDays: number;
  dailyDurationMinutes: number;
  startTime: string;
  latestStartTime: string;
  availableMonths?: number[];
  avoidMonths?: number[];
  guide: 'not_needed' | 'recommended' | 'required';
  reservation: 'none' | 'recommended' | 'required';
  bookingLeadDays?: number;
  physicalDemand: 'low' | 'medium' | 'high';
  weatherSensitivity: 'low' | 'medium' | 'high';
  logistics: string[];
  segments?: Array<{
    title: string;
    coordinate: Coordinate;
    durationMinutes: number;
    startTime?: string;
    note?: string;
  }>;
}

// 'flight' = aéreo; 'car' = terrestre; 'estimate' = só horários (transporte
// não especificado, tratado como terrestre para fins de âncora).
export type TransitionMode = 'flight' | 'car' | 'estimate';

export interface TransitionLeg {
  fromLegId: string;
  toLegId: string;
  mode: TransitionMode;
  departureLocalIso?: string;
  arrivalLocalIso?: string;
  flightDetails?: FlightAnchor;
  arrivalAnchor?: FlightAnchor;
}

export interface ItineraryRequest {
  legs: ItineraryLegRequest[];
  transitions?: TransitionLeg[];
  preferenceOrder: string[];
  mealCandidates?: MealCandidate[];
  attractionPriority?: string[];
  /** Dia local da etapa em que uma atração curada deve permanecer. */
  attractionDayAssignments?: Array<{ legId: string; placeId: string; dayOffset: number }>;
  mealPriority?: string[];
  flightPlan?: FlightPlan;
  preferences?: ItineraryPreferences;
  /** Passeios estruturados de um ou vários dias, fixados em dias consecutivos. */
  anchorExperiences?: AnchorExperienceSelection[];
}

export interface RouteStep {
  stopId: string;
  name?: string;
  coordinate: Coordinate;
  order: number;
  arrivalSeconds: number;
  departureSeconds: number;
  isDepot: boolean;
  isMeal?: boolean;
  mealSlot?: MealSlot;
  mealCategory?: MealCategory;
  mealPlaceId?: string;
  mealAnchor?: MealAnchor;
  // Refeição sem local definido: bloco de tempo posicional cuja coordenada é
  // herdada do trecho. A UI exibe "Refeição em algum local próximo".
  mealPositional?: boolean;
  mealCandidateId?: string;
  reservationLocalIso?: string;
  transitionMode?: TransitionMode;
  transitionDirection?: 'arrival' | 'departure';
  isAnchor?: boolean;
  anchorId?: string;
  anchorDayNumber?: number;
  anchorTotalDays?: number;
  anchorGuide?: AnchorExperienceSelection['guide'];
  anchorReservation?: AnchorExperienceSelection['reservation'];
  anchorLogistics?: string[];
}

export interface RouteLeg {
  fromStopId: string;
  toStopId: string;
  distanceMeters: number;
  durationSeconds: number;
}

export interface DayPlan {
  dayIndex: number;
  legId?: string;
  date?: string;
  distanceMeters: number;
  totalTimeSeconds: number;
  steps: RouteStep[];
  legs: RouteLeg[];
  isTransitDay?: boolean;
}

export interface UnassignedStop {
  stopId: string;
  name?: string;
  coordinate: Coordinate;
  priority: number;
  kind?: 'attraction' | 'meal' | 'anchor';
  mealCategory?: MealCategory;
  reason?: 'closed' | 'seasonal' | 'schedule' | 'capacity';
}

export interface ItineraryLegSummary {
  legId: string;
  color: string;
  destinationName: string;
  startDate: string;
  endDate: string;
  dayIndexStart: number;
  dayIndexEnd: number;
}

export interface TransitionSegment {
  fromLegId: string;
  toLegId: string;
  distanceMeters?: number;
  durationSeconds?: number;
}

export type SolverTraceNodeKind = 'attraction' | 'depot' | 'meal' | 'anchor';

export interface SolverTraceNode {
  stopId: string;
  name?: string;
  coordinate: Coordinate;
  legId: string;
  kind: SolverTraceNodeKind;
  status: 'assigned' | 'unassigned' | 'alternative';
  assignments: { dayIndex: number; arrivalSeconds: number; departureSeconds: number }[];
  serviceTimeSeconds: number;
  timeWindowStartSeconds?: number;
  timeWindowEndSeconds?: number;
  preferredTimeWindowStartSeconds?: number;
  preferredTimeWindowEndSeconds?: number;
  preferredTimeWindowStrength?: 'strong' | 'soft';
  priority: number;
  fixedDayIndex?: number;
  allowedDayIndices?: number[];
  importance?: number;
  seasonalSuitability?: number;
  reason?: 'closed' | 'seasonal' | 'schedule' | 'capacity';
  internalAlternative?: boolean;
}

export interface SolverTraceEdge {
  fromStopId: string;
  toStopId: string;
  distanceMeters: number;
  durationSeconds: number;
  dayIndex?: number;
}

/** Diagnóstico persistível da entrada e da saída do solver para a defesa do TCC. */
export interface SolverTrace {
  source: 'solver' | 'derived' | 'demo-fixture';
  engine: 'Google OR-Tools';
  model: 'VRPTW';
  generatedAt: string;
  solveDurationMs: number;
  nodeCount: number;
  consideredDirectedEdges: number;
  matrixFallbackPairs: number;
  baselineDistanceMeters: number;
  optimizedDistanceMeters: number;
  minStopsPerDay: number;
  maxStopsPerDay: number;
  horizonSeconds: number;
  nodes: SolverTraceNode[];
  solutionEdges: SolverTraceEdge[];
  /** Até cinco vizinhos mais próximos por nó; a matriz completa não é persistida. */
  candidateEdges: SolverTraceEdge[];
}

export interface ItinerarySolution {
  totalDistanceMeters: number;
  totalTimeSeconds: number;
  days: DayPlan[];
  unassigned: UnassignedStop[];
  pois: PlaceSummary[];
  legs: ItineraryLegSummary[];
  transitionSegments?: TransitionSegment[];
  solverTrace?: SolverTrace;
}
