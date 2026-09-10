import {BookingService} from './booking.service';
import type {DatabaseService} from '../database/database.service';
import type {WalletService} from '../wallet/wallet.service';
import type {SettlementService} from '../settlement/settlement.service';
import type {ConfigService} from '@nestjs/config';

/** Build a BookingService with mocked deps + a tx routed by SQL regex. */
function mk(opts: {
  firstQOne?: unknown;                                   // the pre-txn SELECT (cancel)
  dbRows?: Array<[RegExp, unknown]>;                     // db.qOne routes (else firstQOne)
  txRows?: Array<[RegExp, unknown]>;                     // tx.qOne routes
  cfg?: Record<string, unknown>;
}) {
  const txQ = jest.fn().mockImplementation((sql: string) => {
    // LM-B4 — the cancel flip is status-guarded + RETURNING; give it its row.
    if (/UPDATE lite_bookings/.test(sql)) return Promise.resolve([{id: 'b1'}]);
    return Promise.resolve([]);
  });
  const txQOne = jest.fn().mockImplementation((sql: string) => {
    for (const [re, val] of opts.txRows ?? []) if (re.test(sql)) return Promise.resolve(val);
    // LM-B4 — cancel's booking read now runs INSIDE the txn under FOR UPDATE.
    if (/SELECT status, payment_captured/.test(sql)) return Promise.resolve(opts.firstQOne ?? null);
    return Promise.resolve(null);
  });
  const tx = {q: txQ, qOne: txQOne};
  const db = {
    qOne: jest.fn().mockImplementation((sql: string) => {
      for (const [re, val] of opts.dbRows ?? []) if (re.test(sql)) return Promise.resolve(val);
      return Promise.resolve(opts.firstQOne ?? null);
    }),
    q: jest.fn().mockResolvedValue([]),
    withTransaction: (fn: (t: unknown) => unknown) => fn(tx),
  } as unknown as DatabaseService;
  const wallet = {
    refundEscrowHold: jest.fn().mockResolvedValue({refunded: true, credits: 800}),
    settleEscrowSplit: jest.fn().mockResolvedValue({settled: true, toProvider: 100, toClient: 700, platformFee: 0}),
    refundForBooking: jest.fn().mockResolvedValue({refunded: true, credits: 0, balance: {}}),
  } as unknown as WalletService;
  const settlement = {settleEscrowRelease: jest.fn().mockResolvedValue({escrow: true, released: true, toProvider: 800, platformFee: 0})} as unknown as SettlementService;
  const config = {get: (k: string) => (opts.cfg ?? {})[k]} as unknown as ConfigService;
  const fsm = {assert: jest.fn()};
  const pool = {release: jest.fn().mockResolvedValue(undefined)};
  const svc = new BookingService(
    db, {} as never, fsm as never, pool as never, pool as never, wallet, {} as never, settlement, config,
  );
  return {svc, db, tx, txQ, txQOne, wallet, settlement, fsm};
}

