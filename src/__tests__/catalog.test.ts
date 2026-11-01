import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  catalogCount,
  catalogProvider,
  describeProviderModel,
  endpointChoices,
  FEATURED_SLUGS,
  formatPrice,
  MAX_CATALOG_RESULTS,
  MAX_MODEL_RESULTS,
  modelsForProvider,
  providerInputFromCatalog,
  searchCatalog,
  searchProviderModels,
} from '../core/catalog-search';
import { activeDescriptor, type ProviderConfig } from '../core/model';
import { PROVIDER_CATALOG, type CatalogProvider } from '../core/provider-catalog';
import { needsSessionHeader } from '../core/session';
import { DEFAULT_PROVIDERS, OPENCODE_GO_BASE_URL, useConfig } from '../store/config';

// SQLite is native; the provider store is exercised through the in-memory state.
vi.mock('../store/db', () => ({
  getJson: async () => null,
  setJson: async () => undefined,
  deleteKey: async () => undefined,
}));

beforeEach(() => {
  useConfig.setState({
    providers: DEFAULT_PROVIDERS,
    selectedSlug: DEFAULT_PROVIDERS[0].slug,
    loaded: true,
  });
});

/** A provider row the picker can hand to the store. */
function fakeCatalogEntry(patch: Partial<CatalogProvider> = {}): CatalogProvider {
  return {
    slug: 'llama.cpp',
    name: 'llama-server',
    dialect: 'openai-compatible',
    baseUrl: 'http://localhost:8080/v1',
    source: 'local-server',
    modelId: 'model',
    modelName: 'llama-server model',
    models: [
      {
        id: 'model',
        name: 'llama-server model',
        contextWindow: 32768,
        capabilities: { tools: true, vision: false, reasoning: false },
      },
    ],
    ...patch,
  };
}

function providerFor(slug: string, patch: Partial<ProviderConfig> = {}): ProviderConfig {
  const entry = catalogProvider(slug);

  return {
    slug,
    name: entry?.name ?? slug,
    dialect: entry?.dialect ?? 'openai-compatible',
    baseUrl: entry?.baseUrl ?? 'https://example.test/v1',
    source: entry?.source ?? 'remote',
    apiKeyRef: entry?.apiKeyRef,
    endpoints: entry?.endpoints,
    extraModels: [],
    hiddenModelIds: [],
    selectedModelId: entry?.modelId ?? 'model',
    ...patch,
  };
}

