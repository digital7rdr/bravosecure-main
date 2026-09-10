/**
 * Bug-hunt #3 — durable stash for group envelopes that arrived before
 * the local master key for their group was available.
 *
 * Problem:
 *   The admin `create` envelope (first time joining a group) and the
 *   admin `rekey` envelope (post-membership-change key rotation) race
 *   text envelopes through the relay. A text envelope encrypted under
 *   the new master key can land BEFORE the admin envelope that
 *   distributes that key. The receiver's `parseGroupMessage` returns
 *   `{ok: false, reason: 'no_key'}` and the legacy code path then
 *   fell through to the plaintext branch — it wrote a `LocalMessage`
 *   whose `content` was the raw ciphertext JSON blob, acked the relay,
 *   and lost the message permanently when the create/rekey arrived
 *   seconds later.
 *
 * Fix:
 *   Stash the unwrapped SealedPayload + peer in this SQLCipher table.
 *   ACK the relay (we own durability now — the relay has a 30-day
 *   dwell but we don't want it redelivering the same envelope when
 *   we already hold it on disk). On the next admin `create` or `rekey`
 *   that commits a new `masterKeyB64` for the matching groupId, drain
 *   the rows and re-run the post-decrypt routing through a fresh
 *   receive transaction so seenEnvelopes / sqlMessages.upsert commit
 *   atomically with the plaintext insert.
 *
 * Bounds:
 *   `MAX_PER_GROUP = 256`  — soft cap per groupId. Oldest rows evicted
 *                            when a new stash would push the group over.
 *   `MAX_GLOBAL    = 2048` — hard global cap. Same eviction policy.
 *   `RETENTION_MS  = 30 days` — older rows pruned on boot, matching the
 *                            relay's 30-day dwell. GROUP-STASH-7DAY-PRUNE-
 *                            PERMALOSS: the previous 7-day window dropped a
 *                            stashed envelope before its key could arrive —
 *                            and since stashing ACKs the relay (we own
 *                            durability), the relay copy is already gone, so a
 *                            prune = permanent loss. The self-heal key-request
 *                            (reconnect / focus / owner-back-online) can
 *                            recover the master key well past a week, so the
 *                            stash must survive as long as the message is
 *                            recoverable at all — i.e. the relay dwell.
 *   `MAX_ATTEMPTS  = 3`    — drop a row after this many failed replay
 *                            attempts (parse-tamper, decrypt-failure).
 *
 * The bounds are deliberately loose: a typical user with active
 * group chats accumulates maybe a handful of stashed rows during a
 * key rotation, drained within seconds. The cap protects against a
 * hostile sender shipping isGroupCiphertext-shaped junk for groups
 * the receiver has never joined — the cap evicts oldest entries so
 * the table can't fill the disk.
 */

import type {DbHandle} from '../crypto/db';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // match the relay's 30-day dwell (see header)
export const PENDING_GROUP_MAX_PER_GROUP = 256;
export const PENDING_GROUP_MAX_GLOBAL    = 2048;
export const PENDING_GROUP_MAX_ATTEMPTS  = 3;

export interface PendingGroupRow {
  envelopeId:   string;
  groupId:      string;
  peerUserId:   string;
  peerDeviceId: number;
  sealedJson:   string;
  receivedAtMs: number;
  attempts:     number;
}

export interface PendingGroupStashParams {
  envelopeId:   string;
  groupId:      string;
  peerUserId:   string;
  peerDeviceId: number;
  /** The unwrapped SealedPayload — store as JSON for re-parse on drain. */
  sealed:       unknown;
  receivedAtMs: number;
}

export class PendingGroupEnvelopeStore {
  constructor(private readonly db: DbHandle) {}

