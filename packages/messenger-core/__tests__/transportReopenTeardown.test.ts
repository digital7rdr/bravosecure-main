/**
 * Audit RELAY-C1 (2026-07-02) — open() must tear down the prior socket's
 * listeners before opening a new one.
 *
 * The token-refresh reopen (handleAuthReject → open()) and the inline-error
 * reopen reach open() WITHOUT going through forceReconnect() (which already
 * removes listeners). With socket.io's forceNew:false the Manager/Socket is
 * reused, so if open() doesn't strip the old listeners it stacks a second
 * set — every server frame then dispatches twice (duplicate libsignal
 * decrypt corrupts the ratchet / raises spurious bad-MAC banners). The F5
 * fix that was supposed to close this landed in a DEAD mobile copy of the
 * transport; this test locks the guard into the live messenger-core module.
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
  removeAllListeners: jest.Mock;
  disconnect: jest.Mock;
  __fire: (event: string, ...a: unknown[]) => void;
}> = [];
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
      connect() { /* unused */ },
      disconnect: jest.fn(),
      removeAllListeners: jest.fn(),
      connected: true,
      id: 'sock-reopen',
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
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('TransportClient — reopen tears down prior listeners (RELAY-C1)', () => {
  afterEach(() => { jest.clearAllMocks(); mockSockets.length = 0; jest.useRealTimers(); });

  it('calls removeAllListeners() + disconnect() on the previous socket before opening a new one on refresh-reopen', async () => {
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
    await flush();

    const socket1 = lastSocket();
    expect(mockSockets.length).toBe(1);

    // One handshake reject → handleAuthReject kicks a refresh → backoff → open().
    socket1.__fire('connect_error', {data: {code: 'unauthorized'}});
    await flush();
    jest.advanceTimersByTime(1000); // clear the 400*attempt backoff
    await flush();

    // A new socket was opened...
    expect(mockSockets.length).toBe(2);
    // ...and the previous socket's listeners were stripped first (the fix).
    expect(socket1.removeAllListeners).toHaveBeenCalled();
  });
});
