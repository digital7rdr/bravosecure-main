/**
 * B-89 MG-13 — plausibility gate for incoming GPS fixes. Raw fixes used to
 * hit the map unfiltered; a cold-start outlier or cell-tower fallback fix
 * teleported the vehicle marker (the map's >5 km "snap" then HID the
 * teleport instead of rejecting it). Pure module (chatListLayout.ts
 * convention) so the thresholds are unit-tested.
 */

export interface GpsFixLike {
  lat: number;
  lng: number;
  /** ISO timestamp the fix was recorded. */
  recordedAt?: string;
  /** Reported horizontal accuracy radius (meters). */
  accuracyM?: number;
}

/** Fixes with a worse reported accuracy than this are noise for a live map. */
export const MAX_ACCURACY_M = 150;
/** Implied speed above this (m/s ≈ 250 km/h) is a teleport, not a vehicle. */
export const MAX_PLAUSIBLE_SPEED_MPS = 70;

export function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2) ** 2
    + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s1)));
}

function coordsValid(f: GpsFixLike): boolean {
  return Number.isFinite(f.lat) && Number.isFinite(f.lng)
    && Math.abs(f.lat) <= 90 && Math.abs(f.lng) <= 180
    && !(f.lat === 0 && f.lng === 0); // null island (MG-12)
}

/**
 * Accept/reject `next` given the last ACCEPTED fix. Rules:
 *  - invalid/(0,0) coords → reject
 *  - reported accuracy worse than MAX_ACCURACY_M → reject
 *  - implied speed vs the previous fix above MAX_PLAUSIBLE_SPEED_MPS →
 *    reject (guarded: an unparseable/absent/backwards timestamp pair
 *    can't compute a speed, so it passes — better a jump than a stuck map)
 *  - no previous fix → accept (first fix wins; there is nothing to
 *    compare against, and rejecting it would starve the map forever)
 */
export function acceptGpsFix(prev: GpsFixLike | null, next: GpsFixLike): boolean {
  if (!coordsValid(next)) {return false;}
  if (typeof next.accuracyM === 'number' && next.accuracyM > MAX_ACCURACY_M) {return false;}
  if (!prev || !coordsValid(prev)) {return true;}
  const t0 = prev.recordedAt ? Date.parse(prev.recordedAt) : NaN;
  const t1 = next.recordedAt ? Date.parse(next.recordedAt) : NaN;
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) {return true;}
  const dtSec = (t1 - t0) / 1000;
  const distM = haversineM(prev.lat, prev.lng, next.lat, next.lng);
  return distM / dtSec <= MAX_PLAUSIBLE_SPEED_MPS;
}
