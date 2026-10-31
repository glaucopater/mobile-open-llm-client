/**
 * Message rendering for AI SDK v7 UI parts.
 *
 * A message is a list of parts (`text`, `reasoning`, `tool-*`, `file`, …), not a
 * single string, so the tool loop is visible in the transcript.
 */
import { StyleSheet, Text, View } from 'react-native';
import type { UIMessage } from 'ai';

import { elideText } from '../core/context';

/** Long payloads are shown clipped, the same way the guard clips them. */
const MAX_RENDERED_CHARS = 1_200;

/** Structural view of a tool part; `ai` types these per tool name. */
type ToolPart = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

const TOOL_STATE_LABEL: Record<string, string> = {
  'input-streaming': 'writing arguments…',
  'input-available': 'running…',
  'approval-requested': 'waiting for approval',
  'output-available': 'done',
  'output-error': 'failed',
};

function preview(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);

  return elideText(text ?? String(value), MAX_RENDERED_CHARS);
}

function toolNameOf(part: ToolPart): string {
  if (part.toolName !== undefined) {
    return part.toolName;
  }

  return part.type.startsWith('tool-') ? part.type.slice('tool-'.length) : 'tool';
}

function PartView({ part }: { part: UIMessage['parts'][number] }) {
  if (part.type === 'text') {
    return <Text style={styles.text}>{part.text}</Text>;
  }

  if (part.type === 'reasoning') {
    return (
      <View style={styles.reasoning}>
        <Text style={styles.reasoningLabel}>Reasoning</Text>
        <Text style={styles.reasoningText}>{elideText(part.text, MAX_RENDERED_CHARS)}</Text>
      </View>
    );
  }

  if (part.type === 'step-start') {
    return null;
  }

  if (part.type === 'file') {
    return <Text style={styles.meta}>file · {part.mediaType}</Text>;
  }

  if (part.type === 'source-url') {
    return <Text style={styles.meta}>source · {part.title ?? part.url}</Text>;
  }

  if (part.type === 'source-document') {
    return <Text style={styles.meta}>source · {part.title}</Text>;
  }

  if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') {
    const toolPart = part as unknown as ToolPart;
    const body = toolPart.errorText
      ? toolPart.errorText
      : toolPart.output !== undefined
        ? preview(toolPart.output)
        : preview(toolPart.input);

    return (
      <View style={styles.tool}>
        <Text style={styles.toolName}>{toolNameOf(toolPart)}</Text>
        <Text style={styles.toolState}>
          {TOOL_STATE_LABEL[toolPart.state ?? ''] ?? toolPart.state ?? 'pending'}
        </Text>
        {body.length > 0 ? <Text style={styles.toolBody}>{body}</Text> : null}
      </View>
    );
  }

  return <Text style={styles.meta}>{part.type}</Text>;
}

export function ChatMessage({ message }: { message: UIMessage }) {
  const isUser = message.role === 'user';

  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
        <Text style={styles.role}>{isUser ? 'You' : message.role}</Text>
        {message.parts.map((part, index) => (
          <PartView key={`${message.id}-${index}`} part={part} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    marginBottom: 10,
  },
  rowUser: {
    justifyContent: 'flex-end',
  },
  rowAssistant: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '88%',
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  bubbleUser: {
    backgroundColor: '#E6F4FE',
  },
  bubbleAssistant: {
    backgroundColor: '#F4F4F4',
  },
  role: {
    fontSize: 11,
    fontWeight: '600',
    opacity: 0.55,
  },
  text: {
    fontSize: 15,
    lineHeight: 21,
  },
  reasoning: {
    borderLeftWidth: 3,
    borderLeftColor: '#B0B0B0',
    paddingLeft: 8,
    gap: 4,
  },
  reasoningLabel: {
    fontSize: 11,
    fontWeight: '600',
    opacity: 0.6,
  },
  reasoningText: {
    fontSize: 13,
    fontStyle: 'italic',
    opacity: 0.75,
    lineHeight: 18,
  },
  tool: {
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DDDDDD',
    padding: 8,
    gap: 4,
  },
  toolName: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  toolState: {
    fontSize: 12,
    opacity: 0.6,
  },
  toolBody: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: '#333333',
  },
  meta: {
    fontSize: 12,
    opacity: 0.6,
  },
});
