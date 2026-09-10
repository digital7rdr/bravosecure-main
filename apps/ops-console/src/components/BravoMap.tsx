'use client';

/**
 * BravoMap — Mapbox GL wrapper styled for the Command Navy ops console.
 *
 * Renders a dark Mapbox tile layer with Bravo pulse markers for missions.
 * Gracefully falls back to the SVG grid placeholder when no Mapbox token
 * is configured, so the console is still usable without external services.
 */
import {useEffect, useRef, useState} from 'react';
import mapboxgl, {Map as MapboxMap, Marker} from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

export interface BravoMarker {
  id: string;
  lat: number;
  lng: number;
  label?: string;
  type?: 'live' | 'sos' | 'standby' | 'pickup' | 'dropoff' | 'lead' | 'principal' | 'next';
}

/**
 * Audit fix 4.5 — extracted so the diff-by-id sync can re-apply styles
 * in place when the marker type changes (instead of teardown + rebuild).
 */
function applyMarkerStyle(el: HTMLDivElement, type: BravoMarker['type']): void {
  const sz =
    type === 'sos'        ? 18 :
    type === 'lead'       ? 16 :
    type === 'principal'  ? 14 :
    type === 'next'       ? 10 : 12;
  el.style.width  = `${sz}px`;
  el.style.height = `${sz}px`;
  el.style.borderRadius = '50%';
  el.style.background =
    type === 'sos'        ? '#DC2626' :
    type === 'standby'    ? '#8B95A8' :
    type === 'pickup'     ? '#00C853' :
    type === 'dropoff'    ? '#FFC107' :
    type === 'lead'       ? '#5B8DEF' :
    type === 'principal'  ? '#A9C5FF' :
    type === 'next'       ? '#FFC107' :
    '#5B8DEF';
  el.style.boxShadow =
    type === 'sos'        ? '0 0 0 3px rgba(220,38,38,0.22), 0 0 16px #DC2626' :
    type === 'lead'       ? '0 0 0 3px rgba(91,141,239,0.35), 0 0 18px #5B8DEF, inset 0 0 0 2px #fff' :
    type === 'principal'  ? '0 0 0 3px rgba(126,214,255,0.30), 0 0 14px #A9C5FF, inset 0 0 0 2px #07090D' :
    type === 'next'       ? '0 0 0 2px rgba(255,193,7,0.28), 0 0 10px #FFC107' :
    '0 0 0 2px rgba(91,141,239,0.25), 0 0 12px #5B8DEF';
}

/**
 * Audit fix — escape marker-label text before it goes into setHTML().
 * Labels are backend-controlled (call_sign / display_name / short_code),
 * so an injected `<img onerror=…>` would otherwise execute in the ops
 * console. The CSP nonce blocks raw <script> but not innerHTML event
 * handlers on legacy browsers, so we encode at the sink rather than
 * relying on the header.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface BravoRouteOption {
  key: string;                        // stable id for keying the layers
  coords: [number, number][];         // polyline in [lng, lat] pairs
  color?: string;                     // override stroke color
  selected?: boolean;                 // hover/active state for the picker
  onClick?: () => void;
}

export type BravoMapStyleId = 'dark' | 'light' | 'streets' | 'satellite';

interface Props {
  center?: [number, number];         // [lng, lat]
  zoom?: number;
  markers?: BravoMarker[];
  route?: [number, number][];        // primary route — same as before
  alternativeRoutes?: BravoRouteOption[]; // optional overlay for the RE-ROUTE picker
  /**
   * Mapbox style id — mirrors the mobile location picker's cycler.
   * `dark` is the Command Navy default, `light` the white-background
   * map. `streets` shows the standard road map ("street view") and
   * `satellite` is the imagery + roads hybrid. Style swaps re-apply the
   * route + alternative-route + marker layers automatically.
   *
   * Omit the prop entirely and the map renders its own style-cycler
   * button (top-right), so every console map offers the light option
   * without each page wiring its own control.
   */
  styleId?: BravoMapStyleId;
  className?: string;
  style?: React.CSSProperties;
}

