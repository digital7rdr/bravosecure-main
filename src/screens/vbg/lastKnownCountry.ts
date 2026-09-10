/**
 * Founder 2026-08-24 — "location wise, the first bar will be that country."
 *
 * The emergency directory pins a "YOUR LOCATION" country card, but only the
 * VBG-Home entry point could pass a geocoded country; every other door (the
 * messenger Calls banner, agent shell) fell back to the phone's LOCALE — a
 * language guess, not a location. VBG Home already reverse-geocodes on every
 * visit, so its result is persisted here and any later param-less open of the
 * directory reuses it: last-KNOWN location beats language.
 *
 * Best-effort on purpose: a missing/failed cache degrades to the locale
 * fallback the screen already had. Stores ONLY an ISO code + country name —
 * never coordinates (this file must stay out of the location-privacy blast
 * radius).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'bravo:vbg:last-geo-country';

export interface LastKnownCountry {
  iso: string | null;
  name: string | null;
  /**
   * When this geocode was written (epoch ms), or null for a value persisted
   * before timestamping existed. The resolver needs the AGE: a country from six
   * months ago must not outrank the SIM's home country, and a value of unknown
   * age is treated as stale rather than trusted.
   */
  at: number | null;
}

let cache: LastKnownCountry | null = null;

/**
 * Records ONE observation of where the user is. The write is ATOMIC — a new
 * observation replaces both fields together.
 *
 * Why not merge field-by-field (`next.iso ?? cache?.iso`): both callers derive
 * the ISO and the name from the SAME geocode response, so a half-populated
 * write means Mapbox returned a place with no country short_code — not that the
 * caller knows only half. Merging then pairs a STALE iso with the FRESH name of
 * a different country and stamps the pair as newly observed: a principal who
 * geocoded in London and later opened the directory in Dubai would cache
 * {iso: 'GB', name: 'United Arab Emirates'}, and the resolver — which reads the
 * ISO first — would pin the UNITED KINGDOM. That is the original defect,
 * resurrected through the cache it was supposed to fix.
 */
export async function setLastKnownCountry(next: {iso?: string | null; name?: string | null}): Promise<void> {
  const merged: LastKnownCountry = {
    iso: next.iso ?? null,
    name: next.name ?? null,
    at: Date.now(),
  };
  cache = merged;
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(merged));
  } catch { /* best-effort — the in-memory copy still serves this session */ }
}

export async function getLastKnownCountry(): Promise<LastKnownCountry> {
  if (cache) {return cache;}
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LastKnownCountry>;
      cache = {
        iso: parsed.iso ?? null,
        name: parsed.name ?? null,
        at: typeof parsed.at === 'number' ? parsed.at : null,
      };
      return cache;
    }
  } catch { /* fall through to empty */ }
  return {iso: null, name: null, at: null};
}

/** Test seam. */
export function _resetLastKnownCountryForTests(): void {
  cache = null;
}
