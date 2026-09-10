/**
 * Canonical supported-region list — the SINGLE source of truth for `region_code`
 * across dispatch matching, agency profile, booking, and compliance.
 *
 * Previously forked 5 ways (constants.ts / booking.service / agent.service /
 * OrgComplianceScreen / ZoneMapScreen), which let a 'ZA' actor be SILENTLY
 * un-rankable (constants had ZA; the dispatch allow-list didn't). Add a region
 * HERE and re-export — never re-declare a region list elsewhere.
 *
 * ZA (South Africa) is supported per the 2026-06-25 product decision. Its ZAR
 * currency + FX rate are config values gated SEPARATELY from region matching:
 * a 'ZA' agency/booking dispatches fine on region alone; ZAR pricing/escrow is a
 * finance-signed follow-up.
 */
export interface RegionDef {
  code: string;
  name: string;
  currency: string;
  /** LM-M2 — standard UTC offset (hours) for local-wall-clock rules like the
   *  peak-pricing window. Deliberately DST-naive: an hour of drift twice a year
   *  in GB beats the old behaviour (peak evaluated in raw UTC everywhere). */
  utcOffsetHours: number;
  /**
   * B-93 — PRODUCT launch flag: is this region OPEN for client bookings?
   * Availability used to be derived from `cpo_pool` counts, which kept a
   * launched-but-not-yet-staffed region (ZA) stuck on "COMING SOON" and
   * would flash a live region "unavailable" if its pool ever hit zero.
   * Launched-with-no-supply bookings still work: the ops-review path is
   * handled manually and auto-dispatch degrades to NO_PROVIDER.
   */
  launched: boolean;
}

export const REGIONS: ReadonlyArray<RegionDef> = [
  {code: 'AE', name: 'UAE — Dubai, Abu Dhabi, Sharjah',         currency: 'AED', utcOffsetHours: 4, launched: true},
  {code: 'SA', name: 'Saudi Arabia — Riyadh, Jeddah',           currency: 'SAR', utcOffsetHours: 3, launched: false},
  {code: 'BD', name: 'Bangladesh — Dhaka Division',             currency: 'BDT', utcOffsetHours: 6, launched: true},
  {code: 'GB', name: 'United Kingdom — London',                 currency: 'GBP', utcOffsetHours: 0, launched: false},
  {code: 'ZA', name: 'South Africa — Johannesburg, Cape Town',  currency: 'ZAR', utcOffsetHours: 2, launched: true},
];

/** UTC offset for a region code (0 when unknown — falls back to UTC). */
export function regionUtcOffsetHours(code: string | null | undefined): number {
  const r = REGIONS.find(x => x.code === (code ?? '').trim().toUpperCase());
  return r?.utcOffsetHours ?? 0;
}

/** Region codes a dispatchable actor (agency / booking) may carry. */
export const SUPPORTED_REGION_CODES: ReadonlyArray<string> = REGIONS.map(r => r.code);

/** Sentinel for a person outside every supported region. Never dispatchable. */
export const REGION_NA = 'N/A';

/** ISO-3166 alpha-2 country → region_code, for reverse-geocode region detection. */
export const COUNTRY_TO_REGION: Record<string, string> = {
  AE: 'AE', SA: 'SA', BD: 'BD', GB: 'GB', ZA: 'ZA',
};

/** Map a reverse-geocoded country code to a region, or N/A if outside coverage. */
export function regionFromCountry(iso2: string | null | undefined): string {
  if (!iso2) {return REGION_NA;}
  return COUNTRY_TO_REGION[iso2.trim().toUpperCase()] ?? REGION_NA;
}

export function isSupportedRegion(code: string | null | undefined): boolean {
  return !!code && SUPPORTED_REGION_CODES.includes(code.trim().toUpperCase());
}
