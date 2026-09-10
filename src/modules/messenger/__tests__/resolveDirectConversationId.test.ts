import {resolveDirectConversationIdFromState, directConversationSlots} from '@/modules/messenger/store';
import type {LocalConversation} from '@/modules/messenger/store';

/**
 * BS-NC1 / BS-TY1 — the direct-conversation resolver is the single rule
 * that prevents the split-brain "my messages went to an empty thread"
 * bug. Two HIGH fixes lean on it:
 *   - NewChatScreen now navigates to the CANONICAL id (so tapping a
 *     contact reuses an existing server-UUID row instead of minting a
 *     duplicate `direct:<peer>` thread).
 *   - The typing receive path resolves to the same canonical id so the
 *     "typing…" indicator lights the UUID-keyed ChatScreen.
 * These tests pin the resolution rules those fixes depend on.
 */

function conv(partial: Partial<LocalConversation> & {id: string}): LocalConversation {
  return {
    id:            partial.id,
    type:          partial.type ?? 'direct',
    name:          partial.name ?? 'Peer',
    participants:  partial.participants ?? [],
    unread_count:  0,
    is_muted:      false,
    created_at:    new Date('2026-01-01T00:00:00Z').toISOString(),
    peer:          partial.peer,
    session_state: 'fresh',
    ...partial,
  } as LocalConversation;
}

const PEER = 'user-alice';

describe('resolveDirectConversationIdFromState', () => {
  it('prefers the server-UUID row over the synthetic direct: key for the same peer', () => {
    const state = {
      groups: {},
      conversations: {
        [`direct:${PEER}`]: conv({id: `direct:${PEER}`, peer: {userId: PEER, deviceId: 1}}),
        'uuid-123':         conv({id: 'uuid-123', peer: {userId: PEER, deviceId: 1}}),
      },
    };
    expect(resolveDirectConversationIdFromState(state, PEER)).toBe('uuid-123');
  });

  it('falls back to the synthetic direct: key when no UUID row exists', () => {
    const state = {
      groups: {},
      conversations: {
        [`direct:${PEER}`]: conv({id: `direct:${PEER}`, peer: {userId: PEER, deviceId: 1}}),
      },
    };
    expect(resolveDirectConversationIdFromState(state, PEER)).toBe(`direct:${PEER}`);
  });

  it('returns the synthetic key for a cold contact with no row at all', () => {
    expect(resolveDirectConversationIdFromState({conversations: {}}, PEER)).toBe(`direct:${PEER}`);
  });

  it('ignores group rows and rows for a different peer', () => {
    const state = {
      groups: {},
      conversations: {
        'group-1':  conv({id: 'group-1', type: 'group', participants: [PEER, 'user-bob']}),
        'uuid-bob': conv({id: 'uuid-bob', peer: {userId: 'user-bob', deviceId: 1}}),
      },
    };
    // No direct row for Alice → synthetic; bob's UUID must not leak in.
    expect(resolveDirectConversationIdFromState(state, PEER)).toBe(`direct:${PEER}`);
    // And bob resolves to his own UUID, not the group.
    expect(resolveDirectConversationIdFromState(state, 'user-bob')).toBe('uuid-bob');
  });
});

/**
 * B-18 — a 1:1 thread's messages can be split across the synthetic
 * `direct:<peer>` slot and a server-UUID row (the canonical slot shifts
 * when /conversations/mine syncs a UUID row). `directConversationSlots`
 * returns EVERY slot for the peer so ChatScreen render + markRead cover
 * both — fixing "receiver sees only its own sent messages".
 */
describe('directConversationSlots — B-18 merge slots', () => {
  it('returns BOTH the synthetic and the server-UUID slot for a split 1:1 (opened on synthetic)', () => {
    const state = {
      groups: {},
      conversations: {
        [`direct:${PEER}`]: conv({id: `direct:${PEER}`, peer: {userId: PEER, deviceId: 1}}),
        'uuid-123':         conv({id: 'uuid-123', peer: {userId: PEER, deviceId: 1}}),
      },
    };
    const slots = directConversationSlots(state, `direct:${PEER}`).sort();
    expect(slots).toEqual([`direct:${PEER}`, 'uuid-123'].sort());
  });

  it('returns both slots when opened on the server-UUID id (synthetic still merged)', () => {
    const state = {
      groups: {},
      conversations: {
        [`direct:${PEER}`]: conv({id: `direct:${PEER}`, peer: {userId: PEER, deviceId: 1}}),
        'uuid-123':         conv({id: 'uuid-123', peer: {userId: PEER, deviceId: 1}}),
      },
    };
    const slots = directConversationSlots(state, 'uuid-123').sort();
    expect(slots).toEqual([`direct:${PEER}`, 'uuid-123'].sort());
  });

  it('a group returns only its own id (no merge)', () => {
    const state = {
      groups: {},
      conversations: {
        'group-1': conv({id: 'group-1', type: 'group', participants: [PEER, 'user-bob']}),
      },
    };
    expect(directConversationSlots(state, 'group-1')).toEqual(['group-1']);
  });

  it('a cold contact (synthetic id, no row) returns just the synthetic slot', () => {
    expect(directConversationSlots({conversations: {}, groups: {}}, `direct:${PEER}`)).toEqual([`direct:${PEER}`]);
  });

  it('does not leak another peer\'s slots', () => {
    const state = {
      groups: {},
      conversations: {
        [`direct:${PEER}`]: conv({id: `direct:${PEER}`, peer: {userId: PEER, deviceId: 1}}),
        'uuid-bob':         conv({id: 'uuid-bob', peer: {userId: 'user-bob', deviceId: 1}}),
      },
    };
    const slots = directConversationSlots(state, `direct:${PEER}`);
    expect(slots).not.toContain('uuid-bob');
    expect(slots.sort()).toEqual([`direct:${PEER}`]);
  });
});
