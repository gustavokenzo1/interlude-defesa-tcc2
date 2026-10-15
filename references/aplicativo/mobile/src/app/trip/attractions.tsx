import { usePlacePhotos, cachedPlacePhoto } from '@/features/places/usePlacePhotos';
import { useFeatureAccess } from '@/application/feature-access-context';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  Extrapolation,
  FadeIn,
  FadeInUp,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { placesService } from '@/application/places-service';
import { tripStore } from '@/application/trip-store';
import { useTripDraft } from '@/application/use-trip-store';
import { stepNumber } from '@/features/trip/steps';
import { capacityForLeg } from '@/features/trip/capacity';
import type { EnrichedPlace, PlaceSummary, TripLeg } from '@/domain/types';
import { preferenceCatalog } from '@/domain/preferences';
import { discoveryAnchor } from '@/features/discover/anchor';
import { weightedInterleave, type DiscoverBucket } from '@/features/discover/interleave';
import { createPopularityScore, isNonAttraction, rankPlaces } from '@/features/discover/ranking';
import { radiusFromViewport } from '@/features/discover/RadiusMapPicker';
import { describeApiError } from '@/infrastructure/api-client';
import { colors, fontFamily, radius } from '@/theme';
import { Icon } from '@/ui/Icon';
import { PrimaryButton } from '@/ui/PrimaryButton';
import { ScreenSurface } from '@/ui/Surface';
import { StepHeader } from '@/ui/StepHeader';
import {
  formatPlaceType,
  formatRecommendedVisitWindow,
  formatSeasonality,
  formatVisitDuration,
} from '@/features/itinerary/labels';
import {
  budgetZone,
  estimateSelectedCost,
  formatMoney,
  type BudgetZone,
} from '@/features/itinerary/budget';

const SCREEN_WIDTH = Dimensions.get('window').width;
const SWIPE_THRESHOLD = SCREEN_WIDTH * 0.3;
const SWIPE_OUT_DISTANCE = SCREEN_WIDTH * 1.4;
const STACK_OFFSET_Y = 10;
const STACK_SCALE_STEP = 0.05;
const VISIBLE_CARDS = 3;
const SWIPE_OUT_DURATION = 180;
const SWIPE_BACK_DURATION = 140;
const STACK_SPRING = { damping: 20, stiffness: 220, mass: 0.6 };

// Um lote inicial; antecipa outro quando restam três cartões.
const SURPRISE_BUCKET_ID = '__surprise__';
const FEED_HEAD_SIZE = 8;

function diffInDays(start?: string, end?: string): number {
  if (!start || !end) return 1;
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 1;
  return Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1);
}

interface LegFeedState {
  loading: boolean;
  error: string | null;
  summariesQueue: PlaceSummary[];
  places: EnrichedPlace[];
  selectedIds: Set<string>;
  topIndex: number;
}

function emptyState(): LegFeedState {
  return {
    loading: false,
    error: null,
    summariesQueue: [],
    places: [],
    selectedIds: new Set(),
    topIndex: 0,
  };
}

