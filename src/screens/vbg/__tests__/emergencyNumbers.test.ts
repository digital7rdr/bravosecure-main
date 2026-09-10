/**
 * `emergencyForName` resolves the free-text country a geocoder returns. It is
 * the ONE place in this feature that can produce a confidently WRONG country
 * from a correct input, so its failure modes are pinned individually.
 *
 * The rule: a wrong match dials another country's emergency services; a null
 * falls through to the next rung of the ladder. Null is always the better loss.
 */
import {
  emergencyForName, emergencyForIso, EMERGENCY_NUMBERS, NAME_ALIASES,
} from '../emergencyNumbers';

describe('emergencyForName — confidently wrong matches', () => {
  /**
   * THE ONE THAT MATTERS MOST.
   *
   * The fallback used to take the FIRST substring hit and the directory is
   * alphabetical, so 'Hong Kong SAR China' (a standard geocoder spelling) found
   * China at index 35 before Hong Kong at index 74 — and handed someone in Hong
   * Kong 110/120/119. None of those work there; Hong Kong's number is 999.
   */
  it('resolves "Hong Kong SAR China" to HONG KONG, not China', () => {
    const e = emergencyForName('Hong Kong SAR China');
    expect(e?.iso).toBe('HK');
    expect(e?.all).toBe('999');
  });

  it('resolves "Macao SAR China" to Macau, not China', () => {
    expect(emergencyForName('Macao SAR China')?.iso).toBe('MO');
  });

  /**
   * The long form does NOT contain the string "DR Congo", so no substring rule
   * can reach it — it matched plain "Congo" and returned the WRONG Congo
   * (Republic of the Congo, police 117, instead of DR Congo's 112).
   */
  it('resolves the long-form DR Congo to CD, not to the other Congo', () => {
    expect(emergencyForName('Democratic Republic of the Congo')?.iso).toBe('CD');
    expect(emergencyForName('Republic of the Congo')?.iso).toBe('CG');
  });

  it('keeps the near-miss country pairs apart', () => {
    expect(emergencyForName('Nigeria')?.iso).toBe('NG');
    expect(emergencyForName('Niger')?.iso).toBe('NE');
    expect(emergencyForName('South Sudan')?.iso).toBe('SS');
    expect(emergencyForName('Sudan')?.iso).toBe('SD');
    expect(emergencyForName('Equatorial Guinea')?.iso).toBe('GQ');
    expect(emergencyForName('Guinea')?.iso).toBe('GN');
  });

  /**
   * These exercise the SUBSTRING path specifically — no exact match, no alias —
   * with strings containing TWO real entry names where the wrong one sorts
   * first alphabetically. Reverting the comparator to the old first-match
   * behaviour reddens both. (The Hong Kong case above is now covered by the
   * alias table, so it can no longer pin the comparator on its own.)
   */
  it('prefers the LONGEST match, never the alphabetically first', () => {
    // Every case here MUST contain a second, shorter entry name that sorts
    // first — otherwise it passes under the old comparator too and pins
    // nothing. ('Kowloon, Hong Kong' was such a case: "Kong" is not an entry,
    // so it resolved HK either way.)
    expect(emergencyForName('Lagos, Nigeria')?.iso).toBe('NG');       // vs Niger
    expect(emergencyForName('Kinshasa, DR Congo')?.iso).toBe('CD');   // vs Congo
    expect(emergencyForName('Downtown, Romania')?.iso).toBe('RO');    // vs Oman
    expect(emergencyForName('Downtown, Somalia')?.iso).toBe('SO');    // vs Mali
    expect(emergencyForName('Santo Domingo, Dominican Republic')?.iso).toBe('DO'); // vs Dominica
    expect(emergencyForName('Port Moresby, Papua New Guinea')?.iso).toBe('PG');    // vs Guinea
  });

  it('refuses an ambiguous tie rather than guessing a country', () => {
    // Two DIFFERENT entries of equal name length both substring-match; a coin
    // flip between two countries' emergency numbers is never worth taking.
    const a = EMERGENCY_NUMBERS.find(e => e.name === 'Chad')!;
    const b = EMERGENCY_NUMBERS.find(e => e.name === 'Cuba')!;
    expect(a.name.length).toBe(b.name.length);
    expect(emergencyForName(`${a.name} and ${b.name}`)).toBeNull();
  });
});

