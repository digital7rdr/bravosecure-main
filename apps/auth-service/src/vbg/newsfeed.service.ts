import {Injectable, Logger, type OnModuleDestroy, type OnModuleInit} from '@nestjs/common';
import {hostOf, parsePubDate, parseRssItems} from './googlenews.service';
import {osintDomainsFor, siteClause} from './osintSources';
import {COUNTRY_NAMES} from './countryNames';
import {TtlCache} from './ttlCache';

/**
 * General country/category news feed for the messenger "My Feed" screen.
 *
 * Inherits the VBG intel stack's Google News RSS source (free, no key, no
 * documented cap — see googlenews.service.ts) rather than the threat-scoped
 * query shape: here the user picks COUNTRIES and CATEGORIES in News
 * Preferences and the feed blends one RSS fetch per (country, category)
 * pair. NewsData/GDELT stay reserved for the VBG threat blend — NewsData's
 * 200 credits/day budget must not be spent on general news.
 *
 * Every pair is cached 15 min (TtlCache, bounded) so repeated feed opens
 * are nearly free upstream; a pair that fails resolves to [] and the blend
 * degrades gracefully instead of failing the request.
 */
export interface NewsArticle {
  id:           string;
  title:        string;
  summary:      string;
  url:          string;
  source:       string;
  region:       string;  // 'GLOBAL' or ISO2 ('AE', 'SA', …)
  category:     string;  // display label ('Business', 'Security', …)
  published_at: string;  // ISO, '' when the feed omitted a date
}

interface CategorySpec {
  label:  string;
  /** Google News curated topic id — used for GLOBAL (US edition) fetches. */
  topic?: string;
  /** Search terms OR-ed together — used for country-scoped fetches. */
  terms?: string[];
}

// Keys are the wire ids the mobile prefs screen sends. Labels are what the
// feed cards display. `top` with a country = that country edition's headline
// feed (already country news); with GLOBAL it falls back to the WORLD topic.
const CATEGORIES: Record<string, CategorySpec> = {
  top:        {label: 'Top Stories'},
  world:      {label: 'World',       topic: 'WORLD'},
  business:   {label: 'Business',    topic: 'BUSINESS',   terms: ['business', 'economy', 'trade']},
  technology: {label: 'Technology',  topic: 'TECHNOLOGY', terms: ['technology', 'tech']},
  finance:    {label: 'Finance',     terms: ['finance', 'banking', 'markets']},
  security:   {label: 'Security',    terms: ['security', 'crime', 'police']},
  energy:     {label: 'Energy',      terms: ['energy', 'oil', 'gas']},
  defence:    {label: 'Defence',     terms: ['defence', 'military', '"armed forces"']},
  aviation:   {label: 'Aviation',    terms: ['aviation', 'airline', 'airport']},
  realestate: {label: 'Real Estate', terms: ['"real estate"', '"property market"']},
};

// COUNTRY_NAMES moved to ./countryNames.ts (shared with the VBG threat
// blend's foreign-story screen); imported above.

const MAX_COUNTRIES  = 6;
const MAX_CATEGORIES = 8;
const MAX_PAIRS      = 12;
const PER_PAIR       = 12;
const MAX_TOTAL      = 60;

// Rolling freshness window (founder rule, same as the VBG feed's B-91 M2 R6):
// no article older than 72 hours is ever returned. Enforced strictly at blend
// time — undated items are dropped too, since freshness can't be proven for
// them — and additionally pushed upstream via `when:72h` on search feeds.
const FRESH_WINDOW_MS = 72 * 60 * 60 * 1000;

function freshOnly(items: NewsArticle[], now: number): NewsArticle[] {
  const cutoff = now - FRESH_WINDOW_MS;
  return items.filter(a => {
    const ms = Date.parse(a.published_at);
    return Number.isFinite(ms) && ms >= cutoff;
  });
}

const DEFAULT_COUNTRIES  = ['GLOBAL'];
const DEFAULT_CATEGORIES = ['top'];

