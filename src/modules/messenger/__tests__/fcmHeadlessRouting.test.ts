/**
 * Killed-app headless FCM routing:
 *   - P2-BR-5: a contact's GROUP message must NOT be silenced just because their
 *     1:1 DM is muted — mute suppression applies ONLY to an unambiguous explicit
 *     conversationId, never to a DM heuristically resolved from senderUserId.
 *   - P1-BR-1: a group ring must thread roomId (= callId) + roomToken into the
 *     notification so the accept path can sfu.join the host's room.
 *   - P1-7: a missed-call notification must carry fromUserId so its tap can
 *     deep-link to the caller's thread (never a ghost CallScreen).
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
jest.mock('react-native', () => ({Platform: {OS: 'android'}, NativeModules: {}}));
jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    displayNotification: jest.fn(async () => {}),
    cancelNotification:  jest.fn(async () => {}),
    createChannel:       jest.fn(async () => 'ch'),
    deleteChannel:       jest.fn(async () => {}),
  },
  AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2},
  AndroidCategory:   {MESSAGE: 'msg', CALL: 'call'},
  AndroidVisibility: {PRIVATE: 0, PUBLIC: 1},
  AndroidStyle:      {BIGTEXT: 1, MESSAGING: 2},
  EventType:         {PRESS: 1, ACTION_PRESS: 2},
}));
// Ring admission stays HMAC-gated in production; the display-routing under test
// is downstream of a valid verdict, so stub the verifier as ok.
jest.mock('../push/voipWakeVerify', () => ({verifyVoipWake: jest.fn(async () => ({ok: true}))}));

import notifee from '@notifee/react-native';
import {handleHeadlessFcm} from '../push/fcmHeadless';

const display = notifee.displayNotification as jest.Mock;

const OWNER = 'owner-a';
const PEER  = 'peer-alice';
type Convo = {is_muted?: boolean; type?: string; peer?: {userId?: string}};
function seed(convos: Record<string, Convo>): void {
  mockStore.set('messenger-store-v1', JSON.stringify({
    state: {_ownUserId: OWNER, vaultByOwner: {[OWNER]: {conversations: convos}}},
    version: 0,
  }));
}
const msg = (data: Record<string, string>) => handleHeadlessFcm({data} as never);

// B-692 NL-1 — the msg-wake lane now posts a SILENT "checking" placeholder
// before the drain/fallback; banner assertions read through this filter so
// they keep meaning "the real banner".
const banners = (): Array<Record<string, any>> =>
  display.mock.calls.map(c => c[0] as Record<string, any>).filter(a => a.id !== 'bravo-msg-pending');

beforeEach(() => {
  mockStore.clear();
  display.mockClear();
  // GAP-2 — banner ids posted by earlier tests otherwise engage the group
  // summary and calls[0]/call-counts stop meaning "the banner".
  try {
    const {_resetMsgNotifStateForTest} = require('../push/callNotification') as typeof import('../push/callNotification');
    _resetMsgNotifStateForTest();
  } catch { /* callNotification mocked away in some configs */ }
});

describe('msg-wake mute gate (P2-BR-5)', () => {
  it('does NOT suppress a group message when the sender\'s 1:1 DM is muted (ambiguous)', async () => {
    seed({[`direct:${PEER}`]: {type: 'direct', peer: {userId: PEER}, is_muted: true}});
    // No explicit conversationId — the wake could be a GROUP message.
    await msg({kind: 'msg-wake', senderUserId: PEER});
    expect(banners()).toHaveLength(1); // banner shown, NOT silenced
  });

  it('suppresses only when the wake names its conversation explicitly and it is muted — no placeholder either', async () => {
    seed({'uuid-muted': {type: 'direct', peer: {userId: PEER}, is_muted: true}});
    await msg({kind: 'msg-wake', conversationId: 'uuid-muted', senderUserId: PEER});
    // NOTHING displays: the mute gate covers the B-692 "checking" placeholder
    // too, or a muted thread would still light the shade on every wake.
    expect(display).not.toHaveBeenCalled();
  });

  it('shows a banner for an explicit, unmuted conversation', async () => {
    seed({'uuid-open': {type: 'group', is_muted: false}});
    await msg({kind: 'msg-wake', conversationId: 'uuid-open'});
    expect(banners()).toHaveLength(1);
    expect(banners()[0].id).toBe('bravo-msg-uuid-open');
  });

  it('B-692 NL-1 — the silent placeholder posts FIRST, on its own LOW channel, and the fallback retires it', async () => {
    seed({'uuid-open': {type: 'group', is_muted: false}});
    await msg({kind: 'msg-wake', conversationId: 'uuid-open'});
    const first = display.mock.calls[0][0] as Record<string, any>;
    expect(first.id).toBe('bravo-msg-pending');
    expect(first.android.channelId).toBe('bravo-messages-pending');
    // Silent by design: a sealed-sender wake could be a receipt/reaction, and
    // an audible placeholder would ding for every read receipt.
    expect(first.android.importance).toBe(2); // AndroidImportance.LOW
    // The resolved fallback banner supersedes it.
    const cancel = notifee.cancelNotification as jest.Mock;
    expect(cancel).toHaveBeenCalledWith('bravo-msg-pending');
  });
});

