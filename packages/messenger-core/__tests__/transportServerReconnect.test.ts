/**
 * B-14 — post-drop transport recovery.
 *
 * socket.io does NOT auto-reconnect after a server-initiated
 * `io server disconnect` (used for restart / idle reap / crash — B-05).
 * The messenger transport therefore used to sit dead (no recv.enter, no
 * sends) until the app was force-restarted. The client must drive the
 * reconnect itself with capped backoff — EXCEPT when the drop was a
 * single-device takeover (B-11), which must stay put, and except for a
 * user-initiated close (logout).
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
      id: 'sock',
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

import {io} from 'socket.io-client';
import {TransportClient} from '../src/transport/client';

const lastSocket = () => mockSockets[mockSockets.length - 1];
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function newClient() {
  return new TransportClient({
    url: 'http://localhost:3100',
    signalDeviceId: 1,
    getToken: async () => 'jwt-token',
    onFrame: () => undefined,
  });
}

describe('TransportClient server-drop recovery — B-14', () => {
  // Pin the backoff jitter to its midpoint (0.75 + 0.5*0.5 = 1.0×) so the
  // pre-jitter timings below stay exact; the jitter-edge tests re-pin it.
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

  it('opens a NEW socket (backoff reconnect) after a non-takeover server drop', async () => {
    const client = newClient();
    await client.connect();
    await flush();
    lastSocket().__fire('connect');
    const socketsBefore = mockSockets.length;

    lastSocket().__fire('disconnect', 'io server disconnect');
    expect(client.state).toBe('reconnecting');
    // Nothing yet — the reconnect is scheduled behind the backoff delay.
    expect(mockSockets.length).toBe(socketsBefore);

    jest.advanceTimersByTime(1_000); // first backoff step
    await flush();
    expect(mockSockets.length).toBe(socketsBefore + 1);
  });

  it('does NOT reconnect after a single-device takeover (B-11)', async () => {
    const client = newClient();
    await client.connect();
    await flush();
    lastSocket().__fire('connect');
    const socketsBefore = mockSockets.length;

    lastSocket().__fireAny('error', {code: 'superseded'});
    lastSocket().__fire('disconnect', 'io server disconnect');

    jest.advanceTimersByTime(60_000);
    await flush();
    expect(client.state).toBe('superseded');
    expect(mockSockets.length).toBe(socketsBefore); // no new handshake
  });

  it('a user-initiated close() cancels a pending reconnect', async () => {
    const client = newClient();
    await client.connect();
    await flush();
    lastSocket().__fire('connect');
    const socketsBefore = mockSockets.length;

    lastSocket().__fire('disconnect', 'io server disconnect'); // schedules reconnect
    client.close();                                            // user logs out

    jest.advanceTimersByTime(60_000);
    await flush();
    expect(client.state).toBe('disconnected');
    expect(mockSockets.length).toBe(socketsBefore); // reconnect was cancelled
  });

  it('keeps retrying with growing backoff until it reconnects', async () => {
    const client = newClient();
    await client.connect();
    await flush();
    lastSocket().__fire('connect');
    let count = mockSockets.length;

    // Drop #1 → reconnect after ~1s
    lastSocket().__fire('disconnect', 'io server disconnect');
    jest.advanceTimersByTime(1_000);
    await flush();
    expect(mockSockets.length).toBe(++count);

    // The fresh socket also gets dropped before connecting → backoff grows
    // (~2s), so 1s isn't enough but 2s is.
    lastSocket().__fire('disconnect', 'io server disconnect');
    jest.advanceTimersByTime(1_000);
    await flush();
    expect(mockSockets.length).toBe(count); // not yet
    jest.advanceTimersByTime(1_000);
    await flush();
    expect(mockSockets.length).toBe(++count); // fired at ~2s

    // A successful connect resets the backoff.
    lastSocket().__fire('connect');
    expect(client.state).toBe('connected');
    expect((io as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  // P3 (2026-07-09 audit §8) — the backoff carries ±25% random jitter so a
  // fleet that all saw the same service restart doesn't reconnect in
  // lockstep waves (thundering herd).
  it('jitter stretches the backoff delay at the upper edge (1.25×)', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(1);
    const client = newClient();
    await client.connect();
    await flush();
    lastSocket().__fire('connect');
    const before = mockSockets.length;

    lastSocket().__fire('disconnect', 'io server disconnect');
    jest.advanceTimersByTime(1_000); // base delay — jittered past this
    await flush();
    expect(mockSockets.length).toBe(before);
    jest.advanceTimersByTime(250);   // 1.25 × base
    await flush();
    expect(mockSockets.length).toBe(before + 1);
  });

  it('jitter shortens the backoff delay at the lower edge (0.75×)', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const client = newClient();
    await client.connect();
    await flush();
    lastSocket().__fire('connect');
    const before = mockSockets.length;

    lastSocket().__fire('disconnect', 'io server disconnect');
    jest.advanceTimersByTime(750);   // 0.75 × base
    await flush();
    expect(mockSockets.length).toBe(before + 1);
  });
});
