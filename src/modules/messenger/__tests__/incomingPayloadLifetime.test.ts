/**
 * WI-4.8 — the incoming-call payload must live as long as the intent it backs.
 *
 * Three lifetimes were misaligned:
 *
 *   payload TTL        60 s   (incomingCallCache, private literal)
 *   ring window        45 s   (RING_TIMEOUT_MS)
 *   cold-nav wait      20 s   (four inline `20000` literals in fcmBootstrap)
 *
 * A ring answered near its 45 s deadline, on a cold launch whose navigator
 * takes the full 20 s wait, hydrates its route from this cache at t≈65 s —
 * after the payload evaporated at t=60 s. The route lands with no SDP / no
 * deviceId / no conversationId and the answer stalls (the exact B-102 A1
 * starvation, manufactured by a TTL).
 *
 * Worse, `onEnd`'s own header claims "an in-app-answered call keeps its cached
 * payload for the whole call" — the 60 s TTL made that false, and the decline
 * branch below it ("payload present + registry empty → send declined") could
 * fire on a call whose Answer was mid-flight: Telecom tearing down its ring
 * surface DECLINED the call the user just answered.
 *
 * Fixes pinned here:
 *   1. TTLs promoted to callDeadlines with the ordering
 *      INCOMING_PAYLOAD_TTL_MS > RING_TIMEOUT_MS + NAV_READY_WAIT_MS and
 *      INCOMING_TOMBSTONE_TTL_MS > INCOMING_PAYLOAD_TTL_MS.
 *   2. gc() never expires the payload of the LIVE call (registry probe).
 *   3. onEnd's decline branch consults the explicit-accept latch: a valid
 *      Answer intent is never converted into a decline.
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
jest.mock('@navigation/navigationRef', () => ({
  navigationRef: {isReady: () => true, navigate: jest.fn()},
}));
jest.mock('../push/voipPush', () => ({startVoipPushBootstrap: jest.fn(async () => {})}));
jest.mock('../push/backgroundMessageNotifier', () => ({
  startBackgroundMessageNotifier: jest.fn(),
  stopBackgroundMessageNotifier:  jest.fn(),
}));

/** Captured Telecom event handlers (onEnd is the branch under test). */
let capturedCallKitHandlers: Record<string, (callId: string) => void> = {};
jest.mock('../push/callKitBridge', () => ({
  setupCallKit:             jest.fn(async () => {}),
  subscribeToCallKitEvents: jest.fn((h: Record<string, (callId: string) => void>) => {
    capturedCallKitHandlers = h;
    return () => {};
  }),
  bringAppToForeground:     jest.fn(),
  reportEnded:              jest.fn(),
  reportIncomingCall:       jest.fn(),
}));

const mockSent: Array<Record<string, unknown>> = [];
jest.mock('@/modules/messenger/runtime/transportRegistry', () => ({
  getLiveTransport: () => ({send: (f: Record<string, unknown>) => { mockSent.push(f); }}),
}));

/** The live-call registry probe (gc exemption + onEnd's first branch). */
let mockActiveCall: {callId: string; state: string} | null = null;
jest.mock('@/modules/messenger/runtime/callRegistry', () => ({
  getActiveCall: () => mockActiveCall,
  endActiveCall: jest.fn(() => 'ended'),
  wasRecentlyEnded: () => false,
  onActiveCallChange: jest.fn(() => () => {}),
}));
jest.mock('@/modules/messenger/runtime/groupCallRegistry', () => ({
  getActiveGroupCall: () => null,
}));

import {
  RING_TIMEOUT_MS,
  NAV_READY_WAIT_MS,
  INCOMING_PAYLOAD_TTL_MS,
  INCOMING_TOMBSTONE_TTL_MS,
} from '../webrtc/callDeadlines';

type Cache = typeof import('../push/incomingCallCache');
function loadCache(): Cache {
  return require('../push/incomingCallCache') as Cache;
}

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  mockStore.clear();
  mockSent.length = 0;
  mockActiveCall = null;
  capturedCallKitHandlers = {};
});

afterEach(() => {
  jest.useRealTimers();
});

describe('WI-4.8 — TTL ordering (the numbers themselves)', () => {
  it('the payload outlives a last-second answer on a cold navigator', () => {
    expect(INCOMING_PAYLOAD_TTL_MS).toBeGreaterThan(RING_TIMEOUT_MS + NAV_READY_WAIT_MS);
  });

  it('the tombstone outlives the payload (a delayed rewake cannot slip between)', () => {
    expect(INCOMING_TOMBSTONE_TTL_MS).toBeGreaterThan(INCOMING_PAYLOAD_TTL_MS);
  });
});