export default function AttractionsScreen() {
  const { isTccPresentation } = useFeatureAccess();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const draft = useTripDraft();
  const legs = draft.legs;

  const [activeLegId, setActiveLegId] = useState<string>(() => legs[0]?.id ?? '');
  const [stateByLeg, setStateByLeg] = useState<Record<string, LegFeedState>>(() => {
    const initial: Record<string, LegFeedState> = {};
    for (const leg of legs) {
      initial[leg.id] = {
        ...emptyState(),
        places: leg.candidates,
        selectedIds: new Set(leg.selectedCandidateIds),
      };
    }
    return initial;
  });
  const [selectionOpen, setSelectionOpen] = useState(false);
  const [detailPlace, setDetailPlace] = useState<EnrichedPlace | null>(null);
  // Alerta de "passou do recomendado": modal mostrado uma única vez por leg,
  // no primeiro card que ultrapassa a quantidade que costuma caber.
  const [overLimitModalLegId, setOverLimitModalLegId] = useState<string | null>(null);
  const overLimitWarnedRef = useRef<Set<string>>(new Set());

  const [prefetchTick, setPrefetchTick] = useState(0);
  const prefetchAttempts = useRef(new Set<string>());
  const enrichingRef = useRef<Record<string, boolean>>({});
  const enrichedCursorRef = useRef<Record<string, number>>({});
  const generationRef = useRef<Record<string, number>>({});
  const fetchedRef = useRef<Set<string>>(new Set());
  const activeLeg = legs.find((leg) => leg.id === activeLegId) ?? legs[0];

  // Sincroniza candidates novos vindos do draft (ex: POI adicionado via
  // tela /trip/add-poi enquanto esta tela estava em background). Mantém o
  // estado local de topIndex/loading; só injeta places que ainda não existem.
  useEffect(() => {
    setStateByLeg((current) => {
      let changed = false;
      const next: Record<string, LegFeedState> = { ...current };
      for (const leg of legs) {
        const existing = next[leg.id] ?? emptyState();
        const existingIds = new Set(existing.places.map((p) => p.place.placeId));
        const additions = leg.candidates.filter((c) => !existingIds.has(c.place.placeId));
        const newSelected = new Set(existing.selectedIds);
        let selectedChanged = false;
        for (const id of leg.selectedCandidateIds) {
          if (!newSelected.has(id)) {
            newSelected.add(id);
            selectedChanged = true;
          }
        }
        if (additions.length === 0 && !selectedChanged) {
          if (!next[leg.id]) {
            next[leg.id] = existing;
            changed = true;
          }
          continue;
        }
        next[leg.id] = {
          ...existing,
          places: [...additions, ...existing.places],
          selectedIds: newSelected,
        };
        changed = true;
      }
      return changed ? next : current;
    });
  }, [legs]);

  const interestBuckets = useMemo<DiscoverBucket[]>(() => {
    const levels = draft.interestLevels ?? {};
    return preferenceCatalog
      .map((option) => ({
        id: option.id,
        types: option.matchTypes,
        weight: levels[option.id] ?? 0,
      }))
      .filter((bucket) => bucket.weight > 0)
      .map((bucket) => ({ id: bucket.id, weight: bucket.weight, places: [] as PlaceSummary[] }));
  }, [draft.interestLevels]);

  const fetchForLeg = useCallback(
    (leg: TripLeg) => {
      if (fetchedRef.current.has(leg.id)) return;
      // Se já tem candidatos persistidos no draft, não precisa buscar.
      if (leg.candidates.length > 0) {
        fetchedRef.current.add(leg.id);
        return;
      }
      fetchedRef.current.add(leg.id);
      const generation = (generationRef.current[leg.id] ?? 0) + 1;
      generationRef.current[leg.id] = generation;
      setStateByLeg((current) => ({
        ...current,
        [leg.id]: {
          ...emptyState(),
          loading: true,
        },
      }));
      enrichedCursorRef.current[leg.id] = 0;
      enrichingRef.current[leg.id] = false;

      const bucketSpecs = preferenceCatalog
        .map((option) => ({ id: option.id, types: option.matchTypes }))
        .filter((bucket) => interestBuckets.some((interest) => interest.id === bucket.id));

      // Centro = base (hospedagem). O raio é derivado automaticamente do
      // viewport do destino, sem interromper o fluxo com uma configuração.
      const anchor = discoveryAnchor(leg);
      const radiusMeters = radiusFromViewport(anchor.viewport);

      placesService
        .discover({
          viewport: anchor.viewport,
          location: anchor.coordinate,
          radiusMeters,
          buckets:
            bucketSpecs.length > 0
              ? bucketSpecs
              : [{ id: 'experiences', types: ['tourist_attraction', 'point_of_interest'] }],
          includeSurprise: true,
          destinationName: leg.destination.name,
        })
        .then(async (bucketResults) => {
          if (generation !== generationRef.current[leg.id]) return;
          const selectedTypes = new Set(bucketSpecs.flatMap((bucket) => bucket.types));
          const score = createPopularityScore(
            bucketResults.flatMap((bucket) =>
              bucket.places.filter((p) => !isNonAttraction(p, selectedTypes)),
            ),
            { center: anchor.coordinate, radiusMeters },
          );
          const cleanedBuckets: DiscoverBucket[] = bucketResults.map((bucket) => {
            const interest = interestBuckets.find((b) => b.id === bucket.id);
            const weight = bucket.id === SURPRISE_BUCKET_ID ? 1 : interest?.weight ?? 1;
            return { id: bucket.id, weight, places: rankPlaces(bucket.places, score, selectedTypes) };
          });
          const placeById = new Map<string, PlaceSummary>();
          for (const bucket of cleanedBuckets) {
            for (const place of bucket.places) {
              placeById.set(place.placeId, place);
            }
          }
          const allUnique = Array.from(placeById.values()).sort((a, b) => score(b) - score(a));
          const head = allUnique.slice(0, FEED_HEAD_SIZE);
          const seen = new Set(head.map((p) => p.placeId));
          const tailBuckets: DiscoverBucket[] = cleanedBuckets.map((bucket) => ({
            ...bucket,
            places: bucket.places.filter((p) => !seen.has(p.placeId)),
          }));
          const tail = weightedInterleave(tailBuckets).filter((place) => {
            if (seen.has(place.placeId)) return false;
            seen.add(place.placeId);
            return true;
          });
          const queue = [...head, ...tail];
          enrichedCursorRef.current[leg.id] = queue.length;
          setStateByLeg((current) => ({
            ...current,
            [leg.id]: {
              ...current[leg.id]!,
              loading: false,
              error: null,
              summariesQueue: queue,
              places: queue.map((place) => ({ place })),
              topIndex: 0,
            },
          }));
        })
        .catch((err) => {
          if (generation !== generationRef.current[leg.id]) return;
          setStateByLeg((current) => ({
            ...current,
            [leg.id]: { ...current[leg.id]!, loading: false, error: describeApiError(err) },
          }));
        });
    },
    [interestBuckets],
  );

  useEffect(() => {
    if (!activeLeg) return;
    if ((draft.anchorExperiences ?? []).some((anchor) => anchor.legId === activeLeg.id)) {
      fetchedRef.current.add(activeLeg.id);
      return;
    }
    fetchForLeg(activeLeg);
  }, [activeLeg, draft.anchorExperiences, fetchForLeg]);

  // Prefetch do próximo batch dentro do leg ativo
  useEffect(() => {
    if (!activeLeg) return;
    const state = stateByLeg[activeLeg.id];
    if (!state) return;
    if (enrichingRef.current[activeLeg.id]) return;
    const batch = state.places.slice(state.topIndex, state.topIndex + 15)
      .filter((candidate) => !candidate.insight?.description?.trim() && !prefetchAttempts.current.has(`${activeLeg.id}:${candidate.place.placeId}`))
      .slice(0, 10).map((candidate) => candidate.place);
    if (!batch.length) return;
    batch.forEach((place) => prefetchAttempts.current.add(`${activeLeg.id}:${place.placeId}`));
    const generation = generationRef.current[activeLeg.id];
    enrichingRef.current[activeLeg.id] = true;
    placesService
      .enrich(batch, false)
      .then((enriched) => {
        if (generation !== generationRef.current[activeLeg.id]) return;
        setStateByLeg((current) => {
          const existing = current[activeLeg.id]!;
          const byId = new Map(enriched.map((place) => [place.place.placeId, place]));
          return {
            ...current,
            [activeLeg.id]: { ...existing, places: existing.places.map((place) => {
              const fresh = byId.get(place.place.placeId);
              return fresh?.insight ? { ...place, insight: fresh.insight } : place;
            }) },
          };
        });
      })
      .catch(() => {})
      .finally(() => {
        enrichingRef.current[activeLeg.id] = false;
        setPrefetchTick((value) => value + 1);
      });
  }, [activeLeg, stateByLeg, prefetchTick]);

  const accept = useCallback((placeId: string) => {
    if (!activeLeg) return;
    const target = targetForLeg(activeLeg);
    setStateByLeg((current) => {
      const existing = current[activeLeg.id]!;
      if (existing.selectedIds.has(placeId)) return current;
      const next = new Set(existing.selectedIds);
      next.add(placeId);
      // Cruzou o recomendado pela primeira vez neste leg: alerta uma única vez.
      if (next.size > target && !overLimitWarnedRef.current.has(activeLeg.id)) {
        overLimitWarnedRef.current.add(activeLeg.id);
        setOverLimitModalLegId(activeLeg.id);
      }
      return { ...current, [activeLeg.id]: { ...existing, selectedIds: next } };
    });
  }, [activeLeg]);

  const removeSelection = useCallback((placeId: string) => {
    if (!activeLeg) return;
    setStateByLeg((current) => {
      const existing = current[activeLeg.id]!;
      if (!existing.selectedIds.has(placeId)) return current;
      const next = new Set(existing.selectedIds);
      next.delete(placeId);
      return { ...current, [activeLeg.id]: { ...existing, selectedIds: next } };
    });
  }, [activeLeg]);

  const advance = useCallback(() => {
    if (!activeLeg) return;
    setStateByLeg((current) => {
      const existing = current[activeLeg.id]!;
      return { ...current, [activeLeg.id]: { ...existing, topIndex: existing.topIndex + 1 } };
    });
  }, [activeLeg]);

  function toggleSelection(placeId: string) {
    if (!activeLeg) return;
    const state = stateByLeg[activeLeg.id]!;
    if (state.selectedIds.has(placeId)) removeSelection(placeId);
    else accept(placeId);
  }

  function handleRestart() {
    if (!activeLeg) return;
    setStateByLeg((current) => ({
      ...current,
      [activeLeg.id]: { ...current[activeLeg.id]!, selectedIds: new Set(), topIndex: 0 },
    }));
  }

  async function commitAndContinue() {
    let firstLegWithSelection: string | null = null;
    for (const leg of legs) {
      const state = stateByLeg[leg.id];
      if (!state) continue;
      const finalSelected = state.places.filter((place) => state.selectedIds.has(place.place.placeId))
        .map((place) => ({ ...place, photoUrl: place.photoUrl ?? cachedPlacePhoto(place.place.placeId) }));
      if (finalSelected.length === 0) continue;
      if (!firstLegWithSelection) firstLegWithSelection = leg.id;
      await tripStore.setLegCandidates(
        leg.id,
        finalSelected,
        finalSelected.map((place) => place.place.placeId),
      );
    }
    if (firstLegWithSelection) {
      router.push({ pathname: '/trip/attractions-summary', params: { legId: firstLegWithSelection } });
    } else {
      router.push('/trip/meals-hub');
    }
  }

  function handleContinue() {
    if (!activeLeg) return;
    const missingLeg = legs.find(
      (leg) =>
        (stateByLeg[leg.id]?.selectedIds.size ?? 0) === 0 &&
        !(draft.anchorExperiences ?? []).some((anchor) => anchor.legId === leg.id),
    );
    if (missingLeg) {
      setActiveLegId(missingLeg.id);
      return;
    }
    void commitAndContinue();
  }

  // Custo acumulado das atrações selecionadas em toda a viagem vs. orçamento.
  // Só um aviso — nunca trava a seleção.
  const budgetProgress = useMemo(() => {
    const budget = activeLeg?.budget ?? draft.budget;
    const total = budget?.totalAmount;
    if (total == null || total <= 0) return null;
    const selectedEverywhere = (activeLeg?.budget ? [activeLeg] : legs).flatMap((leg) => {
      const state = stateByLeg[leg.id];
      if (!state) return [];
      return state.places.filter((place) => state.selectedIds.has(place.place.placeId));
    });
    const estimated = estimateSelectedCost(selectedEverywhere);
    if (estimated <= 0) return null;
    return { estimated, total, currency: budget!.currency, ratio: estimated / total };
  }, [activeLeg, draft.budget, legs, stateByLeg]);

  const photoState = activeLeg ? stateByLeg[activeLeg.id] : undefined;
  const visiblePhotoRequests = useMemo(() =>
    (photoState?.places.slice(photoState.topIndex, photoState.topIndex + 10) ?? []).map((candidate) => ({
      placeId: candidate.place.placeId, photoNames: candidate.place.photoNames, existingUrl: candidate.photoUrl,
    })), [photoState]);
  const visiblePhotos = usePlacePhotos(visiblePhotoRequests);
  const topCandidate = photoState?.places[photoState.topIndex];
  const descriptionLegId = activeLeg?.id;
  const [manualDescription, setManualDescription] = useState<{ key: string; status: 'loading' | 'error' } | null>(null);
  const descriptionKey = `${descriptionLegId}:${topCandidate?.place.placeId}`;
  const descriptionStatus = !topCandidate || topCandidate.insight?.description?.trim() ? 'idle'
    : manualDescription?.key === descriptionKey ? manualDescription.status
      : !prefetchAttempts.current.has(descriptionKey) || (descriptionLegId && enrichingRef.current[descriptionLegId]) ? 'loading' : 'error';
  async function retryDescription() {
    if (!topCandidate || !descriptionLegId || manualDescription?.status === 'loading') return;
    const key = descriptionKey;
    const generation = generationRef.current[descriptionLegId];
    setManualDescription({ key, status: 'loading' });
    try {
      const [enriched] = await placesService.enrich([topCandidate.place], false);
      if (!enriched?.insight?.description?.trim()) throw new Error('Descrição indisponível');
      if (generation !== generationRef.current[descriptionLegId]) return;
      setStateByLeg(current => {
        const state = current[descriptionLegId];
        if (!state) return current;
        return { ...current, [descriptionLegId]: { ...state, places: state.places.map(place => place.place.placeId === enriched.place.placeId ? { ...place, insight: enriched.insight } : place) } };
      });
      setManualDescription(current => current?.key === key ? null : current);
    } catch { setManualDescription(current => current?.key === key ? { key, status: 'error' } : current); }
  }

  if (!activeLeg) {
    return (
      <ScreenSurface>
        <View style={styles.empty}>
          <Text style={styles.emptyText}>Defina o destino antes de escolher atrações.</Text>
          <PrimaryButton label="Voltar ao início" onPress={() => router.replace('/trip/destination')} />
        </View>
      </ScreenSurface>
    );
  }

  const rawActiveState = stateByLeg[activeLeg.id] ?? emptyState();
  const activeState = { ...rawActiveState, places: rawActiveState.places.map((place) => ({
    ...place, photoUrl: place.photoUrl ?? visiblePhotos[place.place.placeId] ?? cachedPlacePhoto(place.place.placeId),
  })) };
  const days = diffInDays(activeLeg.startDate, activeLeg.endDate);
  const targetStops = targetForLeg(activeLeg);
  const selectedCount = activeState.selectedIds.size;
  const activeHasAnchor = (draft.anchorExperiences ?? []).some((anchor) => anchor.legId === activeLeg.id);
  const recommendationText = describeRecommendation(days, activeLeg.destination.name);

  const deckExhausted = activeState.topIndex >= activeState.places.length;
  // Fila ainda tem lugares aguardando enrich: o fim do deck é provisório.
  const moreEnriching = false;
  const pendingPlaces = activeState.places.filter((place) => !activeState.selectedIds.has(place.place.placeId));
  const selectedPlaces = activeState.places.filter((place) => activeState.selectedIds.has(place.place.placeId));
  return (
    <ScreenSurface>
      <View style={[styles.root, { paddingBottom: insets.bottom + 12 }]}>
        <StepHeader {...stepNumber(draft, 'attractions')} label="Atrações" onBack={() => router.back()} />

        {legs.length > 1 ? (
          <View style={styles.chipsScrollWrap}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipsRow}>
              {legs.map((leg) => {
                const isActive = leg.id === activeLeg.id;
                const count = stateByLeg[leg.id]?.selectedIds.size ?? 0;
                return (
                  <Pressable
                    key={leg.id}
                    onPress={() => setActiveLegId(leg.id)}
                    style={({ pressed }) => [
                      styles.chip,
                      isActive && { backgroundColor: leg.color, borderColor: leg.color },
                      pressed && styles.pressed,
                    ]}>
                    <View style={[styles.chipDot, { backgroundColor: leg.color }, isActive && styles.chipDotActive]} />
                    <Text
                      numberOfLines={1}
                      style={[styles.chipLabel, isActive && styles.chipLabelActive]}>
                      {leg.destination.name}
                    </Text>
                    {count > 0 ? (
                      <Text style={[styles.chipCount, isActive && styles.chipCountActive]}>{count}</Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        <Animated.View entering={FadeInUp.duration(360)} style={styles.headerRow}>
          <Text numberOfLines={2} style={styles.recommendation}>
            {isTccPresentation ? 'Escolha suas atrações' : recommendationText}
          </Text>
          <Pressable
            onPress={() => router.push({ pathname: '/trip/add-poi', params: { legId: activeLeg.id } })}
            style={({ pressed }) => [styles.headerIconButton, pressed && styles.pressed]}>
            <Icon name="plus" size={16} color={colors.ink} strokeWidth={2.2} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Ver ${selectedCount} atrações selecionadas`}
            onPress={() => setSelectionOpen(true)}
            style={({ pressed }) => [styles.selectionButton, pressed && styles.pressed]}>
            <Icon name="list" size={14} color={colors.ink} />
            <Text style={styles.selectionButtonLabel}>{selectedCount}</Text>
          </Pressable>
        </Animated.View>

        {budgetProgress ? <BudgetBar {...budgetProgress} /> : null}

        {activeState.loading ? (
          <View style={styles.loadingBlock}>
            <ActivityIndicator color={colors.ink} />
          </View>
        ) : activeState.error ? (
          <Text style={styles.error}>{activeState.error}</Text>
        ) : (
          <Animated.View key={`deck-${activeLeg.id}`} entering={FadeIn.duration(220)} style={styles.deckArea}>
            {deckExhausted ? (
              moreEnriching ? (
                <DeckLoadingMore />
              ) : (
                <DeckEmptyState
                  selectedCount={selectedCount}
                  totalCount={activeState.places.length}
                  onRestart={handleRestart}
                  onReview={() => setSelectionOpen(true)}
                />
              )
            ) : (
              <Deck
                places={activeState.places}
                topIndex={activeState.topIndex}
                selectedCount={selectedCount}
                targetStops={targetStops}
                descriptionLoading={descriptionStatus === 'loading'}
                onAccept={(id) => {
                  accept(id);
                  advance();
                }}
                onSkip={advance}
                onOpenDetail={setDetailPlace}
              />
            )}
          </Animated.View>
        )}

        <View style={styles.footer}>
          {descriptionStatus === 'loading' ? (
            <Text style={styles.recommendation} accessibilityLiveRegion="polite">Carregando a breve descrição…</Text>
          ) : descriptionStatus === 'error' ? (
            <Pressable accessibilityRole="button" onPress={() => void retryDescription()}>
              <Text style={styles.recommendation}>Descrição indisponível. Toque para tentar novamente.</Text>
            </Pressable>
          ) : null}
          {(() => {
            const nextMissingLeg = legs.find(
              (leg) =>
                leg.id !== activeLeg.id &&
                (stateByLeg[leg.id]?.selectedIds.size ?? 0) === 0 &&
                !(draft.anchorExperiences ?? []).some((anchor) => anchor.legId === leg.id),
            );
            const allLegsHaveSelection = legs.every(
              (leg) =>
                (stateByLeg[leg.id]?.selectedIds.size ?? 0) > 0 ||
                (draft.anchorExperiences ?? []).some((anchor) => anchor.legId === leg.id),
            );
            const totalSelected = legs.reduce(
              (sum, leg) => sum + (stateByLeg[leg.id]?.selectedIds.size ?? 0),
              0,
            );
            let label: string;
            const icon: 'next' = 'next';
            if (selectedCount === 0 && activeHasAnchor) {
              label = 'Continuar com o passeio selecionado';
            } else if (selectedCount === 0) {
              label = 'Selecione ao menos uma atração';
            } else if (nextMissingLeg) {
              label = `Próximo: ${nextMissingLeg.destination.name}`;
            } else if (allLegsHaveSelection && legs.length > 1) {
              label = `Revisar · ${totalSelected} atrações`;
            } else {
              label = `Continuar · ${selectedCount}`;
            }
            return (
              <PrimaryButton
                label={label}
                disabled={selectedCount === 0 && !activeHasAnchor}
                onPress={() => {
                  if (nextMissingLeg) {
                    setActiveLegId(nextMissingLeg.id);
                    return;
                  }
                  handleContinue();
                }}
                trailingIcon={icon}
              />
            );
          })()}
        </View>
      </View>

      {selectionOpen ? (
        <SelectionSheet
          selected={selectedPlaces}
          pending={pendingPlaces}
          destinationName={activeLeg.destination.name}
          onToggle={toggleSelection}
          onOpenDetail={setDetailPlace}
          onClose={() => setSelectionOpen(false)}
        />
      ) : null}

      {detailPlace ? <DetailSheet place={detailPlace} onClose={() => setDetailPlace(null)} /> : null}

      {overLimitModalLegId ? (
        <OverLimitModal
          target={targetStops}
          destinationName={activeLeg.destination.name}
          onKeepAdding={() => setOverLimitModalLegId(null)}
          onGenerate={() => {
            setOverLimitModalLegId(null);
            handleContinue();
          }}
        />
      ) : null}
    </ScreenSurface>
  );
}

function targetForLeg(leg: TripLeg): number {
  return capacityForLeg(leg);
}

// O racional do alvo ("X de Y selecionadas") fica no contador entre os botões
// de swipe; aqui só o contexto do leg, numa linha, para o card dominar a tela.
function describeRecommendation(days: number, cityName: string): string {
  const dayLabel = days === 1 ? 'dia' : 'dias';
  return `${cityName} · ${days} ${dayLabel}`;
}

const BUDGET_ZONE_COLOR: Record<BudgetZone, string> = {
  safe: colors.success,
  warning: colors.amber,
  danger: colors.danger,
};

function BudgetBar({
  estimated,
  total,
  currency,
  ratio,
}: {
  estimated: number;
  total: number;
  currency: string;
  ratio: number;
}) {
  const fillColor = BUDGET_ZONE_COLOR[budgetZone(ratio)];
  const percent = Math.round(ratio * 100);
  const fillWidth = `${Math.min(100, percent)}%` as const;
  return (
    <Animated.View entering={FadeIn.duration(220)} style={styles.budgetBar}>
      <View style={styles.budgetBarRow}>
        <Text style={styles.budgetBarLabel}>
          {formatMoney(estimated, currency)} de {formatMoney(total, currency)}
        </Text>
        <Text style={[styles.budgetBarPercent, { color: fillColor }]}>{percent}%</Text>
      </View>
      <View style={styles.budgetBarTrack}>
        <View style={[styles.budgetBarFill, { width: fillWidth, backgroundColor: fillColor }]} />
      </View>
    </Animated.View>
  );
}

interface DeckProps {
  places: EnrichedPlace[];
  topIndex: number;
  selectedCount: number;
  targetStops: number;
  descriptionLoading: boolean;
  onAccept: (placeId: string) => void;
  onSkip: () => void;
  onOpenDetail: (place: EnrichedPlace) => void;
}

function Deck({ places, topIndex, selectedCount, targetStops, descriptionLoading, onAccept, onSkip, onOpenDetail }: DeckProps) {
  const visible = useMemo(
    () => places.slice(topIndex, topIndex + VISIBLE_CARDS),
    [places, topIndex],
  );

  return (
    <View style={styles.deckColumn}>
      <View style={styles.deckStage}>
        {visible
          .slice()
          .reverse()
          .map((place, reverseIndex) => {
            const depth = visible.length - 1 - reverseIndex;
            const isTop = depth === 0;
            return (
              <DeckCard
                key={place.place.placeId}
                place={place}
                depth={depth}
                isTop={isTop}
                descriptionLoading={!isTop || descriptionLoading}
                onSwipeRight={() => onAccept(place.place.placeId)}
                onSwipeLeft={onSkip}
                onOpenDetail={() => onOpenDetail(place)}
              />
            );
          })}
      </View>

      <View style={styles.deckActions}>
        <Pressable
          onPress={onSkip}
          accessibilityRole="button"
          accessibilityLabel="Descartar atração"
          style={({ pressed }) => [styles.deckActionBtn, styles.deckActionSkip, pressed && styles.pressed]}>
          <Icon name="close" size={22} color={colors.ink} strokeWidth={2.4} />
        </Pressable>
        <View style={styles.deckCounterInline}>
          <Text style={styles.deckCounterInlineText}>
            {selectedCount} <Text style={styles.deckCounterInlineSoft}>/ {targetStops}</Text>
          </Text>
          <Text style={styles.deckCounterInlineLabel}>selecionadas</Text>
        </View>
        <Pressable
          onPress={() => {
            const place = places[topIndex];
            if (!place) return;
            onAccept(place.place.placeId);
          }}
          accessibilityRole="button"
          accessibilityLabel="Selecionar atração"
          style={({ pressed }) => [styles.deckActionBtn, styles.deckActionAccept, pressed && styles.pressed]}>
          <Icon name="check" size={24} color={colors.paper} strokeWidth={2.6} />
        </Pressable>
      </View>
    </View>
  );
}

interface DeckCardProps {
  place: EnrichedPlace;
  depth: number;
  isTop: boolean;
  descriptionLoading: boolean;
  onSwipeRight: () => void;
  onSwipeLeft: () => void;
  onOpenDetail: () => void;
}

function DeckCard({ place, depth, isTop, descriptionLoading, onSwipeRight, onSwipeLeft, onOpenDetail }: DeckCardProps) {
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const depthAnim = useSharedValue(depth);

  useEffect(() => {
    depthAnim.value = withSpring(depth, STACK_SPRING);
  }, [depth, depthAnim]);

  const pan = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-20, 20])
    .enabled(isTop)
    .onUpdate((event) => {
      translateX.value = event.translationX;
      translateY.value = event.translationY * 0.18;
    })
    .onEnd((event) => {
      const shouldAccept = event.translationX > SWIPE_THRESHOLD || event.velocityX > 700;
      const shouldSkip = event.translationX < -SWIPE_THRESHOLD || event.velocityX < -700;
      if (shouldAccept) {
        translateX.value = withTiming(
          SWIPE_OUT_DISTANCE,
          { duration: SWIPE_OUT_DURATION, easing: Easing.out(Easing.cubic) },
          (finished) => {
            if (finished) runOnJS(onSwipeRight)();
          },
        );
        return;
      }
      if (shouldSkip) {
        translateX.value = withTiming(
          -SWIPE_OUT_DISTANCE,
          { duration: SWIPE_OUT_DURATION, easing: Easing.out(Easing.cubic) },
          (finished) => {
            if (finished) runOnJS(onSwipeLeft)();
          },
        );
        return;
      }
      translateX.value = withTiming(0, { duration: SWIPE_BACK_DURATION, easing: Easing.out(Easing.quad) });
      translateY.value = withTiming(0, { duration: SWIPE_BACK_DURATION, easing: Easing.out(Easing.quad) });
    });

  const cardStyle = useAnimatedStyle(() => {
    const rotate = interpolate(
      translateX.value,
      [-SCREEN_WIDTH, 0, SCREEN_WIDTH],
      [-9, 0, 9],
      Extrapolation.CLAMP,
    );
    return {
      transform: [
        { translateX: translateX.value },
        { translateY: translateY.value },
        { rotateZ: `${rotate}deg` },
      ],
    };
  });

  const stackStyle = useAnimatedStyle(() => {
    const scale = 1 - depthAnim.value * STACK_SCALE_STEP;
    const offsetY = depthAnim.value * STACK_OFFSET_Y;
    return {
      transform: [{ translateY: offsetY }, { scale }],
      zIndex: 100 - depth,
    };
  });

  const acceptBadgeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      translateX.value,
      [0, SWIPE_THRESHOLD * 0.5, SWIPE_THRESHOLD],
      [0, 0.6, 1],
      Extrapolation.CLAMP,
    ),
  }));
  const skipBadgeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      translateX.value,
      [-SWIPE_THRESHOLD, -SWIPE_THRESHOLD * 0.5, 0],
      [1, 0.6, 0],
      Extrapolation.CLAMP,
    ),
  }));

  const minutes = place.insight?.averageMinutes;
  const description = place.insight?.description;
  const typeLabel = formatPlaceType(place.place.primaryType ?? place.place.types?.[0]);
  const rating = place.place.rating;
  const ratingCount = place.place.userRatingCount;
  const cost = place.insight?.averageCost;
  const costLabel =
    cost == null ? null : cost.value > 0 ? `~${formatMoney(cost.value, cost.currency)}` : 'Grátis';

  const cardInner = (
    <Animated.View style={[styles.deckCard, isTop ? cardStyle : undefined]}>
      <Pressable
        onPress={onOpenDetail}
        disabled={!isTop}
        accessibilityRole="button"
        accessibilityLabel={`Detalhes de ${place.place.name}`}
        style={styles.deckCardPressable}>
        {place.photoUrl ? (
          <Image source={{ uri: place.photoUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.deckCardFallback]}>
            <Icon name="map" size={32} color={colors.inkSoft} />
          </View>
        )}
        <LinearGradient
          colors={['rgba(0,0,0,0.0)', 'rgba(0,0,0,0.25)', 'rgba(0,0,0,0.92)']}
          locations={[0.25, 0.55, 1]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <View style={styles.deckCardContent}>
          {typeLabel ? <Text style={styles.deckCardType}>{typeLabel.toUpperCase()}</Text> : null}
          <Text numberOfLines={2} style={styles.deckCardTitle}>
            {place.place.name}
          </Text>
          <View style={styles.deckCardChips}>
            {rating ? (
              <View style={styles.deckCardChip}>
                <Icon name="starFilled" size={11} color={colors.star} />
                <Text style={styles.deckCardChipText}>
                  {rating.toFixed(1)}
                  {ratingCount ? ` · ${ratingCount.toLocaleString('pt-BR')}` : ''}
                </Text>
              </View>
            ) : null}
            {minutes ? (
              <View style={styles.deckCardChip}>
                <Icon name="clock" size={11} color={colors.paper} strokeWidth={2} />
                <Text style={styles.deckCardChipText}>{formatVisitDuration(minutes)}</Text>
              </View>
            ) : null}
            {costLabel ? (
              <View style={styles.deckCardChip}>
                <Icon name="creditCard" size={11} color={colors.amber} strokeWidth={2} />
                <Text style={styles.deckCardChipText}>{costLabel}</Text>
              </View>
            ) : null}
          </View>
          {description ? (
            <Text numberOfLines={3} style={styles.deckCardDescription}>
              {description}
            </Text>
          ) : descriptionLoading ? <View accessibilityRole="progressbar" accessibilityLabel="Carregando descrição" style={{ gap: 6, paddingVertical: 4 }}>
            {[100, 94, 68].map(width => <View key={width} style={{ width: `${width}%`, height: 10, borderRadius: 5, backgroundColor: colors.paper, opacity: 0.3 }} />)}
          </View> : <Text style={styles.deckCardDescription}>Descrição indisponível no momento.</Text>}
          <Pressable onPress={onOpenDetail} hitSlop={6} style={styles.deckCardDetailsBtn}>
            <Text style={styles.deckCardDetailsLabel}>Ver tudo</Text>
            <Icon name="chevronRight" size={12} color={colors.paper} />
          </Pressable>
        </View>
        {isTop ? (
          <>
            <Animated.View style={[styles.deckBadge, styles.deckBadgeAccept, acceptBadgeStyle]}>
              <Icon name="check" size={18} color={colors.paper} strokeWidth={2.6} />
              <Text style={styles.deckBadgeLabel}>ADICIONAR</Text>
            </Animated.View>
            <Animated.View style={[styles.deckBadge, styles.deckBadgeSkip, skipBadgeStyle]}>
              <Icon name="close" size={18} color={colors.paper} strokeWidth={2.6} />
              <Text style={styles.deckBadgeLabel}>PULAR</Text>
            </Animated.View>
          </>
        ) : null}
      </Pressable>
    </Animated.View>
  );

  const stacked = (
    <Animated.View pointerEvents={isTop ? 'auto' : 'none'} style={[styles.deckCardWrap, stackStyle]}>
      {cardInner}
    </Animated.View>
  );

  if (!isTop) return stacked;
  return <GestureDetector gesture={pan}>{stacked}</GestureDetector>;
}

function OverLimitModal({
  target,
  destinationName,
  onKeepAdding,
  onGenerate,
}: {
  target: number;
  destinationName: string;
  onKeepAdding: () => void;
  onGenerate: () => void;
}) {
  return (
    <Modal transparent animationType="fade" onRequestClose={onKeepAdding}>
      <View style={styles.limitBackdrop}>
        <View style={styles.limitCard}>
          <View style={styles.limitIcon}>
            <Icon name="info" size={22} color={colors.pine} />
          </View>
          <Text style={styles.limitTitle}>Já dá pra um bom roteiro</Text>
          <Text style={styles.limitBody}>
            Você passou do que costuma caber em {destinationName} (cerca de {target} atrações). Pode
            continuar escolhendo — o roteiro encaixa o que couber e o resto fica de fora.
          </Text>
          <Pressable
            onPress={onKeepAdding}
            style={({ pressed }) => [styles.limitPrimary, pressed && styles.pressed]}>
            <Text style={styles.limitPrimaryLabel}>Adicionar mesmo assim</Text>
          </Pressable>
          <Pressable
            onPress={onGenerate}
            style={({ pressed }) => [styles.limitGhost, pressed && styles.pressed]}>
            <Text style={styles.limitGhostLabel}>Gerar roteiro agora</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function DeckLoadingMore() {
  return (
    <View style={styles.deckEmpty}>
      <ActivityIndicator color={colors.ink} />
      <Text style={styles.deckEmptySubtitle}>Preparando mais atrações…</Text>
    </View>
  );
}

function DeckEmptyState({
  selectedCount,
  totalCount,
  onRestart,
  onReview,
}: {
  selectedCount: number;
  totalCount: number;
  onRestart: () => void;
  onReview: () => void;
}) {
  return (
    <View style={styles.deckEmpty}>
      <View style={styles.deckEmptyBadge}>
        <Icon name="check" size={28} color={colors.paper} strokeWidth={2.4} />
      </View>
      <Text style={styles.deckEmptyTitle}>
        {selectedCount > 0 ? `${selectedCount} selecionadas` : 'Nenhuma seleção'}
      </Text>
      <Text style={styles.deckEmptySubtitle}>
        Você passou pelos {totalCount} lugares sugeridos.
      </Text>
      <View style={styles.deckEmptyActions}>
        <Pressable onPress={onReview} style={({ pressed }) => [styles.deckEmptyButton, pressed && styles.pressed]}>
          <Icon name="list" size={14} color={colors.ink} />
          <Text style={styles.deckEmptyButtonLabel}>Ver seleção</Text>
        </Pressable>
        <Pressable onPress={onRestart} style={({ pressed }) => [styles.deckEmptyButton, pressed && styles.pressed]}>
          <Icon name="refresh" size={14} color={colors.ink} />
          <Text style={styles.deckEmptyButtonLabel}>Recomeçar</Text>
        </Pressable>
      </View>
    </View>
  );
}

function SelectionSheet({
  selected,
  pending,
  destinationName,
  onToggle,
  onOpenDetail,
  onClose,
}: {
  selected: EnrichedPlace[];
  pending: EnrichedPlace[];
  destinationName: string;
  onToggle: (placeId: string) => void;
  onOpenDetail: (place: EnrichedPlace) => void;
  onClose: () => void;
}) {
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <Pressable onPress={onClose} style={StyleSheet.absoluteFill} accessibilityLabel="Fechar" />
        <View style={styles.selectionSheet}>
          <View style={styles.selectionHandle} />
          <View style={styles.selectionHeader}>
            <Text style={styles.selectionTitle}>Em {destinationName}</Text>
            <Pressable onPress={onClose} hitSlop={12} style={({ pressed }) => [styles.selectionClose, pressed && styles.pressed]}>
              <Icon name="close" size={18} color={colors.ink} />
            </Pressable>
          </View>
          <ScrollView
            contentContainerStyle={styles.selectionContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            scrollEventThrottle={16}>
            <Text style={styles.selectionSection}>SELECIONADAS · {selected.length}</Text>
            {selected.length === 0 ? (
              <Text style={styles.selectionHint}>Nenhuma ainda — passe o deck pela direita.</Text>
            ) : (
              selected.map((place) => (
                <SelectionRow
                  key={place.place.placeId}
                  place={place}
                  selected
                  onToggle={() => onToggle(place.place.placeId)}
                  onOpenDetail={() => onOpenDetail(place)}
                />
              ))
            )}
            <Text style={[styles.selectionSection, styles.selectionSectionGap]}>PENDENTES · {pending.length}</Text>
            {pending.length === 0 ? (
              <Text style={styles.selectionHint}>Você já decidiu sobre todas.</Text>
            ) : (
              pending.map((place) => (
                <SelectionRow
                  key={place.place.placeId}
                  place={place}
                  selected={false}
                  onToggle={() => onToggle(place.place.placeId)}
                  onOpenDetail={() => onOpenDetail(place)}
                />
              ))
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function SelectionRow({
  place,
  selected,
  onToggle,
  onOpenDetail,
}: {
  place: EnrichedPlace;
  selected: boolean;
  onToggle: () => void;
  onOpenDetail: () => void;
}) {
  const minutes = place.insight?.averageMinutes;
  return (
    <Pressable onPress={onOpenDetail} style={({ pressed }) => [styles.selectionRow, pressed && styles.pressed]}>
      <View style={styles.selectionMedia}>
        {place.photoUrl ? (
          <Image source={{ uri: place.photoUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <Icon name="map" size={18} color={colors.inkSoft} />
        )}
      </View>
      <View style={styles.selectionBody}>
        <Text numberOfLines={1} style={styles.selectionItemTitle}>
          {place.place.name}
        </Text>
        <View style={styles.selectionMetaRow}>
          {place.place.rating ? (
            <View style={styles.selectionMetaItem}>
              <Icon name="starFilled" size={10} color={colors.star} />
              <Text style={styles.selectionMeta}>{place.place.rating.toFixed(1)}</Text>
            </View>
          ) : null}
          {minutes ? (
            <View style={styles.selectionMetaItem}>
              <Icon name="clock" size={10} color={colors.inkMuted} />
              <Text style={styles.selectionMeta}>{formatVisitDuration(minutes)}</Text>
            </View>
          ) : null}
        </View>
      </View>
      <Pressable
        onPress={onToggle}
        hitSlop={8}
        style={({ pressed }) => [styles.selectionToggle, selected && styles.selectionToggleOn, pressed && styles.pressed]}>
        {selected ? <Icon name="check" size={14} color={colors.paper} strokeWidth={2.4} /> : null}
      </Pressable>
    </Pressable>
  );
}

function DetailSheet({ place, onClose }: { place: EnrichedPlace; onClose: () => void }) {
  const typeLabel = formatPlaceType(place.place.primaryType ?? place.place.types?.[0]);
  const minutes = place.insight?.averageMinutes;
  const cost = place.insight?.averageCost;
  const visitWindow = formatRecommendedVisitWindow(place.insight);
  const seasonality = formatSeasonality(place.insight);
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={styles.sheetBackdrop}>
        <Pressable onPress={(event) => event.stopPropagation()} style={styles.sheetCard}>
          {place.photoUrl ? (
            <Image source={{ uri: place.photoUrl }} style={styles.sheetImage} contentFit="cover" />
          ) : null}
          <View style={styles.sheetBody}>
            {typeLabel ? <Text style={styles.sheetEyebrow}>{typeLabel.toUpperCase()}</Text> : null}
            <Text style={styles.sheetTitle}>{place.place.name}</Text>
            <View style={styles.sheetMetaRow}>
              {place.place.rating ? (
                <View style={styles.sheetMetaItem}>
                  <Icon name="starFilled" size={13} color={colors.star} />
                  <Text style={styles.sheetMetaText}>
                    {place.place.rating.toFixed(1)}
                    {place.place.userRatingCount ? ` · ${place.place.userRatingCount.toLocaleString('pt-BR')}` : ''}
                  </Text>
                </View>
              ) : null}
              {minutes ? (
                <View style={styles.sheetMetaItem}>
                  <Icon name="clock" size={13} color={colors.inkMuted} />
                  <Text style={styles.sheetMetaText}>{formatVisitDuration(minutes)}</Text>
                </View>
              ) : null}
              {cost && cost.value > 0 ? (
                <View style={styles.sheetMetaItem}>
                  <Text style={styles.sheetMetaText}>
                    ~{cost.value} {cost.currency}
                  </Text>
                </View>
              ) : null}
            </View>
            {place.place.formattedAddress ? (
              <View style={styles.sheetAddress}>
                <Icon name="pin" size={13} color={colors.inkMuted} />
                <Text style={styles.sheetAddressText}>{place.place.formattedAddress}</Text>
              </View>
            ) : null}
            {visitWindow ? (
              <View style={styles.sheetAddress}>
                <Icon name="clock" size={13} color={colors.pine} />
                <Text style={styles.sheetAddressText}>{visitWindow}</Text>
              </View>
            ) : null}
            {seasonality ? (
              <View style={styles.sheetAddress}>
                <Icon name="calendar" size={13} color={colors.pine} />
                <Text style={styles.sheetAddressText}>{seasonality}</Text>
              </View>
            ) : null}
            {place.insight?.description ? (
              <Text style={styles.sheetDescription}>{place.insight.description}</Text>
            ) : null}
            <PrimaryButton label="Fechar" variant="outline" onPress={onClose} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, gap: 12, paddingHorizontal: 20 },
  chipsScrollWrap: { height: 38, marginHorizontal: -20 },
  chipsRow: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
  },
  chip: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    height: 32,
    maxWidth: 220,
    paddingHorizontal: 12,
  },
  chipDot: { borderRadius: 999, height: 10, width: 10 },
  chipDotActive: { backgroundColor: 'rgba(255,255,255,0.85)' },
  chipLabel: {
    color: colors.ink,
    fontFamily: fontFamily.semibold,
    fontSize: 13,
  },
  chipLabelActive: { color: colors.paper },
  chipCount: {
    color: colors.inkSoft,
    fontFamily: fontFamily.bold,
    fontSize: 11,
  },
  chipCountActive: { color: colors.paper },
  headerRow: { alignItems: 'center', flexDirection: 'row', gap: 10, justifyContent: 'space-between' },
  budgetBar: { gap: 6 },
  budgetBarRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  budgetBarLabel: {
    color: colors.inkMuted,
    fontFamily: fontFamily.medium,
    fontSize: 12,
  },
  budgetBarPercent: {
    fontFamily: fontFamily.bold,
    fontSize: 13,
    letterSpacing: -0.2,
  },
  budgetBarTrack: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.pill,
    height: 6,
    overflow: 'hidden',
  },
  budgetBarFill: { borderRadius: radius.pill, height: '100%' },
  recommendation: {
    color: colors.inkMuted,
    flex: 1,
    fontFamily: fontFamily.medium,
    fontSize: 13,
    lineHeight: 17,
  },
  headerIconButton: {
    alignItems: 'center',
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 999,
    borderWidth: 1,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  selectionButton: {
    alignItems: 'center',
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  selectionButtonLabel: {
    color: colors.ink,
    fontFamily: fontFamily.bold,
    fontSize: 13,
  },
  pressed: { opacity: 0.85 },
  loadingBlock: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  limitBackdrop: {
    alignItems: 'center',
    backgroundColor: colors.scrim,
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  limitCard: {
    backgroundColor: colors.paper,
    borderRadius: radius.lg,
    gap: 10,
    padding: 24,
    width: '100%',
  },
  limitIcon: {
    alignItems: 'center',
    backgroundColor: colors.pineSoft,
    borderRadius: 999,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  limitTitle: {
    color: colors.ink,
    fontFamily: fontFamily.bold,
    fontSize: 19,
    letterSpacing: -0.3,
    marginTop: 4,
  },
  limitBody: {
    color: colors.inkMuted,
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
  },
  limitPrimary: {
    alignItems: 'center',
    backgroundColor: colors.pine,
    borderRadius: radius.pill,
    marginTop: 8,
    paddingVertical: 14,
  },
  limitPrimaryLabel: {
    color: colors.paper,
    fontFamily: fontFamily.semibold,
    fontSize: 15,
  },
  limitGhost: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  limitGhostLabel: {
    color: colors.inkMuted,
    fontFamily: fontFamily.semibold,
    fontSize: 14,
  },
  error: {
    color: colors.amber,
    fontFamily: fontFamily.medium,
    fontSize: 13,
    textAlign: 'center',
  },
  deckArea: { flex: 1 },
  deckColumn: { flex: 1, gap: 14 },
  deckStage: { flex: 1, position: 'relative' },
  deckCardWrap: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
  deckCard: {
    backgroundColor: colors.ink,
    borderRadius: radius.lg,
    flex: 1,
    overflow: 'hidden',
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    elevation: 6,
  },
  deckCardPressable: { flex: 1 },
  deckCardFallback: { alignItems: 'center', backgroundColor: colors.surfaceMuted, justifyContent: 'center' },
  deckCardContent: { bottom: 0, gap: 8, left: 0, padding: 20, position: 'absolute', right: 0 },
  deckCardType: {
    color: 'rgba(255,255,255,0.75)',
    fontFamily: fontFamily.semibold,
    fontSize: 11,
    letterSpacing: 0.6,
  },
  deckCardTitle: {
    color: colors.paper,
    fontFamily: fontFamily.bold,
    fontSize: 26,
    letterSpacing: -0.6,
    lineHeight: 30,
  },
  deckCardChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  deckCardChip: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  deckCardChipText: {
    color: colors.paper,
    fontFamily: fontFamily.semibold,
    fontSize: 11,
  },
  deckCardDescription: {
    color: 'rgba(255,255,255,0.92)',
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  deckCardDetailsBtn: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 4,
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  deckCardDetailsLabel: {
    color: colors.paper,
    fontFamily: fontFamily.semibold,
    fontSize: 11,
  },
  deckBadge: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 3,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    position: 'absolute',
    top: 32,
  },
  deckBadgeAccept: {
    borderColor: colors.pine,
    backgroundColor: colors.pine,
    left: 24,
    transform: [{ rotate: '-12deg' }],
  },
  deckBadgeSkip: {
    borderColor: colors.ink,
    backgroundColor: colors.scrimStrong,
    right: 24,
    transform: [{ rotate: '12deg' }],
  },
  deckBadgeLabel: {
    color: colors.paper,
    fontFamily: fontFamily.bold,
    fontSize: 13,
    letterSpacing: 0.8,
  },
  deckActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 18,
    justifyContent: 'center',
    paddingTop: 4,
  },
  deckActionBtn: {
    alignItems: 'center',
    borderRadius: 999,
    height: 56,
    justifyContent: 'center',
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 5,
    width: 56,
  },
  deckActionSkip: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderWidth: 1,
  },
  deckActionAccept: { backgroundColor: colors.pine },
  deckCounterInline: {
    alignItems: 'center',
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  deckCounterInlineLabel: {
    color: colors.inkSoft,
    fontFamily: fontFamily.medium,
    fontSize: 9,
    letterSpacing: 0.4,
    marginTop: -2,
    textTransform: 'uppercase',
  },
  deckCounterInlineText: {
    color: colors.ink,
    fontFamily: fontFamily.bold,
    fontSize: 13,
  },
  deckCounterInlineSoft: {
    color: colors.inkSoft,
    fontFamily: fontFamily.medium,
  },
  deckEmpty: { alignItems: 'center', flex: 1, gap: 12, justifyContent: 'center', padding: 24 },
  deckEmptyBadge: {
    alignItems: 'center',
    backgroundColor: colors.pine,
    borderRadius: 999,
    height: 64,
    justifyContent: 'center',
    width: 64,
  },
  deckEmptyTitle: {
    color: colors.ink,
    fontFamily: fontFamily.bold,
    fontSize: 22,
    textAlign: 'center',
  },
  deckEmptySubtitle: {
    color: colors.inkMuted,
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 18,
    maxWidth: 260,
    textAlign: 'center',
  },
  deckEmptyActions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  deckEmptyButton: {
    alignItems: 'center',
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  deckEmptyButtonLabel: {
    color: colors.ink,
    fontFamily: fontFamily.semibold,
    fontSize: 13,
  },
  footer: { paddingTop: 4 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  emptyText: {
    color: colors.inkSoft,
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  sheetBackdrop: {
    backgroundColor: colors.scrim,
    flex: 1,
    justifyContent: 'flex-end',
  },
  confirmBackdrop: {
    alignItems: 'center',
    backgroundColor: colors.scrim,
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  confirmCard: {
    backgroundColor: colors.paper,
    borderRadius: radius.lg,
    gap: 14,
    maxWidth: 380,
    padding: 24,
    width: '100%',
  },
  confirmTitle: {
    color: colors.ink,
    fontFamily: fontFamily.bold,
    fontSize: 20,
    letterSpacing: -0.3,
    lineHeight: 26,
  },
  confirmBody: {
    color: colors.inkMuted,
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
  },
  confirmActions: { flexDirection: 'row', gap: 10, marginTop: 6 },
  confirmActionSecondary: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderRadius: 999,
    flex: 1,
    paddingVertical: 12,
  },
  confirmActionSecondaryLabel: {
    color: colors.ink,
    fontFamily: fontFamily.semibold,
    fontSize: 13,
  },
  confirmActionPrimary: {
    alignItems: 'center',
    backgroundColor: colors.pine,
    borderRadius: 999,
    flex: 1,
    paddingVertical: 12,
  },
  confirmActionPrimaryLabel: {
    color: colors.paper,
    fontFamily: fontFamily.semibold,
    fontSize: 13,
  },
  sheetCard: {
    backgroundColor: colors.paper,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '85%',
    overflow: 'hidden',
  },
  sheetImage: { backgroundColor: colors.surfaceMuted, height: 220, width: '100%' },
  sheetBody: { gap: 12, padding: 20 },
  sheetEyebrow: {
    color: colors.inkSoft,
    fontFamily: fontFamily.medium,
    fontSize: 11,
    letterSpacing: 0.4,
  },
  sheetTitle: {
    color: colors.ink,
    fontFamily: fontFamily.bold,
    fontSize: 22,
    letterSpacing: -0.4,
    lineHeight: 28,
  },
  sheetMetaRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  sheetMetaItem: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  sheetMetaText: {
    color: colors.inkMuted,
    fontFamily: fontFamily.medium,
    fontSize: 13,
  },
  sheetAddress: { alignItems: 'flex-start', flexDirection: 'row', gap: 6 },
  sheetAddressText: {
    color: colors.inkMuted,
    flex: 1,
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 18,
  },
  sheetDescription: {
    color: colors.ink,
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
  },
  selectionSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '88%',
    minHeight: '50%',
    paddingBottom: 12,
  },
  selectionHandle: {
    alignSelf: 'center',
    backgroundColor: colors.hairline,
    borderRadius: 999,
    height: 4,
    marginTop: 8,
    width: 36,
  },
  selectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  selectionTitle: {
    color: colors.ink,
    fontFamily: fontFamily.bold,
    fontSize: 18,
    letterSpacing: -0.3,
  },
  selectionClose: {
    alignItems: 'center',
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 999,
    borderWidth: 1,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  selectionContent: { gap: 8, paddingBottom: 24, paddingHorizontal: 20 },
  selectionSection: {
    color: colors.inkSoft,
    fontFamily: fontFamily.semibold,
    fontSize: 11,
    letterSpacing: 0.6,
  },
  selectionSectionGap: { marginTop: 16 },
  selectionHint: {
    color: colors.inkSoft,
    fontFamily: fontFamily.body,
    fontSize: 13,
    paddingVertical: 8,
  },
  selectionRow: {
    alignItems: 'center',
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    padding: 10,
  },
  selectionMedia: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.sm,
    height: 52,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 52,
  },
  selectionBody: { flex: 1, gap: 4 },
  selectionItemTitle: {
    color: colors.ink,
    fontFamily: fontFamily.semibold,
    fontSize: 14,
    lineHeight: 18,
  },
  selectionMetaRow: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  selectionMetaItem: { alignItems: 'center', flexDirection: 'row', gap: 4 },
  selectionMeta: {
    color: colors.inkMuted,
    fontFamily: fontFamily.body,
    fontSize: 11,
  },
  selectionToggle: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderRadius: 999,
    height: 26,
    justifyContent: 'center',
    width: 26,
  },
  selectionToggleOn: { backgroundColor: colors.pine },
});
