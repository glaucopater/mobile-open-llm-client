import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** A `src/__mocks__` module, resolved from this file's own directory. */
function mock(name: string): string {
  return fileURLToPath(new URL(`./src/__mocks__/${name}`, import.meta.url));
}

const assetStub = mock('asset.ts');

/**
 * Vitest runs the suites in node, so every module that needs the native runtime
 * or the bundler is swapped for a stand-in. Unlike jest, nothing needs
 * `transformIgnorePatterns`: ESM (`ai`, `@ai-sdk/*`) is imported directly.
 */
export default defineConfig({
  plugins: [
    {
      // Bundled images are relative specifiers, which `resolve.alias` does not
      // rewrite; Metro resolves them, node has no loader for them.
      name: 'asset-stub',
      enforce: 'pre',
      resolveId(id: string) {
        return /\.(png|jpe?g|gif|svg)$/.test(id) ? assetStub : null;
      },
    },
  ],
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: mock('react-native.ts') },
      { find: /^expo\/fetch$/, replacement: mock('expo-fetch.ts') },
      { find: /^expo-constants$/, replacement: mock('expo-constants.ts') },
      { find: /^expo-image-picker$/, replacement: mock('expo-image-picker.ts') },
      // `core/tools.ts` reads device info and the documents sandbox; both modules
      // boot Expo's core, which needs Metro's bundle machinery.
      { find: /^expo-device$/, replacement: mock('expo-device.ts') },
      { find: /^expo-file-system$/, replacement: mock('expo-file-system.ts') },
    ],
  },
  test: {
    environment: 'node',
    // Metro's `__DEV__` has to exist before an Expo module is imported (see the
    // setup file), so it is applied before each suite's own imports run.
    setupFiles: [fileURLToPath(new URL('./src/__tests__/setup.ts', import.meta.url))],
    include: ['src/__tests__/**/*.test.ts', 'src/__tests__/**/*.test.tsx'],
  },
});
