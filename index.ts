// Custom entry point: install runtime polyfills before Expo Router registers
// the app, because the AI SDK needs web streams and structuredClone, neither of
// which Hermes provides.
import './src/polyfills';

import 'expo-router/entry';
