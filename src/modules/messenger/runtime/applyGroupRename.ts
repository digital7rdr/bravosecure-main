/**
 * B-290 — a group rename must land on the CONVERSATION row, on every device.
 *
 * Founder, on the B-289 build: "i change the name but the changed name does not
 * show to me. admin change the name, i am in these group, for me the name is
 * not showing."
 *
 * The bug: `applyAdminAction`'s `rename` case updates `groups[id].name` — the
 * crypto state — and NOTHING reads that for display. The chat list, the chat
 * header and the info sheet all render `conversations[id].name`. So the rename
 * applied correctly and was invisible.
 *
 * The receive path made it worse: `applyGroupAdmin` appends a system line and
 * reconciles for `add` and `remove`, but had no `rename` branch at all, so a
 * member's device recorded the new name in crypto state and showed the old one
 * forever.
 *
 * ONE helper, called from BOTH the local emitter and the receive path, because
 * two copies of "apply a rename" is precisely the shape that produced B-286's
 * six drifted avatar-colour functions. If the display rule ever changes it
 * changes here, for both sides, or not at all.
 */
import {useMessengerStore} from '../store/messengerStore';
import {appendChannelRenamedEvent} from './groupEventMessage';

/**
 * Reflect a group rename in everything the user can actually see.
 *
 * Reads LIVE store state rather than accepting a snapshot: the emitter awaits a
 * cert fetch and a fan-out before it gets here, and a snapshot captured before
 * those awaits is stale by the time the row is written.
 *
 * Idempotent. `appendChannelRenamedEvent` dedupes on a deterministic id, and the
 * row write is a plain assignment, so a re-delivered or drained admin envelope
 * cannot double-post or flip the name back.
 */
export function applyGroupRenameToUi(params: {
  groupId:      string;
  newName:      string;
  /** Who renamed it — null when the envelope carried no attributable sender. */
  actorUserId:  string | null;
  selfUserId?:  string;
  /** From the post-apply group state's `updatedAt`, so both sides mint one id. */
  changedAtIso: string;
}): {rowUpdated: boolean} {
  const {groupId, newName, actorUserId, selfUserId, changedAtIso} = params;
  if (!groupId || !newName) {return {rowUpdated: false};}

  const store = useMessengerStore.getState();
  const row = store.conversations[groupId];
  let rowUpdated = false;
  if (row) {
    // `upsertConversation` is a REPLACE, not a merge (B-247), so the existing
    // row must be spread — a bare {id, name} would wipe rosterUserIds, the
    // unread count and last_message.
    //
    // `is_custom_name` marks the label user-chosen, which is what stops the
    // ghost-row sweep and the contact-discovery rename from reverting it.
    store.upsertConversation({...row, name: newName, is_custom_name: true});
    rowUpdated = true;
  } else {
    // No row means no list entry and no open thread to be wrong about — the
    // crypto state still carries the name, so whenever the row is created it
    // will be created with it. Worth a line because the alternative reading
    // ("the rename silently did nothing") is the bug we just fixed.
    console.warn(`[group-rename] no conversation row for ${groupId}; name applied to group state only`);
  }

  appendChannelRenamedEvent({
    groupId,
    actorUserId,
    newName,
    changedAtIso,
    selfUserId,
  });
  return {rowUpdated};
}
