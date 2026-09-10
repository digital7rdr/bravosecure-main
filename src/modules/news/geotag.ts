/**
 * Rough country-name → lat/lng geotagger.
 *
 * The Guardian feed doesn't carry coordinates, only a `sectionName` and
 * free-text headline. To place a marker on the Intel map we scan the
 * headline for a country / region name and look up its capital. Coarse
 * but deterministic — good enough for a "where in the world" glance.
 *
 * When nothing matches we pick a pseudo-random position within the
 * MENA/Europe/Asia band so the map never looks half-empty.
 */

import {NEWS_COUNTRIES, countryLabel} from './newsPrefs';

export interface GeoHit {
  lng:    number;
  lat:    number;
  label:  string;
}

const GEO: Array<{names: string[]; lng: number; lat: number; label: string; iso?: string}> = [
  // Core MENA / GCC
  {names: ['UAE', 'United Arab Emirates', 'Dubai', 'Abu Dhabi', 'DIFC'], lng: 55.27, lat: 25.20, label: 'UAE', iso: 'AE'},
  {names: ['Saudi', 'Riyadh', 'Jeddah'],     lng: 46.68, lat: 24.71, label: 'KSA', iso: 'SA'},
  {names: ['Qatar', 'Doha'],                 lng: 51.53, lat: 25.29, label: 'QATAR', iso: 'QA'},
  {names: ['Oman', 'Muscat'],                lng: 58.54, lat: 23.59, label: 'OMAN', iso: 'OM'},
  {names: ['Kuwait'],                        lng: 47.98, lat: 29.38, label: 'KUWAIT', iso: 'KW'},
  {names: ['Bahrain', 'Manama'],             lng: 50.59, lat: 26.23, label: 'BAHRAIN', iso: 'BH'},
  {names: ['Iraq', 'Baghdad'],               lng: 44.36, lat: 33.31, label: 'IRAQ', iso: 'IQ'},
  {names: ['Iran', 'Tehran'],                lng: 51.39, lat: 35.69, label: 'IRAN', iso: 'IR'},
  {names: ['Israel', 'Tel Aviv', 'Jerusalem'], lng: 34.78, lat: 32.08, label: 'ISRAEL', iso: 'IL'},
  {names: ['Gaza', 'Palestine', 'West Bank'], lng: 34.47, lat: 31.50, label: 'GAZA', iso: 'PS'},
  {names: ['Lebanon', 'Beirut'],             lng: 35.50, lat: 33.89, label: 'LEBANON', iso: 'LB'},
  {names: ['Syria', 'Damascus'],             lng: 36.29, lat: 33.51, label: 'SYRIA', iso: 'SY'},
  {names: ['Jordan', 'Amman'],               lng: 35.93, lat: 31.95, label: 'JORDAN', iso: 'JO'},
  {names: ['Yemen', 'Sanaa'],                lng: 44.19, lat: 15.36, label: 'YEMEN', iso: 'YE'},
  {names: ['Egypt', 'Cairo'],                lng: 31.23, lat: 30.04, label: 'EGYPT', iso: 'EG'},
  {names: ['Turkey', 'Ankara', 'Istanbul'],  lng: 28.98, lat: 41.01, label: 'TURKEY', iso: 'TR'},

  // Europe
  {names: ['UK', 'Britain', 'United Kingdom', 'London', 'England'], lng: -0.13, lat: 51.51, label: 'UK', iso: 'GB'},
  {names: ['France', 'Paris'],               lng:  2.35, lat: 48.86, label: 'FRANCE', iso: 'FR'},
  {names: ['Germany', 'Berlin'],             lng: 13.41, lat: 52.52, label: 'GERMANY', iso: 'DE'},
  {names: ['Italy', 'Rome'],                 lng: 12.50, lat: 41.90, label: 'ITALY', iso: 'IT'},
  {names: ['Spain', 'Madrid'],               lng: -3.70, lat: 40.42, label: 'SPAIN', iso: 'ES'},
  {names: ['Russia', 'Moscow'],              lng: 37.62, lat: 55.76, label: 'RUSSIA', iso: 'RU'},
  {names: ['Ukraine', 'Kyiv', 'Kiev'],       lng: 30.52, lat: 50.45, label: 'UKRAINE', iso: 'UA'},

  // Asia-Pacific
  {names: ['China', 'Beijing', 'Shanghai'],  lng: 116.40, lat: 39.90, label: 'CHINA', iso: 'CN'},
  {names: ['Japan', 'Tokyo'],                lng: 139.69, lat: 35.69, label: 'JAPAN', iso: 'JP'},
  {names: ['Korea', 'Seoul'],                lng: 126.98, lat: 37.57, label: 'KOREA', iso: 'KR'},
  {names: ['India', 'Delhi', 'Mumbai'],      lng: 77.21, lat: 28.61, label: 'INDIA', iso: 'IN'},
  {names: ['Pakistan', 'Islamabad'],         lng: 73.05, lat: 33.68, label: 'PAKISTAN', iso: 'PK'},
  {names: ['Bangladesh', 'Dhaka'],           lng: 90.41, lat: 23.81, label: 'BANGLADESH', iso: 'BD'},
  {names: ['Afghanistan', 'Kabul'],          lng: 69.21, lat: 34.53, label: 'AFGHANISTAN', iso: 'AF'},
  {names: ['Singapore'],                     lng: 103.82, lat: 1.35, label: 'SINGAPORE', iso: 'SG'},
  {names: ['Hong Kong'],                     lng: 114.17, lat: 22.28, label: 'HK', iso: 'HK'},

  // Americas + Africa
  {names: ['US', 'USA', 'United States', 'Washington', 'New York'], lng: -74.00, lat: 40.71, label: 'USA', iso: 'US'},
  {names: ['Canada', 'Toronto', 'Ottawa'],   lng: -79.38, lat: 43.65, label: 'CANADA', iso: 'CA'},
  {names: ['Mexico'],                        lng: -99.13, lat: 19.43, label: 'MEXICO', iso: 'MX'},
  {names: ['Brazil', 'São Paulo', 'Sao Paulo'], lng: -46.63, lat: -23.55, label: 'BRAZIL', iso: 'BR'},
  {names: ['Argentina', 'Buenos Aires'],     lng: -58.38, lat: -34.60, label: 'ARGENTINA', iso: 'AR'},
  {names: ['Nigeria', 'Lagos'],              lng:   3.38, lat:  6.52, label: 'NIGERIA', iso: 'NG'},
  {names: ['South Africa', 'Johannesburg', 'Cape Town'], lng: 28.05, lat: -26.20, label: 'SOUTH AFRICA', iso: 'ZA'},
  {names: ['Kenya', 'Nairobi'],              lng: 36.82, lat: -1.29, label: 'KENYA', iso: 'KE'},
  {names: ['Australia', 'Sydney', 'Melbourne'], lng: 151.21, lat: -33.87, label: 'AUSTRALIA', iso: 'AU'},
];

