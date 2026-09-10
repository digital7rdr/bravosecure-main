import {Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {RedisService} from '../redis/redis.service';

/**
 * Runtime auto-dispatch kill switch (BUILD_RUNBOOK Step 26 / LB21).
 *
 * The env flag `featureFlags.autoDispatch` (AUTO_DISPATCH_ENABLED) is the boot-time
 * dark-launch gate. This adds a RUNTIME override stored in Redis (`dispatch:enabled`)
 * so an ADMIN can bleed auto-dispatch OFF mid-traffic — falling back to the legacy admin
 * flow — without a redeploy, and turn it back on.
 *
 * Semantics (fail-safe): the switch can only turn auto-dispatch OFF, never force it ON
 * beyond the env gate. effective = envFlag AND (redis !== 'false'). So:
 *   - env OFF (dark)        → always OFF (the runtime key is irrelevant).
 *   - env ON, redis absent  → ON (env governs).
 *   - env ON, redis 'false' → OFF (runtime kill).
 *   - Redis error           → last cached value, else env (never crash the request path).
 * Flipping OFF only stops NEW auto-offers; in-flight escrow holds + the sweeps are
 * untouched (they finish in-flight jobs).
 */
const REDIS_KEY = 'dispatch:enabled';
// Short cache: the request path is low-volume (one read per booking), so a tight window
// gives fast fleet convergence after an ADMIN flip while still sparing Redis per-request.
const CACHE_TTL_MS = 2_000;

@Injectable()
export class DispatchKillswitchService {
  private readonly log = new Logger(DispatchKillswitchService.name);
  private cache: {value: boolean; at: number} | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  private envEnabled(): boolean {
    return this.config.get<boolean>('featureFlags.autoDispatch') ?? false;
  }

  /** The effective runtime state used by the request/offer path. */
  async isAutoDispatchEnabled(nowMs: number = Date.now()): Promise<boolean> {
    if (!this.envEnabled()) {return false;} // dark launch — env gate dominates, skip Redis
    if (this.cache && nowMs - this.cache.at < CACHE_TTL_MS) {return this.cache.value;}
    try {
      const v = await this.redis.client.get(REDIS_KEY);
      const enabled = v !== 'false'; // absent/'true' → on; only an explicit 'false' kills it
      // Cache the RAW value (this branch only runs when env is ON, so raw === effective).
      this.cache = {value: enabled, at: nowMs};
      return enabled;
    } catch (e) {
      this.log.warn(`killswitch read failed, falling back: ${(e as Error).message}`);
      return this.cache?.value ?? this.envEnabled();
    }
  }

  /** ADMIN flip. Persists the runtime override (no TTL) + refreshes the local cache. Fails
   *  LOUD if Redis can't be written — the controller surfaces it so an admin never sees a
   *  "flip succeeded" that didn't persist (and the stale cache is left untouched). */
  async setEnabled(enabled: boolean, nowMs: number = Date.now()): Promise<void> {
    try {
      await this.redis.client.set(REDIS_KEY, enabled ? 'true' : 'false');
    } catch (e) {
      this.log.error(`killswitch flip failed to persist: ${(e as Error).message}`);
      throw e; // do NOT update the cache; the caller reports the failure
    }
    // Cache the RAW value to match isAutoDispatchEnabled's cache (consistent semantics).
    this.cache = {value: enabled, at: nowMs};
  }

  /** Current raw runtime value for the monitor (does not fold in the env gate). */
  async currentRuntimeValue(): Promise<'true' | 'false' | 'unset'> {
    try {
      const v = await this.redis.client.get(REDIS_KEY);
      return v === 'true' || v === 'false' ? v : 'unset';
    } catch {
      return 'unset';
    }
  }
}
