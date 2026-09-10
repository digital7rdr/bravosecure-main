import {sealPayload, type SealedPayload} from '../crypto/sealedSender';
import {toBase64, fromBase64} from '../crypto/encoding';
import {groupEncrypt, groupDecrypt, isGroupCiphertext} from '../crypto/groupCrypto';
import {sha256} from '@noble/hashes/sha2.js';
import {AsyncCurve25519Wrapper} from '@privacyresearch/curve25519-typescript';
import type {SessionManager} from '../crypto/sessionManager';
import type {Ciphertext, SessionAddress, UserId, GroupId} from '../crypto/types';
import type {
  GroupAdminAction,
  GroupMessageEnvelope,
  GroupState,
} from './types';

const curve = new AsyncCurve25519Wrapper();

/**
 * Audit fix #27 — discriminated-union return for parseGroupMessage so
 * callers can distinguish "no key yet" (recoverable; admin create may
 * be in flight) from "tamper" (drop hard, surface a security warning)
 * from "malformed" (drop, log).
 */
export type ParseGroupResult =
  | {ok: true;  envelope: GroupMessageEnvelope}
  | {ok: false; reason: 'no_key' | 'tamper' | 'malformed' | 'not_group'};

/**
 * Audit P1-G8 — per-member message auth beyond pairwise Signal session.
 *
 * Today: each group message is sealed N times (once per peer) over the
 * sender's pairwise Signal sessions. The sender's identity is proven
 * by the sealed-sender cert chain INSIDE each pairwise envelope. This
 * means a member CAN tell who sent any given message they received,
 * but two different members CANNOT compare an alleged transcript and
 * verify it's the same message that was sent to both of them — a
 * malicious sender could send {body: "ok"} to Alice and {body: "no"}
 * to Bob via two different envelopes, and each receiver's pairwise
 * verify would pass for their own copy.
 *
 * Signal's group protocol closes this with Sender Keys: a per-group
 * signing key the sender signs every payload with, so any pair of
 * members can compare the same opaque payload + signature and prove
 * they received the same bytes. Implementing Sender Keys is a separate
 * protocol layer (epoch-keyed sender key distribution, mid-key
 * rotation, ratchet integration); deferred as architecture work.
 *
 * The cross-receiver forgery surface today is bounded by the cert
 * chain (the malicious sender must hold a valid cert and burn an
 * outgoing ratchet message per receiver), so the practical attack is
 * "one user lies in a group of two" — high effort, low payoff. Worth
 * fixing for compliance/auditability but not P0 for v1 group messaging.
 *
 * Client-side group messaging over existing pairwise Signal sessions.
 *
 * Broadcast contract:
 *   - Caller supplies a cert (already fetched from SenderCertCache).
 *   - For each member OTHER than self, we produce one sealed Signal
 *     ciphertext and hand it to the provided `deliver` callback.
 *     Typical host wiring: deliver = runtime.submitViaRelay(...).
 *   - Each copy carries the same `clientMsgId` so recipients dedupe.
 *
 * Receiver contract:
 *   - Call handleIncoming(plaintextFromDecrypt) for each sealed
 *     message that arrives with group metadata set. Returns a parsed
 *     envelope + (for admin messages) the applied state update. Caller
 *     is responsible for persisting the updated state.
 *
 * No server awareness of groups is introduced. Anyone holding the
 * master key implicitly belongs to the group; member lists are never
 * transmitted outside of sealed admin messages.
 */

export interface BroadcastParams {
  group:        GroupState;
  self:         SessionAddress;
  cert:         string;
  body:         string;
  /** Present when broadcasting an admin action (create, add, etc). */
  admin?:       GroupAdminAction;
  /** Optional TTL for disappearing group messages. */
  ttlSeconds?:  number;
  session:      SessionManager;
  /**
   * Called once per recipient with the ready-to-submit ciphertext +
   * recipient address. The host's submitEnvelope / transport handles
   * the actual network call.
   *
   * If the host knows the server-assigned envelope id (e.g. the relay
   * returns it on accept), it MAY return `{envelopeId}` so the caller
   * can correlate read-receipts back to the broadcast. Hosts that
   * don't have that info just return `void`.
   */
  deliver: (
    recipient: SessionAddress,
    ciphertext: Ciphertext,
    clientMsgId: string,
  ) => Promise<void | {envelopeId?: string}>;
  /**
   * Optional pre-encrypt hook. Called once per recipient BEFORE
   * `session.encrypt`. Use this to ensure a Signal session record
   * exists for the peer (X3DH bundle fetch + initOutgoingSession).
   *
   * Without this, fresh installs / clear-data flows hit
   * `SessionRecordNotFoundException: No record for <userId>.<deviceId>`
   * the moment the loop tries to encrypt for a peer the local store
   * has never seen — there's no inline rebuild path inside libsignal.
   *
   * Failures here are propagated as recipient failures; we skip the
   * encrypt + deliver for that peer and continue with the rest.
   */
  ensureSession?: (recipient: SessionAddress) => Promise<void>;
  /**
   * Optional recipient allow-list. When present, only members whose
   * userId is in this set receive a fan-out copy — the `group.members`
   * map is still the full, real membership (so an `admin: create`
   * re-share carries the correct member list to the target), we just
   * restrict WHO we deliver to. Used by the self-heal re-share engine
   * to re-DELIVER the current key to a single returning member (or the
   * newly-added member) without re-broadcasting it to everyone. Omit it
   * for a normal full-group broadcast.
   */
  only?:        string[];
}

/**
 * Result of a group fan-out. `recipients` counts successful deliveries;
 * `envelopeIds` holds whatever ids the deliver callback returned (one per
 * successful recipient — empty array if the host doesn't return ids).
 * `failures` records per-recipient errors so the UI can surface partial
 * success without losing the original error.
 */
export interface BroadcastResult {
  clientMsgId: string;
  recipients:  number;
  envelopeIds: string[];
  failures:    Array<{userId: string; deviceId: number; error: string}>;
}

