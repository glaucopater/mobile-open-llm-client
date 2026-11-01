import { beforeEach, describe, expect, it, vi } from 'vitest';

import { catalogProvider, modelsForProvider, providerInputFromCatalog } from '../core/catalog-search';
import type { CatalogProvider } from '../core/provider-catalog';
import { activeDescriptor, type ModelDescriptor, type ProviderConfig } from '../core/model';
import { DEFAULT_PROVIDERS, LOCAL_SERVER_DEFAULT_BASE_URL, OPENCODE_GO_BASE_URL, resetConfig, useConfig } from '../store/config';

// SQLite is native, so the store is stubbed with a plain map. `vi.mock` is
// hoisted above the imports; the map is built at import time and read only
// inside the stub's own call bodies.
const mockRows = new Map<string, unknown>();

vi.mock('../store/db', () => ({
  getJson: async (key: string) => (mockRows.has(key) ? mockRows.get(key) : null),
  setJson: async (key: string, value: unknown) => {
    mockRows.set(key, value);
  },
  deleteKey: async (key: string) => {
    mockRows.delete(key);
  },
}));

function stored(): {
  schema: number;
  providers: ProviderConfig[];
  selectedSlug: string;
  retiredSlugs?: string[];
} {
  return mockRows.get('provider-config') as {
    schema: number;
    providers: ProviderConfig[];
    selectedSlug: string;
    retiredSlugs?: string[];
  };
}

function provider(slug: string): ProviderConfig | undefined {
  return useConfig.getState().providers.find((row) => row.slug === slug);
}

beforeEach(() => {
  mockRows.clear();
  useConfig.setState({
    providers: DEFAULT_PROVIDERS,
    selectedSlug: DEFAULT_PROVIDERS[0].slug,
    loaded: true,
  });
});

describe('addProvider', () => {
  it('derives a slug and a credential slot for a hand-made provider', () => {
    const added = useConfig.getState().addProvider({
      source: 'remote',
      dialect: 'openai-chat',
      name: 'My Gateway',
      modelId: 'model',
    });

    expect(added.slug).toBe('my-gateway');
    expect(added.apiKeyRef).toBe('my-gateway-api-key');
    expect(added.baseUrl).toBe('https://api.openai.com/v1');
    expect(added.selectedModelId).toBe('model');
    expect(added.extraModels.map((model) => model.modelId)).toEqual(['model']);
  });

  it('stores a typed model without selecting a provider that has no key', () => {
    const before = useConfig.getState().selectedSlug;
    const added = useConfig.getState().addProvider({
      source: 'remote',
      dialect: 'anthropic-messages',
      name: 'Another',
      modelId: 'claude-x',
    });

    expect(useConfig.getState().selectedSlug).toBe(before);
    // A model the catalog does not carry is kept as the user's own entry.
    expect(added.extraModels.map((model) => model.modelId)).toEqual(['claude-x']);
    expect(provider(added.slug)?.extraModels.map((model) => model.modelId)).toEqual(['claude-x']);
  });

  it('selects only when asked to', () => {
    const added = useConfig.getState().addProvider({
      source: 'remote',
      dialect: 'openai-chat',
      name: 'Now this one',
      modelId: 'model',
      select: true,
    });

    expect(useConfig.getState().selectedSlug).toBe(added.slug);
  });

  it('gives a duplicated hand-made provider its own credential slot', () => {
    const input = { source: 'remote', dialect: 'openai-chat', name: 'Dup', modelId: 'model' } as const;

    const first = useConfig.getState().addProvider(input);
    const second = useConfig.getState().addProvider(input);

    expect(second.slug).toBe(`${first.slug}-2`);
    // Hand-made providers own their slot, named after their slug, so two gateways
    // never share a key by accident. Catalog providers keep the catalog's slot.
    expect(second.apiKeyRef).toBe('dup-2-api-key');
  });

  it('uses the LAN endpoint for a local server', () => {
    const added = useConfig.getState().addProvider({
      source: 'local-server',
      dialect: 'openai-compatible',
      name: 'LAN box',
      modelId: 'model',
    });

    expect(added.baseUrl).toBe(LOCAL_SERVER_DEFAULT_BASE_URL);
    expect(added.apiKeyRef).toBeUndefined();
  });

  it('persists to SQLite on every change', async () => {
    useConfig.getState().addProvider({
      source: 'remote',
      dialect: 'openai-chat',
      name: 'Persisted',
      modelId: 'model',
    });
    await Promise.resolve();

    expect(stored().providers.some((row) => row.slug === 'persisted')).toBe(true);
    expect(stored().schema).toBe(2);
  });
});

