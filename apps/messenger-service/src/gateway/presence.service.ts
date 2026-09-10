import {Injectable, Logger, OnModuleDestroy, OnModuleInit} from '@nestjs/common';
import {RedisService} from '../redis/redis.service';
import {UserPrivacyService} from '../users/user-privacy.service';
import {SocketHub} from './socket-hub';

/**
 * Presence states — forms a monotonically-informed UI ladder:
 *   offline — not connected anywhere
 *   online  — connected but app may be backgrounded
 *   active  — foreground + user interacting (sent via `presence` event)
 *   away    — user idle / app backgrounded (sent via `presence` event)
 *
 * `online` is derived from connect/disconnect lifecycle; `active`/`away`
 * require an explicit client signal so we don't assume activity.
 */
export type PresenceState = 'online' | 'active' | 'away' | 'offline';

export interface PresenceRecord {
  state:      PresenceState;
  lastSeenMs: number;
}

const STATE_KEY   = (userId: string): string => `presence:${userId}`;
const COUNTER_KEY = (userId: string): string => `presence:count:${userId}`;
const LIVE_KEY    = (userId: string): string => `presence:live:${userId}`;
/** 30d — so last-seen survives well past session expiry. */
const STATE_TTL_SEC = 60 * 60 * 24 * 30;
/**
 * P2-BR-10 — the device counter is now a FAST PATH only: it gives the gateway
 * immediate first-device / last-device edges. It is NOT the liveness source
 * of truth anymore (that is the lease below), because an ungraceful pod death
 * skips `onDisconnect` and leaks +1 per crash — a daily-active user whose
 * heartbeats kept refreshing this TTL was pinned `online` indefinitely and
 * `sweepStale` could never reap them. The TTL is kept only as a GC backstop.
 */
const COUNTER_TTL_SEC = 60 * 60 * 6;
/**
 * P2-BR-10 — liveness lease. Key EXISTENCE, not the counter, is what
 * `sweepStale` trusts: a pod that dies ungracefully simply stops refreshing,
 * the lease expires on its own, and the next sweep flips the user offline —
 * no disconnect handler has to run. Refreshed by client heartbeats (`touch`,
 * ~4s cadence from mobile) AND by this pod's re-assertion timer (which covers
 * clients that never send app-level pings, e.g. the ops-console). Must stay
 * comfortably above LEASE_REASSERT_MS and engine.io's dead-socket detection
 * window (~55s) so a live-but-quiet socket is never false-reaped.
 */
const LIVE_TTL_SEC = 120;
/** Lease re-assertion cadence — 4 refresh chances per lease lifetime. */
const LEASE_REASSERT_MS = 30_000;

/**
 * Presence state store + fan-out.
 *
 * State + last-seen live in Redis so every messenger-service replica
 * reads/writes the same record. Multi-device is handled via an atomic
 * counter: each connect INCRs, each disconnect DECRs; the user flips to
 * `offline` only when the last device drops. Liveness truth is the
 * short-TTL lease (`presence:live:*`) so ungraceful pod deaths self-heal
 * via expiry (P2-BR-10). Watchers receive changes via socket.io rooms
 * (`watch:<userId>`), and join/leave those rooms by emitting
 * `presence.subscribe` / `presence.unsubscribe`.
 *
 * Notifications are emitted with the `volatile` flag — a stale presence
 * frame is worse than no frame, so the server drops them if the watcher
 * socket's send buffer is backed up.
 */
