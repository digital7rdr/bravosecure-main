import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * News feed preferences — which COUNTRIES and CATEGORIES the personalised
 * feed ("My Feed") requests from /news/feed. Shared by NewsPreferencesScreen
 * (edit), NewsFeedScreen (fetch + chips) and NewsHubScreen (tags + preview).
 * Ids mirror the server registry in
 * apps/auth-service/src/vbg/newsfeed.service.ts — unknown tokens are dropped
 * server-side, so the two lists must stay in sync.
 */
export interface NewsPrefs {
  countries:  string[]; // 'GLOBAL' or ISO2 codes
  categories: string[]; // category ids ('top', 'business', …)
}

// GLOBAL first, then every country A→Z. Codes are ISO 3166-1 alpha-2; the
// server uses the matching name in COUNTRY_NAMES (newsfeed.service.ts) to
// scope its news queries, so keep the two maps aligned.
export const NEWS_COUNTRIES: Array<{code: string; label: string}> = [
  {code: 'GLOBAL', label: 'Global'},
  {code: 'AF', label: 'Afghanistan'},
  {code: 'AL', label: 'Albania'},
  {code: 'DZ', label: 'Algeria'},
  {code: 'AD', label: 'Andorra'},
  {code: 'AO', label: 'Angola'},
  {code: 'AG', label: 'Antigua & Barbuda'},
  {code: 'AR', label: 'Argentina'},
  {code: 'AM', label: 'Armenia'},
  {code: 'AU', label: 'Australia'},
  {code: 'AT', label: 'Austria'},
  {code: 'AZ', label: 'Azerbaijan'},
  {code: 'BS', label: 'Bahamas'},
  {code: 'BH', label: 'Bahrain'},
  {code: 'BD', label: 'Bangladesh'},
  {code: 'BB', label: 'Barbados'},
  {code: 'BY', label: 'Belarus'},
  {code: 'BE', label: 'Belgium'},
  {code: 'BZ', label: 'Belize'},
  {code: 'BJ', label: 'Benin'},
  {code: 'BT', label: 'Bhutan'},
  {code: 'BO', label: 'Bolivia'},
  {code: 'BA', label: 'Bosnia & Herzegovina'},
  {code: 'BW', label: 'Botswana'},
  {code: 'BR', label: 'Brazil'},
  {code: 'BN', label: 'Brunei'},
  {code: 'BG', label: 'Bulgaria'},
  {code: 'BF', label: 'Burkina Faso'},
  {code: 'BI', label: 'Burundi'},
  {code: 'KH', label: 'Cambodia'},
  {code: 'CM', label: 'Cameroon'},
  {code: 'CA', label: 'Canada'},
  {code: 'CV', label: 'Cape Verde'},
  {code: 'CF', label: 'Central African Republic'},
  {code: 'TD', label: 'Chad'},
  {code: 'CL', label: 'Chile'},
  {code: 'CN', label: 'China'},
  {code: 'CO', label: 'Colombia'},
  {code: 'KM', label: 'Comoros'},
  {code: 'CG', label: 'Congo'},
  {code: 'CR', label: 'Costa Rica'},
  {code: 'HR', label: 'Croatia'},
  {code: 'CU', label: 'Cuba'},
  {code: 'CY', label: 'Cyprus'},
  {code: 'CZ', label: 'Czech Republic'},
  {code: 'CD', label: 'DR Congo'},
  {code: 'DK', label: 'Denmark'},
  {code: 'DJ', label: 'Djibouti'},
  {code: 'DM', label: 'Dominica'},
  {code: 'DO', label: 'Dominican Republic'},
  {code: 'EC', label: 'Ecuador'},
  {code: 'EG', label: 'Egypt'},
  {code: 'SV', label: 'El Salvador'},
  {code: 'GQ', label: 'Equatorial Guinea'},
  {code: 'ER', label: 'Eritrea'},
  {code: 'EE', label: 'Estonia'},
  {code: 'SZ', label: 'Eswatini'},
  {code: 'ET', label: 'Ethiopia'},
  {code: 'FJ', label: 'Fiji'},
  {code: 'FI', label: 'Finland'},
  {code: 'FR', label: 'France'},
  {code: 'GA', label: 'Gabon'},
  {code: 'GM', label: 'Gambia'},
  {code: 'GE', label: 'Georgia'},
  {code: 'DE', label: 'Germany'},
  {code: 'GH', label: 'Ghana'},
  {code: 'GR', label: 'Greece'},
  {code: 'GD', label: 'Grenada'},
  {code: 'GT', label: 'Guatemala'},
  {code: 'GN', label: 'Guinea'},
  {code: 'GW', label: 'Guinea-Bissau'},
  {code: 'GY', label: 'Guyana'},
  {code: 'HT', label: 'Haiti'},
  {code: 'HN', label: 'Honduras'},
  {code: 'HK', label: 'Hong Kong'},
  {code: 'HU', label: 'Hungary'},
  {code: 'IS', label: 'Iceland'},
  {code: 'IN', label: 'India'},
  {code: 'ID', label: 'Indonesia'},
  {code: 'IR', label: 'Iran'},
  {code: 'IQ', label: 'Iraq'},
  {code: 'IE', label: 'Ireland'},
  {code: 'IL', label: 'Israel'},
  {code: 'IT', label: 'Italy'},
  {code: 'CI', label: 'Ivory Coast'},
  {code: 'JM', label: 'Jamaica'},
  {code: 'JP', label: 'Japan'},
  {code: 'JO', label: 'Jordan'},
  {code: 'KZ', label: 'Kazakhstan'},
  {code: 'KE', label: 'Kenya'},
  {code: 'KI', label: 'Kiribati'},
  {code: 'XK', label: 'Kosovo'},
  {code: 'KW', label: 'Kuwait'},
  {code: 'KG', label: 'Kyrgyzstan'},
  {code: 'LA', label: 'Laos'},
  {code: 'LV', label: 'Latvia'},
  {code: 'LB', label: 'Lebanon'},
  {code: 'LS', label: 'Lesotho'},
  {code: 'LR', label: 'Liberia'},
  {code: 'LY', label: 'Libya'},
  {code: 'LI', label: 'Liechtenstein'},
  {code: 'LT', label: 'Lithuania'},
  {code: 'LU', label: 'Luxembourg'},
  {code: 'MG', label: 'Madagascar'},
  {code: 'MW', label: 'Malawi'},
  {code: 'MY', label: 'Malaysia'},
  {code: 'MV', label: 'Maldives'},
  {code: 'ML', label: 'Mali'},
  {code: 'MT', label: 'Malta'},
  {code: 'MH', label: 'Marshall Islands'},
  {code: 'MR', label: 'Mauritania'},
  {code: 'MU', label: 'Mauritius'},
  {code: 'MX', label: 'Mexico'},
  {code: 'FM', label: 'Micronesia'},
  {code: 'MD', label: 'Moldova'},
  {code: 'MC', label: 'Monaco'},
  {code: 'MN', label: 'Mongolia'},
  {code: 'ME', label: 'Montenegro'},
  {code: 'MA', label: 'Morocco'},
  {code: 'MZ', label: 'Mozambique'},
  {code: 'MM', label: 'Myanmar'},
  {code: 'NA', label: 'Namibia'},
  {code: 'NR', label: 'Nauru'},
  {code: 'NP', label: 'Nepal'},
  {code: 'NL', label: 'Netherlands'},
  {code: 'NZ', label: 'New Zealand'},
  {code: 'NI', label: 'Nicaragua'},
  {code: 'NE', label: 'Niger'},
  {code: 'NG', label: 'Nigeria'},
  {code: 'KP', label: 'North Korea'},
  {code: 'MK', label: 'North Macedonia'},
  {code: 'NO', label: 'Norway'},
  {code: 'OM', label: 'Oman'},
  {code: 'PK', label: 'Pakistan'},
  {code: 'PW', label: 'Palau'},
  {code: 'PS', label: 'Palestine'},
  {code: 'PA', label: 'Panama'},
  {code: 'PG', label: 'Papua New Guinea'},
  {code: 'PY', label: 'Paraguay'},
  {code: 'PE', label: 'Peru'},
  {code: 'PH', label: 'Philippines'},
  {code: 'PL', label: 'Poland'},
  {code: 'PT', label: 'Portugal'},
  {code: 'QA', label: 'Qatar'},
  {code: 'RO', label: 'Romania'},
  {code: 'RU', label: 'Russia'},
  {code: 'RW', label: 'Rwanda'},
  {code: 'KN', label: 'Saint Kitts & Nevis'},
  {code: 'LC', label: 'Saint Lucia'},
  {code: 'VC', label: 'Saint Vincent'},
  {code: 'WS', label: 'Samoa'},
  {code: 'SM', label: 'San Marino'},
  {code: 'ST', label: 'Sao Tome & Principe'},
  {code: 'SA', label: 'Saudi Arabia'},
  {code: 'SN', label: 'Senegal'},
  {code: 'RS', label: 'Serbia'},
  {code: 'SC', label: 'Seychelles'},
  {code: 'SL', label: 'Sierra Leone'},
  {code: 'SG', label: 'Singapore'},
  {code: 'SK', label: 'Slovakia'},
  {code: 'SI', label: 'Slovenia'},
  {code: 'SB', label: 'Solomon Islands'},
  {code: 'SO', label: 'Somalia'},
  {code: 'ZA', label: 'South Africa'},
  {code: 'KR', label: 'South Korea'},
  {code: 'SS', label: 'South Sudan'},
  {code: 'ES', label: 'Spain'},
  {code: 'LK', label: 'Sri Lanka'},
  {code: 'SD', label: 'Sudan'},
  {code: 'SR', label: 'Suriname'},
  {code: 'SE', label: 'Sweden'},
  {code: 'CH', label: 'Switzerland'},
  {code: 'SY', label: 'Syria'},
  {code: 'TW', label: 'Taiwan'},
  {code: 'TJ', label: 'Tajikistan'},
  {code: 'TZ', label: 'Tanzania'},
  {code: 'TH', label: 'Thailand'},
  {code: 'TL', label: 'Timor-Leste'},
  {code: 'TG', label: 'Togo'},
  {code: 'TO', label: 'Tonga'},
  {code: 'TT', label: 'Trinidad & Tobago'},
  {code: 'TN', label: 'Tunisia'},
  {code: 'TR', label: 'Turkey'},
  {code: 'TM', label: 'Turkmenistan'},
  {code: 'TV', label: 'Tuvalu'},
  {code: 'AE', label: 'UAE'},
  {code: 'GB', label: 'UK'},
  {code: 'UG', label: 'Uganda'},
  {code: 'UA', label: 'Ukraine'},
  {code: 'US', label: 'United States'},
  {code: 'UY', label: 'Uruguay'},
  {code: 'UZ', label: 'Uzbekistan'},
  {code: 'VU', label: 'Vanuatu'},
  {code: 'VE', label: 'Venezuela'},
  {code: 'VN', label: 'Vietnam'},
  {code: 'YE', label: 'Yemen'},
  {code: 'ZM', label: 'Zambia'},
  {code: 'ZW', label: 'Zimbabwe'},
];

