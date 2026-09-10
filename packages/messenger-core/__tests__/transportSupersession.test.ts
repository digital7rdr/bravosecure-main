/**
 * B-11 — single-device takeover (supersession).
 *
 * When a newer session for the same (user, device) connects, the server
 * emits `error{code:'superseded'}` and then disconnects the older socket
 * with `io server disconnect`. The OLD client must:
 *   1. surface a distinct 'superseded' state (UI: "active on another device"),
 *   2. NOT auto-reconnect — re-grabbing the slot would ping-pong the kick
 *      back to the device that just took over,
 *   3. clear that takeover memory on a later genuine (re)connect so a
 *      subsequent transient drop isn't misread as a supersession.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

// Fake socket.io socket whose lifecycle events we drive by hand. Unlike
// the B-05 reconnect test's mock, this one wires `onAny` so we can push
// the server's `error` frame through the client's central dispatch.
const mockSockets: Array<{
  __fire: (event: string, ...a: unknown[]) => void;
  __fireAny: (event: string, data: unknown) => void;
  __disconnectCalls: number;
  __connectCalls: number;
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
      connect() { sock.__connectCalls++; },
      disconnect() { sock.__disconnectCalls++; },
      removeAllListeners() { /* unused */ },
      connected: true,
      id: 'sock-1',
      __disconnectCalls: 0,
      __connectCalls: 0,
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
import {TransportClient, type TransportState} from '../src/transport/client';

const lastSocket = () => mockSockets[mockSockets.length - 1];

function newClient() {
  const states: TransportState[] = [];
  const client = new TransportClient({
    url: 'http://localhost:3100',
    signalDeviceId: 1,
    getToken: async () => 'jwt-token',
    onFrame: () => undefined,
    onStateChange: s => { states.push(s); },
  });
  return {client, states};
}

describe('TransportClient supersession — B-11', () => {
  afterEach(() => { jest.clearAllMocks(); mockSockets.length = 0; });

  it('enters the "superseded" state on an error{superseded} frame', async () => {
    const {client, states} = newClient();
    await client.connect();
    lastSocket().__fire('connect');
    expect(client.state).toBe('connected');

    lastSocket().__fireAny('error', {code: 'superseded', message: 'newer session took over'});
    expect(client.state).toBe('superseded');
    expect(states).toContain('superseded');
  });

  it('stays "superseded" (not "disconnected") on the server disconnect that follows', async () => {
    const {client} = newClient();
    await client.connect();
    lastSocket().__fire('connect');

    lastSocket().__fireAny('error', {code: 'superseded'});
    lastSocket().__fire('disconnect', 'io server disconnect');

    expect(client.state).toBe('superseded');
  });

  it('does NOT open a new socket after being superseded (no ping-pong)', async () => {
    const {client} = newClient();
    await client.connect();
    lastSocket().__fire('connect');
    const socketsBefore = mockSockets.length;

    lastSocket().__fireAny('error', {code: 'superseded'});
    lastSocket().__fire('disconnect', 'io server disconnect');

    // No new io() handshake and no socket.connect() retry on the old one.
    expect(mockSockets.length).toBe(socketsBefore);
    expect(lastSocket().__connectCalls).toBe(0);
    expect((io as jest.Mock).mock.calls.length).toBe(1);
  });

  it('a plain server disconnect WITHOUT a superseded frame is NOT "superseded"', async () => {
    const {client} = newClient();
    await client.connect();
    lastSocket().__fire('connect');

    lastSocket().__fire('disconnect', 'io server disconnect');

    // B-14 — a non-takeover server drop now recovers (reconnecting),
    // never the terminal 'superseded' state.
    expect(client.state).toBe('reconnecting');
    expect(client.state).not.toBe('superseded');
  });

  it('clears the takeover memory on a later reconnect (no false supersede)', async () => {
    const {client} = newClient();
    await client.connect();
    lastSocket().__fire('connect');
    lastSocket().__fireAny('error', {code: 'superseded'});
    expect(client.state).toBe('superseded');

    // A genuine reconnect clears the recorded code...
    lastSocket().__fire('connect');
    expect(client.state).toBe('connected');

    // ...so a later transient server drop is NOT misread as a takeover
    // (it recovers via B-14 instead of staying superseded).
    lastSocket().__fire('disconnect', 'io server disconnect');
    expect(client.state).toBe('reconnecting');
  });
});
