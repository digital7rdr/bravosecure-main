/**
 * Minimal phone-number normalization for contact discovery.
 *
 * This is NOT a full libphonenumber replacement — it covers the 95%
 * case that matters for directory lookup:
 *
 *   1. "+1 (415) 555-0100"    → "+14155550100"     (already international)
 *   2. "00 44 20 7946 0958"   → "+442079460958"    (IDD prefix)
 *   3. "415-555-0100" + US    → "+14155550100"     (local, uses default region)
 *   4. anything else          → null
 *
 * The default region comes from the signed-in user's own E.164 phone —
 * their country prefix is stripped off and used to prepend local-format
 * numbers in their contacts. This is approximate (country code `1`
 * covers US + Canada + a dozen Caribbean territories) but is good
 * enough for a phone-match directory lookup: we're matching digits
 * against what the server stored when the peer registered, and the
 * peer also normalized their own phone to E.164 at signup time.
 *
 * We deliberately reject numbers too short (<7 digits) or too long
 * (>15 digits) per the E.164 spec — those are usually garbage entries.
 */

import {DIAL_CODES} from '@utils/constants';

/** ISO-ish hint the app carries around; only used for documentation. */
export type CountryCode = string;

const E164_RE = /^\+(\d{7,15})$/;

/** Known calling codes, sorted longest-first so "880" wins over "88" or "8". */
const KNOWN_CALLING_CODES: readonly string[] = (() => {
  const set = new Set(DIAL_CODES.map(c => c.dial.replace(/^\+/, '')));
  return Array.from(set).sort((a, b) => b.length - a.length);
})();

export function normalizeToE164(
  raw: string | null | undefined,
  defaultCallingCode?: string,
): string | null {
  if (!raw) {return null;}
  const trimmed = raw.trim();
  if (trimmed.length === 0) {return null;}

  // "00…" is the international dialing prefix used in most of the
  // world outside of North America — convert to "+" before stripping.
  const withPlus = trimmed.replace(/^00/, '+');

  // Extract the leading "+" (if any) before stripping everything else.
  const hasPlus = withPlus.startsWith('+');
  const digits  = withPlus.replace(/[^\d]/g, '');
  if (digits.length === 0) {return null;}

  if (hasPlus) {
    const candidate = `+${digits}`;
    return E164_RE.test(candidate) ? candidate : null;
  }

  // No "+" — treat as a local number in the default region. Prepend
  // the caller's country calling code if we have one; otherwise skip.
  if (!defaultCallingCode) {return null;}
  // Audit fix #32 — strip EXACTLY ONE leading zero, not all leading
  // zeros. The trunk-prefix convention is universal: Bangladesh
  // "01799…", UK "07…", Germany "030…" — all use ONE 0. A number
  // like "00xxxx" is not a trunk-prefixed local number; the leading
  // 00 already meant "international dialing prefix" (handled at the
  // top of this function via `replace(/^00/, '+')`). Greedy `^0+`
  // mangled legitimate numbers that happened to have multiple zeros
  // after the trunk strip (rare, but observed in synthetic test data
  // and caused match misses).
  // B-154 — a trunk zero is a strong "this is local format" signal, so a
  // number that had one is ALWAYS prefixed. Its absence is what lets the
  // already-prefixed check below run without misreading e.g. UK "07…".
  const hadTrunkZero = /^0/.test(digits);
  const local = digits.replace(/^0/, '');
  if (local.length === 0) {return null;}

  // B-154 — a contact saved WITHOUT "+" but WITH the country code
  // ("1 415 555 0100", "8801799306165") is extremely common, and blindly
  // prepending produced "+114155550100" / "+8808801799306165": a
  // valid-LOOKING E.164 that matches nothing, so the peer silently never
  // appeared as "on Bravo". Treat the code as already present when the
  // remainder is still a plausible subscriber number (>= 7 digits) — the
  // same floor E164_RE enforces. When the remainder is too short the
  // leading digits really were part of the local number, so we fall
  // through and prefix as before.
  if (!hadTrunkZero && local.startsWith(defaultCallingCode)) {
    const remainder = local.slice(defaultCallingCode.length);
    if (remainder.length >= 7) {
      const already = `+${local}`;
      return E164_RE.test(already) ? already : null;
    }
  }

  const candidate = `+${defaultCallingCode}${local}`;
  return E164_RE.test(candidate) ? candidate : null;
}

/**
 * Pull the country calling code (digits only) off the user's own
 * E.164 phone. Best-effort: looks for the 1–3 digit prefix that
 * matches a known country. Defaults to treating everything after "+"
 * up to the last 10 chars as the country prefix, which covers every
 * real-world code.
 */
export function callingCodeFromOwnPhone(phoneE164: string | null | undefined): string | undefined {
  if (!phoneE164) {return undefined;}
  const m = /^\+(\d{1,4})/.exec(phoneE164);
  if (!m) {return undefined;}
  const all = phoneE164.slice(1);       // strip leading "+"
  // Longest-prefix match against KNOWN_CALLING_CODES so multi-digit codes
  // win over their substrings: "+8801799306165" → "880" (Bangladesh), not
  // "8" or "88". Without this, every BD/UK/IN/SA/etc number would default
  // to a 1-digit code and break local-format contact normalization.
  for (const code of KNOWN_CALLING_CODES) {
    if (all.startsWith(code) && all.length - code.length >= 7) {
      return code;
    }
  }
  // Fallback for codes not in DIAL_CODES — pick the shortest prefix that
  // leaves a plausible 7+ digit local number.
  for (const n of [1, 2, 3]) {
    const tail = all.slice(n);
    if (tail.length >= 7) {return all.slice(0, n);}
  }
  return m[1];
}

/**
 * Back-compat alias for call sites that still refer to the ISO-region
 * concept. We now work in country-calling-codes, so this is just a
 * thin wrapper.
 */
export function regionFromOwnPhone(phoneE164: string | null | undefined): string | undefined {
  return callingCodeFromOwnPhone(phoneE164);
}

/**
 * Normalize + dedupe a batch of raw device-contact phones into E.164.
 * Drops invalid entries silently — the UI layer reports "N contacts,
 * M on Bravo" off the resulting count, not per-entry errors.
 */
export function normalizeBatch(
  raw: Array<string | null | undefined>,
  defaultCallingCode?: string,
): string[] {
  const out = new Set<string>();
  for (const r of raw) {
    const n = normalizeToE164(r, defaultCallingCode);
    if (n) {out.add(n);}
  }
  return Array.from(out);
}
