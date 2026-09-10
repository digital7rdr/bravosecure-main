import {Injectable, Logger, Optional, type OnModuleInit, type OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {acquireRedisLock, releaseRedisLock} from '../common/redis-lock';
import {SettlementService} from '../settlement/settlement.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';

/**
 * Escrow release sweep (BUILD_RUNBOOK Step 11 §42, sweep #2) — the background timer
 * that actually pays the agency after the lead's Finish + the dispute window. It
 * finds PENDING_RELEASE holds whose dispute window has elapsed, that aren't flagged
 * for review, and have NO open dispute, and releases each via SettlementService — the
 * shared escrow-aware path: escrow -> agency provider (+ platform fee), a single agency
 * mission_payouts row, jobs_total bump, and the Ops-Room group dissolve, all in one txn
 * so a stray double-run can't double-pay (the release is gated on status='PENDING_RELEASE').
 *
 * Concurrency (LB9 + §43): a client dispute firing the same instant flips the hold
 * to DISPUTED first, so the release's WHERE status='PENDING_RELEASE' matches 0 rows
 * and no-ops — DISPUTE WINS, no payout. Multi-pod safe via the same Redis SET NX lock
 * as the Step 8 sweeps. Ships DARK on AUTO_DISPATCH_ENABLED.
 */
const SWEEP_INTERVAL_MS = 60_000;          // 1 min
const LOCK_KEY = 'lock:escrow-release';
const LOCK_TTL_MS = 55_000;                // < interval so a crashed sweeper doesn't pin the lock
const LIVENESS_KEY = 'dispatch:watchdog:release:last_run';
const BATCH = 50;

@Injectable()
export class EscrowReleaseSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(EscrowReleaseSweepService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly settlement: SettlementService,
    // LM-N4 — agency payout wake; optional so direct-constructed specs keep working.
    @Optional() private readonly bookingPush?: BookingPushBridge,
  ) {}

  onModuleInit(): void {
    // INFRA-3 — in-flight resolver: always-on so a flag flip can't strand PENDING_RELEASE
    // escrow (agencies must still get paid for completed missions). No-op with no holds.
    this.timer = setInterval(() => { void this.sweepOnce(); }, SWEEP_INTERVAL_MS);
    this.log.log(`escrow-release sweeper started (interval=${SWEEP_INTERVAL_MS}ms)`);
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
  async sweepOnce(): Promise<{released: number; skipped_lock: boolean; skipped_flag: boolean}> {
    // INFRA-3 — always-on (see onModuleInit); skipped_flag retained but never set.
    const token = await acquireRedisLock(this.redis.client, LOCK_KEY, LOCK_TTL_MS);
    if (token === null) {
      return {released: 0, skipped_lock: true, skipped_flag: false};
    }
    try {
      const due = await this.db.q<{booking_id: string}>(
        `SELECT booking_id FROM escrow_holds
          WHERE status = 'PENDING_RELEASE'
            AND release_eligible_at < NOW()
            AND NOT review_required
            AND NOT EXISTS (SELECT 1 FROM booking_disputes d
                             WHERE d.booking_id = escrow_holds.booking_id AND d.status = 'open')
          ORDER BY release_eligible_at ASC
          LIMIT ${BATCH}`,
      );
      let released = 0;
      for (const r of due) {
        try {
          const res = await this.db.withTransaction(async tx =>
            this.settlement.settleEscrowRelease(tx, r.booking_id, {kind: 'system'}),
          );
          if (res.released) {
            released++;
            // LM-N4 — the agency's primary earning event was silent: wake it with
            // the settled amount (post-commit, so the money is durably released).
            if (res.providerUserId) {
              void this.bookingPush?.payoutSettled(res.providerUserId, r.booking_id, res.toProvider)
                .catch(() => undefined);
            }
          }
        } catch (e) {
          this.log.warn(`escrow-release failed for ${r.booking_id}: ${(e as Error).message}`);
        }
      }
      await this.redis.client.set(LIVENESS_KEY, String(Date.now()), 'EX', 600).catch(() => undefined);
      return {released, skipped_lock: false, skipped_flag: false};
    } finally {
      await releaseRedisLock(this.redis.client, LOCK_KEY, token);
    }
  }
}
