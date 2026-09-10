import {MissionDriftJanitorService} from './mission-drift-janitor.service';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';

function mk(opts: {
  drifted?: Array<{id: string; mission_status: string; booking_status: string; booking_id: string}>;
  lockHeld?: boolean;
  flipRows?: number;
}) {
  const txQ = jest.fn().mockImplementation((sql: string) => {
    if (/UPDATE missions/.test(sql)) return Promise.resolve(new Array(opts.flipRows ?? 1).fill({id: 'm1'}));
    return Promise.resolve([]);
  });
  const tx = {q: txQ, qOne: jest.fn().mockResolvedValue(null)};
  const db = {
    q: jest.fn().mockResolvedValue(opts.drifted ?? []),
    withTransaction: (fn: (t: unknown) => unknown) => fn(tx),
  } as unknown as DatabaseService;
  const redis = {
    client: {
      set: jest.fn().mockResolvedValue(opts.lockHeld ? null : 'OK'),
      del: jest.fn().mockResolvedValue(1),
    },
  } as unknown as RedisService;
  const svc = new MissionDriftJanitorService(db, redis);
  return {svc, db, txQ};
}

describe('MissionDriftJanitorService (LM-D1)', () => {
  it('closes a drifted mission ABORTED (booking cancelled) and stands its crew down', async () => {
    const {svc, txQ} = mk({drifted: [
      {id: 'm1', mission_status: 'LIVE', booking_status: 'CANCELLED', booking_id: 'b1'},
    ]});
    const res = await svc.sweepOnce();
    expect(res.healed).toBe(1);
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/UPDATE missions/), ['m1', 'ABORTED']);
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/UPDATE mission_crew SET status = 'off'/), ['m1']);
  });

  it('closes a drifted mission COMPLETED when the booking completed', async () => {
    const {svc, txQ} = mk({drifted: [
      {id: 'm2', mission_status: 'DISPATCHED', booking_status: 'COMPLETED', booking_id: 'b2'},
    ]});
    const res = await svc.sweepOnce();
    expect(res.healed).toBe(1);
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/UPDATE missions/), ['m2', 'COMPLETED']);
  });

  it('no-ops when the mission raced to a terminal state (0 flip rows)', async () => {
    const {svc, txQ} = mk({
      drifted: [{id: 'm3', mission_status: 'LIVE', booking_status: 'CANCELLED', booking_id: 'b3'}],
      flipRows: 0,
    });
    const res = await svc.sweepOnce();
    expect(res.healed).toBe(0);
    expect(txQ).not.toHaveBeenCalledWith(expect.stringMatching(/UPDATE mission_crew/), expect.anything());
  });

  it('skips when another pod holds the lock', async () => {
    const {svc, db} = mk({lockHeld: true});
    const res = await svc.sweepOnce();
    expect(res).toEqual({healed: 0, expired: 0, reconciled: 0, skipped_lock: true});
    expect(db.q).not.toHaveBeenCalled();
  });
});

