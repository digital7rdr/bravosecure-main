import {Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {acquireRedisLock, releaseRedisLock} from '../common/redis-lock';
import {WalletService} from '../wallet/wallet.service';
import {BookingStateMachine, type BookingStatus} from '../booking/state-machine.service';
import {BookingPushBridge} from './booking-push-bridge.service';

/**
 * LM-D1 — booking↔mission drift janitor.
 *
 * A mission must never stay active (DISPATCHED/PICKUP/LIVE/SOS) once its booking is
 * terminal (COMPLETED/CANCELLED/NO_PROVIDER/AGENCY_NO_SHOW). Staging carried 8 such
 * rows (missions stuck LIVE since 2026-04-24 under CONFIRMED-then-closed bookings)
 * with no sweeper to close them — and every drifted mission pins its crew "busy"
 * via mission_crew_agent_active_uq, so those CPOs can never be re-crewed.
 *
 * Each hit: close the mission (COMPLETED when the booking completed, else ABORTED
 * with end_reason='drift_janitor'), stand the crew down, and log a warn — the log
 * line is the alert surface (Sentry picks up warn+). Deliberately NOT gated on
 * AUTO_DISPATCH_ENABLED: drift hurts legacy bookings the same way.
 *
 * Multi-pod safe via the Redis SET NX lock, mirroring the dispatch sweeps.
 */
const SWEEP_INTERVAL_MS = 10 * 60_000;    // 10 min — drift is rare, not urgent
const LOCK_KEY = 'lock:mission-drift-janitor';
const LOCK_TTL_MS = 9 * 60_000;
const BATCH = 50;

@Injectable()
export class MissionDriftJanitorService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MissionDriftJanitorService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    // STALE-EXPIRY sweep deps (all cycle-free within OpsModule's imports).
    // Optional so the existing direct-constructed specs keep working; the
    // expiry step no-ops without them.
    @Optional() private readonly wallet?: WalletService,
    @Optional() private readonly fsm?: BookingStateMachine,
    @Optional() private readonly bookingPush?: BookingPushBridge,
    @Optional() private readonly config?: ConfigService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => { void this.sweepOnce(); }, SWEEP_INTERVAL_MS);
    // One eager pass shortly after boot so a deploy immediately heals known drift.
    setTimeout(() => { void this.sweepOnce(); }, 30_000);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Public for tests — one sweep iteration. */
  async sweepOnce(): Promise<{healed: number; expired: number; reconciled: number; skipped_lock: boolean}> {
    const token = await acquireRedisLock(this.redis.client, LOCK_KEY, LOCK_TTL_MS);
    if (token === null) {
      return {healed: 0, expired: 0, reconciled: 0, skipped_lock: true};
    }
    try {
      const drifted = await this.db.q<{id: string; mission_status: string; booking_status: string; booking_id: string}>(
        `SELECT m.id, m.status AS mission_status, b.status AS booking_status, b.id AS booking_id
           FROM missions m
           JOIN lite_bookings b ON b.id = m.booking_id
          WHERE m.status IN ('DISPATCHED','PICKUP','LIVE','SOS')
            AND b.status IN ('COMPLETED','CANCELLED','NO_PROVIDER','AGENCY_NO_SHOW')
          ORDER BY m.created_at ASC
          LIMIT ${BATCH}`,
      );
      let healed = 0;
      for (const row of drifted) {
        try {
          await this.db.withTransaction(async tx => {
            const to = row.booking_status === 'COMPLETED' ? 'COMPLETED' : 'ABORTED';
            const upd = await tx.q(
              `UPDATE missions
                  SET status = $2, ended_at = COALESCE(ended_at, NOW()),
                      end_reason = COALESCE(end_reason, 'drift_janitor')
                WHERE id = $1 AND status IN ('DISPATCHED','PICKUP','LIVE','SOS')
                RETURNING id`,
              [row.id, to],
            );
            if (upd.length === 0) return; // raced — something else closed it
            await tx.q(
              `UPDATE mission_crew SET status = 'off' WHERE mission_id = $1 AND status <> 'off'`,
              [row.id],
            );
            healed++;
            this.log.warn(
              `[mission-drift] healed mission=${row.id} (${row.mission_status} → ${to}) ` +
              `booking=${row.booking_id} (${row.booking_status}) — investigate the path that left it open`,
            );
          });
        } catch (e) {
          this.log.warn(`[mission-drift] heal failed for mission=${row.id}: ${(e as Error).message}`);
        }
      }
      const expired = await this.expireStaleBookings();
      // INFRA-10 — retry any legacy refund a prior pass committed the cancel for
      // but failed to pay out (post-commit, un-retried until now).
      const reconciled = await this.reconcileStrandedRefunds();
      return {healed, expired, reconciled, skipped_lock: false};
    } finally {
      await releaseRedisLock(this.redis.client, LOCK_KEY, token);
    }
  }

  /**
   * STALE-EXPIRY — the Uber-style hard stop the flow was missing. Timeouts by phase:
   *   • DISPATCHING (searching): the offer cascade already terminates at
   *     NO_PROVIDER within ~5 min — not this sweep's job.
   *   • Auto accept-without-crew: the crew-SLA watchdog fires at 15 min.
   *   • EVERYTHING ELSE that can strand a client forever — a LEGACY booking ops
   *     never dispatched (PENDING_OPS / OPS_APPROVED / paid CONFIRMED), or an old
   *     auto CONFIRMED with no crew_deadline_at stamp — had NO timeout at all
   *     (live example: a paid booking stuck "Awaiting team assignment" since
   *     June 21). This sweep cancels any such booking still UNCREWED 60 minutes
   *     past its pickup time, refunds in full (escrow hold or captured legacy
   *     payment), and wakes the client. The client's one-active-booking slot
   *     frees so they can rebook.
   */
  private async expireStaleBookings(): Promise<number> {
    if (!this.fsm || !this.wallet) {return 0;} // direct-constructed test instance
    const graceMin = this.config?.get<number>('booking.staleUncrewedGraceMinutes') ?? 60;
    const due = await this.db.q<{id: string}>(
      `SELECT b.id
         FROM lite_bookings b
        WHERE b.status IN ('PENDING_OPS', 'OPS_APPROVED', 'CONFIRMED')
          AND b.pickup_time < NOW() - ($1 || ' minutes')::interval
          AND NOT EXISTS (SELECT 1 FROM missions m
                           WHERE m.booking_id = b.id AND m.status <> 'ABORTED')
        ORDER BY b.pickup_time ASC
        LIMIT ${BATCH}`,
      [graceMin],
    );
    let expired = 0;
    for (const row of due) {
      try {
        const result = await this.db.withTransaction(async tx => {
          const cur = await tx.qOne<{status: BookingStatus; client_id: string; payment_captured: boolean; payer_user_id: string | null}>(
            `SELECT status, client_id, payment_captured, payer_user_id FROM lite_bookings
              WHERE id = $1 FOR UPDATE`,
            [row.id],
          );
          if (!cur || !['PENDING_OPS', 'OPS_APPROVED', 'CONFIRMED'].includes(cur.status)) {return null;}
          // Re-check under the lock — crew may have just been assigned.
          const crewed = await tx.qOne<{id: string}>(
            `SELECT id FROM missions WHERE booking_id = $1 AND status <> 'ABORTED' LIMIT 1`,
            [row.id],
          );
          if (crewed) {return null;}
          this.fsm!.assert(cur.status, 'CANCELLED', 'SYSTEM');
          const upd = await tx.q(
            `UPDATE lite_bookings SET status = 'CANCELLED',
                    dispatch_settled_at = COALESCE(dispatch_settled_at, NOW())
              WHERE id = $1 AND status = $2 RETURNING id`,
            [row.id, cur.status],
          );
          if (upd.length === 0) {return null;}
          // Retire any stray live offer (LM-B2 discipline).
          await tx.q(
            `UPDATE dispatch_offers SET status = 'SUPERSEDED', responded_at = NOW()
              WHERE booking_id = $1 AND status = 'OFFERED'`,
            [row.id],
          );
          // Escrow refund in-txn (idempotent no-op when nothing is HELD).
          const r = await this.wallet!.refundEscrowHold(tx, row.id, `Expired uncrewed · booking ${row.id}`);
          await tx.q(
            `INSERT INTO lite_booking_audit (booking_id, from_status, to_status, actor_id, actor_role, metadata)
             VALUES ($1, $2, 'CANCELLED', NULL, 'SYSTEM', $3::jsonb)`,
            [row.id, cur.status, JSON.stringify({reason: 'stale_uncrewed_expiry', grace_minutes: graceMin})],
          );
          // B-374 — the legacy refund must credit the wallet that PAID (family
          // holder on a member booking), not the booking client.
          return {clientId: cur.client_id, payerId: cur.payer_user_id ?? cur.client_id, escrowRefund: r.credits, paymentCaptured: cur.payment_captured, from: cur.status};
        });
        if (!result) {continue;}
        expired++;
        // Legacy captured-credit refund (idempotent per user+booking) — outside
        // the txn, mirroring BookingService.cancel.
        let refunded = result.escrowRefund;
        if (refunded === 0 && result.paymentCaptured) {
          try {
            const lr = await this.wallet!.refundForBooking(
              result.payerId, row.id, `Refund · booking ${row.id} expired uncrewed`);
            refunded = lr.credits;
          } catch (e) {
            this.log.error(`[stale-expiry] legacy refund failed booking=${row.id}: ${(e as Error).message}`);
          }
        }
        this.log.warn(`[stale-expiry] cancelled uncrewed booking=${row.id} (was ${result.from}, refunded ${refunded} BC)`);
        // Wake the client: cancelled + (when money moved) refunded.
        if (refunded > 0) {
          void this.bookingPush?.agencyNoShow(result.clientId, row.id).catch(() => undefined);
          void this.bookingPush?.refundIssued(result.clientId, row.id, refunded).catch(() => undefined);
        } else {
          void this.bookingPush?.bookingRejected(result.clientId, row.id).catch(() => undefined);
        }
      } catch (e) {
        this.log.warn(`[stale-expiry] failed for booking=${row.id}: ${(e as Error).message}`);
      }
    }
    return expired;
  }

  /**
   * INFRA-10 — heal a stranded LEGACY refund. expireStaleBookings performs the
   * captured-credit refund POST-COMMIT (refundForBooking opens its own txn, so it
   * cannot join the cancel txn). If that call threw — or the pod died between the
   * commit and the refund — the booking is already CANCELLED, the status guard
   * never re-selects it, and the client's money was silently kept.
   *
   * This re-finds those bookings and retries the (idempotent) refund. It is
   * SCOPED TIGHT on purpose: only cancellations this janitor made for
   * `stale_uncrewed_expiry` are unconditionally full-refund-owed. A client-
   * initiated late cancel may legitimately keep a cancel fee, so a blanket
   * "cancelled + captured + no refund → refund" sweep would refund fees the
   * platform is owed. The audit row that carries that reason commits INSIDE the
   * cancel txn (before the post-commit refund), so a stranded refund is always
   * findable by it even when the payout never happened.
   */
  private async reconcileStrandedRefunds(): Promise<number> {
    if (!this.wallet) {return 0;} // direct-constructed test instance
    const stranded = (await this.db.q<{id: string; client_id: string; payer_user_id: string | null}>(
      `SELECT b.id, b.client_id, b.payer_user_id
         FROM lite_bookings b
        WHERE b.status = 'CANCELLED'
          AND b.payment_captured = TRUE
          AND EXISTS (SELECT 1 FROM lite_booking_audit a
                       WHERE a.booking_id = b.id AND a.to_status = 'CANCELLED'
                         AND a.metadata->>'reason' = 'stale_uncrewed_expiry')
          AND EXISTS (SELECT 1 FROM wallet_transactions wt
                       WHERE wt.booking_id = b.id AND wt.type = 'payment'
                         AND wt.status = 'succeeded' AND wt.amount_credits < 0)
          AND NOT EXISTS (SELECT 1 FROM wallet_transactions wt
                           WHERE wt.booking_id = b.id AND wt.type = 'refund'
                             AND wt.metadata->>'kind' = 'booking_refund')
        ORDER BY b.dispatch_settled_at ASC NULLS LAST
        LIMIT ${BATCH}`,
    )) ?? [];
    let reconciled = 0;
    for (const row of stranded) {
      try {
        // Credit the payer that was debited (family holder on a member booking).
        const payerId = row.payer_user_id ?? row.client_id;
        const lr = await this.wallet.refundForBooking(
          payerId, row.id, `Refund · booking ${row.id} expired uncrewed (reconciled)`);
        if (lr.credits > 0) {
          reconciled++;
          this.log.warn(`[stale-expiry] reconciled stranded refund booking=${row.id} (+${lr.credits} BC)`);
          void this.bookingPush?.refundIssued(row.client_id, row.id, lr.credits).catch(() => undefined);
        }
      } catch (e) {
        this.log.error(`[stale-expiry] reconcile refund failed booking=${row.id}: ${(e as Error).message}`);
      }
    }
    return reconciled;
  }
}
