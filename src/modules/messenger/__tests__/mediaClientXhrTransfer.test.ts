/**
 * SN-02 — blob transfers must be bounded by INACTIVITY, not wall-clock.
 *
 * Two bugs live in this code's history and neither had an executing test:
 *
 *  1. the download guard was a fixed 60s `AbortController`. RN's fetch is
 *     XHR-backed and non-streaming, so that timer covered the WHOLE body: any
 *     blob bigger than bandwidth x 60s aborted on every attempt, and with no
 *     Range resume each retry replayed the same failure from byte 0. The
 *     attachment was unreceivable on a slow-but-working link.
 *  2. on the upload side `xhr.ontimeout` was wired but `xhr.timeout` was never
 *     assigned (default 0 = disabled), so the handler was DEAD CODE and a
 *     stalled upload hung forever at 90%, blocking the serial media queue
 *     behind it.
 *
 * The fix is a progress-rearmed stall watchdog. The two halves of that claim
 * are what this suite executes, in both directions:
 *   - a transfer that keeps reporting progress SURVIVES far past the stall
 *     window (this is the half a naive "it times out" test would let regress
 *     straight back to bug #1);
 *   - a transfer that goes quiet is aborted at the window with status 0, so
 *     `classifyAttachmentError` still says 'offline' and tap-to-retry fires.
 *
 * The node project has no XMLHttpRequest, which is exactly why these branches
 * were unreachable — the client falls back to fetch. A fake XHR is installed
 * on the global for this file only.
 */
import {MediaClient, MediaHttpError} from '../media/mediaClient';
import {encryptAttachment} from '../media/aesCbc';
import {classifyAttachmentError} from '../media/attachmentError';

const STALL_MS = 30_000;

/**
 * Why: pins the REJECTION TYPE, not just its fields. Every `.status` read below
 * only means something if the failure arrives as a MediaHttpError — a change
 * that rejected with a plain Error would drop `status`, and with it
 * `classifyAttachmentError`'s 'offline'/'gone' verdicts, while every
 * `err.message` assertion still passed. Asserting the instance makes that fail
 * loudly here, and narrows the union for the reads that follow.
 */
function expectMediaHttpError(e: unknown): asserts e is MediaHttpError {
  expect(e).toBeInstanceOf(MediaHttpError);
}

type ProgressEvent = {lengthComputable: boolean; loaded: number; total: number};

class FakeXhr {
  static instances: FakeXhr[] = [];
  static reset() { FakeXhr.instances = []; }

  method = '';
  url = '';
  requestHeaders: Record<string, string> = {};
  responseType = '';
  response: unknown = null;
  status = 0;
  aborted = 0;
  body: unknown = null;
  sent = false;
  private responseHeaders: Record<string, string> = {};

  upload: {onprogress: ((e: ProgressEvent) => void) | null} = {onprogress: null};
  onload:     (() => void) | null = null;
  onerror:    (() => void) | null = null;
  ontimeout:  (() => void) | null = null;
  onprogress: (() => void) | null = null;

  constructor() { FakeXhr.instances.push(this); }

  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(k: string, v: string) { this.requestHeaders[k] = v; }
  getResponseHeader(k: string) { return this.responseHeaders[k.toLowerCase()] ?? null; }
  /** Fake-clock reading at send() — the stall watchdog is armed alongside it. */
  sentAt = 0;
  send(body?: unknown) { this.body = body; this.sent = true; this.sentAt = Date.now(); }
  abort() { this.aborted += 1; }

  // ---- test drivers -------------------------------------------------------
  emitUploadProgress(loaded: number, total: number, lengthComputable = true) {
    this.upload.onprogress?.({lengthComputable, loaded, total});
  }
  emitDownloadProgress() { this.onprogress?.(); }
  finish(status: number, opts: {response?: unknown; headers?: Record<string, string>} = {}) {
    this.status = status;
    this.response = opts.response ?? null;
    this.responseHeaders = opts.headers ?? {};
    this.onload?.();
  }
  fail()    { this.onerror?.(); }
  timeout() { this.ontimeout?.(); }
}

