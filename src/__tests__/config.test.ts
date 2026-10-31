import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { DEFAULT_MODELS, resetConfig, useConfig } from '../store/config';
import type { ModelDescriptor } from '../core/model';

// SQLite is native, so the store is stubbed with a plain map. `jest.mock` is
// hoisted above the imports by the transform; mock variables must be
// `mock`-prefixed and only read inside deferred call bodies.
const mockRows = new Map<string, unknown>();

jest.mock('../store/db', () => ({
  getJson: async (key: string) => (mockRows.has(key) ? mockRows.get(key) : null),
  setJson: async (key: string, value: unknown) => {
    mockRows.set(key, value);
  },
  deleteKey: async (key: string) => {
    mockRows.delete(key);
  },
}));

function stored(): { models: unknown[]; selectedId: string } {
  return mockRows.get('model-registry') as { models: unknown[]; selectedId: string };
}

beforeEach(() => {
  mockRows.clear();
  useConfig.setState({ models: DEFAULT_MODELS, selectedId: DEFAULT_MODELS[0].id, loaded: true });
});

describe('createProfile', () => {
  it('adds a remote provider with a vendor endpoint and a key slot', () => {
    const profile = useConfig.getState().createProfile({
      source: 'remote',
      dialect: 'openai-chat',
      label: 'Gateway',
      modelId: 'gpt-5.1',
    });

    expect(profile.id).toBe('openai:gpt-5.1');
    expect(profile.baseUrl).toBe('https://api.openai.com/v1');
    expect(profile.apiKeyRef).toBe('openai-gpt-5.1-api-key');
    expect(useConfig.getState().models).toContainEqual(profile);
  });

  it('does not select an unconfigured profile for chat', () => {
    const before = useConfig.getState().selectedId;

    useConfig.getState().createProfile({
      source: 'remote',
      dialect: 'anthropic-messages',
      label: 'Anthropic gateway',
      modelId: 'claude-sonnet-4-5',
    });

    expect(useConfig.getState().selectedId).toBe(before);
  });

  it('honours a custom endpoint and trims trailing slashes', () => {
    const profile = useConfig.getState().createProfile({
      source: 'remote',
      dialect: 'openai-compatible',
      label: 'vLLM',
      modelId: 'qwen3:4b',
      baseUrl: 'http://192.168.1.20:8000/v1/',
    });

    expect(profile.baseUrl).toBe('http://192.168.1.20:8000/v1');
    expect(profile.id).toBe('compatible:qwen3:4b');
  });

  it('gives LAN servers no credential slot', () => {
    const profile = useConfig.getState().createProfile({
      source: 'local-server',
      dialect: 'openai-compatible',
      label: 'Ollama',
      modelId: 'qwen3.5:9b',
    });

    expect(profile.apiKeyRef).toBeUndefined();
    expect(profile.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('keeps ids unique when the same model is added twice', () => {
    const input = {
      source: 'remote' as const,
      dialect: 'openai-chat' as const,
      label: 'Dup',
      modelId: 'gpt-5.1',
    };

    const first = useConfig.getState().createProfile(input);
    const second = useConfig.getState().createProfile(input);

    expect(first.id).toBe('openai:gpt-5.1');
    expect(second.id).toBe('openai:gpt-5.1-2');
    expect(second.apiKeyRef).toBe('openai-gpt-5.1-2-api-key');
  });

  it('persists the registry to the store', () => {
    useConfig.getState().createProfile({
      source: 'remote',
      dialect: 'gemini-generate-content',
      label: 'Gemini',
      modelId: 'gemini-2.5-flash',
    });

    expect(stored().models).toHaveLength(DEFAULT_MODELS.length + 1);
  });
});

describe('updateModel', () => {
  it('derives a key slot when a profile becomes remote', () => {
    const profile = useConfig.getState().createProfile({
      source: 'local-server',
      dialect: 'openai-compatible',
      label: 'Gateway that is actually remote',
      modelId: 'mixtral',
    });

    useConfig.getState().updateModel(profile.id, { source: 'remote' });

    const updated = useConfig.getState().models.find((model) => model.id === profile.id);

    expect(updated?.apiKeyRef).toBe('local-mixtral-api-key');
  });

  it('drops the key slot when a profile becomes a LAN server', () => {
    const profile = useConfig.getState().createProfile({
      source: 'remote',
      dialect: 'openai-chat',
      label: 'Now local',
      modelId: 'phi',
    });

    useConfig.getState().updateModel(profile.id, { source: 'local-server' });

    const updated = useConfig.getState().models.find((model) => model.id === profile.id);

    expect(updated?.apiKeyRef).toBeUndefined();
    expect(updated?.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('keeps the id when the label and model id are edited', () => {
    const [first] = DEFAULT_MODELS;

    useConfig.getState().updateModel(first.id, { label: 'Renamed', modelId: 'other' });

    const updated = useConfig.getState().models.find((model) => model.id === first.id);

    expect(updated?.id).toBe(first.id);
    expect(updated?.label).toBe('Renamed');
  });

  it('touches only the profile being edited', () => {
    const [, second, third] = DEFAULT_MODELS;

    useConfig.getState().updateModel(second.id, { dialect: 'openai-compatible', source: 'remote' });

    // A patch must not leak onto the other rows: it used to rewrite every
    // profile's dialect and stamp them all with the edited id.
    expect(useConfig.getState().models.find((model) => model.id === third.id)).toEqual(third);
    expect(useConfig.getState().models.map((model) => model.id)).toEqual(
      DEFAULT_MODELS.map((model) => model.id),
    );
  });

  it('keeps the credential slot of untouched profiles', () => {
    const [, second, third] = DEFAULT_MODELS;

    useConfig.getState().updateModel(second.id, { source: 'local-server' });

    expect(useConfig.getState().models.find((model) => model.id === third.id)?.apiKeyRef).toBe(
      third.apiKeyRef,
    );
  });
});

describe('load', () => {
  it('repairs a registry whose ids collided', async () => {
    const damaged: ModelDescriptor = {
      id: 'openai:model-2',
      label: 'Ollama on LAN',
      dialect: 'openai-compatible',
      modelId: 'qwen3.5:9b',
      baseUrl: 'http://localhost:11434/v1',
      source: 'local-server',
      capabilities: { tools: true, vision: true, reasoning: true },
      contextWindow: 32768,
    };

    mockRows.set('model-registry', {
      models: [
        damaged,
        { ...damaged, label: 'OpenAI GPT-5 Mini', modelId: 'gpt-5-mini', source: 'remote' },
        { ...damaged, label: 'Anthropic', modelId: 'claude-sonnet-4-5', source: 'remote' },
      ],
      selectedId: 'openai:model-2',
    });

    await useConfig.getState().load();

    const models = useConfig.getState().models;

    // Repaired ids describe the profile instead of carrying a numeric suffix.
    expect(models.map((model) => model.id)).toEqual([
      'openai:model-2',
      'compatible:gpt-5-mini',
      'compatible:claude-sonnet-4-5',
    ]);
    expect(models.map((model) => model.label)).toEqual([
      'Ollama on LAN',
      'OpenAI GPT-5 Mini',
      'Anthropic',
    ]);
    // The healed registry is written back, so the repair survives a restart.
    expect(stored().models).toEqual(models);
  });

  it('selects the first profile when the stored selection no longer exists', async () => {
    mockRows.set('model-registry', { models: DEFAULT_MODELS, selectedId: 'gone:model' });

    await useConfig.getState().load();

    expect(useConfig.getState().selectedId).toBe(DEFAULT_MODELS[0].id);
  });
});

describe('removeModel', () => {
  it('falls back to another model when the selected one is deleted', () => {
    const [first, second] = DEFAULT_MODELS;

    useConfig.getState().select(first.id);
    useConfig.getState().removeModel(first.id);

    expect(useConfig.getState().selectedId).toBe(second.id);
    expect(useConfig.getState().models.some((model) => model.id === first.id)).toBe(false);
  });
});

describe('resetConfig', () => {
  it('clears persisted profiles back to the defaults', async () => {
    useConfig.getState().createProfile({
      source: 'remote',
      dialect: 'openai-chat',
      label: 'Temp',
      modelId: 'x',
    });

    await resetConfig();

    expect(useConfig.getState().models).toEqual(DEFAULT_MODELS);
    expect(mockRows.size).toBe(0);
  });
});
