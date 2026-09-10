import type {SessionAddress} from '../crypto/types';

/**
 * Client-side group state. The server has ZERO group-awareness —
 * broadcast is realized as N pairwise sealed envelopes, and the
 * group's membership / admin roles live only in this local structure.
 *
 * The master key is a symmetric secret shared by all members. In
 * Phase 1 we don't actually USE it for anything beyond its presence
 * signalling membership — the per-message Signal sessions already
 * provide confidentiality. Phase 2 could switch to Sender Keys
 * (Signal's group protocol) for O(1) broadcast; until then we keep
 * the master key around so that path can slot in without a protocol
 * break.
 */
/**
 * B-291 — reference to the group's encrypted picture.
 *
 * Field-for-field the shape `MediaClient.uploadEncrypted` already returns, so
 * the group picture is stored, fetched and decrypted by exactly the same code
 * path as a chat photo attachment. No new crypto, no new storage.
 */
export interface GroupPhotoRef {
  /** Object-store key of the CIPHERTEXT. Useless without the key below. */
  objectKey: string;
  /** Base64 32-byte AES-256 key, unique to this file. */
  keyB64:    string;
  /** Base64 16-byte IV. */
  ivB64:     string;
  mimeType:  string;
  /** Bytes of ciphertext, for cache accounting. */
  size:      number;
  /** Epoch ms the picture was set — lets a client show the newest of two. */
  updatedAt: number;
}

export interface GroupState {
  /** UUID. Stable for the lifetime of the group. */
  groupId:   string;
  /** Human-readable name — never sent to the server in plaintext. */
  name:      string;
  /**
   * B-291 — group picture, as a reference to an encrypted object.
   *
   * OPTIONAL and additive: every persisted group state and backup mirror
   * written before this field existed decodes unchanged, and a client that
   * predates it ignores the field.
   *
   * The image itself is AES-256-CBC encrypted with a unique per-file key
   * (`MediaClient.uploadEncrypted`, the same path every chat attachment takes)
   * and stored in the same object store. ONLY this reference travels in group
   * state, so the decryption key reaches members exactly the way the master key
   * does — inside a signed admin action, over pairwise Signal sessions.
   *
   * Why not the plaintext `avatarUrl` pattern that USER profiles use: the group
   * name is deliberately "never sent to the server in plaintext" (above), and a
   * plaintext group picture would tell the relay what a group looks like. That
   * would weaken the model, so it is not done.
   */
  photo?:    GroupPhotoRef | null;
  /** Owner's userId. Owner has admin rights. */
  owner:     string;
  /** Members (incl. owner). Keyed by userId; value carries the Signal device id. */
  members:   Record<string, {deviceId: number; admin: boolean; joinedAt: number}>;
  /** Base64-encoded 32-byte symmetric key. Rotated on membership change. */
  masterKeyB64: string;
  /** Monotonic counter — bumped on every admin event so peers can order them. */
  epoch:     number;
  createdAt: number;
  updatedAt: number;
  /**
   * Audit P1-G1 — chained transcript hash of every applied admin action.
   *
   * Recursive definition:
   *   transcriptHash@E0 = sha256("BRAVO_GROUP_TRANSCRIPT_V1" || canonical(create))
   *   transcriptHash@En = sha256(transcriptHash@E(n-1) || canonical(action_n))
   *
   * Each member computes this locally as they apply admin actions. A
   * desync (e.g. one member missed `remove`, applied `rekey @ E+2`)
   * surfaces as a transcript divergence on the NEXT admin action they
   * exchange — receiver crash-logs the mismatch with both sides'
   * hashes. Without this, a malicious or buggy server could fork
   * membership (send Alice {add Bob} but Carol {add Eve}) and both
   * branches would continue to operate without detection because each
   * receiver only sees its own envelopes.
   *
   * Optional on the wire for back-compat: legacy v0 state rows have no
   * hash; receivers tolerate absent-vs-absent. Once both sides have
   * computed at least one transition, the hash anchors all subsequent
   * comparisons.
   */
  transcriptHash?: string;
  /**
   * Audit G-05 (2026-07-02): the OWNER's `creatorSignature` over THIS state's
   * canonical create-bytes (groupId, members, masterKeyB64, epoch), persisted
   * by receivers so ANY member can RELAY the owner-signed create to a keyless
   * peer when the owner is offline. The receiver verifies it against the
   * OWNER's identity key, so a member can only relay a genuine signature —
   * never forge one. NOT part of canonicalCreateBytes (it signs a fixed
   * subset), so storing it here never affects signature verification; and
   * because the signature covers (key, epoch), a stale sig from before a rekey
   * simply fails to verify and the relay harmlessly no-ops.
   */
  creatorSigB64?: string;
  /**
   * Audit P1-N13 — base64 salt used by `deriveGroupId`. Originally
   * `makeNewGroup` generated 16 random bytes locally, computed
   * `sha256(salt || sortedMembers)`, and threw the salt away —
   * receivers had no way to recompute the id and therefore couldn't
   * tell a legitimate creator from someone substituting an arbitrary
   * id string. We now ship the salt on the `create` admin action and
   * inside the persisted state so any receiver can verify
   * `deriveGroupId(salt, members) === groupId`.
   *
   * Optional during the rollout window so legacy state rows (no salt
   * persisted) continue to load; missing salt skips the
   * re-derivation check rather than rejecting the row.
   */
  saltB64?: string;
}

