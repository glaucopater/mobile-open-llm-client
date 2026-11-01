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
     vitest + vite (node runner; jest and @react-native/jest-preset were dropped), eslint, eslint-config-expo, expo-doctor,
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
- CORS blocks vendors, not LAN servers, on the web target. Measured with Node
  against `https://opencode.ai/zen/go/v1/chat/completions`: the POST answers
  `401 Upstream request failed: Invalid credential` with **no**
  `Access-Control-Allow-Origin` header, and the preflight
  `OPTIONS` (with `authorization` + `content-type` + `x-opencode-session`) answers
  **404** with no CORS headers at all. So a browser never gets an answer to read:
  `fetch` rejects with `TypeError: Failed to fetch` and the key is never sent.
  The app used to report that as "network error · the request never reached the
  server", which is true but useless. `src/core/network-error.ts` now compares the
  endpoint origin with the page origin (scheme + host + **port**, so a LAN server
  on another port is cross-origin too) and says
  `blocked by the browser · https://opencode.ai sends no Access-Control-Allow-Origin to
  http://localhost:8081 … the key never left the page`. Native builds have no CORS,
  so the same message there stays a network error. `describeError(error, baseUrl)`
  takes the endpoint; chat and Test connection both pass it, and an
  `Error.cause` the message does not already carry is appended.
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
- **Debug builds say so**: `AppHeader` adds an amber `DEBUG` badge and a second line
  naming the client and the dev server serving the bundle (`dev client ·
  192.168.178.87:8081`, `web dev`, `Expo Go`, `debug APK`). The flag is
  `__DEV__`, which Metro compiles to `false` in a release APK, so the badge is
  never a cosmetic element — it is the proof a phone is running a dev client and
  not the sideloaded build. `src/core/build-mode.ts` reads it through
  `isDebugBuild()` (checked at render, so a test can flip the flag) and gets the
  client/host from `expo-constants` (`executionEnvironment`, `expoConfig.hostUri`,
  `expoGoConfig` to tell Expo Go from this app's dev client). Jest maps
  `expo-constants` to `src/__mocks__/expo-constants.ts`, since the real module
  reads values the native runtime holds.
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

- **Two more harness bugs, found while chasing the image send**: `dumpUi()` reads the *active*
  window, and while the keyboard is animating that window is the IME — its tree carries none of our
  labels, so `keyboard-composer` and `keyboard-typing` failed with "nothing on screen labelled
  Message" even though the composer was on screen. It now re-dumps until a node carries the app's
  package (`package` is parsed from the XML). And `composer-card`/`vision-attach` compared the attach
  button against the `Message` **EditText**, which is only one child of the card: the button sits to
  the left of the field, so it was always reported "outside the composer". A plain RN `View` carries
  no label, so uiautomator never reports the card itself — `composerRow()` derives the card's bounds
  as the union of the labelled children (input, send/stop, attach) and asserts they share one
  vertical band. `image-pick-preview` drives the picker to the end (tile tapped, accept pressed) and
  asserts a removable thumbnail lands in the composer; the real round trip, which reads what the
  endpoint said about the payload, is gated behind `E2E_PROBE_IMAGE=1` like the free-tier probe.

- **What the photo picker actually looks like**: its tiles carry a caption (`Photo taken on …`) but are
  **not** marked `clickable`, and its accept control is a plain `Done` label, also not clickable — so
  requiring `clickable` made every image check stall inside the picker. `drivePhotoPicker()` matches on
  the label and taps the node's centre. Reading that window needs `dumpWindow()`: `dumpUi()` re-dumps
  until a node carries our package, which a picker never does, so it threw "dump never showed
  com.flagg.mobileopenllmclient" while the picker was the active window.

- **A streamed answer was never on screen** — `image-roundtrip` failed with "an answer or a named
  failure never appeared" while the app bar reported `↑ 3,167 · ↓ 65`: usage existed, so the reply had
  arrived, but the transcript only re-scrolled when the message *count* changed, and a bubble grows as
  its text streams. `FlatList` renders only rows inside the viewport, so the newest bubble (answer and
  token footer) was virtualised away — invisible to the user and to uiautomator. `src/app/index.tsx`
  now scrolls on `onContentSizeChange` (`followNewest`) and keeps that auto-follow only while the user
  is at the bottom (`trackScroll`, within 140px of the end), so scrolling up into history is not
  yanked back down mid-stream. It also scrolls when `status` changes back to `ready`, because the token
  footer is appended after the last text chunk.

- **Uploading an picture blanked the whole screen** — measured on v1.14.0: the app bar's own container
  was `[0,0][1084,1529]` (normally `[0,0][1084,286]`), and the `Open LLM Client` and `v1.14.0 · Chat`
  nodes were gone while the token line, `New chat` and `Settings` were present. Cause: `AppHeader`'s
  identity block used `flex: 1`, which is `flexBasis: 0`, so it starts at zero width; once the bar gains
  the session token line (mono, ~625px) plus `New chat`, the leftover is ~73px, an unwrapping `Text`
  breaks the name into one character per line, and the row becomes ~1400px tall — that is the "crash":
  nothing is painted in the top band and everything below it, including the composer, is pushed down.
  Fix: identity is `flexGrow/flexShrink: 1` with `flexBasis: 'auto'` and `minWidth: 120`, the actions
  shrink instead (`flexShrink: 1`), and every bar label is `numberOfLines={1}` so a narrow bar
  ellipsizes rather than growing. `FlatList` also takes `flex: 1` so a tall sibling cannot steal the
  transcript's height. The `identity` check now fails if the version label ends below y 320.
  Measured after that fix (v1.15.0, 13/13 checks): the bar is back to `[0,0][1084,286]`, the name is at
  y 150 and the version at y 214. The token line was then ellipsized to ~127px, so the bar wraps
  (`flexWrap: 'wrap'`) instead of squeezing: the identity stops shrinking (`flexShrink: 0`) and the token
  line moves to a second row, at most two rows tall.

- **Harness gotcha added by that fix**: `identity.version` is read from `package.json`, so a `--only=`
  run against an APK built before the bump looks for a header the app never prints ("the Chat screen
  never appeared" while the trace showed `v1.15.0 · Chat` in every dump). Install the APK the repo
  describes before running the harness, and `gotoChat`/`gotoSettings` now poll for the header rather
  than tapping a label taken from a dump made while the app is still loading config and the transcript.

- **v1.6.0 (versionCode 7) failed 8/9, and the cause was the UI, not the harness**: the chat
  screen gated a remote provider with no stored key by returning a centred "This provider needs
  an API key" screen *instead of* chat, so `identity` (app name + version in the bar), every
  keyboard check and every Settings check failed — nothing was labelled `Message`, and there was
  no way to switch to a provider that can answer. `src/app/index.tsx` now keeps the header, the
  model chip and the composer, disables **Send** and shows an amber hint with a link to Settings.
  It reads the key with `hasApiKey(model.apiKeyRef)` rather than `keyIsStored`: the cache in
  `src/core/keys.ts` is filled by `primeKeyCache` in `_layout.tsx` asynchronously, so the first
  render after config loads reports a stored key as missing, and that race turned a keyed provider
  into the same dead screen. Mounting chat then exposed a second bug: `createAgent` **threw** for a
  remote provider without a key, and since the agent is built inside `useMemo` during render, that
  throw was a `JavascriptException` on `mqt_v_native` — a FATAL crash, not a chat error (v1.7.0
  passed 8/9 with `no-crash` failing). `createAgent` no longer throws; `ChatSession` blocks Send and
  `testModelConnection` returns `"<model> needs an API key. Add it in Settings."` before probing.
  The harness also tracked the redesign: `gotoSettings()` waits for `Providers` (the old screen said
  `Models`), and `settings-field-reveal` scrolls to the `API key ref` field instead of opening an
  `Edit <model>` row that no longer exists.

- **v1.4.0 (versionCode 5) is built but not yet re-checked on the phone**: `assembleRelease` took 7m30s
  and produced a 34.5 MB arm64-only APK. Wireless adb had dropped (`adb devices` lists nothing), so
  `yarn device:e2e` and the OpenCode Go round trip still need a device. The gateway behaviour is proven
  from this host instead: both Go URLs answer `400 MissingSessionID` without `x-opencode-session` and
  `401 Invalid credential` with it and a dummy key, so routing works and only the key is missing.

- **Fat tool results are verified in vitest, not on the phone**: `src/__tests__/agent-wire.test.ts`
  runs the real `ToolLoopAgent` loop with the real guard and a scripted provider
  (`MockLanguageModelV4` from `ai/test`), so it reads the prompt the guard handed the model. A
  tool returning 4 × `MAX_TOOL_RESULT_CHARS` arrives on the next step as `type: 'text'` with the
  serialised payload elided to the cap (`characters truncated`), the tool call and its result stay
  in one request, and `onTrim` reports `clippedToolResults: 1` — the number the trim chip shows.
  It cannot be exercised with the shipped tools: `MAX_TOOL_OUTPUT_CHARS` in `src/core/tools.ts`
  clamps tool output to 8 000 chars, below the guard's 16 000, so `read_file` and `write_file`
  never reach the cap today. A tool that returns more (an HTTP body, a sqlite dump) would.
  Two AI SDK v7 shapes the mock needed: `finishReason` is an object (`{ unified: 'tool-calls' }`)
  and usage is nested (`inputTokens.total`, `outputTokens.text`); flat strings/numbers are dropped,
  which silently ends the loop after one step. `vitest.config.mts` swaps native modules for stand-ins
  (`react-native`, `expo/fetch`, `expo-constants`, `expo-image-picker`, `expo-device`,
  `expo-file-system`, bundled images), and `ai`
pulls `@workflow/*` in through `@ai-sdk/gateway` as ESM that node imports directly, so nothing
needs jest's `transformIgnorePatterns`. `src/__tests__/setup.ts` sets `__DEV__` before every suite:
`expo`'s async-require reads it at import time and node has no Metro to define it, so importing
`core/tools.ts` → `expo-device` failed with `ReferenceError: __DEV__ is not defined`.

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
1. **Env + scaffold** — repair package manager, `create-expo-app` on SDK 58, dev build scripts, strict TS, eslint, vitest, CI running `typecheck + test + expo-doctor`.
   *Done when `expo run:android` and `expo run:ios` boot a blank screen on emulator and simulator.*
   **Status: toolchain done** — Yarn 4.13 + node-modules linker, SDK 58 scaffold with Expo Router, strict TS, flat eslint config, vitest on node, CI workflow. `typecheck`, `lint`, `test` (3 passing), `expo-doctor` (20/20) and `expo export --platform ios` (1150 modules) all pass. Native boot not verified: no Android emulator run yet on this host, iOS needs macOS or an EAS build.
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
    **Status: transcript persistence landed** — every prompt and every reply is written to SQLite under the conversation's session id (`src/store/transcript.ts`, `transcript` table in `src/store/db.ts`; web keeps the same rows in localStorage), and the chat restores them via `useChat({ messages })` (`src/store/conversation.ts`, loaded in the root layout before the first render because `useChat` reads initial messages at mount). "New chat" mints a fresh session id (`startNewConversation`) and leaves the finished conversation on disk. A turn is stored only when it settles, so a mid-stream kill leaves no half-saved reply; the last 300 rows of a session are kept (`MAX_STORED_MESSAGES`). An errored turn is stored too — the prompt really went out — and `sanitizeForStorage` drops an assistant tool call that never got a result, because a restored `tool_calls` entry with no matching tool message is rejected by every dialect and would fail every later request. Pictures are capped by bytes, not rows: `MAX_STORED_IMAGE_BYTES` (8 MB per conversation) spends itself newest-first, replacing an older attached image with a line of text and stripping only the `media` entry out of an oversized tool result, because a tool result must keep its text half — a call without a result is the same rejected shape. Tool parts and usage metadata are stored, so the `↑ sent · ↓ received` footer survives a reload. Session list, JSON export and abort-resume checkpoints are not built yet.
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
- **OpenCode Go (default profile)**: the gateway answers `400 {"error":{"type":"MissingSessionID"}}` to
  any Chat Completions request without `x-opencode-session`, and `401 Invalid credential` for a key that
  is not a real OpenCode Console/Go subscription key (the free-tier models are OpenCode-only and return
  `403` to other harnesses). `src/core/session.ts` mints one stable `ses_…` id, stores it in the kv table
  so restarts keep the conversation identity, and `requestHeaders` in `src/core/provider.ts` sends it plus
  a client `User-Agent` (`open-llm-client/<version>`) for any host under `opencode.ai`. One endpoint ships
  for Go: `https://opencode.ai/zen/go/v1`, so the request is `POST https://opencode.ai/zen/go/v1/chat/completions`.
  The `inference/go/openai/v1` path models.dev advertises is not a route Go serves and is not offered — the
  generator pins the base through `API_OVERRIDE` and lists no `ENDPOINT_CHOICES`, so Settings shows no endpoint
  switcher for Go. A profile stored on the retired path is rewritten to zen on load (`RETIRED_ENDPOINTS` in
  `src/store/config.ts`), keeping its name, credential slot and model list, because a phone left on the wrong
  URL fails every message with no clue why. The default model is `deepseek-v4.1-flash` (1M ctx, tools +
  vision + reasoning) sharing one credential slot, so pasting the key in Settings is all the phone needs. The
  catalog's `opencode` entry is the pay-as-you-go Console gateway (`inference/openai/v1`), not the Go one.
  `generate-provider-catalog.mjs` lists both under `PAID_ONLY_MODELS`, so a preset added from the picker
  suggests a paid model instead of a free one that would answer `403`.
- **A bare `Failed to fetch` means the request never left the device**, not a wrong endpoint. Measured with a
  dummy credential, `zen/go/v1/chat/completions` answers `HTTP 401 · Upstream request failed: Invalid credential`
  and an unknown model id answers `HTTP 400 · Upstream request failed: Model is unavailable` — both are answers
  from the gateway, so the transport, not the endpoint, is what to suspect when nothing comes back.
- **Credential hygiene**: `normalizeApiKey` in `src/core/keys.ts` strips anything outside printable ASCII before
  a key is stored or probed, because a header value containing a control character makes the native client refuse
  the request and fetch reports that as a bare `Failed to fetch`. `describeError` names that class of failure
  (`network error · the request never reached the server (...)`) instead of quoting fetch; an HTTP status is still
  reported as `HTTP <code> · <message>` because a status is a response, not a transport failure.
- **Built-in defaults reach installs that already saved a registry**: `load()` appends any `DEFAULT_MODELS`
  profile whose id is missing, keeping user rows in their own order and their edits intact, and stores
  `retiredDefaults` so a profile the user deleted is not resurrected. Web keeps the same row in
  localStorage, so the merge is shared by both targets.
- **CI needs Corepack before `actions/setup-node`**: `setup-node`'s `cache: yarn` step runs `yarn --version`
  to build its cache key. With `corepack enable` only in a later step, the runner's global Yarn 1.22 answers
  and the step dies on the `packageManager: yarn@4.13.0` mismatch in seconds — the job never reaches
  `yarn install`. `corepack enable` is therefore the first step, and `COREPACK_ENABLE_DOWNLOAD_PROMPT: '0'`
  is set at job level so the pinned Yarn download is not gated on an interactive confirmation.
- **What leaves the device is asserted, not assumed**: `src/__tests__/opencode-wire.test.ts` drives the
  real `@ai-sdk/openai-compatible` adapter through `createLanguageModel` and `setFetchImplementation`, so
  the outgoing request is inspected rather than the config object. Two things the wire shows that config
  does not: the vendor package lower-cases its header keys (`headers.get('user-agent')`, not
  `headers['User-Agent']`) and appends its own suffix, so the client name is only a prefix of
  `User-Agent`; and the adapter's setting is `baseURL`, so passing `baseUrl` yields
  `TypeError: Invalid URL` from `new URL('undefined/chat/completions')`. `inputMode` is a V5 field and is
  rejected by `tsc` against the V4 spec the SDK ships.
- **Device harness stability**: `identity` polls for the name and version instead of reading one dump -
  the first v1.4.0 run failed there while the header was on screen a moment later. `waitFor` returns what
  the predicate returns, so a predicate that wants the whole node list must return the list.
  `execFileSync` inherits the parent's stderr by default, and device-side `dumpsys | grep` emits
  "Failed to write while dumping service window: Broken pipe" on every early pipe close - dozens of lines
  per run. `stdio: ['pipe', 'pipe', 'pipe']` captures it (the transport-recovery retry still reads
  `error.stderr`) and the output is nine lines. Run it as
  `node scripts/device-e2e.mjs --only=<check>` (equals form); options are not space-separated.
- **Tool fetch and multi-part tool results**: `fetch_url` and `fetch_image` in `src/core/tools.ts` go through `core/http.ts`, so they use the same streaming `expo/fetch` as chat and are testable with `setFetchImplementation`. `fetch_image` answers with `{type:'content', value:[{type:'text'…},{type:'media',data,mediaType}]}`, which only reaches the model as a picture when the adapter is told: `createOpenAICompatible({ supportsMultiPartToolContent: true })` in `src/core/provider.ts`, set from `acceptsImages(model)` so a text-only LAN server is never sent array content on a `tool` message (many of them reject it). The guard counts that media part with `filePartBytes` (which now reads `part.data`) and `clipToolOutput` compresses only the text parts, so base64 is never rewritten into text the model cannot read. `fetch_image` is not offered to non-vision models at all: every tool schema rides on every request.
- **A failure with no HTTP status is a streamed error, not a network fault**: Zen answers `200` and then emits an error chunk, which the SDK surfaces as `An error occurred.` with no status. The masking is `toUIMessageStream`'s default `onError` (`() => 'An error occurred.'`), so `DirectChatTransport` in `src/hooks/useAgentChat.ts` is given an `onError` that runs `describeError` — the real cause reaches the banner instead of the SDK's placeholder. `describeError` appends ` · accepted at <endpoint> and failed inside the response`, quotes the vendor body when present (` · server said: …`, collapsed to one line), and leaves a message that already names a status or a class (`HTTP 401 ·`, `network error ·`, `blocked by the browser ·`) untouched, because the banner re-describes the text the transport put in the error chunk. The transport line names the host (`network error · the request never reached http://host:port (…)`), which is what a tool fetch needs to say which URL failed.
- **llama.rn** (phase 6) needs a development build plus an Expo config plugin, large RAM headroom, and per-device Metal/OpenCL support checks — gate it behind runtime capability probes.

## Open questions
- ~~App name / bundle identifier and repository license~~ — settled: MIT license (the Expo template's MIT `LICENSE` is kept, `package.json` declares `license: MIT`), app stays "Open LLM Client" / `com.flagg.mobileopenllmclient`.
- Whether phase 6 on-device inference is in scope for the first release or a later one.
- Whether a self-hosted proxy mode should ever replace direct device-side keys.