export async function broadcastToGroup(params: BroadcastParams): Promise<BroadcastResult> {
  const clientMsgId = genId();
  const kind: 'text' | 'admin' = params.admin ? 'admin' : 'text';
  const envelopeBody: GroupMessageEnvelope = {
    groupId:     params.group.groupId,
    kind,
    clientMsgId,
    body:        params.body,
  };
  if (params.admin) {envelopeBody.adminAction = params.admin;}
  const innerJson = JSON.stringify(envelopeBody);

  // Spec: group state and message bodies are encrypted with the
  // group master key. The exception is `admin: create` (and the
  // post-rekey first frame), where the recipient does not yet have
  // the new key — those go plaintext under the pairwise Signal
  // session, which is itself E2E. Anything else gets the AES-GCM
  // wrap so the relay (or a compromised pairwise key) can't read
  // the inner envelope without also possessing the group key.
  // `create` and `key-request` ship UNWRAPPED under the pairwise Signal
  // session: `create` because the recipient doesn't have the key yet
  // (it's learning it here), and `key-request` because the SENDER has no
  // key to wrap with (the whole point of the request). Both carry no
  // group-confidential body — `create`'s secret travels in the signed
  // state payload that only valid members can act on, and `key-request`
  // carries no secret at all.
  const skipGroupKey = params.admin?.type === 'create' || params.admin?.type === 'key-request';
  const sealedBody = skipGroupKey
    ? innerJson
    : JSON.stringify(await groupEncrypt(params.group.masterKeyB64, innerJson));
  const onlySet = params.only ? new Set(params.only) : null;

  const expiresAtSec = params.ttlSeconds
    ? Math.floor(Date.now() / 1000) + params.ttlSeconds
    : undefined;

  let count = 0;
  const envelopeIds: string[] = [];
  const failures: BroadcastResult['failures'] = [];
  const targets: Array<{userId: string; deviceId: number}> = [];
  for (const [userId, m] of Object.entries(params.group.members)) {
    if (userId === params.self.userId && m.deviceId === params.self.deviceId) {continue;}
    // Targeted re-share: skip members outside the allow-list (the full
    // membership still rides inside the `create` payload).
    if (onlySet && !onlySet.has(userId)) {continue;}
    targets.push({userId, deviceId: m.deviceId});
  }

  const sendOne = async (t: {userId: string; deviceId: number}): Promise<void> => {
    const {userId} = t;
    const peer: SessionAddress = {userId, deviceId: t.deviceId};
    // Establish a Signal session if the local store doesn't have one.
    // Critical for "create" admin and any first-message-after-restore
    // path — libsignal's encrypt() throws "No record for U.D" without
    // a session record, and unlike decrypt there's no auto-rebuild.
    if (params.ensureSession) {
      try {
        await params.ensureSession(peer);
      } catch (e) {
        const msg = (e as Error).message;
        console.warn(`[bravo.broadcastToGroup] ensureSession failed for ${userId}.${t.deviceId}: ${msg}`);
        failures.push({userId, deviceId: t.deviceId, error: msg});
        return;
      }
    }
    // Round 5 / Security S1 — bind THIS recipient + the broadcast
    // timestamp into the sealed envelope. Each fan-out copy gets its
    // own aad so a replay against a different recipient is detected.
    //
    // Audit P0-N2 (group parity) — also bind sender + conversation/group
    // + epoch. Previously only {to, ts} was stamped, so a receiver could
    // not detect a ciphertext spliced from another group/thread or
    // replayed under a superseded epoch (cross-group splice + stale-epoch
    // replay). These mirror the bindings the mobile 1:1/group sender
    // already stamps inline; receivers (mobile + ops) verify each field
    // only when present, so this is additive — older receivers ignore the
    // new fields, hardened receivers enforce them. `conversationId` is the
    // groupId for a group post (the receiver computes the same expected
    // value), keeping the wire AAD symmetric across platforms.
    const sealed = sealPayload(params.cert, sealedBody, {
      expiresAtSec,
      group: {groupId: params.group.groupId, kind, clientMsgId},
      aad: {
        to:             peer,
        ts:             Date.now(),
        sender:         params.self,
        conversationId: params.group.groupId,
        groupId:        params.group.groupId,
        // Only bind epoch when it's a real (>0) value. A synthesized
        // placeholder epoch of 0 (e.g. an ops broadcast that doesn't
        // track epoch yet) must NOT be stamped — a receiver that later
        // enforces `expectedEpoch` would otherwise reject it as
        // `epoch_stale`. Omitting the field keeps the check inert until
        // the sender actually carries a meaningful epoch.
        ...(params.group.epoch > 0 ? {epoch: params.group.epoch} : {}),
      },
    });
    let ct: Ciphertext;
    try {
      ct = await params.session.encrypt(peer, sealed);
    } catch (e) {
      const msg = (e as Error).message;
      console.warn(`[bravo.broadcastToGroup] encrypt failed for ${userId}.${t.deviceId}: ${msg}`);
      failures.push({userId, deviceId: t.deviceId, error: msg});
      return;
    }
    try {
      const out = await params.deliver(peer, ct, clientMsgId);
      count += 1;
      if (out && typeof out === 'object' && typeof out.envelopeId === 'string') {
        envelopeIds.push(out.envelopeId);
      }
    } catch (e) {
      const msg = (e as Error).message;
      console.warn(`[bravo.broadcastToGroup] deliver failed for ${userId}.${t.deviceId}: ${msg}`);
      failures.push({userId, deviceId: t.deviceId, error: msg});
    }
  };

  // GRP-26 — parallel fan-out. The sequential per-member await made a
  // group CREATE O(members × RTT); mirror the group-TEXT path
  // (productionRuntime Promise.allSettled) with a modest concurrency
  // chunk so a large roster doesn't open every session/upload at once.
  // Per-member error semantics are unchanged: sendOne never rejects
  // (each stage records its own failure), so `recipients` still counts
  // successful deliveries only and can legitimately be 0.
  const FANOUT_CONCURRENCY = 8;
  for (let i = 0; i < targets.length; i += FANOUT_CONCURRENCY) {
    await Promise.allSettled(targets.slice(i, i + FANOUT_CONCURRENCY).map(sendOne));
  }
  return {clientMsgId, recipients: count, envelopeIds, failures};
}

/**
 * Audit P0-G2 — rollout escape hatch for the legacy plaintext
 * acceptance path. Default is OFF (fail-closed): an authenticated peer
 * shipping a plaintext `kind:'text'` envelope is rejected as malformed
 * because production never produces them post-S2 (every text envelope
 * is master-key-wrapped under the group AES-GCM). Setting this flag to
 * `"true"` re-enables the pre-S2 behaviour for the rollout window.
 *
 * Follows the same S9/S10/P0-N1 pattern: opt-in via env, loud warn at
 * module load when set so the flag is visible in logs.
 */
