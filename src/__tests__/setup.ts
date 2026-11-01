/**
 * Runtime flags Metro injects. Hermes and the dev bundle both define `__DEV__`
 * before any module body runs, and `expo`'s async-require setup reads it at
 * import time, so node needs it set before a suite imports anything that touches
 * an Expo module (e.g. `core/tools.ts` → `expo-device`).
 */
(globalThis as { __DEV__?: boolean }).__DEV__ = false;
