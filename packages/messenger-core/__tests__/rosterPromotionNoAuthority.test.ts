import {applyAdminAction, makeNewGroup} from '@bravo/messenger-core';

/**
 * RS-08 regression pin — a SERVER-side roster promotion confers NO crypto
 * authority.
 *
 * When the last conversation admin leaves, the auth-service promotes the
 * oldest member in `conversation_members` (conversations.service.ts). That
 * flip is server metadata only: no signed 'promote' group action exists in
 * the transcript, so every receiver's local GroupState still records the
 * member as admin:false — and the admin gate in applyAdminAction must keep
 * silently dropping their add/remove/rekey/rename actions.
 *
 * If someone later adds a real signed-handover path (the architecture-gated
 * RS-08 fix), these expectations change deliberately — do not "fix" this
 * test to make roster admins work; that would re-open the provenance hole.
 */
describe('RS-08 — roster-promoted member has no crypto authority', () => {
  const group = () => makeNewGroup({
    name: 'ops room',
    owner: 'owner-1',
    ownerDeviceId: 1,
    members: [
      {userId: 'member-oldest', deviceId: 1},
      {userId: 'member-b', deviceId: 1},
    ],
  });

  it('baseline: the group state itself never marks a non-owner admin', () => {
    const g = group();
    expect(g.members['owner-1'].admin).toBe(true);
    expect(g.members['member-oldest'].admin).toBe(false);
    expect(g.members['member-b'].admin).toBe(false);
  });

  it('drops add from a roster-"promoted" (non-crypto-admin) sender', () => {
    const g = group();
    const after = applyAdminAction(g, {
      type: 'add', groupId: g.groupId, atEpoch: g.epoch,
      member: {userId: 'intruder', deviceId: 1},
    } as never, 'member-oldest');
    expect(after).toBe(g);                       // silent no-op, state unchanged
    expect(after.members.intruder).toBeUndefined();
    expect(after.epoch).toBe(g.epoch);
  });

  it('drops remove from a non-crypto-admin sender', () => {
    const g = group();
    const after = applyAdminAction(g, {
      type: 'remove', groupId: g.groupId, atEpoch: g.epoch,
      memberUserId: 'member-b',
    } as never, 'member-oldest');
    expect(after).toBe(g);
    expect(after.members['member-b']).toBeDefined();
  });

  it('drops rekey from a non-crypto-admin sender (cannot rotate the master key)', () => {
    const g = group();
    const after = applyAdminAction(g, {
      type: 'rekey', groupId: g.groupId, atEpoch: g.epoch,
      newMasterKeyB64: Buffer.alloc(32, 7).toString('base64'),
    } as never, 'member-oldest');
    expect(after).toBe(g);
    expect(after.masterKeyB64).toBe(g.masterKeyB64);
  });

  it('the same actions from the real crypto admin DO apply (gate is sender-specific)', () => {
    const g = group();
    const after = applyAdminAction(g, {
      type: 'add', groupId: g.groupId, atEpoch: g.epoch,
      member: {userId: 'newcomer', deviceId: 1},
    } as never, 'owner-1');
    expect(after).not.toBe(g);
    expect(after.members.newcomer).toBeDefined();
    expect(after.members.newcomer.admin).toBe(false);  // add NEVER mints an admin
    expect(after.epoch).toBe(g.epoch + 1);
  });
});
