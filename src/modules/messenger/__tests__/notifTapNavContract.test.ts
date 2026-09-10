/**
 * Notification tap → navigation param contract (msg-wake + missed-call).
 *
 * B-54 — a notification tap crashed ChatScreen because the Chat route's
 *        REQUIRED `name` param was missing (`initials(undefined)`).
 * B-85 — `initial: false` is LOAD-BEARING on every nested Chat deep-link:
 *        without it React Navigation seeds [Chat] alone and hardware-back
 *        bubbles out to the Dashboard instead of MessengerHome.
 * M-05 — a tap must never mint a phantom Chat for a conversation that does
 *        not exist locally; it degrades to MessengerHome.
 * P1-7 — a Missed-call banner carries a callId but must NEVER fall through
 *        to the incoming-call branch (that opened a GHOST CallScreen for a
 *        call that is already over).
 * N-07/N-08/N-09 — name resolves store-first, then the persisted owner
 *        slice, then '' as last resort; isGroup is true for `group` AND
 *        `ops_channel`; the tap waits for the navigator on a cold launch.
 *
 * Drives the REAL notifee event handler installed by fcmBootstrap (same
 * harness as fcmBootstrapOrder.test.ts) with the real messengerStore, plus
 * two static source scans for the branch-ordering rules no mock can pin.
 *
 * Known-broken behaviours are pinned GREEN as `DOCUMENTS PENDING(...)` per
 * the repo bug-regression contract — the fix commit flips those assertions.
 */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

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
  AppState: {currentState: 'active', addEventListener: jest.fn(() => ({remove: jest.fn()}))},
}));
jest.mock('@utils/constants', () => ({MSG_BASE_URL: 'https://msg.test'}));
jest.mock('@services/api', () => ({refreshAccessTokenShared: jest.fn(async () => {})}), {virtual: true});

jest.mock('@react-native-firebase/messaging', () => {
  const api = {
    getToken:                    jest.fn(() => new Promise(() => { /* never settles */ })),
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
    onBackgroundEvent:      jest.fn(),
    onForegroundEvent:      jest.fn(),
    getInitialNotification: jest.fn(async () => null),
    displayNotification:    jest.fn(async () => {}),
    cancelNotification:     jest.fn(async () => {}),
    createChannel:          jest.fn(async () => 'ch'),
    deleteChannel:          jest.fn(async () => {}),
  },
  AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2},
  AndroidCategory:   {MESSAGE: 'msg', CALL: 'call'},
  AndroidVisibility: {PRIVATE: 0, PUBLIC: 1},
  AndroidStyle:      {BIGTEXT: 1, MESSAGING: 2},
  EventType:         {PRESS: 1, ACTION_PRESS: 2},
}));

// Nav mock records whether the container was READY at the instant of each
// navigate() — in prod, navigate on a non-ready ref is a silent no-op, so a
// `false` here means the deep-link intent was dropped on device.
let mockNavReadyFlag = true;
const mockNavigate = jest.fn();
const mockNavReadyAtCall: boolean[] = [];
jest.mock('@navigation/navigationRef', () => ({
  navigationRef: {
    isReady: () => mockNavReadyFlag,
    navigate: (name: string, params?: unknown) => {
      mockNavReadyAtCall.push(mockNavReadyFlag);
      mockNavigate(name, params);
    },
  },
}));

jest.mock('../push/callKitBridge', () => ({
  setupCallKit:             jest.fn(async () => {}),
  subscribeToCallKitEvents: jest.fn(() => () => {}),
  bringAppToForeground:     jest.fn(),
  reportEnded:              jest.fn(),
}));
jest.mock('../push/voipPush', () => ({startVoipPushBootstrap: jest.fn(async () => {})}));
jest.mock('../push/backgroundMessageNotifier', () => ({
  startBackgroundMessageNotifier: jest.fn(),
  stopBackgroundMessageNotifier:  jest.fn(),
}));
jest.mock('@/modules/messenger/runtime/transportRegistry', () => ({getLiveTransport: () => null}));

// B-325 — the tap handler kicks a guarded runtime boot + envelope pull at TAP
// time; B-324 — a guessed banner waits on that pull to re-route. Mock the
// runtime so tests control what the pull ingests.
const mockPullEnvelopes = jest.fn(async (): Promise<void> => {});
const mockSendText = jest.fn(async (_c: string, _t: string): Promise<void> => {});
const mockMarkRead = jest.fn();
jest.mock('@/modules/messenger/runtime', () => ({
  getMessengerRuntime: jest.fn(async () => ({pullEnvelopes: mockPullEnvelopes, sendText: mockSendText, markRead: mockMarkRead})),
}));
jest.mock('@/modules/messenger/backup/restoreMode', () => ({isRestoreModeActive: () => false}));

