import { useFeatureAccess } from '@/application/feature-access-context';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import DraggableFlatList, { type RenderItemParams } from 'react-native-draggable-flatlist';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { placesService } from '@/application/places-service';
import { tripStore } from '@/application/trip-store';
import { useTripDraft } from '@/application/use-trip-store';
import { stepNumber } from '@/features/trip/steps';
import { MAX_LEGS, type AutocompleteSuggestion, type TripLeg } from '@/domain/types';
import { describeApiError } from '@/infrastructure/api-client';
import { colors, fontFamily, radius } from '@/theme';
import { Icon } from '@/ui/Icon';
import { PrimaryButton } from '@/ui/PrimaryButton';
import { ScreenSurface } from '@/ui/Surface';
import { StepHeader } from '@/ui/StepHeader';
import { StepIntro } from '@/ui/StepIntro';
import { PlaceAutocomplete } from '@/features/places/PlaceAutocomplete';

export default function DestinationScreen() {
  const { isTccPresentation } = useFeatureAccess();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const draft = useTripDraft();
  const legs = draft.legs;

  const [pickerOpen, setPickerOpen] = useState(false);
  // Nome do destino sendo carregado (após o usuário escolher no autocomplete).
  // Fecha o sheet na hora e mostra uma linha-esqueleto na lista enquanto os
  // detalhes chegam, em vez de um segundo loading dentro do popup já fechado.
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [footerHeight, setFooterHeight] = useState(0);

  const canContinue = legs.length >= 1;

  async function handleSelect(suggestion: AutocompleteSuggestion) {
    if (legs.length >= MAX_LEGS) return;
    if (suggestion.types?.includes('country')) {
      setPickerOpen(false);
      setError(null);
      router.push({
        pathname: '/trip/country-cities',
        params: { placeId: suggestion.placeId, country: suggestion.primaryText },
      });
      return;
    }
    if (legs.some((leg) => leg.destination.placeId === suggestion.placeId)) {
      setError(`${suggestion.primaryText} já está na sua lista de destinos.`);
      return;
    }
    setPickerOpen(false);
    setAdding(suggestion.primaryText);
    setError(null);
    try {
      const details = await placesService.details(suggestion.placeId, 'location');
      await tripStore.addLeg(details);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setAdding(null);
    }
  }

  function handleRemove(legId: string) {
    void tripStore.removeLeg(legId);
  }

  async function handleReorder(next: TripLeg[]) {
    await tripStore.reorderLegs(next.map((leg) => leg.id));
  }

  function handleContinue() {
    if (!canContinue) return;
    router.push('/trip/dates');
  }

  return (
    <ScreenSurface>
      <View style={styles.headerWrap}>
        <StepHeader {...stepNumber(draft, 'destination')} label="Destinos" onBack={() => router.back()} />
      </View>

      <View style={styles.body}>
        <StepIntro
          title={isTccPresentation ? 'Para onde vamos?' : 'Para onde será a sua próxima viagem?'}
          description={isTccPresentation ? 'Escolha os destinos da sua viagem.' : 'Um destino, ou vários para uma rota multi-cidade.'}
        />

        {legs.length === 0 ? (
          <Pressable
            onPress={() => setPickerOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Buscar destino"
            style={({ pressed }) => [styles.emptyCard, pressed && styles.pressed]}>
            {!isTccPresentation ? <View style={styles.emptyTop}>
              <View style={styles.emptyIcon}>
                <Icon name="map" size={23} color={colors.pine} strokeWidth={1.7} />
              </View>
              <Text style={styles.emptyKicker}>COMECE AQUI</Text>
            </View> : null}
            <Text style={styles.emptyTitle}>{isTccPresentation ? 'Seu primeiro destino' : 'Escolha a primeira parada'}</Text>
            {!isTccPresentation ? <Text style={styles.emptyHint}>Busque uma cidade ou um país. Depois, se quiser, conecte outros destinos à mesma rota.</Text> : null}
            <View style={styles.emptyAction}>
              <Text style={styles.emptyActionLabel}>Buscar destino</Text>
              <Icon name="next" size={17} color={colors.paper} strokeWidth={2} />
            </View>
          </Pressable>
        ) : (
          <DraggableFlatList
            data={legs}
            keyExtractor={(item) => item.id}
            onDragEnd={({ data }) => handleReorder(data)}
            contentContainerStyle={[styles.list, { paddingBottom: footerHeight + 16 }]}
            renderItem={({ item, drag, isActive, getIndex }: RenderItemParams<TripLeg>) => (
              <LegRow
                leg={item}
                index={(getIndex?.() ?? 0) + 1}
                onLongPress={drag}
                onRemove={() => handleRemove(item.id)}
                active={isActive}
              />
            )}
            ListFooterComponent={() => (
              <>
                {adding ? <AddingRow name={adding} /> : null}
                {legs.length < MAX_LEGS ? (
                  <AddButton onPress={() => setPickerOpen(true)} />
                ) : (
                  <Text style={styles.maxNote}>Máximo de {MAX_LEGS} destinos.</Text>
                )}
              </>
            )}
          />
        )}

        {legs.length === 0 && adding ? <AddingRow name={adding} /> : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>

      <View
        style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}
        onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}>
        <PrimaryButton
          label="Continuar"
          disabled={!canContinue}
          onPress={handleContinue}
          trailingIcon="next"
        />
      </View>

      <Modal visible={pickerOpen} animationType="slide" transparent onRequestClose={() => setPickerOpen(false)}>
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPickerOpen(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Adicionar destino</Text>
              <Pressable onPress={() => setPickerOpen(false)} hitSlop={12}>
                <Icon name="close" size={20} color={colors.ink} />
              </Pressable>
            </View>
            <PlaceAutocomplete
              placeholder="Buscar cidade ou país"
              onSelect={(suggestion) => {
                void handleSelect(suggestion);
              }}
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </ScreenSurface>
  );
}

function AddButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Adicionar destino"
      style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}>
      <View style={styles.addIcon}>
        <Icon name="plus" size={18} color={colors.ink} strokeWidth={2.2} />
      </View>
      <Text style={styles.addLabel}>Adicionar destino</Text>
    </Pressable>
  );
}

