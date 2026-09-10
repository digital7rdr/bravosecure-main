/**
 * OR-3 — the iOS banner is drawn by the SERVER (APNs `aps.alert`, see
 * push.service.sendChatWake); the client's job is only to (a) request the
 * UNUserNotificationCenter authorization that makes the alert visible and
 * (b) keep every client draw path Android-only so exactly one banner exists
 * in every app state (a client draw would DOUBLE the server alert with an id
 * the server can neither collapse nor clear — including force-quit, which no
 * client-side fix can reach).
 *
 * Locks: the no-draw invariant on the killed-path handler under iOS, the new
 * requestIosNotificationAuthorization seam + its startFcmBootstrap wiring,
 * and (statically) the `Platform.OS !== 'android'` gates on every draw path.
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
  Platform: {OS: 'ios', Version: '17.0'},
  PermissionsAndroid: {check: jest.fn(async () => true), request: jest.fn(async () => 'granted')},
  NativeModules: {},
}));
jest.mock('@utils/constants', () => ({MSG_BASE_URL: 'https://msg.test'}));
jest.mock('@services/api', () => ({refreshAccessTokenShared: jest.fn(async () => {})}), {virtual: true});

jest.mock('@react-native-firebase/messaging', () => {
  const api = {
    getToken:                    jest.fn(() => new Promise(() => { /* never settles */ })),
    requestPermission:           jest.fn(async () => 1),
    registerDeviceForRemoteMessages: jest.fn(async () => {}),
    onTokenRefresh:              jest.fn(() => () => {}),
    onMessage:                   jest.fn(() => () => {}),
    setBackgroundMessageHandler: jest.fn(),
  };
  const messaging = () => api;
  return {__esModule: true, default: messaging};
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
    deleteChannel:          jest.fn(async () => {}),
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

import {readFileSync} from 'fs';
import {join} from 'path';

/** jest.resetModules() re-runs the mock factories — always read LIVE instances. */
function nf(): Record<string, jest.Mock> {
  return (require('@notifee/react-native') as {default: Record<string, jest.Mock>}).default;
}
function fcm(): Record<string, jest.Mock> {
  const mod = require('@react-native-firebase/messaging') as {default: () => Record<string, jest.Mock>};
  return mod.default();
}

beforeEach(() => {
  // fcmBootstrap latches `started`/`serverRegistered` at module scope — every
  // case needs a virgin process.
  jest.resetModules();
  jest.useFakeTimers(); // keeps the 10 s push-register deadline off the real loop
  mockStore.clear();
  (global as {fetch?: unknown}).fetch = undefined;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('OR-3 — iOS draws nothing client-side (the APNs alert is the only lane)', () => {
  it('the killed-app iOS msg-wake displays NO notifee banner', async () => {
    const {handleHeadlessFcm} = require('../push/fcmHeadless') as typeof import('../push/fcmHeadless');
    await handleHeadlessFcm({data: {kind: 'msg-wake', conversationId: 'c1', senderUserId: 'peer-1'}} as never);
    // A client draw here would DOUBLE the server-drawn aps.alert with an id the
    // server cannot collapse or clear. Keep every draw path Android-only.
    expect(nf().displayNotification).not.toHaveBeenCalled();
  });

  it('every client draw path is statically Android-gated (double-banner lock)', () => {
    const pushDir = join(__dirname, '..', 'push');
    const cn = readFileSync(join(pushDir, 'callNotification.ts'), 'utf8');
    const bg = readFileSync(join(pushDir, 'backgroundMessageNotifier.ts'), 'utf8');
    // The iOS gate must sit between the function head and its first effect —
    // an un-gated draw path re-opens the double-banner lane.
    const gateBefore = (src: string, fnName: string, effect: string) => {
      const fnAt = src.indexOf(`function ${fnName}`);
      expect(fnAt).toBeGreaterThan(-1);
      const gateAt = src.indexOf("Platform.OS !== 'android'", fnAt);
      const effectAt = src.indexOf(effect, fnAt);
      expect(gateAt).toBeGreaterThan(-1);
      expect(effectAt).toBeGreaterThan(-1);
      expect(gateAt).toBeLessThan(effectAt);
    };
    gateBefore(cn, 'showMessageNotif', 'displayNotification');
    gateBefore(cn, 'dismissMessageNotif', 'cancelNotification');
    gateBefore(cn, 'installSlimNotifeeBgHandler', 'onBackgroundEvent');
    gateBefore(bg, 'startBackgroundMessageNotifier', 'running = true');
  });
});

describe('OR-3 — iOS notification authorization (an aps.alert without it is dropped)', () => {
  it('requestIosNotificationAuthorization resolves the OS status', async () => {
    const boot = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
    await expect(boot.requestIosNotificationAuthorization()).resolves.toBe(1);
    expect(fcm().requestPermission).toHaveBeenCalledTimes(1);
  });

  it('resolves -1 (never throws) when the OS request fails', async () => {
    const boot = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
    fcm().requestPermission.mockRejectedValueOnce(new Error('denied'));
    await expect(boot.requestIosNotificationAuthorization()).resolves.toBe(-1);
  });

  it('startFcmBootstrap on iOS requests the authorization (wiring, not just the seam)', async () => {
    const boot = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
    await boot.startFcmBootstrap();
    expect(fcm().requestPermission).toHaveBeenCalledTimes(1);
  });

  it('startFcmBootstrap on iOS registers for remote messages (IOSMSG-2)', async () => {
    // RNFirebase auto-registers by default, but that default can be turned
    // off from firebase.json without anyone touching this file — an explicit
    // register keeps getToken() from silently resolving null and killing the
    // whole iOS data-wake lane.
    const boot = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
    await boot.startFcmBootstrap();
    expect(fcm().registerDeviceForRemoteMessages).toHaveBeenCalledTimes(1);
  });
});
