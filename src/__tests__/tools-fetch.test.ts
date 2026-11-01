/**
 * The network tools the agent can call.
 *
 * These run through `core/http.ts`, so a fake fetch is installed with
 * `setFetchImplementation` — the same seam chat uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getFetchImplementation, setFetchImplementation } from '../core/http';
import { createDefaultTools, fetchImageTool, fetchUrlTool } from '../core/tools';

type Runner = (input: { url: string }) => Promise<Record<string, unknown>>;

function run(tool: { execute?: unknown }, input: { url: string }): Promise<Record<string, unknown>> {
  return (tool.execute as Runner)(input);
}

const originalFetch = getFetchImplementation();

/** A fetch that answers with a status, a content type and a body. */
function respond(status: number, contentType: string, body: string) {
  setFetchImplementation(async () => {
    return new Response(body, { status, headers: { 'content-type': contentType } });
  });
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  setFetchImplementation(originalFetch);
  vi.restoreAllMocks();
});

describe('fetch_url', () => {
  it('returns the status, the type and the text of a page', async () => {
    respond(200, 'text/html; charset=utf-8', '<html>hello world</html>');

    const result = await run(fetchUrlTool, { url: 'https://example.test/page' });

    expect(result.status).toBe(200);
    expect(result.contentType).toBe('text/html; charset=utf-8');
    expect(result.text).toContain('hello world');
    expect(result.error).toBeUndefined();
  });

  it('names an HTTP failure instead of returning an empty body', async () => {
    respond(404, 'text/plain', 'not found');

    const result = await run(fetchUrlTool, { url: 'https://example.test/missing' });

    expect(result.status).toBe(404);
    expect(result.error).toBe('The server answered HTTP 404.');
  });

  it('refuses a URL that is not http(s) rather than fetching it', async () => {
    respond(200, 'text/plain', 'ok');

    const result = await run(fetchUrlTool, { url: 'file:///etc/passwd' });

    expect(result.error).toContain('Only http:// and https:// URLs');
  });

  it('says what failed when the request never produced a status', async () => {
    setFetchImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });

    const result = await run(fetchUrlTool, { url: 'https://example.test/slow' });

    expect(result.error).toContain('network error');
    expect(result.error).toContain('https://example.test');
  });

  it('clips a body larger than the tool cap', async () => {
    respond(200, 'text/plain', 'x'.repeat(120_000));

    const result = await run(fetchUrlTool, { url: 'https://example.test/big' });

    expect(String(result.text)).toContain('characters truncated');
  });
});

describe('fetch_image', () => {
  it('answers with a media part the model can see', async () => {
    respond(200, 'image/png', 'fakepngbytes');

    const result = await run(fetchImageTool, { url: 'https://example.test/cat.png' });

    expect(result.type).toBe('content');
    const parts = result.value as { type: string; mediaType?: string; data?: string }[];
    expect(parts[0].type).toBe('text');
    expect(parts[1]).toMatchObject({ type: 'media', mediaType: 'image/png' });
    // 'fakepngbytes' is 12 bytes, which base64 encodes to 16 characters.
    expect(parts[1].data).toHaveLength(16);
  });

  it('labels bytes the server did not declare as a JPEG', async () => {
    respond(200, 'application/octet-stream', 'jpegdata');

    const result = await run(fetchImageTool, { url: 'https://example.test/photo' });
    const parts = result.value as { mediaType?: string }[];

    expect(parts[1].mediaType).toBe('image/jpeg');
  });

  it('reports a status instead of an empty picture', async () => {
    respond(500, 'text/plain', 'boom');

    const result = await run(fetchImageTool, { url: 'https://example.test/broken.png' });

    expect(result.status).toBe(500);
    expect(result.error).toBe('The server answered HTTP 500.');
  });
});

describe('createDefaultTools', () => {
  it('offers fetch_image only to a model that declares vision', () => {
    const textOnly = createDefaultTools({ supportsImages: false });
    const vision = createDefaultTools({ supportsImages: true });

    expect(Object.keys(textOnly)).toEqual([
      'get_device_info',
      'read_file',
      'write_file',
      'fetch_url',
    ]);
    expect(vision.fetch_image).toBeDefined();
  });
});