// World-map sweep: a representative spread across every continent (all
// covered by the curated OSINT directory) so the Bravo Intel map always has
// worldwide points regardless of the user's ≤6 selected countries
// (founder/Corné report: Africa/Asia rendered empty). Every (country, top)
// pair rides the same 15-min pair cache, and the assembled sweep is cached
// too, so the fan-out is paid at most once per TTL for ALL users.
const WORLD_SPREAD = [
  'ZA', 'NG', 'KE', 'EG', 'ET', 'MA', 'GH', 'SN', 'CI', 'SD', 'TN', 'ZW', // Africa
  'SA', 'AE', 'IL', 'IR', 'TR', 'IQ', 'BH',                               // Middle East
  'IN', 'PK', 'BD', 'CN', 'JP', 'KR', 'ID', 'PH', 'TH', 'MY', 'SG', 'TW', // Asia
  'RU', 'UA', 'GB', 'FR', 'DE', 'PL', 'ES', 'IT', 'GR', 'SE',             // Europe
  'US', 'CA', 'MX', 'BR', 'AR', 'CO', 'PE', 'CL', 'VE',                   // Americas
  'AU', 'NZ', 'FJ',                                                       // Oceania
];
const WORLD_PER_COUNTRY = 2;
// Sweep fan-out runs in waves of this size — 100+ simultaneous requests to
// one upstream from one IP is how you get rate-limited.
const WORLD_BATCH = 12;

async function inBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}

