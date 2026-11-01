/**
 * App configuration store: providers, their models, and what chat uses.
 *
 * Settings are scoped to a provider — one endpoint, one dialect, one credential
 * slot — and a provider offers several models that can be switched between
 * without re-entering anything. The model list itself comes from the generated
 * catalog; SQLite stores only what the user added or hid, so `yarn
 * providers:sync` refreshes the list underneath an existing provider. Keys stay
 * in SecureStore and never reach SQLite.
 */
import { create } from 'zustand';

import { deleteKey, getJson, setJson } from './db';
import { catalogProvider, catalogProviderForEndpoint, modelsForProvider } from '../core/catalog-search';
import {
  DEFAULT_CAPABILITIES,
  deriveApiKeyRef,
  deriveProviderSlug,
  dialectDefaultBaseUrl,
  modelNameOf,
  normalizeBaseUrl,
  providerNameOf,
  providerSlugOf,
  sanitizeKeyRef,
  uniqueProviderSlug,
  type EndpointChoice,
  type ModelDescriptor,
  type NewProviderInput,
  type ProviderConfig,
  type ProviderModel,
} from '../core/model';

/** Persisted shape of the provider configuration. */
const STORAGE_KEY = 'provider-config';
const SCHEMA_VERSION = 2;

/** Registry shape written by builds before v1.6.0, migrated on first load. */
const LEGACY_STORAGE_KEY = 'model-registry';

/**
 * Emulator default. `adb reverse tcp:11434 tcp:11434` forwards the emulator's
 * localhost to the host, which works even when the server binds 127.0.0.1.
 * Without that reverse, use the host's LAN address (e.g. `http://10.0.2.2:11434/v1`)
 * and bind the server to `0.0.0.0`.
 */
export const LOCAL_SERVER_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

/**
 * OpenCode Go. One endpoint: the zen gateway. `POST https://opencode.ai/zen/go/v1/chat/completions`
 * is the request the app makes — the `inference/go` path models.dev advertises is
 * not a route Go serves, so it is retired below rather than offered as a choice.
 * A request without `x-opencode-session` is answered `400 MissingSessionID`;
 * `core/session.ts` adds that header and the app's own `User-Agent`.
 */
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';

/**
 * Endpoints shipped in earlier builds that the gateway does not answer on. A
 * stored profile pointing at one would fail every message forever, so the URL is
 * rewritten on load — the credential and the model list stay.
 */
const RETIRED_ENDPOINTS: Record<string, string> = {
  'https://opencode.ai/inference/go/openai/v1': OPENCODE_GO_BASE_URL,
};

/** One credential slot for the provider, whichever endpoint it is switched to. */
export const OPENCODE_GO_API_KEY_REF = 'opencode-go-api-key';

const OPENCODE_SESSION_NOTE =
  'OpenCode Go needs a subscription key and sends a session id automatically (x-opencode-session). Free models are tagged `free` — Go restricts that tier to OpenCode and validated clients, so a 403 on one is the tier, not your key.';

/** Models the built-in providers start on, when the catalog suggestion differs. */
const DEFAULT_MODEL_BY_SLUG: Record<string, string> = {
  ollama: 'qwen3.5:9b',
  'opencode-go': 'deepseek-v4.1-flash',
  openai: 'gpt-5-mini',
  anthropic: 'claude-sonnet-4-5',
  google: 'gemini-2.5-flash',
};

/**
 * A built-in provider, seeded from the catalog so its endpoint, dialect, key slot
 * and model list match `provider-catalog.ts` rather than a copy kept here.
 */
