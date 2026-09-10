/**
 * B-433 — a REMOVED member must stop being rung.
 *
 * Founder, on the vc272 build: "if i remove someone from the group and start a
 * call that removed person got a ring, it should not be like that."
 *
 * ── WHY IT HAPPENED ─────────────────────────────────────────────────────────
 *
 * `computeRingSet` (ringSet.ts, B-247) is a deliberate UNION of five sources,
 * because each one is blind in a different situation and the bug it fixed was
 * "not enough people get rung". Two of those sources are conversation-row
 * fields — and only ONE of them was stale:
 *
 *   participants    ALREADY CORRECT. `setGroupState` rewrites it from
 *                   `Object.keys(state.members)` for every group / ops_channel
 *                   row (messengerStore, L9), and both removal paths call that
 *                   before they get here. Narrowing it below is therefore a
 *                   no-op in every reachable device shape; it is kept only so
 *                   this helper states the whole rule in one place and cannot
 *                   be defeated if that lockstep is ever relaxed.
 *   rosterUserIds   THE BUG. Written once at create/receive and never
 *                   narrowed, and `upsertConversation` keeps it STICKY on
 *                   purpose (B-247) so an upsert that omits the field inherits
 *                   it. The Home sync omits it, so the stale value is
 *                   re-carried on every focus — and it is persisted, so it
 *                   survives restarts.
 *
 * So the removed user survived in the roster forever, the union put them back
 * into the ring set, and the relay dutifully rang them.
 *
 * The union cannot simply drop the roster: `groupMembers` is authoritative for
 * who is GONE but not for who is NEW (a just-added member may have no crypto
 * state on this device yet), so "not in groupMembers ⇒ do not ring" would
 * re-open B-247 from the other side. The correct fix is to stop the row from
 * being stale in the first place — a removal is an explicit, signed admin
 * action, so we know exactly who to drop.
 *
 * A stale roster is wrong everywhere it is read, not just for ringing. Fixing
 * the row fixes the class; patching `computeRingSet` would have fixed one
 * caller and left the next one to rediscover it.
 *
 * ── WHY ONE HELPER ──────────────────────────────────────────────────────────
 *
 * There are TWO removal paths and the founder's repro runs the first one:
 *
 *   1. the REMOVER's own device  — productionRuntime, right after it applies
 *      the remove to local group state. This is the device that then taps Call.
 *   2. every OTHER member        — applyGroupAdmin's receive branch.
 *
 * Both must narrow, or the roster stays stale on whichever side was missed —
 * and two copies of "apply a removal" is exactly the shape that produced
 * B-286's six drifted avatar-colour functions. Same one-helper-two-callers
 * rule as `applyGroupRenameToUi` (B-290).
 */
import {useMessengerStore} from '../store/messengerStore';

/**
 * Drop a removed member from the conversation row's membership fields.
 *
 * Idempotent and safe to call when the member is already absent, when the row
 * does not exist (a member removed before their row was ever created), and on
 * the removed user's own device (B-337 purges that row separately; narrowing
 * first is harmless).
 *
 * Returns what changed so callers can log honestly rather than assume.
 */
export function applyMemberRemovalToUi(params: {
  groupId:       string;
  removedUserId: string;
}): {rowUpdated: boolean; hadRoster: boolean} {
  const {groupId, removedUserId} = params;
  if (!groupId || !removedUserId) {return {rowUpdated: false, hadRoster: false};}

  const store = useMessengerStore.getState();
  const row = store.conversations[groupId];
  if (!row) {return {rowUpdated: false, hadRoster: false};}

  const hadRoster = Array.isArray(row.rosterUserIds);
  const nextRoster = row.rosterUserIds?.filter(u => u !== removedUserId);
  const nextParticipants = row.participants?.filter(u => u !== removedUserId);

  const rosterChanged =
    !!row.rosterUserIds && nextRoster!.length !== row.rosterUserIds.length;
  const participantsChanged =
    !!row.participants && nextParticipants!.length !== row.participants.length;
  if (!rosterChanged && !participantsChanged) {
    return {rowUpdated: false, hadRoster};
  }

  /**
   * Spread the existing row: `upsertConversation` is a REPLACE, not a merge
   * (B-247), so a partial object would wipe the unread count, last_message and
   * the name-source flag.
   *
   * Passing `rosterUserIds` explicitly is what makes this write ALLOWED to
   * narrow — the store keeps the previous roster only when the incoming upsert
   * omits the field ("only an upsert that actually knows the true roster may
   * change it"). A signed removal is precisely that.
   */
  store.upsertConversation({
    ...row,
    ...(row.rosterUserIds ? {rosterUserIds: nextRoster} : {}),
    ...(row.participants ? {participants: nextParticipants} : {}),
  });
  return {rowUpdated: true, hadRoster};
}

/**
 * Repair a roster that went stale BEFORE this fix existed.
 *
 * Narrowing on the removal event only helps removals that happen from now on.
 * `rosterUserIds` is persisted and has no self-repair — the Home sync omits the
 * field, so stickiness re-carries the stale value on every focus, forever. So
 * on an install that removed someone last week, that person keeps getting rung
 * even with the fix in. Found in review; without this the founder's own group
 * would still have been broken.
 *
 * The repair uses data we already hold durably and did not have to invent: the
 * `member_removed` / `member_added` system rows in the group's own transcript,
 * written by `appendMemberRemovedEvent` / `appendMemberAddedEvent` on every
 * device. LAST event per user wins, so someone removed and later re-added is
 * correctly left in the roster.
 *
 * Deliberately NOT "subtract anyone missing from crypto membership" — that is
 * the tempting one-liner and it re-opens B-247, because a just-added member
 * legitimately has no crypto state on this device yet.
 *
 * Idempotent and cheap (one pass over one conversation's rows), so it is safe
 * to call on the ring path where it is actually needed.
 */
export function repairRosterFromRemovalHistory(groupId: string): {repaired: string[]} {
  const store = useMessengerStore.getState();
  const row = store.conversations[groupId];
  if (!row?.rosterUserIds?.length) {return {repaired: []};}

  const rows = (store.messages?.[groupId] ?? []) as Array<{
    event?: {kind?: string; memberUserId?: string};
  }>;
  if (!rows.length) {return {repaired: []};}

  // Last membership event per user decides. Transcript order is chronological.
  const gone = new Map<string, boolean>();
  for (const m of rows) {
    const k = m.event?.kind;
    const uid = m.event?.memberUserId;
    if (!uid) {continue;}
    if (k === 'member_removed') {gone.set(uid, true);}
    else if (k === 'member_added') {gone.set(uid, false);}
  }

  const repaired = row.rosterUserIds.filter(u => gone.get(u) === true);
  for (const uid of repaired) {applyMemberRemovalToUi({groupId, removedUserId: uid});}
  if (repaired.length) {
    console.warn(
      `[group-roster] repaired stale roster for ${groupId.slice(0, 8)} — dropped ${repaired.length} previously-removed member(s) (B-433)`,
    );
  }
  return {repaired};
}
