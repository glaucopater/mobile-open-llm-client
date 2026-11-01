import type { ReactNode } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DEBUG_BADGE_LABEL, debugDetail, isDebugBuild } from '../core/build-mode';
import { theme } from '../theme';
import { APP_ICON, APP_NAME, APP_VERSION } from '../version';

/**
 * The app's own top bar, used on every screen instead of the navigator header.
 *
 * The Stack renders no header (`headerShown: false`), so this bar carries the
 * icon, the name and the version the APK was built with, plus the screen's
 * actions. It has to pad itself against the status bar, because Android draws
 * edge-to-edge and nothing else reserves that space.
 *
 * A debug build says so: an amber DEBUG badge plus the client and dev server the
 * bundle came from, so a phone showing a dev client can never be mistaken for
 * the release APK.
 */
export function AppHeader({ label, actions }: { label: string; actions?: ReactNode }) {
  const insets = useSafeAreaInsets();
  const debug = isDebugBuild();

  return (
    <View
      style={StyleSheet.compose(styles.bar, { paddingTop: insets.top + 8 })}
      accessibilityRole="header"
    >
      <Image source={APP_ICON} style={styles.icon} accessibilityLabel={`${APP_NAME} icon`} />
      <View style={styles.identity}>
        <View style={styles.nameRow}>
          <Text style={styles.name}>{APP_NAME}</Text>
          {debug ? (
            <Text
              style={styles.debugBadge}
              accessibilityLabel="Debug build: this bundle is served by a dev server"
            >
              {DEBUG_BADGE_LABEL}
            </Text>
          ) : null}
        </View>
        <Text style={styles.detail}>
          v{APP_VERSION} · {label}
        </Text>
        {debug ? <Text style={styles.debugDetail}>{debugDetail()}</Text> : null}
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
  /** Wraps rather than squeezing the actions when the badge takes room. */
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  name: {
    fontSize: 14,
    fontWeight: '700',
    color: theme.text,
  },
  /** Amber, not accent: a debug build must not read like a normal control. */
  debugBadge: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    color: theme.warn,
    backgroundColor: theme.warnSoft,
    borderWidth: 1,
    borderColor: theme.warn,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  /** AA against white; the version is a label, not a faint note. */
  detail: {
    fontSize: 11,
    fontWeight: '600',
    color: theme.accentText,
  },
  /** Which client is running the bundle and which machine is serving it. */
  debugDetail: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: theme.warn,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
});
