/**
 * WI-5.4 — every push-lane call-control send gets the durable fallback it
 * already has (transport G9).
 *
 * The live transport's send() THROWS on a disconnected socket ("transport not
 * open") — it never queues. But all four fcmBootstrap send sites guarded only
 * on `tx` TRUTHINESS: `getLiveTransport()` happily returns a non-null client
 * whose socket is down, the send throws, the outer catch logs… and the
 * `enqueuePendingAction` branch — sitting in the `else` of the truthiness
 * check — is never reached. The decline/hangup is silently lost and the
 * caller keeps ringing to timeout. The slim killed-app handler already does
 * this right (falsy return AND throw both enqueue — callNotification 827-843);
 * these are the rich-side lanes catching up.
 *
 * Sites under test:
 *   A `declineIncomingCallBestEffort` (null-controller ring teardown)
 *   B `sendCallHangup` via the Telecom onEnd decline branch
 *   C notifee GROUP decline (`sfu.ring.decline`)
 *   D notifee DIRECT decline (`call.hangup`)
 *
 * Also pinned: a THROWN send must not skip the local teardown that followed
 * it in the same try (cache clear + latch clear) — pre-fix, site A/C/D
 * unwound past all of it.
 */

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    async (k: string) => mockStore.get(k) ?? null,
    // Writes land a MACROTASK later — the real AsyncStorage shape. This is
    // what makes the awaited-vs-floated distinction observable: a handler
    // that FLOATS the enqueue resolves before the write lands, and the
    // immediate post-await read misses it (exactly what Android does to a
    // headless task that returns early).
    setItem:    async (k: string, v: string) => { await new Promise(r => setTimeout(r, 0)); mockStore.set(k, v); },
    removeItem: async (k: string) => { mockStore.delete(k); },
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
    getToken:                    jest.fn(async () => 'tok'),
    onTokenRefresh:              jest.fn(() => () => {}),
    onMessage:                   jest.fn(() => () => {}),
    setBackgroundMessageHandler: jest.fn(),
    requestPermission:           jest.fn(async () => 1),
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
    getDisplayedNotifications: jest.fn(async () => []),
  },
  AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2},
  AndroidCategory:   {MESSAGE: 'msg', CALL: 'call'},
  AndroidVisibility: {PRIVATE: 0, PUBLIC: 1},
  AndroidStyle:      {BIGTEXT: 1, MESSAGING: 2},
  EventType:         {PRESS: 1, ACTION_PRESS: 2},
}));
jest.mock('@navigation/navigationRef', () => ({
  navigationRef: {isReady: () => true, navigate: jest.fn(), getCurrentRoute: () => ({name: 'MessengerHome'})},
}));
jest.mock('../push/callKitBridge', () => ({
  setupCallKit:             jest.fn(async () => {}),
  subscribeToCallKitEvents: jest.fn((h: Record<string, unknown>) => { mockCallKitHandlers = h as never; return () => {}; }),
  bringAppToForeground:     jest.fn(),
  reportEnded:              jest.fn(),
  reportIncomingCall:       jest.fn(),
}));
jest.mock('../push/voipPush', () => ({startVoipPushBootstrap: jest.fn(async () => {})}));
jest.mock('../push/backgroundMessageNotifier', () => ({
  startBackgroundMessageNotifier: jest.fn(),
  stopBackgroundMessageNotifier:  jest.fn(),
}));
jest.mock('@/store/authStore', () => ({
  useAuthStore: {getState: () => ({user: {id: 'self-1'}})},
}));
jest.mock('@/modules/messenger/runtime/callRegistry', () => ({
  getActiveCall: () => null,
  endActiveCall: jest.fn(() => 'ended'),
  wasRecentlyEnded: () => false,
  onActiveCallChange: jest.fn(() => () => {}),
}));
jest.mock('@/modules/messenger/runtime/groupCallRegistry', () => ({
  getActiveGroupCall: () => null,
}));

/**
 * The transport under test: NON-NULL but its socket is down, so send()
 * throws — exactly what getLiveTransport() can legitimately return.
 */
let mockTxMode: 'throw' | 'ok' | 'null' = 'throw';
const mockSent: Array<Record<string, unknown>> = [];
jest.mock('@/modules/messenger/runtime/transportRegistry', () => ({
  getLiveTransport: () => (mockTxMode === 'null' ? null : {
    send: (f: Record<string, unknown>) => {
      if (mockTxMode === 'throw') { throw new Error('transport not open'); }
      mockSent.push(f);
    },
  }),
  waitForLiveTransport: async () => null,
}));

