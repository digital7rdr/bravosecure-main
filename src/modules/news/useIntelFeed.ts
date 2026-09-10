import {useCallback, useEffect, useRef, useState} from 'react';
import {type GuardianResult} from './guardianClient';
import {DEMO_INTEL} from './demoIntel';
import {geotag, severityFor, sectionToTag} from './geotag';
import type {NewsCategoryId} from './newsPrefs';
import {fetchIntel, selectWorldExtras} from './intelAggregator';
import {fetchWorldMap} from './bravoNewsClient';
import {parseDateMs} from './safeDate';

/**
 * Normalised Intel row rendered on the IntelFeed screen. The shape
 * intentionally matches the legacy hardcoded `WireItem` so we can drop
 * this feed in without touching the render layer.
 */
export interface IntelItem {
  id:            string;
  priority:      'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  priorityColor: string;
  priorityBg:    string;
  tag:           string;      // visual chip: POLITICAL / FINANCE / SECURITY ...
  headline:      string;
  loc:           string;      // "📍 UK" or "📍 GLOBAL"
  src:           string;      // "SOURCE: GUARDIAN"
  ts:            string;      // "23M AGO"
  accentColor:   string;
  lat?:          number;
  lng?:          number;
  webUrl:        string;      // deep link back to the article
  trailText?:    string;
  thumbnail?:    string;
}

const PRIORITY_PALETTE: Record<IntelItem['priority'], {color: string; bg: string; accent: string}> = {
  CRITICAL: {color: '#FF3B30', bg: 'rgba(255,59,48,0.12)',  accent: '#FF3B30'},
  HIGH:     {color: '#FFB800', bg: 'rgba(255,184,0,0.12)',  accent: '#FFB800'},
  MEDIUM:   {color: '#1E88FF', bg: 'rgba(30,136,255,0.12)', accent: '#1E88FF'},
  LOW:      {color: '#7E8AA6', bg: 'rgba(126,138,166,0.12)', accent: '#7E8AA6'},
};

function fmtAge(iso: string): string {
  const ms = parseDateMs(iso);
  if (ms === null) {return '—';} // invalid/missing date — avoid "NaND AGO"
  const delta = Date.now() - ms;
  const m = Math.floor(delta / 60000);
  if (m < 1)  {return 'NOW';}
  if (m < 60) {return `${m}M AGO`;}
  const h = Math.floor(m / 60);
  if (h < 24) {return `${h}H AGO`;}
  const d = Math.floor(h / 24);
  return `${d}D AGO`;
}

export function toIntelItem(g: GuardianResult): IntelItem {
  const priority = severityFor(g.webTitle, g.sectionId);
  const palette  = PRIORITY_PALETTE[priority];
  // A source-resolved pin (Bravo OSINT rows carry their country) beats the
  // headline-keyword guess — this is what puts the enriched points on the map.
  const pin      = g.geo ?? geotag(`${g.webTitle} ${g.fields?.trailText ?? ''}`);
  return {
    id:            g.id,
    priority,
    priorityColor: palette.color,
    priorityBg:    palette.bg,
    tag:           sectionToTag(g.sectionId),
    headline:      g.webTitle,
    loc:           pin ? `📍 ${pin.label}` : '📍 GLOBAL',
    src:           `SOURCE: ${g.sourceTag ?? 'GUARDIAN'}`,
    ts:            fmtAge(g.webPublicationDate),
    accentColor:   palette.accent,
    lat:           pin?.lat,
    lng:           pin?.lng,
    webUrl:        g.webUrl,
    trailText:     g.fields?.trailText,
    thumbnail:     g.fields?.thumbnail,
  };
}

/**
 * Bravo Feed filter chips. Founder 2026-08-09 — these ARE the News Filter
 * categories, derived from NEWS_CATEGORIES so the two surfaces cannot drift.
 * The old vocabulary (CRITICAL / POLITICAL / MILITARY) mixed a SEVERITY
 * (critical) in with topics and used names the preferences screen never
 * offered, so a user could not filter the feed by what they had subscribed to.
 */
export type WireFilter = 'ALL' | NewsCategoryId;

export interface UseIntelFeedState {
  items:    IntelItem[];
  /** Worldwide-sweep items for the MAP only (category-scoped, all
   *  continents) — not shown on the wire list. */
  mapExtras: IntelItem[];
  loading:  boolean;
  error:    string | null;
  /** Count of upstream feeds that returned at least one item. */
  sources:  number;
  refresh:  () => Promise<void>;
}

/**
 * Fetches intel across every free source we have (Guardian + RSS +
 * Reddit + HackerNews), merges + dedupes, maps to IntelItem, and
 * returns hook-stable state. Refetches cancel in-flight requests so
 * rapid filter-flipping doesn't race.
 */
/**
 * B-656 — a STABLE empty array for the map-extras clears.
 *
 * Both clear sites used to pass a fresh `[]` literal, so even when `mapExtras`
 * was already empty the new reference invalidated the entire downstream memo
 * chain in IntelFeedScreen:
 *
 *   mapItems → mapMarkers → clusters → threatsJs → injectJavaScript
 *
 * That meant every feed load pushed a full marker payload into the map WebView
 * regardless of whether anything had changed — so `clusterMarkers` being O(n)
 * and correctly memoised was true but beside the point: its memo was
 * structurally guaranteed to miss. `useState` bails on `Object.is`, so a stable
 * reference makes a redundant clear free.
 */
const EMPTY_EXTRAS: IntelItem[] = [];

export function useIntelFeed(filter: WireFilter = 'ALL'): UseIntelFeedState {
  const [items,   setItems]   = useState<IntelItem[]>([]);
  const [mapExtras, setMapExtras] = useState<IntelItem[]>(EMPTY_EXTRAS);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [sources, setSources] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const fetchNow = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      // Phase 2 kicks off in PARALLEL but is merged after the wire list has
      // painted — a slow/cold world sweep must never delay first content.
      const worldP = fetchWorldMap(filter);
      const {results, sources: srcCount, failed, limited} = await fetchIntel(filter, ctrl.signal);
      if (ctrl.signal.aborted) {return;}
      setMapExtras(EMPTY_EXTRAS);
      void worldP.then(world => {
        if (ctrl.signal.aborted) {return;}
        setMapExtras(selectWorldExtras(filter, results, world).map(toIntelItem));
      });
      if (results.length > 0) {
        setItems(results.map(toIntelItem));
        setSources(srcCount);
        setError(limited ? 'Guardian rate-limited — blending other sources' : null);
      } else if (failed) {
        // Every source failed — fall back to the bundled dataset so
        // the screen never shows a dead end.
        setItems(DEMO_INTEL.map(toIntelItem));
        setSources(0);
        setError('All feeds unreachable — showing demo intel');
      } else {
        setItems([]);
        setSources(srcCount);
        setError('No results for this filter');
      }
    } catch (e) {
      if ((e as {name?: string} | null)?.name === 'AbortError') {return;}
      setItems(DEMO_INTEL.map(toIntelItem));
      setMapExtras(EMPTY_EXTRAS);
      setSources(0);
      setError(e instanceof Error ? `${e.message} — showing demo intel` : 'Failed to load feed');
    } finally {
      if (!ctrl.signal.aborted) {setLoading(false);}
    }
  }, [filter]);

  useEffect(() => {
    void fetchNow();
    return () => { abortRef.current?.abort(); };
  }, [fetchNow]);

  return {items, mapExtras, loading, error, sources, refresh: fetchNow};
}
