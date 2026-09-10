/**
 * AUDIT-2026-08-13 #14 — exactly-once at the SCHEMA layer: one physical
 * row per relay envelope (real engine, real DDL — the B-129 anti-drift
 * pattern from sqlMessageStoreEngine).
 *
 * Before this landed, exactly-once was app-layer only (`seen_envelopes`):
 * any seen-gate miss produced a second row for the same envelope under a
 * fresh random id — a duplicate bubble surviving restarts. And the naive
 * fix (bare UNIQUE index) would have been WORSE than the disease: doUpsert
 * used INSERT OR REPLACE, which resolves ANY constraint by deleting the
 * conflicting row — a redelivered envelope would have silently REPLACED
 * the original message, losing its reactions/receipts/retract tokens.
 */
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));

import {DatabaseSync} from 'node:sqlite';
import {SqlMessageStore} from '../store/sqlMessageStore';
import {DDL, V20_ENVELOPE_MIGRATION_SQL} from '../crypto/db';
import type {LocalMessage} from '../store/types';

function realEngine(opts: {skipUniqueIndex?: boolean} = {}) {
  const raw = new DatabaseSync(':memory:');
  for (const stmt of DDL) {
    if (opts.skipUniqueIndex && /idx_messages_envelope_unique/.test(stmt)) {continue;}
    try {
      raw.exec(stmt);
    } catch (e) {
      if (!/duplicate column name|already exists/i.test((e as Error).message)) {throw e;}
    }
  }
  const db = {
    async execute(sql: string, params: unknown[] = []) {
      const stmt = raw.prepare(sql.trim());
      const bound = params.map(p => (p === undefined ? null : p)) as never[];
      if (/^\s*(SELECT|PRAGMA)/i.test(sql)) {return {rows: stmt.all(...bound) as unknown[]};}
      stmt.run(...bound);
      return {rows: []};
    },
  };
  return {raw, db, store: new SqlMessageStore(db as never)};
}

function msg(id: string, envelopeId: string | undefined, over: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id, conversation_id: 'c1', sender_id: 'peer-1', type: 'text',
    content: `body-${id}`, status: 'delivered', is_encrypted: true,
    created_at: new Date(1000).toISOString(),
    peer: {userId: 'peer-1', deviceId: 1},
    envelope_id: envelopeId,
    ...over,
  } as LocalMessage;
}

