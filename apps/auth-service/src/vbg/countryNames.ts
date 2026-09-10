/**
 * ISO2 → display name for every selectable country, plus headline-matching
 * helpers. Single source shared by the news feed (query scoping) and the VBG
 * threat blend (foreign-story screening) — mirrors NEWS_COUNTRIES in the
 * mobile prefs (src/modules/news/newsPrefs.ts).
 */
export const COUNTRY_NAMES: Record<string, string> = {
  AF: 'Afghanistan',   AL: 'Albania',        DZ: 'Algeria',        AD: 'Andorra',
  AO: 'Angola',        AG: 'Antigua',        AR: 'Argentina',      AM: 'Armenia',
  AU: 'Australia',     AT: 'Austria',        AZ: 'Azerbaijan',     BS: 'Bahamas',
  BH: 'Bahrain',       BD: 'Bangladesh',     BB: 'Barbados',       BY: 'Belarus',
  BE: 'Belgium',       BZ: 'Belize',         BJ: 'Benin',          BT: 'Bhutan',
  BO: 'Bolivia',       BA: 'Bosnia',         BW: 'Botswana',       BR: 'Brazil',
  BN: 'Brunei',        BG: 'Bulgaria',       BF: 'Burkina Faso',   BI: 'Burundi',
  KH: 'Cambodia',      CM: 'Cameroon',       CA: 'Canada',         CV: 'Cape Verde',
  CF: 'Central African Republic',            TD: 'Chad',           CL: 'Chile',
  CN: 'China',         CO: 'Colombia',       KM: 'Comoros',        CG: 'Congo',
  CR: 'Costa Rica',    HR: 'Croatia',        CU: 'Cuba',           CY: 'Cyprus',
  CZ: 'Czech Republic', CD: 'DR Congo',      DK: 'Denmark',        DJ: 'Djibouti',
  DM: 'Dominica',      DO: 'Dominican Republic',                   EC: 'Ecuador',
  EG: 'Egypt',         SV: 'El Salvador',    GQ: 'Equatorial Guinea',
  ER: 'Eritrea',       EE: 'Estonia',        SZ: 'Eswatini',       ET: 'Ethiopia',
  FJ: 'Fiji',          FI: 'Finland',        FR: 'France',         GA: 'Gabon',
  GM: 'Gambia',        GE: 'Georgia',        DE: 'Germany',        GH: 'Ghana',
  GR: 'Greece',        GD: 'Grenada',        GT: 'Guatemala',      GN: 'Guinea',
  GW: 'Guinea-Bissau', GY: 'Guyana',         HT: 'Haiti',          HN: 'Honduras',
  HK: 'Hong Kong',     HU: 'Hungary',        IS: 'Iceland',        IN: 'India',
  ID: 'Indonesia',     IR: 'Iran',           IQ: 'Iraq',           IE: 'Ireland',
  IL: 'Israel',        IT: 'Italy',          CI: 'Ivory Coast',    JM: 'Jamaica',
  JP: 'Japan',         JO: 'Jordan',         KZ: 'Kazakhstan',     KE: 'Kenya',
  KI: 'Kiribati',      XK: 'Kosovo',         KW: 'Kuwait',         KG: 'Kyrgyzstan',
  LA: 'Laos',          LV: 'Latvia',         LB: 'Lebanon',        LS: 'Lesotho',
  LR: 'Liberia',       LY: 'Libya',          LI: 'Liechtenstein',  LT: 'Lithuania',
  LU: 'Luxembourg',    MG: 'Madagascar',     MW: 'Malawi',         MY: 'Malaysia',
  MV: 'Maldives',      ML: 'Mali',           MT: 'Malta',          MH: 'Marshall Islands',
  MR: 'Mauritania',    MU: 'Mauritius',      MX: 'Mexico',         FM: 'Micronesia',
  MD: 'Moldova',       MC: 'Monaco',         MN: 'Mongolia',       ME: 'Montenegro',
  MA: 'Morocco',       MZ: 'Mozambique',     MM: 'Myanmar',        NA: 'Namibia',
  NR: 'Nauru',         NP: 'Nepal',          NL: 'Netherlands',    NZ: 'New Zealand',
  NI: 'Nicaragua',     NE: 'Niger',          NG: 'Nigeria',        KP: 'North Korea',
  MK: 'North Macedonia', NO: 'Norway',       OM: 'Oman',           PK: 'Pakistan',
  PW: 'Palau',         PS: 'Palestine',      PA: 'Panama',         PG: 'Papua New Guinea',
  PY: 'Paraguay',      PE: 'Peru',           PH: 'Philippines',    PL: 'Poland',
  PT: 'Portugal',      QA: 'Qatar',          RO: 'Romania',        RU: 'Russia',
  RW: 'Rwanda',        KN: 'Saint Kitts',    LC: 'Saint Lucia',    VC: 'Saint Vincent',
  WS: 'Samoa',         SM: 'San Marino',     ST: 'Sao Tome',       SA: 'Saudi Arabia',
  SN: 'Senegal',       RS: 'Serbia',         SC: 'Seychelles',     SL: 'Sierra Leone',
  SG: 'Singapore',     SK: 'Slovakia',       SI: 'Slovenia',       SB: 'Solomon Islands',
  SO: 'Somalia',       ZA: 'South Africa',   KR: 'South Korea',    SS: 'South Sudan',
  ES: 'Spain',         LK: 'Sri Lanka',      SD: 'Sudan',          SR: 'Suriname',
  SE: 'Sweden',        CH: 'Switzerland',    SY: 'Syria',          TW: 'Taiwan',
  TJ: 'Tajikistan',    TZ: 'Tanzania',       TH: 'Thailand',       TL: 'Timor-Leste',
  TG: 'Togo',          TO: 'Tonga',          TT: 'Trinidad',       TN: 'Tunisia',
  TR: 'Turkey',        TM: 'Turkmenistan',   TV: 'Tuvalu',         AE: 'UAE',
  GB: 'UK',            UG: 'Uganda',         UA: 'Ukraine',        US: 'United States',
  UY: 'Uruguay',       UZ: 'Uzbekistan',     VU: 'Vanuatu',        VE: 'Venezuela',
  VN: 'Vietnam',       YE: 'Yemen',          ZM: 'Zambia',         ZW: 'Zimbabwe',
};

