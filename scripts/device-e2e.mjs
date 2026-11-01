/**
 * On-device end-to-end checks against the installed APK (Android, via adb).
 *
 *   yarn device:e2e                     # every check on the one connected phone
 *   yarn device:e2e --device=<serial>   # when `adb devices` lists more than one
 *   yarn device:e2e --only=keyboard     # run checks whose name contains this
 *   yarn device:e2e --shots=<dir>       # where screenshots land (default: temp dir)
 *
 * These checks are black-box: they tap the screen and read what the system
 * actually drew. A unit test cannot tell whether a view ends up behind the
 * keyboard; `uiautomator` bounds can, and pairing them with the IME inset from
 * `dumpsys window` says where the keyboard starts. That is how the composer bug
 * was found, so the same measurement is what this harness asserts.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PKG = process.env.E2E_PKG ?? 'com.flagg.mobileopenllmclient';
const LAUNCH = `${PKG}/.MainActivity`;
const UI_PATH = '/sdcard/e2e-ui.xml';
const SHOT_PATH = '/sdcard/e2e-shot.png';

/** Flags: --device=<serial> --only=<name> --shots=<dir> --wait=<ms> --pkg=<id> --trace */
function parseArgs(argv) {
  const options = {
    device: process.env.E2E_DEVICE ?? null,
    only: null,
    shots: join(process.env.TEMP ?? '/tmp', 'device-e2e'),
    wait: 600,
    pkg: PKG,
    trace: argv.includes('--trace') || process.env.E2E_TRACE === '1',
  };

  for (const arg of argv) {
    if (arg.startsWith('--device=')) {
      options.device = arg.slice('--device='.length);
    } else if (arg.startsWith('--only=')) {
      options.only = arg.slice('--only='.length);
    } else if (arg.startsWith('--shots=')) {
      options.shots = arg.slice('--shots='.length);
    } else if (arg.startsWith('--wait=')) {
      options.wait = Number(arg.slice('--wait='.length));
    } else if (arg.startsWith('--pkg=')) {
      options.pkg = arg.slice('--pkg='.length);
    }
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));

/** Blocking sleep for synchronous adb reads: `Atomics.wait` parks the worker. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * adb with transport recovery. Wireless adb (mDNS TLS) drops mid-run when the
 * session expires, and the whole device disappears from `adb devices` — an
 * early run died with `error: closed` / `device offline` after a notification
 * stole the screen. `wait-for-device` blocks until the transport is back, so a
 * short reconnect window covers a transient drop; a device that never returns
 * is reported as what it is: wireless debugging off on the phone.
 */
function adb(...args) {
  const argv = options.device ? ['-s', options.device, ...args] : args;
  const attempts = 3;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // `stdio` is explicit because execFileSync inherits the parent's stderr by
      // default, and device-side `dumpsys | grep` writes "Broken pipe" for every
      // early pipe close - dozens of lines that drown the check output. Captured
      // stderr still feeds the transport-recovery check below.
      return execFileSync('adb', argv, {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (error) {
      const detail = error.stderr ?? error.message;

      if (attempt === attempts || !/device offline|error: closed|no devices|connection/i.test(detail)) {
        throw new Error(`adb ${args.join(' ')} failed: ${detail}`);
      }

      try {
        execFileSync('adb', [...argv.slice(0, 2), 'wait-for-device'], {
          encoding: 'utf8',
          timeout: 20_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        throw new Error(
          `adb lost the device (${detail}). Re-enable Wireless debugging on the phone (Developer options) and re-run.`,
        );
      }
    }
  }

  return '';
}

/** Runs a shell command on the device, filtered on-device to keep the payload small. */
function sh(command) {
  return adb('shell', command);
}

function listDevices() {
  return execFileSync('adb', ['devices'], { encoding: 'utf8' })
    .split('\n')
    .slice(1)
    .filter((line) => line.trim().endsWith('\tdevice'))
    .map((line) => line.split('\t')[0]);
}

/** Display size in pixels; `wm size` reports an override when one is set. */
function displaySize() {
  const out = sh('wm size');
  const match = /Override size:\s*(\d+)x(\d+)/.exec(out) ?? /Physical size:\s*(\d+)x(\d+)/.exec(out);

  if (!match) {
    throw new Error(`could not read display size from: ${out}`);
  }

  return { width: Number(match[1]), height: Number(match[2]) };
}

function parseNode(tag) {
  const attrs = {};

  for (const match of tag.matchAll(/([\w-]+)="([^"]*)"/g)) {
    attrs[match[1]] = match[2];
  }

  const rect = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? '');

  return {
    text: attrs.text ?? '',
    desc: attrs['content-desc'] ?? '',
    class: attrs.class ?? '',
    package: attrs.package ?? '',
    clickable: attrs.clickable === 'true',
    bounds: rect
      ? { left: Number(rect[1]), top: Number(rect[2]), right: Number(rect[3]), bottom: Number(rect[4]) }
      : null,
  };
}

/**
 * Dumps the visible tree, dropping nodes whose bounds are inverted. A ScrollView
 * that is still settling reports clipped children as `[x,286][x,56]` (top below
 * bottom): picking one of those taps a coordinate that is not on screen, which is
 * how a Settings check ended up tapping the model chip instead of the header link.
 */
function readWindow() {
  sh(`uiautomator dump ${UI_PATH}`);
  const xml = sh(`cat ${UI_PATH}`);
  const nodes = [...xml.matchAll(/<node\b[^>]*>/g)]
    .map((match) => parseNode(match[0]))
    .filter((node) => node.bounds === null || node.bounds.bottom >= node.bounds.top);

  if (options.trace) {
    const labels = nodes
      .filter((n) => n.text !== '' || n.desc !== '')
      .map((n) => `${n.text || n.desc} [${n.bounds.left},${n.bounds.top},${n.bounds.right},${n.bounds.bottom}]`)
      .slice(0, 12);

    console.log(`  screen: ${labels.join(' / ')}`);
  }

  return nodes;
}

function dumpUi() {
  // `uiautomator dump` dumps the *active* window. While the keyboard is opening
  // that window is the IME, whose tree has none of our labels — the
  // `keyboard-composer` and `keyboard-typing` checks failed with "nothing on
  // screen labelled Message" for exactly that reason. Retrying a few times reads
  // the app's own window once the animation settles.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const nodes = readWindow();

    if (nodes.some((node) => node.package === options.pkg)) {
      return nodes;
    }

    sleepSync(250);
  }

  throw new Error(`dump never showed ${options.pkg} (the keyboard or a system window owns the screen)`);
}