@Injectable()
export class PresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PresenceService.name);
  /**
   * userId → live socket count on THIS pod. Drives the lease re-assertion
   * timer; the map (and timer) die with the pod, which is exactly what lets
   * a dead pod's leases expire instead of pinning users online (P2-BR-10).
   */
  private readonly localConnects = new Map<string, number>();
  private reassertTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly redis:   RedisService,
    private readonly hub:     SocketHub,
    private readonly privacy: UserPrivacyService,
  ) {}

  onModuleInit(): void {
    this.reassertTimer = setInterval(() => {
      void this.reassertLocalLeases().catch(err => {
        this.logger.warn(`lease re-assert failed: ${(err as Error).message}`);
      });
    }, LEASE_REASSERT_MS);
    this.reassertTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.reassertTimer) clearInterval(this.reassertTimer);
    this.reassertTimer = null;
  }

  /**
   * Refresh the liveness lease for every connection this pod owns. SET (not
   * EXPIRE) so a lease lost to a Redis restart or a stalled event loop is
   * recreated — the local map is authoritative for "a socket is genuinely
   * connected here". Covers clients with no app-level ping (ops-console),
   * whose lease would otherwise expire mid-session and get false-reaped.
   */
  async reassertLocalLeases(): Promise<void> {
    if (this.localConnects.size === 0) return;
    const pipe = this.redis.client.pipeline();
    for (const userId of this.localConnects.keys()) {
      pipe.set(LIVE_KEY(userId), '1', 'EX', LIVE_TTL_SEC);
      pipe.expire(COUNTER_KEY(userId), COUNTER_TTL_SEC);
    }
    await pipe.exec();
  }

  watchRoom(userId: string): string {
    return `watch:${userId}`;
  }

  /** Look up a single user's current record. Defaults to offline. */
  async get(userId: string): Promise<PresenceRecord> {
    const raw = await this.redis.client.get(STATE_KEY(userId));
    return parseRecord(raw);
  }

  /** Bulk lookup — used to hand a new subscriber an immediate snapshot. */
  async getMany(userIds: string[]): Promise<Record<string, PresenceRecord>> {
    if (userIds.length === 0) return {};
    const values = await this.redis.client.mget(...userIds.map(STATE_KEY));
    const out: Record<string, PresenceRecord> = {};
    for (let i = 0; i < userIds.length; i++) {
      out[userIds[i]] = parseRecord(values[i]);
    }
    return out;
  }

  /**
   * Write a new record and notify any watchers. Every call broadcasts —
   * callers dedupe if needed. We use `volatile` so a subscriber with a
   * full send buffer misses the update rather than queueing behind it.
   */
  async set(userId: string, state: PresenceState): Promise<PresenceRecord> {
    const rec: PresenceRecord = {state, lastSeenMs: Date.now()};
    await this.redis.client.set(
      STATE_KEY(userId),
      JSON.stringify(rec),
      'EX',
      STATE_TTL_SEC,
    );
    // Round 7 / presence audit fix #5 — was `.volatile.emit` (drops
    // under socket buffer pressure). Combined with the new
    // resubscribe-on-reconnect flow, a single dropped `online` frame
    // would leave the watcher pinned at `offline` until the next state
    // change. Presence frames are tiny + low-frequency; durability
    // matters more than tail latency. Use a normal emit.
    //
    // M-06 — honor the subject's "show last seen" flag: strip lastSeenMs
    // from the broadcast when users.last_seen_visible=false. The state
    // itself (online/offline) is a separate toggle and stays.
    const showLastSeen = await this.privacy.isLastSeenVisible(userId);
    this.hub.server
      ?.to(this.watchRoom(userId))
      .emit('presence', showLastSeen
        ? {userId, state: rec.state, lastSeenMs: rec.lastSeenMs}
        : {userId, state: rec.state});
    return rec;
  }

  /**
   * Register a connect. Returns true if this is the user's first active
   * device across the cluster, in which case the caller should flip the
   * state to `online`. INCR is atomic; crash-leaked increments are reset
   * here as soon as the lease has expired, and reaped by `sweepStale`
   * otherwise, so drift is bounded instead of permanent (P2-BR-10).
   */
  async onConnect(userId: string): Promise<boolean> {
    this.localConnects.set(userId, (this.localConnects.get(userId) ?? 0) + 1);
    const counterKey = COUNTER_KEY(userId);
    const liveKey    = LIVE_KEY(userId);
    // Why: a counter that outlived its lease counts sockets on a dead pod —
    // the P2-BR-10 leak. Reset it so this connect is counted from zero;
    // otherwise a daily-active user's own heartbeats keep the leaked +1
    // alive and their last graceful disconnect never flips them offline.
    if ((await this.redis.client.exists(liveKey)) === 0) {
      await this.redis.client.del(counterKey);
    }
    const count = await this.redis.client.incr(counterKey);
    await this.redis.client.expire(counterKey, COUNTER_TTL_SEC);
    await this.redis.client.set(liveKey, '1', 'EX', LIVE_TTL_SEC);
    return count === 1;
  }

  /**
   * Refresh liveness from the heartbeat ping: the lease TTL (source of truth
   * for the stale sweep) and the counter's GC-backstop TTL. EXPIRE is a no-op
   * on missing keys, so touching an offline user resurrects nothing; a lease
   * lost mid-session is recreated by `reassertLocalLeases` within 30s.
   */
  async touch(userId: string): Promise<void> {
    await this.redis.client.pipeline()
      .expire(COUNTER_KEY(userId), COUNTER_TTL_SEC)
      .expire(LIVE_KEY(userId), LIVE_TTL_SEC)
      .exec();
  }

  /**
   * Register a disconnect. Returns true if this was the user's last
   * active device (caller should flip state to `offline`). The atomic
   * DECR avoids races when the same user connects & disconnects rapidly.
   */
  async onDisconnect(userId: string): Promise<boolean> {
    const local = (this.localConnects.get(userId) ?? 0) - 1;
    if (local > 0) this.localConnects.set(userId, local);
    else this.localConnects.delete(userId);

    const key   = COUNTER_KEY(userId);
    const count = await this.redis.client.decr(key);
    if (count <= 0) {
      // DECR can legitimately go below zero if a stale counter gets
      // cleaned up under us. Reset + signal "offline" either way. The
      // lease goes too so a sweep never trusts a just-departed user.
      await this.redis.client.del(key, LIVE_KEY(userId));
      return true;
    }
    return false;
  }

  /**
   * AUDIT-2026-08-13 C-3 — is the user STILL offline after the reconnect
   * grace? A disconnect racing a same-user reconnect could DECR to zero
   * and broadcast a transient `offline` while the new socket's INCR was
   * in flight; the gateway now defers the flip and re-checks here. Both
   * keys absent/zero = genuinely gone.
   */
  async confirmOffline(userId: string): Promise<boolean> {
    const [cnt, live] = await this.redis.client.mget(COUNTER_KEY(userId), LIVE_KEY(userId));
    const n = cnt === null ? 0 : parseInt(cnt, 10);
    return (Number.isNaN(n) || n <= 0) && live === null;
  }

  /**
   * Sweep stale presence records left behind by handlers that never ran
   * (gateway crash, kill -9, abrupt network partitions). The lease TTL is
   * 120s but state TTL is 30d — without this sweep, a crashed-out user
   * would appear `online` to peers for up to 30 days. The reaper finds
   * state keys whose lease is missing and flips them to `offline`,
   * broadcasting the change to anyone in the watch room.
   *
   * Uses SCAN (never KEYS) so a million-user keyspace doesn't block the
   * Redis event loop. Skips records already at `offline`. The lease
   * `EXISTS` check is the authoritative liveness signal (P2-BR-10): the
   * lease is only ever refreshed by live pods for live sockets, so a
   * counter leaked by a crash cannot shield a dead session from reaping.
   */
  async sweepStale(opts: {batch?: number; maxScan?: number} = {}): Promise<{scanned: number; reaped: number}> {
    const batch   = opts.batch   ?? 500;
    const maxScan = opts.maxScan ?? 100_000;
    let scanned = 0;
    let reaped  = 0;
    let cursor  = '0';
    do {
      const [next, keys] = await this.redis.client.scan(
        cursor, 'MATCH', 'presence:*', 'COUNT', batch,
      );
      cursor = next;
      // Filter out counter + lease keys — same prefix, distinct namespaces.
      const stateKeys = keys.filter((k: string) =>
        !k.startsWith('presence:count:') && !k.startsWith('presence:live:'));
      if (stateKeys.length === 0) continue;
      scanned += stateKeys.length;

      const userIds = stateKeys.map((k: string) => k.slice('presence:'.length));
      const states  = await this.redis.client.mget(...stateKeys);

      // Pipeline EXISTS checks for the matching lease keys in one round-trip.
      const pipe = this.redis.client.pipeline();
      for (const uid of userIds) pipe.exists(LIVE_KEY(uid));
      const existsResults = (await pipe.exec()) ?? [];

      for (let i = 0; i < userIds.length; i++) {
        const rec = parseRecord(states[i]);
        if (rec.state === 'offline') continue;
        const [, exists] = existsResults[i] ?? [null, 0];
        if ((exists as number) > 0) continue;
        // Lease expired, but state still claims live — orphan. Any counter
        // left behind is crash drift (P2-BR-10); delete it so the next
        // connect starts counting from zero. Then flip + broadcast.
        await this.redis.client.del(COUNTER_KEY(userIds[i]));
        await this.set(userIds[i], 'offline');
        reaped++;
      }
    } while (cursor !== '0' && scanned < maxScan);
    return {scanned, reaped};
  }
}

function parseRecord(raw: string | null): PresenceRecord {
  if (!raw) return {state: 'offline', lastSeenMs: 0};
  try {
    const parsed = JSON.parse(raw) as Partial<PresenceRecord>;
    const state = parsed.state as PresenceState | undefined;
    if (!state) return {state: 'offline', lastSeenMs: 0};
    return {state, lastSeenMs: typeof parsed.lastSeenMs === 'number' ? parsed.lastSeenMs : 0};
  } catch {
    return {state: 'offline', lastSeenMs: 0};
  }
}
