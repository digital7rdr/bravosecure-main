/**
 * Mirrors the audio-route guard decision in CallScreen.tsx
 * (pickAudioRouteNative's lastAppliedRoute + the per-state-transition
 * invalidation added for the "UI says earpiece but device is on
 * loudspeaker" bug): the ringback/ringtone player (expo-av) flips
 * speakerphone ON when it acquires audio focus, so the guard's belief
 * is only trustworthy within a single call state. A state transition
 * must drop the guard; same-state re-runs must keep it (BS-CALL-CHOPPY
 * SCO-churn fix).
 */

type Route = 'SPEAKER_PHONE' | 'EARPIECE' | 'BLUETOOTH' | 'WIRED_HEADSET';

interface GuardSim {
  lastApplied: Route | null;
  lastCallState: string | null;
}

function effectRun(sim: GuardSim, callState: string, desired: Route): boolean {
  if (sim.lastCallState !== callState) {
    sim.lastCallState = callState;
    sim.lastApplied = null;
  }
  if (desired === sim.lastApplied) {
    return false;
  }
  sim.lastApplied = desired;
  return true;
}

describe('call audio route guard (CallScreen mirror)', () => {
  it('re-applies the same route after a call-state transition (ringback flipped the hardware)', () => {
    const sim: GuardSim = {lastApplied: null, lastCallState: null};
    expect(effectRun(sim, 'connecting', 'EARPIECE')).toBe(true);
    // expo-av ringback starts → hardware silently flips to speaker.
    // Callee answers → state transition → guard must NOT skip.
    expect(effectRun(sim, 'active', 'EARPIECE')).toBe(true);
  });

  it('keeps deduplicating same-route re-issues within one state (SCO-churn fix intact)', () => {
    const sim: GuardSim = {lastApplied: null, lastCallState: null};
    expect(effectRun(sim, 'active', 'BLUETOOTH')).toBe(true);
    expect(effectRun(sim, 'active', 'BLUETOOTH')).toBe(false);
    expect(effectRun(sim, 'active', 'BLUETOOTH')).toBe(false);
  });

  it('applies a genuinely different route within one state (user toggle)', () => {
    const sim: GuardSim = {lastApplied: null, lastCallState: null};
    expect(effectRun(sim, 'active', 'EARPIECE')).toBe(true);
    expect(effectRun(sim, 'active', 'SPEAKER_PHONE')).toBe(true);
    expect(effectRun(sim, 'active', 'EARPIECE')).toBe(true);
  });

  it('incoming flow: first application after answering always lands', () => {
    const sim: GuardSim = {lastApplied: null, lastCallState: null};
    // While ringing the effect bails before applying (system ringer);
    // it only records the state. Mirror that by seeding the state.
    sim.lastCallState = 'ringing';
    expect(effectRun(sim, 'active', 'EARPIECE')).toBe(true);
  });

  it('multi-transition outgoing flow lands the route at every hop', () => {
    const sim: GuardSim = {lastApplied: null, lastCallState: null};
    expect(effectRun(sim, 'ringing', 'EARPIECE')).toBe(true);
    expect(effectRun(sim, 'connecting', 'EARPIECE')).toBe(true);
    expect(effectRun(sim, 'active', 'EARPIECE')).toBe(true);
    // Stable in-call: no further re-issues.
    expect(effectRun(sim, 'active', 'EARPIECE')).toBe(false);
  });
});
