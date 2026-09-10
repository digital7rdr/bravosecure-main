/**
 * Intel aggregator.
 *
 * Fans out to every free news source we have (Guardian, RSS, Reddit,
 * HackerNews), merges the results, dedupes by URL + headline prefix,
 * and returns a single time-sorted list. Each source is allowed to
 * fail independently — one rate-limited endpoint won't wipe the feed.
 *
 * The per-filter query mapping lives here too so the UI only needs to
 * call `fetchIntel(filter)`.
 */

import {guardianClient, GuardianRateLimitError, type GuardianResult} from './guardianClient';
import {rssClient, RSS_SOURCES, type RssSource} from './rssClient';
import {redditClient, REDDIT_SOURCES, type RedditSource} from './redditClient';
import {hackerNewsClient} from './hackerNewsClient';
import {fetchBravoNews} from './bravoNewsClient';
import {parseDateMs} from './safeDate';
import type {WireFilter} from './useIntelFeed';

export interface FetchIntelResult {
  results:  GuardianResult[];
  /** Number of source endpoints that returned data. */
  sources:  number;
  /** True when every network call failed — caller should show an error. */
  failed:   boolean;
  /** True when at least one source was rate-limited. */
  limited:  boolean;
}

interface GuardianQuery {
  section?: string;
  q?:       string;
}

function guardianQueryFor(filter: WireFilter): GuardianQuery {
  switch (filter) {
    // Section-backed: Guardian has a real section for these.
    case 'world':      return {section: 'world'};
    case 'business':   return {section: 'business'};
    case 'technology': return {section: 'technology'};
    // Keyword-backed: no Guardian section maps cleanly, so query instead.
    case 'security':   return {q: 'security OR intelligence OR terror OR cyber'};
    case 'defence':    return {q: 'military OR defence OR army OR navy OR nato'};
    case 'finance':    return {q: 'markets OR stocks OR inflation OR economy OR currency'};
    case 'energy':     return {q: 'energy OR oil OR gas OR renewables OR grid'};
    case 'aviation':   return {q: 'aviation OR airline OR aircraft OR airport'};
    case 'realestate': return {q: 'property OR "real estate" OR housing'};
    // Top Stories is deliberately broad — the RSS/Reddit blend below carries
    // the headline mix, so pinning a section here would narrow it.
    case 'top':
    case 'ALL':
    default:           return {section: 'world'};
  }
}

/** Filters with no Guardian section — their pool needs client-side gating. */
const KEYWORD_FILTERS: ReadonlySet<WireFilter> = new Set<WireFilter>([
  'security', 'defence', 'finance', 'energy', 'aviation', 'realestate',
]);

/**
 * Decide which extra sources to hit for a given filter. Keyword-based
 * filters (SECURITY/MILITARY/CRITICAL) fan out wider because Guardian
 * has low volume on those topics; section-based filters stay focused.
 */
function auxSourcesFor(filter: WireFilter): {rss: RssSource[]; reddit: RedditSource[]; useHn: boolean} {
  switch (filter) {
    case 'security':
      return {
        rss:    RSS_SOURCES.filter(s => ['DEFENSE ONE', 'REUTERS', 'BBC'].includes(s.name)),
        reddit: REDDIT_SOURCES.filter(s => ['cybersecurity', 'worldnews'].includes(s.sub)),
        useHn:  true,
      };
    case 'defence':
      return {
        rss:    RSS_SOURCES.filter(s => ['DEFENSE ONE', 'AL JAZEERA', 'REUTERS'].includes(s.name)),
        reddit: REDDIT_SOURCES.filter(s => ['geopolitics', 'worldnews'].includes(s.sub)),
        useHn:  false,
      };
    case 'world':
      return {
        rss:    RSS_SOURCES.filter(s => ['NYT WORLD', 'BBC', 'DW', 'AP'].includes(s.name)),
        reddit: REDDIT_SOURCES.filter(s => ['geopolitics', 'worldnews'].includes(s.sub)),
        useHn:  false,
      };
    case 'technology':
      // HN is the strongest tech signal we have; RSS/Reddit add little.
      return {rss: [], reddit: [], useHn: true};
    case 'business':
    case 'finance':
    case 'realestate':
      return {rss: [], reddit: [], useHn: false};
    case 'energy':
    case 'aviation':
      return {
        rss:    RSS_SOURCES.filter(s => ['REUTERS', 'BBC', 'AP'].includes(s.name)),
        reddit: [],
        useHn:  false,
      };
    case 'top':
    case 'ALL':
    default:
      return {rss: RSS_SOURCES, reddit: REDDIT_SOURCES, useHn: true};
  }
}