describe('updateProvider', () => {
  it('follows the new source only when the endpoint was never customised', () => {
    const added = useConfig.getState().addProvider({
      source: 'remote',
      dialect: 'openai-chat',
      name: 'Flip',
      modelId: 'model',
    });

    useConfig.getState().updateProvider(added.slug, { source: 'local-server' });

    expect(provider(added.slug)?.baseUrl).toBe(LOCAL_SERVER_DEFAULT_BASE_URL);
    expect(provider(added.slug)?.apiKeyRef).toBeUndefined();

    useConfig.getState().updateProvider(added.slug, { source: 'remote' });

    expect(provider(added.slug)?.baseUrl).toBe('https://api.openai.com/v1');
    expect(provider(added.slug)?.apiKeyRef).toBe('flip-api-key');
  });

  it('keeps an endpoint the user typed when the source flips', () => {
    const added = useConfig.getState().addProvider({
      source: 'remote',
      dialect: 'openai-chat',
      name: 'Kept',
      modelId: 'model',
      baseUrl: 'http://192.168.178.87:11434/v1',
    });

    useConfig.getState().updateProvider(added.slug, { source: 'local-server' });

    expect(provider(added.slug)?.baseUrl).toBe('http://192.168.178.87:11434/v1');
  });

  it('normalizes the endpoint and never rewrites the slug', () => {
    useConfig.getState().setEndpoint('ollama', 'http://192.168.178.87:11434/v1///');

    expect(provider('ollama')?.baseUrl).toBe('http://192.168.178.87:11434/v1');
  });

  it('keeps one endpoint for Go and rewrites the retired one', () => {
    // The `inference/go` path shipped in earlier builds is not a route Go serves;
    // loading a profile left on it must land on the zen gateway, same key slot.
    useConfig.getState().setEndpoint('opencode-go', 'https://opencode.ai/inference/go/openai/v1');

    const go = provider('opencode-go');

    expect(go?.baseUrl).toBe(OPENCODE_GO_BASE_URL);
    expect(go?.apiKeyRef).toBe('opencode-go-api-key');
    // Nothing offers a second endpoint, so the settings editor shows no switcher.
    expect(go?.endpoints).toBeUndefined();
  });

  it('leaves the other providers untouched', () => {
    const before = useConfig.getState().providers;
    const [, second] = DEFAULT_PROVIDERS;

    useConfig.getState().updateProvider(second.slug, { name: 'Renamed' });

    const after = useConfig.getState().providers;

    expect(after.map((row) => row.slug)).toEqual(before.map((row) => row.slug));
    expect(after.find((row) => row.slug === second.slug)?.name).toBe('Renamed');
    expect(after.find((row) => row.slug !== second.slug)).toEqual(
      before.find((row) => row.slug !== second.slug),
    );
  });
});

