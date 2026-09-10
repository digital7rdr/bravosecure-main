/**
 * THE CONVERSATION KEYSPACE — pins the exact behaviour of the flat
 * `Record<string, …>` maps (`conversations` / `groups`) into which FOUR
 * different id namespaces are written:
 *
 *   1. `direct:<peerUserId>`  — the synthetic 1:1 slot (cold contact, push tap,
 *                               incoming-call deep link)
 *   2. a 32-hex group id      — `deriveGroupId(salt, members)` output
 *   3. a dept-channel id      — the ops_channel conversation a department
 *                               channel is remapped onto (deptGroupByChannel)
 *   4. a minted CALL id       — `ensureCallGroupKey`'s throwaway `'Call'`
 *                               GroupState, which is filed EITHER at a real
 *                               32-hex id OR aliased onto a direct-shaped /
 *                               1:1-UUID chat id
 *
 * Nothing in the key itself says which namespace it belongs to, so
 * `directConversationSlots` and `resolveDirectConversationIdFromState` have to
 * INFER it. That inference is the seam that produced B-124 (a call key filed at
 * a chat id turned a 1:1 into a "group") and B-125 (the resulting mis-routing
 * lost messages). `directConversationSlots` deliberately returns BOTH the id it
 * was handed and the derived `direct:<peer>` id because the caller cannot tell
 * which namespace it holds.
 *
 * Every assertion below states the CURRENT rule precisely so any future change
 * to the inference is visible in a diff, not discovered on a device.
 *
 * Complements `resolveDirectConversationId.test.ts` (the two-slot 1:1 basics);
 * this file covers the cross-namespace collisions that file does not reach.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear:      async () => { store.clear(); },
    },
  };
});

import {resolveDirectConversationIdFromState, directConversationSlots} from '../store/messengerStore';
import type {LocalConversation} from '../store/types';
import type {GroupState} from '@bravo/messenger-core';

const PEER  = 'alice-uuid';
const OTHER = 'bob-uuid';
const SELF  = 'self-uuid';

/** Namespace 1 — synthetic direct slot. */
const SYNTH = `direct:${PEER}`;
/** A server-issued 1:1 conversation UUID (same namespace as a group UUID!). */
const UUID_1TO1 = '9d1c2f3a-0000-4000-8000-000000000001';
/** Namespace 2 — a real `deriveGroupId` output: 32 lowercase hex chars. */
const HEX_GROUP = 'a1b2c3d4e5f607182930415263748596';
/** Namespace 3 — a department channel's conversation id. */
const DEPT_CONVO = 'dept-conv-hr';
const DEPT_CHANNEL = 'chan-hr';
/** Namespace 4 — an ad-hoc call key minted at a real group-shaped id. */
const CALL_HEX = 'ffeeddccbbaa99887766554433221100';

function conv(over: Partial<LocalConversation> & {id: string}): LocalConversation {
  return {
    type:          'direct',
    name:          'Peer',
    participants:  [],
    unread_count:  0,
    is_muted:      false,
    created_at:    '2026-08-01T00:00:00.000Z',
    session_state: 'established',
    ...over,
  } as LocalConversation;
}

function groupState(groupId: string, name: string, members: string[] = [PEER, SELF]): GroupState {
  return {
    groupId,
    name,
    owner: SELF,
    members: Object.fromEntries(members.map(u => [u, {deviceId: 1, admin: u === SELF, joinedAt: 0}])),
    masterKeyB64: 'AAAA',
    epoch: 1,
    createdAt: 0,
    updatedAt: 0,
  } as GroupState;
}

type KeyspaceState = {
  conversations: Record<string, LocalConversation>;
  groups:        Record<string, GroupState>;
};

const empty = (): KeyspaceState => ({conversations: {}, groups: {}});

