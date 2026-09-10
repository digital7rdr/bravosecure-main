/**
 * Durable application of an edit / delete-for-everyone, plus the stash drain.
 *
 * Structure is deliberately the same as `pendingReactionApply.ts` (SYNC-7),
 * because the failure it prevents is the same one: the target of a pairwise
 * control envelope is not guaranteed to be in the hydrated window — or on disk
 * at all — when the directive lands, and the envelope is already ACKed by then.
 *
 * Three resolution tiers:
 *   1. In the hydrated window → patch the store AND SQLCipher (the store
 *      rehydrates from SQL at boot, so a store-only patch evaporates).
 *   2. On disk but past MAX_HYDRATE_PER_CONVO → patch SQLCipher only; the
 *      scroll-back path reads it from there. Without this tier, editing or
 *      deleting anything older than the window would silently no-op — which is
 *      most of a real thread.
 *   3. Not stored at all → stash and replay when the target lands.
 *
 * Authorisation is NOT decided here — `messageMutationGate.decideMessageMutation`
 * owns that, and every entry point below re-runs it. Re-gating on replay is the
 * point: a peer blocked or removed from the group between stash and drain must
 * not reach the user through a replayed directive (the same rule
 * `drainPendingReactionsFor` applies to a stashed reaction).
 *
 * Tier C: one value import of `useMessengerStore`, `.getState()` called inside.
 */

import {useMessengerStore} from '../store/messengerStore';
import {isPeerBlocked} from './blockedPeers';
import {decideMessageMutation, type MutationVerdict} from './messageMutationGate';
import type {PendingMutationStore} from '../store/pendingMutationStore';
import type {SqlMessageStore} from '../store/sqlMessageStore';
import type {LocalMessage} from '../store/types';
import type {GroupState} from '@bravo/messenger-core';

let pendingMutationsStore: PendingMutationStore | null = null;

