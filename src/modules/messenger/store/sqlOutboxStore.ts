/**
 * Durable outbox.
 *
 * Why: the WS send path is fire-and-forget. If the app is killed (Doze,
 * swipe, low-memory) between `transport.send()` and the server's
 * `envelope.accepted`, the message lives only in the Zustand store as
 * `status: 'sending'` with no retry mechanism — it's gone. WhatsApp
 * persists every outgoing message to disk BEFORE shipping it and only
 * deletes the row after the server confirms. This store does the same.
 *
 * Group fan-out (audit P0-N4): each per-peer envelope is its own row.
 * The PK is composite — (clientMsgId, peerUserId, peerDeviceId) — so a
 * group send to N members enqueues N rows that all carry the same
 * clientMsgId but route to distinct recipients. drainOutbox replays
 * each row independently with per-row retry/backoff.
 *
 * Lifecycle:
 *   1. enqueue()  — runtime writes BEFORE `transport.send()`.
 *   2. markDelivered() — runtime deletes when `envelope.accepted` (or
 *      HTTP fallback) confirms acceptance for THIS peer.
 *   3. dueRows()  — startup + every `socket.on('connect')` calls this
 *      to pull rows whose `next_retry_at <= now`; runtime re-ships
 *      each via the existing HTTP relay path.
 *   4. recordAttempt() — bumps `attempts` and schedules the next retry
 *      with exponential backoff (1s, 2s, 8s, 30s, 2m cap — F-3/B-693).
 *   5. markFailed() — after MAX_ATTEMPTS attempts the row stays in the
 *      DB with `status='failed'` so the UI can surface a retry button.
 */

import type {DbHandle} from '../crypto/db';
import type {ClientMsgId, UserId, SignalDeviceId} from '../conversationIds';
// B-703 MR-6 — THE transient-SQL rule, shared with the receive path. That
// module is dependency-free (Tier A), so this is a value import with no cycle
// and no transport dependency; a second copy of the regex is what let the two
// sides disagree about the same database in the first place.
import {isTransientSqlError} from '../runtime/receiveTransaction';

export interface OutboxRow {
  clientMsgId:    string;
  conversationId: string;
  messageId:      string;
  peerUserId:     string;
  peerDeviceId:   number;
  /** JSON-serialised ClientEnvelopeSend.data (outerSealed + expiresAtSec). */
  payload:        string;
  attempts:       number;
  nextRetryAt:    number;
  createdAt:      number;
  status:         'pending' | 'failed';
}

export interface OutboxEnqueueInput {
  clientMsgId:    string;
  conversationId: string;
  messageId:      string;
  peerUserId:     string;
  peerDeviceId:   number;
  payload:        string;
}

/**
 * Exponential backoff schedule. Capped at 2 minutes; after MAX_ATTEMPTS
 * attempts the row is marked `failed` so the user can manually retry.
 */
// F-3 (B-693) — rungs halved from [1s,4s,15s,60s,5min]: DL-4 showed the
// eligibility ladder is the only wait on a QUIET socket (every up-edge —
// reconnect, NetInfo, foreground — already drains unthrottled), so the tail
// rungs were pure user-visible delay. OM-07's flap-storm budgets are kick-side
// throttles and are untouched by shorter eligibility. Retry-After above the
// new 2-min ceiling gets clamped earlier than the server asked; the 429
// cooldown in relaySendPacer still honours the server's own pace.
const BACKOFF_MS = [1_000, 2_000, 8_000, 30_000, 2 * 60_000];
const MAX_ATTEMPTS = BACKOFF_MS.length + 5; // tolerate ~10 failed attempts
/** Ceiling for any reschedule, including a server-supplied `Retry-After`. */
const MAX_BACKOFF_MS = BACKOFF_MS[BACKOFF_MS.length - 1];

function backoffFor(step: number): number {
  return BACKOFF_MS[Math.min(Math.max(step, 0), BACKOFF_MS.length - 1)];
}

/**
 * SN-04 — did this attempt fail because the network was unreachable, rather
 * than because the server rejected it?
 *
 * Only the latter should consume the retry budget (see `recordAttempt`). The
 * matched shapes are RN's offline `fetch` rejection, DNS/socket errors, and
 * the SN-01 AbortController deadline — all of which mean "we never got an
 * answer", not "the relay said no".
 */
