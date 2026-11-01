import { Link } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { TextInputInstance } from 'react-native';

import { AppHeader } from '../components/AppHeader';
import { describeConnection, testModelConnection, type ConnectionTest } from '../core/agent';
import { budgetFor } from '../core/context';
import {
  catalogCount,
  catalogProvider,
  FEATURED_SLUGS,
  formatPrice,
  profileInputFromCatalog,
  searchCatalog,
} from '../core/catalog-search';
import { deleteApiKey, hasApiKey, normalizeApiKey, primeKeyCache, setApiKey } from '../core/keys';
import {
  dialectDefaultBaseUrl,
  endpointPreview,
  normalizeBaseUrl,
  type Dialect,
  type ModelCapabilities,
  type ModelDescriptor,
  type ModelSource,
} from '../core/model';
import type { CatalogProvider } from '../core/provider-catalog';
import { useKeyboardAwareScroll } from '../hooks/useKeyboardAwareScroll';
import { useKeyboardPadding } from '../hooks/useKeyboardPadding';
import { LOCAL_SERVER_DEFAULT_BASE_URL, useConfig } from '../store/config';
import { theme } from '../theme';

const DIALECTS: { id: Dialect; label: string }[] = [
  { id: 'openai-chat', label: 'OpenAI chat' },
  { id: 'openai-responses', label: 'OpenAI responses' },
  { id: 'anthropic-messages', label: 'Anthropic' },
  { id: 'gemini-generate-content', label: 'Gemini' },
  { id: 'openai-compatible', label: 'OpenAI-compatible' },
];

const SOURCES: { id: ModelSource; label: string }[] = [
  { id: 'remote', label: 'Remote' },
  { id: 'local-server', label: 'LAN server' },
  { id: 'on-device', label: 'On device' },
];

