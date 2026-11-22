import { normalize, linkOf } from './vendor/config.js';
import { HAConnection, haReading, haCalls } from './webos-ha.js';

const KEY = 'house-control:webos:demo:v1';
let home;
let ha = null;
let haAddress = '';
const haStates = new Map();

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
  } catch { /* Invalid plans fall back to the bundled demonstration. */ }
  if (!home) {
    const response = await fetch('./plans/demo-loft.json');
    if (!response.ok) throw new Error('The bundled demo plan could not be loaded.');
    home = makeHome(await response.json());
  }
}

function refreshLinkedStates() {
  if (!home) return;
  const config = normalize(home.plan);
  for (const [section, devices] of [['lights', config.lights], ['acs', config.acs]]) {
    for (const device of devices) {
      const link = linkOf(device);
      if (!link || link.service !== 'homeassistant') continue;
      const reading = haReading(haStates.get(link.id));
      const patch = reading?.[section === 'lights' ? 'light' : 'ac'];
      if (patch) Object.assign(home.state[section][device.id], patch);
      if (reading) home.state[section][device.id].online = reading.online;
      if (section === 'acs' && device.sensor?.service === 'homeassistant') {
        const sensor = haReading(haStates.get(device.sensor.id));
        if (Number.isFinite(sensor?.temperature)) home.state.acs[device.id].roomTemp = sensor.temperature;
      }
    }
  }
}
function setHAState(state) {
  if (!state?.entity_id) return;
  haStates.set(state.entity_id, state);
  refreshLinkedStates();
}

async function connectHA(body) {
  if (!body || typeof body.url !== 'string' || typeof body.token !== 'string')
    throw new Error('Enter the server address and access token.');
  const previous = ha;
  ha = null; previous?.close(); haStates.clear();
  const client = new HAConnection();
  let info;
  try {
    info = await client.connect(body.url, body.token, setHAState, () => {
      if (ha === client) { home.controlReady = false; home.connectionLabel = 'Home Assistant disconnected'; }
    });
  } catch (error) { client.close(); throw error; }
  ha = client; haAddress = info.url;
  home.mode = 'standalone'; home.controlReady = true; home.macOnline = true;
  home.connectionLabel = 'Home Assistant connected';
  refreshLinkedStates();
  return { connected: true, url: haAddress };
}

function disconnectHA() {
  ha?.close(); ha = null; haAddress = ''; haStates.clear();
  home.mode = 'demo'; home.controlReady = true; home.macOnline = false;
  delete home.connectionLabel;
  return { connected: false };
}
function statusHA() { return { connected: !!ha?.connected, url: haAddress }; }

function demoAction(body) {
  const s = home.state, config = normalize(home.plan);
  if (body.kind === 'scene') {
    const scene = config.scenes.find(d => d.id === body.id);
    if (!scene) throw new Error('Unknown scene.');
    for (const section of ['lights', 'acs'])
      for (const [id, value] of Object.entries(s[section]))
        Object.assign(value, scene[section]['*'] || {}, scene[section][id] || {});
    s.scene = scene.id;
  } else if (body.kind === 'allLights' || body.kind === 'room') {
    if (body.kind === 'room' && !config.rooms.some(r => r.id === body.id)) throw new Error('Unknown room.');
    for (const d of config.lights.filter(d => body.kind !== 'room' || d.room === body.id)) s.lights[d.id].on = !!body.on;
    s.scene = null;
  } else if (body.kind === 'light' && s.lights[body.id]) {
    s.lights[body.id].on = !!body.on; s.scene = null;
  } else if (body.kind === 'acPower' && s.acs[body.id]) {
    s.acs[body.id].on = !!body.on; s.scene = null;
  } else if (body.kind === 'acTarget' && s.acs[body.id]) {
    const d = config.acs.find(d => d.id === body.id);
    if (!Number.isFinite(body.target) || body.target < d.min || body.target > d.max) throw new Error('Invalid target temperature.');
    s.acs[body.id].target = body.target; s.scene = null;
  } else throw new Error('Unknown demo action.');
  return { home: structuredClone(home) };
}