function providerFromCatalog(
  slug: string,
  patch: Partial<ProviderConfig> = {},
): ProviderConfig | undefined {
  const entry = catalogProvider(slug);

  if (entry === undefined) {
    return undefined;
  }

  const preferred = DEFAULT_MODEL_BY_SLUG[slug];
  const listed = entry.models.some((model) => model.id === preferred);
  const selectedModelId = listed ? (preferred as string) : entry.modelId;
  const baseUrl = normalizeBaseUrl(patch.baseUrl ?? entry.baseUrl);

  return {
    slug,
    name: entry.name,
    dialect: patch.dialect ?? entry.dialect,
    baseUrl,
    source: patch.source ?? entry.source,
    apiKeyRef: patch.apiKeyRef ?? entry.apiKeyRef,
    docsUrl: entry.docsUrl,
    note: patch.note ?? entry.note,
    endpoints: patch.endpoints ?? entry.endpoints,
    extraModels: [],
    hiddenModelIds: [],
    selectedModelId,
  };
}

/** Providers shipped ready to use: one LAN server, the Go gateway, one vendor per dialect. */
export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  providerFromCatalog('ollama'),
  providerFromCatalog('opencode-go', { baseUrl: OPENCODE_GO_BASE_URL, apiKeyRef: OPENCODE_GO_API_KEY_REF, note: OPENCODE_SESSION_NOTE }),
  providerFromCatalog('openai'),
  providerFromCatalog('anthropic'),
  providerFromCatalog('google'),
].filter((provider): provider is ProviderConfig => provider !== undefined);

interface StoredConfig {
  schema: number;
  providers: ProviderConfig[];
  selectedSlug: string;
  /** Built-in provider slugs the user deleted; kept so a load does not re-add them. */
  retiredSlugs?: string[];
}

/** What a pre-v1.6.0 build stored: one profile per model. */
interface LegacyRegistry {
  models: ModelDescriptor[];
  selectedId: string;
  retiredDefaults?: string[];
}

interface ConfigState {
  providers: ProviderConfig[];
  selectedSlug: string;
  loaded: boolean;
  load(): Promise<void>;
  selectProvider(slug: string): void;
  /** Picks a model to chat with, and makes its provider the active one. */
  selectModel(slug: string, modelId: string): void;
  addProvider(input: NewProviderInput): ProviderConfig;
  updateProvider(slug: string, patch: Partial<ProviderConfig>): void;
  removeProvider(slug: string): void;
  /** Adds a typed model, or one read back from a server, to a provider. */
  addModels(slug: string, models: ProviderModel[]): void;
  /** Removes a model: typed ones are deleted, catalog ones hidden. */
  removeModel(slug: string, modelId: string): void;
  /** Brings back every catalog model that was hidden. */
  restoreHiddenModels(slug: string): void;
  /** Switches between the endpoints one provider answers on. */
  setEndpoint(slug: string, baseUrl: string): void;
}

/** Built-in providers the user deleted, remembered across restarts. */
let retiredSlugs: string[] = [];

function persist(providers: ProviderConfig[], selectedSlug: string): void {
  void setJson(STORAGE_KEY, { schema: SCHEMA_VERSION, providers, selectedSlug, retiredSlugs });
}

