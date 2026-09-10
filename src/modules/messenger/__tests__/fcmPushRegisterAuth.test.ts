/**
 * Server-side push registration — the `registerToken` / `ensurePushRegistered` /
 * `stopFcmBootstrap` half of push/fcmBootstrap.ts.
 *
 * This is the code path whose failure makes a user INVISIBLE to push: the
 * sender sees "delivered" over the WS while the recipient's device never rings
 * or banners, because /push/register* never landed a row. Its own comments name
 * the bugs it exists to prevent:
 *
 *   • "previously this returned null on missing access token AND threw on 401
 *     without retry, leaving the recipient with ZERO server-registered push
 *     tokens" → a refresh-once-then-retry ladder on both entry points.
 *   • B-48 — the server can delete this device's token rows while the app runs
 *     (dead-token GC, logout tombstone from another device), and
 *     `serverRegistered=true` would mask it forever; ensurePushRegistered
 *     re-asserts on every WS `connected`, throttled so socket flaps can't spam.
 *   • Token rotation (reinstall / data clear / anti-abuse) must re-register, or
 *     the server's cache goes stale and the next VoIP wake fires into the void.
 *   • stopFcmBootstrap must drop the CallKit subscription; a logout→login that
 *     left the old listeners attached made ONE system-UI Accept fire twice
 *     (double call.answer → the have-local-offer wedge).
 *
 * fcmBootstrapOrder.test.ts covers the abort deadline and the single-flight
 * guard; the auth ladder, the throttle, the rotation lane and the teardown are
 * exercised here.
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
  AppState: {currentState: 'active', addEventListener: jest.fn(() => ({remove: jest.fn()}))},
}));
jest.mock('@utils/constants', () => ({MSG_BASE_URL: 'https://msg.test'}));

const mockRefresh = jest.fn(async () => {});
jest.mock('@services/api', () => ({refreshAccessTokenShared: mockRefresh}), {virtual: true});

const mockUnsubTokenRefresh = jest.fn();
const mockUnsubOnMessage    = jest.fn();
jest.mock('@react-native-firebase/messaging', () => {
  const api = {
    getToken:                    jest.fn(async () => 'fcm-token-1'),
    onTokenRefresh:              jest.fn(() => mockUnsubTokenRefresh),
    onMessage:                   jest.fn(() => mockUnsubOnMessage),
    setBackgroundMessageHandler: jest.fn(),
    requestPermission:           jest.fn(async () => 1),
  };
  const messaging = () => api;
  return {__esModule: true, default: messaging};
});
jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    displayNotification:    jest.fn(async () => 'nid'),
    cancelNotification:     jest.fn(async () => {}),
    createChannel:          jest.fn(async () => 'ch'),
    onForegroundEvent:      jest.fn(),
    onBackgroundEvent:      jest.fn(),
    getInitialNotification: jest.fn(async () => null),
  },
  AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2},
  AndroidCategory:   {MESSAGE: 'msg', CALL: 'call'},
  AndroidVisibility: {PRIVATE: 0, PUBLIC: 1},
  AndroidStyle:      {BIGTEXT: 1, MESSAGING: 2},
  EventType:         {PRESS: 1, ACTION_PRESS: 2},
}));
jest.mock('@navigation/navigationRef', () => ({
  navigationRef: {isReady: () => true, navigate: jest.fn()},
}));
jest.mock('@/store/authStore', () => ({
  useAuthStore: {getState: () => ({user: {id: 'self-1'}})},
}));

const mockCallKitUnsub = jest.fn();
jest.mock('../push/callKitBridge', () => ({
  setupCallKit:             jest.fn(async () => {}),
  teardownCallKit:          jest.fn(),
  subscribeToCallKitEvents: jest.fn(() => mockCallKitUnsub),
  bringAppToForeground:     jest.fn(),
  reportEnded:              jest.fn(),
  reportIncomingCall:       jest.fn(),
}));
jest.mock('../push/voipPush', () => ({startVoipPushBootstrap: jest.fn(async () => {})}));
jest.mock('../push/voipWakeVerify', () => ({
  verifyVoipWake:   jest.fn(async () => ({ok: true, reason: 'verified'})),
  storeVoipWakeKey: jest.fn(async () => {}),
}));
jest.mock('../push/callNotification', () => ({
  showMessageNotif:          jest.fn(async () => {}),
  dismissMessageNotif:       jest.fn(async () => {}),
  showIncomingCallNotif:     jest.fn(async () => {}),
  dismissCallNotif:          jest.fn(async () => {}),
  showMissedCallNotif:       jest.fn(async () => {}),
  ensureIncomingCallChannel: jest.fn(async () => 'ch'),
  parseCallAction:           jest.fn(() => null),
  EventType:                 {PRESS: 1, ACTION_PRESS: 2},
  notifee: {
    onForegroundEvent:      jest.fn(),
    onBackgroundEvent:      jest.fn(),
    getInitialNotification: jest.fn(async () => null),
  },
}));
jest.mock('../push/backgroundMessageNotifier', () => ({
  startBackgroundMessageNotifier:     jest.fn(),
  stopBackgroundMessageNotifier:      jest.fn(),
  isBackgroundMessageNotifierRunning: jest.fn(() => false),
  getMessagePostedGeneration:         jest.fn(() => 0),
  snapshotCues:                       jest.fn(() => ({gen: 0, failures: 0})),
  cueDeliveredSince:                  jest.fn(async () => false),
}));
jest.mock('@/modules/messenger/runtime', () => ({
  getMessengerRuntime: jest.fn(async () => ({pullEnvelopes: jest.fn(async () => {})})),
}));
jest.mock('@/modules/messenger/runtime/transportRegistry', () => ({getLiveTransport: () => null}));
jest.mock('@/modules/messenger/store/messengerStore', () => ({
  useMessengerStore: {getState: () => ({conversations: {}, directoryNames: {}, messages: {}})},
}));

type Boot = typeof import('../push/fcmBootstrap');
function loadBootstrap(): Boot {
  return require('../push/fcmBootstrap') as Boot;
}
/** jest.resetModules() re-runs the mock factories — always read the LIVE one. */
function live<T = Record<string, jest.Mock>>(spec: string): T {
  return require(spec) as T;
}

