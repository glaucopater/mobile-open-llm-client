import { describe, expect, it, jest } from '@jest/globals';

import {
  ContextOverflowError,
  DEFAULT_CONTEXT_WINDOW,
  MAX_TOOL_RESULT_CHARS,
  MIN_OUTPUT_TOKENS,
  SAFETY_MARGIN_TOKENS,
  contextWindowGuard,
  elideText,
  estimatePromptTokens,
  estimateTokens,
  groupMessages,
  trimPromptToBudget,
  type TrimReport,
} from '../core/context';

// The provider prompt shape the middleware receives. Mirrors
// `LanguageModelV4Prompt` structurally; the guard is typed by `ai`'s middleware.
type Part = {
  type: string;
  text?: string;
  input?: unknown;
  output?: unknown;
  toolCallId?: string;
  toolName?: string;
};

type Message = { role: string; content: Part[] | string };

function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistant(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function assistantWithToolCall(toolCallId: string, input: unknown): Message {
  return { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName: 'read_file', input }] };
}

function toolResult(toolCallId: string, value: string): Message {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId, toolName: 'read_file', output: { type: 'text', value } }],
  };
}

function bigText(chars: number): string {
  return 'x'.repeat(chars);
}

describe('estimateTokens', () => {
  it('is pessimistic rather than optimistic', () => {
    // Word-heavy text estimates above the plain chars/4 rule.
    expect(estimateTokens('the quick brown fox jumps over the lazy dog')).toBeGreaterThan(
      Math.ceil('the quick brown fox jumps over the lazy dog'.length / 4),
    );
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('aaaaaaaaaaaaaaaaaaaa')).toBe(5);
  });
});

describe('elideText', () => {
  it('keeps the head and the tail of a large payload', () => {
    const text = `${'HEAD'.repeat(100)}${'middle'.repeat(1000)}${'TAIL'.repeat(100)}`;
    const elided = elideText(text, 400);

    expect(elided.length).toBeLessThan(text.length);
    expect(elided.startsWith('HEAD')).toBe(true);
    expect(elided.endsWith('TAIL')).toBe(true);
    expect(elided).toContain('characters truncated');
  });

  it('leaves short text untouched', () => {
    expect(elideText('short', 100)).toBe('short');
  });
});

describe('trimPromptToBudget', () => {
  it('leaves a request that already fits alone', () => {
    const prompt = [
      { role: 'system', content: 'You are helpful.' },
      user('hi'),
      assistant('hello'),
    ];

    const { prompt: out, report } = trimPromptToBudget(prompt, {
      inputBudget: 4096,
      contextWindow: 8192,
    });

    expect(out).toEqual(prompt);
    expect(report.droppedMessages).toBe(0);
    expect(report.clippedToolResults).toBe(0);
    expect(report.afterTokens).toBe(report.beforeTokens);
  });

  it('clips oversized tool results at the hard cap', () => {
    const prompt = [
      { role: 'system', content: 'sys' },
      assistantWithToolCall('call-1', { path: 'a.txt' }),
      toolResult('call-1', bigText(MAX_TOOL_RESULT_CHARS * 4)),
    ];

    const { report } = trimPromptToBudget(prompt, {
      inputBudget: 8_000,
      contextWindow: 16_384,
    });

    expect(report.clippedToolResults).toBe(1);
    expect(report.beforeTokens).toBeGreaterThan(report.afterTokens);
  });

  it('drops the oldest turns and keeps the newest ones', () => {
    const prompt: Message[] = [{ role: 'system', content: 'sys' }];

    for (let i = 0; i < 20; i += 1) {
      prompt.push(user(`question ${i} ${bigText(2000)}`));
      prompt.push(assistant(`answer ${i} ${bigText(2000)}`));
    }

    const { prompt: out, report } = trimPromptToBudget(prompt, {
      inputBudget: 2_000,
      contextWindow: 3_000,
    });

    expect(report.droppedMessages).toBeGreaterThan(0);
    expect(out[0].role).toBe('system');
    expect(out[0].content).toContain('sys');
    expect(out[out.length - 1]).toEqual(assistant('answer 19 ' + bigText(2000)));
    expect(JSON.stringify(out)).toContain('Earlier turns were truncated');
    expect(report.afterTokens).toBeLessThanOrEqual(2_000);
  });

  it('never separates a tool call from its result', () => {
    const prompt: Message[] = [{ role: 'system', content: 'sys' }];

    // Two complete tool round-trips, then a final question.
    for (let i = 0; i < 4; i += 1) {
      prompt.push(user(`ask ${i} ${bigText(4000)}`));
      prompt.push(assistantWithToolCall(`call-${i}`, { query: i }));
      prompt.push(toolResult(`call-${i}`, bigText(6000)));
    }
    prompt.push(user('and now?'));

    const { prompt: out } = trimPromptToBudget(prompt, {
      inputBudget: 1_500,
      contextWindow: 2_048,
    });

    const calls = new Set(
      out
        .filter((message) => message.role === 'assistant')
        .flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.filter((part) => part.type === 'tool-call').map((part) => part.toolCallId)
            : [],
        ),
    );
    const results = new Set(
      out
        .filter((message) => message.role === 'tool')
        .flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.filter((part) => part.type === 'tool-result').map((part) => part.toolCallId)
            : [],
        ),
    );

    expect([...results].filter((id) => !calls.has(id))).toEqual([]);
  });

  it('does not mutate the caller messages', () => {
    const prompt = [user(bigText(MAX_TOOL_RESULT_CHARS * 4))];
    trimPromptToBudget(prompt, { inputBudget: 1_000, contextWindow: 2_048 });

    expect(prompt[0].content).toHaveLength(1);
    const part = (prompt[0].content as Part[])[0];
    expect(part.text).toHaveLength(MAX_TOOL_RESULT_CHARS * 4);
  });

  it('throws when even the smallest request does not fit', () => {
    const prompt = [
      { role: 'system', content: bigText(40_000) },
      user('hi'),
    ];

    expect(() =>
      trimPromptToBudget(prompt, { inputBudget: 256, contextWindow: 512 }),
    ).toThrow(ContextOverflowError);
  });

  it('counts tool schemas against the budget', () => {
    const tools = [{ name: 'read_file', description: 'Reads a file', inputSchema: { type: 'object' } }];

    expect(estimatePromptTokens([user('hi')], tools)).toBeGreaterThan(
      estimatePromptTokens([user('hi')]),
    );
  });
});