const mockResolveDirectConversation =
  jest.fn(async (_userId: string): Promise<{id: string; name?: string} | null> => null);
const mockResolveConversationMeta =
  jest.fn(async (_conversationId: string): Promise<{name?: string; isGroup: boolean} | null> => null);
jest.mock('../push/mutedLookup', () => ({
  isConversationMuted:         jest.fn(async () => false),
  resolveDirectConversationId: jest.fn(async () => null),
  resolveDirectConversation:   (userId: string) => mockResolveDirectConversation(userId),
  resolveDirectPeerName:       jest.fn(async () => null),
  resolveConversationMeta:     (conversationId: string) => mockResolveConversationMeta(conversationId),
  conversationExists:          jest.fn(async () => false),
}));

import type {LocalConversation} from '../store/types';

const PRESS = 1;
type Handler = (ev: unknown) => Promise<void>;

function tap(data: Record<string, string>, pressId = 'default'): unknown {
  return {type: PRESS, detail: {notification: {data}, pressAction: {id: pressId}}};
}

/** Read the LIVE notifee mock instance out of the module registry. */
function nf(): Record<string, jest.Mock> {
  return (require('@notifee/react-native') as {default: Record<string, jest.Mock>}).default;
}

/**
 * Boot ONCE per file (module re-execution costs ~5 s per resetModules).
 * Safe to share: the tap paths under test read no module-scope latch
 * (`markAccepted` is call-branch only), and every mock/store is re-seeded
 * in beforeEach.
 */
async function bootHandler(): Promise<Handler> {
  const boot = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
  await boot.startFcmBootstrap();
  const calls = nf().onBackgroundEvent.mock.calls;
  return calls[calls.length - 1][0] as Handler;
}

let handler: Handler;

/**
 * Load the real messengerStore and seed it. The persist middleware
 * rehydrates async on first require — settle its microtask chain FIRST,
 * because its custom merge replaces `conversations` and would wipe rows
 * seeded before rehydration lands.
 */
async function seedStore(convs: Array<Partial<LocalConversation> & {id: string}>): Promise<void> {
  const {useMessengerStore} = require('../store/messengerStore') as
    typeof import('../store/messengerStore');
  for (let i = 0; i < 20; i++) { await Promise.resolve(); }
  const s = useMessengerStore.getState();
  s.reset();
  s.setOwner('owner-1');
  for (const c of convs) {
    s.upsertConversation({
      type:          'direct',
      participants:  ['peer-1'],
      unread_count:  0,
      is_muted:      false,
      created_at:    '2026-07-24T00:00:00.000Z',
      peer:          {userId: 'peer-1', deviceId: 1},
      session_state: 'established',
      ...c,
    } as LocalConversation);
  }
}

function navCallParams(i: number): {screen?: string; initial?: boolean; params?: Record<string, unknown>} {
  const arg = mockNavigate.mock.calls[i][1] as {params?: {screen?: string; initial?: boolean; params?: Record<string, unknown>}};
  return arg.params ?? {};
}

beforeAll(async () => {
  // Fake timers BEFORE boot: the push-register path arms a real 10 s abort
  // deadline; the nav-poll tests advance the same fake clock.
  jest.useFakeTimers();
  handler = await bootHandler();
});

afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  mockStore.clear();
  mockNavigate.mockClear();
  mockNavReadyAtCall.length = 0;
  mockNavReadyFlag = true;
  mockResolveDirectConversation.mockReset();
  mockResolveDirectConversation.mockResolvedValue(null);
  mockResolveConversationMeta.mockReset();
  mockResolveConversationMeta.mockResolvedValue(null);
});

