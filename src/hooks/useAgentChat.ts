/**
 * Chat wiring: `useChat` + `DirectChatTransport` around an in-process agent.
 *
 * There is no HTTP route in this app — the transport calls `ToolLoopAgent`
 * directly, so credentials never leave the device.
 */
import { useChat } from '@ai-sdk/react';
import { DirectChatTransport, type ChatTransport, type UIMessage } from 'ai';
import { useEffect, useMemo, useState } from 'react';

import { createAgent, describeError } from '../core/agent';
import type { TrimReport } from '../core/context';
import { acceptsImages } from '../core/image';
import type { ModelDescriptor } from '../core/model';
import { createDefaultTools } from '../core/tools';
import { createUsageMetadata } from '../core/usage';

export interface AgentChat {
  trim: TrimReport | null;
  /**
   * Clears the transcript, the last error and the trim chip. A turn the guard
   * cannot fit into the window fails forever, so the chat needs a way out.
   */
  reset: () => void;
}

export interface AgentChatOptions {
  /** Stored transcript to restore, so reopening the app shows the same chat. */
  initialMessages?: UIMessage[];
  /** Writes a settled turn to disk. Omitted in tests, where there is no database. */
  persist?: (messages: UIMessage[]) => Promise<void>;
}

export function useAgentChat(model: ModelDescriptor, options: AgentChatOptions = {}) {
  // The guard reports every rewrite; the chip shows the most recent one.
  const [trim, setTrim] = useState<TrimReport | null>(null);

  const transport = useMemo(
    () =>
      new DirectChatTransport({
        agent: createAgent(model, {
          // The fetch tools are only offered to models that declare vision: an
          // image handed back by `fetch_image` is rejected by a text-only server,
          // and every tool schema rides on every request.
          tools: createDefaultTools({ supportsImages: acceptsImages(model) }),
          onTrim: setTrim,
        }),
        // Every model call in the tool loop reports its usage on `finish-step`;
        // the transport only forwards what this callback returns, so the counts
        // are attached to the assistant message as metadata.
        messageMetadata: createUsageMetadata(),
        // `toUIMessageStream` masks every failure as "An error occurred." unless an
        // `onError` is supplied, which is why a rejected image looked like a dead
        // end on the phone. This is the seam that gets the real cause.
        onError: (error: unknown) => describeError(error, model.baseUrl, { freeModel: model.free }),
      }),
    // A profile edit changes the descriptor object, which rebuilds the agent.
    [model],
  );

  // The generic is pinned to plain `UIMessage` because a stored transcript comes
  // back as untyped messages; the transport's inference narrows tool parts to the
  // tools of this agent, which disk rows are not. Runtime shape is identical.
  const chat = useChat<UIMessage>({
    transport: transport as unknown as ChatTransport<UIMessage>,
    // Restored from SQLite at mount; `useChat` reads this once, which is why the
    // screen does not render before the read has finished.
    messages: options.initialMessages ?? [],
    onError: () => undefined,
  });

  const { status, messages } = chat;
  const save = options.persist;

  // A turn is written once it settles. Mid-stream writes would store a reply cut
  // off at the point the app was closed, which restores as a truncated answer. An
  // errored turn is written too — the prompt was really sent — and
  // `sanitizeForStorage` drops the tool call that never got a result, so a failed
  // turn cannot poison the next request.
  useEffect(() => {
    if (save === undefined || status === 'streaming' || status === 'submitted') {
      return;
    }

    void save(messages);
  }, [status, messages, save]);

  const reset = () => {
    chat.clearError();
    chat.setMessages([]);
    setTrim(null);
  };

  return { ...chat, trim, reset };
}
