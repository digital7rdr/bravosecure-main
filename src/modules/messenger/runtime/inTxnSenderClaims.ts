import {verifySenderCert} from '@bravo/messenger-core';
import type {CryptoStore, KeysHttpClient, SessionAddress} from '@bravo/messenger-core';
import {resolveExpectedSenderIdentity} from '../crypto/expectedSenderIdentity';
import type {PeerIdentityCache} from '../crypto/peerIdentityCache';

/**
 * Seam S1 — the in-transaction sender-claims check from `doHandleIncoming`.
 *
 * Distinct from `senderCertAdmit` (which runs BEFORE decryption on both receive
 * paths). This one runs INSIDE the receive transaction, after the ratchet has
 * already advanced, and answers a narrower question: do the authority-attested
 * claims match the peer we just decrypted from?
 *
 * WHY IT THROWS RATHER THAN RETURNING A VERDICT — this is the whole contract,
 * and it is easy to "simplify" wrongly. Inside `doHandleIncoming` a bare
 * `return` COMMITs the transaction, keeping the libsignal session UPSERT from
 * the decrypt that just happened. On the inevitable redelivery libsignal then
 * throws "bad MAC" against the now-burned per-message key and the conversation
 * is stuck permanently. Throwing rolls the ratchet back to its pre-decrypt
 * state, so a later cert-matched envelope can still succeed. Do NOT convert
 * these throws into returns.
 *
 * Extracted so the two checks — which are security rules, not plumbing — are
 * reachable by a unit test. Previously nothing could call them: they live in an
 * 8k-line module that jest cannot import, so they were covered only by mirrors.
 */

export interface InTxnClaimsArgs {
  /** The unsealed payload's sender certificate. */
  cert:               string;
  /** The peer the OUTER wrap named, i.e. who we think we decrypted from. */
  peer:               SessionAddress;
  ownStore:           CryptoStore;
  keys:               KeysHttpClient | undefined;
  peerIdentityCache?: PeerIdentityCache;
  authorityPubKeyB64: string;
  /** Surface a user-visible reason; injected so this stays store-free. */
  onError?:           (message: string) => void;
}

export interface InTxnClaims {
  senderUserId:         string;
  senderSignalDeviceId: number;
  /**
   * Carried through because the group-admin lane verifies a relayed `create`'s
   * owner signature against it — the authority-attested key, never the
   * forgeable inner `sender` field.
   */
  senderIdentityKey:    string;
}

export async function verifyInTxnSenderClaims(args: InTxnClaimsArgs): Promise<InTxnClaims> {
  const {cert, peer, ownStore, keys, peerIdentityCache, authorityPubKeyB64, onError} = args;

  // Audit P0-8 — local trust row first, authority-signed bundle on cold
  // contact, undefined only on dual failure (continuity skipped, signature and
  // expiry still enforced).
  const expectedIdentityKey = await resolveExpectedSenderIdentity(
    peer, ownStore, keys, peerIdentityCache,
  );
  const claims = await verifySenderCert({
    cert,
    authorityPubKeyB64,
    expectedIdentityKey,
  });

  // Audit 1:1 P1-3 — the cert must name the peer the outer wrap named.
  if (claims.senderUserId !== peer.userId) {
    onError?.('sender cert / hint mismatch');
    throw new Error('cert_peer_mismatch');
  }
  // Audit 1:1 P0-2 — deviceId pinning. The cert claims a specific
  // (userId, deviceId) and the outer wrap names the same pair; a mismatch is a
  // cross-device replay attempt.
  if (claims.senderSignalDeviceId !== peer.deviceId) {
    onError?.('sender cert / device-id mismatch');
    throw new Error('cert_device_mismatch');
  }

  return {
    senderUserId:         claims.senderUserId,
    senderSignalDeviceId: claims.senderSignalDeviceId,
    senderIdentityKey:    claims.senderIdentityKey,
  };
}
