import { mapConcurrent } from '../runtime/concurrency.js';
import type { InsightsPort } from '../../domain/ports.js';
import type { PlaceInsight, PlaceSummary } from '../../domain/place.js';
import type { CachePort } from '../../domain/cache.js';
import type { AiGateway } from '../../domain/ai.js';

// Estimativa de tokens por lugar quando o insight vem do cache (sem
// usageMetadata real). Aproxima o custo cheio que a chamada teria; o custo
// real do cache hit é zero.

const INSIGHT_TTL_SECONDS = 90 * 24 * 60 * 60;
// Insight sem duração é quase inútil (o roteiro cai no default) — TTL curto
// para tentar de novo logo, em vez de fixar o vazio por 90 dias.
const EMPTY_INSIGHT_TTL_SECONDS = 24 * 60 * 60;
// A versão faz parte da chave porque o contrato do insight evolui e valores
// antigos não contêm as restrições usadas pelo solver.
const insightKey = (placeId: string) => `ai:insight:v4:${placeId}`;

const SYSTEM_PROMPT = `Você analisa pontos turísticos e devolve apenas um JSON. \
Para cada lugar informado, retorne:
- averageMinutes: tempo médio de visita em minutos (ou null se não souber).
- minimumRecommendedMinutes: menor duração ainda razoável, sem transformar a experiência numa passagem apressada (ou null).
- averageCost: custo médio em moeda local com ISO da moeda (ou null se for gratuito ou desconhecido).
- confidence: 'high' | 'medium' | 'low' baseado no quanto você tem certeza.
- description: 2 a 3 frases descrevendo o lugar para um viajante. Foque no que esperar da experiência, características marcantes e por que vale a visita. Não repita o nome do lugar. Tom direto, em português brasileiro. Máximo de 280 caracteres.
- recommendedVisitWindow: somente quando o horário muda materialmente a qualidade, segurança ou viabilidade da visita. Informe earliestStartLocalTime e latestStartLocalTime em HH:MM; estes são horários de INÍCIO da visita, não de término. Use strength='required' apenas para uma limitação estável e real (necessidade de luz do dia, atividade de nascer/pôr do sol, mercado estritamente matinal, espetáculo noturno ou segurança); 'strong' quando o horário evita uma experiência claramente pior; 'soft' quando é apenas mais agradável. Inclua reason curto. Para parques urbanos e áreas naturais sem proposta noturna, evite início perto ou depois do anoitecer e prefira manhã/início da tarde. Retorne null quando não houver preferência relevante.
- seasonality: availability='year_round'|'seasonal'|'unknown', availableMonths (1-12), avoidMonths (meses em que ainda pode funcionar, mas a experiência costuma ser pior) e reason. Só marque 'seasonal' e meses disponíveis quando houver padrão operacional estável conhecido; não invente fechamentos temporários. Use listas vazias quando não souber.
- environment: 'indoor'|'outdoor'|'mixed'.
- weatherSensitivity: 'low'|'medium'|'high'.
- physicalDemand: 'low'|'medium'|'high' para a visita típica.
- reservationAdvice: 'none'|'recommended'|'required' e typicalBookingLeadDays (inteiro ou null).
- accessibilityNotes: observação curta e útil sobre mobilidade, terreno ou acesso, ou omita.
- familyNotes: observação curta apenas quando houver impacto relevante para crianças, idosos ou grupos familiares, ou omita.
- visitMode: 'independent'|'timed_entry'|'guided_departure'|'event'. Use guided_departure quando o passeio costuma sair em horário definido, e timed_entry para ingresso com hora marcada.
- planningBufferMinutes: minutos inevitáveis ALÉM do tempo de visita (segurança, retirada de equipamento, acesso/estacionamento ou embarque), de 0 a 120; null quando irrelevante ou incerto. Não use como margem genérica de fila.
- operationalDependency: 'none'|'daylight'|'tide'|'snow'|'water_level'|'wildlife'|'weather'. Escolha uma dependência apenas quando ela muda de fato a operação ou a experiência; detalhe em operationalNotes.
- equipmentNotes: equipamento ou vestuário especial somente quando necessário (ex.: calçado de trilha, roupa térmica), ou omita.
- transportAccessNotes: acesso operacional relevante (4x4, barco, teleférico, trilha desde estacionamento, transporte público limitado), ou omita.
- crowdSensitivity: 'low'|'medium'|'high'. Em 'high', use recommendedVisitWindow apenas se houver uma faixa realmente melhor; lotação sozinha nunca cria restrição required.

Considere museus, parques, praias, trilhas, esqui, vida noturna, atrações religiosas, mercados, observação de fauna, cruzeiros/passeios, eventos e locais sujeitos a maré ou luz natural. Horários oficiais do Google serão tratados separadamente: não tente reproduzir horários semanais de abertura. Seja conservador em restrições rígidas; informação incerta deve ter confidence='low' e não virar availability sazonal fechada.

Use confidence 'low' quando faltarem dados. Formato:
{"places":[{"placeId":string,"averageMinutes":number|null,"minimumRecommendedMinutes":number|null,"averageCost":{"value":number,"currency":string}|null,"confidence":"high"|"medium"|"low","description":string,"recommendedVisitWindow":{"earliestStartLocalTime":"HH:MM","latestStartLocalTime":"HH:MM","strength":"required"|"strong"|"soft","reason":string}|null,"seasonality":{"availability":"year_round"|"seasonal"|"unknown","availableMonths":number[],"avoidMonths":number[],"reason":string},"environment":"indoor"|"outdoor"|"mixed","weatherSensitivity":"low"|"medium"|"high","physicalDemand":"low"|"medium"|"high","reservationAdvice":"none"|"recommended"|"required","typicalBookingLeadDays":number|null,"accessibilityNotes":string,"familyNotes":string,"visitMode":"independent"|"timed_entry"|"guided_departure"|"event","planningBufferMinutes":number|null,"operationalDependency":"none"|"daylight"|"tide"|"snow"|"water_level"|"wildlife"|"weather","operationalNotes":string,"equipmentNotes":string,"transportAccessNotes":string,"crowdSensitivity":"low"|"medium"|"high"}]}`;

