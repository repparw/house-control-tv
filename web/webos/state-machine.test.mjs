// Model-checks the webOS adapter (src/webos.js) together with the credential store
// (src/webos-credentials.js) the way src/main.js drives them. A breadth-first search
// explores mode (demo|standalone) x visibility x connection state x key-cleanup failure
// and checks every invariant after every step. Regressions it pins:
//   a9eeab9  demo mode must stay control-ready after hide and resume
//   5531829  disconnect forgets the encrypted record even when removeKey fails
//   offline linked devices reject commands; simulated devices stay controllable
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createHACredentialStore } from '../src/webos-credentials.js';

const TOKEN = 'statemachine-sentinel-token-0000000000';
const RECORD = 'house-control-ha-encrypted-v1';
const STATES = ['demo', 'disconnected', 'connecting', 'connected', 'offline', 'paused', 'unauthorized'];

const plan = name => ({
  version: 1,
  name,
  rooms: [{ id: 'room', name: 'Room', rect: [0, 0, 5, 5], floor: 'oak' }],
  lights: [
    { id: 'sim', name: 'Simulated lamp', room: 'room', type: 'ceiling', pos: [1, 1] },
    { id: 'linked', name: 'Linked lamp', room: 'room', type: 'pendant', pos: [2, 1], link: { service: 'homeassistant', id: 'light.linked' } },
  ],
  acs: [],
  scenes: [],
});

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
};

// Home Assistant server double. `mode` decides how new sockets behave.
class FakeSocket {
  static mode = 'ok'; // ok | reject | down | hang
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    FakeSocket.all.push(this);
    const mode = FakeSocket.mode;
    if (mode === 'down') queueMicrotask(() => { this.onerror?.(); this.close(); });
    else if (mode !== 'hang') queueMicrotask(() => this.emit({ type: 'auth_required' }));
    this.mode = mode;
  }
  static open() { return FakeSocket.all.filter(socket => socket.readyState === 1); }
  emit(message) { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(message) }); }
  send(text) {
    const message = JSON.parse(text);
    const reply = result => queueMicrotask(() => this.emit({ id: message.id, type: 'result', success: true, result }));
    if (message.type === 'auth') queueMicrotask(() => this.emit({ type: this.mode === 'reject' ? 'auth_invalid' : 'auth_ok' }));
    else if (message.type === 'subscribe_events') reply(null);
    else if (message.type === 'get_states') reply([{ entity_id: 'light.linked', state: 'on', attributes: { brightness: 255 }, last_updated: new Date().toISOString() }]);
    else reply(null);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
}

// Keymanager3 double with real AES-GCM so the store's round-trip verification runs.
function fakeKeymanager() {
  let key;
  let operation;
  const platform = {
    failRemoveKey: false,
    hasKey: () => Boolean(key),
    async request(method, { params, data }) {
      if (method === 'generateKey') {
        if (key) throw Object.assign(new Error(), { code: -10002 });
        key = randomBytes(32);
      } else if (method === 'begin') {
        const iv = params.iv ? Buffer.from(params.iv, 'base64') : randomBytes(12);
        operation = { iv, purpose: params.purpose[0] };
        return { returnValue: true, handle: '7', iv: iv.toString('base64') };
      } else if (method === 'finish') {
        const input = Buffer.from(data, 'base64');
        if (operation.purpose === 'encrypt') {
          const cipher = createCipheriv('aes-256-gcm', key, operation.iv);
          return { returnValue: true, output: Buffer.concat([cipher.update(input), cipher.final(), cipher.getAuthTag()]).toString('base64') };
        }
        const decipher = createDecipheriv('aes-256-gcm', key, operation.iv);
        decipher.setAuthTag(input.subarray(-16));
        return { returnValue: true, output: Buffer.concat([decipher.update(input.subarray(0, -16)), decipher.final()]).toString('base64') };
      } else if (method === 'removeKey') {
        if (platform.failRemoveKey) throw Object.assign(new Error('LG internal error'), { code: -1 });
        if (!key) throw Object.assign(new Error(), { code: -10001 });
        key = undefined;
      }
      return { returnValue: true };
    },
  };
  return platform;
}

let instance = 0;
async function freshAdapter() {
  return (await import(`../src/webos.js?state-machine=${++instance}`)).webosAPI;
}

// Mirrors the src/main.js flows that touch the adapter and the credential store.
async function createWorld() {
  const storage = new Map();
  const writes = [];
  globalThis.localStorage = {
    getItem: id => storage.get(id) ?? null,
    setItem: (id, value) => { writes.push([id, String(value)]); storage.set(id, String(value)); },
    removeItem: id => storage.delete(id),
  };
  globalThis.WebSocket = FakeSocket;
  globalThis.fetch = async () => ({ ok: true, json: async () => plan('Bundled demo') });
  FakeSocket.mode = 'ok';
  FakeSocket.all = [];
  const keymanager = fakeKeymanager();
  const world = {
    storage, writes, keymanager, visible: true, lastDisconnect: null,
    api: await freshAdapter(),
    store: createHACredentialStore({ request: keymanager.request, storage: globalThis.localStorage }),
  };
  await world.api('/api/home');
  return world;
}

