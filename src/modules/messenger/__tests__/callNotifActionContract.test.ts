/**
 * Incoming-call notification ACTION CONTRACT (audit 2026-07-24).
 *
 * Why: the ring card is the only surface a backgrounded/killed device shows
 * for an incoming call, and its shape is load-bearing:
 *   - id `bravo-call-<callId>` is what every dismiss path targets;
 *   - the silent `bravo-incoming-call-v2` channel + category CALL + ongoing +
 *     autoCancel:false is what makes Android treat it as telephony (B-27/v2
 *     channel history, docs/audits/CALL_NOTIFICATION_DEVICE_AUDIT_2026-07-10.md);
 *   - timeoutAfter must equal RING_TIMEOUT_MS (PUSH-B5, 45s) or a killed app
 *     rings forever / the native ringtone outlives the card;
 *   - Decline's pressAction must NOT carry launchActivity (P1-BR-3 — a
 *     headless decline must never cold-launch the app the user just rejected)
 *     while Answer MUST launch the activity;
 *   - the data block must round-trip the whole payload so tap handlers
 *     (fcmBootstrap rich handler, slim bundle-entry handler) never have to
 *     re-query state that a process restart already destroyed;
 *   - dismissCallNotif is the single ring-exit funnel: ringtone stop lives
 *     THERE (before the card cancel) so no exit path can strand the ringtone.
 *
 * Unit-import approach: callNotification.ts only pulls notifee + react-native
 * (both mocked, NON-virtual per B-161) + the pure callVibration module.
 * fcmBootstrap.ts CANNOT be imported under the node-env messenger-crypto
 * project, so its rich-handler decline gap is pinned by a comment-stripped,
 * CRLF-safe static source scan (DOCUMENTS PENDING below).
 */

// Shared recorders. `mock` prefix keeps babel-plugin-jest-hoist happy; the
// factories only close over them — nothing is read until a test runs.
const mockOrder: string[] = [];
const mockDisplayed: DisplayedCallNotif[] = [];
const mockCancelled: string[] = [];
let mockBgHandler: ((ev: SlimBgEvent) => Promise<void>) | undefined;

// NOT `{virtual: true}` — B-161: react-native is a real module and a virtual
// mock races the real resolution (untransformed ESM under the node project).
jest.mock('react-native', () => ({
  Platform: {OS: 'android', Version: 34},
  NativeModules: {},
}));

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    createChannel: jest.fn(async (c: {id: string}) => c.id),
    deleteChannel: jest.fn(async () => {}),
    displayNotification: jest.fn(async (n: unknown) => {
      mockDisplayed.push(n as DisplayedCallNotif);
      mockOrder.push(`display:${(n as {id?: string}).id ?? ''}`);
    }),
    cancelNotification: jest.fn(async (id: string) => {
      mockCancelled.push(id);
      mockOrder.push(`cancel:${id}`);
    }),
    onBackgroundEvent: jest.fn((cb: (ev: SlimBgEvent) => Promise<void>) => {
      mockBgHandler = cb;
    }),
    onForegroundEvent: jest.fn(),
  },
  AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2},
  AndroidCategory: {CALL: 'call', MESSAGE: 'msg'},
  AndroidVisibility: {PUBLIC: 1, PRIVATE: 0},
  AndroidStyle: {BIGTEXT: 0, MESSAGING: 1},
  EventType: {PRESS: 1, ACTION_PRESS: 2},
}));

// The dismiss funnel lazily require()s ./incomingRingtone — mock it so the
// stop-before-cancel ORDER is observable through mockOrder.
const mockRingStart = jest.fn((callId: string) => {
  mockOrder.push(`ring-start:${callId}`);
});
const mockRingStop = jest.fn((callId: string | null, _reason: string) => {
  mockOrder.push(`ring-stop:${callId ?? 'any'}`);
});
jest.mock('../push/incomingRingtone', () => ({
  __esModule: true,
  startIncomingRingtone: mockRingStart,
  stopIncomingRingtone: mockRingStop,
}));

