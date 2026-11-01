import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CAPABILITIES,
  activeDescriptor,
  authStyleFor,
  deriveApiKeyRef,
  descriptorFor,
  endpointPreview,
  profileIdFor,
  resolvedBaseUrl,
  sanitizeKeyRef,
  uniqueProfileId,
  type ModelDescriptor,
  type ProviderConfig,
  type ProviderModel,
} from '../core/model';

function descriptor(overrides: Partial<ModelDescriptor>): ModelDescriptor {
  return {
    id: 'openai:gpt-5-mini',
    label: 'Remote',
    providerLabel: 'Remote',
    modelLabel: 'GPT-5 Mini',
    dialect: 'openai-chat',
    modelId: 'gpt-5-mini',
    apiKeyRef: 'k',
    source: 'remote',
    capabilities: DEFAULT_CAPABILITIES,
    ...overrides,
  };
}

describe('auth style per dialect', () => {
  it('keys are sent as Bearer for OpenAI-style dialects', () => {
    expect(authStyleFor('openai-chat', 'k')).toBe('bearer');
    expect(authStyleFor('openai-responses', 'k')).toBe('bearer');
    expect(authStyleFor('openai-compatible', 'k')).toBe('bearer');
  });

  it('anthropic uses x-api-key and gemini a query param', () => {
    expect(authStyleFor('anthropic-messages', 'k')).toBe('x-api-key');
    expect(authStyleFor('gemini-generate-content', 'k')).toBe('query-key');
  });

  it('a profile without a key slot sends no credential', () => {
    expect(authStyleFor('openai-chat', undefined)).toBe('none');
  });
});

describe('endpoint preview', () => {
  it('shows the path each dialect appends', () => {
    expect(endpointPreview(descriptor({}))).toBe(
      'Authorization: Bearer · POST https://api.openai.com/v1/chat/completions',
    );
    expect(endpointPreview(descriptor({ dialect: 'anthropic-messages' }))).toBe(
      'x-api-key header · POST https://api.anthropic.com/v1/messages',
    );
    expect(endpointPreview(descriptor({ dialect: 'gemini-generate-content' }))).toBe(
      'key as query param · POST https://generativelanguage.googleapis.com/v1beta/models/gpt-5-mini:generateContent',
    );
  });

  it('a custom gateway endpoint replaces the vendor origin', () => {
    expect(endpointPreview(descriptor({ baseUrl: 'https://gateway.example/api/v1///' }))).toBe(
      'Authorization: Bearer · POST https://gateway.example/api/v1/chat/completions',
    );
  });

  it('an empty base URL falls back to the dialect default', () => {
    expect(resolvedBaseUrl(descriptor({ baseUrl: '' }))).toBe('https://api.openai.com/v1');
  });

  it('a LAN profile without a key slot says no credential is sent', () => {
    expect(
      endpointPreview(
        descriptor({
          dialect: 'openai-compatible',
          apiKeyRef: undefined,
          source: 'local-server',
          baseUrl: 'http://localhost:11434/v1',
        }),
      ),
    ).toBe('no key sent · POST http://localhost:11434/v1/chat/completions');
  });
});

describe('credential slots and profile ids', () => {
  it('SecureStore names keep only alphanumeric, dot, dash and underscore', () => {
    expect(sanitizeKeyRef('ollama:qwen3.5:9b-api-key')).toBe('ollama-qwen3.5-9b-api-key');
    expect(sanitizeKeyRef('  spaced / ref  ')).toBe('spaced-ref');
    expect(sanitizeKeyRef('x'.repeat(100)).length).toBe(64);
  });

  it('a new remote profile gets a derivable key slot', () => {
    expect(deriveApiKeyRef('openai:gpt-5-mini')).toBe('openai-gpt-5-mini-api-key');
  });

  it('profile ids are prefixed by source and dialect', () => {
    expect(profileIdFor('remote', 'anthropic-messages', 'claude-sonnet-4-5')).toBe(
      'anthropic:claude-sonnet-4-5',
    );
    expect(profileIdFor('local-server', 'openai-compatible', 'qwen3:4b')).toBe('local:qwen3:4b');
    expect(profileIdFor('remote', 'openai-chat', '')).toBe('openai:model');
  });

  it('ids stay unique', () => {
    expect(uniqueProfileId(['openai:model'], 'openai:model')).toBe('openai:model-2');
    expect(uniqueProfileId(['openai:model', 'openai:model-2'], 'openai:model')).toBe(
      'openai:model-3',
    );
    expect(uniqueProfileId([], 'openai:model')).toBe('openai:model');
  });
});

describe('provider and model names', () => {
  const model: ProviderModel = {
    modelId: 'deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    capabilities: DEFAULT_CAPABILITIES,
  };

  function provider(name: string): ProviderConfig {
    return {
      slug: 'opencode-go',
      name,
      dialect: 'openai-compatible',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKeyRef: 'opencode-go-api-key',
      source: 'remote',
      hiddenModelIds: [],
      extraModels: [],
      selectedModelId: model.modelId,
    };
  }

  it('keeps the model name out of the provider name', () => {
    const descriptor = descriptorFor(provider('OpenCode Go (zen alias) · DeepSeek V4.1 Flash'), model);

    expect(descriptor.providerLabel).toBe('OpenCode Go (zen alias)');
    expect(descriptor.modelLabel).toBe('DeepSeek V4.1 Flash');
    expect(descriptor.label).toBe('OpenCode Go (zen alias) · DeepSeek V4.1 Flash');
  });

  it('strips a trailing model id too, and keeps the endpoint alias', () => {
    const descriptor = descriptorFor(provider('OpenCode Go · deepseek-v4.1-flash'), model);

    expect(descriptor.providerLabel).toBe('OpenCode Go');
  });

  it('leaves a provider name that never mentioned the model alone', () => {
    const descriptor = descriptorFor(provider('Ollama on LAN'), model);

    expect(descriptor.providerLabel).toBe('Ollama on LAN');
    expect(descriptor.label).toBe('Ollama on LAN · DeepSeek V4.1 Flash');
  });

  it('does not repeat a provider named after the model', () => {
    const descriptor = descriptorFor(provider('DeepSeek V4.1 Flash'), model);

    expect(descriptor.providerLabel).toBe('DeepSeek V4.1 Flash');
    expect(descriptor.label).toBe('DeepSeek V4.1 Flash');
  });

  it('falls back to the slug when nothing usable is left', () => {
    const descriptor = descriptorFor(provider(' · DeepSeek V4.1 Flash'), model);

    expect(descriptor.providerLabel).toBe('opencode-go');
  });

  it('the active descriptor carries both names', () => {
    const descriptor = activeDescriptor(provider('OpenCode Go (zen alias)'), [model]);

    expect(descriptor.providerLabel).toBe('OpenCode Go (zen alias)');
    expect(descriptor.modelLabel).toBe('DeepSeek V4.1 Flash');
  });
});
