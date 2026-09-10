/**
 * NA-02 (B-121 CALL-D) — a dead incoming-call offer must reach a terminal
 * state instead of leaving the callee on "Answering…" forever.
 *
 * LIMITATION: this file MIRRORS the two new CallScreen effects, it does NOT
 * render the screen — CallScreen cannot mount under jest without the WebRTC /
 * InCallManager / expo-camera native surface (same precedent as
 * inAppRingOwnership.test.ts and callAudioRouteGuard.test.ts;
 * GroupCallScreen.autopop.test.tsx is `describe.skip`ped for the same reason).
 * Part B therefore pins the real source so the mirror cannot drift from it.
 */

import {readFileSync} from 'fs';
import {join} from 'path';

const ACCEPT_INTENT_TTL_MS = 45_000;

interface Env {
  isIncoming: boolean;
  callId: string;
  autoAccept: boolean;
  userAccepted: boolean;
  deadOffer: boolean;
  autoAcceptedRef: {current: boolean};
  hangupInFlightRef: {current: boolean};
  dismissedRef: {current: boolean};
  acceptIntentAtRef: {current: number | null};
  isIncomingCallDead: jest.Mock<boolean, [string]>;
  decline: jest.Mock;
  goBack: jest.Mock;
  setTearingDown: jest.Mock;
  /** callRegistry mirror — the cross-mount liveness / teardown surface. */
  activeCall: {callId: string; state: string} | null;
  endActiveCall: jest.Mock;
  hangup: jest.Mock;
}

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    isIncoming: true,
    callId: 'call-1',
    autoAccept: true,
    userAccepted: false,
    deadOffer: false,
    autoAcceptedRef: {current: false},
    hangupInFlightRef: {current: false},
    dismissedRef: {current: false},
    acceptIntentAtRef: {current: null},
    isIncomingCallDead: jest.fn((_callId: string) => false),
    decline: jest.fn(),
    goBack: jest.fn(),
    setTearingDown: jest.fn(),
    activeCall: null,
    endActiveCall: jest.fn(),
    hangup: jest.fn(),
    ...over,
  };
}

/** Mirror of the NA-02 terminal effect (`useEffect(..., [deadOffer, callId, navigation])`). */
function runTerminal(env: Env): () => void {
  if (!env.deadOffer) {return () => {};}
  env.hangupInFlightRef.current = true;
  env.setTearingDown(true);
  if (env.callId) {
    env.decline(env.callId, 'failed');
  }
  env.hangup();
  // WI-1.1 — the real effect keys the teardown on the route's callId; a
  // mirror that drops the key would stop mirroring the code it stands in for.
  if (env.callId) {
    env.endActiveCall(env.callId, 'ended', 'local');
  }
  const t = setTimeout(() => {
    if (env.dismissedRef.current) {return;}
    env.dismissedRef.current = true;
    env.goBack();
  }, 1_800);
  return () => clearTimeout(t);
}

/**
 * Mirror of the NA-02 watchdog effect
 * (`useEffect(..., [isIncoming, callId, autoAccept, userAccepted, deadOffer])`).
 * `setDeadOffer` re-runs the effect pair exactly like a React re-render would.
 */
function mount(env: Env): () => void {
  let terminalCleanup: () => void = () => {};
  const arm = (): (() => void) => {
    if (!env.isIncoming || !env.callId || env.deadOffer) {return () => {};}
    if (!(env.autoAccept || env.userAccepted)) {return () => {};}
    if (env.autoAcceptedRef.current || env.hangupInFlightRef.current) {return () => {};}
    if (env.acceptIntentAtRef.current === null) {env.acceptIntentAtRef.current = Date.now();}
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => { if (timer) {clearInterval(timer); timer = null;} };
    const tick = () => {
      if (env.autoAcceptedRef.current || env.hangupInFlightRef.current || env.dismissedRef.current) {
        stop();
        return;
      }
      const live = env.activeCall;
      if (live && live.callId === env.callId &&
          (live.state === 'connecting' || live.state === 'connected' || live.state === 'reconnecting')) {
        stop();
        return;
      }
      let peerCancelled = false;
      try {
        peerCancelled = env.isIncomingCallDead(env.callId);
      } catch { /* cache unavailable */ }
      const startedAt = env.acceptIntentAtRef.current;
      const expired = startedAt !== null && Date.now() - startedAt > ACCEPT_INTENT_TTL_MS;
      if (!peerCancelled && !expired) {return;}
      stop();
      // setDeadOffer(true) → re-render → watchdog cleanup + terminal effect.
      env.deadOffer = true;
      terminalCleanup = runTerminal(env);
    };
    timer = setInterval(tick, 1_000);
    return stop;
  };
  const watchdogCleanup = arm();
  return () => { watchdogCleanup(); terminalCleanup(); };
}

