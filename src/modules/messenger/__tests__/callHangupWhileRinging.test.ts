/**
 * Audit BS-NOTIF — a remote `call.hangup` that arrives while the call is
 * still RINGING (the FCM/notifee path woke the device but the user hasn't
 * accepted, so no CallSignalling has registered yet) must dismiss the
 * looping full-screen notifee notification + report the system call UI
 * ended + drop the cached payload.
 *
 * Before the fix, the dispatcher's no-`sig` hangup branch only did
 * `pending.delete(callId)` — the notifee ring kept firing until its TTL
 * and tapping Answer mounted a CallScreen for a peer who already left.
 *
 * We mock the four push-surface modules the dispatcher lazily requires
 * and assert each teardown call fires with the right callId.
 */

const mockDismissCallNotif = jest.fn();
const mockShowMissedCall   = jest.fn();
const mockReportEnded      = jest.fn();
const mockClearPayload     = jest.fn();
const mockGetPayload       = jest.fn();
const mockNotifyCallEnded  = jest.fn();
const mockAppendMessage    = jest.fn();
const mockUpsertConversation = jest.fn();

jest.mock('../push/callNotification', () => ({
  dismissCallNotif: (...a: unknown[]) => mockDismissCallNotif(...a),
  showMissedCallNotif: (...a: unknown[]) => mockShowMissedCall(...a),
}));
// CALL-16 — the dispatcher's missed-bubble append reaches the store via a
// lazy require; mock it so the bubble writes are observable in node.
jest.mock('../store/messengerStore', () => ({
  useMessengerStore: {
    getState: () => ({
      appendMessage: (...a: unknown[]) => mockAppendMessage(...a),
      // M11 — the dispatcher now mints the cold-contact row EXPLICITLY before
      // appending, so the mock has to carry these too. Without them the upsert
      // threw, and the surrounding catch swallowed the bubble with it.
      upsertConversation: (...a: unknown[]) => mockUpsertConversation(...a),
      conversations: {},
    }),
  },
  resolveDirectConversationIdFromState: (_s: unknown, userId: string) => `direct:${userId}`,
  directPlaceholderConversation: (id: string, peerId: string) => ({id, type: 'direct', name: `Bravo · ${peerId.slice(0, 8)}`}),
}));
jest.mock('../push/callKitBridge', () => ({
  reportEnded: (...a: unknown[]) => mockReportEnded(...a),
}));
jest.mock('../push/incomingCallCache', () => ({
  clearIncomingCallPayload: (...a: unknown[]) => mockClearPayload(...a),
  getIncomingCallPayload: (...a: unknown[]) => mockGetPayload(...a),
}));
jest.mock('../push/fcmBootstrap', () => ({
  notifyCallEnded: (...a: unknown[]) => mockNotifyCallEnded(...a),
}));

import {
  registerSignalling,
  dispatchCallFrame,
  clearAllCallDispatchState,
} from '../webrtc/callDispatcher';
import {CallSignalling} from '../webrtc/signallingClient';
import type {TransportClient, ServerCallHangup} from '@bravo/messenger-core';

function noopTransport(): TransportClient {
  return {} as unknown as TransportClient;
}

function hangup(callId: string, reason: ServerCallHangup['data']['reason']): ServerCallHangup {
  return {
    event: 'call.hangup',
    data: {callId, from: {userId: 'u-caller', deviceId: 1}, reason},
  };
}

