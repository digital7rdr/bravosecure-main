/**
 * Contact search for the New Message screen.
 *
 * The search bar there was previously a decorative `<Text>` placeholder —
 * it looked like an input but had no state and filtered nothing, so
 * typing did nothing and users with long contact lists had no way to
 * find anyone. These are the pure matching rules behind the real input.
 *
 * Matching is deliberately forgiving, because the two things a user
 * types are a name fragment and a phone number they remember in a
 * different format than it is stored:
 *   • name  — case/diacritic-insensitive substring, matched against the
 *             local address-book name AND the Bravo display name (they
 *             differ often: "Mum" locally vs "Jane Doe" on Bravo).
 *   • phone — compared digits-only, so "0552 676140", "552676140" and
 *             "+971552676140" all match the stored "+971552676140".
 *             A leading national 0 is dropped so a locally-formatted
 *             number matches its E.164 form.
 */

export interface SearchableContact {
  /** Address-book name, when known. */
  localName?:   string;
  /** Bravo profile name, when known. */
  displayName?: string;
  /** Dev-contact name field. */
  name?:        string;
  phoneE164:    string;
}

/** Lowercase + strip accents so "josé" matches "Jose". */
function foldCase(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // strip combining diacritics
    .toLowerCase()
    .trim();
}

/** Digits only, with a leading national trunk '0' removed. */
function digitsOf(s: string): string {
  const d = s.replace(/\D+/g, '');
  return d.replace(/^0+/, '');
}

/** True when the query is (mostly) a number the user is dialling from memory. */
function looksNumeric(q: string): boolean {
  return /\d/.test(q) && !/[a-z]/i.test(q);
}

/**
 * Does this contact match the query? An empty/whitespace query matches
 * everything, so callers can pass the raw input straight through.
 */
export function contactMatchesQuery(c: SearchableContact, rawQuery: string): boolean {
  const q = rawQuery.trim();
  if (!q) {return true;}
  // Punctuation only ("+", "()", "-") carries no signal — the user is
  // mid-way through typing a number. Showing everything is right; showing
  // nothing looks like the search is broken.
  if (!/[\p{L}\p{N}]/u.test(q)) {return true;}

  if (looksNumeric(q)) {
    const needle = digitsOf(q);
    // A bare '0' or '+' carries no signal — treat as "show everything"
    // rather than matching nothing while the user is still typing.
    if (!needle) {return true;}
    return digitsOf(c.phoneE164).includes(needle);
  }

  const folded = foldCase(q);
  const names = [c.localName, c.displayName, c.name];
  if (names.some(n => n && foldCase(n).includes(folded))) {return true;}
  // A query with both letters and digits (e.g. "baine 552") still gets a
  // shot at the number, using only its digit part.
  const needle = digitsOf(q);
  return needle.length > 0 && digitsOf(c.phoneE164).includes(needle);
}

/** Filter helper — preserves input order and never mutates the source. */
export function filterContacts<T extends SearchableContact>(rows: readonly T[], rawQuery: string): T[] {
  const q = rawQuery.trim();
  if (!q) {return rows.slice();}
  return rows.filter(r => contactMatchesQuery(r, q));
}
