/**
 * Inline Mapbox GL JS HTML for the Bravo location-picker modal.
 *
 * Dark / streets / satellite styles are swap-in-place (no WebView reload).
 * "Locate me" is handled natively by RN (react-native-geolocation-service),
 * which pushes the fix in via `window.showMeAt`.
 *
 * Messages emitted back to RN (`window.ReactNativeWebView.postMessage`):
 *   { type: 'ready' }
 *   { type: 'moveend',  lng, lat, address }
 *   { type: 'locate:denied' | 'locate:error', message }
 */

export interface CoverageCircleGeoJSON {
  id: string;
  label: string;
  lat: number;
  lng: number;
  radiusKm: number;
}

export type MapStyleId = 'dark' | 'light' | 'streets' | 'satellite';

const STYLE_URLS: Record<MapStyleId, string> = {
  dark:      'mapbox://styles/mapbox/dark-v11',
  light:     'mapbox://styles/mapbox/light-v11',
  streets:   'mapbox://styles/mapbox/streets-v12',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
};

export function buildLocationPickerHtml(opts: {
  mapboxToken: string;
  initial: {lat: number; lng: number};
  zones: CoverageCircleGeoJSON[];
  countryCode: string;
  initialStyle?: MapStyleId;
}): string {
  const initialStyle = opts.initialStyle ?? 'dark';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no, viewport-fit=cover"/>
<link href="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.css" rel="stylesheet"/>
<style>
  html, body { margin: 0; padding: 0; background: #05070B; color: #FFFFFF;
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif; overflow: hidden; height: 100%; }
  *, *::before, *::after { box-sizing: border-box; }

  #map { position: absolute; inset: 0; background: #05070B; }

  .grid { position: absolute; inset: 0; pointer-events: none; z-index: 2;
    background-image:
      linear-gradient(rgba(76,194,255,0.05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(76,194,255,0.05) 1px, transparent 1px);
    background-size: 32px 32px; mix-blend-mode: screen; }
  body.satellite .grid, body.light .grid, body.streets .grid { display: none; }
  body.light #map, body.streets #map { background: #F4F5F7; }

  .crosshair {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: 0; height: 0; z-index: 10; pointer-events: none;
  }
  .crosshair .stem {
    position: absolute; left: -1px; top: -2px; width: 2px; height: 40px;
    background: linear-gradient(to bottom, rgba(30,136,255,0.5), #1E88FF);
    border-radius: 2px; transform: translateY(-40px);
  }
  .crosshair .head {
    position: absolute; left: -18px; top: -58px; width: 36px; height: 36px;
    border-radius: 50% 50% 50% 0; transform: rotate(-45deg);
    background: linear-gradient(135deg, #3BA6FF, #1E88FF);
    box-shadow: 0 8px 24px rgba(30,136,255,0.6), inset 0 1px 0 rgba(255,255,255,0.25);
    border: 2px solid rgba(255,255,255,0.9);
  }
  .crosshair .head::after {
    content: ''; position: absolute; inset: 8px; border-radius: 50%; background: #FFFFFF;
  }
  .crosshair .dot {
    position: absolute; left: -4px; top: -4px; width: 8px; height: 8px;
    border-radius: 50%; background: #1E88FF;
    box-shadow: 0 0 10px rgba(30,136,255,0.8);
  }

  .legend {
    position: absolute; left: 12px; top: 12px; z-index: 12;
    padding: 6px 10px; border-radius: 6px;
    background: rgba(6,20,43,0.85); border: 1px solid rgba(30,136,255,0.35);
    color: #B8C7E0; font-size: 10px; letter-spacing: 1px; text-transform: uppercase;
    font-family: "JetBrains Mono", monospace;
  }
  .legend .dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: #1E88FF; margin-right: 6px; vertical-align: middle;
    box-shadow: 0 0 8px rgba(30,136,255,0.6);
  }

  /* User-location marker (distinct from pin) */
  .me-dot {
    width: 14px; height: 14px; border-radius: 50%;
    background: #4ADE80; border: 2px solid #FFF;
    box-shadow: 0 0 0 4px rgba(74,222,128,0.25), 0 0 16px rgba(74,222,128,0.6);
  }
</style>
</head>
<body class="${initialStyle}">
<div id="map"></div>
<div class="grid"></div>
<div class="crosshair">
  <div class="head"></div>
  <div class="stem"></div>
  <div class="dot"></div>
</div>
<div class="legend"><span class="dot"></span>Coverage</div>

<script src="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.js"></script>
<script>
  mapboxgl.accessToken = ${JSON.stringify(opts.mapboxToken)};
  const COUNTRY = ${JSON.stringify(opts.countryCode)};
  const ZONES   = ${JSON.stringify(opts.zones)};
  const STYLE_URLS = ${JSON.stringify(STYLE_URLS)};
  let currentStyleId = ${JSON.stringify(initialStyle)};

  // B-89 P3 — fail fast on WebGL context-creation failure instead of a
  // silent throw the RN watchdog only notices 15 s later.
  let map;
  try {
    map = new mapboxgl.Map({
      container: 'map',
      style: STYLE_URLS[currentStyleId],
      center: ${JSON.stringify([Number(opts.initial.lng), Number(opts.initial.lat)])},
      zoom: 11.5,
      minZoom: 7,
      maxZoom: 19,
      attributionControl: false,
      interactive: true,
      antialias: true,
    });
  } catch (e) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify({type: 'err', where: 'init', msg: String(e)})); } catch (_) {}
    throw e;
  }
  map.addControl(new mapboxgl.AttributionControl({compact: true}), 'bottom-right');

  // High-zoom detail: extruded 3D buildings under the first label layer.
  // Vector styles only — satellite has no extrusion data worth drawing.
  function addDetailLayers() {
    try {
      if (currentStyleId === 'satellite') return;
      if (map.getLayer('bravo-3d-buildings')) return;
      const layers = (map.getStyle().layers) || [];
      let labelId;
      for (const l of layers) {
        if (l.type === 'symbol' && l.layout && l.layout['text-field']) { labelId = l.id; break; }
      }
      const lightish = currentStyleId === 'light' || currentStyleId === 'streets';
      map.addLayer({
        id: 'bravo-3d-buildings', source: 'composite', 'source-layer': 'building',
        filter: ['==', ['get', 'extrude'], 'true'], type: 'fill-extrusion', minzoom: 14.5,
        paint: {
          'fill-extrusion-color': lightish ? '#D9DDE4' : '#1E2634',
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 16, ['get', 'height']],
          'fill-extrusion-base':   ['interpolate', ['linear'], ['zoom'], 14.5, 0, 16, ['get', 'min_height']],
          'fill-extrusion-opacity': 0.6,
        },
      }, labelId);
    } catch (_) {}
  }

  function circleFeature(lng, lat, radiusKm, id, label) {
    const coords = [];
    const steps = 64;
    const R = 6371;
    const latRad = lat * Math.PI / 180;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * 2 * Math.PI;
      const dx = radiusKm * Math.cos(a) / (R * Math.cos(latRad)) * 180 / Math.PI;
      const dy = radiusKm * Math.sin(a) / R * 180 / Math.PI;
      coords.push([lng + dx, lat + dy]);
    }
    return {
      type: 'Feature',
      properties: {id, label},
      geometry: {type: 'Polygon', coordinates: [coords]},
    };
  }

  function mountCoverageLayers() {
    if (!map.getSource('coverage')) {
      const features = ZONES.map(z => circleFeature(z.lng, z.lat, z.radiusKm, z.id, z.label));
      map.addSource('coverage', {
        type: 'geojson',
        data: {type: 'FeatureCollection', features},
      });
    }
    if (!map.getLayer('coverage-fill')) {
      map.addLayer({
        id: 'coverage-fill',
        type: 'fill',
        source: 'coverage',
        paint: { 'fill-color': '#1E88FF', 'fill-opacity': 0.14 },
      });
    }
    if (!map.getLayer('coverage-outline')) {
      map.addLayer({
        id: 'coverage-outline',
        type: 'line',
        source: 'coverage',
        paint: { 'line-color': '#1E88FF', 'line-width': 1.5, 'line-opacity': 0.6 },
      });
    }
  }

  map.on('load', () => {
    mountCoverageLayers();
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'ready'}));
    }
    emitMoveEnd();
  });

  // Style change: coverage layers get dropped when the style swaps,
  // so re-add them on styledata.
  map.on('styledata', () => {
    try { mountCoverageLayers(); } catch(_) {}
  });
  // Detail layers mount only on 'style.load' (initial + after each swap) —
  // adding while a style is still streaming corrupts the load.
  map.on('style.load', () => {
    try { addDetailLayers(); } catch(_) {}
  });

  async function reverseGeocode(lng, lat) {
    // No country filter — the lat/lng is unambiguous. Ask for narrow
    // types first (address/poi/neighborhood) so the pin reads as a
    // specific spot, then fall back to locality if nothing finer
    // exists. Each feature has a context array with the parent country,
    // which we extract so the search box can scope to the right country.
    async function ask(types) {
      // language=en is load-bearing, not cosmetic. Without it Mapbox returns
      // place_name in the local script — in the UAE that is Arabic — and this
      // value is what gets STORED on the booking and then replayed on every
      // client-facing surface (the route timeline, the map pins, the booking
      // summary). The founder's "descriptions is not what I chose" and
      // "description - English (UAE)" both trace back to this one missing param.
      const url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/' +
        lng.toFixed(6) + ',' + lat.toFixed(6) +
        '.json?access_token=' + encodeURIComponent(mapboxgl.accessToken) +
        '&types=' + encodeURIComponent(types) +
        '&language=en' +
        '&limit=1';
      try {
        const r = await fetch(url);
        const j = await r.json();
        const feat = (j && j.features && j.features[0]) || null;
        if (!feat) return null;
        var ctx = feat.context || [];
        var countryCtx = ctx.find(function(c){
          return c && typeof c.id === 'string' && c.id.indexOf('country') === 0;
        });
        var country = (countryCtx && countryCtx.short_code) ? String(countryCtx.short_code).toLowerCase() : '';
        return { address: feat.place_name, country: country };
      } catch (_) { return null; }
    }
    var hit = (await ask('address,poi,neighborhood')) || (await ask('locality,place'));
    return hit || { address: '', country: '' };
  }

  let moveTimer = null;
  let lastGeo = null;
  function scheduleEmit() {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(emitMoveEnd, 350);
  }

  function distM(lng1, lat1, lng2, lat2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng/2) * Math.sin(dLng/2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  async function emitMoveEnd() {
    const c = map.getCenter();
    // Why: a reverse-geocode per pan-stop is quota + latency — reuse the last
    // result when the pin barely moved (<25 m).
    let r;
    if (lastGeo && distM(lastGeo.lng, lastGeo.lat, c.lng, c.lat) < 25) {
      r = lastGeo;
    } else {
      r = await reverseGeocode(c.lng, c.lat);
      lastGeo = {lng: c.lng, lat: c.lat, address: r.address, country: r.country};
    }
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'moveend',
        lng: c.lng, lat: c.lat,
        address: r.address,
        country: r.country,
      }));
    }
  }

  map.on('moveend', scheduleEmit);

  // ── External API for RN ─────────────────────────────────────────
  window.setMapStyle = function(styleId) {
    if (!STYLE_URLS[styleId]) return;
    currentStyleId = styleId;
    document.body.classList.remove('dark','light','streets','satellite');
    document.body.classList.add(styleId);
    map.setStyle(STYLE_URLS[styleId]);
  };

  let meMarker = null;
  // Called by RN after it gets GPS natively (via react-native-geolocation-service).
  window.showMeAt = function(lng, lat) {
    if (typeof lng !== 'number' || typeof lat !== 'number') return;
    if (meMarker) meMarker.remove();
    const el = document.createElement('div');
    el.className = 'me-dot';
    meMarker = new mapboxgl.Marker({element: el})
      .setLngLat([lng, lat])
      .addTo(map);
    map.flyTo({center: [lng, lat], zoom: 14.5, duration: 700});
  };

  window.recentre = function(lng, lat) {
    map.flyTo({center: [lng, lat], zoom: 14, duration: 600});
  };
</script>
</body>
</html>`;
}
