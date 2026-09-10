import {ArrivalNoShowService} from './arrival-noshow.service';
import {BookingStateMachine} from '../booking/state-machine.service';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {ConfigService} from '@nestjs/config';
import type {OpsAuditService} from '../ops/ops-audit.service';
import type {BookingPushBridge} from '../ops/booking-push-bridge.service';
import type {DispatchService} from './dispatch.service';

const fsm = new BookingStateMachine(); // real FSM (pure logic)
const db = {q: jest.fn(), qOne: jest.fn(), withTransaction: jest.fn()};
const client = {set: jest.fn(), del: jest.fn()};
const redis = {client};
const config = {get: jest.fn()};
const audit = {record: jest.fn()};
const push = {bookingReDispatching: jest.fn(), missionAborted: jest.fn(), noProvider: jest.fn()};
const dispatch = {offerNext: jest.fn()};

function svc(): ArrivalNoShowService {
  return new ArrivalNoShowService(
    db as unknown as DatabaseService,
    redis as unknown as RedisService,
    config as unknown as ConfigService,
    fsm,
    audit as unknown as OpsAuditService,
    push as unknown as BookingPushBridge,
    dispatch as unknown as DispatchService,
  );
}

interface Wire {
  due?: Array<{id: string}>;
  bookingLock?: {status: string; client_id: string; assigned_provider_user_id: string | null} | null;
  mission?: {id: string; status: string; pickup_at: Date | null; comms_channel_id?: string | null} | null;
  redispatchRows?: number;
  crew?: Array<{agent_id: string}>;
}

function wire(w: Wire): void {
  db.q.mockImplementation((sql: string) => {
    if (/b\.arrival_deadline_at < NOW\(\)/.test(sql)) return Promise.resolve(w.due ?? []);
    if (/UPDATE lite_bookings\s+SET status = 'DISPATCHING'/.test(sql)) return Promise.resolve(new Array(w.redispatchRows ?? 1).fill({id: 'b1'}));
    if (/UPDATE missions SET status = 'ABORTED'/.test(sql)) return Promise.resolve([]);
    if (/UPDATE mission_crew SET status = 'off'/.test(sql)) return Promise.resolve(w.crew ?? []);
    if (/UPDATE dispatch_offers SET status = 'SUPERSEDED'/.test(sql)) return Promise.resolve([]);
    if (/UPDATE agents SET reliability_breaches/.test(sql)) return Promise.resolve([]);
    return Promise.resolve([]);
  });
  db.qOne.mockImplementation((sql: string) => {
    if (/SELECT status, client_id, assigned_provider_user_id/.test(sql)) return Promise.resolve(w.bookingLock ?? null);
    if (/SELECT id, status, pickup_at, comms_channel_id FROM missions/.test(sql)) return Promise.resolve(w.mission ?? null);
    return Promise.resolve(null);
  });
}

