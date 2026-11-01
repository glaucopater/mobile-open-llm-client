import { StatusBar } from 'expo-status-bar';
import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { primeKeyCache } from '../core/keys';
import { useConfig } from '../store/config';
import { useConversation } from '../store/conversation';

export default function RootLayout() {
  const load = useConfig((state) => state.load);
  const providers = useConfig((state) => state.providers);
  const loadConversation = useConversation((state) => state.load);

  // Config comes from SQLite, keys from SecureStore; both must be readable
  // before the first chat render, because the agent is built synchronously.
  useEffect(() => {
    void load();
  }, [load]);

  // Some gateways (OpenCode Go) refuse a request without a session id, and the
  // stored transcript is keyed by that id, so both are read before the first
  // render: `useChat` takes its initial messages at mount, not later.
  useEffect(() => {
    void loadConversation();
  }, [loadConversation]);

  // One credential slot per provider; both screens read it synchronously, so the
  // cache has to be primed before the first request is built.
  useEffect(() => {
    void primeKeyCache(providers.flatMap((provider) => provider.apiKeyRef ?? []));
  }, [providers]);

  return (
    <SafeAreaProvider>
      {/* Every screen paints white and renders `AppHeader` itself, so the
          navigator header is off — the icon, name and version live in that bar —
          and the status bar icons have to be dark to stay readable on white. */}
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="settings" />
      </Stack>
    </SafeAreaProvider>
  );
}
