import type { Socket} from 'socket.io-client';
import {io} from 'socket.io-client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {ClientFrame, ServerFrame} from './protocol';

// Fix #17: persisted recovery PID. socket.io's connectionStateRecovery
// keys missed packets by the session id we hand back as `auth.pid`.
// Holding it in memory only worked for in-process reconnects; an app
// kill-revive (Doze for >2min, force-stop) reopens the socket with no
// pid → server treats it as a brand-new session and drops anything
// that piled up. Persisting to AsyncStorage lets the post-revive
// connect resume the previous session.
const RECOVERY_PID_KEY    = 'bravo:transport:recoveryPid';
// Why: socket.io v4 connectionStateRecovery only triggers when the
// server receives BOTH `auth.pid` and `auth.offset` as strings (see
// namespace.js _createSocket — if offset is missing the server skips
// restoreSession entirely and mints a fresh session). The lib's own
// _lastOffset/_pid tracking lives on the Socket instance and is lost
// the moment we destroy + rebuild the Socket in forceReconnect(), so
// we track + persist offset alongside pid here and hand both back.
const RECOVERY_OFFSET_KEY = 'bravo:transport:recoveryOffset';

// Fix #18: minimum interval between forceReconnect() calls. Two
// AppState-active transitions in close succession (user toggles
// recent-apps-and-back) used to fire two full handshakes inside
// 200ms. Throttle here so we don't chatter the auth service.
const RECONNECT_THROTTLE_MS = 2_000;

/**
 * B-100/B-101 — how long before the access token's `exp` we start
 * renewing it. The access token lives 15 min and its `jti` allowlist key
 * dies with it; once that key is gone the gateway's 60s P0-6 sweep
 * disconnects the socket, which kills any live call (12s disconnect-bye
 * / 10s SFU leave grace). 5 min of lead covers the sweep period plus a
 * slow refresh round-trip on a bad network with room to spare.
 */
const TOKEN_REFRESH_LEAD_MS = 5 * 60_000;

/**
 * Floor between re-auth attempts so a failing refresh can't storm the
 * auth service — inbound frames (which drive the check) can arrive many
 * times per second on a busy socket.
 */
const REAUTH_RETRY_FLOOR_MS = 5_000;

/**
 * Review F1/TR-3 — how long a renewal may be "in flight" before we treat
 * the guard as stuck and allow a fresh attempt.
 *
 * The in-flight flag is cleared when the emit's promise settles, but
 * `emitWithAck`'s own reject timer is a `setTimeout` — frozen while the
 * screen is locked. If the socket dies between emit and ack, socket.io
 * drops the pending ack callback and nothing ever settles, so a boolean
 * latch would silently disable renewal for the rest of the call. A
 * wall-clock expiry cannot latch: worst case we retry a little early.
 */
const REAUTH_STUCK_MS = 30_000;

/**
 * Round 1 P1 (WI-5.1) — how long the unauthorized-refresh in-flight flag is
 * believed. Same rationale as REAUTH_STUCK_MS one screen up: refreshToken()
 * is an HTTP call with no guaranteed settlement (half-open TCP hangs for
 * minutes; RN freezes its timeout timers while locked), and a bare boolean
 * latch would make the WI-5.1 benign branch a permanent invisible
 * reconnecting-strand that even forceReconnect() cannot clear (its reopen
 * lands right back in the same branch). A stale flag falls through to a
 * FRESH counted refresh attempt instead.
 */
const UNAUTH_REFRESH_STUCK_MS = 30_000;

/**
 * Review TR-1 — floor between IMMEDIATE (timer-free) reconnect attempts.
 * The fast path is re-armed by every successful connect, so without an
 * independent wall-clock floor a connect→drop→connect flap (rolling
 * redeploy, LB draining, AP roam) would re-handshake at RTT cadence with
 * no backoff at all. 2s matches forceReconnect's own throttle window.
 */
const IMMEDIATE_REOPEN_FLOOR_MS = 2_000;

/**
 * Notif-latency E2 (docs/audits/NOTIF_TAP_TO_MESSAGE_LATENCY_2026-08-01.md) —
 * minimum remaining life a stored access token needs to be worth
 * handshaking with. Below this, doOpen() spends one HTTP refresh BEFORE
 * building the socket; a cold boot used to handshake with the expired
 * on-disk token, get rejected, and only then refresh — a guaranteed-wasted
 * roundtrip the user watched as "Connecting… → Reconnecting…". SECONDS on
 * purpose, not TOKEN_REFRESH_LEAD_MS: a token with a minute left still
 * handshakes fine (in-place renewal owns mid-life rotation), and a wider
 * window would rotate the jti on every routine reopen.
 */
const HANDSHAKE_MIN_TTL_MS = 30_000;

/**
 * Review RT-1 — how long without ANY inbound signal from the server
 * before we consider the socket dead. The server heartbeats every ~25s
 * (WS_HEARTBEAT_MS), so 40s is one missed beat plus slack. This is the
 * liveness evidence that works while the screen is locked, where the
 * app-level 4s pong heartbeat (a frozen interval) tells us nothing.
 */
export const SERVER_SILENCE_DEAD_MS = 40_000;

/**
 * Read the `exp` claim (ms since epoch) out of a JWT without verifying
 * it. This is scheduling metadata only — the token is verified by the
 * server on every use; a tampered `exp` can only make the client renew
 * too eagerly, never extend a session. Returns 0 when the token is
 * absent or unparseable, which disables proactive renewal (the old
 * reactive paths still apply).
 */
function decodeJwtExpMs(token: string | null | undefined): number {
  if (!token) {return 0;}
  const parts = token.split('.');
  if (parts.length < 2) {return 0;}
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as {exp?: unknown};
    if (typeof payload.exp === 'number') {return payload.exp * 1000;}
  } catch {
    /* fall through to the warning below */
  }
  // Review TR-4 — returning 0 silently disables in-place renewal for the
  // whole socket, which would look exactly like the bug this fixes. Say
  // so once per occurrence; never log the token itself.
  console.warn('[transport] access token carries no readable exp — in-place re-auth disabled for this socket');
  return 0;
}

/**
 * Connection-state machine surfaced to UI (status badge, reconnect toast, etc).
 */
export type TransportState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unauthorized'
  // B-11 — single-device takeover: a newer session for the same
  // (user, device) connected and the server evicted this one. We do
  // NOT reconnect (that would ping-pong the kick), so this is a
  // distinct terminal-ish state, not a transient 'disconnected'.
  | 'superseded';

export interface TransportOptions {
  /**
   * Base URL for the messenger-service host — e.g.
   * `http://10.0.2.2:3100` for Android emulator. The socket.io client
   * appends `/ws` as the handshake path (see `path` option below).
   */
  url: string;
  /** Signal device id — required by the server to route envelopes. */
  signalDeviceId: number;
  /** Called before each connect attempt. Return null to abort. */
  getToken: () => Promise<string | null>;
  /**
   * Round 2 fix: when the server emits an `error{code:'unauthorized'}`
   * frame (token expired mid-WS-session), drive a single-flight
   * refresh and reconnect — instead of stranding the WS in
   * `unauthorized` until the user manually restarts. Optional so the
   * old behaviour (stop retrying) remains the default.
   */
  refreshToken?: () => Promise<void>;
  /**
   * B-354 — mark this connection as a BACKGROUND (headless/no-UI) socket.
   * Travels as `bg:'1'` in the handshake auth payload; the gateway then
   * keeps the socket out of user-visible presence (no 'online' assert, its
   * `presence` frames ignored). Without it, the killed-app headless drain's
   * socket painted the user green "Online"/"Active now" to every watcher
   * seconds after a message arrived. Old servers ignore the field.
   */
  background?: boolean;
  /** Fires for every authenticated server frame. */
  onFrame: (frame: ServerFrame) => void;
  /** Optional — receive state transitions for UI surfaces. */
  onStateChange?: (state: TransportState) => void;
  /** Max backoff between reconnect attempts. Defaults to 30s. */
  maxBackoffMs?: number;
  /**
   * B-101 LC-1/LC-2 — "is a voice/video call live right now?".
   *
   * When it is, a dropped socket must be re-opened IMMEDIATELY and
   * without touching a timer: RN freezes JS timers while the screen is
   * locked, and the server ends the call 12s (1:1 disconnect-bye) / 10s
   * (SFU leave grace) after the socket dies. When no call is live the
   * ordinary jittered backoff applies — a service redeploy drops every
   * client at once, so unconditional immediate retries would stampede
   * the gateway (the exact thundering herd B-14's jitter exists to
   * prevent). Optional: omitted → always use the backoff.
   */
  hasLiveCall?: () => boolean;
  /**
   * OR-2 — "is there an unacked outbound message right now?".
   *
   * Same rationale as `hasLiveCall`, for the send path: a message handed
   * to a half-dead fd has only frozen timers left to rescue it, so the
   * one reconnect attempt that can still run (from the `disconnect`
   * event, which IS delivered while locked) must not be call-only.
   * Optional: omitted → unchanged behaviour.
   */
  hasPendingOutbound?: () => boolean;
  /**
   * OR-2 — fires on EVERY inbound signal from the server: application
   * frames AND the engine.io protocol ping socket.io's Manager re-emits.
   * This is the only clock that keeps running while RN has the JS timer
   * queue frozen, so background send-recovery work (outbox drain) must
   * hang off it rather than a `setInterval`. Callers MUST throttle — this
   * fires once per frame. Errors are swallowed.
   */
  onServerSignal?: () => void;
}