function normalizeProvider(provider: ProviderConfig): ProviderConfig {
  const baseUrl = normalizeBaseUrl(
    provider.baseUrl.trim().length > 0
      ? provider.baseUrl
      : provider.source === 'local-server'
        ? LOCAL_SERVER_DEFAULT_BASE_URL
        : dialectDefaultBaseUrl(provider.dialect),
  );
  // An endpoint the gateway does not answer on is replaced rather than kept: a
  // profile left on it fails every message, and the user cannot tell why. The
  // replacement is what the catalogue is then matched against, so the rewritten
  // profile reconnects to the gateway's model list.
  const retired = RETIRED_ENDPOINTS[baseUrl.toLowerCase()];
  const url = retired ?? baseUrl;
  const apiKeyRef =
    provider.source === 'remote'
      ? sanitizeKeyRef(provider.apiKeyRef ?? '') || deriveApiKeyRef(provider.slug)
      : undefined;
  // A remote provider whose slug the catalogue does not know can still be a
  // catalogue gateway reached through one of its endpoints — that is what
  // reconnects the gateway's model list to a profile migrated from before the
  // catalogue existed. Local servers list their own models, so they never match.
  const catalogSlug =
    provider.source === 'remote'
      ? (catalogProviderForEndpoint(url, provider.dialect)?.slug ?? provider.catalogSlug)
      : provider.catalogSlug;
  const merged = { ...provider, baseUrl: url, apiKeyRef, catalogSlug };
  // Endpoint chips follow the same rule: a retired path is never offered, and a
  // provider left with one endpoint shows no switcher. `endpointChoices()` adds
  // the current endpoint itself, so the chips here are the *other* endpoints.
  const endpoints = (provider.endpoints ?? []).filter((choice) => {
    const normalized = normalizeBaseUrl(choice.baseUrl);

    return normalized !== url && RETIRED_ENDPOINTS[normalized.toLowerCase()] === undefined;
  });
  // A profile stored before the provider/model split names itself after one of its
  // models (`OpenCode Go (zen alias) · DeepSeek V4.1 Flash`). Any model the
  // provider actually offers is dropped from the name, so every screen shows the
  // provider alone and the model appears once, in its own line.
  const name =
    providerNameOf(
      provider.name,
      provider.selectedModelId,
      provider.selectedModelId,
      modelsForProvider(merged),
    ) || provider.name;

  return { ...merged, endpoints: endpoints.length > 0 ? endpoints : undefined, name };
}

/**
 * Built-in providers a saved configuration predates. Append-only: rows the user
 * made or edited keep their order and edits, and providers they deleted stay
 * gone, so shipping a new default reaches existing installs without rewriting
 * anyone's configuration.
 */
function withMissingDefaults(providers: ProviderConfig[]): ProviderConfig[] {
  const taken = new Set([...providers.map((p) => p.slug), ...retiredSlugs]);

  return providers.concat(
    DEFAULT_PROVIDERS.filter((provider) => !taken.has(provider.slug)).map((provider) => ({ ...provider })),
  );
}

/**
 * Makes every provider point at a model it actually offers, and the selection at
 * a provider that exists. A hidden or deleted model must never stay selected:
 * the agent would build a request for a model the UI no longer lists.
 */
function repairSelection(
  providers: ProviderConfig[],
  selectedSlug: string,
): { providers: ProviderConfig[]; selectedSlug: string } {
  const fallbackSlug = providers[0]?.slug ?? DEFAULT_PROVIDERS[0]?.slug ?? 'provider';
  const slug = providers.some((provider) => provider.slug === selectedSlug) ? selectedSlug : fallbackSlug;

  const repaired = providers.map((provider) => {
    const offered = modelsForProvider(provider);

    if (offered.length === 0 || offered.some((model) => model.modelId === provider.selectedModelId)) {
      return provider;
    }

    return { ...provider, selectedModelId: offered[0].modelId };
  });

  return { providers: repaired, selectedSlug: slug };
}

/**
 * Rewrites a per-model registry into per-provider configuration. Profiles that
 * shared a provider slug become one provider; their endpoint, dialect and key
 * slot come from the first row, and any model the catalog does not carry — or
 * carries with a different context window — is kept as the user's own entry.
 */
