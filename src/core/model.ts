/**
 * Model registry types.
 *
 * A `ModelDescriptor` is everything the app needs to talk to one model: which
 * API dialect to speak, where to send the request, and which SecureStore key
 * holds the credential. UI code refers to models by `id` ("provider:model").
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
  label: string;
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
  pricing?: ModelPricing;
  /** What still has to be edited before the profile can connect. */
  note?: string;
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
