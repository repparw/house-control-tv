import { haURL } from './webos-ha.js';

const URI = 'luna://com.webos.service.keymanager3';
const KEY = 'house-control-ha-aes-gcm-v1';
const RECORD = 'house-control-ha-encrypted-v1';
const AES = { type: 'AES', mode: ['GCM'], padding: ['None'] };
const MAX_PAYLOAD = 8192;

function unavailable() {
  return new Error('Protected Home Assistant storage is unavailable.');
}

function requestKeymanager(method, parameters) {
  const service = globalThis.webOS?.service;
  if (!service?.request) throw unavailable();
  return new Promise((resolve, reject) => {
    let request;
    const timeout = setTimeout(() => {
      reject(unavailable());
      request?.cancel();
    }, 5000);
    const complete = callback => response => {
      clearTimeout(timeout);
      callback(response);
    };
    const fail = complete(response => {
      const error = unavailable();
      error.code = Number(response?.errorCode);
      reject(error);
    });
    try {
      request = service.request(URI, {
        method,
        parameters,
        onSuccess: complete(response => {
          if (response?.returnValue === true) resolve(response);
          else fail(response);
        }),
        onFailure: fail,
      });
    } catch {
      fail();
    }
  });
}

function credentials(value) {
  if (typeof value?.url !== 'string' || value.url.length > 2048 ||
      typeof value.token !== 'string' || !/^[A-Za-z0-9._-]{20,2048}$/.test(value.token.trim())) {
    throw new Error('Enter a Home Assistant server address and long-lived access token.');
  }
  // URL parsing errors can include user input. Keep errors safe for the setup UI.
  try {
    return { url: haURL(value.url), token: value.token.trim() };
  } catch {
    throw new Error('Enter a valid Home Assistant server address. Use HTTPS outside your private LAN.');
  }
}

function decode(value) {
  if (typeof value !== 'string' || value.length > MAX_PAYLOAD * 2) throw unavailable();
  try {
    return Uint8Array.from(atob(value), byte => byte.charCodeAt(0));
  } catch {
    throw unavailable();
  }
}

export function createHACredentialStore({ request = requestKeymanager, storage } = {}) {
  // Serialize writes, reads and removal so an in-flight save cannot undo a clear.
  let tail = Promise.resolve();
  function run(operation) {
    const result = tail.then(async () => {
      try {
        return await operation(storage ?? globalThis.localStorage);
      } catch {
        throw unavailable();
      }
    });
    tail = result.catch(() => {});
    return result;
  }

  async function crypt(purpose, data, iv) {
    const params = { ...AES, purpose: [purpose], mac_length: '128' };
    if (iv !== undefined) params.iv = iv;
    const started = await request('begin', { name: KEY, params });
    const { handle } = started;
    if (typeof handle !== 'string' || !/^\d+$/.test(handle)) throw unavailable();
    try {
      const { output } = await request('finish', { handle, data });
      return { output, iv: started.iv };
    } finally {
      // LG requires abort after begin. A completed handle may already be invalid.
      await request('abort', { handle }).catch(() => {});
    }
  }

  async function open(envelope) {
    const { version, iv, ciphertext } = envelope;
    if (version !== 1 || decode(iv).length !== 12 || decode(ciphertext).length <= 16) throw unavailable();
    const { output } = await crypt('decrypt', ciphertext, iv);
    return new TextDecoder('utf-8', { fatal: true }).decode(decode(output));
  }

  return {
    load: () => run(async disk => {
      const record = disk.getItem(RECORD);
      if (record === null) return null;
      if (record.length > MAX_PAYLOAD * 2) throw unavailable();
      return credentials(JSON.parse(await open(JSON.parse(record))));
    }),

    async save(value) {
      const input = JSON.stringify(credentials(value));
      return run(async disk => {
        try {
          await request('generateKey', { name: KEY, params: { ...AES, size: 256, purpose: ['encrypt', 'decrypt'] } });
        } catch (error) {
          if (error.code !== -10002) throw error;
        }
        const data = btoa(String.fromCharCode(...new TextEncoder().encode(input)));
        const { output: ciphertext, iv } = await crypt('encrypt', data);
        const envelope = { version: 1, iv, ciphertext };
        if (await open(envelope) !== input) throw unavailable();
        disk.setItem(RECORD, JSON.stringify(envelope));
      });
    },

    clear: () => run(async disk => {
      const saved = disk.getItem(RECORD) !== null;
      disk.removeItem(RECORD);
      // Removing the owning key also invalidates old copies of the ciphertext.
      try {
        await request('removeKey', { name: KEY });
      } catch (error) {
        if (error.code !== -10001 && saved) throw error;
      }
    }),
  };
}
