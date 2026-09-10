/**
 * AUDIT-2026-08-13 #11 — guardDbLifecycle: close() must be SAFE on a handle
 * other code may still touch.
 *
 * op-sqlite's JS close() is a native use-after-free trap (verified against
 * cpp/DBHostObject.cpp in review): it frees the connection without nulling
 * the retained pointer or draining the thread pool, so execute-after-close
 * is a SIGSEGV and close-during-execute lets a pool task use freed memory.
 * The #11 close-previous-handle-on-rebuild fix is only safe because this
 * wrapper turns both lanes into JS-visible behaviour:
 *   - execute after close  → catchable StoreError('db_closed…')
 *   - close with executes in flight → native close DEFERRED until drained
 *   - double close → single native call
 */
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));

import {readFileSync} from 'fs';
import {join} from 'path';
import {guardDbLifecycle, DbHandle} from '../crypto/db';

type Fake = {
  execute: jest.Mock;
  close: jest.Mock;
};

function makeFake(): Fake {
  return {
    execute: jest.fn(async () => ({rows: []})),
    close: jest.fn(),
  };
}

describe('AUDIT #11 — guardDbLifecycle behavioral contract', () => {
  it('execute after close throws a catchable StoreError — never reaches native', async () => {
    const fake = makeFake();
    const raw = fake.execute;
    guardDbLifecycle(fake as unknown as DbHandle);
    fake.close();
    // Sync throw at the call site — still caught by every caller's
    // try/catch around `await db.execute(...)`, and classified transient
    // by the receive lane (see the db_closed classifier test below).
    expect(() => fake.execute('SELECT 1')).toThrow(/db_closed: execute after close/);
    expect(raw).not.toHaveBeenCalled(); // the freed-memory path is unreachable
  });

  it('close during an in-flight execute DEFERS the native close until the drain', async () => {
    const fake = makeFake();
    let release: (() => void) | null = null;
    const gate = new Promise<void>(res => { release = res; });
    const rawClose = fake.close;
    fake.execute.mockImplementationOnce(async () => { await gate; return {rows: []}; });
    guardDbLifecycle(fake as unknown as DbHandle);

    const inFlight = fake.execute('INSERT slow');
    fake.close();                          // arrives mid-execute
    expect(rawClose).not.toHaveBeenCalled(); // NOT closed under the pool task
    release!();
    await inFlight;
    expect(rawClose).toHaveBeenCalledTimes(1); // closed exactly at drain
  });

  it('double close reaches native exactly once; in-flight failures still drain', async () => {
    const fake = makeFake();
    const rawClose = fake.close;
    fake.execute.mockImplementationOnce(async () => { throw new Error('SQL boom'); });
    guardDbLifecycle(fake as unknown as DbHandle);

    const failing = fake.execute('BAD SQL');
    fake.close();
    fake.close(); // second close is a no-op
    await expect(failing).rejects.toThrow('SQL boom'); // original error surfaces
    expect(rawClose).toHaveBeenCalledTimes(1); // drained via finally, closed once
  });

  it('a guarded handle behaves normally while open', async () => {
    const fake = makeFake();
    guardDbLifecycle(fake as unknown as DbHandle);
    await expect(fake.execute('SELECT 1', [1])).resolves.toEqual({rows: []});
    // args pass through untouched
    expect(fake.execute).toBeDefined();
  });

  it('EVERY method is gated, not an execute-only whitelist (critic rev-3)', async () => {
    // op-sqlite's enhanceDB assigns executeSync/executeBatch/attach/… as
    // raw pass-throughs that never route through `execute` — one new call
    // site against an execute-only guard would have been a native UAF.
    const fake = {
      execute: jest.fn(async (..._a: unknown[]) => ({rows: []})),
      executeSync: jest.fn((..._a: unknown[]) => ({rows: []})),
      executeBatch: jest.fn(async (..._a: unknown[]) => ({rowsAffected: 0})),
      attach: jest.fn((..._a: unknown[]) => undefined),
      close: jest.fn(),
    };
    const rawBatch = fake.executeBatch;
    const rawSync = fake.executeSync;
    guardDbLifecycle(fake as unknown as DbHandle);

    // Async non-execute methods join the in-flight drain…
    let release: (() => void) | null = null;
    rawBatch.mockImplementationOnce(async () => { await new Promise<void>(r => { release = r; }); return {rowsAffected: 1}; });
    const inFlight = fake.executeBatch([]);
    fake.close();                 // mid-batch — must defer, not UAF
    release!();
    await inFlight;               // drain fires the deferred native close

    // …and after close, every method throws the catchable StoreError.
    expect(() => fake.executeSync('SELECT 1')).toThrow(/db_closed: executeSync/);
    await expect(async () => fake.executeBatch([])).rejects.toThrow(/db_closed: executeBatch/);
    expect(() => fake.attach('a', 'b')).toThrow(/db_closed: attach/);
    expect(rawSync).not.toHaveBeenCalled();
  });

  it('a wedged in-flight execute defers the close FOREVER but warns at 30s (leak, not crash)', () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fake = makeFake();
      const rawClose = fake.close;
      fake.execute.mockImplementationOnce(() => new Promise(() => { /* never settles */ }));
      guardDbLifecycle(fake as unknown as DbHandle);
      void fake.execute('WEDGED');
      fake.close();
      expect(rawClose).not.toHaveBeenCalled();
      jest.advanceTimersByTime(31_000);
      expect(rawClose).not.toHaveBeenCalled(); // force-close under a pool task IS the UAF
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('close deferred >30s'));
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });
});

