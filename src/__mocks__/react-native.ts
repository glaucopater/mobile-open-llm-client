/**
 * Vitest stand-in for `react-native`. The real module boots the native runtime
 * through expo-modules-core, which node does not have; the suites only need the
 * platform branches, so `Platform.OS` stays a native platform and the web paths
 * are exercised by their own tests instead.
 */
export type PlatformOSType = 'ios' | 'android' | 'web' | 'macos' | 'windows';

/** Native on purpose: `keys.ts`, `image.ts` and `network-error.ts` all take the
 *  native branch here, which is the branch the shipped APK runs. */
export const Platform = {
  OS: 'ios' as PlatformOSType,
  select<T>(styles: Partial<Record<PlatformOSType, T>>): T | undefined {
    return styles[Platform.OS];
  },
};

export default { Platform };