describe('ArrivalNoShowService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    config.get.mockReturnValue(true);    // AUTO_DISPATCH_ENABLED on
    client.set.mockResolvedValue('OK');  // lock acquired
    client.del.mockResolvedValue(1);
    audit.record.mockResolvedValue(undefined);
    push.bookingReDispatching.mockResolvedValue(undefined);
    push.missionAborted.mockResolvedValue(undefined);
    dispatch.offerNext.mockResolvedValue(undefined);
    db.withTransaction.mockImplementation((fn: (tx: unknown) => unknown) => fn({q: db.q, qOne: db.qOne}));
  });

  it('INFRA-3 — runs regardless of AUTO_DISPATCH_ENABLED (in-flight resolver is always-on)', async () => {
    config.get.mockReturnValue(false); // flag off
    db.q.mockResolvedValue([]);        // no stuck missions
    const r = await svc().sweepOnce();
    expect(r).toEqual({redispatched: 0, skipped_lock: false, skipped_flag: false});
    expect(client.set).toHaveBeenCalled(); // acquired the lock — did NOT skip on the flag
  });

  it('does NO work when another pod holds the lock (multi-pod guard, LB9)', async () => {
    client.set.mockResolvedValue(null);
    const r = await svc().sweepOnce();
    expect(r.skipped_lock).toBe(true);
    expect(db.q).not.toHaveBeenCalled();
    expect(dispatch.offerNext).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();
  });

  it('re-dispatches a crewed-but-not-arrived booking: DISPATCHING + abort mission + stand crew down + supersede + breach + offerNext', async () => {
    wire({
      due: [{id: 'b1'}],
      bookingLock: {status: 'CONFIRMED', client_id: 'client-1', assigned_provider_user_id: 'agency-A'},
      mission: {id: 'm1', status: 'DISPATCHED', pickup_at: null},
      crew: [{agent_id: 'cpo-1'}, {agent_id: 'cpo-2'}],
    });
    const r = await svc().sweepOnce();
    expect(r).toEqual({redispatched: 1, skipped_lock: false, skipped_flag: false});
    expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/UPDATE lite_bookings\s+SET status = 'DISPATCHING'/), ['b1']);
    expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/UPDATE missions SET status = 'ABORTED'/), ['m1']);
    expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/UPDATE mission_crew SET status = 'off'/), ['m1']);
    expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/UPDATE dispatch_offers SET status = 'SUPERSEDED'/), ['b1']);
    expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/reliability_breaches = reliability_breaches \+ 1/), ['agency-A']);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({action: 'dispatch.arrival_no_show', subject_id: 'b1'}));
    // Re-enters the matchmaker AFTER the commit (booking is now DISPATCHING).
    expect(dispatch.offerNext).toHaveBeenCalledWith('b1');
    // The client gets a "reassigning" wake, NOT a terminal no-provider one.
    expect(push.bookingReDispatching).toHaveBeenCalledWith('client-1', 'b1');
    expect(push.noProvider).not.toHaveBeenCalled();
    // The stood-down crew get their mission card cleared.
    expect(push.missionAborted).toHaveBeenCalledWith('cpo-1', 'm1', 'b1');
    expect(push.missionAborted).toHaveBeenCalledWith('cpo-2', 'm1', 'b1');
  });

  it('B-211: hard-deletes the no-show agency\'s Ops Room when one exists (6-stmt primitive, all scoped to the conversation id)', async () => {
    wire({
      due: [{id: 'b1'}],
      bookingLock: {status: 'CONFIRMED', client_id: 'client-1', assigned_provider_user_id: 'agency-A'},
      mission: {id: 'm1', status: 'DISPATCHED', pickup_at: null, comms_channel_id: 'conv-9'},
      crew: [{agent_id: 'cpo-1'}],
    });
    await svc().sweepOnce();
    const calls = db.q.mock.calls.map(c => String(c[0]));
    expect(calls.some(sql => /UPDATE public\.lite_bookings SET conversation_id = NULL WHERE conversation_id = \$1/.test(sql))).toBe(true);
    expect(calls.some(sql => /UPDATE public\.missions SET comms_channel_id = NULL WHERE comms_channel_id = \$1/.test(sql))).toBe(true);
    expect(calls.some(sql => /DELETE FROM public\.dispatch_room_intents WHERE conversation_id = \$1/.test(sql))).toBe(true);
    expect(calls.some(sql => /DELETE FROM public\.conversation_members WHERE conversation_id = \$1/.test(sql))).toBe(true);
    expect(calls.some(sql => /DELETE FROM public\.system_broadcasts WHERE conversation_id = \$1/.test(sql))).toBe(true);
    expect(calls.some(sql => /DELETE FROM public\.conversations WHERE id = \$1/.test(sql))).toBe(true);
    // Every room-delete statement is scoped to THIS conversation, never the mission id.
    for (const call of db.q.mock.calls) {
      const sql = String(call[0]);
      if (/public\.(conversations|conversation_members|system_broadcasts|dispatch_room_intents)/.test(sql) && /DELETE|conversation_id = NULL|comms_channel_id = NULL/.test(sql)) {
        expect(call[1]).toEqual(['conv-9']);
      }
    }
  });

  it('B-211: no room to delete (comms_channel_id null) — no room-delete statements fire', async () => {
    wire({
      due: [{id: 'b1'}],
      bookingLock: {status: 'CONFIRMED', client_id: 'client-1', assigned_provider_user_id: 'agency-A'},
      mission: {id: 'm1', status: 'DISPATCHED', pickup_at: null, comms_channel_id: null},
    });
    await svc().sweepOnce();
    const calls = db.q.mock.calls.map(c => String(c[0]));
    expect(calls.some(sql => /DELETE FROM public\.conversations/.test(sql))).toBe(false);
  });

  it('MONEY: the re-dispatch touches NO escrow — the hold persists (client never re-charged)', async () => {
    wire({
      due: [{id: 'b1'}],
      bookingLock: {status: 'CONFIRMED', client_id: 'client-1', assigned_provider_user_id: 'agency-A'},
      mission: {id: 'm1', status: 'DISPATCHED', pickup_at: null},
    });
    await svc().sweepOnce();
    // No escrow_holds / wallet movement anywhere in the sweep (unlike the terminal
    // crew-SLA path, which refunds). The hold is carried to the replacement agency.
    expect(db.q).not.toHaveBeenCalledWith(expect.stringMatching(/escrow_holds/), expect.anything());
  });

  it('skips a booking that raced out of CONFIRMED (accepted-late / cancelled)', async () => {
    wire({due: [{id: 'b1'}], bookingLock: {status: 'CANCELLED', client_id: 'client-1', assigned_provider_user_id: 'agency-A'}});
    const r = await svc().sweepOnce();
    expect(r.redispatched).toBe(0);
    expect(db.q).not.toHaveBeenCalledWith(expect.stringMatching(/UPDATE lite_bookings\s+SET status = 'DISPATCHING'/), expect.anything());
    expect(dispatch.offerNext).not.toHaveBeenCalled();
  });

  it('skips a booking whose crew arrived just in time (mission left DISPATCHED / pickup_at set)', async () => {
    wire({
      due: [{id: 'b1'}],
      bookingLock: {status: 'CONFIRMED', client_id: 'client-1', assigned_provider_user_id: 'agency-A'},
      mission: {id: 'm1', status: 'PICKUP', pickup_at: new Date('2026-06-22T00:00:00Z')},
    });
    const r = await svc().sweepOnce();
    expect(r.redispatched).toBe(0);
    expect(db.q).not.toHaveBeenCalledWith(expect.stringMatching(/UPDATE missions SET status = 'ABORTED'/), expect.anything());
    expect(dispatch.offerNext).not.toHaveBeenCalled();
  });
});
