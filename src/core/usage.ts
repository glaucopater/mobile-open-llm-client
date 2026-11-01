/**
 * Per-call token accounting.
 *
 * The agent's tool loop makes more than one model call per assistant turn, so a
 * single number would hide what the conversation actually cost. The AI SDK
 * reports usage on every `finish-step` part of the stream; `DirectChatTransport`
 * only forwards what `messageMetadata` hands back, so the counts are attached to
 * the assistant message here and read back by the transcript.
 */
import type { ModelPricing } from './model';
import type { UIMessage } from 'ai';

/** Counts for one model call. Absent when the server sent no usage block. */
export interface UsageStep {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Subset of `outputTokens` spent on reasoning, when the provider splits them. */
  reasoningTokens?: number;
  finishReason?: string;
}

/** Usage of one assistant message: one entry per model call it made. */
export interface MessageUsage {
  steps: UsageStep[];
  /** Sum of the counts the server reported; 0 when it reported none. */
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** False when every step came back empty — the endpoint omits usage. */
  reported: boolean;
}

/** Metadata shape stored on `UIMessage.metadata`. */
export interface UsageMetadata {
  usage: MessageUsage;
}

/**
 * Structural view of a stream part, like `core/context.ts`: only `type`, the
 * usage numbers and the finish reason are read, so this file stays free of a
 * direct `@ai-sdk/provider` dependency.
 */
type StreamPart = {
  type: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    outputTokenDetails?: { reasoningTokens?: number };
  };
  finishReason?: string;
};

function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stepFrom(part: StreamPart): UsageStep {
  const usage = part.usage ?? {};

  return {
    inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined,
    outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined,
    totalTokens: typeof usage.totalTokens === 'number' ? usage.totalTokens : undefined,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
    finishReason: part.finishReason,
  };
}

export function summarizeSteps(steps: UsageStep[]): MessageUsage {
  const inputTokens = steps.reduce((total, step) => total + count(step.inputTokens), 0);
  const outputTokens = steps.reduce((total, step) => total + count(step.outputTokens), 0);
  const reported = steps.some(
    (step) =>
      step.inputTokens !== undefined ||
      step.outputTokens !== undefined ||
      step.totalTokens !== undefined,
  );

  return {
    steps,
    inputTokens,
    outputTokens,
    totalTokens: steps.reduce((total, step) => total + count(step.totalTokens), 0) ||
      inputTokens + outputTokens,
    reported,
  };
}

/**
 * Builds the `messageMetadata` callback for `DirectChatTransport`.
 *
 * The callback is created once per transport and reused for every request, so the
 * accumulator is reset when a stream starts: without that, a second turn would
 * report the first turn's steps too.
 */
export function createUsageMetadata(): (options: { part: StreamPart }) => UsageMetadata | undefined {
  let steps: UsageStep[] = [];

  return ({ part }) => {
    if (part.type === 'start' || part.type === 'stream-start') {
      steps = [];

      return undefined;
    }

    if (part.type === 'finish-step') {
      steps = [...steps, stepFrom(part)];

      return { usage: summarizeSteps(steps) };
    }

    return undefined;
  };
}

function isUsageStep(value: unknown): value is UsageStep {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const step = value as Record<string, unknown>;

  return (
    step.inputTokens === undefined || typeof step.inputTokens === 'number'
  ) && (step.outputTokens === undefined || typeof step.outputTokens === 'number');
}

/** Reads the usage an assistant message carries, if any. */
export function usageOf(message: UIMessage): MessageUsage | undefined {
  const metadata = message.metadata as Partial<UsageMetadata> | undefined;
  const usage = metadata?.usage;

  if (typeof usage !== 'object' || usage === null) {
    return undefined;
  }

  const steps = Array.isArray(usage.steps) ? usage.steps.filter(isUsageStep) : [];

  if (steps.length === 0) {
    return undefined;
  }

  return summarizeSteps(steps);
}

/** Whole-conversation totals, summed over the assistant messages. */
export function sessionUsage(messages: UIMessage[]): MessageUsage | undefined {
  const steps = messages.flatMap((message) => usageOf(message)?.steps ?? []);

  return steps.length > 0 ? summarizeSteps(steps) : undefined;
}

/** Thousands separators, so a 6-figure count stays readable on a narrow screen. */
export function formatTokens(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * The line shown under an assistant turn. Names the call count because a tool
 * loop answers in several requests, not one.
 */
export function usageLabel(usage: MessageUsage): string {
  if (!usage.reported) {
    return `${usage.steps.length} call${usage.steps.length === 1 ? '' : 's'} · no token counts reported`;
  }

  const calls = `${usage.steps.length} call${usage.steps.length === 1 ? '' : 's'}`;

  return `↑ ${formatTokens(usage.inputTokens)} sent · ↓ ${formatTokens(usage.outputTokens)} received · ${calls}`;
}

/** Per-call detail line, so a fat tool round trip is visible separately. */
export function stepLabel(step: UsageStep, index: number): string {
  const parts = [`#${index + 1}`];

  if (step.inputTokens !== undefined) {
    parts.push(`↑ ${formatTokens(step.inputTokens)}`);
  }

  if (step.outputTokens !== undefined) {
    parts.push(`↓ ${formatTokens(step.outputTokens)}`);
  }

  if (step.reasoningTokens !== undefined && step.reasoningTokens > 0) {
    parts.push(`thought ${formatTokens(step.reasoningTokens)}`);
  }

  if (step.finishReason !== undefined) {
    parts.push(step.finishReason);
  }

  return parts.join(' · ');
}

/** USD estimate from the catalogue's per-1k prices; absent when the model is unpriced. */
export function estimateCostUsd(usage: MessageUsage, pricing?: ModelPricing): number | undefined {
  if (pricing === undefined || !usage.reported) {
    return undefined;
  }

  return (
    (usage.inputTokens / 1000) * pricing.inputPer1k +
    (usage.outputTokens / 1000) * pricing.outputPer1k
  );
}

/** Cost line: rounded to 4 decimals so a cheap call is not shown as $0. */
export function costLabel(usage: MessageUsage, pricing?: ModelPricing): string | undefined {
  const cost = estimateCostUsd(usage, pricing);

  if (cost === undefined) {
    return undefined;
  }

  // A free model costs nothing however long the turn ran, so the line states the
  // price instead of a rounded-down estimate that reads like a cheap paid call.
  if (pricing !== undefined && pricing.inputPer1k === 0 && pricing.outputPer1k === 0) {
    return 'free · $0.00';
  }

  return `≈ $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`;
}
