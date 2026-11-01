/**
 * Search over the generated provider catalog, and the model list a provider
 * offers.
 *
 * The catalog is ~220 providers carrying ~7k models, so both pickers render a
 * capped list of matches and typing narrows the rest. Empty queries list the
 * featured providers first, then the rest alphabetically, so the common ones are
 * reachable without typing.
 *
 * A provider's effective model list is its catalog models minus what the user
 * hid, plus what they typed or read back from a server. Storing only the
 * additions and removals keeps SQLite small and lets `yarn providers:sync`
 * refresh the list under an existing provider.
 */
import { PROVIDER_CATALOG, type CatalogProvider } from './provider-catalog';
import {
  deriveProviderSlug,
  dialectDefaultBaseUrl,
  normalizeBaseUrl,
  sanitizeKeyRef,
  type Dialect,
  type EndpointChoice,
  type ModelPricing,
  type NewProviderInput,
  type ProviderConfig,
  type ProviderModel,
} from './model';

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

/** Rows the provider picker renders at once; typing narrows the rest. */
export const MAX_CATALOG_RESULTS = 60;

/** Rows the model picker renders at once; typing narrows the rest. */
export const MAX_MODEL_RESULTS = 40;

export function catalogProvider(slug: string): CatalogProvider | undefined {
  return PROVIDER_CATALOG.find((provider) => provider.slug === slug);
}

/**
 * Catalog provider that answers at `baseUrl`, on the given dialect. A provider
 * typed before the catalog existed carries the gateway's URL but no catalog slug,
 * and without the slug none of that gateway's models merge into it — so an
 * endpoint match is what reconnects it. Matches the base URL or one of the
 * endpoint choices the provider offers.
 */
export function catalogProviderForEndpoint(baseUrl: string, dialect: Dialect): CatalogProvider | undefined {
  if (baseUrl.trim().length === 0) {
    return undefined;
  }

  const url = normalizeBaseUrl(baseUrl);

  return PROVIDER_CATALOG.find(
    (provider) =>
      provider.source === 'remote' &&
      provider.dialect === dialect &&
      (normalizeBaseUrl(provider.baseUrl) === url ||
        provider.endpoints?.some((endpoint) => normalizeBaseUrl(endpoint.baseUrl) === url) === true),
  );
}

