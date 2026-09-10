/**
 * Audit P0-N6 — persistent envelope-id dedup on receive.
 *
 * The relay's `flushPendingOnConnect` re-pushes ALL pending envelopes
 * on every reconnect; ack-on-receive is the only signal that clears
 * them. If our ack is lost (socket drops between recv and ack, or
 * client crashes mid-decrypt) the server redelivers the SAME envelope
 * on the next connect. Without a dedup gate, libsignal's
 * `own.decrypt` runs against the same ciphertext a SECOND time —
 * which succeeds (already advanced the ratchet on attempt #1, so the
 * message key is gone) and the new attempt throws "bad MAC". The
 * session is now corrupt forever.
 *
 * Fix: persist every successfully-handled envelope-id and skip
 * already-seen envelopes (just re-ack so the relay drops them).
 *
 * Persistence is the key word — the prior in-memory `seenNonces`-style
 * LRU evaporates on every cold start, which is precisely when the
 * relay catch-up flood lands. Persisting in SQLCipher survives reboots
 * and works across the 30-day relay dwell window.
 *
 * Retention:
 *  - Hard cap: NONE on per-write path (writes are cheap).
 *  - Soft prune: rows older than `RETENTION_MS` (35 days, comfortably
 *    past the 30-day Signal relay dwell) are deleted on demand by the
 *    runtime boot sweep. The server can't redeliver anything older
 *    than its own dwell, so anything past that is dead weight.
 *  - Worst case if pruning never runs: ~10K-row table per heavy chat
 *    week — still under a megabyte and indexed by PK.
 */

import type {DbHandle} from '../crypto/db';

/** 35 days — comfortably past the 30-day Signal protocol relay dwell. */
const RETENTION_MS = 35 * 24 * 60 * 60 * 1000;

export class SeenEnvelopeStore {
  constructor(private readonly db: DbHandle) {}

  /** Return `true` iff this envelope-id was previously marked seen. */
  async wasSeen(envelopeId: string): Promise<boolean> {
    const res = await this.db.execute(
      'SELECT 1 FROM seen_envelopes WHERE envelope_id = ? LIMIT 1',
      [envelopeId],
    );
    return (res.rows?.length ?? 0) > 0;
  }

  /**
   * Mark an envelope-id as seen. Idempotent (INSERT OR IGNORE) so a
   * concurrent caller racing the check above can't crash with PK
   * conflict. Must be called INSIDE the receive transaction
   * (see receiveTransaction.ts) so the ratchet advance, the plaintext
   * UPSERT, and the dedup gate either all commit or all roll back.
   */
  async markSeen(envelopeId: string, nowMs: number = Date.now()): Promise<void> {
    await this.db.execute(
      'INSERT OR IGNORE INTO seen_envelopes (envelope_id, first_seen_ms) VALUES (?, ?)',
      [envelopeId, nowMs],
    );
  }

  /**
   * Delete rows older than `RETENTION_MS`. Called from runtime boot
   * (and optionally on a long timer) so the per-receive path stays
   * O(1). Returns the number of rows deleted for telemetry.
   */
  async prune(nowMs: number = Date.now()): Promise<number> {
    const cutoff = nowMs - RETENTION_MS;
    const res = await this.db.execute(
      'DELETE FROM seen_envelopes WHERE first_seen_ms < ?',
      [cutoff],
    );
    // op-sqlite returns `rowsAffected` on writes.
    return (res as {rowsAffected?: number}).rowsAffected ?? 0;
  }

  /** Test helper — current row count. */
  async _size(): Promise<number> {
    const res = await this.db.execute('SELECT COUNT(*) AS n FROM seen_envelopes');
    const row = res.rows?.[0] as {n: number} | undefined;
    return row?.n ?? 0;
  }
}

export const SEEN_ENVELOPES_DDL = `CREATE TABLE IF NOT EXISTS seen_envelopes (
  envelope_id   TEXT PRIMARY KEY,
  first_seen_ms INTEGER NOT NULL
)`;

export const SEEN_ENVELOPES_INDEX_DDL =
  `CREATE INDEX IF NOT EXISTS idx_seen_envelopes_first_seen
     ON seen_envelopes (first_seen_ms)`;

/** Exported for the prune-sweep test. */
export const SEEN_ENVELOPES_RETENTION_MS = RETENTION_MS;
