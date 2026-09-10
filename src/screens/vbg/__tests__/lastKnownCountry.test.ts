/**
 * The persisted "where the user was last seen" cache feeds rungs 4 and 6 of the
 * emergency-country ladder, so a poisoned entry pins the WRONG emergency
 * numbers with a fresh-looking timestamp behind it.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getLastKnownCountry, setLastKnownCountry, _resetLastKnownCountryForTests,
} from '../lastKnownCountry';
import {pickEmergencyCountry} from '../resolveEmergencyCountry';

const KEY = 'bravo:vbg:last-geo-country';

beforeEach(async () => {
  _resetLastKnownCountryForTests();
  await AsyncStorage.clear();
});

describe('setLastKnownCountry', () => {
  it('stamps the write so the resolver can judge its age', async () => {
    const before = Date.now();
    await setLastKnownCountry({iso: 'AE', name: 'United Arab Emirates'});
    const c = await getLastKnownCountry();
    expect(c.iso).toBe('AE');
    expect(c.at).toBeGreaterThanOrEqual(before);
  });

  /**
   * THE REGRESSION THIS FILE EXISTS FOR.
   *
   * The write used to merge field-by-field (`next.iso ?? cache?.iso`). A geocode
   * that resolves a place NAME but no country short_code then pairs the stale
   * ISO with the fresh name — and because the resolver reads the ISO first, the
   * London→Dubai traveller gets pinned back to the United Kingdom by the very
   * cache that was meant to fix them.
   */
  it('a name-only observation does NOT keep the previous country\'s ISO', async () => {
    await setLastKnownCountry({iso: 'GB', name: 'United Kingdom'});   // in London
    await setLastKnownCountry({iso: null, name: 'United Arab Emirates'}); // in Dubai

    const c = await getLastKnownCountry();
    expect(c.iso).toBeNull();
    expect(c.name).toBe('United Arab Emirates');

    // And the ladder must therefore resolve the UAE, not the UK.
    const r = pickEmergencyCountry({
      cachedIso: c.iso, cachedName: c.name, cachedAt: c.at, localeIso: 'GB',
    });
    expect(r?.entry.iso).toBe('AE');
  });

  it('an observation replaces the previous one wholesale', async () => {
    await setLastKnownCountry({iso: 'GB', name: 'United Kingdom'});
    await setLastKnownCountry({iso: 'DE', name: 'Germany'});
    const c = await getLastKnownCountry();
    expect(c).toMatchObject({iso: 'DE', name: 'Germany'});
  });

  it('never persists coordinates — the file must stay out of the location blast radius', async () => {
    await setLastKnownCountry({iso: 'DE', name: 'Germany'});
    const raw = (await AsyncStorage.getItem(KEY)) ?? '';
    expect(JSON.parse(raw)).toEqual({iso: 'DE', name: 'Germany', at: expect.any(Number)});
    expect(raw).not.toMatch(/lat|lng|latitude|longitude|coord/i);
  });
});

describe('getLastKnownCountry', () => {
  it('reads a value persisted by an OLDER app version (no timestamp) as unknown-age', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify({iso: 'AE', name: 'United Arab Emirates'}));
    const c = await getLastKnownCountry();
    expect(c.iso).toBe('AE');
    expect(c.at).toBeNull();

    // Unknown age must NOT outrank the SIM (it could be months old).
    const r = pickEmergencyCountry({simIso: 'DE', cachedIso: c.iso, cachedAt: c.at});
    expect(r?.source).toBe('sim');
  });

  it('survives a corrupt payload rather than throwing into an emergency screen', async () => {
    await AsyncStorage.setItem(KEY, '{not json');
    await expect(getLastKnownCountry()).resolves.toEqual({iso: null, name: null, at: null});
  });

  it('returns empty when nothing was ever stored', async () => {
    await expect(getLastKnownCountry()).resolves.toEqual({iso: null, name: null, at: null});
  });
});
