/**
 * Ops-side adapter over the package's pure `broadcastToGroup`.
 *
 * The package version is a pure fan-out: it takes a `deliver` callback
 * and returns ciphertext per recipient. Ops's UI contract is richer —
 * it expects `{conversationId, members[]}` in, and `{envelopeIds[],
 * failures[]}` out, plus the relay submission and outer-ECIES wrap
 * happening internally.
 *
 * This adapter bridges those two shapes:
 *   • Synthesizes a minimal GroupState from the conversation roster.
 *   • Wraps each per-recipient ciphertext with outer ECIES and submits
 *     it via the ops relay client inside the deliver callback.
 *   • Builds an outgoing Signal session via keysApi.fetchBundle for
 *     peers we haven't talked to yet (ensureSession hook).
 *   • Surfaces partial-success (envelopeIds[], failures[]) in the same
 *     shape ops's MissionGroupPanel already consumes.
 */

import {
  broadcastToGroup as packageBroadcastToGroup,
  wrapOuter,
  toBase64,
  type SessionManager,
  type SessionAddress,
  type CryptoStore,
  type GroupState,
  type GroupAdminAction,
  type BroadcastResult,
} from '@bravo/messenger-core';
import {keysApi} from './keys';
import {relay} from './relay';

const DEFAULT_DEVICE_ID = 1;

export interface ConversationMember {
  userId:      string;
  displayName: string;
  role:        'admin' | 'member';
}

export interface OpsBroadcastParams {
  conversationId: string;
  members:        ConversationMember[];
  self:           SessionAddress;
  cert:           string;
  body:           string;
  ttlSeconds?:    number;
  session:        SessionManager;
  /**
   * Crypto store backing the SessionManager — used for cached peer
   * identity keys when wrapping outer ECIES. Falls through to a
   * fresh keysApi.fetchBundle if a peer's key isn't cached yet.
   */
  store:          CryptoStore;
  /**
   * Group master key (base64, 32 bytes). When set on a non-admin send,
   * the inner envelope JSON is AES-256-GCM-wrapped before sealing.
   */
  masterKeyB64?:  string;
  /**
   * When set, the envelope is an admin message (kind: 'admin'); body
   * MUST be empty. Admin payloads are never wrapped with the master
   * key — recipients learn the key from the embedded GroupState.
   */
  adminAction?:   GroupAdminAction;
}

/**
 * Build a minimal `GroupState` for the package's broadcastToGroup.
 *
 * The package only reads `groupId`, `members`, and `masterKeyB64`; the
 * other fields satisfy the type but don't affect the wire output.
 */
function synthesizeGroupState(p: OpsBroadcastParams): GroupState {
  const members: GroupState['members'] = {};
  for (const m of p.members) {
    members[m.userId] = {
      deviceId: DEFAULT_DEVICE_ID,
      admin:    m.role === 'admin',
      joinedAt: 0,
    };
  }
  return {
    groupId:      p.conversationId,
    name:         '',
    owner:        p.self.userId,
    members,
    masterKeyB64: p.masterKeyB64 ?? '',
    epoch:        0,
    createdAt:    0,
    updatedAt:    0,
  };
}

/**
 * Resolve the recipient's identity public key (base64) — preferring
 * the cached store, falling back to a fresh bundle fetch if the peer
 * has never been seen. Mirrors ops's pre-package behavior.
 */
async function resolveRecipientIdentityKeyB64(
  peer:  SessionAddress,
  store: CryptoStore,
): Promise<string> {
  const cached = await store.loadIdentityKey(`${peer.userId}.${peer.deviceId}`);
  if (cached) return toBase64(cached);
  const bundle = await keysApi.fetchBundle(peer.userId);
  return bundle.identityKey;
}

export async function broadcastToGroup(p: OpsBroadcastParams): Promise<BroadcastResult> {
  return packageBroadcastToGroup({
    group:       synthesizeGroupState(p),
    self:        p.self,
    cert:        p.cert,
    body:        p.adminAction ? '' : p.body,
    ttlSeconds:  p.ttlSeconds,
    session:     p.session,
    admin:       p.adminAction,
    /**
     * Establish a Signal session if we haven't talked to this peer
     * before. Without this, the package's session.encrypt throws
     * "No record for U.D" — there's no inline rebuild path.
     */
    ensureSession: async (peer) => {
      if (await p.session.hasSession(peer)) return;
      const bundle = await keysApi.fetchBundle(peer.userId);
      await p.session.initOutgoingSession({
        registrationId: bundle.registrationId,
        address:        peer,
        identityKey:    bundle.identityKey,
        signedPreKey: {
          keyId:     bundle.signedPrekeyId,
          publicKey: bundle.signedPrekey,
          signature: bundle.signedPrekeySig,
        },
        preKey: bundle.oneTimePrekey
          ? {keyId: bundle.oneTimePrekey.keyId, publicKey: bundle.oneTimePrekey.publicKey}
          : undefined,
      });
    },
    /**
     * The package hands us a per-recipient pairwise Ciphertext. We
     * wrap it in the Sealed Sender v2 outer ECIES envelope and POST
     * to the relay. Returning {envelopeId} lets the package collect
     * the relay's server-assigned ids into BroadcastResult.envelopeIds.
     */
    deliver: async (peer, ciphertext, clientMsgId) => {
      const recipientIdentityKeyB64 = await resolveRecipientIdentityKeyB64(peer, p.store);
      const outerSealed = await wrapOuter({
        recipientIdentityKeyB64,
        sender:     p.self,
        ciphertext,
        // Audit P0-1 (ops parity) — bind the sender cert into the outer
        // ECIES AAD so the wrap emits the v3 wire format, matching the
        // mobile sender. Without the cert this fell back to v2, whose
        // AAD covers only ephPub||recipientPub: the inner sender address
        // is unauthenticated, reopening the forged-outer-envelope →
        // DecryptError → session-wipe vector that v3 closes (a mobile
        // recipient pre-verifies the cert BEFORE decrypt only for v3).
        // `p.cert` is the same authority-signed cert already passed to
        // the package broadcast for inner sealing, so this is free.
        cert: p.cert,
      });
      const r = await relay.send(p.self.deviceId, {
        recipient:    peer,
        outerSealed,
        clientMsgId,
        expiresAtSec: p.ttlSeconds
          ? Math.floor(Date.now() / 1000) + p.ttlSeconds
          : undefined,
      });
      return {envelopeId: r.envelopeId};
    },
  });
}
