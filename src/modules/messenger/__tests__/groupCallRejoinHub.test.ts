/**
 * B-101 LC-4 — the group-call rejoin handler must survive MINIMIZE.
 *
 * Minimizing a group call unmounts the screen but deliberately keeps the
 * call running behind the floating bubble, which mounts no hook. The
 * rejoin-on-WS-reopen listener used to be owned by the screen's boot
 * effect, so it was dropped on minimize: a socket bounce during that
 * window (network blip, service redeploy, revoked-token sweep) reopened
 * the transport but never re-ran `sfu.join`, while the SFU had already
 * closed the participant's transports on its 10s leave grace. The bubble
 * then advertised a live call in which the user was silent and frozen
 * for everyone else.
 *
 * INVARIANTS under test:
 *   1. An installed handler fires on transport reconnect.
 *   2. Installing again REPLACES rather than stacks (a restore must not
 *      produce two hook instances both issuing `sfu.join`), and keeps a
 *      single underlying subscription.
 *   3. Clearing (real teardown) stops any further firing.
 *   4. A handler that throws cannot break the transport's dispatch.
 *   5. Re-binding to a DIFFERENT transport instance drops the old
 *      subscription.
 */
import {
  setGroupCallRejoinHandler,
  clearGroupCallRejoinHandler,
  releaseGroupCallRejoinHandler,
  nextGroupCallRejoinToken,
  currentGroupCallRejoinToken,
  currentGroupCallRejoinClaim,
  hasGroupCallRejoinHandler,
  beginGroupCallRejoin,
  endGroupCallRejoin,
} from '../webrtc/groupCallRejoinHub';
import {GROUP_REJOIN_CEILING_MS, GROUP_REBUILD_MARK_CEILING_MS} from '../webrtc/callDeadlines';

// The hub consults the group-call registry so it never rejoins a call
// that ended while minimized. Keep it "live" for these tests.
jest.mock('../runtime/groupCallRegistry', () => ({
  getActiveGroupCall: jest.fn(() => ({state: 'joined'})),
}));

function makeTransport(): {
  onReconnect: (fn: () => void) => () => void;
  fire: () => void;
  listenerCount: () => number;
} {
  const listeners = new Set<() => void>();
  return {
    onReconnect(fn: () => void) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    fire() { [...listeners].forEach(l => l()); },
    listenerCount() { return listeners.size; },
  };
}

