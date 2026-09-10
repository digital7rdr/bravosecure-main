/**
 * sqa.md bug register — this suite pins: B-132.
 *
 * B-132 (a late-arriving message produced NO notification: the notifier tracked ONE id per
 * conversation — the TAIL id — but appendMessage binary-splices an out-of-order row into
 * send order, leaving the tail unchanged) is pinned by the two M16 cases: an out-of-order
 * late-drained message still notifies, and a status flip on an existing row does not
 * re-notify.
 */
/**
 * Audit 2026-07-06 M-04 — store-driven warm-path message banners.
 *
 * Sealed sender hides the conversation from a group msg-wake, so group
 * collapse/mute/tap is driven off messengerStore instead: while the app is
 * backgrounded, a NEW inbound message in a non-muted, non-active conversation
 * posts a conv-keyed notifee banner; read/activation and foregrounding cancel
 * it. Store-level tests with notifee + AppState mocked.
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

// B-411 tests append DIRECT rows with no avatar, which queues the notifier's
// fire-and-forget directory backfill; its 300 ms debounce timer would fire
// after teardown with no users client configured and fail the run as an
// unhandled rejection. The backfill is decorative here — stub it.
jest.mock('../contacts/directoryNames', () => ({
  __esModule: true,
  ensureDirectoryNames: jest.fn(),
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
  AndroidStyle:      {BIGTEXT: 1},
  EventType:         {PRESS: 1, ACTION_PRESS: 2},
}));

import {AppState} from 'react-native';
import notifee from '@notifee/react-native';
import {useMessengerStore} from '../store/messengerStore';
import {
  startBackgroundMessageNotifier,
  stopBackgroundMessageNotifier,
  setContentPreviewEnabled,
  getMessagePostedGeneration,
  snapshotCues,
  cueDeliveredSince,
  armBackgroundMessageNotifier,
  _resetCueWitnessForTests,
} from '../push/backgroundMessageNotifier';
import {showMessageNotif, dismissMessageNotif} from '../push/callNotification';
import type {LocalConversation, LocalMessage} from '../store/types';

const display = notifee.displayNotification as jest.Mock;
const cancel  = notifee.cancelNotification as jest.Mock;

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
    content:         'super secret plaintext body',
    status:          'delivered',
    is_encrypted:    true,
    created_at:      new Date('2026-07-06T10:00:00Z').toISOString(),
    peer:            {userId: 'peer-1', deviceId: 1},
    ...extra,
  } as LocalMessage;
}

describe('backgroundMessageNotifier (M-04)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AppState as unknown as {currentState: string}).currentState = 'background';
    useMessengerStore.getState().reset();
    useMessengerStore.getState().setOwner('owner-1');
    // GAP-1/GAP-2 — reset the conversation-card/group-summary module state so
    // earlier tests' posted ids don't engage the summary here.
    try {
      const {_resetMsgNotifStateForTest} = require('../push/callNotification') as typeof import('../push/callNotification');
      _resetMsgNotifStateForTest();
    } catch { /* module mocked away in some configs */ }
  });

  afterEach(() => {
    stopBackgroundMessageNotifier();
  });

  it('posts a conv-keyed banner with a content preview (B-65 default ON) for a new inbound group message while backgrounded', async () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g1', {name: 'Ops Team'}));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();

    expect(display).toHaveBeenCalledTimes(1);
    const arg = display.mock.calls[0][0];
    expect(arg.id).toBe('bravo-msg-g1');
    expect(arg.title).toBe('Ops Team');
    expect(arg.data.conversationId).toBe('g1');
    // B-65 — preview default ON (Telegram/WhatsApp parity): the locally-
    // decrypted body IS the banner text (visibility PRIVATE redacts it on a
    // secure lock screen).
    expect(arg.body).toBe('super secret plaintext body');
  });

  it('opt-out (preview disabled) keeps plaintext out of the banner', async () => {
    setContentPreviewEnabled(false);
    try {
      const s = useMessengerStore.getState();
      s.upsertConversation(groupConv('g1', {name: 'Ops Team'}));
      startBackgroundMessageNotifier();
      useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
      await flush();

      expect(display).toHaveBeenCalledTimes(1);
      const arg = display.mock.calls[0][0];
      expect(arg.title).toBe('Ops Team');
      // The privacy guarantee, now opt-in: no plaintext anywhere in the payload.
      expect(JSON.stringify(arg)).not.toContain('super secret plaintext body');
    } finally {
      setContentPreviewEnabled(true); // restore the B-65 default for other tests
    }
  });

  it('B-327 — the sender\'s directory photo rides the banner as the Person icon', async () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g1', {name: 'Ops Team'}));
    useMessengerStore.setState({
      groupMemberNames: {g1: {'peer-1': 'Alice'}},
      directoryAvatars: {'peer-1': 'https://cdn.test/alice.jpg'},
    } as never);
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();

    expect(display).toHaveBeenCalledTimes(1);
    const arg = display.mock.calls[0][0];
    expect(arg.android.style.messages[0].person).toEqual({name: 'Alice', icon: 'https://cdn.test/alice.jpg'});
  });

  it('B-328 — a group sender with NO resolvable name NEVER borrows the group title as their name', async () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g1', {name: 'Ops Team'}));
    // No groupMemberNames, no directoryNames for peer-1 — the cold-headless shape.
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();

    expect(display).toHaveBeenCalledTimes(1);
    const person = display.mock.calls[0][0].android.style.messages[0].person;
    // 'Ops Team' as the sender models the GROUP as the author — the founder's
    // "who sent the msg is showing fault". A neutral label is honest; the
    // directory backfill upgrades the next banner to the real name.
    expect(person.name).not.toBe('Ops Team');
    expect(person.name).toBe('Member');
  });

  it('suppresses banners for a MUTED conversation', async () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g1', {is_muted: true}));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    expect(display).not.toHaveBeenCalled();
  });

  it('suppresses banners for own (self) messages', async () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m2', 'g1', {sender_id: 'self'}));
    await flush();
    expect(display).not.toHaveBeenCalled();
  });

  it('B-703 MR-11 — an ACTIVE conversation is silenced only while the app is ON SCREEN', async () => {
    // Re-pointed, not deleted. This case used to assert the opposite: a
    // message into the "active" thread drew nothing EVEN BACKGROUNDED, which
    // is the founder's "press Home from inside a chat and get no notification"
    // report. `activeConversationId` means "the user is reading this right
    // now"; backgrounded, they are not.
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().setActiveConversation('g1');

    // B-356 — a raw 'background' reading is not evidence the user left (a
    // notification-launched VM reports one while they are reading). Only an
    // OBSERVED transition is, so drive the notifier's own AppState listener.
    (AppState as unknown as {currentState: string}).currentState = 'background';
    const onAppState = (AppState.addEventListener as jest.Mock).mock.calls[0][1] as (st: string) => void;
    onAppState('background');
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    expect(display).toHaveBeenCalledTimes(1);
    expect(display.mock.calls[0][0].id).toBe('bravo-msg-g1');

    // ...and on screen it still routes in-app instead of to the shade.
    display.mockClear();
    (AppState as unknown as {currentState: string}).currentState = 'active';
    onAppState('active');
    useMessengerStore.getState().appendMessage('g1', inbound('m3', 'g1'));
    await flush();
    expect(display).not.toHaveBeenCalled();
  });

  it('B-356 — an UNCONFIRMED background reading keeps the active thread silent', async () => {
    // The notification-cold-launch window: currentState still says
    // 'background' while the user is looking at the thread, and no 'change'
    // event has corrected it yet. Bannering here would ding the chat on screen.
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().setActiveConversation('g1');

    (AppState as unknown as {currentState: string}).currentState = 'background';
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();

    expect(display).not.toHaveBeenCalled();
  });

  it('suppresses banners while the app is foregrounded (active)', async () => {
    (AppState as unknown as {currentState: string}).currentState = 'active';
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    expect(display).not.toHaveBeenCalled();
  });

  it('cancels the banner when its conversation is activated (read)', async () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    expect(display).toHaveBeenCalledTimes(1);

    useMessengerStore.getState().setActiveConversation('g1');
    await flush();
    expect(cancel).toHaveBeenCalledWith('bravo-msg-g1');
  });

  it('cancels all posted banners when the app foregrounds', async () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    const appStateCb = (AppState.addEventListener as jest.Mock).mock.calls[0][1] as (st: string) => void;
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    expect(display).toHaveBeenCalledTimes(1);

    appStateCb('active');
    await flush();
    expect(cancel).toHaveBeenCalledWith('bravo-msg-g1');
  });

  it('does not replay bulk boot hydration as banners', async () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g2'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().hydrateMessages({
      g2: [inbound('h1', 'g2'), inbound('h2', 'g2')],
    });
    await flush();
    expect(display).not.toHaveBeenCalled();
    // But a LIVE append after hydration still notifies.
    useMessengerStore.getState().appendMessage('g2', inbound('m3', 'g2', {
      created_at: new Date('2026-07-06T11:00:00Z').toISOString(),
    }));
    await flush();
    expect(display).toHaveBeenCalledTimes(1);
  });

  it('M16 — an out-of-order (late-drained) message still notifies', async () => {
    // appendMessage binary-splices a late row into SEND order rather than
    // pushing it, so a message that was stashed while offline lands MID-list
    // and leaves the tail id unchanged. The old tail watermark matched and we
    // bailed — no banner, no badge, for exactly the messages most likely to
    // need one. See docs/runbooks/MESSAGE_LOOP.md M16 / W29.
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g3'));
    startBackgroundMessageNotifier();

    useMessengerStore.getState().appendMessage('g3', inbound('live', 'g3', {
      created_at: new Date('2026-07-06T12:00:00Z').toISOString(),
    }));
    await flush();
    expect(display).toHaveBeenCalledTimes(1);

    // Arrives now, but was SENT earlier ⇒ spliced in before 'live'.
    useMessengerStore.getState().appendMessage('g3', inbound('drained', 'g3', {
      created_at: new Date('2026-07-06T11:00:00Z').toISOString(),
    }));
    await flush();
    expect(display).toHaveBeenCalledTimes(2);
  });

  it('M16 — a status flip on an existing row does NOT re-notify', async () => {
    // The seen-id set must not turn every store mutation into a banner: only a
    // genuinely NEW id counts. A read-receipt/status flip rewrites the row
    // object but keeps its id.
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g4'));
    startBackgroundMessageNotifier();

    useMessengerStore.getState().appendMessage('g4', inbound('m1', 'g4'));
    await flush();
    expect(display).toHaveBeenCalledTimes(1);

    useMessengerStore.getState().updateMessageStatus('g4', 'm1', 'read');
    await flush();
    expect(display).toHaveBeenCalledTimes(1);
  });

  it('M16: a message whose receive txn ROLLS BACK produces no banner', async () => {
    // Zustand notifies synchronously from inside the immer producer, and the
    // inbound append runs inside BEGIN IMMEDIATE. Before this, the banner fired
    // while the row was still uncommitted — a rollback then removed the message
    // but left the notification, so tapping it opened nothing.
    const {runWithRatchetTxn} = require('../runtime/receiveTransaction') as
      typeof import('../runtime/receiveTransaction');
    const db = {async execute(sql: string) {
      if (/^COMMIT/i.test(sql)) {throw new Error('disk full');}
      return undefined;
    }};

    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g9'));
    startBackgroundMessageNotifier();

    await expect(runWithRatchetTxn(db as never, async () => {
      useMessengerStore.getState().appendMessage('g9', inbound('rolled', 'g9'));
    })).rejects.toThrow('disk full');
    await flush();

    expect(display).not.toHaveBeenCalled();
  });

  it('M16: a message whose receive txn COMMITS still notifies', async () => {
    // The control. Deferral must not silence the normal path.
    const {runWithRatchetTxn} = require('../runtime/receiveTransaction') as
      typeof import('../runtime/receiveTransaction');
    const db = {async execute() {return undefined;}};

    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g10'));
    startBackgroundMessageNotifier();

    await runWithRatchetTxn(db as never, async () => {
      useMessengerStore.getState().appendMessage('g10', inbound('kept', 'g10'));
    });
    await flush();

    expect(display).toHaveBeenCalledTimes(1);
  });

  it('B-698 — a SYSTEM event row never banners; the next real message still does', async () => {
    // Founder screenshot 2026-08-29: "Member 7f8f75 added Member bc9bc9"
    // bannered (with tone) on every app open — a re-minted membership event
    // row whose raw-userId sender_id also passes the 'self' filter. System
    // rows are thread furniture: watermark them, never alert them.
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g1', {name: 'Ops Team'}));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('sys:add:g1:u2:7', 'g1', {
      type:      'system',
      sender_id: '7f8f75aa-0000-0000-0000-000000000000',
      content:   'Member 7f8f75 added Member bc9bc9',
      event:     {kind: 'member_added', actorUserId: '7f8f75aa', memberUserId: 'bc9bc9aa'},
    } as Partial<LocalMessage>));
    await flush();
    expect(display).not.toHaveBeenCalled();

    // The filter must not eat the REAL arrival that follows (W29 spirit:
    // every committed MESSAGE still notifies).
    useMessengerStore.getState().appendMessage('g1', inbound('m-real', 'g1'));
    await flush();
    expect(display).toHaveBeenCalledTimes(1);
    expect(display.mock.calls[0][0].data.conversationId).toBe('g1');
  });

  it('stops notifying after stop()', async () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    stopBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    expect(display).not.toHaveBeenCalled();
  });
});

