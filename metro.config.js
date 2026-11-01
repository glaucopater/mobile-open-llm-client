/**
 * Metro configuration.
 *
 * The web build needs one extra asset extension: `expo-sqlite` imports its SQLite WASM
 * (`wa-sqlite.wasm`) from the module that backs `openDatabaseAsync`, and Metro cannot
 * resolve that file by default. The web app never opens a database — config and
 * credentials go to localStorage, because Metro cannot serve SQLite's worker — but the
 * import is still bundled, so `wasm` has to be declared.
 *
 * `resolver.blockList` also keeps the generated native output out of the dev server.
 * Metro feeds blockList into `metro-file-map` as its crawler `ignorePattern`
 * (`node_modules/metro/src/node-haste/DependencyGraph/createFileMap.js`), so after
 * `expo prebuild` the server no longer crawls `android/` — 849 MB across 1301 files of
 * Gradle intermediates, CMake objects and a copy of the RN bundle. That crawl is what
 * made `yarn web` hang on page requests and eventually die with a Node heap OOM. The
 * patterns are anchored to the project root: `dist` and `build` appear inside many
 * `node_modules` packages, and a bare name would block real modules.
 */
const { getDefaultConfig } = require('@expo/metro-config');

const defaultConfig = getDefaultConfig(__dirname);

/** Directory separators as they appear in absolute paths on Windows and POSIX. */
const SEP = '[\\\\/]';

/** Escapes a filesystem path for use inside a RegExp. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Continuous-native-generation output and build artefacts, never JS sources. */
const GENERATED_DIRS = ['android', 'ios', 'dist', 'web-build', '.expo', '.kotlin'];

module.exports = {
  resolver: {
    assetExts: [...defaultConfig.resolver.assetExts, 'wasm'],
    blockList: new RegExp(
      `${escapeRegExp(__dirname)}${SEP}(?:${GENERATED_DIRS.join('|')})${SEP}`,
    ),
  },
};