describe('groupMessages', () => {
  it('binds tool results to the assistant turn that asked for them', () => {
    const groups = groupMessages([
      user('hi'),
      assistantWithToolCall('a', {}),
      assistantWithToolCall('b', {}),
      toolResult('a', 'one'),
      toolResult('b', 'two'),
      assistant('done'),
    ]);

    // One step: two assistant tool calls plus both results, then the reply.
    expect(groups.map((group) => group.length)).toEqual([1, 4, 1]);
  });
});

describe('contextWindowGuard', () => {
  async function callGuard(contextWindow: number, prompt: Message[], tools?: unknown[]) {
    const guard = contextWindowGuard({ contextWindow });
    const result = await guard.transformParams?.({
      type: 'stream',
      params: { prompt, tools, maxOutputTokens: 8_000 } as never,
      model: {} as never,
    });

    return result as { prompt: Message[]; maxOutputTokens: number };
  }

  it('clamps maxOutputTokens so the answer fits in the window', async () => {
    const result = await callGuard(DEFAULT_CONTEXT_WINDOW, [
      { role: 'system', content: 'sys' },
      user('hi'),
    ]);

    expect(result.maxOutputTokens).toBeLessThanOrEqual(
      DEFAULT_CONTEXT_WINDOW - SAFETY_MARGIN_TOKENS,
    );
    expect(result.maxOutputTokens).toBeGreaterThanOrEqual(MIN_OUTPUT_TOKENS);
  });

  it('trims a request that would exceed the window', async () => {
    const prompt: Message[] = [{ role: 'system', content: 'sys' }];

    for (let i = 0; i < 30; i += 1) {
      prompt.push(user(`q${i} ${bigText(3000)}`));
    }

    const result = await callGuard(16_384, prompt);

    expect(estimatePromptTokens(result.prompt)).toBeLessThanOrEqual(16_384 - MIN_OUTPUT_TOKENS);
  });

  it('reports the trim so the UI can surface it', async () => {
    const onTrim = jest.fn();
    const guard = contextWindowGuard({ contextWindow: 2_048, onTrim });

    await guard.transformParams?.({
      type: 'generate',
      params: {
        prompt: [
          { role: 'system', content: 'sys' },
          ...Array.from({ length: 10 }, (_unused, i) => user(`q${i} ${bigText(2000)}`)),
        ],
        maxOutputTokens: 4_096,
      } as never,
      model: {} as never,
    });

    expect(onTrim).toHaveBeenCalledTimes(1);

    const report = onTrim.mock.calls[0][0] as TrimReport;
    expect(report.beforeTokens).toBeGreaterThan(report.afterTokens);
    expect(report.droppedMessages).toBeGreaterThan(0);
    expect(report.contextWindow).toBe(2_048);
  });

  it('throws a readable error when the window is smaller than the minimum request', async () => {
    const guard = contextWindowGuard({ contextWindow: 300 });

    await expect(
      guard.transformParams?.({
        type: 'stream',
        params: { prompt: [{ role: 'system', content: bigText(40_000) }] } as never,
        model: {} as never,
      }),
    ).rejects.toThrow(ContextOverflowError);
  });
});
