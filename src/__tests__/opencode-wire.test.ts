import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { DEFAULT_CAPABILITIES, type ModelDescriptor } from '../core/model';
import { createLanguageModel } from '../core/provider';
import { setFetchImplementation } from '../core/http';
import { CLIENT_USER_AGENT, SESSION_HEADER, loadConversationSessionId } from '../core/session';

// The point of this test is what leaves the device, so the real
// `@ai-sdk/openai-compatible` adapter runs against a stub fetch instead of being
// mocked: OpenCode answers `400 MissingSessionID` unless the header is on the
// outgoing request, which only the wire shows. `jest.mock` is hoisted above the
// imports; mock variables must be `mock`-prefixed and read in deferred bodies.
const mockFetch = jest.fn(async (_url: string, init: RequestInit): Promise<Response> =>
  new Response(
    [
      'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
      'data: [DONE]\n\n',
    ].join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  ),
);

jest.mock('../store/db', () => ({
  getJson: async () => ({ id: 'ses_stored' }),
  setJson: async () => {},
  deleteKey: async () => {},
}));

beforeEach(async () => {
  mockFetch.mockClear();
  setFetchImplementation(mockFetch as unknown as typeof globalThis.fetch);
  await loadConversationSessionId();
});

function descriptor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'opencode-go:deepseek-v4.1-flash',
    label: 'OpenCode Go',
    dialect: 'openai-compatible',
    modelId: 'deepseek-v4.1-flash',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    source: 'remote',
    capabilities: DEFAULT_CAPABILITIES,
    contextWindow: 1_000_000,
    ...overrides,
  };
}

async function requestFor(model: ModelDescriptor, apiKey: string): Promise<[string, RequestInit]> {
  const chat = createLanguageModel(model, apiKey);

  await chat.doStream({
    // V4 messages carry content parts, not a plain string.
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    headers: {},
  });

  return mockFetch.mock.calls[0] as [string, RequestInit];
}

function headersOf(init: RequestInit): Headers {
  // The vendor package hands the fetch layer a plain object with lower-case keys;
  // `Headers` normalises the lookup so the assertions do not depend on casing.
  return new Headers(init.headers);
}

describe('OpenCode request headers on the wire', () => {
  it('sends the session id, the client user agent and the credential', async () => {
    const [url, init] = await requestFor(descriptor(), 'oc_key');

    expect(url).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions');

    const headers = headersOf(init);

    expect(headers.get(SESSION_HEADER)).toBe('ses_stored');
    // The vendor package appends its own suffix, so the client name is a prefix.
    expect(headers.get('user-agent')?.startsWith(CLIENT_USER_AGENT)).toBe(true);
    expect(headers.get('authorization')).toBe('Bearer oc_key');
  });

  it('sends the session id on the zen alias too', async () => {
    const [, init] = await requestFor(
      descriptor({ baseUrl: 'https://opencode.ai/zen/go/v1' }),
      'oc_key',
    );

    expect(mockFetch.mock.calls[0][0]).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    expect(headersOf(init).get(SESSION_HEADER)).toBe('ses_stored');
  });

  it('sends nothing extra to a LAN server', async () => {
    const [, init] = await requestFor(
      descriptor({
        id: 'compatible:qwen3.5:9b',
        baseUrl: 'http://192.168.178.87:11434/v1',
        source: 'local-server',
      }),
      'ignored',
    );

    const headers = headersOf(init);

    expect(headers.get(SESSION_HEADER)).toBeNull();
    expect(headers.get('user-agent')?.includes(CLIENT_USER_AGENT)).toBe(false);
  });

  it('lets a profile override the session id', async () => {
    const [, init] = await requestHeadersWithOverride();

    expect(headersOf(init).get(SESSION_HEADER)).toBe('ses_mine');
  });
});

async function requestHeadersWithOverride() {
  return requestFor(descriptor({ headers: { [SESSION_HEADER]: 'ses_mine' } }), 'k');
}