@Injectable()
export class NewsFeedService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(NewsFeedService.name);

  private static readonly TTL_MS = 15 * 60 * 1000;
  private readonly cache = new TtlCache<NewsArticle[]>(NewsFeedService.TTL_MS);
  private warmTimer: ReturnType<typeof setInterval> | null = null;

  // Keep the worldwide sweep HOT for the categories the Intel map opens
  // with, so no user request ever pays the cold fan-out ("the app must not
  // be slow"). Lifecycle hooks only fire inside a Nest app — unit specs
  // constructing the service directly never start the timer.
  onModuleInit(): void {
    const warm = () => {
      for (const cat of ['top', 'security']) {
        this.worldMap(cat).catch(() => {/* warm is best-effort */});
      }
    };
    warm();
    this.warmTimer = setInterval(warm, 10 * 60 * 1000);
    this.warmTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.warmTimer) {clearInterval(this.warmTimer);}
  }

  async feed(countriesCsv?: string, categoriesCsv?: string): Promise<{articles: NewsArticle[]}> {
    const countries  = parseCountries(countriesCsv);
    const categories = parseCategories(categoriesCsv);

    // Country-major pair order so every selected country appears even when
    // the pair cap truncates the category tail.
    const pairs: Array<{country: string; cat: string}> = [];
    for (const cat of categories) {
      for (const country of countries) {
        pairs.push({country, cat});
      }
    }
    const capped = pairs.slice(0, MAX_PAIRS);
    if (capped.length < pairs.length) {
      this.log.warn(`news feed pair cap: ${pairs.length} requested, fetching ${capped.length}`);
    }

    const lists = await Promise.all(capped.map(p => this.fetchPair(p.country, p.cat)));

    // Freshness is applied AFTER the cache read so cached items age out of
    // the window in real time rather than living a full TTL past it.
    const now = Date.now();
    const seen = new Set<string>();
    const out: NewsArticle[] = [];
    for (const list of lists) {
      for (const a of freshOnly(list, now)) {
        const dedup = a.title.toLowerCase().slice(0, 60);
        if (seen.has(dedup)) {continue;}
        seen.add(dedup);
        out.push(a);
      }
    }
    out.sort((x, y) => (Date.parse(y.published_at) || 0) - (Date.parse(x.published_at) || 0));
    return {articles: out.slice(0, MAX_TOTAL)};
  }

  /**
   * Top-N fresh stories per WORLD_SPREAD country — the Bravo Map's always-on
   * worldwide layer. Category-aware (Corné's spec): Globe + "Security" must
   * plot SECURITY signals on every continent, so the sweep runs the chosen
   * category (one per request — fan-out is 35 pairs as it is) against every
   * spread country. Assembled result cached per category.
   */
  async worldMap(categoryCsv?: string): Promise<{articles: NewsArticle[]}> {
    const cat = parseCategories(categoryCsv)[0] ?? 'top';
    const key = `nf:worldmap:${cat}`;
    const hit = this.cache.get(key);
    if (hit) {return {articles: hit};}

    const lists = await inBatches(WORLD_SPREAD, WORLD_BATCH, c => this.fetchPair(c, cat));
    const now = Date.now();
    const seen = new Set<string>();
    const out: NewsArticle[] = [];
    for (const list of lists) {
      let taken = 0;
      for (const a of freshOnly(list, now)) {
        const dedup = a.title.toLowerCase().slice(0, 60);
        if (seen.has(dedup)) {continue;}
        seen.add(dedup);
        out.push(a);
        if (++taken >= WORLD_PER_COUNTRY) {break;}
      }
    }
    this.cache.set(key, out);
    return {articles: out};
  }

  /**
   * One (country, category) fetch: the open Google News feed PLUS, where the
   * country is covered by the curated OSINT outlet directory, a site:-scoped
   * search over exactly those outlets. Cached as one pair; each half resolves
   * [] on failure so the other still serves.
   */
  private async fetchPair(country: string, catKey: string): Promise<NewsArticle[]> {
    const key = `nf:${country}:${catKey}`;
    const hit = this.cache.get(key);
    if (hit) {return hit;}

    const spec = CATEGORIES[catKey];
    const urls = [buildFeedUrl(country, catKey, spec)];
    const curated = buildCuratedFeedUrl(country, spec);
    if (curated) {urls.push(curated);}

    const lists = await Promise.all(urls.map(u => this.fetchList(u, country, spec, catKey)));
    const seen = new Set<string>();
    const out: NewsArticle[] = [];
    for (const list of lists) {
      for (const a of list) {
        const dedup = a.title.toLowerCase().slice(0, 60);
        if (seen.has(dedup)) {continue;}
        seen.add(dedup);
        out.push(a);
      }
    }
    this.cache.set(key, out);
    return out;
  }

  /** One RSS URL → articles, capped at PER_PAIR; [] on any failure. */
  private async fetchList(url: string, country: string, spec: CategorySpec, catKey: string): Promise<NewsArticle[]> {
    try {
      const res = await fetch(url, {
        method: 'GET',
        // Browser-shaped UA — same reason as googlenews.service (bot UAs can
        // be bounced to a consent interstitial).
        headers: {'User-Agent': 'Mozilla/5.0 (compatible; BravoSecure/1.0; +news)'},
        signal: AbortSignal.timeout(6_000),
      });
      if (!res.ok) {
        this.log.warn(`news feed ${res.status} for ${country}/${catKey}`);
        return [];
      }
      const xml = await res.text();
      const seen = new Set<string>();
      const out: NewsArticle[] = [];
      for (const it of parseRssItems(xml)) {
        const dedup = it.title.toLowerCase().slice(0, 60);
        if (seen.has(dedup)) {continue;}
        seen.add(dedup);
        const source = it.source || hostOf(it.link) || 'google news';
        out.push({
          id:           idFor(it.link),
          title:        stripOutletSuffix(it.title, source),
          summary:      '',
          url:          it.link,
          source,
          region:       country,
          category:     spec.label,
          published_at: parsePubDate(it.pubDate),
        });
        if (out.length >= PER_PAIR) {break;}
      }
      return out;
    } catch (e) {
      this.log.warn(`news feed fetch failed for ${country}/${catKey}: ${(e as Error).message}`);
      return [];
    }
  }
}

