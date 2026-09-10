import {Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import type Redis from 'ioredis';
import {RedisService} from '../redis/redis.service';
import {OPS_APPROVED_DISPATCH_CHANNEL} from '../ops/ops.service';
import {DispatchService} from './dispatch.service';

/**
 * Ops-gated auto dispatch — the DispatchModule end of the approve → start handoff.
 *
 * OpsService.approveBooking publishes `{bookingId}` on `dispatch:ops-approved` when an
 * AUTO 'now' booking is approved (a 'later' booking waits for the scheduled cron). This
 * subscriber consumes the frame and runs DispatchService.start(), flipping the booking
 * OPS_APPROVED → DISPATCHING and offering the nearest eligible agency. Redis pub/sub is
 * the seam because DispatchModule imports OpsModule, so OpsService can never inject
 * DispatchService directly (module cycle).
 *
 * Multi-pod safe: pub/sub delivers the frame to EVERY pod, so a per-booking Redis SET NX
 * lock (mirrors mission-drift-janitor) elects exactly one starter. Backstop: start()'s
 * status-guarded conditional UPDATE (0 rows ⇒ booking_state_changed_concurrently), so
 * even a failed-open lock can never double-dispatch. Ships DARK behind
 * AUTO_DISPATCH_ENABLED, mirroring the other dispatch sweeps.
 */
const LOCK_PREFIX = 'lock:ops-approved-dispatch:';
// Long enough to cover a slow start() (ranking + offer insert); a booking is only ever
// approved once, so the lock never needs to be re-acquirable quickly.
const LOCK_TTL_MS = 30_000;

@Injectable()
export class OpsApprovedDispatchService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(OpsApprovedDispatchService.name);
  private sub: Redis | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly dispatch: DispatchService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled()) {
      this.log.log('auto-dispatch off — ops-approved subscriber not started');
      return;
    }
    // Why: onApplicationBootstrap, NOT onModuleInit — RedisService.client is assigned in
    // its own onModuleInit and Nest doesn't order sibling inits, so an onModuleInit here
    // races `.duplicate()` against an undefined client (same fix as messenger-service's
    // push:events subscriber).
    this.bootstrapSubscriber().catch(e => {
      this.log.error(`ops-approved subscriber init failed: ${(e as Error).message}`);
    });
  }

  onModuleDestroy(): void {
    void this.sub?.quit().catch(() => undefined);
    this.sub = null;
  }

  private enabled(): boolean {
    return this.config.get<boolean>('featureFlags.autoDispatch') ?? false;
  }

  private async bootstrapSubscriber(): Promise<void> {
    // Dedicated duplicated connection — once a connection subscribes it can't run
    // regular commands (the lock SET below uses the main client).
    const sub = this.redis.client.duplicate();
    this.sub = sub;
    sub.on('error', err => this.log.warn(`ops-approved subscriber error: ${err.message}`));
    sub.on('message', (channel: string, raw: string) => {
      if (channel !== OPS_APPROVED_DISPATCH_CHANNEL) return;
      void this.handleMessage(raw);
    });
    await sub.subscribe(OPS_APPROVED_DISPATCH_CHANNEL);
    this.log.log(`subscribed to ${OPS_APPROVED_DISPATCH_CHANNEL}`);
  }

  /** Public for tests — consumes one `{bookingId}` frame. Never throws: a bad frame or a
   *  failed start() is logged and dropped; the booking stays OPS_APPROVED for ops to
   *  retry, and the scheduled cron / ops board remain the recovery surfaces. */
  async handleMessage(raw: string): Promise<void> {
    let bookingId: string | undefined;
    try {
      bookingId = (JSON.parse(raw) as {bookingId?: string}).bookingId;
    } catch {
      this.log.warn('ops-approved frame parse failed');
      return;
    }
    if (!bookingId) return;
    // One starter across pods; `.catch(() => null)` fails CLOSED here (skip), because
    // start()'s conditional flip makes a skipped duplicate harmless while a double-run
    // would burn an extra ranking pass on every approve.
    const got = await this.redis.client
      .set(`${LOCK_PREFIX}${bookingId}`, String(Date.now()), 'PX', LOCK_TTL_MS, 'NX')
      .catch(() => null);
    if (got !== 'OK') return;
    try {
      await this.dispatch.start(bookingId);
    } catch (e) {
      this.log.warn(`ops-approved dispatch start failed for ${bookingId}: ${(e as Error).message}`);
    }
  }
}