/**
 * The payload of a `kind: 'admin'` group message. Recipients apply
 * these to their local group state before rendering downstream
 * `kind: 'text'` messages.
 *
 * Round 5 / Security S4 — `create` carries an optional
 * `creatorSignature` (base64 XEd25519 sig) over the canonical bytes
 * of `groupId || sortedMembers || masterKey || epoch`. Recipients
 * verify the signature against the cert's `senderIdentityKey`. This
 * detects a cert-leak-then-substitute attack: if an attacker steals
 * a cert and tries to ship a `create` envelope with a substituted
 * member list (or master key) under the same cert, the signature
 * verification fails because they don't hold the corresponding
 * identity priv key. Optional during the rollout window so legacy
 * v1 admin-create envelopes (pre-S4) still interop; receivers
 * downgrade trust on missing signatures (logged warning).
 */
export type GroupAdminAction =
  | {type: 'create';   state: GroupState; creatorSignature?: string}
  | {type: 'add';      member: {userId: string; deviceId: number}; atEpoch: number}
  | {type: 'remove';   userId: string; atEpoch: number}
  | {type: 'rekey';    newMasterKeyB64: string; atEpoch: number}
  | {type: 'rename';   name: string; atEpoch: number}
  /**
   * B-291 — set or clear the group picture. `photo: null` removes it.
   *
   * Like `rename`, this carries NO rekey: membership is unchanged, so the master
   * key still binds exactly the same devices.
   *
   * Forward compatibility is by design here — `applyAdminAction`'s `default:`
   * branch treats an unknown action as a no-op rather than throwing, precisely
   * so a client that predates this action ignores it instead of crashing.
   */
  | {type: 'photo';    photo: GroupPhotoRef | null; atEpoch: number}
  /**
   * Audit P1-G4 — voluntary member exit.
   *
   * Distinguished from `remove` (which is admin-only): `leave` is signed
   * by the departing member's own cert, so the receiver's admin-gate
   * (see applyAdminAction) is bypassed when sender === self-leaving.
   * Carries no member field — the departing user is the sender, taken
   * from the verified cert at receive time. Recipients drop the user
   * from `members` and advance epoch. The caller MUST chain a rekey
   * after broadcast (planLeaveAndRekey) so the leaver can't keep
   * reading post-exit messages from queued/archived ciphertext.
   */
  | {type: 'leave';    atEpoch: number}
  /**
   * Self-heal — member→admin group-key re-share request.
   *
   * Sent by a member that holds the group conversation but has NO (or a
   * stale/forked) master key — typically after a logout/reinstall wiped
   * its keychain + SQLCipher, or because it was offline/unprovisioned
   * during the original `create`/`add` fan-out so it never received the
   * unwrapped key carrier. The request carries NO key material — only the
   * `groupId` it needs and, optionally, the highest epoch it last held so
   * the owner can decide whether a re-share is even useful.
   *
   * It is NOT master-key-wrapped (the requester has no key to wrap with),
   * so `broadcastToGroup` ships it plaintext under the pairwise Signal
   * session exactly like `create`. `applyAdminAction` treats it as an
   * INERT no-op — it never mutates membership/epoch/key. The owner's
   * receive handler is the only thing that reacts to it, by re-DELIVERING
   * the CURRENT key (no epoch bump) to the verified requester, roster-
   * gated to current members and rate-limited so a malicious/looping
   * member can't amplify it into a rekey storm.
   */
  | {type: 'key-request'; groupId: string; atEpochSeen?: number};

export interface GroupMessageEnvelope {
  groupId:     string;
  kind:        'text' | 'admin';
  clientMsgId: string;
  body:        string;
  /** Present only for admin messages — JSON.stringified GroupAdminAction. */
  adminAction?: GroupAdminAction;
}

export interface GroupMemberAddress {
  userId:   string;
  deviceId: number;
}

export function memberToAddress(m: {userId: string; deviceId: number}): SessionAddress {
  return {userId: m.userId, deviceId: m.deviceId};
}
