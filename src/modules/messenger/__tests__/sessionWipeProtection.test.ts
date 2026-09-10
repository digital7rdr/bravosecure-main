/**
 * Audit P0-1 — session-wipe protection against forged outer envelopes.
 *
 * Threat refresher: the outer ECIES wrap authenticates only
 * `eph_pub || recipientPub` via AAD. The inner `s: {u, d}` (sender
 * address) field is NOT bound by the outer GCM tag, so any
 * authenticated submitter can mint a wrap to any victim with an
 * attacker-chosen `senderAddress`. On receive, `unwrapOuter` succeeds
 * and the named peer is fed to `own.decrypt`, which throws
 * `DecryptError`. The legacy catch-block called `closeSession` —
 * wiping the legitimate ratchet to the named peer.
 *
 * Mitigation (this fix): refuse `closeSession` on DecryptError when
 * the peer's session has had recent legitimate activity. These tests
 * pin the policy:
 *   - A fresh peer with NO prior successful decrypts → rebuild
 *     proceeds (legacy behaviour, the legit identity-rotation case).
 *   - A peer with a recent successful decrypt → rebuild SUPPRESSED.
 *   - After the protection window elapses → rebuild proceeds again
 *     so an actual stale-session case (peer reinstalled and we've
 *     been idle for ages) still self-heals.
 */

import {
  rememberSuccessfulDecrypt,
  hasRecentSuccessfulDecrypt,
  shouldAttemptRebuild,
  markRebuildAttempt,
  attachHealthStore,
  PROTECTED_SESSION_WINDOW_MS,
  REBUILD_COOLDOWN_MS,
  _resetSessionWipeProtection,
} from '../runtime/sessionWipeProtection';
import type {PeerHealthRow} from '../store/peerSessionHealthStore';
import type {SessionAddress} from '@bravo/messenger-core';

/**
 * Lightweight in-memory stand-in for `PeerSessionHealthStore` — the
 * persistence cold-start tests need a store that exposes the synchronous
 * `get` shape `sessionWipeProtection` consults. Mirrors the real store's
 * write-through semantics.
 */
function makeMemoryHealthStore() {
  const rows = new Map<string, PeerHealthRow>();
  return {
    get: (peerKey: string): PeerHealthRow | null => rows.get(peerKey) ?? null,
    noteSuccess: async (peerKey: string, nowMs: number) => {
      const prev = rows.get(peerKey) ?? {lastSuccessMs: 0, lastRebuildAttemptMs: 0};
      if (nowMs <= prev.lastSuccessMs) {return;}
      rows.set(peerKey, {lastSuccessMs: nowMs, lastRebuildAttemptMs: prev.lastRebuildAttemptMs});
    },
    noteRebuildAttempt: async (peerKey: string, nowMs: number) => {
      const prev = rows.get(peerKey) ?? {lastSuccessMs: 0, lastRebuildAttemptMs: 0};
      rows.set(peerKey, {lastSuccessMs: prev.lastSuccessMs, lastRebuildAttemptMs: nowMs});
    },
    warm: async () => {},
    _cacheSize: () => rows.size,
    _resetCache: () => rows.clear(),
    _rows: rows,
  };
}

