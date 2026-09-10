/**
 * WI-4.1 — the killed-app (headless) voip-wake lane must produce a REAL
 * incoming call, not just a picture of one.
 *
 * The warm background lane runs: verify → gates → cache seed (merge) →
 * tombstone refusal → Telecom report → notifee card. The headless lane ran:
 * verify → notifee card. Everything between was missing, so a killed-app ring
 * was a notification with nothing behind it:
 *
 *   - no cache seed → an immediate Telecom/system Answer found no payload:
 *     no SDP hydration, no conversation, no roomToken — the accept stalled;
 *   - no tombstone check → a callId the user had already declined (caller
 *     retry, duplicate wake) re-rang from the killed lane;
 *   - no Telecom report → no system call UI / lock-screen surface, and the
 *     later Answer had no CXCall to answer;
 *   - headless call-cancel left no tombstone and no Telecom teardown → the
 *     ring surfaces it drew could be resurrected by a queued Accept, and the
 *     system UI kept showing a call that was over.
 *
 * The runtime is NOT booted here — every collaborator is a leaf module
 * (incomingCallCache, callKitBridge, restoreMode, the registries).
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
jest.mock('react-native', () => ({Platform: {OS: 'android'}, NativeModules: {}}));
jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    displayNotification: jest.fn(async () => {}),
    cancelNotification:  jest.fn(async () => {}),
    createChannel:       jest.fn(async () => 'ch'),
    deleteChannel:       jest.fn(async () => {}),
  },
  AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2},
  AndroidCategory:   {MESSAGE: 'msg', CALL: 'call'},
  AndroidVisibility: {PRIVATE: 0, PUBLIC: 1},
  AndroidStyle:      {BIGTEXT: 1, MESSAGING: 2},
  EventType:         {PRESS: 1, ACTION_PRESS: 2},
}));
jest.mock('../push/voipWakeVerify', () => ({verifyVoipWake: jest.fn(async () => ({ok: true}))}));
jest.mock('../push/callKitBridge', () => ({
  reportIncomingCall: jest.fn(),
  reportEnded:        jest.fn(),
}));

import notifee from '@notifee/react-native';
import {handleHeadlessFcm} from '../push/fcmHeadless';
import {verifyVoipWake} from '../push/voipWakeVerify';
import * as bridge from '../push/callKitBridge';
import * as cache from '../push/incomingCallCache';

const display = notifee.displayNotification as jest.Mock;
const cancel  = notifee.cancelNotification as jest.Mock;
const reportIncoming = bridge.reportIncomingCall as jest.Mock;
const reportEnded    = bridge.reportEnded as jest.Mock;

const msg = (data: Record<string, string>) => handleHeadlessFcm({data} as never);

beforeEach(() => {
  mockStore.clear();
  display.mockClear();
  cancel.mockClear();
  reportIncoming.mockClear();
  reportEnded.mockClear();
  (verifyVoipWake as jest.Mock).mockResolvedValue({ok: true});
  cache._resetIncomingCallCacheForTests();
});

describe('WI-4.1 — voip-wake seeds real incoming-call state', () => {
  it('seeds the incoming-call cache BEFORE any UI (1:1)', async () => {
    await msg({kind: 'voip-wake', callId: 'c-h1', callKind: 'voice', fromUserId: 'u-9', conversationId: 'conv-7'});
    const p = cache.getIncomingCallPayload('c-h1');
    expect(p).not.toBeNull();
    expect(p).toMatchObject({callId: 'c-h1', kind: 'voice', fromUserId: 'u-9', conversationId: 'conv-7'});
  });

  it('seeds the group fields — roomId derived from callId, roomToken threaded', async () => {
    await msg({kind: 'voip-wake', callId: 'room-g1', callKind: 'group-voice', fromUserId: 'u-9', roomToken: 'tok-1', conversationId: 'conv-g'});
    const p = cache.getIncomingCallPayload('room-g1');
    expect(p).toMatchObject({roomId: 'room-g1', roomToken: 'tok-1', conversationId: 'conv-g', kind: 'group-voice'});
  });

  it('reports the call to Telecom with the group kind collapsed', async () => {
    await msg({kind: 'voip-wake', callId: 'room-g2', callKind: 'group-video', fromUserId: 'u-9'});
    expect(reportIncoming).toHaveBeenCalledTimes(1);
    expect(reportIncoming.mock.calls[0][0]).toMatchObject({callId: 'room-g2', kind: 'video'});
  });

  it('REFUSES a tombstoned callId entirely — no cache, no Telecom, no card', async () => {
    cache.setIncomingCallPayload({callId: 'c-dead', callerName: 'X', kind: 'voice'});
    cache.clearIncomingCallPayload('c-dead'); // declined / cancelled → tombstone
    display.mockClear();
    await msg({kind: 'voip-wake', callId: 'c-dead', callKind: 'voice', fromUserId: 'u-9'});
    expect(cache.getIncomingCallPayload('c-dead')).toBeNull();
    expect(reportIncoming).not.toHaveBeenCalled();
    expect(display).not.toHaveBeenCalled();
  });

  it('a failed verification seeds NOTHING (ring admission stays HMAC-gated)', async () => {
    (verifyVoipWake as jest.Mock).mockResolvedValueOnce({ok: false, reason: 'sig'});
    await msg({kind: 'voip-wake', callId: 'c-forged', callKind: 'voice', fromUserId: 'u-9'});
    expect(cache.getIncomingCallPayload('c-forged')).toBeNull();
    expect(reportIncoming).not.toHaveBeenCalled();
    expect(display).not.toHaveBeenCalled();
  });

  it('still displays the notifee card after seeding (the lane end is unchanged)', async () => {
    await msg({kind: 'voip-wake', callId: 'c-h2', callKind: 'voice', fromUserId: 'u-9'});
    expect(display).toHaveBeenCalledTimes(1);
    expect(display.mock.calls[0][0].id).toBe('bravo-call-c-h2');
  });
});

describe('WI-4.1 — headless call-cancel is a full teardown', () => {
  it('tombstones the callId so a queued Accept cannot resurrect the call', async () => {
    await msg({kind: 'voip-wake', callId: 'c-x1', callKind: 'voice', fromUserId: 'u-9'});
    await msg({kind: 'call-cancel', callId: 'c-x1'});
    expect(cache.isIncomingCallDead('c-x1')).toBe(true);
    expect(cache.getIncomingCallPayload('c-x1')).toBeNull();
  });

  it('tears down the Telecom display (reportEnded remoteEnded)', async () => {
    await msg({kind: 'call-cancel', callId: 'c-x2'});
    expect(reportEnded).toHaveBeenCalledWith('c-x2', 'remoteEnded');
  });

  it('still dismisses the ring card and posts the missed trace', async () => {
    await msg({kind: 'call-cancel', callId: 'c-x3', missed: '1', callerName: 'Alice', fromUserId: 'u-9', callKind: 'voice'});
    expect(cancel).toHaveBeenCalledWith('bravo-call-c-x3');
    const missed = display.mock.calls.find(c => c[0].id === 'bravo-missed-c-x3');
    expect(missed).toBeDefined();
  });

  it('an empty callId is ignored (the warm lane guards this; parity)', async () => {
    await msg({kind: 'call-cancel', callId: ''});
    expect(reportEnded).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});
