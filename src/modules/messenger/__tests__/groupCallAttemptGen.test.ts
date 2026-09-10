/**
 * WI-3.1 — per-attempt generation for the group-call boot / rejoin lifecycle.
 *
 * The race this exists to kill (spec group G6 + G3's duplicate-producer half):
 * `rejoinRoom` is a long async function with four await points, and NOTHING
 * stopped a second rejoin from starting while the first was still in flight.
 * Two attempts then interleave their writes:
 *
 *   • attempt A clears `consumedProducerIds`, attempt B has already re-consumed
 *     into it  → B's tiles are forgotten and get consumed twice;
 *   • A pushes into `producersRef` after B rebuilt it → duplicate producers;
 *   • A overwrites `sendTxRef` with a transport built against a dead socket;
 *   • A's `setState('failed')` lands after B's `setState('joined')` (or the
 *     reverse) → the call shows the wrong terminal state.
 *
 * The fix is an attempt generation: every attempt takes a number, and every
 * write it performs after an await is conditional on that number still being
 * the newest. This module owns that decision so it can be tested without the
 * mediasoup graph.
 *
 * WHY THE COUNTER IS MODULE-LEVEL AND ROOM-KEYED, not a `useRef`:
 * `rejoinRoom` is stashed into `liveSfuHandlesByRoom` and ADOPTED by the hook
 * instance that mounts after a minimize→restore. The adopted closure still
 * reads the ORIGINAL instance's refs, so a restored instance bumping its own
 * ref would be comparing against a counter the adopted closure never sees —
 * every check would read "superseded" or "live" by accident. `useGroupCall`
 * already reached this conclusion for the rejoin in-flight guard, which lives
 * in `groupCallRejoinHub` for exactly this reason (see its header: a
 * per-instance ref "could not see a rejoin still in flight from the hook
 * instance that owned the call before this restore").
 */
import {
  beginAttempt,
  currentAttempt,
  attemptVerdict,
  attemptIsLive,
  abortStaleAttempt,
  clearRoomAttempts,
  clearAllAttempts,
  markAttemptRunning,
  endAttemptRunning,
  isAttemptRunning,
  runningAttemptGen,
} from '../webrtc/groupCallAttemptGen';
import {GROUP_REBUILD_MARK_CEILING_MS} from '../webrtc/callDeadlines';

const ROOM = 'room-A';
const OTHER = 'room-B';

beforeEach(() => {
  clearAllAttempts();
  jest.restoreAllMocks();
});

describe('the counter', () => {
  it('starts at 0 for an unknown room and issues 1 first', () => {
    expect(currentAttempt(ROOM)).toBe(0);
    expect(beginAttempt(ROOM)).toBe(1);
    expect(currentAttempt(ROOM)).toBe(1);
  });

  it('is strictly monotonic per room', () => {
    expect(beginAttempt(ROOM)).toBe(1);
    expect(beginAttempt(ROOM)).toBe(2);
    expect(beginAttempt(ROOM)).toBe(3);
  });

  it('is INDEPENDENT per room — a second call must not supersede the first', () => {
    // Two rooms can genuinely be live at once during a hand-off (the old
    // call's teardown overlapping the new call's boot). A single global
    // counter would make the older room's every write read as superseded and
    // silently stop its teardown work.
    const a = beginAttempt(ROOM);
    const b = beginAttempt(OTHER);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(attemptIsLive({roomId: ROOM, gen: a, cancelled: false, leaving: false})).toBe(true);
    expect(attemptIsLive({roomId: OTHER, gen: b, cancelled: false, leaving: false})).toBe(true);
  });

  it('clearRoomAttempts resets only the named room', () => {
    beginAttempt(ROOM);
    beginAttempt(ROOM);
    beginAttempt(OTHER);
    clearRoomAttempts(ROOM);
    expect(currentAttempt(ROOM)).toBe(0);
    expect(currentAttempt(OTHER)).toBe(1);
  });

  it('clearAllAttempts resets every room (logout / hard reset)', () => {
    beginAttempt(ROOM);
    beginAttempt(OTHER);
    clearAllAttempts();
    expect(currentAttempt(ROOM)).toBe(0);
    expect(currentAttempt(OTHER)).toBe(0);
  });

  it('a room re-entered after a clear starts a fresh sequence rather than resuming', () => {
    // A stale attempt from the PREVIOUS call in this room must not be able to
    // match a generation issued by the NEW call. Restarting at 1 is safe only
    // because the stale attempt captured a number from the old sequence AND
    // the clear happens at teardown, after which no old write is legal at all
    // (its `leaving` flag is set). Pinned so a future "resume the sequence"
    // refactor has to argue with this comment.
    beginAttempt(ROOM);
    beginAttempt(ROOM);
    clearRoomAttempts(ROOM);
    expect(beginAttempt(ROOM)).toBe(1);
  });
});