/**
 * Authenticated, self-healing socket.io client.
 *
 * Wraps `socket.io-client` so the app code keeps talking in terms of
 * `{event, data}` frames and a simple state machine. The server runs
 * socket.io 4.x + the Redis adapter, so any replica in the cluster can
 * service this connection transparently.
 *
 * Transport: `['websocket']` only — we skip long-polling for lean mobile
 * wire + faster connect. socket.io-client handles reconnection,
 * heartbeats, and buffering automatically; the state machine below just
 * maps its lifecycle events to UI-friendly labels.
 */
export class TransportClient {
  private socket: Socket | null = null;
  private _state: TransportState = 'disconnected';
  private closedByUser = false;
  // Socket.io v4.6+ recovery handle. The server's
  // `connectionStateRecovery` config buffers missed packets for the
  // session id captured here; on reopen we hand it back via `auth.pid`
  // so the server replays anything we missed (typing, presence, calls
  // mid-handshake) instead of dropping them. Without this every reopen
  // is a fresh session and the screen-lock-then-resume flow shows the
  // user a stuck "Reconnecting…" banner.
  //
  // Fix #17: persist this to AsyncStorage so the kill-revive case
  // (app force-stopped or Doze-killed for >2min) can still resume
  // via connectionStateRecovery on next open.
  private recoveryPid: string | null = null;
  // socket.io v4 appends the packet offset as the trailing arg of every
  // emit when recovery is enabled. Capture it from onAny so we can pass
  // it back on the next handshake (`auth.offset`) — without it the
  // server refuses to restore the session.
  private recoveryOffset: string | null = null;
  /**
   * Round 2 fix: single-flight guard for the unauthorized-refresh path.
   * Without it, two `error{unauthorized}` frames arriving back-to-back
   * (server emits the error then closes the socket; on the next
   * reconnect we get the same error again before refresh completes)
   * would each kick off a refresh. With this guard the second one
   * coalesces into a no-op while the first is still in flight.
   */
  private unauthorizedRefreshInFlight = false;
  /** Round 1 P1 — wall-clock companion to the in-flight flag; see UNAUTH_REFRESH_STUCK_MS. */
  private unauthorizedRefreshStartedAt = 0;
  /**
   * B-05 / JWT-secret-drift — count of consecutive auth-reject→refresh cycles
   * with NO successful connect in between. When refresh keeps SUCCEEDING but the
   * server still rejects the fresh token (e.g. JWT_ACCESS_SECRET drift between
   * auth and messenger), the inFlight guard alone loops forever; this cap stops
   * the refresh storm and surfaces a visible 'unauthorized' instead of an endless
   * 'reconnecting'. Reset on a successful connect and on forceReconnect().
   */
  private unauthorizedRefreshAttempts = 0;
  private static readonly MAX_UNAUTH_REFRESH = 4;
  /**
   * B-11 — `code` of the most recent server `error` frame. The server
   * sends `error{code:'superseded'}` immediately before it evicts the
   * older socket on a single-device takeover; capturing it lets the
   * `disconnect` handler tell a takeover apart from a transient
   * server-side drop. Cleared on every successful (re)connect.
   */
  private lastServerErrorCode: string | null = null;
  /**
   * B-14 — backoff timer + attempt counter for the manual reconnect we
   * drive after a NON-takeover `io server disconnect` (server restart,
   * idle reap, crash — B-05). socket.io deliberately does NOT
   * auto-reconnect after a server-initiated disconnect, so without this
   * the messenger transport stayed dead (zero recv.enter) until the app
   * was restarted. Reset on every successful (re)connect.
   */
  private serverReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private serverReconnectAttempts = 0;
  /**
   * FIX-03 — the device radio is down, so there is nothing to reconnect TO.
   * Set by the host (which owns the NetInfo subscription and the live-call
   * veto); cleared by notifyNetworkChange() when connectivity returns.
   *
   * Parking only stops the AUTOMATIC ladder — the B-14 timer and socket.io's
   * own retry loop. It never closes a socket: NetInfo lies often enough
   * (captive-portal probes, band changes) that acting on it destructively is
   * how a healthy in-call socket gets torn down. An explicit connect() or
   * forceReconnect() still goes through.
   */
  private networkDown = false;
  /**
   * B-100/B-101 — `exp` (ms) of the access token THIS SOCKET is currently
   * authenticated with, and the single-flight/floor guards for renewing
   * it. Updated only when the server ACKs an `auth.refresh`, so a failed
   * renewal is naturally retried on the next inbound frame instead of
   * being silently forgotten. 0 = unknown (renewal disabled).
   */
  private socketTokenExpMs = 0;
  private reauthInFlight = false;
  private reauthStartedAt = 0;
  private lastReauthAttemptAt = 0;
  private reauthFailureStreak = 0;
  /** Review TR-1 — wall-clock floor for the timer-free reconnect path. */
  private lastImmediateReopenAt = 0;
  /**
   * Review RT-1 — wall-clock of the last inbound signal of ANY kind from
   * the server (application frame or engine.io heartbeat). Unlike the
   * app-level pong clock this keeps advancing while the screen is
   * locked, so it is the only trustworthy liveness evidence available to
   * a background decision (see `msSinceServerSignal`).
   */
  private lastServerSignalAt = 0;
  /**
   * Removes our listener from socket.io's shared Manager (which outlives
   * individual sockets, so the subscription must be swapped, not stacked,
   * on every reopen). See the binding site for why the Manager's 'ping'
   * is the only renewal clock that survives a locked screen.
   */
  private managerPingOff: (() => void) | null = null;
  /**
   * Fix #18: wall-clock of the most recent successful 'connect'
   * event — used to throttle forceReconnect() so a flurry of
   * AppState transitions inside ~2s don't burn N handshakes.
   */
  private lastConnectedAt = 0;
  /** WI-5.7 (G8) — wall-clock of the last PUBLIC forceReconnect that ran while not connected. */
  private lastForceReconnectAt = Number.NEGATIVE_INFINITY;
  /**
   * Audit fix 5.1 — secondary frame listeners. The main `opts.onFrame`
   * is the runtime's central dispatcher; this set lets specific
   * screens (LiveTrackingScreen, ops-console live page) plug in their
   * own per-screen listener without monkey-patching the runtime.
   * Listener errors are swallowed — one buggy screen mustn't block
   * the rest.
   */
  private readonly frameListeners = new Set<(frame: ServerFrame) => void>();
  /**
   * B-05 — reconnect listeners. Fired when the socket RE-connects (not on
   * the first connect). Group-call boot subscribes here so it can re-join
   * the SFU room after the server's P0-6 revoked-socket sweep drops + the
   * refresh path reopens the WS — the SFU tore the room/transports down on
   * disconnect, so an ICE restart over the new socket would never recover.
   * Errors are swallowed so one buggy subscriber can't block the rest.
   */
  private readonly reconnectListeners = new Set<() => void>();
  /**
   * WI-5.3 (round 1 P1) — one-shot listeners for the NEXT time the socket is
   * genuinely up. onReconnect deliberately skips the first connect of a
   * client (B-05), which is correct for a socket that reopens — but a runtime
   * rebuild constructs a NEW client, whose first connect IS the moment a
   * re-bound consumer (the group rejoin hub) must act. Fired once and
   * cleared; close() drops them with the rest of the subscriptions.
   */
  private readonly onceConnectedListeners = new Set<() => void>();
  /**
   * B-05 — true once the very first 'connect' has fired. Lets the connect
   * handler distinguish the initial connect (no rejoin needed) from a
   * genuine reconnect (rejoin required).
   */
  private hasConnectedOnce = false;
  /**
   * P1-12 — single-flight guard for open(). Two reopen triggers inside
   * open()'s async window (the 5 s send-ack watchdog racing an
   * AppState-`active` reconnect, both suspended at `await getToken()`)
   * each used to build a socket; the first became an orphan with live
   * listeners and the gateway then evicted one as `superseded`, dumping
   * the user to the login screen. Concurrent callers now coalesce onto
   * the one in-flight open promise.
   */
  private openInFlight: Promise<void> | null = null;
  /**
   * P1-12 — connect generation. Bumped at the start of every doOpen()
   * (and on close()); a suspended async continuation re-checks it after
   * each await and bails — tearing down any socket it managed to build —
   * if a newer connect superseded it, so a stale continuation can never
   * install an orphan socket.
   */
  private connectGeneration = 0;

