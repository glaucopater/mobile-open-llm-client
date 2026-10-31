import { ScrollView, StyleSheet, Text, View } from 'react-native';

const DIALECTS = [
  { id: 'openai', label: 'OpenAI', note: 'Chat Completions / Responses' },
  { id: 'anthropic', label: 'Anthropic', note: 'Messages API' },
  { id: 'gemini', label: 'Gemini', note: 'generateContent' },
  { id: 'local', label: 'Local server', note: 'OpenAI-compatible baseURL (Ollama, llama.cpp, LM Studio)' },
];

export default function SettingsScreen() {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Providers</Text>
      {DIALECTS.map((dialect) => (
        <View key={dialect.id} style={styles.row}>
          <Text style={styles.label}>{dialect.label}</Text>
          <Text style={styles.note}>{dialect.note}</Text>
        </View>
      ))}
      <Text style={styles.muted}>
        Key storage (expo-secure-store) and base URL profiles land in phase 3.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 24,
    gap: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
  },
  row: {
    gap: 4,
  },
  label: {
    fontSize: 16,
    fontWeight: '500',
  },
  note: {
    fontSize: 13,
    opacity: 0.6,
  },
  muted: {
    fontSize: 14,
    opacity: 0.6,
    marginTop: 8,
  },
});
