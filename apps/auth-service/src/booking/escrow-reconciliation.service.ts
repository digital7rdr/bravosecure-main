import {Injectable, Logger, Optional, type OnModuleInit, type OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {acquireRedisLock, releaseRedisLock} from '../common/redis-lock';
import {SentryService} from '../observability/sentry.service';
import {DispatchMetricsService} from '../observability/dispatch-metrics.service';

/**
 * Escrow reconciliation sweep (BUILD_RUNBOOK Step 11 §42 sweep #3 / §43) — a daily,
 * READ-ONLY audit that asserts the money invariant and alerts on drift. It mutates
 * nothing; it surfaces ledgers that violate conservation so an operator can investigate.
 *
 * Three checks:
 *  1. Terminal-split conservation — a RELEASED/REFUNDED/PARTIAL hold must satisfy
 *     gross == to_provider + to_client + platform_fee.
 *  2. Escrow-account drain — once terminal, the escrow account's net for the booking
 *     must be 0 (the hold credit and the release/refund debits cancel). A non-zero net
 *     means money is stranded in (or leaked from) escrow.
 *  3. No premature payout — a non-terminal hold (HELD/PENDING_RELEASE/DISPUTED) must NOT
 *     have an agency payout row yet (money released before the window/dispute).
 *
 * Multi-pod safe via the same Redis SET NX lock as the other sweeps; ships DARK on
 * AUTO_DISPATCH_ENABLED.
 */
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000; // daily
const LOCK_KEY = 'lock:escrow-recon';
const LOCK_TTL_MS = 5 * 60_000;             // 5 min — generous for a read-only batch
const LIVENESS_KEY = 'dispatch:watchdog:recon:last_run';
const BATCH = 200;

@Injectable()
export class EscrowReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(EscrowReconciliationService.name);
  private timer: NodeJS.Timeout | null = null;
  private eagerTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    // Step 28 — both @Global; optional so existing unit specs (which construct the service
    // directly with 3 args) keep working. Drift → metric + Sentry page (NEVER the push channel).
    @Optional() private readonly metrics?: DispatchMetricsService,
    @Optional() private readonly sentry?: SentryService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled()) {
      this.log.log('auto-dispatch off — escrow reconciliation sweeper not started');
      return;
    }
    this.timer = setInterval(() => { void this.sweepOnce(); }, SWEEP_INTERVAL_MS);
    // INFRA-6 — a bare 24h setInterval never fires if the pod restarts more
    // often than daily (near-daily deploys reset the clock forever), so the
    // only money-conservation audit effectively never ran. Kick an eager pass
    // ~30s after boot, gated on the liveness marker so a restart storm doesn't
    // re-run it: it executes only if no run landed in the last 20h. The
    // sweepOnce Redis lock still serialises across pods.
    this.eagerTimer = setTimeout(() => { void this.maybeEagerSweep(); }, 30_000);
    this.log.log(`escrow reconciliation sweeper started (interval=${SWEEP_INTERVAL_MS}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.eagerTimer) {
      clearTimeout(this.eagerTimer);
      this.eagerTimer = null;
    }
  }

  /** INFRA-6 — run one pass at boot unless the liveness marker shows a recent run. */
  private async maybeEagerSweep(): Promise<void> {
    try {
      if (!this.enabled()) return;
      const last = await this.redis.client.get(LIVENESS_KEY);
      const lastMs = last ? Number(last) : 0;
      if (Number.isFinite(lastMs) && lastMs > 0 && Date.now() - lastMs < 20 * 60 * 60_000) {
        return; // a reconciliation ran within the last 20h — skip the eager pass
      }
      await this.sweepOnce();
    } catch (e) {
      this.log.warn(`eager reconciliation pass skipped: ${String(e)}`);
    }
  }

  private enabled(): boolean {
    return this.config.get<boolean>('featureFlags.autoDispatch') ?? false;
  }

  /** Public for tests — runs one reconciliation pass. Returns the drift counts (0 = clean). */
  async sweepOnce(): Promise<{drift: number; skipped_lock: boolean; skipped_flag: boolean}> {
    if (!this.enabled()) {
      return {drift: 0, skipped_lock: false, skipped_flag: true};
    }
    const token = await acquireRedisLock(this.redis.client, LOCK_KEY, LOCK_TTL_MS);
    if (token === null) {
      return {drift: 0, skipped_lock: true, skipped_flag: false};
    }
    try {
      const escrowId = this.config.get<string>('platformAccounts.escrowId');

      // 1) Terminal-split conservation.
      const splitDrift = await this.db.q<{booking_id: string; gross_credits: number}>(
        `SELECT booking_id, gross_credits FROM escrow_holds
          WHERE status IN ('RELEASED', 'REFUNDED', 'PARTIAL')
            AND gross_credits <> COALESCE(to_provider_credits, 0)
                               + COALESCE(to_client_credits, 0)
                               + COALESCE(platform_fee_credits, 0)
          LIMIT ${BATCH}`,
      );
      // 2) Escrow-account drain for terminal holds.
      const drainDrift = escrowId
        ? await this.db.q<{booking_id: string; escrow_net: number}>(
            `SELECT eh.booking_id, COALESCE(SUM(wt.amount_credits), 0)::int AS escrow_net
               FROM escrow_holds eh
               LEFT JOIN wallet_transactions wt
                 ON wt.booking_id = eh.booking_id AND wt.user_id = $1
              WHERE eh.status IN ('RELEASED', 'REFUNDED', 'PARTIAL')
              GROUP BY eh.booking_id
             HAVING COALESCE(SUM(wt.amount_credits), 0) <> 0
              LIMIT ${BATCH}`,
            [escrowId],
          )
        : [];
      // 3) No premature payout on a non-terminal hold.
      const earlyPayout = await this.db.q<{booking_id: string}>(
        `SELECT eh.booking_id FROM escrow_holds eh
          WHERE eh.status IN ('HELD', 'PENDING_RELEASE', 'DISPUTED')
            AND eh.provider_user_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM wallet_transactions wt
                         WHERE wt.booking_id = eh.booking_id
                           AND wt.user_id = eh.provider_user_id
                           AND wt.type = 'payout')
          LIMIT ${BATCH}`,
      );

      // 4) MON-3 — the platform escrow + fee accounts must never hold a NEGATIVE balance.
      //    A clawback the agency couldn't cover fronts the shortfall from the fee account
      //    (drives it negative) with no automated recovery, so surface it here for a human.
      const feeId = this.config.get<string>('platformAccounts.platformFeeId');
      const negAccounts = escrowId && feeId
        ? await this.db.q<{user_id: string; bravo_credits: string}>(
            `SELECT user_id, bravo_credits::text FROM wallet_balances
              WHERE user_id IN ($1, $2) AND bravo_credits < 0`,
            [escrowId, feeId],
          )
        : [];

      const drift = splitDrift.length + drainDrift.length + earlyPayout.length + negAccounts.length;
      if (drift > 0) {
        for (const r of splitDrift) this.log.error(`escrow recon: split drift booking=${r.booking_id} gross=${r.gross_credits}`);
        for (const r of drainDrift) this.log.error(`escrow recon: escrow not drained booking=${r.booking_id} net=${r.escrow_net}`);
        for (const r of earlyPayout) this.log.error(`escrow recon: premature payout on non-terminal hold booking=${r.booking_id}`);
        for (const r of negAccounts) this.log.error(`escrow recon: NEGATIVE platform account ${r.user_id} balance=${r.bravo_credits} (uncovered clawback)`);
        this.log.error(`escrow reconciliation FOUND ${drift} drift row(s) — investigate`);
        // Step 28 — count the drift + page a human via Sentry (read-only sweep: it ALERTS,
        // it never auto-moves money; an admin resolves via the §41 dispute/resolve path).
        // Counts only in the Sentry payload — NO PII (no booking ids / coords / names).
        this.metrics?.inc('dispatch_money_drift_total', undefined, drift);
        this.sentry?.captureException(new Error('money_drift'), {
          tags: {kind: 'dispatch_money_drift'},
          extra: {drift, split: splitDrift.length, drain: drainDrift.length, early: earlyPayout.length, neg: negAccounts.length},
        });
      } else {
        this.log.log('escrow reconciliation clean');
      }
      const runAt = Date.now();
      await this.redis.client.set(LIVENESS_KEY, String(runAt), 'EX', 2 * 24 * 3600).catch(() => undefined);
      // Sweep liveness on /metrics (the Redis key above is the cross-pod source for /ready).
      this.metrics?.setGauge('dispatch_watchdog_last_run_ts', runAt, {sweep: 'reconciliation'});
      return {drift, skipped_lock: false, skipped_flag: false};
    } finally {
      await releaseRedisLock(this.redis.client, LOCK_KEY, token);
    }
  }
}
