/**
 * B-127 — the decision half of the inbound group `create` handler, extracted so
 * it is unit-testable. `productionRuntime.ts` cannot be imported in jest, and
 * this branch installs group key material, so its rules must be provable rather
 * than mirrored (see B-129 for what mirrors cost).
 *
 * THE BUG THIS CLOSES
 * The create branch read its local state from `store.groups[wireGroupId]` while
 * the install writes `store.groups[action.state.groupId]` — two different wire
 * fields. An attacker set the wire id to any unused value, so `existing` came
 * back undefined, every guard was skipped, and a self-signed create overwrote a
 * victim group's owner, roster and master key. No epoch inflation was needed.
 * The caller therefore MUST resolve `existing` by `state.groupId` and pass it
 * here; `wireGroupId` is carried only so a mismatch can be reported.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * - It never reads `state.name`. `canonicalCreateBytes` signs only
 *   (groupId, sorted members, masterKeyB64, epoch), so `name` is unsigned,
 *   attacker-chosen text. Exempting on the wire name would let an attacker opt
 *   out of the whole gate by typing 'Call' — and would make the hijack quieter,
 *   because the inbox-row upsert is skipped for 'Call' groups too. Every
 *   call-carrier exemption below is a LOCAL fact.
 * - It never rejects on `wireGroupId !== state.groupId`. That is reported as a
 *   warning only: a planned change to the call-key resync deliberately splits
 *   those two fields, and a hard drop there would kill every re-escalated call
 *   at the joiner's 25s key gate.
 * - It never calls `verifyGroupIdDerivation`. Alias states keep the original
 *   mint's salt while carrying a different groupId, and assigned Ops Rooms
 *   carry no salt at all, so derivation is not a valid signal here.
 *
 * SCOPE — this shuts the OVERWRITE door only. When the local slot holds no
 * master key the gate is inert by design (the B-41 keyless bootstrap depends on
 * that), so an attacker who reaches a device BEFORE it holds the group's key can
 * still poison the slot pre-emptively. That residual is tracked as B-127b and
 * needs an architecture decision, because fixing it means persisting an epoch
 * floor or a bootstrap marker on GroupState — a SQLCipher-mirrored,
 * backup-replicated shape.
 */

import {isDeviceLocalGroupId, isCallGroupState} from './messagingLogic';

export interface CreateGateStateLike {
  groupId:      string;
  owner:        string;
  name?:        string;
  epoch:        number;
  masterKeyB64: string;
}

export interface CreateGateExistingLike {
  owner:        string;
  name?:        string;
  epoch:        number;
  masterKeyB64: string;
}

export interface CreateGateInput {
  /** `unwrapped.group.groupId` — the routing id. Reported on, never trusted. */
  wireGroupId: string;
  /** The signed create payload. */
  state: CreateGateStateLike;
  /** Local state resolved by `state.groupId` — NOT by `wireGroupId`. */
  existing?: CreateGateExistingLike;
  /** Owner signature verified against the sender's identity key. */
  signatureOk: boolean;
  /** Signature absent entirely (legacy sender) rather than present-and-bad. */
  signatureMissing: boolean;
  /** The incoming key is one this device already retired for this group. */
  keySuperseded: boolean;
  /** `conversations[state.groupId]?.type`, for the server-UUID 1:1 alias slot. */
  localConversationType?: string;
  /** B-365 — member uid lists for the same-epoch owner-signed roster heal.
   *  Optional: absent (legacy caller/tests) keeps the old repair-row verdict. */
  stateMembers?: string[];
  existingMembers?: string[];
}

export type CreateGateDropReason =
  | 'owner-changed'
  | 'unsigned-over-live-key'
  | 'stale-epoch'
  | 'unsigned-fork'
  | 'superseded-key';

export interface CreateGateDecision {
  action: 'accept' | 'repair-row' | 'drop';
  reason?: CreateGateDropReason;
  /** Set when the routing id and the signed id disagree. Never a drop. */
  warn?: 'wire-id-mismatch';
  /**
   * On a G-04 same-epoch heal: the key being REPLACED, which the caller must
   * pass to `markGroupKeySuperseded` before installing. The gate is pure and
   * cannot write the ledger itself, so it hands the effect back rather than
   * making the caller re-derive the condition — re-deriving is what let the
   * epoch rule drift out of sync in the first place (B-129).
   */
  supersedeKeyB64?: string;
  /** On accept: a keyless-placeholder bootstrap (B-41). Informational. */
  bootstrap?: boolean;
  /** B-365 — accept adopted an owner-signed same-epoch roster SUPERSET. */
  rosterHeal?: boolean;
}

