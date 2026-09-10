/**
 * Pins the emergency directory's country ladder.
 *
 * THE BUG (client, 2026-08-28): a principal standing in Dubai on an
 * "English (United Kingdom)" phone was pinned to the UNITED KINGDOM and offered
 * UK emergency numbers, because the only fallback the param-less doors ever
 * reached was the device LOCALE — a language setting. Two other users were
 * "correct" purely by coincidence (a German in Germany on a German phone, a
 * Bangladeshi in Bangladesh on a Bengali phone), which is exactly why the defect
 * survived: the happy path and the broken path are indistinguishable until
 * someone travels.
 *
 * Every source in the ladder is a device-local PHYSICAL signal. None is
 * IP-derived, so a VPN cannot move any of them — `vpn` cases below pin that
 * property by construction (there is no IP input to poison).
 */
import {readFileSync} from 'fs';
import {join} from 'path';
import {
  pickEmergencyCountry, sourceLabel, CACHE_FRESH_MS, type CountrySource,
} from '../resolveEmergencyCountry';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

describe('pickEmergencyCountry — the reported defect', () => {
  it('pins the UAE for a client in Dubai holding an en_GB phone (was: United Kingdom)', () => {
    const r = pickEmergencyCountry({
      // Every param-less door: the Calls emergency card, the agency shell.
      paramIso: null, paramName: null,
      gpsIso: null,
      networkIso: 'AE',   // camped on an Emirati tower
      simIso: 'AE',
      cachedIso: null, cachedAt: null,
      localeIso: 'GB',    // the phone merely SPEAKS British English
      now: NOW,
    });
    expect(r?.entry.iso).toBe('AE');
    expect(r?.entry.name).toBe('United Arab Emirates');
    expect(r?.source).toBe('network');
    expect(r?.precise).toBe(true);
    // The number that was actually wrong: UK police is 999, UAE ambulance 998.
    expect(r?.entry.ambulance).toBe('998');
  });

  it('still pins Germany for a user in Germany, and Bangladesh for one in Bangladesh', () => {
    const de = pickEmergencyCountry({networkIso: 'DE', localeIso: 'DE', now: NOW});
    expect(de?.entry.iso).toBe('DE');
    expect(de?.entry.police).toBe('110');

    const bd = pickEmergencyCountry({networkIso: 'BD', localeIso: 'BD', now: NOW});
    expect(bd?.entry.iso).toBe('BD');
    expect(bd?.entry.all).toBe('999');
  });

  it('a VPN cannot change the answer — there is no IP input to influence', () => {
    // The same physical signals resolve identically no matter what a VPN would
    // have claimed, because no rung of the ladder accepts an IP-derived country.
    const signals = {networkIso: 'AE', simIso: 'AE', localeIso: 'GB', now: NOW};
    expect(pickEmergencyCountry(signals)?.entry.iso).toBe('AE');
    expect(Object.keys(signals)).not.toContain('ipIso');
  });
});

