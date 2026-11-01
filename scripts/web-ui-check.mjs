/**
 * Headless browser check for the web build.
 *
 * Needs the dev server running:  yarn web
 * Then:                           yarn web:check /settings
 *
 * Drives Edge over Chrome DevTools Protocol (no extra dependency — Node 22
 * ships a global WebSocket). It loads a route, waits for the app to mount,
 * collects console output, optionally taps on a visible label, and writes a
 * screenshot of a phone-sized viewport so the UI can be reviewed without a
 * device.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

const DEV_SERVER = process.env.WEB_CHECK_BASE ?? 'http://localhost:8081';
/**
 * A per-run debugging port. Edge refuses to bind a port another (possibly
 * still-alive) Edge instance already holds, and then never exposes the
 * endpoint — an earlier run hung waiting on a port a leftover browser owned.
 */
const DEBUG_PORT = Number(process.env.WEB_CHECK_PORT ?? 9222 + (process.pid % 400));
const VIEWPORT = { width: 393, height: 852, deviceScaleFactor: 2 };
const EDGE_CANDIDATES = [
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** Flags: <route> --out=<file> --type=<text> --click-text=<label> --settle=<ms> --edge=<path> */
function parseArgs(argv) {
  const options = {
    route: '/',
    out: join(process.env.TEMP ?? '/tmp', 'web-check.png'),
    type: null,
    clickText: null,
    settle: 1500,
    edge: null,
  };

  for (const arg of argv) {
    if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length);
    } else if (arg.startsWith('--type=')) {
      options.type = arg.slice('--type='.length);
    } else if (arg.startsWith('--click-text=')) {
      options.clickText = arg.slice('--click-text='.length);
    } else if (arg.startsWith('--settle=')) {
      options.settle = Number(arg.slice('--settle='.length));
    } else if (arg.startsWith('--edge=')) {
      options.edge = arg.slice('--edge='.length);
    } else if (!arg.startsWith('--')) {
      options.route = arg;
    }
  }

  return options;
}

function findEdge(explicit) {
  if (explicit) {
    return explicit;
  }

  return EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
}

/**
 * Launches Edge with a debugging port and waits for the endpoint to answer.
 * The profile directory is per run: a previous run's Edge children can survive
 * `proc.kill()` and hold the profile lock, and a second Edge pointed at a
 * locked profile never opens the debugging port — that is how a run hung.
 * @returns {{ proc: import('node:child_process').ChildProcess, endpoint: string, profileDir: string }}
 */
async function launchEdge(edgePath) {
  const profileDir = join(
    process.env.TEMP ?? '/tmp',
    `edge-profile-${DEBUG_PORT}-${process.pid}-${Date.now()}`,
  );

  const proc = spawn(edgePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--hide-scrollbars',
  ]);
  proc.on('error', (error) => {
    console.error(`could not start Edge: ${error.message}`);
  });

  const endpoint = `http://127.0.0.1:${DEBUG_PORT}`;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) {
        return { proc, endpoint, profileDir };
      }
    } catch {
      // The port is not listening yet.
    }

    await sleep(250);
  }

  killTree(proc);
  throw new Error(`Edge debugging port ${DEBUG_PORT} never came up`);
}

/**
 * Kills Edge and its children. `proc.kill()` only stops the browser process;
 * renderer and GPU processes linger and keep the profile directory locked.
 */
function killTree(proc) {
  if (!proc.pid) {
    proc.kill();

    return;
  }

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      proc.kill();
    }

    return;
  }

  proc.kill('SIGKILL');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Every CDP round trip is bounded, so a page that never answers cannot hang. */
const COMMAND_TIMEOUT = Number(process.env.WEB_CHECK_TIMEOUT ?? 60_000);