describe('group ring threads roomId + roomToken (P1-BR-1)', () => {
  it('derives roomId from callId for a group kind and carries roomToken into the notif data', async () => {
    await msg({
      kind: 'voip-wake', callId: 'room-42', callKind: 'group-voice',
      fromUserId: 'host-1', roomToken: 'tok-abc', nonce: 'n', exp: '9999999999', sig: 's',
    });
    expect(display).toHaveBeenCalledTimes(1);
    const arg = display.mock.calls[0][0];
    expect(arg.id).toBe('bravo-call-room-42');
    expect(arg.data.roomId).toBe('room-42');     // group rings reuse callId AS roomId
    expect(arg.data.roomToken).toBe('tok-abc');  // echoed for sfu.join
  });
});

describe('missed-call notification carries fromUserId (P1-7 tap contract)', () => {
  it('a call-cancel with missed=1 posts a missed-call banner tagged with fromUserId', async () => {
    await msg({kind: 'call-cancel', callId: 'call-9', missed: '1', fromUserId: 'peer-7', callKind: 'voice'});
    const missed = display.mock.calls.map(c => c[0]).find(n => n.id === 'bravo-missed-call-9');
    expect(missed).toBeDefined();
    expect(missed.data.kind).toBe('missed-call');
    expect(missed.data.fromUserId).toBe('peer-7');
  });
});

describe('B-324 — a sealed-sender msg-wake resolved to the DM is a GUESS, and the tap data says so', () => {
  it('marks convGuess=1 when the conversation was heuristically resolved from senderUserId', async () => {
    seed({[`direct:${PEER}`]: {type: 'direct', peer: {userId: PEER}}});
    await msg({kind: 'msg-wake', senderUserId: PEER});
    expect(banners()).toHaveLength(1);
    const arg = banners()[0];
    expect(arg.data.conversationId).toBe(`direct:${PEER}`);
    expect(arg.data.convGuess).toBe('1');
  });

  it('an explicit conversationId is authoritative — no guess marker', async () => {
    seed({'uuid-open': {type: 'group', is_muted: false}});
    await msg({kind: 'msg-wake', conversationId: 'uuid-open', senderUserId: PEER});
    const arg = banners()[0];
    expect(arg.data.convGuess).toBeUndefined();
  });
});

describe('B-323 — the killed-path banner carries the wire send time into the shade header', () => {
  it('stamps android.timestamp/showTimestamp from data.sentAtMs', async () => {
    const sent = Date.parse('2026-07-29T08:00:00.000Z');
    seed({[`direct:${PEER}`]: {type: 'direct', peer: {userId: PEER}}});
    await msg({kind: 'msg-wake', senderUserId: PEER, sentAtMs: String(sent)});
    const arg = banners()[0];
    expect(arg.android.timestamp).toBe(sent);
    expect(arg.android.showTimestamp).toBe(true);
  });

  it('a malformed sentAtMs is ignored, not rendered as a bogus date', async () => {
    seed({[`direct:${PEER}`]: {type: 'direct', peer: {userId: PEER}}});
    await msg({kind: 'msg-wake', senderUserId: PEER, sentAtMs: 'garbage'});
    const arg = banners()[0];
    expect(arg.android.timestamp).toBeUndefined();
    expect(arg.android.showTimestamp).toBeUndefined();
  });
});
