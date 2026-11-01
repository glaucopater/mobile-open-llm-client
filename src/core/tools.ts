/**
 * Tool set the agent can execute on the device.
 *
 * Every tool runs in-process: the model emits a tool call, `ToolLoopAgent`
 * executes it here, and the result is fed back on the next step. Results are
 * capped defensively — the context guard clips them anyway, but a tool should
 * never hand the model an unbounded payload.
 */
import * as Device from 'expo-device';
import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import { elideText } from './context';
import { encodeBase64, MAX_IMAGE_BYTES } from './image';
import { getFetchImplementation } from './http';
import { describeTransportFailure, isTransportFailure } from './network-error';

const MAX_TOOL_OUTPUT_CHARS = 8_000;

/** Bytes read from a URL before decoding: a page can be megabytes. */
const MAX_FETCH_BYTES = 400_000;

function clamp(value: string): string {
  return value.length > MAX_TOOL_OUTPUT_CHARS ? value.slice(0, MAX_TOOL_OUTPUT_CHARS) : value;
}

/** UTF-8 for fetched bytes; Hermes has no `TextDecoder`, so String.fromCharCode is used. */
function decodeText(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8').decode(bytes);
  }

  // Only ASCII is decoded this way, which is enough for HTML and JSON bodies.
  let out = '';

  for (const byte of bytes) {
    out += String.fromCharCode(byte);
  }

  return out;
}

/**
 * A fetch that produced no status is either a dropped connection or, on the web
 * build, a cross-origin request the browser blocked — which never sends the key.
 */
function describeFetchFailure(error: unknown, url: string): string {
  const message = error instanceof Error ? error.message : String(error);

  return isTransportFailure(message)
    ? describeTransportFailure(message, url)
    : message;
}

/**
 * Resolves a relative path inside the documents directory. `..` is rejected so
 * a model cannot walk outside the app sandbox.
 */
function resolveDocumentFile(path: string): File {
  if (Platform.OS === 'web') {
    // expo-file-system has no web implementation, so the file tools would fail
    // with an opaque constructor warning.
    throw new Error('File tools are not available in the web build.');
  }

  const clean = path.replace(/^[/\\]+/, '');

  if (clean.includes('..')) {
    throw new Error('Path must stay inside the documents directory.');
  }

  return new File(Paths.document, clean);
}

export const getDeviceInfoTool = tool({
  description: 'Reads the device this app is running on: brand, model, OS, memory, real-device flag.',
  inputSchema: z.object({}),
  execute: async () => {
    // The web build reads memory from `navigator.deviceMemory` and has no
    // `getMaxMemoryAsync`, so the async probe only runs when the sync value is absent.
    let maxMemory: number | null = Device.totalMemory ?? null;

    if (maxMemory === null) {
      try {
        maxMemory = await Device.getMaxMemoryAsync();
      } catch {
        maxMemory = null;
      }
    }

    return {
      isDevice: Device.isDevice,
      brand: Device.brand ?? 'unknown',
      manufacturer: Device.manufacturer ?? 'unknown',
      designName: Device.designName ?? 'unknown',
      productName: Device.productName ?? 'unknown',
      deviceType: Device.deviceType ?? 'unknown',
      // Web reports '' rather than null for OS fields.
      osName: Device.osName || 'unknown',
      osVersion: Device.osVersion || 'unknown',
      platformApiLevel: Device.platformApiLevel,
      memoryMb: maxMemory === null ? null : Math.round(maxMemory / 1024 / 1024),
    };
  },
});