describe('showMessageNotif ids (M-03)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // GAP-2 — ids posted by earlier tests otherwise engage the group summary,
    // and calls[0] stops being the banner.
    const {_resetMsgNotifStateForTest} = require('../push/callNotification') as typeof import('../push/callNotification');
    _resetMsgNotifStateForTest();
  });

  it('keys by conversation when resolvable', async () => {
    await showMessageNotif({conversationId: 'c9', senderUserId: 'u9'});
    const arg = display.mock.calls[0][0];
    expect(arg.id).toBe('bravo-msg-c9');
    expect(arg.data.conversationId).toBe('c9');
  });

  it('falls back to a sender-keyed id (bounded stacking) with NO conversationId in tap data', async () => {
    await showMessageNotif({senderUserId: 'u9'});
    const arg = display.mock.calls[0][0];
    expect(arg.id).toBe('bravo-msg-sender:u9');
    expect(arg.data.conversationId).toBeUndefined();
  });

  it('dismissMessageNotif on a direct thread also clears the first-contact sender-keyed banner', async () => {
    await dismissMessageNotif('direct:u9');
    expect(cancel).toHaveBeenCalledWith('bravo-msg-direct:u9');
    expect(cancel).toHaveBeenCalledWith('bravo-msg-sender:u9');
  });
});

