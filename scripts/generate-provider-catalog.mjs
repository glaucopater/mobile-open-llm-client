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
 *
 * Every provider carries its whole model list, so switching model is a tap
 * inside the provider rather than a new profile. Deprecated models are dropped;
 * the list is ordered newest first so the current models are at the top.
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
  // models.dev lists only the Agent API (`perplexity-agent`), and the plain
  // `perplexity` entry ships no `api`, so it is not drivable here.
  'perplexity-agent': 'https://api.perplexity.ai/v1',
  vercel: 'https://ai-gateway.vercel.sh/v1',
  azure: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1',
  // models.dev points Go at the documented `inference/go` path, which the app
  // must not use: Go answers on the zen gateway, so the request goes to
  // `https://opencode.ai/zen/go/v1/chat/completions`.
  'opencode-go': 'https://opencode.ai/zen/go/v1',
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

/**
 * Endpoints the same provider answers on, switchable inside its settings. The
 * first is the default. OpenCode Go is deliberately absent: it has one endpoint
 * (`https://opencode.ai/zen/go/v1`, see `API_OVERRIDE`), and offering a second
 * path that the gateway does not serve is a way to make the app fail.
 */
const ENDPOINT_CHOICES = {};

/** Extra text the settings editor shows for presets that need editing first. */
const NOTE = {
  azure: 'Replace YOUR-RESOURCE with your Azure OpenAI resource name.',
  'perplexity-agent': 'Responses API (POST /v1/responses); web-grounded answers with citations.',
  opencode:
    'Console gateway, key from the OpenCode Console. Free models are tagged `free`: the gateway restricts them, so a `403` there is the tier, not your key. The app sends the `x-opencode-session` header this gateway needs.',
  'opencode-go':
    'Go subscription key from the OpenCode Console. Requests go to the zen gateway (`POST https://opencode.ai/zen/go/v1/chat/completions`), the only endpoint Go serves. Free models are tagged `free`: Go restricts them to OpenCode and validated clients, and workspace Privacy › Regions must allow your region, so a `403` there is the tier, not your key. The app sends the `x-opencode-session` header this gateway needs.',
};

/**
 * Gateways whose zero-cost models answer only inside OpenCode and the clients it
 * has validated (https://opencode.ai/v2/docs/console/go). They are listed and
 * tagged `free`, but never suggested as the provider's first model: a new
 * provider should not start on a model that may answer `403`.
 */
const FREE_TIER_GATEWAYS = new Set(['opencode', 'opencode-go']);

/**
 * Local servers models.dev does not list. Their model list is whatever is
 * loaded on the machine, so the suggestion is a placeholder the user edits or
 * reads back from the server with "List models from server".
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

function contextOf(model) {
  return model.limit?.context ?? 0;
}

/**
 * A free model is one whose every cost field is zero. The `-free` id suffix is
 * not used to decide it: OpenCode lists `big-pickle` and `grok-code` as free
 * without the suffix, so filtering by suffix would miss them.
 */
function isFreeModel(model) {
  const cost = model.cost;

  if (cost === undefined || typeof cost.input !== 'number' || typeof cost.output !== 'number') {
    return false;
  }

  return Object.values(cost).every((value) => value === 0);
}

function costOf(model) {
  return model.cost?.input ?? Number.POSITIVE_INFINITY;
}

function updatedOf(model) {
  return model.last_updated ?? model.release_date ?? '';
}

/**
 * The provider's whole model list: ids models.dev actually resolves, deprecated
 * rows dropped, duplicates collapsed, newest model first so the current ones
 * head the list a user browses. Free models are kept and tagged `free`.
 */
