/**
 * MSG-RECONNECT / JWT-secret-drift — the unauthorized-refresh path must be
 * BOUNDED. When the server keeps rejecting the handshake but token refresh keeps
 * SUCCEEDING (the classic JWT_ACCESS_SECRET drift between auth and messenger:
 * the fresh token is signed correctly but verified against the wrong secret),
 * the old code looped forever (refresh → reopen → reject → refresh …), pinning
 * the UI on "reconnecting" and hammering auth-service /refresh. The cap stops the
 * storm after MAX_UNAUTH_REFRESH attempts and fails CLOSED to 'unauthorized'.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockSockets: Array<{__fire: (event: string, ...a: unknown[]) => void}> = [];
jest.mock('socket.io-client', () => ({
  __esModule: true,
  io: jest.fn(() => {
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const sock = {
      on(event: string, cb: (...args: unknown[]) => void) {
        (handlers[event] = handlers[event] ?? []).push(cb);
      },
      onAny() { /* unused */ },
      emit() { /* unused */ },
      disconnect() { /* unused */ },
      removeAllListeners() { /* unused */ },
      connected: true,
      id: 'sock-cap',
      __fire(event: string, ...args: unknown[]) {
        for (const cb of handlers[event] ?? []) { cb(...args); }
      },
    };
    mockSockets.push(sock);
    return sock;
  }),
}));

import {TransportClient} from '../src/transport/client';

const lastSocket = () => mockSockets[mockSockets.length - 1];

describe('TransportClient — unauthorized-refresh cap (JWT-drift)', () => {
  afterEach(() => { jest.clearAllMocks(); mockSockets.length = 0; jest.useRealTimers(); });

  it('caps the refresh storm and fails closed to unauthorized when refresh keeps succeeding but the server keeps rejecting', async () => {
    jest.useFakeTimers();
    const refresh = jest.fn().mockResolvedValue(undefined);
    const client = new TransportClient({
      url: 'http://localhost:3100',
      signalDeviceId: 1,
      getToken: async () => 'jwt-token',
      onFrame: () => undefined,
      refreshToken: refresh,
    });
    await client.connect();

    // Drive repeated handshake rejects. Each reject kicks a refresh (which
    // resolves), a backoff timer, then a reopen — onto which we fire the next
    // reject, simulating a server that never accepts the (correctly) refreshed
    // token. Without the cap this loop is unbounded.
    for (let i = 0; i < 8; i++) {
      const s = lastSocket();
      if (!s) { break; }
      s.__fire('connect_error', {data: {code: 'unauthorized'}});
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(5000); // fire the backoff timer
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }

    // Bounded: refresh fired but never more than the cap (without the fix it
    // would equal the number of rejects, i.e. 8).
    expect(refresh.mock.calls.length).toBeGreaterThan(0);
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(4);
    // Fails closed so the UI shows an actionable error, not an endless spinner.
    expect(client.state).toBe('unauthorized');
  });
});
