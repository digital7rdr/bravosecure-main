/**
 * WI-1.1 / WI-1.2 / WI-1.4 — the 1:1 identity spine.
 *
 * The registry used to accept UNKEYED writes and teardowns: ~40 call sites
 * mutated "whatever is active". Any stale continuation — a late ring expiry, a
 * queued hangup ack, an ICE-failed on a closing PC, a reconcile tick from a
 * previous kept-alive call — could mutate or TEAR DOWN a newer call. And
 * `endActiveCall` was re-entrant: it called `controller.hangup()`, which fires
 * `useCall.onState` terminal SYNCHRONOUSLY, which called straight back into
 * `endActiveCall`, double-running unregister / audio-stop / CallKit report /
 * notif dismiss / FGS stop / listener notify.
 *
 * This file pins the three properties that close that class:
 *   I3 — events from an old call cannot mutate a newer call;
 *   I5 — end is safe to call repeatedly, and runs its side effects ONCE;
 *   I10 — one live media-state handler no matter how many times we adopt.
 *
 * Node project (`messenger-crypto`): the registry is a plain module, and every
 * native edge it lazy-`require`s is mocked below.
 */
import type {ActiveCallSeed} from '../runtime/callRegistry';

/** Jest hoists jest.mock factories above this; only mock-prefixed names may be
 *  reached from inside one, hence the holder. */
