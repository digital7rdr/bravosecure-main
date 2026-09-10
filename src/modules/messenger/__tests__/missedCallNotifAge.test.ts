/**
 * SYNC-5 (B-121 / NA-GATE-6) — client-side missed-call NOTIFICATION age gate.
 *
 * The server marker now survives days (env-tunable, dwell-clamped), so a
 * reconnect after a long offline stretch can replay stale `call.missed`
 * markers. The Calls-log row (`missed-<callId>` bubble) is ALWAYS written;
 * only misses newer than 6h post a notification — otherwise waking from a
 * weekend offline spams one banner per old call.
 *
 * The B-64 zombie-end guard must stay AHEAD of the age gate: a stale marker
 * for a callId that matches a live registry session must still kill it.
 *
 * Modelled on callHangupWhileRinging.test.ts: the dispatcher's lazy
 * requires are jest-mocked so bubble/notif/registry effects are observable.
 */

const mockShowMissedCall  = jest.fn();
const mockAppendMessage   = jest.fn();
const mockGetActiveCall   = jest.fn();
const mockEndActiveCall   = jest.fn();

jest.mock('../push/callNotification', () => ({
  dismissCallNotif: jest.fn(),
  showMissedCallNotif: (...a: unknown[]) => mockShowMissedCall(...a),
}));
jest.mock('../store/messengerStore', () => ({
  useMessengerStore: {
    getState: () => ({
      appendMessage: (...a: unknown[]) => mockAppendMessage(...a),
      conversations: {},
    }),
  },
  resolveDirectConversationIdFromState: (_s: unknown, userId: string) => `direct:${userId}`,
}));
jest.mock('../runtime/callRegistry', () => ({
  getActiveCall: (...a: unknown[]) => mockGetActiveCall(...a),
  endActiveCall: (...a: unknown[]) => mockEndActiveCall(...a),
}));

import {dispatchCallFrame} from '../webrtc/callDispatcher';
import type {ServerFrame} from '@bravo/messenger-core';

const FROM = {userId: 'u-caller', deviceId: 1};
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function missedFrame(callId: string, at?: number): ServerFrame {
  return {
    event: 'call.missed',
    data:  {callId, from: FROM, kind: 'voice', ...(at !== undefined ? {at} : {})},
  } as unknown as ServerFrame;
}

function expectBubbleAppended(callId: string): void {
  expect(mockAppendMessage).toHaveBeenCalledTimes(1);
  const [convoId, msg] = mockAppendMessage.mock.calls[0] as [string, Record<string, unknown>];
  expect(convoId).toBe('direct:u-caller');
  expect(msg.id).toBe(`missed-${callId}`);
  expect(msg.call_meta).toEqual({kind: 'voice', direction: 'incoming', outcome: 'missed', duration: 0});
}

describe('SYNC-5 — missed-call notification age gate (<6h)', () => {
  beforeEach(() => {
    mockShowMissedCall.mockClear();
    mockAppendMessage.mockClear();
    mockGetActiveCall.mockClear();
    mockGetActiveCall.mockReturnValue(null);
    mockEndActiveCall.mockClear();
  });

  it('a fresh miss appends the bubble AND posts the notification', () => {
    dispatchCallFrame(missedFrame('call-fresh', Date.now()));
    expectBubbleAppended('call-fresh');
    expect(mockShowMissedCall).toHaveBeenCalledWith(
      expect.objectContaining({callId: 'call-fresh', kind: 'voice'}),
    );
  });

  it('a miss just inside the window still notifies', () => {
    dispatchCallFrame(missedFrame('call-edge', Date.now() - (SIX_HOURS_MS - 60_000)));
    expectBubbleAppended('call-edge');
    expect(mockShowMissedCall).toHaveBeenCalled();
  });

  it('a week-old replayed miss appends the bubble but does NOT notify', () => {
    dispatchCallFrame(missedFrame('call-stale', Date.now() - 7 * 86_400_000));
    expectBubbleAppended('call-stale');
    expect(mockShowMissedCall).not.toHaveBeenCalled();
  });

  // The `?? 0` fallback is deliberate: no timestamp = assume stale, never spam.
  it('a frame with NO `at` is treated as stale — bubble yes, notification no', () => {
    dispatchCallFrame(missedFrame('call-no-at'));
    expectBubbleAppended('call-no-at');
    expect(mockShowMissedCall).not.toHaveBeenCalled();
  });

  it('B-64 — a STALE miss matching a live registry session still ends the zombie', () => {
    mockGetActiveCall.mockReturnValue({callId: 'call-zombie', state: 'connecting'});
    dispatchCallFrame(missedFrame('call-zombie', Date.now() - 7 * 86_400_000));
    // WI-1.1 — the callId leads. A server frame carries no generation, so the
    // dispatcher uses the weak ref form; the id is what stops this teardown
    // landing on a different call that took the slot.
    expect(mockEndActiveCall).toHaveBeenCalledWith('call-zombie', 'failed', 'remote');
    // Age gate only suppresses the banner, never the teardown or the log row.
    expect(mockShowMissedCall).not.toHaveBeenCalled();
    expectBubbleAppended('call-zombie');
  });
});
