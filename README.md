# Open LLM Client

An Expo / React Native app that runs an LLM **agent** on the phone: the tool loop, tool execution, provider configuration and chat history all live inside the app. There is no server, no HTTP route, and no proxy — the app talks to the provider you configured, directly from the device.

It speaks to two kinds of endpoint:

- **Remote vendors** over HTTPS (OpenAI, Anthropic, Google, OpenRouter, Groq, OpenCode, …)
- **Local servers on your LAN** over plain HTTP (Ollama, llama.cpp server, LM Studio, vLLM, MLX, Atomic Chat, Lynkr, Privatemode AI)

## What it does

- **Agent loop in-app** — Vercel AI SDK v7 (`ToolLoopAgent` + `useChat`) with OpenAI, Anthropic, Google and OpenAI-compatible adapters. Multi-step tool calls stream into the transcript.
- **Five tools**, no plugin or skill registry: `get_device_info`, `read_file`, `write_file`, `fetch_url`, `fetch_image`. `fetch_image` is only offered when the selected model accepts images.
- **Provider-scoped settings** — one provider = one endpoint + one dialect + one credential slot. Models are switched inside the provider, never as a profile per model. A shipped catalogue (generated from models.dev) covers every provider the app can drive; you can add any OpenAI-compatible server by URL.
- **Vision** — pick up to 4 photos from the gallery, re-encoded as JPEG and sent as `file` parts; they render back in your own bubble and round-trip through the model.
- **Context guard** — input, output and a safety margin are budgeted against the model's context window, attachments and tool media are counted, oversized tool results are elided, and an overflowing request is refused before it goes out (`ContextOverflowError`) instead of being rejected by the server.
- **Real error text** — the banner quotes the provider's own response (`401 · Upstream request failed: Invalid credential`) and distinguishes a dropped network from a browser-blocked request; a missing key is caught before the request.
- **Token accounting** — per-message footer with tokens sent, tokens received, tool-call count and an approximate cost, plus session totals in the top bar.
- **Everything persists** — full transcripts in SQLite, restored when you reopen a session; "New chat" starts empty.
- **Free models** are kept and badged `free`, not filtered out.
- **Readable UI** — floating composer flush above the keyboard, transcript that follows the newest bubble while streaming, wrapped top bar showing the icon, app name, version and a `DEBUG` badge on debug builds.

## Screens

| Route | File | What it holds |
| --- | --- | --- |
| Chat | `src/app/index.tsx` | transcript, composer (text + gallery button), model chip, error banner, session totals |
| Settings | `src/app/settings.tsx` | provider cards: endpoint, dialect, credential, model list, catalogue search |

Five providers ship ready to use: Ollama (LAN), OpenCode Go, OpenAI, Anthropic, Google. Everything else comes from the catalogue on demand.

## Providers and dialects

| Dialect | Used for |
| --- | --- |
| `openai-chat` | OpenAI and other `/chat/completions` vendors |
| `openai-responses` | OpenAI Responses API |
| `anthropic-messages` | Anthropic `/v1/messages` |
| `gemini-generate-content` | Google `generateContent` |
| `openai-compatible` | every LAN server and most aggregators |

**OpenCode Go** has exactly one endpoint: `https://opencode.ai/zen/go/v1` (`POST …/chat/completions`). Requests carry the `x-opencode-session` header that gateway requires. Profiles left on the retired `inference/go/openai/v1` URL are rewritten to zen on load, so existing installs keep working.

## Keys, storage and privacy

- API keys are stored on the device in `expo-secure-store` (one slot per provider). On the web dev target only, they fall back to `localStorage` in plaintext, because Expo ships an empty secure-store module for web.
- Transcripts and provider config go in SQLite (`expo-sqlite`); images are capped per conversation, and the oldest attachment is replaced by a note when the budget is exceeded.
- There is no analytics, no telemetry, and no intermediate server: the key leaves the device only in a request to the provider you configured.
- Release Android builds allow **cleartext HTTP** (via `plugins/android-cleartext.js`) so LAN servers on plain `http://192.168.x.x:11434/v1` work. Remote providers stay HTTPS. If you point a provider at a plain-HTTP host on the internet, the credential travels unencrypted — that is on you.

## Requirements