const CHUNK_SIZE = 5;

interface RawInsight {
  placeId?: string;
  averageMinutes?: number | null;
  minimumRecommendedMinutes?: number | null;
  averageCost?: { value?: number; currency?: string } | null;
  confidence?: string;
  description?: string;
  reasoning?: string;
  recommendedVisitWindow?: {
    earliestStartLocalTime?: string;
    latestStartLocalTime?: string;
    strength?: string;
    reason?: string;
  } | null;
  seasonality?: {
    availability?: string;
    availableMonths?: number[];
    avoidMonths?: number[];
    reason?: string;
  } | null;
  environment?: string;
  weatherSensitivity?: string;
  physicalDemand?: string;
  reservationAdvice?: string;
  typicalBookingLeadDays?: number | null;
  accessibilityNotes?: string;
  familyNotes?: string;
  visitMode?: string;
  planningBufferMinutes?: number | null;
  operationalDependency?: string;
  operationalNotes?: string;
  equipmentNotes?: string;
  transportAccessNotes?: string;
  crowdSensitivity?: string;
}

export class GeminiInsightsAdapter implements InsightsPort {
  constructor(
    private readonly ai: AiGateway,
    private readonly cache?: CachePort,
  ) {}

  private readonly pending = new Map<string, Promise<PlaceInsight | undefined>>();

  async enrich(places: PlaceSummary[]): Promise<PlaceInsight[]> {
    const owned: PlaceSummary[] = [];
    const resolvers = new Map<string, (value: PlaceInsight | undefined) => void>();
    const promises = Array.from(new Map(places.map((place) => [place.placeId, place])).values()).map((place) => {
      const existing = this.pending.get(place.placeId);
      if (existing) return existing;
      const promise = new Promise<PlaceInsight | undefined>((resolve) => resolvers.set(place.placeId, resolve));
      this.pending.set(place.placeId, promise);
      owned.push(place);
      return promise;
    });
    if (owned.length) {
      try {
        const hits = await mapConcurrent(owned, 5, (place) =>
          this.cache?.get<PlaceInsight>(insightKey(place.placeId)).catch(() => null) ?? Promise.resolve(null));
        const missing = owned.filter((_, index) => !hits[index]?.description?.trim());
        const chunks: PlaceSummary[][] = [];
        for (let i = 0; i < missing.length; i += CHUNK_SIZE) chunks.push(missing.slice(i, i + CHUNK_SIZE));
        const fresh = (await mapConcurrent(chunks, 2, (chunk) => this.enrichChunk(chunk).catch((error: unknown) => {
          console.error('[enrich] falha na IA:', error instanceof Error ? error.message : 'erro desconhecido');
          return [];
        }))).flat();
        await mapConcurrent(fresh, 5, async (insight) => {
          await this.cache?.set(insightKey(insight.placeId), insight,
            insight.averageMinutes !== null ? INSIGHT_TTL_SECONDS : EMPTY_INSIGHT_TTL_SECONDS).catch(() => undefined);
        });
        const byId = new Map([...hits.filter((hit): hit is PlaceInsight => Boolean(hit)), ...fresh].map((insight) => [insight.placeId, insight]));
        for (const place of owned) resolvers.get(place.placeId)!(byId.get(place.placeId));
      } finally {
        for (const place of owned) {
          resolvers.get(place.placeId)!(undefined);
          this.pending.delete(place.placeId);
        }
      }
    }
    return (await Promise.all(promises)).filter((insight): insight is PlaceInsight => Boolean(insight));
  }

