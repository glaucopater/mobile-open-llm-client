import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Constants from 'expo-constants';

import {
  DEBUG_BADGE_LABEL,
  debugDetail,
  debugEnvironmentLabel,
  debugHostUri,
  isDebugBuild,
} from '../core/build-mode';
import { contrastRatio, theme } from '../theme';

/** AA for text; the badge border also has to be visible on the app bar. */
const TEXT_MIN = 4.5;
const UI_MIN = 3;

/** Stands in for the real bundle flag, which the module reads as a global. */
const savedDevFlag = (globalThis as { __DEV__?: boolean }).__DEV__;

/** `expoConfig` is nullable, never undefined, matching the real module. */
function withExpoConfig(hostUri: string | undefined, assertion: () => void): void {
  const stored = Constants.expoConfig;

  Constants.expoConfig =
    hostUri === undefined
      ? null
      : ({ name: 'Open LLM Client', slug: 'app', hostUri } as unknown as typeof Constants.expoConfig);

  try {
    assertion();
  } finally {
    Constants.expoConfig = stored;
  }
}

beforeEach(() => {
  (globalThis as { __DEV__?: boolean }).__DEV__ = false;
});

afterEach(() => {
  (globalThis as { __DEV__?: boolean }).__DEV__ = savedDevFlag;
});

describe('isDebugBuild', () => {
  it('follows the bundle flag, not the app name', () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    expect(isDebugBuild()).toBe(true);

    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    expect(isDebugBuild()).toBe(false);
  });
});

describe('debug labels', () => {
  it('names a debug build with no dev server attached', () => {
    // The test stub reports `standalone`, and node runs are not a browser.
    expect(debugEnvironmentLabel()).toBe('debug APK');
    expect(debugHostUri()).toBeUndefined();
    expect(debugDetail()).toBe('debug APK');
  });

  it('names the dev server that is serving the bundle', () => {
    withExpoConfig('192.168.178.87:8081', () => {
      expect(debugHostUri()).toBe('192.168.178.87:8081');
      expect(debugDetail()).toContain('debug APK · 192.168.178.87:8081');
    });
  });

  it('ignores an empty host', () => {
    withExpoConfig('', () => {
      expect(debugHostUri()).toBeUndefined();
      expect(debugDetail()).toBe('debug APK');
    });
  });

  it('is a badge no one mistakes for the version, and stays readable', () => {
    expect(DEBUG_BADGE_LABEL).toBe('DEBUG');

    expect(contrastRatio(theme.warn, theme.warnSoft)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrastRatio(theme.warn, theme.bg)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrastRatio(theme.warn, theme.warnSoft)).toBeGreaterThanOrEqual(UI_MIN);
  });
});
