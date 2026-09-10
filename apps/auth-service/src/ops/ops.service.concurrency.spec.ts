/**
 * Audit fix 1.1 — concurrency regression test for state-changing flows.
 *
 * The withTransaction + SELECT FOR UPDATE + conditional UPDATE pattern
 * exists so two admins clicking "approve" simultaneously can't both
 * land. We can't reach pg's actual row locks under unit-test conditions,
 * but we CAN replay the exact race outcome the production locks
 * produce: the winner sees `RETURNING id` with one row, the loser sees
 * the same SELECT but the UPDATE matches zero rows (because the row's
 * status no longer equals the expected snapshot). The loser must throw
 * `booking_state_changed_concurrently`, NOT silently pass.
 *
 * If withTransaction were ever removed (or someone reverted to a plain
 * `q` outside a txn), this test fails because the SELECT/UPDATE would
 * stop being a single critical section.
 */
import {BadRequestException} from '@nestjs/common';
import {OpsService, OPS_APPROVED_DISPATCH_CHANNEL} from './ops.service';
import {BookingStateMachine} from '../booking/state-machine.service';
import type {AdminContext} from './admin.guard';

const ADMIN_A: AdminContext = {user_id: 'u-A', role: 'ADMIN', call_sign: 'OPS-A', region: 'AE'};

function makeBookingRow() {
  return {
    status:           'PENDING_OPS',
    client_id:        'c-1',
    pickup_address:   'A',
    dropoff_address:  'B',
    pickup_time:      new Date(),
    total_aed:        '500',
    region_code:      'AE',
  };
}

function makeService(opts: {
  // Whether the conditional UPDATE matches a row (winner) or 0 (loser).
  updateWins: boolean;
}) {
  const txQ    = jest.fn().mockResolvedValue(opts.updateWins ? [{id: 'b1'}] : []);
  const txQOne = jest.fn().mockResolvedValue(makeBookingRow());
  const withTransaction = jest.fn(async <T>(fn: (tx: {q: jest.Mock; qOne: jest.Mock}) => Promise<T>) => {
    return fn({q: txQ, qOne: txQOne});
  });

  const db = {
    q:    jest.fn().mockResolvedValue([]),
    qOne: jest.fn().mockResolvedValue(null),
    withTransaction,
  } as never;

  const audit = {
    record:      jest.fn().mockResolvedValue(undefined),
    recordAdmin: jest.fn().mockResolvedValue(undefined),
    emit:        jest.fn().mockResolvedValue(undefined),
    recentFeed:  jest.fn().mockResolvedValue([]),
  } as never;

  const jobFeed = {
    publishFromBooking: jest.fn().mockResolvedValue({short_code: 'MSN-abc'}),
  } as never;

  const systemMsg = {
    sendBookingApproved: jest.fn().mockResolvedValue(undefined),
    sendBookingRejected: jest.fn().mockResolvedValue(undefined),
  } as never;

  const svc = new OpsService(
    db,
    {} as never,                  // bookings
    {} as never,                  // agents
    new BookingStateMachine(),    // real FSM
    {} as never,                  // agentFsm
    audit,
    jobFeed,
    systemMsg,
    {} as never,                  // cpoAssign
    {} as never,                  // vehicles
    {} as never,                  // conversations
    {} as never,                  // wallet
    {} as never,                  // settlement
    {} as never,                  // mapbox
    {bookingApproved: async () => {}, agentDecided: async () => {},
     missionDispatched: async () => {}, missionAborted: async () => {},
     payoutSettled: async () => {}, sosAlert: async () => {}} as never, // bookingPush
  );

  return {svc, db, txQ, txQOne, withTransaction};
}