describe('AUDIT #14 — the unique envelope index on a real engine', () => {
  it('a redelivered envelope under a NEW id is REJECTED — the original row and its reactions survive', async () => {
    const {store, raw} = realEngine();
    await (store as never as {upsert: (m: LocalMessage) => Promise<void>}).upsert(
      msg('orig', 'env-A', {reactions: {alice: '👍'}}));
    // The seen-gate missed; the receive path re-processed env-A under a
    // fresh random id. Pre-#14 with OR REPLACE + unique index this DELETED
    // 'orig'; pre-#14 without the index it duplicated the bubble.
    await expect(
      (store as never as {upsert: (m: LocalMessage) => Promise<void>}).upsert(msg('redelivered', 'env-A')),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
    const rows = raw.prepare('SELECT id, reactions_json FROM messages').all() as Array<{id: string; reactions_json: string}>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('orig');
    expect(rows[0].reactions_json).toContain('👍');
  });

  it('PK-targeted updates still work in place (status flip keeps the same envelope_id — no self-collision)', async () => {
    const {store, raw} = realEngine();
    const up = (store as never as {upsert: (m: LocalMessage) => Promise<void>}).upsert.bind(store);
    await up(msg('m1', 'env-B', {status: 'delivered'}));
    await up(msg('m1', 'env-B', {status: 'read', reactions: {bob: '❤️'}}));
    const rows = raw.prepare('SELECT id, status, reactions_json FROM messages').all() as Array<{id: string; status: string; reactions_json: string}>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('read');
    expect(rows[0].reactions_json).toContain('❤️');
  });

  it('NULL envelope_ids never collide (sent rows, pre-envelope rows)', async () => {
    const {store, raw} = realEngine();
    const up = (store as never as {upsert: (m: LocalMessage) => Promise<void>}).upsert.bind(store);
    await up(msg('s1', undefined));
    await up(msg('s2', undefined));
    expect((raw.prepare('SELECT COUNT(*) AS n FROM messages').get() as {n: number}).n).toBe(2);
  });

  it('BATCH ingestion (restore) skips a duplicate-envelope row instead of failing the whole restore', async () => {
    // The server mirror can hold PRE-FIX duplicates; a restore that throws
    // on them would fail permanently (the B-45 class). upsertBatch rides
    // writeRows, whose tolerance skips exactly the envelope-unique
    // violation and lands everything else.
    const {store, raw} = realEngine();
    const up = (store as never as {upsert: (m: LocalMessage) => Promise<void>}).upsert.bind(store);
    await up(msg('orig', 'env-C'));
    const skipped = await store.upsertBatch([
      msg('other-1', 'env-D'),
      msg('dup-of-C', 'env-C'), // the pre-fix duplicate — must be skipped
      msg('other-2', 'env-E'),
    ]);
    // AUDIT #14 (critic) — the skip is COUNTED so the restore's completion
    // tally can distinguish "succeeded" from "rows silently absent".
    expect(skipped).toBe(1);
    const ids = (raw.prepare('SELECT id FROM messages ORDER BY id').all() as Array<{id: string}>).map(r => r.id);
    expect(ids).toEqual(['orig', 'other-1', 'other-2']);
  });
});

describe('AUDIT #14 — the v20 migration on a real engine', () => {
  it('dedups keeping the OLDEST row per envelope, then builds the index; boot tolerates the pre-dedup DDL failure', async () => {
    // Simulate a v19 install: full DDL minus the unique index, with
    // pre-fix duplicates present.
    const {raw, db} = realEngine({skipUniqueIndex: true});
    raw.exec(`INSERT INTO messages (id, conversation_id, sender_id, type, status, is_encrypted, created_at, peer_user_id, peer_device_id, envelope_id)
              VALUES ('old', 'c1', 'p', 'text', 'read', 1, '2026-01-01', 'p', 1, 'env-X')`);
    raw.exec(`INSERT INTO messages (id, conversation_id, sender_id, type, status, is_encrypted, created_at, peer_user_id, peer_device_id, envelope_id)
              VALUES ('newer-dup', 'c1', 'p', 'text', 'delivered', 1, '2026-02-01', 'p', 1, 'env-X')`);
    raw.exec(`INSERT INTO messages (id, conversation_id, sender_id, type, status, is_encrypted, created_at, peer_user_id, peer_device_id, envelope_id)
              VALUES ('unrelated', 'c1', 'p', 'text', 'read', 1, '2026-01-15', 'p', 1, 'env-Y')`);

    // The DDL's CREATE UNIQUE INDEX fails on the dups — the boot-tolerance
    // lane must swallow EXACTLY that failure (narrow: this index only).
    let uniqueDdlError: Error | null = null;
    try {
      raw.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_envelope_unique
                  ON messages (envelope_id) WHERE envelope_id IS NOT NULL`);
    } catch (e) { uniqueDdlError = e as Error; }
    expect(uniqueDdlError?.message).toMatch(/UNIQUE constraint failed/i);

    // The REAL v20 migration statements (edge F4: executing a hand-copied
    // mirror of the SQL is the B-129 trap — a drifted or deleted
    // migration body must go RED here, so we import and run the same
    // constants runMigrations executes).
    for (const stmt of V20_ENVELOPE_MIGRATION_SQL) {
      await db.execute(stmt);
    }

    const ids = (raw.prepare('SELECT id FROM messages ORDER BY id').all() as Array<{id: string}>).map(r => r.id);
    expect(ids).toEqual(['old', 'unrelated']); // within a conversation, the OLDEST survives
    const idx = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_envelope_unique'").all();
    expect(idx).toHaveLength(1);
  });

  it('CROSS-conversation dups (the B-124 alias pair) keep the NEWEST filing — the live slot, not the dead one', async () => {
    // Edge F3 — a v<20 install that lived through B-124 call-key
    // contamination can hold the same envelope under a dead `direct:`
    // slot AND the real conversation, with the contaminated alias filed
    // FIRST. Global MIN(rowid) would have kept the copy in the slot the
    // user never opens; the two-pass sweep keeps the newer filing,
    // matching remapConversation's prefer-the-new-slot rule.
    const {raw, db} = realEngine({skipUniqueIndex: true});
    raw.exec(`INSERT INTO messages (id, conversation_id, sender_id, type, status, is_encrypted, created_at, peer_user_id, peer_device_id, envelope_id)
              VALUES ('aliased', 'direct:dead-slot', 'p', 'text', 'read', 1, '2026-01-01', 'p', 1, 'env-B124')`);
    raw.exec(`INSERT INTO messages (id, conversation_id, sender_id, type, status, is_encrypted, created_at, peer_user_id, peer_device_id, envelope_id)
              VALUES ('refiled', 'live-conv', 'p', 'text', 'read', 1, '2026-01-02', 'p', 1, 'env-B124')`);
    for (const stmt of V20_ENVELOPE_MIGRATION_SQL) {
      await db.execute(stmt);
    }
    const rows = raw.prepare('SELECT id, conversation_id FROM messages').all() as Array<{id: string; conversation_id: string}>;
    expect(rows).toHaveLength(1);
    expect(rows[0].conversation_id).toBe('live-conv');
  });

  it('the migration BODY executes the exported constants (source pin — a deleted v20 block must go RED)', () => {

    const {readFileSync} = require('node:fs');

    const {join} = require('node:path');
    const src = readFileSync(join(__dirname, '..', 'crypto', 'db.ts'), 'utf8');
    const lines = src.split(/\r?\n/).map((l: string) => l.trim());
    // The silent failure mode this kills: the DDL tolerance swallows the
    // index failure, a broken/absent v20 block does nothing, the version
    // stamps 20, and no later boot ever re-enters.
    expect(lines.some((l: string) => l.startsWith('for (const stmt of V20_ENVELOPE_MIGRATION_SQL) {'))).toBe(true);
    const v20At = src.indexOf('if (fromVersion < 20) {');
    expect(v20At).toBeGreaterThan(-1);
    expect(src.indexOf('for (const stmt of V20_ENVELOPE_MIGRATION_SQL) {', v20At)).toBeGreaterThan(v20At);
  });

  it('the DDL boot-tolerance in db.ts is NARROW (source pin: that index only, UNIQUE failures only)', () => {

    const {readFileSync} = require('node:fs');

    const {join} = require('node:path');
    const src = readFileSync(join(__dirname, '..', 'crypto', 'db.ts'), 'utf8');
    const lines = src.split(/\r?\n/).map((l: string) => l.trim());
    expect(lines.some((l: string) =>
      l.startsWith('if (/UNIQUE constraint failed/i.test(msg) && /idx_messages_envelope_unique/.test(stmt)) {'))).toBe(true);
    // …and NO destructive/absorbing conflict-resolution class may target
    // messages (edge F1: a fresh `INSERT OR IGNORE INTO messages` writer
    // passed the old OR-REPLACE-only ban — IGNORE silently swallows
    // envelope collisions, the precise ghost this audit kills).
    const storeSrc = readFileSync(join(__dirname, '..', 'store', 'sqlMessageStore.ts'), 'utf8');
    expect(storeSrc).not.toMatch(/INSERT\s+OR\s+(REPLACE|IGNORE)\s+INTO\s+messages/i);
    expect(storeSrc).toContain('ON CONFLICT(conversation_id, id) DO UPDATE SET');
    // The PK target is the ONLY conflict clause any INTO-messages
    // statement carries (an ON CONFLICT(envelope_id) DO NOTHING would be
    // the same absorber in new clothes).
    const conflictClauses: string[] = storeSrc.match(/ON CONFLICT\([^)]*\)/g) ?? [];
    for (const c of conflictClauses) {
      if (storeSrc.slice(Math.max(0, storeSrc.indexOf(c) - 2000), storeSrc.indexOf(c)).includes('INTO messages')) {
        expect(c).toBe('ON CONFLICT(conversation_id, id)');
      }
    }
  });
});