describe('namespace 1 — `direct:<uid>` vs a server-UUID 1:1 row', () => {
  it('a lone server-UUID 1:1 row STILL reports the (non-existent) synthetic slot', () => {
    // This is the "writes both slots" ambiguity in its purest form: the caller
    // handed us a UUID, so we cannot know a synthetic sibling does not exist —
    // and callers (ChatScreen render + markRead) must tolerate a slot with no
    // conversation row. Changing this to "only slots that exist" would silently
    // stop merging history that lands in the synthetic slot a moment later.
    const state = empty();
    state.conversations[UUID_1TO1] = conv({id: UUID_1TO1, peer: {userId: PEER, deviceId: 1}});

    expect(directConversationSlots(state, UUID_1TO1).sort()).toEqual([SYNTH, UUID_1TO1].sort());
    expect(state.conversations[SYNTH]).toBeUndefined();
  });

  it('the ROW\'s peer wins over the id suffix when a contaminated `direct:` id disagrees', () => {
    // A `direct:<X>` key whose row says the peer is Y. peerUid is read from the
    // ROW first, so the returned set spans BOTH derived namespaces rather than
    // trusting the id string.
    const contaminated = `direct:${OTHER}`;
    const state = empty();
    state.conversations[contaminated] = conv({id: contaminated, peer: {userId: PEER, deviceId: 1}});

    const slots = directConversationSlots(state, contaminated).sort();
    expect(slots).toEqual([contaminated, SYNTH].sort());
  });

  it('a direct row with NO peer and a non-`direct:` id resolves to itself only', () => {
    // No peer anywhere to derive from — the merge must not guess.
    const state = empty();
    state.conversations[UUID_1TO1] = conv({id: UUID_1TO1, type: 'direct'});
    expect(directConversationSlots(state, UUID_1TO1)).toEqual([UUID_1TO1]);
  });

  it('resolve picks the FIRST non-synthetic direct row when two UUID rows claim one peer', () => {
    // Duplicate-UUID rows for one peer are reachable (two /conversations/mine
    // rows, a restore racing a sync). The rule is insertion order, not "newest"
    // — pinned so a change to it is deliberate rather than incidental.
    const first  = '00000000-0000-4000-8000-00000000aaaa';
    const second = '00000000-0000-4000-8000-00000000bbbb';
    const state = empty();
    state.conversations[first]  = conv({id: first,  peer: {userId: PEER, deviceId: 1}});
    state.conversations[second] = conv({id: second, peer: {userId: PEER, deviceId: 1}});

    expect(resolveDirectConversationIdFromState(state, PEER)).toBe(first);
    // …but the slot merge covers BOTH so no history is stranded on the loser.
    expect(directConversationSlots(state, first).sort()).toEqual([SYNTH, first, second].sort());
  });
});

describe('namespace 2 — a 32-hex group id', () => {
  it('is a group on the strength of its GroupState ALONE, with no conversation row', () => {
    // The order /conversations/mine and the admin `create` envelope arrive in is
    // not guaranteed. A key-material-only group must already be a group, or the
    // slot merge would try to resolve a PEER for it (the M2 bug).
    const state = empty();
    state.groups[HEX_GROUP] = groupState(HEX_GROUP, 'Ops Team');
    expect(directConversationSlots(state, HEX_GROUP)).toEqual([HEX_GROUP]);
  });

  it('a shadow-created group placeholder never merges into its `peer` field\'s 1:1 slots', () => {
    // appendMessage's group shadow-create stamps `peer: msg.peer` — a REAL user
    // — purely to satisfy LocalConversation. If group-ness were inferred from
    // `peer` rather than from type/GroupState, this group's thread would fold
    // into that member's private 1:1. It must not.
    const state = empty();
    state.conversations[HEX_GROUP] = conv({
      id: HEX_GROUP, type: 'group', name: 'Group chat',
      participants: [PEER], peer: {userId: PEER, deviceId: 1},
    });
    state.conversations[SYNTH] = conv({id: SYNTH, peer: {userId: PEER, deviceId: 1}});

    expect(directConversationSlots(state, HEX_GROUP)).toEqual([HEX_GROUP]);
    // …and the peer's own 1:1 resolution never returns the group id.
    expect(resolveDirectConversationIdFromState(state, PEER)).toBe(SYNTH);
  });

  it('a 2+ participant row with no type and no GroupState still counts as a group', () => {
    const state = empty();
    state.conversations[HEX_GROUP] = conv({
      id: HEX_GROUP, type: undefined as never, participants: [PEER, OTHER],
      peer: {userId: PEER, deviceId: 1},
    });
    expect(directConversationSlots(state, HEX_GROUP)).toEqual([HEX_GROUP]);
  });
});

