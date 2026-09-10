/**
 * NA-03 — cold-start notification routing was serialized behind unbounded
 * push-register network I/O.
 *
 * installNotifeeHandlers owns the ONLY cold-launch route to CallScreen
 * (getInitialNotification), and it used to be installed AFTER an un-timeout-ed
 * `getToken()` + two bare `fetch`es to /push/register*. On a black-holed link
 * (OkHttp has no read timeout in RN) that Answer tap routed nowhere at all.
 *
 * Locks: the handler hoist, the non-blocking register, the abort deadline, the
 * in-flight guard, and the F4 rider (the rich bg handler now displaces the slim
 * bundle-entry one earlier, so it owes the same durable decline).
 */

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    async (k: string) => mockStore.get(k) ?? null,
    setItem:    async (k: string, v: string) => { mockStore.set(k, v); },
    removeItem: async (k: string) => { mockStore.delete(k); },
  },
}));
jest.mock('react-native', () => ({
  Platform: {OS: 'android', Version: 33},
  PermissionsAndroid: {check: jest.fn(async () => true), request: jest.fn(async () => 'granted')},
  NativeModules: {},
}));
jest.mock('@utils/constants', () => ({MSG_BASE_URL: 'https://msg.test'}));
jest.mock('@services/api', () => ({refreshAccessTokenShared: jest.fn(async () => {})}), {virtual: true});

let mockGetToken: () => Promise<string | null> = () => new Promise(() => { /* never settles */ });
jest.mock('@react-native-firebase/messaging', () => {
  const api = {
    getToken:                    jest.fn(() => mockGetToken()),
    onTokenRefresh:              jest.fn(() => () => {}),
    onMessage:                   jest.fn(() => () => {}),
    setBackgroundMessageHandler: jest.fn(),
  };
  const messaging = () => api;
  return {__esModule: true, default: messaging};
});

let mockInitialNotification: unknown = null;
jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    onBackgroundEvent:      jest.fn(),
    onForegroundEvent:      jest.fn(),
    getInitialNotification: jest.fn(async () => mockInitialNotification),
    displayNotification:    jest.fn(async () => {}),
    cancelNotification:     jest.fn(async () => {}),
    createChannel:          jest.fn(async () => 'ch'),
    deleteChannel:          jest.fn(async () => {}),
  },
  AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2},
  AndroidCategory:   {MESSAGE: 'msg', CALL: 'call'},
  AndroidVisibility: {PRIVATE: 0, PUBLIC: 1},
  AndroidStyle:      {BIGTEXT: 1, MESSAGING: 2},
  EventType:         {PRESS: 1, ACTION_PRESS: 2},
}));

const mockNav = jest.fn();
jest.mock('@navigation/navigationRef', () => ({
  navigationRef: {isReady: () => true, navigate: (n: string, p?: unknown) => mockNav(n, p)},
}));
jest.mock('../push/callKitBridge', () => ({
  setupCallKit:             jest.fn(async () => {}),
  subscribeToCallKitEvents: jest.fn(() => () => {}),
  bringAppToForeground:     jest.fn(),
  reportEnded:              jest.fn(),
}));
jest.mock('../push/voipPush', () => ({startVoipPushBootstrap: jest.fn(async () => {})}));
jest.mock('../push/backgroundMessageNotifier', () => ({
  startBackgroundMessageNotifier: jest.fn(),
  stopBackgroundMessageNotifier:  jest.fn(),
}));
jest.mock('@/modules/messenger/runtime/transportRegistry', () => ({getLiveTransport: () => null}));

const ACTION_PRESS = 2;

type Boot = typeof import('../push/fcmBootstrap');
function loadBootstrap(): Boot {
  return require('../push/fcmBootstrap') as Boot;
}
/** jest.resetModules() re-runs the notifee factory, so read the LIVE instance. */
function nf(): Record<string, jest.Mock> {
  return (require('@notifee/react-native') as {default: Record<string, jest.Mock>}).default;
}

