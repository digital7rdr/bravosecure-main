/**
 * TURN credential cache + pre-warm (audit Step 2.1, B-601 / B-598).
 *
 * Pins the session-wide cache: a fresh cache is a synchronous hit (no fetch);
 * single-flight collapses concurrent calls onto one fetch; the ceiling returns
 * STUN-only WITHOUT caching it (the next call retries) while the in-flight
 * fetch still warms the cache; expiry re-fetches; `invalidateIceServers`
 * fences an in-flight fetch so a signOut cannot repopulate creds.
 */
import {
  getIceServers,
  prewarmIceServers,
  invalidateIceServers,
  _resetTurnCredentialsForTest,
} from '../webrtc/turnCredentials';

// The module lazy-`require`s these; mock them (factory must be self-contained —
// jest hoists it above the imports).
// NOT {virtual:true} — these are REAL modules; a virtual mock conflicts with
// another worker file importing the real one (turnCredentials.test then saw a
// warm cache from a group-hook test that transitively loaded turnCredentials).
jest.mock('@/services/api', () => ({fetchWithRefresh: jest.fn()}));
jest.mock('@utils/constants', () => ({MSG_BASE_URL: 'https://relay.test'}));
const {fetchWithRefresh} = jest.requireMock('@/services/api') as {fetchWithRefresh: jest.Mock};

function okCreds(opts: {expiresInSec?: number; urls?: string[]} = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    ok: true,
    json: async () => ({
      urls: opts.urls ?? ['turn:relay.test:3478'],
      username: `${nowSec + (opts.expiresInSec ?? 86400)}:abc`,
      credential: 'cred',
      expiresAt: nowSec + (opts.expiresInSec ?? 86400),
    }),
  };
}

