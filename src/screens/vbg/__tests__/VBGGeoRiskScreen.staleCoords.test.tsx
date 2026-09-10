/**
 * GeoRisk — stale-coords regression (adversarial-review HIGH finding).
 *
 * Repro: tap "Use My GPS" → run an analysis (scores the GPS fix). Then start a
 * NEW typed search but pause at a single character and tap RUN. The OLD code
 * left `coords` armed with the GPS fix and the <2-char branch fell through to
 * it, so the analysis silently re-scored the previous GPS location while the
 * query box showed the user's new text — a wrong-result bug.
 *
 * The decision is now isolated in the pure `resolveAnalysisCoords`, tested
 * here directly (no render → no expo runtime needed).
 */
import {resolveAnalysisCoords} from '../vbgGeoRiskCoords';

const GPS = {lat: 25.2, lng: 55.27};
const GEO = {lat: 51.5, lng: -0.12};

describe('resolveAnalysisCoords — source is unambiguous', () => {
  it('GPS mode uses the GPS coords', () => {
    expect(resolveAnalysisCoords({usingGps: true, coords: GPS, query: '', geocoded: null}))
      .toEqual({kind: 'ok', lat: GPS.lat, lng: GPS.lng});
  });

  it('typed mode (>=2 chars) uses the freshly geocoded result, NOT coords', () => {
    // coords still holds a stale GPS fix; it must be ignored in typed mode.
    expect(resolveAnalysisCoords({usingGps: false, coords: GPS, query: 'London', geocoded: GEO}))
      .toEqual({kind: 'ok', lat: GEO.lat, lng: GEO.lng});
  });

  it('THE BUG: a 1-char typed query after a GPS run does NOT reuse the stale GPS coords', () => {
    const r = resolveAnalysisCoords({usingGps: false, coords: GPS, query: 'U', geocoded: null});
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {expect(r.message).toMatch(/at least 2 characters/i);}
  });

  it('typed mode with a geocode miss errors (no stale fallback)', () => {
    const r = resolveAnalysisCoords({usingGps: false, coords: GPS, query: 'Nowhereville', geocoded: null});
    expect(r.kind).toBe('error');
  });

  it('no location at all → pick-a-location error', () => {
    const r = resolveAnalysisCoords({usingGps: false, coords: null, query: '', geocoded: null});
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {expect(r.message).toMatch(/pick a location/i);}
  });

  it('whitespace-only query is treated as empty (no location)', () => {
    const r = resolveAnalysisCoords({usingGps: false, coords: GPS, query: '   ', geocoded: null});
    expect(r.kind).toBe('error');
  });
});
