import {OpsService} from './ops.service';
import type {AdminContext} from './admin.guard';

const ADMIN: AdminContext = {user_id: 'adm-1', role: 'ADMIN', call_sign: 'OPS-1', region: 'AE'};

function mk(holdRow: unknown) {
  const txQ = jest.fn().mockResolvedValue([]);
  const txQOne = jest.fn().mockImplementation((sql: string) =>
    /FROM booking_disputes d/.test(sql) ? Promise.resolve(holdRow) : Promise.resolve(null));
  const tx = {q: txQ, qOne: txQOne};
  const db = {withTransaction: (fn: (t: unknown) => unknown) => fn(tx)};
  const wallet = {
    settleEscrowSplit: jest.fn().mockResolvedValue({settled: true, toProvider: 0, toClient: 0, platformFee: 0}),
    clawbackReleasedHold: jest.fn().mockResolvedValue({clawed: true, toClient: 800, toPlatform: 0, toProvider: 0, shortfall: 0}),
  };
  const audit = {recordAdmin: jest.fn().mockResolvedValue(undefined), emit: jest.fn().mockResolvedValue(undefined)};
  // LM-N4 — resolveDispute wakes both parties post-commit.
  const push = {
    disputeResolved: jest.fn().mockResolvedValue(undefined),
    refundIssued: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new OpsService(
    db as never, {} as never, {} as never, {} as never, {} as never,
    audit as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    wallet as never, {} as never, {} as never, push as never,
  );
  return {svc, tx, txQ, wallet, audit, push};
}

describe('OpsService.resolveDispute (Step 11)', () => {
  it('splits a DISPUTED hold (client 300 / provider 500) → PARTIAL, records decided_by + audit', async () => {
    const {svc, txQ, wallet, audit, push} = mk({dispute_status: 'open', booking_id: 'b1', hold_status: 'DISPUTED', gross_credits: 800, region_code: 'AE', client_id: 'c1', provider_user_id: 'agency-A'});
    const res = await svc.resolveDispute('d1', ADMIN, {to_client: 300, to_provider: 500, resolution: 'split decision'});
    expect(res).toEqual({ok: true, dispute_id: 'd1', outcome: 'PARTIAL', to_client: 300, to_provider: 500, platform_fee: 0});
    expect(wallet.settleEscrowSplit).toHaveBeenCalledWith(expect.anything(), 'b1', expect.objectContaining({toProvider: 500, toClient: 300, fromStatuses: ['DISPUTED'], finalStatus: 'PARTIAL'}));
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/UPDATE booking_disputes/), expect.arrayContaining(['d1', 'resolved', 300, 500, 'adm-1']));
    expect(audit.recordAdmin).toHaveBeenCalledWith(ADMIN, 'dispute.resolve', 'booking', 'b1', expect.objectContaining({outcome: 'PARTIAL'}));
    // LM-N4 — both parties woken with the outcome; the client also sees the refund.
    expect(push.disputeResolved).toHaveBeenCalledWith('c1', 'b1', 'PARTIAL');
    expect(push.disputeResolved).toHaveBeenCalledWith('agency-A', 'b1', 'PARTIAL');
    expect(push.refundIssued).toHaveBeenCalledWith('c1', 'b1', 300);
  });

  it('full client refund (provider 0) → REFUNDED, decision upheld', async () => {
    const {svc, wallet} = mk({dispute_status: 'open', booking_id: 'b1', hold_status: 'DISPUTED', gross_credits: 800, region_code: 'AE'});
    const res = await svc.resolveDispute('d1', ADMIN, {to_client: 800, to_provider: 0, resolution: 'agency failed'});
    expect(res.outcome).toBe('REFUNDED');
    expect(wallet.settleEscrowSplit).toHaveBeenCalledWith(expect.anything(), 'b1', expect.objectContaining({finalStatus: 'REFUNDED', basis: 'refund'}));
  });

  it('claws back when the hold already RELEASED', async () => {
    const {svc, wallet} = mk({dispute_status: 'open', booking_id: 'b1', hold_status: 'RELEASED', gross_credits: 800, region_code: 'AE'});
    const res = await svc.resolveDispute('d1', ADMIN, {to_client: 800, to_provider: 0, resolution: 'upheld post-release'});
    expect(res.outcome).toBe('CLAWBACK');
    // clawback reclaims (gross − to_provider) = client refund (800) + platform leg (0).
    expect(wallet.clawbackReleasedHold).toHaveBeenCalledWith(expect.anything(), 'b1', 800, 0, expect.stringMatching(/clawback/));
  });

  it('rejects a dispute that is not open', async () => {
    const {svc} = mk({dispute_status: 'resolved', booking_id: 'b1', hold_status: 'DISPUTED', gross_credits: 800, region_code: 'AE'});
    await expect(svc.resolveDispute('d1', ADMIN, {to_client: 0, to_provider: 800, resolution: 'x'})).rejects.toThrow('dispute_not_open');
  });

  it('404s an unknown dispute', async () => {
    const {svc} = mk(null);
    await expect(svc.resolveDispute('d1', ADMIN, {to_client: 0, to_provider: 0, resolution: 'x'})).rejects.toThrow('Dispute not found');
  });
});
