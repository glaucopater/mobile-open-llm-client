/**
 * One provider's configuration: endpoint, dialect, credential, and the model it
 * chats with. Everything a provider needs is edited here once, so switching
 * model is a tap in its model list rather than a new profile.
 *
 * Catalog models are not stored — the list comes from `provider-catalog.ts` —
 * so the card only writes what the user typed, hid, or overrode.
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { TextInputInstance } from 'react-native';

import { describeConnection, testModelConnection, type ConnectionTest } from '../core/agent';
import {
  describeProviderModel,
  endpointChoices,
  formatPrice,
  modelsForProvider,
} from '../core/catalog-search';
import { budgetFor } from '../core/context';
import { deleteApiKey, hasApiKey, normalizeApiKey, primeKeyCache, setApiKey } from '../core/keys';
import { listServerModels } from '../core/model-list';
import {
  DEFAULT_CAPABILITIES,
  dialectDefaultBaseUrl,
  endpointPreview,
  normalizeBaseUrl,
  activeDescriptor,
  type Dialect,
  type ModelCapabilities,
  type ModelSource,
  type ProviderConfig,
  type ProviderModel,
} from '../core/model';
import { useConfig } from '../store/config';
import { theme } from '../theme';
import { Field } from './Field';
import { ModelPicker } from './ModelPicker';

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

const CAPABILITIES: { key: keyof ModelCapabilities; label: string }[] = [
  { key: 'tools', label: 'tools' },
  { key: 'vision', label: 'vision' },
  { key: 'reasoning', label: 'reasoning' },
];

export function ProviderCard({
  provider,
  isSelected,
  reveal,
}: {
  provider: ProviderConfig;
  isSelected: boolean;
  reveal: (target: TextInputInstance | null) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKeyRef, setApiKeyRef] = useState(provider.apiKeyRef ?? '');
  const [apiKey, setKey] = useState('');
  const [keyStored, setKeyStored] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [modelsOpen, setModelsOpen] = useState(false);
  const [newModelId, setNewModelId] = useState('');
  const [testResult, setTestResult] = useState<ConnectionTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const keyRef = useRef<TextInputInstance>(null);

  const dialect = provider.dialect;
  const source = provider.source;
  const models = modelsForProvider(provider);
  const active = models.find((model) => model.modelId === provider.selectedModelId) ?? models[0];

  // The provider as typed on screen: Save, the probe and the endpoint preview all
  // act on this rather than on the stored row, so an edit can be tested first.
  const draft: ProviderConfig = {
    ...provider,
    dialect,
    source,
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKeyRef: apiKeyRef.trim() || provider.apiKeyRef,
  };
  const draftModels = modelsForProvider(draft);
  const draftActive = activeDescriptor(draft, draftModels);
  const choices = endpointChoices(draft);
  const budget = budgetFor(active?.contextWindow);

  useEffect(() => {
    let active = true;

    hasApiKey(provider.apiKeyRef).then((stored) => {
      if (active) {
        setKeyStored(stored);
      }
    });

    return () => {
      active = false;
    };
  }, [provider.apiKeyRef]);

  const patch = (next: Partial<ProviderConfig>) => {
    useConfig.getState().updateProvider(provider.slug, next);
    setApiKeyRef(
      useConfig.getState().providers.find((row) => row.slug === provider.slug)?.apiKeyRef ?? '',
    );
    setTestResult(null);
  };

  const changeDialect = (next: Dialect) => {
    // An endpoint the user never touched follows the new dialect's vendor origin.
    if (baseUrl.trim() === dialectDefaultBaseUrl(dialect)) {
      setBaseUrl(dialectDefaultBaseUrl(next));
      useConfig.getState().setEndpoint(provider.slug, dialectDefaultBaseUrl(next));
    }

    patch({ dialect: next });
  };

  const changeSource = (next: ModelSource) => {
    patch({ source: next });

    const stored = useConfig.getState().providers.find((row) => row.slug === provider.slug);
    setBaseUrl(stored?.baseUrl ?? baseUrl);
  };

  const applyEndpoint = (choice: string) => {
    setBaseUrl(choice);
    useConfig.getState().setEndpoint(provider.slug, choice);
    setTestResult(null);
  };

  /** Writes a per-model override: the guard budgets against it, and capabilities drive the loop. */
  const overrideActive = (patchModel: Partial<ProviderModel>) => {
    if (active === undefined) {
      return;
    }

    useConfig
      .getState()
      .addModels(provider.slug, [{ ...active, ...patchModel, modelId: active.modelId, edited: true }]);
  };

  const toggleCapability = (key: keyof ModelCapabilities) => {
    if (active === undefined) {
      return;
    }

    overrideActive({
      capabilities: { ...active.capabilities, [key]: !active.capabilities[key] },
    });
  };

  const addTypedModel = () => {
    const modelId = newModelId.trim();

    if (modelId.length === 0) {
      return;
    }

    useConfig.getState().addModels(provider.slug, [
      {
        modelId,
        label: modelId,
        capabilities: { ...DEFAULT_CAPABILITIES },
        added: true,
        edited: true,
      },
    ]);
    setNewModelId('');
    setModelsOpen(true);
  };

  /** Reads the server's own list — the only way to know what a LAN server has loaded. */
  const listFromServer = async () => {
    const controller = new AbortController();

    abortRef.current = controller;
    setListing(true);
    setListError(null);

    try {
      const listed = await listServerModels(draft.baseUrl, {
        apiKey: normalizeApiKey(apiKey) || undefined,
        abortSignal: controller.signal,
      });

      if (listed.length === 0) {
        setListError(`${draft.baseUrl}/models answered with no models`);
      } else {
        useConfig.getState().addModels(provider.slug, listed);
        setModelsOpen(true);
      }
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      abortRef.current = null;
      setListing(false);
    }
  };

  const runTest = async () => {
    const typedKey = normalizeApiKey(apiKey);
    const controller = new AbortController();

    abortRef.current = controller;
    setTesting(true);
    setTestResult(null);

    try {
      setTestResult(
        await testModelConnection(draftActive, {
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

  const canProbe = source !== 'on-device';
  const listingSupported = draft.dialect === 'openai-compatible' || source === 'local-server';

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.label}>
          {provider.name}
          {provider.source === 'local-server' ? <Text style={styles.badge}> · LAN</Text> : null}
        </Text>
        {isSelected ? <Text style={styles.selected}>selected for chat</Text> : null}
      </View>

      {!isSelected ? (
        <Pressable
          style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : undefined]}
          onPress={() => useConfig.getState().selectProvider(provider.slug)}
          accessibilityRole="button"
          accessibilityLabel={`Use ${provider.name} for chat`}
        >
          <Text style={styles.chipText}>Use for chat</Text>
        </Pressable>
      ) : null}

      {active !== undefined ? (
        <Pressable
          style={({ pressed }) => [styles.modelRow, pressed ? styles.pressed : undefined]}
          onPress={() => setModelsOpen((open) => !open)}
          accessibilityRole="button"
          accessibilityLabel={`Switch model for ${provider.name}`}
        >
          <Text style={styles.label}>{active.modelId}</Text>
          <Text style={styles.note}>{describeProviderModel(active)}</Text>
          <Text style={styles.note}>
            {models.length} model{models.length === 1 ? '' : 's'} offered
            {provider.hiddenModelIds.length > 0
              ? ` · ${provider.hiddenModelIds.length} hidden`
              : ''}
          </Text>
          <Text style={styles.chipText}>{modelsOpen ? 'Close model list' : 'Switch model'}</Text>
        </Pressable>
      ) : (
        <Text style={styles.warn}>This provider has no models. Add one below.</Text>
      )}

      {modelsOpen ? (
        <>
          <ModelPicker
            provider={provider}
            query={modelQuery}
            onQueryChange={setModelQuery}
            selectedModelId={provider.selectedModelId}
            onPick={(modelId) => {
              useConfig.getState().selectModel(provider.slug, modelId);
            }}
            onRemove={(modelId) => {
              useConfig.getState().removeModel(provider.slug, modelId);
            }}
            reveal={reveal}
          />
          {provider.hiddenModelIds.length > 0 ? (
            <Pressable
              style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : undefined]}
              onPress={() => useConfig.getState().restoreHiddenModels(provider.slug)}
              accessibilityRole="button"
            >
              <Text style={styles.chipText}>Restore hidden models</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}

      <Field
        label="Model id to add"
        value={newModelId}
        onChangeText={setNewModelId}
        autoCapitalize="none"
        autoCorrect={false}
        reveal={reveal}
      />
      <View style={styles.buttonRow}>
        <Pressable
          style={({ pressed }) => [
            styles.secondaryButton,
            newModelId.trim().length === 0 ? styles.buttonDisabled : undefined,
            pressed ? styles.pressed : undefined,
          ]}
          onPress={addTypedModel}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryButtonText}>Add model</Text>
        </Pressable>
        {listingSupported ? (
          <Pressable
            style={({ pressed }) => [
              styles.secondaryButton,
              listing ? styles.buttonDisabled : undefined,
              pressed ? styles.pressed : undefined,
            ]}
            onPress={listFromServer}
            disabled={listing}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryButtonText}>
              {listing ? 'Listing…' : 'List models from server'}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {listError !== null ? <Text style={styles.testFail}>{listError}</Text> : null}

      <Field
        label="Base URL"
        value={baseUrl}
        onChangeText={(text) => {
          setBaseUrl(text);
          setTestResult(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        reveal={reveal}
      />
      <View style={styles.buttonRow}>
        <Pressable
          style={({ pressed }) => [styles.secondaryButton, pressed ? styles.pressed : undefined]}
          onPress={() => applyEndpoint(baseUrl)}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryButtonText}>Apply endpoint</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : undefined]}
          onPress={() => {
            setBaseUrl(dialectDefaultBaseUrl(dialect));
            applyEndpoint(dialectDefaultBaseUrl(dialect));
          }}
          accessibilityRole="button"
        >
          <Text style={styles.chipText}>Vendor default</Text>
        </Pressable>
      </View>

      {choices.length > 1 ? (
        <View style={styles.chipRow}>
          {choices.map((choice) => (
            <Pressable
              key={choice.baseUrl}
              style={({ pressed }) => [
                styles.chip,
                draft.baseUrl === choice.baseUrl ? styles.chipOn : undefined,
                pressed ? styles.chipPressed : undefined,
              ]}
              onPress={() => applyEndpoint(choice.baseUrl)}
              accessibilityRole="button"
              accessibilityState={{ selected: draft.baseUrl === choice.baseUrl }}
            >
              <Text style={draft.baseUrl === choice.baseUrl ? styles.chipTextOn : styles.chipText}>
                {choice.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

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

      {active !== undefined ? (
        <>
          <View style={styles.chipRow}>
            {CAPABILITIES.map((option) => (
              <Pressable
                key={option.key}
                style={({ pressed }) => [
                  styles.chip,
                  active.capabilities[option.key] ? styles.chipOn : undefined,
                  pressed ? styles.chipPressed : undefined,
                ]}
                onPress={() => toggleCapability(option.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: active.capabilities[option.key] }}
              >
                <Text
                  style={active.capabilities[option.key] ? styles.chipTextOn : styles.chipText}
                >
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <Field
            label="Context window (tokens)"
            value={String(active.contextWindow ?? 32768)}
            onChangeText={(text) =>
              overrideActive({ contextWindow: Number(text) || undefined })
            }
            keyboardType="number-pad"
            reveal={reveal}
          />
        </>
      ) : null}

      <Text style={styles.preview}>{endpointPreview(draftActive)}</Text>
      <Text style={styles.note}>
        request budget: prompt ≤ {budget.inputBudget}, answer {budget.maxOutputTokens}
      </Text>
      {active?.pricing !== undefined ? (
        <Text style={styles.note}>{formatPrice(active.pricing)}</Text>
      ) : null}
      {provider.note !== undefined ? <Text style={styles.warn}>{provider.note}</Text> : null}

      {apiKeyRef.trim().length > 0 ? (
        <>
          <Field
            label="API key ref"
            value={apiKeyRef}
            onChangeText={(text) => {
              setApiKeyRef(text);
              patch({ apiKeyRef: text.trim() || undefined });
            }}
            autoCapitalize="none"
            reveal={reveal}
          />
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
              accessibilityLabel="API key"
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
                style={({ pressed }) => [
                  styles.dangerButton,
                  pressed ? styles.dangerPressed : undefined,
                ]}
                onPress={clearKey}
                accessibilityRole="button"
              >
                <Text style={styles.dangerButtonText}>Clear</Text>
              </Pressable>
            ) : null}
          </View>
        </>
      ) : null}

      {canProbe ? (
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
            accessibilityLabel={`Test ${provider.name}`}
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
      ) : null}

      {testResult !== null ? (
        <Text style={testResult.ok ? styles.testOk : styles.testFail}>
          {describeConnection(draftActive, testResult)}
        </Text>
      ) : null}

      <Pressable
        style={({ pressed }) => [styles.dangerButton, pressed ? styles.dangerPressed : undefined]}
        onPress={() => useConfig.getState().removeProvider(provider.slug)}
        accessibilityRole="button"
        accessibilityLabel={`Delete ${provider.name}`}
      >
        <Text style={styles.dangerButtonText}>Delete this provider</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 8,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    padding: 12,
    backgroundColor: theme.surface,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
    color: theme.text,
  },
  badge: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.accentText,
  },
  selected: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.accentText,
  },
  modelRow: {
    gap: 2,
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.accentSoft,
  },
  note: {
    fontSize: 12,
    color: theme.muted,
  },
  warn: {
    fontSize: 12,
    color: theme.warn,
  },
  preview: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: theme.muted,
  },
  pressed: {
    backgroundColor: theme.accentSoft,
    borderColor: theme.accent,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  chipOn: {
    backgroundColor: theme.accent,
    borderColor: theme.accent,
  },
  chipPressed: {
    borderWidth: 2,
    borderColor: theme.accent,
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
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  secondaryButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.accent,
    backgroundColor: theme.surface,
    minHeight: 40,
    justifyContent: 'center',
  },
  secondaryButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.accentText,
  },
  buttonDisabled: {
    opacity: 0.5,
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
  dangerPressed: {
    backgroundColor: theme.dangerPressed,
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
  keyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  field: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 14,
    color: theme.text,
    backgroundColor: theme.surface,
  },
});
