import type { ReactNode } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '../theme';
import { APP_ICON, APP_NAME, APP_VERSION } from '../version';

/**
 * The app's own top bar, used on every screen instead of the navigator header.
 *
 * The Stack renders no header (`headerShown: false`), so this bar carries the
 * icon, the name and the version the APK was built with, plus the screen's
 * actions. It has to pad itself against the status bar, because Android draws
 * edge-to-edge and nothing else reserves that space.
 */
export function AppHeader({ label, actions }: { label: string; actions?: ReactNode }) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={StyleSheet.compose(styles.bar, { paddingTop: insets.top + 8 })}
      accessibilityRole="header"
    >
      <Image source={APP_ICON} style={styles.icon} accessibilityLabel={`${APP_NAME} icon`} />
      <View style={styles.identity}>
        <Text style={styles.name}>{APP_NAME}</Text>
        <Text style={styles.detail}>
          v{APP_VERSION} · {label}
        </Text>
      </View>
      {actions !== undefined ? <View style={styles.actions}>{actions}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 8,
    backgroundColor: theme.bg,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  icon: {
    width: 28,
    height: 28,
    borderRadius: 7,
  },
  identity: {
    flex: 1,
    gap: 2,
  },
  name: {
    fontSize: 14,
    fontWeight: '700',
    color: theme.text,
  },
  /** AA against white; the version is a label, not a faint note. */
  detail: {
    fontSize: 11,
    fontWeight: '600',
    color: theme.accentText,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
});
