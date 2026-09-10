import type {ConfigService} from '@nestjs/config';
import {UserPrivacyService} from './user-privacy.service';

/**
 * M-06 / M-07 — UserPrivacyService unit tests. Covers:
 *  - degrade: no Supabase config → fail open (visible / not blocked)
 *  - flag mapping: last_seen_visible=false → false; missing row → true
 *  - block mapping: row present (either direction) → true
 *  - 60s TTL cache: repeated lookups cost ONE query per key per TTL
 *  - single-flight: concurrent lookups share one in-flight query
 *  - pair-key symmetry: (a,b) and (b,a) share one cache entry
 *  - query errors fail open AND are cached (no hot-path hammering)
 *  - ids outside the UUID charset never reach the query layer
 */

interface FakeResult {data: unknown; error: {message: string} | null}

/**
 * Minimal PostgREST builder stub — just enough chain surface for the two
 * queries the service issues (`select→eq→maybeSingle` on users and
 * `select→or→limit` on blocked_users). Every terminal call resolves via
 * `next()` so tests can count and defer queries.
 */
function fakeSupabase(next: (table: string) => Promise<FakeResult>) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      from(table: string) {
        const terminal = () => {
          calls.push(table);
          return next(table);
        };
        const builder = {
          select: () => builder,
          eq:     () => builder,
          or:     () => builder,
          limit:  terminal,
          maybeSingle: terminal,
        };
        return builder;
      },
    },
  };
}

function degradedConfig(): ConfigService {
  return {get: () => undefined} as unknown as ConfigService;
}

/** Build a service in degraded mode, then inject the fake client. */
function serviceWith(next: (table: string) => Promise<FakeResult>) {
  const svc = new UserPrivacyService(degradedConfig());
  const fake = fakeSupabase(next);
  (svc as unknown as {client: unknown}).client = fake.client;
  return {svc, calls: fake.calls};
}

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

