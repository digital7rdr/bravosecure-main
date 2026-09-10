/**
 * Notif-latency E2 (docs/audits/NOTIF_TAP_TO_MESSAGE_LATENCY_2026-08-01.md) —
 * the handshake must never be attempted with a token that cannot survive it.
 *
 * Before this fix, a cold boot handshook with whatever access token was on
 * disk. After hours killed, that token is expired, so the FIRST connect was
 * designed to fail: gateway reject → 'reconnecting' → HTTP refresh → reopen.
 * The user watched that as "Connecting… → Reconnecting…" on every cold open,
 * and the wasted roundtrip sat on the notification-tap critical path.
 *
 * INVARIANTS under test:
 *   1. An EXPIRED (or about-to-expire, < 30s TTL) stored token spends one
 *      refresh BEFORE the socket is built, and the handshake carries the
 *      rotated token.
 *   2. A token with comfortable TTL spends NOTHING at connect time — the
 *      in-place renewal path (socketReauth.test.ts) owns mid-life rotation.
 *      The threshold is SECONDS on purpose: socketReauth.test.ts connects
 *      with 60s-left tokens as its renewal setup, and a wider connect-time
 *      window would both break that setup and rotate the jti on every
 *      routine reopen.
 *   3. A failed refresh keeps the stale token and still builds the socket —
 *      the existing handshake-reject → handleAuthReject path stays the
 *      owner of retries, caps, and terminal 'unauthorized'.
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
  on: (event: string, cb: (...a: unknown[]) => void) => void;
  onAny: (cb: (...a: unknown[]) => void) => void;
  removeAllListeners: () => void;
  emit: (event: string, data: unknown, ack?: (resp: unknown) => void) => void;
  disconnect: () => void;
  io: {on: (e: string, cb: () => void) => void; off: (e: string, cb: () => void) => void};
}

const ioCalls: Array<{base: string; opts: {auth?: {token?: string}}}> = [];

jest.mock('socket.io-client', () => ({
  __esModule: true,
  io: jest.fn((base: string, opts: {auth?: {token?: string}}) => {
    ioCalls.push({base, opts});
    const sock: FakeSocket = {
      connected: true,
      emitted: [],
      on() { /* listeners not needed here */ },
      onAny() { /* not needed */ },
      removeAllListeners() { /* no-op */ },
      emit(event: string, data: unknown) { sock.emitted.push({event, data}); },
      disconnect() { sock.connected = false; },
      io: {on() { /* no-op */ }, off() { /* no-op */ }},
    };
    return sock;
  }),
}));

import {TransportClient} from '../src/transport/client';

/** Build an unsigned JWT whose `exp` is `secondsFromNow` from now (may be negative). */
function tokenExpiringIn(secondsFromNow: number): string {
  const payload = {exp: Math.floor(Date.now() / 1000) + secondsFromNow, sub: 'u1'};
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
  return `header.${b64}.sig`;
}

function buildClient(opts: {
  initial: string;
  afterRefresh?: string;
  refreshImpl?: () => Promise<void>;
  withRefreshHook?: boolean;
}): {client: TransportClient; refreshToken: jest.Mock; store: {token: string}} {
  const store = {token: opts.initial};
  const refreshToken = jest.fn(async () => {
    if (opts.refreshImpl) {await opts.refreshImpl();}
    if (opts.afterRefresh) {store.token = opts.afterRefresh;}
  });
  const client = new TransportClient({
    url: 'http://localhost:3100',
    signalDeviceId: 1,
    getToken: async () => store.token,
    ...(opts.withRefreshHook === false ? {} : {refreshToken}),
    onFrame: () => { /* ignored */ },
  });
  return {client, refreshToken, store};
}

describe('TransportClient — connect-time token freshness (notif-latency E2)', () => {
  beforeEach(() => { ioCalls.length = 0; });
  afterEach(() => { jest.clearAllMocks(); });

  it('refreshes an EXPIRED stored token BEFORE the handshake and connects with the rotated one', async () => {
    const fresh = tokenExpiringIn(15 * 60);
    const {client, refreshToken} = buildClient({
      initial: tokenExpiringIn(-60),
      afterRefresh: fresh,
    });

    await client.connect();

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(ioCalls).toHaveLength(1);
    expect(ioCalls[0].opts.auth?.token).toBe(fresh);
  });

  it('refreshes a token with under 30s left (would not survive the handshake pin)', async () => {
    const fresh = tokenExpiringIn(15 * 60);
    const {client, refreshToken} = buildClient({
      initial: tokenExpiringIn(10),
      afterRefresh: fresh,
    });

    await client.connect();

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(ioCalls[0].opts.auth?.token).toBe(fresh);
  });

  it('spends NOTHING when the stored token has comfortable TTL (60s is the socketReauth setup — must stay untouched)', async () => {
    const initial = tokenExpiringIn(60);
    const {client, refreshToken} = buildClient({initial});

    await client.connect();

    expect(refreshToken).not.toHaveBeenCalled();
    expect(ioCalls).toHaveLength(1);
    expect(ioCalls[0].opts.auth?.token).toBe(initial);
  });

  it('keeps the stale token and still builds the socket when the refresh THROWS (reject path stays the owner)', async () => {
    const initial = tokenExpiringIn(-60);
    const {client, refreshToken} = buildClient({
      initial,
      refreshImpl: async () => { throw new Error('offline'); },
    });

    await client.connect();

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(ioCalls).toHaveLength(1);
    expect(ioCalls[0].opts.auth?.token).toBe(initial);
  });

  it('skips the pre-refresh entirely when no refreshToken hook is wired (ops-console shape)', async () => {
    const initial = tokenExpiringIn(-60);
    const {client} = buildClient({initial, withRefreshHook: false});

    await client.connect();

    expect(ioCalls).toHaveLength(1);
    expect(ioCalls[0].opts.auth?.token).toBe(initial);
  });
});
