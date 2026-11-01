/**
 * Message rendering for AI SDK v7 UI parts.
 *
 * A message is a list of parts (`text`, `reasoning`, `tool-*`, `file`, …), not a
 * single string, so the tool loop is visible in the transcript.
 */
import { Image, StyleSheet, Text, View } from 'react-native';
import type { UIMessage } from 'ai';

import { elideText } from '../core/context';
import type { ModelPricing } from '../core/model';
import { costLabel, stepLabel, usageLabel, usageOf } from '../core/usage';
import { theme } from '../theme';

/** Long payloads are shown clipped, the same way the guard clips them. */
const MAX_RENDERED_CHARS = 1_200;

/** Attachment thumbnails: big enough to read a screenshot, small enough to scan. */
const THUMB_WIDTH = 220;
const THUMB_HEIGHT = 150;

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

/** State is colour-coded as well as worded: running, done and failed read apart at a glance. */
const TOOL_STATE_COLOR: Record<string, string> = {
  'input-streaming': theme.accentText,
  'input-available': theme.accentText,
  'approval-requested': theme.warn,
  'output-available': theme.ok,
  'output-error': theme.danger,
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
    // An image the user attached or the model returned: drawn, not described,
    // because "file · image/jpeg" tells nobody what was in it.
    if (part.mediaType.startsWith('image/')) {
      return (
        <Image
          source={{ uri: part.url }}
          style={styles.image}
          resizeMode="contain"
          accessibilityLabel={`Image (${part.mediaType})`}
        />
      );
    }

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

    const stateColor = TOOL_STATE_COLOR[toolPart.state ?? ''] ?? theme.muted;

    return (
      <View style={styles.tool}>
        <View style={styles.toolHead}>
          <Text style={styles.toolName}>{toolNameOf(toolPart)}</Text>
          <Text style={[styles.toolState, { color: stateColor }]}>
            {TOOL_STATE_LABEL[toolPart.state ?? ''] ?? toolPart.state ?? 'pending'}
          </Text>
        </View>
        {body.length > 0 ? <Text style={styles.toolBody}>{body}</Text> : null}
      </View>
    );
  }

  return <Text style={styles.meta}>{part.type}</Text>;
}

export function ChatMessage({
  message,
  pricing,
}: {
  message: UIMessage;
  /** Catalogue prices for the model that answered, used to estimate the cost. */
  pricing?: ModelPricing;
}) {
  const isUser = message.role === 'user';
  // Usage is per assistant turn: a tool loop is several calls, so the footer
  // names the count and lists each one when there is more than one.
  const usage = isUser ? undefined : usageOf(message);
  const cost = usage !== undefined ? costLabel(usage, pricing) : undefined;

  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
        <Text style={styles.role}>{isUser ? 'You' : message.role}</Text>
        {message.parts.map((part, index) => (
          <PartView key={`${message.id}-${index}`} part={part} />
        ))}
        {usage !== undefined ? (
          <View style={styles.usage}>
            <Text style={styles.usageLine}>
              {usageLabel(usage)}
              {cost !== undefined ? ` · ${cost}` : ''}
            </Text>
            {usage.steps.length > 1
              ? usage.steps.map((step, index) => (
                  <Text key={`${message.id}-usage-${index}`} style={styles.usageStep}>
                    {stepLabel(step, index)}
                  </Text>
                ))
              : null}
          </View>
        ) : null}
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
    borderWidth: 1,
    padding: 12,
    gap: 8,
  },
  bubbleUser: {
    backgroundColor: theme.surfaceAlt,
    borderColor: theme.border,
  },
  bubbleAssistant: {
    backgroundColor: theme.surface,
    borderColor: theme.border,
  },
  role: {
    fontSize: 11,
    fontWeight: '600',
    color: theme.muted,
    letterSpacing: 0.4,
  },
  text: {
    fontSize: 15,
    lineHeight: 22,
    color: theme.text,
  },
  reasoning: {
    borderLeftWidth: 3,
    borderLeftColor: theme.border,
    paddingLeft: 8,
    gap: 4,
  },
  reasoningLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: theme.muted,
    letterSpacing: 0.4,
  },
  reasoningText: {
    fontSize: 13,
    fontStyle: 'italic',
    lineHeight: 18,
    color: theme.muted,
  },
  tool: {
    borderRadius: 8,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    padding: 8,
    gap: 4,
  },
  toolHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  toolName: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'monospace',
    color: theme.text,
  },
  toolState: {
    fontSize: 12,
    fontWeight: '600',
  },
  toolBody: {
    fontSize: 12,
    fontFamily: 'monospace',
    lineHeight: 17,
    color: theme.text,
  },
  meta: {
    fontSize: 12,
    color: theme.muted,
  },
  /** Attached or returned image, drawn inside the bubble. */
  image: {
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    borderRadius: 8,
    backgroundColor: theme.card,
  },
  /** Token footer, separated from the answer it describes. */
  usage: {
    borderTopWidth: 1,
    borderTopColor: theme.border,
    paddingTop: 6,
    gap: 2,
  },
  usageLine: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'monospace',
    color: theme.muted,
  },
  usageStep: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: theme.subtle,
  },
});
