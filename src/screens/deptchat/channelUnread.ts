import {useMessengerStore} from '@/modules/messenger/store/messengerStore';

/**
 * THE unread rule for department channels.
 *
 * A channel's unread count is NOT on the channel DTO — the server never sees
 * plaintext, so it cannot count what you have read. It lives in the encrypted
 * messenger store, keyed by the channel's group conversation id, and a channel
 * with no group yet has nothing to be unread.
 *
 * Three surfaces need it (the header total, the flat channel row, the
 * organisation tree) and the first two had already grown their own copy of the
 * same expression. The third — the nested path introduced by item 6 — shipped
 * with NO unread signal at all, so on a workspace whose channels are all nested
 * the "where is the new message" affordance simply disappeared, while the
 * header total kept counting it. One rule, one place.
 */
export function unreadOfGroup(
  conversations: Record<string, {unread_count?: number} | undefined>,
  groupConversationId?: string | null,
): number {
  if (!groupConversationId) {return 0;}
  return conversations[groupConversationId]?.unread_count ?? 0;
}

/** One channel's unread badge count. */
export function useChannelUnread(groupConversationId?: string | null): number {
  return useMessengerStore(s => unreadOfGroup(s.conversations, groupConversationId));
}

/**
 * Unread across a set of channels — what an ORGANISATION row must show, since
 * the row itself is a container and the unread lives in its descendants.
 *
 * Why: the selector returns a NUMBER, so a fresh `ids` array each render costs
 * a re-run of the sum but never a re-render; zustand compares the result.
 */
export function useAggregateUnread(groupConversationIds: (string | null | undefined)[]): number {
  return useMessengerStore(s =>
    groupConversationIds.reduce((sum, id) => sum + unreadOfGroup(s.conversations, id), 0));
}
