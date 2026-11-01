/**
 * Model registry types.
 *
 * Configuration is scoped to a **provider** (`ProviderConfig`): one endpoint,
 * one dialect, one credential slot. A provider offers several models, and the
 * model the chat uses is picked from them. `ModelDescriptor` is the flattened
 * view of one provider + one model — everything the agent needs to send a
 * request — and is built on demand by `descriptorFor`, so the agent layer never
 * has to know about providers.
 */

export type Dialect =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'gemini-generate-content'
  | 'openai-compatible';

export type ModelSource = 'remote' | 'local-server' | 'on-device';

export interface ModelCapabilities {
  /** Native tool/function calling with multi-step loops. */
  tools: boolean;
  /** Image inputs. */
  vision: boolean;
  /** Reasoning traces surfaced as `reasoning` parts. */
  reasoning: boolean;
}

export interface ModelPricing {
  /** USD per 1k input tokens. */
  inputPer1k: number;
  /** USD per 1k output tokens. */
  outputPer1k: number;
}

export interface ModelDescriptor {
  /** Stable identifier used in the UI, e.g. `openai:gpt-5-mini`. */
  id: string;
  /** Provider name and model name together — what error lines and probes quote. */
  label: string;
  /**
   * The provider's own name, never carrying the model's name: the chat screen
   * shows the two on separate lines so a provider reads as one thing.
   */
  providerLabel: string;
  /** Name of the model this descriptor points at. */
  modelLabel: string;
  dialect: Dialect;
  /** Model id passed to the provider, e.g. `gpt-5-mini`. */
  modelId: string;
  /** Request origin. Defaults to the dialect's vendor URL. */
  baseUrl?: string;
  /** SecureStore key name holding the API key. Absent for unauthenticated local servers. */
  apiKeyRef?: string;
  /**
   * Static extra request headers, merged with the credential header the vendor
   * package sends. Gateways that demand a conversation id get one from
   * `core/session.ts` on top of these.
   */
  headers?: Record<string, string>;
  source: ModelSource;
  capabilities: ModelCapabilities;
  contextWindow?: number;
  /**
   * Answer-token cap sent as `maxOutputTokens`. The guard clamps it to what the
   * window leaves, and it never exceeds the model's own output limit.
   */
  maxOutputTokens?: number;
  pricing?: ModelPricing;
  /** The model costs nothing; see `ProviderModel.free`. */
  free?: boolean;
  /** What still has to be edited before the profile can connect. */
  note?: string;
}

/** One model a provider offers. Prices are USD per 1k tokens. */
export interface ProviderModel {
  /** Model id passed to the provider, e.g. `gpt-5-mini`. */
  modelId: string;
  label: string;
  contextWindow?: number;
  outputWindow?: number;
  capabilities: ModelCapabilities;
  pricing?: ModelPricing;
  /**
   * Costs nothing on every field the catalogue prices. A gateway may still
   * restrict the tier, so this says what it costs, not whether it answers.
   */
  free?: boolean;
  /** ISO date the catalogue last updated the entry; absent for typed models. */
  updated?: string;
  /** Model the user typed or read back from a server, not from the catalogue. */
  added?: boolean;
  /**
   * Fields the user changed in Settings. Only such a row shadows the catalogue's
   * row of the same id; rows an older build stored from a legacy profile are not
   * edits, so the catalogue's context, price and capabilities win over them.
   */
  edited?: boolean;
}

/** An endpoint a provider answers on, switchable in its settings. */
export interface EndpointChoice {
  baseUrl: string;
  label: string;
}

/**
 * Per-provider configuration: endpoint, dialect and credential, plus which of
 * the provider's models the chat uses. The model list itself comes from the
 * generated catalogue; only what the user added or hid is stored here.
 */
