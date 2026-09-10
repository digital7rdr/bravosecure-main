/**
 * OR-2 — the send-recovery clock seam on the transport.
 *
 * `onServerSignal` must fire from the engine.io Manager ping ALONE (the only
 * clock that survives a locked screen — B-100/B-101 proved it for auth
 * renewal) and from inbound application frames; `hasPendingOutbound` must
 * earn the same timer-free reopen a live call gets, without widening the
 * no-call/no-pending herd behaviour.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

interface FakeSocket {
  connected: boolean;
  emitted: Array<{event: string; data: unknown}>;
  __fire: (event: string, ...args: unknown[]) => void;
  __fireAny: (event: string, ...args: unknown[]) => void;
  __fireManagerPing: () => void;
}

const sharedManagerListeners: Record<string, Array<() => void>> = {};
const sharedManager = {
  on(e: string, cb: () => void) { (sharedManagerListeners[e] = sharedManagerListeners[e] ?? []).push(cb); },
  off(e: string, cb: () => void) {
    sharedManagerListeners[e] = (sharedManagerListeners[e] ?? []).filter(f => f !== cb);
  },
  __listenerCount(e: string) { return (sharedManagerListeners[e] ?? []).length; },
  __fire(e: string) { [...(sharedManagerListeners[e] ?? [])].forEach(cb => cb()); },
};

const mockSockets: FakeSocket[] = [];

jest.mock('socket.io-client', () => ({
  __esModule: true,
  io: jest.fn(() => {
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    const anyHandlers: Array<(event: string, ...a: unknown[]) => void> = [];
    const sock: FakeSocket & Record<string, unknown> = {
      connected: true,
      emitted: [],
      on(event: string, cb: (...a: unknown[]) => void) {
        (handlers[event] = handlers[event] ?? []).push(cb);
      },
      onAny(cb: (event: string, ...a: unknown[]) => void) { anyHandlers.push(cb); },
      removeAllListeners() { /* no-op */ },
      emit(event: string, data: unknown, ack?: (resp: unknown) => void) {
        sock.emitted.push({event, data});
        if (ack) { setTimeout(() => ack({ok: true}), 0); }
      },
      disconnect() { sock.connected = false; },
      __fire(event: string, ...args: unknown[]) {
        (handlers[event] ?? []).forEach(cb => cb(...args));
      },
      __fireAny(event: string, ...args: unknown[]) {
        anyHandlers.forEach(cb => cb(event, ...args));
      },
      io: sharedManager,
      __fireManagerPing() { sharedManager.__fire('ping'); },
    };
    mockSockets.push(sock);
    return sock;
  }),
}));

import {TransportClient} from '../src/transport/client';

function tokenExpiringIn(secondsFromNow: number): string {
  const payload = {exp: Math.floor(Date.now() / 1000) + secondsFromNow, sub: 'u1'};
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
  return `header.${b64}.sig`;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) { await Promise.resolve(); }
  await new Promise(r => setTimeout(r, 0));
  for (let i = 0; i < 6; i++) { await Promise.resolve(); }
};

async function connectWith(opts: {
  onServerSignal?: () => void;
  hasLiveCall?: () => boolean;
  hasPendingOutbound?: () => boolean;
}): Promise<{client: TransportClient; socket: FakeSocket}> {
  mockSockets.length = 0;
  const client = new TransportClient({
    url: 'http://localhost:3100',
    signalDeviceId: 1,
    getToken: async () => tokenExpiringIn(3600),
    onFrame: () => { /* ignored */ },
    ...opts,
  });
  await client.connect();
  const socket = mockSockets[0];
  socket.__fire('connect');
  await flush();
  return {client, socket};
}

describe('OR-2 — TransportClient onServerSignal / hasPendingOutbound', () => {
  beforeEach(() => {
    Object.keys(sharedManagerListeners).forEach(k => { sharedManagerListeners[k] = []; });
  });
  afterEach(() => { jest.clearAllMocks(); });

  it('fires from the Manager ping alone — no socket.io event, no timer advance', async () => {
    const spy = jest.fn();
    const {socket} = await connectWith({onServerSignal: spy});
    spy.mockClear();
    socket.__fireManagerPing();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fires on an inbound application frame', async () => {
    const spy = jest.fn();
    const {socket} = await connectWith({onServerSignal: spy});
    spy.mockClear();
    socket.__fireAny('presence', {});
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a throwing subscriber does not break the socket', async () => {
    const spy = jest.fn(() => { throw new Error('subscriber bug'); });
    const {client, socket} = await connectWith({onServerSignal: spy});
    socket.__fireManagerPing();
    socket.__fireAny('presence', {});
    expect(spy).toHaveBeenCalled();
    expect(client.state).toBe('connected');
  });

  it('does not fire after close()', async () => {
    const spy = jest.fn();
    const {client, socket} = await connectWith({onServerSignal: spy});
    client.close();
    spy.mockClear();
    socket.__fireManagerPing();
    expect(spy).not.toHaveBeenCalled();
  });

  it('hasPendingOutbound drives a timer-free reopen with NO live call', async () => {
    const {socket} = await connectWith({
      hasLiveCall: () => false,
      hasPendingOutbound: () => true,
    });
    const socketsBefore = mockSockets.length;
    socket.__fire('disconnect', 'transport close');
    await flush();
    expect(mockSockets.length).toBeGreaterThan(socketsBefore);
  });

  it('neither opt set → a transport-close drop schedules nothing (herd guard intact)', async () => {
    const {socket} = await connectWith({});
    const socketsBefore = mockSockets.length;
    socket.__fire('disconnect', 'transport close');
    await flush();
    expect(mockSockets.length).toBe(socketsBefore);
  });
});
