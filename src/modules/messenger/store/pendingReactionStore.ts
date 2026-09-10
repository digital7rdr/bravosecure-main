/**
 * SYNC-7 — durable stash for reactions that arrived before their target
 * message existed locally.
 *
 * Why durable: the receive path marks the envelope seen and ACKs it inside the
 * same transaction, so the relay drops its copy. An in-memory stash would lose
 * the reaction on the next process death — the exact failure this exists to
 * kill. Same reasoning as `pendingGroupEnvelopeStore`.
 *
 * Key is (conversation_id, target_msg_id, from_user_id) so INSERT OR REPLACE
 * gives last-writer-wins per reactor — identical to the in-memory
 * `reactions[fromUserId] = emoji` semantics, and idempotent on replay.
 *
 * Bounds:
 *   MAX_PER_CONVERSATION = 256 — a peer can mint unlimited fake targetMsgIds,
 *                                so the table needs a cap even though the PK
 *                                bounds one row per (chat, target, reactor).
 *   MAX_GLOBAL           = 2048
 *   RETENTION_MS         = 30 days — matches the relay dwell, for the same
 *                                reason pendingGroupEnvelopeStore uses it
 *                                (GROUP-STASH-7DAY-PERMALOSS): stashing ACKs,
 *                                so an early prune IS the loss.
 */

import type {DbHandle} from '../crypto/db';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const PENDING_REACTION_MAX_PER_CONVERSATION = 256;
export const PENDING_REACTION_MAX_GLOBAL = 2048;

export interface PendingReactionRow {
  conversationId: string;
  targetMsgId: string;
  fromUserId: string;
  emoji: string;
  removed: boolean;
  receivedAtMs: number;
}

export class PendingReactionStore {
  constructor(private readonly db: DbHandle) {}

  async stash(row: PendingReactionRow): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO pending_reactions
         (conversation_id, target_msg_id, from_user_id, emoji, removed, received_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      [
        row.conversationId,
        row.targetMsgId,
        row.fromUserId,
        row.emoji,
        row.removed ? 1 : 0,
        row.receivedAtMs,
      ],
    );
    await this.db.execute(
      `DELETE FROM pending_reactions
         WHERE rowid IN (
           SELECT rowid FROM pending_reactions
             WHERE conversation_id = ?
             ORDER BY received_at_ms ASC
             LIMIT MAX(0, (SELECT COUNT(*) FROM pending_reactions WHERE conversation_id = ?) - ?)
         )`,
      [row.conversationId, row.conversationId, PENDING_REACTION_MAX_PER_CONVERSATION],
    );
    await this.db.execute(
      `DELETE FROM pending_reactions
         WHERE rowid IN (
           SELECT rowid FROM pending_reactions
             ORDER BY received_at_ms ASC
             LIMIT MAX(0, (SELECT COUNT(*) FROM pending_reactions) - ?)
         )`,
      [PENDING_REACTION_MAX_GLOBAL],
    );
  }

  async listForTarget(conversationId: string, targetMsgId: string): Promise<PendingReactionRow[]> {
    const res = await this.db.execute(
      `SELECT conversation_id, target_msg_id, from_user_id, emoji, removed, received_at_ms
         FROM pending_reactions
         WHERE conversation_id = ? AND target_msg_id = ?
         ORDER BY received_at_ms ASC`,
      [conversationId, targetMsgId],
    );
    return mapRows(res.rows ?? []);
  }

  /** Boot sweep — every stashed row, oldest first. Bounded by MAX_GLOBAL. */
  async listAll(): Promise<PendingReactionRow[]> {
    const res = await this.db.execute(
      `SELECT conversation_id, target_msg_id, from_user_id, emoji, removed, received_at_ms
         FROM pending_reactions
         ORDER BY received_at_ms ASC`,
    );
    return mapRows(res.rows ?? []);
  }

  async deleteForTarget(conversationId: string, targetMsgId: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM pending_reactions WHERE conversation_id = ? AND target_msg_id = ?',
      [conversationId, targetMsgId],
    );
  }

  async prune(nowMs: number = Date.now()): Promise<number> {
    const res = await this.db.execute('DELETE FROM pending_reactions WHERE received_at_ms < ?', [
      nowMs - RETENTION_MS,
    ]);
    return (res as {rowsAffected?: number}).rowsAffected ?? 0;
  }

  /** Test helper — current row count. */
  async _size(): Promise<number> {
    const res = await this.db.execute('SELECT COUNT(*) AS n FROM pending_reactions');
    const row = res.rows?.[0] as {n: number} | undefined;
    return row?.n ?? 0;
  }
}

function mapRows(rows: unknown[]): PendingReactionRow[] {
  return (
    rows as Array<{
      conversation_id: string;
      target_msg_id: string;
      from_user_id: string;
      emoji: string;
      removed: number;
      received_at_ms: number;
    }>
  ).map(r => ({
    conversationId: r.conversation_id,
    targetMsgId: r.target_msg_id,
    fromUserId: r.from_user_id,
    emoji: r.emoji,
    removed: r.removed === 1,
    receivedAtMs: r.received_at_ms,
  }));
}

export const PENDING_REACTIONS_RETENTION_MS = RETENTION_MS;
