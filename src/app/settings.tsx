/**
 * Settings, scoped to providers.
 *
 * Each provider card holds what one provider needs — endpoint, dialect,
 * credential — and the models it offers, switchable from inside the card. There
 * is no per-model profile: a model is picked from the provider's list, and only
 * what the user typed, hid or overrode is stored.
 */
import { Link } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { TextInputInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader } from '../components/AppHeader';
import { ProviderCard } from '../components/ProviderCard';
import {
  catalogCount,
  catalogProvider,
  FEATURED_SLUGS,
  formatPrice,
  providerInputFromCatalog,
  searchCatalog,
} from '../core/catalog-search';
import type { CatalogProvider } from '../core/provider-catalog';
import { LOCAL_SERVER_DEFAULT_BASE_URL, resetConfig, useConfig } from '../store/config';
import { useKeyboardAwareScroll } from '../hooks/useKeyboardAwareScroll';
import { useKeyboardPadding } from '../hooks/useKeyboardPadding';
import { theme } from '../theme';

export default function SettingsScreen() {
  const providers = useConfig((state) => state.providers);
  const selectedSlug = useConfig((state) => state.selectedSlug);
  const { scrollRef, onScroll, reveal } = useKeyboardAwareScroll();
  const keyboardPadding = useKeyboardPadding();
  // See the chat screen: the keyboard also covers the navigation bar, which
  // `endCoordinates.height` leaves out, so the inset is padded on top of it.
  const insets = useSafeAreaInsets();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [resetDone, setResetDone] = useState(false);

  const addFromCatalog = (entry: CatalogProvider) => {
    setPickerOpen(false);
    useConfig.getState().addProvider(providerInputFromCatalog(entry));
  };

  const addRemoteProvider = () => {
    setPickerOpen(false);
    useConfig.getState().addProvider({
      source: 'remote',
      dialect: 'openai-chat',
      name: 'New provider',
    });
  };

  const addLocalServer = () => {
    setPickerOpen(false);
    useConfig.getState().addProvider({
      source: 'local-server',
      dialect: 'openai-compatible',
      name: 'New LAN server',
      baseUrl: LOCAL_SERVER_DEFAULT_BASE_URL,
    });
  };

  return (
    // Android draws edge-to-edge since SDK 53, so the window is never resized by
    // the keyboard: the viewport has to be padded by the keyboard height itself,
    // and `reveal` scrolls the focused field into that smaller box.
    <View
      style={StyleSheet.compose(styles.container, { paddingBottom: keyboardPadding + insets.bottom })}
    >
      <AppHeader
        label="Settings"
        actions={
          <Link href="/" style={styles.headerAction}>
            Chat
          </Link>
        }
      />
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        <Text style={styles.section}>Providers ({providers.length})</Text>

        {providers.length === 0 ? (
          <Text style={styles.note}>
            No providers configured. Add one from the catalog below, then pick a model.
          </Text>
        ) : null}

        {providers.map((provider) => (
          <ProviderCard
            key={provider.slug}
            provider={provider}
            isSelected={provider.slug === selectedSlug}
            reveal={reveal}
          />
        ))}

        <View style={styles.buttonRow}>
          <Pressable
            style={({ pressed }) => [styles.primaryButton, pressed ? styles.primaryPressed : undefined]}
            onPress={() => setPickerOpen((open) => !open)}
            accessibilityRole="button"
          >
            <Text style={styles.primaryButtonText}>
              {pickerOpen ? 'Close provider list' : 'Add provider from catalog'}
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.secondaryButton, pressed ? styles.pressed : undefined]}
            onPress={addRemoteProvider}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryButtonText}>Blank remote</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.secondaryButton, pressed ? styles.pressed : undefined]}
            onPress={addLocalServer}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryButtonText}>Add LAN server</Text>
          </Pressable>
        </View>

        {pickerOpen ? (
          <ProviderPicker
            query={query}
            onQueryChange={setQuery}
            onPick={addFromCatalog}
            reveal={reveal}
          />
        ) : null}

        <View style={styles.buttonRow}>
          <Pressable
            style={({ pressed }) => [styles.dangerButton, pressed ? styles.dangerPressed : undefined]}
            onPress={() => {
              void resetConfig().then(() => setResetDone(true));
            }}
            accessibilityRole="button"
          >
            <Text style={styles.dangerButtonText}>Reset to built-in providers</Text>
          </Pressable>
        </View>
        {resetDone ? (
          <Text style={styles.note}>
            Providers reset. Keys are untouched — they live in SecureStore, not in this list.
          </Text>
        ) : null}

        <Text style={styles.footer}>
          One provider holds one endpoint, one dialect and one credential; the models it offers are
          picked inside the card, and switching model does not re-enter anything. Model lists come
          from models.dev and are refreshed with <Text style={styles.code}>yarn providers:sync</Text>
          {' '}— a LAN server instead answers <Text style={styles.code}>GET /models</Text>, which the{' '}
          <Text style={styles.code}>List models from server</Text> button reads. Keys are kept in
          SecureStore (in the web dev build, unencrypted localStorage), never in SQLite. Auth follows
          the dialect: OpenAI-style dialects send <Text style={styles.code}>Authorization: Bearer</Text>,
          Anthropic sends <Text style={styles.code}>x-api-key</Text>, Gemini puts the key in the query.
          Test connection probes the endpoint with the typed key without storing it — press{' '}
          <Text style={styles.code}>Save key</Text> to keep it. A model&apos;s context window is what
          the request guard budgets against. For a LAN server bind it to{' '}
          <Text style={styles.code}>0.0.0.0</Text> and use the host&apos;s LAN address. Gateways that
          route by conversation — OpenCode Go — need <Text style={styles.code}>x-opencode-session</Text>,
          which the app sends with a stable id it stores locally. The web dev target runs inside a
          browser, so an endpoint that sends no{' '}
          <Text style={styles.code}>Access-Control-Allow-Origin</Text> is blocked before the key ever
          leaves the page, and the failure reads as a network error; the phone build has no CORS and
          reaches the same endpoint.
        </Text>
      </ScrollView>
    </View>
  );
}

