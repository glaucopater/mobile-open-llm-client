import { Link } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
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
  const listRef = useRef<FlatList<UIMessage>>(null);

  const busy = status === 'streaming' || status === 'submitted';
  const budget = budgetFor(model.contextWindow);

  useEffect(() => {
    listRef.current?.scrollToEnd({ animated: true });
  }, [messages.length]);

  const send = () => {
    const text = draft.trim();

    if (text.length === 0 || busy) {
      return;
    }

    setDraft('');
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
            <Pressable onPress={reset} disabled={busy}>
              <Text style={styles.settingsLink}>New chat</Text>
            </Pressable>
          ) : null}
          <Link href="/settings" style={styles.settingsLink}>
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
      />

      {error !== undefined ? <Text style={styles.error}>{error.message}</Text> : null}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={busy ? 'Answering…' : 'Message'}
          multiline
          editable={!busy}
          onSubmitEditing={send}
        />
        <Pressable
          style={[styles.button, busy ? styles.buttonStop : undefined]}
          onPress={busy ? stop : send}
          disabled={!busy && draft.trim().length === 0}
        >
          <Text style={styles.buttonText}>{busy ? 'Stop' : 'Send'}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    gap: 10,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
  },
  muted: {
    fontSize: 14,
    opacity: 0.6,
    paddingHorizontal: 24,
  },
  link: {
    fontSize: 16,
    color: '#0A7FB5',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#E8E8E8',
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  settingsLink: {
    fontSize: 13,
    color: '#0A7FB5',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  modelLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  budget: {
    fontSize: 11,
    opacity: 0.6,
  },
  trimChip: {
    fontSize: 11,
    color: '#B45309',
  },
  listContent: {
    padding: 16,
    gap: 4,
  },
  error: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    color: '#B02A30',
    fontSize: 13,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#E8E8E8',
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    borderWidth: 1,
    borderColor: '#DDDDDD',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
  },
  button: {
    borderRadius: 10,
    backgroundColor: '#0A7FB5',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  buttonStop: {
    backgroundColor: '#B02A30',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
});
