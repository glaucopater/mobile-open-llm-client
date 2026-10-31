/**
 * Context-window enforcement.
 *
 * AI SDK v7 ships no message trimming, so a long conversation or a fat tool
 * result is sent verbatim and the server rejects it with "request exceeds the
 * context window". This guard runs as a `transformParams` middleware right
 * before the request leaves the device: it clips oversized tool payloads, drops
 * the oldest whole message groups, and clamps `maxOutputTokens`, so the prompt
 * always leaves room for the answer.
 */
import type { LanguageModelMiddleware } from 'ai';

/**
 * Structural view of the provider prompt. The middleware hands us a
 * `LanguageModelV4Prompt`; we only read part `type`/text/output and drop whole
 * messages, so a wider structural type is enough and keeps this file free of a
 * direct `@ai-sdk/provider` dependency.
 */
type PromptPart = {
  type: string;
  text?: string;
  input?: unknown;
  output?: unknown;
  toolCallId?: string;
};

type PromptMessage = {
  role: string;
  content: PromptPart[] | string;
};

type PromptTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

/** Used when a profile declares no context window: never overshoot the server. */
export const DEFAULT_CONTEXT_WINDOW = 16_384;

/** Output budget when the caller did not set `maxOutputTokens`. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** Smallest answer budget we will still honour; below this the request is hopeless. */
export const MIN_OUTPUT_TOKENS = 256;

/** Slack for chat templates, tool-schema overhead, and estimator error. */
export const SAFETY_MARGIN_TOKENS = 512;

/** Smallest slice of conversation we will still keep, even when it is oversized. */
export const MIN_KEEP_TOKENS = 256;

/** Below this the request is not worth sending: it cannot carry a question plus tools. */
export const MIN_INPUT_TOKENS = 1024;

/** A single tool result larger than this is clipped before it reaches the model. */
export const MAX_TOOL_RESULT_CHARS = 16_000;

/** Flat guess for one image/file part; real counts vary per provider. */
export const FILE_TOKEN_ESTIMATE = 600;

/** Marker kept in the prompt so truncation is never repeated or mistaken for user text. */
const TRUNCATION_NOTE = '[Earlier turns were truncated to fit the model context window.]';

/** Reports what the guard changed, so the UI can show a "context trimmed" chip. */
export interface TrimReport {
  /** Estimated prompt tokens before trimming. */
  beforeTokens: number;
  /** Estimated prompt tokens after trimming. */
  afterTokens: number;
  /** Messages dropped from the front of the conversation. */
  droppedMessages: number;
  /** Tool payloads clipped to `MAX_TOOL_RESULT_CHARS`. */
  clippedToolResults: number;
  /** `maxOutputTokens` sent to the provider. */
  maxOutputTokens: number;
  contextWindow: number;
}

export class ContextOverflowError extends Error {
  /**
   * `promptBudget` is what the window leaves for the prompt once the answer and
   * safety margin are reserved — usually the binding limit, not the raw window.
   */
  constructor(contextWindow: number, promptTokens: number, promptBudget: number) {
    super(
      `Context window too small: the smallest possible request needs ${promptTokens} tokens, ` +
        `but a ${contextWindow} token window only leaves ${promptBudget} for the prompt ` +
        `(the answer and safety margin take the rest). Raise the context window in ` +
        `Settings or shorten the instructions.`,
    );
    this.name = 'ContextOverflowError';
  }
}

