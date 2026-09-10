/**
 * Mobile mirror of the auth-service canonical region list
 * (`apps/auth-service/src/common/regions.ts`) — the SINGLE mobile source of
 * truth for `region_code`. A service provider's dispatch region (`agents.region_code`)
 * and a booking's `region_code` must both come from this list, or the auto-dispatch
 * ranking (which hard-filters `a.region_code = booking.region_code`) silently drops
 * the actor. Keep in sync with the server list when a region is added.
 *
 * Also provides GPS → region detection (used by the Region setting screen to
 * default-assign and to guard region changes): map a reverse-geocoded ISO-3166 country
 * to a region, with an offline bounding-box fallback. This module is pure — the Mapbox
 * reverse-geocode (env + network) lives in `screens/deptchat/geo.ts`.
 */
import {alpha3} from '@utils/countryCodes';

export interface RegionDef {
  code: string;
  name: string;
  currency: string;
  /**
   * B-90 T-07 — 3-letter DISPLAY badge. Never a dispatch key.
   *
   * DERIVED from `code`, not typed by hand. It used to be a literal, and Issue
   * 37 is what that costs: the contract said "RSA" while the data said "SA",
   * so South Africa rendered Saudi Arabia's dispatch code on screen and no
   * check could see it. Deriving makes that class impossible.
   */
  badge: string;
  /** Flag emoji for region chips (home header, zone picker). */
  flag: string;
}

/**
 * Founder rule 2026-08-08 — every country abbreviation the user sees is ISO
 * 3166-1 alpha-3. That RETIRES the colloquial badges this list used to carry:
 * UAE → ARE, KSA → SAU, RSA → ZAF (BGD and GBR were already alpha-3). `code`
 * is untouched and stays alpha-2 — it is the dispatch/pricing key and the
 * server's `region_code`.
 */
export const REGIONS: ReadonlyArray<RegionDef> = (
  [
    {code: 'AE', name: 'United Arab Emirates', currency: 'AED', flag: '🇦🇪'},
    {code: 'SA', name: 'Saudi Arabia', currency: 'SAR', flag: '🇸🇦'},
    {code: 'BD', name: 'Bangladesh', currency: 'BDT', flag: '🇧🇩'},
    {code: 'GB', name: 'United Kingdom', currency: 'GBP', flag: '🇬🇧'},
    {code: 'ZA', name: 'South Africa', currency: 'ZAR', flag: '🇿🇦'},
  ] as ReadonlyArray<Omit<RegionDef, 'badge'>>
).map(r => ({...r, badge: alpha3(r.code)}));

/**
 * Pilot cities per region, shown as the sub-line on region pickers. Kept beside
 * REGIONS so a new region cannot be added without deciding where it operates.
 * Mirrors `modules/booking/coverageZones.ts` (the geofences clients are tested
 * against) — if you add a zone there, add its city here.
 */
const REGION_CITIES: Readonly<Record<string, string>> = {
  AE: 'Dubai · Abu Dhabi · Sharjah',
  SA: 'Riyadh · Jeddah',
  BD: 'Dhaka Division',
  GB: 'London · Manchester',
  ZA: 'Johannesburg · Cape Town',
};

/** A selectable coverage region for the provider onboarding picker. */
export interface CoverageRegionRow {
  code: string;
  name: string;
  badge: string;
  cities: string;
  /** Providers opt IN — never pre-claim coverage a provider cannot serve. */
  on: boolean;
}

/**
 * Issue 37 — the provider coverage picker's rows, DERIVED from the canonical
 * region list. AgentCoverageScreen used to hard-code its own array, which
 * drifted: South Africa (the pilot region) was missing and USA was offered even
 * though it is not a dispatch region. Deriving makes that class of drift
 * impossible; adding a region to REGIONS now adds it to onboarding.
 */
export function coverageRegionRows(): CoverageRegionRow[] {
  return REGIONS.map(r => ({
    code: r.code,
    name: r.name,
    badge: r.badge,
    cities: REGION_CITIES[r.code] ?? r.name,
    on: false,
  }));
}

/** Region row for a code (case-insensitive), or undefined when unsupported. */
export function regionDef(code: string | null | undefined): RegionDef | undefined {
  if (!code) {return undefined;}
  const c = code.trim().toUpperCase();
  return REGIONS.find(r => r.code === c);
}

export const SUPPORTED_REGION_CODES: ReadonlyArray<string> = REGIONS.map(r => r.code);

/** Sentinel for a fix outside every supported region. Never dispatchable. */
export const REGION_NA = 'N/A';

/** ISO-3166 alpha-2 country → region_code (matches the server `COUNTRY_TO_REGION`). */
export const COUNTRY_TO_REGION: Record<string, string> = {
  AE: 'AE', SA: 'SA', BD: 'BD', GB: 'GB', ZA: 'ZA',
};

export function regionFromCountry(iso2: string | null | undefined): string {
  if (!iso2) {return REGION_NA;}
  return COUNTRY_TO_REGION[iso2.trim().toUpperCase()] ?? REGION_NA;
}

export function isSupportedRegion(code: string | null | undefined): boolean {
  return !!code && SUPPORTED_REGION_CODES.includes(code.trim().toUpperCase());
}

export function regionName(code: string | null | undefined): string {
  if (!code) {return '—';}
  const c = code.trim().toUpperCase();
  return REGIONS.find(r => r.code === c)?.name ?? c;
}

/**
 * Approximate per-country bounding boxes [minLat, maxLat, minLng, maxLng], used
 * ONLY as an offline fallback when reverse-geocoding is unavailable. Checked
 * smallest/most-specific first so an AE fix (whose box sits inside Saudi's
 * longitude range) resolves to AE, never SA.
 */
const REGION_BBOX: ReadonlyArray<{code: string; box: [number, number, number, number]}> = [
  {code: 'AE', box: [22.5, 26.5, 51.0, 56.6]},
  {code: 'BD', box: [20.5, 26.7, 88.0, 92.8]},
  {code: 'GB', box: [49.8, 61.1, -8.7, 1.9]},
  {code: 'ZA', box: [-35.1, -22.0, 16.3, 33.1]},
  {code: 'SA', box: [16.0, 32.6, 34.4, 55.7]},
];

/** Region a fix falls in by bounding box (offline fallback), or N/A if outside coverage. */
export function regionFromBBox(lat: number, lng: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {return REGION_NA;}
  for (const {code, box} of REGION_BBOX) {
    if (lat >= box[0] && lat <= box[1] && lng >= box[2] && lng <= box[3]) {return code;}
  }
  return REGION_NA;
}

export type RegionDetection = {region: string; country: string | null; source: 'geocode' | 'bbox'};

/**
 * Resolve the region for a fix, given an optionally reverse-geocoded ISO country
 * (accurate at the AE/SA border). When the country is unknown (geocode unavailable)
 * fall back to bounding boxes so a momentary network blip never blocks detection.
 * `region` is `N/A` when the fix is outside every supported region.
 */
export function detectRegion(iso2: string | null | undefined, lat: number, lng: number): RegionDetection {
  if (iso2) {
    return {region: regionFromCountry(iso2), country: iso2.trim().toUpperCase(), source: 'geocode'};
  }
  return {region: regionFromBBox(lat, lng), country: null, source: 'bbox'};
}
