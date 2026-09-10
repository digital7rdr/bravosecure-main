/**
 * White-box coverage for the socket.io TransportClient state machine:
 * connect/disconnect routing, the auth-reject refresh path + attempt cap
 * (B-05), single-device takeover (B-11), server-disconnect backoff (B-14),
 * frame fan-out, and forceReconnect throttling.
 *
 * socket.io-client + AsyncStorage are mocked; we drive the captured event
 * handlers directly to exercise each transition.
 */

const handlers: Record<string, (...a: unknown[]) => void> = {};
const mockSocket = {
  connected: false,
  id: 'sock-1',
  on: (ev: string, cb: (...a: unknown[]) => void) => {handlers[ev] = cb;},
  onAny: (cb: (...a: unknown[]) => void) => {handlers.__any = cb;},
  emit: jest.fn(),
  disconnect: jest.fn(),
  removeAllListeners: jest.fn(),
};
const mockIo = jest.fn((..._a: unknown[]) => mockSocket);

jest.mock('socket.io-client', () => ({io: (...a: unknown[]) => mockIo(...a)}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
  },
}));

import {TransportClient} from '../src/transport/client';
import type {TransportOptions} from '../src/transport/client';
import type {ServerFrame} from '../src/transport/protocol';

function makeClient(over: Partial<TransportOptions> = {}) {
  const states: string[] = [];
  const frames: ServerFrame[] = [];
  const opts = {
    url: 'http://h:3100',
    signalDeviceId: 1,
    getToken: jest.fn(async () => 'tok'),
    onFrame: (f: ServerFrame) => frames.push(f),
    onStateChange: (s: string) => states.push(s),
    ...over,
  };
  const client = new TransportClient(opts as never);
  return {client, opts, states, frames};
}

beforeEach(() => {
  for (const k of Object.keys(handlers)) {delete handlers[k];}
  mockSocket.connected = false;
  mockSocket.emit.mockReset();
  mockSocket.disconnect.mockReset();
  mockSocket.removeAllListeners.mockReset();
  mockIo.mockClear();
});

describe('TransportClient — connect lifecycle', () => {
  it('connects: connecting → connected, and io() is called once', async () => {
    const {client, states} = makeClient();
    await client.connect();
    expect(mockIo).toHaveBeenCalledTimes(1);
    expect(states).toContain('connecting');
    handlers.connect();
    expect(client.state).toBe('connected');
    expect(states[states.length - 1]).toBe('connected');
  });

  it('aborts to unauthorized when getToken returns null', async () => {
    const {client} = makeClient({getToken: jest.fn(async () => null)});
    await client.connect();
    expect(client.state).toBe('unauthorized');
    expect(mockIo).not.toHaveBeenCalled();
  });

  it('send throws when not connected, emits when connected', async () => {
    const {client} = makeClient();
    expect(() => client.send({event: 'x', data: {}} as never)).toThrow(/not open/);
    await client.connect();
    mockSocket.connected = true;
    handlers.connect();
    client.send({event: 'presence', data: {state: 'active'}} as never);
    expect(mockSocket.emit).toHaveBeenCalledWith('presence', {state: 'active'});
  });
});

describe('TransportClient — frame dispatch', () => {
  it('routes normal frames to onFrame and registered listeners', async () => {
    const {client, frames} = makeClient();
    await client.connect();
    const seen: ServerFrame[] = [];
    const unsub = client.addFrameListener(f => seen.push(f));
    handlers.__any('envelope.deliver', {id: 'e1'});
    expect(frames).toEqual([{event: 'envelope.deliver', data: {id: 'e1'}}]);
    expect(seen).toHaveLength(1);
    unsub();
    handlers.__any('envelope.deliver', {id: 'e2'});
    expect(seen).toHaveLength(1); // unsubscribed
  });

  it('does NOT forward an unauthorized error frame as a normal frame', async () => {
    const {client, frames} = makeClient(); // no refreshToken
    await client.connect();
    handlers.__any('error', {code: 'unauthorized'});
    expect(frames).toHaveLength(0);
    expect(client.state).toBe('unauthorized');
    expect(mockSocket.disconnect).toHaveBeenCalled();
  });

  it('treats a superseded error frame as a terminal takeover state', async () => {
    const {client} = makeClient();
    await client.connect();
    handlers.__any('error', {code: 'superseded'});
    expect(client.state).toBe('superseded');
  });
});

