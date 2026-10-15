import { apiClient } from '@/infrastructure/api-client';
import type { TravelMode } from '@/domain/types';

export interface TravelModeRecommendation {
  mode: TravelMode;
  reason: string;
}

export const travelModeService = {
  // Recomendação do Gemini (cacheada no backend por cidade) do melhor meio de
  // locomoção para circular pela cidade, com o motivo para mostrar ao usuário.
  async recommend(city: string): Promise<TravelModeRecommendation | null> {
    try {
      const { data } = await apiClient().post<{ recommendation: TravelModeRecommendation }>(
        '/v1/travel-mode/recommend',
        { city },
      );
      return data.recommendation ?? null;
    } catch {
      return null;
    }
  },
};
