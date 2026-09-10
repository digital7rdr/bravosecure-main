import type {CryptoStore, KeysHttpClient, SessionAddress} from '@bravo/messenger-core';
import {toBase64} from '@bravo/messenger-core';
import {notePeerRotationSuspected} from './peerRotationFlag';

/**
 * AUDIT-2026-08-13 #5 — the peer-identity cache contract, in ONE place.
 *
 * The cache is a single Map shared by the send path (outer-ECIES wrap target)
 * and the receive path (`resolveExpectedSenderIdentity`). Its entries are
 * server-authoritative identity keys ONLY — never a local-trust-row fallback
 * (a fallback read mid-rotation is exactly the dead identity the eviction
 * sites exist to discard; caching it would re-poison the Map for a full TTL).
 * A failed bundle fetch instead arms a short per-peer cooldown so a slow or
 * rate-limiting keys-service is not re-probed on every send (the trust row is
 * served during the hold — same value the old fallback cache served, for at
 * most COOLDOWN instead of a full TTL; the bound is pinned by test).
 * KNOWN RESIDUAL: of the five evictions, three (the rotation-recovery sites)
 * fire only after `refreshPeerIdentityIfRotated` has already committed the
 * fresh trust row, so a hold-armed read serves the CURRENT key; the
 * decrypt-error site in `doHandleIncoming` is NOT refresh-gated, and the
 * recovery closure's own step-1 delete leaves the old row when its refresh
 * THROWS at the fetch — at both, a hold can serve the old row for the
 * remainder of the hold (≤30s, vs 8 min pre-fix) before the B-46 lane heals
 * it. A never-contacted peer (no trust row) is deliberately exempt from the
 * hold — first contact is never starved, at the cost of one transport
 * timeout per send during an outage. The per-cache failure map is never
 * pruned per-key (entries only lapse); growth is bounded by distinct
 * peer-devices contacted in one runtime lifetime, same as the cache itself.
 *
 * Every read, write and delete of the Map MUST key it via
 * `peerIdentityCacheKey` and expire it via `PEER_IDENTITY_TTL_MS` — both are
 * owned here and only here. The original bug was two recovery sites evicting
 * with a bare userId — a key no writer ever produces, so the delete was a
 * silent no-op and resends re-wrapped to the peer's dead identity for up to
 * 8 minutes. Covered lanes: the shared recovery closure
 * (`refreshPeerIdentityAndSession` — B-46 auto-resend + B-122 retry), the
 * rotation-recovery deletes on both receive paths, and both cache writers.
 * NOT yet routed through this contract: `resetSessionWith` (ChatInfo "Reset
 * secure session") rebuilds the session without evicting/seeding this cache —
 * pre-existing, self-heals via B-46 within one round trip, logged as a
 * follow-up in the audit doc. `peerIdentityCacheKey.test.ts` pins the rest.
 */
export interface PeerIdentityCacheEntry {
  idKey: string;
  fetchedAt: number;
}
export type PeerIdentityCache = Map<string, PeerIdentityCacheEntry>;

/**
 * Fix #11 — short enough that a fresh reinstall self-heals on the next
 * inbound, long enough to coalesce a chat session into one destructive
 * bundle fetch (each fetch pops one of the peer's one-time pre-keys).
 */
export const PEER_IDENTITY_TTL_MS = 8 * 60 * 1000;

export function peerIdentityCacheKey(peer: Pick<SessionAddress, 'userId' | 'deviceId'>): string {
  return `${peer.userId}.${peer.deviceId}`;
}

/**
 * Recover the recipient's identity public key (base64) for the outer
 * ECIES wrap. Server-first: the previous version returned the libsignal-
 * cached identity if present, which never refreshed when the peer rotated
 * keys (clear-data + reinstall) — the libsignal cache only updates on
 * receiving a PreKeyWhisperMessage from the peer, a chicken-and-egg loop
 * after rotation. Falls back to the local trust row only when the network
 * request fails — better stale than no message at all.
 *
 * `fromServer` tells the caller which branch produced the key. Only a
 * server-fetched key may enter the shared cache (see module header).
 */
export async function recipientIdentityKeyB64(
  ownStore: CryptoStore,
  keys: KeysHttpClient,
  peer: SessionAddress,
): Promise<{idKey: string; fromServer: boolean}> {
  try {
    const {bundle} = await keys.fetchPeerBundleWithPoolSize(peer.userId);
    return {idKey: bundle.identityKey, fromServer: true};
  } catch {
    const cached = await ownStore.loadIdentityKey(peerIdentityCacheKey(peer));
    if (cached) {return {idKey: toBase64(cached), fromServer: false};}
    throw new Error('peer identity unavailable: server unreachable and no local cache');
  }
}

