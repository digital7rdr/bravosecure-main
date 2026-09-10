/**
 * WI-1.5 / WI-1.6 — the GROUP identity spine.
 *
 * Before this, exactly ONE of thirty `patchActiveGroupCall` call sites checked
 * which room it was writing to. Every frame handler, consume/reconcile write,
 * camera write and identity write from a superseded room wrote straight into
 * whatever call was active.
 *
 * And `endActiveGroupCall` did `active = null; notify(); await leave()` — so
 * for the whole duration of the leave every busy guard saw "no call" while the
 * mediasoup transports were still closing, admitting a boot that raced
 * `sfu.join` against them (the `transport_id_in_use` class).
 */
import type {ActiveGroupCallSeed} from '../runtime/groupCallRegistry';

/** Only mock-prefixed names are reachable from a hoisted jest.mock factory. */
const mockNative = {
  stopSharedAudioSession:    jest.fn(),
  stopCallForegroundService: jest.fn(),
};

jest.mock('../runtime/callAudioSession', () => ({
  __esModule: true,
  stopSharedAudioSession: (...a: unknown[]) => mockNative.stopSharedAudioSession(...a),
  otherStackHasLiveCall: () => false,
}));
jest.mock('../runtime/callForegroundService', () => ({
  __esModule: true,
  stopCallForegroundService: (...a: unknown[]) => mockNative.stopCallForegroundService(...a),
}));

import * as greg from '../runtime/groupCallRegistry';

function seed(roomId: string, over: Partial<ActiveGroupCallSeed> = {}): ActiveGroupCallSeed {
  return {
    roomId,
    conversationId:   'conv-1',
    conversationName: 'Team',
    callType:         'voice',
    isHost:           false,
    selfTag:          null,
    state:            'joined',
    localStream:      null,
    remoteTiles:      [],
    identityByTag:    {},
    audioLevels:      {},
    audioTrack:       null,
    videoTrack:       null,
    isMuted:          false,
    isVideoOff:       false,
    isMinimized:      false,
    keepAlive:        false,
    leave:            null,
    toggleMute:       null,
    toggleVideo:      null,
    joinedAtMs:       null,
    ...over,
  };
}

const flush = () => new Promise<void>(r => setImmediate(r));

/**
 * A `leave` shaped like the REAL one.
 *
 * `useGroupCall.leaveInternal` ends with Fix #14 — "only clear the registry if
 * it still points at OUR roomId" — so production's leave NULLS THE SLOT while
 * `endActiveGroupCall` is awaiting it. Every test here used a leave that never
 * touched the registry, which is exactly why a teardown that skipped the audio
 * and foreground-service stops on the dominant path looked green.
 */
function productionShapedLeave(roomId: string): {leave: jest.Mock; release: () => void} {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const leave = jest.fn(async () => {
    await gate;
    const reg = greg.getActiveGroupCall();
    if (reg && reg.roomId === roomId) { greg.setActiveGroupCall(null); }
  });
  return {leave, release: () => release()};
}

