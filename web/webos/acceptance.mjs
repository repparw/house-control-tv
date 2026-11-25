// From web/ with Node 24 and an installed recent Chromium or Chrome:
//   pnpm install --frozen-lockfile
//   pnpm run build:webos
//   pnpm run test:acceptance
// The browser is, in order: $CHROMIUM, the newest $HOME/.t3/tools/chrome-headless-shell
// (with $HOME/.t3/chrome-libs on LD_LIBRARY_PATH when present), then chromium,
// chromium-browser, google-chrome or google-chrome-stable on PATH. The test serves the packaged dist/
// (the input to ares-package) on loopback and uses a disposable browser profile.
// It imports an unlinked plan in the UI and requires no TV or Home Assistant.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants, existsSync, readdirSync } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { delimiter, extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const dist = new URL('../dist/', import.meta.url);
const html = await readFile(new URL('index.html', dist), 'utf8');
assert.match(html, /src="\.\/webostv\/webOSTV.js"/, 'Run pnpm run build:webos first');
for (const file of ['appinfo.json', 'webostv/webOSTV.js']) await readFile(new URL(file, dist));

async function executable(path) {
  return access(path, constants.X_OK).then(() => true, () => false);
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

export async function findChromium(env = process.env) {
  if (env.CHROMIUM) return { command: env.CHROMIUM, env };
  const home = env.HOME || homedir();
  const shells = join(home, '.t3', 'tools', 'chrome-headless-shell');
  if (existsSync(shells)) {
    const candidates = [];
    for (const entry of readdirSync(shells, { recursive: true, withFileTypes: true })) {
      const path = join(entry.parentPath, entry.name);
      const version = /(?:^|[\\/])(\d+(?:\.\d+){1,3})(?:[\\/]|$)/.exec(path.slice(shells.length))?.[1];
      if (entry.name === 'chrome-headless-shell' && !entry.isDirectory() && version && await executable(path)) {
        candidates.push({ path, version });
      }
    }
    candidates.sort((a, b) => compareVersions(b.version, a.version));
    if (candidates.length) {
      const libs = join(home, '.t3', 'chrome-libs');
      const libraryPath = existsSync(libs) ? [libs, env.LD_LIBRARY_PATH].filter(Boolean).join(delimiter) : env.LD_LIBRARY_PATH;
      return { command: candidates[0].path, env: { ...env, ...(libraryPath ? { LD_LIBRARY_PATH: libraryPath } : {}) } };
    }
  }
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    for (const dir of (env.PATH || '').split(delimiter).filter(Boolean)) {
      if (await executable(join(dir, name))) return { command: join(dir, name), env };
    }
  }
  throw new Error('No Chromium found. Fix: set CHROMIUM=/path/to/chromium, or install chromium or google-chrome on PATH.');
}

const plan = {
  version: 1,
  name: 'Two-floor acceptance home',
  levels: [{ id: 'ground', name: 'Ground' }, { id: 'upper', name: 'Upper' }],
  rooms: [
    { id: 'ground-room', name: 'Ground room', level: 'ground', rect: [0, 0, 5, 5], floor: 'walnut' },
    { id: 'upper-room', name: 'Upper room', level: 'upper', rect: [0, 0, 5, 5], floor: 'tile' },
  ],
  lights: [
    { id: 'ground-light', name: 'Ground lamp', room: 'ground-room', type: 'ceiling', pos: [2.5, 2.5] },
    { id: 'upper-light', name: 'Upper lamp', room: 'upper-room', type: 'ceiling', pos: [2.5, 2.5] },
  ],
};

const contentTypes = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png',
};
const server = createServer(async (request, response) => {
  const path = request.url === '/' ? 'index.html' : request.url.slice(1);
  if (!/^[\w-]+(?:\/[\w-]+)*\.[\w]+$/.test(path)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(new URL(path, dist));
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(path)] ?? 'application/octet-stream',
      'Content-Security-Policy': "connect-src 'self'; default-src 'self' 'unsafe-inline' data:",
    }).end(body);
  } catch {
    response.writeHead(404).end();
  }
});

