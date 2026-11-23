import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalize, linkOf, createWorld } from '@house-control/visuals';
import { normalize as compatibilityNormalize } from '../src/vendor/config.js';

test('TV uses PR #29 shared plan parser, including linked devices and levels', async () => {
  const raw = JSON.parse(await readFile(new URL('../public/plans/demo-loft.json', import.meta.url)));
  raw.lights[0].link = { service: 'homeassistant', id: 'light.kitchen' };
  raw.scenes[0].toggle = true;
  const plan = normalize(raw);
  assert.ok(Array.isArray(plan.levels) && plan.levels.length);
  assert.equal(plan.scenes[0].toggle, true);
  assert.deepEqual(linkOf(plan.lights[0]), { service: 'homeassistant', id: 'light.kitchen' });
  assert.deepEqual(compatibilityNormalize(raw), plan);
  assert.equal(typeof createWorld, 'function');
});
