/**
 * Metro configuration.
 *
 * The web build needs one extra asset extension: `expo-sqlite` imports its SQLite WASM
 * (`wa-sqlite.wasm`) from the module that backs `openDatabaseAsync`, and Metro cannot
 * resolve that file by default. The web app never opens a database — config and
 * credentials go to localStorage, because Metro cannot serve SQLite's worker — but the
 * import is still bundled, so `wasm` has to be declared.
 */
const { getDefaultConfig } = require('@expo/metro-config');

const defaultConfig = getDefaultConfig(__dirname);

module.exports = {
  resolver: {
    assetExts: [...defaultConfig.resolver.assetExts, 'wasm'],
  },
};