// Runs a promise that may hang (a silent server) without blocking the search.
async function settle(promise) {
  const outcome = promise.then(value => ({ value }), error => ({ error }));
  return Promise.race([outcome, flush().then(() => ({ pending: true }))]);
}

const ACTIONS = {
  async hide(w) { w.visible = false; await settle(w.api('/api/webos/visibility', { visible: false })); },
  async show(w) { w.visible = true; await settle(w.api('/api/webos/visibility', { visible: true })); },
  async connect(w) {
    const result = await settle(w.api('/api/webos/ha/connect', { url: '192.168.0.20', token: TOKEN }));
    if (result.value?.connected) await w.store.save({ url: '192.168.0.20', token: TOKEN }).catch(() => {});
  },
  async disconnect(w) { await disconnect(w, false); },
  async disconnectKeyFailure(w) { await disconnect(w, true); },
  async drop() { for (const socket of FakeSocket.open()) socket.close(); await flush(); },
  async serverOk() { FakeSocket.mode = 'ok'; },
  async serverRejects() { FakeSocket.mode = 'reject'; },
  async serverDown() { FakeSocket.mode = 'down'; },
  async serverSilent() { FakeSocket.mode = 'hang'; },
  async retry() { mock.timers.tick(31_000); await flush(); },
  async reload(w) {
    // The old page is gone: stop its connection before the new instance boots.
    await settle(w.api('/api/webos/visibility', { visible: false }));
    w.api = await freshAdapter();
    w.store = createHACredentialStore({ request: w.keymanager.request, storage: globalThis.localStorage });
    w.visible = true;
    await w.api('/api/home');
    const saved = await w.store.load().catch(() => null);
    if (saved) await settle(w.api('/api/webos/ha/connect', saved));
  },
  // Buttons in the UI can be pressed only while the app is visible.
  async importPlan(w) { if (!w.visible) return; await w.api('/api/import', { plan: plan('Imported home'), confirm: true }); },
  async resetDemo(w) {
    if (!w.visible) return;
    try { await w.store.clear(); } catch { return; }
    await w.api('/api/demo', { enabled: true });
  },
};

// src/main.js offers Disconnect only while connected or reconnecting.
async function disconnect(w, keyFailure) {
  const status = await w.api('/api/webos/ha/status');
  if (!w.visible || (!status.connected && !status.reconnecting)) return;
  w.keymanager.failRemoveKey = keyFailure;
  await settle(w.api('/api/webos/ha/disconnect', {}));
  const cleared = await w.store.clear().then(() => true, () => false);
  w.keymanager.failRemoveKey = false;
  w.lastDisconnect = { keyFailure, cleared, step: w.step };
}

async function snapshot(w) {
  const home = await w.api('/api/home');
  const status = await w.api('/api/webos/ha/status');
  return { home, status };
}

