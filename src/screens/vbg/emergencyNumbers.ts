/**
 * Bundled OFFLINE emergency-services directory for the VBG "Contact Emergency
 * Services" action. An emergency feature must work with no signal, so this
 * ships in-app rather than behind an API.
 *
 * Each entry: ISO-3166 alpha-2 code, display name, and the dialable numbers
 * for Police / Ambulance / Fire (and where a single universal line covers all,
 * `all`). Numbers are the official public emergency lines per country. `112`
 * is the GSM-universal fallback reachable on any network/SIM and is shown as a
 * safe default for every country.
 *
 * Sources: ITU / national emergency authorities (public reference data).
 */
export interface EmergencyEntry {
  iso:   string;        // ISO-3166 alpha-2
  name:  string;
  /** Single number that reaches all services (shown first when present). */
  all?:    string;
  police?: string;
  ambulance?: string;
  fire?:   string;
}

/** GSM-universal emergency number, reachable on any network worldwide. */
export const UNIVERSAL_EMERGENCY = '112';

export const EMERGENCY_NUMBERS: EmergencyEntry[] = [
  {iso: 'AF', name: 'Afghanistan', police: '119', ambulance: '102', fire: '119'},
  {iso: 'AL', name: 'Albania', all: '112', police: '129', ambulance: '127', fire: '128'},
  {iso: 'DZ', name: 'Algeria', police: '17', ambulance: '14', fire: '14'},
  {iso: 'AD', name: 'Andorra', all: '112'},
  {iso: 'AO', name: 'Angola', police: '113', ambulance: '116', fire: '115'},
  {iso: 'AG', name: 'Antigua and Barbuda', all: '911'},
  {iso: 'AR', name: 'Argentina', all: '911', police: '101', ambulance: '107', fire: '100'},
  {iso: 'AM', name: 'Armenia', all: '112', police: '102', ambulance: '103', fire: '101'},
  {iso: 'AU', name: 'Australia', all: '000', police: '000', ambulance: '000', fire: '000'},
  {iso: 'AT', name: 'Austria', all: '112', police: '133', ambulance: '144', fire: '122'},
  {iso: 'AZ', name: 'Azerbaijan', all: '112', police: '102', ambulance: '103', fire: '101'},
  {iso: 'BS', name: 'Bahamas', all: '911', police: '919'},
  {iso: 'BH', name: 'Bahrain', all: '999'},
  {iso: 'BD', name: 'Bangladesh', all: '999', police: '999', ambulance: '999', fire: '999'},
  {iso: 'BB', name: 'Barbados', police: '211', ambulance: '511', fire: '311'},
  {iso: 'BY', name: 'Belarus', police: '102', ambulance: '103', fire: '101'},
  {iso: 'BE', name: 'Belgium', all: '112', police: '101', ambulance: '112', fire: '112'},
  {iso: 'BZ', name: 'Belize', all: '911', police: '911'},
  {iso: 'BJ', name: 'Benin', police: '117', fire: '118'},
  {iso: 'BT', name: 'Bhutan', police: '113', ambulance: '112', fire: '110'},
  {iso: 'BO', name: 'Bolivia', police: '110', ambulance: '118', fire: '119'},
  {iso: 'BA', name: 'Bosnia and Herzegovina', all: '112', police: '122', ambulance: '124', fire: '123'},
  {iso: 'BW', name: 'Botswana', police: '999', ambulance: '997', fire: '998'},
  {iso: 'BR', name: 'Brazil', police: '190', ambulance: '192', fire: '193'},
  {iso: 'BN', name: 'Brunei', police: '993', ambulance: '991', fire: '995'},
  {iso: 'BG', name: 'Bulgaria', all: '112'},
  {iso: 'BF', name: 'Burkina Faso', police: '17', ambulance: '112', fire: '18'},
  {iso: 'BI', name: 'Burundi', police: '117', ambulance: '112'},
  {iso: 'KH', name: 'Cambodia', police: '117', ambulance: '119', fire: '118'},
  {iso: 'CM', name: 'Cameroon', police: '117', ambulance: '119', fire: '118'},
  {iso: 'CA', name: 'Canada', all: '911'},
  {iso: 'CV', name: 'Cape Verde', police: '132', ambulance: '130', fire: '131'},
  {iso: 'CF', name: 'Central African Republic', police: '117'},
  {iso: 'TD', name: 'Chad', police: '17', fire: '18'},
  {iso: 'CL', name: 'Chile', police: '133', ambulance: '131', fire: '132'},
  {iso: 'CN', name: 'China', police: '110', ambulance: '120', fire: '119'},
  {iso: 'CO', name: 'Colombia', all: '123'},
  {iso: 'KM', name: 'Comoros', police: '17'},
  {iso: 'CG', name: 'Congo', police: '117'},
  {iso: 'CD', name: 'DR Congo', police: '112'},
  {iso: 'CR', name: 'Costa Rica', all: '911'},
  {iso: 'CI', name: "Côte d'Ivoire", police: '111', ambulance: '185', fire: '180'},
  {iso: 'HR', name: 'Croatia', all: '112', police: '192', ambulance: '194', fire: '193'},
  {iso: 'CU', name: 'Cuba', police: '106', ambulance: '104', fire: '105'},
  {iso: 'CY', name: 'Cyprus', all: '112', police: '199'},
  {iso: 'CZ', name: 'Czechia', all: '112', police: '158', ambulance: '155', fire: '150'},
  {iso: 'DK', name: 'Denmark', all: '112', police: '114'},
  {iso: 'DJ', name: 'Djibouti', police: '17', ambulance: '351', fire: '18'},
  {iso: 'DM', name: 'Dominica', all: '999'},
  {iso: 'DO', name: 'Dominican Republic', all: '911'},
  {iso: 'EC', name: 'Ecuador', all: '911'},
  {iso: 'EG', name: 'Egypt', police: '122', ambulance: '123', fire: '180'},
  {iso: 'SV', name: 'El Salvador', all: '911', police: '911'},
  {iso: 'GQ', name: 'Equatorial Guinea', police: '114', fire: '115'},
  {iso: 'ER', name: 'Eritrea', police: '113', ambulance: '114', fire: '116'},
  {iso: 'EE', name: 'Estonia', all: '112', police: '110'},
  {iso: 'SZ', name: 'Eswatini', all: '999', police: '999'},
  {iso: 'ET', name: 'Ethiopia', police: '991', ambulance: '907', fire: '939'},
  {iso: 'FJ', name: 'Fiji', all: '911', police: '917', ambulance: '911', fire: '910'},
  {iso: 'FI', name: 'Finland', all: '112'},
  {iso: 'FR', name: 'France', all: '112', police: '17', ambulance: '15', fire: '18'},
  {iso: 'GA', name: 'Gabon', police: '1730', fire: '18'},
  {iso: 'GM', name: 'Gambia', police: '117', ambulance: '116', fire: '118'},
  {iso: 'GE', name: 'Georgia', all: '112'},
  {iso: 'DE', name: 'Germany', all: '112', police: '110', ambulance: '112', fire: '112'},
  {iso: 'GH', name: 'Ghana', all: '112', police: '191', ambulance: '193', fire: '192'},
  {iso: 'GR', name: 'Greece', all: '112', police: '100', ambulance: '166', fire: '199'},
  {iso: 'GD', name: 'Grenada', all: '911', police: '911', ambulance: '434', fire: '112'},
  {iso: 'GT', name: 'Guatemala', all: '110', police: '110', ambulance: '125', fire: '123'},
  {iso: 'GN', name: 'Guinea', police: '117', fire: '18'},
  {iso: 'GW', name: 'Guinea-Bissau', police: '117'},
  {iso: 'GY', name: 'Guyana', all: '911', police: '911'},
  {iso: 'HT', name: 'Haiti', police: '114', ambulance: '116', fire: '115'},
  {iso: 'HN', name: 'Honduras', all: '911'},
  {iso: 'HK', name: 'Hong Kong', all: '999', police: '999'},
  {iso: 'HU', name: 'Hungary', all: '112', police: '107', ambulance: '104', fire: '105'},
  {iso: 'IS', name: 'Iceland', all: '112'},
  {iso: 'IN', name: 'India', all: '112', police: '100', ambulance: '102', fire: '101'},
  {iso: 'ID', name: 'Indonesia', all: '112', police: '110', ambulance: '118', fire: '113'},
  {iso: 'IR', name: 'Iran', police: '110', ambulance: '115', fire: '125'},
  {iso: 'IQ', name: 'Iraq', police: '104', ambulance: '122', fire: '115'},
  {iso: 'IE', name: 'Ireland', all: '112', police: '999', ambulance: '999', fire: '999'},
  {iso: 'IL', name: 'Israel', police: '100', ambulance: '101', fire: '102'},
  {iso: 'IT', name: 'Italy', all: '112', police: '113', ambulance: '118', fire: '115'},
  {iso: 'JM', name: 'Jamaica', police: '119', ambulance: '110', fire: '110'},
  {iso: 'JP', name: 'Japan', police: '110', ambulance: '119', fire: '119'},
  {iso: 'JO', name: 'Jordan', all: '911', police: '191', ambulance: '193', fire: '199'},
  {iso: 'KZ', name: 'Kazakhstan', all: '112', police: '102', ambulance: '103', fire: '101'},
  {iso: 'KE', name: 'Kenya', all: '999', police: '999', ambulance: '999', fire: '999'},
  {iso: 'KI', name: 'Kiribati', police: '992', ambulance: '994', fire: '993'},
  {iso: 'KW', name: 'Kuwait', all: '112'},
  {iso: 'KG', name: 'Kyrgyzstan', police: '102', ambulance: '103', fire: '101'},
  {iso: 'LA', name: 'Laos', police: '191', ambulance: '195', fire: '190'},
  {iso: 'LV', name: 'Latvia', all: '112', police: '110', ambulance: '113'},
  {iso: 'LB', name: 'Lebanon', police: '112', ambulance: '140', fire: '175'},
  {iso: 'LS', name: 'Lesotho', police: '123', ambulance: '121', fire: '122'},
  {iso: 'LR', name: 'Liberia', all: '911'},
  {iso: 'LY', name: 'Libya', police: '1515', ambulance: '193'},
  {iso: 'LI', name: 'Liechtenstein', all: '112', police: '117', ambulance: '144', fire: '118'},
  {iso: 'LT', name: 'Lithuania', all: '112'},
  {iso: 'LU', name: 'Luxembourg', all: '112', police: '113'},
  {iso: 'MO', name: 'Macau', all: '999'},
  {iso: 'MG', name: 'Madagascar', police: '117', ambulance: '124', fire: '118'},
  {iso: 'MW', name: 'Malawi', police: '997', ambulance: '998', fire: '999'},
  {iso: 'MY', name: 'Malaysia', all: '999', police: '999', ambulance: '999', fire: '994'},
  {iso: 'MV', name: 'Maldives', police: '119', ambulance: '102', fire: '118'},
  {iso: 'ML', name: 'Mali', police: '17', ambulance: '15', fire: '18'},
  {iso: 'MT', name: 'Malta', all: '112'},
  {iso: 'MR', name: 'Mauritania', police: '117', fire: '118'},
  {iso: 'MU', name: 'Mauritius', police: '999', ambulance: '114', fire: '115'},
  {iso: 'MX', name: 'Mexico', all: '911'},
  {iso: 'MD', name: 'Moldova', all: '112'},
  {iso: 'MC', name: 'Monaco', all: '112', police: '17', ambulance: '18', fire: '18'},
  {iso: 'MN', name: 'Mongolia', police: '102', ambulance: '103', fire: '101'},
  {iso: 'ME', name: 'Montenegro', all: '112', police: '122', ambulance: '124', fire: '123'},
  {iso: 'MA', name: 'Morocco', police: '190', ambulance: '150', fire: '150'},
  {iso: 'MZ', name: 'Mozambique', police: '119', ambulance: '117', fire: '198'},
  {iso: 'MM', name: 'Myanmar', police: '199', ambulance: '192', fire: '191'},
  {iso: 'NA', name: 'Namibia', police: '10111', ambulance: '2032276', fire: '2032270'},
  {iso: 'NP', name: 'Nepal', police: '100', ambulance: '102', fire: '101'},
  // B-638 — `police: '0900-8844'` REMOVED. That is the Dutch **non-emergency**
  // police line ("geen spoed, wel politie"): premium-rate, queued, and useless
  // in an emergency — and it was being rendered as a one-tap chip labelled
  // "Police" on the emergency card. The Netherlands uses 112 for all services.
  {iso: 'NL', name: 'Netherlands', all: '112'},
  {iso: 'NZ', name: 'New Zealand', all: '111', police: '111', ambulance: '111', fire: '111'},
  {iso: 'NI', name: 'Nicaragua', all: '911', police: '118'},
  {iso: 'NE', name: 'Niger', police: '17', fire: '18'},
  {iso: 'NG', name: 'Nigeria', all: '112', police: '112'},
  {iso: 'KP', name: 'North Korea', police: '119'},
  {iso: 'MK', name: 'North Macedonia', all: '112', police: '192', ambulance: '194', fire: '193'},
  {iso: 'NO', name: 'Norway', all: '112', police: '112', ambulance: '113', fire: '110'},
  {iso: 'OM', name: 'Oman', all: '9999'},
  {iso: 'PK', name: 'Pakistan', all: '15', police: '15', ambulance: '1122', fire: '16'},
  {iso: 'PS', name: 'Palestine', police: '100', ambulance: '101', fire: '102'},
  {iso: 'PA', name: 'Panama', all: '911', police: '104', ambulance: '911', fire: '103'},
  {iso: 'PG', name: 'Papua New Guinea', police: '112', ambulance: '111'},
  {iso: 'PY', name: 'Paraguay', all: '911', police: '911', ambulance: '141', fire: '132'},
  {iso: 'PE', name: 'Peru', all: '105', police: '105', ambulance: '116', fire: '116'},
  {iso: 'PH', name: 'Philippines', all: '911', police: '911'},
  {iso: 'PL', name: 'Poland', all: '112', police: '997', ambulance: '999', fire: '998'},
  {iso: 'PT', name: 'Portugal', all: '112'},
  {iso: 'QA', name: 'Qatar', all: '999'},
  {iso: 'RO', name: 'Romania', all: '112'},
  {iso: 'RU', name: 'Russia', all: '112', police: '102', ambulance: '103', fire: '101'},
  {iso: 'RW', name: 'Rwanda', police: '112', ambulance: '912', fire: '111'},
  {iso: 'KN', name: 'Saint Kitts and Nevis', all: '911'},
  {iso: 'LC', name: 'Saint Lucia', all: '911', police: '999'},
  {iso: 'VC', name: 'Saint Vincent and the Grenadines', all: '911', police: '999'},
  {iso: 'WS', name: 'Samoa', all: '911', police: '995', ambulance: '996', fire: '994'},
  {iso: 'SM', name: 'San Marino', all: '113', police: '113', ambulance: '118', fire: '115'},
  {iso: 'ST', name: 'São Tomé and Príncipe', police: '112'},
  {iso: 'SA', name: 'Saudi Arabia', all: '911', police: '999', ambulance: '997', fire: '998'},
  {iso: 'SN', name: 'Senegal', police: '17', ambulance: '1515', fire: '18'},
  {iso: 'RS', name: 'Serbia', all: '112', police: '192', ambulance: '194', fire: '193'},
  {iso: 'SC', name: 'Seychelles', all: '999', police: '999'},
  {iso: 'SL', name: 'Sierra Leone', police: '019', ambulance: '999'},
  {iso: 'SG', name: 'Singapore', all: '999', police: '999', ambulance: '995', fire: '995'},
  {iso: 'SK', name: 'Slovakia', all: '112', police: '158', ambulance: '155', fire: '150'},
  {iso: 'SI', name: 'Slovenia', all: '112', police: '113'},
  {iso: 'SB', name: 'Solomon Islands', all: '999', police: '999'},
  {iso: 'SO', name: 'Somalia', police: '888', ambulance: '999'},
  {iso: 'ZA', name: 'South Africa', all: '112', police: '10111', ambulance: '10177', fire: '10177'},
  {iso: 'KR', name: 'South Korea', police: '112', ambulance: '119', fire: '119'},
  {iso: 'SS', name: 'South Sudan', police: '777'},
  {iso: 'ES', name: 'Spain', all: '112', police: '091', ambulance: '061', fire: '080'},
  {iso: 'LK', name: 'Sri Lanka', all: '119', police: '119', ambulance: '1990', fire: '110'},
  {iso: 'SD', name: 'Sudan', police: '999', ambulance: '333'},
  {iso: 'SR', name: 'Suriname', police: '115', ambulance: '113', fire: '110'},
  {iso: 'SE', name: 'Sweden', all: '112'},
  {iso: 'CH', name: 'Switzerland', all: '112', police: '117', ambulance: '144', fire: '118'},
  {iso: 'SY', name: 'Syria', police: '112', ambulance: '110', fire: '113'},
  {iso: 'TW', name: 'Taiwan', police: '110', ambulance: '119', fire: '119'},
  {iso: 'TJ', name: 'Tajikistan', police: '102', ambulance: '103', fire: '101'},
  {iso: 'TZ', name: 'Tanzania', all: '112', police: '112', ambulance: '114', fire: '115'},
  {iso: 'TH', name: 'Thailand', all: '191', police: '191', ambulance: '1669', fire: '199'},
  {iso: 'TL', name: 'Timor-Leste', all: '112', police: '112'},
  {iso: 'TG', name: 'Togo', police: '117', ambulance: '8200', fire: '118'},
  {iso: 'TO', name: 'Tonga', all: '911', police: '922', ambulance: '933', fire: '999'},
  {iso: 'TT', name: 'Trinidad and Tobago', police: '999', ambulance: '811', fire: '990'},
  {iso: 'TN', name: 'Tunisia', police: '197', ambulance: '190', fire: '198'},
  {iso: 'TR', name: 'Turkey', all: '112', police: '155', ambulance: '112', fire: '110'},
  {iso: 'TM', name: 'Turkmenistan', police: '02', ambulance: '03', fire: '01'},
  {iso: 'UG', name: 'Uganda', all: '999', police: '999', ambulance: '912'},
  {iso: 'UA', name: 'Ukraine', all: '112', police: '102', ambulance: '103', fire: '101'},
  {iso: 'AE', name: 'United Arab Emirates', all: '999', police: '999', ambulance: '998', fire: '997'},
  {iso: 'GB', name: 'United Kingdom', all: '999', police: '999', ambulance: '999', fire: '999'},
  {iso: 'US', name: 'United States', all: '911', police: '911', ambulance: '911', fire: '911'},
  {iso: 'UY', name: 'Uruguay', all: '911', police: '109', ambulance: '105', fire: '104'},
  {iso: 'UZ', name: 'Uzbekistan', police: '102', ambulance: '103', fire: '101'},
  {iso: 'VU', name: 'Vanuatu', all: '112', police: '112'},
  {iso: 'VE', name: 'Venezuela', all: '911', police: '171'},
  {iso: 'VN', name: 'Vietnam', police: '113', ambulance: '115', fire: '114'},
  {iso: 'YE', name: 'Yemen', police: '199', ambulance: '191', fire: '191'},
  {iso: 'ZM', name: 'Zambia', police: '999', ambulance: '992', fire: '993'},
  {iso: 'ZW', name: 'Zimbabwe', all: '999', police: '995', ambulance: '994', fire: '993'},
];

