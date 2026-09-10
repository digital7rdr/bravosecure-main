/**
 * Pure layout helpers for the chat message list. Kept free of React /
 * react-native imports so they're unit-testable in a node env.
 */

/**
 * BS-UD1 — index at which the "Unread N messages" divider should sit:
 * just BEFORE the Nth-from-last INBOUND message. Returns -1 when there
 * are no unread.
 *
 * `unreadCount` (= conversation.unread_count) counts only inbound
 * messages, but the loaded list also contains our own sends. The naive
 * `messages.length - unreadCount` assumed every trailing row was
 * inbound, so any self-send interleaved in the unread tail (you replied,
 * went offline, more inbound arrived) pushed the divider too high —
 * hiding read self-messages under it or burying unread inbound above it.
 * Walking back from the end counting only inbound rows places the
 * divider correctly regardless of interleaving. When fewer inbound rows
 * are loaded than the counter (hydrate-window cap / counter drift) we
 * fall back to the top of the loaded slice so the divider still shows.
 */
export function unreadDividerIndex(
  messages: ReadonlyArray<{sender_id?: string | null}>,
  unreadCount: number,
): number {
  if (unreadCount <= 0) {return -1;}
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].sender_id !== 'self') {
      seen += 1;
      if (seen === unreadCount) {return i;}
    }
  }
  // Fewer loaded inbound rows than the counter — anchor to the top.
  return messages.length > 0 ? 0 : -1;
}
