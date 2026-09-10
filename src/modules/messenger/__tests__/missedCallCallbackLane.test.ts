/**
 * Missed-call lane end-to-end — producers → tap → call-back affordance.
 *
 * Every missed-call surface funnels through callNotification.showMissedCallNotif
 * (id `bravo-missed-<callId>`, channel `bravo-missed-calls`, data.kind
 * 'missed-call'), and the P1-7 tap contract is: `data.fromUserId` present →
 * deep-link the caller's 1:1 thread (call-back affordance); absent → degrade to
 * the Calls log. Producers covered here:
 *
 *   - warm WS `call.missed` replay (callDispatcher, SYNC-5 age-gated) and the
 *     no-controller `call.hangup` while ringing (CALL-16 bubble + notif)
 *   - FCM call-cancel: killed/bg lane (fcmBootstrap.setBackgroundMessageHandler
 *     → handleCallCancel, N-02) and headless lane (fcmHeadless)
 *   - headless voip-wake stale-degrade (N-03)
 *
 * Consumers: the rich notifee handler (fcmBootstrap → handleMissedCallTap) and
 * the SLIM bundle-entry handler (a missed-call tap must never be treated as a
 * ring action).
 *
 * DOCUMENTS PENDING pins (see the individual tests): both warm callDispatcher
 * producers OMIT fromUserId, so a warm-lane missed-call tap can never deep-link
 * the caller thread — it always degrades to CallsLog.
 *
 * Static scans strip comments first and never anchor a regex on \n — these
 * sources are CRLF (repo rule; a \n-anchored regex matches nothing).
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).__missedLaneAsyncStore = store;
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
    },
  };
});
jest.mock('react-native', () => ({
  Platform: {OS: 'android', Version: 33},
  PermissionsAndroid: {check: jest.fn(async () => true), request: jest.fn(async () => 'granted')},
  AppState: {currentState: 'background', addEventListener: jest.fn(() => ({remove: jest.fn()}))},
  NativeModules: {},
}));
// NOT `{virtual: true}` — the module is real (see B-161 note in pendingActions.test.ts).
jest.mock('@utils/constants', () => ({MSG_BASE_URL: 'https://msg.test'}));
jest.mock('@services/api', () => ({refreshAccessTokenShared: jest.fn(async () => {})}), {virtual: true});

jest.mock('@react-native-firebase/messaging', () => {
  const api = {
    // Reject fast so doRegisterPushTokens' getToken race never leaves a live timer.
    getToken:                    jest.fn(async () => { throw new Error('no token in test'); }),
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
    displayNotification:    jest.fn(async () => 'nid'),
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

const mockNav = jest.fn();
jest.mock('@navigation/navigationRef', () => ({
  navigationRef: {isReady: () => true, navigate: (n: string, p?: unknown) => mockNav(n, p)},
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
jest.mock('../runtime/callRegistry', () => ({
  getActiveCall: jest.fn(() => null),
  endActiveCall: jest.fn(),
}));

const mockResolvePeerName = jest.fn(async (_uid: string): Promise<string | null> => 'Resolved Caller');
const mockResolveDirectConversation =
  jest.fn(async (uid: string): Promise<{id: string; name: string} | null> => ({id: `direct:${uid}`, name: 'Peer Thread'}));
jest.mock('../push/mutedLookup', () => ({
  resolveDirectPeerName:     (uid: string) => mockResolvePeerName(uid),
  resolveDirectConversation: (uid: string) => mockResolveDirectConversation(uid),
  isConversationMuted:       jest.fn(async () => false),
  resolveConversationMeta:   jest.fn(async () => null),
}));

const mockVerifyVoipWake = jest.fn(async (): Promise<{ok: boolean; reason?: string}> => ({ok: true}));
jest.mock('../push/voipWakeVerify', () => ({
  verifyVoipWake: (..._a: unknown[]) => mockVerifyVoipWake(),
}));

import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import notifee from '@notifee/react-native';
import {handleHeadlessFcm} from '../push/fcmHeadless';
import {installSlimNotifeeBgHandler} from '../push/callNotification';
import {loadPendingActions} from '../push/pendingActions';
import {dispatchCallFrame} from '../webrtc/callDispatcher';
import {useMessengerStore} from '../store/messengerStore';
import {setIncomingCallPayload} from '../push/incomingCallCache';
import type {ServerFrame} from '@bravo/messenger-core';

const display = notifee.displayNotification as jest.Mock;
const cancel  = notifee.cancelNotification as jest.Mock;

const PRESS = 1;

type MissedNotif = {
  id: string;
  title: string;
  body: string;
  data: Record<string, string | undefined>;
  android: {channelId: string; pressAction?: {id: string; launchActivity?: string}};
};
const lastDisplay = (): MissedNotif => display.mock.calls.at(-1)![0] as MissedNotif;

type NotifEvent = {
  type: number;
  detail: {notification?: {data?: Record<string, string>}; pressAction?: {id: string}; input?: string};
};
type NotifHandler = (ev: NotifEvent) => Promise<void>;

const asyncStore = (): Map<string, string> =>
  (globalThis as Record<string, unknown>).__missedLaneAsyncStore as Map<string, string>;

const flush = async (): Promise<void> => {
  await new Promise<void>(r => setImmediate(r));
  await new Promise<void>(r => setImmediate(r));
};

const frame = (o: Record<string, unknown>): ServerFrame => o as unknown as ServerFrame;
const headless = (data: Record<string, string>): Parameters<typeof handleHeadlessFcm>[0] =>
  ({data} as unknown as Parameters<typeof handleHeadlessFcm>[0]);

beforeEach(() => {
  display.mockClear();
  cancel.mockClear();
  mockNav.mockClear();
  mockResolvePeerName.mockClear();
  mockResolveDirectConversation.mockClear();
  asyncStore().clear();
  (global as {fetch?: unknown}).fetch = undefined;
});

// ── Static producer contract ─────────────────────────────────────────────────

describe('missed-call producer funnel (static source scan)', () => {
  const MSGR = join(process.cwd(), 'src', 'modules', 'messenger');

  /** Strip block + line comments so scans see CODE, not prose (repo trap). */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, {withFileTypes: true})) {
      if (e.name === '__tests__' || e.name === '__mocks__') {continue;}
      const p = join(dir, e.name);
      if (e.isDirectory()) {walk(p, out);}
      else if (/\.tsx?$/.test(e.name)) {out.push(p);}
    }
    return out;
  }

  it('the bravo-missed id/channel is minted ONLY inside callNotification.ts (all producers funnel)', () => {
    // If a new producer hand-rolls its own displayNotification with a
    // bravo-missed id, the P1-7 tap contract (kind + callId + fromUserId in
    // data) silently forks. Every producer must call showMissedCallNotif.
    const offenders = walk(MSGR)
      .filter(p => stripComments(readFileSync(p, 'utf8')).includes('bravo-missed'))
      .map(p => p.slice(MSGR.length + 1).replace(/\\/g, '/'));
    expect(offenders).toEqual(['push/callNotification.ts']);
  });

  it('showMissedCallNotif keeps default autoCancel (tap self-clears) and launches the app on tap', () => {
    const src = readFileSync(join(MSGR, 'push', 'callNotification.ts'), 'utf8');
    const start = src.indexOf('export async function showMissedCallNotif');
    const end   = src.indexOf('export async function showIncomingCallNotif', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = stripComments(src.slice(start, end));
    expect(body).toContain('bravo-missed-');
    expect(body).toContain("'missed-call'");
    // The tap must launch the app for the call-back affordance to exist at all.
    expect(body).toMatch(/launchActivity:\s*'default'/);
    // Why this pin exists: the SLIM bundle-entry handler dismisses the RING id
    // (`bravo-call-<id>`) on a missed-call tap, never `bravo-missed-<id>` — see
    // the DOCUMENTS PENDING(slim-missed-dismiss-id) test below. That mismatch
    // is harmless ONLY while the banner keeps notifee's default autoCancel
    // (true) and is not `ongoing`. If either appears here, the slim handler
    // must be fixed FIRST or missed banners become undismissable from a tap.
    expect(body).not.toMatch(/autoCancel/);
    expect(body).not.toMatch(/ongoing\s*:/);
  });
});