export interface ProviderConfig {
  /** Catalogue slug, or a sanitized slug for a hand-made provider. */
  slug: string;
  /**
   * Catalogue entry whose model list this provider offers, when its own slug is
   * not one the catalogue knows — a provider migrated from a pre-catalog profile
   * keeps the gateway's endpoint but carries a name-derived slug.
   */
  catalogSlug?: string;
  name: string;
  dialect: Dialect;
  /** Request origin. Defaults to the dialect's vendor origin when unset. */
  baseUrl: string;
  source: ModelSource;
  /** SecureStore key name holding this provider's credential. */
  apiKeyRef?: string;
  docsUrl?: string;
  note?: string;
  /** Known endpoints for the same provider; switching one rewrites `baseUrl`. */
  endpoints?: EndpointChoice[];
  /** Models the user typed or listed from a server, beyond the catalogue. */
  extraModels: ProviderModel[];
  /** Catalogue model ids the user removed from this provider. */
  hiddenModelIds: string[];
  /** Model the chat uses; must be one of the provider's models. */
  selectedModelId: string;
  /** Static extra headers, e.g. a gateway that demands its own session id. */
  headers?: Record<string, string>;
}

/** Input for adding a provider; the store fills in slug and key slot. */
export interface NewProviderInput {
  source: ModelSource;
  dialect: Dialect;
  name: string;
  /** Suggested model; defaults to `model` for a hand-made provider. */
  modelId?: string;
  modelLabel?: string;
  contextWindow?: number;
  capabilities?: ModelCapabilities;
  pricing?: ModelPricing;
  /** Defaults to the dialect's vendor origin, or the LAN server for local. */
  baseUrl?: string;
  endpoints?: EndpointChoice[];
  /** Catalogue slug; a hand-made provider derives one from its name. */
  slug?: string;
  /** Credential slot from the preset; remote providers derive one. */
  apiKeyRef?: string;
  headers?: Record<string, string>;
  note?: string;
  docsUrl?: string;
  /** Provider added as the active one for chat. */
  select?: boolean;
}

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  tools: true,
  vision: false,
  reasoning: false,
};

/** Dialects that authenticate with `Authorization: Bearer <key>`. */
export function dialectUsesBearerAuth(dialect: Dialect): boolean {
  return (
    dialect === 'openai-chat' ||
    dialect === 'openai-responses' ||
    dialect === 'openai-compatible'
  );
}

/** Default origin per dialect, used when the profile sets no base URL. */
export function dialectDefaultBaseUrl(dialect: Dialect): string {
  switch (dialect) {
    case 'openai-chat':
    case 'openai-responses':
      return 'https://api.openai.com/v1';
    case 'anthropic-messages':
      return 'https://api.anthropic.com/v1';
    case 'gemini-generate-content':
      return 'https://generativelanguage.googleapis.com/v1beta';
    case 'openai-compatible':
      return 'http://localhost:11434/v1';
  }
}

/**
 * Normalises a base URL for the dialect: providers concatenate their path onto
 * the base, so a trailing slash would produce a double slash.
 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** The origin a descriptor will actually send requests to. */
export function resolvedBaseUrl(model: ModelDescriptor): string {
  const base =
    model.baseUrl === undefined || model.baseUrl.trim().length === 0
      ? dialectDefaultBaseUrl(model.dialect)
      : model.baseUrl;

  return normalizeBaseUrl(base);
}

/**
 * How the AI SDK authenticates a dialect. The vendor packages decide this, so a
 * profile cannot pick a header style — only the dialect changes it.
 */
export type AuthStyle = 'bearer' | 'x-api-key' | 'query-key' | 'none';

const AUTH_STYLE_BY_DIALECT: Record<Dialect, Exclude<AuthStyle, 'none'>> = {
  'openai-chat': 'bearer',
  'openai-responses': 'bearer',
  'openai-compatible': 'bearer',
  'anthropic-messages': 'x-api-key',
  'gemini-generate-content': 'query-key',
};

export function authStyleFor(dialect: Dialect, apiKeyRef?: string): AuthStyle {
  return apiKeyRef === undefined ? 'none' : AUTH_STYLE_BY_DIALECT[dialect];
}

/**
 * Path the provider appends to the base URL. Checked against the installed
 * vendor packages rather than remembered: `/chat/completions`, `/responses`,
 * `/messages`, and Gemini's `:generateContent` suffix.
 */
