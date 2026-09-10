/**
 * ONE place decides which country the emergency directory pins.
 *
 * ── THE BUG THIS EXISTS TO KILL ──────────────────────────────────────────────
 * The directory used to try: route param → cached geocode → **the phone's
 * LOCALE**. Only the VBG Home door ever supplied the first two, so every other
 * door (the messenger Calls emergency card, the agency shell) landed on the
 * locale — a LANGUAGE setting with no relationship to where the user is. A
 * client standing in Dubai on an "English (United Kingdom)" phone was pinned to
 * the UK and offered 999-for-Britain. A user in Germany on a German phone, and
 * one in Bangladesh on a Bengali phone, were right only by coincidence.
 *
 * ── WHY A VPN CANNOT AFFECT ANY OF THIS ──────────────────────────────────────
 * Every source below is a device-local physical signal — GNSS, the serving cell
 * tower's MCC, the SIM, the locale. **No source is IP-derived**, so a VPN (or
 * Tor, or a proxy) changes nothing. Do NOT "improve" this by adding an
 * IP-geolocation lookup: it is the only mechanism a VPN could poison, and it
 * would reintroduce exactly the class of bug this file closes.
 *
 * ── THE LADDER ───────────────────────────────────────────────────────────────
 * Ordered most-trustworthy first. Each rung is tried in turn and the FIRST one
 * that resolves to a bundled directory entry wins — a rung naming a country the
 * offline directory does not carry (e.g. a territory ISO) falls through rather
 * than pinning nothing.
 *
 *   1. param        caller already geocoded a fix (VBG Home passes this)
 *   2. gps          a live fix reverse-geocoded this visit
 *   3. network      the cell tower the handset is CAMPED ON — current, correct
 *                   while roaming, permission-free. Ranked ABOVE the cache
 *                   because the cache is by definition from the past: it is what
 *                   makes London→Dubai flip to Dubai the moment the phone
 *                   registers, with no GPS and no location permission.
 *   4. fresh cache  a geocoded country persisted in the last hour
 *   5. sim          the SIM's HOME country — a German SIM roaming in Dubai still
 *                   reads DE, so it sits below every current signal, but it is a
 *                   far better prior than a language setting
 *   6. stale cache  somewhere the user demonstrably WAS, beats a language guess
 *   7. locale       last resort, and the UI must say so
 *
 * Rungs 1-3 are physical facts about the PRESENT; 4-7 describe the past or are
 * inference. That split is exposed as `precise`, and the screen labels the card
 * accordingly — B-638 settled that a guess rendered as fact is worse than no
 * country at all, because it hides the guess behind a dialable number.
 */
import {emergencyForIso, emergencyForName, type EmergencyEntry} from './emergencyNumbers';

export type CountrySource =
  | 'param' | 'gps' | 'network' | 'cache' | 'sim' | 'stale-cache' | 'locale';

export interface ResolvedCountry {
  entry:  EmergencyEntry;
  source: CountrySource;
  /** True when the country came from a CURRENT physical signal, not inference. */
  precise: boolean;
}

export interface CountrySignals {
  /** ISO passed by a caller that already geocoded a fix. */
  paramIso?:   string | null;
  /** Free-text country name from the same caller (weaker than its ISO). */
  paramName?:  string | null;
  /**
   * ISO from a live reverse-geocode performed this visit, and the country NAME
   * from the same response. Both, because `/vbg/geocode` genuinely returns
   * `country: null` with a usable context string — and throwing the name away
   * there drops a LIVE location answer straight through to the locale guess.
   */
  gpsIso?:     string | null;
  gpsName?:    string | null;
  /** ISO of the serving mobile network (cell-tower MCC). */
  networkIso?: string | null;
  /** ISO of the SIM's home country. */
  simIso?:     string | null;
  /** Persisted geocoded country, and when it was written (epoch ms). */
  cachedIso?:  string | null;
  cachedName?: string | null;
  cachedAt?:   number | null;
  /** ISO derived from the device locale — a language setting, never a location. */
  localeIso?:  string | null;
  /** Injectable for tests; defaults to Date.now(). */
  now?:        number;
}

/**
 * A cached geocode older than this stops outranking the SIM's home country.
 *
 * Deliberately SHORTER than a long-haul flight, not longer: the traveller who
 * lands in Dubai with a London cache must have it expire BEFORE they arrive,
 * not after. An hour also bounds how wrong the card can be for someone who was
 * moving when it was written.
 */
export const CACHE_FRESH_MS = 60 * 60 * 1000;

/**
 * Sources that are a CURRENT physical reading rather than inference.
 *
 * The cache is NOT one of them however fresh it is — it describes where the
 * user WAS. Rendering a remembered country under a confident "Your Location"
 * is how an airplane-mode arrival gets told, in green, that it is still in the
 * country it left.
 */
const PRECISE: ReadonlySet<CountrySource> = new Set<CountrySource>(['param', 'gps', 'network']);

/**
 * Pure: given every signal, return the winning entry — or null when not one of
 * them names a country the bundled directory carries.
 */
export function pickEmergencyCountry(s: CountrySignals): ResolvedCountry | null {
  const at = s.cachedAt ?? null;
  const now = s.now ?? Date.now();
  // An absent timestamp means the value predates timestamping — treat it as
  // stale rather than trusting an unknown age.
  const cacheFresh = at !== null && Number.isFinite(at) && now - at <= CACHE_FRESH_MS && now >= at;

  const ladder: Array<[CountrySource, EmergencyEntry | null]> = [
    ['param',       emergencyForIso(s.paramIso) ?? emergencyForName(s.paramName)],
    ['gps',         emergencyForIso(s.gpsIso) ?? emergencyForName(s.gpsName)],
    ['network',     emergencyForIso(s.networkIso)],
    ['cache',       cacheFresh ? (emergencyForIso(s.cachedIso) ?? emergencyForName(s.cachedName)) : null],
    ['sim',         emergencyForIso(s.simIso)],
    ['stale-cache', cacheFresh ? null : (emergencyForIso(s.cachedIso) ?? emergencyForName(s.cachedName))],
    ['locale',      emergencyForIso(s.localeIso)],
  ];

  for (const [source, entry] of ladder) {
    if (entry) {return {entry, source, precise: PRECISE.has(source)};}
  }
  return null;
}

/**
 * The country name out of a `/vbg/geocode` context ("Deira, Dubai, United Arab
 * Emirates" → "United Arab Emirates"). One copy, because both callers of that
 * endpoint need it and a drifted second copy is this repo's documented
 * duplicate-copy bug class.
 */
export function countryNameFromContext(context: string | null | undefined): string | null {
  const parts = (context ?? '').split(',').map(p => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/** Caption for the pinned card — states HOW the country was determined. */
export function sourceLabel(source: CountrySource): string {
  switch (source) {
    case 'param':
    case 'gps':         return 'Your location';
    case 'network':     return 'Your mobile network';
    case 'cache':       return 'Your last known location — confirm before dialling';
    case 'sim':         return 'Your SIM card — confirm before dialling';
    case 'stale-cache': return 'Where you were last seen — confirm before dialling';
    case 'locale':      return 'Estimated from phone settings — confirm before dialling';
  }
}
