/**
 * Chat wiring: `useChat` + `DirectChatTransport` around an in-process agent.
 *
 * There is no HTTP route in this app — the transport calls `ToolLoopAgent`
 * directly, so credentials never leave the device.
 */
import { useChat } from '@ai-sdk/react';
import { DirectChatTransport } from 'ai';
import { useMemo, useState } from 'react';

import { createAgent } from '../core/agent';
import type { TrimReport } from '../core/context';
import type { ModelDescriptor } from '../core/model';
import { createDefaultTools } from '../core/tools';

export interface AgentChat {
  trim: TrimReport | null;
  /**
   * Clears the transcript, the last error and the trim chip. A turn the guard
   * cannot fit into the window fails forever, so the chat needs a way out.
   */
  reset: () => void;
}

export function useAgentChat(model: ModelDescriptor) {
  // The guard reports every rewrite; the chip shows the most recent one.
  const [trim, setTrim] = useState<TrimReport | null>(null);

  const transport = useMemo(
    () =>
      new DirectChatTransport({
        agent: createAgent(model, { tools: createDefaultTools(), onTrim: setTrim }),
      }),
    // A profile edit changes the descriptor object, which rebuilds the agent.
    [model],
  );

  const chat = useChat({ transport, onError: () => undefined });

  const reset = () => {
    chat.clearError();
    chat.setMessages([]);
    setTrim(null);
  };

  return { ...chat, trim, reset };
}
