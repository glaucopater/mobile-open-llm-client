/**
 * A provider's model list: search box plus a capped list of rows.
 *
 * Catalog providers carry hundreds of models (OpenRouter lists ~377), so only a
 * slice is rendered and typing narrows it. The selected row is marked, and a row
 * can be removed — typed models are deleted, catalog ones hidden and restorable.
 */
import { useRef } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { TextInputInstance } from 'react-native';

import {
  countProviderModels,
  describeProviderModel,
  searchProviderModels,
} from '../core/catalog-search';
import type { ProviderConfig } from '../core/model';
import { theme } from '../theme';

export function ModelPicker({
  provider,
  query,
  onQueryChange,
  selectedModelId,
  onPick,
  onRemove,
  reveal,
}: {
  provider: ProviderConfig;
  query: string;
  onQueryChange: (text: string) => void;
  selectedModelId: string;
  onPick: (modelId: string) => void;
  onRemove: (modelId: string) => void;
  reveal?: (target: TextInputInstance | null) => void;
}) {
  const results = searchProviderModels(provider, query);
  const total = countProviderModels(provider, query);
  const searchRef = useRef<TextInputInstance>(null);

  return (
    <View style={styles.picker}>
      <TextInput
        ref={searchRef}
        style={styles.search}
        value={query}
        onChangeText={onQueryChange}
        placeholder="Search models"
        placeholderTextColor={theme.subtle}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Search models"
        onFocus={() => reveal?.(searchRef.current)}
        selectionColor={theme.accent}
      />

      {results.map((model) => {
        const selected = model.modelId === selectedModelId;
        // A free row is marked because the price line alone does not say that a
        // gateway may restrict the tier and answer 403 instead of pricing it.
        const free = model.free === true;

        return (
          <View key={model.modelId} style={styles.row}>
            <Pressable
              onPress={() => onPick(model.modelId)}
              style={({ pressed }) => [styles.rowMain, pressed ? styles.pressed : undefined]}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`Use ${model.label} for chat${free ? ', free model' : ''}`}
            >
              <View style={styles.labelRow}>
                <Text style={selected ? styles.labelOn : styles.label}>
                  {selected ? `${model.modelId} ✓` : model.modelId}
                </Text>
                {free ? <Text style={styles.freeBadge}>free</Text> : null}
              </View>
              <Text style={styles.note}>{describeProviderModel(model)}</Text>
            </Pressable>
            <Pressable
              onPress={() => onRemove(model.modelId)}
              style={({ pressed }) => [styles.removeButton, pressed ? styles.removePressed : undefined]}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${model.modelId}`}
            >
              <Text style={styles.removeText}>{model.added ? 'Delete' : 'Hide'}</Text>
            </Pressable>
          </View>
        );
      })}

      {total === 0 ? <Text style={styles.note}>No models match this search.</Text> : null}
      {total > results.length ? (
        <Text style={styles.note}>
          showing {results.length} of {total} — refine the search to see the rest
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  picker: {
    gap: 6,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    padding: 8,
    backgroundColor: theme.card,
  },
  search: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 14,
    color: theme.text,
    backgroundColor: theme.card,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
    paddingBottom: 6,
  },
  rowMain: {
    flex: 1,
    gap: 2,
    padding: 4,
    borderRadius: 8,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.text,
  },
  labelOn: {
    fontSize: 14,
    fontWeight: '700',
    color: theme.accentText,
  },
  /** Green, not accent: it reads as "this costs nothing", not "this is selected". */
  freeBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: theme.ok,
    backgroundColor: theme.okSoft,
    borderWidth: 1,
    borderColor: theme.ok,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  note: {
    fontSize: 12,
    color: theme.muted,
  },
  pressed: {
    backgroundColor: theme.accentSoft,
    borderColor: theme.accent,
  },
  removeButton: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.danger,
    backgroundColor: theme.dangerSoft,
  },
  removePressed: {
    backgroundColor: theme.dangerPressed,
  },
  removeText: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.danger,
  },
});
