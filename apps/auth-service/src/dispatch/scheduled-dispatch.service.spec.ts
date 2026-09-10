import {ScheduledDispatchService} from './scheduled-dispatch.service';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {ConfigService} from '@nestjs/config';
import type {DispatchService} from './dispatch.service';

const db = {q: jest.fn()};
const client = {set: jest.fn(), del: jest.fn(), eval: jest.fn().mockResolvedValue(1)};
const redis = {client};
const config = {get: jest.fn()};
const dispatch = {start: jest.fn()};

function svc(): ScheduledDispatchService {
  return new ScheduledDispatchService(
    db as unknown as DatabaseService,
    redis as unknown as RedisService,
    config as unknown as ConfigService,
    dispatch as unknown as DispatchService,
  );
}

describe('ScheduledDispatchService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    config.get.mockReturnValue(true);   // AUTO_DISPATCH_ENABLED on
    client.set.mockResolvedValue('OK'); // lock acquired
    client.del.mockResolvedValue(1);
    dispatch.start.mockResolvedValue(undefined);
  });

  it('no-ops when AUTO_DISPATCH_ENABLED is off (ships dark)', async () => {
    config.get.mockReturnValue(false);
    const r = await svc().sweepOnce();
    expect(r).toEqual({started: 0, skipped_lock: false, skipped_flag: true});
    expect(client.set).not.toHaveBeenCalled();
    expect(db.q).not.toHaveBeenCalled();
  });

  it('does NO work when another pod holds the lock (multi-pod safe)', async () => {
    client.set.mockResolvedValue(null);
    const r = await svc().sweepOnce();
    expect(r.skipped_lock).toBe(true);
    expect(db.q).not.toHaveBeenCalled();
    expect(dispatch.start).not.toHaveBeenCalled();
  });

  it('starts each due "later" booking once and releases the lock', async () => {
    db.q.mockResolvedValue([{id: 'b1'}, {id: 'b2'}]);
    const r = await svc().sweepOnce();
    expect(dispatch.start).toHaveBeenCalledTimes(2);
    expect(dispatch.start).toHaveBeenCalledWith('b1');
    expect(dispatch.start).toHaveBeenCalledWith('b2');
    expect(r).toEqual({started: 2, skipped_lock: false, skipped_flag: false});
    // Ops-gated: the query targets APPROVED auto "later" bookings inside the lead
    // window (plus legacy in-flight DRAFT rows from the pre-gate flow).
    expect(db.q.mock.calls[0][0]).toMatch(/booking_mode = 'later'[\s\S]*status IN \('OPS_APPROVED', 'DRAFT'\)/);
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'lock:scheduled-dispatch', expect.any(String));
  });

  it('dispatches OPS_APPROVED(later) but NEVER an unapproved PENDING_OPS row (ops approval is the gate)', async () => {
    db.q.mockResolvedValue([]);
    await svc().sweepOnce();
    const sql = db.q.mock.calls[0][0] as string;
    expect(sql).toMatch(/'OPS_APPROVED'/);
    expect(sql).not.toMatch(/PENDING_OPS/);
    // Auto-scoped: legacy admin-flow bookings can never be swept into the matchmaker.
    expect(sql).toMatch(/dispatch_mode = 'auto'/);
  });

  it('INFRA-2: recovers a stuck approved "now" booking whose ops-approved pub/sub frame was lost', async () => {
    db.q.mockResolvedValueOnce([]);              // no "later" due
    db.q.mockResolvedValueOnce([{id: 'now-1'}]); // a stuck "now" (approved, never started)
    const r = await svc().sweepOnce();
    expect(dispatch.start).toHaveBeenCalledWith('now-1');
    expect(r.started).toBe(1);
    // The recovery query targets approved 'now' bookings never started past the grace.
    const stuckSql = db.q.mock.calls[1][0] as string;
    expect(stuckSql).toMatch(/booking_mode = 'now'[\s\S]*status = 'OPS_APPROVED'[\s\S]*dispatch_started_at IS NULL/);
    expect(stuckSql).toMatch(/updated_at < NOW\(\)/);
  });

  it('a single failing start does not abort the sweep, and the lock is still released', async () => {
    db.q.mockResolvedValue([{id: 'bad'}, {id: 'b2'}]);
    dispatch.start.mockRejectedValueOnce(new Error('raced'));
    const r = await svc().sweepOnce();
    expect(dispatch.start).toHaveBeenCalledTimes(2);
    expect(r.started).toBe(1); // bad one didn't count
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'lock:scheduled-dispatch', expect.any(String));
  });
});
