/**
 * NA-02 (B-121 CALL-D) — the two push-layer halves of the dead-offer exit:
 *
 *   1. `incomingCallCache.isIncomingCallDead()` — the cross-lane "this call is
 *      dead" probe a controller-less ring screen can read (every cancel lane
 *      funnels through `clearIncomingCallPayload`, which tombstones).
 *   2. `declineIncomingCallBestEffort(callId, reason)` — the same B-102
 *      null-controller teardown, now able to say `'failed'` instead of lying
 *      to the caller / Telecom that the user declined.
 *
 * The default-arg case is the back-compat guard on the signature widening
 * (callAcceptLatch.test.ts pins the same default from the other side).
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

const mockReportEnded = jest.fn();
jest.mock('../push/callKitBridge', () => ({
  reportEnded: (...a: unknown[]) => mockReportEnded(...a),
  reportIncomingCall: jest.fn(),
  reportAnswered: jest.fn(),
}));

const mockSent: unknown[] = [];
let mockLiveTx: {send: (f: unknown) => void} | null = {send: f => { mockSent.push(f); }};
jest.mock('@/modules/messenger/runtime/transportRegistry', () => ({
  getLiveTransport: () => mockLiveTx,
}));

import {declineIncomingCallBestEffort} from '../push/fcmBootstrap';
import * as cache from '../push/incomingCallCache';

beforeEach(() => {
  mockSent.length = 0;
  mockReportEnded.mockClear();
  mockLiveTx = {send: f => { mockSent.push(f); }};
  cache._resetIncomingCallCacheForTests();
});

describe('NA-02 — isIncomingCallDead tombstone probe', () => {
  it('C1 — false for an untouched callId, true once the call is cleared', () => {
    cache.setIncomingCallPayload({callId: 'x', fromUserId: 'u', kind: 'voice'} as never);
    expect(cache.isIncomingCallDead('x')).toBe(false);
    cache.clearIncomingCallPayload('x');
    expect(cache.isIncomingCallDead('x')).toBe(true);
  });

  it('C2 — true even when nothing was ever cached (peer hung up before the offer)', () => {
    expect(cache.isIncomingCallDead('never-seen')).toBe(false);
    cache.clearIncomingCallPayload('never-seen');
    expect(cache.isIncomingCallDead('never-seen')).toBe(true);
  });

  it('C3 — a live cached ring is never reported dead (live-call safety)', () => {
    cache.setIncomingCallPayload({
      callId: 'live', fromUserId: 'u', remoteDeviceId: 2, kind: 'voice', incomingSdp: 'v=0',
    } as never);
    expect(cache.getIncomingCallPayload('live')).not.toBeNull();
    expect(cache.isIncomingCallDead('live')).toBe(false);
    // A different call dying must not implicate this one.
    cache.clearIncomingCallPayload('other');
    expect(cache.isIncomingCallDead('live')).toBe(false);
  });
});

describe('NA-02 — declineIncomingCallBestEffort reason', () => {
  it("C4 — reason 'failed' reaches both the caller frame and Telecom", () => {
    cache.setIncomingCallPayload({
      callId: 'c1', fromUserId: 'caller-uid', remoteDeviceId: 3, kind: 'voice',
    } as never);

    declineIncomingCallBestEffort('c1', 'failed');

    expect(mockSent).toHaveLength(1);
    expect(mockSent[0]).toMatchObject({
      event: 'call.hangup',
      data: {callId: 'c1', to: {userId: 'caller-uid', deviceId: 3}, reason: 'failed'},
    });
    expect(mockReportEnded).toHaveBeenCalledWith('c1', 'failed');
  });

  it("C5 — back-compat: the default arg still says 'declined'", () => {
    cache.setIncomingCallPayload({
      callId: 'c2', fromUserId: 'caller-uid', remoteDeviceId: 1, kind: 'voice',
    } as never);

    declineIncomingCallBestEffort('c2');

    expect(mockSent[0]).toMatchObject({
      event: 'call.hangup',
      data: {callId: 'c2', reason: 'declined'},
    });
    expect(mockReportEnded).toHaveBeenCalledWith('c2', 'declined');
  });

  it('C6 — either teardown leaves the callId cleared and tombstoned', () => {
    cache.setIncomingCallPayload({callId: 'c3', fromUserId: 'u', kind: 'voice'} as never);
    declineIncomingCallBestEffort('c3', 'failed');
    expect(cache.getIncomingCallPayload('c3')).toBeNull();
    expect(cache.isIncomingCallDead('c3')).toBe(true);

    cache.setIncomingCallPayload({callId: 'c4', fromUserId: 'u', kind: 'voice'} as never);
    declineIncomingCallBestEffort('c4');
    expect(cache.getIncomingCallPayload('c4')).toBeNull();
    expect(cache.isIncomingCallDead('c4')).toBe(true);
  });
});
