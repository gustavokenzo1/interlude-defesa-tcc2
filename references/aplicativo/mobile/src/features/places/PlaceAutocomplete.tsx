import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { describeApiError } from '@/infrastructure/api-client';
import { placesService } from '@/application/places-service';
import type { AutocompleteSuggestion } from '@/domain/types';
import { colors, fontFamily, radius } from '@/theme';
import { Icon } from '@/ui/Icon';

interface Props {
  placeholder: string;
  onSelect(suggestion: AutocompleteSuggestion): void;
}

export function PlaceAutocomplete({ placeholder, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<AutocompleteSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  function scheduleSearch(value: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 2) {
      setSuggestions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const requestId = ++requestIdRef.current;
      try {
        const items = await placesService.autocomplete(value);
        if (requestId !== requestIdRef.current) return;
        setSuggestions(items);
        setError(null);
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        setError(describeApiError(err));
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    }, 280);
  }

  function handleChange(value: string) {
    setQuery(value);
    scheduleSearch(value);
  }

  return (
    <View style={styles.wrapper}>
      <View style={styles.inputBox}>
        <Icon name="search" size={18} color={colors.inkSoft} />
        <TextInput
          autoCorrect={false}
          autoCapitalize="words"
          onChangeText={handleChange}
          placeholder={placeholder}
          placeholderTextColor={colors.inkSoft}
          selectionColor={colors.pine}
          style={styles.input}
          value={query}
        />
        {loading ? <ActivityIndicator color={colors.ink} /> : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {suggestions.length ? (
        <ScrollView
          style={styles.results}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          {suggestions.map((suggestion) => (
            <Pressable
              key={suggestion.placeId}
              accessibilityRole="button"
              accessibilityLabel={suggestion.primaryText}
              onPress={() => {
                onSelect(suggestion);
                setQuery(suggestion.primaryText);
                setSuggestions([]);
              }}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
              <View style={styles.rowIcon}>
                <Icon name="pin" size={16} color={colors.ink} />
              </View>
              <View style={styles.rowBody}>
                <Text style={styles.primary}>{suggestion.primaryText}</Text>
                {suggestion.secondaryText ? (
                  <Text style={styles.secondary}>{suggestion.secondaryText}</Text>
                ) : null}
              </View>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: 10 },
  inputBox: {
    alignItems: 'center',
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  input: {
    color: colors.ink,
    flex: 1,
    fontFamily: fontFamily.medium,
    fontSize: 15,
  },
  results: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radius.md,
    borderWidth: 1,
    maxHeight: 280,
  },
  row: {
    alignItems: 'center',
    borderBottomColor: colors.hairlineSoft,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowIcon: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderRadius: 8,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  rowBody: { flex: 1, gap: 2 },
  pressed: { opacity: 0.85 },
  primary: {
    color: colors.ink,
    fontFamily: fontFamily.semibold,
    fontSize: 15,
    lineHeight: 20,
  },
  secondary: {
    color: colors.inkSoft,
    fontFamily: fontFamily.body,
    fontSize: 12,
    lineHeight: 16,
  },
  error: {
    color: colors.danger,
    fontFamily: fontFamily.medium,
    fontSize: 13,
  },
});
