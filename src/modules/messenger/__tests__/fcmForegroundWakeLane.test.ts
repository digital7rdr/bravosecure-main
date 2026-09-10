/**
 * The FOREGROUND FCM data-push lane — `messaging().onMessage` inside
 * startFcmBootstrap (push/fcmBootstrap.ts).
 *
 * setBackgroundMessageHandler only fires when the app is backgrounded or
 * killed, so this handler is the ONLY thing that sees a data push while the app
 * is on screen. Its branches were unexecuted (the existing suites either mock
 * onMessage away or scan the source for them), and three of them exist purely
 * because of field failures:
 *
 *   AC-3 / B-306 — a GROUP wake arriving in the foreground used to be dropped on
 *     the assumption that the live WS lane always presents the ring. The
 *     2026-07-27 two-device run disproved it: the WS lane's outcome can be lost
 *     (busy-1:1 race), leaving a notification card as the only trace — and a
 *     card cannot full-screen a foregrounded app. It is now re-dispatched
 *     through the ring dispatcher, whose roomId/ringId dedup makes it a no-op
 *     when the WS lane already presented.
 *   B-336 — the fan-out `ringId` must ride along, or this copy dedups against
 *     the wrong ring (or a genuinely new fan-out fails to present).
 *   P2-5 — call-cancel is handled in the foreground too, so a ring drawn while
 *     backgrounded stops the instant the caller gives up instead of running out
 *     its 45 s timeout after the app is foregrounded.
 *   B-107 — a msg-wake must NEVER boot the runtime while a restore holds
 *     (installIdentity + bundle publish → server wipes the OPK pool: the
 *     Round-8 data-loss class).
 *
 * addCallAuditPins.test.ts pins the group re-dispatch by INDEXING THE SOURCE
 * TEXT; this executes it and asserts the frame the dispatcher actually receives.
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
  AppState: {currentState: 'active', addEventListener: jest.fn(() => ({remove: jest.fn()}))},
}));
jest.mock('@utils/constants', () => ({MSG_BASE_URL: 'https://msg.test'}));
jest.mock('@services/api', () => ({refreshAccessTokenShared: jest.fn(async () => {})}), {virtual: true});
jest.mock('@react-native-firebase/messaging', () => {
  const api = {
    getToken:                    jest.fn(async () => 'tok-1'),
    onTokenRefresh:              jest.fn(() => () => {}),
    onMessage:                   jest.fn(() => () => {}),
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
    deleteChannel:          jest.fn(async () => {}),
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
jest.mock('../push/callKitBridge', () => ({
  setupCallKit:             jest.fn(async () => {}),
  teardownCallKit:          jest.fn(),
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
jest.mock('../push/mutedLookup', () => ({
  isConversationMuted:         jest.fn(async () => false),
  resolveDirectConversation:   jest.fn(async () => null),
  resolveConversationMeta:     jest.fn(async () => null),
  resolveDirectPeerName:       jest.fn(async () => null),
  resolveTotalUnread:          jest.fn(async () => null),
}));
jest.mock('../push/backgroundMessageNotifier', () => ({
  startBackgroundMessageNotifier:     jest.fn(),
  stopBackgroundMessageNotifier:      jest.fn(),
  isBackgroundMessageNotifierRunning: jest.fn(() => false),
  getMessagePostedGeneration:         jest.fn(() => 0),
  snapshotCues:                       jest.fn(() => ({gen: 0, failures: 0})),
  cueDeliveredSince:                  jest.fn(async () => false),
}));
jest.mock('../push/serverWakeNotifications', () => ({
  showServerWakeNotification: jest.fn(async () => true),
}));
jest.mock('@/modules/messenger/runtime', () => ({
  getMessengerRuntime: jest.fn(async () => ({pullEnvelopes: jest.fn(async () => {})})),
}));
jest.mock('@/modules/messenger/runtime/transportRegistry', () => ({getLiveTransport: () => null}));

const mockDispatcher = {dispatchGroupRingFrame: jest.fn((_frame: unknown) => true)};
jest.mock('@/modules/messenger/webrtc/groupCallRingDispatcher', () => mockDispatcher);

const mockDirectoryNames: Record<string, string> = {};
jest.mock('@/modules/messenger/store/messengerStore', () => ({
  useMessengerStore: {
    getState: () => ({conversations: {}, directoryNames: mockDirectoryNames, messages: {}}),
  },
}));

import messaging from '@react-native-firebase/messaging';
import {startFcmBootstrap} from '../push/fcmBootstrap';
import {dismissCallNotif} from '../push/callNotification';
import {showServerWakeNotification} from '../push/serverWakeNotifications';
import {getMessengerRuntime} from '@/modules/messenger/runtime';
import {setRestoreModeActive} from '../backup/restoreMode';

type FgHandler = (m: {data?: Record<string, string>}) => Promise<void>;

const dispatch    = mockDispatcher.dispatchGroupRingFrame;
const dismissRing = dismissCallNotif as jest.Mock;
const serverWake  = showServerWakeNotification as jest.Mock;
const getRuntime  = getMessengerRuntime as jest.Mock;

let fgHandler: FgHandler;
let pullMock: jest.Mock;

beforeAll(async () => {
  await startFcmBootstrap();
  fgHandler = ((messaging().onMessage as unknown as jest.Mock).mock.calls[0] as [FgHandler])[0];
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockDirectoryNames)) { delete mockDirectoryNames[k]; }
  pullMock = jest.fn(async () => {});
  getRuntime.mockImplementation(async () => ({pullEnvelopes: pullMock}));
  dispatch.mockImplementation(() => true);
  setRestoreModeActive(false);
});

const push = (data: Record<string, string>) => fgHandler({data});

describe('AC-3 / B-306 — a foreground GROUP wake is re-dispatched through the ring dispatcher', () => {
  it('builds an sfu.ring.incoming frame from the wake, carrying the B-336 ringId', async () => {
    mockDirectoryNames['host-1'] = 'Alice';

    await push({
      kind: 'voip-wake', callKind: 'group-video', callId: 'room-1',
      conversationId: 'conv-1', fromUserId: 'host-1', roomToken: 'tok-1', ringId: 'ring-7',
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      event: 'sfu.ring.incoming',
      data: {
        roomId:         'room-1',
        conversationId: 'conv-1',
        callType:       'video',
        // deviceId 0 marks "FCM lane, device unknown" — routing is by userId.
        from:           {userId: 'host-1', deviceId: 0},
        callerName:     'Alice',
        roomToken:      'tok-1',
        // Without the fan-out id this copy dedups against the wrong ring.
        ringId:         'ring-7',
      },
    });
  });

  it('a group-voice wake maps to callType voice and the generic label when the directory misses', async () => {
    await push({kind: 'voip-wake', callKind: 'group-voice', callId: 'room-2', fromUserId: 'host-9'});

    expect(dispatch).toHaveBeenCalledTimes(1);
    const frame = dispatch.mock.calls[0][0] as {data: Record<string, unknown>};
    expect(frame.data.callType).toBe('voice');
    // The wake carries no cleartext name by design; a generic label beats no ring.
    expect(frame.data.callerName).toBe('Bravo contact');
    expect(frame.data.conversationId).toBe('');
    expect(frame.data.roomToken).toBeUndefined();
    expect(frame.data.ringId).toBeUndefined();
  });

  it('B-504 — a group wake that fails HMAC verification never reaches the dispatcher', async () => {
    // Security S3: ring admission is HMAC-gated on EVERY lane. This was the
    // last asymmetry — the bg, headless and 1:1-rescue lanes all verified
    // before presenting, while this branch dispatched a full ring UI from an
    // unverified push payload.
    const {verifyVoipWake} = require('../push/voipWakeVerify') as {verifyVoipWake: jest.Mock};
    verifyVoipWake.mockResolvedValueOnce({ok: false, reason: 'sig'});

    await push({
      kind: 'voip-wake', callKind: 'group-voice', callId: 'room-forged',
      fromUserId: 'host-1', ringId: 'ring-9',
    });

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('B-504 — the verifier gets the signed fields and the real selfUserId', async () => {
    const {verifyVoipWake} = require('../push/voipWakeVerify') as {verifyVoipWake: jest.Mock};

    await push({
      kind: 'voip-wake', callKind: 'group-voice', callId: 'room-sig',
      fromUserId: 'host-1', nonce: 'n-1', exp: '1234', sig: 's-1',
    });

    expect(verifyVoipWake).toHaveBeenCalledTimes(1);
    expect(verifyVoipWake.mock.calls[0][0]).toEqual({
      selfUserId: 'self-1',
      fields: {kind: 'voip-wake', callId: 'room-sig', nonce: 'n-1', exp: 1234, sig: 's-1'},
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('B-504 — a throwing verifier fails CLOSED (no dispatch)', async () => {
    const {verifyVoipWake} = require('../push/voipWakeVerify') as {verifyVoipWake: jest.Mock};
    verifyVoipWake.mockRejectedValueOnce(new Error('keychain gone'));

    await push({kind: 'voip-wake', callKind: 'group-voice', callId: 'room-throw', fromUserId: 'host-1'});

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('a 1:1 voip-wake is NOT re-dispatched (the WS call.offer frame drives that UI)', async () => {
    await push({kind: 'voip-wake', callKind: 'voice', callId: 'call-1', fromUserId: 'peer-1'});
    await push({kind: 'voip-wake', callKind: 'video', callId: 'call-2', fromUserId: 'peer-1'});

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('a group wake with no callId cannot be dispatched and is dropped', async () => {
    await push({kind: 'voip-wake', callKind: 'group-voice', callId: '', fromUserId: 'host-1'});

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('a throwing dispatcher never propagates out of the push handler', async () => {
    dispatch.mockImplementation(() => { throw new Error('dispatcher down'); });

    await expect(push({kind: 'voip-wake', callKind: 'group-voice', callId: 'room-3'})).resolves.toBeUndefined();
  });

  it('a voip-wake never falls through to the runtime pull or the server-wake dispatcher', async () => {
    await push({kind: 'voip-wake', callKind: 'group-voice', callId: 'room-4'});

    expect(getRuntime).not.toHaveBeenCalled();
    expect(serverWake).not.toHaveBeenCalled();
  });
});

describe('P2-5 — call-cancel is handled in the foreground too', () => {
  it('dismisses the ring drawn while the app was backgrounded', async () => {
    await push({kind: 'call-cancel', callId: 'call-9'});

    expect(dismissRing).toHaveBeenCalledWith('call-9');
    expect(serverWake).not.toHaveBeenCalled();
  });
});

describe('msg-wake — nudge the pull, but never during a restore', () => {
  it('boots the runtime and pulls envelopes', async () => {
    await push({kind: 'msg-wake', conversationId: 'conv-1'});

    expect(getRuntime).toHaveBeenCalledWith('production');
    expect(pullMock).toHaveBeenCalledTimes(1);
    // Chat is already delivered live over the WS — the foreground lane draws
    // no banner of its own.
    expect(serverWake).not.toHaveBeenCalled();
  });

  it('B-107 — restore mode blocks the runtime boot entirely', async () => {
    setRestoreModeActive(true);
    await push({kind: 'msg-wake', conversationId: 'conv-1'});

    expect(getRuntime).not.toHaveBeenCalled();
    expect(pullMock).not.toHaveBeenCalled();
  });

  it('a runtime that fails to boot is swallowed (WS foreground delivery is the backstop)', async () => {
    getRuntime.mockImplementation(async () => { throw new Error('no runtime'); });

    await expect(push({kind: 'msg-wake', conversationId: 'conv-1'})).resolves.toBeUndefined();
  });
});

describe('every other server-driven wake goes through the shared dispatcher', () => {
  it('records the in-app bell row alongside the OS banner (N-18 warm path)', async () => {
    await push({kind: 'booking-approved', bookingId: 'b-1'});

    expect(serverWake).toHaveBeenCalledTimes(1);
    expect(serverWake).toHaveBeenCalledWith(
      {kind: 'booking-approved', bookingId: 'b-1'},
      {recordActivity: true},
    );
  });

  it('an opaque wake with no kind still reaches the dispatcher', async () => {
    await push({eventId: 'evt-1'});

    expect(serverWake).toHaveBeenCalledWith({eventId: 'evt-1'}, {recordActivity: true});
  });

  it('a dispatcher failure is contained', async () => {
    serverWake.mockImplementation(async () => { throw new Error('notifee down'); });

    await expect(push({kind: 'agent-approved'})).resolves.toBeUndefined();
  });
});
