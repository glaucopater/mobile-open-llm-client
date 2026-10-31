/**
 * Credentials live in SecureStore; nothing secret is written to SQLite.
 *
 * The value stored is the key itself, keyed by the descriptor's `apiKeyRef`
 * (e.g. `openai-api-key`), so several providers can share one credential.
 */
import * as SecureStore from 'expo-secure-store';

/** SecureStore is unavailable on web and on very old Android API levels. */
async function isSupported(): Promise<boolean> {
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

export async function getApiKey(apiKeyRef?: string): Promise<string | undefined> {
  if (!apiKeyRef || !(await isSupported())) {
    return undefined;
  }

  const value = await SecureStore.getItemAsync(apiKeyRef);
  return value && value.length > 0 ? value : undefined;
}

export async function setApiKey(apiKeyRef: string, apiKey: string): Promise<void> {
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