/** Case-insensitive match on name, slug, endpoint and its models. */
function matches(provider: CatalogProvider, query: string): boolean {
  return (
    provider.name.toLowerCase().includes(query) ||
    provider.slug.toLowerCase().includes(query) ||
    provider.baseUrl.toLowerCase().includes(query) ||
    provider.modelId.toLowerCase().includes(query) ||
    provider.dialect.toLowerCase().includes(query) ||
    provider.models.some((model) => model.id.toLowerCase().includes(query))
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

/**
 * Models a provider offers: catalogue rows newest-first, with rows the user edited
 * in Settings overriding a catalogue row of the same id, and any unknown id
 * appended.
 *
 * A row that only came from an older build's migration is not an edit: it carries a
 * guessed context window and capability set, and letting it shadow the catalogue is
 * what made a vision model report `vision: false` and disable image input.
 */
export function modelsForProvider(provider: ProviderConfig): ProviderModel[] {
  const hidden = new Set(provider.hiddenModelIds);
  // `catalogSlug` is the entry a provider reached through its endpoint rather than
  // its own slug; it is what merges the gateway's models into a migrated profile.
  const catalog = (catalogProvider(provider.catalogSlug ?? provider.slug)?.models ?? [])
    .filter((model) => !hidden.has(model.id))
    .map<ProviderModel>((model) => ({
      modelId: model.id,
      label: model.name,
      contextWindow: model.contextWindow,
      outputWindow: model.outputWindow,
      capabilities: model.capabilities,
      pricing: model.pricing,
      free: model.free,
      updated: model.updated,
    }));

  const catalogIds = new Set(catalog.map((model) => model.modelId));
  const extras = provider.extraModels
    .filter((model) => !catalogIds.has(model.modelId) || model.edited === true)
    .map<ProviderModel>((model) => ({ ...model, added: !catalogIds.has(model.modelId) }));
  const byId = new Map(catalog.map((model) => [model.modelId, model]));

  for (const model of extras) {
    byId.set(model.modelId, model);
  }

  const known = catalog.map((model) => byId.get(model.modelId) as ProviderModel);
  const unknown = extras.filter((model) => !catalogIds.has(model.modelId));

  return [...known, ...unknown];
}

/** Model the provider has selected, or the first one it offers. */
export function selectedModelFor(provider: ProviderConfig): ProviderModel | undefined {
  const models = modelsForProvider(provider);

  return models.find((model) => model.modelId === provider.selectedModelId) ?? models[0];
}

/** Case-insensitive match on model id, name, family-ish label and id fields. */
function modelMatches(model: ProviderModel, query: string): boolean {
  return (
    model.modelId.toLowerCase().includes(query) ||
    model.label.toLowerCase().includes(query) ||
    (model.updated ?? '').toLowerCase().includes(query)
  );
}

/** Models the picker renders at once for a provider, narrowed by the query. */
export function searchProviderModels(
  provider: ProviderConfig,
  query: string,
  limit = MAX_MODEL_RESULTS,
): ProviderModel[] {
  const all = modelsForProvider(provider);
  const q = query.trim().toLowerCase();
  const pool = q.length === 0 ? all : all.filter((model) => modelMatches(model, q));

  return pool.slice(0, limit);
}

/** How many models match, so the picker can say "showing 40 of 377". */
export function countProviderModels(provider: ProviderConfig, query: string): number {
  const all = modelsForProvider(provider);
  const q = query.trim().toLowerCase();

  return q.length === 0 ? all.length : all.filter((model) => modelMatches(model, q)).length;
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

/** One-line summary of a model: context, answer limit, capabilities, price. */
export function describeProviderModel(model: ProviderModel): string {
  const caps = [
    model.capabilities.tools ? 'tools' : null,
    model.capabilities.vision ? 'vision' : null,
    model.capabilities.reasoning ? 'reasoning' : null,
  ].filter(Boolean);

  return [
    `ctx ${model.contextWindow ?? 'unset'}`,
    model.outputWindow !== undefined ? `out ${model.outputWindow}` : null,
    caps.length > 0 ? caps.join('+') : null,
    formatPrice(model.pricing),
    model.updated !== undefined ? model.updated : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Endpoint chips for a provider: its known choices, its current endpoint, and —
 * for a remote provider on a dialect with a vendor origin — that origin.
 *
 * `openai-compatible` has no vendor: it is the shape a server of your own speaks,
 * so offering `localhost:11434` as its "vendor default" would point a gateway at
 * a machine that is not the gateway's.
 */
export function endpointChoices(provider: ProviderConfig): EndpointChoice[] {
  const choices = provider.endpoints ?? [];
  const current = normalizeBaseUrl(provider.baseUrl);
  const withCurrent = choices.some((choice) => choice.baseUrl === current)
    ? [...choices]
    : [{ baseUrl: current, label: 'current endpoint' }, ...choices];

  if (provider.source === 'local-server' || provider.dialect === 'openai-compatible') {
    return withCurrent;
  }

  const vendorDefault = { baseUrl: dialectDefaultBaseUrl(provider.dialect), label: 'vendor default' };

  if (withCurrent.some((choice) => choice.baseUrl === vendorDefault.baseUrl)) {
    return withCurrent;
  }

  return [...withCurrent, vendorDefault];
}

/** Turns a catalog entry into the store's add-provider input. */
export function providerInputFromCatalog(entry: CatalogProvider): NewProviderInput {
  const model = entry.models.find((candidate) => candidate.id === entry.modelId) ?? entry.models[0];

  return {
    source: entry.source,
    dialect: entry.dialect,
    name: entry.name,
    slug: sanitizeKeyRef(entry.slug) || 'provider',
    modelId: model?.id ?? entry.modelId,
    modelLabel: model?.name ?? entry.modelName,
    baseUrl: entry.baseUrl,
    endpoints: entry.endpoints,
    capabilities: model?.capabilities,
    contextWindow: model?.contextWindow,
    pricing: model?.pricing,
    apiKeyRef: entry.apiKeyRef,
    docsUrl: entry.docsUrl,
    note: entry.note,
  };
}

/** Slug for a provider built by hand, from its display name. */
export function slugForProviderName(name: string): string {
  return deriveProviderSlug(name);
}
