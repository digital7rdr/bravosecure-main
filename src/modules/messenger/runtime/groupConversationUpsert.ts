/**
 * Group-add visibility fixes (docs/handoffs/GROUP_ADD_VISIBILITY_AND_DELIVERY_GAPS_HANDOFF.md §2).
 *
 * Why this lives in its own module:
 *   `productionRuntime.ts` transitively imports native modules and cannot
 *   be required under the Jest `messenger-crypto` project (same reason as
 *   `envelopeDelivered.ts`). These helpers are the single writers of the
 *   group conversation row on a receiving device, so they need direct
 *   unit coverage.
 */

import {useMessengerStore} from '../store/messengerStore';
import {suppressResurrection} from '../backup/conversationTombstones';
import {isDeviceLocalGroupId, isCallGroupState} from './messagingLogic';
import type {GroupState, SessionAddress} from '@bravo/messenger-core';

/**
 * Single writer for a group's inbox row from a verified `admin: create`
 * state. Extracted from the `group-create:recv` handler so:
 *   (a) the idempotent duplicate-create early-return can REPAIR a device
 *       that holds groups[gid] crypto state but lost/never wrote the
 *       conversations[gid] row (previously the early return preceded the
 *       upsert, so redelivery could never fix an invisible group), and
 *   (b) a re-shared create no longer clobbers local-only fields —
 *       unread_count / mute / pin / custom name / last_message survive
 *       for members who already had the row (upsertConversation is a
 *       full replace).
 * Ad-hoc `'Call'` groups must be excluded by the CALLER (BS-CALL-GHOST).
 */
export function upsertGroupConversationFromState(
  state: GroupState,
  senderUserId: string,
): void {
  const store = useMessengerStore.getState();
  const existing = store.conversations[state.groupId];
  // B-594 — a verified `create` REPLAYED out of the archive must not undo a
  // deliberate delete. `suppressResurrection`, NOT a bare tombstone read: a
  // create that arrives LIVE is a genuine re-add and must LIFT the tombstone
  // here, because this path returns before `appendMessage` and nothing else
  // downstream would ever clear it — a re-added member would be permanently
  // invisible, which the tombstone module's own docblock calls worse than the
  // bug. Never suppresses a REPAIR of a row we still hold.
  if (!existing && suppressResurrection(state.groupId)) {return;}
  const memberIds = Object.keys(state.members);
  const otherMembers = memberIds.filter(uid => uid !== senderUserId);
  store.upsertConversation({
    ...(existing ?? {}),
    id:            state.groupId,
    type:          'group',
    name:          existing?.is_custom_name && existing.name ? existing.name : state.name,
    participants:  memberIds,
    // B-247 part 2 — the receiving side never ran ensureAssignedGroup, so this
    // was the one device shape with no rosterUserIds at all: a CPO calling the
    // mission room rang whoever it happened to hold keys for, missing the
    // agency and managers. The verified `create` state carries the true
    // membership, so record it here as well.
    rosterUserIds: memberIds,
    unread_count:  existing?.unread_count ?? 0,
    is_muted:      existing?.is_muted ?? false,
    created_at:    existing?.created_at ?? new Date(state.createdAt).toISOString(),
    // Placeholder address — group routing is per-member fan-out, this
    // field is only used by legacy 1:1-shaped selectors.
    peer:          existing?.peer ?? {userId: otherMembers[0] ?? senderUserId, deviceId: 1},
    session_state: existing?.session_state ?? 'fresh',
  });
}

/**
 * A brand-new member whose owner `create` has not landed yet may receive
 * a wrapped group message first (stashed as `no_key`/`tamper`). Without
 * an inbox row the group is invisible on the Messages page AND every
 * self-heal trigger that walks `conversations` (WS-connect resync,
 * ChatScreen-open resync) skips it entirely. Upsert a minimal
 * placeholder so the thread shows in a syncing state; the real `create`
 * overwrites name/participants when it lands. Never overwrites an
 * existing row. Zustand-only write — safe inside the receive txn.
 */
