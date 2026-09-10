/**
 * HackerNews via the public Algolia search API.
 *
 * No key, generous rate limits (documented as "reasonable use"). We
 * pull front-page stories and filter by keywords so the SIGNALS tab
 * can surface cyber / infra / defence-tech chatter alongside the
 * mainstream news sources.
 */

import type {GuardianResult} from './guardianClient';
import {fetchWithTimeout} from './httpTimeout';

interface HnHit {
  objectID:     string;
  title?:       string;
  story_title?: string;
  url?:         string;
  story_url?:   string;
  author?:      string;
  points?:      number;
  num_comments?:number;
  created_at:   string;
  _tags?:       string[];
}

interface HnSearchResponse {
  hits: HnHit[];
}

const ENDPOINT = 'https://hn.algolia.com/api/v1/search_by_date';
const CACHE_TTL_MS = 15 * 60 * 1000;

interface CacheEntry {
  results: GuardianResult[];
  at:      number;
}

function toResult(hit: HnHit): GuardianResult {
  const title = hit.title || hit.story_title || 'Untitled';
  const url = hit.url || hit.story_url || `https://news.ycombinator.com/item?id=${hit.objectID}`;
  return {
    id:                 `hn/${hit.objectID}`,
    webTitle:           title,
    webUrl:             url,
    sectionId:          'security',
    sectionName:        'HACKER NEWS',
    webPublicationDate: hit.created_at,
    fields: {
      trailText: `${hit.points ?? 0} points · ${hit.num_comments ?? 0} comments · via HN`,
    },
  };
}

export class HackerNewsClient {
  private cache = new Map<string, CacheEntry>();

  /**
   * Search HN for the last 48 hours matching any of the supplied keywords.
   * Defaults target the intel aesthetic: cyber, security, infra.
   */
  async search(
    keywords: string[] = ['cyber', 'security', 'breach', 'hacked', 'vulnerability', 'infrastructure'],
    signal?: AbortSignal,
  ): Promise<GuardianResult[]> {
    const key = keywords.join('|');
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && now - cached.at < CACHE_TTL_MS) {return cached.results;}

    const q = keywords.join(' OR ');
    const params = new URLSearchParams({
      query:   q,
      tags:    'story',
      numericFilters: `created_at_i>${Math.floor((now - 48 * 3600 * 1000) / 1000)}`,
      hitsPerPage: '20',
    });

    try {
      const res = await fetchWithTimeout(`${ENDPOINT}?${params.toString()}`, {signal});
      if (!res.ok) {return cached?.results ?? [];}
      const data = (await res.json()) as HnSearchResponse;
      const results = (data.hits ?? [])
        .filter(h => h.title || h.story_title)
        .map(toResult);
      this.cache.set(key, {results, at: now});
      return results;
    } catch {
      return cached?.results ?? [];
    }
  }
}

export const hackerNewsClient = new HackerNewsClient();
