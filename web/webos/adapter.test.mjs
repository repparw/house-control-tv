import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webosAPI } from '../src/webos.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function plan() {
  return {
    version: 1,
    name: 'Adapter test home',
    rooms: [{ id: 'room', name: 'Room', rect: [0, 0, 5, 5], floor: 'oak' }],
    lights: [
      { id: 'sim', name: 'Simulated lamp', room: 'room', type: 'ceiling', pos: [1, 1] },
      { id: 'ha', name: 'Linked lamp', room: 'room', type: 'pendant', pos: [2, 1], link: { service: 'homeassistant', id: 'light.ha' } },
    ],
    acs: [],
    scenes: [
      { id: 'all-on', name: 'All on', lights: { '*': { on: true } } },
      { id: 'toggle', name: 'Toggle', toggle: true, lights: { sim: { on: true } } },
    ],
  };
}

class FakeSocket {
  static instances = [];
  static states = [];
  static failEntities = new Set();
  static snapshotTime = new Date().toISOString();

  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    this.closed = false;
    FakeSocket.instances.push(this);
    queueMicrotask(() => this.emit({ type: 'auth_required' }));
  }

  emit(message) { this.onmessage?.({ data: JSON.stringify(message) }); }

  send(value) {
    const message = JSON.parse(value);
    this.sent.push(message);
    if (message.type === 'auth') queueMicrotask(() => this.emit({ type: 'auth_ok' }));
    else if (message.type === 'subscribe_events') {
      this.subscriptionId = message.id;
      queueMicrotask(() => this.emit({ id: message.id, type: 'result', success: true, result: null }));
    } else if (message.type === 'get_states') {
      queueMicrotask(() => this.emit({ id: message.id, type: 'result', success: true, result: structuredClone(FakeSocket.states) }));
    } else if (message.type === 'call_service') {
      const entityId = message.service_data?.entity_id;
      queueMicrotask(() => this.emit(entityId && FakeSocket.failEntities.has(entityId)
        ? { id: message.id, type: 'result', success: false, error: { message: 'The entity rejected the command.' } }
        : { id: message.id, type: 'result', success: true, result: null }));
    }
  }

  emitState(entityId, state, timestamp = new Date().toISOString()) {
    this.emit({
      type: 'event',
      id: this.subscriptionId,
      event: {
        event_type: 'state_changed',
        data: {
          entity_id: entityId,
          new_state: { entity_id: entityId, state, attributes: {}, last_updated: timestamp },
        },
      },
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
}

function useStorage() {
  const saved = new Map();
  globalThis.localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key),
  };
  return saved;
}

async function install(planValue = plan(), states = [
  { entity_id: 'light.ha', state: 'off', attributes: {}, last_updated: new Date().toISOString() },
]) {
  useStorage();
  globalThis.WebSocket = FakeSocket;
  globalThis.fetch = async () => ({ ok: true, json: async () => structuredClone(planValue) });
  FakeSocket.instances = [];
  FakeSocket.states = structuredClone(states);
  FakeSocket.failEntities = new Set();
  FakeSocket.snapshotTime = new Date().toISOString();
  await webosAPI('/api/home');
  await webosAPI('/api/import', { plan: planValue, confirm: true });
}

async function connect() {
  return webosAPI('/api/webos/ha/connect', { url: '192.168.0.20', token: 'z'.repeat(40) });
}

test('foreground lifecycle closes Home Assistant and reconnects with a fresh snapshot', async () => {
  await install();
  await connect();
  assert.equal(FakeSocket.instances.length, 1);
  assert.equal((await webosAPI('/api/webos/ha/status')).state, 'connected');

  const hidden = await webosAPI('/api/webos/visibility', { visible: false });
  assert.equal(hidden.state, 'paused');
  assert.equal(hidden.reconnecting, false);
  assert.equal(FakeSocket.instances[0].readyState, 3);

  const resumed = await webosAPI('/api/webos/visibility', { visible: true });
  assert.equal(resumed.state, 'connected');
  assert.equal(FakeSocket.instances.length, 2);
  assert.equal(FakeSocket.instances[1].sent.filter(message => message.type === 'get_states').length, 1);
  await webosAPI('/api/webos/ha/disconnect', {});
});

test('offline linked devices stay stale while simulated devices remain controllable', async () => {
  await install();
  await connect();
  const socket = FakeSocket.instances[0];
  socket.emitState('light.ha', 'on');
  await tick();

  let current = await webosAPI('/api/home');
  assert.equal(current.state.lights.ha.on, true);
  assert.equal(current.state.lights.ha.status, 'live');

  socket.close();
  await tick();
  current = await webosAPI('/api/home');
  assert.equal(current.state.lights.ha.on, true);
  assert.equal(current.state.lights.ha.stale, true);
  assert.equal(current.state.lights.ha.online, false);
  assert.equal(current.state.lights.ha.controlEnabled, false);
  assert.equal(current.connection.state, 'offline');

  await assert.rejects(webosAPI('/api/action', { kind: 'light', id: 'ha', on: false }), /Connect Home Assistant/);
  const simulated = await webosAPI('/api/action', { kind: 'light', id: 'sim', on: false });
  assert.equal(simulated.home.state.lights.sim.on, false);
  assert.equal(simulated.home.state.lights.sim.simulated, true);
  assert.equal(simulated.home.state.lights.sim.controlEnabled, true);
  await webosAPI('/api/webos/ha/disconnect', {});
});

