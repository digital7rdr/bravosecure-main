/**
 * GAP-1/GAP-2 (NOTIFICATION_INDUSTRY_AUDIT_2026-07-27) — the message banner is
 * a CONVERSATION, not a single line, and the shade groups per-thread.
 *
 * Industry bar (WhatsApp/Signal/Telegram, Android conversation guidance):
 *  - a thread's banner ACCUMULATES its recent messages in one MessagingStyle
 *    card (ours re-built the card with only the newest message every time);
 *  - the style's top-level `person` is the DEVICE USER ("You") — messages
 *    carry their own sender `person`. Ours put the sender at top level, which
 *    models every message as sent by "you";
 *  - each thread notification joins one app group with a SUMMARY notification
 *    once ≥2 threads are showing ("N conversations"), so ten messages are not
 *    ten stacked banners;
 *  - `shortcutId` is stamped with the conversation id — required for
 *    Android's conversation space once shortcuts are published (the native
 *    shortcut publisher is the flagged follow-up; the field is forward-compat
 *    and harmless without it).
 *
 * Unit-import approach mirrors callNotifActionContract.test.ts (notifee +
 * react-native mocked, NON-virtual per B-161).
 */

const mockDisplayed: Array<Record<string, any>> = [];
const mockCancelled: string[] = [];

jest.mock('react-native', () => ({
  Platform: {OS: 'android', Version: 34},
  NativeModules: {},
}));

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    createChannel: jest.fn(async (c: {id: string}) => c.id),
    deleteChannel: jest.fn(async () => {}),
    displayNotification: jest.fn(async (n: unknown) => { mockDisplayed.push(n as Record<string, any>); }),
    cancelNotification: jest.fn(async (id: string) => { mockCancelled.push(id); }),
    onBackgroundEvent: jest.fn(),
    onForegroundEvent: jest.fn(),
  },
  AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2, MIN: 1},
  AndroidCategory: {CALL: 'call', MESSAGE: 'msg'},
  AndroidVisibility: {PUBLIC: 1, PRIVATE: 0},
  AndroidStyle: {MESSAGING: 2, INBOX: 1},
  EventType: {ACTION_PRESS: 2, PRESS: 1, DISMISSED: 0},
}));

// callVibration is pure; the real module is fine. Everything else the module
// lazily requires is inside try/catch.

import {showMessageNotif, dismissMessageNotif} from '../push/callNotification';

const CONVO_A = 'conv-aaa';
const CONVO_B = 'conv-bbb';

function displayedById(id: string): Array<Record<string, any>> {
  return mockDisplayed.filter(n => n.id === id);
}

beforeEach(() => {
  mockDisplayed.length = 0;
  mockCancelled.length = 0;
});

afterEach(async () => {
  // Isolate module accumulation between tests.
  await dismissMessageNotif(CONVO_A);
  await dismissMessageNotif(CONVO_B);
});

describe('GAP-1 — the banner is a conversation card', () => {
  it('accumulates messages across posts for the same thread', async () => {
    await showMessageNotif({conversationId: CONVO_A, title: 'Alice', body: 'first', senderName: 'Alice'});
    await showMessageNotif({conversationId: CONVO_A, title: 'Alice', body: 'second', senderName: 'Alice'});
    const cards = displayedById(`bravo-msg-${CONVO_A}`);
    expect(cards.length).toBe(2);
    const texts = cards[1].android.style.messages.map((m: {text: string}) => m.text);
    expect(texts).toEqual(['first', 'second']);
  });

  it('caps the accumulated thread', async () => {
    for (let i = 0; i < 10; i++) {
      await showMessageNotif({conversationId: CONVO_A, title: 'Alice', body: `m${i}`, senderName: 'Alice'});
    }
    const cards = displayedById(`bravo-msg-${CONVO_A}`);
    const last = cards[cards.length - 1].android.style.messages;
    expect(last.length).toBeLessThanOrEqual(7);
    expect(last[last.length - 1].text).toBe('m9');
  });

  it('models people correctly: top-level person is You, messages carry the sender', async () => {
    await showMessageNotif({conversationId: CONVO_A, title: 'Ops Room', body: 'hi', senderName: 'Alice'});
    const card = displayedById(`bravo-msg-${CONVO_A}`)[0];
    expect(card.android.style.person.name).toBe('You');
    expect(card.android.style.messages[0].person.name).toBe('Alice');
  });

  it('dismiss clears the accumulator — a later post starts a fresh card', async () => {
    await showMessageNotif({conversationId: CONVO_A, title: 'Alice', body: 'old', senderName: 'Alice'});
    await dismissMessageNotif(CONVO_A);
    await showMessageNotif({conversationId: CONVO_A, title: 'Alice', body: 'new', senderName: 'Alice'});
    const cards = displayedById(`bravo-msg-${CONVO_A}`);
    const last = cards[cards.length - 1].android.style.messages;
    expect(last.map((m: {text: string}) => m.text)).toEqual(['new']);
  });

  it('stamps the conversation shortcutId', async () => {
    await showMessageNotif({conversationId: CONVO_A, title: 'Alice', body: 'hi', senderName: 'Alice'});
    expect(displayedById(`bravo-msg-${CONVO_A}`)[0].android.shortcutId).toBe(CONVO_A);
  });
});