/**
 * When a bundle fetch fails, how long the wrapper serves the trust row
 * WITHOUT re-attempting the fetch. Bounds the degraded-regime cost: a
 * keys-service that is slow (20s transport timeout) or rate-limiting must
 * not be re-probed by every queued send — the serial outbox drain has a 30s
 * budget and would otherwise ship ~1 row per sweep. The identity served
 * during the hold is the same value the pre-#5 code cached for a full 8-min
 * TTL, so the staleness window strictly shrank; the Map itself still never
 * holds a fallback.
 */
export const NEGATIVE_FETCH_COOLDOWN_MS = 30 * 1000;

// Cooldown state scoped to the cache instance it protects (WeakMap: dies with
// the runtime's Map on rebuild, and needs no extra parameter at 10 call sites
// — a second threaded param is the drift shape this module exists to kill).
const recentFetchFailures = new WeakMap<PeerIdentityCache, Map<string, number>>();

function armCooldown(cache: PeerIdentityCache, key: string): void {
  let failures = recentFetchFailures.get(cache);
  if (!failures) {
    failures = new Map();
    recentFetchFailures.set(cache, failures);
  }
  failures.set(key, Date.now());
}

/**
 * Drop a peer's negative-fetch hold after an authoritative fetch OUTSIDE the
 * cached wrapper succeeded (the recovery closure fetches via
 * `forceRefreshOutgoingSession` directly). A success proves the keys-service
 * reachable, so keeping the hold would only delay the next legitimate probe —
 * and it shrinks the one residual window where a rotation-recovery eviction
 * (`doHandleIncoming`'s decrypt-error site, which is NOT refresh-gated) could
 * serve a still-stale trust row for the rest of the hold.
 */
export function clearNegativeFetchCooldown(cache: PeerIdentityCache, peer: Pick<SessionAddress, 'userId' | 'deviceId'>): void {
  recentFetchFailures.get(cache)?.delete(peerIdentityCacheKey(peer));
}

/**
 * Fix #11: cached version of `recipientIdentityKeyB64`. Every call to the
 * bare version pops one of the peer's one-time pre-keys (GET /auth/keys/:id
 * is destructive on the OPK pool by design — that's how X3DH works). Sending
 * 50 messages to a peer exhausted all 50 pre-uploaded OPKs in one chat
 * session, after which any new sender's X3DH stalled until that peer came
 * back online to refill.
 *
 * Identity keys rotate only on reinstall, which we already detect via
 * DecryptError → the caller invalidates this cache there.
 *
 * AUDIT #5 — a local-row fallback is served to THIS caller but never cached:
 * during identity-rotation recovery the trust row still holds the DEAD key
 * until `forceRefreshOutgoingSession` overwrites it, and caching that value
 * would undo the recovery's eviction for a full TTL. The cooldown (above)
 * absorbs the fetch cost instead. A cooldown hold with NO trust row falls
 * through to the fetch — a first-contact send must never be starved.
 */
export async function recipientIdentityKeyB64Cached(
  ownStore: CryptoStore,
  keys: KeysHttpClient,
  peer: SessionAddress,
  cache: PeerIdentityCache,
): Promise<string> {
  const key = peerIdentityCacheKey(peer);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < PEER_IDENTITY_TTL_MS) {
    return hit.idKey;
  }
  const failedAt = recentFetchFailures.get(cache)?.get(key);
  if (failedAt !== undefined && Date.now() - failedAt < NEGATIVE_FETCH_COOLDOWN_MS) {
    const row = await ownStore.loadIdentityKey(key);
    if (row) {return toBase64(row);}
  }
  try {
    const got = await recipientIdentityKeyB64(ownStore, keys, peer);
    if (got.fromServer) {
      cache.set(key, {idKey: got.idKey, fetchedAt: Date.now()});
      recentFetchFailures.get(cache)?.delete(key);
      // B-701 — send-side rotation detection, riding the fetch the seal
      // already paid for (no extra network, no extra OPK pop). The trust
      // row is what the cached Double-Ratchet session was negotiated
      // against; a SERVER identity that differs means the peer reinstalled
      // and every message sealed into that session is dead on arrival.
      // Note-only here (this module has no SessionManager) — the rebuild
      // happens in ensureOutgoingSession's fast path, one-shot.
      try {
        const row = await ownStore.loadIdentityKey(key);
        if (row && toBase64(row) !== got.idKey) {
          notePeerRotationSuspected(key);
        }
      } catch { /* trust row unreadable — detection is best-effort */ }
    } else {
      armCooldown(cache, key);
    }
    return got.idKey;
  } catch (e) {
    armCooldown(cache, key);
    throw e;
  }
}
