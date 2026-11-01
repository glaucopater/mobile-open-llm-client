import { Link } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { UIMessage } from 'ai';

import { ChatMessage } from '../components/ChatMessage';
import { budgetFor } from '../core/context';
import { keyIsStored } from '../core/keys';
import type { ModelDescriptor } from '../core/model';
import { useAgentChat } from '../hooks/useAgentChat';
import { useConfig } from '../store/config';
import { theme } from '../theme';

export default function ChatScreen() {
  const loaded = useConfig((state) => state.loaded);
  const models = useConfig((state) => state.models);
  const selectedId = useConfig((state) => state.selectedId);

  const model = models.find((m) => m.id === selectedId) ?? models[0];

  if (!loaded) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="small" />
      </View>
    );
  }

  // Every profile can be deleted, which used to leave this screen as a spinner
  // with no way out.
  if (model === undefined) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>No models configured</Text>
        <Text style={styles.muted}>Add a provider from the catalog in Settings.</Text>
        <Link href="/settings" style={styles.link}>
          Open Settings
        </Link>
      </View>
    );
  }

  if (model.source === 'remote' && !keyIsStored(model.apiKeyRef)) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>{model.label}</Text>
        <Text style={styles.muted}>This model needs an API key before it can answer.</Text>
        <Link href="/settings" style={styles.link}>
          Add the key in Settings
        </Link>
      </View>
    );
  }

  // Remounting per model keeps the transcript tied to the model that produced it.
  return <ChatSession key={model.id} model={model} />;
}

function ChatSession({ model }: { model: ModelDescriptor }) {
  const { messages, status, error, sendMessage, stop, trim, reset } = useAgentChat(model);
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const listRef = useRef<FlatList<UIMessage>>(null);

  const busy = status === 'streaming' || status === 'submitted';
  const budget = budgetFor(model.contextWindow);
  const sendDisabled = !busy && draft.trim().length === 0;

  useEffect(() => {
    listRef.current?.scrollToEnd({ animated: true });
  }, [messages.length]);

  // The keyboard shrinks the list (adjustResize on Android, padding on iOS), so
  // the newest turn has to be re-scrolled into the smaller viewport.
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => {
      listRef.current?.scrollToEnd({ animated: true });
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => {
      listRef.current?.scrollToEnd({ animated: false });
    });

    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  const send = () => {
    const text = draft.trim();

    if (text.length === 0 || busy) {
      return;
    }

    setDraft('');
    Keyboard.dismiss();
    sendMessage({ text });
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.modelLabel}>{model.label}</Text>
          <Text style={styles.budget}>
            ctx {budget.contextWindow} · prompt ≤ {budget.inputBudget} · answer {budget.maxOutputTokens}
          </Text>
          {trim !== null && messages.length > 0 && (trim.droppedMessages > 0 || trim.clippedToolResults > 0) ? (
            <Text style={styles.trimChip}>
              trimmed {trim.droppedMessages} msgs · {trim.beforeTokens}→{trim.afterTokens} tok
              {trim.clippedToolResults > 0 ? ` · ${trim.clippedToolResults} tool cut` : ''}
            </Text>
          ) : null}
        </View>
        <View style={styles.headerActions}>
          {messages.length > 0 ? (
            <Pressable
              onPress={reset}
              disabled={busy}
              style={({ pressed }) => [
                styles.headerAction,
                pressed && !busy ? styles.headerActionPressed : undefined,
              ]}
              accessibilityRole="button"
            >
              <Text style={busy ? styles.headerActionDisabled : styles.headerActionText}>
                New chat
              </Text>
            </Pressable>
          ) : null}
          <Link href="/settings" style={[styles.headerAction, styles.settingsLink]}>
            Settings
          </Link>
        </View>
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(message) => message.id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => <ChatMessage message={item} />}
        ListEmptyComponent={<Text style={styles.muted}>Nothing yet — ask something.</Text>}
        keyboardShouldPersistTaps="handled"
      />

      {error !== undefined ? <Text style={styles.error}>{error.message}</Text> : null}

      <View style={styles.composer}>
        <TextInput
          style={[styles.input, focused ? styles.inputFocused : undefined]}
          value={draft}
          onChangeText={setDraft}
          placeholder={busy ? 'Answering…' : 'Message'}
          placeholderTextColor={theme.subtle}
          multiline
          editable={!busy}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSubmitEditing={send}
          selectionColor={theme.accent}
          accessibilityLabel="Message"
        />
        <Pressable
          style={({ pressed }) => [
            styles.button,
            busy ? styles.buttonStop : undefined,
            sendDisabled ? styles.buttonDisabled : undefined,
            pressed && !sendDisabled
              ? busy
                ? styles.buttonStopPressed
                : styles.buttonPressed
              : undefined,
          ]}
          onPress={busy ? stop : send}
          disabled={sendDisabled}
          accessibilityRole="button"
          accessibilityLabel={busy ? 'Stop answering' : 'Send message'}
        >
          <Text style={[styles.buttonText, sendDisabled ? styles.buttonTextDisabled : undefined]}>
            {busy ? 'Stop' : 'Send'}
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: theme.bg,
    padding: 24,
    gap: 10,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    color: theme.text,
  },
  muted: {
    fontSize: 14,
    color: theme.muted,
    paddingHorizontal: 24,
  },
  link: {
    fontSize: 16,
    fontWeight: '600',
    color: theme.accentText,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 6,
    backgroundColor: theme.bg,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  headerText: {
    flex: 1,
    gap: 3,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  // Touch target stays ≥44dp; the label is small but not faint.
  headerAction: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  headerActionPressed: {
    backgroundColor: theme.accentSoft,
  },
  headerActionText: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.accentText,
  },
  headerActionDisabled: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.subtle,
  },
  settingsLink: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.accentText,
  },
  modelLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.text,
  },
  budget: {
    fontSize: 11,
    color: theme.muted,
  },
  trimChip: {
    fontSize: 11,
    fontWeight: '600',
    color: theme.warn,
    backgroundColor: theme.warnSoft,
    borderWidth: 1,
    borderColor: theme.warn,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  listContent: {
    padding: 16,
    gap: 4,
    paddingBottom: 24,
  },
  error: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 10,
    borderRadius: 8,
    backgroundColor: theme.dangerSoft,
    borderWidth: 1,
    borderColor: theme.danger,
    color: theme.danger,
    fontSize: 13,
    lineHeight: 18,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 12,
    backgroundColor: theme.bg,
    borderTopWidth: 1,
    borderTopColor: theme.border,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    borderRadius: 12,
    backgroundColor: theme.card,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    lineHeight: 20,
    color: theme.text,
  },
  inputFocused: {
    borderColor: theme.accent,
    borderWidth: 2,
  },
  button: {
    borderRadius: 12,
    backgroundColor: theme.accent,
    minHeight: 44,
    minWidth: 66,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  buttonStop: {
    backgroundColor: theme.danger,
  },
  buttonPressed: {
    backgroundColor: theme.accentPressed,
  },
  buttonStopPressed: {
    backgroundColor: theme.dangerPressed,
  },
  buttonDisabled: {
    backgroundColor: theme.disabled,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  buttonTextDisabled: {
    color: theme.muted,
  },
});
