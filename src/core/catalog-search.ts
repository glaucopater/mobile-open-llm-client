/**
 * Search over the generated provider catalog.
 *
 * The catalog is ~220 entries, so the picker shows a capped list of matches
 * instead of rendering every provider. Empty queries list the featured
 * providers first, then the rest alphabetically, so the common ones are
 * reachable without typing.
 */
import { PROVIDER_CATALOG, type CatalogProvider } from './provider-catalog';
import { sanitizeKeyRef, type ModelPricing } from './model';
import type { NewProfileInput } from '../store/config';

/** Providers worth surfacing before the alphabetical tail. */
export const FEATURED_SLUGS = [
  'openrouter',
  'opencode',
  'opencode-go',
  'openai',
  'anthropic',
  'google',
  'groq',
  'ollama',
  'ollama-cloud',
  'lmstudio',
  'mistral',
  'xai',
  'deepseek',
  'togetherai',
  'cerebras',
  'fireworks-ai',
  'huggingface',
  'vercel',
  'novita-ai',
  'sambanova',
  'perplexity',
  'llama.cpp',
  'vllm',
  'mlx',
];

const FEATURED_ORDER = new Map(FEATURED_SLUGS.map((slug, index) => [slug, index]));

/** Rows the picker renders at once; typing narrows the rest. */
export const MAX_CATALOG_RESULTS = 60;

export function catalogProvider(slug: string): CatalogProvider | undefined {
  return PROVIDER_CATALOG.find((provider) => provider.slug === slug);
}

/** Case-insensitive match on name, slug, endpoint and suggested model. */
function matches(provider: CatalogProvider, query: string): boolean {
  return (
    provider.name.toLowerCase().includes(query) ||
    provider.slug.toLowerCase().includes(query) ||
    provider.baseUrl.toLowerCase().includes(query) ||
    provider.modelId.toLowerCase().includes(query) ||
    provider.dialect.toLowerCase().includes(query)
  );
}

export function searchCatalog(query: string, limit = MAX_CATALOG_RESULTS): CatalogProvider[] {
  const q = query.trim().toLowerCase();
  const pool = q.length === 0 ? PROVIDER_CATALOG : PROVIDER_CATALOG.filter((p) => matches(p, q));

  const rank = (provider: CatalogProvider) => FEATURED_ORDER.get(provider.slug) ?? Number.MAX_SAFE_INTEGER;
  const scored = pool.map((provider, index) => ({ provider, rank: rank(provider), index }));
  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      (a.rank === Number.MAX_SAFE_INTEGER ? a.provider.name.localeCompare(b.provider.name, 'en') : 0) ||
      a.index - b.index,
  );

  return scored.slice(0, limit).map(({ provider }) => provider);
}

export function catalogCount(query: string): number {
  const q = query.trim().toLowerCase();

  return q.length === 0 ? PROVIDER_CATALOG.length : PROVIDER_CATALOG.filter((p) => matches(p, q)).length;
}

/** Prices are stored per 1k tokens; tiny rates keep their significant digits. */
export function formatPrice(pricing?: ModelPricing): string {
  if (pricing === undefined) {
    return 'price unknown';
  }

  const per = (value: number) => {
    if (value === 0) return 'free';
    if (value >= 0.01) return `$${value.toFixed(2)}`;

    return `$${String(Number(value.toPrecision(3)))}`;
  };

  return `${per(pricing.inputPer1k)} / ${per(pricing.outputPer1k)} per 1k`;
}

/** Turns a catalog entry into the store's create-profile input. */
export function profileInputFromCatalog(provider: CatalogProvider): NewProfileInput {
  return {
    source: provider.source,
    dialect: provider.dialect,
    label: `${provider.name} · ${provider.modelName}`,
    modelId: provider.modelId,
    baseUrl: provider.baseUrl,
    contextWindow: provider.contextWindow,
    capabilities: provider.capabilities,
    pricing: provider.pricing,
    // The slug is sanitized the same way key names are, so ids stay printable.
    providerSlug: sanitizeKeyRef(provider.slug) || 'provider',
    apiKeyRef: provider.apiKeyRef,
    note: provider.note,
  };
}