/**
 * Heuristic keyword filter so the aggregated pool reflects the chip
 * the user picked. Guardian is already filtered server-side; we apply
 * this client-side to RSS / Reddit / HN only.
 */
const CATEGORY_PATTERNS: Partial<Record<WireFilter, RegExp>> = {
  world:      /(election|president|minister|parliament|government|sanction|diplomat|summit|border|vote)/,
  business:   /(business|company|profit|revenue|merger|earnings|industry|retail|supply chain)/,
  finance:    /(market|stock|economy|bank|inflation|trade|tariff|gdp|fund|finance|currency|bond)/,
  security:   /(security|intelligence|terror|cyber|breach|hack|espionage|surveillance|police)/,
  technology: /(tech|software|ai\b|artificial intelligence|chip|semiconductor|startup|data|app|digital)/,
  energy:     /(energy|oil|gas|petrol|renewab|solar|wind farm|nuclear|grid|pipeline|opec)/,
  defence:    /(military|army|navy|defen[cs]e|troop|missile|strike|weapon|drone|nato|conflict|war)/,
  aviation:   /(aviation|airline|aircraft|airport|flight|boeing|airbus|jet\b|runway)/,
  realestate: /(property|real estate|housing|mortgage|rent|landlord|construction|developer)/,
  // 'top' has no pattern — Top Stories is everything, gated only by recency.
};

/** Text-based core so callers holding a rendered row (not a Guardian result)
 *  can reuse the same vocabulary. Caller lower-cases. */
export function matchesCategoryText(filter: WireFilter, text: string): boolean {
  if (filter === 'ALL' || filter === 'top') {return true;}
  const pattern = CATEGORY_PATTERNS[filter];
  return pattern ? pattern.test(text) : true;
}

function keywordMatch(filter: WireFilter, r: GuardianResult): boolean {
  return matchesCategoryText(filter, `${r.webTitle} ${r.fields?.trailText ?? ''}`.toLowerCase());
}

/**
 * Founder 2026-08-09 — the News Filter selection must shape the Bravo Feed,
 * not just My Feed. On the ALL chip the pool is gated to the union of the
 * user's saved categories, so "Security + Defence" no longer surfaces sport.
 * An empty selection means "no preference" and passes everything through, as
 * does Top Stories (which is by definition unfiltered).
 */
export function matchesAnyCategory(cats: readonly WireFilter[], text: string): boolean {
  if (cats.length === 0 || cats.includes('top')) {return true;}
  return cats.some(c => matchesCategoryText(c, text));
}

/** Normalise a URL for dedup: strip query + hash + trailing slash. */
function normaliseUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return u;
  }
}

function titleKey(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
}

function dedupe(results: GuardianResult[]): GuardianResult[] {
  const byUrl = new Map<string, GuardianResult>();
  const byTitle = new Map<string, GuardianResult>();
  for (const r of results) {
    const urlKey = normaliseUrl(r.webUrl);
    const tKey = titleKey(r.webTitle);
    if (byUrl.has(urlKey) || byTitle.has(tKey)) {continue;}
    byUrl.set(urlKey, r);
    byTitle.set(tKey, r);
  }
  return Array.from(byUrl.values());
}

