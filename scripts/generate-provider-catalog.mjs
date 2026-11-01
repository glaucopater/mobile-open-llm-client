/**
 * Regenerates `src/core/provider-catalog.ts` from https://models.dev/api.json.
 *
 * Run with:  yarn providers:sync
 *
 * models.dev is the provider registry OpenCode itself uses: one entry per
 * provider with the AI SDK package it speaks (`npm`), its base URL (`api`) and
 * its model list. Only providers whose dialect our app can drive are emitted:
 * `@ai-sdk/openai`, `@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`,
 * `@ai-sdk/google` and `@ai-sdk/google-vertex`. Everything else needs a
 * provider package we do not ship, or a base URL with account placeholders in
 * it, and is reported in the summary instead.
 */
import { writeFileSync } from 'node:fs';

const SOURCE = 'https://models.dev/api.json';
const OUTPUT = 'src/core/provider-catalog.ts';

/** npm package -> the dialect our `createLanguageModel` switch understands. */
const DIALECT_BY_NPM = {
  '@ai-sdk/openai': 'openai-chat',
  '@ai-sdk/openai-compatible': 'openai-compatible',
  '@ai-sdk/anthropic': 'anthropic-messages',
  '@ai-sdk/google': 'gemini-generate-content',
  '@ai-sdk/google-vertex': 'gemini-generate-content',
};

const MIN_CONTEXT = 32_768;
const FALLBACK_CONTEXT = 8_192;

/**
 * providers models.dev lists with a provider package we do not ship
 * (`@ai-sdk/groq`, `@ai-sdk/xai`, …) but that expose an OpenAI-compatible
 * endpoint we can drive instead. Endpoints below were checked against each
 * vendor's own docs/OpenAPI spec, not remembered.
 */
const API_OVERRIDE = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  xai: 'https://api.x.ai/v1',
  mistral: 'https://api.mistral.ai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  togetherai: 'https://api.together.ai/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  // Chat Completions lives on the Orchestrator API; `/v1` alone is Responses-only.
  perplexity: 'https://api.perplexity.ai/orchestrator/v1',
  vercel: 'https://ai-gateway.vercel.sh/v1',
  azure: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1',
};

/** Dialect to use instead of the one implied by models.dev's `npm` field. */
const DIALECT_OVERRIDE = {
  // Native packages speak Chat Completions too, so the generic adapter works.
  openrouter: 'openai-compatible',
  vercel: 'openai-compatible',
  azure: 'openai-compatible',
  // Perplexity's Agent API only accepts the Responses shape.
  'perplexity-agent': 'openai-responses',
};

/** Extra text the settings editor shows for presets that need editing first. */
const NOTE = {
  azure: 'Replace YOUR-RESOURCE with your Azure OpenAI resource name.',
  perplexity: 'Chat Completions through the Orchestrator API; model ids look like `perplexity/kimi-k3`.',
  'perplexity-agent': 'Responses API (POST /v1/responses); web-grounded answers with citations.',
  opencode:
    'Console gateway, key from the OpenCode Console. Free models only answer inside OpenCode, so type a paid model id. The app sends the `x-opencode-session` header this gateway needs.',
  'opencode-go':
    'Go subscription key from the OpenCode Console. Free models only answer inside OpenCode (other clients get HTTP 403), so type a paid model id. The app sends the `x-opencode-session` header this gateway needs.',
};

/**
 * Providers whose zero-cost models only answer from inside OpenCode
 * (https://opencode.ai/v2/docs/console/harnesses). Suggesting one would hand the
 * user a profile that gets `403`, so the suggestion picks a paid model instead.
 */
const PAID_ONLY_MODELS = new Set(['opencode', 'opencode-go']);

/**
 * Local servers models.dev does not list. Their model list is whatever is
 * loaded on the machine, so the suggestion is a placeholder the user edits.
 */
const LOCAL_SERVERS = {
  ollama: {
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    docsUrl: 'https://docs.ollama.com',
    modelId: 'qwen3.5:9b',
    modelName: 'Ollama model',
    contextWindow: 32768,
  },
  'llama.cpp': {
    name: 'llama-server (llama.cpp)',
    baseUrl: 'http://localhost:8080/v1',
    docsUrl: 'https://github.com/ggml-org/llama.cpp',
    modelId: 'model',
    modelName: 'llama-server model',
    contextWindow: 32768,
  },
  vllm: {
    name: 'vLLM',
    baseUrl: 'http://localhost:8000/v1',
    docsUrl: 'https://docs.vllm.ai',
    modelId: 'model',
    modelName: 'vLLM model',
    contextWindow: 32768,
  },
  mlx: {
    name: 'MLX LM server',
    baseUrl: 'http://localhost:8000/v1',
    docsUrl: 'https://github.com/ml-explore/mlx-lm',
    modelId: 'model',
    modelName: 'MLX model',
    contextWindow: 32768,
  },
};

