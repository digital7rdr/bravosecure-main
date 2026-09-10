/**
 * AUDIT-2026-08-13 #15 — the archive-retry outbox drain must be CRASH-SAFE.
 *
 * The old drain did `RPOP` then processed: a crash (deploy restart, OOM-kill)
 * between the pop and the outcome permanently dropped the row — a sealed
 * envelope that had already failed its live archive write, i.e. exactly the
 * data the outbox exists to not lose. Now:
 *   - rows move OUTBOX → PROCESSING atomically via LMOVE;
 *   - every outcome (archived / dead-lettered / re-enqueued) LREMs the
 *     staged copy;
 *   - the next drain RECLAIMS whatever a crashed run left in PROCESSING
 *     (before its own loop starts, so it can never steal its own rows) and
 *     re-increments the approximate byte counter it decrements on staging.
 * Single-replica semantics, matching the deployment (audit #3).
 *
 * ioredis-mock supports lmove/lrem (verified before this suite was written).
 */

import {Test} from '@nestjs/testing';
import {ConfigModule} from '@nestjs/config';
import RedisMock from 'ioredis-mock';
import {RedisService} from '../redis/redis.service';
import {BackupService} from './backup.service';
import configuration from '../config/configuration';

const OUTBOX = 'backup:archive-retry';
const PROCESSING = 'backup:archive-retry:processing';
const BYTES = 'backup:archive-retry:bytes';
const DEAD = 'backup:archive-retry:dead';

function row(envelopeId: string, attempts = 0): string {
  return JSON.stringify({
    recipientUserId: 'bob', envelopeId, outerSealed: 'AAAA',
    timestampMs: 1_700_000_000_000, attempts,
  });
}

async function setup(mock: InstanceType<typeof RedisMock>) {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({isGlobal: true, load: [configuration]})],
    providers: [RedisService, BackupService],
  })
    .overrideProvider(RedisService)
    .useValue({client: mock} as unknown as RedisService)
    .compile();
  return moduleRef.get(BackupService);
}

