import {verifySenderCert, IdentityKeyMismatchError} from '@bravo/messenger-core';
import type {CryptoStore, KeysHttpClient, SessionAddress} from '@bravo/messenger-core';
import {resolveExpectedSenderIdentity} from '../crypto/expectedSenderIdentity';
import {peerIdentityCacheKey, type PeerIdentityCache} from '../crypto/peerIdentityCache';
import {notePeerIdentityChanged} from '../store/peerIdentityAckStore';
import {log as crashLog} from '../../observability/crashlytics';
import {useMessengerStore} from '../store/messengerStore';
import {isTransientCertError, isTransientSqlError} from './receiveTransaction';

/**
 * M5 — the v3 sender-cert admission decision, shared by BOTH receive paths.
 *
 * `handleDeliverInner` (WebSocket) and `drainRelay` (HTTP catch-up) each carried
 * their own ~60-line copy of this. Two copies of a SECURITY decision — "is this
 * sender who the authority says they are, and what do we do when their identity
 * rotated?" — is the worst kind of duplication to own, and they had already
 * drifted in logging, in the no-keys branch shape, and (until 3aad19c) in which
 * trust anchor they consulted.
 *
 * This function DECIDES and never acts on the relay: it returns a verdict and
 * the caller acks. That is deliberate — the two paths ack differently (WS
 * `return`s, the drain `continue`s a loop) and burying a relay call in here
 * would hide an ack inside a decision function.
 *
 * Verification semantics are unchanged and deliberately NOT relaxed:
 *   - expected identity comes from the local trust row first, then the
 *     authority-signed bundle (P0-8); undefined only on dual failure, where the
 *     cert is still checked for signature + expiry + revocation and only
 *     CONTINUITY is skipped — the pre-existing availability posture.
 *   - the revocation cache is consulted only when FRESH (P1-1). A stale cache
 *     is intentionally not passed: a revocation-list DoS must not be able to
 *     disable cert verification altogether.
 *   - the trusted peer comes from the authority-attested CLAIMS, never from the
 *     inner `sender` field, which is forgeable on v3 too.
 */
export type CertAdmitVerdict =
  /** Proceed to decrypt with this peer identity. */
  | {kind: 'proceed'; trustedPeer: SessionAddress}
  /** Unrecoverable — ack `discarded` so the sender's tick stays honest. */
  | {kind: 'ack-discard'}
  /** Transient (keys-service blip) — do NOT ack; let the relay redeliver. */
  | {kind: 'leave-on-relay'};

export interface CertAdmitDeps {
  ownStore:           CryptoStore;
  keys:               KeysHttpClient | undefined;
  peerIdentityCache?: PeerIdentityCache;
  authorityPubKeyB64: string;
  revokedJtis?:       ReadonlySet<string>;
  envelopeId:        string;
  /** Log prefix only — 'ws' or 'drain'. Never affects the verdict. */
  tag:               'ws' | 'drain';
}

export interface CertAdmitEnvelope {
  wireVersion?: number;
  senderCert?:  string;
  sender:       SessionAddress;
}