const LEGACY_GROUP_PLAINTEXT = (typeof process !== 'undefined'
  && process.env?.EXPO_PUBLIC_LEGACY_GROUP_PLAINTEXT === 'true');

if (LEGACY_GROUP_PLAINTEXT) {

  console.warn(
    '[bravo.groupClient] EXPO_PUBLIC_LEGACY_GROUP_PLAINTEXT=true — ' +
    'accepting unencrypted kind:text group envelopes. This downgrades the ' +
    'group AES-GCM wrap; flip back to default once all senders ship master-' +
    'key-wrapped envelopes.',
  );
}

/**
 * Parse a decrypted sealed-payload plaintext into a group message
 * envelope. Caller has already verified the sender cert; this is
 * pure deserialization + admin-action validation.
 *
 * Audit fix #27 — return a discriminated union instead of `null` so
 * callers can distinguish recoverable failures (no master key yet —
 * just wait for the admin-create) from non-recoverable ones (tamper,
 * malformed body — drop and surface).
 *
 * Audit P0-G2 — plaintext `kind:'text'` envelopes are now REJECTED by
 * default. The pre-fix fall-through accepted any JSON shaped like a
 * group envelope, silently bypassing the master-key AES-GCM wrap.
 * Plaintext `kind:'admin'` envelopes are STILL accepted because admin
 * `create` is the bootstrap action — the recipient doesn't have the
 * master key yet and must learn it from a plaintext payload. The
 * applyAdminAction receiver still gates the admin payload via the
 * admin-only check + create-signature verify already in place.
 *
 * `masterKeyB64`: if the recipient knows the group master key, pass
 * it so the inner envelope can be decrypted. Admin `create` messages
 * are always plaintext (the recipient learns the key from them);
 * everything else is master-key-wrapped when produced by a master-
 * key-aware client.
 */
export async function parseGroupMessage(
  sealed: SealedPayload,
  masterKeyB64?: string,
): Promise<ParseGroupResult> {
  if (!sealed.group) {return {ok: false, reason: 'not_group'};}
  let inner: GroupMessageEnvelope | null = null;

  // Try master-key path first if the body looks like a group ciphertext.
  let outer: unknown = null;
  try { outer = JSON.parse(sealed.body); } catch { return {ok: false, reason: 'malformed'}; }

  if (isGroupCiphertext(outer) && masterKeyB64) {
    try {
      const plain = await groupDecrypt(masterKeyB64, outer);
      inner = JSON.parse(plain) as GroupMessageEnvelope;
    } catch {
      // Decrypt failed — usually a stale rekey'd payload arriving after
      // we've rotated the master key. The cert was valid; treat as
      // tamper-or-stale (UI surfaces "couldn't decrypt one message").
      return {ok: false, reason: 'tamper'};
    }
  } else if (isGroupCiphertext(outer) && !masterKeyB64) {
    // Encrypted but we don't have the key — admin create likely still
    // in flight. Recoverable; caller can stash the envelope to retry
    // after the next admin event.
    return {ok: false, reason: 'no_key'};
  } else {
    // Audit P0-G2 — plaintext fall-through. Admin envelopes are allowed
    // (bootstrap `create` ships plaintext by construction). Text
    // envelopes are REJECTED unless the legacy escape hatch is set.
    const sealedKind = sealed.group.kind;
    if (sealedKind === 'text' && !LEGACY_GROUP_PLAINTEXT) {
      return {ok: false, reason: 'malformed'};
    }
    inner = outer as GroupMessageEnvelope;
  }

  if (!inner) {return {ok: false, reason: 'malformed'};}
  // Consistency check — the metadata from seal() MUST match the inner
  // envelope. Divergence here means a tamper attempt: the sealed
  // metadata is bound to the cert but the inner body could have been
  // swapped by a malicious admin-tier process between encrypt and
  // sign (it can't, in practice, but we still defend in depth).
  if (inner.groupId   !== sealed.group.groupId)       {return {ok: false, reason: 'tamper'};}
  if (inner.kind      !== sealed.group.kind)          {return {ok: false, reason: 'tamper'};}
  if (inner.clientMsgId !== sealed.group.clientMsgId) {return {ok: false, reason: 'tamper'};}
  return {ok: true, envelope: inner};
}

/**
 * Apply an admin action to a GroupState. Returns the new state.
 * Only advances `epoch` if the action's `atEpoch` is the current
 * epoch — late/duplicated admin messages are ignored without error.
 *
 * Audit fix #26 — `senderUserId` is now required.
 *
 *   The previous signature accepted any admin action without checking
 *   who sent it. Cert-verified non-admin members could broadcast
 *   `add` / `remove` / `rekey` / `rename` envelopes and the receiver
 *   would apply them. The fix gates every action (except `create`,
 *   which by definition has no prior state to consult) on
 *   `state.members[senderUserId]?.admin === true`. Non-admin actions
 *   are silently dropped — we deliberately don't raise so a malicious
 *   peer can't probe for admin status.
 *
 *   Callers must thread the sender's userId through. The sender's
 *   identity comes from the verified sender cert in handleIncoming,
 *   so this is trustworthy server-side info.
 */
/**
 * Audit P1-G1 — canonical bytes used to extend `transcriptHash`.
 *
 * Each action contributes a deterministic byte-string keyed by type so
 * a missed action OR a swapped action between Alice and Bob produces a
 * divergent hash on the very next transition they share.
 */
function canonicalActionBytes(action: GroupAdminAction): Uint8Array {
  const enc = new TextEncoder();
  switch (action.type) {
    case 'create': {
      const memberIds = Object.keys(action.state.members).sort().join(',');
      return enc.encode(`create|${action.state.groupId}|${memberIds}|${action.state.masterKeyB64}|${action.state.epoch}`);
    }
    case 'add':    return enc.encode(`add|${action.atEpoch}|${action.member.userId}|${action.member.deviceId}`);
    case 'remove': return enc.encode(`remove|${action.atEpoch}|${action.userId}`);
    case 'rekey':  return enc.encode(`rekey|${action.atEpoch}|${action.newMasterKeyB64}`);
    case 'rename': return enc.encode(`rename|${action.atEpoch}|${action.name}`);
    // B-291 — every field that affects what a member DECRYPTS is signed:
    // objectKey, key and IV. Signing only the objectKey would let an attacker
    // who can replay a stale envelope swap in a different key for the same
    // object. `none` for a clear, so setting and clearing sign different bytes.
    case 'photo': return enc.encode(action.photo
      ? `photo|${action.atEpoch}|${action.photo.objectKey}|${action.photo.keyB64}|${action.photo.ivB64}|${action.photo.mimeType}`
      : `photo|${action.atEpoch}|none`);
    case 'leave':  return enc.encode(`leave|${action.atEpoch}`);
    // Self-heal control signal — never mutates state, so it never
    // actually extends the transcript chain; the case exists only for
    // switch exhaustiveness.
    case 'key-request': return enc.encode(`key-request|${action.groupId}|${action.atEpochSeen ?? ''}`);
  }
}

