/**
 * Warm-start FIX-03 — the transport parks its retry ladder while the radio is
 * down, and restarts it the moment connectivity returns.
 *
 * Before this, the NetInfo listener in productionRuntime had ONLY a positive
 * branch: nothing anywhere told the client "there is no network". A user in
 * airplane mode kept burning a handshake every 30s (socket.io's ceiling) plus
 * the B-14 timer, for as long as they stayed offline — spec §5 asks for the
 * opposite ("stop/reduce retries when the app is genuinely offline").
 *
 * The two rules that matter, and why:
 *   - parking must NEVER close a socket. NetInfo lies (captive-portal probes,
 *     band changes), and acting on it destructively is how a healthy in-call
 *     socket gets torn down. The host's live-call veto is the other half of
 *     that rule and lives where hasLiveCall() does.
 *   - un-parking must reset the attempt counter: a ladder that never ran says
 *     nothing about the quality of the new route.
 *
 * Mock shape follows transportClientSocketIo.test.ts — only the socket.io
 * factory and AsyncStorage are faked; the class under test is real.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    jest.fn(async () => null),
    setItem:    jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

interface MockSocket {
  on: (e: string, cb: (...a: unknown[]) => void) => void;
  onAny: (cb: (e: string, ...a: unknown[]) => void) => void;
  emit: jest.Mock;
  disconnect: jest.Mock;
  removeAllListeners: jest.Mock;
  connected: boolean;
  id?: string;
  io: {reconnection: jest.Mock; on: jest.Mock; off: jest.Mock};
  __fire: (e: string, ...a: unknown[]) => void;
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
      emit: jest.fn(),
      disconnect: jest.fn(),
      removeAllListeners: jest.fn(() => {
        for (const k of Object.keys(handlers)) { delete handlers[k]; }
        anyHandlers.length = 0;
      }),
      connected: true,
      id: 'raw-socket-id',
      io: {reconnection: jest.fn(), on: jest.fn(), off: jest.fn()},
      __fire(e: string, ...a: unknown[]) { for (const cb of [...(handlers[e] ?? [])]) { cb(...a); } },
    };
    mockSockets.push(sock as unknown as MockSocket);
    return sock;
  }),
}));

import {TransportClient} from '../src/transport/client';

const lastSocket = (): MockSocket => mockSockets[mockSockets.length - 1];

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) { await Promise.resolve(); }
  await new Promise<void>(r => setImmediate(r));
};

type Opts = ConstructorParameters<typeof TransportClient>[0];

function newClient(over: Partial<Opts> = {}): TransportClient {
  return new TransportClient({
    url: 'http://localhost:3100',
    signalDeviceId: 3,
    getToken: async () => 'jwt-token',
    ...over,
  } as Opts);
}

beforeEach(() => { mockSockets.length = 0; jest.clearAllMocks(); });

describe('FIX-03 — offline park', () => {
  it('reports parked state and surfaces `disconnected`, not a misleading `reconnecting`', () => {
    const c = newClient();
    expect(c.isNetworkParked()).toBe(false);

    c.setNetworkDown();

    expect(c.isNetworkParked()).toBe(true);
    // "reconnecting" with nothing in flight would render as "almost back".
    expect(c.state).toBe('disconnected');
  });

  it('parking a CONNECTED socket keeps its state truthful (audit round 2)', async () => {
    const c = newClient();
    const opening = c.connect(); opening.catch(() => undefined);
    await flush();
    lastSocket().__fire('connect');
    await flush();
    expect(c.state).toBe('connected');

    c.setNetworkDown();

    // Park stops the retry ladder — it does not decide what the socket is.
    // Flipping to 'disconnected' here made the correcting NetInfo event
    // force-rebuild a healthy socket (pongFresh reads state === 'connected'),
    // dropping in-flight acks on every false-alarm flap pair.
    expect(c.isNetworkParked()).toBe(true);
    expect(c.state).toBe('connected');
  });

  it('never closes the socket when parking', async () => {
    const c = newClient();
    const opening = c.connect(); opening.catch(() => undefined);
    await flush();
    lastSocket().__fire('connect');
    await flush();

    c.setNetworkDown();

    // NetInfo is wrong often enough that acting on it destructively is how a
    // healthy in-call socket dies.
    expect(lastSocket().disconnect).not.toHaveBeenCalled();
  });

  it('turns socket.io auto-reconnect off while parked and back on when the network returns', async () => {
    const c = newClient();
    const opening = c.connect(); opening.catch(() => undefined);
    await flush();
    lastSocket().__fire('connect');
    await flush();

    // Hold the parked socket: notifyNetworkChange goes on to force a fresh
    // handshake, so `lastSocket()` afterwards is a DIFFERENT socket (built
    // with reconnection:true in its own io options).
    const parked = lastSocket();

    c.setNetworkDown();
    expect(parked.io.reconnection).toHaveBeenCalledWith(false);

    const changing = c.notifyNetworkChange(); changing.catch(() => undefined);
    await flush();
    expect(parked.io.reconnection).toHaveBeenCalledWith(true);
  });

  it('un-parks on notifyNetworkChange', async () => {
    const c = newClient();
    c.setNetworkDown();
    expect(c.isNetworkParked()).toBe(true);

    const changing = c.notifyNetworkChange(); changing.catch(() => undefined);
    await flush();

    expect(c.isNetworkParked()).toBe(false);
  });

  it('parking twice is a no-op — a chatty NetInfo must not churn timers', () => {
    const c = newClient();
    c.setNetworkDown();
    const first = c.state;
    c.setNetworkDown();
    expect(c.state).toBe(first);
    expect(c.isNetworkParked()).toBe(true);
  });

  it('an explicit reconnect still opens a socket while parked', async () => {
    const c = newClient();
    c.setNetworkDown();

    // Parking stops the AUTOMATIC ladder only — an explicit attempt (app
    // foreground, user retry) must still be allowed through.
    const reopening = c.forceReconnect(); reopening.catch(() => undefined);
    await flush();

    expect(mockSockets.length).toBeGreaterThan(0);
  });

  it('does not park a socket the user deliberately closed', () => {
    const c = newClient();
    c.close();
    c.setNetworkDown();
    // closedByUser owns that lifecycle; parking must not muddy it.
    expect(c.isNetworkParked()).toBe(false);
  });

  it('a server-initiated disconnect while parked does NOT schedule a retry', async () => {
    const c = newClient();
    const opening = c.connect(); opening.catch(() => undefined);
    await flush();
    lastSocket().__fire('connect');
    await flush();

    c.setNetworkDown();
    const socketsBefore = mockSockets.length;
    lastSocket().__fire('disconnect', 'io server disconnect');
    await flush();

    // This is the whole point: the B-14 ladder used to fire here and keep
    // firing at the 30s ceiling for as long as the user stayed offline.
    expect(c.state).toBe('disconnected');
    expect(mockSockets.length).toBe(socketsBefore);
  });
});

/**
 * The HOST half of FIX-03 lives in productionRuntime.ts, which no test can
 * import (MESSAGE_LOOP §5). A source scan is the gate instead — and per
 * CLAUDE.md it strips comments first (prose containing the banned token is the
 * usual false result here) and never anchors on \n (these files are CRLF).
 */
