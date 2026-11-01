/**
 * Vitest stand-in for `expo/fetch` (the real module needs a native runtime).
 * Tests install their own implementation through `setFetchImplementation`.
 */
export async function fetch(_input: unknown, _init?: unknown): Promise<Response> {
  throw new Error('expo/fetch is mocked in tests; use setFetchImplementation().');
}

export default { fetch };
