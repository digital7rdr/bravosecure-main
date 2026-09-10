/**
 * AUDIT-2026-08-13 #5 — the peer-identity cache must be evicted with the SAME
 * composite key it is written under, and only server-authoritative identities
 * may enter it.
 *
 * The cache is ONE Map shared by the send path (`recipientIdentityKeyB64Cached`,
 * the outer-ECIES wrap target) and the receive path
 * (`resolveExpectedSenderIdentity`). Two recovery sites — B-46's
 * `resendUndeliverable` and B-122's freshSession retry — existed precisely to
 * discard the DEAD identity a failed wrap was built from, but evicted with a
 * bare userId: a key no writer ever produces, so the delete was a silent no-op
 * and both auto-resend and the manual retry re-wrapped to the dead identity
 * for up to the full 8-minute TTL after a peer reinstall.
 *
 * The fix (critic + edge-case reviewed) has three legs, each pinned here:
 *   1. ONE key formula — `peerIdentityCacheKey` — used by every read, write
 *      and delete of the Map. Covered lanes: both cache writers, the shared
 *      recovery closure (B-46 + B-122), and the rotation-recovery deletes on
 *      both receive paths. (`resetSessionWith` rebuilds a session without
 *      touching this cache — pre-existing, self-heals via B-46, logged as a
 *      follow-up in the audit doc.)
 *   2. Server-only writes — a local-trust-row fallback is served to the caller
 *      but NEVER cached: during rotation recovery the trust row still holds
 *      the dead key until `forceRefreshOutgoingSession` overwrites it, and a
 *      concurrent send lane caching that fallback would undo the eviction
 *      mid-recovery (the edge reviewer's race).
 *   3. Recovery shape — evict BEFORE the session refresh, re-seed AFTER it
 *      from the same authority-verified bundle (closes the redundant second
 *      destructive OPK pop the critic flagged, and overwrites any value a
 *      concurrent lane wrote mid-window).
 *
 * Parts A/B run the REAL shared module. Part C is a source scan over the
 * runtime files (which no test can import — see queuedSendBubbleState.test.ts)
 * with the scan itself mutation-validated: it catches a bare-userId delete
 * even when prettier wraps the call across lines, and it does NOT false-fail
 * on a re-wrapped correct site.
 */

import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {
  peerIdentityCacheKey,
  recipientIdentityKeyB64,
  recipientIdentityKeyB64Cached,
  clearNegativeFetchCooldown,
  PEER_IDENTITY_TTL_MS,
  NEGATIVE_FETCH_COOLDOWN_MS,
  type PeerIdentityCache,
} from '../crypto/peerIdentityCache';
import {resolveExpectedSenderIdentity} from '../crypto/expectedSenderIdentity';
import {toBase64, type CryptoStore, type KeysHttpClient, type SessionAddress} from '@bravo/messenger-core';

// ---------------------------------------------------------------- fixtures

function keyBytes(seed: number): ArrayBuffer {
  const u8 = new Uint8Array(32).fill(seed);
  return u8.buffer;
}
const DEAD_B64  = toBase64(keyBytes(1));
const FRESH_B64 = toBase64(keyBytes(2));

/** Store whose trust row can be present (returns `rowKey`) or absent. */
function makeStore(rows: Record<string, ArrayBuffer> = {}): CryptoStore {
  return {
    async loadIdentityKey(addr: string) { return rows[addr]; },
  } as unknown as CryptoStore;
}

/** Keys client that counts destructive bundle fetches; can succeed or throw. */
function makeKeys(behaviour: {identityKeyB64?: string; throw?: Error}): {keys: KeysHttpClient; fetches: () => number} {
  let fetches = 0;
  const keys = {
    async fetchPeerBundleWithPoolSize() {
      fetches++;
      if (behaviour.throw) {throw behaviour.throw;}
      return {
        bundle: {
          registrationId: 1,
          address:        {userId: 'peer', deviceId: 1},
          identityKey:    behaviour.identityKeyB64 ?? FRESH_B64,
          signedPreKey:   {keyId: 1, publicKey: 'x', signature: 'y'},
        },
        poolSize: 50,
      };
    },
  } as unknown as KeysHttpClient;
  return {keys, fetches: () => fetches};
}

