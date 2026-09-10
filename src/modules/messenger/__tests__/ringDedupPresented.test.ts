/**
 * B-306 (dedup half) — a ring nobody HANDLED must stay eligible for the
 * server's reconnect replay.
 *
 * `dispatchGroupRingFrame` deduped `sfu.ring.incoming` by roomId at DISPATCH
 * time, and deliberately ran the marker "even with zero handlers". That
 * marks the ring as seen when it was never presented to anyone: a frame
 * arriving in a handler gap (boot, sign-in transition, HMR in dev) burned
 * the room's one chance, and the replay the server sends after a WS reopen
 * was silently swallowed — no ring surface, ever, for that call.
 *
 * With the B-306 park (a busy device parks instead of racing), a dispatched
 * ring is always either presented or parked — so marking at dispatch is
 * correct ONLY when at least one handler exists to do one of those things.
 * Zero handlers ⇒ do not mark ⇒ the replay re-fires when a handler is back.
 *
 * The original Finding #8(b) behaviour is still pinned below: WITH a handler
 * registered, a duplicate ring within the TTL fires onIncoming exactly once.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  clearAllGroupCallRingHandlers,
  dispatchGroupRingFrame,
  setGroupCallRingHandler,
  setGroupRingAckSender,
  type GroupCallRingPayload,
} from '../webrtc/groupCallRingDispatcher';

function frame(roomId: string): {event: string; data: GroupCallRingPayload} {
  return {
    event: 'sfu.ring.incoming',
    data: {
      roomId,
      conversationId: `conv-${roomId}`,
      callType:       'voice',
      from:           {userId: 'host-uuid', deviceId: 1},
      callerName:     'Host',
    },
  };
}

/**
 * A handler that PRESENTS the ring.
 *
 * WI-3.6 made the verdict explicit: the dedup marker is burned on what a
 * handler REPORTS, not on the fact that one was registered. This fake reports
 * `true` because it does surface the ring (it records it); `registerDeclining`
 * below is the counterpart that receives the ring and decides not to.
 */
function register(): {incoming: string[]; unsub: () => void} {
  const incoming: string[] = [];
  const unsub = setGroupCallRingHandler({
    onIncoming: r => { incoming.push(r.roomId); return true; },
    onCancel:   () => {},
    onDecline:  () => {},
  });
  return {incoming, unsub};
}

/**
 * A handler that receives the ring and DECLINES to present it — restore mode
 * is active, navigation isn't ready, the shell-aware navigate was dropped, or
 * it is `IncomingGroupCallScreen`'s deliberate no-op `onIncoming`.
 */
function registerDeclining(): {incoming: string[]; unsub: () => void} {
  const incoming: string[] = [];
  const unsub = setGroupCallRingHandler({
    onIncoming: r => { incoming.push(r.roomId); },
    onCancel:   () => {},
    onDecline:  () => {},
  });
  return {incoming, unsub};
}

beforeEach(() => {
  clearAllGroupCallRingHandlers();
});

describe('B-306 — dedup marks PRESENTED, not merely seen', () => {
  it('a ring dispatched into a handler gap does NOT burn the dedup slot', () => {
    // No handlers: the frame is unhandled…
    expect(dispatchGroupRingFrame(frame('room-gap'))).toBe(false);
    // …so the server replay after the handler registers must still ring.
    const {incoming} = register();
    dispatchGroupRingFrame(frame('room-gap'));
    expect(incoming).toEqual(['room-gap']);
  });

  it('Finding #8(b) still holds — a handled ring dedups its replay', () => {
    const {incoming} = register();
    dispatchGroupRingFrame(frame('room-dup'));
    dispatchGroupRingFrame(frame('room-dup'));
    expect(incoming).toEqual(['room-dup']);
  });

  it('cancel re-arms the room (pre-existing behaviour, must survive)', () => {
    const {incoming} = register();
    dispatchGroupRingFrame(frame('room-x'));
    dispatchGroupRingFrame({event: 'sfu.ring.cancelled', data: {roomId: 'room-x', conversationId: 'c'} as unknown as GroupCallRingPayload});
    dispatchGroupRingFrame(frame('room-x'));
    expect(incoming).toEqual(['room-x', 'room-x']);
  });
});

