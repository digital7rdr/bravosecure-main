import {IoAdapter} from '@nestjs/platform-socket.io';
import type {INestApplicationContext} from '@nestjs/common';
import {Logger} from '@nestjs/common';
import {createAdapter} from '@socket.io/redis-adapter';
import {Server as SocketIoServer, type ServerOptions} from 'socket.io';
import Redis from 'ioredis';
import {createSessionAwareRedisAdapter} from './session-aware-redis-adapter';

/**
 * socket.io adapter backed by two ioredis clients (pub + sub). With this
 * attached, `server.to(room).emit(...)` fans out across EVERY replica —
 * so a call.offer from a caller on node A reaches the callee's socket on
 * node B without either node having direct visibility of the other.
 *
 * Heartbeat tuning comes from WS_HEARTBEAT_MS / WS_HEARTBEAT_GRACE so
 * behaviour stays consistent with the previous raw-ws gateway.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private pub?: Redis;
  private sub?: Redis;

  constructor(
    app: INestApplicationContext,
    private readonly url: string,
    private readonly heartbeatMs: number,
    private readonly heartbeatGraceMs: number,
    private readonly maxPayloadBytes: number,
    /**
     * Audit Transport P0-4 — CORS allowlist mirroring HTTP CORS.
     * Empty array means dev mode (localhost-only reflect). Explicit
     * entries here are the only browser origins allowed to open a WS.
     * Mobile clients (no Origin header on the upgrade request) are
     * always allowed — the JWT handshake middleware is the auth gate
     * for non-browser callers.
     */
    private readonly allowedOrigins: string[] = [],
    /**
     * OR-5/SRV-07 — WS_SESSION_RECOVERY, resolved via ConfigService in
     * main.ts like every other ws.* knob. Drives BOTH the adapter choice
     * and whether `connectionStateRecovery` is advertised at all, so the
     * two can never disagree: only SessionAwareRedisAdapter implements
     * `restoreSession`, and advertising recovery without it makes every
     * client mint, persist and re-present a pid/offset that can never
     * match.
     */
    private readonly sessionRecovery: boolean = false,
  ) {
    super(app);
  }

  /**
   * Audit Transport P0-4 — same allowlist policy as main.ts HTTP CORS:
   *  - explicit list set     → exact match required, reject everything else
   *  - empty list (dev only) → reflect localhost/127.0.0.1, reject everything else
   *  - no Origin header      → allow (mobile RN, server-to-server WS clients)
   */
  private originAllowed(origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void): void {
    if (!origin) return cb(null, true);
    if (this.allowedOrigins.length > 0) {
      return this.allowedOrigins.includes(origin)
        ? cb(null, true)
        : cb(new Error('cors_blocked'));
    }
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
    return cb(new Error('cors_blocked'));
  }

  async connectToRedis(): Promise<void> {
    this.pub = new Redis(this.url, {lazyConnect: true, maxRetriesPerRequest: null});
    this.sub = this.pub.duplicate();
    await Promise.all([this.pub.connect(), this.sub.connect()]);
    // Connection-state-recovery is implemented by SessionAwareRedisAdapter, but
    // its broadcast override appends an offset to EVERY WS event, so a bug would
    // affect all real-time messaging. It is therefore FLAG-GATED and OFF by
    // default: the stock createAdapter (today's exact behavior) is used unless
    // ws.sessionRecovery is true (WS_SESSION_RECOVERY=true) — enable + verify in
    // staging with a multi-client reconnect test before turning on in prod, and
    // only on a SINGLE replica (the session buffer is per-process). Default off
    // ⇒ this change is a no-op for the running app.
    if (this.sessionRecovery) {
      this.adapterConstructor = createSessionAwareRedisAdapter(this.pub, this.sub);
      this.logger.warn('socket.io redis adapter connected — SESSION RECOVERY ENABLED (WS_SESSION_RECOVERY=true)');
    } else {
      this.adapterConstructor = createAdapter(this.pub, this.sub);
      this.logger.log('socket.io redis adapter connected');
    }
  }

  createIOServer(port: number, options?: ServerOptions): SocketIoServer {
    const merged: Partial<ServerOptions> = {
      ...(options ?? {}),
      pingInterval:      this.heartbeatMs,
      pingTimeout:       this.heartbeatGraceMs,
      maxHttpBufferSize: this.maxPayloadBytes,
      transports:        ['websocket'],
      cors:              {
        origin:      (origin, cb) => this.originAllowed(origin, cb),
        credentials: true,
      },
      // socket.io 4.6+ connection state recovery — the server buffers a
      // disconnected socket's missed packets for this window; if the
      // client reconnects with the same session id it rejoins the same
      // rooms and receives everything it missed. Keeps mobile users from
      // losing typing + presence frames during brief network blips
      // (subway, elevator, lock-screen).
      //
      // Why skipMiddlewares: false — socket.io does NOT preserve custom
      // `socket.data` across the recovery boundary, only session id,
      // rooms, and missed packets. With `skipMiddlewares: true` the auth
      // middleware doesn't run on recovery, so `socket.data.claims` is
      // undefined and handleConnection drops the socket as unauthorized
      // (every recovery attempt logged `recovered=no`). Running the
      // middleware again repopulates socket.data — JWT verify is cheap,
      // and we still get the win: same session id, same rooms, queued
      // packets replayed without going through flushPendingOnConnect.
      //
      // SRV-07/OR-5 — only advertised when the SessionAware adapter is
      // actually installed. With the stock RedisAdapter `restoreSession`
      // inherits the base Adapter's `return null`, so leaving this on
      // merely made socket.io mint a `pid` for every client and made the
      // mobile transport persist and re-present a pid/offset that could
      // never be honoured.
      ...(this.sessionRecovery
        ? {
          connectionStateRecovery: {
            maxDisconnectionDuration: 2 * 60 * 1000, // 2 min
            skipMiddlewares:          false,
          },
        }
        : {}),
    };
    const server = super.createIOServer(port, merged) as SocketIoServer;
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }

  async dispose(): Promise<void> {
    await Promise.all([
      this.pub?.quit().catch(() => undefined),
      this.sub?.quit().catch(() => undefined),
    ]);
  }
}
