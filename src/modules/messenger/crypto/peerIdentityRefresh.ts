/**
 * Peer-identity refresh on rotation. Closes the silent-drop gap
 * surfaced by the `bravo.drainRelay reconnect drain failed: 'sender
 * identity key mismatch'` line in the logs.
 *
 * What this fixes
 * ---------------
 * When a peer reinstalls the app, their identity keypair may be
 * republished to the keys-service. The recipient still has the OLD
 * identity in the local SqlCipherProtocolStore. The next envelope
 * from that peer carries a sender cert claiming the NEW identity;
 * `verifySenderCert` throws "sender identity key mismatch" against
 * our stored copy. Without recovery, the throw propagates through
 * drainRelay's per-envelope loop and kills the entire pull — every
 * later envelope in the same page is left unprocessed.
 *
 * Session reset on rotation (BS-IDKEY)
 * ------------------------------------
 * Saving the new identity key alone is NOT enough to decrypt: the peer's
 * old Double-Ratchet session in our store was negotiated against their
 * OLD identity, so even after `saveIdentity` the retry decrypt fails with
 * a ratchet/session error and the message is dropped. When the rotation
 * is authority-confirmed we therefore ALSO `removeSession` for that peer
 * so libsignal rebuilds a fresh session from the peer's new prekey bundle
 * on the next message/send. The envelope that carried the rotation is the
 * last one under the dead ratchet and cannot be recovered (it was sealed
 * to a session that no longer exists) — but every subsequent message now
 * decrypts instead of being silently dropped forever. Mirrors the
 * Signal/WhatsApp "safety number changed → session re-established" model;
 * `sessionReset` in the outcome lets the caller surface that to the user.
 *
 * What this does NOT fix
 * ----------------------
 * - Outer ECIES "outer sealed authentication failed" — fires BEFORE
 *   unwrap so no sender info is available to look up.
 *
 * Trust model
 * -----------
 * keys-service is authoritative for "who is X's current identity"
 * because every published bundle is signed by the registration
 * authority's Ed25519 key (verifySenderCert uses the same authority
 * pub-key for cert verification). If the keys-service confirms the
 * cert's claimed identity, we accept the rotation. If not, the cert
 * is stale or forged — drop, do not mutate trust.
 *
 * Cost
 * ----
 * `fetchPeerBundleWithPoolSize` consumes one one-time prekey from
 * the peer's server-side pool. We only call this from the cert-
 * mismatch catch path (rare — happens once per peer per rotation),
 * NOT on every drain pass.
 */

import type {KeysHttpClient, CryptoStore} from '@bravo/messenger-core';
import {fromBase64, toBase64} from '@bravo/messenger-core';

export interface RefreshOutcome {
  /**
   * 'refreshed' — keys-service confirmed the rotation; we updated
   * the local store. Caller should retry handleIncoming once.
   *
   * 'stale-cert' — keys-service does NOT report the cert's claimed
   * identity as current. Either the envelope was sent during a
   * prior, since-superseded rotation, or the cert is forged. Caller
   * drops the envelope.
   *
   * 'no-change' — keys-service still reports our cached identity.
   * The cert mismatch is something else (caller bug, race against
   * an in-flight saveIdentity). Caller drops the envelope.
   *
   * 'unavailable' — keys-service call failed (network / 5xx).
   * Caller MUST NOT ack the relay envelope — a future drain can
   * retry once connectivity returns.
   */
  result: 'refreshed' | 'stale-cert' | 'no-change' | 'unavailable';
  /** Optional diagnostic for telemetry breadcrumbs. */
  reason?: string;
  /**
   * BS-IDKEY — true when we archived the peer's stale session as part of
   * a confirmed identity rotation, so libsignal rebuilds fresh on the
   * next message. The caller uses this to surface a "safety number
   * changed" notice (the rotation is now trusted, but the user should
   * know the peer's keys changed — a standard secure-messenger signal).
   */
  sessionReset?: boolean;
}

/**
 * Attempt to reconcile a sender-identity-mismatch by fetching the
 * authoritative identity from the keys-service.
 *
 * @param peerUserId       userId from the sender cert claims
 * @param peerDeviceId     deviceId from the sender cert claims
 * @param certIdentityB64  base64 identity key the cert claims
 * @param keys             keys-service client (optional — pass undefined to skip)
 * @param ownStore         local crypto store for saveIdentityKey
 */
export async function refreshPeerIdentityIfRotated(
  peerUserId:      string,
  peerDeviceId:    number,
  certIdentityB64: string,
  keys:            KeysHttpClient | undefined,
  ownStore:        CryptoStore,
): Promise<RefreshOutcome> {
  if (!keys) {
    return {result: 'unavailable', reason: 'no-keys-client'};
  }
  let identityFromServer: string;
  try {
    // Use the pool-size variant — same endpoint as the steady-state
    // send path so the keys-service can amortise tracking.
    const {bundle} = await keys.fetchPeerBundleWithPoolSize(peerUserId);
    identityFromServer = bundle.identityKey;
  } catch (e) {
    return {result: 'unavailable', reason: (e as Error).message.slice(0, 80)};
  }
  if (!identityFromServer) {
    return {result: 'stale-cert', reason: 'bundle-missing-identity'};
  }
  if (identityFromServer !== certIdentityB64) {
    // keys-service disagrees with the cert. The cert is stale or
    // forged. Do NOT mutate our trust.
    return {result: 'stale-cert', reason: 'cert-vs-bundle-mismatch'};
  }
  // keys-service confirms the cert's claim. Update local trust.
  const addrKey = `${peerUserId}.${peerDeviceId}`;
  const currentLocal = await ownStore.loadIdentityKey(addrKey);
  const currentLocalB64 = currentLocal ? toBase64(currentLocal) : null;
  if (currentLocalB64 === certIdentityB64) {
    // Race: another path already updated. Caller can retry directly.
    return {result: 'refreshed', reason: 'already-current'};
  }
  await ownStore.saveIdentity(addrKey, fromBase64(certIdentityB64));
  // BS-IDKEY — archive the stale session. The peer's old Double-Ratchet
  // state was negotiated under their OLD identity; without dropping it the
  // post-refresh retry decrypts against a dead ratchet and the message is
  // lost. removeSession forces libsignal to rebuild from the peer's new
  // prekey bundle on the next message/send. Best-effort: a store without
  // a session row (first contact post-rotation) is a no-op, and a failure
  // here must not block the trust update we just committed.
  let sessionReset = false;
  try {
    await ownStore.removeSession(addrKey);
    sessionReset = true;
  } catch (e) {
    // Non-fatal: identity is updated; the next prekey message can still
    // rebuild. Surface the reason for telemetry but keep result=refreshed.
    return {result: 'refreshed', reason: `updated;session-reset-failed:${(e as Error).message.slice(0, 40)}`};
  }
  return {result: 'refreshed', reason: 'updated', sessionReset};
}
