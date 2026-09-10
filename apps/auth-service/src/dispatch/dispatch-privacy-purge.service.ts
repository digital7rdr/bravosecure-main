import {Injectable, Logger, type OnModuleInit, type OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {acquireRedisLock, releaseRedisLock} from '../common/redis-lock';

/**
 * Privacy / retention purge sweep (BUILD_RUNBOOK Step 22).
 *
 * Two data-minimization jobs, both run on a slow Redis-locked tick so only one
 * pod works per interval (auth-service is multi-replica). Ships DARK behind
 * AUTO_DISPATCH_ENABLED, mirroring the other dispatch sweeps.
 *
 *   1. Offer reject-reason redaction — a rejected/expired/superseded offer keeps
 *      its free-text `reject_reason` only long enough to debug a live cascade.
 *      After OFFER_PII_TTL_HOURS we NULL it so the diagnostic string can't linger.
 *      (dispatch_offers stores NO coordinates — coarse offers carry only
 *      `distance_km`, never lat/lng — so reject_reason is the only PII to purge.)
 *
 *   2. Mission-telemetry retention — `mission_telemetry_last` is the single-row
 *      Postgres fallback holding a booking's most recent GPS fix. The Redis
 *      stream already self-expires; this row otherwise lingers forever. Once a
 *      booking reaches a terminal state we keep the last fix only briefly (for a
 *      post-trip replay), then DELETE it. This NARROWS retention (deletes sooner,
 *      never widens) — it does not touch the relay/transport dwell window.
 *
 * Both are best-effort cleanup: a failed tick simply retries next interval.
 */
const SWEEP_INTERVAL_MS = 5 * 60_000;     // 5 min — retention cleanup, not real-time
const LOCK_KEY = 'lock:dispatch-privacy-purge';
const LOCK_TTL_MS = 4 * 60_000;           // < interval so a crashed sweeper can't pin the lock
const OFFER_PII_TTL_HOURS = 24;           // redact reject_reason 24h after the offer closed
const TELEMETRY_RETENTION_HOURS = 24;     // purge the last GPS fix 24h after the booking terminal

const TERMINAL_BOOKING_STATES = ['COMPLETED', 'CANCELLED', 'NO_PROVIDER', 'AGENCY_NO_SHOW'];

@Injectable()
export class DispatchPrivacyPurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DispatchPrivacyPurgeService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled()) {
      this.log.log('auto-dispatch off — privacy-purge sweeper not started');
      return;
    }
    this.timer = setInterval(() => { void this.sweepOnce(); }, SWEEP_INTERVAL_MS);
    this.log.log(`privacy-purge sweeper started (interval=${SWEEP_INTERVAL_MS}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private enabled(): boolean {
    return this.config.get<boolean>('featureFlags.autoDispatch') ?? false;
  }

  /** Public for tests — runs one sweep iteration. */
  async sweepOnce(): Promise<{offers_redacted: number; telemetry_purged: number; skipped_lock: boolean; skipped_flag: boolean}> {
    if (!this.enabled()) {
      return {offers_redacted: 0, telemetry_purged: 0, skipped_lock: false, skipped_flag: true};
    }
    const token = await acquireRedisLock(this.redis.client, LOCK_KEY, LOCK_TTL_MS);
    if (token === null) {
      return {offers_redacted: 0, telemetry_purged: 0, skipped_lock: true, skipped_flag: false};
    }
    try {
      let offers_redacted = 0;
      let telemetry_purged = 0;

      // 1 — redact stale offer reject reasons (the only PII on dispatch_offers).
      try {
        const redacted = await this.db.q<{id: string}>(
          `UPDATE dispatch_offers
              SET reject_reason = NULL
            WHERE status IN ('REJECTED', 'EXPIRED', 'SUPERSEDED')
              AND reject_reason IS NOT NULL
              AND responded_at < NOW() - ($1 || ' hours')::interval
            RETURNING id`,
          [OFFER_PII_TTL_HOURS],
        );
        offers_redacted = redacted.length;
      } catch (e) {
        this.log.warn(`offer reject-reason purge failed: ${(e as Error).message}`);
      }

      // 2 — purge the last-GPS-fix fallback row for terminal bookings past retention.
      try {
        const purged = await this.db.q<{booking_id: string}>(
          `DELETE FROM mission_telemetry_last t
            USING lite_bookings b
            WHERE b.id = t.booking_id
              AND b.status::text = ANY($1::text[])
              AND b.updated_at < NOW() - ($2 || ' hours')::interval
            RETURNING t.booking_id`,
          [TERMINAL_BOOKING_STATES, TELEMETRY_RETENTION_HOURS],
        );
        telemetry_purged = purged.length;
      } catch (e) {
        this.log.warn(`telemetry retention purge failed: ${(e as Error).message}`);
      }

      if (offers_redacted > 0 || telemetry_purged > 0) {
        this.log.log(`privacy-purge: redacted ${offers_redacted} offer reason(s), purged ${telemetry_purged} telemetry row(s)`);
      }
      return {offers_redacted, telemetry_purged, skipped_lock: false, skipped_flag: false};
    } finally {
      await releaseRedisLock(this.redis.client, LOCK_KEY, token);
    }
  }
}