// ── FCM lanes: headless call-cancel + stale voip-wake degrade ────────────────

describe('fcmHeadless — call-cancel and stale-degrade producers carry fromUserId (N-02/N-03)', () => {
  it('call-cancel with missed=1 posts bravo-missed-<id> on bravo-missed-calls with kind/callId/fromUserId', async () => {
    await handleHeadlessFcm(headless({
      kind: 'call-cancel', callId: 'call-h1', missed: '1',
      fromUserId: 'u-fcm', callerName: 'Alice', callKind: 'voice',
    }));
    // The ring this device may have drawn is dismissed…
    expect(cancel).toHaveBeenCalledWith('bravo-call-call-h1');
    // …and the missed-call trace carries the full P1-7 tap contract.
    expect(display).toHaveBeenCalledTimes(1);
    const arg = lastDisplay();
    expect(arg.id).toBe('bravo-missed-call-h1');
    expect(arg.android.channelId).toBe('bravo-missed-calls');
    expect(arg.data).toEqual({kind: 'missed-call', callId: 'call-h1', fromUserId: 'u-fcm'});
    expect(arg.body).toBe('Voice call from Alice');
  });

  it('call-cancel WITHOUT missed=1 dismisses the ring but draws no missed banner', async () => {
    await handleHeadlessFcm(headless({kind: 'call-cancel', callId: 'call-h2'}));
    expect(cancel).toHaveBeenCalledWith('bravo-call-call-h2');
    expect(display).not.toHaveBeenCalled();
  });

  it('a voip-wake failing ONLY freshness degrades to a missed-call notif with fromUserId + resolved name', async () => {
    mockVerifyVoipWake.mockResolvedValueOnce({ok: false, reason: 'stale'});
    await handleHeadlessFcm(headless({kind: 'voip-wake', callId: 'call-h3', fromUserId: 'u-77', callKind: 'video'}));
    expect(display).toHaveBeenCalledTimes(1);
    const arg = lastDisplay();
    expect(arg.id).toBe('bravo-missed-call-h3');
    expect(arg.data.kind).toBe('missed-call');
    expect(arg.data.callId).toBe('call-h3');
    expect(arg.data.fromUserId).toBe('u-77');
    // N-13 — the wire carries no name; it resolves from the local vault.
    expect(mockResolvePeerName).toHaveBeenCalledWith('u-77');
    expect(arg.body).toBe('Video call from Resolved Caller');
  });

  it('a voip-wake failing verification for any OTHER reason surfaces nothing (no laundering into missed)', async () => {
    mockVerifyVoipWake.mockResolvedValueOnce({ok: false, reason: 'bad-sig'});
    await handleHeadlessFcm(headless({kind: 'voip-wake', callId: 'call-h4', fromUserId: 'u-77'}));
    expect(display).not.toHaveBeenCalled();
  });
});