const plaintext = new Uint8Array(Buffer.from('a photo worth of bytes'.repeat(8)));

/** Relay + R2 stand-in. Only the JSON endpoints ride fetch here. */
function makeFetch(opts: {objectSize?: () => number | null} = {}) {
  const calls: Array<{url: string; method: string; headers: Record<string, string>}> = [];
  const json = (b: unknown) => new Response(JSON.stringify(b), {
    status: 200, headers: {'content-type': 'application/json'},
  });
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({url, method, headers});
    if (url.endsWith('/media/upload-url')) {
      return json({uploadUrl: 'https://r2.test/put/1', objectKey: 'att/obj-1'});
    }
    if (url.includes('/media/download-url/')) {
      return json({downloadUrl: 'https://r2.test/get/1'});
    }
    if (headers.Range === 'bytes=0-0') {
      const size = opts.objectSize?.() ?? null;
      if (size === null) {return new Response('nope', {status: 403});}
      return new Response(new Uint8Array(1), {
        status: 206, headers: {'Content-Range': `bytes 0-0/${size}`},
      });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as unknown as typeof fetch;
  return {impl, calls};
}

function makeClient(fetchImpl: typeof fetch): MediaClient {
  (globalThis as {fetch: typeof fetch}).fetch = fetchImpl;
  return new MediaClient({
    baseUrl: 'https://relay.test',
    getToken: async () => 'tok',
    signalDeviceId: 1,
  });
}

/** Let queued promise jobs run without moving the fake clock. */
const settleMicrotasks = () => jest.advanceTimersByTimeAsync(0);

/** Wait until the client has constructed its XHR. */
async function nextXhr(): Promise<FakeXhr> {
  for (let i = 0; i < 100 && !FakeXhr.instances[0]?.sent; i++) {
    await jest.advanceTimersByTimeAsync(1);
  }
  const xhr = FakeXhr.instances[0];
  if (!xhr?.sent) {throw new Error('the client never sent an XMLHttpRequest');}
  return xhr;
}

/**
 * Advance the fake clock to `ms` after the request was sent — the moment the
 * stall watchdog was armed. Awaiting the XHR above consumes a few fake ms of
 * its own, so an absolute reference is the only stable way to sit one tick
 * either side of the window.
 */
const advanceToSinceSend = (xhr: FakeXhr, ms: number) =>
  jest.advanceTimersByTimeAsync(Math.max(0, xhr.sentAt + ms - Date.now()));

const realFetch = globalThis.fetch;
const realXhr = (globalThis as {XMLHttpRequest?: unknown}).XMLHttpRequest;
let warn: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  FakeXhr.reset();
  (globalThis as {XMLHttpRequest?: unknown}).XMLHttpRequest = FakeXhr;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  (globalThis as {fetch: typeof fetch}).fetch = realFetch;
  (globalThis as {XMLHttpRequest?: unknown}).XMLHttpRequest = realXhr;
  warn.mockRestore();
});

