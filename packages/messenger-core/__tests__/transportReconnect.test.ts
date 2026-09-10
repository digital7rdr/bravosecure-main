/**
 * B-05 — TransportClient.onReconnect must fire on the SECOND 'connect'
 * (a genuine reopen after a drop) but NOT on the first connect.
 *
 * Why this matters: after the server's P0-6 revoked-socket sweep drops the
 * WS and the refresh path reopens it, the SFU room/transports were torn
 * down server-side. Group-call boot subscribes to onReconnect so it can
 * RE-JOIN the room (an ICE restart over the fresh socket would never
 * recover a room the server already deleted). The first connect must NOT
 * trigger a rejoin — there's nothing to rejoin yet.
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

// Fake socket.io socket whose 'connect' event we drive by hand. The
// factory must be self-contained (babel hoists jest.mock above imports
// and forbids referencing out-of-scope, non-`mock`-prefixed bindings).
// We stash the most recent fake socket on a `mock`-prefixed holder so the
// tests can read it back.
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
      emit() { /* unused */ },
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

const lastSocket = () => mockSockets[mockSockets.length - 1];

function newClient() {
  return new TransportClient({
    url: 'http://localhost:3100',
    signalDeviceId: 1,
    getToken: async () => 'jwt-token',
    onFrame: () => undefined,
  });
}

describe('TransportClient.onReconnect — B-05', () => {
  afterEach(() => { jest.clearAllMocks(); mockSockets.length = 0; });

  it('does NOT fire on the FIRST connect', async () => {
    const client = newClient();
    const spy = jest.fn();
    client.onReconnect(spy);
    await client.connect();
    lastSocket().__fire('connect');
    expect(spy).not.toHaveBeenCalled();
  });

  it('fires on the SECOND connect (a reopen after a drop)', async () => {
    const client = newClient();
    const spy = jest.fn();
    client.onReconnect(spy);
    await client.connect();
    lastSocket().__fire('connect'); // first connect
    expect(spy).not.toHaveBeenCalled();
    lastSocket().__fire('connect'); // reopen
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fires once per subsequent reconnect', async () => {
    const client = newClient();
    const spy = jest.fn();
    client.onReconnect(spy);
    await client.connect();
    lastSocket().__fire('connect'); // first
    lastSocket().__fire('connect'); // reopen 1
    lastSocket().__fire('connect'); // reopen 2
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe stops further notifications', async () => {
    const client = newClient();
    const spy = jest.fn();
    const off = client.onReconnect(spy);
    await client.connect();
    lastSocket().__fire('connect'); // first
    off();
    lastSocket().__fire('connect'); // reopen — should not reach spy
    expect(spy).not.toHaveBeenCalled();
  });

  it('a throwing listener does not block the others', async () => {
    const client = newClient();
    const boom = jest.fn(() => { throw new Error('boom'); });
    const ok = jest.fn();
    client.onReconnect(boom);
    client.onReconnect(ok);
    await client.connect();
    lastSocket().__fire('connect'); // first
    lastSocket().__fire('connect'); // reopen
    expect(boom).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