// B-411 — the warm-lane title rule: the `Bravo · <hex>` placeholder never
// reaches a banner; a directory-sourced name is tagged "· Unsaved"; an
// address-book name renders plain.
describe('warm banner titles for unsaved/placeholder 1:1 rows (B-411)', () => {
  const PEER = 'deadbeef-1111-2222-3333-444455556666';
  const CONV = `direct:${PEER}`;

  function directConv(extra?: Partial<LocalConversation>): LocalConversation {
    return {
      id:            CONV,
      type:          'direct',
      name:          `Bravo · ${PEER.slice(0, 8)}`,
      name_source:   'placeholder',
      participants:  [PEER],
      unread_count:  0,
      is_muted:      false,
      created_at:    new Date('2026-08-09T00:00:00Z').toISOString(),
      peer:          {userId: PEER, deviceId: 1},
      session_state: 'established',
      ...extra,
    } as LocalConversation;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (AppState as unknown as {currentState: string}).currentState = 'background';
    useMessengerStore.getState().reset();
    useMessengerStore.getState().setOwner('owner-1');
    try {
      const {_resetMsgNotifStateForTest} = require('../push/callNotification') as typeof import('../push/callNotification');
      _resetMsgNotifStateForTest();
    } catch { /* module mocked away in some configs */ }
  });

  afterEach(() => { stopBackgroundMessageNotifier(); });

  async function bannerFor(conv: LocalConversation, directoryName?: string): Promise<{title?: string}> {
    const s = useMessengerStore.getState();
    s.upsertConversation(conv);
    if (directoryName) {s.setDirectoryNames({[PEER]: directoryName});}
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage(CONV, inbound('m1', CONV, {sender_id: PEER, peer: {userId: PEER, deviceId: 1}}));
    await flush();
    expect(display).toHaveBeenCalledTimes(1);
    return display.mock.calls[0][0];
  }

  it('placeholder row + cold directory → generic title, the hex NEVER renders', async () => {
    const arg = await bannerFor(directConv());
    expect(String(arg.title)).not.toContain('Bravo · ');
    expect(String(arg.title)).not.toContain(PEER.slice(0, 8));
  });

  it('placeholder row + known phone → the phone', async () => {
    const arg = await bannerFor(directConv({phoneE164: '+8801711000000'}));
    expect(arg.title).toBe('+8801711000000');
  });

  it('placeholder row + resolved directory name → tagged "· Unsaved"', async () => {
    const arg = await bannerFor(directConv(), 'Jack Bravo');
    expect(arg.title).toBe('Jack Bravo · Unsaved');
  });

  it("registered-name row (name_source 'profile') → tagged; address-book row ('contact') → plain", async () => {
    const arg = await bannerFor(directConv({name: 'John Doe', name_source: 'profile'}));
    expect(arg.title).toBe('John Doe · Unsaved');
    stopBackgroundMessageNotifier();
    display.mockClear();
    useMessengerStore.getState().reset();
    useMessengerStore.getState().setOwner('owner-1');
    const arg2 = await bannerFor(directConv({name: 'John Doe', name_source: 'contact'}));
    expect(arg2.title).toBe('John Doe');
  });

  it('pre-migration row (real name, NO flag) renders plain — never a wrong Unsaved tag', async () => {
    const arg = await bannerFor(directConv({name: 'Sahana Begum', name_source: undefined}));
    expect(arg.title).toBe('Sahana Begum');
  });
});