function normalizeBaseUrl(url) {
  return url.trim().replace(/\/+$/, '');
}

function isLocal(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i.test(url);
}

/** SecureStore key names allow only alphanumeric, `.`, `-` and `_`. */
function sanitizeKeyRef(value) {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, 64);
}

/** models.dev prices are USD per 1M tokens; our registry stores per 1k. */
function pricingPer1k(cost) {
  if (!cost || typeof cost.input !== 'number' || typeof cost.output !== 'number') {
    return undefined;
  }

  // Rounded: per-1k rates come out of a 1M division and otherwise carry float noise.
  const per1k = (value) => Math.round((value / 1000) * 1e6) / 1e6;

  return { inputPer1k: per1k(cost.input), outputPer1k: per1k(cost.output) };
}

function capabilities(model) {
  const input = model.modalities?.input ?? [];

  return {
    tools: model.tool_call === true,
    vision: input.includes('image'),
    reasoning: model.reasoning === true,
  };
}

/**
 * Suggested model for a freshly added profile: tool-capable, not deprecated, a
 * context window the request guard can budget against, and cheapest first so a
 * new profile does not spend much before the user picks a model. Providers whose
 * whole list is deprecated still get an entry, flagged in the note.
 */
function pickModel(models, { paidOnly = false } = {}) {
  const withIds = Object.values(models ?? {}).filter((model) => typeof model.id === 'string');
  const usable = withIds.filter((model) => model.status !== 'deprecated');
  const deprecated = usable.length === 0;
  const pool = deprecated ? withIds : usable;

  if (pool.length === 0) {
    return undefined;
  }

  const costOf = (model) => model.cost?.input ?? Number.POSITIVE_INFINITY;
  const contextOf = (model) => model.limit?.context ?? 0;

  // A zero-cost model here would be answered 403 by a client outside OpenCode.
  const priced = paidOnly ? pool.filter((model) => costOf(model) > 0) : pool;
  const candidates = priced.filter(
    (model) => model.tool_call === true && contextOf(model) >= MIN_CONTEXT,
  );
  const shortlist = candidates.length > 0
    ? candidates
    : priced.filter((model) => contextOf(model) >= FALLBACK_CONTEXT);
  const chosen = shortlist.length > 0 ? shortlist : pool;

  chosen.sort((a, b) => costOf(a) - costOf(b) || contextOf(b) - contextOf(a));

  const model = chosen[0];

  return {
    modelId: model.id,
    modelName: model.name ?? model.id,
    contextWindow: contextOf(model) || undefined,
    capabilities: capabilities(model),
    pricing: pricingPer1k(model.cost),
    deprecated,
  };
}

function toEntry(id, provider) {
  const dialect =
    DIALECT_OVERRIDE[id] ??
    DIALECT_BY_NPM[provider.npm] ??
    (API_OVERRIDE[id] === undefined ? undefined : 'openai-compatible');
  const baseUrl = API_OVERRIDE[id] ?? provider.api;

  if (dialect === undefined || typeof baseUrl !== 'string') {
    return undefined;
  }

  // URLs with account placeholders (`${SNOWFLAKE_ACCOUNT}`) cannot be reached.
  if (baseUrl.includes('${') || baseUrl.includes('{')) {
    return undefined;
  }

  const model = pickModel(provider.models, { paidOnly: PAID_ONLY_MODELS.has(id) });

  if (model === undefined) {
    return undefined;
  }

  const local = isLocal(baseUrl);
  const notes = [];

  if (NOTE[id] !== undefined) {
    notes.push(NOTE[id]);
  }
  if (model.deprecated) {
    notes.push('models.dev marks every model here as deprecated — type a newer model id.');
  }

  const { deprecated: _deprecated, ...suggestion } = model;

  return {
    slug: id,
    name: provider.name ?? id,
    dialect,
    baseUrl: normalizeBaseUrl(baseUrl),
    source: local ? 'local-server' : 'remote',
    apiKeyRef: local ? undefined : sanitizeKeyRef(`${id}-api-key`),
    docsUrl: provider.doc,
    note: notes.length > 0 ? notes.join(' ') : undefined,
    ...suggestion,
  };
}