// The slim bg handler lazily require()s ./pendingActions (which pulls
// @utils/constants + AsyncStorage) — full mock keeps the node project clean.
const mockSendCallDecline = jest.fn(async (_a: unknown) => true);
const mockEnqueuePendingAction = jest.fn(async (_a: unknown) => {});
jest.mock('../push/pendingActions', () => ({
  __esModule: true,
  sendCallDecline: mockSendCallDecline,
  enqueuePendingAction: mockEnqueuePendingAction,
}));

import * as fs from 'fs';
import * as path from 'path';
import {EventType} from '@notifee/react-native';
import {
  showIncomingCallNotif,
  dismissCallNotif,
  parseCallAction,
  installSlimNotifeeBgHandler,
  NOTIF_ACCENT,
  type IncomingCallNotifPayload,
} from '../push/callNotification';

// The REAL constant (requireActual bypasses the module mock; its react-native
// import still resolves to the mock above, so importing it is side-effect free).
const {RING_TIMEOUT_MS} = jest.requireActual<
  typeof import('../push/incomingRingtone')
>('../push/incomingRingtone');

interface PressAction {
  id: string;
  launchActivity?: string;
}
interface NotifAction {
  title: string;
  pressAction: PressAction;
}
interface DisplayedCallNotif {
  id: string;
  title: string;
  body: string;
  data: Record<string, string>;
  android: {
    channelId: string;
    category: string;
    importance: number;
    visibility: number;
    ongoing?: boolean;
    autoCancel?: boolean;
    timeoutAfter?: number;
    color?: string;
    colorized?: boolean;
    fullScreenAction?: PressAction;
    pressAction?: PressAction;
    actions?: NotifAction[];
  };
}
interface SlimBgEvent {
  type: number;
  detail: {
    notification?: {data?: Record<string, string | undefined>};
    pressAction?: {id: string};
  };
}

function lastDisplayed(): DisplayedCallNotif {
  const n = mockDisplayed[mockDisplayed.length - 1];
  if (!n) {
    throw new Error('no notification displayed');
  }
  return n;
}

function slimHandler(): (ev: SlimBgEvent) => Promise<void> {
  if (!mockBgHandler) {
    throw new Error('slim bg handler was not registered');
  }
  return mockBgHandler;
}

beforeAll(() => {
  installSlimNotifeeBgHandler();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockOrder.length = 0;
  mockDisplayed.length = 0;
  mockCancelled.length = 0;
});

describe('showIncomingCallNotif — card shape', () => {
  it('emits id bravo-call-<callId> on the silent v2 channel as a CALL-category, PUBLIC, HIGH card', async () => {
    await showIncomingCallNotif({callId: 'c1', kind: 'voice', callerName: 'Fahim', fromUserId: 'u1'});
    const n = lastDisplayed();
    expect(n.id).toBe('bravo-call-c1');
    expect(n.android.channelId).toBe('bravo-incoming-call-v2');
    expect(n.android.category).toBe('call'); // AndroidCategory.CALL
    expect(n.android.importance).toBe(4); // AndroidImportance.HIGH
    expect(n.android.visibility).toBe(1); // AndroidVisibility.PUBLIC
  });

  it('is persistent: ongoing:true + autoCancel:false (only an explicit dismiss or the 45s timeout removes it)', async () => {
    await showIncomingCallNotif({callId: 'c1', kind: 'voice', callerName: 'Fahim'});
    const n = lastDisplayed();
    expect(n.android.ongoing).toBe(true);
    expect(n.android.autoCancel).toBe(false);
  });

  it('timeoutAfter equals RING_TIMEOUT_MS (PUSH-B5: 45s, matching the native ringtone auto-stop and the offer relay TTL)', async () => {
    await showIncomingCallNotif({callId: 'c1', kind: 'video', callerName: 'Fahim'});
    expect(RING_TIMEOUT_MS).toBe(45_000);
    expect(lastDisplayed().android.timeoutAfter).toBe(RING_TIMEOUT_MS);
  });

  it('carries a fullScreenAction (lock-screen wake) and a body-tap pressAction, both launching the activity', async () => {
    await showIncomingCallNotif({callId: 'c1', kind: 'voice', callerName: 'Fahim'});
    const n = lastDisplayed();
    expect(n.android.fullScreenAction).toEqual({id: 'default', launchActivity: 'default'});
    expect(n.android.pressAction).toEqual({id: 'default', launchActivity: 'default'});
  });

  it('starts the native ringtone with the callId only AFTER the card displays (a failed display must not leave invisible sound)', async () => {
    await showIncomingCallNotif({callId: 'c-ring', kind: 'voice', callerName: 'Fahim'});
    expect(mockRingStart).toHaveBeenCalledWith('c-ring');
    const displayAt = mockOrder.indexOf('display:bravo-call-c-ring');
    const ringAt = mockOrder.indexOf('ring-start:c-ring');
    expect(displayAt).toBeGreaterThanOrEqual(0);
    expect(ringAt).toBeGreaterThan(displayAt);
  });

  it('the colorized ring card paints NOTIF_ACCENT cobalt, not legacy #1E88FF (B-232 fixed)', async () => {
    // B-66 residual closed as B-232 / G8: every display site (showMessageNotif,
    // showMissedCallNotif, markReplyQueued, and now the incoming-call ring)
    // paints NOTIF_ACCENT #5B8DEF. colorized:true means the WHOLE surface takes
    // the accent, so a legacy blue here was the most visible deviation.
    await showIncomingCallNotif({callId: 'c1', kind: 'voice', callerName: 'Fahim'});
    const n = lastDisplayed();
    expect(NOTIF_ACCENT).toBe('#5B8DEF');
    expect(n.android.colorized).toBe(true);
    expect(n.android.color).toBe(NOTIF_ACCENT);
  });
});

