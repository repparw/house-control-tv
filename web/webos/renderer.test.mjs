import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalize } from '@house-control/visuals';
import { createWorld, STAGE_BG } from '../src/vendor/three/world.js';
import { TV_RENDERER_OPTIONS, tvTarget, tvView } from '../src/vendor/three/tv.js';

test('TV adapter delegates to the shared renderer with a TV budget', () => {
  assert.equal(typeof createWorld, 'function');
  assert.equal(STAGE_BG, '#0a0e1a');
  assert.equal(TV_RENDERER_OPTIONS.effects, false);
  assert.equal(TV_RENDERER_OPTIONS.lampShadows, false);
  assert.equal(TV_RENDERER_OPTIONS.staticWalls, true);
  assert.equal(TV_RENDERER_OPTIONS.allowPan, false);
  assert.equal(TV_RENDERER_OPTIONS.orbitLimit, 40);
});

test('TV widget camera targets the modelled television', async () => {
  const raw = JSON.parse(await readFile(new URL('../public/plans/demo-loft.json', import.meta.url)));
  const config = normalize(raw);
  const tv = config.furniture.find((item) => item.type === 'tv');
  assert.ok(tv, 'demo plan includes a TV');
  const view = tvView(config);
  assert.ok(view);
  assert.equal(view.az, tv.rot || 0);
  assert.deepEqual(view.target, tvTarget(tv));
  assert.equal(view.el, 8);
  assert.equal(view.dist, 1.6);
});

test('a plan without a TV has no widget push-in', () => {
  assert.equal(tvView({ furniture: [] }), null);
  assert.equal(tvTarget(null), null);
});
