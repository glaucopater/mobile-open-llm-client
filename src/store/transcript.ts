/**
 * Transcript persistence.
 *
 * Every prompt sent and every response received is written to SQLite under the
 * conversation's session id, so reopening the app restores the same chat and a
 * model switch does not discard it. Only the *stored* copy is complete: what the
 * model actually sees is still trimmed by `core/context.ts` on each request.
 *
 * The web build has no SQLite (see `store/db.ts`), so it keeps the same rows in
 * localStorage under one key per session.
 *
 * Credentials never land here — the transcript is prompts, replies, tool calls
 * and image payloads.
 */
import { Platform } from 'react-native';
import type { TextUIPart, UIMessage } from 'ai';

import { getDatabase } from './db';
import { webStorage } from './webStorage';
import { base64ByteLength } from '../core/image';

/** Oldest rows are dropped past this count: an unbounded chat becomes a slow load. */
export const MAX_STORED_MESSAGES = 300;

/**
 * Bytes of picture data one conversation may hold. A phone photo is a few
 * megabytes and four can go in a single message, so an uncapped history grows to
 * hundreds of megabytes and every settle rewrites all of it. Older pictures are
 * replaced by a note, not deleted: the text of the turn stays.
 */
export const MAX_STORED_IMAGE_BYTES = 8_000_000;

/** Web rows live under this prefix, one key per conversation. */
const WEB_PREFIX = 'openllm.transcript.';

/** What replaces a picture whose payload the conversation can no longer afford. */
const DROPPED_IMAGE_NOTE: TextUIPart = {
  type: 'text',
  text: 'Image dropped from the stored history: this conversation is past its picture budget.',
};

/** Rows that survive only for the current page when localStorage is unavailable. */
const memoryRows = new Map<string, string>();

function webKey(sessionId: string): string {
  return WEB_PREFIX + sessionId;
}

/**
 * Parts that must not be written back. A tool call that never received a result
 * (`input-streaming` / `input-available`) restores as a dangling `tool_calls`
 * entry: the next request would carry a call with no matching tool message, and
 * a server rejects that shape outright — so a turn that failed mid-tool would
 * make every later message fail. Text the model did stream is kept: it was sent
 * to the screen, and the user asked for the whole exchange to survive.
 */
export function sanitizeForStorage(messages: UIMessage[]): UIMessage[] {
  return dropOldImages(
    messages
      .map((message) => {
        if (message.role !== 'assistant') {
          return message;
        }

        const parts = message.parts.filter((part) => {
          const state = (part as { state?: string }).state;

          return state !== 'input-streaming' && state !== 'input-available';
        });

        return parts.length === message.parts.length ? message : { ...message, parts };
      })
      .filter((message) => message.parts.length > 0),
  );
}

/** Base64 payload a part carries: an attached image, or media in a tool result. */
function imagePayloadBytes(
  part: { type: string; mediaType?: string; url?: unknown; output?: unknown },
): number {
  if (
    part.type === 'file' &&
    typeof part.mediaType === 'string' &&
    part.mediaType.startsWith('image/') &&
    typeof part.url === 'string'
  ) {
    return base64ByteLength(part.url);
  }

  const output = part.output as
    | { type?: string; value?: { type: string; data?: unknown }[] }
    | undefined;

  if (output?.type !== 'content' || !Array.isArray(output.value)) {
    return 0;
  }

  return output.value.reduce(
    (total, entry) =>
      entry.type === 'media' && typeof entry.data === 'string'
        ? total + base64ByteLength(entry.data)
        : total,
    0,
  );
}

/**
 * Keeps the newest pictures and turns older ones into a line of text. Newest
 * first, because the images still inside the model's window are the ones worth
 * paying for; a picture the guard would trim anyway costs storage for nothing.
 * The text of a turn is never dropped, only its payload.
 */
function dropOldImages(messages: UIMessage[]): UIMessage[] {
  let budget = MAX_STORED_IMAGE_BYTES;
  const kept: UIMessage[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    let seen = 0;

    const parts = message.parts.map((part) => {
      const payload = imagePayloadBytes(
        part as { type: string; mediaType?: string; url?: unknown; output?: unknown },
      );

      if (payload === 0) {
        return part;
      }

      seen += payload;

      if (seen <= budget) {
        return part;
      }

      if (part.type === 'file') {
        return DROPPED_IMAGE_NOTE;
      }

      // A tool result can carry a picture. Its text half has to survive: turning
      // the whole part into a note would orphan the tool call, and a call with no
      // result is the shape a server rejects.
      const output = (part as { output?: { value?: unknown[] } }).output;
      const textOnly = (output?.value ?? []).filter(
        (entry) => (entry as { type: string }).type !== 'media',
      );

      return {
        ...part,
        output: { type: 'content', value: [...textOnly, { type: 'text', text: DROPPED_IMAGE_NOTE.text }] },
      } as UIMessage['parts'][number];
    });

    budget -= Math.min(seen, budget);

    // A replacement keeps the part count, so equality by length would silently
    // discard the note; compare the parts themselves.
    const changed = parts.some((part, position) => part !== message.parts[position]);

    kept.unshift(changed ? { ...message, parts } : message);
  }

  return kept;
}

/**
 * Replaces the stored transcript for a session. Called when a turn settles, not
 * per streamed chunk: a partial assistant message would restore as a cut-off reply.
 */
export async function saveTranscript(sessionId: string, messages: UIMessage[]): Promise<void> {
  const kept = sanitizeForStorage(messages).slice(-MAX_STORED_MESSAGES);

  if (Platform.OS === 'web') {
    memoryRows.set(webKey(sessionId), JSON.stringify(kept));
    const storage = webStorage();

    if (storage !== null) {
      storage.setItem(webKey(sessionId), JSON.stringify(kept));
    }

    return;
  }

  const db = await getDatabase();
  await db.runAsync('DELETE FROM transcript WHERE session_id = ?', [sessionId]);

  for (const [seq, message] of kept.entries()) {
    await db.runAsync(
      'INSERT INTO transcript (session_id, seq, message, created) VALUES (?, ?, ?, ?)',
      [sessionId, seq, JSON.stringify(message), Date.now()],
    );
  }
}

/** Reads a session's transcript in send order; an empty session is an empty list. */
export async function loadTranscript(sessionId: string): Promise<UIMessage[]> {
  if (Platform.OS === 'web') {
    const storage = webStorage();
    const raw = storage?.getItem(webKey(sessionId)) ?? memoryRows.get(webKey(sessionId));

    if (raw === undefined || raw === '') {
      return [];
    }

    try {
      return JSON.parse(raw) as UIMessage[];
    } catch {
      // A row written by an older build, or truncated by a quota error, is not a
      // chat: starting empty is better than crashing the screen.
      return [];
    }
  }

  const db = await getDatabase();
  const rows = await db.getAllAsync<{ message: string }>(
    'SELECT message FROM transcript WHERE session_id = ? ORDER BY seq ASC',
    [sessionId],
  );

  return rows.flatMap((row) => {
    try {
      return [JSON.parse(row.message) as UIMessage];
    } catch {
      return [];
    }
  });
}

/** Drops a conversation. Called by "New chat", which mints a new session id. */
export async function clearTranscript(sessionId: string): Promise<void> {
  if (Platform.OS === 'web') {
    memoryRows.delete(webKey(sessionId));
    webStorage()?.removeItem(webKey(sessionId));

    return;
  }

  const db = await getDatabase();
  await db.runAsync('DELETE FROM transcript WHERE session_id = ?', [sessionId]);
}