/**
 * B-703 MR-19 — the FCM wake lanes ask "did the user actually get a cue?"
 * before drawing their own generic fallback. They used to ask a weaker
 * question — "did the generation move?" — which the notifier bumps
 * synchronously, BEFORE the native display, and never took back when the
 * display failed. So a banner that never reached the shade suppressed the one
 * draw that exists to guarantee a real message is never fully silent.
 */
describe('B-703 MR-19 — the cue witness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AppState as unknown as {currentState: string}).currentState = 'background';
    useMessengerStore.getState().reset();
    useMessengerStore.getState().setOwner('owner-1');
    _resetCueWitnessForTests();
    try {
      const {_resetMsgNotifStateForTest} = require('../push/callNotification') as typeof import('../push/callNotification');
      _resetMsgNotifStateForTest();
    } catch { /* module mocked away in some configs */ }
  });

  afterEach(() => {
    stopBackgroundMessageNotifier();
    display.mockImplementation(async () => 'nid');
  });

  it('a banner that lands counts as a delivered cue', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    const before = snapshotCues();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();

    expect(display).toHaveBeenCalledTimes(1);
    expect(await cueDeliveredSince(before)).toBe(true);
  });

  it('a display that FAILS does not — though the generation still advanced', async () => {
    display.mockImplementationOnce(async () => { throw new Error('channel blocked'); });
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    const before = snapshotCues();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();

    // The bump stays unconditional and synchronous ON PURPOSE (a bump below the
    // native round-trip makes the wake lanes double-banner), so the generation
    // alone cannot answer the question...
    expect(getMessagePostedGeneration()).toBe(before.gen + 1);
    // ...and this is what the fallback must see instead.
    expect(await cueDeliveredSince(before)).toBe(false);
  });

  it('waits for an in-flight draw instead of judging it early', async () => {
    // The draw must FAIL for this to pin anything: the generation is bumped
    // synchronously inside appendMessage (onAfterCommit runs inline outside a
    // txn), so a draw that merely settles LATE answers `true` with or without
    // the wait. Only a late FAILURE distinguishes them.
    let fail: (e: Error) => void = () => {};
    display.mockImplementationOnce(() => new Promise<string>((_r, rej) => { fail = rej; }));
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    const before = snapshotCues('g1');
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    // Let the draw reach the native call — `showMessageNotif` awaits the
    // channel first, so before this the reject handle is not even bound.
    await flush();
    expect(display).toHaveBeenCalledTimes(1);

    // The consumer resumes from its own await while the native call is still
    // in flight. Without the wait it reads "generation moved, no failures yet"
    // and suppresses the fallback for a banner that is about to be refused.
    const verdict = cueDeliveredSince(before);
    fail(new Error('binder died'));
    expect(await verdict).toBe(false);
  });

  it('B-703 MR-19/F5 — a failure in ANOTHER thread does not answer this thread\'s question', async () => {
    // The fallback is keyed to the wake's conversation, so a cross-thread
    // "false" does not add a banner — it REPLACES this thread's rich card with
    // the generic line and arms the 10 s global alert-collapse window.
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    useMessengerStore.getState().upsertConversation(groupConv('g2'));
    startBackgroundMessageNotifier();
    const before = snapshotCues('g1');

    display.mockImplementationOnce(async () => 'nid');                       // g1 lands
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    display.mockImplementationOnce(async () => { throw new Error('nope'); }); // g2 fails
    useMessengerStore.getState().appendMessage('g2', inbound('m2', 'g2'));
    await flush();

    expect(await cueDeliveredSince(before)).toBe(true);
    // ...and the thread that actually missed still gets its fallback.
    expect(await cueDeliveredSince(snapshotCues('g2'))).toBe(false);
  });

  it('B-703 MR-19/F1 — a foreground route with NO banner host mounted is not a cue', async () => {
    // notifyForegroundMessage swallows every side effect it owns, so it cannot
    // throw: with no host mounted it returned silently and was counted as a
    // banner the user saw. Only its RETURN can answer.
    (AppState as unknown as {currentState: string}).currentState = 'active';
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    const before = snapshotCues('g1');
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();

    expect(display).not.toHaveBeenCalled();       // foreground routes in-app, not notifee
    expect(await cueDeliveredSince(before)).toBe(false);
  });

  it('fails open — a hung draw must not park the wake lane forever', async () => {
    display.mockImplementationOnce(() => new Promise<string>(() => {}));
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    const before = snapshotCues();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));

    // Budget expires; the generation moved and nothing has reported a failure,
    // so the answer is the optimistic one — a duplicate banner is the cost of
    // guessing wrong here, and a wake lane blocked on a native promise is not
    // a cost we can pay at all.
    expect(await cueDeliveredSince(before, {budgetMs: 5})).toBe(true);
  });
});

