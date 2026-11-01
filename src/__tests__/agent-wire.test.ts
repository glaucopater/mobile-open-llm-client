import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tool } from 'ai';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { z } from 'zod';

import { createAgent } from '../core/agent';
import { MAX_TOOL_RESULT_CHARS, type TrimReport } from '../core/context';
import { DEFAULT_CAPABILITIES, type ModelDescriptor } from '../core/model';

/**
 * End-to-end pass through the real agent loop. `createAgent` wires the context
 * guard with `wrapLanguageModel`, so the prompt that reaches the model is the
 * one the guard rewrote. Everything above the provider is real; only the
 * provider is swapped for a scripted model, which is what makes it possible to
 * read the request the guard produced.
 *
 * This is the only place the fat-tool-result path can be checked without a
 * device: the shipped tools clamp their own output to 8 000 chars
 * (`MAX_TOOL_OUTPUT_CHARS` in src/core/tools.ts), below the guard's
 * `MAX_TOOL_RESULT_CHARS`, so no tool in the default set can trigger clipping
 * today. A tool that returns more (an HTTP body, a sqlite dump) would, and the
 * trim chip in the chat screen reads the report this test asserts.
 */
const mockToolContents = 'x'.repeat(MAX_TOOL_RESULT_CHARS * 4);

type PromptMessage = {
  role: string;
  content: Record<string, unknown>[] | string;
};

/**
 * Every request the guard handed the model, in order. Built by `vi.hoisted`
 * because the provider stub below is hoisted above the imports and reads it.
 */
const mockRequests = vi.hoisted(() => [] as PromptMessage[][]);

/** LanguageModelV4 reports token counts as nested objects, not flat numbers. */
function usage(inputTotal: number, outputTotal: number) {
  return {
    inputTokens: { total: inputTotal, noCache: inputTotal, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTotal, text: outputTotal, reasoning: 0 },
  };
}

/** `finishReason` is an object in V4; the loop only continues on `unified`. */
const TOOL_FINISH = { unified: 'tool-calls' as const };
const STOP_FINISH = { unified: 'stop' as const };

/** Step 1 asks for a tool, step 2 answers; each call records its prompt. */
function mockDoStream(options: { prompt: PromptMessage[] }) {
  mockRequests.push(options.prompt);

  const parts = mockRequests.length === 1 ? TOOL_STEP : ANSWER_STEP;

  return { stream: convertArrayToReadableStream(parts as never) };
}

/** `ToolLoopAgent` can take either path, so both script the same two steps. */
function mockDoGenerate(options: { prompt: PromptMessage[] }) {
  mockRequests.push(options.prompt);

  return mockRequests.length === 1
    ? {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'read_file',
            input: JSON.stringify({ path: 'a.txt' }),
          },
        ],
        finishReason: TOOL_FINISH,
        usage: usage(20, 10),
      }
    : {
        content: [{ type: 'text', text: 'Read it.' }],
        finishReason: STOP_FINISH,
        usage: usage(40, 5),
      };
}

const TOOL_STEP: unknown[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-input-start', id: 'call-1', toolName: 'read_file' },
  { type: 'tool-input-delta', id: 'call-1', delta: '{"path":"a.txt"}' },
  { type: 'tool-input-end', id: 'call-1' },
  {
    type: 'tool-call',
    toolCallId: 'call-1',
    toolName: 'read_file',
    // LanguageModelV4 carries the tool input as JSON text, not an object.
    input: JSON.stringify({ path: 'a.txt' }),
  },
  { type: 'finish', finishReason: TOOL_FINISH, usage: usage(20, 10) },
];

const ANSWER_STEP: unknown[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 'text-1' },
  { type: 'text-delta', id: 'text-1', delta: 'Read it.' },
  { type: 'text-end', id: 'text-1' },
  { type: 'finish', finishReason: STOP_FINISH, usage: usage(40, 5) },
];

vi.mock('../core/provider', () => ({
  // The scripted model is structurally typed; the cast keeps the test readable.
  createLanguageModel: () =>
    new MockLanguageModelV4({ doStream: mockDoStream as never, doGenerate: mockDoGenerate as never }),
}));