const alice1: SessionAddress = {userId: 'alice', deviceId: 1};

// ------------------------------------------------- Part A: the key formula

describe('AUDIT #5 part A — peerIdentityCacheKey is THE formula', () => {
  it('produces `${userId}.${deviceId}`', () => {
    expect(peerIdentityCacheKey(alice1)).toBe('alice.1');
    expect(peerIdentityCacheKey({userId: 'bob', deviceId: 3})).toBe('bob.3');
  });

  it('is device-scoped — sibling devices never collide', () => {
    expect(peerIdentityCacheKey({userId: 'alice', deviceId: 1}))
      .not.toBe(peerIdentityCacheKey({userId: 'alice', deviceId: 2}));
  });

  it('never equals the bare userId (the AUDIT #5 defect shape)', () => {
    expect(peerIdentityCacheKey(alice1)).not.toBe(alice1.userId);
  });
});

// ------------------------------------- Part B: writer + eviction contract

describe('AUDIT #5 part B — cache write/evict contract (real module)', () => {
  it('send-path writer stores under the composite key, never the bare userId', async () => {
    const cache: PeerIdentityCache = new Map();
    const {keys} = makeKeys({identityKeyB64: FRESH_B64});
    await recipientIdentityKeyB64Cached(makeStore(), keys, alice1, cache);
    expect([...cache.keys()]).toEqual(['alice.1']);
    expect(cache.has('alice')).toBe(false);
  });

  it('receive-path writer uses the SAME key — the two paths share entries', async () => {
    const cache: PeerIdentityCache = new Map();
    const {keys} = makeKeys({identityKeyB64: FRESH_B64});
    await resolveExpectedSenderIdentity(alice1, makeStore(), keys, cache);
    expect([...cache.keys()]).toEqual(['alice.1']);

    // A send-path read now HITS the receive path's entry: zero extra fetches.
    const second = makeKeys({identityKeyB64: DEAD_B64});
    const served = await recipientIdentityKeyB64Cached(makeStore(), second.keys, alice1, cache);
    expect(served).toBe(FRESH_B64);
    expect(second.fetches()).toBe(0);
  });

  it('a bare-userId delete does NOT evict (the original no-op, pinned forever)', async () => {
    const cache: PeerIdentityCache = new Map();
    const {keys} = makeKeys({identityKeyB64: DEAD_B64});
    await recipientIdentityKeyB64Cached(makeStore(), keys, alice1, cache);

    cache.delete(alice1.userId); // what the buggy sites did
    expect(cache.size).toBe(1);  // entry survives → dead identity still served

    const fresh = makeKeys({identityKeyB64: FRESH_B64});
    const served = await recipientIdentityKeyB64Cached(makeStore(), fresh.keys, alice1, cache);
    expect(served).toBe(DEAD_B64);
    expect(fresh.fetches()).toBe(0);
  });

  it('the composite delete evicts, and the next resolve re-fetches the CURRENT identity', async () => {
    const cache: PeerIdentityCache = new Map();
    const {keys} = makeKeys({identityKeyB64: DEAD_B64});
    await recipientIdentityKeyB64Cached(makeStore(), keys, alice1, cache);

    cache.delete(peerIdentityCacheKey(alice1)); // what the fixed sites do
    expect(cache.size).toBe(0);

    const fresh = makeKeys({identityKeyB64: FRESH_B64});
    const served = await recipientIdentityKeyB64Cached(makeStore(), fresh.keys, alice1, cache);
    expect(served).toBe(FRESH_B64);
    expect(fresh.fetches()).toBe(1);
  });

  it('eviction is device-scoped — a sibling device entry is untouched', async () => {
    // Multi-device fan-out (CRIT-7) sends to deviceId != 1; a user-wide sweep
    // would re-pop OPKs for healthy siblings on every recovery.
    const cache: PeerIdentityCache = new Map();
    cache.set(peerIdentityCacheKey({userId: 'alice', deviceId: 1}), {idKey: DEAD_B64, fetchedAt: Date.now()});
    cache.set(peerIdentityCacheKey({userId: 'alice', deviceId: 2}), {idKey: FRESH_B64, fetchedAt: Date.now()});
    cache.delete(peerIdentityCacheKey({userId: 'alice', deviceId: 1}));
    expect([...cache.keys()]).toEqual(['alice.2']);
  });

  it('SERVER-ONLY WRITES: a local-trust-row fallback is served but NEVER cached', async () => {
    // The edge reviewer's race: mid-recovery the trust row still holds the
    // DEAD key. A concurrent send lane whose bundle fetch fails (429/timeout)
    // falls back to that row — if it CACHED the fallback, the recovery's
    // eviction would be undone for a full TTL and the resend would re-wrap
    // to the dead identity anyway (burning B-46's one-attempt budget).
    const cache: PeerIdentityCache = new Map();
    const store = makeStore({'alice.1': keyBytes(1)}); // trust row = DEAD
    const {keys} = makeKeys({throw: new Error('429 too many requests')});

    const served = await recipientIdentityKeyB64Cached(store, keys, alice1, cache);
    expect(served).toBe(DEAD_B64);   // caller still gets an answer (availability)
    expect(cache.size).toBe(0);      // ...but the shared cache stays clean

    // Once the cooldown lapses, the next resolve adopts the CURRENT identity —
    // the fallback never gained cache tenure.
    const t = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(t + NEGATIVE_FETCH_COOLDOWN_MS + 1);
    try {
      const fresh = makeKeys({identityKeyB64: FRESH_B64});
      const next = await recipientIdentityKeyB64Cached(store, fresh.keys, alice1, cache);
      expect(next).toBe(FRESH_B64);
      expect(fresh.fetches()).toBe(1);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('COOLDOWN: a failed fetch is not re-probed within the hold — trust row served, zero extra fetches', async () => {
    // Critic M2 — the fallback is deliberately un-cached, so without a
    // cooldown a slow/rate-limiting keys-service would eat one 20s transport
    // timeout PER QUEUED SEND (the serial outbox drain has a 30s budget:
    // ~1 row per sweep). The cooldown serves the trust row for a short hold
    // instead — the same value the pre-#5 code cached for 8 minutes, so the
    // staleness window strictly shrank while the Map stays fallback-free.
    const cache: PeerIdentityCache = new Map();
    const store = makeStore({'alice.1': keyBytes(1)});
    const {keys, fetches} = makeKeys({throw: new Error('timeout')});

    await recipientIdentityKeyB64Cached(store, keys, alice1, cache);  // arms
    const second = await recipientIdentityKeyB64Cached(store, keys, alice1, cache);
    const third  = await recipientIdentityKeyB64Cached(store, keys, alice1, cache);
    expect(second).toBe(DEAD_B64);
    expect(third).toBe(DEAD_B64);
    expect(fetches()).toBe(1);      // one probe armed the hold; the rest skip
    expect(cache.size).toBe(0);     // still nothing cached during the hold
  });

  it('COOLDOWN: never starves a first contact — no trust row falls through to the fetch', async () => {
    const cache: PeerIdentityCache = new Map();
    const store = makeStore();      // no trust row at all
    const {keys, fetches} = makeKeys({throw: new Error('ECONNRESET')});

    await expect(recipientIdentityKeyB64Cached(store, keys, alice1, cache)).rejects.toThrow();
    await expect(recipientIdentityKeyB64Cached(store, keys, alice1, cache)).rejects.toThrow();
    expect(fetches()).toBe(2);      // hold armed, but with no row it re-probes
  });

  it('COOLDOWN vs CACHE ORDER: a live cache entry beats an armed hold (critic MF1)', async () => {
    // The cache-hit check MUST run before the cooldown check. Real-world
    // state this pins: hold armed at t0 (fetch failed, trust row = K_old),
    // then the recovery closure seeds K_new into the cache. The wrapper must
    // serve the seeded K_new — a swapped order serves the STALE trust row for
    // the rest of the hold, which is the audit-#5 failure shape resurrected.
    const cache: PeerIdentityCache = new Map();
    const store = makeStore({'alice.1': keyBytes(1)});          // row = DEAD
    await recipientIdentityKeyB64Cached(store, makeKeys({throw: new Error('503')}).keys, alice1, cache); // arms hold
    cache.set(peerIdentityCacheKey(alice1), {idKey: FRESH_B64, fetchedAt: Date.now()}); // closure's seed

    const counting = makeKeys({identityKeyB64: DEAD_B64});
    const served = await recipientIdentityKeyB64Cached(store, counting.keys, alice1, cache);
    expect(served).toBe(FRESH_B64);       // cache wins over the held-back row
    expect(counting.fetches()).toBe(0);
  });

  it('COOLDOWN BOUNDS: the hold is a fraction of the TTL, never a second staleness regime (critic MF2)', () => {
    // The module's whole safety argument is COOLDOWN << TTL — a hold serves
    // the trust row for AT MOST this long. Widening the constant toward the
    // TTL silently restores the 8-minute stale-wrap window finding #5 killed;
    // every other cooldown test moves time relative to the constant and would
    // stay green. Pin the relation AND an absolute ceiling.
    expect(NEGATIVE_FETCH_COOLDOWN_MS).toBeLessThan(PEER_IDENTITY_TTL_MS);
    expect(NEGATIVE_FETCH_COOLDOWN_MS).toBeLessThanOrEqual(60_000);
  });

  it('COOLDOWN: the hold is device-scoped — a device-1 hold never suppresses device-2 fetches', async () => {
    const cache: PeerIdentityCache = new Map();
    const store = makeStore({'alice.1': keyBytes(1), 'alice.2': keyBytes(1)});
    await recipientIdentityKeyB64Cached(store, makeKeys({throw: new Error('503')}).keys, alice1, cache); // arms alice.1

    const d2 = makeKeys({identityKeyB64: FRESH_B64});
    const served = await recipientIdentityKeyB64Cached(store, d2.keys, {userId: 'alice', deviceId: 2}, cache);
    expect(served).toBe(FRESH_B64);
    expect(d2.fetches()).toBe(1);         // sibling device probes normally
  });

  it('clearNegativeFetchCooldown drops the hold so the next miss probes immediately', async () => {
    // The recovery closure calls this after its own authoritative fetch
    // succeeded — keeping the hold would only delay the next legitimate probe
    // and stretch the doHandleIncoming residual (delete not refresh-gated).
    const cache: PeerIdentityCache = new Map();
    const store = makeStore({'alice.1': keyBytes(1)});
    await recipientIdentityKeyB64Cached(store, makeKeys({throw: new Error('503')}).keys, alice1, cache); // arms hold

    clearNegativeFetchCooldown(cache, alice1);

    const counting = makeKeys({identityKeyB64: FRESH_B64});
    const served = await recipientIdentityKeyB64Cached(store, counting.keys, alice1, cache);
    expect(served).toBe(FRESH_B64);
    expect(counting.fetches()).toBe(1);   // hold gone → immediate re-probe
  });

  it('COOLDOWN: a successful fetch clears the hold and later evictions re-fetch immediately', async () => {
    const cache: PeerIdentityCache = new Map();
    const store = makeStore({'alice.1': keyBytes(1)});

    await recipientIdentityKeyB64Cached(store, makeKeys({throw: new Error('503')}).keys, alice1, cache);
    const t = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(t + NEGATIVE_FETCH_COOLDOWN_MS + 1);
    try {
      const ok = makeKeys({identityKeyB64: FRESH_B64});
      expect(await recipientIdentityKeyB64Cached(store, ok.keys, alice1, cache)).toBe(FRESH_B64);
      expect(ok.fetches()).toBe(1);

      // Recovery-style eviction, evaluated back INSIDE the original hold
      // window (t+2s): only a genuinely CLEARED hold lets the authoritative
      // re-fetch through — an uncleared one would serve the stale trust row
      // here and this assertion would catch it.
      spy.mockReturnValue(t + 2_000);
      cache.delete(peerIdentityCacheKey(alice1));
      const again = makeKeys({identityKeyB64: FRESH_B64});
      expect(await recipientIdentityKeyB64Cached(store, again.keys, alice1, cache)).toBe(FRESH_B64);
      expect(again.fetches()).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('bare resolver reports which branch produced the key', async () => {
    const okKeys = makeKeys({identityKeyB64: FRESH_B64});
    await expect(recipientIdentityKeyB64(makeStore(), okKeys.keys, alice1))
      .resolves.toEqual({idKey: FRESH_B64, fromServer: true});

    const downKeys = makeKeys({throw: new Error('ECONNRESET')});
    await expect(recipientIdentityKeyB64(makeStore({'alice.1': keyBytes(1)}), downKeys.keys, alice1))
      .resolves.toEqual({idKey: DEAD_B64, fromServer: false});

    const noRow = makeKeys({throw: new Error('ECONNRESET')});
    await expect(recipientIdentityKeyB64(makeStore(), noRow.keys, alice1))
      .rejects.toThrow('peer identity unavailable');
  });

  it('an expired entry is refetched; a live one is served (TTL boundary)', async () => {
    const cache: PeerIdentityCache = new Map();
    cache.set('alice.1', {idKey: DEAD_B64, fetchedAt: Date.now() - PEER_IDENTITY_TTL_MS - 1});
    const {keys, fetches} = makeKeys({identityKeyB64: FRESH_B64});
    const served = await recipientIdentityKeyB64Cached(makeStore(), keys, alice1, cache);
    expect(served).toBe(FRESH_B64);
    expect(fetches()).toBe(1);

    const again = await recipientIdentityKeyB64Cached(makeStore(), keys, alice1, cache);
    expect(again).toBe(FRESH_B64);
    expect(fetches()).toBe(1); // fresh write served from cache
  });
});

// ------------------------------------------------ Part C: the source scan

describe('AUDIT #5 part C — runtime sites use the helper (source scan)', () => {
  // productionRuntime.ts cannot be imported under jest, so its call sites are
  // pinned statically. These files are CRLF: split on /\r?\n/ or the suite
  // passes vacuously (CLAUDE.md). Comment handling is line-based ONLY — the
  // house regex stripper eats real code when `/*` appears inside a string.
  // After dropping comment lines the text is JOINED and whitespace-collapsed
  // so a call wrapped across lines by prettier cannot hide from the scan
  // (mutation-validated: an added multi-line bare-userId delete FAILS here).
  const RUNTIME_DIR = join(__dirname, '..', 'runtime');
  const CRYPTO_DIR  = join(__dirname, '..', 'crypto');
  const FILES = [RUNTIME_DIR, CRYPTO_DIR].flatMap(dir =>
    readdirSync(dir)
      .filter(f => f.endsWith('.ts') && statSync(join(dir, f)).isFile())
      .map(f => join(dir, f)),
  );

  function codeText(path: string): string {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(l => {
        const t = l.trim();
        return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join(' ')
      .replace(/\s+/g, ' ');
  }

  const OP = /peerIdentityCache\??\.(delete|set)\(\s*([^),]*?)\s*[,)]/g;

  const sites = FILES.flatMap(path =>
    [...codeText(path).matchAll(OP)].map(m => ({
      file: path.split(/[\\/]/).pop() as string,
      op:   m[1],
      arg:  m[2].trim(),
    })),
  );

  it('found the sites at all (anti-vacuous guard)', () => {
    // 4 deletes + 1 set in productionRuntime (the two recovery lanes share
    // ONE closure), 1 delete in senderCertAdmit — 6 at the time of the fix.
    // A drop below 6 means the scan stopped matching — re-anchor it before
    // touching this number.
    expect(sites.length).toBeGreaterThanOrEqual(6);
    expect(new Set(sites.map(s => s.file))).toContain('senderCertAdmit.ts');
    expect(sites.filter(s => s.op === 'set').length).toBeGreaterThanOrEqual(1);
  });

  it('EVERY delete/set keys the map via peerIdentityCacheKey(...) — never an inline template or bare userId', () => {
    const bad = sites.filter(s => !/^peerIdentityCacheKey\(/.test(s.arg));
    expect(bad.map(s => `${s.file}: .${s.op}(${s.arg})`)).toEqual([]);
  });

  it('the recovery closure evicts BEFORE the refresh, re-seeds AFTER it, then drops the hold', () => {
    const src = codeText(join(RUNTIME_DIR, 'productionRuntime.ts'));
    // delete → await forceRefreshOutgoingSession → set({idKey, fetchedAt}) → clear hold
    expect(src).toMatch(
      /peerIdentityCache\.delete\(peerIdentityCacheKey\(peer\)\); const idKey = await forceRefreshOutgoingSession\(own, keys, peer, ownStore\); peerIdentityCache\.set\(peerIdentityCacheKey\(peer\), \{idKey, fetchedAt: Date\.now\(\)\}\); clearNegativeFetchCooldown\(peerIdentityCache, peer\);/,
    );
    // ...and forceRefreshOutgoingSession actually returns the bundle identity.
    expect(src).toMatch(/async function forceRefreshOutgoingSession[\s\S]{0,1500}?return bundle\.identityKey; \}/);
  });

  it('the hold-clearing mutator has exactly ONE runtime call site (the closure)', () => {
    // clearNegativeFetchCooldown weakens the storm guard if sprinkled around;
    // its only legitimate production caller is the recovery closure, whose
    // ordering is pinned above. A second call site must arrive deliberately —
    // grow this count with a reason, not by accident. (The import line has no
    // paren, so it does not match.)
    const src = codeText(join(RUNTIME_DIR, 'productionRuntime.ts'));
    expect(src.match(/clearNegativeFetchCooldown\(/g)).toHaveLength(1);
  });

  it('both recovery lanes route through the shared closure (B-46 + B-122)', () => {
    // Any-identifier capture: a third lane calling the closure with some other
    // peer variable must surface HERE (grow this list deliberately), not slip
    // past a (peer|target)-only pattern.
    const src = codeText(join(RUNTIME_DIR, 'productionRuntime.ts'));
    const calls = src.match(/await refreshPeerIdentityAndSession\([A-Za-z_$][\w$]*\);/g) ?? [];
    expect(calls.sort()).toEqual([
      'await refreshPeerIdentityAndSession(peer);',
      'await refreshPeerIdentityAndSession(target);',
    ]);
  });

  it('the literal defect shape stays dead in every scanned file', () => {
    // Belt over the per-site check above: a `.delete(x.userId)` call on any
    // *peerIdentityCache-named* binding (incl. `deps.peerIdentityCache`) must
    // never reappear. KNOWN LIMIT, on purpose: re-aliasing the Map into a
    // differently-named binding escapes this scan — that is what the per-site
    // check + the module's single exported formula are for; a static text gate
    // cannot chase dataflow.
    for (const path of FILES) {
      expect(codeText(path)).not.toMatch(/peerIdentityCache\??\.delete\( ?[A-Za-z_$][\w$]*\.userId ?\)/);
    }
  });
});