function extendTranscript(prev: string | undefined, action: GroupAdminAction): string {
  const seed = prev
    ? new Uint8Array(fromBase64(prev))
    : new TextEncoder().encode('BRAVO_GROUP_TRANSCRIPT_V1');
  const next = canonicalActionBytes(action);
  const buf = new Uint8Array(seed.byteLength + next.byteLength);
  buf.set(seed, 0);
  buf.set(next, seed.byteLength);
  const hash = sha256(buf);
  const ab = new ArrayBuffer(hash.byteLength);
  new Uint8Array(ab).set(hash);
  return toBase64(ab);
}

export function applyAdminAction(
  state: GroupState,
  action: GroupAdminAction,
  senderUserId: string,
): GroupState {
  const now = Date.now();
  // `create` is the bootstrap action — there's no prior state to consult.
  // We trust it because the surrounding handleIncoming already verified
  // the sender cert chain; whether the sender becomes admin is encoded
  // in `action.state.members[senderUserId].admin`.
  if (action.type === 'create') {
    // Audit P1-N13 — when the creator ships a salt, the receiver must
    // verify deriveGroupId(salt, members) === groupId before trusting
    // the bootstrap state. A mismatch means either a bug or an attacker
    // claiming an attacker-chosen groupId that nothing actually hashes
    // to; either way we refuse to install the row (return the prior
    // state unchanged). Salt-absent state is the legacy path and is
    // still accepted so pre-P1-N13 senders keep interop'ing.
    if (action.state.saltB64 && !verifyGroupIdDerivation(action.state)) {
      return state;
    }
    // Audit P1-G1 — seed the transcript chain from the create action.
    return {...action.state, transcriptHash: extendTranscript(undefined, action)};
  }
  // Self-heal — a `key-request` is a pure control signal: it asks the
  // owner to re-DELIVER the existing key, and the owner's receive handler
  // is the only thing that reacts to it. Here in the pure reducer it is an
  // INERT no-op so a stray, replayed, or forged request can NEVER change
  // membership, epoch, or the master key. Handled before the admin gate
  // because the requester is, by definition, a member who LOST the key
  // (it may not be an admin, and it must not be dropped as "non-admin").
  if (action.type === 'key-request') {
    return state;
  }
  // Audit P1-G4 — `leave` bypasses the admin-only gate because the
  // sender is acting on themself, not mutating anyone else's membership.
  // Authority check: the sender (from the verified cert) must currently
  // be a member; otherwise the action is meaningless and dropped.
  if (action.type === 'leave') {
    if (action.atEpoch !== state.epoch) {return state;}
    if (!state.members[senderUserId]) {return state;}
    const next = {...state.members};
    delete next[senderUserId];
    return {
      ...state,
      members: next,
      epoch: state.epoch + 1,
      updatedAt: now,
      transcriptHash: extendTranscript(state.transcriptHash, action),
    };
  }
  // For every other action, the sender must currently be a group admin.
  // Drop silently otherwise — a non-admin trying to mutate group state
  // is best treated as a no-op so they can't probe membership.
  const senderMember = state.members[senderUserId];
  if (!senderMember?.admin) {
    return state;
  }
  switch (action.type) {
    case 'add':
      if (action.atEpoch !== state.epoch) {return state;}
      return {
        ...state,
        members: {
          ...state.members,
          [action.member.userId]: {
            deviceId: action.member.deviceId,
            admin:    false,
            joinedAt: now,
          },
        },
        epoch:     state.epoch + 1,
        updatedAt: now,
        // Audit P1-G1 — chain the transcript.
        transcriptHash: extendTranscript(state.transcriptHash, action),
      };
    case 'remove': {
      if (action.atEpoch !== state.epoch) {return state;}
      const next = {...state.members};
      delete next[action.userId];
      return {
        ...state, members: next, epoch: state.epoch + 1, updatedAt: now,
        transcriptHash: extendTranscript(state.transcriptHash, action),
      };
    }
    case 'rekey':
      if (action.atEpoch !== state.epoch) {return state;}
      return {
        ...state,
        masterKeyB64: action.newMasterKeyB64,
        epoch:        state.epoch + 1,
        updatedAt:    now,
        transcriptHash: extendTranscript(state.transcriptHash, action),
      };
    case 'rename':
      if (action.atEpoch !== state.epoch) {return state;}
      return {
        ...state, name: action.name, epoch: state.epoch + 1, updatedAt: now,
        transcriptHash: extendTranscript(state.transcriptHash, action),
      };
    // B-291 — set or clear the group picture. Epoch-gated exactly like rename,
    // and like rename it does NOT touch masterKeyB64: membership is unchanged,
    // so the key still binds the same devices and forcing a redistribution for
    // a picture would risk a partial rekey for no security gain.
    case 'photo':
      if (action.atEpoch !== state.epoch) {return state;}
      return {
        ...state, photo: action.photo, epoch: state.epoch + 1, updatedAt: now,
        transcriptHash: extendTranscript(state.transcriptHash, action),
      };
    default: {
      // Exhaustiveness check — `leave` is handled above the admin gate
      // (see Audit P1-G4 block). Any future action that lands here
      // without an explicit case has slipped past both gates; surface
      // it as a no-op rather than a runtime throw so a forward-
      // compatibility rollout doesn't crash a legacy receiver.
      const _exhaust: never = action;
      void _exhaust;
      return state;
    }
  }
}

