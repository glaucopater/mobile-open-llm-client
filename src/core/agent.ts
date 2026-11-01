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
import { describeTransportFailure, isTransportFailure } from './network-error';
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

  // A missing credential is not a construction failure. Chat builds the agent
  // during render, so throwing here crashed the whole screen — the header, the
  // model chip and Settings were gone and the phone was stuck on a dead view.
  // `ChatSession` disables Send and names the missing key instead, and
  // `testModelConnection` reports it before probing.
  const languageModel = wrapLanguageModel({
    model: createLanguageModel(model, apiKey),
    middleware: contextWindowGuard({
      contextWindow: model.contextWindow,
      // The model's own answer limit caps the budget, so a small-output model is
      // never asked for more than it can return.
      maxOutputTokens: model.maxOutputTokens,
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

/**
 * Turns any failure into one line a settings screen can show. A status-less
 * failure is classified by `core/network-error.ts`, because "Failed to fetch"
 * is a browser-blocked cross-origin request just as often as a dropped socket.
 */
export function describeError(
  error: unknown,
  baseUrl?: string,
  /** A zero-cost model: a 403 is the tier being restricted, not a bad credential. */
  options: { freeModel?: boolean } = {},
): string {
  if (error instanceof ContextOverflowError) {
    return error.message;
  }

  // APICallError carries the HTTP status and the vendor's own body; duck-typed so
  // this stays import-cheap.
  const apiError = error as {
    statusCode?: number;
    message?: string;
    cause?: unknown;
    responseBody?: string;
  };
  const raw = apiError.message ?? String(error);
  const cause = apiError.cause;
  const causeText = cause instanceof Error ? cause.message : undefined;
  // Collapsed to one line: a JSON error body arrives with newlines, which the
  // banner would render as a paragraph.
  const body =
    typeof apiError.responseBody === 'string'
      ? apiError.responseBody.replace(/\s+/g, ' ').trim()
      : undefined;

  let detail = raw;

  if (causeText !== undefined && !detail.includes(causeText)) {
    detail = `${detail} · ${causeText}`;
  }

  // The body is the only text that names a rejected request shape (an image the
  // endpoint does not accept, a bad model id); the wrapper message alone does not.
  if (body !== undefined && body.length > 0 && !detail.includes(body)) {
    detail = `${detail} · server said: ${body}`;
  }

  // Idempotent: a line that already names its class is passed through unchanged,
  // because the banner re-describes the text the transport put in the error chunk.
  const alreadyClassified = /^(network error|blocked by the browser|HTTP \d{3})/.test(detail);

  if (apiError.statusCode === undefined && isTransportFailure(detail) && !alreadyClassified) {
    return describeTransportFailure(detail, baseUrl ?? '');
  }

  const status = typeof apiError.statusCode === 'number' ? `HTTP ${apiError.statusCode} · ` : '';

  // No status field usually means the failure arrived inside an already-accepted
  // stream: the endpoint answered 200 and then failed mid-body, which is not a
  // network fault. A message that already names a status or a class is left alone.
  const namesAStatus = /\bHTTP \d{3}\b|^\d{3}\b/.test(detail);
  const streamed =
    apiError.statusCode === undefined &&
    !namesAStatus &&
    !alreadyClassified &&
    !detail.includes('failed inside the response')
      ? ` · accepted at ${baseUrl ?? 'the endpoint'} and failed inside the response`
      : '';
  const line = status + detail + streamed;

  // A 403 on a free model is the gateway restricting its free tier. Without this
  // line the user checks the key again, which is the wrong thing to check.
  if (apiError.statusCode === 403 && options.freeModel === true) {
    return elideText(`${line} · the free tier is restricted by the gateway, not your key`, 260);
  }

  return elideText(line, 220);
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
    // An empty credential would reach the vendor as an unauthenticated request,
    // which answers with a status the user cannot act on; name it here instead.
    const apiKey = options.apiKey ?? cachedApiKey(model.apiKeyRef);

    if (model.apiKeyRef !== undefined && apiKey === undefined && model.source === 'remote') {
      return {
        ok: false,
        latencyMs: 0,
        error: `${describeModel(model)} needs an API key. Add it in Settings.`,
      };
    }

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
    // The endpoint is what separates a blocked cross-origin request from a dead
    // socket, so the classifier gets it.
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: describeError(error, model.baseUrl, { freeModel: model.free }),
    };
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