describe('UserPrivacyService (M-06 / M-07)', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('degrade behavior', () => {
    it('fails open when Supabase config is missing', async () => {
      const svc = new UserPrivacyService(degradedConfig());
      expect(await svc.isLastSeenVisible(A)).toBe(true);
      expect(await svc.isBlockedEither(A, B)).toBe(false);
    });

    it('fails open and caches the default when a query errors', async () => {
      const {svc, calls} = serviceWith(async () => ({data: null, error: {message: 'boom'}}));
      expect(await svc.isLastSeenVisible(A)).toBe(true);
      expect(await svc.isBlockedEither(A, B)).toBe(false);
      // Cached — the failing query is NOT retried within the TTL.
      expect(await svc.isLastSeenVisible(A)).toBe(true);
      expect(await svc.isBlockedEither(A, B)).toBe(false);
      expect(calls).toHaveLength(2);
    });

    it('never queries for ids outside the UUID charset (filter-injection guard)', async () => {
      const {svc, calls} = serviceWith(async () => ({data: [], error: null}));
      expect(await svc.isLastSeenVisible('x,or(1.eq.1)')).toBe(true);
      expect(await svc.isBlockedEither(A, 'b),or(1.eq.1')).toBe(false);
      expect(calls).toHaveLength(0);
    });
  });

  describe('flag mapping', () => {
    it('last_seen_visible=false → hidden; true/missing row → visible', async () => {
      let row: unknown = {last_seen_visible: false};
      const {svc} = serviceWith(async () => ({data: row, error: null}));
      expect(await svc.isLastSeenVisible(A)).toBe(false);
      row = {last_seen_visible: true};
      expect(await svc.isLastSeenVisible(B)).toBe(true);
      row = null; // unknown user — default visible, matches auth-service
      expect(await svc.isLastSeenVisible('33333333-3333-3333-3333-333333333333')).toBe(true);
    });

    it('block row present → blocked; empty → not blocked', async () => {
      let rows: unknown[] = [{blocker_user_id: A}];
      const {svc} = serviceWith(async () => ({data: rows, error: null}));
      expect(await svc.isBlockedEither(A, B)).toBe(true);
      rows = [];
      expect(await svc.isBlockedEither(A, '33333333-3333-3333-3333-333333333333')).toBe(false);
    });
  });

  describe('cache + single-flight (hot-path guarantees)', () => {
    it('repeated sequential lookups hit the DB once per TTL', async () => {
      const {svc, calls} = serviceWith(async () => ({data: {last_seen_visible: true}, error: null}));
      await svc.isLastSeenVisible(A);
      await svc.isLastSeenVisible(A);
      await svc.isLastSeenVisible(A);
      expect(calls).toHaveLength(1);
    });

    it('expires after the 60s TTL and re-fetches', async () => {
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      const {svc, calls} = serviceWith(async () => ({data: {last_seen_visible: true}, error: null}));
      await svc.isLastSeenVisible(A);
      now += 59_000;
      await svc.isLastSeenVisible(A);
      expect(calls).toHaveLength(1);   // still fresh
      now += 2_000;                    // 61s total — past TTL
      await svc.isLastSeenVisible(A);
      expect(calls).toHaveLength(2);
    });

    it('concurrent lookups share ONE in-flight query (single-flight)', async () => {
      let release!: (r: FakeResult) => void;
      const gate = new Promise<FakeResult>(res => { release = res; });
      const {svc, calls} = serviceWith(() => gate);
      const p1 = svc.isBlockedEither(A, B);
      const p2 = svc.isBlockedEither(A, B);
      const p3 = svc.isBlockedEither(B, A); // pair key is order-insensitive
      release({data: [{blocker_user_id: A}], error: null});
      expect(await Promise.all([p1, p2, p3])).toEqual([true, true, true]);
      expect(calls).toHaveLength(1);
    });

    it('caches per user — different subjects query independently', async () => {
      const {svc, calls} = serviceWith(async () => ({data: null, error: null}));
      await svc.isLastSeenVisible(A);
      await svc.isLastSeenVisible(B);
      expect(calls).toHaveLength(2);
    });
  });

  // B-597 (audit Step 1) — the DEADLINE-bounded call-lane gate falls back to
  // this on a slow lookup, so it MUST return the last verdict even after the
  // 60 s TTL (a stale "blocked" keeps a blocked pair blocked); it may only be
  // `undefined` for a pair this process has never seen. A one-token revert to
  // the `expiresAt > Date.now()` form used in `cached()` would silently turn
  // B-597 back into plain fail-open — pin it against the REAL implementation.
  describe('peekBlockedEither (B-597 stale fallback)', () => {
    it('returns the last verdict EVEN AFTER the TTL has expired (a stale block stays blocked)', async () => {
      let now = 5_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      const {svc} = serviceWith(async () => ({data: [{blocker_user_id: A}], error: null}));
      expect(await svc.isBlockedEither(A, B)).toBe(true);   // warms the cache
      now += 10 * 60_000;                                   // 10 min — well past the 60 s TTL
      expect(svc.peekBlockedEither(A, B)).toBe(true);       // still remembered
      expect(svc.peekBlockedEither(B, A)).toBe(true);       // order-insensitive
    });

    it('remembers a NOT-blocked verdict too (false, not undefined)', async () => {
      const {svc} = serviceWith(async () => ({data: [], error: null}));
      expect(await svc.isBlockedEither(A, B)).toBe(false);
      expect(svc.peekBlockedEither(A, B)).toBe(false);
    });

    it('is undefined for a pair never checked, and when Supabase is not configured', () => {
      const {svc} = serviceWith(async () => ({data: [], error: null}));
      expect(svc.peekBlockedEither(A, B)).toBeUndefined();  // never checked
      const disabled = new UserPrivacyService(degradedConfig());
      expect(disabled.peekBlockedEither(A, B)).toBeUndefined(); // client null
    });
  });
});