describe('provider catalog', () => {
  it('lists only dialects the app can drive, with reachable endpoints', () => {
    const driven = new Set([
      'openai-chat',
      'openai-responses',
      'anthropic-messages',
      'gemini-generate-content',
      'openai-compatible',
    ]);

    for (const provider of PROVIDER_CATALOG) {
      expect(driven.has(provider.dialect)).toBe(true);
      expect(provider.baseUrl).toMatch(/^https?:\/\//);
      expect(provider.baseUrl).not.toMatch(/[${}]/);
      expect(provider.baseUrl).not.toMatch(/\/$/);
      expect(provider.modelId.length).toBeGreaterThan(0);
      // Key slots must be valid SecureStore names.
      if (provider.apiKeyRef !== undefined) {
        expect(provider.apiKeyRef).toMatch(/^[a-zA-Z0-9._-]+$/);
      }
      if (provider.source === 'local-server') {
        expect(provider.apiKeyRef).toBeUndefined();
      }
    }
  });

  it('carries a model list per provider so switching needs no new profile', () => {
    for (const provider of PROVIDER_CATALOG) {
      expect(provider.models.length).toBeGreaterThan(0);
      // The suggested model must be one the switcher can offer.
      expect(provider.models.some((model) => model.id === provider.modelId)).toBe(true);
    }

    // Gateways carry hundreds of models; browsing them is what the picker is for.
    expect((catalogProvider('openrouter')?.models.length ?? 0)).toBeGreaterThan(100);
  });

  it('drops deprecated models and keeps the newest first', () => {
    const models = catalogProvider('openrouter')?.models ?? [];
    const ids = new Set(models.map((model) => model.id));

    expect(ids.size).toBe(models.length);
    expect(models.every((model) => typeof model.id === 'string')).toBe(true);
    // `updated` is only absent when models.dev has no date, so ordering is stable.
    const dated = models.filter((model) => model.updated !== undefined);
    expect(dated.length).toBeGreaterThan(0);
    // Dates are compared as ISO strings, which sort the same way they parse.
    expect((dated[0]?.updated ?? '') >= (dated[dated.length - 1]?.updated ?? '')).toBe(true);
  });

  it('lists free models and flags them by cost, not by the id suffix', () => {
    const free = PROVIDER_CATALOG.flatMap((provider) => provider.models).filter(
      (model) => model.free === true,
    );

    expect(free.length).toBeGreaterThan(100);
    // The flag is the price, so a free row can never quote a rate.
    for (const model of free) {
      expect((model.pricing?.inputPer1k ?? 0) + (model.pricing?.outputPer1k ?? 0)).toBe(0);
    }
    // `big-pickle` is free without a `-free` id, so suffix filtering would miss it.
    const byId = new Map((catalogProvider('opencode')?.models ?? []).map((model) => [model.id, model]));
    expect(byId.get('big-pickle')?.free).toBe(true);
    expect(byId.get('deepseek-v4.1-flash')?.free).toBeUndefined();
  });

  it('keeps free models off the suggested model of a gateway that restricts the tier', () => {
    for (const slug of ['opencode', 'opencode-go']) {
      const provider = catalogProvider(slug);
      const models = provider?.models ?? [];
      const free = models.filter((model) => model.free === true);

      // Listed, so the user can choose one knowingly.
      expect(free.length).toBeGreaterThan(0);
      // Never first: a restricted tier answers 403, and a new provider should not
      // start on a model that may fail.
      const suggested = models.find((model) => model.id === provider?.modelId);

      expect(suggested?.free).toBeUndefined();
      expect((suggested?.pricing?.inputPer1k ?? 0)).toBeGreaterThan(0);
      // The shipped Go provider starts on the paid DeepSeek, whose free twin is
      // listed separately as `deepseek-v4.1-flash-free`.
      expect(models.some((model) => model.id === 'deepseek-v4.1-flash')).toBe(true);
      expect(models.some((model) => model.id === 'beam-free' && model.free === true)).toBe(true);
    }
  });

  it('covers the gateways and vendors users ask for by name', () => {
    const slugs = new Set(PROVIDER_CATALOG.map((provider) => provider.slug));

    for (const slug of [
      'openrouter',
      'opencode',
      'opencode-go',
      'openai',
      'anthropic',
      'google',
      'groq',
      'ollama',
      'lmstudio',
      'mistral',
      'xai',
      'deepseek',
      'vercel',
      'huggingface',
    ]) {
      expect(slugs.has(slug)).toBe(true);
    }
  });

  it('points OpenAI-compatible gateways at endpoints that accept chat completions', () => {
    expect(catalogProvider('openrouter')?.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(catalogProvider('groq')?.baseUrl).toBe('https://api.groq.com/openai/v1');
    // models.dev lists only the Agent API for Perplexity; its `/v1` is Responses-only.
    expect(catalogProvider('perplexity-agent')?.baseUrl).toBe('https://api.perplexity.ai/v1');
    expect(catalogProvider('perplexity-agent')?.dialect).toBe('openai-responses');
    // The package-backed entry has no endpoint to drive, so it is not listed.
    expect(catalogProvider('perplexity')).toBeUndefined();
    expect(catalogProvider('anthropic')?.dialect).toBe('anthropic-messages');
    expect(catalogProvider('google')?.dialect).toBe('gemini-generate-content');
  });

  it('flags presets that need editing before they can connect', () => {
    expect(catalogProvider('azure')?.note).toContain('YOUR-RESOURCE');
    expect(catalogProvider('ollama')?.note).toContain('loaded');
  });
});

describe('searchCatalog', () => {
  it('surfaces featured providers first when nothing is typed', () => {
    const results = searchCatalog('');

    expect(results.length).toBeLessThanOrEqual(MAX_CATALOG_RESULTS);
    expect(results[0]?.slug).toBe(FEATURED_SLUGS[0]);
    expect(results.map((provider) => provider.slug)).toContain('openrouter');
  });

  it('caps the list and reports the full match count', () => {
    expect(searchCatalog('').length).toBe(MAX_CATALOG_RESULTS);
    expect(catalogCount('')).toBe(PROVIDER_CATALOG.length);
  });

  it('matches on name, slug, endpoint and the model list', () => {
    expect(searchCatalog('groq').map((p) => p.slug)).toContain('groq');
    expect(searchCatalog('OpenRouter').map((p) => p.slug)).toContain('openrouter');
    expect(searchCatalog('api.groq.com').map((p) => p.slug)).toContain('groq');
    expect(searchCatalog('claude-haiku').map((p) => p.slug)).toContain('anthropic');
    expect(catalogCount('zzzz-not-a-provider')).toBe(0);
  });

  it('finds the local servers', () => {
    const local = searchCatalog('localhost');

    expect(local.length).toBeGreaterThan(0);
    for (const provider of local) {
      expect(provider.source).toBe('local-server');
    }
  });
});

describe('modelsForProvider', () => {
  it('offers the catalog list for an untouched provider', () => {
    const provider = providerFor('openrouter');
    const models = modelsForProvider(provider);

    expect(models.length).toBe(catalogProvider('openrouter')?.models.length);
    expect(models.every((model) => model.added !== true)).toBe(true);
    expect(models.some((model) => model.modelId === provider.selectedModelId)).toBe(true);
  });

  it('hides catalog models and restores them', () => {
    const catalog = catalogProvider('openrouter')?.models ?? [];
    const [first] = catalog;
    const provider = providerFor('openrouter', { hiddenModelIds: [first?.id ?? 'model'] });
    const models = modelsForProvider(provider);

    expect(models.some((model) => model.modelId === first?.id)).toBe(false);
    expect(models.length).toBe(catalog.length - 1);
  });

  it('lets an edit override a catalog row of the same id', () => {
    const provider = providerFor('openrouter', {
      extraModels: [
        {
          modelId: catalogProvider('openrouter')?.modelId ?? 'model',
          label: 'edited ctx',
          contextWindow: 8192,
          capabilities: { tools: false, vision: false, reasoning: false },
          added: true,
          edited: true,
        },
      ],
    });
    const models = modelsForProvider(provider);
    const edited = models.find((model) => model.modelId === provider.selectedModelId);

    expect(models.length).toBe(catalogProvider('openrouter')?.models.length);
    expect(edited?.contextWindow).toBe(8192);
    expect(edited?.label).toBe('edited ctx');
    // The id is still one the catalog carries, so it is not shown as typed.
    expect(edited?.added).toBe(false);
  });

  it('lets the catalog win over a row an older build stored', () => {
    // What a migrated profile carries: a guessed context window and capability
    // set for a model the catalog knows. Letting that shadow the catalog is what
    // reported `vision: false` on a vision model and disabled image input.
    const catalog = catalogProvider('opencode-go')?.models.find((model) => model.id === 'mimo-v2.6-flash');
    const provider = providerFor('opencode-go', {
      extraModels: [
        {
          modelId: 'mimo-v2.6-flash',
          label: 'mimo-v2.6-flash',
          contextWindow: 16_384,
          capabilities: { tools: true, vision: false, reasoning: true },
          added: true,
        },
      ],
    });
    const merged = modelsForProvider(provider).find((model) => model.modelId === 'mimo-v2.6-flash');

    expect(merged?.contextWindow).toBe(catalog?.contextWindow);
    expect(merged?.capabilities.vision).toBe(true);
    expect(merged?.added).not.toBe(true);
  });

  it('appends models a server listed that the catalog does not carry', () => {
    const provider = providerFor('ollama', {
      extraModels: [
        { modelId: 'qwen3.5:9b', label: 'qwen3.5:9b', capabilities: { tools: true, vision: false, reasoning: true }, added: true },
      ],
    });

    expect(modelsForProvider(provider).map((model) => model.modelId)).toContain('qwen3.5:9b');
  });
});

describe('searchProviderModels', () => {
  it('caps the rows and narrows on typing', () => {
    const provider = providerFor('openrouter');
    const part = provider.selectedModelId.slice(0, 4);

    expect(searchProviderModels(provider, '').length).toBe(MAX_MODEL_RESULTS);
    expect(searchProviderModels(provider, part).length).toBeGreaterThan(0);
    expect(
      searchProviderModels(provider, part).every(
        (model) =>
          model.modelId.toLowerCase().includes(part) || model.label.toLowerCase().includes(part),
      ),
    ).toBe(true);
    expect(searchProviderModels(provider, 'zzzz-no-such-model')).toHaveLength(0);
  });

  it('describes a model in one line', () => {
    const model = modelsForProvider(providerFor('openrouter'))[0];
    const line = describeProviderModel(model);

    expect(line).toContain('ctx');
    expect(line).toContain('per 1k');
  });
});

describe('endpointChoices', () => {
  it('offers only the endpoint Go answers on', () => {
    // One endpoint, so the chips are just the current one: no switcher.
    expect(endpointChoices(providerFor('opencode-go')).map((choice) => choice.baseUrl)).toEqual([
      OPENCODE_GO_BASE_URL,
    ]);

    // A provider with no known choices still gets its own endpoint and, for a
    // remote one, the dialect's vendor origin.
    const lmstudio = providerFor('lmstudio');

    expect(endpointChoices(lmstudio)).toEqual([
      { baseUrl: 'http://127.0.0.1:1234/v1', label: 'current endpoint' },
    ]);
  });
});

describe('OpenCode defaults', () => {
  it('ships one Go provider on the zen gateway, which needs the session header', () => {
    const go = DEFAULT_PROVIDERS.find((provider) => provider.slug === 'opencode-go');

    expect(go?.baseUrl).toBe(OPENCODE_GO_BASE_URL);
    expect(go?.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(go?.endpoints).toBeUndefined();
    expect(go?.apiKeyRef).toBe('opencode-go-api-key');
    expect(needsSessionHeader(go?.baseUrl ?? '')).toBe(true);
  });

  it('starts each built-in provider on a model it offers', () => {
    for (const provider of DEFAULT_PROVIDERS) {
      const models = modelsForProvider(provider);

      expect(models.length).toBeGreaterThan(0);
      expect(models.some((model) => model.modelId === provider.selectedModelId)).toBe(true);
    }
  });
});

describe('descriptorFor', () => {
  it('flattens provider + model into the request shape', () => {
    const provider = providerFor('openrouter');
    const model = modelsForProvider(provider).find(
      (candidate) => candidate.modelId === provider.selectedModelId,
    );
    const descriptor = activeDescriptor(provider, modelsForProvider(provider));

    expect(descriptor.id).toBe(`openrouter:${provider.selectedModelId}`);
    expect(descriptor.modelId).toBe(provider.selectedModelId);
    expect(descriptor.label).toContain('OpenRouter');
    expect(descriptor.baseUrl).toBe(provider.baseUrl);
    expect(descriptor.apiKeyRef).toBe('openrouter-api-key');
    expect(descriptor.capabilities).toEqual(model?.capabilities);
    expect(descriptor.contextWindow).toEqual(model?.contextWindow);
    expect(descriptor.maxOutputTokens).toEqual(model?.outputWindow);
  });

  it('carries the free flag onto the descriptor the chat uses', () => {
    const provider = providerFor('opencode-go');
    const free = modelsForProvider(provider).find((model) => model.free === true);

    expect(free).toBeDefined();
    const descriptor = activeDescriptor(provider, [free!]);

    expect(descriptor.free).toBe(true);
    // The free tier is answered by the gateway's own endpoint, so switching to it
    // does not move the request anywhere else.
    expect(descriptor.baseUrl).toBe(provider.baseUrl);
    expect(descriptor.pricing).toEqual({ inputPer1k: 0, outputPer1k: 0 });
  });
});

describe('formatPrice', () => {
  it('reads sub-cent rates without rounding to zero', () => {
    expect(formatPrice({ inputPer1k: 0.25, outputPer1k: 2 })).toBe('$0.25 / $2.00 per 1k');
    expect(formatPrice({ inputPer1k: 0.000015, outputPer1k: 0.0006 })).toBe(
      '$0.000015 / $0.0006 per 1k',
    );
    expect(formatPrice({ inputPer1k: 0, outputPer1k: 0 })).toBe('free / free per 1k');
    expect(formatPrice(undefined)).toBe('price unknown');
  });
});

describe('providerInputFromCatalog', () => {
  it('carries endpoint, dialect, suggested model and key slot', () => {
    const openrouter = catalogProvider('openrouter') as CatalogProvider;
    const input = providerInputFromCatalog(openrouter);

    expect(input.source).toBe('remote');
    expect(input.dialect).toBe('openai-compatible');
    expect(input.baseUrl).toBe(openrouter.baseUrl);
    expect(input.modelId).toBe(openrouter.modelId);
    expect(input.slug).toBe('openrouter');
    expect(input.apiKeyRef).toBe('openrouter-api-key');
    expect(input.name).toContain('OpenRouter');
    expect(input.endpoints).toBeUndefined();
  });

  it('adds a provider keyed by the catalog slug without selecting it', () => {
    const openrouter = catalogProvider('openrouter') as CatalogProvider;
    const provider = useConfig.getState().addProvider(providerInputFromCatalog(openrouter));

    expect(provider.slug).toBe('openrouter');
    expect(provider.apiKeyRef).toBe('openrouter-api-key');
    expect(provider.selectedModelId).toBe(openrouter.modelId);
    expect(provider.extraModels).toHaveLength(0);
    expect(useConfig.getState().selectedSlug).toBe(DEFAULT_PROVIDERS[0].slug);
    // Its whole catalog list is available to switch to.
    expect(modelsForProvider(provider).length).toBe(openrouter.models.length);
  });

  it('keeps one credential slot when a provider is added twice', () => {
    const input = providerInputFromCatalog(catalogProvider('openrouter') as CatalogProvider);

    const first = useConfig.getState().addProvider(input);
    const second = useConfig.getState().addProvider(input);

    expect(second.slug).toBe(`${first.slug}-2`);
    expect(second.apiKeyRef).toBe(first.apiKeyRef);
  });

  it('adds a LAN server with no credential slot', () => {
    const provider = useConfig
      .getState()
      .addProvider(providerInputFromCatalog(catalogProvider('ollama') as CatalogProvider));

    expect(provider.source).toBe('local-server');
    expect(provider.apiKeyRef).toBeUndefined();
    expect(provider.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('sanitizes slugs that are not printable id characters', () => {
    const provider = useConfig.getState().addProvider(providerInputFromCatalog(fakeCatalogEntry()));

    expect(provider.slug).toMatch(/^llama\.cpp(-\d+)?$/);
  });

  it('stores a typed model the catalog does not carry', () => {
    const provider = useConfig.getState().addProvider({
      source: 'remote',
      dialect: 'openai-compatible',
      name: 'Gateway with my model',
      slug: 'my-gateway',
      modelId: 'my-model',
      modelLabel: 'My model',
      contextWindow: 16384,
    });

    expect(provider.extraModels.map((model) => model.modelId)).toEqual(['my-model']);
    expect(provider.extraModels[0]?.label).toBe('My model');
    expect(provider.selectedModelId).toBe('my-model');
    expect(modelsForProvider(provider).map((model) => model.modelId)).toEqual(['my-model']);
  });
});
