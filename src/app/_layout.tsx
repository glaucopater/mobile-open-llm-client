import { StatusBar } from 'expo-status-bar';
import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { primeKeyCache } from '../core/keys';
import { loadConversationSessionId } from '../core/session';
import { useConfig } from '../store/config';

export default function RootLayout() {
  const load = useConfig((state) => state.load);
  const models = useConfig((state) => state.models);

  // Config comes from SQLite, keys from SecureStore; both must be readable
  // before the first chat render, because the agent is built synchronously.
  useEffect(() => {
    void load();
  }, [load]);

  // Some gateways (OpenCode Go) refuse a request without a session id, so the
  // id is read from SQLite before the first request rather than minted per call.
  useEffect(() => {
    void loadConversationSessionId();
  }, []);

  useEffect(() => {
    void primeKeyCache(models.flatMap((model) => model.apiKeyRef ?? []));
  }, [models]);

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