describe('namespace 3 — a dept-channel-derived conversation id (ops_channel)', () => {
  it('an ops_channel is a group, so it is never merged with a member\'s direct slots', () => {
    // B-116 / M2 — the inline `type === 'group'` copy omitted ops_channel, and a
    // whole department channel went blue on ONE member's read. Same omission
    // here would merge the channel into a member's 1:1 thread.
    const state = empty();
    state.conversations[DEPT_CONVO] = conv({
      id: DEPT_CONVO, type: 'ops_channel', name: 'HR',
      participants: [PEER, OTHER, SELF], peer: {userId: PEER, deviceId: 1},
    });
    state.conversations[SYNTH] = conv({id: SYNTH, peer: {userId: PEER, deviceId: 1}});

    expect(directConversationSlots(state, DEPT_CONVO)).toEqual([DEPT_CONVO]);
  });

  it('the channel→conversation POINTER lives in a different map and does not affect slot merge', () => {
    // deptGroupByChannel maps CHANNEL id → CONVERSATION id. The channel id is a
    // fifth string that must never be mistaken for a conversation key.
    const state = empty();
    state.conversations[DEPT_CONVO] = conv({
      id: DEPT_CONVO, type: 'ops_channel', participants: [PEER, SELF],
    });
    // Asking about the CHANNEL id (which is not a conversation key at all)
    // yields exactly itself — no peer can be derived, so nothing is merged.
    expect(directConversationSlots(state, DEPT_CHANNEL)).toEqual([DEPT_CHANNEL]);
  });
});

describe('namespace 4 — a minted ad-hoc CALL id', () => {
  it('B-124 — a `Call` key aliased onto a `direct:` slot does NOT make the 1:1 a group', () => {
    // ensureCallGroupKey files a throwaway GroupState named exactly 'Call' onto
    // the ORIGINATING 1:1 slot during 1:1→group escalation. Before the fix that
    // key made `isGroupConversation` true for a direct-shaped id, the send path
    // took the group branch, and the thread split-brained.
    const state = empty();
    state.conversations[SYNTH] = conv({id: SYNTH, peer: {userId: PEER, deviceId: 1}});
    state.groups[SYNTH] = groupState(SYNTH, 'Call');

    expect(directConversationSlots(state, SYNTH)).toEqual([SYNTH]);
  });

  it('B-124 — a `Call` key aliased onto the 1:1 UUID row keeps it a direct thread', () => {
    const state = empty();
    state.conversations[UUID_1TO1] = conv({id: UUID_1TO1, peer: {userId: PEER, deviceId: 1}});
    state.conversations[SYNTH]     = conv({id: SYNTH,     peer: {userId: PEER, deviceId: 1}});
    state.groups[UUID_1TO1] = groupState(UUID_1TO1, 'Call');

    // Still a 1:1 → both slots merge, exactly as with no call key present.
    expect(directConversationSlots(state, UUID_1TO1).sort()).toEqual([SYNTH, UUID_1TO1].sort());
  });

  it('a `Call` key at a real 32-hex id with no chat row is NOT a group and NOT a direct merge', () => {
    // The ad-hoc call group deliberately has no chat-list row (BS-CALL-GHOST).
    // The exact-'Call' sentinel disqualifies it from group-ness, and with no
    // conversation row there is no peer to derive — so it stands alone.
    const state = empty();
    state.groups[CALL_HEX] = groupState(CALL_HEX, 'Call');
    expect(directConversationSlots(state, CALL_HEX)).toEqual([CALL_HEX]);
  });

  it('a group the USER renamed to something containing "Call" is a real group', () => {
    // The sentinel is EXACT — 'Call + Bob' is a user-named group and must keep
    // full group behaviour.
    const state = empty();
    state.groups[CALL_HEX] = groupState(CALL_HEX, 'Call + Bob');
    expect(directConversationSlots(state, CALL_HEX)).toEqual([CALL_HEX]);

    // Contrast: the exact sentinel is not a group.
    const sentinel = empty();
    sentinel.groups[CALL_HEX] = groupState(CALL_HEX, 'Call');
    sentinel.conversations[CALL_HEX] = conv({
      id: CALL_HEX, type: 'direct', peer: {userId: PEER, deviceId: 1},
    });
    // …and being direct-typed, it merges with the peer's 1:1 slots instead.
    expect(directConversationSlots(sentinel, CALL_HEX).sort()).toEqual([CALL_HEX, SYNTH].sort());
  });
});