/** Mirrors the server's MAX_COUNTRIES (newsfeed.service.ts) — selections past
 *  this are silently dropped there, so the prefs screen enforces it up front. */
export const MAX_SELECTED_COUNTRIES = 6;

/**
 * The ONE category vocabulary. Founder 2026-08-09: the Bravo Feed chips must
 * be "exactly the same as in the News Filter", so both read this list and the
 * Bravo Feed's filter type is derived from these ids — a new category cannot
 * be added to one surface and forgotten on the other.
 */
export type NewsCategoryId =
  | 'top' | 'world' | 'business' | 'finance' | 'security'
  | 'technology' | 'energy' | 'defence' | 'aviation' | 'realestate';

export const NEWS_CATEGORIES: Array<{id: NewsCategoryId; label: string}> = [
  {id: 'top',        label: 'Top Stories'},
  {id: 'world',      label: 'World'},
  {id: 'business',   label: 'Business'},
  {id: 'finance',    label: 'Finance'},
  {id: 'security',   label: 'Security'},
  {id: 'technology', label: 'Technology'},
  {id: 'energy',     label: 'Energy'},
  {id: 'defence',    label: 'Defence'},
  {id: 'aviation',   label: 'Aviation'},
  {id: 'realestate', label: 'Real Estate'},
];

