import type { InsightsPort, PlacesPort } from '../domain/ports.js';
import type { EnrichedPlace, PlaceSummary } from '../domain/place.js';

const PHOTO_MAX_WIDTH = 800;
const PHOTO_MAX_HEIGHT = 600;

export class EnrichPlacesUseCase {
  constructor(
    private readonly places: PlacesPort,
    private readonly insights: InsightsPort,
  ) {}

  async execute(places: PlaceSummary[], includePhotos = true): Promise<EnrichedPlace[]> {
    const [insightList, photoList] = await Promise.all([
      // Sem insights o roteiro degrada para durações default (75min) em tudo —
      // falha aqui não pode ser silenciosa, foi assim que a remoção do modelo
      // gemini-2.5-flash passou despercebida.
      this.insights.enrich(places).catch((error: unknown) => {
        console.error(
          '[enrich] insights indisponíveis, usando durações default:',
          error instanceof Error ? error.message : error,
        );
        return [];
      }),
      includePhotos ? Promise.all(places.map((place) => this.fetchFirstPhoto(place))) : Promise.resolve([]),
    ]);

    const insightById = new Map(insightList.map((insight) => [insight.placeId, insight]));

    return places.map((place, index) => ({
      place,
      insight: insightById.get(place.placeId),
      photoUrl: photoList[index] ?? undefined,
    }));
  }

  private async fetchFirstPhoto(place: PlaceSummary): Promise<string | null> {
    const photoName = place.photoNames?.[0];
    if (!photoName) return null;
    try {
      return await this.places.fetchPhotoDataUrl({
        photoName,
        maxWidthPx: PHOTO_MAX_WIDTH,
        maxHeightPx: PHOTO_MAX_HEIGHT,
      });
    } catch {
      return null;
    }
  }
}