export function upsertKeylessGroupPlaceholder(
  groupId: string,
  peer: SessionAddress,
): void {
  const store = useMessengerStore.getState();
  if (store.conversations[groupId]) {return;}
  // B-594 — the EARLIEST minter, and the one that runs before every other
  // gate on the receive path. A conversation the user deleted must not be
  // re-placeheld by a replayed archive envelope. `suppressResurrection` LIFTS
  // on a live arrival and returns false, so a real re-invitation still gets
  // its placeholder — this path returns early, so it is the only chance to
  // lift, and a bare tombstone read here stranded re-added members.
  if (suppressResurrection(groupId)) {return;}
  // B-124 §3.1 — THE ghost-row minter. A device-local id can never name a real
  // group, so refuse unconditionally. This deliberately does NOT consult
  // `store.groups`: the B-106 sentinel below is a DEVICE-LOCAL lookup of a
  // CROSS-DEVICE id, so it reads undefined for a peer's stamped id and falls
  // through — and pruneCallKeyContamination (the B-124 boot sweep) deletes the
  // very alias it dereferences, which would otherwise re-mint this ghost on
  // every boot. Shape is the only signal that is always present, and it works
  // against the un-updated fleet because the row is minted on OUR device.
  if (isDeviceLocalGroupId(groupId)) {return;}
  // B-106 — never materialise a chat-list row for an ad-hoc call group.
  // The BS-CALL-GHOST sentinel guard only covers the group-create path;
  // a group-tagged envelope racing its create landed here unguarded and
  // resurrected the 'Call' thread. Exact-name sentinel, same semantics as
  // productionRuntime's create-side guard (adhocCallKeyLookup.test.ts).
  if (isCallGroupState(store.groups[groupId])) {return;}
  store.upsertConversation({
    id:            groupId,
    type:          'group',
    name:          'Group',
    participants:  [peer.userId],
    unread_count:  0,
    is_muted:      false,
    created_at:    new Date().toISOString(),
    peer:          {userId: peer.userId, deviceId: peer.deviceId},
    session_state: 'fresh',
  });
}

/**
 * Target resolution for a group key-request. Participants normally come
 * from the conversation row; a keyless brand-new member may have NO row
 * (the row's only writer is the very `create` that never landed — the
 * catch-22 in handoff §2.5 Seam C), so the stash branch supplies the
 * envelope's sender as a direct fallback target.
 */
export function resolveKeyRequestTargets(
  participants: string[] | undefined,
  ownUserId: string,
  fallbackPeerUserId?: string,
): string[] {
  const fromConvo = (participants ?? []).filter(uid => uid && uid !== ownUserId);
  if (fromConvo.length > 0) {return fromConvo;}
  if (fallbackPeerUserId && fallbackPeerUserId !== ownUserId) {return [fallbackPeerUserId];}
  return [];
}

/**
 * GF-3 — which groups a key-resync sweep should ask about.
 *
 * The default sweep is keyless-only: holding a key means nothing to recover.
 * A DIVERGENCE resync is the exception — it is raised by the receive path
 * precisely because the key we hold FAILED to decrypt (`tamper`), so the
 * keyless filter would drop the only case that needed it.
 */
export function selectKeyResyncCandidates(args: {
  groups: Record<string, {masterKeyB64?: string} | undefined>;
  conversations: Record<string, {type?: string} | undefined>;
  groupId?: string;
  divergence?: boolean;
}): string[] {
  const {groups, conversations, groupId, divergence} = args;
  const ids = groupId
    ? [groupId]
    : Object.keys(conversations).filter(id => {
        const c = conversations[id];
        return c?.type === 'group' || c?.type === 'ops_channel';
      });
  return ids.filter(id => divergence === true || !groups[id]?.masterKeyB64);
}

/**
 * B-124/B-125 — one-shot cleanup of call-escalation contamination.
 *
 * The prunes that already exist cannot reach these rows (the ghost prune
 * skips non-group types; the server-reconciliation prune only touches
 * dashed-UUID ids; the ad-hoc group is never registered server-side), so
 * already-affected installs stay broken even after the routing fixes. The
 * criteria are deliberately tight — every shape below is PROVABLY bogus:
 *
 *   1. A conversation whose id is `direct:<ownUserId>` — a 1:1 with
 *      yourself cannot exist; it is the shadow-minted duplicate from a
 *      peer's contaminated group-stamped sends.
 *   2. A group-TYPED conversation whose id is `direct:`-prefixed — real
 *      groups are 32-hex / server UUIDs; this is the stash-placeholder junk
 *      thread minted from a contaminated stamp (pre-guard builds).
 *   3. A `'Call'`-named GroupState aliased under a `direct:`-shaped id or a
 *      `type: 'direct'` conversation's id — the transient call-key carrier
 *      filed under a chat-bearing slot. Purging at boot is safe (no live
 *      call) and the next call simply re-mints.
 */
export function selectCallContaminationCleanup(
  state: {
    conversations: Record<string, {type?: string} | undefined>;
    groups: Record<string, {name?: string} | undefined>;
  },
  ownUserId: string,
): {conversationIdsToRemove: string[]; groupAliasIdsToPurge: string[]} {
  const conversationIdsToRemove: string[] = [];
  const groupAliasIdsToPurge: string[] = [];
  const selfSlot = `direct:${ownUserId}`;
  for (const [id, convo] of Object.entries(state.conversations)) {
    if (!convo) {continue;}
    if (id === selfSlot) {
      conversationIdsToRemove.push(id);
      continue;
    }
    if (convo.type === 'group' && id.startsWith('direct:')) {
      conversationIdsToRemove.push(id);
    }
  }
  for (const [id, gs] of Object.entries(state.groups)) {
    if (!isCallGroupState(gs)) {continue;}
    if (id.startsWith('direct:') || state.conversations[id]?.type === 'direct') {
      groupAliasIdsToPurge.push(id);
    }
  }
  return {conversationIdsToRemove, groupAliasIdsToPurge};
}