describe('the stale-attempt rejection matrix', () => {
  it('the newest attempt with no teardown flags proceeds', () => {
    const gen = beginAttempt(ROOM);
    expect(attemptVerdict({roomId: ROOM, gen, cancelled: false, leaving: false})).toBe('proceed');
  });

  it('an OLDER generation is superseded', () => {
    const first = beginAttempt(ROOM);
    beginAttempt(ROOM);
    expect(attemptVerdict({roomId: ROOM, gen: first, cancelled: false, leaving: false}))
      .toBe('superseded');
  });

  it('a generation NEWER than the counter is also superseded, never proceed', () => {
    // Impossible by construction — which is exactly why it must fail CLOSED.
    // A "gen < current" comparison would let this through and hand a corrupt
    // caller write access to the live call's refs.
    beginAttempt(ROOM);
    expect(attemptVerdict({roomId: ROOM, gen: 99, cancelled: false, leaving: false}))
      .toBe('superseded');
  });

  it('an unknown room supersedes (its counter was cleared by teardown)', () => {
    expect(attemptVerdict({roomId: 'never-seen', gen: 1, cancelled: false, leaving: false}))
      .toBe('superseded');
  });

  it('the newest attempt still stops when the hook unmounted', () => {
    const gen = beginAttempt(ROOM);
    expect(attemptVerdict({roomId: ROOM, gen, cancelled: true, leaving: false})).toBe('cancelled');
  });

  it('the newest attempt still stops when a teardown is in flight', () => {
    const gen = beginAttempt(ROOM);
    expect(attemptVerdict({roomId: ROOM, gen, cancelled: false, leaving: true})).toBe('leaving');
  });

  it('superseded OUTRANKS leaving and cancelled', () => {
    // Ordering is diagnostic, not behavioural — all three abort. It is pinned
    // because "superseded" is the one that means a RACE happened, and that is
    // the line an engineer greps for. Reporting it as a plain unmount would
    // hide the very thing this work item exists to make visible.
    const first = beginAttempt(ROOM);
    beginAttempt(ROOM);
    expect(attemptVerdict({roomId: ROOM, gen: first, cancelled: true, leaving: true}))
      .toBe('superseded');
  });

  it('leaving OUTRANKS cancelled', () => {
    const gen = beginAttempt(ROOM);
    expect(attemptVerdict({roomId: ROOM, gen, cancelled: true, leaving: true})).toBe('leaving');
  });

  it('attemptIsLive is true ONLY for proceed', () => {
    const first = beginAttempt(ROOM);
    const second = beginAttempt(ROOM);
    expect(attemptIsLive({roomId: ROOM, gen: second, cancelled: false, leaving: false})).toBe(true);
    expect(attemptIsLive({roomId: ROOM, gen: first, cancelled: false, leaving: false})).toBe(false);
    expect(attemptIsLive({roomId: ROOM, gen: second, cancelled: true, leaving: false})).toBe(false);
    expect(attemptIsLive({roomId: ROOM, gen: second, cancelled: false, leaving: true})).toBe(false);
  });
});

