/**
 * WI-4.3 / WI-4.4 — the user's Answer INTENT must outlive everything that is
 * merely a routing accident.
 *
 * Two latches share one clear function today and that conflation is the bug:
 *
 *   acceptedCallIds   — "a navigation for this callId already happened".
 *                       Exists to stop a notifee Accept tap AND the Telecom
 *                       Answer event (they fire within ms on Android FSI) from
 *                       both mounting CallScreen and both sending call.answer.
 *   explicitAcceptIds — "the user pressed Answer". Read by MainNavigator's WS
 *                       offer navigation to RE-ASSERT autoAccept, because RN6
 *                       navigate() REPLACES params (B-102 A1).
 *
 * WI-4.3: the 20 s nav-readiness wait clears BOTH on abandon. The stated reason
 * ("don't leave the accept latch set for 5 min") is served entirely by the
 * first one. Dropping the second means a slow cold-launch navigator silently
 * downgrades the user's Answer to a plain ring — the offer replay that lands a
 * second later no longer knows an Answer was ever pressed.
 *
 * WI-4.4: `markAccepted` sits in the SHARED path, so a BODY tap burns the
 * answer dedupe. The subsequent real Answer then hits the "already accepted"
 * branch and returns without navigating and without autoAccept. Tapping the
 * notification to see who is calling therefore disables the Answer button.
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
    deleteChannel:          jest.fn(async () => {}),
    getDisplayedNotifications: jest.fn(async () => []),
  },
  AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2},
  AndroidCategory:   {MESSAGE: 'msg', CALL: 'call'},
  AndroidVisibility: {PRIVATE: 0, PUBLIC: 1},
  AndroidStyle:      {BIGTEXT: 1, MESSAGING: 2},
  EventType:         {PRESS: 1, ACTION_PRESS: 2},
}));

/** Nav readiness is the variable under test in the WI-4.3 cases. */
let mockNavReady = true;
const mockNav = jest.fn();
jest.mock('@navigation/navigationRef', () => ({
  navigationRef: {
    isReady:  () => mockNavReady,
    navigate: (n: string, p?: unknown) => mockNav(n, p),
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

const PRESS = 1;
const ACTION_PRESS = 2;

type Boot = typeof import('../push/fcmBootstrap');
function loadBootstrap(): Boot {
  return require('../push/fcmBootstrap') as Boot;
}
function nf(): Record<string, jest.Mock> {
  return (require('@notifee/react-native') as {default: Record<string, jest.Mock>}).default;
}

/** The rich handler is the LAST onBackgroundEvent registrar (survey-confirmed). */
type Ev = {type: number; detail: Record<string, unknown>};
async function bootAndGetBgHandler(): Promise<(e: Ev) => Promise<void>> {
  const boot = loadBootstrap();
  await boot.startFcmBootstrap();
  const calls = nf().onBackgroundEvent.mock.calls;
  return calls[calls.length - 1][0] as (e: Ev) => Promise<void>;
}

function ringNotification(callId: string): Record<string, unknown> {
  return {
    id:   `bravo-call-${callId}`,
    data: {callId, kind: 'voice', fromUserId: 'peer-1', conversationId: 'conv-1'},
  };
}

/** navigateToMessengerScreen nests params per shell level — walk to the leaf. */
function leafParams(p: unknown): Record<string, unknown> {
  let cur = p as Record<string, unknown>;
  while (cur && typeof cur === 'object' && cur.params && typeof cur.params === 'object') {
    cur = cur.params as Record<string, unknown>;
  }
  return cur ?? {};
}

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  mockStore.clear();
  mockNav.mockClear();
  mockNavReady = true;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('WI-4.3 — a navigation-readiness failure must not erase the Answer intent', () => {
  it('keeps wasCallExplicitlyAccepted true after the notifee Answer path abandons the route', async () => {
    mockNavReady = false;
    const boot = loadBootstrap();
    await boot.startFcmBootstrap();
    const calls = nf().onBackgroundEvent.mock.calls;
    const handle = calls[calls.length - 1][0] as (e: Ev) => Promise<void>;

    const p = handle({
      type:   ACTION_PRESS,
      detail: {notification: ringNotification('c-nav'), pressAction: {id: 'accept-c-nav'}},
    });
    // Burn the whole 20 s poll without the navigator ever becoming ready.
    await jest.advanceTimersByTimeAsync(21_000);
    await p;

    expect(mockNav).not.toHaveBeenCalled();
    // THE POINT: the nav was slow. The user still pressed Answer.
    expect(boot.wasCallExplicitlyAccepted('c-nav')).toBe(true);
  });

  it('still releases the navigate dedupe so a follow-up Answer can route', async () => {
    mockNavReady = false;
    const boot = loadBootstrap();
    await boot.startFcmBootstrap();
    const calls = nf().onBackgroundEvent.mock.calls;
    const handle = calls[calls.length - 1][0] as (e: Ev) => Promise<void>;

    const p1 = handle({
      type:   ACTION_PRESS,
      detail: {notification: ringNotification('c-retry'), pressAction: {id: 'accept-c-retry'}},
    });
    await jest.advanceTimersByTimeAsync(21_000);
    await p1;

    // Navigator finally mounts; the user presses Answer again.
    mockNavReady = true;
    await handle({
      type:   ACTION_PRESS,
      detail: {notification: ringNotification('c-retry'), pressAction: {id: 'accept-c-retry'}},
    });

    expect(mockNav).toHaveBeenCalled();
  });
});

describe('review round 1 P0 — the Answer intent is time-bounded', () => {
  it('the latch expires at the 5-min scrub — it can never auto-join a ring from an hour ago', async () => {
    // WI-4.6 made this latch a NAVIGATION INPUT keyed by roomId, and group
    // roomIds are REUSED across re-rings. An unbounded entry surviving a
    // failed Answer would silently auto-join the room's NEXT ring — a live
    // mic with no consent. The Map+scrub is the backstop; the terminal
    // lanes still clear explicitly.
    const boot = loadBootstrap();
    boot.markCallAccepted('room-ttl');
    expect(boot.wasCallExplicitlyAccepted('room-ttl')).toBe(true);
    jest.advanceTimersByTime(5 * 60_000 + 1_000);
    expect(boot.wasCallExplicitlyAccepted('room-ttl')).toBe(false);
  });
});

describe('WI-4.4 — a body tap must not consume the answer dedupe', () => {
  it('lets a real Answer navigate with autoAccept AFTER a body tap opened the ring', async () => {
    const handle = await bootAndGetBgHandler();

    // 1. Body tap — pressAction id is 'default', parseCallAction returns null.
    await handle({
      type:   PRESS,
      detail: {notification: ringNotification('c-body'), pressAction: {id: 'default'}},
    });
    expect(mockNav).toHaveBeenCalledTimes(1);
    const bodyParams = mockNav.mock.calls[0][1] as Record<string, unknown>;
    expect(bodyParams).toBeDefined();

    mockNav.mockClear();

    // 2. The user now presses the real Answer button.
    await handle({
      type:   ACTION_PRESS,
      detail: {notification: ringNotification('c-body'), pressAction: {id: 'accept-c-body'}},
    });

    // THE POINT: this must NOT be swallowed as "already accepted".
    expect(mockNav).toHaveBeenCalledTimes(1);
    expect(leafParams(mockNav.mock.calls[0][1]).autoAccept).toBe(true);
  });

  it('records the explicit accept even though a body tap came first', async () => {
    const boot = loadBootstrap();
    await boot.startFcmBootstrap();
    const calls = nf().onBackgroundEvent.mock.calls;
    const handle = calls[calls.length - 1][0] as (e: Ev) => Promise<void>;

    await handle({
      type:   PRESS,
      detail: {notification: ringNotification('c-latch'), pressAction: {id: 'default'}},
    });
    expect(boot.wasCallExplicitlyAccepted('c-latch')).toBe(false);

    await handle({
      type:   ACTION_PRESS,
      detail: {notification: ringNotification('c-latch'), pressAction: {id: 'accept-c-latch'}},
    });
    expect(boot.wasCallExplicitlyAccepted('c-latch')).toBe(true);
  });

  it('a SECOND body tap is still deduped (it must not re-navigate on every press)', async () => {
    const handle = await bootAndGetBgHandler();

    await handle({
      type:   PRESS,
      detail: {notification: ringNotification('c-dup'), pressAction: {id: 'default'}},
    });
    mockNav.mockClear();
    await handle({
      type:   PRESS,
      detail: {notification: ringNotification('c-dup'), pressAction: {id: 'default'}},
    });
    expect(mockNav).not.toHaveBeenCalled();
  });

  it('a duplicate Answer is still deduped (the have-local-offer wedge stays closed)', async () => {
    const handle = await bootAndGetBgHandler();

    await handle({
      type:   ACTION_PRESS,
      detail: {notification: ringNotification('c-two'), pressAction: {id: 'accept-c-two'}},
    });
    mockNav.mockClear();
    await handle({
      type:   ACTION_PRESS,
      detail: {notification: ringNotification('c-two'), pressAction: {id: 'accept-c-two'}},
    });
    expect(mockNav).not.toHaveBeenCalled();
  });

  it('a stale card event for a DEAD callId is dropped — no navigation, no latch (edge D1)', async () => {
    // A card-driven event can only be stale here: no lane draws a card for a
    // tombstoned id, so the card this tap came from predates the
    // decline/cancel that killed the call (queued notifee event).
    const handle = await bootAndGetBgHandler();
    const cache = require('../push/incomingCallCache') as typeof import('../push/incomingCallCache');
    cache._resetIncomingCallCacheForTests();
    cache.setIncomingCallPayload({callId: 'c-stale', callerName: 'A', kind: 'voice'});
    cache.clearIncomingCallPayload('c-stale'); // cancel/decline → tombstone

    await handle({
      type:   ACTION_PRESS,
      detail: {notification: ringNotification('c-stale'), pressAction: {id: 'accept-c-stale'}},
    });

    expect(mockNav).not.toHaveBeenCalled();
    const boot = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
    expect(boot.wasCallExplicitlyAccepted('c-stale')).toBe(false);
  });

  it('a stale group Answer after an END is dropped via the consumed-room marker (R2-1)', async () => {
    // END no longer tombstones (a reused roomId must stay ringable — B-502),
    // so the consumed-room marker is the ONLY thing standing between a
    // queued Answer event and a silent re-join of the room the user just
    // left. A fresh FCM seed self-heals the marker, so a genuine re-invite's
    // card still answers normally (asserted in groupRingCleanup).
    const handle = await bootAndGetBgHandler();
    const cache = require('../push/incomingCallCache') as typeof import('../push/incomingCallCache');
    cache._resetIncomingCallCacheForTests();
    cache.setIncomingCallPayload({callId: 'room-endz', callerName: 'H', kind: 'group-voice', roomId: 'room-endz'});
    cache.dropIncomingCallPayload('room-endz'); // the group END teardown shape

    await handle({
      type:   ACTION_PRESS,
      detail: {notification: ringNotification('room-endz'), pressAction: {id: 'accept-room-endz'}},
    });

    expect(mockNav).not.toHaveBeenCalled();
  });

  it('a body tap landing AFTER an Answer re-asserts autoAccept instead of clobbering it', async () => {
    const handle = await bootAndGetBgHandler();

    await handle({
      type:   ACTION_PRESS,
      detail: {notification: ringNotification('c-order'), pressAction: {id: 'accept-c-order'}},
    });
    mockNav.mockClear();

    // The full-screen intent's body press arrives second (Android FSI ordering).
    await handle({
      type:   PRESS,
      detail: {notification: ringNotification('c-order'), pressAction: {id: 'default'}},
    });

    // Either it is suppressed, or it navigates carrying autoAccept — never
    // navigates with autoAccept false, which is what un-answers the call.
    if (mockNav.mock.calls.length > 0) {
      expect(leafParams(mockNav.mock.calls[0][1]).autoAccept).toBe(true);
    }
  });
});
