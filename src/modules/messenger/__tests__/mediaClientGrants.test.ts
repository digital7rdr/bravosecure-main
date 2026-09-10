/**
 * Audit P0-V5 / row #3 — MediaClient.registerGrants wiring.
 *
 * The server-side strict gate (MEDIA_REQUIRE_RECIPIENT_GRANT=true) was
 * already shipped; the gap was that no mobile caller ever invoked
 * /media/grants, so flipping the gate would have 403'd every recipient
 * download. The runtime now calls registerGrants pre-fanout (M2 follow-
 * up) for both 1:1 and group sends. These tests lock the client's
 * contract against regression:
 *
 *   1. empty / self-only recipient list short-circuits (no HTTP)
 *   2. populated list POSTs to /media/grants with the right shape
 *   3. server-cap of 1024 recipients is respected client-side
 *   4. duplicate recipients are deduped before sending
 */
import {MediaClient} from '../media/mediaClient';

type FetchCall = {url: string; method: string; body: unknown; headers: Record<string, string>};

function mockFetch(): {fetch: typeof fetch; calls: FetchCall[]} {
  const calls: FetchCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url:     String(input),
      method:  init?.method ?? 'GET',
      body:    init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify({ok: true, count: 0}), {
      status:  200,
      headers: {'content-type': 'application/json'},
    });
  }) as unknown as typeof fetch;
  return {fetch: fn, calls};
}

function makeClient(fetchImpl: typeof fetch): MediaClient {
  // Pin global fetch for this test — MediaClient uses the platform
  // fetch, not an injected one. Restore after each test via afterEach.
  (globalThis as {fetch: typeof fetch}).fetch = fetchImpl;
  return new MediaClient({
    baseUrl:        'https://relay.test',
    getToken:       async () => 'bearer-token-fixture',
    signalDeviceId: 1,
  });
}

describe('MediaClient.registerGrants — audit row #3', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as {fetch: typeof fetch}).fetch = realFetch;
  });

  it('short-circuits with empty recipient list — no HTTP call', async () => {
    const m = mockFetch();
    const client = makeClient(m.fetch);
    const result = await client.registerGrants('att/abc', []);
    expect(result).toEqual({ok: true, count: 0});
    expect(m.calls).toEqual([]);
  });

  it("short-circuits with self-only list ('self' is filtered out)", async () => {
    const m = mockFetch();
    const client = makeClient(m.fetch);
    const result = await client.registerGrants('att/abc', ['self']);
    expect(result).toEqual({ok: true, count: 0});
    expect(m.calls).toEqual([]);
  });

  it('short-circuits when every recipient is empty-string or self', async () => {
    const m = mockFetch();
    const client = makeClient(m.fetch);
    const result = await client.registerGrants('att/abc', ['', 'self', '']);
    expect(result).toEqual({ok: true, count: 0});
    expect(m.calls).toEqual([]);
  });

  it('POSTs to /media/grants with the right body + auth headers', async () => {
    const m = mockFetch();
    const client = makeClient(m.fetch);
    await client.registerGrants('att/00000000-0000-0000-0000-000000000001',
      ['user-alice', 'user-bob']);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].method).toBe('POST');
    expect(m.calls[0].url).toBe('https://relay.test/media/grants');
    expect(m.calls[0].body).toEqual({
      objectKey:        'att/00000000-0000-0000-0000-000000000001',
      recipientUserIds: ['user-alice', 'user-bob'],
    });
    expect(m.calls[0].headers).toMatchObject({
      Authorization:        'Bearer bearer-token-fixture',
      'X-Signal-Device-Id': '1',
      'Content-Type':       'application/json',
    });
  });

  it('dedupes duplicate recipients before sending', async () => {
    const m = mockFetch();
    const client = makeClient(m.fetch);
    await client.registerGrants('att/abc',
      ['user-alice', 'user-bob', 'user-alice', 'user-bob']);
    expect(m.calls).toHaveLength(1);
    expect((m.calls[0].body as {recipientUserIds: string[]}).recipientUserIds)
      .toEqual(['user-alice', 'user-bob']);
  });

  it('caps at 1024 recipients (matches server DTO ArrayMaxSize)', async () => {
    const m = mockFetch();
    const client = makeClient(m.fetch);
    const big = Array.from({length: 1500}, (_, i) => `user-${i}`);
    await client.registerGrants('att/abc', big);
    expect(m.calls).toHaveLength(1);
    const sent = (m.calls[0].body as {recipientUserIds: string[]}).recipientUserIds;
    expect(sent).toHaveLength(1024);
    expect(sent[0]).toBe('user-0');
    expect(sent[1023]).toBe('user-1023');
  });
});

// Media-parity M5 (2026-07-03) — a single transient grant failure used to
// permanently 403 every recipient under strict mode (the caller only
// warn'd). registerGrants now retries transient classes; genuine 4xx
// still throw immediately (retry can't fix them).
describe('MediaClient.registerGrants — retry semantics (M5)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { (globalThis as {fetch: typeof fetch}).fetch = realFetch; });

  function flakyFetch(sequence: number[]): {fetch: typeof fetch; count: () => number} {
    let i = 0;
    const fn = (async () => {
      const status = sequence[Math.min(i, sequence.length - 1)];
      i++;
      const ok = status >= 200 && status < 300;
      return new Response(JSON.stringify(ok ? {ok: true, count: 1} : {message: 'err'}), {
        status, headers: {'content-type': 'application/json'},
      });
    }) as unknown as typeof fetch;
    return {fetch: fn, count: () => i};
  }

  it('retries a 500 then succeeds', async () => {
    jest.useFakeTimers();
    try {
      const f = flakyFetch([500, 200]);
      const client = makeClient(f.fetch);
      const p = client.registerGrants('att/00000000-0000-0000-0000-000000000002', ['bob']);
      await jest.advanceTimersByTimeAsync(1500);
      const res = await p;
      expect(res).toEqual({ok: true, count: 1});
      expect(f.count()).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does NOT retry a 403 (not the object owner)', async () => {
    const f = flakyFetch([403, 200]);
    const client = makeClient(f.fetch);
    await expect(
      client.registerGrants('att/00000000-0000-0000-0000-000000000003', ['bob']),
    ).rejects.toMatchObject({status: 403});
    expect(f.count()).toBe(1); // no retry
  });

  it('gives up after 3 transient failures', async () => {
    jest.useFakeTimers();
    try {
      const f = flakyFetch([503, 503, 503]);
      const client = makeClient(f.fetch);
      const p = client.registerGrants('att/00000000-0000-0000-0000-000000000004', ['bob'])
        .catch(e => e);
      await jest.advanceTimersByTimeAsync(6000);
      const err = await p;
      expect(err).toMatchObject({status: 503});
      expect(f.count()).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });
});
