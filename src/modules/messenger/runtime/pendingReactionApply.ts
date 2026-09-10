/**
 * SYNC-7 — durable reaction application + the pending-reaction drain.
 *
 * Extracted from productionRuntime.ts so the behaviour is unit-testable (that
 * file transitively imports native modules and cannot load under the
 * `messenger-crypto` Jest project). The stash handle lives at module scope
 * because `applyReaction` and the drain run on module-level receive-path
 * functions (same placement rationale as productionRuntime's drain pump);
 * productionRuntime assigns it when the SQLCipher stores are built and nulls
 * it via a liveDisposer, so a logout→login rebuild can never leave the
 * previous user's handle live.
 */

import {useMessengerStore} from '../store/messengerStore';
import {mergeReaction} from './reactionMerge';
import {isPeerBlocked} from './blockedPeers';
import type {PendingReactionStore} from '../store/pendingReactionStore';
import type {SqlMessageStore} from '../store/sqlMessageStore';
import type {LocalMessage} from '../store/types';

let pendingReactionsStore: PendingReactionStore | null = null;

export function setPendingReactionStore(store: PendingReactionStore | null): void {
  pendingReactionsStore = store;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * SYNC-7 tier 1, on its own — patch the target inside the hydrated store
 * window and return the row AS COMMITTED to the store (read back, so the
 * caller cannot persist a stale copy of it).
 *
 * M9 — returning the row instead of void is the whole point of this split.
 * The receive lane needs the patched row so it can `await sqlMessages.upsert`
 * it INSIDE the receive transaction; a void tier 1 could only reach SQLCipher
 * after COMMIT and after the relay ack, which is how a reaction the sender had
 * already been shown ✓✓ for could be lost.
 *
 * Null means "not in the hydrated window" — NOT "drop it". Callers owe the
 * durable fallback (`applyReaction` below, tiers 2 and 3): a reaction is a
 * pairwise envelope with no group-key dependency, so it routinely overtakes
 * the group text it points at.
 */
export function applyReactionInWindow(
  conversationId: string,
  fromUserId: string,
  targetMsgId: string,
  emoji: string,
  remove: boolean,
): LocalMessage | null {
  const store = useMessengerStore.getState();
  // Find target by the sender-chosen opaque id we store when encoding.
  // reply_to_msg_id is keyed off the same id, so the lookup pattern is
  // the "clientMsgId" of the target.
  const msg = store.messages[conversationId]?.find(
    m => m.id === targetMsgId || m.reply_to_msg_id === targetMsgId,
  );
  if (!msg) {
    return null;
  }
  // MM-05 — a delete-for-everyone is terminal: merging onto the tombstone
  // would render a reaction on "This message was deleted". Found-but-unchanged
  // (not null) so the durable tiers don't stash it for a replay that must
  // never happen.
  if (msg.deleted_for_all) {
    return msg;
  }
  const next = mergeReaction(msg.reactions, fromUserId, emoji, remove);
  store.updateMessageReactions(conversationId, msg.id, next);
  return useMessengerStore.getState().messages[conversationId]
    ?.find(m => m.id === msg.id) ?? null;
}

/**
 * SYNC-7 — fold a reaction patch onto its target message, durably.
 *
 * Three resolution tiers, because the target can legitimately be absent from
 * the in-memory window:
 *   1. In the hydrated window  → patch the store AND SQLCipher (the store
 *      rehydrates from SQL at boot, so a store-only patch evaporated).
 *   2. On disk but past MAX_HYDRATE_PER_CONVO → patch SQLCipher only; the
 *      scroll-back path reads it from there.
 *   3. Not stored at all      → stash. A reaction is a pairwise envelope with
 *      no group-key dependency, so it routinely overtakes the group text it
 *      points at; the caller has already ACKed it, so dropping it here is
 *      permanent loss. `drainPendingReactionsFor` replays it when the target
 *      lands.
 */
export async function applyReaction(
  conversationId: string,
  fromUserId: string,
  targetMsgId: string,
  emoji: string,
  remove: boolean,
  sqlMessages: SqlMessageStore | null,
  receivedAtMs: number = Date.now(),
): Promise<void> {
  const patched = applyReactionInWindow(conversationId, fromUserId, targetMsgId, emoji, remove);
  if (patched) {
    if (sqlMessages) {
      // Why: fire-and-forget (no chain await) — this runs on the hot receive
      // path inside the ratchet txn and must not lengthen it (B-75 class).
      // The RECEIVE LANE does not come through here: it calls
      // `applyReactionInWindow` directly and awaits the upsert itself (M9), so
      // this coalesced write is for the non-txn callers (drain/sweep replays).
      sqlMessages.upsertCoalesced(patched);
    }
    return;
  }
  if (sqlMessages) {
    const onDisk = await sqlMessages.findReactionTarget(conversationId, targetMsgId);
    if (onDisk) {
      if (onDisk.deleted_for_all) {
        return;
      }
      const next = mergeReaction(onDisk.reactions, fromUserId, emoji, remove);
      await sqlMessages.upsert({...onDisk, reactions: next});
      return;
    }
  }
  if (!pendingReactionsStore) {
    return;
  }
  try {
    await pendingReactionsStore.stash({
      conversationId,
      targetMsgId,
      fromUserId,
      emoji,
      removed: remove,
      receivedAtMs,
    });
    console.log('[recv.reaction.stashed] target=' + targetMsgId.slice(0, 8));
  } catch (e) {
    console.warn('[messenger.pendingReactions] stash failed:', errText(e));
  }
}

/**
 * SYNC-7 — replay every stashed reaction that was waiting for `messageId`.
 * Called immediately after an inbound message row is persisted, inside the
 * same receive transaction, so the reaction commits atomically with its target.
 */
export async function drainPendingReactionsFor(
  conversationId: string,
  messageId: string,
  sqlMessages: SqlMessageStore | null,
): Promise<void> {
  if (!pendingReactionsStore || !sqlMessages) {
    return;
  }
  let rows;
  try {
    rows = await pendingReactionsStore.listForTarget(conversationId, messageId);
  } catch (e) {
    console.warn('[messenger.pendingReactions] list failed:', errText(e));
    return;
  }
  if (rows.length === 0) {
    return;
  }
  const store = useMessengerStore.getState();
  const live = store.messages[conversationId]?.find(m => m.id === messageId);
  const target = live ?? (await sqlMessages.findReactionTarget(conversationId, messageId));
  if (!target) {
    return;
  }
  // MM-05 — the target landed already retracted; replaying stashed reactions
  // onto the tombstone would render them. Discard the stash instead.
  if (target.deleted_for_all) {
    await pendingReactionsStore.deleteForTarget(conversationId, messageId);
    return;
  }
  let next = target.reactions;
  for (const r of rows) {
    // The M-07 gate ran at stash time; re-check so a peer blocked in the
    // meantime can't reach the user through a replayed reaction.
    if (isPeerBlocked(r.fromUserId)) {
      continue;
    }
    next = mergeReaction(next, r.fromUserId, r.emoji, r.removed);
  }
  const merged = next ?? {};
  if (live) {
    store.updateMessageReactions(conversationId, messageId, merged);
  }
  await sqlMessages.upsert({...target, reactions: merged});
  await pendingReactionsStore.deleteForTarget(conversationId, messageId);
  console.log('[recv.reaction.drained] msgId=' + messageId.slice(0, 8) + ' n=' + rows.length);
}

/**
 * SYNC-7 — boot sweep. Covers targets that landed through a path with no
 * drain hook (backup restore, a build that predates the drain call sites).
 * Bounded by PENDING_REACTION_MAX_GLOBAL; runs once, fire-and-forget.
 */
export async function sweepPendingReactions(sqlMessages: SqlMessageStore | null): Promise<void> {
  if (!pendingReactionsStore || !sqlMessages) {
    return;
  }
  const rows = await pendingReactionsStore.listAll();
  const targets = new Set(rows.map(r => `${r.conversationId} ${r.targetMsgId}`));
  for (const key of targets) {
    const [conversationId, targetMsgId] = key.split(' ');
    await drainPendingReactionsFor(conversationId, targetMsgId, sqlMessages);
  }
}
