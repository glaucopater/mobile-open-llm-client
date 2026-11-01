/**
 * The current conversation: its id, the transcript restored from SQLite, and the
 * writes that keep it on disk.
 *
 * `useChat` owns the live message list, so this store only carries what the chat
 * needs at construction (`initialMessages`) and where a settled turn is written.
 * Both are read synchronously by the chat screen, hence the load happens in the
 * root layout before the first render, exactly like config and keys.
 */
import { create } from 'zustand';
import type { UIMessage } from 'ai';

import { conversationSessionId, loadConversationSessionId, startNewConversation } from '../core/session';
import { loadTranscript, saveTranscript } from './transcript';

interface ConversationState {
  /** Id of the conversation being shown; also the transcript's key. */
  sessionId: string;
  /** Messages restored from disk, handed to `useChat` at mount. */
  initialMessages: UIMessage[];
  /** True once the stored transcript has been read. */
  loaded: boolean;
  load: () => Promise<void>;
  persist: (messages: UIMessage[]) => Promise<void>;
  /**
   * Starts an empty chat under a fresh session id. The previous transcript is
   * left on disk rather than deleted: it is history the user asked to keep.
   */
  startNew: () => Promise<void>;
}

export const useConversation = create<ConversationState>((set, get) => ({
  sessionId: '',
  initialMessages: [],
  loaded: false,

  async load() {
    const sessionId = await loadConversationSessionId();
    const initialMessages = await loadTranscript(sessionId);

    set({ sessionId, initialMessages, loaded: true });
  },

  async persist(messages) {
    const sessionId = get().sessionId !== '' ? get().sessionId : conversationSessionId();

    await saveTranscript(sessionId, messages);
  },

  async startNew() {
    // The previous transcript is left on disk under its own session id rather
    // than deleted: it is history the user asked to keep, and a later history
    // screen can reopen it.
    const sessionId = await startNewConversation();

    set({ sessionId, initialMessages: [], loaded: true });
  },
}));