function listModels(models) {
  const seen = new Set();
  const rows = [];

  for (const model of Object.values(models ?? {})) {
    if (typeof model.id !== 'string' || model.status === 'deprecated') {
      continue;
    }
    if (seen.has(model.id)) {
      continue;
    }

    seen.add(model.id);
    rows.push({
      id: model.id,
      name: model.name ?? model.id,
      contextWindow: contextOf(model) || undefined,
      outputWindow: model.limit?.output ?? undefined,
      capabilities: capabilities(model),
      pricing: pricingPer1k(model.cost),
      free: isFreeModel(model) ? true : undefined,
      updated: updatedOf(model) || undefined,
    });
  }

  rows.sort(
    (a, b) =>
      (b.updated ?? '').localeCompare(a.updated ?? '') ||
      (a.pricing?.inputPer1k ?? 0) - (b.pricing?.inputPer1k ?? 0) ||
      a.id.localeCompare(b.id, 'en'),
  );

  return rows;
}

/**
 * Suggested model for a freshly added provider: tool-capable, a context window
 * the request guard can budget against, and cheapest first so a new provider
 * does not spend much before the user picks a model. On the OpenCode gateways a
 * free model is skipped — it is the cheapest, but the tier may answer `403`.
 * Providers whose whole list is deprecated still get an entry, flagged in the note.
 */
