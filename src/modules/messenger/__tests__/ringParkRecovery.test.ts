/**
 * B-479 / B-481 — a parked group ring must never be a dead end.
 *
 * Both bugs are about the same hole from opposite sides. B-479: a ring arriving
 * during a backup restore was DROPPED, on the assumption that the server's
 * reconnect replay would bring it back — but that replay is one-shot and
 * destructive (the gateway clears the pending-ring artifacts as soon as it
 * emits them) and the restore flow connects a socket while restore mode is
 * still armed, so the one replay could be consumed and discarded mid-restore.
 * B-481: a parked ring that expires unconsumed lives 45 s while the dispatcher's
 * dedup marker lives 60 s, so for 15 s the room was suppressed with nothing left
 * to present it.
 *
 * Together the fix is: park instead of drop, re-present on restore exit, and
 * have a dead park re-arm the room so a later copy can still ring.
 */
import {
  clearAllGroupCallRingHandlers,
  dispatchGroupRingFrame,
  setGroupCallRingHandler,
  type GroupCallRingPayload,
} from '../webrtc/groupCallRingDispatcher';
import {
  parkGroupRing,
  peekPendingGroupRing,
  consumePendingGroupRing,
  reparkGroupRing,
  _resetPendingGroupRingForTest,
} from '../webrtc/pendingGroupRing';
import {
  setRestoreModeActive,
  isRestoreModeActive,
  subscribeRestoreMode,
} from '../backup/restoreMode';

jest.mock('../webrtc/useGroupCall', () => ({
  appendMissedGroupCallBubble: jest.fn(),
}));

function ring(roomId: string, ringId?: string): GroupCallRingPayload {
  return {
    roomId,
    conversationId: `conv-${roomId}`,
    callType:       'voice',
    from:           {userId: 'host-uuid', deviceId: 1},
    callerName:     'Host',
    ...(ringId ? {ringId} : {}),
  };
}

function frame(r: GroupCallRingPayload): {event: string; data: GroupCallRingPayload} {
  return {event: 'sfu.ring.incoming', data: r};
}

/** A handler that PRESENTS (returns true), so the dedup marker is burned. */
function presenting(): {seen: string[]; unsub: () => void} {
  const seen: string[] = [];
  const unsub = setGroupCallRingHandler({
    onIncoming: r => { seen.push(r.roomId); return true; },
    onCancel:   () => {},
    onDecline:  () => {},
  });
  return {seen, unsub};
}

beforeEach(() => {
  jest.useFakeTimers();
  clearAllGroupCallRingHandlers();
  _resetPendingGroupRingForTest();
  setRestoreModeActive(false);
});

afterEach(() => {
  jest.useRealTimers();
  setRestoreModeActive(false);
});

describe('B-481 — a park that dies unconsumed re-arms the room', () => {
  it('a later copy of the ring can still be presented after the park expires', () => {
    const h = presenting();
    // The ring is presented once and the room is dedup-marked for 60 s.
    dispatchGroupRingFrame(frame(ring('room-expire')));
    expect(h.seen).toEqual(['room-expire']);
    // …and parked, as the restore / busy-1:1 branches do.
    parkGroupRing(ring('room-expire'));

    // 45 s later the park expires unconsumed. The dedup marker would still
    // have ~15 s to run, and used to swallow everything in that window.
    jest.advanceTimersByTime(46_000);
    expect(peekPendingGroupRing()).toBeNull();

    dispatchGroupRingFrame(frame(ring('room-expire')));
    expect(h.seen).toEqual(['room-expire', 'room-expire']);
  });

  it('a park that is CONSUMED does not re-arm the room', () => {
    // Consuming means the user is being shown the ring — a replay landing
    // straight afterwards must still be deduped, or they get two ring screens.
    const h = presenting();
    dispatchGroupRingFrame(frame(ring('room-consumed')));
    parkGroupRing(ring('room-consumed'));

    expect(consumePendingGroupRing()).not.toBeNull();
    jest.advanceTimersByTime(46_000);

    dispatchGroupRingFrame(frame(ring('room-consumed')));
    expect(h.seen).toEqual(['room-consumed']);
  });

  it('expiry re-arms only the room that expired', () => {
    const h = presenting();
    dispatchGroupRingFrame(frame(ring('room-a')));
    dispatchGroupRingFrame(frame(ring('room-b')));
    expect(h.seen).toEqual(['room-a', 'room-b']);

    parkGroupRing(ring('room-a'));
    jest.advanceTimersByTime(46_000);

    dispatchGroupRingFrame(frame(ring('room-a')));   // re-armed
    dispatchGroupRingFrame(frame(ring('room-b')));   // still suppressed
    expect(h.seen).toEqual(['room-a', 'room-b', 'room-a']);
  });
});

