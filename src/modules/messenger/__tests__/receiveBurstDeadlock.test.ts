/**
 * sqa.md bug register — this suite pins: B-140.
 *
 * B-140 (second AB-BA lock inversion, same class as B-130 — receive took txn-chain then
 * session-lock while send took session-lock then txn-chain) is pinned by "M14 pair 2: the
 * send path takes the txn chain BEFORE the session lock" and "M14 pair 2: the network fetch
 * stays OUTSIDE the chain" (holding the chain across a bundle fetch would trade the
 * deadlock for a stall).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import { makeMsg, makeTxnTrackingDb, assertSerializedTrace } from './txnTrackingDb';

/**
 * B-130 — burst of messages silently stops the receiver, permanently.
 *
 * REPORTED: "Send 4-6 messages very quickly. The receiving phone processes the
 * first 1-2, then gets stuck while saving one message to its database.
 * Everything behind it stops. No crash, no error. The rest stay on the server
 * and are not delivered until the app is restarted."
 *
 * ROOT CAUSE — an AB-BA lock-order inversion between the only two write
 * mutexes on the single SQLCipher connection:
 *
 *   Lock A = `txnChain`   (receiveTransaction.ts) — global, one open txn at a time
 *   Lock B = `chains`     (sqlMessageStore.ts)    — per-conversation write order
 *
 *   RECEIVE takes A then B:
 *     runWithRatchetTxn(...)            <- A held for the whole receive
 *       -> doHandleIncoming
 *         -> await sqlMessages.upsert() -> chainOp   <- waits on B
 *
 *   COALESCED FLUSH took B then A:
 *     setTimeout(50ms)
 *       -> chainOp(cid, ...)            <- B claimed SYNCHRONOUSLY
 *         -> upsertBatch -> runWithRatchetTxn        <- waits on A
 *
 * Circular wait. Nothing throws, so the receive txn's `await work()` never
 * settles: COMMIT never runs, ROLLBACK never runs, the `finally` that clears
 * the open-txn flag never runs. `txnChain` is dead for the process lifetime,
 * every later receive parks behind it, and because the relay ack happens
 * strictly AFTER the receive resolves, the envelopes are never acked and sit on
 * the relay until a restart. That is the reported symptom, exactly.
 *
 * WHY A BURST: frames dispatch fire-and-forget with no concurrency cap, so N
 * envelopes keep lock A continuously busy — which is what lets a 50ms timer
 * land INSIDE an open transaction. With 1-2 messages A is idle in between and
 * the flush commits harmlessly. That is why "the first 1-2" arrive.
 *
 * WHAT ARMS THE TIMER (this cost the original diagnosis a wrong turn): NOT
 * appendMessage. A new inbound row takes the write-through subscriber's INSERT
 * branch -> `store.upsert()`, which touches lock B only and cannot invert. The
 * coalesce timer is armed ONLY by an UPDATE to an EXISTING row —
 * dominantly markRead flipping delivered -> read while the chat is open and
 * focused. So these tests arm it with `upsertCoalesced`, never with appends.
 *
 * FIX: the flush keeps lock B (that ordering is load-bearing — see the last
 * test) and no longer reaches for lock A; it writes rows raw via `writeRows`.
 *
 * Own file + jest.resetModules() per test ON PURPOSE: `txnChain` is
 * module-level, so a regression here would otherwise wedge every test declared
 * after it and surface as an unrelated timeout.
 */

const DEADLOCK = 'DEADLOCK';

/** Resolve 'DEADLOCK' rather than hang, so a regression is a readable diff. */
function withDeadlockGuard<T>(p: Promise<T>, ms = 2000): Promise<T | typeof DEADLOCK> {
  return Promise.race([
    p,
    new Promise<typeof DEADLOCK>(r => setTimeout(() => r(DEADLOCK), ms)),
  ]);
}

function freshModules() {
  jest.resetModules();
  // Both must come from the SAME fresh registry: sqlMessageStore imports
  // runWithRatchetTxn at module scope, so a mismatched pair would chain on two
  // different txnChains and the deadlock could not form (nor be proven gone).
  const { runWithRatchetTxn } = require('../runtime/receiveTransaction') as typeof import('../runtime/receiveTransaction');
  const { SqlMessageStore } = require('../store/sqlMessageStore') as typeof import('../store/sqlMessageStore');
  return { runWithRatchetTxn, SqlMessageStore };
}