describe('showIncomingCallNotif — action buttons', () => {
  it('Decline has NO launchActivity (P1-BR-3 headless decline); Answer HAS launchActivity default', async () => {
    await showIncomingCallNotif({callId: 'c2', kind: 'voice', callerName: 'Fahim'});
    const actions = lastDisplayed().android.actions ?? [];
    expect(actions).toHaveLength(2);

    const decline = actions.find(a => a.pressAction.id.startsWith('decline-'));
    const answer = actions.find(a => a.pressAction.id.startsWith('accept-'));
    expect(decline).toBeDefined();
    expect(answer).toBeDefined();

    expect(decline!.title).toContain('Decline');
    expect(decline!.pressAction.id).toBe('decline-c2');
    // The load-bearing absence: launchActivity here would cold-launch the app
    // the user just rejected. Assert the KEY is absent, not merely undefined.
    expect('launchActivity' in decline!.pressAction).toBe(false);

    expect(answer!.title).toContain('Answer');
    expect(answer!.pressAction).toEqual({id: 'accept-c2', launchActivity: 'default'});
  });

  it('the displayed action ids round-trip through parseCallAction back to the callId', async () => {
    const callId = 'a3f1c9e2-uuid-with-dashes';
    await showIncomingCallNotif({callId, kind: 'group-voice', callerName: 'Ops', roomId: 'r1'});
    const actions = lastDisplayed().android.actions ?? [];
    const ids = actions.map(a => a.pressAction.id);
    expect(parseCallAction(ids.find(i => i.startsWith('decline-'))!)).toEqual({outcome: 'decline', callId});
    expect(parseCallAction(ids.find(i => i.startsWith('accept-'))!)).toEqual({outcome: 'accept', callId});
  });
});

describe('parseCallAction', () => {
  it('parses accept-/decline- prefixes, preserving dashes inside the callId', () => {
    expect(parseCallAction('accept-c-77')).toEqual({outcome: 'accept', callId: 'c-77'});
    expect(parseCallAction('decline-c-77')).toEqual({outcome: 'decline', callId: 'c-77'});
  });

  it("returns null for the body tap ('default') and for foreign action ids", () => {
    expect(parseCallAction('default')).toBeNull();
    expect(parseCallAction('read-conv1')).toBeNull();
    expect(parseCallAction('reply-conv1')).toBeNull();
    expect(parseCallAction('')).toBeNull();
  });
});

describe('dismissCallNotif — the single ring-exit funnel', () => {
  it('stops the ringtone FIRST, then cancels bravo-call-<id>', async () => {
    await dismissCallNotif('c9');
    expect(mockRingStop).toHaveBeenCalledWith('c9', 'dismiss');
    expect(mockCancelled).toEqual(['bravo-call-c9']);
    const stopAt = mockOrder.indexOf('ring-stop:c9');
    const cancelAt = mockOrder.indexOf('cancel:bravo-call-c9');
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(cancelAt).toBeGreaterThan(stopAt);
  });

  it('a throwing ringtone stop is contained — the card is still cancelled (never a stuck ring card)', async () => {
    mockRingStop.mockImplementationOnce(() => {
      throw new Error('binder died');
    });
    await expect(dismissCallNotif('c10')).resolves.toBeUndefined();
    expect(mockCancelled).toContain('bravo-call-c10');
  });
});