/**
 * The active window whatever it is. Used while the system photo picker owns the
 * screen: `dumpUi()` insists on our own package, which a picker never has.
 */
function dumpWindow() {
  return readWindow();
}

/** Keyboard state: the IME inset gives its top edge; `mInputViewStarted` says if it is up. */
function keyboardState() {
  const insets = /mInsetsHint=Insets\{left=(\d+), top=(\d+), right=(\d+), bottom=(\d+)\}/.exec(
    sh('dumpsys window | grep -m1 "mType=ime"'),
  );
  const bottom = insets ? Number(insets[4]) : 0;
  const shown = sh('dumpsys input_method | grep -m1 "mInputViewStarted"');

  return {
    visible: shown.includes('mInputViewStarted=true'),
    inset: bottom,
    top: displaySize().height - bottom,
  };
}

function focus() {
  return sh('dumpsys window | grep -m1 mCurrentFocus');
}

/**
 * Closes the notification shade and the recents screen. `adb install` raises a
 * notification, and if the shade is open the app never becomes `mCurrentFocus`,
 * so every check would fail against the system UI rather than the app.
 */
function closeSystemDialogs() {
  sh('am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS');
  // The shade can also be open on its own; collapsing it is the only way to put
  // the app back on screen without restarting it.
  sh('cmd statusbar collapse');
}

/**
 * Puts the app back on screen before every check. Incoming notifications expand
 * into the shade and take focus: one run read a WhatsApp conversation instead
 * of the composer, then tapped into the shade and lost the device. `am start`
 * on the already-running task brings it forward without losing state.
 */
async function ensureForeground() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (focus().includes(options.pkg)) {
      return;
    }

    closeSystemDialogs();
    sh(`am start -n ${LAUNCH}`);
    await sleep(600);
  }

  throw new Error(`app is not on screen: ${focus()}`);
}

async function launch() {
  closeSystemDialogs();
  sh(`am force-stop ${options.pkg}`);
  sh(`am start -n ${options.pkg}/.MainActivity`);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = focus();

    if (current.includes(options.pkg)) {
      await sleep(options.wait);

      return;
    }

    if (current.includes('NotificationShade') || current.includes('Recents')) {
      closeSystemDialogs();
    }

    await sleep(500);
  }

  throw new Error(`app never came to the foreground: ${focus()}`);
}

/**
 * Taps a coordinate pair, a `{x, y}` point, or a UI node (its centre). The
 * Settings checks pass points/nodes directly; passing them to a `(x, y)`
 * signature sent `NaN NaN`, which the device silently ignored.
 */
async function tap(target, y) {
  const point =
    typeof target === 'number'
      ? { x: target, y }
      : target.bounds !== undefined && target.x === undefined
        ? center(target)
        : target;

  if (options.trace) {
    console.log(`  tap (${Math.round(point.x)}, ${Math.round(point.y)})`);
  }

  sh(`input tap ${Math.round(point.x)} ${Math.round(point.y)}`);
  await sleep(options.wait);
}

