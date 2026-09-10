/**
 * B-102 - explicit-accept latch + null-controller decline fallback.
 *
 *   A1: the WS offer navigation consults wasCallExplicitlyAccepted() so an
 *       offer replay landing AFTER the notification Answer tap re-asserts
 *       autoAccept instead of clobbering it (RN6 navigate replaces params).
 *   A2: declineIncomingCallBestEffort() is the ring screen's fallback when
 *       the useCall controller never built (SDP-late boot) - it must send
 *       call.hangup{declined} from the cached payload and clear every latch.
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

const mockSent: unknown[] = [];
let mockLiveTx: {send: (f: unknown) => void} | null = {send: f => { mockSent.push(f); }};
jest.mock('@/modules/messenger/runtime/transportRegistry', () => ({
  getLiveTransport: () => mockLiveTx,
}));

import {
  markCallAccepted,
  wasCallExplicitlyAccepted,
  notifyCallEnded,
  declineIncomingCallBestEffort,
} from '../push/fcmBootstrap';
import * as cache from '../push/incomingCallCache';

beforeEach(() => {
  mockSent.length = 0;
  mockLiveTx = {send: f => { mockSent.push(f); }};
  cache._resetIncomingCallCacheForTests();
});

describe('B-102 A1 - explicit-accept latch', () => {
  it('marks and reports an explicit accept', () => {
    expect(wasCallExplicitlyAccepted('c1')).toBe(false);
    markCallAccepted('c1');
    expect(wasCallExplicitlyAccepted('c1')).toBe(true);
    expect(wasCallExplicitlyAccepted('c2')).toBe(false);
  });

  it('clears the latch when the call ends (same callId can ring fresh later)', () => {
    markCallAccepted('c1');
    notifyCallEnded('c1');
    expect(wasCallExplicitlyAccepted('c1')).toBe(false);
  });
});

describe('B-102 A2 - declineIncomingCallBestEffort', () => {
  it('sends call.hangup{declined} from the cached payload and clears everything', () => {
    cache.setIncomingCallPayload({
      callId: 'c9',
      fromUserId: 'caller-uid',
      remoteDeviceId: 3,
      kind: 'voice',
    } as never);
    markCallAccepted('c9');

    declineIncomingCallBestEffort('c9');

    expect(mockSent).toHaveLength(1);
    expect(mockSent[0]).toMatchObject({
      event: 'call.hangup',
      data: {callId: 'c9', to: {userId: 'caller-uid', deviceId: 3}, reason: 'declined'},
    });
    expect(cache.getIncomingCallPayload('c9')).toBeNull();
    expect(wasCallExplicitlyAccepted('c9')).toBe(false);
  });

  it('defaults deviceId to 1 when the payload has none', () => {
    cache.setIncomingCallPayload({callId: 'c10', fromUserId: 'caller-uid', kind: 'voice'} as never);
    declineIncomingCallBestEffort('c10');
    expect(mockSent[0]).toMatchObject({data: {to: {userId: 'caller-uid', deviceId: 1}}});
  });

  it('is a safe no-op with nothing cached', () => {
    expect(() => declineIncomingCallBestEffort('missing')).not.toThrow();
    expect(mockSent).toHaveLength(0);
  });

  it('still clears the cache when the transport is down (fail-soft to no-answer)', () => {
    mockLiveTx = null;
    cache.setIncomingCallPayload({callId: 'c11', fromUserId: 'caller-uid', kind: 'voice'} as never);
    declineIncomingCallBestEffort('c11');
    expect(mockSent).toHaveLength(0);
    expect(cache.getIncomingCallPayload('c11')).toBeNull();
  });
});
