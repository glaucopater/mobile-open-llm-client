/**
 * Stand-in for `expo-constants` in tests: it reads native runtime values that
 * node has none of. The shape mirrors the real module so `core/build-mode.ts`
 * exercises its fallbacks instead of a stub that always reports "no constants".
 */
export enum ExecutionEnvironment {
  StoreClient = 'storeClient',
  Bare = 'bare',
  Standalone = 'standalone',
}

const Constants = {
  executionEnvironment: ExecutionEnvironment.Standalone,
  expoConfig: undefined,
  expoGoConfig: null,
  debugMode: false,
};

export default Constants;