export const readFileTool = tool({
  description: 'Reads a UTF-8 text file from the app documents directory.',
  inputSchema: z.object({
    path: z.string().describe('Relative path inside the app documents directory'),
  }),
  execute: async ({ path }) => {
    try {
      const file = resolveDocumentFile(path);

      if (!file.exists) {
        return { error: `No such file: ${path}` };
      }

      return { path, contents: clamp(await file.text()) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
});

export const writeFileTool = tool({
  description: 'Writes a UTF-8 text file into the app documents directory.',
  inputSchema: z.object({
    path: z.string().describe('Relative path inside the app documents directory'),
    contents: z.string(),
  }),
  execute: async ({ path, contents }) => {
    try {
      const file = resolveDocumentFile(path);
      await file.write(contents);

      return { path, bytes: contents.length };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
});

/**
 * Reads a URL with the app's own network stack (`core/http.ts`), so the tool and
 * chat go through the same fetch and tests can swap it.
 *
 * The body is capped while it is read, not after: an HTML page can be megabytes,
 * and the whole string would sit in memory before the guard ever saw it.
 */
async function fetchBody(
  url: string,
  accept: string,
  maxBytes: number,
): Promise<{ status: number; contentType: string; bytes: Uint8Array; truncated: boolean }> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Only http:// and https:// URLs can be fetched.');
  }

  const fetch = getFetchImplementation();
  const response = await fetch(url, { method: 'GET', headers: { Accept: accept } });
  const contentType = response.headers.get('content-type') ?? '';

  if (!response.ok) {
    return { status: response.status, contentType, bytes: new Uint8Array(), truncated: false };
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  return {
    status: response.status,
    contentType,
    bytes: bytes.subarray(0, maxBytes),
    truncated: bytes.length > maxBytes,
  };
}

export const fetchUrlTool = tool({
  description:
    'Fetches a http(s) URL and returns its text. Returns the status and content type; long bodies are clipped.',
  inputSchema: z.object({
    url: z.string().describe('Absolute http:// or https:// URL'),
  }),
  execute: async ({ url }) => {
    try {
      const { status, contentType, bytes, truncated } = await fetchBody(
        url,
        'text/plain, text/html, application/json;q=0.9, */*;q=0.5',
        MAX_FETCH_BYTES,
      );
      const text = decodeText(bytes);

      if (status >= 400) {
        return { url, status, contentType, error: `The server answered HTTP ${status}.` };
      }

      return {
        url,
        status,
        contentType,
        text: clamp(elideText(text, MAX_TOOL_OUTPUT_CHARS)),
        truncated,
      };
    } catch (error) {
      return { url, error: describeFetchFailure(error, url) };
    }
  },
});

export const fetchImageTool = tool({
  description:
    'Fetches an image URL and returns it as a picture the assistant can see. Only available on vision models.',
  inputSchema: z.object({
    url: z.string().describe('Absolute http:// or https:// URL of an image'),
  }),
  execute: async ({ url }) => {
    try {
      const { status, contentType, bytes, truncated } = await fetchBody(
        url,
        'image/*, */*;q=0.5',
        MAX_IMAGE_BYTES,
      );

      if (status >= 400) {
        return { url, status, error: `The server answered HTTP ${status}.` };
      }

      // The declared type is a hint; a server can label a JPEG as octet-stream.
      const mediaType = contentType.startsWith('image/') ? contentType.split(';')[0] : 'image/jpeg';

      if (bytes.length === 0) {
        return { url, error: 'The URL returned no image data.' };
      }

      return {
        type: 'content',
        value: [
          {
            type: 'text',
            text: `Fetched ${url} (${Math.round(bytes.length / 1024)} KB, ${mediaType})${truncated ? ', truncated' : ''}.`,
          },
          { type: 'media', data: encodeBase64(bytes), mediaType },
        ],
      };
    } catch (error) {
      return { url, error: describeFetchFailure(error, url) };
    }
  },
});

/**
 * Tools enabled on the chat screen. `fetch_image` is only offered when the model
 * declares vision: a text-only endpoint rejects the media part, and an unusable
 * schema costs tokens on every request.
 */
export function createDefaultTools(options: { supportsImages?: boolean } = {}): ToolSet {
  const tools: ToolSet = {
    get_device_info: getDeviceInfoTool,
    read_file: readFileTool,
    write_file: writeFileTool,
    fetch_url: fetchUrlTool,
  };

  if (options.supportsImages === true) {
    tools.fetch_image = fetchImageTool;
  }

  return tools;
}
