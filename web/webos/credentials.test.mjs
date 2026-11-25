import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createHACredentialStore } from '../src/webos-credentials.js';

const credentials = { url: 'homeassistant.local', token: 'example-long-lived-token' };
const normalized = { ...credentials, url: 'http://homeassistant.local:8123' };

// LG's Keymanager3 rejects unknown parameters, so the fake accepts exactly the keys each
// method takes on hardware. `mac_length` on generateKey broke real TVs (b8fbe50).
const ALLOWED = {
  generateKey: { top: ['name', 'params'], params: ['type', 'mode', 'padding', 'size', 'purpose'], required: ['type', 'mode', 'padding', 'size', 'purpose'] },
  begin: { top: ['name', 'params'], params: ['type', 'mode', 'padding', 'purpose', 'mac_length', 'iv'], required: ['type', 'mode', 'padding', 'purpose', 'mac_length'] },
  finish: { top: ['handle', 'data'] },
  abort: { top: ['handle'] },
  removeKey: { top: ['name'] },
};

function assertExactKeys(label, value, allowed, required = allowed) {
  for (const key of Object.keys(value)) assert.ok(allowed.includes(key), `${label} must not send ${key}; Keymanager3 accepts only ${allowed.join(', ')}`);
  for (const key of required) assert.ok(Object.hasOwn(value, key), `${label} must send ${key}`);
}

function assertParameters(method, parameters) {
  const rule = ALLOWED[method];
  assert.ok(rule, `Keymanager3 method ${method} is not used by the credential store; add it to ALLOWED only after checking LG's API`);
  assertExactKeys(method, parameters, rule.top);
  if (rule.params) assertExactKeys(`${method}.params`, parameters.params, rule.params, rule.required);
}

function fakePlatform() {
  const records = new Map();
  const writes = [];
  let key;
  let operation;
  let fail;
  const methods = [];
  return {
    records,
    writes,
    methods,
    fail(method) { fail = method; },
    storage: {
      getItem: id => records.get(id) ?? null,
      setItem: (id, value) => { writes.push([id, value]); records.set(id, value); },
      removeItem: id => records.delete(id),
    },
    async request(method, parameters) {
      const { params, data, handle } = parameters;
      methods.push(method);
      assertParameters(method, parameters);
      if (method === fail) throw new Error(credentials.token);
      if (method === 'generateKey') {
        if (key) throw Object.assign(new Error(), { code: -10002 });
        assert.equal(params.size, 256);
        assert.equal(params.mac_length, undefined);
        key = randomBytes(32);
      } else if (method === 'begin') {
        assert.deepEqual(params.mode, ['GCM']);
        assert.equal(params.mac_length, '128');
        assert.ok(key);
        const iv = params.iv ? Buffer.from(params.iv, 'base64') : randomBytes(12);
        operation = { iv, purpose: params.purpose[0] };
        return { handle: '18446744073709551615', iv: iv.toString('base64') };
      } else if (method === 'finish') {
        assert.equal(handle, '18446744073709551615');
        const input = Buffer.from(data, 'base64');
        const { iv, purpose } = operation;
        if (purpose === 'encrypt') {
          const cipher = createCipheriv('aes-256-gcm', key, iv);
          return { output: Buffer.concat([cipher.update(input), cipher.final(), cipher.getAuthTag()]).toString('base64') };
        }
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(input.subarray(-16));
        return { output: Buffer.concat([decipher.update(input.subarray(0, -16)), decipher.final()]).toString('base64') };
      } else if (method === 'abort') {
        operation = undefined;
      } else if (method === 'removeKey') {
        if (!key) throw Object.assign(new Error(), { code: -10001 });
        key = undefined;
      } else {
        assert.fail(method);
      }
      return { returnValue: true };
    },
  };
}

test('only authenticated ciphertext persists across store instances', async () => {
  const platform = fakePlatform();
  const store = createHACredentialStore(platform);
  assert.equal(await store.load(), null);
  await store.save(credentials);
  const [[id, serialized]] = platform.records;
  assert.doesNotMatch(serialized, /homeassistant|example-long-lived-token/);
  assert.deepEqual(await createHACredentialStore(platform).load(), normalized);
  await store.save(credentials);
  assert.notEqual(JSON.parse(platform.records.get(id)).iv, JSON.parse(serialized).iv);

  const modified = JSON.parse(serialized);
  const bytes = Buffer.from(modified.ciphertext, 'base64');
  bytes[0] ^= 1;
  modified.ciphertext = bytes.toString('base64');
  platform.records.set(id, JSON.stringify(modified));
  await assert.rejects(store.load(), /Protected Home Assistant storage is unavailable/);
  assert.equal(platform.methods.at(-1), 'abort');
});

