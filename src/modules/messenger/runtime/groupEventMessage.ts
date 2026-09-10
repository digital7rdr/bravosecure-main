/**
 * SN-11 — group membership changes leave a visible trace in the thread.
 *
 * Before this, adding someone was completely invisible in the conversation:
 * the admin saw no confirmation (the only Alert was gated on a branch that
 * never fired for locally-derived group ids) and the other members saw
 * nothing at all — a new participant simply started appearing. Users read the
 * silence as "the add didn't work", re-opened the picker and added the same
 * person again, which is what produced most of the "already a member" reports
 * behind ISSUE 02.
 *
 * Kept in its own tiny module (no native/runtime imports beyond the store) so
 * the message shape can be unit-tested without standing up the messenger
 * runtime — same rationale as `media/attachmentError.ts`.
 */

import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage} from '../store/types';

/**
 * Deterministic id for a membership event.
 *
 * Keyed by (group, member, epoch) because every add advances the group epoch
 * exactly once. Both the adding device and every receiving device therefore
 * derive the SAME id for the same event, so a re-delivered admin envelope,
 * a pending-envelope drain, or a restore replay all collapse onto one row
 * instead of stacking duplicate "X added Y" lines.
 */
export function memberAddedMessageId(groupId: string, addedUserId: string, epoch: number): string {
  return `sys:add:${groupId}:${addedUserId}:${epoch}`;
}

/**
 * Best-effort display name for a user id.
 *
 * B-223 — precedence (the app-wide B-115 order): group-member name/override
 * (dept groups hydrate real names there) > direct-convo custom/contact name >
 * session directory name (populated from /conversations/mine + /users/profiles)
 * > peer phone number (E.164, WhatsApp parity, only ever held for a discovered
 * contact) > short-id fragment. A
 * fragment miss fires a debounced directory backfill so a later re-render (the
 * group-event line is re-derived via `memberAddedContentFor`) resolves the real
 * name instead of leaving a baked "Member 613949" forever.
 */
export function resolveMemberName(userId: string, selfUserId?: string, groupId?: string): string {
  if (selfUserId && userId === selfUserId) {return 'You';}
  const st = useMessengerStore.getState();
  // Department/roster groups hydrate real display names into groupMemberNames
  // (see DepartmentChatScreen's focus-effect) — check that BEFORE falling
  // back to the 1:1 direct-conversation name, which a group-only member (no
  // 1:1 thread with the actor) would never have.
  const groupName = groupId ? st.groupMemberNames[groupId]?.[userId] : undefined;
  if (groupName) {return groupName;}
  const direct = st.conversations[`direct:${userId}`];
  if (direct?.name) {return direct.name;}
  const namedConvo = Object.values(st.conversations).find(
    c => c.type === 'direct' && c.peer?.userId === userId && !!c.name,
  );
  if (namedConvo?.name) {return namedConvo.name;}
  const dir = st.directoryNames?.[userId];
  if (dir?.trim()) {return dir.trim();}
  // A known phone beats an opaque code. We only ever hold one for a peer we
  // discovered as a contact (the server profile endpoint never exposes phones).
  const phone = direct?.phoneE164
    ?? Object.values(st.conversations).find(c => c.type === 'direct' && c.peer?.userId === userId)?.phoneE164;
  if (phone) {return phone;}
  // Miss — queue a directory backfill (fire-and-forget) so a re-render resolves.
  try {
    const {ensureDirectoryNames} = require('../contacts/directoryNames') as typeof import('../contacts/directoryNames');
    ensureDirectoryNames([userId]);
  } catch { /* offline / pre-auth — the fragment below is the offline-safe last resort */ }
  return `Member ${userId.slice(0, 6)}`;
}

