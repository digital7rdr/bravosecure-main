import {EscrowReconciliationService} from './escrow-reconciliation.service';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {ConfigService} from '@nestjs/config';
import type {SentryService} from '../observability/sentry.service';
import type {DispatchMetricsService} from '../observability/dispatch-metrics.service';

const db = {q: jest.fn()};
const client = {set: jest.fn(), del: jest.fn(), eval: jest.fn().mockResolvedValue(1)};
const redis = {client};
const config = {get: jest.fn()};
const metrics = {inc: jest.fn(), setGauge: jest.fn()};
const sentry = {captureException: jest.fn()};

function svc(): EscrowReconciliationService {
  return new EscrowReconciliationService(
    db as unknown as DatabaseService, redis as unknown as RedisService, config as unknown as ConfigService,
    metrics as unknown as DispatchMetricsService, sentry as unknown as SentryService,
  );
}
function flagOn(on = true): void {
  config.get.mockImplementation((k: string) =>
    k === 'featureFlags.autoDispatch' ? on : (k === 'platformAccounts.escrowId' ? '00000000-0000-0000-0000-0000000000e5' : undefined));
}

describe('EscrowReconciliationService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    flagOn(true);
    client.set.mockResolvedValue('OK');
    client.del.mockResolvedValue(1);
  });

  it('no-ops when AUTO_DISPATCH_ENABLED is off', async () => {
    flagOn(false);
    const r = await svc().sweepOnce();
    expect(r).toEqual({drift: 0, skipped_lock: false, skipped_flag: true});
    expect(client.set).not.toHaveBeenCalled();
    expect(db.q).not.toHaveBeenCalled();
  });

  it('does no work when another pod holds the lock', async () => {
    client.set.mockResolvedValue(null);
    const r = await svc().sweepOnce();
    expect(r.skipped_lock).toBe(true);
    expect(db.q).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();
  });

  it('reports clean (drift 0) when every invariant holds, releases the lock', async () => {
    db.q.mockResolvedValue([]);
    const r = await svc().sweepOnce();
    expect(r).toEqual({drift: 0, skipped_lock: false, skipped_flag: false});
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'lock:escrow-recon', expect.any(String));
  });

  it('flags an injected imbalance (a terminal hold whose split != gross)', async () => {
    db.q.mockImplementation((sql: string) =>
      /gross_credits <> COALESCE/.test(sql) ? Promise.resolve([{booking_id: 'b1', gross_credits: 800}]) : Promise.resolve([]));
    const r = await svc().sweepOnce();
    expect(r.drift).toBe(1);
  });

  it('Step 28 — on drift, increments the money-drift metric and pages Sentry (no PII)', async () => {
    db.q.mockImplementation((sql: string) =>
      /gross_credits <> COALESCE/.test(sql) ? Promise.resolve([{booking_id: 'b1', gross_credits: 800}]) : Promise.resolve([]));
    await svc().sweepOnce();
    expect(metrics.inc).toHaveBeenCalledWith('dispatch_money_drift_total', undefined, 1);
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({message: 'money_drift'}),
      expect.objectContaining({tags: {kind: 'dispatch_money_drift'}}),
    );
    // The Sentry payload carries counts only — never a booking id / coords / name.
    const [, ctx] = sentry.captureException.mock.calls[0];
    expect(JSON.stringify(ctx.extra)).not.toMatch(/b1/);
  });

  it('Step 28 — a clean sweep does NOT page Sentry but stamps the liveness gauge', async () => {
    db.q.mockResolvedValue([]);
    await svc().sweepOnce();
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(metrics.setGauge).toHaveBeenCalledWith('dispatch_watchdog_last_run_ts', expect.any(Number), {sweep: 'reconciliation'});
  });
});
