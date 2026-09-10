import {Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {createClient, SupabaseClient} from '@supabase/supabase-js';

/**
 * M-06 / M-07 — read-side view of the privacy flags that live in the
 * shared Postgres (written by auth-service):
 *
 *   users.last_seen_visible                  — "show last seen" toggle
 *   blocked_users(blocker_user_id,
 *                 blocked_user_id)           — directed block edges
 *
 * The gateway consults these on the presence / typing / read-receipt
 * paths, which are high-frequency — so every lookup is cache-first
 * (60s TTL) with single-flight per key: at most one DB round-trip per
 * key per TTL, and concurrent frames share the in-flight promise
 * instead of stampeding Supabase.
 *
 * Degrades exactly like BackupService: when SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY are unset (or a query fails) the checks
 * fail OPEN — lastSeenVisible=true, not-blocked — so a config gap
 * never takes presence or receipts down.
 */

/** 60s — bounds staleness of a flag flip against hot-path DB load. */
const CACHE_TTL_MS = 60_000;
/** Hard bound on cache entries; pruned (then cleared) when exceeded. */
const CACHE_MAX_ENTRIES = 10_000;
/**
 * userIds are UUIDs. Anything outside this charset cannot match a row,
 * and rejecting it up front keeps client-supplied ids out of the
 * PostgREST `.or()` filter string (comma/paren injection).
 */
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;

interface CacheEntry {
  value:     boolean;
  expiresAt: number;
}

@Injectable()
export class UserPrivacyService {
  private readonly log = new Logger('UserPrivacyService');
  private client: SupabaseClient | null = null;
  private readonly cache    = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<boolean>>();
  private degradeLogged = false;

  constructor(config: ConfigService) {
    const cfg = config.get<{supabaseUrl?: string; supabaseServiceRoleKey?: string}>('backup');
    if (!cfg?.supabaseUrl || !cfg?.supabaseServiceRoleKey) {
      // Why: mirror BackupService — a missing key must not break the WS
      // gateway; privacy checks fail open until the env is configured.
      this.log.warn(
        'privacy.disabled — SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing. ' +
        'last-seen visibility + block checks fail open until both are set.',
      );
      return;
    }
    this.client = createClient(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, {
      auth: {persistSession: false, autoRefreshToken: false},
    });
    this.log.log(`privacy.init-ok host=${new URL(cfg.supabaseUrl).host}`);
  }

  /** True unless the user explicitly set users.last_seen_visible=false. */
  async isLastSeenVisible(userId: string): Promise<boolean> {
    if (!this.client || !SAFE_ID.test(userId)) return true;
    return this.cached(`ls:${userId}`, () => this.fetchLastSeenVisible(userId));
  }

  /** True when a block edge exists in EITHER direction between a and b. */
  async isBlockedEither(a: string, b: string): Promise<boolean> {
    if (!this.client || !SAFE_ID.test(a) || !SAFE_ID.test(b)) return false;
    // Why: order-insensitive pair key — (a,b) and (b,a) share one entry.
    const [x, y] = a < b ? [a, b] : [b, a];
    return this.cached(`bl:${x}:${y}`, () => this.fetchBlockedEither(x, y));
  }

  /**
   * B-597 — the last verdict this process has seen for the pair, EVEN IF
   * EXPIRED (`undefined` = never seen / privacy disabled). Used only by the
   * call lanes' deadline-bounded gate so a slow lookup falls back to the stale
   * verdict instead of failing open for a pair that has ever been checked.
   * Never a substitute for `isBlockedEither` on a normal path.
   */
  peekBlockedEither(a: string, b: string): boolean | undefined {
    if (!this.client || !SAFE_ID.test(a) || !SAFE_ID.test(b)) return undefined;
    const [x, y] = a < b ? [a, b] : [b, a];
    return this.cache.get(`bl:${x}:${y}`)?.value;
  }

  private cached(key: string, fetch: () => Promise<boolean>): Promise<boolean> {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.value);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = fetch()
      .then(value => {
        this.remember(key, value);
        return value;
      })
      .finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, p);
    return p;
  }

  private remember(key: string, value: boolean): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const now = Date.now();
      for (const [k, v] of this.cache) {
        if (v.expiresAt <= now) this.cache.delete(k);
      }
      if (this.cache.size >= CACHE_MAX_ENTRIES) this.cache.clear();
    }
    this.cache.set(key, {value, expiresAt: Date.now() + CACHE_TTL_MS});
  }

  private async fetchLastSeenVisible(userId: string): Promise<boolean> {
    try {
      const res = await this.client!
        .from('users')
        .select('last_seen_visible')
        .eq('id', userId)
        .maybeSingle();
      if (res.error) {
        this.degrade(res.error.message);
        return true;
      }
      // Missing row / null column → default visible (matches auth-service).
      return (res.data as {last_seen_visible?: boolean | null} | null)?.last_seen_visible !== false;
    } catch (e) {
      this.degrade((e as Error).message);
      return true;
    }
  }

  private async fetchBlockedEither(a: string, b: string): Promise<boolean> {
    try {
      const res = await this.client!
        .from('blocked_users')
        .select('blocker_user_id')
        .or(`and(blocker_user_id.eq.${a},blocked_user_id.eq.${b}),and(blocker_user_id.eq.${b},blocked_user_id.eq.${a})`)
        .limit(1);
      if (res.error) {
        this.degrade(res.error.message);
        return false;
      }
      return Array.isArray(res.data) && res.data.length > 0;
    } catch (e) {
      this.degrade((e as Error).message);
      return false;
    }
  }

  private degrade(msg: string): void {
    // Why: log once — this sits on the typing/presence hot path and a DB
    // outage would otherwise emit one warning per frame.
    if (this.degradeLogged) return;
    this.degradeLogged = true;
    this.log.warn(`privacy.degraded — lookup failed (${msg}); failing open until next success.`);
  }
}
