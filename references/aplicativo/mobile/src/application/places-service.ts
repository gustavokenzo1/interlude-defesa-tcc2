import { apiClient } from '@/infrastructure/api-client';
import type {
  AutocompleteSuggestion,
  CitySuggestion,
  Coordinate,
  EnrichedPlace,
  PlaceDetails,
  PlaceSummary,
  Viewport,
} from '@/domain/types';

export const placesService = {
  async autocomplete(
    query: string,
    locationBias?: Coordinate,
    options?: { scope?: 'destination' | 'lodging'; radiusMeters?: number },
  ): Promise<AutocompleteSuggestion[]> {
    const params: Record<string, string | number> = { query };
    if (locationBias) {
      params.latitude = locationBias.latitude;
      params.longitude = locationBias.longitude;
    }
    if (options?.scope) params.scope = options.scope;
    if (options?.radiusMeters) params.radiusMeters = options.radiusMeters;
    const { data } = await apiClient().get<{ suggestions: AutocompleteSuggestion[] }>(
      '/v1/places/autocomplete',
      { params },
    );
    return data.suggestions;
  },

  async details(placeId: string, purpose: 'full' | 'location' | 'photos' = 'full'): Promise<PlaceDetails> {
    const { data } = await apiClient().get<{ place: PlaceDetails }>(`/v1/places/${placeId}`, { params: { purpose } });
    return data.place;
  },

  async suggestCitiesForCountry(country: string): Promise<CitySuggestion[]> {
    const { data } = await apiClient().post<{ cities: CitySuggestion[] }>(
      '/v1/destinations/cities',
      { country },
    );
    return data.cities;
  },

  async nearbyAttractions(input: {
    viewport?: Viewport;
    location?: Coordinate;
    radiusMeters?: number;
    maxResultCount?: number;
    includedTypes?: string[];
  }): Promise<PlaceSummary[]> {
    const { data } = await apiClient().post<{ places: PlaceSummary[] }>('/v1/places/nearby', input);
    return data.places;
  },

  async nearbyLodging(input: {
    viewport?: Viewport;
    location?: Coordinate;
    radiusMeters?: number;
    maxResultCount?: number;
  }): Promise<PlaceSummary[]> {
    const { data } = await apiClient().post<{ places: PlaceSummary[] }>('/v1/places/lodging', input);
    return data.places;
  },

  async textSearch(input: {
    query: string;
    location?: Coordinate;
    radiusMeters?: number;
    maxResultCount?: number;
  }): Promise<PlaceSummary[]> {
    const { data } = await apiClient().post<{ places: PlaceSummary[] }>(
      '/v1/places/text-search',
      input,
    );
    return data.places;
  },

  async discover(input: {
    viewport?: Viewport;
    location?: Coordinate;
    radiusMeters?: number;
    buckets: { id: string; types: string[] }[];
    includeSurprise?: boolean;
    destinationName?: string;
  }): Promise<{ id: string; places: PlaceSummary[] }[]> {
    const { data } = await apiClient().post<{
      buckets: { id: string; places: PlaceSummary[] }[];
    }>('/v1/places/discover', input);
    return data.buckets;
  },

  async enrich(places: PlaceSummary[], includePhotos = true): Promise<EnrichedPlace[]> {
    const { data } = await apiClient().post<{ places: EnrichedPlace[] }>('/v1/places/enrich', {
      places,
      includePhotos,
    });
    return data.places;
  },

  async fetchPhotos(
    items: { placeId: string; photoName?: string; photoNames?: string[] }[],
    options?: { maxWidthPx?: number; maxHeightPx?: number },
  ): Promise<Record<string, string | null>> {
    if (items.length === 0) return {};
    const { data } = await apiClient().post<{ photos: { placeId: string; photoUrl: string | null }[] }>(
      '/v1/places/photos',
      {
        items,
        maxWidthPx: options?.maxWidthPx,
        maxHeightPx: options?.maxHeightPx,
      },
    );
    const result: Record<string, string | null> = {};
    for (const entry of data.photos) {
      result[entry.placeId] = entry.photoUrl;
    }
    return result;
  },
};
