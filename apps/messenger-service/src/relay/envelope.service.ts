import {Injectable, Logger, BadRequestException, ForbiddenException, HttpException, HttpStatus} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {Cron, CronExpression} from '@nestjs/schedule';
import {randomUUID} from 'node:crypto';
import {EnvelopeStore, PendingQueueFullError, parsePendingKey} from './envelope.store';
import type {ReceiptOutcome, SendEnvelopeInput, SendEnvelopeResult, StoredEnvelope} from './envelope.types';
import type {ServerEnvelopeDeliver, SessionAddress} from '../gateway/protocol';
import {ConnectionRegistry} from '../gateway/connection-registry';
import {SocketHub} from '../gateway/socket-hub';
import {BackupService} from '../backup/backup.service';
import {RedisService} from '../redis/redis.service';
import {runWithReplicaLock} from '../redis/replica-lock';

/**
 * Central relay logic:
 *   - `sendFromSender` ingests a client submission, stamps verified
 *     sender claims, persists, and fans out to any connected device(s).
 *   - `pull` / `ack` — per-device batch retrieval + hard-delete.
 *   - `sweepAllOrphans` — iterate every pending ZSET and drop members
 *     whose main key has expired. Called by the daily cron.
 *
 * The service never sees plaintext — ciphertext is opaque. We still
 * size-limit it to prevent memory abuse; anything over the configured
 * cap is rejected at ingest.
 */
/**
 * B-715 — floor (ms) above which the post-persist tail of a submit is logged.
 *
 * The tail is a handful of Redis round-trips and is expected to be low
 * single-digit ms, so an unconditional line would be pure noise on the relay's
 * highest-volume route. A floor makes the log line mean something: it fires only
 * when the gap between "the message is durable" and "the push can start" is
 * large enough to be a real contributor to a person's wait.
 */
const SUBMIT_TAIL_WARN_MS = 50;

@Injectable()
export class EnvelopeService {
  private readonly logger = new Logger(EnvelopeService.name);

  constructor(
    private readonly store:    EnvelopeStore,
    private readonly registry: ConnectionRegistry,
    private readonly hub:      SocketHub,
    private readonly config:   ConfigService,
    private readonly backup:   BackupService,
    private readonly redis:    RedisService,
  ) {}

  private get dwellSeconds(): number {
    return this.config.get<number>('relay.dwellSeconds') ?? 30 * 24 * 3600;
  }

  /**
   * Audit P0-N9 — strict-mode flag. When true, an ack without a token
   * is rejected outright; when false (emergency rollback only) missing
   * tokens fall back to the legacy recipient-identity check and emit
   * a warning.
   *
   * Messaging-transport audit P1-4 — default flipped to TRUE so the
   * P0-N9 fix is actually enforced. Legacy clients that never shipped
   * ack tokens are now hard-rejected, which is the intended end state.
   * Operators can set `RELAY_REQUIRE_ACK_TOKEN=false` only as an
   * emergency rollback during a regression window.
   */
  private get requireAckToken(): boolean {
    return this.config.get<boolean>('relay.requireAckToken') ?? true;
  }

  private get maxCiphertextBytes(): number {
    // Cap on the Sealed Sender v2 outer-wrap byte length (after base64).
    // Inner libsignal ciphertext is bounded at 256 KB and the outer
    // wrap adds 45 bytes of header + 16 bytes of GCM tag, so 512 KB
    // raw → ~700 KB once base64 gives us comfortable headroom without
    // inviting memory abuse.
    return this.config.get<number>('relay.maxCiphertextBytes') ?? 700 * 1024;
  }