export function isUnreachableError(e: unknown): boolean {
  if (e instanceof Error && e.name === 'AbortError') {return true;}
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return /network request failed|network error|failed to fetch|abort|timed? ?out|econnrefused|econnreset|enotfound|enetunreach|ehostunreach/i.test(msg);
}

/**
 * XO-5 — did the relay REJECT this envelope on its merits, so that retrying
 * the identical bytes can never succeed?
 *
 * `EnvelopeService.submitEnvelope` answers 400 for `invalid_recipient`,
 * `invalid_outer_sealed`, `outer_sealed_too_large` and `expires_in_past` — all
 * deterministic validation of the bytes we already sealed. 401 (token refresh),
 * 429 (throttle) and 5xx are deliberately excluded: those are transient and
 * must keep their retry budget.
 *
 * Matched on `.name` rather than `instanceof RelayHttpError` because the store
 * must not import the transport layer, and there are two structurally
 * identical error classes.
 */
export function isPermanentRelayRejection(e: unknown): boolean {
  const err = e as {name?: string; status?: number} | null | undefined;
  if (err?.name !== 'RelayHttpError') {return false;}
  return err.status === 400 || err.status === 413;
}

/**
 * SRV-01 / GF-1 — server backpressure, not a delivery rejection.
 *
 * The relay is group-blind, so one group post is N independent
 * `POST /envelopes` calls; a burst can trip the per-user throttler (429) or
 * the per-recipient queue ceiling (`relay_queue_full`, also 429). Neither says
 * anything about THIS envelope's validity, so — exactly like SN-04's offline
 * case — the attempt budget must not be spent on it.
 */
export function isBackpressureError(e: unknown): boolean {
  if ((e as {status?: unknown} | null | undefined)?.status === 429) {return true;}
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return /too many requests|throttler|rate.?limit|relay_queue_full/i.test(msg);
}

/**
 * XO-3 — how a send failure should be charged.
 *
 *   'unreachable'       — we never got an answer (SN-04).
 *   'server-transient'  — "come back later", from EITHER side: the relay
 *                         answering 5xx, 408/425, its own 429 throttle or
 *                         `relay_queue_full`, no access token to present
 *                         (401 / local `no_token`), or (B-703 MR-6) a LOCAL
 *                         SQLCipher fault — a locked/busy database, a nested
 *                         transaction, disk I/O — which says nothing about
 *                         this envelope and clears on its own.
 *   'rejected'          — a semantic refusal that retrying cannot fix
 *                         (400 invalid_recipient / outer_sealed_too_large,
 *                         404, local crypto failures).
 *
 * Only 'rejected' consumes the 10-attempt budget. Status is duck-typed off
 * `RelayHttpError` so this store keeps no dependency on the transport layer.
 */
export type OutboxFailureKind = 'unreachable' | 'server-transient' | 'rejected';

export interface OutboxFailure {
  kind:          OutboxFailureKind;
  /** HTTP status when the relay answered; 0 for local/unreachable failures. */
  status:        number;
  /** Server-supplied Retry-After, clamped to the backoff ceiling. */
  retryAfterMs?: number;
}

/** Statuses below 500 that still mean "come back later", not "never". */
const SOFT_STATUSES = new Set([401, 408, 425, 429]);

export function classifyOutboxFailure(e: unknown): OutboxFailure {
  const status = typeof (e as {status?: unknown} | null)?.status === 'number'
    ? (e as {status: number}).status
    : 0;
  if (isUnreachableError(e)) {return {kind: 'unreachable', status};}
  // B-703 MR-6 — a LOCAL storage fault is not a rejection. The receive side has
  // curated this exact set for years (locked/busy, nested transaction, disk
  // I/O, db_closed) and leaves the envelope on the relay for a later pass; the
  // send side charged the SAME strings to the 10-attempt budget, so a burst of
  // SQLCipher contention — the backup mirror on its own handle, a B-701 storm's
  // wedged txn chain — walked a perfectly good message to a terminal red chip
  // in about twelve minutes. Same process, same database, opposite policies.
  // ONE rule now: imported, not re-written, so the two cannot drift.
  // Gated on `status === 0`: a local SQLCipher fault never carries an HTTP
  // status, and a RelayHttpError's MESSAGE is the server's response body — so
  // an ungated test feeds server text into a SQLite regex. It also has to sit
  // above the 5xx branch to be reachable at all for status 0, and an ungated
  // arm there would swallow a real relay answer's `Retry-After`.
  if (status === 0 && isTransientSqlError(e)) {return {kind: 'server-transient', status};}
  if (status >= 500 || SOFT_STATUSES.has(status) || (status === 0 && isBackpressureError(e))) {
    const raw = (e as {retryAfterMs?: unknown} | null)?.retryAfterMs;
    const retryAfterMs = typeof raw === 'number' && raw > 0
      ? Math.min(raw, MAX_BACKOFF_MS)
      : undefined;
    return {kind: 'server-transient', status, retryAfterMs};
  }
  return {kind: 'rejected', status};
}