describe('MissionDriftJanitorService — stale-uncrewed expiry', () => {
  function mkExpiry(opts: {
    due?: Array<{id: string}>;
    booking?: {status: string; client_id: string; payment_captured: boolean; payer_user_id?: string | null} | null;
    crewed?: boolean;
    escrowRefund?: number;
    stranded?: Array<{id: string; client_id: string; payer_user_id?: string | null}>;
    reconcileCredits?: number;
  }) {
    const txQ = jest.fn().mockImplementation((sql: string) => {
      if (/UPDATE lite_bookings SET status = 'CANCELLED'/.test(sql)) return Promise.resolve([{id: 'b1'}]);
      return Promise.resolve([]);
    });
    const txQOne = jest.fn().mockImplementation((sql: string) => {
      if (/SELECT status, client_id, payment_captured/.test(sql)) return Promise.resolve(opts.booking ?? null);
      if (/SELECT id FROM missions/.test(sql)) return Promise.resolve(opts.crewed ? {id: 'm1'} : null);
      return Promise.resolve(null);
    });
    const tx = {q: txQ, qOne: txQOne};
    const db = {
      // Match by SQL so call order doesn't matter: drift query (missions) is empty,
      // the due list gates expiry, and the INFRA-10 reconciliation query is keyed on
      // its stale_uncrewed_expiry audit-reason filter.
      q: jest.fn().mockImplementation((sql: string) => {
        if (/stale_uncrewed_expiry/.test(sql)) return Promise.resolve(opts.stranded ?? []);
        if (/status IN \('PENDING_OPS'/.test(sql)) return Promise.resolve(opts.due ?? []);
        return Promise.resolve([]);
      }),
      withTransaction: (fn: (t: unknown) => unknown) => fn(tx),
    } as unknown as DatabaseService;
    const redis = {
      client: {set: jest.fn().mockResolvedValue('OK'), del: jest.fn().mockResolvedValue(1)},
    } as unknown as RedisService;
    const wallet = {
      refundEscrowHold: jest.fn().mockResolvedValue({refunded: (opts.escrowRefund ?? 0) > 0, credits: opts.escrowRefund ?? 0}),
      refundForBooking: jest.fn().mockResolvedValue({refunded: true, credits: 412}),
    };
    const fsm = {assert: jest.fn()};
    const push = {
      agencyNoShow: jest.fn().mockResolvedValue(undefined),
      refundIssued: jest.fn().mockResolvedValue(undefined),
      bookingRejected: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new MissionDriftJanitorService(
      db, redis, wallet as never, fsm as never, push as never, {get: () => 60} as never);
    return {svc, txQ, wallet, fsm, push};
  }

  it('cancels + escrow-refunds an uncrewed auto booking past the grace window', async () => {
    const {svc, txQ, wallet, push} = mkExpiry({
      due: [{id: 'b1'}],
      booking: {status: 'CONFIRMED', client_id: 'c1', payment_captured: true},
      escrowRefund: 800,
    });
    const res = await svc.sweepOnce();
    expect(res.expired).toBe(1);
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/SET status = 'CANCELLED'/), ['b1', 'CONFIRMED']);
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/SUPERSEDED/), ['b1']);
    expect(wallet.refundEscrowHold).toHaveBeenCalled();
    expect(wallet.refundForBooking).not.toHaveBeenCalled(); // escrow covered it
    expect(push.agencyNoShow).toHaveBeenCalledWith('c1', 'b1');
    expect(push.refundIssued).toHaveBeenCalledWith('c1', 'b1', 800);
  });

  it('falls back to the legacy captured-payment refund (the stuck June-21 case)', async () => {
    const {svc, wallet, push} = mkExpiry({
      due: [{id: 'b1'}],
      booking: {status: 'CONFIRMED', client_id: 'c1', payment_captured: true},
      escrowRefund: 0, // legacy booking — no escrow hold
    });
    const res = await svc.sweepOnce();
    expect(res.expired).toBe(1);
    expect(wallet.refundForBooking).toHaveBeenCalledWith('c1', 'b1', expect.stringMatching(/expired/));
    expect(push.refundIssued).toHaveBeenCalledWith('c1', 'b1', 412);
  });

  it('B-374 — a family legacy expiry refund credits the HOLDER that paid, not the member', async () => {
    const {svc, wallet, push} = mkExpiry({
      due: [{id: 'b1'}],
      booking: {status: 'CONFIRMED', client_id: 'c1', payment_captured: true, payer_user_id: 'holder-9'},
      escrowRefund: 0, // legacy booking — no escrow hold
    });
    await svc.sweepOnce();
    expect(wallet.refundForBooking).toHaveBeenCalledWith('holder-9', 'b1', expect.stringMatching(/expired/));
    // The client-facing wake still goes to the booking client.
    expect(push.refundIssued).toHaveBeenCalledWith('c1', 'b1', 412);
  });

  it('no-ops when crew was assigned between the scan and the lock', async () => {
    const {svc, wallet} = mkExpiry({
      due: [{id: 'b1'}],
      booking: {status: 'CONFIRMED', client_id: 'c1', payment_captured: true},
      crewed: true,
    });
    const res = await svc.sweepOnce();
    expect(res.expired).toBe(0);
    expect(wallet.refundEscrowHold).not.toHaveBeenCalled();
    expect(wallet.refundForBooking).not.toHaveBeenCalled();
  });

  it('INFRA-10 — retries a stranded post-commit legacy refund on a later sweep (crediting the payer)', async () => {
    // The booking was already CANCELLED for stale_uncrewed_expiry on a prior pass,
    // but the post-commit refund never landed (throw / pod death). No due rows this
    // pass — the reconciliation query alone re-finds it and pays the payer wallet.
    const {svc, wallet, push} = mkExpiry({
      due: [],
      stranded: [{id: 'b9', client_id: 'c9', payer_user_id: 'holder-9'}],
    });
    const res = await svc.sweepOnce();
    expect(res.expired).toBe(0);
    expect(res.reconciled).toBe(1);
    expect(wallet.refundForBooking).toHaveBeenCalledWith('holder-9', 'b9', expect.stringMatching(/reconciled/));
    expect(push.refundIssued).toHaveBeenCalledWith('c9', 'b9', 412);
  });

  it('INFRA-10 — reconciles nothing when no stranded refunds exist', async () => {
    const {svc, wallet} = mkExpiry({due: [], stranded: []});
    const res = await svc.sweepOnce();
    expect(res.reconciled).toBe(0);
    expect(wallet.refundForBooking).not.toHaveBeenCalled();
  });
});
