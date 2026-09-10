/**
 * EXECUTABLE coverage for the ADMIN-ACTION half of `runtime/applyGroupAdmin.ts`
 * (the `else if (args.existing)` lane) — everything that is NOT `create` and
 * NOT `key-request`.
 *
 * Only the key-request branch had ever been RUN by a test
 * (`escalatedCallKeyResync.test.ts`); everything below was pinned by regex
 * scans of the source text, which cannot see whether the reducer is actually
 * consulted or whether a guard fires.
 *
 * THE PROPERTY THIS SUITE EXISTS FOR — EPOCH MONOTONICITY (G1).
 * `applyAdminAction` drops any action whose `atEpoch` differs from the local
 * state's epoch by returning the SAME state reference. That single rule is
 * what makes a REPLAYED admin envelope harmless: a captured `remove` cannot
 * be re-injected later to evict a member again, a captured `rekey` cannot roll
 * the key back, and a captured `add` cannot re-admit someone who was removed.
 * The lane's job is to (a) not defeat that, (b) name the reason in the
 * breadcrumb, (c) STASH stale-epoch actions for replay after the next commit,
 * and (d) fire NONE of the UI side effects for a dropped action. All four are
 * asserted here against the real reducer from `@bravo/messenger-core`.
 *
 * The reducer, `isGroupMember` and `disposeGroupKey` are the REAL
 * implementations — mocking them would leave the guard untested, which is the
 * whole point. Only the UI/DB side-effect helpers are stubbed, so the lane's
 * decisions are observable.
 */

const asyncStore: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    jest.fn(async (k: string) => asyncStore[k] ?? null),
    setItem:    jest.fn(async (k: string, v: string) => { asyncStore[k] = v; }),
    removeItem: jest.fn(async (k: string) => { delete asyncStore[k]; }),
  },
}));
jest.mock('../crypto/expectedSenderIdentity', () => ({resolveExpectedSenderIdentity: jest.fn()}));
jest.mock('../runtime/groupEventMessage', () => ({
  appendGroupPhotoChangedEvent: jest.fn(),
  appendMemberAddedEvent:       jest.fn(),
  appendMemberRemovedEvent:     jest.fn(),
}));
jest.mock('../runtime/applyGroupRename', () => ({applyGroupRenameToUi: jest.fn()}));
jest.mock('../runtime/applyMemberRemoval', () => ({applyMemberRemovalToUi: jest.fn()}));
jest.mock('../runtime/decryptFailureSignal', () => ({noteDestroyedEnvelope: jest.fn()}));
jest.mock('../runtime/groupConversationUpsert', () => ({
  upsertGroupConversationFromState: jest.fn(),
}));

import {applyGroupAdmin} from '../runtime/applyGroupAdmin';
import type {GroupAdminDeps, GroupAdminOutcome} from '../runtime/applyGroupAdmin';
import {
  appendGroupPhotoChangedEvent,
  appendMemberAddedEvent,
  appendMemberRemovedEvent,
} from '../runtime/groupEventMessage';
import {applyGroupRenameToUi} from '../runtime/applyGroupRename';
import {applyMemberRemovalToUi} from '../runtime/applyMemberRemoval';
import type {GroupAdminAction, GroupState} from '@bravo/messenger-core';

const OWNER  = 'owner-uid';
const SELF   = 'self-uid';
const MEMBER = 'plain-member-uid';
const GID    = 'group-1234567890abcdef';
const KEY_A  = Buffer.alloc(32, 1).toString('base64');
const KEY_B  = Buffer.alloc(32, 2).toString('base64');

interface Harness {
  groups: Record<string, GroupState>;
  setGroupState: jest.Mock;
  crashLog: jest.Mock;
  emit: jest.Mock;
  stash: jest.Mock;
  outcome: GroupAdminOutcome;
  /** Whatever the lane handed to setGroupState (undefined when it never wrote). */
  written: GroupState | undefined;
  /** True when the reducer returned the SAME object — i.e. the action was a no-op. */
  noOp: boolean;
}