describe('msg-wake body tap → Chat param contract (B-54/B-85, N-07/N-08)', () => {
  it('navigates Main→MessengerTab→Chat with conversationId + store name + isGroup:false + initial:false', async () => {
    await seedStore([{id: 'c-1', type: 'direct', name: 'Alice'}]);
    // Live store must WIN over the persisted slice — poison the fallback.
    mockResolveConversationMeta.mockResolvedValue({name: 'WRONG', isGroup: true});

    await handler(tap({kind: 'msg-wake', conversationId: 'c-1'}));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('Main', {
      screen: 'MessengerTab',
      params: {
        screen:  'Chat',
        initial: false,
        params:  {conversationId: 'c-1', name: 'Alice', isGroup: false},
      },
    });
    expect(mockResolveConversationMeta).not.toHaveBeenCalled();
  });

  it('passes isGroup:true for a `group` conversation', async () => {
    await seedStore([{id: 'g-1', type: 'group', name: 'Ops Team', peer: {userId: '', deviceId: 0}} as Partial<LocalConversation> & {id: string}]);

    await handler(tap({kind: 'msg-wake', conversationId: 'g-1'}));

    expect(navCallParams(0)).toEqual({
      screen:  'Chat',
      initial: false,
      params:  {conversationId: 'g-1', name: 'Ops Team', isGroup: true},
    });
  });

  it('passes isGroup:true for an `ops_channel` conversation too', async () => {
    await seedStore([{id: 'ch-1', type: 'ops_channel', name: 'Bravo System', peer: {userId: '', deviceId: 0}} as Partial<LocalConversation> & {id: string}]);

    await handler(tap({kind: 'msg-wake', conversationId: 'ch-1'}));

    expect(navCallParams(0)).toEqual({
      screen:  'Chat',
      initial: false,
      params:  {conversationId: 'ch-1', name: 'Bravo System', isGroup: true},
    });
  });

  it('cold boot: falls back to the persisted-slice meta (name + isGroup) when the live store misses', async () => {
    await seedStore([]); // live store hydrated but EMPTY — cold-boot shape
    mockResolveConversationMeta.mockResolvedValue({name: 'Persisted Squad', isGroup: true});

    await handler(tap({kind: 'msg-wake', conversationId: 'c-cold'}));

    expect(mockResolveConversationMeta).toHaveBeenCalledWith('c-cold');
    expect(navCallParams(0)).toEqual({
      screen:  'Chat',
      initial: false,
      params:  {conversationId: 'c-cold', name: 'Persisted Squad', isGroup: true},
    });
  });

  it("last resort: a resolvable conversation with no name anywhere still passes name:'' (never undefined)", async () => {
    await seedStore([{id: 'c-noname', type: 'direct', name: undefined}]);

    await handler(tap({kind: 'msg-wake', conversationId: 'c-noname'}));

    const params = navCallParams(0).params as Record<string, unknown>;
    expect(params.conversationId).toBe('c-noname');
    // ChatScreen crashed on initials(undefined) — '' is the contract (N-07).
    expect(params.name).toBe('');
    expect(typeof params.name).toBe('string');
  });
});

describe('M-05 — unresolvable conversation degrades to MessengerHome, never a phantom Chat', () => {
  it('unknown conversationId (store miss + persisted miss) lands on MessengerHome', async () => {
    await seedStore([]);
    mockResolveConversationMeta.mockResolvedValue(null);

    await handler(tap({kind: 'msg-wake', conversationId: 'c-ghost'}));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('Main', {
      screen: 'MessengerTab',
      params: {screen: 'MessengerHome'},
    });
    expect(navCallParams(0).screen).not.toBe('Chat');
  });

  it('a msg-wake with NO conversationId at all lands on MessengerHome without consulting the resolvers', async () => {
    await seedStore([]);

    await handler(tap({kind: 'msg-wake'}));

    expect(mockResolveConversationMeta).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('Main', {
      screen: 'MessengerTab',
      params: {screen: 'MessengerHome'},
    });
  });
});