/**
 * Catalog picker: a search box plus a capped list of matches. Typing filters
 * name, slug, endpoint, dialect and the provider's models, so a catalog of 218
 * providers stays usable on a phone without virtualising the list.
 */
function ProviderPicker({
  query,
  onQueryChange,
  onPick,
  reveal,
}: {
  query: string;
  onQueryChange: (text: string) => void;
  onPick: (provider: CatalogProvider) => void;
  reveal: (target: TextInputInstance | null) => void;
}) {
  const results = searchCatalog(query);
  const total = catalogCount(query);
  const popular = FEATURED_SLUGS.slice(0, 8).map((slug) => catalogProvider(slug));
  const searchRef = useRef<TextInputInstance>(null);

  return (
    <View style={styles.picker}>
      <Text style={styles.section}>Providers ({total})</Text>

      <TextInput
        ref={searchRef}
        style={styles.search}
        value={query}
        onChangeText={onQueryChange}
        placeholder="Search providers, endpoints or models"
        placeholderTextColor={theme.subtle}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Search providers"
        onFocus={() => reveal(searchRef.current)}
        selectionColor={theme.accent}
      />

      {query.trim().length === 0 ? (
        <View style={styles.chipRow}>
          {popular.map((provider) =>
            provider === undefined ? null : (
              <Pressable
                key={provider.slug}
                style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : undefined]}
                onPress={() => onPick(provider)}
                accessibilityRole="button"
              >
                <Text style={styles.chipText}>{provider.name}</Text>
              </Pressable>
            ),
          )}
        </View>
      ) : null}

      {results.map((provider) => (
        <Pressable
          key={provider.slug}
          onPress={() => onPick(provider)}
          style={({ pressed }) => [styles.catalogRow, pressed ? styles.pressed : undefined]}
          accessibilityRole="button"
          accessibilityLabel={`Add ${provider.name}`}
        >
          <Text style={styles.label}>
            {provider.name}
            {provider.source === 'local-server' ? <Text style={styles.badge}> · LAN</Text> : null}
          </Text>
          <Text style={styles.note}>{provider.baseUrl}</Text>
          <Text style={styles.note}>
            {provider.dialect} · starts on {provider.modelId} ·{' '}
            {provider.models.length} models · {formatPrice(provider.models.find((model) => model.id === provider.modelId)?.pricing)}
          </Text>
          {provider.note !== undefined ? <Text style={styles.warn}>{provider.note}</Text> : null}
        </Pressable>
      ))}

      {total > results.length ? (
        <Text style={styles.note}>
          showing {results.length} of {total} — refine the search to see the rest
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  scroll: {
    flex: 1,
  },
  /** Back to chat; the navigator header is off, so this is the only way out. */
  headerAction: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderRadius: 8,
    fontSize: 13,
    fontWeight: '600',
    color: theme.accentText,
  },
  content: {
    padding: 16,
    gap: 10,
    paddingBottom: 40,
  },
  section: {
    fontSize: 14,
    fontWeight: '700',
    color: theme.text,
    letterSpacing: 0.4,
    marginTop: 8,
  },
  /** Pressed feedback: a tinted fill, since colour alone is hard to see on tap. */
  pressed: {
    backgroundColor: theme.accentSoft,
    borderColor: theme.accent,
  },
  /** Pressed feedback for filled controls — the fill darkens, white text stays AA. */
  primaryPressed: {
    backgroundColor: theme.accentPressed,
  },
  dangerPressed: {
    backgroundColor: theme.dangerPressed,
  },
  /** Chips keep their fill when selected, so they thicken instead of tinting. */
  chipPressed: {
    borderWidth: 2,
    borderColor: theme.accent,
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
    color: theme.text,
  },
  note: {
    fontSize: 12,
    color: theme.muted,
  },
  warn: {
    fontSize: 12,
    color: theme.warn,
  },
  badge: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.accentText,
  },
  picker: {
    gap: 8,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    padding: 10,
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
  catalogRow: {
    gap: 2,
    padding: 8,
    borderRadius: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
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
  chipText: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.accentText,
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  primaryButton: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: theme.accent,
    minHeight: 44,
    justifyContent: 'center',
  },
  primaryButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  secondaryButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.accent,
    backgroundColor: theme.card,
    minHeight: 40,
    justifyContent: 'center',
  },
  secondaryButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.accentText,
  },
  dangerButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.danger,
    backgroundColor: theme.dangerSoft,
    minHeight: 40,
    justifyContent: 'center',
  },
  dangerButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.danger,
  },
  footer: {
    fontSize: 12,
    color: theme.muted,
    lineHeight: 18,
    marginTop: 8,
  },
  code: {
    fontFamily: 'monospace',
    color: theme.text,
  },
});