describe('model selection', () => {
  it('switches the model and makes its provider the active one', () => {
    useConfig.getState().addProvider(providerInputFromCatalog(catalogProvider('openrouter') as CatalogProvider));
    const modelId = catalogProvider('openrouter')?.models[1]?.id ?? 'model';

    useConfig.getState().selectModel('openrouter', modelId);

    expect(useConfig.getState().selectedSlug).toBe('openrouter');
    expect(provider('openrouter')?.selectedModelId).toBe(modelId);
  });

  it('ignores a provider that does not exist', () => {
    const before = useConfig.getState().selectedSlug;

    useConfig.getState().selectModel('nope', 'model');
    expect(useConfig.getState().selectedSlug).toBe(before);

    useConfig.getState().selectProvider('nope');
    expect(useConfig.getState().selectedSlug).toBe(before);
  });

  it('selecting a provider keeps its model', () => {
    useConfig.getState().selectProvider('anthropic');

    expect(useConfig.getState().selectedSlug).toBe('anthropic');
    expect(provider('anthropic')?.selectedModelId).toBeDefined();
  });

  it('repairs a selection that points at a hidden model', async () => {
    mockRows.set('provider-config', {
      schema: 2,
      providers: [
        {
          slug: 'openrouter',
          name: 'OpenRouter',
          dialect: 'openai-compatible',
          baseUrl: 'https://openrouter.ai/api/v1',
          source: 'remote',
          apiKeyRef: 'openrouter-api-key',
          extraModels: [],
          hiddenModelIds: [DEFAULT_PROVIDERS[0]?.selectedModelId ?? 'model'],
          selectedModelId: 'hidden-model-id',
        },
      ],
      selectedSlug: 'openrouter',
      retiredSlugs: [],
    });

    await useConfig.getState().load();

    const openrouter = provider('openrouter');
    const offered = openrouter?.extraModels.length ?? 0;

    expect(offered).toBe(0);
    expect(
      (useConfig.getState().providers.find((row) => row.slug === 'openrouter')?.selectedModelId ?? '') !==
        'hidden-model-id',
    ).toBe(true);
  });
});

describe('addModels and removeModel', () => {
  it('adds listed server models and selects the first', () => {
    const added = useConfig.getState().addProvider({
      source: 'local-server',
      dialect: 'openai-compatible',
      name: 'Server',
    });

    // A blank provider holds no model until something is typed or listed.
    expect(added.extraModels).toHaveLength(0);
    expect(added.selectedModelId).toBe('');

    useConfig.getState().addModels(added.slug, [
      { modelId: 'qwen3.5:9b', label: 'qwen3.5:9b', capabilities: { tools: true, vision: false, reasoning: true } },
      { modelId: 'llama-3.2', label: 'llama-3.2', capabilities: { tools: true, vision: false, reasoning: false } },
    ]);

    const row = provider(added.slug);

    expect(row?.extraModels.map((model) => model.modelId)).toEqual(['qwen3.5:9b', 'llama-3.2']);
    expect(row?.extraModels[0]?.added).toBe(true);
    expect(row?.selectedModelId).toBe('qwen3.5:9b');
  });

  it('replaces an override of the same model id instead of duplicating it', () => {
    const row = provider('ollama');
    const modelId = row?.selectedModelId ?? 'model';

    useConfig.getState().addModels('ollama', [
      { modelId, label: 'edited', contextWindow: 4096, capabilities: { tools: false, vision: false, reasoning: false } },
    ]);

    expect(provider('ollama')?.extraModels).toHaveLength(1);
    expect(provider('ollama')?.extraModels[0]?.contextWindow).toBe(4096);
  });

  it('deletes a typed model and hides a catalog one', () => {
    useConfig.getState().addProvider(providerInputFromCatalog(catalogProvider('openrouter') as CatalogProvider));
    const added = useConfig.getState().addProvider({
      source: 'remote',
      dialect: 'openai-compatible',
      name: 'Mixed',
      modelId: 'typed-model',
    });

    useConfig.getState().removeModel(added.slug, 'typed-model');

    expect(provider(added.slug)?.extraModels).toHaveLength(0);
    expect(provider(added.slug)?.hiddenModelIds).toEqual([]);

    const catalogModel = catalogProvider('openrouter')?.models[0]?.id ?? 'model';
    useConfig.getState().removeModel('openrouter', catalogModel);

    expect(provider('openrouter')?.hiddenModelIds).toEqual([catalogModel]);
  });

  it('moves the selection off a model that was removed', () => {
    const added = useConfig.getState().addProvider({
      source: 'remote',
      dialect: 'openai-compatible',
      name: 'Only one',
      modelId: 'typed-model',
    });

    useConfig.getState().removeModel(added.slug, 'typed-model');

    expect(provider(added.slug)?.selectedModelId).toBe('model');
  });

  it('brings hidden catalog models back', () => {
    useConfig.getState().addProvider(providerInputFromCatalog(catalogProvider('openrouter') as CatalogProvider));
    const catalogModel = catalogProvider('openrouter')?.models[0]?.id ?? 'model';

    useConfig.getState().removeModel('openrouter', catalogModel);
    expect(provider('openrouter')?.hiddenModelIds).toEqual([catalogModel]);

    useConfig.getState().restoreHiddenModels('openrouter');

    expect(provider('openrouter')?.hiddenModelIds).toEqual([]);
  });
});

