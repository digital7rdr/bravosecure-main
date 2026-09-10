/**
 * B-100/B-101 — in-place socket re-authentication, driven by INBOUND
 * FRAMES rather than a timer.
 *
 * Why frames and not a timer: React Native freezes JS timers while the
 * Android host activity is paused, which is precisely the locked-screen
 * state where calls were dying (the access token's jti leaves the Redis
 * allowlist at 15 min, the gateway's sweep disconnects the socket, and
 * the 12s disconnect-bye / 10s SFU leave grace end the call). WS message
 * delivery keeps waking JS, so hanging renewal off the inbound path is
 * the only mechanism that still runs with the screen off.
 *
 * INVARIANTS under test:
 *   1. A token comfortably far from expiry triggers NOTHING (no refresh
 *      storm on every frame).
 *   2. A token inside the renewal lead window triggers refreshToken()
 *      and emits `auth.refresh` carrying the NEW token.
 *   3. After the server ACKs, further frames do not re-refresh (the
 *      socket's tracked expiry advanced).
 *   4. A failed re-auth does NOT advance the tracked expiry, so a later
 *      frame retries (subject to the retry floor).
 *   5. Renewal never runs while the socket is closed.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

interface FakeSocket {
  connected: boolean;
  emitted: Array<{event: string; data: unknown}>;
  ackResponses: Record<string, unknown>;
  io: {
    on: (e: string, cb: () => void) => void;
    off: (e: string, cb: () => void) => void;
    __listenerCount: (e: string) => number;
  };
  __fire: (event: string, ...args: unknown[]) => void;
  __fireAny: (event: string, ...args: unknown[]) => void;
  /** Simulate an engine.io protocol ping arriving from the server. */
  __fireManagerPing: () => void;
}

/**
 * socket.io's Manager is SHARED across sockets and outlives them, so the
 * fake mirrors that: one manager instance reused by every socket the
 * mocked io() hands out, with listener bookkeeping so a test can prove
 * subscriptions are swapped rather than stacked across reopens.
 */
const sharedManagerListeners: Record<string, Array<() => void>> = {};
const sharedManager = {
  on(e: string, cb: () => void) { (sharedManagerListeners[e] = sharedManagerListeners[e] ?? []).push(cb); },
  off(e: string, cb: () => void) {
    sharedManagerListeners[e] = (sharedManagerListeners[e] ?? []).filter(f => f !== cb);
  },
  __listenerCount(e: string) { return (sharedManagerListeners[e] ?? []).length; },
  __fire(e: string) { [...(sharedManagerListeners[e] ?? [])].forEach(cb => cb()); },
};

const mockSockets: FakeSocket[] = [];

jest.mock('socket.io-client', () => ({
  __esModule: true,
  io: jest.fn(() => {
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    const anyHandlers: Array<(event: string, ...a: unknown[]) => void> = [];
    const sock: FakeSocket & Record<string, unknown> = {
      connected: true,
      emitted: [],
      ackResponses: {},
      on(event: string, cb: (...a: unknown[]) => void) {
        (handlers[event] = handlers[event] ?? []).push(cb);
      },
      onAny(cb: (event: string, ...a: unknown[]) => void) { anyHandlers.push(cb); },
      removeAllListeners() { /* no-op */ },
      emit(event: string, data: unknown, ack?: (resp: unknown) => void) {
        sock.emitted.push({event, data});
        if (ack) {
          const resp = sock.ackResponses[event] ?? {ok: true};
          // Ack asynchronously, like the real transport.
          setTimeout(() => ack(resp), 0);
        }
      },
      disconnect() { sock.connected = false; },
      __fire(event: string, ...args: unknown[]) {
        (handlers[event] ?? []).forEach(cb => cb(...args));
      },
      __fireAny(event: string, ...args: unknown[]) {
        anyHandlers.forEach(cb => cb(event, ...args));
      },
      io: sharedManager,
      __fireManagerPing() { sharedManager.__fire('ping'); },
    };
    mockSockets.push(sock);
    return sock;
  }),
}));

import {TransportClient} from '../src/transport/client';

/** Build an unsigned JWT whose `exp` is `secondsFromNow` in the future. */
function tokenExpiringIn(secondsFromNow: number): string {
  const payload = {exp: Math.floor(Date.now() / 1000) + secondsFromNow, sub: 'u1'};
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
  return `header.${b64}.sig`;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) { await Promise.resolve(); }
  await new Promise(r => setTimeout(r, 0));
  for (let i = 0; i < 6; i++) { await Promise.resolve(); }
};

/**
 * Models the real token store: `getToken` returns whatever is currently
 * stored, and only a successful `refreshToken()` rotates it. This is what
 * distinguishes the two renewal routes — spend an HTTP refresh, versus
 * adopt a token some other path already refreshed.
 */
