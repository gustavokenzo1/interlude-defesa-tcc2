import { GenerationOperations, OperationError, operationFingerprint } from '../../infrastructure/runtime/generation-operations.js';
import { AxiosError } from 'axios';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { DiscoverPlacesUseCase } from '../../application/discover-places.js';
import type { InferTripMemoriesUseCase } from '../../application/infer-trip-memories.js';
import type { EnrichPlacesUseCase } from '../../application/enrich-places.js';
import type { GenerateItineraryUseCase } from '../../application/generate-itinerary.js';
import type { LookupFlightUseCase } from '../../application/lookup-flight.js';
import type { ParseFlightDocumentUseCase } from '../../application/parse-flight-document.js';
import { InvalidAirportError, type SuggestFlightsUseCase } from '../../application/suggest-flights.js';
import { searchAirports } from '../../domain/airports.js';
import type { SearchDestinationsUseCase } from '../../application/search-destinations.js';
import type { ItineraryRequest } from '../../domain/itinerary.js';
import type { CitySuggesterPort, RoutesPort, TravelModeAdvisorPort } from '../../domain/ports.js';
import { itineraryRequestSchema, viewportSchema, coordinateSchema } from './schemas.js';
import { verifyBearerToken, type AuthenticatedUser } from './auth.js';
import { registerAdminRoutes } from './admin-routes.js';
import type { AdminStatsUseCase } from '../../application/admin-stats.js';
import type { AdminTripsUseCase } from '../../application/admin-trips.js';
import type { AdminUsersUseCase } from '../../application/admin-users.js';
import type { HomeRecommendationsUseCase } from '../../application/home-recommendations.js';
import type { TripCollaborationUseCase } from '../../application/trip-collaboration.js';
import type { TravelCatalogUseCase } from '../../application/travel-catalog.js';
import type { AiSettingsUseCase } from '../../application/ai-settings.js';
import type { GenerateBlueprintDraftUseCase } from '../../application/generate-blueprint-draft.js';
import type { FeatureProfilesUseCase } from '../../application/feature-profiles.js';
import type { FeatureKey } from '../../domain/feature-access.js';
import { defaultHomeRecommendations } from '../../domain/home-recommendation.js';
import { estimateGenerationCost } from '../../infrastructure/cost/estimate.js';
import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import { detachDeletedAccount } from '../../application/account-deletion.js';

function describeSolverDetail(detail: unknown): string | null {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => (item && typeof item === 'object' && 'msg' in item ? String((item as { msg: unknown }).msg) : null))
      .filter((value): value is string => Boolean(value));
    return messages.length > 0 ? messages.join('; ') : null;
  }
  return null;
}

interface Dependencies {
  searchDestinations: SearchDestinationsUseCase;
  discoverPlaces: DiscoverPlacesUseCase;
  inferTripMemories: InferTripMemoriesUseCase;
  enrichPlaces: EnrichPlacesUseCase;
  generateItinerary: GenerateItineraryUseCase;
  lookupFlight?: LookupFlightUseCase;
  parseFlightDocument?: ParseFlightDocumentUseCase;
  suggestFlights?: SuggestFlightsUseCase;
  fetchPhoto: (input: { photoName: string; maxWidthPx: number; maxHeightPx: number }) => Promise<string>;
  routesAdapter: RoutesPort;
  travelModeAdvisor: TravelModeAdvisorPort;
  citySuggester: CitySuggesterPort;
  auth?: Auth;
  firestore?: Firestore;
  adminEmails?: string[];
  adminStats?: AdminStatsUseCase;
  adminUsers?: AdminUsersUseCase;
  adminTrips?: AdminTripsUseCase;
  homeRecommendations?: HomeRecommendationsUseCase;
  travelCatalog: TravelCatalogUseCase;
  aiSettings: AiSettingsUseCase;
  generateBlueprintDraft: GenerateBlueprintDraftUseCase;
  tripCollaboration?: TripCollaborationUseCase;
  featureProfiles?: FeatureProfilesUseCase;
  // Config da instrumentação de custo (presente só fora de produção).
  costConfig?: { usdToBrl: number };
}