function center(node) {
  if (!node.bounds) {
    throw new Error(`${node.desc || node.text || node.class} has no bounds`);
  }

  return {
    x: (node.bounds.left + node.bounds.right) / 2,
    y: (node.bounds.top + node.bounds.bottom) / 2,
  };
}

function pick(nodes, label) {
  const node = nodes.find((n) => n.desc === label || n.text === label);

  if (!node) {
    throw new Error(`nothing on screen labelled "${label}"`);
  }

  if (options.trace) {
    console.log(`  picked "${label}" -> class ${node.class} bounds ${JSON.stringify(node.bounds)}`);
  }

  return node;
}

function contains(nodes, text) {
  return nodes.find((n) => n.text.includes(text) || n.desc.includes(text));
}

/**
 * The composer card as one band. uiautomator does not report the RN `View` that
 * wraps it (a plain View carries no label), so the card's bounds are the union of
 * its children. Comparing a button against the `Message` EditText alone compared
 * it to the text field: the attach button sits to the left of the field, so it was
 * always "outside the composer".
 */
function composerRow(nodes) {
  const parts = nodes.filter(
    (node) =>
      node.bounds !== null &&
      (node.desc === 'Message' ||
        node.desc === 'Send message' ||
        node.desc === 'Stop answering' ||
        node.desc === 'Add images from the gallery' ||
        /^At most \d+ images per message$/.test(node.desc)),
  );

  if (parts.length === 0) {
    throw new Error('nothing on screen belonging to the composer');
  }

  return {
    parts,
    bounds: {
      left: Math.min(...parts.map((n) => n.bounds.left)),
      top: Math.min(...parts.map((n) => n.bounds.top)),
      right: Math.max(...parts.map((n) => n.bounds.right)),
      bottom: Math.max(...parts.map((n) => n.bounds.bottom)),
    },
  };
}

async function screenshot(name) {
  sh(`screencap -p ${SHOT_PATH}`);
  const file = join(options.shots, `${name}.png`);
  adb('pull', SHOT_PATH, file);

  return file;
}

/** Version strings come from src/version.ts so the check tracks the app, not a copy. */
function appIdentity() {
  const source = readFileSync('src/version.ts', 'utf8');

  return {
    name: /export const APP_NAME = '([^']*)';/.exec(source)?.[1] ?? '',
    version: /export const APP_VERSION = '([^']*)';/.exec(source)?.[1] ?? '',
  };
}

const identity = appIdentity();
const display = displaySize();

const results = [];