describe('AUDIT #11 — the four destructive catch lanes gate on transient SQL (edge rev-4)', () => {
  // The classifier alternate only helps lanes that CONSULT it. These four
  // caught blindly and made destructive decisions — for them the guard
  // traded "SIGSEGV, data safe on relay" for "no crash, data destroyed".
  // (Sites 2 and 3 are pinned behaviorally in bootGroupStashDrain.test.ts
  // and archiveReplayDrain.test.ts; the two productionRuntime lanes are
  // unimportable, so they are pinned here by line-start source scans.)
  const prSrc = readFileSync(
    join(__dirname, '..', 'runtime', 'productionRuntime.ts'), 'utf8');
  const lineStart = (body: string, prefix: string): boolean =>
    body.split(/\r?\n/).some(l => l.trim().startsWith(prefix));

  it('WS unwrap: transient SQL leaves the envelope ON the relay — never ack-discarded', () => {
    // The try covers getIdentityKeyPair() (a live SQL read); the catch
    // acked 'discarded' unconditionally → relay hard-delete.
    const unwrapAt = prSrc.indexOf('unwrapped = await unwrapOuter({');
    expect(unwrapAt).toBeGreaterThan(-1);
    const catchBody = prSrc.slice(unwrapAt, unwrapAt + 3000);
    const gate = catchBody.indexOf('if (isTransientSqlError(e)) {');
    const ack = catchBody.indexOf("disposition: 'discarded'");
    expect(gate).toBeGreaterThan(-1);
    expect(ack).toBeGreaterThan(gate); // the gate sits BEFORE the destructive ack
    expect(lineStart(catchBody.slice(0, ack), 'if (isTransientSqlError(e)) {')).toBe(true);
  });

  it('admin-action drain: transient SQL never spends a bounded attempt', () => {
    const at = prSrc.indexOf('crashLog(`[group:drain-admin] apply failed');
    expect(at).toBeGreaterThan(-1);
    const body = prSrc.slice(at, at + 900);
    const gate = body.indexOf('if (isTransientSqlError(e)) {continue;}');
    const bump = body.indexOf('bumpAttempts(row.id)');
    expect(gate).toBeGreaterThan(-1);
    expect(bump).toBeGreaterThan(gate); // gate BEFORE the attempt spend
    expect(lineStart(body.slice(0, bump), 'if (isTransientSqlError(e)) {continue;}')).toBe(true);
  });

  it('stash drain: the caller feeds transientSql into shouldBumpStashAttempt', () => {
    // The policy lives in the importable pure fn (pinned behaviorally in
    // bootGroupStashDrain.test.ts); this asserts the CALLER actually
    // feeds it — the guard-the-function-not-the-caller trap.
    expect(lineStart(prSrc,
      'if (!shouldBumpStashAttempt({needsKey, keyChanged, transientSql: isTransientSqlError(e)})) {continue;}'))
      .toBe(true);
  });
});