describe('BookingService — Step 11 client escrow endpoints', () => {
  describe('confirmComplete', () => {
    it('releases the hold via SettlementService when PENDING_RELEASE + owner + not review', async () => {
      const {svc, settlement} = mk({txRows: [[/FROM escrow_holds eh JOIN lite_bookings/, {status: 'PENDING_RELEASE', review_required: false, client_id: 'c1'}]]});
      const res = await svc.confirmComplete('c1', 'b1');
      expect(res).toEqual({id: 'b1', status: 'RELEASED', to_provider_credits: 800});
      expect(settlement.settleEscrowRelease).toHaveBeenCalledWith(expect.anything(), 'b1', {kind: 'client', userId: 'c1'});
    });
    it('rejects a non-owner', async () => {
      const {svc} = mk({txRows: [[/FROM escrow_holds eh JOIN lite_bookings/, {status: 'PENDING_RELEASE', review_required: false, client_id: 'OWNER'}]]});
      await expect(svc.confirmComplete('intruder', 'b1')).rejects.toThrow('Booking not found');
    });
    it('rejects when review_required', async () => {
      const {svc} = mk({txRows: [[/FROM escrow_holds eh JOIN lite_bookings/, {status: 'PENDING_RELEASE', review_required: true, client_id: 'c1'}]]});
      await expect(svc.confirmComplete('c1', 'b1')).rejects.toThrow('confirm_not_allowed_review');
    });
    it('rejects when not PENDING_RELEASE', async () => {
      const {svc} = mk({txRows: [[/FROM escrow_holds eh JOIN lite_bookings/, {status: 'HELD', review_required: false, client_id: 'c1'}]]});
      await expect(svc.confirmComplete('c1', 'b1')).rejects.toThrow('confirm_not_allowed');
    });
  });

  describe('openDispute', () => {
    it('flips PENDING_RELEASE → DISPUTED and inserts an open dispute', async () => {
      const {svc, txQ} = mk({txRows: [
        [/SELECT eh\.status, b\.client_id/, {status: 'PENDING_RELEASE', client_id: 'c1'}],
        [/UPDATE escrow_holds SET status = 'DISPUTED'/, {id: 'eh1'}],
        [/INSERT INTO booking_disputes/, {id: 'd1'}],
      ]});
      const res = await svc.openDispute('c1', 'b1', {category: 'not_performed', reason: 'never showed'});
      expect(res).toEqual({id: 'b1', status: 'DISPUTED', dispute_id: 'd1'});
      // the flip is the conditional WHERE status='PENDING_RELEASE' that beats the sweep
      expect(txQ).not.toHaveBeenCalledWith(expect.stringMatching(/payout/), expect.anything());
    });
    it('rejects when not PENDING_RELEASE (already released or terminal)', async () => {
      const {svc} = mk({txRows: [[/SELECT eh\.status, b\.client_id/, {status: 'RELEASED', client_id: 'c1'}]]});
      await expect(svc.openDispute('c1', 'b1', {category: 'billing'})).rejects.toThrow('dispute_not_allowed');
    });
    it('rejects a non-owner', async () => {
      const {svc} = mk({txRows: [[/SELECT eh\.status, b\.client_id/, {status: 'PENDING_RELEASE', client_id: 'OWNER'}]]});
      await expect(svc.openDispute('intruder', 'b1', {category: 'conduct'})).rejects.toThrow('Booking not found');
    });
  });

  describe('getEscrow', () => {
    it('returns the hold split for the owning client', async () => {
      const {svc} = mk({firstQOne: {
        booking_id: 'b1', status: 'RELEASED', basis: 'full_release', currency: 'AED', gross_credits: 800,
        to_provider_credits: 800, to_client_credits: 0, platform_fee_credits: 0,
        release_eligible_at: null, review_required: false, client_id: 'c1', provider_user_id: 'a1',
      }});
      const res = await svc.getEscrow('c1', 'b1');
      expect(res.status).toBe('RELEASED');
      expect(res.to_provider_credits).toBe(800);
    });
    it('rejects a user who is neither the client nor the provider', async () => {
      const {svc} = mk({firstQOne: {booking_id: 'b1', status: 'HELD', basis: null, currency: 'AED', gross_credits: 800, to_provider_credits: null, to_client_credits: null, platform_fee_credits: null, release_eligible_at: null, review_required: false, client_id: 'c1', provider_user_id: 'a1'}});
      await expect(svc.getEscrow('intruder', 'b1')).rejects.toThrow('Booking not found');
    });
  });

  describe('cancel — escrow-aware', () => {
    // LM-B4/LM-B8 shapes: the booking row now carries dispatch_mode +
    // dispatch_settled_at and is read INSIDE the txn under FOR UPDATE.
    const AUTO_CONFIRMED = {
      status: 'CONFIRMED', payment_captured: true, created_at: new Date(),
      dispatch_mode: 'auto', dispatch_settled_at: new Date(),
    };
    it('reverses a HELD hold with a full refund (no crew committed)', async () => {
      const {svc, wallet} = mk({
        firstQOne: AUTO_CONFIRMED,
        txRows: [[/SELECT gross_credits FROM escrow_holds/, {gross_credits: 800}]], // no mission → committed null
        cfg: {'dispatch.cancelFeePct': 0},
      });
      const res = await svc.cancel('c1', 'b1');
      expect(wallet.refundEscrowHold).toHaveBeenCalled();
      expect(wallet.settleEscrowSplit).not.toHaveBeenCalled();
      expect(res.refunded_credits).toBe(800);
    });
    // NO-PROVIDER CANCEL (Job-Portal QA 2026-07-10) — "cancel search" on a booking whose
    // search already ended must be an idempotent success, not the FSM's 403: the raw 403
    // surfaced as an error popup when the client cancelled just as NO_PROVIDER landed.
    it.each(['NO_PROVIDER', 'CANCELLED', 'AGENCY_NO_SHOW'] as const)(
      'idempotent success (never 403) when the booking already ended as %s', async (status) => {
        const {svc, wallet, fsm, txQ} = mk({
          firstQOne: {...AUTO_CONFIRMED, status},
        });
        const res = await svc.cancel('c1', 'b1');
        expect(res).toEqual({id: 'b1', status, refunded_credits: 0, already_ended: true});
        // Nothing may move: no FSM assert, no flip, no money.
        expect(fsm.assert).not.toHaveBeenCalled();
        expect(txQ).not.toHaveBeenCalledWith(expect.stringMatching(/UPDATE lite_bookings/), expect.anything());
        expect(wallet.refundEscrowHold).not.toHaveBeenCalled();
        expect(wallet.settleEscrowSplit).not.toHaveBeenCalled();
      });
    it('applies a cancellation fee (PARTIAL) when crew is committed and a fee is configured', async () => {
      const {svc, wallet} = mk({
        firstQOne: AUTO_CONFIRMED,
        txRows: [
          [/SELECT gross_credits FROM escrow_holds/, {gross_credits: 800}],
          [/SELECT id FROM missions/, {id: 'm1'}],
        ],
        cfg: {'dispatch.cancelFeePct': 25},
      });
      const res = await svc.cancel('c1', 'b1');
      expect(wallet.settleEscrowSplit).toHaveBeenCalledWith(expect.anything(), 'b1', expect.objectContaining({toProvider: 200, toClient: 600, basis: 'partial', finalStatus: 'PARTIAL'}));
      expect(res.refunded_credits).toBe(700); // mocked settleEscrowSplit returns toClient 700
    });
    it('falls back to the legacy payment refund for a non-escrow booking', async () => {
      const {svc, wallet} = mk({
        firstQOne: {status: 'CONFIRMED', payment_captured: true, created_at: new Date(), dispatch_mode: null, dispatch_settled_at: null},
        txRows: [], // no hold
      });
      await svc.cancel('c1', 'b1');
      expect(wallet.refundEscrowHold).not.toHaveBeenCalled();
      expect(wallet.refundForBooking).toHaveBeenCalledWith('c1', 'b1', expect.stringMatching(/cancelled/));
    });
    it('B-374 — a family legacy cancel refunds the HOLDER wallet that paid, not the member', async () => {
      // The debit + payer stamp both hit the holder at pay time; summing debits
      // on the member's wallet finds nothing and silently refunds nobody.
      const {svc, wallet} = mk({
        firstQOne: {status: 'CONFIRMED', payment_captured: true, created_at: new Date(), dispatch_mode: null, dispatch_settled_at: null, payer_user_id: 'holder-9'},
        txRows: [], // no hold
      });
      await svc.cancel('c1', 'b1');
      expect(wallet.refundForBooking).toHaveBeenCalledWith('holder-9', 'b1', expect.stringMatching(/cancelled/));
    });
    it('rejects a legacy CONFIRMED cancel after the 1-hour window (anchored to created_at)', async () => {
      const {svc, wallet} = mk({
        firstQOne: {status: 'CONFIRMED', payment_captured: true, created_at: new Date(Date.now() - 2 * 3600_000), dispatch_mode: null, dispatch_settled_at: null},
      });
      await expect(svc.cancel('c1', 'b1')).rejects.toMatchObject({response: {code: 'cancel_window_expired'}});
      expect(wallet.refundEscrowHold).not.toHaveBeenCalled();
      expect(wallet.refundForBooking).not.toHaveBeenCalled();
    });
    it('LM-B8: an auto CONFIRMED cancel anchors the window to ACCEPT time, not created_at', async () => {
      const {svc, wallet} = mk({
        firstQOne: {
          status: 'CONFIRMED', payment_captured: true,
          created_at: new Date(Date.now() - 26 * 3600_000),          // created a day ago (scheduled)
          dispatch_mode: 'auto', dispatch_settled_at: new Date(Date.now() - 10 * 60_000), // accepted 10min ago
        },
        txRows: [[/SELECT gross_credits FROM escrow_holds/, {gross_credits: 800}]],
      });
      const res = await svc.cancel('c1', 'b1');
      expect(res.status).toBe('CANCELLED');
      expect(wallet.refundEscrowHold).toHaveBeenCalled();
    });
    it('LM-B8: a pre-commitment status (DISPATCHING) is cancellable regardless of age', async () => {
      const {svc} = mk({
        firstQOne: {
          status: 'DISPATCHING', payment_captured: false,
          created_at: new Date(Date.now() - 48 * 3600_000),
          dispatch_mode: 'auto', dispatch_settled_at: null,
        },
      });
      const res = await svc.cancel('c1', 'b1');
      expect(res.status).toBe('CANCELLED');
    });
    it('LM-B2: cancelling supersedes any live OFFERED offer (agency un-benched)', async () => {
      const {svc, txQ} = mk({
        firstQOne: {
          status: 'DISPATCHING', payment_captured: false, created_at: new Date(),
          dispatch_mode: 'auto', dispatch_settled_at: null,
        },
      });
      await svc.cancel('c1', 'b1');
      expect(txQ).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE dispatch_offers SET status = 'SUPERSEDED'/), ['b1']);
    });
    it('blocks a client cancel once the mission is LIVE (protection active) — no wallet call', async () => {
      const {svc, wallet} = mk({
        firstQOne: AUTO_CONFIRMED,
        txRows: [[/SELECT id, status FROM missions/, {id: 'm1', status: 'LIVE'}]],
      });
      await expect(svc.cancel('c1', 'b1')).rejects.toMatchObject({response: {code: 'cancel_blocked_protection_active'}});
      expect(wallet.refundEscrowHold).not.toHaveBeenCalled();
      expect(wallet.refundForBooking).not.toHaveBeenCalled();
      expect(wallet.settleEscrowSplit).not.toHaveBeenCalled();
    });
    it('aborts a DISPATCHED mission atomically with the booking cancel', async () => {
      const {svc, txQ} = mk({
        firstQOne: {status: 'CONFIRMED', payment_captured: true, created_at: new Date(), dispatch_mode: null, dispatch_settled_at: null},
        txRows: [[/SELECT id, status FROM missions/, {id: 'm1', status: 'DISPATCHED'}]], // legacy booking, no escrow hold
      });
      await svc.cancel('c1', 'b1');
      expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/UPDATE missions SET status = 'ABORTED'/), expect.anything());
      expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/UPDATE mission_crew SET status = 'off'/), expect.anything());
    });
  });
});
