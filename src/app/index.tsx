import { Link } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { UIMessage } from 'ai';

import { AppHeader } from '../components/AppHeader';
import { ChatMessage } from '../components/ChatMessage';
import { ModelSwitchSheet } from '../components/ModelSwitchSheet';
import { describeError } from '../core/agent';
import { modelsForProvider } from '../core/catalog-search';
import { budgetFor } from '../core/context';
import {
  acceptsImages,
  imageParts,
  MAX_IMAGES_PER_MESSAGE,
  pickImages,
  type ImageAttachment,
} from '../core/image';
import { hasApiKey } from '../core/keys';
import { activeDescriptor, type ModelDescriptor, type ProviderConfig } from '../core/model';
import { costLabel, formatTokens, sessionUsage } from '../core/usage';
import { useAgentChat } from '../hooks/useAgentChat';
import { useKeyboardPadding } from '../hooks/useKeyboardPadding';
import { useConfig } from '../store/config';
import { useConversation } from '../store/conversation';
import { theme } from '../theme';

export default function ChatScreen() {
  const loaded = useConfig((state) => state.loaded);
  const providers = useConfig((state) => state.providers);
  const selectedSlug = useConfig((state) => state.selectedSlug);
  const conversationLoaded = useConversation((state) => state.loaded);
  const initialMessages = useConversation((state) => state.initialMessages);
  const persist = useConversation((state) => state.persist);
  const startNew = useConversation((state) => state.startNew);

  // The provider chat talks to. The descriptor is rebuilt only when that
  // provider's row changes, so `useAgentChat` keeps one transport per provider.
  const provider = providers.find((row) => row.slug === selectedSlug) ?? providers[0];
  const model = useMemo(
    () => (provider === undefined ? undefined : activeDescriptor(provider, modelsForProvider(provider))),
    [provider],
  );

  // The stored transcript is read from SQLite, and `useChat` takes its initial
  // messages at mount, so the chat cannot render before the read has finished.
  if (!loaded || !conversationLoaded) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="small" />
      </View>
    );
  }

  // Every provider can be deleted, and a blank one has no model until it is
  // typed or listed, so both states need a way out.
  if (provider === undefined || model === undefined) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>
          {provider === undefined ? 'No providers configured' : `${provider.name} has no model yet`}
        </Text>
        <Text style={styles.muted}>
          {provider === undefined
            ? 'Add a provider from the catalog in Settings.'
            : 'Type a model id or list the models the server offers in Settings.'}
        </Text>
        <Link href="/settings" style={styles.link}>
          Open Settings
        </Link>
      </View>
    );
  }

  // A missing key is shown inside the chat rather than replacing this screen: the
  // header, the version and the model chip still have to be reachable, otherwise a
  // provider without a key is the only thing on screen and there is no way to
  // switch to one that can answer.
  return (
    <ChatSession
      model={model}
      providers={providers}
      selectedSlug={provider.slug}
      initialMessages={initialMessages}
      persist={persist}
      onNewConversation={startNew}
    />
  );
}