// Audit fix 4.5 — the Mapbox token MUST be URL-restricted to the ops
// console origin in the Mapbox dashboard (Account → Tokens → Edit →
// URL restrictions). Unrestricted tokens leak billable Mapbox quota
// to anyone who scrapes the JS bundle. Verification is operational:
// hit https://api.mapbox.com/styles/v1/mapbox/streets-v12?access_token=<TOKEN>
// from a non-ops origin and expect a 401/403. Tracked in tracker 4.5.
const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';
const DEFAULT_STYLE = process.env.NEXT_PUBLIC_MAPBOX_STYLE ?? 'mapbox://styles/mapbox/navigation-night-v1';
const STYLE_URLS: Record<BravoMapStyleId, string> = {
  dark:      DEFAULT_STYLE,
  light:     'mapbox://styles/mapbox/light-v11',
  streets:   'mapbox://styles/mapbox/streets-v12',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
};
const STYLE_CYCLE: BravoMapStyleId[] = ['dark', 'light', 'streets', 'satellite'];

export function BravoMap({
  center = [55.2708, 25.2048],       // Dubai
  zoom = 11,
  markers = [],
  route,
  alternativeRoutes,
  styleId: styleIdProp,
  className,
  style,
}: Props) {
  // Controlled (page owns the toggle, e.g. live/[id]) vs uncontrolled
  // (map renders its own cycler so the light/streets/satellite options
  // exist on every console map).
  const [internalStyleId, setInternalStyleId] = useState<BravoMapStyleId>('dark');
  const controlled = styleIdProp !== undefined;
  const styleId = controlled ? styleIdProp : internalStyleId;
  const container = useRef<HTMLDivElement | null>(null);
  const mapRef    = useRef<MapboxMap | null>(null);
  const markerRefs = useRef<Marker[]>([]);
  // Audit fix 4.5 — diff-by-id marker sync. Previously every render
  // teardown'd every Marker and rebuilt them, which (a) made the map
  // flicker when one marker moved, (b) lost open popups on each tick,
  // and (c) burned CPU on the 6s SWR refresh. Now we keep a Map<id, …>
  // of {marker, prev} so we can move/update existing markers in place
  // and only create/destroy the diff.
  const markersById = useRef<Map<string, {
    marker: Marker;
    prev: BravoMarker;
    el: HTMLDivElement;
  }>>(new Map());
  const altLayerIds = useRef<string[]>([]);
  // Audit fix — registered alt-route interaction handlers, keyed by
  // hit-layer id, so the teardown loop can map.off() them. Without this
  // the click/hover handlers accumulated on every alternativeRoutes change
  // (memory leak + stale onClick closures firing on a single click).
  const altHandlers = useRef<Map<string, {
    click: () => void;
    enter: () => void;
    leave: () => void;
  }>>(new Map());
  // Content signature of the last-applied alternativeRoutes (plus the
  // styleNonce they were drawn under). Callers rebuild the array every
  // render, so without a value diff the effect tore down and re-added every
  // alt source/layer/handler on each 2s poll — flicker + wasted GL work.
  const altSigRef = useRef<string | null>(null);
  const currentStyleRef = useRef<BravoMapStyleId>(styleId);
  // Bumped on every style swap so route + alt-route effects re-apply
  // their layers after the new style finishes loading (mapbox drops
  // user sources on setStyle).
  const [styleNonce, setStyleNonce] = useState(0);

  // Fallback styling (no token, grid-only)
  const fallback = !TOKEN;

  useEffect(() => {
    if (fallback || !container.current || mapRef.current) return;

    mapboxgl.accessToken = TOKEN;
    const map = new mapboxgl.Map({
      container: container.current,
      style: STYLE_URLS[styleId],
      center,
      zoom,
      attributionControl: false,
      logoPosition: 'bottom-left',
      antialias: true,
    });
    mapRef.current = map;
    // Capture the (stable-for-lifetime) marker map for the cleanup closure
    // so the ref isn't read at teardown time (react-hooks/exhaustive-deps).
    const markersAtMount = markersById.current;

    return () => {
      // Audit fix 4.5 — also clear the diff map so a remount doesn't
      // restore zombie entries from the old mapbox instance.
      markersAtMount.forEach(e => e.marker.remove());
      markersAtMount.clear();
      markerRefs.current = [];
      map.remove();
      mapRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Style swap. Calling map.setStyle() drops every source/layer the app
  // added (route, alt routes), so we bump `styleNonce` after the new
  // style loads — the route + alternativeRoutes effects below depend on
  // it and will re-add their layers on the new style. Markers are DOM-
  // based (mapboxgl.Marker) so they survive style swaps untouched.
  useEffect(() => {
    if (fallback || !mapRef.current) return;
    const map = mapRef.current;
    if (currentStyleRef.current === styleId) return;
    currentStyleRef.current = styleId;
    // Reset the picker layer-id cache so the alt-route teardown loop
    // doesn't try to remove layers from the discarded style. Detach the
    // tracked alt-route handlers too — setStyle drops the layers but the
    // listener bindings would otherwise leak until the next redraw.
    for (const [id, h] of altHandlers.current) {
      map.off('click',      `${id}-hit`, h.click);
      map.off('mouseenter', `${id}-hit`, h.enter);
      map.off('mouseleave', `${id}-hit`, h.leave);
    }
    altHandlers.current.clear();
    altLayerIds.current = [];
    map.setStyle(STYLE_URLS[styleId]);
    map.once('style.load', () => setStyleNonce(n => n + 1));
  }, [styleId, fallback]);

  // High-zoom detail — extruded 3D buildings under the first label layer.
  // Vector styles only (satellite has imagery). Re-applied after every
  // style swap via styleNonce; idempotent through the getLayer guard.
  useEffect(() => {
    if (fallback || !mapRef.current) return;
    const map = mapRef.current;
    const apply = () => {
      try {
        const current = currentStyleRef.current;
        if (current === 'satellite') return;
        if (map.getLayer('bravo-3d-buildings')) return;
        const layers = map.getStyle()?.layers ?? [];
        const label = layers.find(
          l => l.type === 'symbol' && (l as mapboxgl.SymbolLayer).layout?.['text-field'],
        );
        const lightish = current === 'light' || current === 'streets';
        map.addLayer({
          id: 'bravo-3d-buildings', source: 'composite', 'source-layer': 'building',
          filter: ['==', ['get', 'extrude'], 'true'], type: 'fill-extrusion', minzoom: 14.5,
          paint: {
            'fill-extrusion-color': lightish ? '#D9DDE4' : '#1E2634',
            'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 16, ['get', 'height']],
            'fill-extrusion-base':   ['interpolate', ['linear'], ['zoom'], 14.5, 0, 16, ['get', 'min_height']],
            'fill-extrusion-opacity': 0.6,
          },
        }, label?.id);
      } catch {
        // Style without a composite building source (custom nav styles) — skip.
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [fallback, styleNonce]);

  // Sync route. Runs on every change to `route` AND after the initial map
  // load (since the source/layer can't be added until the style is ready).
  // Mapbox drops sources when style swaps, so we re-add idempotently.
  useEffect(() => {
    if (fallback || !mapRef.current) return;
    const map = mapRef.current;
    const apply = () => {
      const data: GeoJSON.Feature<GeoJSON.LineString> = {
        type: 'Feature', properties: {},
        geometry: {type: 'LineString', coordinates: route ?? []},
      };
      const src = map.getSource('route') as mapboxgl.GeoJSONSource | undefined;
      if (src) {
        src.setData(data);
      } else if (route && route.length > 1) {
        map.addSource('route', {type: 'geojson', data});
        map.addLayer({
          id: 'route-glow', type: 'line', source: 'route',
          layout: {'line-cap': 'round', 'line-join': 'round'},
          paint: {'line-color': '#5B8DEF', 'line-width': 8, 'line-opacity': 0.18, 'line-blur': 3},
        });
        map.addLayer({
          id: 'route-line', type: 'line', source: 'route',
          layout: {'line-cap': 'round', 'line-join': 'round'},
          paint: {'line-color': '#5B8DEF', 'line-width': 3.2, 'line-opacity': 0.92},
        });
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [route, fallback, styleNonce]);

  // Sync alternative routes — used by the RE-ROUTE picker. Each option
  // gets its own GeoJSON source + glow + line + transparent click hit
  // layer so the user can tap a route to select it.
  useEffect(() => {
    if (fallback || !mapRef.current) return;
    const map = mapRef.current;

    // Skip the teardown + rebuild when neither the route content nor the
    // style changed. A styleNonce bump MUST still rebuild (setStyle drops
    // the sources), hence the nonce in the signature.
    const sig = `${styleNonce}|` + (alternativeRoutes ?? [])
      .map(o =>
        `${o.key}:${o.color ?? ''}:${Number(!!o.selected)}:${Number(!!o.onClick)}:` +
        `${o.coords.length}:${o.coords[0] ?? ''}:${o.coords[o.coords.length - 1] ?? ''}`)
      .join(';');
    if (altSigRef.current === sig) return;
    altSigRef.current = sig;

    const apply = () => {
      // Tear down previous picker layers/sources before redrawing. Detach
      // any interaction handlers FIRST so they don't accumulate across
      // redraws (each map.on must be paired with a map.off on the same fn).
      for (const id of altLayerIds.current) {
        const h = altHandlers.current.get(id);
        if (h) {
          map.off('click',      `${id}-hit`, h.click);
          map.off('mouseenter', `${id}-hit`, h.enter);
          map.off('mouseleave', `${id}-hit`, h.leave);
          altHandlers.current.delete(id);
        }
        if (map.getLayer(`${id}-hit`))  map.removeLayer(`${id}-hit`);
        if (map.getLayer(`${id}-line`)) map.removeLayer(`${id}-line`);
        if (map.getLayer(`${id}-glow`)) map.removeLayer(`${id}-glow`);
        if (map.getSource(id))          map.removeSource(id);
      }
      altLayerIds.current = [];

      if (!alternativeRoutes || alternativeRoutes.length === 0) return;

      // Draw non-selected routes FIRST so the selected one renders on top
      // of any geographic overlap. Mapbox z-orders by add-order, so this
      // is the simplest way to guarantee the active route reads cleanly
      // even when the alternates share long stretches of road.
      const ordered = [...alternativeRoutes].sort((a, b) =>
        Number(!!a.selected) - Number(!!b.selected),
      );

      for (const opt of ordered) {
        if (!opt.coords || opt.coords.length < 2) continue;
        const id = `alt-${opt.key}`;
        altLayerIds.current.push(id);
        const data: GeoJSON.Feature<GeoJSON.LineString> = {
          type: 'Feature', properties: {},
          geometry: {type: 'LineString', coordinates: opt.coords},
        };
        const color = opt.color ?? (opt.selected ? '#FFC107' : '#8B95A8');
        // Aggressive hierarchy: selected reads as a chunky highlighted
        // primary; non-selected are thin dashed ghosts so they obviously
        // signal "this is an option, not the route". When several routes
        // overlap the same road for long stretches, this is the only way
        // to keep the active one readable.
        const isSel    = !!opt.selected;
        const width    = isSel ? 6   : 2.5;
        const opacity  = isSel ? 1.0 : 0.45;
        const glowMul  = isSel ? 3.0 : 1.6;
        const glowOp   = isSel ? 0.30 : 0.10;
        const dashArray = isSel ? undefined : [2, 1.5];
        map.addSource(id, {type: 'geojson', data});
        map.addLayer({
          id: `${id}-glow`, type: 'line', source: id,
          layout: {'line-cap': 'round', 'line-join': 'round'},
          paint: {
            'line-color':   color,
            'line-width':   width * glowMul,
            'line-opacity': glowOp,
            'line-blur':    isSel ? 4 : 2,
          },
        });
        const linePaint: mapboxgl.LinePaint = {
          'line-color':   color,
          'line-width':   width,
          'line-opacity': opacity,
        };
        if (dashArray) linePaint['line-dasharray'] = dashArray;
        map.addLayer({
          id: `${id}-line`, type: 'line', source: id,
          layout: {'line-cap': 'round', 'line-join': 'round'},
          paint: linePaint,
        });
        // Wide invisible hit-line so clicks don't need pixel-perfect aim.
        map.addLayer({
          id: `${id}-hit`, type: 'line', source: id,
          layout: {'line-cap': 'round', 'line-join': 'round'},
          paint: {'line-color': color, 'line-width': 18, 'line-opacity': 0.001},
        });
        if (opt.onClick) {
          const click = () => opt.onClick?.();
          const enter = () => { map.getCanvas().style.cursor = 'pointer'; };
          const leave = () => { map.getCanvas().style.cursor = ''; };
          map.on('click', `${id}-hit`, click);
          map.on('mouseenter', `${id}-hit`, enter);
          map.on('mouseleave', `${id}-hit`, leave);
          altHandlers.current.set(id, {click, enter, leave});
        }
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [alternativeRoutes, fallback, styleNonce]);

  // Sync markers — Audit fix 4.5, diff by id.
  useEffect(() => {
    if (fallback || !mapRef.current) return;
    const map = mapRef.current;

    // Audit fix — drop non-finite coords (NaN / Infinity) before they
    // reach setLngLat. Upstream filters guard null but not NaN; a single
    // bad fix from the backend would otherwise make Mapbox throw and blank
    // the whole map. A marker that goes invalid falls out of nextIds and
    // is removed below.
    const validMarkers = markers.filter(
      m => Number.isFinite(m.lat) && Number.isFinite(m.lng),
    );

    const nextIds = new Set(validMarkers.map(m => m.id));

    // Remove markers that are no longer in the next set.
    for (const [id, entry] of markersById.current) {
      if (!nextIds.has(id)) {
        entry.marker.remove();
        markersById.current.delete(id);
      }
    }

    for (const m of validMarkers) {
      const existing = markersById.current.get(m.id);
      if (existing) {
        // Move/update in place. Only rewrite style attributes when the
        // type changes — keeps the DOM stable so popups don't flicker.
        if (existing.prev.lat !== m.lat || existing.prev.lng !== m.lng) {
          existing.marker.setLngLat([m.lng, m.lat]);
        }
        if (existing.prev.type !== m.type) {
          applyMarkerStyle(existing.el, m.type);
        }
        if (existing.prev.label !== m.label) {
          existing.el.title = m.label ?? m.id;
          // Popup body rebuild — Mapbox doesn't expose a public way to
          // mutate popup HTML, so we replace the popup binding entirely.
          if (m.label) {
            existing.marker.setPopup(
              new mapboxgl.Popup({offset: 14, closeButton: false, className: 'bravo-popup'})
                .setHTML(`<div style="font-family:'JetBrains Mono';font-size:10px;color:#A9C5FF;letter-spacing:0.4px">${escapeHtml(m.label)}</div>`),
            );
          }
        }
        existing.prev = m;
      } else {
        const el = document.createElement('div');
        applyMarkerStyle(el, m.type);
        el.title = m.label ?? m.id;
        const marker = new mapboxgl.Marker(el).setLngLat([m.lng, m.lat]).addTo(map);
        if (m.label) {
          marker.setPopup(
            new mapboxgl.Popup({offset: 14, closeButton: false, className: 'bravo-popup'})
              .setHTML(`<div style="font-family:'JetBrains Mono';font-size:10px;color:#A9C5FF;letter-spacing:0.4px">${escapeHtml(m.label)}</div>`),
          );
        }
        markersById.current.set(m.id, {marker, prev: m, el});
      }
    }
    // Keep markerRefs in sync for any consumer reading it (e.g. style
    // swap path that tears down all markers — unchanged behavior).
    markerRefs.current = Array.from(markersById.current.values()).map(e => e.marker);
  }, [markers, fallback]);

  // Fly to center/zoom only when the coordinate VALUES change. Callers pass
  // `center` as a fresh array literal on every render, and SWR polls re-render
  // them every 2s — keying on the array reference re-fired flyTo on every poll
  // and yanked the camera away from the operator's pan/zoom.
  const [centerLng, centerLat] = center;
  const lastFlyKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (fallback || !mapRef.current) return;
    const key = `${centerLng.toFixed(6)},${centerLat.toFixed(6)},${zoom}`;
    if (lastFlyKeyRef.current === key) return;
    lastFlyKeyRef.current = key;
    mapRef.current.flyTo({center: [centerLng, centerLat], zoom, speed: 1.2});
  }, [centerLng, centerLat, zoom, fallback]);

  if (fallback) {
    return (
      <div
        className={className}
        style={{
          position: 'relative',
          background: 'var(--bg-depth)',
          ...style,
        }}>
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          backgroundImage:
            'linear-gradient(rgba(76,194,255,0.06) 1px, transparent 1px),' +
            'linear-gradient(90deg, rgba(76,194,255,0.06) 1px, transparent 1px)',
          backgroundSize: '36px 36px',
        }} />
        <div style={{
          position: 'absolute', top: 12, left: 14,
          fontFamily: 'JetBrains Mono', fontSize: 10, color: 'var(--tx-3)',
          letterSpacing: 1, textTransform: 'uppercase',
        }}>
          MAPBOX · <span style={{color:'var(--warn)'}}>NO TOKEN — fallback grid</span>
        </div>
        {markers.map(m => (
          <div key={m.id} style={{
            position: 'absolute',
            top: `${pctFromLat(m.lat)}%`, left: `${pctFromLng(m.lng)}%`,
            transform: 'translate(-50%,-50%)',
            width: m.type === 'sos' ? 14 : 10,
            height: m.type === 'sos' ? 14 : 10,
            borderRadius: '50%',
            background: m.type === 'sos' ? '#DC2626' : '#5B8DEF',
            boxShadow: m.type === 'sos'
              ? '0 0 0 3px rgba(220,38,38,0.22), 0 0 16px #DC2626'
              : '0 0 0 2px rgba(91,141,239,0.25), 0 0 12px #5B8DEF',
          }} title={m.label ?? m.id}/>
        ))}
      </div>
    );
  }

  // Uncontrolled mode renders its own style-cycler chip so every console
  // map exposes dark / light / streets / satellite without page wiring.
  // The wrapper keeps the caller's className/style (position defaults to
  // relative so the chip anchors correctly; an explicit style wins).
  return (
    <div className={className} style={{position: 'relative', ...style}}>
      <div ref={container} style={{position: 'absolute', inset: 0}}/>
      {!controlled && (
        <button
          onClick={() => setInternalStyleId(prev =>
            STYLE_CYCLE[(STYLE_CYCLE.indexOf(prev) + 1) % STYLE_CYCLE.length])}
          title="Cycle map style"
          style={{
            position: 'absolute', top: 10, right: 10, zIndex: 5,
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
            background: 'rgba(4,16,31,0.92)', border: '1px solid var(--bd-1)',
            color: 'var(--tx-1)', fontFamily: 'JetBrains Mono', fontSize: 10,
            fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase',
          }}>
          <span style={{
            width: 8, height: 8, borderRadius: 2,
            background: styleId === 'dark' ? '#5B8DEF'
                      : styleId === 'light' ? '#E8EAEE'
                      : styleId === 'streets' ? '#7ED320'
                      : '#FFC107',
          }}/>
          {styleId === 'dark' ? 'DARK' : styleId === 'light' ? 'LIGHT'
            : styleId === 'streets' ? 'STREETS' : 'SAT'}
        </button>
      )}
    </div>
  );
}

// Fallback-mode helpers — normalize arbitrary coords into 0-100% so the
// grid placeholder still looks roughly right when Mapbox is missing.
function pctFromLat(lat: number) {
  // Dubai ~25°N; spread ±1°
  return Math.max(5, Math.min(95, 50 - (lat - 25.2) * 40));
}
function pctFromLng(lng: number) {
  return Math.max(5, Math.min(95, 50 + (lng - 55.27) * 40));
}