test('failed replacement preserves the original and never writes its plaintext', async () => {
  const platform = fakePlatform();
  const store = createHACredentialStore(platform);
  await store.save(credentials);
  const original = [...platform.records];
  platform.fail('finish');
  await assert.rejects(store.save({ ...credentials, token: 'another-long-lived-token' }), {
    message: 'Protected Home Assistant storage is unavailable.',
  });
  assert.deepEqual([...platform.records], original);
  assert.equal(platform.methods.at(-1), 'abort');
});

test('clear runs after a pending save and invalidates a retained copy', async () => {
  const platform = fakePlatform();
  const store = createHACredentialStore(platform);
  await store.save(credentials);
  const original = [...platform.records];
  await Promise.all([store.save(credentials), store.clear()]);
  assert.equal(await store.load(), null);
  await store.clear();
  platform.records.set(...original[0]);
  await assert.rejects(store.load(), /Protected Home Assistant storage is unavailable/);
});

test('invalid input and missing platform support never write a record', async () => {
  const platform = fakePlatform();
  const store = createHACredentialStore({ storage: platform.storage });
  await assert.rejects(store.save({ ...credentials, url: 'https://user:pass@host' }), /valid Home Assistant server address/);
  await assert.rejects(store.save(credentials), /Protected Home Assistant storage is unavailable/);
  assert.equal(platform.records.size, 0);
});

test('uses the official Luna bridge and ignores platform error text', async t => {
  const platform = fakePlatform();
  globalThis.webOS = {
    service: {
      request(uri, { method, parameters, onSuccess, onFailure }) {
        assert.equal(uri, 'luna://com.webos.service.keymanager3');
        platform.request(method, parameters).then(
          result => onSuccess({ ...result, returnValue: true }),
          error => onFailure({ returnValue: false, errorCode: error.code, errorText: credentials.token }),
        );
        return { cancel() {} };
      },
    },
  };
  t.after(() => { delete globalThis.webOS; });
  const store = createHACredentialStore({ storage: platform.storage });
  await store.save(credentials);
  await store.save(credentials);
  assert.deepEqual(await store.load(), normalized);
  platform.fail('removeKey');
  await assert.rejects(store.clear(), { message: 'Protected Home Assistant storage is unavailable.' });
  assert.equal(await store.load(), null);
});

test('no plaintext token reaches storage across connect, reload and disconnect', async () => {
  const platform = fakePlatform();
  const token = 'plaintext-sentinel-token-0123456789';
  const assertNoPlaintext = stage => {
    for (const [id, value] of [...platform.writes, ...platform.records]) {
      assert.ok(!String(value).includes(token) && !String(id).includes(token), `${stage} wrote the HA token to ${id}; store only the Keymanager3 envelope`);
      assert.ok(!String(value).includes('homeassistant.local'), `${stage} wrote the HA URL in plaintext to ${id}`);
    }
  };
  await createHACredentialStore(platform).save({ ...credentials, token });
  assertNoPlaintext('connect');
  const reloaded = createHACredentialStore(platform);
  assert.equal((await reloaded.load()).token, token);
  assertNoPlaintext('reload');
  await reloaded.clear();
  assertNoPlaintext('disconnect');
  assert.equal(platform.records.size, 0);
  assert.equal(await createHACredentialStore(platform).load(), null);
});

test('the fake Keymanager3 rejects parameters LG does not accept', () => {
  const platform = fakePlatform();
  const aes = { type: 'AES', mode: ['GCM'], padding: ['None'] };
  return Promise.all([
    assert.rejects(platform.request('generateKey', { name: 'k', params: { ...aes, size: 256, purpose: ['encrypt'], mac_length: '128' } }), /generateKey.params must not send mac_length/),
    assert.rejects(platform.request('begin', { name: 'k', params: { ...aes, purpose: ['encrypt'] } }), /begin.params must send mac_length/),
    assert.rejects(platform.request('finish', { handle: '1', data: '', extra: 1 }), /finish must not send extra/),
    assert.rejects(platform.request('update', { handle: '1' }), /not used by the credential store/),
  ]);
});