/** Inverse of `memberAddedMessageId` — {groupId, addedUserId, epoch} or null. */
export function parseMemberAddedId(
  id: string,
): {groupId: string; addedUserId: string; epoch: number} | null {
  // sys:add:<groupId>:<addedUserId>:<epoch>. groupId/userId can themselves
  // contain ':' only in pathological cases; the epoch is the final numeric
  // segment and the addedUserId the one before it, so split from the RIGHT.
  if (!id.startsWith('sys:add:')) {return null;}
  const rest = id.slice('sys:add:'.length);
  const lastColon = rest.lastIndexOf(':');
  if (lastColon < 0) {return null;}
  const epoch = Number(rest.slice(lastColon + 1));
  const head = rest.slice(0, lastColon);
  const midColon = head.lastIndexOf(':');
  if (midColon < 0 || Number.isNaN(epoch)) {return null;}
  const addedUserId = head.slice(midColon + 1);
  const groupId = head.slice(0, midColon);
  if (!groupId || !addedUserId) {return null;}
  return {groupId, addedUserId, epoch};
}

/**
 * B-223 — RENDER-TIME re-derivation of a "<actor> added <member>" line. The
 * event content is baked once at receive time (for backup / notifications /
 * non-render consumers), so a name that arrives AFTER the bake (the added member
 * only shows up in /conversations/mine on the next sync) would otherwise stay a
 * frozen "Member 613949". A render surface calls this for a `sys:add:` system
 * message to re-resolve both names from the CURRENT store; returns null for any
 * message that isn't a parseable add-event (caller falls back to msg.content).
 */
export function memberAddedContentFor(
  msg: {id: string; type: string; sender_id?: string | null},
  selfUserId?: string,
): string | null {
  if (msg.type !== 'system') {return null;}
  const parsed = parseMemberAddedId(msg.id);
  if (!parsed) {return null;}
  const actor = resolveMemberName(msg.sender_id ?? parsed.groupId, selfUserId, parsed.groupId);
  const added = resolveMemberName(parsed.addedUserId, selfUserId, parsed.groupId);
  return `${actor} added ${added === 'You' ? 'you' : added}`;
}

/**
 * Render the display text for a structured system membership/rename event,
 * resolving names LIVE from the current store.
 *
 * Called at RENDER time (not creation) so a name that only hydrated after the
 * row was synthesized — the auto-add case, where the E2EE admin envelope
 * carries no name and the roster fills in on focus — shows correctly instead of
 * a frozen "Member <code>". Returns null for an unknown event kind so the
 * caller can fall back to the message's baked `content`.
 */
export function systemEventText(
  event: NonNullable<LocalMessage['event']>,
  opts?: {selfUserId?: string; groupId?: string},
): string | null {
  const {selfUserId, groupId} = opts ?? {};
  if (event.kind === 'member_added') {
    const actor = resolveMemberName(event.actorUserId, selfUserId, groupId);
    const added = resolveMemberName(event.memberUserId, selfUserId, groupId);
    return `${actor} added ${added === 'You' ? 'you' : added}`;
  }
  if (event.kind === 'member_removed') {
    const actor = resolveMemberName(event.actorUserId, selfUserId, groupId);
    const removed = resolveMemberName(event.memberUserId, selfUserId, groupId);
    // "You removed Sam" / "Alex removed you" — the same shape as the add line,
    // because the reader is answering the same question either way.
    return `${actor} removed ${removed === 'You' ? 'you' : removed}`;
  }
  if (event.kind === 'channel_renamed') {
    const actor = event.actorUserId ? resolveMemberName(event.actorUserId, selfUserId, groupId) : 'Someone';
    return `${actor} renamed the channel to "${event.newName}"`;
  }
  if (event.kind === 'group_photo_changed') {
    const actor = event.actorUserId ? resolveMemberName(event.actorUserId, selfUserId, groupId) : 'Someone';
    return event.cleared
      ? `${actor} removed the group photo`
      : `${actor} changed the group photo`;
  }
  return null;
}

/**
 * Append a "<actor> added <member>" system line to the group thread.
 *
 * No-ops when an identical event is already present, so callers on both the
 * send and receive paths can invoke it unconditionally.
 */