describe('showIncomingCallNotif — data block round-trip', () => {
  it('round-trips EVERY payload field as strings so tap handlers never re-query state', async () => {
    const p: IncomingCallNotifPayload = {
      callId: 'c-full-1',
      kind: 'group-video',
      callerName: 'Bravo Ops',
      remoteUserId: 'u-remote',
      remoteDeviceId: 3,
      incomingSdp: 'v=0 fake-offer-sdp',
      roomId: 'room-9',
      roomToken: 'tok-abc',
      conversationId: 'conv-7',
      fromUserId: 'u-caller',
    };
    await showIncomingCallNotif(p);
    const data = lastDisplayed().data;
    expect(data).toEqual({
      callId: 'c-full-1',
      kind: 'group-video',
      callerName: 'Bravo Ops',
      isGroup: '1',
      remoteUserId: 'u-remote',
      remoteDeviceId: '3',
      incomingSdp: 'v=0 fake-offer-sdp',
      roomId: 'room-9',
      roomToken: 'tok-abc',
      conversationId: 'conv-7',
      fromUserId: 'u-caller',
    });
    for (const v of Object.values(data)) {
      expect(typeof v).toBe('string'); // notifee data blocks are string-only
    }
  });

  it('remoteDeviceId 0 survives (falsy-number guard) and a minimal voice payload emits exactly the base keys', async () => {
    await showIncomingCallNotif({callId: 'c-dev0', kind: 'voice', callerName: 'X', remoteDeviceId: 0});
    expect(lastDisplayed().data.remoteDeviceId).toBe('0');

    await showIncomingCallNotif({callId: 'c-min', kind: 'voice', callerName: 'X'});
    expect(lastDisplayed().data).toEqual({
      callId: 'c-min',
      kind: 'voice',
      callerName: 'X',
      isGroup: '0',
    });
  });
});

describe('slim killed-app bg handler — headless decline acts on notification DATA alone', () => {
  const declineEvent = (callId: string, data: Record<string, string | undefined>): SlimBgEvent => ({
    type: EventType.ACTION_PRESS,
    detail: {notification: {data}, pressAction: {id: `decline-${callId}`}},
  });

  it('direct decline sends with peerUserId = data.fromUserId, then funnels through dismissCallNotif', async () => {
    await slimHandler()(
      declineEvent('c-slim', {callId: 'c-slim', kind: 'voice', isGroup: '0', fromUserId: 'u-caller'}),
    );
    expect(mockSendCallDecline).toHaveBeenCalledWith({
      callId: 'c-slim',
      kind: 'direct',
      peerUserId: 'u-caller',
    });
    expect(mockEnqueuePendingAction).not.toHaveBeenCalled();
    expect(mockRingStop).toHaveBeenCalledWith('c-slim', 'dismiss');
    expect(mockCancelled).toContain('bravo-call-c-slim');
  });

  it('a FAILED send durably enqueues the decline (the caller must not ring out because the network blinked)', async () => {
    mockSendCallDecline.mockResolvedValueOnce(false);
    await slimHandler()(
      declineEvent('c-slim2', {callId: 'c-slim2', kind: 'voice', isGroup: '0', fromUserId: 'u-caller'}),
    );
    expect(mockEnqueuePendingAction).toHaveBeenCalledWith({
      t: 'decline',
      callId: 'c-slim2',
      kind: 'direct',
      peerUserId: 'u-caller',
    });
    expect(mockCancelled).toContain('bravo-call-c-slim2');
  });

  it('a THROWING send also falls back to the durable enqueue', async () => {
    mockSendCallDecline.mockRejectedValueOnce(new Error('net down'));
    await slimHandler()(
      declineEvent('c-slim3', {callId: 'c-slim3', kind: 'voice', isGroup: '0', fromUserId: 'u-caller'}),
    );
    expect(mockEnqueuePendingAction).toHaveBeenCalledWith({
      t: 'decline',
      callId: 'c-slim3',
      kind: 'direct',
      peerUserId: 'u-caller',
    });
    expect(mockCancelled).toContain('bravo-call-c-slim3');
  });

  it('group decline sends kind group with the roomId from data', async () => {
    await slimHandler()(
      declineEvent('c-g1', {callId: 'c-g1', kind: 'group-voice', isGroup: '1', roomId: 'room-1'}),
    );
    expect(mockSendCallDecline).toHaveBeenCalledWith({
      callId: 'c-g1',
      kind: 'group',
      roomId: 'room-1',
    });
  });

  it('a body tap (pressAction default) dismisses the ring without sending a decline', async () => {
    await slimHandler()({
      type: EventType.PRESS,
      detail: {
        notification: {data: {callId: 'c-body', kind: 'voice', isGroup: '0', fromUserId: 'u-caller'}},
        pressAction: {id: 'default'},
      },
    });
    expect(mockSendCallDecline).not.toHaveBeenCalled();
    expect(mockEnqueuePendingAction).not.toHaveBeenCalled();
    expect(mockCancelled).toContain('bravo-call-c-body');
  });
});

