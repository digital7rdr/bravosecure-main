/**
 * B-306 — a group ring that arrives while a 1:1 call owns the screen is
 * PARKED, not raced.
 *
 * Device evidence (Pixel 6a host + OPPO peer, 2026-07-27 run 3, both
 * v1.0.178): the host escalated a 1:1; the peer's CallScreen auto-dismiss
 * (a 50 ms delayed goBack) and the ring handler's navigate raced, the goBack
 * popped the just-pushed IncomingGroupCallScreen, and the once-ever ring
 * dedup swallowed the replay — no ringtone, no answer button, ever. The FCM
 * card was the only survivor, and a card cannot full-screen a foregrounded
 * app.
 *
 * The park is the handoff: MainNavigator parks instead of navigating over a
 * live call screen, and CallScreen consumes the parked ring at its OWN
 * dismissal moment (`navigate` after the pop it already owns) — one actor,
 * no race. This module is the mailbox between them.
 *
 * Semantics pinned here:
 *  - latest-wins: a second parked ring replaces the first (two concurrent
 *    group calls ringing one busy device — the newer one is the live intent);
 *  - TTL: a parked ring older than the server's ring window is dead — the
 *    host's side has already timed out, so consuming it would join a room
 *    with nobody ringing;
 *  - consume clears: exactly-once presentation;
 *  - roomId-scoped clear: `sfu.ring.cancelled` for room A must not discard a
 *    parked ring for room B.
 */
import {
  parkGroupRing,
  peekPendingGroupRing,
  consumePendingGroupRing,
  clearPendingGroupRing,
  _resetPendingGroupRingForTest,
} from '../webrtc/pendingGroupRing';
import type {GroupCallRingPayload} from '../webrtc/groupCallRingDispatcher';

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
});

afterEach(() => {
  jest.useRealTimers();
});

describe('B-306 — pendingGroupRing mailbox', () => {
  it('park → consume returns the ring exactly once', () => {
    parkGroupRing(ring('room-a'));
    expect(consumePendingGroupRing()?.roomId).toBe('room-a');
    expect(consumePendingGroupRing()).toBeNull();
  });

  it('peek does not consume', () => {
    parkGroupRing(ring('room-a'));
    expect(peekPendingGroupRing()?.roomId).toBe('room-a');
    expect(consumePendingGroupRing()?.roomId).toBe('room-a');
  });

  it('latest ring wins', () => {
    parkGroupRing(ring('room-a'));
    parkGroupRing(ring('room-b'));
    expect(consumePendingGroupRing()?.roomId).toBe('room-b');
    expect(consumePendingGroupRing()).toBeNull();
  });

  it('a parked ring EXPIRES after the ring window', () => {
    parkGroupRing(ring('room-a'));
    jest.advanceTimersByTime(46_000);
    expect(consumePendingGroupRing()).toBeNull();
  });

  it('a fresh parked ring survives a shorter wait', () => {
    parkGroupRing(ring('room-a'));
    jest.advanceTimersByTime(10_000);
    expect(consumePendingGroupRing()?.roomId).toBe('room-a');
  });

  it('cancel clears by roomId — and ONLY that room', () => {
    parkGroupRing(ring('room-a'));
    clearPendingGroupRing('room-zzz');
    expect(peekPendingGroupRing()?.roomId).toBe('room-a');
    clearPendingGroupRing('room-a');
    expect(peekPendingGroupRing()).toBeNull();
  });

  it('clear with no argument clears unconditionally (sign-out path)', () => {
    parkGroupRing(ring('room-a'));
    clearPendingGroupRing();
    expect(peekPendingGroupRing()).toBeNull();
  });
});