describe('B-130 — a message burst must not deadlock the receive pipeline', () => {
  it('a receive txn writing the SAME conversation while a coalesced flush is armed still COMMITs', async () => {
    const { runWithRatchetTxn, SqlMessageStore } = freshModules();
    const { calls, db } = makeTxnTrackingDb();
    const store = new SqlMessageStore(db as never);

    // Arm the 50ms coalesce timer the way a markRead status flip does.
    store.upsertCoalesced(makeMsg('m-read', 'c1', { status: 'read' }));

    // A receive whose body outlives the coalesce window (decrypt + cert verify
    // are hundreds of ms in reality) and then persists a row on that same
    // conversation from INSIDE the open transaction.
    const receive = runWithRatchetTxn(db, async () => {
      await new Promise(r => setTimeout(r, 120));
      await store.upsert(makeMsg('m-in', 'c1'));
    });

    await expect(withDeadlockGuard(receive.then(() => 'committed'))).resolves.toBe('committed');
    assertSerializedTrace(calls);
  });

  it('a 6-message burst all lands — none is stranded behind the flush', async () => {
    const { runWithRatchetTxn, SqlMessageStore } = freshModules();
    const { calls, db } = makeTxnTrackingDb();
    const store = new SqlMessageStore(db as never);
    const settled: string[] = [];

    // The burst keeps lock A continuously busy, which is what lets the timer
    // fire inside an open txn.
    const burst = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map((id, i) =>
      runWithRatchetTxn(db, async () => {
        // A read receipt for the messages already on screen — the real igniter,
        // re-armed as each new message arrives.
        if (i === 1) {store.upsertCoalesced(makeMsg('m-read', 'c1', { status: 'read' }));}
        await new Promise(r => setTimeout(r, 20));
        await store.upsert(makeMsg(id, 'c1'));
      }).then(() => {settled.push(id);}),
    );

    await withDeadlockGuard(Promise.all(burst), 4000);

    // Pre-fix this is ["m1","m2"] — the reported "only the first 1-2 arrive".
    expect(settled).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    assertSerializedTrace(calls);
  });

  it('the chain is not poisoned — a receive queued AFTER the stall still runs', async () => {
    // This is the "and it never recovers until restart" half of the report:
    // a wedged txnChain blocks every later receive, forever.
    const { runWithRatchetTxn, SqlMessageStore } = freshModules();
    const { calls, db } = makeTxnTrackingDb();
    const store = new SqlMessageStore(db as never);

    store.upsertCoalesced(makeMsg('m-read', 'c1', { status: 'read' }));
    const first = runWithRatchetTxn(db, async () => {
      await new Promise(r => setTimeout(r, 120));
      await store.upsert(makeMsg('m1', 'c1'));
    });
    const second = runWithRatchetTxn(db, async () => {
      await store.upsert(makeMsg('m2', 'c1'));
    });

    await expect(
      withDeadlockGuard(Promise.all([first, second]).then(() => 'ok'), 3000),
    ).resolves.toBe('ok');
    assertSerializedTrace(calls);
  });

  it('CONTROL: the flush and the burst on DIFFERENT conversations was always immune', async () => {
    // Lock B is per-conversation. When the armed flush and the inbound writes
    // touch DIFFERENT conversations, the receive never waits on the chain the
    // flush holds, so there is no cycle — this case passed even before the fix.
    // Pinned so a future "optimisation" to a single global write chain does not
    // quietly make it reachable too.
    //
    // NOTE the overlap matters: an earlier draft of this test armed the flush on
    // 'c1' AND had one receive write 'c1', which DID deadlock pre-fix. Keep the
    // conversation sets disjoint or this stops being a control.
    const { runWithRatchetTxn, SqlMessageStore } = freshModules();
    const { calls, db } = makeTxnTrackingDb();
    const store = new SqlMessageStore(db as never);

    store.upsertCoalesced(makeMsg('m-read', 'c0', { status: 'read' }));
    const work = ['c1', 'c2', 'c3'].map((cid, i) =>
      runWithRatchetTxn(db, async () => {
        await new Promise(r => setTimeout(r, 60));
        await store.upsert(makeMsg(`m${i}`, cid));
      }),
    );

    await expect(withDeadlockGuard(Promise.all(work).then(() => 'ok'), 3000)).resolves.toBe('ok');
    // Liveness only, deliberately. A trace assertion here would be racy: the
    // flush is fire-and-forget, so pre-fix it could still have a BEGIN open when
    // the receives resolve, and this control must hold in BOTH directions to be
    // worth anything. Serialisation is asserted by the tests above.
    expect(calls.length).toBeGreaterThan(0);
  });

  it('M14 pair 2: the send path takes the txn chain BEFORE the session lock', async () => {
    // Same AB-BA shape as B-130, different pair. The receive path holds the
    // global txn chain and then awaits a per-address session lock (inside
    // own.decrypt). The send path's session rebuild used to do the reverse:
    // take the session lock, then queue on the txn chain via
    // processPreKey -> saveIdentity. Both orders live at once = a cycle.
    //
    // Scanned rather than executed: driving real libsignal prekey processing
    // needs a full crypto fixture, and what must not regress is the ORDER.
    const src = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    // RE-POINTED for B-701 (2026-08-29): forceRefreshOutgoingSession's chain-
    // wrapped body was extracted into rebuildOutgoingSessionWithBundle so the
    // send-side rotation consumer can share it. The M14 property is unchanged
    // and now pinned where the chain actually lives; a separate assertion
    // below keeps forceRefresh honest about DELEGATING rather than inlining a
    // second (unscanned) rebuild.
    for (const fn of ['ensureOutgoingSession', 'rebuildOutgoingSessionWithBundle']) {
      const start = src.indexOf(`async function ${fn}(`);
      expect(start).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf('\nasync function ', start + 10));
      // The chain must be claimed BEFORE the session rebuild — being inside the
      // wrapper is exactly right, so assert ORDER, not absence. (A first draft
      // asserted `own.initOutgoingSession` never appears with `await`, which is
      // wrong: the core legitimately awaits it inside the wrapper.)
      const chainAt   = body.indexOf('runOnTxnChain(');
      const rebuildAt = body.indexOf('own.initOutgoingSession(');
      expect(chainAt).toBeGreaterThan(-1);
      expect(rebuildAt).toBeGreaterThan(chainAt);
    }
    {
      const start = src.indexOf('async function forceRefreshOutgoingSession(');
      expect(start).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf('\nasync function ', start + 10));
      expect(body).toMatch(/rebuildOutgoingSessionWithBundle\(/);
      // No inline second rebuild that would dodge the core's M14 shape.
      expect(body).not.toMatch(/own\.initOutgoingSession\(/);
    }
  });

  it('M14 pair 2: the network fetch stays OUTSIDE the chain', async () => {
    // Holding the global chain across a bundle round-trip would block every
    // receive for its duration — trading a deadlock for a stall.
    const src = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    // RE-POINTED for B-701: the chain lives in rebuildOutgoingSessionWithBundle
    // now. Its callers fetch FIRST; the core itself must contain NO fetch —
    // strictly stronger than the old order assertion.
    for (const fn of ['ensureOutgoingSession', 'forceRefreshOutgoingSession']) {
      const start = src.indexOf(`async function ${fn}(`);
      const body = src.slice(start, src.indexOf('\nasync function ', start + 10));
      const fetchAt = body.indexOf('fetchPeerBundleWithPoolSize');
      const rebuildAt = body.indexOf('rebuildOutgoingSessionWithBundle(');
      expect(fetchAt).toBeGreaterThan(-1);
      expect(rebuildAt).toBeGreaterThan(fetchAt);
    }
    {
      const start = src.indexOf('async function rebuildOutgoingSessionWithBundle(');
      const body = src.slice(start, src.indexOf('\nasync function ', start + 10));
      expect(body.indexOf('runOnTxnChain(')).toBeGreaterThan(-1);
      expect(body.indexOf('fetchPeerBundleWithPoolSize')).toBe(-1);
    }
  });

  it('ORDERING GUARD: a DELETE emitted after the flush is armed still executes AFTER it', async () => {
    // The per-conversation chain exists so a "clear chat" DELETE burst cannot be
    // overtaken by an in-flight INSERT — otherwise cleared or retracted messages
    // resurrect on the next boot. The obvious wrong fix for B-130 is to drop
    // chainOp from the flush; that would break this. Fail loudly if anyone does.
    const { SqlMessageStore } = freshModules();
    const { calls, db } = makeTxnTrackingDb();
    const store = new SqlMessageStore(db as never);

    store.upsertCoalesced(makeMsg('m-x', 'c1', { status: 'read' }));
    await new Promise(r => setTimeout(r, 80)); // let the flush claim the chain
    await store.remove('c1', 'm-x');            // emitted after ⇒ must run after

    // AUDIT #14 — doUpsert moved from INSERT OR REPLACE to the PK-targeted
    // ON CONFLICT form (OR REPLACE would have let a redelivered envelope
    // silently delete the original row under the new unique index).
    const ins = calls.findIndex(s => /INSERT INTO messages/i.test(s) && /ON CONFLICT\(conversation_id, id\) DO UPDATE/i.test(s));
    const del = calls.findIndex(s => /^\s*DELETE FROM messages/i.test(s));
    expect(ins).toBeGreaterThanOrEqual(0);
    expect(del).toBeGreaterThan(ins);
  });
});
