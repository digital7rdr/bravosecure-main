import {DispatchKillswitchService} from './dispatch-killswitch.service';
import type {RedisService} from '../redis/redis.service';
import type {ConfigService} from '@nestjs/config';

const client = {get: jest.fn(), set: jest.fn()};
const redis = {client} as unknown as RedisService;

function svc(envOn: boolean): DispatchKillswitchService {
  const config = {get: jest.fn().mockReturnValue(envOn)} as unknown as ConfigService;
  return new DispatchKillswitchService(redis, config);
}

describe('DispatchKillswitchService (Step 26)', () => {
  beforeEach(() => { jest.resetAllMocks(); client.set.mockResolvedValue('OK'); });

  it('env OFF (dark) ⇒ always disabled, never reads Redis', async () => {
    const s = svc(false);
    expect(await s.isAutoDispatchEnabled()).toBe(false);
    expect(client.get).not.toHaveBeenCalled();
  });

  it('env ON + Redis absent ⇒ enabled (env governs)', async () => {
    client.get.mockResolvedValue(null);
    expect(await svc(true).isAutoDispatchEnabled()).toBe(true);
  });

  it('env ON + Redis "false" ⇒ runtime kill ⇒ disabled', async () => {
    client.get.mockResolvedValue('false');
    expect(await svc(true).isAutoDispatchEnabled()).toBe(false);
  });

  it('caches the Redis read within the TTL (one Redis hit for two close calls)', async () => {
    client.get.mockResolvedValue('true');
    const s = svc(true);
    await s.isAutoDispatchEnabled(1000);
    await s.isAutoDispatchEnabled(2000); // < 5s later
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it('defaults safe on a Redis error (falls back to the cached/env value, never throws)', async () => {
    const s = svc(true);
    client.get.mockResolvedValue('true');
    await s.isAutoDispatchEnabled(1000);          // primes cache = true
    client.get.mockRejectedValue(new Error('redis down'));
    expect(await s.isAutoDispatchEnabled(9000)).toBe(true); // cache fallback
  });

  it('setEnabled persists the runtime flag and refreshes the cache', async () => {
    const s = svc(true);
    await s.setEnabled(false);
    expect(client.set).toHaveBeenCalledWith('dispatch:enabled', 'false');
    // cache now false → no Redis read needed
    client.get.mockClear();
    expect(await s.isAutoDispatchEnabled(Date.now())).toBe(false);
  });

  it('setEnabled fails LOUD on a Redis write error (so the admin is not misled)', async () => {
    const s = svc(true);
    client.set.mockRejectedValue(new Error('redis down'));
    await expect(s.setEnabled(false)).rejects.toThrow('redis down');
  });
});