describe('cross-namespace: resolve never crosses out of the direct namespace', () => {
  it('skips group, ops_channel and Call-aliased rows when resolving a peer\'s 1:1', () => {
    const state = empty();
    state.conversations[HEX_GROUP]  = conv({id: HEX_GROUP,  type: 'group',       participants: [PEER, OTHER], peer: {userId: PEER, deviceId: 1}});
    state.conversations[DEPT_CONVO] = conv({id: DEPT_CONVO, type: 'ops_channel', participants: [PEER, OTHER], peer: {userId: PEER, deviceId: 1}});
    state.groups[CALL_HEX] = groupState(CALL_HEX, 'Call');

    // Nothing DIRECT exists for the peer → the synthetic key, which is exactly
    // the key the shadow-create branch will mint on first inbound.
    expect(resolveDirectConversationIdFromState(state, PEER)).toBe(SYNTH);
  });

  it('an empty keyspace resolves to the synthetic key and a single slot', () => {
    expect(resolveDirectConversationIdFromState(empty(), PEER)).toBe(SYNTH);
    expect(directConversationSlots(empty(), SYNTH)).toEqual([SYNTH]);
  });

  it('the returned slot list is DEDUPED and leads with the id it was asked about', () => {
    // Set-backed: asking about the synthetic id when it is also the only direct
    // row must not return it twice (a duplicate slot double-counts unread and
    // double-renders every bubble in ChatScreen's read-merge).
    const state = empty();
    state.conversations[SYNTH] = conv({id: SYNTH, peer: {userId: PEER, deviceId: 1}});
    const slots = directConversationSlots(state, SYNTH);
    expect(slots).toEqual([SYNTH]);
    expect(new Set(slots).size).toBe(slots.length);

    const withUuid = empty();
    withUuid.conversations[SYNTH]     = conv({id: SYNTH,     peer: {userId: PEER, deviceId: 1}});
    withUuid.conversations[UUID_1TO1] = conv({id: UUID_1TO1, peer: {userId: PEER, deviceId: 1}});
    expect(directConversationSlots(withUuid, UUID_1TO1)[0]).toBe(UUID_1TO1);
  });

  it('another peer\'s direct rows are never pulled into this peer\'s slot set', () => {
    const state = empty();
    state.conversations[SYNTH]              = conv({id: SYNTH,              peer: {userId: PEER,  deviceId: 1}});
    state.conversations[`direct:${OTHER}`]  = conv({id: `direct:${OTHER}`,  peer: {userId: OTHER, deviceId: 1}});
    state.conversations[UUID_1TO1]          = conv({id: UUID_1TO1,          peer: {userId: OTHER, deviceId: 1}});

    const slots = directConversationSlots(state, SYNTH);
    expect(slots).toEqual([SYNTH]);
    expect(resolveDirectConversationIdFromState(state, OTHER)).toBe(UUID_1TO1);
  });
});
