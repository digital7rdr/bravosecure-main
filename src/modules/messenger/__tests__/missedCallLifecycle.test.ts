/**
 * WI-4.9 — a missed-call notification has a LIFECYCLE, not just a birth.
 *
 * The banner was created in five places and destroyed in exactly one: its own
 * tap. Talking to the person (opening their thread), calling them back, or
 * them calling you again all left "Missed call · Voice call from X" sitting
 * in the shade — stale the moment the user acted on it by any other door, and
 * immortal if they never tapped it.
 *
 * Three destruction lanes + one age bound:
 *   1. thread opened  → ChatScreen's dismiss-on-read effect (scan half);
 *   2. new call TO the peer → launchCall's dial site (scan half);
 *   3. new call FROM the peer → showIncomingCallNotif clears their older
 *      missed banners (the funnel every ring lane already passes through);
 *   4. sweepStaleCallNotifications ages out banners older than
 *      MISSED_NOTIF_MAX_AGE_MS on boot/foreground.
 *
 * Matching is by data.fromUserId OR data.conversationId — the banner id is
 * keyed by callId, which none of those lanes know.
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
jest.mock('react-native', () => ({Platform: {OS: 'android'}, NativeModules: {}, Vibration: {vibrate: jest.fn(), cancel: jest.fn()}}));

type Displayed = {notification: {id?: string; data?: Record<string, string>}; date?: number | string};
const mockDisplayed: Displayed[] = [];
jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    displayNotification: jest.fn(async () => {}),
    cancelNotification:  jest.fn(async () => {}),
    createChannel:       jest.fn(async () => 'ch'),
    getDisplayedNotifications: jest.fn(async () => mockDisplayed),
  },
  AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2},
  AndroidCategory:   {MESSAGE: 'msg', CALL: 'call'},
  AndroidVisibility: {PRIVATE: 0, PUBLIC: 1},
  AndroidStyle:      {BIGTEXT: 1, MESSAGING: 2},
  EventType:         {PRESS: 1, ACTION_PRESS: 2},
}));

import notifee from '@notifee/react-native';
import {
  showIncomingCallNotif,
  dismissMissedCallNotifs,
  sweepStaleCallNotifications,
} from '../push/callNotification';
import {MISSED_NOTIF_MAX_AGE_MS} from '../webrtc/callDeadlines';

const cancel = notifee.cancelNotification as jest.Mock;

function missedBanner(callId: string, data: Record<string, string>, ageMs = 0): Displayed {
  return {
    notification: {id: `bravo-missed-${callId}`, data: {kind: 'missed-call', callId, ...data}},
    // notifee's native side stringifies `date` — model the device shape.
    date: String(Date.now() - ageMs),
  };
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
}
const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf8');

beforeEach(() => {
  mockDisplayed.length = 0;
  cancel.mockClear();
  (notifee.displayNotification as jest.Mock).mockClear();
});

describe('WI-4.9 — dismissMissedCallNotifs', () => {
  it('cancels missed banners matching fromUserId, and ONLY those', async () => {
    mockDisplayed.push(
      missedBanner('c1', {fromUserId: 'peer-a'}),
      missedBanner('c2', {fromUserId: 'peer-b'}),
      {notification: {id: 'bravo-call-c9', data: {callId: 'c9', fromUserId: 'peer-a'}}, date: String(Date.now())},
    );
    const n = await dismissMissedCallNotifs({fromUserId: 'peer-a'});
    expect(n).toBe(1);
    expect(cancel).toHaveBeenCalledWith('bravo-missed-c1');
    expect(cancel).not.toHaveBeenCalledWith('bravo-missed-c2');
    // NEVER a ring card — a live ring from the same peer is not a stale miss.
    expect(cancel).not.toHaveBeenCalledWith('bravo-call-c9');
  });

  it('cancels by conversationId too (group threads have no single peer)', async () => {
    mockDisplayed.push(
      missedBanner('room-1', {conversationId: 'conv-g', fromUserId: 'host-x'}),
      missedBanner('c3', {conversationId: 'conv-other'}),
    );
    const n = await dismissMissedCallNotifs({conversationId: 'conv-g'});
    expect(n).toBe(1);
    expect(cancel).toHaveBeenCalledWith('bravo-missed-room-1');
  });

  it('no match criteria → touches nothing (never a mass sweep)', async () => {
    mockDisplayed.push(missedBanner('c4', {fromUserId: 'peer-a'}));
    const n = await dismissMissedCallNotifs({});
    expect(n).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('WI-4.9 — a new incoming ring clears the caller\'s stale missed banners', () => {
  it('showIncomingCallNotif cancels older missed-from-same-caller banners', async () => {
    mockDisplayed.push(missedBanner('c-old', {fromUserId: 'peer-a'}));
    await showIncomingCallNotif({callId: 'c-new', kind: 'voice', callerName: 'A', fromUserId: 'peer-a'});
    expect(cancel).toHaveBeenCalledWith('bravo-missed-c-old');
  });

  it('leaves other callers\' missed banners alone', async () => {
    mockDisplayed.push(missedBanner('c-old2', {fromUserId: 'peer-b'}));
    await showIncomingCallNotif({callId: 'c-new2', kind: 'voice', callerName: 'A', fromUserId: 'peer-a'});
    expect(cancel).not.toHaveBeenCalledWith('bravo-missed-c-old2');
  });

  it('the dismiss runs AFTER the card + ringtone (a Doze-budgeted wake must ring first)', async () => {
    // Review round 1 (P2) — the shade query is a bridge round-trip; it must
    // never sit between the wake and the ring.
    const order: string[] = [];
    (notifee.displayNotification as jest.Mock).mockImplementationOnce(async () => { order.push('display'); });
    (notifee.getDisplayedNotifications as jest.Mock).mockImplementationOnce(async () => { order.push('shade-query'); return []; });
    await showIncomingCallNotif({callId: 'c-ord', kind: 'voice', callerName: 'A', fromUserId: 'peer-a'});
    expect(order.indexOf('display')).toBeGreaterThan(-1);
    expect(order.indexOf('shade-query')).toBeGreaterThan(order.indexOf('display'));
  });

  it('conversation identity wins: a DIRECT ring does not retire a GROUP banner naming the same ringer', async () => {
    mockDisplayed.push(missedBanner('room-9', {fromUserId: 'peer-a', conversationId: 'conv-group'}));
    await showIncomingCallNotif({callId: 'c-new3', kind: 'voice', callerName: 'A', fromUserId: 'peer-a', conversationId: 'conv-direct'});
    expect(cancel).not.toHaveBeenCalledWith('bravo-missed-room-9');
  });
});

describe('WI-4.9 — the sweep ages stale missed banners', () => {
  it('cancels a missed banner older than MISSED_NOTIF_MAX_AGE_MS', async () => {
    mockDisplayed.push(missedBanner('c-ancient', {fromUserId: 'peer-a'}, MISSED_NOTIF_MAX_AGE_MS + 60_000));
    await sweepStaleCallNotifications();
    expect(cancel).toHaveBeenCalledWith('bravo-missed-c-ancient');
  });

  it('keeps a fresh missed banner (the user has not seen it yet)', async () => {
    mockDisplayed.push(missedBanner('c-fresh', {fromUserId: 'peer-a'}, 60_000));
    await sweepStaleCallNotifications();
    expect(cancel).not.toHaveBeenCalledWith('bravo-missed-c-fresh');
  });

  it('a missed banner with no readable date is left alone (fail open, never destructive)', async () => {
    mockDisplayed.push({notification: {id: 'bravo-missed-c-nodate', data: {kind: 'missed-call', callId: 'c-nodate'}}});
    await sweepStaleCallNotifications();
    expect(cancel).not.toHaveBeenCalledWith('bravo-missed-c-nodate');
  });
});

describe('WI-4.9 — the thread-open and dial lanes (source scans; RN screens)', () => {
  it('ChatScreen dismisses missed banners for the opened conversation', () => {
    const src = stripComments(read('src', 'screens', 'messenger', 'ChatScreen.tsx'));
    expect(src).toMatch(/dismissMissedCallNotifs\(/);
  });

  it('launchCall dismisses the dialled peer\'s missed banners at the 1:1 dial site', () => {
    const src = stripComments(read('src', 'modules', 'messenger', 'webrtc', 'launchCall.ts'));
    // The CALL site (`latchOneToOneLaunch();`), not the definition — the
    // semicolon disambiguates (the definition reads `(): void {`).
    const dialAt = src.indexOf('latchOneToOneLaunch();');
    expect(dialAt).toBeGreaterThan(-1);
    // The dismiss belongs to the "we are definitely dialling this peer"
    // moment, and carries the conversation so a group banner naming this
    // peer is not retired by a 1:1 dial.
    const window = src.slice(dialAt, dialAt + 900);
    expect(window).toMatch(/dismissMissedCallNotifs\(\{fromUserId: peer, conversationId: opts\.conversationId\}\)/);
  });
});