export function endpointPathFor(dialect: Dialect, modelId: string): string {
  switch (dialect) {
    case 'openai-chat':
    case 'openai-compatible':
      return '/chat/completions';
    case 'openai-responses':
      return '/responses';
    case 'anthropic-messages':
      return '/messages';
    case 'gemini-generate-content':
      return `/models/${modelId}:generateContent`;
  }
}

/** Human-readable "what will be sent" line for the settings editor. */
export function endpointPreview(model: ModelDescriptor): string {
  const style = authStyleFor(model.dialect, model.apiKeyRef);
  const auth =
    style === 'bearer'
      ? 'Authorization: Bearer'
      : style === 'x-api-key'
        ? 'x-api-key header'
        : style === 'query-key'
          ? 'key as query param'
          : 'no key sent';

  return `${auth} · POST ${resolvedBaseUrl(model)}${endpointPathFor(model.dialect, model.modelId)}`;
}

/** SecureStore key names allow only alphanumeric, `.`, `-` and `_`. */
const KEY_REF_UNSUPPORTED_CHARS = /[^a-zA-Z0-9._-]+/g;
const KEY_REF_MAX_LENGTH = 64;

export function sanitizeKeyRef(value: string): string {
  return value
    .replace(KEY_REF_UNSUPPORTED_CHARS, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, KEY_REF_MAX_LENGTH);
}

/**
 * Default credential slot for a new profile, so pasting a key works without the
 * user inventing a SecureStore name.
 */
export function deriveApiKeyRef(id: string): string {
  return sanitizeKeyRef(`${id}-api-key`);
}

/** Short provider slug used as the `provider:` half of a profile id. */
const DIALECT_SLUG: Record<Dialect, string> = {
  'openai-chat': 'openai',
  'openai-responses': 'openai',
  'anthropic-messages': 'anthropic',
  'gemini-generate-content': 'gemini',
  'openai-compatible': 'compatible',
};

export function profileIdFor(
  source: ModelSource,
  dialect: Dialect,
  modelId: string,
  /** Overrides the dialect slug, e.g. `openrouter` for a catalog preset. */
  providerSlug?: string,
): string {
  const prefix =
    providerSlug !== undefined && providerSlug.trim().length > 0
      ? sanitizeKeyRef(providerSlug) || 'provider'
      : source === 'remote'
        ? DIALECT_SLUG[dialect]
        : source === 'local-server'
          ? 'local'
          : 'device';

  return `${prefix}:${modelId.trim() || 'model'}`;
}

/** Keeps ids unique — ids are the registry key and the UI's selection handle. */
export function uniqueProfileId(existingIds: string[], candidate: string): string {
  if (!existingIds.includes(candidate)) {
    return candidate;
  }

  for (let suffix = 2; suffix < 100; suffix += 1) {
    const next = `${candidate}-${suffix}`;

    if (!existingIds.includes(next)) {
      return next;
    }
  }

  return `${candidate}-${Date.now()}`;
}

/** `provider:model` string used in settings and the chat header. */
export function describeModel(model: ModelDescriptor): string {
  return `${model.source} · ${model.label}`;
}

/**
 * Provider half of a model id. Model ids carry their own colons (`qwen3.5:9b`),
 * so only the first one separates the slug.
 */
export function providerSlugOf(modelId: string): string {
  const [slug] = modelId.split(':');

  return slug ?? '';
}

/** Model half of a `provider:model` id. */
export function modelNameOf(modelId: string): string {
  return modelId.slice(providerSlugOf(modelId).length + 1);
}

/** The id a descriptor and the UI use for one provider + model pair. */
export function descriptorId(slug: string, modelId: string): string {
  return `${sanitizeKeyRef(slug) || 'provider'}:${modelId.trim() || 'model'}`;
}

/**
 * Slug for a hand-made provider. Slugs double as credential slot names and the
 * `provider:` half of a model id, so they are sanitized the same way key names
 * are.
 */
