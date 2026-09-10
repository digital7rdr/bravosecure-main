/**
 * ISO 3166-1 alpha-2 → alpha-3, for DISPLAY ONLY.
 *
 * Founder rule (2026-08-08): every country abbreviation the user can see — in
 * Bravo Secure Services, Messenger, News, Virtual Bodyguard and Department
 * Channels — is THREE letters, never two, to match international practice.
 *
 * DISPLAY ONLY, and that constraint is load-bearing. Alpha-2 is what the rest
 * of the system is built on and none of it may change:
 *
 *   - `NEWS_COUNTRIES[].code` is the PERSISTED news preference (AsyncStorage)
 *     and the value sent to `/news/feed`; rewriting it would silently drop
 *     every user's saved selection and break the GDELT/NewsData queries.
 *   - `REGIONS[].code` is the dispatch/region key used for pricing and zones.
 *   - Flag emoji are built from alpha-2 regional-indicator pairs.
 *
 * So: keep alpha-2 as the identity, render `alpha3()` at the edge.
 */

/**
 * The 197 countries offered by `NEWS_COUNTRIES`, plus the regions in
 * `utils/regions.ts`. Alphabetical by alpha-2 so a missing entry is easy to
 * spot; `countryCodes.test.ts` pins completeness against both sources, so a
 * country added there without a code here fails the suite rather than
 * rendering a two-letter badge in production.
 */
export const ALPHA2_TO_ALPHA3: Readonly<Record<string, string>> = {
  AD: 'AND', AE: 'ARE', AF: 'AFG', AG: 'ATG', AL: 'ALB', AM: 'ARM', AO: 'AGO',
  AR: 'ARG', AT: 'AUT', AU: 'AUS', AZ: 'AZE',
  BA: 'BIH', BB: 'BRB', BD: 'BGD', BE: 'BEL', BF: 'BFA', BG: 'BGR', BH: 'BHR',
  BI: 'BDI', BJ: 'BEN', BN: 'BRN', BO: 'BOL', BR: 'BRA', BS: 'BHS', BT: 'BTN',
  BW: 'BWA', BY: 'BLR', BZ: 'BLZ',
  CA: 'CAN', CD: 'COD', CF: 'CAF', CG: 'COG', CH: 'CHE', CI: 'CIV', CL: 'CHL',
  CM: 'CMR', CN: 'CHN', CO: 'COL', CR: 'CRI', CU: 'CUB', CV: 'CPV', CY: 'CYP',
  CZ: 'CZE',
  DE: 'DEU', DJ: 'DJI', DK: 'DNK', DM: 'DMA', DO: 'DOM', DZ: 'DZA',
  EC: 'ECU', EE: 'EST', EG: 'EGY', ER: 'ERI', ES: 'ESP', ET: 'ETH',
  FI: 'FIN', FJ: 'FJI', FM: 'FSM', FR: 'FRA',
  GA: 'GAB', GB: 'GBR', GD: 'GRD', GE: 'GEO', GH: 'GHA', GM: 'GMB', GN: 'GIN',
  GQ: 'GNQ', GR: 'GRC', GT: 'GTM', GW: 'GNB', GY: 'GUY',
  HK: 'HKG', HN: 'HND', HR: 'HRV', HT: 'HTI', HU: 'HUN',
  ID: 'IDN', IE: 'IRL', IL: 'ISR', IN: 'IND', IQ: 'IRQ', IR: 'IRN', IS: 'ISL',
  IT: 'ITA',
  JM: 'JAM', JO: 'JOR', JP: 'JPN',
  KE: 'KEN', KG: 'KGZ', KH: 'KHM', KI: 'KIR', KM: 'COM', KN: 'KNA', KP: 'PRK',
  KR: 'KOR', KW: 'KWT', KZ: 'KAZ',
  LA: 'LAO', LB: 'LBN', LC: 'LCA', LI: 'LIE', LK: 'LKA', LR: 'LBR', LS: 'LSO',
  LT: 'LTU', LU: 'LUX', LV: 'LVA', LY: 'LBY',
  MA: 'MAR', MC: 'MCO', MD: 'MDA', ME: 'MNE', MG: 'MDG', MH: 'MHL', MK: 'MKD',
  // MO/Macau is reachable from the VBG emergency directory but is NOT one of
  // the 197 news countries — which is exactly why completeness is asserted
  // against every source list rather than just NEWS_COUNTRIES.
  ML: 'MLI', MM: 'MMR', MN: 'MNG', MO: 'MAC', MR: 'MRT', MT: 'MLT', MU: 'MUS', MV: 'MDV',
  MW: 'MWI', MX: 'MEX', MY: 'MYS', MZ: 'MOZ',
  NA: 'NAM', NE: 'NER', NG: 'NGA', NI: 'NIC', NL: 'NLD', NO: 'NOR', NP: 'NPL',
  NR: 'NRU', NZ: 'NZL',
  OM: 'OMN',
  PA: 'PAN', PE: 'PER', PG: 'PNG', PH: 'PHL', PK: 'PAK', PL: 'POL', PS: 'PSE',
  PT: 'PRT', PW: 'PLW', PY: 'PRY',
  QA: 'QAT',
  RO: 'ROU', RS: 'SRB', RU: 'RUS', RW: 'RWA',
  SA: 'SAU', SB: 'SLB', SC: 'SYC', SD: 'SDN', SE: 'SWE', SG: 'SGP', SI: 'SVN',
  SK: 'SVK', SL: 'SLE', SM: 'SMR', SN: 'SEN', SO: 'SOM', SR: 'SUR', SS: 'SSD',
  ST: 'STP', SV: 'SLV', SY: 'SYR', SZ: 'SWZ',
  TD: 'TCD', TG: 'TGO', TH: 'THA', TJ: 'TJK', TL: 'TLS', TM: 'TKM', TN: 'TUN',
  TO: 'TON', TR: 'TUR', TT: 'TTO', TV: 'TUV', TW: 'TWN', TZ: 'TZA',
  UA: 'UKR', UG: 'UGA', US: 'USA', UY: 'URY', UZ: 'UZB',
  VC: 'VCT', VE: 'VEN', VN: 'VNM', VU: 'VUT',
  WS: 'WSM',
  // Kosovo has NO assigned ISO 3166-1 code. XK is the user-assigned alpha-2 in
  // de-facto use (EU, IMF); XKX is its conventional alpha-3 partner (World
  // Bank). Listed explicitly so it reads as a decision, not an oversight.
  XK: 'XKX',
  YE: 'YEM',
  ZA: 'ZAF', ZM: 'ZMB', ZW: 'ZWE',
};

/**
 * The pseudo-country the news feed uses for "everything, unfiltered". Not ISO,
 * never rendered as a code (its row draws a globe icon), and excluded from the
 * completeness check.
 */
export const GLOBAL_CODE = 'GLOBAL';

/**
 * Three-letter code for display.
 *
 * Falls back to the input UPPERCASED rather than throwing or rendering a
 * placeholder: a country missing from the table is a test failure at build
 * time, and at runtime a two-letter badge is a far better outcome than a crash
 * or an empty chip on a shipped screen.
 */
export function alpha3(code: string | null | undefined): string {
  if (!code) {return '';}
  const key = code.trim().toUpperCase();
  if (key === GLOBAL_CODE) {return GLOBAL_CODE;}
  return ALPHA2_TO_ALPHA3[key] ?? key;
}
