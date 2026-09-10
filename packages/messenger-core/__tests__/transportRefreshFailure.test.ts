/**
 * P1-BR-7 (2026-07-10 background audit §3) — a TRANSIENT refresh failure
 * at foreground must NOT kill the transport.
 *
 * App backgrounded >15 min → JWT expires → foreground forceReconnect →
 * handshake rejects → refreshToken(). If that one POST fails transiently
 * (radio not re-attached after Doze, auth-service mid-redeploy, nginx 502,
 * timeout), the old catch set closedByUser + terminal 'unauthorized' —
 * no messages and no call rings until the app was force-cycled. Contract:
 *   - network error / 5xx / timeout → stay 'reconnecting', retry via the
 *     B-14 backoff,
 *   - HTTP 401/403 or no-refresh-token → keep the terminal path,
 *   - a network-restore signal retries immediately from non-connected
 *     states (folded P2: no fast-path reconnect on network restore),
 *   - but never resurrects a superseded (B-11) or user-closed session.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockSockets: Array<{
  __fire: (event: string, ...a: unknown[]) => void;
  __fireAny: (event: string, data: unknown) => void;
}> = [];
jest.mock('socket.io-client', () => ({
  __esModule: true,
  io: jest.fn(() => {
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const anyHandlers: Array<(event: string, ...args: unknown[]) => void> = [];
    const sock = {
      on(event: string, cb: (...args: unknown[]) => void) {
        (handlers[event] = handlers[event] ?? []).push(cb);
      },
      onAny(cb: (event: string, ...args: unknown[]) => void) { anyHandlers.push(cb); },
      emit() { /* unused */ },
      connect() { /* unused */ },
      disconnect() { /* unused */ },
      removeAllListeners() { /* unused */ },
      connected: true,
      id: 'sock-refresh',
      __fire(event: string, ...args: unknown[]) {
        for (const cb of handlers[event] ?? []) { cb(...args); }
      },
      __fireAny(event: string, data: unknown) {
        for (const cb of anyHandlers) { cb(event, data); }
      },
    };
    mockSockets.push(sock);
    return sock;
  }),
}));

import {TransportClient} from '../src/transport/client';

const lastSocket = () => mockSockets[mockSockets.length - 1];
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function newClient(refreshToken?: () => Promise<void>) {
  return new TransportClient({
    url: 'http://localhost:3100',
    signalDeviceId: 1,
    getToken: async () => 'jwt-token',
    onFrame: () => undefined,
    refreshToken,
  });
}

describe('TransportClient — refresh-failure classification (P1-BR-7)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // pin jitter to 1.0×
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mockSockets.length = 0;
  });

  it('a NETWORK refresh failure stays reconnecting and retries via the B-14 backoff', async () => {
    const refresh = jest.fn().mockRejectedValue(new Error('Network Error'));
    const client = newClient(refresh);
    await client.connect();
    expect(mockSockets.length).toBe(1);

    lastSocket().__fire('connect_error', {data: {code: 'unauthorized'}});
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    // Pre-fix this was a terminal 'unauthorized'.
    expect(client.state).toBe('reconnecting');

    jest.advanceTimersByTime(1_000); // first B-14 step
    await flush();
    expect(mockSockets.length).toBe(2); // it retried
  });

  it('an axios 5xx refresh failure is transient too', async () => {
    const err = Object.assign(new Error('Request failed with status code 503'), {
      response: {status: 503},
    });
    const client = newClient(jest.fn().mockRejectedValue(err));
    await client.connect();

    lastSocket().__fire('connect_error', {data: {code: 'unauthorized'}});
    await flush();
    expect(client.state).toBe('reconnecting');

    jest.advanceTimersByTime(1_000);
    await flush();
    expect(mockSockets.length).toBe(2);
  });

  it('an HTTP 401 from the refresh endpoint stays TERMINAL (no retry)', async () => {
    const err = Object.assign(new Error('Request failed with status code 401'), {
      response: {status: 401},
    });
    const client = newClient(jest.fn().mockRejectedValue(err));
    await client.connect();

    lastSocket().__fire('connect_error', {data: {code: 'unauthorized'}});
    await flush();
    expect(client.state).toBe('unauthorized');

    jest.advanceTimersByTime(120_000);
    await flush();
    expect(mockSockets.length).toBe(1); // no reconnect attempts
  });

  it('"No refresh token" stays TERMINAL', async () => {
    const client = newClient(jest.fn().mockRejectedValue(new Error('No refresh token')));
    await client.connect();

    lastSocket().__fire('connect_error', {data: {code: 'unauthorized'}});
    await flush();
    expect(client.state).toBe('unauthorized');

    jest.advanceTimersByTime(120_000);
    await flush();
    expect(mockSockets.length).toBe(1);
  });
});

describe('TransportClient — network-restore fast path (folded P2, client.ts:393)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mockSockets.length = 0;
  });

  it('reconnects immediately from a non-connected state instead of waiting out the backoff', async () => {
    const client = newClient();
    await client.connect();
    lastSocket().__fire('connect');
    lastSocket().__fire('disconnect', 'io server disconnect'); // arms the 1 s B-14 timer
    expect(client.state).toBe('reconnecting');
    expect(mockSockets.length).toBe(1);

    await client.notifyNetworkChange(); // network restored — no timer advance
    expect(mockSockets.length).toBe(2);

    // The pending B-14 timer was cancelled — no extra handshake later.
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(mockSockets.length).toBe(2);
  });

  it('does NOT resurrect a superseded session (B-11)', async () => {
    const client = newClient();
    await client.connect();
    lastSocket().__fire('connect');
    lastSocket().__fireAny('error', {code: 'superseded'});
    lastSocket().__fire('disconnect', 'io server disconnect');
    expect(client.state).toBe('superseded');

    await client.notifyNetworkChange();
    expect(mockSockets.length).toBe(1);
    expect(client.state).toBe('superseded');
  });

  it('stays a no-op after a user close()', async () => {
    const client = newClient();
    await client.connect();
    lastSocket().__fire('connect');
    client.close();

    await client.notifyNetworkChange();
    expect(mockSockets.length).toBe(1);
    expect(client.state).toBe('disconnected');
  });
});