export function appendMemberAddedEvent(params: {
  groupId:     string;
  actorUserId: string;
  addedUserId: string;
  epoch:       number;
  selfUserId?: string;
}): LocalMessage | null {
  const {groupId, actorUserId, addedUserId, epoch, selfUserId} = params;
  if (!groupId || !addedUserId) {return null;}

  const id = memberAddedMessageId(groupId, addedUserId, epoch);
  const store = useMessengerStore.getState();
  if (store.messages[groupId]?.some(m => m.id === id)) {return null;}

  // B-223 — queue a directory backfill for both ids so a name we don't yet hold
  // (a freshly-added member isn't in /conversations/mine until the next sync)
  // resolves on a later re-render via memberAddedContentFor.
  try {
    const {ensureDirectoryNames} = require('../contacts/directoryNames') as typeof import('../contacts/directoryNames');
    ensureDirectoryNames([actorUserId, addedUserId]);
  } catch { /* best-effort */ }

  const actor = resolveMemberName(actorUserId, selfUserId, groupId);
  const added = resolveMemberName(addedUserId, selfUserId, groupId);
  // "You added Sam" / "Alex added you" — never two raw ids.
  const content = `${actor} added ${added === 'You' ? 'you' : added}`;

  const msg: LocalMessage = {
    id,
    conversation_id: groupId,
    sender_id:       actorUserId,
    type:            'system',
    content,
    // Structured so the renderer re-resolves the added member's name live once
    // the roster hydrates — the auto-add path has no name at creation time.
    event:           {kind: 'member_added', actorUserId, memberUserId: addedUserId},
    status:          'delivered',
    is_encrypted:    false,
    created_at:      new Date().toISOString(),
    // The actor is the "peer" for this event. deviceId 1 matches the
    // phase-1 single-device assumption used across the runtime.
    peer:            {userId: actorUserId, deviceId: 1},
  };
  store.appendMessage(groupId, msg);
  return msg;
}

/**
 * B-255 — deterministic id for a removal, same shape as the add id so both
 * sides of the fan-out converge on ONE row and a re-delivered admin envelope
 * cannot stack duplicates.
 */
export function memberRemovedMessageId(groupId: string, removedUserId: string, epoch: number): string {
  return `sys:remove:${groupId}:${removedUserId}:${epoch}`;
}

/**
 * Append a "<actor> removed <member>" system line to the group thread.
 *
 * THE BUG this closes: adding someone left a visible trace, removing them left
 * NOTHING. The roster silently shrank, the removed member's device just went
 * quiet, and nobody could tell whether a person had left, been removed, or the
 * group had broken — a membership change with no audit trail in the one place
 * every member is looking.
 *
 * Mirrors `appendMemberAddedEvent` exactly: idempotent on the deterministic id,
 * safe to call unconditionally from both the sender and receiver paths.
 */
export function appendMemberRemovedEvent(params: {
  groupId:       string;
  actorUserId:   string;
  removedUserId: string;
  epoch:         number;
  selfUserId?:   string;
}): LocalMessage | null {
  const {groupId, actorUserId, removedUserId, epoch, selfUserId} = params;
  if (!groupId || !removedUserId) {return null;}

  const id = memberRemovedMessageId(groupId, removedUserId, epoch);
  const store = useMessengerStore.getState();
  if (store.messages[groupId]?.some(m => m.id === id)) {return null;}

  // Backfill both names — a removed member may already be out of the roster by
  // the time this renders, so the directory is the only source left for them.
  try {
    const {ensureDirectoryNames} = require('../contacts/directoryNames') as typeof import('../contacts/directoryNames');
    ensureDirectoryNames([actorUserId, removedUserId]);
  } catch { /* best-effort */ }

  const actor = resolveMemberName(actorUserId, selfUserId, groupId);
  const removed = resolveMemberName(removedUserId, selfUserId, groupId);
  const content = `${actor} removed ${removed === 'You' ? 'you' : removed}`;

  const msg: LocalMessage = {
    id,
    conversation_id: groupId,
    sender_id:       actorUserId,
    type:            'system',
    content,
    event:           {kind: 'member_removed', actorUserId, memberUserId: removedUserId},
    status:          'delivered',
    is_encrypted:    false,
    created_at:      new Date().toISOString(),
    peer:            {userId: actorUserId, deviceId: 1},
  };
  store.appendMessage(groupId, msg);
  return msg;
}

