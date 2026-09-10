/**
 * Schema v18 — @-mentions, edit-sent-message and delete-for-everyone must
 * survive a restart, against a REAL SQLite engine.
 *
 * Why a real engine and not a hand-rolled fake: every one of these three
 * fields fails in a DANGEROUS direction if it only ever lived in memory.
 *   - a lost `edited_at` shows the OLD body after every relaunch, so the
 *     author believes they corrected something they did not;
 *   - a lost `deleted_for_all` RESURRECTS content the author already retracted
 *     for everyone — the single worst outcome in this whole feature set;
 *   - a lost `mentions` silently kills the highlight and the "you were
 *     mentioned" signal.
 * A regex-matching fake DbHandle (see sqlOutboxStore.test.ts) cannot see a
 * missing column or a placeholder-count mismatch — the INSERT would simply
 * bind the wrong values into the wrong columns and still "pass".
 *
 * The schema is the REAL exported DDL, never a copy: a copied schema pins its
 * own copy and drifts (the B-129 class).
 */

jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));

import {DatabaseSync} from 'node:sqlite';
import {DDL} from '../crypto/db';
import {SqlMessageStore} from '../store/sqlMessageStore';
import type {LocalMessage} from '../store/types';

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
        if (isRead) {return {rows: stmt.all(...bound) as unknown[]};}
        stmt.run(...bound);
        return {rows: []};
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

function msg(id: string, over: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id,
    conversation_id: 'g-1',
    sender_id:       'peer-1',
    type:            'text',
    content:         `body-${id}`,
    status:          'delivered',
    is_encrypted:    false,
    created_at:      '2026-07-25T10:00:00.000Z',
    peer:            {userId: 'peer-1', deviceId: 1},
    envelope_id:     `env-${id}`,
    ...over,
  } as unknown as LocalMessage;
}

let engine: ReturnType<typeof makeEngineDb>;
let store: SqlMessageStore;

beforeEach(() => {
  engine = makeEngineDb();
  applySchema(engine.raw);
  store = new SqlMessageStore(engine.db as never);
});

afterEach(() => { engine.raw.close(); });

describe('schema v18 — the columns exist on the real table', () => {
  it('declares mentions_json, edited_at and deleted_for_all', () => {
    const cols = (engine.raw.prepare('PRAGMA table_info(messages)').all() as {name: string}[])
      .map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(['mentions_json', 'edited_at', 'deleted_for_all']));
  });

  it('the INSERT binds every declared column — placeholder count matches', async () => {
    // A miscount here does not throw at type-check time and does not throw in a
    // regex fake; a real engine rejects it. This is the whole reason the test
    // uses one.
    await expect(store.upsert(msg('m1'))).resolves.toBeUndefined();
  });
});

describe('mentions round-trip', () => {
  it('persists and reloads a mention list', async () => {
    const mentions = [{userId: 'u-alice', label: 'Alice'}, {userId: 'u-bob', label: 'Bob R'}];
    await store.upsert(msg('m1', {mentions}));
    const back = (await store.loadAll())['g-1'][0];
    expect(back.mentions).toEqual(mentions);
  });

  it('an empty list is stored as NULL and reads back undefined, not []', async () => {
    // `[]` and `undefined` must not both be reachable — the renderer branches
    // on presence, and two representations of "nobody" is how a highlight path
    // ends up conditionally dead.
    await store.upsert(msg('m1', {mentions: []}));
    const row = engine.raw.prepare('SELECT mentions_json FROM messages WHERE id = ?').get('m1') as {mentions_json: string | null};
    expect(row.mentions_json).toBeNull();
    expect((await store.loadAll())['g-1'][0].mentions).toBeUndefined();
  });

  it('a corrupt mentions_json degrades to undefined instead of crashing the renderer', async () => {
    await store.upsert(msg('m1'));
    engine.raw.prepare('UPDATE messages SET mentions_json = ? WHERE id = ?').run('{not json', 'm1');
    expect((await store.loadAll())['g-1'][0].mentions).toBeUndefined();
  });

  it('drops malformed ENTRIES rather than handing the renderer a bad element', async () => {
    await store.upsert(msg('m1'));
    engine.raw.prepare('UPDATE messages SET mentions_json = ? WHERE id = ?')
      .run(JSON.stringify([{userId: 'u-a', label: 'A'}, {userId: 5}, null, 'nope']), 'm1');
    expect((await store.loadAll())['g-1'][0].mentions).toEqual([{userId: 'u-a', label: 'A'}]);
  });

  it('a non-array mentions_json is rejected wholesale', async () => {
    await store.upsert(msg('m1'));
    engine.raw.prepare('UPDATE messages SET mentions_json = ? WHERE id = ?')
      .run(JSON.stringify({userId: 'u-a', label: 'A'}), 'm1');
    expect((await store.loadAll())['g-1'][0].mentions).toBeUndefined();
  });
});

describe('edit round-trip', () => {
  it('persists edited_at alongside the replacement body', async () => {
    await store.upsert(msg('m1', {content: 'corrected', edited_at: 1_700_000_000_000}));
    const back = (await store.loadAll())['g-1'][0];
    expect(back.content).toBe('corrected');
    expect(back.edited_at).toBe(1_700_000_000_000);
  });

  it('a never-edited row reads back with edited_at undefined', async () => {
    await store.upsert(msg('m1'));
    expect((await store.loadAll())['g-1'][0].edited_at).toBeUndefined();
  });

  it('re-upserting the same id overwrites the body AND the edit stamp', async () => {
    await store.upsert(msg('m1', {content: 'v1'}));
    await store.upsert(msg('m1', {content: 'v2', edited_at: 42}));
    const rows = (await store.loadAll())['g-1'];
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('v2');
    expect(rows[0].edited_at).toBe(42);
  });
});

describe('delete-for-everyone round-trip', () => {
  it('persists the tombstone flag', async () => {
    await store.upsert(msg('m1', {content: '', deleted_for_all: true}));
    expect((await store.loadAll())['g-1'][0].deleted_for_all).toBe(true);
  });

  it('a live row reads back with deleted_for_all undefined, never false', async () => {
    // The renderer tests truthiness; storing an explicit 0 would be equivalent
    // today but would make `deleted_for_all in msg` true for a live row, which
    // the backup mirror's row-diffing does look at.
    await store.upsert(msg('m1'));
    expect((await store.loadAll())['g-1'][0].deleted_for_all).toBeUndefined();
  });

  it('the tombstone SURVIVES a reload — the resurrection case this feature must never hit', async () => {
    await store.upsert(msg('m1', {content: 'secret', deleted_for_all: true}));
    // Simulate a fresh boot: a brand-new store instance over the same file.
    const rebooted = new SqlMessageStore(engine.db as never);
    const back = (await rebooted.loadRecent(50))['g-1'][0];
    expect(back.deleted_for_all).toBe(true);
  });

  it('the tombstone survives loadOlder paging too', async () => {
    await store.upsert(msg('m0', {created_at: '2026-07-25T09:00:00.000Z', deleted_for_all: true}));
    await store.upsert(msg('m1', {created_at: '2026-07-25T10:00:00.000Z'}));
    const older = await store.loadOlder('g-1', '2026-07-25T10:00:00.000Z', 'm1', 10);
    expect(older.map(m => m.id)).toEqual(['m0']);
    expect(older[0].deleted_for_all).toBe(true);
  });
});
