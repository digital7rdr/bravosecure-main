import {Injectable, Logger, type OnModuleInit, type OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {acquireRedisLock, releaseRedisLock} from '../common/redis-lock';
import {BookingStateMachine} from '../booking/state-machine.service';
import {OpsAuditService} from '../ops/ops-audit.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import {WalletService} from '../wallet/wallet.service';

/**
 * Sweep 2 — crew-assign SLA watchdog (BUILD_RUNBOOK Step 8 / LB5).
 *
 * An agency that ACCEPTED a job (booking CONFIRMED, crew_deadline_at stamped at
 * accept) but never assigned crew — i.e. no `missions` row — before the deadline
 * is a provider no-show. This sweep flips the booking CONFIRMED -> AGENCY_NO_SHOW,
 * supersedes any stray live offer, increments the agency's reliability_breaches,
 * and wakes the client. So the client is never stranded on a CONFIRMED booking no
 * guard is coming to.
 *
 * Multi-pod safe via the Redis `SET NX` lock (LB9), same shape as Sweep 1.
 *
 * ⚠️ SINGLE OWNER: this is THE crew-SLA sweep. Do NOT add a second crew-SLA sweep
 * (e.g. a booking-module one) — two sweeps on different lock keys would not be
 * mutually exclusive and could both act on the same overdue booking.
 *
 * MONEY (Step 9, wired): the no-show refund runs via WalletService.refundEscrowHold
 * on flagNoShow's OWN `tx` handle, so the escrow HELD->REFUNDED move (client gets
 * their held credits back) is ATOMIC with the AGENCY_NO_SHOW flip. It is idempotent
 * (a non-HELD hold is a no-op) and a no-op when the booking was never charged.
 */
const SWEEP_INTERVAL_MS = 60_000;         // 1 min
const LOCK_KEY = 'lock:dispatch-crew-sla';
const LOCK_TTL_MS = 55_000;               // < interval so a crashed sweeper doesn't pin the lock
const LIVENESS_KEY = 'dispatch:watchdog:crew:last_run';
const BATCH = 50;

@Injectable()
export class CrewSlaService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(CrewSlaService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly fsm: BookingStateMachine,
    private readonly audit: OpsAuditService,
    private readonly push: BookingPushBridge,
    private readonly wallet: WalletService,
  ) {}

  onModuleInit(): void {
    // INFRA-3 — the in-flight MONEY resolvers must run regardless of
    // AUTO_DISPATCH_ENABLED: turning the flag off must not strand held escrow. This
    // sweep's query is scoped to dispatch_mode='auto', so a legacy-only deployment is
    // a cheap no-op. (Contrast the offer-CREATING sweeps, which stay flag-gated.)
    this.timer = setInterval(() => { void this.sweepOnce(); }, SWEEP_INTERVAL_MS);
    this.log.log(`crew-SLA sweeper started (interval=${SWEEP_INTERVAL_MS}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private enabled(): boolean {
    return this.config.get<boolean>('featureFlags.autoDispatch') ?? false;
  }

  /** Public for tests — runs one sweep iteration. */
  async sweepOnce(): Promise<{flagged: number; skipped_lock: boolean; skipped_flag: boolean}> {
    // INFRA-3 — always-on (see onModuleInit). skipped_flag is kept in the shape for
    // back-compat but is never set now: the flag no longer gates this money resolver.
    const token = await acquireRedisLock(this.redis.client, LOCK_KEY, LOCK_TTL_MS);
    if (token === null) {
      return {flagged: 0, skipped_lock: true, skipped_flag: false};
    }
    try {
      const due = await this.db.q<{id: string}>(
        // Why: scope to AUTO bookings explicitly (dispatch_mode='auto' + a stamped
        // crew_deadline_at), so this can never flag a legacy/manual CONFIRMED booking
        // even if some future path stamps crew_deadline_at on one — the no-show +
        // breach penalty is an auto-dispatch concept only.
        `SELECT b.id
           FROM lite_bookings b
          WHERE b.status = 'CONFIRMED'
            AND b.dispatch_mode = 'auto'
            AND b.crew_deadline_at IS NOT NULL
            AND b.crew_deadline_at < NOW()
            -- LM-B1: an ABORTED mission from a prior re-dispatch round is history,
            -- not crew — only a live (non-ABORTED) mission counts as "crewed".
            AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.booking_id = b.id AND m.status <> 'ABORTED')
          ORDER BY b.crew_deadline_at ASC
          LIMIT ${BATCH}`,
      );
      let flagged = 0;
      for (const r of due) {
        try {
          if (await this.flagNoShow(r.id)) {
            flagged++;
          }
        } catch (e) {
          this.log.warn(`crew-SLA failed for ${r.id}: ${(e as Error).message}`);
        }
      }
      await this.redis.client.set(LIVENESS_KEY, String(Date.now()), 'EX', 600).catch(() => undefined);
      return {flagged, skipped_lock: false, skipped_flag: false};
    } finally {
      await releaseRedisLock(this.redis.client, LOCK_KEY, token);
    }
  }

  /** One booking, in its own txn: re-check under the row lock, flip to
   *  AGENCY_NO_SHOW, supersede any live offer, bump the agency breach counter.
   *  Audit + client wake happen best-effort after the commit. */
  private async flagNoShow(bookingId: string): Promise<boolean> {
    const result = await this.db.withTransaction(async tx => {
      const cur = await tx.qOne<{status: string; client_id: string; assigned_provider_user_id: string | null}>(
        `SELECT status, client_id, assigned_provider_user_id
           FROM lite_bookings WHERE id = $1 FOR UPDATE`,
        [bookingId],
      );
      if (!cur || cur.status !== 'CONFIRMED') {
        return null; // raced — accepted-then-completed/cancelled, or already swept
      }
      // Re-check no mission under the booking lock — crew may have been assigned
      // just now. ⚠️ INVARIANT for Step 13 (crew-assign): the mission-writer MUST
      // take `lite_bookings FOR UPDATE` (or do its conditional UPDATE on
      // lite_bookings) ATOMIC with the INSERT INTO missions. Otherwise, at READ
      // COMMITTED this re-check can miss an uncommitted mission insert and flip a
      // booking that is in fact being crewed. The runbook designs crew-assign as a
      // conditional UPDATE on lite_bookings (RUNBOOK §"crew-assign"), which closes
      // it — that lock-ordering is the contract this sweep relies on.
      const mission = await tx.qOne<{id: string}>(
        `SELECT id FROM missions WHERE booking_id = $1 AND status <> 'ABORTED' LIMIT 1`,
        [bookingId],
      );
      if (mission) {
        return null; // crewed in time — not a no-show
      }
      this.fsm.assert('CONFIRMED', 'AGENCY_NO_SHOW', 'SYSTEM');
      const upd = await tx.q(
        `UPDATE lite_bookings SET status = 'AGENCY_NO_SHOW', dispatch_settled_at = NOW()
          WHERE id = $1 AND status = 'CONFIRMED' RETURNING id`,
        [bookingId],
      );
      if (upd.length === 0) {
        return null; // raced
      }
      // Retire any stray live offer for this booking (defensive).
      await tx.q(
        `UPDATE dispatch_offers SET status = 'SUPERSEDED', responded_at = NOW()
          WHERE booking_id = $1 AND status = 'OFFERED'`,
        [bookingId],
      );
      // Flag the accepting agency — a provider-fault breach drives reliability.
      if (cur.assigned_provider_user_id) {
        await tx.q(
          `UPDATE agents SET reliability_breaches = reliability_breaches + 1 WHERE user_id = $1`,
          [cur.assigned_provider_user_id],
        );
      } else {
        // Unreachable in practice (accept() always sets assigned_provider_user_id in
        // the same UPDATE that stamps crew_deadline_at) — but make a data-integrity
        // break observable rather than silently dropping the breach attribution.
        this.log.warn(`crew-SLA no-show on ${bookingId} with no assigned_provider_user_id — breach not attributed`);
      }
      // Refund the client from escrow (HELD -> REFUNDED) in THIS txn — atomic with
      // the AGENCY_NO_SHOW flip. Idempotent, and a no-op when the booking was never
      // charged (0-total/free). The agency forfeits the job; the client is made whole.
      await this.wallet.refundEscrowHold(tx, bookingId, `Agency no-show ${bookingId}`);
      // TODO(LB13): optionally re-dispatch via DispatchService.start for a replacement.
      return {clientId: cur.client_id};
    });
    if (!result) {
      return false;
    }
    await this.audit.record({
      actor_id: null, actor_role: 'SYSTEM', action: 'dispatch.agency_no_show',
      subject_type: 'booking', subject_id: bookingId,
    });
    // LM-V6 — booking-status audit row for the client-facing timeline.
    await this.db.q(
      `INSERT INTO lite_booking_audit (booking_id, from_status, to_status, actor_id, actor_role, metadata)
       VALUES ($1, 'CONFIRMED', 'AGENCY_NO_SHOW', NULL, 'SYSTEM', $2::jsonb)`,
      [bookingId, JSON.stringify({reason: 'crew_sla_breach'})],
    ).catch(e => this.log.warn(`audit insert failed for ${bookingId}: ${(e as Error).message}`));
    // Best-effort wake — the client app also polls GET /bookings/:id.
    void this.push.agencyNoShow(result.clientId, bookingId).catch(() => undefined);
    return true;
  }
}
