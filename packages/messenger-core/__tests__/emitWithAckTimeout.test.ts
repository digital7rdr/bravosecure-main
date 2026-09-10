/**
 * B-16 — emitWithAck's default ack timeout must be 15_000 ms (not 8_000).
 *
 * Why: measured Contabo ping spikes hit ~2601 ms. At an 8 s default the SFU
 * signalling round-trips (sfu.producers / restartIce, sent via wsRequest →
 * emitWithAck with NO explicit timeout) gave up after only ~3 RTT and
 * abandoned otherwise-recoverable calls. 15 s ≈ 5 RTT at 2601 ms.
 *
 * INVARIANT under test: with no timeout arg the promise rejects with the
 * exact message `ack_timeout:<event>` (B-05/B-06 code + tests grep for that
 * literal) only AFTER ~15 s — it must NOT reject at 8 s, and it must NOT
 * resolve before the deadline when the server never acks.
 */

// AsyncStorage isn't available in the node test env — stub the methods
// TransportClient touches so open()/connect() don't throw.
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

// Fake socket.io socket whose ack callback is NEVER invoked, so the only
// thing that can settle emitWithAck is its internal timeout. The factory
// must be self-contained (babel hoists jest.mock above imports).
const mockSockets: Array<{__fire: (event: string, ...a: unknown[]) => void}> = [];
jest.mock('socket.io-client', () => ({
  __esModule: true,
  io: jest.fn(() => {
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const sock = {
      on(event: string, cb: (...args: unknown[]) => void) {
        (handlers[event] = handlers[event] ?? []).push(cb);
      },
      onAny() { /* unused here */ },
      emit() { /* never calls the ack — forces the timeout path */ },
      disconnect() { /* unused */ },
      removeAllListeners() { /* unused */ },
      connected: true,
      id: 'sock-1',
      __fire(event: string, ...args: unknown[]) {
        for (const cb of handlers[event] ?? []) { cb(...args); }
      },
    };
    mockSockets.push(sock);
    return sock;
  }),
}));

import {TransportClient} from '../src/transport/client';

function newClient() {
  return new TransportClient({
    url: 'http://localhost:3100',
    signalDeviceId: 1,
    getToken: async () => 'jwt-token',
    onFrame: () => undefined,
  });
}

describe('TransportClient.emitWithAck default timeout — B-16', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
    mockSockets.length = 0;
  });

  it('does NOT reject at the old 8 s ceiling when no timeout arg is passed', async () => {
    const client = newClient();
    await client.connect();
    const p = client.emitWithAck('sfu.producers', {roomId: 'r1'});
    // Guard against an unhandled rejection if the assertion logic changes.
    const settled = jest.fn();
    p.then(() => settled('resolved'), () => settled('rejected'));

    jest.advanceTimersByTime(8_000);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    // Drain the real timeout so the promise can't leak as unhandled.
    jest.advanceTimersByTime(7_000);
    await expect(p).rejects.toThrow('ack_timeout:sfu.producers');
  });

  it('rejects with the exact ack_timeout:<event> message at the new 15 s default', async () => {
    const client = newClient();
    await client.connect();
    const p = client.emitWithAck('sfu.join', {roomId: 'r1'});
    p.catch(() => undefined); // avoid unhandled-rejection noise pre-await

    jest.advanceTimersByTime(15_000);
    await expect(p).rejects.toThrow('ack_timeout:sfu.join');
  });

  it('still honours an explicit shorter timeout (fail-fast callers unaffected)', async () => {
    const client = newClient();
    await client.connect();
    const p = client.emitWithAck('sfu.restartIce', {roomId: 'r1'}, 3_000);
    p.catch(() => undefined);

    jest.advanceTimersByTime(3_000);
    await expect(p).rejects.toThrow('ack_timeout:sfu.restartIce');
  });
});
