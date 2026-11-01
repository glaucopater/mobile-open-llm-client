/**
 * Credentials.
 *
 * The value stored is the key itself, keyed by the descriptor's `apiKeyRef`
 * (e.g. `openai-api-key`), so several providers can share one credential.
 *
 * Native builds use SecureStore and nothing secret reaches SQLite. Web has no
 * SecureStore — `expo-secure-store` ships an empty web module — so it falls back to
 * localStorage. That is plaintext, which is acceptable for the local web target used
 * to develop and test the UI, and never reached by the Android/iOS bundle.
 */
import { Platform } from 'react-native';

import * as SecureStore from 'expo-secure-store';

import { webStorage } from '../store/webStorage';

/** Namespace so web storage cannot collide with other apps on the same origin. */
const WEB_PREFIX = 'openllm.key.';

/** Keys that survive only for the current page when localStorage is unavailable. */
const memoryKeys = new Map<string, string>();

/** SecureStore is unavailable on web and on very old Android API levels. */
async function isSupported(): Promise<boolean> {
  if (Platform.OS === 'web') {
    return false;
  }

  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

function webRead(apiKeyRef: string): string | undefined {
  const storage = webStorage();
  const value = storage?.getItem(WEB_PREFIX + apiKeyRef) ?? memoryKeys.get(apiKeyRef);

  return value !== undefined && value.length > 0 ? value : undefined;
}

function webWrite(apiKeyRef: string, apiKey: string): void {
  const storage = webStorage();

  if (apiKey.length === 0) {
    memoryKeys.delete(apiKeyRef);

    if (storage !== null) {
      storage.removeItem(WEB_PREFIX + apiKeyRef);
    }

    return;
  }

  memoryKeys.set(apiKeyRef, apiKey);

  if (storage !== null) {
    storage.setItem(WEB_PREFIX + apiKeyRef, apiKey);
  }
}

/**
 * Credentials travel inside an HTTP header, so anything a paste drags along that
 * is not a printable ASCII character makes the request never leave the device:
 * the native client rejects a header value containing a control character, and
 * fetch surfaces that as a bare "Failed to fetch".
 */
export function normalizeApiKey(apiKey: string): string {
  return apiKey.replace(/[^ -~]/g, '').trim();
}

export async function getApiKey(apiKeyRef?: string): Promise<string | undefined> {
  if (!apiKeyRef) {
    return undefined;
  }

  if (Platform.OS === 'web') {
    return webRead(apiKeyRef);
  }

  if (!(await isSupported())) {
    return undefined;
  }

  const value = await SecureStore.getItemAsync(apiKeyRef);
  return value && value.length > 0 ? value : undefined;
}

export async function setApiKey(apiKeyRef: string, rawApiKey: string): Promise<void> {
  const apiKey = normalizeApiKey(rawApiKey);

  if (Platform.OS === 'web') {
    webWrite(apiKeyRef, apiKey);

    if (apiKey.length === 0) {
      keyCache.delete(apiKeyRef);
    } else {
      keyCache.set(apiKeyRef, apiKey);
    }

    return;
  }

  if (!(await isSupported())) {
    return;
  }

  if (apiKey.length === 0) {
    await SecureStore.deleteItemAsync(apiKeyRef);
    keyCache.delete(apiKeyRef);
    return;
  }

  await SecureStore.setItemAsync(apiKeyRef, apiKey);
  keyCache.set(apiKeyRef, apiKey);
}

export async function deleteApiKey(apiKeyRef: string): Promise<void> {
  if (Platform.OS === 'web') {
    webWrite(apiKeyRef, '');
    keyCache.delete(apiKeyRef);
    return;
  }

  if (!(await isSupported())) {
    return;
  }

  await SecureStore.deleteItemAsync(apiKeyRef);
  keyCache.delete(apiKeyRef);
}

/** True when a stored key exists — used for the settings badge. */
export async function hasApiKey(apiKeyRef?: string): Promise<boolean> {
  return (await getApiKey(apiKeyRef)) !== undefined;
}

/**
 * SecureStore reads are async, but the agent is built synchronously inside the
 * chat hook, so keys are mirrored into memory at startup and refreshed after
 * each write.
 */
const keyCache = new Map<string, string>();

export async function primeKeyCache(apiKeyRefs: string[]): Promise<void> {
  for (const ref of apiKeyRefs) {
    const value = await getApiKey(ref);

    if (value === undefined) {
      keyCache.delete(ref);
    } else {
      keyCache.set(ref, value);
    }
  }
}

export function cachedApiKey(apiKeyRef?: string): string | undefined {
  return apiKeyRef === undefined ? undefined : keyCache.get(apiKeyRef);
}

/** Reads through the cache first so callers stay synchronous. */
export function keyIsStored(apiKeyRef?: string): boolean {
  return apiKeyRef !== undefined && keyCache.has(apiKeyRef);
}
