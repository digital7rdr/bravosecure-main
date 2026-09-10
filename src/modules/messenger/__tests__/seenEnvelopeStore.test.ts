import {
  SeenEnvelopeStore,
  SEEN_ENVELOPES_DDL,
  SEEN_ENVELOPES_RETENTION_MS,
} from '../store/seenEnvelopeStore';
import type {DbHandle} from '../crypto/db';

/**
 * Minimal in-memory DbHandle stub. We only model the three SQL shapes
 * the store actually issues:
 *   - INSERT OR IGNORE INTO seen_envelopes ...
 *   - SELECT 1 FROM seen_envelopes WHERE envelope_id = ? LIMIT 1
 *   - DELETE FROM seen_envelopes WHERE first_seen_ms < ?
 *   - SELECT COUNT(*) AS n FROM seen_envelopes
 *
 * This avoids spinning up op-sqlite + SQLCipher in the Node Jest project.
 */
function makeStubDb(): DbHandle {
  const rows = new Map<string, {envelope_id: string; first_seen_ms: number}>();
  const db = {
    async execute(sql: string, params: unknown[] = []): Promise<unknown> {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('CREATE TABLE')) {return {rows: []};}
      if (s.startsWith('INSERT OR IGNORE INTO seen_envelopes')) {
        const [id, ts] = params as [string, number];
        if (!rows.has(id)) {
          rows.set(id, {envelope_id: id, first_seen_ms: ts});
          return {rowsAffected: 1};
        }
        return {rowsAffected: 0};
      }
      if (s.startsWith('SELECT 1 FROM seen_envelopes')) {
        const [id] = params as [string];
        return {rows: rows.has(id) ? [{1: 1}] : []};
      }
      if (s.startsWith('DELETE FROM seen_envelopes')) {
        const [cutoff] = params as [number];
        let deleted = 0;
        for (const [k, v] of rows) {
          if (v.first_seen_ms < cutoff) {rows.delete(k); deleted++;}
        }
        return {rowsAffected: deleted};
      }
      if (s.startsWith('SELECT COUNT(*)')) {
        return {rows: [{n: rows.size}]};
      }
      throw new Error('unmocked SQL: ' + s);
    },
  } as unknown as DbHandle;
  return db;
}

describe('SeenEnvelopeStore — audit P0-N6 persistent receive dedup', () => {
  it('wasSeen returns false on a fresh store', async () => {
    const store = new SeenEnvelopeStore(makeStubDb());
    expect(await store.wasSeen('env-1')).toBe(false);
  });

  it('markSeen + wasSeen round-trip', async () => {
    const store = new SeenEnvelopeStore(makeStubDb());
    expect(await store.wasSeen('env-1')).toBe(false);
    await store.markSeen('env-1');
    expect(await store.wasSeen('env-1')).toBe(true);
  });

  it('markSeen is idempotent — duplicate markSeen does not throw or alter timestamp', async () => {
    // Critical for the reconnect-storm case: the same envelope may arrive
    // twice across separate transactions before we've committed the first
    // markSeen. INSERT OR IGNORE must not crash with PRIMARY KEY conflict.
    const store = new SeenEnvelopeStore(makeStubDb());
    await store.markSeen('env-1', 1000);
    await store.markSeen('env-1', 2000); // second call — must not throw
    await store.markSeen('env-1', 3000);
    expect(await store.wasSeen('env-1')).toBe(true);
    // Three calls, one row.
    expect(await store._size()).toBe(1);
  });

  it('distinct envelope ids are independent', async () => {
    const store = new SeenEnvelopeStore(makeStubDb());
    await store.markSeen('env-a');
    await store.markSeen('env-b');
    expect(await store.wasSeen('env-a')).toBe(true);
    expect(await store.wasSeen('env-b')).toBe(true);
    expect(await store.wasSeen('env-c')).toBe(false);
  });

  it('prune deletes rows older than RETENTION_MS and keeps fresher ones', async () => {
    const store = new SeenEnvelopeStore(makeStubDb());
    const now = 100_000_000_000; // arbitrary anchor
    await store.markSeen('old-1', now - SEEN_ENVELOPES_RETENTION_MS - 1);
    await store.markSeen('old-2', now - SEEN_ENVELOPES_RETENTION_MS - 1000);
    await store.markSeen('fresh', now - 1000);
    const deleted = await store.prune(now);
    expect(deleted).toBe(2);
    expect(await store.wasSeen('old-1')).toBe(false);
    expect(await store.wasSeen('old-2')).toBe(false);
    expect(await store.wasSeen('fresh')).toBe(true);
  });

  it('prune is safe on an empty table', async () => {
    const store = new SeenEnvelopeStore(makeStubDb());
    const deleted = await store.prune();
    expect(deleted).toBe(0);
  });

  it('exports the DDL needed for schema bootstrap', () => {
    expect(SEEN_ENVELOPES_DDL).toContain('CREATE TABLE IF NOT EXISTS seen_envelopes');
    expect(SEEN_ENVELOPES_DDL).toContain('PRIMARY KEY');
    expect(SEEN_ENVELOPES_DDL).toContain('first_seen_ms');
  });

  it('RETENTION_MS is past the 30-day relay dwell', () => {
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(SEEN_ENVELOPES_RETENTION_MS).toBeGreaterThan(thirtyDays);
  });
});