describe('turnCredentials (audit Step 2.1)', () => {
  beforeEach(() => {
    _resetTurnCredentialsForTest();
    fetchWithRefresh.mockReset();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it('a fresh cache is a HIT — no second fetch', async () => {
    fetchWithRefresh.mockResolvedValue(okCreds());
    const a = await getIceServers({ceilingMs: 6000});
    const b = await getIceServers({ceilingMs: 6000});
    expect(fetchWithRefresh).toHaveBeenCalledTimes(1);
    expect(a.some(s => s.username === undefined)).toBe(true);   // stun unshift
    expect(a.some(s => s.username === '' || (s.credential ?? '') === 'cred')).toBe(true);
    expect(b).toEqual(a);
  });

  it('sends the X-Signal-Device-Id header to the relay TURN endpoint', async () => {
    fetchWithRefresh.mockResolvedValue(okCreds());
    await getIceServers({ceilingMs: 6000});
    expect(fetchWithRefresh).toHaveBeenCalledWith(
      'https://relay.test/webrtc/turn-credentials',
      {headers: {'X-Signal-Device-Id': '1'}},
    );
  });

  it('single-flight — concurrent callers share ONE fetch', async () => {
    let release!: (v: unknown) => void;
    fetchWithRefresh.mockReturnValue(new Promise(r => { release = r; }));
    const p1 = getIceServers({ceilingMs: 6000});
    const p2 = getIceServers({ceilingMs: 6000});
    release(okCreds());
    const [a, b] = await Promise.all([p1, p2]);
    expect(fetchWithRefresh).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('ceiling → STUN-only, NOT cached; the in-flight fetch still caches for the next call', async () => {
    let release!: (v: unknown) => void;
    fetchWithRefresh.mockReturnValue(new Promise(r => { release = r; }));
    const first = await getIceServers({ceilingMs: 20});          // fetch not done → STUN
    expect(first).toEqual([{urls: 'stun:stun.l.google.com:19302'}]);
    release(okCreds());                                          // the in-flight fetch completes → caches
    await Promise.resolve(); await Promise.resolve();
    const second = await getIceServers({ceilingMs: 6000});       // now a hit, real creds
    expect(fetchWithRefresh).toHaveBeenCalledTimes(1);
    expect(second.some(s => (s.credential ?? '') === 'cred')).toBe(true);
  });

  it('a failed fetch returns STUN-only and is NOT cached (next call retries)', async () => {
    fetchWithRefresh.mockRejectedValueOnce(new Error('network'));
    const a = await getIceServers({ceilingMs: 6000});
    expect(a).toEqual([{urls: 'stun:stun.l.google.com:19302'}]);
    fetchWithRefresh.mockResolvedValueOnce(okCreds());
    const b = await getIceServers({ceilingMs: 6000});
    expect(fetchWithRefresh).toHaveBeenCalledTimes(2);
    expect(b.some(s => (s.credential ?? '') === 'cred')).toBe(true);
  });

  it('a !ok response is a failure (STUN, no cache)', async () => {
    fetchWithRefresh.mockResolvedValue({ok: false, status: 401, json: async () => ({})});
    const a = await getIceServers({ceilingMs: 6000});
    expect(a).toEqual([{urls: 'stun:stun.l.google.com:19302'}]);
  });

  it('re-fetches once the creds are within 5 min of expiry', async () => {
    fetchWithRefresh.mockResolvedValueOnce(okCreds({expiresInSec: 60}));  // expires in 60 s → inside the 5-min margin
    await getIceServers({ceilingMs: 6000});
    fetchWithRefresh.mockResolvedValueOnce(okCreds());
    await getIceServers({ceilingMs: 6000});
    expect(fetchWithRefresh).toHaveBeenCalledTimes(2);                    // not fresh enough → re-fetched
  });

  it('prewarm populates the cache so a later getIceServers is a hit', async () => {
    fetchWithRefresh.mockResolvedValue(okCreds());
    prewarmIceServers();
    await new Promise(r => setTimeout(r, 0));
    const a = await getIceServers({ceilingMs: 6000});
    expect(fetchWithRefresh).toHaveBeenCalledTimes(1);                    // prewarm did the only fetch
    expect(a.some(s => (s.credential ?? '') === 'cred')).toBe(true);
  });

  it('invalidate fences an in-flight fetch — a signOut cannot repopulate creds', async () => {
    fetchWithRefresh.mockResolvedValueOnce(okCreds());
    const p = getIceServers({ceilingMs: 5000});                  // starts the fetch (epoch 0)
    invalidateIceServers();                                      // signOut mid-fetch → epoch 1
    await p;                                                     // the fenced fetch resolves but does NOT cache
    // The next call must fetch again — the fenced result was discarded.
    fetchWithRefresh.mockResolvedValueOnce(okCreds());
    await getIceServers({ceilingMs: 5000});
    expect(fetchWithRefresh).toHaveBeenCalledTimes(2);
  });

  it('P1 — a signOut mid-fetch then a signIn NEVER serves the previous user\'s in-flight creds', async () => {
    // User A's fetch is in flight (the B-110 dead-socket window)…
    let releaseA!: (v: unknown) => void;
    fetchWithRefresh.mockReturnValueOnce(new Promise(r => { releaseA = r; }));
    const warmA = getIceServers({ceilingMs: 20});               // starts A's fetch, ceiling → STUN for A
    // …signOut (epoch bumps), then signIn as B and start B's fetch.
    invalidateIceServers();
    let releaseB!: (v: unknown) => void;
    fetchWithRefresh.mockReturnValueOnce(new Promise(r => { releaseB = r; }));
    const pB = getIceServers({ceilingMs: 5000});               // must NOT reuse A's stale-epoch inflight
    releaseA({ok: true, json: async () => ({urls: ['turn:A'], username: 'A-user', credential: 'A', expiresAt: Math.floor(Date.now() / 1000) + 86400})});
    await warmA;
    releaseB({ok: true, json: async () => ({urls: ['turn:B'], username: 'B-user', credential: 'B', expiresAt: Math.floor(Date.now() / 1000) + 86400})});
    const creds = await pB;
    expect(fetchWithRefresh).toHaveBeenCalledTimes(2);          // A and B fetched separately
    expect(creds.some(s => s.credential === 'B')).toBe(true);   // B got B's creds
    expect(creds.some(s => s.credential === 'A')).toBe(false);  // never A's
    // And A's fenced result did not poison the cache.
    const next = await getIceServers({ceilingMs: 5000});
    expect(next.some(s => s.credential === 'B')).toBe(true);
    expect(fetchWithRefresh).toHaveBeenCalledTimes(2);          // served from B's cache
  });
});
