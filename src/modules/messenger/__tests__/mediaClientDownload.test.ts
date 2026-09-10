/**
 * `media/mediaClient.ts` — the DOWNLOAD half, plus the auth envelope.
 *
 * The existing suites cover `registerGrants` (P0-V5) and the upload length
 * probe (MEDIA-31). Everything below the download-url call had never been
 * executed:
 *
 *   - the ciphertext-cache hit path (media-parity G6/#24), including the
 *     self-heal that EVICTS a cached blob whose unwrap fails and refetches —
 *     without it a stale row pins "image unavailable" forever;
 *   - the invariant this whole cache exists to keep: it stores WIRE bytes, so
 *     plaintext must never reach `cache.put`;
 *   - `authJson` — no token, server error-message extraction, non-JSON bodies;
 *   - the failure classes the bubble renders (403 forbidden / 404 gone /
 *     network offline) arriving as MediaHttpError with the right status.
 *
 * Crypto is REAL here (aesCbc via the quick-crypto shim), so the round-trip
 * test proves the client's wiring end to end rather than against a stub, and
 * the tamper case proves the pipeline still fails closed when R2 lies.
 */
import {MediaClient, MediaHttpError} from '../media/mediaClient';
import {encryptAttachment} from '../media/aesCbc';
import {classifyAttachmentError} from '../media/attachmentError';
import type {MediaBlobCache} from '../media/mediaBlobCache';

type R2Object = {body: Uint8Array; contentType: string};

interface Harness {
  fetchImpl: typeof fetch;
  objects: Map<string, R2Object>;
  calls: Array<{url: string; method: string; headers: Record<string, string>}>;
  /** Force a status for the presigned GET of a given object key. */
  getStatus: Map<string, number>;
  /** Make the presigned GET throw like a dead socket. */
  networkDown: {value: boolean};
  /** Override the response of the auth-json endpoints. */
  authResponse: {value: Response | null};
  /** Status for the presigned PUT (the no-progress fetch path). */
  putStatus: {value: number};
  /** Make the download-url mint fail, so the length probe cannot verify. */
  downloadUrlBroken: {value: boolean};
}

function makeHarness(): Harness {
  const objects = new Map<string, R2Object>();
  const calls: Harness['calls'] = [];
  const getStatus = new Map<string, number>();
  const networkDown = {value: false};
  const authResponse = {value: null as Response | null};
  const putStatus = {value: 200};
  const downloadUrlBroken = {value: false};
  let seq = 0;

  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200, headers: {'content-type': 'application/json'},
  });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({url, method, headers});

    if (url.endsWith('/media/upload-url')) {
      if (authResponse.value) {return authResponse.value;}
      seq += 1;
      return json({uploadUrl: `https://r2.test/put/att%2Fobj-${seq}`, objectKey: `att/obj-${seq}`});
    }
    if (url.includes('/media/download-url/')) {
      if (authResponse.value) {return authResponse.value;}
      if (downloadUrlBroken.value) {return new Response('nope', {status: 500, statusText: 'Server Error'});}
      const key = url.slice(url.indexOf('/media/download-url/') + '/media/download-url/'.length);
      return json({downloadUrl: `https://r2.test/get/${encodeURIComponent(key)}`});
    }
    if (url.endsWith('/media/purge') || url.endsWith('/media/grants')) {
      if (authResponse.value) {return authResponse.value;}
      return json({ok: true, purged: true});
    }
    if (method === 'PUT' && url.startsWith('https://r2.test/put/')) {
      if (putStatus.value >= 400) {
        return new Response('rejected', {status: putStatus.value, statusText: 'Forbidden'});
      }
      const key = decodeURIComponent(url.slice('https://r2.test/put/'.length));
      objects.set(key, {
        body: new Uint8Array(init!.body as Uint8Array),
        contentType: headers['Content-Type'] ?? 'application/octet-stream',
      });
      return new Response(null, {status: putStatus.value});
    }
    if (url.startsWith('https://r2.test/get/')) {
      if (networkDown.value) {throw new TypeError('Network request failed');}
      const key = decodeURIComponent(url.slice('https://r2.test/get/'.length));
      const forced = getStatus.get(key);
      if (forced) {return new Response('denied', {status: forced, statusText: 'Forbidden'});}
      const obj = objects.get(key);
      if (!obj) {return new Response('NoSuchKey', {status: 404, statusText: 'Not Found'});}
      if (headers.Range === 'bytes=0-0') {
        return new Response(obj.body.slice(0, 1), {
          status: 206, headers: {'Content-Range': `bytes 0-0/${obj.body.byteLength}`},
        });
      }
      return new Response(obj.body, {status: 200, headers: {'content-type': obj.contentType}});
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  }) as unknown as typeof fetch;

  return {fetchImpl, objects, calls, getStatus, networkDown, authResponse, putStatus, downloadUrlBroken};
}

