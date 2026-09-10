/**
 * Reddit public JSON client.
 *
 * No API key required: appending `.json` to any listing URL gives back
 * a public feed we can render as intel items. We pick subs that skew
 * toward world news, geopolitics, and security so they complement the
 * Guardian + RSS sources already wired into the feed.
 *
 * Reddit's unauthenticated rate limit is "a few requests / minute /
 * IP" — we keep an in-memory cache so filter flips don't rehit it.
 */

import type {GuardianResult} from './guardianClient';
import {fetchWithTimeout} from './httpTimeout';

export interface RedditSource {
  sub:      string;      // e.g. 'worldnews'
  label:    string;      // shown as source name
  section:  string;      // section tag
}

export const REDDIT_SOURCES: RedditSource[] = [
  {sub: 'worldnews',    label: 'REDDIT WORLD',   section: 'world'},
  {sub: 'geopolitics',  label: 'REDDIT GEOPOL',  section: 'world'},
  {sub: 'news',         label: 'REDDIT NEWS',    section: 'world'},
  {sub: 'cybersecurity',label: 'REDDIT CYBER',   section: 'security'},
];

interface RedditPost {
  data: {
    id:           string;
    title:        string;
    url:          string;
    permalink:    string;
    created_utc:  number;
    selftext?:    string;
    thumbnail?:   string;
    domain:       string;
    is_self:      boolean;
    over_18:      boolean;
  };
}

interface RedditListing {
  data?: {children?: RedditPost[]};
}

const CACHE_TTL_MS = 15 * 60 * 1000;

interface CacheEntry {
  results: GuardianResult[];
  at:      number;
}

function toResult(src: RedditSource, post: RedditPost['data']): GuardianResult {
  const url = post.is_self ? `https://www.reddit.com${post.permalink}` : post.url;
  const thumb = post.thumbnail?.startsWith('http') ? post.thumbnail : undefined;
  const trail = post.selftext ? post.selftext.slice(0, 220) : `Discussion on r/${src.sub} · ${post.domain}`;
  return {
    id:                 `reddit/${src.sub}/${post.id}`,
    webTitle:           post.title,
    webUrl:             url,
    sectionId:          src.section,
    sectionName:        src.label,
    webPublicationDate: new Date(post.created_utc * 1000).toISOString(),
    fields: {trailText: trail, thumbnail: thumb},
  };
}

export class RedditClient {
  private cache = new Map<string, CacheEntry>();
  private cooldownUntil = 0;

  async fetchSub(src: RedditSource, signal?: AbortSignal): Promise<GuardianResult[]> {
    const now = Date.now();
    const cached = this.cache.get(src.sub);
    if (cached && now - cached.at < CACHE_TTL_MS) {return cached.results;}
    if (now < this.cooldownUntil) {return cached?.results ?? [];}

    const url = `https://www.reddit.com/r/${src.sub}/hot.json?limit=20&raw_json=1`;
    try {
      const res = await fetchWithTimeout(url, {signal, headers: {'User-Agent': 'BravoSecure/1.0 intel-feed'}});
      if (res.status === 429 || res.status === 403) {
        this.cooldownUntil = now + 10 * 60 * 1000;
        return cached?.results ?? [];
      }
      if (!res.ok) {return cached?.results ?? [];}
      const data = (await res.json()) as RedditListing;
      const posts = data.data?.children ?? [];
      const results = posts
        .filter(p => !p.data.over_18)
        .map(p => toResult(src, p.data));
      this.cache.set(src.sub, {results, at: now});
      return results;
    } catch {
      return cached?.results ?? [];
    }
  }

  async fetchAll(sources: RedditSource[] = REDDIT_SOURCES, signal?: AbortSignal): Promise<GuardianResult[]> {
    const all = await Promise.all(sources.map(s => this.fetchSub(s, signal)));
    return all.flat();
  }
}

export const redditClient = new RedditClient();
