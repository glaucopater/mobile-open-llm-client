/**
 * Transcript persistence.
 *
 * `store/db.ts` is swapped for an in-memory stand-in: the suites do not have
 * expo-sqlite, and the point of these tests is the row contract (order, cap,
 * unreadable rows), not SQLite itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'ai';

import { clearTranscript, loadTranscript, MAX_STORED_MESSAGES, saveTranscript } from '../store/transcript';

interface FakeRow {
  session_id: string;
  seq: number;
  message: string;
}

const rows: FakeRow[] = [];

// `vi.mock` is hoisted above the import above, so the stand-in is installed
// before `store/transcript` is evaluated.
vi.mock('../store/db', () => ({
  getDatabase: async () => ({
    runAsync: async (sql: string, params: unknown[]) => {
      if (sql.startsWith('DELETE FROM transcript')) {
        const sessionId = params[0] as string;
        const kept = rows.filter((row) => row.session_id !== sessionId);
        rows.length = 0;
        rows.push(...kept);

        return;
      }

      rows.push({
        session_id: params[0] as string,
        seq: params[1] as number,
        message: params[2] as string,
      });
    },
    getAllAsync: async (_sql: string, params: unknown[]) => {
      const sessionId = params[0] as string;

      return rows
        .filter((row) => row.session_id === sessionId)
        .sort((a, b) => a.seq - b.seq)
        .map((row) => ({ message: row.message }));
    },
  }),
}));

function message(role: 'user' | 'assistant', text: string): UIMessage {
  return { id: `${role}-${text}`, role, parts: [{ type: 'text', text }] };
}

beforeEach(() => {
  rows.length = 0;
});

describe('saveTranscript / loadTranscript', () => {
  it('stores prompts and replies and reads them back in send order', async () => {
    await saveTranscript('ses_a', [
      message('user', 'hello'),
      message('assistant', 'hi there'),
      message('user', 'and the tools?'),
      message('assistant', 'three of them'),
    ]);

    const restored = await loadTranscript('ses_a');

    expect(restored.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(restored[1].parts).toEqual([{ type: 'text', text: 'hi there' }]);
  });

  it('keeps tool parts and usage metadata, so the token footer survives a reload', async () => {
    await saveTranscript('ses_a', [
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'fetch_url',
            toolCallId: 'call-1',
            state: 'output-available',
            input: { url: 'https://example.test' },
            output: 'HTTP 200 · ok',
          },
          { type: 'text', text: 'Fetched it.' },
        ],
        metadata: { usage: { inputTokens: 120, outputTokens: 30, calls: 2 } },
      },
    ]);

    const [restored] = await loadTranscript('ses_a');

    expect(restored.parts.map((part) => part.type)).toEqual(['dynamic-tool', 'text']);
    expect(restored.metadata).toEqual({ usage: { inputTokens: 120, outputTokens: 30, calls: 2 } });
  });

  it('drops a tool call that never got a result, keeping the prompt that asked for it', async () => {
    // A turn that failed mid-tool leaves a call with no result. Restoring it
    // would send a `tool_calls` entry with no matching tool message, which every
    // dialect rejects — so the next message would fail forever.
    await saveTranscript('ses_a', [
      message('user', 'fetch the page'),
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Let me fetch it.' },
          {
            type: 'dynamic-tool',
            toolName: 'fetch_url',
            toolCallId: 'call-1',
            state: 'input-available',
            input: { url: 'https://example.test' },
          },
        ],
      },
    ]);

    const restored = await loadTranscript('ses_a');

    expect(restored.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(restored[1].parts).toEqual([{ type: 'text', text: 'Let me fetch it.' }]);

    // An assistant turn that streamed nothing at all is not a reply.
    await saveTranscript('ses_b', [
      message('user', 'hello'),
      { id: 'assistant-1', role: 'assistant', parts: [] },
    ]);

    expect((await loadTranscript('ses_b')).map((m) => m.role)).toEqual(['user']);
  });

  it('keeps the newest picture and notes the older one once the budget is full', async () => {
    const photo = (bytes: number) => ({
      type: 'file' as const,
      mediaType: 'image/jpeg',
      url: `data:image/jpeg;base64,${'A'.repeat(Math.ceil((bytes * 4) / 3))}`,
    });

    await saveTranscript('ses_a', [
      // 6 MB will not fit once the 3 MB in the newest turn has spent the budget.
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'first' }, photo(6_000_000)] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'second' }, photo(3_000_000)] },
    ]);

    const restored = await loadTranscript('ses_a');

    // The newest message keeps its payload; the older one keeps its words.
    expect(restored[1].parts[1]).toMatchObject({ type: 'file' });
    expect(restored[0].parts[1]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('picture budget'),
    });
    expect(restored[0].parts[0]).toEqual({ type: 'text', text: 'first' });

    // Nothing else in the row was rewritten: the note is the only change.
    expect(JSON.stringify(restored[0].parts)).toContain('first');
  });

  it('keeps a tool result that is over budget, minus its picture', async () => {
    // A `fetch_image` result carries base64. Rewriting the whole part would
    // orphan the call, so the payload goes and the call keeps its answer.
    const base64 = 'A'.repeat(Math.ceil((9_000_000 * 4) / 3));

    await saveTranscript('ses_a', [
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'fetch_image',
            toolCallId: 'call-1',
            state: 'output-available',
            input: { url: 'https://example.test/photo.jpg' },
            output: {
              type: 'content',
              value: [
                { type: 'text', text: 'Fetched https://example.test/photo.jpg' },
                { type: 'media', data: base64, mediaType: 'image/jpeg' },
              ],
            },
          },
        ],
      },
    ]);

    const [restored] = await loadTranscript('ses_a');
    const part = restored.parts[0] as { state?: string; output?: { value?: { type: string }[] } };

    expect(part.state).toBe('output-available');
    expect(part.output?.value?.map((entry) => entry.type)).toEqual(['text', 'text']);
    expect(JSON.stringify(part.output)).not.toContain('data:image');
    expect(JSON.stringify(part.output)).toContain('Fetched https://example.test/photo.jpg');
  });

  it('drops the oldest turns past the cap and keeps the newest', async () => {
    const many = Array.from({ length: MAX_STORED_MESSAGES + 5 }, (_, index) =>
      message('user', `turn ${index}`),
    );

    await saveTranscript('ses_a', many);
    const restored = await loadTranscript('ses_a');

    expect(restored).toHaveLength(MAX_STORED_MESSAGES);
    expect(restored[restored.length - 1].parts).toEqual([
      { type: 'text', text: `turn ${many.length - 1}` },
    ]);
  });

  it('writes a conversation under its own id without touching another', async () => {
    await saveTranscript('ses_a', [message('user', 'first chat')]);
    await saveTranscript('ses_b', [message('user', 'second chat')]);

    expect(await loadTranscript('ses_a')).toHaveLength(1);
    expect((await loadTranscript('ses_b'))[0].parts).toEqual([
      { type: 'text', text: 'second chat' },
    ]);
  });

  it('reads an empty session as an empty chat, not a failure', async () => {
    expect(await loadTranscript('ses-none')).toEqual([]);
  });

  it('ignores a row that cannot be parsed instead of crashing the screen', async () => {
    rows.push({ session_id: 'ses_a', seq: 0, message: '{"role":"user"' });
    rows.push({ session_id: 'ses_a', seq: 1, message: JSON.stringify(message('user', 'ok')) });

    expect(await loadTranscript('ses_a')).toHaveLength(1);
  });

  it('clears a conversation without clearing its neighbours', async () => {
    await saveTranscript('ses_a', [message('user', 'one')]);
    await saveTranscript('ses_b', [message('user', 'two')]);

    await clearTranscript('ses_a');

    expect(await loadTranscript('ses_a')).toEqual([]);
    expect(await loadTranscript('ses_b')).toHaveLength(1);
  });
});
