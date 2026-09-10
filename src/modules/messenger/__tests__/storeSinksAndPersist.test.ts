/**
 * The three EDGES messengerStore talks to outside its own state, and the two
 * persist hooks — none of which had ever been executed by a test:
 *
 *   1. `registerGroupMasterKeySink` / `clearGroupMasterKeySink` — the SQLCipher
 *      wrapped-group-key writer. P0-S3/P0-S5: the master key must reach disk
 *      wrapped, and must be PURGED when the group goes away, or a captured
 *      SQLCipher file can still decrypt intercepted group ciphertext.
 *   2. `registerDraftSink` — MI-06 durable drafts.
 *   3. the backup mirror nudges (`markDirty` / `mirrorRemoval`). H-3: the
 *      removal notification must fire AFTER the immer commit and must carry the
 *      row's real conversation_id + created_at, or the mirror re-ships the
 *      still-present row as LIVE and "delete for everyone" resurrects on restore.
 *   4. `partialize` — MSG-10 (no plaintext body at rest) + P0-S3 (no master key
 *      at rest), including the DEFENSIVE strip of an inactive owner's vault.
 *   5. `onRehydrateStorage` — vault hydration plus the two boot sweeps
 *      (B-106 call-group ghosts, B-124 call-key contamination).
 *
 * Every sink call is deliberately deferred to a microtask (it must not run
 * inside the immer producer), so the tests await a tick before asserting — that
 * ordering IS the contract.
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

const mockMarkDirty     = jest.fn();
const mockMirrorRemoval = jest.fn();
jest.mock('../backup/messageMirror', () => ({
  __esModule: true,
  markDirty:     (...a: unknown[]) => mockMarkDirty(...a),
  mirrorRemoval: (...a: unknown[]) => mockMirrorRemoval(...a),
}));

import {
  useMessengerStore,
  registerGroupMasterKeySink,
  clearGroupMasterKeySink,
  registerDraftSink,
} from '../store/messengerStore';
import type {LocalConversation, LocalMessage} from '../store/types';
import type {GroupState} from '@bravo/messenger-core';

const OWNER = 'owner-a';
const OTHER = 'owner-b';
const PEER  = 'alice-uuid';
const GID   = 'a1b2c3d4e5f607182930415263748596';

const st = () => useMessengerStore.getState();
const tick = () => new Promise<void>(r => setTimeout(r, 0));

function msg(over: Partial<LocalMessage> & {id: string}): LocalMessage {
  return {
    conversation_id: 'c1',
    sender_id:       'self',
    type:            'text',
    content:         'top secret',
    status:          'sent',
    is_encrypted:    true,
    created_at:      '2026-08-01T10:00:00.000Z',
    peer:            {userId: PEER, deviceId: 1},
    ...over,
  } as LocalMessage;
}

function convo(id: string, over: Partial<LocalConversation> = {}): LocalConversation {
  return {
    id,
    type:          'direct',
    name:          id,
    participants:  [PEER],
    unread_count:  0,
    is_muted:      false,
    created_at:    '2026-08-01T00:00:00.000Z',
    peer:          {userId: PEER, deviceId: 1},
    session_state: 'established',
    ...over,
  } as LocalConversation;
}

function groupState(groupId: string, over: Partial<GroupState> = {}): GroupState {
  return {
    groupId,
    name:  'Ops Team',
    owner: OWNER,
    members: {
      [OWNER]: {deviceId: 1, admin: true,  joinedAt: 0},
      [PEER]:  {deviceId: 1, admin: false, joinedAt: 0},
    },
    masterKeyB64: 'MASTER-KEY-BYTES',
    epoch: 1,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as GroupState;
}

type PersistOpts = {
  partialize?:          (s: unknown) => Record<string, unknown>;
  onRehydrateStorage?:  () => (state: unknown, error?: unknown) => void;
};
const persistOptions = (): PersistOpts =>
  (useMessengerStore as unknown as {persist: {getOptions: () => PersistOpts}}).persist.getOptions();

beforeEach(() => {
  st().reset();
  clearGroupMasterKeySink();
  registerDraftSink(null);
  mockMarkDirty.mockClear();
  mockMirrorRemoval.mockClear();
});

afterAll(() => {
  clearGroupMasterKeySink();
  registerDraftSink(null);
});

describe('group master-key sink — P0-S3 / P0-S5', () => {
  it('setGroupState mirrors the key to the sink, on a microtask (never inside the producer)', async () => {
    const setKey = jest.fn().mockResolvedValue(undefined);
    const deleteKey = jest.fn().mockResolvedValue(undefined);
    registerGroupMasterKeySink({setKey, deleteKey});

    st().setGroupState(groupState(GID));

    // The immer commit has already landed…
    expect(st().groups[GID]?.masterKeyB64).toBe('MASTER-KEY-BYTES');
    // …and the disk write is deferred out of the producer.
    expect(setKey).not.toHaveBeenCalled();
    await tick();
    expect(setKey).toHaveBeenCalledWith(GID, 'MASTER-KEY-BYTES');
  });

  it('a keyless group state (metadata-only update) does not call the sink', async () => {
    const setKey = jest.fn().mockResolvedValue(undefined);
    registerGroupMasterKeySink({setKey, deleteKey: jest.fn()});

    st().setGroupState(groupState(GID, {masterKeyB64: ''}));
    await tick();

    // Writing an empty key would overwrite a good wrapped row with nothing.
    expect(setKey).not.toHaveBeenCalled();
  });

  it('removeGroupState purges the wrapped row so a captured DB cannot decrypt later ciphertext', async () => {
    const deleteKey = jest.fn().mockResolvedValue(undefined);
    registerGroupMasterKeySink({setKey: jest.fn().mockResolvedValue(undefined), deleteKey});

    st().setGroupState(groupState(GID));
    await tick();
    st().removeGroupState(GID);

    expect(st().groups[GID]).toBeUndefined();
    await tick();
    expect(deleteKey).toHaveBeenCalledWith(GID);
  });

  it('a sink that rejects is swallowed with a warning — the store never throws at the caller', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    registerGroupMasterKeySink({
      setKey:    jest.fn().mockRejectedValue(new Error('sqlcipher down')),
      deleteKey: jest.fn().mockRejectedValue(new Error('sqlcipher down')),
    });

    expect(() => st().setGroupState(groupState(GID))).not.toThrow();
    await tick();
    expect(() => st().removeGroupState(GID)).not.toThrow();
    await tick();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('clearGroupMasterKeySink (logout) stops any further write under the old wrap key', async () => {
    const setKey = jest.fn().mockResolvedValue(undefined);
    registerGroupMasterKeySink({setKey, deleteKey: jest.fn()});
    clearGroupMasterKeySink();

    st().setGroupState(groupState(GID));
    await tick();

    expect(setKey).not.toHaveBeenCalled();
  });

  it('L9 — setGroupState re-syncs the conversation participants to the crypto membership', () => {
    st().upsertConversation(convo(GID, {type: 'group', participants: ['stale-member']}));

    st().setGroupState(groupState(GID));

    expect([...(st().conversations[GID]?.participants ?? [])].sort()).toEqual([OWNER, PEER].sort());
  });

  it('L9 — a DIRECT row is never re-written by group state landing under its id', () => {
    // B-124 shape: a call key filed at a 1:1 id. Rewriting participants there
    // would hand the 1:1's fan-out an invented member list.
    st().upsertConversation(convo('uuid-1to1', {type: 'direct', participants: [PEER]}));
    st().setGroupState(groupState('uuid-1to1', {name: 'Call'}));

    expect(st().conversations['uuid-1to1']?.participants).toEqual([PEER]);
  });
});

describe('draft sink — MI-06', () => {
  it('writes the draft through on a microtask, and writes an EMPTY string when it is cleared', async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    registerDraftSink({set});

    st().setDraft('c1', 'half-typed message');
    expect(set).not.toHaveBeenCalled();
    await tick();
    expect(set).toHaveBeenCalledWith('c1', 'half-typed message');
    expect(st().drafts.c1).toBe('half-typed message');

    set.mockClear();
    st().setDraft('c1', '   ');
    await tick();
    // The durable copy must be told to clear, not merely left stale.
    expect(set).toHaveBeenCalledWith('c1', '');
    expect(st().drafts.c1).toBeUndefined();
  });

  it('an unchanged draft short-circuits before the sink (no write per keystroke replay)', async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    registerDraftSink({set});

    st().setDraft('c1', 'same');
    await tick();
    set.mockClear();
    st().setDraft('c1', 'same');
    await tick();

    expect(set).not.toHaveBeenCalled();
  });

  it('clearing a draft that was never set does not hit the sink', async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    registerDraftSink({set});
    st().setDraft('never-typed', '');
    await tick();
    expect(set).not.toHaveBeenCalled();
  });

  it('a rejecting sink is swallowed with a warning', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    registerDraftSink({set: jest.fn().mockRejectedValue(new Error('disk full'))});

    expect(() => st().setDraft('c1', 'text')).not.toThrow();
    await tick();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('backup-mirror nudges — audit fix #30 / H-3', () => {
  it('does NOT nudge the mirror while no owner is set (pre-login mutations)', () => {
    st().upsertConversation(convo('c1'));
    st().appendMessage('c1', msg({id: 'm1', conversation_id: 'c1'}));
    st().updateMessageStatus('c1', 'm1', 'delivered');

    expect(mockMarkDirty).not.toHaveBeenCalled();
  });

  it('marks a row dirty on every mutating action once an owner is known', () => {
    st().setOwner(OWNER);
    st().upsertConversation(convo('c1'));
    st().appendMessage('c1', msg({id: 'm1', conversation_id: 'c1'}));

    mockMarkDirty.mockClear();
    st().updateMessageStatus('c1', 'm1', 'delivered');
    st().updateMessageReactions('c1', 'm1', {[PEER]: '❤️'});
    st().updateMessageEnvelopeId('c1', 'm1', 'env-1');
    st().updateMessageRetractToken('c1', 'm1', 'tok-1');
    st().patchMessageMedia('c1', 'm1', {media_object_key: 'r2/x'});

    expect(mockMarkDirty.mock.calls.map(c => c[1])).toEqual(['m1', 'm1', 'm1', 'm1', 'm1']);
    expect(mockMarkDirty.mock.calls.every(c => c[0] === OWNER)).toBe(true);
  });

  it('H-3 — removeMessage ships a tombstone carrying the row\'s REAL conversation_id + created_at', () => {
    st().setOwner(OWNER);
    st().upsertConversation(convo('c1'));
    st().appendMessage('c1', msg({id: 'm1', conversation_id: 'c1', created_at: '2026-07-04T08:09:10.000Z'}));

    st().removeMessage('c1', 'm1');

    expect(mockMirrorRemoval).toHaveBeenCalledWith(OWNER, {
      id: 'm1', conversation_id: 'c1', created_at: '2026-07-04T08:09:10.000Z',
    });
    // …and it fired AFTER the commit: the row is already gone.
    expect(st().messages.c1).toEqual([]);
  });

  it('H-3 — removing a row the store never had still emits a well-formed tombstone', () => {
    st().setOwner(OWNER);
    st().upsertConversation(convo('c1'));

    st().removeMessage('c1', 'phantom');

    expect(mockMirrorRemoval).toHaveBeenCalledTimes(1);
    const [owner, row] = mockMirrorRemoval.mock.calls[0] as [string, {id: string; conversation_id: string; created_at: string}];
    expect(owner).toBe(OWNER);
    expect(row.id).toBe('phantom');
    expect(row.conversation_id).toBe('c1');
    // Falls back to "now" rather than emitting an undefined timestamp.
    expect(Number.isNaN(Date.parse(row.created_at))).toBe(false);
  });
});

describe('partialize — what actually reaches unencrypted AsyncStorage', () => {
  const persistedNow = () => {
    const p = persistOptions().partialize;
    if (!p) {throw new Error('messengerStore lost its partialize');}
    return p(st()) as {
      _ownUserId: string | null;
      vaultByOwner: Record<string, {
        conversations: Record<string, LocalConversation>;
        groups: Record<string, GroupState>;
      }>;
    };
  };

  it('persists ONLY _ownUserId + vaultByOwner — messages and drafts never reach disk here', () => {
    st().setOwner(OWNER);
    st().upsertConversation(convo('c1'));
    st().appendMessage('c1', msg({id: 'm1', conversation_id: 'c1'}));
    st().setDraft('c1', 'unsent secret');

    const out = persistedNow();

    expect(Object.keys(out).sort()).toEqual(['_ownUserId', 'vaultByOwner']);
    expect(JSON.stringify(out)).not.toContain('unsent secret');
  });

  it('MSG-10 — the persisted last_message carries NO plaintext body, but the live store still does', () => {
    st().setOwner(OWNER);
    st().upsertConversation(convo('c1'));
    st().appendMessage('c1', msg({id: 'm1', conversation_id: 'c1', content: 'top secret'}));
    expect(st().conversations.c1?.last_message?.content).toBe('top secret');

    const out = persistedNow();

    expect(out.vaultByOwner[OWNER].conversations.c1.last_message?.content).toBe('');
    // …and the strip is a COPY: the in-memory preview the home list renders is
    // untouched.
    expect(st().conversations.c1?.last_message?.content).toBe('top secret');
    expect(JSON.stringify(out)).not.toContain('top secret');
  });

  it('a conversation with no last_message survives partialize unchanged', () => {
    st().setOwner(OWNER);
    st().upsertConversation(convo('c1'));
    const out = persistedNow();
    expect(out.vaultByOwner[OWNER].conversations.c1.last_message).toBeUndefined();
    expect(out.vaultByOwner[OWNER].conversations.c1.id).toBe('c1');
  });

  it('P0-S3 — masterKeyB64 is blanked for the LIVE owner while the rest of the group state survives', () => {
    st().setOwner(OWNER);
    st().setGroupState(groupState(GID));

    const out = persistedNow();

    expect(out.vaultByOwner[OWNER].groups[GID].masterKeyB64).toBe('');
    // Membership/epoch/name are deliberately retained so the group list paints
    // with no SQLCipher round-trip.
    expect(out.vaultByOwner[OWNER].groups[GID].name).toBe('Ops Team');
    expect(Object.keys(out.vaultByOwner[OWNER].groups[GID].members).sort()).toEqual([OWNER, PEER].sort());
    expect(JSON.stringify(out)).not.toContain('MASTER-KEY-BYTES');
    // The live key is untouched — group decrypt still works this session.
    expect(st().groups[GID]?.masterKeyB64).toBe('MASTER-KEY-BYTES');
  });

  it('DEFENSIVE — an INACTIVE owner\'s vaulted slice is stripped too (self-healing migration)', () => {
    // An older app version wrote plain keys + plaintext previews into the vault.
    // Switching users snapshots the previous owner's live slice verbatim, so
    // partialize is the last line of defence for it.
    st().setOwner(OTHER);
    st().setGroupState(groupState(GID));
    st().upsertConversation(convo('c-old'));
    st().appendMessage('c-old', msg({id: 'old-1', conversation_id: 'c-old', content: 'top secret'}));
    st().setOwner(OWNER);

    // Snapshot really did capture the previous owner unstripped…
    expect(st().vaultByOwner[OTHER]?.groups?.[GID]?.masterKeyB64).toBe('MASTER-KEY-BYTES');

    const out = persistedNow();

    expect(out.vaultByOwner[OTHER].groups[GID].masterKeyB64).toBe('');
    expect(out.vaultByOwner[OTHER].conversations['c-old'].last_message?.content).toBe('');
    expect(JSON.stringify(out)).not.toContain('MASTER-KEY-BYTES');
    expect(JSON.stringify(out)).not.toContain('top secret');
  });

  it('with no owner set, nothing is folded into the vault under a null key', () => {
    st().upsertConversation(convo('c1'));
    const out = persistedNow();
    expect(out._ownUserId).toBeNull();
    expect(Object.keys(out.vaultByOwner)).toHaveLength(0);
  });
});

describe('onRehydrateStorage — cold-boot hydration + the two boot sweeps', () => {
  const handler = () => {
    const make = persistOptions().onRehydrateStorage;
    if (!make) {throw new Error('messengerStore lost its onRehydrateStorage');}
    return make();
  };

  it('an error short-circuits: the passed state is left completely alone', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const state = {_ownUserId: OWNER, conversations: {}, conversationOrder: [], groups: {}, vaultByOwner: {
      [OWNER]: {conversations: {c1: convo('c1')}, conversationOrder: ['c1'], groups: {}},
    }} as never as Record<string, unknown>;

    handler()(state, new Error('bad json'));

    expect(Object.keys(state.conversations as object)).toHaveLength(0);
    log.mockRestore();
  });

  it('hydrates the live slice from the last-active owner\'s vault entry', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const state = {
      _ownUserId: OWNER,
      conversations: {}, conversationOrder: [], groups: {},
      groupMemberNames: {}, deptGroupByChannel: {}, deptConversationIds: {},
      vaultByOwner: {
        [OWNER]: {
          conversations: {c1: convo('c1')},
          conversationOrder: ['c1'],
          groups: {[GID]: groupState(GID, {masterKeyB64: ''})},
          groupMemberNames: {[GID]: {[PEER]: 'Alice'}},
          deptGroupByChannel: {'chan-hr': 'dept-conv'},
          deptConversationIds: {'dept-conv': true},
        },
      },
    } as never as Record<string, never>;

    handler()(state);

    expect(Object.keys(state.conversations)).toEqual(['c1']);
    expect(state.conversationOrder).toEqual(['c1']);
    expect(state.groupMemberNames[GID][PEER]).toBe('Alice');
    expect(state.deptGroupByChannel['chan-hr']).toBe('dept-conv');
    // The additive dept registry MUST come back too — dropping it un-refuses a
    // company file for the vault.
    expect(state.deptConversationIds['dept-conv']).toBe(true);
    log.mockRestore();
  });

  it('B-106 — a persisted ad-hoc call-group ghost row is swept, a user-renamed one is kept', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const ghost  = 'ffeeddccbbaa99887766554433221100';
    const keeper = '00112233445566778899aabbccddeeff';
    const state = {
      _ownUserId: OWNER,
      conversations: {
        [ghost]:  convo(ghost,  {type: 'group', name: 'Call'}),
        [keeper]: convo(keeper, {type: 'group', name: 'Call + Bob', is_custom_name: true}),
      },
      conversationOrder: [ghost, keeper],
      groups: {[ghost]: groupState(ghost, {name: 'Call'})},
      vaultByOwner: {},
    } as never as Record<string, never>;

    handler()(state);

    expect(state.conversations[ghost]).toBeUndefined();
    expect(state.conversations[keeper]).toBeDefined();
    expect(state.conversationOrder).toEqual([keeper]);
    log.mockRestore();
  });

  it('B-124/B-125 — the boot sweep drops call-key aliases at direct ids and the impossible self-slot row', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const selfSlot = `direct:${OWNER}`;
    const realChat = `direct:${PEER}`;
    const state = {
      _ownUserId: OWNER,
      conversations: {
        [selfSlot]: convo(selfSlot, {peer: {userId: OWNER, deviceId: 1}}),
        [realChat]: convo(realChat),
      },
      conversationOrder: [selfSlot, realChat],
      groups: {
        [realChat]: groupState(realChat, {name: 'Call'}),   // alias on a REAL chat
        [GID]:      groupState(GID),                        // a genuine group
      },
      vaultByOwner: {},
    } as never as Record<string, never>;

    handler()(state);

    // The alias goes…
    expect(state.groups[realChat]).toBeUndefined();
    // …but the CHAT it was aliased onto is a real conversation and stays.
    expect(state.conversations[realChat]).toBeDefined();
    // The self-slot row is definitionally invalid and goes, order included.
    expect(state.conversations[selfSlot]).toBeUndefined();
    expect(state.conversationOrder).toEqual([realChat]);
    // A genuine group is untouched.
    expect(state.groups[GID]).toBeDefined();
    log.mockRestore();
  });

  it('a boot with no vault entry for the owner leaves the live slices empty rather than crashing', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const state = {
      _ownUserId: OWNER,
      conversations: {}, conversationOrder: [], groups: {}, vaultByOwner: {},
    } as never as Record<string, never>;

    expect(() => handler()(state)).not.toThrow();
    expect(state.conversations).toEqual({});
    log.mockRestore();
  });
});
