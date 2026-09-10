import {Injectable, Logger, Optional, type OnModuleInit, type OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {acquireRedisLock, releaseRedisLock} from '../common/redis-lock';
import {SentryService} from '../observability/sentry.service';
import {DispatchMetricsService} from '../observability/dispatch-metrics.service';

/**
 * Dispatch SLO evaluator (BUILD_RUNBOOK Step 26). Since no human watches auto-dispatch
 * 24/7, this Redis-locked sweep is the only eye on it: every interval it checks the
 * conditions a person can't, and pages via Sentry (NOT the opaque push channel) with NO
 * PII. Ships DARK behind AUTO_DISPATCH_ENABLED. Multi-pod-safe (SET NX lock).
 *
 * Conditions: stuck DISPATCHING (a booking searching too long with no live offer); a dead
 * watchdog (offer-expiry liveness key stale); a region with live demand but ZERO on-duty
 * agencies; and a fresh run of charge failures (delta on the metric counter).
 */
const SWEEP_INTERVAL_MS = 60_000;
const LOCK_KEY = 'lock:dispatch-slo';
const LOCK_TTL_MS = 55_000;
const STUCK_DISPATCHING_MIN = 3;          // DISPATCHING this long with no live offer = stuck
const WATCHDOG_STALE_MS = 60_000;         // offer sweep ~8s; 60s = clearly dead
const WATCHDOG_LIVENESS_KEY = 'dispatch:watchdog:offer:last_run';
// INFRA-5 — the money-moving sweeps (60s cadence) whose liveness keys nothing reads today.
// A dead one strands refunds/payouts while /ready stays green, so page from HERE (Sentry),
// NOT /ready (coupling /ready to a sweep is the INFRA-14 self-amplifying-outage trap).
const MONEY_SWEEPS = ['crew', 'arrival', 'relist', 'release'] as const;
const MONEY_SWEEP_STALE_MS = 180_000;     // 3 missed 60s runs

@Injectable()
export class DispatchSloService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DispatchSloService.name);
  private timer: NodeJS.Timeout | null = null;
  private lastChargeFailures = 0;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    @Optional() private readonly sentry?: SentryService,
    @Optional() private readonly metrics?: DispatchMetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled()) {
      this.log.log('auto-dispatch off — SLO evaluator not started');
      return;
    }
    this.timer = setInterval(() => { void this.sweepOnce(); }, SWEEP_INTERVAL_MS);
    this.log.log(`dispatch SLO evaluator started (interval=${SWEEP_INTERVAL_MS}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private enabled(): boolean {
    return this.config.get<boolean>('featureFlags.autoDispatch') ?? false;
  }

  private fire(slo: string, count: number): void {
    // Sentry only (PagerDuty downstream). NEVER the opaque push channel; NEVER PII.
    this.log.warn(`SLO breach: ${slo} (n=${count})`);
    this.sentry?.captureException(new Error(`slo:${slo}`), {tags: {kind: 'dispatch_slo', slo}, extra: {count}});
  }

  /** Public for tests — runs one evaluation. Returns the breaches it fired. */
  async sweepOnce(nowMs: number = Date.now()): Promise<{breaches: string[]; skipped_lock: boolean; skipped_flag: boolean}> {
    if (!this.enabled()) {
      return {breaches: [], skipped_lock: false, skipped_flag: true};
    }
    const token = await acquireRedisLock(this.redis.client, LOCK_KEY, LOCK_TTL_MS);
    if (token === null) {
      return {breaches: [], skipped_lock: true, skipped_flag: false};
    }
    const breaches: string[] = [];
    try {
      // 1 — stuck DISPATCHING (searching too long with no live offer).
      try {
        const stuck = await this.db.qOne<{n: string}>(
          `SELECT count(*)::text AS n FROM lite_bookings b
            WHERE b.status = 'DISPATCHING'
              AND b.dispatch_started_at < NOW() - ($1 || ' minutes')::interval
              AND NOT EXISTS (SELECT 1 FROM dispatch_offers o
                               WHERE o.booking_id = b.id AND o.status = 'OFFERED')`,
          [STUCK_DISPATCHING_MIN],
        );
        const n = Number(stuck?.n ?? 0);
        if (n > 0) { breaches.push('stuck_dispatching'); this.fire('stuck_dispatching', n); }
      } catch (e) { this.log.warn(`stuck check failed: ${(e as Error).message}`); }

      // 2 — dead watchdog (offer-expiry liveness stale).
      try {
        const raw = await this.redis.client.get(WATCHDOG_LIVENESS_KEY);
        const last = raw ? Number(raw) : NaN;
        if (!Number.isFinite(last) || nowMs - last > WATCHDOG_STALE_MS) {
          breaches.push('watchdog_dead'); this.fire('watchdog_dead', 1);
        }
      } catch (e) { this.log.warn(`watchdog check failed: ${(e as Error).message}`); }

      // 3 — a region with live demand but ZERO on-duty agencies.
      try {
        const dead = await this.db.q<{region_code: string}>(
          `SELECT DISTINCT b.region_code FROM lite_bookings b
            WHERE b.status = 'DISPATCHING'
              AND NOT EXISTS (SELECT 1 FROM agents a
                               WHERE a.type = 'company' AND a.status = 'ACTIVE'
                                 AND a.on_duty = TRUE AND a.region_code = b.region_code)`,
        );
        if (dead.length > 0) { breaches.push('region_zero_agencies'); this.fire('region_zero_agencies', dead.length); }
      } catch (e) { this.log.warn(`region check failed: ${(e as Error).message}`); }

      // 4 — fresh charge failures since the last evaluation (metric delta).
      const cf = this.metrics?.snapshot().counters['dispatch_charge_failure_total'] ?? 0;
      if (cf > this.lastChargeFailures) {
        const delta = cf - this.lastChargeFailures;
        breaches.push('charge_failures'); this.fire('charge_failures', delta);
      }
      this.lastChargeFailures = cf;

      // 5 — INFRA-5: money-moving sweeps alive. Each writes its liveness key every run;
      //     a stale one means refunds/payouts have silently stopped (green /ready).
      try {
        for (const sweep of MONEY_SWEEPS) {
          const raw = await this.redis.client.get(`dispatch:watchdog:${sweep}:last_run`);
          const last = raw ? Number(raw) : NaN;
          if (!Number.isFinite(last) || nowMs - last > MONEY_SWEEP_STALE_MS) {
            breaches.push(`money_sweep_dead:${sweep}`); this.fire(`money_sweep_dead:${sweep}`, 1);
          }
        }
      } catch (e) { this.log.warn(`money-sweep liveness check failed: ${(e as Error).message}`); }

      // 6 — INFRA-5: rows DUE but OVERDUE. Catches a sweep whose liveness is fresh but
      //     whose per-row work is failing (the "alive but not working" mode): escrow past
      //     its release window still unreleased, or a CONFIRMED auto booking past its crew
      //     deadline with no mission (crew-SLA should have flagged/refunded it).
      try {
        const overdue = await this.db.qOne<{release: string; crew: string}>(
          `SELECT
             (SELECT count(*) FROM escrow_holds
               WHERE status = 'PENDING_RELEASE'
                 AND release_eligible_at < NOW() - INTERVAL '15 minutes')::text AS release,
             (SELECT count(*) FROM lite_bookings b
               WHERE b.status = 'CONFIRMED' AND b.dispatch_mode = 'auto'
                 AND b.crew_deadline_at < NOW() - INTERVAL '5 minutes'
                 AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.booking_id = b.id AND m.status <> 'ABORTED'))::text AS crew`,
        );
        const rel = Number(overdue?.release ?? 0);
        const crew = Number(overdue?.crew ?? 0);
        if (rel > 0) { breaches.push('escrow_release_overdue'); this.fire('escrow_release_overdue', rel); }
        if (crew > 0) { breaches.push('crew_sla_overdue'); this.fire('crew_sla_overdue', crew); }
      } catch (e) { this.log.warn(`overdue-money check failed: ${(e as Error).message}`); }

      // Liveness for this sweep (so /metrics shows the SLO loop is alive).
      this.metrics?.setGauge('dispatch_watchdog_last_run_ts', nowMs, {sweep: 'slo'});
      return {breaches, skipped_lock: false, skipped_flag: false};
    } finally {
      await releaseRedisLock(this.redis.client, LOCK_KEY, token);
    }
  }
}