// ── Warm WS lanes: callDispatcher producers ──────────────────────────────────

describe('callDispatcher — warm call.missed and hangup-while-ringing producers', () => {
  beforeEach(() => {
    useMessengerStore.getState().reset();
    useMessengerStore.getState().setOwner('owner-1');
  });

  function bubbleIds(convoId: string): string[] {
    return (useMessengerStore.getState().messages[convoId] ?? []).map(m => m.id);
  }

  it('a fresh call.missed posts bravo-missed-<id> on bravo-missed-calls AND appends the Calls-log bubble', async () => {
    dispatchCallFrame(frame({
      event: 'call.missed',
      data:  {callId: 'call-wm1', from: {userId: 'u-caller', deviceId: 1}, kind: 'voice', at: Date.now()},
    }));
    await flush();
    expect(display).toHaveBeenCalledTimes(1);
    const arg = lastDisplay();
    expect(arg.id).toBe('bravo-missed-call-wm1');
    expect(arg.android.channelId).toBe('bravo-missed-calls');
    expect(arg.data.kind).toBe('missed-call');
    expect(arg.data.callId).toBe('call-wm1');
    expect(arg.body).toMatch(/^Voice call from /);
    expect(bubbleIds('direct:u-caller')).toContain('missed-call-wm1');
  });

  it('the warm call.missed producer carries fromUserId so the tap deep-links the caller thread (B-229 fixed)', async () => {
    // B-229: the call.missed branch now passes f.data.from.userId to
    // showMissedCallNotif, so handleMissedCallTap resolves the 1:1 thread — the
    // warm lane's call-back affordance is the caller thread, not CallsLog.
    dispatchCallFrame(frame({
      event: 'call.missed',
      data:  {callId: 'call-wm2', from: {userId: 'u-caller', deviceId: 1}, kind: 'voice', at: Date.now()},
    }));
    await flush();
    expect(display).toHaveBeenCalledTimes(1);
    expect(lastDisplay().data.fromUserId).toBe('u-caller');
  });

  it('SYNC-5 — a stale call.missed replay writes the Calls-log bubble but draws NO notification', async () => {
    dispatchCallFrame(frame({
      event: 'call.missed',
      data:  {callId: 'call-wm3', from: {userId: 'u-caller', deviceId: 1}, kind: 'voice', at: Date.now() - 7 * 86_400_000},
    }));
    await flush();
    expect(display).not.toHaveBeenCalled();
    expect(bubbleIds('direct:u-caller')).toContain('missed-call-wm3');
  });

  it('caller hangs up while we are still ringing (no controller) → missed notif + CALL-16 bubble + ring dismissed', async () => {
    setIncomingCallPayload({callId: 'call-hang-1', callerName: 'Alice', kind: 'voice', fromUserId: 'u-hang'});
    dispatchCallFrame(frame({
      event: 'call.hangup',
      data:  {callId: 'call-hang-1', from: {userId: 'u-hang', deviceId: 1}, reason: 'timeout'},
    }));
    await flush();
    expect(cancel).toHaveBeenCalledWith('bravo-call-call-hang-1');
    expect(display).toHaveBeenCalledTimes(1);
    const arg = lastDisplay();
    expect(arg.id).toBe('bravo-missed-call-hang-1');
    expect(arg.android.channelId).toBe('bravo-missed-calls');
    expect(arg.data.kind).toBe('missed-call');
    expect(arg.body).toBe('Voice call from Alice');
    expect(bubbleIds('direct:u-hang')).toContain('missed-call-hang-1');
  });

  it('the hangup-while-ringing producer carries fromUserId (ring-cached, falling back to the frame) (B-229 fixed)', async () => {
    // B-229: both sources are in scope — payload.fromUserId (cached by the ring)
    // and f.data.from.userId (on the hangup frame). The fix passes
    // payload.fromUserId ?? f.data.from?.userId, so this tap also deep-links.
    setIncomingCallPayload({callId: 'call-hang-3', callerName: 'Alice', kind: 'voice', fromUserId: 'u-hang3'});
    dispatchCallFrame(frame({
      event: 'call.hangup',
      data:  {callId: 'call-hang-3', from: {userId: 'u-hang3', deviceId: 1}, reason: 'timeout'},
    }));
    await flush();
    expect(display).toHaveBeenCalledTimes(1);
    expect(lastDisplay().data.fromUserId).toBe('u-hang3');
  });

  it('a DECLINED hangup is not a missed call — no banner, no bubble', async () => {
    setIncomingCallPayload({callId: 'call-hang-2', callerName: 'Alice', kind: 'voice', fromUserId: 'u-hang2'});
    dispatchCallFrame(frame({
      event: 'call.hangup',
      data:  {callId: 'call-hang-2', from: {userId: 'u-hang2', deviceId: 1}, reason: 'declined'},
    }));
    await flush();
    expect(display).not.toHaveBeenCalled();
    expect(bubbleIds('direct:u-hang2')).not.toContain('missed-call-hang-2');
  });
});

