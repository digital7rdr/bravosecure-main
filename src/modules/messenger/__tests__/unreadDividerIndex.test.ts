import {unreadDividerIndex} from '@/modules/messenger/ui/chatListLayout';

/**
 * BS-UD1 — the unread divider must sit before the Nth-from-last INBOUND
 * message, not the Nth-from-last row. The old arithmetic
 * (messages.length - unreadCount) mislaid the divider whenever the
 * user's own sends were interleaved in the unread tail.
 */
function inbound(id: string) { return {id, sender_id: 'peer'}; }
function mine(id: string)    { return {id, sender_id: 'self'}; }

describe('unreadDividerIndex', () => {
  it('returns -1 when there are no unread messages', () => {
    expect(unreadDividerIndex([inbound('a'), mine('b')], 0)).toBe(-1);
  });

  it('places the divider before the first unread inbound (no self interleaving)', () => {
    // 4 messages, 2 unread → divider before index 2.
    const msgs = [inbound('a'), inbound('b'), inbound('c'), inbound('d')];
    expect(unreadDividerIndex(msgs, 2)).toBe(2);
  });

  it('skips self-sends interleaved in the unread tail (the bug case)', () => {
    // read inbound, read self, then 2 unread inbound with a self-send
    // between them. unreadCount=2 must point at the FIRST of the two
    // unread inbound rows (index 2), NOT messages.length - 2 = index 3.
    const msgs = [
      inbound('read'),   // 0  (read)
      mine('myreply'),   // 1  (self, read)
      inbound('u1'),     // 2  (unread #1)  ← divider belongs here
      mine('mysend'),    // 3  (self, interleaved)
      inbound('u2'),     // 4  (unread #2)
    ];
    // Naive messages.length - unreadCount = 5 - 2 = 3 (a self-send) — wrong.
    expect(unreadDividerIndex(msgs, 2)).toBe(2);
  });

  it('counts only inbound when the tail is all self-sends after the unread', () => {
    const msgs = [
      inbound('u1'),   // 0 ← only unread inbound
      mine('s1'),      // 1
      mine('s2'),      // 2
    ];
    expect(unreadDividerIndex(msgs, 1)).toBe(0);
  });

  it('anchors to the top when fewer inbound rows are loaded than the counter', () => {
    // Counter says 5 unread but only 2 inbound rows are loaded.
    const msgs = [inbound('a'), mine('b'), inbound('c')];
    expect(unreadDividerIndex(msgs, 5)).toBe(0);
  });

  it('returns -1 for an empty list even with a positive counter', () => {
    expect(unreadDividerIndex([], 3)).toBe(-1);
  });
});
