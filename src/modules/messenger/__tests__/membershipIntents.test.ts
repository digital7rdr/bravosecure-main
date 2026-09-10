/**
 * Drain logic for org-workspace membership intents → E2EE rekey actions.
 * Verifies the security-critical mapping (remove → removeGroupMember+rekey),
 * the ack-only-on-success rule, and that unprovisioned channels are skipped.
 */
import {drainMembershipIntents} from '../orgWorkspace/membershipIntents';

const mockApi = {
  listMembershipIntents: jest.fn(),
  ackMembershipIntent: jest.fn(),
};
const mockRuntime = {
  addGroupMember: jest.fn(),
  removeGroupMember: jest.fn(),
};

jest.mock('@services/api', () => ({
  departmentApi: {
    listMembershipIntents: (...a: unknown[]) => mockApi.listMembershipIntents(...a),
    ackMembershipIntent: (...a: unknown[]) => mockApi.ackMembershipIntent(...a),
  },
}));
jest.mock('@/modules/messenger/runtime', () => ({
  getMessengerRuntime: async () => mockRuntime,
}));

describe('drainMembershipIntents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.ackMembershipIntent.mockResolvedValue({ok: true});
    mockRuntime.addGroupMember.mockResolvedValue({newEpoch: 2});
    mockRuntime.removeGroupMember.mockResolvedValue({newEpoch: 2});
  });

  it('does nothing when there are no intents', async () => {
    mockApi.listMembershipIntents.mockResolvedValue({data: {intents: []}});
    const r = await drainMembershipIntents();
    expect(r).toEqual({processed: 0, skipped: 0, failed: 0});
    expect(mockRuntime.removeGroupMember).not.toHaveBeenCalled();
  });

  it('maps remove → removeGroupMember (rekey) and acks only after success', async () => {
    mockApi.listMembershipIntents.mockResolvedValue({data: {intents: [
      {id: 'i1', channel_id: 'c1', group_conversation_id: 'g1', member_user_id: 'cpo-9', action: 'remove', created_at: 't'},
    ]}});
    const r = await drainMembershipIntents();
    expect(mockRuntime.removeGroupMember).toHaveBeenCalledWith({groupId: 'g1', removedUserId: 'cpo-9'});
    expect(mockApi.ackMembershipIntent).toHaveBeenCalledWith('i1');
    expect(r.processed).toBe(1);
  });

  it('maps add → addGroupMember on deviceId 1', async () => {
    mockApi.listMembershipIntents.mockResolvedValue({data: {intents: [
      {id: 'i2', channel_id: 'c1', group_conversation_id: 'g1', member_user_id: 'cpo-2', action: 'add', created_at: 't'},
    ]}});
    await drainMembershipIntents();
    expect(mockRuntime.addGroupMember).toHaveBeenCalledWith({
      groupId: 'g1', newMember: {userId: 'cpo-2', deviceId: 1},
    });
  });

  it('skips intents for channels with no provisioned group (nothing to rekey yet)', async () => {
    mockApi.listMembershipIntents.mockResolvedValue({data: {intents: [
      {id: 'i3', channel_id: 'c1', group_conversation_id: null, member_user_id: 'cpo-3', action: 'remove', created_at: 't'},
    ]}});
    const r = await drainMembershipIntents();
    expect(r.skipped).toBe(1);
    expect(mockRuntime.removeGroupMember).not.toHaveBeenCalled();
    expect(mockApi.ackMembershipIntent).not.toHaveBeenCalled();
  });

  it('does NOT ack when the rekey throws — leaves the intent for retry', async () => {
    mockApi.listMembershipIntents.mockResolvedValue({data: {intents: [
      {id: 'i4', channel_id: 'c1', group_conversation_id: 'g1', member_user_id: 'cpo-9', action: 'remove', created_at: 't'},
    ]}});
    mockRuntime.removeGroupMember.mockRejectedValueOnce(new Error('lock busy'));
    const r = await drainMembershipIntents();
    expect(r.failed).toBe(1);
    expect(mockApi.ackMembershipIntent).not.toHaveBeenCalled();
  });
});
