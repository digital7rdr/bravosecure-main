import {isGroupMember} from '@bravo/messenger-core';
import type {GroupState} from '@bravo/messenger-core';

/**
 * The authorisation decision for an inbound "edit this message" or
 * "delete this message for everyone" directive.
 *
 * WHY THIS MODULE EXISTS AT ALL, which is the non-obvious part:
 *
 * An edit and a delete-for-everyone are 1:1-PAIRWISE-encrypted CONTROL
 * envelopes carrying a group ROUTING hint — exactly like reactions (MSG-02),
 * and exactly UNLIKE group text. Group text is master-key encrypted, so
 * possession of the group key gates it implicitly and that lane looks safe with
 * no explicit check. These directives get none of that protection. B-128 is the
 * precedent: the group reaction lane looked identical to the text lane and had
 * no membership gate for months, so a non-member who knew a groupId could react
 * into any group and a removed member kept reacting forever.
 *
 * These two directives are strictly more dangerous than a reaction, because
 * they REWRITE or DESTROY content rather than decorating it. So the gate is
 * stricter, and it fails CLOSED:
 *
 *   1. blocked peer            → drop   (M-07 / P2-9 parity with every lane)
 *   2. non-member of the group → drop   (B-128 parity)
 *   3. target not held locally → STASH, never drop. The envelope is already
 *      ACKed by the time we get here, so dropping is PERMANENT divergence: for
 *      a delete that means the recipient keeps rendering content the author
 *      retracted everywhere else. This is the SYNC-7 lesson, and it applies
 *      harder here than it did to reactions.
 *   4. the target is OUR message → drop. A peer may never rewrite or destroy
 *      something we wrote.
 *   5. the sender is not the target's author → drop. THIS is the security
 *      property the whole feature rests on. `fromUserId` is the sender
 *      authenticated by the Signal session + sender-cert upstream — not a field
 *      the envelope gets to claim — so binding the directive to
 *      `target.sender_id` means a member can only ever mutate their own posts.
 *   6. the target is already tombstoned → drop. Deletion is ONE-WAY. An edit
 *      that was in flight when the delete was sent must not resurrect a body,
 *      and a second delete is a no-op.
 *   7. an edit not newer than the one already applied → drop. Two edits can
 *      arrive out of order; without this the older body wins whenever it loses
 *      the race.
 *
 * NOT closed here, and deliberately so: like reactions, these envelopes seal
 * with an AAD of only `{to, ts}`, so `verifySealedAad`'s conversation/group
 * checks are inert for them (B-128 part 2). Widening the AAD is a CLAUDE.md
 * stop-condition — sealed-sender envelope shape / AAD binding — and needs
 * sign-off. What rules 4–6 give instead is RECEIVER-STATE enforcement: even
 * with a replayed or misrouted envelope, the only message a peer can touch is
 * one they demonstrably authored in a conversation we already hold. Do not
 * treat that as a substitute for the binding.
 *
 * Multi-device note: rule 4 also means an edit from the user's OWN second
 * device would be refused, because our own rows carry `sender_id === 'self'`.
 * That is correct TODAY — no send path in this runtime addresses the sender's
 * other devices (see `reactionRecipients`, which excludes self) — but it is the
 * line to revisit if own-device sync is ever added.
 *
 * Tier A: pure decision, no store/React/react-native imports, so the node jest
 * project can load it. It decides and returns; it never mutates and never acks.
 */

export type MutationDropReason =
  | 'blocked'
  | 'nonmember'
  | 'own-row'
  | 'not-author'
  | 'tombstoned'
  | 'stale-edit';

export type MutationVerdict =
  | {kind: 'apply'}
  /** Target not present locally yet — replay when it lands. Never a drop. */
  | {kind: 'stash'}
  | {kind: 'drop'; reason: MutationDropReason};

/** The only fields of the target row the decision reads. */
export interface MutationTargetLike {
  sender_id:        string;
  deleted_for_all?: boolean;
  edited_at?:       number;
}

