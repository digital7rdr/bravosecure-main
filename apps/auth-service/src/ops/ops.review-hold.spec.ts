/**
 * MON-2 — OpsService.resolveReviewHold: the operator exit for a stranded escrow
 * hold (status='HELD' AND review_required) that the proof-of-completion gate
 * froze. Admin either RELEASES it to the agency (force) or REFUNDS it to the
 * client; both clear the flag, are region-scoped + fail-closed audited, and wake
 * the affected party. The guard rejects any hold not in review.
 */
import {OpsService} from './ops.service';
import type {AdminContext} from './admin.guard';

const ADMIN: AdminContext = {user_id: 'adm-1', role: 'ADMIN', call_sign: 'OPS-1', region: 'AE'};
const REVIEW = {status: 'HELD', review_required: true, region_code: 'AE', client_id: 'c1', provider_user_id: 'agency-A'};

function mk(holdRow: unknown) {
  const txQ = jest.fn().mockResolvedValue([]);
  const txQOne = jest.fn().mockImplementation((sql: string) =>
    /FROM escrow_holds eh/.test(sql) ? Promise.resolve(holdRow) : Promise.resolve(null));
  const tx = {q: txQ, qOne: txQOne};
  const db = {withTransaction: (fn: (t: unknown) => unknown) => fn(tx)};
  const wallet = {refundEscrowHold: jest.fn().mockResolvedValue({refunded: true, credits: 800})};
  const settlement = {settleEscrowRelease: jest.fn().mockResolvedValue({escrow: true, released: true, toProvider: 720, platformFee: 80, providerUserId: 'agency-A'})};
  const audit = {recordAdmin: jest.fn().mockResolvedValue(undefined), emit: jest.fn().mockResolvedValue(undefined)};
  const push = {refundIssued: jest.fn().mockResolvedValue(undefined), payoutSettled: jest.fn().mockResolvedValue(undefined)};
  const svc = new OpsService(
    db as never, {} as never, {} as never, {} as never, {} as never,
    audit as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    wallet as never, settlement as never, {} as never, push as never,
  );
  return {svc, txQ, wallet, settlement, audit, push};
}

describe('OpsService.resolveReviewHold (MON-2)', () => {
  it('REFUND repays the client, clears review_required, audits, and pushes the refund', async () => {
    const {svc, txQ, wallet, audit, push} = mk(REVIEW);
    const res = await svc.resolveReviewHold('b1', ADMIN, {action: 'refund', reason: 'could not verify'});
    expect(res).toEqual({ok: true, booking_id: 'b1', outcome: 'REFUNDED', credits: 800});
    expect(wallet.refundEscrowHold).toHaveBeenCalledWith(expect.anything(), 'b1', expect.stringMatching(/refund/i));
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/review_required = FALSE/), ['b1']);
    expect(audit.recordAdmin).toHaveBeenCalledWith(ADMIN, 'escrow.review_resolve', 'booking', 'b1', expect.objectContaining({action: 'refund', outcome: 'REFUNDED'}));
    expect(push.refundIssued).toHaveBeenCalledWith('c1', 'b1', 800);
  });

  it('RELEASE force-releases to the agency, clears the flag, and pushes the payout', async () => {
    const {svc, settlement, push} = mk(REVIEW);
    const res = await svc.resolveReviewHold('b1', ADMIN, {action: 'release', reason: 'verified offline'});
    expect(res.outcome).toBe('RELEASED');
    expect(res.credits).toBe(720);
    expect(settlement.settleEscrowRelease).toHaveBeenCalledWith(expect.anything(), 'b1', {kind: 'admin', userId: 'adm-1'}, {force: true});
    expect(push.payoutSettled).toHaveBeenCalledWith('agency-A', 'b1', 720);
  });

  it('rejects a hold that is not in review (HELD + review_required only)', async () => {
    const {svc} = mk({status: 'PENDING_RELEASE', review_required: false, region_code: 'AE', client_id: 'c1', provider_user_id: 'a'});
    await expect(svc.resolveReviewHold('b1', ADMIN, {action: 'refund', reason: 'x'})).rejects.toThrow(/hold_not_in_review/);
  });

  it('404s when no hold exists for the booking', async () => {
    const {svc} = mk(null);
    await expect(svc.resolveReviewHold('b1', ADMIN, {action: 'refund', reason: 'x'})).rejects.toThrow('escrow_hold_not_found');
  });
});