describe('missed-call tap routing (P1-7 — no ghost CallScreen)', () => {
  it('fromUserId with a resolvable 1:1 thread → Chat{conversationId, name, isGroup:false} + initial:false', async () => {
    mockResolveDirectConversation.mockResolvedValue({id: 'c-2', name: 'Mallory'});
    // A missed-call banner ALSO carries the dead call's id + a still-cached
    // ring payload — the exact shape that used to fall into the call branch.
    const cache = require('../push/incomingCallCache') as typeof import('../push/incomingCallCache');
    cache.setIncomingCallPayload({callId: 'call-1', callerName: 'Mallory', kind: 'voice', fromUserId: 'u-2'});
    nf().cancelNotification.mockClear();

    await handler(tap({kind: 'missed-call', callId: 'call-1', fromUserId: 'u-2', callKind: 'voice'}));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('Main', {
      screen: 'MessengerTab',
      params: {
        screen:  'Chat',
        initial: false,
        params:  {conversationId: 'c-2', name: 'Mallory', isGroup: false},
      },
    });
    // Never reached the incoming-call branch: no CallScreen navigation, and
    // no dismissCallNotif (the call branch ALWAYS dismisses first).
    expect(navCallParams(0).screen).not.toBe('CallScreen');
    expect(nf().cancelNotification).not.toHaveBeenCalled();
  });

  it('no fromUserId → CallsLog (never the incoming-call branch)', async () => {
    nf().cancelNotification.mockClear();

    await handler(tap({kind: 'missed-call', callId: 'call-2'}));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    // BB-3 — initial: false seeds MessengerHome beneath CallsLog (same B-85
    // flag the Chat branch carries), so its back arrow works on a cold tap.
    expect(mockNavigate).toHaveBeenCalledWith('Main', {
      screen: 'MessengerTab',
      params: {screen: 'CallsLog', initial: false},
    });
    expect(nf().cancelNotification).not.toHaveBeenCalled();
  });

  it('fromUserId with NO local 1:1 thread → CallsLog (no phantom Chat)', async () => {
    mockResolveDirectConversation.mockResolvedValue(null);

    await handler(tap({kind: 'missed-call', callId: 'call-3', fromUserId: 'u-stranger'}));

    expect(mockResolveDirectConversation).toHaveBeenCalledWith('u-stranger');
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('Main', {
      screen: 'MessengerTab',
      params: {screen: 'CallsLog', initial: false},
    });
  });
});

describe('route param superset — navigation/types.ts is the contract', () => {
  it('both tap paths pass a superset of the Chat route’s REQUIRED params', async () => {
    const typesSrc = readFileSync(join(process.cwd(), 'src', 'navigation', 'types.ts'), 'utf8');
    // First `Chat:` entry = MessengerStackParamList.Chat (single-line object).
    const m = /Chat:\s*\{([^}]*)\}/.exec(typesSrc);
    expect(m).not.toBeNull();
    const required = (m as RegExpExecArray)[1]
      .split(';')
      .map(field => /^\s*(\w+)(\??)\s*:/.exec(field))
      .filter((x): x is RegExpExecArray => x !== null && x[2] !== '?')
      .map(x => x[1]);
    // Guard the parse itself — if the route type changes shape, fail loudly
    // here instead of vacuously passing below.
    expect([...required].sort()).toEqual(['conversationId', 'isGroup', 'name']);

    await seedStore([{id: 'c-sup', type: 'direct', name: 'Alice'}]);
    await handler(tap({kind: 'msg-wake', conversationId: 'c-sup'}));
    mockResolveDirectConversation.mockResolvedValue({id: 'c-sup', name: 'Alice'});
    await handler(tap({kind: 'missed-call', callId: 'call-9', fromUserId: 'u-9'}));

    expect(mockNavigate).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i++) {
      const p = navCallParams(i);
      expect(p.screen).toBe('Chat');
      const keys = Object.keys(p.params ?? {});
      for (const k of required) {
        expect(keys).toContain(k);
      }
    }
  });
});

describe('static structure — the missed-call branch can never reach the call branch (P1-7)', () => {
  const FCM = join(process.cwd(), 'src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts');

  /** Strip `//` line and block comments so a scan sees CODE, not prose. */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
  }

  it('the missed-call check precedes the callId call branch and returns', () => {
    const src = readFileSync(FCM, 'utf8');
    const start = src.indexOf('const handle = async');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('notifee.onForegroundEvent(', start);
    expect(end).toBeGreaterThan(start);
    const body = stripComments(src.slice(start, end));

    const missed    = body.indexOf("data.kind === 'missed-call'");
    const callParse = body.indexOf('parseCallAction(');
    expect(missed).toBeGreaterThan(-1);
    expect(callParse).toBeGreaterThan(missed);
    // The branch must consume the tap: await the router, then return.
    expect(body).toMatch(/data\.kind === 'missed-call'\)\s*\{\s*await handleMissedCallTap\(data\);\s*return;/);
  });

  it('handleMissedCallTap targets Chat/CallsLog only — CallScreen never appears in its code', () => {
    const src = readFileSync(FCM, 'utf8');
    const fnStart = src.indexOf('async function handleMissedCallTap');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = src.indexOf('function stringFields', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const body = stripComments(src.slice(fnStart, fnEnd));

    expect(body).toContain("'CallsLog'");
    expect(body).toContain('initial: false'); // B-85 back-stack seed on the Chat leg
    expect(body).not.toContain('CallScreen');
  });
});