/** In-memory stand-in for the SQLCipher ciphertext cache. */
function makeCache() {
  const rows = new Map<string, {bytes: Uint8Array; mime: string | null; size: number}>();
  const cache = {
    rows,
    get:    jest.fn(async (k: string) => rows.get(k)?.bytes ?? null),
    put:    jest.fn(async (k: string, bytes: Uint8Array, mime: string | null, size: number) => {
      rows.set(k, {bytes: new Uint8Array(bytes), mime, size});
    }),
    remove: jest.fn(async (k: string) => { rows.delete(k); }),
  };
  return cache;
}

function makeClient(h: Harness, cache?: ReturnType<typeof makeCache>, token: string | null = 'tok'): MediaClient {
  (globalThis as {fetch: typeof fetch}).fetch = h.fetchImpl;
  return new MediaClient({
    baseUrl:        'https://relay.test',
    getToken:       async () => token,
    signalDeviceId: 3,
    cache:          cache as unknown as MediaBlobCache | undefined,
  });
}

const realFetch = globalThis.fetch;
let warn: jest.SpyInstance;

beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => {
  (globalThis as {fetch: typeof fetch}).fetch = realFetch;
  warn.mockRestore();
});

const MARKER = 'TOP-SECRET-PLAINTEXT-MARKER';
const plaintext = new Uint8Array(Buffer.from(`${MARKER} — a document body`));

/** Put a genuine v2 blob in the fake bucket and return its key material. */
async function seedObject(h: Harness, key: string, pt: Uint8Array = plaintext) {
  const enc = await encryptAttachment(pt);
  h.objects.set(key, {body: enc.ciphertext, contentType: 'application/pdf'});
  return {objectKey: key, keyB64: enc.key, ivB64: enc.iv, wire: enc.ciphertext};
}

/**
 * Narrow a caught rejection to MediaHttpError — and PIN the failure class while
 * narrowing. Every site below reads `.status` / `.message` off the rejection,
 * and this assertion is what makes those reads honest: a client that stops
 * wrapping (a raw TypeError escaping the dead-socket path, an AbortError from
 * the stall watchdog) fails here with a clear message instead of silently
 * comparing `undefined`. It also catches a call that RESOLVES when the test
 * expects it to throw.
 */
function assertMediaHttpError(e: unknown): asserts e is MediaHttpError {
  expect(e).toBeInstanceOf(MediaHttpError);
}