  constructor(private readonly opts: TransportOptions) {}

  get state(): TransportState {
    return this._state;
  }

  async connect(): Promise<void> {
    this.closedByUser = false;
    await this.open();
  }

  send(frame: ClientFrame): void {
    if (!this.socket?.connected) {
      throw new Error('transport not open');
    }
    // socket.io dispatches by event name; server handlers are mounted
    // via @SubscribeMessage(<event>) and receive `data` verbatim.
    this.socket.emit(frame.event, (frame as {data?: unknown}).data ?? {});
  }

  /**
   * Fire-and-forget control frame (presence / room subscribe-unsubscribe / activity)
   * that is SAFE to drop when the socket is closed: these subscriptions are explicitly
   * re-established on the next `open` transition (see onReconnect + the per-screen hooks),
   * so a send against a closed transport must NOT throw. Left un-guarded, the throw escapes
   * a React effect (e.g. useMissionEvents → subscribeMission) into the app's ErrorBoundary
   * and crashes the whole app. Mirrors sendReadReceipt's best-effort semantics.
   */
  private bestEffortSend(frame: ClientFrame): void {
    try {
      this.send(frame);
    } catch {
      /* socket not open — the subscription re-subscribes on reconnect. */
    }
  }

  /**
   * Emit an event with a socket.io-style ack callback. SFU group-call
   * flows lean on this — `Device.createSendTransport.on('produce', cb)`
   * needs a producerId back from the server before mediasoup-client
   * proceeds. The ack timeout matches socket.io's default.
   */
  emitWithAck<T>(event: string, data: unknown, timeoutMs = 15_000): Promise<T> {
    if (!this.socket?.connected) {
      return Promise.reject(new Error('transport not open'));
    }
    const sock = this.socket;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`ack_timeout:${event}`)), timeoutMs);
      sock.emit(event, data, (resp: unknown) => {
        clearTimeout(t);
        // Audit SFU-01: the server now returns an event-less {ok:false,data}
        // on error so NestJS actually invokes this ack (an {event} return is
        // emitted-not-acked). Reject on ok===false; keep the legacy
        // event==='sfu.error' branch so a transitional server still parses.
        const r = resp as {ok?: boolean; event?: string; data?: {message?: string}};
        if (r && (r.ok === false || r.event === 'sfu.error')) {
          reject(new Error(r.data?.message ?? 'sfu_error'));
        } else {
          resolve(resp as T);
        }
      });
    });
  }

  /**
   * Subscribe to a list of users' live presence. The server emits a
   * `presence` snapshot for every id in the list, then streams
   * subsequent transitions. Idempotent — resubscribing is safe.
   */
  subscribePresence(userIds: string[]): void {
    if (userIds.length === 0) {return;}
    this.bestEffortSend({event: 'presence.subscribe', data: {userIds}});
  }

  unsubscribePresence(userIds: string[]): void {
    if (userIds.length === 0) {return;}
    this.bestEffortSend({event: 'presence.unsubscribe', data: {userIds}});
  }

  /**
   * Audit fix 5.1 — subscribe to a mission's lifecycle channel. The
   * gateway joins this socket to a `mission:<id>` room; the server
   * pushes `mission.status` / `mission.team` / `mission.telemetry`
   * frames through the existing `onFrame` callback, so the consumer
   * just adds another branch in their frame switch.
   *
   * Idempotent — resubscribing is harmless. Survives the WS reconnect:
   * socket.io's connectionStateRecovery replays the room membership
   * inside the recovery window; outside that, the client should
   * resubscribe on the next `state === 'open'` transition.
   */
  subscribeMission(missionId: string): void {
    if (!missionId) {return;}
    this.bestEffortSend({event: 'mission.subscribe', data: {missionId}});
  }

  unsubscribeMission(missionId: string): void {
    if (!missionId) {return;}
    this.bestEffortSend({event: 'mission.unsubscribe', data: {missionId}});
  }

  /**
   * Audit fix 5.1 — per-screen frame listener registration. Returns an
   * unsubscribe function. The listener fires AFTER the runtime's main
   * `onFrame` callback so any state updates from the runtime have
   * already landed before screen-level state updates.
   */
  addFrameListener(fn: (frame: ServerFrame) => void): () => void {
    this.frameListeners.add(fn);
    return () => { this.frameListeners.delete(fn); };
  }

  /**
   * B-05 — subscribe to socket RE-connect events. The callback fires on
   * every successful 'connect' AFTER the first one (i.e. a reopen following
   * a drop), never on the initial connect. Returns an unsubscribe fn.
   */
  /**
   * WI-5.3 — fire once when the socket is next up. If it is up NOW, fires
   * synchronously. Returns an unsubscribe for the not-yet-fired case.
   */
  onceConnected(fn: () => void): () => void {
    if (this._state === 'connected' && this.socket?.connected) {
      try { fn(); } catch { /* consumer fault — not ours */ }
      return () => { /* already fired */ };
    }
    this.onceConnectedListeners.add(fn);
    return () => { this.onceConnectedListeners.delete(fn); };
  }

  onReconnect(fn: () => void): () => void {
    this.reconnectListeners.add(fn);
    return () => { this.reconnectListeners.delete(fn); };
  }

  /**
   * Report the local app's foreground/background state so the server
   * refines presence from `online` to `active` / `away`. Clients should
   * call this on app state transitions (AppState 'active' / 'background').
   */
  setActivity(state: 'active' | 'away'): void {
    this.bestEffortSend({event: 'presence', data: {state}});
  }

  /**
   * Tell `peer`'s connected devices that we've read the listed
   * envelopes. The server fans this out only to that peer, leaving
   * Sealed Sender semantics intact for everyone else. Best-effort:
   * if the socket is not open, the receipt is dropped.
   */
  sendReadReceipt(peer: {userId: string; deviceId: number}, envelopeIds: string[]): void {
    if (envelopeIds.length === 0) {return;}
    try {
      this.send({event: 'read-receipt', data: {to: peer, envelopeIds}});
    } catch { /* socket not open — best effort */ }
  }

  close(): void {
    this.closedByUser = true;
    // P1-12 — invalidate any doOpen() continuation still suspended at an
    // await so it can't install a socket after this close.
    this.connectGeneration++;
    // B-14 — cancel any pending manual reconnect so a user-initiated
    // close (logout) isn't undone by a queued backoff retry.
    if (this.serverReconnectTimer) {
      clearTimeout(this.serverReconnectTimer);
      this.serverReconnectTimer = null;
    }
    this.serverReconnectAttempts = 0;
    // B-100/B-101 — drop the Manager-level renewal listener; it is not
    // owned by the socket, so socket.disconnect() would leave it behind
    // (a logout must not leave a listener holding this instance alive).
    try { this.managerPingOff?.(); } catch { /* already gone */ }
    this.managerPingOff = null;
    this.socketTokenExpMs = 0;
    if (this.socket) {
      try { this.socket.disconnect(); } catch { /* ignore */ }
      this.socket = null;
    }
    // Fix #17: clear the persisted recovery pid on a USER-initiated
    // close (logout, forceClose). Without this, next session's open()
    // would replay against an authenticated-as-previous-user pid and
    // the server's recovery check would either miss (harmless) or, in
    // the worst case, hand back stale state. Don't clear in transient
    // disconnect paths (`socket.disconnect` events) — those preserve
    // the pid so reconnect can resume.
    this.recoveryPid    = null;
    this.recoveryOffset = null;
    AsyncStorage.removeItem(RECOVERY_PID_KEY).catch(() => { /* non-fatal */ });
    AsyncStorage.removeItem(RECOVERY_OFFSET_KEY).catch(() => { /* non-fatal */ });
    // WI-5.2 (transport G7) — a closed client is a CORPSE, and a stale holder
    // calling forceReconnect() on it used to revive it with every old
    // listener still attached: the revival's first 'connect' then fired
    // `reconnectListeners` immediately (hasConnectedOnce was still true from
    // the previous life) — a group rejoin against a brand-new session, and
    // frame listeners from screens of the PREVIOUS session double-dispatching
    // alongside the new client's. A close ends the subscriptions with the
    // session: whoever legitimately revives this client re-subscribes, and
    // the first connect of the new life is a first connect, not a reconnect.
    this.frameListeners.clear();
    this.onceConnectedListeners.clear();
    this.reconnectListeners.clear();
    this.hasConnectedOnce = false;
    this.setState('disconnected');
  }

  /**
   * Force a fresh connection — used on app foreground when the OS may
   * have silently killed the socket fd while we were backgrounded. Just
   * calling `connect()` isn't enough because socket.io may still report
   * `socket.connected === true` against a dead socket. Tearing the
   * existing socket down and starting over guarantees a real session.
   * Preserves the recovery PID so the server replays anything we missed
   * via connectionStateRecovery.
   *
   * Fix #18: throttle. If a real handshake completed less than
   * RECONNECT_THROTTLE_MS ago, skip the rebuild — the socket is
   * almost certainly fine. Two AppState 'active' transitions in
   * close succession (notification swipe, recents-and-back) used
   * to fire two full handshakes inside 200ms.
   */
  async forceReconnect(): Promise<void> {
    // WI-5.7 (transport G8) — the missing wall-clock floor for the
    // NOT-connected side. reopenNow() below keeps the Fix #18 healthy-socket
    // throttle; while 'reconnecting'/'disconnected' every public call used
    // to run a full handshake, so a flurry of AppState transitions (or a
    // stale holder hammering a corpse) re-handshook at call cadence. Only
    // the PUBLIC surface is floored: the internal recovery paths (the B-14
    // ladder, notifyNetworkChange, the SEC-1 reauth reopen) each carry
    // their own pacing and call reopenNow() directly — flooring them would
    // stall the ladder, whose retry is only re-armed by connection events.
    // A floored call coalesces onto an in-flight open when one exists;
    // with none, it returns having done nothing — the internal recovery
    // machinery (ladder / socket.io retry) still owns the outcome.
    if (this._state !== 'connected') {
      const now = Date.now();
      if (now - this.lastForceReconnectAt < RECONNECT_THROTTLE_MS) {
        if (this.openInFlight) { await this.openInFlight; }
        return;
      }
      this.lastForceReconnectAt = now;
    }
    await this.reopenNow();
  }

  /**
   * WI-5.7 — the reopen body forceReconnect() always had, including the
   * Fix #18 healthy-socket throttle the internal callers rely on (the SEC-1
   * reauth reopen counts on a recent connect making this a no-op). The
   * public forceReconnect() is now the floored wrapper above.
   */
  private async reopenNow(): Promise<void> {
    if (this._state === 'connected' && Date.now() - this.lastConnectedAt < RECONNECT_THROTTLE_MS) {
      return;
    }
    this.closedByUser = false;
    this.unauthorizedRefreshAttempts = 0;
    this.setState('connecting');
    // P1-12 — route through the single-flight open(). doOpen() performs the
    // prior-socket teardown itself, and a reopen that races an in-flight
    // open() coalesces onto that attempt instead of building a second
    // socket the gateway then evicts as `superseded`.
    await this.open();
  }

  /**
   * Called by the runtime when NetInfo reports a network type change
   * (Wi-Fi ↔ cellular handover, captive portal flip, etc). The TCP
   * sockets bound to the old route are dead the moment the kernel
   * destroys them, but socket.io's default backoff is ~30s — far too
   * slow for an active call. We short-circuit it.
   *
   * Behaviour:
   *  • If we believe we're connected, the OS handover already nuked the
   *    socket layer but socket.io's heartbeat (~25s ping) hasn't noticed
   *    yet — force a fresh handshake on the new route (throttled by
   *    forceReconnect()'s 2s window).
   *  • If we're NOT connected (reconnecting / connecting / a transient
   *    refresh failure), the network just came back: reconnect NOW
   *    instead of waiting out socket.io's up-to-30s backoff or a pending
   *    B-14 retry timer.
   *  • A takeover ('superseded') or user close never auto-reconnects.
   */
  /**
   * FIX-03 — the host observed the radio go down. Stop the automatic retry
   * ladder until it comes back; burning a handshake every 30s against a dead
   * radio costs battery and buys nothing.
   *
   * The host must NOT call this while a call is live — NetInfo false alarms
   * are common enough that trusting one over an in-flight call is a worse bug
   * than the one this fixes.
   */
  setNetworkDown(): void {
    if (this.networkDown || this.closedByUser) {return;}
    this.networkDown = true;
    if (this.serverReconnectTimer) {
      clearTimeout(this.serverReconnectTimer);
      this.serverReconnectTimer = null;
    }
    try { this.socket?.io?.reconnection(false); } catch { /* older manager shape */ }
    // Audit (FIX-03 round 2) — park stops the RETRY LADDER, it does not decide
    // what the socket is. A false NetInfo alarm parks a socket that is still
    // healthily connected; flipping _state to 'disconnected' then made the
    // correction event seconds later force-rebuild it (pongFresh reads
    // state === 'connected', now structurally false) — dropping in-flight acks,
    // the exact churn the pongFresh filter exists to prevent. Keep 'connected'
    // truthful; if the radio really is gone the socket's own 'disconnect'
    // event lands within a heartbeat and re-enters here via
    // scheduleServerReconnect, which reports 'disconnected' honestly.
    // 'reconnecting' with nothing in flight is equally a lie ("almost back").
    if (this._state !== 'superseded' && this._state !== 'unauthorized' && this._state !== 'connected') {
      this.setState('disconnected');
    }
  }

  /** FIX-03 — true while the ladder is parked for a down radio. */
  isNetworkParked(): boolean { return this.networkDown; }

  async notifyNetworkChange(): Promise<void> {
    if (this.closedByUser) {return;}
    // Un-park first: everything below wants to actually reach the network.
    if (this.networkDown) {
      this.networkDown = false;
      try { this.socket?.io?.reconnection(true); } catch { /* older manager shape */ }
      // A parked ladder never counted attempts against the new route.
      this.serverReconnectAttempts = 0;
    }
    // B-11 — re-grabbing the (user, device) slot would ping-pong the kick
    // back to the device that just took over.
    if (this._state === 'superseded') {return;}
    if (this._state !== 'connected') {
      // Fast-path reconnect on network restore: cancel the pending B-14
      // backoff so the immediate attempt isn't followed by a stale
      // long-delay retry, and reset its step counter — the route change
      // means the old failure streak says nothing about the new route.
      if (this.serverReconnectTimer) {
        clearTimeout(this.serverReconnectTimer);
        this.serverReconnectTimer = null;
      }
      this.serverReconnectAttempts = 0;
      await this.reopenNow();
      return;
    }
    await this.reopenNow();
  }

  /**
   * B-100/B-101 — keep the LIVE socket's credentials fresh so it is never
   * disconnected for holding an expired/rotated token.
   *
   * Why this is driven by inbound frames rather than a timer: React
   * Native freezes JS timers while the Android host activity is paused,
   * which is exactly the locked-screen state where calls were dying. WS
   * message delivery keeps waking JS (the server pings every ~25s), so
   * hanging renewal off the inbound path means it still runs with the
   * screen off — the one thing a `setInterval` could not do.
   *
   * Flow: if the socket's token is within `TOKEN_REFRESH_LEAD_MS` of
   * expiry, adopt an already-fresher stored token if some other code
   * path (an HTTP 401 refresh) produced one, otherwise refresh over
   * HTTP; then hand the token to the gateway via `auth.refresh`, which
   * re-verifies it and swaps the socket's claims WITHOUT a disconnect.
   * `socketTokenExpMs` advances only on a server ACK, so any failure is
   * retried on the next frame (subject to `REAUTH_RETRY_FLOOR_MS`).
   */
  private maybeRenewSocketAuth(): void {
    if (this.closedByUser) {return;}
    const now = Date.now();
    // Review F1/TR-3 — a wall-clock guard, never a bare boolean: an ack
    // lost while the screen is locked never settles (its reject timer is
    // frozen), and a latched flag would kill renewal for the whole call.
    if (this.reauthInFlight && now - this.reauthStartedAt < REAUTH_STUCK_MS) {return;}
    if (this._state !== 'connected' || !this.socket?.connected) {return;}
    if (this.socketTokenExpMs <= 0) {return;}
    if (this.socketTokenExpMs - now > TOKEN_REFRESH_LEAD_MS) {return;}
    // Review TR-2 — the floor grows with consecutive failures so a
    // server that keeps refusing (or a broken refresh endpoint) cannot
    // be hammered once per inbound heartbeat.
    const floor = REAUTH_RETRY_FLOOR_MS * Math.min(1 + this.reauthFailureStreak, 6);
    if (now - this.lastReauthAttemptAt < floor) {return;}
    this.lastReauthAttemptAt = now;
    this.reauthStartedAt = now;
    this.reauthInFlight = true;
    void (async () => {
      let spentRefresh = false;
      try {
        let token = await this.opts.getToken();
        let exp = decodeJwtExpMs(token);
        // Another path may already have refreshed (HTTP 401 interceptor).
        // Only spend a refresh round-trip when the stored token is not
        // itself comfortably fresh. Doing so also avoids needlessly
        // rotating — and thereby REVOKING — the jti this socket is
        // currently pinned to (review SEC-1).
        if (exp - Date.now() < TOKEN_REFRESH_LEAD_MS) {
          if (!this.opts.refreshToken) {return;}
          await this.opts.refreshToken();
          spentRefresh = true;
          token = await this.opts.getToken();
          exp = decodeJwtExpMs(token);
        }
        if (!token || exp <= 0) {return;}
        if (this._state !== 'connected' || !this.socket?.connected) {return;}
        await this.emitWithAck<{ok?: boolean}>('auth.refresh', {token}, 10_000);
        // emitWithAck resolves only on ok; a server refusal arrives as a
        // rejection (review TR-5) and is handled below.
        this.socketTokenExpMs = exp;
        this.reauthFailureStreak = 0;
      } catch {
        this.reauthFailureStreak++;
        // Review SEC-1 — if we already spent the HTTP refresh, the token
        // rotation has ALREADY revoked the jti this socket is pinned to,
        // so staying put means waiting to be killed by the revocation
        // sweep (fatal mid-call). A fresh handshake with the new token
        // is the fast, safe recovery, and reconnecting cancels the
        // server's pending call-disconnect bye. Throttled by the same
        // immediate-reopen floor that protects the reconnect path.
        if (spentRefresh && !this.closedByUser
            && Date.now() - this.lastImmediateReopenAt > IMMEDIATE_REOPEN_FLOOR_MS) {
          this.lastImmediateReopenAt = Date.now();
          void this.reopenNow().catch(() => { /* state machine surfaces it */ });
        }
      } finally {
        this.reauthInFlight = false;
      }
    })();
  }

  /**
   * Review RT-1 — milliseconds since ANY inbound signal from the server
   * (application frame or engine.io heartbeat), or `Infinity` when the
   * socket has never been up. Callers that must judge socket liveness
   * while the app is BACKGROUNDED use this: the app-level pong clock is
   * driven by a frozen interval and is always stale there, which made
   * connectivity flaps tear down healthy in-call sockets.
   */
  msSinceServerSignal(): number {
    if (this.lastServerSignalAt <= 0) {return Number.POSITIVE_INFINITY;}
    return Date.now() - this.lastServerSignalAt;
  }

  /** OR-2 — notify the runtime that the server was heard from. Never throws. */
  private fireServerSignal(): void {
    if (this.closedByUser) {return;}
    try { this.opts.onServerSignal?.(); } catch { /* subscriber fault — keep the socket healthy */ }
  }

  /**
   * OR-2 — may this drop take the timer-free reopen path? A live call
   * (B-101) or an unacked outbound message are the two states where the
   * ordinary (RN-frozen) backoff timer is not good enough.
   */
  private needsImmediateReopen(): boolean {
    try {
      return !!(this.opts.hasLiveCall?.() || this.opts.hasPendingOutbound?.());
    } catch { return false; }
  }

  /**
   * Shared auth-reject handler for both the handshake `connect_error` path and
   * the mid-session `error{unauthorized|token_revoked}` frame. Returns true when
   * it took ownership (kicked a single-flight refresh, or tripped the attempt cap
   * and surfaced 'unauthorized'); false when the caller should run its own
   * fallback (no refresh hook wired, or a refresh is already in flight).
   */
  private handleAuthReject(socket: {disconnect: () => void}): boolean {
    // WI-5.1 (transport G1) — a SECOND reject while the refresh is still in
    // flight is the NORMAL shape of this failure (the server emits the error,
    // closes the socket, and socket.io's retry with the same stale token is
    // rejected again before the refresh resolves). It used to return false
    // here, lumped together with "no refresh hook wired" — and the inline
    // error-frame caller's fallback for false is TERMINAL
    // (closedByUser + 'unauthorized'), so the resolving refresh then bailed
    // at doOpen's closedByUser check: a permanent strand, mid-call death at
    // the grace timer. Own the case instead: stay benignly 'reconnecting',
    // drop this socket (the refresh's open() builds the fresh one), and
    // return true so NEITHER caller runs its fallback. `false` now means
    // exactly one thing: no refresh hook is wired.
    if (this.opts.refreshToken && this.unauthorizedRefreshInFlight
        && Date.now() - this.unauthorizedRefreshStartedAt < UNAUTH_REFRESH_STUCK_MS) {
      this.setState('reconnecting');
      try { socket.disconnect(); } catch { /* ignore */ }
      return true;
    }
    if (!this.opts.refreshToken) {
      return false;
    }
    if (this.unauthorizedRefreshAttempts >= TransportClient.MAX_UNAUTH_REFRESH) {
      // Persistent reject (e.g. server JWT-secret drift: refresh succeeds but the
      // fresh token is STILL rejected) — stop the refresh storm and surface a
      // visible error instead of an endless 'reconnecting'. Recoverable:
      // forceReconnect() (app foreground / manual retry) clears closedByUser AND
      // resets this counter, giving a fresh budget once the cause is fixed.
      this.closedByUser = true;
      this.setState('unauthorized');
      try { socket.disconnect(); } catch { /* ignore */ }
      return true;
    }
    this.unauthorizedRefreshAttempts += 1;
    this.unauthorizedRefreshInFlight = true;
    this.unauthorizedRefreshStartedAt = Date.now();
    this.setState('reconnecting');
    try { socket.disconnect(); } catch { /* ignore */ }
    const attempt = this.unauthorizedRefreshAttempts;
    void this.opts.refreshToken()
      .then(async () => {
        this.unauthorizedRefreshInFlight = false;
        // B-101 LC-1 — the FIRST reopen must be inline. RN freezes JS
        // timers while the screen is locked, so any `setTimeout` here
        // parks the reopen until unlock — long past the server's 12s
        // disconnect-bye / 10s SFU leave grace, i.e. a guaranteed dead
        // call. Later attempts keep the growing backoff so a persistent
        // reject still can't hammer auth-service before the cap trips.
        if (attempt > 1) {
          await new Promise(r => setTimeout(r, 400 * attempt));
        }
        void this.open();
      })
      .catch((e: unknown) => {
        this.unauthorizedRefreshInFlight = false;
        // P1-BR-7 — only a DEFINITIVE reject from the refresh endpoint is
        // terminal. A transient failure (radio not re-attached after Doze,
        // auth-service mid-redeploy 5xx, timeout, DNS blip) used to land
        // here too and strand the transport in terminal 'unauthorized' —
        // no messages, no call rings — until the app was force-cycled.
        // Stay 'reconnecting' and retry through the B-14 backoff instead;
        // forceReconnect() there re-reads getToken() and re-enters this
        // refresh path, so recovery is automatic once the network is back.
        if (isTerminalRefreshError(e)) {
          this.closedByUser = true;
          this.setState('unauthorized');
          return;
        }
        this.scheduleServerReconnect();
      });
    return true;
  }

  /**
   * P1-12 — single-flight open. Concurrent reopen triggers (the 5s
   * send-ack watchdog racing an AppState-active forceReconnect, both
   * otherwise suspended at `await getToken()`) coalesce onto the one
   * in-flight attempt instead of each building a socket. Pre-fix, the
   * first socket became an orphan with live listeners; the gateway
   * evicted one as `superseded` for the same (user, device) and the app
   * misread its own duplicate as a device takeover → spurious sign-out.
   */
  private open(): Promise<void> {
    if (this.openInFlight) {return this.openInFlight;}
    const tracked: Promise<void> = this.doOpen().finally(() => {
      if (this.openInFlight === tracked) {this.openInFlight = null;}
    });
    this.openInFlight = tracked;
    return tracked;
  }

  private async doOpen(): Promise<void> {
    if (this.closedByUser) {return;}
    const gen = ++this.connectGeneration;
    // Audit RELAY-C1 (2026-07-02): tear down any prior socket's listeners
    // before opening a new one. open() is reached on the token-refresh
    // reopen (handleAuthReject) and the inline-error reopen WITHOUT going
    // through forceReconnect() (which already does this). With
    // forceNew:false socket.io reuses the same Manager/Socket, so skipping
    // this stacks a second listener set on every reopen — every server
    // frame then dispatches twice (duplicate libsignal decrypt corrupts
    // the ratchet / raises spurious bad-MAC banners, and state transitions
    // double-fire). Mirrors forceReconnect()'s teardown.
    if (this.socket) {
      try { this.socket.removeAllListeners(); } catch { /* ignore */ }
      try { this.socket.disconnect(); } catch { /* ignore */ }
      this.socket = null;
    }
    this.setState('connecting');

    let token = await this.opts.getToken();
    // P1-12 — a close() superseded this attempt while we were suspended:
    // bail before touching state or installing a socket.
    if (gen !== this.connectGeneration || this.closedByUser) {return;}
    // Notif-latency E2 — a token that cannot survive the handshake spends
    // one refresh HERE instead of handshaking to a guaranteed reject
    // (reject → 'reconnecting' → refresh → reopen was the cold-boot
    // "Connecting… → Reconnecting…" cycle). Failure keeps the stale token:
    // handleAuthReject stays the owner of retries, caps, and terminal
    // 'unauthorized'. No attempt counter is touched — this is not a reject.
    if (token && this.opts.refreshToken) {
      const expMs = decodeJwtExpMs(token);
      if (expMs > 0 && expMs - Date.now() < HANDSHAKE_MIN_TTL_MS) {
        try {
          await this.opts.refreshToken();
          const rotated = await this.opts.getToken();
          if (rotated) {token = rotated;}
        } catch { /* offline/transient — the reject path recovers as before */ }
        if (gen !== this.connectGeneration || this.closedByUser) {return;}
      }
    }
    if (!token) {
      this.setState('unauthorized');
      return;
    }
    // B-100/B-101 — the handshake pins the socket to this token's jti;
    // remember when it expires so the inbound-frame path can renew the
    // credentials in place before the gateway's sweep disconnects us.
    this.socketTokenExpMs = decodeJwtExpMs(token);
    // Review TR-2 — deliberately NOT resetting `lastReauthAttemptAt`
    // here: a reconnect loop would otherwise clear the retry floor on
    // every reopen and let renewal run unthrottled. Clear the stuck-flag
    // instead, since the new socket has no attempt in flight.
    this.reauthInFlight = false;
    this.reauthStartedAt = 0;
    this.lastServerSignalAt = Date.now();

    // Fix #17: rehydrate recoveryPid + offset from disk if we don't
    // have them in memory (kill-revive case — fresh JS context, no
    // in-memory state). Best-effort: a stale pid/offset is still
    // useful; if the server has expired the session it just hands us a
    // fresh one.
    if (!this.recoveryPid) {
      try {
        const [storedPid, storedOff] = await Promise.all([
          AsyncStorage.getItem(RECOVERY_PID_KEY),
          AsyncStorage.getItem(RECOVERY_OFFSET_KEY),
        ]);
        if (storedPid) { this.recoveryPid    = storedPid; }
        if (storedOff) { this.recoveryOffset = storedOff; }
      } catch { /* ignore — non-fatal */ }
    }
    if (gen !== this.connectGeneration || this.closedByUser) {return;}

    const maxBackoff = this.opts.maxBackoffMs ?? 30_000;
    // socket.io-client treats everything after the host as a namespace,
    // so strip a trailing `/ws` if the caller gave us the legacy raw-ws
    // URL. The actual handshake path is set via the `path` option below.
    const base = this.opts.url.replace(/\/ws\/?$/, '');
    const socket = io(base, {
      path:                   '/ws',
      transports:             ['websocket'],
      reconnection:           true,
      reconnectionAttempts:   Infinity,
      reconnectionDelay:      500,
      reconnectionDelayMax:   maxBackoff,
      randomizationFactor:    0.5,
      autoConnect:            true,
      // forceNew=false so socket.io reuses the same Manager across
      // reconnects, which preserves the recovery context. Combined
      // with the `auth.pid` hand-back below, the server's
      // connectionStateRecovery (2 min window) replays any frames
      // missed during a screen lock or brief network blip.
      forceNew:               false,
      // Server's _createSocket requires both pid AND offset as strings
      // to even attempt recovery. Send empty string on the very first
      // connect (no offset yet) — server treats that as "replay from
      // the beginning of the buffer," which is the right behaviour for
      // a brand-new session.
      //
      // Audit P0-T1 — `token` and `signalDeviceId` now travel in the
      // socket.io `auth` payload (carried in the WebSocket upgrade body
      // as an Engine.IO `0{...}` frame) rather than the URL query string.
      // The query form leaked the JWT into nginx access logs, browser
      // history, and any L7 LB that records URLs. The server prefers
      // auth and falls back to query for one rollout release; once
      // telemetry shows zero clients still using query the fallback
      // will be removed.
      auth: {
        token,
        signalDeviceId: this.opts.signalDeviceId,
        // B-354 — presence-invisible background socket (headless drain).
        ...(this.opts.background ? {bg: '1'} : {}),
        ...(this.recoveryPid
          ? {pid: this.recoveryPid, offset: this.recoveryOffset ?? ''}
          : {}),
      },
    });
    this.socket = socket;

    // B-100/B-101 — the renewal HEARTBEAT and the background liveness clock.
    //
    // `onAny` sees only events the server *emits*; an engine.io protocol
    // ping is not one, so on a silent locked call (1:1 media is P2P, so
    // the socket carries no application traffic at all) nothing would
    // ever drive `maybeRenewSocketAuth` and the token would expire
    // exactly as it did before this fix. socket.io's Manager re-emits
    // every protocol ping as a reserved 'ping' event, and it fires off
    // an inbound WebSocket frame — i.e. it keeps running with the screen
    // locked, where timers do not. That makes the server's ~25s
    // heartbeat both our renewal clock and (via `lastServerSignalAt`)
    // the only liveness evidence a background decision can trust.
    //
    // The Manager can be REUSED across sockets for the same URL, so the
    // previous subscription is always removed before adding a new one
    // rather than assuming a fresh Manager per connection.
    try { this.managerPingOff?.(); } catch { /* already gone */ }
    this.managerPingOff = null;
    const manager = (socket as unknown as {
      io?: {on?: (e: string, cb: () => void) => void; off?: (e: string, cb: () => void) => void};
    }).io;
    if (manager && typeof manager.on === 'function') {
      const onManagerPing = (): void => {
        this.lastServerSignalAt = Date.now();
        this.maybeRenewSocketAuth();
        this.fireServerSignal();
      };
      manager.on('ping', onManagerPing);
      this.managerPingOff = () => { manager.off?.('ping', onManagerPing); };
    }

    socket.on('connect', () => {
      // Fix #17: when the server signals connectionStateRecovery
      // succeeded (`socket.recovered === true`), the server's session
      // id is still the OLD pid we sent — our `auth.pid` was honoured.
      // Otherwise the server minted a fresh session and we capture its pid.
      //
      // P1-13: socket.io-client exposes NO public `pid` — the recovery
      // session id is the private `_pid` the server sends in the CONNECT
      // payload when connectionStateRecovery is enabled. The old code fell
      // back to `socket.id`, which is NOT a recovery key: the server's
      // restoreSession never matched it (the 2-min missed-frame replay
      // never fired), and handing it back as `auth.pid` overrode the lib's
      // own correct `_pid` in the CONNECT builder, breaking stock
      // in-process recovery too. Capture `_pid` only; when the server sends
      // none (recovery disabled), clear any stale persisted pid so future
      // handshakes omit `auth.pid`/`auth.offset` entirely.
      const sock = socket as unknown as {recovered?: boolean; _pid?: string};
      if (sock.recovered !== true) {
        // Fresh server session — the previous session's offset is
        // meaningless against the new buffer.
        this.recoveryOffset = null;
        AsyncStorage.removeItem(RECOVERY_OFFSET_KEY).catch(() => { /* non-fatal */ });
      }
      const nextPid = sock.recovered === true && this.recoveryPid
        ? this.recoveryPid
        : (typeof sock._pid === 'string' && sock._pid.length > 0 ? sock._pid : null);
      this.recoveryPid = nextPid;
      // Persist for kill-revive — fire-and-forget, never block the
      // connect path on disk I/O.
      if (nextPid) {
        AsyncStorage.setItem(RECOVERY_PID_KEY, nextPid).catch(() => { /* non-fatal */ });
      } else {
        AsyncStorage.removeItem(RECOVERY_PID_KEY).catch(() => { /* non-fatal */ });
      }
      // Fix #18: stamp the wall-clock so forceReconnect() can throttle
      // a redundant rebuild request that arrives within 2s.
      this.lastConnectedAt = Date.now();
      // Round 1 P2 (G8) — a fresh connect re-arms the public forceReconnect
      // immediately: the AppState foreground recovery exists precisely for a
      // drop right after a connect, and flooring it there starved the one
      // caller that cannot wait out the window.
      this.lastForceReconnectAt = Number.NEGATIVE_INFINITY;
      // B-11 — a fresh connection clears any prior takeover/error code so
      // a later transient drop isn't misread as a supersession.
      this.lastServerErrorCode = null;
      // B-14 — reset the manual-reconnect backoff now that we're back.
      this.serverReconnectAttempts = 0;
      if (this.serverReconnectTimer) {
        clearTimeout(this.serverReconnectTimer);
        this.serverReconnectTimer = null;
      }
      // Healthy connect — clear the auth-refresh budget so a future genuine
      // reject starts fresh.
      this.unauthorizedRefreshAttempts = 0;
      this.setState('connected');
      // B-05 — fire reconnect listeners ONLY on a genuine reopen (not the
      // first connect). Snapshot so a listener that (un)subscribes during
      // dispatch doesn't mutate the set mid-loop; swallow listener faults.
      if (this.hasConnectedOnce) {
        for (const fn of [...this.reconnectListeners]) {
          try { fn(); } catch { /* listener fault — keep dispatching */ }
        }
      }
      this.hasConnectedOnce = true;
      // WI-5.3 — one-shot up-edge consumers (fired on FIRST connects too).
      const onceFns = [...this.onceConnectedListeners];
      this.onceConnectedListeners.clear();
      for (const fn of onceFns) {
        try { fn(); } catch { /* listener fault — keep dispatching */ }
      }
    });
    socket.on('reconnect_attempt', () => this.setState('reconnecting'));
    socket.on('connect_error',  (err: Error & {data?: {code?: string; message?: string}}) => {
      // Transient handshake failure — socket.io will retry until we give up.
      if (this.closedByUser) {return;}
      // Why: when the server's handshake middleware rejects with an
      // `unauthorized`/`token_revoked` code (expired JWT, JTI not in
      // Redis, signature failure), socket.io fires `connect_error` —
      // NOT the inline `error` frame the auth-mid-session path uses.
      // Without this branch, the client retries forever with the same
      // stale token. Trigger the same single-flight refresh+reopen
      // path the inline `error` handler uses.
      const code   = err?.data?.code;
      const reason = err?.data?.message ?? err?.message ?? '';
      const isAuthReject =
        code === 'unauthorized' ||
        code === 'token_revoked' ||
        /token_revoked|exp.*claim|invalid_token|missing_token|jwt|expired/i.test(reason);
      if (isAuthReject && this.handleAuthReject(socket)) {
        return;
      }
      this.setState('reconnecting');
    });

    // Server emits every frame with its own event name (`envelope.deliver`,
    // `presence`, `call.offer`, `error`, etc). `onAny` captures the lot
    // and rebuilds the ServerFrame shape the app expects. The variadic
    // args also include socket.io's recovery offset as a trailing
    // string when connectionStateRecovery is enabled — capture it so
    // the next handshake can resume the session.
    socket.onAny((event: string, ...args: unknown[]) => {
      const data = args[0];
      // B-100/B-101 — renew this socket's credentials off the INBOUND
      // frame path. RN freezes JS timers while the screen is locked, so
      // a timer-based renewal would never fire during exactly the calls
      // that were dying; server pings (~25s) keep this alive instead.
      this.lastServerSignalAt = Date.now();
      this.maybeRenewSocketAuth();
      this.fireServerSignal();
      // Recovery offset arrives as the LAST arg when recovery is on.
      // It's always a string. Persist it best-effort.
      const tail = args[args.length - 1];
      if (this.recoveryPid && typeof tail === 'string' && tail !== this.recoveryOffset) {
        this.recoveryOffset = tail;
        AsyncStorage.setItem(RECOVERY_OFFSET_KEY, tail).catch(() => { /* non-fatal */ });
      }
      // The server's `error` frame carries `{code, message}` and is how
      // we learn about auth failures (it arrives right before disconnect).
      // Round 2 fix: instead of stranding the WS in `unauthorized` and
      // forcing the user to restart, drive a single refresh attempt and
      // reopen the socket with the fresh JWT. We only fall through to
      // the old "give up" branch when refresh itself fails OR no
      // refresh hook is wired (loopback dev / test runs).
      //
      // Why: previously only `code === 'unauthorized'` triggered the
      // refresh path. The server's P0-6 mid-stream revocation sweep
      // (messenger.gateway.ts:360) emits `code: 'token_revoked'`
      // INSTEAD of `unauthorized`, so the refresh never fired. The
      // socket disconnected, socket.io retried with the same revoked
      // JWT, every reconnect 401'd, and the WS sat in 'reconnecting'
      // forever without acking anything. Match both codes so either
      // server-initiated drop kicks the refresh+reopen flow.
      if (event === 'error' && isErrorPayload(data) && (data.code === 'unauthorized' || data.code === 'token_revoked')) {
        if (this.handleAuthReject(socket)) {
          return;
        }
        // No refresh hook wired (loopback dev / test) or a refresh is already
        // in flight — surface unauthorized so the UI can react.
        this.closedByUser = true; // stop socket.io from retrying
        this.setState('unauthorized');
        try { socket.disconnect(); } catch { /* ignore */ }
        return;
      }
      // B-11 — single-device takeover. The server emits this right
      // before it disconnects the older socket for the same
      // (user, device). Record the code so the imminent
      // `io server disconnect` is handled as a takeover (no reconnect)
      // rather than a transient drop, and surface a distinct state. It
      // is not message content, so we do NOT pass it on to onFrame.
      if (event === 'error' && isErrorPayload(data) && data.code === 'superseded') {
        this.lastServerErrorCode = 'superseded';
        this.setState('superseded');
        return;
      }
      const frame = {event, data} as ServerFrame;
      this.opts.onFrame(frame);
      // Audit fix 5.1 — fan out to secondary listeners. Listener
      // errors are swallowed so one buggy subscriber doesn't break
      // the runtime's central dispatch. Snapshot the set so a
      // listener that calls addFrameListener() during dispatch
      // doesn't get re-fired in the same loop.
      for (const fn of [...this.frameListeners]) {
        try { fn(frame); } catch { /* listener fault — keep dispatching */ }
      }
    });

    socket.on('disconnect', (reason: string) => {
      if (this.closedByUser) {
        this.setState('disconnected');
        return;
      }
      // socket.io auto-reconnects for network-level drops; we only flip
      // state for UI feedback. `io server disconnect` means the server
      // called `socket.disconnect(true)` — usually auth or supersession —
      // and socket.io will NOT auto-reconnect in that case.
      if (reason === 'io server disconnect') {
        // B-11 — a single-device takeover (`superseded` error frame
        // arrived just before this). Do NOT reconnect: re-grabbing the
        // (user, device) slot would ping-pong the kick back to the
        // device that just took over. Stay in the distinct 'superseded'
        // state so the UI can say "active on another device".
        if (this.lastServerErrorCode === 'superseded') {
          this.setState('superseded');
          return;
        }
        // An auth reject (`unauthorized`/`token_revoked`) is handled by
        // the error/connect_error paths, which either set closedByUser
        // (→ handled at the top of this handler) or drive a single-flight
        // refresh+reopen. Don't double-reconnect while that's in flight.
        if (this.unauthorizedRefreshInFlight) {return;}
        // B-14 — otherwise this is a server-initiated drop that is NOT a
        // takeover and NOT an auth reject: a messenger-service restart,
        // idle reap, or crash (B-05). socket.io will NOT auto-reconnect
        // after a server disconnect, so the transport used to sit dead
        // (no recv.enter, no sends) until app restart. Drive the
        // reconnect ourselves with capped exponential backoff.
        this.scheduleServerReconnect();
        return;
      }
      this.setState('reconnecting');
      // Network-level drop ('transport close', 'ping timeout', …).
      // socket.io auto-reconnects these — but only on its own ~500ms
      // TIMER, which RN freezes while the screen is locked (B-101 LC-2):
      // an in-call socket lost to an elevator/AP-roam blip made no
      // attempt at all until unlock, long after the server's 12s/10s
      // call-teardown graces. WITH A CALL LIVE, drive one immediate
      // attempt from this event (which IS delivered while locked);
      // doOpen() tears the old socket down first, so this supersedes
      // rather than races socket.io's pending retry. With no call live,
      // socket.io's own retry is left alone — unchanged behaviour.
      if (this.needsImmediateReopen()) {
        this.scheduleServerReconnect();
      }
    });
  }

  /**
   * B-14 — schedule a manual reconnect after a non-takeover server
   * disconnect, with capped exponential backoff. forceReconnect()
   * rebuilds the socket and re-reads getToken(), so a token that
   * expired during the outage self-heals via the connect_error refresh
   * path on the next attempt. Keeps retrying (capped at maxBackoffMs)
   * until the server is back — a long outage must not strand the
   * transport. Resets once a connect succeeds.
   */
  private scheduleServerReconnect(): void {
    if (this.closedByUser) {return;}
    // FIX-03 — no radio, no retry. notifyNetworkChange() restarts the ladder
    // the moment connectivity returns, with the attempt counter reset.
    if (this.networkDown) {
      this.setState('disconnected');
      return;
    }
    this.setState('reconnecting');
    // B-101 LC-1/LC-2 — with a call live, the first retry runs INLINE,
    // not on a timer. RN freezes JS timers while the Android host
    // activity is paused, so a socket that dies with the screen locked
    // (revoked-token sweep, service redeploy, TCP reset) could not even
    // ATTEMPT a reconnect until the user unlocked — always losing the
    // race with the 12s disconnect-bye / 10s SFU leave grace that ends
    // the call. The `disconnect` event itself IS delivered while locked,
    // so reconnecting from inside it is the one path that still works.
    // Deliberately gated on a live call: a redeploy drops every client
    // at once, and unconditional immediate retries would stampede the
    // gateway — the thundering herd the jitter below exists to prevent.
    // Review TR-1 — the fast path additionally needs its own WALL-CLOCK
    // floor: `serverReconnectAttempts` is reset by every successful
    // connect, so a connect→drop→connect flap (rolling redeploy, LB
    // draining, AP roam) would otherwise re-handshake at RTT cadence
    // with no backoff whatsoever. forceReconnect's own throttle cannot
    // damp this path because it only applies while state is 'connected'.
    const nowMs = Date.now();
    if (this.serverReconnectAttempts === 0
        && this.needsImmediateReopen()
        && nowMs - this.lastImmediateReopenAt > IMMEDIATE_REOPEN_FLOOR_MS) {
      this.lastImmediateReopenAt = nowMs;
      this.serverReconnectAttempts++;
      void this.reopenNow();
      return;
    }
    const maxBackoff = this.opts.maxBackoffMs ?? 30_000;
    const base = Math.min(1_000 * 2 ** this.serverReconnectAttempts, maxBackoff);
    // Why: ±25% jitter — after a service restart every client sees the
    // drop at the same instant; identical backoff steps would stampede
    // the gateway in lockstep waves (thundering herd).
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.serverReconnectAttempts++;
    if (this.serverReconnectTimer) {clearTimeout(this.serverReconnectTimer);}
    this.serverReconnectTimer = setTimeout(() => {
      this.serverReconnectTimer = null;
      if (this.closedByUser) {return;}
      void this.reopenNow();
    }, delay);
  }

  private setState(next: TransportState): void {
    if (this._state === next) {return;}
    this._state = next;
    this.opts.onStateChange?.(next);
  }
}

function isErrorPayload(v: unknown): v is {code: string; message?: string} {
  return !!v && typeof v === 'object' && typeof (v as {code?: unknown}).code === 'string';
}

/**
 * P1-BR-7 — classify a refreshToken() failure. Terminal only when the
 * auth service definitively rejected the refresh (HTTP 401/403 — expired
 * or revoked refresh token) or there is no refresh token to present.
 * Anything else (network error, 5xx, timeout) is transient: the caller
 * must keep the transport retrying instead of stranding it in a terminal
 * 'unauthorized'. Reads the axios error shape (`response.status`) with a
 * plain `status` fallback for fetch-style wrappers.
 */
function isTerminalRefreshError(e: unknown): boolean {
  if (!e || typeof e !== 'object') {return false;}
  const status = (e as {response?: {status?: number}}).response?.status
    ?? (e as {status?: number}).status;
  if (typeof status === 'number') {
    return status === 401 || status === 403;
  }
  const msg = (e as {message?: unknown}).message;
  return typeof msg === 'string' && /no refresh token|refresh.*revoked|token_revoked/i.test(msg);
}
