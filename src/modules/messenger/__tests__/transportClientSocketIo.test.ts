/**
 * First executable coverage for `src/modules/messenger/transport/client.ts`
 * — the mobile-local `TransportClient` re-exported by `transport/index.ts`.
 *
 * The class is one long list of fixes whose failure modes are all silent:
 * a stranded `unauthorized` socket the user can only clear by restarting
 * (Round 2 refresh), a duplicated listener set that decrypts every frame
 * twice (F5), a handshake storm on AppState chatter (Fix #18), a lost
 * connectionStateRecovery pid on kill-revive (Fix #17), and a JWT in the
 * query string that every reverse proxy logs (Audit P0-W4). Each of those
 * gets a test that goes red if the guard is removed.
 *
 * Everything runs the REAL class; only the two edges are mocked — the
 * socket.io factory (whose lifecycle events the tests fire by hand) and
 * AsyncStorage.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    jest.fn(async () => null),
    setItem:    jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

// The io() factory reads these `mock`-prefixed holders so each test decides
// what the "server" hands back on the next handshake. (babel-plugin-jest-hoist
// hoists jest.mock above the imports and only tolerates `mock*` references.)
let mockNextId: string | undefined;
let mockNextPid: string | undefined;
let mockNextRecovered: boolean | undefined;

interface MockSocket {
  on:                 (e: string, cb: (...a: unknown[]) => void) => void;
  onAny:              (cb: (e: string, ...a: unknown[]) => void) => void;
  emit:               jest.Mock;
  disconnect:         jest.Mock;
  removeAllListeners: jest.Mock;
  connected:          boolean;
  id?:                string;
  pid?:               string;
  recovered?:         boolean;
  __fire:             (e: string, ...a: unknown[]) => void;
  __fireAny:          (e: string, ...a: unknown[]) => void;
  __handlerCount:     (e: string) => number;
}

const mockSockets: MockSocket[] = [];

jest.mock('socket.io-client', () => ({
  __esModule: true,
  io: jest.fn(() => {
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    const anyHandlers: Array<(e: string, ...a: unknown[]) => void> = [];
    const sock: Record<string, unknown> = {
      on(e: string, cb: (...a: unknown[]) => void) { (handlers[e] = handlers[e] ?? []).push(cb); },
      onAny(cb: (e: string, ...a: unknown[]) => void) { anyHandlers.push(cb); },
      emit:       jest.fn(),
      disconnect: jest.fn(),
      removeAllListeners: jest.fn(() => {
        for (const k of Object.keys(handlers)) { delete handlers[k]; }
        anyHandlers.length = 0;
      }),
      connected: true,
      id:        mockNextId ?? 'raw-socket-id',
      // P1-13 — the recovery session id is the PRIVATE _pid socket.io-client
      // stores from the CONNECT payload; there is no public .pid. The mock
      // mirrors the real shape or the capture test passes vacuously.
      _pid:      mockNextPid,
      recovered: mockNextRecovered,
      __fire(e: string, ...a: unknown[]) { for (const cb of [...(handlers[e] ?? [])]) { cb(...a); } },
      __fireAny(e: string, ...a: unknown[]) { for (const cb of [...anyHandlers]) { cb(e, ...a); } },
      __handlerCount(e: string) { return e === '*' ? anyHandlers.length : (handlers[e] ?? []).length; },
    };
    mockSockets.push(sock as unknown as MockSocket);
    return sock;
  }),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {io} from 'socket.io-client';
import {TransportClient, type TransportState} from '../transport/client';

const PID_KEY = 'bravo:transport:recoveryPid';

const lastSocket = (): MockSocket => mockSockets[mockSockets.length - 1];
const ioMock = io as unknown as jest.Mock;
const ioOpts = (n: number): Record<string, unknown> =>
  ioMock.mock.calls[n][1] as Record<string, unknown>;
const ioAuth = (n: number): Record<string, unknown> =>
  ioOpts(n).auth as Record<string, unknown>;

/** Drain the microtask queue plus one macrotask turn. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) { await Promise.resolve(); }
  await new Promise<void>(r => setImmediate(r));
};

type Opts = ConstructorParameters<typeof TransportClient>[0];

function newClient(over: Partial<Opts> = {}) {
  const states: TransportState[] = [];
  const frames: Array<{event: string; data: unknown}> = [];
  const client = new TransportClient({
    url:            'http://localhost:3100',
    signalDeviceId: 3,
    getToken:       async () => 'jwt-token',
    onFrame:        f => { frames.push(f as {event: string; data: unknown}); },
    onStateChange:  s => { states.push(s); },
    ...over,
  });
  return {client, states, frames};
}

beforeEach(() => {
  mockNextId = undefined;
  mockNextPid = undefined;
  mockNextRecovered = undefined;
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
});

afterEach(() => {
  jest.clearAllMocks();
  mockSockets.length = 0;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('TransportClient — handshake options (Audit P0-W4)', () => {
  it('carries the JWT and deviceId in the socket.io auth payload, never in the URL', async () => {
    const {client} = newClient();
    await client.connect();

    const url = ioMock.mock.calls[0][0] as string;
    // A query-string token is logged verbatim by every reverse proxy / CDN
    // edge on the path — the exact thing P0-W4 moved into the auth body.
    expect(url).not.toMatch(/token/i);
    expect(ioAuth(0)).toEqual({token: 'jwt-token', signalDeviceId: 3});
  });

  it('pins the websocket-only, path=/ws, forceNew=false handshake shape', async () => {
    const {client} = newClient();
    await client.connect();

    expect(ioOpts(0)).toMatchObject({
      path:                 '/ws',
      transports:           ['websocket'],
      reconnection:         true,
      reconnectionAttempts: Infinity,
      reconnectionDelay:    500,
      // forceNew=false is what lets socket.io reuse the Manager and keep
      // the recovery context across reconnects.
      forceNew:             false,
      autoConnect:          true,
    });
  });

  it('defaults the reconnect ceiling to 30s and honours an explicit maxBackoffMs', async () => {
    await newClient().client.connect();
    expect(ioOpts(0).reconnectionDelayMax).toBe(30_000);

    mockSockets.length = 0;
    await newClient({maxBackoffMs: 5_000}).client.connect();
    expect(ioOpts(1).reconnectionDelayMax).toBe(5_000);
  });

  it.each([
    ['http://h:3100/ws',  'http://h:3100'],
    ['http://h:3100/ws/', 'http://h:3100'],
    ['http://h:3100',     'http://h:3100'],
    // Only a TRAILING /ws is a legacy raw-ws suffix; a path segment is not.
    ['http://h:3100/wsx', 'http://h:3100/wsx'],
  ])('strips a legacy trailing /ws from %s', async (url, expected) => {
    await newClient({url}).client.connect();
    expect(ioMock.mock.calls[0][0]).toBe(expected);
  });

  it('aborts the handshake and reports unauthorized when getToken returns null', async () => {
    const {client, states} = newClient({getToken: async () => null});
    await client.connect();

    expect(ioMock).not.toHaveBeenCalled();
    expect(client.state).toBe('unauthorized');
    expect(states).toEqual(['connecting', 'unauthorized']);
  });
});

describe('TransportClient — state machine', () => {
  it('starts disconnected and reports connected only after the connect event', async () => {
    const {client, states} = newClient();
    expect(client.state).toBe('disconnected');

    await client.connect();
    expect(client.state).toBe('connecting');

    lastSocket().__fire('connect');
    expect(client.state).toBe('connected');
    expect(states).toEqual(['connecting', 'connected']);
  });

  it('does not re-notify onStateChange for a repeated transition to the same state', async () => {
    const {client, states} = newClient();
    await client.connect();
    lastSocket().__fire('connect');
    lastSocket().__fire('connect');
    lastSocket().__fire('connect');

    expect(states).toEqual(['connecting', 'connected']);
  });

  it('maps reconnect_attempt to reconnecting', async () => {
    const {client} = newClient();
    await client.connect();
    lastSocket().__fire('connect');
    lastSocket().__fire('reconnect_attempt');

    expect(client.state).toBe('reconnecting');
  });

  it.each([
    ['transport close',     'reconnecting'],
    ['ping timeout',        'reconnecting'],
    // B-14: socket.io does NOT auto-reconnect after a server-side
    // disconnect(true), so the client now schedules its OWN backoff ladder
    // (scheduleServerReconnect) — 'reconnecting' is the truth, not a lie.
    // The old 'disconnected' expectation predates that ladder.
    ['io server disconnect', 'reconnecting'],
  ])('disconnect reason "%s" maps to %s', async (reason, expected) => {
    const {client} = newClient();
    await client.connect();
    lastSocket().__fire('connect');
    lastSocket().__fire('disconnect', reason);

    expect(client.state).toBe(expected);
  });

  it('tolerates a client without an onStateChange hook', async () => {
    const client = new TransportClient({
      url: 'http://h', signalDeviceId: 1, getToken: async () => 't', onFrame: () => undefined,
    });
    await client.connect();
    expect(() => lastSocket().__fire('connect')).not.toThrow();
    expect(client.state).toBe('connected');
  });
});

describe('TransportClient — frame fan-out', () => {
  it('rebuilds every server event into a {event, data} frame', async () => {
    const {client, frames} = newClient();
    await client.connect();
    lastSocket().__fireAny('envelope.deliver', {envelopeId: 'e-1'});
    lastSocket().__fireAny('presence', {userId: 'u-1', state: 'active'});

    expect(client.state).not.toBe('unauthorized');
    expect(frames).toEqual([
      {event: 'envelope.deliver', data: {envelopeId: 'e-1'}},
      {event: 'presence',         data: {userId: 'u-1', state: 'active'}},
    ]);
  });

  it('forwards a non-auth `error` frame to the app instead of tearing the socket down', async () => {
    const {client, frames} = newClient();
    await client.connect();
    lastSocket().__fireAny('error', {code: 'rate_limited', message: 'slow down'});

    expect(frames).toEqual([{event: 'error', data: {code: 'rate_limited', message: 'slow down'}}]);
    expect(client.state).not.toBe('unauthorized');
    expect(lastSocket().disconnect).not.toHaveBeenCalled();
  });
});

describe('TransportClient — malformed error payloads do not trip the auth path', () => {
  it.each([
    ['a bare string',        'unauthorized'],
    ['null',                 null],
    ['a numeric code',       {code: 401}],
    ['no code at all',       {message: 'unauthorized'}],
  ])('%s is forwarded as a normal frame', async (_label, payload) => {
    const {client, frames} = newClient();
    await client.connect();
    lastSocket().__fireAny('error', payload);

    expect(frames).toEqual([{event: 'error', data: payload}]);
    expect(client.state).not.toBe('unauthorized');
  });
});

describe('TransportClient.send / emit helpers', () => {
  it('throws when the socket is not open', () => {
    const {client} = newClient();
    expect(() => client.send({event: 'presence', data: {state: 'active'}} as never))
      .toThrow('transport not open');
  });

  it('throws when a socket exists but socket.io reports it disconnected', async () => {
    const {client} = newClient();
    await client.connect();
    lastSocket().connected = false;

    expect(() => client.send({event: 'presence', data: {state: 'active'}} as never))
      .toThrow('transport not open');
  });

  it('emits the event name with its data payload verbatim', async () => {
    const {client} = newClient();
    await client.connect();
    client.send({event: 'presence', data: {state: 'active'}} as never);

    expect(lastSocket().emit).toHaveBeenCalledWith('presence', {state: 'active'});
  });

  it('substitutes {} for a frame with no data (server handlers receive `data` verbatim)', async () => {
    const {client} = newClient();
    await client.connect();
    client.send({event: 'ping'} as never);

    expect(lastSocket().emit).toHaveBeenCalledWith('ping', {});
  });

  it('subscribePresence / unsubscribePresence send the userIds list', async () => {
    const {client} = newClient();
    await client.connect();
    client.subscribePresence(['u-1', 'u-2']);
    client.unsubscribePresence(['u-1']);

    expect(lastSocket().emit).toHaveBeenNthCalledWith(1, 'presence.subscribe', {userIds: ['u-1', 'u-2']});
    expect(lastSocket().emit).toHaveBeenNthCalledWith(2, 'presence.unsubscribe', {userIds: ['u-1']});
  });

  it('never sends an empty presence subscribe/unsubscribe', async () => {
    const {client} = newClient();
    await client.connect();
    client.subscribePresence([]);
    client.unsubscribePresence([]);

    expect(lastSocket().emit).not.toHaveBeenCalled();
  });

  it('setActivity reports the foreground/background hint', async () => {
    const {client} = newClient();
    await client.connect();
    client.setActivity('away');

    expect(lastSocket().emit).toHaveBeenCalledWith('presence', {state: 'away'});
  });

  it('sendReadReceipt addresses the single peer and lists the envelopes', async () => {
    const {client} = newClient();
    await client.connect();
    client.sendReadReceipt({userId: 'u-9', deviceId: 2}, ['e-1', 'e-2']);

    expect(lastSocket().emit).toHaveBeenCalledWith('read-receipt', {
      to: {userId: 'u-9', deviceId: 2}, envelopeIds: ['e-1', 'e-2'],
    });
  });

  it('sendReadReceipt is a no-op for an empty envelope list', async () => {
    const {client} = newClient();
    await client.connect();
    client.sendReadReceipt({userId: 'u-9', deviceId: 2}, []);

    expect(lastSocket().emit).not.toHaveBeenCalled();
  });

  it('sendReadReceipt SWALLOWS the closed-socket throw (best effort, never breaks a read)', () => {
    const {client} = newClient();
    expect(() => client.sendReadReceipt({userId: 'u-9', deviceId: 2}, ['e-1'])).not.toThrow();
  });
});

describe('TransportClient.emitWithAck', () => {
  it('rejects immediately when the transport is closed', async () => {
    const {client} = newClient();
    await expect(client.emitWithAck('sfu.produce', {})).rejects.toThrow('transport not open');
  });

  it('resolves with the ack payload the server hands back', async () => {
    const {client} = newClient();
    await client.connect();
    const p = client.emitWithAck<{producerId: string}>('sfu.produce', {kind: 'audio'});

    const [event, data, ack] = lastSocket().emit.mock.calls[0] as [string, unknown, (r: unknown) => void];
    expect(event).toBe('sfu.produce');
    expect(data).toEqual({kind: 'audio'});
    ack({producerId: 'p-1'});

    await expect(p).resolves.toEqual({producerId: 'p-1'});
  });

  it('rejects with the server message when the ack is an sfu.error frame', async () => {
    const {client} = newClient();
    await client.connect();
    const p = client.emitWithAck('sfu.produce', {});
    const ack = lastSocket().emit.mock.calls[0][2] as (r: unknown) => void;
    ack({event: 'sfu.error', data: {message: 'no_transport'}});

    await expect(p).rejects.toThrow('no_transport');
  });

  it('rejects with a generic sfu_error when the error frame carries no message', async () => {
    const {client} = newClient();
    await client.connect();
    const p = client.emitWithAck('sfu.produce', {});
    const ack = lastSocket().emit.mock.calls[0][2] as (r: unknown) => void;
    ack({event: 'sfu.error'});

    await expect(p).rejects.toThrow('sfu_error');
  });

  it('rejects with ack_timeout:<event> when the server never acks', async () => {
    const {client} = newClient();
    await client.connect();
    jest.useFakeTimers();

    const settled: Promise<Error> = client
      .emitWithAck('sfu.produce', {}, 8_000)
      .then(() => new Error('resolved without an ack'), (e: Error) => e);

    jest.advanceTimersByTime(7_999);
    expect(jest.getTimerCount()).toBe(1); // still armed one tick short
    jest.advanceTimersByTime(1);

    expect((await settled).message).toBe('ack_timeout:sfu.produce');
  });

  it('clears the timeout once the ack lands, so a late tick cannot reject a settled promise', async () => {
    const {client} = newClient();
    await client.connect();
    jest.useFakeTimers();

    const p = client.emitWithAck<{ok: boolean}>('sfu.produce', {}, 1_000);
    const ack = lastSocket().emit.mock.calls[0][2] as (r: unknown) => void;
    ack({ok: true});
    jest.advanceTimersByTime(5_000);

    await expect(p).resolves.toEqual({ok: true});
    // A live timer here would keep the JS thread (and the test env) busy.
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('TransportClient — recovery pid persistence (Fix #17)', () => {
  it('captures socket.pid on connect and persists it for the kill-revive case', async () => {
    mockNextPid = 'srv-pid-1';
    const {client} = newClient();
    await client.connect();
    lastSocket().__fire('connect');

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(PID_KEY, 'srv-pid-1');
    expect(client.state).toBe('connected');
  });

  it('P1-13: with no server pid it CLEARS the persisted pid — socket.id is not a recovery key', async () => {
    // The pre-P1-13 fallback persisted socket.id here, but restoreSession
    // never matches an id, and handing it back as auth.pid overrode the
    // lib's own correct _pid — breaking stock in-process recovery too.
    mockNextId = 'sock-abc';
    const {client} = newClient();
    await client.connect();
    lastSocket().__fire('connect');

    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(PID_KEY, expect.anything());
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(PID_KEY);
  });

  it('keeps the pid we handed back when the server honoured recovery', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('stored-pid');
    mockNextRecovered = true;
    mockNextId = 'fresh-but-irrelevant-id';
    const {client} = newClient();
    await client.connect();

    expect(ioAuth(0).pid).toBe('stored-pid');
    lastSocket().__fire('connect');
    // recovered === true means our pid WAS the session — re-adopting
    // socket.id here would break the next recovery.
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(PID_KEY, 'stored-pid');
  });

  it('rehydrates the pid from disk exactly once, then reuses the in-memory copy', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('disk-pid');
    const {client} = newClient();
    await client.connect();

    // TWO reads on the cold rehydrate — the pid and its companion OFFSET are
    // read together (Promise.all) since offset persistence landed; the old
    // single-read expectation predates the offset key.
    expect(AsyncStorage.getItem).toHaveBeenCalledTimes(2);
    expect(ioAuth(0).pid).toBe('disk-pid');

    lastSocket().__fire('disconnect', 'transport close');
    await client.forceReconnect();

    // Still the same two reads — the second handshake used the cached pid.
    expect(AsyncStorage.getItem).toHaveBeenCalledTimes(2);
    expect(ioAuth(1).pid).toBe('disk-pid');
  });

  it('omits auth.pid entirely when nothing is stored', async () => {
    const {client} = newClient();
    await client.connect();

    expect(Object.prototype.hasOwnProperty.call(ioAuth(0), 'pid')).toBe(false);
  });

  it('treats an AsyncStorage read failure as non-fatal and still connects', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValue(new Error('disk gone'));
    const {client} = newClient();

    await expect(client.connect()).resolves.toBeUndefined();
    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(Object.prototype.hasOwnProperty.call(ioAuth(0), 'pid')).toBe(false);
  });

  it('never lets a failed disk write break the connect path (fire-and-forget)', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValue(new Error('quota exceeded'));
    (AsyncStorage.removeItem as jest.Mock).mockRejectedValue(new Error('quota exceeded'));
    mockNextPid = 'srv-pid-x';
    const {client} = newClient();
    await client.connect();

    expect(() => lastSocket().__fire('connect')).not.toThrow();
    expect(client.state).toBe('connected');

    expect(() => client.close()).not.toThrow();
    // Both rejections must be absorbed by their .catch() — an unhandled
    // rejection here would surface as a red-box in dev.
    await flush();
    expect(client.state).toBe('disconnected');
  });

  it('does not persist anything when neither pid nor id is available', async () => {
    mockNextId = undefined;
    const {client} = newClient();
    await client.connect();
    // socket.id defaults to 'raw-socket-id' in the factory; blank it out to
    // simulate a socket that reports neither.
    (lastSocket() as unknown as {id: string | undefined}).id = undefined;
    lastSocket().__fire('connect');

    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect(client.state).toBe('connected');
  });
});

describe('TransportClient.close', () => {
  it('disconnects, drops the socket, clears the persisted pid and reports disconnected', async () => {
    const {client, states} = newClient();
    await client.connect();
    lastSocket().__fire('connect');
    const sock = lastSocket();

    client.close();

    expect(sock.disconnect).toHaveBeenCalledTimes(1);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(PID_KEY);
    expect(client.state).toBe('disconnected');
    expect(states).toEqual(['connecting', 'connected', 'disconnected']);
    // socket is gone — sends must fail loudly rather than silently no-op.
    expect(() => client.send({event: 'presence', data: {state: 'active'}} as never)).toThrow('transport not open');
  });

  it('survives a socket whose disconnect() throws', async () => {
    const {client} = newClient();
    await client.connect();
    lastSocket().disconnect.mockImplementation(() => { throw new Error('already gone'); });

    expect(() => client.close()).not.toThrow();
    expect(client.state).toBe('disconnected');
  });

  it('is safe to call before any connect', () => {
    const {client} = newClient();
    expect(() => client.close()).not.toThrow();
    expect(client.state).toBe('disconnected');
  });

  it('a user close forgets the pid, so the next handshake does not resume the old session', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('old-pid');
    const {client} = newClient();
    await client.connect();
    expect(ioAuth(0).pid).toBe('old-pid');

    client.close();
    // Mirror the removeItem the client just issued (the mock store is static).
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    await client.connect();

    expect(Object.prototype.hasOwnProperty.call(ioAuth(1), 'pid')).toBe(false);
  });

  it('a transient disconnect does NOT clear the pid (recovery must still work)', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('keep-me');
    const {client} = newClient();
    await client.connect();
    lastSocket().__fire('connect');
    (AsyncStorage.removeItem as jest.Mock).mockClear();

    lastSocket().__fire('disconnect', 'transport close');

    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    expect(client.state).toBe('reconnecting');
  });
});

describe('TransportClient.forceReconnect — Fix #18 throttle', () => {
  it('skips the rebuild when a handshake completed less than 2s ago', async () => {
    const {client} = newClient();
    await client.connect();
    lastSocket().__fire('connect');
    const sock = lastSocket();

    await client.forceReconnect();

    // Two AppState 'active' transitions inside 200ms used to burn two full
    // handshakes; the second must be a no-op.
    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(sock.disconnect).not.toHaveBeenCalled();
    expect(client.state).toBe('connected');
  });

  it('rebuilds once the throttle window has elapsed', async () => {
    const {client} = newClient();
    await client.connect();
    lastSocket().__fire('connect');
    const sock = lastSocket();

    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow + 2_001);
    await client.forceReconnect();

    expect(ioMock).toHaveBeenCalledTimes(2);
    expect(sock.removeAllListeners).toHaveBeenCalled();
    expect(sock.disconnect).toHaveBeenCalled();
  });

  it('is NOT throttled when the state is anything other than connected', async () => {
    const {client} = newClient();
    await client.connect();
    lastSocket().__fire('connect');
    lastSocket().__fire('disconnect', 'transport close'); // -> reconnecting

    await client.forceReconnect();

    expect(ioMock).toHaveBeenCalledTimes(2);
  });

  it('tears the old listeners down before rebuilding, so frames are not dispatched twice', async () => {
    const {client, frames} = newClient();
    await client.connect();
    const first = lastSocket();
    lastSocket().__fire('connect');
    lastSocket().__fire('disconnect', 'transport close');

    await client.forceReconnect();
    // The stale socket's onAny set must be gone (F5 duplicate-decrypt class).
    expect(first.removeAllListeners).toHaveBeenCalled();
    expect(first.__handlerCount('*')).toBe(0);

    lastSocket().__fireAny('envelope.deliver', {envelopeId: 'e-1'});
    expect(frames).toHaveLength(1);
  });

  it('clears a user-close so a foreground forceReconnect can reopen', async () => {
    const {client} = newClient();
    await client.connect();
    client.close();

    await client.forceReconnect();

    expect(ioMock).toHaveBeenCalledTimes(2);
  });
});

describe('TransportClient — open() re-entry does not stack listeners (F5)', () => {
  it('a second connect() strips the previous socket before registering again', async () => {
    const {client, frames} = newClient();
    await client.connect();
    const first = lastSocket();

    await client.connect();

    expect(first.removeAllListeners).toHaveBeenCalledTimes(1);
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(ioMock).toHaveBeenCalledTimes(2);

    // Every frame must be delivered exactly once — a stacked listener set is
    // a duplicate decrypt and a duplicate state transition.
    lastSocket().__fireAny('envelope.deliver', {envelopeId: 'e-1'});
    expect(frames).toEqual([{event: 'envelope.deliver', data: {envelopeId: 'e-1'}}]);
  });
});

describe('TransportClient — mid-session auth failure (Round 2 refresh)', () => {
  const authFrames: Array<[string, unknown]> = [
    ['unauthorized', {code: 'unauthorized', message: 'jwt expired'}],
    // P0-6 mid-stream JTI revocation sweep — used to fall through to onFrame
    // and strand the socket retrying with the revoked JWT.
    ['token_revoked', {code: 'token_revoked', message: 'jti revoked'}],
  ];

  it.each(authFrames)('an `error{%s}` frame refreshes the token and reopens', async (_label, payload) => {
    const refreshToken = jest.fn(async () => undefined);
    const {client, frames} = newClient({refreshToken});
    await client.connect();
    lastSocket().__fire('connect');
    const sock = lastSocket();

    sock.__fireAny('error', payload);

    expect(client.state).toBe('reconnecting');
    expect(sock.disconnect).toHaveBeenCalledTimes(1);
    // The auth frame is consumed, not leaked to the app as a normal frame.
    expect(frames).toHaveLength(0);

    await flush();
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(ioMock).toHaveBeenCalledTimes(2);
  });

  it('reopens with the token getToken returns AFTER the refresh', async () => {
    const tokens = ['stale-jwt', 'fresh-jwt'];
    const getToken = jest.fn(async () => tokens.shift() ?? 'fresh-jwt');
    const {client} = newClient({getToken, refreshToken: async () => undefined});
    await client.connect();
    lastSocket().__fire('connect');
    lastSocket().__fireAny('error', {code: 'unauthorized'});
    await flush();

    expect(ioAuth(0).token).toBe('stale-jwt');
    expect(ioAuth(1).token).toBe('fresh-jwt');
    void client;
  });

  /**
   * WI-5.1 (transport G1) — FIXED, flipped from its DOCUMENTS form. The
   * single-flight guard used to coalesce the refresh CALL but not the frame:
   * the second `error{unauthorized}` during an in-flight refresh fell through
   * to the give-up branch (`closedByUser = true` + 'unauthorized'), and the
   * resolving refresh then bailed at open()'s closedByUser check — a
   * permanent strand in the exact scenario the guard was written for (server
   * emits the error, closes the socket, and the same error arrives again
   * before the refresh completes; mid-call death at the grace timer).
   *
   * `handleAuthReject` now OWNS the in-flight case: benign 'reconnecting',
   * drop the rejected socket, return true — so neither caller runs its
   * terminal fallback, and `false` means exactly one thing (no refresh hook
   * wired; that give-up pin lives below, unchanged).
   */
  it('a second unauthorized frame during an in-flight refresh stays benign and the reopen lands', async () => {
    let release: () => void = () => undefined;
    const refreshToken = jest.fn(() => new Promise<void>(r => { release = r; }));
    const {client} = newClient({refreshToken});
    await client.connect();
    lastSocket().__fire('connect');

    lastSocket().__fireAny('error', {code: 'unauthorized'});
    expect(client.state).toBe('reconnecting');

    lastSocket().__fireAny('error', {code: 'unauthorized'});
    expect(refreshToken).toHaveBeenCalledTimes(1); // the call is coalesced...
    expect(client.state).toBe('reconnecting');     // ...and the frame is benign now.

    release();
    await flush();
    // The reopen LANDS: closedByUser was never set.
    expect(ioMock).toHaveBeenCalledTimes(2);
    expect(client.state).toBe('connecting');
  });

  it('the connect_error path DOES coalesce correctly — its fallback is non-terminal', async () => {
    let release: () => void = () => undefined;
    const refreshToken = jest.fn(() => new Promise<void>(r => { release = r; }));
    const {client} = newClient({refreshToken});
    await client.connect();
    const authErr = () => Object.assign(new Error('x'), {data: {code: 'unauthorized'}});

    lastSocket().__fire('connect_error', authErr());
    lastSocket().__fire('connect_error', authErr());
    lastSocket().__fire('connect_error', authErr());

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(client.state).toBe('reconnecting');

    release();
    await flush();
    expect(ioMock).toHaveBeenCalledTimes(2);
  });

  it('gives up into `unauthorized` when the refresh itself fails, and stops retrying', async () => {
    // P1-BR-7 — only a TERMINAL refresh failure (401/403/no-token/revoked) may
    // strand in 'unauthorized'; a bare network error now stays 'reconnecting'
    // (transportRefreshFailure.test.ts owns that lane). Stamp the status so
    // this test keeps exercising the give-up path it was written for.
    const refreshToken = jest.fn(async () => { throw Object.assign(new Error('refresh 401'), {status: 401}); });
    const {client, states} = newClient({refreshToken});
    await client.connect();
    lastSocket().__fire('connect');
    lastSocket().__fireAny('error', {code: 'unauthorized'});
    await flush();

    expect(client.state).toBe('unauthorized');
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'unauthorized']);
    expect(ioMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the give-up behaviour when no refreshToken hook is wired', async () => {
    const {client, frames} = newClient();
    await client.connect();
    lastSocket().__fire('connect');
    const sock = lastSocket();

    sock.__fireAny('error', {code: 'unauthorized', message: 'nope'});

    expect(client.state).toBe('unauthorized');
    // closedByUser is set so socket.io stops retrying with the dead token.
    expect(sock.disconnect).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
    sock.__fire('disconnect', 'io client disconnect');
    expect(client.state).toBe('disconnected');
  });

  it('a close() during an in-flight refresh must NOT resurrect the socket', async () => {
    let release: () => void = () => undefined;
    const refreshToken = jest.fn(() => new Promise<void>(r => { release = r; }));
    const {client} = newClient({refreshToken});
    await client.connect();
    lastSocket().__fire('connect');
    lastSocket().__fireAny('error', {code: 'unauthorized'});

    client.close();
    release();
    await flush();

    // open() sees closedByUser and bails — one handshake total.
    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(client.state).toBe('disconnected');
  });
});