describe('downloadEncrypted — the R2 path', () => {
  it('fetches, decrypts, and returns the original bytes', async () => {
    const h = makeHarness();
    const o = await seedObject(h, 'att/plain');
    const client = makeClient(h);
    const out = await client.downloadEncrypted(o);
    expect(Buffer.from(out).toString()).toContain(MARKER);
  });

  it('a full upload → download round-trip returns byte-identical plaintext', async () => {
    const h = makeHarness();
    const client = makeClient(h);
    const up = await client.uploadEncrypted(plaintext, 'application/pdf');
    const out = await client.downloadEncrypted({
      objectKey: up.objectKey, keyB64: up.keyB64, ivB64: up.ivB64,
    });
    expect(Buffer.from(out).equals(Buffer.from(plaintext))).toBe(true);
    expect(up.size).toBe(plaintext.byteLength);
    expect(up.mimeType).toBe('application/pdf');
  });

  it('a TAMPERED object fails closed — the client never hands back forged bytes', async () => {
    const h = makeHarness();
    const o = await seedObject(h, 'att/tampered');
    const stored = h.objects.get('att/tampered')!;
    stored.body[6] ^= 0xff;                        // flip a bit inside the AES body
    const client = makeClient(h);
    await expect(client.downloadEncrypted(o)).rejects.toThrow(/hmac mismatch/i);
  });

  it('403 surfaces as MediaHttpError(403) → the bubble says "no access"', async () => {
    const h = makeHarness();
    const o = await seedObject(h, 'att/forbidden');
    h.getStatus.set('att/forbidden', 403);
    const client = makeClient(h);
    const err = await client.downloadEncrypted(o).catch((e: unknown) => e);
    assertMediaHttpError(err);
    expect(err.status).toBe(403);
    expect(classifyAttachmentError(err)).toBe('forbidden');
  });

  it('404 (swept after the 30-day dwell) surfaces as "gone"', async () => {
    const h = makeHarness();
    const client = makeClient(h);
    const err = await client.downloadEncrypted({
      objectKey: 'att/never-existed', keyB64: 'x', ivB64: 'y',
    }).catch((e: unknown) => e);
    assertMediaHttpError(err);
    expect(err.status).toBe(404);
    expect(classifyAttachmentError(err)).toBe('gone');
  });

  it('a dead socket becomes status 0 → "offline" (tap to retry), not a raw TypeError', async () => {
    const h = makeHarness();
    const o = await seedObject(h, 'att/offline');
    h.networkDown.value = true;
    const client = makeClient(h);
    const err = await client.downloadEncrypted(o).catch((e: unknown) => e);
    assertMediaHttpError(err);
    expect(err.status).toBe(0);
    expect(classifyAttachmentError(err)).toBe('offline');
  });
});