describe('OpsService.approveBooking — concurrency', () => {
  it('the winner completes (SELECT FOR UPDATE + UPDATE returns one row)', async () => {
    const {svc, withTransaction} = makeService({updateWins: true});

    const result = await svc.approveBooking('b1', ADMIN_A, 'tactical suit only');
    expect(result.ok).toBe(true);
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  it('the loser throws booking_state_changed_concurrently when the conditional UPDATE matches zero rows', async () => {
    const {svc} = makeService({updateWins: false});

    await expect(svc.approveBooking('b1', ADMIN_A, 'tactical suit only'))
      .rejects.toThrow('booking_state_changed_concurrently');

    // Also confirm it's specifically a BadRequest (400), not a 500.
    await expect(svc.approveBooking('b1', ADMIN_A, 'tactical suit only'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('two parallel approve calls — exactly one wins, exactly one throws', async () => {
    // Simulate the race by sharing a single in-memory status flag between
    // two service instances. The winner flips the flag from PENDING_OPS;
    // the loser reads the now-stale snapshot and its conditional UPDATE
    // matches nothing.
    const sharedStatus = {value: 'PENDING_OPS'};

    function makeRaceSvc() {
      const txQ = jest.fn(async (sql: string, params: unknown[]) => {
        // Conditional UPDATE: only succeeds if status still matches.
        if (sql.includes('UPDATE lite_bookings')) {
          const expected = params[2] as string;
          if (sharedStatus.value === expected) {
            sharedStatus.value = 'OPS_APPROVED';
            return [{id: 'b1'}];
          }
          return [];                 // loser path
        }
        return [];
      });
      const txQOne = jest.fn(async (sql: string) => {
        if (sql.includes('SELECT status')) {
          return {...makeBookingRow(), status: sharedStatus.value};
        }
        return null;
      });
      const withTransaction = jest.fn(async <T>(fn: (tx: {q: jest.Mock; qOne: jest.Mock}) => Promise<T>) => {
        return fn({q: txQ, qOne: txQOne});
      });
      const db = {
        q: jest.fn().mockResolvedValue([]),
        qOne: jest.fn().mockResolvedValue(null),
        withTransaction,
      } as never;
      const audit = {
        record: jest.fn().mockResolvedValue(undefined),
        recordAdmin: jest.fn().mockResolvedValue(undefined),
        emit: jest.fn().mockResolvedValue(undefined),
        recentFeed: jest.fn().mockResolvedValue([]),
      } as never;
      const jobFeed = {publishFromBooking: jest.fn().mockResolvedValue({short_code: 'MSN-xyz'})} as never;
      const systemMsg = {
        sendBookingApproved: jest.fn().mockResolvedValue(undefined),
      } as never;
      return new OpsService(
        db, {} as never, {} as never, new BookingStateMachine(), {} as never,
        audit, jobFeed, systemMsg, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
        {bookingApproved: async () => {}, agentDecided: async () => {},
         missionDispatched: async () => {}, missionAborted: async () => {},
         payoutSettled: async () => {}, sosAlert: async () => {}} as never, // bookingPush
      );
    }

    const a = makeRaceSvc();
    const b = makeRaceSvc();

    const results = await Promise.allSettled([
      a.approveBooking('b1', ADMIN_A, 'tactical suit only'),
      b.approveBooking('b1', ADMIN_A, 'tactical suit only'),
    ]);

    const wins  = results.filter(r => r.status === 'fulfilled').length;
    const fails = results.filter(r => r.status === 'rejected').length;
    expect(wins).toBe(1);
    expect(fails).toBe(1);
    const rejection = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejection.reason as Error).message).toContain('booking_state_changed_concurrently');
  });
});

// ─── Ops-gated auto dispatch — approval hands the AUTO booking to the matchmaker ───
//
// dispatch_mode='auto': flip PENDING_OPS → OPS_APPROVED like legacy, wake the client
// (bookingPush.bookingApproved), then publish {bookingId} on `dispatch:ops-approved`
// for 'now' ONLY ('later' waits for the scheduled cron). Never the agent job feed.
// Legacy (dispatch_mode NULL) must stay byte-for-byte: job feed publish, no Redis frame.
describe('OpsService.approveBooking — ops-gated auto dispatch', () => {
  function makeAutoSvc(rowOverrides: Record<string, unknown>, opts?: {publishThrows?: boolean}) {
    const txQ    = jest.fn().mockResolvedValue([{id: 'b1'}]);
    const txQOne = jest.fn().mockResolvedValue({...makeBookingRow(), ...rowOverrides});
    const withTransaction = jest.fn(async <T>(fn: (tx: {q: jest.Mock; qOne: jest.Mock}) => Promise<T>) => {
      return fn({q: txQ, qOne: txQOne});
    });
    const db = {q: jest.fn().mockResolvedValue([]), qOne: jest.fn().mockResolvedValue(null), withTransaction} as never;
    const audit = {
      record: jest.fn().mockResolvedValue(undefined),
      recordAdmin: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn().mockResolvedValue(undefined),
      recentFeed: jest.fn().mockResolvedValue([]),
    } as never;
    const jobFeed = {publishFromBooking: jest.fn().mockResolvedValue({short_code: 'MSN-abc'})};
    const systemMsg = {sendBookingApproved: jest.fn().mockResolvedValue(undefined)};
    const bookingApproved = jest.fn().mockResolvedValue(undefined);
    const publish = opts?.publishThrows
      ? jest.fn().mockRejectedValue(new Error('redis down'))
      : jest.fn().mockResolvedValue(1);
    const redis = {client: {publish}};
    const svc = new OpsService(
      db, {} as never, {} as never, new BookingStateMachine(), {} as never,
      audit, jobFeed as never, systemMsg as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
      {bookingApproved} as never, redis as never,
    );
    return {svc, publish, jobFeed, bookingApproved};
  }

  it("auto + 'now': publishes {bookingId} on dispatch:ops-approved, wakes the client, skips the job feed", async () => {
    const {svc, publish, jobFeed, bookingApproved} = makeAutoSvc({dispatch_mode: 'auto', booking_mode: 'now'});
    const result = await svc.approveBooking('b1', ADMIN_A, 'tactical suit only');
    expect(result).toEqual({ok: true, job: null});
    expect(publish).toHaveBeenCalledWith(OPS_APPROVED_DISPATCH_CHANNEL, JSON.stringify({bookingId: 'b1'}));
    expect(bookingApproved).toHaveBeenCalledWith('c-1', 'b1', 'OPS_APPROVED');
    // The matchmaker handles auto bookings — the agent job feed must never see them.
    expect(jobFeed.publishFromBooking).not.toHaveBeenCalled();
  });

  it("auto + 'later': NO publish — the scheduled cron dispatches the OPS_APPROVED row near pickup", async () => {
    const {svc, publish, jobFeed, bookingApproved} = makeAutoSvc({dispatch_mode: 'auto', booking_mode: 'later'});
    const result = await svc.approveBooking('b1', ADMIN_A, 'tactical suit only');
    expect(result).toEqual({ok: true, job: null});
    expect(publish).not.toHaveBeenCalled();
    expect(bookingApproved).toHaveBeenCalledWith('c-1', 'b1', 'OPS_APPROVED');
    expect(jobFeed.publishFromBooking).not.toHaveBeenCalled();
  });

  it('legacy (non-auto) approve is unchanged: job feed publish, no Redis frame', async () => {
    const {svc, publish, jobFeed} = makeAutoSvc({dispatch_mode: null, booking_mode: 'now'});
    const result = await svc.approveBooking('b1', ADMIN_A, 'tactical suit only');
    expect(result.ok).toBe(true);
    expect(result.job).toEqual({short_code: 'MSN-abc'});
    expect(jobFeed.publishFromBooking).toHaveBeenCalledWith('b1', ADMIN_A);
    expect(publish).not.toHaveBeenCalled();
  });

  it('a failed publish never fails the approval (best-effort handoff — booking stays OPS_APPROVED)', async () => {
    const {svc, publish} = makeAutoSvc({dispatch_mode: 'auto', booking_mode: 'now'}, {publishThrows: true});
    const result = await svc.approveBooking('b1', ADMIN_A, 'tactical suit only');
    expect(result).toEqual({ok: true, job: null});
    expect(publish).toHaveBeenCalled();
  });
});
