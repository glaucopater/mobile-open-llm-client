/**
 * App configuration store: the model registry plus the selected model.
 *
 * Non-secret config is persisted to SQLite; keys stay in SecureStore. Defaults
 * cover one remote provider per dialect plus a LAN local server, so the app is
 * usable before any profile is edited.
 */
import { create } from 'zustand';

import { deleteKey, getJson, setJson } from './db';
import {
  DEFAULT_CAPABILITIES,
  deriveApiKeyRef,
  dialectDefaultBaseUrl,
  normalizeBaseUrl,
  profileIdFor,
  sanitizeKeyRef,
  uniqueProfileId,
  type Dialect,
  type ModelCapabilities,
  type ModelDescriptor,
  type ModelPricing,
  type ModelSource,
} from '../core/model';

const STORAGE_KEY = 'model-registry';

/**
 * Emulator default. `adb reverse tcp:11434 tcp:11434` forwards the emulator's
 * localhost to the host, which works even when the server binds 127.0.0.1.
 * Without that reverse, use the host's LAN address (e.g. `http://10.0.2.2:11434/v1`)
 * and bind the server to `0.0.0.0`.
 */
export const LOCAL_SERVER_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

export const DEFAULT_MODELS: ModelDescriptor[] = [
  {
    id: 'ollama:qwen3.5:9b',
    label: 'Ollama on LAN',
    dialect: 'openai-compatible',
    modelId: 'qwen3.5:9b',
    baseUrl: LOCAL_SERVER_DEFAULT_BASE_URL,
    source: 'local-server',
    capabilities: { tools: true, vision: true, reasoning: true },
    contextWindow: 32768,
  },
  {
    id: 'openai:gpt-5-mini',
    label: 'OpenAI GPT-5 Mini',
    dialect: 'openai-chat',
    modelId: 'gpt-5-mini',
    apiKeyRef: 'openai-api-key',
    source: 'remote',
    capabilities: { ...DEFAULT_CAPABILITIES, reasoning: true },
    contextWindow: 400_000,
    pricing: { inputPer1k: 0.25, outputPer1k: 2 },
  },
  {
    id: 'anthropic:claude-sonnet-4-5',
    label: 'Anthropic Claude Sonnet 4.5',
    dialect: 'anthropic-messages',
    modelId: 'claude-sonnet-4-5',
    apiKeyRef: 'anthropic-api-key',
    source: 'remote',
    capabilities: { ...DEFAULT_CAPABILITIES, vision: true },
    contextWindow: 200_000,
    pricing: { inputPer1k: 3, outputPer1k: 15 },
  },
  {
    id: 'gemini:gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    dialect: 'gemini-generate-content',
    modelId: 'gemini-2.5-flash',
    apiKeyRef: 'gemini-api-key',
    source: 'remote',
    capabilities: { ...DEFAULT_CAPABILITIES, vision: true, reasoning: true },
    contextWindow: 1_000_000,
    pricing: { inputPer1k: 0.3, outputPer1k: 2.5 },
  },
];

/** Minimal input for creating a profile; the store fills in id and key slot. */
export interface NewProfileInput {
  source: ModelSource;
  dialect: Dialect;
  label: string;
  modelId: string;
  /** Defaults to the dialect's vendor origin, or the LAN server for local profiles. */
  baseUrl?: string;
  contextWindow?: number;
  capabilities?: ModelCapabilities;
  /** USD per 1k tokens, carried over from a catalog preset. */
  pricing?: ModelPricing;
  /** Overrides the `provider:` half of the id, e.g. `openrouter`. */
  providerSlug?: string;
  /** Credential slot from the preset; remote profiles derive one when absent. */
  apiKeyRef?: string;
  note?: string;
}

interface ConfigState {
  models: ModelDescriptor[];
  selectedId: string;
  loaded: boolean;
  load(): Promise<void>;
  select(id: string): void;
  addModel(model: ModelDescriptor): void;
  /** Creates a profile from partial input and returns it, so the UI can open its editor. */
  createProfile(input: NewProfileInput): ModelDescriptor;
  updateModel(id: string, patch: Partial<ModelDescriptor>): void;
  removeModel(id: string): void;
}

function persistRegistry(models: ModelDescriptor[], selectedId: string): void {
  void setJson(STORAGE_KEY, { models, selectedId });
}

/**
 * Repairs a registry whose ids collided. Older builds patched every profile on
 * any edit and re-stamped their ids, which made rows unaddressable (the editor
 * opened the first match and React warned about duplicate keys). Ids are the
 * registry key and the UI's selection handle, so duplicates get a suffix.
 */