export async function fetchIntel(
  filter: WireFilter,
  signal?: AbortSignal,
): Promise<FetchIntelResult> {
  const aux = auxSourcesFor(filter);
  const gq = guardianQueryFor(filter);

  // Fan out every call in parallel — each source handles its own errors
  // and rate limits internally. Guardian goes through the error model so
  // we can surface a "limited" banner; everything else returns [] on
  // failure rather than throwing.
  const guardianP = guardianClient
    .search({...gq, pageSize: 25, signal})
    .then(r => ({ok: true as const, results: r, limited: false}))
    .catch(e => {
      if (e instanceof GuardianRateLimitError) {
        return {ok: true as const, results: e.stale ?? [], limited: true};
      }
      return {ok: false as const, results: [] as GuardianResult[], limited: false};
    });
  const rssP    = aux.rss.length    ? rssClient.fetchAll(aux.rss, signal)       : Promise.resolve([] as GuardianResult[]);
  const redditP = aux.reddit.length ? redditClient.fetchAll(aux.reddit, signal) : Promise.resolve([] as GuardianResult[]);
  const hnP     = aux.useHn         ? hackerNewsClient.search(undefined, signal) : Promise.resolve([] as GuardianResult[]);
  // Bravo OSINT — the server's country-scoped curated blend. Every row
  // carries a resolved country pin, so these are the enriched map points.
  // (The WORLDWIDE sweep is deliberately NOT awaited here — it loads in a
  // second phase via selectWorldExtras so a cold server sweep can never
  // stall the wire list. "The app must not be slow" is a founder rule.)
  const bravoP  = fetchBravoNews(filter);

  const [guardian, rss, reddit, hn, bravo] = await Promise.all([guardianP, rssP, redditP, hnP, bravoP]);

  // Apply the keyword filter to the aux sources so a user on SECURITY
  // doesn't see generic BBC World headlines leaking through. Bravo rows
  // skip it — they are already category-filtered server-side, and their
  // country-local phrasing would fail the English keyword heuristics.
  // EXCEPT on the keyword-backed chips (security/defence/finance/energy/
  // aviation/realestate): those have no server section to scope by, so their
  // rows must still pass the keyword gate.
  const bravoRows = categoryGate(filter, bravo);
  const auxAll = [...rss, ...reddit, ...hn].filter(r => keywordMatch(filter, r));

  const merged = [...guardian.results, ...bravoRows, ...auxAll];
  const deduped = dedupe(merged);

  // Newest-first; keeps Guardian-first bias because it hits the array
  // first AND most sources publish close to real time anyway. Invalid
  // dates sort to the bottom (treated as epoch 0) so a NaN comparator
  // can't scramble the order.
  deduped.sort((a, b) =>
    (parseDateMs(b.webPublicationDate) ?? 0) - (parseDateMs(a.webPublicationDate) ?? 0),
  );

  const activeSources =
    (guardian.results.length > 0 ? 1 : 0) +
    (bravo.length  > 0 ? 1 : 0) +
    (rss.length    > 0 ? 1 : 0) +
    (reddit.length > 0 ? 1 : 0) +
    (hn.length     > 0 ? 1 : 0);

  return {
    results: deduped.slice(0, 60),
    sources: activeSources,
    failed:  !guardian.ok && bravo.length === 0 && auxAll.length === 0,
    limited: guardian.limited,
  };
}

/**
 * Keyword-backed filters have no Guardian section, so the worldwide sweep
 * comes back unscoped — gate it client-side or the map fills with rows the
 * chip never asked for. (Was `sevGate`, which existed only for the removed
 * CRITICAL severity chip.)
 */
function categoryGate(filter: WireFilter, rows: GuardianResult[]): GuardianResult[] {
  return KEYWORD_FILTERS.has(filter) ? rows.filter(r => keywordMatch(filter, r)) : rows;
}

/**
 * Phase-two world layer: everything from the worldwide sweep that isn't
 * already on the wire list — plotted on the Bravo Map only, so every
 * continent lights up without bloating the personal wire feed.
 */
export function selectWorldExtras(
  filter: WireFilter,
  results: GuardianResult[],
  world: GuardianResult[],
): GuardianResult[] {
  const seenUrls   = new Set(results.map(r => normaliseUrl(r.webUrl)));
  const seenTitles = new Set(results.map(r => titleKey(r.webTitle)));
  return dedupe(categoryGate(filter, world)).filter(
    r => !seenUrls.has(normaliseUrl(r.webUrl)) && !seenTitles.has(titleKey(r.webTitle)),
  );
}
