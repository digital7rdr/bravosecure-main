import {Injectable, Logger, OnModuleDestroy, OnModuleInit} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {acquireRedisLock, releaseRedisLock} from '../common/redis-lock';
import {BookingStateMachine} from './state-machine.service';

/**
 * Sweep stale PAYMENT_PENDING bookings to CANCELLED.
 *
 * The mobile client lands a booking in PAYMENT_PENDING when the user
 * starts the auto-debit countdown but bails out (insufficient credits,
 * "I'LL TOP UP LATER", app killed). Without a sweep, that row sits
 * forever and blocks the user's `active_booking_exists` slot — they
 * can't create any new booking until support manually cancels it.
 *
 * Design:
 *   - Window: PAYMENT_PENDING for > PAYMENT_PENDING_TTL_MIN minutes.
 *     Short enough to unblock real users quickly; long enough that a
 *     user briefly switching apps during top-up isn't penalized.
 *   - Multi-pod safe: each sweep wraps the work in a Redis SET NX lock
 *     so only one pod runs at a time.
 *   - Per-row transaction with SELECT FOR UPDATE — the FSM transition
 *     can race with a late payWithCredits arrival; whichever holds the
 *     row lock first wins. The looser branch (sweep) just no-ops if
 *     the status moved on.
 *
 * Triggered by setInterval — keeps the wiring minimal (no @nestjs/schedule
 * dependency). Safe because this service is single-instance per pod and
 * lock-guarded across pods.
 */
const PAYMENT_PENDING_TTL_MIN = 15;
const SWEEP_INTERVAL_MS = 60_000; // 1 min
const LOCK_KEY = 'lock:payment-pending-expiry';
const LOCK_TTL_MS = 55_000; // shorter than interval so a crashed sweeper doesn't pin the lock

@Injectable()
export class PaymentPendingExpiryService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PaymentPendingExpiryService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly fsm: BookingStateMachine,
  ) {}

  onModuleInit(): void {
    // Stagger the first run so app startup isn't competing with the sweep.
    this.timer = setInterval(() => { void this.sweepOnce(); }, SWEEP_INTERVAL_MS);
    this.log.log(`payment-pending-expiry sweeper started (ttl=${PAYMENT_PENDING_TTL_MIN}min interval=${SWEEP_INTERVAL_MS}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Public for tests — runs one sweep iteration. */
  async sweepOnce(): Promise<{cancelled: number; skipped_lock: boolean}> {
    const token = await acquireRedisLock(this.redis.client, LOCK_KEY, LOCK_TTL_MS);
    if (token === null) return {cancelled: 0, skipped_lock: true};
    try {
      const stale = await this.db.q<{id: string; client_id: string}>(
        `SELECT id, client_id FROM lite_bookings
          WHERE status = 'PAYMENT_PENDING'
            AND updated_at < NOW() - INTERVAL '${PAYMENT_PENDING_TTL_MIN} minutes'
          ORDER BY updated_at ASC
          LIMIT 50`,
      );
      let cancelled = 0;
      for (const r of stale) {
        try {
          const didCancel = await this.db.withTransaction(async tx => {
            const cur = await tx.qOne<{status: string}>(
              `SELECT status FROM lite_bookings WHERE id = $1 FOR UPDATE`,
              [r.id],
            );
            if (!cur || cur.status !== 'PAYMENT_PENDING') return false; // raced — skip
            this.fsm.assert(cur.status as never, 'CANCELLED', 'SYSTEM');
            const upd = await tx.q(
              `UPDATE lite_bookings SET status = 'CANCELLED' WHERE id = $1 AND status = 'PAYMENT_PENDING' RETURNING id`,
              [r.id],
            );
            return upd.length > 0;
          });
          if (!didCancel) continue;
          // INFRA-12 — audit AFTER commit. Inside the txn, a failed audit INSERT swallowed
          // by .catch() left the PG txn aborted, so the COMMIT silently ROLLED BACK the
          // CANCELLED flip while the sweep still counted it. Post-commit + best-effort.
          await this.db.q(
            `INSERT INTO booking_audit (booking_id, from_status, to_status, actor_user_id, actor_role, reason, metadata)
               VALUES ($1, 'PAYMENT_PENDING', 'CANCELLED', NULL, 'SYSTEM', $2, '{}'::jsonb)`,
            [r.id, `Auto-cancelled after ${PAYMENT_PENDING_TTL_MIN}min in PAYMENT_PENDING`],
          ).catch(() => undefined);
          cancelled++;
        } catch (e) {
          this.log.warn(`expiry sweep failed for booking ${r.id}: ${(e as Error).message}`);
        }
      }
      if (cancelled > 0) this.log.log(`payment-pending-expiry swept ${cancelled} stale booking(s)`);
      return {cancelled, skipped_lock: false};
    } finally {
      await releaseRedisLock(this.redis.client, LOCK_KEY, token);
    }
  }
}