describe('pickEmergencyCountry — ladder order', () => {
  it('a caller-supplied geocode outranks everything', () => {
    const r = pickEmergencyCountry({
      paramIso: 'FR', gpsIso: 'DE', networkIso: 'AE', simIso: 'GB',
      cachedIso: 'IT', cachedAt: NOW, localeIso: 'US', now: NOW,
    });
    expect(r?.source).toBe('param');
    expect(r?.entry.iso).toBe('FR');
  });

  it('a live GPS geocode outranks the network', () => {
    const r = pickEmergencyCountry({gpsIso: 'DE', networkIso: 'AE', now: NOW});
    expect(r?.source).toBe('gps');
    expect(r?.entry.iso).toBe('DE');
  });

  /**
   * `/vbg/geocode` really does answer `country: null` with a usable context —
   * VBGHomeScreen has always handled that shape. A no-SIM tablet in Dubai on an
   * en_GB phone would otherwise drop a LIVE location answer through every rung
   * to the locale, and land back on the United Kingdom: the original defect,
   * with the right answer sitting unread in the response.
   */
  it('uses the geocoded NAME when the response carries no country code', () => {
    const r = pickEmergencyCountry({
      gpsIso: null, gpsName: 'United Arab Emirates', localeIso: 'GB', now: NOW,
    });
    expect(r?.source).toBe('gps');
    expect(r?.entry.iso).toBe('AE');
    expect(r?.precise).toBe(true);
  });

  it('the serving network outranks even a FRESH cache — London→Dubai flips on landing', () => {
    const r = pickEmergencyCountry({
      networkIso: 'AE',
      cachedIso: 'GB', cachedAt: NOW - HOUR, // geocoded in London an hour ago
      localeIso: 'GB',
      now: NOW,
    });
    expect(r?.source).toBe('network');
    expect(r?.entry.iso).toBe('AE');
  });

  it('a fresh cache outranks the SIM home country, but is NEVER "Your Location"', () => {
    const r = pickEmergencyCountry({
      simIso: 'DE', cachedIso: 'AE', cachedAt: NOW - HOUR / 2, localeIso: 'DE', now: NOW,
    });
    expect(r?.source).toBe('cache');
    expect(r?.entry.iso).toBe('AE');
    // A remembered country is where the user WAS. Rendering it under a
    // confident green "Your Location" is how an airplane-mode arrival gets told
    // it is still in the country it left.
    expect(r?.precise).toBe(false);
    expect(sourceLabel('cache')).toMatch(/confirm before dialling/i);
  });

  it('the cache expires well before a long-haul flight lands', () => {
    // London→Dubai is ~7 h. The cache must NOT still be authoritative on arrival.
    expect(CACHE_FRESH_MS).toBeLessThan(7 * HOUR);
    const r = pickEmergencyCountry({
      simIso: 'DE', cachedIso: 'GB', cachedAt: NOW - 7 * HOUR, localeIso: 'GB', now: NOW,
    });
    expect(r?.entry.iso).not.toBe('GB');
  });

  it('a STALE cache drops below the SIM — a German home from Dubai six months ago', () => {
    const r = pickEmergencyCountry({
      simIso: 'DE',
      cachedIso: 'AE', cachedAt: NOW - CACHE_FRESH_MS - 1,
      localeIso: 'DE', now: NOW,
    });
    expect(r?.source).toBe('sim');
    expect(r?.entry.iso).toBe('DE');
    expect(r?.precise).toBe(false);
  });

  it('a stale cache still beats the locale when there is no SIM', () => {
    const r = pickEmergencyCountry({
      cachedIso: 'AE', cachedAt: NOW - CACHE_FRESH_MS - 1, localeIso: 'GB', now: NOW,
    });
    expect(r?.source).toBe('stale-cache');
    expect(r?.entry.iso).toBe('AE');
    expect(r?.precise).toBe(false);
  });

  it('the locale is last, and is never reported as precise', () => {
    const r = pickEmergencyCountry({localeIso: 'GB', now: NOW});
    expect(r?.source).toBe('locale');
    expect(r?.precise).toBe(false);
    expect(sourceLabel(r!.source)).toMatch(/confirm before dialling/i);
  });
});

describe('pickEmergencyCountry — hostile and legacy inputs', () => {
  it('a cache with no timestamp (written before timestamping) counts as STALE', () => {
    const r = pickEmergencyCountry({
      simIso: 'DE', cachedIso: 'AE', cachedAt: null, localeIso: 'DE', now: NOW,
    });
    expect(r?.source).toBe('sim');
  });

  it('a future timestamp (clock skew / user clock change) counts as STALE', () => {
    const r = pickEmergencyCountry({
      simIso: 'DE', cachedIso: 'AE', cachedAt: NOW + HOUR, localeIso: 'DE', now: NOW,
    });
    expect(r?.source).toBe('sim');
  });

  it('a NaN timestamp counts as stale rather than throwing', () => {
    const r = pickEmergencyCountry({
      simIso: 'DE', cachedIso: 'AE', cachedAt: Number.NaN, localeIso: 'DE', now: NOW,
    });
    expect(r?.source).toBe('sim');
  });

  it('a rung naming a country the offline directory lacks FALLS THROUGH', () => {
    // 'XX' is not a country; it must not pin nothing and hide the real answer.
    const r = pickEmergencyCountry({networkIso: 'XX', simIso: 'DE', now: NOW});
    expect(r?.source).toBe('sim');
    expect(r?.entry.iso).toBe('DE');
  });

  it('resolves by NAME when only a free-text country is known', () => {
    const r = pickEmergencyCountry({paramName: 'United Arab Emirates', now: NOW});
    expect(r?.entry.iso).toBe('AE');
  });

  it('returns null when nothing is known — the caller hides the card', () => {
    expect(pickEmergencyCountry({now: NOW})).toBeNull();
    expect(pickEmergencyCountry({
      networkIso: null, simIso: null, cachedIso: null, localeIso: null, now: NOW,
    })).toBeNull();
  });

  it('every source has a caption, and only the CURRENT ones go unhedged', () => {
    // 'cache' is deliberately on the hedged side: it is where the user WAS.
    const precise: CountrySource[] = ['param', 'gps', 'network'];
    const inferred: CountrySource[] = ['cache', 'sim', 'stale-cache', 'locale'];
    for (const s of [...precise, ...inferred]) {
      expect(sourceLabel(s).length).toBeGreaterThan(0);
    }
    for (const s of inferred) {
      expect(sourceLabel(s)).toMatch(/confirm before dialling/i);
    }
    for (const s of precise) {
      expect(sourceLabel(s)).not.toMatch(/confirm/i);
    }
  });
});