export async function registerRoutes(app: FastifyInstance, deps: Dependencies) {
  const operations = new GenerationOperations(deps.firestore);
  app.get('/health', { logLevel: 'silent' }, async () => ({ status: 'ok' }));

  app.get('/public/invitations/:token', async (request, reply) => {
    if (!deps.tripCollaboration) {
      reply.code(503);
      return { error: 'collaboration_not_configured' };
    }
    const params = z.object({ token: z.string().min(20).max(200) }).parse(request.params);
    return { invitation: await deps.tripCollaboration.preview(params.token) };
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/v1/')) return;
    if (!deps.auth) {
      reply.code(503).send({ error: 'auth_not_configured' });
      return reply;
    }
    const user = await verifyBearerToken(request, deps.auth);
    if (!user) {
      reply.code(401).send({ error: 'unauthorized' });
      return reply;
    }
    (request as typeof request & { user?: AuthenticatedUser }).user = user;
  });

  async function requireAnyFeature(
    request: FastifyRequest,
    reply: FastifyReply,
    keys: FeatureKey[],
  ): Promise<boolean> {
    const user = (request as typeof request & { user?: AuthenticatedUser }).user;
    if (!user || !deps.featureProfiles || !(await deps.featureProfiles.hasAny(user, keys))) {
      reply.code(403).send({ error: 'feature_not_available' });
      return false;
    }
    return true;
  }

  app.get('/v1/me/features', async (request, reply) => {
    const user = (request as typeof request & { user?: AuthenticatedUser }).user;
    if (!user || !deps.featureProfiles) {
      reply.code(503);
      return { error: 'feature_profiles_not_configured' };
    }
    return deps.featureProfiles.resolveForUser(user);
  });

  app.get('/v1/home/recommendations', async (request, reply) => {
    if (!(await requireAnyFeature(request, reply, ['explore']))) return;
    if (!deps.homeRecommendations) {
      return { recommendations: defaultHomeRecommendations.filter((item) => item.active) };
    }
    return { recommendations: await deps.homeRecommendations.listActive() };
  });

  app.get('/v1/explore/blueprints', async (request, reply) => {
    if (!(await requireAnyFeature(request, reply, ['ready_made_itineraries']))) return;
    const query = z.object({
      kind: z.enum(['city', 'adventure']).optional(),
      featured: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
    }).parse(request.query);
    return { blueprints: await deps.travelCatalog.listPublished(query) };
  });

  app.get('/v1/explore/blueprints/:id', async (request, reply) => {
    if (!(await requireAnyFeature(request, reply, ['ready_made_itineraries']))) return;
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const blueprint = await deps.travelCatalog.get(id);
    if (!blueprint) {
      reply.code(404);
      return { error: 'blueprint_not_found' };
    }
    return { blueprint };
  });

  app.post('/v1/explore/blueprints/:id/instantiate', async (request, reply) => {
    if (!(await requireAnyFeature(request, reply, ['ready_made_itineraries']))) return;
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const { days } = z.object({ days: z.number().int().min(1).max(30).optional() }).parse(request.body ?? {});
    return { instantiation: await deps.travelCatalog.instantiate(id, days) };
  });

  if (
    deps.adminEmails?.length
    && deps.adminStats
    && deps.adminUsers
    && deps.adminTrips
    && deps.homeRecommendations
    && deps.featureProfiles
  ) {
    await registerAdminRoutes(app, {
      adminEmails: deps.adminEmails,
      stats: deps.adminStats,
      users: deps.adminUsers,
      trips: deps.adminTrips,
      recommendations: deps.homeRecommendations,
      catalog: deps.travelCatalog,
      aiSettings: deps.aiSettings,
      generateBlueprintDraft: deps.generateBlueprintDraft,
      featureProfiles: deps.featureProfiles,
    });
  }

  app.get('/v1/me', async (request) => {
    const user = (request as typeof request & { user?: AuthenticatedUser }).user ?? null;
    if (!user || !deps.firestore) {
      return { user, profile: null };
    }
    const snapshot = await deps.firestore.doc(`users/${user.uid}`).get();
    return { user, profile: snapshot.exists ? snapshot.data() : null };
  });

  app.post('/v1/trips/:tripId/invitations', async (request, reply) => {
    if (!(await requireAnyFeature(request, reply, ['trip_collaboration']))) return;
    const user = (request as typeof request & { user?: AuthenticatedUser }).user ?? null;
    if (!user || !deps.tripCollaboration) {
      reply.code(user ? 503 : 401);
      return { error: user ? 'collaboration_not_configured' : 'unauthorized' };
    }
    const params = z.object({ tripId: z.string().min(1) }).parse(request.params);
    const body = z.object({
      role: z.enum(['editor', 'viewer']).default('editor'),
    }).parse(request.body);
    const invitation = await deps.tripCollaboration.createInvite({
      ...body,
      tripId: params.tripId,
      requesterUid: user.uid,
    });
    reply.code(201);
    return { invitation };
  });

  app.post('/v1/invitations/:token/accept', async (request, reply) => {
    if (!(await requireAnyFeature(request, reply, ['trip_collaboration']))) return;
    const user = (request as typeof request & { user?: AuthenticatedUser }).user ?? null;
    if (!user || !deps.tripCollaboration || !deps.auth) {
      reply.code(user ? 503 : 401);
      return { error: user ? 'collaboration_not_configured' : 'unauthorized' };
    }
    const params = z.object({ token: z.string().min(20).max(200) }).parse(request.params);
    const authUser = await deps.auth.getUser(user.uid);
    return deps.tripCollaboration.accept({
      token: params.token,
      uid: user.uid,
      email: authUser.email,
      displayName: authUser.displayName,
      photoURL: authUser.photoURL,
    });
  });

  app.delete('/v1/me', async (request, reply) => {
    const user = (request as typeof request & { user?: AuthenticatedUser }).user ?? null;
    if (!user) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    if (deps.firestore) {
      const userRef = deps.firestore.doc(`users/${user.uid}`);
      const sharedTrips = await deps.firestore
        .collection('trips')
        .where('memberIds', 'array-contains', user.uid)
        .get();
      for (const tripSnapshot of sharedTrips.docs) {
        const trip = tripSnapshot.data() as {
          ownerId?: string;
          memberIds?: string[];
          members?: Record<string, unknown>;
          participants?: Record<string, Record<string, unknown>>;
        };
        if (trip.ownerId === user.uid) {
          await deps.firestore.recursiveDelete(tripSnapshot.ref);
          continue;
        }
        await tripSnapshot.ref.update(detachDeletedAccount(trip, user.uid));
      }
      await deps.firestore.recursiveDelete(userRef);
    }
    if (deps.auth) {
      await deps.auth.deleteUser(user.uid);
    }
    return { deleted: true };
  });

  app.get('/v1/places/autocomplete', async (request) => {
    const query = z
      .object({
        query: z.string().min(1),
        sessionToken: z.string().optional(),
        latitude: z.coerce.number().optional(),
        longitude: z.coerce.number().optional(),
        scope: z.enum(['destination', 'lodging']).optional(),
        radiusMeters: z.coerce.number().int().positive().max(50_000).optional(),
      })
      .parse(request.query);
    const locationBias =
      query.latitude !== undefined && query.longitude !== undefined
        ? { latitude: query.latitude, longitude: query.longitude }
        : undefined;
    const suggestions = await deps.searchDestinations.autocomplete({
      query: query.query,
      sessionToken: query.sessionToken,
      locationBias,
      scope: query.scope,
      locationRestrictionRadiusMeters: query.radiusMeters,
    });
    return { suggestions };
  });

  app.get('/v1/places/:placeId', async (request) => {
    const params = z.object({ placeId: z.string().min(1) }).parse(request.params);
    const { purpose } = z.object({ purpose: z.enum(['full', 'location', 'photos']).default('full') }).parse(request.query);
    const details = await deps.searchDestinations.details(params.placeId, purpose);
    return { place: details };
  });

  app.post('/v1/places/nearby', async (request) => {
    const body = z
      .object({
        viewport: viewportSchema.optional(),
        location: coordinateSchema.optional(),
        radiusMeters: z.number().int().positive().max(50_000).optional(),
        maxResultCount: z.number().int().min(1).max(20).optional(),
        includedTypes: z.array(z.string()).optional(),
      })
      .parse(request.body);
    const places = await deps.discoverPlaces.attractions(body);
    return { places };
  });

  // Infere cidade e atração de cada agrupamento de fotos (viagem antiga
  // importada, sem roteiro vinculado). O app clusteriza por proximidade antes
  // de chamar, então cada cluster custa no máximo 1 geocode + 1 nearby.
  app.post('/v1/memories/infer', async (request, reply) => {
    if (!(await requireAnyFeature(request, reply, ['memories']))) return;
    const body = z
      .object({
        clusters: z
          .array(
            z.object({
              id: z.string(),
              // coerce: tolera lat/long como string (alguns clients enviam assim).
              latitude: z.coerce.number(),
              longitude: z.coerce.number(),
              photoCount: z.coerce.number().int().positive(),
            }),
          )
          .min(1)
          .max(200),
      })
      .parse(request.body);
    const clusters = await deps.inferTripMemories.infer(body.clusters);
    return { clusters };
  });

  app.post('/v1/places/lodging', async (request) => {
    const body = z
      .object({
        viewport: viewportSchema.optional(),
        location: coordinateSchema.optional(),
        radiusMeters: z.number().int().positive().max(50_000).optional(),
        maxResultCount: z.number().int().min(1).max(20).optional(),
      })
      .parse(request.body);
    const places = await deps.discoverPlaces.lodging(body);
    return { places };
  });

  app.post('/v1/places/discover', async (request) => {
    const body = z
      .object({
        viewport: viewportSchema.optional(),
        location: coordinateSchema.optional(),
        // Acima de 50km o use case decompõe em multi-círculo (centro + anel),
        // já que cada searchNearby do Google é limitado a 50km.
        radiusMeters: z.number().int().positive().max(100_000).optional(),
        buckets: z
          .array(
            z.object({
              id: z.string().min(1),
              types: z.array(z.string().min(1)).min(1).max(50),
            }),
          )
          .min(1)
          .max(20),
        includeSurprise: z.boolean().default(true),
        destinationName: z.string().min(1).max(120).optional(),
      })
      .parse(request.body);
    const buckets = await deps.discoverPlaces.discover(body);
    return { buckets };
  });

  app.post('/v1/places/text-search', async (request) => {
    const body = z
      .object({
        query: z.string().min(1),
        location: coordinateSchema.optional(),
        radiusMeters: z.number().int().positive().max(50_000).optional(),
        maxResultCount: z.number().int().min(1).max(20).optional(),
      })
      .parse(request.body);
    const places = await deps.discoverPlaces.searchByText(body);
    return { places };
  });

  app.post('/v1/routes/segment', async (request, reply) => {
    const body = z
      .object({
        origin: coordinateSchema,
        destination: coordinateSchema,
        mode: z.enum(['car', 'transit', 'walk']).default('car'),
      })
      .parse(request.body);
    try {
      const segment = await deps.routesAdapter.computeSegment(body);
      if (!segment) {
        reply.code(404);
        return { error: 'Não foi possível calcular o trajeto.' };
      }
      return {
        segment: {
          distanceMeters: segment.distanceMeters,
          durationSeconds: segment.durationSeconds,
          polyline: segment.polyline,
        },
      };
    } catch (error) {
      request.log.error(error);
      reply.code(500);
      return { error: error instanceof Error ? error.message : 'Erro ao calcular trajeto.' };
    }
  });

  app.post('/v1/travel-mode/recommend', async (request, reply) => {
    const body = z.object({ city: z.string().min(1) }).parse(request.body);
    try {
      const recommendation = await deps.travelModeAdvisor.recommend(body.city);
      return { recommendation };
    } catch (error) {
      request.log.error(error);
      reply.code(500);
      return { error: error instanceof Error ? error.message : 'Erro ao recomendar modo.' };
    }
  });

  app.post('/v1/destinations/cities', async (request, reply) => {
    const body = z.object({ country: z.string().min(1) }).parse(request.body);
    try {
      const cities = await deps.citySuggester.suggestCities(body.country);
      return { cities };
    } catch (error) {
      request.log.error(error);
      reply.code(500);
      return { error: error instanceof Error ? error.message : 'Erro ao sugerir cidades.' };
    }
  });

  app.post('/v1/places/photos', async (request) => {
    const body = z
      .object({
        items: z
          .array(
            z.object({
              placeId: z.string().min(1),
              photoName: z.string().min(1).optional(),
              photoNames: z.array(z.string().min(1)).min(1).max(5).optional(),
            }).refine((item) => Boolean(item.photoName || item.photoNames?.length), {
              message: 'Informe photoName ou photoNames.',
            }),
          )
          .min(1)
          .max(10),
        maxWidthPx: z.number().int().min(100).max(1600).optional(),
        maxHeightPx: z.number().int().min(100).max(1600).optional(),
      })
      .parse(request.body);
    const maxWidthPx = body.maxWidthPx ?? 400;
    const maxHeightPx = body.maxHeightPx ?? 300;
    const photos = await Promise.all(
      body.items.map(async (item) => {
        const names = [...new Set([...(item.photoNames ?? []), ...(item.photoName ? [item.photoName] : [])])].slice(0, 3);
        for (const photoName of names) {
          try {
            const dataUrl = await deps.fetchPhoto({ photoName, maxWidthPx, maxHeightPx });
            if (dataUrl) return { placeId: item.placeId, photoUrl: dataUrl };
          } catch {
            // Tenta a próxima referência: fotos podem expirar ou ser removidas.
          }
        }
        return { placeId: item.placeId, photoUrl: null };
      }),
    );
    return { photos };
  });

  app.post('/v1/places/enrich', async (request) => {
    const openingPoint = z.object({
      day: z.number().int().min(0).max(6),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
    });
    const body = z
      .object({
        includePhotos: z.boolean().default(true),
        places: z
          .array(
            z.object({
              placeId: z.string(),
              name: z.string(),
              formattedAddress: z.string().optional(),
              coordinate: coordinateSchema,
              primaryType: z.string().optional(),
              types: z.array(z.string()).optional(),
              rating: z.number().optional(),
              userRatingCount: z.number().int().optional(),
              priceLevel: z.string().optional(),
              photoNames: z.array(z.string()).optional(),
              openingHours: z
                .object({
                  periods: z.array(
                    z.object({ open: openingPoint, close: openingPoint.optional() }),
                  ),
                })
                .optional(),
              businessStatus: z
                .enum(['OPERATIONAL', 'CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY'])
                .optional(),
            }),
          )
          .min(1)
          .max(30),
      })
      .parse(request.body);
    const enriched = await deps.enrichPlaces.execute(body.places, body.includePhotos);
    return { places: enriched };
  });

  app.post('/v1/itineraries', { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    if (!(await requireAnyFeature(request, reply, ['city_itinerary_generation', 'ready_made_itineraries']))) return;
    const payload = itineraryRequestSchema.parse(request.body);
    const domainRequest: ItineraryRequest = payload;
    const key = z.string().min(1).max(128).parse(request.headers['idempotency-key'] ?? operationFingerprint(payload));
    request.log.info({ legs: payload.legs.length, candidates: payload.legs.reduce((sum, leg) => sum + leg.candidates.length, 0) }, 'itinerary request');
    try {
      const uid = (request as typeof request & { user: AuthenticatedUser }).user.uid;
      let computed = false;
      const solution = await operations.run(uid, key, payload, () => { computed = true; return deps.generateItinerary.execute(domainRequest); });
      request.log.info({ reused: !computed }, 'generation_result');
      return { itinerary: solution };
    } catch (error) {
      if (error instanceof OperationError) {
        if (error.message === 'generation_in_progress') reply.header('Retry-After', '3');
        reply.code(error.statusCode);
        return { error: error.message };
      }
      if (error instanceof AxiosError) {
        if (!error.response) {
          reply.code(503);
          return { error: 'Solver indisponível. Verifique se o serviço está rodando.' };
        }
        if (error.response.status === 422) {
          reply.code(422);
          const detail = (error.response.data as { detail?: unknown } | undefined)?.detail;
          const message = describeSolverDetail(detail);
          return { error: message ?? 'Não foi possível gerar um roteiro viável com essas restrições.' };
        }
      }
      request.log.error(error);
      reply.code(500);
      return { error: error instanceof Error ? error.message : 'Erro ao gerar roteiro.' };
    }
  });

  // Estimativa de custo pré-geração (dev). Exposta apenas quando a config de
  // custo existe — em produção a instrumentação está desligada.
  if (deps.costConfig) {
    const costConfig = deps.costConfig;
    app.post('/v1/cost/estimate', async (request) => {
      const body = z
        .object({
          legs: z.number().int().min(1).max(20),
          totalDays: z.number().int().min(1).max(120),
          maxRadiusMeters: z.number().int().positive().max(100_000),
          attractionsPerLeg: z.number().int().min(0).max(200),
          mealsPerDay: z.number().int().min(0).max(5),
        })
        .parse(request.body);
      const estimate = estimateGenerationCost(body, costConfig.usdToBrl, await deps.aiSettings.getActive());
      return { estimate };
    });
  }

  app.get('/v1/flights', async (request, reply) => {
    if (!deps.lookupFlight) {
      reply.code(501);
      return { error: 'flight lookup not configured' };
    }
    const query = z
      .object({
        flightIata: z.string().min(2),
        scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(request.query);
    try {
      const options = await deps.lookupFlight.listOptions(query);
      if (options.length === 0) {
        reply.code(404);
        return { error: 'Voo não encontrado.' };
      }
      return { options };
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : 'Voo não encontrado.' };
    }
  });

  // Busca textual de aeroportos na base local (IATA, cidade ou nome). Substitui
  // o autocomplete pago do Places na escolha de origem.
  app.get('/v1/flights/airports/search', async (request) => {
    const query = z.object({ q: z.string().min(2).max(60) }).parse(request.query);
    const airports = searchAirports(query.q).map((airport) => ({
      iata: airport.iata,
      name: airport.name,
      city: airport.city,
      countryCode: airport.countryCode,
      coordinate: airport.coordinate,
    }));
    return { airports };
  });

  // Lista os aeroportos comerciais de uma cidade (principal primeiro) para a UI
  // deixar o usuário escolher quando há mais de um (NYC: JFK/EWR/LGA).
  app.post('/v1/flights/airports', async (request, reply) => {
    if (!deps.suggestFlights) {
      reply.code(501);
      return { error: 'flight suggestions not configured' };
    }
    const body = z
      .object({
        iata: z.string().length(3).optional(),
        name: z.string().optional(),
        coordinate: coordinateSchema.optional(),
      })
      .refine((value) => value.iata || value.coordinate || value.name, {
        message: 'Informe iata, coordinate ou name.',
      })
      .parse(request.body);
    const result = await deps.suggestFlights.listAirports(body);
    return result;
  });

  // Sugere voos reais a partir de origem/destino (cidade ou IATA) e datas.
  // Resolve os IATAs pelo dataset local + Places e consulta o microsserviço.
  app.post('/v1/flights/suggestions', async (request, reply) => {
    if (!deps.suggestFlights) {
      reply.code(501);
      return { error: 'flight suggestions not configured' };
    }
    const airportRefSchema = z
      .object({
        iata: z.string().length(3).optional(),
        name: z.string().optional(),
        coordinate: coordinateSchema.optional(),
      })
      .refine((value) => value.iata || value.coordinate || value.name, {
        message: 'Informe iata, coordinate ou name.',
      });
    const body = z
      .object({
        origin: airportRefSchema,
        destination: airportRefSchema,
        departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        passengers: z.number().int().min(1).max(9).optional(),
        seatType: z.enum(['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST']).optional(),
        topN: z.number().int().min(1).max(10).optional(),
      })
      .parse(request.body);
    try {
      const result = await deps.suggestFlights.execute(body);
      return result;
    } catch (error) {
      if (error instanceof InvalidAirportError) {
        reply.code(422);
        return { error: error.message };
      }
      request.log.error(error);
      reply.code(502);
      return {
        error: error instanceof Error ? error.message : 'Não foi possível buscar voos.',
      };
    }
  });

  // Extrai dados de voo de um bilhete/cartão de embarque. O documento é
  // processado em memória e descartado — nunca é gravado em disco nem em nuvem.
  app.post('/v1/flights/parse-document', async (request, reply) => {
    if (!deps.parseFlightDocument) {
      reply.code(501);
      return { error: 'flight document parsing not configured' };
    }
    const body = z
      .object({
        base64: z.string().min(1),
        mimeType: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']),
      })
      .parse(request.body);
    try {
      const flight = await deps.parseFlightDocument.execute(body);
      return { flight };
    } catch (error) {
      request.log.error(error);
      reply.code(422);
      return {
        error: error instanceof Error ? error.message : 'Não foi possível ler o documento do voo.',
      };
    }
  });
}