function migrateLegacy(legacy: LegacyRegistry): StoredConfig {
  const groups = new Map<string, ModelDescriptor[]>();

  for (const model of legacy.models ?? []) {
    const slug = sanitizeKeyRef(providerSlugOf(model.id)) || deriveProviderSlug(model.label);
    const group = groups.get(slug) ?? [];

    group.push(model);
    groups.set(slug, group);
  }

  const selectedSlug = sanitizeKeyRef(providerSlugOf(legacy.selectedId)) || '';
  const providers: ProviderConfig[] = [];

  for (const [slug, group] of groups) {
    const first = group[0];
    // A legacy profile names its gateway in the label, not in a catalogue slug, so
    // the endpoint is what identifies it: without the entry none of the gateway's
    // models merge and every row reads `ctx unset · price unknown`.
    const entry = catalogProvider(slug) ?? catalogProviderForEndpoint(first.baseUrl ?? '', first.dialect);
    const extraModels: ProviderModel[] = [];

    for (const row of group) {
      const catalogModel = entry?.models.find((model) => model.id === row.modelId);
      // The catalogue supplies context, capabilities and price, so a row it carries
      // needs no copy. Only a context window the user set, or a model the catalogue
      // does not list, is kept as the user's own entry.
      if (
        catalogModel !== undefined &&
        (row.contextWindow === undefined || row.contextWindow === catalogModel.contextWindow)
      ) {
        continue;
      }

      extraModels.push({
        modelId: row.modelId,
        label: catalogModel?.name ?? row.label,
        contextWindow: row.contextWindow,
        capabilities: row.capabilities ?? DEFAULT_CAPABILITIES,
        pricing: row.pricing,
        added: true,
      });
    }

    const provider: ProviderConfig = {
      slug,
      // The catalogue entry is addressed by slug, which the legacy name-derived slug
      // is not; keeping both lets the model list merge while the user's own slug,
      // endpoint and key slot stay put.
      catalogSlug: entry?.slug,
      // Legacy rows named themselves `Provider · model`; the provider keeps its own
      // part of that name so the chat chip does not repeat the model.
      name: providerNameOf(first.label, first.label, first.modelId) || entry?.name || slug,
      dialect: first.dialect,
      baseUrl: first.baseUrl ?? dialectDefaultBaseUrl(first.dialect),
      source: first.source,
      apiKeyRef: first.apiKeyRef,
      docsUrl: entry?.docsUrl,
      note: entry?.note ?? first.note,
      headers: first.headers,
      endpoints: entry?.endpoints,
      extraModels,
      hiddenModelIds: [],
      selectedModelId:
        slug === selectedSlug ? modelNameOf(legacy.selectedId) || first.modelId : first.modelId,
    };

    providers.push(normalizeProvider(provider));
  }

  // A default provider that survived migration is not retired; a default whose
  // whole provider is gone stays gone.
  const retired = (legacy.retiredDefaults ?? [])
    .map((id) => sanitizeKeyRef(providerSlugOf(id)))
    .filter((slug) => slug.length > 0 && !providers.some((provider) => provider.slug === slug));

  return {
    schema: SCHEMA_VERSION,
    providers,
    selectedSlug: providers.some((provider) => provider.slug === selectedSlug)
      ? selectedSlug
      : (providers[0]?.slug ?? DEFAULT_PROVIDERS[0].slug),
    retiredSlugs: [...new Set(retired)],
  };
}

/** Repairs a stored provider list: sane endpoint, key slot, model and selection. */
function sanitizeStored(stored: StoredConfig): { providers: ProviderConfig[]; selectedSlug: string } {
  const providers = (Array.isArray(stored.providers) ? stored.providers : [])
    .filter((provider) => typeof provider?.slug === 'string' && provider.slug.length > 0)
    .map(normalizeProvider);

  return repairSelection(withMissingDefaults(providers), stored.selectedSlug ?? '');
}