function wordRe(name: string): RegExp {
  return new RegExp(`\\b${name.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
}

/**
 * B-656 — the GEO table's matchers, PRECOMPILED once at module load.
 *
 * `geotag()` used to call `wordRe(name)` inside a nested loop, constructing and
 * discarding a fresh `RegExp` for every candidate name on every call — 98 of
 * them across the 41 rows in the worst case, once per un-geotagged wire item,
 * inside a synchronous `.map` over the whole feed.
 *
 * One alternation per row replaces up to 5 constructions + 5 tests with zero
 * constructions and one test. Note this is the same treatment `COUNTRY_MATCHERS`
 * below already had — the JSDoc there saying "precompiled once at module load"
 * was correctly scoped to that table and never claimed to cover this loop.
 *
 * Alternation preserves the original semantics exactly: the inner loop
 * short-circuited on the FIRST matching name and returned the row, and a single
 * regex OR-ing the same escaped, `\b`-anchored names matches precisely when at
 * least one of them would have.
 */
const GEO_MATCHERS: {re: RegExp; row: (typeof GEO)[number]}[] = GEO.map(row => ({
  re: new RegExp(
    row.names
      .map(n => `\\b${n.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
      .join('|'),
  ),
  row,
}));

/** Common headline forms that differ from the registry label. */
const NAME_ALIASES: Record<string, string> = {
  'HOLLAND': 'NL', 'CZECHIA': 'CZ', 'BURMA': 'MM', "COTE D'IVOIRE": 'CI',
  'DRC': 'CD', 'THE GAMBIA': 'GM', 'EAST TIMOR': 'TL', 'CABO VERDE': 'CV',
  'MACEDONIA': 'MK', 'SWAZILAND': 'SZ',
};

