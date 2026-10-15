export interface Coordinate {
  latitude: number;
  longitude: number;
}

export interface Viewport {
  northeast: Coordinate;
  southwest: Coordinate;
}

// Meio de locomoção preferido na cidade. Aproxima os tempos de deslocamento do
// roteiro (carro, transporte público ou a pé); a navegação real fica a cargo
// do usuário. Escolhido por cidade na tela de preferências.
export type TravelMode = 'car' | 'transit' | 'walk';

export type Pace = 'relaxed' | 'moderate' | 'intense';

export interface OpeningPeriodPoint {
  day: number;
  hour: number;
  minute: number;
}

export interface OpeningPeriod {
  open: OpeningPeriodPoint;
  close?: OpeningPeriodPoint;
}

export interface OpeningHours {
  periods: OpeningPeriod[];
}

export interface PlaceSummary {
  placeId: string;
  name: string;
  formattedAddress?: string;
  coordinate: Coordinate;
  primaryType?: string;
  types?: string[];
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  photoNames?: string[];
  openingHours?: OpeningHours;
  businessStatus?: 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY';
}

export interface PlaceInsight {
  placeId: string;
  averageMinutes: number | null;
  minimumRecommendedMinutes?: number | null;
  averageCost: { value: number; currency: string } | null;
  confidence: 'high' | 'medium' | 'low';
  description?: string;
  recommendedVisitWindow?: RecommendedVisitWindow;
  seasonality?: PlaceSeasonality;
  environment?: 'indoor' | 'outdoor' | 'mixed';
  weatherSensitivity?: 'low' | 'medium' | 'high';
  physicalDemand?: 'low' | 'medium' | 'high';
  reservationAdvice?: 'none' | 'recommended' | 'required';
  typicalBookingLeadDays?: number | null;
  accessibilityNotes?: string;
  familyNotes?: string;
  visitMode?: 'independent' | 'timed_entry' | 'guided_departure' | 'event';
  planningBufferMinutes?: number | null;
  operationalDependency?: 'none' | 'daylight' | 'tide' | 'snow' | 'water_level' | 'wildlife' | 'weather';
  operationalNotes?: string;
  equipmentNotes?: string;
  transportAccessNotes?: string;
  crowdSensitivity?: 'low' | 'medium' | 'high';
}

export interface RecommendedVisitWindow {
  earliestStartLocalTime: string;
  latestStartLocalTime: string;
  strength: 'required' | 'strong' | 'soft';
  reason?: string;
}

export interface PlaceSeasonality {
  availability: 'year_round' | 'seasonal' | 'unknown';
  availableMonths?: number[];
  avoidMonths?: number[];
  reason?: string;
}

export interface EnrichedPlace {
  place: PlaceSummary;
  insight?: PlaceInsight;
  photoUrl?: string;
  photoAttribution?: {
    author: string;
    license: string;
    sourceUrl: string;
  };
}

export interface AutocompleteSuggestion {
  placeId: string;
  primaryText: string;
  secondaryText?: string;
  types?: string[];
}

export interface CitySuggestion {
  name: string;
  reason?: string;
  recommendedDays?: number;
}

