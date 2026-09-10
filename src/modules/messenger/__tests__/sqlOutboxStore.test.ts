/**
 * Durable outbox unit tests. These exercise the SqlOutboxStore against
 * an in-memory fake DbHandle so we don't need op-sqlite/SQLCipher
 * available in the Jest harness. Coverage:
 *
 *   1. enqueue inserts a row; double-enqueue of the SAME composite key
 *      (clientMsgId, peerUserId, peerDeviceId) is idempotent
 *      (INSERT OR IGNORE).
 *   2. enqueue with the SAME clientMsgId but DIFFERENT peer creates
 *      independent rows (audit P0-N4 — group fan-out).
 *   3. dueRows returns rows with next_retry_at <= now in created_at
 *      order; filters out 'failed' status.
 *   4. markDelivered removes ONLY the row matching (clientMsgId, peer);
 *      sibling group-fanout rows survive.
 *   5. recordAttempt bumps attempts on the targeted row and schedules
 *      backoff; after MAX_ATTEMPTS it marks that row 'failed'.
 *   6. resetFailed flips one 'failed' row back to 'pending' without
 *      touching peer siblings.
 */

import {
  SqlOutboxStore,
  isUnreachableError,
  isPermanentRelayRejection,
  isBackpressureError,
  classifyOutboxFailure,
} from '../store/sqlOutboxStore';
import {RelayHttpError} from '@bravo/messenger-core';
import {planOutboxDrain, isDeferredDirect} from '../runtime/deferredOutbox';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

type Row = Record<string, string | number | null>;

/**
 * Hand-rolled mini SQLite engine that understands only the queries the
 * outbox store actually emits. Faster than spinning up sql.js and
 * isolates failures to the store's SQL strings rather than a generic
 * SQLite parser quirk.
 */
function makeFakeDb() {
  const table: Row[] = [];
  const sameKey = (r: Row, cmid: unknown, uid: unknown, did: unknown): boolean =>
    r.client_msg_id === cmid && r.peer_user_id === uid && r.peer_device_id === did;
  return {
    table,
    async execute(sql: string, params: (string | number)[] = []) {
      const trimmed = sql.trim().replace(/\s+/g, ' ');
      if (trimmed.startsWith('INSERT OR IGNORE INTO outbox')) {
        const [client_msg_id, conversation_id, message_id, peer_user_id,
               peer_device_id, payload, next_retry_at, created_at] = params;
        if (table.some(r => sameKey(r, client_msg_id, peer_user_id, peer_device_id))) {
          return {rows: []};
        }
        table.push({
          client_msg_id, conversation_id, message_id, peer_user_id,
          peer_device_id, payload, attempts: 0, soft_attempts: 0,
          next_retry_at, created_at, status: 'pending',
        });
        return {rows: []};
      }
      if (trimmed.startsWith('SELECT client_msg_id, conversation_id')) {
        const now = params[0] as number;
        const rows = table
          .filter(r => r.status === 'pending' && (r.next_retry_at as number) <= now)
          .sort((a, b) => (a.created_at as number) - (b.created_at as number));
        return {rows};
      }
      if (trimmed.startsWith('DELETE FROM outbox WHERE conversation_id')) {
        const [convId] = params;
        for (let i = table.length - 1; i >= 0; i--) {
          if (table[i].conversation_id === convId) {table.splice(i, 1);}
        }
        return {rows: []};
      }
      if (trimmed.startsWith('DELETE FROM outbox WHERE client_msg_id = ?') && params.length === 1) {
        const [cmid] = params;
        for (let i = table.length - 1; i >= 0; i--) {
          if (table[i].client_msg_id === cmid) {table.splice(i, 1);}
        }
        return {rows: []};
      }
      if (trimmed.startsWith('DELETE FROM outbox')) {
        const [cmid, uid, did] = params;
        const idx = table.findIndex(r => sameKey(r, cmid, uid, did));
        if (idx >= 0) {table.splice(idx, 1);}
        return {rows: []};
      }
      if (trimmed.startsWith('SELECT DISTINCT message_id FROM outbox')) {
        const pendingOnly = /status = 'pending'/.test(trimmed);
        const rows = table
          .filter(r => !pendingOnly || r.status === 'pending')
          .map(r => ({message_id: r.message_id}));
        return {rows};
      }
      if (trimmed.startsWith('SELECT attempts, soft_attempts FROM outbox')) {
        const [cmid, uid, did] = params;
        const match = table.find(r => sameKey(r, cmid, uid, did));
        return {rows: match ? [{attempts: match.attempts, soft_attempts: match.soft_attempts}] : []};
      }
      // XO-5 — permanent relay rejection: terminate without touching attempts.
      if (trimmed.startsWith('UPDATE outbox SET status = \'failed\'')) {
        const [cmid, uid, did] = params;
        const match = table.find(r => sameKey(r, cmid, uid, did));
        if (match) { match.status = 'failed'; }
        return {rows: []};
      }
      if (trimmed.startsWith('UPDATE outbox SET attempts = ?, status = \'failed\'')) {
        const [attempts, cmid, uid, did] = params;
        const match = table.find(r => sameKey(r, cmid, uid, did));
        if (match) { match.attempts = attempts; match.status = 'failed'; }
        return {rows: []};
      }
      if (trimmed.startsWith('UPDATE outbox SET attempts = ?, next_retry_at = ?')) {
        const [attempts, next_retry_at, cmid, uid, did] = params;
        const match = table.find(r => sameKey(r, cmid, uid, did));
        if (match) { match.attempts = attempts; match.next_retry_at = next_retry_at; }
        return {rows: []};
      }
      // OM-07 — bulk unpark: zero the soft streak on every parked pending row.
      if (trimmed.startsWith('UPDATE outbox SET soft_attempts = 0, next_retry_at = ?')) {
        const [next_retry_at] = params;
        for (const r of table) {
          if (r.status === 'pending' && (r.soft_attempts as number) > 0) {
            r.soft_attempts = 0;
            r.next_retry_at = next_retry_at;
          }
        }
        return {rows: []};
      }
      // SN-04 / XO-3 — no-budget reschedule: escalates soft_attempts and
      // pushes next_retry_at WITHOUT touching attempts or status.
      if (trimmed.startsWith('UPDATE outbox SET soft_attempts = ?, next_retry_at = ?')) {
        const [soft_attempts, next_retry_at, cmid, uid, did] = params;
        const match = table.find(r => sameKey(r, cmid, uid, did));
        if (match) { match.soft_attempts = soft_attempts; match.next_retry_at = next_retry_at; }
        return {rows: []};
      }
      // OR-1 — kickPending: pull every future-dated pending row forward.
      if (trimmed.startsWith('UPDATE outbox SET next_retry_at = ?')) {
        const [next_retry_at, cutoff] = params;
        for (const r of table) {
          if (r.status === 'pending' && (r.next_retry_at as number) > (cutoff as number)) {
            r.next_retry_at = next_retry_at;
          }
        }
        return {rows: []};
      }
      if (trimmed.startsWith('UPDATE outbox SET attempts = 0, soft_attempts = 0')) {
        const [next_retry_at, cmid, uid, did] = params;
        const match = table.find(r => sameKey(r, cmid, uid, did) && r.status === 'failed');
        if (match) {
          match.attempts = 0;
          match.soft_attempts = 0;
          match.next_retry_at = next_retry_at;
          match.status = 'pending';
        }
        return {rows: []};
      }
      throw new Error(`unhandled SQL: ${trimmed}`);
    },
  };
}