describe('upload — MX-09 progress rides XHR (fetch has none in RN)', () => {
  it('PUTs over XHR with the signed content-type, and reports fractions', async () => {
    const f = makeFetch();
    const client = makeClient(f.impl);
    const seen: number[] = [];
    const done = client.uploadEncrypted(plaintext, 'image/jpeg', v => seen.push(v));

    const xhr = await nextXhr();
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe('https://r2.test/put/1');
    expect(xhr.requestHeaders['Content-Type']).toBe('image/jpeg');
    expect(xhr.body).toBeInstanceOf(Uint8Array);
    // The PUT never went out over fetch.
    expect(f.calls.some(c => c.method === 'PUT')).toBe(false);

    xhr.emitUploadProgress(25, 100);
    xhr.emitUploadProgress(100, 100);
    xhr.finish(200);
    const res = await done;

    expect(seen).toEqual([0.25, 1]);
    expect(res.objectKey).toBe('att/obj-1');
    expect(res.size).toBe(plaintext.byteLength);
  });

  it('ignores progress events that carry no usable total', async () => {
    // A chunked upload reports lengthComputable=false; publishing 0/NaN there
    // would make the ring jump backwards.
    const f = makeFetch();
    const client = makeClient(f.impl);
    const seen: number[] = [];
    const done = client.uploadEncrypted(plaintext, 'image/jpeg', v => seen.push(v));
    const xhr = await nextXhr();
    xhr.emitUploadProgress(10, 100, false);
    xhr.emitUploadProgress(10, 0);
    xhr.finish(200);
    await done;
    expect(seen).toEqual([]);
  });

  it('the uploaded body is the CIPHERTEXT, not the plaintext', async () => {
    const f = makeFetch();
    const client = makeClient(f.impl);
    const done = client.uploadEncrypted(plaintext, 'image/jpeg', () => {});
    const xhr = await nextXhr();
    const body = Buffer.from(xhr.body as Uint8Array);
    expect(body.equals(Buffer.from(plaintext))).toBe(false);
    expect(body[0]).toBe(0x02);                 // v2 format byte
    xhr.finish(200);
    await done;
  });

  it('a non-2xx response fails with that status', async () => {
    const f = makeFetch();
    const client = makeClient(f.impl);
    const done = client.uploadEncrypted(plaintext, 'image/jpeg', () => {}).catch((e: unknown) => e);
    (await nextXhr()).finish(500);
    const err = await done;
    expectMediaHttpError(err);
    expect(err.status).toBe(500);
  });

  it('a transport error becomes status 0 → offline', async () => {
    const f = makeFetch();
    const client = makeClient(f.impl);
    const done = client.uploadEncrypted(plaintext, 'image/jpeg', () => {}).catch((e: unknown) => e);
    (await nextXhr()).fail();
    const err = await done;
    expectMediaHttpError(err);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/upload network error/);
    expect(classifyAttachmentError(err)).toBe('offline');
  });

  it('the ontimeout handler is wired (it was dead code before SN-02)', async () => {
    const f = makeFetch();
    const client = makeClient(f.impl);
    const done = client.uploadEncrypted(plaintext, 'image/jpeg', () => {}).catch((e: unknown) => e);
    (await nextXhr()).timeout();
    const err = await done;
    expectMediaHttpError(err);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/upload timeout/);
  });
});

