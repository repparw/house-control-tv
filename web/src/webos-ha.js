// Home Assistant's WebSocket API supplies state, events, and service calls without HTTP CORS.
// Credentials remain in memory for this first standalone integration; never write them into a floor plan.
const ENTITY = /^(light|switch|climate|sensor)\.[a-z0-9_]{1,200}$/;

export function haURL(raw) {
  const input = String(raw || '').trim();
  const url = new URL(input.includes('://') ? input : 'http://' + input);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
    throw new Error('Enter only the Home Assistant server address.');
  if (url.protocol === 'http:') {
    const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const parts = h.split('.').map(Number);
    const privateV4 = parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
      (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
       (parts[0] === 192 && parts[1] === 168) || (parts[0] === 169 && parts[1] === 254));
    if (!(privateV4 || h.endsWith('.local') || h === 'homeassistant'))
      throw new Error('Plain HTTP is limited to private IPv4 addresses and .local hosts. Use HTTPS otherwise.');
  }
  if (url.protocol === 'http:' && !url.port) url.port = '8123';
  return url.origin;
}

export class HAConnection {
  constructor(Socket = globalThis.WebSocket) {
    this.Socket = Socket;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.connected = false;
    this.onState = () => {};
    this.onDisconnect = () => {};
    this.subscriptionId = null;
    this.staged = null;
  }

  async connect(address, token, onState, onDisconnect = () => {}) {
    const url = haURL(address);
    if (typeof token !== 'string' || !/^[A-Za-z0-9._-]{20,2048}$/.test(token.trim()))
      throw new Error('Enter a Home Assistant long-lived access token.');
    this.close();
    this.onState = onState;
    this.onDisconnect = onDisconnect;
    this.nextId = 0;
    this.connected = false;
    this.staged = null;
    const wsURL = url.replace(/^http/, 'ws') + '/api/websocket';
    const socket = new this.Socket(wsURL);
    this.ws = socket;
    let done = false;
    let resolveAuth, rejectAuth;
    const authenticated = new Promise((resolve, reject) => { resolveAuth = resolve; rejectAuth = reject; });
    const timeout = setTimeout(() => { if (!done) { rejectAuth(new Error('Home Assistant did not respond.')); socket.close(); } }, 10000);
    const complete = (err) => {
      if (done) return;
      done = true; clearTimeout(timeout);
      if (err) rejectAuth(err); else resolveAuth();
    };
    socket.onmessage = ({ data }) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'auth_required') {
        socket.send(JSON.stringify({ type: 'auth', access_token: token.trim() }));
      } else if (msg.type === 'auth_ok') {
        complete();
      } else if (msg.type === 'auth_invalid') {
        complete(new Error('Home Assistant rejected the token.'));
        socket.close();
      } else if (msg.type === 'result') {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id); clearTimeout(p.timer);
          if (msg.success) p.resolve(msg.result);
          else p.reject(new Error(msg.error?.message || 'Home Assistant rejected the request.'));
        }
      } else if (msg.type === 'event' && msg.id === this.subscriptionId) {
        const changed = msg.event?.data;
        const entityId = changed?.entity_id;
        if (typeof entityId !== 'string') return;
        // A deleted entity is unavailable, not permanently stuck in its previous state.
        const state = changed.new_state ?? { entity_id: entityId, state: 'unavailable', attributes: {} };
        if (this.staged) this.staged.set(entityId, state);
        else this.onState(state);
      }
    };
    socket.onerror = () => { complete(new Error('Cannot open the Home Assistant WebSocket.')); };
    socket.onclose = () => {
      complete(new Error('Home Assistant disconnected.'));
      this.connected = false;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Home Assistant disconnected.')); }
      this.pending.clear();
      if (this.ws === socket) this.onDisconnect();
    };
    try {
      await authenticated;
      // Subscribe before reading the snapshot so changes cannot be missed at startup.
      const subscription = this.request('subscribe_events', { event_type: 'state_changed' });
      this.subscriptionId = this.nextId;
      await subscription;
      this.staged = new Map();
      const states = await this.request('get_states');
      if (!Array.isArray(states)) throw new Error('Home Assistant returned an invalid state snapshot.');
      const latest = new Map(states.filter(s => s?.entity_id).map(s => [s.entity_id, s]));
      for (const [id, event] of this.staged) {
        const previous = latest.get(id);
        // Home Assistant state objects carry last_updated timestamps. A snapshot
        // newer than a queued event must not be overwritten by that older event.
        const oldTime = Date.parse(previous?.last_updated);
        const newTime = Date.parse(event.last_updated);
        if (!previous || !Number.isFinite(oldTime) || !Number.isFinite(newTime) || newTime >= oldTime)
          latest.set(id, event);
      }
      for (const state of latest.values()) this.onState(state);
      this.staged = null;
      this.connected = true;
      return { url };
    } catch (error) {
      socket.close();
      throw error;
    }
  }

  request(type, fields = {}) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('Home Assistant is not connected.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Home Assistant request timed out.'));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, type, ...fields })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async call(domain, service, entityId, data = {}) {
    if (!ENTITY.test(entityId) || !['light', 'switch', 'climate'].includes(domain) ||
        !entityId.startsWith(domain + '.')) throw new Error('Invalid Home Assistant entity.');
    await this.request('call_service', { domain, service, service_data: { ...data, entity_id: entityId } });
  }

  close() {
    const socket = this.ws;
    this.ws = null; this.connected = false; this.subscriptionId = null; this.staged = null;
    if (socket) { socket.onclose = null; socket.close(); }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Home Assistant disconnected.')); }
    this.pending.clear();
  }
}

