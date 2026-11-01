/**
 * Browser storage used by the web build's persistence shims.
 *
 * `expo-sqlite` and `expo-secure-store` cannot run in the web bundle, so config and
 * credentials fall back here. Returns null when storage is unavailable — off web, or
 * on web with storage blocked (Safari private mode throws on write, so the write is
 * probed rather than assumed). Callers then keep values in memory for the page.
 */
import { Platform } from 'react-native';

const PROBE_KEY = 'openllm.storage-probe';

export function webStorage(): Storage | null {
  if (Platform.OS !== 'web') {
    return null;
  }

  const storage = (globalThis as unknown as { localStorage?: Storage }).localStorage;

  if (storage === undefined) {
    return null;
  }

  try {
    storage.setItem(PROBE_KEY, '1');
    storage.removeItem(PROBE_KEY);

    return storage;
  } catch {
    return null;
  }
}
