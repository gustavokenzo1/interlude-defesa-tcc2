import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  ScrollView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE, type Region } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { placesService } from '@/application/places-service';
import type {
  Coordinate,
  LodgingStay,
  PlaceSummary,
} from '@/domain/types';
import { colors, fontFamily, radius } from '@/theme';
import { Icon } from '@/ui/Icon';
import { CompactRouteHeader } from '@/ui/CompactRouteHeader';
import { PrimaryButton } from '@/ui/PrimaryButton';

interface Props {
  visible: boolean;
  initialStay?: LodgingStay;
  initialCenter: Coordinate;
  destinationName: string;
  legStartDate: string;
  legEndDate: string;
  minCheckIn: string;
  maxCheckOut: string;
  onCancel(): void;
  onSave(stay: LodgingStay): void;
}

function todayPlus0() {
  return new Date();
}

function formatBr(iso: string): string {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return iso;
  return `${match[3]}/${match[2]}`;
}

function addDaysIso(iso: string, amount: number): string {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return iso;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setDate(date.getDate() + amount);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function compareIso(a: string, b: string): number {
  return a.localeCompare(b);
}

const MONTH_NAMES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

export function LodgingMapPicker({
  visible,
  initialStay,
  initialCenter,
  destinationName,
  legStartDate,
  legEndDate,
  minCheckIn,
  maxCheckOut,
  onCancel,
  onSave,
}: Props) {
  const insets = useSafeAreaInsets();
  const mapRef = useRef<MapView | null>(null);

  const [stage, setStage] = useState<'location' | 'details'>(initialStay ? 'details' : 'location');
  const [suggestionsHeight, setSuggestionsHeight] = useState(260);
  const [locationChosen, setLocationChosen] = useState(!!initialStay);
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<PlaceSummary[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [coordinate, setCoordinate] = useState<Coordinate>(
    initialStay?.coordinate ?? initialCenter,
  );
  const [name, setName] = useState<string>(initialStay?.name ?? '');
  const [placeId, setPlaceId] = useState<string | undefined>(initialStay?.placeId);
  const [address, setAddress] = useState<string | undefined>(initialStay?.formattedAddress);
  const [checkInDate, setCheckInDate] = useState<string>(initialStay?.checkInDate ?? minCheckIn);
  const [checkOutDate, setCheckOutDate] = useState<string>(
    initialStay?.checkOutDate ?? maxCheckOut,
  );
  const [checkInTime, setCheckInTime] = useState<string>(initialStay?.checkInTime ?? '14:00');
  const [checkOutTime, setCheckOutTime] = useState<string>(initialStay?.checkOutTime ?? '12:00');
  const [error, setError] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Quando o usuário escolhe uma sugestão, escrevemos o nome no input. Isso
  // dispararia uma nova busca que reexibe o próprio local; esta flag pula a
  // próxima rodada do efeito.
  const skipNextSearchRef = useRef(false);
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  useEffect(() => {
    if (skipNextSearchRef.current) {
      skipNextSearchRef.current = false;
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    let active = true;
    if (query.trim().length < 2 || stage !== 'location') {
      setLoadingSuggestions(false);
      setSuggestions([]);
      return;
    }
    setLoadingSuggestions(true);
    debounceRef.current = setTimeout(async () => {
      try {
        // textSearch com nome do destino na query + raio força a busca a ficar
        // local. Mais firme que autocomplete pra marcas globais (Novotel,
        // Hilton) que retornam matches do mundo todo.
        const items = await placesService.textSearch({
          query: `${query} ${destinationName}`,
          location: coordinate,
          radiusMeters: 25_000,
          maxResultCount: 8,
        });
        if (active) setSuggestions(items);
      } catch {
        if (active) setSuggestions([]);
      } finally {
        if (active) setLoadingSuggestions(false);
      }
    }, 300);
    return () => { active = false; if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, destinationName, coordinate, stage]);

  function pickSuggestion(place: PlaceSummary) {
    setLocationChosen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    skipNextSearchRef.current = true;
    setCoordinate(place.coordinate);
    setName(place.name);
    setPlaceId(place.placeId);
    setAddress(place.formattedAddress);
    setQuery(place.name);
    setSuggestions([]);
    setLoadingSuggestions(false);
    Keyboard.dismiss();
    mapRef.current?.animateToRegion(
      {
        latitude: place.coordinate.latitude,
        longitude: place.coordinate.longitude,
        latitudeDelta: 0.025,
        longitudeDelta: 0.025,
      },
      300,
    );
  }

  function validate(): string | null {
    if (!name.trim()) return 'Dê um nome para a hospedagem.';
    if (compareIso(checkInDate, minCheckIn) < 0) {
      return `Check-in não pode ser antes de ${formatBr(minCheckIn)}.`;
    }
    if (compareIso(checkOutDate, maxCheckOut) > 0) {
      return `Check-out não pode ser depois de ${formatBr(maxCheckOut)}.`;
    }
    if (compareIso(checkInDate, checkOutDate) >= 0) {
      return 'Check-out deve ser depois do check-in.';
    }
    if (!isValidHhmm(checkInTime) || !isValidHhmm(checkOutTime)) {
      return 'Horário inválido. Use o formato HH:MM.';
    }
    return null;
  }

  function handleSave() {
    const message = validate();
    if (message) {
      setError(message);
      return;
    }
    const stay: LodgingStay = {
      id: initialStay?.id ?? `lodging-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      placeId,
      name: name.trim(),
      coordinate,
      formattedAddress: address,
      checkInDate,
      checkOutDate,
      checkInTime,
      checkOutTime,
    };
    onSave(stay);
  }

  const initialRegion: Region = useMemo(
    () => ({
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
      latitudeDelta: 0.05,
      longitudeDelta: 0.05,
    }),
    // só na primeira render
    [coordinate],
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.root, { paddingTop: insets.top + 8 }]}>
        <CompactRouteHeader
          eyebrow="ONDE FICAR"
          title={stage === 'location' ? "Escolha sua hospedagem" : "Dados da hospedagem"}
          onBack={stage === 'details' ? () => { Keyboard.dismiss(); setStage('location'); } : onCancel}
          backIcon={stage === 'details' ? "back" : "close"}
        />

        {stage === 'location' ? <>
        <View style={styles.mapWrap} onLayout={event => setSuggestionsHeight(Math.max(0, Math.min(260, event.nativeEvent.layout.height - 90)))}>
          <MapView
            ref={mapRef}
            style={StyleSheet.absoluteFill}
            provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
            initialRegion={initialRegion}
            onPress={(event) => {
              const coord = event.nativeEvent.coordinate;
              setCoordinate(coord); setLocationChosen(true); setPlaceId(undefined); setAddress(undefined); setName('');
            }}>
            <Marker
              coordinate={coordinate}
              draggable
              onDragEnd={(event) => { setCoordinate(event.nativeEvent.coordinate); setLocationChosen(true); setPlaceId(undefined); setAddress(undefined); setName(''); }}
              pinColor={colors.pine}
            />
          </MapView>

          <View style={[styles.searchFloating, { top: 16 }]}>
            <View style={styles.searchInputBox}>
              <Icon name="search" size={18} color={colors.pine} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Buscar hotel, bairro ou endereço"
                placeholderTextColor={colors.inkMuted}
                style={styles.searchInput}
                autoCorrect={false}
                autoCapitalize="words"
              />
              {loadingSuggestions ? (
                <ActivityIndicator color={colors.pine} />
              ) : query.length > 0 ? (
                <Pressable hitSlop={8} onPress={() => { setQuery(''); setSuggestions([]); }}>
                  <Icon name="close" size={16} color={colors.inkMuted} />
                </Pressable>
              ) : null}
            </View>
            {suggestions.length > 0 ? (
              <ScrollView style={[styles.suggestions, { maxHeight: suggestionsHeight }]} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                {suggestions.slice(0, 5).map((place) => (
                  <Pressable
                    key={place.placeId}
                    onPress={() => pickSuggestion(place)}
                    accessibilityRole="button"
                    accessibilityLabel={place.name}
                    style={({ pressed }) => [styles.suggestionRow, pressed && styles.pressed]}>
                    <Icon name="pin" size={14} color={colors.ink} />
                    <View style={styles.suggestionBody}>
                      <Text style={styles.suggestionPrimary} numberOfLines={1}>
                        {place.name}
                      </Text>
                      {place.formattedAddress ? (
                        <Text style={styles.suggestionSecondary} numberOfLines={1}>
                          {place.formattedAddress}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}
          </View>
        </View>

        <View style={[styles.form, { paddingBottom: insets.bottom + 16 }]}>
          <Text style={styles.formLabel}>{locationChosen ? name || 'Ponto selecionado no mapa' : 'Busque uma hospedagem ou toque no mapa'}</Text>
          {address ? <Text style={styles.formAddress} numberOfLines={2}>{address}</Text> : null}
          <PrimaryButton label="Confirmar localização" disabled={!locationChosen || loadingSuggestions} onPress={() => { Keyboard.dismiss(); setSuggestions([]); setStage('details'); }} />
        </View>
        </> : <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.form, { paddingBottom: insets.bottom + 16 }]}>
          <Text style={styles.formLabel}>Nome da hospedagem</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Ex.: Airbnb Botafogo"
            placeholderTextColor={colors.inkSoft}
            style={styles.formInput}
          />
          {address ? <Text style={styles.formAddress}>{address}</Text> : null}

          <Text style={styles.sectionHint}>Datas e horários locais de check-in e check-out da hospedagem.</Text>
          <View style={styles.dateRow}>
            <View style={styles.dateColumn}>
              <DateField
                label="Check-in"
                value={checkInDate}
                minimum={minCheckIn}
                maximum={addDaysIso(checkOutDate, -1)}
                onChange={setCheckInDate}
              />
              <TimeField label="Horário de check-in" value={checkInTime} onChange={setCheckInTime} />
            </View>
            <View style={styles.dateColumn}>
              <DateField
                label="Check-out"
                value={checkOutDate}
                minimum={addDaysIso(checkInDate, 1)}
                maximum={maxCheckOut}
                onChange={setCheckOutDate}
              />
              <TimeField label="Horário de check-out" value={checkOutTime} onChange={setCheckOutTime} />
            </View>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <PrimaryButton label="Salvar hospedagem" onPress={handleSave} />
        </ScrollView>}
      </KeyboardAvoidingView>
    </Modal>
  );
}

interface TimeFieldProps {
  label: string;
  value: string;
  onChange(value: string): void;
}

function isValidHhmm(value: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const [hh, mm] = value.split(':').map(Number);
  return hh! >= 0 && hh! <= 23 && mm! >= 0 && mm! <= 59;
}

function TimeField({ label, value, onChange }: TimeFieldProps) {
  function handleChange(next: string) {
    let cleaned = next.replace(/[^\d:]/g, '');
    if (cleaned.length === 2 && !cleaned.includes(':') && value.length < cleaned.length) {
      cleaned = `${cleaned}:`;
    }
    onChange(cleaned.slice(0, 5));
  }
  return (
    <View style={styles.dateField}>
      <Text style={styles.dateLabel}>{label}</Text>
      <View style={styles.timeBox}>
        <Icon name="clock" size={14} color={colors.inkMuted} />
        <TextInput
          value={value}
          onChangeText={handleChange}
          keyboardType="number-pad"
          placeholder="14:00"
          placeholderTextColor={colors.inkSoft}
          maxLength={5}
          style={styles.timeInput}
        />
      </View>
    </View>
  );
}

interface DateFieldProps {
  label: string;
  value: string;
  minimum: string;
  maximum: string;
  onChange(value: string): void;
}

function DateField({ label, value, minimum, maximum, onChange }: DateFieldProps) {
  const [showPicker, setShowPicker] = useState(false);
  return (
    <View style={styles.dateField}>
      <Text style={styles.dateLabel}>{label}</Text>
      <Pressable
        onPress={() => setShowPicker(true)}
        style={({ pressed }) => [styles.dateButton, pressed && styles.dateButtonPressed]}>
        <Icon name="calendar" size={15} color={colors.pine} />
        <Text style={styles.dateValue}>{formatBr(value)}</Text>
        <Icon name="chevronDown" size={14} color={colors.inkMuted} />
      </Pressable>
      {showPicker ? (
        <DateInlinePicker
          value={value}
          minimum={minimum}
          maximum={maximum}
          onClose={() => setShowPicker(false)}
          onPick={(next) => {
            onChange(next);
            setShowPicker(false);
          }}
        />
      ) : null}
    </View>
  );
}

interface DateInlinePickerProps {
  value: string;
  minimum: string;
  maximum: string;
  onClose(): void;
  onPick(value: string): void;
}

function DateInlinePicker({ value, minimum, maximum, onClose, onPick }: DateInlinePickerProps) {
  const today = useMemo(() => todayPlus0(), []);
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const m = value.match(/^(\d{4})-(\d{2})/);
    if (m) return { year: Number(m[1]), month: Number(m[2]) - 1 };
    return { year: today.getFullYear(), month: today.getMonth() };
  });

  const lastDay = new Date(visibleMonth.year, visibleMonth.month + 1, 0).getDate();
  const firstOffset = new Date(visibleMonth.year, visibleMonth.month, 1).getDay();
  const cells: { key: string; day: number | null }[] = [];
  for (let i = 0; i < firstOffset; i += 1) cells.push({ key: `pad-${i}`, day: null });
  for (let d = 1; d <= lastDay; d += 1) cells.push({ key: `d-${d}`, day: d });

  function moveMonth(delta: number) {
    setVisibleMonth((current) => {
      const next = new Date(current.year, current.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  }

  function isoFor(day: number): string {
    const m = String(visibleMonth.month + 1).padStart(2, '0');
    const d = String(day).padStart(2, '0');
    return `${visibleMonth.year}-${m}-${d}`;
  }

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.inlineBackdrop} onPress={onClose}>
        <Pressable onPress={(e) => e.stopPropagation()} style={styles.inlineCard}>
          <View style={styles.inlineHeader}>
            <Pressable onPress={() => moveMonth(-1)} hitSlop={12}>
              <Icon name="back" size={18} color={colors.ink} />
            </Pressable>
            <Text style={styles.inlineMonth}>
              {MONTH_NAMES[visibleMonth.month]} {visibleMonth.year}
            </Text>
            <Pressable onPress={() => moveMonth(1)} hitSlop={12}>
              <Icon name="next" size={18} color={colors.ink} />
            </Pressable>
          </View>
          <View style={styles.inlineGrid}>
            {cells.map((cell) => {
              if (cell.day === null) return <View key={cell.key} style={styles.inlineCell} />;
              const iso = isoFor(cell.day);
              const disabled = compareIso(iso, minimum) < 0 || compareIso(iso, maximum) > 0;
              const isSelected = iso === value;
              return (
                <Pressable
                  key={cell.key}
                  onPress={() => !disabled && onPick(iso)}
                  disabled={disabled}
                  style={styles.inlineCell}>
                  <View style={[styles.inlineDay, isSelected && styles.inlineDaySelected]}>
                    <Text
                      style={[
                        styles.inlineDayLabel,
                        disabled && styles.inlineDayDisabled,
                        isSelected && styles.inlineDayLabelSelected,
                      ]}>
                      {cell.day}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: colors.surface, flex: 1 },
  pressed: { opacity: 0.85 },
  mapWrap: { flex: 1, position: 'relative' },
  searchFloating: {
    left: 16,
    position: 'absolute',
    right: 16,
  },
  searchInputBox: {
    alignItems: 'center',
    backgroundColor: colors.paper,
    borderColor: colors.pine,
    borderRadius: radius.md,
    borderWidth: 1.5,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 6,
  },
  searchInput: {
    color: colors.ink,
    flex: 1,
    fontFamily: fontFamily.semibold,
    fontSize: 15,
    padding: 0,
  },
  suggestions: {
    backgroundColor: colors.paper,
    borderRadius: radius.md,
    marginTop: 6,
    overflow: 'hidden',
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 4,
  },
  suggestionRow: {
    alignItems: 'center',
    borderBottomColor: colors.hairlineSoft,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  suggestionBody: { flex: 1, gap: 2 },
  suggestionPrimary: {
    color: colors.ink,
    fontFamily: fontFamily.semibold,
    fontSize: 14,
  },
  suggestionSecondary: {
    color: colors.inkSoft,
    fontFamily: fontFamily.body,
    fontSize: 12,
  },
  form: {
    backgroundColor: colors.paper,
    borderTopColor: colors.hairline,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  formLabel: {
    color: colors.inkSoft,
    fontFamily: fontFamily.medium,
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  formInput: {
    backgroundColor: colors.surface,
    borderColor: colors.hairline,
    borderRadius: radius.md,
    borderWidth: 1,
    color: colors.ink,
    fontFamily: fontFamily.semibold,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  formAddress: {
    color: colors.inkSoft,
    fontFamily: fontFamily.body,
    fontSize: 12,
  },
  sectionHint: {
    color: colors.inkMuted,
    fontFamily: fontFamily.medium,
    fontSize: 12,
    marginTop: 2,
  },
  dateRow: { flexDirection: 'row', gap: 12 },
  dateColumn: { flex: 1, gap: 8 },
  timeInput: {
    color: colors.ink,
    flex: 1,
    fontFamily: fontFamily.semibold,
    fontSize: 14,
    padding: 0,
  },
  dateField: { gap: 6 },
  dateLabel: {
    color: colors.inkSoft,
    fontFamily: fontFamily.medium,
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  dateButton: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.hairline,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  timeBox: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.hairline,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  dateButtonPressed: { borderColor: colors.pine, opacity: 0.9 },
  dateValue: {
    color: colors.ink,
    flex: 1,
    fontFamily: fontFamily.semibold,
    fontSize: 14,
  },
  error: {
    color: colors.amber,
    fontFamily: fontFamily.medium,
    fontSize: 12,
  },
  inlineBackdrop: {
    backgroundColor: colors.scrim,
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  inlineCard: {
    backgroundColor: colors.paper,
    borderRadius: radius.lg,
    gap: 10,
    padding: 16,
  },
  inlineHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  inlineMonth: {
    color: colors.ink,
    fontFamily: fontFamily.semibold,
    fontSize: 15,
  },
  inlineGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  inlineCell: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: `${100 / 7}%`,
  },
  inlineDay: {
    alignItems: 'center',
    borderRadius: 999,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  inlineDaySelected: { backgroundColor: colors.pine },
  inlineDayLabel: {
    color: colors.ink,
    fontFamily: fontFamily.medium,
    fontSize: 13,
  },
  inlineDayLabelSelected: { color: colors.paper, fontFamily: fontFamily.semibold },
  inlineDayDisabled: { color: colors.inkSoft, opacity: 0.4 },
});
