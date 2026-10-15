export interface PreferenceOption {
  id: string;
  label: string;
  description: string;
  matchTypes: string[];
}

export type InterestSelection = Record<string, boolean>;

export function defaultInterests(): InterestSelection {
  return Object.fromEntries(preferenceCatalog.map((option) => [option.id, true]));
}

// Normaliza uma seleção (que pode vir de um perfil antigo, sem alguma chave)
// garantindo um booleano para cada categoria do catálogo atual.
export function normalizeInterests(selection?: InterestSelection | null): InterestSelection {
  if (!selection) return defaultInterests();
  return Object.fromEntries(
    preferenceCatalog.map((option) => [option.id, selection[option.id] ?? false]),
  );
}

// Converte a seleção binária na lista de tipos do Google Places usada para
// priorizar atrações no solver. A ordem segue o catálogo (peso igual entre as
// categorias ligadas) e remove duplicatas de tipos compartilhados.
export function interestsToPreferenceOrder(selection: InterestSelection): string[] {
  const types = preferenceCatalog
    .filter((option) => selection[option.id])
    .flatMap((option) => option.matchTypes);
  return Array.from(new Set(types));
}

export function activeInterestIds(selection: InterestSelection): string[] {
  return preferenceCatalog.filter((option) => selection[option.id]).map((option) => option.id);
}

export const preferenceCatalog: PreferenceOption[] = [
  {
    id: 'culture',
    label: 'Cultura e museus',
    description: 'Museus, galerias, monumentos e patrimônio histórico',
    matchTypes: [
      'museum',
      'art_museum',
      'history_museum',
      'art_gallery',
      'historical_place',
      'monument',
      'sculpture',
      'library',
    ],
  },
  {
    id: 'arts',
    label: 'Arte e espetáculos',
    description: 'Teatros, casas de show e apresentações ao vivo',
    matchTypes: [
      'performing_arts_theater',
      'concert_hall',
      'opera_house',
      'philharmonic_hall',
      'live_music_venue',
      'auditorium',
      'comedy_club',
    ],
  },
  {
    id: 'nature',
    label: 'Natureza e parques',
    description: 'Parques, praias, mirantes e trilhas',
    matchTypes: [
      'park',
      'city_park',
      'state_park',
      'national_park',
      'botanical_garden',
      'garden',
      'nature_preserve',
      'beach',
      'lake',
      'river',
      'mountain_peak',
      'scenic_spot',
      'observation_deck',
      'hiking_area',
      'woods',
      'marina',
    ],
  },
  {
    id: 'architecture',
    label: 'Arquitetura e marcos',
    description: 'Construções icônicas, castelos e pontes famosas',
    matchTypes: [
      'cultural_landmark',
      'historical_landmark',
      'castle',
      'fountain',
      'plaza',
      'bridge',
    ],
  },
  {
    id: 'worship',
    label: 'Religião',
    description: 'Igrejas, templos, mesquitas e sinagogas',
    matchTypes: [
      'church',
      'buddhist_temple',
      'hindu_temple',
      'mosque',
      'shinto_shrine',
      'synagogue',
    ],
  },
  {
    id: 'shopping',
    label: 'Mercados e feiras',
    description: 'Mercados municipais, feiras e mercados de rua',
    matchTypes: [
      'market',
      'farmers_market',
      'flea_market',
    ],
  },
  {
    id: 'family',
    label: 'Família',
    description: 'Atrações para todas as idades',
    matchTypes: [
      'amusement_park',
      'aquarium',
      'zoo',
      'water_park',
      'wildlife_park',
      'planetarium',
      'ferris_wheel',
    ],
  },
  {
    id: 'wellness',
    label: 'Bem-estar',
    description: 'Spas, saunas e estúdios de yoga',
    matchTypes: [
      'spa',
      'massage_spa',
      'sauna',
      'wellness_center',
      'yoga_studio',
      'public_bath',
    ],
  },
  {
    id: 'sports',
    label: 'Esportes e atividades',
    description: 'Estádios, esportes ao ar livre e adrenalina',
    matchTypes: [
      'stadium',
      'arena',
      'golf_course',
      'ski_resort',
      'adventure_sports_center',
      'bowling_alley',
      'swimming_pool',
      'cycling_park',
    ],
  },
  {
    id: 'classics',
    label: 'Pontos turísticos clássicos',
    description: 'Atrações famosas e cartões-postais da cidade',
    matchTypes: [
      'tourist_attraction',
      'cultural_center',
      'vineyard',
      'winery',
    ],
  },
];
