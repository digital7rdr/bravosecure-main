/**
 * Regression: fire-and-forget control frames (mission/presence subscribe-unsubscribe,
 * activity) must be BEST-EFFORT — a send against a closed transport must NOT throw.
 *
 * Why this matters: useMissionEvents calls transport.subscribeMission inside a React
 * effect. When the WS is down (cold boot, reconnect, post-logout) the un-guarded throw
 * escaped the effect into the app's ErrorBoundary and crashed the whole app
 * ("Something went wrong" / "transport not open"). The subscriptions re-establish on the
 * next reconnect, so dropping them while closed is correct.
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockSockets: Array<{__fire: (event: string, ...a: unknown[]) => void; emit: jest.Mock}> = [];
jest.mock('socket.io-client', () => ({
  __esModule: true,
  io: jest.fn(() => {
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const sock = {
      on(event: string, cb: (...args: unknown[]) => void) {
        (handlers[event] = handlers[event] ?? []).push(cb);
      },
      onAny() { /* unused */ },
      emit: jest.fn(),
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
    url: 'http://localhost:3100', signalDeviceId: 1,
    getToken: async () => 'jwt-token', onFrame: () => undefined,
  });
}

describe('TransportClient — best-effort subscription sends', () => {
  afterEach(() => { jest.clearAllMocks(); mockSockets.length = 0; });

  it('subscribe/presence/activity do NOT throw on a CLOSED transport (the crash fix)', () => {
    const client = newClient(); // never connected → socket is null
    expect(() => client.subscribeMission('m1')).not.toThrow();
    expect(() => client.unsubscribeMission('m1')).not.toThrow();
    expect(() => client.subscribePresence(['u1'])).not.toThrow();
    expect(() => client.unsubscribePresence(['u1'])).not.toThrow();
    expect(() => client.setActivity('active')).not.toThrow();
  });

  it('send() STILL throws on a closed transport (unchanged — callers that need failure see it)', () => {
    const client = newClient();
    expect(() => client.send({event: 'mission.subscribe', data: {missionId: 'm1'}})).toThrow('transport not open');
  });

  it('subscribeMission emits the frame when the transport is OPEN', async () => {
    const client = newClient();
    await client.connect();
    lastSocket().__fire('connect');
    client.subscribeMission('m1');
    expect(lastSocket().emit).toHaveBeenCalledWith('mission.subscribe', {missionId: 'm1'});
  });
});
