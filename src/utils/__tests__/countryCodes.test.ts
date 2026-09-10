/**
 * Founder rule 2026-08-08 — every country abbreviation the user can see is
 * THREE letters (ISO 3166-1 alpha-3), never two.
 *
 * Two halves, because either alone is a false pass:
 *
 *  - the DATA half: alpha-3 exists for every country the app offers, is
 *    well-formed and is unique. A missing entry silently falls back to the
 *    alpha-2 input, which is exactly the bug being fixed — so completeness has
 *    to be asserted against the real lists, not sampled.
 *  - the CALL-SITE half: a source scan proving no screen renders a raw
 *    alpha-2. The data can be perfect while a screen still prints `item.code`.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ALPHA2_TO_ALPHA3, GLOBAL_CODE, alpha3} from '@utils/countryCodes';
import {NEWS_COUNTRIES} from '@modules/news/newsPrefs';
import {REGIONS} from '@utils/regions';
import {EMERGENCY_NUMBERS} from '@screens/vbg/emergencyNumbers';

describe('alpha-3 table — data', () => {
  it('every value is exactly three uppercase letters', () => {
    const bad = Object.entries(ALPHA2_TO_ALPHA3).filter(([, v]) => !/^[A-Z]{3}$/.test(v));
    expect(bad).toEqual([]);
  });

  it('every key is exactly two uppercase letters', () => {
    const bad = Object.keys(ALPHA2_TO_ALPHA3).filter(k => !/^[A-Z]{2}$/.test(k));
    expect(bad).toEqual([]);
  });

  it('no two countries share an alpha-3', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const [k, v] of Object.entries(ALPHA2_TO_ALPHA3)) {
      const prev = seen.get(v);
      if (prev) {collisions.push(`${v}: ${prev} + ${k}`);}
      seen.set(v, k);
    }
    expect(collisions).toEqual([]);
  });

  it('covers EVERY news country — a gap renders a 2-letter badge in production', () => {
    const missing = NEWS_COUNTRIES
      .map(c => c.code)
      .filter(c => c !== GLOBAL_CODE && !ALPHA2_TO_ALPHA3[c]);
    expect(missing).toEqual([]);
  });

  it('covers every dispatch region and every VBG emergency country', () => {
    expect(REGIONS.map(r => r.code).filter(c => !ALPHA2_TO_ALPHA3[c])).toEqual([]);
    expect(EMERGENCY_NUMBERS.map(e => e.iso).filter(c => !ALPHA2_TO_ALPHA3[c])).toEqual([]);
  });

  it('carries no entry for a country nothing offers (dead rows rot)', () => {
    const known = new Set<string>([
      ...NEWS_COUNTRIES.map(c => c.code),
      ...REGIONS.map(r => r.code),
      ...EMERGENCY_NUMBERS.map(e => e.iso),
    ]);
    expect(Object.keys(ALPHA2_TO_ALPHA3).filter(k => !known.has(k))).toEqual([]);
  });

  it('spot-checks the codes that are NOT a prefix of the English name', () => {
    // The easy ones (AFG/Afghanistan) would pass a wrong table by luck. These
    // are the ones a hand-written map actually gets wrong.
    expect(alpha3('DE')).toBe('DEU');   // Germany
    expect(alpha3('CH')).toBe('CHE');   // Switzerland
    expect(alpha3('NL')).toBe('NLD');   // Netherlands
    expect(alpha3('KM')).toBe('COM');   // Comoros
    expect(alpha3('CD')).toBe('COD');   // DR Congo
    expect(alpha3('CG')).toBe('COG');   // Congo
    expect(alpha3('CV')).toBe('CPV');   // Cape Verde
    expect(alpha3('CI')).toBe('CIV');   // Ivory Coast
    expect(alpha3('SZ')).toBe('SWZ');   // Eswatini
    expect(alpha3('KP')).toBe('PRK');   // North Korea
    expect(alpha3('KR')).toBe('KOR');   // South Korea
    expect(alpha3('RO')).toBe('ROU');   // Romania
    expect(alpha3('BA')).toBe('BIH');   // Bosnia & Herzegovina
    expect(alpha3('FM')).toBe('FSM');   // Micronesia
    expect(alpha3('SV')).toBe('SLV');   // El Salvador
    expect(alpha3('GW')).toBe('GNB');   // Guinea-Bissau
    expect(alpha3('TL')).toBe('TLS');   // Timor-Leste
    expect(alpha3('MM')).toBe('MMR');   // Myanmar
  });
});

describe('alpha3()', () => {
  it('is the identity for the GLOBAL pseudo-country', () => {
    expect(alpha3(GLOBAL_CODE)).toBe(GLOBAL_CODE);
  });

  it('accepts lowercase and padded input', () => {
    expect(alpha3('ae')).toBe('ARE');
    expect(alpha3(' dz ')).toBe('DZA');
  });

  it('degrades to the input rather than throwing or blanking', () => {
    // A country missing from the table must fail the suite above, not crash a
    // shipped screen or leave an empty chip where a code should be.
    expect(alpha3('ZZ')).toBe('ZZ');
    expect(alpha3('')).toBe('');
    expect(alpha3(null)).toBe('');
    expect(alpha3(undefined)).toBe('');
  });
});

/**
 * THE CALL-SITE HALF.
 *
 * These are the screens that render a country abbreviation. Each must pass it
 * through `alpha3()`; printing the raw alpha-2 is the founder-reported defect.
 * Comments are stripped first — the prose above each call site names the raw
 * expression, and matching that would pass vacuously.
 */
