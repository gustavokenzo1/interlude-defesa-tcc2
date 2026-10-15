import { loadEnv } from './config/env.js';
import { DiscoverPlacesUseCase } from './application/discover-places.js';
import { InferTripMemoriesUseCase } from './application/infer-trip-memories.js';
import { EnrichPlacesUseCase } from './application/enrich-places.js';
import { GenerateItineraryUseCase } from './application/generate-itinerary.js';
import { LookupFlightUseCase } from './application/lookup-flight.js';
import { ParseFlightDocumentUseCase } from './application/parse-flight-document.js';
import { SuggestFlightsUseCase } from './application/suggest-flights.js';
import { SearchDestinationsUseCase } from './application/search-destinations.js';
import { AirlabsFlightsAdapter } from './infrastructure/airlabs/flights-adapter.js';
import { AviationstackFlightsAdapter } from './infrastructure/aviationstack/flights-adapter.js';
import { UpstashRedisCache } from './infrastructure/cache/upstash-redis-cache.js';
import { GeminiInsightsAdapter } from './infrastructure/google/gemini-adapter.js';
import { GeminiTravelModeAdapter } from './infrastructure/google/gemini-travel-mode-adapter.js';
import { GeminiCitySuggesterAdapter } from './infrastructure/google/gemini-city-suggester-adapter.js';
import { GeminiFlightDocumentAdapter } from './infrastructure/google/flight-document-adapter.js';
import { GooglePlacesAdapter } from './infrastructure/google/places-adapter.js';
import { GoogleRoutesAdapter } from './infrastructure/google/routes-adapter.js';
import { HttpSolverClient } from './infrastructure/solver/solver-client.js';
import { HttpFlightSuggestionsClient } from './infrastructure/flights/suggestions-client.js';
import { initFirebase, isFirebaseConfigured } from './infrastructure/firebase/firebase-admin.js';
import { AdminStatsUseCase } from './application/admin-stats.js';
import { AdminTripsUseCase } from './application/admin-trips.js';
import { AdminUsersUseCase } from './application/admin-users.js';
import { HomeRecommendationsUseCase } from './application/home-recommendations.js';
import { AiSettingsUseCase } from './application/ai-settings.js';
import { TravelCatalogUseCase } from './application/travel-catalog.js';
import { ConfigurableAiGateway } from './infrastructure/ai/configurable-ai-gateway.js';
import { OpenverseImageAdapter } from './infrastructure/media/openverse-image-adapter.js';
import { ApproximateRoutesAdapter } from './infrastructure/routes/approximate-routes-adapter.js';
import { GenerateBlueprintDraftUseCase } from './application/generate-blueprint-draft.js';
import { TripCollaborationUseCase } from './application/trip-collaboration.js';
import { FeatureProfilesUseCase } from './application/feature-profiles.js';
import { buildServer } from './interfaces/http/server.js';