function make(): {store: SqlOutboxStore; table: Row[]} {
  const fake = makeFakeDb();
  return {store: new SqlOutboxStore(fake as never), table: fake.table};
}

function row(overrides: Partial<{
  clientMsgId: string; conversationId: string; messageId: string;
  peerUserId: string; peerDeviceId: number; payload: string;
}> = {}) {
  return {
    clientMsgId:    overrides.clientMsgId    ?? 'cmid-1',
    conversationId: overrides.conversationId ?? 'direct:bob',
    messageId:      overrides.messageId      ?? 'mid-1',
    peerUserId:     overrides.peerUserId     ?? 'bob',
    peerDeviceId:   overrides.peerDeviceId   ?? 1,
    payload:        overrides.payload        ?? '{"outerSealed":"AAA"}',
  };
}

describe('SqlOutboxStore', () => {
  test('enqueue inserts a row and is idempotent on duplicate composite key', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'dup'}));
    await store.enqueue(row({clientMsgId: 'dup', payload: 'IGNORED'}));
    expect(table).toHaveLength(1);
    expect(table[0].payload).toBe('{"outerSealed":"AAA"}'); // first wins
  });

  test('audit P0-N4 — same clientMsgId, different peers => independent rows', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'group-1', peerUserId: 'alice'}));
    await store.enqueue(row({clientMsgId: 'group-1', peerUserId: 'bob'}));
    await store.enqueue(row({clientMsgId: 'group-1', peerUserId: 'carol'}));
    expect(table).toHaveLength(3);
    const peers = table.map(r => r.peer_user_id).sort();
    expect(peers).toEqual(['alice', 'bob', 'carol']);
  });

  test('audit P0-N4 — markDelivered removes ONLY the targeted peer row', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'group-1', peerUserId: 'alice'}));
    await store.enqueue(row({clientMsgId: 'group-1', peerUserId: 'bob'}));
    await store.enqueue(row({clientMsgId: 'group-1', peerUserId: 'carol'}));
    await store.markDelivered('group-1', 'bob', 1);
    const survivors = table.map(r => r.peer_user_id).sort();
    expect(survivors).toEqual(['alice', 'carol']);
  });

  test('dueRows returns pending rows with next_retry_at <= now in created order', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'a'}));
    // manually advance created_at on row a so b is newer
    table[0].created_at = 100;
    await store.enqueue(row({clientMsgId: 'b'}));
    table[1].created_at = 200;
    const due = await store.dueRows(Date.now() + 1_000_000);
    expect(due.map(r => r.clientMsgId)).toEqual(['a', 'b']);
  });

  test('dueRows skips status=failed', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'a'}));
    table[0].status = 'failed';
    const due = await store.dueRows(Date.now() + 1_000_000);
    expect(due).toHaveLength(0);
  });

  test('markDelivered removes the row', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'x'}));
    expect(table).toHaveLength(1);
    await store.markDelivered('x', 'bob', 1);
    expect(table).toHaveLength(0);
  });

  test('recordAttempt bumps attempts and schedules backoff', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'a'}));
    const before = table[0].next_retry_at as number;
    const r1 = await store.recordAttempt('a', 'bob', 1);
    expect(r1.attempts).toBe(1);
    expect(r1.failed).toBe(false);
    const after = table[0].next_retry_at as number;
    expect(after).toBeGreaterThan(before);
  });

  test('recordAttempt eventually marks failed after enough retries', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'a'}));
    let last = {attempts: 0, failed: false};
    for (let i = 0; i < 12 && !last.failed; i++) {
      last = await store.recordAttempt('a', 'bob', 1);
    }
    expect(last.failed).toBe(true);
    expect(table[0].status).toBe('failed');
  });

  test('audit P0-N4 — recordAttempt only affects the targeted peer row', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'group-1', peerUserId: 'alice'}));
    await store.enqueue(row({clientMsgId: 'group-1', peerUserId: 'bob'}));
    await store.recordAttempt('group-1', 'bob', 1);
    const alice = table.find(r => r.peer_user_id === 'alice');
    const bob = table.find(r => r.peer_user_id === 'bob');
    expect(alice?.attempts).toBe(0);
    expect(bob?.attempts).toBe(1);
  });

  test('resetFailed re-arms a failed row for immediate retry', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'a'}));
    table[0].status = 'failed';
    table[0].attempts = 11;
    await store.resetFailed('a', 'bob', 1);
    expect(table[0].status).toBe('pending');
    expect(table[0].attempts).toBe(0);
    expect((table[0].next_retry_at as number)).toBeLessThanOrEqual(Date.now() + 5);
  });

  test('recordAttempt on a deleted row is a no-op', async () => {
    const {store} = make();
    const r = await store.recordAttempt('does-not-exist', 'bob', 1);
    expect(r).toEqual({attempts: 0, failed: false, queued: false});
  });

  test('audit MSG-05 — deleteByClientMsgId drops EVERY peer row for a clientMsgId', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'g1', peerUserId: 'alice'}));
    await store.enqueue(row({clientMsgId: 'g1', peerUserId: 'bob'}));
    await store.enqueue(row({clientMsgId: 'keep', peerUserId: 'carol'}));
    await store.deleteByClientMsgId('g1');
    expect(table).toHaveLength(1);
    expect(table[0].client_msg_id).toBe('keep');
  });

  test('P2-10 — deleteByConversation drops ALL rows for a conversation (any clientMsgId/peer)', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'g1', conversationId: 'grp:x', peerUserId: 'alice'}));
    await store.enqueue(row({clientMsgId: 'g1', conversationId: 'grp:x', peerUserId: 'bob'}));
    await store.enqueue(row({clientMsgId: 't2', conversationId: 'grp:x', peerUserId: 'carol'}));
    await store.enqueue(row({clientMsgId: 'other', conversationId: 'direct:dave', peerUserId: 'dave'}));
    await store.deleteByConversation('grp:x');
    expect(table).toHaveLength(1);
    expect(table[0].conversation_id).toBe('direct:dave');
  });

  /**
   * SN-04 — an offline stretch must not exhaust the retry budget.
   *
   * Before this, offline sends fast-failed in milliseconds and each one
   * burned an attempt; ~30-40 min in a dead zone flipped every queued row to
   * 'failed', and because dueRows only selects 'pending', reconnecting sent
   * NOTHING until the user tapped retry on each bubble individually.
   */
  describe('SN-04 — unreachable-network attempts do not consume the budget', () => {
    test('an unreachable failure reschedules without incrementing attempts', async () => {
      const {store, table} = make();
      await store.enqueue(row({clientMsgId: 'm1', peerUserId: 'alice'}));

      const res = await store.recordAttempt('m1', 'alice', 1, {unreachable: true});

      expect(res).toEqual({attempts: 0, failed: false, queued: true});
      expect(table[0].attempts).toBe(0);
      expect(table[0].status).toBe('pending');
      expect(table[0].next_retry_at as number).toBeGreaterThan(Date.now() - 1);
    });

    test('offline far beyond MAX_ATTEMPTS still leaves the row drainable', async () => {
      const {store, table} = make();
      await store.enqueue(row({clientMsgId: 'm1', peerUserId: 'alice'}));

      // Well past the ~10-attempt budget that previously killed the row.
      for (let i = 0; i < 40; i++) {
        await store.recordAttempt('m1', 'alice', 1, {unreachable: true});
      }

      expect(table[0].status).toBe('pending');
      expect(table[0].attempts).toBe(0);

      // The decisive property: when connectivity returns, it auto-drains.
      const due = await store.dueRows(Date.now() + 10 * 60_000);
      expect(due.map(r => r.clientMsgId)).toContain('m1');
    });

    test('server-rejected attempts DO still consume the budget and terminate', async () => {
      const {store, table} = make();
      await store.enqueue(row({clientMsgId: 'm1', peerUserId: 'alice'}));

      let last = {attempts: 0, failed: false};
      for (let i = 0; i < 10; i++) {
        last = await store.recordAttempt('m1', 'alice', 1);
      }

      expect(last.failed).toBe(true);
      expect(table[0].status).toBe('failed');
    });

    test('a mixed run only counts the server-rejected attempts', async () => {
      const {store, table} = make();
      await store.enqueue(row({clientMsgId: 'm1', peerUserId: 'alice'}));

      await store.recordAttempt('m1', 'alice', 1, {unreachable: true});
      await store.recordAttempt('m1', 'alice', 1);
      await store.recordAttempt('m1', 'alice', 1, {unreachable: true});
      const res = await store.recordAttempt('m1', 'alice', 1);

      expect(res.attempts).toBe(2);
      expect(table[0].status).toBe('pending');
    });
  });

  /**
   * XO-3 — a 5xx / 429 / no_token is the relay saying "later", not "no".
   * Charging those to the 10-attempt budget turned a ~30-min relay outage
   * into a permanently 'failed' row that no automatic drain re-selects.
   *
   * OM-07 rides along: the no-budget branch used to index BACKOFF_MS with
   * `attempts` (which it never increments), pinning the delay at 1s forever.
   */
  describe('XO-3 — server-transient rejections do not consume the budget', () => {
    test('40 transient failures never terminate the row', async () => {
      const {store, table} = make();
      await store.enqueue(row({clientMsgId: 'm1', peerUserId: 'alice'}));

      for (let i = 0; i < 40; i++) {
        await store.recordAttempt('m1', 'alice', 1, {transient: true});
      }

      expect(table[0].status).toBe('pending');
      expect(table[0].attempts).toBe(0);
      const due = await store.dueRows(Date.now() + 10 * 60_000);
      expect(due.map(r => r.clientMsgId)).toContain('m1');
    });

    test('OM-07 — consecutive no-budget failures escalate the backoff', async () => {
      const {store, table} = make();
      await store.enqueue(row({clientMsgId: 'm1', peerUserId: 'alice'}));

      const gap = async (): Promise<number> => (table[0].next_retry_at as number) - Date.now();

      await store.recordAttempt('m1', 'alice', 1, {transient: true});
      expect(await gap()).toBeGreaterThan(900);
      expect(await gap()).toBeLessThan(1_100);

      for (let i = 0; i < 4; i++) {
        await store.recordAttempt('m1', 'alice', 1, {transient: true});
      }
      // F-3 (B-693) — ceiling re-pointed 5min → 2min (rungs halved; DL-4:
      // the eligibility ladder is the only wait on a quiet socket). The
      // BEHAVIOUR pinned here — escalate then cap, budget untouched — is
      // unchanged; only the cap value moved.
      expect(await gap()).toBeGreaterThan(119_000);
      expect(await gap()).toBeLessThan(121_000);

      // Capped, not growing.
      for (let i = 0; i < 4; i++) {
        await store.recordAttempt('m1', 'alice', 1, {transient: true});
      }
      expect(await gap()).toBeLessThan(121_000);
      expect(table[0].attempts).toBe(0);
      expect(table[0].status).toBe('pending');
    });

    test('an explicit deferMs (Retry-After) wins over the computed backoff', async () => {
      const {store, table} = make();
      await store.enqueue(row({clientMsgId: 'm1', peerUserId: 'alice'}));

      await store.recordAttempt('m1', 'alice', 1, {transient: true, deferMs: 7_000});

      const gap = (table[0].next_retry_at as number) - Date.now();
      expect(gap).toBeGreaterThan(6_900);
      expect(gap).toBeLessThan(7_100);
      expect(table[0].attempts).toBe(0);
    });

    test('a hostile Retry-After is clamped to the backoff ceiling (2min post-F-3)', async () => {
      const {store, table} = make();
      await store.enqueue(row({clientMsgId: 'm1', peerUserId: 'alice'}));

      await store.recordAttempt('m1', 'alice', 1, {transient: true, deferMs: 3_600_000});

      const gap = (table[0].next_retry_at as number) - Date.now();
      expect(gap).toBeLessThanOrEqual(120_000);
      expect(gap).toBeGreaterThan(119_000);
    });

    test('deferMs alone (no flag) still takes the no-budget branch', async () => {
      const {store, table} = make();
      await store.enqueue(row({clientMsgId: 'm1', peerUserId: 'alice'}));

      const res = await store.recordAttempt('m1', 'alice', 1, {deferMs: 5_000});

      expect(res).toEqual({attempts: 0, failed: false, queued: true});
      expect(table[0].attempts).toBe(0);
    });

    test('semantic rejections still burn the budget and terminate', async () => {
      const {store, table} = make();
      await store.enqueue(row({clientMsgId: 'm1', peerUserId: 'alice'}));

      let last = {attempts: 0, failed: false, queued: false};
      for (let i = 0; i < 10; i++) {
        last = await store.recordAttempt('m1', 'alice', 1);
      }

      expect(last.failed).toBe(true);
      expect(last.queued).toBe(false);
      expect(table[0].status).toBe('failed');
    });

    test('resetFailed zeroes soft_attempts as well as attempts', async () => {
      const {store, table} = make();
      await store.enqueue(row({clientMsgId: 'm1', peerUserId: 'alice'}));
      await store.recordAttempt('m1', 'alice', 1, {transient: true});
      table[0].status = 'failed';
      table[0].attempts = 11;

      await store.resetFailed('m1', 'alice', 1);

      expect(table[0].status).toBe('pending');
      expect(table[0].attempts).toBe(0);
      expect(table[0].soft_attempts).toBe(0);
    });
  });

  /**
   * XO-5 — the outbox owns the terminal decision. A bubble may only go
   * 'failed' when the row is genuinely not going to be retried; the `queued`
   * flag is what the send path reads to decide that.
   */
  describe('XO-5 — queued flag and permanent rejections', () => {
    test('an unreachable failure reports queued and leaves the row pending', async () => {
      const {store, table} = make();
      await store.enqueue(row({clientMsgId: 'm1', peerUserId: 'alice'}));

      const res = await store.recordAttempt('m1', 'alice', 1, {unreachable: true});

      // The exact split this finding is about: never (bubble failed, row pending).
      expect({queued: res.queued, rowStatus: table[0].status})
        .toEqual({queued: true, rowStatus: 'pending'});
    });

    test('a permanent rejection terminates the row without burning attempts', async () => {
      const {store, table} = make();
      await store.enqueue(row({clientMsgId: 'm1', peerUserId: 'alice'}));

      const res = await store.recordAttempt('m1', 'alice', 1, {permanent: true});

      expect(res).toEqual({attempts: 0, failed: true, queued: false});
      expect(table[0].status).toBe('failed');
      expect(table[0].attempts).toBe(0);
      expect(await store.dueRows(Date.now() + 10 * 60_000)).toHaveLength(0);
    });

    test('budget exhaustion reports queued=false', async () => {
      const {store} = make();
      await store.enqueue(row({clientMsgId: 'm1', peerUserId: 'alice'}));

      let last = {attempts: 0, failed: false, queued: true};
      for (let i = 0; i < 10; i++) {
        last = await store.recordAttempt('m1', 'alice', 1);
      }

      expect(last).toEqual({attempts: 10, failed: true, queued: false});
    });

    test('pendingMessageIds excludes rows whose only status is failed', async () => {
      const {store, table} = make();
      await store.enqueue(row({clientMsgId: 'a', messageId: 'dead', peerUserId: 'alice'}));
      await store.enqueue(row({clientMsgId: 'b', messageId: 'alive', peerUserId: 'bob'}));
      table[0].status = 'failed';

      expect([...(await store.pendingMessageIds())]).toEqual(['alive']);
      expect([...(await store.allMessageIds())].sort()).toEqual(['alive', 'dead']);
    });
  });

  /**
   * OM-07 part 3 / OR-1 — without an unpark, an escalating offline backoff
   * parks rows past the reconnect that made it obsolete: a battery bug traded
   * for a minutes-late send.
   */
  describe('OM-07 / OR-1 — unparking a backed-off queue', () => {
    test('clearUnreachableBackoff makes parked rows immediately due', async () => {
      const {store, table} = make();
      await store.enqueue(row({clientMsgId: 'm1', peerUserId: 'alice'}));
      for (let i = 0; i < 6; i++) {
        await store.recordAttempt('m1', 'alice', 1, {unreachable: true});
      }
      expect(await store.dueRows(Date.now())).toHaveLength(0);

      await store.clearUnreachableBackoff();

      const due = await store.dueRows(Date.now() + 5);
      expect(due.map(r => r.clientMsgId)).toEqual(['m1']);
      expect(table[0].soft_attempts).toBe(0);
    });

    test('clearUnreachableBackoff leaves failed rows and the attempts budget alone', async () => {
      const {store, table} = make();
      await store.enqueue(row({clientMsgId: 'dead', peerUserId: 'alice'}));
      await store.enqueue(row({clientMsgId: 'live', peerUserId: 'bob'}));
      table[0].status = 'failed';
      table[0].attempts = 11;
      table[0].soft_attempts = 3;
      await store.recordAttempt('live', 'bob', 1);
      const liveAttempts = table[1].attempts;
      await store.recordAttempt('live', 'bob', 1, {unreachable: true});

      await store.clearUnreachableBackoff();

      expect(table[0].status).toBe('failed');
      expect(table[0].attempts).toBe(11);
      expect(table[0].soft_attempts).toBe(3);
      expect(table[1].attempts).toBe(liveAttempts);
    });

    test('kickPending pulls a parked pending row forward without touching attempts', async () => {
      const {store, table} = make();
      await store.enqueue(row({clientMsgId: 'm1', peerUserId: 'alice'}));
      await store.recordAttempt('m1', 'alice', 1);
      const attemptsBefore = table[0].attempts;
      table[0].next_retry_at = Date.now() + 300_000;
      expect(await store.dueRows(Date.now())).toHaveLength(0);

      await store.kickPending();

      expect((await store.dueRows(Date.now() + 5)).map(r => r.clientMsgId)).toEqual(['m1']);
      expect(table[0].attempts).toBe(attemptsBefore);
    });

    test('kickPending does not revive a failed row and does not push past rows forward', async () => {
      const {store, table} = make();
      await store.enqueue(row({clientMsgId: 'dead', peerUserId: 'alice'}));
      await store.enqueue(row({clientMsgId: 'old', peerUserId: 'bob'}));
      table[0].status = 'failed';
      table[1].next_retry_at = 1_000;

      await store.kickPending();

      expect(table[0].status).toBe('failed');
      expect(table[1].next_retry_at).toBe(1_000);
    });
  });
});

