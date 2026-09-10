/**
 * Audit P0-1 — defence against forged-outer-envelope ratchet wipe.
 *
 * Threat:
 *   The outer ECIES wrap (`packages/messenger-core/src/crypto/outerEcies.ts`)
 *   authenticates only `eph_pub || recipientPub` via AAD. The inner
 *   `s: {u, d}` (sender address) field is NOT bound by the outer GCM
 *   tag, so any authenticated submitter can mint a wrap to any victim
 *   with an attacker-chosen `senderAddress`. On receive `unwrapOuter`
 *   succeeds and the attacker-named peer is fed to `own.decrypt`,
 *   which throws `DecryptError` because no valid Signal session
 *   matches the attacker-minted inner ciphertext. The legacy catch-
 *   block then called `closeSession` + bundle refetch — wiping the
 *   legitimate ratchet to the named peer.
 *
 * Mitigation (this module — behavioural defence, does NOT change the
 * wire format):
 *   Refuse `closeSession`-on-DecryptError when the peer's session has
 *   had recent legitimate activity.
 *
 * Relationship to outer-ECIES v3 wire upgrade:
 *   The ROOT-CAUSE fix is `wrap/unwrapOuter` v3 (cert in outer AAD)
 *   plus pre-decrypt cert verify in `productionRuntime.handleDeliver`
 *   / `drainRelay`. With v3 the receiver derives the trusted peer
 *   from authority-attested claims BEFORE calling `own.decrypt`, so a
 *   forged outer envelope simply cannot reach a DecryptError — and
 *   this module becomes structurally unreachable on v3 senders.
 *
 *   This module still matters during the v2→v3 rollout window. Any
 *   peer that hasn't yet upgraded to a v3-aware client sends v2 wraps;
 *   the receiver's legacy decrypt path runs and the DecryptError catch
 *   can still attempt closeSession. The behavioural defence here
 *   keeps those peers protected until every fleet member is on v3.
 *   Once `EXPO_PUBLIC_OUTER_WIRE_V2=true` is no longer used in prod
 *   AND all clients are v3-capable, this module is belt-and-braces —
 *   keep it on for defence-in-depth.
 *
 *   Rationale:
 *     A live session that's been decrypting cleanly is overwhelmingly
 *     more likely to be hit by a forged envelope (attacker can spam
 *     per-minute) than by a legitimate identity rotation (rare per
 *     peer). The legitimate rotation case is STILL handled:
 *       - Peer's first message after reinstall arrives as a
 *         PreKeyWhisperMessage, which libsignal's own initiation path
 *         rebuilds without our closeSession intervention.
 *       - The genuine `IdentityKeyMismatchError` signal from the cert
 *         authority path (Sprint-6 peerIdentityRefresh) is unaffected
 *         — it runs outside this protection scope.
 *       - The "we've been idle and your prekey expired" case still
 *         hits the rebuild path because the protection window
 *         naturally elapses.
 *
 *   Window: 10 minutes by default. Long enough that a typical
 *   conversation's keepalive (typing/presence + messages) keeps the
 *   session "live" from the defender's perspective, short enough
 *   that idle peers don't get permanently quarantined against
 *   legitimate rotation. Tunable via
 *   `EXPO_PUBLIC_P01_PROTECTED_WINDOW_MS`; set to 0 to disable (NOT
 *   recommended outside forensic investigation of a related false
 *   positive).
 *
 * Bug-hunt #1 — persistence across cold start.
 *   The in-process Map below evaporated on every restart, so the first
 *   forged envelope to land after a crash slipped past the check and
 *   the legacy rebuild path destroyed the live ratchet. The
 *   `PeerSessionHealthStore` writes through to SQLCipher; this module
 *   keeps the in-process Map as a synchronous hot cache but consults
 *   the store on miss. Once `attachHealthStore` has been called and
 *   the store warmed, `hasRecentSuccessfulDecrypt` is fed from both
 *   sources and a cold-start lookup hits the SQL row written before
 *   the restart.
 *
 *   Rebuild-attempt cooldown (was `markRebuildAttempt` /
 *   `shouldAttemptRebuild` in productionRuntime.ts, also an unbounded
 *   in-process Map — P1-7) is folded into the same store row so the
 *   cooldown survives restart too.
 */