export const DEFAULT_NEWS_PREFS: NewsPrefs = {
  countries:  ['AE', 'SA', 'GLOBAL'],
  categories: ['top', 'business', 'finance', 'security'],
};

const PREFS_KEY_V2 = 'bravo.news.prefs.v2';
// v1 shape ({topics, regions}) written by the pre-country prefs screen.
const PREFS_KEY_V1 = 'bravo.news.prefs.v1';

const V1_TOPIC_TO_CATEGORY: Record<string, string> = {
  'business': 'business', 'finance': 'finance', 'security': 'security',
  'energy': 'energy', 'technology': 'technology', 'defence': 'defence',
  'aviation': 'aviation', 'real estate': 'realestate',
};
const V1_REGION_TO_COUNTRY: Record<string, string> = {
  ae: 'AE', sa: 'SA', gb: 'GB', global: 'GLOBAL',
};

function sanitize(p: Partial<NewsPrefs> | null | undefined): NewsPrefs {
  const countries = (p?.countries ?? [])
    .filter(c => NEWS_COUNTRIES.some(n => n.code === c))
    .slice(0, MAX_SELECTED_COUNTRIES);
  const categories = (p?.categories ?? [])
    .filter(c => NEWS_CATEGORIES.some(n => n.id === c));
  return {
    countries:  countries.length ? countries : DEFAULT_NEWS_PREFS.countries,
    categories: categories.length ? categories : DEFAULT_NEWS_PREFS.categories,
  };
}