/**
 * Deterministic id for a channel-rename event, keyed by the server's
 * name_changed_at stamp so a repeated poll of the same value collapses onto
 * one row (appendMessage's own id-uniqueness) instead of re-announcing the
 * same rename every focus.
 */
export function channelRenamedMessageId(groupId: string, changedAtIso: string): string {
  return `sys:rename:${groupId}:${changedAtIso}`;
}

/**
 * WhatsApp-style "<actor> renamed the channel to <name>" system line.
 *
 * The channel name is plaintext server metadata (not E2EE), so this is
 * synthesized LOCALLY from department-channel polling (name_changed_by/
 * name_changed_at) rather than sent as an encrypted group message — every
 * member's device derives the identical row from the same server fields.
 */
export function appendChannelRenamedEvent(params: {
  groupId:       string;
  actorUserId:   string | null;
  newName:       string;
  changedAtIso:  string;
  selfUserId?:   string;
}): LocalMessage | null {
  const {groupId, actorUserId, newName, changedAtIso, selfUserId} = params;
  if (!groupId || !newName || !changedAtIso) {return null;}

  const id = channelRenamedMessageId(groupId, changedAtIso);
  const store = useMessengerStore.getState();
  if (store.messages[groupId]?.some(m => m.id === id)) {return null;}

  const actor = actorUserId ? resolveMemberName(actorUserId, selfUserId, groupId) : 'Someone';
  const content = `${actor} renamed the channel to "${newName}"`;

  const msg: LocalMessage = {
    id,
    conversation_id: groupId,
    sender_id:       actorUserId ?? groupId,
    type:            'system',
    content,
    event:           {kind: 'channel_renamed', actorUserId, newName},
    status:          'delivered',
    is_encrypted:    false,
    created_at:      changedAtIso,
    peer:            {userId: actorUserId ?? groupId, deviceId: 1},
  };
  store.appendMessage(groupId, msg);
  return msg;
}

/**
 * B-291 — deterministic id for a group-photo change, keyed on the group and the
 * change timestamp. Same reasoning as `channelRenamedMessageId`: the sender and
 * every receiver derive the id from the post-apply state's `updatedAt`, so all
 * devices converge on ONE row and a re-delivered or drained admin envelope
 * cannot stack duplicates.
 */
export function groupPhotoChangedMessageId(groupId: string, changedAtIso: string): string {
  return `sys:photo:${groupId}:${changedAtIso}`;
}

/**
 * Append a "<actor> changed the group photo" system line.
 *
 * No-ops when an identical event is already present, so both the send and
 * receive paths can call it unconditionally.
 */
export function appendGroupPhotoChangedEvent(params: {
  groupId:      string;
  actorUserId:  string | null;
  cleared:      boolean;
  changedAtIso: string;
  selfUserId?:  string;
}): LocalMessage | null {
  const {groupId, actorUserId, cleared, changedAtIso, selfUserId} = params;
  if (!groupId || !changedAtIso) {return null;}

  const id = groupPhotoChangedMessageId(groupId, changedAtIso);
  const store = useMessengerStore.getState();
  if (store.messages[groupId]?.some(m => m.id === id)) {return null;}

  const event = {kind: 'group_photo_changed' as const, actorUserId, cleared};
  // `content` is the fallback for old renderers, backup mirrors and any row
  // read by something that does not know this event kind.
  const content = systemEventText(event, {selfUserId, groupId})
    ?? (cleared ? 'Group photo removed' : 'Group photo changed');

  const msg: LocalMessage = {
    id,
    conversation_id: groupId,
    sender_id:       actorUserId ?? groupId,
    type:            'system',
    content,
    event,
    status:          'delivered',
    is_encrypted:    false,
    created_at:      changedAtIso,
    peer:            {userId: actorUserId ?? groupId, deviceId: 1},
  };
  store.appendMessage(groupId, msg);
  return msg;
}
