/**
 * "Is this conversation a department channel?" — for the MESSENGER LISTS.
 *
 * ── THE BUG THIS FIXES (founder-reported on device, 2026-08-05) ─────────────
 *
 * Department channels were showing up in the ordinary Messenger chat list and
 * the Groups tab, for everyone. They must not: the workspace is their own
 * surface, and a channel opened from the messenger list lands on `ChatScreen`,
 * which renders the call buttons the PDF's A9/M9 rule forbids.
 *
 * Both screens DID filter them — but each did it from a NETWORK CALL
 * (`departmentApi.listChannels()`), and a filter that has to finish a round
 * trip before it can hide anything is not a filter, it is a race:
 *
 *   • on a cold boot the set is EMPTY, so every channel is visible until the
 *     request lands — the flash the founder actually saw;
 *   • offline, the request never lands, so they stay visible ALL SESSION;
 *   • `listChannels` 403s for a non-member, and the catch leaves the set empty;
 *   • `GroupsScreen`'s was mount-only (not focus), so it never refreshed at all.
 *
 * ── THE FIX ─────────────────────────────────────────────────────────────────
 *
 * Ask the STORE instead. `deptConversationIds` is an additive, PERSISTED set
 * that `armDeptConversationRegistry()` fills at messenger boot in all three
 * shells, and `deptGroupByChannel` is the channel pointer. Neither needs the
 * network at read time, both survive a cold boot, and both are already the
 * signals `resolveDeptConversation` uses to decide where a notification tap
 * goes.
 *
 * Reusing that exact function is the point: ONE predicate now answers both
 * "hide this row from the messenger list" and "route this tap to
 * DepartmentChat". Previously those were separate implementations that could —
 * and did — disagree, which is this repo's most-repeated defect shape.
 *
 * The network set is kept alongside as belt-and-braces for a channel this
 * device has genuinely never recorded; it can only ADD to what the store knows,
 * never gate it.
 */
import {useCallback} from 'react';
import {useMessengerStore} from '@/modules/messenger/store';
import {resolveDeptConversation} from '@/modules/messenger/push/deptChannelTarget';

/**
 * Returns a stable predicate: true when the conversation is departmental and
 * must therefore be kept OUT of the messenger lists.
 *
 * Subscribes to both registry maps, so an arming that happens after first paint
 * re-renders the list and the rows disappear on their own.
 */
export function useIsDeptConversation(): (conversationId: string) => boolean {
  const deptConversationIds = useMessengerStore(s => s.deptConversationIds);
  const deptGroupByChannel  = useMessengerStore(s => s.deptGroupByChannel);

  return useCallback(
    (conversationId: string) =>
      resolveDeptConversation(conversationId, {deptConversationIds, deptGroupByChannel}) !== null,
    [deptConversationIds, deptGroupByChannel],
  );
}