async function change(section, device, patch) {
  const current = home.state[section][device.id];
  if (!current) throw new Error('Unknown device.');
  const link = linkOf(device);
  const desired = { ...current, ...patch };
  if (link) {
    if (link.service !== 'homeassistant') throw new Error(device.name + ' uses a provider not yet available on webOS.');
    const reading = haReading(haStates.get(link.id));
    if (!reading?.online) throw new Error(device.name + ' is unavailable in Home Assistant.');
    const calls = haCalls(link.id, patch, desired, haStates.get(link.id)?.attributes);
    for (const [domain, service, data] of calls) await ha.call(domain, service, link.id, data);
  }
  Object.assign(current, patch);
  home.state.scene = null;
}

async function liveAction(body) {
  if (!ha?.connected) throw new Error('Connect Home Assistant before controlling real devices.');
  const config = normalize(home.plan);
  const light = id => config.lights.find(d => d.id === id);
  const ac = id => config.acs.find(d => d.id === id);
  if (body.kind === 'light' && light(body.id)) {
    if (typeof body.on !== 'boolean') throw new Error('Expected an on/off value.');
    await change('lights', light(body.id), { on: body.on });
  } else if (body.kind === 'lightSet' && light(body.id)) {
    const patch = Object.fromEntries(['on', 'brightness', 'temp', 'color'].filter(k => Object.hasOwn(body,k)).map(k => [k,body[k]]));
    if (!Object.keys(patch).length) throw new Error('Nothing to change.');
    await change('lights', light(body.id), patch);
  } else if (body.kind === 'acPower' && ac(body.id)) {
    if (typeof body.on !== 'boolean') throw new Error('Expected an on/off value.');
    await change('acs', ac(body.id), { on: body.on });
  } else if (body.kind === 'acTarget' && ac(body.id)) {
    const device = ac(body.id);
    if (!Number.isFinite(body.target) || body.target < device.min || body.target > device.max)
      throw new Error('Invalid target temperature.');
    await change('acs', device, { target: body.target });
  } else if (body.kind === 'scene' || body.kind === 'allLights' || body.kind === 'room') {
    const scene = config.scenes.find(s => s.id === body.id);
    if (body.kind === 'scene' && !scene) throw new Error('Unknown scene.');
    if (body.kind === 'room' && !config.rooms.some(r => r.id === body.id)) throw new Error('Unknown room.');
    if (body.kind !== 'scene' && typeof body.on !== 'boolean') throw new Error('Expected an on/off value.');
    const changes = [];
    for (const [section, devices] of [['lights', config.lights], ['acs', config.acs]]) {
      for (const device of devices) {
        let patch = {};
        if (scene) patch = { ...(scene[section]['*'] || {}), ...(scene[section][device.id] || {}) };
        else if (section === 'lights' && (body.kind !== 'room' || device.room === body.id)) patch = { on: body.on };
        patch = Object.fromEntries(Object.entries(patch).filter(([key, val]) => home.state[section][device.id]?.[key] !== val));
        if (Object.keys(patch).length) changes.push({ section, device, patch });
      }
    }
    // Reject unsupported links before making any changes, rather than applying half a scene.
    for (const { device } of changes) {
      const link = linkOf(device);
      if (link && link.service !== 'homeassistant') throw new Error('Scene includes an unsupported provider: ' + device.name);
    }
    for (const { section, device, patch } of changes) await change(section, device, patch);
    if (scene) home.state.scene = scene.id;
  } else throw new Error('Unknown action.');
  return { ok: true, direct: true, home: structuredClone(home) };
}

export async function webosAPI(path, body) {
  await loadHome();
  if (path === '/api/home') return structuredClone(home);
  if (path === '/api/webos/ha/status') return statusHA();
  if (path === '/api/webos/ha/connect') return connectHA(body);
  if (path === '/api/webos/ha/disconnect') return disconnectHA();
  if (path === '/api/import') {
    const plan = body?.plan ?? body;
    const next = makeHome(plan);
    localStorage.setItem(KEY, JSON.stringify(plan));
    home = next;
    if (ha?.connected) {
      home.mode = 'standalone'; home.controlReady = true; home.macOnline = true;
      home.connectionLabel = 'Home Assistant connected'; refreshLinkedStates();
    }
    return { ok: true };
  }
  if (path === '/api/demo') {
    disconnectHA();
    localStorage.removeItem(KEY); home = null; await loadHome();
    return { ok: true };
  }
  if (path === '/api/action') return liveAction(body);
  if (path === '/api/demo/action') return demoAction(body);
  throw new Error('Unsupported webOS API call.');
}