const useConfigStore = create<ConfigState>()((set, get) => ({
  providers: DEFAULT_PROVIDERS,
  selectedSlug: DEFAULT_PROVIDERS[0].slug,
  loaded: false,

  async load() {
    const stored = await getJson<StoredConfig>(STORAGE_KEY);

    if (stored === null) {
      const legacy = await getJson<LegacyRegistry>(LEGACY_STORAGE_KEY);

      if (legacy === null || !Array.isArray(legacy.models) || legacy.models.length === 0) {
        set({ loaded: true });
        return;
      }

      const migrated = migrateLegacy(legacy);

      retiredSlugs = migrated.retiredSlugs ?? [];
      set({ providers: migrated.providers, selectedSlug: migrated.selectedSlug, loaded: true });
      await setJson(STORAGE_KEY, migrated);
      // The old shape is not read again; leaving it would re-migrate on a reset.
      await deleteKey(LEGACY_STORAGE_KEY);
      return;
    }

    retiredSlugs = stored.retiredSlugs ?? [];
    const { providers, selectedSlug } = sanitizeStored(stored);

    set({ providers, selectedSlug, loaded: true });

    // Heal the stored copy too: appended defaults, repaired endpoints, repaired
    // model selection, and the retired list that older builds never wrote.
    if (
      JSON.stringify(providers) !== JSON.stringify(stored.providers ?? []) ||
      selectedSlug !== stored.selectedSlug ||
      stored.retiredSlugs === undefined ||
      stored.schema !== SCHEMA_VERSION
    ) {
      persist(providers, selectedSlug);
    }
  },

  selectProvider(slug) {
    const providers = get().providers;

    if (!providers.some((provider) => provider.slug === slug)) {
      return;
    }

    set({ selectedSlug: slug });
    persist(providers, slug);
  },

  selectModel(slug, modelId) {
    const providers = get().providers;

    if (!providers.some((provider) => provider.slug === slug)) {
      return;
    }

    const next = providers.map((provider) =>
      provider.slug === slug ? { ...provider, selectedModelId: modelId } : provider,
    );

    set({ providers: next, selectedSlug: slug });
    persist(next, slug);
  },

  addProvider(input) {
    const providers = get().providers;
    const slug = uniqueProviderSlug(
      providers.map((provider) => provider.slug),
      input.slug !== undefined && input.slug.trim().length > 0
        ? sanitizeKeyRef(input.slug)
        : deriveProviderSlug(input.name),
    );
    const source = input.source;
    // A blank provider starts with no model at all: the user types one or reads
    // the server's list, so a made-up id never sits selected and 404s in chat.
    const modelId = (input.modelId ?? '').trim();
    const catalogEntry = catalogProvider(slug);
    const listed = catalogEntry?.models.some((model) => model.id === modelId) ?? false;
    const extraModels: ProviderModel[] =
      modelId.length === 0 || listed
        ? []
        : [
            {
              modelId,
              label: input.modelLabel?.trim() || modelId,
              contextWindow: input.contextWindow,
              capabilities: input.capabilities ?? DEFAULT_CAPABILITIES,
              pricing: input.pricing,
              added: true,
            },
          ];
    const endpoints: EndpointChoice[] | undefined = input.endpoints;

    const provider = normalizeProvider({
      slug,
      name: input.name.trim() || 'New provider',
      dialect: input.dialect,
      baseUrl:
        input.baseUrl && input.baseUrl.trim().length > 0
          ? input.baseUrl
          : source === 'local-server'
            ? LOCAL_SERVER_DEFAULT_BASE_URL
            : dialectDefaultBaseUrl(input.dialect),
      source,
      apiKeyRef: input.apiKeyRef,
      docsUrl: input.docsUrl,
      note: input.note,
      headers: input.headers,
      endpoints,
      extraModels,
      hiddenModelIds: [],
      selectedModelId: modelId,
    });

    const next = [...providers, provider];
    const selectedSlug = input.select ? slug : get().selectedSlug;

    set({ providers: next, selectedSlug });
    persist(next, selectedSlug);

    return provider;
  },

  updateProvider(slug, patch) {
    const providers = get().providers.map((provider) => {
      if (provider.slug !== slug) {
        return provider;
      }

      const next: ProviderConfig = { ...provider, ...patch, slug };

      if (patch.source !== undefined) {
        const current = next.baseUrl;
        const vendorDefault = dialectDefaultBaseUrl(next.dialect);

        // Only an endpoint the user never customised follows the new source.
        if (next.source === 'local-server' && current === vendorDefault) {
          next.baseUrl = LOCAL_SERVER_DEFAULT_BASE_URL;
        } else if (next.source === 'remote' && current === LOCAL_SERVER_DEFAULT_BASE_URL) {
          next.baseUrl = vendorDefault;
        }
      }

      return normalizeProvider(next);
    });

    set({ providers });
    persist(providers, get().selectedSlug);
  },

  removeProvider(slug) {
    const providers = get().providers.filter((provider) => provider.slug !== slug);

    // A deleted built-in must not be re-added by `withMissingDefaults` later.
    if (DEFAULT_PROVIDERS.some((provider) => provider.slug === slug) && !retiredSlugs.includes(slug)) {
      retiredSlugs = [...retiredSlugs, slug];
    }

    const selectedSlug =
      get().selectedSlug === slug ? (providers[0]?.slug ?? DEFAULT_PROVIDERS[0].slug) : get().selectedSlug;

    set({ providers, selectedSlug });
    persist(providers, selectedSlug);
  },

  addModels(slug, models) {
    const providers = get().providers.map((provider) => {
      if (provider.slug !== slug) {
        return provider;
      }

      const extraModels = [...provider.extraModels];
      // Adding a model the user had hidden brings it back, typed or listed.
      const hiddenModelIds = [...provider.hiddenModelIds];

      for (const model of models) {
        const modelId = model.modelId.trim();

        if (modelId.length === 0) {
          continue;
        }

        const index = extraModels.findIndex((existing) => existing.modelId === modelId);

        extraModels[index >= 0 ? index : extraModels.length] = { ...model, modelId, added: true };

        if (hiddenModelIds.includes(modelId)) {
          hiddenModelIds.splice(hiddenModelIds.indexOf(modelId), 1);
        }
      }

      const selectedModelId = modelsForProvider({ ...provider, extraModels, hiddenModelIds }).some(
        (model) => model.modelId === provider.selectedModelId,
      )
        ? provider.selectedModelId
        : (extraModels[0]?.modelId ?? provider.selectedModelId);

      return { ...provider, extraModels, hiddenModelIds, selectedModelId };
    });

    set({ providers });
    persist(providers, get().selectedSlug);
  },

  removeModel(slug, modelId) {
    const providers = get().providers.map((provider) => {
      if (provider.slug !== slug) {
        return provider;
      }

      // Typed models are deleted; catalog models are hidden, and can be restored.
      const isTyped = provider.extraModels.some((model) => model.modelId === modelId);
      const next: ProviderConfig = {
        ...provider,
        extraModels: isTyped
          ? provider.extraModels.filter((model) => model.modelId !== modelId)
          : provider.extraModels,
        hiddenModelIds: isTyped
          ? provider.hiddenModelIds
          : [...provider.hiddenModelIds, modelId],
      };

      // Whatever the provider now offers takes over if chat was on the removed model.
      const offered = modelsForProvider(next);

      return offered.some((model) => model.modelId === next.selectedModelId)
        ? next
        : { ...next, selectedModelId: offered[0]?.modelId ?? 'model' };
    });

    set({ providers });
    persist(providers, get().selectedSlug);
  },

  restoreHiddenModels(slug) {
    const providers = get().providers.map((provider) =>
      provider.slug === slug ? { ...provider, hiddenModelIds: [] } : provider,
    );

    set({ providers });
    persist(providers, get().selectedSlug);
  },

  setEndpoint(slug, baseUrl) {
    const providers = get().providers.map((provider) =>
      provider.slug === slug
        ? normalizeProvider({ ...provider, baseUrl: baseUrl.trim() })
        : provider,
    );

    set({ providers });
    persist(providers, get().selectedSlug);
  },
}));

export const useConfig = useConfigStore;

/** Clears persisted configuration back to the defaults. */
export async function resetConfig(): Promise<void> {
  await deleteKey(STORAGE_KEY);
  await deleteKey(LEGACY_STORAGE_KEY);
  retiredSlugs = [];
  useConfig.setState({
    providers: DEFAULT_PROVIDERS,
    selectedSlug: DEFAULT_PROVIDERS[0].slug,
  });
}