const mockNative = {
  stopSharedAudioSession:   jest.fn(),
  stopCallForegroundService: jest.fn(),
  reportEnded:              jest.fn(),
  clearIncomingCallPayload: jest.fn(),
  dismissCallNotif:         jest.fn(),
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
jest.mock('../push/callKitBridge', () => ({
  __esModule: true,
  reportEnded: (...a: unknown[]) => mockNative.reportEnded(...a),
}));
jest.mock('../push/incomingCallCache', () => ({
  __esModule: true,
  clearIncomingCallPayload: (...a: unknown[]) => mockNative.clearIncomingCallPayload(...a),
}));
jest.mock('../push/callNotification', () => ({
  __esModule: true,
  dismissCallNotif: (...a: unknown[]) => mockNative.dismissCallNotif(...a),
}));

import * as reg from '../runtime/callRegistry';

const PEER = {userId: 'u-peer', deviceId: 1};

function seed(callId: string, over: Partial<ActiveCallSeed> = {}): ActiveCallSeed {
  return {
    callId,
    conversationId: `direct:${PEER.userId}`,
    peer:           PEER,
    peerName:       '',
    kind:           'voice',
    direction:      'outgoing',
    controller:     null,
    signalling:     null,
    unregister:     null,
    localStream:    null,
    remoteStream:   null,
    audioTrack:     null,
    videoTrack:     null,
    state:          'connecting',
    isMinimized:    false,
    keepAlive:      false,
    connectedAtMs:  null,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  reg.setActiveCall(null);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  reg.setActiveCall(null);
  jest.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────
describe('WI-1.1 — generation minting', () => {
  it('every setActiveCall mints a NEW generation, even for the same callId', () => {
    const k1 = reg.setActiveCall(seed('call-a'));
    const k2 = reg.setActiveCall(seed('call-a'));
    expect(k1).not.toBeNull();
    expect(k2).not.toBeNull();
    expect(k2!.gen).toBeGreaterThan(k1!.gen);
    expect(reg.getActiveCall()!.gen).toBe(k2!.gen);
  });

  it('the minted key matches the stored entry', () => {
    const k = reg.setActiveCall(seed('call-b'))!;
    expect(k.callId).toBe('call-b');
    expect(reg.getActiveCall()).toMatchObject({callId: 'call-b', gen: k.gen});
  });

  it('clearing returns null and leaves no entry', () => {
    reg.setActiveCall(seed('call-c'));
    expect(reg.setActiveCall(null)).toBeNull();
    expect(reg.getActiveCall()).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
describe('WI-1.1 — a stale key may not mutate a newer call', () => {
  it('drops a patch carrying a stale GENERATION of the same callId', () => {
    const stale = reg.setActiveCall(seed('call-x', {peerName: 'first'}))!;
    const fresh = reg.setActiveCall(seed('call-x', {peerName: 'second'}))!;

    expect(reg.patchActiveCall(stale, {peerName: 'clobbered'})).toBe(false);
    expect(reg.getActiveCall()!.peerName).toBe('second');
    // …and the SAME id with the CURRENT generation still works, so the drop is
    // about identity and not about the id being rejected wholesale.
    expect(reg.patchActiveCall(fresh, {peerName: 'legit'})).toBe(true);
    expect(reg.getActiveCall()!.peerName).toBe('legit');
  });

  it('drops a patch carrying a different callId', () => {
    const old = reg.setActiveCall(seed('call-old'))!;
    reg.setActiveCall(seed('call-new'));
    expect(reg.patchActiveCall(old, {state: 'failed'})).toBe(false);
    expect(reg.getActiveCall()).toMatchObject({callId: 'call-new', state: 'connecting'});
  });

  it('drops a patch with no key at all (the pre-registration window)', () => {
    reg.setActiveCall(seed('call-live'));
    expect(reg.patchActiveCall(null, {state: 'failed'})).toBe(false);
    expect(reg.getActiveCall()!.state).toBe('connecting');
  });

  it('a patch can never rewrite identity', () => {
    const k = reg.setActiveCall(seed('call-id'))!;
    // `callId`/`gen` are excluded from the patch type; force one through the
    // way a JS caller could, and prove the registry still refuses it.
    reg.patchActiveCall(k, {callId: 'hijacked', gen: 999} as never);
    expect(reg.getActiveCall()).toMatchObject({callId: 'call-id', gen: k.gen});
  });

  it('drops a stale-key END and leaves the newer call completely alone', () => {
    const stale = reg.setActiveCall(seed('call-1'))!;
    reg.setActiveCall(seed('call-2'));
    jest.clearAllMocks();

    expect(reg.endActiveCall(stale, 'ended', 'local')).toBe('refused');
    expect(reg.getActiveCall()).toMatchObject({callId: 'call-2'});
    // The whole point: no teardown side effect may fire for the live call.
    expect(mockNative.stopSharedAudioSession).not.toHaveBeenCalled();
    expect(mockNative.stopCallForegroundService).not.toHaveBeenCalled();
    expect(mockNative.reportEnded).not.toHaveBeenCalled();
  });

  it('drops a stale-key MINIMIZE', () => {
    const stale = reg.setActiveCall(seed('call-m1'))!;
    reg.setActiveCall(seed('call-m2'));
    expect(reg.setMinimized(stale, true)).toBe(false);
    expect(reg.getActiveCall()!.isMinimized).toBe(false);
  });

  it('no call site reads a teardown outcome in BOOLEAN position', () => {
    // `endActiveCall` used to return `boolean`; it now returns a string union
    // whose every member is TRUTHY. Any surviving `if (endActiveCall(...))` or
    // `!endActiveCall(...)` therefore inverts silently — no type error, no test
    // failure, just the fallback teardown firing on exactly the wrong branch.
    // That is the shape the next migration will trip over, so pin it.
    const {readFileSync, readdirSync, statSync} = require('node:fs') as typeof import('node:fs');
    const {join, extname} = require('node:path') as typeof import('node:path');

    const CALL = String.raw`(await\s+)?[\w.]*\bendActive(Group)?Call\s*\(`;
    const BOOLEAN_POSITION = [
      new RegExp(String.raw`\bif\s*\(\s*!?\s*${CALL}`),
      new RegExp(String.raw`[&|]{2}\s*!?\s*${CALL}`),
      new RegExp(String.raw`\breturn\s+!?\s*${CALL}`),
      new RegExp(String.raw`!\s*${CALL}`),
      new RegExp(String.raw`${CALL}[^;]*\)\s*\?`),          // ternary test
    ];
    // The capture-then-branch shape is the one the repo actually writes, so the
    // scan has to follow the binding: `const ok = endActiveCall(...)` then
    // `if (ok)`. Without this the pin only covers a form nobody uses here.
    const CAPTURE = new RegExp(String.raw`\b(?:const|let|var)\s+(\w+)\s*=\s*${CALL}`);

    const offenders: string[] = [];
    let callSitesSeen = 0;
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name === 'node_modules' || name === '__tests__') {continue;}
          walk(full);
        } else if (extname(name) === '.ts' || extname(name) === '.tsx') {
          const lines = readFileSync(full, 'utf8').split(/\r?\n/);
          const captured = new Map<string, number>();
          lines.forEach((line, i) => {
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) {return;}   // strip comment lines
            if (/\bendActive(Group)?Call\s*\(/.test(line)) {callSitesSeen++;}
            if (BOOLEAN_POSITION.some(re => re.test(line))) {
              offenders.push(`${full}:${i + 1}: ${line.trim()}`);
            }
            const cap = CAPTURE.exec(line);
            if (cap) {captured.set(cap[1], i + 1);}
          });
          // A captured outcome read as a bare truthiness test, anywhere after.
          for (const [name_, declaredAt] of captured) {
            const bare = new RegExp(String.raw`(\bif\s*\(\s*!?\s*${name_}\s*\)|[&|]{2}\s*!?\s*${name_}\b|\breturn\s+!\s*${name_}\b)`);
            lines.slice(declaredAt).forEach((line, j) => {
              if (/^\s*(\/\/|\*|\/\*)/.test(line)) {return;}
              if (bare.test(line)) {
                offenders.push(`${full}:${declaredAt + j + 1}: captured outcome in boolean position: ${line.trim()}`);
              }
            });
          }
        }
      }
    };
    walk(join(process.cwd(), 'src'));

    // POSITIVE CONTROL. `toEqual([])` is absence-only: if the root, the
    // extension filter or a regex ever rots, this test certifies an empty set
    // and goes green having looked at nothing. Fail loudly instead.
    expect(callSitesSeen).toBeGreaterThanOrEqual(15);
    expect(offenders).toEqual([]);
  });

  it('a dropped END is release-visible; a dropped PATCH is not', () => {
    // `console.warn` survives the release strip and `console.log` does not, so
    // the channel IS the contract. Routine patch drops (a write before the key
    // is minted, a write after the call is gone) would bury the lane; an End
    // that landed nowhere is exactly the "End does not end" evidence you grep
    // a release logcat for.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log  = jest.spyOn(console, 'log').mockImplementation(() => {});

    reg.patchActiveCall('no-such-call', {peerName: 'x'});
    expect(warn.mock.calls.map(String).join('|')).not.toContain('registry.patch.dropped');
    expect(log.mock.calls.map(String).join('|')).toContain('registry.patch.dropped');

    warn.mockClear();
    reg.endActiveCall('no-such-call', 'ended', 'local');
    expect(warn.mock.calls.map(String).join('|')).toContain('registry.end.dropped');
  });

  it('every dropped op is reported on the [CALLSM] lane', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const stale = reg.setActiveCall(seed('call-w1'))!;
    reg.setActiveCall(seed('call-w2'));
    warn.mockClear();
    reg.patchActiveCall(stale, {peerName: 'x'});
    reg.endActiveCall(stale, 'ended', 'local');
    const lines = warn.mock.calls.map(c => String(c[0]));
    expect(lines.some(l => l.startsWith('[CALLSM] registry.patch.dropped') && l.includes('stale-key'))).toBe(true);
    expect(lines.some(l => l.startsWith('[CALLSM] registry.end.dropped') && l.includes('stale-key'))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
describe('WI-1.1 — the weak (callId-only) ref', () => {
  it('accepts a bare callId that matches, for callers that cannot know the gen', () => {
    reg.setActiveCall(seed('call-weak'));
    expect(reg.patchActiveCall('call-weak', {peerName: 'ok'})).toBe(true);
    expect(reg.getActiveCall()!.peerName).toBe('ok');
  });

  it('still refuses a bare callId that does NOT match', () => {
    reg.setActiveCall(seed('call-weak'));
    expect(reg.endActiveCall('some-other-call', 'ended', 'remote')).toBe('refused');
    expect(reg.getActiveCall()).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
describe('WI-1.1 — adoption is a continuation, not a new call', () => {
  it('the adopted key (read off the entry) keeps working across patches', () => {
    const booted = reg.setActiveCall(seed('call-adopt'))!;
    // What `useCall`'s adopt branch does: read the LIVE entry and inherit its
    // generation rather than minting a new one.
    const live = reg.getActiveCall()!;
    const adopted = {callId: live.callId, gen: live.gen};
    expect(adopted).toEqual(booted);

    expect(reg.patchActiveCall(adopted, {keepAlive: false, isMinimized: false})).toBe(true);
    // …and the ORIGINAL booting instance's callbacks still own the slot too —
    // adoption must not orphan them.
    expect(reg.patchActiveCall(booted, {state: 'connected'})).toBe(true);
    expect(reg.getActiveCall()!.state).toBe('connected');
  });
});

// ────────────────────────────────────────────────────────────────────
describe('WI-1.2 — endActiveCall is non-re-entrant', () => {
  /**
   * The real shape: `controller.hangup()` drives `useCall.onState('ended')`,
   * which calls `endActiveCall` again — synchronously, from inside the first
   * call. Before the fix that second pass re-ran the entire teardown.
   */
  function reentrantController(onHangup: () => void) {
    return {hangup: jest.fn(() => { onHangup(); })} as never;
  }

  it('runs each teardown side effect EXACTLY once under a synchronous re-entry', () => {
    const unregister = jest.fn();
    let key!: reg.CallKey;
    const controller = reentrantController(() => {
      // the re-entry, exactly as useCall.onState does it
      reg.endActiveCall(key, 'ended', 'remote');
    });
    key = reg.setActiveCall(seed('call-re', {controller, unregister}))!;
    jest.clearAllMocks();

    expect(reg.endActiveCall(key, 'ended', 'local')).toBe('ended');

    expect(unregister).toHaveBeenCalledTimes(1);
    expect(mockNative.stopSharedAudioSession).toHaveBeenCalledTimes(1);
    expect(mockNative.stopCallForegroundService).toHaveBeenCalledTimes(1);
    expect(mockNative.reportEnded).toHaveBeenCalledTimes(1);
    expect(mockNative.clearIncomingCallPayload).toHaveBeenCalledTimes(1);
    expect(mockNative.dismissCallNotif).toHaveBeenCalledTimes(1);
    expect(reg.getActiveCall()).toBeNull();
  });

  it('tells a re-entrant caller "ending", not "refused" — so it skips its fallback', () => {
    // The distinction that makes WI-1.2's exactly-once real. The slot is dropped
    // BEFORE hangup, so by the time `useCall.onState` re-enters, a plain
    // "did the registry own it" test reads false — and that caller then ran its
    // own CallKit / cache / notifee teardown on EVERY end. The second
    // `reportEnded` carries the wrong end-reason, and the bridge is
    // first-write-wins, so a locally-ended call logged as remote-ended.
    const outcomes: reg.EndCallOutcome[] = [];
    let key!: reg.CallKey;
    const controller = {hangup: jest.fn(() => {
      outcomes.push(reg.endActiveCall(key, 'ended', 'remote'));
    })} as never;
    key = reg.setActiveCall(seed('call-outcome', {controller}))!;

    expect(reg.endActiveCall(key, 'ended', 'local')).toBe('ended');
    expect(outcomes).toEqual(['ending']);
  });

  it('a re-entrant end citing a STALE GENERATION of the same id is "refused"', () => {
    // The weak (id-only) ref matches on id because it has nothing else to
    // offer; a full key must match both. Otherwise an older generation gets
    // told "covered" and skips its own fallback teardown.
    const outcomes: reg.EndCallOutcome[] = [];
    let key!: reg.CallKey;
    const controller = {hangup: jest.fn(() => {
      outcomes.push(reg.endActiveCall({callId: 'call-gen', gen: key.gen - 1}, 'ended', 'remote'));
      outcomes.push(reg.endActiveCall('call-gen', 'ended', 'remote'));   // weak ref
    })} as never;
    key = reg.setActiveCall(seed('call-gen', {controller}))!;

    reg.endActiveCall(key, 'ended', 'local');
    expect(outcomes).toEqual(['refused', 'ending']);
  });

  it('noteCallEnded records a death the registry did not perform (CALL-N15 / FIX-14)', () => {
    // `useCall`'s adopt-mirror kills an orphaned call through its own
    // controller when the slot belongs to someone else — the registry teardown
    // cannot run, so nothing else would mark it.
    expect(reg.wasRecentlyEnded('call-orphan')).toBe(false);
    reg.noteCallEnded('call-orphan', 'adopt-foreign-slot');
    expect(reg.wasRecentlyEnded('call-orphan')).toBe(true);
  });

  it('a re-entrant end of a DIFFERENT call is "refused", not "ending"', () => {
    // Only the call actually being torn down gets the "covered" answer.
    const outcomes: reg.EndCallOutcome[] = [];
    let key!: reg.CallKey;
    const controller = {hangup: jest.fn(() => {
      outcomes.push(reg.endActiveCall('some-other-call', 'ended', 'remote'));
    })} as never;
    key = reg.setActiveCall(seed('call-outcome-2', {controller}))!;

    reg.endActiveCall(key, 'ended', 'local');
    expect(outcomes).toEqual(['refused']);
  });

  it('listeners see exactly ONE null transition', () => {
    const seen: Array<string | null> = [];
    let key!: reg.CallKey;
    const controller = reentrantController(() => { reg.endActiveCall(key, 'ended', 'remote'); });
    key = reg.setActiveCall(seed('call-notify', {controller}))!;
    const off = reg.onActiveCallChange(s => seen.push(s?.callId ?? null));
    seen.length = 0;                       // drop the register-time replay

    reg.endActiveCall(key, 'ended', 'local');
    off();
    expect(seen).toEqual([null]);
  });

  it('a second, LATER end of the same key is refused (idempotent, I5)', () => {
    const key = reg.setActiveCall(seed('call-twice'))!;
    expect(reg.endActiveCall(key, 'ended', 'local')).toBe('ended');
    jest.clearAllMocks();
    expect(reg.endActiveCall(key, 'ended', 'local')).toBe('refused');
    expect(mockNative.stopSharedAudioSession).not.toHaveBeenCalled();
    expect(mockNative.stopCallForegroundService).not.toHaveBeenCalled();
  });

  it('the ending latch refuses a re-entry from a listener that started a NEW call', () => {
    // The re-entry the early null CANNOT catch: a listener notified on the null
    // transition starts a fresh call, so the slot is non-null again while the
    // outer teardown is still running. Ending that new call from inside the old
    // call's teardown is never safe — the outer pass would keep going and strip
    // the audio/FGS it was just handed.
    let newKey: reg.CallKey | null = null;
    let reentryResult: reg.EndCallOutcome | null = null;
    const oldKey = reg.setActiveCall(seed('call-outer'))!;
    const off = reg.onActiveCallChange(s => {
      if (s !== null || newKey) {return;}
      newKey = reg.setActiveCall(seed('call-inner'));
      reentryResult = reg.endActiveCall(newKey!, 'ended', 'local');
    });

    reg.endActiveCall(oldKey, 'ended', 'local');
    off();

    expect(reentryResult).toBe('refused');
    expect(reg.getActiveCall()).toMatchObject({callId: 'call-inner'});
  });

  it('does not stop the foreground service when a listener took the slot', () => {
    // `stopCallForegroundService` is keyed by OWNER, not callId, so unlike the
    // rest of the tail it cannot tell the old call from the new one.
    let claimed = false;
    const oldKey = reg.setActiveCall(seed('call-fgs-outer'))!;
    const off = reg.onActiveCallChange(s => {
      if (s !== null || claimed) {return;}
      claimed = true;
      reg.setActiveCall(seed('call-fgs-inner'));
    });
    mockNative.stopCallForegroundService.mockClear();

    reg.endActiveCall(oldKey, 'ended', 'local');
    off();

    expect(mockNative.stopCallForegroundService).not.toHaveBeenCalled();
    expect(reg.getActiveCall()).toMatchObject({callId: 'call-fgs-inner'});
  });

  it('the re-entrancy latch cannot leave the registry wedged', () => {
    // A throwing controller must not strand `endInProgress` — the next call
    // has to work. (try/finally, not a bare flag.)
    const boom = {hangup: jest.fn(() => { throw new Error('native blew up'); })} as never;
    const k1 = reg.setActiveCall(seed('call-boom', {controller: boom}))!;
    expect(reg.endActiveCall(k1, 'ended', 'local')).toBe('ended');
    const k2 = reg.setActiveCall(seed('call-after'))!;
    expect(reg.endActiveCall(k2, 'ended', 'local')).toBe('ended');
    expect(reg.getActiveCall()).toBeNull();
  });

  it('maps (reason × source) to the CallKit ended-reason unchanged', () => {
    const cases: Array<['ended' | 'failed', 'local' | 'remote', string]> = [
      ['failed', 'local',  'failed'],
      ['failed', 'remote', 'failed'],
      ['ended',  'local',  'declined'],
      ['ended',  'remote', 'remoteEnded'],
    ];
    for (const [reason, source, expected] of cases) {
      mockNative.reportEnded.mockClear();
      const k = reg.setActiveCall(seed(`call-${reason}-${source}`))!;
      reg.endActiveCall(k, reason, source);
      expect(mockNative.reportEnded).toHaveBeenCalledWith(`call-${reason}-${source}`, expected);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
describe('WI-1.2 — endActiveCall records recentlyEnded (CALL-N15 / FIX-14)', () => {
  it('marks the call dead on the DOMINANT end path', () => {
    const k = reg.setActiveCall(seed('call-ghost'))!;
    expect(reg.wasRecentlyEnded('call-ghost')).toBe(false);
    reg.endActiveCall(k, 'ended', 'local');
    // Before WI-1.2 only `setActiveCall` recorded, so the path that actually
    // ends a call left the ghost-redial guard with nothing to see.
    expect(reg.wasRecentlyEnded('call-ghost')).toBe(true);
  });

  it('a REFUSED end records nothing — the call is still alive', () => {
    const stale = reg.setActiveCall(seed('call-r1'))!;
    reg.setActiveCall(seed('call-r2'));
    // 'call-r1' was displaced by setActiveCall, which legitimately marks it.
    // The point here is that r2 — the LIVE call — must not be marked.
    reg.endActiveCall(stale, 'ended', 'local');
    expect(reg.wasRecentlyEnded('call-r2')).toBe(false);
  });

  it('setActiveCall still records the call it displaces', () => {
    reg.setActiveCall(seed('call-d1'));
    reg.setActiveCall(seed('call-d2'));
    expect(reg.wasRecentlyEnded('call-d1')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
describe('WI-1.2 — teardown ordering survived the re-key', () => {
  it('stops local tracks BEFORE hanging up (W7 — camera LED past the End tap)', () => {
    const order: string[] = [];
    const audioTrack = {stop: () => order.push('audio')} as never;
    const videoTrack = {stop: () => order.push('video')} as never;
    const controller = {hangup: () => order.push('hangup')} as never;
    const key = reg.setActiveCall(seed('call-order', {audioTrack, videoTrack, controller}))!;
    reg.endActiveCall(key, 'ended', 'local');
    expect(order).toEqual(['audio', 'video', 'hangup']);
  });

  it('a throwing track stop does not abort the rest of the teardown', () => {
    const audioTrack = {stop: () => { throw new Error('already stopped'); }} as never;
    const unregister = jest.fn();
    const key = reg.setActiveCall(seed('call-throw', {audioTrack, unregister}))!;
    reg.endActiveCall(key, 'ended', 'local');
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(mockNative.stopCallForegroundService).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────
describe('WI-1.4 — N adoptions leave exactly ONE media-state handler', () => {
  // `CallSignalling` only needs a transport-shaped object to construct; the
  // advisory path under test never sends.
  const {CallSignalling} = require('../webrtc/signallingClient') as typeof import('../webrtc/signallingClient');
  const fakeTransport = {state: 'connected', send: jest.fn()} as never;
  const OWNER = 'useCall:call-adopt';
  const advisory = {
    event: 'call.media-state',
    data: {callId: 'call-adopt', from: PEER, cameraOff: true, micOff: false},
  } as never;

  it('re-registering under one owner REPLACES the previous handler', () => {
    const sig = new CallSignalling(fakeTransport);
    const hits: number[] = [];
    for (let i = 0; i < 5; i++) {
      sig.onMediaStateOwned(OWNER, () => hits.push(i));
    }
    expect(sig.mediaStateHandlerCount()).toBe(1);

    sig.ingest(advisory);
    // Only the LAST registration runs, and only once — before ownership every
    // restore stacked another handler writing into a dead React tree.
    expect(hits).toEqual([4]);
  });

  it('an older owner’s late disposer cannot remove the handler that replaced it', () => {
    const sig = new CallSignalling(fakeTransport);
    const hits: string[] = [];
    const disposeFirst = sig.onMediaStateOwned(OWNER, () => hits.push('first'));
    sig.onMediaStateOwned(OWNER, () => hits.push('second'));

    // This is the real sequence: a previous mount tears down AFTER the restore
    // has already re-registered. Identity-guarded, so it is a no-op.
    disposeFirst();
    expect(sig.mediaStateHandlerCount()).toBe(1);
    sig.ingest(advisory);
    expect(hits).toEqual(['second']);
  });

  it('the current owner’s disposer does remove it (teardown still works)', () => {
    const sig = new CallSignalling(fakeTransport);
    const dispose = sig.onMediaStateOwned(OWNER, () => { /* noop */ });
    dispose();
    expect(sig.mediaStateHandlerCount()).toBe(0);
  });

  it('different owners still coexist — ownership scopes, it does not serialise', () => {
    const sig = new CallSignalling(fakeTransport);
    const hits: string[] = [];
    sig.onMediaStateOwned('useCall:call-a', () => hits.push('a'));
    sig.onMediaStateOwned('useCall:call-b', () => hits.push('b'));
    expect(sig.mediaStateHandlerCount()).toBe(2);
    sig.ingest(advisory);
    expect(hits.sort()).toEqual(['a', 'b']);
  });

  it('the un-owned onMediaState is still additive (other subscribers unaffected)', () => {
    const sig = new CallSignalling(fakeTransport);
    sig.onMediaState(() => { /* noop */ });
    sig.onMediaState(() => { /* noop */ });
    expect(sig.mediaStateHandlerCount()).toBe(2);
  });
});

/**
 * Phase 6 rounds 2+3 (critic advisory / edge R1, re-keyed round 3) — a
 * caller acting on a verdict the far side ALREADY ISSUED opts into a
 * wire-silent end via `{silentWire: true}`; under the shared deviceId a
 * still-live sibling transport would otherwise relay an AUTHORIZED
 * call.hangup into the winner's ACTIVE session.
 *
 * THE KEY IS NOT `source`. `source:'remote'` is glyph-coupled (the CallKit
 * endedReason map), and three semantically-LOCAL live-call ends
 * (Telecom/system-UI End, logout) carry it while RELYING on the wire
 * hangup — keying on source killed the peer's "Call ended" for all three
 * (round-3 catch). The second test below is that contract's pin.
 */
describe('Phase 6 — silentWire ends are wire-silent; everything else keeps the hangup', () => {
  function controllerDouble(withSilent: boolean) {
    const hangup = jest.fn();
    const endSilently = jest.fn();
    return {double: withSilent ? {hangup, endSilently} : {hangup}, hangup, endSilently};
  }

  it('{silentWire: true} → endSilently, never hangup (no call.hangup on the wire)', () => {
    const {double, hangup, endSilently} = controllerDouble(true);
    const k = reg.setActiveCall(seed('call-silent', {controller: double as never}))!;
    expect(reg.endActiveCall(k, 'ended', 'remote', {silentWire: true})).toBe('ended');
    expect(endSilently).toHaveBeenCalledWith('ended');
    expect(hangup).not.toHaveBeenCalled();
  });

  it("source 'remote' WITHOUT the opt-in still sends the wire hangup (Telecom-End/logout class)", () => {
    // These sites label themselves 'remote' for the 'remoteEnded' glyph while
    // the peer's only "Call ended" signal IS this hangup frame.
    const {double, hangup, endSilently} = controllerDouble(true);
    const k = reg.setActiveCall(seed('call-glyph', {controller: double as never}))!;
    expect(reg.endActiveCall(k, 'ended', 'remote')).toBe('ended');
    expect(hangup).toHaveBeenCalledWith('ended');
    expect(endSilently).not.toHaveBeenCalled();
  });

  it("source 'local' still sends the wire hangup", () => {
    const {double, hangup, endSilently} = controllerDouble(true);
    const k = reg.setActiveCall(seed('call-loud', {controller: double as never}))!;
    expect(reg.endActiveCall(k, 'ended', 'local')).toBe('ended');
    expect(hangup).toHaveBeenCalledWith('ended');
    expect(endSilently).not.toHaveBeenCalled();
  });

  it('a controller without the seam falls back to hangup (double-compat lane)', () => {
    const {double, hangup} = controllerDouble(false);
    const k = reg.setActiveCall(seed('call-legacy', {controller: double as never}))!;
    expect(reg.endActiveCall(k, 'ended', 'remote', {silentWire: true})).toBe('ended');
    expect(hangup).toHaveBeenCalledWith('ended');
  });
});
