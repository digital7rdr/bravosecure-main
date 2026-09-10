import {Injectable, Logger} from '@nestjs/common';
import {ALL_THEME_WORDS, classifyThreat, type ThreatItem} from './threatClassify';
import {TtlCache} from './ttlCache';

interface NewsDataArticle {
  title?:       string;
  link?:        string;
  source_id?:   string;
  pubDate?:     string;   // "2026-06-20 05:18:16"
  description?: string;
}

/**
 * NewsData.io threat source for the VBG intel blend.
 *
 * NewsData has far better LOCAL coverage than GDELT for many countries
 * (88k sources, 206 countries) — it surfaces region-specific incidents
 * (e.g. "mob attacks on police in Lalmonirhat") that GDELT misses. We query
 * `/latest` scoped to the reverse-geocoded country with the shared threat
 * keywords, then classify by severity.
 *
 * Free tier: 200 credits/day. We cache per (country|window) for 15 min and
 * skip entirely when NEWSDATA_API_KEY is unset, so the source is optional —
 * GDELT + RSS still work without it.
 */
@Injectable()
export class NewsDataService {
  private readonly log = new Logger(NewsDataService.name);
  private readonly key = process.env.NEWSDATA_API_KEY;

  private static readonly TTL_MS = 15 * 60 * 1000;
  // Bounded (audit M-7) — keys vary by place hierarchy, so cap the cache.
  private readonly cache = new TtlCache<ThreatItem[]>(NewsDataService.TTL_MS);
  // NewsData accepts up to 5 OR-terms per query — use the highest-signal ones.
  private static readonly QUERY_TERMS = ['crime', 'shooting', 'robbery', 'protest', 'attack'];

  get enabled(): boolean { return !!this.key; }

  /**
   * Live LOCAL threats for an area. The critical detail: NewsData's `country`
   * filter returns articles PUBLISHED BY that country's outlets — and local
   * papers (e.g. The Daily Star, Observer BD) cover world news too, so a bare
   * country query surfaces Lebanon/Ukraine stories that aren't a threat to the
   * principal. So we scope the search to the PLACE NAME(s) (region + nearby
   * district/city from the reverse-geocode) AND threat terms, which matches
   * articles ABOUT the area, not merely published there.
   *
   * `placeTerms` are the location names to OR together (e.g. ["Narayanganj",
   * "Siddirganj", "Dhaka"]); `countryIso2` scopes by publisher country.
   */
  async threatsForArea(placeTerms: string[], countryIso2: string | null): Promise<ThreatItem[]> {
    if (!this.key) {return [];}
    const places = placeTerms.map(s => s.trim()).filter(Boolean);
    if (places.length === 0 && !countryIso2) {return [];}

    const country = (countryIso2 ?? '').toLowerCase();
    const key = `nd:${country}:${places.join('|').toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit) {return hit;}

    // (place1 OR place2 …) AND (threat OR threat …) — articles about the area.
    const placeClause = places.length ? `(${places.map(p => `"${p}"`).join(' OR ')}) AND ` : '';
    const threatClause = `(${NewsDataService.QUERY_TERMS.join(' OR ')})`;
    const q = encodeURIComponent(`${placeClause}${threatClause}`);
    const countryParam = country ? `&country=${encodeURIComponent(country)}` : '';
    const url =
      `https://newsdata.io/api/1/latest?apikey=${this.key}` +
      `${countryParam}&language=en&q=${q}`;
    try {
      const res = await fetch(url, {method: 'GET', signal: AbortSignal.timeout(6_000)});
      if (!res.ok) {
        this.log.warn(`NewsData ${res.status} for "${places.join(',')}/${country}"`);
        return [];
      }
      const body = await res.json() as {status?: string; results?: NewsDataArticle[]};
      if (body.status !== 'success') {return [];}
      const seen = new Set<string>();
      const items: ThreatItem[] = [];
      for (const a of body.results ?? []) {
        if (!a.title || !a.link) {continue;}
        const dedup = a.title.toLowerCase().slice(0, 60);
        if (seen.has(dedup)) {continue;}
        seen.add(dedup);
        const {severity, theme} = classifyThreat(`${a.title} ${a.description ?? ''}`);
        items.push({
          title:    a.title,
          url:      a.link,
          source:   a.source_id ?? 'newsdata',
          seenAt:   parseNewsDataDate(a.pubDate),
          severity,
          theme,
        });
      }
      this.cache.set(key, items);
      return items;
    } catch (e) {
      this.log.warn(`NewsData fetch failed for "${country}": ${(e as Error).message}`);
      return [];
    }
  }
}

// `ALL_THEME_WORDS` is imported for parity with the GDELT query shape; NewsData
// caps OR-terms, so we use a curated subset (QUERY_TERMS) above.
void ALL_THEME_WORDS;

function parseNewsDataDate(d?: string): string {
  // "2026-06-20 05:18:16" (UTC) → ISO. Empty on missing/malformed — never
  // fabricate freshness for undated items (audit L-2).
  if (d) {
    const ms = Date.parse(d.replace(' ', 'T') + 'Z');
    if (!Number.isNaN(ms)) {return new Date(ms).toISOString();}
  }
  return '';
}