async function check(name, body) {
  if (options.only !== null && !name.includes(options.only)) {
    return;
  }

  try {
    await ensureForeground();
    const detail = await body();
    results.push({ name, ok: true, detail });
    console.log(`PASS ${name} — ${detail}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    console.log(`FAIL ${name} — ${error.message}`);
  }

  await screenshot(name);
}

/**
 * Polls the UI tree until `predicate` matches. Navigation and keyboard changes
 * on the device take longer than a single fixed wait, and dumping a screen that
 * has not settled yet makes a check pass or fail for the wrong reason — the
 * first run read the Chat screen while believing it was on Settings.
 */
async function waitFor(predicate, description, timeout = 5000, read = dumpUi) {
  const deadline = Date.now() + timeout;

  for (;;) {
    const hit = predicate(read());

    if (hit) {
      return hit;
    }

    if (Date.now() > deadline) {
      throw new Error(`${description} never appeared (waited ${timeout}ms)`);
    }

    await sleep(250);
  }
}

/**
 * Drives the system photo picker to the end: tap a tile, press its accept
 * control, hand the screen back to the app. Two things the picker taught us by
 * being dumped rather than guessed — its tiles are *not* marked clickable (a tap
 * still selects them), and its accept control is a plain `Done` label, also not
 * clickable. Requiring `clickable` on either made every image check stall in the
 * picker, so the label alone decides and the tap goes to the node's centre.
 */
async function drivePhotoPicker() {
  const tile = await waitFor(
    (nodes) =>
      nodes.find((n) => /Photo taken on|Screenshot/i.test(n.desc)) ??
      nodes.find((n) => n.class.toLowerCase().includes('imageview') && n.bounds !== null),
    'a photo tile in the picker',
    8000,
    dumpWindow,
  );
  await tap(tile);

  const accept = await waitFor(
    (nodes) =>
      nodes.find((n) => /^(Next|OK|Done|Finish|Use|Send)$/i.test((n.text || n.desc).trim())),
    'the picker accept control',
    6000,
    dumpWindow,
  );
  await tap(accept);

  await waitFor(() => (focus().includes(options.pkg) ? true : null), 'the app after the picker', 12000);

  return tile.desc || tile.text;
}

/** Waits for the keyboard to come up; taps are async on the device. */
async function awaitKeyboard(shows = true) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = keyboardState();

    if (state.visible === shows) {
      return state;
    }

    await sleep(250);
  }

  return keyboardState();
}

/**
 * Taps the composer until the IME is up. ReactEditText only summons the
 * keyboard when the view is clickable in touch mode (`isInTouchMode`), so a
 * tap that lands right after an adb keyevent focuses the field without
 * showing the keyboard — measured as `mInputStarted=true` with
 * `mShowInputRequested=false`. A second tap behaves like a real user.
 */
async function tapComposerUntilKeyboardUp() {
  let keyboard = await awaitKeyboard(false);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await ensureForeground();
    await tap(center(pick(dumpUi(), 'Message')));
    keyboard = await awaitKeyboard(true);

    if (keyboard.visible) {
      return keyboard;
    }
  }

  return keyboard;
}

/**
 * Dismisses anything stacked above the screens: the modal model switcher, and
 * the system dialogs (a notification shade steals focus and swallows taps).
 * Android's back key closes both, and the modal answers `onRequestClose`.
 */
async function clearStack() {
  sh('am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!contains(dumpUi(), 'Switch model')) {
      return;
    }

    sh('input keyevent KEYCODE_BACK');
    await sleep(options.wait);
  }
}

/**
 * Waits for another activity to take the screen. The image picker is a separate
 * app, so its arrival is the proof a button did something rather than a tap that
 * was swallowed. A notification shade or recents is not a picker, so those are
 * pushed away and the wait continues instead of counting as a hit.
 */
async function waitForOtherActivity(timeout = 8000) {
  const deadline = Date.now() + timeout;

  for (;;) {
    const current = focus();

    if (!current.includes(options.pkg)) {
      if (current.includes('NotificationShade') || current.includes('Recents')) {
        closeSystemDialogs();
        sh(`am start -n ${LAUNCH}`);
      } else {
        return current;
      }
    }

    if (Date.now() > deadline) {
      throw new Error(`the picker never took the screen: ${focus()}`);
    }

    await sleep(400);
  }
}

/**
 * Navigates to a screen by the label its header prints. The header only exists once
 * config and the stored transcript have loaded, so a dump taken during that window
 * has nothing to tap — polling is what makes a `--only=` run stand alone. A control is
 * tapped only in the top bar: the transcript footer says "Chat" too, and tapping it
 * does nothing.
 */
async function gotoScreen(label) {
  await clearStack();
  const header = `v${identity.version} · ${label}`;
  const startedAt = Date.now();
  const deadline = startedAt + 12000;

  for (;;) {
    const nodes = dumpUi();

    if (contains(nodes, header)) {
      return;
    }

    const control = nodes.find(
      (n) => (n.text === label || n.desc === label) && (n.bounds?.top ?? 0) < 320,
    );

    if (control !== undefined) {
      await tap(control);
    }

    if (Date.now() > deadline) {
      throw new Error(
        `the ${label} screen never appeared: no header "${header}" (waited ${Date.now() - startedAt}ms)`,
      );
    }

    await sleep(400);
  }
}

/** Navigates to Settings if not already there, so `--only=` runs stand alone. */
async function gotoSettings() {
  // The header names the screen. The `Providers (N)` heading sits inside the scroll
  // view and is dropped from a dump taken mid-scroll, so the header is the proof.
  await gotoScreen('Settings');
}

/** Back to Chat, likewise. */
async function gotoChat() {
  await gotoScreen('Chat');
}

/** Finds a node whose visible text or label matches, for lines whose length varies. */
function findText(nodes, pattern) {
  return nodes.find((n) => pattern.test(n.text) || pattern.test(n.desc));
}

/**
 * Replaces the contents of a focused text field: select-all then delete. `input
 * text` appends, so a field left holding text from an earlier check would end up
 * holding two strings and the taps that follow would search for the wrong thing.
 */
async function replaceText(node, text) {
  await tap(node);
  await awaitKeyboard(true);
  sh('input keyevent 122');
  sh('input keyevent 67');
  await sleep(options.wait);
  sh(`input text "${text.replace(/ /g, '%s')}"`);
  await sleep(options.wait);
}

/** Taps the first node whose text or label contains `text`, for names with suffixes. */
async function tapContaining(nodes, text) {
  const node = contains(nodes, text);

  if (!node) {
    throw new Error(`nothing on screen containing "${text}"`);
  }

  await tap(node);
}

/**
 * Drives the chat's switcher: opens it, selects `providerName`, narrows the model
 * list with `query`, taps the row whose label matches, closes. The provider chip
 * is also a `Use … for chat` row, so `rowPattern` has to name the model.
 */
async function selectModel(providerName, query, rowPattern) {
  await tap(pick(dumpUi(), 'Switch provider or model'));
  await waitFor((nodes) => contains(nodes, 'Switch model'), 'the model switcher');

  // Provider chips are matched by substring: a migrated profile keeps its endpoint
  // suffix, so it reads "OpenCode Go (zen alias)" rather than the preset name.
  await tapContaining(dumpUi(), providerName);
  await replaceText(pick(dumpUi(), 'Search models'), query);

  const row = await waitFor(
    (nodes) => nodes.find((n) => n.clickable && rowPattern.test(n.desc)),
    `the model row matching ${rowPattern.source}`,
  );
  await tap(row);
  await tap(pick(dumpUi(), 'Close model switcher'));
  // If the Close tap lands on a screen that has not settled, back still dismisses
  // the modal, so the check does not stay stuck inside the switcher.
  await clearStack();

  await waitFor((nodes) => contains(nodes, providerName), 'the chat chip');
}

/** Scrolls a list down by one screen; adb swipes, the app does the rest. */
async function scrollDown() {
  const x = Math.round(display.width / 2);

  sh(`input swipe ${x} 1700 ${x} 500 400`);
  // The list keeps animating after the swipe, and a dump taken during it reports
  // clipped children with inverted bounds, so give it a moment to settle.
  await sleep(Math.max(options.wait, 900));
}

/**
 * Finds a node that may be below the fold. `uiautomator` only reports what is
 * visible, so a long editor's lower fields need scrolling before they can be
 * asserted — the same thing a user has to do.
 */
async function findByScroll(predicate, description, maxScrolls = 6) {
  for (let attempt = 0; attempt <= maxScrolls; attempt += 1) {
    const hit = predicate(dumpUi());

    if (hit) {
      return hit;
    }

    await scrollDown();
  }

  throw new Error(`${description} never came into view`);
}

async function main() {
  const devices = options.device ? [options.device] : listDevices();

  if (devices.length === 0) {
    throw new Error('no device connected (`adb devices` is empty)');
  }

  if (devices.length > 1 && !options.device) {
    throw new Error(`multiple devices connected (${devices.join(', ')}) — pass --device=<serial>`);
  }

  mkdirSync(options.shots, { recursive: true });
  console.log(`device ${devices[0]} | ${display.width}x${display.height} | pkg ${options.pkg}`);

  await launch();

  await check('identity', async () => {
    // A single dump right after `am start` can land before the header has
    // rendered, so poll instead of reading once: the first run of v1.4.0 failed
    // here while the top bar was clearly present a moment later. `waitFor` hands
    // back whatever the predicate returns, so it returns the node list here.
    const nodes = await waitFor(
      (current) =>
        contains(current, identity.name) && contains(current, `v${identity.version}`)
          ? current
          : null,
      `${identity.name} and v${identity.version} in the top bar`,
    );

    const name = contains(nodes, identity.name);
    const version = contains(nodes, `v${identity.version}`);
    const icon = nodes.find((n) => n.desc.toLowerCase().includes('icon'));

    if (!name) {
      throw new Error(`app name "${identity.name}" is not in the top bar`);
    }

    if (!version) {
      throw new Error(`version "v${identity.version}" is not in the top bar`);
    }

    if (!icon) {
      throw new Error('app icon is not in the top bar');
    }

    // The bar has to stay a bar. On v1.14.0 the version label sat at y 768: once the
    // bar carried the session token line plus "New chat", the identity block was
    // squeezed to ~73px wide and the app name wrapped one character per line, making
    // the bar ~1529px tall and pushing the transcript and composer off screen.
    if ((version.bounds?.bottom ?? 0) > 320) {
      throw new Error(
        `top bar is too tall: "v${identity.version}" ends at y ${version.bounds?.bottom}, so the screen below it is pushed off`,
      );
    }

    return `top bar shows ${identity.name} · v${identity.version} + icon at y ${name.bounds?.top}`;
  });

  await check('version-code', async () => {
    // The APK's own version strings, read from the package manager: they prove the
    // build that was installed is the one the repo describes, not an older one.
    const dump = sh(`dumpsys package ${options.pkg}`);
    const versionName = /versionName=(\S+)/.exec(dump)?.[1] ?? '';
    const versionCode = /versionCode=(\d+)/.exec(dump)?.[1] ?? '';
    const app = JSON.parse(readFileSync('app.json', 'utf8')).expo;

    if (versionName !== app.version) {
      throw new Error(`installed versionName "${versionName}", app.json says "${app.version}"`);
    }

    if (versionCode !== String(app.android?.versionCode ?? '')) {
      throw new Error(`installed versionCode ${versionCode}, app.json says ${app.android?.versionCode}`);
    }

    return `versionCode ${versionCode}, versionName ${versionName}`;
  });

  await check('keyboard-composer', async () => {
    const keyboard = await tapComposerUntilKeyboardUp();

    if (!keyboard.visible) {
      throw new Error('keyboard never appeared after tapping the composer');
    }

    const composer = pick(dumpUi(), 'Message');
    const gap = keyboard.top - composer.bounds.bottom;

    if (gap < 0) {
      throw new Error(
        `composer is behind the keyboard: bottom ${composer.bounds.bottom}, keyboard top ${keyboard.top}`,
      );
    }

    if (gap > 200) {
      throw new Error(
        `composer is ${gap}px above the keyboard — padding overshoots (keyboard top ${keyboard.top})`,
      );
    }

    const header = contains(dumpUi(), identity.name);

    if (header && header.bounds && header.bounds.top >= keyboard.top) {
      throw new Error(`top bar is behind the keyboard at y ${header.bounds.top}`);
    }

    return `composer bottom ${composer.bounds.bottom}, keyboard top ${keyboard.top} (gap ${gap})`;
  });

  await check('keyboard-typing', async () => {
    // Standalone runs (`--only=keyboard`) start with the keyboard down.
    await tapComposerUntilKeyboardUp();

    const typed = 'hello world';
    sh(`input text "${typed.replace(/ /g, '%s')}"`);
    await sleep(options.wait);

    const composer = pick(dumpUi(), 'Message');

    if (composer.text !== typed) {
      throw new Error(`composer holds "${composer.text}", expected "${typed}"`);
    }

    return `typed "${typed}" with the keyboard up`;
  });

  await check('keyboard-hide', async () => {
    // BACK dismisses the keyboard. With the keyboard down it navigates back
    // instead and leaves the app, so the keyboard has to be up first — an
    // earlier run exited the app and every later check read the launcher.
    await tapComposerUntilKeyboardUp();
    sh('input keyevent KEYCODE_BACK');
    const keyboard = await awaitKeyboard(false);

    if (!focus().includes(options.pkg)) {
      throw new Error(`back left the app: ${focus()}`);
    }

    const composer = pick(dumpUi(), 'Message');

    if (composer.bounds.bottom < display.height - 120) {
      throw new Error(`composer stayed ${display.height - composer.bounds.bottom}px above the bottom edge`);
    }

    return `keyboard inset ${keyboard.inset}, composer back at bottom ${composer.bounds.bottom}`;
  });

  await check('composer-card', async () => {
    const row = composerRow(dumpUi());

    if (row.bounds.left <= 0 || row.bounds.right >= display.width) {
      throw new Error(
        `composer spans the screen edge (${row.bounds.left}..${row.bounds.right} of ${display.width}), not a floating card`,
      );
    }

    // A card, not a toolbar: the children share one vertical band.
    const band = row.bounds.bottom - row.bounds.top;
    const tallest = Math.max(...row.parts.map((n) => n.bounds.bottom - n.bounds.top));

    if (band > tallest * 1.6) {
      throw new Error(
        `composer children span ${band}px vertically (tallest ${tallest}px) — they are not one card`,
      );
    }

    return `${row.parts.length} controls inset ${row.bounds.left}px from the left, ${display.width - row.bounds.right}px from the right, band ${row.bounds.top}..${row.bounds.bottom}`;
  });

  await check('settings-header', async () => {
    await gotoSettings();

    // The header names the screen, so this is the proof navigation happened —
    // looking only for the version would pass on the Chat screen too.
    const header = await waitFor(
      (nodes) => contains(nodes, `v${identity.version} · Settings`),
      `v${identity.version} · Settings`,
    );

    return `Settings header reads "${header.text}" at y ${header.bounds?.top}`;
  });

  await check('settings-field-reveal', async () => {
    await gotoSettings();

    // Provider cards hold their fields inline. The credential fields live in a
    // remote card below the fold, so scrolling them into view is what the
    // reveal-on-focus path has to handle — the old per-model editor had an
    // "Edit <model>" row to open, which no longer exists.
    const field = await findByScroll(
      (nodes) => nodes.find((n) => n.desc === 'API key ref'),
      'the API key ref field',
    );

    await tap(field);

    const keyboard = await awaitKeyboard(true);

    if (!keyboard.visible) {
      throw new Error('keyboard never appeared for the field');
    }

    const focused = await waitFor(
      (nodes) => nodes.find((n) => n.desc === 'API key ref'),
      'the focused API key ref field',
    );
    const gap = keyboard.top - focused.bounds.bottom;

    if (gap < 0) {
      throw new Error(
        `focused field is behind the keyboard: bottom ${focused.bounds.bottom}, keyboard top ${keyboard.top}`,
      );
    }

    return `focused field bottom ${focused.bounds.bottom}, keyboard top ${keyboard.top} (gap ${gap})`;
  });

  await check('settings-back-to-chat', async () => {
    await gotoChat();

    const composer = await waitFor(
      (nodes) => nodes.find((n) => n.desc === 'Message'),
      'the chat composer',
    );

    return `composer reachable again at y ${composer.bounds.top}`;
  });

  await check('free-model-badge', async () => {
    // Free models are listed rather than hidden, so the badge and the price line
    // are what tells them apart from a paid model that also needs a key.
    await gotoChat();
    await tap(pick(dumpUi(), 'Switch provider or model'));
    await waitFor((nodes) => contains(nodes, 'Switch model'), 'the model switcher');
    await tapContaining(dumpUi(), 'OpenCode Go');
    await replaceText(pick(dumpUi(), 'Search models'), 'free');

    const row = await waitFor(
      (nodes) => nodes.find((n) => n.clickable && /for chat, free model/.test(n.desc)),
      'a row labelled as a free model',
    );
    const badge = await waitFor((nodes) => nodes.find((n) => n.text === 'free'), 'the free badge');
    const price = findText(dumpUi(), /free \/ free per 1k/);

    await tap(pick(dumpUi(), 'Close model switcher'));

    if (!price) {
      throw new Error('the free row does not say what it costs');
    }

    return `${row.desc} · badge "${badge.text}" at y ${badge.bounds?.top} · ${price.text}`;
  });

  await check('vision-attach', async () => {
    // Image input has to be a real, tappable control on a vision model. The two
    // emoji buttons it replaced drew Android's own glyph colour, so a disabled
    // one looked enabled and a working one looked broken; there is now one
    // button with text, drawn only when the model declares vision.
    await gotoChat();
    await selectModel('OpenCode Go', 'mimo', /mimo/i);

    const chip = await waitFor((nodes) => findText(nodes, /mimo/i), 'the chip naming the model');
    const button = await waitFor(
      (nodes) => nodes.find((n) => n.desc === 'Add images from the gallery'),
      'the image button',
    );
    const row = composerRow(dumpUi());

    if (!button.clickable) {
      throw new Error(`the image button is not clickable: ${JSON.stringify(button)}`);
    }

    if (
      button.bounds.left < row.bounds.left ||
      button.bounds.right > row.bounds.right ||
      button.bounds.bottom > row.bounds.bottom
    ) {
      throw new Error(
        `image button [${button.bounds.left},${button.bounds.top},${button.bounds.right},${button.bounds.bottom}] sits outside the composer [${row.bounds.left},${row.bounds.top},${row.bounds.right},${row.bounds.bottom}]`,
      );
    }

    // Tapping it must hand the screen to the system picker, not do nothing.
    await tap(button);
    const picker = await waitForOtherActivity();

    sh('input keyevent KEYCODE_BACK');
    await waitFor(() => (focus().includes(options.pkg) ? true : null), 'the app after the picker');

    return `chip "${chip.text || chip.desc}" · "${button.desc}" at y ${button.bounds.top} inside the composer · picker ${picker}`;
  });

  await check('image-pick-preview', async () => {
    // The pick has to come back as a thumbnail the message will carry, not just
    // open a picker. The tile is tapped, `Done` pressed, and the app must then
    // show a removable attachment.
    await gotoChat();

    const button = await waitFor(
      (nodes) => nodes.find((n) => n.desc === 'Add images from the gallery'),
      'the image button',
    );
    await tap(button);
    await waitForOtherActivity();

    const picked = await drivePhotoPicker();
    const thumbnail = await waitFor(
      (nodes) => nodes.find((n) => /^Remove /.test(n.desc)),
      'the attachment thumbnail',
      10000,
    );
    const label = findText(dumpUi(), /image\/(jpeg|png)/);

    // Removing it must leave the composer with nothing pending.
    await tap(thumbnail);
    await waitFor(
      (nodes) => (findText(nodes, /^Remove /) === undefined ? true : null),
      'the attachment gone from the composer',
    );

    return `${thumbnail.desc} from "${picked}"${label ? ` · payload labelled "${label.text || label.desc}"` : ''}`;
  });

  // Only runs on request: it picks a real photo and spends a round trip.
  if (process.env.E2E_PROBE_IMAGE === '1') {
    await check('image-roundtrip', async () => {
      // Picking a photo is not proof it reached the model. The check drives the
      // whole path: pick, thumbnail, send, then read what the endpoint said.
      await gotoChat();
      await selectModel('OpenCode Go', 'mimo', /mimo/i);

      const button = await waitFor(
        (nodes) => nodes.find((n) => n.desc === 'Add images from the gallery'),
        'the image button',
      );
      await tap(button);
      await waitForOtherActivity();

      const picked = await drivePhotoPicker();
      const attachment = await waitFor(
        (nodes) => nodes.find((n) => /^Remove /.test(n.desc)),
        'the attachment thumbnail',
        10000,
      );

      sh('logcat -c');
      await tapComposerUntilKeyboardUp();
      await replaceText(pick(dumpUi(), 'Message'), 'What is in this image? Answer in one word.');
      // The composer moves when the keyboard opens, so the send button is re-read.
      await tap(pick(dumpUi(), 'Send message'));

      // The picture has to appear in the sent bubble: that is the converted
      // payload the request carried, not just a thumbnail in the composer. The
      // bubble draws the image, so either the accessibility label or an image
      // view inside the app's window counts as proof.
      const sent = await waitFor(
        (nodes) =>
          findText(nodes, /^Image \(image\//) ??
          nodes.find((n) => n.package === options.pkg && n.class.toLowerCase().includes('imageview')),
        'the image inside the sent message',
        20000,
      );

      // Either an answer with token counts, or a failure that names its cause. A
      // bare "An error occurred." is the bug this probe exists to catch.
      const outcome = await waitFor(
        (nodes) =>
          findText(nodes, /↑ [\d,]+ sent · ↓ [\d,]+ received/) ??
          findText(
            nodes,
            /HTTP \d{3}|server said|failed inside the response|blocked by the browser|network error|exceeds the context/i,
          ),
        'an answer or a named failure',
        90_000,
      );

      const line = outcome.text || outcome.desc;
      const proof = sent.desc || sent.text || sent.class;

      // The words the model wrote about the picture: proof it saw the image rather
      // than answering the text alone. The bubble's role label is the anchor, and
      // the footer and attachment are skipped because they are not the answer.
      const after = dumpUi();
      const anchor = after.findIndex((n) => n.text === 'assistant' || n.desc === 'assistant');
      const answer =
        anchor < 0
          ? undefined
          : after
              .slice(anchor + 1)
              .find((n) => n.package === options.pkg && n.text.length > 1 && !/^(↑|Image|Reasoning)/i.test(n.text));

      // `formatTokens` groups thousands, so the footer reads "↑ 5,900 sent".
      if (/^↑ [\d,]+ sent/.test(line)) {
        return `image round trip ok · "${attachment.desc}" from "${picked}" drawn as "${proof}" · ${line}${
          answer ? ` · answer: "${answer.text.slice(0, 120)}"` : ''
        }`;
      }

      const log = sh('logcat -d -t 200')
        .split('\n')
        .filter((entry) => /mobileopenllmclient|ImagePicker|HTTP|ai-sdk|Exception/i.test(entry))
        .slice(-6)
        .join(' / ');

      return `image rejected · "${attachment.desc}" from "${picked}" drawn as "${proof}" · screen says "${line}"${log ? ` · logcat: ${log}` : ''}`;
    });
  }

  // Only runs on request: it spends a real round trip and needs the saved Go key.
  if (process.env.E2E_PROBE_FREE === '1') {
    await check('free-tier-probe', async () => {
      await gotoChat();

      try {
        await selectModel('OpenCode Go', 'beam-free', /Beam Free/);

        const chip = await waitFor(
          (nodes) => findText(nodes, /free model · a gateway may still restrict/),
          'the chip naming the free tier',
        );

        if (findText(dumpUi(), /needs an API key/)) {
          throw new Error('OpenCode Go has no saved key — press Save key in Settings, then re-run');
        }

        await tapComposerUntilKeyboardUp();
        await replaceText(pick(dumpUi(), 'Message'), 'Reply with exactly OK.');
        await tap(pick(dumpUi(), 'Send message'));

        // Whatever the gateway decides, the screen has to name it: a status, or an
        // answer. A bare "network error" here would be the bug this probe exists to catch.
        const outcome = await waitFor(
          (nodes) => findText(nodes, /^OK$/) ?? findText(nodes, /HTTP \d{3}/),
          'an answer or a real HTTP status',
          60_000,
        );
        const line = outcome.text || outcome.desc;
        const usage = findText(dumpUi(), /↑ [\d,]+ sent · ↓ [\d,]+ received/);
        const detail = usage !== undefined ? `${line} (${usage.text})` : line;

        if (/^HTTP /.test(line)) {
          return `chip "${chip.text}" · free tier answered ${detail}`;
        }

        return `chip "${chip.text}" · free tier replied "${detail}"`;
      } finally {
        // Leave the provider on a paid model: a phone left on a restricted tier
        // would 403 on the next message the user types.
        await selectModel('OpenCode Go', 'deepseek', /DeepSeek/);
      }
    });
  }

  await check('no-crash', async () => {
    const crashes = sh('logcat -d -b crash -t 40');
    const fatal = crashes.match(/FATAL|ANR/, 'g');

    if (fatal) {
      throw new Error(`${fatal.join(', ')} in the crash buffer: ${crashes.slice(0, 300)}`);
    }

    return 'crash buffer empty';
  });

  const failed = results.filter((result) => !result.ok);

  console.log(`\n${results.length - failed.length}/${results.length} checks passed; shots in ${options.shots}`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

await main();
