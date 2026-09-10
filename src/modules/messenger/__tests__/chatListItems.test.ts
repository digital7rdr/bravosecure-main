import {
  buildChatListItems,
  buildInvertedChatListItems,
  type ChatListItem,
} from '../ui/chatListItems';
import type {LocalMessage} from '../store';

function msg(id: string, createdAt: string, senderId: string = 'peer'): LocalMessage {
  return {
    id,
    conversation_id: 'c1',
    sender_id: senderId,
    type: 'text',
    content: `body-${id}`,
    status: 'delivered',
    created_at: createdAt,
    is_encrypted: true,
    peer: {userId: 'peer', deviceId: 1},
  } as unknown as LocalMessage;
}

const kinds = (items: ChatListItem[]) => items.map(i => i.kind);
const keys  = (items: ChatListItem[]) => items.map(i => i.key);

// Why: fixtures are LOCAL-time strings (no Z) — the builder groups by
// local day, so UTC instants would land on different local days in some
// timezones and flake the day-separator assertions on CI.

describe('buildChatListItems — chronological interleave', () => {
  it('inserts one day separator per day boundary, before that day\'s first message', () => {
    const items = buildChatListItems([
      msg('a', '2026-07-15T09:00:00'),
      msg('b', '2026-07-15T10:00:00'),
      msg('c', '2026-07-16T08:00:00'),
    ], 0);
    expect(kinds(items)).toEqual(['day', 'msg', 'msg', 'day', 'msg']);
    expect(keys(items)[1]).toBe('a');
    expect(keys(items)[4]).toBe('c');
  });

  it('places the unread divider before the Nth-from-last inbound message', () => {
    const items = buildChatListItems([
      msg('a', '2026-07-16T08:00:00'),
      msg('mine', '2026-07-16T08:30:00', 'self'),
      msg('b', '2026-07-16T09:00:00'),
      msg('c', '2026-07-16T09:30:00'),
    ], 2);
    // Divider sits before 'b' (2 unread inbound: b, c — self-send skipped).
    const unreadIdx = items.findIndex(i => i.kind === 'unread');
    expect(unreadIdx).toBeGreaterThan(-1);
    expect(items[unreadIdx + 1].key).toBe('b');
    expect((items[unreadIdx] as {count: number}).count).toBe(2);
  });

  it('keeps the chronological message index on each msg row (grouping input)', () => {
    const items = buildChatListItems([
      msg('a', '2026-07-15T09:00:00'),
      msg('b', '2026-07-16T09:00:00'),
    ], 0);
    const msgs = items.filter(i => i.kind === 'msg') as Array<{index: number; key: string}>;
    expect(msgs).toEqual([
      expect.objectContaining({key: 'a', index: 0}),
      expect.objectContaining({key: 'b', index: 1}),
    ]);
  });
});

describe('buildInvertedChatListItems — display order for the inverted FlatList', () => {
  it('newest message lands at index 0 and separators stay above their day (higher index)', () => {
    const items = buildInvertedChatListItems([
      msg('a', '2026-07-15T09:00:00'),
      msg('b', '2026-07-15T10:00:00'),
      msg('c', '2026-07-16T08:00:00'),
    ], 0);
    // Reversed: [c, day(16th), b, a, day(15th)] — in an inverted list the
    // higher index renders visually ABOVE, so each day separator still
    // paints above its day's messages.
    expect(keys(items)[0]).toBe('c');
    expect(kinds(items)).toEqual(['msg', 'day', 'msg', 'msg', 'day']);
    expect(items[items.length - 1].kind).toBe('day');
  });

  it('unread divider ends up immediately after (visually above) its anchor message', () => {
    const items = buildInvertedChatListItems([
      msg('a', '2026-07-16T08:00:00'),
      msg('b', '2026-07-16T09:00:00'),
    ], 1);
    const bIdx = items.findIndex(i => i.key === 'b');
    expect(items[bIdx + 1].kind).toBe('unread');
  });
});

describe('MX-07 — identity stability across rebuilds', () => {
  it('reuses row objects when the underlying message objects are unchanged', () => {
    const a = msg('a', '2026-07-16T08:00:00');
    const b = msg('b', '2026-07-16T09:00:00');
    const first  = buildInvertedChatListItems([a, b], 0);
    const second = buildInvertedChatListItems([a, b], 0);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).toBe(first[2]); // day separator row too
  });

  it('mints a fresh row only for the replaced message object', () => {
    const a = msg('a', '2026-07-16T08:00:00');
    const b = msg('b', '2026-07-16T09:00:00');
    const first = buildInvertedChatListItems([a, b], 0);
    const b2 = {...b, status: 'read'} as LocalMessage;
    const second = buildInvertedChatListItems([a, b2], 0);
    const firstA  = first.find(i => i.key === 'a');
    const secondA = second.find(i => i.key === 'a');
    const firstB  = first.find(i => i.key === 'b');
    const secondB = second.find(i => i.key === 'b');
    expect(secondA).toBe(firstA);
    expect(secondB).not.toBe(firstB);
  });

  it('re-indexes cached rows when history is prepended (loadOlder)', () => {
    const b = msg('b', '2026-07-16T09:00:00');
    buildInvertedChatListItems([b], 0);
    const older = msg('old', '2026-07-16T08:00:00');
    const items = buildInvertedChatListItems([older, b], 0);
    const row = items.find(i => i.key === 'b') as {index: number};
    expect(row.index).toBe(1);
  });
});