/**
 * Audit fix #25 — derive groupId deterministically.
 *
 *   The original `genId()` generated 16 random bytes per group, so
 *   two creators inviting the same set of members ended up with two
 *   distinct groupIds and the receivers saw two parallel
 *   conversations (each with one missing message half). Deriving the
 *   id from `sha256(salt || sortedMemberIds)` makes the same set of
 *   members produce the same id deterministically; the SECOND
 *   creator's admin-create envelope hits a receiver that already has
 *   the group state and triggers a "join existing" code path on the
 *   receiver side instead of creating a duplicate.
 *
 *   The `salt` parameter (16 random bytes provided by the initiator)
 *   keeps two LEGITIMATELY-distinct groups with identical membership
 *   distinguishable: a project channel and a side-thread between the
 *   same three people are separate groups, derived from different
 *   salts. The salt travels in the admin-create payload so receivers
 *   recompute the id and verify it matches the sender's choice.
 */
export function makeNewGroup(params: {
  name:    string;
  owner:   string;
  ownerDeviceId: number;
  members: Array<{userId: string; deviceId: number}>;
}): GroupState {
  const now = Date.now();
  const members: GroupState['members'] = {
    [params.owner]: {deviceId: params.ownerDeviceId, admin: true, joinedAt: now},
  };
  for (const m of params.members) {
    if (m.userId === params.owner) {continue;}
    members[m.userId] = {deviceId: m.deviceId, admin: false, joinedAt: now};
  }
  const salt = randomSalt();
  const groupId = deriveGroupId(salt, Object.keys(members));
  return {
    groupId,
    name:         params.name,
    owner:        params.owner,
    members,
    // Audit P1-N13 — ship the salt alongside the state so a receiver
    // applying `create` can run `verifyGroupIdDerivation` and reject
    // an admin-create that claims a groupId the salt+members don't
    // actually hash to.
    saltB64:      toBase64(salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer),
    masterKeyB64: genMasterKey(),
    epoch:        0,
    createdAt:    now,
    updatedAt:    now,
  };
}

/**
 * MISSION-GROUP (batch area 5) — bootstrap a group whose id is EXTERNALLY
 * ASSIGNED rather than salt-derived. The mission "Ops Room" conversation id
 * is minted server-side (a UUID), so the deriveGroupId(salt, members) scheme
 * `makeNewGroup` uses cannot reproduce it. We therefore take the id as given
 * and OMIT `saltB64`.
 *
 * Security: `saltB64` absent puts this on the same footing as the legacy
 * salt-absent path — `verifyGroupIdDerivation` returns true (it cannot check
 * a non-derived id), so authenticity rests entirely on `signGroupCreate`
 * (creator identity-key signature) + the sender-cert verification that
 * `handleIncoming` already enforces before `applyAdminAction('create')`, plus
 * the epoch-monotonicity guard in `applyAdminAction` (a replayed old `create`
 * for a group we already hold is rejected). The owner (agency device) mints
 * the master key; it is distributed only over pairwise Signal sessions in the
 * admin-create envelope, never to the server. Mirrors `makeNewGroup`'s shape
 * exactly apart from id source + salt omission.
 */
export function makeAssignedGroup(params: {
  groupId: string;
  name:    string;
  owner:   string;
  ownerDeviceId: number;
  members: Array<{userId: string; deviceId: number}>;
}): GroupState {
  const now = Date.now();
  const members: GroupState['members'] = {
    [params.owner]: {deviceId: params.ownerDeviceId, admin: true, joinedAt: now},
  };
  for (const m of params.members) {
    if (m.userId === params.owner) {continue;}
    members[m.userId] = {deviceId: m.deviceId, admin: false, joinedAt: now};
  }
  return {
    groupId:      params.groupId,
    name:         params.name,
    owner:        params.owner,
    members,
    // saltB64 deliberately omitted — externally-assigned id, not salt-derived.
    masterKeyB64: genMasterKey(),
    epoch:        0,
    createdAt:    now,
    updatedAt:    now,
  };
}

/**
 * Audit P1-N4 — is this userId a member of the group at the
 * current local epoch?
 *
 * Used by receivers to gate inbound `text` envelopes: a peer whose
 * cert chain verifies but who isn't in `state.members` is either a
 * removed member whose old envelope arrived late OR a peer racing
 * an admin event from a sender that hadn't applied the remove yet.
 * Either way, the message has no place in the group thread.
 *
 * Owner check is folded in: the owner appears in `members` with
 * `admin: true`, so they pass this gate. Members removed via the
 * `remove` admin action have already been deleted from `members`
 * by `applyAdminAction`.
 */
export function isGroupMember(
  state: Pick<GroupState, 'members'>,
  userId: string,
): boolean {
  return Boolean(state.members[userId]);
}

/**
 * Audit P1-N13 — verify the wire-supplied groupId really is
 * `deriveGroupId(salt, sortedMembers)`. Used by receivers when
 * applying an admin-create with a saltB64 attached.
 *
 * Back-compat: when saltB64 is absent (legacy state from before
 * P1-N13) the check is a no-op so existing rows still load. Once
 * every active sender ships the salt, callers can flip the absence
 * branch to a hard reject.
 */
export function verifyGroupIdDerivation(state: GroupState): boolean {
  if (!state.saltB64) {return true;}
  try {
    const salt = new Uint8Array(fromBase64(state.saltB64));
    return deriveGroupId(salt, Object.keys(state.members)) === state.groupId;
  } catch {
    return false;
  }
}

/**
 * Audit fix #25 — sha256(salt || sortedMemberIds.join(',')) hex
 * truncated to 32 chars (128 bits — collision-safe at our scale).
 *
 * Sorting member ids gives all participants the same canonical input
 * regardless of insertion order. The salt prefix makes collisions
 * across distinct groups with identical members impossible in
 * practice. The hex form is human-debuggable and matches the legacy
 * 32-char id format expected elsewhere.
 */
export function deriveGroupId(salt: Uint8Array, memberUserIds: UserId[]): GroupId {
  const sorted = [...memberUserIds].sort();
  const enc = new TextEncoder();
  const memberBytes = enc.encode(sorted.join(','));
  const buf = new Uint8Array(salt.byteLength + memberBytes.byteLength);
  buf.set(salt, 0);
  buf.set(memberBytes, salt.byteLength);
  const hash = sha256(buf);
  let out = '';
  for (let i = 0; i < 16; i++) {out += hash[i].toString(16).padStart(2, '0');}
  return out;
}

function randomSalt(): Uint8Array {
  const s = new Uint8Array(16);
  crypto.getRandomValues(s);
  return s;
}

