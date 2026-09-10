/**
 * Bravo OSINT source for the Intel feed / Bravo Map.
 *
 * Pulls the server's country-scoped news blend (`/news/feed` — Google News
 * + the founder's curated OSINT outlet directory, all ≤72h fresh) and maps
 * the rows into the aggregator's GuardianResult shape. Every row carries an
 * ISO2 `region`, so each one gets a GUARANTEED country pin (`geo`) — these
 * are the enriched news points on the map, no headline-keyword luck needed.
 *
 * Fails soft: [] on any error, like every other intel source.
 */
import {newsApi} from '@services/api';
import {countryLabel, loadNewsPrefs} from './newsPrefs';
import {countryPin} from './geotag';
import type {GuardianResult} from './guardianClient';
import type {WireFilter} from './useIntelFeed';

/**
 * Wire-filter → feed category ids (server drops unknown tokens).
 * Founder 2026-08-09 — the Bravo Feed chips ARE the News Filter categories
 * now, so a chip maps to itself and this stops being a translation table.
 * 'ALL' still sends '' so the server blends the user's SAVED categories.
 */
export function categoriesFor(filter: WireFilter): string {
  return filter === 'ALL' ? '' : filter;
}

/** Map one /news/feed row → the aggregator's result shape. Exported for tests. */
export function toGuardianShape(r: Record<string, unknown>): GuardianResult {
  const region   = String(r.region ?? '').toUpperCase();
  const category = String(r.category ?? '').toLowerCase().replace(/\s+/g, '');
  const source   = String(r.source ?? 'Bravo OSINT');
  const pin      = region && region !== 'GLOBAL'
    ? countryPin(region, countryLabel(region))
    : null;
  return {
    id:                 `bravo-${String(r.id ?? '')}`,
    webTitle:           String(r.title ?? ''),
    webUrl:             typeof r.url === 'string' ? r.url : '',
    sectionId:          category === 'topstories' ? 'top' : category,
    sectionName:        String(r.category ?? ''),
    webPublicationDate: String(r.published_at ?? ''),
    fields:             {trailText: String(r.summary ?? '') || undefined},
    geo:                pin ?? undefined,
    sourceTag:          source.toUpperCase(),
  };
}

export async function fetchBravoNews(filter: WireFilter): Promise<GuardianResult[]> {
  try {
    const prefs = await loadNewsPrefs();
    const categories = categoriesFor(filter) || prefs.categories.join(',');
    const {data} = await newsApi.getFeed({
      countries:  prefs.countries.join(','),
      categories,
    });
    const rows = Array.isArray(data?.articles) ? data.articles : [];
    return rows
      .map(toGuardianShape)
      .filter(g => g.webTitle && g.webUrl);
  } catch {
    return [];
  }
}

/**
 * Worldwide sweep for the Bravo Map (Corné's spec): the chosen category's
 * signals across every continent, independent of the user's ≤6 selected
 * countries. Every row carries its country pin. [] on failure.
 */
export async function fetchWorldMap(filter: WireFilter): Promise<GuardianResult[]> {
  try {
    const primary = (categoriesFor(filter) || 'top').split(',')[0];
    const {data} = await newsApi.getWorldMap({categories: primary});
    const rows = Array.isArray(data?.articles) ? data.articles : [];
    return rows
      .map(toGuardianShape)
      .filter(g => g.webTitle && g.webUrl);
  } catch {
    return [];
  }
}
