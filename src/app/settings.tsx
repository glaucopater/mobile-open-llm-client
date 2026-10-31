import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

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
import { deleteApiKey, hasApiKey, primeKeyCache, setApiKey } from '../core/keys';
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
import { LOCAL_SERVER_DEFAULT_BASE_URL, useConfig } from '../store/config';

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
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.section}>Models</Text>

      {models.map((model) => (
        <View key={model.id} style={styles.row}>
          <Pressable onPress={() => select(model.id)} style={styles.rowMain}>
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
            style={styles.editButton}
          >
            <Text style={styles.editText}>Edit</Text>
          </Pressable>
        </View>
      ))}

      <View style={styles.buttonRow}>
        <Pressable style={styles.primaryButton} onPress={() => setPickerOpen((open) => !open)}>
          <Text style={styles.primaryButtonText}>
            {pickerOpen ? 'Close provider list' : 'Add provider from catalog'}
          </Text>
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={addRemoteProvider}>
          <Text style={styles.secondaryButtonText}>Blank remote</Text>
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={addLocalServer}>
          <Text style={styles.secondaryButtonText}>Add LAN server</Text>
        </Pressable>
      </View>

      {pickerOpen ? (
        <ProviderPicker query={query} onQueryChange={setQuery} onPick={addFromCatalog} />
      ) : null}

      {editing !== undefined ? (
        <>
          {/* Remount per profile: the editor's fields are local state seeded from
              the model, and must not leak the previous profile's values. */}
          <ModelEditor
            key={editing.id}
            model={editing}
            onSave={(patch) => {
              useConfig.getState().updateModel(editing.id, patch);
              setEditingId(null);
            }}
            onCancel={() => setEditingId(null)}
          />
          <Pressable
            style={styles.dangerButton}
            onPress={() => {
              removeModel(editing.id);
              setEditingId(null);
            }}
          >
            <Text style={styles.dangerButtonText}>Delete this model</Text>
          </Pressable>
        </>
      ) : null}

      <Text style={styles.footer}>
        Keys are stored in SecureStore, never in SQLite. Auth follows the dialect: OpenAI-style
        dialects send <Text style={styles.code}>Authorization: Bearer</Text>, Anthropic sends
        <Text style={styles.code}>x-api-key</Text>, Gemini puts the key in the query. Test
        connection probes the endpoint with the typed key without storing it. The context window you
        set here is what the request guard budgets against — set it to the server&apos;s ctx size. For
        a LAN server bind it to <Text style={styles.code}>0.0.0.0</Text> and use the host&apos;s LAN
        address, or tunnel the port with <Text style={styles.code}>adb reverse tcp:11434 tcp:11434</Text>
        (emulator, or a real phone over USB). The provider catalog comes
        from models.dev and is refreshed with <Text style={styles.code}>yarn providers:sync</Text>.
      </Text>
    </ScrollView>
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
}: {
  query: string;
  onQueryChange: (text: string) => void;
  onPick: (provider: CatalogProvider) => void;
}) {
  const results = searchCatalog(query);
  const total = catalogCount(query);
  const popular = FEATURED_SLUGS.slice(0, 8).map((slug) => catalogProvider(slug));

  return (
    <View style={styles.editor}>
      <Text style={styles.section}>Providers ({total})</Text>

      <TextInput
        style={styles.field}
        value={query}
        onChangeText={onQueryChange}
        placeholder="Search providers, endpoints or models"
        autoCapitalize="none"
        autoCorrect={false}
      />

      {query.trim().length === 0 ? (
        <View style={styles.chipRow}>
          {popular.map((provider) =>
            provider === undefined ? null : (
              <Pressable key={provider.slug} style={styles.chip} onPress={() => onPick(provider)}>
                <Text style={styles.chipText}>{provider.name}</Text>
              </Pressable>
            ),
          )}
        </View>
      ) : null}

      {results.map((provider) => (
        <Pressable key={provider.slug} onPress={() => onPick(provider)} style={styles.catalogRow}>
          <Text style={styles.label}>
            {provider.name}
            {provider.source === 'local-server' ? <Text style={styles.note}> · LAN</Text> : null}
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
}: {
  model: ModelDescriptor;
  onSave: (patch: Partial<ModelDescriptor>) => void;
  onCancel: () => void;
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
    const typedKey = apiKey.trim();
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

    if (ref.length === 0 || apiKey.trim().length === 0) {
      return;
    }

    await setApiKey(ref, apiKey.trim());
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

      <Field label="Label" value={label} onChangeText={setLabel} />
      <Field label="Model id" value={modelId} onChangeText={setModelId} />
      <Field
        label="Base URL"
        value={baseUrl}
        onChangeText={setBaseUrl}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Field label="Context window (tokens)" value={contextWindow} onChangeText={setContextWindow} keyboardType="number-pad" />
      <Field label="API key ref" value={apiKeyRef} onChangeText={setApiKeyRef} autoCapitalize="none" />

      <View style={styles.chipRow}>
        {DIALECTS.map((option) => (
          <Pressable
            key={option.id}
            style={[styles.chip, dialect === option.id ? styles.chipOn : undefined]}
            onPress={() => changeDialect(option.id)}
          >
            <Text style={styles.chipText}>{option.label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.chipRow}>
        {SOURCES.map((option) => (
          <Pressable
            key={option.id}
            style={[styles.chip, source === option.id ? styles.chipOn : undefined]}
            onPress={() => changeSource(option.id)}
          >
            <Text style={styles.chipText}>{option.label}</Text>
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
            style={[styles.chip, capabilities[key] ? styles.chipOn : undefined]}
            onPress={() => toggleCapability(key)}
          >
            <Text style={styles.chipText}>{text}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.chipRow}>
        <Pressable style={styles.chip} onPress={resetEndpoint}>
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
        <Pressable style={styles.secondaryButton} onPress={runTest} disabled={testing}>
          <Text style={styles.secondaryButtonText}>{testing ? 'Testing…' : 'Test connection'}</Text>
        </Pressable>
        {testing ? (
          <Pressable style={styles.dangerButton} onPress={cancelTest}>
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
          style={styles.field}
          value={apiKey}
          onChangeText={setKey}
          placeholder={keyStored ? 'Key stored — paste a new one to replace' : 'Paste API key'}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable style={styles.secondaryButton} onPress={saveKey}>
          <Text style={styles.secondaryButtonText}>Save key</Text>
        </Pressable>
        {keyStored ? (
          <Pressable style={styles.dangerButton} onPress={clearKey}>
            <Text style={styles.dangerButtonText}>Clear</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.buttonRow}>
        <Pressable
          style={styles.primaryButton}
          onPress={() =>
            onSave({
              label: label.trim() || model.label,
              modelId: modelId.trim() || model.modelId,
              baseUrl: normalizeBaseUrl(baseUrl),
              contextWindow: Number(contextWindow) || undefined,
              apiKeyRef: apiKeyRef.trim() || undefined,
            })
          }
        >
          <Text style={styles.primaryButtonText}>Save changes</Text>
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={onCancel}>
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
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  keyboardType?: 'number-pad' | 'default';
  autoCapitalize?: 'none' | 'sentences';
  autoCorrect?: boolean;
}) {
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.field}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize={autoCapitalize ?? 'sentences'}
        autoCorrect={autoCorrect ?? true}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 16,
    gap: 10,
    paddingBottom: 40,
  },
  section: {
    fontSize: 14,
    fontWeight: '700',
    marginTop: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#E8E8E8',
    paddingBottom: 8,
  },
  rowMain: {
    flex: 1,
    gap: 2,
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
  },
  note: {
    fontSize: 12,
    opacity: 0.65,
  },
  preview: {
    fontSize: 12,
    fontFamily: 'monospace',
    opacity: 0.75,
  },
  testOk: {
    fontSize: 12,
    color: '#15803D',
  },
  testFail: {
    fontSize: 12,
    color: '#B02A30',
  },
  selected: {
    fontSize: 12,
    color: '#0A7FB5',
  },
  editButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#DDDDDD',
    // Touch target stays ≥44dp so the button is hittable on small screens.
    minWidth: 48,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  editText: {
    fontSize: 13,
  },
  catalogRow: {
    gap: 2,
    borderBottomWidth: 1,
    borderBottomColor: '#EFEFEF',
    paddingBottom: 6,
  },
  warn: {
    fontSize: 12,
    color: '#8A5A00',
  },
  editor: {
    borderWidth: 1,
    borderColor: '#DDDDDD',
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  fieldRow: {
    gap: 4,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    opacity: 0.7,
  },
  field: {
    borderWidth: 1,
    borderColor: '#DDDDDD',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#DDDDDD',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipOn: {
    backgroundColor: '#E6F4FE',
    borderColor: '#0A7FB5',
  },
  chipText: {
    fontSize: 12,
  },
  keyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
  },
  primaryButton: {
    borderRadius: 8,
    backgroundColor: '#0A7FB5',
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
    borderColor: '#DDDDDD',
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  secondaryButtonText: {
    fontSize: 14,
  },
  dangerButton: {
    borderRadius: 8,
    backgroundColor: '#B02A30',
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
    opacity: 0.6,
    lineHeight: 17,
  },
  code: {
    fontFamily: 'monospace',
    fontSize: 11,
  },
});
