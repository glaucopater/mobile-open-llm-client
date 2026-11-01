/**
 * Minor version bump for the app.
 *
 *   yarn bump            # 1.0.0 -> 1.1.0
 *   yarn bump --patch    # 1.0.0 -> 1.0.1 (escape hatch)
 *   yarn bump --dry-run  # print what would change, write nothing
 *
 * One run touches all three places that carry the number, so the version shown in
 * the app's top bar always matches the version the APK is built with:
 *   package.json      version
 *   app.json          expo.version          (versionName)
 *   app.json          expo.android.versionCode  (total bumps, so `install -r` and
 *                 EAS can tell builds apart)
 *   src/version.ts    APP_VERSION           (what the UI renders)
 *
 * `versionCode` only reaches the APK after `expo prebuild`, which regenerates
 * android/app/build.gradle from app.json — run prebuild before building.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PACKAGE_JSON = 'package.json';
const APP_JSON = 'app.json';
const VERSION_TS = 'src/version.ts';

function parseArgs(argv) {
  return {
    level: argv.includes('--patch') ? 'patch' : 'minor',
    dryRun: argv.includes('--dry-run'),
  };
}

/** `[major, minor, patch]` from a `x.y.z` string, tolerating `-alpha` suffixes. */
function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);

  if (!match) {
    throw new Error(`version "${version}" is not x.y.z`);
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function nextVersion(version, level) {
  const [major, minor, patch] = parseVersion(version);

  return level === 'patch' ? `${major}.${minor}.${patch + 1}` : `${major}.${minor + 1}.0`;
}

function readJson(path) {
  const text = readFileSync(path, 'utf8');

  return { text, data: JSON.parse(text) };
}

/** Rewrites JSON keeping the file's existing indentation and trailing newline. */
function writeJson(path, data, originalText) {
  const indent = originalText.includes('\t') ? '\t' : 2;
  const trailingNewline = originalText.endsWith('\n') ? '\n' : '';
  writeFileSync(path, `${JSON.stringify(data, null, indent)}${trailingNewline}`);
}

const { level, dryRun } = parseArgs(process.argv.slice(2));
const pkg = readJson(PACKAGE_JSON);
const app = readJson(APP_JSON);

if (pkg.data.version !== app.data.expo.version) {
  throw new Error(
    `package.json is ${pkg.data.version} but app.json is ${app.data.expo.version} — make them equal first`,
  );
}

const current = pkg.data.version;
const next = nextVersion(current, level);
const versionCode = (app.data.expo.android?.versionCode ?? 1) + 1;

pkg.data.version = next;
app.data.expo.version = next;
app.data.expo.android = { ...(app.data.expo.android ?? {}), versionCode };

const versionTs = readFileSync(VERSION_TS, 'utf8');

if (!/export const APP_VERSION = '[^']*';/.test(versionTs)) {
  throw new Error(`${VERSION_TS} has no "export const APP_VERSION = ..." line to update`);
}

const tsNext = versionTs.replace(/export const APP_VERSION = '[^']*';/, `export const APP_VERSION = '${next}';`);

if (dryRun) {
  console.log(`would bump ${level}: ${current} -> ${next}, android.versionCode -> ${versionCode}`);
} else {
  writeJson(PACKAGE_JSON, pkg.data, pkg.text);
  writeJson(APP_JSON, app.data, app.text);
  writeFileSync(VERSION_TS, tsNext);
  console.log(`bumped ${level}: ${current} -> ${next}, android.versionCode -> ${versionCode}`);
  console.log('run `npx expo prebuild --platform android --no-install` before building to apply versionCode');
}
