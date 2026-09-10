/**
 * B-321 residual (P3) — a PARKED group ring that expires unconsumed must
 * leave a "Missed group call" record.
 *
 * The B-12 missed-bubble writer lives in IncomingGroupCallScreen, which never
 * mounts when the ring was parked behind a 1:1 (B-306 mailbox). Before this
 * fix, a parked ring that hit its 45 s TTL simply vanished: no ringtone, no
 * bubble, no trace. Pinned here:
 *
 *  - expiry (timer sweep) writes EXACTLY ONE missed bubble, through the same
 *    shared appendMissedGroupCallBubble helper the screen uses (B-134: call
 *    events go through the store's conversation-row helper — no hand-rolled
 *    appendMessage shapes);
 *  - the stableId is `missed-group-<roomId>` so appendMessage's id-dedup
 *    collapses it with the server's `sfu.ring.missed` replay marker;
 *  - lazy expiry (suspended timers — Android background) is a backstop that
 *    also writes once, and the stale timer firing later never double-writes;
 *  - a CONSUMED ring never writes (it was presented, not missed);
 *  - clears (sign-out, host `sfu.ring.cancelled`) never write;
 *  - latest-wins replacement is a supersede, not an expiry — no bubble for
 *    the replaced ring.
 */
jest.mock('../webrtc/useGroupCall', () => ({
  appendMissedGroupCallBubble: jest.fn(),
}));

import {appendMissedGroupCallBubble} from '../webrtc/useGroupCall';
import {
  parkGroupRing,
  consumePendingGroupRing,
  clearPendingGroupRing,
  _resetPendingGroupRingForTest,
} from '../webrtc/pendingGroupRing';
import type {GroupCallRingPayload} from '../webrtc/groupCallRingDispatcher';

const appendMock = appendMissedGroupCallBubble as jest.Mock;

function ring(roomId: string): GroupCallRingPayload {
  return {
    roomId,
    conversationId: `conv-${roomId}`,
    callType:       'voice',
    from:           {userId: 'host-uuid', deviceId: 1},
    callerName:     'Host',
    roomToken:      'tok',
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  _resetPendingGroupRingForTest();
  appendMock.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('B-321 — parked ring expiry writes the missed group-call bubble', () => {
  it('TTL expiry sweep writes exactly one missed bubble via the shared helper', () => {
    parkGroupRing(ring('room-a'));
    jest.advanceTimersByTime(46_000);
    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(appendMock).toHaveBeenCalledWith({
      conversationId: 'conv-room-a',
      callType:       'voice',
      stableId:       'missed-group-room-a',
      at:             expect.any(Number),
    });
    // Already expired — a late consume finds nothing and writes nothing more.
    expect(consumePendingGroupRing()).toBeNull();
    jest.advanceTimersByTime(120_000);
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it('lazy expiry (suspended timer) writes once; the stale timer never doubles it', () => {
    parkGroupRing(ring('room-a'));
    // Clock jumps past the TTL WITHOUT the sweep timer firing — the Android
    // background case. The lazy check in the consumer path must still write.
    jest.setSystemTime(Date.now() + 46_000);
    expect(consumePendingGroupRing()).toBeNull();
    expect(appendMock).toHaveBeenCalledTimes(1);
    // The original sweep timer now fires late — must not write again.
    jest.advanceTimersByTime(120_000);
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it('a consumed ring never writes a bubble', () => {
    parkGroupRing(ring('room-a'));
    jest.advanceTimersByTime(10_000);
    expect(consumePendingGroupRing()?.roomId).toBe('room-a');
    jest.advanceTimersByTime(120_000);
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('sign-out clear (no argument) never writes a bubble', () => {
    parkGroupRing(ring('room-a'));
    clearPendingGroupRing();
    jest.advanceTimersByTime(120_000);
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('host-cancel clear (roomId-scoped) never writes a bubble', () => {
    parkGroupRing(ring('room-a'));
    clearPendingGroupRing('room-a');
    jest.advanceTimersByTime(120_000);
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('latest-wins replacement is a supersede — only the survivor can expire', () => {
    parkGroupRing(ring('room-a'));
    jest.advanceTimersByTime(10_000);
    parkGroupRing(ring('room-b'));
    // room-a's original deadline is long past; room-b (parked 40 s ago) is
    // still fresh — nothing may have been written yet.
    jest.advanceTimersByTime(40_000);
    expect(appendMock).not.toHaveBeenCalled();
    // room-b now crosses its own TTL.
    jest.advanceTimersByTime(6_000);
    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(appendMock.mock.calls[0][0].conversationId).toBe('conv-room-b');
  });
});