describe('NA-02 dead-offer watchdog (CallScreen effect mirror)', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('A1 — accept intent with no offer: exits after the TTL, tears down as failed, pops once', () => {
    const env = makeEnv();
    mount(env);

    jest.advanceTimersByTime(46_000);
    expect(env.deadOffer).toBe(true);
    expect(env.setTearingDown).toHaveBeenCalledWith(true);
    expect(env.decline).toHaveBeenCalledTimes(1);
    expect(env.decline).toHaveBeenCalledWith('call-1', 'failed');
    expect(env.goBack).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1_800);
    expect(env.goBack).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60_000);
    expect(env.goBack).toHaveBeenCalledTimes(1);
    expect(env.decline).toHaveBeenCalledTimes(1);
  });

  it('A2 — a tombstoned callId exits well before the 45s deadline', () => {
    const env = makeEnv();
    mount(env);

    jest.advanceTimersByTime(2_000);
    expect(env.deadOffer).toBe(false);

    env.isIncomingCallDead.mockReturnValue(true);
    jest.advanceTimersByTime(2_000);
    expect(env.deadOffer).toBe(true);
    expect(env.decline).toHaveBeenCalledWith('call-1', 'failed');

    jest.advanceTimersByTime(1_800);
    expect(env.goBack).toHaveBeenCalledTimes(1);
  });

  it('A3 — LIVE CALL SAFETY: accept() already fired ⇒ nothing is ever torn down', () => {
    const env = makeEnv();
    mount(env);
    env.autoAcceptedRef.current = true;
    env.isIncomingCallDead.mockReturnValue(true);

    jest.advanceTimersByTime(60_000);
    expect(env.deadOffer).toBe(false);
    expect(env.decline).not.toHaveBeenCalled();
    expect(env.goBack).not.toHaveBeenCalled();
  });

  it('A4 — a user-initiated hangup in flight disarms the watchdog', () => {
    const env = makeEnv();
    mount(env);
    env.hangupInFlightRef.current = true;

    jest.advanceTimersByTime(60_000);
    expect(env.deadOffer).toBe(false);
    expect(env.decline).not.toHaveBeenCalled();
    expect(env.goBack).not.toHaveBeenCalled();
  });

  it('A5 — a plain ring (no accept intent) never arms: the ring surface is untouched', () => {
    const env = makeEnv({autoAccept: false, userAccepted: false});
    env.isIncomingCallDead.mockReturnValue(true);
    mount(env);

    jest.advanceTimersByTime(60_000);
    expect(env.isIncomingCallDead).not.toHaveBeenCalled();
    expect(env.deadOffer).toBe(false);
    expect(env.goBack).not.toHaveBeenCalled();
  });

  it('A6 — an outgoing call never arms', () => {
    const env = makeEnv({isIncoming: false});
    env.isIncomingCallDead.mockReturnValue(true);
    mount(env);

    jest.advanceTimersByTime(60_000);
    expect(env.deadOffer).toBe(false);
    expect(env.goBack).not.toHaveBeenCalled();
  });

  it('A7 — the interval cannot leak past unmount / re-render', () => {
    const env = makeEnv();
    const cleanup = mount(env);

    jest.advanceTimersByTime(3_000);
    const probesWhileMounted = env.isIncomingCallDead.mock.calls.length;
    expect(probesWhileMounted).toBeGreaterThan(0);

    cleanup();
    jest.advanceTimersByTime(60_000);
    expect(env.isIncomingCallDead.mock.calls.length).toBe(probesWhileMounted);
    expect(env.deadOffer).toBe(false);
  });

  it('A8 — an already-dismissed screen is not popped a second time', () => {
    const env = makeEnv();
    mount(env);

    jest.advanceTimersByTime(46_000);
    expect(env.deadOffer).toBe(true);

    // The state-driven auto-dismiss won the race.
    env.dismissedRef.current = true;
    jest.advanceTimersByTime(5_000);
    expect(env.goBack).not.toHaveBeenCalled();
  });

  it('A9 — wall-clock deadline, not tick counting (RN freezes timers when backgrounded)', () => {
    const env = makeEnv();
    mount(env);

    // Two ticks, then the JS timer loop stalls while the clock keeps running.
    jest.advanceTimersByTime(2_000);
    expect(env.deadOffer).toBe(false);
    jest.setSystemTime(Date.now() + 60_000);

    // One tick on resume is enough — the verdict is a Date.now() delta.
    jest.advanceTimersByTime(1_000);
    expect(env.deadOffer).toBe(true);
    expect(env.decline).toHaveBeenCalledWith('call-1', 'failed');
  });

  it('A10 — an adopted registry entry is ENDED before the pop (no phantom floating overlay)', () => {
    const env = makeEnv({autoAccept: false, userAccepted: true, activeCall: {callId: 'call-1', state: 'ringing'}});
    env.endActiveCall.mockImplementation(() => { env.activeCall = null; });
    mount(env);

    jest.advanceTimersByTime(46_000);
    expect(env.deadOffer).toBe(true);
    expect(env.hangupInFlightRef.current).toBe(true);
    expect(env.endActiveCall).toHaveBeenCalledWith(env.callId, 'ended', 'local');

    // The registry can no longer satisfy `beforeRemove`'s minimise condition.
    jest.advanceTimersByTime(1_800);
    expect(env.goBack).toHaveBeenCalledTimes(1);
    expect(env.activeCall).toBeNull();
  });

  it('A11 — LIVE CALL SAFETY: a registry call that reached connected disarms the watchdog', () => {
    const env = makeEnv({autoAccept: false, userAccepted: true, activeCall: {callId: 'call-1', state: 'ringing'}});
    mount(env);

    jest.advanceTimersByTime(2_000);
    env.activeCall = {callId: 'call-1', state: 'connected'};
    env.isIncomingCallDead.mockReturnValue(true);

    jest.advanceTimersByTime(120_000);
    expect(env.deadOffer).toBe(false);
    expect(env.decline).not.toHaveBeenCalled();
    expect(env.endActiveCall).not.toHaveBeenCalled();
    expect(env.goBack).not.toHaveBeenCalled();
  });
});

