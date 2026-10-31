/**
 * Network seam.
 *
 * `expo/fetch` is the production implementation: unlike React Native's bundled
 * fetch it streams response bodies, which the AI SDK needs. Keeping it behind a
 * getter lets tests drive the adapters without native modules.
 */
import { fetch as expoFetch } from 'expo/fetch';

/**
 * expo/fetch accepts (url, options) with its own request shape and returns a
 * Winter-compatible Response with a streaming body. The AI SDK only ever calls
 * fetch with (string, init), so the cast holds.
 */
let fetchImplementation = expoFetch as unknown as typeof globalThis.fetch;

export function getFetchImplementation(): typeof globalThis.fetch {
  return fetchImplementation;
}

export function setFetchImplementation(fetchImpl: typeof globalThis.fetch): void {
  fetchImplementation = fetchImpl;
}
