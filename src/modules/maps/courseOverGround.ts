/**
 * Course-over-ground for the native nav camera — the SAME rules the WebView
 * map uses (bravoAgentTrackerMapHtml.ts), extracted pure so they are
 * unit-testable and cannot drift between the two renderers:
 *
 *   - Bearing is derived from consecutive fixes, NOT a compass: it is the
 *     direction the vehicle is actually travelling.
 *   - It only updates once the vehicle has moved MIN_COURSE_M, so a parked
 *     vehicle cannot spin the map on GPS noise.
 *   - A server-supplied heading_deg SEEDS it before the first movement, so
 *     the very first frame is oriented.
 *   - Updates blend along the shortest arc (350° → 10° turns +20°, not
 *     −340°), damped so one noisy fix cannot snap the camera.
 */

/** [lng, lat] — Mapbox order. */
export type CourseLngLat = [number, number];

export interface CourseState {
  /** Current course bearing in degrees [0, 360), or null before any seed. */
  bearing: number | null;
  /** The last fix that ADVANCED the course (not merely arrived). */
  lastFix: CourseLngLat | null;
}

/** Metres a fix must move before it may turn the course. Same as the WebView map. */
export const MIN_COURSE_M = 6;
/** Shortest-arc blend factor per accepted fix. Same as the WebView map. */
export const COURSE_BLEND = 0.45;

export const initialCourse: CourseState = {bearing: null, lastFix: null};

/** Great-circle initial bearing from a to b, degrees [0, 360). */
export function bearingDeg(a: CourseLngLat, b: CourseLngLat): number {
  const y1 = (a[1] * Math.PI) / 180;
  const y2 = (b[1] * Math.PI) / 180;
  const dx = ((b[0] - a[0]) * Math.PI) / 180;
  const y = Math.sin(dx) * Math.cos(y2);
  const x = Math.cos(y1) * Math.sin(y2) - Math.sin(y1) * Math.cos(y2) * Math.cos(dx);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Fast local-plane distance — fine at fix-to-fix scales. */
export function metresBetween(a: CourseLngLat, b: CourseLngLat): number {
  const mLat = 111320;
  const mLng = 111320 * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * mLng, (b[1] - a[1]) * mLat);
}

/** Shortest-arc blend, so 350 -> 10 turns +20 degrees and not -340. */
export function blendBearing(from: number, to: number, k: number): number {
  const d = ((to - from + 540) % 360) - 180;
  return (from + d * k + 360) % 360;
}

/**
 * Feed one fix; returns the next state. Pure — the caller owns the state.
 *
 * `headingDeg` (server heading) only seeds a null bearing; once any bearing
 * exists, movement is the only thing that turns it.
 */
export function advanceCourse(
  state: CourseState,
  fix: CourseLngLat,
  headingDeg?: number | null,
): CourseState {
  let bearing = state.bearing;
  if (bearing === null && typeof headingDeg === 'number' && Number.isFinite(headingDeg)) {
    bearing = ((headingDeg % 360) + 360) % 360;
  }
  if (!state.lastFix) {
    return {bearing, lastFix: fix};
  }
  if (metresBetween(state.lastFix, fix) < MIN_COURSE_M) {
    return {bearing, lastFix: state.lastFix};
  }
  const raw = bearingDeg(state.lastFix, fix);
  return {
    bearing: bearing === null ? raw : blendBearing(bearing, raw, COURSE_BLEND),
    lastFix: fix,
  };
}
