import {DispatchService} from './dispatch.service';
import {BookingStateMachine} from '../booking/state-machine.service';
import type {DatabaseService} from '../database/database.service';
import type {OpsAuditService} from '../ops/ops-audit.service';
import type {BookingPushBridge} from '../ops/booking-push-bridge.service';
import type {WalletService} from '../wallet/wallet.service';

/**
 * Step 19 — the client-request rollback primitive. abandonUnstarted must be STATUS-GUARDED
 * so a just-created auto booking that an agency ACCEPTED in the race window (CONFIRMED +
 * escrow HELD) is never clobbered+refunded; it only cancels a still-DRAFT / still-DISPATCHING
 * orphan.
 */
function mk(status: string | null) {
  const txQ = jest.fn().mockResolvedValue([]);
  const txQOne = jest.fn().mockResolvedValue(status === null ? null : {status});
  const tx = {q: txQ, qOne: txQOne};
  const db = {withTransaction: (fn: (t: unknown) => unknown) => fn(tx)} as unknown as DatabaseService;
  const svc = new DispatchService(
    db, new BookingStateMachine(),
    {record: jest.fn()} as unknown as OpsAuditService,
    {} as unknown as BookingPushBridge,
    // refundEscrowHold: D4's refund of a (relist-only) HELD hold — idempotent no-op
    // on the uncharged paths these tests model.
    {refundEscrowHold: jest.fn().mockResolvedValue({refunded: false, credits: 0})} as unknown as WalletService,
  );
  return {svc, txQ};
}

describe('DispatchService.abandonUnstarted', () => {
  it('cancels a pre-commit DRAFT orphan', async () => {
    const {svc, txQ} = mk('DRAFT');
    await svc.abandonUnstarted('b1');
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/UPDATE lite_bookings SET status = 'CANCELLED'/), ['b1']);
  });

  it('cancels a post-commit DISPATCHING orphan + supersedes the live offer', async () => {
    const {svc, txQ} = mk('DISPATCHING');
    await svc.abandonUnstarted('b1');
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/UPDATE dispatch_offers SET status = 'SUPERSEDED'/), ['b1']);
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/UPDATE lite_bookings SET status = 'CANCELLED'/), ['b1']);
  });

  it('NO-OPs (never clobbers) when an agency raced the booking to CONFIRMED+escrow', async () => {
    const {svc, txQ} = mk('CONFIRMED');
    await svc.abandonUnstarted('b1');
    expect(txQ).not.toHaveBeenCalled();
  });

  it('NO-OPs when the booking is already gone/terminal', async () => {
    const {svc, txQ} = mk(null);
    await svc.abandonUnstarted('b1');
    expect(txQ).not.toHaveBeenCalled();
  });
});
