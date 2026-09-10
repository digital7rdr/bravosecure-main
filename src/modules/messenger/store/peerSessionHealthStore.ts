/**
 * Bug-hunt #1 — persistent per-peer session health for the
 * forged-outer-envelope wipe defence.
 *
 * The in-process `lastSuccessfulDecryptByPeer` cache in
 * `sessionWipeProtection.ts` evaporates on every cold start, which is
 * exactly when the relay's catch-up flood is most likely to land —
 * meaning the first `DecryptError` after a restart slipped past the
 * protection check and the legacy rebuild path destroyed the live
 * ratchet. Persisting the timestamp in SQLCipher closes that window.
 *
 * The same row also folds in `markRebuildAttempt`/`shouldAttemptRebuild`
 * cooldown that previously lived in an unbounded in-process Map (P1-7).
 * Both fields are written through the SQL store and cached in front so
 * the hot read path stays O(1) without an SQL round-trip per envelope.
 *
 * Writes are intentionally outside any receive transaction — they're
 * "I observed the peer is healthy / I just tried to recover" metadata,
 * not state that has to commit atomically with the ratchet. A crash
 * between `own.decrypt` succeeding and `noteSuccess()` returning at
 * worst rolls the cache back to the previous successful timestamp;
 * never to a corrupt state.
 */

import type {DbHandle} from '../crypto/db';

export interface PeerHealthRow {
  lastSuccessMs:         number;
  lastRebuildAttemptMs:  number;
}

export class PeerSessionHealthStore {
  // Write-through cache. Reads consult the cache first; misses hit SQL
  // and warm the cache. Cache is unbounded by row count because the
  // SQL table itself is naturally bounded (one row per peer the user
  // has ever talked to — at the order of thousands at the absolute
  // most for a heavy user, hundreds for a typical one).
  private readonly cache = new Map<string, PeerHealthRow>();
  private warmed = false;

  constructor(private readonly db: DbHandle) {}

  /**
   * Lazy-warm the cache from disk on first access. Cheap (single SELECT,
   * row count is the user's lifetime distinct peer count). Idempotent.
   */
  async warm(): Promise<void> {
    if (this.warmed) {return;}
    const res = await this.db.execute(
      'SELECT peer_key, last_success_ms, last_rebuild_attempt_ms FROM peer_session_health',
    );
    const rows = (res.rows ?? []) as Array<{
      peer_key: string; last_success_ms: number; last_rebuild_attempt_ms: number;
    }>;
    for (const row of rows) {
      this.cache.set(row.peer_key, {
        lastSuccessMs:        row.last_success_ms,
        lastRebuildAttemptMs: row.last_rebuild_attempt_ms,
      });
    }
    this.warmed = true;
  }

  /** Synchronous read of the in-memory cache. Returns null on miss. */
  get(peerKey: string): PeerHealthRow | null {
    return this.cache.get(peerKey) ?? null;
  }

  /**
   * Mark the peer's session as having had a successful decrypt now.
   * Updates both cache and SQL. Idempotent; clamps backwards-stamps so
   * a delayed write doesn't roll a fresher timestamp back.
   */
  async noteSuccess(peerKey: string, nowMs: number = Date.now()): Promise<void> {
    const prev = this.cache.get(peerKey) ?? {lastSuccessMs: 0, lastRebuildAttemptMs: 0};
    if (nowMs <= prev.lastSuccessMs) {return;}
    const next: PeerHealthRow = {
      lastSuccessMs:        nowMs,
      lastRebuildAttemptMs: prev.lastRebuildAttemptMs,
    };
    this.cache.set(peerKey, next);
    await this.db.execute(
      `INSERT INTO peer_session_health (peer_key, last_success_ms, last_rebuild_attempt_ms, updated_at)
         VALUES (?, ?, ?, ?)
       ON CONFLICT(peer_key) DO UPDATE SET
         last_success_ms = MAX(last_success_ms, excluded.last_success_ms),
         updated_at = excluded.updated_at`,
      [peerKey, nowMs, next.lastRebuildAttemptMs, nowMs],
    );
  }

  /**
   * Stamp the rebuild-attempt cooldown for this peer. Called only after
   * the rebuild succeeds (matches the existing fix-#6 semantics: do not
   * arm the cooldown on a failed bundle fetch).
   */
  async noteRebuildAttempt(peerKey: string, nowMs: number = Date.now()): Promise<void> {
    const prev = this.cache.get(peerKey) ?? {lastSuccessMs: 0, lastRebuildAttemptMs: 0};
    const next: PeerHealthRow = {
      lastSuccessMs:        prev.lastSuccessMs,
      lastRebuildAttemptMs: nowMs,
    };
    this.cache.set(peerKey, next);
    await this.db.execute(
      `INSERT INTO peer_session_health (peer_key, last_success_ms, last_rebuild_attempt_ms, updated_at)
         VALUES (?, ?, ?, ?)
       ON CONFLICT(peer_key) DO UPDATE SET
         last_rebuild_attempt_ms = excluded.last_rebuild_attempt_ms,
         updated_at = excluded.updated_at`,
      [peerKey, next.lastSuccessMs, nowMs, nowMs],
    );
  }

  /** Test helper — current cache size. */
  _cacheSize(): number {
    return this.cache.size;
  }

  /** Test helper — reset cache (does NOT touch SQL). */
  _resetCache(): void {
    this.cache.clear();
    this.warmed = false;
  }
}
