/**
 * MEDIA-31 — upload-truncation verification must actually verify.
 *
 * The old probe issued a HEAD against the GET-presigned URL; SigV4
 * signs the method, so real S3/R2 answered 403 → null → every upload
 * was silently accepted. The probe is now a ranged GET
 * (Range: bytes=0-0) against the same URL — the signature stays valid —
 * and the total object size comes from Content-Range ("bytes 0-0/TOTAL").
 *
 * These tests lock the contract:
 *   1. probe = ranged GET (never HEAD); matching total → single PUT
 *   2. mismatched total → existing retry-once path (fresh URL + re-PUT)
 *   3. second mismatch → honest failure ("truncated twice")
 *   4. non-2xx probe (403) → null → accept without retry
 *   5. range ignored (200, no Content-Range) → null → accept
 */
import {MediaClient} from '../media/mediaClient';

type Call = {url: string; method: string; headers: Record<string, string>};
type ProbePlan = 'match' | 'short' | 'forbidden' | 'no-range';

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status:  200,
    headers: {'content-type': 'application/json'},
  });
}

function makeHarness(probePlan: ProbePlan[]) {
  const calls: Call[] = [];
  const putLens: number[] = [];
  let probeIdx = 0;
  let urlSeq = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({url, method, headers: (init?.headers ?? {}) as Record<string, string>});
    if (url.endsWith('/media/upload-url')) {
      urlSeq++;
      return jsonRes({uploadUrl: `https://r2.test/put-${urlSeq}`, objectKey: `att/key-${urlSeq}`});
    }
    if (method === 'PUT') {
      putLens.push((init?.body as Uint8Array).byteLength);
      return new Response(null, {status: 200});
    }
    if (url.includes('/media/download-url/')) {
      return jsonRes({downloadUrl: `https://r2.test/get-${urlSeq}`});
    }
    // Ranged length probe against the presigned GET URL.
    const plan = probePlan[Math.min(probeIdx, probePlan.length - 1)];
    probeIdx++;
    const total = putLens[putLens.length - 1];
    if (plan === 'forbidden') {
      return new Response('denied', {status: 403});
    }
    if (plan === 'no-range') {
      // Server ignored the Range header — 200 full body, no Content-Range.
      return new Response(new Uint8Array(total), {status: 200});
    }
    const reported = plan === 'match' ? total : total - 7;
    return new Response(new Uint8Array(1), {
      status:  206,
      headers: {'Content-Range': `bytes 0-0/${reported}`},
    });
  }) as unknown as typeof fetch;
  return {fetchImpl, calls, probeCount: () => probeIdx};
}

function makeClient(fetchImpl: typeof fetch): MediaClient {
  (globalThis as {fetch: typeof fetch}).fetch = fetchImpl;
  return new MediaClient({
    baseUrl:        'https://relay.test',
    getToken:       async () => 'bearer-token-fixture',
    signalDeviceId: 1,
  });
}

describe('MediaClient upload length probe — MEDIA-31 ranged GET', () => {
  const realFetch = globalThis.fetch;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    (globalThis as {fetch: typeof fetch}).fetch = realFetch;
    warnSpy.mockRestore();
  });

  const plaintext = new Uint8Array(100).fill(7);

  it('probes with a ranged GET (never HEAD) and accepts on a matching total', async () => {
    const h = makeHarness(['match']);
    const client = makeClient(h.fetchImpl);
    const res = await client.uploadEncrypted(plaintext, 'image/jpeg');
    expect(res.objectKey).toBe('att/key-1');
    expect(res.size).toBe(100);
    expect(h.calls.filter(c => c.method === 'PUT')).toHaveLength(1);
    expect(h.calls.some(c => c.method === 'HEAD')).toBe(false);
    const probe = h.calls.find(c => c.url.startsWith('https://r2.test/get-'));
    expect(probe).toBeDefined();
    expect(probe!.method).toBe('GET');
    expect(probe!.headers.Range).toBe('bytes=0-0');
  });

  it('mismatched Content-Range total triggers exactly one retry PUT, then succeeds', async () => {
    const h = makeHarness(['short', 'match']);
    const client = makeClient(h.fetchImpl);
    const res = await client.uploadEncrypted(plaintext, 'image/jpeg');
    // The retry re-requests a fresh URL — result carries the SECOND key.
    expect(res.objectKey).toBe('att/key-2');
    expect(h.calls.filter(c => c.method === 'PUT')).toHaveLength(2);
    expect(h.probeCount()).toBe(2);
  });

  it('fails honestly when the retry is also truncated', async () => {
    const h = makeHarness(['short', 'short']);
    const client = makeClient(h.fetchImpl);
    await expect(client.uploadEncrypted(plaintext, 'image/jpeg'))
      .rejects.toThrow(/truncated twice/);
    expect(h.calls.filter(c => c.method === 'PUT')).toHaveLength(2);
    expect(h.probeCount()).toBe(2);
  });

  it('non-2xx probe (403) means "cannot verify" — accept without retry', async () => {
    const h = makeHarness(['forbidden']);
    const client = makeClient(h.fetchImpl);
    const res = await client.uploadEncrypted(plaintext, 'image/jpeg');
    expect(res.objectKey).toBe('att/key-1');
    expect(h.calls.filter(c => c.method === 'PUT')).toHaveLength(1);
    expect(h.probeCount()).toBe(1);
  });

  it('range-ignoring server (200, no Content-Range) — accept without retry', async () => {
    const h = makeHarness(['no-range']);
    const client = makeClient(h.fetchImpl);
    const res = await client.uploadEncrypted(plaintext, 'image/jpeg');
    expect(res.objectKey).toBe('att/key-1');
    expect(h.calls.filter(c => c.method === 'PUT')).toHaveLength(1);
  });
});
