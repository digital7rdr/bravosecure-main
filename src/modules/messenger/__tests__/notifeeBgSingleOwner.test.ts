/**
 * WI-4.2 — notifee.onBackgroundEvent has exactly ONE registration owner.
 *
 * Evaluation order, verified (not assumed): index.js registers the SLIM
 * handler at bundle entry; a logged-in MainNavigator later runs
 * startFcmBootstrap, whose installNotifeeHandlers used to call
 * notifee.onBackgroundEvent AGAIN. notifee keeps a single bg-handler slot, so
 * this worked by accident of last-write-wins — an undocumented displacement
 * two files apart, where a future registrar (or a re-ordering of boot) would
 * silently decide which behaviours exist for killed-app taps.
 *
 * Now callNotification owns THE registration, once, and the rich handler
 * installs itself as a DELEGATE into that closure. Before the delegate
 * arrives the slim behaviour serves (durable decline + dismiss); after, every
 * event routes to the rich handler. Ownership is a module contract, not a
 * race.
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
jest.mock('@react-native-firebase/messaging', () => {
  const api = {
    getToken:                    jest.fn(async () => 'tok'),
    onTokenRefresh:              jest.fn(() => () => {}),
    onMessage:                   jest.fn(() => () => {}),
    setBackgroundMessageHandler: jest.fn(),
  };
  return {__esModule: true, default: () => api};
});
jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    onBackgroundEvent:      jest.fn(),
    onForegroundEvent:      jest.fn(),
    getInitialNotification: jest.fn(async () => null),
    displayNotification:    jest.fn(async () => {}),
    cancelNotification:     jest.fn(async () => {}),
    createChannel:          jest.fn(async () => 'ch'),
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
  reportIncomingCall:       jest.fn(),
}));
jest.mock('../push/voipPush', () => ({startVoipPushBootstrap: jest.fn(async () => {})}));
jest.mock('../push/backgroundMessageNotifier', () => ({
  startBackgroundMessageNotifier: jest.fn(),
  stopBackgroundMessageNotifier:  jest.fn(),
}));
jest.mock('@/modules/messenger/runtime/transportRegistry', () => ({getLiveTransport: () => null}));

const PRESS = 1;
const ACTION_PRESS = 2;

function nf(): Record<string, jest.Mock> {
  return (require('@notifee/react-native') as {default: Record<string, jest.Mock>}).default;
}

type Ev = {type: number; detail: Record<string, unknown>};

beforeEach(() => {
  jest.resetModules();
  mockStore.clear();
  mockNav.mockClear();
});

describe('WI-4.2 — one registration, delegated behaviour', () => {
  it('the whole boot sequence registers onBackgroundEvent EXACTLY ONCE', async () => {
    const cn = require('../push/callNotification') as typeof import('../push/callNotification');
    cn.installSlimNotifeeBgHandler();                       // bundle entry
    const boot = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
    await boot.startFcmBootstrap();                         // post-login
    expect(nf().onBackgroundEvent).toHaveBeenCalledTimes(1);
  });

  it('before the rich delegate installs, the registered closure serves the slim behaviour', async () => {
    const cn = require('../push/callNotification') as typeof import('../push/callNotification');
    cn.installSlimNotifeeBgHandler();
    const handler = nf().onBackgroundEvent.mock.calls[0][0] as (e: Ev) => Promise<void>;
    await handler({
      type:   ACTION_PRESS,
      detail: {
        notification: {id: 'bravo-call-c-slim', data: {callId: 'c-slim', kind: 'voice', fromUserId: 'u-1'}},
        pressAction:  {id: 'decline-c-slim'},
      },
    });
    // The slim decline lane always cancels the ring card; it never navigates.
    expect(nf().cancelNotification).toHaveBeenCalledWith('bravo-call-c-slim');
    expect(mockNav).not.toHaveBeenCalled();
  });

  it('after startFcmBootstrap, the SAME closure routes to the rich handler', async () => {
    const cn = require('../push/callNotification') as typeof import('../push/callNotification');
    cn.installSlimNotifeeBgHandler();
    const handler = nf().onBackgroundEvent.mock.calls[0][0] as (e: Ev) => Promise<void>;
    const boot = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
    await boot.startFcmBootstrap();
    await handler({
      type:   ACTION_PRESS,
      detail: {
        notification: {id: 'bravo-call-c-rich', data: {callId: 'c-rich', kind: 'voice', fromUserId: 'u-1', conversationId: 'conv-1'}},
        pressAction:  {id: 'accept-c-rich'},
      },
    });
    // The rich Answer lane navigates — the slim one cannot.
    expect(mockNav).toHaveBeenCalled();
    expect(boot.wasCallExplicitlyAccepted('c-rich')).toBe(true);
  });

  it('iOS (no slim install) still gets exactly one registration via the delegate installer', async () => {
    jest.resetModules();
    jest.doMock('react-native', () => ({
      Platform: {OS: 'ios', Version: 17},
      PermissionsAndroid: {check: jest.fn(async () => true), request: jest.fn(async () => 'granted')},
      NativeModules: {},
    }));
    const cn = require('../push/callNotification') as typeof import('../push/callNotification');
    cn.installSlimNotifeeBgHandler();                       // gated out on iOS
    expect(nf().onBackgroundEvent).not.toHaveBeenCalled();
    const boot = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
    await boot.startFcmBootstrap();
    expect(nf().onBackgroundEvent).toHaveBeenCalledTimes(1);
    jest.dontMock('react-native');
  });

  it('a body PRESS through the delegated closure reaches the rich body-tap lane', async () => {
    const cn = require('../push/callNotification') as typeof import('../push/callNotification');
    cn.installSlimNotifeeBgHandler();
    const handler = nf().onBackgroundEvent.mock.calls[0][0] as (e: Ev) => Promise<void>;
    const boot = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
    await boot.startFcmBootstrap();
    await handler({
      type:   PRESS,
      detail: {
        notification: {id: 'bravo-call-c-body', data: {callId: 'c-body', kind: 'voice', fromUserId: 'u-1'}},
        pressAction:  {id: 'default'},
      },
    });
    expect(mockNav).toHaveBeenCalled();
    // WI-4.4 — and it must not have latched the Answer intent.
    expect(boot.wasCallExplicitlyAccepted('c-body')).toBe(false);
  });
});
