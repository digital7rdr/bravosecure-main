import {Injectable, Logger} from '@nestjs/common';
import {fetchWithDeadline} from '../common/http/fetchWithDeadline';
import {ALL_THEME_WORDS, classifyThreat, type ThreatItem, type ThreatSeverity} from './threatClassify';
import {TtlCache} from './ttlCache';

// Re-export so existing imports (`from './gdelt.service'`) keep working.
export type {ThreatItem, ThreatSeverity};

const classify = classifyThreat;

interface GdeltArticle {
  title?:      string;
  url?:        string;
  domain?:     string;
  seendate?:   string;   // "20260601T120000Z"
}

/**
 * Region-based threat feed from GDELT 2.0 (free, no key).
 *
 * GDELT's free tier throttles to ~1 request / 5s / IP, so this service
 * caches per region for 15 minutes and serialises outgoing calls behind
 * a single in-flight promise + minimum spacing. On any failure it returns
 * an empty list — the caller (VbgService) degrades gracefully.
 */
@Injectable()
export class GdeltService {
  private readonly log = new Logger(GdeltService.name);

  private static readonly TTL_MS = 15 * 60 * 1000;
  // Bounded (audit M-7) — GeoRisk queries arbitrary places, so an unbounded
  // Map would grow for the life of the process.
  private readonly cache = new TtlCache<ThreatItem[]>(GdeltService.TTL_MS);
  private static readonly MIN_SPACING_MS = 5_200;
  // Default lookback when the caller doesn't scope a window. GDELT's free
  // tier accepts up to ~21 days for this query shape.
  private static readonly DEFAULT_TIMESPAN = '21d';
  private static readonly MAX_TIMESPAN_HOURS = 21 * 24;
  private lastCallAt = 0;
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * Live threats for a region. `timeWindowHours` scopes the GDELT lookback
   * (the GeoRisk 24/48/72h control); omitted → 21-day default. The window is
   * part of the cache key so a 24h and a 72h query don't collide.
   */
  async threatsForRegion(region: string, timeWindowHours?: number): Promise<ThreatItem[]> {
    const region_ = region.trim();
    if (!region_) {return [];}
    const timespan = GdeltService.toTimespan(timeWindowHours);
    const key = `${region_.toLowerCase()}|${timespan}`;

    const hit = this.cache.get(key);
    if (hit) {return hit;}

    // Serialise + space out calls so we never trip GDELT's 1-per-5s limit.
    const run = this.chain.then(() => this.fetchSpaced(region_, timespan));
    this.chain = run.catch(() => undefined);
    const items = await run;
    this.cache.set(key, items);
    return items;
  }

  /** Hours → a GDELT `timespan` token (e.g. 48 → "48h"), clamped to 21d. */
  private static toTimespan(hours?: number): string {
    if (!hours || !Number.isFinite(hours) || hours <= 0) {return GdeltService.DEFAULT_TIMESPAN;}
    const h = Math.min(Math.round(hours), GdeltService.MAX_TIMESPAN_HOURS);
    return `${h}h`;
  }

  private async fetchSpaced(region: string, timespan: string): Promise<ThreatItem[]> {
    const wait = GdeltService.MIN_SPACING_MS - (Date.now() - this.lastCallAt);
    if (wait > 0) {await new Promise(r => setTimeout(r, wait));}
    this.lastCallAt = Date.now();

    const themeClause = ALL_THEME_WORDS.map(w => (w.includes(' ') ? `"${w}"` : w)).join(' OR ');
    const query = `${region} (${themeClause})`;
    const url =
      'https://api.gdeltproject.org/api/v2/doc/doc' +
      `?query=${encodeURIComponent(query)}` +
      `&mode=ArtList&maxrecords=25&format=json&sort=DateDesc&timespan=${timespan}`;

    try {
      const res = await fetchWithDeadline(url, { // Audit Rev2 API-05
        headers: {'User-Agent': 'BravoSecure/1.0 (+vbg)'}, deadlineMs: 6_000,
      });
      if (!res.ok) {
        this.log.warn(`GDELT ${res.status} for "${region}"`);
        return [];
      }
      const text = await res.text();
      // GDELT returns a plaintext throttle notice (not JSON) when rate-limited.
      if (!text.trimStart().startsWith('{')) {
        this.log.warn(`GDELT non-JSON for "${region}": ${text.slice(0, 80)}`);
        return [];
      }
      const body = JSON.parse(text) as {articles?: GdeltArticle[]};
      const seen = new Set<string>();
      const items: ThreatItem[] = [];
      for (const a of body.articles ?? []) {
        if (!a.title || !a.url) {continue;}
        const dedup = a.title.toLowerCase().slice(0, 60);
        if (seen.has(dedup)) {continue;}
        seen.add(dedup);
        const {severity, theme} = classify(a.title);
        items.push({
          title:    a.title,
          url:      a.url,
          source:   a.domain ?? 'gdelt',
          seenAt:   parseGdeltDate(a.seendate),
          severity,
          theme,
        });
      }
      return items;
    } catch (e) {
      this.log.warn(`GDELT fetch failed for "${region}": ${(e as Error).message}`);
      return [];
    }
  }
}

function parseGdeltDate(d?: string): string {
  // "20260601T120000Z" → ISO. An empty string on a malformed/missing stamp —
  // fabricating "now" made undated items look breaking-news fresh (audit L-2).
  if (d && /^\d{8}T\d{6}Z$/.test(d)) {
    const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`;
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) {return new Date(ms).toISOString();}
  }
  return '';
}