vi.mock('expo-secure-store', () => ({
  isAvailableAsync: async () => true,
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));

function localDescriptor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'local:qwen3.5:9b',
    label: 'Ollama on LAN',
    providerLabel: 'Ollama on LAN',
    modelLabel: 'Qwen3.5 9B',
    dialect: 'openai-compatible',
    modelId: 'qwen3.5:9b',
    baseUrl: 'http://192.168.178.87:11434/v1',
    source: 'local-server',
    capabilities: DEFAULT_CAPABILITIES,
    contextWindow: 32_768,
    ...overrides,
  };
}

/** Deliberately returns far more than the guard's cap. */
const fatReadFileTool = tool({
  description: 'Reads a large file',
  inputSchema: z.object({ path: z.string() }),
  execute: async () => ({ path: 'a.txt', contents: mockToolContents }),
});

function parts(message: PromptMessage): Record<string, unknown>[] {
  // System messages carry a plain string; only turn messages have parts.
  return Array.isArray(message.content) ? message.content : [];
}

function toolResults(prompt: PromptMessage[]): Record<string, unknown>[] {
  return prompt
    .filter((message) => message.role === 'tool')
    .flatMap((message) => parts(message).filter((part) => part.type === 'tool-result'));
}

function toolCalls(prompt: PromptMessage[]): string[] {
  return prompt
    .filter((message) => message.role === 'assistant')
    .flatMap((message) =>
      parts(message)
        .filter((part) => part.type === 'tool-call')
        .map((part) => String(part.toolCallId)),
    );
}

function sentToolResult(step: number): { type: string; value: string } {
  const results = toolResults(mockRequests[step]);

  expect(results).toHaveLength(1);

  return results[0].output as { type: string; value: string };
}

beforeEach(() => {
  mockRequests.length = 0;
});

describe('the agent that goes on the wire', () => {
  it('streams a two-step tool round trip', async () => {
    const agent = createAgent(localDescriptor(), {
      tools: { read_file: fatReadFileTool },
      maxSteps: 2,
    });

    const result = await agent.generate({ prompt: 'Read a.txt and summarise it.' });

    expect(result.text).toBe('Read it.');
    expect(mockRequests).toHaveLength(2);
  });

  it('clips a fat tool result before the step that follows it', async () => {
    const trims: TrimReport[] = [];
    const agent = createAgent(localDescriptor(), {
      tools: { read_file: fatReadFileTool },
      maxSteps: 2,
      onTrim: (report) => trims.push(report),
    });

    await agent.generate({ prompt: 'Read a.txt and summarise it.' });

    const sent = sentToolResult(1);
    // A JSON tool result is serialised, then elided, so the cap bounds the
    // text and the head/tail of the payload survive.
    expect(sent.type).toBe('text');
    expect(sent.value.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(sent.value).toContain('characters truncated');
    expect(sent.value).toContain('"path":"a.txt"');

    // The chip in the chat screen reads this report.
    expect(trims.some((report) => report.clippedToolResults === 1)).toBe(true);
  });

  it('never splits a tool call from its result across the trim', async () => {
    const agent = createAgent(localDescriptor(), {
      tools: { read_file: fatReadFileTool },
      maxSteps: 2,
    });

    await agent.generate({ prompt: 'Read a.txt and summarise it.' });

    expect(toolResults(mockRequests[1]).map((part) => String(part.toolCallId))).toEqual(
      toolCalls(mockRequests[1]),
    );
  });

  it('fits the request inside the window the profile declares', async () => {
    const agent = createAgent(localDescriptor({ contextWindow: 2_048 }), {
      tools: { read_file: fatReadFileTool },
      maxSteps: 2,
    });

    await agent.generate({ prompt: 'Read a.txt and summarise it.' });

    const sent = sentToolResult(1);
    expect(sent.value.length).toBeLessThan(mockToolContents.length);
    expect(sent.value.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });
});
