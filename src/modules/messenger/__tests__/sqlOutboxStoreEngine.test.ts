/**
 * AUDIT-2026-08-13 #20 — the outbox on a REAL SQLite engine.
 *
 * The existing sqlOutboxStore suite runs on a hand-written fake that
 * regex-matches SQL text ("understands only the queries the outbox store
 * actually emits") — a changed SQL string silently returns `{rows: []}`
 * and the suite passes VACUOUSLY. This suite is the antidote, following
 * the sqlMessageStoreEngine.test.ts pattern: node:sqlite (Node 22+, no
 * new dependency) + the REAL exported DDL, never a copy (the B-129
 * class). The properties pinned here are the B-137-class destruction
 * lanes: which failures burn the 10-attempt budget, which rows a peer's
 * ack deletes, and which rows a drain can never see again.
 */

jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));

import {DatabaseSync} from 'node:sqlite';
import {DDL} from '../crypto/db';
import {SqlOutboxStore} from '../store/sqlOutboxStore';

interface ExecResult {rows?: unknown[]}

function makeEngineDb(): {db: {execute(sql: string, params?: unknown[]): Promise<ExecResult>}; raw: DatabaseSync} {
  const raw = new DatabaseSync(':memory:');
  return {
    raw,
    db: {
      async execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
        const trimmed = sql.trim();
        const isRead = /^\s*(SELECT|PRAGMA)/i.test(trimmed);
        const stmt = raw.prepare(trimmed);
        const bound = params.map(p => (p === undefined ? null : p)) as never[];
        if (isRead) {
          return {rows: stmt.all(...bound) as unknown[]};
        }
        // Faithful to op-sqlite's QueryResult (edge review): rowsAffected
        // is REQUIRED there and six production consumers read it — an
        // adapter dropping it makes their green a fiction.
        const r = stmt.run(...bound);
        return {rows: [], rowsAffected: Number(r.changes), insertId: Number(r.lastInsertRowid)};
      },
    },
  };
}

function applySchema(raw: DatabaseSync): void {
  for (const stmt of DDL) {
    try {
      raw.exec(stmt);
    } catch (e) {
      if (!/duplicate column name|already exists/i.test((e as Error).message)) {throw e;}
    }
  }
}

function boot(): {store: SqlOutboxStore; raw: DatabaseSync} {
  const {db, raw} = makeEngineDb();
  applySchema(raw);
  return {store: new SqlOutboxStore(db as never), raw};
}

const rowFor = (peer: string, msg = 'cm-1') => ({
  clientMsgId: msg,
  conversationId: 'conv-1',
  messageId: `m-${msg}`,
  peerUserId: peer,
  peerDeviceId: 1,
  payload: '{"sealed":"…"}',
});