import type {SessionAddress} from '@bravo/messenger-core';
import type {PeerSessionHealthStore} from '../store/peerSessionHealthStore';

const DEFAULT_PROTECTED_SESSION_WINDOW_MS = 600_000;
const DEFAULT_REBUILD_COOLDOWN_MS = 60_000;

export const PROTECTED_SESSION_WINDOW_MS: number = (() => {
  const raw =
    typeof process !== 'undefined' &&
    (process as {env?: {[k: string]: string | undefined}}).env?.EXPO_PUBLIC_P01_PROTECTED_WINDOW_MS;
  if (!raw) {return DEFAULT_PROTECTED_SESSION_WINDOW_MS;}
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) {return DEFAULT_PROTECTED_SESSION_WINDOW_MS;}
  return n;
})();

export const REBUILD_COOLDOWN_MS = DEFAULT_REBUILD_COOLDOWN_MS;

/**
 * Audit 1:1 P1-7 — bound on the in-process hot caches.
 *
 * The persistent SQL store is the source of truth, but the in-process
 * Maps below back the hot path so it stays synchronous. Without a cap,
 * a long-lived install that talked to many peers (mission ops fleet,
 * group conversations) would accumulate one entry per distinct peer
 * for the entire process lifetime. 1024 entries × ~64 bytes each is
 * generous for any realistic user (group conversations top out in the
 * hundreds) while keeping eviction pressure off the steady state.
 *
 * Classical JS-Map-as-LRU: insertion order IS iteration order, so a
 * cache hit re-inserts to promote, and the oldest key gets evicted
 * when we exceed the cap. Bookkeeping is one delete + one set per touch.
 */
const HOT_CACHE_CAP = 1024;

function touchLru(m: Map<string, number>, key: string, value: number): void {
  if (m.has(key)) {m.delete(key);}
  m.set(key, value);
  if (m.size > HOT_CACHE_CAP) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) {m.delete(oldest);}
  }
}

const lastSuccessfulDecryptByPeer = new Map<string, number>();
const lastRebuildAttemptByPeer = new Map<string, number>();

let attachedHealth: PeerSessionHealthStore | null = null;

function keyFor(peer: SessionAddress): string {
  return `${peer.userId}.${peer.deviceId}`;
}

/**
 * Wire the persistent store into the in-process cache. Idempotent —
 * subsequent calls with the same store reuse it; passing null detaches.
 * The runtime calls this once on boot after SQLCipher is open and the
 * store has been warmed.
 */
export function attachHealthStore(store: PeerSessionHealthStore | null): void {
  attachedHealth = store;
  if (!store) {return;}
  // Seed the in-process cache from the warm SQL store so the first
  // post-restart `hasRecentSuccessfulDecrypt` lookup is satisfied
  // synchronously by the Map (no SQL latency on the hot receive path).
  // PeerSessionHealthStore.warm() must have run BEFORE this attach.
  // Iterating its cache is O(distinct peers), trivially small.
  // We don't expose an iterator to keep the API surface tight; instead
  // both maps lazy-fill on every `get()` below.
}

/**
 * Mark this peer's session as having had a SUCCESSFUL decrypt now.
 * Called from `doHandleIncoming` immediately after `own.decrypt`
 * resolves cleanly. Refreshes the protection-window timestamp.
 *
 * The SQL write is fire-and-forget (the in-process cache is the
 * source of truth for the hot path); a failure to persist is logged
 * but not propagated, because the next successful decrypt will write
 * a fresh row and the cold-start gap reopens only for a few minutes.
 */