describe('the rejoin in-flight mark (WI-3.2)', () => {
  it('marks and releases a room', () => {
    expect(isAttemptRunning(ROOM)).toBe(false);
    const gen = beginAttempt(ROOM);
    markAttemptRunning(ROOM, gen);
    expect(isAttemptRunning(ROOM)).toBe(true);
    expect(runningAttemptGen(ROOM)).toBe(gen);
    endAttemptRunning(ROOM, gen);
    expect(isAttemptRunning(ROOM)).toBe(false);
    expect(runningAttemptGen(ROOM)).toBeNull();
  });

  it('is per-room — one room rebuilding must not freeze another', () => {
    const a = beginAttempt(ROOM);
    markAttemptRunning(ROOM, a);
    expect(isAttemptRunning(OTHER)).toBe(false);
  });

  it('a SUPERSEDED attempt cannot release the winner\'s mark', () => {
    // THE bug this guard exists for. Two rejoins overlap; the loser's
    // `finally` runs while the winner is still mid-rebuild. An unconditional
    // delete there re-opens the reconcile tick onto exactly the half-built
    // transports the mark exists to protect — and the loser's finally is
    // GUARANTEED to run, because being superseded is what makes it return.
    const loser  = beginAttempt(ROOM);
    markAttemptRunning(ROOM, loser);
    const winner = beginAttempt(ROOM);
    markAttemptRunning(ROOM, winner);

    endAttemptRunning(ROOM, loser);          // the loser's finally lands late

    expect(isAttemptRunning(ROOM)).toBe(true);
    expect(runningAttemptGen(ROOM)).toBe(winner);

    endAttemptRunning(ROOM, winner);
    expect(isAttemptRunning(ROOM)).toBe(false);
  });

  it('releasing a room that was never marked is a no-op', () => {
    expect(() => endAttemptRunning(ROOM, 1)).not.toThrow();
    expect(isAttemptRunning(ROOM)).toBe(false);
  });

  it('EXPIRES rather than latching when the rejoin never settles', () => {
    // `rejoinRoom` rides acks whose reject timers are setTimeouts, frozen
    // while the screen is locked. If the socket dies between emit and ack the
    // promise never settles and the `finally` never runs. A plain boolean
    // would disable the reconcile backstop for the rest of the call.
    const realNow = Date.now;
    try {
      let t = 5_000_000;
      Date.now = () => t;
      const gen = beginAttempt(ROOM);
      markAttemptRunning(ROOM, gen);
      t += GROUP_REBUILD_MARK_CEILING_MS - 1;
      expect(isAttemptRunning(ROOM)).toBe(true);     // still plausibly running
      t += 2;
      expect(isAttemptRunning(ROOM)).toBe(false);    // recovery resumes
    } finally {
      Date.now = realNow;
    }
  });

  it('clearRoomAttempts drops the mark as well as the counter', () => {
    const gen = beginAttempt(ROOM);
    markAttemptRunning(ROOM, gen);
    clearRoomAttempts(ROOM);
    expect(isAttemptRunning(ROOM)).toBe(false);
  });

  it('clearAllAttempts drops every mark', () => {
    markAttemptRunning(ROOM, beginAttempt(ROOM));
    markAttemptRunning(OTHER, beginAttempt(OTHER));
    clearAllAttempts();
    expect(isAttemptRunning(ROOM)).toBe(false);
    expect(isAttemptRunning(OTHER)).toBe(false);
  });

  it('runningAttemptGen lets an attempt recognise its OWN work', () => {
    // `rejoinRoom` re-consumes every existing producer through the same
    // consumeProducer funnel everyone else uses. A boolean "stand down while
    // a rejoin runs" check would make the rejoin stand down from its own
    // work and rebuild a room with no remote tiles in it.
    const gen = beginAttempt(ROOM);
    markAttemptRunning(ROOM, gen);
    expect(runningAttemptGen(ROOM)).toBe(gen);          // mine → proceed
    expect(runningAttemptGen(ROOM)).not.toBe(gen + 1);  // someone else's → park
  });
});

describe('abortStaleAttempt — the call-site helper', () => {
  it('returns FALSE (do not abort) for the live attempt', () => {
    const gen = beginAttempt(ROOM);
    expect(abortStaleAttempt('rejoin.produce', {roomId: ROOM, gen, cancelled: false, leaving: false}))
      .toBe(false);
  });

  it('returns TRUE (abort) for every non-proceed verdict', () => {
    const first = beginAttempt(ROOM);
    const second = beginAttempt(ROOM);
    expect(abortStaleAttempt('a', {roomId: ROOM, gen: first, cancelled: false, leaving: false})).toBe(true);
    expect(abortStaleAttempt('b', {roomId: ROOM, gen: second, cancelled: true, leaving: false})).toBe(true);
    expect(abortStaleAttempt('c', {roomId: ROOM, gen: second, cancelled: false, leaving: true})).toBe(true);
  });

  it('a SUPERSEDED drop is release-visible (console.warn)', () => {
    // `babel-plugin-transform-remove-console` strips `log` and keeps `warn`,
    // and a release build is the only one worth diagnosing. A lost rejoin race
    // on a user's device has to leave a trace.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log  = jest.spyOn(console, 'log').mockImplementation(() => {});
    const first = beginAttempt(ROOM);
    beginAttempt(ROOM);
    abortStaleAttempt('rejoin.setState', {roomId: ROOM, gen: first, cancelled: false, leaving: false});
    expect(warn).toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    const line = warn.mock.calls[0].join(' ');
    expect(line).toContain('[CALLSM]');
    expect(line).toContain('superseded');
    // The site must be identifiable — a warn that doesn't say WHERE is noise.
    expect(line).toContain('rejoin.setState');
  });

  it('an ORDINARY unmount / teardown drop stays quiet (console.log)', () => {
    // These fire on every normal hang-up. Routing them to the release lane
    // would bury the superseded warns this exists to surface.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log  = jest.spyOn(console, 'log').mockImplementation(() => {});
    const gen = beginAttempt(ROOM);
    abortStaleAttempt('rejoin.turn', {roomId: ROOM, gen, cancelled: true, leaving: false});
    abortStaleAttempt('rejoin.turn', {roomId: ROOM, gen, cancelled: false, leaving: true});
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('a PROCEED logs nothing at all', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log  = jest.spyOn(console, 'log').mockImplementation(() => {});
    const gen = beginAttempt(ROOM);
    abortStaleAttempt('rejoin.turn', {roomId: ROOM, gen, cancelled: false, leaving: false});
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('never logs the roomId in full — ids are truncated like the rest of [CALLSM]', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const room = 'ROOM_0123456789abcdef_secret_suffix';
    const first = beginAttempt(room);
    beginAttempt(room);
    abortStaleAttempt('x', {roomId: room, gen: first, cancelled: false, leaving: false});
    expect(warn.mock.calls[0].join(' ')).not.toContain('secret_suffix');
  });
});