/**
 * Source scan — the screen must FEED the ladder, not re-implement a fallback.
 *
 * The file is CRLF, so this is line-based (a `\n`-anchored regex would match
 * nothing and pass vacuously), and comments are stripped first: this very file's
 * prose describes the old locale-first shape, and so does the screen's.
 */
describe('VBGEmergencyScreen wiring', () => {
  const SRC = readFileSync(
    join(__dirname, '..', 'VBGEmergencyScreen.tsx'), 'utf8',
  );
  const code = SRC
    .split(/\r?\n/)
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('resolves through pickEmergencyCountry', () => {
    expect(code).toMatch(/pickEmergencyCountry\(\{/);
  });

  /**
   * The locale must reach the card ONLY through the ladder. Banning one exact
   * textual shape was too weak — `const fallback = emergencyForIso(getDevice…)`
   * would have reintroduced the defect and stayed green. Instead: the locale
   * getter may appear exactly ONCE, and that occurrence must be the ladder's
   * `localeIso` argument. Any second use is a second decision site.
   */
  it('uses the device locale ONLY as the ladder\'s localeIso input', () => {
    const uses = code.match(/getDeviceCountryIso\(\)/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(code).toMatch(/localeIso:\s*getDeviceCountryIso\(\)/);
    expect(code).not.toMatch(/emergencyForIso\(\s*getDeviceCountryIso/);
  });

  it('reads a fix through the silent helper, never a raw geolocation call', () => {
    expect(code).toMatch(/getSilentFix\(\)/);
    // The screen must not grow its own location/permission path around it.
    expect(code).not.toMatch(/PermissionsAndroid/);
    expect(code).not.toMatch(/getCurrentPosition|requestAuthorization/);
  });

  it('pins nothing until the offline signals land (no locale-only first paint)', () => {
    expect(code).toMatch(/signals\.ready/);
    // Gate on the param having RESOLVED, not on one having been PASSED — an
    // unmatchable param must not buy its way past the gate.
    expect(code).toMatch(/const fromParam = pickEmergencyCountry\(\{paramIso, paramName\}\)/);
    expect(code).toMatch(/if\s*\(fromParam\)\s*\{return fromParam;\}/);
    expect(code).toMatch(/if\s*\(!signals\.ready\)\s*\{return null;\}/);
    expect(code).not.toMatch(/hasParam/);
  });

  it('feeds the permission-free network country into the ladder', () => {
    expect(code).toMatch(/getRadioCountry\(\)/);
    expect(code).toMatch(/networkIso:\s*signals\.networkIso/);
  });

  it('keeps the geocoded country NAME, not only its ISO', () => {
    expect(code).toMatch(/countryNameFromContext\(res\.data\.context\)/);
    expect(code).toMatch(/gpsName:\s*gps\.name/);
  });

  it('persists a fresh geocode so the next open starts from a real location', () => {
    expect(code).toMatch(/setLastKnownCountry\(\{iso, name\}\)/);
  });

  it('logs the RESOLVED country on a dial, not the (usually absent) route param', () => {
    expect(code).toMatch(/countryIso:\s*detectedIso/);
  });

  it('keeps `call` off the resolved OBJECT so memoized rows do not churn', () => {
    expect(code).toMatch(/\}, \[detectedIso, route\.params\?\.countryIso\]\)/);
  });

  /**
   * The ONLY mechanism a VPN could poison. Banning a handful of vendor names was
   * decorative — `fetch('https://api.country.is')` sailed past it. The real
   * invariant is that this screen makes exactly ONE outbound call, to our own
   * geocode endpoint, carrying coordinates the device already has.
   */
  it('never introduces an IP-geolocation lookup', () => {
    expect(code).not.toMatch(/ipapi|ip-api|ipinfo|geoip|ipIso/i);
    // Vendor-name bans are decorative on their own (`fetch('https://api.country.is')`
    // walks past them), so assert the screen's COMPLETE outbound-call set instead.
    // `authHttp`/`http` are named explicitly: they end in neither `Api` nor
    // `fetch`, and would otherwise slip through the shape below.
    const calls = code.match(
      /\b(fetch|axios|XMLHttpRequest)\s*\(|\b(authHttp|http|api)\.\w+\(|\w+Api\.\w+\(/g,
    ) ?? [];
    expect(calls).toEqual(['vbgApi.geocode(']);
  });
});