/**
 * B-703 MR-10 — the wake that duplicates, downgrades and gags.
 *
 * The server fires the FCM wake without consulting whether live WS delivery
 * succeeded, so for every HTTP-path send (all group fan-out) a backgrounded-
 * but-connected recipient ingests over the socket and banners FIRST, and the
 * wake handler runs afterwards. A snapshot taken at handler entry cannot see
 * that cue — it already happened — so the handler concluded "nothing drew" and
 * posted a second, generic banner on the SAME notifee id.
 */
describe('B-703 MR-10 — one cue, one wake (a claim ledger, not a time window)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AppState as unknown as {currentState: string}).currentState = 'background';
    useMessengerStore.getState().reset();
    useMessengerStore.getState().setOwner('owner-1');
    _resetCueWitnessForTests();
    try {
      const {_resetMsgNotifStateForTest} = require('../push/callNotification') as typeof import('../push/callNotification');
      _resetMsgNotifStateForTest();
    } catch { /* module mocked away in some configs */ }
  });

  afterEach(() => {
    stopBackgroundMessageNotifier();
    display.mockImplementation(async () => 'nid');
  });

  it('a banner drawn BEFORE the snapshot answers the wake', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    // The live WS lane banners...
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    expect(display).toHaveBeenCalledTimes(1);

    // ...and only THEN does the wake handler start and take its snapshot, so
    // the counters it compares cannot see the cue that already happened.
    expect(await cueDeliveredSince(snapshotCues(), {senderUserId: 'peer-1'})).toBe(true);
  });

  it('ONE cue answers ONE wake — the second wake of a burst is not silenced', async () => {
    // This is the case a recency window gets wrong, and the reason there is no
    // window here. msg1 is cued; msg2 arrives seconds later and its pull fails,
    // so nothing is drawn for it. A window wide enough to cover push latency
    // still "sees" msg1's banner and suppresses msg2's fallback — which is the
    // server's DEBOUNCED trailing wake, the one that exists precisely to cover
    // the second message of a burst. A token can only be spent once.
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();

    expect(await cueDeliveredSince(snapshotCues(), {senderUserId: 'peer-1'})).toBe(true);
    expect(await cueDeliveredSince(snapshotCues(), {senderUserId: 'peer-1'})).toBe(false);
  });

  it('a cue drawn DURING the wake window is claimed too, so no later wake reuses it', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    const before = snapshotCues();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();

    // The generation moved inside this wake's own window.
    expect(await cueDeliveredSince(before, {senderUserId: 'peer-1'})).toBe(true);
    // ...and the token it minted went with it.
    expect(await cueDeliveredSince(snapshotCues(), {senderUserId: 'peer-1'})).toBe(false);
  });

  it('tokens are sender-scoped — another sender\'s cue answers nothing', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();

    expect(await cueDeliveredSince(snapshotCues(), {senderUserId: 'someone-else'})).toBe(false);
    // A wake that cannot name a sender at all can claim nothing.
    expect(await cueDeliveredSince(snapshotCues())).toBe(false);
  });

  it('a FAILED draw in this thread overrides an unclaimed token', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();

    const before = snapshotCues('g1');
    display.mockImplementationOnce(async () => { throw new Error('refused'); });
    useMessengerStore.getState().appendMessage('g1', inbound('m2', 'g1'));
    await flush();

    expect(await cueDeliveredSince(before, {senderUserId: 'peer-1'})).toBe(false);
  });
});