describe('SN-04 — isUnreachableError classification', () => {
  test.each([
    ['RN offline rejection',   new TypeError('Network request failed')],
    ['axios-style offline',    new Error('Network Error')],
    ['SN-01 abort',            Object.assign(new Error('Aborted'), {name: 'AbortError'})],
    ['socket reset',           new Error('read ECONNRESET')],
    ['dns failure',            new Error('getaddrinfo ENOTFOUND relay.test')],
  ])('treats %s as unreachable', (_label, err) => {
    expect(isUnreachableError(err)).toBe(true);
  });

  test.each([
    ['a relay rejection',      new Error('relay rejected: bad_recipient')],
    ['an auth failure',        new Error('no_token')],
    ['a crypto failure',       new Error('sender cert expired')],
  ])('does NOT treat %s as unreachable', (_label, err) => {
    expect(isUnreachableError(err)).toBe(false);
  });
});

describe('XO-3 — classifyOutboxFailure', () => {
  test.each([
    ['a real RelayHttpError 500', new RelayHttpError(500, 'Internal server error')],
    ['502',                       Object.assign(new Error('Bad Gateway'), {status: 502})],
    ['503',                       Object.assign(new Error('Service Unavailable'), {status: 503})],
    ['504',                       Object.assign(new Error('upstream_error'), {status: 504})],
    ['the Nest throttler 429',    Object.assign(new Error('ThrottlerException: Too Many Requests'), {status: 429})],
    ['relay_queue_full',          Object.assign(new Error('relay_queue_full'), {status: 429})],
    ['a local no_token 401',      new RelayHttpError(401, 'no_token')],
  ])('classifies %s as server-transient', (_label, err) => {
    expect(classifyOutboxFailure(err).kind).toBe('server-transient');
  });

  test.each([
    ['invalid_recipient',          Object.assign(new Error('invalid_recipient'), {status: 400})],
    ['outer_sealed_too_large',     Object.assign(new Error('outer_sealed_too_large'), {status: 400})],
    ['404',                        Object.assign(new Error('not found'), {status: 404})],
    ['a local crypto failure',     new Error('outbox_cert_expired_unresealable')],
  ])('classifies %s as rejected', (_label, err) => {
    expect(classifyOutboxFailure(err).kind).toBe('rejected');
  });

  /**
   * B-703 MR-6 — a LOCAL storage fault is not a rejection.
   *
   * The receive path has treated these as "leave it, come back" for years; the
   * send path charged the SAME strings to the 10-attempt budget, so a burst of
   * SQLCipher contention (the backup mirror on its own handle, a B-701 storm's
   * wedged txn chain) walked a perfectly good message to a terminal red chip in
   * roughly twelve minutes — the founder's "it failed on its own while queued".
   */
  test.each([
    ['a nested transaction', new Error('[op-sqlite] cannot start a transaction within a transaction')],
    ['a locked database',    new Error('database is locked')],
    ['a locked table',       new Error('database table is locked')],
    ['SQLITE_BUSY',          new Error('SQLITE_BUSY: database is busy')],
    ['SQLITE_LOCKED',        new Error('SQLITE_LOCKED')],
    ['disk I/O',             new Error('disk i/o error')],
    ['SQLITE_IOERR',         new Error('SQLITE_IOERR')],
    ['a full disk',          new Error('database or disk is full')],
    ['SQLITE_FULL',          new Error('SQLITE_FULL')],
    ['a disowned txn frame', new Error('txn_frame_disowned')],
    ['a closed handle',      new Error('db_closed')],
  ])('REGRESSION: classifies %s as server-transient, never rejected', (_label, err) => {
    expect(classifyOutboxFailure(err).kind).toBe('server-transient');
  });

  /**
   * B-703 MR-6 — the arm is gated on `status === 0`.
   *
   * A local SQLCipher fault never carries an HTTP status, and a RelayHttpError's
   * MESSAGE is the server's response body — so an ungated test feeds server text
   * into a SQLite regex. It also sits above the 5xx branch (it has to, to be
   * reachable for status 0), so ungated it would swallow a real relay answer's
   * Retry-After.
   */
  it('a RELAY error is never re-read as a local storage fault', () => {
    const relay5xx = Object.assign(new Error('database is locked'), {status: 503, retryAfterMs: 4_000});
    const out = classifyOutboxFailure(relay5xx);
    expect(out.kind).toBe('server-transient');
    expect(out.status).toBe(503);
    // The server's own pacing hint survives — the local arm must not shadow it.
    expect(out.retryAfterMs).toBe(4_000);
  });

  it('a 400 whose body happens to mention a database is still a rejection', () => {
    const rejected = Object.assign(new Error('invalid_recipient (database is locked)'), {status: 400});
    expect(classifyOutboxFailure(rejected).kind).toBe('rejected');
  });

  it('shares ONE transient-SQL rule with the receive path (no second regex to drift)', () => {
    const {isTransientSqlError} = require('../runtime/receiveTransaction') as
      typeof import('../runtime/receiveTransaction');
    // Enumerated from the receive path's OWN source, not a hand-picked sample:
    // sampling four agreed strings would stay green if someone reintroduced a
    // local copy that dropped the disk-full alternatives. Adding an alternative
    // on the receive side now automatically demands the send side spares it too.
    const src = readFileSync(
      join(__dirname, '..', 'runtime', 'receiveTransaction.ts'), 'utf8');
    const m = /const TRANSIENT_SQL_ERROR_RE\s*=\s*\r?\n?\s*\/([^\n]+)\/i;/.exec(src);
    expect(m).not.toBeNull();
    const alternatives = m![1].split('|').map(a => a.replace(/\\/g, ''));
    expect(alternatives.length).toBeGreaterThanOrEqual(11);

    for (const alt of alternatives) {
      const err = new Error(alt);
      expect(isTransientSqlError(err)).toBe(true);
      expect(classifyOutboxFailure(err).kind).toBe('server-transient');
    }
    // ...and a genuine semantic rejection is still terminal.
    expect(isTransientSqlError(new Error('invalid_recipient'))).toBe(false);
    expect(classifyOutboxFailure(Object.assign(new Error('invalid_recipient'), {status: 400})).kind)
      .toBe('rejected');
  });

  test.each([
    ['the RN offline rejection', new TypeError('Network request failed')],
    ['the SN-01 abort',          Object.assign(new Error('Aborted'), {name: 'AbortError'})],
  ])('classifies %s as unreachable', (_label, err) => {
    expect(classifyOutboxFailure(err).kind).toBe('unreachable');
  });

  test('carries Retry-After through, clamped to the backoff ceiling', () => {
    expect(classifyOutboxFailure(new RelayHttpError(429, 'slow down', undefined, 7_000)).retryAfterMs)
      .toBe(7_000);
    // F-3 (B-693) — ceiling value re-pointed with the halved ladder (2min).
    expect(classifyOutboxFailure(new RelayHttpError(429, 'slow down', undefined, 10 * 60_000)).retryAfterMs)
      .toBe(120_000);
    expect(classifyOutboxFailure(new RelayHttpError(500, 'boom')).retryAfterMs).toBeUndefined();
  });
});