/**
 * Generated fallback: EVERY selectable country's name (plus aliases) → its
 * capital pin. Without this, a Global feed clustered on Europe/MENA — the
 * only places the hand-curated GEO table above knows (founder/Corné report,
 * 2026-07-31). Regexes precompiled once at module load.
 */
const COUNTRY_MATCHERS: Array<{re: RegExp; code: string; label: string}> = (() => {
  const out: Array<{re: RegExp; code: string; label: string}> = [];
  for (const c of NEWS_COUNTRIES) {
    if (c.code === 'GLOBAL') {continue;}
    out.push({re: wordRe(c.label), code: c.code, label: c.label});
  }
  for (const [alias, code] of Object.entries(NAME_ALIASES)) {
    out.push({re: wordRe(alias), code, label: countryLabel(code)});
  }
  return out;
})();

/**
 * Find the first geo match inside `text`. Matches are case-insensitive
 * and use word boundaries so "Iraq" doesn't match "Iraqi" (that would
 * also be an Iraq hit, which is fine — but also so "UK" doesn't match
 * "puking", which is not). The curated GEO table wins (city-level aliases,
 * regional labels like GAZA/KSA); the full-coverage country-name table
 * catches everything else so the whole globe can light up.
 */
export function geotag(text: string): GeoHit | null {
  const upper = text.toUpperCase();
  for (const {re, row} of GEO_MATCHERS) {
    if (re.test(upper)) {
      return {lng: row.lng, lat: row.lat, label: row.label};
    }
  }
  for (const m of COUNTRY_MATCHERS) {
    if (m.re.test(upper)) {
      return countryPin(m.code, m.label);
    }
  }
  return null;
}

/**
 * Guaranteed country pin for a Bravo-feed article. The server feed rows
 * carry an ISO2 `region`, so unlike headline-keyword geotagging this can
 * ALWAYS place the marker — the "enriched news point" on the Intel map.
 * Coordinates are capital-city level (country-glance precision, same as
 * the GEO table above).
 */
