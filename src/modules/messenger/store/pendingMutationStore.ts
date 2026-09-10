/**
 * Durable stash for edit / delete-for-everyone directives that arrived before
 * their target message existed locally.
 *
 * Why durable, and why at all: the receive path marks the envelope seen and
 * ACKs it inside the same transaction, so the relay drops its copy. An
 * in-memory stash would lose the directive on the next process death — and a
 * lost delete means the recipient keeps rendering content the author retracted
 * everywhere else. Same argument as `pendingReactionStore` (SYNC-7) and
 * `pendingGroupEnvelopeStore`, with a worse failure mode.
 *
 * Key is (conversation_id, target_msg_id, from_user_id, kind) so INSERT OR
 * REPLACE gives last-writer-wins per author per kind. That is the correct
 * collapse: two queued edits from one author should replay as the newer one
 * only, and a delete and an edit are separate rows so the drain can apply the
 * delete last and win regardless of arrival order.
 *
 * Bounds mirror pendingReactionStore — a peer can mint unlimited fake
 * targetMsgIds, so the table needs a cap even though the PK bounds one row per
 * (chat, target, author, kind). RETENTION_MS matches the relay dwell for the
 * same reason: stashing ACKs, so an early prune IS the loss.
 */

import type {DbHandle} from '../crypto/db';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const PENDING_MUTATION_MAX_PER_CONVERSATION = 256;
export const PENDING_MUTATION_MAX_GLOBAL = 2048;

export interface PendingMutationRow {
  conversationId: string;
  targetMsgId:    string;
  fromUserId:     string;
  kind:           'edit' | 'delete';
  /** Replacement body for an edit; null for a delete, which carries none. */
  body:           string | null;
  mentions:       Array<{userId: string; label: string}> | null;
  /** The directive's own clock stamp — `editedAt` / `deletedAt`. */
  stampMs:        number;
  receivedAtMs:   number;
}

export class PendingMutationStore {
  constructor(private readonly db: DbHandle) {}

  async stash(row: PendingMutationRow): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO pending_mutations
         (conversation_id, target_msg_id, from_user_id, kind, body, mentions_json, stamp_ms, received_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.conversationId,
        row.targetMsgId,
        row.fromUserId,
        row.kind,
        row.body,
        row.mentions?.length ? JSON.stringify(row.mentions) : null,
        row.stampMs,
        row.receivedAtMs,
      ],
    );
    await this.db.execute(
      `DELETE FROM pending_mutations
         WHERE rowid IN (
           SELECT rowid FROM pending_mutations
             WHERE conversation_id = ?
             ORDER BY received_at_ms ASC
             LIMIT MAX(0, (SELECT COUNT(*) FROM pending_mutations WHERE conversation_id = ?) - ?)
         )`,
      [row.conversationId, row.conversationId, PENDING_MUTATION_MAX_PER_CONVERSATION],
    );
    await this.db.execute(
      `DELETE FROM pending_mutations
         WHERE rowid IN (
           SELECT rowid FROM pending_mutations
             ORDER BY received_at_ms ASC
             LIMIT MAX(0, (SELECT COUNT(*) FROM pending_mutations) - ?)
         )`,
      [PENDING_MUTATION_MAX_GLOBAL],
    );
  }

  /**
   * Rows for one target, oldest first. The drain applies them in this order so
   * the newest edit wins; a delete in the set wins outright (see the applier).
   */
  async listForTarget(conversationId: string, targetMsgId: string): Promise<PendingMutationRow[]> {
    const res = await this.db.execute(
      `SELECT conversation_id, target_msg_id, from_user_id, kind, body, mentions_json, stamp_ms, received_at_ms
         FROM pending_mutations
         WHERE conversation_id = ? AND target_msg_id = ?
         ORDER BY received_at_ms ASC`,
      [conversationId, targetMsgId],
    );
    return mapRows(res.rows ?? []);
  }

  /** Boot sweep — every stashed row, oldest first. Bounded by MAX_GLOBAL. */
  async listAll(): Promise<PendingMutationRow[]> {
    const res = await this.db.execute(
      `SELECT conversation_id, target_msg_id, from_user_id, kind, body, mentions_json, stamp_ms, received_at_ms
         FROM pending_mutations
         ORDER BY received_at_ms ASC`,
    );
    return mapRows(res.rows ?? []);
  }

  async deleteForTarget(conversationId: string, targetMsgId: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM pending_mutations WHERE conversation_id = ? AND target_msg_id = ?',
      [conversationId, targetMsgId],
    );
  }

  async prune(nowMs: number = Date.now()): Promise<number> {
    const res = await this.db.execute('DELETE FROM pending_mutations WHERE received_at_ms < ?', [
      nowMs - RETENTION_MS,
    ]);
    return (res as {rowsAffected?: number}).rowsAffected ?? 0;
  }

  /** Test helper — current row count. */
  async _size(): Promise<number> {
    const res = await this.db.execute('SELECT COUNT(*) AS n FROM pending_mutations');
    const row = res.rows?.[0] as {n: number} | undefined;
    return row?.n ?? 0;
  }
}

function mapRows(rows: unknown[]): PendingMutationRow[] {
  return (
    rows as Array<{
      conversation_id: string;
      target_msg_id:   string;
      from_user_id:    string;
      kind:            string;
      body:            string | null;
      mentions_json:   string | null;
      stamp_ms:        number;
      received_at_ms:  number;
    }>
  ).map(r => ({
    conversationId: r.conversation_id,
    targetMsgId:    r.target_msg_id,
    fromUserId:     r.from_user_id,
    kind:           r.kind === 'delete' ? 'delete' : 'edit',
    body:           r.body,
    mentions:       parseMentions(r.mentions_json),
    stampMs:        r.stamp_ms,
    receivedAtMs:   r.received_at_ms,
  }));
}

function parseMentions(s: string | null): Array<{userId: string; label: string}> | null {
  if (!s) {return null;}
  try {
    const parsed = JSON.parse(s) as unknown;
    if (!Array.isArray(parsed)) {return null;}
    const out = parsed.filter(
      (m): m is {userId: string; label: string} =>
        !!m && typeof m === 'object' &&
        typeof (m as {userId?: unknown}).userId === 'string' &&
        typeof (m as {label?: unknown}).label === 'string',
    );
    return out.length ? out : null;
  } catch { return null; }
}

export const PENDING_MUTATIONS_RETENTION_MS = RETENTION_MS;