/**
 * WI-3.6 — B-306 moved the marker behind "at least one handler exists" on the
 * reasoning that "with at least one handler the ring is always either surfaced
 * or parked". That claim was FALSE, and the gap it left is the same user-
 * visible failure B-306 set out to fix.
 *
 * `MainNavigator.onIncoming` has at least five branches that receive the ring
 * and then return without presenting it (restore mode active, navigation not
 * ready, an already-ringing route, a silently-dropped shell navigate, a thrown
 * registry read) — and `IncomingGroupCallScreen` registers an `onIncoming`
 * that is a literal no-op yet still satisfies `handlers.length > 0`. Every one
 * of them burned the room's 60 s marker, so the server's reconnect replay AND
 * the FCM rescue copy were both suppressed and the ring was simply lost.
 */
describe('WI-3.6 — a ring nobody PRESENTED stays replayable', () => {
  it('a handler that declines does not burn the dedup slot', () => {
    // THE bug. The declining handler sees the ring (so `handlers.length > 0`
    // and the old code marked it) but never surfaces it.
    const declining = registerDeclining();
    dispatchGroupRingFrame(frame('room-suppressed'));
    expect(declining.incoming).toEqual(['room-suppressed']);

    // The rescue lane must still get through. This is the FCM copy / the
    // server's reconnect replay arriving once the suppressing condition has
    // cleared and a presenting handler is registered.
    declining.unsub();
    const presenting = register();
    dispatchGroupRingFrame(frame('room-suppressed'));
    expect(presenting.incoming).toEqual(['room-suppressed']);
  });

  it('a declining handler alongside a presenting one still marks', () => {
    // The real registration shape: IncomingGroupCallScreen's no-op is mounted
    // at the same time as MainNavigator's real handler. One presenter is
    // enough — otherwise every ring would double-fire.
    const declining  = registerDeclining();
    const presenting = register();
    dispatchGroupRingFrame(frame('room-both'));
    dispatchGroupRingFrame(frame('room-both'));
    expect(presenting.incoming).toEqual(['room-both']);
    expect(declining.incoming).toEqual(['room-both']);
  });

  it('a ring that was never presented is re-presented on EVERY retry, not just the first', () => {
    // The replay lanes retry more than once; a marker burned on the second
    // attempt would be just as fatal as one burned on the first.
    const declining = registerDeclining();
    dispatchGroupRingFrame(frame('room-retry'));
    dispatchGroupRingFrame(frame('room-retry'));
    dispatchGroupRingFrame(frame('room-retry'));
    expect(declining.incoming).toHaveLength(3);
  });

  it('presenting is what dedups — not the mere presence of a handler', () => {
    const presenting = register();
    dispatchGroupRingFrame(frame('room-mark'));
    dispatchGroupRingFrame(frame('room-mark'));
    expect(presenting.incoming).toEqual(['room-mark']);
  });

  it('a handler that THROWS has not presented, so the ring stays replayable', () => {
    // The dispatcher swallows handler faults so one bad handler can't block
    // the others. That must not be mistaken for a successful presentation.
    const unsub = setGroupCallRingHandler({
      onIncoming: () => { throw new Error('handler exploded'); },
      onCancel:   () => {},
      onDecline:  () => {},
    });
    expect(() => dispatchGroupRingFrame(frame('room-throw'))).not.toThrow();
    unsub();

    const presenting = register();
    dispatchGroupRingFrame(frame('room-throw'));
    expect(presenting.incoming).toEqual(['room-throw']);
  });

  it('only a literal true counts — a truthy-but-not-true return does not mark', () => {
    // `onIncoming` returns `boolean | void`. Accepting any truthy value would
    // let a handler that happens to return an object (a navigation result, a
    // promise) silently burn the marker.
    const unsub = setGroupCallRingHandler({
      onIncoming: (() => ({navigated: true})) as unknown as () => boolean,
      onCancel:   () => {},
      onDecline:  () => {},
    });
    dispatchGroupRingFrame(frame('room-truthy'));
    unsub();

    const presenting = register();
    dispatchGroupRingFrame(frame('room-truthy'));
    expect(presenting.incoming).toEqual(['room-truthy']);
  });
});

/**
 * WI-3.6 — the PRODUCER of the verdict.
 *
 * The dispatcher can only be as honest as its handlers. `MainNavigator` owns
 * the only `onIncoming` that actually presents a group ring, so its return
 * value IS the dedup decision. Two sites must report success and every
 * suppressing branch must stay silent.
 *
 * Source scan: MainNavigator pulls the whole navigation + RN graph and cannot
 * be imported under the node project (same limitation as
 * `escalationRingHandoff.test.ts`, which scans the same handler).
 */
