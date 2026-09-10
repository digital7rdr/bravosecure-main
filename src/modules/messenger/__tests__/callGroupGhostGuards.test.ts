/**
 * B-106 - ad-hoc call groups must never appear as chat-list threads.
 *
 * The create-side BS-CALL-GHOST guard (exact sentinel name 'Call') only
 * covered `group-create:recv`. These tests pin the three writers/cleaners
 * added by B-106:
 *
 *   1. upsertKeylessGroupPlaceholder skips a known 'Call' group (a group-
 *      tagged envelope racing its create used to resurrect the thread).
 *   2. appendMessage's group shadow-create skips a known 'Call' group but
 *      STILL stores the message (the Calls tab walks thread-less slots).
 *   3. pruneCallGroupGhostRows removes persisted ghosts at hydration but
 *      never touches a user-renamed ("Call + x" / is_custom_name) group.
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

import {upsertKeylessGroupPlaceholder} from '../runtime/groupConversationUpsert';
import {useMessengerStore, pruneCallGroupGhostRows} from '../store/messengerStore';
import type {GroupState} from '@bravo/messenger-core';
import type {LocalMessage, LocalConversation} from '../store/types';

const GID = 'adhoc0c0ffee0c0ffee0c0ffee0c0ffee';

function callGroupState(name: string, groupId: string = GID): GroupState {
  return {
    groupId,
    name,
    owner: 'u-host',
    members: {
      'u-host': {deviceId: 1, admin: true, joinedAt: 1},
      'u-me':   {deviceId: 1, admin: false, joinedAt: 2},
    },
    masterKeyB64: 'a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2U=',
    epoch: 0,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };
}

function inboundMsg(id: string): LocalMessage {
  return {
    id,
    sender_id: 'u-host',
    body: 'x',
    created_at: new Date().toISOString(),
    status: 'delivered',
    peer: {userId: 'u-host', deviceId: 1},
  } as unknown as LocalMessage;
}

beforeEach(() => {
  useMessengerStore.getState().reset();
});

describe('upsertKeylessGroupPlaceholder (B-106 guard)', () => {
  it("skips a group whose state carries the exact 'Call' sentinel", () => {
    useMessengerStore.getState().setGroupState(callGroupState('Call'));
    upsertKeylessGroupPlaceholder(GID, {userId: 'u-host', deviceId: 1});
    expect(useMessengerStore.getState().conversations[GID]).toBeUndefined();
  });

  it("still creates the placeholder for a non-sentinel group ('Call + x')", () => {
    useMessengerStore.getState().setGroupState(callGroupState('Call + x'));
    upsertKeylessGroupPlaceholder(GID, {userId: 'u-host', deviceId: 1});
    expect(useMessengerStore.getState().conversations[GID]).toBeTruthy();
  });
});

/**
 * B-124 §3.1 — the ghost-row minter, and why the sentinel above is not enough.
 *
 * The `store.groups[groupId]?.name === 'Call'` guard is a DEVICE-LOCAL lookup of
 * a CROSS-DEVICE id. When a peer stamps its own device-local id on the wire, this
 * device holds no state at that id, the lookup yields undefined, and a junk
 * `type:'group'` thread is minted carrying the 1:1's traffic.
 *
 * Worse, it is not merely absent state: pruneCallKeyContamination (the B-124 boot
 * sweep) DELETES `direct:`-shaped 'Call' aliases at every rehydrate — so on an
 * otherwise-healed device the sentinel is guaranteed to miss and the ghost is
 * re-minted on every boot for as long as any peer stays on v1.0.118.
 *
 * The guard must therefore be a SHAPE check that never consults the groups map.
 */
