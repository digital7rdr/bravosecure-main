/**
 * Pure coordinate-resolution for the GeoRisk "Run Security Analysis" action.
 *
 * Kept in its own module (no React Native / expo imports) so the stale-GPS-fix
 * guard is unit-testable without loading the screen's native dependency graph.
 */
export interface LatLng { lat: number; lng: number }

export type AnalysisCoords =
  | {kind: 'ok'; lat: number; lng: number}
  | {kind: 'error'; message: string};

/**
 * Decide which coordinates an analysis run should use.
 *
 * Source is unambiguous: GPS mode uses the GPS `coords`; typed mode uses the
 * freshly-`geocoded` result. A typed query under 2 chars is "no location"
 * (NOT a fallback to a previously-set `coords`), which is what stops a stale
 * GPS fix from being silently re-scored under a half-typed query.
 */
export function resolveAnalysisCoords(args: {
  usingGps: boolean;
  coords: LatLng | null;
  query: string;
  geocoded: LatLng | null;
}): AnalysisCoords {
  const {usingGps, coords, query, geocoded} = args;
  const trimmed = query.trim();
  const where = usingGps ? coords : (trimmed.length >= 2 ? geocoded : null);
  if (where) {return {kind: 'ok', lat: where.lat, lng: where.lng};}
  return {
    kind: 'error',
    message: !usingGps && trimmed.length > 0 && trimmed.length < 2
      ? 'Enter at least 2 characters to search a place.'
      : 'Pick a location first — type a place or use your GPS.',
  };
}
