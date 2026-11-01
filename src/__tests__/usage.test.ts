import { describe, expect, it } from 'vitest';

import {
  costLabel,
  createUsageMetadata,
  formatTokens,
  sessionUsage,
  stepLabel,
  summarizeSteps,
  usageLabel,
  usageOf,
  type UsageStep,
} from '../core/usage';
import type { UIMessage } from 'ai';

function message(id: string, steps: UsageStep[]): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', text: 'answer' }],
    metadata: { usage: summarizeSteps(steps) },
  } as UIMessage;
}

describe('per-call usage accumulation', () => {
  const metadata = createUsageMetadata();

  it('starts empty and reports nothing until a step finishes', () => {
    expect(metadata({ part: { type: 'stream-start' } })).toBeUndefined();
    expect(metadata({ part: { type: 'start' } })).toBeUndefined();
    expect(metadata({ part: { type: 'text-delta' } })).toBeUndefined();
  });

  it('carries the counts of each model call in the tool loop', () => {
    metadata({ part: { type: 'start' } });
    metadata({ part: { type: 'finish-step', usage: { inputTokens: 120, outputTokens: 30 }, finishReason: 'tool-calls' } });

    const afterSecond = metadata({
      part: {
        type: 'finish-step',
        usage: { inputTokens: 380, outputTokens: 90, totalTokens: 470 },
        finishReason: 'stop',
      },
    });

    expect(afterSecond?.usage.inputTokens).toBe(500);
    expect(afterSecond?.usage.outputTokens).toBe(120);
    // A server that omits `totalTokens` is not a zero: the sum of the parts stands in.
    expect(afterSecond?.usage.totalTokens).toBe(470);
    expect(afterSecond?.usage.reported).toBe(true);
    expect(afterSecond?.usage.steps).toHaveLength(2);
  });

  it('drops the previous turn when a new stream starts', () => {
    metadata({ part: { type: 'start' } });
    const only = metadata({ part: { type: 'finish-step', usage: { inputTokens: 10, outputTokens: 5 } } });

    expect(only?.usage.steps).toHaveLength(1);
    expect(only?.usage.inputTokens).toBe(10);
  });

  it('says so when the endpoint reports no usage at all', () => {
    metadata({ part: { type: 'start' } });
    const bare = metadata({ part: { type: 'finish-step', finishReason: 'stop' } });

    expect(bare?.usage.reported).toBe(false);
    expect(usageLabel(bare!.usage)).toBe('1 call · no token counts reported');
  });
});

describe('reading usage back', () => {
  it('reads counts stored on the message metadata', () => {
    const usage = usageOf(message('a', [{ inputTokens: 1000, outputTokens: 200 }]));

    expect(usage?.inputTokens).toBe(1000);
    expect(usageLabel(usage!)).toBe('↑ 1,000 sent · ↓ 200 received · 1 call');
  });

  it('returns nothing for a message without usage', () => {
    expect(usageOf({ id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] } as UIMessage)).toBeUndefined();
    expect(usageOf(message('e', []) as UIMessage)).toBeUndefined();
  });

  it('sums the whole session', () => {
    const session = sessionUsage([
      message('a', [{ inputTokens: 100, outputTokens: 20 }]),
      message('b', [{ inputTokens: 400, outputTokens: 80 }, { inputTokens: 600, outputTokens: 40 }]),
    ]);

    expect(session?.inputTokens).toBe(1100);
    expect(session?.outputTokens).toBe(140);
    expect(session?.steps).toHaveLength(3);
  });

  it('names each call when a turn made several', () => {
    const step = stepLabel({ inputTokens: 380, outputTokens: 90, reasoningTokens: 60, finishReason: 'stop' }, 1);

    expect(step).toBe('#2 · ↑ 380 · ↓ 90 · thought 60 · stop');
  });

  it('keeps large counts readable', () => {
    expect(formatTokens(131184)).toBe('131,184');
  });

  it('estimates cost from the catalogue prices', () => {
    const usage = summarizeSteps([{ inputTokens: 1000, outputTokens: 500 }]);

    expect(costLabel(usage, { inputPer1k: 0.15, outputPer1k: 0.6 })).toBe('≈ $0.450');
    expect(costLabel(usage, undefined)).toBeUndefined();
    // An unreported count is not a free call.
    expect(costLabel(summarizeSteps([{ finishReason: 'stop' }]), { inputPer1k: 0.15, outputPer1k: 0.6 })).toBeUndefined();
  });

  it('says free instead of a rounded-down estimate for a zero-priced model', () => {
    const usage = summarizeSteps([{ inputTokens: 40000, outputTokens: 12000 }]);

    // `≈ $0.000` would read like a cheap paid call; the price is zero, so name it.
    expect(costLabel(usage, { inputPer1k: 0, outputPer1k: 0 })).toBe('free · $0.00');
  });
});