/**
 * A slot that legitimately carries an ad-hoc CALL key rather than a real group.
 * All three signals are LOCAL. The name check is load-bearing and the other two
 * are defence in depth: every alias slot originates from a `name: 'Call'` mint
 * and is filed preserving that name, on both the sending and receiving side,
 * which is what makes the exemption hold for a cold contact whose conversation
 * row has not synced yet.
 */
function isCallCarrier(input: CreateGateInput): boolean {
  return (
    isCallGroupState(input.existing) ||
    isDeviceLocalGroupId(input.state.groupId) ||
    input.localConversationType === 'direct'
  );
}

export function decideGroupCreate(input: CreateGateInput): CreateGateDecision {
  const {state, existing, signatureOk, signatureMissing, keySuperseded} = input;

  // (a) Report a routing/payload id split. Never a drop — see the header.
  const warn = input.wireGroupId !== state.groupId
    ? ({warn: 'wire-id-mismatch'} as const)
    : ({} as {warn?: 'wire-id-mismatch'});

  const holdsLiveKey = !!existing?.masterKeyB64;

  // The gate is inert with no live key to protect: the B-41 keyless-placeholder
  // bootstrap requires an unsigned/older/any create to be able to deliver the
  // first key. This is the B-127b residual, not an oversight.
  if (!holdsLiveKey) {
    const bootstrap = !!existing && state.epoch < existing.epoch;
    return bootstrap
      ? {action: 'accept', bootstrap: true, ...warn}
      : {action: 'accept', ...warn};
  }

  // (b) An unsigned create must never overwrite live key material. The
  // same-epoch arm already refused unsigned forks; this extends it to the
  // epoch-advance case, which was the way in. A signature that is PRESENT but
  // invalid never reaches here — the caller hard-drops any sigCheck reason
  // other than 'missing' before the gate is consulted.
  if (signatureMissing) {
    return {action: 'drop', reason: 'unsigned-over-live-key', ...warn};
  }

  // (c) Stale / replayed create.
  if (state.epoch < existing!.epoch) {
    return {action: 'drop', reason: 'stale-epoch', ...warn};
  }

  // (d) Owner continuity. MUST sit after (c) and before (e), so an exempt call
  // resync at equal epochs with a different key still reaches the heal below
  // and converges instead of being dropped here.
  if (state.owner !== existing!.owner && !isCallCarrier(input)) {
    return {action: 'drop', reason: 'owner-changed', ...warn};
  }

  // (e) Same-epoch four-way (the G-04 fork heal + MEDIUM-2 rollback guard).
  if (state.epoch === existing!.epoch) {
    if (state.masterKeyB64 === existing!.masterKeyB64) {
      // B-365 — owner-signed ROSTER heal. Same epoch + same key used to be
      // an unconditional "idempotent duplicate", which silently discarded a
      // create whose MEMBER LIST had grown — a device that missed an add
      // kept its stale roster forever and roster-gated every serve/identity
      // reply to the missing member ("requester not on our roster copy",
      // Ariful↔Ae2 2026-08-01). The owner's signature covers
      // (groupId, sorted members, masterKeyB64, epoch), so the incoming
      // roster is authenticated; adopt it when it is a STRICT SUPERSET of
      // ours. Superset-only keeps this replay-safe: a removal always bumps
      // the epoch (G-03), so any state from before a kick sits BELOW the
      // current epoch and is dropped by (c) — a same-epoch superset can
      // only be members the owner signed at THIS epoch. Unsigned creates
      // never reach here with a roster change (still repair-row).
      if (signatureOk && input.stateMembers && input.existingMembers) {
        const local = new Set(input.existingMembers);
        const incoming = new Set(input.stateMembers);
        const isSuperset = incoming.size > local.size &&
          [...local].every(m => incoming.has(m));
        if (isSuperset) {
          return {action: 'accept', rosterHeal: true, ...warn};
        }
      }
      // Idempotent duplicate — still allowed to repair a lost inbox row.
      return {action: 'repair-row', ...warn};
    }
    if (!signatureOk) {return {action: 'drop', reason: 'unsigned-fork', ...warn};}
    if (keySuperseded) {return {action: 'drop', reason: 'superseded-key', ...warn};}
    // Hand the ledger write back to the caller — see supersedeKeyB64.
    return {action: 'accept', supersedeKeyB64: existing!.masterKeyB64, ...warn};
  }

  // (f) Normal epoch advance from the same owner.
  return {action: 'accept', ...warn};
}