describe('AUDIT #20 — outbox on the real engine', () => {
  it('P0-N4: one peer’s ack deletes ONLY that peer’s row of a group fan-out', async () => {
    const {store} = boot();
    await store.enqueue(rowFor('u-alice'));
    await store.enqueue(rowFor('u-bob'));
    await store.markDelivered('cm-1', 'u-alice', 1);
    const due = await store.dueRows(Date.now() + 1);
    expect(due.map(r => r.peerUserId)).toEqual(['u-bob']);
  });

  it('enqueue is idempotent on the composite PK (INSERT OR IGNORE, attempts preserved)', async () => {
    const {store} = boot();
    await store.enqueue(rowFor('u-alice'));
    await store.recordAttempt('cm-1', 'u-alice', 1); // attempts -> 1
    await store.enqueue(rowFor('u-alice'));          // must NOT reset the row
    const due = await store.dueRows(Date.now() + 10 * 60_000);
    expect(due).toHaveLength(1);
    expect(due[0].attempts).toBe(1);
  });

  it('dueRows: only pending rows past next_retry_at, oldest first; failed rows never return', async () => {
    const {store} = boot();
    await store.enqueue(rowFor('u-a', 'cm-old'));
    await new Promise(r => setTimeout(r, 5)); // distinct created_at
    await store.enqueue(rowFor('u-a', 'cm-new'));
    await store.recordAttempt('cm-old', 'u-a', 1, {permanent: true});
    const due = await store.dueRows(Date.now() + 1);
    expect(due.map(r => r.clientMsgId)).toEqual(['cm-new']);
  });

  it('the rejected lane burns the budget and terminates at the cap — then only resetFailed revives it', async () => {
    const {store} = boot();
    await store.enqueue(rowFor('u-a'));
    let out: {attempts: number; failed: boolean; queued: boolean} = {attempts: 0, failed: false, queued: false};
    let spins = 0;
    while (!out.failed && spins < 50) {
      out = await store.recordAttempt('cm-1', 'u-a', 1);
      spins++;
    }
    expect(out.failed).toBe(true);
    expect(spins).toBeLessThan(50);               // a real cap exists
    const cap = out.attempts;
    expect(cap).toBeGreaterThanOrEqual(3);
    // Terminal: invisible to every drain, forever…
    expect(await store.dueRows(Date.now() + 60 * 60_000)).toHaveLength(0);
    expect(await store.pendingMessageIds()).toEqual(new Set());
    // …but still visible to the MSG-07 boot sweep…
    expect(await store.allMessageIds()).toEqual(new Set(['m-cm-1']));
    // …and only the user's explicit retry revives it, from zero.
    await store.resetFailed('cm-1', 'u-a', 1);
    const due = await store.dueRows(Date.now() + 1);
    expect(due).toHaveLength(1);
    expect(due[0].attempts).toBe(0);
  });

  it('SN-04/XO-3: unreachable and transient failures never touch the budget', async () => {
    const {store} = boot();
    await store.enqueue(rowFor('u-a'));
    for (let i = 0; i < 30; i++) {
      const out = await store.recordAttempt('cm-1', 'u-a', 1, i % 2 ? {unreachable: true} : {transient: true});
      expect(out.failed).toBe(false);
      expect(out.attempts).toBe(0); // the budget is untouched after 30 offline failures
    }
    // Parked by soft backoff, not terminated: a far-future drain still sees it.
    expect(await store.dueRows(Date.now() + 60 * 60_000)).toHaveLength(1);
  });

  it('OM-07: soft backoff escalates (the delay is not pinned at the first slot)', async () => {
    const {store, raw} = boot();
    await store.enqueue(rowFor('u-a'));
    const readRetryAt = (): number =>
      (raw.prepare('SELECT next_retry_at FROM outbox').get() as {next_retry_at: number}).next_retry_at;
    await store.recordAttempt('cm-1', 'u-a', 1, {unreachable: true});
    const first = readRetryAt() - Date.now();
    for (let i = 0; i < 6; i++) {
      await store.recordAttempt('cm-1', 'u-a', 1, {unreachable: true});
    }
    const later = readRetryAt() - Date.now();
    expect(later).toBeGreaterThan(first);
  });

  it('a server Retry-After (deferMs) overrides the ladder and is ceiling-clamped', async () => {
    const {store, raw} = boot();
    await store.enqueue(rowFor('u-a'));
    await store.recordAttempt('cm-1', 'u-a', 1, {deferMs: 99 * 60_000}); // absurd Retry-After
    const parkedFor =
      (raw.prepare('SELECT next_retry_at FROM outbox').get() as {next_retry_at: number}).next_retry_at - Date.now();
    expect(parkedFor).toBeLessThanOrEqual(5 * 60_000 + 1000); // the 5-min ceiling holds
    expect(parkedFor).toBeGreaterThan(60_000);
  });

  it('XO-5 permanent: terminates immediately without spending the budget counter', async () => {
    const {store} = boot();
    await store.enqueue(rowFor('u-a'));
    const out = await store.recordAttempt('cm-1', 'u-a', 1, {permanent: true});
    expect(out.failed).toBe(true);
    expect(out.attempts).toBe(0);
    expect(await store.dueRows(Date.now() + 1)).toHaveLength(0);
  });

  it('the ack race: recordAttempt on a row markDelivered already deleted is a clean no-op', async () => {
    const {store} = boot();
    await store.enqueue(rowFor('u-a'));
    await store.markDelivered('cm-1', 'u-a', 1);
    const out = await store.recordAttempt('cm-1', 'u-a', 1);
    expect(out).toEqual({attempts: 0, failed: false, queued: false});
  });

  it('clearUnreachableBackoff un-parks soft-parked pending rows and NOTHING else', async () => {
    const {store} = boot();
    await store.enqueue(rowFor('u-soft', 'cm-soft'));
    await store.enqueue(rowFor('u-dead', 'cm-dead'));
    await store.recordAttempt('cm-soft', 'u-soft', 1, {unreachable: true}); // parked
    await store.recordAttempt('cm-dead', 'u-dead', 1, {permanent: true});  // terminal
    await store.clearUnreachableBackoff();
    const due = await store.dueRows();
    expect(due.map(r => r.clientMsgId)).toEqual(['cm-soft']); // failed row NOT revived
  });

  it('kickPending pulls every future pending retry to now but keeps the soft ladder', async () => {
    const {store, raw} = boot();
    await store.enqueue(rowFor('u-a'));
    await store.recordAttempt('cm-1', 'u-a', 1, {unreachable: true});
    await store.recordAttempt('cm-1', 'u-a', 1, {unreachable: true});
    expect(await store.dueRows()).toHaveLength(0); // parked in the future
    await store.kickPending();
    expect(await store.dueRows()).toHaveLength(1); // due immediately
    const soft = (raw.prepare('SELECT soft_attempts FROM outbox').get() as {soft_attempts: number}).soft_attempts;
    expect(soft).toBe(2); // the escalation ladder survives the kick (OR-1)
  });

  it('deleteByConversation clears every peer row for the thread; others untouched', async () => {
    const {store} = boot();
    await store.enqueue(rowFor('u-a', 'cm-1'));
    await store.enqueue(rowFor('u-b', 'cm-1'));
    await store.enqueue({...rowFor('u-c', 'cm-other'), conversationId: 'conv-2'});
    await store.deleteByConversation('conv-1');
    const due = await store.dueRows(Date.now() + 1);
    expect(due.map(r => r.clientMsgId)).toEqual(['cm-other']);
  });
});