/**
 * Deliberately pessimistic token estimate (~4 chars/token, floored by word
 * count). Overestimating keeps us under the real limit; the server rejects on
 * its own count, we never get a second chance.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  const words = text.split(/\s+/).filter(Boolean).length;

  return Math.max(Math.ceil(text.length / 4), Math.ceil(words * 1.35));
}

function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function partTokens(part: PromptPart): number {
  switch (part.type) {
    case 'text':
      return estimateTokens(part.text ?? '');
    case 'tool-call':
      return estimateTokens(stringify(part.input)) + estimateTokens(part.toolCallId ?? '');
    case 'tool-result': {
      const output = part.output as { type?: string; value?: unknown; reason?: string } | undefined;
      const body = output?.type === 'text' ? stringify(output.value) : stringify(output);

      return estimateTokens(body) + estimateTokens(part.toolCallId ?? '');
    }
    case 'file':
    case 'reasoning-file':
      return FILE_TOKEN_ESTIMATE;
    default:
      // Reasoning, sources, custom parts: cheap, and the provider may drop them anyway.
      return estimateTokens(stringify(part));
  }
}

function messageTokens(message: PromptMessage): number {
  if (typeof message.content === 'string') {
    return estimateTokens(message.content) + 4;
  }

  return message.content.reduce((total, part) => total + partTokens(part), 0) + 4;
}

function estimateGroupTokens(group: PromptMessage[]): number {
  return group.reduce((total, message) => total + messageTokens(message), 0);
}

/** Tool schemas are part of every request, so they count against the budget. */
export function estimateToolTokens(tools: PromptTool[] | undefined): number {
  if (tools === undefined || tools.length === 0) {
    return 0;
  }

  return tools.reduce(
    (total, tool) =>
      total +
      estimateTokens(tool.name) +
      estimateTokens(tool.description ?? '') +
      estimateTokens(stringify(tool.inputSchema)),
    0,
  );
}

export function estimatePromptTokens(prompt: PromptMessage[], tools?: PromptTool[]): number {
  return (
    prompt.reduce((total, message) => total + messageTokens(message), 0) + estimateToolTokens(tools)
  );
}

/**
 * Clips text in the middle so the model still sees the beginning and the end of
 * a large payload, which is where most useful signal lives.
 */
export function elideText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const head = Math.floor(maxChars * 0.6);
  const tail = Math.floor(maxChars * 0.3);
  const omitted = text.length - head - tail;

  return `${text.slice(0, head)}\n…[${omitted} characters truncated]…\n${text.slice(-tail)}`;
}

function toolCallIds(message: PromptMessage): Set<string> {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) {
    return new Set();
  }

  return new Set(
    message.content
      .filter((part) => part.type === 'tool-call' && part.toolCallId !== undefined)
      .map((part) => part.toolCallId as string),
  );
}

/**
 * Groups messages so a tool call is never separated from its result: providers
 * reject orphan `tool` messages and dangling tool calls, and the app cannot
 * recover from a half-cut step.
 */
export function groupMessages(messages: PromptMessage[]): PromptMessage[][] {
  const groups: PromptMessage[][] = [];
  let current: PromptMessage[] = [];
  let pendingCallIds: Set<string> = new Set();

  for (const message of messages) {
    const isToolResult =
      message.role === 'tool' &&
      Array.isArray(message.content) &&
      message.content.every(
        (part) => part.toolCallId === undefined || pendingCallIds.has(part.toolCallId),
      );

    // A model can emit several tool calls in a row, and their results arrive
    // after all of them, so consecutive assistant turns form one group.
    const isAssistantContinuation =
      current.length > 0 && current[current.length - 1].role === 'assistant' && message.role === 'assistant';

    if (current.length > 0 && (isToolResult || isAssistantContinuation)) {
      current.push(message);

      if (message.role === 'assistant') {
        for (const callId of toolCallIds(message)) {
          pendingCallIds.add(callId);
        }
      } else {
        for (const part of message.content as PromptPart[]) {
          if (part.toolCallId !== undefined) {
            pendingCallIds.delete(part.toolCallId);
          }
        }
      }
    } else {
      current = [message];
      groups.push(current);
      pendingCallIds = toolCallIds(message);
    }
  }

  return groups;
}