describe('WI-4.8 — payload lifetime behaviour', () => {
  it('survives to ring-window + nav-wait (the late-answer hydration window)', () => {
    const cache = loadCache();
    cache.setIncomingCallPayload({callId: 'c-late', callerName: 'A', kind: 'voice', fromUserId: 'u1', incomingSdp: 'sdp'});
    jest.advanceTimersByTime(RING_TIMEOUT_MS + NAV_READY_WAIT_MS);
    const p = cache.getIncomingCallPayload('c-late');
    expect(p).not.toBeNull();
    expect(p?.incomingSdp).toBe('sdp');
  });

  it('still expires an unanswered payload at its TTL', () => {
    const cache = loadCache();
    cache.setIncomingCallPayload({callId: 'c-dead', callerName: 'A', kind: 'voice'});
    jest.advanceTimersByTime(INCOMING_PAYLOAD_TTL_MS + 1_000);
    expect(cache.getIncomingCallPayload('c-dead')).toBeNull();
  });

  it('NEVER expires the payload of the live call (aligned with the call lifetime)', () => {
    const cache = loadCache();
    cache.setIncomingCallPayload({callId: 'c-live', callerName: 'A', kind: 'voice', fromUserId: 'u1'});
    mockActiveCall = {callId: 'c-live', state: 'connected'};
    // Far past any TTL: a real call can run for an hour.
    jest.advanceTimersByTime(INCOMING_PAYLOAD_TTL_MS * 10);
    expect(cache.getIncomingCallPayload('c-live')).not.toBeNull();
    // The moment the call is gone, normal expiry resumes.
    mockActiveCall = null;
    jest.advanceTimersByTime(INCOMING_PAYLOAD_TTL_MS + 1_000);
    expect(cache.getIncomingCallPayload('c-live')).toBeNull();
  });

  it('the live-call exemption never applies to a DIFFERENT call', () => {
    const cache = loadCache();
    cache.setIncomingCallPayload({callId: 'c-other', callerName: 'A', kind: 'voice'});
    mockActiveCall = {callId: 'c-unrelated', state: 'connected'};
    jest.advanceTimersByTime(INCOMING_PAYLOAD_TTL_MS + 1_000);
    expect(cache.getIncomingCallPayload('c-other')).toBeNull();
  });
});

describe('WI-4.8 — Telecom onEnd vs a valid Answer intent', () => {
  async function bootAndGetOnEnd(): Promise<(callId: string) => void> {
    const boot = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
    await boot.startFcmBootstrap();
    expect(capturedCallKitHandlers.onEnd).toBeDefined();
    return capturedCallKitHandlers.onEnd;
  }

  it('does NOT decline a mid-accept call (payload present, registry empty, Answer latched)', async () => {
    const cache = loadCache();
    const boot = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
    const onEnd = await bootAndGetOnEnd();

    cache.setIncomingCallPayload({callId: 'c-mid', callerName: 'A', kind: 'voice', fromUserId: 'u1'});
    boot.markCallAccepted('c-mid');   // the user pressed Answer; controller not built yet
    mockSent.length = 0;

    onEnd('c-mid');

    // THE POINT: the system UI tearing down its ring surface must not turn
    // the user's Answer into a decline at the caller.
    expect(mockSent.filter(f => f.event === 'call.hangup')).toHaveLength(0);
    // And the payload the mid-flight accept still needs must survive.
    expect(cache.getIncomingCallPayload('c-mid')).not.toBeNull();
    expect(cache.isIncomingCallDead('c-mid')).toBe(false);
  });

  it('the no-decline branch is AGE-BOUNDED — a late Telecom End declines again (round 2)', async () => {
    // Past the plausible accept-in-flight window (cold-nav wait + TURN
    // ceiling) a system End cannot still be racing the answer; a real user
    // End must decline exactly as it did at HEAD.
    const cache = loadCache();
    const boot = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
    const onEnd = await bootAndGetOnEnd();

    cache.setIncomingCallPayload({callId: 'c-late-end', callerName: 'A', kind: 'voice', fromUserId: 'u1'});
    boot.markCallAccepted('c-late-end');
    const {NAV_READY_WAIT_MS: NAV, TURN_FETCH_CEILING_MS: TURN} =
      require('../webrtc/callDeadlines') as typeof import('../webrtc/callDeadlines');
    jest.advanceTimersByTime(NAV + TURN + 1_000);
    mockSent.length = 0;

    onEnd('c-late-end');

    expect(mockSent.filter(f => f.event === 'call.hangup')).toHaveLength(1);
  });

  it('still declines a genuinely un-answered ring from the Telecom sheet', async () => {
    const cache = loadCache();
    const onEnd = await bootAndGetOnEnd();

    cache.setIncomingCallPayload({callId: 'c-ring', callerName: 'A', kind: 'voice', fromUserId: 'u1'});
    mockSent.length = 0;

    onEnd('c-ring');

    const hangups = mockSent.filter(f => f.event === 'call.hangup');
    expect(hangups).toHaveLength(1);
    expect((hangups[0].data as Record<string, unknown>).reason).toBe('declined');
    expect(cache.isIncomingCallDead('c-ring')).toBe(true);
  });

  it('an End on the LIVE call still ends it (the registry branch is untouched)', async () => {
    const cache = loadCache();
    const onEnd = await bootAndGetOnEnd();
    const reg = require('@/modules/messenger/runtime/callRegistry') as {endActiveCall: jest.Mock};

    cache.setIncomingCallPayload({callId: 'c-up', callerName: 'A', kind: 'voice', fromUserId: 'u1'});
    mockActiveCall = {callId: 'c-up', state: 'connected'};
    mockSent.length = 0;

    onEnd('c-up');

    expect(reg.endActiveCall).toHaveBeenCalledWith('c-up', 'ended', 'remote');
    expect(mockSent.filter(f => f.event === 'call.hangup')).toHaveLength(0);
  });
});
