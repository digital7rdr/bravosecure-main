import {RelistTimeoutService} from './relist-timeout.service';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {ConfigService} from '@nestjs/config';
import type {DispatchService} from './dispatch.service';

/**
 * Sweep 4 — relist/orphan timeout (spec P4 + review D2). A withdrawn/no-show
 * relisted booking is DISPATCHING with a HELD hold and NO live offer, so no other
 * sweep can terminate it; this one must close it via noProvider (which refunds).
 */
function mk(opts: {enabled?: boolean; lock?: 'OK' | null; due?: Array<{id: string}>}) {
  const db = {
    q: jest.fn().mockResolvedValue(opts.due ?? []),
    qOne: jest.fn(),
  };
  const redis = {client: {
    set: jest.fn().mockResolvedValue(opts.lock === undefined ? 'OK' : opts.lock),
    del: jest.fn().mockResolvedValue(1),
    eval: jest.fn().mockResolvedValue(1),
  }};
  const config = {get: () => opts.enabled ?? true};
  const dispatch = {noProvider: jest.fn().mockResolvedValue(undefined)};
  const svc = new RelistTimeoutService(
    db as unknown as DatabaseService,
    redis as unknown as RedisService,
    config as unknown as ConfigService,
    dispatch as unknown as DispatchService,
  );
  return {svc, db, redis, dispatch};
}

describe('RelistTimeoutService.sweepOnce', () => {
  it('closes each stalled offer-less DISPATCHING booking via noProvider (→ R12 refund)', async () => {
    const {svc, db, dispatch} = mk({due: [{id: 'b1'}, {id: 'b2'}]});
    const r = await svc.sweepOnce();
    expect(r).toEqual({closed: 2, skipped_lock: false, skipped_flag: false});
    expect(dispatch.noProvider).toHaveBeenCalledWith('b1');
    expect(dispatch.noProvider).toHaveBeenCalledWith('b2');
    // The query must scope to auto + DISPATCHING + past-TTL + NO live OFFERED row —
    // never a healthy mid-cascade booking.
    expect(db.q).toHaveBeenCalledWith(
      expect.stringMatching(/dispatch_mode = 'auto'[\s\S]*status = 'DISPATCHING'[\s\S]*NOT EXISTS[\s\S]*status = 'OFFERED'/),
      [expect.anything()],
    );
  });

  it('a single failing row does not abort the sweep', async () => {
    const {svc, dispatch} = mk({due: [{id: 'bad'}, {id: 'b2'}]});
    dispatch.noProvider.mockRejectedValueOnce(new Error('boom'));
    const r = await svc.sweepOnce();
    expect(r.closed).toBe(2);
    expect(dispatch.noProvider).toHaveBeenCalledWith('b2');
  });

  it('skips when another pod holds the lock', async () => {
    const {svc, dispatch} = mk({lock: null});
    const r = await svc.sweepOnce();
    expect(r).toEqual({closed: 0, skipped_lock: true, skipped_flag: false});
    expect(dispatch.noProvider).not.toHaveBeenCalled();
  });

  it('INFRA-3 — runs regardless of AUTO_DISPATCH_ENABLED (money resolver is always-on)', async () => {
    const {svc, db, dispatch} = mk({enabled: false}); // flag off; no due rows (default [])
    const r = await svc.sweepOnce();
    expect(r).toEqual({closed: 0, skipped_lock: false, skipped_flag: false});
    expect(db.q).toHaveBeenCalled();                     // queried — did NOT skip on the flag
    expect(dispatch.noProvider).not.toHaveBeenCalled();  // no due rows
  });

  it('releases the lock even when the query throws', async () => {
    const {svc, db, redis} = mk({});
    db.q.mockRejectedValue(new Error('db down'));
    await expect(svc.sweepOnce()).rejects.toThrow('db down');
    expect(redis.client.eval).toHaveBeenCalled();
  });
});
