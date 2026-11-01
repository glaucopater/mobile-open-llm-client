import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  conversationSessionId,
  hostOf,
  loadConversationSessionId,
  needsSessionHeader,
} from '../core/session';

// SQLite is native, so the kv store the session id lives in is stubbed. `jest.mock`
// is hoisted above the imports; mock variables must be `mock`-prefixed.
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

beforeEach(() => {
  mockRows.clear();
});

describe('hostOf', () => {
  it('reads the host and ignores scheme, credentials and port', () => {
    expect(hostOf('https://opencode.ai/inference/go/openai/v1')).toBe('opencode.ai');
    expect(hostOf('https://user:pass@gateway.example:8443/v1')).toBe('gateway.example');
    expect(hostOf('http://192.168.178.87:11434/v1')).toBe('192.168.178.87');
    expect(hostOf('opencode.ai')).toBe('');
  });
});

describe('needsSessionHeader', () => {
  it('matches OpenCode and its subdomains', () => {
    expect(needsSessionHeader('https://opencode.ai/zen/go/v1')).toBe(true);
    expect(needsSessionHeader('https://opencode.ai/inference/go/openai/v1')).toBe(true);
    expect(needsSessionHeader('https://console.opencode.ai/v1')).toBe(true);
  });

  it('does not match look-alike hosts or local servers', () => {
    expect(needsSessionHeader('http://localhost:11434/v1')).toBe(false);
    expect(needsSessionHeader('https://opencode.ai.evil.example/v1')).toBe(false);
    expect(needsSessionHeader('https://notopencode.ai/v1')).toBe(false);
  });
});

describe('conversation session id', () => {
  it('mints one and stores it on first use', async () => {
    const id = await loadConversationSessionId();

    expect(id).toMatch(/^ses_[0-9a-z]+_[0-9a-z]+$/);
    expect(mockRows.get('conversation-session')).toEqual({ id });
  });

  it('reuses the stored id across restarts', async () => {
    const first = await loadConversationSessionId();
    const again = await loadConversationSessionId();

    expect(again).toBe(first);
    expect(conversationSessionId()).toBe(first);
  });
});