type Res = {ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown>};
const ok = (body: unknown = {ok: true}): Res => ({
  ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body,
});
const status = (code: number, body = ''): Res => ({
  ok: false, status: code, text: async () => body, json: async () => ({}),
});

let fetchMock: jest.Mock;
/** POSTs recorded as [endpoint, authorization header, parsed body]. */
function posts(): Array<{url: string; auth: string; body: Record<string, unknown>}> {
  return fetchMock.mock.calls.map(([url, init]: [string, RequestInit]) => ({
    url,
    auth: (init.headers as Record<string, string>).Authorization,
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
  }));
}

/** Let the fire-and-forget `void registerPushTokens()` chain settle. */
async function flush(times = 60): Promise<void> {
  for (let i = 0; i < times; i++) { await Promise.resolve(); }
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockStore.clear();
  mockRefresh.mockImplementation(async () => {});
  fetchMock = jest.fn(async () => ok());
  (global as {fetch?: unknown}).fetch = fetchMock;
});

describe('the auth ladder on /push/register*', () => {
  it('registers BOTH endpoints with the platform + bearer the gateway requires', async () => {
    mockStore.set('auth:access_token', 'jwt-1');
    const boot = loadBootstrap();
    await boot.startFcmBootstrap();
    await flush();

    const sent = posts();
    expect(sent.map(p => p.url).sort()).toEqual([
      'https://msg.test/push/register',
      'https://msg.test/push/register-voip',
    ]);
    for (const p of sent) {
      expect(p.auth).toBe('Bearer jwt-1');
      // Chat wakes and call wakes live in different Redis keyspaces but share
      // this token — both rows are required for the user to be reachable.
      expect(p.body).toEqual({platform: 'android', token: 'fcm-token-1'});
    }
    expect(boot.getPushRegisterHealth().registered).toBe(true);
  });

  it('with no JWT yet, refreshes once and posts nothing rather than throwing', async () => {
    const boot = loadBootstrap();
    await boot.startFcmBootstrap();
    await flush();

    expect(mockRefresh).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // DOCUMENTS (unfiled) — pins CURRENT behaviour, which looks wrong.
  //
  // `registerToken` returns null (no throw) when there is still no JWT, and
  // doRegisterPushTokens scores every non-throwing endpoint as success:
  //
  //     registerDataToken(token).then(() => true).catch(() => false)
  //
  // so a bootstrap that ran BEFORE login flips `serverRegistered` — and with it
  // the B-412 health probe — to `registered: true` while the device has ZERO
  // rows on the server. That gate then makes every later startFcmBootstrap take
  // the "already started + server-registered" short-circuit, leaving the WS
  // `connected` re-assert (throttled to 60 s) as the only thing that can heal
  // it. That is the same "recipient invisible to push.chat.sendChatWake" shape
  // the function's own comment says the flag exists to prevent.
  //
  // WHEN FIXED (a no-POST attempt must score as NOT registered), this assertion
  // becomes `.toBe(false)` and the test name loses its DOCUMENTS prefix.
  it('DOCUMENTS — a no-JWT register still reports the health gate as registered', async () => {
    const boot = loadBootstrap();
    await boot.startFcmBootstrap();
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(boot.getPushRegisterHealth().registered).toBe(true);
  });

  it('a refresh that DOES produce a token proceeds to post (no wasted boot)', async () => {
    mockRefresh.mockImplementation(async () => { mockStore.set('auth:access_token', 'jwt-refreshed'); });
    const boot = loadBootstrap();
    await boot.startFcmBootstrap();
    await flush();

    expect(posts()).toHaveLength(2);
    expect(posts().every(p => p.auth === 'Bearer jwt-refreshed')).toBe(true);
  });

  it('a 401 refreshes and retries the SAME endpoint exactly once, with the new token', async () => {
    mockStore.set('auth:access_token', 'jwt-stale');
    mockRefresh.mockImplementation(async () => { mockStore.set('auth:access_token', 'jwt-fresh'); });
    const seen = new Map<string, number>();
    fetchMock.mockImplementation(async (url: string) => {
      const n = (seen.get(url) ?? 0) + 1;
      seen.set(url, n);
      return n === 1 ? status(401, 'expired') : ok();
    });

    const boot = loadBootstrap();
    await boot.startFcmBootstrap();
    await flush();

    const register = posts().filter(p => p.url.endsWith('/push/register'));
    expect(register).toHaveLength(2);
    expect(register[0].auth).toBe('Bearer jwt-stale');
    expect(register[1].auth).toBe('Bearer jwt-fresh');
    // Both endpoints healed → the gate flips.
    expect(boot.getPushRegisterHealth().registered).toBe(true);
  });

  it('a persistent 401 gives up after ONE retry and leaves the gate closed for the next attempt', async () => {
    mockStore.set('auth:access_token', 'jwt-dead');
    fetchMock.mockImplementation(async () => status(401, 'nope'));

    const boot = loadBootstrap();
    await boot.startFcmBootstrap();
    await flush();

    // 2 endpoints x (initial + one retry) — never an unbounded refresh loop.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // B-48 — a false `registered` here would mask the failure forever, since the
    // only other re-register triggers are app start and token rotation.
    expect(boot.getPushRegisterHealth().registered).toBe(false);
  });

  it('a 500 fails that endpoint without retrying (only 401 is an auth problem)', async () => {
    mockStore.set('auth:access_token', 'jwt-1');
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/push/register-voip') ? status(500, 'boom') : ok());

    const boot = loadBootstrap();
    await boot.startFcmBootstrap();
    await flush();

    expect(posts().filter(p => p.url.endsWith('/push/register-voip'))).toHaveLength(1);
    // PARTIAL success must not flip the gate — call-wake would stay broken.
    expect(boot.getPushRegisterHealth().registered).toBe(false);
  });
});

describe('B-48 — ensurePushRegistered re-asserts on WS connect, throttled', () => {
  it('does nothing before the bootstrap has run', async () => {
    const boot = loadBootstrap();
    mockStore.set('auth:access_token', 'jwt-1');

    await boot.ensurePushRegistered();
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(boot.getPushRegisterHealth().lastAssertAgoMs).toBeNull();
  });

  it('re-asserts both rows once, then throttles a rapid second connect', async () => {
    mockStore.set('auth:access_token', 'jwt-1');
    const boot = loadBootstrap();
    await boot.startFcmBootstrap();
    await flush();
    fetchMock.mockClear();

    await boot.ensurePushRegistered();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The health probe can now say how long ago we last re-asserted.
    expect(boot.getPushRegisterHealth().lastAssertAgoMs).toBeGreaterThanOrEqual(0);

    // A socket flap seconds later must NOT spam the server.
    fetchMock.mockClear();
    await boot.ensurePushRegistered();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('token rotation', () => {
  it('re-registers both endpoints with the rotated token', async () => {
    mockStore.set('auth:access_token', 'jwt-1');
    const boot = loadBootstrap();
    await boot.startFcmBootstrap();
    await flush();
    fetchMock.mockClear();

    const msg = (live<{default: () => Record<string, jest.Mock>}>('@react-native-firebase/messaging')).default();
    const onRotate = msg.onTokenRefresh.mock.calls.at(-1)![0] as (t: string) => void;
    onRotate('fcm-token-2');
    await flush();

    const sent = posts();
    expect(sent).toHaveLength(2);
    expect(sent.every(p => p.body.token === 'fcm-token-2')).toBe(true);
    expect(sent.map(p => p.url).sort()).toEqual([
      'https://msg.test/push/register',
      'https://msg.test/push/register-voip',
    ]);
  });

  it('a rotation that fails to register closes the gate again (the stored token is stale)', async () => {
    mockStore.set('auth:access_token', 'jwt-1');
    const boot = loadBootstrap();
    await boot.startFcmBootstrap();
    await flush();
    expect(boot.getPushRegisterHealth().registered).toBe(true);

    fetchMock.mockImplementation(async () => status(500, 'boom'));
    const msg = (live<{default: () => Record<string, jest.Mock>}>('@react-native-firebase/messaging')).default();
    const onRotate = msg.onTokenRefresh.mock.calls.at(-1)![0] as (t: string) => void;
    onRotate('fcm-token-3');
    await flush();

    expect(boot.getPushRegisterHealth().registered).toBe(false);
  });
});

describe('stopFcmBootstrap — logout teardown', () => {
  it('drops the FCM listeners, the banner notifier and the CallKit subscription', async () => {
    mockStore.set('auth:access_token', 'jwt-1');
    const boot = loadBootstrap();
    await boot.startFcmBootstrap();
    await flush();

    boot.stopFcmBootstrap();

    expect(mockUnsubTokenRefresh).toHaveBeenCalledTimes(1);
    expect(mockUnsubOnMessage).toHaveBeenCalledTimes(1);
    // Leaving THIS attached is what made one system-UI Accept fire twice after
    // a logout→login (double call.answer → have-local-offer wedge).
    expect(mockCallKitUnsub).toHaveBeenCalledTimes(1);
    expect(live('../push/backgroundMessageNotifier').stopBackgroundMessageNotifier).toHaveBeenCalledTimes(1);
    expect(live('../push/callKitBridge').teardownCallKit).toHaveBeenCalledTimes(1);
  });

  it('a re-login runs the full bootstrap again instead of short-circuiting', async () => {
    mockStore.set('auth:access_token', 'jwt-1');
    const boot = loadBootstrap();
    await boot.startFcmBootstrap();
    await flush();
    boot.stopFcmBootstrap();
    fetchMock.mockClear();

    await boot.startFcmBootstrap();
    await flush();

    // `started` was cleared, so the token + register lane runs from scratch and
    // a NEW CallKit subscription is installed for the new session.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(live('../push/callKitBridge').subscribeToCallKitEvents).toHaveBeenCalledTimes(2);
  });

  it('a repeat bootstrap while still registered is a no-op (no duplicate POSTs)', async () => {
    mockStore.set('auth:access_token', 'jwt-1');
    const boot = loadBootstrap();
    await boot.startFcmBootstrap();
    await flush();
    fetchMock.mockClear();

    await boot.startFcmBootstrap();
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a repeat bootstrap while NOT server-registered re-attempts the register', async () => {
    mockStore.set('auth:access_token', 'jwt-1');
    fetchMock.mockImplementation(async () => status(500, 'boom'));
    const boot = loadBootstrap();
    await boot.startFcmBootstrap();
    await flush();
    expect(boot.getPushRegisterHealth().registered).toBe(false);

    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => ok());
    await boot.startFcmBootstrap();
    await flush();

    // Without this re-attempt the recipient stays invisible to push forever.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(boot.getPushRegisterHealth().registered).toBe(true);
  });
});
