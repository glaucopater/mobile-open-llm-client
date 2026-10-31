/**
 * Agent construction.
 *
 * `ToolLoopAgent` runs the multi-step loop in-process: the model emits tool
 * calls, the app executes them on the device, results are fed back, and the
 * loop stops at `stopWhen`. `DirectChatTransport` wires that agent into
 * `useChat`, so there is no HTTP API route in this app.
 */
import { isStepCount, ToolLoopAgent, wrapLanguageModel, type ToolSet } from 'ai';

import { cachedApiKey } from './keys';
import { contextWindowGuard, elideText, ContextOverflowError, type TrimReport } from './context';
import { describeModel, endpointPreview, type ModelDescriptor } from './model';
import { createLanguageModel } from './provider';

export const MAX_STEPS = 8;

/** A probe must fail fast: an unreachable endpoint should not hang Settings. */
export const TEST_TIMEOUT_MS = 20_000;

export const SYSTEM_PROMPT = [
  'You are the assistant inside a mobile app that can act on the device.',
  'Prefer short answers. Use a tool when the request needs device data or an action.',
  'Never invent file contents, network results, or device state; read them with a tool.',
].join('\n');

export interface AgentOptions {
  tools?: ToolSet;
  instructions?: string;
  maxSteps?: number;
  /**
   * Credential to use instead of the cache. Used by the Settings connectivity
   * probe so a freshly typed key can be verified before it is stored.
   */
  apiKey?: string;
  /** Called whenever the context guard rewrites a request, e.g. for a UI chip. */
  onTrim?: (report: TrimReport) => void;
}

/**
 * Built synchronously: credentials come from the key cache primed at startup,
 * because `useChat` constructs its transport during render.
 */
export function createAgent(
  model: ModelDescriptor,
  options: AgentOptions = {},
): ToolLoopAgent {
  const apiKey = options.apiKey ?? cachedApiKey(model.apiKeyRef);

  if (model.apiKeyRef !== undefined && apiKey === undefined && model.source === 'remote') {
    throw new Error(`${describeModel(model)} needs an API key. Add it in Settings.`);
  }

  const languageModel = wrapLanguageModel({
    model: createLanguageModel(model, apiKey),
    middleware: contextWindowGuard({
      contextWindow: model.contextWindow,
      onTrim: options.onTrim,
    }),
  });

  return new ToolLoopAgent({
    model: languageModel,
    instructions: options.instructions ?? SYSTEM_PROMPT,
    tools: options.tools ?? {},
    stopWhen: isStepCount(options.maxSteps ?? MAX_STEPS),
    maxRetries: 1,
  });
}

export interface ConnectionTest {
  ok: boolean;
  latencyMs: number;
  /** Trimmed model reply, e.g. `OK`. */
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Short, display-ready failure reason. */
  error?: string;
}

/** Turns any failure into one line a settings screen can show. */
export function describeError(error: unknown): string {
  if (error instanceof ContextOverflowError) {
    return error.message;
  }

  // APICallError carries the HTTP status; duck-typed so this stays import-cheap.
  const apiError = error as { statusCode?: number; message?: string };
  const status = typeof apiError.statusCode === 'number' ? `HTTP ${apiError.statusCode} · ` : '';

  return elideText(status + (apiError.message ?? String(error)), 220);
}

export interface ConnectionTestOptions {
  timeoutMs?: number;
  /** Credential typed in Settings that has not been stored yet. */
  apiKey?: string;
  /** Lets Settings cancel a probe that is hanging on an unreachable endpoint. */
  abortSignal?: AbortSignal;
}

/**
 * Probes a profile through the same path chat uses — credential lookup, dialect
 * adapter, context guard — with no tools and one step.
 */
export async function testModelConnection(
  model: ModelDescriptor,
  options: ConnectionTestOptions = {},
): Promise<ConnectionTest> {
  const startedAt = Date.now();

  try {
    const agent = createAgent(model, {
      maxSteps: 1,
      apiKey: options.apiKey,
      instructions: 'This is a connectivity probe. Reply with exactly OK. Do not use any tool.',
    });

    const result = await agent.generate({
      prompt: 'Reply with exactly OK.',
      timeout: options.timeoutMs ?? TEST_TIMEOUT_MS,
      abortSignal: options.abortSignal,
    });

    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      text: elideText(result.text, 80),
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
    };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: describeError(error) };
  }
}

/** One-line summary of what a test proved, for the settings UI. */
export function describeConnection(model: ModelDescriptor, test: ConnectionTest): string {
  const target = endpointPreview(model);

  if (!test.ok) {
    return `${target} · failed: ${test.error ?? 'unknown error'}`;
  }

  return `${target} · ok in ${test.latencyMs}ms (${test.inputTokens ?? '?'} in, ${test.outputTokens ?? '?'} out)`;
}
