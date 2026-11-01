# mobile-open-llm-client — Build Plan

A React Native app that acts as an LLM agent + harness on-device, talking to remote APIs or local
servers through OpenAI / Anthropic / Gemini dialects.

## Locked decisions
- **Framework**: Expo SDK 58 → React Native 0.88 (latest stable, Oct 2026), React 19.3, New Architecture only, TypeScript strict API (default since 0.87). Development builds via `npx expo run:ios|android`; Expo Go will not work once native modules land.
- **AI layer**: Vercel AI SDK v7 (`ai`, `@ai-sdk/react`) with `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`, `zod/v4`.
- **"Local LLM" for v1**: a local server on the LAN (Ollama, llama.cpp server, LM Studio, vLLM) reached through an OpenAI-compatible `baseURL`. No native modules needed for this tier.
- **Keys**: stored on device in `expo-secure-store`; the app calls providers directly (personal/local-first app; the exposure risk is documented in the README).
- **Tools in first working version**: core device tools. On-device inference (`llama.rn`, Apple Foundation Models, Android ADK Gemini Nano) is a later phase behind the same provider registry.

## Prerequisite (done)
This machine's Volta shims are broken: `npm`, `npx`, and `pnpm` fail with missing corepack/Volta modules; only `yarn 4.13` works. Node is 22.21.1 (Expo 58 requires ≥22.13 ✓). **Decision: the project uses Yarn 4.13** (`packageManager` in `package.json`, `nodeLinker: node-modules` in `.yarnrc.yml` — the linker name is `node-modules`, not `node_modules`). Run Expo CLI as `yarn expo <command>`.

## Dependencies
```
expo@~58, react-native@0.88, react@19.3, react-dom@19.3 (expo-router's web peer), typescript, zod@4
ai, @ai-sdk/react, @ai-sdk/openai, @ai-sdk/anthropic, @ai-sdk/google, @ai-sdk/openai-compatible
@ungap/structured-clone, web-streams-polyfill   # AI SDK polyfills for Hermes
expo-router, expo-constants, expo-linking, expo-secure-store, expo-sqlite,
expo-file-system, expo-notifications, expo-device,
react-native-safe-area-context, react-native-screens,
react-native-gesture-handler, react-native-reanimated, react-native-worklets,
zustand
dev: @babel/core@7 (Expo pins 7.x; babel 8 breaks the preset), @react-native/metro-config,
     @react-native/jest-preset, jest, eslint, eslint-config-expo, expo-doctor,
     @types/ungap__structured-clone, maestro (later)
not installed yet: react-native-blob-util (phase 4), react-native-markdown-display
    (its peer set conflicts with expo-router's web deps — revisit per phase)
later phase: @react-native-ai/llama + llama.rn, @react-native-ai/apple, @react-native-ai/adk
web dev target: react-native-web@0.21, @expo/metro-runtime (npx expo install)
```

