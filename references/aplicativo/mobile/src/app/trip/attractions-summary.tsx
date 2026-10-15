import { useFeatureAccess } from '@/application/feature-access-context';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import DraggableFlatList, { type RenderItemParams } from 'react-native-draggable-flatlist';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { placesService } from '@/application/places-service';
import { tripStore } from '@/application/trip-store';
import { useTripDraft } from '@/application/use-trip-store';
import type { EnrichedPlace, TripLeg } from '@/domain/types';
import { capacityForLeg } from '@/features/trip/capacity';
import { formatPlaceType } from '@/features/itinerary/labels';
import { stepNumber } from '@/features/trip/steps';
import { colors, fontFamily, radius } from '@/theme';
import { Icon } from '@/ui/Icon';
import { PrimaryButton } from '@/ui/PrimaryButton';
import { ScreenSurface } from '@/ui/Surface';
import { StepHeader } from '@/ui/StepHeader';
import { StepIntro } from '@/ui/StepIntro';

interface Row {
  key: string;
  place: EnrichedPlace;
}

export default function AttractionsSummaryScreen() {
  const { isTccPresentation } = useFeatureAccess();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const draft = useTripDraft();
  const params = useLocalSearchParams<{ legId?: string }>();
  const { step, total, stepKey } = stepNumber(draft, 'attractions');

  const leg: TripLeg | undefined = useMemo(() => {
    if (params.legId) {
      return draft.legs.find((l) => l.id === params.legId);
    }
    return draft.legs.find((l) => l.selectedCandidateIds.length > 0) ?? draft.legs[0];
  }, [params.legId, draft.legs]);

  const legIndex = leg ? draft.legs.findIndex((l) => l.id === leg.id) : -1;
  const totalLegs = draft.legs.length;
  const capacity = useMemo(() => (leg ? capacityForLeg(leg) : 0), [leg]);

  const initialRows: Row[] = useMemo(() => {
    if (!leg) return [];
    const selected = leg.candidates.filter((c) => leg.selectedCandidateIds.includes(c.place.placeId));
    const priorityOrder = draft.attractionPriority ?? [];
    const byId = new Map(selected.map((c) => [c.place.placeId, c] as const));
    const ordered: EnrichedPlace[] = [];
    for (const id of priorityOrder) {
      const candidate = byId.get(id);
      if (candidate) {
        ordered.push(candidate);
        byId.delete(id);
      }
    }
    for (const candidate of byId.values()) ordered.push(candidate);
    return ordered.map((place) => ({ key: place.place.placeId, place }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leg?.id]);

  const [rows, setRows] = useState<Row[]>(initialRows);
  const [extraPhotos, setExtraPhotos] = useState<Record<string, string>>({});
  const fetchedPhotoRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const missing = rows.filter((row) => {
      const placeId = row.place.place.placeId;
      if (row.place.photoUrl) return false;
      if (extraPhotos[placeId]) return false;
      if (fetchedPhotoRef.current.has(placeId)) return false;
      const photoName = row.place.place.photoNames?.[0];
      return Boolean(photoName);
    });
    if (missing.length === 0) return;
    const batch = missing.slice(0, 12);
    batch.forEach((row) => fetchedPhotoRef.current.add(row.place.place.placeId));
    placesService
      .fetchPhotos(
        batch.map((row) => ({
          placeId: row.place.place.placeId,
          photoName: row.place.place.photoNames![0]!,
        })),
      )
      .then((map) => {
        const filtered: Record<string, string> = {};
        for (const [k, v] of Object.entries(map)) {
          if (v) filtered[k] = v;
        }
        if (Object.keys(filtered).length > 0) {
          setExtraPhotos((prev) => ({ ...prev, ...filtered }));
        }
      })
      .catch(() => {
        // foto não é crítica
      });
  }, [rows, extraPhotos]);

  function removeRow(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }

  async function handleContinue() {
    if (!leg) return;
    const remainingIds = rows.map((r) => r.key);
    const remainingPlaces = rows.map((r) => r.place);
    await tripStore.setLegCandidates(leg.id, remainingPlaces, remainingIds);

    const allPriorityIds = [
      ...(draft.attractionPriority ?? []).filter((id) =>
        draft.legs.some((l) =>
          l.id !== leg.id && l.candidates.some((c) => c.place.placeId === id),
        ),
      ),
      ...remainingIds,
    ];
    await tripStore.setAttractionPriority(allPriorityIds);

    const nextLeg = draft.legs.find(
      (candidate, idx) => idx > legIndex && candidate.selectedCandidateIds.length > 0,
    );
    if (nextLeg) {
      router.push({ pathname: '/trip/attractions-summary', params: { legId: nextLeg.id } });
    } else {
      router.push('/trip/meals-hub');
    }
  }

  if (!leg) {
    return (
      <ScreenSurface>
        <View style={styles.empty}>
          <Text style={styles.emptyText}>Nenhum destino selecionado.</Text>
          <PrimaryButton label="Voltar" onPress={() => router.back()} />
        </View>
      </ScreenSurface>
    );
  }

  const isLastLeg = !draft.legs.some(
    (candidate, idx) => idx > legIndex && candidate.selectedCandidateIds.length > 0,
  );

  const renderItem = ({ item, drag, isActive, getIndex }: RenderItemParams<Row>) => {
    const placeIndex = getIndex() ?? 0;
    const insideCapacity = placeIndex < capacity;
    const photoUrl = item.place.photoUrl ?? extraPhotos[item.place.place.placeId];
    return (
      <Pressable
        onLongPress={drag}
        delayLongPress={180}
        style={[
          styles.row,
          !insideCapacity && styles.rowWaitlist,
          isActive && styles.rowActive,
        ]}>
        <View style={[styles.rowIndex, !insideCapacity && styles.rowIndexWaitlistBox]}>
          <Text style={[styles.rowIndexText, !insideCapacity && styles.rowIndexTextWaitlist]}>
            {placeIndex + 1}
          </Text>
        </View>
        {photoUrl ? (
          <Image
            source={{ uri: photoUrl }}
            style={[styles.rowPhoto, !insideCapacity && styles.rowPhotoWaitlist]}
            contentFit="cover"
          />
        ) : (
          <View style={[styles.rowPhoto, styles.rowPhotoEmpty, !insideCapacity && styles.rowPhotoWaitlist]}>
            <Icon name="pin" size={16} color={colors.inkMuted} />
          </View>
        )}
        <View style={styles.rowBody}>
          {item.place.place.primaryType ? (
            <Text style={styles.rowType} numberOfLines={1}>
              {formatPlaceType(item.place.place.primaryType)}
            </Text>
          ) : null}
          <Text
            style={[styles.rowName, !insideCapacity && styles.rowNameWaitlist]}
            numberOfLines={2}>
            {item.place.place.name}
          </Text>
        </View>
        <Pressable
          onPress={() => removeRow(item.key)}
          hitSlop={8}
          style={({ pressed }) => [styles.rowRemove, pressed && styles.pressed]}>
          <Icon name="close" size={14} color={colors.inkMuted} />
        </Pressable>
        <Icon name="grip" size={16} color={colors.inkSoft} />
      </Pressable>
    );
  };

  return (
    <ScreenSurface>
      <View style={styles.root}>
        <View style={styles.headerWrap}>
          <StepHeader step={step} total={total} stepKey={stepKey} onBack={() => router.back()} />
        </View>
        <View style={styles.intro}>
          <View style={styles.legBadge}>
            <View style={[styles.legBadgeDot, { backgroundColor: leg.color }]} />
            <Text style={styles.legBadgeText}>{leg.destination.name}</Text>
            {totalLegs > 1 ? (
              <Text style={styles.legBadgeProgress}>
                · {legIndex + 1} de {totalLegs}
              </Text>
            ) : null}
          </View>
          <StepIntro
            title="Priorize suas atrações"
            description={isTccPresentation ? `Arraste as favoritas para cima. Estimativa: ${capacity} atrações.` : `Arraste para reordenar. Cabem cerca de ${capacity} no roteiro de ${leg.destination.name}.`}
          />
        </View>

        <View style={styles.listWrap}>
          <DraggableFlatList<Row>
            data={rows}
            keyExtractor={(item) => item.key}
            renderItem={renderItem}
            onDragEnd={({ data }) => setRows(data)}
            contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 120, paddingTop: 8 }}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyText}>Nenhuma atração selecionada.</Text>
              </View>
            }
            renderPlaceholder={() => <View style={styles.placeholder} />}
            CellRendererComponent={({ children, item, ...rest }) => {
              const index = rows.findIndex((r) => r.key === item.key);
              const showCutoff = rows.length > capacity && index === capacity - 1;
              return (
                <View {...rest} style={[rest.style, styles.cell]}>
                  {children}
                  {showCutoff ? (
                    <View style={styles.cutoffBanner}>
                      <View style={styles.cutoffIconWrap}>
                        <Icon name="info" size={14} color={colors.amber} />
                      </View>
                      <View style={styles.cutoffTexts}>
                        <Text style={styles.cutoffTitle}>Podem não caber no roteiro</Text>
                        <Text style={styles.cutoffDescription}>
                          {isTccPresentation ? 'Estas entram se houver tempo. Arraste suas favoritas para cima.' : 'As atrações abaixo só entram se o solver conseguir encaixar. Arraste pra cima as que são mais importantes.'}
                        </Text>
                      </View>
                    </View>
                  ) : null}
                </View>
              );
            }}
          />
        </View>

        <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
          <PrimaryButton
            label={isLastLeg ? 'Continuar para refeições' : 'Próxima cidade'}
            onPress={handleContinue}
            trailingIcon="next"
          />
        </View>
      </View>
    </ScreenSurface>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerWrap: { paddingHorizontal: 20 },
  intro: { gap: 8, paddingHorizontal: 20, paddingTop: 16 },
  legBadge: {
    alignItems: 'center', alignSelf: 'flex-start', backgroundColor: colors.paper,
    borderColor: colors.hairline, borderRadius: radius.pill, borderWidth: 1,
    flexDirection: 'row', gap: 6, paddingHorizontal: 10, paddingVertical: 5,
  },
  legBadgeDot: { borderRadius: 4, height: 8, width: 8 },
  legBadgeText: { color: colors.ink, fontFamily: fontFamily.semibold, fontSize: 12 },
  legBadgeProgress: { color: colors.inkSoft, fontFamily: fontFamily.medium, fontSize: 11 },
  listWrap: { flex: 1, marginTop: 16 },
  row: {
    alignItems: 'center', backgroundColor: colors.paper, borderColor: colors.hairline,
    borderRadius: radius.md, borderWidth: 1, flexDirection: 'row', gap: 10, padding: 10,
  },
  rowActive: {
    borderColor: colors.pine,
    shadowColor: colors.ink, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18,
    shadowRadius: 8, elevation: 4,
  },
  rowWaitlist: {
    backgroundColor: colors.surfaceMuted, borderColor: colors.hairline, borderStyle: 'dashed',
    opacity: 0.85,
  },
  rowIndex: {
    alignItems: 'center', backgroundColor: colors.pine, borderRadius: 14, height: 28,
    justifyContent: 'center', width: 28,
  },
  rowIndexWaitlistBox: { backgroundColor: colors.surfaceMuted, borderColor: colors.hairline, borderWidth: 1 },
  rowIndexText: { color: colors.paper, fontFamily: fontFamily.bold, fontSize: 13 },
  rowIndexTextWaitlist: { color: colors.inkSoft },
  rowPhoto: { backgroundColor: colors.surfaceMuted, borderRadius: radius.sm, height: 48, width: 48 },
  rowPhotoEmpty: { alignItems: 'center', justifyContent: 'center' },
  rowPhotoWaitlist: { opacity: 0.6 },
  rowBody: { flex: 1, gap: 2 },
  rowType: { color: colors.inkSoft, fontFamily: fontFamily.medium, fontSize: 11, letterSpacing: 0.3, textTransform: 'uppercase' },
  rowName: { color: colors.ink, fontFamily: fontFamily.semibold, fontSize: 14, lineHeight: 18 },
  rowNameWaitlist: { color: colors.inkMuted },
  rowRemove: {
    alignItems: 'center', backgroundColor: colors.surfaceMuted, borderRadius: 14, height: 28,
    justifyContent: 'center', width: 28,
  },
  pressed: { opacity: 0.7 },
  separator: { height: 8 },
  placeholder: { backgroundColor: colors.surfaceMuted, borderRadius: radius.md, height: 76 },
  cell: { flexDirection: 'column' },
  cutoffBanner: {
    alignItems: 'flex-start', backgroundColor: colors.amberSoft, borderColor: colors.amber,
    borderRadius: radius.md, borderWidth: 1, flexDirection: 'row', gap: 10,
    marginVertical: 14, padding: 12,
  },
  cutoffIconWrap: {
    alignItems: 'center', backgroundColor: colors.paper, borderRadius: 12,
    height: 24, justifyContent: 'center', width: 24,
  },
  cutoffTexts: { flex: 1, gap: 2 },
  cutoffTitle: { color: colors.amberInk, fontFamily: fontFamily.bold, fontSize: 13, letterSpacing: 0.1 },
  cutoffDescription: { color: colors.amberInk, fontFamily: fontFamily.body, fontSize: 12, lineHeight: 16, opacity: 0.85 },
  empty: { alignItems: 'center', flex: 1, gap: 16, justifyContent: 'center', padding: 24 },
  emptyText: { color: colors.inkSoft, fontFamily: fontFamily.body, fontSize: 14 },
  footer: {
    backgroundColor: colors.surface, borderTopColor: colors.hairline, borderTopWidth: 1,
    paddingHorizontal: 20, paddingTop: 12,
  },
});