  /**
   * Accept a sealed envelope from an authenticated submitter. The
   * submitter's user id is NOT stored — Sealed Sender means the
   * server keeps no link between envelope content and sender identity.
   * We still require a valid JWT at ingest for rate limiting + DoS
   * protection; that trust context dies at the end of this call.
   */
  async submitEnvelope(input: SendEnvelopeInput): Promise<SendEnvelopeResult> {
    if (!input.recipient?.userId || !(input.recipient.deviceId >= 1)) {
      throw new BadRequestException('invalid_recipient');
    }
    if (!input.outerSealed || typeof input.outerSealed !== 'string') {
      throw new BadRequestException('invalid_outer_sealed');
    }
    const bodyLen = Buffer.byteLength(input.outerSealed, 'utf8');
    if (bodyLen > this.maxCiphertextBytes) {
      throw new BadRequestException('outer_sealed_too_large');
    }

    const now = Date.now();
    const envelopeId = randomUUID();
    const retractToken = randomUUID();

    // Disappearing-message TTL: when the sender provides a deadline that
    // lands before the default dwell, use that as the Redis TTL so the
    // ciphertext self-evicts at its advertised expiry — even if the
    // recipient never comes online to ACK. Minimum 1s to avoid rejecting
    // "already expired" envelopes as invalid (Redis requires EX >= 1).
    //
    // Round 2 / Security audit: cap the remaining window at the server's
    // own dwell ceiling. The original code only LOWERED `effectiveTtl`
    // when `remaining < dwellSeconds`, but it never validated the upper
    // bound. A malicious client could submit `expiresAtSec` 100 years in
    // the future; the line below then stored that as the envelope's
    // metadata even though the Redis TTL was capped at `dwellSeconds`.
    // The retract-token storage path also used `effectiveTtl` so storage
    // exhaustion wasn't directly possible — but the metadata leak meant
    // the recipient saw a bogus expiry. Hard-cap remaining at the dwell
    // window AND clamp the stored expiresAtSec to match.
    // Round 7 / crypto audit fix F28 — preserve the client's
    // recipient-side expiresAtSec verbatim. Two distinct concerns:
    //
    //   `effectiveTtl` (Redis TTL): the dwell window during which the
    //     envelope sits in Redis waiting for the recipient to pick it
    //     up. Must be capped at `dwellSeconds` for storage hygiene.
    //
    //   `storedExpiresAtSec` (recipient-side disappearing-message
    //     deadline): how long the recipient's app keeps the message
    //     after delivery. Must be carried through unchanged so a
    //     90-day disappearing message expires at 90 days on the
    //     recipient, not at the dwell window.
    //
    // Previously these two values were collapsed: a long-TTL message
    // was rewritten to `now + dwellSeconds` for BOTH purposes, silently
    // shortening every disappearing-message deadline to ~30 days.
    let effectiveTtl = this.dwellSeconds;
    const storedExpiresAtSec = input.expiresAtSec;
    if (typeof input.expiresAtSec === 'number') {
      const remaining = input.expiresAtSec - Math.floor(now / 1000);
      if (remaining < 1) {
        // Audit P1-T5 — previously threw `expires_in_past` (400). That
        // turned the endpoint into a recipient/device enumeration
        // oracle: an attacker iterating recipientUserId/deviceId pairs
        // saw 400 when the recipient was valid (DTO + expiry checks
        // both ran) vs the validation 400 when invalid, leaking which
        // tuples exist. Treat "already expired" as a no-op: ACCEPT
        // the submit, mint the same shape (envelopeId, retractToken)
        // the caller expects, but DO NOT persist or fan out. The
        // caller can't distinguish this from "persisted and expired
        // immediately on the recipient", which is the desired
        // ambiguity.
        return {
          envelopeId,
          clientMsgId:  input.clientMsgId,
          deliveredNow: false,
          retractToken,
          // Audit P2-BR-3 — already expired: nothing persisted or fanned
          // out, so a killed device must not be woken for it.
          wakeEligible: false,
        };
      }
      // Only the storage TTL is shortened when the recipient deadline
      // is sooner than dwell. The recipient-side deadline is left as
      // the client supplied it.
      if (remaining < effectiveTtl) {
        effectiveTtl = remaining;
      }
    }

    // Audit P0-N5 — server-side dedup on (recipient, clientMsgId).
    // The mobile outbox + watchdog can submit the same envelope twice
    // (WS ack times out, HTTP fallback fires, then the late ack arrives
    // and re-pushes via drainOutbox). Without this gate, every retry
    // creates a fresh envelope and the recipient sees duplicate bubbles.
    // Atomic SET NX EX means concurrent submits never both win.
    if (input.clientMsgId) {
      const dedup = await this.store.claimClientMsgId(
        input.recipient,
        input.clientMsgId,
        {envelopeId, retractToken},
        this.dwellSeconds,
      );
      if (!dedup.stored && dedup.existing) {
        // Already accepted under this clientMsgId; return the original
        // result so the sender treats it as success and stops retrying.
        // `deliveredNow` is intentionally false — by the time we're here
        // the original envelope may already be acked/deleted, and we have
        // no cheap way to tell whether the recipient is currently online.
        // Sender UI only uses this hint locally; the persisted ack flow
        // still drives the canonical state.
        return {
          envelopeId:   dedup.existing.envelopeId,
          clientMsgId:  input.clientMsgId,
          deliveredNow: false,
          retractToken: dedup.existing.retractToken,
          // Audit P2-BR-3 — dedup HIT: this is a retried send; the original
          // already fired its chat wake. Re-firing here phantom-banners a
          // killed device for a message it already has queued.
          wakeEligible: false,
        };
      }
    }

    const env: StoredEnvelope = {
      envelopeId,
      recipient:    input.recipient,
      outerSealed:  input.outerSealed,
      timestamp:    now,
      dwellExpires: now + effectiveTtl * 1000,
      expiresAtSec: storedExpiresAtSec,
    };
    // B-715 T3 — the DURABILITY instant. Everything before this line is required
    // before the message can be called accepted; everything after it is capability
    // and routing work that the recipient's wake does not depend on. The founder's
    // question "what is the backend waiting for before it starts the push?" is
    // answered by `postPutMs` below, which measures exactly this tail.
    let putAtMs = 0;
    try {
      await this.store.put(env, effectiveTtl);
      putAtMs = Date.now();
    } catch (e) {
      // Audit P1-16 — release the dedup claim on ANY put failure, not only
      // the queue-full case. If `store.put` fails for any other reason
      // (Redis OOM under `noeviction`, a connection drop between the claim
      // and the put, a failover mid-submit) the SET-NX claim would survive
      // while nothing was persisted; the client's outbox retry then hits
      // the still-claimed dedup key and gets the cached
      // {envelopeId, retractToken} echoed back as a FAKE success — no
      // envelope in Redis, no archive row, and the message is silently lost
      // for the full 30-day dwell. Releasing here makes the retry a fresh
      // submit. Best-effort: the dedup key TTLs out within the dwell anyway.
      if (input.clientMsgId) {
        await this.store.releaseClientMsgId(input.recipient, input.clientMsgId).catch(() => { /* best-effort */ });
      }
      // Audit P0-7 — recipient queue at ceiling. Map to HTTP 429 so the
      // submitter knows to back off; the message is intentionally
      // recipient-agnostic so an attacker can't enumerate which devices
      // are heavily queued.
      if (e instanceof PendingQueueFullError) {
        throw new HttpException('relay_queue_full', HttpStatus.TOO_MANY_REQUESTS);
      }
      throw e;
    }

    // AUDIT-2026-08-13 #4 — everything after a successful put is BEST-EFFORT.
    // The envelope is already durable (Redis row above; the archive hook
    // below is fire-and-forget and best-effort in its own right); the writes
    // here only add CAPABILITIES on top of it (retract mapping, receipt
    // slot, delivered-routing), and the fan-out only adds the LIVE path.
    // The old code let any of these throw, which aborted AFTER persistence
    // + dedup claim: the client's outbox retry then hit the dedup echo
    // (deliveredNow:false, wakeEligible:false) and neither fanned out nor
    // fired the chat wake — a persisted message invisible to a killed-app
    // recipient until its next reconnect drain, with the sender shown
    // success. A Redis blip in this window must degrade capabilities, never
    // the message: swallow + log loudly, and return an accurate success so
    // the caller still fires the FCM wake. The wake survives the DOMINANT
    // failure class (a single-command write failure — OOM under noeviction,
    // WRONGTYPE, per-command timeout — leaves the wake's token-registry
    // READS working) but shares Redis on a CONNECTION-LEVEL outage; that
    // residual has no code fix (you cannot push without the token registry)
    // and recovery is then the next reconnect drain.
    // The dedup claim is intentionally KEPT on these failures — releasing it
    // would let the retry mint a DUPLICATE envelope (the exact P0-N5 bug).
    // Honest degradation ledger when a key is missing (message intact):
    //   retract-token → the sender's retract for THIS envelope no-ops
    //     ({retracted:false}); the client treats retract as fire-and-forget
    //     (expiry sweeper), so this is invisible;
    //   receipt-slot  → for HTTP submits this is the ONLY delivered-tick
    //     source (that lane passes no submitter by design), and the client
    //     memoises the resulting 'unknown' for the session — the bubble can
    //     sit at one tick until app restart. Message + wake unaffected;
    //   submitter-map → the recipient's ack can't route envelope.delivered
    //     to the sender's live socket (silent skip is the documented miss
    //     path in takeSubmitter);
    //   fan-out       → no live WS deliver; the wake (when reachable, see
    //     above) or the next reconnect drain covers delivery of the
    //     persisted envelope.
    const auxFailed: string[] = [];
    let lastAuxErr = '';
    const noteAuxFailure = (label: string, e: unknown): void => {
      auxFailed.push(label);
      // String(...?.message ?? e): a NON-Error rejection (string, null,
      // plain object) must not throw INSIDE this handler — that would abort
      // post-put with the claim held, re-creating the exact bug this block
      // exists to kill, with the original cause destroyed by a TypeError.
      lastAuxErr = String((e as Error)?.message ?? e).replace(/\s+/g, ' ');
    };
    // The aux writes touch independent keys with no ordering dependency —
    // run them CONCURRENTLY so a degraded submit burns one offline-queue
    // retry budget (~1-2s), not three sequentially (~4-5s, which would
    // straddle the client's 5s WS ack watchdog and trip a spurious
    // reconnect + HTTP fallback; harmless — the kept claim coalesces it —
    // but pointless churn).
    const auxOps: Array<{label: string; run: () => Promise<void>}> = [
      // M12 retract-capability mapping (`retract:{token} → envelopeId`).
      {label: 'retract-token', run: () => this.store.storeRetractToken(retractToken, envelopeId, effectiveTtl)},
    ];
    // OM-03 — HTTP submitters have no live socket for `envelope.delivered`
    // and Sealed Sender forbids recording WHO submitted, so park an
    // identity-free outcome slot the sender can poll with the capability
    // token it already holds. Opened only when the client asks, so WS
    // submits and legacy clients cost nothing.
    if (input.receipt) {
      auxOps.push({label: 'receipt-slot', run: () => this.store.openReceipt(envelopeId, retractToken, effectiveTtl)});
    }
    // Audit P0-T6 — transient submitter mapping so the recipient's ack
    // can route an `envelope.delivered` back to the original sender
    // device. The WS gateway passes a submitter address; the HTTP
    // controller does not (HTTP submitters have no live socket to
    // notify). The mapping lives in `submitter:{envelopeId}` with the
    // same TTL as the envelope, and is read-then-deleted by ack so
    // sealed-sender is preserved at the storage layer.
    if (input.submitter) {
      const submitter = input.submitter;
      auxOps.push({label: 'submitter-map', run: () => this.store.storeSubmitter(envelopeId, submitter, effectiveTtl)});
    }
    const settled = await Promise.allSettled(auxOps.map(op => op.run()));
    settled.forEach((r, i) => {
      if (r.status === 'rejected') noteAuxFailure(auxOps[i].label, r.reason);
    });

    // Restore-after-reinstall fix #3 — server-side mirror of every
    // accepted envelope into the long-term sealed_envelope_archive
    // table, keyed by recipient userId. Sealed Sender keeps the
    // server cryptographically blind: outerSealed is opaque, and the
    // recipient ID is the only routing fact we need. Without this
    // mirror, every envelope that was acked + Redis-deleted before
    // the recipient's NEXT reinstall is permanently gone — the very
    // bug that left users with most of their chat history missing.
    // Fire-and-forget: a Supabase blip must never block the relay.
    void this.backup.archiveSealedEnvelope({
      recipientUserId: env.recipient.userId,
      envelopeId:      env.envelopeId,
      outerSealed:     env.outerSealed,
      timestampMs:     env.timestamp,
      // Audit P1-T1 — propagate the recipient-side expiry so the long-
      // term archive honours disappearing-message TTLs. Without this,
      // a "1-hour disappearing" message lived 90 days in the archive
      // even though the active relay path correctly self-evicted at
      // 1 hour. The archive sweeper uses this column to drop expired
      // rows ahead of the 90-day default retention.
      expiresAtSec:    storedExpiresAtSec,
    }).catch(() => { /* logged inside the service */ });

    // AUDIT #4 — the fan-out's ack-token mint is a Redis call too (the same
    // blip that broke an aux write above throws HERE); a live-path failure
    // must not un-succeed a persisted submit either.
    let deliveredNow = false;
    try {
      deliveredNow = await this.tryFanOut(env);
    } catch (e) {
      noteAuxFailure('fan-out', e);
    }

    if (auxFailed.length > 0) {
      this.logger.error(
        `[submit] post-persist writes failed envId=${envelopeId.slice(0, 8)} failed=${auxFailed.join(',')} err=${lastAuxErr.slice(0, 120)} — ` +
        'envelope IS stored (archive attempted) and the submit succeeds; the named capabilities are degraded for this envelope; ' +
        'recipient recovers via wake (if reachable) or the next reconnect drain.',
      );
    }

    // B-715 T3→T5 — how long the caller waited AFTER durability before it could
    // start the push. This is the "is our backend sitting on the notification?"
    // number, and until now it did not exist: the only server timestamps were the
    // `accepted` line (printed here, at the END of this tail) and the push line,
    // so the tail itself was invisible and could only be assumed small.
    //
    // What is inside it, in order: the concurrent aux writes (retract token,
    // receipt slot, submitter map), the fire-and-forget archive hand-off, and the
    // awaited `tryFanOut` — whose ack-token mint is one more Redis round-trip
    // before the live emit. Logged only above a floor so the common case stays
    // quiet; ids truncated, numbers only.
    const postPutMs = putAtMs > 0 ? Date.now() - putAtMs : -1;
    if (postPutMs >= SUBMIT_TAIL_WARN_MS) {
      this.logger.warn(
        `[submit] slow post-persist tail envId=${envelopeId.slice(0, 8)} postPutMs=${postPutMs} aux=${auxOps.length} live=${deliveredNow}`,
      );
    }
    return {envelopeId, clientMsgId: input.clientMsgId, deliveredNow, retractToken, wakeEligible: true, postPutMs};
  }

