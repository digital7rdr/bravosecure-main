import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import {Logger, Injectable, OnModuleInit, OnModuleDestroy, UseGuards, HttpException} from '@nestjs/common';
import {WsPayloadGuard} from './ws-payload.guard';
import type {Server, Socket} from 'socket.io';
import {randomUUID} from 'node:crypto';
import {JwtService, type AccessClaims} from '../auth/jwt.service';
import {ConnectionRegistry, type Connection} from './connection-registry';
import {SocketHub} from './socket-hub';
import {PresenceService, type PresenceState} from './presence.service';
import {EnvelopeService} from '../relay/envelope.service';
import {PushService} from '../push/push.service';
import {RedisService} from '../redis/redis.service';
import {runWithReplicaLock} from '../redis/replica-lock';
import {SfuService} from '../sfu/sfu.service';
import {RoomTokenService} from '../sfu/room-token.service';
import {UserPrivacyService} from '../users/user-privacy.service';
import {WsRateLimiter, DEFAULT_WS_LIMITS, type RateLimit} from './ws-rate-limiter';
import type {
  ClientSfuJoin, ClientSfuConnectTransport, ClientSfuProduce,
  ClientSfuConsume, ClientSfuConsumerResume, ClientSfuConsumerPause, ClientSfuLeave,
  ClientSfuRing, ClientSfuRingCancel, ClientSfuRingDecline, ClientSfuRingAck,
  ClientSfuMuteTarget, ClientSfuKick,
  ClientSfuProducerPause, ClientSfuProducerResume,
} from '../sfu/sfu.types';
import {
  type CallOfferAuthBlock,
  type ClientCallAnswer,
  type ClientCallHangup,
  type ClientCallIce,
  type ClientCallMediaState,
  type ClientCallOffer,
  type ClientCallReAnswer,
  type ClientCallReOffer,
  type ClientEnvelopeAck,
  type ClientEnvelopePull,
  type ClientEnvelopeSend,
  type ClientPing,
  type ClientPresence,
  type ClientPresenceSubscribe,
  type ClientPresenceUnsubscribe,
  type ClientReadReceipt,
  type ClientTyping,
  type ServerCallAnswer,
  type ServerCallHangup,
  type ServerCallIce,
  type ServerCallMediaState,
  type ServerCallOffer,
  type ServerCallReAnswer,
  type ServerCallReOffer,
  type ServerEnvelopeAccepted,
  type ServerEnvelopeDeliver,
  type ServerError,
  type ServerPresence,
  type ServerReadReceipt,
  type ServerTyping,
} from './protocol';

/**
 * Per-socket session context captured by the handshake middleware after
 * JWT verification. Stored on `socket.data` so it survives socket.io's
 * connection-state recovery (which replays missed packets on reconnect).
 */
interface SocketContext {
  claims:         AccessClaims;
  signalDeviceId: number;
  sessionId:      string;
  /**
   * B-354 — the client declared this a BACKGROUND (headless, no-UI) socket
   * via `bg:'1'` in the handshake auth payload. It stays fully in the
   * connection/counter/lease accounting (envelope delivery, liveness) but
   * must never DRIVE user-visible presence: no 'online' assert on connect,
   * and its `presence` frames are ignored. Without this, the killed-app
   * message drain painted the recipient "Active now" to every watcher.
   */
  presenceBg:     boolean;
}

/**
 * 1:1 P2P call lifecycle the gateway tracks for auth + cleanup. A call
 * is created on the first `call.offer` (state='ringing') and ends on
 * `call.hangup` from either participant or on socket disconnect. After
 * end, a tombstone (state='ended', `endedAt` set) is retained for
 * `CALL_TOMBSTONE_TTL_MS` so a delayed duplicate offer for the same
 * callId is rejected as "already ended". Both participants are pinned
 * at offer time — late `call.*` frames from a third userId are dropped
 * with auth_failed.
 */
type CallSessionState = 'ringing' | 'active' | 'ended';
interface CallSession {
  callId:    string;
  caller:    {userId: string; deviceId: number};
  callee:    {userId: string; deviceId: number};
  state:     CallSessionState;
  createdAt: number;
  endedAt?:  number;
  /** SRV-02 — set only by `rehydrateCallSession` (replayed offer, no owning socket). */
  rehydrated?: boolean;
  /**
   * B-596 — the session now exists from the offer's FIRST line (before the
   * privacy await), so trickled ICE can no longer outrun it. While the offer
   * itself has not been forwarded yet, the caller's candidates are HELD here
   * (bounded) and flushed right behind the offer frame — never ahead of it,
   * and never at all if the offer is dropped (blocked pair / hangup / error).
   */
  offerPending?: boolean;
  heldIce?: ClientCallIce['data'][];
  /**
   * WI-6.1 — the device whose `call.answer` won the arbitration. Set exactly
   * once, on the FIRST answer; any later answer for an `active` session is
   * dropped idempotently instead of forwarding a second `call.answer`.
   */
  answeredBy?: {userId: string; deviceId: number};
}

/** Typing auto-stop window — longer than a keystroke burst, shorter than a pause. */
const TYPING_TIMEOUT_MS = 6_000;
// C-3 — how long a last-socket disconnect waits before re-checking and
// broadcasting `offline` (absorbs the same-user reconnect race).
const OFFLINE_FLIP_GRACE_MS = 3_000;

/**
 * Compact constructor for SFU error results returned over socket.io acks.
 *
 * Audit SFU-01 (2026-07-02): this MUST NOT carry an `event` property. The
 * NestJS socket.io adapter treats any handler return value with an `event`
 * key as a WsResponse and EMITS it, returning before invoking the ack
 * callback — so the client's `emitWithAck` never resolves and every SFU
 * error surfaced as a 15s `ack_timeout` instead of the real reason (this is
 * what made the group video-toggle failure impossible to diagnose). The
 * result is now an event-less `{ok:false, data:{...}}` so NestJS invokes the
 * ack; the client rejects on `ok === false`. The `data.{code,message}` shape
 * is preserved so both old and new clients parse the message the same way.
 */
function sfuError(message: string, code = 'sfu_error'): {ok: false; data: {code: string; message: string}} {
  return {ok: false, data: {code, message}};
}

/**
 * socket.io room names for SFU fanout. Participants join both at
 * `sfu.join`: `sfu:<roomId>` for room broadcasts and `sfutag:<tag>` for
 * self-addressed frames. Routing through named rooms (not raw Socket
 * refs) lets the Redis adapter deliver across pods — see bindFanout.
 */
function sfuRoom(roomId: string): string { return `sfu:${roomId}`; }
function sfuTagRoom(tag: string): string { return `sfutag:${tag}`; }

/**
 * Diagnostic SDP dumper — emits a one-line summary per m-line (kind, mid,
 * direction, ssrc count, msid presence) followed by the full SDP fenced
 * between BEGIN/END markers so it can be greppped out of `docker logs`.
 *
 * Direction is the load-bearing field for the video-call diagnosis: an
 * answer with `a=recvonly` on the video m-line means the answerer's
 * sender stayed dormant and no media will flow back.
 */
function dumpSdp(label: 'OFFER' | 'ANSWER' | 'RE-OFFER' | 'RE-ANSWER', callId: string, sdp: string | undefined): void {
  if (!sdp) {
    console.log(`[CALL][SDP] ${label} cid=${callId} (empty)`);
    return;
  }
  const lines = sdp.split(/\r?\n/);
  let curMedia: string | null = null;
  let curMid: string | null = null;
  let curDir: string | null = null;
  let curSsrcs = 0;
  let curHasMsid = false;
  const flush = () => {
    if (curMedia) {
      console.log(`[CALL][SDP] ${label} cid=${callId} kind=${curMedia} mid=${curMid ?? '?'} dir=${curDir ?? '?'} ssrcs=${curSsrcs} msid=${curHasMsid ? 'y' : 'n'}`);
    }
  };
  for (const line of lines) {
    if (line.startsWith('m=')) {
      flush();
      curMedia = line.slice(2).split(' ')[0] ?? null;
      curMid = null; curDir = null; curSsrcs = 0; curHasMsid = false;
    } else if (line.startsWith('a=mid:')) {
      curMid = line.slice(6).trim();
    } else if (line.startsWith('a=sendrecv') || line.startsWith('a=sendonly') ||
               line.startsWith('a=recvonly') || line.startsWith('a=inactive')) {
      curDir = line.slice(2).split('\r')[0].trim();
    } else if (line.startsWith('a=ssrc:')) {
      curSsrcs += 1;
    } else if (line.startsWith('a=msid:')) {
      curHasMsid = true;
    }
  }
  flush();
  // Round 2 / PII audit: do NOT log the full SDP to docker logs — it
  // exposes both peers' private IPs, port-reflexive ICE candidates,
  // and ufrag/password to anyone with `docker logs` access. Keep the
  // per-m-line summary above (which is enough to diagnose direction
  // bugs without leaking network topology) and gate the verbose dump
  // behind an explicit `BRAVO_DUMP_SDP=1` env-var so devs can opt in
  // when they need the full body for a deep diagnosis.
  if (process.env.BRAVO_DUMP_SDP === '1') {
    console.log(`[CALL][SDP] ${label} cid=${callId} === SDP BEGIN ===\n${sdp}\n[CALL][SDP] ${label} cid=${callId} === SDP END ===`);
  }
}

