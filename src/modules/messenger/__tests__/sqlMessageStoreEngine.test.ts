/**
 * M8 — "N inbound envelopes produce exactly N rows, in order, no duplicates."
 *
 * This is the first test in the repo that runs a REAL SQLite engine.
 *
 * Why that matters: M8 is a DDL property, not application logic. The entire
 * exactly-once guarantee is `PRIMARY KEY (conversation_id, id)` in
 * crypto/db.ts plus `INSERT OR REPLACE INTO messages` in sqlMessageStore.ts.
 * Every other defence (appendMessage's three dedups, SeenEnvelopeStore,
 * inFlightEnvelopes) is depth on top of it. Until now every DbHandle in the
 * suite was a hand-written fake that regex-matched SQL text — see
 * sqlOutboxStore.test.ts ("Hand-rolled mini SQLite engine that understands
 * only the queries the outbox store actually emits") — so the PK collapse,
 * the REPLACE overwrite semantics and index uniqueness were asserted by
 * NOTHING. The property was invisible to the suite by construction.
 *
 * The engine is `node:sqlite`, built into Node 22+. No new dependency, no
 * native compilation. The schema is the REAL exported DDL, never a copy — a
 * copied schema would drift and pin its own copy (the B-129 class).
 *
 * Scope: this pins storage semantics only. SQLCipher page encryption is not
 * exercised (node:sqlite is plain SQLite); that is a native concern and is
 * covered by the on-device checks in MESSAGE_LOOP.md §8.
 */

// crypto/db.ts imports the op-sqlite NATIVE module, which cannot load in the
// node test environment (the messenger-crypto jest project runs
// testEnvironment 'node' with no RN preset). We only want its DDL constant, so
// stub the native binding — same approach as wipeAtRest.test.ts and
// compartmentedDbHardening.test.ts.
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));

import {DatabaseSync} from 'node:sqlite';
import {DDL} from '../crypto/db';
import {SqlMessageStore} from '../store/sqlMessageStore';
import type {LocalMessage} from '../store/types';

// The receive-txn runner wraps upsertBatch in BEGIN IMMEDIATE/COMMIT. Keep it
// real — serialisation is part of what we are pinning — but it needs no mock:
// it only calls db.execute, which our adapter implements faithfully.

interface ExecResult {rows?: unknown[]}

/** Adapts node:sqlite to the op-sqlite `DbHandle` surface the store uses. */
function makeEngineDb(): {db: {execute(sql: string, params?: unknown[]): Promise<ExecResult>}; raw: DatabaseSync} {
  const raw = new DatabaseSync(':memory:');
  return {
    raw,
    db: {
      async execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
        const trimmed = sql.trim();
        // node:sqlite rejects parameters on statements that take none, and
        // exposes reads via .all() / writes via .run().
        const isRead = /^\s*(SELECT|PRAGMA)/i.test(trimmed);
        const stmt = raw.prepare(trimmed);
        const bound = params.map(p => (p === undefined ? null : p)) as never[];
        if (isRead) {
          return {rows: stmt.all(...bound) as unknown[]};
        }
        // Faithful to op-sqlite's QueryResult (edge review, audit #20):
        // rowsAffected is REQUIRED there; keep every engine adapter on
        // the same honest surface.
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
      // The DDL array carries idempotent ALTERs for older installs (e.g.
      // "ALTER TABLE messages ADD COLUMN media_meta_json") which fail once
      // the CREATE already declared the column. Real runMigrations tolerates
      // the same, so skip only that class and let anything else fail loudly.
      const errText = (e as Error).message;
      if (!/duplicate column name|already exists/i.test(errText)) {throw e;}
    }
  }
}

function msg(id: string, conversationId: string, over: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id,
    conversation_id: conversationId,
    sender_id: 'peer-1',
    type: 'text',
    content: `body-${id}`,
    status: 'delivered',
    is_encrypted: false,
    created_at: new Date(Date.parse('2026-07-21T10:00:00.000Z') + Number(id.replace(/\D/g, '') || 0) * 1000).toISOString(),
    peer: {userId: 'peer-1', deviceId: 1},
    envelope_id: `env-${id}`,
    ...over,
  } as unknown as LocalMessage;
}

function countRows(raw: DatabaseSync): number {
  const r = raw.prepare('SELECT COUNT(*) AS n FROM messages').get() as {n: number};
  return r.n;
}

