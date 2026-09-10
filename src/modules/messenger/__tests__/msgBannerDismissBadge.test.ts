/**
 * Message-banner dismiss / badge / id-keying parity (M-03, N-17, N-29/P3).
 *
 * Why this suite exists: the message banner surface has three id namespaces
 * (`bravo-msg-<conv>`, legacy `msg-wake:<conv>`, and the killed-path
 * `bravo-msg-sender:<uid>`) and every read/activation path must cancel ALL of
 * them or a banner outlives the read (the P3 killed-group residual). The
 * launcher badge (N-17) and the burst window (N-29/P3, the onlyAlertOnce
 * over-suppression fix) live on the same seam. Pins, per behavior:
 *
 *   - dismissMessageNotif cancels the conv id, the legacy id, the
 *     `direct:`-derived sender key, and every passed memberUserId — and
 *     cancels NOTHING without a conversationId.
 *   - showMessageNotif keys by conversationId over senderUserId (M-03) and an
 *     id-less banner is always allowed to alert (shouldAlert(undefined)).
 *   - badgeCount clamps to >= 0 and is OMITTED when unknown, so an unknown
 *     count never clobbers a real launcher badge.
 *   - the alert model (B-692 NL-2): a short per-thread floor instead of the
 *     old 10 s per-conversation gag; a messageId alerts at most once, ever
 *     (N-29); an alerted WAKE banner opens a collapse window that keeps the
 *     drain's named upgrades silent. The >500-entry bound evicts only expired
 *     windows, never an in-flight one — pinned below as the B-235 regression.
 *   - backgroundMessageNotifier: badge = sum of unread_count across ALL
 *     conversations; activating a thread cancels its banner including the
 *     participants' sender-keyed ids (onStoreChange active-conv branch).
 *
 * Store-level + unit tests with notifee/AppState mocked, same pattern as
 * backgroundMessageNotifier.test.ts.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
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
  Platform: {OS: 'android'},
  AppState: {
    currentState: 'background',
    addEventListener: jest.fn(() => ({remove: jest.fn()})),
  },
}));

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    displayNotification: jest.fn(async () => 'nid'),
    cancelNotification:  jest.fn(async () => {}),
    createChannel:       jest.fn(async () => 'bravo-messages'),
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

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import notifee from '@notifee/react-native';
import {useMessengerStore} from '../store/messengerStore';
import {
  startBackgroundMessageNotifier,
  stopBackgroundMessageNotifier,
} from '../push/backgroundMessageNotifier';
import {showMessageNotif, dismissMessageNotif} from '../push/callNotification';
import type {LocalConversation, LocalMessage} from '../store/types';

const display = notifee.displayNotification as jest.Mock;
const cancel  = notifee.cancelNotification as jest.Mock;

// The windows pinned by the static scan at the bottom of the alert describe.
const ALERT_FLOOR_MS = 1_500;
const WAKE_UPGRADE_SILENCE_MS = 10_000;

interface NotifArg {
  id?: string;
  title?: string;
  body?: string;
  data: Record<string, string | undefined>;
  android: {onlyAlertOnce?: boolean; badgeCount?: number; [k: string]: unknown};
}

function lastDisplayArg(): NotifArg {
  // B-692 NL-8 — the group summary now posts AFTER its member banner, so "the
  // last display" must skip it to keep meaning "the banner".
  const calls = display.mock.calls
    .map(c => c[0] as NotifArg)
    .filter(a => a.id !== 'bravo-msg-summary');
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1];
}

const flush = async () => {
  await new Promise<void>(r => setImmediate(r));
  await new Promise<void>(r => setImmediate(r));
};

function groupConv(id: string, extra?: Partial<LocalConversation>): LocalConversation {
  return {
    id,
    type:          'group',
    name:          `Group ${id}`,
    participants:  ['peer-1', 'peer-2'],
    unread_count:  0,
    is_muted:      false,
    created_at:    new Date('2026-07-01T00:00:00Z').toISOString(),
    peer:          {userId: '', deviceId: 0},
    session_state: 'established',
    ...extra,
  } as LocalConversation;
}

function inbound(id: string, conversationId: string, extra?: Partial<LocalMessage>): LocalMessage {
  return {
    id,
    conversation_id: conversationId,
    sender_id:       'peer-1',
    type:            'text',
    content:         'hello there',
    status:          'delivered',
    is_encrypted:    true,
    created_at:      new Date('2026-07-24T10:00:00Z').toISOString(),
    peer:            {userId: 'peer-1', deviceId: 1},
    ...extra,
  } as LocalMessage;
}

beforeEach(() => {
  jest.clearAllMocks();
  // GAP-1/GAP-2 — the conversation-card + group-summary accumulators are
  // module state; without this reset, ids posted by EARLIER tests keep the
  // summary machinery engaged and every "the last display is the banner"
  // assumption here reads the wrong notification.
  const {_resetMsgNotifStateForTest} = require('../push/callNotification') as typeof import('../push/callNotification');
  _resetMsgNotifStateForTest();
});

describe('dismissMessageNotif id parity (M-03/P3)', () => {
  it('cancels both the current bravo-msg-<conv> id and the legacy msg-wake:<conv> id', async () => {
    await dismissMessageNotif('conv-plain');
    expect(cancel).toHaveBeenCalledWith('msg-wake:conv-plain');
    expect(cancel).toHaveBeenCalledWith('bravo-msg-conv-plain');
    // Non-direct id, no members: nothing sender-keyed must be touched.
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('a direct:<peer> thread also clears the first-contact sender-keyed banner', async () => {
    await dismissMessageNotif('direct:peer-7');
    expect(cancel).toHaveBeenCalledWith('msg-wake:direct:peer-7');
    expect(cancel).toHaveBeenCalledWith('bravo-msg-direct:peer-7');
    expect(cancel).toHaveBeenCalledWith('bravo-msg-sender:peer-7');
    expect(cancel).toHaveBeenCalledTimes(3);
  });

  it('cancels a sender-keyed banner for EVERY passed memberUserId, skipping falsy ids', async () => {
    // P3 — a killed-app GROUP banner is keyed by its sender; reading the
    // thread must clear each member's sender-keyed id.
    await dismissMessageNotif('grp-9', ['member-a', '', 'member-b']);
    expect(cancel).toHaveBeenCalledWith('bravo-msg-sender:member-a');
    expect(cancel).toHaveBeenCalledWith('bravo-msg-sender:member-b');
    expect(cancel).not.toHaveBeenCalledWith('bravo-msg-sender:');
    // 2 base ids + 2 member keys, nothing else.
    expect(cancel).toHaveBeenCalledTimes(4);
  });

  it('without a conversationId it cancels NOTHING (guard), even when member ids are passed', async () => {
    await dismissMessageNotif(undefined, ['member-a']);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('showMessageNotif banner id keying (M-03)', () => {
  it('conversationId wins over senderUserId when both are present', async () => {
    await showMessageNotif({conversationId: 'conv-key-1', senderUserId: 'sender-key-1'});
    const arg = lastDisplayArg();
    expect(arg.id).toBe('bravo-msg-conv-key-1');
    expect(arg.id).not.toContain('sender');
    // The tap payload still carries both for routing.
    expect(arg.data.conversationId).toBe('conv-key-1');
    expect(arg.data.senderUserId).toBe('sender-key-1');
  });

  it('with neither id the banner is id-less and ALWAYS allowed to alert (shouldAlert(undefined))', async () => {
    await showMessageNotif({});
    let arg = lastDisplayArg();
    expect(arg.id).toBeUndefined();
    expect(arg.android.onlyAlertOnce).toBe(false);
    // An id-less banner has no burst record to suppress against — a second
    // immediate post must alert again, never be silently collapsed.
    await showMessageNotif({});
    arg = lastDisplayArg();
    expect(arg.android.onlyAlertOnce).toBe(false);
  });
});

describe('showMessageNotif launcher badge (N-17)', () => {
  it('clamps a negative badgeCount to 0', async () => {
    await showMessageNotif({conversationId: 'badge-neg', badgeCount: -5});
    expect(lastDisplayArg().android.badgeCount).toBe(0);
  });

  it('passes a real badgeCount through unchanged', async () => {
    await showMessageNotif({conversationId: 'badge-pos', badgeCount: 7});
    expect(lastDisplayArg().android.badgeCount).toBe(7);
  });

  it('OMITS badgeCount when unknown so it never clobbers a real launcher count', async () => {
    await showMessageNotif({conversationId: 'badge-unknown'});
    const arg = lastDisplayArg();
    expect('badgeCount' in arg.android).toBe(false);
  });
});

describe('the alert model (B-692 NL-2 — floor + per-message + wake collapse)', () => {
  let nowSpy: jest.SpyInstance<number, []> | null = null;
  const T0 = 1_800_000_000_000;

  afterEach(() => {
    nowSpy?.mockRestore();
    nowSpy = null;
  });

  it('same thread: alerts, floors a rapid follow-up, re-alerts once the floor elapses — the 10 s gag is gone', async () => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);
    await showMessageNotif({conversationId: 'floor-same'});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(false); // first post alerts

    nowSpy.mockReturnValue(T0 + ALERT_FLOOR_MS - 1);
    await showMessageNotif({conversationId: 'floor-same'});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(true); // inside the floor: silent update

    // Under the OLD model this stayed silent for 10 s — the founder's "the
    // notification isn't updating". The floor is measured from the last
    // ALERTED post; the suppressed update above must not have extended it.
    nowSpy.mockReturnValue(T0 + ALERT_FLOOR_MS);
    await showMessageNotif({conversationId: 'floor-same'});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(false);
  });

  it('a different thread always alerts, even while another id is inside its floor', async () => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);
    await showMessageNotif({conversationId: 'floor-a'});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(false);

    nowSpy.mockReturnValue(T0 + 500);
    await showMessageNotif({conversationId: 'floor-b'});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(false); // unaffected by floor-a's window
  });

  it('N-29 — a messageId alerts at most once, EVER: a re-post of the same row is silent even after the floor', async () => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);
    await showMessageNotif({conversationId: 'mid-conv', messageId: 'm-once'});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(false);

    nowSpy.mockReturnValue(T0 + 5_000); // well past the floor
    await showMessageNotif({conversationId: 'mid-conv', messageId: 'm-once'});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(true);

    // A DIFFERENT message in the same thread still alerts (that is the fix).
    await showMessageNotif({conversationId: 'mid-conv', messageId: 'm-two'});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(false);
  });

  it('an alerted WAKE banner opens the collapse window: named upgrades inside it stay silent; a suppressed post does not extend it', async () => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);
    await showMessageNotif({senderUserId: 'wk-sender', wakeFallback: true});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(false); // the wake's one sound

    // The drain's named upgrades land moments later — silent (the N-29
    // generic→named double-sound, without gagging live traffic).
    nowSpy.mockReturnValue(T0 + 3_000);
    await showMessageNotif({conversationId: 'wk-conv', senderUserId: 'wk-sender', messageId: 'wk-m1'});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(true);

    // B-710 — a DIFFERENT sender is no longer gagged. That is the fix: the
    // window exists to collapse ONE message's wake into its own named upgrade,
    // and both halves carry the same senderUserId.
    nowSpy.mockReturnValue(T0 + 4_000);
    await showMessageNotif({conversationId: 'wk-other', senderUserId: 'wk-sender2', messageId: 'wk-o1'});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(false);

    // Critic F4 — a SUPPRESSED wake post inside the window must not extend it,
    // or repeated fallback wakes become a self-perpetuating global gag. It has
    // to name the SAME sender now to be suppressed at all; the invariant this
    // case exists for is what the T0-relative assertions below prove.
    nowSpy.mockReturnValue(T0 + 5_000);
    await showMessageNotif({senderUserId: 'wk-sender', wakeFallback: true});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(true);

    nowSpy.mockReturnValue(T0 + WAKE_UPGRADE_SILENCE_MS - 1);
    await showMessageNotif({conversationId: 'wk-conv2', senderUserId: 'wk-sender', messageId: 'wk-m2'});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(true);

    nowSpy.mockReturnValue(T0 + WAKE_UPGRADE_SILENCE_MS);
    await showMessageNotif({conversationId: 'wk-conv3', senderUserId: 'wk-sender', messageId: 'wk-m3'});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(false); // measured from T0, NOT T0+5s

    // Critic F2 — a message the window silenced was never burned: its one
    // audible chance survives to a later post.
    nowSpy.mockReturnValue(T0 + WAKE_UPGRADE_SILENCE_MS + 5_000);
    await showMessageNotif({conversationId: 'wk-conv', senderUserId: 'wk-sender', messageId: 'wk-m1'});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(false);
  });

  it('B-703 MR-19 — a draw that FAILED gives its alert budget back', async () => {
    // The budget is spent BEFORE the display (the answer shapes the payload).
    // A refused display therefore used to burn the message's one-sound-ever
    // record and open the thread's 1.5 s floor for a banner nobody saw — so the
    // fallback posted moments later on the same id came out SILENT, which is
    // the "notification arrives but never makes a sound" half of the report.
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);

    display.mockImplementationOnce(async () => { throw new Error('display refused'); });
    expect(await showMessageNotif({conversationId: 'fa-conv', messageId: 'fa-m1'})).toBe(false);

    // Same message, same thread, well inside the 1.5 s floor: it has still
    // never sounded, so it must be allowed to.
    nowSpy.mockReturnValue(T0 + 200);
    expect(await showMessageNotif({conversationId: 'fa-conv', messageId: 'fa-m1'})).toBe(true);
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(false);

    // ...and the rollback is not a licence to re-sound: now that it HAS
    // sounded, the once-ever record holds.
    nowSpy.mockReturnValue(T0 + 5_000);
    await showMessageNotif({conversationId: 'fa-conv', messageId: 'fa-m1'});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(true);
  });

  it('DOCUMENTS B-703 MR-10 — the wake fallback and the named card are DIFFERENT notifee ids', async () => {
    // MR-10 was filed as "the generic wake banner collapses onto the named
    // card's id and replaces it". It does not, on the payload the server
    // actually sends: no chat wake carries a conversationId
    // (messenger.gateway.ts / envelope.controller.ts pass only senderUserId),
    // so the fallback is sender-keyed while the store notifier's card is
    // conversation-keyed. The duplicate is a SECOND shade entry, not a
    // downgrade — which is why the "re-render the retained card" branch was
    // removed rather than kept as dead code with live privacy hazards
    // (a swiped-away banner and a signed-out account both leave the retained
    // decrypted preview in place).
    //
    // If the server is ever changed to name the conversation, the ids collide,
    // the downgrade becomes real, and THIS TEST MUST BECOME the assertion that
    // the named card survives — with those hazards fixed first.
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);
    await showMessageNotif({
      conversationId: 'dg-conv', title: 'Ops Team', body: 'see you at 6', senderName: 'Alice',
    });
    expect(lastDisplayArg().id).toBe('bravo-msg-dg-conv');

    nowSpy.mockReturnValue(T0 + 400);
    await showMessageNotif({senderUserId: 'peer-9', wakeFallback: true});

    const arg = lastDisplayArg();
    expect(arg.id).toBe('bravo-msg-sender:peer-9');
    expect(arg.title).toBe('New secure message');
  });

  // B-710 — RE-POINTED, exactly as the DOCUMENTS case above instructed: "if the
  // ids collide, the downgrade becomes real, and THIS TEST MUST BECOME the
  // assertion that the named card survives — with those hazards fixed first."
  // The ids DO collide: `fcmHeadless` resolves a DM's conversation id locally
  // (`mutedLookup.resolveDirectConversation`) and passes it, so the killed-lane
  // wake shares the store notifier's id on the commonest shape there is. The
  // three hazards are answered — dismissal is observed now
  // (`noteMessageNotifDismissed`), sender-keyed ids never retain, and a retained
  // re-render never alerts.
  it('B-710 — a conversation-keyed generic draw re-renders the card instead of erasing it', async () => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);
    await showMessageNotif({
      conversationId: 'ng-conv', title: 'Ops Team', body: 'see you at 6', senderName: 'Alice',
    });
    nowSpy.mockReturnValue(T0 + 400);
    await showMessageNotif({conversationId: 'ng-conv', wakeFallback: true});

    const arg = lastDisplayArg();
    expect(arg.title).toBe('Ops Team');
    expect(arg.body).toBe('see you at 6');
    expect((arg.android.style as {messages: Array<{text: string}>}).messages.map(m => m.text)).toEqual(['see you at 6']);
    expect(arg.android.onlyAlertOnce).toBe(true); // announces no new row, spends no budget
  });

  it('B-710 — a SENDER-keyed generic draw still stays generic (one sender spans many threads)', async () => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);
    await showMessageNotif({
      senderUserId: 'ns-peer', title: 'Alice', body: 'see you at 6', senderName: 'Alice',
    });
    nowSpy.mockReturnValue(T0 + 400);
    await showMessageNotif({senderUserId: 'ns-peer', wakeFallback: true});

    const arg = lastDisplayArg();
    expect(arg.title).toBe('New secure message');
    expect(arg.body).toBe('Open Bravo Secure to read it');
    expect(arg.android.style).toBeUndefined();
  });

  it('B-703 MR-19 — a failed WAKE draw does not arm the 10 s global gag', async () => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);

    display.mockImplementationOnce(async () => { throw new Error('display refused'); });
    await showMessageNotif({senderUserId: 'wf-sender', wakeFallback: true});

    // Nothing was shown, so nothing may silence every other conversation for
    // the next ten seconds.
    nowSpy.mockReturnValue(T0 + 1_000);
    await showMessageNotif({conversationId: 'wf-other', messageId: 'wf-m1'});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(false);
  });

  it('a store post (no wakeFallback) never opens the collapse window', async () => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);
    await showMessageNotif({conversationId: 'st-a', messageId: 'st-m1'});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(false);

    // If the post above had stamped the wake window, this would be silent —
    // the exact regression that would re-create the 10 s gag for live traffic.
    nowSpy.mockReturnValue(T0 + 100);
    await showMessageNotif({conversationId: 'st-b', messageId: 'st-m2'});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(false);
  });

  it('static scan: the model constants + every generic wake draw carries wakeFallback', () => {
    // shouldAlert and its windows are module-private by design; pin the values
    // by source scan so a silent retune cannot leave this suite testing stale
    // windows. CRLF-safe: no \n anchoring.
    const src = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'push', 'callNotification.ts'),
      'utf8',
    );
    expect(src).toMatch(/const ALERT_FLOOR_MS\s*=\s*1_500\b/);
    expect(src).toMatch(/const WAKE_UPGRADE_SILENCE_MS\s*=\s*10_000\b/);
    expect(src).toMatch(/const ALERTED_MSG_TTL_MS\s*=\s*60_000\b/);

    // The collapse only works if the wake draws SET the flag: one in the
    // killed fallback, one in each fcmBootstrap lane (direct draw + the P2-6
    // ternary's two branches).
    const headless = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'push', 'fcmHeadless.ts'),
      'utf8',
    );
    expect(headless.match(/wakeFallback: true/g) ?? []).toHaveLength(1);
    const bootstrap = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts'),
      'utf8',
    );
    expect(bootstrap.match(/wakeFallback: true/g) ?? []).toHaveLength(3);
  });

  it('tripping the >500-entry bound must NOT reset an in-flight floor window (B-235 fixed)', async () => {
    // B-235: the bound was `if (size > 500) lastAlertAtById.clear()` — a
    // wholesale reset that forgot every in-flight window, so a just-alerted id
    // re-alerted (heads-up + sound) inside its window the moment 500 other ids
    // tripped the bound — spam under exactly the load the bound exists for.
    // The fix evicts only entries whose window has already elapsed, so a
    // still-active window survives the bound.
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);
    await showMessageNotif({conversationId: 'bound-victim'});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(false); // window opens at T0

    nowSpy.mockReturnValue(T0 + 1_000);
    await showMessageNotif({conversationId: 'bound-victim'});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(true); // still suppressed pre-trip

    // Flood enough UNIQUE ids to trip the bound regardless of what earlier
    // tests left in the map. Each filler is a different id, so each alerts.
    // (All posted at T0+1s, so none is expired when the bound trips.)
    for (let i = 0; i < 520; i++) {
      await showMessageNotif({conversationId: `bound-fill-${i}`});
      expect(lastDisplayArg().android.onlyAlertOnce).toBe(false);
    }

    // Still inside the victim's floor (1.4 s < 1.5 s), and its record survived
    // the bound (not expired), so the re-post stays a silent update.
    nowSpy.mockReturnValue(T0 + ALERT_FLOOR_MS - 100);
    await showMessageNotif({conversationId: 'bound-victim'});
    expect(lastDisplayArg().android.onlyAlertOnce).toBe(true);
  });
});

describe('backgroundMessageNotifier badge + activation cleanup (N-17/P3)', () => {
  beforeEach(() => {
    useMessengerStore.getState().reset();
    useMessengerStore.getState().setOwner('owner-1');
  });

  afterEach(() => {
    stopBackgroundMessageNotifier();
  });

  it('N-17: a posted banner carries badgeCount = sum of unread_count across ALL conversations', async () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('bg-a', {unread_count: 3}));
    s.upsertConversation(groupConv('bg-b'));
    startBackgroundMessageNotifier();

    useMessengerStore.getState().appendMessage('bg-b', inbound('m-badge', 'bg-b'));
    await flush();

    expect(display).toHaveBeenCalledTimes(1);
    const arg = lastDisplayArg();
    expect(arg.id).toBe('bravo-msg-bg-b');
    // bg-a keeps its 3; the append bumps bg-b to 1 → total 4.
    expect(arg.android.badgeCount).toBe(4);
  });

  it('P3: activating a thread cancels its banner AND its participants sender-keyed banners, even when this notifier posted nothing', async () => {
    // The killed-path sender-keyed group banner was drawn by fcmHeadless, not
    // by this notifier — the active-conv branch must clear it anyway.
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('act-1'));
    startBackgroundMessageNotifier();
    expect(display).not.toHaveBeenCalled();

    useMessengerStore.getState().setActiveConversation('act-1');
    await flush();

    expect(cancel).toHaveBeenCalledWith('msg-wake:act-1');
    expect(cancel).toHaveBeenCalledWith('bravo-msg-act-1');
    expect(cancel).toHaveBeenCalledWith('bravo-msg-sender:peer-1');
    expect(cancel).toHaveBeenCalledWith('bravo-msg-sender:peer-2');
  });
});
