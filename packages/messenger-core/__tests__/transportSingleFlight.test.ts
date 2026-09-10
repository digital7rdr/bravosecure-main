/**
 * P1-12 (2026-07-09 audit §4) — single-flight open() + connect-generation
 * guard.
 *
 * Two reconnect triggers inside open()'s async window (the 5 s send-ack
 * watchdog racing an AppState-'active' forceReconnect, both suspended at
 * `await getToken()`) each used to build a socket. The first became an
 * orphan with live listeners; the gateway evicted one as `superseded` for
 * the same (user, device), and the app misread its own duplicate as a
 * device takeover → spurious full sign-out (productionRuntime signOut).
 * Concurrent callers must coalesce onto ONE in-flight open, and a close()
 * that lands while an open is suspended must prevent the stale
 * continuation from installing a socket.
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
      id: 'sock-sf',
      __fire(event: string, ...args: unknown[]) {
        for (const cb of handlers[event] ?? []) { cb(...args); }
      },
    };
    mockSockets.push(sock);
    return sock;
  }),
}));

import {io} from 'socket.io-client';
import {TransportClient} from '../src/transport/client';

describe('TransportClient — single-flight open (P1-12)', () => {
  afterEach(() => { jest.clearAllMocks(); mockSockets.length = 0; });

  it('two concurrent reopen triggers suspended at getToken produce exactly ONE socket', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const getToken = jest.fn(async () => { await gate; return 'jwt-token'; });
    const client = new TransportClient({
      url: 'http://localhost:3100',
      signalDeviceId: 1,
      getToken,
      onFrame: () => undefined,
    });

    const p1 = client.connect();        // watchdog-style reopen
    const p2 = client.forceReconnect(); // AppState-active reopen racing it
    release();
    await p1;
    await p2;

    // Pre-fix: two io() handshakes → orphan socket → gateway `superseded`.
    expect((io as jest.Mock).mock.calls.length).toBe(1);
    expect(mockSockets.length).toBe(1);
    // The second caller coalesced — it never ran its own token fetch.
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('a reopen AFTER the previous open completed still builds a fresh socket and tears the orphan down', async () => {
    const client = new TransportClient({
      url: 'http://localhost:3100',
      signalDeviceId: 1,
      getToken: async () => 'jwt-token',
      onFrame: () => undefined,
    });
    await client.connect();
    expect(mockSockets.length).toBe(1);
    const first = mockSockets[0];
    first.__fire('connect');
    // Drop so forceReconnect isn't throttled by the fresh-connect window.
    first.__fire('disconnect', 'transport close');

    await client.forceReconnect();
    expect(mockSockets.length).toBe(2);
    // The prior socket's listeners were stripped and it was closed — no
    // orphan with live listeners double-dispatching frames.
    expect(first.removeAllListeners).toHaveBeenCalled();
    expect(first.disconnect).toHaveBeenCalled();
  });

  it('close() during a suspended open bails the stale continuation — no socket, state stays disconnected', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const client = new TransportClient({
      url: 'http://localhost:3100',
      signalDeviceId: 1,
      getToken: async () => { await gate; return 'jwt-token'; },
      onFrame: () => undefined,
    });

    const p = client.connect();
    client.close(); // logout while the open is suspended at getToken
    release();
    await p;

    // The generation check must prevent the stale continuation from
    // installing an orphan socket after the close.
    expect((io as jest.Mock).mock.calls.length).toBe(0);
    expect(mockSockets.length).toBe(0);
    expect(client.state).toBe('disconnected');
  });
});