let mockCallKitHandlers: Record<string, (callId: string) => void> = {};

type Boot = typeof import('../push/fcmBootstrap');
type Cache = typeof import('../push/incomingCallCache');
type Pending = typeof import('../push/pendingActions');

function loadAll(): {boot: Boot; cache: Cache; pending: Pending} {
  return {
    boot:    require('../push/fcmBootstrap') as Boot,
    cache:   require('../push/incomingCallCache') as Cache,
    pending: require('../push/pendingActions') as Pending,
  };
}

// Only ACTION_PRESS is exercised here (the notification's Decline button);
// notifee's EventType.PRESS (body tap) has its own suite.
const ACTION_PRESS = 2;
type Ev = {type: number; detail: Record<string, unknown>};

async function bootAndGetBgHandler(boot: Boot): Promise<(e: Ev) => Promise<void>> {
  await boot.startFcmBootstrap();
  const nf = (require('@notifee/react-native') as {default: Record<string, jest.Mock>}).default;
  const calls = nf.onBackgroundEvent.mock.calls;
  return calls[calls.length - 1][0] as (e: Ev) => Promise<void>;
}

beforeEach(() => {
  jest.resetModules();
  mockStore.clear();
  mockSent.length = 0;
  mockTxMode = 'throw';
  mockCallKitHandlers = {};
});

/** The void-caller lanes float their enqueue by design — poll, bounded. */
async function waitForDeclines(pending: Pending, n: number, ms = 1_000): Promise<Array<Record<string, unknown>>> {
  const t0 = Date.now();
  for (;;) {
    const q = await declines(pending);
    if (q.length >= n || Date.now() - t0 > ms) {return q;}
    await new Promise(r => setTimeout(r, 10));
  }
}

async function declines(pending: Pending): Promise<Array<Record<string, unknown>>> {
  const list = await pending.loadPendingActions();
  return list.filter(a => a.t === 'decline') as never;
}

describe('WI-5.4 site A — declineIncomingCallBestEffort', () => {
  it('a THROWING send enqueues the durable decline and still clears the ring state', async () => {
    const {boot, cache, pending} = loadAll();
    cache._resetIncomingCallCacheForTests();
    cache.setIncomingCallPayload({callId: 'c-a1', callerName: 'A', kind: 'voice', fromUserId: 'peer-1'});
    boot.markCallAccepted('c-a1');

    boot.declineIncomingCallBestEffort('c-a1', 'declined');
    const q = await waitForDeclines(pending, 1);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({callId: 'c-a1', kind: 'direct', peerUserId: 'peer-1'});
    // The teardown that followed the send in the same try must still run.
    expect(cache.getIncomingCallPayload('c-a1')).toBeNull();
    expect(cache.isIncomingCallDead('c-a1')).toBe(true);
    expect(boot.wasCallExplicitlyAccepted('c-a1')).toBe(false);
  });

  it('a NULL transport also enqueues (parity with the throw path)', async () => {
    mockTxMode = 'null';
    const {boot, cache, pending} = loadAll();
    cache._resetIncomingCallCacheForTests();
    cache.setIncomingCallPayload({callId: 'c-a2', callerName: 'A', kind: 'voice', fromUserId: 'peer-1'});

    boot.declineIncomingCallBestEffort('c-a2');
    await new Promise(r => setTimeout(r, 20));

    expect(await declines(pending)).toHaveLength(1);
  });

  it("a dead-offer 'failed' teardown never degrades into a durable DECLINE (round 1 P2)", async () => {
    // NA-02 chose reason='failed' precisely so the caller/Telecom never hears
    // "declined" for a call that simply never connected — the durable lane
    // only speaks decline, so it must stay out of this path entirely.
    const {boot, cache, pending} = loadAll();
    cache._resetIncomingCallCacheForTests();
    cache.setIncomingCallPayload({callId: 'c-af', callerName: 'A', kind: 'voice', fromUserId: 'peer-1'});

    boot.declineIncomingCallBestEffort('c-af', 'failed');
    await new Promise(r => setTimeout(r, 20));

    expect(await declines(pending)).toHaveLength(0);
    // The local teardown still ran.
    expect(cache.isIncomingCallDead('c-af')).toBe(true);
  });

  it('a SUCCESSFUL send enqueues nothing', async () => {
    mockTxMode = 'ok';
    const {boot, cache, pending} = loadAll();
    cache._resetIncomingCallCacheForTests();
    cache.setIncomingCallPayload({callId: 'c-a3', callerName: 'A', kind: 'voice', fromUserId: 'peer-1'});

    boot.declineIncomingCallBestEffort('c-a3');
    await new Promise(r => setTimeout(r, 20));

    expect(mockSent.filter(f => f.event === 'call.hangup')).toHaveLength(1);
    expect(await declines(pending)).toHaveLength(0);
  });
});

