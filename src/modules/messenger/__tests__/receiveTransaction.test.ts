import {
  runWithRatchetTxn,
  isInsideRatchetTxn,
  isTransientSqlError,
} from '../runtime/receiveTransaction';
import { SqlMessageStore } from '../store/sqlMessageStore';
// Extracted so the B-130 burst-deadlock regression drives the SAME stub
// connection instead of hand-rolling a second copy of it.
import { makeMsg, makeTxnTrackingDb, assertSerializedTrace } from './txnTrackingDb';

/**
 * Stub DbHandle that records every SQL statement issued and lets us
 * simulate failures inside the transaction body. Mirrors the
 * op-sqlite execute(sql, params) signature.
 */
function makeStubDb() {
  const calls: string[] = [];
  return {
    calls,
    db: {
      async execute(sql: string): Promise<unknown> {
        calls.push(sql);
        return undefined;
      },
    },
  };
}

describe('runWithRatchetTxn — audit P0-N14 atomic ratchet+plaintext', () => {
  it('COMMITs when work resolves', async () => {
    const { db, calls } = makeStubDb();
    const result = await runWithRatchetTxn(db, async () => {
      await db.execute('INSERT INTO sessions VALUES (?)');
      await db.execute('INSERT INTO messages VALUES (?)');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toEqual([
      'BEGIN IMMEDIATE',
      'INSERT INTO sessions VALUES (?)',
      'INSERT INTO messages VALUES (?)',
      'COMMIT',
    ]);
  });

  it('ROLLBACKs and re-throws when work fails AFTER the ratchet write', async () => {
    // Scenario: libsignal advances the ratchet (INSERT INTO sessions)
    // and then the message-row UPSERT throws. The transaction must
    // unwind the session write so the redelivered ciphertext decrypts
    // cleanly on retry.
    const { db, calls } = makeStubDb();
    const boom = new Error('disk full');
    await expect(
      runWithRatchetTxn(db, async () => {
        await db.execute('INSERT INTO sessions VALUES (?)'); // ratchet
        throw boom; // plaintext write failed
      }),
    ).rejects.toBe(boom);
    expect(calls).toEqual([
      'BEGIN IMMEDIATE',
      'INSERT INTO sessions VALUES (?)',
      'ROLLBACK',
    ]);
  });

  it('ROLLBACKs when work fails BEFORE any write (cert/AAD check rejects)', async () => {
    const { db, calls } = makeStubDb();
    const reject = new Error('aad mismatch');
    await expect(
      runWithRatchetTxn(db, async () => {
        throw reject;
      }),
    ).rejects.toBe(reject);
    expect(calls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
  });

  it('still re-throws the original error when ROLLBACK itself fails', async () => {
    // We promise to surface the user-meaningful error, not the cleanup
    // failure. WAL recovery on next open handles the orphaned BEGIN.
    const calls: string[] = [];
    const rollbackBoom = new Error('rollback failed');
    const workBoom = new Error('decrypt failed');
    const db = {
      async execute(sql: string): Promise<unknown> {
        calls.push(sql);
        if (sql === 'ROLLBACK') {throw rollbackBoom;}
        return undefined;
      },
    };
    await expect(
      runWithRatchetTxn(db, async () => { throw workBoom; }),
    ).rejects.toBe(workBoom); // NOT rollbackBoom
    expect(calls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
  });

  it('uses BEGIN IMMEDIATE (acquires RESERVED up front, not on first write)', async () => {
    // Critical for correctness — BEGIN DEFERRED would let a concurrent
    // writer interleave, then SQLITE_BUSY us mid-decrypt after the
    // ratchet had already updated its in-memory copy.
    const { db, calls } = makeStubDb();
    await runWithRatchetTxn(db, async () => undefined);
    expect(calls[0]).toBe('BEGIN IMMEDIATE');
  });

  it('returns the work result on success', async () => {
    const { db } = makeStubDb();
    const out = await runWithRatchetTxn(db, async () => ({ msg: 'hello' }));
    expect(out).toEqual({ msg: 'hello' });
  });
});

/**
 * Audit P0-1 (2026-07-09) — the M-14 coalesced status-flush transaction
 * (SqlMessageStore.upsertBatch) and the receive transaction
 * (runWithRatchetTxn) run on the SAME single SQLCipher connection. The
 * M-14 fix serialized upsertBatch against itself via a store-local
 * static mutex but NOT against the receive txn, so under a reconnect-
 * drain + markRead burst the receive `BEGIN IMMEDIATE` landed inside an
 * open flush txn, threw "cannot start a transaction within a
 * transaction", the catch-all classified it terminal, and the relay
 * ack-`discarded` — DELETED — a committed inbound message.
 *
 * These tests pin both halves of the fix over the REAL SqlMessageStore
 * and the REAL txn runner on one txn-depth-tracking stub connection:
 *   (a) upsertBatch and the receive txn serialize on ONE shared mutex —
 *       interleaving them (either order, plus a second cross-instance
 *       M-14 flush) never produces a nested BEGIN;
 *   (b) a transient LOCAL SQL failure (nested-txn / SQLITE_BUSY / disk
 *       pressure) rolls back and classifies as leave-on-relay — it must
 *       NEVER produce the `discarded` ack that destroys the message.
 */

describe('P0-1(a) — coalesced flush txn and receive txn share ONE per-connection mutex', () => {
  it('flush racing a receive txn serializes (no nested BEGIN, both commit)', async () => {
    const { calls, db } = makeTxnTrackingDb();
    const store = new SqlMessageStore(db as never);
    // Fire the flush FIRST so its BEGIN owns the connection, with the
    // receive txn immediately behind it. Pre-fix (independent mutexes)
    // the receive BEGIN IMMEDIATE landed inside the open flush txn and
    // threw — handledOk=false → ack 'discarded' → the relay destroyed a
    // committed inbound message.
    await Promise.all([
      store.upsertBatch([makeMsg('a'), makeMsg('b')]),
      runWithRatchetTxn(db, async () => {
        await db.execute('INSERT INTO sessions VALUES (?)'); // ratchet advance
        await db.execute('INSERT INTO messages VALUES (?)'); // plaintext row
      }),
    ]);
    assertSerializedTrace(calls);
    expect(calls.filter(c => /^BEGIN/i.test(c))).toHaveLength(2);
    expect(calls.filter(c => c === 'COMMIT')).toHaveLength(2);
  });

  it('receive txn racing a flush (reverse interleaving) also serializes — the status batch is not silently rolled back', async () => {
    const { calls, db } = makeTxnTrackingDb();
    const store = new SqlMessageStore(db as never);
    await Promise.all([
      runWithRatchetTxn(db, async () => {
        await db.execute('INSERT INTO sessions VALUES (?)');
        await db.execute('INSERT INTO messages VALUES (?)');
      }),
      store.upsertBatch([makeMsg('c'), makeMsg('d'), makeMsg('e')]),
    ]);
    assertSerializedTrace(calls);
    expect(calls.filter(c => c === 'COMMIT')).toHaveLength(2);
  });

  it('M-14 cross-instance flushes stay serialized too (restore-path store racing the live store + a receive txn)', async () => {
    const { calls, db } = makeTxnTrackingDb();
    const liveStore = new SqlMessageStore(db as never);
    const restoreStore = new SqlMessageStore(db as never);
    await Promise.all([
      liveStore.upsertBatch([makeMsg('f')]),
      restoreStore.upsertBatch([makeMsg('g'), makeMsg('h')]),
      runWithRatchetTxn(db, async () => {
        await db.execute('INSERT INTO sessions VALUES (?)');
      }),
    ]);
    assertSerializedTrace(calls);
    expect(calls.filter(c => /^BEGIN/i.test(c))).toHaveLength(3);
    expect(calls.filter(c => c === 'COMMIT')).toHaveLength(3);
  });

  it('flags isInsideRatchetTxn() during the flush so nested store writers (saveIdentity) skip their own BEGIN', async () => {
    const flags: boolean[] = [];
    const db = {
      async execute(sql: string): Promise<{ rows: unknown[] }> {
        // doUpsert emits `INSERT OR REPLACE INTO messages (…)`.
        if (/INTO messages/i.test(sql)) { flags.push(isInsideRatchetTxn()); }
        return { rows: [] };
      },
    };
    const store = new SqlMessageStore(db as never);
    await store.upsertBatch([makeMsg('i')]);
    expect(flags).toEqual([true]);
    expect(isInsideRatchetTxn()).toBe(false); // released after COMMIT
  });
});

describe('P0-1(b) — transient local SQL errors classify leave-on-relay, never a discarded ack', () => {
  it('a transient failure inside the receive txn rolls back and classifies leave-on-relay', async () => {
    const busy = new Error('database is locked (5) (SQLITE_BUSY)');
    const { calls, db } = makeTxnTrackingDb({ failOn: /INSERT INTO messages/, failWith: busy });
    let caught: unknown;
    try {
      await runWithRatchetTxn(db, async () => {
        await db.execute('INSERT INTO sessions VALUES (?)'); // ratchet advance
        await db.execute('INSERT INTO messages VALUES (?)'); // plaintext write hits BUSY
      });
    } catch (e) { caught = e; }
    expect(caught).toBe(busy);
    // The ratchet advance was undone — a relay redelivery decrypts clean.
    expect(calls[calls.length - 1]).toBe('ROLLBACK');
    // The ack sites consult this classifier: transient ⇒ leaveOnRelay
    // (the ack is SKIPPED — the relay keeps the envelope and redelivers).
    // Pre-fix this fell into the catch-all and acked 'discarded', telling
    // the relay to DELETE a message it still held.
    expect(isTransientSqlError(caught)).toBe(true);
  });

  it('classifies every documented transient local failure as leave-on-relay', () => {
    const transient = [
      'cannot start a transaction within a transaction', // nested-txn collision
      'database is locked (5) (SQLITE_BUSY)',
      'database table is locked',
      'SQLITE_BUSY',
      'SQLITE_LOCKED',
      'disk I/O error',
      'SQLITE_IOERR: disk I/O error',
      'database or disk is full',
      'SQLITE_FULL',
    ];
    for (const msg of transient) {
      expect(isTransientSqlError(new Error(msg))).toBe(true);
    }
  });

  it('keeps terminal message-specific failures on the discarded path', () => {
    const terminal = [
      'bad MAC',
      'sealed-sender aad mismatch',
      'sender certificate expired',
      'signature verification failed',
      'malformed envelope',
      'CryptoError: decrypt failed',
    ];
    for (const msg of terminal) {
      expect(isTransientSqlError(new Error(msg))).toBe(false);
    }
    expect(isTransientSqlError(undefined)).toBe(false);
    expect(isTransientSqlError(null)).toBe(false);
    expect(isTransientSqlError({})).toBe(false);
  });
});

describe('B-72 — saveIdentity BEGIN must ride the one per-connection txn chain', () => {
  // Field evidence (emulator-5556 logcat, 2026-07-11 00:28, rapid-send burst):
  // "[sqlMessageStore] coalesced flush failed — cannot start a transaction
  // within a transaction", repeatedly. Send-path saveIdentity (X3DH
  // processPreKey) opened a raw BEGIN IMMEDIATE outside the chain while the
  // 50ms coalesced flush ran its CHAINED BEGIN on the same connection.
  // Fix: saveIdentity's own-transaction case now queues on runWithRatchetTxn.

  /** Stub with real SQLite semantics: a second BEGIN while a txn is open throws. */
  function makeStrictTxnDb() {
    const calls: string[] = [];
    let open = false;
    const db = {
      async execute(sql: string): Promise<{rows: unknown[]}> {
        // Yield so concurrent callers interleave like op-sqlite's native dispatch.
        await Promise.resolve();
        if (/^BEGIN/i.test(sql)) {
          if (open) {
            throw new Error(
              '[op-sqlite] statement execution error: cannot start a transaction within a transaction',
            );
          }
          open = true;
        } else if (/^(COMMIT|ROLLBACK)/i.test(sql)) {
          open = false;
        }
        calls.push(sql);
        return {rows: []};
      },
    };
    return {calls, db};
  }

  it('send-path saveIdentity racing a chained flush txn does not nest BEGINs', async () => {
    const {calls, db} = makeStrictTxnDb();
    const {SqlCipherProtocolStore} = require('../crypto/sqlCipherStore') as
      typeof import('../crypto/sqlCipherStore');
    const store = new SqlCipherProtocolStore(db as never);

    // Outside-chain saveIdentity (send path) fired concurrently with a
    // chained transaction (the coalesced message flush).
    const race = Promise.all([
      store.saveIdentity('peer.1', new Uint8Array([1, 2, 3]).buffer),
      runWithRatchetTxn(db, async () => {
        await db.execute('INSERT INTO messages VALUES (?)');
      }),
    ]);
    await expect(race).resolves.toBeDefined();

    // Every BEGIN must be balanced by COMMIT/ROLLBACK before the next BEGIN.
    let depth = 0;
    for (const sql of calls) {
      if (/^BEGIN/i.test(sql)) {depth++;}
      if (/^(COMMIT|ROLLBACK)/i.test(sql)) {depth--;}
      expect(depth).toBeLessThanOrEqual(1);
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it('saveIdentity called INSIDE a chain txn runs raw (single outer BEGIN)', async () => {
    const {calls, db} = makeStrictTxnDb();
    const {SqlCipherProtocolStore} = require('../crypto/sqlCipherStore') as
      typeof import('../crypto/sqlCipherStore');
    const store = new SqlCipherProtocolStore(db as never);

    await runWithRatchetTxn(db, async () => {
      // decrypt → storeSession → saveIdentity, inside the receive txn
      await store.saveIdentity('peer.1', new Uint8Array([4, 5, 6]).buffer);
    });

    expect(calls.filter(s => /^BEGIN/i.test(s))).toHaveLength(1);
    expect(calls.filter(s => /^COMMIT/i.test(s))).toHaveLength(1);
  });
});

describe('B-75 — saveIdentity reached from runOnTxnChain work must NOT deadlock the chain', () => {
  // Field regression from the B-72 fix (commit 3ae4790): saveIdentity's
  // own-transaction case queued on runWithRatchetTxn. When reached from
  // INSIDE a runOnTxnChain body (decrypt-recovery: initOutgoingSession →
  // libsignal processPreKey → saveIdentity), it appended itself behind the
  // very chain frame awaiting it → the global txnChain froze forever,
  // stalling every later DB write (inbound persistence, coalesced flush,
  // message backup/restore). Symptom the founder reported: "backup so slow".

  /** Strict SQLite-semantics stub: a second BEGIN while one is open throws. */
  function makeStrictTxnDb() {
    const calls: string[] = [];
    let open = false;
    const db = {
      async execute(sql: string): Promise<{rows: unknown[]}> {
        await Promise.resolve();
        if (/^BEGIN/i.test(sql)) {
          if (open) {
            throw new Error(
              '[op-sqlite] statement execution error: cannot start a transaction within a transaction',
            );
          }
          open = true;
        } else if (/^(COMMIT|ROLLBACK)/i.test(sql)) {
          open = false;
        }
        calls.push(sql);
        return {rows: []};
      },
    };
    return {calls, db};
  }

  it('runOnTxnChain body that awaits saveIdentity RESOLVES (no deadlock) in ONE atomic inline txn', async () => {
    const {calls, db} = makeStrictTxnDb();
    const {SqlCipherProtocolStore} = require('../crypto/sqlCipherStore') as
      typeof import('../crypto/sqlCipherStore');
    const {runOnTxnChain} = require('../runtime/receiveTransaction') as
      typeof import('../runtime/receiveTransaction');
    const store = new SqlCipherProtocolStore(db as never);

    // Mirrors runDecryptRecovery: runOnTxnChain(() => initOutgoingSession(...))
    // whose libsignal internals await storage.saveIdentity. Pre-fix this hung.
    // (If it deadlocks, this await never settles and Jest fails on timeout.)
    const result = await runOnTxnChain(async () => {
      await store.saveIdentity('peer.1', new Uint8Array([7, 8, 9]).buffer);
      return 'recovered';
    });

    expect(result).toBe('recovered');
    // B-75 fix: context (2) opens its OWN inline BEGIN/COMMIT (atomic, exclusive)
    // — not a raw autocommit (would lose P0-S6 atomicity) and not a chain re-queue
    // (would deadlock). Exactly one balanced transaction.
    expect(calls.filter(s => /^BEGIN/i.test(s))).toHaveLength(1);
    expect(calls.filter(s => /^COMMIT/i.test(s))).toHaveLength(1);
    expect(calls[0]).toBe('BEGIN IMMEDIATE');
    expect(calls[calls.length - 1]).toBe('COMMIT');
  });

  it('wraps the trusted_identities UPSERT AND the identity_rotations INSERT in the SAME inline txn (P0-S6, key rotation)', async () => {
    // Regression for the review finding: on a key ROTATION during recovery, both
    // writes must be atomic so a crash can't desync the forensic rotation log.
    const {calls, db} = makeStrictTxnDb();
    const {SqlCipherProtocolStore} = require('../crypto/sqlCipherStore') as
      typeof import('../crypto/sqlCipherStore');
    const {runOnTxnChain} = require('../runtime/receiveTransaction') as
      typeof import('../runtime/receiveTransaction');
    // Strict stub that ALSO returns an existing (different) key for the snapshot
    // SELECT so saveIdentity sees changed===true and emits the rotation INSERT.
    let open = false;
    const rotCalls: string[] = [];
    const rotDb = {
      async execute(sql: string): Promise<{rows: unknown[]}> {
        await Promise.resolve();
        if (/^BEGIN/i.test(sql)) { if (open) {throw new Error('cannot start a transaction within a transaction');} open = true; }
        else if (/^(COMMIT|ROLLBACK)/i.test(sql)) { open = false; }
        rotCalls.push(sql);
        if (/SELECT identity_key FROM trusted_identities/i.test(sql)) {
          return {rows: [{identity_key: new Uint8Array([1, 2, 3])}]}; // differs from incoming
        }
        return {rows: []};
      },
    };
    void db; void calls;
    const store = new SqlCipherProtocolStore(rotDb as never);
    await runOnTxnChain(async () => {
      await store.saveIdentity('peer.1', new Uint8Array([9, 9, 9]).buffer); // new key ⇒ rotation
    });
    const beginIdx = rotCalls.findIndex(s => /^BEGIN/i.test(s));
    const commitIdx = rotCalls.findIndex(s => /^COMMIT/i.test(s));
    const upsertIdx = rotCalls.findIndex(s => /INSERT INTO trusted_identities/i.test(s));
    const rotationIdx = rotCalls.findIndex(s => /INSERT INTO identity_rotations/i.test(s));
    expect(beginIdx).toBe(0);
    expect(upsertIdx).toBeGreaterThan(beginIdx);
    expect(rotationIdx).toBeGreaterThan(upsertIdx);
    expect(commitIdx).toBeGreaterThan(rotationIdx); // both writes committed together
    expect(rotCalls.filter(s => /^BEGIN/i.test(s))).toHaveLength(1);
  });

  it('the chain is NOT frozen — a runWithRatchetTxn queued after recovery still runs', async () => {
    const {calls, db} = makeStrictTxnDb();
    const {SqlCipherProtocolStore} = require('../crypto/sqlCipherStore') as
      typeof import('../crypto/sqlCipherStore');
    const {runOnTxnChain} = require('../runtime/receiveTransaction') as
      typeof import('../runtime/receiveTransaction');
    const store = new SqlCipherProtocolStore(db as never);

    const recovery = runOnTxnChain(async () => {
      await store.saveIdentity('peer.1', new Uint8Array([1]).buffer);
    });
    // A normal receive txn queued right behind recovery. Pre-fix it never ran
    // because the chain was deadlocked on recovery's self-enqueued saveIdentity.
    const later = runWithRatchetTxn(db, async () => {
      await db.execute('INSERT INTO messages VALUES (?)');
    });

    await expect(Promise.all([recovery, later])).resolves.toBeDefined();
    // Two balanced txns ran in sequence — recovery's inline saveIdentity BEGIN
    // AND the later receive txn. Pre-fix the later txn never ran (chain frozen).
    expect(calls.filter(s => /^BEGIN/i.test(s))).toHaveLength(2);
    expect(calls.filter(s => /^COMMIT/i.test(s))).toHaveLength(2);
    // The last statements are the later txn — proof the chain advanced past recovery.
    expect(calls[calls.length - 1]).toBe('COMMIT');
  });

  it('isOnTxnChain() is true only while a runOnTxnChain body runs, false after', async () => {
    const {isOnTxnChain, runOnTxnChain} = require('../runtime/receiveTransaction') as
      typeof import('../runtime/receiveTransaction');
    expect(isOnTxnChain()).toBe(false);
    let insideFlag = false;
    await runOnTxnChain(async () => { insideFlag = isOnTxnChain(); });
    expect(insideFlag).toBe(true);
    expect(isOnTxnChain()).toBe(false);
  });
});

describe('B-126 — chain watchdog: a wedged frame cannot stall receive forever', () => {
  const rt = () => require('../runtime/receiveTransaction') as typeof import('../runtime/receiveTransaction');

  beforeEach(() => {
    jest.useFakeTimers();
    rt()._resetTxnChainForTests();
  });
  afterEach(() => {
    jest.useRealTimers();
    rt()._resetTxnChainForTests();
  });

  it('force-advances the chain past a never-resolving frame; later frames run', async () => {
    const {runWithRatchetTxn: runTxn, runOnTxnChain: runChain, CHAIN_FRAME_FORCE_MS, chainForcedAdvanceCount} = rt();
    const {db, calls} = makeStubDb();
    // Frame 1 wedges forever AFTER its BEGIN succeeded.
    const never = new Promise<never>(() => { /* wedged */ });
    const wedged = runTxn(db, () => never, 'wedge');
    void wedged.catch(() => undefined);
    let laterRan = false;
    const later = runChain(async () => { laterRan = true; }, 'later');
    // Before the deadline the later frame is stuck behind the wedge.
    await jest.advanceTimersByTimeAsync(CHAIN_FRAME_FORCE_MS - 1000);
    expect(laterRan).toBe(false);
    // Past the deadline the watchdog releases the tail.
    await jest.advanceTimersByTimeAsync(2000);
    await later;
    expect(laterRan).toBe(true);
    expect(chainForcedAdvanceCount()).toBe(1);
    // The watchdog rolled back the wedged frame's orphaned BEGIN so the
    // next BEGIN IMMEDIATE cannot die on the nested-txn error.
    expect(calls).toContain('ROLLBACK');
  });

  it('a later receive txn BEGINs cleanly after the force-advance rollback', async () => {
    const {runWithRatchetTxn: runTxn, CHAIN_FRAME_FORCE_MS} = rt();
    const {db, calls} = makeStubDb();
    const never = new Promise<never>(() => { /* wedged */ });
    void runTxn(db, () => never, 'wedge').catch(() => undefined);
    const later = runTxn(db, async () => 'ok', 'recv:later');
    await jest.advanceTimersByTimeAsync(CHAIN_FRAME_FORCE_MS + 1000);
    await expect(later).resolves.toBe('ok');
    // Sequence contains the watchdog ROLLBACK followed by a fresh BEGIN+COMMIT.
    const tail = calls.slice(calls.indexOf('ROLLBACK'));
    expect(tail).toEqual(['ROLLBACK', 'BEGIN IMMEDIATE', 'COMMIT']);
  });

  it('a disowned zombie frame must NOT COMMIT (it could commit a later frame\'s txn)', async () => {
    const {runWithRatchetTxn: runTxn, CHAIN_FRAME_FORCE_MS, isTransientSqlError: transient,
           onAfterCommit: queueFx, _postCommitQueueDepthForTest: depth} = rt();
    const {db, calls} = makeStubDb();
    let releaseZombie: (() => void) | null = null;
    const zombieGate = new Promise<void>(res => { releaseZombie = res; });
    const zombieFx = jest.fn();
    const zombie = runTxn(db, () => { queueFx(zombieFx); return zombieGate; }, 'zombie');
    const zombieOutcome = zombie.then(() => 'committed', e => e as Error);
    // Watchdog fires: chain advances, zombie disowned, its BEGIN rolled back.
    await jest.advanceTimersByTimeAsync(CHAIN_FRAME_FORCE_MS + 1000);
    // F5 / edge MF-2, third path — the disown DROPPED the zombie's queued
    // effect (depth 0, never fired), it did not orphan it.
    expect(depth()).toBe(0);
    expect(zombieFx).not.toHaveBeenCalled();
    // A later frame now owns a live BEGIN.
    let holdLater: (() => void) | null = null;
    const laterGate = new Promise<void>(res => { holdLater = res; });
    const later = runTxn(db, () => laterGate, 'later');
    await jest.advanceTimersByTimeAsync(10);
    // Zombie resumes mid-later-txn: it must throw the disowned marker,
    // NOT execute COMMIT/ROLLBACK on the shared connection.
    const commitsBefore = calls.filter(s => s === 'COMMIT').length;
    releaseZombie!();
    const out = await zombieOutcome;
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toMatch(/txn_frame_disowned/);
    expect(transient(out)).toBe(true); // leave-on-relay class, never ack-discard
    expect(calls.filter(s => s === 'COMMIT').length).toBe(commitsBefore);
    holdLater!();
    await later;
    // The later frame's COMMIT is the only new one.
    expect(calls[calls.length - 1]).toBe('COMMIT');
    // The later frame's commit must not resurrect the zombie's effect.
    expect(zombieFx).not.toHaveBeenCalled();
  });

  it('a nested-inline frame that wedges is DISOWNED — it must not COMMIT effect-less (critic rev-3)', async () => {
    // Rev-3 regression, caught in review: the watchdog discarded the
    // wedged frame's effects but only disowned it when _txnOpen was still
    // true. A frame whose _txnOpen was hard-falsed by a nested inline kept
    // ownership, resumed, passed the `_txnOwner !== me` check, and
    // COMMITTED with its effects already discarded — durable data, banner
    // never posted (the M16 inverse). Latent (the nesting is
    // upstream-blocked) but the failure direction must be redelivery.
    const {runWithRatchetTxn: runTxn, runRatchetTxnInline: runInline,
           CHAIN_FRAME_FORCE_MS, isTransientSqlError: transient,
           onAfterCommit: queueFx, _postCommitQueueDepthForTest: depth} = rt();
    const {db} = makeStubDb();
    const fx = jest.fn();
    let release: (() => void) | null = null;
    const gate = new Promise<void>(res => { release = res; });
    const p = runTxn(db, async () => {
      queueFx(fx);
      await runInline(db, async () => undefined); // finally hard-falses _txnOpen
      await gate;                                 // wedge
      return 'ok';
    }, 'nested-then-wedge');
    const outcome = p.then(() => 'committed', e => e as Error);
    await jest.advanceTimersByTimeAsync(CHAIN_FRAME_FORCE_MS + 1_000);
    expect(depth()).toBe(0);                      // discarded at disown
    release!();
    const out = await outcome;
    expect(out).toBeInstanceOf(Error);            // NOT 'committed'
    expect((out as Error).message).toMatch(/txn_frame_disowned/);
    expect(transient(out)).toBe(true);            // leave-on-relay → redelivery
    expect(fx).not.toHaveBeenCalled();
  });

  it("a resuming zombie must not clobber the LIVE frame's effect owner (M16, edge rev-3)", async () => {
    // Pins the `if (_effectOwner === me)` guard in the frame's finally: an
    // unconditional null there let a disowned zombie's late resume wipe the
    // LIVE frame's owner key, so that frame's next onAfterCommit ran
    // IMMEDIATELY — the banner posted BEFORE the covering COMMIT, the
    // original M16 defect. Proven load-bearing by mutation (edge).
    const {runWithRatchetTxn: runTxn, CHAIN_FRAME_FORCE_MS,
           onAfterCommit: queueFx} = rt();
    const {db} = makeStubDb();
    let releaseZombie: (() => void) | null = null;
    const zombieGate = new Promise<void>(res => { releaseZombie = res; });
    const zombie = runTxn(db, () => zombieGate, 'zombie');
    const zombieOutcome = zombie.then(() => 'committed', e => e as Error);
    await jest.advanceTimersByTimeAsync(CHAIN_FRAME_FORCE_MS + 1_000);
    const fx = jest.fn();
    const later = runTxn(db, async () => {
      // Zombie resumes and fully unwinds (its finally runs) INSIDE the
      // live frame's window…
      releaseZombie!();
      const zErr = await zombieOutcome;
      expect((zErr as Error).message).toMatch(/txn_frame_disowned/);
      // …then the live frame queues its effect: it must QUEUE under the
      // live owner, not fire immediately off a clobbered-null owner.
      queueFx(fx);
      expect(fx).not.toHaveBeenCalled();
      return 'ok';
    }, 'later');
    await jest.advanceTimersByTimeAsync(10);
    await expect(later).resolves.toBe('ok');
    expect(fx).toHaveBeenCalledTimes(1); // fired at the live frame's COMMIT
  });

  it('AUDIT #12 — assertLive kills a force-advanced frame at its next checkpoint (no zombie writes)', async () => {
    const {runWithRatchetTxn: runTxn, CHAIN_FRAME_FORCE_MS,
           isTransientSqlError: transient} = rt();
    const {db, calls} = makeStubDb();
    let release: (() => void) | null = null;
    const gate = new Promise<void>(res => { release = res; });
    const writesAfterResume: string[] = [];
    const p = runTxn(db, async (frame) => {
      await gate;                                  // wedge (the decrypt analogue)
      frame.assertLive();                          // the post-await checkpoint
      writesAfterResume.push('INSERT zombie-row'); // must be unreachable
      await db.execute('INSERT zombie-row');
      return 'ok';
    }, 'recv:zombie12');
    const outcome = p.then(() => 'committed', e => e as Error);
    await jest.advanceTimersByTimeAsync(CHAIN_FRAME_FORCE_MS + 1_000); // disowned
    release!();
    const out = await outcome;
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toMatch(/txn_frame_disowned/);
    expect(transient(out)).toBe(true);             // leave-on-relay → redelivery
    expect(writesAfterResume).toEqual([]);         // the write never happened
    expect(calls.filter(s => /zombie-row/.test(s))).toEqual([]);
  });

  it('AUDIT #12 sibling — a wedged INLINE txn is rolled back by the watchdog; the chain survives', async () => {
    const {runOnTxnChain, runRatchetTxnInline: runInline, runWithRatchetTxn: runTxn,
           CHAIN_FRAME_FORCE_MS, isTransientSqlError: transient} = rt();
    const {db, calls} = makeStubDb();
    let release: (() => void) | null = null;
    const gate = new Promise<void>(res => { release = res; });
    // The production shape: decrypt-recovery runs on the chain, and
    // saveIdentity opens an inline txn inside it (B-75).
    const p = runOnTxnChain(() => runInline(db, () => gate), 'recovery:wedged');
    const outcome = p.then(() => 'committed', e => e as Error);
    await jest.advanceTimersByTimeAsync(CHAIN_FRAME_FORCE_MS + 1_000);
    // Pre-fix: the inline set _txnOpen but never openTxnDb, so the
    // watchdog's rollback guard could never fire — the BEGIN stayed open
    // and EVERY later frame died on "cannot start a transaction within a
    // transaction", permanently. Now the watchdog rolled it back:
    await Promise.resolve();
    expect(calls.filter(s => s === 'ROLLBACK').length).toBe(1);
    // …and a later frame BEGINs and COMMITs cleanly.
    await expect(runTxn(db, async () => 'alive', 'recv:after-inline')).resolves.toBe('alive');
    // The wedged inline finally resumes: it must throw the TRANSIENT
    // disowned marker, never attempt the unclassified "cannot commit"
    // COMMIT — and its catch must NOT issue a rollback that could abort
    // a later frame's live txn (still exactly one ROLLBACK total).
    release!();
    const out = await outcome;
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toMatch(/txn_frame_disowned/);
    expect(transient(out)).toBe(true);
    expect(calls.filter(s => s === 'ROLLBACK').length).toBe(1);
    expect(calls.filter(s => s === 'COMMIT').length).toBe(1); // the later frame's only
  });

  it('AUDIT #12 ALIASING — a resumed inline must not COMMIT a later frame\'s OPEN txn (nonce, not handle)', async () => {
    // Every frame shares the ONE db object, so `openTxnDb === db` is true
    // again the moment a later frame BEGINs. A handle-compare intervention
    // check would pass, and the resumed inline's COMMIT would commit the
    // LATER frame's half-done transaction. The nonce compare cannot alias.
    const {runOnTxnChain, runRatchetTxnInline: runInline, runWithRatchetTxn: runTxn,
           CHAIN_FRAME_FORCE_MS, onAfterCommit: queueFx} = rt();
    const {db, calls} = makeStubDb();
    let releaseInline: (() => void) | null = null;
    const inlineGate = new Promise<void>(res => { releaseInline = res; });
    const p = runOnTxnChain(() => runInline(db, () => inlineGate), 'recovery:aliased');
    const outcome = p.then(() => 'committed', e => e as Error);
    await jest.advanceTimersByTimeAsync(CHAIN_FRAME_FORCE_MS + 1_000); // watchdog rolls inline back

    // A later frame opens its BEGIN and PARKS — its txn is LIVE when the
    // wedged inline resumes.
    let holdLater: (() => void) | null = null;
    const laterGate = new Promise<void>(res => { holdLater = res; });
    const fx = jest.fn();
    const later = runTxn(db, async () => {
      await laterGate;
      // The resumed inline's finally must not have clobbered OUR open-txn
      // state either: this effect must QUEUE (M16), not fire immediately
      // off a falsed _txnOpen.
      queueFx(fx);
      expect(fx).not.toHaveBeenCalled();
      return 'ok';
    }, 'recv:later-open');
    await jest.advanceTimersByTimeAsync(10);
    const commitsBefore = calls.filter(s => s === 'COMMIT').length;

    releaseInline!();                            // inline resumes mid-later-txn
    const out = await outcome;
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toMatch(/txn_frame_disowned/);
    // The resumed inline issued NOTHING on the shared connection:
    expect(calls.filter(s => s === 'COMMIT').length).toBe(commitsBefore);
    expect(calls.filter(s => s === 'ROLLBACK').length).toBe(1); // the watchdog's only

    holdLater!();                                // the later frame finishes ITS txn
    await expect(later).resolves.toBe('ok');
    expect(calls[calls.length - 1]).toBe('COMMIT'); // exactly the later frame's
    expect(fx).toHaveBeenCalledTimes(1);         // fired at the later COMMIT, once
  });

  it('AUDIT #12 — a never-resuming wedged INLINE\'s queued effects are dropped at the watchdog (critic)', async () => {
    const {runOnTxnChain, runRatchetTxnInline: runInline, CHAIN_FRAME_FORCE_MS,
           onAfterCommit: queueFx, _postCommitQueueDepthForTest: depth} = rt();
    const {db} = makeStubDb();
    const fx = jest.fn();
    const gate = new Promise<void>(() => { /* never resolves — true zombie */ });
    void runOnTxnChain(() => runInline(db, async () => {
      queueFx(fx);       // queued under the inline's owner token
      await gate;
    }), 'recovery:never-resumes').catch(() => undefined);
    await jest.advanceTimersByTimeAsync(CHAIN_FRAME_FORCE_MS + 1_000);
    // The inline never resumes, so its own catch-side discard never runs —
    // the watchdog must drop the entries at disown time or they leak for
    // the process lifetime.
    expect(depth()).toBe(0);
    expect(fx).not.toHaveBeenCalled();
  });

  it('AUDIT #13 MECHANISM — isInsideRatchetTxn is a TIME WINDOW, not a stack identity (edge F6)', async () => {
    // Pins WHY the write-through subscriber must never use module txn
    // state as its delta discriminator: an unrelated task interleaved
    // into the txn's await window observes isInsideRatchetTxn() === true
    // — a user send's append would have been wrongly suppressed and its
    // bubble lost on restart. The precise discriminator is the SYNC
    // bracket in messengerStore (runWriteThroughSuppressed).
    const {runWithRatchetTxn: runTxn, isInsideRatchetTxn: isInsideTxnNow} = rt();
    const {db} = makeStubDb();
    let release: (() => void) | null = null;
    const gate = new Promise<void>(res => { release = res; });
    const p = runTxn(db, async () => { await gate; return 'ok'; }, 'recv:parked');
    await jest.advanceTimersByTimeAsync(1);
    // The txn is parked on an await — an INTERLEAVED stack still sees true:
    expect(isInsideTxnNow()).toBe(true);
    release!();
    await expect(p).resolves.toBe('ok');
    // …and post-settle it is false again (post-commit effects, e.g. the
    // background notifier's store writes, must write through normally).
    expect(isInsideTxnNow()).toBe(false);
  });

  it('AUDIT #13 MECHANISM — the sync bracket is scoped to its callback only (no await-window bleed)', () => {
    const {runWriteThroughSuppressed, isWriteThroughSuppressedNow} =

      require('../store/messengerStore') as typeof import('../store/messengerStore');
    expect(isWriteThroughSuppressedNow()).toBe(false);
    const seen: boolean[] = [];
    runWriteThroughSuppressed(() => {
      seen.push(isWriteThroughSuppressedNow());          // true inside
      runWriteThroughSuppressed(() => {
        seen.push(isWriteThroughSuppressedNow());        // depth handles nesting
      });
      seen.push(isWriteThroughSuppressedNow());          // still true after nested exit
    });
    seen.push(isWriteThroughSuppressedNow());            // false outside
    expect(seen).toEqual([true, true, true, false]);
    // A throw inside the bracket must not leak the flag.
    expect(() => runWriteThroughSuppressed(() => { throw new Error('x'); })).toThrow('x');
    expect(isWriteThroughSuppressedNow()).toBe(false);
  });

  it('healthy frames never trip the watchdog', async () => {
    const {runWithRatchetTxn: runTxn, chainForcedAdvanceCount, CHAIN_FRAME_FORCE_MS} = rt();
    const {db} = makeStubDb();
    await runTxn(db, async () => 'a', 'recv:a');
    await runTxn(db, async () => 'b', 'recv:b');
    await jest.advanceTimersByTimeAsync(CHAIN_FRAME_FORCE_MS * 2);
    expect(chainForcedAdvanceCount()).toBe(0);
  });
});

// ─── AUDIT-2026-08-13 F5 — owner-keyed post-commit effects ────────────────
//
// The unkeyed queue had two defects: a later frame's rollback could discard
// (or its commit fire) entries a DIFFERENT owner had queued — cross-frame
// inheritance/destruction, not same-moment attribution (critic) — and an
// effect queued during runRatchetTxnInline was NEVER drained — the inline
// path had no drain and the next frame's wholesale reset silently dropped a
// COMMITTED effect.
describe('AUDIT F5 — onAfterCommit is keyed to the owning transaction', () => {

  const {onAfterCommit, runRatchetTxnInline} = require('../runtime/receiveTransaction');

  // Edge rev-3: without this reset, the drain-removal mutant was killed
  // only by CROSS-TEST leakage (order-dependent — `it.only` let it
  // survive). Each test starts with an empty queue; the in-test depth
  // assertions below are the isolated kills.
  beforeEach(() => {
    (require('../runtime/receiveTransaction') as
      typeof import('../runtime/receiveTransaction'))._resetTxnChainForTests();
  });

  it('outside any txn the effect runs immediately', () => {
    const fx = jest.fn();
    onAfterCommit(fx);
    expect(fx).toHaveBeenCalledTimes(1);
  });

  it('frame commit runs the effect exactly once; rollback never runs it', async () => {
    const {db} = makeStubDb();
    const committed = jest.fn();
    await runWithRatchetTxn(db, async () => { onAfterCommit(committed); }, 'f5:ok');
    expect(committed).toHaveBeenCalledTimes(1);

    const discarded = jest.fn();
    await expect(runWithRatchetTxn(db, async () => {
      onAfterCommit(discarded);
      throw new Error('boom');
    }, 'f5:rollback')).rejects.toThrow('boom');
    expect(discarded).not.toHaveBeenCalled();
    // Edge MF-2 — "not called" passes on a LEAK too (discarded and orphaned
    // look identical from outside). Depth pins the actual discard: a no-op'd
    // discardPostCommit ran the full suite green before this line existed.
    const {_postCommitQueueDepthForTest} = require('../runtime/receiveTransaction');
    expect(_postCommitQueueDepthForTest()).toBe(0);
  });

  it('THE DROPPED-EFFECT BUG, pinned: an inline-txn effect fires at the INLINE commit', async () => {
    // Pre-fix: this effect sat in the global queue, the inline commit never
    // drained, and the next frame reset the queue — a committed effect
    // silently vanished.
    const {db} = makeStubDb();
    const fx = jest.fn();
    await runRatchetTxnInline(db, async () => { onAfterCommit(fx); });
    expect(fx).toHaveBeenCalledTimes(1);
    // Edge rev-3 — the drain must REMOVE what it ran, not just run it: a
    // drain that kept its entries survived every other test in isolation.
    const {_postCommitQueueDepthForTest} = require('../runtime/receiveTransaction');
    expect(_postCommitQueueDepthForTest()).toBe(0);

    // …and a later frame neither re-fires nor inherits anything.
    await runWithRatchetTxn(db, async () => undefined, 'f5:later');
    expect(fx).toHaveBeenCalledTimes(1);
  });

  it('inline rollback discards ONLY the inline effects', async () => {
    const {db} = makeStubDb();
    const fx = jest.fn();
    await expect(runRatchetTxnInline(db, async () => {
      onAfterCommit(fx);
      throw new Error('inline-boom');
    })).rejects.toThrow('inline-boom');
    expect(fx).not.toHaveBeenCalled();
    const {_postCommitQueueDepthForTest} = require('../runtime/receiveTransaction');
    expect(_postCommitQueueDepthForTest()).toBe(0); // discarded, not orphaned (edge MF-2)
  });

  it('IN-FLIGHT COMMIT vs watchdog disown: a committed frame STILL fires its effects (critic rev-2)', async () => {
    // The rev-1 discard-at-disown raced an in-flight COMMIT: the frame had
    // passed its ownership guard and issued COMMIT (SQLite completes it),
    // then found its entries deleted — data durable, banner never posted
    // (the M16 inverse). The fix splices the frame's entries into a local
    // array BEFORE COMMIT, out of the discard's reach.
    jest.useFakeTimers();
    try {
      const rtx = require('../runtime/receiveTransaction');
      rtx._resetTxnChainForTests();
      let releaseCommit!: () => void;
      const commitGate = new Promise<void>(r => { releaseCommit = r; });
      const db = {
        async execute(sql: string): Promise<unknown> {
          if (sql === 'COMMIT') {await commitGate;}
          return undefined;
        },
      };
      const fx = jest.fn();
      const p = rtx.runWithRatchetTxn(db, async () => { rtx.onAfterCommit(fx); return 'ok'; }, 'f5:inflight');
      await jest.advanceTimersByTimeAsync(1);                 // BEGIN + work + COMMIT issued
      // No `??` fallback (critic): a renamed export would silently advance
      // 31s, the watchdog would never fire, and this race would go
      // unexercised while green.
      await jest.advanceTimersByTimeAsync(rtx.CHAIN_FRAME_FORCE_MS + 1_000); // watchdog disowns mid-COMMIT
      releaseCommit();
      await p;                                                // COMMIT completed — data durable
      expect(fx).toHaveBeenCalledTimes(1);                    // the effect MUST fire
    } finally {
      jest.useRealTimers();
    }
  });
});

// ─── AUDIT-2026-08-13 #18 — the transient classifier CONTRACT ─────────────
describe('AUDIT #18 — every TRANSIENT_SQL_ERROR_RE alternate is behaviorally asserted', () => {
  // The classifier is a cross-package string match; an alternate that
  // drifts out of the regex silently converts a transient local failure
  // into ack-`discarded` (relay hard-delete). Each alternate gets a case
  // here so a regex edit that drops one goes RED, and the deliberate
  // TERMINAL cases are locked so a "helpful" widening goes RED too.

  const {isTransientSqlError: classifyTransient} = require('../runtime/receiveTransaction') as
    typeof import('../runtime/receiveTransaction');

  it('classifies every transient alternate as leave-on-relay', () => {
    for (const msg of [
      'cannot start a transaction within a transaction',
      'database is locked',
      'database table is locked',
      'SQLITE_BUSY: database busy',
      'SQLITE_LOCKED',
      'disk i/o error',
      'SQLITE_IOERR: some io failure',
      'database or disk is full',
      'SQLITE_FULL',
      'txn_frame_disowned: watchdog force-advanced past this frame (B-126)',
      'db_closed: execute after close (late writer — see AUDIT #11)',
    ]) {
      expect(`${msg} → ${classifyTransient(new Error(msg))}`).toBe(`${msg} → true`);
    }
  });

  it('keeps the DELIBERATE terminal cases terminal', () => {
    for (const msg of [
      // #14 — an envelope-unique collision means the seen-gate failed and
      // the row already exists: destroying the DUP envelope is correct.
      'UNIQUE constraint failed: messages.envelope_id',
      "UNIQUE constraint failed: index 'idx_messages_envelope_unique'",
      // The audit's own catch-all example — a genuinely unknown throw
      // stays a destroy decision (the exit-census taxonomy owns it).
      'some completely novel failure',
      'no such table: messages',
    ]) {
      expect(`${msg} → ${classifyTransient(new Error(msg))}`).toBe(`${msg} → false`);
    }
    expect(classifyTransient(null)).toBe(false);
    expect(classifyTransient(undefined)).toBe(false);
    // Unlike isTransientCertError (Error-instance only), this classifier
    // runs String(err) for non-Errors — a layer that THROWS a bare string
    // still classifies. Documented contract, not an accident.
    expect(classifyTransient('database is locked')).toBe(true);
  });
});

// ─── AUDIT-2026-08-13 #12 — zombie-write checkpoints are THREADED ─────────
describe('AUDIT #12 — the checkpoint call sites actually feed the frame (static pins)', () => {
  const {readFileSync: rf12} = require('node:fs');
  const {join: j12} = require('node:path');
  const lineStart = (body: string, prefix: string): number =>
    body.split(/\r?\n/).filter(l => l.trim().startsWith(prefix)).length;

  it('doHandleIncoming: the post-decrypt checkpoint sits between decrypt success and markSeen', () => {
    const src = rf12(j12(__dirname, '..', 'runtime', 'productionRuntime.ts'), 'utf8');
    // The receive txn passes the frame through… F-0 (B-693) re-point: the
    // single-line closure became a stamped block (chainWait/txn probes), but
    // the CONTRACT is unchanged — the work closure takes the frame and feeds
    // it to doHandleIncoming. Same pin, new anchor.
    expect(lineStart(src, 'post = await runWithRatchetTxn(txnDb, async (frame) => {')).toBe(1);
    const txnAt = src.indexOf('post = await runWithRatchetTxn(txnDb, async (frame) => {');
    const txnBody = src.slice(txnAt, src.indexOf('`recv:${', txnAt));
    expect(txnBody).toContain('await doHandleIncoming(');
    expect(lineStart(txnBody, 'frame, ')).toBe(1);
    // …and the checkpoint guards the FIRST post-wedge write (markSeen).
    const anchor = src.indexOf('rememberSuccessfulDecrypt(peer);');
    expect(anchor).toBeGreaterThan(-1);
    const window = src.slice(anchor, src.indexOf('await seenEnvelopes.markSeen(envelopeId);', anchor));
    expect(lineStart(window, 'frame?.assertLive();')).toBe(1);
  });

  it('stashReplay: every awaited write cluster is checkpointed', () => {
    const src = rf12(j12(__dirname, '..', 'runtime', 'productionRuntime.ts'), 'utf8');
    const at = src.indexOf('await runWithRatchetTxn(txnDb, async (frame) => {');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('stashReplay:', at));
    expect(lineStart(body, 'frame.assertLive();')).toBe(3);
  });

  it('EVERY stash / placeholder / pending-drain write site in doHandleIncoming is checkpoint-guarded (edge rev-1)', () => {
    // The census decays by count, not presence (edge): walk every
    // occurrence of the three destructive write shapes and require a
    // line-start checkpoint within the preceding window. The stash sites
    // are the worst class — the stash row is the ONLY surviving copy
    // (stashing ACKs the relay), so a stray INSERT in a later frame's
    // rolled-back txn is permanent group-message loss.
    const src = rf12(j12(__dirname, '..', 'runtime', 'productionRuntime.ts'), 'utf8');
    const fnStart = src.indexOf('async function doHandleIncoming(');
    expect(fnStart).toBeGreaterThan(-1);
    const body = src.slice(fnStart);
    const guarded = (preceding: string): boolean =>
      preceding.split(/\r?\n/).some(l => {
        const t = l.trim();
        return t.startsWith('frame?.assertLive();') || t.startsWith('frame.assertLive();');
      });
    const SITES: Array<[string, number]> = [
      ['await pendingGroupEnvelopes.stash({', 2],
      ['{await sqlMessages.upsert(placeholder);}', 2],
      ['await drainPendingReactionsFor(', 3],
    ];
    for (const [site, expectedCount] of SITES) {
      let idx = body.indexOf(site);
      let found = 0;
      while (idx !== -1) {
        found += 1;
        const ok = guarded(body.slice(Math.max(0, idx - 700), idx));
        expect(`${site} #${found} guarded: ${ok}`).toBe(`${site} #${found} guarded: true`);
        idx = body.indexOf(site, idx + 1);
      }
      expect(`${site} count: ${found}`).toBe(`${site} count: ${expectedCount}`);
    }
  });

  it('writeRows (statusFlush) checkpoints per row; saveIdentity before its second write', () => {
    const store = rf12(j12(__dirname, '..', 'store', 'sqlMessageStore.ts'), 'utf8');
    expect(lineStart(store, 'frame?.assertLive();')).toBe(1);
    expect(lineStart(store, 'return runWithRatchetTxn(this.db, (frame) => this.writeRows(messages, frame)')).toBe(1);
    const cipher = rf12(j12(__dirname, '..', 'crypto', 'sqlCipherStore.ts'), 'utf8');
    expect(lineStart(cipher, 'frame?.assertLive();')).toBe(1);
  });
});

// ─── AUDIT-2026-08-13 F9 — raw BEGIN budget ───────────────────────────────
//
// Two multi-statement writes deliberately bypass the txn chain and are safe
// BY TIMING ONLY (each runs before any concurrent chain user exists, or
// inside an exclusively-held chain frame). That safety argument is fragile
// prose — so pin the exact budget: any NEW raw `execute('BEGIN')` outside
// this file must justify itself here or route through the chain.
// SHIP DEPENDENCY (edge MF-1): this two-site budget holds only ON TOP OF
// the audit-#7 tombstone conversion — at pre-#7 HEAD the dead fork
// crypto/identity.ts carried a THIRD raw BEGIN (it is the WALK test below
// that goes RED there, so this note covers the whole describe — edge).
// Items #6 and #7 must land in the same commit or this suite is RED
// between them.
describe('AUDIT F9 — no new raw BEGINs outside the txn chain', () => {
  const {readFileSync: rf} = require('node:fs');
  const {join: j} = require('node:path');
  const ROOT = j(__dirname, '..', '..', '..', '..');

  it('exactly the two known timing-safe sites exist, each with its rationale', () => {
    const sites = [
      {file: 'src/modules/messenger/backup/identityBackup.ts',  budget: 1},
      {file: 'packages/messenger-core/src/crypto/identity.ts',  budget: 1},
    ];
    for (const {file, budget} of sites) {
      const src = rf(j(ROOT, file), 'utf8');
      // Case-insensitive (edge): `execute('begin')` is a free style choice
      // and must not evade; the IMMEDIATE exclusion inherits the flag.
      const RE = /execute\(\s*['"`]\s*BEGIN\b(?!\s+IMMEDIATE)/gi;
      let n = 0;
      let m: RegExpExecArray | null;
      while ((m = RE.exec(src)) !== null) {
        n += 1;
        // SITE-scoped, not file-scoped (critic): the back-reference must sit
        // WITH the raw BEGIN it justifies — a marker 300 lines away is the
        // exact anti-pattern CLAUDE.md bans. 1200 chars ≈ the full rationale
        // block plus the bracket preamble.
        const preceding = src.slice(Math.max(0, m.index - 1200), m.index);
        expect(`${file}@${m.index} has adjacent AUDIT F9: ${preceding.includes('AUDIT F9')}`)
          .toBe(`${file}@${m.index} has adjacent AUDIT F9: true`);
      }
      expect(`${file}: ${n}`).toBe(`${file}: ${budget}`);
    }
  });

  it('no OTHER production file issues a raw BEGIN (repo scan, pure Node)', () => {
    const {readdirSync, statSync} = require('node:fs');
    // Quote-agnostic + variant-proof (critic + edge): BEGIN TRANSACTION /
    // BEGIN EXCLUSIVE are semantically identical raw begins and must not
    // evade. BEGIN IMMEDIATE (the chain's own form) is excluded.
    const NEEDLE = /execute\(\s*['"`]\s*BEGIN\b(?!\s+IMMEDIATE)/i;
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = j(dir, name);
        if (statSync(p).isDirectory()) {
          if (name === '__tests__' || name === 'node_modules') {continue;}
          walk(p);
        } else if (name.endsWith('.ts') && NEEDLE.test(rf(p, 'utf8'))) {
          // path.relative: worktree-safe and repo-rename-safe (an indexOf on
          // the repo folder name broke inside .claude/worktrees — critic).
          hits.push(require('node:path').relative(ROOT, p).split(require('node:path').sep).join('/'));
        }
      }
    };
    walk(j(ROOT, 'src', 'modules', 'messenger'));
    walk(j(ROOT, 'packages', 'messenger-core', 'src'));
    expect(hits.sort()).toEqual([
      'packages/messenger-core/src/crypto/identity.ts',
      'src/modules/messenger/backup/identityBackup.ts',
    ]);
  });
});

describe('F-0 (B-693) — chainPendingCount gauges running + queued frames', () => {
  // The [recv.total] probe samples this at frame arrival; a counter that
  // silently sticks (or never rises) turns qdepth into noise, so both
  // directions are asserted: a deleted increment fails the mid-flight
  // expectation, a deleted decrement fails the drained-to-zero one.
  const rtx = () => require('../runtime/receiveTransaction') as
    typeof import('../runtime/receiveTransaction');

  beforeEach(() => {
    rtx()._resetTxnChainForTests();
  });

  it('rises while frames run/queue and drains back to 0 when they settle', async () => {
    const {runOnTxnChain, chainPendingCount} = rtx();
    expect(chainPendingCount()).toBe(0);
    let release!: () => void;
    const gate = new Promise<void>(r => {release = r;});
    const p1 = runOnTxnChain(async () => {await gate;}, 'b693-probe-1');
    const p2 = runOnTxnChain(async () => undefined, 'b693-probe-2');
    // One frame running (parked on the gate), one queued behind it.
    expect(chainPendingCount()).toBe(2);
    release();
    await p1;
    await p2;
    // The decrement rides the settle hook one microtask after each frame
    // resolves — flush the macrotask queue before asserting drained.
    await new Promise(r => setTimeout(r, 0));
    expect(chainPendingCount()).toBe(0);
  });

  it('a throwing frame still decrements — a failed decrypt must not inflate qdepth forever', async () => {
    const {runOnTxnChain, chainPendingCount} = rtx();
    const boom = new Error('boom');
    await expect(runOnTxnChain(async () => {throw boom;}, 'b693-probe-3')).rejects.toBe(boom);
    await new Promise(r => setTimeout(r, 0));
    expect(chainPendingCount()).toBe(0);
  });

  it('runWithRatchetTxn frames count too — the gauge covers BOTH chain entry points', async () => {
    const {runWithRatchetTxn: runTxn, chainPendingCount} = rtx();
    const db = {async execute(): Promise<unknown> {return undefined;}};
    let release!: () => void;
    const gate = new Promise<void>(r => {release = r;});
    const p = runTxn(db, async () => {await gate;}, 'b693-probe-4');
    expect(chainPendingCount()).toBe(1);
    release();
    await p;
    await new Promise(r => setTimeout(r, 0));
    expect(chainPendingCount()).toBe(0);
  });
});

/**
 * B-703 MR-7 / MESSAGE_LOOP M9 — the missing half of the effect pair.
 *
 * `onAfterCommit` defers a visible effect until the data is durable. Nothing
 * deferred a COMPENSATION until we knew it was not: the receive path writes the
 * row to Zustand and to SQL inside one transaction, and a ROLLBACK only took
 * the SQL half back. The bubble survived, the envelope was acked 'discarded',
 * the server emitted `envelope.undeliverable`, and the sender's zero-tap
 * auto-resend put the same message on the recipient's screen a second time.
 */
describe('B-703 MR-7 — onRollback compensations', () => {
  const {onRollback, onAfterCommit, _compensationQueueDepthForTest} =
    require('../runtime/receiveTransaction') as typeof import('../runtime/receiveTransaction');

  function stub() {
    const calls: string[] = [];
    return {calls, db: {async execute(sql: string) { calls.push(sql); return undefined; }}};
  }

  it('runs the compensation when the transaction ROLLS BACK', async () => {
    const {db} = stub();
    const undone: string[] = [];
    await expect(runWithRatchetTxn(db, async () => {
      onRollback(() => undone.push('row-1'));
      throw new Error('non-transient');
    })).rejects.toThrow('non-transient');

    expect(undone).toEqual(['row-1']);
    expect(_compensationQueueDepthForTest()).toBe(0);
  });

  it('does NOT run it when the transaction COMMITs — and leaks nothing', async () => {
    const {db} = stub();
    const undone: string[] = [];
    await runWithRatchetTxn(db, async () => { onRollback(() => undone.push('row-1')); });

    expect(undone).toEqual([]);
    expect(_compensationQueueDepthForTest()).toBe(0);
  });

  it('is a NO-OP outside a transaction — there is nothing to undo', () => {
    const undone: string[] = [];
    onRollback(() => undone.push('row-1'));
    // The asymmetry with onAfterCommit is deliberate: running eagerly here
    // would delete the row the caller just wrote.
    expect(undone).toEqual([]);
    expect(_compensationQueueDepthForTest()).toBe(0);
  });

  it('one throwing compensation does not strand the others, nor replace the failure', async () => {
    const {db} = stub();
    const undone: string[] = [];
    await expect(runWithRatchetTxn(db, async () => {
      onRollback(() => { throw new Error('compensation blew up'); });
      onRollback(() => undone.push('row-2'));
      throw new Error('original');
    })).rejects.toThrow('original');

    expect(undone).toEqual(['row-2']);
    expect(_compensationQueueDepthForTest()).toBe(0);
  });

  it('is owner-keyed: one frame\'s rollback cannot fire another frame\'s compensation', async () => {
    const {db} = stub();
    const undone: string[] = [];
    await runWithRatchetTxn(db, async () => { onRollback(() => undone.push('committed-frame')); });
    await expect(runWithRatchetTxn(db, async () => {
      onRollback(() => undone.push('rolled-back-frame'));
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(undone).toEqual(['rolled-back-frame']);
  });

  it('commit and rollback effects stay independent', async () => {
    const {db} = stub();
    const seen: string[] = [];
    await runWithRatchetTxn(db, async () => {
      onAfterCommit(() => seen.push('commit'));
      onRollback(() => seen.push('rollback'));
    });
    expect(seen).toEqual(['commit']);
  });
});
