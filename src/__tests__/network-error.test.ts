import { DirectChatTransport } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { describeError } from '../core/agent';
import { describeTransportFailure, isTransportFailure, pageOrigin, urlOrigin } from '../core/network-error';

// `describeError` lives in the agent module, which reaches SecureStore and the
// SQLite-backed session id; both native modules are stubbed so the classifier can
// be imported without them.
vi.mock('expo-secure-store', () => ({
  isAvailableAsync: async () => false,
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));

vi.mock('../store/db', () => ({
  getJson: async () => null,
  setJson: async () => undefined,
  deleteKey: async () => undefined,
}));

describe('urlOrigin', () => {
  it('reads scheme, host and port', () => {
    expect(urlOrigin('https://opencode.ai/zen/go/v1')).toBe('https://opencode.ai');
    expect(urlOrigin('http://192.168.178.87:11434/v1')).toBe('http://192.168.178.87:11434');
  });

  it('says nothing about a value that is not a URL', () => {
    expect(urlOrigin('not a url')).toBe('');
    expect(urlOrigin('')).toBe('');
  });
});

describe('isTransportFailure', () => {
  it('recognises status-less failures', () => {
    for (const message of [
      'Failed to fetch',
      'Network request failed',
      'connection refused',
      'Unable to resolve host opencode.ai',
      'TLS handshake failed',
    ]) {
      expect(isTransportFailure(message)).toBe(true);
    }
  });

  it('does not mistake an answered request for a transport failure', () => {
    expect(isTransportFailure('HTTP 401 · Upstream request failed: Invalid credential')).toBe(false);
    expect(isTransportFailure('does not exceed the context window')).toBe(false);
  });
});

describe('describeTransportFailure', () => {
  const page = 'http://localhost:8081';

  it('names a browser-blocked cross-origin request, with both origins', () => {
    const line = describeTransportFailure(
      'Failed to fetch',
      'https://opencode.ai/zen/go/v1',
      page,
    );

    expect(line).toContain('blocked by the browser');
    expect(line).toContain('https://opencode.ai');
    expect(line).toContain(page);
    expect(line).toContain('Access-Control-Allow-Origin');
    // Says what the user must do instead of trusting the browser to explain it.
    expect(line).toContain('phone build');
  });

  it('calls a same-origin failure a network error', () => {
    // An origin is scheme + host + port: the page and the endpoint must match all three.
    const line = describeTransportFailure('Failed to fetch', 'http://localhost:8081/v1', page);

    expect(line).toContain('network error');
    expect(line).toContain('Failed to fetch');
    expect(line).not.toContain('blocked by the browser');
  });

  it('counts a LAN server on another port as cross-origin', () => {
    const line = describeTransportFailure('Failed to fetch', 'http://localhost:11434/v1', page);

    expect(line).toContain('blocked by the browser');
    expect(line).toContain('http://localhost:11434');
    expect(line).toContain(page);
  });

  it('calls it a network error on a native build, where CORS does not exist', () => {
    const line = describeTransportFailure('Failed to fetch', 'https://api.openai.com/v1', '');

    expect(line).toContain('network error');
    expect(line).not.toContain('blocked by the browser');
  });
});

describe('pageOrigin', () => {
  it('is empty outside a browser', () => {
    // Jest runs the native platform, so nothing here can be a CORS failure.
    expect(pageOrigin()).toBe('');
  });
});

describe('describeError', () => {
  it('keeps an HTTP status in front of the vendor message', () => {
    const error = Object.assign(new Error('Upstream request failed: Invalid credential'), {
      statusCode: 401,
    });

    expect(describeError(error, 'https://opencode.ai/zen/go/v1')).toBe(
      'HTTP 401 · Upstream request failed: Invalid credential',
    );
  });

  it('reports the wrapped cause when the outer message says nothing', () => {
    const error = Object.assign(new Error('Failed to fetch'), {
      cause: new Error('server unreachable'),
    });
    const line = describeError(error, 'http://192.168.178.87:11434/v1');

    expect(line).toContain('Failed to fetch');
    expect(line).toContain('server unreachable');
  });

  it('does not repeat a cause the message already carries', () => {
    const error = Object.assign(new Error('Failed to fetch: socket closed'), {
      cause: new Error('socket closed'),
    });

    expect(describeError(error, 'http://192.168.178.87:11434/v1')).toBe(
      'network error · the request never reached http://192.168.178.87:11434 (Failed to fetch: socket closed)',
    );
  });

  it('does not classify a request that was answered', () => {
    expect(describeError(new Error('401 unauthorized'), 'https://opencode.ai/zen/go/v1')).toBe(
      '401 unauthorized',
    );
  });

  it('names the endpoint when a failure arrives inside an accepted stream', () => {
    // Zen answers 200 and then emits an error chunk, so there is no status to
    // quote: say that the request was accepted and died mid-body.
    expect(describeError(new Error('An error occurred.'), 'https://opencode.ai/zen/go/v1')).toBe(
      'An error occurred. · accepted at https://opencode.ai/zen/go/v1 and failed inside the response',
    );
  });

  it('quotes the server body, which is what names a rejected request shape', () => {
    const error = Object.assign(new Error('Bad Request'), {
      statusCode: 400,
      responseBody: '{"error":{"message":"image parts are not supported by this model"}}',
    });

    expect(describeError(error, 'http://192.168.178.87:11434/v1')).toBe(
      'HTTP 400 · Bad Request · server said: {"error":{"message":"image parts are not supported by this model"}}',
    );
  });

  it('passes a line it already described through unchanged', () => {
    // The banner re-describes the text the transport put in the error chunk, so a
    // second pass must not append the endpoint a second time.
    const once = describeError(new Error('An error occurred.'), 'https://opencode.ai/zen/go/v1');
    const twice = describeError(new Error(once), 'https://opencode.ai/zen/go/v1');

    expect(twice).toBe(once);
    expect(twice.match(/failed inside the response/g)).toHaveLength(1);

    const network = describeError(new Error('Failed to fetch'), 'http://192.168.178.87:11434/v1');

    expect(describeError(new Error(network), 'http://192.168.178.87:11434/v1')).toBe(network);
  });
});

describe('the transport error seam', () => {
  it('surfaces the real cause instead of the SDK\'s masked message', async () => {
    // `toUIMessageStream` replaces every failure with "An error occurred." unless
    // an `onError` is given, which is what the phone showed for a rejected image.
    type TransportAgent = ConstructorParameters<typeof DirectChatTransport>[0]['agent'];
    const failingAgent = {
      tools: {},
      stream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            // Zen answers 200 and puts the failure in the body as an error part:
            // that part, not a rejected stream, is what the SDK masks.
            controller.enqueue({
              type: 'error',
              error: Object.assign(new Error('Upstream request failed'), {
                responseBody: '{"error":{"message":"image parts are not supported"}}',
              }),
            });
            controller.close();
          },
        }),
      }),
    };

    const transport = new DirectChatTransport({
      agent: failingAgent as unknown as TransportAgent,
      onError: (error: unknown) => describeError(error, 'https://opencode.ai/zen/go/v1'),
    });

    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: 'test-chat',
      messageId: undefined,
      messages: [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'what is in this image?' }] },
      ],
      abortSignal: undefined,
    });

    const chunks: { type: string; errorText?: string }[] = [];

    for await (const chunk of stream as AsyncIterable<{ type: string; errorText?: string }>) {
      chunks.push(chunk);
    }

    const error = chunks.find((chunk) => chunk.type === 'error');

    expect(error?.errorText).toContain('image parts are not supported');
    expect(error?.errorText).not.toBe('An error occurred.');
  });
});
