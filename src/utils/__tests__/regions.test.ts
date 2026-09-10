import {
  regionFromCountry, isSupportedRegion, regionName, regionFromBBox, detectRegion,
  SUPPORTED_REGION_CODES, REGION_NA, REGIONS, coverageRegionRows,
} from '../regions';

describe('region helpers', () => {
  it('maps ISO country → region (case-insensitive)', () => {
    expect(regionFromCountry('AE')).toBe('AE');
    expect(regionFromCountry('ae')).toBe('AE');
    expect(regionFromCountry(' gb ')).toBe('GB');
    expect(regionFromCountry('US')).toBe(REGION_NA);
    expect(regionFromCountry(null)).toBe(REGION_NA);
    expect(regionFromCountry(undefined)).toBe(REGION_NA);
  });

  it('validates supported regions', () => {
    expect(isSupportedRegion('SA')).toBe(true);
    expect(isSupportedRegion('za')).toBe(true);
    expect(isSupportedRegion('XX')).toBe(false);
    expect(isSupportedRegion(null)).toBe(false);
    expect(SUPPORTED_REGION_CODES).toEqual(['AE', 'SA', 'BD', 'GB', 'ZA']);
  });

  it('names regions', () => {
    expect(regionName('BD')).toBe('Bangladesh');
    expect(regionName('GB')).toBe('United Kingdom');
    expect(regionName(null)).toBe('—');
  });
});

describe('regionFromBBox (offline fallback)', () => {
  const cases: Array<[string, number, number, string]> = [
    ['Dubai → AE (not the overlapping SA box)', 25.2048, 55.2708, 'AE'],
    ['Riyadh → SA', 24.7136, 46.6753, 'SA'],
    ['Jeddah → SA', 21.4858, 39.1925, 'SA'],
    ['Dhaka → BD', 23.8103, 90.4125, 'BD'],
    ['London → GB', 51.5074, -0.1278, 'GB'],
    ['Johannesburg → ZA', -26.2041, 28.0473, 'ZA'],
    ['New York → N/A (outside coverage)', 40.7128, -74.006, REGION_NA],
  ];
  it.each(cases)('%s', (_label, lat, lng, expected) => {
    expect(regionFromBBox(lat, lng)).toBe(expected);
  });
});

describe('detectRegion', () => {
  it('prefers the reverse-geocoded country when present', () => {
    // A Dubai fix whose country resolves to SA (e.g. near the border) trusts the geocode.
    expect(detectRegion('SA', 25.2048, 55.2708)).toEqual({region: 'SA', country: 'SA', source: 'geocode'});
    expect(detectRegion('gb', 0, 0)).toEqual({region: 'GB', country: 'GB', source: 'geocode'});
  });

  it('falls back to bounding boxes when the country is unknown', () => {
    expect(detectRegion(null, 25.2048, 55.2708)).toEqual({region: 'AE', country: null, source: 'bbox'});
    expect(detectRegion(undefined, 40.7128, -74.006)).toEqual({region: REGION_NA, country: null, source: 'bbox'});
  });
});

/**
 * Issue 37 (Testing Issues V2, PDF p.42) — "South Africa Is Missing from
 * Provider Coverage Regions", CRITICAL: the pilot launches in South Africa.
 *
 * AgentCoverageScreen hard-coded its own five-country array which drifted from
 * this canonical list — ZA absent, and US present even though it is not a
 * dispatch region at all. Coverage rows are now DERIVED, so the two cannot
 * disagree again.
 */
describe('coverageRegionRows — provider coverage picker (Issue 37)', () => {
  const rows = coverageRegionRows();

  it('offers exactly the supported dispatch regions, in canonical order', () => {
    expect(rows.map(r => r.code)).toEqual([...SUPPORTED_REGION_CODES]);
  });

  it('includes South Africa — the pilot region', () => {
    const za = rows.find(r => r.code === 'ZA');
    expect(za).toBeDefined();
    expect(za?.name).toBe('South Africa');
    // The pilot cities, matching modules/booking/coverageZones.ts.
    expect(za?.cities).toContain('Johannesburg');
    expect(za?.cities).toContain('Cape Town');
  });

  it('implies NO unsupported region (the screen used to list USA)', () => {
    expect(rows.some(r => r.code === 'US')).toBe(false);
    for (const row of rows) {
      expect(isSupportedRegion(row.code)).toBe(true);
    }
  });

  it('every region carries a non-empty city list, so no row renders blank', () => {
    for (const row of rows) {
      expect(row.cities.length).toBeGreaterThan(0);
      expect(row.name.length).toBeGreaterThan(0);
    }
  });

  it('defaults every region OFF — a provider opts in to what it can serve', () => {
    expect(rows.every(r => r.on === false)).toBe(true);
  });

  it('South Africa and Saudi Arabia never share a display badge', () => {
    // ZA badge was 'SA', which is Saudi Arabia's dispatch CODE. Dispatching a
    // detail to the wrong continent is the failure mode this guards.
    const za = REGIONS.find(r => r.code === 'ZA');
    const sa = REGIONS.find(r => r.code === 'SA');
    expect(za?.badge).not.toBe(sa?.badge);
    expect(za?.badge).not.toBe('SA');
  });
});