export async function loadNewsPrefs(): Promise<NewsPrefs> {
  try {
    const raw = await AsyncStorage.getItem(PREFS_KEY_V2);
    if (raw) {return sanitize(JSON.parse(raw) as Partial<NewsPrefs>);}

    // One-time migration from the v1 topics/regions shape.
    const v1raw = await AsyncStorage.getItem(PREFS_KEY_V1);
    if (v1raw) {
      const v1 = JSON.parse(v1raw) as {topics?: string[]; regions?: Record<string, boolean>};
      const countries = Object.entries(v1.regions ?? {})
        .filter(([, on]) => on)
        .map(([id]) => V1_REGION_TO_COUNTRY[id])
        .filter((c): c is string => !!c);
      const categories = (v1.topics ?? [])
        .map(t => V1_TOPIC_TO_CATEGORY[t.toLowerCase()])
        .filter((c): c is string => !!c);
      if (v1.regions?.tech && !categories.includes('technology')) {categories.push('technology');}
      const migrated = sanitize({countries, categories});
      await saveNewsPrefs(migrated);
      return migrated;
    }
  } catch {/* corrupt/missing — defaults */}
  return DEFAULT_NEWS_PREFS;
}

export async function saveNewsPrefs(prefs: NewsPrefs): Promise<void> {
  try {
    await AsyncStorage.setItem(PREFS_KEY_V2, JSON.stringify(sanitize(prefs)));
  } catch {/* best-effort */}
}

export function countryLabel(code: string): string {
  return NEWS_COUNTRIES.find(c => c.code === code)?.label ?? code;
}

export function categoryLabel(id: string): string {
  return NEWS_CATEGORIES.find(c => c.id === id)?.label ?? id;
}
