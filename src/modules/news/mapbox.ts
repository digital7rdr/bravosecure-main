/**
 * Mapbox Static Images API helpers.
 *
 * Why static images vs. @rnmapbox/maps?
 *   - Zero native code, zero rebuild. Pulls a plain PNG URL into an
 *     <Image>, so we can ship today and rebuild only if the user asks
 *     for pan/zoom.
 *   - The URL signs the markers in so we can point-render up to ~100
 *     pins in a single request.
 *
 * Docs: https://docs.mapbox.com/api/maps/static-images/
 */

const TOKEN    = process.env.EXPO_PUBLIC_MAPBOX_TOKEN || '';
const STYLE    = 'mapbox/dark-v11';     // matches the dark intel aesthetic
const FALLBACK = 'mapbox/streets-v12';  // used only if the dark style 404s

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

const MARKER_COLOR: Record<Severity, string> = {
  CRITICAL: 'ff3b30',
  HIGH:     'ffb800',
  MEDIUM:   '1e88ff',
  LOW:      '7e8aa6',
};

export interface MapMarker {
  lng:       number;
  lat:       number;
  severity:  Severity;
  label?:    string;
}

export interface ClusterMarker extends MapMarker {
  count:  number;
  label:  string;      // country tag e.g. 'IRAN'
}

/**
 * THE cluster bucket key — one country/place cell. Every consumer that
 * groups intel items for the map (marker badges, the tap drawer) MUST use
 * this same key: the badge count and the drawer stack were once computed
 * with two different keys (one included the label, one didn't), so a
 * bubble said "2" while the tap revealed 5 (founder report, 2026-07-31).
 */
export function clusterKey(m: {lat: number; lng: number; label?: string}): string {
  // Whole-degree cell (~111 km) + label so distinct places sharing a cell
  // stay distinct bubbles.
  return `${Math.round(m.lat)}_${Math.round(m.lng)}_${m.label ?? ''}`;
}

/**
 * Group individual markers by rounded lat/lng so one country renders as
 * a single bubble with a count — matches the HTML preview's bubble
 * clustering (one dot per country, not one dot per article).
 * Severity of the cluster inherits from its worst article.
 */
export function clusterMarkers(markers: MapMarker[]): ClusterMarker[] {
  const rank: Record<Severity, number> = {CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0};
  const buckets = new Map<string, ClusterMarker>();
  for (const m of markers) {
    const key = clusterKey(m);
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {...m, count: 1, label: m.label ?? ''});
      continue;
    }
    existing.count += 1;
    if (rank[m.severity] > rank[existing.severity]) {existing.severity = m.severity;}
  }
  return Array.from(buckets.values());
}

export interface StaticMapOptions {
  /** Viewport center. Defaults to a wide MENA-centred view. */
  center?:      {lng: number; lat: number};
  /** Zoom (0-22). Default 1.2 — shows the full eastern hemisphere. */
  zoom?:        number;
  width?:       number;
  height?:      number;
  /** `@2x` for retina. Default true. */
  retina?:      boolean;
  markers?:     MapMarker[];
}

export function hasMapboxToken(): boolean {
  return TOKEN.startsWith('pk.');
}

/**
 * Build a Mapbox Static Images URL with inline `pin-s-circle+hexcolor`
 * markers (small solid circles in the severity colour).
 *
 * Caller just drops the returned URL into an <Image source={{uri}}>.
 */
export function buildStaticMapUrl(opts: StaticMapOptions = {}): string {
  if (!hasMapboxToken()) {return '';}
  const width   = Math.round(opts.width  ?? 800);
  const height  = Math.round(opts.height ?? 500);
  const retina  = opts.retina !== false;
  const zoom    = opts.zoom   ?? 1.2;
  const center  = opts.center ?? {lng: 45, lat: 25};
  const markers = opts.markers ?? [];

  // Overlay spec: `pin-l-<label>+<hex>(lng,lat)` for large labelled pins.
  // Cluster the input so each country shows once with its headline count,
  // capped at ~30 pins — URLs past ~8 KB start failing on some proxies.
  const clustered = clusterMarkers(markers).slice(0, 30);
  const pinSpec = clustered.map(m => {
    const colour = MARKER_COLOR[m.severity] ?? MARKER_COLOR.MEDIUM;
    const lng = Number(m.lng.toFixed(4));
    const lat = Number(m.lat.toFixed(4));
    // Mapbox labels must be 0-99; larger counts render as "9+" style
    const label = m.count > 9 ? '9' : String(m.count);
    return `pin-l-${label}+${colour}(${lng},${lat})`;
  }).join(',');

  const path = pinSpec ? `/${pinSpec}` : '';
  const size = `${width}x${height}${retina ? '@2x' : ''}`;
  const viewport = `${center.lng.toFixed(4)},${center.lat.toFixed(4)},${zoom}`;
  return (
    `https://api.mapbox.com/styles/v1/${STYLE}/static${path}` +
    `/${viewport}/${size}` +
    `?access_token=${encodeURIComponent(TOKEN)}`
  );
}