## Web target (dev/test only, never shipped)
```
yarn web        # expo start --web, app at http://localhost:8081
yarn web:check  # node scripts/web-ui-check.mjs <route> --out=<png> [--type=<text>] [--click-text=<label>]
                # drives headless Edge over CDP: waits for mount, dumps console, phone-sized shot
                # default --out is $TMP/web-check.png, so the repo stays clean

Limits found by running it, not assumed:
- expo-sqlite cannot run on web: its WASM worker is fetched from
  `new URL('./worker', location.href)`, which Metro answers with index.html, and the
  OPFS VFS needs COOP/COEP headers the dev server cannot add. Config therefore goes to
  localStorage via src/store/db.ts + src/store/webStorage.ts (memory fallback when
  storage is blocked). metro.config.js adds `wasm` to assetExts so the import still bundles.
- expo-secure-store ships an empty web module, so src/core/keys.ts falls back to
  localStorage there (plaintext, web build only).
- expo-file-system has no web implementation: read_file/write_file report
  "File tools are not available in the web build". get_device_info works (ua-parser).
- react-native-web emits no keyboardDidShow/DidHide, so keyboard avoidance can only be
  verified on a real device; the web view verifies layout, contrast and round trips.
- LAN Ollama works from the browser at http://localhost:11434/v1 (Ollama allows the
  localhost origin by default), streaming and reasoning included.
- Dev-server memory: Metro crawls the project root to build its file map, so once
  `expo prebuild` creates android/ the server walked 849 MB across 1301 files of Gradle
  and CMake output on every start. Page requests hung and a long-lived server hit Node's
  ~4 GB heap ceiling ("Reached heap limit Allocation failed"). metro.config.js sets
  `resolver.blockList`, which Metro feeds to metro-file-map as the crawler's
  `ignorePattern` (node_modules/metro/src/node-haste/DependencyGraph/createFileMap.js),
  so android/, ios/, dist/, web-build/, .expo/ and .kotlin/ are never crawled. The pattern
  is anchored to the project root, because bare `dist`/`build` names also match files
  inside node_modules and would break real imports. Measured after the fix: /settings
  answers at once, a web bundle is 8 MB in ~3.4s, and RSS stays 820-880 MB across six
  invalidate-and-rebundle rounds — the growth was the crawl, not a leak, so no heap bump
  is configured. (`env VAR=... cmd` is not a yarn builtin on Windows; set
  `$env:NODE_OPTIONS` in PowerShell if headroom is ever needed.)
  The fix was then checked against churn rather than only against startup: 1500 new files
  written inside `android/` leave the bundle byte-identical (8,411,893 bytes) and served in
  3.9s with Metro's RSS flat at ~857 MB, where the same churn cost a 434s bundle before the
  blockList existed.
- `scripts/web-ui-check.mjs` hung, then reported `mounted after 0 nodes`, for reasons
  unrelated to the app: a leftover Edge from an earlier run keeps the shared profile
  directory locked, and a second Edge on a locked profile never opens its debugging port.
  Each run now gets its own profile dir and its own port (`9222 + pid % 400`), every CDP
  round trip is bounded by `WEB_CHECK_TIMEOUT` (default 60s), Edge is killed with
  `taskkill /T /F` so its children cannot hold the lock, and the mount count is reported as
  both `#root` descendants and `body` children, so 0 can never be read as a successful
  mount. Measured after the fix: `/settings` mounts 62 nodes, `/` mounts 85, and
  `--click-text=Settings` navigates Chat to Settings.
- Favicon: `app.json`'s `web.favicon` points at assets/favicon.png, and
  `npx expo export --platform web` converts it into a real multi-size favicon.ico
  (checked: ICO header 00 00 01 00, 3 entries at 16x16) plus
  `<link rel="icon" href="/favicon.ico">` in dist/index.html. The dev server does NOT
  inject that link, so the tab icon is blank while `yarn web` runs — expected, not a
  broken asset.
```

## Version and on-device checks

```
yarn bump          # 1.0.0 -> 1.1.0 (minor bump; --patch for 1.0.1, --dry-run to preview)
                   # writes package.json, app.json expo.version, app.json expo.android.versionCode
                   # and src/version.ts APP_VERSION in one go; src/__tests__/version.test.ts
                   # fails if the three ever drift apart
npx expo prebuild --platform android --no-install   # versionCode only reaches the APK here
yarn device:e2e    # node scripts/device-e2e.mjs — black-box checks on the installed APK
                   # [--device=<serial>] [--only=<name>] [--shots=<dir>] [--wait=<ms>] [--trace]
                   # --trace prints every tap and the labelled nodes of each dump