export interface MutationGateArgs {
  /** 'edit' carries `editedAt`; 'delete' does not need an ordering key. */
  mutation:   {kind: 'edit'; editedAt: number} | {kind: 'delete'};
  /** Sender authenticated upstream by the Signal session + sender cert. */
  fromUserId: string;
  /** The local row, or null when we hold no copy of it (yet). */
  target:     MutationTargetLike | null;
  /**
   * Group state for the target conversation, when this is a GROUP directive.
   * Undefined for a 1:1, and also undefined for a group we hold no state for —
   * both skip the membership gate, matching `applyReactionLane`'s fail-open.
   */
  groupState?: GroupState | undefined;
  isPeerBlocked: (userId: string) => boolean;
}

/** The sentinel `sender_id` every locally-authored row carries. */
export const SELF_SENDER_ID = 'self';

export function decideMessageMutation(args: MutationGateArgs): MutationVerdict {
  const {mutation, fromUserId, target, groupState, isPeerBlocked} = args;

  if (isPeerBlocked(fromUserId)) {
    return {kind: 'drop', reason: 'blocked'};
  }

  if (groupState && !isGroupMember(groupState, fromUserId)) {
    return {kind: 'drop', reason: 'nonmember'};
  }

  // Ordered BEFORE the author checks on purpose: with no target there is no
  // author to compare against, and guessing would be the wrong kind of
  // fail-closed — it would discard a directive we are simply not ready for.
  // The stash is re-gated in full when it replays.
  if (!target) {
    return {kind: 'stash'};
  }

  if (target.sender_id === SELF_SENDER_ID) {
    return {kind: 'drop', reason: 'own-row'};
  }

  if (target.sender_id !== fromUserId) {
    return {kind: 'drop', reason: 'not-author'};
  }

  if (target.deleted_for_all) {
    return {kind: 'drop', reason: 'tombstoned'};
  }

  if (mutation.kind === 'edit') {
    // `>=`, not `>`: a replayed duplicate of the edit we already applied has an
    // identical stamp and must be a no-op, not a re-apply that re-dirties the
    // backup mirror on every drain.
    if (typeof target.edited_at === 'number' && mutation.editedAt <= target.edited_at) {
      return {kind: 'drop', reason: 'stale-edit'};
    }
  }

  return {kind: 'apply'};
}

/**
 * Product windows, enforced on the SENDING side.
 *
 * Deliberately not enforced on the receiver: a directive can legitimately sit
 * in the outbox or on the relay for far longer than either window (the relay
 * dwell is 30 days), so an age check on arrival would destroy exactly the
 * queued directives that most need to land — the offline-then-online case.
 * What the receiver enforces instead is authorship, which is the part that
 * actually matters; a stale edit is a product wart, an unauthorised one is a
 * security bug. The "edited" marker is always rendered, so nothing an author
 * does to their own message is silent.
 */
export const EDIT_WINDOW_MS   = 15 * 60 * 1000;
export const DELETE_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Can the local author still edit this message? Drives the action sheet. */
export function canEditOwnMessage(
  msg: {sender_id: string; type?: string; created_at?: string; deleted_for_all?: boolean},
  nowMs: number = Date.now(),
): boolean {
  if (msg.sender_id !== SELF_SENDER_ID) {return false;}
  if (msg.deleted_for_all) {return false;}
  // Text only. Editing a caption in place would desync it from the uploaded
  // blob's own metadata, and there is no edit affordance for a call record or
  // a system line at all.
  if (msg.type !== undefined && msg.type !== 'text') {return false;}
  return withinWindow(msg.created_at, nowMs, EDIT_WINDOW_MS);
}

/** Can the local author still delete this message for everyone? */
export function canDeleteForEveryone(
  msg: {sender_id: string; created_at?: string; deleted_for_all?: boolean},
  nowMs: number = Date.now(),
): boolean {
  if (msg.sender_id !== SELF_SENDER_ID) {return false;}
  if (msg.deleted_for_all) {return false;}
  return withinWindow(msg.created_at, nowMs, DELETE_WINDOW_MS);
}

function withinWindow(createdAt: string | undefined, nowMs: number, windowMs: number): boolean {
  if (!createdAt) {return false;}
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) {return false;}
  // A row stamped in the future (sender clock skew, already clamped upstream by
  // orderingTsMs) reads as age 0 rather than as an expired window.
  return nowMs - t <= windowMs;
}
