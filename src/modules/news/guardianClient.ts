/**
 * Guardian Open Platform client.
 *
 * Free tier quick start:
 *   - Dev key: the literal string "test" works for light read traffic
 *     (per https://open-platform.theguardian.com). Swap for a real key
 *     in production via EXPO_PUBLIC_GUARDIAN_API_KEY.
 *   - Endpoints: content.guardianapis.com/search
 *     (docs: https://open-platform.theguardian.com/documentation/)
 *
 * We hit `/search` with `show-fields=trailText,thumbnail,short-url`
 * so we can render headlines with body text + a thumbnail + canonical
 * share link without needing a second call per item.
 *
 * Two-tier cache: in-memory (short TTL, fast) + AsyncStorage (long TTL,
 * survives relaunch). A cold start reads the persisted cache first so
 * the user sees intel immediately even if we're mid-cooldown.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {fetchWithTimeout} from './httpTimeout';

export interface GuardianResult {
  id:             string;
  webTitle:       string;
  webUrl:         string;
  sectionId:      string;   // e.g. "world", "business", "politics"
  sectionName:    string;
  webPublicationDate: string;
  pillarName?:    string;
  fields?: {
    trailText?:   string;
    thumbnail?:   string;
    'short-url'?: string;
  };
  /** Pre-resolved map pin — set by sources that KNOW the article's country
   *  (the Bravo OSINT feed carries an ISO2 region); wins over headline
   *  geotagging in toIntelItem. */
  geo?:           {lat: number; lng: number; label: string};
  /** Display source override ("GULF NEWS"); default is GUARDIAN. */
  sourceTag?:     string;
}

interface GuardianSearchResponse {
  response: {
    status:       'ok' | 'error';
    total:        number;
    pageSize:     number;
    currentPage:  number;
    pages:        number;
    results:      GuardianResult[];
  };
}

const DEFAULT_BASE = 'https://content.guardianapis.com';
const DEFAULT_KEY  = process.env.EXPO_PUBLIC_GUARDIAN_API_KEY || 'test';

/** In-memory cache TTL — the "test" key is capped at 12 calls/sec &
 *  500/day. 10 minutes lets the user flip filters all session without
 *  burning quota. */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** Persisted (AsyncStorage) cache — kept much longer so a cold start
 *  after a rate-limit can still populate the feed while the aggregator
 *  blends in fresh items from the no-key sources. */
const PERSIST_TTL_MS = 6 * 60 * 60 * 1000;
/** On 429 we back off this long before even trying again. Bumped from
 *  30 s → 5 min so we don't re-hit the quota the second the user swipes. */
const BACKOFF_MS   = 5 * 60 * 1000;
const PERSIST_PREFIX = 'bravo:intel:guardian:';

export interface GuardianSearchOptions {
  /** Free-text query. Blank returns editorial home selection. */
  q?:       string;
  /** Section filter — e.g. "world", "business", "politics", "sport". */
  section?: string;
  /** Number of results (1–50). Default 20. */
  pageSize?: number;
  /** Newest-first ("newest") or relevance ("relevance"). Default "newest". */
  orderBy?: 'newest' | 'oldest' | 'relevance';
  /** AbortSignal so callers can cancel stale fetches on unmount. */
  signal?:  AbortSignal;
}

interface CacheEntry {
  results: GuardianResult[];
  at:      number;
}

export class GuardianRateLimitError extends Error {
  readonly status = 429;
  /** The cached results we fell back to, if any — lets the UI keep
   *  rendering stale data instead of a blank error state. */
  constructor(public readonly stale: GuardianResult[] | null, message = 'Guardian API 429') {
    super(message);
    this.name = 'GuardianRateLimitError';
  }
}

export class GuardianClient {
  private cache = new Map<string, CacheEntry>();
  private cooldownUntil = 0;

  constructor(
    private readonly apiKey: string = DEFAULT_KEY,
    private readonly baseUrl: string = DEFAULT_BASE,
  ) {}

  private async loadPersisted(key: string): Promise<GuardianResult[] | null> {
    try {
      const raw = await AsyncStorage.getItem(PERSIST_PREFIX + key);
      if (!raw) {return null;}
      const entry = JSON.parse(raw) as CacheEntry;
      if (Date.now() - entry.at > PERSIST_TTL_MS) {return null;}
      // Warm the in-memory cache so subsequent hits short-circuit fast.
      this.cache.set(key, entry);
      return entry.results;
    } catch {
      return null;
    }
  }

  private persist(key: string, entry: CacheEntry): void {
    // Fire-and-forget — a failed write just means we re-fetch next launch.
    AsyncStorage.setItem(PERSIST_PREFIX + key, JSON.stringify(entry)).catch(() => {});
  }

  async search(opts: GuardianSearchOptions = {}): Promise<GuardianResult[]> {
    const params = new URLSearchParams({
      'api-key':     this.apiKey,
      'show-fields': 'trailText,thumbnail,shortUrl',
      'page-size':   String(opts.pageSize ?? 20),
      'order-by':    opts.orderBy ?? 'newest',
    });
    if (opts.q)       {params.set('q', opts.q);}
    if (opts.section) {params.set('section', opts.section);}

    const key = params.toString();
    const now = Date.now();
    let cached = this.cache.get(key);
    if (!cached) {
      const persisted = await this.loadPersisted(key);
      if (persisted) {cached = this.cache.get(key);}
    }

    if (cached && now - cached.at < CACHE_TTL_MS) {
      return cached.results;
    }

    if (now < this.cooldownUntil) {
      if (cached) {return cached.results;}
      throw new GuardianRateLimitError(null);
    }

    const url = `${this.baseUrl}/search?${key}`;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, {signal: opts.signal});
    } catch (e) {
      // Network blip — return stale cache if we have it, otherwise rethrow.
      if (cached) {return cached.results;}
      throw e;
    }

    if (res.status === 429) {
      this.cooldownUntil = now + BACKOFF_MS;
      throw new GuardianRateLimitError(cached?.results ?? null);
    }
    if (!res.ok) {
      if (cached) {return cached.results;}
      throw new Error(`Guardian API ${res.status}`);
    }
    const data = (await res.json()) as GuardianSearchResponse;
    if (data.response?.status !== 'ok') {
      if (cached) {return cached.results;}
      throw new Error('Guardian API returned non-ok status');
    }
    const results = data.response.results ?? [];
    const entry = {results, at: now};
    this.cache.set(key, entry);
    this.persist(key, entry);
    return results;
  }
}

export const guardianClient = new GuardianClient();