function AddingRow({ name }: { name: string }) {
  return (
    <View style={[styles.legRow, styles.addingRow]}>
      <View style={[styles.legColor, styles.addingColor]}>
        <ActivityIndicator color={colors.pine} size="small" />
      </View>
      <View style={styles.legBody}>
        <Text style={styles.legName} numberOfLines={1}>{name}</Text>
        <Text style={styles.legAddress}>Carregando destino…</Text>
      </View>
    </View>
  );
}

interface LegRowProps {
  leg: TripLeg;
  index: number;
  active: boolean;
  onLongPress: () => void;
  onRemove: () => void;
}

function LegRow({ leg, index, active, onLongPress, onRemove }: LegRowProps) {
  return (
    <View style={[styles.legRow, active && styles.legRowActive]}>
      <View style={[styles.legColor, { backgroundColor: leg.color }]}>
        <Text style={styles.legColorNumber}>{index}</Text>
      </View>
      <View style={styles.legBody}>
        <Text style={styles.legName} numberOfLines={1}>
          {leg.destination.name}
        </Text>
        {leg.destination.formattedAddress ? (
          <Text style={styles.legAddress} numberOfLines={1}>
            {leg.destination.formattedAddress}
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={onRemove}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Remover destino"
        style={({ pressed }) => [styles.removeBtn, pressed && styles.pressed]}>
        <Icon name="close" size={16} color={colors.inkSoft} />
      </Pressable>
      {/* Drag só pelo handle: o long-press na linha inteira brigava com o
          scroll vertical da lista. */}
      <Pressable
        onLongPress={onLongPress}
        delayLongPress={140}
        hitSlop={10}
        style={({ pressed }) => [styles.dragHandle, pressed && styles.pressed]}>
        <Icon name="grip" size={18} color={active ? colors.pine : colors.inkSoft} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  headerWrap: { paddingHorizontal: 20 },
  body: { flex: 1, gap: 16, paddingHorizontal: 20, paddingTop: 12 },
  list: { gap: 8, paddingTop: 8 },
  legRow: {
    alignItems: 'center',
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    marginBottom: 8,
    padding: 12,
  },
  legRowActive: {
    borderColor: colors.pine,
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.16,
    shadowRadius: 14,
    elevation: 4,
  },
  legColor: {
    alignItems: 'center',
    borderRadius: 10,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  addingRow: { opacity: 0.9 },
  addingColor: { backgroundColor: colors.pineSoft },
  legColorNumber: {
    color: colors.paper,
    fontFamily: fontFamily.bold,
    fontSize: 15,
  },
  legBody: { flex: 1, gap: 2 },
  legName: {
    color: colors.ink,
    fontFamily: fontFamily.semibold,
    fontSize: 15,
    lineHeight: 20,
  },
  legAddress: {
    color: colors.inkSoft,
    fontFamily: fontFamily.body,
    fontSize: 12,
    lineHeight: 16,
  },
  removeBtn: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderRadius: 999,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  pressed: { opacity: 0.85 },
  dragHandle: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: 32,
  },
  addButton: {
    alignItems: 'center',
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radius.md,
    borderStyle: 'dashed',
    borderWidth: 1.5,
    flexDirection: 'row',
    gap: 10,
    padding: 14,
  },
  addIcon: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderRadius: 999,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  addLabel: {
    color: colors.ink,
    fontFamily: fontFamily.semibold,
    fontSize: 15,
  },
  maxNote: {
    color: colors.inkSoft,
    fontFamily: fontFamily.body,
    fontSize: 12,
    paddingHorizontal: 4,
    paddingVertical: 8,
    textAlign: 'center',
  },
  emptyCard: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: 9,
    padding: 20,
  },
  emptyTop: { alignItems: 'center', flexDirection: 'row', gap: 9 },
  emptyIcon: {
    alignItems: 'center',
    backgroundColor: colors.pineSoft,
    borderRadius: 10,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  emptyKicker: { color: colors.pine, fontFamily: fontFamily.bold, fontSize: 10, letterSpacing: 1.6 },
  emptyTitle: {
    color: colors.ink,
    fontFamily: fontFamily.display,
    fontSize: 23,
    letterSpacing: -0.5,
    marginTop: 3,
  },
  emptyHint: {
    color: colors.inkMuted,
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 19,
  },
  emptyAction: {
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: colors.pine,
    borderRadius: radius.md,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  emptyActionLabel: { color: colors.paper, fontFamily: fontFamily.semibold, fontSize: 14 },
  footer: { paddingHorizontal: 20, paddingTop: 12 },
  modalBackdrop: {
    backgroundColor: colors.scrim,
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    gap: 16,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  sheetHandle: {
    alignSelf: 'center',
    backgroundColor: colors.hairline,
    borderRadius: 999,
    height: 4,
    width: 36,
  },
  sheetHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sheetTitle: {
    color: colors.ink,
    fontFamily: fontFamily.bold,
    fontSize: 18,
    letterSpacing: -0.2,
  },
  error: {
    color: colors.danger,
    fontFamily: fontFamily.medium,
    fontSize: 13,
  },
});
