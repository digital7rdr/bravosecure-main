/**
 * Cross-node fanout (RedisAdapter) + connectionStateRecovery (in-process
 * SessionAware semantics) in one adapter.
 *
 * Why this exists:
 *   socket.io 4.x ships two adapters separately:
 *     - `RedisAdapter` (from @socket.io/redis-adapter) — fans out
 *       broadcasts across replicas via Redis pub/sub, extends the
 *       base `Adapter` class.
 *     - `SessionAwareAdapter` (built into socket.io-adapter) — stores
 *       disconnected sessions in an in-memory `Map` and appends a
 *       packet-offset string to every broadcast so a reconnecting
 *       client can resume from the right point.
 *   The two are incompatible by default: when you wire RedisAdapter via
 *   `server.adapter(createAdapter(pub, sub))`, the base Adapter's no-op
 *   `restoreSession` is in effect — every reconnect logs `recovered=no`,
 *   the client's `auth.pid` + `auth.offset` are ignored, and the user
 *   loses typing/presence frames on every blip. This is why the original
 *   wiring (Round 2) had the connectionStateRecovery config "enabled"
 *   but it never actually fired.
 *
 * What this adapter does:
 *   - On disconnect, persists the socket session (pid, rooms, data) in
 *     an in-process Map keyed by pid. TTL = maxDisconnectionDuration
 *     from the namespace config.
 *   - On reconnect with matching pid + offset, returns the session +
 *     replays packets buffered since that offset.
 *   - On broadcast, appends an offset string to the packet data and
 *     buffers the packet in-process so a future restore can find it.
 *   - Still delegates cross-node fanout to RedisAdapter — broadcasts
 *     reach every replica via Redis pub/sub exactly as before.
 *
 * Single-host limitation (acceptable for staging, plan for prod):
 *   Session state lives in THIS node's memory. If a reconnect lands
 *   on a different replica (no sticky sessions), recovery can't find
 *   the pid and falls back to a fresh session — same behaviour as
 *   pre-fix, just slower because we now waste a Map lookup first.
 *   For multi-pod prod you need either:
 *     - sticky sessions on the load balancer (recommended), or
 *     - Redis-backed session storage (custom — out of scope here).
 *   Single-host staging (1 replica) gets the full benefit immediately.
 */

import {RedisAdapter, type RedisAdapterOptions} from '@socket.io/redis-adapter';
import type Redis from 'ioredis';
// `socket.io-adapter` exports BroadcastOptions + Session types we need to
// match the SessionAwareAdapter contract. The actual class isn't imported
// because we can't multi-inherit; we copy its small in-memory logic.
import type {
  BroadcastOptions,
  Session,
  Room,
} from 'socket.io-adapter';
import type {Namespace} from 'socket.io';

interface PersistedPacket {
  id:        string;
  opts:      BroadcastOptions;
  data:      unknown[];
  emittedAt: number;
}

interface PersistedSession extends Omit<Session, 'missedPackets'> {
  pid:            string;
  rooms:          Room[];
  data:           unknown;
  disconnectedAt: number;
}

