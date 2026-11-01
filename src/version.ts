/**
 * App identity shown in the top bar of every screen.
 *
 * `scripts/bump-version.mjs` rewrites this file together with the version in
 * `package.json` and `app.json`, so the number on screen is the number the APK is
 * built with. `src/__tests__/version.test.ts` fails if the three drift apart.
 */
import icon from '../assets/icon.png';

export const APP_NAME = 'Open LLM Client';
export const APP_VERSION = '1.2.0';
export const APP_ICON = icon;
