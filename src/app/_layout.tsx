import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { primeKeyCache } from '../core/keys';
import { useConfig } from '../store/config';

export default function RootLayout() {
  const load = useConfig((state) => state.load);
  const models = useConfig((state) => state.models);

  // Config comes from SQLite, keys from SecureStore; both must be readable
  // before the first chat render, because the agent is built synchronously.
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void primeKeyCache(models.flatMap((model) => model.apiKeyRef ?? []));
  }, [models]);

  return (
    <SafeAreaProvider>
      <Stack>
        <Stack.Screen name="index" options={{ title: 'Chat' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      </Stack>
    </SafeAreaProvider>
  );
}
