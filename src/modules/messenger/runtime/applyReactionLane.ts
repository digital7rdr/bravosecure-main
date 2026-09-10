import {isGroupMember} from '@bravo/messenger-core';
import type {GroupState, SessionAddress} from '@bravo/messenger-core';
import type {LocalMessage} from '../store/types';

/**
 * Seam S5 — the reaction lane, for BOTH group and 1:1.
 *
 * This is a unification, not just a move. `doHandleIncoming` had two reaction
 * lanes that were identical apart from one gate, and the difference was not
 * design — it was drift. The group lane only got its membership gate at B-128,
 * as a P1 security fix, because a non-member who knew a groupId could place
 * reactions into a group they had never belonged to and a removed member kept
 * reacting forever. That is the same "two hand-copied implementations, the
 * unwatched one drifts" failure behind B-124, B-141 and the M5 divergences.
 * Merging them means the next gate is added once, not once-and-forgotten.
 *
 * The topology difference is now an explicit PARAMETER rather than two
 * copies: pass `groupState` for a group reaction, omit it for a 1:1. A 1:1 has
 * no membership concept, and its conversation id is resolved FROM the peer, so
 * a peer cannot address someone else's thread.
 *
 * Why reactions need their own gate at all, which is the non-obvious part: a
 * reaction is a 1:1-PAIRWISE-encrypted CONTROL envelope carrying a group ROUTING
 * hint (MSG-02), not a master-key-encrypted message. Possession of the group key
 * gates the text lane implicitly, so that lane looks safe with no explicit
 * check — and this lane, which gets none of that protection, looks identical.
 *
 * NOT closed here — B-128 part 2: reaction envelopes seal with an AAD of only
 * `{to, ts}`, so `verifySealedAad`'s conversation/group checks are inert for
 * them. That is a CLAUDE.md stop-condition (sealed-sender envelope shape / AAD
 * binding) and needs sign-off. This gate is RECEIVER-STATE enforcement: it stops
 * the practical attack, it does not cryptographically bind the envelope to a
 * conversation. Do not treat it as a substitute.
 *
 * See docs/runbooks/MESSAGE_LOOP.md W24/S5 and sqa.md B-128.
 */

export type ReactionOutcome =
  | {kind: 'dropped'; reason: 'blocked' | 'nonmember'}
  /** `patched` is null when the target message is not present locally yet. */
  | {kind: 'applied'; patched: LocalMessage | null};

export interface ReactionLaneDeps {
  isPeerBlocked: (userId: string) => boolean;
  noteDestroyed: (args: {envelopeId: string; reason: string; peer: SessionAddress}) => void;
  applyReaction: (
    conversationId: string, reactorUserId: string,
    targetMsgId: string, emoji: string, remove: boolean,
  ) => LocalMessage | null;
  upsert: ((msg: LocalMessage) => Promise<void>) | null;
  log:    (msg: string) => void;
  /**
   * SYNC-7 tiers 2 and 3 — what to do when `applyReaction` returns null.
   *
   * Null is NOT "drop it". A reaction is a pairwise CONTROL envelope with no
   * group-key dependency, so it routinely overtakes the group text it points
   * at; the caller has already ACKed it off the relay, so falling back to
   * nothing is PERMANENT loss. This hook re-resolves the target on disk and,
   * failing that, stashes the patch for `drainPendingReactionsFor` to replay
   * when the target lands. Optional only so unit tests can omit it.
   */
  resolveDurably?: (
    conversationId: string, reactorUserId: string,
    targetMsgId: string, emoji: string, remove: boolean,
    receivedAtMs: number,
  ) => Promise<void>;
}

export interface ReactionLaneArgs {
  conversationId: string;
  peer:           SessionAddress;
  reaction:       {targetMsgId: string; emoji: string; remove?: boolean};
  envelopeId:     string | undefined;
  /**
   * Local state for the target group, when this is a GROUP reaction. Undefined
   * for a 1:1 reaction, and also undefined for a group we hold no state for —
   * both skip the membership gate, which is the intended fail-open.
   */
  groupState?:    GroupState | undefined;
  /**
   * Authenticated send time (aad.ts) of the reaction envelope, used as the
   * stash timestamp when the target has not arrived yet. Falls back to now.
   */
  receivedAtMs?:  number;
}

export async function applyReactionLane(
  args: ReactionLaneArgs,
  deps: ReactionLaneDeps,
): Promise<ReactionOutcome> {
  const {conversationId, peer, reaction, envelopeId, groupState} = args;

  // P2-9 / M-07 — before the reaction lands. A blocked peer could previously
  // patch the bubble unimpeded.
  if (deps.isPeerBlocked(peer.userId)) {
    deps.log('[recv.reaction.blocked] peer=' + peer.userId.slice(0, 8));
    return {kind: 'dropped', reason: 'blocked'};
  }

  // B-128 — group only, and only when we actually hold state to judge against.
  if (groupState && !isGroupMember(groupState, peer.userId)) {
    deps.log(`[group:recv] DROP reaction — peer=${peer.userId.slice(0, 8)} not a member of groupId=${conversationId.slice(0, 8)} at epoch=${groupState.epoch}`);
    // M10 — a bare return in the caller COMMITS and acks 'delivered'. W11 taught
    // the group-text non-member drop to note the envelope so the sender is told
    // 'discarded' rather than a false ✓✓; this drop owes the same honesty.
    if (envelopeId) {
      deps.noteDestroyed({envelopeId, reason: 'group-reaction-nonmember', peer});
    }
    return {kind: 'dropped', reason: 'nonmember'};
  }

  const patched = deps.applyReaction(
    conversationId, peer.userId,
    reaction.targetMsgId, reaction.emoji, reaction.remove ?? false,
  );
  // M9 — persist INSIDE the receive txn. Returning void here is what made the
  // reaction reach SQLite only via the deferred 50 ms subscriber, i.e. after
  // COMMIT and after the ack.
  if (patched && deps.upsert) {
    await deps.upsert(patched);
  }
  // SYNC-7 — the target was not in the hydrated window. Do NOT stop here: the
  // envelope is already acked, so the durable tiers (on-disk lookup, then the
  // pending stash replayed by drainPendingReactionsFor) are the only thing
  // between an out-of-order reaction and permanent loss.
  if (!patched && deps.resolveDurably) {
    await deps.resolveDurably(
      conversationId, peer.userId,
      reaction.targetMsgId, reaction.emoji, reaction.remove ?? false,
      args.receivedAtMs ?? Date.now(),
    );
  }
  return {kind: 'applied', patched};
}