export class SqlOutboxStore {
  constructor(private readonly db: DbHandle) {}

  /** Insert a brand-new outbox row. PK collision is treated as idempotent. */
  async enqueue(row: OutboxEnqueueInput): Promise<void> {
    const now = Date.now();
    await this.db.execute(
      `INSERT OR IGNORE INTO outbox (
         client_msg_id, conversation_id, message_id, peer_user_id,
         peer_device_id, payload, attempts, next_retry_at, created_at, status
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'pending')`,
      [
        row.clientMsgId, row.conversationId, row.messageId,
        row.peerUserId, row.peerDeviceId, row.payload,
        now, now,
      ],
    );
  }

  /**
   * Audit MSG-07 (2026-07-02): every message_id that still has ANY outbox row
   * (pending or failed). The boot sweep flips hydrated 'sending' bubbles with
   * NO row here to 'failed' — a crash between append and enqueue left them
   * permanently stuck in 'sending' with no retry path.
   */
  async allMessageIds(): Promise<Set<string>> {
    const result = await this.db.execute('SELECT DISTINCT message_id FROM outbox');
    const rows = (result.rows ?? []) as unknown as ReadonlyArray<{message_id: string}>;
    return new Set(rows.map(r => r.message_id));
  }

  /**
   * XO-5 — every message_id that still has a RETRIABLE outbox row.
   *
   * The MSG-07 boot sweep uses this to decide which hydrated 'sending' bubble
   * has no retry path left. 'failed' rows are excluded because `dueRows` will
   * never pick them up, so a bubble whose only rows are terminal must get the
   * retry chip rather than a clock that never resolves. A bubble that reached
   * at least one peer is already 'sent', so this can never downgrade a
   * delivered group message.
   */
  async pendingMessageIds(): Promise<Set<string>> {
    const result = await this.db.execute(
      "SELECT DISTINCT message_id FROM outbox WHERE status = 'pending'",
    );
    const rows = (result.rows ?? []) as unknown as ReadonlyArray<{message_id: string}>;
    return new Set(rows.map(r => r.message_id));
  }

  /**
   * Rows that are due for a retry attempt. Caller is expected to ship
   * each one and then call either markDelivered() (success) or
   * recordAttempt() (transient failure).
   */
  async dueRows(now: number = Date.now()): Promise<OutboxRow[]> {
    const result = await this.db.execute(
      `SELECT client_msg_id, conversation_id, message_id, peer_user_id,
              peer_device_id, payload, attempts, next_retry_at,
              created_at, status
         FROM outbox
        WHERE status = 'pending' AND next_retry_at <= ?
        ORDER BY created_at ASC`,
      [now],
    );
    const rows = (result.rows ?? []) as unknown as ReadonlyArray<{
      client_msg_id:   string;
      conversation_id: string;
      message_id:      string;
      peer_user_id:    string;
      peer_device_id:  number;
      payload:         string;
      attempts:        number;
      next_retry_at:   number;
      created_at:      number;
      status:          string;
    }>;
    return rows.map(r => ({
      clientMsgId:    r.client_msg_id,
      conversationId: r.conversation_id,
      messageId:      r.message_id,
      peerUserId:     r.peer_user_id,
      peerDeviceId:   r.peer_device_id,
      payload:        r.payload,
      attempts:       r.attempts,
      nextRetryAt:    r.next_retry_at,
      createdAt:      r.created_at,
      status:         r.status === 'failed' ? 'failed' : 'pending',
    }));
  }

  /**
   * Confirm delivery for one (clientMsgId, peer) row. Group sends call
   * this once per recipient; 1:1 sends call it once. Audit P0-N4: the
   * composite key prevents one peer's ack from clearing every peer's
   * row.
   */
  async markDelivered(
    clientMsgId: ClientMsgId,
    peerUserId: UserId,
    peerDeviceId: SignalDeviceId,
  ): Promise<void> {
    await this.db.execute(
      `DELETE FROM outbox
        WHERE client_msg_id = ?
          AND peer_user_id = ?
          AND peer_device_id = ?`,
      [clientMsgId, peerUserId, peerDeviceId],
    );
  }