/** Minimal CDP client: promise per command, console events collected. */
async function connectPage(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let seq = 0;
  const pending = new Map();
  const logs = [];

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);

    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      pending.delete(message.id);

      if (!entry) {
        return;
      }

      if (message.error) {
        entry.reject(new Error(`${message.error.message}`));
      } else {
        entry.resolve(message.result);
      }

      return;
    }

    if (message.method === 'Runtime.consoleAPICalled') {
      logs.push(
        `${message.params.type}: ${message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`,
      );
    } else if (message.method === 'Runtime.exceptionThrown') {
      logs.push(`exception: ${message.params.exceptionDetails.exception?.description ?? 'unknown'}`);
    } else if (message.method === 'Log.entryAdded') {
      logs.push(`${message.params.entry.level}: ${message.params.entry.text}`);
    }
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP socket never opened')), COMMAND_TIMEOUT);

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('CDP socket failed'));
    });
  });

  return {
    logs,
    command(method, params = {}) {
      const id = ++seq;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} did not answer within ${COMMAND_TIMEOUT}ms`));
        }, COMMAND_TIMEOUT);

        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression, { awaitPromise = false } = {}) {
      const result = await this.command('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise,
      });

      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? 'eval failed');
      }

      return result.result.value;
    },
    close() {
      socket.close();
    },
  };
}

/** Taps the centre of the first element whose visible text contains `label`. */
async function clickText(page, label) {
  const rect = await page.evaluate(
    `(() => {
      const nodes = [...document.querySelectorAll('div,span,p,a,button')];
      const hit = nodes.find((n) => n.textContent.trim() === ${JSON.stringify(label)});
      if (!hit) return null;
      hit.scrollIntoView({ block: 'center' });
      const box = hit.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`,
  );

  if (!rect) {
    throw new Error(`no element with text "${label}"`);
  }

  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.command('Input.dispatchMouseEvent', {
      type,
      x: rect.x,
      y: rect.y,
      button: 'left',
      clickCount: 1,
    });
  }
}

/** Focuses the message box and types into it, so React sees real input events. */
async function typeIntoInput(page, text) {
  const focused = await page.evaluate(
    `(() => {
      const input = document.querySelector('input,textarea');
      if (!input) return false;
      input.focus();
      return true;
    })()`,
  );

  if (!focused) {
    throw new Error('no text input on this screen');
  }

  await page.command('Input.insertText', { text });
}

const options = parseArgs(process.argv.slice(2));
const edge = findEdge(options.edge);

if (!edge) {
  throw new Error('Microsoft Edge not found; pass --edge=<path to msedge.exe>');
}

const { proc, endpoint, profileDir } = await launchEdge(edge);
const targets = await (await fetch(`${endpoint}/json/list`)).json();
const page = targets.find((target) => target.type === 'page');

if (!page?.webSocketDebuggerUrl) {
  killTree(proc);
  throw new Error('no page target exposed by Edge');
}

const session = await connectPage(page.webSocketDebuggerUrl);

try {
  console.log(`route ${options.route}`);

  await session.command('Page.enable');
  await session.command('Runtime.enable');
  await session.command('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, mobile: true });

  await session.command('Page.navigate', { url: `${DEV_SERVER}${options.route}` });

  // Wait for the app to mount (and for SQLite/SecureStore init to settle).
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const mounted = await session.evaluate(
      `document.querySelector('#root')?.childElementCount ?? document.body.childElementCount`,
    );

    if (mounted > 0) {
      break;
    }

    await sleep(500);
  }

  await session.evaluate(`new Promise((r) => setTimeout(r, ${options.settle}))`, {
    awaitPromise: true,
  });

  if (options.type) {
    try {
      await typeIntoInput(session, options.type);
      // React needs one commit before the send button reflects the text.
      await sleep(300);
    } catch (error) {
      console.error(`typing failed: ${error.message}`);
    }
  }

  if (options.clickText) {
    try {
      await clickText(session, options.clickText);
      await sleep(options.settle);
    } catch (error) {
      console.error(`click failed: ${error.message}`);
    }
  }

  const shot = await session.command('Page.captureScreenshot', { format: 'png' });
  const path = isAbsolute(options.out) ? options.out : join(process.cwd(), options.out);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(shot.data, 'base64'));

  const nodes = await session.evaluate(`document.querySelectorAll('#root *').length`);
  const body = await session.evaluate(`document.body.childElementCount`);

  console.log(`mounted: ${nodes} nodes under #root, ${body} children of body`);
  console.log(`screenshot ${path}`);

  if (session.logs.length > 0) {
    console.log(`console (${session.logs.length}):`);
    session.logs.slice(0, 20).forEach((line) => console.log(`  ${line}`));
  }
} finally {
  session.close();
  killTree(proc);

  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    // Edge can still hold the profile open for a moment; a leftover temp dir is harmless.
  }
}