  /**
   * Pull pending envelopes for the caller. `afterTs` is a cursor; on
   * first fetch pass 0 — callers typically persist the timestamp of
   * the last successful ack and use it as the next afterTs.
   *
   * Restore-after-reinstall fix #4 — `bootstrap=true` raises the cap
   * to relay.maxBootstrapLimit (default 1000). The default is the
   * common-case ceiling; the bootstrap ceiling is the rare reinstall-
   * after-vacation case where the user has thousands of dwelling
   * envelopes and would otherwise need many round-trips to drain.
   */
  async pull(
    caller: SessionAddress,
    afterTs: number,
    limit: number,
    opts?: {bootstrap?: boolean},
  ): Promise<StoredEnvelope[]> {
    const cap = opts?.bootstrap
      ? (this.config.get<number>('relay.maxBootstrapLimit') ?? 1000)
      : (this.config.get<number>('relay.maxPullLimit') ?? 100);
    const cappedLimit = Math.max(1, Math.min(limit, cap));
    const envs = await this.store.listForDevice(caller, afterTs, cappedLimit);
    // Audit P0-N9 — attach the per-envelope ack token so the recipient
    // can prove possession on the corresponding POST /envelopes/:id/ack.
    // Same get-or-mint as the WS deliver path, so a hybrid client that
    // first sees an envelope on WS and then re-pulls over HTTP gets the
    // same token both times.
    return Promise.all(envs.map(async env => ({
      ...env,
      ackToken: await this.store.getOrMintAckToken(env.envelopeId, this.dwellSeconds),
    })));
  }