function ChatSession({
  model,
  providers,
  selectedSlug,
  initialMessages,
  persist,
  onNewConversation,
}: {
  model: ModelDescriptor;
  providers: ProviderConfig[];
  selectedSlug: string;
  initialMessages: UIMessage[];
  persist: (messages: UIMessage[]) => Promise<void>;
  onNewConversation: () => Promise<void>;
}) {
  const { messages, status, error, sendMessage, stop, trim, reset } = useAgentChat(model, {
    initialMessages,
    persist,
  });
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // Which provider the sheet is browsing. Reset when it opens rather than in an
  // effect, so it cannot cascade a render.
  const [switcherSlug, setSwitcherSlug] = useState(selectedSlug);
  // Images picked for the message being written. They belong to the model that
  // was selected when they were picked, so switching to a model without vision
  // drops them without an effect: the list is read against `model.id`.
  const [pending, setPending] = useState<{
    modelId: string;
    items?: ImageAttachment[];
    error?: string;
  }>({ modelId: '' });
  const attachments = pending.modelId === model.id ? pending.items ?? [] : [];
  const pickError = pending.modelId === model.id ? pending.error : undefined;
  const [picking, setPicking] = useState(false);
  const listRef = useRef<FlatList<UIMessage>>(null);

  const busy = status === 'streaming' || status === 'submitted';
  const budget = budgetFor(model.contextWindow);
  // Image parts are only accepted by models that declare vision; the catalog
  // carries the flag, so the buttons say so instead of failing at the endpoint.
  const vision = acceptsImages(model);
  const session = sessionUsage(messages);
  const sessionCost = session === undefined ? undefined : costLabel(session, model.pricing);
  // Whether this provider's credential exists. SecureStore reads are async and the
  // cache is filled at startup, so the screen asks itself instead of trusting
  // `keyIsStored`, which reports a stored key as missing before priming finishes.
  const [keyMissing, setKeyMissing] = useState(false);
  const sendDisabled =
    !busy && ((draft.trim().length === 0 && attachments.length === 0) || keyMissing);
  const keyboardPadding = useKeyboardPadding();
  // `endCoordinates.height` is the IME inset minus the system bars, but the
  // keyboard covers the navigation bar too, so the bar's own inset has to be
  // padded as well — otherwise the composer ends up inset-height behind the
  // keys (measured on the phone: 31px short, matching the nav bar inset).
  const insets = useSafeAreaInsets();

  const scrollToBottom = (animated: boolean) => {
    listRef.current?.scrollToEnd({ animated });
  };

  // The list follows the newest turn only while the user is sitting at the bottom.
  // A streamed answer grows the transcript as it arrives, and `FlatList` does not
  // render rows outside the viewport: without following the growth, the newest
  // bubble — its answer and its token footer — was never on screen at all (measured
  // on the phone: the app bar reported `↓ 65` while the screen showed only the
  // user's own bubble).
  const viewportHeight = useRef(0);
  const atBottom = useRef(true);

  const trackScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize } = event.nativeEvent;
    const below = contentSize.height - contentOffset.y - viewportHeight.current;

    atBottom.current = below < 140;
  };

  // Fires for every growth of the content, including mid-stream text chunks.
  const followNewest = () => {
    if (busy || atBottom.current) {
      scrollToBottom(false);
    }
  };

  // Scrolls when a turn is added and again when it settles: the token footer is
  // appended after the last text chunk, so a scroll keyed on the message count
  // alone can stop above it and the footer stays out of the viewport.
  useEffect(() => {
    scrollToBottom(true);
  }, [messages.length, status]);

  // The keyboard pads the container (see `useKeyboardPadding`), so the newest
  // turn has to be re-scrolled into the smaller viewport. The padding lands a
  // frame after the event, hence the second pass.
  useEffect(() => {
    let retry: ReturnType<typeof setTimeout> | undefined;

    const shown = Keyboard.addListener('keyboardDidShow', () => {
      scrollToBottom(false);
      retry = setTimeout(() => scrollToBottom(false), 150);
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => {
      scrollToBottom(false);
    });

    return () => {
      if (retry !== undefined) {
        clearTimeout(retry);
      }
      shown.remove();
      hidden.remove();
    };
  }, []);

  // A remote provider without a key cannot answer, so sending is blocked rather
  // than letting the request fail with a vendor error the user cannot act on.
  useEffect(() => {
    let cancelled = false;

    void hasApiKey(model.apiKeyRef).then((present) => {
      if (!cancelled) {
        setKeyMissing(model.source === 'remote' && !present);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [model.apiKeyRef, model.source]);

  const send = () => {
    const text = draft.trim();

    if ((text.length === 0 && attachments.length === 0) || busy || keyMissing) {
      return;
    }

    setDraft('');
    Keyboard.dismiss();

    // `files` is the AI SDK's user-message form for attachments; each part is a
    // data URL the dialect adapter turns into its own image shape.
    const files = imageParts(attachments);
    setPending({ modelId: '' });

    if (text.length > 0) {
      sendMessage({ text, files });
    } else {
      sendMessage({ files });
    }
  };

  /** Opens the system picker; the result is converted here, before it is shown. */
  const attach = async () => {
    if (busy || picking || !vision) {
      return;
    }

    const pickedFor = model.id;
    const already = attachments;

    setPicking(true);
    setPending({ modelId: pickedFor });

    const result = await pickImages({
      remaining: MAX_IMAGES_PER_MESSAGE - already.length,
    });

    setPicking(false);

    setPending({
      modelId: pickedFor,
      items: [...already, ...result.attachments].slice(0, MAX_IMAGES_PER_MESSAGE),
      error: result.error,
    });
  };

  /** Drops one pending image; the bytes stay on the device until they are sent. */
  const detach = (index: number) => {
    setPending((current) => ({
      modelId: current.modelId,
      items: (current.items ?? []).filter((_, position) => position !== index),
      error: current.error,
    }));
  };

  const clearChat = async () => {
    // The new session id is minted first: `reset()` empties the message list, and
    // the settle effect would otherwise write that empty list over the finished
    // conversation that is still stored under the old id.
    await onNewConversation();
    reset();
    setPending({ modelId: '' });
  };

  return (
    <View
      style={StyleSheet.compose(styles.container, { paddingBottom: keyboardPadding + insets.bottom })}
    >
      <AppHeader
        label="Chat"
        actions={
          <>
            {/* Session totals: what the conversation has cost so far, so a run
                that quietly eats 100k tokens is visible without opening a message. */}
            {session !== undefined ? (
              <Text style={styles.sessionUsage} numberOfLines={1}>
                ↑ {formatTokens(session.inputTokens)} · ↓ {formatTokens(session.outputTokens)}
                {sessionCost !== undefined ? ` · ${sessionCost}` : ''}
              </Text>
            ) : null}
            {messages.length > 0 ? (
              <Pressable
                onPress={clearChat}
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
          </>
        }
      />

      {/* Tap to switch: provider first, then that provider's models. The sheet is
          a modal, so switching mid-conversation keeps the transcript and hands it
          to the newly selected model. */}
      <Pressable
        onPress={() => {
          setSwitcherSlug(selectedSlug);
          setSwitcherOpen(true);
        }}
        style={({ pressed }) => [styles.modelRow, pressed ? styles.modelRowPressed : undefined]}
        accessibilityRole="button"
        accessibilityLabel="Switch provider or model"
      >
        {/* Provider and model are separate lines: the provider is the thing being
            configured (endpoint, credential), the model is one of its choices. */}
        <Text style={styles.providerLabel}>{model.providerLabel}</Text>
        <View style={styles.modelLine}>
          <Text style={styles.modelLabel}>{model.modelLabel}</Text>
          {model.free === true ? <Text style={styles.freeChip}>free</Text> : null}
        </View>
        {/* Costs nothing, but a gateway can still restrict the tier — so the chip
            says what it costs and what it might still do. */}
        {model.free === true ? (
          <Text style={styles.freeHint}>free model · a gateway may still restrict this tier (HTTP 403)</Text>
        ) : null}
        <Text style={styles.budget}>
          ctx {budget.contextWindow} · prompt ≤ {budget.inputBudget} · answer {budget.maxOutputTokens}
        </Text>
        <Text style={styles.switchHint}>tap to switch provider or model</Text>
        {trim !== null && messages.length > 0 && (trim.droppedMessages > 0 || trim.clippedToolResults > 0) ? (
          <Text style={styles.trimChip}>
            trimmed {trim.droppedMessages} msgs · {trim.beforeTokens}→{trim.afterTokens} tok
            {trim.clippedToolResults > 0 ? ` · ${trim.clippedToolResults} tool cut` : ''}
          </Text>
        ) : null}
      </Pressable>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(message) => message.id}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => <ChatMessage message={item} pricing={model.pricing} />}
        ListEmptyComponent={<Text style={styles.muted}>Nothing yet — ask something.</Text>}
        keyboardShouldPersistTaps="handled"
        onLayout={(event) => {
          viewportHeight.current = event.nativeEvent.layout.height;
        }}
        onScroll={trackScroll}
        scrollEventThrottle={100}
        onContentSizeChange={followNewest}
      />

      {/* The classifier names the failure class: a browser-blocked request is not
          a dead socket, and the raw message alone never says which. */}
      {error !== undefined ? (
        <Text style={styles.error}>{describeError(error, model.baseUrl, { freeModel: model.free })}</Text>
      ) : null}

      {/* The key is what the send button is waiting on, so the way out is on the
          same screen as the disabled button, not on a screen that replaced chat. */}
      {keyMissing ? (
        <Text style={styles.keyHint}>
          {model.label} needs an API key.{' '}
          <Link href="/settings" style={styles.keyHintLink}>
            Add it in Settings
          </Link>
        </Text>
      ) : null}

      {/* Pending attachments: shown before sending, each removable, because the
          bytes are already decoded and the user should see what is about to go. */}
      {attachments.length > 0 ? (
        <View style={styles.attachRow}>
          {attachments.map((attachment, index) => (
            <Pressable
              key={`${attachment.name}-${index}`}
              onPress={() => detach(index)}
              style={styles.attachThumb}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${attachment.name}`}
            >
              <Image source={{ uri: attachment.url }} style={styles.attachImage} resizeMode="cover" />
              <Text style={styles.attachName}>{attachment.name}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {pickError !== undefined ? (
        <Text style={styles.pickError}>{pickError}</Text>
      ) : null}

      <View style={styles.composer}>
        {/* Image input sits inside the card so it reads as part of the message,
            not as a toolbar. It is only drawn when the model declares vision: a
            greyed icon looks like a control that is broken, which reads worse
            than no control at all, and Android draws emoji in their own colour,
            so a disabled one never looks disabled. */}
        {vision ? (
          <Pressable
            onPress={attach}
            disabled={busy || picking || attachments.length >= MAX_IMAGES_PER_MESSAGE}
            style={({ pressed }) => [
              styles.attachButton,
              styles.attachButtonEnabled,
              pressed && !busy && !picking ? styles.attachButtonPressed : undefined,
            ]}
            accessibilityRole="button"
            accessibilityState={{
              disabled: busy || picking || attachments.length >= MAX_IMAGES_PER_MESSAGE,
            }}
            accessibilityLabel={
              attachments.length >= MAX_IMAGES_PER_MESSAGE
                ? `At most ${MAX_IMAGES_PER_MESSAGE} images per message`
                : 'Add images from the gallery'
            }
          >
            <Text style={styles.attachLabel}>{picking ? '…' : 'Image'}</Text>
          </Pressable>
        ) : null}
        <TextInput
          style={[styles.input, focused ? styles.inputFocused : undefined]}
          value={draft}
          onChangeText={setDraft}
          placeholder={busy ? 'Answering…' : keyMissing ? 'Waiting for an API key' : 'Message'}
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

      <ModelSwitchSheet
        open={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
        providers={providers}
        selectedSlug={selectedSlug}
        slug={switcherSlug}
        onSlugChange={setSwitcherSlug}
      />
    </View>
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
  /** Model + token budget, right under the app bar. Pressable: opens the switcher. */
  modelRow: {
    gap: 3,
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
    minHeight: 44,
  },
  modelRowPressed: {
    backgroundColor: theme.accentSoft,
    borderBottomColor: theme.accent,
  },
  /** Whole-session token totals, in the app bar so a long run is visible. */
  sessionUsage: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'monospace',
    color: theme.muted,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 6,
    /** Ellipsizes rather than wrapping: a wrapped mono line is what made the bar tall. */
    flexShrink: 1,
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
  /** The provider being configured — endpoint and credential belong to it. */
  providerLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.muted,
  },
  /** The model that answers, the line the chat is actually about. */
  modelLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.text,
  },
  modelLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  /** Same badge the model picker uses, so a free choice reads the same in both. */
  freeChip: {
    fontSize: 11,
    fontWeight: '700',
    color: theme.ok,
    backgroundColor: theme.okSoft,
    borderWidth: 1,
    borderColor: theme.ok,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  freeHint: {
    fontSize: 11,
    color: theme.muted,
  },
  budget: {
    fontSize: 11,
    color: theme.muted,
  },
  /** Says the row is a button, in a colour that is AA on the background. */
  switchHint: {
    fontSize: 11,
    fontWeight: '600',
    color: theme.accentText,
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
  /**
   * The transcript owns the leftover height. Without it the bar or the chip can
   * take the space and the list is left with a strip too small to show an answer.
   */
  list: {
    flex: 1,
  },
  /**
   * Waiting state, not a failure: amber, the colour the debug badge uses, so it
   * reads as "this needs something from you" rather than "the request broke".
   */
  keyHint: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 10,
    borderRadius: 8,
    backgroundColor: theme.warnSoft,
    borderWidth: 1,
    borderColor: theme.warn,
    color: theme.warn,
    fontSize: 13,
    lineHeight: 18,
  },
  keyHintLink: {
    color: theme.warn,
    fontWeight: '600',
    textDecorationLine: 'underline',
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
  /**
   * Floating card: rounded, inset from the screen edges, and lifted clear of the
   * keyboard by the container's padding (`useKeyboardPadding` + the bottom inset).
   * The hairline border was the old full-width row's divider; a card reads better
   * against the transcript, so it gets a border plus a soft shadow instead.
   */
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    marginHorizontal: 12,
    marginBottom: 10,
    padding: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    backgroundColor: theme.card,
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
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
  /**
   * Images waiting to be sent, above the card: they are message content, so they
   * read as part of what is about to go rather than as app chrome.
   */
  attachRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  attachThumb: {
    borderWidth: 1,
    borderColor: theme.borderStrong,
    borderRadius: 8,
    backgroundColor: theme.card,
    padding: 4,
    gap: 2,
  },
  attachImage: {
    width: 100,
    height: 74,
    borderRadius: 4,
  },
  attachName: {
    fontSize: 11,
    color: theme.muted,
  },
  /** A pick that could not be used: named, not dropped silently. */
  pickError: {
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
  /** One gallery button; drawn only for models that declare vision. */
  attachButton: {
    width: 52,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  attachButtonEnabled: {
    borderColor: theme.borderStrong,
    backgroundColor: theme.card,
  },
  attachButtonPressed: {
    borderColor: theme.accent,
    backgroundColor: theme.accentSoft,
  },
  /** Real text, not emoji: emoji ignore the colour, so the state would not show. */
  attachLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.text,
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
