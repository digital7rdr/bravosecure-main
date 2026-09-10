/**
 * The encoded-polyline decoder, and the precision trap it exists to avoid.
 *
 * Untestable in its original home (inline in a generated HTML template
 * literal). The mission route arrives from the Directions API at precision 6;
 * decoding at the library default of 5 does not error — it silently produces
 * coordinates ~10x out, which looks like a route to nowhere.
 */
import {ROUTE_POLYLINE_PRECISION, decodePolyline} from '../decodePolyline';

// The canonical Google example, which decodes at precision 5 to
// (38.5, -120.2), (40.7, -120.95), (43.252, -126.453).
const SAMPLE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

describe('decodePolyline', () => {
  it('decodes the canonical sample to [lng, lat] pairs', () => {
    const out = decodePolyline(SAMPLE, 5);
    expect(out).toHaveLength(3);
    // Mapbox order — lng FIRST. Swapping these puts Dubai in Somalia.
    expect(out[0][0]).toBeCloseTo(-120.2, 5);
    expect(out[0][1]).toBeCloseTo(38.5, 5);
    expect(out[2][0]).toBeCloseTo(-126.453, 5);
    expect(out[2][1]).toBeCloseTo(43.252, 5);
  });

  it('precision changes the ANSWER, not just the accuracy', () => {
    const p5 = decodePolyline(SAMPLE, 5);
    const p6 = decodePolyline(SAMPLE, 6);
    // Exactly a factor of ten out — no error, no throw, just a wrong map.
    expect(p6[0][0]).toBeCloseTo(p5[0][0] / 10, 6);
    expect(p6[0][1]).toBeCloseTo(p5[0][1] / 10, 6);
  });

  it('this app decodes routes at precision 6', () => {
    // Pinned because the default is 5 and the failure is silent.
    expect(ROUTE_POLYLINE_PRECISION).toBe(6);
  });

  it('an empty or missing string is an empty route, not a crash', () => {
    expect(decodePolyline('')).toEqual([]);
    expect(decodePolyline(undefined as unknown as string)).toEqual([]);
  });

  it('handles a single point', () => {
    const one = decodePolyline('_p~iF~ps|U', 5);
    expect(one).toHaveLength(1);
    expect(one[0][1]).toBeCloseTo(38.5, 5);
  });
});
