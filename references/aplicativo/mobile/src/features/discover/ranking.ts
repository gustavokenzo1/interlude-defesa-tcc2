import type { Coordinate, PlaceSummary } from '@/domain/types';

// Bayesian average: priorizamos lugares com muitas avaliações sobre lugares
// com nota máxima mas poucas avaliações. C alto puxa lugares pouco avaliados
// para a média global m; com C=500 e m=4, 1 avaliação 5★ vira ~4.002, enquanto
// 15k avaliações 4.8★ ficam quase em 4.79.
const BAYESIAN_C = 500;
const BAYESIAN_M = 4.0;

export function popularityScore(place: PlaceSummary): number {
  const rating = place.rating ?? BAYESIAN_M;
  const count = place.userRatingCount ?? 0;
  const denom = count + BAYESIAN_C;
  return (count / denom) * rating + (BAYESIAN_C / denom) * BAYESIAN_M;
}

export function bayesianScore(rating: number | undefined, count: number | undefined): number {
  const r = rating ?? BAYESIAN_M;
  const n = count ?? 0;
  const denom = n + BAYESIAN_C;
  return (n / denom) * r + (BAYESIAN_C / denom) * BAYESIAN_M;
}

// A média bayesiana sozinha satura quando n >> C: o score converge para a nota
// crua e a ordenação vira "todos os 4.8★ antes de todos os 4.7★", afundando
// ícones de alto volume (Top of the Rock, 4.7★/83k) abaixo de lugares obscuros
// bem avaliados (4.8★/3k). O volume de avaliações é o proxy de relevância
// turística, então somamos um termo de iconicidade: log10 do volume, min-max
// normalizado dentro do conjunto candidato — o que auto-calibra por densidade
// do destino (300k reviews = teto em Nova York; 11k = teto em Puerto Natales).
const ICONICITY_WEIGHT = 0.6;

// Decaimento gravitacional: a camada regional usa bias suave do Text Search,
// que vaza POIs muito além do raio (Watkins Glen a 303km numa viagem a NY).
// Dentro do raio de descoberta escolhido pelo usuário a distância é grátis;
// além dele, cada duplicação custa GRAVITY_WEIGHT no score. Âncoras de massa
// alta sobrevivem (Torres del Paine a 107km de Puerto Natales segue no topo,
// iconicidade ~1.0 no conjunto local); ruído de massa média afunda. Calibrado
// no sweep de 6 cidades: 0.15 é o maior valor que não regride o caso Patagônia.
const GRAVITY_WEIGHT = 0.15;
const EARTH_RADIUS_METERS = 6_371_000;

export interface DiscoveryOrigin {
  center: Coordinate;
  radiusMeters: number;
}