/**
 * B-703 MR-8 — a destroyed message must take its banner with it.
 *
 * `deleted_for_all` was the only destruction the notifier watched for. The
 * disappearing-message sweeper does not tombstone: it DELETES the row, and so do
 * clearMessages / removeConversation. None of them touched the shade, so a TTL
 * message that expired unread left its decrypted preview on the lock screen
 * indefinitely — the one surface the burn never reached, and precisely what
 * disappearing messages exist to prevent.
 */
describe('B-703 MR-8 — the burn reaches the shade', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AppState as unknown as {currentState: string}).currentState = 'background';
    useMessengerStore.getState().reset();
    useMessengerStore.getState().setOwner('owner-1');
    _resetCueWitnessForTests();
    try {
      const {_resetMsgNotifStateForTest} = require('../push/callNotification') as typeof import('../push/callNotification');
      _resetMsgNotifStateForTest();
    } catch { /* module mocked away in some configs */ }
  });

  afterEach(() => { stopBackgroundMessageNotifier(); });

  it('the LAST message expiring clears the banner (the empty-list case)', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    expect(display).toHaveBeenCalledTimes(1);

    // The sweeper burns it. The conversation's list is now EMPTY — the case the
    // old early-bail skipped, and the one that matters most.
    useMessengerStore.getState().removeMessage('g1', 'm1');
    await flush();

    expect(cancel).toHaveBeenCalledWith('bravo-msg-g1');
  });

  it('one of several expiring still clears it — banners are conversation-collapsed', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    useMessengerStore.getState().appendMessage('g1', inbound('m2', 'g1'));
    await flush();
    cancel.mockClear();

    useMessengerStore.getState().removeMessage('g1', 'm1');
    await flush();

    expect(cancel).toHaveBeenCalledWith('bravo-msg-g1');
  });

  it('does NOT fire for a conversation this module never bannered', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1', {sender_id: 'self'}));
    await flush();
    expect(display).not.toHaveBeenCalled();
    cancel.mockClear();

    useMessengerStore.getState().removeMessage('g1', 'm1');
    await flush();

    expect(cancel).not.toHaveBeenCalled();
  });
});

/**
 * B-703 MR-17 — the killed-lane "Checking for new messages…" placeholder is
 * drawn by fcmHeadless and cancelled ONLY inside that same handler. A VM Android
 * freezes mid-drain strands it: nothing in a full boot or a foreground ever
 * cancels it, and it survives until the next wake happens to repost the same
 * fixed id. A permanent "Checking for new messages…" is a worse lie than no row
 * at all — the app is open and there is nothing left to check.
 */
describe('B-703 MR-17 — a stranded placeholder is retired', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AppState as unknown as {currentState: string}).currentState = 'background';
    useMessengerStore.getState().reset();
    useMessengerStore.getState().setOwner('owner-1');
  });

  afterEach(() => { stopBackgroundMessageNotifier(); });

  it('a WARM notifier start cancels it', async () => {
    startBackgroundMessageNotifier();
    await flush();
    expect(cancel).toHaveBeenCalledWith('bravo-msg-pending');
  });

  it('foregrounding cancels it too — the drain that owned it is long gone', async () => {
    startBackgroundMessageNotifier();
    await flush();
    cancel.mockClear();

    const onAppState = (AppState.addEventListener as jest.Mock).mock.calls[0][1] as (st: string) => void;
    onAppState('active');
    await flush();

    expect(cancel).toHaveBeenCalledWith('bravo-msg-pending');
  });

  it('the HEADLESS notifier does NOT — it starts alongside the drain that owns it', async () => {
    startBackgroundMessageNotifier({headless: true});
    await flush();
    expect(cancel).not.toHaveBeenCalledWith('bravo-msg-pending');
  });
});