describe('WI-3.6 — MainNavigator reports whether it presented the ring', () => {
  const NAV = join(process.cwd(), 'src', 'navigation', 'MainNavigator.tsx');

  /** Whole-line comments only — the fix's own comments name these symbols. */
  const CODE = readFileSync(NAV, 'utf8')
    .split(/\r?\n/)
    .filter(l => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');

  /** The group-ring handler block. */
  function ringHandler(): string {
    const i = CODE.indexOf('setGroupCallRingHandler({');
    expect(i).toBeGreaterThan(-1);
    return CODE.slice(i, i + 6000);
  }

  it('the navigate site RETURNS its result (RN6 drops a bad nested navigate silently)', () => {
    // B-460's lesson applied to the ring lane: the resolver already reported
    // failure, and this call site discarded it. That is precisely the
    // Ops-Room bug — a CPO/agency shell whose ring navigated nowhere while
    // the FCM rescue copy was dedup-suppressed.
    expect(ringHandler()).toMatch(
      /return navigateToMessengerScreen\(navigationRef as never, 'IncomingGroupCallScreen'/,
    );
  });

  it('the PARK site reports success — a parked ring is presented', () => {
    // Window the busy-1:1 branch precisely: from the park to the start of the
    // NEXT decision (`shouldNavigateForRing`). A fixed character count missed
    // it, because the branch carries a long registry-subscription retry
    // closure between the park and its return.
    const block = ringHandler();
    const park = block.indexOf('parkGroupRing(ring)');
    const next = block.indexOf('shouldNavigateForRing(');
    expect(park).toBeGreaterThan(-1);
    expect(next).toBeGreaterThan(park);
    expect(block.slice(park, next)).toMatch(/return true;/);
  });

  it('B-479 — the restore-mode branch PARKS the ring instead of dropping it', () => {
    /**
     * WI-3.6 originally required this branch to stay silent, so the server's
     * reconnect replay could bring the ring back. B-479 showed that lane does
     * not exist: the gateway clears the pending-ring artifacts as soon as it
     * replays them, and the restore flow connects a socket while the flag is
     * still armed — so the single replay could be consumed and discarded
     * mid-restore, leaving no ring, no replay and no missed-call record.
     *
     * Parking gives the ring an owner and a 45 s expiry that writes the
     * missed-call bubble, and `return true` is then the SAME contract the
     * 1:1-busy park site uses. A restore outlasting the TTL is covered by
     * B-481: the expiry re-arms the room's dedup marker so a later copy rings.
     */
    const block = ringHandler();
    const at = block.indexOf('isRestoreModeActive()');
    expect(at).toBeGreaterThan(-1);
    const branch = block.slice(at, at + 1400);
    expect(branch).toContain('parkGroupRing(ring)');
    expect(branch).toMatch(/return true;/);
  });

  /**
   * B-478 — FIXED. This was a DOCUMENTS pin on the broken behaviour; the fix
   * flipped it, which is exactly what such a pin is for.
   *
   * `consumePendingGroupRing()` is destructive — it clears the park AND
   * cancels its 45 s expiry — so discarding the resolver's verdict lost the
   * ring outright when it refused: not parked, not presented, and already
   * dedup-marked by the park site's own `return true`, so not even a
   * missed-call record. The ladder now keeps the verdict and gives the ring
   * back to the mailbox before retrying.
   */
  it('B-478 — the parked-ring consume ladder re-parks when the navigate is refused', () => {
    const block = ringHandler();
    const consume = block.indexOf('consumePendingGroupRing');
    expect(consume).toBeGreaterThan(-1);
    const ladder = block.slice(consume, consume + 1600);
    expect(ladder).toMatch(/const landed = navigateToMessengerScreen\(/);
    expect(ladder).toMatch(/if \(!landed\) \{/);
    // It must hand the ring BACK, not merely retry against an empty mailbox.
    expect(ladder).toMatch(/repark\(parked\)/);
    expect(ladder).toContain('attemptConsume(attempt + 1)');
  });

  it('B-478 — CallScreen\'s consume site re-parks too', () => {
    // The same destructive-consume-then-discard shape lived in the PRIMARY
    // B-306 consume path, not just the registry-null fallback.
    const screen = readFileSync(
      join(process.cwd(), 'src', 'screens', 'messenger', 'CallScreen.tsx'), 'utf8',
    );
    const at = screen.indexOf('consumePendingGroupRing();');
    expect(at).toBeGreaterThan(-1);
    // Window has to clear the explanatory comment block between the navigate
    // and the re-park; 2000 stopped just short of it and reported a missing
    // fix that was present.
    const body = screen.slice(at, at + 3200);
    expect(body).toMatch(/const landed = navigateToMessengerScreen\(/);
    expect(body).toMatch(/if \(!landed\) \{/);
    expect(body).toMatch(/parkGroupRing\(ring\)/);
  });

  it('the route-suppression branch stays SILENT too', () => {
    const block = ringHandler();
    const at = block.indexOf('shouldNavigateForRing(');
    expect(at).toBeGreaterThan(-1);
    const branch = block.slice(at, at + 320);
    expect(branch).toMatch(/return;/);
    expect(branch).not.toMatch(/return true;/);
  });
});

/**
 * Round 4 — the guards the review found missing on the fixes themselves.
 */
describe('round 4 — the consume sites are ordered and guarded', () => {
  const NAV2 = readFileSync(
    join(process.cwd(), 'src', 'navigation', 'MainNavigator.tsx'), 'utf8',
  );
  const SCREEN2 = readFileSync(
    join(process.cwd(), 'src', 'screens', 'messenger', 'CallScreen.tsx'), 'utf8',
  );

  it('B-479 — the restore-exit consume carries the SAME busy guard as its siblings', () => {
    /**
     * THE P1 the review caught on the fix. The restore branch is the FIRST test
     * in `onIncoming`, so a ring arriving during a restore parks under it and
     * the 1:1 ladder is never armed. Presenting on restore-exit without a busy
     * test pushes the ring screen on top of a live CallScreen — whose ended
     * auto-dismiss is a delayed goBack that pops whatever is on top, so the
     * ring is popped ~50 ms later, already consumed, its expiry cancelled and
     * its room dedup-marked. That is B-306 re-opened on a new path.
     */
    const at = NAV2.indexOf('restore ended — presenting parked ring');
    expect(at).toBeGreaterThan(-1);
    const before = NAV2.slice(Math.max(0, at - 1600), at);
    expect(before).toMatch(/route\?\.name === 'CallScreen' \|\| route\?\.name === 'VoiceCall'/);
    expect(before).toContain('callReg.getActiveCall()');
    // Pin the CONDITION, not just the lookup: a mutation that neuters the test
    // while leaving the call in place reads as guarded and is not.
    expect(before).toMatch(
      /if \(live1to1 && live1to1\.state !== 'ended' && live1to1\.state !== 'failed'\) \{return;\}/,
    );
    // …and the guards must precede the DESTRUCTIVE consume, not follow it.
    const guard   = before.lastIndexOf('getActiveCall()');
    const consume = before.lastIndexOf('consumePendingGroupRing()');
    expect(consume).toBeGreaterThan(guard);
  });

  it('B-478 — every re-park preserves the ring age', () => {
    // `parkGroupRing` stamps Date.now(); a re-park with it would reset the TTL
    // that exists to stop the user being walked into a room nobody is ringing.
    expect(NAV2).toContain('reparkGroupRing');
    expect(SCREEN2).toContain('reparkGroupRing');
    // Pin the IMPORT, not the call site. The ladder calls through an alias, so
    // swapping `reparkGroupRing` for `parkGroupRing` in the destructure leaves
    // `repark(parked)` textually identical while silently resetting the age.
    expect(NAV2).toMatch(/const \{consumePendingGroupRing, reparkGroupRing: repark\} = require/);
    expect(NAV2).not.toMatch(/const \{consumePendingGroupRing, parkGroupRing: repark\} = require/);
  });

  it('B-478 — CallScreen tests readiness BEFORE the destructive consume', () => {
    const at = SCREEN2.indexOf('const ring = consumePendingGroupRing();');
    expect(at).toBeGreaterThan(-1);
    const before = SCREEN2.slice(Math.max(0, at - 900), at);
    expect(before).toMatch(/isReady\(\)/);
  });

  it('B-478 — a throw past the consume gives the ring back', () => {
    // The old rationale ("the park TTL still bounds it") stopped being true the
    // moment the consume cancelled the park.
    const at = SCREEN2.indexOf('const ring = consumePendingGroupRing();');
    const body = SCREEN2.slice(at, at + 3600);
    expect(body).not.toContain('the park TTL still bounds it');
    expect(body).toMatch(/catch \{[\s\S]{0,400}?reparkGroupRing\(ring\)/);
  });
});

/**
 * B-479 server half — the client ACKS a replayed ring once it owns it.
 *
 * The server no longer deletes a queued ring the instant it replays it: the
 * replay used to be destructive, so the ring got exactly ONE chance to land and
 * a client that could not present it at that moment lost the call outright — no
 * ring, no replay, no missed-call record. The sharpest case is a socket coming
 * up mid backup-restore, which the restore flow does twice while its own
 * suppression flag is still armed.
 *
 * "Owns it" is deliberately wider than "showed a ring screen": presenting it
 * and recognising it as one we already have both count, because in each case
 * this client owns the outcome.
 */
describe('B-479 — acking a replayed ring', () => {
  function replayFrame(roomId: string, ringId?: string): {event: string; data: GroupCallRingPayload} {
    const f = frame(roomId);
    return {event: f.event, data: {...f.data, replayed: true, roomToken: 'tok', ...(ringId ? {ringId} : {})}};
  }

  let acks: Array<{roomId: string; roomToken?: string}>;
  beforeEach(() => {
    acks = [];
    setGroupRingAckSender((roomId, roomToken) => { acks.push({roomId, roomToken}); });
  });
  afterEach(() => { setGroupRingAckSender(null); });

  it('acks a replay this client PRESENTS', () => {
    const presenting = register();
    dispatchGroupRingFrame(replayFrame('room-ack'));
    expect(presenting.incoming).toEqual(['room-ack']);
    expect(acks).toEqual([{roomId: 'room-ack', roomToken: 'tok'}]);
  });

  it('acks a replay we already have — suppression is OWNERSHIP, not a decline', () => {
    // Without this the server would re-emit it on every reconnect until the
    // 45 s window closed, then land it as a spurious missed call for a ring the
    // user actually saw.
    const presenting = register();
    dispatchGroupRingFrame(replayFrame('room-dup2', 'r1'));
    expect(acks).toHaveLength(1);
    dispatchGroupRingFrame(replayFrame('room-dup2', 'r1'));   // dedup-suppressed
    expect(presenting.incoming).toEqual(['room-dup2']);
    expect(acks).toHaveLength(2);
  });

  it('does NOT ack a replay every handler declined', () => {
    // Nobody owns it, so the server must keep it and try again.
    const declining = registerDeclining();
    dispatchGroupRingFrame(replayFrame('room-declined'));
    expect(declining.incoming).toEqual(['room-declined']);
    expect(acks).toEqual([]);
  });

  it('does NOT ack a LIVE fan-out frame', () => {
    /**
     * The queued artifacts include the days-long missed-call marker. Clearing
     * it the moment a ring is shown would cost the user their missed-call
     * record for a call they simply never answered — so only a REPLAY, which
     * means "the queue did its job", is acked.
     */
    const presenting = register();
    dispatchGroupRingFrame(frame('room-live'));
    expect(presenting.incoming).toEqual(['room-live']);
    expect(acks).toEqual([]);
  });

  it('does NOT ack when there are no handlers at all', () => {
    setGroupRingAckSender((roomId) => { acks.push({roomId}); });
    expect(dispatchGroupRingFrame(replayFrame('room-nohandler'))).toBe(false);
    expect(acks).toEqual([]);
  });

  it('a throwing ack sender cannot break the ring path', () => {
    setGroupRingAckSender(() => { throw new Error('socket gone'); });
    const presenting = register();
    expect(() => dispatchGroupRingFrame(replayFrame('room-throwack'))).not.toThrow();
    expect(presenting.incoming).toEqual(['room-throwack']);
  });

  it('sign-out drops the sender — it closes over the previous user transport', () => {
    const presenting = register();
    clearAllGroupCallRingHandlers();
    const after = register();
    dispatchGroupRingFrame(replayFrame('room-signout'));
    expect(after.incoming).toEqual(['room-signout']);
    expect(acks).toEqual([]);
    void presenting;
  });
});
