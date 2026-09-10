/**
 * P1-13 (2026-07-09 audit §4) — recovery handback must use the PRIVATE
 * socket.io recovery pid (`_pid`), never `socket.id`.
 *
 * socket.io-client 4.x has no public `pid`; the recovery session id the
 * server keys `restoreSession` by is the private `_pid` delivered in the
 * CONNECT payload when connectionStateRecovery is enabled. The old code
 * captured `socket.id` as the pid, so (a) recovery never fired on rebuilt
 * sockets (the 2-minute missed-frame replay was dead), and (b) injecting
 * the wrong `auth.pid` overrode the lib's own `_pid` in its CONNECT
 * builder, breaking stock in-process recovery too. Contract under test:
 *   - capture `_pid` only, never fall back to `socket.id`,
 *   - inject `auth.pid`/`auth.offset` ONLY when a real pid was captured,
 *   - clear a stale persisted pid after a connect that carries no `_pid`.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

// Per-open socket customization: the factory reads these `mock`-prefixed
// holders at io() time so each test controls what the "server" hands back.
let mockNextPid: string | undefined;
let mockRecovered: boolean;
const mockSockets: Array<{
  __fire: (event: string, ...a: unknown[]) => void;
  __fireAny: (event: string, ...a: unknown[]) => void;
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
      id: 'raw-socket-id',
      recovered: mockRecovered,
      _pid: mockNextPid,
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

import AsyncStorage from '@react-native-async-storage/async-storage';
import {io} from 'socket.io-client';
import {TransportClient} from '../src/transport/client';

const PID_KEY = 'bravo:transport:recoveryPid';
const lastSocket = () => mockSockets[mockSockets.length - 1];
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const authOfCall = (n: number) =>
  ((io as jest.Mock).mock.calls[n][1] as {auth: Record<string, unknown>}).auth;

function newClient() {
  return new TransportClient({
    url: 'http://localhost:3100',
    signalDeviceId: 1,
    getToken: async () => 'jwt-token',
    onFrame: () => undefined,
  });
}

describe('TransportClient — recovery pid handback (P1-13)', () => {
  beforeEach(() => { mockNextPid = undefined; mockRecovered = false; });
  afterEach(() => { jest.clearAllMocks(); mockSockets.length = 0; });

  it('captures the private _pid and hands it back as auth.pid on the next handshake', async () => {
    mockNextPid = 'srv-recovery-pid';
    const client = newClient();
    await client.connect();
    lastSocket().__fire('connect');
    await flush();
    lastSocket().__fire('disconnect', 'transport close'); // exit the throttle window

    await client.forceReconnect();
    const auth = authOfCall(1);
    expect(auth.pid).toBe('srv-recovery-pid');
    // NEVER the raw socket.id — that is not a recovery key.
    expect(auth.pid).not.toBe('raw-socket-id');
    // No offset seen yet — empty string means "replay from buffer start".
    expect(auth.offset).toBe('');
  });

  it('hands back the last captured recovery offset alongside the pid', async () => {
    mockNextPid = 'srv-pid-2';
    const client = newClient();
    await client.connect();
    lastSocket().__fire('connect');
    await flush();
    // Recovery offset arrives as the trailing string arg of any emit.
    lastSocket().__fireAny('envelope.deliver', {id: 'e1'}, 'offset-42');
    lastSocket().__fire('disconnect', 'transport close');

    await client.forceReconnect();
    const auth = authOfCall(1);
    expect(auth.pid).toBe('srv-pid-2');
    expect(auth.offset).toBe('offset-42');
  });

  it('omits auth.pid AND auth.offset entirely when the server sent no _pid (recovery disabled)', async () => {
    const client = newClient(); // mockNextPid undefined
    await client.connect();
    lastSocket().__fire('connect');
    await flush();
    lastSocket().__fire('disconnect', 'transport close');

    await client.forceReconnect();
    const auth = authOfCall(1);
    expect(Object.prototype.hasOwnProperty.call(auth, 'pid')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(auth, 'offset')).toBe(false);
    // And socket.id was never persisted as a bogus recovery pid.
    const setCalls = (AsyncStorage.setItem as jest.Mock).mock.calls;
    expect(setCalls.filter(c => c[0] === PID_KEY)).toHaveLength(0);
  });

  it('clears a stale persisted pid (old builds stored socket.id) after a no-_pid connect', async () => {
    (AsyncStorage.getItem as jest.Mock).mockImplementation(
      async (k: string) => (k === PID_KEY ? 'stale-raw-socket-id' : null),
    );
    const client = newClient();
    await client.connect();
    // Rollover: the very first handshake still carries the stale value...
    expect(authOfCall(0).pid).toBe('stale-raw-socket-id');
    // ...but a connect that delivers no _pid must clear it.
    lastSocket().__fire('connect');
    await flush();
    expect((AsyncStorage.removeItem as jest.Mock).mock.calls.map(c => c[0])).toContain(PID_KEY);
    // Mirror the removeItem the client just issued (the mock store is static).
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);

    lastSocket().__fire('disconnect', 'transport close');
    await client.forceReconnect();
    const auth = authOfCall(1);
    expect(Object.prototype.hasOwnProperty.call(auth, 'pid')).toBe(false);
  });

  it('keeps the pid we handed back when the server honoured recovery (socket.recovered === true)', async () => {
    mockNextPid = 'pid-A';
    const client = newClient();
    await client.connect();
    lastSocket().__fire('connect'); // captures pid-A
    await flush();
    lastSocket().__fire('disconnect', 'transport close');

    // The reopened socket reports a RECOVERED session (and exposes no
    // fresh _pid) — the pid we sent stays authoritative.
    mockNextPid = undefined;
    mockRecovered = true;
    await client.forceReconnect();
    expect(authOfCall(1).pid).toBe('pid-A');
    lastSocket().__fire('connect');
    await flush();
    lastSocket().__fire('disconnect', 'transport close');

    mockRecovered = false;
    // WI-5.7 (G8) — the public forceReconnect is wall-clock floored while not
    // connected; step past the window so this second reopen is a fresh call,
    // not a hammering duplicate the floor exists to suppress.
    const base = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => base + 5_000);
    try {
      mockNextPid = 'pid-A';
      await client.forceReconnect();
      expect(authOfCall(2).pid).toBe('pid-A');
    } finally {
      nowSpy.mockRestore();
    }
  });
});
