import {useEffect, useRef, useState} from 'react';

/**
 * The cold-start security-check intro.
 *
 * Client request (Corne Breytenbach, 2026-08-31, relayed by the founder):
 *
 *   "There used to be a loading screen when you open the App, that tested the
 *    encryption and stuff like that... It was very nice, could you add that back?
 *    Could you make that a thing that runs for 1.5 seconds as a type of display."
 *
 * and, crucially, the scoping the client themselves proposed once the founder
 * pushed back with "it will be annoying when someone rapidly use the app":
 *
 *   "When you close App completely on phone and Open again it should show as
 *    like part of the security check display (like an intro almost). If the App
 *    is open, but just minimised on the phone in background, it must not load."
 *
 * So: ONCE PER PROCESS, never on a resume.
 *
 * Cold start is detected by MODULE STATE rather than AppState, and that is the
 * whole trick. React Native evaluates this module exactly once per JS runtime:
 * a killed-and-relaunched app gets a fresh runtime (flag unset -> intro), while
 * a background -> foreground resume keeps the runtime alive (flag set -> no
 * intro). An AppState listener cannot tell those apart — it sees the same
 * 'active' transition for both — which is precisely the case the client asked
 * us to exclude.
 *
 * The 1.5 s is a DISPLAY FLOOR, not a measurement: it holds even when boot
 * finishes sooner, because the client asked for a fixed intro. It never
 * SHORTENS a genuinely slow boot — the caller keeps its own loading condition,
 * and this only widens it.
 */

/** Client-specified intro duration. */
export const COLD_START_INTRO_MS = 1500;

/**
 * Burned on the first mount of the first consumer in this JS runtime. Module
 * scope is load-bearing — see the file header. Do not move it into a ref, a
 * store, or AsyncStorage: a ref resets on remount, and persisted storage would
 * survive the process death that is exactly what we want to detect.
 */
let introConsumed = false;

/** Test-only: restore the pre-cold-start state. */
export function __resetColdStartIntroForTests(): void {
  introConsumed = false;
}

export interface ColdStartIntro {
  /** True while the intro should be on screen (cold start, first 1.5 s). */
  showing: boolean;
  /** True for the whole process when this run began with a cold start. */
  isColdBoot: boolean;
}

export function useColdStartIntro(): ColdStartIntro {
  // Captured at mount so it stays stable after `showing` flips — callers use it
  // to pick a checklist, and a checklist that swapped mid-boot would restart
  // its own step animation.
  const isColdBoot = useRef(!introConsumed).current;
  const [showing, setShowing] = useState(isColdBoot);

  useEffect(() => {
    if (!isColdBoot) {return undefined;}
    // Burn immediately, not on timeout expiry: if this component remounts
    // inside the same process the intro must not replay.
    introConsumed = true;
    const t = setTimeout(() => setShowing(false), COLD_START_INTRO_MS);
    return () => clearTimeout(t);
  }, [isColdBoot]);

  return {showing, isColdBoot};
}
