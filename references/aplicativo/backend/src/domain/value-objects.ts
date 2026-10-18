export interface Coordinate {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_METERS = 6_371_000;

export function haversineMeters(a: Coordinate, b: Coordinate): number {
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

export interface Viewport {
  northeast: Coordinate;
  southwest: Coordinate;
}

// Meio de locomoção usado na roteirização. Aproxima os tempos de deslocamento
// (carro, transporte público ou a pé); a navegação real fica a cargo do usuário
// (Maps/Waze). Escolhido por cidade pelo usuário; carro é o padrão/fallback.
export type TravelMode = 'car' | 'transit' | 'walk';

export const FIXED_TRAVEL_MODE: TravelMode = 'car';

export const ABSOLUTE_DAY_START_HOUR = 6;
export const ABSOLUTE_DAY_END_HOUR = 23;
export const ABSOLUTE_DAY_START_SECONDS = ABSOLUTE_DAY_START_HOUR * 3600;
export const OPERATING_HORIZON_SECONDS = (ABSOLUTE_DAY_END_HOUR - ABSOLUTE_DAY_START_HOUR) * 3600;
export const DEFAULT_SERVICE_TIME_MINUTES = 75;
export const DEFAULT_SERVICE_TIME_SECONDS = DEFAULT_SERVICE_TIME_MINUTES * 60;
export const MAX_SOLVER_DAYS = 30;

export type Pace = 'relaxed' | 'moderate' | 'intense';

export interface PaceProfile {
  targetActiveHours: number;
  minStopsPerDay: number;
  maxStopsPerDay: number;
  // Multiplicador aplicado ao tempo médio de visita por POI. Um ritmo
  // tranquilo permite passear mais devagar; um ritmo intenso assume que o
  // visitante passa mais rápido pelos pontos.
  serviceTimeMultiplier: number;
}

export const PACE_PROFILES: Record<Pace, PaceProfile> = {
  relaxed: { targetActiveHours: 6, minStopsPerDay: 2, maxStopsPerDay: 3, serviceTimeMultiplier: 1.3 },
  moderate: { targetActiveHours: 8, minStopsPerDay: 3, maxStopsPerDay: 4, serviceTimeMultiplier: 1.0 },
  intense: { targetActiveHours: 10, minStopsPerDay: 4, maxStopsPerDay: 6, serviceTimeMultiplier: 0.8 },
};

export const DEFAULT_PACE: Pace = 'moderate';

// Duração de um dia ativo "confortável". Não é um alvo que o solver tenta
// preencher — serve de referência para derivar o limiar de atividade de dia
// inteiro.
export const COMFORT_DAY_SECONDS = 9 * 3600;
// Uma atração cuja duração estimada ocupe pelo menos esta fração de um dia
// confortável é tratada como atividade de dia inteiro: consome o dia sozinha.
export const FULL_DAY_THRESHOLD_RATIO = 0.7;
// Teto de duração de uma atividade normal. Atividades de dia inteiro escapam
// deste teto e usam a duração estimada real.
export const NORMAL_SERVICE_CAP_SECONDS = Math.round(3.5 * 3600);

export type MealSlot = 'breakfast' | 'lunch' | 'snack' | 'dinner';
export type MealCategory = 'coffee' | 'restaurant';

export interface MealSlotProfile {
  windowStartHour: number;
  windowEndHour: number;
  defaultServiceSeconds: number;
  searchKeywords: string[];
  includedTypes: string[];
}

export const MEAL_SLOT_PROFILES: Record<MealSlot, MealSlotProfile> = {
  breakfast: {
    windowStartHour: 7,
    windowEndHour: 9.5,
    defaultServiceSeconds: 45 * 60,
    searchKeywords: ['café da manhã', 'cafeteria', 'padaria'],
    includedTypes: ['cafe', 'bakery', 'breakfast_restaurant'],
  },
  lunch: {
    windowStartHour: 12,
    windowEndHour: 14,
    defaultServiceSeconds: 75 * 60,
    searchKeywords: ['restaurante almoço'],
    includedTypes: ['restaurant'],
  },
  snack: {
    windowStartHour: 15.5,
    windowEndHour: 17,
    defaultServiceSeconds: 45 * 60,
    searchKeywords: ['café da tarde', 'cafeteria', 'padaria'],
    includedTypes: ['cafe', 'bakery'],
  },
  dinner: {
    windowStartHour: 19,
    windowEndHour: 21,
    defaultServiceSeconds: 90 * 60,
    searchKeywords: ['restaurante jantar'],
    includedTypes: ['restaurant'],
  },
};

export const MEAL_SLOT_ORDER: MealSlot[] = ['breakfast', 'lunch', 'snack', 'dinner'];

export const CATEGORY_TO_SLOTS: Record<MealCategory, MealSlot[]> = {
  coffee: ['breakfast', 'snack'],
  restaurant: ['lunch', 'dinner'],
};

export const RESERVATION_SLACK_SECONDS = 15 * 60;
