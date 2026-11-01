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

const MAX_TOOL_OUTPUT_CHARS = 8_000;

function clamp(value: string): string {
  return value.length > MAX_TOOL_OUTPUT_CHARS ? value.slice(0, MAX_TOOL_OUTPUT_CHARS) : value;
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

/** Tools enabled by default on the chat screen. */
export function createDefaultTools(): ToolSet {
  return {
    get_device_info: getDeviceInfoTool,
    read_file: readFileTool,
    write_file: writeFileTool,
  };
}