  /**
   * Audit MSG-05 (2026-07-02): delete EVERY peer row for a clientMsgId.
   * Used by the tap-to-retry path: retry removes the failed bubble and
   * re-sends under a FRESH clientMsgId, so the old clientMsgId's outbox
   * row(s) must be dropped — otherwise the next reconnect drain also ships
   * the original envelope and the recipient receives the message twice
   * (different clientMsgIds, so the receive-side dedup can't catch it).
   */
  async deleteByClientMsgId(clientMsgId: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM outbox WHERE client_msg_id = ?',
      [clientMsgId],
    );
  }

  /**
   * Audit P2-10 — drop EVERY outbox row for a conversation. Used by
   * "Clear chat": without it, a still-queued (pending/failed) row keeps
   * getting re-shipped by the next reconnect drain even though the user
   * cleared the thread, so the recipient receives a message the sender
   * deleted. Deleting a single message routes through deleteByClientMsgId.
   */
  async deleteByConversation(conversationId: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM outbox WHERE conversation_id = ?',
      [conversationId],
    );
  }

  /**
   * Transient failure — bump attempts and schedule the next retry for
   * THIS (clientMsgId, peer) row. Returns the new attempt count so the
   * runtime can decide whether to surface a UI banner (after, say, 3
   * retries).
   */
  async recordAttempt(
    clientMsgId: string,
    peerUserId: string,
    peerDeviceId: number,
    /**
     * `unreachable` (SN-04) and `transient` (XO-3) both reschedule WITHOUT
     * consuming the budget — the first means "no answer", the second means
     * "the relay answered: later". `deferMs` is the single Retry-After seam:
     * when set it overrides the computed backoff (clamped to the 2m ceiling).
     * `permanent` (XO-5) terminates the row now — retrying the identical
     * bytes against a semantic rejection can only fail the same way.
     */
    opts?: {unreachable?: boolean; transient?: boolean; deferMs?: number; permanent?: boolean},
  ): Promise<{attempts: number; failed: boolean; queued: boolean}> {
    const existing = await this.db.execute(
      `SELECT attempts, soft_attempts FROM outbox
        WHERE client_msg_id = ?
          AND peer_user_id = ?
          AND peer_device_id = ?`,
      [clientMsgId, peerUserId, peerDeviceId],
    );
    const row = existing.rows?.[0] as unknown as
      {attempts: number; soft_attempts?: number} | undefined;
    if (!row) {
      // Already removed via markDelivered, or never existed. No-op.
      return {attempts: 0, failed: false, queued: false};
    }
    // XO-5 — the relay rejected the bytes, not the network. Retrying the same
    // envelope can only fail the same way, so terminate now instead of burning
    // the whole ladder of backoff with the bubble stuck mid-flight.
    if (opts?.permanent) {
      await this.db.execute(
        `UPDATE outbox SET status = 'failed'
          WHERE client_msg_id = ?
            AND peer_user_id = ?
            AND peer_device_id = ?`,
        [clientMsgId, peerUserId, peerDeviceId],
      );
      return {attempts: row.attempts, failed: true, queued: false};
    }
    // SN-04 — an unreachable network is not a delivery attempt.
    //
    // Offline sends fail in milliseconds, so with the 60s drain tick plus a
    // drain on every reconnect flap the 10-attempt budget burned out after
    // roughly half an hour of no connectivity. The row then flipped to
    // 'failed', and `dueRows` only selects 'pending' — so when the network
    // came back NOTHING auto-sent and the user had to tap retry on every
    // bubble individually. The relay holds envelopes for ~30 days; the queue
    // is meant to outlive a dead zone (the WhatsApp model this store's header
    // cites). Reserve the budget for attempts the SERVER actually rejected.
    //
    // Backoff still applies, so an offline device costs at most one attempt
    // per ceiling-interval (2 min) per row rather than a hot loop.
    //
    // XO-3 — a 5xx / 429 / no_token is the relay saying "later", not "no".
    // Charging it to the budget turned a ~30-min relay outage (or one group
    // fan-out tripping the per-user POST throttle) into a permanent 'failed'
    // row that no automatic drain will ever look at again.
    //
    // OM-07 — this branch used to index BACKOFF_MS by `attempts`, which it
    // deliberately never increments, so the delay was pinned at 1s forever.
    // `soft_attempts` is the escalating counter for BOTH no-budget classes;
    // an explicit deferMs (the server's Retry-After) overrides it.
    if (opts?.unreachable || opts?.transient || opts?.deferMs !== undefined) {
      const softAttempts = (row.soft_attempts ?? 0) + 1;
      const delay = opts.deferMs !== undefined && opts.deferMs > 0
        ? Math.min(opts.deferMs, MAX_BACKOFF_MS)
        : backoffFor(softAttempts - 1);
      await this.db.execute(
        `UPDATE outbox SET soft_attempts = ?, next_retry_at = ?
          WHERE client_msg_id = ?
            AND peer_user_id = ?
            AND peer_device_id = ?`,
        [softAttempts, Date.now() + delay, clientMsgId, peerUserId, peerDeviceId],
      );
      return {attempts: row.attempts, failed: false, queued: true};
    }
    const nextAttempts = row.attempts + 1;
    if (nextAttempts >= MAX_ATTEMPTS) {
      await this.db.execute(
        `UPDATE outbox SET attempts = ?, status = 'failed'
          WHERE client_msg_id = ?
            AND peer_user_id = ?
            AND peer_device_id = ?`,
        [nextAttempts, clientMsgId, peerUserId, peerDeviceId],
      );
      return {attempts: nextAttempts, failed: true, queued: false};
    }
    // BACKOFF_MS is bounded by MAX_ATTEMPTS-5 to keep the lookup safe
    // here; even the last slot caps at 2 min which keeps the relay
    // window (~30 days dwell) far from exhaustion.
    const delay = backoffFor(nextAttempts - 1);
    await this.db.execute(
      `UPDATE outbox
          SET attempts = ?, next_retry_at = ?
        WHERE client_msg_id = ?
          AND peer_user_id = ?
          AND peer_device_id = ?`,
      [nextAttempts, Date.now() + delay, clientMsgId, peerUserId, peerDeviceId],
    );
    return {attempts: nextAttempts, failed: false, queued: true};
  }

  /**
   * Operator/manual retry of a row that previously hit MAX_ATTEMPTS.
   * Resets attempts to 0 and schedules an immediate replay for the
   * specified (clientMsgId, peer) row.
   */
  async resetFailed(
    clientMsgId: string,
    peerUserId: string,
    peerDeviceId: number,
  ): Promise<void> {
    await this.db.execute(
      `UPDATE outbox
          SET attempts = 0, soft_attempts = 0, next_retry_at = ?, status = 'pending'
        WHERE client_msg_id = ?
          AND peer_user_id = ?
          AND peer_device_id = ?
          AND status = 'failed'`,
      [Date.now(), clientMsgId, peerUserId, peerDeviceId],
    );
  }

  /**
   * OM-07 — a fresh socket connect proves the network is back, so drop the
   * no-budget parking for every pending row. `dueRows` only returns rows past
   * `next_retry_at`, so without this the escalated soft backoff (up to 2 min)
   * would delay the reconnect drain that used to fire instantly.
   *
   * Deliberately does NOT touch `attempts` or `status='failed'` rows — those
   * are the server-rejection budget and only the user's tap-to-retry clears
   * them (`resetFailed`).
   */
  async clearUnreachableBackoff(now: number = Date.now()): Promise<void> {
    await this.db.execute(
      `UPDATE outbox
          SET soft_attempts = 0, next_retry_at = ?
        WHERE status = 'pending' AND soft_attempts > 0`,
      [now],
    );
  }

  /**
   * OR-1 — connectivity just came back, so any future `next_retry_at` is
   * stale by definition. Pull every still-pending row forward to `now` so the
   * next `dueRows()` sees it instead of waiting out up to 2 minutes of dead
   * time.
   *
   * Broader than `clearUnreachableBackoff` (it also un-parks rows backed off
   * by a server rejection, since a connectivity change is new information
   * there too) and narrower in what it writes: the soft counter is left alone
   * so the escalation ladder survives a flapping link. `attempts` is untouched
   * and `status='failed'` rows are excluded.
   */
  async kickPending(now: number = Date.now()): Promise<void> {
    await this.db.execute(
      `UPDATE outbox SET next_retry_at = ?
        WHERE status = 'pending' AND next_retry_at > ?`,
      [now, now],
    );
  }
}
