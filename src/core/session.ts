/**
 * Conversation identity for gateways that route by session.
 *
 * OpenCode Go answers `400 MissingSessionID` when `x-opencode-session` is
 * absent, and asks for a *stable* id per conversation so its prompt cache can be
 * reused (https://opencode.ai/v2/docs/console/go#where-can-i-use-it). It also
 * wants a client-owned `User-Agent` instead of a generic HTTP-library name.
 *
 * The id is minted once and stored, so restarting the app keeps the same
 * conversation identity. Once transcript persistence exists, each stored
 * conversation should get its own id instead of this app-wide one.
 */
import { getJson, setJson } from '../store/db';
import { APP_NAME, APP_VERSION } from '../version';

/** Stored under this key in the non-secret kv table — an id is not a credential. */
const SESSION_STORAGE_KEY = 'conversation-session';

/** Header the OpenCode gateway requires on every request. */
export const SESSION_HEADER = 'x-opencode-session';

/** Gateways that reject a request without a session id. */
const SESSION_HEADER_HOSTS = ['opencode.ai'];

/** Sent to those gateways in place of the runtime's default user agent. */
export const CLIENT_USER_AGENT = `${APP_NAME.toLowerCase().replace(/ /g, '-')}/${APP_VERSION}`;

/** Host of a base URL, without the `URL` class: Hermes has no global `URL`. */
export function hostOf(baseUrl: string): string {
  const match = /^https?:\/\/(?:[^@/]*@)?([^:/?#]+)/i.exec(baseUrl.trim());

  return match?.[1]?.toLowerCase() ?? '';
}

export function needsSessionHeader(baseUrl: string): boolean {
  const host = hostOf(baseUrl);

  return SESSION_HEADER_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

let sessionId: string | null = null;

/** `ses_...` shaped like the ids the gateway documents. Math.random is enough here. */
function newSessionId(): string {
  const random = Array.from({ length: 12 }, () => Math.floor(Math.random() * 36).toString(36)).join('');

  return `ses_${Date.now().toString(36)}_${random}`;
}

/**
 * Reads the stored id, minting and persisting one when the app has none.
 * Called from the root layout: the agent is built synchronously, so the id must
 * be in memory before the first request goes out.
 */
export async function loadConversationSessionId(): Promise<string> {
  const stored = await getJson<{ id?: string }>(SESSION_STORAGE_KEY);
  const id =
    stored?.id !== undefined && stored.id.length > 0 ? stored.id : (sessionId ?? newSessionId());

  sessionId = id;

  if (stored?.id !== id) {
    await setJson(SESSION_STORAGE_KEY, { id });
  }

  return id;
}

/** Sync read for provider construction; falls back to a freshly minted id. */
export function conversationSessionId(): string {
  sessionId ??= newSessionId();

  return sessionId;
}