function clipToolOutput(output: unknown, maxChars: number): unknown {
  const result = output as { type?: string; value?: unknown } | undefined;

  if (result?.type === 'text' && typeof result.value === 'string') {
    return { ...result, value: elideText(result.value, maxChars) };
  }

  const serialized = stringify(output);

  return serialized.length > maxChars
    ? { type: 'text', value: elideText(serialized, maxChars) }
    : output;
}

/** Reduces every text-ish part proportionally until the group fits its budget. */
function shrinkToFit(group: PromptMessage[], budgetTokens: number): PromptMessage[] {
  let tokens = estimateGroupTokens(group);

  if (tokens <= budgetTokens) {
    return group;
  }

  const shrinkable = group.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter(
          (part) =>
            part.type === 'text' || part.type === 'tool-result' || part.type === 'tool-call',
        )
      : [],
  );

  if (shrinkable.length === 0) {
    return group;
  }

  // Text is the only thing we can compress, so the char allowance is the budget
  // minus the tokens that cannot be shrunk (role wrappers, ids, file parts).
  const fixedTokens = tokens - estimateTokens(stringify(shrinkable));
  let maxChars = Math.max(200, Math.floor((budgetTokens - fixedTokens) * 4));

  while (estimateGroupTokens(group) > budgetTokens && maxChars > 200) {
    for (const part of shrinkable) {
      if (part.type === 'text' && part.text !== undefined) {
        part.text = elideText(part.text, maxChars);
      } else if (part.type === 'tool-result') {
        part.output = clipToolOutput(part.output, maxChars * 4);
      } else if (part.input !== undefined) {
        part.input = { truncated: elideText(stringify(part.input), maxChars * 4) };
      }
    }

    maxChars = Math.floor(maxChars / 2);
  }

  return group;
}

export interface TrimOptions {
  /** Tokens the prompt may use; the answer budget is reserved elsewhere. */
  inputBudget: number;
  /** Full window, used only for the error message. */
  contextWindow: number;
  tools?: PromptTool[];
  maxToolResultChars?: number;
}

export interface TrimResult {
  prompt: PromptMessage[];
  report: TrimReport;
}

/**
 * Applies the hard per-tool-result cap, then drops the oldest message groups
 * until the prompt fits `inputBudget`. System messages and the newest group are
 * always kept; a truncation note is appended once so the model knows history is
 * missing.
 */
export function trimPromptToBudget(prompt: PromptMessage[], options: TrimOptions): TrimResult {
  const { inputBudget, contextWindow, tools, maxToolResultChars = MAX_TOOL_RESULT_CHARS } = options;

  const beforeTokens = estimatePromptTokens(prompt, tools);

  // Copy deeply enough that trimming cannot mutate the caller's parts.
  const cloned: PromptMessage[] = prompt.map((message) => ({
    ...message,
    content:
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => ({ ...part })),
  }));

  const system = cloned.filter((message) => message.role === 'system');
  const turns = cloned.filter((message) => message.role !== 'system');

  let clippedToolResults = 0;
  for (const message of turns) {
    if (!Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (part.type !== 'tool-result') {
        continue;
      }

      const before = stringify(part.output).length;
      part.output = clipToolOutput(part.output, maxToolResultChars);

      if (stringify(part.output).length < before) {
        clippedToolResults += 1;
      }
    }
  }

  const systemTokens =
    system.reduce((total, message) => total + messageTokens(message), 0) + estimateToolTokens(tools);

  // Walk backwards so the newest turns survive; the newest group is kept even
  // when it does not fit, because dropping it would leave nothing to answer.
  const groups = groupMessages(turns);
  const kept: PromptMessage[] = [];
  // Reserve room for the note up front, otherwise adding it at the end can push
  // the request back over the budget.
  const noteTokens = groups.length > 1 ? estimateTokens(TRUNCATION_NOTE) : 0;
  let used = systemTokens + noteTokens;

  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const budget = Math.max(MIN_KEEP_TOKENS, inputBudget - used);
    const group = groups[i];

    if (kept.length > 0 && estimateGroupTokens(group) > budget) {
      break;
    }

    const shrunk = shrinkToFit(group, budget);
    kept.unshift(...shrunk);
    used += estimateGroupTokens(shrunk);
  }

  const droppedMessages = turns.length - kept.length;

  if (droppedMessages > 0) {
    if (system.length === 0) {
      system.push({ role: 'system', content: TRUNCATION_NOTE });
    } else {
      const first = system[0];

      if (typeof first.content === 'string' && !first.content.includes(TRUNCATION_NOTE)) {
        first.content = `${first.content}\n\n${TRUNCATION_NOTE}`;
      }
    }
  }

  const trimmed = [...system, ...kept];
  const afterTokens = estimatePromptTokens(trimmed, tools);

  if (afterTokens > inputBudget) {
    throw new ContextOverflowError(contextWindow, afterTokens, inputBudget);
  }

  return {
    prompt: trimmed,
    report: {
      beforeTokens,
      afterTokens,
      droppedMessages,
      clippedToolResults,
      maxOutputTokens: 0,
      contextWindow,
    },
  };
}