```

- **Version in the UI**: every screen renders `AppHeader` (icon + `Open LLM Client` +
  `v<version>` + that screen's actions) instead of the navigator header
  (`headerShown: false`), so the bar pads itself against the status bar inset — nothing
  else reserves that space once the header is gone. `src/version.ts` is the display
  source; `scripts/bump-version.mjs` is the only writer.
- **Device e2e**: taps are driven by `adb shell input`, and what is asserted is what the
  system drew: `uiautomator` bounds for the composer and Settings fields, the keyboard's
  top edge from `dumpsys window` (`mType=ime` → `mInsetsHint` bottom, keyboard top =
  display height − inset), and keyboard visibility from `dumpsys input_method`
  (`mInputViewStarted`). The crash buffer (`logcat -b crash`) is checked last. Screenshots
  per check land in the temp dir. This is the only place the keyboard behaviour can be
  verified — react-native-web emits no keyboard events, and unit tests cannot see whether
  a view sits behind the IME. Passed 9/9 on v1.2.0 (versionCode 3).
- **Device e2e pitfalls, learned by running it**: a single fixed wait after a tap is too
  short, so checks poll the dump (`waitFor`) instead of sleeping once; `uiautomator` only
  reports nodes that are visible, so content below the fold needs a swipe (`scrollDown`,
  used by `settings-field-reveal`); `--only=<name>` must not depend on a navigation done by
  an earlier check, hence `gotoSettings`/`gotoChat`; and `tap()` accepts a coordinate pair,
  a point or a node, because passing a point to an `(x, y)` signature sent `NaN NaN`, which
  `adb` ignored — every Settings check then failed against the Chat screen; and `adb install`
  leaves a notification that can leave the shade open, so `launch` broadcasts
  `CLOSE_SYSTEM_DIALOGS` and retries, otherwise `mCurrentFocus` stays `NotificationShade`
  and no check can see the app.
- **More pitfalls from a run that failed 7/9 on v1.3.0**: an incoming WhatsApp message
  expanded into the shade mid-run, so the dump read a chat transcript instead of the app and
  the following tap landed in system UI — every check after it failed against the launcher.
  Wireless adb (`mDNS TLS`) then dropped to `device offline` / `error: closed` and the
  device vanished from `adb devices`, killing the run. `check()` now calls
  `ensureForeground()` first (collapse the shade with `cmd statusbar collapse`, re-`am start`
  until `mCurrentFocus` is ours), `adb()` retries through `wait-for-device`, and keyboard
  checks go through `tapComposerUntilKeyboardUp()`: `ReactEditText` only summons the IME on
  a click in touch mode (`requestFocusProgrammatically` checks `isInTouchMode`), so a tap
  measured `mInputStarted=true` with `mShowInputRequested=false` and no keyboard until a
  second tap followed, and a `KEYCODE_BACK` sent while the keyboard is down navigates out of
  the app instead of hiding it.

## Architecture
```
src/
  core/     ModelDescriptor { id, dialect, baseUrl, apiKeyRef, capabilities,
              contextWindow, pricing, source: remote | local-server | on-device }
            dialect adapters: openai-chat | openai-responses | anthropic-messages
                              | gemini-generate-content | openai-compatible
            providerRegistry ("provider:model" strings), capability gate, error normalization
  agent/    harness: system prompt presets/skills, tool registry + per-tool approval policy,
            multi-step loop with maxSteps, AbortSignal + checkpoint resume,
            retry/fallback across models, per-turn usage + cost metering,
            context budget + summarization compaction
  tools/    fs.read/write/list · http.fetch · clipboard · device.info · location
            · sqlite.query · notify
  store/    sqlite: sessions, messages (AI SDK UI parts), tool_calls, usage_events,
            providers, models; JSON export/import per session
  ui/       chat (stream, tool cards, approval sheet), sessions list,
            settings/providers/keys, trace inspector
