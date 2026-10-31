import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  catalogCount,
  catalogProvider,
  FEATURED_SLUGS,
  formatPrice,
  MAX_CATALOG_RESULTS,
  profileInputFromCatalog,
  searchCatalog,
} from '../core/catalog-search';
import { PROVIDER_CATALOG, type CatalogProvider } from '../core/provider-catalog';
import { DEFAULT_MODELS, useConfig } from '../store/config';

// SQLite is native; the registry store is exercised through the in-memory state.
jest.mock('../store/db', () => ({
  getJson: async () => null,
  setJson: async () => undefined,
  deleteKey: async () => undefined,
}));

beforeEach(() => {
  useConfig.setState({ models: DEFAULT_MODELS, selectedId: DEFAULT_MODELS[0].id, loaded: true });
});

describe('provider catalog', () => {
  it('lists only dialects the app can drive, with reachable endpoints', () => {
    const driven = new Set(['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini-generate-content', 'openai-compatible']);

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
    expect(catalogProvider('perplexity')?.baseUrl).toBe('https://api.perplexity.ai/orchestrator/v1');
    // The Agent API only takes the Responses shape.
    expect(catalogProvider('perplexity-agent')?.dialect).toBe('openai-responses');
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

  it('matches on name, slug, endpoint and model id', () => {
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

describe('formatPrice', () => {
  it('reads sub-cent rates without rounding to zero', () => {
    expect(formatPrice({ inputPer1k: 0.25, outputPer1k: 2 })).toBe('$0.25 / $2.00 per 1k');
    expect(formatPrice({ inputPer1k: 0.000015, outputPer1k: 0.0006 })).toBe('$0.000015 / $0.0006 per 1k');
    expect(formatPrice({ inputPer1k: 0, outputPer1k: 0 })).toBe('free / free per 1k');
    expect(formatPrice(undefined)).toBe('price unknown');
  });
});

describe('profileInputFromCatalog', () => {
  it('carries endpoint, model, context window and key slot', () => {
    const openrouter = catalogProvider('openrouter') as CatalogProvider;
    const input = profileInputFromCatalog(openrouter);

    expect(input.source).toBe('remote');
    expect(input.baseUrl).toBe(openrouter.baseUrl);
    expect(input.modelId).toBe(openrouter.modelId);
    expect(input.contextWindow).toBe(openrouter.contextWindow);
    expect(input.capabilities).toEqual(openrouter.capabilities);
    expect(input.providerSlug).toBe('openrouter');
    expect(input.apiKeyRef).toBe('openrouter-api-key');
    expect(input.label).toContain('OpenRouter');
  });

  it('creates a profile keyed by the provider slug', () => {
    const openrouter = catalogProvider('openrouter') as CatalogProvider;
    const profile = useConfig.getState().createProfile(profileInputFromCatalog(openrouter));

    expect(profile.id).toBe(`openrouter:${openrouter.modelId}`);
    expect(profile.apiKeyRef).toBe('openrouter-api-key');
    expect(profile.pricing).toEqual(openrouter.pricing);
    expect(profile.note).toBe(openrouter.note);
    expect(useConfig.getState().selectedId).toBe(DEFAULT_MODELS[0].id);
  });

  it('reuses one credential slot when a provider is added twice', () => {
    const openrouter = catalogProvider('openrouter') as CatalogProvider;
    const input = profileInputFromCatalog(openrouter);

    const first = useConfig.getState().createProfile(input);
    const second = useConfig.getState().createProfile(input);

    expect(second.id).toBe(`${first.id}-2`);
    expect(second.apiKeyRef).toBe(first.apiKeyRef);
  });

  it('adds a LAN server with no credential slot', () => {
    const ollama = catalogProvider('ollama') as CatalogProvider;
    const profile = useConfig.getState().createProfile(profileInputFromCatalog(ollama));

    expect(profile.source).toBe('local-server');
    expect(profile.apiKeyRef).toBeUndefined();
    expect(profile.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('sanitizes slugs that are not printable id characters', () => {
    const input = profileInputFromCatalog({
      slug: 'llama.cpp',
      name: 'llama-server',
      dialect: 'openai-compatible',
      baseUrl: 'http://localhost:8080/v1',
      source: 'local-server',
      modelId: 'model',
      modelName: 'llama-server model',
      capabilities: { tools: true, vision: false, reasoning: false },
    });

    expect(useConfig.getState().createProfile(input).id).toBe('llama.cpp:model');
  });
});