export function rememberSuccessfulDecrypt(peer: SessionAddress): void {
  const now = Date.now();
  // Audit 1:1 P1-7 — bounded LRU promotion (vs unbounded set).
  touchLru(lastSuccessfulDecryptByPeer, keyFor(peer), now);
  if (attachedHealth) {
    attachedHealth.noteSuccess(keyFor(peer), now).catch(() => {
      // Best-effort persistence — the cache is the authority for the
      // hot path. Cold-start window reopens transiently on persist
      // failure; surface in dev only.
    });
  }
}

/**
 * Returns true if the peer's session was used successfully within the
 * protection window. Callers MUST NOT closeSession when this is true —
 * surface a soft banner instead. Consults both the in-process Map and
 * (lazily) the attached health store, so a cold-start lookup hits the
 * SQL row written before the restart.
 *
 * When the window is set to 0 (disabled), always returns false so
 * the legacy behaviour kicks in.
 */
export function hasRecentSuccessfulDecrypt(peer: SessionAddress): boolean {
  if (PROTECTED_SESSION_WINDOW_MS <= 0) {return false;}
  const key = keyFor(peer);
  const now = Date.now();
  let last = lastSuccessfulDecryptByPeer.get(key) ?? 0;
  if (last === 0 && attachedHealth) {
    const row = attachedHealth.get(key);
    if (row && row.lastSuccessMs > 0) {
      last = row.lastSuccessMs;
      // Audit 1:1 P1-7 — fill via the LRU helper, not raw set.
      touchLru(lastSuccessfulDecryptByPeer, key, last);
    }
  }
  if (last === 0) {return false;}
  return now - last < PROTECTED_SESSION_WINDOW_MS;
}

/**
 * True iff this peer's last rebuild attempt was longer ago than the
 * cooldown. Read-only; the caller stamps `noteRebuildAttempt` AFTER a
 * successful rebuild only (preserves the fix-#6 semantics — a failed
 * bundle fetch does not arm the cooldown).
 */
export function shouldAttemptRebuild(peer: SessionAddress): boolean {
  const key = keyFor(peer);
  const now = Date.now();
  let last = lastRebuildAttemptByPeer.get(key) ?? 0;
  if (last === 0 && attachedHealth) {
    const row = attachedHealth.get(key);
    if (row && row.lastRebuildAttemptMs > 0) {
      last = row.lastRebuildAttemptMs;
      // Audit 1:1 P1-7 — fill via the LRU helper.
      touchLru(lastRebuildAttemptByPeer, key, last);
    }
  }
  return now - last >= REBUILD_COOLDOWN_MS;
}

/** Stamp the rebuild-attempt cooldown for this peer. */
export function markRebuildAttempt(peer: SessionAddress): void {
  const now = Date.now();
  // Audit 1:1 P1-7 — bounded LRU promotion.
  touchLru(lastRebuildAttemptByPeer, keyFor(peer), now);
  if (attachedHealth) {
    attachedHealth.noteRebuildAttempt(keyFor(peer), now).catch(() => { /* best-effort */ });
  }
}

/** Clear the rebuild-attempt cooldown for this peer (e.g. on identity rotation). */
export function clearRebuildAttempt(peer: SessionAddress): void {
  lastRebuildAttemptByPeer.delete(keyFor(peer));
  // We deliberately don't write a zero to SQL — the next noteSuccess
  // or noteRebuildAttempt will overwrite, and zero-rows would just bloat
  // the table. If the in-process map is missing the entry, the next
  // shouldAttemptRebuild query consults SQL again; we accept that small
  // window of "stale rebuild cooldown after explicit clear" — it never
  // causes wrong behaviour, only a slightly slower retry.
}

/** Test-only — clear the in-process protection state. */
export function _resetSessionWipeProtection(): void {
  lastSuccessfulDecryptByPeer.clear();
  lastRebuildAttemptByPeer.clear();
  attachedHealth = null;
}
