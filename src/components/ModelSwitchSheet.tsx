/**
 * Chat's model switcher: providers first, then the tapped provider's models.
 *
 * It is a modal rather than a push route so switching model mid-conversation
 * does not unmount the chat — the transcript and the streaming turn stay put.
 */
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { TextInputInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { modelsForProvider } from '../core/catalog-search';
import type { ProviderConfig } from '../core/model';
import { useConfig } from '../store/config';
import { theme } from '../theme';
import { ModelPicker } from './ModelPicker';

export function ModelSwitchSheet({
  open,
  onClose,
  providers,
  selectedSlug,
  slug,
  onSlugChange,
  reveal,
}: {
  open: boolean;
  onClose: () => void;
  providers: ProviderConfig[];
  selectedSlug: string;
  /** Which provider's list is expanded. Owned by the caller, which resets it on open. */
  slug: string;
  onSlugChange: (slug: string) => void;
  reveal?: (target: TextInputInstance | null) => void;
}) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');

  // A provider that was deleted while the sheet was open falls back to the one chat uses.
  const provider =
    providers.find((row) => row.slug === slug) ?? providers.find((row) => row.slug === selectedSlug);
  const offered = provider !== undefined ? modelsForProvider(provider) : [];

  return (
    <Modal visible={open} animationType="slide" onRequestClose={onClose}>
      {/* The modal draws over the status bar, so the Close button has to start
          below it: taps inside the status bar area are taken by the system. */}
      <View style={StyleSheet.compose(styles.sheet, { paddingTop: insets.top })}>
        <View style={styles.head}>
          <Text style={styles.title}>Switch model</Text>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.close, pressed ? styles.pressed : undefined]}
            accessibilityRole="button"
            accessibilityLabel="Close model switcher"
          >
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.chipRow}>
            {providers.map((row) => (
              <Pressable
                key={row.slug}
                onPress={() => {
                  onSlugChange(row.slug);
                  setQuery('');
                }}
                style={({ pressed }) => [
                  styles.chip,
                  row.slug === slug ? styles.chipOn : undefined,
                  row.slug === selectedSlug ? styles.chipActive : undefined,
                  pressed ? styles.chipPressed : undefined,
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: row.slug === slug }}
              >
                <Text style={row.slug === slug ? styles.chipTextOn : styles.chipText}>
                  {row.name}
                  {row.slug === selectedSlug ? ' •' : ''}
                </Text>
              </Pressable>
            ))}
          </View>

          {provider === undefined ? (
            <Text style={styles.note}>No providers configured.</Text>
          ) : (
            <>
              <Text style={styles.note}>
                {provider.name} · {provider.baseUrl} · {offered.length} models
              </Text>
              <ModelPicker
                provider={provider}
                query={query}
                onQueryChange={setQuery}
                selectedModelId={provider.selectedModelId}
                onPick={(modelId) => {
                  // Picking also makes this provider the one chat talks to.
                  useConfig.getState().selectModel(provider.slug, modelId);
                }}
                onRemove={(modelId) => useConfig.getState().removeModel(provider.slug, modelId)}
                reveal={reveal}
              />
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: theme.text,
  },
  close: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.accent,
    backgroundColor: theme.surface,
    minHeight: 40,
    justifyContent: 'center',
  },
  closeText: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.accentText,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 16,
    gap: 10,
    paddingBottom: 60,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.card,
  },
  chipOn: {
    backgroundColor: theme.accent,
    borderColor: theme.accent,
  },
  /** The provider chat is on: an outline, so it is distinguishable from the tap target. */
  chipActive: {
    borderWidth: 2,
    borderColor: theme.accentText,
  },
  chipPressed: {
    backgroundColor: theme.accentPressed,
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.accentText,
  },
  chipTextOn: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  note: {
    fontSize: 12,
    color: theme.muted,
  },
  pressed: {
    backgroundColor: theme.accentSoft,
    borderColor: theme.accent,
  },
});
