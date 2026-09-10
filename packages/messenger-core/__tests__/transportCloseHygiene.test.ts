/**
 * WI-5.2 (transport G7) + WI-5.7 (transport G8) — a closed client is a
 * corpse, and reviving one must not resurrect the previous session.
 *
 * `close()` used to leave `frameListeners`, `reconnectListeners` and
 * `hasConnectedOnce` intact. A stale holder calling `forceReconnect()` on
 * the corpse revived it with every old listener attached, and — because
 * `hasConnectedOnce` was still true — the revival's very FIRST 'connect'
 * fired the reconnect listeners immediately: a group rejoin issued against a
 * brand-new session, plus the previous session's per-screen frame listeners
 * double-dispatching alongside the new client's.
 *
 * And `forceReconnect()` had a wall-clock throttle only while 'connected'
 * (Fix #18); from 'reconnecting'/'disconnected' every public call ran a full
 * handshake — a flurry of AppState transitions (or a stale holder hammering
 * a corpse) re-handshook at call cadence. The public surface is now floored
 * on both sides; the internal recovery paths (the B-14 ladder,
 * notifyNetworkChange, the SEC-1 reauth reopen) route through the unfloored
 * `reopenNow()` and keep their own pacing.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockSockets: Array<{__fire: (event: string, ...a: unknown[]) => void; __fireAny: (event: string, ...a: unknown[]) => void}> = [];
jest.mock('socket.io-client', () => ({
  __esModule: true,
  io: jest.fn(() => {
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const anyHandlers: Array<(...args: unknown[]) => void> = [];
    const sock = {
      on(event: string, cb: (...args: unknown[]) => void) {
        (handlers[event] = handlers[event] ?? []).push(cb);
      },
      onAny(cb: (...args: unknown[]) => void) { anyHandlers.push(cb); },
      emit() { /* unused */ },
      disconnect() { /* unused */ },
      removeAllListeners() { /* unused */ },
      connected: true,
      id: 'sock-x',
      __fire(event: string, ...args: unknown[]) {
        for (const cb of handlers[event] ?? []) { cb(...args); }
      },
      __fireAny(event: string, ...args: unknown[]) {
        for (const cb of anyHandlers) { cb(event, ...args); }
      },
    };
    mockSockets.push(sock);
    return sock;
  }),
}));

import {io} from 'socket.io-client';
import {TransportClient} from '../src/transport/client';

const ioMock = io as unknown as jest.Mock;
const lastSocket = () => mockSockets[mockSockets.length - 1];
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function newClient() {
  return new TransportClient({
    url: 'http://localhost:3100',
    signalDeviceId: 1,
    getToken: async () => 'jwt-token',
    onFrame: () => undefined,
  });
}

afterEach(() => { jest.clearAllMocks(); mockSockets.length = 0; });

describe('WI-5.2 — close() ends the subscriptions with the session', () => {
  it('a revived corpse does NOT fire the previous session\'s reconnect listeners', async () => {
    const client = newClient();
    const fired: string[] = [];
    client.onReconnect(() => fired.push('rejoin'));

    await client.connect();
    lastSocket().__fire('connect');           // first connect — no reconnect fire
    await flush();
    client.close();                            // logout — the session is over

    // A stale holder revives the corpse.
    await client.forceReconnect();
    await flush();
    lastSocket().__fire('connect');

    // Pre-fix: hasConnectedOnce was still true AND the listener survived —
    // this fired a group rejoin against a brand-new session.
    expect(fired).toEqual([]);
  });

  it('a revived corpse does NOT dispatch frames to the previous session\'s frame listeners', async () => {
    const client = newClient();
    const frames: string[] = [];
    client.addFrameListener(f => frames.push((f as {event: string}).event));

    await client.connect();
    lastSocket().__fire('connect');
    await flush();
    lastSocket().__fireAny('envelope.deliver', {id: 'e1'});
    expect(frames).toEqual(['envelope.deliver']);

    client.close();
    await client.forceReconnect();
    await flush();
    lastSocket().__fire('connect');
    lastSocket().__fireAny('envelope.deliver', {id: 'e2'});

    expect(frames).toEqual(['envelope.deliver']); // old listener is gone
  });

  it('after the revival, a SECOND connect is a genuine reconnect again (new subscribers work)', async () => {
    const client = newClient();
    await client.connect();
    lastSocket().__fire('connect');
    await flush();
    client.close();

    await client.forceReconnect();
    await flush();
    const fired: string[] = [];
    client.onReconnect(() => fired.push('rejoin'));
    lastSocket().__fire('connect');            // first connect of the NEW life
    expect(fired).toEqual([]);
    lastSocket().__fire('connect');            // a reopen within the new life
    expect(fired).toEqual(['rejoin']);
  });
});

