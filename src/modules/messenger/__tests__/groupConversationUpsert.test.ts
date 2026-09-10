/**
 * Group-add visibility fixes (handoff §2.7-1/-2/-3/-5).
 *
 * The added member's Messages page renders ONLY from
 * `conversations`/`conversationOrder`, and the group row's single writer
 * was the inline upsert in the `group-create:recv` handler. These tests
 * pin the extracted writers + the key-request target fallback that break
 * the "group invisible on the added member's device" failure modes:
 *
 *   1. `upsertGroupConversationFromState` creates the row from a create.
 *   2. A re-shared create no longer resets local-only fields
 *      (unread/mute/pin/custom name/last_message).
 *   3. `upsertKeylessGroupPlaceholder` makes a stashed no_key/tamper
 *      group visible (syncing) without ever clobbering a real row.
 *   4. `resolveKeyRequestTargets` falls back to the stashed envelope's
 *      sender when there is no conversation row (the Seam-C catch-22).
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

import {
  upsertGroupConversationFromState,
  upsertKeylessGroupPlaceholder,
  resolveKeyRequestTargets,
  selectKeyResyncCandidates,
  selectCallContaminationCleanup,
} from '../runtime/groupConversationUpsert';
import {useMessengerStore} from '../store/messengerStore';
import type {GroupState} from '@bravo/messenger-core';
import type {LocalMessage} from '../store/types';

const OWNER = 'u-owner';
const ME    = 'u-me';
const GID   = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function makeState(overrides: Partial<GroupState> = {}): GroupState {
  return {
    groupId:      GID,
    name:         'Ops Team',
    owner:        OWNER,
    members: {
      [OWNER]: {deviceId: 1, admin: true,  joinedAt: 1},
      [ME]:    {deviceId: 1, admin: false, joinedAt: 2},
      'u-3':   {deviceId: 1, admin: false, joinedAt: 3},
    },
    masterKeyB64: 'a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2U=',
    epoch:        1,
    createdAt:    1700000000000,
    updatedAt:    1700000000000,
    ...overrides,
  };
}

beforeEach(() => {
  useMessengerStore.getState().reset();
});

describe('upsertGroupConversationFromState (§2.7-3/-5)', () => {
  it('creates the inbox row from a verified create state', () => {
    upsertGroupConversationFromState(makeState(), OWNER);

    const s = useMessengerStore.getState();
    const row = s.conversations[GID];
    expect(row).toBeTruthy();
    expect(row.type).toBe('group');
    expect(row.name).toBe('Ops Team');
    expect([...row.participants].sort()).toEqual([OWNER, ME, 'u-3'].sort());
    expect(row.unread_count).toBe(0);
    expect(s.conversationOrder).toContain(GID);
  });

  it('preserves local-only fields on a re-shared create (no reset)', () => {
    const s = useMessengerStore.getState();
    const lastMsg = {
      id: 'm1', conversation_id: GID, sender_id: 'u-3', type: 'text',
      content: 'hello', status: 'delivered', is_encrypted: true,
      created_at: new Date().toISOString(), peer: {userId: 'u-3', deviceId: 1},
    } as LocalMessage;
    s.upsertConversation({
      id: GID, type: 'group', name: 'My Custom Name', participants: [OWNER, ME],
      unread_count: 7, is_muted: true, is_pinned: true, is_custom_name: true,
      created_at: '2026-01-01T00:00:00.000Z', last_message: lastMsg,
      peer: {userId: OWNER, deviceId: 1}, session_state: 'established',
    });

    upsertGroupConversationFromState(makeState({name: 'Ops Team (renamed)'}), OWNER);

    const row = useMessengerStore.getState().conversations[GID];
    expect(row.unread_count).toBe(7);
    expect(row.is_muted).toBe(true);
    expect(row.is_pinned).toBe(true);
    expect(row.name).toBe('My Custom Name');           // custom name wins
    expect(row.last_message?.id).toBe('m1');
    expect(row.created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(row.session_state).toBe('established');
    expect([...row.participants].sort()).toEqual([OWNER, ME, 'u-3'].sort()); // roster updates
  });

  it('updates the name from state when the user has NOT custom-named it', () => {
    upsertGroupConversationFromState(makeState({name: 'Old Name'}), OWNER);
    upsertGroupConversationFromState(makeState({name: 'New Name'}), OWNER);
    expect(useMessengerStore.getState().conversations[GID].name).toBe('New Name');
  });
});

describe('upsertKeylessGroupPlaceholder (§2.7-2)', () => {
  it('creates a visible syncing placeholder when there is no row', () => {
    upsertKeylessGroupPlaceholder(GID, {userId: 'u-sender', deviceId: 1});

    const s = useMessengerStore.getState();
    const row = s.conversations[GID];
    expect(row).toBeTruthy();
    expect(row.type).toBe('group');
    expect(row.name).toBe('Group');
    expect(row.participants).toEqual(['u-sender']); // resync targets reach the stash sender
    expect(s.conversationOrder).toContain(GID);
  });

  it('NEVER overwrites an existing row (real create wins, placeholder no-ops)', () => {
    upsertGroupConversationFromState(makeState(), OWNER);
    upsertKeylessGroupPlaceholder(GID, {userId: 'u-sender', deviceId: 1});

    const row = useMessengerStore.getState().conversations[GID];
    expect(row.name).toBe('Ops Team');
    expect(row.participants).toContain(OWNER);
  });

  it('the real create later REPLACES the placeholder name/participants', () => {
    upsertKeylessGroupPlaceholder(GID, {userId: OWNER, deviceId: 1});
    upsertGroupConversationFromState(makeState(), OWNER);

    const row = useMessengerStore.getState().conversations[GID];
    expect(row.name).toBe('Ops Team');
    expect([...row.participants].sort()).toEqual([OWNER, ME, 'u-3'].sort());
  });
});

describe('resolveKeyRequestTargets (§2.7-1 — Seam-C catch-22)', () => {
  it('uses conversation participants when present (existing behavior)', () => {
    expect(resolveKeyRequestTargets([OWNER, ME, 'u-3'], ME, 'u-fallback'))
      .toEqual([OWNER, 'u-3']);
  });

  it('falls back to the stashed envelope sender when there is NO row', () => {
    expect(resolveKeyRequestTargets(undefined, ME, OWNER)).toEqual([OWNER]);
    expect(resolveKeyRequestTargets([], ME, OWNER)).toEqual([OWNER]);
  });

  it('falls back when the row only contains ourselves', () => {
    expect(resolveKeyRequestTargets([ME], ME, OWNER)).toEqual([OWNER]);
  });

  it('never targets ourselves and returns empty with nothing to go on', () => {
    expect(resolveKeyRequestTargets(undefined, ME, ME)).toEqual([]);
    expect(resolveKeyRequestTargets(undefined, ME, undefined)).toEqual([]);
    expect(resolveKeyRequestTargets([ME, ''], ME, undefined)).toEqual([]);
  });
});

describe('selectKeyResyncCandidates (GF-3)', () => {
  const RESYNC_GID = 'g-1';

  it('keyless explicit group is selected (today\'s contract)', () => {
    expect(selectKeyResyncCandidates({
      groups: {}, conversations: {}, groupId: RESYNC_GID,
    })).toEqual([RESYNC_GID]);
  });

  it('keyed explicit group without the flag is dropped (today\'s contract)', () => {
    expect(selectKeyResyncCandidates({
      groups: {[RESYNC_GID]: {masterKeyB64: 'k'}}, conversations: {}, groupId: RESYNC_GID,
    })).toEqual([]);
  });

  it('GF-3 regression — a keyed group WITH divergence is selected', () => {
    // This is the dead-code kill: the tamper branch raises the request
    // precisely because the key we hold failed to decrypt, and the keyless
    // gate used to silently drop it.
    expect(selectKeyResyncCandidates({
      groups: {[RESYNC_GID]: {masterKeyB64: 'k'}}, conversations: {}, groupId: RESYNC_GID,
      divergence: true,
    })).toEqual([RESYNC_GID]);
  });

  it('the sweep only walks keyless group/ops_channel conversations', () => {
    const out = selectKeyResyncCandidates({
      groups: {keyed: {masterKeyB64: 'k'}},
      conversations: {
        keyed:    {type: 'group'},
        keyless:  {type: 'group'},
        ops:      {type: 'ops_channel'},
        'direct:x': {type: 'direct'},
      },
    });
    expect(out.sort()).toEqual(['keyless', 'ops']);
  });

  it('divergence on a sweep widens to keyed groups but never to direct rows', () => {
    const out = selectKeyResyncCandidates({
      groups: {keyed: {masterKeyB64: 'k'}},
      conversations: {
        keyed:      {type: 'group'},
        'direct:x': {type: 'direct'},
      },
      divergence: true,
    });
    expect(out).toEqual(['keyed']);
  });
});

describe('B-124 — placeholder never materialises for a direct-shaped group id', () => {
  it('refuses a `direct:`-prefixed groupId (contaminated cross-device stamp)', () => {
    upsertKeylessGroupPlaceholder('direct:some-user-uuid', {userId: OWNER, deviceId: 1});
    expect(useMessengerStore.getState().conversations['direct:some-user-uuid']).toBeUndefined();
  });

  it('still materialises for a legitimate 32-hex/UUID group id (regression)', () => {
    upsertKeylessGroupPlaceholder('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', {userId: OWNER, deviceId: 1});
    expect(useMessengerStore.getState().conversations.a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6?.type).toBe('group');
  });
});

describe('B-124/B-125 — selectCallContaminationCleanup', () => {
  const SELF = 'me-uuid';

  it('flags the shadow-minted direct:<self> duplicate', () => {
    const out = selectCallContaminationCleanup({
      conversations: {[`direct:${SELF}`]: {type: 'direct'}},
      groups: {},
    }, SELF);
    expect(out.conversationIdsToRemove).toEqual([`direct:${SELF}`]);
  });

  it('flags a group-typed junk thread on a direct:-shaped id', () => {
    const out = selectCallContaminationCleanup({
      conversations: {'direct:peer-uuid': {type: 'group'}},
      groups: {},
    }, SELF);
    expect(out.conversationIdsToRemove).toEqual(['direct:peer-uuid']);
  });

  it("flags 'Call' aliases under direct-shaped ids and direct-typed rows", () => {
    const out = selectCallContaminationCleanup({
      conversations: {'uuid-1': {type: 'direct'}},
      groups: {
        'direct:host-uuid': {name: 'Call'},
        'uuid-1':           {name: 'Call'},
        'deadbeef32hex':    {name: 'Call'},   // free-floating mint slot — harmless, kept
        'uuid-2':           {name: 'Team'},   // real group — kept
      },
    }, SELF);
    expect(out.groupAliasIdsToPurge.sort()).toEqual(['direct:host-uuid', 'uuid-1']);
  });

  it('touches nothing on a healthy store', () => {
    const out = selectCallContaminationCleanup({
      conversations: {
        'direct:peer-uuid': {type: 'direct'},
        'uuid-real-group':  {type: 'group'},
      },
      groups: {'uuid-real-group': {name: 'Team'}},
    }, SELF);
    expect(out.conversationIdsToRemove).toEqual([]);
    expect(out.groupAliasIdsToPurge).toEqual([]);
  });
});