```

## Phases and acceptance criteria
1. **Env + scaffold** — repair package manager, `create-expo-app` on SDK 58, dev build scripts, strict TS, eslint, jest, CI running `typecheck + test + expo-doctor`.
   *Done when `expo run:android` and `expo run:ios` boot a blank screen on emulator and simulator.*
   **Status: toolchain done** — Yarn 4.13 + node-modules linker, SDK 58 scaffold with Expo Router, strict TS, flat eslint config, jest on `@react-native/jest-preset`, CI workflow. `typecheck`, `lint`, `test` (3 passing), `expo-doctor` (20/20) and `expo export --platform ios` (1150 modules) all pass. Native boot not verified: no Android emulator run yet on this host, iOS needs macOS or an EAS build.
2. **Streaming chat** — `useChat` + `DefaultChatTransport({ fetch: expoFetch })`, OpenAI-compatible provider pointed at a remote endpoint and a local server, polyfills wired in.
   *Done when tokens render incrementally on both platforms.*
    **Status: verified on device** — `useChat` + `DirectChatTransport({ agent })` (no HTTP route), `expo/fetch` behind `src/core/http.ts`, dialect providers, the context-window guard in `src/core/context.ts`, and the chat UI in `src/app/index.tsx`. Tokens render incrementally on the Android emulator and on a real phone (Android 16, arm64-v8a); aborting mid-turn leaves no orphan tool results. The oversized-turn case raises `ContextOverflowError` with the prompt budget instead of a server 400.
3. **Multi-dialect + settings** — Anthropic and Gemini adapters behind the registry, SecureStore key storage, per-provider base-URL profiles, model catalog with capability badges, per-turn token/cost readout.
   *Done when switching OpenAI ↔ Anthropic ↔ Gemini requires no UI change.*
    **Status: code landed, dialect switching verified** — Anthropic + Gemini + `openai-compatible` adapters behind one registry, SecureStore keys (`src/core/keys.ts`), and editable base URL / model id / context window / capability chips in `src/app/settings.tsx`. Remote↔LAN toggling and the auth style per dialect (`Authorization: Bearer` / `x-api-key` / query param) were probed on the emulator; remote providers still need a real key on the phone to be verified end to end.
4. **Agent loop + device tools** — tool calling verified per dialect (parallel-tool behaviour differs between OpenAI and Anthropic), approval sheet, tool-call cards with input/output/errors, trace inspector.
   *Done when "save a note to a file and read it back" completes across tool rounds.*
    **Status: verified on device** — `ToolLoopAgent` with `isStepCount(MAX_STEPS)`, device tools (`get_device_info`, sandboxed `read_file` / `write_file` under `Paths.document`), tool cards per step in the transcript. `write_file` → `read_file` round trips complete on the emulator and on the phone, including a 16 KB file that the guard clips on the next turn. Approval sheet and trace inspector not built yet.
5. **Persistence + resilience** — session list, reload after app kill, partial assistant messages saved on abort, JSON export/import.
   *Done when an interrupted stream is recoverable.*
6. **Local/on-device tier** — `@react-native-ai/llama` + `llama.rn` GGUF download manager (HuggingFace, progress, storage budget), GPU-layer detection with CPU fallback, Apple Foundation Models and ADK Gemini Nano as zero-download built-ins, capability-gated offline mode.
7. **Polish** — context compaction, MCP client, dark theme and accessibility, release builds (Android R8 is on by default in SDK 58; iOS 27 scene lifecycle), EAS dev builds + OTA updates, README and provider setup docs.

## Constraints to respect from day 1
- **RN 0.88 removals**: no `InteractionManager` (use `requestIdleCallback`), no `Touchable` root export, no `NativeMethods` types, no `ImageBackground` (use a `View` with an absolutely positioned `Image`); refs typed as `ViewInstance` / `TextInputInstance`.
- **Streaming**: always `expo/fetch`, never the default fetch (it buffers). AI SDK on RN needs `structuredClone` and `TextEncoderStream`/`TextDecoderStream` polyfills; `web-streams` warnings are known and harmless.
- **Local servers**: Android emulator cannot reach host `localhost` → use `10.0.2.2` or `adb reverse`; iOS simulator uses `localhost`. Android needs cleartext HTTP enabled for LAN servers — debug builds get it from the generated debug manifest, release builds from the `plugins/android-cleartext` config plugin registered in `app.json`.
- **iOS builds** require a macOS host. This machine is Windows, so iOS verification is deferred unless a Mac is available or EAS cloud builds are used.
- **Windows native builds**: `react-native-worklets` compiles C++ into CMake object paths longer than 260 chars, which ninja 1.10.2 (bundled with SDK `cmake;3.22.1`) cannot create — it fails with `mkdir(...): No such file or directory`. Fixed on this host by installing `cmake;3.31.6` (ninja 1.12.1) and uninstalling `cmake;3.22.1`; deleting the stale `node_modules/*/android/.cxx` directories forces CMake to reconfigure against the new toolchain. `eas build` is unaffected.
- **Standalone APK (no dev server)**: `npx expo prebuild --platform android` then `android/gradlew assembleRelease --max-workers=1` embeds the Hermes bundle, so the release APK boots without Metro and without the dev-launcher menu. The template signs release with the debug keystore, which is fine for sideloading to your own devices; use `eas build --profile production` for a distributable build.
- **One ABI**: the `expo-build-properties` plugin in `app.json` sets `android.buildArchs: ["arm64-v8a"]`, which prebuild writes into `android/gradle.properties` as `reactNativeArchitectures=arm64-v8a`. The phone is arm64-v8a, so the other three ABIs were dead weight: measured here, the release APK went from 101 MB to 34.5 MB and `assembleRelease` from 13m to 8m22s. `buildArchs` is **not** an `ExpoConfig` key — putting it under `android` in `app.json` is silently ignored, and `gradle.properties` keeps all four ABIs (`armeabi-v7a,arm64-v8a,x8,x86_64`). Re-add `x86_64` there if an emulator is ever needed.
- **Edge-to-edge keyboard on Android**: SDK 53+ draws edge-to-edge, which makes `windowSoftInputMode="adjustResize"` a no-op — the keyboard overlays the window instead of shrinking it, so the Expo docs' `behavior: undefined` on Android leaves the composer covered. `KeyboardAvoidingView behavior="padding"` is *also* wrong here: RN's native payload reports `screenY` as the visible-frame bottom (`ReactRootView.checkForKeyboardEvents`), which only equals the keyboard's top after a resize, so KAV under-pads by about the system-bar height. Measured on the phone: keyboard top y=1529, IME inset 883px, composer bottom still y=1770. Both screens therefore pad by `endCoordinates.height` + the safe-area bottom inset (`src/hooks/useKeyboardPadding.ts`; the height is the IME inset *minus* the system bars, while the keyboard also covers the nav bar, which left the composer 31px short), and `useKeyboardAwareScroll` reveals focused fields inside the padded viewport. Verified with `yarn device:e2e` bounds, not by trusting the docs.
- **App icon**: `assets/icon.png`, `splash-icon.png`, the three `android-icon-*.png` adaptive layers and `favicon.png` are custom (chat bubble + LAN link mark in `theme.accent` #0B5C86 on white); `app.json`'s `adaptiveIcon.backgroundColor` is `#FFFFFF`. The layers are drawn with GDI+ — every shape is a filled path (ring, capsule spokes, dot ellipses), because `System.Drawing.Drawing2D.Pen` does not resolve under PowerShell. Changing the art means re-running the generator and re-prebuilding: icons are native resources, so a JS-only update does not show in the launcher.
- **Composer is a floating card**: rounded, inset 12dp from the screen edges, bordered
  (`theme.borderStrong`) with a soft shadow, lifted clear of the keyboard by the
  container's padding. `device:e2e` asserts the inset (`composer-card`) and that its
  bottom lands above the keyboard (`keyboard-composer`).
- **Phone install without a cable**: Developer options → Wireless debugging → `adb pair <ip>:<pairingPort> <code>`; adb then discovers the connect endpoint over mDNS (`adb mdns services`), so no port needs to be typed. Release builds are not debuggable, so `adb shell run-as` cannot inspect app files — verify file tools through the model instead.
- **LAN servers on a real phone**: bind the server to `0.0.0.0` and set the profile's base URL to the host's LAN address (the phone has no `adb reverse` equivalent once wireless adb drops). Windows' firewall app rules decide whether the phone may connect; check `Get-NetFirewallRule -DisplayName '<server>'`.
- **llama.rn** (phase 6) needs a development build plus an Expo config plugin, large RAM headroom, and per-device Metal/OpenCL support checks — gate it behind runtime capability probes.

## Open questions
- ~~App name / bundle identifier and repository license~~ — settled: MIT license (the Expo template's MIT `LICENSE` is kept, `package.json` declares `license: MIT`), app stays "Open LLM Client" / `com.flagg.mobileopenllmclient`.
- Whether phase 6 on-device inference is in scope for the first release or a later one.
- Whether a self-hosted proxy mode should ever replace direct device-side keys.