describe('XO-5 — isPermanentRelayRejection classification', () => {
  test.each([
    ['a 400 relay rejection', Object.assign(new Error('invalid_outer_sealed'), {name: 'RelayHttpError', status: 400})],
    ['a 413 payload cap',     Object.assign(new Error('too large'), {name: 'RelayHttpError', status: 413})],
  ])('treats %s as permanent', (_label, err) => {
    expect(isPermanentRelayRejection(err)).toBe(true);
  });

  test.each([
    ['a 429 throttle',   Object.assign(new Error('slow'), {name: 'RelayHttpError', status: 429})],
    ['a 401 refresh',    Object.assign(new Error('no_token'), {name: 'RelayHttpError', status: 401})],
    ['a 500',            Object.assign(new Error('boom'), {name: 'RelayHttpError', status: 500})],
    ['an offline error', new TypeError('Network request failed')],
    ['a sibling class',  Object.assign(new Error('bad'), {name: 'MediaHttpError', status: 400})],
  ])('does NOT treat %s as permanent', (_label, err) => {
    expect(isPermanentRelayRejection(err)).toBe(false);
  });
});

describe('SRV-01 — isBackpressureError classification', () => {
  test('classifies a 429 and relay_queue_full as backpressure, not unreachable', () => {
    const e429 = Object.assign(new Error('ThrottlerException: Too Many Requests'), {status: 429});
    expect(isBackpressureError(e429)).toBe(true);
    expect(isUnreachableError(e429)).toBe(false);
    expect(isBackpressureError(new Error('relay_queue_full'))).toBe(true);
    expect(isBackpressureError(new Error('No record for U.1'))).toBe(false);
  });
});