export interface ContextBudget {
  contextWindow: number;
  /** Tokens reserved for the answer. */
  maxOutputTokens: number;
  /** Tokens the prompt may use. */
  inputBudget: number;
}

/**
 * Splits a context window into prompt and answer budgets. Exported so Settings
 * can show what the guard will actually send.
 */
export function budgetFor(
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
  maxOutputTokens: number = DEFAULT_MAX_OUTPUT_TOKENS,
): ContextBudget {
  const window = Math.max(MIN_OUTPUT_TOKENS * 2, contextWindow);
  // The answer has to fit too, so the output budget is reserved up front — but
  // never so much that the prompt is left with nothing to carry.
  const reserve = Math.min(
    maxOutputTokens,
    Math.max(MIN_OUTPUT_TOKENS, window - MIN_INPUT_TOKENS - SAFETY_MARGIN_TOKENS),
  );

  return {
    contextWindow: window,
    maxOutputTokens: reserve,
    inputBudget: Math.max(MIN_KEEP_TOKENS, window - reserve - SAFETY_MARGIN_TOKENS),
  };
}

export interface ContextGuardOptions {
  contextWindow?: number;
  maxOutputTokens?: number;
  maxToolResultChars?: number;
  onTrim?: (report: TrimReport) => void;
}

/**
 * Middleware that bounds every request to the model's context window. Attach it
 * with `wrapLanguageModel` so it covers generate and stream alike.
 */
export function contextWindowGuard(options: ContextGuardOptions = {}): LanguageModelMiddleware {
  const { inputBudget, contextWindow } = budgetFor(
    options.contextWindow,
    options.maxOutputTokens,
  );
  const requestedMaxOutput = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const maxToolResultChars = options.maxToolResultChars ?? MAX_TOOL_RESULT_CHARS;

  return {
    transformParams: async ({ params }) => {
      const trimmed = trimPromptToBudget(params.prompt as unknown as PromptMessage[], {
        inputBudget,
        contextWindow,
        tools: params.tools as unknown as PromptTool[] | undefined,
        maxToolResultChars,
      });

      const maxOutputTokens = Math.max(
        MIN_OUTPUT_TOKENS,
        Math.min(
          requestedMaxOutput,
          contextWindow - trimmed.report.afterTokens - SAFETY_MARGIN_TOKENS,
        ),
      );

      if (trimmed.report.afterTokens + maxOutputTokens > contextWindow) {
        throw new ContextOverflowError(
          contextWindow,
          trimmed.report.afterTokens + maxOutputTokens,
          contextWindow - maxOutputTokens - SAFETY_MARGIN_TOKENS,
        );
      }

      trimmed.report.maxOutputTokens = maxOutputTokens;
      options.onTrim?.(trimmed.report);

      return {
        ...params,
        prompt: trimmed.prompt as unknown as typeof params.prompt,
        maxOutputTokens,
      };
    },
  };
}
