/**
 * Coverage zones for Bravo Lite booking.
 *
 * For MVP we use **circular coverage** (centre + radius) per city. When
 * the user drops a pin via the Mapbox LocationPicker, we check haversine
 * distance from each city centre — if any radius contains the point,
 * the booking is accepted; otherwise we surface "no coverage".
 */

export interface CoverageZone {
  id: string;
  label: string;
  country: string;
  countryCode: string;
  lat: number;
  lng: number;
  /** coverage radius in kilometres */
  radiusKm: number;
}

export const COVERAGE_ZONES: CoverageZone[] = [
  // UAE
  {id: 'dxb', label: 'Dubai',     country: 'UAE', countryCode: 'AE', lat: 25.2048, lng: 55.2708, radiusKm: 40},
  {id: 'auh', label: 'Abu Dhabi', country: 'UAE', countryCode: 'AE', lat: 24.4539, lng: 54.3773, radiusKm: 35},
  {id: 'shj', label: 'Sharjah',   country: 'UAE', countryCode: 'AE', lat: 25.3463, lng: 55.4209, radiusKm: 18},

  // KSA
  {id: 'ryd', label: 'Riyadh',    country: 'Saudi Arabia', countryCode: 'SA', lat: 24.7136, lng: 46.6753, radiusKm: 45},
  {id: 'jed', label: 'Jeddah',    country: 'Saudi Arabia', countryCode: 'SA', lat: 21.4858, lng: 39.1925, radiusKm: 35},

  // Bangladesh
  {id: 'dac', label: 'Dhaka',      country: 'Bangladesh', countryCode: 'BD', lat: 23.8103, lng: 90.4125, radiusKm: 60},
  {id: 'cgp', label: 'Chattogram', country: 'Bangladesh', countryCode: 'BD', lat: 22.3569, lng: 91.7832, radiusKm: 35},
  {id: 'syl', label: 'Sylhet',     country: 'Bangladesh', countryCode: 'BD', lat: 24.8949, lng: 91.8687, radiusKm: 25},

  // South Africa (B-93 launch — without these the LocationPicker fell back
  // to its Dubai default and every ZA pin read "out of coverage").
  {id: 'jnb', label: 'Johannesburg', country: 'South Africa', countryCode: 'ZA', lat: -26.2041, lng: 28.0473, radiusKm: 50},
  {id: 'cpt', label: 'Cape Town',    country: 'South Africa', countryCode: 'ZA', lat: -33.9249, lng: 18.4241, radiusKm: 45},
];

/** Haversine distance (km) between two coordinates. */
export function distanceKm(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface CoverageCheck {
  inCoverage: boolean;
  nearest: CoverageZone | null;
  distanceKm: number;
  /** Zones scoped to the user's currently-selected country (so a Dubai booking
   *  that drifts into Sharjah is still "covered", but one into Oman is not). */
  scopedZones: CoverageZone[];
}

/**
 * Check whether a point falls inside any coverage zone — globally. The
 * `countryCode` is only used to populate `scopedZones` (e.g. for drawing
 * the country's coverage rings on the picker map) and to pick the
 * "nearest" zone shown in the warning banner when the pin is *outside*
 * coverage. It does NOT gate the coverage decision: a pin in Dhaka is
 * still in-coverage even if the booking flow defaulted countryCode='AE'.
 */
export function checkCoverage(
  lat: number,
  lng: number,
  countryCode: string,
): CoverageCheck {
  const scopedZones = COVERAGE_ZONES.filter(z => z.countryCode === countryCode);

  let nearest: CoverageZone | null = null;
  let nearestDist = Number.POSITIVE_INFINITY;
  let inCoverage = false;

  for (const z of COVERAGE_ZONES) {
    const d = distanceKm(lat, lng, z.lat, z.lng);
    if (d <= z.radiusKm) {inCoverage = true;}
    // Prefer a zone in the user's selected country for the "nearest" label;
    // otherwise fall back to the globally nearest zone.
    const preferScope = scopedZones.length > 0;
    const zoneInScope = z.countryCode === countryCode;
    const better = d < nearestDist;
    if (preferScope ? zoneInScope && better : better) {
      nearest = z;
      nearestDist = d;
    }
  }

  return {
    inCoverage,
    nearest,
    distanceKm: +nearestDist.toFixed(1),
    scopedZones,
  };
}