  private async enrichChunk(chunk: PlaceSummary[]): Promise<PlaceInsight[]> {
    const sanitized = chunk.map((place) => ({
      placeId: place.placeId,
      name: place.name,
      formattedAddress: place.formattedAddress,
      primaryType: place.primaryType,
      types: place.types,
      rating: place.rating,
      userRatingCount: place.userRatingCount,
      regularOpeningHoursAvailable: Boolean(place.openingHours?.periods?.length),
      businessStatus: place.businessStatus,
    }));

    const response = await this.ai.generate({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: JSON.stringify(sanitized),
      temperature: 0.4,
      maxOutputTokens: 8192,
    });

    const text = response.text;
    const parsed = this.safeParseJson(text);
    if (!Array.isArray(parsed?.places) || parsed.places.length === 0) {
      throw new Error('A IA não retornou descrições válidas dos lugares.');
    }
    const items = parsed.places as RawInsight[];

    return items
      .filter((item): item is RawInsight & { placeId: string } => Boolean(item.placeId))
      .map<PlaceInsight>((item) => ({
        placeId: item.placeId,
        averageMinutes: item.averageMinutes ?? null,
        minimumRecommendedMinutes:
          typeof item.minimumRecommendedMinutes === 'number' && item.minimumRecommendedMinutes > 0
            ? item.minimumRecommendedMinutes
            : null,
        averageCost:
          item.averageCost && typeof item.averageCost.value === 'number'
            ? {
                value: item.averageCost.value,
                currency: item.averageCost.currency ?? 'USD',
              }
            : null,
        confidence:
          item.confidence === 'high' || item.confidence === 'medium' ? item.confidence : 'low',
        description: item.description ?? item.reasoning,
        recommendedVisitWindow: normalizeVisitWindow(item.recommendedVisitWindow),
        seasonality: normalizeSeasonality(item.seasonality),
        environment: oneOf(item.environment, ['indoor', 'outdoor', 'mixed'] as const),
        weatherSensitivity: oneOf(item.weatherSensitivity, ['low', 'medium', 'high'] as const),
        physicalDemand: oneOf(item.physicalDemand, ['low', 'medium', 'high'] as const),
        reservationAdvice: oneOf(
          item.reservationAdvice,
          ['none', 'recommended', 'required'] as const,
        ),
        typicalBookingLeadDays:
          typeof item.typicalBookingLeadDays === 'number' && item.typicalBookingLeadDays >= 0
            ? Math.round(item.typicalBookingLeadDays)
            : null,
        accessibilityNotes: item.accessibilityNotes,
        familyNotes: item.familyNotes,
        visitMode: oneOf(item.visitMode, ['independent', 'timed_entry', 'guided_departure', 'event'] as const),
        planningBufferMinutes:
          typeof item.planningBufferMinutes === 'number' && item.planningBufferMinutes >= 0
            ? Math.min(120, Math.round(item.planningBufferMinutes))
            : null,
        operationalDependency: oneOf(
          item.operationalDependency,
          ['none', 'daylight', 'tide', 'snow', 'water_level', 'wildlife', 'weather'] as const,
        ),
        operationalNotes: item.operationalNotes,
        equipmentNotes: item.equipmentNotes,
        transportAccessNotes: item.transportAccessNotes,
        crowdSensitivity: oneOf(item.crowdSensitivity, ['low', 'medium', 'high'] as const),
      }));
  }

  private safeParseJson<T = { places?: RawInsight[] }>(text: string): T | null {
    try {
      return JSON.parse(text) as T;
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        return null;
      }
    }
  }
}

function oneOf<const T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
): T[number] | undefined {
  return value && allowed.includes(value as T[number]) ? (value as T[number]) : undefined;
}

function normalizeLocalTime(value: string | undefined): string | null {
  const match = value?.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeVisitWindow(
  value: RawInsight['recommendedVisitWindow'],
): PlaceInsight['recommendedVisitWindow'] {
  if (!value) return undefined;
  const start = normalizeLocalTime(value.earliestStartLocalTime);
  const end = normalizeLocalTime(value.latestStartLocalTime);
  const strength = oneOf(value.strength, ['required', 'strong', 'soft'] as const);
  if (!start || !end || !strength || start >= end) return undefined;
  return {
    earliestStartLocalTime: start,
    latestStartLocalTime: end,
    strength,
    reason: value.reason,
  };
}

function normalizeMonths(values: number[] | undefined): number[] | undefined {
  if (!values) return undefined;
  return [...new Set(values.filter((month) => Number.isInteger(month) && month >= 1 && month <= 12))]
    .sort((a, b) => a - b);
}

function normalizeSeasonality(
  value: RawInsight['seasonality'],
): PlaceInsight['seasonality'] {
  if (!value) return undefined;
  const availability = oneOf(
    value.availability,
    ['year_round', 'seasonal', 'unknown'] as const,
  );
  if (!availability) return undefined;
  const availableMonths = normalizeMonths(value.availableMonths);
  const avoidMonths = normalizeMonths(value.avoidMonths);
  return {
    availability,
    availableMonths: availability === 'seasonal' ? availableMonths : undefined,
    avoidMonths,
    reason: value.reason,
  };
}
