/**
 * Bug-hunt #5 follow-through — durable stash for group admin actions
 * that arrived out-of-epoch order.
 *
 * Problem:
 *   The two-step admin flows (`{remove, rekey}`, `{add, rekey}`,
 *   `{leave, rekey}`) broadcast TWO envelopes back-to-back. The relay
 *   may deliver step 2 (rekey @ E+1) before step 1 (add @ E) on
 *   reconnect-flush, or per-recipient ordering may differ for any
 *   other reason. `applyAdminAction` silently no-ops when
 *   `atEpoch !== state.epoch`. Bug-hunt #5 added a crashLog
 *   breadcrumb so operators could correlate "group X stopped
 *   decrypting" reports — but the action itself was still dropped
 *   and the receiver's local state desynced from the rest of the
 *   group.
 *
 * Fix:
 *   When an admin action no-ops on stale epoch, also stash it here.
 *   The very next admin commit that DOES advance the local state
 *   (whether for the same group or any other) triggers a drain pass
 *   that re-runs each stashed action through `applyAdminAction`;
 *   the one that was previously stale will now match and apply.
 *
 *   The drain runs OUTSIDE the receive txn (the admin commit ran
 *   in-txn; the drain pass is best-effort cleanup, not part of the
 *   atomic group). Per-row failure (still stale, or unparseable)
 *   bumps an attempts counter; we drop after 3 retries so the table
 *   doesn't grow unbounded for actions that will never apply.
 */

import type {DbHandle} from '../crypto/db';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const PENDING_ADMIN_MAX_PER_GROUP = 64;
export const PENDING_ADMIN_MAX_GLOBAL    = 512;
export const PENDING_ADMIN_MAX_ATTEMPTS  = 3;

export interface PendingAdminRow {
  id:             number;
  groupId:        string;
  actionEpoch:    number;
  senderUserId:   string;
  actionJson:     string;
  receivedAtMs:   number;
  attempts:       number;
}

export interface PendingAdminStashParams {
  groupId:       string;
  actionEpoch:   number;
  senderUserId:  string;
  /** The full GroupAdminAction object — store as JSON. */
  action:        unknown;
  receivedAtMs:  number;
}

export class PendingAdminActionStore {
  constructor(private readonly db: DbHandle) {}

  async stash(params: PendingAdminStashParams): Promise<void> {
    const actionJson = JSON.stringify(params.action);
    await this.db.execute(
      `INSERT INTO pending_admin_actions
         (group_id, action_epoch, sender_user_id, action_json, received_at_ms, attempts)
         VALUES (?, ?, ?, ?, ?, 0)`,
      [
        params.groupId, params.actionEpoch,
        params.senderUserId, actionJson, params.receivedAtMs,
      ],
    );
    // Per-group cap.
    await this.db.execute(
      `DELETE FROM pending_admin_actions
         WHERE id IN (
           SELECT id FROM pending_admin_actions
             WHERE group_id = ?
             ORDER BY received_at_ms ASC
             LIMIT MAX(0, (SELECT COUNT(*) FROM pending_admin_actions WHERE group_id = ?) - ?)
         )`,
      [params.groupId, params.groupId, PENDING_ADMIN_MAX_PER_GROUP],
    );
    // Global cap.
    await this.db.execute(
      `DELETE FROM pending_admin_actions
         WHERE id IN (
           SELECT id FROM pending_admin_actions
             ORDER BY received_at_ms ASC
             LIMIT MAX(0, (SELECT COUNT(*) FROM pending_admin_actions) - ?)
         )`,
      [PENDING_ADMIN_MAX_GLOBAL],
    );
  }

  async listForGroup(groupId: string): Promise<PendingAdminRow[]> {
    const res = await this.db.execute(
      `SELECT id, group_id, action_epoch, sender_user_id,
              action_json, received_at_ms, attempts
         FROM pending_admin_actions
         WHERE group_id = ?
         ORDER BY action_epoch ASC, received_at_ms ASC`,
      [groupId],
    );
    const rows = (res.rows ?? []) as Array<{
      id: number; group_id: string; action_epoch: number;
      sender_user_id: string; action_json: string;
      received_at_ms: number; attempts: number;
    }>;
    return rows.map(r => ({
      id:           r.id,
      groupId:      r.group_id,
      actionEpoch:  r.action_epoch,
      senderUserId: r.sender_user_id,
      actionJson:   r.action_json,
      receivedAtMs: r.received_at_ms,
      attempts:     r.attempts,
    }));
  }

  async delete(id: number): Promise<void> {
    await this.db.execute(
      'DELETE FROM pending_admin_actions WHERE id = ?',
      [id],
    );
  }

  async bumpAttempts(id: number): Promise<number> {
    await this.db.execute(
      `UPDATE pending_admin_actions
         SET attempts = attempts + 1
         WHERE id = ?`,
      [id],
    );
    const res = await this.db.execute(
      'SELECT attempts FROM pending_admin_actions WHERE id = ?',
      [id],
    );
    const row = (res.rows ?? [])[0] as {attempts?: number} | undefined;
    return row?.attempts ?? 0;
  }

  async prune(nowMs: number = Date.now()): Promise<number> {
    const cutoff = nowMs - RETENTION_MS;
    const res = await this.db.execute(
      'DELETE FROM pending_admin_actions WHERE received_at_ms < ?',
      [cutoff],
    );
    return (res as {rowsAffected?: number}).rowsAffected ?? 0;
  }

  async _size(): Promise<number> {
    const res = await this.db.execute(
      'SELECT COUNT(*) AS n FROM pending_admin_actions',
    );
    const row = res.rows?.[0] as {n: number} | undefined;
    return row?.n ?? 0;
  }
}

export const PENDING_ADMIN_ACTIONS_RETENTION_MS = RETENTION_MS;
