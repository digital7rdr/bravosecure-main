/**
 * The killed/backgrounded VoIP-wake RING lane — the `setBackgroundMessageHandler`
 * branch in push/fcmBootstrap.ts that turns an FCM wake into a system ring.
 *
 * msgWakeWarmBannerRules.test.ts pins the msg-wake half of this handler and the
 * single "a forged wake draws nothing" case. Everything the lane does once a
 * wake VERIFIES was unexecuted, and it is the part with the interesting failure
 * modes — each of these was a shipped bug:
 *
 *   S3      — verification runs BEFORE any surface is raised; a replayed payload
 *             must ring neither notifee nor Telecom.
 *   §5      — the wake carries no cleartext caller name (by design), so the label
 *             is resolved from the LOCAL direct-conversation list; a miss stays
 *             the generic 'Bravo contact'.
 *   B-107   — no ring surfaces at all while a backup restore holds (the Round-8
 *             stranded-backup class).
 *   W4.2    — a wake for a DIFFERENT call while one is live must not raise a
 *             second system surface over the in-progress call; the same callId
 *             (the B-102 offer replay) must still fall through.
 *   tombstone — a caller retrying a declined callId must not repopulate the
 *             cache and re-ring.
 *   P1-BR-1 — group rings reuse the roomId as the callId and must thread the
 *             per-recipient roomToken through to the accept path.
 *   P2-5    — call-cancel tears down BOTH surfaces and tombstones the cache so a
 *             queued Accept cannot resurrect a dead call.
 *
 * The handler is registered as a module-top-level side effect, so it is captured
 * off the messaging mock (the fcmBootstrapOrder.test.ts trick).
 */

const mockAsyncStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    async (k: string) => mockAsyncStore.get(k) ?? null,
    setItem:    async (k: string, v: string) => { mockAsyncStore.set(k, v); },
    removeItem: async (k: string) => { mockAsyncStore.delete(k); },
  },
}));
jest.mock('react-native', () => ({
  Platform: {OS: 'android', Version: 33},
  PermissionsAndroid: {check: jest.fn(async () => true), request: jest.fn(async () => 'granted')},
  NativeModules: {},
  AppState: {currentState: 'background', addEventListener: jest.fn(() => ({remove: jest.fn()}))},
}));
jest.mock('@utils/constants', () => ({MSG_BASE_URL: 'https://msg.test'}));
jest.mock('@services/api', () => ({refreshAccessTokenShared: jest.fn(async () => {})}), {virtual: true});
jest.mock('@react-native-firebase/messaging', () => {
  const api = {
    getToken:                    jest.fn(async () => 'tok-1'),
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
    displayNotification: jest.fn(async () => 'nid'),
    cancelNotification:  jest.fn(async () => {}),
    createChannel:       jest.fn(async () => 'ch'),
    deleteChannel:       jest.fn(async () => {}),
    onForegroundEvent:   jest.fn(),
    onBackgroundEvent:   jest.fn(),
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
jest.mock('../push/callKitBridge', () => ({
  setupCallKit:             jest.fn(async () => {}),
  subscribeToCallKitEvents: jest.fn(() => () => {}),
  bringAppToForeground:     jest.fn(),
  reportEnded:              jest.fn(),
  reportIncomingCall:       jest.fn(),
}));
jest.mock('../push/voipPush', () => ({startVoipPushBootstrap: jest.fn(async () => {})}));
jest.mock('../push/voipWakeVerify', () => ({
  verifyVoipWake: jest.fn(async () => ({ok: true, reason: 'verified'})),
}));
jest.mock('../push/callNotification', () => ({
  showMessageNotif:      jest.fn(async () => {}),
  dismissMessageNotif:   jest.fn(async () => {}),
  showIncomingCallNotif: jest.fn(async () => {}),
  dismissCallNotif:      jest.fn(async () => {}),
  showMissedCallNotif:   jest.fn(async () => {}),
  markReplyQueued:       jest.fn(async () => {}),
}));
jest.mock('../push/mutedLookup', () => ({
  isConversationMuted:         jest.fn(async () => false),
  resolveDirectConversation:   jest.fn(async () => null),
  resolveDirectConversationId: jest.fn(async () => null),
  resolveConversationMeta:     jest.fn(async () => null),
  resolveDirectPeerName:       jest.fn(async () => null),
  resolveTotalUnread:          jest.fn(async () => null),
  conversationExists:          jest.fn(async () => false),
}));
jest.mock('../push/backgroundMessageNotifier', () => ({
  startBackgroundMessageNotifier:     jest.fn(),
  stopBackgroundMessageNotifier:      jest.fn(),
  isBackgroundMessageNotifierRunning: jest.fn(() => false),
  getMessagePostedGeneration:         jest.fn(() => 0),
  snapshotCues:                       jest.fn(() => ({gen: 0, failures: 0})),
  cueDeliveredSince:                  jest.fn(async () => false),
  setContentPreviewEnabled:           jest.fn(),
}));
jest.mock('@/modules/messenger/runtime', () => ({
  getMessengerRuntime: jest.fn(async () => ({pullEnvelopes: jest.fn(async () => {})})),
}));
jest.mock('@/modules/messenger/runtime/transportRegistry', () => ({getLiveTransport: () => null}));

const mockCallRegistry  = {getActiveCall:      jest.fn(() => null as {callId: string} | null)};
const mockGroupRegistry = {getActiveGroupCall: jest.fn(() => null as {roomId: string} | null)};
jest.mock('@/modules/messenger/runtime/callRegistry', () => mockCallRegistry);
jest.mock('@/modules/messenger/runtime/groupCallRegistry', () => mockGroupRegistry);

type Conv = {type: string; name?: string; peer?: {userId: string}};
const mockConversations: Record<string, Conv> = {};
jest.mock('@/modules/messenger/store/messengerStore', () => ({
  useMessengerStore: {getState: () => ({conversations: mockConversations, directoryNames: {}, messages: {}})},
}));

import '../push/fcmBootstrap'; // registers the bg handler as a top-level side effect
import messaging from '@react-native-firebase/messaging';
import {reportIncomingCall, reportEnded} from '../push/callKitBridge';
import {showIncomingCallNotif, dismissCallNotif, showMissedCallNotif} from '../push/callNotification';
import {verifyVoipWake} from '../push/voipWakeVerify';
import {resolveDirectPeerName} from '../push/mutedLookup';
import * as cache from '../push/incomingCallCache';
import {setRestoreModeActive} from '../backup/restoreMode';

type BgHandler = (m: {data?: Record<string, string>}) => Promise<void>;
const bgHandler = ((messaging().setBackgroundMessageHandler as unknown as jest.Mock)
  .mock.calls[0] as [BgHandler])[0];

const telecomRing  = reportIncomingCall as jest.Mock;
const telecomEnded = reportEnded as jest.Mock;
const showRing     = showIncomingCallNotif as jest.Mock;
const dismissRing  = dismissCallNotif as jest.Mock;
const showMissed   = showMissedCallNotif as jest.Mock;
const verify       = verifyVoipWake as jest.Mock;
const peerName     = resolveDirectPeerName as jest.Mock;

const wake = (data: Record<string, string>) => bgHandler({data});

beforeEach(() => {
  jest.clearAllMocks();
  cache._resetIncomingCallCacheForTests();
  for (const k of Object.keys(mockConversations)) { delete mockConversations[k]; }
  mockCallRegistry.getActiveCall.mockImplementation(() => null);
  mockGroupRegistry.getActiveGroupCall.mockImplementation(() => null);
  verify.mockImplementation(async () => ({ok: true, reason: 'verified'}));
  peerName.mockImplementation(async () => null);
  setRestoreModeActive(false);
});

describe('a verified 1:1 voip-wake raises both ring surfaces', () => {
  it('seeds the incoming-call cache, then rings Telecom AND notifee with the same callId', async () => {
    await wake({
      kind: 'voip-wake', callId: 'call-1', callKind: 'voice',
      fromUserId: 'peer-1', conversationId: 'conv-1',
    });

    // The cache is seeded BEFORE any UI, so an instant heads-up Answer tap
    // (which can beat the notifee render) finds the payload.
    expect(cache.getIncomingCallPayload('call-1')).toMatchObject({
      callId: 'call-1', kind: 'voice', fromUserId: 'peer-1', conversationId: 'conv-1',
    });
    // 1:1 → no roomId. Setting one here would make the accept path try to
    // sfu.join a room that does not exist.
    expect(cache.getIncomingCallPayload('call-1')?.roomId).toBeUndefined();

    expect(telecomRing).toHaveBeenCalledWith({callId: 'call-1', callerName: 'Bravo contact', kind: 'voice'});
    expect(showRing).toHaveBeenCalledTimes(1);
    expect(showRing.mock.calls[0][0]).toMatchObject({callId: 'call-1', kind: 'voice', conversationId: 'conv-1'});
  });

  it('§5 — labels the ring from the LOCAL direct conversation, never from the wire', async () => {
    mockConversations['c-1'] = {type: 'direct', name: 'Alice', peer: {userId: 'peer-1'}};
    mockConversations['c-2'] = {type: 'group',  name: 'Ops',   peer: {userId: 'peer-1'}};

    await wake({kind: 'voip-wake', callId: 'call-2', callKind: 'video', fromUserId: 'peer-1'});

    expect(telecomRing).toHaveBeenCalledWith({callId: 'call-2', callerName: 'Alice', kind: 'video'});
    expect(showRing.mock.calls[0][0].callerName).toBe('Alice');
  });

  it('falls back to the generic label when no local conversation matches the sender', async () => {
    mockConversations['c-1'] = {type: 'direct', name: 'Alice', peer: {userId: 'someone-else'}};

    await wake({kind: 'voip-wake', callId: 'call-3', fromUserId: 'peer-unknown'});

    expect(telecomRing).toHaveBeenCalledWith({callId: 'call-3', callerName: 'Bravo contact', kind: 'voice'});
  });

  it('coerces an unrecognised callKind to voice rather than passing it through', async () => {
    await wake({kind: 'voip-wake', callId: 'call-4', callKind: 'hologram'});

    expect(cache.getIncomingCallPayload('call-4')?.kind).toBe('voice');
    expect(showRing.mock.calls[0][0].kind).toBe('voice');
  });

  it('threads the signed fields to the verifier, coercing a string exp to a number', async () => {
    await wake({kind: 'voip-wake', callId: 'call-5', nonce: 'n-5', exp: '1700000000', sig: 'sig-5'});

    expect(verify).toHaveBeenCalledWith({
      selfUserId: 'self-1',
      fields: {kind: 'voip-wake', callId: 'call-5', nonce: 'n-5', exp: 1700000000, sig: 'sig-5'},
    });
  });
});

describe('group rings (P1-BR-1)', () => {
  it('reuses the callId as the roomId and carries the per-recipient roomToken', async () => {
    await wake({
      kind: 'voip-wake', callId: 'room-9', callKind: 'group-video',
      conversationId: 'conv-g', roomToken: 'tok-abc', fromUserId: 'host-1',
    });

    expect(cache.getIncomingCallPayload('room-9')).toMatchObject({
      roomId: 'room-9', roomToken: 'tok-abc', kind: 'group-video', conversationId: 'conv-g',
    });
    // Telecom only knows voice/video — the group variants collapse.
    expect(telecomRing).toHaveBeenCalledWith({callId: 'room-9', callerName: 'Bravo contact', kind: 'video'});
    // notifee keeps the full kind so the tap opens the GROUP ring screen.
    expect(showRing.mock.calls[0][0]).toMatchObject({kind: 'group-video', roomId: 'room-9', roomToken: 'tok-abc'});
  });

  it('a group-voice wake collapses to a voice Telecom display', async () => {
    await wake({kind: 'voip-wake', callId: 'room-10', callKind: 'group-voice'});

    expect(telecomRing).toHaveBeenCalledWith({callId: 'room-10', callerName: 'Bravo contact', kind: 'voice'});
    expect(showRing.mock.calls[0][0].kind).toBe('group-voice');
  });
});

describe('gates that must silence the ring entirely', () => {
  it('S3 — a failed verification raises NEITHER surface and writes no cache entry', async () => {
    verify.mockImplementation(async () => ({ok: false, reason: 'replay'}));

    await wake({kind: 'voip-wake', callId: 'call-replay', sig: 'captured', nonce: 'n', exp: '1'});

    expect(telecomRing).not.toHaveBeenCalled();
    expect(showRing).not.toHaveBeenCalled();
    expect(cache.getIncomingCallPayload('call-replay')).toBeNull();
  });

  it('B-107 — restore mode blocks the ring before anything is cached', async () => {
    setRestoreModeActive(true);

    await wake({kind: 'voip-wake', callId: 'call-restore', fromUserId: 'peer-1'});

    expect(telecomRing).not.toHaveBeenCalled();
    expect(showRing).not.toHaveBeenCalled();
    expect(cache.getIncomingCallPayload('call-restore')).toBeNull();

    // Control: the same wake rings once restore lifts.
    setRestoreModeActive(false);
    await wake({kind: 'voip-wake', callId: 'call-restore-2', fromUserId: 'peer-1'});
    expect(showRing).toHaveBeenCalledTimes(1);
  });

  it('W4.2 — a wake for a DIFFERENT call is suppressed while a 1:1 call is live', async () => {
    mockCallRegistry.getActiveCall.mockImplementation(() => ({callId: 'live-call'}));

    await wake({kind: 'voip-wake', callId: 'other-call'});

    expect(telecomRing).not.toHaveBeenCalled();
    expect(showRing).not.toHaveBeenCalled();
  });

  it('W4.2 — a wake for the call being answered (same id) still falls through', async () => {
    // B-102 replays the offer for the call in progress; suppressing that would
    // break the answer path itself.
    mockCallRegistry.getActiveCall.mockImplementation(() => ({callId: 'live-call'}));

    await wake({kind: 'voip-wake', callId: 'live-call'});

    expect(showRing).toHaveBeenCalledTimes(1);
  });

  it('W4.2 — a live GROUP call suppresses a wake for a different room', async () => {
    mockGroupRegistry.getActiveGroupCall.mockImplementation(() => ({roomId: 'live-room'}));

    await wake({kind: 'voip-wake', callId: 'other-room', callKind: 'group-voice'});
    expect(showRing).not.toHaveBeenCalled();

    await wake({kind: 'voip-wake', callId: 'live-room', callKind: 'group-voice'});
    expect(showRing).toHaveBeenCalledTimes(1);
  });

  it('a tombstoned callId (caller retrying after a decline) never re-rings', async () => {
    // Declining tombstones the id in the cache.
    cache.setIncomingCallPayload({callId: 'call-dead', callerName: 'Alice', kind: 'voice'});
    cache.clearIncomingCallPayload('call-dead');

    await wake({kind: 'voip-wake', callId: 'call-dead', fromUserId: 'peer-1'});

    // Repopulating would expose the stale SDP from the first attempt.
    expect(showRing).not.toHaveBeenCalled();
    expect(telecomRing).not.toHaveBeenCalled();
  });
});

describe('P2-5 — call-cancel teardown', () => {
  it('dismisses notifee, ends the Telecom display and tombstones the cache', async () => {
    cache.setIncomingCallPayload({callId: 'call-c1', callerName: 'Alice', kind: 'voice'});

    await wake({kind: 'call-cancel', callId: 'call-c1'});

    expect(dismissRing).toHaveBeenCalledWith('call-c1');
    expect(telecomEnded).toHaveBeenCalledWith('call-c1', 'remoteEnded');
    expect(cache.getIncomingCallPayload('call-c1')).toBeNull();
    // Not "missed" — the caller cancelling an already-handled call leaves no trace.
    expect(showMissed).not.toHaveBeenCalled();

    // The tombstone survives: a re-wake for the cancelled id cannot resurrect it.
    await wake({kind: 'voip-wake', callId: 'call-c1', fromUserId: 'peer-1'});
    expect(showRing).not.toHaveBeenCalled();
  });

  it('missed=1 leaves a Missed-call trace labelled with the resolved peer name', async () => {
    peerName.mockImplementation(async () => 'Alice');

    await wake({kind: 'call-cancel', callId: 'call-c2', missed: '1', fromUserId: 'peer-1', callKind: 'video'});

    expect(showMissed).toHaveBeenCalledWith({
      callId: 'call-c2', callerName: 'Alice', fromUserId: 'peer-1', kind: 'video',
    });
  });

  it('prefers an explicit callerName on the wake over a directory lookup', async () => {
    await wake({kind: 'call-cancel', callId: 'call-c3', missed: '1', fromUserId: 'peer-1', callerName: 'Bob'});

    expect(peerName).not.toHaveBeenCalled();
    expect(showMissed).toHaveBeenCalledWith(
      expect.objectContaining({callerName: 'Bob', kind: 'voice'}),
    );
  });

  it('a call-cancel with no callId is ignored (no surface is touched)', async () => {
    await wake({kind: 'call-cancel'});

    expect(dismissRing).not.toHaveBeenCalled();
    expect(telecomEnded).not.toHaveBeenCalled();
    expect(showMissed).not.toHaveBeenCalled();
  });
});