function haversineMeters(a: Coordinate, b: Coordinate): number {
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

export function createPopularityScore(
  places: PlaceSummary[],
  origin?: DiscoveryOrigin,
): (place: PlaceSummary) => number {
  let minLog = Infinity;
  let maxLog = -Infinity;
  for (const place of places) {
    const log = Math.log10(1 + (place.userRatingCount ?? 0));
    if (log < minLog) minLog = log;
    if (log > maxLog) maxLog = log;
  }
  const spread = maxLog - minLog;
  return (place) => {
    const iconicity =
      spread > 0 ? (Math.log10(1 + (place.userRatingCount ?? 0)) - minLog) / spread : 0;
    const gravity = origin
      ? Math.log2(Math.max(1, haversineMeters(origin.center, place.coordinate) / origin.radiusMeters))
      : 0;
    return popularityScore(place) + ICONICITY_WEIGHT * iconicity - GRAVITY_WEIGHT * gravity;
  };
}

/**
 * Tipos cujo `primaryType` indica que o lugar não é atração turística.
 * O filtro do backend (`ATTRACTION_EXCLUDED_TYPES`) cobre só hospedagem
 * porque listas longas causam zero resultados no Google. Aqui filtramos
 * pelo cliente usando o `primaryType` (mais confiável do que o array de tipos).
 */
const NON_ATTRACTION_PRIMARY_TYPES = new Set<string>([
  // Shoppings (usuário marca interesse mas mall comum é experiência fraca;
  // mercados de rua / farmers_market continuam liberados pois SÃO atração)
  'shopping_mall',
  'department_store',
  'discount_store',
  'discount_supermarket',
  // Comércio
  'auto_parts_store',
  'bicycle_store',
  'building_materials_store',
  'butcher_shop',
  'cell_phone_store',
  'clothing_store',
  'convenience_store',
  'cosmetics_store',
  'electronics_store',
  'florist',
  'food_store',
  'furniture_store',
  'garden_center',
  'general_store',
  'grocery_store',
  'hardware_store',
  'health_food_store',
  'home_goods_store',
  'home_improvement_store',
  'hypermarket',
  'jewelry_store',
  'liquor_store',
  'pet_store',
  'shoe_store',
  'sporting_goods_store',
  'sportswear_store',
  'store',
  'supermarket',
  'thrift_store',
  'toy_store',
  'warehouse_store',
  'wholesaler',
  'womens_clothing_store',
  // Restaurantes/cafés (vão pro fluxo de refeições, não pra atrações)
  'restaurant',
  'cafe',
  'cafeteria',
  'bakery',
  'fast_food_restaurant',
  'meal_takeaway',
  'meal_delivery',
  'coffee_shop',
  'coffee_stand',
  'coffee_roastery',
  'pastry_shop',
  'ice_cream_shop',
  'sandwich_shop',
  'donut_shop',
  'breakfast_restaurant',
  'brunch_restaurant',
  'buffet_restaurant',
  'diner',
  'dessert_restaurant',
  'dessert_shop',
  'fine_dining_restaurant',
  'food_court',
  'hamburger_restaurant',
  'pizza_restaurant',
  'ramen_restaurant',
  'sushi_restaurant',
  'seafood_restaurant',
  'steak_house',
  'vegan_restaurant',
  'vegetarian_restaurant',
  'acai_shop',
  'afghani_restaurant',
  'african_restaurant',
  'american_restaurant',
  'asian_restaurant',
  'barbecue_restaurant',
  'brazilian_restaurant',
  'chinese_restaurant',
  'french_restaurant',
  'greek_restaurant',
  'indian_restaurant',
  'indonesian_restaurant',
  'italian_restaurant',
  'japanese_restaurant',
  'korean_restaurant',
  'lebanese_restaurant',
  'mediterranean_restaurant',
  'mexican_restaurant',
  'middle_eastern_restaurant',
  'spanish_restaurant',
  'thai_restaurant',
  'turkish_restaurant',
  'vietnamese_restaurant',
  'juice_shop',
  'tea_house',
  'chocolate_factory',
  'chocolate_shop',
  'candy_store',
  // Bares, pubs e vida noturna (refeição/à parte, não pra atrações)
  'bar',
  'bar_and_grill',
  'pub',
  'wine_bar',
  'cocktail_bar',
  'sports_bar',
  'karaoke',
  'night_club',
  // Mercados, feiras (mesmo que tradicionais entram como refeição)
  'market',
  'food_market',
  'farmers_market',
  'fish_market',
  'flea_market',
  'wholesale_market',
  // Academias, spas, fitness
  'gym',
  'spa',
  'fitness_center',
  'sauna',
  'wellness_center',
  'yoga_studio',
  'pilates_studio',
  'massage',
  'sports_club',
  'sports_complex',
  'sports_activity_location',
  'athletic_field',
  'fishing_charter',
  'fishing_pond',
  // Finanças
  'accounting',
  'atm',
  'bank',
  'insurance_agency',
  // Serviços
  'barber_shop',
  'beautician',
  'beauty_salon',
  'body_art_service',
  'car_dealer',
  'car_rental',
  'car_repair',
  'car_wash',
  'consultant',
  'courier_service',
  'electrician',
  'employment_agency',
  'funeral_home',
  'gas_station',
  'hair_care',
  'hair_salon',
  'laundry',
  'lawyer',
  'locksmith',
  'makeup_artist',
  'marketing_consultant',
  'moving_company',
  'nail_salon',
  'painter',
  'plumber',
  'real_estate_agency',
  'roofing_contractor',
  'service',
  'storage',
  'tailor',
  'telecommunications_service_provider',
  'tour_agency',
  'travel_agency',
  'visitor_center',
  'tourist_information_center',
  // Negócios
  'business_center',
  'corporate_office',
  'coworking_space',
  'farm',
  'manufacturer',
  'ranch',
  'supplier',
  'association_or_organization',
  // Saúde
  'chiropractor',
  'dental_clinic',
  'dentist',
  'doctor',
  'drugstore',
  'general_hospital',
  'hospital',
  'medical_center',
  'medical_clinic',
  'medical_lab',
  'pharmacy',
  'physiotherapist',
  'skin_care_clinic',
  // Educação
  'academic_department',
  'educational_institution',
  'preschool',
  'primary_school',
  'research_institute',
  'school',
  'secondary_school',
  'university',
  // Governo
  'city_hall',
  'courthouse',
  'embassy',
  'fire_station',
  'government_office',
  'local_government_office',
  'neighborhood_police_station',
  'police',
  'post_office',
  // Transporte
  'airport',
  'bus_station',
  'bus_stop',
  'ferry_terminal',
  'heliport',
  'international_airport',
  'light_rail_station',
  'park_and_ride',
  'subway_station',
  'taxi_stand',
  'toll_station',
  'train_station',
  'tram_stop',
  'transit_depot',
  'transit_station',
  'transportation_service',
  'transit_stop',
  // Hospedagem (segunda camada por garantia)
  'bed_and_breakfast',
  'campground',
  'cottage',
  'guest_house',
  'hostel',
  'hotel',
  'inn',
  'lodging',
  'motel',
  'resort_hotel',
]);

// Tipos cuja presença em `types` (mesmo que primaryType seja tourist_attraction)
// indica que o lugar é melhor classificado como refeição/serviço. Mais agressivo
// que o filtro por primaryType: pega o "Mercado Público" classificado como
// tourist_attraction mas que na verdade entra no fluxo de refeições/compras.
const SECONDARY_EXCLUSION_TYPES = new Set<string>([
  'restaurant',
  'bar',
  'pub',
  'night_club',
  'cafe',
  'coffee_shop',
  'bakery',
  'fast_food_restaurant',
  'meal_takeaway',
  'meal_delivery',
  'food_court',
  'market',
  'food_market',
  'farmers_market',
  'fish_market',
  'flea_market',
  'supermarket',
  'hypermarket',
  'grocery_store',
  'convenience_store',
  'shopping_mall',
  'department_store',
  'gym',
  'spa',
  'fitness_center',
  'sports_club',
  'wellness_center',
  'lodging',
  'hotel',
  'hostel',
  'motel',
]);

/**
 * `selectedTypes` (união dos matchTypes dos interesses marcados pelo usuário)
 * isenta da exclusão os lugares cujo primaryType foi pedido explicitamente.
 * Sem isso o filtro anti-contaminação anula interesses inteiros: spa, market,
 * bar etc. estão nas listas de exclusão, então Bem-estar e Mercados eram
 * buscados e 100% apagados. A contaminação cruzada continua filtrada — um spa
 * só passa para quem marcou Bem-estar.
 */
// Tipos onde o Google frequentemente atribui 'tourist_attraction' por ruído
// (um restaurante/bar/hotel/terminal). Para estes, a presença de
// 'tourist_attraction' nos types NÃO redime — o lugar continua sendo refeição/
// serviço/transporte. Para os demais (ex.: government_office do Palácio do
// Planalto, que é genuinamente um marco visitável), o selo de atração vale.
const ATTRACTION_TAG_IGNORED_FOR = new Set<string>([
  'restaurant', 'bar', 'bar_and_grill', 'pub', 'wine_bar', 'cocktail_bar',
  'sports_bar', 'night_club', 'cafe', 'coffee_shop', 'bakery',
  'fast_food_restaurant', 'meal_takeaway', 'meal_delivery', 'food_court',
  'lodging', 'hotel', 'hostel', 'motel', 'resort_hotel', 'guest_house',
  // Transporte: um terminal de ônibus com selo de atração (Terminal Puerto
  // Montt) não é atração. Estações icônicas são resgatadas à parte por volume.
  'bus_station', 'transit_station', 'transit_depot', 'transportation_service',
  'taxi_stand', 'park_and_ride',
  // Turismo/serviços: agências de passeio e centros de informação têm selo de
  // atração mas são serviços, não lugares para visitar. Não redimir.
  'tour_agency', 'travel_agency', 'visitor_center', 'tourist_information_center',
]);

// Estações de trem icônicas (Grand Central, São Bento) são train_station puro
// — o Google não as marca como tourist_attraction. Resgatamo-las pelo volume
// de avaliações, que separa o marco visitável da estação de subúrbio.
const ICONIC_STATION_TYPES = new Set<string>(['train_station', 'subway_station', 'transit_station']);
const ICONIC_STATION_MIN_RATINGS = 20_000;

export function isNonAttraction(
  place: PlaceSummary,
  selectedTypes?: ReadonlySet<string>,
): boolean {
  if (place.primaryType && selectedTypes?.has(place.primaryType)) return false;
  // Estação de trem/metrô icônica (alto volume de avaliações) é atração: passa
  // antes de qualquer exclusão de transporte.
  if (
    place.primaryType &&
    ICONIC_STATION_TYPES.has(place.primaryType) &&
    (place.userRatingCount ?? 0) >= ICONIC_STATION_MIN_RATINGS
  ) {
    return false;
  }
  // Tipos de consumo no array `types` (comida/bar/loja) excluem sempre, mesmo
  // que o lugar também carregue o selo 'tourist_attraction' (ruído comum em
  // restaurante/bar famoso).
  if (place.types) {
    for (const type of place.types) {
      if (SECONDARY_EXCLUSION_TYPES.has(type)) return true;
    }
  }
  // Selo explícito de atração redime tipos ambíguos que sobraram: um marco com
  // primaryType 'government_office' ou 'event_venue' (Palácio do Planalto,
  // Itamaraty) segue sendo atração legítima.
  const taggedAttraction = place.types?.includes('tourist_attraction') ?? false;
  if (
    taggedAttraction &&
    place.primaryType &&
    !ATTRACTION_TAG_IGNORED_FOR.has(place.primaryType)
  ) {
    return false;
  }
  if (place.primaryType && NON_ATTRACTION_PRIMARY_TYPES.has(place.primaryType)) return true;
  return false;
}

/**
 * Filtra lugares contaminados e ordena cada bucket por popularidade global.
 * O Google ordena por "relevância" deles, que mistura proximidade + qualidade.
 * Para um app de turismo queremos popularidade primeiro. O `score` contextual
 * (createPopularityScore sobre o conjunto inteiro) mantém buckets comparáveis
 * entre si na hora do merge global.
 */
export function rankPlaces(
  places: PlaceSummary[],
  score: (place: PlaceSummary) => number = popularityScore,
  selectedTypes?: ReadonlySet<string>,
): PlaceSummary[] {
  return places
    .filter((place) => !isNonAttraction(place, selectedTypes))
    .slice()
    .sort((a, b) => score(b) - score(a));
}

export function rankMealPlaces(places: PlaceSummary[]): PlaceSummary[] {
  return places
    .filter((place) => place.rating !== undefined)
    .slice()
    .sort((a, b) => popularityScore(b) - popularityScore(a));
}
