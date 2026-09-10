import {OfferExpiryService} from './offer-expiry.service';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {ConfigService} from '@nestjs/config';
import type {DispatchService} from './dispatch.service';

const db = {q: jest.fn()};
const client = {set: jest.fn(), del: jest.fn(), eval: jest.fn().mockResolvedValue(1)};
const redis = {client};
const config = {get: jest.fn()};
const dispatch = {expire: jest.fn()};

function svc(): OfferExpiryService {
  return new OfferExpiryService(
    db as unknown as DatabaseService,
    redis as unknown as RedisService,
    config as unknown as ConfigService,
    dispatch as unknown as DispatchService,
  );
}

describe('OfferExpiryService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    config.get.mockReturnValue(true);    // AUTO_DISPATCH_ENABLED on
    client.set.mockResolvedValue('OK');  // lock acquired
    client.del.mockResolvedValue(1);
    dispatch.expire.mockResolvedValue(undefined);
  });

  it('no-ops (no lock, no DB) when AUTO_DISPATCH_ENABLED is off', async () => {
    config.get.mockReturnValue(false);
    const r = await svc().sweepOnce();
    expect(r).toEqual({expired: 0, skipped_lock: false, skipped_flag: true});
    expect(client.set).not.toHaveBeenCalled();
    expect(db.q).not.toHaveBeenCalled();
  });

  it('does NO work when another pod holds the lock — multi-pod double-cascade guard (LB9)', async () => {
    client.set.mockResolvedValue(null); // SET NX failed
    const r = await svc().sweepOnce();
    expect(r.skipped_lock).toBe(true);
    expect(db.q).not.toHaveBeenCalled();
    expect(dispatch.expire).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled(); // never acquired → never released
  });

  it('expires each due offer once, writes the liveness key, and releases the lock', async () => {
    db.q.mockResolvedValue([{id: 'o1'}, {id: 'o2'}]);
    const r = await svc().sweepOnce();
    expect(dispatch.expire).toHaveBeenCalledTimes(2);
    expect(dispatch.expire).toHaveBeenCalledWith('o1');
    expect(dispatch.expire).toHaveBeenCalledWith('o2');
    expect(r).toEqual({expired: 2, skipped_lock: false, skipped_flag: false});
    expect(client.set).toHaveBeenCalledWith('dispatch:watchdog:offer:last_run', expect.any(String), 'EX', 600);
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'lock:dispatch-offer-expiry', expect.any(String));
  });

  it('a single failing expire does not abort the sweep and the lock is still released', async () => {
    db.q.mockResolvedValue([{id: 'bad'}, {id: 'o2'}]);
    dispatch.expire.mockRejectedValueOnce(new Error('boom'));
    const r = await svc().sweepOnce();
    expect(dispatch.expire).toHaveBeenCalledTimes(2); // continued past the failure
    expect(r.expired).toBe(2);
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'lock:dispatch-offer-expiry', expect.any(String));
  });
});