@Injectable()
@WebSocketGateway({
  path: '/ws',
  // Audit Transport P0-4 — CORS is enforced by RedisIoAdapter.createIOServer
  // using the same allowlist as HTTP (cors.origins config). We disable the
  // decorator-level cors here so Nest does not merge a permissive default
  // that overrides the adapter's allowlist. Mobile (no Origin header) is
  // allowed by the adapter's origin callback; browser origins must match
  // CORS_ORIGINS env var or be denied.
  cors: false,
})
// AUDIT #16 — every @SubscribeMessage payload is shape-validated at entry
// (one spec table, completeness pinned); malformed frames get a typed
// error + silent drop instead of throwing into the crash-armor path.
@UseGuards(WsPayloadGuard)
export class MessengerGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(MessengerGateway.name);

  /**
   * Pending typing auto-stop timers keyed by `${from}->${to}`. Socket.io
   * typing frames are ephemeral and can be lost; without a timer we'd
   * leave the "… is typing" indicator stuck forever if the sender's
   * `stop` frame drops. The timer guarantees the indicator self-clears.
   */
  private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Audit P0-5 — per-(socket, event) WS rate limiter. Token-bucket so
   * a single authed socket cannot pump `envelope.send` / `call.*` in a
   * tight loop and DoS the relay (same threat surface as HTTP, where
   * `@nestjs/throttler` covers it). One shared instance: per-socket
   * buckets live in a WeakMap keyed by the socket itself, so disconnect
   * garbage-collects them automatically.
   */
  private readonly wsRateLimiter = new WsRateLimiter();

  @WebSocketServer() server!: Server;

  /**
   * Track which socket each SFU participant tag belongs to so the
   * gateway can fanout `sfu.*` server frames to the right connection.
   * Also tracks tag → roomId so a socket disconnect can leave the
   * room cleanly without the participant having to send sfu.leave.
   */
  private readonly sfuTagToSocket = new Map<string, Socket>();
  private readonly sfuSocketTags  = new WeakMap<Socket, Set<string>>();
  // Audit SFU-04 — pending leave-grace timers per SFU tag. On a socket drop we
  // DELAY the mediasoup teardown so a transient blip / socket.io recovery /
  // quick reconnect doesn't kill the user's media mid-call. leaveRoom is
  // idempotent and a rejoin within grace is handled by joinRoom's same-user
  // supersede (SFU-05), so a late timer firing is a harmless no-op.
  private readonly sfuLeaveGrace  = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly SFU_LEAVE_GRACE_MS = 10_000;

  /**
   * Per-callId session state for 1:1 P2P calls. Previously the gateway
   * was a pure relay with zero knowledge of who was in which call —
   * which meant:
   *   - a malicious client could send `call.hangup` for someone else's
   *     callId and end any call (no auth);
   *   - a socket disconnect mid-call left the peer waiting 30s for ICE
   *     to time out instead of getting an immediate `bye`;
   *   - duplicate offers for the same callId were silently relayed
   *     (no idempotency).
   *
   * The map is in-memory only (1:1 sessions are short-lived and a
   * gateway restart legitimately ends the call anyway). For multi-pod
   * deployments either pin caller+callee to the same pod via Redis
   * adapter sticky sessions, or promote this to Redis with a 5-min
   * EXpiry. The `endedAt` field is a tombstone — kept for `TOMBSTONE_TTL_MS`
   * after a hangup so a late-arriving duplicate `call.offer` for the
   * same callId is rejected as "already ended" instead of being
   * accepted as a brand-new call (which is the rapid-redial-with-
   * recycled-callId attack surface).
   */
  private readonly callSessions = new Map<string, CallSession>();
  private static readonly CALL_TOMBSTONE_TTL_MS = 60_000;
  /**
   * SRV-02 — ceiling for a REHYDRATED ringing session. A session rebuilt from
   * a replayed offer has no owning socket (see `rehydrateCallSession`), so
   * `handleDisconnect`'s `socketCalls`-driven teardown can never end it: if
   * neither side ever sends a terminal frame it would sit in `callSessions`
   * for the process lifetime. The queued offer payload lives 45s and the
   * client ring timeout is 45s, so a rehydrated session still `ringing` this
   * long after replay is provably unanswerable. Only rehydrated sessions are
   * swept — a `trackCallStart` session always has an owner socket.
   */
  private static readonly REHYDRATED_RING_TTL_MS = 300_000;
  /** Tracks callIds owned per socket so handleDisconnect can fire bye. */
  private readonly socketCalls = new WeakMap<Socket, Set<string>>();

  /**
   * P1-BR-5 / B-58 — deferred disconnect-bye timers for CONNECTED 1:1
   * calls, keyed by `${callId}::${userId}::${deviceId}`. A brief WS drop
   * mid-call (Doze fd cut, Wi-Fi↔cellular handover, reconnect churn) must
   * NOT instantly tear the call down; we hold the bye for a grace window
   * so a same-device reconnect can cancel it (mirrors the SFU leave-grace).
   * Only `ringing` sessions still get the immediate bye. In-memory is fine
   * (single-replica deploy; a gateway restart legitimately ends the call).
   */
  private readonly callDisconnectGrace = new Map<string, {timer: ReturnType<typeof setTimeout>; userId: string; deviceId: number; peer: {userId: string; deviceId: number}; callId: string}>();
  private static readonly CALL_DISCONNECT_GRACE_MS = 12_000;

  /**
   * SRV-02 — `call.answer` frames whose target (the CALLER's device) was not
   * in its room at forward time, keyed by `callGraceKey(callId, caller)`.
   * A deploy drops both sockets; the callee can reconnect, drain the replayed
   * offer and accept before the caller's socket is back, and the answer is
   * then discarded as `peer_offline` with no retry on either side
   * (`signallingClient.sendAnswer` is fire-and-forget). Held briefly and
   * flushed by `handleConnection`. In-memory for the same reason as
   * `callSessions`: single-replica deploy, and a restart in this window
   * legitimately ends the call.
   */
  private readonly pendingAnswers = new Map<string, {frame: ServerCallAnswer['data']; timer: ReturnType<typeof setTimeout>}>();
  private static readonly PENDING_ANSWER_TTL_MS = 15_000;

  /** P3-P-1 — one-shot guard so the tokenless-SFU-admit warning isn't spammed. */
  private tokenlessSfuAdmitLogged = false;

  constructor(
    private readonly jwt:       JwtService,
    private readonly registry:  ConnectionRegistry,
    private readonly hub:       SocketHub,
    private readonly presence:  PresenceService,
    private readonly envelopes: EnvelopeService,
    private readonly push:      PushService,
    private readonly sfu:       SfuService,
    private readonly redis:     RedisService,
    private readonly roomToken: RoomTokenService,
    private readonly privacy:   UserPrivacyService,
  ) {
    // Wire SFU → gateway fanout so SfuService can broadcast room
    // events without importing the gateway (which would create a
    // circular dependency).
    // Multi-pod fanout: route SFU frames through socket.io rooms so the
    // Redis adapter delivers them to participants on ANY pod, not just
    // this one. Each participant socket joins `sfutag:<tag>` (self-
    // addressed frames: muted/kicked) and `sfu:<roomId>` (room
    // broadcasts: new-producer, participant.left, etc.) at `sfu.join`.
    // The old path emitted directly on in-memory `sfuTagToSocket` Socket
    // refs, which only exist on the pod that owns the connection — a
    // participant on a different pod silently never received
    // `sfu.new-producer` and their tile never appeared. `server.to(room)`
    // publishes via Redis pub/sub and reaches every replica.
    this.sfu.bindFanout({
      toParticipant: (tag, frame) => {
        this.hub.server
          ?.to(sfuTagRoom(tag))
          .emit((frame as {event: string}).event, (frame as {data?: unknown}).data ?? {});
      },
      toRoom: (roomId, frame, exceptTag) => {
        const emitter = this.hub.server?.to(sfuRoom(roomId));
        if (!emitter) return;
        // `exceptTag` excludes the frame's originator. Their socket is in
        // `sfutag:<exceptTag>`, so excluding that room drops them from the
        // broadcast on every pod (the adapter honours .except across the
        // Redis fanout, same as the typing/presence broadcasts already do).
        (exceptTag ? emitter.except(sfuTagRoom(exceptTag)) : emitter)
          .emit((frame as {event: string}).event, (frame as {data?: unknown}).data ?? {});
      },
    });
  }

  afterInit(server: Server): void {
    this.hub.server = server;

    // Handshake auth — runs before `handleConnection` and rejects bad
    // tokens with socket.io's built-in connect_error path so the client
    // gets a clean error instead of a connected-then-disconnected blip.
    // Note: socket.io's connectionStateRecovery does NOT preserve custom
    // socket.data across recovery, so this middleware ALSO runs on
    // recovery reconnects (skipMiddlewares is false in the adapter) to
    // repopulate socket.data. JWT verify is cheap; without it
    // handleConnection drops every recovered socket as unauthorized.
    server.use(async (socket, next) => {
      const ip = socket.handshake.address;
      try {
        const {token, signalDeviceId, source} = extractHandshakeParams(socket);
        if (!token) {
          this.logger.warn(`[handshake] reject missing_token ip=${ip} src=${source}`);
          return next(handshakeError('missing_token'));
        }
        if (signalDeviceId == null) {
          this.logger.warn(`[handshake] reject missing_signal_device_id ip=${ip} src=${source}`);
          return next(handshakeError('missing_signal_device_id'));
        }
        // Audit P0-T1 — warn (once per connect) when a client still
        // carries the token in the URL. The connection succeeds for
        // rollout compatibility, but every line of this warning is a
        // line that should disappear before we drop the query branch.
        if (source === 'query') {
          this.logger.warn(
            `[P0-T1] handshake_token_via_query — client should move to socket.io auth payload`,
          );
        }
        const claims = await this.jwt.verifyAccessToken(token);
        // Audit P0-6 — JTI revocation check on WS handshake. Mirrors
        // the HTTP JwtHttpGuard: a token revoked at auth-service
        // (logout, remote-wipe, password change) MUST NOT open a new
        // WS session. Previously the WS handshake stopped at signature
        // verification, so a stolen JWT kept opening new sockets for
        // the full 15-min `exp` even after revocation. The redis key
        // is `jti:<jti>`, written by auth-service on issue and DEL'd
        // on revoke; the same key the HTTP guard checks.
        if (!(await this.redis.client.exists(`jti:${claims.jti}`))) {
          this.logger.warn(`[handshake] reject token_revoked ip=${ip} sub=${claims.sub} jti=${claims.jti.slice(0,8)}`);
          return next(handshakeError('token_revoked'));
        }
        // B-354 — presence-invisible background socket (headless drain).
        // Self-declared and privacy-reducing-only: claiming it can only make
        // the caller LESS visible, so it needs no verification.
        const presenceBg = ((socket.handshake.auth ?? {}) as Record<string, unknown>).bg === '1';
        const ctx: SocketContext = {claims, signalDeviceId, sessionId: randomUUID(), presenceBg};
        socket.data = ctx;
        next();
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'invalid_token';
        this.logger.warn(`[handshake] reject verify_throw ip=${ip} msg=${msg}`);
        next(handshakeError(msg));
      }
    });

  }

  /**
   * Audit P0-6 — periodic JTI re-validation for ALREADY-CONNECTED
   * sockets. The HTTP guard and WS handshake catch revocation at
   * request/connect time; this closes the long-tail case where a
   * socket opens, the user logs out shortly after, and the existing
   * socket would otherwise drain envelopes for the full `exp` window.
   *
   * Strategy: every `JTI_RECHECK_INTERVAL_MS` we walk every connected
   * socket and EXISTS-check its claims.jti. Sockets whose JTI is gone
   * get a soft disconnect (close=true, server-side) so the client can
   * re-auth with a fresh token on reconnect. EXISTS is sub-ms per
   * key; a 60s cadence keeps the cost negligible at our scale.
   *
   * Pub/sub-style real-time invalidation could shave the worst-case
   * lag from 60s to ~1s but it requires auth-service to publish on
   * every revoke — a cross-service contract we avoid until pressure
   * justifies it. 60s is well within the "user-visible promptness"
   * bar for a remote-wipe / logout-from-other-device flow.
   */
  private readonly jtiRecheckInterval: ReturnType<typeof setInterval> = setInterval(() => {
    void this.recheckAllJtis().catch(e =>
      this.logger.warn(`[P0-6] jti recheck failed: ${(e as Error).message}`),
    );
  }, 60_000);

  private async recheckAllJtis(): Promise<void> {
    if (!this.server) return;
    const sockets = await this.server.fetchSockets();
    if (sockets.length === 0) return;
    // Batch the EXISTS lookups via pipeline so N sockets cost ~1 RTT.
    const ctxs: {jti: string; sid: string; sock: typeof sockets[number]}[] = [];
    const pipe = this.redis.client.pipeline();
    for (const sock of sockets) {
      const ctx = sock.data as SocketContext | undefined;
      if (!ctx?.claims?.jti) continue;
      ctxs.push({jti: ctx.claims.jti, sid: ctx.claims.sub, sock});
      pipe.exists(`jti:${ctx.claims.jti}`);
    }
    if (ctxs.length === 0) return;
    const results = await pipe.exec();
    for (let i = 0; i < ctxs.length; i++) {
      const [err, present] = results?.[i] ?? [null, 0];
      if (err) continue;
      if (present === 0) {
        const {jti, sid, sock} = ctxs[i];
        this.logger.log(`[P0-6] disconnecting revoked socket sub=${sid.slice(0, 8)} jti=${jti.slice(0, 8)}`);
        try { sock.emit('error', {code: 'token_revoked', message: 'session revoked'}); } catch { /* ignore */ }
        try { sock.disconnect(true); } catch { /* ignore */ }
      }
    }
  }

  /** Audit P0-6 — clear the recheck interval on module destroy. */
  onModuleDestroy(): void {
    clearInterval(this.jtiRecheckInterval);
    // P1-BR-5 — drop any pending disconnect-bye timers so they can't fire
    // after teardown (also keeps Jest from leaking open handles).
    for (const {timer} of this.callDisconnectGrace.values()) clearTimeout(timer);
    this.callDisconnectGrace.clear();
    for (const {timer} of this.pendingAnswers.values()) clearTimeout(timer);
    this.pendingAnswers.clear();
  }

  // Why: previously bootstrapMissionEventsSubscriber() ran inside
  // afterInit, which fires when the WS server starts — that happens
  // BEFORE Nest's onModuleInit has finished resolving every provider,
  // so `this.redis.client` was still undefined and `.duplicate()` threw.
  // Moving the bootstrap to onModuleInit (which Nest guarantees runs
  // AFTER every constructor-injected dependency's own onModuleInit
  // resolves) closes the race without polling.
  async onModuleInit(): Promise<void> {
    // Audit fix 5.1 — bridge auth-service `mission:events` pub/sub to
    // socket.io rooms. A dedicated subscriber connection (NOT the main
    // ioredis client — once subscribed, ioredis can't run other
    // commands on the same connection) listens for mission lifecycle
    // frames and re-emits to the matching `mission:<id>` room. The
    // socket.io Redis adapter (cluster-wide) handles cross-pod fanout.
    this.bootstrapMissionEventsSubscriber().catch(e => {
      this.logger.error(`mission-events subscriber init failed: ${(e as Error).message}`);
    });
  }

  /**
   * Audit fix 5.1 — Redis subscriber for `mission:events`. Re-emits
   * each frame to the matching `mission:<id>` socket.io room. Designed
   * to survive Redis disconnects (ioredis auto-reconnects, and the
   * subscription persists across the reconnect).
   */
  private async bootstrapMissionEventsSubscriber(): Promise<void> {
    const sub = this.redis.client.duplicate();
    sub.on('error', err => this.logger.warn(`mission-events subscriber error: ${err.message}`));
    sub.on('message', (channel: string, raw: string) => {
      if (channel !== 'mission:events') return;
      try {
        const frame = JSON.parse(raw) as {missionId: string; event: string; data: unknown; ts: number};
        if (!frame.missionId || !frame.event) return;
        this.server.to(`mission:${frame.missionId}`).emit(frame.event, {
          missionId: frame.missionId,
          ...((frame.data as object | undefined) ?? {}),
          ts: frame.ts,
        });
      } catch (e) {
        this.logger.warn(`mission-events frame parse failed: ${(e as Error).message}`);
      }
    });
    await sub.subscribe('mission:events');
    this.logger.log('subscribed to mission:events');
  }

  async handleConnection(client: Socket): Promise<void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) {
      // Should be unreachable — middleware populates data before this
      // fires — but defend anyway. Treat as an auth failure.
      try { client.emit('error', {code: 'unauthorized', message: 'missing context'}); } catch { /* ignore */ }
      try { client.disconnect(true); } catch { /* ignore */ }
      return;
    }
    const {claims, signalDeviceId, sessionId} = ctx;

    // Room membership drives cross-node fanout through the Redis adapter.
    await client.join([
      this.hub.deviceRoom({userId: claims.sub, deviceId: signalDeviceId}),
      this.hub.userRoom(claims.sub),
    ]);

    const conn: Connection = {
      userId:       claims.sub,
      deviceId:     signalDeviceId,
      socket:       client,
      sessionId,
      authDeviceId: claims.deviceId,
      lastSeenMs:   Date.now(),
    };
    const superseded = this.registry.add(conn);

    // P1-BR-5 — a reconnect within the disconnect-grace window cancels any
    // deferred bye for this (user, device) so a live call survives a brief blip.
    this.cancelCallDisconnectByes(claims.sub, signalDeviceId);
    // SRV-02 — deliver any call.answer that arrived while this device was down.
    this.flushPendingAnswers(client, {userId: claims.sub, deviceId: signalDeviceId});

    // Presence — two INDEPENDENT concerns, deliberately decoupled.
    //
    // 1. The device COUNTER. B-11 — skip the INCR entirely on a
    //    single-device takeover. The evicted socket already counted this
    //    (user, device) slot and its `onDisconnect` is skipped (presence
    //    audit fix #4), so a second INCR here leaks the counter and pins
    //    the user `online` forever even after every device has dropped.
    const firstDevice = superseded ? false : await this.presence.onConnect(claims.sub);

    // 2. The STATE key. A socket is open, therefore this user IS reachable —
    //    so re-assert it on EVERY authenticated connect, not only when
    //    `onConnect` reports the first device cluster-wide.
    //
    //    This used to be gated on that first-device edge, which made
    //    `set('online')` the ONLY writer that can ever move a state key
    //    back up: `touch` just bumps TTLs, `reassertLocalLeases` only
    //    rewrites the lease, and `sweepStale` is strictly online→offline.
    //    So any moment the key went stale-`offline` while the socket was
    //    genuinely up — a sweep that raced a momentarily-missing lease, or
    //    an underflow `onDisconnect` after the counter was reset — the user
    //    was painted grey until they happened to background/foreground the
    //    app. Because the client pins `signalDeviceId = 1`, every reconnect
    //    that races the previous socket's teardown lands in the
    //    `superseded` branch and skipped the re-assert entirely, so this
    //    was reachable on a single device with no second device involved.
    //
    //    Clobbering a live `active`/`away` with `online` is safe and
    //    self-correcting: all three are non-offline, the client re-sends its
    //    real activity immediately after reconnecting (`setActivity`), and
    //    reporting a connected user as `online` is never a lie.
    //
    //    B-354 — EXCEPT for a self-declared background socket (killed-app
    //    headless drain): a wake-driven connect says nothing about the USER,
    //    so it must never assert presence UP. It stays in the counter/lease
    //    accounting above (envelope delivery + liveness need that), and gets
    //    one repair-only write DOWN: if nothing else is connected and the
    //    state key still claims non-offline, that record is a stale leftover
    //    from an ungraceful kill — and the bg socket's own lease would now
    //    shield it from sweepStale indefinitely. Flip it to offline (stamps
    //    last-seen) instead of letting the lie outlive the app.
    if (!ctx.presenceBg) {
      await this.presence.set(claims.sub, 'online');
    } else if (firstDevice) {
      const rec = await this.presence.get(claims.sub);
      if (rec.state !== 'offline') { await this.presence.set(claims.sub, 'offline'); }
    }

    // Keep `lastSeenMs` fresh for telemetry; engine.io handles real
    // liveness via ping/pong. `onAny` gives us every inbound frame.
    client.onAny(() => this.registry.touch(claims.sub, signalDeviceId));

    this.logger.log(`ws open sub=${claims.sub} signalDev=${signalDeviceId} recovered=${client.recovered ? 'yes' : 'no'}`);

    // Auto-drain queued envelopes on connect. Without this, clients
    // that came online while messages were piling up in Redis would
    // need to remember to call `envelope.pull` themselves — which
    // every webclient/agent has historically been getting wrong, with
    // the result that "I sent a message but nothing arrived" happens
    // any time the recipient was offline at send time. Server-pushing
    // the backlog removes the dependency on client wiring.
    void this.flushPendingOnConnect(client, {userId: claims.sub, deviceId: signalDeviceId});
    void this.deliverPendingCallOffer(client, {userId: claims.sub, deviceId: signalDeviceId});
    // P2-BR-9 — replay any group-call ring queued while this user was offline
    // (live ring if within the 45s window, else a missed-group-call record).
    void this.deliverPendingGroupRing(client, {userId: claims.sub});
    // Audit RELAY-C3 — replay any delivered ("double-tick") receipts that
    // couldn't reach this sender while they were offline.
    void this.envelopes.flushPendingDelivered({userId: claims.sub, deviceId: signalDeviceId});
  }

  /**
   * If a caller hit `peer_offline` for this user recently, the offer
   * was stashed in Redis with a short TTL. Drain it on connect so the
   * callee's UI rings the moment they come back online — even if the
   * VoIP push that woke them only carried the wake-up signal, not the
   * SDP. Best-effort: failures don't block other connect-time work.
   */
  private async deliverPendingCallOffer(
    client: Socket,
    address: {userId: string; deviceId: number},
  ): Promise<void> {
    try {
      // Drain the SET of queued callIds for this device. The earlier
      // single-slot key silently overwrote the first caller when a
      // second caller dialed within 45s — they saw nothing while their
      // target rang for the second caller. Now we replay every queued
      // offer in arrival order.
      const idxKey = pendingOfferIndexKey(address.userId, address.deviceId);
      const callIds = await this.redis.client.smembers(idxKey);
      if (!callIds || callIds.length === 0) return;
      // Why: SRV-03 — the drain used to DEL the index, payload and missed-marker
      // BEFORE emitting, so a socket dying mid-drain permanently ate both the
      // ring and the missed-call record. Peek → emit → remove-what-emitted (the
      // pattern the read-receipt queue already uses); an advisory claim replaces
      // the up-front DEL as the concurrent-drain guard.
      await runWithReplicaLock(
        this.redis,
        pendingOfferDrainLockKey(address.userId, address.deviceId),
        PENDING_DRAIN_LOCK_TTL_SEC,
        () => this.drainPendingCallOffers(client, address, callIds),
      );
    } catch (e) {
      this.logger.warn(`pending-offer replay failed: ${(e as Error).message}`);
    }
  }

  /**
   * SRV-03 — read-only pass over the queued offers, then emit, then remove
   * only what actually emitted on a live socket. Anything left behind (dead
   * socket, emit throw, crash) survives in Redis under its original TTL and
   * replays on the next connect; every client path dedups the replay
   * (`missed-<callId>` bubble id, live-session routing by callId).
   */
  private async drainPendingCallOffers(
    client: Socket,
    address: {userId: string; deviceId: number},
    callIds: string[],
  ): Promise<void> {
    const live:    Array<{callId: string; offer: PendingCallOffer}> = [];
    const missed:  Array<{callId: string; marker: MissedCallMarker}> = [];
    const settled: string[] = [];
    for (const cid of callIds) {
      let raw: string | null;
      let markerRaw: string | null;
      try {
        [raw, markerRaw] = await this.redis.client.mget(
          pendingOfferKey(address.userId, address.deviceId, cid),
          missedCallMarkerKey(address.userId, address.deviceId, cid),
        );
      } catch {
        // Why: SRV-03 — a transient Redis rejection says nothing about the
        // entry. Settling here would destroy a ring and its missed-call record
        // we never even read. Leave it queued (index and marker keep their own
        // TTLs) so the next connect replays it.
        continue;
      }
      try {
        const parsed = raw ? JSON.parse(raw) as PendingCallOffer : null;
        if (parsed && (Date.now() - parsed.at) / 1000 <= 45) {
          live.push({callId: cid, offer: parsed});
          continue;
        }
        // N-02 — no live offer (expired, or the caller hung up and we purged
        // the payload but kept the marker). A surviving marker means the callee
        // genuinely missed the call.
        if (markerRaw) {
          missed.push({callId: cid, marker: JSON.parse(markerRaw) as MissedCallMarker});
          continue;
        }
        settled.push(cid);
      } catch {
        // Malformed entry is never deliverable — settle it so it can't wedge
        // the index for the full marker TTL.
        settled.push(cid);
      }
    }
    missed.sort((a, b) => a.marker.at - b.marker.at);
    live.sort((a, b) => a.offer.at - b.offer.at);
    // SYNC-5 — keep only the NEWEST cap-worth (list is ascending, so trim the
    // head) and emit oldest-first so the client's chronological splice in
    // appendMessage does no extra work. The overflow is settled unemitted —
    // gone, not deferred — so a reconnect can't page a stale backlog forever.
    for (const {callId} of missed.splice(0, Math.max(0, missed.length - MISSED_CALL_DRAIN_EMIT_CAP))) {
      settled.push(callId);
    }
    for (const {callId, marker} of missed) {
      if (!client.connected) break;
      try {
        client.emit('call.missed', {callId: marker.callId, from: marker.from, kind: marker.kind, at: marker.at});
        settled.push(callId);
      } catch { /* emit threw — leave it queued for the next connect */ }
    }
    for (const {callId, offer} of live) {
      if (!client.connected) break;
      // SRV-02 — the offer outlives the process but `callSessions` does not, so
      // re-register the session BEFORE the replay or the answer that follows is
      // dropped by `authorizeCallFrame` as an unknown callId. A live tombstone
      // means the caller already hung up: skip the replay entirely, and leave
      // the entry unsettled so the surviving missed-marker is not destroyed
      // (the 45s payload expires and the next connect reclassifies it).
      if (!this.rehydrateCallSession(offer.callId, offer.from, address)) {
        this.logger.log(`skip replay of ended cid=${offer.callId.slice(0, 8)}`);
        continue;
      }
      const ageSec = (Date.now() - offer.at) / 1000;
      this.logger.log(`replay pending offer cid=${offer.callId.slice(0, 8)} → ${address.userId.slice(0, 8)}/${address.deviceId} age=${ageSec.toFixed(1)}s`);
      try {
        client.emit('call.offer', {
          callId: offer.callId,
          from:   offer.from,
          sdp:    offer.sdp,
          kind:   offer.kind,
          // Audit S7 — replay the same signed AAD the caller minted; the
          // receiver verifies via verifyCallOfferAuth.
          auth:   offer.auth,
        });
        settled.push(callId);
      } catch { /* emit threw — leave it queued for the next connect */ }
    }
    for (const cid of settled) {
      await this.clearPendingCallArtifacts(address.userId, address.deviceId, cid);
    }
  }

  /**
   * P2-BR-9 — drain queued group-call rings for this user on connect. A ring
   * within the 45s window is replayed as a live `sfu.ring.incoming`; anything
   * older surfaces a `sfu.ring.missed` record from the missed-marker
   * (MISSED_CALL_MARKER_TTL_SEC, days — SYNC-5). The group
   * analogue of `deliverPendingCallOffer` (device-agnostic: group rings target
   * userIds, so the first device to reconnect drains the shared per-user set).
   */
  private async deliverPendingGroupRing(
    client: Socket,
    address: {userId: string},
  ): Promise<void> {
    try {
      const idxKey = pendingGroupRingIndexKey(address.userId);
      const roomIds = await this.redis.client.smembers(idxKey);
      if (!roomIds || roomIds.length === 0) return;
      // Why: SRV-03 — see drainPendingCallOffers; same destructive-drain fix.
      await runWithReplicaLock(
        this.redis,
        pendingGroupRingDrainLockKey(address.userId),
        PENDING_DRAIN_LOCK_TTL_SEC,
        () => this.drainPendingGroupRings(client, address.userId, roomIds),
      );
    } catch (e) {
      this.logger.warn(`pending group-ring replay failed: ${(e as Error).message}`);
    }
  }

  /** SRV-03 — peek → emit → remove-what-emitted for queued group rings. */
  private async drainPendingGroupRings(
    client: Socket,
    userId: string,
    roomIds: string[],
  ): Promise<void> {
    const live:    Array<{roomId: string; ring: PendingGroupRing}> = [];
    const missed:  Array<{roomId: string; marker: MissedGroupCallMarker}> = [];
    const settled: string[] = [];
    for (const rid of roomIds) {
      let raw: string | null;
      let markerRaw: string | null;
      try {
        [raw, markerRaw] = await this.redis.client.mget(
          pendingGroupRingKey(userId, rid),
          missedGroupCallMarkerKey(userId, rid),
        );
      } catch {
        // Why: SRV-03 — see drainPendingCallOffers; never settle an entry the
        // read failed on, or a transient Redis blip destroys an unread ring.
        continue;
      }
      try {
        const parsed = raw ? JSON.parse(raw) as PendingGroupRing : null;
        if (parsed && (Date.now() - parsed.at) / 1000 <= 45) {
          live.push({roomId: rid, ring: parsed});
          continue;
        }
        // No live ring (expired or host-cancelled) — surface the missed record.
        if (markerRaw) {
          missed.push({roomId: rid, marker: JSON.parse(markerRaw) as MissedGroupCallMarker});
          continue;
        }
        settled.push(rid);
      } catch {
        settled.push(rid);
      }
    }
    missed.sort((a, b) => a.marker.at - b.marker.at);
    live.sort((a, b) => a.ring.at - b.ring.at);
    // SYNC-5 — bound the reconnect burst (see MISSED_CALL_DRAIN_EMIT_CAP);
    // overflow (oldest first) is settled unemitted, same as the 1:1 drain.
    for (const {roomId} of missed.splice(0, Math.max(0, missed.length - MISSED_CALL_DRAIN_EMIT_CAP))) {
      settled.push(roomId);
    }
    for (const {roomId, marker} of missed) {
      if (!client.connected) break;
      try {
        client.emit('sfu.ring.missed', {
          roomId: marker.roomId, conversationId: marker.conversationId,
          from: marker.from, callType: marker.callType, at: marker.at,
        });
        settled.push(roomId);
      } catch { /* leave queued for the next connect */ }
    }
    // B-479 — live rings are NOT settled here. This replay used to be
    // destructive (emit + delete in one pass), so the ring got exactly one
    // chance to land and a client that could not present it at that instant
    // lost the call entirely — no ring, no replay, no missed-call record. The
    // sharpest case is a socket coming up mid backup-restore, which the restore
    // flow does twice while its own suppression flag is still armed.
    //
    // They now stay queued until the client acks (`sfu.ring.ack`), which it
    // sends once it has taken responsibility for the ring. An unacked ring is
    // re-emitted on the next reconnect and is bounded by the 45 s live-window
    // check above, after which it degrades to a missed-call record — so this
    // cannot queue forever.
    for (const {ring} of live) {
      if (!client.connected) break;
      this.logger.log(`replay pending group-ring rid=${ring.roomId.slice(0, 8)} → ${userId.slice(0, 8)} (awaiting ack)`);
      try {
        client.emit('sfu.ring.incoming', {
          roomId:         ring.roomId,
          conversationId: ring.conversationId,
          callType:       ring.callType,
          from:           ring.from,
          callerName:     ring.callerName,
          roomToken:      ring.roomToken,
          roomTokenExp:   ring.roomTokenExp,
          // B-336 — replay the ORIGINAL fan-out's id so the client still
          // dedups this against the copy it may already have presented.
          ringId:         ring.ringId,
          // B-479 — marks this as a REPLAY, which is what the client acks.
          // Live fan-out frames are deliberately not acked: their queued
          // artifacts include the days-long missed-call marker, and clearing
          // that early would cost the user their missed-call record for a ring
          // they simply never answered. Only a replay means "the queue did its
          // job", which is exactly what the old post-emit delete asserted —
          // the ack just makes it conditional on the client confirming.
          replayed:       true,
        });
      } catch { /* leave queued for the next connect */ }
    }
    for (const rid of settled) {
      await this.clearPendingGroupRingArtifacts(userId, rid);
    }
  }

  /**
   * P2-BR-9 — remove a queued group ring (payload, marker, index) for one target.
   *
   * WI-6.3 — one atomic MULTI (writer parity): the old three sequential awaits
   * could tear mid-sequence and leave marker+index with no payload, which the
   * reconnect drain reads as a missed group call for a ring that was handled.
   *
   * WI-6.7 — `opts.onlyRingId`: a HOST CANCEL names the one fan-out it is
   * cancelling. When a NEWER ring for the same room is queued (mid-call "Add",
   * host Re-ring), its artifacts must survive cancel of the OLD ring, so each
   * key is cleared only if its stored ringId is absent (pre-B-336 rows) or
   * matches. The read→MULTI window is a bounded TOCTOU (a fan-out landing in
   * between can lose its just-queued copy) — the pre-WI-6.7 behaviour was
   * unconditionally worse (every cancel destroyed the newer ring outright).
   */
  private async clearPendingGroupRingArtifacts(
    userId: string,
    roomId: string,
    opts: {onlyRingId?: string} = {},
  ): Promise<void> {
    try {
      let clearPayload = true;
      let clearMarker  = true;
      if (opts.onlyRingId) {
        const [rawRing, rawMarker] = await this.redis.client.mget(
          pendingGroupRingKey(userId, roomId),
          missedGroupCallMarkerKey(userId, roomId),
        );
        const ringIdOf = (raw: string | null): string | undefined => {
          if (!raw) return undefined;
          try { return (JSON.parse(raw) as {ringId?: string}).ringId; } catch { return undefined; }
        };
        const payloadRingId = ringIdOf(rawRing);
        const markerRingId  = ringIdOf(rawMarker);
        clearPayload = !payloadRingId || payloadRingId === opts.onlyRingId;
        clearMarker  = !markerRingId  || markerRingId  === opts.onlyRingId;
      }
      if (!clearPayload && !clearMarker) return; // both belong to a newer ring
      const chain = this.redis.client.multi();
      if (clearPayload) chain.del(pendingGroupRingKey(userId, roomId));
      if (clearMarker)  chain.del(missedGroupCallMarkerKey(userId, roomId));
      // The index entry must stay reachable while EITHER artifact survives —
      // the drain enumerates only the index (P1-15's lesson, group flavour).
      if (clearPayload && clearMarker) {
        chain.srem(pendingGroupRingIndexKey(userId), roomId);
      }
      const res = await chain.exec();
      if (!Array.isArray(res) || res.some(([e]) => !!e)) {
        this.logger.warn(`[SFU] clear-ring MULTI partial failure rid=${roomId.slice(0, 8)} → ${userId.slice(0, 8)}`);
      }
    } catch { /* best effort */ }
  }

  /**
   * On a freshly-connected socket, pull every pending envelope for
   * the (userId, deviceId) and emit them as `envelope.deliver` frames.
   * The client's existing inbound handler ACKs each via `envelope.ack`,
   * which removes them from Redis. Best-effort: any error is logged
   * and the client can still call `envelope.pull` explicitly to retry.
   *
   * Round 7 / crypto audit fix F1+F2 — previously this used a hard-
   * coded `limit=200` with no bootstrap flag. The relay clamps non-
   * bootstrap pulls to `relay.maxPullLimit` (default 100), so
   * recipients with >100 queued envelopes silently lost the rest until
   * they explicitly hit `envelope.pull` (which clients don't do
   * automatically because the connect-flush conditioned them not to).
   * Now we pass `{bootstrap:true}` to lift the cap to
   * `relay.maxBootstrapLimit` (default 1000) AND paginate until the
   * server has nothing left to deliver.
   */
  private async flushPendingOnConnect(
    client: Socket,
    address: {userId: string; deviceId: number},
  ): Promise<void> {
    const PAGE_SIZE = 1000;
    const MAX_PAGES = 20; // 20k envelopes ceiling; symptomatic of a stuck-ack loop beyond that.
    try {
      let total = 0;
      let after = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const pending = await this.envelopes.pull(address, after, PAGE_SIZE, {bootstrap: true});
        if (pending.length === 0) break;
        for (const env of pending) {
          // Why: pass JUST the inner payload as socket.io's data arg.
          // The two other emit sites (tryFanOut, envelope.pull handler)
          // already do `emit(event, frame.data)`. Previously this site
          // passed the WHOLE ServerEnvelopeDeliver wrapper, so the
          // client's onAny handler rebuilt `{event, data:{event, data:{...}}}`
          // and every catch-up envelope arrived with `data.envelopeId`
          // undefined — handleDeliver's unwrap step then threw
          // "Cannot read property 'slice' of undefined", surfaced as
          // the persistent red banner on the chat surface, and the
          // recipient never rendered any pending message.
          client.emit('envelope.deliver', {
            envelopeId:  env.envelopeId,
            outerSealed: env.outerSealed,
            timestamp:   env.timestamp,
            // Audit P0-N9 — ack token from service.pull (minted or
            // reused) lets the recipient prove possession on ack.
            ackToken:    env.ackToken,
          });
        }
        total += pending.length;
        // Audit P1-T7 — same-ms cursor safety. The relay's
        // zrangebyscore uses an EXCLUSIVE lower bound (`(${after}`),
        // so anything at the EXACT cursor timestamp is skipped on the
        // next page. When a page is full (PAGE_SIZE rows) the very
        // next envelope might share the last ms of this page; if we
        // advance to `last.timestamp` we'd silently drop those rows.
        // Step back by 1ms and rely on the receive-side `seenEnvelopes`
        // dedup (P0-N6) to swallow the resulting overlap. The single-
        // ms overlap is bounded — at most one ms of duplicate IDs per
        // page — and the seen-set lookup is O(1).
        const lastTs = pending[pending.length - 1].timestamp;
        after = pending.length >= PAGE_SIZE ? Math.max(0, lastTs - 1) : lastTs;
        if (pending.length < PAGE_SIZE) break;
      }
      if (total > 0) {
        this.logger.log(`flush ${total} pending envelopes → ${address.userId}/${address.deviceId}`);
      }
    } catch (e) {
      this.logger.warn(`flush failed for ${address.userId}/${address.deviceId}: ${(e as Error).message}`);
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return;
    const {claims, signalDeviceId, sessionId} = ctx;

    // Round 7 / presence audit fix #4 — capture whether this disconnect
    // is a real eviction (the session owned the registry slot) or a
    // supersession-driven leftover (a newer sessionId already took
    // over). When a fresh socket replaces us the new connection has
    // already fired `presence.onConnect`, so we must NOT also fire
    // `presence.onDisconnect` — that would DECR back to zero and
    // broadcast a spurious offline → online blip across every watcher.
    const wasLiveOwner = this.registry.remove(claims.sub, signalDeviceId, sessionId);
    this.clearTypingTimersFrom(claims.sub, signalDeviceId);

    // Tear down any SFU participant tags owned by this socket — without
    // this, a reload-mid-call leaves the Router thinking the participant
    // is still in the room and peers keep receiving stale producers.
    const tags = this.sfuSocketTags.get(client);
    if (tags) {
      for (const tag of tags) {
        // Audit SFU-04 — grace before teardown (see sfuLeaveGrace). The dead
        // socket's tag mapping is dropped now, but the mediasoup participant is
        // held for SFU_LEAVE_GRACE_MS so a quick reconnect keeps media alive.
        this.sfuTagToSocket.delete(tag);
        const prev = this.sfuLeaveGrace.get(tag);
        if (prev) clearTimeout(prev);
        const timer = setTimeout(() => {
          this.sfuLeaveGrace.delete(tag);
          void this.sfu.leaveRoom(tag).catch(() => { /* swallow — idempotent */ });
        }, MessengerGateway.SFU_LEAVE_GRACE_MS);
        // Don't keep the event loop alive on this timer alone.
        (timer as unknown as {unref?: () => void}).unref?.();
        this.sfuLeaveGrace.set(tag, timer);
      }
      tags.clear();
    }

    // Fire `call.hangup` to the peer for every active 1:1 call this
    // socket owned. Without this, a flaky-network drop leaves the peer
    // staring at "Connecting…" / "In call" until ICE consent times out
    // (~30s with default RFC 7675 settings). With this, the peer sees
    // "Call ended (failed)" within milliseconds. Cheap fanout — at
    // most 1-2 active calls per socket. Idempotent if the client also
    // sent a final `call.hangup` before disconnect (trackCallEnd is
    // already a no-op on tombstoned sessions).
    const ownedCalls = this.socketCalls.get(client);
    if (ownedCalls) {
      const myUserId = claims.sub;
      const myDeviceId = signalDeviceId;
      for (const callId of ownedCalls) {
        const session = this.callSessions.get(callId);
        if (!session || session.state === 'ended') continue;
        // B-596 — the offer never went out: end silently, no bye to a callee
        // (possibly a blocked pair) that has never heard of this call.
        if (session.offerPending) { this.trackCallEnd(callId); continue; }
        // Identify the peer (the OTHER participant).
        const peer = session.caller.userId === myUserId
          ? session.callee
          : session.caller;
        if (session.state === 'active') {
          // P1-BR-5 / B-58 — a CONNECTED call must survive a brief WS blip.
          // Defer the bye by the grace window; a same-device reconnect cancels
          // it (see handleConnection). Only unanswered `ringing` sessions get
          // the immediate bye so a dropped ring doesn't dangle.
          this.scheduleCallDisconnectBye(callId, {userId: myUserId, deviceId: myDeviceId}, peer);
          continue;
        }
        this.trackCallEnd(callId);
        const target = this.hub.server?.to(this.hub.deviceRoom(peer));
        if (target) {
          target.emit('call.hangup', {
            callId,
            from:   {userId: myUserId, deviceId: myDeviceId},
            reason: 'failed',
          });
          this.logger.log(`[CALL] disconnect-bye cid=${callId.slice(0, 8)} → ${peer.userId.slice(0, 8)}/${peer.deviceId}`);
        }
      }
      ownedCalls.clear();
    }

    // Atomic DECR — flip to `offline` only when this was the user's
    // last active socket across the cluster. Skip entirely when a
    // newer session already evicted us (see fix #4 above) — the new
    // socket's presence.onConnect already maintained the count, so
    // touching it here would underflow.
    if (wasLiveOwner && await this.presence.onDisconnect(claims.sub)) {
      // AUDIT-2026-08-13 C-3 — defer the offline flip past the reconnect
      // window: a disconnect racing a same-user reconnect could DECR to
      // zero (transient `offline` to every watcher) while the new
      // socket's INCR was still in flight. Re-check after the grace and
      // flip only if the user is STILL gone. A pod death mid-grace loses
      // the timer — sweepStale covers that path, as it already does for
      // handlers that never ran.
      const uid = claims.sub;
      const t = setTimeout(() => {
        void (async () => {
          try {
            if (await this.presence.confirmOffline(uid)) {
              await this.presence.set(uid, 'offline');
            }
          } catch { /* transient Redis blip — sweepStale converges */ }
        })();
      }, OFFLINE_FLIP_GRACE_MS);
      (t as unknown as {unref?: () => void}).unref?.();
    }

    this.logger.log(`ws close sub=${claims.sub} signalDev=${signalDeviceId}`);
  }

  // ─── ping / envelope handlers (unchanged semantics) ─────────────────

  @SubscribeMessage('ping')
  handlePing(
    @MessageBody() data: ClientPing['data'],
    @ConnectedSocket() client: Socket,
  ): {ts: number} {
    const ts = data?.ts ?? Date.now();
    // Why B-05: two clients hit this handler with different needs.
    //  (1) productionRuntime sends fire-and-forget `ping` (transport.send) and
    //      listens for a `pong` EVENT (RTT chip + AppState-resume gating).
    //  (2) useGroupCall sends `ping` via emitWithAck() and needs the socket.io
    //      ACK to resolve, else it ack_timeouts every keepalive cadence.
    // NestJS routes an event-shaped return ({event,data}) to socket.emit() and
    // returns BEFORE invoking the ack — so the old `return {event:'pong',...}`
    // fed (1) but never acked (2). Emit the event explicitly for (1), and
    // return an event-LESS object so Nest invokes the ack for (2).
    client.emit('pong', {ts});
    // Audit WS-MED — refresh the presence liveness counter on the heartbeat so
    // a long-lived foreground socket (> counter TTL) isn't false-reaped to
    // `offline` by the stale sweep. Fire-and-forget; ping must stay cheap.
    const ctx = client.data as SocketContext | undefined;
    if (ctx) void this.presence.touch(ctx.claims.sub).catch(() => { /* best-effort */ });
    return {ts};
  }

  /**
   * B-100/B-101 — in-place socket re-authentication.
   *
   * The socket binds to the handshake token's `jti` for its whole life,
   * but that jti's Redis allowlist key lives only as long as the access
   * token (15 min, and it is DEL'd the instant a refresh rotates the
   * session). The P0-6 sweep then disconnects the socket — which, for a
   * live call, is a death sentence (12s disconnect-bye / 10s SFU leave
   * grace) because the client's reconnect paths are frozen while the
   * screen is locked. Letting the client hand us its FRESH token and
   * swapping the claims in place removes the disconnect entirely.
   *
   * Security posture — this ADDS no authority and weakens nothing:
   *   • The new token gets the EXACT handshake treatment: HS256
   *     signature + `exp` + issuer/audience via `verifyAccessToken`,
   *     then the same `jti:<jti>` Redis allowlist check.
   *   • Identity is PINNED: a token for a different `sub` or a
   *     different `device_id` is refused, so a socket can never
   *     re-auth its way into another identity or device slot. The
   *     handshake-derived `signalDeviceId` / `sessionId` are untouched.
   *   • Revocation promptness is preserved (architecture contract
   *     "instant kill", MESSENGER_BACKEND.md): a revoked jti is absent
   *     from the allowlist, so re-auth is refused AND the 60s sweep
   *     still disconnects on the stale claims. We deliberately do NOT
   *     add a revocation grace or exempt in-call sockets from the
   *     sweep — both were considered and rejected as weakenings.
   *   • Failure is non-destructive: we keep the existing (already
   *     authenticated) claims and let the sweep act on them. A bad
   *     token cannot downgrade or hijack a healthy socket.
   */
  @SubscribeMessage('auth.refresh')
  async handleAuthRefresh(
    @MessageBody() data: {token?: string} | undefined,
    @ConnectedSocket() client: Socket,
  ): Promise<{ok: true} | {ok: false; code: string}> {
    const limited = this.rateGate(client, 'auth.refresh');
    if (limited) return {ok: false, code: 'rate_limited'};
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return {ok: false, code: 'no_active_session'};
    const token = typeof data?.token === 'string' ? data.token : '';
    if (!token) return {ok: false, code: 'missing_token'};
    try {
      const claims = await this.jwt.verifyAccessToken(token);
      // Identity pin — the ONLY claims we accept are a fresh credential
      // for the very same principal this socket already authenticated as.
      if (claims.sub !== ctx.claims.sub || claims.deviceId !== ctx.claims.deviceId) {
        this.logger.warn(
          `[auth.refresh] reject identity_mismatch sub=${ctx.claims.sub.slice(0, 8)} ` +
          `presented=${claims.sub.slice(0, 8)}`,
        );
        return {ok: false, code: 'identity_mismatch'};
      }
      if (!(await this.redis.client.exists(`jti:${claims.jti}`))) {
        return {ok: false, code: 'token_revoked'};
      }
      ctx.claims  = claims;
      client.data = ctx;
      this.logger.debug?.(
        `[auth.refresh] ok sub=${claims.sub.slice(0, 8)} jti=${claims.jti.slice(0, 8)}`,
      );
      return {ok: true};
    } catch {
      // Review SEC-3 — return a flat code, never the verifier's message.
      // The client has no use for the distinction and the exception text
      // can name the failed check (algorithm, audience, issuer), which
      // is free reconnaissance.
      return {ok: false, code: 'invalid_token'};
    }
  }

  /**
   * Audit fix 5.1 — mission lifecycle subscription.
   *
   * The auth-service publishes mission status/team/telemetry frames
   * to the Redis `mission:events` channel; this gateway listens (see
   * `onModuleInit` below) and re-emits to the `mission:<id>` room.
   * Clients call `mission.subscribe` with the missionId they care
   * about and the gateway joins their socket to that room.
   *
   * Membership guard: ANY authenticated socket can subscribe. The
   * frames carry only state summaries (not message content), and the
   * underlying REST endpoints (which the client uses for the actual
   * payload re-fetch) are already region/role-gated. The subscribe
   * itself is metadata only — knowing "mission X just went LIVE" is
   * not sensitive enough to warrant a second auth round-trip per
   * subscribe.
   *
   * Multiple missions per socket are supported (operator opens 3
   * tabs, each on a different mission). Unsubscribe drops the room
   * membership; full disconnect drops everything automatically.
   */
  /**
   * Audit P0-5 — per-socket WS rate-limit gate. Returns a typed
   * `ServerError` when the (socket, event) bucket is exhausted; the
   * caller returns it directly so socket.io routes it into the
   * standard ack/error channel. Limits live in `DEFAULT_WS_LIMITS`;
   * pass an override only when the call site has a justified looser
   * (or tighter) cadence than the table default.
   *
   * Returns `null` on the happy path so the call site doesn't have to
   * unwrap a discriminated union before continuing.
   */
  private rateGate(socket: Socket, event: string, override?: RateLimit): ServerError | null {
    const limit = override ?? DEFAULT_WS_LIMITS[event];
    if (!limit) return null;
    const result = this.wsRateLimiter.consume(socket, event, limit);
    if (result.ok) return null;
    return {
      event: 'error',
      data:  {
        code:    'rate_limited',
        message: `event ${event} rate-limited; retry in ${result.retryAfterMs}ms`,
      },
    };
  }

  /**
   * Audit MEDIUM-3 (2026-07-02): CLUSTER-GLOBAL per-USER rate limit for the hot
   * abusive verbs. The per-socket WsRateLimiter is in-memory, so a single user
   * amplifies a flood by opening N sockets across N pods. This is a Redis
   * fixed-window counter keyed on (user, verb, minute) — one INCR+EXPIRE per
   * accepted request, enforced across the whole cluster regardless of how many
   * sockets/pods the user spreads across. Fails OPEN on a Redis hiccup (the
   * per-socket limiter still applies) so a transient Redis blip can't lock
   * every user out. Returns true when the caller should REJECT.
   */
  private async userRateExceeded(userId: string, verb: string, perMinute: number): Promise<boolean> {
    try {
      const bucket = Math.floor(Date.now() / 60_000);
      const key = `urate:${verb}:${userId}:${bucket}`;
      // AUDIT-2026-08-13 D-5 — INCR-then-conditional-EXPIRE leaked the key
      // forever when the EXPIRE leg never ran (crash/disconnect between the
      // two RTTs): the bucket rotates each minute, so the orphan was pure
      // Redis memory growth. MULTI runs both server-side atomically; the
      // unconditional EXPIRE is safe because the WINDOW lives in the key
      // (bucket suffix), not the TTL — refreshing it never widens the rate
      // window, it only guarantees every touched key carries a TTL.
      const res = await this.redis.client.multi().incr(key).expire(key, 120).exec();
      // ioredis exec RESOLVES per-command errors into the result slots —
      // a failed INCR must fail OPEN here, not read as n=undefined.
      const incrSlot = res?.[0];
      if (!incrSlot || incrSlot[0]) {return false;}
      const n = incrSlot[1] as number;
      return n > perMinute;
    } catch {
      return false; // fail-open — per-socket limiter is still in force
    }
  }

  @SubscribeMessage('mission.subscribe')
  async handleMissionSubscribe(
    @MessageBody() data: {missionId: string},
    @ConnectedSocket() client: Socket,
  ): Promise<{event: 'mission.subscribed'; data: {missionId: string}} | ServerError> {
    const limited = this.rateGate(client, 'mission.subscribe');
    if (limited) return limited;
    if (!data?.missionId || typeof data.missionId !== 'string' || data.missionId.length > 64) {
      return {event: 'error', data: {code: 'bad_request', message: 'invalid_mission_id'}};
    }
    // Audit P1-T3 — per-socket mission subscription cap. The full fix
    // (membership check against auth-service) is tracked separately;
    // until then the cap limits the blast radius of an authed
    // attacker fishing for mission activity. 32 is roomy for legit
    // operators juggling multiple dashboards but well below the
    // thousands-of-rooms-at-once shape of a fishing attack.
    const MAX_MISSIONS_PER_SOCKET = 32;
    const currentMissionRooms = Array.from(client.rooms).filter(r => r.startsWith('mission:')).length;
    if (currentMissionRooms >= MAX_MISSIONS_PER_SOCKET) {
      return {event: 'error', data: {
        code: 'mission_sub_limit',
        message: `socket cap of ${MAX_MISSIONS_PER_SOCKET} mission subscriptions reached`,
      }};
    }
    await client.join(`mission:${data.missionId}`);
    return {event: 'mission.subscribed', data: {missionId: data.missionId}};
  }

  @SubscribeMessage('mission.unsubscribe')
  async handleMissionUnsubscribe(
    @MessageBody() data: {missionId: string},
    @ConnectedSocket() client: Socket,
  ): Promise<{event: 'mission.unsubscribed'; data: {missionId: string}} | ServerError> {
    if (!data?.missionId || typeof data.missionId !== 'string') {
      return {event: 'error', data: {code: 'bad_request', message: 'invalid_mission_id'}};
    }
    await client.leave(`mission:${data.missionId}`);
    return {event: 'mission.unsubscribed', data: {missionId: data.missionId}};
  }

  @SubscribeMessage('envelope.send')
  async handleEnvelopeSend(
    @MessageBody() data: ClientEnvelopeSend['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerEnvelopeAccepted | ServerError> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    const limited = this.rateGate(client, 'envelope.send');
    if (limited) {
      this.logger.warn(`[envelope.send] rate-limited sub=${ctx.claims.sub.slice(0,8)} clientMsgId=${(data?.clientMsgId ?? '?').slice(0,8)}`);
      return limited;
    }
    // MEDIUM-3 — cluster-global per-user cap (defeats multi-socket / multi-pod
    // amplification of the per-socket limit). 600/min = 10/s sustained, well
    // above any human sender, blunts a scripted flood from one account.
    if (await this.userRateExceeded(ctx.claims.sub, 'env', 600)) {
      this.logger.warn(`[envelope.send] user-rate-limited sub=${ctx.claims.sub.slice(0,8)}`);
      return {event: 'error', data: {code: 'rate_limited', message: 'per-user send rate exceeded'}};
    }
    this.logger.log(`[envelope.send] sub=${ctx.claims.sub.slice(0,8)} → ${(data?.to?.userId ?? '?').slice(0,8)}/${data?.to?.deviceId} clientMsgId=${(data?.clientMsgId ?? '?').slice(0,8)}`);
    try {
      const res = await this.envelopes.submitEnvelope({
        recipient:    data.to,
        outerSealed:  data.outerSealed,
        clientMsgId:  data.clientMsgId,
        expiresAtSec: data.expiresAtSec,
        // Audit P0-T6 — pass the submitter so the relay can wire the
        // delivered callback. The submitter address comes from the
        // authenticated WS context — not from any client-supplied
        // field — so it cannot be spoofed by the sender. NOT
        // persisted into StoredEnvelope; lives only in the transient
        // `submitter:{envelopeId}` mapping consumed at recipient ack.
        submitter:    {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId},
      });

      // Fire a chat-wake FCM push so the recipient sees a heads-up
      // banner when their app is backgrounded or killed. Best-effort:
      // failures must not block the WS ack. Sender identity is the
      // submitting JWT's claims.sub — which is what we already
      // disclose to the relay for rate limiting; pushing it as data
      // so the client can swap in the local contact name doesn't
      // widen the trust boundary.
      // Title stays generic ("New message") since AccessClaims only
      // carries `sub` — the client looks up the local name on receipt.
      // Audit P2-BR-3 — parity with the HTTP path: skip the wake for
      // non-displayable envelopes (`urgent:false` from the client) and for
      // submits the relay marked not notification-worthy (dedup-hit retry,
      // pre-expired send) so killed devices stop getting phantom banners.
      if (data.urgent !== false && res.wakeEligible) {
        void this.push.sendChatWake(data.to.userId, {
          senderUserId: ctx.claims.sub,
          // B-715 — log-only join key (never reaches the FCM payload). This lane
          // also logs `clientMsgId` on its `accepted` line below, so the WS path
          // is the one that can be followed end to end: sender's clientMsgId →
          // envelopeId → push → the recipient's frame.
          envelopeId:   res.envelopeId,
        }).catch(e => this.logger.warn(`push.chat.dispatch-failed: ${(e as Error).message}`));
      }

      const accepted: ServerEnvelopeAccepted = {
        event: 'envelope.accepted',
        data:  {
          clientMsgId:  res.clientMsgId ?? data.clientMsgId,
          envelopeId:   res.envelopeId,
          retractToken: res.retractToken,
        },
      };
      // Why: the mobile transport uses fire-and-forget `socket.emit` with
      // no callback (transport/client.ts#send), so the NestJS return value
      // — which socket.io routes into the callback-ack channel — is
      // silently discarded. The sender's runtime waits on the
      // `envelope.accepted` *event* (handled in onAny → handleAccepted)
      // and falls back to a 5s HTTP retry when it never arrives. Emit
      // explicitly so the event listener fires; the return is kept for
      // any future callback-style caller.
      // B-715 — `lane` and `postPutMs` join this line to the HTTP twin in
      // envelope.controller and expose the post-durability tail (T3→T5) that was
      // previously folded invisibly into this single timestamp.
      this.logger.log(`[envelope.send] accepted envId=${res.envelopeId.slice(0,8)} clientMsgId=${(data?.clientMsgId ?? '?').slice(0,8)} lane=ws postPutMs=${res.postPutMs ?? -1}`);
      client.emit('envelope.accepted', accepted.data);
      return accepted;
    } catch (e) {
      this.logger.warn(`[envelope.send] FAILED sub=${ctx.claims.sub.slice(0,8)} → ${(data?.to?.userId ?? '?').slice(0,8)} err=${(e as Error).message?.slice(0,120)}`);
      return toError(e);
    }
  }

  @SubscribeMessage('envelope.ack')
  async handleEnvelopeAck(
    @MessageBody() data: ClientEnvelopeAck['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{event: 'envelope.ack.ok'; data: {envelopeId: string}} | ServerError> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    this.logger.log(`[envelope.ack] received sub=${ctx.claims.sub.slice(0,8)} envId=${(data.envelopeId ?? '?').slice(0,8)}`);
    const limited = this.rateGate(client, 'envelope.ack');
    if (limited) {
      this.logger.warn(`[envelope.ack] RATE-LIMITED sub=${ctx.claims.sub.slice(0,8)} envId=${(data.envelopeId ?? '?').slice(0,8)}`);
      return limited;
    }
    try {
      // Audit P0-N9 — service enforces the possession-proof token when
      // present, falls back to the recipient-identity check when absent
      // (rollout window), and rejects when `relay.requireAckToken=true`.
      await this.envelopes.ack(
        {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId},
        data.envelopeId,
        data.ackToken,
        // Handoff §3.6(c) — only the literal 'discarded' flips the
        // sender-facing receipt; junk/missing defaults to 'delivered'.
        data.disposition === 'discarded' ? 'discarded' : 'delivered',
      );
      return {event: 'envelope.ack.ok', data: {envelopeId: data.envelopeId}};
    } catch (e) {
      this.logger.warn(`[envelope.ack] FAILED sub=${ctx.claims.sub.slice(0,8)} envId=${(data.envelopeId ?? '?').slice(0,8)} err=${(e as Error).message?.slice(0,120)}`);
      return toError(e);
    }
  }

  // ─── Call signalling (M8) ─────────────────────────────────────────

  @SubscribeMessage('call.offer')
  async handleCallOffer(
    @MessageBody() data: ClientCallOffer['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    const limited = this.rateGate(client, 'call.offer');
    if (limited) return limited;
    // Audit row #6 — fail-CLOSED at the gateway when the offer carries
    // no auth block. The mobile dispatcher also rejects the same case
    // end-to-end, so the only senders shipping an unsigned offer here
    // are either out-of-date clients (about to be rejected anyway) or
    // attackers probing the WS surface directly. Drop early so we don't
    // leak a `peer_offline` / VoIP-wake side-channel based on the
    // recipient's online state.
    if (!data.auth) {
      console.warn(`[CALL] reject unsigned offer from=${ctx.claims.sub?.slice(0, 8)} cid=${data.callId.slice(0, 8)}`);
      return {event: 'error', data: {code: 'missing_offer_auth', message: 'call.offer requires auth block'}};
    }
    // Why: M-07 (P1-11) — a blocked pair must not ring the blocker, live OR
    // killed. Silent-drop mirroring the typing/read-receipt no-oracle path: no
    // error to the caller, no session tracked, no forward, no pending-offer
    // queue, no VoIP wake. Unlike sealed-sender messages, call.offer exposes
    // both parties to the server, so a server-side gate is feasible here.
    // Audit Step 0 (B-596) — stamp the frame's ARRIVAL before the privacy
    // await, so the relay log shows real wire order (the OFFER line below
    // prints after the await and used to hide the ICE-before-session window).
    console.log(`[CALL] OFFER recv from=${ctx.claims.sub?.slice(0, 8)}/${ctx.signalDeviceId} cid=${data.callId.slice(0, 8)}`);
    // B-596 (audit Step 1) — register the session BEFORE the first await.
    // The client's B-273 gate flushes its buffered candidates the instant the
    // offer frame is emitted, so they land here while this handler is parked
    // at the privacy await; with no session yet, handleCallIce {ignore}d them
    // (the host/srflx ones — the call then connected later, via relay). The
    // session is created synchronously, marked offer-pending, and ICE for it is
    // HELD (bounded) until the offer frame has been forwarded — then flushed
    // behind it, or discarded if the offer never goes out.
    const trackErr = this.trackCallStart(
      client, data.callId,
      {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId},
      {userId: data.to.userId, deviceId: data.to.deviceId},
    );
    if (trackErr) {
      console.warn(`[CALL] OFFER rejected cid=${data.callId.slice(0, 8)} ${trackErr.data.code}`);
      return trackErr;
    }
    const pendingSession = this.callSessions.get(data.callId);
    if (pendingSession) {pendingSession.offerPending = true;}
    // M-07 semantics are unchanged: a blocked pair gets no forward, no queue,
    // no wake, no error — and now also no lingering session (untracked
    // silently, no tombstone, so a retry cannot read `duplicate_call_id` as an
    // oracle). B-597: the lookup is DEADLINE-bounded — on deadline it fails
    // OPEN exactly like the service's own probe-error path.
    let blocked = false;
    try {
      blocked = await this.privacyGateBounded(ctx.claims.sub, data.to.userId, 'offer');
    } catch (e) {
      // A rejecting lookup must never leave the hold armed (every later
      // candidate for the call would be black-holed) — clear, then propagate.
      this.clearOfferHold(data.callId);
      throw e;
    }
    if (blocked) {
      console.log(`[CALL] OFFER blocked-drop from=${ctx.claims.sub?.slice(0, 8)} → ${data.to.userId.slice(0, 8)} cid=${data.callId.slice(0, 8)}`);
      this.untrackCallSilently(client, data.callId);
      return undefined;
    }
    // The caller may have hung up inside the await window (the hangup is now
    // tracked because the session exists): never forward a stale offer.
    const liveSession = this.callSessions.get(data.callId);
    if (!liveSession || liveSession.state === 'ended') {
      console.log(`[CALL] OFFER dropped-after-gate cid=${data.callId.slice(0, 8)} state=${liveSession?.state ?? 'gone'}`);
      if (liveSession) {liveSession.offerPending = false; liveSession.heldIce = undefined;}
      return undefined;
    }
    // Round 2 / PII audit: log id-prefixes only — full userIds /
    // signal-device-ids leak account identity to anyone with
    // `docker logs` access. Eight-char prefix is enough to correlate a
    // single call across log lines without giving up the full uuid.
    console.log(`[CALL] OFFER from=${ctx.claims.sub?.slice(0, 8)}/${ctx.signalDeviceId} → ${data.to.userId.slice(0, 8)}/${data.to.deviceId} cid=${data.callId.slice(0, 8)} kind=${data.kind} sdpLen=${data.sdp?.length}`);
    dumpSdp('OFFER', data.callId, data.sdp);
    // (The session was registered at the top of the handler — B-596. It still
    // rejects duplicate callIds and pins the (caller, callee) pair for
    // authorizeCallFrame exactly as before; only the ORDER vs the privacy
    // await changed.)
    let result: ServerError | void;
    try {
      result = await this.forwardToDevice(client, data.to, false, (from): ServerCallOffer => ({
        event: 'call.offer',
        // Audit S7 — forward the caller-minted auth block verbatim. The
        // relay is intentionally a pure pass-through here; the callee
        // performs end-to-end verification via verifyCallOfferAuth.
        data:  {callId: data.callId, from, sdp: data.sdp, kind: data.kind, auth: data.auth},
      }));
    } catch (e) {
      this.clearOfferHold(data.callId);   // see the gate's catch above
      throw e;
    }
    console.log(`[CALL] OFFER result cid=${data.callId.slice(0, 8)} ${result?.event === 'error' ? 'ERR='+result.data.code : 'OK'}`);
    // A hangup that landed DURING the forward await (Edge row 17): nothing more
    // goes out for this call — no held ICE, no queued replay, no VoIP wake.
    {
      const afterForward = this.callSessions.get(data.callId);
      if (!afterForward || afterForward.state === 'ended') {
        console.log(`[CALL] OFFER hung-up-during-forward cid=${data.callId.slice(0, 8)} delivered=${!result || result.event !== 'error'}`);
        this.clearOfferHold(data.callId);
        // The in-window hangup handler stays silent (the callee may not have
        // seen the call) — but if the offer frame DID leave during the await,
        // the callee is ringing now: send the hangup it would otherwise never get.
        if (!result || result.event !== 'error') {
          void this.forwardToDevice(client, data.to, false, (from): ServerCallHangup => ({
            event: 'call.hangup',
            data:  {callId: data.callId, from, reason: 'ended'},
          })).catch(() => { /* best effort */ });
        }
        return undefined;
      }
    }
    // B-596 — release the ICE hold. Candidates held while the offer was in
    // flight go out now, BEHIND the offer frame, only if the offer actually
    // reached the callee; otherwise they are discarded (the same fate they
    // had before, emitted into an empty room — and the replayed offer path
    // never carried early candidates either).
    {
      const s = this.callSessions.get(data.callId);
      const held = s?.heldIce ?? [];
      if (s) { s.offerPending = false; s.heldIce = undefined; }
      if (held.length > 0) {
        if (!result || result.event !== 'error') {
          for (const ice of held) {
            void this.forwardToDevice(client, ice.to, false, (from): ServerCallIce => ({
              event: 'call.ice',
              data:  {callId: ice.callId, from, candidate: ice.candidate, sdpMid: ice.sdpMid, sdpMLineIndex: ice.sdpMLineIndex},
            }), {skipOnlineProbe: true});
          }
          console.log(`[CALL] ICE flushed cid=${data.callId.slice(0, 8)} n=${held.length}`);
        } else {
          console.log(`[CALL] ICE held-discarded cid=${data.callId.slice(0, 8)} n=${held.length} reason=${result.data.code}`);
        }
      }
    }
    // N-01 — ALWAYS queue the offer + fire the VoIP wake, not only when the
    // socket-room probe says peer_offline. A killed/frozen app (Doze, radio
    // asleep, OEM freeze, network switch) leaves a ZOMBIE socket in the room
    // for up to ~55s (heartbeat 30s + grace 25s); `forwardToDevice` "succeeds"
    // by emitting into that dead socket, so the old peer_offline-gated path
    // skipped BOTH the queue and the wake — the call rang nowhere and left no
    // trace. The group `sfu.ring` path already always-sends the wake and the
    // client dedupes by callId (notifee id `bravo-call-<callId>`; the
    // foreground onMessage ignores voip-wake), so mirroring it here is safe.
    const ctxFrom = (client.data as SocketContext | undefined)?.claims;
    const fromDeviceId = (client.data as SocketContext | undefined)?.signalDeviceId ?? 1;
    let queued = false;
    if (ctxFrom?.sub) {
      const from = {userId: ctxFrom.sub, deviceId: fromDeviceId};
      const pending: PendingCallOffer = {
        callId: data.callId,
        from,
        sdp:    data.sdp,
        kind:   data.kind,
        at:     Date.now(),
        // Audit S7 — persist auth so the WS-open replay delivers the SAME
        // signed block (a stripped auth would re-open the spoof window).
        auth:   data.auth,
      };
      const marker: MissedCallMarker = {callId: data.callId, from, kind: data.kind, at: pending.at};
      try {
        // Per-callId payload + index entry so concurrent callers for the same
        // offline recipient don't overwrite each other. The offer payload
        // (with SDP) stays short-lived (45s); the slim missed-marker + index
        // live long enough for a late reconnect to surface a "Missed call".
        // AUDIT-2026-08-13 (Phase-0 item 5) — ONE atomic MULTI instead of four
        // sequential awaits. A blip mid-sequence used to leave torn state: an
        // offer payload with no index entry (invisible to the reconnect
        // drain) or an index entry with no marker (phantom missed-call row).
        // All-or-nothing also collapses 4 RTTs into 1.
        const execRes = await this.redis.client.multi()
          .set(
            pendingOfferKey(data.to.userId, data.to.deviceId, data.callId),
            JSON.stringify(pending),
            'EX', 45,
          )
          .set(
            missedCallMarkerKey(data.to.userId, data.to.deviceId, data.callId),
            JSON.stringify(marker),
            'EX', MISSED_CALL_MARKER_TTL_SEC,
          )
          .sadd(
            pendingOfferIndexKey(data.to.userId, data.to.deviceId),
            data.callId,
          )
          .expire(
            pendingOfferIndexKey(data.to.userId, data.to.deviceId),
            MISSED_CALL_MARKER_TTL_SEC,
          )
          .exec();
        // rev-2 (critic catch) — exec RESOLVES with per-command [err, reply]
        // pairs; only queue-time/connection errors reject. `queued` gates the
        // peer_offline suppression below, so a partial in-EXEC failure must
        // NOT report success (the caller would sit in "calling…" over an
        // offer the drain cannot see).
        queued = Array.isArray(execRes) && execRes.length === 4 && execRes.every(([e]) => !e);
      } catch { /* best effort */ }
    }
    // §5 parity (Ranak-approved 2026-07-05, relaxes audit P1-N2): the wake
    // carries the pseudonymous sender UUID + call kind so the killed-app ring
    // labels the caller from LOCAL contacts; no cleartext name hits FCM. Full
    // call detail still arrives via the queued `call.offer` frame on reconnect.
    // P2-BR-8 — the 1:1 call.offer frame carries the media kind as `kind`
    // ('voice'|'video'); read it (with the legacy `callType` as fallback) so a
    // video call to a killed device rings as video, not always "voice".
    // Round-2 Critic nit (pre-existing race): a hangup that landed DURING the
    // Redis MULTI await must not still wake the callee's phone.
    {
      const beforeWake = this.callSessions.get(data.callId);
      if (!beforeWake || beforeWake.state === 'ended') {
        console.log(`[CALL] OFFER wake-skipped cid=${data.callId.slice(0, 8)} reason=hung-up-before-wake`);
        // Same return shape as the handler's tail (peer_offline + queued is suppressed).
        return (result && result.event === 'error' && result.data.code === 'peer_offline' && queued) ? undefined : result;
      }
    }
    void this.push.sendVoipWake(
      data.to.userId, data.callId, ctx.claims.sub, undefined,
      ((data as {kind?: string}).kind ?? (data as {callType?: string}).callType) === 'video' ? 'video' : 'voice',
    ).then(r => {
      // SRV-06 — a throttled wake means a Dozed/killed callee never rings; the
      // queued pendingOffer (45s) + missed marker are the only remaining paths.
      // Surface it in the operator-facing [CALL] stream, not just push logs.
      if (r?.reason) {
        console.warn(`[CALL] OFFER wake-throttled cid=${data.callId.slice(0, 8)} → ${data.to.userId.slice(0, 8)} reason=${r.reason}`);
      }
    }).catch(() => { /* swallow */ });
    // Hide peer_offline from the caller when we queued + pushed — their UI
    // stays in "calling…" and the call.answer arrives once the callee comes
    // online and accepts. (For an online callee `result` is undefined already.)
    if (result && result.event === 'error' && result.data.code === 'peer_offline' && queued) {
      return undefined;
    }
    return result;
  }

  @SubscribeMessage('call.answer')
  async handleCallAnswer(
    @MessageBody() data: ClientCallAnswer['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    const limited = this.rateGate(client, 'call.answer');
    if (limited) return limited;
    console.log(`[CALL] ANSWER from=${ctx.claims.sub?.slice(0, 8)}/${ctx.signalDeviceId} → ${data.to.userId.slice(0, 8)}/${data.to.deviceId} cid=${data.callId.slice(0, 8)} sdpLen=${data.sdp?.length}`);
    dumpSdp('ANSWER', data.callId, data.sdp);
    const auth = this.authorizeCallFrame(ctx.claims.sub, data.callId);
    if (auth.ok === false) {
      if ('ignore' in auth) return undefined;
      console.warn(`[CALL] ANSWER rejected cid=${data.callId.slice(0, 8)} ${auth.err.data.code}`);
      return auth.err;
    }
    // B-596 — an offer-pending session is NOT LIVE for anything but held ICE
    // (review round 1): the callee has not seen the call, so nothing may be
    // forwarded, pushed or probed on its behalf until the offer is out.
    if (auth.session.offerPending) return undefined;
    // WI-6.1 — ANSWER ARBITRATION: first answer wins, system-wide. A session
    // that is already `active` with a recorded winner means some device beat
    // this one to it; forwarding a SECOND call.answer would hand the caller
    // two competing SDP answers (state-machine corruption on a live call).
    // Idempotent success: return the same shape a clean forward returns, so
    // the losing device's client behaves exactly as if its answer landed —
    // the answered-elsewhere cancel push below is what collapses its UI.
    // The check+track run synchronously before the first await, so two
    // genuinely concurrent answers cannot both pass on one process.
    const session = auth.session;
    if (session.state === 'active' && session.answeredBy) {
      console.warn(`[CALL] ANSWER duplicate cid=${data.callId.slice(0, 8)} from=${ctx.claims.sub?.slice(0, 8)}/${ctx.signalDeviceId} — already answered by ${session.answeredBy.userId.slice(0, 8)}/${session.answeredBy.deviceId}; idempotent drop`);
      // Round 2 (critic F1) — the LOSER needs a direct verdict on the lane it
      // is already listening to. Its copy of the answered-elsewhere cancel
      // push is ignored by its own accept latch (the same client guard that
      // protects the winner), so without this frame it strands at
      // "Answering…" until a watchdog fails the call — and that watchdog's
      // hangup is authorized (the loser IS a participant) and would tombstone
      // and kill the LIVE call. Directed emit on THIS socket only: the
      // deviceRoom is shared by every device of the user (signalDeviceId=1),
      // so a room emit would reach the winner too.
      try {
        client.emit('call.hangup', {
          callId: data.callId, from: session.caller, reason: 'ended',
        });
      } catch { /* best effort — the ring-expiry backstop still bounds it */ }
      return undefined;
    }
    // Track callee's socket so disconnect on EITHER side fires bye, and
    // record the arbitration winner (WI-6.1).
    this.trackCallAnswer(client, data.callId, {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId});
    // N-02 — the callee answered, so purge THEIR queued offer + missed-marker.
    // Without this, a later reconnect drain would replay/emit a missed call for
    // a call that was actually answered.
    // WI-6.1 — clear the lane the offer was actually QUEUED on (the session's
    // pinned callee address) as well as the answering socket's own lane: if
    // they differ, the queued copy would otherwise survive on the pinned lane
    // and another device's reconnect could drain a live replay of an
    // ANSWERED call.
    void this.clearPendingCallArtifacts(ctx.claims.sub, ctx.signalDeviceId, data.callId);
    if (session.callee.userId !== ctx.claims.sub || session.callee.deviceId !== ctx.signalDeviceId) {
      void this.clearPendingCallArtifacts(session.callee.userId, session.callee.deviceId, data.callId);
    }
    // WI-6.1 — "answered elsewhere": collapse the ring on the callee's OTHER
    // devices via the existing cancel-push semantics (missed=false — an
    // answered call is not a missed call). The push fans to every registered
    // device token including the winner's; the client side preserves the
    // answering device by ignoring a ring-cancel for a call it has itself
    // accepted (fcmBootstrap handleCallCancel guard).
    void this.push.sendCallCancel(
      ctx.claims.sub, data.callId, session.caller.userId, 'voice', /*missed*/ false,
    ).catch(() => { /* best effort */ });
    const forwarded = await this.forwardToDevice(client, data.to, false, (from): ServerCallAnswer => ({
      event: 'call.answer',
      data:  {callId: data.callId, from, sdp: data.sdp},
    }));
    // SRV-02 — the caller may simply be mid-reconnect (a deploy drops both
    // sockets). Hold the answer briefly instead of dropping it: the callee
    // never re-sends, so a discarded answer strands the call at "Answering…".
    if (forwarded && forwarded.event === 'error' && forwarded.data.code === 'peer_offline') {
      this.queuePendingAnswer(data.to, {
        callId: data.callId,
        from:   {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId},
        sdp:    data.sdp,
      });
      return undefined;
    }
    return forwarded;
  }

  /**
   * N-02 — remove a queued offer's Redis artifacts (offer payload, missed
   * marker, index membership) for one (user, device, callId). Used when a call
   * is answered or ended so nothing stale replays on the next reconnect.
   */
  private async clearPendingCallArtifacts(
    userId: string,
    deviceId: number,
    callId: string,
    opts: {keepMarker?: boolean} = {},
  ): Promise<void> {
    try {
      // WI-6.3 — ONE atomic MULTI, mirroring the writer (Phase-0 item 5 /
      // D-3). The old three sequential awaits could fail between commands and
      // leave marker+index alive with no payload — which the reconnect drain
      // then classifies as a MISSED call for a call that was ANSWERED.
      // P1-15 / P2-13 — the reconnect `call.missed` drain enumerates ONLY the
      // pending-offer index, so the marker DEL + SREM stay INSIDE the
      // keep-marker guard: when we keep the missed-marker (caller gave up on
      // an unanswered call) we must ALSO keep the index entry, else the
      // surviving marker is unreachable and `call.missed` never fires on the
      // callee's next connect.
      const chain = this.redis.client.multi()
        .del(pendingOfferKey(userId, deviceId, callId));
      if (!opts.keepMarker) {
        chain
          .del(missedCallMarkerKey(userId, deviceId, callId))
          .srem(pendingOfferIndexKey(userId, deviceId), callId);
      }
      const res = await chain.exec();
      // ioredis exec RESOLVES with per-command [err, reply] pairs; only
      // queue-time/connection errors reject. A partial in-EXEC failure must be
      // VISIBLE — it is exactly the torn state this MULTI exists to prevent.
      if (!Array.isArray(res) || res.some(([e]) => !!e)) {
        this.logger.warn(`[CALL] clear-artifacts MULTI partial failure cid=${callId.slice(0, 8)} → ${userId.slice(0, 8)}/${deviceId}`);
      }
    } catch { /* best effort */ }
  }

  @SubscribeMessage('call.ice')
  async handleCallIce(
    @MessageBody() data: ClientCallIce['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    const limited = this.rateGate(client, 'call.ice');
    if (limited) return limited;
    // Round 2 / PII audit: do NOT log the candidate body — even an 80
    // char slice usually contains the IP + port. The mid + idx are
    // enough to correlate a candidate frame with the SDP m-line for
    // diagnosis. Length is a useful signal that the candidate isn't
    // empty without leaking the network topology.
    const candLen = (data.candidate ?? '').length;
    console.log(`[CALL] ICE from=${ctx.claims.sub?.slice(0, 8)}/${ctx.signalDeviceId} → ${data.to.userId.slice(0, 8)}/${data.to.deviceId} cid=${data.callId.slice(0, 8)} mid=${data.sdpMid} idx=${data.sdpMLineIndex} candLen=${candLen}`);
    const auth = this.authorizeCallFrame(ctx.claims.sub, data.callId);
    if (auth.ok === false) {
      if ('ignore' in auth) {
        // Audit Step 0 (B-596) — make the silent drop COUNTABLE. `no_session`
        // is the B-273/B-596 signature (candidate outran its offer's session);
        // `ended` is the benign late-ICE case. Ids only.
        const s = this.callSessions.get(data.callId);
        console.warn(`[CALL] ICE ignored cid=${data.callId.slice(0, 8)} reason=${s ? s.state : 'no_session'}`);
        return undefined;
      }
      return auth.err;
    }
    // AUDIT-2026-08-13 D-4 — skip the per-frame online probe. Trickle ICE
    // ships dozens of frames per call setup and `deviceIsOnline` costs a
    // cluster `fetchSockets` round-trip EACH; a candidate emitted into an
    // empty room is a no-op, and ICE loss is self-healing (more candidates
    // follow; TURN absorbs the tail). Frames stay non-volatile so they are
    // not shed under backpressure.
    // WHO CONSUMED THE REMOVED ERROR (critic-verified, rev-2 correction of an
    // earlier wrong "fire-and-forget, nobody" claim): Nest's socket.io
    // adapter emits a handler's return as a FRAME (io-adapter.js
    // `if (response.event) socket.emit(...)`), so each ICE peer_offline
    // reached productionRuntime's 'error' case → gatewayErrorPolicy
    // (AUTO_CLEAR_CODES) → a 3.5s toast — one PER CANDIDATE to an offline
    // callee, defeating handleCallOffer's own deliberate peer_offline
    // suppression. Removing the probe also removes that toast storm.
    // B-596 — the offer for this session has not been forwarded yet: HOLD the
    // candidate (bounded, drop-oldest — the same cap the client uses) and let
    // handleCallOffer flush it behind the offer frame. Only the caller can be
    // here (the callee has not seen the call; third parties fail auth above).
    if (auth.session.offerPending) {
      const held = auth.session.heldIce ?? (auth.session.heldIce = []);
      if (held.length >= MessengerGateway.MAX_HELD_ICE) {held.shift();}
      held.push(data);
      return undefined;
    }
    return this.forwardToDevice(client, data.to, false, (from): ServerCallIce => ({
      event: 'call.ice',
      data:  {
        callId: data.callId, from,
        candidate: data.candidate,
        sdpMid: data.sdpMid, sdpMLineIndex: data.sdpMLineIndex,
      },
    }), {skipOnlineProbe: true});
  }

  @SubscribeMessage('call.hangup')
  async handleCallHangup(
    @MessageBody() data: ClientCallHangup['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    const limited = this.rateGate(client, 'call.hangup');
    if (limited) return limited;
    console.log(`[CALL] HANGUP from=${ctx.claims.sub?.slice(0, 8)}/${ctx.signalDeviceId} → ${data.to.userId.slice(0, 8)}/${data.to.deviceId} cid=${data.callId.slice(0, 8)} reason=${data.reason}`);
    const auth = this.authorizeCallFrame(ctx.claims.sub, data.callId);
    if (auth.ok === false) {
      if ('ignore' in auth) return undefined; // duplicate / late hangup — ack silently
      console.warn(`[CALL] HANGUP rejected cid=${data.callId.slice(0, 8)} ${auth.err.data.code} (third-party hangup attempt blocked)`);
      return auth.err;
    }
    // B-596 — a hangup INSIDE the offer's gate window: the caller gave up
    // before the callee ever saw the call. End the session (handleCallOffer
    // then drops the parked offer + held ICE) but forward NOTHING, push
    // NOTHING, probe NOTHING — the callee may be a blocked pair and must learn
    // nothing; the caller learns nothing about the callee either.
    if (auth.session.offerPending) {
      this.trackCallEnd(data.callId);
      console.log(`[CALL] HANGUP in-gate-window cid=${data.callId.slice(0, 8)} — ended silently`);
      return undefined;
    }
    // N-02 — was the call still ringing (never answered)? Read BEFORE
    // trackCallEnd flips it. `isCaller` distinguishes a caller giving up (the
    // callee, possibly a killed device, is the one still "ringing") from a
    // callee declining (the caller isn't ringing and never "missed" anything).
    const pre = this.callSessions.get(data.callId);
    const wasRinging = pre?.state === 'ringing';
    const isCaller = !!pre && pre.caller.userId === ctx.claims.sub;
    // Mark ended BEFORE forwarding so a duplicate hangup frame in
    // flight is dropped at the auth gate (not relayed).
    this.trackCallEnd(data.callId);
    // N-02 — kill the ghost ring: purge the callee's queued offer so a reconnect
    // within 45s can't replay a call the caller already abandoned. Keep the
    // missed-marker only when the caller gave up on an unanswered call (so the
    // callee still learns they missed it); drop it otherwise (answered, or a
    // callee-initiated decline is not a "missed call").
    const callerGaveUp = wasRinging && isCaller;
    // P1-14 — the queued offer/marker/index were keyed on the CALLEE at offer
    // time (handleCallOffer used data.to = the ringing callee). Clear THOSE
    // keys regardless of who hung up: on a callee-decline, this frame's
    // `data.to` is the CALLER, so using it would leave the callee's own
    // missed-marker + index entry alive → a phantom "Missed call" (and, within
    // 45s, a ghost re-ring) on the callee's next reconnect for a call they
    // explicitly declined.
    const ringingCallee = pre ? pre.callee : {userId: data.to.userId, deviceId: data.to.deviceId};
    void this.clearPendingCallArtifacts(
      ringingCallee.userId, ringingCallee.deviceId, data.callId, {keepMarker: callerGaveUp},
    );
    // N-02 — no push-based ring cancel existed: a Doze-deferred wake could ring
    // for up to 45s AFTER the caller hung up ("notification only after the
    // call"). When the caller gives up on an unanswered call, send a data-only
    // cancel push so a killed device dismisses the ring and shows a Missed call.
    if (callerGaveUp) {
      // The call session doesn't retain the media kind; the missed-call label
      // ('Voice'/'Video') is cosmetic, so default to voice. Target the ringing
      // callee (P1-14) — the device(s) still ringing from the VoIP wake.
      void this.push.sendCallCancel(
        ringingCallee.userId, data.callId, ctx.claims.sub, 'voice', /*missed*/ true,
      ).catch(() => { /* swallow — best effort */ });
    } else if (wasRinging && !isCaller) {
      // KO-2 (B-566) — the CALLEE declined over WS: their OTHER devices are
      // still ringing from the VoIP wake and used to ring out the full 45 s
      // (only the HTTP decline lane collapsed them). Same answered-elsewhere
      // cancel semantics as declineCallViaHttp's 1:1 branch: missed=false —
      // an explicit decline is not a missed call — and the decliner's own
      // device is protected by the client's post-ring guards.
      void this.push.sendCallCancel(
        ringingCallee.userId, data.callId,
        pre ? pre.caller.userId : data.to.userId, 'voice', /*missed*/ false,
      ).catch(() => { /* swallow — best effort */ });
    }
    return this.forwardToDevice(client, data.to, false, (from): ServerCallHangup => ({
      event: 'call.hangup',
      data:  {callId: data.callId, from, reason: data.reason},
    }));
  }

  /**
   * WI-6.6 — 1:1 reconcile query: "is callId X still alive?". The SFU has
   * `sfu.producers` as its reconcile primitive; the 1:1 lane had nothing, so
   * a client that missed a hangup (Doze, deploy, dropped frame) waited out
   * its own timers with a zombie call UI. Read-only; answered over the
   * socket.io ACK (event-less return — SFU-01), so the reply reaches only
   * the asking socket.
   *
   * Anti-probing: a caller who is NOT a participant of a live session gets
   * exactly the same answer as for a nonexistent callId — `unknown` — so the
   * endpoint is not an oracle for "does this callId exist" (and `unknown` is
   * also what the legitimate owner needs to hard-end after a relay restart).
   */
  @SubscribeMessage('call.sync')
  async handleCallSync(
    @MessageBody() data: {callId?: unknown},
    @ConnectedSocket() client: Socket,
  ): Promise<{ok: true; state: 'ringing' | 'active' | 'ended' | 'unknown'} | {ok: false; data: {code: string; message: string}}> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return sfuError('unauthenticated');
    // Event-less rate refusal so the client's emitWithAck gets a real ack
    // instead of a stray 'error' frame + 15s ack_timeout (SFU-01).
    if (this.rateGate(client, 'call.sync')) return sfuError('rate_limited');
    const callId = typeof data?.callId === 'string' ? data.callId : '';
    if (!callId || callId.length > 128) return sfuError('bad_request');
    this.gcCallTombstones();
    const session = this.callSessions.get(callId);
    if (session) {
      if (session.caller.userId !== ctx.claims.sub && session.callee.userId !== ctx.claims.sub) {
        return {ok: true, state: 'unknown'};
      }
      return {ok: true, state: session.state};
    }
    // KO-1 (B-566) — session miss is NOT proof the call is dead: after a
    // relay restart the durable rescue lanes (queued offer / FIX-07 queued
    // answer) rehydrate it on the ASKER's reconnect drain, and the probe
    // fires from the same 'connected' edge — answering 'unknown' here
    // hard-ends the call milliseconds before its own rescue lands. Check
    // the asker's OWN queued lanes (keys are namespaced by the
    // authenticated sub, so this widens no oracle: you can only ever see
    // your own pending state). A queued ANSWER means the callee picked up
    // → 'active'; a still-live queued OFFER means it is still ringing.
    try {
      const [offerRaw, answerRaw] = await this.redis.client.mget(
        pendingOfferKey(ctx.claims.sub, ctx.signalDeviceId, callId),
        pendingAnswerKey(ctx.claims.sub, ctx.signalDeviceId, callId),
      );
      if (answerRaw) return {ok: true, state: 'active'};
      if (offerRaw) {
        const parsed = JSON.parse(offerRaw) as {at?: number};
        if (typeof parsed.at === 'number' && (Date.now() - parsed.at) / 1000 <= 45) {
          return {ok: true, state: 'ringing'};
        }
      }
    } catch { /* Redis blip — fall through to the pre-KO-1 answer */ }
    return {ok: true, state: 'unknown'};
  }

  /**
   * BS-021 — pure relay for the peer-mute / peer-camera-off advisory.
   * Receiver flips a "Camera off" / "Mic off" placeholder in the
   * remote tile so the user can distinguish an intentional disable
   * from a frozen RTP feed. Server never persists this.
   */
  @SubscribeMessage('call.media-state')
  handleCallMediaState(
    @MessageBody() data: ClientCallMediaState['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> | undefined {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return Promise.resolve(authMissing());
    const limited = this.rateGate(client, 'call.media-state');
    if (limited) return Promise.resolve(limited);
    console.log(`[CALL] MEDIA-STATE from=${ctx.claims.sub?.slice(0, 8)}/${ctx.signalDeviceId} → ${data.to.userId.slice(0, 8)}/${data.to.deviceId} cid=${data.callId.slice(0, 8)} cam=${data.cameraOff ? 'off' : 'on'} mic=${data.micOff ? 'off' : 'on'}`);
    // Round 7 / WebRTC audit fix W1 — every other call.* handler
    // verifies the sender is actually a participant of the named call;
    // this one was skipping the check, so any authed user could spoof
    // a media-state advisory for someone else's callId and flip the
    // recipient's "Camera off" placeholder. Adding the same gate as
    // call.answer/ice/hangup.
    const auth = this.authorizeCallFrame(ctx.claims.sub, data.callId);
    if (auth.ok === false) {
      if ('ignore' in auth) return undefined;
      return Promise.resolve(auth.err);
    }
    if (auth.session.offerPending) return undefined; // B-596 — not live until the offer is out
    return this.forwardToDevice(client, data.to, false, (from): ServerCallMediaState => ({
      event: 'call.media-state',
      data:  {callId: data.callId, from, cameraOff: data.cameraOff, micOff: data.micOff},
    }));
  }

  /**
   * Mid-call SDP renegotiation — voice→video upgrade. Pure relay just
   * like call.offer/answer; no offline queueing or VoIP push because
   * the peer is mid-call and therefore by definition online (the WS
   * has been carrying ICE keepalives between them up to this moment).
   * If `forwardToDevice` returns peer_offline we surface it back to
   * the initiator so its watchdog can roll back the half-applied
   * upgrade and the call stays voice-only.
   *
   * dumpSdp gated behind the same BRAVO_DUMP_SDP env-var as the
   * initial offer/answer so we don't leak SDP into normal docker logs.
   */
  @SubscribeMessage('call.reoffer')
  handleCallReOffer(
    @MessageBody() data: ClientCallReOffer['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> | undefined {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return Promise.resolve(authMissing());
    const limited = this.rateGate(client, 'call.reoffer');
    if (limited) return Promise.resolve(limited);
    console.log(`[CALL] RE-OFFER from=${ctx.claims.sub?.slice(0, 8)}/${ctx.signalDeviceId} → ${data.to.userId.slice(0, 8)}/${data.to.deviceId} cid=${data.callId.slice(0, 8)} sdpLen=${data.sdp?.length}`);
    dumpSdp('RE-OFFER', data.callId, data.sdp);
    // Round 7 / WebRTC audit fix W1 — without this check a third party
    // who guesses a callId can ship a malicious renegotiation SDP that
    // the receiver's setRemoteDescription accepts, breaking the active
    // call by negotiating bogus codecs / media lines.
    const auth = this.authorizeCallFrame(ctx.claims.sub, data.callId);
    if (auth.ok === false) {
      if ('ignore' in auth) return undefined;
      return Promise.resolve(auth.err);
    }
    if (auth.session.offerPending) return undefined; // B-596 — not live until the offer is out
    return this.forwardToDevice(client, data.to, false, (from): ServerCallReOffer => ({
      event: 'call.reoffer',
      data:  {callId: data.callId, from, sdp: data.sdp},
    }));
  }

  @SubscribeMessage('call.reanswer')
  handleCallReAnswer(
    @MessageBody() data: ClientCallReAnswer['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> | undefined {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return Promise.resolve(authMissing());
    const limited = this.rateGate(client, 'call.reanswer');
    if (limited) return Promise.resolve(limited);
    console.log(`[CALL] RE-ANSWER from=${ctx.claims.sub?.slice(0, 8)}/${ctx.signalDeviceId} → ${data.to.userId.slice(0, 8)}/${data.to.deviceId} cid=${data.callId.slice(0, 8)} sdpLen=${data.sdp?.length}`);
    dumpSdp('RE-ANSWER', data.callId, data.sdp);
    // Round 7 / WebRTC audit fix W1 — same rationale as call.reoffer
    // above: confirm the sender is a participant before forwarding the
    // SDP to the peer.
    const auth = this.authorizeCallFrame(ctx.claims.sub, data.callId);
    if (auth.ok === false) {
      if ('ignore' in auth) return undefined;
      return Promise.resolve(auth.err);
    }
    if (auth.session.offerPending) return undefined; // B-596 — not live until the offer is out
    return this.forwardToDevice(client, data.to, false, (from): ServerCallReAnswer => ({
      event: 'call.reanswer',
      data:  {callId: data.callId, from, sdp: data.sdp},
    }));
  }

  // ─── SFU group calls (M9) ─────────────────────────────────────────
  //
  // Frames flow client → gateway → SfuService → mediasoup. The gateway
  // returns frame ack payloads inline (socket.io ack semantics) so the
  // mediasoup-client `Device` callbacks can chain transport.connect /
  // produce / consume without separate request/response plumbing.

  @SubscribeMessage('sfu.join')
  async handleSfuJoin(
    @MessageBody() data: ClientSfuJoin['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ReturnType<SfuService['joinRoom']> | {ok: false; data: {code: string; message: string}}> {
    // Audit SFU-07 — rate-limit joins to blunt slot-exhaustion / rejoin-spam by
    // a removed member who knows the conversationId. Event-less sfuError so it
    // rides the ack (SFU-01).
    if (this.rateGate(client, 'sfu.join')) return sfuError('rate_limited');
    const ctx = client.data as SocketContext;
    // Audit Step 0 — handler duration from the FIRST line (review round 2: the
    // Redis rate counter below is part of what the client waits for).
    const joinT0 = Date.now();
    // MEDIUM-3 — cluster-global per-user join cap. The per-socket limit above
    // is bypassed by a removed member reconnecting fresh sockets across pods to
    // spam joins; 30 joins/min/user is generous for legit reconnect/rejoin.
    if (await this.userRateExceeded(ctx.claims.sub, 'sfujoin', 30)) {
      return sfuError('rate_limited');
    }
    // Audit P0-C2 / row #5 — verify the per-recipient HMAC token before
    // admitting. Token absent: probe whether the server has
    // SFU_ROOM_TOKEN_SECRET configured by attempting to mint a throw-
    // away. If issue() succeeds the secret IS set → tokenless join is
    // a hard reject. If issue() throws (secret unset, dev/legacy)
    // admit without verification.
    if (data.roomToken) {
      const verdict = this.roomToken.verify(data.roomToken, data.roomId, ctx.claims.sub);
      if (!verdict.ok) {
        this.logger.warn(`[SFU] join rejected uid=${ctx.claims.sub?.slice(0, 8)} rid=${data.roomId.slice(0, 8)} reason=${verdict.reason}`);
        return sfuError(`room_token_${verdict.reason}`, 'room_token_invalid');
      }
    } else {
      try {
        this.roomToken.issue('probe', 'probe', 1);
        this.logger.warn(`[SFU] join rejected uid=${ctx.claims.sub?.slice(0, 8)} rid=${data.roomId.slice(0, 8)} reason=missing_token`);
        return sfuError('room_token_required', 'room_token_required');
      } catch {
        // P3-P-1 — issue() throwing means SFU_ROOM_TOKEN_SECRET is unset. FAIL
        // CLOSED in production: a prod box missing the secret must NOT run the
        // whole SFU plane in open-admit mode with zero boot signal. In non-prod
        // we still admit (dev/test), but LOUDLY once so the gap is visible.
        if (process.env.NODE_ENV === 'production') {
          this.logger.error(`[SFU] join rejected uid=${ctx.claims.sub?.slice(0, 8)} rid=${data.roomId.slice(0, 8)} reason=token_secret_unset_prod`);
          return sfuError('room_token_required', 'room_token_required');
        }
        if (!this.tokenlessSfuAdmitLogged) {
          this.tokenlessSfuAdmitLogged = true;
          this.logger.error('[SFU] admitting joins WITHOUT token verification — SFU_ROOM_TOKEN_SECRET is unset (non-prod only). Set it to enforce per-recipient room-access tokens.');
        }
      }
    }
    try {
      const joined = await this.sfu.joinRoom(data.roomId, ctx.claims.sub);
      // Audit Step 0 — handler duration (ids only); pairs with the client's
      // [CALLLAT] join:sent → join:ack delta to split RTT from server work.
      this.logger.log(`[SFU] join.ack rid=${data.roomId.slice(0, 8)} uid=${ctx.claims.sub?.slice(0, 8)} ms=${Date.now() - joinT0}`);
      // Track the participant tag so server-pushed sfu.* frames find
      // the socket, and tear down on disconnect.
      this.sfuTagToSocket.set(joined.participantTag, client);
      let tags = this.sfuSocketTags.get(client);
      if (!tags) { tags = new Set(); this.sfuSocketTags.set(client, tags); }
      tags.add(joined.participantTag);
      // Join the socket.io rooms the multi-pod fanout broadcasts to
      // (see bindFanout). `sfu:<roomId>` for room-wide frames,
      // `sfutag:<tag>` for self-addressed ones. Leaving happens in
      // handleDisconnect / handleSfuLeave / kick via leaveSfuRooms.
      void client.join(sfuRoom(data.roomId));
      void client.join(sfuTagRoom(joined.participantTag));
      // B-568 — a JOIN is an answer: clear the joiner's own queued ring
      // artifacts (the 1:1 lane has had exactly this since N-02/WI-6.1; the
      // group lane never did). Without it the days-long missed marker
      // outlives the 45 s payload, and ANY later reconnect drains a phantom
      // "Missed group call" for a call the user answered — possibly while
      // they are still on it. Keys are namespaced by the authenticated sub.
      // And collapse the joiner's OTHER devices' rings (answered-elsewhere,
      // missed=false), same semantics as the decline lane's WI-6.2 push.
      // Skipped for the HOST's own join: a host is never rung, so their
      // boot-join would fan a pure no-op multicast on every call start.
      void this.clearPendingGroupRingArtifacts(ctx.claims.sub, data.roomId);
      const joinHost = this.sfu.hostOf(data.roomId);
      if (joinHost !== ctx.claims.sub) {
        void this.push.sendCallCancel(
          ctx.claims.sub, data.roomId, joinHost ?? ctx.claims.sub, 'voice', /*missed*/ false,
        ).catch(() => { /* best effort */ });
      }
      return joined;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'sfu_join_failed';
      return sfuError(message, 'sfu_join_failed');
    }
  }

  @SubscribeMessage('sfu.transport.connect')
  async handleSfuConnect(
    @MessageBody() data: ClientSfuConnectTransport['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{ok: true} | {ok: false; data: {code: string; message: string}}> {
    const tag = this.firstTagFor(client, data.roomId);
    if (!tag) return sfuError('no_active_participant');
    const t0 = Date.now();
    try {
      await this.sfu.connectTransport(tag, data.transportId, data.dtlsParameters as never);
      this.logger.log(`[SFU] transport.connect rid=${data.roomId.slice(0, 8)} tag=${tag.slice(0, 8)} ms=${Date.now() - t0}`);
      return {ok: true};
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_connect_failed');
    }
  }

  /**
   * Weak-network ICE restart. The client's mediasoup-client transport
   * reports `connectionstatechange === 'disconnected'` (e.g. Wi-Fi ↔
   * cellular handover) and asks the server for fresh iceParameters.
   * mediasoup's `transport.restartIce()` reallocates ICE ufrag/pwd
   * without tearing the WebRtcTransport down — producers and consumers
   * survive, DTLS context is preserved, and media resumes once the
   * client applies the new parameters and re-gathers candidates.
   */
  @SubscribeMessage('sfu.transport.restartIce')
  async handleSfuRestartIce(
    @MessageBody() data: {roomId: string; transportId: string},
    @ConnectedSocket() client: Socket,
  ): Promise<{iceParameters: unknown} | {ok: false; data: {code: string; message: string}}> {
    const tag = this.firstTagFor(client, data.roomId);
    if (!tag) return sfuError('no_active_participant');
    try {
      const iceParameters = await this.sfu.restartTransportIce(tag, data.transportId);
      return {iceParameters};
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_restart_ice_failed');
    }
  }

  @SubscribeMessage('sfu.produce')
  async handleSfuProduce(
    @MessageBody() data: ClientSfuProduce['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{producerId: string} | {ok: false; data: {code: string; message: string}}> {
    const tag = this.firstTagFor(client, data.roomId);
    if (!tag) return sfuError('no_active_participant');
    const t0 = Date.now();
    try {
      const produced = await this.sfu.produce(tag, data.transportId, data.kind, data.rtpParameters as never);
      this.logger.log(`[SFU] produce rid=${data.roomId.slice(0, 8)} tag=${tag.slice(0, 8)} kind=${data.kind} ms=${Date.now() - t0}`);
      return produced;
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_produce_failed');
    }
  }

  @SubscribeMessage('sfu.consume')
  async handleSfuConsume(
    @MessageBody() data: ClientSfuConsume['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<Awaited<ReturnType<SfuService['consume']>> | {ok: false; data: {code: string; message: string}}> {
    const tag = this.firstTagFor(client, data.roomId);
    if (!tag) return sfuError('no_active_participant');
    const t0 = Date.now();
    try {
      const consumed = await this.sfu.consume(tag, data.transportId, data.producerId, data.rtpCapabilities as never);
      this.logger.log(`[SFU] consume rid=${data.roomId.slice(0, 8)} tag=${tag.slice(0, 8)} kind=${consumed.kind} ms=${Date.now() - t0}`);
      return consumed;
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_consume_failed');
    }
  }

  @SubscribeMessage('sfu.consumer.resume')
  async handleSfuConsumerResume(
    @MessageBody() data: ClientSfuConsumerResume['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{ok: true} | {ok: false; data: {code: string; message: string}}> {
    const tag = this.firstTagFor(client, data.roomId);
    if (!tag) return sfuError('no_active_participant');
    const t0 = Date.now();
    try {
      await this.sfu.resumeConsumer(tag, data.consumerId);
      this.logger.log(`[SFU] consumer.resume rid=${data.roomId.slice(0, 8)} tag=${tag.slice(0, 8)} ms=${Date.now() - t0}`);
      return {ok: true};
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_resume_failed');
    }
  }

  // Recipient pauses their OWN consumer — offscreen-tile bandwidth
  // control. Ownership + the no-fanout rationale live in
  // SfuService.pauseConsumer; sfu.consumer.resume is the inverse.
  @SubscribeMessage('sfu.consumer.pause')
  async handleSfuConsumerPause(
    @MessageBody() data: ClientSfuConsumerPause['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{ok: true} | {ok: false; data: {code: string; message: string}}> {
    const tag = this.firstTagFor(client, data.roomId);
    if (!tag) return sfuError('no_active_participant');
    try {
      await this.sfu.pauseConsumer(tag, data.consumerId);
      return {ok: true};
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_pause_failed');
    }
  }

  // Owner toggles their own camera/mic producer. Ownership + the S6
  // host-mute guard live in SfuService.setProducerPaused; the fan-out
  // (sfu.producer-paused / -resumed) lets peers swap the frozen tile
  // for the avatar placeholder deterministically.
  @SubscribeMessage('sfu.producer.pause')
  async handleSfuProducerPause(
    @MessageBody() data: ClientSfuProducerPause['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{ok: true} | {ok: false; data: {code: string; message: string}}> {
    // Audit SFU-09 — enforce the (previously-dead) pause/resume rate budget.
    // Convert the limiter's event-shaped result into the event-LESS sfuError so
    // it still rides the ack (SFU-01) rather than becoming a blind timeout.
    if (this.rateGate(client, 'sfu.producer.pause')) return sfuError('rate_limited');
    const tag = this.firstTagFor(client, data.roomId);
    if (!tag) return sfuError('no_active_participant');
    try {
      await this.sfu.setProducerPaused(tag, data.producerId, true);
      return {ok: true};
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_producer_pause_failed');
    }
  }

  @SubscribeMessage('sfu.producer.resume')
  async handleSfuProducerResume(
    @MessageBody() data: ClientSfuProducerResume['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{ok: true} | {ok: false; data: {code: string; message: string}}> {
    // Audit SFU-09 — enforce the resume rate budget (event-less sfuError).
    if (this.rateGate(client, 'sfu.producer.resume')) return sfuError('rate_limited');
    const tag = this.firstTagFor(client, data.roomId);
    if (!tag) return sfuError('no_active_participant');
    try {
      await this.sfu.setProducerPaused(tag, data.producerId, false);
      return {ok: true};
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_producer_resume_failed');
    }
  }

  /**
   * Reconcile query — client diffs this against its live consumers and
   * consumes any producer it's missing (dropped/missed `sfu.new-producer`
   * frame, or a transiently-failed consume). Read-only; the SFU validates
   * the caller is in the room.
   */
  @SubscribeMessage('sfu.producers')
  handleSfuListProducers(
    @MessageBody() data: {roomId: string},
    @ConnectedSocket() client: Socket,
  ): {producers: Array<{producerId: string; participantTag: string; kind: 'audio' | 'video'; paused: boolean}>} | {ok: false; data: {code: string; message: string}} {
    const tag = this.firstTagFor(client, data.roomId);
    if (!tag) return sfuError('no_active_participant');
    try {
      return {producers: this.sfu.listProducers(tag, data.roomId)};
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_list_producers_failed');
    }
  }

  /**
   * Is this user in the room AND actually reachable there right now?
   *
   * Used to decide whether ringing them would be redundant. `isParticipantUser`
   * alone is not enough: on a socket disconnect the mediasoup participant is
   * deliberately held for SFU_LEAVE_GRACE_MS so a quick reconnect keeps media
   * alive (SFU-04), so for those 10 seconds someone whose phone has just
   * dropped off Wi-Fi still reads as "in the room". Filtering on that would
   * make a host's Re-ring or Add return `{ok: true}` while the member is
   * never rung — the silent-success shape B-336 exists to prevent, and the
   * single worst failure mode in this subsystem.
   *
   * A tag sitting in the grace map has had its socket mapping dropped
   * already, so it cannot receive a frame; treat it as absent and ring.
   */
  private isReachableParticipant(roomId: string, userId: string): boolean {
    if (!this.sfu.isParticipantUser(roomId, userId)) return false;
    for (const tag of this.sfuLeaveGrace.keys()) {
      const info = this.sfu.resolveParticipantUser(tag);
      if (info && info.roomId === roomId && info.userId === userId) return false;
    }
    return true;
  }

  @SubscribeMessage('sfu.leave')
  async handleSfuLeave(
    @MessageBody() data: ClientSfuLeave['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{ok: true}> {
    const tags = this.sfuSocketTags.get(client);
    /**
     * Orphan reap — the caller is leaving a room it never JOINED.
     *
     * A group-call boot creates the room (POST /sfu/rooms) at step 1 and
     * only joins at step 3. Any failure in between — media acquisition,
     * the FrameCryptor refusal, a key-wait timeout — leaves a room whose
     * `hostUserId` is this user and whose participant set is empty. Nothing
     * reaped it: `sfu.leave` matches no tag, and the ring-cancel path is
     * gated on a ring that was never sent. The server then advertises that
     * corpse to every other member of the conversation for the whole
     * fresh-room grace, so the next person to tap Call was handed a dead
     * room to "join".
     *
     * This MUST run before the `!tags` early return below: a boot that died
     * before joining has no tags on the socket at all, which is precisely
     * the case being fixed. Authority is unchanged —
     * `endRoomIfEmptyByHost` independently refuses unless the caller IS the
     * recorded host AND the room is genuinely empty, so this can never reap
     * a live room or one belonging to someone else.
     */
    const leaveCtx = client.data as SocketContext | undefined;
    const leaveCallerId = leaveCtx?.claims?.sub;
    if (data?.roomId && leaveCallerId) {
      const hasTagHere = tags
        ? Array.from(tags).some(t => this.sfu.resolveParticipantUser(t)?.roomId === data.roomId)
        : false;
      if (!hasTagHere && this.sfu.endRoomIfEmptyByHost(data.roomId, leaveCallerId)) {
        this.logger.log(`[SFU] orphan room reaped rid=${data.roomId.slice(0, 8)} by=${leaveCallerId.slice(0, 8)}`);
      }
    }
    if (!tags) return {ok: true};
    // Filter by roomId — leaving room A must NOT tear down a tag that
    // belongs to room B. Previously this handler iterated EVERY tag on
    // the socket; on rapid leave-then-join (incoming-call accept mid-
    // call) the new room's tag was killed before it ever started
    // routing media. If the client didn't send roomId (older clients,
    // or roomId is missing in the schema), fall back to the all-tags
    // semantics so no leak — a missing roomId is rare enough that the
    // wrong-room-killed risk is acceptable.
    const targetRoomId = data?.roomId;
    const tagsToLeave: string[] = [];
    if (targetRoomId) {
      for (const tag of tags) {
        const info = this.sfu.resolveParticipantUser(tag);
        if (info && info.roomId === targetRoomId) tagsToLeave.push(tag);
      }
    } else {
      tagsToLeave.push(...tags);
    }
    for (const tag of tagsToLeave) {
      // L7 — this is the INTENTIONAL leave (the user pressed End/Leave; the
      // socket stays connected). A host ending here terminates the room for
      // everyone, per WhatsApp/Zoom semantics. A host's transient WS DROP goes
      // through handleDisconnect (no flag) and does NOT kill the room.
      const {removedTags} = await this.sfu.leaveRoom(tag, {hostTerminatesRoom: true})
        .catch(() => ({removedTags: [tag]}));
      // Audit SFU-06 — purge the gateway maps for EVERY torn-down tag, not just
      // our own. On a host-terminate leaveRoom also closes the survivors; their
      // sfuTagToSocket entries (a STRONG Map) and sfuSocketTags sets used to
      // leak until each survivor's own socket disconnected, and firstTagFor
      // could then resolve a dead tag for a later moderation action.
      for (const rt of removedTags) {
        const survSock = this.sfuTagToSocket.get(rt);
        this.sfuTagToSocket.delete(rt);
        if (survSock) {
          this.sfuSocketTags.get(survSock)?.delete(rt);
          void survSock.leave(sfuTagRoom(rt));
        }
      }
      tags.delete(tag);
      // Leave the fanout rooms so post-leave broadcasts don't reach this
      // socket. The socket stays connected (only this SFU session ended),
      // so unlike handleDisconnect we must leave explicitly.
      void client.leave(sfuTagRoom(tag));
    }
    if (targetRoomId) void client.leave(sfuRoom(targetRoomId));
    return {ok: true};
  }

  // ─── Group call ringing ──────────────────────────────────────────
  //
  // The caller has already POSTed /sfu/rooms and joined the room. This
  // handler takes the explicit recipient list (server doesn't see group
  // membership — groups are E2E) and fans `sfu.ring.incoming` to each
  // recipient's userRoom + fires a VoIP push wake so offline devices ring.

  @SubscribeMessage('sfu.ring')
  async handleSfuRing(
    @MessageBody() data: ClientSfuRing['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{ok: true; ringId?: string} | {ok: false; data: {code: string; message: string}}> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return sfuError('unauthenticated');
    const callerId = ctx.claims.sub;

    // P2-3 — meter the in-app group ring (was unmetered): a host could spam
    // `sfu.ring` to online victims' IncomingGroupCallScreen. Per-socket bucket
    // plus a cluster-global per-user cap (mirrors sfu.join) so multi-socket /
    // multi-pod amplification is also blunted.
    if (this.rateGate(client, 'sfu.ring')) return sfuError('rate_limited');
    if (await this.userRateExceeded(callerId, 'sfuring', 20)) return sfuError('rate_limited');

    // Audit row #5 (C3) — ring authority. Originally host-only: without a
    // gate, any authed user could ship `sfu.ring` for any roomId they
    // guessed or saw in a prior frame and spam-ring arbitrary
    // `recipientUserIds[]`. B-334 widens it to host OR **current room
    // participant** — founder repro 2026-07-29: two in-call members pressed
    // "Add" and were refused, so the invitee never rang. The anchor is
    // preserved: a participant only exists because the host's ring admitted
    // them via a per-recipient HMAC room token (sfu.join verifies it), so
    // ring authority still descends from "the person who POSTed /sfu/rooms".
    // Unknown roomId still returns `not_host` (forbidden) so attackers
    // can't enumerate hostless rooms; rate caps above are unchanged.
    const host = this.sfu.hostOf(data.roomId);
    const mayRing = !!host && (host === callerId || this.sfu.isParticipantUser(data.roomId, callerId));
    if (!mayRing) {
      this.logger.warn(`[SFU] ring rejected uid=${callerId.slice(0, 8)} rid=${data.roomId.slice(0, 8)} reason=not_host`);
      return sfuError('not_host');
    }

    // Audit row #5 (C3) — cap per-call ring fan-out. A 10k-entry
    // recipientUserIds[] would otherwise force 10k WS emits + 10k VoIP
    // wakes in one frame. 250 is generous (Phase-1 informal group cap
    // is ~50) but bounded enough to block torch attacks.
    const MAX_RING_TARGETS = 250;
    if (Array.isArray(data.recipientUserIds) && data.recipientUserIds.length > MAX_RING_TARGETS) {
      this.logger.warn(`[SFU] ring rejected uid=${callerId.slice(0, 8)} rid=${data.roomId.slice(0, 8)} reason=too_many_targets count=${data.recipientUserIds.length}`);
      return sfuError('too_many_targets');
    }

    /**
     * Strip self + duplicates — the caller's own devices are already in it —
     * and ALSO anyone who is currently a participant of this very room.
     *
     * The last clause is new. Ringing a member who is already in the call was
     * previously unreachable (only the host rang, once, at boot). Now that a
     * caller who tapped Call rings even when handed an existing room, it is
     * reachable in two ordinary ways: two people tapping Call within the
     * room's setup grace, and a client whose relay predates the `live` field
     * treating every entry as a fresh call. For a member sitting in the call
     * with the app foregrounded the ring is harmless — the client suppresses
     * a ring for the room it is already in — but a MINIMIZED or backgrounded
     * member gets a VoIP wake and a full-screen incoming-call notification
     * for the call they are already on, and the fan-out also writes them a
     * missed-call marker that nothing clears on join, so they later receive a
     * "missed group call" for a call they answered.
     *
     * The relay is the only place that knows the room's real occupancy, so
     * the filter belongs here rather than in each caller.
     */
    const deduped = Array.from(new Set(
      data.recipientUserIds.filter(uid =>
        uid && uid !== callerId && !this.isReachableParticipant(data.roomId, uid),
      ),
    ));
    // Why: M-07 (P1-11) — never ring (WS incoming OR VoIP wake) a user in a
    // block relationship with the host. Silent-filter, no oracle.
    // B-597 — deadline-bounded per target (see privacyGateBounded): the first
    // WS ring no longer waits on a cold Supabase round trip for the slowest member.
    const blockedFlags = await Promise.all(deduped.map(uid => this.privacyGateBounded(callerId, uid, 'ring')));
    const targets = deduped.filter((_, i) => !blockedFlags[i]);
    if (targets.length === 0) return {ok: true};

    // Why: SRV-04 — the wake's conversationId is client-supplied and rides a 4KB
    // FCM/APNs payload; an oversize value would fail the whole wake (the WS frame
    // and the pending-ring copies are unaffected). 128 chars matches the frame
    // bound used elsewhere in this gateway.
    const convHint =
      typeof data.conversationId === 'string' && data.conversationId.length > 0 && data.conversationId.length <= 128
        ? data.conversationId
        : undefined;

    // B-336 — one id per ring FAN-OUT, repeated on every copy of THIS ring
    // (WS frame, VoIP wake, queued reconnect replay). The client dedups on
    // (roomId, ringId): keying on roomId alone meant a recipient who never
    // answered swallowed every later re-ring for a minute, so mid-call "Add"
    // and the host's Re-ring silently did nothing while this server logged a
    // successful fan-out. Display/routing-only — admission is still gated by
    // the per-recipient HMAC room token, so this rides UNSIGNED like
    // fromUserId/callKind and old clients simply ignore it.
    const ringId = randomUUID();

    // B-239 — collect per-member wake outcomes for the fan-out summary below.
    const wakeResults: Array<Promise<{sent: number; stubbed: boolean; reason?: string} | null>> = [];
    for (const uid of targets) {
      // Audit P0-C2 / row #5 — mint per-recipient HMAC token. Without
      // this, knowing a roomId was enough to silently land in the
      // room. 30-min TTL (M1) absorbs PushKit cold-start + Doze thaw.
      // issue() throws when secret unset → ship empty string, gateway
      // skips verify on join (dev/legacy compat).
      let roomToken = '';
      let roomTokenExp = 0;
      try {
        const minted = this.roomToken.issue(data.roomId, uid);
        roomToken = minted.token;
        roomTokenExp = minted.exp;
      } catch { /* secret not configured — dev only */ }

      const ringData = {
        roomId:         data.roomId,
        conversationId: data.conversationId,
        callType:       data.callType,
        from:           {userId: callerId, deviceId: ctx.signalDeviceId},
        callerName:     data.callerName,
        roomToken,
        roomTokenExp,
        // B-336 — see the `ringId` mint above.
        ringId,
      };
      // Fan to every connected device of this user. Cross-node delivery
      // rides the Redis adapter automatically.
      this.hub.server?.to(this.hub.userRoom(uid)).emit('sfu.ring.incoming', ringData);
      // VoIP wake — best-effort; reusing roomId as the call id since
      // group calls don't have a separate callId concept. §5 parity
      // (Ranak-approved 2026-07-05, relaxes P1-N2): pseudonymous caller
      // UUID + group call-kind ride the wake for instant local-name ring
      // labeling. Audit row #7 — per-(caller, recipient) wake budget
      // enforced inside sendVoipWake. Audit PUSH-B6 — pass the recipient's
      // minted room token so a killed-app decline can authenticate
      // sfu.ring.decline. Empty string when the secret isn't configured.
      wakeResults.push(this.push.sendVoipWake(
        uid, data.roomId, callerId, roomToken || undefined,
        (data as {callType?: string}).callType === 'video' ? 'group-video' : 'group-voice',
        convHint,
        // B-336 — the FCM lane's copy of THIS fan-out must carry the same
        // ringId, or it would dedup as a separate ring and double-present.
        ringId,
      ).then(r => {
        // SRV-06 — surface a throttled group wake in the [SFU] stream.
        if (r?.reason) {
          this.logger.warn(`[SFU] ring wake-throttled rid=${data.roomId.slice(0, 8)} → ${uid.slice(0, 8)} reason=${r.reason}`);
        }
        return r ?? null;
      }).catch(() => null));

      // P2-BR-9 — queue a short-TTL pending ring + a missed-group-call marker
      // (MISSED_CALL_MARKER_TTL_SEC) per target so a device offline/Dozed at ring time either rings
      // live (reconnect within 45s) or records a missed group call (reconnect
      // later) — the group analogue of the 1:1 pendingOffer/missed-marker.
      // conversationId rides the queued payload so the replayed ring can dedupe
      // + attach to the right thread.
      try {
        const at = Date.now();
        const pendingRing: PendingGroupRing = {
          roomId:         data.roomId,
          conversationId: data.conversationId,
          callType:       data.callType,
          from:           {userId: callerId, deviceId: ctx.signalDeviceId},
          callerName:     data.callerName,
          roomToken,
          roomTokenExp,
          at,
          // B-336 — the reconnect replay is a copy of THIS fan-out, so it must
          // replay the same ringId; otherwise every replay would look new and
          // re-present a ring the user already saw (the B-306 regression).
          ringId,
        };
        // AUDIT-2026-08-13 D-3 — one atomic MULTI per ring target instead of
        // four sequential awaits: no torn ring/marker/index state on a blip,
        // and the fan-out loop costs 1 RTT per member instead of 4 (a 250-cap
        // ring shrinks from ~1000 sequential round-trips to 250).
        const ringExec = await this.redis.client.multi()
          .set(pendingGroupRingKey(uid, data.roomId), JSON.stringify(pendingRing), 'EX', 45)
          .set(
            missedGroupCallMarkerKey(uid, data.roomId),
            // WI-6.7 — the marker carries the fan-out's ringId too, so a
            // host cancel for an OLD ring cannot destroy a NEWER ring's
            // missed-call record after the newer payload expires.
            JSON.stringify({roomId: data.roomId, conversationId: data.conversationId, from: pendingRing.from, callType: data.callType, at, ringId} satisfies MissedGroupCallMarker),
            'EX', MISSED_CALL_MARKER_TTL_SEC,
          )
          .sadd(pendingGroupRingIndexKey(uid), data.roomId)
          .expire(pendingGroupRingIndexKey(uid), MISSED_CALL_MARKER_TTL_SEC)
          .exec();
        // rev-2 — best-effort lane, but a partial in-EXEC failure must be
        // VISIBLE (it silently loses one member's queued ring).
        if (!Array.isArray(ringExec) || ringExec.some(([e]) => !!e)) {
          this.logger.warn(`[SFU] pending-ring MULTI partial failure rid=${data.roomId.slice(0, 8)} → ${uid.slice(0, 8)}`);
        }
      } catch { /* best effort */ }
    }
    this.logger.log(`[GROUP-CALL] ring rid=${data.roomId} from=${callerId} → ${targets.length} user(s)`);
    // B-239 — ring-blackout visibility: ONE summary per fan-out. A `dark`
    // member received no push wake at all (no tokens, or FCM/APNs stubbed);
    // they ring only if a live WS connection happens to be up right now.
    // Fire-and-forget so the ring ack never waits on push RTTs.
    void Promise.all(wakeResults).then(results => {
      const pushed = results.filter(r => !!r && r.sent > 0).length;
      const throttled = results.filter(r => !!r?.reason).length;
      const dark = results.length - pushed - throttled;
      const line = `[SFU] ring wake summary rid=${data.roomId.slice(0, 8)} targets=${targets.length} pushed=${pushed} throttled=${throttled} dark=${dark}`;
      if (dark > 0) {
        this.logger.warn(`${line} — dark members have no reachable ring token (B-239)`);
      } else {
        this.logger.log(line);
      }
    });
    // WI-6.7 — return THIS fan-out's id so the host can cancel this ring
    // specifically (sfu.ring.cancel {ringId}) instead of by roomId alone,
    // which a room's second ring made ambiguous. Old clients ignore the field.
    return {ok: true, ringId};
  }

  @SubscribeMessage('sfu.ring.cancel')
  handleSfuRingCancel(
    @MessageBody() data: ClientSfuRingCancel['data'],
    @ConnectedSocket() client: Socket,
  ): {ok: true} | {ok: false; data: {code: string; message: string}} {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return sfuError('unauthenticated');
    // Round 2 (critic F3) — this frame now fans a cancel PUSH per recipient;
    // meter it. Event-less refusal so the ack lane stays intact (SFU-01).
    if (this.rateGate(client, 'sfu.ring.cancel')) return sfuError('rate_limited');
    // Audit row #5 (C2) — only the room HOST may cancel. Otherwise
    // any authed user could force every recipient's IncomingGroupCall-
    // Screen to self-dismiss by spamming the cancel frame for a
    // guessed roomId. hostOnly=true → caller must equal
    // SfuService.hostOf(roomId) AND (when secret set) present a token
    // binding (roomId, callerId).
    const ringGateErr = this.verifySfuRingAuthority(data.roomToken, data.roomId, ctx.claims.sub, /*hostOnly*/ true);
    if (ringGateErr) return ringGateErr;
    // B-238 — a host cancelling the ring before anyone joined is ending the
    // call attempt: purge the empty room so a member's call-back creates a
    // fresh room (they become host) instead of resolving this corpse and
    // getting `not_host` on their own sfu.ring. No-op when the room has
    // participants (cancelling one outstanding ringee must not end a live
    // call). Runs AFTER the host-authority gate above.
    this.sfu.endRoomIfEmptyByHost(data.roomId, ctx.claims.sub);
    // WI-6.7 — the host names WHICH fan-out it is cancelling. A second ring
    // for the same room (mid-call "Add", Re-ring) must survive a stale cancel
    // of the first, so every consumer below keys on (roomId, ringId), not
    // roomId alone. Optional: an old client sends none, and every lane then
    // falls back to the roomId-wide behaviour it always had.
    const cancelRingId =
      typeof data.ringId === 'string' && data.ringId.length > 0 && data.ringId.length <= 64
        ? data.ringId
        : undefined;
    const targets = Array.from(new Set(data.recipientUserIds.filter(uid => uid && uid !== ctx.claims.sub)));
    const frame = {
      event: 'sfu.ring.cancelled',
      data:  {roomId: data.roomId, conversationId: data.conversationId, ringId: cancelRingId},
    };
    for (const uid of targets) {
      this.hub.server?.to(this.hub.userRoom(uid)).emit(frame.event, frame.data);
      // P2-15 — parity with the 1:1 N-02 cancel push: a killed/Dozed device
      // never saw the WS cancel and keeps ringing up to the 45s wake TTL.
      // Reuse roomId as the callId so the client dismisses `bravo-call-<roomId>`.
      void this.push.sendCallCancel(uid, data.roomId, ctx.claims.sub, 'voice', /*missed*/ false, cancelRingId)
        .catch(() => { /* best effort */ });
      // Drop the queued pending ring (P2-BR-9) so a reconnect can't re-ring —
      // but ONLY the named fan-out's artifacts (WI-6.7): a newer queued ring
      // for this room survives.
      void this.clearPendingGroupRingArtifacts(uid, data.roomId, {onlyRingId: cancelRingId});
    }
    return {ok: true};
  }

  @SubscribeMessage('sfu.ring.decline')
  handleSfuRingDecline(
    @MessageBody() data: ClientSfuRingDecline['data'],
    @ConnectedSocket() client: Socket,
  ): {ok: true} | {ok: false; data: {code: string; message: string}} {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return sfuError('unauthenticated');
    // Round 2 (critic F3) — the WI-6.2 parity actions attached an FCM/APNs
    // cancel push to this frame; a 30-min ring token replayed in a loop was
    // an unmetered push amplifier. Meter BEFORE the (untouched) C2 gate.
    if (this.rateGate(client, 'sfu.ring.decline')) return sfuError('rate_limited');
    // Audit row #5 (C2) — proof the decliner was actually ringed.
    // Token was minted in handleSfuRing per recipient and shipped in
    // sfu.ring.incoming.roomToken; presenting it back proves they
    // received the ring. hostOnly=false → token presence + binding
    // is enough.
    const ringGateErr = this.verifySfuRingAuthority(data.roomToken, data.roomId, ctx.claims.sub, /*hostOnly*/ false);
    if (ringGateErr) return ringGateErr;
    // Tell the room's host about the decline. We can't address the host
    // directly from the decliner's side because the decliner never joined,
    // so the cleanest path is: ask the SFU for the host of this room and
    // emit to their userRoom. If the room is gone (host hung up before
    // decline arrived) this is a no-op.
    const hostUserId = this.sfu.hostOf(data.roomId);
    if (hostUserId && hostUserId !== ctx.claims.sub) {
      this.hub.server?.to(this.hub.userRoom(hostUserId)).emit('sfu.ring.declined', {
        roomId:         data.roomId,
        conversationId: data.conversationId,
        from:           {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId},
      });
    }
    // WI-6.2 — parity with declineCallViaHttp's group branch. The WS decline
    // used to clear NOTHING: the decliner's queued ring survived (ghost
    // re-ring on the next reconnect, phantom "missed group call" for an
    // explicitly declined call) and their OTHER devices kept ringing to the
    // 45s wake TTL. Same two actions as the HTTP lane, after the identical
    // authority gate above.
    void this.clearPendingGroupRingArtifacts(ctx.claims.sub, data.roomId);
    void this.push.sendCallCancel(
      ctx.claims.sub, data.roomId, hostUserId ?? ctx.claims.sub, 'voice', /*missed*/ false,
    ).catch(() => { /* best effort */ });
    this.logger.log(`[SFU] ring-decline rid=${data.roomId.slice(0, 8)} by=${ctx.claims.sub.slice(0, 8)}`); // WI-7.2
    return {ok: true};
  }

  /**
   * Audit row #5 (C2 helper) — shared authority check for
   * `sfu.ring.cancel` / `sfu.ring.decline`. Returns an `sfu.error`
   * object on failure (caller should `return` it), or `null` to admit.
   *
   * - `hostOnly: true`  → caller must equal `SfuService.hostOf(roomId)`
   *                       AND (when secret is set) present a valid
   *                       `roomToken` binding (roomId, caller).
   * - `hostOnly: false` → caller need only present a valid token. The
   *                       token presence proves they received the ring;
   *                       the binding proves they didn't borrow someone
   *                       else's. Used by decline (anyone legitimately
   *                       ringed may decline).
   */
  private verifySfuRingAuthority(
    token:    string | undefined,
    roomId:   string,
    callerId: string | undefined,
    hostOnly: boolean,
  ): {ok: false; data: {code: string; message: string}} | null {
    if (!callerId) return sfuError('unauthenticated');
    if (hostOnly) {
      const host = this.sfu.hostOf(roomId);
      if (!host || host !== callerId) {
        this.logger.warn(`[SFU] cancel rejected uid=${callerId.slice(0, 8)} rid=${roomId.slice(0, 8)} reason=not_host`);
        return sfuError('not_host');
      }
    }
    if (token) {
      const verdict = this.roomToken.verify(token, roomId, callerId);
      if (!verdict.ok) {
        this.logger.warn(`[SFU] ring-auth rejected uid=${callerId.slice(0, 8)} rid=${roomId.slice(0, 8)} reason=${verdict.reason}`);
        return sfuError(`room_token_${verdict.reason}`);
      }
      return null;
    }
    // No token — probe whether the server has the secret. If set, reject.
    try {
      this.roomToken.issue('probe', 'probe', 1);
      this.logger.warn(`[SFU] ring-auth rejected uid=${callerId.slice(0, 8)} rid=${roomId.slice(0, 8)} reason=missing_token`);
      return sfuError('room_token_required');
    } catch {
      return null;
    }
  }

  /**
   * B-479 — the recipient has taken responsibility for a replayed ring, so the
   * queued artifacts can go.
   *
   * Authority is the SESSION: every key this touches is namespaced by the
   * authenticated `sub`, so a caller can only ever discard their OWN queued
   * ring — something they can already do by declining it. The room token is
   * verified when supplied (belt, and it costs nothing) but not required: the
   * FCM rescue lane's payload may not carry one, and rejecting there would
   * leave the ring queued forever rather than protect anything.
   */
  @SubscribeMessage('sfu.ring.ack')
  async handleSfuRingAck(
    @MessageBody() data: ClientSfuRingAck['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{ok: true} | {ok: false; data: {code: string; message: string}}> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return sfuError('unauthenticated');
    if (this.rateGate(client, 'sfu.ring.ack')) return sfuError('rate_limited');
    const roomId = typeof data?.roomId === 'string' ? data.roomId.trim() : '';
    if (!roomId) return sfuError('bad_request');
    if (data.roomToken) {
      const verdict = this.roomToken.verify(data.roomToken, roomId, ctx.claims.sub);
      if (!verdict.ok) {
        this.logger.warn(`[SFU] ring-ack rejected uid=${ctx.claims.sub.slice(0, 8)} rid=${roomId.slice(0, 8)} reason=${verdict.reason}`);
        return sfuError(`room_token_${verdict.reason}`);
      }
    }
    this.logger.log(`[SFU] ring-ack uid=${ctx.claims.sub.slice(0, 8)} rid=${roomId.slice(0, 8)}`);
    // B-566 round 2 (arch P3-5) — the ack settles the REPLAYED fan-out it
    // owns, not whatever happens to be queued: a ring #2 that overwrote the
    // queue after replay #1 was emitted must survive #1's late ack. Absent
    // ringId (old client) → the historical room-wide settle.
    const ackRingId =
      typeof data.ringId === 'string' && data.ringId.length > 0 && data.ringId.length <= 64
        ? data.ringId
        : undefined;
    await this.clearPendingGroupRingArtifacts(ctx.claims.sub, roomId, {onlyRingId: ackRingId});
    return {ok: true};
  }

  @SubscribeMessage('sfu.mute-target')
  async handleSfuMuteTarget(
    @MessageBody() data: ClientSfuMuteTarget['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{ok: true; pausedProducers: number} | {ok: false; data: {code: string; message: string}}> {
    // Audit SFU-06 — resolve the tag scoped to THIS room. Without the hint,
    // firstTagFor fell back to insertion order, so a host who was a survivor
    // of a previously-ended call could resolve a stale tag → participant_not_
    // found (surfaced as an ack error for a moderation action on the live call).
    const byTag = this.firstTagFor(client, data.roomId);
    if (!byTag) return sfuError('no_active_participant');
    try {
      // Round 5 / Security S6 — authoriseMute is now async because it
      // actually pauses (or resumes) the mediasoup Producer server-
      // side. Pause stops RTP at the SFU regardless of whether the
      // target client honors the advisory frame.
      const {targetUserId, pausedProducers} = await this.sfu.authoriseMute(
        byTag, data.roomId, data.targetTag, {unmute: data.unmute === true},
      );
      const event = data.unmute ? 'sfu.unmuted' : 'sfu.muted';
      // Emit to the target's `sfutag:<tag>` room — delivered on whichever
      // pod holds the socket via the Redis adapter, so this works
      // cross-node without the old WeakMap-then-user-room fallback. The
      // target joined this room at sfu.join. `targetUserId` is no longer
      // needed for routing here (kept in the service return for logging).
      void targetUserId;
      this.hub.server?.to(sfuTagRoom(data.targetTag)).emit(event, {
        roomId: data.roomId, byTag,
      });
      return {ok: true, pausedProducers};
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_mute_failed');
    }
  }

  @SubscribeMessage('sfu.kick')
  async handleSfuKick(
    @MessageBody() data: ClientSfuKick['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{ok: true} | {ok: false; data: {code: string; message: string}}> {
    // Audit SFU-06 — scope the actor tag to this room (see mute-target).
    const byTag = this.firstTagFor(client, data.roomId);
    if (!byTag) return sfuError('no_active_participant');
    try {
      const {kickedTag} = await this.sfu.kick(byTag, data.roomId, data.targetTag);
      // Tell the kicked client via their `sfutag:<tag>` room so the signal
      // reaches them on whatever pod holds their socket (Redis fanout).
      // socket.io room membership is socket-side, so this still resolves
      // even though sfu.kick already removed them from the SFU room state.
      this.hub.server?.to(sfuTagRoom(kickedTag)).emit('sfu.kicked', {roomId: data.roomId, byTag});
      // Clean up our local tag → socket mapping + fanout-room membership
      // if the kicked socket lives on this pod.
      const targetSock = this.sfuTagToSocket.get(kickedTag);
      this.sfuTagToSocket.delete(kickedTag);
      if (targetSock) {
        const tags = this.sfuSocketTags.get(targetSock);
        if (tags) tags.delete(kickedTag);
        void targetSock.leave(sfuTagRoom(kickedTag));
        void targetSock.leave(sfuRoom(data.roomId));
      }
      return {ok: true};
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_kick_failed');
    }
  }

  /**
   * Returns the SFU participant tag bound to this socket. When `roomId`
   * is provided, prefers the tag whose participant is in that room —
   * critical when a single socket holds two SFU sessions (rapid leave→
   * rejoin, or accept-incoming-call-mid-call). Without the roomId
   * preference, iteration order would silently pick the OLDER tag and
   * subsequent `sfu.produce`/`sfu.consume` would route against a torn-
   * down ParticipantState and surface as `participant_not_found`.
   * Falls back to insertion order if no roomId hint is given (legacy
   * call sites; their flows are in single-room scope so the fallback
   * is safe).
   */
  private firstTagFor(client: Socket, roomId?: string): string | null {
    const tags = this.sfuSocketTags.get(client);
    if (!tags || tags.size === 0) return null;
    if (roomId) {
      for (const tag of tags) {
        const info = this.sfu.resolveParticipantUser(tag);
        if (info && info.roomId === roomId) return tag;
      }
    }
    return tags.values().next().value as string;
  }

  // ─── Ephemeral signals (M11) ──────────────────────────────────────

  @SubscribeMessage('typing')
  async handleTyping(
    @MessageBody() data: ClientTyping['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    // Audit WS-HIGH — meter the fan-out signal (was unmetered).
    const limited = this.rateGate(client, 'typing');
    if (limited) return limited;
    // Why: M-07 — blocked pairs must not leak typing signals. Silent drop
    // (no error frame) so the block itself stays undetectable. Server leg
    // only: message delivery is NOT gated here (sealed sender hides it).
    if (await this.privacy.isBlockedEither(ctx.claims.sub, data.to.userId)) return undefined;
    const from = {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId};
    // Why: SYNC-6 — opaque client-side scope token. Forwarded verbatim,
    // never parsed, stored or logged; a bad shape is dropped, not 400'd.
    const convTag = sanitizeConvTag(data.convTag);

    // Typing indicators are volatile — skip the online probe and skip
    // buffering. If the peer's socket has a full send queue we'd rather
    // drop the frame than delay a real message behind it.
    this.hub.server
      ?.to(this.hub.deviceRoom(data.to))
      .volatile
      .emit('typing', typingFrame(from, data.state, convTag));

    const key = typingKey(from, data.to, convTag);
    const prev = this.typingTimers.get(key);
    if (prev) clearTimeout(prev);

    if (data.state === 'start') {
      const t = setTimeout(() => {
        this.hub.server
          ?.to(this.hub.deviceRoom(data.to))
          .volatile
          .emit('typing', typingFrame(from, 'stop', convTag));
        this.typingTimers.delete(key);
      }, TYPING_TIMEOUT_MS);
      (t as {unref?: () => void})?.unref?.();
      this.typingTimers.set(key, t);
    } else {
      this.typingTimers.delete(key);
    }
    return undefined;
  }

  @SubscribeMessage('read-receipt')
  async handleReadReceipt(
    @MessageBody() data: ClientReadReceipt['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    // Audit WS-HIGH — meter read-receipt fan-out (was unmetered).
    const limited = this.rateGate(client, 'read-receipt');
    if (limited) return limited;
    // Why: M-07 — silent drop when blocked; an error frame would be a
    // block oracle.
    if (await this.privacy.isBlockedEither(ctx.claims.sub, data.to.userId)) return undefined;
    const from = {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId};
    const frame: ServerReadReceipt = {
      event: 'read-receipt',
      data:  {from, envelopeIds: data.envelopeIds},
    };
    // P2-BR-11 / F7 — a ≤55s ZOMBIE socket (dead TCP, Doze-frozen) still
    // counts as "online" via deviceIsOnline() but never receives the emit, so
    // the old online→emit-only / offline→queue split lost receipts forever on
    // that window. ALWAYS enqueue to the durable queue AND attempt the live
    // emit; the drain is idempotent (receipts dedupe by (envelopeId, reader)
    // on the client), so a double delivery is harmless.
    try {
      await this.envelopes.queueReadReceipt(data.to, frame.data);
    } catch { /* best-effort — the live emit below may still deliver */ }
    try {
      if (await this.hub.deviceIsOnline(data.to)) {
        this.hub.server?.to(this.hub.deviceRoom(data.to)).emit(frame.event, frame.data);
      }
    } catch { /* best-effort — the durable queue above drains on reconnect */ }
    return undefined;
  }

  // ─── Presence ─────────────────────────────────────────────────────

  @SubscribeMessage('presence')
  async handlePresence(
    @MessageBody() data: ClientPresence['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    const limited = this.rateGate(client, 'presence');
    if (limited) return limited;
    // B-354 — a background socket never drives user-visible activity; its
    // client-side replay ('away' on connect) must not overwrite a truthful
    // 'offline' with a phantom state while the app is killed.
    if (ctx.presenceBg) return undefined;
    const next: PresenceState = data.state === 'active' ? 'active' : 'away';
    await this.presence.set(ctx.claims.sub, next);
    return undefined;
  }

  /**
   * Subscribe to a list of users' presence. Joins this socket to each
   * `watch:<userId>` room, then immediately emits a one-shot snapshot
   * so the client can paint its contact-status UI without waiting for
   * the next state transition.
   */
  @SubscribeMessage('presence.subscribe')
  async handlePresenceSubscribe(
    @MessageBody() data: ClientPresenceSubscribe['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    const limited = this.rateGate(client, 'presence.subscribe');
    if (limited) return limited;
    const userIds = sanitizeUserIds(data?.userIds);
    if (userIds.length === 0) return undefined;
    // Why: M-07 — a blocked pair gets NO live watch (never joins the room)
    // and a plain-offline snapshot instead of an error, so a blocker cannot
    // be detected by probing presence.
    const blocked = await Promise.all(
      userIds.map(uid => this.privacy.isBlockedEither(ctx.claims.sub, uid)),
    );
    const watchable = userIds.filter((_, i) => !blocked[i]);
    if (watchable.length > 0) {
      await client.join(watchable.map(uid => this.presence.watchRoom(uid)));
    }
    const snapshot = await this.presence.getMany(watchable);
    const visible = await Promise.all(
      watchable.map(uid => this.privacy.isLastSeenVisible(uid)),
    );
    const visibleByUid = new Map(watchable.map((uid, i) => [uid, visible[i]]));
    for (let i = 0; i < userIds.length; i++) {
      const uid = userIds[i];
      const rec = snapshot[uid];
      // M-06 — strip lastSeenMs from the snapshot when the SUBJECT's
      // last_seen_visible is false; the state boolean is a separate toggle.
      const frame: ServerPresence = blocked[i] || !rec
        ? {event: 'presence', data: {userId: uid, state: 'offline'}}
        : {
            event: 'presence',
            data: visibleByUid.get(uid)
              ? {userId: uid, state: rec.state, lastSeenMs: rec.lastSeenMs}
              : {userId: uid, state: rec.state},
          };
      client.emit(frame.event, frame.data);
    }
    return undefined;
  }

  @SubscribeMessage('presence.unsubscribe')
  async handlePresenceUnsubscribe(
    @MessageBody() data: ClientPresenceUnsubscribe['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    const limited = this.rateGate(client, 'presence.unsubscribe');
    if (limited) return limited;
    const userIds = sanitizeUserIds(data?.userIds);
    for (const uid of userIds) {
      await client.leave(this.presence.watchRoom(uid));
    }
    return undefined;
  }

  // ─── Envelope pull ────────────────────────────────────────────────

  @SubscribeMessage('envelope.pull')
  async handleEnvelopePull(
    @MessageBody() data: ClientEnvelopePull['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<void | ServerError> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    // Audit WS-HIGH — meter the most expensive WS verb (was unmetered).
    const limited = this.rateGate(client, 'envelope.pull');
    if (limited) return limited;
    try {
      const bootstrap = data?.bootstrap === true;
      const envs = await this.envelopes.pull(
        {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId},
        data?.after ? Number.parseInt(data.after, 10) || 0 : 0,
        data?.limit ?? (bootstrap ? 1000 : 50),
        {bootstrap},
      );
      for (const env of envs) {
        const frame: ServerEnvelopeDeliver = {
          event: 'envelope.deliver',
          data: {
            envelopeId:  env.envelopeId,
            outerSealed: env.outerSealed,
            timestamp:   env.timestamp,
            // Audit P0-N9 — minted (or fetched) by service.pull.
            ackToken:    env.ackToken,
          },
        };
        client.emit(frame.event, frame.data);
      }
      return undefined;
    } catch (e) {
      return toError(e);
    }
  }

  // ─── helpers ──────────────────────────────────────────────────────

  // ─── Call-session bookkeeping ────────────────────────────────────
  // Helpers for the 1:1 P2P call lifecycle. See `callSessions` field
  // declaration for the full rationale.

  /**
   * Track a freshly-created call. Called from `call.offer` after
   * duplicate / tombstone checks have passed. Returns a structured
   * error if the callId is already known (active or in tombstone
   * window), else creates the session and links it to the caller's
   * socket so disconnect can fire bye.
   */
  private trackCallStart(
    client: Socket,
    callId: string,
    caller: {userId: string; deviceId: number},
    callee: {userId: string; deviceId: number},
  ): ServerError | undefined {
    this.gcCallTombstones();
    const existing = this.callSessions.get(callId);
    if (existing) {
      // Already exists in any state. Either:
      //   - state === 'ended' & still in tombstone window → reject as
      //     duplicate. Caller should regenerate callId on rapid redial.
      //   - state === 'ringing' / 'active' → it's an active call; the
      //     same caller can re-offer (renegotiation goes through the
      //     dedicated call.reoffer handler, not call.offer), so reject.
      return {event: 'error', data: {code: 'duplicate_call_id', message: `callId ${callId.slice(0, 8)} is already known (${existing.state})`}};
    }
    this.callSessions.set(callId, {
      callId, caller, callee,
      state: 'ringing', createdAt: Date.now(),
    });
    // WI-7.2 — callSessions transition record (ids only).
    console.log(`[CALL] session cid=${callId.slice(0, 8)} -→ringing src=offer`);
    let owned = this.socketCalls.get(client);
    if (!owned) { owned = new Set(); this.socketCalls.set(client, owned); }
    owned.add(callId);
    return undefined;
  }

  /**
   * SRV-02 — re-create the in-memory session for an offer replayed out of
   * Redis on reconnect. `callSessions` dies with the process but the queued
   * offer does not, so without this a ring replayed after a gateway restart
   * (staging redeploys on every push) can never be answered:
   * `authorizeCallFrame` sees an unknown callId and silently drops the
   * `call.answer`. Every field comes from the persisted offer, so no new
   * server-side call state is introduced.
   *
   * Returns false when the callId is a live tombstone — the caller already
   * hung up, so the offer must NOT be replayed at all.
   *
   * Why: the session is intentionally NOT linked into `socketCalls`. Linking
   * it would make a post-replay socket flap fire an immediate `call.hangup`
   * at the caller (ringing sessions get the un-graced bye), killing a call
   * the callee is still ringing for. `trackCallAnswer` links the socket at
   * answer time, which is the normal flow. Because of that omission nothing
   * can tear the session down if BOTH sides then go silent, so it is stamped
   * `rehydrated` and swept by `gcCallTombstones` after `REHYDRATED_RING_TTL_MS`.
   */
  private rehydrateCallSession(
    callId: string,
    caller: {userId: string; deviceId: number},
    callee: {userId: string; deviceId: number},
  ): boolean {
    this.gcCallTombstones();
    const existing = this.callSessions.get(callId);
    if (existing) return existing.state !== 'ended';
    this.callSessions.set(callId, {
      callId, caller, callee,
      state: 'ringing', createdAt: Date.now(), rehydrated: true,
    });
    console.log(`[CALL] session cid=${callId.slice(0, 8)} -→ringing src=rehydrate`); // WI-7.2
    return true;
  }

  /**
   * Verify the sender of a `call.*` frame is a participant in the
   * referenced callId. Returns null if the call is unknown or ended
   * (caller should treat as "ignore this frame"), or an error frame if
   * the sender isn't authorized. Returns the session on success.
   */
  private authorizeCallFrame(
    senderUserId: string,
    callId: string,
  ): {ok: true; session: CallSession} | {ok: false; err: ServerError} | {ok: false; ignore: true} {
    this.gcCallTombstones();
    const session = this.callSessions.get(callId);
    if (!session || session.state === 'ended') {
      // Frame for a call we don't track or that already ended. Don't
      // hand out an error to the sender (could be benign — e.g. a late
      // ICE for a hung-up call); silently drop.
      return {ok: false, ignore: true};
    }
    if (session.caller.userId !== senderUserId && session.callee.userId !== senderUserId) {
      // Cross-call mischief: a third party trying to hangup someone
      // else's call. Surface as auth_failed so the offending client
      // sees the rejection in its logs.
      return {ok: false, err: {event: 'error', data: {code: 'auth_failed', message: 'sender is not a participant in this call'}}};
    }
    return {ok: true, session};
  }

  /**
   * Bind callee's socket on the first `call.answer` so disconnect on
   * either side fires bye to the other.
   *
   * WI-6.1 — `answeredBy` records the arbitration winner. First writer wins
   * (`??=`): the durable-answer drain and the live handler can both reach
   * this, and whichever device's answer got here first stays the winner.
   */
  private trackCallAnswer(
    client: Socket,
    callId: string,
    answeredBy?: {userId: string; deviceId: number},
  ): void {
    const s = this.callSessions.get(callId);
    if (!s) return;
    if (s.state === 'ringing') {
      s.state = 'active';
      console.log(`[CALL] session cid=${callId.slice(0, 8)} ringing→active src=answer by=${answeredBy ? answeredBy.userId.slice(0, 8) + '/' + answeredBy.deviceId : '-'}`); // WI-7.2
    }
    if (answeredBy) s.answeredBy ??= answeredBy;
    let owned = this.socketCalls.get(client);
    if (!owned) { owned = new Set(); this.socketCalls.set(client, owned); }
    owned.add(callId);
  }

  /**
   * Idempotent call end — flips to tombstone, NOT deletes. Tombstones
   * are GC'd by `gcCallTombstones` after CALL_TOMBSTONE_TTL_MS.
   */
  private trackCallEnd(callId: string): CallSession | undefined {
    const s = this.callSessions.get(callId);
    if (!s) return undefined;
    if (s.state !== 'ended') {
      console.log(`[CALL] session cid=${callId.slice(0, 8)} ${s.state}→ended src=hangup`); // WI-7.2
      s.state = 'ended';
      s.endedAt = Date.now();
    }
    // B-596 — an ended session never flushes held candidates.
    s.offerPending = false;
    s.heldIce = undefined;
    return s;
  }

  /** B-596 — cap on candidates held while the offer is in flight (the client's own MAX_PENDING_ICE). */
  private static readonly MAX_HELD_ICE = 64;

  /**
   * B-596 / M-07 — forget a session that must leave NO trace: a blocked pair's
   * offer. Unlike trackCallEnd there is no tombstone, so a retried callId is
   * treated exactly like a never-seen one (a `duplicate_call_id` reply would
   * be an oracle the privacy gate promises not to give).
   */
  private untrackCallSilently(client: Socket, callId: string): void {
    const s = this.callSessions.get(callId);
    if (s) {console.log(`[CALL] session cid=${callId.slice(0, 8)} ${s.state}→forgotten src=blocked`);} // WI-7.2 lane completeness
    this.callSessions.delete(callId);
    const owned = this.socketCalls.get(client);
    if (owned) {owned.delete(callId);}
  }

  /** B-596 — release a hold that can no longer be flushed (throw / hangup); idempotent. */
  private clearOfferHold(callId: string): void {
    const s = this.callSessions.get(callId);
    if (!s) return;
    s.offerPending = false;
    s.heldIce = undefined;
  }

  /**
   * B-597 — the call lanes' block-check, DEADLINE-bounded. The offer handler
   * and the group ring fan-out used to await a Supabase round trip with no
   * ceiling before the first frame went out (a slow-but-successful lookup was
   * "fail-closed by hanging"). On deadline:
   *   1. if the privacy service holds a CACHED verdict for the pair — even an
   *      EXPIRED one — that verdict is used (a stale "blocked" stays blocked:
   *      the bound never widens the gate for a pair it has ever seen);
   *   2. only a never-seen pair fails OPEN — the SAME outcome the service
   *      already returns on a probe error ("a config gap never takes presence
   *      or receipts down"), bounded to one frame per pair per 60 s because the
   *      in-flight lookup keeps running and warms the cache.
   * Messaging / typing / receipt lanes are untouched.
   * `PRIVACY_CALL_GATE_DEADLINE_MS`: default 500 (the audit's cold Supabase
   * estimate is 50–300 ms, so a healthy cold miss stays inside the bound);
   * `0` / non-numeric disables the bound (raw await, today's behaviour).
   * Founder-visible trade-off: recorded in sqa.md under B-597.
   */
  private privacyGateBounded(a: string, b: string, lane: 'offer' | 'ring'): Promise<boolean> {
    const check = this.privacy.isBlockedEither(a, b);
    const raw = Number(process.env.PRIVACY_CALL_GATE_DEADLINE_MS ?? 500);
    const deadline = Number.isFinite(raw) ? raw : 0;
    if (!(deadline > 0)) return check;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onDeadline = new Promise<boolean>(resolve => {
      timer = setTimeout(() => {
        const stale = this.privacy.peekBlockedEither?.(a, b);
        console.warn(`[CALL] privacy gate deadline lane=${lane} ms=${deadline} verdict=${stale === undefined ? 'open(never-seen)' : `cached(${stale})`}`);
        resolve(stale ?? false);
      }, deadline);
      timer.unref?.();
    });
    return Promise.race([check, onDeadline]).finally(() => { if (timer) clearTimeout(timer); });
  }

  /**
   * Sweep ended sessions older than tombstone TTL. Called on any call.* hit.
   * SRV-02 — also expires an owner-less rehydrated session that is still
   * `ringing` past `REHYDRATED_RING_TTL_MS`; it is unanswerable by then (the
   * replayed offer payload only lives 45s) and no teardown path can reach it.
   * It is tombstoned rather than deleted so the duplicate-callId perimeter
   * still holds for the normal tombstone window.
   */
  private gcCallTombstones(): void {
    const now = Date.now();
    const cutoff = now - MessengerGateway.CALL_TOMBSTONE_TTL_MS;
    const ringCutoff = now - MessengerGateway.REHYDRATED_RING_TTL_MS;
    for (const [cid, s] of this.callSessions) {
      if (s.state === 'ringing' && s.rehydrated && s.createdAt < ringCutoff) {
        s.state = 'ended';
        s.endedAt = now;
        continue;
      }
      if (s.state === 'ended' && (s.endedAt ?? 0) < cutoff) {
        this.callSessions.delete(cid);
      }
    }
  }

  /**
   * P1-BR-5 / B-58 — schedule the disconnect-bye for a CONNECTED 1:1 call.
   * Fires after the grace window UNLESS `cancelCallDisconnectByes` clears it
   * first (same-device reconnect). At fire time we re-check the session so a
   * peer-hangup / answer during grace makes it a no-op.
   */
  private scheduleCallDisconnectBye(
    callId: string,
    who:  {userId: string; deviceId: number},
    peer: {userId: string; deviceId: number},
  ): void {
    const key = callGraceKey(callId, who.userId, who.deviceId);
    const prev = this.callDisconnectGrace.get(key);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      this.callDisconnectGrace.delete(key);
      const session = this.callSessions.get(callId);
      if (!session || session.state === 'ended') return; // resolved during grace
      this.trackCallEnd(callId);
      const target = this.hub.server?.to(this.hub.deviceRoom(peer));
      if (target) {
        target.emit('call.hangup', {callId, from: who, reason: 'failed'});
        this.logger.log(`[CALL] grace disconnect-bye cid=${callId.slice(0, 8)} → ${peer.userId.slice(0, 8)}/${peer.deviceId}`);
      }
    }, MessengerGateway.CALL_DISCONNECT_GRACE_MS);
    (timer as unknown as {unref?: () => void}).unref?.();
    this.callDisconnectGrace.set(key, {timer, userId: who.userId, deviceId: who.deviceId, peer, callId});
  }

  /** P1-BR-5 — cancel every deferred bye owned by this (user, device). */
  private cancelCallDisconnectByes(userId: string, deviceId: number): void {
    for (const [key, v] of this.callDisconnectGrace) {
      if (v.userId === userId && v.deviceId === deviceId) {
        clearTimeout(v.timer);
        this.callDisconnectGrace.delete(key);
      }
    }
  }

  /**
   * SRV-02 — hold an answer for a caller device that was mid-reconnect. One
   * slot per (callId, caller device); a re-sent answer replaces the previous
   * one. The TTL timer bounds the map so it cannot grow on a caller that
   * never returns.
   */
  private queuePendingAnswer(
    to:    {userId: string; deviceId: number},
    frame: ServerCallAnswer['data'],
  ): void {
    // In-process slot kept as a same-replica fast path AND as the fallback
    // when Redis is unavailable — losing an answer to a Redis blip would be a
    // regression on the very lane this is hardening.
    const key = callGraceKey(frame.callId, to.userId, to.deviceId);
    const prev = this.pendingAnswers.get(key);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => this.pendingAnswers.delete(key), MessengerGateway.PENDING_ANSWER_TTL_MS);
    (timer as unknown as {unref?: () => void}).unref?.();
    this.pendingAnswers.set(key, {frame, timer});

    // FIX-07 — durable twin. Without it a service restart, or a reconnect that
    // lands on another replica, silently drops the answer and the caller keeps
    // ringing against a call the callee already picked up.
    const ttlSec = Math.ceil(MessengerGateway.PENDING_ANSWER_TTL_MS / 1000);
    void (async () => {
      try {
        const pipe = this.redis.client.pipeline();
        pipe.set(pendingAnswerKey(to.userId, to.deviceId, frame.callId), JSON.stringify(frame), 'EX', ttlSec);
        pipe.sadd(pendingAnswerIndexKey(to.userId, to.deviceId), frame.callId);
        pipe.expire(pendingAnswerIndexKey(to.userId, to.deviceId), ttlSec);
        await pipe.exec();
      } catch (e) {
        this.logger.warn(`pending-answer persist failed: ${(e as Error).message}`);
      }
    })();
    this.logger.log(`[CALL] answer queued for reconnecting caller cid=${frame.callId.slice(0, 8)} → ${to.userId.slice(0, 8)}/${to.deviceId}`);
  }

  /**
   * SRV-02 — deliver answers queued while this device was reconnecting.
   *
   * FIX-07 — now drains the durable queue as well as the in-process one. Order
   * matters: the in-process pass runs FIRST and records what it emitted, so the
   * Redis pass cannot double-emit the same answer on the replica that queued
   * it. Redis entries are settled only after a successful emit (peek → emit →
   * settle, the same rule as the pending-offer drain): anything left behind by
   * a dead socket survives under its own TTL and replays on the next connect.
   */
  private flushPendingAnswers(client: Socket, address: {userId: string; deviceId: number}): void {
    const suffix = `::${address.userId}::${address.deviceId}`;
    const emitted = new Set<string>();
    for (const [key, entry] of this.pendingAnswers) {
      if (!key.endsWith(suffix)) continue;
      clearTimeout(entry.timer);
      this.pendingAnswers.delete(key);
      const session = this.callSessions.get(entry.frame.callId);
      if (!session || session.state === 'ended') continue;
      client.emit('call.answer', entry.frame);
      emitted.add(entry.frame.callId);
      this.logger.log(`[CALL] answer flushed cid=${entry.frame.callId.slice(0, 8)} → ${address.userId.slice(0, 8)}/${address.deviceId}`);
    }
    void this.flushDurablePendingAnswers(client, address, emitted);
  }

  /** FIX-07 — the cross-replica / post-restart half of flushPendingAnswers. */
  private async flushDurablePendingAnswers(
    client:  Socket,
    address: {userId: string; deviceId: number},
    already: Set<string>,
  ): Promise<void> {
    const idxKey = pendingAnswerIndexKey(address.userId, address.deviceId);
    try {
      const callIds = await this.redis.client.smembers(idxKey);
      if (!callIds || callIds.length === 0) return;
      for (const cid of callIds) {
        const payloadKey = pendingAnswerKey(address.userId, address.deviceId, cid);
        if (already.has(cid)) {
          // Emitted from the in-process slot on this replica — settle only.
          await this.redis.client.del(payloadKey);
          await this.redis.client.srem(idxKey, cid);
          continue;
        }
        let raw: string | null;
        try { raw = await this.redis.client.get(payloadKey); }
        catch { continue; }   // transient Redis error says nothing — leave queued
        if (raw === null) {
          // Expired past the ring window. A stale answer must never resurrect a
          // call the caller has already given up on.
          await this.redis.client.srem(idxKey, cid);
          continue;
        }
        let frame: ServerCallAnswer['data'];
        try { frame = JSON.parse(raw) as ServerCallAnswer['data']; }
        catch {
          // Malformed payload cannot wedge the index.
          await this.redis.client.del(payloadKey);
          await this.redis.client.srem(idxKey, cid);
          continue;
        }
        // Audit finding (first cut of FIX-07): checking callSessions here and
        // settling on absence made the drain delete the answer in EXACTLY the
        // restart/other-replica case it exists for — callSessions is in-process
        // and empty on a fresh gateway. Same recovery the offer lane uses:
        // an in-memory ENDED session is authoritative (drop), an ABSENT one is
        // rehydrated so the emit lands AND the caller's follow-up frames pass
        // authorizeCallFrame instead of dying as unknown-callId.
        const session = this.callSessions.get(cid);
        if (session ? session.state === 'ended'
                    : !this.rehydrateCallSession(cid, address, frame.from)) {
          await this.redis.client.del(payloadKey);
          await this.redis.client.srem(idxKey, cid);
          continue;
        }
        try {
          client.emit('call.answer', frame);
        } catch (e) {
          this.logger.warn(`pending-answer emit failed: ${(e as Error).message}`);
          continue;   // stays queued for the next connect
        }
        // Audit round 2 — a delivered answer means the call is LIVE. Left at
        // 'ringing'+rehydrated, gcCallTombstones force-ends the session at
        // REHYDRATED_RING_TTL_MS (300s): the caller's hangup then never
        // reaches the callee and any ICE restart dies in authorizeCallFrame.
        // trackCallAnswer promotes to 'active' AND links this socket so a
        // drop still fires the disconnect bye. WI-6.1 — the frame's `from` is
        // the answering callee device; record it so a late duplicate answer
        // after this flush is dropped by the arbitration gate, not forwarded.
        this.trackCallAnswer(client, cid, frame.from);
        await this.redis.client.del(payloadKey);
        await this.redis.client.srem(idxKey, cid);
        this.logger.log(`[CALL] durable answer flushed cid=${cid.slice(0, 8)} → ${address.userId.slice(0, 8)}/${address.deviceId}`);
      }
    } catch (e) {
      this.logger.warn(`durable pending-answer drain failed: ${(e as Error).message}`);
    }
  }

  /**
   * P1-BR-3 — headless / HTTP decline. Lets a killed-app client reject a ring
   * over a lightweight authenticated POST (no WS/runtime boot needed) so the
   * caller stops ringing instantly. Idempotent + best-effort: safe to call even
   * when the call is already gone (the CallsController always returns 200).
   *
   *   direct → tell the caller's devices `call.hangup{reason:'declined'}`, clear
   *            the DECLINING callee's own queued artifacts (drop the marker — a
   *            decline is not a missed call), and cancel-push the callee's OTHER
   *            devices so they stop ringing.
   *   group  → tell the room host `sfu.ring.declined`, and clear this member's
   *            queued group-ring artifacts.
   *
   * `caller` here is the DECLINING user (from the verified JWT), NOT the ring's
   * originator — `body.peerUserId` names the 1:1 originator.
   */
  async declineCallViaHttp(
    caller: {userId: string; deviceId: number},
    callId: string,
    body:   {peerUserId?: string; kind?: 'direct' | 'group'; roomId?: string},
  ): Promise<void> {
    if (body.kind === 'group') {
      const roomId = body.roomId || callId;
      const hostUserId = this.sfu.hostOf(roomId);
      if (hostUserId && hostUserId !== caller.userId) {
        this.hub.server?.to(this.hub.userRoom(hostUserId)).emit('sfu.ring.declined', {
          roomId, conversationId: '', from: caller,
        });
      }
      await this.clearPendingGroupRingArtifacts(caller.userId, roomId);
      // WI-6.2 — the HTTP group decline was missing the other-device ring
      // collapse its own 1:1 branch already has: the decliner's OTHER
      // devices kept ringing from the VoIP wake. Same cancel push both lanes.
      void this.push.sendCallCancel(
        caller.userId, roomId, hostUserId ?? caller.userId, 'voice', /*missed*/ false,
      ).catch(() => { /* best effort */ });
      return;
    }
    // 1:1 decline. Tombstone locally so any in-flight WS frames stop relaying.
    this.trackCallEnd(callId);
    if (body.peerUserId) {
      this.hub.server?.to(this.hub.userRoom(body.peerUserId)).emit('call.hangup', {
        callId, from: caller, reason: 'declined',
      });
    }
    // Drop the declining callee's own queued offer + marker (a decline is not a
    // missed call), keyed on the callee — the correct addressing from P1-14.
    await this.clearPendingCallArtifacts(caller.userId, caller.deviceId, callId);
    // Stop the callee's OTHER devices still ringing from the VoIP wake.
    void this.push.sendCallCancel(
      caller.userId, callId, body.peerUserId || caller.userId, 'voice', /*missed*/ false,
    ).catch(() => { /* best effort */ });
  }

  /**
   * Cross-node forward — probes `fetchSockets` so the caller sees a
   * definitive `peer_offline` even when the callee is on another
   * replica. Set `volatile=true` for frames that are safe to drop
   * (typing / presence broadcasts).
   */
  private async forwardToDevice<T extends {event: string; data: unknown}>(
    client: Socket,
    to: {userId: string; deviceId: number},
    volatile: boolean,
    buildFrame: (from: {userId: string; deviceId: number}) => T,
    // AUDIT D-4 — high-frequency, self-healing frames (trickle ICE) may skip
    // the cluster fetchSockets probe; the emit into an empty room is a no-op.
    // Offer/answer/hangup keep the probe: their callers act on peer_offline.
    opts?: {skipOnlineProbe?: boolean},
  ): Promise<ServerError | void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    const from = {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId};

    if (!opts?.skipOnlineProbe) {
      const online = await this.hub.deviceIsOnline(to);
      if (!online) {
        return {event: 'error', data: {code: 'peer_offline', message: 'callee not connected'}};
      }
    }
    const frame = buildFrame(from);
    const target = this.hub.server?.to(this.hub.deviceRoom(to));
    if (volatile && target) {
      target.volatile.emit(frame.event, frame.data);
    } else if (target) {
      target.emit(frame.event, frame.data);
    }
    return undefined;
  }

  private clearTypingTimersFrom(userId: string, deviceId: number): void {
    const prefix = `${userId}:${deviceId}->`;
    for (const [k, t] of this.typingTimers) {
      if (k.startsWith(prefix)) {
        clearTimeout(t);
        this.typingTimers.delete(k);
      }
    }
  }
}

/**
 * Offer that landed while the callee was offline. Persists for ~45s in
 * Redis so the callee's WS-open handler can replay it as a `call.offer`
 * frame the moment they reconnect — pairing with the VoIP push wake
 * gives users the "ring even when not in the app" experience.
 */
interface PendingCallOffer {
  callId: string;
  from:   {userId: string; deviceId: number};
  sdp:    string;
  kind:   'voice' | 'video';
  /** epoch ms — used to skip replay of stale offers. */
  at:     number;
  /**
   * Audit S7 — caller's signed AAD. Pass-through; the relay never
   * verifies. Persisted with the queued offer so the WS-open replay
   * delivers the SAME auth block the original offerer minted (replaying
   * with a stripped auth would force the callee into legacy fallback
   * and re-open the spoof window).
   */
  auth?:  CallOfferAuthBlock;
}

/**
 * Per-callId Redis key for queued offline offers. Previously the key
 * was just `${userId}:${deviceId}` — a SECOND caller dialing the same
 * offline recipient within the 45s TTL silently OVERWROTE the first
 * caller's offer, who then saw nothing while their target rang for
 * the second caller. Scoping by callId means up to N concurrent
 * offers can wait per recipient device. The connect-time drain (see
 * `pendingOfferIndexKey`) enumerates them via a Redis SET and emits
 * each in arrival order.
 */
function pendingOfferKey(userId: string, deviceId: number, callId: string): string {
  return `pending-call-offer:${userId}:${deviceId}:${callId}`;
}
/** SET of callIds with queued offers for a (user,device) pair. */
function pendingOfferIndexKey(userId: string, deviceId: number): string {
  return `pending-call-offer-idx:${userId}:${deviceId}`;
}

// Why: SRV-03 — the drain no longer DELs the index up-front, so this advisory
// claim is what stops two sockets for the same target draining concurrently.
// Short TTL so a holder that crashes mid-drain can't wedge the next ring.
const PENDING_DRAIN_LOCK_TTL_SEC = 10;
function pendingOfferDrainLockKey(userId: string, deviceId: number): string {
  return `pending-call-offer-drain:${userId}:${deviceId}`;
}
function pendingGroupRingDrainLockKey(userId: string): string {
  return `pending-group-ring-drain:${userId}`;
}

/**
 * N-02 — slim missed-call marker (no SDP). The pending offer payload lives only
 * 45s, so the old payload-based `call.missed` emit on reconnect was effectively
 * dead code (the payload had already expired by the time its age crossed the
 * >45s threshold that would have emitted it). This marker carries just enough
 * to render a "Missed call" on reconnect, and lives long enough that a
 * killed/Dozed device that reconnects minutes-to-hours later still learns it
 * missed a call — bounded so markers can't accumulate unboundedly.
 *
 * SYNC-5 — the old flat 6h silently DROPPED the record for any device that
 * stayed offline longer (phone off overnight, plane, OEM battery-kill over a
 * weekend): the connect-time drain reads the marker index, finds nothing, and
 * the call never reaches the Calls log. The marker is slim JSON (~130 B), so
 * hold it for a fraction of the relay's own dwell budget instead.
 *
 * Why the clamp: this marker is the one place the relay holds a cleartext
 * callee→caller tuple, so it must never outlive an actual envelope. Hard-capped
 * at the configured RELAY_DWELL_SECONDS (30d Signal default) and floored at 60s
 * so a typo'd env can neither extend the metadata window past dwell nor
 * disable the feature outright.
 */
function resolveMissedCallMarkerTtlSec(): number {
  const parse = (raw: string | undefined, fallback: number): number => {
    const n = parseInt(raw ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const dwell = parse(process.env['RELAY_DWELL_SECONDS'], 30 * 24 * 3600);
  const want = parse(process.env['MISSED_CALL_MARKER_TTL_SEC'], 7 * 24 * 3600);
  return Math.max(60, Math.min(want, dwell, 30 * 24 * 3600));
}
const MISSED_CALL_MARKER_TTL_SEC = resolveMissedCallMarkerTtlSec();

/**
 * SYNC-5 — with a multi-day marker TTL a device that was offline for a week can
 * come back holding a large backlog. Cap the connect-time `call.missed` /
 * `sfu.ring.missed` burst at the newest N (the overflow is settled — deleted
 * from Redis — in the same drain pass, by design: a 51st week-old missed call
 * has no user value) so one reconnect can't emit hundreds of frames into a
 * cold client.
 */
const MISSED_CALL_DRAIN_EMIT_CAP = 50;
interface MissedCallMarker {
  callId: string;
  from:   {userId: string; deviceId: number};
  kind:   'voice' | 'video';
  at:     number;
}
function missedCallMarkerKey(userId: string, deviceId: number, callId: string): string {
  return `missed-call-marker:${userId}:${deviceId}:${callId}`;
}

/** P1-BR-5 — grace-timer key so a reconnect can cancel the deferred bye. */
function callGraceKey(callId: string, userId: string, deviceId: number): string {
  return `${callId}::${userId}::${deviceId}`;
}

/**
 * FIX-07 — an answer held for a caller device that was mid-reconnect.
 *
 * Every other recoverable call event is Redis-durable (call.offer, call.missed,
 * the group ring); `call.answer` alone lived in a per-process Map, so it was
 * lost on a service restart and invisible to a caller whose reconnect landed on
 * a different replica. The caller then rang on against a call the callee had
 * already picked up.
 *
 * Same shape as the pending-offer lane: a per-(user,device) index SET plus a
 * payload key, both under the ring-window TTL, drained peek → emit → settle.
 */
function pendingAnswerKey(userId: string, deviceId: number, callId: string): string {
  return `pending-call-answer:${userId}:${deviceId}:${callId}`;
}
function pendingAnswerIndexKey(userId: string, deviceId: number): string {
  return `pending-call-answer-idx:${userId}:${deviceId}`;
}

/**
 * P2-BR-9 — group-call ring queued for an offline member. Payload (incl. the
 * per-recipient room token) lives 45s so a quick reconnect rings live; the slim
 * missed-marker outlives it (MISSED_CALL_MARKER_TTL_SEC) so a later reconnect
 * still learns it missed a group call. Group rings target userIds (server has no view of group device
 * membership), so these keys are per-user, not per-device.
 */
interface PendingGroupRing {
  roomId:         string;
  conversationId: string;
  callType:       'voice' | 'video';
  from:           {userId: string; deviceId: number};
  callerName:     string;
  roomToken:      string;
  roomTokenExp:   number;
  at:             number;
  /** B-336 — the fan-out this queued copy belongs to. Optional: rows queued
   *  by a pre-B-336 relay have none, and the client then falls back to the
   *  roomId-only dedup it always used. */
  ringId?:        string;
}
interface MissedGroupCallMarker {
  roomId:         string;
  conversationId: string;
  from:           {userId: string; deviceId: number};
  callType:       'voice' | 'video';
  at:             number;
  /** WI-6.7 — the fan-out this marker belongs to (absent on pre-WI-6.7 rows). */
  ringId?:        string;
}
function pendingGroupRingKey(userId: string, roomId: string): string {
  return `pending-group-ring:${userId}:${roomId}`;
}
function pendingGroupRingIndexKey(userId: string): string {
  return `pending-group-ring-idx:${userId}`;
}
function missedGroupCallMarkerKey(userId: string, roomId: string): string {
  return `missed-group-call-marker:${userId}:${roomId}`;
}

/**
 * Audit P0-T1 — extract `token` and `signalDeviceId` from the socket.io
 * handshake. Preference order:
 *   1. `socket.handshake.auth` — the Socket.IO `auth` payload travels
 *      inside the WebSocket upgrade body (Engine.IO `0{"token":...}`
 *      packet), NOT in the URL. Reverse proxies, CDN access logs, and
 *      browser history don't see it.
 *   2. `socket.handshake.query` — legacy form. The token rides the URL
 *      and ends up in nginx / ALB / Cloudflare access logs. Kept for
 *      one rollout release so old clients still authenticate; emits a
 *      `[P0-T1] handshake_token_via_query` warning so we can spot any
 *      client that hasn't moved over before the fallback is removed.
 *
 * Removal plan: once telemetry shows 100% of connects carry the token
 * via auth, drop the query branch entirely and reject with
 * `missing_token` for any client still using the URL form.
 */
export function extractHandshakeParams(socket: Socket): {token: string | null; signalDeviceId: number | null; source: 'auth' | 'query' | 'none'} {
  const auth = (socket.handshake.auth ?? {}) as Record<string, unknown>;
  const authToken = typeof auth.token === 'string' && auth.token.length > 0 ? auth.token : null;
  const authDevRaw = auth.signalDeviceId;
  const authDev = typeof authDevRaw === 'number' && Number.isFinite(authDevRaw)
    ? authDevRaw
    : (typeof authDevRaw === 'string' ? Number.parseInt(authDevRaw, 10) : NaN);
  if (authToken && Number.isFinite(authDev) && authDev >= 1) {
    return {token: authToken, signalDeviceId: authDev, source: 'auth'};
  }

  const q = socket.handshake.query ?? {};
  const rawToken = Array.isArray(q['token']) ? q['token'][0] : q['token'];
  const rawDev   = Array.isArray(q['signalDeviceId']) ? q['signalDeviceId'][0] : q['signalDeviceId'];
  const token    = typeof rawToken === 'string' && rawToken.length > 0 ? rawToken : null;
  const n        = typeof rawDev === 'string' ? Number.parseInt(rawDev, 10) : NaN;
  const signalDeviceId = Number.isFinite(n) && n >= 1 ? n : null;
  return {token, signalDeviceId, source: token ? 'query' : 'none'};
}

/**
 * socket.io surfaces middleware rejections to the client as
 * `connect_error` with `err.data` attached. We embed the same
 * `{code, message}` shape our other error frames use so the RN client
 * can key off `code === 'unauthorized'` uniformly.
 */
function handshakeError(reason: string): Error & {data: {code: string; message: string}} {
  const code = reason === 'missing_token' || reason === 'missing_signal_device_id'
    ? 'unauthorized'
    : 'unauthorized';
  const err = new Error(reason) as Error & {data: {code: string; message: string}};
  err.data = {code, message: reason};
  return err;
}

function authMissing(): ServerError {
  return {event: 'error', data: {code: 'unauthenticated', message: 'no socket context'}};
}

// AUDIT-2026-08-13 E-1 — map by exception CLASS/status, never message
// substring: the substring form silently broke on any rewording, and two
// of its four alternates ('invalid_ciphertext', 'ciphertext_too_large')
// had NO live throw site anywhere — dead strings posing as coverage. The
// services already throw typed Nest exceptions at every site
// (BadRequestException('invalid_recipient'), ForbiddenException
// ('not_recipient')); the status → code map keeps the wire codes
// byte-identical for those throws and covers future typed throws for free.
export function toWsError(e: unknown): ServerError {
  if (e instanceof HttpException) {
    const s = e.getStatus();
    const code =
      s === 400 ? 'bad_request' :
      s === 403 ? 'forbidden' :
      s === 413 ? 'too_large' :
      s === 429 ? 'rate_limited' :
      'internal';
    return {event: 'error', data: {code, message: e.message}};
  }
  const msg = e instanceof Error ? e.message : String(e);
  return {event: 'error', data: {code: 'internal', message: msg}};
}

function toError(e: unknown): ServerError {
  return toWsError(e);
}

function typingKey(
  from: {userId: string; deviceId: number},
  to:   {userId: string; deviceId: number},
  convTag?: string,
): string {
  // Why: SYNC-6 — keying the auto-stop timer by tag gives a user typing in a
  // group and the 1:1 with the same peer two independent timers instead of
  // the second silently cancelling the first. clearTypingTimersFrom's
  // startsWith(`${userId}:${deviceId}->`) prefix match is unaffected.
  return `${from.userId}:${from.deviceId}->${to.userId}:${to.deviceId}|${convTag ?? ''}`;
}

/** SYNC-6 — accept only a 16-char lowercase hex tag; anything else is dropped. */
function sanitizeConvTag(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[0-9a-f]{16}$/.test(raw) ? raw : undefined;
}

function typingFrame(
  from: {userId: string; deviceId: number},
  state: 'start' | 'stop',
  convTag?: string,
): ServerTyping['data'] {
  return convTag ? {from, state, convTag} : {from, state};
}

/** Strip non-strings, trim, cap at 200 ids per subscribe to bound work. */
function sanitizeUserIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t.length === 0 || t.length > 128) continue;
    out.push(t);
    if (out.length >= 200) break;
  }
  return out;
}
