import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webosAPI } from '../src/webos.js';

test('imported bindings remain isolated while scenes and demo reset work', async () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  };
  const plan = JSON.parse(await readFile(new URL('../public/plans/demo-loft.json', import.meta.url)));
  const requests = [];
  globalThis.fetch = async path => {
    requests.push(path);
    assert.equal(path, './plans/demo-loft.json');
    return { ok: true, json: async () => structuredClone(plan) };
  };
  const initial = await webosAPI('/api/home');
  assert.equal(initial.mode, 'demo');
  const imported = structuredClone(plan);
  imported.name = 'Imported test home';
  imported.lights[0].link = { service: 'homeassistant', id: 'light.never_call' };
  await webosAPI('/api/import', imported);
  const current = await webosAPI('/api/home');
  assert.equal(current.plan.name, imported.name);
  const id = current.plan.lights[0].id;
  const off = await webosAPI('/api/demo/action', { kind: 'light', id, on: false });
  assert.equal(off.home.state.lights[id].on, false);
  const scene = current.plan.scenes[0];
  const applied = await webosAPI('/api/demo/action', { kind: 'scene', id: scene.id });
  assert.equal(applied.home.state.scene, scene.id);
  await assert.rejects(webosAPI('/api/action', { kind: 'light', id, on: true }), /disabled/);
  await assert.rejects(webosAPI('/api/import', { rooms: [] }));
  assert.equal((await webosAPI('/api/home')).plan.name, imported.name);
  await webosAPI('/api/import', { plan: imported });
  assert.equal((await webosAPI('/api/home')).plan.name, imported.name);
  await webosAPI('/api/demo', { enabled: true });
  assert.equal((await webosAPI('/api/home')).plan.name, plan.name);
  assert.deepEqual(requests, ['./plans/demo-loft.json', './plans/demo-loft.json']);
});
