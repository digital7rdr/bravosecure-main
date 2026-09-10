/**
 * `VaultClient` — the File Vault's HTTP adapter, executed rather than scanned.
 *
 * SECURITY (CLAUDE.md stop condition — "File vault MFA gate or any download URL
 * issuance flow"): every call into the vault control plane MUST carry a fresh
 * `X-Mfa-Proof`. The server's MfaGuard is the real gate, but a client that
 * forgot the header — or reused one proof for two operations, or fetched bytes
 * anyway after the guard said no — turns a working server gate into a hole this
 * module opened. Those are the properties pinned below.
 *
 * The whole file was at 0% executable coverage: nothing had ever run
 * `uploadEncrypted`, `downloadAndDecrypt` or `authJson`. Deleting the
 * `X-Mfa-Proof` line, or the `if (!token)` fail-closed, broke no test.
 *
 * Real `aesCbc` is used deliberately (quick-crypto is mapped to Node's crypto by
 * the messenger-crypto project), so the round-trip below proves the bytes PUT to
 * storage are the ciphertext the returned key/iv actually open — a mocked
 * encryptor could not tell plaintext from ciphertext.
 */
import {VaultClient, VaultHttpError} from '../vault/vaultClient';

type Call = {url: string; init?: RequestInit};

const calls: Call[] = [];
/** url-substring → response factory. First match wins. */
let routes: Array<{match: string; reply: (c: Call) => unknown}> = [];

function res(body: {
  status?: number;
  statusText?: string;
  text?: string;
  bytes?: Uint8Array;
}) {
  const status = body.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: body.statusText ?? '',
    text: async () => body.text ?? '',
    arrayBuffer: async () => {
      const b = body.bytes ?? new Uint8Array();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  };
}

beforeEach(() => {
  calls.length = 0;
  routes = [];
  (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const call = {url: String(url), init};
    calls.push(call);
    const hit = routes.find(r => call.url.includes(r.match));
    if (!hit) {return res({status: 404, statusText: 'no route: ' + call.url});}
    return hit.reply(call);
  });
});

const BASE = 'https://msg.invalid';

function makeClient(over: Partial<{token: string | null; deviceId: number}> = {}) {
  const getToken = jest.fn(async () => ('token' in over ? over.token! : 'jwt-abc'));
  const client = new VaultClient({
    baseUrl: BASE,
    getToken,
    signalDeviceId: over.deviceId ?? 1,
  });
  return {client, getToken};
}

const headersOf = (c: Call) => (c.init?.headers ?? {}) as Record<string, string>;
const controlPlaneCalls = () => calls.filter(c => c.url.startsWith(BASE));

describe('VaultClient — the MFA proof is threaded on EVERY control-plane call', () => {
  it('sends the caller proof in X-Mfa-Proof when minting an upload url', async () => {
    routes = [
      {match: '/vault/upload-url', reply: () => res({text: JSON.stringify({uploadUrl: 'https://s3.invalid/put', objectKey: 'vault/u1/abc'})})},
      {match: 's3.invalid/put', reply: () => res({})},
    ];
    const {client} = makeClient();
    await client.uploadEncrypted(new Uint8Array([1, 2, 3]), 'application/pdf', 'proof-upload-1');

    const mint = controlPlaneCalls()[0];
    expect(mint.url).toBe(`${BASE}/vault/upload-url`);
    expect(headersOf(mint)['X-Mfa-Proof']).toBe('proof-upload-1');
  });

  it('sends the caller proof in X-Mfa-Proof when minting a download url', async () => {
    const enc = await encryptFixture(new Uint8Array([9, 9]));
    routes = [
      {match: '/vault/download-url/', reply: () => res({text: JSON.stringify({downloadUrl: 'https://s3.invalid/get'})})},
      {match: 's3.invalid/get', reply: () => res({bytes: enc.ciphertext})},
    ];
    const {client} = makeClient();
    await client.downloadAndDecrypt({objectKey: 'vault/u1/abc', keyB64: enc.key, ivB64: enc.iv, mfaProof: 'proof-open-1'});

    const mint = controlPlaneCalls()[0];
    expect(mint.url).toBe(`${BASE}/vault/download-url/vault/u1/abc`);
    expect(headersOf(mint)['X-Mfa-Proof']).toBe('proof-open-1');
  });

  /**
   * Proofs are SINGLE-USE server-side (replay guard), so the client must never
   * cache one across operations. Two opens must present the two proofs their
   * callers minted, in order — a client that stashed the first would be
   * replaying a burnt token and every second open would 401 in production.
   */
  it('never caches a proof across operations — each call carries its own', async () => {
    const enc = await encryptFixture(new Uint8Array([4]));
    routes = [
      {match: '/vault/download-url/', reply: () => res({text: JSON.stringify({downloadUrl: 'https://s3.invalid/get'})})},
      {match: 's3.invalid/get', reply: () => res({bytes: enc.ciphertext})},
    ];
    const {client} = makeClient();
    const p = {objectKey: 'k', keyB64: enc.key, ivB64: enc.iv};
    await client.downloadAndDecrypt({...p, mfaProof: 'proof-A'});
    await client.downloadAndDecrypt({...p, mfaProof: 'proof-B'});

    expect(controlPlaneCalls().map(c => headersOf(c)['X-Mfa-Proof'])).toEqual(['proof-A', 'proof-B']);
  });

  it('binds the request to the signal device id the host was constructed with', async () => {
    routes = [{match: '/vault/download-url/', reply: () => res({status: 403, text: '{}'})}];
    const {client} = makeClient({deviceId: 7});
    await expect(client.downloadAndDecrypt({objectKey: 'k', keyB64: 'x', ivB64: 'y', mfaProof: 'p'}))
      .rejects.toBeInstanceOf(VaultHttpError);
    expect(headersOf(controlPlaneCalls()[0])['X-Signal-Device-Id']).toBe('7');
  });

  it('carries the bearer token alongside the proof — the proof is EXTRA, not a substitute', async () => {
    routes = [{match: '/vault/download-url/', reply: () => res({status: 403, text: '{}'})}];
    const {client} = makeClient({token: 'jwt-xyz'});
    await expect(client.downloadAndDecrypt({objectKey: 'k', keyB64: 'x', ivB64: 'y', mfaProof: 'p'}))
      .rejects.toBeInstanceOf(VaultHttpError);
    const h = headersOf(controlPlaneCalls()[0]);
    expect(h.Authorization).toBe('Bearer jwt-xyz');
    expect(h['X-Mfa-Proof']).toBe('p');
  });
});