const COUNTRY_COORDS: Record<string, [number, number]> = {
  AF: [34.53, 69.17], AL: [41.33, 19.82], DZ: [36.75, 3.06],   AD: [42.51, 1.52],
  AO: [-8.84, 13.23], AG: [17.12, -61.85], AR: [-34.6, -58.38], AM: [40.18, 44.51],
  AU: [-35.28, 149.13], AT: [48.21, 16.37], AZ: [40.41, 49.87], BS: [25.05, -77.34],
  BH: [26.23, 50.59], BD: [23.81, 90.41], BB: [13.1, -59.62],  BY: [53.9, 27.57],
  BE: [50.85, 4.35],  BZ: [17.25, -88.77], BJ: [6.5, 2.6],     BT: [27.47, 89.64],
  BO: [-16.5, -68.15], BA: [43.86, 18.41], BW: [-24.65, 25.91], BR: [-15.79, -47.88],
  BN: [4.9, 114.94],  BG: [42.7, 23.32],  BF: [12.37, -1.52], BI: [-3.43, 29.92],
  KH: [11.56, 104.92], CM: [3.87, 11.52], CA: [45.42, -75.7], CV: [14.93, -23.51],
  CF: [4.39, 18.56],  TD: [12.13, 15.06], CL: [-33.45, -70.67], CN: [39.9, 116.4],
  CO: [4.71, -74.07], KM: [-11.7, 43.26], CG: [-4.26, 15.24], CR: [9.93, -84.08],
  HR: [45.81, 15.98], CU: [23.11, -82.37], CY: [35.19, 33.38], CZ: [50.09, 14.42],
  CD: [-4.44, 15.27], DK: [55.68, 12.57], DJ: [11.59, 43.15], DM: [15.3, -61.39],
  DO: [18.49, -69.93], EC: [-0.18, -78.47], EG: [30.04, 31.24], SV: [13.69, -89.19],
  GQ: [3.75, 8.78],   ER: [15.34, 38.93], EE: [59.44, 24.75], SZ: [-26.31, 31.14],
  ET: [9.03, 38.74],  FJ: [-18.14, 178.44], FI: [60.17, 24.94], FR: [48.86, 2.35],
  GA: [0.39, 9.45],   GM: [13.45, -16.58], GE: [41.72, 44.79], DE: [52.52, 13.41],
  GH: [5.6, -0.19],   GR: [37.98, 23.73], GD: [12.06, -61.75], GT: [14.63, -90.51],
  GN: [9.64, -13.58], GW: [11.86, -15.6], GY: [6.8, -58.16],  HT: [18.54, -72.34],
  HN: [14.07, -87.19], HK: [22.28, 114.17], HU: [47.5, 19.04], IS: [64.15, -21.94],
  IN: [28.61, 77.21], ID: [-6.21, 106.85], IR: [35.69, 51.39], IQ: [33.31, 44.36],
  IE: [53.35, -6.26], IL: [31.77, 35.21], IT: [41.9, 12.5],   CI: [5.36, -4.01],
  JM: [18.02, -76.8], JP: [35.69, 139.69], JO: [31.95, 35.93], KZ: [51.17, 71.45],
  KE: [-1.29, 36.82], KI: [1.45, 173.03], XK: [42.66, 21.17], KW: [29.38, 47.98],
  KG: [42.87, 74.59], LA: [17.98, 102.63], LV: [56.95, 24.11], LB: [33.89, 35.5],
  LS: [-29.32, 27.48], LR: [6.29, -10.76], LY: [32.89, 13.19], LI: [47.14, 9.52],
  LT: [54.69, 25.28], LU: [49.61, 6.13],  MG: [-18.88, 47.51], MW: [-13.96, 33.77],
  MY: [3.14, 101.69], MV: [4.18, 73.51],  ML: [12.64, -8.0],  MT: [35.9, 14.51],
  MH: [7.12, 171.36], MR: [18.08, -15.98], MU: [-20.16, 57.5], MX: [19.43, -99.13],
  FM: [6.92, 158.16], MD: [47.01, 28.86], MC: [43.73, 7.42],  MN: [47.89, 106.91],
  ME: [42.43, 19.26], MA: [34.02, -6.84], MZ: [-25.97, 32.57], MM: [19.76, 96.08],
  NA: [-22.56, 17.08], NR: [-0.55, 166.92], NP: [27.72, 85.32], NL: [52.37, 4.9],
  NZ: [-41.29, 174.78], NI: [12.11, -86.24], NE: [13.51, 2.11], NG: [9.06, 7.5],
  KP: [39.03, 125.75], MK: [41.99, 21.43], NO: [59.91, 10.75], OM: [23.59, 58.54],
  PK: [33.68, 73.05], PW: [7.5, 134.62],  PS: [31.9, 35.2],   PA: [8.98, -79.52],
  PG: [-9.44, 147.18], PY: [-25.26, -57.58], PE: [-12.05, -77.04], PH: [14.6, 120.98],
  PL: [52.23, 21.01], PT: [38.72, -9.14], QA: [25.29, 51.53], RO: [44.43, 26.1],
  RU: [55.76, 37.62], RW: [-1.94, 30.06], KN: [17.3, -62.73], LC: [14.01, -60.99],
  VC: [13.16, -61.22], WS: [-13.83, -171.77], SM: [43.94, 12.45], ST: [0.34, 6.73],
  SA: [24.71, 46.68], SN: [14.72, -17.47], RS: [44.79, 20.45], SC: [-4.62, 55.45],
  SL: [8.47, -13.23], SG: [1.35, 103.82], SK: [48.15, 17.11], SI: [46.06, 14.51],
  SB: [-9.43, 159.95], SO: [2.05, 45.32], ZA: [-25.75, 28.19], KR: [37.57, 126.98],
  SS: [4.85, 31.6],   ES: [40.42, -3.7],  LK: [6.93, 79.85],  SD: [15.5, 32.56],
  SR: [5.87, -55.17], SE: [59.33, 18.07], CH: [46.95, 7.45],  SY: [33.51, 36.29],
  TW: [25.03, 121.57], TJ: [38.56, 68.79], TZ: [-6.79, 39.21], TH: [13.76, 100.5],
  TL: [-8.56, 125.57], TG: [6.13, 1.22],  TO: [-21.14, -175.2], TT: [10.65, -61.51],
  TN: [36.81, 10.18], TR: [39.93, 32.86], TM: [37.96, 58.33], TV: [-8.52, 179.2],
  AE: [24.45, 54.38], GB: [51.51, -0.13], UG: [0.35, 32.58],  UA: [50.45, 30.52],
  US: [38.9, -77.04], UY: [-34.9, -56.19], UZ: [41.3, 69.24], VU: [-17.73, 168.32],
  VE: [10.48, -66.9], VN: [21.03, 105.85], YE: [15.36, 44.19], ZM: [-15.39, 28.32],
  ZW: [-17.83, 31.05],
};