function dedupeIds(models: ModelDescriptor[]): ModelDescriptor[] {
  const seen = new Set<string>();

  return models.map((model) => {
    const taken = [...seen];
    // Prefer an id that describes the profile over a numeric suffix.
    const candidate = seen.has(model.id)
      ? profileIdFor(model.source, model.dialect, model.modelId)
      : model.id;
    const id = uniqueProfileId(taken, candidate);

    seen.add(id);

    return id === model.id ? model : { ...model, id };
  });
}

export const useConfig = create<ConfigState>()((set, get) => ({
  models: DEFAULT_MODELS,
  selectedId: DEFAULT_MODELS[0].id,
  loaded: false,

  async load() {
    const stored = await getJson<{ models: ModelDescriptor[]; selectedId: string }>(STORAGE_KEY);

    if (stored === null) {
      set({ loaded: true });
      return;
    }

    const models = dedupeIds(stored.models.length > 0 ? stored.models : DEFAULT_MODELS);
    const selectedId = models.some((m) => m.id === stored.selectedId)
      ? stored.selectedId
      : models[0].id;

    set({ models, selectedId, loaded: true });

    // Heal the stored copy too, so the repair survives a restart.
    if (models.some((model, index) => model.id !== stored.models[index]?.id)) {
      persistRegistry(models, selectedId);
    }
  },

  select(id) {
    set({ selectedId: id });
    persistRegistry(get().models, id);
  },

  addModel(model) {
    const models = [...get().models, model];

    set({ models, selectedId: model.id });
    persistRegistry(models, model.id);
  },

  createProfile(input) {
    const models = get().models;
    const modelId = input.modelId.trim() || 'model';
    const id = uniqueProfileId(
      models.map((model) => model.id),
      profileIdFor(input.source, input.dialect, modelId, input.providerSlug),
    );
    const baseUrl =
      input.baseUrl && input.baseUrl.trim().length > 0
        ? normalizeBaseUrl(input.baseUrl)
        : input.source === 'local-server'
          ? LOCAL_SERVER_DEFAULT_BASE_URL
          : dialectDefaultBaseUrl(input.dialect);

    const profile: ModelDescriptor = {
      id,
      label: input.label.trim() || 'New provider',
      dialect: input.dialect,
      modelId,
      baseUrl,
      // Remote profiles need a credential slot; LAN servers usually need none.
      apiKeyRef:
        input.source === 'remote'
          ? input.apiKeyRef !== undefined
            ? sanitizeKeyRef(input.apiKeyRef) || deriveApiKeyRef(id)
            : deriveApiKeyRef(id)
          : undefined,
      source: input.source,
      capabilities: input.capabilities ?? DEFAULT_CAPABILITIES,
      contextWindow: input.contextWindow ?? 32768,
      pricing: input.pricing,
      note: input.note,
    };

    const next = [...models, profile];

    // A new profile is not selected automatically: it has no key yet, so chat
    // would fail until the user configures it and taps the row.
    set({ models: next });
    persistRegistry(next, get().selectedId);

    return profile;
  },

  updateModel(id, patch) {
    const models = get().models.map((model) => {
      if (model.id !== id) {
        return model;
      }

      const next = { ...model, ...patch, id };

      if (patch.source !== undefined) {
        const current = next.baseUrl ?? dialectDefaultBaseUrl(next.dialect);
        const vendorDefault = dialectDefaultBaseUrl(next.dialect);

        // Only an endpoint the user never customised follows the new source.
        if (next.source === 'local-server' && current === vendorDefault) {
          next.baseUrl = LOCAL_SERVER_DEFAULT_BASE_URL;
        } else if (next.source === 'remote' && current === LOCAL_SERVER_DEFAULT_BASE_URL) {
          next.baseUrl = vendorDefault;
        }
      }

      // Remote profiles need a credential slot, otherwise the agent rejects the
      // request and Settings has nowhere to paste a key. LAN servers need none.
      if (next.source === 'remote' && next.apiKeyRef === undefined) {
        next.apiKeyRef = deriveApiKeyRef(next.id);
      } else if (next.source !== 'remote' && patch.apiKeyRef === undefined) {
        delete next.apiKeyRef;
      }

      return next;
    });

    set({ models });
    persistRegistry(models, get().selectedId);
  },

  removeModel(id) {
    const models = get().models.filter((model) => model.id !== id);
    const selectedId =
      get().selectedId === id ? (models[0]?.id ?? DEFAULT_MODELS[0].id) : get().selectedId;

    set({ models, selectedId });
    persistRegistry(models, selectedId);
  },
}));

/** Clears persisted configuration back to the defaults. */
export async function resetConfig(): Promise<void> {
  await deleteKey(STORAGE_KEY);
  useConfig.setState({ models: DEFAULT_MODELS, selectedId: DEFAULT_MODELS[0].id });
}
