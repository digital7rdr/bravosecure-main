/**
 * Drain logic for dispatch Ops-Room membership intents → E2EE rekey actions
 * (Step 12). Verifies the security-critical mapping (add → addGroupMember+rekey on
 * deviceId 1, remove → removeGroupMember+rekey), the ack-only-on-success rule, and
 * that rooms with no provisioned group are skipped. Mirrors membershipIntents.test.ts.
 */
import {drainDispatchRoomIntents} from '../orgWorkspace/dispatchRoomIntents';

const mockApi = {
  listRoomIntents: jest.fn(),
  ackRoomIntent: jest.fn(),
  claimRoomCrypto: jest.fn(),
};
const mockRuntime = {
  addGroupMember: jest.fn(),
  removeGroupMember: jest.fn(),
  ensureAssignedGroup: jest.fn(),
};
// B-207/B-210 → B-416 — the drain admits the company OWNER (account_kind
// 'agency' AND org === null) OR a delegated MANAGER (managed_org non-null),
// per isOpsRoomKeyAuthority. Single-mint safety no longer rests on the
// identity gate: drainOnce CLAIMS each room on the server first
// (PK-arbitrated) and stands down wherever another account already won.
// Default to a company owner that wins its claims so the pre-existing
// behavioural tests below still exercise the drain body.
//
// B-210 — `is_org_manager` is NOT the "is this a delegated manager" signal: it is
// TRUE for the owner too (resolveIsOrgManager counts a company account as "manager
// of its own org"). The manager discriminator is `managed_org` (structurally null
// for owners); `org` alone can't be it either — a plain managed CPO also carries a
// non-null org, and a promoted-CPO manager reads account_kind 'cpo'.
let mockAuthUser: {
  id?: string; account_kind?: string; is_org_manager?: boolean;
  org?: {id: string; name: string} | null;
  managed_org?: {id: string; name: string} | null;
  owns_agency?: boolean;
} | null = null;

jest.mock('@services/api', () => ({
  dispatchApi: {
    listRoomIntents: (...a: unknown[]) => mockApi.listRoomIntents(...a),
    ackRoomIntent: (...a: unknown[]) => mockApi.ackRoomIntent(...a),
    claimRoomCrypto: (...a: unknown[]) => mockApi.claimRoomCrypto(...a),
  },
}));
jest.mock('@/modules/messenger/runtime', () => ({
  getMessengerRuntime: async () => mockRuntime,
}));
jest.mock('@store/authStore', () => ({
  useAuthStore: {getState: () => ({user: mockAuthUser})},
}));

