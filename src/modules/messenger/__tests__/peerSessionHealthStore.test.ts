/**
 * Bug-hunt #1.B/C — persistent peer-session-health store.
 *
 * The store is the durable backing for `sessionWipeProtection`'s
 * `lastSuccessfulDecryptByPeer` and `lastRebuildAttemptByPeer` maps.
 * Without it, the in-process Maps evaporated on every cold start and
 * the first forged-outer DecryptError after a restart wiped the live
 * ratchet. These tests pin the store contract:
 *
 *   - writes are upserts keyed on `peer_key`
 *   - `noteSuccess` clamps backwards-stamps so a slow write can't roll
 *     a fresher timestamp back
 *   - `noteRebuildAttempt` writes alongside the success timestamp on
 *     the same row (one row per peer, not two)
 *   - `warm` rehydrates the in-memory cache from disk
 *   - `get` reads from cache (no SQL touch in the hot path)
 *
 * The store uses an in-memory mock DbHandle so the test suite doesn't
 * need an op-sqlite native module loaded.
 */

import {PeerSessionHealthStore} from '../store/peerSessionHealthStore';

interface Row {
  peer_key:                string;
  last_success_ms:         number;
  last_rebuild_attempt_ms: number;
  updated_at:              number;
}

function makeMockDb(): {
  db: {execute: (sql: string, params?: unknown[]) => Promise<{rows?: unknown[]; rowsAffected?: number}>};
  rows: Row[];
  executions: string[];
} {
  const rows: Row[] = [];
  const executions: string[] = [];
  return {
    rows,
    executions,
    db: {
      execute: async (sql, params) => {
        executions.push(sql);
        if (/^SELECT peer_key/.test(sql)) {
          return {rows: rows.map(r => ({...r}))};
        }
        if (/^INSERT INTO peer_session_health/.test(sql)) {
          const p = params as [string, number, number, number];
          const existing = rows.find(r => r.peer_key === p[0]);
          if (!existing) {
            rows.push({
              peer_key:                p[0],
              last_success_ms:         p[1],
              last_rebuild_attempt_ms: p[2],
              updated_at:              p[3],
            });
            return {rowsAffected: 1};
          }
          // Crude UPSERT emulation — the real SQL clause uses MAX() on
          // success-stamp and a direct overwrite on rebuild-stamp,
          // mirroring the store's two write paths.
          if (/excluded\.last_success_ms/.test(sql)) {
            existing.last_success_ms = Math.max(existing.last_success_ms, p[1]);
          }
          if (/excluded\.last_rebuild_attempt_ms/.test(sql)) {
            existing.last_rebuild_attempt_ms = p[2];
          }
          existing.updated_at = p[3];
          return {rowsAffected: 1};
        }
        return {rows: []};
      },
    },
  };
}

describe('bug-hunt #1 — PeerSessionHealthStore', () => {
  it('noteSuccess upserts and caches the timestamp', async () => {
    const {db, rows} = makeMockDb();

    const store = new PeerSessionHealthStore(db as any);
    await store.noteSuccess('alice.1', 1000);
    expect(store.get('alice.1')).toEqual({lastSuccessMs: 1000, lastRebuildAttemptMs: 0});
    expect(rows).toHaveLength(1);
    expect(rows[0].last_success_ms).toBe(1000);
  });

  it('noteSuccess clamps backwards-stamps', async () => {
    const {db} = makeMockDb();

    const store = new PeerSessionHealthStore(db as any);
    await store.noteSuccess('alice.1', 5000);
    await store.noteSuccess('alice.1', 3000); // earlier than the previous mark
    // Cache must reflect the LATER timestamp, not the slow-write one.
    expect(store.get('alice.1')).toEqual({lastSuccessMs: 5000, lastRebuildAttemptMs: 0});
  });

  it('noteRebuildAttempt writes alongside last_success_ms on the SAME row', async () => {
    const {db, rows} = makeMockDb();

    const store = new PeerSessionHealthStore(db as any);
    await store.noteSuccess('alice.1', 1000);
    await store.noteRebuildAttempt('alice.1', 2000);
    expect(rows).toHaveLength(1);
    expect(rows[0].last_success_ms).toBe(1000);
    expect(rows[0].last_rebuild_attempt_ms).toBe(2000);
    expect(store.get('alice.1')).toEqual({lastSuccessMs: 1000, lastRebuildAttemptMs: 2000});
  });

  it('warm() rehydrates the cache from existing rows (cold-start path)', async () => {
    const {db, rows} = makeMockDb();
    // Pre-populate as if a previous run had written.
    rows.push({peer_key: 'alice.1', last_success_ms: 4000, last_rebuild_attempt_ms: 0, updated_at: 4000});
    rows.push({peer_key: 'bob.1',   last_success_ms: 5000, last_rebuild_attempt_ms: 5500, updated_at: 5500});

    const store = new PeerSessionHealthStore(db as any);
    expect(store.get('alice.1')).toBeNull(); // cold cache before warm
    await store.warm();
    expect(store.get('alice.1')).toEqual({lastSuccessMs: 4000, lastRebuildAttemptMs: 0});
    expect(store.get('bob.1')).toEqual({lastSuccessMs: 5000, lastRebuildAttemptMs: 5500});
  });

  it('warm() is idempotent', async () => {
    const {db} = makeMockDb();

    const store = new PeerSessionHealthStore(db as any);
    await store.warm();
    await store.warm();
    // Second call short-circuits — pass if it doesn't throw.
    expect(store._cacheSize()).toBe(0);
  });

  it('per-peer isolation — different peers, different rows', async () => {
    const {db, rows} = makeMockDb();

    const store = new PeerSessionHealthStore(db as any);
    await store.noteSuccess('alice.1', 1000);
    await store.noteSuccess('bob.1', 2000);
    await store.noteRebuildAttempt('alice.2', 3000);
    expect(rows).toHaveLength(3);
    expect(store.get('alice.1')?.lastSuccessMs).toBe(1000);
    expect(store.get('bob.1')?.lastSuccessMs).toBe(2000);
    expect(store.get('alice.2')?.lastRebuildAttemptMs).toBe(3000);
  });
});
