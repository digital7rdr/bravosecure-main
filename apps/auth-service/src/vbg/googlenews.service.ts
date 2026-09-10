import {Injectable, Logger} from '@nestjs/common';
import {classifyThreat, type ThreatItem} from './threatClassify';
import {siteClause} from './osintSources';
import {TtlCache} from './ttlCache';

/**
 * Google News RSS threat source for the VBG intel blend.
 *
 * Why this source: it is COMPLETELY FREE — no API key, no documented daily
 * cap — and has the widest local coverage of any free option (Google indexes
 * tens of thousands of regional outlets worldwide). It complements GDELT
 * (global events, thin on small places) and NewsData (good local, but capped
 * at 200 credits/day) by giving uncapped, query-scoped, geo-localised news for
 * any place on earth.
 *
 * We query the search RSS endpoint:
 *   https://news.google.com/rss/search?q=<query>&hl=en&gl=<ISO2>&ceid=<ISO2>:en
 * where the query is the same shape as the other sources —
 *   (place1 OR place2 …) (threat OR threat …)
 * scoped to the principal's locality + the surrounding district/city.
 *
 * RSS is small XML; we parse it with focused regexes (no XML dependency, same
 * fetch-only idiom as gdelt/newsdata). On any failure we return [] so the
 * blend in VbgService degrades gracefully.
 */
@Injectable()
export class GoogleNewsService {
  private readonly log = new Logger(GoogleNewsService.name);

  private static readonly TTL_MS = 15 * 60 * 1000;
  // Bounded (audit M-7) — keys vary by place hierarchy, so cap the cache.
  private readonly cache = new TtlCache<ThreatItem[]>(GoogleNewsService.TTL_MS);
  // Highest-signal threat terms (kept short so the URL stays well-formed and
  // the result set stays incident-focused rather than general news).
  private static readonly QUERY_TERMS = [
    'crime', 'shooting', 'killed', 'robbery', 'attack', 'protest', 'fire', 'accident',
  ];

  /**
   * Live LOCAL threats for an area from Google News RSS.
   *
   * `placeTerms` are the location names to OR together (e.g. ["Narayanganj",
   * "Siddirganj", "Dhaka"]); `countryIso2` localises the edition (hl/gl/ceid)
   * so results favour the principal's country. The endpoint needs no key.
   *
   * `curatedDomains` (optional) restricts the search to the founder's OSINT
   * outlet directory for the country (`site:` clause) — a second blend source
   * with better local-incident recall than the open index.
   */
  async threatsForArea(
    placeTerms: string[],
    countryIso2: string | null,
    curatedDomains?: string[],
  ): Promise<ThreatItem[]> {
    const places = placeTerms.map(s => s.trim()).filter(Boolean);
    if (places.length === 0) {return [];}
    const domains = (curatedDomains ?? []).filter(Boolean);

    const iso = (countryIso2 ?? '').trim().toUpperCase();
    const key = `gn:${iso}:${domains.length ? 'osint:' : ''}${places.join('|').toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit) {return hit;}

    // (place1 OR place2 …) (threat OR threat …) — articles about the area.
    // when:72h pins the rolling news window upstream (B-91 M2 R6 mirrors it
    // downstream via withinWindowStrict, which may narrow further).
    const placeClause = `(${places.map(p => `"${p}"`).join(' OR ')})`;
    const threatClause = `(${GoogleNewsService.QUERY_TERMS.join(' OR ')})`;
    const curatedClause = domains.length ? ` ${siteClause(domains)}` : '';
    const q = encodeURIComponent(`${placeClause} ${threatClause}${curatedClause} when:72h`);
    // gl/ceid want a country code; default to US edition when we have no ISO.
    // Use a generic `hl=en` (not en-US) so a non-US country edition isn't
    // rejected for a language/region mismatch and 302-redirected to the US
    // edition (extra hop). The place names in the query do the real area
    // scoping; gl/ceid only bias ranking toward that country's outlets.
    const gl = iso && iso.length === 2 ? iso : 'US';
    const url =
      `https://news.google.com/rss/search?q=${q}` +
      `&hl=en&gl=${gl}&ceid=${gl}:en`;

    try {
      const res = await fetch(url, {
        method: 'GET',
        // A browser-shaped UA is served the RSS reliably; a bot-style UA can be
        // bounced to a consent interstitial.
        headers: {'User-Agent': 'Mozilla/5.0 (compatible; BravoSecure/1.0; +vbg)'},
        signal: AbortSignal.timeout(6_000),
      });
      if (!res.ok) {
        this.log.warn(`GoogleNews ${res.status} for "${places.join(',')}/${gl}"`);
        return [];
      }
      const xml = await res.text();
      const items = parseRssItems(xml);
      const seen = new Set<string>();
      const out: ThreatItem[] = [];
      for (const it of items) {
        if (!it.title || !it.link) {continue;}
        const dedup = it.title.toLowerCase().slice(0, 60);
        if (seen.has(dedup)) {continue;}
        seen.add(dedup);
        const {severity, theme} = classifyThreat(it.title);
        out.push({
          title:    it.title,
          url:      it.link,
          // Google wraps the real outlet name in <source>; fall back to the host.
          source:   it.source || hostOf(it.link) || 'google news',
          seenAt:   parsePubDate(it.pubDate),
          severity,
          theme,
        });
      }
      this.cache.set(key, out);
      return out;
    } catch (e) {
      this.log.warn(`GoogleNews fetch failed for "${gl}": ${(e as Error).message}`);
      return [];
    }
  }
}

export interface RssItem {
  title:   string;
  link:    string;
  source:  string;
  pubDate: string;
}

/**
 * Parse the <item> blocks of a Google News RSS feed. The feed is small,
 * well-formed XML; focused regexes avoid pulling in an XML parser dependency.
 * Google News titles arrive as "Headline - Outlet"; we keep the full title
 * (the classifier reads the headline) and separately capture <source> as the
 * outlet name.
 *
 * Exported (with `parsePubDate`/`hostOf`) so NewsFeedService — the general
 * country/category news feed — inherits the exact same battle-tested RSS
 * handling instead of duplicating it.
 */
export function parseRssItems(xml: string): RssItem[] {
  const out: RssItem[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title  = decodeXml(tag(block, 'title'));
    const link   = decodeXml(tag(block, 'link'));
    const source = decodeXml(tag(block, 'source'));
    const pubDate = tag(block, 'pubDate');
    if (!title || !link) {continue;}
    out.push({title, link, source, pubDate});
    if (out.length >= 30) {break;}
  }
  return out;
}

/** First inner text of <name>…</name>, CDATA-aware, trimmed. */
function tag(block: string, name: string): string {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i');
  const m = re.exec(block);
  if (!m) {return '';}
  return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function parsePubDate(d?: string): string {
  // RFC-822, e.g. "Fri, 20 Jun 2026 05:18:16 GMT" → ISO. Empty on missing/
  // malformed — never fabricate freshness for undated items (audit L-2).
  if (d) {
    const ms = Date.parse(d);
    if (!Number.isNaN(ms)) {return new Date(ms).toISOString();}
  }
  return '';
}