function state(over: Partial<GroupState> = {}): GroupState {
  return {
    groupId:      GID,
    name:         'Ops Room',
    owner:        OWNER,
    members: {
      [OWNER]:  {deviceId: 1, admin: true,  joinedAt: 1},
      [SELF]:   {deviceId: 1, admin: true,  joinedAt: 2},
      [MEMBER]: {deviceId: 1, admin: false, joinedAt: 3},
    },
    masterKeyB64: KEY_A,
    epoch:        5,
    createdAt:    1,
    updatedAt:    1,
    ...over,
  } as GroupState;
}

async function run(
  action: GroupAdminAction,
  existing: GroupState | undefined,
  opts: {senderId?: string; ownUserId?: string; withStash?: boolean} = {},
): Promise<Harness> {
  const groups = existing ? {[existing.groupId]: existing} : {};
  const setGroupState = jest.fn();
  const crashLog = jest.fn();
  const emit = jest.fn();
  const stash = jest.fn(async () => {});
  const deps: GroupAdminDeps = {
    store: {groups, setGroupState},
    getState: () => ({groups, conversations: {}, setGroupState, setError: jest.fn()}),
    ownStore: {} as GroupAdminDeps['ownStore'],
    keys: null,
    peerIdentityCache: undefined as unknown as GroupAdminDeps['peerIdentityCache'],
    ownUserId: opts.ownUserId ?? SELF,
    pendingAdminActions: opts.withStash === false ? null : {stash},
    emitGroupKeySignal: emit,
    crashLog,
  };
  const outcome = await applyGroupAdmin(
    {
      action,
      peer: {userId: opts.senderId ?? OWNER, deviceId: 1},
      existing,
      envelopeId: 'env-abcdef0123',
      wireGroupId: existing?.groupId,
      senderIdentityKey: 'sender-ik-b64',
    },
    deps,
  );
  const written = setGroupState.mock.calls[0]?.[0] as GroupState | undefined;
  return {
    groups, setGroupState, crashLog, emit, stash, outcome, written,
    noOp: written === existing,
  };
}

let logSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  logSpy  = jest.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('G1 — an action whose atEpoch != the local epoch is IGNORED, not applied', () => {
  it('a replayed `remove` does not evict the member a second time', async () => {
    // The attack this closes: capture the remove envelope that legitimately
    // evicted someone at epoch 5, wait for the group to advance, re-inject it.
    const before = state({epoch: 9});
    const h = await run({type: 'remove', userId: MEMBER, atEpoch: 5}, before);

    expect(h.noOp).toBe(true);
    expect(h.written!.members[MEMBER]).toBeDefined();
    expect(h.written!.epoch).toBe(9);
    // NONE of the visible consequences of a removal may fire.
    expect(appendMemberRemovedEvent).not.toHaveBeenCalled();
    expect(applyMemberRemovalToUi).not.toHaveBeenCalled();
  });

  it('a replayed self-remove does NOT trigger the B-337 local purge', async () => {
    // The purge deletes this device's conversation row, transcript, outbox and
    // crypto state. Firing it off a stale envelope is unrecoverable data loss.
    const h = await run({type: 'remove', userId: SELF, atEpoch: 4}, state({epoch: 6}));

    expect(h.noOp).toBe(true);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('a stale `rekey` leaves the master key alone and asks for no drain', async () => {
    const h = await run({type: 'rekey', newMasterKeyB64: KEY_B, atEpoch: 1}, state({epoch: 5}));

    expect(h.written!.masterKeyB64).toBe(KEY_A);
    expect(h.outcome).toBeUndefined();
  });

  it('a stale `add` writes no membership row and no system line', async () => {
    const h = await run(
      {type: 'add', member: {userId: 'newcomer', deviceId: 1}, atEpoch: 99},
      state({epoch: 5}),
    );

    expect(h.written!.members.newcomer).toBeUndefined();
    expect(appendMemberAddedEvent).not.toHaveBeenCalled();
  });

  it('names the epochs in the breadcrumb and STASHES the action for replay', async () => {
    // Stale-epoch is the one no-op family that replay can fix (it is usually
    // out-of-order delivery, e.g. rekey@E+1 arriving before add@E).
    const h = await run({type: 'add', member: {userId: 'n', deviceId: 1}, atEpoch: 7}, state({epoch: 5}));

    expect(h.crashLog).toHaveBeenCalledWith(expect.stringContaining('stale-epoch action=7 state=5'));
    expect(h.stash).toHaveBeenCalledWith(expect.objectContaining({
      groupId: GID, actionEpoch: 7, senderUserId: OWNER, action: expect.objectContaining({type: 'add'}),
    }));
  });
});

describe('policy drops are NOT stashed — replaying them would just re-drop forever', () => {
  it('a non-admin sender is refused and named as such', async () => {
    const h = await run(
      {type: 'remove', userId: OWNER, atEpoch: 5},
      state(),
      {senderId: MEMBER},
    );

    expect(h.noOp).toBe(true);
    expect(h.written!.members[OWNER]).toBeDefined();
    expect(h.crashLog).toHaveBeenCalledWith(expect.stringContaining('reason=non-admin-sender'));
    expect(h.stash).not.toHaveBeenCalled();
  });

  it('a `leave` from someone who is not a member is named leaver-not-member', async () => {
    const h = await run({type: 'leave', atEpoch: 5}, state(), {senderId: 'stranger-uid'});

    expect(h.noOp).toBe(true);
    expect(h.crashLog).toHaveBeenCalledWith(expect.stringContaining('reason=leaver-not-member'));
    expect(h.stash).not.toHaveBeenCalled();
  });

  it('a stale-epoch drop with no stash store available does not throw', async () => {
    const h = await run(
      {type: 'add', member: {userId: 'n', deviceId: 1}, atEpoch: 1},
      state({epoch: 5}),
      {withStash: false},
    );

    expect(h.noOp).toBe(true);
    expect(h.crashLog).toHaveBeenCalledWith(expect.stringContaining('stale-epoch'));
  });
});

describe('an accepted action applies AND reconciles what the user sees', () => {
  it('`add` advances the epoch and appends the SN-11 membership row', async () => {
    const h = await run({type: 'add', member: {userId: 'newcomer', deviceId: 2}, atEpoch: 5}, state());

    expect(h.noOp).toBe(false);
    expect(h.written!.members.newcomer).toEqual(expect.objectContaining({deviceId: 2, admin: false}));
    expect(h.written!.epoch).toBe(6);
    expect(appendMemberAddedEvent).toHaveBeenCalledWith({
      groupId: GID, actorUserId: OWNER, addedUserId: 'newcomer', epoch: 6, selfUserId: SELF,
    });
    // add/remove/rename never rotate the key, so there is nothing to drain.
    expect(h.outcome).toBeUndefined();
  });

  it('`remove` of ANOTHER member narrows the conversation row too (B-433)', async () => {
    // Without applyMemberRemovalToUi the sticky `rosterUserIds` keeps the
    // removed user in computeRingSet and they get RUNG on the next call.
    const h = await run({type: 'remove', userId: MEMBER, atEpoch: 5}, state());

    expect(h.written!.members[MEMBER]).toBeUndefined();
    expect(appendMemberRemovedEvent).toHaveBeenCalledWith(expect.objectContaining({
      removedUserId: MEMBER, actorUserId: OWNER, epoch: 6, selfUserId: SELF,
    }));
    expect(applyMemberRemovalToUi).toHaveBeenCalledWith({groupId: GID, removedUserId: MEMBER});
    // Somebody ELSE being removed must never purge OUR copy of the group.
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('`remove` of SELF emits the B-337 purge signal', async () => {
    const h = await run({type: 'remove', userId: SELF, atEpoch: 5}, state());

    expect(h.emit).toHaveBeenCalledWith({kind: 'purge-self-removed', groupId: GID});
    expect(h.crashLog).toHaveBeenCalledWith(expect.stringContaining('self removed'));
  });

  it('`rename` patches the UI row, because nothing displays groups[id].name (B-290)', async () => {
    const h = await run({type: 'rename', name: 'New Name', atEpoch: 5}, state());

    expect(h.written!.name).toBe('New Name');
    expect(applyGroupRenameToUi).toHaveBeenCalledWith(expect.objectContaining({
      groupId: GID, newName: 'New Name', actorUserId: OWNER, selfUserId: SELF,
    }));
  });

  it.each([
    ['setting',  {objectKey: 'ok', keyB64: 'k', ivB64: 'i', mimeType: 'image/jpeg'}, false],
    ['clearing', null, true],
  ])('`photo` (%s) appends the system line with the right cleared flag (B-291)', async (_l, photo, cleared) => {
    await run({type: 'photo', photo, atEpoch: 5} as GroupAdminAction, state());

    expect(appendGroupPhotoChangedEvent).toHaveBeenCalledWith(
      expect.objectContaining({groupId: GID, cleared, actorUserId: OWNER, selfUserId: SELF}),
    );
  });
});

describe('`leave` — G-03 rekey designation + B-433 roster narrowing', () => {
  it('every remaining member narrows its own row for the leaver', async () => {
    // Hoisted above the designation branch on purpose: only ONE device rekeys,
    // but ALL of them must stop ringing the leaver.
    const h = await run({type: 'leave', atEpoch: 5}, state(), {senderId: MEMBER});

    expect(h.written!.members[MEMBER]).toBeUndefined();
    expect(applyMemberRemovalToUi).toHaveBeenCalledWith({groupId: GID, removedUserId: MEMBER});
  });

  it('only the DESIGNATED admin is asked to rekey — the owner while they remain a member', async () => {
    const h = await run({type: 'leave', atEpoch: 5}, state(), {senderId: MEMBER, ownUserId: SELF});

    // Owner is still in the group, so the owner (not us) is designated.
    expect(h.emit).not.toHaveBeenCalled();

    const asOwner = await run({type: 'leave', atEpoch: 5}, state(), {senderId: MEMBER, ownUserId: OWNER});
    expect(asOwner.emit).toHaveBeenCalledWith({kind: 'leave-rekey', groupId: GID, leaverId: MEMBER});
  });

  it('falls back to the lowest-userId remaining admin when the OWNER is the one who left', async () => {
    // Deterministic on every device, so a designation race cannot fork the key.
    const withTwoAdmins = state({
      members: {
        [OWNER]:      {deviceId: 1, admin: true,  joinedAt: 1},
        'aaa-admin':  {deviceId: 1, admin: true,  joinedAt: 2},
        'zzz-admin':  {deviceId: 1, admin: true,  joinedAt: 3},
      },
    } as Partial<GroupState>);

    const lowest = await run({type: 'leave', atEpoch: 5}, withTwoAdmins, {senderId: OWNER, ownUserId: 'aaa-admin'});
    expect(lowest.emit).toHaveBeenCalledWith({kind: 'leave-rekey', groupId: GID, leaverId: OWNER});

    const higher = await run({type: 'leave', atEpoch: 5}, withTwoAdmins, {senderId: OWNER, ownUserId: 'zzz-admin'});
    expect(higher.emit).not.toHaveBeenCalled();
  });

  it('a designated admin holding NO master key is not asked to rekey', async () => {
    const keyless = state({masterKeyB64: ''});
    const h = await run({type: 'leave', atEpoch: 5}, keyless, {senderId: MEMBER, ownUserId: OWNER});
    expect(h.emit).not.toHaveBeenCalled();
  });
});

describe('a key rotation evicts the old key and asks for a drain', () => {
  it('`rekey` returns drain-group so the stashed no_key envelopes replay', async () => {
    const h = await run({type: 'rekey', newMasterKeyB64: KEY_B, atEpoch: 5}, state());

    expect(h.written!.masterKeyB64).toBe(KEY_B);
    expect(h.outcome).toEqual({kind: 'drain-group', groupId: GID});
  });

  it('an action that does NOT change the key returns no outcome', async () => {
    const h = await run({type: 'rename', name: 'X', atEpoch: 5}, state());
    expect(h.outcome).toBeUndefined();
  });
});

describe('no local state for the group', () => {
  it('a non-create action against an unknown group writes nothing and returns nothing', async () => {
    const h = await run({type: 'rekey', newMasterKeyB64: KEY_B, atEpoch: 5}, undefined);

    expect(h.setGroupState).not.toHaveBeenCalled();
    expect(h.outcome).toBeUndefined();
    expect(h.crashLog).not.toHaveBeenCalled();
  });
});