describe('B-710 - the notifier keeps up with a live conversation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AppState as unknown as {currentState: string}).currentState = 'background';
    useMessengerStore.getState().reset();
    useMessengerStore.getState().setOwner('owner-1');
    _resetCueWitnessForTests();
    try {
      const {_resetMsgNotifStateForTest} = require('../push/callNotification') as typeof import('../push/callNotification');
      _resetMsgNotifStateForTest();
    } catch { /* mocked away in some configs */ }
  });
  afterEach(() => { stopBackgroundMessageNotifier(); });

  // The P0. The FCM headless task runs in the app's OWN JS VM, so a notifier
  // started `{headless: true}` stayed headless for the life of the process:
  // `foregroundUi` is `!headlessMode && ...` and `isBackgrounded()` is
  // `s !== 'active'` in headless mode, so with the app ON SCREEN both read false
  // and every message hit the `!foregroundUi && !isBackgrounded()` bail. No
  // banner, no tone, no in-app cue - until sign-out. "I opened the app from a
  // notification and then stopped being notified."
  it('a WARM start promotes a notifier that came up headless', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1', {name: 'Ops Team'}));
    startBackgroundMessageNotifier({headless: true});
    startBackgroundMessageNotifier(); // the app is opened

    (AppState as unknown as {currentState: string}).currentState = 'active';
    const before = getMessagePostedGeneration();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();

    // Foregrounded, so the cue is the IN-APP one rather than notifee - but it
    // must exist. Stuck headless, the generation never moved at all.
    expect(getMessagePostedGeneration()).toBeGreaterThan(before);
  });

  it('a HEADLESS start never demotes a notifier that is already serving the UI', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1', {name: 'Ops Team'}));
    startBackgroundMessageNotifier();
    startBackgroundMessageNotifier({headless: true}); // a wake lands while warm

    (AppState as unknown as {currentState: string}).currentState = 'active';
    const before = getMessagePostedGeneration();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    expect(getMessagePostedGeneration()).toBeGreaterThan(before);
  });

  // The offline catch-up. `fresh.reduce(newest)` bannered ONE row per commit and
  // `rememberSeen` had already watermarked the rest, so the messages in between
  // could never appear anywhere.
  it('several arrivals in ONE commit all reach the card, in send order', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1', {name: 'Ops Team'}));
    useMessengerStore.setState({groupMemberNames: {g1: {'peer-1': 'Alice'}}} as never);
    // Seed the thread first: a conversation MATERIALISING with many rows is boot
    // hydration, and the notifier is right to stay silent for that.
    useMessengerStore.getState().appendMessage('g1', inbound('m0', 'g1', {content: 'earlier', created_at: '2026-07-06T09:00:00.000Z'}));
    startBackgroundMessageNotifier();

    useMessengerStore.setState((st: {messages: Record<string, LocalMessage[]>}) => ({
      messages: {
        ...st.messages,
        g1: [
          ...st.messages.g1,
          inbound('m1', 'g1', {content: 'Hey', created_at: '2026-07-06T10:00:00.000Z'}),
          inbound('m2', 'g1', {content: 'Are you there?', created_at: '2026-07-06T10:00:01.000Z'}),
          inbound('m3', 'g1', {content: 'I need to talk', created_at: '2026-07-06T10:00:02.000Z'}),
        ],
      },
    }) as never);
    await flush();

    expect(display).toHaveBeenCalledTimes(1); // one card, not three banners
    const arg = display.mock.calls[0][0];
    expect(arg.android.style.messages.map((m: {text: string}) => m.text))
      .toEqual(['Hey', 'Are you there?', 'I need to talk']);
    expect(arg.body).toBe('I need to talk'); // the collapsed line is the newest
  });

  // The newest row of a commit used to be picked BEFORE the self-send filter, so
  // an outbound row landing alongside an inbound one made the whole conversation
  // `continue` - with the inbound ids already watermarked.
  it('an outbound row in the same commit does not swallow the inbound ones', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1', {name: 'Ops Team'}));
    useMessengerStore.getState().appendMessage('g1', inbound('m0', 'g1', {content: 'earlier', created_at: '2026-07-06T09:00:00.000Z'}));
    startBackgroundMessageNotifier();

    useMessengerStore.setState((st: {messages: Record<string, LocalMessage[]>}) => ({
      messages: {
        ...st.messages,
        g1: [
          ...st.messages.g1,
          inbound('m1', 'g1', {content: 'from Alice', created_at: '2026-07-06T10:00:00.000Z'}),
          inbound('m2', 'g1', {sender_id: 'self', content: 'my own reply', created_at: '2026-07-06T10:00:05.000Z'}),
        ],
      },
    }) as never);
    await flush();

    expect(display).toHaveBeenCalledTimes(1);
    expect(display.mock.calls[0][0].body).toBe('from Alice');
  });

  // The founder's literal example: three messages, one after another, app
  // backgrounded. ONE shade entry, all three lines, newest last, one sound.
  it('the founder case — three separate arrivals build one growing card', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1', {name: 'Alex'}));
    useMessengerStore.setState({groupMemberNames: {g1: {'peer-1': 'Alex'}}} as never);
    startBackgroundMessageNotifier();

    for (const [i, text] of ['Hey', 'Are you there?', 'I need to talk to you'].entries()) {
      useMessengerStore.getState().appendMessage('g1', inbound(`m${i}`, 'g1', {
        content: text,
        created_at: new Date(Date.UTC(2026, 6, 6, 10, 0, i)).toISOString(),
      }));
      await flush();
    }

    // Three draws, one notifee id — an UPDATE each time, never a new entry.
    expect(display).toHaveBeenCalledTimes(3);
    expect(new Set(display.mock.calls.map(c => c[0].id))).toEqual(new Set(['bravo-msg-g1']));

    const last = display.mock.calls[2][0];
    expect(last.android.style.messages.map((m: {text: string}) => m.text))
      .toEqual(['Hey', 'Are you there?', 'I need to talk to you']);
    expect(last.body).toBe('I need to talk to you');
    // The first alerts; the burst inside the 1.5 s floor updates silently.
    expect(display.mock.calls[0][0].android.onlyAlertOnce).toBe(false);
    expect(last.android.onlyAlertOnce).toBe(true);
    // ...and the shade sort key moved FORWARD with each one.
    const whens = display.mock.calls.map(c => c[0].android.timestamp as number);
    expect(whens[1]).toBeGreaterThan(whens[0]);
    expect(whens[2]).toBeGreaterThan(whens[1]);
  });

  it('forwards the sender so the alert model can scope its wake window', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1', {name: 'Ops Team'}));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    expect(display.mock.calls[0][0].data.senderUserId).toBe('peer-1');
  });

  // B-712 — FIXED. A killed-VM boot replays the whole SQLCipher history through
  // this subscriber. The anti-spray guard needs MORE THAN ONE row, so a one-row
  // conversation walked through it and re-bannered its old message — with sound,
  // because a fresh VM's once-ever alert ledger is empty — and that draw then told
  // the wake's own fallback "a banner exists" for the message that actually
  // arrived.
  //
  // The fix is the store signal the B-710 revert note asked for: `hydrateMessages`
  // bumps `hydrationGeneration` inside its own immer producer, so the notifier can
  // tell a bulk-replay COMMIT from a live arrival. It is deliberately not a time
  // window — the reverted "hydration hold" was one, and a live message committing
  // inside it was swallowed whole (see the next case, which pins exactly that).
  //
  // NOTE for whoever edits this next: drive the replay through `hydrateMessages`,
  // NOT a raw `setState`. This test used to fake the boot with `setState`, which
  // does not bump the generation — so a correct fix would leave it green at the
  // OLD assertion and read as "the fix does nothing".
  it('B-712 — a one-row boot replay is watermarked, never bannered', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1', {name: 'Ops Team'}));
    startBackgroundMessageNotifier({headless: true}); // BEFORE the runtime: store empty

    const genBefore = getMessagePostedGeneration();
    useMessengerStore.getState().hydrateMessages({
      g1: [inbound('old-1', 'g1', {content: 'last week'})],
    });
    await flush();
    expect(display).not.toHaveBeenCalled();
    // The stale draw is also what lied to the killed lane's fallback witness, so
    // the generation must not move either.
    expect(getMessagePostedGeneration()).toBe(genBefore);

    // The mark must NOT stick: a live arrival in the very next commit still draws.
    // This is the half that makes the fix different from the reverted hold.
    useMessengerStore.getState().appendMessage('g1', inbound('live-1', 'g1', {content: 'arrived after boot'}));
    await flush();
    expect(display).toHaveBeenCalledTimes(1);

    // And the hydrated row is still watermarked, so a later re-emission of the
    // same list does not resurrect it.
    display.mockClear();
    armBackgroundMessageNotifier();
    useMessengerStore.setState((st: {messages: Record<string, LocalMessage[]>}) => ({
      messages: {...st.messages, g1: [...st.messages.g1]},
    }) as never);
    await flush();
    expect(display).not.toHaveBeenCalled();
  });

  // The regression the revert exists to prevent: a message that lands WHILE the
  // runtime is still booting must still banner.
  it('a message arriving during the runtime boot is never swallowed', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1', {name: 'Ops Team'}));
    startBackgroundMessageNotifier({headless: true});

    // The WS connects mid-boot and delivers. No arm() has run yet.
    useMessengerStore.getState().appendMessage('g1', inbound('live-1', 'g1', {content: 'arrived mid-boot'}));
    await flush();
    expect(display).toHaveBeenCalledTimes(1);
    expect(display.mock.calls[0][0].body).toBe('arrived mid-boot');
  });

  it('a WARM start draws immediately — it runs after the runtime, not before it', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1', {name: 'Ops Team'}));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    expect(display).toHaveBeenCalledTimes(1);
  });
});
