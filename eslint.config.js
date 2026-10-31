const { defineConfig, globalIgnores } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  globalIgnores(['node_modules/*', '.expo/*', 'coverage/*', 'dist/*', 'web-build/*']),
]);