describe('groupCallRejoinHub', () => {
  beforeEach(() => {
    // mockClear() does NOT drop implementations, so a mockReturnValue set by
    // one test would leak into the next — restore the "call is live" default.
    const {getActiveGroupCall} = require('../runtime/groupCallRegistry') as
      {getActiveGroupCall: jest.Mock};
    getActiveGroupCall.mockReturnValue({state: 'joined'});
  });
  afterEach(() => { clearGroupCallRejoinHandler(); jest.clearAllMocks(); });

  it('fires the installed handler on reconnect', () => {
    const ws = makeTransport();
    const rejoin = jest.fn();
    setGroupCallRejoinHandler('t1', ws, rejoin);

    ws.fire();

    expect(rejoin).toHaveBeenCalledTimes(1);
    expect(hasGroupCallRejoinHandler()).toBe(true);
  });

  it('survives the minimize window — the handler is still live after the screen unmounts', () => {
    const ws = makeTransport();
    const rejoin = jest.fn();
    setGroupCallRejoinHandler('t1', ws, rejoin);

    // Screen unmounts on minimize; the hub is intentionally NOT cleared.
    ws.fire();
    ws.fire();

    expect(rejoin).toHaveBeenCalledTimes(2);
  });

  it('REPLACES the handler on restore instead of stacking (exactly one sfu.join)', () => {
    const ws = makeTransport();
    const minimizedHandler = jest.fn();
    const restoredHandler  = jest.fn();
    setGroupCallRejoinHandler('minimized', ws, minimizedHandler);
    setGroupCallRejoinHandler('restored', ws, restoredHandler);

    ws.fire();

    expect(minimizedHandler).not.toHaveBeenCalled();
    expect(restoredHandler).toHaveBeenCalledTimes(1);
    // And only ONE subscription is held on the transport.
    expect(ws.listenerCount()).toBe(1);
  });

  it('stops firing after a real teardown', () => {
    const ws = makeTransport();
    const rejoin = jest.fn();
    setGroupCallRejoinHandler('t1', ws, rejoin);

    clearGroupCallRejoinHandler();
    ws.fire();

    expect(rejoin).not.toHaveBeenCalled();
    expect(hasGroupCallRejoinHandler()).toBe(false);
    expect(ws.listenerCount()).toBe(0);
  });

  it('never rejoins a call that ended while minimized', () => {
    const {getActiveGroupCall} = require('../runtime/groupCallRegistry') as
      {getActiveGroupCall: jest.Mock};
    const ws = makeTransport();
    const rejoin = jest.fn();
    setGroupCallRejoinHandler('t1', ws, rejoin);

    getActiveGroupCall.mockReturnValue({state: 'ended-by-host'});
    ws.fire();
    expect(rejoin).not.toHaveBeenCalled();

    getActiveGroupCall.mockReturnValue(null);
    ws.fire();
    expect(rejoin).not.toHaveBeenCalled();
  });

  /**
   * The rejoin slot must never LATCH. `sfu.join` rides an ack whose
   * reject timer is a setTimeout — frozen while the screen is locked —
   * so if the socket dies between emit and ack the promise never
   * settles. A boolean flag would then block every future rejoin for the
   * rest of the call, silently defeating the whole point of this hub.
   */
  describe('rejoin slot', () => {
    it('serialises concurrent rejoins and releases on completion', () => {
      const claim = beginGroupCallRejoin();
      expect(claim).toBeGreaterThan(0);
      expect(beginGroupCallRejoin()).toBe(0);   // one at a time
      endGroupCallRejoin(claim);
      expect(beginGroupCallRejoin()).toBeGreaterThan(0);
    });

    /**
     * Review round 1 — the release is CLAIM-GUARDED.
     *
     * It was unconditional, while its sibling `endAttemptRunning` had already
     * been hardened for the identical reason. After a stuck-claim takeover the
     * ABANDONED rejoin still settles and still runs its `.finally`; an
     * unconditional release handed the slot away while the winner was
     * mid-rebuild, re-opening exactly the concurrency the 90 s ceiling was
     * widened to prevent.
     */
    it('a SUPERSEDED claim cannot release the winner\'s slot', () => {
      const realNow = Date.now;
      try {
        let t = 2_000_000;
        Date.now = () => t;
        const loser = beginGroupCallRejoin();
        expect(loser).toBeGreaterThan(0);
        t += GROUP_REJOIN_CEILING_MS + 1;
        const winner = beginGroupCallRejoin();          // takeover
        expect(winner).toBeGreaterThan(0);
        expect(winner).not.toBe(loser);

        endGroupCallRejoin(loser);                      // the loser settles late

        // The winner still holds it — a third rejoin must NOT start.
        expect(beginGroupCallRejoin()).toBe(0);
        endGroupCallRejoin(winner);
        expect(beginGroupCallRejoin()).toBeGreaterThan(0);
      } finally { Date.now = realNow; }
    });

    it('takes over a slot whose ack was lost (wall-clock expiry, never latches)', () => {
      const realNow = Date.now;
      try {
        let t = 1_000_000;
        Date.now = () => t;
        expect(beginGroupCallRejoin()).toBeGreaterThan(0);
        // The ack never arrives: endGroupCallRejoin is never called.
        t += GROUP_REJOIN_CEILING_MS - 1_000;
        expect(beginGroupCallRejoin()).toBe(0);              // still plausibly running
        t += 2_000;                                          // past the stuck window
        expect(beginGroupCallRejoin()).toBeGreaterThan(0);   // recovery possible again
      } finally {
        Date.now = realNow;
      }
    });

    /**
     * WI-3.3 — the ceiling has to outlive a REAL rejoin, not a guessed one.
     * At 30 s it did not: a 4-peer rejoin (TURN fetch + two produces + a
     * serial consume per remote producer, all over a socket that has just
     * reconnected) routinely ran longer, so the "stuck" takeover fired
     * against rejoins that were merely slow and restarted them from scratch.
     */
    it('the ceiling comfortably exceeds a real multi-peer rejoin', () => {
      expect(GROUP_REJOIN_CEILING_MS).toBeGreaterThanOrEqual(60_000);
    });

    it('the hub takeover window is LONGER than the rebuild-mark window', () => {
      // Review round 1 split these. One constant was serving two guards that
      // want opposite things: the takeover wants to be slow to abandon a
      // healthy rejoin, while the rebuild mark blinds the tile-reconcile
      // backstop for as long as it is held. Sharing 90 s meant a wedged
      // rejoin left a missed tile unhealed for a minute and a half.
      expect(GROUP_REJOIN_CEILING_MS).toBeGreaterThan(GROUP_REBUILD_MARK_CEILING_MS);
    });

    it('a takeover is release-visible, a first claim is silent', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const realNow = Date.now;
      try {
        let t = 1_000_000;
        Date.now = () => t;
        expect(beginGroupCallRejoin()).toBeGreaterThan(0);
        expect(warn).not.toHaveBeenCalled();               // an ordinary claim is quiet
        t += GROUP_REJOIN_CEILING_MS + 1;
        expect(beginGroupCallRejoin()).toBeGreaterThan(0); // takeover
        const line = warn.mock.calls.map(c => c.join(' ')).join('\n');
        expect(line).toContain('[CALLSM]');
        expect(line).toContain('groupcall.rejoin.takeover');
      } finally {
        Date.now = realNow;
        warn.mockRestore();
      }
    });

    it('the REFUSED sentinel (0) can never release the slot', () => {
      // 0 is both the "refused" return AND the counter's initial value, so a
      // caller that ignored a refusal would otherwise free a slot it never
      // held. Unreachable from the two production sites; made unreachable by
      // construction.
      const held = beginGroupCallRejoin();
      expect(held).toBeGreaterThan(0);
      endGroupCallRejoin(0);
      expect(beginGroupCallRejoin()).toBe(0);   // still held
      endGroupCallRejoin(held);
      expect(beginGroupCallRejoin()).toBeGreaterThan(0);
    });

    it('currentGroupCallRejoinClaim reports the live holder', () => {
      // This is what lets a LATE ack tell that it was taken over: the rejoin
      // generation is minted on ack arrival, so without it an abandoned
      // attempt would mint a HIGHER number than its replacement and tear down
      // the transports that replacement had just built.
      // No absolute assertion on the counter: it is monotonic for the life of
      // the module and deliberately NOT reset by `clearGroupCallRejoinHandler`
      // (that is what stops a claim taken before a clear matching afterwards),
      // so its value here depends on how many tests ran first. Only the
      // relative ordering is meaningful.
      const realNow = Date.now;
      try {
        // Mock the clock BEFORE the first claim: mixing a real-clock claim
        // with a mocked read makes the elapsed time arbitrary, and the
        // "still held" assertion below then depends on wall time.
        let t = 9_000_000;
        Date.now = () => t;
        const claim = beginGroupCallRejoin();
        expect(currentGroupCallRejoinClaim()).toBe(claim);
        const first = beginGroupCallRejoin();
        expect(first).toBe(0);                 // still held, no takeover yet
        t += GROUP_REJOIN_CEILING_MS + 1;
        const taken = beginGroupCallRejoin();  // takeover
        expect(taken).toBeGreaterThan(claim);
        expect(currentGroupCallRejoinClaim()).toBe(taken);
        // The abandoned attempt can now SEE that it lost.
        expect(claim).not.toBe(currentGroupCallRejoinClaim());
      } finally { Date.now = realNow; }
    });

    it('is released by a full teardown', () => {
      expect(beginGroupCallRejoin()).toBeGreaterThan(0);
      clearGroupCallRejoinHandler();
      expect(beginGroupCallRejoin()).toBeGreaterThan(0);
    });

    it('a claim from BEFORE a full teardown cannot release the slot afterwards', () => {
      const stale = beginGroupCallRejoin();
      clearGroupCallRejoinHandler();
      const fresh = beginGroupCallRejoin();
      expect(fresh).not.toBe(stale);
      endGroupCallRejoin(stale);
      expect(beginGroupCallRejoin()).toBe(0);   // fresh still holds it
    });
  });

  it('a throwing handler cannot break the transport dispatch', () => {
    const ws = makeTransport();
    setGroupCallRejoinHandler('t1', ws, () => { throw new Error('rejoin exploded'); });

    expect(() => ws.fire()).not.toThrow();
  });

  it('re-binding to a different transport drops the old subscription', () => {
    const oldWs = makeTransport();
    const newWs = makeTransport();
    const rejoin = jest.fn();
    setGroupCallRejoinHandler('t1', oldWs, rejoin);
    setGroupCallRejoinHandler('t2', newWs, rejoin);

    expect(oldWs.listenerCount()).toBe(0);
    expect(newWs.listenerCount()).toBe(1);

    oldWs.fire();
    expect(rejoin).not.toHaveBeenCalled();
    newWs.fire();
    expect(rejoin).toHaveBeenCalledTimes(1);
  });

  /**
   * WI-3.3 — ownership tokens.
   *
   * The hub deliberately outlives the screen, so "clear on teardown" was
   * ambiguous about WHOSE teardown. A stale hook instance's leaveInternal —
   * fired un-awaited by launchCall's `void staleLeave()` and by
   * endActiveGroupCall, both of which run while the NEXT call is already
   * booting — could retire the handler the new call had just installed. The
   * new call then ran its whole life with no WS-reopen recovery, and nothing
   * looked wrong until a socket bounced and it zombied.
   */
  describe('handler ownership (WI-3.3)', () => {
    it('records the installing owner', () => {
      const ws = makeTransport();
      setGroupCallRejoinHandler('room#1', ws, jest.fn());
      expect(currentGroupCallRejoinToken()).toBe('room#1');
    });

    it('a STALE instance cannot retire the live call\'s handler', () => {
      const ws = makeTransport();
      const oldInstance = jest.fn();
      const newInstance = jest.fn();
      setGroupCallRejoinHandler('room#1', ws, oldInstance);
      setGroupCallRejoinHandler('room#2', ws, newInstance);

      // The old instance's teardown lands LATE — after the new call installed.
      releaseGroupCallRejoinHandler('room#1');

      expect(hasGroupCallRejoinHandler()).toBe(true);
      expect(currentGroupCallRejoinToken()).toBe('room#2');
      ws.fire();
      expect(newInstance).toHaveBeenCalledTimes(1);
      expect(oldInstance).not.toHaveBeenCalled();
    });

    it('the OWNER can retire its own handler', () => {
      const ws = makeTransport();
      const rejoin = jest.fn();
      setGroupCallRejoinHandler('room#1', ws, rejoin);
      releaseGroupCallRejoinHandler('room#1');

      expect(hasGroupCallRejoinHandler()).toBe(false);
      expect(currentGroupCallRejoinToken()).toBeNull();
      ws.fire();
      expect(rejoin).not.toHaveBeenCalled();
      expect(ws.listenerCount()).toBe(0);
    });

    it('an instance that never installed (null token) cannot clear anything', () => {
      const ws = makeTransport();
      setGroupCallRejoinHandler('room#1', ws, jest.fn());
      releaseGroupCallRejoinHandler(null);
      expect(hasGroupCallRejoinHandler()).toBe(true);
    });

    it('a refused release is release-visible', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const ws = makeTransport();
        setGroupCallRejoinHandler('room#2', ws, jest.fn());
        releaseGroupCallRejoinHandler('room#1');
        const line = warn.mock.calls.map(c => c.join(' ')).join('\n');
        expect(line).toContain('[CALLSM]');
        expect(line).toContain('groupcall.rejoin.release.refused');
      } finally { warn.mockRestore(); }
    });

    it('releasing when nothing is installed is a silent no-op', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        clearGroupCallRejoinHandler();
        releaseGroupCallRejoinHandler('room#1');
        releaseGroupCallRejoinHandler(null);
        expect(warn).not.toHaveBeenCalled();
      } finally { warn.mockRestore(); }
    });

    it('the unconditional clear still works (logout / hard reset)', () => {
      const ws = makeTransport();
      setGroupCallRejoinHandler('room#1', ws, jest.fn());
      clearGroupCallRejoinHandler();
      expect(hasGroupCallRejoinHandler()).toBe(false);
      expect(currentGroupCallRejoinToken()).toBeNull();
    });

    it('tokens minted for the same room are distinct per installation', () => {
      // Two hook instances for ONE room is the normal minimize/restore shape,
      // so the room id alone cannot identify an owner.
      const a = nextGroupCallRejoinToken('ROOM');
      const b = nextGroupCallRejoinToken('ROOM');
      expect(a).not.toBe(b);
      expect(a).toContain('ROOM');
    });
  });

});