function pickModel(models, { skipFreeTier = false } = {}) {
  const withIds = Object.values(models ?? {}).filter((model) => typeof model.id === 'string');
  const usable = withIds.filter((model) => model.status !== 'deprecated');
  const deprecated = usable.length === 0;
  const pool = deprecated ? withIds : usable;

  if (pool.length === 0) {
    return undefined;
  }

  const priced = skipFreeTier ? pool.filter((model) => !isFreeModel(model)) : pool;
  const candidates = priced.filter(
    (model) => model.tool_call === true && contextOf(model) >= MIN_CONTEXT,
  );
  const shortlist = candidates.length > 0
    ? candidates
    : priced.filter((model) => contextOf(model) >= FALLBACK_CONTEXT);
  // Every model on a free-tier gateway is free, so fall back to the pool rather
  // than handing the provider no suggestion at all.
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

  const skipFreeTier = FREE_TIER_GATEWAYS.has(id);
  const models = listModels(provider.models);
  const suggestion = pickModel(provider.models, { skipFreeTier });

  if (suggestion === undefined || models.length === 0) {
    return undefined;
  }

  const local = isLocal(baseUrl);
  const notes = [];

  if (NOTE[id] !== undefined) {
    notes.push(NOTE[id]);
  }
  if (suggestion.deprecated) {
    notes.push('models.dev marks every model here as deprecated — type a newer model id.');
  }

  const endpoints = (ENDPOINT_CHOICES[id] ?? []).map((choice) => ({
    baseUrl: normalizeBaseUrl(choice.baseUrl),
    label: choice.label,
  }));
  // The default endpoint must be one of the choices the switcher offers.
  const normalized = normalizeBaseUrl(baseUrl);

  if (!endpoints.some((choice) => choice.baseUrl === normalized)) {
    endpoints.unshift({ baseUrl: normalized, label: 'default' });
  }

  return {
    slug: id,
    name: provider.name ?? id,
    dialect,
    baseUrl: normalized,
    source: local ? 'local-server' : 'remote',
    apiKeyRef: local ? undefined : sanitizeKeyRef(`${id}-api-key`),
    docsUrl: provider.doc,
    note: notes.length > 0 ? notes.join(' ') : undefined,
    endpoints: endpoints.length > 1 ? endpoints : undefined,
    modelId: suggestion.modelId,
    modelName: suggestion.modelName,
    models,
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
    note: 'Model id must match a model the server has loaded — use "List models from server".',
    modelId: server.modelId,
    modelName: server.modelName,
    models: [
      {
        id: server.modelId,
        name: server.modelName,
        contextWindow: server.contextWindow,
        outputWindow: undefined,
        capabilities: { tools: true, vision: false, reasoning: false },
        pricing: undefined,
        updated: undefined,
      },
    ],
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
const modelCount = entries.reduce((total, entry) => total + entry.models.length, 0);
const freeCount = entries.reduce(
  (total, entry) => total + entry.models.filter((model) => model.free === true).length,
  0,
);

function literal(value) {
  return JSON.stringify(value);
}

function renderModel(model) {
  const parts = [
    `id: ${literal(model.id)}`,
    `name: ${literal(model.name)}`,
    `contextWindow: ${model.contextWindow ?? 'undefined'}`,
    `outputWindow: ${model.outputWindow ?? 'undefined'}`,
    `capabilities: ${literal(model.capabilities)}`,
    model.pricing ? `pricing: ${literal(model.pricing)}` : null,
    model.free ? 'free: true' : null,
    model.updated ? `updated: ${literal(model.updated)}` : null,
  ];

  return `      { ${parts.filter(Boolean).join(', ')} },`;
}

function render(entry) {
  const lines = [
    `  { slug: ${literal(entry.slug)}, name: ${literal(entry.name)}, dialect: ${literal(entry.dialect)},`,
    `    baseUrl: ${literal(entry.baseUrl)}, source: ${literal(entry.source)},`,
    `    modelId: ${literal(entry.modelId)}, modelName: ${literal(entry.modelName)},`,
    entry.apiKeyRef ? `    apiKeyRef: ${literal(entry.apiKeyRef)},` : null,
    entry.docsUrl ? `    docsUrl: ${literal(entry.docsUrl)},` : null,
    entry.note ? `    note: ${literal(entry.note)},` : null,
    entry.endpoints ? `    endpoints: ${literal(entry.endpoints)},` : null,
    `    models: [`,
    ...entry.models.map(renderModel),
    '    ],',
    '  },',
  ];

  return lines.filter(Boolean).join('\n');
}

const file = [
  '/**',
  ' * Generated by `scripts/generate-provider-catalog.mjs` (yarn providers:sync).',
  ' * Source: https://models.dev/api.json — do not edit by hand.',
  ' *',
  ' * Every entry speaks one of the dialects the app can drive and carries the',
  ' * provider\'s model list, newest first, so switching model happens inside the',
  ' * provider instead of adding a profile per model. Deprecated models are dropped',
  ' * and zero-cost models are kept but tagged `free`.',
  ' */',
  '',
  "import type { Dialect, ModelCapabilities, ModelSource } from './model';",
  '',
  'export interface CatalogModel {',
  '  /** Model id passed to the provider. */',
  '  id: string;',
  '  /** Display name from models.dev. */',
  '  name: string;',
  '  /** Full context window in tokens, when models.dev knows it. */',
  '  contextWindow?: number;',
  '  /** Answer limit in tokens, when models.dev knows it. */',
  '  outputWindow?: number;',
  '  capabilities: ModelCapabilities;',
  '  /** USD per 1k tokens. */',
  '  pricing?: { inputPer1k: number; outputPer1k: number };',
  '  /**',
  '   * Costs nothing on every field models.dev prices. Tagged so a free tier a',
  '   * gateway restricts can be told apart from a paid model that needs a key.',
  '   */',
  '  free?: true;',
  '  /** ISO date models.dev last updated the entry. */',
  '  updated?: string;',
  '}',
  '',
  'export interface CatalogEndpoint {',
  '  baseUrl: string;',
  '  label: string;',
  '}',
  '',
  'export interface CatalogProvider {',
  '  /** Provider slug, used as the `provider:` half of a model id. */',
  '  slug: string;',
  '  name: string;',
  '  dialect: Dialect;',
  '  baseUrl: string;',
  '  source: ModelSource;',
  '  /** Suggested model for a provider just added: cheap and tool-capable. */',
  '  modelId: string;',
  '  modelName: string;',
  '  /** Models offered by the provider, newest first. */',
  '  models: CatalogModel[];',
  '  /** Endpoints the same provider answers on; the first is the default. */',
  '  endpoints?: CatalogEndpoint[];',
  '  /** SecureStore slot the key goes in; absent for unauthenticated servers. */',
  '  apiKeyRef?: string;',
  '  docsUrl?: string;',
  '  /** What the user must still change before the provider can connect. */',
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
  `wrote ${OUTPUT}: ${entries.length} providers (${remote} remote, ${local} local servers), ${modelCount} models (${freeCount} free)`,
);
console.log(`skipped ${skipped.length} providers (unsupported package or placeholder URL)`);
console.log('unsupported:', skipped.slice(0, 12).join(', '), skipped.length > 12 ? '…' : '');
