/**
 * RSS → JSON client via rss2json.com.
 *
 * Free tier (no key): 10 requests / hour / IP — good enough to pull a
 * handful of outlets per session alongside the Guardian feed. Optional
 * EXPO_PUBLIC_RSS2JSON_KEY unlocks 10k / day.
 *
 * We intentionally pick outlets whose feeds skew toward world news,
 * defence, and security so they match the "intel" aesthetic without a
 * lot of noise.
 */

import type {GuardianResult} from './guardianClient';
import {safeIso} from './safeDate';
import {fetchWithTimeout} from './httpTimeout';

export interface RssSource {
  /** Used as the `src` label on each IntelItem. */
  name:      string;
  /** Public RSS URL — must be https. */
  feed:      string;
  /** Section tag applied to every item from this feed. */
  section:   string;
}

// Curated list of public RSS feeds with decent world/security coverage.
// These are the canonical public RSS endpoints published by each outlet.
export const RSS_SOURCES: RssSource[] = [
  {name: 'BBC',        feed: 'https://feeds.bbci.co.uk/news/world/rss.xml',             section: 'world'},
  {name: 'REUTERS',    feed: 'https://feeds.reuters.com/Reuters/worldNews',             section: 'world'},
  {name: 'AL JAZEERA', feed: 'https://www.aljazeera.com/xml/rss/all.xml',               section: 'world'},
  {name: 'NYT WORLD',  feed: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',  section: 'world'},
  {name: 'DEFENSE ONE',feed: 'https://www.defenseone.com/rss/all/',                     section: 'military'},
  {name: 'AP',         feed: 'https://feeds.apnews.com/rss/apf-topnews',                section: 'world'},
  {name: 'DW',         feed: 'https://rss.dw.com/xml/rss-en-world',                     section: 'world'},
];

interface Rss2JsonItem {
  title:       string;
  pubDate:     string;
  link:        string;
  guid?:       string;
  description?: string;
  thumbnail?:  string;
  enclosure?:  {link?: string};
  categories?: string[];
}

interface Rss2JsonResponse {
  status:  'ok' | 'error';
  message?: string;
  items?:  Rss2JsonItem[];
  feed?:   {title?: string};
}

const ENDPOINT = 'https://api.rss2json.com/v1/api.json';
const API_KEY  = process.env.EXPO_PUBLIC_RSS2JSON_KEY || '';
// 429s on rss2json are aggressive — keep a per-feed cache around for
// 15 minutes so a user flipping tabs doesn't burn through the free tier.
const CACHE_TTL_MS = 15 * 60 * 1000;

interface CacheEntry {
  results: GuardianResult[];
  at:      number;
}

/** Strip HTML tags + collapse whitespace — RSS descriptions often
 *  include inline `<img>` / `<p>` we don't want in the Wire summary. */
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function toResult(src: RssSource, item: Rss2JsonItem): GuardianResult {
  const thumb = item.thumbnail || item.enclosure?.link;
  const trail = item.description ? stripHtml(item.description).slice(0, 220) : undefined;
  return {
    id:                 `${src.name.toLowerCase()}/${item.guid ?? item.link}`,
    webTitle:           item.title,
    webUrl:             item.link,
    sectionId:          src.section,
    sectionName:        src.name,
    webPublicationDate: safeIso(item.pubDate),
    fields: {
      trailText: trail,
      thumbnail: thumb || undefined,
    },
  };
}

export class RssClient {
  private cache = new Map<string, CacheEntry>();
  private cooldownUntil = 0;

  async fetchOne(src: RssSource, signal?: AbortSignal): Promise<GuardianResult[]> {
    const now = Date.now();
    const cached = this.cache.get(src.feed);
    if (cached && now - cached.at < CACHE_TTL_MS) {return cached.results;}
    if (now < this.cooldownUntil) {return cached?.results ?? [];}

    const params = new URLSearchParams({rss_url: src.feed, count: '20'});
    if (API_KEY) {params.set('api_key', API_KEY);}

    try {
      const res = await fetchWithTimeout(`${ENDPOINT}?${params.toString()}`, {signal});
      if (res.status === 429) {
        // 10 min cooldown across ALL rss2json feeds to avoid hammering.
        this.cooldownUntil = now + 10 * 60 * 1000;
        return cached?.results ?? [];
      }
      if (!res.ok) {return cached?.results ?? [];}
      const data = (await res.json()) as Rss2JsonResponse;
      if (data.status !== 'ok' || !data.items) {return cached?.results ?? [];}
      const results = data.items.map(it => toResult(src, it));
      this.cache.set(src.feed, {results, at: now});
      return results;
    } catch {
      return cached?.results ?? [];
    }
  }

  async fetchAll(sources: RssSource[] = RSS_SOURCES, signal?: AbortSignal): Promise<GuardianResult[]> {
    const all = await Promise.all(sources.map(s => this.fetchOne(s, signal)));
    return all.flat();
  }
}

export const rssClient = new RssClient();
