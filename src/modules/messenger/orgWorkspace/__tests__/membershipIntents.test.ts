jest.mock('@services/api', () => ({
  departmentApi: {listMembershipIntents: jest.fn(), ackMembershipIntent: jest.fn()},
}));
jest.mock('@/modules/messenger/runtime', () => ({getMessengerRuntime: jest.fn()}));

import {drainMembershipIntents} from '../membershipIntents';
import {departmentApi} from '@services/api';
import {getMessengerRuntime} from '@/modules/messenger/runtime';

const mockApi = departmentApi as unknown as {
  listMembershipIntents: jest.Mock; ackMembershipIntent: jest.Mock;
};
const mockRuntime = {addGroupMember: jest.fn(), removeGroupMember: jest.fn()};

const intent = (over: Record<string, unknown> = {}) => ({
  id: 'i1', action: 'add', member_user_id: 'u1', group_conversation_id: 'g1', ...over,
});

describe('drainMembershipIntents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getMessengerRuntime as jest.Mock).mockImplementation(async () => mockRuntime);
    mockApi.ackMembershipIntent.mockResolvedValue({ok: true});
  });

  it('processes a successful add and acks it', async () => {
    mockApi.listMembershipIntents.mockResolvedValue({data: {intents: [intent()]}});
    mockRuntime.addGroupMember.mockResolvedValue(undefined);
    const res = await drainMembershipIntents();
    expect(mockApi.ackMembershipIntent).toHaveBeenCalledWith('i1');
    expect(res.processed).toBe(1);
  });

  it('D2-g: acks an already-member intent as a settled no-op (no churn)', async () => {
    mockApi.listMembershipIntents.mockResolvedValue({data: {intents: [intent()]}});
    mockRuntime.addGroupMember.mockRejectedValue(new Error('u1 is already a member of g1'));
    const res = await drainMembershipIntents();
    expect(mockApi.ackMembershipIntent).toHaveBeenCalledWith('i1');
    expect(res.processed).toBe(1);
    expect(res.failed).toBe(0);
  });

  it('D2-g: acks an already-removed (not a member) remove intent', async () => {
    mockApi.listMembershipIntents.mockResolvedValue({data: {intents: [intent({action: 'remove'})]}});
    mockRuntime.removeGroupMember.mockRejectedValue(new Error('u1 is not a member of g1'));
    const res = await drainMembershipIntents();
    expect(mockApi.ackMembershipIntent).toHaveBeenCalledWith('i1');
    expect(res.processed).toBe(1);
  });

  it('D2-e: defers (skips, never acks) when this device has no group state', async () => {
    mockApi.listMembershipIntents.mockResolvedValue({data: {intents: [intent()]}});
    mockRuntime.addGroupMember.mockRejectedValue(new Error('addGroupMember: unknown group g1'));
    const res = await drainMembershipIntents();
    expect(mockApi.ackMembershipIntent).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
    expect(res.failed).toBe(0);
  });

  it('leaves a genuine failure pending (not acked)', async () => {
    mockApi.listMembershipIntents.mockResolvedValue({data: {intents: [intent({action: 'remove'})]}});
    mockRuntime.removeGroupMember.mockRejectedValue(new Error('network down'));
    const res = await drainMembershipIntents();
    expect(mockApi.ackMembershipIntent).not.toHaveBeenCalled();
    expect(res.failed).toBe(1);
  });

  it('D5-b: coalesces concurrent drains into a single in-flight pass', async () => {
    let resolveList: (v: unknown) => void = () => {};
    mockApi.listMembershipIntents.mockReturnValue(new Promise(r => { resolveList = r; }));
    const p1 = drainMembershipIntents();
    const p2 = drainMembershipIntents();
    expect(p1).toBe(p2);
    resolveList({data: {intents: []}});
    await Promise.all([p1, p2]);
    expect(mockApi.listMembershipIntents).toHaveBeenCalledTimes(1);
  });
});
