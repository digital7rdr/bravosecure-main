import {EscrowReleaseSweepService} from './escrow-release-sweep.service';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {ConfigService} from '@nestjs/config';
import type {SettlementService} from '../settlement/settlement.service';

const db = {q: jest.fn(), withTransaction: jest.fn()};
const client = {set: jest.fn(), del: jest.fn(), eval: jest.fn().mockResolvedValue(1)};
const redis = {client};
const config = {get: jest.fn()};
const settlement = {settleEscrowRelease: jest.fn()};

function svc(): EscrowReleaseSweepService {
  return new EscrowReleaseSweepService(
    db as unknown as DatabaseService,
    redis as unknown as RedisService,
    config as unknown as ConfigService,
    settlement as unknown as SettlementService,
  );
}

function flagOn(on = true): void {
  config.get.mockImplementation((k: string) => (k === 'featureFlags.autoDispatch' ? on : (k === 'dispatch.platformFeePct' ? 0 : undefined)));
}

function wire(opts: {due?: Array<{booking_id: string}>; released?: boolean}): void {
  db.withTransaction.mockImplementation((fn: (tx: unknown) => unknown) => fn({q: db.q}));
  db.q.mockImplementation((sql: string) =>
    /WHERE status = 'PENDING_RELEASE'/.test(sql) ? Promise.resolve(opts.due ?? []) : Promise.resolve([]));
  settlement.settleEscrowRelease.mockResolvedValue({escrow: true, released: opts.released ?? true, toProvider: 800, platformFee: 0});
}

describe('EscrowReleaseSweepService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    flagOn(true);
    client.set.mockResolvedValue('OK');
    client.del.mockResolvedValue(1);
  });

  it('INFRA-3 — runs regardless of AUTO_DISPATCH_ENABLED (payout resolver is always-on)', async () => {
    flagOn(false);              // flag off
    db.q.mockResolvedValue([]); // no releasable holds
    const r = await svc().sweepOnce();
    expect(r).toEqual({released: 0, skipped_lock: false, skipped_flag: false});
    expect(client.set).toHaveBeenCalled(); // acquired the lock — did NOT skip on the flag
  });

  it('does NO work when another pod holds the lock — multi-pod double-release guard (LB9)', async () => {
    wire({});
    client.set.mockResolvedValue(null);
    const r = await svc().sweepOnce();
    expect(r.skipped_lock).toBe(true);
    expect(db.q).not.toHaveBeenCalled();
    expect(settlement.settleEscrowRelease).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();
  });

  it('releases each eligible hold via SettlementService, releases the lock', async () => {
    wire({due: [{booking_id: 'b1'}, {booking_id: 'b2'}], released: true});
    const r = await svc().sweepOnce();
    expect(settlement.settleEscrowRelease).toHaveBeenCalledTimes(2);
    expect(settlement.settleEscrowRelease).toHaveBeenCalledWith(expect.anything(), 'b1', {kind: 'system'});
    expect(r).toEqual({released: 2, skipped_lock: false, skipped_flag: false});
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'lock:escrow-release', expect.any(String));
  });

  it('does NOT count a hold whose release no-ops (raced to DISPUTED/RELEASED)', async () => {
    wire({due: [{booking_id: 'b1'}], released: false});
    const r = await svc().sweepOnce();
    expect(r.released).toBe(0);
  });
});