describe('B-479 — restore mode has an exit signal', () => {
  it('notifies subscribers when it flips OFF', () => {
    const seen: boolean[] = [];
    const unsub = subscribeRestoreMode(a => { seen.push(a); });

    setRestoreModeActive(true);
    setRestoreModeActive(false);

    expect(seen).toEqual([true, false]);
    unsub();
  });

  it('does not re-notify for a no-op set', () => {
    // The flag is armed by BOTH the boot gate and the screen mount, so the
    // second arm must not look like a fresh transition.
    const seen: boolean[] = [];
    const unsub = subscribeRestoreMode(a => { seen.push(a); });

    setRestoreModeActive(true);
    setRestoreModeActive(true);
    expect(seen).toEqual([true]);
    unsub();
  });

  it('an unsubscribed listener stops hearing', () => {
    const seen: boolean[] = [];
    const unsub = subscribeRestoreMode(a => { seen.push(a); });
    unsub();
    setRestoreModeActive(true);
    expect(seen).toEqual([]);
  });

  it('a throwing listener cannot wedge the restore', () => {
    // The setter runs on the restore's own path; a bad subscriber must not be
    // able to stop the flag from clearing.
    const unsubBad = subscribeRestoreMode(() => { throw new Error('bad listener'); });
    const seen: boolean[] = [];
    const unsubGood = subscribeRestoreMode(a => { seen.push(a); });

    expect(() => setRestoreModeActive(true)).not.toThrow();
    expect(isRestoreModeActive()).toBe(true);
    expect(seen).toEqual([true]);

    unsubBad(); unsubGood();
  });

  it('the parked ring survives the restore window and is consumable on exit', () => {
    // The end-to-end shape MainNavigator wires: park while armed, consume when
    // it clears. (The navigation half is source-scanned in ringDedupPresented.)
    setRestoreModeActive(true);
    parkGroupRing(ring('room-restore'));

    let consumed: GroupCallRingPayload | null = null;
    const unsub = subscribeRestoreMode(active => {
      if (!active) {consumed = consumePendingGroupRing();}
    });

    setRestoreModeActive(false);
    expect(consumed).not.toBeNull();
    expect(consumed!.roomId).toBe('room-restore');
    unsub();
  });

  it('a restore longer than the park TTL leaves the room ring-eligible', () => {
    // The common case: a real restore takes minutes, so the park is long dead
    // by the time the flag clears. B-481 is what stops that being a dead end.
    const h = presenting();
    dispatchGroupRingFrame(frame(ring('room-slow')));
    setRestoreModeActive(true);
    parkGroupRing(ring('room-slow'));

    jest.advanceTimersByTime(120_000);   // restore drags on
    setRestoreModeActive(false);

    expect(consumePendingGroupRing()).toBeNull();   // nothing left to present…
    dispatchGroupRingFrame(frame(ring('room-slow')));
    expect(h.seen).toEqual(['room-slow', 'room-slow']);  // …but a new copy rings
  });
});