async function checkInvariants(w, path) {
  const where = `after ${path.join(' → ') || 'boot'}`;
  const { home, status } = await snapshot(w);
  const state = home.connection.state;
  const linked = home.state.lights.linked;
  const sim = home.state.lights.sim;

  assert.ok(STATES.includes(state), `${where}: unknown connection state ${state}`);
  assert.equal(home.controlReady, state === 'connected' || state === 'demo',
    `${where}: controlReady must be true exactly in connected and demo (a9eeab9); state=${state}`);
  if (home.mode === 'demo') {
    assert.equal(state, w.visible ? 'demo' : 'paused', `${where}: demo mode must be demo when visible and paused when hidden`);
  }
  if (home.mode === 'demo' && w.visible) {
    assert.equal(home.controlReady, true, `${where}: demo must stay control-ready after resume (a9eeab9)`);
  }
  assert.equal(home.connection.foreground, w.visible, `${where}: adapter foreground must follow visibility`);
  if (!w.visible) {
    assert.equal(state, 'paused', `${where}: hidden app must be paused without a live connection`);
    assert.equal(FakeSocket.open().length, 0, `${where}: hidden app left a Home Assistant socket open`);
  }
  assert.equal(home.connection.connected, state === 'connected', `${where}: connection.connected disagrees with state`);
  assert.equal(status.connected, state === 'connected', `${where}: status.connected disagrees with state`);
  assert.ok(FakeSocket.open().length <= 1, `${where}: more than one Home Assistant socket is open`);
  if (state === 'connected') assert.equal(FakeSocket.open().length, 1, `${where}: connected without an open socket`);
  if (state === 'unauthorized') assert.equal(status.reconnecting, false, `${where}: unauthorized must not retry`);
  if (status.reconnecting) assert.equal(state, 'offline', `${where}: only offline may report reconnecting`);

  // Disconnect always forgets the saved credentials, even if Keymanager3 cleanup failed (5531829).
  if (w.lastDisconnect?.step === path.length) {
    assert.equal(w.storage.has(RECORD), false,
      `${where}: disconnect left the encrypted record (keyFailure=${w.lastDisconnect.keyFailure}) (5531829)`);
    assert.equal(await createHACredentialStore({ request: w.keymanager.request, storage: globalThis.localStorage }).load(), null,
      `${where}: credentials survive disconnect and would reconnect after reload (5531829)`);
  }

  for (const [id, value] of [...w.writes, ...w.storage]) {
    assert.ok(!value.includes(TOKEN) && !id.includes(TOKEN), `${where}: plaintext HA token written to localStorage key ${id}`);
  }

  assert.equal(sim.controlEnabled, true, `${where}: simulated devices must stay controllable`);
  assert.equal(linked.controlEnabled, state === 'connected', `${where}: linked control must require a live connection; state=${state}`);
  const on = !sim.on;
  const result = await w.api('/api/action', { kind: 'light', id: 'sim', on });
  assert.equal(result.home.state.lights.sim.on, on, `${where}: simulated light ignored a command`);
  if (state !== 'connected') {
    await assert.rejects(w.api('/api/action', { kind: 'light', id: 'linked', on: !linked.on }), { code: 'OFFLINE' },
      `${where}: offline linked device accepted a command`);
  }
  return { mode: home.mode, visible: w.visible, state };
}

async function replay(path) {
  // Drop timers left by earlier replays so their adapters cannot reconnect into this one.
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout'] });
  const world = await createWorld();
  let observed = await checkInvariants(world, []);
  for (let i = 0; i < path.length; i++) {
    world.step = i + 1;
    await ACTIONS[path[i]](world);
    observed = await checkInvariants(world, path.slice(0, i + 1));
  }
  for (const socket of FakeSocket.open()) { socket.onclose = null; socket.readyState = 3; }
  return { world, observed };
}

async function abstractKey(world, observed) {
  const status = await world.api('/api/webos/ha/status');
  return JSON.stringify({
    ...observed, server: FakeSocket.mode, record: world.storage.has(RECORD), key: world.keymanager.hasKey(),
    plan: (await world.api('/api/home')).plan.name, sockets: FakeSocket.open().length, reconnecting: status.reconnecting,
  });
}

function withTimers(fn) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try { await fn(); } finally { mock.timers.reset(); }
  };
}

test('breadth-first search holds every invariant across the reachable state space', { timeout: 120_000 }, withTimers(async () => {
  const MAX_DEPTH = 6;
  const seen = new Set();
  const covered = new Set();
  const queue = [[]];
  while (queue.length) {
    const path = queue.shift();
    const { world, observed } = await replay(path);
    covered.add(`${observed.mode}/${observed.visible ? 'visible' : 'hidden'}/${observed.state}`);
    const key = await abstractKey(world, observed);
    if (seen.has(key) || path.length >= MAX_DEPTH) continue;
    seen.add(key);
    for (const action of Object.keys(ACTIONS)) queue.push([...path, action]);
  }
  const required = [
    'demo/visible/demo', 'demo/hidden/paused',
    'standalone/visible/disconnected', 'standalone/visible/connecting', 'standalone/visible/connected',
    'standalone/visible/offline', 'standalone/visible/unauthorized',
    'standalone/hidden/paused',
  ];
  for (const combination of required) assert.ok(covered.has(combination), `search never reached ${combination}; extend ACTIONS`);
  assert.ok(seen.size > 100, `search explored only ${seen.size} abstract states; check that ACTIONS still change state`);
}));

test('demo stays control-ready through repeated hide and resume (a9eeab9)', withTimers(async () => {
  await replay(['hide', 'show', 'hide', 'show', 'reload', 'hide', 'show']);
}));

test('disconnect forgets credentials when removeKey fails, including after reload (5531829)', withTimers(async () => {
  const { world } = await replay(['importPlan', 'connect', 'disconnectKeyFailure', 'reload']);
  assert.deepEqual(world.lastDisconnect, { keyFailure: true, cleared: false, step: 3 }, 'the Keymanager3 failure must surface to the UI');
  assert.equal((await world.api('/api/webos/ha/status')).state, 'disconnected');
}));

test('offline and paused linked devices reject commands while simulated devices respond', withTimers(async () => {
  await replay(['importPlan', 'connect', 'serverDown', 'drop', 'retry', 'hide', 'show', 'serverOk', 'retry']);
}));