  /**
   * ACK + hard-delete. Ownership checks:
   *   1. Only the envelope's recipient may ack (defense in depth).
   *   2. Audit P0-N9 — possession-proof: the caller must present the
   *      ack token issued in the deliver frame. Without this, a
   *      compromised device could iterate envelope-ids and ack
   *      messages it never received, wiping undelivered envelopes
   *      from the relay before the legitimate device pulls them.
   *
   * Token enforcement is optional during the rollout window so legacy
   * clients keep working. Operator flips `relay.requireAckToken=true`
   * once 100% of clients ship the new field; before that, missing
   * tokens fall back to the legacy recipient-identity check and emit
   * a warning we can monitor in telemetry.
   *
   * Audit P0-T6 — after the hard-delete succeeds, look up the original
   * submitter mapping and emit `envelope.delivered` back to that
   * device so the sender can paint the double-tick. The mapping is
   * single-use (takeSubmitter does an atomic GETDEL — audit item 5) so a
   * duplicate ack of the same envelopeId can't fire the event twice. Failures of the
   * emit path are best-effort: the envelope IS gone from the relay
   * regardless, and the sender's local message-history fetch on
   * reconnect will still surface the recipient's read receipt once
   * they actually read it.
   */
  async ack(
    caller: SessionAddress,
    envelopeId: string,
    ackToken?: string,
    // Handoff §3.6(c) — ack-outcome split. 'delivered' (default, legacy)
    // emits `envelope.delivered`; 'discarded' means the recipient device
    // destroyed the message (terminal decrypt failure) — the envelope is
    // deleted either way, but the sender gets `envelope.undeliverable`
    // instead of a lying double-tick. The relay learns exactly one bit
    // (decrypt outcome) it could not see before — owner-approved
    // 2026-07-03; note the plaintext read-receipt fan-out already
    // discloses strictly more per envelope.
    disposition: 'delivered' | 'discarded' = 'delivered',
  ): Promise<void> {
    const env = await this.store.get(envelopeId);
    if (!env) {
      // Idempotent: already gone. Return silently — caller may retry.
      // Note: a retried ack that races a concurrent submitter mapping
      // won't accidentally re-fire delivered, because the FIRST ack
      // already consumed the submitter key via takeSubmitter.
      return;
    }
    if (env.recipient.userId !== caller.userId || env.recipient.deviceId !== caller.deviceId) {
      throw new ForbiddenException('not_recipient');
    }
    if (ackToken) {
      const ok = await this.store.verifyAckToken(envelopeId, ackToken);
      if (!ok) {
        throw new ForbiddenException('bad_ack_token');
      }
    } else if (this.requireAckToken) {
      throw new ForbiddenException('ack_token_required');
    } else {
      this.logger.warn(
        `[P0-N9] legacy ack without token caller=${caller.userId.slice(0, 8)}/${caller.deviceId} env=${envelopeId.slice(0, 8)}`,
      );
    }
    await this.store.ack(envelopeId, caller);
    // Audit P0-N9 — drop the token alongside the envelope so a replayed
    // ack with the same token finds neither and silently no-ops.
    await this.store.deleteAckToken(envelopeId);

    // OM-03 — settle the anonymous receipt BEFORE the submitter emit, in
    // its own try: a hub failure on the WS path must not swallow the
    // receipt the HTTP path depends on.
    try {
      await this.store.settleReceipt(envelopeId, disposition);
    } catch (e) {
      this.logger.warn(`[OM-03] receipt settle failed for ${envelopeId}: ${(e as Error).message}`);
    }

    // Audit P0-T6 — fire the sender-facing delivered notification.
    // Read the submitter mapping AFTER the hard-delete so a crash
    // between ack-delete and submitter-take leaves the mapping to
    // expire by TTL rather than letting a stale submitter receive
    // delivered for an envelope that never actually deleted. Errors
    // here are non-fatal — the ack itself succeeded.
    try {
      const submitter = await this.store.takeSubmitter(envelopeId);
      if (submitter) {
        if (disposition === 'discarded') {
          // Handoff §3.6(c) — the recipient destroyed the message; tell
          // the sender the truth instead of painting ✓✓.
          this.hub.emitToDevice(submitter, 'envelope.undeliverable', {envelopeId});
          try { await this.store.addPendingUndeliverable(submitter.userId, envelopeId); }
          catch { /* best-effort — the live emit may have landed */ }
        } else {
          this.hub.emitToDevice(submitter, 'envelope.delivered', {envelopeId});
          // Audit RELAY-C3 — also queue it so a sender who was offline at this
          // moment still gets the double-tick on their next connect (the live
          // emit above is fire-and-forget with no delivery guarantee).
          try { await this.store.addPendingDelivered(submitter.userId, envelopeId); }
          catch { /* best-effort — the live emit may have landed */ }
        }
      }
    } catch (e) {
      this.logger.warn(
        `[P0-T6] delivered-emit failed for ${envelopeId}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * SRV-05 — batch ack. Each item is run through the SAME `ack()` above,
   * so the P0-N9 possession proof is still verified per envelope and no
   * ownership check is relaxed; the only thing batched is the HTTP
   * round-trip. Per-item failures are reported, never fatal: a stale or
   * forbidden entry must not block the rest of a drain.
   *
   * Sealed Sender is untouched — the caller is the RECIPIENT (already
   * identified by JWT on the single-ack route) and every envelope in the
   * batch is already known to the relay as queued for that device, so
   * grouping them reveals nothing the pending ZSET does not.
   */
  async ackBatch(
    caller: SessionAddress,
    items:  Array<{envelopeId: string; ackToken: string; disposition?: 'delivered' | 'discarded'}>,
  ): Promise<{results: Array<{envelopeId: string; status: 'ok' | 'forbidden' | 'error'}>}> {
    const results: Array<{envelopeId: string; status: 'ok' | 'forbidden' | 'error'}> = [];
    for (const item of items) {
      try {
        await this.ack(
          caller,
          item.envelopeId,
          item.ackToken,
          item.disposition === 'discarded' ? 'discarded' : 'delivered',
        );
        results.push({envelopeId: item.envelopeId, status: 'ok'});
      } catch (e) {
        const forbidden = e instanceof ForbiddenException;
        if (!forbidden) {
          this.logger.warn(`[SRV-05] batch ack item failed env=${item.envelopeId.slice(0, 8)}: ${(e as Error).message}`);
        }
        results.push({envelopeId: item.envelopeId, status: forbidden ? 'forbidden' : 'error'});
      }
    }
    return {results};
  }

  /**
   * Audit RELAY-C3 — drain + emit the queued delivered receipts for a sender
   * that just (re)connected. Called from the gateway's handleConnection.
   * Idempotent on the client, so re-emitting one it already saw is harmless.
   */
  async flushPendingDelivered(addr: SessionAddress): Promise<void> {
    // Audit SRV-03 — non-destructive drain (same shape as the F7 read-receipt
    // block below): emit first, remove only what emitted. A crash or an emit
    // throw used to destroy the receipt permanently.
    try {
      const settled: string[] = [];
      for (const envelopeId of await this.store.peekPendingDelivered(addr.userId)) {
        try {
          this.hub.emitToDevice(addr, 'envelope.delivered', {envelopeId});
          settled.push(envelopeId);
        } catch { /* emit threw — leave this entry queued for the next drain */ }
      }
      await this.store.removePendingDelivered(addr.userId, settled);
    } catch (e) {
      this.logger.warn(`[RELAY-C3] flushPendingDelivered failed for ${addr.userId}: ${(e as Error).message}`);
    }
    // Handoff §3.6(c) — replay queued `envelope.undeliverable` receipts
    // the same way. Client's applyEnvelopeUndeliverable is idempotent.
    try {
      const settled: string[] = [];
      for (const envelopeId of await this.store.peekPendingUndeliverable(addr.userId)) {
        try {
          this.hub.emitToDevice(addr, 'envelope.undeliverable', {envelopeId});
          settled.push(envelopeId);
        } catch { /* emit threw — leave this entry queued for the next drain */ }
      }
      await this.store.removePendingUndeliverable(addr.userId, settled);
    } catch (e) {
      this.logger.warn(`[3.6c] flushPendingUndeliverable failed for ${addr.userId}: ${(e as Error).message}`);
    }
    // F7 — replay read-receipt frames queued while this device had no
    // live socket. Payloads are the exact `{from, envelopeIds}` frame
    // data the gateway would have emitted.
    //
    // Folded P2 (socket cluster) — NON-DESTRUCTIVE drain. The previous
    // implementation popped the whole queue (SMEMBERS+DEL) and THEN emitted,
    // so a crash — or an emit throw — between the pop and the emit destroyed
    // the receipts permanently. Now: peek, emit, and delete only the entries
    // that emitted without throwing. Anything left behind (a mid-drain crash,
    // a hub error) survives in Redis and re-emits on the next connect; the
    // client applies read-receipts idempotently, so a duplicate replay is
    // harmless. The queue keeps its original 7-day TTL, so a persistently
    // undeliverable entry still ages out.
    try {
      const raws = await this.store.peekPendingReadReceipts(addr);
      const settled: string[] = [];
      for (const raw of raws) {
        let frame: unknown;
        try {
          frame = JSON.parse(raw);
        } catch {
          // Malformed entry is never deliverable — mark it for removal so it
          // can't wedge the queue.
          settled.push(raw);
          continue;
        }
        try {
          this.hub.emitToDevice(addr, 'read-receipt', frame);
          settled.push(raw);
        } catch { /* emit threw — leave this entry queued for the next drain */ }
      }
      if (settled.length > 0) {
        await this.store.removePendingReadReceipts(addr, settled);
      }
    } catch (e) {
      this.logger.warn(`[F7] flushPendingReadReceipts failed for ${addr.userId}: ${(e as Error).message}`);
    }
  }

  /**
   * F7 — durable read-receipt handoff for a target device with no live
   * socket. Reuses the RELAY-C3 offline-receipt queue mechanics; drained
   * by `flushPendingDelivered` on the target's next connect.
   */
  async queueReadReceipt(
    to:   SessionAddress,
    data: {from: SessionAddress; envelopeIds: string[]},
  ): Promise<void> {
    await this.store.addPendingReadReceipt(to, JSON.stringify(data));
  }

  /**
   * OM-03 — capability-gated delivery-receipt read. Identity-free by
   * construction: the only auth is the retract token the submitter
   * received at submit (same model as `retract`), and an unknown
   * envelope is indistinguishable from a bad token.
   */
  async readReceipts(
    items: Array<{envelopeId: string; retractToken: string}>,
  ): Promise<Array<{envelopeId: string; outcome: ReceiptOutcome}>> {
    return Promise.all(items.map(async ({envelopeId, retractToken}) => ({
      envelopeId,
      outcome: await this.store.readReceipt(envelopeId, retractToken),
    })));
  }

  /**
   * M12: sender-initiated retract.
   *
   * Closes the Phase-1 gap where a disappearing message might sit on
   * the relay for the full 30-day dwell if the recipient is offline.
   *
   * Auth model: capability token, not sender identity. On submit we
   * issue a random UUID back to the client ("retractToken"); only a
   * caller presenting that token can retract. This preserves Sealed
   * Sender — the server learns nothing about who originally sent the
   * envelope. Client is responsible for safeguarding the token; if
   * it's stolen the attacker can retract the message but cannot
   * read it or impersonate the sender.
   */
  async retract(retractToken: string): Promise<{retracted: boolean}> {
    if (!/^[0-9a-f-]{36}$/i.test(retractToken)) {
      throw new BadRequestException('invalid_retract_token');
    }
    const envelopeId = await this.store.consumeRetractToken(retractToken);
    if (!envelopeId) return {retracted: false};
    const env = await this.store.get(envelopeId);
    if (!env) return {retracted: false};
    await this.store.ack(envelopeId, env.recipient);
    return {retracted: true};
  }

  /**
   * Sprint-6 — purge every queued envelope for the JWT-authenticated
   * caller's device after their identity rotated. Returns the count of
   * envelopes dropped from the pending queue. Idempotent.
   *
   * The `supersededIdentityB64` argument is a possession-proof hint
   * (the caller knows it because they just rotated away from it). The
   * server CAN'T cryptographically verify each queued envelope was
   * wrapped to that exact identity — outerSealed is opaque by design.
   * Authorisation is the JWT (caller proves account ownership) plus
   * the device scope (only the caller's own queue is touched).
   *
   * The hint IS validated for shape — it must be a non-empty string —
   * so a malformed body can't slip through. We never store or log the
   * identity bytes themselves.
   */
  async purgeStaleRecipientQueue(
    caller:                SessionAddress,
    supersededIdentityB64: string,
  ): Promise<{purged: number}> {
    if (typeof supersededIdentityB64 !== 'string' || supersededIdentityB64.length === 0) {
      throw new BadRequestException('invalid_superseded_identity');
    }
    const result = await this.store.purgeRecipientQueue(caller);
    if (result.purged > 0) {
      this.logger.log(
        `[Sprint-6] purged ${result.purged} stale-recipient envelopes for ` +
        `${caller.userId.slice(0, 8)}/${caller.deviceId}`,
      );
    }
    return result;
  }

  /**
   * Daily sweep — scans every pending:* ZSET and drops orphan members.
   */
  async sweepAllOrphans(): Promise<number> {
    let total = 0;
    for await (const key of this.store.scanPendingKeys()) {
      const addr = parsePendingKey(key);
      if (!addr) continue;
      total += await this.store.sweepPending(addr);
    }
    if (total > 0) this.logger.log(`sweep removed ${total} orphan refs`);
    return total;
  }

  /**
   * Cron — every 5 minutes. Runs the orphan sweep so ZSET indexes shed
   * members whose Redis-TTL'd content has just auto-evicted.
   *
   * Disappearing-message content is already auto-evicted by Redis at
   * the TTL we set in submitEnvelope (shrunk to expiresAtSec when the
   * sender asked). This cron closes the loop on the pending index so
   * subsequent `pull()` calls don't waste a round-trip on ghost ids.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, {name: 'envelope-sweep'})
  async scheduledSweep(): Promise<void> {
    // HIGH-2 — one replica per tick. TTL (4 min) < the 5-min cadence so a
    // missed release still frees the lock before the next scheduled run.
    await runWithReplicaLock(this.redis, 'relay:envelope-sweep:lock', 240, async () => {
      try {
        await this.sweepAllOrphans();
      } catch (e) {
        this.logger.warn(`scheduled sweep failed: ${(e as Error).message}`);
      }
    });
  }

  private async tryFanOut(env: StoredEnvelope): Promise<boolean> {
    // Audit P0-N9 — mint (or fetch existing) ack token so the recipient
    // can prove possession on the corresponding envelope.ack. The token
    // shares the envelope's dwell TTL: it can never outlive what it
    // protects.
    const ackToken = await this.store.getOrMintAckToken(env.envelopeId, this.dwellSeconds);
    const frame: ServerEnvelopeDeliver = {
      event: 'envelope.deliver',
      data: {
        envelopeId:  env.envelopeId,
        outerSealed: env.outerSealed,
        timestamp:   env.timestamp,
        ackToken,
      },
    };
    // Route through the socket.io Redis adapter — reaches the recipient
    // regardless of which replica holds the socket.
    this.hub.emitToDevice(env.recipient, frame.event, frame.data);

    // `deliveredNow` is a best-effort local hint for the sender's UI.
    // Cross-node delivery still happens via the emit above; this flag
    // just tells us whether the recipient was connected on THIS node.
    // False here does not mean undelivered — the envelope is also
    // persisted for the next pull.
    const localHit = this.registry.get(env.recipient.userId, env.recipient.deviceId) != null;
    this.logger.log(`[envelope.deliver] emit envId=${env.envelopeId.slice(0,8)} → ${env.recipient.userId.slice(0,8)}/${env.recipient.deviceId} localSocket=${localHit}`);
    return localHit;
  }
}