function genId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

function genMasterKey(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return toBase64(b.buffer);
}

/**
 * Round 5 / Security S2 — public form of `genMasterKey` so the runtime
 * can mint a fresh group master key when chaining a rekey after a
 * member removal. Same primitive as `makeNewGroup` uses internally;
 * exported separately so callers don't have to construct a whole
 * GroupState just to roll a key.
 */
export function genFreshGroupMasterKey(): string {
  return genMasterKey();
}

/**
 * Round 5 / Security S2 — atomic "remove + rekey" planner.
 *
 *   When a member is removed from a group, the OLD master key is still
 *   on the removed member's device. Without a rekey, every subsequent
 *   group message the remaining members send is still encrypted under
 *   that key — so the removed member can read messages that were sent
 *   AFTER they left, simply by passively listening to the relay. (The
 *   admin gate prevents them from MUTATING state; it does not stop them
 *   from reading.)
 *
 *   This helper returns the two-step plan the caller must broadcast in
 *   order:
 *
 *     1. `remove`  → at the current epoch (E)
 *     2. `rekey`   → at the post-remove epoch (E+1) with a freshly-
 *                    generated 32-byte master key
 *
 *   Recipients applying the plan land at epoch E+2 with `masterKeyB64`
 *   replaced. The removed member receives copy 1 (the remove envelope)
 *   and sees they were ousted. WHY THEY NEVER GET THE NEW KEY (AUDIT #1
 *   review corrected this — the old claim "the rekey body is wrapped
 *   under the NEW key" was wrong): the rekey envelope is wrapped under
 *   the OLD key, and the protection is the FAN-OUT SET — the runtime
 *   broadcasts step 2 against the post-remove state, so no pairwise
 *   copy is ever minted for the removed member. Now that the key is
 *   unpredictable (fresh-random), that fan-out exclusion is the ONLY
 *   thing between the removed member and the new key — do not weaken
 *   it. (The remaining members' `parseGroupMessage` masterKey lookup
 *   uses their LOCAL state which has been advanced by step 1, so they
 *   decrypt fine.)
 *
 *   IMPORTANT: the caller MUST broadcast the two actions IN ORDER and
 *   wait for step 1's fan-out to complete before sending step 2. If
 *   step 2 is sent first/concurrently the remaining members won't be
 *   able to decrypt it — their LOCAL state still has the old master
 *   key when they try to unwrap the rekey body.
 */
export function planRemoveAndRekey(state: GroupState, removedUserId: UserId): {
  remove: Extract<GroupAdminAction, {type: 'remove'}>;
  rekey:  Extract<GroupAdminAction, {type: 'rekey'}>;
  newMasterKeyB64: string;
} {
  if (!state.members[removedUserId]) {
    throw new Error(`planRemoveAndRekey: ${removedUserId} not in group ${state.groupId}`);
  }
  // AUDIT-2026-08-13 #1 (P0 — supersedes P0-G3's deterministic derivation,
  // founder-approved 2026-08-14) — the new key must contain entropy the
  // REMOVED member does not hold. P0-G3's KDF(prevKey ‖ removedIds ‖
  // postEpoch) meant the removed member — who HOLDS prevKey and can see
  // the public inputs — could compute the new key and chain forward
  // through every later deterministic rekey: rotation was
  // cryptographically ineffective against exactly the party it names
  // (exposed surfaces: group-call media keys = HKDF(masterKey), sealed
  // archives, group photo keys). Fresh randomness restores the
  // architecture contract ("forward secrecy at epoch boundaries"), and
  // the receiver side needs NO change: `applyAdminAction` ADOPTS the
  // carried `newMasterKeyB64`, it never re-derives.
  //
  // The fork P0-G3 solved is now held by the OTHER belts: the
  // leave-auto-rekey has ONE designated sender (applyGroupAdmin), and a
  // same-member race (two admins removing X, or X leaving WHILE being
  // removed — the latter was convergent under P0-G3 and diverges now)
  // no-ops its loser at the epoch guard for same-order receivers. A
  // genuine CROSS-ORDER fork is repaired by the key-request/reshare
  // lane with a CRYPTOGRAPHIC tiebreak (edge, traced + probed): only
  // the OWNER's reshare carries a fresh signGroupCreate over the
  // current state; a non-owner reshare relays a creatorSig minted over
  // PRE-rekey state (the signed bytes cover masterKeyB64 AND epoch) and
  // fails verification — so exactly one key can install at a contested
  // epoch and the heal cannot oscillate. PRECONDITION, recorded: the
  // heal is therefore OWNER-ONLY — an offline owner delays it for their
  // offline window, and a DEPARTED owner (leaveGroup has no ownership
  // transfer) makes a fork permanent until owner re-attestation ships
  // (tracked in REMAINING_TODO). Forked-window messages under the LOSING
  // key stay stashed on the winning side (never rendered, never lost);
  // the sender still sees delivered ticks.
  const newMasterKeyB64 = genFreshGroupMasterKey();
  return {
    remove: {type: 'remove', userId: removedUserId, atEpoch: state.epoch},
    rekey:  {type: 'rekey',  newMasterKeyB64, atEpoch: state.epoch + 1},
    newMasterKeyB64,
  };
}

/**
 * ⛔ DEPRECATED — AUDIT-2026-08-13 #1 (P0): DO NOT use for rekey.
 * "Same inputs always produce the same output" is exactly the flaw: the
 * REMOVED member holds `prevMasterKeyB64` and can see the public inputs,
 * so they can compute the output — and chain through every later
 * deterministic rekey. No production caller remains (all planners use
 * `genFreshGroupMasterKey()`); kept exported ONLY so the regression test
 * can pin that the attack no longer predicts planner output. A new
 * caller of this function for key rotation is a P0 regression.
 *
 * (Historical rationale, superseded:)
 * Audit P0-G3 — deterministic master-key derivation for rekey after a
 * membership change. Same inputs always produce the same output, so two
 * admins racing the same membership change converge on the same key.
 *
 * Construction:
 *   sha256(
 *     "BRAVO_GROUP_REKEY_V1\n" ||
 *     prevMasterKeyB64 || "\n" ||
 *     sortedRemovedMemberIds.join(',') || "\n" ||
 *     postEpoch
 *   )
 *
 * Domain separator pins the meaning so the output can't be confused with
 * any other Bravo group hash (`BRAVO_GROUP_CREATE_V1`, etc.). The prev
 * master key is a 32-byte secret known only to current members, so a
 * non-member observing the wire (groupId + epoch are public-ish) cannot
 * brute-force the new key. The output is base64-encoded so it slots
 * straight into `masterKeyB64`.
 *
 * Exported for use by sibling planners that also need convergent rekey
 * behaviour (P1-G4 leave+rekey is one example).
 */