export async function admitSenderCert(
  unwrapped: CertAdmitEnvelope,
  deps: CertAdmitDeps,
): Promise<CertAdmitVerdict> {
  // v2 / no cert — the inner sender is all we have (back-compat decode path).
  if (!(unwrapped.wireVersion === 3 && unwrapped.senderCert)) {
    return {kind: 'proceed', trustedPeer: unwrapped.sender};
  }

  try {
    const expectedIdentityKey = await resolveExpectedSenderIdentity(
      unwrapped.sender, deps.ownStore, deps.keys, deps.peerIdentityCache,
    );
    const claims = await verifySenderCert({
      cert:               unwrapped.senderCert,
      authorityPubKeyB64: deps.authorityPubKeyB64,
      expectedIdentityKey,
      revokedJtis:        deps.revokedJtis,
    });
    return {
      kind: 'proceed',
      trustedPeer: {userId: claims.senderUserId, deviceId: claims.senderSignalDeviceId},
    };
  } catch (e) {
    const env8 = deps.envelopeId.slice(0, 8);

    // BS-CERT-MISMATCH — the original code `throw e`'d here expecting a later
    // try/catch to handle it. That never worked (a throw in one catch is not
    // caught by a sibling try, and inside a for-loop it exits the loop), so the
    // refresh never ran and the envelope redelivered forever. The refresh runs
    // INLINE here so it actually executes.
    if (e instanceof IdentityKeyMismatchError && deps.keys) {
      const {refreshPeerIdentityIfRotated} = require('../crypto/peerIdentityRefresh') as
        typeof import('../crypto/peerIdentityRefresh');
      const outcome = await refreshPeerIdentityIfRotated(
        e.claims.senderUserId,
        e.claims.senderSignalDeviceId,
        e.claims.senderIdentityKey,
        deps.keys,
        deps.ownStore,
      );
      crashLog(`[messenger] ${deps.tag}-cert-pre-verify-rotation env=${env8} outcome=${outcome.result} reason=${outcome.reason ?? '-'}`);

      // TOFU send-gate — record the unacknowledged identity change (harmless
      // when the gate flag is off; sendText only blocks on it when enabled).
      if (outcome.result === 'refreshed' && outcome.sessionReset) {
        void notePeerIdentityChanged(e.claims.senderUserId);
      }
      if (outcome.result === 'refreshed') {
        try {
          deps.peerIdentityCache?.delete(peerIdentityCacheKey({userId: e.claims.senderUserId, deviceId: e.claims.senderSignalDeviceId}));
        } catch { /* ignore */ }
        if (outcome.sessionReset) {
          try {
            useMessengerStore.getState().setError('A contact’s security code changed — their messages will resume on a new secure session.');
          } catch { /* ignore */ }
        }
        // Trust refreshed — proceed with the authority-attested claims.
        return {
          kind: 'proceed',
          trustedPeer: {userId: e.claims.senderUserId, deviceId: e.claims.senderSignalDeviceId},
        };
      }
      if (outcome.result === 'unavailable') {
        // Keys-service blip — redeliverable, so do NOT ack.
        return {kind: 'leave-on-relay'};
      }
      // stale-cert / no-change — cannot recover.
      crashLog(`[messenger] ${deps.tag}-cert-pre-verify-mismatch dropped env=${env8} reason=${outcome.reason ?? '?'}`);
      return {kind: 'ack-discard'};
    }

    // M6 — a CLOCK-WINDOW failure is not a verdict about the sender. Acking
    // `discarded` here deleted the envelope off the relay, so a device whose
    // clock was momentarily >120s out lost the message PERMANENTLY, with no
    // redelivery and nothing in the log to explain it. Leave it on the relay
    // instead; a later drain succeeds once the clock settles.
    //
    // Bounded naturally by the relay's 30-day dwell rather than by a retry
    // budget: a permanently-wrong clock stops costing anything when the
    // envelope expires, and until then the message is still recoverable —
    // which is the trade this invariant is about (a redelivery loop is
    // annoying; a destroyed message is not fixable).
    if (isTransientCertError(e)) {
      crashLog(`[messenger] ${deps.tag}-cert-clock-skew LEAVE-ON-RELAY env=${env8} err=${String((e as Error)?.message ?? e).slice(0, 60)}`);
      return {kind: 'leave-on-relay'};
    }
    // AUDIT #11 rev-6 (edge, lane 5) — this try's FIRST statement is a live
    // SQL read (resolveExpectedSenderIdentity → loadIdentityKey). A
    // transient local failure (db_closed during a rebuild's handle swap,
    // BUSY) is not a verdict about the sender — same M6 trade as the clock
    // window: a redelivery loop is annoying; a destroyed message is not
    // fixable. (Coverage note, critic: refreshPeerIdentityIfRotated's
    // trusted_identities write sits INSIDE this catch, ahead of the gates
    // — a db_closed there escapes as a rejection instead, which both
    // callers propagate WITHOUT acking: leave-on-relay by a different
    // door, still the safe direction.)
    if (isTransientSqlError(e)) {
      crashLog(`[messenger] ${deps.tag}-cert-transient-sql LEAVE-ON-RELAY env=${env8} err=${String((e as Error)?.message ?? e).slice(0, 60)}`);
      return {kind: 'leave-on-relay'};
    }
    crashLog(`[P0-1] ${deps.tag} v3 cert pre-verify failed envId=${env8} err=${String((e as Error)?.message ?? e).slice(0, 120)}`);
    return {kind: 'ack-discard'};
  }
}
