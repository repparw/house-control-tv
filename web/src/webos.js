import { normalize } from './vendor/config.js';

const KEY = 'house-control:webos:demo:v1';
let home;

function makeHome(plan) {
  const config = normalize(plan);
  return {
    mode: 'demo', revision: crypto.randomUUID(), plan,
    controlReady: true, macOnline: false,
    state: {
      lights: Object.fromEntries(config.lights.map(d => [d.id, { on: true, brightness: .75, temp: 3000, color: null }])),
      acs: Object.fromEntries(config.acs.map(d => [d.id, { on: false, target: 23, mode: 'cool', fan: 'auto' }])),
      scene: null,
    },
  };
}

async function loadHome() {
  if (home) return;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved) home = makeHome(saved);
  } catch { /* An invalid saved plan falls back to the bundled demonstration. */ }
  if (!home) {
    const response = await fetch('./plans/demo-loft.json');
    if (!response.ok) throw new Error('The bundled demo plan could not be loaded.');
    home = makeHome(await response.json());
  }
}

// This adapter has no device transport. Imported bindings cannot send commands.
export async function webosAPI(path, body) {
  await loadHome();
  if (path === '/api/home') return structuredClone(home);
  if (path === '/api/import') {
    const plan = body?.plan ?? body;
    const next = makeHome(plan);
    localStorage.setItem(KEY, JSON.stringify(plan));
    home = next;
    return { ok: true };
  }
  if (path === '/api/demo') {
    localStorage.removeItem(KEY); home = null; await loadHome();
    return { ok: true };
  }
  if (path !== '/api/demo/action') throw new Error('Device connections are disabled in this webOS demo.');
  const s = home.state, config = normalize(home.plan);
  if (body.kind === 'scene') {
    const scene = config.scenes.find(d => d.id === body.id);
    if (!scene) throw new Error('Unknown scene.');
    for (const section of ['lights', 'acs']) {
      for (const [id, value] of Object.entries(s[section])) Object.assign(value, scene[section]['*'] || {}, scene[section][id] || {});
    }
    s.scene = scene.id;
  } else if (body.kind === 'allLights' || body.kind === 'room') {
    for (const d of config.lights.filter(d => body.kind !== 'room' || d.room === body.id)) s.lights[d.id].on = !!body.on;
    s.scene = null;
  } else if (body.kind === 'light' && s.lights[body.id]) {
    s.lights[body.id].on = !!body.on; s.scene = null;
  } else if (body.kind === 'acPower' && s.acs[body.id]) s.acs[body.id].on = !!body.on;
  else if (body.kind === 'acTarget' && s.acs[body.id]) {
    const d = config.acs.find(d => d.id === body.id);
    if (!Number.isFinite(body.target) || body.target < d.min || body.target > d.max) throw new Error('Invalid target temperature.');
    s.acs[body.id].target = body.target;
  } else throw new Error('Unknown demo action.');
  return { home: structuredClone(home) };
}
