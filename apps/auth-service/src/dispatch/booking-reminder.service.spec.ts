import {BookingReminderService} from './booking-reminder.service';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {BookingPushBridge} from '../ops/booking-push-bridge.service';

const db = {q: jest.fn()};
const client = {set: jest.fn(), del: jest.fn(), eval: jest.fn().mockResolvedValue(1)};
const redis = {client};
const push = {bookingReminder: jest.fn()};

function svc(): BookingReminderService {
  return new BookingReminderService(
    db as unknown as DatabaseService,
    redis as unknown as RedisService,
    push as unknown as BookingPushBridge,
  );
}

describe('BookingReminderService — B-405 T-60 start reminder', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    client.set.mockResolvedValue('OK'); // lock acquired
    client.del.mockResolvedValue(1);
    push.bookingReminder.mockResolvedValue(undefined);
  });

  it('does NO work when another pod holds the lock (multi-pod safe)', async () => {
    client.set.mockResolvedValue(null);
    const r = await svc().sweepOnce();
    expect(r.skipped_lock).toBe(true);
    expect(db.q).not.toHaveBeenCalled();
    expect(push.bookingReminder).not.toHaveBeenCalled();
  });

  it('reminds each due scheduled booking once and releases the lock', async () => {
    db.q.mockImplementation((sql: string) =>
      Promise.resolve(/^\s*SELECT/.test(sql)
        ? [{id: 'b1', client_id: 'c1'}, {id: 'b2', client_id: 'c2'}]
        : [{id: 'claimed'}]));
    const r = await svc().sweepOnce();
    expect(push.bookingReminder).toHaveBeenCalledTimes(2);
    expect(push.bookingReminder).toHaveBeenCalledWith('c1', 'b1');
    expect(push.bookingReminder).toHaveBeenCalledWith('c2', 'b2');
    expect(r).toEqual({reminded: 2, skipped_lock: false});
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'lock:booking-reminder', expect.any(String));
  });

  it('sweeps ONLY unsent, still-alive later bookings inside the lead window and never past pickups', async () => {
    db.q.mockResolvedValue([]);
    await svc().sweepOnce();
    const sql = db.q.mock.calls[0][0] as string;
    expect(sql).toMatch(/booking_mode = 'later'/);
    expect(sql).toMatch(/status IN \('PENDING_OPS','OPS_APPROVED','PAYMENT_PENDING','CONFIRMED'\)/);
    expect(sql).toMatch(/reminder_sent_at IS NULL/);
    // Window: due within the lead, but a pickup already in the past is skipped
    // ("starts within the hour" must be true when it lands).
    expect(sql).toMatch(/pickup_time <= NOW\(\) \+ \(\$1 \|\| ' minutes'\)::interval/);
    expect(sql).toMatch(/pickup_time > NOW\(\)/);
    // Terminal / live states never remind.
    expect(sql).not.toMatch(/CANCELLED|COMPLETED|'LIVE'|DISPATCHING/);
  });

  it('the conditional claim is the idempotency gate — a lost race sends nothing', async () => {
    db.q.mockImplementation((sql: string) =>
      Promise.resolve(/^\s*SELECT/.test(sql)
        ? [{id: 'b1', client_id: 'c1'}]
        : [])); // UPDATE ... WHERE reminder_sent_at IS NULL claimed by another pod
    const r = await svc().sweepOnce();
    expect(push.bookingReminder).not.toHaveBeenCalled();
    expect(r.reminded).toBe(0);
    // The claim itself must be conditional, or a crash-restart double-sends.
    const claim = (db.q.mock.calls[1]?.[0] ?? '') as string;
    expect(claim).toMatch(/SET reminder_sent_at = NOW\(\)/);
    expect(claim).toMatch(/reminder_sent_at IS NULL/);
    // 3-agent review 2026-08-09: the claim re-checks status + mode, so a
    // booking cancelled between SELECT and claim never gets a reminder.
    expect(claim).toMatch(/status IN \('PENDING_OPS','OPS_APPROVED','PAYMENT_PENDING','CONFIRMED'\)/);
    expect(claim).toMatch(/booking_mode = 'later'/);
  });

  it('NEVER throws — a rejecting SELECT (e.g. column missing pre-migration) is logged, not fatal', async () => {
    // sweepOnce is driven by `void setInterval`; an escaping rejection is an
    // unhandledRejection that TERMINATES the auth-service process. This is the
    // crash-loop guard for code-before-migration deploys (3-agent review).
    db.q.mockRejectedValue(new Error('column "reminder_sent_at" does not exist'));
    await expect(svc().sweepOnce()).resolves.toEqual({reminded: 0, skipped_lock: false});
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'lock:booking-reminder', expect.any(String));
  });

  it('NEVER throws — a Redis outage on the lock acquire is swallowed too', async () => {
    client.set.mockRejectedValue(new Error('redis unreachable'));
    // FSM-3 — acquireRedisLock fails SAFE: a Redis error at acquire is caught and
    // returns null, so the sweep reports skipped_lock (it did not get the lock) and
    // does no work, rather than the old conflated skipped_lock:false.
    await expect(svc().sweepOnce()).resolves.toEqual({reminded: 0, skipped_lock: true});
    expect(db.q).not.toHaveBeenCalled();
  });

  it('one failing row does not abort the sweep, and the lock is still released', async () => {
    db.q.mockImplementation((sql: string) =>
      Promise.resolve(/^\s*SELECT/.test(sql)
        ? [{id: 'bad', client_id: 'c1'}, {id: 'b2', client_id: 'c2'}]
        : [{id: 'claimed'}]));
    push.bookingReminder.mockRejectedValueOnce(new Error('redis down'));
    const r = await svc().sweepOnce();
    expect(push.bookingReminder).toHaveBeenCalledTimes(2);
    expect(r.reminded).toBe(1);
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'lock:booking-reminder', expect.any(String));
  });
});
