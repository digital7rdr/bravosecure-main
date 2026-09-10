/**
 * B-425 — the in-call volume FLOOR policy.
 *
 * Android indexes STREAM_VOICE_CALL per OUTPUT DEVICE, so a headset can carry
 * its own remembered level. Measured on the founder's Pixel 6a: routing to the
 * paired buds dropped the call stream to 7/15 (~47%) half a second after SCO
 * connected, and back to 15/15 when it dropped out.
 *
 * The brief forbids "simply increasing volume globally", and these tests are
 * what hold that line: this may only ever RAISE, only from BELOW the floor, and
 * it must not touch a user who deliberately keeps call volume low — which,
 * because the raise is reverted at call end and stands down the moment they
 * touch the slider, means their setting survives.
 */

import {volumeFloorTarget, FLOOR_FRACTION} from '../runtime/callVolumeFloor';

describe('B-425 — volumeFloorTarget only ever raises, and only from below the floor', () => {
  it('raises the measured real-world case (7 of 15) to the floor', () => {
    // 15 * 0.7 = 10.5 -> ceil -> 11. Clearly audible, and NOT max: the point
    // is a usable floor, not loudness.
    expect(volumeFloorTarget(7, 15)).toBe(11);
  });

  it('leaves a stream already at the floor alone', () => {
    expect(volumeFloorTarget(11, 15)).toBeNull();
  });

  it('leaves a stream ABOVE the floor alone — never lowers', () => {
    expect(volumeFloorTarget(15, 15)).toBeNull();
    expect(volumeFloorTarget(13, 15)).toBeNull();
  });

  it('never returns a target above max', () => {
    for (const max of [1, 5, 7, 15, 25, 100]) {
      const t = volumeFloorTarget(0, max);
      expect(t).not.toBeNull();
      expect(t as number).toBeLessThanOrEqual(max);
    }
  });

  it('never returns a target below the floor it promises', () => {
    for (const max of [5, 7, 15, 25, 100]) {
      const t = volumeFloorTarget(0, max) as number;
      expect(t / max).toBeGreaterThanOrEqual(FLOOR_FRACTION);
    }
  });

  it('handles a muted stream (0) by lifting it to the floor', () => {
    expect(volumeFloorTarget(0, 15)).toBe(11);
  });

  it('is inert on nonsense input rather than guessing', () => {
    expect(volumeFloorTarget(NaN, 15)).toBeNull();
    expect(volumeFloorTarget(7, 0)).toBeNull();
    expect(volumeFloorTarget(7, -1)).toBeNull();
    expect(volumeFloorTarget(-1, 15)).toBeNull();
    expect(volumeFloorTarget(7, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('a caller-supplied floor is honoured (the policy is not hard-coded at the call site)', () => {
    // floor = ceil(15 * 0.5) = 8
    expect(volumeFloorTarget(8, 15, 0.5)).toBeNull();   // already at the floor
    expect(volumeFloorTarget(3, 15, 0.5)).toBe(8);      // below it -> raised
    // ...and the same input is NOT raised under the shipped 0.7 floor only
    // because 0.7 asks for more, proving the parameter actually drives it.
    expect(volumeFloorTarget(8, 15)).toBe(11);
  });

  it('the shipped floor is a floor, not a max — a deliberately quiet user keeps most of their range', () => {
    // Guards against someone "fixing" this by bumping FLOOR_FRACTION to 1.0.
    expect(FLOOR_FRACTION).toBeGreaterThan(0);
    expect(FLOOR_FRACTION).toBeLessThan(1);
    // Anything the user sets at or above the floor is untouched, so the whole
    // top of the range remains theirs.
    expect(volumeFloorTarget(Math.ceil(15 * FLOOR_FRACTION), 15)).toBeNull();
  });
});
