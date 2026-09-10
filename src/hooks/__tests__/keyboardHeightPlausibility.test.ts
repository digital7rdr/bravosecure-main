/**
 * B-277 — the composer stayed behind the keyboard on the first open after a cold
 * start. Uses the REAL numbers measured on a Redmi Note 11, API 33, edge-to-edge.
 * The process id in the device log is what identified it — not a race, not the
 * animation, not a fast tap:
 *
 *     pid 1882  keyboardDidShow h=326.18  OK
 *     pid 5774  keyboardDidShow h=5.09    BROKEN   <- first open, fresh process
 *     pid 5774  keyboardDidShow h=326.18  OK
 *     pid 5774  keyboardDidShow h=326.18  OK
 *
 * Android emits `keyboardDidShow` once per visibility transition and
 * `Keyboard.metrics()` is event-derived (verified frozen at 5.09 across probes at
 * 50/150/400ms), so the bad value is FINAL for that session. Two polling-based
 * fixes were shipped before this and neither could work.
 *
 * The rule is a RATIO of the window, never an absolute dp figure, because the app
 * ships to small phones, tablets and foldables.
 */
import {
  isPlausibleKeyboardHeight,
  resolveKeyboardHeight,
  KEYBOARD_MIN_WINDOW_FRACTION,
} from '../useKeyboardLayout';

// The measured device.
const WIN = 792.7272727272727;
const REAL = 326.18182373046875;
const BOGUS = 5.090909004211426;

describe('B-277 — isPlausibleKeyboardHeight', () => {
  it('the measured REAL height is plausible; the measured BOGUS one is not', () => {
    expect(isPlausibleKeyboardHeight(REAL, WIN)).toBe(true);
    expect(isPlausibleKeyboardHeight(BOGUS, WIN)).toBe(false);
  });

  it('judges by SHARE OF WINDOW, so it holds on any form factor', () => {
    // Same 300dp keyboard is plausible on a phone and on a tablet; the point is
    // that no absolute dp constant is involved.
    expect(isPlausibleKeyboardHeight(300, 800)).toBe(true);   // phone, 37%
    expect(isPlausibleKeyboardHeight(300, 1600)).toBe(true);  // tablet, 19%
    // A short IME on a tall tablet is still a keyboard if it clears the ratio.
    expect(isPlausibleKeyboardHeight(0.2 * 1600, 1600)).toBe(true);
    // And the bogus reading stays bogus at every scale.
    expect(isPlausibleKeyboardHeight(5, 800)).toBe(false);
    expect(isPlausibleKeyboardHeight(5, 1600)).toBe(false);
  });

  it('the boundary is exactly the documented fraction', () => {
    const win = 1000;
    expect(isPlausibleKeyboardHeight(KEYBOARD_MIN_WINDOW_FRACTION * win, win)).toBe(true);
    expect(isPlausibleKeyboardHeight(KEYBOARD_MIN_WINDOW_FRACTION * win - 1, win)).toBe(false);
  });

  it('zero / negative / non-finite are never plausible', () => {
    expect(isPlausibleKeyboardHeight(0, WIN)).toBe(false);
    expect(isPlausibleKeyboardHeight(-10, WIN)).toBe(false);
    expect(isPlausibleKeyboardHeight(Number.NaN, WIN)).toBe(false);
  });

  it('accepts any positive height when the window is unknown', () => {
    // Rejecting a reading we cannot evaluate would be worse than accepting it.
    expect(isPlausibleKeyboardHeight(5, 0)).toBe(true);
    expect(isPlausibleKeyboardHeight(300, 0)).toBe(true);
  });
});

describe('B-277 — resolveKeyboardHeight', () => {
  it('THE BUG: the cold-start reading is replaced by the learned height', () => {
    expect(resolveKeyboardHeight(BOGUS, WIN, REAL)).toBe(REAL);
  });

  it('a believable reading is used as-is and never overridden', () => {
    // The learned value must not win over a live, plausible measurement — that
    // would pin the lift to a stale emoji-pad height forever.
    expect(resolveKeyboardHeight(REAL, WIN, 999)).toBe(REAL);
    expect(resolveKeyboardHeight(250, 800, 400)).toBe(250);
  });

  it('with nothing learned yet, the reported value still comes through', () => {
    // Very first keyboard open on a fresh install. A small lift beats pretending
    // the keyboard is not there at all.
    expect(resolveKeyboardHeight(BOGUS, WIN, 0)).toBe(BOGUS);
  });

  it('an implausible LEARNED value is not substituted either', () => {
    // Guards against poisoning the store with a bogus reading and then serving
    // it back forever.
    expect(resolveKeyboardHeight(BOGUS, WIN, 4)).toBe(BOGUS);
  });

  it('is pure — repeated calls give the same answer', () => {
    const a = resolveKeyboardHeight(BOGUS, WIN, REAL);
    const b = resolveKeyboardHeight(BOGUS, WIN, REAL);
    expect(a).toBe(b);
  });
});

describe('B-277 — the lift the founder should now see', () => {
  it('the substituted height produces the full nav-bar-corrected inset', () => {
    // computeKeyboardOverlap adds the safe-area band back on Android API>=30.
    // Broken: 5.09 + 47.27 = 52.36 (composer buried, matches the screenshot).
    // Fixed:  326.18 + 47.27 = 373.45.
    const SAFE = 47.272727966308594;
    const resolved = resolveKeyboardHeight(BOGUS, WIN, REAL);
    expect(resolved + SAFE).toBeCloseTo(373.45, 1);
  });
});