export function setPendingMutationStore(store: PendingMutationStore | null): void {
  pendingMutationsStore = store;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type MutationDirectiveInput =
  | {kind: 'edit'; body: string; editedAt: number; mentions?: LocalMessage['mentions']}
  | {kind: 'delete'; deletedAt: number};

/** The stamp that orders this directive, whichever kind it is. */
function stampOf(d: MutationDirectiveInput): number {
  return d.kind === 'edit' ? d.editedAt : d.deletedAt;
}

/**
 * Tier 1 — patch the target inside the hydrated store window and return the row
 * AS COMMITTED (read back, so the caller cannot persist a stale copy).
 *
 * M9 — returning the row rather than void is what lets the receive lane
 * `await sqlMessages.upsert` it INSIDE the receive transaction. A void tier 1
 * could only reach SQLCipher after COMMIT and after the relay ack.
 *
 * Null means "not in the hydrated window" — NOT "drop it".
 */
export function applyMutationInWindow(
  conversationId: string,
  targetMsgId:    string,
  directive:      MutationDirectiveInput,
): LocalMessage | null {
  const store = useMessengerStore.getState();
  // Same lookup shape as the reaction path: the sender-chosen opaque id, which
  // is also what `reply_to_msg_id` is keyed off.
  const msg = store.messages[conversationId]?.find(
    m => m.id === targetMsgId || m.reply_to_msg_id === targetMsgId,
  );
  if (!msg) {return null;}
  if (directive.kind === 'edit') {
    store.applyMessageEdit(conversationId, msg.id, directive.body, directive.editedAt, directive.mentions);
  } else {
    store.applyDeleteForEveryone(conversationId, msg.id);
  }
  return useMessengerStore.getState().messages[conversationId]
    ?.find(m => m.id === msg.id) ?? null;
}

/** Produce the tombstoned/edited row from an on-disk copy, without the store. */
function patchOffline(row: LocalMessage, directive: MutationDirectiveInput): LocalMessage {
  if (directive.kind === 'edit') {
    return {
      ...row,
      content:   directive.body,
      edited_at: directive.editedAt,
      mentions:  directive.mentions?.length ? directive.mentions : undefined,
    };
  }
  // Must strip exactly what the store action strips. Two copies of this list is
  // how a field gets retracted in memory and left on disk; the parity is
  // asserted in messageMutationApply.test.ts.
  return {
    ...row,
    deleted_for_all:  true,
    content:          '',
    type:             'text',
    media_mime:       undefined,
    media_object_key: undefined,
    media_key:        undefined,
    media_iv:         undefined,
    media_meta:       undefined,
    reactions:        undefined,
    mentions:         undefined,
    reply_to_msg_id:  undefined,
    reply_to_preview: undefined,
    expires_at:       undefined,
  };
}

export interface ApplyMutationArgs {
  conversationId: string;
  targetMsgId:    string;
  fromUserId:     string;
  directive:      MutationDirectiveInput;
  groupState?:    GroupState | undefined;
  sqlMessages:    SqlMessageStore | null;
  receivedAtMs?:  number;
}

export type ApplyMutationOutcome =
  | {kind: 'applied'; patched: LocalMessage | null; wasInWindow: boolean}
  | {kind: 'stashed'}
  | {kind: 'dropped'; reason: string};

/**
 * Resolve + authorise + apply, across all three tiers.
 *
 * The gate runs against whichever copy of the target we can find, so an
 * out-of-window message is authorised against its REAL author from disk rather
 * than being waved through for lack of a local row.
 */
export async function applyMessageMutation(args: ApplyMutationArgs): Promise<ApplyMutationOutcome> {
  const {conversationId, targetMsgId, fromUserId, directive, groupState, sqlMessages} = args;
  const store = useMessengerStore.getState();

  const inWindow = store.messages[conversationId]?.find(
    m => m.id === targetMsgId || m.reply_to_msg_id === targetMsgId,
  ) ?? null;

  // Tier 2 lookup happens BEFORE the gate when the window misses, so the gate
  // sees a real author instead of a null target and does not stash something we
  // can already resolve.
  const onDisk = !inWindow && sqlMessages
    ? await sqlMessages.findReactionTarget(conversationId, targetMsgId)
    : null;

  const target = inWindow ?? onDisk;
  const verdict: MutationVerdict = decideMessageMutation({
    mutation: directive.kind === 'edit'
      ? {kind: 'edit', editedAt: directive.editedAt}
      : {kind: 'delete'},
    fromUserId,
    target,
    groupState,
    isPeerBlocked,
  });

  if (verdict.kind === 'drop') {
    return {kind: 'dropped', reason: verdict.reason};
  }

  if (verdict.kind === 'stash') {
    if (!pendingMutationsStore) {
      return {kind: 'dropped', reason: 'no-stash-store'};
    }
    try {
      await pendingMutationsStore.stash({
        conversationId,
        targetMsgId,
        fromUserId,
        kind:         directive.kind,
        body:         directive.kind === 'edit' ? directive.body : null,
        mentions:     directive.kind === 'edit' ? directive.mentions ?? null : null,
        stampMs:      stampOf(directive),
        receivedAtMs: args.receivedAtMs ?? Date.now(),
      });
      console.log(`[recv.mutation.stashed] kind=${directive.kind} target=${targetMsgId.slice(0, 8)}`);
    } catch (e) {
      console.warn('[messenger.pendingMutations] stash failed:', errText(e));
    }
    return {kind: 'stashed'};
  }

  if (inWindow) {
    const patched = applyMutationInWindow(conversationId, targetMsgId, directive);
    return {kind: 'applied', patched, wasInWindow: true};
  }

  // Tier 2 — on disk only. `onDisk` is non-null here: the gate returned
  // 'stash' for a null target, and that branch already returned above.
  const patched = patchOffline(onDisk as LocalMessage, directive);
  if (sqlMessages) {
    await sqlMessages.upsert(patched);
  }
  return {kind: 'applied', patched, wasInWindow: false};
}

/**
 * Replay every stashed directive that was waiting for `messageId`.
 *
 * Called immediately after an inbound message row is persisted, inside the same
 * receive transaction, so the mutation commits atomically with its target — the
 * peer never sees a one-frame flash of the pre-edit body.
 *
 * A delete in the set wins outright regardless of arrival order: deletion is
 * one-way (the gate refuses an edit for a tombstoned row), so applying the
 * edits first and the delete last converges on the same state no matter how the
 * network reordered them.
 */
export async function drainPendingMutationsFor(
  conversationId: string,
  messageId:      string,
  sqlMessages:    SqlMessageStore | null,
  groupState?:    GroupState | undefined,
): Promise<void> {
  if (!pendingMutationsStore) {return;}
  let rows;
  try {
    rows = await pendingMutationsStore.listForTarget(conversationId, messageId);
  } catch (e) {
    console.warn('[messenger.pendingMutations] list failed:', errText(e));
    return;
  }
  if (rows.length === 0) {return;}

  // Edits oldest-first, then any delete. The gate's own ordering rules do the
  // rest (a stale edit is refused, a tombstoned row refuses everything).
  const ordered = [...rows].sort((a, b) => {
    if (a.kind !== b.kind) {return a.kind === 'delete' ? 1 : -1;}
    return a.stampMs - b.stampMs;
  });

  for (const r of ordered) {
    const directive: MutationDirectiveInput = r.kind === 'edit'
      ? {kind: 'edit', body: r.body ?? '', editedAt: r.stampMs, mentions: r.mentions ?? undefined}
      : {kind: 'delete', deletedAt: r.stampMs};
    // Re-gate in full: blocked/removed since the stash must not get through.
    await applyMessageMutation({
      conversationId,
      targetMsgId: messageId,
      fromUserId:  r.fromUserId,
      directive,
      groupState,
      sqlMessages,
      receivedAtMs: r.receivedAtMs,
    });
  }

  await pendingMutationsStore.deleteForTarget(conversationId, messageId);
  console.log(`[recv.mutation.drained] msgId=${messageId.slice(0, 8)} n=${rows.length}`);
}

/**
 * Boot sweep. Covers targets that landed through a path with no drain hook
 * (backup restore, a build predating the drain call sites). Bounded by
 * PENDING_MUTATION_MAX_GLOBAL; runs once, fire-and-forget.
 */
export async function sweepPendingMutations(sqlMessages: SqlMessageStore | null): Promise<void> {
  if (!pendingMutationsStore) {return;}
  const rows = await pendingMutationsStore.listAll();
  const targets = new Set(rows.map(r => `${r.conversationId} ${r.targetMsgId}`));
  const groups = useMessengerStore.getState().groups;
  for (const key of targets) {
    const [conversationId, targetMsgId] = key.split(' ');
    await drainPendingMutationsFor(conversationId, targetMsgId, sqlMessages, groups[conversationId]);
  }
}