describe('NA-02 CallScreen.tsx source wiring', () => {
  const src = readFileSync(join(__dirname, '..', 'CallScreen.tsx'), 'utf8').replace(/\r\n/g, '\n');
  const count = (needle: string): number => src.split(needle).length - 1;

  it('B1 — one shared ACCEPT_INTENT_TTL_MS; the magic 45_000 is gone', () => {
    // WI-2.3 re-point, STRENGTHENED not relaxed. This used to require a local
    // `const ACCEPT_INTENT_TTL_MS = 45_000;` in this file. The value now comes
    // from `callDeadlines.ts`, which satisfies B1's intent more strongly: the
    // constant is shared across MODULES, not merely deduplicated within one
    // file, and `callDeadlines.test.ts` additionally pins
    // `ACCEPT_INTENT_TTL === RING_TIMEOUT` — the relationship B1 could never
    // see from here.
    expect(src).toContain('ACCEPT_INTENT_TTL_MS');
    expect(src).toMatch(/import \{[^}]*ACCEPT_INTENT_TTL_MS[^}]*\} from '@\/modules\/messenger\/webrtc\/callDeadlines'/);
    expect(src).toContain('if (Date.now() - acceptIntentAtRef.current > ACCEPT_INTENT_TTL_MS) {');
    // The literal may not reappear anywhere in this file.
    expect(count('45_000')).toBe(0);
    // Module scope, not inside the component.
    expect(src.indexOf('ACCEPT_INTENT_TTL_MS'))
      .toBeLessThan(src.indexOf('function CallScreenInner('));
  });

  it('B2 — the terminal flag exists', () => {
    expect(src).toContain('const [deadOffer, setDeadOffer] = useState(false);');
  });

  it('B3 — the watchdog is a bounded 1s interval that always clears', () => {
    expect(src).toContain('setInterval(tick, 1_000)');
    expect(src).toContain('const stop = () => { if (timer) {clearInterval(timer); timer = null;} };');
    expect(src).toContain('    return stop;\n  }, [isIncoming, callId, autoAccept, userAccepted, deadOffer]);');
  });

  it('B4 — the cross-lane tombstone probe is wired', () => {
    expect(src).toContain('peerCancelled = cache.isIncomingCallDead(callId);');
  });

  it('B5 — LIVE CALL SAFETY: both the arm gate and the per-tick disarm are present', () => {
    expect(src).toContain('if (!(autoAccept || userAccepted)) {return;}');
    expect(src).toContain('if (autoAcceptedRef.current || hangupInFlightRef.current) {return;}');
    expect(src).toMatch(
      /if \(autoAcceptedRef\.current \|\| hangupInFlightRef\.current \|\| dismissedRef\.current\)/,
    );
  });

  it('B6 — teardown reuses declineIncomingCallBestEffort; the existing decline site is unchanged', () => {
    expect(count("fb.declineIncomingCallBestEffort(callId, 'failed');")).toBe(1);
    expect(count('fb.declineIncomingCallBestEffort(callId);')).toBe(1);
  });

  it('B7 — the terminal copy wins over "Answering…" in both status ternaries', () => {
    expect(count('Couldn’t connect · missed call')).toBe(2);
    expect(count(
      "deadOffer\n                ? 'Couldn’t connect · missed call'\n                : isRinging",
    )).toBe(2);
  });

  it('B8 — NO second missed-call filing path (duplicate-bubble guard)', () => {
    expect(count('useMessengerStore.getState().appendMessage(')).toBe(1);
  });

  it('B9 — the watchdog never touches the accept path', () => {
    const start = src.indexOf('// Why: NA-02 — dead-offer watchdog.');
    const end = src.indexOf('// Minimise = go back to Chat');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).not.toContain('liveCall.accept');
    expect(block).not.toContain('setUserAccepted');
    expect(block).not.toContain('appendMessage');
  });

  const terminalBlock = (): string => {
    const start = src.indexOf('// Why: NA-02 — terminal handling');
    const end = src.indexOf('// Minimise = go back to Chat');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  it('B10 — the watchdog verdict is a wall-clock delta, not a tick count', () => {
    expect(src).toContain(
      'const expired = startedAt !== null && Date.now() - startedAt > ACCEPT_INTENT_TTL_MS;',
    );
  });

  it('B11 — LIVE CALL SAFETY: the tick bails on a registry call that connected', () => {
    const start = src.indexOf('// Why: NA-02 — dead-offer watchdog.');
    const block = src.slice(start, src.indexOf('// Why: NA-02 — terminal handling'));
    expect(block).toContain("live.state === 'connecting' || live.state === 'connected' || live.state === 'reconnecting'");
    expect(block).toContain('reg.getActiveCall();');
  });

  it('B12 — the terminal effect ends the registry entry so beforeRemove cannot minimise', () => {
    const block = terminalBlock();
    expect(block).toContain('hangupInFlightRef.current = true;');
    // WI-1.1 — keyed on the route's callId so a dead-offer teardown on a
    // superseded screen cannot end whatever call now holds the slot.
    expect(block).toContain("reg.endActiveCall(callId, 'ended', 'local');");
    expect(block).toContain('liveCallRef.current?.hangup();');
  });

  it('the End button ends through the REGISTRY first, so the reason is `local`', () => {
    // `liveCall.hangup()` drives the controller terminal, whose registry end is
    // hard-coded `source: 'remote'` — it genuinely cannot know who ended the
    // call. Run it FIRST and, with the slot still live, that call wins the
    // teardown and reports `remoteEnded`. `reportEndCallWithUUID` is
    // first-write-wins, so the screen's own `'local'` never reaches the bridge
    // and every End the user presses lands in iOS Recents / the Android call
    // log with the remote-ended glyph. Ordering IS the fix, so ordering is what
    // this pins.
    const at = src.indexOf('const endCall = () => {');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf('const declineCall = () => {', at));
    // Anchor on the STATEMENTS, not the bare symbols: prose in the surrounding
    // comment names both, and an `indexOf` on a bare token would order the
    // comment rather than the code (this exact trap cost a run).
    const registryAt = block.indexOf("if (callId) {reg.endActiveCall(callId, 'ended', 'local');}");
    const hangupAt   = block.indexOf('try { liveCall.hangup(); }');
    expect(registryAt).toBeGreaterThan(-1);
    expect(hangupAt).toBeGreaterThan(-1);
    expect(registryAt).toBeLessThan(hangupAt);
  });

  it('B13 — the terminal effect dwells 1.8s, then pops exactly once', () => {
    // B-306 — the pop now funnels through dismissCallScreen, the ONE
    // dismissal helper: it owns dismissedRef (exactly-once) and consumes any
    // group ring parked behind this call before popping. The dwell is
    // unchanged. Pinning the raw dismissedRef+goBack shape here would force
    // this path to bypass the funnel — which is the pop-race B-306 fixed.
    const block = terminalBlock();
    expect(block).toContain('dismissCallScreen();');
    expect(block).toContain('}, 1_800);');
  });
});