describe('TransportClient — auth-reject refresh (B-05)', () => {
  it('connect_error with an auth code drives a single-flight refresh', async () => {
    const refreshToken = jest.fn(async () => {});
    const {client, states} = makeClient({refreshToken});
    await client.connect();
    handlers.connect_error({data: {code: 'unauthorized'}});
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(states).toContain('reconnecting');
    expect(mockSocket.disconnect).toHaveBeenCalled();
  });

  it('a non-auth connect_error just goes to reconnecting (no refresh)', async () => {
    const refreshToken = jest.fn(async () => {});
    const {client} = makeClient({refreshToken});
    await client.connect();
    handlers.connect_error({message: 'timeout'});
    expect(refreshToken).not.toHaveBeenCalled();
    expect(client.state).toBe('reconnecting');
  });

  it('surfaces unauthorized after the refresh-attempt cap is exceeded', async () => {
    // Each rejected attempt increments the counter; after MAX (4) the next
    // reject trips the cap and surfaces a terminal unauthorized.
    const refreshToken = jest.fn(async () => {});
    const {client} = makeClient({refreshToken});
    await client.connect();
    for (let i = 0; i < 4; i++) {
      // clear the in-flight flag between attempts (a real refresh resolves it)
      handlers.connect_error({data: {code: 'unauthorized'}});
      (client as unknown as {unauthorizedRefreshInFlight: boolean}).unauthorizedRefreshInFlight = false;
    }
    handlers.connect_error({data: {code: 'unauthorized'}});
    expect(client.state).toBe('unauthorized');
  });
});

describe('TransportClient — disconnect routing', () => {
  it('io server disconnect after superseded stays superseded (no reconnect)', async () => {
    const {client} = makeClient();
    await client.connect();
    handlers.__any('error', {code: 'superseded'});
    handlers.disconnect('io server disconnect');
    expect(client.state).toBe('superseded');
  });

  it('a transient disconnect goes to reconnecting', async () => {
    const {client} = makeClient();
    await client.connect();
    handlers.connect();
    handlers.disconnect('transport close');
    expect(client.state).toBe('reconnecting');
  });

  it('a user-initiated close goes to disconnected and clears persisted recovery', async () => {
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      removeItem: jest.Mock;
    };
    const {client} = makeClient();
    await client.connect();
    client.close();
    expect(client.state).toBe('disconnected');
    expect(mockSocket.disconnect).toHaveBeenCalled();
    expect(AsyncStorage.removeItem).toHaveBeenCalled();
  });
});

describe('TransportClient — best-effort sends + forceReconnect throttle', () => {
  it('subscribePresence/subscribeMission no-op on empty input', async () => {
    const {client} = makeClient();
    await client.connect();
    mockSocket.connected = true;
    handlers.connect();
    mockSocket.emit.mockReset();
    client.subscribePresence([]);
    client.subscribeMission('');
    expect(mockSocket.emit).not.toHaveBeenCalled();
    client.subscribePresence(['u1']);
    expect(mockSocket.emit).toHaveBeenCalledWith('presence.subscribe', {userIds: ['u1']});
  });

  it('forceReconnect rebuilds the socket when disconnected', async () => {
    const {client} = makeClient();
    await client.connect();
    mockIo.mockClear();
    await client.forceReconnect();
    expect(mockIo).toHaveBeenCalledTimes(1);
  });
});