export function countryPin(iso2: string | undefined, label?: string): GeoHit | null {
  const code = (iso2 ?? '').toUpperCase();
  // The curated GEO row is CANONICAL for its country: same coords + same
  // label as headline geotagging, so one country never splits into two
  // bubbles ("KSA" vs "SAUDI ARABIA") with badge counts that disagree
  // with the tap drawer (founder report, 2026-07-31).
  const curated = GEO.find(r => r.iso === code);
  if (curated) {return {lat: curated.lat, lng: curated.lng, label: curated.label};}
  const c = COUNTRY_COORDS[code];
  if (!c) {return null;}
  return {lat: c[0], lng: c[1], label: (label ?? code).toUpperCase()};
}

/**
 * Severity heuristic — stamps headlines with a colour tier based on
 * keyword presence. Mirrors the hand-tuned palette in the original
 * mock data. Deterministic so the same article always gets the same
 * marker colour across app sessions.
 */
export function severityFor(headline: string, sectionId: string): 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' {
  const t = headline.toLowerCase();
  if (/\b(killed|attack|strike|bomb|ballistic|shooting|massacre|crisis|emergency)\b/.test(t)) {return 'CRITICAL';}
  if (/\b(protest|riot|threat|sanction|war|violence|clash|unrest)\b/.test(t))                {return 'HIGH';}
  if (sectionId === 'world' || sectionId === 'politics')                                     {return 'MEDIUM';}
  return 'LOW';
}

/** Map a Guardian `sectionId` (or a Bravo feed category id) to the visual
 *  tag shown on the Wire tab. */
export function sectionToTag(sectionId: string): string {
  switch (sectionId) {
    case 'world':        return 'POLITICAL';
    case 'politics':     return 'POLITICAL';
    case 'business':     return 'FINANCE';
    case 'money':        return 'FINANCE';
    case 'finance':      return 'FINANCE';
    case 'realestate':   return 'FINANCE';
    case 'environment':  return 'CLIMATE';
    case 'technology':   return 'TECH';
    case 'sport':        return 'SPORT';
    case 'society':      return 'SOCIETY';
    case 'security':     return 'SECURITY';
    case 'defence':      return 'MILITARY';
    case 'energy':       return 'ENERGY';
    case 'aviation':     return 'AVIATION';
    default:             return 'GENERAL';
  }
}