describe('emergencyForName — endonyms and long forms', () => {
  it.each([
    ['Deutschland',              'DE'],
    ['Türkiye',                  'TR'],
    ['Nederland',                'NL'],
    ['Suomi',                    'FI'],
    ['Republic of Korea',        'KR'],
    ['United States of America', 'US'],
    ['Czech Republic',           'CZ'],
    ['Ivory Coast',              'CI'],
    ['Schweiz',                  'CH'],
    ['UAE',                      'AE'],
  ])('resolves %s → %s', (name, iso) => {
    expect(emergencyForName(name)?.iso).toBe(iso);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(emergencyForName('  dEuTsChLaNd  ')?.iso).toBe('DE');
    expect(emergencyForName('United   Arab   Emirates')?.iso).toBe('AE');
  });

  /**
   * Turkish dotted capital İ (U+0130) lowercases to `i` + COMBINING DOT ABOVE,
   * which NFC cannot recompose (there is no precomposed "i with dot above"), so
   * an all-caps 'TÜRKİYE' missed its alias entirely until the U+0307 strip.
   */
  it('matches the Turkish dotted capital İ (U+0130)', () => {
    expect(emergencyForName('TÜRKİYE')?.iso).toBe('TR');
    expect(emergencyForName('Türkiye')?.iso).toBe('TR');
  });

  it('matches decomposed (NFD) accents', () => {
    for (const [name, iso] of [['Türkiye', 'TR'], ['España', 'ES'], ['België', 'BE']] as const) {
      expect(emergencyForName(name.normalize('NFD'))?.iso).toBe(iso);
    }
  });
});

describe('emergencyForName — safe failure', () => {
  it('returns null rather than guessing on an unknown name', () => {
    expect(emergencyForName('Atlantis')).toBeNull();
    expect(emergencyForName('')).toBeNull();
    expect(emergencyForName('   ')).toBeNull();
    expect(emergencyForName(null)).toBeNull();
    expect(emergencyForName(undefined)).toBeNull();
  });

  it('every entry resolves to itself by its own name', () => {
    for (const e of EMERGENCY_NUMBERS) {
      expect(emergencyForName(e.name)?.iso).toBe(e.iso);
    }
  });

  /**
   * The exhaustive sweep that would have caught Hong Kong on day one: drive the
   * SUBSTRING path for every country in the directory by prefixing a locality,
   * and assert none of them resolves to a DIFFERENT country. Under the old
   * first-alphabetical-match rule this fails for every name that contains a
   * shorter country name — Hong Kong→China, Papua New Guinea→Guinea,
   * Nigeria→Niger, and so on.
   */
  it('every "Locality, Country" string resolves to the RIGHT country', () => {
    const bad: string[] = [];
    for (const e of EMERGENCY_NUMBERS) {
      const hit = emergencyForName(`Someplace, ${e.name}`);
      if (hit?.iso !== e.iso) {bad.push(`${e.name} -> ${hit?.name ?? 'null'}`);}
    }
    expect(bad).toEqual([]);
  });

  /**
   * Deliberately asserts RIGHT rather than "not wrong". Accepting null let an
   * always-null substring path pass this sweep, so the weaker form pinned
   * nothing about resolution. All 192 currently resolve correctly, so this is
   * free today — and it is a forcing function: a future entry whose name
   * collides ambiguously with an existing one will RED this test until someone
   * adds an alias, which is exactly the moment to think about it.
   */
  it('the sweep demands resolution, not merely the absence of a wrong answer', () => {
    for (const e of EMERGENCY_NUMBERS) {
      expect(emergencyForName(`Someplace, ${e.name}`)).not.toBeNull();
    }
  });

  /**
   * Guards the alias table against a typo: an alias pointing at an ISO the
   * directory does not carry would silently resolve to nothing.
   */
  /**
   * Iterates the REAL table rather than a hand-copied list. A duplicated list
   * only guards the aliases someone remembered to copy across — this repo's
   * documented duplicate-copy bug class, waiting to drift.
   */
  it('every alias resolves to the real directory entry it claims', () => {
    const keys = Object.keys(NAME_ALIASES);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const target = emergencyForIso(NAME_ALIASES[key]);
      expect(target).not.toBeNull();               // no typo'd ISO
      expect(emergencyForName(key)?.iso).toBe(NAME_ALIASES[key]);
    }
  });
});