const DISPLAY_SITES: Array<[file: string, rawExpression: string]> = [
  ['src/screens/news/NewsPreferencesScreen.tsx', 'item.code'],
  ['src/screens/booking/ZoneMapScreen.tsx',      'country.code'],
  ['src/screens/agent/OrgRegionScreen.tsx',      'r.code'],
  ['src/screens/vbg/VBGEmergencyScreen.tsx',     'e.iso'],
  ['src/screens/vbg/VBGEmergencyScreen.tsx',     'detected.iso'],
];

/** Line-based strip; the house block-comment regex eats code containing `/*`. */
function codeOnly(rel: string): string {
  const lines = readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('//') || t.startsWith('*')) {continue;}
    out.push(raw);
  }
  return out.join('\n');
}

describe('no screen renders a raw two-letter country code', () => {
  it('the scan reads real code (not a vacuous pass)', () => {
    for (const [file] of DISPLAY_SITES) {
      const src = codeOnly(file);
      expect(src.length).toBeGreaterThan(1_000);
      expect(src).not.toContain('\r');
    }
  });

  it.each(DISPLAY_SITES)('%s wraps {%s} in alpha3()', (file, expr) => {
    const src = codeOnly(file);
    // The wrapped form must be present…
    expect(src).toContain(`alpha3(${expr})`);
    // …and the bare form must not be RENDERED. Anchored on the JSX text-child
    // shape `>{expr}<` rather than on `{expr}` anywhere in the file: the loose
    // form flags `key={r.code}` (OrgRegionScreen:197), which is a React key and
    // never reaches the screen. Asserting the token exists somewhere instead of
    // at the decision site is the documented false-result trap in CLAUDE.md.
    expect(src).not.toContain(`>{${expr}}<`);
  });

  it('every display site imports the helper', () => {
    for (const [file] of new Map(DISPLAY_SITES.map(s => [s[0], s])).values()) {
      expect(codeOnly(file)).toMatch(/from '@utils\/countryCodes'/);
    }
  });

  it('REGIONS badges are DERIVED, so they cannot drift from the codes', () => {
    // Issue 37 was a hand-typed badge disagreeing with its own contract.
    for (const r of REGIONS) {
      expect(r.badge).toBe(alpha3(r.code));
      expect(r.badge).toMatch(/^[A-Z]{3}$/);
    }
    // The colloquial badges are retired, explicitly.
    expect(REGIONS.map(r => r.badge).sort()).toEqual(['ARE', 'BGD', 'GBR', 'SAU', 'ZAF']);
  });

  it('the identity keys stay alpha-2 — display change only', () => {
    // Rewriting these would drop every user's saved news prefs and break the
    // dispatch/pricing key. The whole design rests on them NOT changing.
    expect(REGIONS.map(r => r.code).sort()).toEqual(['AE', 'BD', 'GB', 'SA', 'ZA']);
    expect(NEWS_COUNTRIES.every(c => c.code === GLOBAL_CODE || /^[A-Z]{2}$/.test(c.code))).toBe(true);
  });
});
