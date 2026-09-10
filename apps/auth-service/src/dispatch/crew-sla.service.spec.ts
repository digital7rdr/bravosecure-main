import {CrewSlaService} from './crew-sla.service';
import {BookingStateMachine} from '../booking/state-machine.service';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {ConfigService} from '@nestjs/config';
import type {OpsAuditService} from '../ops/ops-audit.service';
import type {BookingPushBridge} from '../ops/booking-push-bridge.service';
import type {WalletService} from '../wallet/wallet.service';

const fsm = new BookingStateMachine(); // real FSM (pure logic)
const db = {q: jest.fn(), qOne: jest.fn(), withTransaction: jest.fn()};
const client = {set: jest.fn(), del: jest.fn()};
const redis = {client};
const config = {get: jest.fn()};
const audit = {record: jest.fn()};
const push = {agencyNoShow: jest.fn()};
const wallet = {refundEscrowHold: jest.fn()};

function svc(): CrewSlaService {
  return new CrewSlaService(
    db as unknown as DatabaseService,
    redis as unknown as RedisService,
    config as unknown as ConfigService,
    fsm,
    audit as unknown as OpsAuditService,
    push as unknown as BookingPushBridge,
    wallet as unknown as WalletService,
  );
}

interface Wire {
  due?: Array<{id: string}>;
  bookingLock?: {status: string; client_id: string; assigned_provider_user_id: string | null} | null;
  mission?: {id: string} | null;
  confirmRows?: number;
}

function wire(w: Wire): void {
  db.q.mockImplementation((sql: string) => {
    if (/WHERE b\.status = 'CONFIRMED'/.test(sql)) return Promise.resolve(w.due ?? []);
    if (/UPDATE lite_bookings SET status = 'AGENCY_NO_SHOW'/.test(sql)) return Promise.resolve(new Array(w.confirmRows ?? 1).fill({id: 'b1'}));
    if (/UPDATE dispatch_offers SET status = 'SUPERSEDED'/.test(sql)) return Promise.resolve([]);
    if (/UPDATE agents SET reliability_breaches/.test(sql)) return Promise.resolve([]);
    return Promise.resolve([]);
  });
  db.qOne.mockImplementation((sql: string) => {
    if (/SELECT status, client_id, assigned_provider_user_id/.test(sql)) return Promise.resolve(w.bookingLock ?? null);
    if (/SELECT id FROM missions WHERE booking_id/.test(sql)) return Promise.resolve(w.mission ?? null);
    return Promise.resolve(null);
  });
}

describe('CrewSlaService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    config.get.mockReturnValue(true);    // AUTO_DISPATCH_ENABLED on
    client.set.mockResolvedValue('OK');  // lock acquired
    client.del.mockResolvedValue(1);
    audit.record.mockResolvedValue(undefined);
    push.agencyNoShow.mockResolvedValue(undefined);
    wallet.refundEscrowHold.mockResolvedValue({refunded: true, credits: 800});
    db.withTransaction.mockImplementation((fn: (tx: unknown) => unknown) => fn({q: db.q, qOne: db.qOne}));
  });

  it('INFRA-3 — runs regardless of AUTO_DISPATCH_ENABLED (money resolver is always-on)', async () => {
    config.get.mockReturnValue(false); // flag off
    db.q.mockResolvedValue([]);        // no due bookings
    const r = await svc().sweepOnce();
    // The resolver acquired the lock and queried rather than skipping on the flag.
    expect(r).toEqual({flagged: 0, skipped_lock: false, skipped_flag: false});
    expect(client.set).toHaveBeenCalled();
  });

  it('does NO work when another pod holds the lock — multi-pod double-refund guard (LB9)', async () => {
    client.set.mockResolvedValue(null);
    const r = await svc().sweepOnce();
    expect(r.skipped_lock).toBe(true);
    expect(db.q).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();      // no double-flag at the side-effect boundary
    expect(push.agencyNoShow).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();
  });

  it('flags a CONFIRMED-past-deadline booking with no mission: AGENCY_NO_SHOW + supersede + breach + audit + client wake', async () => {
    wire({
      due: [{id: 'b1'}],
      bookingLock: {status: 'CONFIRMED', client_id: 'client-1', assigned_provider_user_id: 'agency-A'},
      mission: null,
    });
    const r = await svc().sweepOnce();
    expect(r).toEqual({flagged: 1, skipped_lock: false, skipped_flag: false});
    expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/UPDATE lite_bookings SET status = 'AGENCY_NO_SHOW'/), ['b1']);
    expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/UPDATE dispatch_offers SET status = 'SUPERSEDED'/), ['b1']);
    expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/reliability_breaches = reliability_breaches \+ 1/), ['agency-A']);
    // The held escrow is refunded to the client IN THE SAME txn as the flip.
    expect(wallet.refundEscrowHold).toHaveBeenCalledWith(expect.anything(), 'b1', expect.stringContaining('Agency no-show'));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({action: 'dispatch.agency_no_show', subject_id: 'b1'}));
    expect(push.agencyNoShow).toHaveBeenCalledWith('client-1', 'b1');
  });

  it('skips a booking that raced out of CONFIRMED (accepted-then-cancelled/completed)', async () => {
    wire({due: [{id: 'b1'}], bookingLock: {status: 'CANCELLED', client_id: 'client-1', assigned_provider_user_id: 'agency-A'}});
    const r = await svc().sweepOnce();
    expect(r.flagged).toBe(0);
    expect(db.q).not.toHaveBeenCalledWith(expect.stringMatching(/AGENCY_NO_SHOW/), expect.anything());
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('skips a booking that got crewed (a missions row now exists)', async () => {
    wire({
      due: [{id: 'b1'}],
      bookingLock: {status: 'CONFIRMED', client_id: 'client-1', assigned_provider_user_id: 'agency-A'},
      mission: {id: 'm1'},
    });
    const r = await svc().sweepOnce();
    expect(r.flagged).toBe(0);
    expect(db.q).not.toHaveBeenCalledWith(expect.stringMatching(/AGENCY_NO_SHOW/), expect.anything());
    expect(push.agencyNoShow).not.toHaveBeenCalled();
  });
});
