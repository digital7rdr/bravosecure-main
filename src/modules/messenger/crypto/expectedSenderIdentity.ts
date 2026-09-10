import type {CryptoStore, KeysHttpClient, SessionAddress} from '@bravo/messenger-core';
import {toBase64} from '@bravo/messenger-core';
import {peerIdentityCacheKey, PEER_IDENTITY_TTL_MS, type PeerIdentityCache} from './peerIdentityCache';

/**
 * Audit P0-8 — resolve the trusted identity key (base64) for the
 * sender of an inbound envelope BEFORE verifying their cert.
 *
 * Resolution order:
 *   1. Local trust row (`ownStore.loadIdentityKey`) — fast path, no
 *      network. Anyone who's exchanged at least one message with us
 *      hits this branch.
 *   2. Authority-signed bundle fetch — cold contact path. Returns the
 *      bundle's identityKey on success; P0-I2 (authority binding in
 *      `KeysHttpClient.verifyOrThrow`) attests it.
 *   3. undefined — both paths failed (transient outage or unbound
 *      legacy bundle). The caller passes `expectedIdentityKey:
 *      undefined` to `verifySenderCert` so the cert is still verified
 *      for signature + expiry + revocation but the continuity check is
 *      skipped. Matches the prior behaviour for availability under a
 *      keys-service blip.
 *
 * Returning undefined on dual-failure is intentional. Failing closed
 * would mean a keys-service outage stops every cold-contact message
 * from decrypting; failing open returns to the legacy gap. Since the
 * cert signature itself remains the load-bearing trust anchor in the
 * fallback case, the closed-then-opens-later compromise is the right
 * trade — the prior behaviour with no resolution at ALL is what the
 * audit P0-8 row flagged. With this helper the steady-state path
 * (local row OR successful bundle fetch) is the only path that hands
 * off to the keys-service for substitution.
 *
 * NOT responsible for persisting fetched identities. The right time to
 * trust a freshly-fetched key is AFTER `verifySenderCert` confirms
 * the cert binds the same identity AND libsignal's session-init pins
 * it on the first successful decrypt — that happens downstream. Saving
 * here would let a one-shot bad bundle (somehow past the authority
 * signature check) poison the trust row before the cert has had a
 * chance to fail.
 */
export async function resolveExpectedSenderIdentity(
  peer:     SessionAddress,
  ownStore: CryptoStore,
  // Optional ON PURPOSE. Callers on the receive paths may have no keys client
  // (loopback / fully-offline build). Without this the drain path hand-rolled
  // its own "local trust row, else undefined" fallback — a second, divergent
  // implementation of this function's own step 1. It only *happened* to agree
  // because a missing client threw inside the catch below and surfaced as
  // undefined. Making the parameter honest lets both receive paths call this
  // unconditionally and deletes that copy. See MESSAGE_LOOP.md M5.
  keys:     KeysHttpClient | undefined,
  // F12 cold-contact-receive-double-opk-pop — optional shared identity cache
  // (the same Map the send path uses, keyed by `${userId}.${deviceId}`). The
  // bundle fetch below is DESTRUCTIVE: it pops one of the peer's server-side
  // one-time prekeys, even though the receiver needs only the peer's
  // OPK-independent identity key. This resolver runs in BOTH the pre-decrypt
  // cert verify AND doHandleIncoming, so a single cold-contact first message
  // used to burn TWO of the sender's OPKs purely to read their identity.
  // Caching the fetched identity collapses that to ONE pop; after the first
  // successful decrypt libsignal pins the key locally and the fast path (1)
  // takes over. Eviction is shared with the send cache (on identity rotation
  // / decrypt failure), so a stale identity can't survive a key change.
  cache?:   PeerIdentityCache,
): Promise<string | undefined> {
  // Same composite form for the trust-row address AND the cache key — the two
  // stores deliberately share the `${userId}.${deviceId}` addressing.
  const cacheKey = peerIdentityCacheKey(peer);
  const local = await ownStore.loadIdentityKey(cacheKey);
  if (local) {return toBase64(local);}
  const hit = cache?.get(cacheKey);
  if (hit && Date.now() - hit.fetchedAt < PEER_IDENTITY_TTL_MS) {return hit.idKey;}
  // No keys client ⇒ the local trust row was the only anchor available and it
  // missed. Return undefined explicitly rather than relying on the catch below
  // swallowing a TypeError — same result, but stated instead of accidental.
  if (!keys) {return undefined;}
  try {
    const {bundle} = await keys.fetchPeerBundleWithPoolSize(peer.userId);
    cache?.set(cacheKey, {idKey: bundle.identityKey, fetchedAt: Date.now()});
    return bundle.identityKey;
  } catch {
    return undefined;
  }
}
