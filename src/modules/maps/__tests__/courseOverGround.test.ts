/**
 * Course-over-ground rules for the native nav camera — extracted from the
 * WebView map so both renderers turn the camera identically. The bugs these
 * pin were all REAL on one surface or the other:
 *   - a parked vehicle spinning the map on GPS noise (MIN_COURSE_M gate)
 *   - 350°→10° turning the long way around (shortest-arc blend)
 *   - the camera never rotating at all because nothing ever updated the
 *     bearing after the seed (the native map shipped exactly this in 1.0.252)
 */
import {
  advanceCourse,
  bearingDeg,
  blendBearing,
  initialCourse,
  metresBetween,
  MIN_COURSE_M,
  type CourseLngLat,
} from '../courseOverGround';

// Dhaka-ish base point; ~1e-5 deg lat ≈ 1.11 m.
const BASE: CourseLngLat = [90.4125, 23.8103];
const northOf = (m: number): CourseLngLat => [BASE[0], BASE[1] + m / 111320];
const eastOf = (m: number): CourseLngLat => [
  BASE[0] + m / (111320 * Math.cos((BASE[1] * Math.PI) / 180)),
  BASE[1],
];

describe('bearingDeg', () => {
  it('cardinal directions', () => {
    expect(bearingDeg(BASE, northOf(100))).toBeCloseTo(0, 1);
    expect(bearingDeg(BASE, eastOf(100))).toBeCloseTo(90, 1);
    expect(bearingDeg(northOf(100), BASE)).toBeCloseTo(180, 1);
    expect(bearingDeg(eastOf(100), BASE)).toBeCloseTo(270, 1);
  });
});

describe('metresBetween', () => {
  it('is metre-accurate at fix scales', () => {
    expect(metresBetween(BASE, northOf(50))).toBeCloseTo(50, 0);
    expect(metresBetween(BASE, eastOf(50))).toBeCloseTo(50, 0);
  });
});

describe('blendBearing', () => {
  it('takes the shortest arc across north', () => {
    // 350 -> 10 is +20°, so a 0.5 blend lands on 0, never on 180.
    expect(blendBearing(350, 10, 0.5)).toBeCloseTo(0, 5);
    expect(blendBearing(10, 350, 0.5)).toBeCloseTo(0, 5);
  });
});

describe('advanceCourse', () => {
  it('a server heading seeds a null bearing so the first frame is oriented', () => {
    const s = advanceCourse(initialCourse, BASE, 137);
    expect(s.bearing).toBe(137);
  });

  it('GPS noise while parked cannot turn the course', () => {
    let s = advanceCourse(initialCourse, BASE, 90);
    // A jitter fix under MIN_COURSE_M in a different direction: bearing holds.
    s = advanceCourse(s, northOf(MIN_COURSE_M - 2));
    expect(s.bearing).toBe(90);
    // ...and the anchor fix did NOT advance, so drift cannot accumulate
    // through many sub-threshold hops.
    expect(s.lastFix).toEqual(BASE);
  });

  it('real movement turns the course (blended), which is what rotates the camera', () => {
    let s = advanceCourse(initialCourse, BASE, 90);
    s = advanceCourse(s, northOf(50));
    // Blend 0.45 from 90° toward 0° = 49.5°.
    expect(s.bearing).toBeCloseTo(49.5, 1);
    s = advanceCourse(s, northOf(100));
    expect(s.bearing!).toBeLessThan(49.5); // keeps converging on the true course
  });

  it('with no seed, the first real movement sets the raw course', () => {
    let s = advanceCourse(initialCourse, BASE, null);
    expect(s.bearing).toBeNull();
    s = advanceCourse(s, eastOf(20));
    expect(s.bearing).toBeCloseTo(90, 1);
  });

  it('once any bearing exists, a later server heading cannot overwrite it', () => {
    let s = advanceCourse(initialCourse, BASE, 90);
    s = advanceCourse(s, northOf(50), 270);
    expect(s.bearing).toBeCloseTo(49.5, 1); // movement won, the stale heading lost
  });
});