// ── SLIM bundle-entry handler: a missed-call tap is not a ring action ────────

describe('slim bundle-entry handler — missed-call tap', () => {
  let slimHandler: NotifHandler;

  beforeAll(() => {
    installSlimNotifeeBgHandler();
    slimHandler = (notifee.onBackgroundEvent as jest.Mock).mock.calls.at(-1)![0] as NotifHandler;
  });

  it('a missed-call body tap fires NO ring action: no decline POST, no pending action, no re-display', async () => {
    const fetchSpy = jest.fn();
    (global as {fetch?: unknown}).fetch = fetchSpy as unknown as typeof fetch;
    await slimHandler({
      type: PRESS,
      detail: {notification: {data: {kind: 'missed-call', callId: 'call-s1', fromUserId: 'u-s'}}, pressAction: {id: 'default'}},
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await loadPendingActions()).toHaveLength(0);
    expect(display).not.toHaveBeenCalled();
  });

  it('the missed-call tap-dismiss targets bravo-missed-<id>, not the ring id (B-233 fixed)', async () => {
    // B-233: the slim handler now recognises kind==='missed-call' and cancels
    // its own `bravo-missed-<id>`, never the ring's `bravo-call-<id>` (a
    // notification that no longer exists). This makes a future persistent missed
    // banner dismissable from a killed-app tap.
    await slimHandler({
      type: PRESS,
      detail: {notification: {data: {kind: 'missed-call', callId: 'call-s2'}}, pressAction: {id: 'default'}},
    });
    expect(cancel).toHaveBeenCalledWith('bravo-missed-call-s2');
    expect(cancel).not.toHaveBeenCalledWith('bravo-call-call-s2');
  });
});

// ── Rich lane: fcmBootstrap producer (handleCallCancel) + tap routing ────────

describe('fcmBootstrap — killed/bg call-cancel producer and the P1-7 tap routes', () => {
  let bgFcmHandler: (msg: {data: Record<string, string>}) => Promise<void>;
  let richPress: NotifHandler;

  beforeAll(async () => {
    const boot = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
    await boot.startFcmBootstrap();
    const messagingApi = (require('@react-native-firebase/messaging') as {default: () => Record<string, jest.Mock>}).default();
    bgFcmHandler = messagingApi.setBackgroundMessageHandler.mock.calls.at(-1)![0] as typeof bgFcmHandler;
    richPress    = (notifee.onBackgroundEvent as jest.Mock).mock.calls.at(-1)![0] as NotifHandler;
  });

  it('bg FCM call-cancel with missed=1 posts the funnel notification WITH fromUserId (P2-5)', async () => {
    await bgFcmHandler({data: {
      kind: 'call-cancel', callId: 'call-f1', missed: '1',
      fromUserId: 'u-fcm', callerName: 'Alice', callKind: 'video',
    }});
    expect(cancel).toHaveBeenCalledWith('bravo-call-call-f1');
    expect(display).toHaveBeenCalledTimes(1);
    const arg = lastDisplay();
    expect(arg.id).toBe('bravo-missed-call-f1');
    expect(arg.android.channelId).toBe('bravo-missed-calls');
    expect(arg.data).toEqual({kind: 'missed-call', callId: 'call-f1', fromUserId: 'u-fcm'});
    expect(arg.body).toBe('Video call from Alice');
  });

  it('a missed-call tap WITH fromUserId deep-links the caller 1:1 thread (call-back affordance)', async () => {
    await richPress({
      type: PRESS,
      detail: {notification: {data: {kind: 'missed-call', callId: 'call-t1', fromUserId: 'u-tap'}}, pressAction: {id: 'default'}},
    });
    expect(mockResolveDirectConversation).toHaveBeenCalledWith('u-tap');
    // B-85 — `initial: false` is load-bearing (seeds MessengerHome beneath Chat).
    expect(mockNav).toHaveBeenCalledWith('Main', {
      screen: 'MessengerTab',
      params: {screen: 'Chat', initial: false, params: {conversationId: 'direct:u-tap', name: 'Peer Thread', isGroup: false}},
    });
  });

  it('a missed-call tap WITHOUT fromUserId degrades to CallsLog and NEVER opens a ghost CallScreen', async () => {
    await richPress({
      type: PRESS,
      detail: {notification: {data: {kind: 'missed-call', callId: 'call-t2'}}, pressAction: {id: 'default'}},
    });
    expect(mockNav).toHaveBeenCalledWith('Main', {screen: 'MessengerTab', params: {screen: 'CallsLog', initial: false}});
    // P1-7 — the call is over; the tap must not fall through to the CALL branch.
    expect(JSON.stringify(mockNav.mock.calls)).not.toContain('CallScreen');
  });
});