beforeEach(() => {
  // fcmBootstrap latches `started` / `serverRegistered` / `notifeeHandlersInstalled`
  // at module scope — every case needs a virgin process.
  jest.resetModules();
  // The register path arms a 10 s deadline; keep it off the real event loop.
  jest.useFakeTimers();
  mockStore.clear();
  mockNav.mockClear();
  mockInitialNotification = null;
  mockGetToken = () => new Promise(() => { /* never settles */ });
  (global as {fetch?: unknown}).fetch = undefined;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('NA-03 — bootstrap ordering', () => {
  it('installs the notifee handlers before any push-register I/O settles', async () => {
    const boot = loadBootstrap();
    await boot.startFcmBootstrap();

    expect(nf().onBackgroundEvent).toHaveBeenCalled();
    expect(nf().onForegroundEvent).toHaveBeenCalled();
    expect(nf().getInitialNotification).toHaveBeenCalled();
  });

  it('resolves without waiting for the push register', async () => {
    const boot = loadBootstrap();
    await expect(boot.startFcmBootstrap()).resolves.toBeUndefined();
  });

  it('routes a cold-launch Answer press to CallScreen', async () => {
    mockInitialNotification = {
      notification: {data: {kind: 'voice', callId: 'c-1', fromUserId: 'u-2'}},
      pressAction:  {id: 'accept-c-1'},
    };
    const boot = loadBootstrap();
    await boot.startFcmBootstrap();
    // getInitialNotification routing is a floating promise inside the installer.
    for (let i = 0; i < 20; i++) { await Promise.resolve(); }

    expect(mockNav).toHaveBeenCalledWith('Main', expect.objectContaining({screen: 'MessengerTab'}));
    expect(mockNav.mock.calls[0][1]).toMatchObject({
      params: {screen: 'CallScreen', params: {callId: 'c-1', autoAccept: true, isIncoming: true}},
    });
  });
});

describe('NA-03 — bounded, single-flight push register', () => {
  it('aborts /push/register* on the 10 s deadline', async () => {
    mockStore.set('auth:access_token', 'tok');
    mockGetToken = async () => 'tok-1';
    const urls: string[] = [];
    const signals: AbortSignal[] = [];
    (global as {fetch?: unknown}).fetch = jest.fn((u: string, init: RequestInit) => {
      urls.push(u);
      if (init.signal) {signals.push(init.signal as AbortSignal);}
      return new Promise(() => { /* black hole */ });
    });

    const boot = loadBootstrap();
    void boot.startFcmBootstrap();
    // Drain the microtask chain (getToken → token read → fetch) before the clock moves.
    for (let i = 0; i < 40; i++) { await Promise.resolve(); }
    jest.advanceTimersByTime(10_001);
    for (let i = 0; i < 10; i++) { await Promise.resolve(); }

    expect(urls).toEqual(expect.arrayContaining([
      'https://msg.test/push/register',
      'https://msg.test/push/register-voip',
    ]));
    expect(signals).toHaveLength(2);
    expect(signals.every(s => s.aborted)).toBe(true);
  });

  it('joins a concurrent register instead of firing a second pair of POSTs', async () => {
    mockStore.set('auth:access_token', 'tok');
    mockGetToken = async () => 'tok-1';
    const fetchMock = jest.fn(() => new Promise(() => { /* hangs */ }));
    (global as {fetch?: unknown}).fetch = fetchMock;

    const boot = loadBootstrap();
    await boot.startFcmBootstrap();
    for (let i = 0; i < 40; i++) { await Promise.resolve(); }
    void boot.ensurePushRegistered();
    for (let i = 0; i < 40; i++) { await Promise.resolve(); }

    expect(fetchMock).toHaveBeenCalledTimes(2); // one per endpoint, not four
  });
});

describe('NA-03 F4 — the rich bg handler owes a durable decline', () => {
  it('queues a pending decline when it fires before the WS is up', async () => {
    const boot = loadBootstrap();
    await boot.startFcmBootstrap();
    // The FCM bg wake seeds the cache before drawing the ring; the decline
    // branch reads the peer back out of it.
    const cache = require('../push/incomingCallCache') as typeof import('../push/incomingCallCache');
    cache.setIncomingCallPayload({callId: 'c-2', callerName: 'Alice', kind: 'voice', fromUserId: 'u-9'});

    const handler = nf().onBackgroundEvent.mock.calls.at(-1)![0] as (ev: unknown) => Promise<void>;
    await handler({
      type: ACTION_PRESS,
      detail: {
        notification: {data: {kind: 'voice', callId: 'c-2', fromUserId: 'u-9'}},
        pressAction:  {id: 'decline-c-2'},
      },
    });

    const {loadPendingActions} = require('../push/pendingActions') as typeof import('../push/pendingActions');
    expect(await loadPendingActions()).toContainEqual(
      expect.objectContaining({t: 'decline', callId: 'c-2', kind: 'direct', peerUserId: 'u-9'}),
    );
  });
});