- Node ≥ 22.13, Yarn 4.13 (`packageManager` — use `yarn`, not `npm`/`npx` for scripts).
- Expo SDK 58 with native modules (`expo-sqlite`, `expo-secure-store`, `expo-image-picker`), so **Expo Go will not run it** — you need a development build.
- Android device or emulator (the shipped APK is **arm64-v8a only**). iOS builds need macOS or EAS.

## Commands

```bash
yarn install
yarn android              # development build (expo run:android)
yarn web                  # browser dev target — for layout/round-trip testing only
yarn test                 # vitest, one-shot
yarn typecheck
yarn lint                 # expo lint
yarn doctor               # expo-doctor
yarn providers:sync       # regenerate src/core/provider-catalog.ts from models.dev
yarn bump                 # minor bump: package.json, app.json version + versionCode, src/version.ts
yarn device:e2e           # drive the installed APK over adb
yarn web:check            # drive the web target over CDP, writes a phone-sized PNG
```

`src/core/provider-catalog.ts` is generated — never hand-edit it; run `yarn providers:sync` instead.

## Building and installing a release APK

```bash
yarn bump                 # do this before every app build
npx expo prebuild         # generates android/ from app.json (Continuous Native Generation)
cd android
gradlew.bat assembleRelease      # Windows; ./gradlew assembleRelease elsewhere
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

`versionCode` only reaches the APK after `prebuild` regenerates `android/app/build.gradle`, so bump → prebuild → build is the order. `android/` and `ios/` are generated, not committed: configure native behaviour in `app.json` and config plugins, never by hand.

For cloud builds and OTA updates use EAS: `bunx eas-cli build` / `eas submit` / `eas update` (substitute `npx eas-cli@latest` here since the project is Yarn-based).

## Verification

- **Unit tests**: Vitest with React Native and Expo mocks (`src/__mocks__`) — covers the context guard, error wording, catalogue, key handling, image caps, transcript persistence, usage maths and tool behaviour.
- **On-device e2e** (`scripts/device-e2e.mjs`, 13 checks): top-bar identity, `versionCode`, keyboard avoidance around the composer, composer card insets, Settings header and field reveal, back-to-chat, free-model badge, vision attach, photo-picker preview, and a crash-buffer check.
  ```bash
  yarn device:e2e                    # all checks
  yarn device:e2e --only=image-roundtrip   # send a real photo and read the model's answer
  yarn device:e2e --trace            # dump the UI tree on every step
  ```
  Optional probes: `E2E_PROBE_IMAGE=1` (real image round trip), `E2E_PROBE_FREE=1` (a free-tier model), `E2E_DEVICE=<serial>`, `E2E_PKG=<package>`. Screenshots land in the system temp dir, not the repo.
- **Web UI check** (`scripts/web-ui-check.mjs`): headless browser, waits for mount, dumps console output, writes a phone-sized screenshot.

CI runs typecheck, lint, `yarn test` and `expo-doctor` on every PR and on `main`.

## Known limits

- **iOS** is not built or verified from a Windows host — needs macOS (`yarn ios`) or `eas build`.
- **The web target is dev/test only and is never shipped.** Remote vendors send no `Access-Control-Allow-Origin` and reject the preflight with `404`, so remote calls cannot be tested there; LAN Ollama at `http://localhost:11434/v1` does work. File tools report "not available in the web build", keyboard avoidance can only be verified on a device, and config/keys use `localStorage` instead of SQLite/SecureStore.
- **OpenCode Console** (pay-as-you-go) still uses `https://opencode.ai/inference/openai/v1`; only Go was moved to the zen gateway.
- On-device inference (`llama.rn`, Apple Foundation Models, Android ADK) is a planned phase behind the same provider registry, not shipped.

## Layout

```
src/app/        routes (chat, settings, layout)
src/components/ top bar, message bubble, composer controls, provider card, model sheets
src/core/       agent, transport, dialects, catalogue, context guard, tools, image, usage, errors
src/hooks/      useAgentChat, keyboard-aware scroll/padding
src/store/      provider config, SQLite, transcript, web storage fallback
src/version.ts  app name/version/icon shown in the bar — rewritten by `yarn bump`
scripts/        version bump, catalogue generator, device e2e, web UI check
plugins/        Android cleartext config plugin
PLAN.md         locked decisions and findings measured on device
```

MIT licensed.
