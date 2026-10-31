/** @type {import('jest').Config} */
module.exports = {
  preset: '@react-native/jest-preset',
  moduleNameMapper: {
    // expo/fetch requires the native runtime; tests swap in their own fetch.
    '^expo/fetch$': '<rootDir>/src/__mocks__/expo-fetch.ts',
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|ai|@ai-sdk/.*)/)',
  ],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  coveragePathIgnorePatterns: ['/node_modules/', '/__tests__/'],
};