describe('removeProvider', () => {
  it('drops the provider and moves the selection', () => {
    const [first, second] = DEFAULT_PROVIDERS;

    useConfig.getState().selectProvider(first.slug);
    useConfig.getState().removeProvider(first.slug);

    expect(useConfig.getState().providers.some((row) => row.slug === first.slug)).toBe(false);
    expect(useConfig.getState().selectedSlug).toBe(second.slug);
  });

  it('remembers a deleted built-in so a load does not re-add it', async () => {
    useConfig.getState().removeProvider('opencode-go');
    await Promise.resolve();

    await useConfig.getState().load();

    expect(useConfig.getState().providers.some((row) => row.slug === 'opencode-go')).toBe(false);
    expect(stored().retiredSlugs ?? []).toContain('opencode-go');
  });

  it('keeps a provider the user made deletable without retiring it', async () => {
    const added = useConfig.getState().addProvider({
      source: 'remote',
      dialect: 'openai-chat',
      name: 'Mine',
      modelId: 'model',
    });
    useConfig.getState().removeProvider(added.slug);
    await Promise.resolve();

    await useConfig.getState().load();

    expect(useConfig.getState().providers.some((row) => row.slug === 'mine')).toBe(false);
    expect(stored().retiredSlugs ?? []).not.toContain('mine');
  });
});