describe('RT-3 — deferred/cert-metadata payloads ride the opaque TEXT column', () => {
  test('a sealed-direct payload round-trips byte-identical (no migration needed)', async () => {
    const {store} = make();
    const payload = JSON.stringify({
      outerSealed: 'SEALED', expiresAtSec: 123, certExpSec: 456,
      resealKind: 'direct', body: 'hello', replyTo: {msgId: 'r1', preview: 'p'},
      clientMsgId: 'cm-1',
    });
    await store.enqueue(row({clientMsgId: 'cm-1', payload}));
    const due = await store.dueRows(Date.now() + 1_000_000);
    expect(due).toHaveLength(1);
    expect(due[0].payload).toBe(payload);
    const plan = planOutboxDrain(due[0].payload, 456_000 + 10_000_000);
    expect(plan.mode).toBe('reseal');
  });

  test('XO-2 — a direct deferred intent round-trips and routes to reseal', async () => {
    const {store} = make();
    const payload = JSON.stringify({
      deferred: true, direct: true, body: 'queued offline', clientMsgId: 'cm-2',
    });
    await store.enqueue(row({clientMsgId: 'cm-2', payload}));
    const due = await store.dueRows(Date.now() + 1_000_000);
    const plan = planOutboxDrain(due[0].payload);
    expect(plan.mode).toBe('reseal');
    if (plan.mode === 'reseal') { expect(isDeferredDirect(plan.payload)).toBe(true); }
  });

  test('XO-2 — group cert-failure fan-out writes one deferred row per member', async () => {
    const {store, table} = make();
    const payload = JSON.stringify({
      deferred: true, sealedBody: 'sb', groupId: 'g1', kind: 'text', clientMsgId: 'cm-3',
    });
    for (const peer of ['alice', 'bob', 'carol']) {
      await store.enqueue(row({clientMsgId: 'cm-3', peerUserId: peer, payload}));
    }
    expect(table).toHaveLength(3);
    for (const r of await store.dueRows(Date.now() + 1_000_000)) {
      expect(planOutboxDrain(r.payload).mode).toBe('reseal');
    }
  });

  test('OM-05 — dueRows carries createdAt (the compose moment the re-seal rides on)', async () => {
    const {store} = make();
    const before = Date.now();
    await store.enqueue(row({clientMsgId: 'cm-ts'}));
    const after = Date.now();
    const [due] = await store.dueRows(Date.now() + 1_000_000);
    expect(due.createdAt).toBeGreaterThanOrEqual(before);
    expect(due.createdAt).toBeLessThanOrEqual(after);
  });

  test("GF-2 — a groupkey: row survives the group's Clear-chat delete", async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'key-1', conversationId: 'groupkey:G1',
      payload: JSON.stringify({outerSealed: 'K', keyMaterial: true, urgent: false})}));
    await store.enqueue(row({clientMsgId: 'txt-1', conversationId: 'G1'}));
    await store.deleteByConversation('G1');
    expect(table.map(r => r.client_msg_id)).toEqual(['key-1']);
  });

  test('SN-04 — an unreachable attempt on a deferred row spends no budget', async () => {
    const {store, table} = make();
    const payload = JSON.stringify({
      deferred: true, direct: true, body: 'queued offline', clientMsgId: 'cm-4',
    });
    await store.enqueue(row({clientMsgId: 'cm-4', payload}));
    const before = table[0].next_retry_at as number;
    const res = await store.recordAttempt('cm-4', 'bob', 1, {unreachable: true});
    expect(res).toMatchObject({attempts: 0, failed: false, queued: true});
    expect(table[0].attempts).toBe(0);
    expect(table[0].next_retry_at as number).toBeGreaterThan(before);
  });
});