describe('audit P0-1 — session-wipe protection', () => {
  beforeEach(() => { _resetSessionWipeProtection(); });

  it('fresh peer (no prior successful decrypts) is NOT protected', () => {
    const peer: SessionAddress = {userId: 'alice', deviceId: 1};
    expect(hasRecentSuccessfulDecrypt(peer)).toBe(false);
  });

  it('after a successful decrypt, peer is protected', () => {
    const peer: SessionAddress = {userId: 'alice', deviceId: 1};
    rememberSuccessfulDecrypt(peer);
    expect(hasRecentSuccessfulDecrypt(peer)).toBe(true);
  });

  it('protection is per (userId, deviceId)', () => {
    const a: SessionAddress = {userId: 'alice', deviceId: 1};
    const b: SessionAddress = {userId: 'alice', deviceId: 2};
    const c: SessionAddress = {userId: 'bob',   deviceId: 1};
    rememberSuccessfulDecrypt(a);
    expect(hasRecentSuccessfulDecrypt(a)).toBe(true);
    expect(hasRecentSuccessfulDecrypt(b)).toBe(false);
    expect(hasRecentSuccessfulDecrypt(c)).toBe(false);
  });

  it('protection elapses after PROTECTED_SESSION_WINDOW_MS', () => {
    const peer: SessionAddress = {userId: 'alice', deviceId: 1};
    // Spy on Date.now directly so we don't depend on Jest's fake-timer
    // semantics across versions.
    const realNow = Date.now;
    let mockMs = 1_000_000;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => mockMs);
    try {
      rememberSuccessfulDecrypt(peer);
      expect(hasRecentSuccessfulDecrypt(peer)).toBe(true);

      // Just before the window — still protected.
      mockMs += PROTECTED_SESSION_WINDOW_MS - 1;
      expect(hasRecentSuccessfulDecrypt(peer)).toBe(true);

      // At window exactly — boundary is `<` so we should be UNPROTECTED.
      mockMs = 1_000_000 + PROTECTED_SESSION_WINDOW_MS;
      expect(hasRecentSuccessfulDecrypt(peer)).toBe(false);

      // After window — unprotected, rebuild path can run.
      mockMs = 1_000_000 + PROTECTED_SESSION_WINDOW_MS + 60_000;
      expect(hasRecentSuccessfulDecrypt(peer)).toBe(false);
    } finally {
      spy.mockRestore();
      void realNow;
    }
  });

  it('repeated successful decrypts refresh the protection window', () => {
    const peer: SessionAddress = {userId: 'alice', deviceId: 1};
    let mockMs = 1_000_000;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => mockMs);
    try {
      rememberSuccessfulDecrypt(peer);

      // Advance most of the way, then mark another successful decrypt.
      mockMs += PROTECTED_SESSION_WINDOW_MS - 1000;
      rememberSuccessfulDecrypt(peer);

      // Now skip past the original would-be expiry — still protected
      // because the second mark refreshed the timestamp.
      mockMs += 1100; // total elapsed since first mark: WINDOW + 100ms
      expect(hasRecentSuccessfulDecrypt(peer)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('default protected window matches the documented 10 minutes', () => {
    // Regression-lock: if someone shortens this without thinking about
    // the threat model, this test forces a deliberate code review.
    // Override via EXPO_PUBLIC_P01_PROTECTED_WINDOW_MS in code; the
    // default must remain 10 min for the documented tradeoff balance.
    expect(PROTECTED_SESSION_WINDOW_MS).toBe(600_000);
  });
});

describe('bug-hunt #1 — rebuild-attempt cooldown', () => {
  beforeEach(() => { _resetSessionWipeProtection(); });

  it('first call returns true (no prior attempt)', () => {
    const peer: SessionAddress = {userId: 'alice', deviceId: 1};
    expect(shouldAttemptRebuild(peer)).toBe(true);
  });

  it('stamping then re-checking blocks during the cooldown window', () => {
    const peer: SessionAddress = {userId: 'alice', deviceId: 1};
    let mockMs = 1_000_000;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => mockMs);
    try {
      markRebuildAttempt(peer);
      mockMs += REBUILD_COOLDOWN_MS - 1;
      expect(shouldAttemptRebuild(peer)).toBe(false);
      mockMs += 2;
      expect(shouldAttemptRebuild(peer)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('cooldown is per-peer', () => {
    const a: SessionAddress = {userId: 'alice', deviceId: 1};
    const b: SessionAddress = {userId: 'bob', deviceId: 1};
    markRebuildAttempt(a);
    expect(shouldAttemptRebuild(a)).toBe(false);
    expect(shouldAttemptRebuild(b)).toBe(true);
  });
});

describe('bug-hunt #1 — cold-start persistence via attached health store', () => {
  beforeEach(() => { _resetSessionWipeProtection(); });
  afterEach(() => { attachHealthStore(null); });

  it('cold start: a peer marked success BEFORE restart stays protected after restart', () => {
    // Simulate a fresh process by resetting in-process Maps, then
    // attaching a health store that already has a row (i.e. SQL had
    // been warmed from a prior session's writes).
    const store = makeMemoryHealthStore();

    attachHealthStore(store as any);
    store._rows.set('alice.1', {lastSuccessMs: Date.now() - 1000, lastRebuildAttemptMs: 0});

    const peer: SessionAddress = {userId: 'alice', deviceId: 1};
    // Cold-start: in-process Map is empty, but the SQL-backed store
    // has the row. The protection check must lazily fill from disk.
    expect(hasRecentSuccessfulDecrypt(peer)).toBe(true);
  });

  it('cold start: rebuild-cooldown row from prior session honoured', () => {
    const store = makeMemoryHealthStore();

    attachHealthStore(store as any);
    const peer: SessionAddress = {userId: 'alice', deviceId: 1};
    // Pretend a rebuild attempt landed 1s before this process started.
    store._rows.set('alice.1', {lastSuccessMs: 0, lastRebuildAttemptMs: Date.now() - 1000});
    expect(shouldAttemptRebuild(peer)).toBe(false);
  });

  it('no health store attached → falls back to in-process Map only', () => {
    const peer: SessionAddress = {userId: 'alice', deviceId: 1};
    expect(hasRecentSuccessfulDecrypt(peer)).toBe(false);
    rememberSuccessfulDecrypt(peer);
    expect(hasRecentSuccessfulDecrypt(peer)).toBe(true);
  });

  it('rememberSuccessfulDecrypt writes through to the attached store', async () => {
    const store = makeMemoryHealthStore();

    attachHealthStore(store as any);
    const peer: SessionAddress = {userId: 'alice', deviceId: 1};
    rememberSuccessfulDecrypt(peer);
    // Write is fire-and-forget — drain the microtask queue.
    await new Promise(r => setImmediate(r));
    expect(store._rows.get('alice.1')?.lastSuccessMs).toBeGreaterThan(0);
  });

  it('markRebuildAttempt writes through to the attached store', async () => {
    const store = makeMemoryHealthStore();

    attachHealthStore(store as any);
    const peer: SessionAddress = {userId: 'alice', deviceId: 1};
    markRebuildAttempt(peer);
    await new Promise(r => setImmediate(r));
    expect(store._rows.get('alice.1')?.lastRebuildAttemptMs).toBeGreaterThan(0);
  });
});

describe('bug-hunt #1 — in-process hot cache LRU bound', () => {
  beforeEach(() => { _resetSessionWipeProtection(); });

  it('caches stay bounded under many distinct peers', () => {
    // Pin the LRU cap at 1024. We add 1100 distinct peers and confirm
    // the oldest ones get evicted (the protection check returns false
    // for the first-inserted address because its entry was dropped).
    const HEAD = {userId: 'peer-0', deviceId: 1};
    rememberSuccessfulDecrypt(HEAD);
    expect(hasRecentSuccessfulDecrypt(HEAD)).toBe(true);
    for (let i = 1; i < 1100; i++) {
      rememberSuccessfulDecrypt({userId: `peer-${i}`, deviceId: 1});
    }
    // HEAD was evicted; the most-recent entries survive.
    expect(hasRecentSuccessfulDecrypt(HEAD)).toBe(false);
    expect(hasRecentSuccessfulDecrypt({userId: 'peer-1099', deviceId: 1})).toBe(true);
  });
});