describe('M8 — exactly-once persistence, against a REAL SQLite engine', () => {
  let raw: DatabaseSync;
  let store: SqlMessageStore;

  beforeEach(() => {
    const h = makeEngineDb();
    raw = h.raw;
    applySchema(raw);
    store = new SqlMessageStore(h.db as never);
  });

  afterEach(() => {
    raw.close();
  });

  it('the real DDL declares the composite primary key the guarantee rests on', () => {
    const sql = (raw.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'",
    ).get() as {sql: string}).sql;
    expect(sql).toMatch(/PRIMARY KEY\s*\(\s*conversation_id\s*,\s*id\s*\)/);
  });

  it('N distinct envelopes produce exactly N rows', async () => {
    const N = 100;
    for (let i = 0; i < N; i++) {
      await store.upsert(msg(`m${i}`, 'conv-1'));
    }
    expect(countRows(raw)).toBe(N);
  });

  it('reads back in send order regardless of insertion order', async () => {
    await store.upsert(msg('m3', 'conv-1'));
    await store.upsert(msg('m1', 'conv-1'));
    await store.upsert(msg('m2', 'conv-1'));

    const rows = raw.prepare(
      'SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
    ).all('conv-1') as Array<{id: string}>;
    expect(rows.map(r => r.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('a redelivered envelope collapses onto one row (INSERT OR REPLACE + PK)', async () => {
    await store.upsert(msg('m1', 'conv-1'));
    await store.upsert(msg('m1', 'conv-1'));
    expect(countRows(raw)).toBe(1);
  });

  it('DOCUMENTS A SHARP EDGE: same (conversation_id, id), different body ⇒ the first body is LOST', async () => {
    // The id is SENDER-supplied (`unwrapped.clientMsgId ?? makeId()`), so a
    // peer that reuses a clientMsgId with different content silently
    // overwrites the earlier row on disk. The in-memory store forks the id
    // instead (messengerStore `${id}#${len}`), so memory and disk disagree —
    // that divergence is M12/W14, not fixed here. This test pins the CURRENT
    // disk behaviour so the fix has something to flip.
    await store.upsert(msg('m1', 'conv-1', {content: 'first'}));
    await store.upsert(msg('m1', 'conv-1', {content: 'second'}));
    expect(countRows(raw)).toBe(1);
    const row = raw.prepare('SELECT content FROM messages WHERE id = ?').get('m1') as {content: string};
    expect(row.content).toBe('second');
  });

  it('FLIPPED by AUDIT #14: one envelope_id under two ids ⇒ the second is REJECTED (unique index)', async () => {
    // This DOCUMENTS test pinned the sharp edge ("the database cannot
    // catch a duplicate that slipped past the in-memory dedup") until the
    // fix landed; the v20 partial UNIQUE index is that fix.
    await store.upsert(msg('m1', 'conv-1', {envelope_id: 'env-dup'}));
    await expect(store.upsert(msg('m2', 'conv-1', {envelope_id: 'env-dup'})))
      .rejects.toThrow(/UNIQUE constraint failed/i);
    expect(countRows(raw)).toBe(1);
  });

  it('FLIPPED by AUDIT #14: the B-124 alias (same envelope, second slot) is now VISIBLE to the DB', async () => {
    // The old comment said "no schema change can catch id-aliasing; only
    // the topology rule (M1) can" — the envelope-unique index falsifies
    // that for the realistic alias shape: re-filing the SAME message
    // (same envelope) under a second conversation slot now throws.
    await store.upsert(msg('m1', 'direct:peer-1'));
    await expect(store.upsert(msg('m1', 'uuid-conv')))
      .rejects.toThrow(/UNIQUE constraint failed/i);
    expect(countRows(raw)).toBe(1);
  });

  it('distinct messages under two conversation slots remain TWO legitimate rows (the PK property)', async () => {
    // The PK includes conversation_id, so two rows sharing an id but
    // carrying DIFFERENT envelopes are distinct — the unique index only
    // rejects the same-envelope alias above.
    await store.upsert(msg('m1', 'direct:peer-1'));
    await store.upsert(msg('m1', 'uuid-conv', {envelope_id: 'env-other'}));
    expect(countRows(raw)).toBe(2);
  });

  it('a batch of N distinct rows commits exactly N (upsertBatch shares the txn runner)', async () => {
    const batch = Array.from({length: 25}, (_, i) => msg(`b${i}`, 'conv-2'));
    await store.upsertBatch(batch);
    expect(countRows(raw)).toBe(25);
  });

  it('a batch containing a redelivery still commits one row per distinct id', async () => {
    await store.upsertBatch([
      msg('b1', 'conv-2'),
      msg('b2', 'conv-2'),
      msg('b1', 'conv-2'),
    ]);
    expect(countRows(raw)).toBe(2);
  });
});

/**
 * B-636 — `searchContent`, against the SAME real engine.
 *
 * A hand-rolled fake would have to re-implement `LIKE`, `ESCAPE`, `IN` and the
 * NULL-vs-0 semantics of `deleted_for_all` in order to answer, and it would then
 * be asserting its own re-implementation. Every property below is a property of
 * SQL, so it is worth nothing unless SQL evaluates it:
 *
 *   - the conversation allow-list is a BOUNDARY (empty ⇒ nothing, never all)
 *   - `%` and `_` typed by a user are LITERAL, not wildcards
 *   - a deleted-for-everyone body and an expired disappearing message are
 *     unreachable — a search that resurrects deleted text is the exact class
 *     this repo shipped in B-594/B-605
 */
describe('B-636 — searchContent, against a REAL SQLite engine', () => {
  let raw: DatabaseSync;
  let store: SqlMessageStore;

  beforeEach(() => {
    const h = makeEngineDb();
    raw = h.raw;
    applySchema(raw);
    store = new SqlMessageStore(h.db as never);
  });

  afterEach(() => {
    raw.close();
  });

  /** A row with an explicit body and stamp — the file-level `msg` derives its
   *  timestamp from digits in the id, which is not controllable enough here. */
  function body(id: string, conversationId: string, content: string, iso: string, over: Partial<LocalMessage> = {}): LocalMessage {
    return {
      id,
      conversation_id: conversationId,
      sender_id: 'peer-1',
      type: 'text',
      content,
      status: 'delivered',
      is_encrypted: false,
      created_at: iso,
      peer: {userId: 'peer-1', deviceId: 1},
      envelope_id: `env-${id}`,
      ...over,
    } as unknown as LocalMessage;
  }

  const T1 = '2026-08-20T09:00:00.000Z';
  const T2 = '2026-08-20T10:00:00.000Z';
  const T3 = '2026-08-20T11:00:00.000Z';

  it('finds a message by a word inside its body', async () => {
    await store.upsert(body('m1', 'conv-a', 'please sign the contract today', T1));
    const out = await store.searchContent('contract', {conversationIds: ['conv-a'], limit: 10});
    expect(out.map(m => m.id)).toEqual(['m1']);
  });

  it('is ASCII-case-insensitive, like the LIKE it is built on', async () => {
    await store.upsert(body('m1', 'conv-a', 'The CONTRACT is signed', T1));
    const out = await store.searchContent('contract', {conversationIds: ['conv-a'], limit: 10});
    expect(out.map(m => m.id)).toEqual(['m1']);
  });

  it('returns newest-first', async () => {
    await store.upsert(body('m1', 'conv-a', 'contract one',   T1));
    await store.upsert(body('m2', 'conv-a', 'contract two',   T3));
    await store.upsert(body('m3', 'conv-a', 'contract three', T2));
    const out = await store.searchContent('contract', {conversationIds: ['conv-a'], limit: 10});
    expect(out.map(m => m.id)).toEqual(['m2', 'm3', 'm1']);
  });

  it('honours the limit', async () => {
    for (let i = 0; i < 8; i++) {
      await store.upsert(body(`m${i}`, 'conv-a', `contract ${i}`, `2026-08-20T0${i}:00:00.000Z`));
    }
    const out = await store.searchContent('contract', {conversationIds: ['conv-a'], limit: 3});
    expect(out).toHaveLength(3);
  });

  // The allow-list is the scope boundary.

  it('NEVER returns a conversation outside the allow-list', async () => {
    await store.upsert(body('mine',    'conv-a', 'our contract', T1));
    await store.upsert(body('foreign', 'conv-b', 'their contract', T2));
    const out = await store.searchContent('contract', {conversationIds: ['conv-a'], limit: 10});
    expect(out.map(m => m.id)).toEqual(['mine']);
  });

  it('an EMPTY allow-list returns NOTHING - it is never read as "no filter"', async () => {
    await store.upsert(body('m1', 'conv-a', 'the contract', T1));
    const out = await store.searchContent('contract', {conversationIds: [], limit: 10});
    expect(out).toEqual([]);
  });

  it('spans more conversations than one statement may bind, still newest-first', async () => {
    // 450 ids exceeds SEARCH_ID_CHUNK (400), so this exercises the chunk merge.
    // The two matches sit in DIFFERENT chunks and out of order, which is the
    // case a naive concatenation gets wrong.
    const ids = Array.from({length: 450}, (_, i) => `conv-${i}`);
    await store.upsert(body('early', 'conv-5',   'contract early', T1));
    await store.upsert(body('late',  'conv-430', 'contract late',  T3));
    const out = await store.searchContent('contract', {conversationIds: ids, limit: 10});
    expect(out.map(m => m.id)).toEqual(['late', 'early']);
  });

  it('applies the cap ACROSS chunks, not per chunk', async () => {
    const ids = Array.from({length: 450}, (_, i) => `conv-${i}`);
    await store.upsert(body('a', 'conv-1',   'contract a', T1));
    await store.upsert(body('b', 'conv-2',   'contract b', T2));
    await store.upsert(body('c', 'conv-410', 'contract c', T3));
    const out = await store.searchContent('contract', {conversationIds: ids, limit: 2});
    expect(out.map(m => m.id)).toEqual(['c', 'b']);
  });

  // LIKE wildcards in user input are literal.

  it('treats a typed percent sign as text, not "match everything"', async () => {
    await store.upsert(body('pct',   'conv-a', 'discount is 15% today', T2));
    await store.upsert(body('plain', 'conv-a', 'no symbol here',        T1));
    const out = await store.searchContent('%', {conversationIds: ['conv-a'], limit: 10});
    expect(out.map(m => m.id)).toEqual(['pct']);
  });

  it('treats a typed underscore as text, not "any single character"', async () => {
    await store.upsert(body('under', 'conv-a', 'file_name.pdf', T2));
    await store.upsert(body('other', 'conv-a', 'fileXname.pdf', T1));
    const out = await store.searchContent('file_name', {conversationIds: ['conv-a'], limit: 10});
    expect(out.map(m => m.id)).toEqual(['under']);
  });

  it('treats a typed backslash as text (the escape character itself)', async () => {
    await store.upsert(body('slash', 'conv-a', 'path C:\\reports\\q3', T2));
    await store.upsert(body('plain', 'conv-a', 'path C:reportsq3',    T1));
    const out = await store.searchContent('C:\\reports', {conversationIds: ['conv-a'], limit: 10});
    expect(out.map(m => m.id)).toEqual(['slash']);
  });

  // What a search must never surface.

  it('cannot resurrect a delete-for-everyone body', async () => {
    // The app blanks the body when it applies the tombstone, so this row is
    // deliberately UNBLANKED: the column is the guard being pinned, and this is
    // the state a future change to the apply path would produce.
    await store.upsert(body('gone', 'conv-a', 'the secret contract', T2, {deleted_for_all: true} as Partial<LocalMessage>));
    await store.upsert(body('live', 'conv-a', 'the live contract',   T1));
    const out = await store.searchContent('contract', {conversationIds: ['conv-a'], limit: 10});
    expect(out.map(m => m.id)).toEqual(['live']);
  });

  it('a row with deleted_for_all NULL (every pre-tombstone row) is still searchable', async () => {
    // The guard is "IS NULL OR = 0". Written as "= 0" alone it would hide every
    // legacy row, i.e. almost the whole history - a silently empty search.
    await store.upsert(body('legacy', 'conv-a', 'legacy contract', T1));
    raw.exec("UPDATE messages SET deleted_for_all = NULL WHERE id = 'legacy'");
    const out = await store.searchContent('contract', {conversationIds: ['conv-a'], limit: 10});
    expect(out.map(m => m.id)).toEqual(['legacy']);
  });

  it('cannot surface an EXPIRED disappearing message', async () => {
    await store.upsert(body('expired', 'conv-a', 'expired contract', T2, {expires_at: Date.now() - 60000} as Partial<LocalMessage>));
    await store.upsert(body('future',  'conv-a', 'future contract',  T1, {expires_at: Date.now() + 600000} as Partial<LocalMessage>));
    const out = await store.searchContent('contract', {conversationIds: ['conv-a'], limit: 10});
    expect(out.map(m => m.id)).toEqual(['future']);
  });

  it('searches TEXT rows only - a media caption is not a body', async () => {
    await store.upsert(body('img', 'conv-a', 'contract.png', T2, {type: 'image'} as Partial<LocalMessage>));
    await store.upsert(body('txt', 'conv-a', 'contract text', T1));
    const out = await store.searchContent('contract', {conversationIds: ['conv-a'], limit: 10});
    expect(out.map(m => m.id)).toEqual(['txt']);
  });

  it('a blank or whitespace-only query returns nothing rather than every row', async () => {
    await store.upsert(body('m1', 'conv-a', 'anything', T1));
    expect(await store.searchContent('',    {conversationIds: ['conv-a'], limit: 10})).toEqual([]);
    expect(await store.searchContent('   ', {conversationIds: ['conv-a'], limit: 10})).toEqual([]);
  });

  it('a non-positive limit returns nothing rather than SQL-erroring', async () => {
    await store.upsert(body('m1', 'conv-a', 'the contract', T1));
    expect(await store.searchContent('contract', {conversationIds: ['conv-a'], limit: 0})).toEqual([]);
  });
});