describe('load', () => {
  it('starts on the defaults with nothing stored', async () => {
    await useConfig.getState().load();

    expect(useConfig.getState().loaded).toBe(true);
    expect(useConfig.getState().providers.map((row) => row.slug)).toEqual(
      DEFAULT_PROVIDERS.map((row) => row.slug),
    );
  });

  it('appends built-in providers a saved configuration predates', async () => {
    mockRows.set('provider-config', {
      schema: 2,
      providers: [
        {
          slug: 'mine',
          name: 'Mine',
          dialect: 'openai-chat',
          baseUrl: 'https://gateway.test/v1',
          source: 'remote',
          apiKeyRef: 'mine-api-key',
          extraModels: [{ modelId: 'm', label: 'm', capabilities: { tools: true, vision: false, reasoning: false } }],
          hiddenModelIds: [],
          selectedModelId: 'm',
        },
      ],
      selectedSlug: 'mine',
      retiredSlugs: [],
    });

    await useConfig.getState().load();

    const slugs = useConfig.getState().providers.map((row) => row.slug);

    expect(slugs[0]).toBe('mine');
    expect(slugs).toContain('opencode-go');
    expect(useConfig.getState().selectedSlug).toBe('mine');
  });

  it('repairs a selection pointing at a provider that is gone', async () => {
    mockRows.set('provider-config', {
      schema: 2,
      providers: [],
      selectedSlug: 'gone',
      retiredSlugs: [],
    });

    await useConfig.getState().load();

    expect(useConfig.getState().selectedSlug).toBe(DEFAULT_PROVIDERS[0].slug);
  });

  it('migrates a per-model registry into one provider per slug', async () => {
    const legacy: LegacyRegistryShape = {
      models: [
        {
          id: 'ollama:qwen3.5:9b',
          label: 'Ollama · qwen3.5:9b',
          providerLabel: 'Ollama',
          modelLabel: 'qwen3.5:9b',
          dialect: 'openai-compatible',
          modelId: 'qwen3.5:9b',
          baseUrl: 'http://192.168.178.87:11434/v1',
          source: 'local-server',
          capabilities: { tools: true, vision: false, reasoning: true },
          contextWindow: 32768,
        },
        {
          id: 'ollama:llama-3.2',
          label: 'Ollama · llama-3.2',
          providerLabel: 'Ollama',
          modelLabel: 'llama-3.2',
          dialect: 'openai-compatible',
          modelId: 'llama-3.2',
          baseUrl: 'http://192.168.178.87:11434/v1',
          source: 'local-server',
          capabilities: { tools: true, vision: false, reasoning: false },
          contextWindow: 8192,
        },
        {
          id: 'opencode-go:deepseek-v4.1-flash',
          label: 'OpenCode Go · DeepSeek V4.1 Flash',
          providerLabel: 'OpenCode Go',
          modelLabel: 'DeepSeek V4.1 Flash',
          dialect: 'openai-compatible',
          modelId: 'deepseek-v4.1-flash',
          baseUrl: OPENCODE_GO_BASE_URL,
          apiKeyRef: 'opencode-go-api-key',
          headers: { 'x-opencode-session': 'ses_1' },
          source: 'remote',
          capabilities: { tools: true, vision: true, reasoning: true },
          contextWindow: 1000000,
        },
      ],
      selectedId: 'ollama:llama-3.2',
      retiredDefaults: [],
    };

    mockRows.set('model-registry', legacy);

    await useConfig.getState().load();

    const ollama = provider('ollama');

    expect(ollama?.baseUrl).toBe('http://192.168.178.87:11434/v1');
    expect(ollama?.source).toBe('local-server');
    expect(ollama?.selectedModelId).toBe('llama-3.2');
    // A legacy row named itself `Provider · model`; the provider keeps its own name.
    expect(ollama?.name).toBe('Ollama');
    // A model the catalog does not carry is kept as the user's own entry.
    expect(ollama?.extraModels.map((model) => model.modelId)).toContain('llama-3.2');
    // The second row of the same provider became one provider, not two.
    expect(useConfig.getState().providers.filter((row) => row.slug === 'ollama')).toHaveLength(1);

    const go = provider('opencode-go');

    expect(go?.apiKeyRef).toBe('opencode-go-api-key');
    expect(go?.headers).toEqual({ 'x-opencode-session': 'ses_1' });
    // Go answers on one endpoint, so the migrated profile carries no switcher.
    expect(go?.endpoints).toBeUndefined();
    // A catalog model with the catalog's context window is not duplicated.
    expect(go?.extraModels).toHaveLength(0);
    expect(useConfig.getState().selectedSlug).toBe('ollama');
    // The old shape is dropped so a reset does not re-migrate it.
    expect(mockRows.has('model-registry')).toBe(false);
  });

  it('drops the model name from a provider stored in v2 shape', async () => {
    // What the phone holds after an earlier migration: the model is still glued to
    // the provider's name, so the chip and the switch sheet repeat it.
    mockRows.set('provider-config', {
      schema: 2,
      selectedSlug: 'opencode-go-zen-alias',
      retiredSlugs: [],
      providers: [
        {
          slug: 'opencode-go-zen-alias',
          name: 'OpenCode Go (zen alias) · DeepSeek V4.1 Flash',
          dialect: 'openai-compatible',
          baseUrl: 'https://opencode.ai/inference/go/openai/v1',
          source: 'remote',
          apiKeyRef: 'opencode-go-api-key',
          extraModels: [],
          hiddenModelIds: [],
          selectedModelId: 'deepseek-v4.1-flash',
        },
      ],
    });

    await useConfig.getState().load();

    const stored = provider('opencode-go-zen-alias')!;
    const label = activeDescriptor(stored, modelsForProvider(stored)).providerLabel;

    expect(provider('opencode-go-zen-alias')?.name).toBe('OpenCode Go (zen alias)');
    expect(label).toBe('OpenCode Go (zen alias)');
    // The path it was stored on is not a route Go serves; loading moves it to the
    // zen gateway instead of leaving a profile that fails every message.
    expect(stored.baseUrl).toBe(OPENCODE_GO_BASE_URL);
    expect(stored.endpoints).toBeUndefined();
  });

  it('reconnects a migrated gateway profile to its catalogue entry by endpoint', async () => {
    // The phone's real profile: a name-derived slug the catalogue does not know,
    // pointed at the zen gateway. Without the endpoint match none of the gateway's
    // models merge, and every row reads `ctx unset · price unknown`.
    mockRows.set('model-registry', {
      models: [
        {
          id: 'opencode-go-zen-alias:deepseek-v4.1-flash',
          label: 'OpenCode Go (zen alias) · DeepSeek V4.1 Flash',
          providerLabel: 'OpenCode Go (zen alias)',
          modelLabel: 'DeepSeek V4.1 Flash',
          dialect: 'openai-compatible',
          modelId: 'deepseek-v4.1-flash',
          baseUrl: OPENCODE_GO_BASE_URL,
          apiKeyRef: 'opencode-go-api-key',
          source: 'remote',
          capabilities: { tools: true, vision: true, reasoning: true },
          contextWindow: 1000000,
        },
      ],
      selectedId: 'opencode-go-zen-alias:deepseek-v4.1-flash',
      retiredDefaults: [],
    });

    await useConfig.getState().load();

    const go = provider('opencode-go-zen-alias');

    expect(go?.catalogSlug).toBe('opencode-go');
    // The user's own endpoint and key slot stay put.
    expect(go?.baseUrl).toBe(OPENCODE_GO_BASE_URL);
    expect(go?.apiKeyRef).toBe('opencode-go-api-key');
    // The stored name still carried the model; the provider keeps its own part.
    expect(go?.name).toBe('OpenCode Go (zen alias)');
    expect(go?.extraModels).toHaveLength(0);
    // The catalogue's list is what the picker shows, free models included.
    const offered = modelsForProvider(go!);

    expect(offered.length).toBe(catalogProvider('opencode-go')?.models.length);
    expect(offered.some((model) => model.free === true)).toBe(true);
    expect(activeDescriptor(go!, offered).label).toBe(
      'OpenCode Go (zen alias) · DeepSeek V4.1 Flash',
    );
  });

  it('keeps a default the user deleted gone through migration', async () => {
    mockRows.set('model-registry', {
      models: [
        {
          id: 'mine:model',
          label: 'Mine · model',
          providerLabel: 'Mine',
          modelLabel: 'model',
          dialect: 'openai-chat',
          modelId: 'model',
          baseUrl: 'https://gateway.test/v1',
          source: 'remote',
          apiKeyRef: 'mine-api-key',
          capabilities: { tools: true, vision: false, reasoning: false },
          contextWindow: 32768,
        },
      ],
      selectedId: 'mine:model',
      retiredDefaults: ['opencode-go:deepseek-v4.1-flash'],
    });

    await useConfig.getState().load();

    expect(useConfig.getState().providers.some((row) => row.slug === 'opencode-go')).toBe(false);
    expect(useConfig.getState().providers.some((row) => row.slug === 'mine')).toBe(true);
    // The hand-made provider keeps its own name, not `Mine · model`.
    expect(provider('mine')?.name).toBe('Mine');
  });
});

describe('resetConfig', () => {
  it('clears providers and selection but leaves the retired list empty', async () => {
    useConfig.getState().removeProvider('opencode-go');
    await resetConfig();

    expect(mockRows.has('provider-config')).toBe(false);
    expect(useConfig.getState().providers.map((row) => row.slug)).toEqual(
      DEFAULT_PROVIDERS.map((row) => row.slug),
    );
    expect(useConfig.getState().providers.some((row) => row.slug === 'opencode-go')).toBe(true);
  });
});

/** The shape builds before v1.6.0 wrote; used to drive the migration test. */
type LegacyRegistryShape = {
  models: ModelDescriptor[];
  selectedId: string;
  retiredDefaults?: string[];
};
