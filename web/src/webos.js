import { normalize, linkOf } from '@house-control/visuals';
import { HAConnection, haReading, haCalls, isHAControlEntity } from './webos-ha.js';

const PLAN_KEY = 'house-control:webos:demo:v1';
const STATE_KEY = 'house-control:webos:state:v1';
const COMMAND_TIMEOUT = 15000;
const LIGHT_STATE_KEYS = ['on', 'brightness', 'temp', 'color'];
const AC_STATE_KEYS = ['on', 'target', 'mode', 'fan', 'roomTemp'];

let home = null;
let ha = null;
let haAddress = '';
let haCredentials = null;
let haGeneration = 0;
let reconnectTimer = null;
let reconnectAttempt = 0;
let foreground = true;
let operationCounter = 0;
const haStates = new Map();
const pendingCommands = new Map();
const supersededCommands = new Map();
const operations = new Map();

export class WebOSError extends Error {
  constructor(message, code = 'ADAPTER_ERROR', details = null) {
    super(message);
    this.name = 'WebOSError';
    this.code = code;
    this.details = details;
  }
}

function storage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

function fingerprint(value) {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function copyStateFields(target, source, keys) {
  if (!source) return;
  for (const key of keys) {
    if (Object.hasOwn(source, key) && source[key] !== undefined) target[key] = structuredClone(source[key]);
  }
}

function validHAEntity(section, entityId) {
  if (!isHAControlEntity(entityId)) return false;
  const domain = entityId.split('.')[0];
  return section === 'lights' ? ['light', 'switch'].includes(domain) : domain === 'climate';
}

function deviceError(section, device, link) {
  if (!link) return null;
  if (link.service !== 'homeassistant')
    return `${device.name} uses an unsupported provider: ${link.service}.`;
  if (!validHAEntity(section, link.id)) return `${device.name} has an invalid Home Assistant entity: ${link.id}.`;
  return null;
}

function initialDeviceState(section, device) {
  const link = linkOf(device);
  const simulated = !link;
  const state = section === 'lights'
    ? { on: true, brightness: .75, temp: 3000, color: null }
    : { on: false, target: 23, mode: 'cool', fan: 'auto' };
  return {
    ...state,
    online: simulated,
    known: simulated,
    provider: link?.service || null,
    simulated,
    stale: false,
    pending: false,
    error: deviceError(section, device, link),
    errorCode: link && link.service !== 'homeassistant' ? 'UNSUPPORTED_PROVIDER' : link && !validHAEntity(section, link.id) ? 'INVALID_ENTITY' : null,
    controlEnabled: simulated,
    status: simulated ? 'simulated' : link.service === 'homeassistant' ? 'disconnected' : 'unsupported',
  };
}

function compatibleDevice(oldDevice) {
  // Device ids are unique across a plan, so a matching id in the same section is the
  // compatibility check. A light may change its fixture type without becoming an AC.
  return Boolean(oldDevice);
}

function makeHome(plan, options = {}) {
  const config = normalize(plan);
  const mode = options.mode || 'standalone';
  const next = {
    mode, revision: crypto.randomUUID(), plan: structuredClone(plan),
    controlReady: mode === 'demo', macOnline: mode === 'demo',
    state: {
      lights: Object.fromEntries(config.lights.map(d => [d.id, initialDeviceState('lights', d)])),
      acs: Object.fromEntries(config.acs.map(d => [d.id, initialDeviceState('acs', d)])),
      scene: null,
    },
    connection: {
      state: mode === 'demo' ? 'demo' : 'disconnected',
      foreground,
      connected: false,
      reconnecting: false,
      stale: false,
      label: mode === 'demo' ? 'Demo · no real devices' : 'Home Assistant is not connected',
      error: null,
    },
    operation: null,
  };
  if (options.previous) {
    const oldConfig = normalize(options.previous.plan);
    for (const [section, devices] of [['lights', oldConfig.lights], ['acs', oldConfig.acs]]) {
      const oldById = new Map(devices.map(d => [d.id, d]));
      for (const device of config[section]) {
        const oldDevice = oldById.get(device.id);
        if (!compatibleDevice(oldDevice)) continue;
        const oldState = options.previous.state?.[section]?.[device.id];
        const oldLink = linkOf(oldDevice);
        const newLink = linkOf(device);
        // Local-only state survives only when the device stayed simulated and compatible.
        if (!newLink && !oldLink) copyStateFields(next.state[section][device.id], oldState, section === 'lights' ? LIGHT_STATE_KEYS : AC_STATE_KEYS);
        // A linked display value may be retained as last-known presentation, never as authority.
        if (oldState && newLink?.service === 'homeassistant' && oldLink?.service === 'homeassistant' && oldLink.id === newLink.id) {
          copyStateFields(next.state[section][device.id], oldState, section === 'lights' ? LIGHT_STATE_KEYS : AC_STATE_KEYS);
          const state = next.state[section][device.id];
          state.displayName = oldState.displayName;
          state.known = state.stale = oldState.known === true;
        }
      }
    }
  }
  return next;
}

function readCachedState() {
  try {
    const raw = storage()?.getItem(STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function restoreCachedState() {
  const cached = readCachedState();
  if (!cached || fingerprint(cached.plan) !== fingerprint(home.plan)) return;
  let oldConfig;
  try { oldConfig = normalize(cached.plan); } catch { return; }
  for (const [section, devices] of [['lights', oldConfig.lights], ['acs', oldConfig.acs]]) {
    const oldById = new Map(devices.map(d => [d.id, d]));
    for (const device of normalize(home.plan)[section]) {
      const oldDevice = oldById.get(device.id);
      if (!compatibleDevice(oldDevice)) continue;
      const oldState = cached.state?.[section]?.[device.id];
      const oldLink = linkOf(oldDevice);
      const newLink = linkOf(device);
      if (!newLink && !oldLink) {
        copyStateFields(home.state[section][device.id], oldState, section === 'lights' ? LIGHT_STATE_KEYS : AC_STATE_KEYS);
      } else if (oldState && newLink?.service === 'homeassistant' && oldLink?.service === 'homeassistant' && oldLink.id === newLink.id) {
        copyStateFields(home.state[section][device.id], oldState, section === 'lights' ? LIGHT_STATE_KEYS : AC_STATE_KEYS);
        const state = home.state[section][device.id];
        state.displayName = oldState.displayName;
        state.known = state.stale = oldState.known === true;
      }
    }
  }
}

let saveScheduled = false;
function saveCachedState() {
  if (!home || saveScheduled) return;
  saveScheduled = true;
  queueMicrotask(() => {
    saveScheduled = false;
    if (!home) return;
    globalThis.window?.dispatchEvent(new Event('weboshomechange'));
    try {
      const state = structuredClone(home.state);
      for (const pending of pendingCommands.values()) {
        Object.assign(state[pending.section][pending.id], pending.authority);
      }
      storage()?.setItem(STATE_KEY, JSON.stringify({ version: 1, plan: home.plan, state }));
    } catch { /* Presentation caching is best effort. */ }
  });
}

async function loadHome() {
  if (home) return;
  let saved = null;
  try { saved = JSON.parse(storage()?.getItem(PLAN_KEY) || 'null'); } catch { saved = null; }
  if (saved) {
    home = makeHome(saved, { mode: 'standalone' });
    restoreCachedState();
    refreshLinkedStates(false);
    return;
  }
  const response = await fetch('./plans/demo-loft.json');
  if (!response.ok) throw new Error('The bundled demo plan could not be loaded.');
  home = makeHome(await response.json(), { mode: 'demo' });
}

function currentReading(section, device) {
  const link = linkOf(device);
  if (!link) return null;
  return haReading(haStates.get(link.id));
}

function refreshLinkedStates(applyAuthority = ha?.connected === true) {
  if (!home) return;
  const config = normalize(home.plan);
  for (const [section, devices] of [['lights', config.lights], ['acs', config.acs]]) {
    for (const device of devices) {
      const link = linkOf(device);
      const state = home.state[section][device.id];
      if (!link) {
        state.online = true;
        state.known = true;
        state.simulated = true;
        state.stale = false;
        state.pending = false;
        state.controlEnabled = true;
        state.status = 'simulated';
        continue;
      }
      if (link.service !== 'homeassistant') {
        state.online = false;
        state.known = false;
        state.simulated = false;
        state.stale = false;
        state.pending = false;
        state.controlEnabled = false;
        state.status = 'unsupported';
        state.error = deviceError(section, device, link);
        state.errorCode = 'UNSUPPORTED_PROVIDER';
        continue;
      }
      if (!validHAEntity(section, link.id)) {
        state.online = false;
        state.known = false;
        state.simulated = false;
        state.stale = false;
        state.pending = false;
        state.controlEnabled = false;
        state.status = 'invalid';
        state.error = deviceError(section, device, link);
        state.errorCode = 'INVALID_ENTITY';
        continue;
      }
      const entity = haStates.get(link.id);
      if (applyAuthority && section === 'lights' && entity) {
        const name = entity.attributes?.friendly_name;
        state.displayName = typeof name === 'string' ? name.trim() || null : null;
      }
      const reading = haReading(entity);
      const part = reading?.[section === 'lights' ? 'light' : 'ac'];
      if (applyAuthority && section === 'acs' && device.sensor?.service === 'homeassistant') {
        const value = haReading(haStates.get(device.sensor.id))?.temperature;
        if (Number.isFinite(value)) state.roomTemp = value;
      }
      if (applyAuthority && reading?.online && part) {
        Object.assign(state, part);
        state.known = true;
      }
      if (ha?.connected) {
        state.online = reading?.online === true;
        state.stale = false;
        state.status = reading?.online ? 'live' : 'unavailable';
        state.controlEnabled = reading?.online === true;
      } else {
        state.online = false;
        state.stale = state.known === true;
        state.status = state.stale ? 'stale' : 'disconnected';
        state.controlEnabled = false;
      }
      const pending = pendingCommands.get(`${section}:${device.id}`);
      if (pending) {
        Object.assign(state, pending.patch);
        state.pending = true;
      } else state.pending = false;
    }
  }
  if (home.connection) home.connection.stale = Object.values(home.state.lights).concat(Object.values(home.state.acs)).some(s => s.stale);
}

function setHAState(state) {
  if (!state?.entity_id) return;
  haStates.set(state.entity_id, state);
  if (!ha?.connected) return; // The initial snapshot is applied once after authentication.
  refreshLinkedStates(ha?.connected === true);
  const config = normalize(home.plan);
  for (const [section, devices] of [['lights', config.lights], ['acs', config.acs]]) {
    for (const device of devices) {
      if (section === 'acs' && device.sensor?.service === 'homeassistant' && device.sensor.id === state.entity_id) {
        const sensor = haReading(haStates.get(device.sensor.id));
        if (Number.isFinite(sensor?.temperature)) home.state.acs[device.id].roomTemp = sensor.temperature;
      }
      if (linkOf(device)?.id === state.entity_id) reconcilePending(`${section}:${device.id}`, state);
    }
  }
  saveCachedState();
}

function setConnectionStatus(state, label, error = null) {
  if (!home) return;
  home.mode = state === 'demo' || (home.mode === 'demo' && !haCredentials) ? 'demo' : 'standalone';
  home.controlReady = state === 'connected' || state === 'demo';
  home.macOnline = state === 'connected';
  home.connection = {
    state,
    foreground,
    connected: state === 'connected',
    reconnecting: foreground && !!haCredentials && state === 'offline',
    stale: false,
    label,
    error,
  };
  if (state !== 'connected') {
    for (const section of ['lights', 'acs']) {
      for (const [id, deviceState] of Object.entries(home.state[section])) {
        if (!deviceState.provider) continue;
        if (deviceState.provider !== 'homeassistant' || deviceState.status === 'unsupported' || deviceState.status === 'invalid') continue;
        deviceState.online = false;
        deviceState.stale = deviceState.known === true;
        deviceState.status = deviceState.stale ? 'stale' : 'disconnected';
        deviceState.controlEnabled = false;
      }
    }
  }
  refreshLinkedStates(state === 'connected');
  home.connection.stale = Object.values(home.state.lights).concat(Object.values(home.state.acs)).some(s => s.stale);
  saveCachedState();
}

function cancelReconnect() {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function queueReconnect(generation) {
  if (generation !== haGeneration || !haCredentials || !foreground || reconnectTimer !== null) return;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt++, 5));
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (generation !== haGeneration || !haCredentials || !foreground) return;
    try {
      await startHA(generation);
    } catch (error) {
      if (generation !== haGeneration) return;
      handleConnectionFailure(generation, error);
    }
  }, delay);
  reconnectTimer.unref?.();
}

function handleConnectionFailure(generation, error) {
  if (generation !== haGeneration) return;
  if (/rejected the token/i.test(error?.message || '')) {
    haCredentials = null;
    setConnectionStatus('unauthorized', 'Home Assistant authorization expired. Reconnect in Sync & connect.', error.message);
    return;
  }
  setConnectionStatus('offline', 'Home Assistant offline. Retrying connection.', error?.message || 'Home Assistant is offline.');
  queueReconnect(generation);
}

async function startHA(generation) {
  haStates.clear();
  const previous = ha;
  const client = new HAConnection();
  ha = client;
  failAllPending('Home Assistant connection was replaced before the command was confirmed.');
  previous?.close();
  setConnectionStatus('connecting', 'Connecting to Home Assistant…');
  let established = false;
  let info;
  try {
    info = await client.connect(haCredentials.url, haCredentials.token, state => {
      if (ha === client && generation === haGeneration) setHAState(state);
    }, () => {
      if (!established || ha !== client || generation !== haGeneration) return;
      failAllPending('Home Assistant disconnected before the command was confirmed.');
      setConnectionStatus('offline', 'Home Assistant disconnected. Reconnecting.', 'Home Assistant disconnected.');
      queueReconnect(generation);
    });
  } catch (error) {
    client.close();
    if (ha === client) ha = null;
    throw error;
  }
  if (generation !== haGeneration || ha !== client) {
    client.close();
    throw new WebOSError('Connection was cancelled.', 'CONNECTION_CANCELLED');
  }
  established = true;
  haAddress = info.url;
  reconnectAttempt = 0;
  cancelReconnect();
  setConnectionStatus('connected', 'Home Assistant connected');
  refreshLinkedStates(true);
  saveCachedState();
  return { connected: true, url: haAddress };
}

async function connectHA(body) {
  if (!body || typeof body.url !== 'string' || typeof body.token !== 'string')
    throw new WebOSError('Enter the server address and access token.', 'INVALID_CREDENTIALS');
  const generation = ++haGeneration;
  cancelReconnect();
  failAllPending('Home Assistant connection was replaced before the command was confirmed.');
  ha?.close(); ha = null;
  haCredentials = { url: body.url, token: body.token };
  if (!foreground) {
    setConnectionStatus('paused', 'House Control is in the background. Home Assistant will reconnect when it is visible.');
    return { connected: false, pending: true, url: '' };
  }
  try {
    return await startHA(generation);
  } catch (error) {
    if (generation === haGeneration) handleConnectionFailure(generation, error);
    throw error;
  }
}

function disconnectHA() {
  ++haGeneration;
  cancelReconnect();
  haCredentials = null;
  failAllPending('Home Assistant disconnected before the command was confirmed.');
  ha?.close(); ha = null; haAddress = '';
  if (home) setConnectionStatus('disconnected', 'Home Assistant is not connected');
  return statusHA();
}

function statusHA() {
  return {
    connected: !!ha?.connected,
    reconnecting: foreground && !!haCredentials && !ha?.connected && home?.connection?.state === 'offline',
    foreground,
    state: home?.connection?.state || 'disconnected',
    stale: !!home?.connection?.stale,
    url: haAddress,
    lastError: home?.connection?.error || null,
    operation: home?.operation ? structuredClone(home.operation) : null,
  };
}

async function setForeground(visible) {
  const nextForeground = visible !== false;
  if (nextForeground === foreground) return statusHA();
  foreground = nextForeground;
  if (!foreground) {
    ++haGeneration;
    cancelReconnect();
    failAllPending('House Control closed before Home Assistant confirmed the command.');
    ha?.close(); ha = null; haAddress = '';
    setConnectionStatus('paused', 'House Control is in the background. Home Assistant is disconnected.');
    return statusHA();
  }
  const generation = ++haGeneration;
  if (haCredentials) {
    reconnectAttempt = 0;
    setConnectionStatus('connecting', 'Reconnecting to Home Assistant…');
    try { await startHA(generation); }
    catch (error) {
      if (generation === haGeneration) handleConnectionFailure(generation, error);
      throw error;
    }
  } else setConnectionStatus(home?.mode === 'demo' ? 'demo' : 'disconnected', home?.mode === 'demo' ? 'Demo · no real devices' : 'Home Assistant is not connected');
  return statusHA();
}

function createOperation(kind, total) {
  const operation = {
    id: `operation-${++operationCounter}`,
    kind,
    status: 'pending',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total,
    succeeded: 0,
    failed: 0,
    failures: [],
    message: 'Applying changes…',
  };
  operations.set(operation.id, operation);
  if (operations.size > 20) operations.delete(operations.keys().next().value);
  if (home) home.operation = operation;
  return operation;
}

function finishOperation(operation, failures = []) {
  operation.failed = failures.filter(failure => failure.id).length;
  operation.succeeded = Math.max(0, operation.total - operation.failed);
  operation.failures = failures;
  operation.finishedAt = new Date().toISOString();
  if (!failures.length) {
    operation.status = 'complete';
    operation.message = 'All requested changes were confirmed.';
  } else if (operation.succeeded) {
    operation.status = 'partial';
    operation.message = `${operation.succeeded} of ${operation.total} changes succeeded.`;
  } else {
    operation.status = 'failed';
    operation.message = failures.length === 1 ? failures[0].message : 'No requested changes succeeded.';
  }
  if (home) home.operation = operation;
  saveCachedState();
}

function operationFailure(item, error) {
  return {
    id: item.device.id,
    name: item.device.name,
    code: error?.code || 'COMMAND_FAILED',
    message: error?.message || 'The device change failed.',
  };
}

function numericEqual(a, b, tolerance = .01) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

function valuesMatch(section, reading, patch) {
  if (!reading?.online) return false;
  const actual = reading[section === 'lights' ? 'light' : 'ac'] || {};
  for (const [key, expected] of Object.entries(patch)) {
    if (key === 'color' && expected === null) continue;
    if (key === 'on' && actual.on !== expected) return false;
    if (key === 'brightness' && !numericEqual(actual.brightness, expected)) return false;
    if (key === 'temp' && !numericEqual(actual.temp, expected, 1)) return false;
    if (key === 'color' && String(actual.color || '').toLowerCase() !== String(expected).toLowerCase()) return false;
    if (key === 'target' && !numericEqual(actual.target, expected, .1)) return false;
    if (key === 'mode' && actual.mode !== expected) return false;
  }
  return true;
}

function linkedDiff(section, device, patch) {
  const link = linkOf(device);
  const reading = currentReading(section, device);
  if (!reading?.online) throw new WebOSError(`${device.name} is unavailable in Home Assistant.`, 'ENTITY_UNAVAILABLE');
  const actual = reading[section === 'lights' ? 'light' : 'ac'] || {};
  const diff = {};
  if (patch.on === false) {
    if (actual.on !== false) diff.on = false;
    return diff;
  }
  for (const [key, expected] of Object.entries(patch)) {
    if (key === 'color' && expected === null) continue;
    const current = actual[key];
    const same = key === 'on' || key === 'mode' || key === 'color'
      ? current === expected
      : numericEqual(current, expected, key === 'temp' ? 1 : key === 'brightness' ? .01 : .1);
    if (!same) diff[key] = expected;
  }
  return diff;
}

function stateTime(state) {
  const value = Date.parse(state?.last_updated || state?.last_changed || '');
  return Number.isFinite(value) ? value : null;
}

function maybeCompletePending(pending) {
  if (pending.serviceSettled && pending.confirmed) confirmPending(pending);
}

function confirmPending(pending) {
  if (pendingCommands.get(pending.key) !== pending) return;
  pendingCommands.delete(pending.key);
  supersededCommands.delete(pending.key);
  clearTimeout(pending.timer);
  refreshLinkedStates(true);
  const state = home.state[pending.section][pending.id];
  state.pending = false;
  state.error = null;
  state.errorCode = null;
  pending.resolve();
  saveCachedState();
}

function failPending(pending, message, code = 'COMMAND_FAILED') {
  if (pendingCommands.get(pending.key) !== pending) return;
  pendingCommands.delete(pending.key);
  if (code !== 'COMMAND_SUPERSEDED') supersededCommands.delete(pending.key);
  clearTimeout(pending.timer);
  refreshLinkedStates(true);
  const state = home.state[pending.section][pending.id];
  state.pending = false;
  state.error = message;
  state.errorCode = code;
  pending.reject(new WebOSError(message, code));
  saveCachedState();
}

function reconcilePending(key, state) {
  const pending = pendingCommands.get(key);
  if (!pending) return;
  const eventTime = stateTime(state);
  const reading = haReading(state);
  if (valuesMatch(pending.section, reading, pending.patch)) {
    pending.confirmed = true;
    maybeCompletePending(pending);
    return;
  }
  // A superseded service call can still produce an event after the newer command. If the
  // event describes that older request, keep the newer optimistic state until its own
  // authoritative event arrives.
  const oldCommands = supersededCommands.get(key) || [];
  if (oldCommands.some(old => valuesMatch(pending.section, reading, old.patch))) return;
  // Timestamp precision in Home Assistant is one second. An event from an earlier second
  // cannot be confirmation of the current command.
  if (eventTime !== null && eventTime < Math.floor(pending.startedAt / 1000) * 1000) return;
  failPending(pending, `${pending.name} was changed by Home Assistant instead of applying the requested state.`, 'STATE_CORRECTED');
}

function failAllPending(message) {
  for (const pending of [...pendingCommands.values()]) failPending(pending, message, 'COMMAND_INTERRUPTED');
}

async function performChange(item) {
  const { section, device, patch } = item;
  const state = home.state[section][device.id];
  const link = linkOf(device);
  if (!link) {
    Object.assign(state, patch);
    state.pending = false;
    state.error = null;
    state.errorCode = null;
    state.known = true;
    home.state.scene = null;
    saveCachedState();
    return;
  }
  if (link.service !== 'homeassistant')
    throw new WebOSError(`${device.name} uses an unsupported provider: ${link.service}.`, 'UNSUPPORTED_PROVIDER');
  if (!validHAEntity(section, link.id))
    throw new WebOSError(`${device.name} has an invalid Home Assistant entity: ${link.id}.`, 'INVALID_ENTITY');
  if (!foreground || !ha?.connected)
    throw new WebOSError('Connect Home Assistant before controlling real devices.', 'OFFLINE');
  if (Object.hasOwn(patch, 'fan'))
    throw new WebOSError(`${device.name} fan speed is not supported by the Home Assistant adapter.`, 'UNSUPPORTED_CAPABILITY');
  const reading = currentReading(section, device);
  if (!reading?.online)
    throw new WebOSError(`${device.name} is unavailable in Home Assistant.`, 'ENTITY_UNAVAILABLE');
  const key = `${section}:${device.id}`;
  const previous = pendingCommands.get(key);
  if (previous) {
    const old = supersededCommands.get(key) || [];
    old.push({ patch: previous.patch, startedAt: previous.startedAt });
    supersededCommands.set(key, old.slice(-5));
    failPending(previous, `${device.name} received a newer command.`, 'COMMAND_SUPERSEDED');
  }
  let diff = linkedDiff(section, device, patch);
  // If an older command is still in flight, issue the newer request even when the last
  // authoritative value already matches it. The older service call may otherwise land later.
  if (!Object.keys(diff).length && previous) diff = { ...patch };
  if (!Object.keys(diff).length) {
    state.pending = false;
    state.error = null;
    state.errorCode = null;
    home.state.scene = null;
    return;
  }
  const desired = { ...(reading[section === 'lights' ? 'light' : 'ac'] || {}), ...diff };
  const calls = haCalls(link.id, diff, desired, haStates.get(link.id)?.attributes);
  if (!calls.length)
    throw new WebOSError(`${device.name} does not support the requested change.`, 'UNSUPPORTED_CAPABILITY');

  let resolve, reject;
  const completion = new Promise((res, rej) => { resolve = res; reject = rej; });
  const pending = {
    key, section, id: device.id, name: device.name, patch: diff,
    authority: reading[section === 'lights' ? 'light' : 'ac'],
    startedAt: Date.now(), serviceSettled: false, confirmed: false,
    resolve, reject, timer: null,
  };
  pending.timer = setTimeout(() => {
    failPending(pending, `Home Assistant did not confirm the change to ${device.name}.`, 'COMMAND_TIMEOUT');
    if (item.refreshOnFailure !== false && !pendingCommands.has(key) && client?.connected) void client.snapshot().catch(() => {});
  }, COMMAND_TIMEOUT);
  pending.timer.unref?.();
  pendingCommands.set(key, pending);
  Object.assign(state, diff);
  state.pending = true;
  state.error = null;
  state.errorCode = null;
  state.controlEnabled = true;
  home.state.scene = null;
  saveCachedState();

  const client = ha;
  void (async () => {
    try {
      for (const [domain, service, data] of calls) await client.call(domain, service, link.id, data);
      if (pendingCommands.get(key) !== pending) return;
      pending.serviceSettled = true;
      maybeCompletePending(pending);
    } catch (error) {
      failPending(pending, error?.message || `Home Assistant rejected the change to ${device.name}.`, 'COMMAND_FAILED');
      if (item.refreshOnFailure !== false && !pendingCommands.has(key) && client?.connected) void client.snapshot().catch(() => {});
    }
  })();
  return completion;
}

function sanitizePatch(section, device, patch, clamp = false) {
  const result = {};
  for (const [key, raw] of Object.entries(patch || {})) {
    if (section === 'lights') {
      if (key === 'on') {
        if (typeof raw !== 'boolean') throw new WebOSError('Expected an on/off value.', 'INVALID_ACTION');
        result.on = raw;
      } else if (key === 'brightness') {
        if (!Number.isFinite(raw)) throw new WebOSError('Invalid brightness.', 'INVALID_ACTION');
        result.brightness = clamp ? Math.max(.05, Math.min(1, raw)) : raw;
        if (!clamp && (raw < .05 || raw > 1)) throw new WebOSError('Invalid brightness.', 'INVALID_ACTION');
      } else if (key === 'temp') {
        if (!Number.isFinite(raw)) throw new WebOSError('Invalid colour temperature.', 'INVALID_ACTION');
        result.temp = clamp ? Math.max(2200, Math.min(6500, raw)) : raw;
        if (!clamp && (raw < 2200 || raw > 6500)) throw new WebOSError('Invalid colour temperature.', 'INVALID_ACTION');
      } else if (key === 'color') {
        if (raw !== null && (typeof raw !== 'string' || !/^#[0-9a-f]{6}$/i.test(raw)))
          throw new WebOSError('Invalid colour.', 'INVALID_ACTION');
        result.color = raw;
      } else throw new WebOSError(`Unsupported light setting: ${key}.`, 'UNSUPPORTED_CAPABILITY');
    } else if (key === 'on') {
      if (typeof raw !== 'boolean') throw new WebOSError('Expected an on/off value.', 'INVALID_ACTION');
      result.on = raw;
    } else if (key === 'target') {
      if (!Number.isFinite(raw)) throw new WebOSError('Invalid target temperature.', 'INVALID_ACTION');
      result.target = clamp ? Math.round(Math.max(device.min, Math.min(device.max, raw))) : raw;
      if (!clamp && (raw < device.min || raw > device.max)) throw new WebOSError('Invalid target temperature.', 'INVALID_ACTION');
    } else if (key === 'mode') {
      if (!['cool', 'heat', 'dry', 'fan', 'auto'].includes(raw)) throw new WebOSError('Invalid climate mode.', 'INVALID_ACTION');
      result.mode = raw;
    } else if (key === 'fan') {
      if (!['auto', 'low', 'medium', 'high', 'turbo'].includes(raw)) throw new WebOSError('Invalid fan speed.', 'INVALID_ACTION');
      result.fan = raw;
    } else throw new WebOSError(`Unsupported climate setting: ${key}.`, 'UNSUPPORTED_CAPABILITY');
  }
  return result;
}

function scenePatch(scene, section, id) {
  return { ...(scene[section]['*'] || {}), ...(scene[section][id] || {}) };
}

function displayedOn(section, device) {
  const link = linkOf(device);
  if (link?.service === 'homeassistant' && ha?.connected) {
    const reading = currentReading(section, device);
    if (reading?.online) return !!reading[section === 'lights' ? 'light' : 'ac']?.on;
  }
  return !!home.state[section][device.id]?.on;
}

function sceneItems(scene, config) {
  const items = [];
  const targets = [];
  if (scene.toggle) {
    for (const [section, devices] of [['lights', config.lights], ['acs', config.acs]]) {
      for (const device of devices) {
        const patch = scenePatch(scene, section, device.id);
        if (patch.on === true) targets.push({ section, device, patch: { on: false } });
      }
    }
    if (targets.some(item => displayedOn(item.section, item.device))) return targets;
  }
  for (const [section, devices] of [['lights', config.lights], ['acs', config.acs]]) {
    for (const device of devices) {
      const patch = scenePatch(scene, section, device.id);
      if (!Object.keys(patch).length) continue;
      items.push({ section, device, patch: sanitizePatch(section, device, patch, true) });
    }
  }
  return items;
}

function preflight(item) {
  const link = linkOf(item.device);
  if (!link) return;
  if (link.service !== 'homeassistant')
    throw new WebOSError(`${item.device.name} uses an unsupported provider: ${link.service}.`, 'UNSUPPORTED_PROVIDER');
  if (!validHAEntity(item.section, link.id))
    throw new WebOSError(`${item.device.name} has an invalid Home Assistant entity: ${link.id}.`, 'INVALID_ENTITY');
  if (!foreground || !ha?.connected)
    throw new WebOSError('Connect Home Assistant before controlling real devices.', 'OFFLINE');
  if (!currentReading(item.section, item.device)?.online)
    throw new WebOSError(`${item.device.name} is unavailable in Home Assistant.`, 'ENTITY_UNAVAILABLE');
}

function runBatch(operation, items, options = {}) {
  if (!items.length) {
    finishOperation(operation, []);
    return;
  }
  const originalHome = home;
  const attempts = items.map(item => performChange(item).then(
    () => ({ ok: true, item }),
    error => ({ ok: false, item, error }),
  ));
  void Promise.all(attempts).then(async results => {
    if (home !== originalHome) return;
    const failures = results.filter(result => !result.ok).map(result => operationFailure(result.item, result.error));
    if (options.scene && ha?.connected && items.some(item => linkOf(item.device)?.service === 'homeassistant')) {
      try { await ha.snapshot(); }
      catch (error) {
        failures.push({ id: null, name: 'Home Assistant', code: 'REFRESH_FAILED', message: error?.message || 'Could not refresh Home Assistant states.' });
      }
    }
    if (options.scene && !failures.length) {
      for (const result of results.filter(result => result.ok)) {
        const item = result.item;
        if (linkOf(item.device)?.service !== 'homeassistant') continue;
        try {
          const diff = linkedDiff(item.section, item.device, item.patch);
          if (Object.keys(diff).length) failures.push(operationFailure(item, new WebOSError(`${item.device.name} did not reach the requested scene state.`, 'STATE_CORRECTED')));
        } catch (error) {
          failures.push(operationFailure(item, error));
        }
      }
    }
    if (home !== originalHome) return;
    if (options.scene && !failures.length && options.sceneId) home.state.scene = options.sceneId;
    if (options.scene && failures.length) home.state.scene = null;
    finishOperation(operation, failures);
  });
}

function demoAction(body) {
  body ||= {};
  const s = home.state, config = normalize(home.plan);
  if (body.kind === 'scene') {
    const scene = config.scenes.find(d => d.id === body.id);
    if (!scene) throw new WebOSError('Unknown scene.', 'UNKNOWN_SCENE');
    for (const section of ['lights', 'acs'])
      for (const [id, value] of Object.entries(s[section]))
        Object.assign(value, scene[section]['*'] || {}, scene[section][id] || {});
    s.scene = scene.id;
  } else if (body.kind === 'allLights' || body.kind === 'room') {
    if (body.kind === 'room' && !config.rooms.some(r => r.id === body.id)) throw new WebOSError('Unknown room.', 'UNKNOWN_ROOM');
    for (const d of config.lights.filter(d => body.kind !== 'room' || d.room === body.id)) s.lights[d.id].on = !!body.on;
    s.scene = null;
  } else if (body.kind === 'light' && s.lights[body.id]) {
    s.lights[body.id].on = !!body.on; s.scene = null;
  } else if (body.kind === 'acPower' && s.acs[body.id]) {
    s.acs[body.id].on = !!body.on; s.scene = null;
  } else if (body.kind === 'acTarget' && s.acs[body.id]) {
    const d = config.acs.find(d => d.id === body.id);
    if (!Number.isFinite(body.target) || body.target < d.min || body.target > d.max) throw new WebOSError('Invalid target temperature.', 'INVALID_ACTION');
    s.acs[body.id].target = body.target; s.scene = null;
  } else throw new WebOSError('Unknown demo action.', 'INVALID_ACTION');
  saveCachedState();
  return { home: structuredClone(home) };
}

function liveAction(body) {
  body ||= {};
  const config = normalize(home.plan);
  const light = id => config.lights.find(d => d.id === id);
  const ac = id => config.acs.find(d => d.id === id);
  let items = [];
  let options = {};
  if (body.kind === 'light' && light(body.id)) {
    if (typeof body.on !== 'boolean') throw new WebOSError('Expected an on/off value.', 'INVALID_ACTION');
    items = [{ section: 'lights', device: light(body.id), patch: { on: body.on } }];
  } else if (body.kind === 'lightSet' && light(body.id)) {
    const raw = Object.fromEntries(['on', 'brightness', 'temp', 'color'].filter(k => Object.hasOwn(body, k)).map(k => [k, body[k]]));
    if (!Object.keys(raw).length) throw new WebOSError('Nothing to change.', 'INVALID_ACTION');
    items = [{ section: 'lights', device: light(body.id), patch: sanitizePatch('lights', light(body.id), raw) }];
  } else if (body.kind === 'acPower' && ac(body.id)) {
    if (typeof body.on !== 'boolean') throw new WebOSError('Expected an on/off value.', 'INVALID_ACTION');
    items = [{ section: 'acs', device: ac(body.id), patch: { on: body.on } }];
  } else if (body.kind === 'acTarget' && ac(body.id)) {
    const device = ac(body.id);
    if (!Number.isFinite(body.target) || body.target < device.min || body.target > device.max)
      throw new WebOSError('Invalid target temperature.', 'INVALID_ACTION');
    items = [{ section: 'acs', device, patch: { target: body.target } }];
  } else if (body.kind === 'scene' || body.kind === 'allLights' || body.kind === 'room') {
    if (body.kind === 'scene') {
      const scene = config.scenes.find(s => s.id === body.id);
      if (!scene) throw new WebOSError('Unknown scene.', 'UNKNOWN_SCENE');
      items = sceneItems(scene, config);
      for (const item of items) item.refreshOnFailure = false;
      options = { scene: true, sceneId: scene.toggle ? null : scene.id };
      home.state.scene = null;
    } else {
      if (body.kind === 'room' && !config.rooms.some(r => r.id === body.id)) throw new WebOSError('Unknown room.', 'UNKNOWN_ROOM');
      if (typeof body.on !== 'boolean') throw new WebOSError('Expected an on/off value.', 'INVALID_ACTION');
      items = config.lights
        .filter(device => body.kind !== 'room' || device.room === body.id)
        .map(device => ({ section: 'lights', device, patch: { on: body.on } }));
      home.state.scene = null;
    }
  } else throw new WebOSError('Unknown action.', 'INVALID_ACTION');

  if (items.length === 1 && !options.scene) preflight(items[0]);
  const operation = createOperation(body.kind, items.length);
  runBatch(operation, items, options);
  return { ok: true, direct: true, operation: structuredClone(operation), home: structuredClone(home) };
}

function planPreview(raw) {
  const config = normalize(raw);
  const oldConfig = home ? normalize(home.plan) : null;
  const changes = {};
  for (const section of ['lights', 'acs']) {
    const old = new Map((oldConfig?.[section] || []).map(d => [d.id, d]));
    const next = new Map(config[section].map(d => [d.id, d]));
    changes[section] = {
      added: config[section].filter(d => !old.has(d.id)).map(d => d.id),
      removed: (oldConfig?.[section] || []).filter(d => !next.has(d.id)).map(d => d.id),
      changed: config[section].filter(d => old.has(d.id) && fingerprint(old.get(d.id)) !== fingerprint(d)).map(d => d.id),
    };
  }
  return {
    valid: true,
    requiresConfirmation: true,
    plan: { name: config.name, lights: config.lights.length, acs: config.acs.length, scenes: config.scenes.length },
    changes,
  };
}

async function importPlan(raw, confirmed) {
  let preview;
  try { preview = planPreview(raw); }
  catch (error) { throw new WebOSError(error.message, 'PLAN_INVALID'); }
  if (!confirmed) throw new WebOSError('Confirm replacing the current floor plan.', 'PLAN_CONFIRMATION_REQUIRED', preview);
  let next;
  try { next = makeHome(raw, { mode: 'standalone', previous: home }); }
  catch (error) { throw new WebOSError(error.message, 'PLAN_INVALID'); }
  try { storage()?.setItem(PLAN_KEY, JSON.stringify(raw)); }
  catch { throw new WebOSError('The new floor plan could not be saved. The current plan was not changed.', 'PLAN_STORAGE_FAILED'); }
  failAllPending('Floor plan was replaced.');
  home = next;
  if (ha?.connected) setConnectionStatus('connected', 'Home Assistant connected');
  else if (foreground && haCredentials) setConnectionStatus('offline', 'Home Assistant offline. Retrying connection.');
  else if (!foreground && haCredentials) setConnectionStatus('paused', 'House Control is in the background. Home Assistant is disconnected.');
  else setConnectionStatus('disconnected', 'Home Assistant is not connected');
  let refreshError = null;
  if (ha?.connected) {
    try { await ha.snapshot(); }
    catch (error) { refreshError = error?.message || 'Home Assistant states could not be refreshed.'; }
  }
  saveCachedState();
  return { ok: true, imported: preview, refreshError, home: structuredClone(home) };
}

export async function webosAPI(path, body) {
  await loadHome();
  if (path === '/api/home') return structuredClone(home);
  if (path === '/api/webos/ha/status') return statusHA();
  if (path === '/api/webos/ha/connect') return connectHA(body);
  if (path === '/api/webos/ha/disconnect') return disconnectHA();
  if (path === '/api/webos/visibility' || path === '/api/webos/ha/visibility') return setForeground(body?.visible);
  if (path === '/api/webos/operation') return home.operation ? structuredClone(home.operation) : null;
  if (path === '/api/webos/operations') return [...operations.values()].map(operation => structuredClone(operation));
  if (path === '/api/webos/plan/preview') {
    const raw = body?.plan ?? body?.rawPlan ?? body;
    try { return planPreview(raw); }
    catch (error) { throw new WebOSError(error.message, 'PLAN_INVALID'); }
  }
  if (path === '/api/import') {
    const raw = body?.plan ?? body?.rawPlan ?? body;
    const confirmed = body?.confirm === true;
    return importPlan(raw, confirmed);
  }
  if (path === '/api/demo') {
    disconnectHA();
    try { storage()?.removeItem(PLAN_KEY); storage()?.removeItem(STATE_KEY); } catch { /* Ignore storage cleanup failures. */ }
    home = null; await loadHome();
    return { ok: true };
  }
  if (path === '/api/action') return liveAction(body);
  if (path === '/api/demo/action') return demoAction(body);
  throw new WebOSError('Unsupported webOS API call.', 'UNKNOWN_API');
}
