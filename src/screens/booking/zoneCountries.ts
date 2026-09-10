/**
 * Country list composition for the booking zone screen (founder spec
 * 2026-08-01): all 195 countries are listed, but only ACTIVE_ZONE_CODES are
 * selectable — everything else reads "Coming Soon". The user's
 * current-location country is ALWAYS displayed on top (active or not); the
 * rest live inside two collapsed dropdowns (Active / Coming Soon).
 */
import {NEWS_COUNTRIES} from '@/modules/news/newsPrefs';

export interface ZoneCountry {
  code:   string;   // ISO2
  label:  string;
  active: boolean;
}

/** Founder 2026-08-01 — only UAE and South Africa are selectable zones. */
export const ACTIVE_ZONE_CODES: readonly string[] = ['AE', 'ZA'];

/**
 * Compose the three display groups from the canonical 195-country list
 * (NEWS_COUNTRIES minus GLOBAL, already alphabetical):
 *  - `current`: the user's located country, or null when unknown;
 *  - `active`:  selectable countries EXCLUDING current, alphabetical;
 *  - `soon`:    every other country EXCLUDING current, alphabetical.
 */
export function composeZoneCountries(myCountry: string | null | undefined): {
  current: ZoneCountry | null;
  active:  ZoneCountry[];
  soon:    ZoneCountry[];
} {
  const mine = (myCountry ?? '').trim().toUpperCase();
  const all: ZoneCountry[] = NEWS_COUNTRIES
    .filter(c => c.code !== 'GLOBAL')
    .map(c => ({code: c.code, label: c.label, active: ACTIVE_ZONE_CODES.includes(c.code)}));

  const current = mine ? all.find(c => c.code === mine) ?? null : null;
  return {
    current,
    active: all.filter(c => c.active && c.code !== mine),
    soon:   all.filter(c => !c.active && c.code !== mine),
  };
}
