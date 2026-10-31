/**
 * Config plugin: allow cleartext (plain http) traffic in release builds.
 *
 * Android 9+ blocks cleartext by default. Debug builds already opt in through
 * the generated debug manifest, but a standalone release APK must reach LAN
 * OpenAI-compatible servers (`http://192.168.x.x:11434/v1`, llama.cpp, vllm,
 * mlx on the local network), which are plain http. Remote https providers are
 * unaffected.
 */
const { AndroidConfig, withAndroidManifest } = require('@expo/config-plugins');

module.exports = function androidCleartext(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);

    app.$['android:usesCleartextTraffic'] = 'true';

    return cfg;
  });
};