describe('WI-5.4 site B — the Telecom onEnd decline lane (sendCallHangup)', () => {
  it('a THROWING send enqueues the durable decline', async () => {
    const {boot, cache, pending} = loadAll();
    await boot.startFcmBootstrap();
    cache._resetIncomingCallCacheForTests();
    cache.setIncomingCallPayload({callId: 'c-b1', callerName: 'A', kind: 'voice', fromUserId: 'peer-2'});

    expect(mockCallKitHandlers.onEnd).toBeDefined();
    mockCallKitHandlers.onEnd('c-b1'); // un-answered ring + Telecom End → decline
    const q = await waitForDeclines(pending, 1);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({callId: 'c-b1', kind: 'direct', peerUserId: 'peer-2'});
  });
});

describe('round 2 F-2 — sendCallHangup durable is declined-only (source scan; private fn)', () => {
  it('the site B durable arg is gated on reason === declined', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts'), 'utf8');
    // The lane only speaks decline; busy/ended/failed must degrade to
    // no-answer, never lie to the caller. (Site B is module-private, so
    // the non-declined reasons are not publicly drivable — pinned by scan.)
    expect(src).toMatch(/reason === 'declined' \? \{t: 'decline', callId, kind: 'direct', peerUserId: payload\.fromUserId\} : null/);
  });
});

describe('WI-5.4 sites C/D — the notifee decline branches', () => {
  it('GROUP: a THROWING sfu.ring.decline send enqueues and still tombstones', async () => {
    const {boot, cache, pending} = loadAll();
    cache._resetIncomingCallCacheForTests();
    const handle = await bootAndGetBgHandler(boot);
    cache.setIncomingCallPayload({callId: 'room-c1', callerName: 'H', kind: 'group-voice', roomId: 'room-c1', ringId: 'r1'});

    await handle({
      type:   ACTION_PRESS,
      detail: {
        notification: {id: 'bravo-call-room-c1', data: {callId: 'room-c1', kind: 'group-voice', isGroup: '1', roomId: 'room-c1', fromUserId: 'host-1'}},
        pressAction:  {id: 'decline-room-c1'},
      },
    });

    // Round 1 P1 — asserted IMMEDIATELY after the handler resolves, with no
    // extra yield: notifee kills the headless task when the handler settles,
    // so the durable write must already be on disk here. (The old pin slept
    // first, which let a floated write finish and pass vacuously.)
    const q = await declines(pending);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({callId: 'room-c1', kind: 'group', roomId: 'room-c1'});
    // The teardown after the send must still have run despite the throw.
    expect(cache.isIncomingCallDead('room-c1')).toBe(true);
  });

  it('DIRECT: a THROWING call.hangup send enqueues and still tombstones', async () => {
    const {boot, cache, pending} = loadAll();
    cache._resetIncomingCallCacheForTests();
    const handle = await bootAndGetBgHandler(boot);
    cache.setIncomingCallPayload({callId: 'c-d1', callerName: 'A', kind: 'voice', fromUserId: 'peer-3'});

    await handle({
      type:   ACTION_PRESS,
      detail: {
        notification: {id: 'bravo-call-c-d1', data: {callId: 'c-d1', kind: 'voice', fromUserId: 'peer-3'}},
        pressAction:  {id: 'decline-c-d1'},
      },
    });

    const q = await declines(pending);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({callId: 'c-d1', kind: 'direct', peerUserId: 'peer-3'});
    expect(cache.isIncomingCallDead('c-d1')).toBe(true);
  });

  it('GROUP + DIRECT: successful sends enqueue nothing (no double delivery)', async () => {
    mockTxMode = 'ok';
    const {boot, cache, pending} = loadAll();
    cache._resetIncomingCallCacheForTests();
    const handle = await bootAndGetBgHandler(boot);
    cache.setIncomingCallPayload({callId: 'c-d2', callerName: 'A', kind: 'voice', fromUserId: 'peer-3'});

    await handle({
      type:   ACTION_PRESS,
      detail: {
        notification: {id: 'bravo-call-c-d2', data: {callId: 'c-d2', kind: 'voice', fromUserId: 'peer-3'}},
        pressAction:  {id: 'decline-c-d2'},
      },
    });

    expect(mockSent.filter(f => f.event === 'call.hangup')).toHaveLength(1);
    expect(await declines(pending)).toHaveLength(0);
  });
});