  /**
   * Stash an envelope. Enforces per-group + global caps by evicting
   * the oldest entry when either cap is exceeded. INSERT OR REPLACE
   * so a duplicate envelopeId (same ciphertext redelivered before
   * the drain happens) overwrites cleanly rather than throwing.
   *
   * Must be called INSIDE the receive transaction so the stash row,
   * the `seen_envelopes` row, and (later) the post-drain plaintext
   * insert form an atomic group across crash boundaries.
   */
  async stash(params: PendingGroupStashParams): Promise<void> {
    const sealedJson = JSON.stringify(params.sealed);
    await this.db.execute(
      `INSERT OR REPLACE INTO pending_group_envelopes
         (envelope_id, group_id, peer_user_id, peer_device_id,
          sealed_json, received_at_ms, attempts)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [
        params.envelopeId, params.groupId,
        params.peerUserId, params.peerDeviceId,
        sealedJson, params.receivedAtMs,
      ],
    );
    // Enforce per-group cap. SQLite DELETE-with-LIMIT requires an
    // ORDER BY subquery; ROWID is the implicit insertion-order key.
    await this.db.execute(
      `DELETE FROM pending_group_envelopes
         WHERE envelope_id IN (
           SELECT envelope_id FROM pending_group_envelopes
             WHERE group_id = ?
             ORDER BY received_at_ms ASC
             LIMIT MAX(0, (SELECT COUNT(*) FROM pending_group_envelopes WHERE group_id = ?) - ?)
         )`,
      [params.groupId, params.groupId, PENDING_GROUP_MAX_PER_GROUP],
    );
    // Enforce global cap.
    await this.db.execute(
      `DELETE FROM pending_group_envelopes
         WHERE envelope_id IN (
           SELECT envelope_id FROM pending_group_envelopes
             ORDER BY received_at_ms ASC
             LIMIT MAX(0, (SELECT COUNT(*) FROM pending_group_envelopes) - ?)
         )`,
      [PENDING_GROUP_MAX_GLOBAL],
    );
  }

  /**
   * Return all stashed rows for a groupId, oldest first (so the drain
   * replays them in arrival order — matters for any inner sequencing
   * the rendered chat list cares about).
   */
  async listForGroup(groupId: string): Promise<PendingGroupRow[]> {
    const res = await this.db.execute(
      `SELECT envelope_id, group_id, peer_user_id, peer_device_id,
              sealed_json, received_at_ms, attempts
         FROM pending_group_envelopes
         WHERE group_id = ?
         ORDER BY received_at_ms ASC`,
      [groupId],
    );
    const rows = (res.rows ?? []) as Array<{
      envelope_id: string; group_id: string;
      peer_user_id: string; peer_device_id: number;
      sealed_json: string; received_at_ms: number; attempts: number;
    }>;
    return rows.map(r => ({
      envelopeId:   r.envelope_id,
      groupId:      r.group_id,
      peerUserId:   r.peer_user_id,
      peerDeviceId: r.peer_device_id,
      sealedJson:   r.sealed_json,
      receivedAtMs: r.received_at_ms,
      attempts:     r.attempts,
    }));
  }

  /** Delete one row by envelopeId. Used after a successful replay. */
  async delete(envelopeId: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM pending_group_envelopes WHERE envelope_id = ?',
      [envelopeId],
    );
  }

  /**
   * Increment the attempt counter for one row. Returns the new value.
   * Callers drop the row when the count reaches `MAX_ATTEMPTS`.
   */
  async bumpAttempts(envelopeId: string): Promise<number> {
    await this.db.execute(
      `UPDATE pending_group_envelopes
         SET attempts = attempts + 1
         WHERE envelope_id = ?`,
      [envelopeId],
    );
    const res = await this.db.execute(
      'SELECT attempts FROM pending_group_envelopes WHERE envelope_id = ?',
      [envelopeId],
    );
    const row = (res.rows ?? [])[0] as {attempts?: number} | undefined;
    return row?.attempts ?? 0;
  }

  /**
   * Boot-time sweep — delete rows older than RETENTION_MS. The matching
   * relay copies have long since expired (30-day dwell), so anything
   * pending past that window will never be drainable. Returns the
   * count for telemetry.
   */
  async prune(nowMs: number = Date.now()): Promise<number> {
    const cutoff = nowMs - RETENTION_MS;
    const res = await this.db.execute(
      'DELETE FROM pending_group_envelopes WHERE received_at_ms < ?',
      [cutoff],
    );
    return (res as {rowsAffected?: number}).rowsAffected ?? 0;
  }

  /** Test helper — current row count. */
  async _size(): Promise<number> {
    const res = await this.db.execute(
      'SELECT COUNT(*) AS n FROM pending_group_envelopes',
    );
    const row = res.rows?.[0] as {n: number} | undefined;
    return row?.n ?? 0;
  }

  /** Test helper — current row count for a single group. */
  async _sizeForGroup(groupId: string): Promise<number> {
    const res = await this.db.execute(
      'SELECT COUNT(*) AS n FROM pending_group_envelopes WHERE group_id = ?',
      [groupId],
    );
    const row = res.rows?.[0] as {n: number} | undefined;
    return row?.n ?? 0;
  }
}

export const PENDING_GROUP_ENVELOPES_RETENTION_MS = RETENTION_MS;
