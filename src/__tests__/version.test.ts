import { describe, expect, it } from 'vitest';

import appConfig from '../../app.json';
import packageJson from '../../package.json';

import { APP_NAME, APP_VERSION } from '../version';

/**
 * The number in the top bar is only honest if it is the number the APK is built
 * with, so all three places `scripts/bump-version.mjs` writes are pinned here.
 */
describe('app version', () => {
  it('is the same string in package.json and app.json', () => {
    expect(appConfig.expo.version).toBe(packageJson.version);
  });

  it('is the string the top bar renders', () => {
    expect(APP_VERSION).toBe(packageJson.version);
  });

  it('uses the app name from app.json', () => {
    expect(APP_NAME).toBe(appConfig.expo.name);
  });

  it('is a plain x.y.z version', () => {
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('has an Android versionCode gradle can build', () => {
    expect(Number.isInteger(appConfig.expo.android.versionCode)).toBe(true);
    expect(appConfig.expo.android.versionCode).toBeGreaterThanOrEqual(1);
  });
});
