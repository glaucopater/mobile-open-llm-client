import { Link } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

export default function ChatScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Chat</Text>
      <Text style={styles.muted}>
        Streaming responses land in phase 2. Until then, set up providers here.
      </Text>
      <Link href="/settings" style={styles.link}>
        Configure providers
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    gap: 12,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
  },
  muted: {
    fontSize: 14,
    opacity: 0.6,
  },
  link: {
    fontSize: 16,
  },
});