describe('round 2 F-3 — onceConnected against the REAL client (no inert doubles)', () => {
  it('fires on a FIRST connect (the case onReconnect deliberately skips)', async () => {
    const client = newClient();
    const fired: string[] = [];
    client.onceConnected(() => fired.push('up'));
    await client.connect();
    expect(fired).toEqual([]);
    lastSocket().__fire('connect');
    expect(fired).toEqual(['up']);
    lastSocket().__fire('connect'); // one-shot — a later edge does not re-fire
    expect(fired).toEqual(['up']);
  });

  it('fires IMMEDIATELY when the socket is already up', async () => {
    const client = newClient();
    await client.connect();
    lastSocket().__fire('connect');
    await flush();
    const fired: string[] = [];
    client.onceConnected(() => fired.push('up'));
    expect(fired).toEqual(['up']);
  });

  it('close() clears armed one-shots — a revived corpse fires nothing old', async () => {
    const client = newClient();
    const fired: string[] = [];
    await client.connect();
    client.onceConnected(() => fired.push('stale'));
    client.close();
    await client.forceReconnect();
    await flush();
    lastSocket().__fire('connect');
    expect(fired).toEqual([]);
  });
});

describe('round 1 P1 — the in-flight refresh guard is wall-clock bounded', () => {
  it('a refresh that never settles cannot latch the benign branch forever', async () => {
    const base = 3_000_000_000;
    let now = base;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const refreshToken = jest.fn(() => new Promise<void>(() => { /* NEVER settles */ }));
      const client = new TransportClient({
        url: 'http://localhost:3100',
        signalDeviceId: 1,
        getToken: async () => 'jwt-token',
        onFrame: () => undefined,
        refreshToken,
      });
      await client.connect();
      lastSocket().__fire('connect');
      await flush();

      lastSocket().__fireAny('error', {code: 'token_revoked'});
      expect(refreshToken).toHaveBeenCalledTimes(1);

      // Within the stuck window: the benign branch owns it (no new refresh).
      now = base + 5_000;
      lastSocket().__fireAny('error', {code: 'token_revoked'});
      expect(refreshToken).toHaveBeenCalledTimes(1);

      // Past the stuck window: the stale flag falls through to a FRESH,
      // counted attempt instead of a silent permanent 'reconnecting'.
      now = base + 40_000;
      lastSocket().__fireAny('error', {code: 'token_revoked'});
      expect(refreshToken).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('WI-5.7 (G8) — forceReconnect is wall-clock floored while NOT connected', () => {
  it('two rapid public calls run ONE handshake; a later call runs again', async () => {
    const base = 1_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => base);
    try {
      const client = newClient();
      await client.forceReconnect();           // state 'disconnected' → floored side
      const opens = ioMock.mock.calls.length;

      await client.forceReconnect();           // within the window — coalesced/refused
      expect(ioMock.mock.calls.length).toBe(opens);

      nowSpy.mockImplementation(() => base + 5_000);
      await client.forceReconnect();           // past the window — runs
      expect(ioMock.mock.calls.length).toBe(opens + 1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('the B-14 ladder path is NOT floored (a server drop still recovers on its own pacing)', async () => {
    const base = 2_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => base);
    jest.useFakeTimers();
    try {
      const client = newClient();
      await client.connect();
      lastSocket().__fire('connect');
      await flush();
      const opensBefore = ioMock.mock.calls.length;

      // A non-takeover server disconnect schedules the ladder.
      lastSocket().__fire('disconnect', 'io server disconnect');
      await jest.advanceTimersByTimeAsync(3_000); // first backoff step fires
      await flush();

      // The ladder's reopen ran even though a public call at this instant
      // would have been floored — internal recovery is never starved.
      expect(ioMock.mock.calls.length).toBeGreaterThan(opensBefore);
    } finally {
      jest.useRealTimers();
      nowSpy.mockRestore();
    }
  });
});