export function deriveRekeyMasterKey(p: {
  prevMasterKeyB64: string;
  removedMemberIds: string[];
  postEpoch: number;
}): string {
  const sorted = [...p.removedMemberIds].sort();
  const canonical = [
    'BRAVO_GROUP_REKEY_V1',
    p.prevMasterKeyB64,
    sorted.join(','),
    String(p.postEpoch),
  ].join('\n');
  const digest = sha256(new TextEncoder().encode(canonical));
  const ab = new ArrayBuffer(digest.byteLength);
  new Uint8Array(ab).set(digest);
  return toBase64(ab);
}

/**
 * Audit P0-G3 — atomic "add + rekey" planner (forward-secrecy on add).
 *
 *   A bare `add` action lets the new member onto the group at the
 *   CURRENT epoch with the CURRENT master key. From the moment they
 *   join, every envelope still sitting on the relay (≤ 30 day dwell)
 *   AND every sealed-archive row written under the current key (≤ 90
 *   day TTL) becomes decryptable by the new member — they hold the
 *   only key required.
 *
 *   This violates Signal-spec forward secrecy for group history:
 *   "the new member should be able to read messages sent AFTER they
 *   joined, not before." Without an immediate rekey, that property is
 *   broken by construction; a malicious admin could even add a
 *   surveillance account specifically to harvest queued/archived
 *   ciphertext.
 *
 *   Plan (mirrors `planRemoveAndRekey`):
 *
 *     1. `add`   → at the current epoch (E). New member joins the
 *                  membership set; epoch advances to E+1; master key
 *                  unchanged (the new member can apply this and
 *                  derive the same state as everyone else).
 *     2. `rekey` → at the post-add epoch (E+1) with a freshly-
 *                  generated 32-byte master key.
 *
 *   Recipients (including the newly-added member) land at epoch E+2
 *   with `masterKeyB64` replaced. From this point forward the new
 *   member CAN decrypt; the previous key is rotated out and dropped
 *   from cache via the P0-G2 dispose path on receive.
 *
 *   HOW THE NEW MEMBER ACTUALLY GETS KEYED (RC1 — this header's original
 *   step-2 contract was FALSE): both the `add` and `rekey` envelopes are
 *   master-key-wrapped, and the new member holds NO prior key, so they
 *   can decrypt NEITHER. The runtime (addGroupMember, RC1 fix) delivers
 *   the POST-rekey state to the new member as an unwrapped, signed
 *   `admin: create` over their pairwise session — the one carrier a
 *   keyless member can read. Join-forward-secrecy therefore HOLDS in the
 *   live path: the new member receives the NEW key only and can decrypt
 *   nothing from before they joined (old-key relay/archive rows stay
 *   unreadable to them).
 *
 *   IMPORTANT — same broadcast-ordering rule as `planRemoveAndRekey`:
 *
 *     - Step 1 (`add`) fans out to the POST-add member set (existing
 *       members + new member). The new member's session must already
 *       exist (caller is responsible for X3DH bring-up before invoking
 *       the planner).
 *     - Step 2 (`rekey`) fans out to the SAME POST-add member set,
 *       encrypted under the OLD master key (still active locally at
 *       this point). All recipients including the new member can
 *       unwrap it because they all hold the OLD key at receive time.
 *     - Caller MUST wait for step 1 fan-out to acknowledge before
 *       sending step 2. Sending them out of order leaves the new
 *       member unable to apply the rekey (their LOCAL state still
 *       missing the membership update means the action's `atEpoch`
 *       won't match and `applyAdminAction` silently no-ops).
 *
 *   The runtime wrapper (productionRuntime.addAndRekey) is the only
 *   sanctioned caller for the two-step broadcast; do not invent
 *   shortcut paths that skip the rekey.
 */
/**
 * Audit P1-G4 — voluntary "leave + rekey" planner.
 *
 *   Mirror of `planRemoveAndRekey` for the case where the user is
 *   exiting on their own initiative (not being kicked by an admin).
 *   The `leave` admin action removes the SENDER from membership at the
 *   current epoch; the chained `rekey` rotates the master key under the
 *   post-leave member set. HONEST SCOPE (AUDIT #1 review — the first
 *   sentence here used to claim old-key ciphertext "remains decryptable
 *   only by the still-current members", contradicting its own
 *   parenthetical): PRE-leave ciphertext (relay dwell ≤30d, sealed
 *   archives ≤90d, photo keys) is encrypted under the OLD key, which
 *   the leaver DOES hold — that access is irrevocable by design. The
 *   rotation protects POST-leave traffic only. NOTE also that this
 *   planner's rekey half is currently DEAD CODE: leaveGroup broadcasts
 *   only `plan.leave` (the leaver cannot authorize a rekey — the
 *   reducer drops post-leave admin actions from a non-member) and the
 *   DESIGNATED-admin auto-rekey (G-03) does the actual rotation.
 *
 *   IMPORTANT: this is best-effort against a cooperative leaver. A
 *   malicious leaver can keep the OLD master key around indefinitely
 *   and read any pre-leave ciphertext they captured. The defence is
 *   the same as `remove` in that respect — both rely on "after the
 *   rotation, only the remaining members hold the new key." The
 *   leaver's PRE-leave access is irrevocable by construction; the
 *   chained rekey just stops them from also reading POST-leave
 *   ciphertext that happens to still be encrypted under the old key
 *   when they receive their own leave envelope.
 */
export function planLeaveAndRekey(state: GroupState, leavingUserId: string): {
  leave:  Extract<GroupAdminAction, {type: 'leave'}>;
  rekey:  Extract<GroupAdminAction, {type: 'rekey'}>;
  newMasterKeyB64: string;
} {
  if (!state.members[leavingUserId]) {
    throw new Error(`planLeaveAndRekey: ${leavingUserId} not in group ${state.groupId}`);
  }
  // AUDIT #1 — fresh randomness; the LEAVER holds the previous key, so a
  // derived key was computable by them (see planRemoveAndRekey's block).
  const newMasterKeyB64 = genFreshGroupMasterKey();
  return {
    leave:  {type: 'leave',  atEpoch: state.epoch},
    rekey:  {type: 'rekey',  newMasterKeyB64, atEpoch: state.epoch + 1},
    newMasterKeyB64,
  };
}

