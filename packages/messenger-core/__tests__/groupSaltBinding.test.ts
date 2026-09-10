import {
  applyAdminAction,
  deriveGroupId,
  isGroupMember,
  makeNewGroup,
  planRemoveAndRekey,
  verifyGroupIdDerivation,
  type GroupAdminAction,
  type GroupState,
} from '@bravo/messenger-core';

/**
 * Audit P1-N13 — the salt used by `deriveGroupId` is now persisted on
 * the GroupState and shipped on the admin `create` action so receivers
 * can verify `deriveGroupId(salt, members) === groupId`.
 *
 * Without this, an attacker (or a buggy sender) could ship an admin-
 * create with an arbitrary `groupId` string and recipients had no
 * cryptographic check beyond trusting the cert. That made it possible
 * to claim a groupId that collided with a real group's id, e.g. to
 * inject admin actions into a thread the attacker was never invited to.
 */
describe('groupClient — P1-N13 salt shipped + verifiable', () => {
  it('makeNewGroup persists saltB64 alongside the derived groupId', () => {
    const state = makeNewGroup({
      name: 'Project Bravo',
      owner: 'alice',
      ownerDeviceId: 1,
      members: [{userId: 'bob', deviceId: 1}, {userId: 'carol', deviceId: 1}],
    });
    expect(state.saltB64).toBeDefined();
    expect(state.saltB64!.length).toBeGreaterThan(0);
  });

  it('verifyGroupIdDerivation returns true when salt + members hash to groupId', () => {
    const state = makeNewGroup({
      name: 'Project Bravo',
      owner: 'alice',
      ownerDeviceId: 1,
      members: [{userId: 'bob', deviceId: 1}, {userId: 'carol', deviceId: 1}],
    });
    expect(verifyGroupIdDerivation(state)).toBe(true);
  });

  it('verifyGroupIdDerivation rejects a state whose groupId was substituted', () => {
    const state = makeNewGroup({
      name: 'Project Bravo',
      owner: 'alice',
      ownerDeviceId: 1,
      members: [{userId: 'bob', deviceId: 1}, {userId: 'carol', deviceId: 1}],
    });
    const tampered: GroupState = {...state, groupId: 'deadbeef'.padEnd(32, '0')};
    expect(verifyGroupIdDerivation(tampered)).toBe(false);
  });

  it('verifyGroupIdDerivation returns true for legacy state with no saltB64 (back-compat)', () => {
    // Legacy v0 row — no salt persisted. The check is a no-op so
    // existing groups continue to load.
    const legacy: GroupState = {
      groupId: 'abc123',
      name: 'Legacy',
      owner: 'alice',
      members: {
        alice: {deviceId: 1, admin: true, joinedAt: 0},
      },
      masterKeyB64: '',
      epoch: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    expect(verifyGroupIdDerivation(legacy)).toBe(true);
  });

  it('applyAdminAction refuses a create whose groupId is forged but salt is shipped', () => {
    const state = makeNewGroup({
      name: 'Project Bravo',
      owner: 'alice',
      ownerDeviceId: 1,
      members: [{userId: 'bob', deviceId: 1}],
    });
    const forged: GroupState = {...state, groupId: 'deadbeef'.padEnd(32, '0')};
    const action: GroupAdminAction = {type: 'create', state: forged};

    // Receiver has no prior state for this group. A legitimate create
    // would install `forged.state` wholesale; the salt-bound check
    // refuses because deriveGroupId(salt, members) !== forged.groupId.
    const empty: GroupState = {
      groupId: '', name: '', owner: '',
      members: {}, masterKeyB64: '', epoch: 0, createdAt: 0, updatedAt: 0,
    };
    const next = applyAdminAction(empty, action, 'alice');
    expect(next).toBe(empty);
  });

  it('applyAdminAction accepts a legitimate create whose salt+members derive the claimed id', () => {
    const state = makeNewGroup({
      name: 'Project Bravo',
      owner: 'alice',
      ownerDeviceId: 1,
      members: [{userId: 'bob', deviceId: 1}],
    });
    const action: GroupAdminAction = {type: 'create', state};
    const empty: GroupState = {
      groupId: '', name: '', owner: '',
      members: {}, masterKeyB64: '', epoch: 0, createdAt: 0, updatedAt: 0,
    };
    const next = applyAdminAction(empty, action, 'alice');
    expect(next.groupId).toBe(state.groupId);
    expect(next.saltB64).toBe(state.saltB64);
    // Transcript chain was seeded.
    expect(next.transcriptHash).toBeDefined();
  });

  // Audit P1-N4 — removed-member messages from the prior epoch (or
  // from a peer racing the remove they haven't applied yet) must not
  // render in the group thread. The membership check on text envelopes
  // is the gate that productionRuntime now applies; this lock-in test
  // documents the predicate so a future refactor can't silently flip it.
  it('audit P1-N4 — isGroupMember returns true for current members', () => {
    const state = makeNewGroup({
      name: 'X', owner: 'alice', ownerDeviceId: 1,
      members: [{userId: 'bob', deviceId: 1}, {userId: 'carol', deviceId: 1}],
    });
    expect(isGroupMember(state, 'alice')).toBe(true);
    expect(isGroupMember(state, 'bob')).toBe(true);
    expect(isGroupMember(state, 'carol')).toBe(true);
  });

  it('audit P1-N4 — isGroupMember returns false for a userId never in the group', () => {
    const state = makeNewGroup({
      name: 'X', owner: 'alice', ownerDeviceId: 1,
      members: [{userId: 'bob', deviceId: 1}],
    });
    expect(isGroupMember(state, 'mallory')).toBe(false);
  });

  it('audit P1-N4 — applyAdminAction(remove) drops the user from isGroupMember', () => {
    const seed = makeNewGroup({
      name: 'X', owner: 'alice', ownerDeviceId: 1,
      members: [{userId: 'bob', deviceId: 1}, {userId: 'carol', deviceId: 1}],
    });
    expect(isGroupMember(seed, 'bob')).toBe(true);

    const plan = planRemoveAndRekey(seed, 'bob');
    // Apply the `remove` action via the admin owner.
    const afterRemove = applyAdminAction(seed, plan.remove, 'alice');
    expect(isGroupMember(afterRemove, 'bob')).toBe(false);
    expect(isGroupMember(afterRemove, 'carol')).toBe(true);

    // Subsequent rekey still doesn't restore membership.
    const afterRekey = applyAdminAction(afterRemove, plan.rekey, 'alice');
    expect(isGroupMember(afterRekey, 'bob')).toBe(false);
  });

  it('deriveGroupId is deterministic in salt+members and changes with either', () => {
    const salt = new Uint8Array(16);
    salt.fill(7);
    const members = ['alice', 'bob'];
    const id1 = deriveGroupId(salt, members);
    const id2 = deriveGroupId(salt, members);
    expect(id1).toBe(id2);

    const saltOther = new Uint8Array(16);
    saltOther.fill(8);
    expect(deriveGroupId(saltOther, members)).not.toBe(id1);
    expect(deriveGroupId(salt, [...members, 'carol'])).not.toBe(id1);
  });
});