describe('upload — SN-02 stall watchdog', () => {
  it('aborts a SILENT upload at the stall window (status 0, so retry still offers)', async () => {
    const f = makeFetch();
    const client = makeClient(f.impl);
    const done = client.uploadEncrypted(plaintext, 'image/jpeg', () => {}).catch((e: unknown) => e);
    const xhr = await nextXhr();

    await advanceToSinceSend(xhr, STALL_MS - 1);
    expect(xhr.aborted).toBe(0);                 // not yet — still inside the window
    await jest.advanceTimersByTimeAsync(2);

    const err = await done;
    expectMediaHttpError(err);
    expect(xhr.aborted).toBe(1);
    expect(err.status).toBe(0);
    expect(err.message).toBe('upload stalled');
    expect(classifyAttachmentError(err)).toBe('offline');
  });

  it('THE POINT OF SN-02: a slow-but-live upload is never aborted', async () => {
    // 100 seconds — more than three stall windows, and longer than the old
    // fixed 60s ceiling that made big attachments unsendable on slow links.
    const f = makeFetch();
    const client = makeClient(f.impl);
    const seen: number[] = [];
    const done = client.uploadEncrypted(plaintext, 'image/jpeg', v => seen.push(v));
    const xhr = await nextXhr();

    for (let i = 1; i <= 5; i++) {
      await jest.advanceTimersByTimeAsync(20_000);
      xhr.emitUploadProgress(i * 20, 100);
      expect(xhr.aborted).toBe(0);
    }
    xhr.finish(200);
    await done;
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('the watchdog is disarmed once the upload lands (no late abort, no double settle)', async () => {
    const f = makeFetch();
    const client = makeClient(f.impl);
    const done = client.uploadEncrypted(plaintext, 'image/jpeg', () => {});
    const xhr = await nextXhr();
    xhr.finish(200);
    await done;

    await jest.advanceTimersByTimeAsync(STALL_MS * 3);
    expect(xhr.aborted).toBe(0);
    // A late transport event after settling must not resurface as a rejection.
    expect(() => xhr.fail()).not.toThrow();
    await settleMicrotasks();
  });
});

describe('download — SN-02 stall watchdog on getBlob', () => {
  async function seeded() {
    const enc = await encryptAttachment(plaintext);
    return {enc, params: {objectKey: 'att/obj-1', keyB64: enc.key, ivB64: enc.iv}};
  }

  it('GETs as an arraybuffer and decrypts what comes back', async () => {
    const f = makeFetch();
    const client = makeClient(f.impl);
    const {enc, params} = await seeded();
    const done = client.downloadEncrypted(params);
    const xhr = await nextXhr();
    expect(xhr.method).toBe('GET');
    expect(xhr.responseType).toBe('arraybuffer');

    xhr.finish(200, {
      response: enc.ciphertext.buffer.slice(
        enc.ciphertext.byteOffset, enc.ciphertext.byteOffset + enc.ciphertext.byteLength),
      headers: {'content-type': 'image/jpeg'},
    });
    const out = await done;
    expect(Buffer.from(out).equals(Buffer.from(plaintext))).toBe(true);
  });

  it('a non-2xx response carries the status through to the reason class', async () => {
    const f = makeFetch();
    const client = makeClient(f.impl);
    const {params} = await seeded();
    const done = client.downloadEncrypted(params).catch((e: unknown) => e);
    (await nextXhr()).finish(404);
    const err = await done;
    expectMediaHttpError(err);
    expect(err.status).toBe(404);
    expect(classifyAttachmentError(err)).toBe('gone');
  });

  it('a transport error is offline, not a crash', async () => {
    const f = makeFetch();
    const client = makeClient(f.impl);
    const {params} = await seeded();
    const done = client.downloadEncrypted(params).catch((e: unknown) => e);
    (await nextXhr()).fail();
    const err = await done;
    expectMediaHttpError(err);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/download network error/);
  });

  it('a black-holed socket aborts at the stall window', async () => {
    const f = makeFetch();
    const client = makeClient(f.impl);
    const {params} = await seeded();
    const done = client.downloadEncrypted(params).catch((e: unknown) => e);
    const xhr = await nextXhr();
    await advanceToSinceSend(xhr, STALL_MS - 1);
    expect(xhr.aborted).toBe(0);                 // the window is 30s, not "soon"
    await jest.advanceTimersByTimeAsync(2);
    const err = await done;
    expectMediaHttpError(err);
    expect(xhr.aborted).toBe(1);
    expect(err.message).toBe('download stalled');
    expect(classifyAttachmentError(err)).toBe('offline');
  });

  it('THE POINT OF SN-02: a large blob trickling in past 60s still completes', async () => {
    // The exact case the old fixed 60s abort made permanently unreceivable.
    const f = makeFetch();
    const client = makeClient(f.impl);
    const {enc, params} = await seeded();
    const done = client.downloadEncrypted(params);
    const xhr = await nextXhr();

    for (let i = 0; i < 6; i++) {
      await jest.advanceTimersByTimeAsync(25_000);   // 150s total
      xhr.emitDownloadProgress();
      expect(xhr.aborted).toBe(0);
    }
    xhr.finish(200, {
      response: enc.ciphertext.buffer.slice(
        enc.ciphertext.byteOffset, enc.ciphertext.byteOffset + enc.ciphertext.byteLength),
      headers: {'content-type': 'image/jpeg'},
    });
    expect(Buffer.from(await done).equals(Buffer.from(plaintext))).toBe(true);
  });

  it('a download that timed out does not also abort later (settle-once)', async () => {
    const f = makeFetch();
    const client = makeClient(f.impl);
    const {params} = await seeded();
    const done = client.downloadEncrypted(params).catch((e: unknown) => e);
    const xhr = await nextXhr();
    xhr.timeout();
    const err = await done;
    expectMediaHttpError(err);
    expect(err.message).toMatch(/download timeout/);
    await jest.advanceTimersByTimeAsync(STALL_MS * 2);
    expect(xhr.aborted).toBe(0);
  });
});
