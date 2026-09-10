/**
 * RS-02 — drain logic for conversation membership intents → E2EE rekey
 * actions. Verifies the security-critical mapping (add → addGroupMember on
 * deviceId 1, remove → removeGroupMember with rekey), the ack-only-on-success
 * rule, the idempotent already-in/out ack, and the unknown-group defer.
 * Mirrors dispatchRoomIntents.test.ts / membershipIntents.test.ts.
 */
import {drainConversationIntents} from '../orgWorkspace/conversationIntents';

const mockApi = {
  listMembershipIntents: jest.fn(),
  ackMembershipIntent: jest.fn(),
};
const mockRuntime = {
  addGroupMember: jest.fn(),
  removeGroupMember: jest.fn(),
};

jest.mock('@services/api', () => ({
  conversationApi: {
    listMembershipIntents: (...a: unknown[]) => mockApi.listMembershipIntents(...a),
    ackMembershipIntent: (...a: unknown[]) => mockApi.ackMembershipIntent(...a),
  },
}));
jest.mock('@/modules/messenger/runtime', () => ({
  getMessengerRuntime: async () => mockRuntime,
}));

describe('drainConversationIntents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.ackMembershipIntent.mockResolvedValue({ok: true});
    mockRuntime.addGroupMember.mockResolvedValue({newEpoch: 2});
    mockRuntime.removeGroupMember.mockResolvedValue({newEpoch: 2});
  });

  it('does nothing when there are no intents', async () => {
    mockApi.listMembershipIntents.mockResolvedValue({data: {intents: []}});
    const r = await drainConversationIntents();
    expect(r).toEqual({processed: 0, skipped: 0, failed: 0});
    expect(mockRuntime.addGroupMember).not.toHaveBeenCalled();
  });

  it('maps remove → removeGroupMember with the conversation id as group id, acks after success', async () => {
    mockApi.listMembershipIntents.mockResolvedValue({data: {intents: [
      {id: 'i1', conversation_id: 'conv-1', member_user_id: 'u-9', action: 'remove', created_at: 't'},
    ]}});
    const r = await drainConversationIntents();
    expect(mockRuntime.removeGroupMember).toHaveBeenCalledWith({groupId: 'conv-1', removedUserId: 'u-9'});
    expect(mockApi.ackMembershipIntent).toHaveBeenCalledWith('i1');
    expect(r.processed).toBe(1);
  });

  it('maps add → addGroupMember on deviceId 1', async () => {
    mockApi.listMembershipIntents.mockResolvedValue({data: {intents: [
      {id: 'i2', conversation_id: 'conv-1', member_user_id: 'u-2', action: 'add', created_at: 't'},
    ]}});
    await drainConversationIntents();
    expect(mockRuntime.addGroupMember).toHaveBeenCalledWith({groupId: 'conv-1', newMember: {userId: 'u-2', deviceId: 1}});
  });

  it('does NOT ack when the rekey throws — leaves the intent for retry (at-least-once)', async () => {
    mockApi.listMembershipIntents.mockResolvedValue({data: {intents: [
      {id: 'i3', conversation_id: 'conv-1', member_user_id: 'u-9', action: 'remove', created_at: 't'},
    ]}});
    mockRuntime.removeGroupMember.mockRejectedValueOnce(new Error('relay offline'));
    const r = await drainConversationIntents();
    expect(r.failed).toBe(1);
    expect(mockApi.ackMembershipIntent).not.toHaveBeenCalled();
  });

  it('acks an idempotent no-op (member already out of the group)', async () => {
    mockApi.listMembershipIntents.mockResolvedValue({data: {intents: [
      {id: 'i4', conversation_id: 'conv-1', member_user_id: 'u-9', action: 'remove', created_at: 't'},
    ]}});
    mockRuntime.removeGroupMember.mockRejectedValueOnce(new Error('u-9 is not a member of conv-1'));
    const r = await drainConversationIntents();
    expect(r.processed).toBe(1);
    expect(mockApi.ackMembershipIntent).toHaveBeenCalledWith('i4');
  });

  it('defers (skip, no ack) when this device has no local group state', async () => {
    mockApi.listMembershipIntents.mockResolvedValue({data: {intents: [
      {id: 'i5', conversation_id: 'conv-x', member_user_id: 'u-9', action: 'remove', created_at: 't'},
    ]}});
    mockRuntime.removeGroupMember.mockRejectedValueOnce(new Error('unknown group conv-x'));
    const r = await drainConversationIntents();
    expect(r.skipped).toBe(1);
    expect(mockApi.ackMembershipIntent).not.toHaveBeenCalled();
  });

  it('keeps draining the remaining intents after one fails', async () => {
    mockApi.listMembershipIntents.mockResolvedValue({data: {intents: [
      {id: 'i6', conversation_id: 'conv-1', member_user_id: 'u-1', action: 'remove', created_at: 't'},
      {id: 'i7', conversation_id: 'conv-1', member_user_id: 'u-2', action: 'add', created_at: 't'},
    ]}});
    mockRuntime.removeGroupMember.mockRejectedValueOnce(new Error('relay offline'));
    const r = await drainConversationIntents();
    expect(r.failed).toBe(1);
    expect(r.processed).toBe(1);
    expect(mockApi.ackMembershipIntent).toHaveBeenCalledWith('i7');
  });
});