describe('AUDIT #11 — db_closed is TRANSIENT on the receive lane (critic rev-3)', () => {
  it('a StoreError(db_closed…) classifies leave-on-relay, never ack-discarded', () => {
    // Without this alternate the guard traded E1\'s SIGSEGV for permanent
    // message destruction: a receive frame racing a rebuild\'s handle close
    // classified terminal → the relay deleted the envelope. A closed LOCAL
    // handle says nothing about the message.

    const {isTransientSqlError} = require('../runtime/receiveTransaction') as
      typeof import('../runtime/receiveTransaction');

    const {StoreError} = require('@bravo/messenger-core') as {StoreError: new (m: string) => Error};
    expect(isTransientSqlError(new StoreError('db_closed: execute after close (late writer — see AUDIT #11)'))).toBe(true);
    expect(isTransientSqlError(new StoreError('db_closed: executeBatch after close (late writer — see AUDIT #11)'))).toBe(true);
    // …and the classifier still rejects a generic store failure.
    expect(isTransientSqlError(new StoreError('some other store failure'))).toBe(false);
  });
});

describe('AUDIT #11 — EVERY opener applies the guard (static pin, edge SHOULD-1)', () => {
  it('no export async function open*Db hands out an unguarded handle', () => {
    // "openSecondaryDb has no production caller" was an UNPINNED assumption
    // — the same class that let the original leak exist. Instead of pinning
    // caller-absence, every opener guards its handle, and this scan walks
    // ALL of them (future openers included) rather than naming one.
    const src = readFileSync(join(__dirname, '..', 'crypto', 'db.ts'), 'utf8');
    // `Database` included so an opener named outside the `open*Db`
    // convention cannot escape the walk (critic rev-4 note).
    const openerRe = /export async function (open\w*(?:Db|Database))\b/g;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = openerRe.exec(src)) !== null) {
      count += 1;
      const next = src.indexOf('\nexport', m.index + 1);
      const body = src.slice(m.index, next === -1 ? src.length : next);
      // Line-start anchored — a trailing-comment decoy cannot fake it.
      const guarded = body.split(/\r?\n/).some(l => l.trim().startsWith('guardDbLifecycle('));
      expect(`${m[1]} guarded: ${guarded}`).toBe(`${m[1]} guarded: true`);
    }
    expect(count).toBeGreaterThanOrEqual(3); // anti-vacuous: the walk found the openers
  });

  it('no production code uses the two guard-ESCAPING handle methods (critic rev-4)', () => {
    // The guard gates CALLS on the handle, not objects the handle hands
    // out: prepareStatement() returns a statement holding the raw
    // connection and reactiveExecute() registers a native callback —
    // prepare-then-close-then-execute is still a native UAF. Zero usage
    // today; this pin keeps "no unpinned assumption" true.
    const {readdirSync, statSync} = require('node:fs');
    const path = require('node:path');
    const ROOTS = [
      join(__dirname, '..'),
      join(__dirname, '..', '..', '..', '..', 'packages', 'messenger-core', 'src'),
    ];
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name === '__tests__' || name === 'node_modules') {continue;}
          walk(p);
        } else if (/\.tsx?$/.test(name)) {
          const s = readFileSync(p, 'utf8');
          if (/\.(prepareStatement|reactiveExecute)\(/.test(s)) {
            hits.push(path.basename(p));
          }
        }
      }
    };
    for (const r of ROOTS) {walk(r);}
    expect(hits).toEqual([]);
  });
});
