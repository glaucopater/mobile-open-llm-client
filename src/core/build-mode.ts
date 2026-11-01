/**
 * Whether the running bundle is a debugging build, and what to say about it.
 *
 * `__DEV__` is set by Metro for anything served by the dev server — a dev-client
 * build on a device, Expo Go, or the web dev target — and is compiled to `false`
 * in a release APK and in a production web export. So it is the flag that says
 * "this build is attached to a debugger", without guessing from the app name.
 *
 * `expo-constants` then names the client that is running the bundle and the dev
 * server serving it, which is what makes the badge useful on a phone: it shows
 * which machine the app is talking to.
 */
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';

/** Reads `__DEV__` at call time, so a test can flip the flag around an assertion. */
export function isDebugBuild(): boolean {
  return __DEV__;
}

/** The badge in the app bar: unmistakable, and never mistaken for the version. */
export const DEBUG_BADGE_LABEL = 'DEBUG';

/** Which client is running the bundle. Unknown values fall back to a plain label. */
export function debugEnvironmentLabel(): string {
  if (Platform.OS === 'web') {
    return 'web dev';
  }

  switch (Constants.executionEnvironment) {
    case ExecutionEnvironment.StoreClient:
      // `expoGoConfig` is only filled when Expo Go itself is running the bundle.
      return Constants.expoGoConfig != null ? 'Expo Go' : 'dev client';
    case ExecutionEnvironment.Bare:
      return 'bare build';
    case ExecutionEnvironment.Standalone:
      // A standalone binary that still has __DEV__ set: built with a debug profile.
      return 'debug APK';
    default:
      return 'dev build';
  }
}

/** The dev server serving this bundle, as `host:port`; absent when there is none. */
export function debugHostUri(): string | undefined {
  const hostUri = Constants.expoConfig?.hostUri;

  return typeof hostUri === 'string' && hostUri.length > 0 ? hostUri : undefined;
}

/** One line under the version: what kind of debug build this is, and its server. */
export function debugDetail(): string {
  const host = debugHostUri();

  return host === undefined ? debugEnvironmentLabel() : `${debugEnvironmentLabel()} · ${host}`;
}