describe('VaultClient — the gate FAILS CLOSED, it is never bypassed', () => {
  /**
   * The download url is what the MfaGuard actually protects. A rejected proof
   * must end the operation — not fall through to a cached url, a retry without
   * the header, or a bare GET at the object key.
   */
  it('a rejected proof (403) yields NO byte fetch at all', async () => {
    routes = [{match: '/vault/download-url/', reply: () => res({status: 403, text: JSON.stringify({message: 'mfa_required'})})}];
    const {client} = makeClient();

    await expect(client.downloadAndDecrypt({objectKey: 'vault/u1/abc', keyB64: 'k', ivB64: 'i', mfaProof: 'stale'}))
      .rejects.toMatchObject({name: 'VaultHttpError', status: 403, message: 'mfa_required'});

    expect(calls).toHaveLength(1);            // the mint attempt, and nothing after it
    expect(calls.some(c => c.url.includes('s3.invalid'))).toBe(false);
  });

  it('a rejected proof on upload never PUTs the bytes anywhere', async () => {
    routes = [{match: '/vault/upload-url', reply: () => res({status: 403, text: JSON.stringify({message: 'mfa_required'})})}];
    const {client} = makeClient();

    await expect(client.uploadEncrypted(new Uint8Array([1, 2, 3]), 'image/png', 'stale'))
      .rejects.toMatchObject({status: 403});

    expect(calls.filter(c => c.init?.method === 'PUT')).toHaveLength(0);
  });

  it('no auth token → 401 no_token BEFORE any network call is made', async () => {
    const {client, getToken} = makeClient({token: null});
    await expect(client.downloadAndDecrypt({objectKey: 'k', keyB64: 'x', ivB64: 'y', mfaProof: 'p'}))
      .rejects.toMatchObject({name: 'VaultHttpError', status: 401, message: 'no_token'});
    expect(getToken).toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('a failed storage PUT is surfaced with the storage status, not swallowed', async () => {
    routes = [
      {match: '/vault/upload-url', reply: () => res({text: JSON.stringify({uploadUrl: 'https://s3.invalid/put', objectKey: 'vault/u1/abc'})})},
      {match: 's3.invalid/put', reply: () => res({status: 503})},
    ];
    const {client} = makeClient();
    await expect(client.uploadEncrypted(new Uint8Array([1]), 'text/plain', 'p'))
      .rejects.toMatchObject({name: 'VaultHttpError', status: 503, message: 'upload failed'});
  });

  it('a failed storage GET is surfaced instead of returning empty bytes', async () => {
    routes = [
      {match: '/vault/download-url/', reply: () => res({text: JSON.stringify({downloadUrl: 'https://s3.invalid/get'})})},
      {match: 's3.invalid/get', reply: () => res({status: 404})},
    ];
    const {client} = makeClient();
    await expect(client.downloadAndDecrypt({objectKey: 'k', keyB64: 'x', ivB64: 'y', mfaProof: 'p'}))
      .rejects.toMatchObject({name: 'VaultHttpError', status: 404, message: 'download failed'});
  });
});

describe('VaultClient — what actually leaves the device', () => {
  it('uploads CIPHERTEXT, never the plaintext bytes', async () => {
    const plaintext = new TextEncoder().encode('rota-2026-classified');
    routes = [
      {match: '/vault/upload-url', reply: () => res({text: JSON.stringify({uploadUrl: 'https://s3.invalid/put', objectKey: 'vault/u1/abc'})})},
      {match: 's3.invalid/put', reply: () => res({})},
    ];
    const {client} = makeClient();
    await client.uploadEncrypted(plaintext, 'text/plain', 'p');

    const put = calls.find(c => c.init?.method === 'PUT')!;
    const body = put.init!.body as unknown as Uint8Array;
    expect(Buffer.from(body).includes(Buffer.from(plaintext))).toBe(false);
    // v2 attachment format: [0x02 | aes-cbc | hmac-32].
    expect(body[0]).toBe(0x02);
  });

  it('declares the CIPHERTEXT length to the presigner, so the PUT is not rejected', async () => {
    const plaintext = new Uint8Array(64);
    let declared = -1;
    routes = [
      {
        match: '/vault/upload-url',
        reply: (c) => {
          declared = JSON.parse(String(c.init!.body)).contentLength;
          return res({text: JSON.stringify({uploadUrl: 'https://s3.invalid/put', objectKey: 'vault/u1/abc'})});
        },
      },
      {match: 's3.invalid/put', reply: () => res({})},
    ];
    const {client} = makeClient();
    await client.uploadEncrypted(plaintext, 'application/octet-stream', 'p');

    const put = calls.find(c => c.init?.method === 'PUT')!;
    const body = put.init!.body as unknown as Uint8Array;
    expect(declared).toBe(body.byteLength);
    expect(declared).toBeGreaterThan(plaintext.byteLength);   // padding + version + tag
    expect((put.init!.headers as Record<string, string>)['Content-Length']).toBe(String(body.byteLength));
  });

  it('reports the PLAINTEXT size to the index, so the UI does not show padded bytes', async () => {
    const plaintext = new Uint8Array(100);
    routes = [
      {match: '/vault/upload-url', reply: () => res({text: JSON.stringify({uploadUrl: 'https://s3.invalid/put', objectKey: 'vault/u1/abc'})})},
      {match: 's3.invalid/put', reply: () => res({})},
    ];
    const {client} = makeClient();
    const out = await client.uploadEncrypted(plaintext, 'image/jpeg', 'p');
    expect(out).toMatchObject({objectKey: 'vault/u1/abc', size: 100, mimeType: 'image/jpeg'});
    expect(out.keyB64).toEqual(expect.any(String));
    expect(out.ivB64).toEqual(expect.any(String));
  });

  /**
   * The whole point of the adapter: the key material it hands back is the key
   * material that opens what it stored. A wrong key/iv pairing here means every
   * vault row is a permanently unopenable file, and no unit-level mock of the
   * cipher could catch it.
   */
  it('round-trips: the returned key + iv decrypt exactly what was PUT', async () => {
    const plaintext = new TextEncoder().encode('deployment-order §12');
    let stored: Uint8Array = new Uint8Array();
    routes = [
      {match: '/vault/upload-url', reply: () => res({text: JSON.stringify({uploadUrl: 'https://s3.invalid/put', objectKey: 'vault/u1/abc'})})},
      {match: 's3.invalid/put', reply: (c) => { stored = c.init!.body as unknown as Uint8Array; return res({}); }},
      {match: '/vault/download-url/', reply: () => res({text: JSON.stringify({downloadUrl: 'https://s3.invalid/get'})})},
      {match: 's3.invalid/get', reply: () => res({bytes: stored})},
    ];
    const {client} = makeClient();
    const up = await client.uploadEncrypted(plaintext, 'text/plain', 'proof-1');
    const back = await client.downloadAndDecrypt({
      objectKey: up.objectKey, keyB64: up.keyB64, ivB64: up.ivB64, mfaProof: 'proof-2',
    });
    expect(new TextDecoder().decode(back)).toBe('deployment-order §12');
  });

  it('a tampered stored blob is REFUSED rather than decrypted (encrypt-then-MAC)', async () => {
    const plaintext = new TextEncoder().encode('pay this invoice to IBAN A');
    let stored: Uint8Array = new Uint8Array();
    routes = [
      {match: '/vault/upload-url', reply: () => res({text: JSON.stringify({uploadUrl: 'https://s3.invalid/put', objectKey: 'vault/u1/abc'})})},
      {match: 's3.invalid/put', reply: (c) => { stored = c.init!.body as unknown as Uint8Array; return res({}); }},
      {match: '/vault/download-url/', reply: () => res({text: JSON.stringify({downloadUrl: 'https://s3.invalid/get'})})},
      {match: 's3.invalid/get', reply: () => {
        const t = Uint8Array.from(stored);
        t[5] ^= 0xff;                       // storage-side bit flip
        return res({bytes: t});
      }},
    ];
    const {client} = makeClient();
    const up = await client.uploadEncrypted(plaintext, 'text/plain', 'p1');
    await expect(client.downloadAndDecrypt({
      objectKey: up.objectKey, keyB64: up.keyB64, ivB64: up.ivB64, mfaProof: 'p2',
    })).rejects.toThrow(/hmac mismatch|not supported/i);
  });

  it('sets a JSON content-type only when there is a body to send', async () => {
    routes = [
      {match: '/vault/upload-url', reply: () => res({text: JSON.stringify({uploadUrl: 'https://s3.invalid/put', objectKey: 'o'})})},
      {match: 's3.invalid/put', reply: () => res({})},
      {match: '/vault/download-url/', reply: () => res({status: 500, text: ''})},
    ];
    const {client} = makeClient();
    await client.uploadEncrypted(new Uint8Array([1]), 'text/plain', 'p');
    await expect(client.downloadAndDecrypt({objectKey: 'o', keyB64: 'k', ivB64: 'i', mfaProof: 'p'})).rejects.toThrow();

    const mintUpload = calls.find(c => c.url.endsWith('/vault/upload-url'))!;
    const mintDownload = calls.find(c => c.url.includes('/vault/download-url/'))!;
    expect(headersOf(mintUpload)['Content-Type']).toBe('application/json');
    expect(headersOf(mintDownload)['Content-Type']).toBeUndefined();
    expect(mintDownload.init?.body).toBeUndefined();
  });

  it('does not send the presigned storage request with our credentials', async () => {
    // The presigned url IS the capability; attaching the bearer token or the
    // proof to a third-party host hands both to storage for no benefit.
    routes = [
      {match: '/vault/upload-url', reply: () => res({text: JSON.stringify({uploadUrl: 'https://s3.invalid/put', objectKey: 'o'})})},
      {match: 's3.invalid/put', reply: () => res({})},
    ];
    const {client} = makeClient();
    await client.uploadEncrypted(new Uint8Array([1]), 'text/plain', 'secret-proof');

    const put = calls.find(c => c.url.includes('s3.invalid'))!;
    const h = headersOf(put);
    expect(h.Authorization).toBeUndefined();
    expect(h['X-Mfa-Proof']).toBeUndefined();
  });
});

describe('VaultClient — error reporting stays honest', () => {
  it('prefers the server message field', async () => {
    routes = [{match: '/vault/download-url/', reply: () => res({status: 402, text: JSON.stringify({message: 'quota_exceeded'})})}];
    const {client} = makeClient();
    await expect(client.downloadAndDecrypt({objectKey: 'o', keyB64: 'k', ivB64: 'i', mfaProof: 'p'}))
      .rejects.toMatchObject({status: 402, message: 'quota_exceeded'});
  });

  it('falls back to the raw body when the error is not JSON (an HTML 502 page)', async () => {
    routes = [{match: '/vault/download-url/', reply: () => res({status: 502, text: '<html>bad gateway</html>'})}];
    const {client} = makeClient();
    await expect(client.downloadAndDecrypt({objectKey: 'o', keyB64: 'k', ivB64: 'i', mfaProof: 'p'}))
      .rejects.toMatchObject({status: 502, message: '<html>bad gateway</html>'});
  });

  it('falls back to the status text when the error body is empty', async () => {
    routes = [{match: '/vault/download-url/', reply: () => res({status: 504, statusText: 'Gateway Timeout', text: ''})}];
    const {client} = makeClient();
    await expect(client.downloadAndDecrypt({objectKey: 'o', keyB64: 'k', ivB64: 'i', mfaProof: 'p'}))
      .rejects.toMatchObject({status: 504, message: 'Gateway Timeout'});
  });

  it('VaultHttpError is a real Error subclass, so callers can catch and read .status', async () => {
    routes = [{match: '/vault/download-url/', reply: () => res({status: 418, text: ''})}];
    const {client} = makeClient();
    try {
      await client.downloadAndDecrypt({objectKey: 'o', keyB64: 'k', ivB64: 'i', mfaProof: 'p'});
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(VaultHttpError);
      expect((e as VaultHttpError).status).toBe(418);
      expect((e as Error).name).toBe('VaultHttpError');
    }
  });
});

/** Encrypt with the same primitive the client uses, for download-only cases. */
async function encryptFixture(bytes: Uint8Array) {
  const {encryptAttachment} = require('../media/aesCbc') as typeof import('../media/aesCbc');
  return encryptAttachment(bytes);
}