describe('nav-readiness window on a cold launch (N-09 / P1-BR-2)', () => {
  it('body-tap waits 20s for the navigator and BAILS if still un-ready — never navigates blind (B-227 fixed)', async () => {
    // B-227: msg-wake now matches the call path — a 20 s window (P1-BR-2 cold
    // launches take 10–25 s) with a post-loop readiness re-check that bails
    // instead of navigating a non-ready ref (a silent no-op that drops the
    // deep-link on device). The foreground mount pull surfaces the message.
    await seedStore([{id: 'c-slow', type: 'direct', name: 'Alice'}]);
    mockNavReadyFlag = false; // container never mounts

    const p = handler(tap({kind: 'msg-wake', conversationId: 'c-slow'}));
    await jest.advanceTimersByTimeAsync(19_900);
    expect(mockNavigate).not.toHaveBeenCalled(); // still polling inside 20s
    await jest.advanceTimersByTimeAsync(300);    // crosses the 20s cap
    await p;

    // Bailed — never navigates a dead ref.
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('after its 20s wait expires un-ready the missed-call tap BAILS instead of navigating a dead ref (B-230 fixed)', async () => {
    // B-230: handleMissedCallTap now mirrors the Telecom-Answer path — after the
    // 20 s poll it re-checks isReady() and returns, instead of falling through
    // to a navigate() that no-ops on device and silently drops the tap intent.
    mockResolveDirectConversation.mockResolvedValue({id: 'c-9', name: 'Bob'});
    mockNavReadyFlag = false; // container never mounts

    const p = handler(tap({kind: 'missed-call', callId: 'call-9', fromUserId: 'u-9'}));
    await jest.advanceTimersByTimeAsync(19_900);
    expect(mockNavigate).not.toHaveBeenCalled(); // still polling inside 20s
    await jest.advanceTimersByTimeAsync(300);    // crosses the 20s cap
    await p;

    // Bailed — no navigate on a dead ref.
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('B-324/B-325 — tap-time pull + guessed-conversation re-route', () => {
  function appendInbound(cid: string, senderId: string, createdAt: string): void {
    const {useMessengerStore} = require('../store/messengerStore') as
      typeof import('../store/messengerStore');
    useMessengerStore.getState().appendMessage(cid, {
      id:              `m-${cid}-${createdAt}`,
      conversation_id: cid,
      sender_id:       senderId,
      type:            'text',
      content:         'hi',
      status:          'delivered',
      is_encrypted:    true,
      created_at:      createdAt,
      peer:            {userId: senderId, deviceId: 1},
    } as never);
  }

  beforeEach(() => {
    mockPullEnvelopes.mockReset();
    mockPullEnvelopes.mockResolvedValue(undefined);
  });

  it('B-325 — a body tap kicks the envelope pull even on the authoritative path', async () => {
    await seedStore([{id: 'c-1', type: 'direct', name: 'Alice'}]);

    await handler(tap({kind: 'msg-wake', conversationId: 'c-1'}));
    // The pull is deliberately fire-and-forget on the authoritative path —
    // drain the microtask chain (timer-free; the suite runs fake timers).
    for (let i = 0; i < 10; i++) { await Promise.resolve(); }

    expect(mockPullEnvelopes).toHaveBeenCalled();
    // Navigation itself is unchanged — the pull rides alongside, never blocks.
    expect(navCallParams(0).params).toEqual({conversationId: 'c-1', name: 'Alice', isGroup: false});
  });

  it('B-324/C1 — a convGuess banner routes the guess IMMEDIATELY, then re-routes to where the sender’s newest message actually landed', async () => {
    await seedStore([
      {id: 'direct:peer-9', type: 'direct', name: 'Alice', peer: {userId: 'peer-9', deviceId: 1}, participants: ['peer-9']},
      {id: 'g-7', type: 'group', name: 'Ops Squad', peer: {userId: '', deviceId: 0}, participants: ['peer-9', 'peer-2']},
    ]);
    // The tap-time pull ingests the sealed GROUP message the wake was really about.
    mockPullEnvelopes.mockImplementation(async () => {
      appendInbound('g-7', 'peer-9', '2026-07-29T08:00:00.000Z');
    });

    await handler(tap({kind: 'msg-wake', conversationId: 'direct:peer-9', convGuess: '1', senderUserId: 'peer-9'}));

    // Notif-latency C1: navigation is never held hostage to the pull (up to
    // 6 s) — the guess renders first…
    expect(navCallParams(0)).toEqual({
      screen:  'Chat',
      initial: false,
      params:  {conversationId: 'direct:peer-9', name: 'Alice', isGroup: false},
    });
    // …and B-324's protection is intact: the FINAL destination is where the
    // sender's newest message actually landed.
    expect(navCallParams(mockNavigate.mock.calls.length - 1)).toEqual({
      screen:  'Chat',
      initial: false,
      params:  {conversationId: 'g-7', name: 'Ops Squad', isGroup: true},
    });
  });

  it('B-324 — when the pull yields nothing from the sender, the guessed DM stays the fallback', async () => {
    await seedStore([
      {id: 'direct:peer-9', type: 'direct', name: 'Alice', peer: {userId: 'peer-9', deviceId: 1}, participants: ['peer-9']},
    ]);

    await handler(tap({kind: 'msg-wake', conversationId: 'direct:peer-9', convGuess: '1', senderUserId: 'peer-9'}));

    expect(navCallParams(0).params).toEqual({conversationId: 'direct:peer-9', name: 'Alice', isGroup: false});
  });

  it('B-326 — an inline Reply on a cold VM still reaches sendText (and never navigates)', async () => {
    await seedStore([{id: 'c-1', type: 'direct', name: 'Alice'}]);

    await handler({
      type: 2, // ACTION_PRESS
      detail: {
        notification: {data: {kind: 'msg-wake', conversationId: 'c-1'}},
        pressAction:  {id: 'reply-c-1'},
        input:        'on my way',
      },
    });

    // B-361 — the reply now dispatches through the durable pending-action
    // drain: same sendText, plus the hints that survive an un-hydrated store
    // (isGroup, retry-stable bubble id). The typed text and target must be
    // untouched, and it must still never navigate.
    expect(mockSendText).toHaveBeenCalledWith('c-1', 'on my way', expect.objectContaining({
      isGroup: false,
      stableMsgId: expect.stringMatching(/^notifreply-/),
    }));
    expect(mockMarkRead).toHaveBeenCalledWith('c-1');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('B-326 — every notification action routes through ensureRuntimeForNotifAction (cold-VM config parity)', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts'), 'utf8');
    // The helper exists and configures from the persisted record.
    const helper = src.indexOf('async function ensureRuntimeForNotifAction');
    expect(helper).toBeGreaterThan(-1);
    expect(src.slice(helper, helper + 900)).toContain('configureRuntimeFromPersisted');
    // The reply and mark-read action branches use it — a bare
    // getMessengerRuntime there throws B-272 on a cold headless VM and the
    // typed reply is silently DROPPED.
    const readBranch  = src.indexOf("pressId.startsWith('read-')");
    const replyBranch = src.indexOf("pressId.startsWith('reply-')");
    expect(readBranch).toBeGreaterThan(-1);
    expect(replyBranch).toBeGreaterThan(-1);
    expect(src.slice(readBranch,  readBranch  + 700)).toContain('ensureRuntimeForNotifAction');
    expect(src.slice(replyBranch, replyBranch + 700)).toContain('ensureRuntimeForNotifAction');
  });

  it('B-324 — the re-route picks the NEWEST message when the sender is in several threads', async () => {
    await seedStore([
      {id: 'direct:peer-9', type: 'direct', name: 'Alice', peer: {userId: 'peer-9', deviceId: 1}, participants: ['peer-9']},
      {id: 'g-7', type: 'group', name: 'Ops Squad', peer: {userId: '', deviceId: 0}, participants: ['peer-9', 'peer-2']},
    ]);
    appendInbound('direct:peer-9', 'peer-9', '2026-07-29T07:00:00.000Z'); // older DM row already hydrated
    mockPullEnvelopes.mockImplementation(async () => {
      appendInbound('g-7', 'peer-9', '2026-07-29T08:00:00.000Z');
    });

    await handler(tap({kind: 'msg-wake', conversationId: 'direct:peer-9', convGuess: '1', senderUserId: 'peer-9'}));

    // C1: the guess routes first; the refinement (last navigate) picks the
    // sender's NEWEST message across threads.
    expect((navCallParams(0).params as Record<string, unknown>).conversationId).toBe('direct:peer-9');
    const last = mockNavigate.mock.calls.length - 1;
    expect((navCallParams(last).params as Record<string, unknown>).conversationId).toBe('g-7');
  });
});