describe('FIX-03 — the host wires the park (source scan)', () => {
  const nodeFs = require('fs') as {readFileSync: (p: string, e: string) => string};
  const nodePath = require('path') as {resolve: (...p: string[]) => string};
  const RUNTIME = nodePath.resolve(
    __dirname, '..', '..', '..', 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts',
  );

  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join('\n');

  const src = (): string => stripComments(nodeFs.readFileSync(RUNTIME, 'utf8'));

  it('the NetInfo listener has a negative branch that parks the transport', () => {
    // Before FIX-03 this listener was positive-only: nothing anywhere told the
    // client the radio was gone.
    expect(src()).toMatch(/setNetworkDown\(\)/);
  });

  it('parks only on an EXPLICIT isConnected === false', () => {
    // `isInternetReachable === null` means UNKNOWN and must read as online —
    // a falsy check would park the app on every unknown.
    expect(src()).toMatch(/state\.isConnected === false/);
  });

  it('a live call vetoes parking', () => {
    const s = src();
    const branch = s.indexOf('state.isConnected === false');
    expect(branch).toBeGreaterThan(-1);
    const window = s.slice(branch, branch + 400);
    // Trusting one NetInfo blip over an in-flight call is worse than the
    // battery drain parking saves.
    expect(window).toMatch(/hasLiveCall\(\)/);
    expect(window.indexOf('hasLiveCall()')).toBeLessThan(window.indexOf('setNetworkDown()'));
  });

  it('the AppState resume consults the last network verdict', () => {
    const s = src();
    // decideResumeAction reads only pong + live-call, so a foreground with the
    // radio still down used to go straight to a doomed forceReconnect().
    expect(s).toMatch(/parkForNetwork/);
    expect(s).toMatch(/resumeAction === 'park'/);
  });
});
