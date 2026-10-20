import { placesService } from '@/application/places-service';
import { placeSummaryForMealCandidate } from '@/features/itinerary/meals';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInUp } from 'react-native-reanimated';
import { PlanningProgress } from '@/features/itinerary/PlanningProgress';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  buildFlightPlanPayload,
  buildLegsPayload,
  buildTransitionsPayload,
  itinerariesService,
} from '@/application/itineraries-service';
import { tripStore } from '@/application/trip-store';
import { useTripDraft } from '@/application/use-trip-store';
import { fetchCoverPhotos } from '@/features/trip/cover-photos';
import { describeApiError } from '@/infrastructure/api-client';
import { colors, fontFamily } from '@/theme';
import { PrimaryButton } from '@/ui/PrimaryButton';
import { ScreenSurface } from '@/ui/Surface';

export default function GeneratingScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const liveDraft = useTripDraft();
  // Uma tentativa usa um snapshot: salvar a solução ou receber uma atualização
  // remota não deve disparar outra geração enquanto esta tela estiver aberta.
  const [draft, setDraft] = useState(() => liveDraft);
  const [error, setError] = useState<string | null>(null);
  const [errorTitle, setErrorTitle] = useState('Não conseguimos gerar agora');
  const [retryToken, setRetryToken] = useState(0);

  const legs = draft.legs;

  const readyLegs = useMemo(
    () =>
      legs.every(
        (leg) =>
          leg.startDate &&
          leg.endDate &&
          (leg.selectedCandidateIds.length > 0 ||
            (draft.anchorExperiences ?? []).some((anchor) => anchor.legId === leg.id)),
      ),
    [draft.anchorExperiences, legs],
  );

  useEffect(() => {
    if (!readyLegs || legs.length === 0) {
      setError('Faltam informações para gerar o roteiro.');
      return;
    }
    let cancelled = false;
    setError(null);
    const payload = buildLegsPayload(legs);
    const requestBody = {
      legs: payload,
      transitions: buildTransitionsPayload(draft.transitions),
      preferenceOrder: draft.preferenceOrder,
      mealCandidates: draft.mealCandidates,
      attractionPriority: draft.attractionPriority,
      attractionDayAssignments: draft.attractionDayAssignments,
      mealPriority: draft.mealPriority,
      flightPlan: buildFlightPlanPayload(draft.flightPlan),
      preferences: draft.preferences,
      anchorExperiences: draft.anchorExperiences,
    };
    async function generate() {
      const pending = (draft.mealCandidates ?? [])
        .filter(row => !row.insight)
        .map(row => ({ row, place: placeSummaryForMealCandidate(row) }))
        .filter((entry): entry is { row: typeof entry.row; place: NonNullable<typeof entry.place> } => Boolean(entry.place));
      const meals = [...(draft.mealCandidates ?? [])];
      try {
        for (let offset = 0; offset < pending.length; offset += 10) {
          if (cancelled) return null;
          const enriched = await placesService.enrich(pending.slice(offset, offset + 10).map(entry => entry.place), false);
          for (const place of enriched) {
            for (const { row } of pending.filter(entry => entry.place.placeId === place.place.placeId)) {
              if (cancelled) return null;
              await tripStore.setMealCandidateEnrichment(row.id, place);
              const index = meals.findIndex(meal => meal.id === row.id);
              if (index >= 0) meals[index] = { ...meals[index]!, insight: place.insight };
            }
          }
        }
      } catch {
        // Os dados básicos permitem gerar mesmo quando a descrição está indisponível.
      }
      if (cancelled) return null;
      return itinerariesService.generate({ ...requestBody, mealCandidates: meals });
    }
    generate()
      .then(async (solution) => {
        if (cancelled || !solution) return;
        try {
          await tripStore.setItinerary(solution);
          try {
            const coverPhotoUrls = await fetchCoverPhotos(legs);
            if (coverPhotoUrls.length > 0) {
              await tripStore.patchDraft({ coverPhotoUrls });
            }
          } catch {
            // Silenciosamente cai pro fallback (foto de POI / placeholder).
          }
          const savedTrip = await tripStore.saveAsTrip();
          if (!savedTrip) throw new Error('O roteiro foi gerado, mas a viagem não pôde ser salva.');
          router.replace({ pathname: '/trip/result', params: { tripId: savedTrip.id } });
        } catch (reason) {
          if (!cancelled) {
            setErrorTitle('O roteiro ficou pronto, mas não foi salvo');
            setError(describeApiError(reason));
          }
        }
      })
      .catch((err) => {
        console.log('[generate] error', err?.response?.data ?? err);
        if (!cancelled) {
          setErrorTitle('Não conseguimos gerar agora');
          setError(describeApiError(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    draft.attractionDayAssignments,
    draft.attractionPriority,
    draft.anchorExperiences,
    draft.flightPlan,
    draft.mealCandidates,
    draft.mealPriority,
    draft.preferenceOrder,
    draft.preferences,
    draft.transitions,
    legs,
    readyLegs,
    retryToken,
    router,
  ]);

  const legCount = legs.length;
  return (
    <ScreenSurface>
      <View style={[styles.content, { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 32 }]}>
        <Animated.View entering={FadeInUp.duration(400)} style={styles.heading}>
          <Text style={styles.kicker}>GERANDO ROTEIRO</Text>
          <Text style={styles.title}>{legCount > 1 ? `Preparando sua viagem por ${legCount} cidades` : 'Preparando seu roteiro'}</Text>
        </Animated.View>

        {error ? (
          <Animated.View entering={FadeIn.duration(300)} style={styles.errorBlock}>
            <Text style={styles.errorTitle}>{errorTitle}</Text>
            <Text style={styles.errorMessage}>{error}</Text>
            <PrimaryButton label="Tentar novamente" onPress={() => {
              setDraft(liveDraft);
              setRetryToken((value) => value + 1);
            }} />
            <PrimaryButton variant="ghost" label="Voltar" onPress={() => router.back()} />
          </Animated.View>
        ) : (
          <PlanningProgress />
        )}
      </View>
    </ScreenSurface>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, gap: 32, paddingHorizontal: 24, justifyContent: 'center' },
  heading: { alignItems: 'center', gap: 8 },
  kicker: { color: colors.pine, fontFamily: fontFamily.bold, fontSize: 9, letterSpacing: 1.8 },
  title: {
    color: colors.ink,
    fontFamily: fontFamily.display,
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.4,
    maxWidth: 320,
    textAlign: 'center',
  },
  errorBlock: { gap: 12, alignItems: 'center' },
  errorTitle: {
    color: colors.ink,
    fontFamily: fontFamily.semibold,
    fontSize: 18,
    lineHeight: 22,
    textAlign: 'center',
  },
  errorMessage: {
    color: colors.inkMuted,
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 18,
    maxWidth: 320,
    textAlign: 'center',
  },
});
