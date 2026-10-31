import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { DEFAULT_CAPABILITIES, type ModelDescriptor } from '../core/model';
import { getFetchImplementation, setFetchImplementation } from '../core/http';
import { createLanguageModel } from '../core/provider';

// The AI SDK ships ESM only, so the provider packages are stubbed here. These
// tests assert our dialect wiring (which base URL, which model shape, which
// fetch implementation), not the vendor internals. Mock variables must be
// `mock`-prefixed for `jest.mock` factories to reference them.
const mockOpenAI = jest.fn();
const mockAnthropic = jest.fn();
const mockGoogle = jest.fn();
const mockCompatible = jest.fn();

jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: (settings: unknown) => {
    mockOpenAI(settings);

    return Object.assign((modelId: string) => ({ id: `openai:${modelId}` }), {
      chat: (modelId: string) => ({ id: `openai-chat:${modelId}` }),
      responses: (modelId: string) => ({ id: `openai-responses:${modelId}` }),
    });
  },
}));

jest.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: (settings: unknown) => {
    mockAnthropic(settings);

    return Object.assign((modelId: string) => ({ id: `anthropic:${modelId}` }), {
      messages: (modelId: string) => ({ id: `anthropic-messages:${modelId}` }),
    });
  },
}));

jest.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: (settings: unknown) => {
    mockGoogle(settings);

    return Object.assign((modelId: string) => ({ id: `google:${modelId}` }), {
      languageModel: (modelId: string) => ({ id: `google-language-model:${modelId}` }),
    });
  },
}));

jest.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: (settings: unknown) => {
    mockCompatible(settings);

    return Object.assign((modelId: string) => ({ id: `compatible:${modelId}` }), {
      chatModel: (modelId: string) => ({ id: `compatible:${modelId}` }),
    });
  },
}));

function descriptor(overrides: Partial<ModelDescriptor>): ModelDescriptor {
  return {
    id: 'test:model',
    label: 'Test model',
    dialect: 'openai-chat',
    modelId: 'test-model',
    source: 'remote',
    capabilities: DEFAULT_CAPABILITIES,
    ...overrides,
  };
}

beforeEach(() => {
  mockOpenAI.mockClear();
  mockAnthropic.mockClear();
  mockGoogle.mockClear();
  mockCompatible.mockClear();
});

describe('dialect adapters', () => {
  it('openai-chat uses the vendor base URL and the chat shape', () => {
    const model = createLanguageModel(descriptor({ modelId: 'gpt-5-mini' }), 'secret-key');

    expect(model).toEqual({ id: 'openai-chat:gpt-5-mini' });
    expect(mockOpenAI).toHaveBeenCalledWith({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'secret-key',
      fetch: getFetchImplementation(),
    });
  });

  it('openai-responses selects the responses endpoint shape', () => {
    const model = createLanguageModel(descriptor({ dialect: 'openai-responses' }), 'k');

    expect(model).toEqual({ id: 'openai-responses:test-model' });
  });

  it('strips a trailing slash from a custom base URL', () => {
    createLanguageModel(descriptor({ baseUrl: 'https://gateway.example/api/v1/' }), 'k');

    expect(mockOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://gateway.example/api/v1' }),
    );
  });

  it('anthropic gets its own provider and the messages shape', () => {
    const model = createLanguageModel(
      descriptor({ dialect: 'anthropic-messages', modelId: 'claude-sonnet-4-5' }),
      'anthropic-key',
    );

    expect(model).toEqual({ id: 'anthropic-messages:claude-sonnet-4-5' });
    expect(mockAnthropic).toHaveBeenCalledWith({
      baseURL: 'https://api.anthropic.com/v1',
      apiKey: 'anthropic-key',
      fetch: getFetchImplementation(),
    });
    expect(mockOpenAI).not.toHaveBeenCalled();
  });

  it('gemini gets its own provider', () => {
    createLanguageModel(
      descriptor({ dialect: 'gemini-generate-content', modelId: 'gemini-2.5-flash' }),
      'gemini-key',
    );

    expect(mockGoogle).toHaveBeenCalledWith({
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'gemini-key',
      fetch: getFetchImplementation(),
    });
  });

  it('openai-compatible names the provider from the descriptor id', () => {
    const model = createLanguageModel(
      descriptor({
        id: 'ollama:qwen3:4b',
        dialect: 'openai-compatible',
        modelId: 'qwen3:4b',
        baseUrl: 'http://10.0.2.2:11434/v1',
        source: 'local-server',
      }),
    );

    expect(model).toEqual({ id: 'compatible:qwen3:4b' });
    expect(mockCompatible).toHaveBeenCalledWith({
      name: 'ollama',
      baseURL: 'http://10.0.2.2:11434/v1',
      apiKey: undefined,
      fetch: getFetchImplementation(),
    });
  });

  it('exposes the fetch implementation that can be swapped for tests', () => {
    const replacement = jest.fn();
    const previous = getFetchImplementation();

    setFetchImplementation(replacement as unknown as typeof globalThis.fetch);
    expect(getFetchImplementation()).toBe(replacement);

    setFetchImplementation(previous);
    expect(getFetchImplementation()).toBe(previous);
  });
});