describe('B-323 — the banner shows the SEND time, never the draw time', () => {
  const SENT_AT = Date.parse('2026-07-29T08:00:00.000Z');

  it('stamps the style message and the shade header from sentAtMs', async () => {
    await showMessageNotif({conversationId: CONVO_A, title: 'Alice', body: 'early bird', senderName: 'Alice', sentAtMs: SENT_AT});
    const card = displayedById(`bravo-msg-${CONVO_A}`)[0];
    expect(card.android.style.messages[0].timestamp).toBe(SENT_AT);
    expect(card.android.timestamp).toBe(SENT_AT);
    expect(card.android.showTimestamp).toBe(true);
  });

  it('a generic (body-less) banner still carries the header send time', async () => {
    await showMessageNotif({conversationId: CONVO_A, sentAtMs: SENT_AT});
    const card = displayedById(`bravo-msg-${CONVO_A}`)[0];
    expect(card.android.timestamp).toBe(SENT_AT);
    expect(card.android.showTimestamp).toBe(true);
  });

  it('without sentAtMs the header keys stay absent (no false claim of a send time)', async () => {
    await showMessageNotif({conversationId: CONVO_A, title: 'Alice', body: 'hi', senderName: 'Alice'});
    const card = displayedById(`bravo-msg-${CONVO_A}`)[0];
    expect(card.android.timestamp).toBeUndefined();
    expect(card.android.showTimestamp).toBeUndefined();
  });

  it('an accumulated thread keeps each message its own send time', async () => {
    await showMessageNotif({conversationId: CONVO_A, title: 'Alice', body: 'one', senderName: 'Alice', sentAtMs: SENT_AT});
    await showMessageNotif({conversationId: CONVO_A, title: 'Alice', body: 'two', senderName: 'Alice', sentAtMs: SENT_AT + 60_000});
    const cards = displayedById(`bravo-msg-${CONVO_A}`);
    const msgs = cards[cards.length - 1].android.style.messages;
    expect(msgs.map((m: {timestamp: number}) => m.timestamp)).toEqual([SENT_AT, SENT_AT + 60_000]);
  });
});

describe('B-327 — the sender\'s profile photo rides the conversation card', () => {
  it('senderIconUrl becomes the per-message Person icon', async () => {
    await showMessageNotif({conversationId: CONVO_A, title: 'Ops Room', body: 'hi', senderName: 'Alice', senderIconUrl: 'https://cdn.test/alice.jpg'});
    const card = displayedById(`bravo-msg-${CONVO_A}`)[0];
    expect(card.android.style.messages[0].person).toEqual({name: 'Alice', icon: 'https://cdn.test/alice.jpg'});
  });

  it('each accumulated message keeps ITS OWN sender icon (group threads mix senders)', async () => {
    await showMessageNotif({conversationId: CONVO_A, title: 'Ops Room', body: 'one', senderName: 'Alice', senderIconUrl: 'https://cdn.test/alice.jpg'});
    await showMessageNotif({conversationId: CONVO_A, title: 'Ops Room', body: 'two', senderName: 'Bob'});
    const cards = displayedById(`bravo-msg-${CONVO_A}`);
    const msgs = cards[cards.length - 1].android.style.messages;
    expect(msgs[0].person).toEqual({name: 'Alice', icon: 'https://cdn.test/alice.jpg'});
    expect(msgs[1].person).toEqual({name: 'Bob'}); // no icon key when unknown
  });
});

describe('B-324 — a heuristically-resolved conversation is marked as a guess in the tap data', () => {
  it('convUnconfirmed rides the notification data as convGuess=1', async () => {
    await showMessageNotif({conversationId: CONVO_A, senderUserId: 'peer-9', convUnconfirmed: true});
    const card = displayedById(`bravo-msg-${CONVO_A}`)[0];
    expect(card.data.convGuess).toBe('1');
  });

  it('an authoritative conversation does NOT carry the guess marker', async () => {
    await showMessageNotif({conversationId: CONVO_A, senderUserId: 'peer-9'});
    const card = displayedById(`bravo-msg-${CONVO_A}`)[0];
    expect(card.data.convGuess).toBeUndefined();
  });
});

describe('GAP-2 — the shade groups threads under one summary', () => {
  it('every thread banner joins the app group', async () => {
    await showMessageNotif({conversationId: CONVO_A, title: 'Alice', body: 'hi', senderName: 'Alice'});
    expect(displayedById(`bravo-msg-${CONVO_A}`)[0].android.groupId).toBe('bravo-messages-group');
  });

  it('a second thread posts the summary; dropping to one clears it', async () => {
    await showMessageNotif({conversationId: CONVO_A, title: 'Alice', body: 'hi', senderName: 'Alice'});
    expect(displayedById('bravo-msg-summary')).toHaveLength(0);
    await showMessageNotif({conversationId: CONVO_B, title: 'Bob', body: 'yo', senderName: 'Bob'});
    const summaries = displayedById('bravo-msg-summary');
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    expect(summaries[0].android.groupSummary).toBe(true);
    expect(summaries[0].android.groupId).toBe('bravo-messages-group');
    await dismissMessageNotif(CONVO_B);
    expect(mockCancelled).toContain('bravo-msg-summary');
  });
});
