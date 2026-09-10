/**
 * AUDIT #12 — the inline-txn aliasing class, pinned on a REAL SQLite
 * engine (node:sqlite), adapted from the Edge reviewer's attack probes.
 *
 * The stub-db suites cannot see what actually persists; this one can.
 * Against the handle-compare version this exact scenario produced (real
 * trace, edge review): the zombie inline COMMITTED the later frame's
 * half-done txn, the later frame's continuation ran in AUTOCOMMIT, and
 * its own COMMIT died on "cannot commit - no transaction is active" —
 * both its writes durable while it reported failure. The nonce version
 * must keep the zombie silent and the later frame atomic.
 */
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));

import {DatabaseSync} from 'node:sqlite';

function realDb() {
  const sq = new DatabaseSync(':memory:');
  sq.exec('CREATE TABLE t (v TEXT)');
  const log: string[] = [];
  return {
    sq, log,
    rows: (): string[] => (sq.prepare('SELECT v FROM t').all() as {v: string}[]).map(r => r.v),
    db: {
      async execute(sql: string): Promise<unknown> { log.push(sql); sq.exec(sql); return undefined; },
    },
  };
}

describe('AUDIT #12 — wedged chain-resident inline vs a later frame (real engine, B-75 shape)', () => {
  beforeEach(() => {
    jest.useFakeTimers();

    (require('../runtime/receiveTransaction') as
      typeof import('../runtime/receiveTransaction'))._resetTxnChainForTests();
  });
  afterEach(() => {
    jest.useRealTimers();

    (require('../runtime/receiveTransaction') as
      typeof import('../runtime/receiveTransaction'))._resetTxnChainForTests();
  });

  it('the resumed zombie emits nothing; the later frame commits atomically', async () => {

    const rtx = require('../runtime/receiveTransaction') as
      typeof import('../runtime/receiveTransaction');
    const h = realDb();

    // (a) chain-resident inline (runOnTxnChain → runRatchetTxnInline) wedges
    let releaseInline!: () => void;
    const gate = new Promise<void>(r => { releaseInline = r; });
    let assertLiveVerdict = 'not-reached';
    const inlineP = rtx.runOnTxnChain(async () => {
      await rtx.runRatchetTxnInline(h.db, async (frame) => {
        await h.db.execute("INSERT INTO t VALUES ('INLINE-ZOMBIE')");
        await gate; // wedge
        frame.assertLive(); // must throw post-disown
        assertLiveVerdict = 'LIVE (guard passed)';
      });
    }, 'recovery');
    const inlineOutcome = inlineP.then(() => 'resolved', e => (e as Error).message);
    await jest.advanceTimersByTimeAsync(1);

    // (b) watchdog force-advances → the inline's BEGIN is ROLLED BACK
    await jest.advanceTimersByTimeAsync(rtx.CHAIN_FRAME_FORCE_MS + 1_000);
    await Promise.resolve();
    expect(h.rows()).toEqual([]); // the zombie's INSERT died with its txn

    // (c) a LATER frame opens a live BEGIN on the SAME shared connection
    let releaseLater!: () => void;
    const laterGate = new Promise<void>(r => { releaseLater = r; });
    const laterP = rtx.runWithRatchetTxn(h.db, async () => {
      await h.db.execute("INSERT INTO t VALUES ('LATER-HALF-DONE')");
      await laterGate; // the txn is LIVE when the zombie resumes
      await h.db.execute("INSERT INTO t VALUES ('LATER-SECOND-WRITE')");
      return 'ok';
    }, 'later');
    await jest.advanceTimersByTimeAsync(1);

    // (d) the zombie resumes INSIDE the later frame's txn window
    releaseInline();
    await jest.advanceTimersByTimeAsync(5);
    expect(await inlineOutcome).toMatch(/txn_frame_disowned/);
    expect(assertLiveVerdict).toBe('not-reached'); // assertLive threw

    // (e) the later frame finishes: BOTH its writes durable, in ONE txn
    releaseLater();
    await jest.advanceTimersByTimeAsync(5);
    await expect(laterP).resolves.toBe('ok');
    expect(h.rows()).toEqual(['LATER-HALF-DONE', 'LATER-SECOND-WRITE']);
    // Exactly one ROLLBACK (the watchdog's) and one COMMIT (the later
    // frame's) ever reached the engine.
    expect(h.log.filter(s => s === 'ROLLBACK')).toHaveLength(1);
    expect(h.log.filter(s => s === 'COMMIT')).toHaveLength(1);
  });
});
