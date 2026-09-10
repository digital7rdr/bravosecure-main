/**
 * Contact-discovery phone normalization — first direct coverage.
 *
 * `normalizeBatch` + `regionFromOwnPhone` feed the directory lookup from
 * three live screens; a wrong canonical form here is a silent "contact
 * not on Bravo" miss, so every rule the header comment promises is
 * pinned: IDD `00` → `+`, E.164 length bounds, the single-trunk-zero
 * strip (Audit fix #32), longest-prefix calling-code detection, and
 * batch dedupe. Two sharp edges are DOCUMENTED as current behaviour:
 * an embedded country code double-prefixes (B-154), and an own-phone
 * without `+` yields no region at all.
 */

// @utils/constants reads process.env.EXPO_PUBLIC_* — babel-preset-expo
// rewrites that into an `expo/virtual/env` import the node project cannot
// transform (same class as the pushSlimBgHandler suite flake). Mock the
// one constant this module needs.
jest.mock('@utils/constants', () => ({
  DIAL_CODES: [
    {dial: '+1'},
    {dial: '+44'},
    {dial: '+49'},
    {dial: '+880'},
    {dial: '+91'},
  ],
}), {virtual: true});

import {
  callingCodeFromOwnPhone,
  normalizeBatch,
  normalizeToE164,
  regionFromOwnPhone,
} from '../contacts/phoneNormalize';

describe('normalizeToE164 — international forms', () => {
  it('passes through a formatted international number', () => {
    expect(normalizeToE164('+1 (415) 555-0100')).toBe('+14155550100');
  });

  it('converts the 00 IDD prefix to +', () => {
    expect(normalizeToE164('00 44 20 7946 0958')).toBe('+442079460958');
  });

  it.each([
    ['+123456', 'six digits is below the E.164 floor'],
    ['+1234567890123456', 'sixteen digits is above the E.164 ceiling'],
  ])('rejects %s (%s)', raw => {
    expect(normalizeToE164(raw)).toBeNull();
  });
});

describe('normalizeToE164 — local forms with a default calling code', () => {
  it('prepends the calling code to a plain local number', () => {
    expect(normalizeToE164('415-555-0100', '1')).toBe('+14155550100');
  });

  it('strips EXACTLY ONE trunk zero (Audit fix #32)', () => {
    expect(normalizeToE164('01799-306165', '880')).toBe('+8801799306165');
  });

  it('does not greedily strip a second zero after the trunk prefix', () => {
    // "030…" (Berlin) keeps its second zero: only the trunk 0 goes.
    expect(normalizeToE164('030 901820', '49')).toBe('+4930901820');
  });

  it('a local number without a known region is dropped, not guessed', () => {
    expect(normalizeToE164('415-555-0100')).toBeNull();
  });

  it('a bare trunk zero normalizes to nothing', () => {
    expect(normalizeToE164('0', '880')).toBeNull();
  });

  it('B-154 FIXED: an entry that already embeds the country code is not double-prefixed', () => {
    expect(normalizeToE164('1 (415) 555-0100', '1')).toBe('+14155550100');
    expect(normalizeToE164('8801799306165', '880')).toBe('+8801799306165');
    expect(normalizeToE164('44 20 7946 0958', '44')).toBe('+442079460958');
  });

  it('B-154: a trunk-zero number is ALWAYS prefixed, even if it starts with the code', () => {
    // "07…" under cc 44 must become +447…, never +47…. The trunk zero is
    // what disambiguates local format from an embedded country code.
    expect(normalizeToE164('07700 900123', '44')).toBe('+447700900123');
    expect(normalizeToE164('01799-306165', '880')).toBe('+8801799306165');
  });

  it('B-154: leading digits that merely LOOK like the code are still prefixed', () => {
    // cc '1' with a 7-digit local starting in 1: stripping "1" would leave
    // 6 digits, below the E.164 floor, so it was never a country code.
    expect(normalizeToE164('1234567', '1')).toBe('+11234567');
  });

  it('B-154: a plain local number is unaffected', () => {
    expect(normalizeToE164('415-555-0100', '1')).toBe('+14155550100');
    expect(normalizeToE164('7700900123', '44')).toBe('+447700900123');
  });

  it('B-154: the already-prefixed path still enforces the E.164 bounds', () => {
    // '1' + 7 digits passes; '1' + 16 digits must not sneak through.
    expect(normalizeToE164('1' + '2'.repeat(16), '1')).toBeNull();
  });
});

describe('normalizeToE164 — garbage in', () => {
  it.each([null, undefined, '', '   ', 'no digits here!'])('%p → null', raw => {
    expect(normalizeToE164(raw as string | null | undefined)).toBeNull();
  });
});

describe('callingCodeFromOwnPhone — longest-prefix detection', () => {
  it('multi-digit codes win over their substrings', () => {
    expect(callingCodeFromOwnPhone('+8801799306165')).toBe('880');
  });

  it('detects a 1-digit NANP code', () => {
    expect(callingCodeFromOwnPhone('+14155550100')).toBe('1');
  });

  it('detects a 2-digit code', () => {
    expect(callingCodeFromOwnPhone('+442079460958')).toBe('44');
  });

  it('CONTRACT: the own phone must be E.164 — a bare-digit phone yields no region', () => {
    // Deliberately strict, and NOT changed by B-154. Accepting bare digits
    // would mean guessing a region from an ambiguous string: a local
    // "01799306165" has no country code at all, and picking one wrong
    // silently misroutes EVERY contact lookup for that user. Failing
    // closed (no region ⇒ only "+"-form contacts resolve) is the safer
    // half of that trade. `Me.phone` is normalised at signup.
    expect(callingCodeFromOwnPhone('8801799306165')).toBeUndefined();
  });

  it.each([null, undefined, ''])('%p → undefined', v => {
    expect(callingCodeFromOwnPhone(v as string | null | undefined)).toBeUndefined();
  });

  it('regionFromOwnPhone is a passthrough alias', () => {
    expect(regionFromOwnPhone('+8801799306165')).toBe('880');
  });
});

describe('normalizeBatch — dedupe + silent drops', () => {
  it('collapses different spellings of one number', () => {
    const out = normalizeBatch(['+14155550100', '(415) 555-0100', '415.555.0100'], '1');
    expect(out).toEqual(['+14155550100']);
  });

  it('drops invalid entries without reporting them', () => {
    expect(normalizeBatch(['garbage', null, undefined, '+12'], '1')).toEqual([]);
  });

  it('keeps distinct numbers distinct', () => {
    const out = normalizeBatch(['+14155550100', '+8801799306165'], '1');
    expect(out).toHaveLength(2);
  });
});