/** Local servers that are not in models.dev: their model list is per-machine. */
function localEntry(id, server) {
  return {
    slug: id,
    name: server.name,
    dialect: 'openai-compatible',
    baseUrl: normalizeBaseUrl(server.baseUrl),
    source: 'local-server',
    docsUrl: server.docsUrl,
    note: 'Model id must match a model the server has loaded.',
    modelId: server.modelId,
    modelName: server.modelName,
    contextWindow: server.contextWindow,
    capabilities: { tools: true, vision: false, reasoning: false },
  };
}

const response = await fetch(SOURCE);

if (!response.ok) {
  throw new Error(`${SOURCE} returned HTTP ${response.status}`);
}

const data = await response.json();

const entries = [];
const skipped = [];

for (const [id, provider] of Object.entries(data)) {
  const entry = toEntry(id, provider);

  if (entry === undefined) {
    skipped.push(`${id} (${provider.npm ?? 'no npm'} ${provider.api ? 'has api' : 'no api'})`);
    continue;
  }

  entries.push(entry);
}

for (const [id, server] of Object.entries(LOCAL_SERVERS)) {
  // models.dev already carries a live model list for some local servers.
  if (data[id] !== undefined) {
    continue;
  }

  entries.push(localEntry(id, server));
}

entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));

const remote = entries.filter((entry) => entry.source === 'remote').length;
const local = entries.length - remote;

function literal(value) {
  return JSON.stringify(value);
}

function render(entry) {
  const lines = [
    `  { slug: ${literal(entry.slug)}, name: ${literal(entry.name)}, dialect: ${literal(entry.dialect)},`,
    `    baseUrl: ${literal(entry.baseUrl)}, source: ${literal(entry.source)},`,
    `    modelId: ${literal(entry.modelId)}, modelName: ${literal(entry.modelName)},`,
    `    contextWindow: ${entry.contextWindow ?? 'undefined'},`,
    `    capabilities: ${literal(entry.capabilities)},`,
    entry.pricing ? `    pricing: ${literal(entry.pricing)},` : null,
    entry.apiKeyRef ? `    apiKeyRef: ${literal(entry.apiKeyRef)},` : null,
    entry.docsUrl ? `    docsUrl: ${literal(entry.docsUrl)},` : null,
    entry.note ? `    note: ${literal(entry.note)},` : null,
    '  },',
  ];

  return lines.filter(Boolean).join('\n');
}

const file = [
  '/**',
  ' * Generated by `scripts/generate-provider-catalog.mjs` (yarn providers:sync).',
  ' * Source: https://models.dev/api.json — do not edit by hand.',
  ' *',
  ' * Every entry speaks one of the four dialects the app can drive and ships a',
  ' * suggested model, so adding a provider is one tap plus pasting a key.',
  ' */',
  '',
  "import type { Dialect, ModelCapabilities, ModelSource } from './model';",
  '',
  'export interface CatalogProvider {',
  '  /** Provider slug, used as the `provider:` half of a profile id. */',
  '  slug: string;',
  '  name: string;',
  '  dialect: Dialect;',
  '  baseUrl: string;',
  '  source: ModelSource;',
  '  modelId: string;',
  '  modelName: string;',
  '  contextWindow?: number;',
  '  capabilities: ModelCapabilities;',
  '  /** USD per 1k tokens. */',
  '  pricing?: { inputPer1k: number; outputPer1k: number };',
  '  /** SecureStore slot the key goes in; absent for unauthenticated servers. */',
  '  apiKeyRef?: string;',
  '  docsUrl?: string;',
  '  /** What the user must still change before the profile can connect. */',
  '  note?: string;',
  '}',
  '',
  `export const PROVIDER_CATALOG: CatalogProvider[] = [`,
  entries.map(render).join('\n'),
  '];',
  '',
].join('\n');

writeFileSync(OUTPUT, file, 'utf8');

console.log(
  `wrote ${OUTPUT}: ${entries.length} providers (${remote} remote, ${local} local servers)`,
);
console.log(`skipped ${skipped.length} providers (unsupported package or placeholder URL)`);
console.log('unsupported:', skipped.slice(0, 12).join(', '), skipped.length > 12 ? '…' : '');