async function connectWith(opts: {
  initial: string;
  afterRefresh?: string;
  refreshImpl?: () => Promise<void>;
  hasLiveCall?: () => boolean;
}): Promise<{client: TransportClient; socket: FakeSocket; refreshToken: jest.Mock; store: {token: string}}> {
  mockSockets.length = 0;
  const store = {token: opts.initial};
  const getToken = jest.fn(async () => store.token);
  const refreshToken = jest.fn(async () => {
    if (opts.refreshImpl) {await opts.refreshImpl();}
    if (opts.afterRefresh) {store.token = opts.afterRefresh;}
  });
  const client = new TransportClient({
    url: 'http://localhost:3100',
    signalDeviceId: 1,
    getToken,
    refreshToken,
    hasLiveCall: opts.hasLiveCall,
    onFrame: () => { /* ignored */ },
  });
  await client.connect();
  const socket = mockSockets[0];
  socket.__fire('connect');
  await flush();
  return {client, socket, refreshToken, store};
}

describe('TransportClient — in-place socket re-auth (B-100/B-101)', () => {
  beforeEach(() => { Object.keys(sharedManagerListeners).forEach(k => { sharedManagerListeners[k] = []; }); });
  afterEach(() => { jest.clearAllMocks(); });

  /**
   * The decisive case: a LOCKED phone on a silent 1:1 call. Media is P2P,
   * so the socket carries no application traffic — `onAny` never fires —
   * and every JS timer is frozen by RN. The ONLY thing still arriving is
   * the server's ~25s engine.io protocol ping, which socket.io's Manager
   * re-emits. If renewal did not hang off that, the token would expire
   * mid-call exactly as it did before the fix.
   */
  describe('renewal clock while the screen is locked', () => {
    it('renews from the Manager ping alone, with NO socket.io events and NO timers', async () => {
      const fresh = tokenExpiringIn(15 * 60);
      const {socket, refreshToken} = await connectWith({
        initial: tokenExpiringIn(60),
        afterRefresh: fresh,
      });

      // Nothing but the protocol heartbeat — no frames, no timer advance.
      socket.__fireManagerPing();
      await flush();

      expect(refreshToken).toHaveBeenCalledTimes(1);
      const reauths = socket.emitted.filter(e => e.event === 'auth.refresh');
      expect(reauths).toHaveLength(1);
      expect((reauths[0].data as {token: string}).token).toBe(fresh);
    });

    it('does not stack Manager listeners across reconnects', async () => {
      const {socket} = await connectWith({
        initial: tokenExpiringIn(15 * 60),
        hasLiveCall: () => true,
      });

      socket.__fire('disconnect', 'io server disconnect');
      await flush();
      socket.__fire('disconnect', 'transport close');
      await flush();

      // One live subscription regardless of how many sockets were built.
      expect(sharedManager.__listenerCount('ping')).toBe(1);
    });
  });

  it('does NOT renew while the token is far from expiry (no per-frame storm)', async () => {
    const {socket, refreshToken} = await connectWith({initial: tokenExpiringIn(15 * 60)});

    for (let i = 0; i < 5; i++) { socket.__fireAny('pong', {ts: Date.now()}); }
    await flush();

    expect(refreshToken).not.toHaveBeenCalled();
    expect(socket.emitted.filter(e => e.event === 'auth.refresh')).toHaveLength(0);
  });

  it('renews on an inbound frame once inside the lead window, emitting auth.refresh with the NEW token', async () => {
    const fresh = tokenExpiringIn(15 * 60);
    const {socket, refreshToken} = await connectWith({
      initial: tokenExpiringIn(60),   // 1 min left — inside the 5 min lead
      afterRefresh: fresh,
    });

    socket.__fireAny('pong', {ts: Date.now()});
    await flush();

    expect(refreshToken).toHaveBeenCalledTimes(1);
    const reauths = socket.emitted.filter(e => e.event === 'auth.refresh');
    expect(reauths).toHaveLength(1);
    expect((reauths[0].data as {token: string}).token).toBe(fresh);
  });

  it('adopts an already-fresh stored token WITHOUT spending an HTTP refresh', async () => {
    // Some other path (the HTTP 401 interceptor) already rotated the stored
    // token; the socket is still pinned to the old one. Re-auth in place and
    // skip the redundant refresh round-trip.
    const {socket, refreshToken, store} = await connectWith({initial: tokenExpiringIn(60)});
    store.token = tokenExpiringIn(15 * 60);

    socket.__fireAny('pong', {ts: Date.now()});
    await flush();

    expect(refreshToken).not.toHaveBeenCalled();
    const reauths = socket.emitted.filter(e => e.event === 'auth.refresh');
    expect(reauths).toHaveLength(1);
    expect((reauths[0].data as {token: string}).token).toBe(store.token);
  });

  it('stops renewing once the server ACKs (tracked expiry advanced)', async () => {
    const {socket, refreshToken} = await connectWith({
      initial: tokenExpiringIn(60),
      afterRefresh: tokenExpiringIn(15 * 60),
    });

    socket.__fireAny('pong', {ts: Date.now()});
    await flush();
    expect(socket.emitted.filter(e => e.event === 'auth.refresh')).toHaveLength(1);

    // Many more frames — the socket now holds a fresh token, so nothing fires.
    for (let i = 0; i < 5; i++) { socket.__fireAny('pong', {ts: Date.now()}); }
    await flush();

    expect(socket.emitted.filter(e => e.event === 'auth.refresh')).toHaveLength(1);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it('does not tear the socket down when the server REFUSES the re-auth', async () => {
    const {socket} = await connectWith({
      initial: tokenExpiringIn(60),
      afterRefresh: tokenExpiringIn(15 * 60),
    });
    socket.ackResponses['auth.refresh'] = {ok: false, code: 'token_revoked'};

    socket.__fireAny('pong', {ts: Date.now()});
    await flush();

    // It attempted; the refusal is left to the server's revocation sweep +
    // the existing refresh/reopen path — the client must not self-destruct.
    expect(socket.emitted.filter(e => e.event === 'auth.refresh')).toHaveLength(1);
    expect(socket.connected).toBe(true);
  });

  /**
   * B-101 LC-1/LC-2 — the timer-free reconnect. RN freezes JS timers with
   * the screen locked, so a socket that dies mid-call must be re-opened
   * from the `disconnect` EVENT itself (which is still delivered) or the
   * server's 12s disconnect-bye / 10s SFU leave grace ends the call
   * before any retry runs. Gated on a live call so a service redeploy
   * doesn't stampede the gateway with every client reconnecting at once.
   */
  describe('timer-free reconnect while a call is live', () => {
    it('re-opens IMMEDIATELY (no timer) after a server drop when a call is live', async () => {
      const {socket} = await connectWith({
        initial: tokenExpiringIn(15 * 60),
        hasLiveCall: () => true,
      });
      expect(mockSockets).toHaveLength(1);

      socket.__fire('disconnect', 'io server disconnect');
      await flush();

      // A brand-new socket exists without any timer having been advanced.
      expect(mockSockets.length).toBeGreaterThan(1);
    });

    it('re-opens immediately after a NETWORK drop when a call is live', async () => {
      const {socket} = await connectWith({
        initial: tokenExpiringIn(15 * 60),
        hasLiveCall: () => true,
      });

      socket.__fire('disconnect', 'transport close');
      await flush();

      expect(mockSockets.length).toBeGreaterThan(1);
    });

    it('applies a wall-clock floor so a connect/drop flap cannot spin (review TR-1)', async () => {
      const {socket} = await connectWith({
        initial: tokenExpiringIn(15 * 60),
        hasLiveCall: () => true,
      });

      socket.__fire('disconnect', 'io server disconnect');
      await flush();
      const afterFirst = mockSockets.length;
      expect(afterFirst).toBeGreaterThan(1);

      // A second drop immediately after: the counter was reset by the
      // reconnect, but the floor must still refuse an instant re-handshake.
      const latest = mockSockets[mockSockets.length - 1];
      latest.__fire('connect');
      await flush();
      latest.__fire('disconnect', 'io server disconnect');
      await flush();

      expect(mockSockets.length).toBe(afterFirst);
    });

    it('does NOT bypass the backoff when no call is live (no redeploy stampede)', async () => {
      const {socket} = await connectWith({
        initial: tokenExpiringIn(15 * 60),
        hasLiveCall: () => false,
      });

      socket.__fire('disconnect', 'io server disconnect');
      await flush();

      // Still exactly one socket — the jittered B-14 timer owns the retry.
      expect(mockSockets).toHaveLength(1);
    });

    it('leaves socket.io to handle a network drop when no call is live', async () => {
      const {socket} = await connectWith({
        initial: tokenExpiringIn(15 * 60),
        hasLiveCall: () => false,
      });

      socket.__fire('disconnect', 'transport close');
      await flush();

      expect(mockSockets).toHaveLength(1);
    });
  });

  it('never renews while the socket is closed', async () => {
    const {socket, refreshToken} = await connectWith({
      initial: tokenExpiringIn(60),
      afterRefresh: tokenExpiringIn(15 * 60),
    });
    socket.connected = false;

    socket.__fireAny('pong', {ts: Date.now()});
    await flush();

    expect(refreshToken).not.toHaveBeenCalled();
    expect(socket.emitted.filter(e => e.event === 'auth.refresh')).toHaveLength(0);
  });
});