describe('downloadEncrypted — the ciphertext cache', () => {
  it('a cache hit decrypts locally with ZERO network calls', async () => {
    const h = makeHarness();
    const o = await seedObject(h, 'att/cached');
    const cache = makeCache();
    await cache.put('att/cached', o.wire, 'application/pdf', o.wire.byteLength);
    const client = makeClient(h, cache);
    h.calls.length = 0;
    const out = await client.downloadEncrypted(o);
    expect(Buffer.from(out).toString()).toContain(MARKER);
    expect(h.calls).toHaveLength(0);
  });

  it('a fresh download fills the cache with WIRE bytes — plaintext never enters it', async () => {
    const h = makeHarness();
    const o = await seedObject(h, 'att/fill');
    const cache = makeCache();
    const client = makeClient(h, cache);
    await client.downloadEncrypted(o);
    await Promise.resolve();                       // put() is fire-and-forget
    expect(cache.put).toHaveBeenCalledTimes(1);
    const [key, bytes, mime, size] = cache.put.mock.calls[0];
    expect(key).toBe('att/fill');
    expect(Buffer.from(bytes as Uint8Array).equals(Buffer.from(o.wire))).toBe(true);
    expect(Buffer.from(bytes as Uint8Array).includes(MARKER)).toBe(false);
    expect(mime).toBe('application/pdf');          // content-type off the GET
    expect(size).toBe(o.wire.byteLength);
  });

  it('audit #24 — a cached blob that will not unwrap is EVICTED and refetched', async () => {
    const h = makeHarness();
    const o = await seedObject(h, 'att/stale');
    const cache = makeCache();
    // A blob cached under a different key (or a v1 truncation) — right key,
    // wrong bytes. Before #24 this pinned "image unavailable" forever.
    const junk = (await encryptAttachment(new Uint8Array([1, 2, 3]))).ciphertext;
    await cache.put('att/stale', junk, 'application/pdf', junk.byteLength);
    cache.put.mockClear();

    const client = makeClient(h, cache);
    const out = await client.downloadEncrypted(o);
    expect(Buffer.from(out).toString()).toContain(MARKER);   // self-healed
    expect(cache.remove).toHaveBeenCalledWith('att/stale');
    expect(h.calls.some(c => c.url.startsWith('https://r2.test/get/'))).toBe(true);
    // …and the fresh, correct bytes replace the poisoned row.
    await Promise.resolve();
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it('the eviction log stays categorical — no key material, no plaintext', async () => {
    const h = makeHarness();
    const o = await seedObject(h, 'att/logsafe');
    const cache = makeCache();
    const junk = (await encryptAttachment(new Uint8Array([7]))).ciphertext;
    await cache.put('att/logsafe', junk, null, junk.byteLength);
    const client = makeClient(h, cache);
    await client.downloadEncrypted(o);
    const lines = warn.mock.calls.map(c => c.join(' ')).join('\n');
    expect(lines).toContain('[mediaClient]');
    expect(lines).not.toContain(o.keyB64);
    expect(lines).not.toContain(o.ivB64);
    expect(lines).not.toContain(MARKER);
  });

  it('a cache read that THROWS falls through to R2 instead of failing the open', async () => {
    const h = makeHarness();
    const o = await seedObject(h, 'att/cacheboom');
    const cache = makeCache();
    cache.get.mockRejectedValueOnce(new Error('sqlcipher busy'));
    const client = makeClient(h, cache);
    await expect(client.downloadEncrypted(o)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('a cache WRITE failure never breaks the download (best-effort fill)', async () => {
    const h = makeHarness();
    const o = await seedObject(h, 'att/putboom');
    const cache = makeCache();
    cache.put.mockRejectedValue(new Error('disk full'));
    const client = makeClient(h, cache);
    const out = await client.downloadEncrypted(o);
    expect(Buffer.from(out).toString()).toContain(MARKER);
  });

  it('a remove() failure during self-heal still lets the refetch through', async () => {
    const h = makeHarness();
    const o = await seedObject(h, 'att/removeboom');
    const cache = makeCache();
    const junk = (await encryptAttachment(new Uint8Array([3]))).ciphertext;
    await cache.put('att/removeboom', junk, null, junk.byteLength);
    cache.remove.mockRejectedValueOnce(new Error('locked'));
    const client = makeClient(h, cache);
    await expect(client.downloadEncrypted(o)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('media-parity G6 — an upload seeds the cache with what it just PUT', async () => {
    const h = makeHarness();
    const cache = makeCache();
    const client = makeClient(h, cache);
    const up = await client.uploadEncrypted(plaintext, 'image/jpeg');
    await Promise.resolve();
    expect(cache.put).toHaveBeenCalledTimes(1);
    const [key, bytes] = cache.put.mock.calls[0];
    expect(key).toBe(up.objectKey);
    // The sender's own bubble now renders from cache: the seeded bytes are
    // exactly the object in the bucket, and are ciphertext.
    expect(Buffer.from(bytes as Uint8Array).equals(Buffer.from(h.objects.get(up.objectKey)!.body))).toBe(true);
    expect(Buffer.from(bytes as Uint8Array).includes(MARKER)).toBe(false);
  });

  it('with no cache configured the client still works (cache is optional)', async () => {
    const h = makeHarness();
    const o = await seedObject(h, 'att/nocache');
    const client = makeClient(h);
    await expect(client.downloadEncrypted(o)).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe('authJson — the authenticated relay envelope', () => {
  it('sends the bearer token and the signal device id on every call', async () => {
    const h = makeHarness();
    const o = await seedObject(h, 'att/hdr');
    const client = makeClient(h);
    await client.downloadEncrypted(o);
    const call = h.calls.find(c => c.url.includes('/media/download-url/'))!;
    expect(call.method).toBe('POST');
    expect(call.headers).toMatchObject({
      Authorization:        'Bearer tok',
      'X-Signal-Device-Id': '3',
    });
  });

  it('a missing token fails as 401 no_token WITHOUT hitting the network', async () => {
    const h = makeHarness();
    const client = makeClient(h, undefined, null);
    const err = await client.downloadEncrypted({objectKey: 'k', keyB64: 'a', ivB64: 'b'})
      .catch((e: unknown) => e);
    assertMediaHttpError(err);
    expect(err.status).toBe(401);
    expect(err.message).toBe('no_token');
    expect(h.calls).toHaveLength(0);
  });

  it('surfaces the server message field on an error response', async () => {
    const h = makeHarness();
    h.authResponse.value = new Response(JSON.stringify({message: 'not_object_owner'}), {
      status: 403, headers: {'content-type': 'application/json'},
    });
    const client = makeClient(h);
    const err = await client.purge('att/x').catch((e: unknown) => e);
    assertMediaHttpError(err);
    expect(err.status).toBe(403);
    expect(err.message).toBe('not_object_owner');
  });

  it('falls back to the raw body when the error is not JSON', async () => {
    const h = makeHarness();
    h.authResponse.value = new Response('<html>502 upstream</html>', {status: 502, statusText: 'Bad Gateway'});
    const client = makeClient(h);
    const err = await client.purge('att/x').catch((e: unknown) => e);
    assertMediaHttpError(err);
    expect(err.status).toBe(502);
    expect(err.message).toContain('502 upstream');
  });

  it('falls back to statusText when the error body is empty', async () => {
    const h = makeHarness();
    h.authResponse.value = new Response('', {status: 503, statusText: 'Service Unavailable'});
    const client = makeClient(h);
    const err = await client.purge('att/x').catch((e: unknown) => e);
    assertMediaHttpError(err);
    expect(err.message).toBe('Service Unavailable');
  });

  it('an empty 200 body reads as {} rather than throwing on JSON.parse', async () => {
    const h = makeHarness();
    h.authResponse.value = new Response('', {status: 200});
    const client = makeClient(h);
    await expect(client.purge('att/x')).resolves.toEqual({});
  });

  it('omits the JSON content-type on a body-less request', async () => {
    const h = makeHarness();
    const o = await seedObject(h, 'att/nobody');
    const client = makeClient(h);
    await client.downloadEncrypted(o);
    // requestDownloadUrl passes no body — the header must not be invented.
    const call = h.calls.find(c => c.url.includes('/media/download-url/'))!;
    expect(call.headers['Content-Type']).toBeUndefined();
  });
});

describe('uploadEncrypted — the no-progress fetch PUT', () => {
  it('a rejected PUT surfaces the presign status instead of a poisoned reference', async () => {
    const h = makeHarness();
    h.putStatus.value = 403;                     // expired / mis-signed presign
    const client = makeClient(h);
    const err = await client.uploadEncrypted(plaintext, 'image/jpeg').catch((e: unknown) => e);
    assertMediaHttpError(err);
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/upload failed/);
  });

  it('sends the exact content-type the server signed', async () => {
    const h = makeHarness();
    const client = makeClient(h);
    await client.uploadEncrypted(plaintext, 'audio/mp4');
    const put = h.calls.find(c => c.method === 'PUT')!;
    expect(put.headers['Content-Type']).toBe('audio/mp4');
    expect(put.headers['Content-Length']).toBe(String(h.objects.get('att/obj-1')!.body.byteLength));
  });

  it('an unverifiable length probe accepts the upload rather than failing the send', async () => {
    // MEDIA-31 posture: the probe answers "can't verify" (here the download-url
    // mint itself 500s) and the upload must still complete — the alternative is
    // blocking sends on a probe that is only advisory.
    const h = makeHarness();
    const client = makeClient(h);
    h.downloadUrlBroken.value = true;
    const res = await client.uploadEncrypted(plaintext, 'image/jpeg');
    expect(res.objectKey).toBe('att/obj-1');
    expect(h.calls.filter(c => c.method === 'PUT')).toHaveLength(1);
  });
});

describe('purge — A10 sender-initiated object delete', () => {
  it('POSTs the object key to /media/purge', async () => {
    const h = makeHarness();
    const client = makeClient(h);
    await expect(client.purge('att/gone-now')).resolves.toEqual({ok: true, purged: true});
    const call = h.calls.find(c => c.url.endsWith('/media/purge'))!;
    expect(call.method).toBe('POST');
    expect(call.headers['Content-Type']).toBe('application/json');
  });
});
