/**
 * Founder spec 2026-08-01 — booking zone country list: 195 countries, only
 * UAE + South Africa selectable, located country always on top (active or
 * "Coming Soon"), the rest grouped for the two collapsed dropdowns.
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {getItem: jest.fn(async () => null), setItem: jest.fn(async () => {})},
}), {virtual: true});

import {composeZoneCountries, ACTIVE_ZONE_CODES} from '../zoneCountries';
import {NEWS_COUNTRIES} from '@/modules/news/newsPrefs';

// "All 195 countries" (founder wording) = the whole canonical country list;
// derive the exact count so a list update can never silently shrink coverage.
const TOTAL = NEWS_COUNTRIES.length - 1; // minus GLOBAL

describe('composeZoneCountries', () => {
  it('only UAE and South Africa are active', () => {
    expect([...ACTIVE_ZONE_CODES].sort()).toEqual(['AE', 'ZA']);
    const {active, soon} = composeZoneCountries(null);
    expect(active.map(c => c.code).sort()).toEqual(['AE', 'ZA']);
    expect(active.every(c => c.active)).toBe(true);
    expect(soon.every(c => !c.active)).toBe(true);
  });

  it('covers the whole canonical country list exactly once (GLOBAL excluded)', () => {
    const {active, soon} = composeZoneCountries(null);
    expect(TOTAL).toBeGreaterThanOrEqual(195);
    expect(active.length + soon.length).toBe(TOTAL);
    expect([...active, ...soon].some(c => c.code === 'GLOBAL')).toBe(false);
  });

  it('located ACTIVE country is pulled out of the dropdown (shown on top instead)', () => {
    const {current, active, soon} = composeZoneCountries('AE');
    expect(current).toEqual({code: 'AE', label: 'UAE', active: true});
    expect(active.map(c => c.code)).toEqual(['ZA']);
    expect(soon.some(c => c.code === 'AE')).toBe(false);
  });

  it('located NOT-YET-COVERED country still surfaces, marked inactive (Coming Soon)', () => {
    const {current, active, soon} = composeZoneCountries('BD');
    expect(current).toEqual({code: 'BD', label: 'Bangladesh', active: false});
    // Both actives stay in the dropdown, alphabetical.
    expect(active.map(c => c.label)).toEqual(['South Africa', 'UAE']);
    expect(soon.some(c => c.code === 'BD')).toBe(false);
  });

  it('unknown location: no current row, everything lives in the dropdowns', () => {
    const {current, active, soon} = composeZoneCountries(null);
    expect(current).toBeNull();
    expect(active.length).toBe(2);
    expect(soon.length).toBe(TOTAL - 2);
  });

  it('coming-soon list stays alphabetical (dropdown render order)', () => {
    const {soon} = composeZoneCountries(null);
    const labels = soon.map(c => c.label);
    expect(labels).toEqual([...labels].sort());
  });
});