describe('AUDIT #15 — crash-safe archive-retry drain (LMOVE staging)', () => {
  let redis: InstanceType<typeof RedisMock>;
  let svc: BackupService;
  let archiveOutcome: 'ok' | 'missing-table' | 'transient-error' | 'permanent';

  beforeEach(async () => {
    redis = new RedisMock();
    // ioredis-mock instances SHARE a data store by default — without this
    // flush, rows from the previous test leak into the next drain (measured:
    // one permanent row dead-lettered twice). Same pattern as the relay spec.
    await redis.flushall();
    svc = await setup(redis);
    // The drain guards on the Supabase client being configured; give it a
    // truthy client and intercept the single archive attempt seam.
    (svc as unknown as {client: unknown}).client = {};
    archiveOutcome = 'ok';
    jest.spyOn(svc as unknown as {tryArchiveOnce: () => Promise<string>}, 'tryArchiveOnce')
      .mockImplementation(async () => archiveOutcome);
  });

  it('a successful drain leaves BOTH lists empty (no staged residue)', async () => {
    await redis.lpush(OUTBOX, row('env-1'), row('env-2'));
    const res = await svc.drainArchiveRetryOutbox();
    expect(res.ok).toBe(2);
    expect(await redis.llen(OUTBOX)).toBe(0);
    expect(await redis.llen(PROCESSING)).toBe(0);
  });

  it('CRASH RECOVERY: rows stranded in PROCESSING by a dead run are reclaimed and processed', async () => {
    // Simulate the crash aftermath: a previous drain LMOVE'd the row out of
    // the outbox and died before settling it.
    await redis.lpush(PROCESSING, row('env-crashed'));
    await redis.set(BYTES, '0'); // bytes were decremented when it was staged

    const res = await svc.drainArchiveRetryOutbox();
    expect(res.ok).toBe(1);                          // the stranded row was archived
    expect(await redis.llen(PROCESSING)).toBe(0);    // and settled
    expect(await redis.llen(OUTBOX)).toBe(0);
    // Bytes: reclaim +N, staging -N — net zero, never negative drift.
    expect(Number(await redis.get(BYTES))).toBe(0);
  });

  it('a TRANSIENT failure re-enqueues with attempts+1 and still clears the staged copy', async () => {
    archiveOutcome = 'transient-error';
    await redis.lpush(OUTBOX, row('env-t', 0));
    const res = await svc.drainArchiveRetryOutbox();
    expect(res.retried).toBe(1);
    expect(await redis.llen(PROCESSING)).toBe(0);
    const requeued = await redis.lrange(OUTBOX, 0, -1);
    expect(requeued).toHaveLength(1);
    expect(JSON.parse(requeued[0]).attempts).toBe(1);
  });

  it('a PERMANENT failure dead-letters and clears the staged copy', async () => {
    archiveOutcome = 'permanent';
    await redis.lpush(OUTBOX, row('env-p'));
    const res = await svc.drainArchiveRetryOutbox();
    expect(res.dead).toBe(1);
    expect(await redis.llen(PROCESSING)).toBe(0);
    expect(await redis.llen(DEAD)).toBe(1);
  });

  it('a MALFORMED row dead-letters and clears the staged copy', async () => {
    await redis.lpush(OUTBOX, 'not-json{{');
    const res = await svc.drainArchiveRetryOutbox();
    expect(res.dead).toBe(1);
    expect(await redis.llen(PROCESSING)).toBe(0);
    expect(await redis.llen(DEAD)).toBe(1);
  });

  it('REV-2 (critic): the M-7 privacy purge clears STAGED rows too — a wiped user cannot be re-archived', async () => {
    // Ported from the critic's preserved repro (inverted). A row for 'bob'
    // stranded in PROCESSING by a crash must not survive forgetBackup's
    // purge: pre-fix it outlived the 1h tombstone and a later reclaim
    // re-archived data the user deleted (BACKUP_LOOP §2: "server wipes
    // purge the ledger").
    await redis.lpush(PROCESSING, row('env-wiped'));
    await redis.lpush(PROCESSING, JSON.stringify({
      recipientUserId: 'carol', envelopeId: 'env-keep', outerSealed: 'BBBB',
      timestampMs: 1, attempts: 0,
    }));
    await (svc as unknown as {purgeOutboxForUser: (u: string) => Promise<void>}).purgeOutboxForUser('bob');
    const remaining = await redis.lrange(PROCESSING, 0, -1);
    expect(remaining).toHaveLength(1);                        // carol's row untouched
    expect(JSON.parse(remaining[0]).recipientUserId).toBe('carol');

    // …and the outbox pass still works alongside it.
    await redis.lpush(OUTBOX, row('env-wiped-2'));
    await (svc as unknown as {purgeOutboxForUser: (u: string) => Promise<void>}).purgeOutboxForUser('bob');
    expect(await redis.llen(OUTBOX)).toBe(0);
  });

  it('REV-2 (edge): overlapping drains cannot steal each other\'s staged rows — the reentrancy guard skips tick B', async () => {
    // Ported from the edge reviewer's row-loss repro (inverted). Drain A
    // blocks inside tryArchiveOnce with row R staged; drain B fires (cron
    // does not await; the replica lock had expired pre-fix). Pre-fix, B's
    // reclaim moved R back, re-staged it, and A's value-matched LREM then
    // deleted B's copy — R in NEITHER list. The guard makes B a no-op.
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    // rev-3 (edge E1): only the FIRST call blocks on the gate; an unguarded
    // drain B gets a distinct throwing outcome instead of deadlocking on the
    // same gate — so removing the guard fails HERE on the actual loss shape
    // (assertions below), not on a misleading 5s test timeout a maintainer
    // might "fix" by raising the timeout.
    let calls = 0;
    jest.spyOn(svc as unknown as {tryArchiveOnce: () => Promise<string>}, 'tryArchiveOnce')
      .mockImplementation(async () => {
        calls += 1;
        if (calls === 1) { await gate; return 'ok'; }
        throw new Error('drain-B-entered-the-archive-seam');
      });
    await redis.lpush(OUTBOX, row('env-r'));

    const drainA = svc.drainArchiveRetryOutbox();
    await new Promise(r => setImmediate(r));                  // A reaches the gate, R staged
    expect(await redis.llen(PROCESSING)).toBe(1);

    const b = await svc.drainArchiveRetryOutbox();            // tick B — must skip
    expect(b).toEqual({ok: 0, retried: 0, dead: 0});
    expect(calls).toBe(1);                                    // B never touched the seam
    expect(await redis.llen(PROCESSING)).toBe(1);             // R untouched by B

    release();
    const a = await drainA;
    expect(a.ok).toBe(1);
    expect(await redis.llen(PROCESSING)).toBe(0);             // settled exactly once
    expect(await redis.llen(OUTBOX)).toBe(0);                 // and never duplicated
  });

  it('REV-3 (edge E2): a failed llen degrades to the FIXED batch, never a silent no-op tick', async () => {
    // Reverting the fallback to 0 ran the full suite green — the exact
    // unpinned-lane class the critic caught on the ring queue. Pin it: with
    // llen throwing, the drain still processes queued rows.
    await redis.lpush(OUTBOX, row('env-llen'));
    const realLlen = redis.llen.bind(redis);
    jest.spyOn(redis as unknown as {llen: (k: string) => Promise<number>}, 'llen')
      .mockImplementationOnce(async () => { throw new Error('llen blip'); });
    const res = await svc.drainArchiveRetryOutbox();
    expect(res.ok).toBe(1);                                   // processed despite the blip
    expect(await realLlen(OUTBOX)).toBe(0);
    expect(await realLlen(PROCESSING)).toBe(0);
  });

  it('THE ORIGINAL BUG SHAPE, pinned: a throw mid-process leaves the row in PROCESSING, not dropped', async () => {
    // tryArchiveOnce throwing (not returning an outcome) models the crash
    // class: the row must survive SOMEWHERE in Redis. With RPOP it was gone;
    // with LMOVE it sits in PROCESSING for the next drain's reclaim.
    jest.spyOn(svc as unknown as {tryArchiveOnce: () => Promise<string>}, 'tryArchiveOnce')
      .mockImplementation(async () => { throw new Error('simulated crash'); });
    await redis.lpush(OUTBOX, row('env-x'));
    await expect(svc.drainArchiveRetryOutbox()).rejects.toThrow('simulated crash');
    expect(await redis.llen(PROCESSING)).toBe(1);   // survived, staged
    expect(await redis.llen(OUTBOX)).toBe(0);

    // …and the NEXT drain reclaims + completes it.
    jest.spyOn(svc as unknown as {tryArchiveOnce: () => Promise<string>}, 'tryArchiveOnce')
      .mockImplementation(async () => 'ok');
    const res = await svc.drainArchiveRetryOutbox();
    expect(res.ok).toBe(1);
    expect(await redis.llen(PROCESSING)).toBe(0);
  });
});