describe('drainDispatchRoomIntents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthUser = {id: 'owner-1', account_kind: 'agency', is_org_manager: false};
    mockApi.ackRoomIntent.mockResolvedValue({ok: true});
    // B-416 — default: this account wins every claim, so the behavioural
    // tests exercise the full drain body exactly as before the claim landed.
    mockApi.claimRoomCrypto.mockResolvedValue({data: {claimed_by: 'owner-1'}});
    mockRuntime.addGroupMember.mockResolvedValue({newEpoch: 2});
    mockRuntime.removeGroupMember.mockResolvedValue({newEpoch: 2});
    mockRuntime.ensureAssignedGroup.mockResolvedValue({groupId: 'g1', alreadyExisted: false});
  });

  it('does nothing when there are no intents', async () => {
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: []}});
    const r = await drainDispatchRoomIntents();
    expect(r).toEqual({processed: 0, skipped: 0, failed: 0});
    expect(mockRuntime.addGroupMember).not.toHaveBeenCalled();
  });

  it('maps add → addGroupMember on deviceId 1 and acks only after success', async () => {
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i1', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-2', action: 'add', created_at: 't'},
    ]}});
    const r = await drainDispatchRoomIntents();
    expect(mockRuntime.addGroupMember).toHaveBeenCalledWith({groupId: 'g1', newMember: {userId: 'cpo-2', deviceId: 1}});
    expect(mockApi.ackRoomIntent).toHaveBeenCalledWith('i1');
    expect(r.processed).toBe(1);
  });

  it('maps remove → removeGroupMember (rekey on the post-remove set)', async () => {
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i2', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-9', action: 'remove', created_at: 't'},
    ]}});
    await drainDispatchRoomIntents();
    expect(mockRuntime.removeGroupMember).toHaveBeenCalledWith({groupId: 'g1', removedUserId: 'cpo-9'});
  });

  it('skips intents for rooms with no provisioned group (nothing to rekey yet)', async () => {
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i3', booking_id: 'b1', conversation_id: null, member_user_id: 'cpo-3', action: 'add', created_at: 't'},
    ]}});
    const r = await drainDispatchRoomIntents();
    expect(r.skipped).toBe(1);
    expect(mockRuntime.addGroupMember).not.toHaveBeenCalled();
    expect(mockApi.ackRoomIntent).not.toHaveBeenCalled();
  });

  it('MISSION-GROUP — bootstraps the Ops Room group ONCE per room (client as initial member) before the CPO adds', async () => {
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i1', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-2', action: 'add', created_at: 't', client_id: 'client-1', conversation_title: 'MISSION X · OPS ROOM'},
      {id: 'i2', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-3', action: 'add', created_at: 't', client_id: 'client-1', conversation_title: 'MISSION X · OPS ROOM'},
    ]}});
    const r = await drainDispatchRoomIntents();
    // The server-assigned room is bootstrapped exactly once (not per-intent),
    // with the client as the initial non-agency member — this is what mints the
    // group master key locally so the CPO add-intents stop looping `pending`.
    expect(mockRuntime.ensureAssignedGroup).toHaveBeenCalledTimes(1);
    expect(mockRuntime.ensureAssignedGroup).toHaveBeenCalledWith({
      groupId: 'g1', name: 'MISSION X · OPS ROOM', members: ['client-1'],
    });
    // Both CPO adds still applied + acked after the bootstrap.
    expect(mockRuntime.addGroupMember).toHaveBeenCalledTimes(2);
    expect(r.processed).toBe(2);
  });

  it('MISSION-GROUP — a transient bootstrap failure does not abort the drain', async () => {
    mockRuntime.ensureAssignedGroup.mockRejectedValueOnce(new Error('offline'));
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i1', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-2', action: 'add', created_at: 't', client_id: 'client-1', conversation_title: 'T'},
    ]}});
    const r = await drainDispatchRoomIntents();
    // Bootstrap threw but the add still ran (addGroupMember is independently
    // idempotent/retry-safe); the drain didn't crash.
    expect(mockRuntime.addGroupMember).toHaveBeenCalledTimes(1);
    expect(r).toBeDefined();
  });

  it('does NOT ack when the rekey throws — leaves the intent for retry (at-least-once)', async () => {
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i4', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-9', action: 'add', created_at: 't'},
    ]}});
    mockRuntime.addGroupMember.mockRejectedValueOnce(new Error('group not bootstrapped'));
    const r = await drainDispatchRoomIntents();
    expect(r.failed).toBe(1);
    expect(mockApi.ackRoomIntent).not.toHaveBeenCalled();
  });

  // ─── B-207/B-416 — authority gate, claim arbitration, benign-ack, coalescer ───

  it('B-416 — a delegated MANAGER (promoted-CPO shape) with a WON claim drains', async () => {
    // FLIPPED from the B-207 "manager never drains" pin (founder-approved
    // B-416): the identity gate admits managers; the fork-safety the old pin
    // defended moved to the server's atomic per-room claim, exercised below.
    // A promoted-CPO manager reads account_kind 'cpo' (cpo precedence in
    // deriveAccountKind) with managed_org non-null — the shape that proves
    // account_kind can never be the manager arm's discriminator.
    mockAuthUser = {id: 'mgr-1', account_kind: 'cpo', is_org_manager: true,
      org: {id: 'owner-1', name: 'Some Agency'}, managed_org: {id: 'owner-1', name: 'Some Agency'}};
    mockApi.claimRoomCrypto.mockResolvedValue({data: {claimed_by: 'mgr-1'}});
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i1', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-2', action: 'add', created_at: 't', client_id: 'client-1', conversation_title: 'T'},
    ]}});
    const r = await drainDispatchRoomIntents();
    expect(mockApi.claimRoomCrypto).toHaveBeenCalledWith('g1');
    expect(mockRuntime.ensureAssignedGroup).toHaveBeenCalledTimes(1);
    expect(mockRuntime.addGroupMember).toHaveBeenCalledTimes(1);
    expect(r.processed).toBe(1);
  });

  it('B-416 — a PURE delegated manager (agency kind + non-null org + managed_org) drains too', async () => {
    mockAuthUser = {id: 'mgr-2', account_kind: 'agency', is_org_manager: true,
      org: {id: 'owner-1', name: 'Some Agency'}, managed_org: {id: 'owner-1', name: 'Some Agency'}};
    mockApi.claimRoomCrypto.mockResolvedValue({data: {claimed_by: 'mgr-2'}});
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i1', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-2', action: 'add', created_at: 't', client_id: 'client-1', conversation_title: 'T'},
    ]}});
    const r = await drainDispatchRoomIntents();
    expect(r.processed).toBe(1);
  });

  it('B-417 — THE STRANDED OWNER: workspace-joined owner (non-null org) with owns_agency DRAINS', async () => {
    // Phase B let an owner join another org's workspace, which makes their
    // `org` NON-null (four-arm fallback) — the legacy `!org` owner inference
    // then reads them as a non-owner and their device silently stopped
    // claiming/draining their own agency's rooms. The server-computed
    // owns_agency fact is the rescue arm.
    mockAuthUser = {id: 'owner-1', account_kind: 'agency', is_org_manager: true,
      org: {id: 'ws-9', name: 'Joined Workspace'}, managed_org: null, owns_agency: true};
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i1', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-2', action: 'add', created_at: 't', client_id: 'client-1', conversation_title: 'T'},
    ]}});
    const r = await drainDispatchRoomIntents();
    expect(mockApi.claimRoomCrypto).toHaveBeenCalledWith('g1');
    expect(r.processed).toBe(1);
  });

  it('B-417 — the same persona against an OLD server (owns_agency undefined) still refuses (mixed-version pin)', async () => {
    // Documents the rollout story: until the server ships the fact, the
    // workspace-joined owner stays in today's (broken) state — but no
    // OTHER persona regresses, because the legacy arm is kept verbatim.
    mockAuthUser = {id: 'owner-1', account_kind: 'agency', is_org_manager: true,
      org: {id: 'ws-9', name: 'Joined Workspace'}, managed_org: null};
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i1', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-2', action: 'add', created_at: 't'},
    ]}});
    const r = await drainDispatchRoomIntents();
    expect(mockApi.listRoomIntents).not.toHaveBeenCalled();
    expect(r).toEqual({processed: 0, skipped: 0, failed: 0});
  });

  it('B-416 — a plain managed CPO (non-null org, NO managed_org) NEVER drains', async () => {
    // Pins the org-vs-managed_org distinction: org alone must not admit.
    mockAuthUser = {id: 'cpo-1', account_kind: 'cpo', org: {id: 'owner-1', name: 'Some Agency'}, managed_org: null};
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i1', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-2', action: 'add', created_at: 't'},
    ]}});
    const r = await drainDispatchRoomIntents();
    expect(mockApi.listRoomIntents).not.toHaveBeenCalled();
    expect(r).toEqual({processed: 0, skipped: 0, failed: 0});
  });

  it('B-416 — a room CLAIMED BY ANOTHER account is fully stood down: no bootstrap, no add, no ack, not failed', async () => {
    mockApi.claimRoomCrypto.mockResolvedValue({data: {claimed_by: 'someone-else'}});
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i1', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-2', action: 'add', created_at: 't', client_id: 'client-1', conversation_title: 'T'},
    ]}});
    const r = await drainDispatchRoomIntents();
    expect(mockRuntime.ensureAssignedGroup).not.toHaveBeenCalled();
    expect(mockRuntime.addGroupMember).not.toHaveBeenCalled();
    expect(mockApi.ackRoomIntent).not.toHaveBeenCalled();
    expect(r).toEqual({processed: 0, skipped: 1, failed: 0});
  });

  it('B-416 — a FAILED claim call fails CLOSED: the room is treated as not-mine', async () => {
    mockApi.claimRoomCrypto.mockRejectedValue(new Error('network'));
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i1', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-2', action: 'add', created_at: 't', client_id: 'client-1', conversation_title: 'T'},
    ]}});
    const r = await drainDispatchRoomIntents();
    expect(mockRuntime.ensureAssignedGroup).not.toHaveBeenCalled();
    expect(r).toEqual({processed: 0, skipped: 1, failed: 0});
  });

  it('B-416 — the claim runs ONCE per distinct room and BEFORE ensureAssignedGroup', async () => {
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i1', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-2', action: 'add', created_at: 't', client_id: 'client-1', conversation_title: 'T'},
      {id: 'i2', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-3', action: 'add', created_at: 't', client_id: 'client-1', conversation_title: 'T'},
    ]}});
    const order: string[] = [];
    mockApi.claimRoomCrypto.mockImplementation(async () => { order.push('claim'); return {data: {claimed_by: 'owner-1'}}; });
    mockRuntime.ensureAssignedGroup.mockImplementation(async () => { order.push('bootstrap'); return {groupId: 'g1', alreadyExisted: false}; });
    await drainDispatchRoomIntents();
    expect(mockApi.claimRoomCrypto).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['claim', 'bootstrap']);
  });

  it("B-416 — the claimant's OWN add-intent (cannot add self) is benign-ACKED, never churned", async () => {
    // The owner is seated + intented now (decline reason (a)), so the
    // claimant always meets its own add-intent, and addGroupMember refuses
    // self-adds BEFORE the already-member check. Without this triage arm the
    // intent would count `failed` and retry on every drain forever.
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i9', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'owner-1', action: 'add', created_at: 't', client_id: 'client-1', conversation_title: 'T'},
    ]}});
    mockRuntime.addGroupMember.mockRejectedValueOnce(
      Object.assign(new Error('cannot add self via addGroupMember'), {code: 'CANNOT_ADD_SELF'}));
    const r = await drainDispatchRoomIntents();
    expect(mockApi.ackRoomIntent).toHaveBeenCalledWith('i9');
    expect(r.processed).toBe(1);
    expect(r.failed).toBe(0);
  });

  it('B-416 (defense-in-depth) — an only-admins refusal is SKIPPED without ack, never churned or dropped', async () => {
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i8', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-2', action: 'add', created_at: 't', client_id: 'client-1', conversation_title: 'T'},
    ]}});
    mockRuntime.addGroupMember.mockRejectedValueOnce(
      Object.assign(new Error('only admins can add members'), {code: 'NOT_ADMIN'}));
    const r = await drainDispatchRoomIntents();
    expect(mockApi.ackRoomIntent).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
    expect(r.failed).toBe(0);
  });

  it('B-210 — the REAL owner (is_org_manager=true, org=null) still drains — this is the production regression', async () => {
    // DOCUMENTS B-210: resolveIsOrgManager (account-kind.ts) returns TRUE for the
    // owner too — "a company account counts as manager of its own org" is that
    // function's own documented contract. A gate keyed on `!is_org_manager` (the
    // original B-207 code) therefore ALWAYS evaluated false for the real owner and
    // silently no-op'd the drain on every trigger in production — confirmed live on
    // staging via an instrumented diagnostic build showing exactly this shape:
    // {account_kind: 'agency', is_org_manager: true} for the true company owner.
    // Every mission Ops Room was stuck keyless until manually unstuck. The correct
    // owner-only signal is `org === null` (asserted below alongside is_org_manager
    // being true, to prove the fix does NOT regress to keying off that field).
    mockAuthUser = {id: 'owner-1', account_kind: 'agency', is_org_manager: true, org: null};
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i1', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-2', action: 'add', created_at: 't', client_id: 'client-1', conversation_title: 'T'},
    ]}});
    const r = await drainDispatchRoomIntents();
    expect(mockApi.listRoomIntents).toHaveBeenCalled();
    expect(mockRuntime.addGroupMember).toHaveBeenCalledWith({groupId: 'g1', newMember: {userId: 'cpo-2', deviceId: 1}});
    expect(r.processed).toBe(1);
  });

  it('B-207 (M1 safety) — a non-agency account (client / CPO) never drains', async () => {
    mockAuthUser = {account_kind: 'client'};
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i1', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-2', action: 'add', created_at: 't'},
    ]}});
    const r = await drainDispatchRoomIntents();
    expect(mockApi.listRoomIntents).not.toHaveBeenCalled();
    expect(r).toEqual({processed: 0, skipped: 0, failed: 0});
  });

  it('B-207 (S2) — an ALREADY_MEMBER add (the client, already the bootstrap member) is benign-ACKED, not left pending', async () => {
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i1', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'client-1', action: 'add', created_at: 't', client_id: 'client-1', conversation_title: 'T'},
    ]}});
    mockRuntime.addGroupMember.mockRejectedValueOnce(
      Object.assign(new Error('client-1 is already a member of g1'), {code: 'ALREADY_MEMBER'}));
    const r = await drainDispatchRoomIntents();
    expect(mockApi.ackRoomIntent).toHaveBeenCalledWith('i1');
    expect(r.processed).toBe(1);
    expect(r.failed).toBe(0);
  });

  it('B-207 (S2) — a NOT_A_MEMBER remove is benign-ACKED too', async () => {
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i2', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-9', action: 'remove', created_at: 't'},
    ]}});
    mockRuntime.removeGroupMember.mockRejectedValueOnce(
      new Error('cpo-9 is not a member of g1'));
    const r = await drainDispatchRoomIntents();
    expect(mockApi.ackRoomIntent).toHaveBeenCalledWith('i2');
    expect(r.processed).toBe(1);
  });

  it('B-207 (D2-e) — an "unknown group" error is SKIPPED (deferred to the owner device), not acked', async () => {
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i3', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-2', action: 'add', created_at: 't'},
    ]}});
    mockRuntime.addGroupMember.mockRejectedValueOnce(new Error('addGroupMember: unknown group g1'));
    const r = await drainDispatchRoomIntents();
    expect(r.skipped).toBe(1);
    expect(r.failed).toBe(0);
    expect(mockApi.ackRoomIntent).not.toHaveBeenCalled();
  });

  it('B-207 (M1) — coalesces concurrent drains into ONE pass (no ack race across the widened triggers)', async () => {
    let resolveList: (v: unknown) => void = () => {};
    mockApi.listRoomIntents.mockReturnValueOnce(new Promise(r => { resolveList = r; }));
    const p1 = drainDispatchRoomIntents();
    const p2 = drainDispatchRoomIntents();
    resolveList({data: {intents: []}});
    await Promise.all([p1, p2]);
    expect(mockApi.listRoomIntents).toHaveBeenCalledTimes(1);
  });
});