export function haReading(entity) {
  const id = entity?.entity_id;
  if (!ENTITY.test(id)) return null;
  const state = entity.state;
  if (state === 'unavailable' || state === 'unknown') return { online: false };
  const a = entity.attributes || {};
  if (id.startsWith('light.') || id.startsWith('switch.')) {
    const light = { on: state === 'on' };
    if (state === 'on' && Number.isFinite(a.brightness)) light.brightness = Math.max(.05, Math.min(1, a.brightness / 255));
    if (a.color_mode === 'color_temp' && Number.isFinite(a.color_temp_kelvin)) {
      light.temp = a.color_temp_kelvin; light.color = null;
    } else if (['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].includes(a.color_mode) && Array.isArray(a.rgb_color)) {
      light.color = '#' + a.rgb_color.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
    }
    return { online: true, light };
  }
  if (id.startsWith('climate.')) {
    const ac = { on: state !== 'off' };
    const mode = state === 'fan_only' ? 'fan' : state === 'heat_cool' ? 'auto' : state;
    if (['cool', 'heat', 'dry', 'fan', 'auto'].includes(mode)) ac.mode = mode;
    if (Number.isFinite(a.temperature)) ac.target = a.temperature;
    if (Number.isFinite(a.current_temperature)) ac.roomTemp = a.current_temperature;
    return { online: true, ac };
  }
  const n = Number(state);
  if (Number.isFinite(n) && (a.device_class === 'temperature' || ['°C', '°F'].includes(a.unit_of_measurement)))
    return { online: true, temperature: a.unit_of_measurement === '°F' ? (n - 32) * 5 / 9 : n };
  return { online: true };
}

export function haCalls(id, patch, desired, attributes = {}) {
  if (!ENTITY.test(id)) throw new Error('Invalid Home Assistant entity.');
  const [domain] = id.split('.');
  if (domain === 'switch') return typeof patch.on === 'boolean' ? [[domain, patch.on ? 'turn_on' : 'turn_off', {}]] : [];
  if (domain === 'light') {
    if (patch.on === false) return [[domain, 'turn_off', {}]];
    const data = {};
    if (patch.brightness !== undefined) data.brightness_pct = Math.round(patch.brightness * 100);
    if (patch.temp !== undefined) data.color_temp_kelvin = Math.round(patch.temp);
    if (typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color))
      data.rgb_color = [1, 3, 5].map(i => parseInt(patch.color.slice(i, i + 2), 16));
    return Object.keys(data).length || patch.on === true ? [[domain, 'turn_on', data]] : [];
  }
  if (domain !== 'climate') throw new Error('Unsupported Home Assistant entity.');
  if (patch.on === false) return [[domain, 'set_hvac_mode', { hvac_mode: 'off' }]];
  const calls = [];
  if (patch.on === true || patch.mode) {
    const modes = attributes.hvac_modes || [];
    const requested = patch.mode || desired.mode || 'cool';
    const names = requested === 'fan' ? ['fan_only'] : requested === 'auto' ? ['auto', 'heat_cool'] : [requested];
    const selected = names.find(x => modes.includes(x));
    if (selected) calls.push([domain, 'set_hvac_mode', { hvac_mode: selected }]);
  }
  if (patch.target !== undefined) calls.push([domain, 'set_temperature', { temperature: patch.target }]);
  return calls;
}
