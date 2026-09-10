import {Injectable, Logger, Optional, type OnModuleInit, type OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {acquireRedisLock, releaseRedisLock} from '../common/redis-lock';
import {DispatchService} from './dispatch.service';
import {DispatchMetricsService} from '../observability/dispatch-metrics.service';

/**
 * Sweep 4 — relist/orphan timeout (JOB_PORTAL_MARKETPLACE_SPEC P4 + review D2).
 *
 * A withdraw (or arrival no-show) RELISTS a booking to DISPATCHING with its escrow
 * hold still HELD, and the portal — not the ranked cascade — is its re-offer surface,
 * so nothing else ever drives it terminal: no live OFFERED row for the offer-expiry
 * sweep, no crew deadline for the crew-SLA sweep. Without this sweep the client's
 * money could sit HELD behind a perpetual "searching…" forever. Every interval it
 * finds auto DISPATCHING bookings that have been searching longer than the TTL with
 * NO live offer and closes them via DispatchService.noProvider — whose R12 refund
 * returns the HELD credits. Also catches a cascade-orphaned row (offerNext retry
 * budget exhausted) the Step-8 watchdog can't re-drive.
 *
 * Multi-pod safe via the Redis `SET NX` lock; ships dark behind
 * AUTO_DISPATCH_ENABLED. Mirrors offer-expiry.service.ts verbatim in shape.
 */
const SWEEP_INTERVAL_MS = 60_000;
const LOCK_KEY = 'lock:dispatch-relist-timeout';
const LOCK_TTL_MS = 55_000; // < interval so a crashed sweeper doesn't pin the lock
const LIVENESS_KEY = 'dispatch:watchdog:relist:last_run';
const BATCH = 25;
// How long an offer-less DISPATCHING booking may keep searching before the client
// gets their money + a clear NO_PROVIDER answer. Env-tunable for staging demos.
const RELIST_TTL_MINUTES = Number(process.env['DISPATCH_RELIST_TTL_MINUTES'] ?? '60');

@Injectable()
export class RelistTimeoutService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RelistTimeoutService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly dispatch: DispatchService,
    @Optional() private readonly metrics?: DispatchMetricsService,
  ) {}

  onModuleInit(): void {
    // Ships dark: don't even start the timer until AUTO_DISPATCH_ENABLED.
    // INFRA-3 — in-flight resolver: always-on so a flag flip can't strand a relisted
    // DISPATCHING booking's HELD escrow (this sweep is its ONLY refund driver).
    this.timer = setInterval(() => { void this.sweepOnce(); }, SWEEP_INTERVAL_MS);
    this.log.log(`relist-timeout sweeper started (interval=${SWEEP_INTERVAL_MS}ms, ttl=${RELIST_TTL_MINUTES}m)`);
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
  async sweepOnce(): Promise<{closed: number; skipped_lock: boolean; skipped_flag: boolean}> {
    // INFRA-3 — always-on (see onModuleInit); skipped_flag retained but never set.
    const sweepStart = Date.now();
    const token = await acquireRedisLock(this.redis.client, LOCK_KEY, LOCK_TTL_MS);
    if (token === null) {
      return {closed: 0, skipped_lock: true, skipped_flag: false};
    }
    try {
      // Why: `NOT EXISTS live OFFERED` keeps this away from a healthy mid-cascade
      // booking — those always hold a live offer or advance within seconds; an
      // offer-less DISPATCHING row older than the TTL is definitionally stalled.
      const due = await this.db.q<{id: string}>(
        `SELECT b.id
           FROM lite_bookings b
          WHERE b.dispatch_mode = 'auto'
            AND b.status = 'DISPATCHING'
            AND b.dispatch_started_at < NOW() - ($1 || ' minutes')::interval
            AND NOT EXISTS (SELECT 1 FROM dispatch_offers o
                             WHERE o.booking_id = b.id AND o.status = 'OFFERED')
          ORDER BY b.dispatch_started_at ASC
          LIMIT ${BATCH}`,
        [RELIST_TTL_MINUTES],
      );
      for (const r of due) {
        // noProvider() is itself the status-guarded conditional flip + R12 refund;
        // a single bad row must not abort the sweep.
        try {
          await this.dispatch.noProvider(r.id);
        } catch (e) {
          this.log.warn(`relist-timeout close failed for ${r.id}: ${(e as Error).message}`);
        }
      }
      const runAt = Date.now();
      await this.redis.client.set(LIVENESS_KEY, String(runAt), 'EX', 600).catch(() => undefined);
      this.metrics?.setGauge('dispatch_watchdog_last_run_ts', runAt, {sweep: 'relist'});
      this.metrics?.observe('dispatch_watchdog_sweep_duration_ms', runAt - sweepStart, {sweep: 'relist'});
      return {closed: due.length, skipped_lock: false, skipped_flag: false};
    } finally {
      await releaseRedisLock(this.redis.client, LOCK_KEY, token);
    }
  }
}