export default function SettingsScreen() {
  const models = useConfig((state) => state.models);
  const selectedId = useConfig((state) => state.selectedId);
  const select = useConfig((state) => state.select);
  const createProfile = useConfig((state) => state.createProfile);
  const removeModel = useConfig((state) => state.removeModel);
  const { scrollRef, onScroll, reveal } = useKeyboardAwareScroll();
  const keyboardPadding = useKeyboardPadding();
  // See the chat screen: the keyboard also covers the navigation bar, which
  // `endCoordinates.height` leaves out, so the inset is padded on top of it.
  const insets = useSafeAreaInsets();

  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = models.find((model) => model.id === editingId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');

  const addFromCatalog = (provider: CatalogProvider) => {
    setPickerOpen(false);
    setEditingId(createProfile(profileInputFromCatalog(provider)).id);
  };

  const addRemoteProvider = () => {
    setPickerOpen(false);
    setEditingId(
      createProfile({
        source: 'remote',
        dialect: 'openai-chat',
        label: 'New provider',
        modelId: 'model',
      }).id,
    );
  };

  const addLocalServer = () => {
    setPickerOpen(false);
    setEditingId(
      createProfile({
        source: 'local-server',
        dialect: 'openai-compatible',
        label: 'New LAN server',
        modelId: 'model',
        baseUrl: LOCAL_SERVER_DEFAULT_BASE_URL,
      }).id,
    );
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
        <Text style={styles.section}>Models</Text>

        {models.map((model) => (
          <View key={model.id} style={styles.row}>
            <Pressable
              onPress={() => select(model.id)}
              style={({ pressed }) => [styles.rowMain, pressed ? styles.pressed : undefined]}
              accessibilityRole="button"
              accessibilityLabel={`Use ${model.label} for chat`}
            >
              <Text style={styles.label}>{model.label}</Text>
              <Text style={styles.note}>
                {model.dialect} · {model.modelId} · ctx {model.contextWindow ?? 'unset'}
              </Text>
              <Text style={styles.note}>{endpointPreview(model)}</Text>
              {model.id === selectedId ? <Text style={styles.selected}>selected for chat</Text> : null}
            </Pressable>
            <Pressable
              onPress={() => {
                setPickerOpen(false);
                setEditingId(model.id);
              }}
              style={({ pressed }) => [styles.editButton, pressed ? styles.pressed : undefined]}
              accessibilityRole="button"
              accessibilityLabel={`Edit ${model.label}`}
            >
              <Text style={styles.editText}>Edit</Text>
            </Pressable>
          </View>
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

        {editing !== undefined ? (
          <>
            {/* Remount per profile: the editor's fields are local state seeded from
                the model, and must not leak the previous profile's values. */}
            <ModelEditor
              key={editing.id}
              model={editing}
              reveal={reveal}
              onSave={(patch) => {
                useConfig.getState().updateModel(editing.id, patch);
                setEditingId(null);
              }}
              onCancel={() => setEditingId(null)}
            />
            <Pressable
              style={({ pressed }) => [styles.dangerButton, pressed ? styles.dangerPressed : undefined]}
              onPress={() => {
                removeModel(editing.id);
                setEditingId(null);
              }}
              accessibilityRole="button"
            >
              <Text style={styles.dangerButtonText}>Delete this model</Text>
            </Pressable>
          </>
        ) : null}

        <Text style={styles.footer}>
          Keys are kept in SecureStore (in the web dev build, unencrypted localStorage), never in
          SQLite. Auth follows the dialect: OpenAI-style dialects send{' '}
          <Text style={styles.code}>Authorization: Bearer</Text>, Anthropic sends{' '}
          <Text style={styles.code}>x-api-key</Text>, Gemini puts the key in the query. Test
          connection probes the endpoint with the typed key without storing it. The context window you
          set here is what the request guard budgets against — set it to the server&apos;s ctx size. For
          a LAN server bind it to <Text style={styles.code}>0.0.0.0</Text> and use the host&apos;s LAN
          address, or tunnel the port with{' '}
          <Text style={styles.code}>adb reverse tcp:11434 tcp:11434</Text>{' '}
          (emulator, or a real phone over USB). Gateways that route by conversation — OpenCode Go —
          need <Text style={styles.code}>x-opencode-session</Text>, which the app sends with a stable
          id it stores locally. OpenCode Go ships as a default profile, so it only needs a key
          pasted here. The provider catalog comes from models.dev and is refreshed with{' '}
          <Text style={styles.code}>yarn providers:sync</Text>.
        </Text>
      </ScrollView>
    </View>
  );
}

/**
 * Catalog picker: a search box plus a capped list of matches. Typing filters
 * name, slug, endpoint, model id and dialect, so a 220-entry catalog stays
 * usable on a phone without virtualising the list.
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
    <View style={styles.editor}>
      <Text style={styles.section}>Providers ({total})</Text>

      <TextInput
        ref={searchRef}
        style={styles.field}
        value={query}
        onChangeText={onQueryChange}
        placeholder="Search providers, endpoints or models"
        placeholderTextColor={theme.subtle}
        autoCapitalize="none"
        autoCorrect={false}
        onFocus={() => reveal(searchRef.current)}
        selectionColor={theme.accent}
      />

      {query.trim().length === 0 ? (
        <View style={styles.chipRow}>
          {popular.map((provider) =>
            provider === undefined ? null : (
              <Pressable
                key={provider.slug}
                style={({ pressed }) => [styles.chip, pressed ? styles.pressed : undefined]}
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
        >
          <Text style={styles.label}>
            {provider.name}
            {provider.source === 'local-server' ? <Text style={styles.badge}> · LAN</Text> : null}
          </Text>
          <Text style={styles.note}>{provider.baseUrl}</Text>
          <Text style={styles.note}>
            {provider.dialect} · {provider.modelId} · ctx {provider.contextWindow ?? 'unset'} ·{' '}
            {formatPrice(provider.pricing)}
          </Text>
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

function ModelEditor({
  model,
  onSave,
  onCancel,
  reveal,
}: {
  model: ModelDescriptor;
  onSave: (patch: Partial<ModelDescriptor>) => void;
  onCancel: () => void;
  reveal: (target: TextInputInstance | null) => void;
}) {
  const [label, setLabel] = useState(model.label);
  const [modelId, setModelId] = useState(model.modelId);
  const [baseUrl, setBaseUrl] = useState(model.baseUrl ?? dialectDefaultBaseUrl(model.dialect));
  const [contextWindow, setContextWindow] = useState(String(model.contextWindow ?? 32768));
  const [apiKeyRef, setApiKeyRef] = useState(model.apiKeyRef ?? '');
  const [apiKey, setKey] = useState('');
  const [keyStored, setKeyStored] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTest | null>(null);
  const [testing, setTesting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const keyRef = useRef<TextInputInstance>(null);

  const dialect = model.dialect;
  const source = model.source;
  const capabilities = model.capabilities;

  useEffect(() => {
    let active = true;

    hasApiKey(model.apiKeyRef).then((stored) => {
      if (active) {
        setKeyStored(stored);
      }
    });

    return () => {
      active = false;
    };
  }, [model.apiKeyRef]);

  /** The profile as typed, which is what Save and the probe act on. */
  const draft: ModelDescriptor = {
    ...model,
    label: label.trim() || model.label,
    modelId: modelId.trim() || model.modelId,
    baseUrl: normalizeBaseUrl(baseUrl),
    contextWindow: Number(contextWindow) || undefined,
    apiKeyRef: apiKeyRef.trim() || undefined,
  };

  /**
   * Writes through the store, then re-reads the credential slot: switching
   * source derives a slot (remote) or drops it (LAN server).
   */
  const patchModel = (patch: Partial<ModelDescriptor>) => {
    useConfig.getState().updateModel(model.id, patch);
    setApiKeyRef(
      useConfig.getState().models.find((candidate) => candidate.id === model.id)?.apiKeyRef ?? '',
    );
    setTestResult(null);
  };

  const changeDialect = (next: Dialect) => {
    // An endpoint the user never touched follows the new dialect's vendor origin.
    if (baseUrl.trim() === dialectDefaultBaseUrl(model.dialect)) {
      setBaseUrl(dialectDefaultBaseUrl(next));
    }

    patchModel({ dialect: next });
  };

  const changeSource = (next: ModelSource) => {
    patchModel({ source: next });

    if (next === 'local-server') {
      setBaseUrl(LOCAL_SERVER_DEFAULT_BASE_URL);
    } else if (baseUrl.trim() === LOCAL_SERVER_DEFAULT_BASE_URL) {
      setBaseUrl(dialectDefaultBaseUrl(draft.dialect));
    }
  };

  const toggleCapability = (key: keyof ModelCapabilities) => {
    useConfig
      .getState()
      .updateModel(model.id, { capabilities: { ...capabilities, [key]: !capabilities[key] } });
  };

  const resetEndpoint = () => {
    setBaseUrl(dialectDefaultBaseUrl(draft.dialect));
    setTestResult(null);
  };

  const runTest = async () => {
    const typedKey = normalizeApiKey(apiKey);
    const controller = new AbortController();

    abortRef.current = controller;
    setTesting(true);
    setTestResult(null);

    try {
      setTestResult(
        await testModelConnection(draft, {
          apiKey: typedKey.length > 0 ? typedKey : undefined,
          abortSignal: controller.signal,
        }),
      );
    } finally {
      abortRef.current = null;
      setTesting(false);
    }
  };

  const cancelTest = () => {
    abortRef.current?.abort();
  };

  const saveKey = async () => {
    const ref = apiKeyRef.trim();

    if (ref.length === 0 || normalizeApiKey(apiKey).length === 0) {
      return;
    }

    await setApiKey(ref, apiKey);
    await primeKeyCache([ref]);
    setKeyStored(true);
    setKey('');
  };

  const clearKey = async () => {
    const ref = apiKeyRef.trim();

    if (ref.length === 0) {
      return;
    }

    await deleteApiKey(ref);
    await primeKeyCache([ref]);
    setKeyStored(false);
  };

  const budget = budgetFor(Number(contextWindow) || undefined);

  return (
    <View style={styles.editor}>
      <Text style={styles.section}>{model.id}</Text>

      <Field label="Label" value={label} onChangeText={setLabel} reveal={reveal} />
      <Field label="Model id" value={modelId} onChangeText={setModelId} reveal={reveal} />
      <Field
        label="Base URL"
        value={baseUrl}
        onChangeText={setBaseUrl}
        autoCapitalize="none"
        autoCorrect={false}
        reveal={reveal}
      />
      <Field
        label="Context window (tokens)"
        value={contextWindow}
        onChangeText={setContextWindow}
        keyboardType="number-pad"
        reveal={reveal}
      />
      <Field
        label="API key ref"
        value={apiKeyRef}
        onChangeText={setApiKeyRef}
        autoCapitalize="none"
        reveal={reveal}
      />

      <View style={styles.chipRow}>
        {DIALECTS.map((option) => (
          <Pressable
            key={option.id}
            style={({ pressed }) => [
              styles.chip,
              dialect === option.id ? styles.chipOn : undefined,
              pressed ? styles.chipPressed : undefined,
            ]}
            onPress={() => changeDialect(option.id)}
            accessibilityRole="button"
            accessibilityState={{ selected: dialect === option.id }}
          >
            <Text style={dialect === option.id ? styles.chipTextOn : styles.chipText}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.chipRow}>
        {SOURCES.map((option) => (
          <Pressable
            key={option.id}
            style={({ pressed }) => [
              styles.chip,
              source === option.id ? styles.chipOn : undefined,
              pressed ? styles.chipPressed : undefined,
            ]}
            onPress={() => changeSource(option.id)}
            accessibilityRole="button"
            accessibilityState={{ selected: source === option.id }}
          >
            <Text style={source === option.id ? styles.chipTextOn : styles.chipText}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.chipRow}>
        {(
          [
            ['tools', 'tools'],
            ['vision', 'vision'],
            ['reasoning', 'reasoning'],
          ] as const
        ).map(([key, text]) => (
          <Pressable
            key={key}
            style={({ pressed }) => [
              styles.chip,
              capabilities[key] ? styles.chipOn : undefined,
              pressed ? styles.chipPressed : undefined,
            ]}
            onPress={() => toggleCapability(key)}
            accessibilityRole="button"
            accessibilityState={{ selected: capabilities[key] }}
          >
            <Text style={capabilities[key] ? styles.chipTextOn : styles.chipText}>{text}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.chipRow}>
        <Pressable
          style={({ pressed }) => [styles.chip, pressed ? styles.pressed : undefined]}
          onPress={resetEndpoint}
          accessibilityRole="button"
        >
          <Text style={styles.chipText}>Use dialect default endpoint</Text>
        </Pressable>
      </View>

      <Text style={styles.preview}>{endpointPreview(draft)}</Text>
      <Text style={styles.note}>
        request budget: prompt ≤ {budget.inputBudget}, answer {budget.maxOutputTokens}
      </Text>
      {model.pricing !== undefined ? <Text style={styles.note}>{formatPrice(model.pricing)}</Text> : null}
      {model.note !== undefined ? <Text style={styles.warn}>{model.note}</Text> : null}

      <View style={styles.buttonRow}>
        <Pressable
          style={({ pressed }) => [
            styles.secondaryButton,
            testing ? styles.buttonDisabled : undefined,
            pressed ? styles.pressed : undefined,
          ]}
          onPress={runTest}
          disabled={testing}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryButtonText}>{testing ? 'Testing…' : 'Test connection'}</Text>
        </Pressable>
        {testing ? (
          <Pressable
            style={({ pressed }) => [styles.dangerButton, pressed ? styles.dangerPressed : undefined]}
            onPress={cancelTest}
            accessibilityRole="button"
          >
            <Text style={styles.dangerButtonText}>Cancel</Text>
          </Pressable>
        ) : null}
      </View>

      {testResult !== null ? (
        <Text style={testResult.ok ? styles.testOk : styles.testFail}>
          {describeConnection(draft, testResult)}
        </Text>
      ) : null}

      <View style={styles.keyRow}>
        <TextInput
          ref={keyRef}
          style={styles.field}
          value={apiKey}
          onChangeText={setKey}
          placeholder={keyStored ? 'Key stored — paste a new one to replace' : 'Paste API key'}
          placeholderTextColor={theme.subtle}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          onFocus={() => reveal(keyRef.current)}
          selectionColor={theme.accent}
        />
        <Pressable
          style={({ pressed }) => [
            styles.secondaryButton,
            apiKey.trim().length === 0 || apiKeyRef.trim().length === 0
              ? styles.buttonDisabled
              : undefined,
            pressed ? styles.pressed : undefined,
          ]}
          onPress={saveKey}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryButtonText}>Save key</Text>
        </Pressable>
        {keyStored ? (
          <Pressable
            style={({ pressed }) => [styles.dangerButton, pressed ? styles.dangerPressed : undefined]}
            onPress={clearKey}
            accessibilityRole="button"
          >
            <Text style={styles.dangerButtonText}>Clear</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.buttonRow}>
        <Pressable
          style={({ pressed }) => [styles.primaryButton, pressed ? styles.primaryPressed : undefined]}
          onPress={() =>
            onSave({
              label: label.trim() || model.label,
              modelId: modelId.trim() || model.modelId,
              baseUrl: normalizeBaseUrl(baseUrl),
              contextWindow: Number(contextWindow) || undefined,
              apiKeyRef: apiKeyRef.trim() || undefined,
            })
          }
          accessibilityRole="button"
        >
          <Text style={styles.primaryButtonText}>Save changes</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.secondaryButton, pressed ? styles.pressed : undefined]}
          onPress={onCancel}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryButtonText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Field({
  label,
  value,
  onChangeText,
  keyboardType,
  autoCapitalize,
  autoCorrect,
  reveal,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  keyboardType?: 'number-pad' | 'default';
  autoCapitalize?: 'none' | 'sentences';
  autoCorrect?: boolean;
  reveal: (target: TextInputInstance | null) => void;
}) {
  const inputRef = useRef<TextInputInstance>(null);
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        ref={inputRef}
        style={[styles.field, focused ? styles.fieldFocused : undefined]}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize={autoCapitalize ?? 'sentences'}
        autoCorrect={autoCorrect ?? true}
        accessibilityLabel={label}
        selectionColor={theme.accent}
        onFocus={() => {
          setFocused(true);
          reveal(inputRef.current);
        }}
        onBlur={() => setFocused(false)}
      />
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
    paddingBottom: 8,
  },
  rowMain: {
    flex: 1,
    gap: 2,
    padding: 4,
    borderRadius: 8,
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
  badge: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.accentText,
  },
  preview: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: theme.muted,
  },
  testOk: {
    fontSize: 12,
    color: theme.ok,
    backgroundColor: theme.okSoft,
    borderWidth: 1,
    borderColor: theme.ok,
    borderRadius: 8,
    padding: 8,
  },
  testFail: {
    fontSize: 12,
    color: theme.danger,
    backgroundColor: theme.dangerSoft,
    borderWidth: 1,
    borderColor: theme.danger,
    borderRadius: 8,
    padding: 8,
  },
  selected: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.accentText,
    backgroundColor: theme.accentSoft,
    borderColor: theme.accent,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    alignSelf: 'flex-start',
    marginTop: 2,
  },
  editButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    backgroundColor: theme.card,
    // Touch target stays ≥44dp so the button is hittable on small screens.
    minWidth: 48,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  editText: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.accentText,
  },
  catalogRow: {
    gap: 2,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderRadius: 8,
  },
  warn: {
    fontSize: 12,
    color: theme.warn,
    backgroundColor: theme.warnSoft,
    borderWidth: 1,
    borderColor: theme.warn,
    borderRadius: 8,
    padding: 8,
  },
  editor: {
    borderWidth: 1,
    borderColor: theme.borderStrong,
    borderRadius: 10,
    backgroundColor: theme.surface,
    padding: 12,
    gap: 8,
  },
  fieldRow: {
    gap: 4,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.text,
  },
  field: {
    borderWidth: 1,
    borderColor: theme.borderStrong,
    borderRadius: 8,
    backgroundColor: theme.card,
    minHeight: 44,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: theme.text,
  },
  fieldFocused: {
    borderColor: theme.accent,
    borderWidth: 2,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    backgroundColor: theme.card,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 40,
    justifyContent: 'center',
  },
  chipOn: {
    backgroundColor: theme.accent,
    borderColor: theme.accent,
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.text,
  },
  chipTextOn: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  keyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  primaryButton: {
    borderRadius: 8,
    backgroundColor: theme.accent,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  secondaryButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    backgroundColor: theme.card,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.text,
  },
  buttonDisabled: {
    backgroundColor: theme.disabled,
    borderColor: theme.border,
  },
  dangerButton: {
    borderRadius: 8,
    backgroundColor: theme.danger,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  dangerButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  footer: {
    fontSize: 12,
    lineHeight: 17,
    color: theme.muted,
  },
  code: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: theme.text,
  },
});