/** Case-insensitive name + ISO search over the bundled directory. */
export function searchEmergency(query: string): EmergencyEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) {return EMERGENCY_NUMBERS;}
  return EMERGENCY_NUMBERS.filter(
    e => e.name.toLowerCase().includes(q) || e.iso.toLowerCase() === q,
  );
}

/** Look up one country by ISO-3166 alpha-2 (case-insensitive). */
export function emergencyForIso(iso: string | null | undefined): EmergencyEntry | null {
  if (!iso) {return null;}
  const up = iso.trim().toUpperCase();
  return EMERGENCY_NUMBERS.find(e => e.iso === up) ?? null;
}

/**
 * Geocoder spellings that no amount of substring matching can reach — endonyms
 * ("Deutschland"), long forms ("Democratic Republic of the Congo", which does
 * NOT contain the string "DR Congo"), and the SAR forms. Every value is checked
 * against the directory by `emergencyNumbers.test.ts`, so a typo here fails the
 * build rather than silently resolving nothing.
 */
export const NAME_ALIASES: Readonly<Record<string, string>> = {
  'democratic republic of the congo': 'CD',
  'republic of the congo':            'CG',
  'drc':                              'CD',
  'hong kong sar china':              'HK',
  'macao sar china':                  'MO',
  'macao':                            'MO',
  'deutschland':                      'DE',
  'türkiye':                          'TR',
  'turkiye':                          'TR',
  'nederland':                        'NL',
  'the netherlands':                  'NL',
  'suomi':                            'FI',
  'republic of korea':                'KR',
  'united states of america':         'US',
  'usa':                              'US',
  'great britain':                    'GB',
  'uae':                              'AE',
  'czech republic':                   'CZ',
  'burma':                            'MM',
  'ivory coast':                      'CI',
  'schweiz':                          'CH',
  'suisse':                           'CH',
  'svizzera':                         'CH',
  'belgië':                           'BE',
  'belgique':                         'BE',
  'españa':                           'ES',
  'italia':                           'IT',
};