describe('re-park preserves the ring AGE (round 4)', () => {
  it('a re-parked ring expires on the ORIGINAL clock, not a fresh one', () => {
    /**
     * The TTL measures age SINCE THE HOST RANG — its own doc says a ring older
     * than the window is dead and consuming it "would walk the user into a room
     * where nobody is ringing them". `parkGroupRing` stamps `Date.now()`, so the
     * re-park sites B-478/B-479 introduced would have reset that clock: a ring
     * could be handed to the user long after the host gave up.
     */
    parkGroupRing(ring('room-age'));
    jest.advanceTimersByTime(40_000);          // 5 s of life left

    const taken = consumePendingGroupRing();
    expect(taken).not.toBeNull();
    reparkGroupRing(taken!);

    jest.advanceTimersByTime(6_000);           // past the ORIGINAL deadline
    expect(peekPendingGroupRing()).toBeNull();
  });

  it('a plain park after a consume still starts a FRESH clock', () => {
    // The distinction is the point: a genuinely new ring is not a re-park.
    parkGroupRing(ring('room-fresh'));
    jest.advanceTimersByTime(40_000);
    consumePendingGroupRing();

    parkGroupRing(ring('room-fresh'));
    jest.advanceTimersByTime(40_000);
    expect(peekPendingGroupRing()).not.toBeNull();
  });

  it('a re-park of an ALREADY-DEAD ring expires it properly rather than reviving it', () => {
    const h = presenting();
    dispatchGroupRingFrame(frame(ring('room-dead')));
    parkGroupRing(ring('room-dead'));
    const taken = consumePendingGroupRing();
    expect(taken).not.toBeNull();

    jest.advanceTimersByTime(50_000);          // the ring dies in our hands
    reparkGroupRing(taken!);

    // Re-armed SYNCHRONOUSLY — no peek, no timer advance. Leaving it to the
    // lazy `fresh()` backstop or a 1 ms timer would keep the room suppressed on
    // exactly the platform that suspends timers (Android backgrounds the JS
    // clock), which is when it matters most.
    dispatchGroupRingFrame(frame(ring('room-dead')));
    expect(h.seen).toEqual(['room-dead', 'room-dead']);
    expect(peekPendingGroupRing()).toBeNull();
  });

  it('a re-park of a ring we never consumed falls back to a fresh clock', () => {
    // No recorded age for this roomId — must not crash, must not expire instantly.
    reparkGroupRing(ring('room-unknown'));
    expect(peekPendingGroupRing()).not.toBeNull();
  });
});

describe('a SUPERSEDED park re-arms its room (round 4)', () => {
  it('latest-wins releases the displaced room without writing a bubble', () => {
    /**
     * B-481's contract is "a ring nobody saw must not leave its room
     * suppressed". The latest-wins overwrite was the one unconsumed-death path
     * that skipped it. The missed-call bubble is deliberately NOT written —
     * `pendingGroupRingExpiryBubble.test.ts` pins supersede-is-not-expiry, and
     * that decision stands; only the dedup release was missing.
     */
    const h = presenting();
    dispatchGroupRingFrame(frame(ring('room-first')));
    expect(h.seen).toEqual(['room-first']);

    parkGroupRing(ring('room-first'));
    parkGroupRing(ring('room-second'));        // displaces the first

    // room-first was presented to nobody after being displaced — a fresh copy
    // must ring rather than being swallowed by its stale marker.
    dispatchGroupRingFrame(frame(ring('room-first')));
    expect(h.seen).toEqual(['room-first', 'room-first']);
  });

  it('replacing a park for the SAME room does not release it', () => {
    // A re-ring for the same room is not a supersede of a different call.
    const h = presenting();
    dispatchGroupRingFrame(frame(ring('room-same')));
    parkGroupRing(ring('room-same'));
    parkGroupRing(ring('room-same'));

    dispatchGroupRingFrame(frame(ring('room-same')));
    expect(h.seen).toEqual(['room-same']);
  });
});