async function bootstrap() {
  const env = loadEnv();
  if (env.NODE_ENV === 'production' && !isFirebaseConfigured(env)) {
    throw new Error('Firebase Admin credentials are required in production.');
  }

  const cache = env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
    ? new UpstashRedisCache({
        url: env.UPSTASH_REDIS_REST_URL,
        token: env.UPSTASH_REDIS_REST_TOKEN,
      })
    : undefined;

  const firebase = isFirebaseConfigured(env) ? initFirebase(env) : null;
  const aiSettings = new AiSettingsUseCase(
    {
      google: env.GEMINI_API_KEY,
      openai: env.OPENAI_API_KEY,
      anthropic: env.ANTHROPIC_API_KEY,
    },
    firebase?.firestore,
    {
      provider: env.AI_PROVIDER,
      model:
        env.AI_MODEL ??
        ((!env.AI_PROVIDER || env.AI_PROVIDER === 'google') && env.GEMINI_API_KEY
          ? env.GOOGLE_GEMINI_MODEL
          : undefined),
    },
  );
  const aiGateway = new ConfigurableAiGateway(aiSettings);

  const placesAdapter = new GooglePlacesAdapter(env.GOOGLE_MAPS_API_KEY, cache);
  const editorialMedia = new OpenverseImageAdapter(cache);
  const routesAdapter = new GoogleRoutesAdapter(env.GOOGLE_MAPS_API_KEY, cache);
  const insightsAdapter = new GeminiInsightsAdapter(aiGateway, cache);
  const travelModeAdvisor = new GeminiTravelModeAdapter(aiGateway, cache);
  const citySuggester = new GeminiCitySuggesterAdapter(aiGateway, cache);
  const solverClient = new HttpSolverClient(
    env.SOLVER_BASE_URL,
    env.SOLVER_ID_TOKEN_AUDIENCE,
  );
  const blueprintGenerateItinerary = new GenerateItineraryUseCase(
    new ApproximateRoutesAdapter(),
    solverClient,
    placesAdapter,
  );
  const travelCatalog = new TravelCatalogUseCase(
    firebase?.firestore,
    blueprintGenerateItinerary,
    cache,
    placesAdapter,
    routesAdapter,
  );

  const searchDestinations = new SearchDestinationsUseCase(placesAdapter);
  const discoverPlaces = new DiscoverPlacesUseCase(placesAdapter);
  const inferTripMemories = new InferTripMemoriesUseCase(placesAdapter);
  const enrichPlaces = new EnrichPlacesUseCase(placesAdapter, insightsAdapter);
  const generateItinerary = new GenerateItineraryUseCase(routesAdapter, solverClient, placesAdapter);
  const flightsAdapter = env.AIRLABS_API_KEY
    ? new AirlabsFlightsAdapter(env.AIRLABS_API_KEY)
    : env.AVIATIONSTACK_ACCESS_KEY
      ? new AviationstackFlightsAdapter(env.AVIATIONSTACK_ACCESS_KEY)
      : undefined;
  const lookupFlight = flightsAdapter ? new LookupFlightUseCase(flightsAdapter, placesAdapter) : undefined;
  const flightDocumentAdapter = new GeminiFlightDocumentAdapter(aiGateway);
  const parseFlightDocument = new ParseFlightDocumentUseCase(flightDocumentAdapter, placesAdapter);
  const flightSuggestionsClient = new HttpFlightSuggestionsClient(env.FLIGHTS_BASE_URL);
  const suggestFlights = new SuggestFlightsUseCase(flightSuggestionsClient, placesAdapter);
  const adminEmails = env.ADMIN_EMAILS?.split(',')
    .map((email) => email.trim())
    .filter(Boolean);
  const featureProfiles = firebase ? new FeatureProfilesUseCase(firebase.firestore) : undefined;

  const app = await buildServer(env, {
    searchDestinations,
    discoverPlaces,
    inferTripMemories,
    enrichPlaces,
    generateItinerary,
    lookupFlight,
    parseFlightDocument,
    suggestFlights,
    fetchPhoto: (input) => placesAdapter.fetchPhotoDataUrl(input),
    routesAdapter,
    travelModeAdvisor,
    citySuggester,
    auth: firebase?.auth,
    firestore: firebase?.firestore,
    adminEmails,
    adminStats: firebase ? new AdminStatsUseCase(firebase.firestore) : undefined,
    adminUsers: firebase ? new AdminUsersUseCase(firebase.firestore, firebase.auth) : undefined,
    adminTrips: firebase ? new AdminTripsUseCase(firebase.firestore) : undefined,
    homeRecommendations: firebase ? new HomeRecommendationsUseCase(firebase.firestore) : undefined,
    travelCatalog,
    aiSettings,
    generateBlueprintDraft: new GenerateBlueprintDraftUseCase(
      aiGateway,
      placesAdapter,
      blueprintGenerateItinerary,
      editorialMedia,
      cache,
      aiSettings,
    ),
    tripCollaboration: firebase
      ? new TripCollaborationUseCase(firebase.firestore, env.INVITE_BASE_URL)
      : undefined,
    featureProfiles,
  });

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
