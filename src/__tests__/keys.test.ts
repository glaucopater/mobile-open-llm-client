import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getApiKey, normalizeApiKey, setApiKey } from '../core/keys';

// `expo-secure-store` is native, so the store is stubbed with a map. The map is
// built at import time, but the stub only reads it inside its own call bodies.
const mockStore = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  isAvailableAsync: async () => true,
  getItemAsync: async (key: string) => mockStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    mockStore.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    mockStore.delete(key);
  },
}));

beforeEach(() => {
  mockStore.clear();
});

describe('normalizeApiKey', () => {
  it('drops the control and non-ASCII characters a paste brings along', () => {
    // A header value with a control character makes the native client refuse the
    // request, which fetch reports as "Failed to fetch" with no hint of why.
    expect(normalizeApiKey(' sk_oc\u000Akey\u000D\u000A')).toBe('sk_ockey');
    expect(normalizeApiKey('sk_oc\u00A0\u200Bkey')).toBe('sk_ockey');
    expect(normalizeApiKey('\u0000\u0001')).toBe('');
    expect(normalizeApiKey('')).toBe('');
  });

  it('keeps printable characters the key legitimately contains', () => {
    expect(normalizeApiKey('sk.oc_key-1_2')).toBe('sk.oc_key-1_2');
    expect(normalizeApiKey('Bearer sk')).toBe('Bearer sk');
  });
});

describe('stored credentials', () => {
  it('stores the normalized value, not the pasted one', async () => {
    await setApiKey('openai-api-key', 'sk_test\n');

    expect(mockStore.get('openai-api-key')).toBe('sk_test');
    expect(await getApiKey('openai-api-key')).toBe('sk_test');
  });

  it('treats a key that normalizes to nothing as no key', async () => {
    await setApiKey('openai-api-key', 'sk_test');
    await setApiKey('openai-api-key', '\u0000\u000A');

    expect(mockStore.has('openai-api-key')).toBe(false);
    expect(await getApiKey('openai-api-key')).toBeUndefined();
  });

  it('ignores a profile without a credential slot', async () => {
    expect(await getApiKey(undefined)).toBeUndefined();
  });
});
