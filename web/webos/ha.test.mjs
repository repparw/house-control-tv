import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAConnection, haURL, haReading, haCalls } from '../src/webos-ha.js';

class FakeSocket {
  static last;
  constructor(url) {
    this.url = url; this.readyState = 1; this.sent = [];
    FakeSocket.last = this;
    queueMicrotask(() => this.emit({ type: 'auth_required' }));
  }
  emit(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  send(text) {
    const msg = JSON.parse(text);
    this.sent.push(msg);
    if (msg.type === 'auth') queueMicrotask(() => this.emit({ type: 'auth_ok' }));
    else if (msg.type === 'get_states') queueMicrotask(() => this.emit({
      id: msg.id, type: 'result', success: true, result: [
        { entity_id: 'light.kitchen', state: 'on', attributes: { brightness: 128 } },
        { entity_id: 'switch.plug', state: 'off', attributes: {} },
      ],
    }));
    else if (msg.type === 'subscribe_events') queueMicrotask(() => this.emit({ id: msg.id, type: 'result', success: true, result: null }));
    else if (msg.type === 'call_service') queueMicrotask(() => this.emit({ id: msg.id, type: 'result', success: true, result: null }));
  }
  close() { this.readyState = 3; this.onclose?.(); }
}

test('only local HTTP and arbitrary HTTPS URLs are allowed', () => {
  assert.equal(haURL('192.168.0.20'), 'http://192.168.0.20:8123');
  assert.equal(haURL('http://homeassistant.local:8123'), 'http://homeassistant.local:8123');
  assert.equal(haURL('https://example.com'), 'https://example.com');
  assert.throws(() => haURL('http://example.com'), /Plain HTTP/);
  assert.throws(() => haURL('https://example.com/redirect'), /server address/);
  assert.throws(() => haURL('https://user:pass@example.com'), /server address/);
});

test('reads linked light states and maps HA service calls', () => {
  const reading = haReading({ entity_id: 'light.kitchen', state: 'on', attributes: { brightness: 128, color_mode: 'rgb', rgb_color: [20, 80, 255] } });
  assert.equal(reading.light.on, true);
  assert.equal(reading.light.color, '#1450ff');
  assert.ok(reading.light.brightness > .5);
  assert.deepEqual(haCalls('light.kitchen', { on: false }, {}), [['light','turn_off',{}]]);
  assert.deepEqual(haCalls('light.kitchen', { on: true, brightness: .45 }, {}), [['light','turn_on',{ brightness_pct: 45 }]]);
  assert.deepEqual(haCalls('climate.room', { target: 23 }, { mode: 'cool' }), [['climate', 'set_temperature', { temperature: 23 }]]);
  assert.throws(() => haCalls('sensor.temperature', { on: true }, {}), /Unsupported/);
});

test('authenticates, reads states, listens for updates and calls services', async () => {
  const received = [];
  const client = new HAConnection(FakeSocket);
  await client.connect('http://192.168.0.20:8123', 'a'.repeat(40), state => received.push(state));
  assert.equal(client.connected, true);
  assert.equal(received.length, 2);
  assert.equal(FakeSocket.last.url, 'ws://192.168.0.20:8123/api/websocket');
  FakeSocket.last.emit({ type: 'event', id: client.subscriptionId, event: {
    event_type: 'state_changed', data: { entity_id: 'light.kitchen', new_state: {
      entity_id: 'light.kitchen', state: 'off', attributes: {},
    } },
  } });
  assert.equal(received.at(-1).state, 'off');
  await client.call('light', 'turn_on', 'light.kitchen', { brightness_pct: 50 });
  assert.equal(FakeSocket.last.sent.at(-1).service, 'turn_on');
  assert.deepEqual(FakeSocket.last.sent.at(-1).service_data, { brightness_pct: 50, entity_id: 'light.kitchen' });
  client.close();
  assert.equal(client.connected, false);
});

test('buffers updates during get_states and uses the newest timestamp', async () => {
  class RacingSocket extends FakeSocket {
    send(text) {
      const msg = JSON.parse(text);
      this.sent.push(msg);
      if (msg.type === 'auth') queueMicrotask(() => this.emit({ type: 'auth_ok' }));
      else if (msg.type === 'subscribe_events') queueMicrotask(() => this.emit({
        id: msg.id, type: 'result', success: true, result: null,
      }));
      else if (msg.type === 'get_states') queueMicrotask(() => {
        const id = this.sent.find(x => x.type === 'subscribe_events').id;
        this.emit({ type: 'event', id, event: { data: {
          entity_id: 'light.kitchen',
          new_state: { entity_id: 'light.kitchen', state: 'off', last_updated: '2026-11-22T18:03:00Z' },
        } } });
        this.emit({ id: msg.id, type: 'result', success: true, result: [
          { entity_id: 'light.kitchen', state: 'on', last_updated: '2026-11-22T18:02:00Z' },
        ] });
      });
    }
  }
  const seen = [];
  const client = new HAConnection(RacingSocket);
  await client.connect('192.168.0.20', 'a'.repeat(40), state => seen.push(state));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].state, 'off');
  RacingSocket.last.emit({ type: 'event', id: client.subscriptionId, event: {
    data: { entity_id: 'light.kitchen', new_state: null },
  } });
  assert.equal(seen.at(-1).state, 'unavailable');
  client.close();
});

test('rejects commands when the socket closes', async () => {
  const client = new HAConnection(FakeSocket);
  await client.connect('192.168.0.20', 'a'.repeat(40), () => {});
  FakeSocket.last.close();
  await assert.rejects(client.call('light', 'turn_on', 'light.kitchen'), /not connected/);
  assert.equal(client.connected, false);
});