// Extra headline tokens per country: formal names, demonyms and common short
// forms for the countries that dominate world news. Matched case-insensitively
// with word boundaries; ALL-CAPS/dotted forms below go through the
// case-sensitive acronym matcher instead (so 'US' never matches "us").
const NAME_ALIASES: Record<string, string[]> = {
  AE: ['United Arab Emirates', 'Emirati'],
  US: ['America', 'American', 'USA'],
  GB: ['Britain', 'British', 'United Kingdom', 'England', 'Scotland', 'Wales'],
  RU: ['Russian'],
  CN: ['Chinese'],
  JP: ['Japanese'],
  IN: ['Indian'],
  PK: ['Pakistani'],
  IR: ['Iranian', 'Tehran'],
  IL: ['Israeli'],
  PS: ['Palestinian', 'Gaza', 'West Bank'],
  UA: ['Ukrainian'],
  TR: ['Turkish'],
  FR: ['French'],
  DE: ['German'],
  EG: ['Egyptian'],
  SA: ['Saudi'],
  KP: ['North Korean'],
  KR: ['South Korean'],
  SY: ['Syrian'],
  YE: ['Yemeni'],
  AF: ['Afghan'],
  NL: ['Dutch'],
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const nameToIso = new Map<string, string>();      // lowercased token → ISO2
const acronymToIso = new Map<string, string>();   // exact-case token → ISO2

function register(token: string, iso: string): void {
  const t = token.trim();
  if (!t) {return;}
  // Short ALL-CAPS / dotted forms are case-sensitive (US/UK/UAE/U.S.).
  if (/^[A-Z.]{2,6}$/.test(t)) {
    acronymToIso.set(t, iso);
  } else {
    nameToIso.set(t.toLowerCase(), iso);
  }
}

for (const [iso, name] of Object.entries(COUNTRY_NAMES)) {register(name, iso);}
for (const [iso, list] of Object.entries(NAME_ALIASES)) {
  for (const alias of list) {register(alias, iso);}
}

// Longest-first so "South Korea" wins over "Korea"-style overlaps.
const NAME_RE = new RegExp(
  `\\b(${[...nameToIso.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})\\b`, 'gi');
const ACRONYM_RE = new RegExp(
  `(^|[^A-Za-z])(${[...acronymToIso.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![A-Za-z])`, 'g');

/** ISO2 codes of every country a headline explicitly names. */
export function titleCountryRefs(title: string): Set<string> {
  const out = new Set<string>();
  const t = title ?? '';
  NAME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAME_RE.exec(t)) !== null) {
    const iso = nameToIso.get(m[1].toLowerCase());
    if (iso) {out.add(iso);}
  }
  ACRONYM_RE.lastIndex = 0;
  while ((m = ACRONYM_RE.exec(t)) !== null) {
    const iso = acronymToIso.get(m[2]);
    if (iso) {out.add(iso);}
  }
  return out;
}

/**
 * Founder rule (SRA relevance, 2026-08-01): a threat headline in the radius
 * assessment must be ABOUT the area. Local outlets cover world news, so the
 * place-scoped query alone lets "Thirteen killed in Japan earthquake" (via a
 * UAE paper) into an Abu Dhabi assessment. Keep an item when it makes no
 * country claim at all, names the HOME country, or names one of the place
 * terms; drop it only when every country it names is foreign.
 */
export function isLocallyRelevant(
  title: string,
  homeIso: string | null | undefined,
  placeTerms: readonly string[],
): boolean {
  const refs = titleCountryRefs(title);
  if (refs.size === 0) {return true;}
  const home = (homeIso ?? '').trim().toUpperCase();
  if (home && refs.has(home)) {return true;}
  const t = (title ?? '').toLowerCase();
  return placeTerms.some(p => {
    const term = (p ?? '').trim().toLowerCase();
    return term.length > 0 && t.includes(term);
  });
}
