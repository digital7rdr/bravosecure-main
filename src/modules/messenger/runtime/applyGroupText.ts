import {isGroupMember} from '@bravo/messenger-core';
import type {GroupState, SessionAddress} from '@bravo/messenger-core';
import {buildInboundMessage, sentAtFromAad} from './inboundMessageBuilder';
import type {LocalMessage} from '../store/types';

/**
 * Seam S5 — the group TEXT lane of `doHandleIncoming`.
 *
 * This is the "a group message arrived and parsed cleanly; may it render, and
 * where?" decision. It is one of the three S5 lanes that are safe to extract —
 * the ADMIN lane next to it is architecture-gated (it does
 * `verifyGroupCreateSignature`, epoch monotonicity, master-key install and
 * `applyAdminAction`), so it deliberately stays in `productionRuntime.ts`. See
 * MESSAGE_LOOP.md W24/S5 and §10.
 *
 * Everything react-native-tainted is INJECTED rather than imported, so this
 * module stays Tier A and the node jest project can load it. That is the entire
 * point of the extraction: these four gates were previously reachable only by a
 * static source scan (`readFileSync` on an 8k-line file), and are now reachable
 * by a real behavioural test that can actually run them.
 *
 * The gate ORDER is load-bearing and is asserted by the tests:
 *
 *   1. membership (P1-N4) — before anything is built. A removed member's late
 *      envelope must not render, and the drop is NOTED so the sender is acked
 *      'discarded' rather than a false ✓✓ (M10/W11 — a bare return in the
 *      caller COMMITS and acks 'delivered').
 *   2. transcript-hash divergence (G-08) — DIAGNOSTIC ONLY, never a drop. A
 *      benign out-of-order delivery also mismatches transiently and settles on
 *      the next admin action, so dropping here would destroy good messages.
 *   3. restore tombstone (M-08) — needs the built row's id, so it sits below
 *      the builder.
 *   4. blocked peer (P2-9) — the render is suppressed, but the caller has
 *      already completed decrypt + txn + seen/ack identically, so the blocked
 *      peer cannot tell they are blocked.
 *
 * Returning an outcome rather than void is what makes the lane assertable: the
 * caller just `return`s on every branch, so a void signature would leave tests
 * unable to distinguish "dropped as non-member" from "dropped as blocked".
 */

export type GroupTextOutcome =
  | {kind: 'dropped'; reason: 'nonmember' | 'tombstoned' | 'blocked'}
  /** `committedId` is null when the store deduped the row away. */
  | {kind: 'appended'; committedId: string | null};

export interface GroupTextDeps {
  /** In-memory blocked set. Injected — its module pulls AsyncStorage. */
  isPeerBlocked:       (userId: string) => boolean;
  /** Restore tombstones. Injected for the same reason. */
  isRestoreTombstoned: (msgId: string) => boolean;
  /** Flips the ack to 'discarded' so a destroyed message is reported honestly. */
  noteDestroyed:       (args: {envelopeId: string; reason: string; peer: SessionAddress}) => void;
  appendMessage:       (conversationId: string, msg: LocalMessage) => string | null;
  upsert:              ((msg: LocalMessage) => Promise<void>) | null;
  makeId:              () => string;
  crashLog:            (msg: string) => void;
  log:                 (msg: string) => void;
}

export interface GroupTextArgs {
  /** The unsealed envelope. Shaped loosely because the caller's type is local. */
  env:            {group?: {groupId: string; senderTranscriptHash?: string}; aad?: unknown};
  conversationId: string;
  peer:           SessionAddress;
  /** Decrypted inner body. */
  content:        string;
  envelopeId:     string | undefined;
  /** Local group state, or undefined when we hold none for this id. */
  existing:       GroupState | undefined;
  /**
   * OM-02 — the relay's accept time, used to clamp a sender whose clock is in
   * the FUTURE. The inline lane this replaced clamped via orderingCreatedAt;
   * passing it keeps that behaviour instead of silently dropping it.
   */
  refTsMs?:       number;
}

/**
 * Async because the append and the upsert MUST stay together: M8/M12 exist
 * because the caller used to persist the pre-append object while the store had
 * forked the id, leaving `X` on disk and `X#n` in memory. Splitting them across
 * this boundary would rebuild that bug at the seam. The caller runs this inside
 * the receive txn, so the write still lands before COMMIT (P0-N14).
 */
export async function applyGroupText(args: GroupTextArgs, deps: GroupTextDeps): Promise<GroupTextOutcome> {
  const {env, conversationId, peer, content, envelopeId, existing, refTsMs} = args;
  const groupId = env.group?.groupId ?? conversationId;

  // 1. P1-N4 — a text envelope from someone not in `existing.members` at OUR
  // current epoch has no place in the thread. `existing &&` on purpose: with no
  // local state we cannot judge membership, and dropping would discard
  // legitimate traffic for a group we simply have not synced yet.
  if (existing && !isGroupMember(existing, peer.userId)) {
    deps.log(`[group:recv] DROP text — peer=${peer.userId} not a member of groupId=${groupId.slice(0, 8)} at epoch=${existing.epoch}`);
    if (envelopeId) {
      deps.noteDestroyed({envelopeId, reason: 'group-nonmember', peer});
    }
    return {kind: 'dropped', reason: 'nonmember'};
  }

  // 2. G-08 — a same-epoch transcript mismatch means the two sides applied a
  // DIFFERENT admin sequence (a fork/equivocation). Detection only: never a
  // user-facing error and never a drop.
  const senderTH = env.group?.senderTranscriptHash;
  if (existing && senderTH && existing.transcriptHash && senderTH !== existing.transcriptHash) {
    deps.crashLog(`[group:recv] G-08 transcript divergence groupId=${groupId.slice(0, 8)} sender=${peer.userId.slice(0, 8)} local=${existing.transcriptHash.slice(0, 12)} theirs=${senderTH.slice(0, 12)} epoch=${existing.epoch}`);
  }

  // MSG-09 — send time from the authenticated aad.ts so a message drained after
  // reconnect sorts by when it was SENT, not when it was received.
  const groupMsg: LocalMessage = buildInboundMessage({
    env:       env as Parameters<typeof buildInboundMessage>[0]['env'],
    conversationId, peer, content,
    createdAt: sentAtFromAad(env.aad as {ts?: number} | undefined, refTsMs),
    envelopeId,
    makeId:    deps.makeId,
  });

  // 3. M-08 — don't let the sealed-archive replay resurrect a message the user
  // deleted before reinstalling.
  if (deps.isRestoreTombstoned(groupMsg.id)) {
    deps.log('[group:recv.tombstoned] msgId=' + groupMsg.id.slice(0, 8));
    return {kind: 'dropped', reason: 'tombstoned'};
  }

  // 4. P2-9 — suppress the render only. The caller already completed decrypt,
  // txn and seen/ack identically, so a blocked peer cannot detect the block.
  if (deps.isPeerBlocked(peer.userId)) {
    deps.log('[group:recv.blocked] peer=' + peer.userId.slice(0, 8));
    return {kind: 'dropped', reason: 'blocked'};
  }

  // M8/M12 — persist the row the store COMMITTED, not the one we built.
  // appendMessage can fork the id on a content-divergent collision and returns
  // null when it deduped; upserting the pre-append object stored `X` on disk
  // while memory held `X#n`.
  const committedId = deps.appendMessage(conversationId, groupMsg);
  if (committedId && deps.upsert) {
    await deps.upsert({...groupMsg, id: committedId});
  }
  return {kind: 'appended', committedId};
}