// ── Static scan: the RICH handler's cold-cache decline dead-end ──────────────
// fcmBootstrap.ts transitively imports firebase/expo and cannot load under the
// node project, so the gap is pinned as text. CRLF-safe (/\r?\n/ split) and
// comment-stripped before every presence/absence assertion.

const FCM_BOOTSTRAP = path.join(__dirname, '..', 'push', 'fcmBootstrap.ts');

/** String-aware comment stripper (line + block); enough for the scanned region, which holds no regex literals. */
function stripComments(code: string): string {
  let out = '';
  let s: 'code' | 'line' | 'block' | "'" | '"' | '`' = 'code';
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    const n = code[i + 1];
    if (s === 'code') {
      if (c === '/' && n === '/') {
        s = 'line';
        i++;
        continue;
      }
      if (c === '/' && n === '*') {
        s = 'block';
        i++;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        s = c;
      }
      out += c;
    } else if (s === 'line') {
      if (c === '\n') {
        s = 'code';
        out += c;
      }
    } else if (s === 'block') {
      if (c === '*' && n === '/') {
        s = 'code';
        i++;
      } else if (c === '\n') {
        out += c;
      }
    } else {
      if (c === '\\') {
        out += c + (n ?? '');
        i++;
        continue;
      }
      if (c === s || (s !== '`' && c === '\n')) {
        s = 'code';
      }
      out += c;
    }
  }
  return out;
}

/** The rich handler's decline branch: from `if (action?.outcome === 'decline')` to its closing `return;`. */
function richDeclineRegion(): string {
  const raw = fs.readFileSync(FCM_BOOTSTRAP, 'utf8');
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex(l => l.includes("outcome === 'decline'"));
  expect(start).toBeGreaterThan(-1);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === 'return;') {
      end = i;
      break;
    }
  }
  expect(end).toBeGreaterThan(start);
  return stripComments(lines.slice(start, end + 1).join('\n'));
}

describe('rich handler (fcmBootstrap) decline — cold-cache dead-end', () => {
  it('the direct decline falls back to data.fromUserId when the in-memory cache is empty (B-228 fixed)', () => {
    // The window: FCM wake displayed the card in process A (populating the
    // in-memory incomingCallCache), the process restarted, the user logged in
    // (rich handler displaces the slim one), THEN tapped Decline. The cache is
    // empty, but fromUserId round-trips on the notification data (proven above),
    // so the direct branch now uses `payload?.fromUserId ?? data.fromUserId`
    // and sends call.hangup / durably enqueues instead of ringing out 45s.
    const region = richDeclineRegion();

    // Sanity: we grabbed the right block.
    expect(region).toContain('getIncomingCallPayload');
    expect(region).toContain('payload?.fromUserId');
    // Control: the group branch DOES fall back to notification data.
    expect(region).toContain('data.roomId');

    // THE FIX — the direct branch now consults notification data too, so a
    // cold-cache decline is no longer a dead-end.
    expect(region).toContain('data.fromUserId');
  });
});