describe('B-124 — device-local group ids must never mint a chat row', () => {
  const OWN = 'u-me';

  it('does not create a row for a `direct:`-shaped wire groupId with no local state', () => {
    upsertKeylessGroupPlaceholder(`direct:${'u-host'}`, {userId: 'u-host', deviceId: 1});
    expect(useMessengerStore.getState().conversations['direct:u-host']).toBeUndefined();
  });

  it('does not create a row for a `direct:<ownUserId>` self-slot wire groupId', () => {
    upsertKeylessGroupPlaceholder(`direct:${OWN}`, {userId: 'u-host', deviceId: 1});
    expect(useMessengerStore.getState().conversations[`direct:${OWN}`]).toBeUndefined();
  });

  it('holds even after the boot sweep deleted the alias the old sentinel relied on', () => {
    // Reproduces the real sequence: alias present -> boot sweep clears it ->
    // an un-updated peer's group-tagged envelope arrives.
    useMessengerStore.getState().setGroupState(callGroupState('Call', 'direct:u-host'));
    expect(useMessengerStore.getState().groups['direct:u-host']).toBeTruthy();
    useMessengerStore.setState(s => {
      delete s.groups['direct:u-host'];      // what pruneCallKeyContamination does
      return s;
    });
    upsertKeylessGroupPlaceholder('direct:u-host', {userId: 'u-host', deviceId: 1});
    expect(useMessengerStore.getState().conversations['direct:u-host']).toBeUndefined();
  });

  it('REGRESSION: a genuine keyless group create placeholder is still created', () => {
    // A brand-new member whose `create` never landed has no state and no row.
    // This is the whole reason the placeholder exists — it must survive.
    upsertKeylessGroupPlaceholder(GID, {userId: 'u-host', deviceId: 1});
    expect(useMessengerStore.getState().conversations[GID]).toBeTruthy();
    expect(useMessengerStore.getState().conversations[GID]?.type).toBe('group');
  });
});

describe('appendMessage group shadow-create (B-106 guard)', () => {
  it("does not create a chat row for a 'Call' group but keeps the message", () => {
    const s = useMessengerStore.getState();
    s.setGroupState(callGroupState('Call'));
    s.appendMessage(GID, inboundMsg('m1'));
    const after = useMessengerStore.getState();
    expect(after.conversations[GID]).toBeUndefined();
    expect(after.conversationOrder).not.toContain(GID);
    expect(after.messages[GID]?.map(m => m.id)).toEqual(['m1']);
  });

  it('still shadow-creates the placeholder for an unknown group id', () => {
    const s = useMessengerStore.getState();
    s.appendMessage('someRealGroupId000000000000000000', inboundMsg('m2'));
    const after = useMessengerStore.getState();
    expect(after.conversations.someRealGroupId000000000000000000).toBeTruthy();
  });
});

describe('pruneCallGroupGhostRows (B-106 hydration sweep)', () => {
  function row(id: string, name: string, custom = false): LocalConversation {
    return {
      id,
      type: 'group',
      name,
      participants: ['u-host'],
      peer: {userId: 'u-host', deviceId: 1},
      session_state: 'fresh',
      unread_count: 0,
      is_muted: false,
      created_at: new Date().toISOString(),
      is_custom_name: custom,
    } as unknown as LocalConversation;
  }

  it('removes rows whose group state carries the sentinel, and sentinel-named rows', () => {
    const state = {
      conversations: {
        [GID]:       row(GID, 'Call'),
        'g-legacy':  row('g-legacy', 'Call'),          // pre-guard ghost, no groups entry
        'g-real':    row('g-real', 'Ops Team'),
      },
      conversationOrder: [GID, 'g-legacy', 'g-real'],
      groups: {[GID]: callGroupState('Call')},
    };
    const pruned = pruneCallGroupGhostRows(state);
    expect(pruned).toBe(2);
    expect(state.conversations['g-real']).toBeTruthy();
    expect(state.conversations[GID]).toBeUndefined();
    expect(state.conversations['g-legacy']).toBeUndefined();
    expect(state.conversationOrder).toEqual(['g-real']);
  });

  it("never touches a user-renamed group, even one whose state says 'Call'", () => {
    const state = {
      conversations: {'g-x': row('g-x', 'Call', true)},
      conversationOrder: ['g-x'],
      groups: {'g-x': callGroupState('Call', 'g-x')},
    };
    expect(pruneCallGroupGhostRows(state)).toBe(0);
    expect(state.conversations['g-x']).toBeTruthy();
  });

  it("leaves 'Call + x' named groups alone", () => {
    const state = {
      conversations: {'g-y': row('g-y', 'Call + x')},
      conversationOrder: ['g-y'],
      groups: {'g-y': callGroupState('Call + x', 'g-y')},
    };
    expect(pruneCallGroupGhostRows(state)).toBe(0);
    expect(state.conversations['g-y']).toBeTruthy();
  });
});
