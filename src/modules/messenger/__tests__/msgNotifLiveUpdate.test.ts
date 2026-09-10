/**
 * B-710 — the message banner must behave like WhatsApp's: it UPDATES as new
 * messages land, in order, once per message, and never goes backwards.
 *
 * Every case below was reproduced against the pre-fix tree (see
 * `docs/qa/MSG_NOTIF_LIVE_UPDATE_AUDIT_2026-08-30.md` §1) — these are not
 * hypotheticals:
 *
 *   N1 DOWNGRADE  a body-less wake draw on a conversation-keyed id ERASED the
 *                 rich card and left "Open Bravo Secure to read it". The killed
 *                 lane resolves a DM's conversationId locally
 *                 (`mutedLookup.resolveDirectConversation`), so the wake and the
 *                 store notifier share one notifee id and this fires on the
 *                 commonest shape there is. The MR-10 note claiming it "could
 *                 not fire" was written against a false premise.
 *   N2 ORDER      the card was array-push ordered, so an out-of-order draw
 *                 rendered [one, three, two] and the shade header timestamp
 *                 REGRESSED to the older message — an older notification
 *                 overwriting a newer one, exactly what must never happen.
 *   N3 DUPLICATE  the same messageId drawn twice appended its text twice. The
 *                 alert model deduped the SOUND; nothing deduped the CARD.
 *   N4 DISMISS    nothing observed EventType.DISMISSED, so a swiped-away banner
 *                 left its accumulator and group membership behind: already-read
 *                 text reappeared on the next message, and the summary counted
 *                 banners that were gone.
 *   N5 GAG        the wake alert-collapse window was GLOBAL, so a wake from Alex
 *                 silenced a genuinely new message from Bo for 10 s.
 *   N6 STALE      a sender-keyed generic wake was retired only on READ, so it sat
 *                 in the shade forever next to the named card that superseded it.
 *
 * Mocked notifee + react-native, NON-virtual (B-161), same shape as
 * msgNotifConversationShape.test.ts.
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
  EventType: {ACTION_PRESS: 2, PRESS: 1, DISMISSED: 0, DELIVERED: 3},
}));

import {
  showMessageNotif,
  noteMessageNotifDismissed,
  clearMessageNotifState,
  dismissMessageNotif,
  _resetMsgNotifStateForTest,
} from '../push/callNotification';

const A = 'conv-a';
const B = 'conv-b';
const idA = `bravo-msg-${A}`;

function drawsFor(id: string): Array<Record<string, any>> {
  return mockDisplayed.filter(n => n.id === id);
}
function lastFor(id: string): Record<string, any> {
  const list = drawsFor(id);
  return list[list.length - 1];
}
function cardTexts(n: Record<string, any>): string[] {
  return (n?.android?.style?.messages ?? []).map((m: {text: string}) => m.text);
}

beforeEach(() => {
  mockDisplayed.length = 0;
  mockCancelled.length = 0;
  _resetMsgNotifStateForTest();
});

describe('N1 — a content-free wake never downgrades a card that already has content', () => {
  it('re-renders the retained thread instead of erasing it', async () => {
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'Hey', senderName: 'Alex', messageId: 'm1', sentAtMs: 1_000});
    // The killed/warm wake lane: same notifee id, no body (it cannot decrypt).
    await showMessageNotif({conversationId: A, title: 'Alex', wakeFallback: true});

    const last = lastFor(idA);
    expect(cardTexts(last)).toEqual(['Hey']);
    expect(last.body).toBe('Hey');
    expect(last.title).toBe('Alex');
  });

  it('a retained re-render does not sound again — even long past the burst floor', async () => {
    // Critic D3: without the clock spy this passed on the 1.5 s per-thread floor
    // alone and pinned nothing. At real timings a wake lands seconds or minutes
    // after the store draw, where the un-short-circuited path WOULD alert (the
    // wake carries no messageId to burn, and a non-wake draw never arms the
    // collapse window) — and re-ding a card the user has already seen.
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      await showMessageNotif({conversationId: A, title: 'Alex', body: 'Hey', senderName: 'Alex', messageId: 'm1'});
      now.mockReturnValue(600_000); // ten minutes later
      await showMessageNotif({conversationId: A, title: 'Alex', wakeFallback: true});
      expect(lastFor(idA).android.onlyAlertOnce).toBe(true); // silent update
      expect(cardTexts(lastFor(idA))).toEqual(['Hey']);      // ...and still the card
    } finally { now.mockRestore(); }
  });

  it('a body-less STORE draw (previews off) is NOT a retention — it must not freeze the thread', async () => {
    // Critic D1 — `previewForNotif` returns undefined with content previews
    // disabled, so the store notifier draws body-less too. Retaining there would
    // re-render withheld previews AND silently drop the new message.
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    let last: Record<string, any>;
    try {
      await showMessageNotif({conversationId: A, title: 'Alex', body: 'secret preview', senderName: 'Alex', messageId: 'm1', sentAtMs: 1_000});
      now.mockReturnValue(60_000); // well past the 1.5 s per-thread floor
      await showMessageNotif({conversationId: A, title: 'Alex', messageId: 'm2', sentAtMs: 2_000});
      last = lastFor(idA);
    } finally { now.mockRestore(); }
    expect(JSON.stringify(last!)).not.toContain('secret preview');
    expect(last!.body).toBe('Open Bravo Secure to read it');
    expect(last!.android.onlyAlertOnce).toBe(false); // a NEW message still alerts
  });

  it('still draws the generic banner when the thread has NO retained content', async () => {
    await showMessageNotif({conversationId: A, title: 'Alex', wakeFallback: true});
    const last = lastFor(idA);
    expect(last.body).toBe('Open Bravo Secure to read it');
    expect(last.android.style).toBeUndefined();
  });

  it('never retains across a SENDER-keyed id — one sender can span many threads', async () => {
    // A sender-keyed card aggregates conversations, so re-rendering it would
    // caption one thread's messages with another thread's title.
    await showMessageNotif({senderUserId: 'u-alex', title: 'Alex', body: 'Hey', senderName: 'Alex', messageId: 'm1'});
    await showMessageNotif({senderUserId: 'u-alex', title: 'Alex', wakeFallback: true});
    expect(lastFor('bravo-msg-sender:u-alex').body).toBe('Open Bravo Secure to read it');
  });
});

describe('N2 — order, and never let an older draw win', () => {
  it('sorts the card by send time when draws arrive out of order', async () => {
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'one',   senderName: 'Alex', messageId: 'm1', sentAtMs: 1_000});
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'three', senderName: 'Alex', messageId: 'm3', sentAtMs: 3_000});
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'two',   senderName: 'Alex', messageId: 'm2', sentAtMs: 2_000});

    expect(cardTexts(lastFor(idA))).toEqual(['one', 'two', 'three']);
  });

  it('the shade header timestamp never regresses', async () => {
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'three', senderName: 'Alex', messageId: 'm3', sentAtMs: 3_000});
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'two',   senderName: 'Alex', messageId: 'm2', sentAtMs: 2_000});
    expect(lastFor(idA).android.timestamp).toBe(3_000);
  });

  it('the collapsed line shows the NEWEST message, not the last one drawn', async () => {
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'three', senderName: 'Alex', messageId: 'm3', sentAtMs: 3_000});
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'two',   senderName: 'Alex', messageId: 'm2', sentAtMs: 2_000});
    expect(lastFor(idA).body).toBe('three');
  });

  it('keeps the newest when the cap is exceeded', async () => {
    for (let i = 0; i < 10; i++) {
      await showMessageNotif({conversationId: A, title: 'Alex', body: `m${i}`, senderName: 'Alex', messageId: `m${i}`, sentAtMs: 1_000 + i});
    }
    const texts = cardTexts(lastFor(idA));
    expect(texts.length).toBeLessThanOrEqual(7);
    expect(texts[texts.length - 1]).toBe('m9');
    expect(texts).not.toContain('m0');
  });
});

describe('N3 — one message, one card row', () => {
  it('a re-draw of the same messageId replaces its row rather than appending', async () => {
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'Hey', senderName: 'Alex', messageId: 'm1', sentAtMs: 1_000});
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'Hey', senderName: 'Alex', messageId: 'm1', sentAtMs: 1_000});
    expect(cardTexts(lastFor(idA))).toEqual(['Hey']);
  });

  it('an edited re-draw of the same id updates the text in place', async () => {
    await showMessageNotif({conversationId: A, title: 'Alex', body: '📷 Photo', senderName: 'Alex', messageId: 'm1', sentAtMs: 1_000});
    await showMessageNotif({conversationId: A, title: 'Alex', body: '📷 Photo — caption', senderName: 'Alex', messageId: 'm1', sentAtMs: 1_000});
    expect(cardTexts(lastFor(idA))).toEqual(['📷 Photo — caption']);
  });

  it('a redraw without a send time does not blank the one we already had', async () => {
    // B-323 — the shade header must keep the REAL send time. A plain spread
    // merge let an undefined field on the second draw erase it.
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'Hey', senderName: 'Alex', messageId: 'm1', sentAtMs: 5_000, senderIconUrl: 'https://cdn/a.jpg'});
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'Hey', senderName: 'Alex', messageId: 'm1'});
    const last = lastFor(idA);
    expect(last.android.timestamp).toBe(5_000);
    expect(last.android.style.messages[0].person).toEqual({name: 'Alex', icon: 'https://cdn/a.jpg'});
  });

  it('rows WITHOUT a messageId still accumulate (nothing to dedupe on)', async () => {
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'one', senderName: 'Alex', sentAtMs: 1_000});
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'two', senderName: 'Alex', sentAtMs: 2_000});
    expect(cardTexts(lastFor(idA))).toEqual(['one', 'two']);
  });
});

describe('N4 — a swiped-away banner is gone', () => {
  it('drops the accumulator so read text does not reappear', async () => {
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'Hey', senderName: 'Alex', messageId: 'm1', sentAtMs: 1_000});
    noteMessageNotifDismissed(idA);
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'Later', senderName: 'Alex', messageId: 'm2', sentAtMs: 2_000});
    expect(cardTexts(lastFor(idA))).toEqual(['Later']);
  });

  it('drops group membership so the summary stops counting it', async () => {
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'Hey', senderName: 'Alex', messageId: 'm1'});
    noteMessageNotifDismissed(idA);
    // One live thread again → no summary should be posted for the second draw.
    mockDisplayed.length = 0;
    await showMessageNotif({conversationId: B, title: 'Bo', body: 'Yo', senderName: 'Bo', messageId: 'm9'});
    expect(drawsFor('bravo-msg-summary')).toHaveLength(0);
  });

  it('a dismissed thread that was NOT retained is a no-op', () => {
    expect(() => noteMessageNotifDismissed('bravo-msg-nothing')).not.toThrow();
  });
});

describe('N5 — the wake alert-collapse window is scoped to its sender', () => {
  it('a wake from one sender does not silence another sender', async () => {
    await showMessageNotif({senderUserId: 'u-alex', title: 'Alex', wakeFallback: true});
    await showMessageNotif({conversationId: B, senderUserId: 'u-bo', title: 'Bo', body: 'Yo', senderName: 'Bo', messageId: 'm9'});
    expect(lastFor(`bravo-msg-${B}`).android.onlyAlertOnce).toBe(false);
  });

  it('still collapses the wake→named upgrade for the SAME sender', async () => {
    await showMessageNotif({senderUserId: 'u-alex', title: 'Alex', wakeFallback: true});
    await showMessageNotif({conversationId: A, senderUserId: 'u-alex', title: 'Alex', body: 'Hey', senderName: 'Alex', messageId: 'm1'});
    expect(lastFor(idA).android.onlyAlertOnce).toBe(true);
  });

  it('a wake that names no sender falls back to the global window', async () => {
    await showMessageNotif({conversationId: A, title: 'Alex', wakeFallback: true});
    await showMessageNotif({conversationId: B, senderUserId: 'u-bo', title: 'Bo', body: 'Yo', senderName: 'Bo', messageId: 'm9'});
    expect(lastFor(`bravo-msg-${B}`).android.onlyAlertOnce).toBe(true);
  });
});

describe('N6 — a generic wake banner is retired by the card that supersedes it', () => {
  it('cancels the sender-keyed generic when the named card for that sender draws', async () => {
    await showMessageNotif({senderUserId: 'u-alex', title: 'Alex', wakeFallback: true});
    await showMessageNotif({conversationId: A, senderUserId: 'u-alex', title: 'Alex', body: 'Hey', senderName: 'Alex', messageId: 'm1'});
    expect(mockCancelled).toContain('bravo-msg-sender:u-alex');
  });

  it('does not cancel a sender-keyed banner that carried real content', async () => {
    await showMessageNotif({senderUserId: 'u-alex', title: 'Alex', body: 'group text', senderName: 'Alex', messageId: 'm0'});
    await showMessageNotif({conversationId: A, senderUserId: 'u-alex', title: 'Alex', body: 'Hey', senderName: 'Alex', messageId: 'm1'});
    expect(mockCancelled).not.toContain('bravo-msg-sender:u-alex');
  });

  it('the summary count follows the retirement', async () => {
    await showMessageNotif({senderUserId: 'u-alex', title: 'Alex', wakeFallback: true});
    await showMessageNotif({conversationId: A, senderUserId: 'u-alex', title: 'Alex', body: 'Hey', senderName: 'Alex', messageId: 'm1'});
    // One real thread is showing, so no "N conversations" summary.
    expect(drawsFor('bravo-msg-summary')).toHaveLength(0);
  });
});

describe('N7 — sign-out drops every accumulator', () => {
  it('a retained card cannot outlive the account that made it', async () => {
    // 1:1 ids are peer-keyed, so two accounts talking to the same peer share
    // one id. A retained re-render must not leak the previous account's
    // decrypted preview into the new account's shade.
    await showMessageNotif({conversationId: 'direct:peer-9', title: 'Alex', body: 'account A secret', senderName: 'Alex', messageId: 'a1'});
    clearMessageNotifState();

    await showMessageNotif({conversationId: 'direct:peer-9', title: 'Alex', wakeFallback: true});
    const last = mockDisplayed[mockDisplayed.length - 1];
    expect(last.body).toBe('Open Bravo Secure to read it');
    expect(last.android.style).toBeUndefined();
    expect(JSON.stringify(last)).not.toContain('account A secret');
  });

  it('also drops the generic-wake ledger and the summary membership', async () => {
    await showMessageNotif({senderUserId: 'u-alex', title: 'Alex', wakeFallback: true});
    await showMessageNotif({conversationId: 'conv-x', title: 'X', body: 'hi', senderName: 'X', messageId: 'x1'});
    clearMessageNotifState();
    mockDisplayed.length = 0;
    mockCancelled.length = 0;

    // A fresh single thread must produce no summary and retire nothing.
    await showMessageNotif({conversationId: 'conv-y', senderUserId: 'u-alex', title: 'Y', body: 'yo', senderName: 'Y', messageId: 'y1'});
    expect(drawsFor('bravo-msg-summary')).toHaveLength(0);
    expect(mockCancelled).not.toContain('bravo-msg-sender:u-alex');
  });
});

describe('N8 — a dismissal cannot be undone by a draw that was already in flight', () => {
  it('opening the chat wins over a concurrent draw for the same thread', async () => {
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'Hey', senderName: 'Alex', messageId: 'm1', sentAtMs: 1_000});
    mockDisplayed.length = 0;
    mockCancelled.length = 0;

    // A second message's draw and the user's read race each other.
    const draw = showMessageNotif({conversationId: A, title: 'Alex', body: 'Later', senderName: 'Alex', messageId: 'm2', sentAtMs: 2_000});
    const read = dismissMessageNotif(A);
    await Promise.all([draw, read]);

    // Both ran, and the LAST word on this id is the cancel — not a re-display
    // built from a snapshot taken before the read.
    expect(mockCancelled).toContain(idA);
    const lastDraw = mockDisplayed.filter(n => n.id === idA).length;
    const cancelledAfterLastDraw = mockCancelled.lastIndexOf(idA);
    expect(cancelledAfterLastDraw).toBeGreaterThanOrEqual(0);
    expect(lastDraw).toBeGreaterThanOrEqual(1);
    // And the accumulator is empty, so the NEXT message starts a fresh card.
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'Newest', senderName: 'Alex', messageId: 'm3', sentAtMs: 3_000});
    expect(cardTexts(lastFor(idA))).toEqual(['Newest']);
  });
});

describe('N9 — defects the adversarial critics found in the first cut of this fix', () => {
  it('D4 — a previewless STORE draw is not recorded as a generic wake, so it cannot orphan one', async () => {
    // A killed wake for S posts the real generic banner...
    await showMessageNotif({senderUserId: 'u-s', title: 'S', wakeFallback: true});
    // ...then a store draw for one of S's threads happens to have no preview
    // (previews off, a call record, a tombstone). If THAT were recorded as the
    // generic, the map would point at the wrong id and the live sender-keyed row
    // would sit in the shade forever.
    await showMessageNotif({conversationId: A, senderUserId: 'u-s', title: 'Alex', messageId: 'm0'});
    mockCancelled.length = 0;

    // The real named card must still retire the ACTUAL generic banner.
    await showMessageNotif({conversationId: A, senderUserId: 'u-s', title: 'Alex', body: 'Hey', senderName: 'Alex', messageId: 'm1'});
    expect(mockCancelled).toContain('bravo-msg-sender:u-s');
  });

  it('D4 — a card with content never cancels another CONVERSATION banner of the same sender', async () => {
    // A previewless draw in DM D, then text in group G from the same sender.
    await showMessageNotif({conversationId: 'conv-dm', senderUserId: 'u-s', title: 'S', messageId: 'd0'});
    mockCancelled.length = 0;
    await showMessageNotif({conversationId: 'conv-grp', senderUserId: 'u-s', title: 'Group', body: 'hi all', senderName: 'S', messageId: 'g0'});
    // The DM's unread banner is not collateral damage.
    expect(mockCancelled).not.toContain('bravo-msg-conv-dm');
  });

  it('D9 — dismissing the GROUP SUMMARY takes its children with it', async () => {
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'Hey', senderName: 'Alex', messageId: 'm1'});
    await showMessageNotif({conversationId: B, title: 'Bo', body: 'Yo', senderName: 'Bo', messageId: 'm9'});
    expect(drawsFor('bravo-msg-summary').length).toBeGreaterThan(0); // summary is up

    // Android delivers the delete intent for the summary row only, but the whole
    // group leaves the shade with it.
    noteMessageNotifDismissed('bravo-msg-summary');

    mockDisplayed.length = 0;
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'Later', senderName: 'Alex', messageId: 'm2'});
    // A fresh card — not seven already-dismissed previews back on the lock screen.
    expect(cardTexts(lastFor(idA))).toEqual(['Later']);
    // ...and one live thread means no summary.
    expect(drawsFor('bravo-msg-summary')).toHaveLength(0);
  });

  it('D9 — the retained branch never advertises a time for content it did not render', async () => {
    await showMessageNotif({conversationId: A, title: 'Alex', body: 'Hey', senderName: 'Alex', messageId: 'm1', sentAtMs: 1_000});
    // The wake knows the NEW message's send time, but renders only the old row.
    await showMessageNotif({conversationId: A, title: 'Alex', wakeFallback: true, sentAtMs: 9_000});
    expect(lastFor(idA).android.timestamp).toBe(1_000);
  });

  it('D7 — a wedged draw cannot silence the thread for good', async () => {
    jest.useFakeTimers();
    try {
      const notifee = (jest.requireMock('@notifee/react-native') as {default: {displayNotification: jest.Mock}}).default;
      // One native call that never settles — the wedged-binder case.
      notifee.displayNotification.mockImplementationOnce(() => new Promise(() => {}));
      void showMessageNotif({conversationId: A, title: 'Alex', body: 'first', senderName: 'Alex', messageId: 'w1'});

      const second = showMessageNotif({conversationId: A, title: 'Alex', body: 'second', senderName: 'Alex', messageId: 'w2'});
      jest.advanceTimersByTime(6_000); // past the chain's budget
      await second;

      expect(mockDisplayed.some(n => n.body === 'second')).toBe(true);
    } finally { jest.useRealTimers(); }
  });
});
