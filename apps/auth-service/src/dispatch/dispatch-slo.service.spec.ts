import {DispatchSloService} from './dispatch-slo.service';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {ConfigService} from '@nestjs/config';
import type {SentryService} from '../observability/sentry.service';
import type {DispatchMetricsService} from '../observability/dispatch-metrics.service';

const db = {qOne: jest.fn(), q: jest.fn()};
const client = {set: jest.fn(), get: jest.fn(), del: jest.fn(), eval: jest.fn().mockResolvedValue(1)};
const redis = {client};
const config = {get: jest.fn()};
const sentry = {captureException: jest.fn()};
const metrics = {snapshot: jest.fn(), setGauge: jest.fn()};

function svc(): DispatchSloService {
  return new DispatchSloService(
    db as unknown as DatabaseService,
    redis as unknown as RedisService,
    config as unknown as ConfigService,
    sentry as unknown as SentryService,
    metrics as unknown as DispatchMetricsService,
  );
}

const NOW = 1_000_000_000_000;

describe('DispatchSloService (Step 26)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    config.get.mockReturnValue(true);          // AUTO_DISPATCH on
    client.set.mockResolvedValue('OK');        // lock acquired
    client.del.mockResolvedValue(1);
    client.get.mockResolvedValue(String(NOW)); // watchdog fresh
    db.qOne.mockResolvedValue({n: '0'});       // no stuck bookings
    db.q.mockResolvedValue([]);                // no dead regions
    metrics.snapshot.mockReturnValue({counters: {}, gauges: {}, histos: {}});
  });

  it('no-ops when AUTO_DISPATCH is off', async () => {
    config.get.mockReturnValue(false);
    const r = await svc().sweepOnce(NOW);
    expect(r).toEqual({breaches: [], skipped_lock: false, skipped_flag: true});
    expect(client.set).not.toHaveBeenCalled();
  });

  it('does no work when another pod holds the lock', async () => {
    client.set.mockResolvedValue(null);
    const r = await svc().sweepOnce(NOW);
    expect(r.skipped_lock).toBe(true);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('clean state ⇒ no breaches, lock released', async () => {
    const r = await svc().sweepOnce(NOW);
    expect(r.breaches).toEqual([]);
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'lock:dispatch-slo', expect.any(String));
  });

  it('fires stuck_dispatching when a booking has searched too long with no live offer', async () => {
    db.qOne.mockResolvedValue({n: '2'});
    const r = await svc().sweepOnce(NOW);
    expect(r.breaches).toContain('stuck_dispatching');
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({message: 'slo:stuck_dispatching'}),
      expect.objectContaining({tags: {kind: 'dispatch_slo', slo: 'stuck_dispatching'}}),
    );
  });

  it('fires watchdog_dead when the offer-sweep liveness key is stale', async () => {
    client.get.mockResolvedValue(String(NOW - 10 * 60_000)); // 10 min old
    const r = await svc().sweepOnce(NOW);
    expect(r.breaches).toContain('watchdog_dead');
  });

  it('fires region_zero_agencies when a region has live demand but no on-duty agency', async () => {
    db.q.mockResolvedValue([{region_code: 'BD'}]);
    const r = await svc().sweepOnce(NOW);
    expect(r.breaches).toContain('region_zero_agencies');
  });

  it('INFRA-5: fires money_sweep_dead when a payout/refund sweep liveness key is stale', async () => {
    client.get.mockImplementation((key: string) =>
      Promise.resolve(String(key).includes(':release:') ? String(NOW - 10 * 60_000) : String(NOW)));
    const r = await svc().sweepOnce(NOW);
    expect(r.breaches).toContain('money_sweep_dead:release');
    expect(r.breaches).not.toContain('watchdog_dead'); // the offer key is still fresh
  });

  it('INFRA-5: fires escrow_release_overdue when releasable holds sit past their window', async () => {
    db.qOne.mockImplementation((sql: string) =>
      Promise.resolve(/PENDING_RELEASE/.test(String(sql)) ? {release: '3', crew: '0'} : {n: '0'}));
    const r = await svc().sweepOnce(NOW);
    expect(r.breaches).toContain('escrow_release_overdue');
    expect(r.breaches).not.toContain('stuck_dispatching');
  });

  it('fires charge_failures only on a fresh delta (not on a flat counter)', async () => {
    metrics.snapshot.mockReturnValue({counters: {dispatch_charge_failure_total: 3}, gauges: {}, histos: {}});
    const s = svc();
    const r1 = await s.sweepOnce(NOW);
    expect(r1.breaches).toContain('charge_failures'); // 0 → 3 is a delta
    const r2 = await s.sweepOnce(NOW);
    expect(r2.breaches).not.toContain('charge_failures'); // unchanged → no re-fire
  });
});
