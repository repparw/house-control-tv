import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webosAPI } from '../src/webos.js';

class FakeSocket {
  static last;
  constructor(url) {
    this.url = url; this.readyState = 1; this.sent = []; FakeSocket.last = this;
    queueMicrotask(() => this.emit({ type: 'auth_required' }));
  }
  emit(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  send(value) {
    const msg = JSON.parse(value); this.sent.push(msg);
    if (msg.type === 'auth') queueMicrotask(() => this.emit({ type: 'auth_ok' }));
    else if (msg.type === 'get_states') queueMicrotask(() => this.emit({ id: msg.id, type: 'result', success: true,
      result: [{ entity_id: 'light.kitchen', state: 'off', attributes: { brightness: 127 } }] }));
    else if (msg.id) queueMicrotask(() => this.emit({ id: msg.id, type: 'result', success: true, result: null }));
  }
  close() { this.readyState = 3; this.onclose?.(); }
}

test('imported HA-linked light uses the live WebSocket and never saves credentials', async () => {
  const saved = new Map();
  globalThis.localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key),
  };
  globalThis.WebSocket = FakeSocket;
  const plan = JSON.parse(await readFile(new URL('../public/plans/demo-loft.json', import.meta.url)));
  globalThis.fetch = async () => ({ ok: true, json: async () => structuredClone(plan) });
  await webosAPI('/api/home');
  const imported = structuredClone(plan);
  imported.lights[0].link = { service: 'homeassistant', id: 'light.kitchen' };
  await webosAPI('/api/import', imported);
  const token = 'Z'.repeat(40);
  await webosAPI('/api/webos/ha/connect', { url: '192.168.0.20', token });
  const current = await webosAPI('/api/home');
  assert.equal(current.mode, 'standalone');
  assert.equal(current.state.lights[imported.lights[0].id].on, false);
  assert.equal(current.controlReady, true);
  await webosAPI('/api/action', { kind: 'light', id: imported.lights[0].id, on: true });
  const command = FakeSocket.last.sent.find(m => m.type === 'call_service');
  assert.equal(command.service, 'turn_on');
  assert.equal(command.service_data.entity_id, 'light.kitchen');
  assert.ok(!JSON.stringify([...saved]).includes(token));
  assert.ok(!JSON.stringify(await webosAPI('/api/home')).includes(token));
  await webosAPI('/api/webos/ha/disconnect', {});
  await assert.rejects(webosAPI('/api/action', { kind: 'light', id: imported.lights[0].id, on: false }), /Connect Home Assistant/);
});

test('rejects unsupported providers before running a scene', async () => {
  const plan = JSON.parse(await readFile(new URL('../public/plans/demo-loft.json', import.meta.url)));
  plan.lights[0].link = { service: 'hue', id: 'abc' };
  await webosAPI('/api/import', plan);
  await webosAPI('/api/webos/ha/connect', { url: '192.168.0.20', token: 'x'.repeat(40) });
  const before = FakeSocket.last.sent.length;
  await assert.rejects(webosAPI('/api/action', { kind: 'scene', id: plan.scenes.at(-1).id }), /unsupported provider/);
  assert.equal(FakeSocket.last.sent.slice(before).filter(m => m.type === 'call_service').length, 0);
  await webosAPI('/api/webos/ha/disconnect', {});
});