describe('call.hangup while ringing — notifee + system-UI teardown (BS-NOTIF)', () => {
  beforeEach(() => {
    clearAllCallDispatchState();
    mockDismissCallNotif.mockClear();
    mockShowMissedCall.mockClear();
    mockReportEnded.mockClear();
    mockClearPayload.mockClear();
    mockGetPayload.mockClear();
    mockGetPayload.mockReturnValue(null);
    mockNotifyCallEnded.mockClear();
    mockAppendMessage.mockClear();
    mockUpsertConversation.mockClear();
  });

  it('dismisses notifee + reports ended + clears cache when no controller is registered', () => {
    dispatchCallFrame(hangup('call-ringing-1', 'ended'));

    expect(mockDismissCallNotif).toHaveBeenCalledWith('call-ringing-1');
    expect(mockReportEnded).toHaveBeenCalledWith('call-ringing-1', 'remoteEnded');
    expect(mockClearPayload).toHaveBeenCalledWith('call-ringing-1');
    expect(mockNotifyCallEnded).toHaveBeenCalledWith('call-ringing-1');
  });

  it("maps reason='failed' to a 'failed' CallKit end reason", () => {
    dispatchCallFrame(hangup('call-ringing-2', 'failed'));
    expect(mockReportEnded).toHaveBeenCalledWith('call-ringing-2', 'failed');
  });

  it('posts a Missed call notification when a ring payload was cached (caller cancelled)', () => {
    mockGetPayload.mockReturnValue({callId: 'call-ringing-3', callerName: 'Alice', kind: 'voice'});
    dispatchCallFrame(hangup('call-ringing-3', 'ended'));
    expect(mockShowMissedCall).toHaveBeenCalledWith(
      expect.objectContaining({callId: 'call-ringing-3', callerName: 'Alice', kind: 'voice'}),
    );
    // Teardown still runs.
    expect(mockClearPayload).toHaveBeenCalledWith('call-ringing-3');
  });

  it('does NOT post a Missed call when the user declined', () => {
    mockGetPayload.mockReturnValue({callId: 'call-ringing-4', callerName: 'Bob', kind: 'voice'});
    dispatchCallFrame(hangup('call-ringing-4', 'declined'));
    expect(mockShowMissedCall).not.toHaveBeenCalled();
    expect(mockClearPayload).toHaveBeenCalledWith('call-ringing-4');
  });

  // ── CALL-16 — caller-cancel-while-ringing must ALSO land the chat bubble ──

  it('appends the idempotent missed-<callId> bubble when the caller cancels (payload cached)', () => {
    mockGetPayload.mockReturnValue({callId: 'call-ringing-6', callerName: 'Alice', kind: 'video'});
    dispatchCallFrame(hangup('call-ringing-6', 'ended'));

    expect(mockAppendMessage).toHaveBeenCalledTimes(1);
    const [convoId, msg] = mockAppendMessage.mock.calls[0] as [string, Record<string, unknown>];
    expect(convoId).toBe('direct:u-caller');
    expect(msg.id).toBe('missed-call-ringing-6');
    expect(msg.sender_id).toBe('u-caller');
    expect(msg.type).toBe('call');
    expect(msg.call_meta).toEqual(
      expect.objectContaining({kind: 'video', direction: 'incoming', outcome: 'missed', duration: 0}),
    );
  });

  it('does NOT append the bubble when the user declined (same gating as the notification)', () => {
    mockGetPayload.mockReturnValue({callId: 'call-ringing-7', callerName: 'Bob', kind: 'voice'});
    dispatchCallFrame(hangup('call-ringing-7', 'declined'));
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('does NOT append the bubble when no ring payload was cached (stray hangup for a call that never rang here)', () => {
    dispatchCallFrame(hangup('call-ringing-8', 'ended'));
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('the call.missed replay path still appends the same bubble (shared helper)', () => {
    // SYNC-5 — the notification is age-gated (<6h) now, so this replay-parity
    // case uses a FRESH miss; the stale-marker behaviour (bubble yes, notif no)
    // is covered in missedCallNotifAge.test.ts.
    dispatchCallFrame({
      event: 'call.missed',
      data: {callId: 'call-missed-1', from: {userId: 'u-caller', deviceId: 1}, kind: 'voice', at: Date.now()},
    } as unknown as ServerCallHangup);

    expect(mockAppendMessage).toHaveBeenCalledTimes(1);
    const [convoId, msg] = mockAppendMessage.mock.calls[0] as [string, Record<string, unknown>];
    expect(convoId).toBe('direct:u-caller');
    expect(msg.id).toBe('missed-call-missed-1');
    // Notification still posted on the replay path.
    expect(mockShowMissedCall).toHaveBeenCalledWith(
      expect.objectContaining({callId: 'call-missed-1', kind: 'voice'}),
    );
  });

  it('does NOT run the ringing-teardown when a controller IS registered (live call owns hangup)', () => {
    const signalling = new CallSignalling(noopTransport());
    const seen: string[] = [];
    signalling.onHangup((d) => seen.push(d.reason));
    const unregister = registerSignalling('call-live-1', signalling);
    try {
      dispatchCallFrame(hangup('call-live-1', 'ended'));
      // The frame went to the registered signalling — the dispatcher's
      // notifee-teardown branch (for the no-controller ringing case)
      // must NOT fire; the live controller's own onState=ended path
      // handles dismissal.
      expect(seen).toEqual(['ended']);
      expect(mockDismissCallNotif).not.toHaveBeenCalled();
      expect(mockReportEnded).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });
});