/** Trivial fallback if the dark style is rate-limited. */
export function buildStaticMapFallbackUrl(opts: StaticMapOptions = {}): string {
  return buildStaticMapUrl(opts).replace(STYLE, FALLBACK);
}

/**
 * Static map centred on a single unlabelled pin — the "last known location"
 * card (Linked Members member sheet). Same single-`<Image>` idiom as
 * `buildRouteMapUrl`: no native map lib, safe inside a sheet/list.
 * Returns '' when the token is missing or the coordinate is absent.
 */
export function buildPinMapUrl(
  point: {lng: number; lat: number} | null,
  opts: {width?: number; height?: number; retina?: boolean; zoom?: number; pinColor?: string} = {},
): string {
  if (!hasMapboxToken() || !point) {return '';}
  const width  = Math.round(opts.width  ?? 640);
  const height = Math.round(opts.height ?? 280);
  const retina = opts.retina !== false;
  const zoom   = opts.zoom ?? 13.5;
  const colour = (opts.pinColor ?? '5B8DEF').replace('#', '');
  const lng = Number(point.lng.toFixed(5));
  const lat = Number(point.lat.toFixed(5));
  const size = `${width}x${height}${retina ? '@2x' : ''}`;
  return (
    `https://api.mapbox.com/styles/v1/${STYLE}/static/` +
    `pin-s+${colour}(${lng},${lat})/${lng},${lat},${zoom}/${size}` +
    `?access_token=${encodeURIComponent(TOKEN)}`
  );
}

/**
 * Static map of a pickup → destination route: a GeoJSON line between the two
 * points plus a pin at each end, auto-framed to fit both. Used for the per-card
 * route map on the agent Job Marketplace — a single <Image>, no native map lib,
 * so a long scroll list stays smooth.
 *
 * Returns '' when the token is missing or either coordinate is absent (the
 * caller then renders a plain hero band).
 */
export function buildRouteMapUrl(
  pickup: {lng: number; lat: number} | null,
  dropoff: {lng: number; lat: number} | null,
  opts: {width?: number; height?: number; retina?: boolean; lineColor?: string} = {},
): string {
  if (!hasMapboxToken() || !pickup || !dropoff) {return '';}
  const width  = Math.round(opts.width  ?? 700);
  const height = Math.round(opts.height ?? 232);
  const retina = opts.retina !== false;
  const line   = (opts.lineColor ?? 'a78bfa').replace('#', '');

  const p = (c: {lng: number; lat: number}) => `${Number(c.lng.toFixed(5))},${Number(c.lat.toFixed(5))}`;
  // GeoJSON path overlay (the route line) — URL-encoded.
  const geojson = encodeURIComponent(JSON.stringify({
    type: 'Feature',
    properties: {stroke: `#${line}`, 'stroke-width': 3, 'stroke-opacity': 0.85},
    geometry: {type: 'LineString', coordinates: [[pickup.lng, pickup.lat], [dropoff.lng, dropoff.lat]]},
  }));
  // Pins: green for pickup (start), violet for destination (end).
  const pins = `pin-s+22c55e(${p(pickup)}),pin-s+${line}(${p(dropoff)})`;
  const size = `${width}x${height}${retina ? '@2x' : ''}`;
  // `auto` frames the overlays with padding so both ends are always visible.
  return (
    `https://api.mapbox.com/styles/v1/${STYLE}/static/` +
    `geojson(${geojson}),${pins}/auto/${size}` +
    `?access_token=${encodeURIComponent(TOKEN)}&padding=40,30,30,30`
  );
}

// ─── Mercator projection ─────────────────────────────────────────────────────
// Project a lng/lat onto pixel coordinates over a Mapbox Static image
// rendered at (centerLng, centerLat, zoom) with given width/height. Lets us
// draw tappable RN overlay Views on top of the static PNG so we can still
// have interactive "ping" bubbles without pulling in a native map library.

const TILE_SIZE = 256;

function lngToMercX(lng: number): number {
  return (lng + 180) / 360;
}
function latToMercY(lat: number): number {
  const rad = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
}

export function projectMarker(
  lng: number,
  lat: number,
  center: {lng: number; lat: number},
  zoom: number,
  width: number,
  height: number,
): {x: number; y: number} {
  const scale = Math.pow(2, zoom) * TILE_SIZE;
  const cx = lngToMercX(center.lng) * scale;
  const cy = latToMercY(center.lat) * scale;
  const mx = lngToMercX(lng) * scale;
  const my = latToMercY(lat) * scale;
  return {
    x: width  / 2 + (mx - cx),
    y: height / 2 + (my - cy),
  };
}
