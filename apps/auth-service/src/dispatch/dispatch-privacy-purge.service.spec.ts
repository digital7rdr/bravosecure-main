import {DispatchPrivacyPurgeService} from './dispatch-privacy-purge.service';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {ConfigService} from '@nestjs/config';

const db = {q: jest.fn()};
const client = {set: jest.fn(), del: jest.fn(), eval: jest.fn().mockResolvedValue(1)};
const redis = {client};
const config = {get: jest.fn()};

function svc(): DispatchPrivacyPurgeService {
  return new DispatchPrivacyPurgeService(
    db as unknown as DatabaseService,
    redis as unknown as RedisService,
    config as unknown as ConfigService,
  );
}

describe('DispatchPrivacyPurgeService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    config.get.mockReturnValue(true);   // AUTO_DISPATCH_ENABLED on
    client.set.mockResolvedValue('OK'); // lock acquired
    client.del.mockResolvedValue(1);
  });

  it('no-ops when AUTO_DISPATCH_ENABLED is off (ships dark)', async () => {
    config.get.mockReturnValue(false);
    const r = await svc().sweepOnce();
    expect(r).toEqual({offers_redacted: 0, telemetry_purged: 0, skipped_lock: false, skipped_flag: true});
    expect(client.set).not.toHaveBeenCalled();
    expect(db.q).not.toHaveBeenCalled();
  });

  it('does NO work when another pod holds the lock (multi-pod safe)', async () => {
    client.set.mockResolvedValue(null);
    const r = await svc().sweepOnce();
    expect(r.skipped_lock).toBe(true);
    expect(db.q).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();
  });

  it('redacts stale offer reasons + purges terminal telemetry and releases the lock', async () => {
    db.q
      .mockResolvedValueOnce([{id: 'o1'}, {id: 'o2'}])      // reject-reason redaction
      .mockResolvedValueOnce([{booking_id: 'b1'}]);          // telemetry purge
    const r = await svc().sweepOnce();
    expect(r).toEqual({offers_redacted: 2, telemetry_purged: 1, skipped_lock: false, skipped_flag: false});
    // First query nulls reject_reason on terminal offers; second deletes telemetry-last.
    expect(db.q.mock.calls[0][0]).toMatch(/reject_reason = NULL/);
    expect(db.q.mock.calls[1][0]).toMatch(/DELETE FROM mission_telemetry_last/);
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'lock:dispatch-privacy-purge', expect.any(String));
  });

  it('a failing telemetry purge does not abort the sweep nor pin the lock', async () => {
    db.q
      .mockResolvedValueOnce([{id: 'o1'}])
      .mockRejectedValueOnce(new Error('boom'));
    const r = await svc().sweepOnce();
    expect(r.offers_redacted).toBe(1);
    expect(r.telemetry_purged).toBe(0);
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'lock:dispatch-privacy-purge', expect.any(String));
  });
});