/**
 * Match a free-text country NAME (e.g. the last segment of a geocode context).
 *
 * ⚠️ A WRONG match here dials the wrong country's emergency services, so the
 * order is exact → alias → LONGEST unambiguous substring, and an ambiguous
 * result returns null rather than a guess (the caller's next rung is always a
 * better answer than a confident wrong one).
 *
 * The longest-match rule is load-bearing. The fallback used to take the FIRST
 * substring hit, and the directory is alphabetical, so:
 *
 *   'Hong Kong SAR China' → China → 110/120/119, none of which work in
 *                                    Hong Kong, where the number is 999.
 *
 * "Hong Kong" (9 chars) must beat "China" (5). Do NOT reach for `endsWith`
 * instead — 'hong kong sar china'.endsWith('china') is true and picks China
 * straight back.
 */
export function emergencyForName(name: string | null | undefined): EmergencyEntry | null {
  if (!name) {return null;}
  /**
   * `normalize('NFC')` folds decomposed accents so a geocoder that emits NFD
   * ('Türkiye' as T-u-¨-r-…) still matches its alias.
   *
   * The U+0307 strip is for Turkish specifically: the dotted capital İ (U+0130)
   * lowercases to `i` + COMBINING DOT ABOVE, and NFC cannot recompose it
   * (no precomposed "i with dot above" exists). Without the strip 'TÜRKİYE'
   * misses its alias entirely — and all-caps country names are a real geocoder
   * rendering. A miss is safe (the ladder falls through), never wrong, but it
   * costs a correct answer for no reason.
   */
  const n = name
    .trim().toLowerCase().normalize('NFC')
    .replace(/\u0307/g, '')
    .replace(/\s+/g, ' ');
  if (!n) {return null;}

  const exact = EMERGENCY_NUMBERS.find(e => e.name.toLowerCase() === n);
  if (exact) {return exact;}

  const aliased = NAME_ALIASES[n];
  if (aliased) {return emergencyForIso(aliased);}

  const hits = EMERGENCY_NUMBERS
    .filter(e => n.includes(e.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length);
  if (!hits.length) {return null;}
  // A tie between two different countries is genuinely ambiguous — fall through.
  if (hits.length > 1 && hits[1].name.length === hits[0].name.length) {return null;}
  return hits[0];
}
