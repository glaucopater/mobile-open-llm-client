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
    clickable: attrs.clickable === 'true',
    bounds: rect
      ? { left: Number(rect[1]), top: Number(rect[2]), right: Number(rect[3]), bottom: Number(rect[4]) }
      : null,
  };
}

function dumpUi() {
  sh(`uiautomator dump ${UI_PATH}`);
  const xml = sh(`cat ${UI_PATH}`);
  const nodes = [...xml.matchAll(/<node\b[^>]*>/g)].map((match) => parseNode(match[0]));

  if (options.trace) {
    const labels = nodes
      .filter((n) => n.text !== '' || n.desc !== '')
      .map((n) => `${n.text || n.desc} [${n.bounds.left},${n.bounds.top},${n.bounds.right},${n.bounds.bottom}]`)
      .slice(0, 12);

    console.log(`  screen: ${labels.join(' / ')}`);
  }

  return nodes;
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
async function waitFor(predicate, description, timeout = 5000) {
  const deadline = Date.now() + timeout;

  for (;;) {
    const hit = predicate(dumpUi());

    if (hit) {
      return hit;
    }

    if (Date.now() > deadline) {
      throw new Error(`${description} never appeared (waited ${timeout}ms)`);
    }

    await sleep(250);
  }
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

/** Navigates to Settings if not already there, so `--only=` runs stand alone. */
async function gotoSettings() {
  if (!contains(dumpUi(), 'Models')) {
    await tap(pick(dumpUi(), 'Settings'));
  }

  await waitFor((nodes) => contains(nodes, 'Models'), 'the Settings screen');
}

/** Back to Chat, likewise. */
async function gotoChat() {
  if (!contains(dumpUi(), `v${identity.version} · Chat`)) {
    await tap(pick(dumpUi(), 'Chat'));
  }

  await waitFor((nodes) => contains(nodes, `v${identity.version} · Chat`), 'the Chat screen');
}

/** Scrolls a list down by one screen; adb swipes, the app does the rest. */
async function scrollDown() {
  const x = Math.round(display.width / 2);

  sh(`input swipe ${x} 1700 ${x} 500 400`);
  await sleep(options.wait);
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

    return `top bar shows ${identity.name} · v${identity.version} + icon at y ${name.bounds?.top}`;
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
    const composer = pick(dumpUi(), 'Message');

    if (!composer.bounds) {
      throw new Error('composer has no bounds');
    }

    if (composer.bounds.left <= 0 || composer.bounds.right >= display.width) {
      throw new Error(
        `composer spans the screen edge (${composer.bounds.left}..${composer.bounds.right} of ${display.width}), not a floating card`,
      );
    }

    return `composer inset ${composer.bounds.left}px from the left, ${display.width - composer.bounds.right}px from the right`;
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

    const edit = await waitFor(
      (nodes) => nodes.find((n) => n.desc.startsWith('Edit ')),
      'a model row to edit',
    );

    await tap(edit);

    // The editor sits below the model list, so its lower fields start off-screen;
    // scrolling them into view is what the reveal-on-focus path has to handle.
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
