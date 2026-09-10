/**
 * NA-04 — a Telecom / lock-screen / headset Answer leaves the process
 * backgrounded. CallScreen then starts the call foreground service from a
 * background procstate, Android refuses the microphone/camera FGS types and
 * CallForegroundService degrades to typeless — the callee is mute, and the
 * in-call UI never comes forward at all.
 *
 * bringAppToForeground() used to live ONLY in the no-cached-payload early
 * return, i.e. it never ran on the normal path. These tests pin it to BOTH
 * branches, ahead of the navigate.
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
  Platform: {OS: 'android'},
  PermissionsAndroid: {request: jest.fn(), PERMISSIONS: {}, RESULTS: {}},
  NativeModules: {},
}));
jest.mock('@react-native-firebase/messaging', () => ({
  __esModule: true,
  default: () => ({
    setBackgroundMessageHandler: jest.fn(),
    getToken: jest.fn(async () => 'tok'),
    onTokenRefresh: jest.fn(() => () => {}),
    onMessage: jest.fn(() => () => {}),
    requestPermission: jest.fn(async () => 1),
  }),
}));
jest.mock('@utils/constants', () => ({MSG_BASE_URL: 'http://test.local'}));
jest.mock('../push/callNotification', () => ({
  dismissCallNotif: jest.fn(async () => {}),
}));
jest.mock('@/modules/messenger/runtime/transportRegistry', () => ({
  getLiveTransport: () => null,
}));

const mockOrder: string[] = [];
const mockNav = jest.fn();
jest.mock('../push/callKitBridge', () => ({
  bringAppToForeground:     jest.fn(() => { mockOrder.push('foreground'); }),
  reportEnded:              jest.fn(),
  subscribeToCallKitEvents: jest.fn(() => () => {}),
}));
jest.mock('@navigation/navigationRef', () => ({
  navigationRef: {
    isReady:  () => true,
    navigate: (n: string, p?: unknown) => { mockOrder.push('navigate'); mockNav(n, p); },
  },
}));

import {handleSystemUiAnswer} from '../push/fcmBootstrap';
import * as bridge from '../push/callKitBridge';
import * as cache from '../push/incomingCallCache';

const bringForward = bridge.bringAppToForeground as jest.Mock;

beforeEach(() => {
  mockOrder.length = 0;
  mockNav.mockClear();
  bringForward.mockClear();
  cache._resetIncomingCallCacheForTests();
});

describe('NA-04 — handleSystemUiAnswer surfaces the app', () => {
  it('brings the app forward on the CACHED-PAYLOAD path (the defect)', async () => {
    cache.setIncomingCallPayload({callId: 'c1', callerName: 'Alice', kind: 'voice', fromUserId: 'u1', incomingSdp: 'sdp'});
    handleSystemUiAnswer('c1');
    await Promise.resolve();

    expect(bringForward).toHaveBeenCalledTimes(1);
  });

  it('brings the app forward BEFORE navigating (CallScreen must not mount backgrounded)', async () => {
    cache.setIncomingCallPayload({callId: 'c2', callerName: 'Alice', kind: 'voice', fromUserId: 'u1', incomingSdp: 'sdp'});
    handleSystemUiAnswer('c2');
    await Promise.resolve();

    expect(mockOrder).toEqual(['foreground', 'navigate']);
  });

  it('still brings the app forward, and does not navigate, with no cached payload', async () => {
    handleSystemUiAnswer('unknown-call');
    await Promise.resolve();

    expect(bringForward).toHaveBeenCalledTimes(1);
    expect(mockNav).not.toHaveBeenCalled();
  });

  it('navigates a 1:1 answer to CallScreen with the cached route (extraction is behaviour-neutral)', async () => {
    cache.setIncomingCallPayload({
      callId: 'c3', callerName: 'Alice', kind: 'voice', fromUserId: 'u1',
      remoteDeviceId: 7, incomingSdp: 'sdp', conversationId: 'convo-uuid',
    });
    handleSystemUiAnswer('c3');
    await Promise.resolve();

    expect(mockNav).toHaveBeenCalledTimes(1);
    expect(mockNav.mock.calls[0][0]).toBe('Main');
    expect(mockNav.mock.calls[0][1]).toMatchObject({
      screen: 'MessengerTab',
      params: {
        screen: 'CallScreen',
        params: {
          isIncoming:     true,
          autoAccept:     true,
          callId:         'c3',
          conversationId: 'convo-uuid',
          remoteDeviceId: 7,
          incomingSdp:    'sdp',
        },
      },
    });
  });

  it('routes a group answer to IncomingGroupCallScreen', async () => {
    cache.setIncomingCallPayload({
      callId: 'g1', callerName: 'Host', kind: 'group-voice', fromUserId: 'u9',
      roomId: 'g1', roomToken: 'tok', conversationId: 'gconvo',
    });
    handleSystemUiAnswer('g1');
    await Promise.resolve();

    expect(mockNav.mock.calls[0][1]).toMatchObject({
      screen: 'MessengerTab',
      params: {
        screen: 'IncomingGroupCallScreen',
        params: {roomId: 'g1', roomToken: 'tok', conversationId: 'gconvo', autoAccept: true},
      },
    });
  });

  it('keeps the accept dedupe: a duplicate answer re-surfaces but navigates once', async () => {
    cache.setIncomingCallPayload({callId: 'c4', callerName: 'Alice', kind: 'voice', fromUserId: 'u1', incomingSdp: 'sdp'});
    handleSystemUiAnswer('c4');
    handleSystemUiAnswer('c4');
    await Promise.resolve();

    expect(mockNav).toHaveBeenCalledTimes(1);
    expect(bringForward).toHaveBeenCalledTimes(2);
  });
});