test('plan replacement requires confirmation, preserves compatible simulation and keeps the HA connection', async () => {
  await install();
  await connect();
  await webosAPI('/api/action', { kind: 'light', id: 'sim', on: false });
  const serviceCalls = FakeSocket.instances[0].sent.filter(message => message.type === 'call_service').length;

  const replacement = structuredClone(plan());
  replacement.name = 'Confirmed replacement';
  const preview = await webosAPI('/api/webos/plan/preview', { plan: replacement });
  assert.equal(preview.requiresConfirmation, true);
  await assert.rejects(
    webosAPI('/api/import', { plan: replacement }),
    error => error.code === 'PLAN_CONFIRMATION_REQUIRED' && error.details.valid === true,
  );
  await assert.rejects(webosAPI('/api/import', { plan: { rooms: [] }, confirm: true }), /Plan needs at least one room/);
  assert.equal((await webosAPI('/api/home')).plan.name, 'Adapter test home');

  const imported = await webosAPI('/api/import', { plan: replacement, confirm: true });
  assert.equal(imported.home.plan.name, 'Confirmed replacement');
  assert.equal(imported.home.state.lights.sim.on, false);
  assert.equal((await webosAPI('/api/webos/ha/status')).connected, true);
  assert.equal(FakeSocket.instances[0].sent.filter(message => message.type === 'call_service').length, serviceCalls);
  await webosAPI('/api/webos/ha/disconnect', {});
});

test('optimistic commands stay pending until authoritative state confirms them', async () => {
  await install();
  await connect();
  const socket = FakeSocket.instances[0];

  const accepted = await webosAPI('/api/action', { kind: 'light', id: 'ha', on: true });
  assert.equal(accepted.home.state.lights.ha.on, true);
  assert.equal(accepted.home.state.lights.ha.pending, true);
  assert.equal(accepted.home.operation.status, 'pending');

  socket.emitState('light.ha', 'on');
  await tick();
  let current = await webosAPI('/api/home');
  assert.equal(current.state.lights.ha.pending, false);
  assert.equal(current.state.lights.ha.error, null);
  assert.equal(current.operation.status, 'complete');

  await webosAPI('/api/action', { kind: 'light', id: 'ha', on: false });
  socket.emitState('light.ha', 'on');
  await tick();
  current = await webosAPI('/api/home');
  assert.equal(current.state.lights.ha.on, true);
  assert.equal(current.state.lights.ha.pending, false);
  assert.match(current.state.lights.ha.error, /changed by Home Assistant/);
  await webosAPI('/api/webos/ha/disconnect', {});
});

test('a newer command is not overwritten by an older state event', async () => {
  const old = new Date(Date.now() - 10000).toISOString();
  await install(plan(), [{ entity_id: 'light.ha', state: 'off', attributes: {}, last_updated: old }]);
  await connect();
  const socket = FakeSocket.instances[0];

  await webosAPI('/api/action', { kind: 'light', id: 'ha', on: true });
  await webosAPI('/api/action', { kind: 'light', id: 'ha', on: false });
  socket.emitState('light.ha', 'on', new Date(Date.now() - 2000).toISOString());
  await tick();
  let current = await webosAPI('/api/home');
  assert.equal(current.state.lights.ha.on, false);
  assert.equal(current.state.lights.ha.pending, true);

  socket.emitState('light.ha', 'off');
  await tick();
  current = await webosAPI('/api/home');
  assert.equal(current.state.lights.ha.on, false);
  assert.equal(current.state.lights.ha.pending, false);
  await webosAPI('/api/webos/ha/disconnect', {});
});

test('scene failures are per device, do not roll back successes and do not select a partial scene', async () => {
  const value = plan();
  value.lights.push({
    id: 'ha2', name: 'Second linked lamp', room: 'room', type: 'table', pos: [3, 1],
    link: { service: 'homeassistant', id: 'light.ha2' },
  });
  const now = new Date().toISOString();
  await install(value, [
    { entity_id: 'light.ha', state: 'off', attributes: {}, last_updated: now },
    { entity_id: 'light.ha2', state: 'off', attributes: {}, last_updated: now },
  ]);
  await connect();
  FakeSocket.failEntities.add('light.ha2');
  const socket = FakeSocket.instances[0];

  await webosAPI('/api/action', { kind: 'scene', id: 'all-on' });
  await tick();
  socket.emitState('light.ha', 'on');
  await tick();
  await tick();

  const operation = await webosAPI('/api/webos/operation');
  assert.equal(operation.status, 'partial');
  assert.equal(operation.failures.length, 1);
  assert.equal(operation.failures[0].id, 'ha2');
  const current = await webosAPI('/api/home');
  assert.equal(current.state.lights.ha.on, true);
  assert.equal(current.state.lights.ha2.on, false);
  assert.equal(current.state.scene, null);
  assert.equal(socket.sent.filter(message => message.type === 'call_service').length, 2);
  await webosAPI('/api/webos/ha/disconnect', {});
});

test('toggle scenes turn their targets off and back on again', async () => {
  await install();
  await webosAPI('/api/action', { kind: 'light', id: 'sim', on: true });
  const off = await webosAPI('/api/action', { kind: 'scene', id: 'toggle' });
  assert.equal(off.home.state.lights.sim.on, false);
  assert.equal(off.home.state.scene, null);
  const on = await webosAPI('/api/action', { kind: 'scene', id: 'toggle' });
  assert.equal(on.home.state.lights.sim.on, true);
});