beforeEach(() => {
  jest.clearAllMocks();
  greg.setActiveGroupCall(null);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  greg.setActiveGroupCall(null);
  jest.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────
describe('WI-1.5 — writes are keyed by roomId', () => {
  it('mints a new generation per session, including for the same room', () => {
    const k1 = greg.setActiveGroupCall(seed('room-a'))!;
    const k2 = greg.setActiveGroupCall(seed('room-a'))!;
    expect(k2.gen).toBeGreaterThan(k1.gen);
    expect(greg.getActiveGroupCall()!.gen).toBe(k2.gen);
  });

  it('drops a patch aimed at a stale room', () => {
    greg.setActiveGroupCall(seed('room-old'));
    greg.setActiveGroupCall(seed('room-new', {conversationName: 'New'}));
    expect(greg.patchActiveGroupCall('room-old', {conversationName: 'Clobbered'})).toBe(false);
    expect(greg.getActiveGroupCall()!.conversationName).toBe('New');
  });

  it('applies a patch aimed at the live room', () => {
    greg.setActiveGroupCall(seed('room-live'));
    expect(greg.patchActiveGroupCall('room-live', {isMuted: true})).toBe(true);
    expect(greg.getActiveGroupCall()!.isMuted).toBe(true);
  });

  it('drops a patch with no room id (the pre-create window)', () => {
    greg.setActiveGroupCall(seed('room-live'));
    expect(greg.patchActiveGroupCall(null, {isMuted: true})).toBe(false);
    expect(greg.patchActiveGroupCall(undefined, {isMuted: true})).toBe(false);
    expect(greg.getActiveGroupCall()!.isMuted).toBe(false);
  });

  it('a patch can never rewrite identity', () => {
    const k = greg.setActiveGroupCall(seed('room-id'))!;
    greg.patchActiveGroupCall('room-id', {roomId: 'hijacked', gen: 999} as never);
    expect(greg.getActiveGroupCall()).toMatchObject({roomId: 'room-id', gen: k.gen});
  });

  it('drops a stale-room minimize', () => {
    greg.setActiveGroupCall(seed('room-m1'));
    greg.setActiveGroupCall(seed('room-m2'));
    expect(greg.setGroupCallMinimized('room-m1', true)).toBe(false);
    expect(greg.getActiveGroupCall()!.isMinimized).toBe(false);
  });

  it('reports every dropped write on the [CALLSM] lane', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    greg.setActiveGroupCall(seed('room-w1'));
    greg.setActiveGroupCall(seed('room-w2'));
    warn.mockClear();
    greg.patchActiveGroupCall('room-w1', {isMuted: true});
    const lines = warn.mock.calls.map(c => String(c[0]));
    expect(lines.some(l => l.startsWith('[CALLSM] group.patch.dropped') && l.includes('stale-room'))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
describe('WI-1.5 — the room rename (room_not_found re-create)', () => {
  it('renames when keyed on the id the registry actually holds', () => {
    const k = greg.setActiveGroupCall(seed('room-reaped'))!;
    expect(greg.renameActiveGroupCallRoom('room-reaped', 'room-fresh')).toBe(true);
    const live = greg.getActiveGroupCall()!;
    expect(live.roomId).toBe('room-fresh');
    // The session did NOT restart — it is the same call, re-pointed.
    expect(live.gen).toBe(k.gen);
  });

  it('a dropped RENAME is release-visible', () => {
    // `renameActiveGroupCallRoom`'s whole hazard is that keying it wrong is
    // SILENT: the entry strands on a reaped room, `leaveInternal` then skips
    // teardown, and `launchCall`'s busy guard blocks calls in OTHER
    // conversations with "Call in progress". `console.warn` survives the
    // release strip and `console.log` does not, so the channel is the contract.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log  = jest.spyOn(console, 'log').mockImplementation(() => {});

    // A `no-active` rename — the branch that reads the op-based channel. (A
    // `stale-room` drop is loud for EVERY op, so it would not exercise it.)
    greg.setActiveGroupCall(null);
    greg.renameActiveGroupCallRoom('room-gone', 'room-next');
    expect(warn.mock.calls.map(String).join('|')).toContain('group.rename.dropped');

    // …while a ROUTINE patch drop stays quiet. `no-active` (a write after the
    // call is gone), not `stale-room` — a stale-room write is one call aiming
    // at another and is loud for every op.
    greg.setActiveGroupCall(null);
    warn.mockClear(); log.mockClear();
    greg.patchActiveGroupCall('room-not-live', {isMuted: true});
    expect(warn.mock.calls.map(String).join('|')).not.toContain('group.patch.dropped');
    expect(log.mock.calls.map(String).join('|')).toContain('group.patch.dropped');
  });

  it('refuses (and does NOT strand the slot) when keyed on the NEW id', () => {
    // The trap this API exists for: `patchActiveGroupCall(rid, {roomId: rid})`
    // with `rid` already moved is a silent no-op, and a stranded id makes
    // `leaveInternal` skip teardown while launchCall's busy guard blocks calls
    // in other conversations with "Call in progress".
    greg.setActiveGroupCall(seed('room-reaped'));
    expect(greg.renameActiveGroupCallRoom('room-fresh', 'room-fresh')).toBe(false);
    expect(greg.getActiveGroupCall()!.roomId).toBe('room-reaped');
  });
});

// ────────────────────────────────────────────────────────────────────
describe('WI-1.6 — endActiveGroupCall must not null before the leave completes', () => {
  it('keeps the entry visible and marked `ending` for the whole leave', async () => {
    let release!: () => void;
    const leave = jest.fn(() => new Promise<void>(r => { release = r; }));
    greg.setActiveGroupCall(seed('room-end', {leave}));

    const done = greg.endActiveGroupCall();
    await flush();

    // Mid-leave: the slot is STILL there — that is what every busy guard reads.
    const during = greg.getActiveGroupCall();
    expect(during).not.toBeNull();
    expect(during!.roomId).toBe('room-end');
    expect(during!.ending).toBe(true);
    expect(leave).toHaveBeenCalledTimes(1);

    release();
    await done;
    expect(greg.getActiveGroupCall()).toBeNull();
  });

  it('refuses an end aimed at a stale room, and SAYS SO, and leaves the live one alone', async () => {
    // The overlay/watchdog case: a bubble still rendering room A while the slot
    // has moved to room B. Unkeyed, the End tap tore down B.
    const {leave} = productionShapedLeave('room-gone');
    greg.setActiveGroupCall(seed('room-gone', {leave}));
    greg.setActiveGroupCall(seed('room-current'));

    // The outcome is the whole point: `void` made a stale-key drop invisible,
    // so "await the teardown, then navigate" silently became "navigate now"
    // with the group call fully live — the B-320 two-live-calls state.
    expect(await greg.endActiveGroupCall('room-gone')).toBe('refused');

    expect(greg.getActiveGroupCall()!.roomId).toBe('room-current');
    expect(leave).not.toHaveBeenCalled();
    expect(mockNative.stopSharedAudioSession).not.toHaveBeenCalled();
    expect(mockNative.stopCallForegroundService).not.toHaveBeenCalled();
  });

  it('a REFUSED end still awaits a leave already in flight', async () => {
    // Otherwise `await endActiveGroupCall(wrongRoom)` resolves instantly while
    // transports are still closing — the caller resumes into the race the
    // await exists to prevent.
    const {leave, release} = productionShapedLeave('room-closing');
    greg.setActiveGroupCall(seed('room-closing', {leave}));
    const first = greg.endActiveGroupCall();
    await flush();

    let refusedSettled = false;
    const refused = greg.endActiveGroupCall('some-other-room').then(o => { refusedSettled = true; return o; });
    await flush();
    expect(refusedSettled).toBe(false);

    release();
    await Promise.all([first, refused]);
    expect(refusedSettled).toBe(true);
  });

  it('a room RENAME during the ending window does not wedge the entry forever', async () => {
    // Ownership keys on `gen` alone. `gen` is globally monotonic, so it already
    // means "this IS our entry"; also comparing roomId would read a rename
    // (which preserves gen) as a successor, leave `ending: true` stuck, and
    // wedge the app — launchCall permanently reporting the previous call still
    // hanging up, the overlay hidden, the adopt gate refusing, with no recovery
    // short of a restart.
    let release!: () => void;
    const leave = jest.fn(() => new Promise<void>(r => { release = r; }));
    greg.setActiveGroupCall(seed('room-before', {leave}));

    const done = greg.endActiveGroupCall();
    await flush();
    greg.renameActiveGroupCallRoom('room-before', 'room-after');
    release();
    await done;

    expect(greg.getActiveGroupCall()).toBeNull();
    expect(mockNative.stopSharedAudioSession).toHaveBeenCalledWith('group');
  });

  it('hands the started-flag to a SAME-room successor but never strands a different room’s', async () => {
    // Ownership is by `gen`; the started-flag is keyed by `roomId`. They are
    // different questions. A same-room successor inherited our flag and must
    // keep it. A different-room successor did not — and if ours is left in the
    // set, a later call landing on that roomId gets `markGroupAudioSessionStarted`
    // = false and its audio effect early-returns: no InCallManager.start, no
    // foreground service, no cleanup — a silent call with no audio.
    for (const [label, successorRoom, expectFlagFree] of [
      ['same-room successor keeps it',      'room-flag', false],
      ['different-room successor frees it', 'room-other', true],
    ] as const) {
      greg.setActiveGroupCall(null);
      let release!: () => void;
      const leave = jest.fn(() => new Promise<void>(r => { release = r; }));
      greg.setActiveGroupCall(seed('room-flag', {leave}));
      expect(greg.markGroupAudioSessionStarted('room-flag')).toBe(true);

      const done = greg.endActiveGroupCall();
      await flush();
      greg.setActiveGroupCall(seed(successorRoom));   // a genuinely newer session
      release();
      await done;

      // `markGroupAudioSessionStarted` returns true only when the flag was NOT set.
      // Labelled: two cases share this body and the failure message would
      // otherwise not say which successor shape broke.
      expect({case: label, flagFree: greg.markGroupAudioSessionStarted('room-flag')})
        .toEqual({case: label, flagFree: expectFlagFree});
      greg.clearGroupAudioSessionStarted('room-flag');
      greg.clearGroupAudioSessionStarted(successorRoom);
    }
  });

  it('clears the leave bound when leave() wins, leaving no dangling timer', async () => {
    // A dangling 3 s timer retains `entry`/`leave` per end, and under Jest it
    // fires after teardown and logs into a dead environment — the B-304
    // moving-flake shape.
    jest.useFakeTimers();
    try {
      const leave = jest.fn(() => Promise.resolve());
      greg.setActiveGroupCall(seed('room-timer', {leave}));
      await greg.endActiveGroupCall();
      expect(greg.getActiveGroupCall()).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('an omitted roomId still means "end whatever is live"', async () => {
    // signOut / the FGS action genuinely name no room; that must keep working.
    const {leave, release} = productionShapedLeave('room-any');
    greg.setActiveGroupCall(seed('room-any', {leave}));
    const done = greg.endActiveGroupCall();
    await flush();
    release();
    await done;
    expect(greg.getActiveGroupCall()).toBeNull();
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('publishes the in-flight leave BEFORE listeners are told we are ending', async () => {
    // A listener notified on the `ending` transition can re-enter
    // endActiveGroupCall. If the handle is published after `notify()`, that
    // re-entry finds null and resolves IMMEDIATELY — so a caller that awaited
    // it (GroupCallScreen's "Fix #15: AWAIT endActiveGroupCall before
    // navigating") proceeds onto a half-closed socket.
    let seenFromListener: Promise<void> | null | undefined;
    let reentrySettled = false;
    const {leave, release} = productionShapedLeave('room-notify-order');
    greg.setActiveGroupCall(seed('room-notify-order', {leave}));

    const off = greg.onActiveGroupCallChange(s => {
      if (!s?.ending || seenFromListener !== undefined) {return;}
      seenFromListener = greg.groupLeaveInFlight();
      void greg.endActiveGroupCall().then(() => { reentrySettled = true; });
    });

    const done = greg.endActiveGroupCall();
    await flush();
    off();

    expect(seenFromListener).toBeTruthy();
    expect(reentrySettled).toBe(false);   // genuinely parked on the real leave

    release();
    await done;
    await flush();
    expect(reentrySettled).toBe(true);
  });

  it('publishes the in-flight leave BEFORE leave() starts running', async () => {
    // `leaveInternal` has a SYNCHRONOUS prefix (clear the rejoin handler,
    // setState('left'), drop the frame subscription) that can drive a listener
    // straight back into endActiveGroupCall. If the handle is published only
    // after the leave is kicked off, that re-entry finds null and returns
    // WITHOUT awaiting — and `acceptIncomingOneToOne`'s "Fix #15: AWAIT
    // endActiveGroupCall before navigating" resumes onto a half-closed socket.
    let seenFromInsideLeave: Promise<void> | null | undefined;
    let release!: () => void;
    const leave = jest.fn(() => {
      seenFromInsideLeave = greg.groupLeaveInFlight();
      return new Promise<void>(r => { release = r; });
    });
    greg.setActiveGroupCall(seed('room-publish', {leave}));

    const done = greg.endActiveGroupCall();
    await flush();
    expect(leave).toHaveBeenCalledTimes(1);
    expect(seenFromInsideLeave).toBeTruthy();

    release();
    await done;
  });

  it('exposes the in-flight leave so the next boot can await it', async () => {
    let release!: () => void;
    const leave = jest.fn(() => new Promise<void>(r => { release = r; }));
    greg.setActiveGroupCall(seed('room-await', {leave}));

    const done = greg.endActiveGroupCall();
    await flush();
    const inFlight = greg.groupLeaveInFlight();
    expect(inFlight).not.toBeNull();

    release();
    await done;
    // Cleared once the room really is closed, so a later boot does not wait
    // on a promise that has already settled forever.
    expect(greg.groupLeaveInFlight()).toBeNull();
  });

  it('a competing boot that awaits the in-flight leave sees a CLOSED room', async () => {
    // The `transport_id_in_use` shape: the new boot must not reach sfu.join
    // while the old leave is still closing.
    const order: string[] = [];
    let release!: () => void;
    const leave = jest.fn(() => new Promise<void>(r => {
      release = () => { order.push('leave-resolved'); r(); };
    }));
    greg.setActiveGroupCall(seed('room-race', {leave}));

    const ending = greg.endActiveGroupCall();
    await flush();

    const boot = (async () => {
      const prior = greg.groupLeaveInFlight();
      if (prior) { await prior; }
      order.push('sfu.join');
      // The slot the booting call finds must be empty, not the corpse.
      expect(greg.getActiveGroupCall()).toBeNull();
    })();

    await flush();
    expect(order).toEqual([]);          // the boot is genuinely parked

    release();
    await Promise.all([ending, boot]);
    expect(order).toEqual(['leave-resolved', 'sfu.join']);
  });

  it('a second end joins the teardown in progress instead of starting another', async () => {
    let release!: () => void;
    const leave = jest.fn(() => new Promise<void>(r => { release = r; }));
    greg.setActiveGroupCall(seed('room-double', {leave}));

    const first  = greg.endActiveGroupCall();
    await flush();
    const second = greg.endActiveGroupCall();
    await flush();

    expect(leave).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(greg.getActiveGroupCall()).toBeNull();
    expect(mockNative.stopSharedAudioSession).toHaveBeenCalledTimes(1);
    expect(mockNative.stopCallForegroundService).toHaveBeenCalledTimes(1);
  });

  it('a wedged leave is bounded — the slot still clears', async () => {
    jest.useFakeTimers();
    try {
      const leave = jest.fn(() => new Promise<void>(() => { /* never resolves */ }));
      greg.setActiveGroupCall(seed('room-wedged', {leave}));
      const done = greg.endActiveGroupCall();
      await Promise.resolve();
      expect(greg.getActiveGroupCall()!.ending).toBe(true);
      jest.advanceTimersByTime(3_000);
      await done;
      expect(greg.getActiveGroupCall()).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('STILL stops the audio session and the FGS when leave() nulled the slot itself', async () => {
    // The dominant path, with the real leave shape. `leaveInternal`'s Fix #14
    // tail clears the registry during the ending window, so by the time the
    // teardown resumes the slot is ALREADY null — and reading that as "somebody
    // superseded me" skipped both stops. Symptoms: the device pinned in
    // MODE_IN_COMMUNICATION ("no call audio", the CALL-N5 mirror) and a
    // stranded "Bravo Secure call · Hang up" notification (B-256). Nothing else
    // stops them when no screen is mounted — which is exactly the minimized
    // overlay-End case.
    const {leave, release} = productionShapedLeave('room-selfnull');
    greg.setActiveGroupCall(seed('room-selfnull', {leave}));

    const done = greg.endActiveGroupCall();
    await flush();
    release();
    await done;

    expect(greg.getActiveGroupCall()).toBeNull();
    expect(mockNative.stopSharedAudioSession).toHaveBeenCalledWith('group');
    expect(mockNative.stopCallForegroundService).toHaveBeenCalledWith('group');
  });

  it('does not stop the audio session or FGS when a NEW call took the slot', async () => {
    let release!: () => void;
    const leave = jest.fn(() => new Promise<void>(r => { release = r; }));
    greg.setActiveGroupCall(seed('room-superseded', {leave}));
    const done = greg.endActiveGroupCall();
    await flush();

    // A boot that did not wait (or a different room entirely) claims the slot.
    greg.setActiveGroupCall(seed('room-successor'));
    release();
    await done;

    expect(greg.getActiveGroupCall()!.roomId).toBe('room-successor');
    expect(mockNative.stopSharedAudioSession).not.toHaveBeenCalled();
    expect(mockNative.stopCallForegroundService).not.toHaveBeenCalled();
  });

  it('ending with no active call still awaits a leave already in flight', async () => {
    let release!: () => void;
    const leave = jest.fn(() => new Promise<void>(r => { release = r; }));
    greg.setActiveGroupCall(seed('room-solo', {leave}));
    const first = greg.endActiveGroupCall();
    await flush();

    // Drop the slot out from under the teardown, then end again: the caller's
    // `await` must still mean "the room is quiet".
    greg.setActiveGroupCall(null);
    let settled = false;
    const second = greg.endActiveGroupCall().then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);

    release();
    await Promise.all([first, second]);
    expect(settled).toBe(true);
  });

  it('listeners see the null only once the room is actually closed', async () => {
    const seen: Array<string | null | 'ending'> = [];
    let release!: () => void;
    const leave = jest.fn(() => new Promise<void>(r => { release = r; }));
    greg.setActiveGroupCall(seed('room-notify', {leave}));
    const off = greg.onActiveGroupCallChange(s => {
      seen.push(s === null ? null : (s.ending ? 'ending' : s.roomId));
    });
    seen.length = 0;                      // drop the register-time replay

    const done = greg.endActiveGroupCall();
    await flush();
    expect(seen).toEqual(['ending']);     // NOT null — the guards must still see a call

    release();
    await done;
    off();
    expect(seen).toEqual(['ending', null]);
  });
});

// ────────────────────────────────────────────────────────────────────
describe('WI-1.6 — `ending` is busy to the launch side, dead to the resume side', () => {
  it('hasLiveCall() is FALSE for an ending call — it is not resumable', async () => {
    const {hasLiveCall} = require('../runtime/callResumeGuard') as typeof import('../runtime/callResumeGuard');
    const {leave, release} = productionShapedLeave('room-resume');
    greg.setActiveGroupCall(seed('room-resume', {leave}));
    expect(hasLiveCall()).toBe(true);
    //  observed as the REAL teardown produces it, not by poking the
    // registry's internals — the difference is what hid P0-1.
    const done = greg.endActiveGroupCall();
    await flush();
    expect(greg.getActiveGroupCall()!.ending).toBe(true);
    expect(hasLiveCall()).toBe(false);
    release(); await done;
  });

  it('otherStackHasLiveCall("direct") is FALSE for an ending group call', async () => {
    // Regression guard for CALL-N5: before WI-1.6 the slot was already null
    // here, so counting an ending entry would newly REFUSE the 1:1 audio stop
    // for the whole leave window and pin MODE_IN_COMMUNICATION.
    const real = jest.requireActual('../runtime/callAudioSession') as
      typeof import('../runtime/callAudioSession');
    const {leave, release} = productionShapedLeave('room-audio');
    greg.setActiveGroupCall(seed('room-audio', {leave}));
    expect(real.otherStackHasLiveCall('direct')).toBe(true);
    const done = greg.endActiveGroupCall();
    await flush();
    expect(real.otherStackHasLiveCall('direct')).toBe(false);
    release(); await done;
  });
});

// ────────────────────────────────────────────────────────────────────
describe('WI-1.6 — the `ending` rule is applied at every reader, not just the registry', () => {
  /**
   * ONE rule, stated once so a future reader can check a new call site against
   * it instead of guessing:
   *
   *   • LAUNCH/JOIN side (anything that would create a competing session) —
   *     `ending` is BUSY. The transports are still closing.
   *   • EVERYTHING ELSE (resume, rejoin, ring presentation, UI) —
   *     `ending` is NOT LIVE. It is a corpse, not a call to return to.
   *
   * These are source scans because the readers live in RN modules the node
   * project cannot import. CRLF-safe (line-based), comments stripped.
   */
  const {readFileSync} = require('node:fs') as typeof import('node:fs');
  const {join} = require('node:path') as typeof import('node:path');

  /** Strip line comments only — conservative, so a real `//` inside a string survives. */
  function codeOf(rel: string): string {
    return readFileSync(join(process.cwd(), rel), 'utf8')
      .split(/\r?\n/)
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
  }

  it.each([
    // launch/join side — ending is BUSY, so it is excluded from the rejoin escape hatch
    ['src/modules/messenger/webrtc/launchCall.ts',            /busyGroup !== null && !busyGroup\.ending/],
    // adopt gate — an ending entry has dead transports
    ['src/modules/messenger/webrtc/useGroupCall.ts',          /transportsAlive && !existing\.ending/],
    // rejoin — never rejoin a call we are leaving
    ['src/modules/messenger/webrtc/groupCallRejoinHub.ts',    /!!g && !g\.ending/],
    // resume — an ending call is not resumable
    ['src/modules/messenger/runtime/callResumeGuard.ts',      /g && !g\.ending/],
    // audio arbitration — CALL-N5: an ending call must not block the 1:1 stop
    ['src/modules/messenger/runtime/callAudioSession.ts',     /g !== null && g\.ending !== true/],
    // ring dedup — an ending call must not suppress a genuine ring
    ['src/navigation/MainNavigator.tsx',                      /active && !active\.ending \? active\.roomId : null/],
    // waiting banner — fall through to the normal ring path
    ['src/navigation/MainNavigator.tsx',                      /liveGroupForBanner && !liveGroupForBanner\.ending/],
    // FCM system-ring busy gate
    ['src/modules/messenger/push/fcmBootstrap.ts',            /!!liveGroup && !liveGroup\.ending/],
    // the floating bubble must not float a call that is leaving
    ['src/screens/messenger/FloatingCallOverlay.tsx',         /groupActive\?\.isMinimized && !groupActive\.ending/],
    // the screen's audio cleanup is the ONLY other place that stops the group
    // audio session + FGS; an ending entry must not make it skip them.
    //
    // B-595 — the rule MOVED, it did not go away. The screen used to inline
    // `const live = raw && !raw.ending ? raw : null`; the whole release
    // decision now lives in the pure `shouldReleaseSharedCallResources`,
    // which applies the same `ending` test on the entry it is handed. Pinned
    // at BOTH ends: the screen must still feed the raw registry entry to the
    // predicate, and the predicate must still consult `ending`.
    ['src/screens/messenger/GroupCallScreen.tsx',             /shouldReleaseSharedCallResources\(\{\s*entry: raw,/],
    ['src/screens/messenger/groupCallResourceRelease.ts',     /entry && entry\.ending !== true \? entry : null/],
    // busy behind a call the user JUST ENDED is a 3 s window, and the alert
    // must say THAT rather than "Finish the current call before starting a
    // new one" — a lie about a call they already finished
    ['src/modules/messenger/webrtc/launchCall.ts',            /busyOneToOne === null && busyGroup !== null && busyGroup\.ending === true/],
  ])('%s consults `ending`', (file, pattern) => {
    expect(codeOf(file as string)).toMatch(pattern as RegExp);
  });

  it('the blocked-behind-leave alert does NOT auto-retry the launch', () => {
    // A deferred launch navigates seconds later with no way to cancel, and
    // neither the CALL-17 latch nor the group branch guards a QUEUE of them —
    // N taps inside the window would each fire ringRecipients + a navigate.
    // Telling the user to try again is the smaller failure.
    const src = codeOf('src/modules/messenger/webrtc/launchCall.ts');
    expect(src).toMatch(/Ending the previous call/);
    expect(src).not.toMatch(/afterLeaveRetry/);
    expect(src).not.toMatch(/launchCall\(nav, opts, true\)/);
  });

  it('a restored group call INHERITS its registry key, so the leave guard keeps its generation', () => {
    // Without this the guard silently degrades to the id-only test it replaced,
    // for exactly the instance most likely to overlap a same-room successor.
    const src = codeOf('src/modules/messenger/webrtc/useGroupCall.ts');
    expect(src).toMatch(/groupKeyRef\.current = \{roomId: existing\.roomId, gen: existing\.gen\}/);
    expect(src).toMatch(/reg\.roomId === rid && \(!ours \|\| reg\.gen === ours\.gen\)/);
  });

  it('the boot awaits the registry’s in-flight leave before sfu.join', () => {
    // WI-1.6's "expose the in-flight promise so the next boot can await the
    // previous leave" — without this the whole ordering change buys nothing.
    const src = codeOf('src/modules/messenger/webrtc/useGroupCall.ts');
    // BOTH, not `??`. When both exist, `staleLeavePromise` is the worthless one:
    // the un-adoptable branch re-invokes the SAME `leaveInternal` whose
    // `isLeavingRef` is already set, so it resolves immediately — and `??`
    // would have picked exactly that and waved the join straight through.
    expect(src).toMatch(/\[staleLeavePromise, groupLeaveInFlight\(\)\]/);
    expect(src).toMatch(/Promise\.all\(priorLeaves\)/);
    expect(src).not.toMatch(/staleLeavePromise \?\? groupLeaveInFlight/);
    const awaitAt = src.indexOf('const priorLeaves =');
    const joinAt  = src.indexOf("'sfu.join'");
    expect(awaitAt).toBeGreaterThan(-1);
    expect(joinAt).toBeGreaterThan(awaitAt);
  });
});
