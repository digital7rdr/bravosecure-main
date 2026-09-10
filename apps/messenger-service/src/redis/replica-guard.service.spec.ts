/**
 * AUDIT-2026-08-13 #3/#10 — single-replica enforcement.
 *
 * With >=2 replicas the pod-local call sessions silently strand every
 * cross-pod call. This guard converts that into a LOUD refusal on the
 * EXTRA replica only, with #6's failure-direction rules: first replica
 * always boots, Redis errors fail open, a live competing claim fails
 * closed (after a rolling-restart retry window), a stolen claim mid-run
 * makes US yield.
 */

import RedisMock from 'ioredis-mock';
import {RedisService} from './redis.service';
import {ReplicaGuardService} from './replica-guard.service';

function makeGuard(mock: InstanceType<typeof RedisMock>): ReplicaGuardService & {exits: string[]} {
  const guard = new ReplicaGuardService({client: mock} as unknown as RedisService);
  const exits: string[] = [];
  jest.spyOn(guard, 'fatalExit').mockImplementation((reason: string) => { exits.push(reason); });
  return Object.assign(guard, {exits});
}

describe('AUDIT #3/#10 — ReplicaGuardService', () => {
  let redis: InstanceType<typeof RedisMock>;
  const KEY = ReplicaGuardService.KEY;

  beforeEach(async () => {
    jest.useRealTimers();
    delete process.env.REPLICA_GUARD;
    redis = new RedisMock();
    await redis.flushall(); // ioredis-mock instances SHARE a store
  });

  it('the FIRST replica claims and boots', async () => {
    const a = makeGuard(redis);
    await a.onApplicationBootstrap();
    expect(a.exits).toHaveLength(0);
    expect(await redis.get(KEY)).toBe(a.instanceId);
    await a.onModuleDestroy();
  });

  it('a COMPETING replica refuses after the retry window (the audit-#3 stopgap)', async () => {
    jest.useFakeTimers();
    const a = makeGuard(redis);
    await a.onApplicationBootstrap();

    const b = makeGuard(redis);
    const boot = b.onApplicationBootstrap();
    // Drive b through its full retry window; a's claim never lapses because
    // ioredis-mock TTLs use wall-clock, frozen under fake timers.
    await jest.advanceTimersByTimeAsync(ReplicaGuardService.CLAIM_WINDOW_MS + ReplicaGuardService.CLAIM_RETRY_MS);
    await boot;
    expect(b.exits).toHaveLength(1);
    expect(b.exits[0]).toContain('another live messenger-service replica');
    expect(await redis.get(KEY)).toBe(a.instanceId);   // the survivor is untouched
    jest.useRealTimers();
    await a.onModuleDestroy();
    await b.onModuleDestroy();
  });

  it('a ROLLING RESTART succeeds: the old holder releases inside the window and the new replica claims', async () => {
    jest.useFakeTimers();
    const a = makeGuard(redis);
    await a.onApplicationBootstrap();

    const b = makeGuard(redis);
    const boot = b.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(ReplicaGuardService.CLAIM_RETRY_MS); // b has retried once
    await a.onModuleDestroy();                                              // old container drains
    await jest.advanceTimersByTimeAsync(ReplicaGuardService.CLAIM_RETRY_MS * 2);
    await boot;
    expect(b.exits).toHaveLength(0);
    expect(await redis.get(KEY)).toBe(b.instanceId);
    jest.useRealTimers();
    await b.onModuleDestroy();
  });

  it('a Redis error at claim time fails OPEN: the replica boots unguarded (#6 lesson)', async () => {
    const broken = {
      client: {set: async () => { throw new Error('ECONNREFUSED'); }},
    } as unknown as RedisService;
    const guard = new ReplicaGuardService(broken);
    const exits: string[] = [];
    jest.spyOn(guard, 'fatalExit').mockImplementation(r => { exits.push(r); });
    await guard.onApplicationBootstrap();
    expect(exits).toHaveLength(0);
    await guard.onModuleDestroy();
  });

  it('a STOLEN claim mid-run makes this instance yield (two live replicas IS the outage)', async () => {
    jest.useFakeTimers();
    const a = makeGuard(redis);
    await a.onApplicationBootstrap();
    // Simulate: a's TTL lapsed during a stall and another replica claimed.
    await redis.set(KEY, 'intruder-instance-id');
    await jest.advanceTimersByTimeAsync(ReplicaGuardService.HEARTBEAT_MS + 50);
    expect(a.exits.some(r => r.includes('held by another instance'))).toBe(true);
    jest.useRealTimers();
    await a.onModuleDestroy();
    expect(await redis.get(KEY)).toBe('intruder-instance-id'); // never deletes a foreign claim
  });

  it('the heartbeat re-claims after a lapse nobody exploited', async () => {
    jest.useFakeTimers();
    const a = makeGuard(redis);
    await a.onApplicationBootstrap();
    await redis.del(KEY);                                     // TTL lapse stand-in
    await jest.advanceTimersByTimeAsync(ReplicaGuardService.HEARTBEAT_MS + 50);
    expect(await redis.get(KEY)).toBe(a.instanceId);
    expect(a.exits).toHaveLength(0);
    jest.useRealTimers();
    await a.onModuleDestroy();
  });

  it('REPLICA_GUARD=off disables everything (logged escape hatch)', async () => {
    process.env.REPLICA_GUARD = 'off';
    const a = makeGuard(redis);
    await a.onApplicationBootstrap();
    expect(await redis.get(KEY)).toBeNull();                  // never claimed
    expect(a.exits).toHaveLength(0);
    await a.onModuleDestroy();
  });

  it('shutdown releases the claim so the next boot is instant', async () => {
    const a = makeGuard(redis);
    await a.onApplicationBootstrap();
    await a.onModuleDestroy();
    expect(await redis.get(KEY)).toBeNull();
  });
});