export interface PlaceDetails extends PlaceSummary {
  viewport?: Viewport;
  websiteUri?: string;
  internationalPhoneNumber?: string;
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

export interface FlightAnchor {
  airportCode?: string;
  airportName?: string;
  scheduledLocalIso: string;
  coordinate?: Coordinate;
}

export interface OriginPlace {
  placeId?: string;
  iata?: string;
  name: string;
  coordinate?: Coordinate;
}

export interface FlightPlan {
  travelStartDate: string;
  travelEndDate: string;
  arrival?: FlightAnchor;
  departure?: FlightAnchor;
  // Cidade/aeroporto de partida do viajante. Alimenta a sugestão automática
  // de voos no passo 3.
  origin?: OriginPlace;
}

export interface ItineraryPreferences {
  pace?: Pace;
}

export interface FlightSuggestionLeg {
  airlineCode: string;
  flightNumber: string;
  departureAirport: string;
  arrivalAirport: string;
  departureIso: string;
  arrivalIso: string;
  durationMinutes: number;
}

export interface FlightSuggestionDirection {
  departureAirport: string;
  arrivalAirport: string;
  departureIso: string;
  arrivalIso: string;
  durationMinutes: number;
  stops: number;
  airlines: string[];
  legs: FlightSuggestionLeg[];
}

export interface FlightSuggestion {
  price: number;
  currency?: string;
  outbound: FlightSuggestionDirection;
  inbound?: FlightSuggestionDirection;
}

export interface FlightSuggestionsResult {
  origin: { iata: string; name: string };
  destination: { iata: string; name: string };
  options: FlightSuggestion[];
  available: boolean;
}

export interface BudgetPreferences {
  currency: string;
  // Orçamento da viagem inteira. Serve apenas como aviso de custo estimado das
  // atrações; nunca limita ou bloqueia a seleção.
  totalAmount?: number;
}

export type MealSlot = 'breakfast' | 'lunch' | 'snack' | 'dinner';
// 'nearby': refeição posicional sem local definido. 'lodging' é aceito na
// entrada por compatibilidade; 'place' é restaurante real escolhido.
export type MealAnchor = 'nearby' | 'lodging' | 'place';
export type MealCategory = 'coffee' | 'restaurant';

export interface MealCandidate {
  id: string;
  legId: string;
  category: MealCategory;
  anchor: MealAnchor;
  placeId?: string;
  placeName: string;
  coordinate?: Coordinate;
  openingHours?: OpeningHours;
  photoUrl?: string;
  rating?: number;
  userRatingCount?: number;
  primaryType?: string;
  // Mantém os dados completos usados na descoberta para que o card do roteiro
  // não regrida para apenas o nome depois que o solver escolher o local.
  place?: PlaceSummary;
  insight?: PlaceInsight;
  reservationLocalIso?: string;
  serviceTimeSeconds?: number;
  suggestionType?: string;
  // Dia (offset 0-based no leg) fixado pelo usuário. Ausente: solver escolhe.
  dayOffset?: number;
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
  mealAnchor?: MealAnchor;
  mealCategory?: MealCategory;
  mealPlaceId?: string;
  // Refeição sem local definido: a UI exibe "Refeição em algum local próximo".
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

export interface TripLeg {
  budget?: BudgetPreferences;
  id: string;
  destination: PlaceDetails;
  startDate?: string;
  endDate?: string;
  lodgings: LodgingStay[];
  candidates: EnrichedPlace[];
  selectedCandidateIds: string[];
  color: string;
  preferences?: ItineraryPreferences;
  /** Meio de locomoção preferido nesta cidade (carro/transit/a pé). Aproxima os
   * tempos de deslocamento do roteiro. Ausente: carro (padrão). */
  travelMode?: TravelMode;
  /** Distingue a sugestão automática de uma escolha explícita. Assim uma
   * recomendação corrigida não sobrescreve o que o usuário decidiu. */
  travelModeSelection?: 'suggested' | 'manual';
  /** Raio de busca de atrações a partir da cidade, em metros. Quando ausente,
   * o fluxo deriva um padrão do viewport da cidade. Permite passeios de
   * bate-volta (cidade-base com pontos distantes). */
  discoveryRadiusMeters?: number;
  /** Dias recomendados pela IA para esta cidade (vindo do step país→cidades).
   * Usado como dica ao marcar as datas; não é uma regra. */
  recommendedDays?: number;
}

// 'flight' = aéreo; 'car' = terrestre; 'estimate' = só horários informados
// manualmente (transporte não especificado).
export type TransitionMode = 'flight' | 'car' | 'estimate';

export interface TransitionLeg {
  fromLegId: string;
  toLegId: string;
  mode: TransitionMode;
  /** `YYYY-MM-DD HH:MM` ou ISO completo, hora local */
  departureLocalIso?: string;
  arrivalLocalIso?: string;
  flightIata?: string;
  flightDetails?: FlightAnchor;
  arrivalAnchor?: FlightAnchor;
}

// Progresso do modo viagem (live): paradas concluídas/puladas e o dia em foco.
// Persistido por viagem para sobreviver ao fechamento do app durante a viagem.
export interface LiveProgress {
  completedStopIds: string[];
  skippedStopIds: string[];
  activeDayIndex?: number;
  updatedAt: string;
}

export interface TripDraft {
  datesFlexible?: boolean;
  id: string;
  legs: TripLeg[];
  transitions?: TransitionLeg[];
  preferenceOrder: string[];
  interestLevels?: Record<string, number>;
  preferences?: ItineraryPreferences;
  budget?: BudgetPreferences;
  flightPlan?: FlightPlan;
  itinerary?: ItinerarySolution;
  itineraryEdited?: boolean;
  coverPhotoUrl?: string;
  coverPhotoUrls?: string[];
  mealCandidates?: MealCandidate[];
  attractionPriority?: string[];
  attractionDayAssignments?: AttractionDayAssignment[];
  mealPriority?: string[];
  liveProgress?: LiveProgress;
  sourceBlueprint?: TripSourceBlueprint;
  anchorExperiences?: AnchorExperienceSelection[];
  ownerId?: string;
  memberIds?: string[];
  members?: Record<string, import('./collaboration').TripMember>;
  participants?: Record<string, import('./collaboration').TripParticipant>;
  /** Definido automaticamente quando todas as paradas do roteiro são resolvidas. */
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type BlueprintKind = 'city' | 'adventure';
export type BlueprintStatus = 'draft' | 'review' | 'published' | 'archived';
export type DemandLevel = 'low' | 'medium' | 'high';

export interface BlueprintSource {
  label: string;
  url: string;
  publisher: string;
  kind: 'official' | 'specialist' | 'community';
  checkedAt: string;
}

export interface CuratedPlace {
  id: string;
  destinationId?: string;
  includedInPlaceId?: string;
  googlePlaceId?: string;
  editorialImage?: {
    url: string;
    alt: string;
    author: string;
    license: string;
    sourceUrl: string;
  };
  photoName?: string;
  photoNames?: string[];
  name: string;
  coordinate: Coordinate;
  category: string;
  description: string;
  averageMinutes: number;
  averageCost?: { value: number; currency: string };
  environment: 'indoor' | 'outdoor' | 'mixed';
}

export interface BlueprintModule {
  id: string;
  destinationId?: string;
  title: string;
  area: string;
  summary: string;
  placeIds: string[];
}

export interface BlueprintAnchorSegment {
  title: string;
  coordinate: Coordinate;
  durationMinutes: number;
  startTime?: string;
  note?: string;
}

export interface BlueprintAnchor {
  id: string;
  destinationId?: string;
  title: string;
  summary: string;
  coordinate: Coordinate;
  durationDays: number;
  dailyDurationMinutes: number;
  averageCost?: { value: number; currency: string };
  startTime: string;
  latestStartTime: string;
  availableMonths?: number[];
  avoidMonths?: number[];
  guide: 'not_needed' | 'recommended' | 'required';
  reservation: 'none' | 'recommended' | 'required';
  bookingLeadDays?: number;
  physicalDemand: DemandLevel;
  weatherSensitivity: DemandLevel;
  logistics: string[];
  segments?: BlueprintAnchorSegment[];
}

export interface AnchorExperienceSelection extends BlueprintAnchor {
  legId: string;
  dayOffset: number;
}

export interface BlueprintVariant {
  days: number;
  label: string;
  summary: string;
  moduleIds: string[];
  dayPlans?: {
    dayOffset: number;
    destinationId?: string;
    moduleIds?: string[];
    placeIds?: string[];
  }[];
  anchors: { anchorId: string; dayOffset: number }[];
  destinationDays?: { destinationId: string; days: number }[];
}

export interface ItineraryBlueprint {
  id: string;
  kind: BlueprintKind;
  status: BlueprintStatus;
  featured: boolean;
  order: number;
  destination: { name: string; country: string; region?: string; coordinate: Coordinate };
  destinations?: { id: string; name: string; country: string; region?: string; coordinate: Coordinate }[];
  transitions?: { fromDestinationId: string; toDestinationId: string; mode: 'flight' | 'car' | 'estimate'; durationMinutes?: number }[];
  eyebrow: string;
  title: string;
  summary: string;
  heroImage?: {
    url: string;
    alt: string;
    author: string;
    license: string;
    sourceUrl: string;
  };
  heroColors: [string, string];
  tags: string[];
  minDays: number;
  maxDays: number;
  recommendedDays: number;
  bestMonths?: number[];
  avoidMonths?: number[];
  seasonalityNote?: string;
  physicalDemand: DemandLevel;
  guideNote?: string;
  places: CuratedPlace[];
  modules: BlueprintModule[];
  anchors: BlueprintAnchor[];
  variants: BlueprintVariant[];
  sources: BlueprintSource[];
  quality: {
    score: number;
    reviewStatus: 'source_backed' | 'needs_review';
    lastVerifiedAt: string;
    notes: string[];
  };
  generation?: {
    provider: 'google' | 'openai' | 'anthropic';
    model: string;
    promptVersion: string;
    generatedAt: string;
    requestedDestination: string;
    matchedPlaces: number;
    totalPlaces: number;
    solverValidatedDays: number[];
    warnings: string[];
  };
  version: number;
  updatedAt?: string;
}

export interface BlueprintInstantiation {
  blueprintId: string;
  variant: BlueprintVariant;
  destination: ItineraryBlueprint['destination'];
  candidates: EnrichedPlace[];
  anchors: (BlueprintAnchor & { dayOffset: number })[];
  dayAssignments: { destinationId: string; placeId: string; dayOffset: number }[];
  provenance: BlueprintSource[];
  legs: {
    destinationId: string;
    destination: ItineraryBlueprint['destination'];
    days: number;
    candidates: EnrichedPlace[];
    anchors: (BlueprintAnchor & { dayOffset: number })[];
  }[];
  transitions: { fromDestinationId: string; toDestinationId: string; mode: 'flight' | 'car' | 'estimate'; durationMinutes?: number }[];
  precomputedItinerary?: ItinerarySolution;
  precomputedLegs?: { destinationId: string; legId: string }[];
}

export interface AttractionDayAssignment {
  legId: string;
  placeId: string;
  dayOffset: number;
}

export interface TripSourceBlueprint {
  id: string;
  title: string;
  kind: BlueprintKind;
  variantDays: number;
  sources: BlueprintSource[];
  qualityScore: number;
  flexibleDates?: boolean;
  provider?: 'google' | 'openai' | 'anthropic';
  model?: string;
}

// Cores por destino (leg). O destino principal usa o navy do tema; o coral foi
// rebaixado a acento pontual, então fica por último.
export const LEG_COLORS: readonly string[] = [
  '#1B2A41',
  '#0066CC',
  '#5AA776',
  '#8B5CF6',
  '#3B82F6',
  '#EC4899',
  '#F59E0B',
  '#E9573A',
] as const;

export const MAX_LEGS = 8;
