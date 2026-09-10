import {Injectable, Logger, type OnModuleInit, type OnModuleDestroy} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {acquireRedisLock, releaseRedisLock} from '../common/redis-lock';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';

/**
 * B-405 — scheduled-booking start reminder (founder req 2026-08-09).
 *
 * A 'later' booking is a parked reservation: after ops approval nothing visible
 * happens until the scheduled-dispatch sweeper starts the CPO search ~15 min
 * before pickup. The client who booked days ahead gets ONE push reminder
 * REMINDER_LEAD_MINUTES (default 60) before pickup_time.
 *
 * Applies to every 'later' booking still alive pre-mission (PENDING_OPS /
 * OPS_APPROVED / PAYMENT_PENDING / CONFIRMED) — legacy and auto alike — so it
 * is NOT gated behind AUTO_DISPATCH_ENABLED. Bookings whose pickup already
 * passed are skipped: "starts within the hour" would be a lie, and the
 * dispatch/ops flows own the overdue cases.
 *
 * Multi-pod safe: Redis SET NX lock per tick (TTL < interval), and the
 * per-row conditional claim (`reminder_sent_at IS NULL`) makes the send
 * at-most-once even without the lock.
 */
const SWEEP_INTERVAL_MS = 60_000; // 1 min
const LOCK_KEY = 'lock:booking-reminder';
const LOCK_TTL_MS = 55_000;       // < interval so a crashed sweeper can't pin the lock
// Why: Number('') is 0 and a typo is NaN — either would silently kill the
// feature or error every sweep ('NaN minutes'::interval). Fall back to 60.
const RAW_LEAD = Number(process.env['BOOKING_REMINDER_LEAD_MINUTES'] ?? '60');
const REMINDER_LEAD_MINUTES = Number.isFinite(RAW_LEAD) && RAW_LEAD > 0 ? RAW_LEAD : 60;
const BATCH = 50;

@Injectable()
export class BookingReminderService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(BookingReminderService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly push: BookingPushBridge,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => { void this.sweepOnce(); }, SWEEP_INTERVAL_MS);
    this.log.log(`booking-reminder sweeper started (interval=${SWEEP_INTERVAL_MS}ms lead=${REMINDER_LEAD_MINUTES}min)`);
  }

  onModuleDestroy(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Public for tests — runs one sweep iteration. NEVER throws: this is
   *  driven by a fire-and-forget setInterval, and an escaping rejection is an
   *  unhandledRejection that terminates the whole auth-service process
   *  (3-agent review, 2026-08-09 — e.g. code deployed before the
   *  reminder_sent_at migration would otherwise crash-loop every pod). */
  async sweepOnce(): Promise<{reminded: number; skipped_lock: boolean}> {
    try {
      const token = await acquireRedisLock(this.redis.client, LOCK_KEY, LOCK_TTL_MS);
      if (token === null) {
        return {reminded: 0, skipped_lock: true};
      }
      try {
        const due = await this.db.q<{id: string; client_id: string}>(
          `SELECT id, client_id FROM lite_bookings
            WHERE booking_mode = 'later'
              AND status IN ('PENDING_OPS','OPS_APPROVED','PAYMENT_PENDING','CONFIRMED')
              AND reminder_sent_at IS NULL
              AND pickup_time <= NOW() + ($1 || ' minutes')::interval
              AND pickup_time > NOW()
            ORDER BY pickup_time ASC
            LIMIT ${BATCH}`,
          [REMINDER_LEAD_MINUTES],
        );
        let reminded = 0;
        for (const b of due) {
          try {
            // Claim BEFORE publishing — the conditional write is the idempotency
            // gate (at-most-once; the durable inbox row rides the same publish).
            // The claim re-checks status + mode: the booking may have been
            // cancelled/rejected between the SELECT and this row's turn.
            const claimed = await this.db.q<{id: string}>(
              `UPDATE lite_bookings SET reminder_sent_at = NOW()
                WHERE id = $1 AND reminder_sent_at IS NULL
                  AND booking_mode = 'later'
                  AND status IN ('PENDING_OPS','OPS_APPROVED','PAYMENT_PENDING','CONFIRMED')
                RETURNING id`,
              [b.id],
            );
            if (claimed.length === 0) {continue;}
            await this.push.bookingReminder(b.client_id, b.id);
            reminded += 1;
          } catch (e) {
            this.log.warn(`reminder failed for ${b.id}: ${(e as Error).message}`);
          }
        }
        if (reminded > 0) {this.log.log(`sent ${reminded} booking start reminder(s)`);}
        return {reminded, skipped_lock: false};
      } finally {
        await releaseRedisLock(this.redis.client, LOCK_KEY, token);
      }
    } catch (e) {
      this.log.error(`reminder sweep failed: ${(e as Error).message}`);
      return {reminded: 0, skipped_lock: false};
    }
  }
}