describe('TransportClient — handshake rejection (connect_error)', () => {
  it.each([
    ['err.data.code unauthorized',  Object.assign(new Error('x'), {data: {code: 'unauthorized'}})],
    ['err.data.code token_revoked', Object.assign(new Error('x'), {data: {code: 'token_revoked'}})],
    ['a jwt message',               new Error('jwt malformed')],
    ['an expired message',          new Error('Token expired')],
    ['invalid_token in data',       Object.assign(new Error('x'), {data: {message: 'invalid_token'}})],
    ['missing_token',               new Error('missing_token')],
  ])('%s drives the single-flight refresh + reopen', async (_label, err) => {
    const refreshToken = jest.fn(async () => undefined);
    const {client} = newClient({refreshToken});
    await client.connect();
    const sock = lastSocket();

    sock.__fire('connect_error', err);

    expect(client.state).toBe('reconnecting');
    expect(sock.disconnect).toHaveBeenCalledTimes(1);
    await flush();
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(ioMock).toHaveBeenCalledTimes(2);
  });

  it('a plain network handshake failure only flips the badge — no refresh, no teardown', async () => {
    const refreshToken = jest.fn(async () => undefined);
    const {client} = newClient({refreshToken});
    await client.connect();
    const sock = lastSocket();

    sock.__fire('connect_error', new Error('xhr poll error'));

    expect(client.state).toBe('reconnecting');
    expect(refreshToken).not.toHaveBeenCalled();
    expect(sock.disconnect).not.toHaveBeenCalled();
    expect(ioMock).toHaveBeenCalledTimes(1);
  });

  it('an auth rejection with no refreshToken hook just reports reconnecting', async () => {
    const {client} = newClient();
    await client.connect();
    lastSocket().__fire('connect_error', Object.assign(new Error('x'), {data: {code: 'unauthorized'}}));

    expect(client.state).toBe('reconnecting');
    expect(ioMock).toHaveBeenCalledTimes(1);
  });

  it('ignores connect_error entirely after the user closed the transport', async () => {
    const refreshToken = jest.fn(async () => undefined);
    const {client} = newClient({refreshToken});
    await client.connect();
    const sock = lastSocket();
    client.close();

    sock.__fire('connect_error', Object.assign(new Error('x'), {data: {code: 'unauthorized'}}));

    expect(client.state).toBe('disconnected');
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it('a failed refresh from the handshake path lands in unauthorized and blocks further attempts', async () => {
    // P1-BR-7 — same rule as the mid-session twin above: the give-up lane
    // needs a TERMINAL refresh error; a transient one stays 'reconnecting'.
    const refreshToken = jest.fn(async () => { throw Object.assign(new Error('refresh down'), {status: 403}); });
    const {client} = newClient({refreshToken});
    await client.connect();
    const sock = lastSocket();

    sock.__fire('connect_error', Object.assign(new Error('x'), {data: {code: 'unauthorized'}}));
    await flush();
    expect(client.state).toBe('unauthorized');

    // closedByUser is now set — a retry storm must not restart the refresh.
    sock.__fire('connect_error', Object.assign(new Error('x'), {data: {code: 'unauthorized'}}));
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(client.state).toBe('unauthorized');
  });

  it('handles a connect_error carrying neither data nor message', async () => {
    const refreshToken = jest.fn(async () => undefined);
    const {client} = newClient({refreshToken});
    await client.connect();
    lastSocket().__fire('connect_error', {} as Error);

    expect(client.state).toBe('reconnecting');
    expect(refreshToken).not.toHaveBeenCalled();
  });
});
