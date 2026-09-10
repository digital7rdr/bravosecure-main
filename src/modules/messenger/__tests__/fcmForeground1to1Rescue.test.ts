/**
 * WI-4.10 — the foreground FCM lane rescues a 1:1 ring the way it already
 * rescues a group ring.
 *
 * AC-3 gave GROUP wakes a foreground rescue (re-dispatch through the ring
 * dispatcher, dedup makes it a no-op when the WS lane presented). The 1:1
 * branch kept the old assumption — "the WS call.offer frame drives that UI" —
 * which is the exact assumption the group fix was built on disproving: the
 * WS lane's outcome can be lost (socket mid-reconnect, frame dropped), and
 * then a caller rings a user who is LOOKING AT THE APP and sees nothing.
 *
 * The rescue mirrors the background wake lane, gates first:
 *   verify HMAC → restore gate → busy gate → already-presented dedup
 *   (CallScreen route / registry / tombstone) → cache seed (merge) →
 *   Telecom report + notifee card.
 * The card + Telecom surface dedup by callId, and the SDP-carrying WS offer
 * merges over the seed whenever it does arrive — nothing double-presents.
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
    onBackgroundEvent:      jest.fn(),
    onForegroundEvent:      jest.fn(),
    getInitialNotification: jest.fn(async () => null),
    displayNotification:    jest.fn(async () => {}),
    cancelNotification:     jest.fn(async () => {}),
    createChannel:          jest.fn(async () => 'ch'),
    getDisplayedNotifications: jest.fn(async () => []),
  },
  AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2},
  AndroidCategory:   {MESSAGE: 'msg', CALL: 'call'},
  AndroidVisibility: {PRIVATE: 0, PUBLIC: 1},
  AndroidStyle:      {BIGTEXT: 1, MESSAGING: 2},
  EventType:         {PRESS: 1, ACTION_PRESS: 2},
}));

let mockRoute: {name: string; params?: Record<string, unknown>} | undefined;
jest.mock('@navigation/navigationRef', () => ({
  navigationRef: {
    isReady: () => true,
    navigate: jest.fn(),
    getCurrentRoute: () => mockRoute,
  },
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

let mockVerifyOk = true;
jest.mock('../push/voipWakeVerify', () => ({
  verifyVoipWake: jest.fn(async () => (mockVerifyOk ? {ok: true} : {ok: false, reason: 'sig'})),
}));
jest.mock('@/store/authStore', () => ({
  useAuthStore: {getState: () => ({user: {id: 'self-1'}})},
}));
jest.mock('@/modules/messenger/store/messengerStore', () => ({
  useMessengerStore: {getState: () => ({conversations: {}, directoryNames: {}})},
}));

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

// jest.resetModules() re-runs every mock factory, so read the LIVE instances
// (the fcmBootstrapOrder lesson) — a top-level import pins the stale ones.
function nf(): Record<string, jest.Mock> {
  return (require('@notifee/react-native') as {default: Record<string, jest.Mock>}).default;
}
function liveBridge(): Record<string, jest.Mock> {
  return require('../push/callKitBridge') as Record<string, jest.Mock>;
}

type OnMessage = (msg: {data: Record<string, string>}) => Promise<void>;
async function bootAndGetOnMessage(): Promise<OnMessage> {
  const boot = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
  await boot.startFcmBootstrap();
  const api = (require('@react-native-firebase/messaging') as {default: () => Record<string, jest.Mock>}).default();
  return api.onMessage.mock.calls.at(-1)![0] as OnMessage;
}
function cache(): typeof import('../push/incomingCallCache') {
  return require('../push/incomingCallCache') as typeof import('../push/incomingCallCache');
}

const WAKE = {kind: 'voip-wake', callId: 'c-fg1', callKind: 'voice', fromUserId: 'u-caller', conversationId: 'conv-1'};

beforeEach(() => {
  jest.resetModules();
  mockAsyncStore.clear();


  mockVerifyOk = true;
  mockActiveCall = null;
  mockRoute = {name: 'MessengerHome'};
});

describe('WI-4.10 — foreground 1:1 voip-wake rescue', () => {
  it('presents the ring when the WS lane never did (card + Telecom + cache seed)', async () => {
    const onMessage = await bootAndGetOnMessage();
    await onMessage({data: WAKE});
    expect(liveBridge().reportIncomingCall).toHaveBeenCalledTimes(1);
    expect(liveBridge().reportIncomingCall.mock.calls[0][0]).toMatchObject({callId: 'c-fg1', kind: 'voice'});
    expect(nf().displayNotification.mock.calls.some(c => c[0].id === 'bravo-call-c-fg1')).toBe(true);
    expect(cache().getIncomingCallPayload('c-fg1')).not.toBeNull();
  });

  it('SKIPS when CallScreen is already up — the WS lane presented', async () => {
    mockRoute = {name: 'CallScreen', params: {callId: 'c-fg1'}};
    const onMessage = await bootAndGetOnMessage();
    await onMessage({data: WAKE});
    expect(liveBridge().reportIncomingCall).not.toHaveBeenCalled();
    expect(nf().displayNotification.mock.calls.some(c => c[0]?.id === 'bravo-call-c-fg1')).toBe(false);
  });

  it('SKIPS when the registry already holds this call (answered mid-flight)', async () => {
    mockActiveCall = {callId: 'c-fg1', state: 'connecting'};
    const onMessage = await bootAndGetOnMessage();
    await onMessage({data: WAKE});
    expect(liveBridge().reportIncomingCall).not.toHaveBeenCalled();
  });

  it('SUPPRESSES when busy on a DIFFERENT call (the in-call banner owns busy)', async () => {
    mockActiveCall = {callId: 'c-other', state: 'connected'};
    const onMessage = await bootAndGetOnMessage();
    await onMessage({data: WAKE});
    expect(liveBridge().reportIncomingCall).not.toHaveBeenCalled();
    expect(nf().displayNotification.mock.calls.some(c => c[0]?.id === 'bravo-call-c-fg1')).toBe(false);
  });

  it('REFUSES a tombstoned callId (declined / cancelled — dedup preserved)', async () => {
    const onMessage = await bootAndGetOnMessage();
    cache().setIncomingCallPayload({callId: 'c-fg1', callerName: 'X', kind: 'voice'});
    cache().clearIncomingCallPayload('c-fg1');
    await onMessage({data: WAKE});
    expect(liveBridge().reportIncomingCall).not.toHaveBeenCalled();
    expect(nf().displayNotification.mock.calls.some(c => c[0]?.id === 'bravo-call-c-fg1')).toBe(false);
  });

  it('DROPS a wake that fails HMAC verification (authentication not weakened)', async () => {
    mockVerifyOk = false;
    const onMessage = await bootAndGetOnMessage();
    await onMessage({data: WAKE});
    expect(liveBridge().reportIncomingCall).not.toHaveBeenCalled();
    expect(cache().getIncomingCallPayload('c-fg1')).toBeNull();
  });

  it('the group re-dispatch branch is untouched — a group wake still routes to the dispatcher, not this lane', async () => {
    const onMessage = await bootAndGetOnMessage();
    await onMessage({data: {kind: 'voip-wake', callId: 'room-1', callKind: 'group-voice', fromUserId: 'u-h'}});
    // The group lane never raises the notifee card from onMessage.
    expect(nf().displayNotification.mock.calls.some(c => c[0]?.id === 'bravo-call-room-1')).toBe(false);
  });
});