function parseCountries(csv?: string): string[] {
  const tokens = (csv ?? '')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(t => t === 'GLOBAL' || /^[A-Z]{2}$/.test(t));
  const unique = Array.from(new Set(tokens)).slice(0, MAX_COUNTRIES);
  return unique.length ? unique : DEFAULT_COUNTRIES;
}

function parseCategories(csv?: string): string[] {
  const tokens = (csv ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(t => t in CATEGORIES);
  const unique = Array.from(new Set(tokens)).slice(0, MAX_CATEGORIES);
  return unique.length ? unique : DEFAULT_CATEGORIES;
}

function buildFeedUrl(country: string, catKey: string, spec: CategorySpec): string {
  const gl = country === 'GLOBAL' ? 'US' : country;
  const edition = `hl=en&gl=${gl}&ceid=${gl}:en`;

  if (country === 'GLOBAL') {
    if (spec.topic) {return `https://news.google.com/rss/headlines/section/topic/${spec.topic}?${edition}`;}
    if (spec.terms) {
      const q = encodeURIComponent(`(${spec.terms.join(' OR ')}) when:72h`);
      return `https://news.google.com/rss/search?q=${q}&${edition}`;
    }
    // 'top' with no country — world headlines.
    return `https://news.google.com/rss/headlines/section/topic/WORLD?${edition}`;
  }

  // Country-scoped: ALWAYS a search about the country (articles ABOUT it —
  // founder rule: a selected country returns only that country's news, never
  // whatever its papers also publish about the rest of the world). Google's
  // search matches full text, so domestic stories that omit the country name
  // in the headline still qualify. Topic feeds only for name-less categories.
  const name = COUNTRY_NAMES[country] ?? country;
  if (spec.terms) {
    const q = encodeURIComponent(`"${name}" (${spec.terms.join(' OR ')}) when:72h`);
    return `https://news.google.com/rss/search?q=${q}&${edition}`;
  }
  if (spec.topic) {return `https://news.google.com/rss/headlines/section/topic/${spec.topic}?${edition}`;}
  // 'top' — everything about the country, from its edition. NOT the edition's
  // own headline feed: that is "what this country's readers see" and is full
  // of world stories (the geo/ section would be the canonical shape but
  // returns 0 items for many editions — probed 2026-07-31: SA/AE empty,
  // ZA fine — so the name search is the reliable industry shape).
  const q = encodeURIComponent(`"${name}" when:72h`);
  return `https://news.google.com/rss/search?q=${q}&${edition}`;
}

/**
 * Curated-outlet feed for a (country, category): a Google News search scoped
 * to the founder's OSINT directory domains for that country AND to the
 * country itself. The name clause is mandatory (founder rule, 2026-07-31):
 * without it a country's papers contribute everything they publish — a UAE
 * paper's Philippines story showed up under UAE. Google matches the name in
 * full text, so domestic stories without it in the headline still qualify.
 * Returns null when the country has no curated coverage.
 */
function buildCuratedFeedUrl(country: string, spec: CategorySpec): string | null {
  const domains = osintDomainsFor(country);
  if (domains.length === 0) {return null;}
  const gl = country === 'GLOBAL' ? 'US' : country;
  const name = country === 'GLOBAL' ? '' : `"${COUNTRY_NAMES[country] ?? country}" `;
  const terms = spec.terms ? ` (${spec.terms.join(' OR ')})` : '';
  const q = encodeURIComponent(`${name}${siteClause(domains)}${terms} when:72h`);
  return `https://news.google.com/rss/search?q=${q}&hl=en&gl=${gl}&ceid=${gl}:en`;
}

/** Google News titles arrive as "Headline - Outlet"; the outlet renders separately. */
function stripOutletSuffix(title: string, source: string): string {
  const suffix = ` - ${source}`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title;
}

/** Stable id from the article URL (djb2), so client keys survive refetches. */
function idFor(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) {h = ((h << 5) + h + url.charCodeAt(i)) | 0;}
  return 'gn' + (h >>> 0).toString(36);
}
