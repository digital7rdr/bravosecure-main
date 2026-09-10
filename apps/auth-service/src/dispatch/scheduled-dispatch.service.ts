import {Injectable, Logger, type OnModuleInit, type OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {acquireRedisLock, releaseRedisLock} from '../common/redis-lock';
import {DispatchService} from './dispatch.service';

/**
 * Scheduled / recurring auto-dispatch (BUILD_RUNBOOK Step 24).
 *
 * Ops-gated auto dispatch: a "later" auto request now waits on the ops board
 * (PENDING_OPS) and its approval parks it OPS_APPROVED with NO publish
 * (OpsService.approveBooking) — this sweep is what dispatches it. Every interval it
 * finds OPS_APPROVED auto "later" bookings whose pickup is within the lead window and
 * flips each to DISPATCHING via DispatchService.start() — so a guard booked for 6pm
 * starts searching ~15min before. An UNAPPROVED booking is still PENDING_OPS and is
 * never selected — ops approval is the gate.
 *
 * Multi-pod safe: one pod per tick via a Redis SET NX lock (TTL < interval). Within the
 * tick, start() is itself a conditional status-guarded flip, so even without the lock
 * a booking can't be double-dispatched. Ships DARK behind AUTO_DISPATCH_ENABLED, mirroring
 * the other dispatch sweeps.
 */
const SWEEP_INTERVAL_MS = 60_000; // 1 min
const LOCK_KEY = 'lock:scheduled-dispatch';
const LOCK_TTL_MS = 55_000;       // < interval so a crashed sweeper can't pin the lock
const LEAD_WINDOW_MINUTES = Number(process.env['DISPATCH_SCHEDULED_LEAD_MINUTES'] ?? '15');
// INFRA-2 — minutes an approved 'now' booking may sit un-dispatched before this
// sweep re-drives it (the ops-approved pub/sub frame is fire-once; a lost frame
// otherwise strands it forever). Short, since 'now' means the client is waiting.
const STUCK_NOW_GRACE_MINUTES = Number(process.env['DISPATCH_STUCK_NOW_GRACE_MINUTES'] ?? '2');
const BATCH = 50;

@Injectable()
export class ScheduledDispatchService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ScheduledDispatchService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly dispatch: DispatchService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled()) {
      this.log.log('auto-dispatch off — scheduled-dispatch sweeper not started');
      return;
    }
    this.timer = setInterval(() => { void this.sweepOnce(); }, SWEEP_INTERVAL_MS);
    this.log.log(`scheduled-dispatch sweeper started (interval=${SWEEP_INTERVAL_MS}ms lead=${LEAD_WINDOW_MINUTES}min)`);
  }

  onModuleDestroy(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private enabled(): boolean {
    return this.config.get<boolean>('featureFlags.autoDispatch') ?? false;
  }

  /** Public for tests — runs one sweep iteration. */
  async sweepOnce(): Promise<{started: number; skipped_lock: boolean; skipped_flag: boolean}> {
    if (!this.enabled()) {
      return {started: 0, skipped_lock: false, skipped_flag: true};
    }
    const token = await acquireRedisLock(this.redis.client, LOCK_KEY, LOCK_TTL_MS);
    if (token === null) {
      return {started: 0, skipped_lock: true, skipped_flag: false};
    }
    try {
      const due = await this.db.q<{id: string}>(
        // OPS_APPROVED = ops-gated flow (the only steady-state source). DRAFT is kept as a
        // safe union for in-flight rows created by the pre-gate flow (request-time used to
        // leave "later" bookings DRAFT) — drop it once those rows have drained. PENDING_OPS
        // is deliberately absent: an unapproved booking must never auto-dispatch.
        `SELECT id FROM lite_bookings
          WHERE dispatch_mode = 'auto' AND booking_mode = 'later'
            AND status IN ('OPS_APPROVED', 'DRAFT') AND dispatch_started_at IS NULL
            AND pickup_time <= NOW() + ($1 || ' minutes')::interval
          ORDER BY pickup_time ASC
          LIMIT ${BATCH}`,
        [LEAD_WINDOW_MINUTES],
      );
      // INFRA-2 — recover 'now' bookings whose ops-approved pub/sub frame was lost:
      // approved (OPS_APPROVED), never started (dispatch_started_at IS NULL), and
      // sitting past the grace window. start() is the same idempotent conditional
      // flip, so a booking already picked up by the live pub/sub path is a no-op here.
      const stuckNow = await this.db.q<{id: string}>(
        `SELECT id FROM lite_bookings
          WHERE dispatch_mode = 'auto' AND booking_mode = 'now'
            AND status = 'OPS_APPROVED' AND dispatch_started_at IS NULL
            AND updated_at < NOW() - ($1 || ' minutes')::interval
          ORDER BY updated_at ASC
          LIMIT ${BATCH}`,
        [STUCK_NOW_GRACE_MINUTES],
      );
      const ids = new Set<string>();
      for (const r of due) ids.add(r.id);
      for (const r of stuckNow) ids.add(r.id);
      let started = 0;
      for (const id of ids) {
        // start() is a conditional DRAFT→DISPATCHING flip + offer cascade; a single bad
        // row (e.g. raced into a manual start) must not abort the sweep.
        try {
          await this.dispatch.start(id);
          started++;
        } catch (e) {
          this.log.warn(`scheduled-dispatch start failed for ${id}: ${(e as Error).message}`);
        }
      }
      if (started > 0) this.log.log(`scheduled-dispatch started ${started} due booking(s) (incl. ${stuckNow.length} recovered 'now')`);
      return {started, skipped_lock: false, skipped_flag: false};
    } finally {
      await releaseRedisLock(this.redis.client, LOCK_KEY, token);
    }
  }
}