async function until(label, condition) {
  const deadline = Date.now() + 15_000;
  do {
    const value = await condition();
    if (value) return value;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  const events = new EventTarget();
  const pending = new Map();
  let id = 0;
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) {
      events.dispatchEvent(new CustomEvent(message.method, { detail: message.params }));
      return;
    }
    const reply = pending.get(message.id);
    if (!reply) return;
    pending.delete(message.id);
    reply(message);
  });
  try {
    await once(socket, 'open', { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    socket.close();
    throw error;
  }
  return {
    socket,
    events,
    send(method, params = {}) {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Chromium did not answer ${method}`));
        }, 10_000);
        pending.set(requestId, ({ result, error }) => {
          clearTimeout(timer);
          if (error) reject(new Error(`${method}: ${error.message}`));
          else resolve(result);
        });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
    },
  };
}

function pixelDifference(a, b) {
  return a.reduce((total, value, index) => total + Math.abs(value - b[index]), 0) / a.length;
}

async function exercise({ send, events }, url, fixture) {
  const errors = [];
  events.addEventListener('Runtime.exceptionThrown', ({ detail: { exceptionDetails } }) => {
    errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text);
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
  });
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  await send('Page.navigate', { url });

  async function evaluate(expression) {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(result.description ?? exceptionDetails.text);
    return result.value;
  }

  async function press(key, code) {
    const event = { key, windowsVirtualKeyCode: code };
    await send('Input.dispatchKeyEvent', key === 'Enter'
      ? { ...event, type: 'keyDown', text: '\r' }
      : { ...event, type: 'rawKeyDown' });
    await send('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
  }

  const textIs = (selector, text) => evaluate(
    `document.querySelector(${JSON.stringify(selector)})?.textContent.trim() === ${JSON.stringify(text)}`,
  );
  const focusIs = name => evaluate(
    `(document.activeElement.matches('button') &&
      (document.activeElement.getAttribute('aria-label') || document.activeElement.textContent.trim())) === ${JSON.stringify(name)}`,
  );
  async function move(key, code, name) {
    await press(key, code);
    assert.ok(await focusIs(name), `Expected ${name} to have focus after ${key}`);
  }
  async function selectRoom(name) {
    await press('Enter', 13);
    await until(`${name} selected`, async () =>
      await textIs('h1', name) && await textIs('nav[aria-label="Rooms"] [aria-pressed="true"]', name));
  }
  async function backToWholeHome() {
    await press('BrowserBack', 461);
    await until('Back to select and focus Whole home', async () =>
      await focusIs('Whole home') && await textIs('h1', 'Whole home') &&
      await textIs('nav[aria-label="Rooms"] [aria-pressed="true"]', 'Whole home'));
  }

  await until('bundled demo and initial room focus', async () =>
    await textIs('#status', 'Demo · no real devices') && await focusIs('Whole home'));

  // webOS hides the app on Home and resumes it later. Demo must come back ready, not
  // offline (a9eeab9). Override document.hidden because headless Chromium never hides.
  const demoReady = `(() => { const s = document.querySelector('#status');
    return s.textContent.trim() === 'Demo · no real devices' && !s.classList.contains('offline'); })()`;
  assert.ok(await evaluate(demoReady), 'Expected the demo status to start ready');
  const setHidden = hidden => evaluate(`(() => {
    if (${hidden}) {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    } else {
      delete document.hidden;
      delete document.visibilityState;
    }
    document.dispatchEvent(new Event('visibilitychange'));
    return document.hidden === ${hidden};
  })()`);
  assert.ok(await setHidden(true), 'Could not emulate a hidden page');
  await until('demo paused while hidden', () => evaluate(
    `document.querySelector('#status').textContent.includes('in the background')`,
  ));
  assert.ok(await setHidden(false), 'Could not emulate a visible page');
  await until('demo status ready after resume (green, not offline)', () => evaluate(demoReady));
  await focusIs('Whole home') || await evaluate(`document.querySelector('[data-room="all"]').focus()`);
  assert.ok(await evaluate(`[...document.querySelectorAll('button')].some(button => {
    if (button.textContent.trim() !== 'Sync & connect' || !button.checkVisibility()) return false;
    button.click();
    return true;
  })`), 'Expected a visible Sync & connect button');
  const fileInput = 'input[aria-label="Import floor plan JSON"]';
  await until('visible floor-plan picker', () => evaluate(
    `document.querySelector(${JSON.stringify(fileInput)})?.checkVisibility()`,
  ));
  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: fileInput });
  // Setting the file through CDP drives the normal input/change and confirmation flow.
  await send('DOM.setFileInputFiles', { nodeId, files: [fixture] });
  await until('import confirmation', () => focusIs('Cancel'));
  assert.ok(await textIs('#webos-import-description', 'Replace the current floor plan with “Two-floor acceptance home”?'));
  await move('ArrowRight', 39, 'Replace floor plan');
  await press('Enter', 13);
  await until('imported room tabs and reset focus', async () =>
    await focusIs('Whole home') && await textIs('nav button:last-child', 'Upper room'));

  const canvas = 'canvas[aria-label="Interactive 3D home model"]';
  const renderer = await evaluate(`(() => {
    const gl = document.querySelector(${JSON.stringify(canvas)}).getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
  })()`);
  assert.match(renderer ?? '', /SwiftShader/i, 'Expected software WebGL on the model canvas');

  // Sample the middle of the composited model, below the caption and clear of
  // the orbit button. Screenshots also work with a discarded WebGL draw buffer.
  const clip = await evaluate(`(() => {
    const { x, y, width, height } = document.querySelector(${JSON.stringify(canvas)}).getBoundingClientRect();
    return { x: Math.round(x + width * .2), y: Math.round(y + height * .27),
      width: Math.round(width * .6), height: Math.round(height * .62), scale: 1 };
  })()`);
  async function frame() {
    const { data } = await send('Page.captureScreenshot', { clip });
    return evaluate(`(async () => {
      const bytes = Uint8Array.fromBase64(${JSON.stringify(data)});
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const context = new OffscreenCanvas(48, 32).getContext('2d');
      context.drawImage(image, 0, 0, 48, 32);
      image.close();
      return Array.from(context.getImageData(0, 0, 48, 32).data).filter((_, i) => i % 4 !== 3);
    })()`);
  }
  async function settledFrame(label) {
    let previous = await frame();
    let stable = 0;
    return until(`${label} rendering to settle`, async () => {
      const current = await frame();
      stable = pixelDifference(previous, current) < .25 ? stable + 1 : 0;
      previous = current;
      return stable >= 3 && current;
    });
  }

  const ground = await settledFrame('ground-floor overview');
  assert.ok(Math.max(...ground) - Math.min(...ground) > 35, 'Expected visible model detail');

  await move('ArrowRight', 39, 'Ground room');
  await move('ArrowRight', 39, 'Upper room');
  await selectRoom('Upper room');
  assert.equal(await evaluate('document.querySelectorAll("#device-list button").length'), 1);
  await move('ArrowDown', 40, 'Lighting');
  await move('ArrowDown', 40, 'Lights off');
  await move('ArrowDown', 40, 'Upper lamp, on');
  const lit = await settledFrame('lit upper room');
  await press('Enter', 13);
  await until('upper lamp off', () => evaluate(
    'document.activeElement.matches(\'button[aria-label="Upper lamp, off"][aria-pressed="false"]\')',
  ));
  const unlit = await settledFrame('unlit upper room');
  assert.ok(pixelDifference(lit, unlit) > 1, 'Turning off the upper lamp should visibly change its model');
  await press('Enter', 13);
  await until('upper lamp back on', () => evaluate(
    'document.activeElement.matches(\'button[aria-label="Upper lamp, on"][aria-pressed="true"]\')',
  ));

  // Back clears room focus while keeping the displayed floor. Compare identical
  // overview UI before and after changing floors to avoid mistaking a camera
  // close-up of a room for a floor transition.
  await backToWholeHome();
  const upper = await settledFrame('upper-floor overview');
  assert.ok(pixelDifference(ground, upper) > 3, 'Upper-floor overview should differ from ground');
  await move('ArrowRight', 39, 'Ground room');
  await selectRoom('Ground room');
  await until('ground lamp still on', () => evaluate(
    'document.querySelector(\'button[aria-label="Ground lamp, on"][aria-pressed="true"]\')?.checkVisibility()',
  ));
  await backToWholeHome();
  const restored = await settledFrame('restored ground-floor overview');
  assert.ok(pixelDifference(ground, restored) < 1, 'Expected the original ground-floor overview');
  assert.deepEqual(errors, [], 'Uncaught page errors');
}

const profile = await mkdtemp(join(tmpdir(), 'webos-acceptance-'));
let browser;
let exited;
let cdp;
let stderr = '';
try {
  const fixture = join(profile, 'two-floors.json');
  await writeFile(fixture, JSON.stringify(plan));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const chromium = await findChromium();
  console.log(`Chromium: ${chromium.command}`);
  browser = spawn(chromium.command, [
    // CI runners restrict unprivileged user namespaces, which Chrome's sandbox needs.
    ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    '--headless', '--ozone-platform=headless', '--no-first-run', '--disable-background-networking', '--disable-component-update',
    '--proxy-server=http://127.0.0.1:1', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], env: chromium.env });
  exited = new Promise(resolve => browser.once('close', resolve));
  let launchError;
  browser.on('error', error => { launchError = error; });
  browser.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const port = await until('Chromium debugging port', async () => {
    if (launchError) throw launchError;
    assert.equal(browser.exitCode, null, 'Chromium exited during startup');
    const contents = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
    return /^\d+/m.exec(contents)?.[0];
  });
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(5000),
  })).json();
  const page = targets.find(target => target.type === 'page' && target.url === 'about:blank');
  assert.ok(page, 'Expected a blank tab in the disposable Chromium profile');
  cdp = await connect(page.webSocketDebuggerUrl);
  await exercise(cdp, url, fixture);
  console.log('PASS packaged webOS UI: demo ready after hide/resume, SwiftShader render, room and floor navigation, Back, simulated light');
} catch (error) {
  if (stderr) console.error(stderr.trim());
  throw error;
} finally {
  cdp?.socket.close();
  if (browser) {
    browser.kill();
    const forceQuit = setTimeout(() => browser.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(forceQuit);
  }
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