/**
 * Yeast-style id generator. Mirrors the one used by socket.io's stock
 * SessionAwareAdapter — copying the format keeps client-side offset
 * comparison logic (string equality) drop-in compatible.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
let yeastSeed = 0;
let yeastPrev: string | undefined;
function yeast(): string {
  let encoded = '';
  let n       = Date.now();
  do {
    encoded = ALPHABET[n % 64] + encoded;
    n = Math.floor(n / 64);
  } while (n > 0);
  if (encoded === yeastPrev) {
    return encoded + '.' + ALPHABET[yeastSeed++ % 64];
  }
  yeastSeed = 0;
  yeastPrev = encoded;
  return encoded;
}

function shouldIncludePacket(sessionRooms: Room[], opts: BroadcastOptions): boolean {
  const except      = opts.except ?? new Set<Room>();
  const included    = opts.rooms.size === 0 || sessionRooms.some(r => opts.rooms.has(r));
  const notExcluded = sessionRooms.every(r => !except.has(r));
  return included && notExcluded;
}

export class SessionAwareRedisAdapter extends RedisAdapter {
  private readonly sessions = new Map<string, PersistedSession>();
  private readonly packets: PersistedPacket[] = [];
  private readonly maxDisconnectionDuration: number;
  private readonly gcTimer: ReturnType<typeof setInterval>;
  private readonly redis: Redis;

  constructor(
    nsp:       Namespace,
    pubClient: Redis,
    subClient: Redis,
    opts:      Partial<RedisAdapterOptions> = {},
  ) {
    super(nsp, pubClient, subClient, opts);
    this.redis = pubClient;

    // Read the recovery window from the same nsp.server.opts the stock
    // SessionAwareAdapter reads — keeps the two paths identical for any
    // future config change to connectionStateRecovery.
    const recoveryCfg = (nsp.server as unknown as {
      opts: {connectionStateRecovery?: {maxDisconnectionDuration?: number}};
    }).opts.connectionStateRecovery;
    this.maxDisconnectionDuration = recoveryCfg?.maxDisconnectionDuration ?? 2 * 60 * 1000;

    // GC expired sessions + packets every 60s. unref so Node can exit
    // even if this timer is still scheduled (matches stock behaviour).
    this.gcTimer = setInterval(() => {
      const threshold = Date.now() - this.maxDisconnectionDuration;
      for (const [sid, session] of this.sessions) {
        if (session.disconnectedAt < threshold) this.sessions.delete(sid);
      }
      // packets is append-ordered, so we can binary-trim from the front.
      let lastExpiredIdx = -1;
      for (let i = 0; i < this.packets.length; i++) {
        if (this.packets[i].emittedAt >= threshold) break;
        lastExpiredIdx = i;
      }
      if (lastExpiredIdx >= 0) this.packets.splice(0, lastExpiredIdx + 1);
    }, 60_000);
    this.gcTimer.unref?.();
  }

  override persistSession(session: Session): void {
    const persisted: PersistedSession = {
      ...session,
      disconnectedAt: Date.now(),
    };
    this.sessions.set(session.pid, persisted);
  }

  // Why the return type widening: the parent class declares
  // `Promise<Session>` but the runtime contract (socket.io's
  // _createSocket in namespace.js) checks `if (session) { ... }` and
  // treats a falsy result as "no recovery, mint a fresh session." The
  // stock SessionAwareAdapter also returns null in identical
  // conditions; the upstream typing is just out of date with the
  // implementation. Cast through unknown so the override compiles
  // without weakening runtime safety.
  override restoreSession(pid: string, offset: string): Promise<Session> {
    return this.doRestoreSession(pid, offset) as unknown as Promise<Session>;
  }

  private async doRestoreSession(pid: string, offset: string): Promise<Session | null> {
    const session = this.sessions.get(pid);
    if (!session) return null;
    if (session.disconnectedAt + this.maxDisconnectionDuration < Date.now()) {
      this.sessions.delete(pid);
      return null;
    }
    // Why: socket.io flushes missedPackets inside the Socket constructor,
    // BEFORE the handshake auth middleware runs, so a session revoked while
    // the device was offline would still get its buffered frames replayed.
    // Audit P0-6's `jti:<jti>` allowlist is the same source of truth the
    // handshake and the live-socket recheck use.
    if (!(await this.jtiStillValid(session))) {
      this.sessions.delete(pid);
      return null;
    }
    const index = this.packets.findIndex(p => p.id === offset);
    if (index === -1) {
      // Either the client sent an empty offset (first-ever connect or
      // post-install) or the offset is older than our retention window.
      // Return null so socket.io mints a fresh session — same behaviour
      // as the stock adapter.
      return null;
    }
    const missedPackets: unknown[][] = [];
    for (let i = index + 1; i < this.packets.length; i++) {
      const packet = this.packets[i];
      if (shouldIncludePacket(session.rooms, packet.opts)) {
        missedPackets.push(packet.data);
      }
    }
    return {...session, missedPackets};
  }

  private async jtiStillValid(session: PersistedSession): Promise<boolean> {
    const jti = (session.data as {claims?: {jti?: string}} | undefined)?.claims?.jti;
    if (!jti) return false;
    try {
      return (await this.redis.exists(`jti:${jti}`)) === 1;
    } catch {
      // Fail closed — an unreachable Redis must not hand back a buffered session.
      return false;
    }
  }

  override broadcast(packet: {type: number; data?: unknown[]; id?: unknown; nsp?: string}, opts: BroadcastOptions): void {
    const isEventPacket          = packet.type === 2;
    const withoutAcknowledgement = packet.id === undefined;
    const notVolatile            = (opts.flags as {volatile?: boolean} | undefined)?.volatile === undefined;
    if (isEventPacket && withoutAcknowledgement && notVolatile && packet.data) {
      const id = yeast();
      // The offset rides at the end of the data array so the client
      // (which calls socket.onAny with ...args) can grab it from the
      // last position. Same on-wire shape as the stock adapter.
      packet.data.push(id);
      this.packets.push({
        id,
        opts,
        data:      packet.data,
        emittedAt: Date.now(),
      });
    }
    // RedisAdapter.broadcast handles cross-node publish + local dispatch.
    super.broadcast(packet as Parameters<RedisAdapter['broadcast']>[0], opts);
  }
}

/**
 * Factory matching @socket.io/redis-adapter's `createAdapter` signature
 * so the swap is one-line in RedisIoAdapter.createIOServer.
 */
export function createSessionAwareRedisAdapter(
  pubClient: Redis,
  subClient: Redis,
  opts:      Partial<RedisAdapterOptions> = {},
) {
  return function (nsp: Namespace) {
    return new SessionAwareRedisAdapter(nsp, pubClient, subClient, opts);
  };
}
