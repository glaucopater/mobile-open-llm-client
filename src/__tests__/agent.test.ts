import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { describeConnection, describeError, testModelConnection } from '../core/agent';
import { DEFAULT_CAPABILITIES, type ModelDescriptor } from '../core/model';
import { primeKeyCache } from '../core/keys';

// The AI SDK and SecureStore are ESM/native respectively, so both are stubbed:
// these tests assert our probe wiring, not vendor internals. `jest.mock` is
// hoisted above the imports; mock variables must be `mock`-prefixed and
// referenced only inside deferred call bodies.
const mockGenerate = jest.fn(
  (options: unknown): PromiseLike<unknown> => Promise.resolve({ options }),
);
const mockCreateOpenAI = jest.fn((settings: unknown) => settings);

jest.mock('../store/db', () => ({
  getJson: async () => ({ id: 'ses_test' }),
  setJson: async () => {},
  deleteKey: async () => {},
}));

jest.mock('ai', () => ({
  isStepCount: (steps: number) => ({ stopAfter: steps }),
  wrapLanguageModel: ({ model }: { model: unknown }) => ({ guarded: model }),
  ToolLoopAgent: class {
    settings: Record<string, unknown>;

    constructor(settings: Record<string, unknown>) {
      this.settings = settings;
    }

    generate(options: unknown) {
      return mockGenerate(options);
    }
  },
}));

jest.mock('expo-secure-store', () => ({
  isAvailableAsync: async () => true,
  getItemAsync: async (key: string) => (key === 'cached-key' ? 'typed-secret' : null),
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));

jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: (settings: unknown) => {
    mockCreateOpenAI(settings);

    return { chat: (modelId: string) => ({ id: `openai-chat:${modelId}` }) };
  },
}));
jest.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: () => ({ messages: (modelId: string) => ({ id: `anthropic:${modelId}` }) }),
}));
jest.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: () => (modelId: string) => ({ id: `google:${modelId}` }),
}));
jest.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: () => ({ chatModel: (modelId: string) => ({ id: `compat:${modelId}` }) }),
}));

function descriptor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'openai:gpt-5-mini',
    label: 'Gateway',
    dialect: 'openai-chat',
    modelId: 'gpt-5-mini',
    baseUrl: 'https://gateway.example/v1',
    apiKeyRef: 'cached-key',
    source: 'remote',
    capabilities: DEFAULT_CAPABILITIES,
    contextWindow: 32768,
    ...overrides,
  };
}

function reply(input: { text?: string; usage?: Record<string, unknown> }) {
  return Promise.resolve({ text: input.text ?? 'OK', usage: input.usage ?? {} });
}

beforeEach(async () => {
  mockGenerate.mockReset();
  mockCreateOpenAI.mockReset();
  await primeKeyCache(['cached-key']);
});

describe('testModelConnection', () => {
  it('probes with one step, a timeout, and no tools', async () => {
    mockGenerate.mockImplementation(() => reply({ usage: { inputTokens: 7, outputTokens: 2 } }));

    const test = await testModelConnection(descriptor());

    expect(test.ok).toBe(true);
    expect(test.text).toBe('OK');
    expect(test.inputTokens).toBe(7);
    expect(mockGenerate).toHaveBeenCalledWith({
      prompt: 'Reply with exactly OK.',
      timeout: 20_000,
      abortSignal: undefined,
    });
  });

  it('builds the agent with a single step and the probe instructions', async () => {
    mockGenerate.mockImplementation(() => reply({}));

    await testModelConnection(descriptor());

    // The class is mocked, so inspect what `generate` was asked to run: one step
    // means the probe cannot wander into a tool loop.
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it('passes the cached credential to the dialect adapter', async () => {
    mockGenerate.mockImplementation(() => reply({}));

    await testModelConnection(descriptor());

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://gateway.example/v1',
        apiKey: 'typed-secret',
      }),
    );
  });

  it('accepts a typed key that has not been stored yet', async () => {
    mockGenerate.mockImplementation(() => reply({}));

    await testModelConnection(descriptor({ apiKeyRef: 'not-stored-yet' }), {
      apiKey: 'pasted-key',
    });

    expect(mockCreateOpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'pasted-key' }));
  });

  it('surfaces an HTTP status from the API error', async () => {
    mockGenerate.mockRejectedValue({ statusCode: 401, message: 'Invalid API key' });

    const test = await testModelConnection(descriptor());

    expect(test.ok).toBe(false);
    expect(test.error).toBe('HTTP 401 · Invalid API key');
  });

  it('explains a remote profile with no key instead of sending an empty request', async () => {
    mockGenerate.mockImplementation(() => reply({}));

    const test = await testModelConnection(descriptor({ apiKeyRef: 'missing-key' }));

    expect(test.ok).toBe(false);
    expect(test.error).toMatch(/needs an API key/);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('reports the endpoint it tested alongside the outcome', async () => {
    mockGenerate.mockImplementation(() => reply({ usage: { inputTokens: 7, outputTokens: 2 } }));

    const summary = describeConnection(descriptor(), await testModelConnection(descriptor()));

    expect(summary).toContain('POST https://gateway.example/v1/chat/completions');
    expect(summary).toContain('ok in');
    expect(summary).toContain('7 in, 2 out');
  });
});

describe('describeError', () => {
  it('clips long failure text to one displayable line', () => {
    const long = new Error(`boom ${'x'.repeat(400)}`);
    const described = describeError(long);

    expect(described).toContain('characters truncated');
    expect(described.length).toBeLessThan(long.message.length);
    expect(describeError('plain string')).toContain('plain string');
  });

  it('names a request that never reached the server instead of quoting fetch', () => {
    // expo/fetch rejects with a bare "Failed to fetch" for DNS/TLS/dropped
    // connections; the endpoint is shown beside it, so say what failed.
    expect(describeError(new TypeError('Failed to fetch'))).toBe(
      'network error · the request never reached the server (Failed to fetch)',
    );
    expect(describeError(new Error('Unable to resolve host'))).toContain('network error');
    // An HTTP status is a response, not a transport failure.
    expect(describeError({ statusCode: 502, message: 'Bad gateway' })).toBe('HTTP 502 · Bad gateway');
  });
});