export function planAddAndRekey(
  state: GroupState,
  newMember: {userId: string; deviceId: number},
): {
  add:    Extract<GroupAdminAction, {type: 'add'}>;
  rekey:  Extract<GroupAdminAction, {type: 'rekey'}>;
  newMasterKeyB64: string;
} {
  if (state.members[newMember.userId]) {
    throw new Error(`planAddAndRekey: ${newMember.userId} already in group ${state.groupId}`);
  }
  if (!newMember.userId || !(newMember.deviceId >= 1)) {
    throw new Error('planAddAndRekey: invalid newMember (userId required, deviceId >= 1)');
  }
  // AUDIT #1 — fresh randomness (supersedes the F2 deterministic mirror).
  // A derived key here still chained: any PAST member who held prevKey
  // could compute every future key through this hop too — and since RC1
  // the new member receives the POST-rekey state only (see the header),
  // so an unpredictable key is what makes their join boundary real. See
  // planRemoveAndRekey's block for the fork-belt analysis.
  const newMasterKeyB64 = genFreshGroupMasterKey();
  return {
    add:    {type: 'add',    member: newMember,           atEpoch: state.epoch},
    rekey:  {type: 'rekey',  newMasterKeyB64,             atEpoch: state.epoch + 1},
    newMasterKeyB64,
  };
}

/**
 * Round 5 / Security S4 — canonical bytes the creator signs to bind
 * the create envelope to their identity.
 *
 *   sha256(
 *     "BRAVO_GROUP_CREATE_V1\n" ||
 *     groupId ||  "\n" ||
 *     sortedMemberUserIds.join(',') || "\n" ||
 *     masterKeyB64 || "\n" ||
 *     epoch
 *   )
 *
 * Why hash the inputs first instead of feeding the whole canonical
 * string straight into XEd25519: keeps the signed message size constant
 * (32 bytes, the sha256 digest) regardless of group size, and makes the
 * sign/verify cost independent of member count. The threat model is
 * about authentication, not collision resistance — sha256 is more than
 * strong enough.
 *
 * The "BRAVO_GROUP_CREATE_V1" domain separator prevents an attacker
 * who has captured a sender's signature on some OTHER message (e.g.
 * a future feature that signs different bytes with the same key) from
 * substituting it as a group-create signature.
 */
export function canonicalCreateBytes(state: GroupState): Uint8Array {
  const sortedMembers = Object.keys(state.members).sort();
  const canonical = [
    'BRAVO_GROUP_CREATE_V1',
    state.groupId,
    sortedMembers.join(','),
    state.masterKeyB64,
    String(state.epoch),
  ].join('\n');
  const enc = new TextEncoder();
  return sha256(enc.encode(canonical));
}

/**
 * Round 5 / Security S4 — sign the canonical create-bytes with the
 * caller's identity priv key. Used inside the runtime's
 * `createGroupChat` to stamp the admin-create envelope.
 */
export async function signGroupCreate(
  identityPrivKey: ArrayBuffer,
  state: GroupState,
): Promise<string> {
  const digest = canonicalCreateBytes(state);
  const digestAb = new ArrayBuffer(digest.byteLength);
  new Uint8Array(digestAb).set(digest);
  const sig = await curve.sign(identityPrivKey, digestAb);
  return toBase64(sig);
}

/**
 * Round 5 / Security S4 — verify the creatorSignature against the
 * sender's identity public key (already obtained from the validated
 * sender cert). Returns the discriminated union shape so callers can
 * distinguish:
 *
 *   ok        — signature valid, accept the create
 *   missing   — no signature on the wire (legacy v1 sender). Caller
 *               decides whether to accept under the rollout policy.
 *   bad       — signature present but does not verify. Drop the
 *               envelope; this is a forge attempt.
 *   malformed — signature shape wrong (not 64 bytes). Drop.
 */
export async function verifyGroupCreateSignature(p: {
  state:                  GroupState;
  senderIdentityKeyB64:   string;
  creatorSignature?:      string;
}): Promise<{ok: true} | {ok: false; reason: 'missing' | 'bad' | 'malformed'}> {
  if (!p.creatorSignature) {return {ok: false, reason: 'missing'};}
  let sigBytes: Uint8Array;
  try { sigBytes = new Uint8Array(fromBase64(p.creatorSignature)); }
  catch { return {ok: false, reason: 'malformed'}; }
  if (sigBytes.byteLength !== 64) {return {ok: false, reason: 'malformed'};}

  const digest = canonicalCreateBytes(p.state);
  const digestAb = new ArrayBuffer(digest.byteLength);
  new Uint8Array(digestAb).set(digest);

  const sigAb = new ArrayBuffer(sigBytes.byteLength);
  new Uint8Array(sigAb).set(sigBytes);

  // libsignal's identity public keys are 33 bytes on the wire — a
  // leading 0x05 DJB type byte followed by the raw 32-byte curve25519
  // pubkey. The signing primitive (AsyncCurve25519Wrapper) operates on
  // raw 32-byte keys, so we strip the type byte if present. Senders
  // that hand-roll the pubkey can pass the raw 32-byte form too.
  const pubBytes = new Uint8Array(fromBase64(p.senderIdentityKeyB64));
  let rawPub: Uint8Array;
  if (pubBytes.byteLength === 33 && pubBytes[0] === 0x05) {
    rawPub = pubBytes.subarray(1);
  } else if (pubBytes.byteLength === 32) {
    rawPub = pubBytes;
  } else {
    return {ok: false, reason: 'malformed'};
  }
  const pubAb = new ArrayBuffer(rawPub.byteLength);
  new Uint8Array(pubAb).set(rawPub);

  // AsyncCurve25519Wrapper.verify returns truthy on INVALID and falsy
  // on VALID — same convention used in senderCert verifyXEd25519Signature.
  const result = await curve.verify(pubAb, digestAb, sigAb);
  return result ? {ok: false, reason: 'bad'} : {ok: true};
}

// Silence TS about the imported-but-unused type — consumers of the
// group module commonly want it.
void ({} as SealedPayload);