export function deriveProviderSlug(name: string): string {
  return sanitizeKeyRef(name.trim().toLowerCase().replace(/\s+/g, '-')) || 'provider';
}

/** Keeps slugs unique: they address a provider and are React keys. */
export function uniqueProviderSlug(existing: string[], candidate: string): string {
  const base = sanitizeKeyRef(candidate) || 'provider';

  if (!existing.includes(base)) {
    return base;
  }

  for (let suffix = 2; suffix < 100; suffix += 1) {
    const next = `${base}-${suffix}`;

    if (!existing.includes(next)) {
      return next;
    }
  }

  return `${base}-${Date.now()}`;
}

/**
 * Strips the model's name out of a provider name. A profile typed before the
 * provider/model split often reads `OpenCode Go (zen alias) · DeepSeek V4.1
 * Flash`; the endpoint alias is kept, the trailing model name is not repeated.
 *
 * `offered` is the provider's own model list: a stored name may still carry a
 * model other than the selected one, and only a name the provider actually
 * offers is a model name rather than part of the provider's own name.
 */
export function providerNameOf(
  name: string,
  modelLabel: string,
  modelId: string,
  offered: ProviderModel[] = [],
): string {
  let out = name.trim();
  const parts = [modelLabel, modelId, ...offered.flatMap((model) => [model.label, model.modelId])];
  const suffixes = parts
    .filter((part) => part.trim().length > 0)
    .flatMap((part) => [` · ${part}`, `(${part})`])
    .map((suffix) => suffix.trimStart().toLowerCase());

  // Repeatedly, so a name padded with more than one model (`A · B · C`) is stripped
  // down to the provider's own part.
  for (let pass = 0; pass < 3; pass += 1) {
    const tail = suffixes.find((suffix) => out.length >= suffix.length && out.toLowerCase().endsWith(suffix));

    if (tail === undefined) {
      break;
    }

    out = out.slice(0, out.length - tail.length).trim();
  }

  return out;
}

/**
 * Flattens a provider and one of its models into the descriptor the agent
 * builds its request from. The endpoint is normalized, and the model's own
 * output limit caps the answer budget so a small-output model is never asked
 * for more than it can answer.
 */
export function descriptorFor(
  provider: ProviderConfig,
  model: ProviderModel,
  /** The provider's model list; used to strip a model name the stored name still carries. */
  offered: ProviderModel[] = [model],
): ModelDescriptor {
  const baseUrl =
    provider.baseUrl.trim().length > 0
      ? normalizeBaseUrl(provider.baseUrl)
      : dialectDefaultBaseUrl(provider.dialect);

  const modelLabel = model.label.trim() || model.modelId.trim() || 'model';
  const providerLabel =
    providerNameOf(provider.name, modelLabel, model.modelId, offered) || provider.slug;

  return {
    id: descriptorId(provider.slug, model.modelId),
    // The provider name is never padded with the model name; when a legacy row
    // named itself after the model there is nothing to repeat.
    label: modelLabel === providerLabel ? providerLabel : `${providerLabel} · ${modelLabel}`,
    providerLabel,
    modelLabel,
    dialect: provider.dialect,
    modelId: model.modelId,
    baseUrl,
    apiKeyRef: provider.apiKeyRef,
    headers: provider.headers,
    source: provider.source,
    capabilities: model.capabilities,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.outputWindow,
    pricing: model.pricing,
    free: model.free,
    note: provider.note,
  };
}

/** The descriptor for the model the provider has selected. */
export function activeDescriptor(provider: ProviderConfig, models: ProviderModel[]): ModelDescriptor {
  const model =
    models.find((candidate) => candidate.modelId === provider.selectedModelId) ?? models[0];

  if (model === undefined) {
    return descriptorFor(
      provider,
      {
        modelId: provider.selectedModelId || 'model',
        label: provider.selectedModelId || 'model',
        capabilities: DEFAULT_CAPABILITIES,
        added: true,
      },
      models,
    );
  }

  return descriptorFor(provider, model, models);
}
