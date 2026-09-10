/**
 * Mapbox HTML for the Agent Live Tracker — extends the existing
 * live-route map with a CPO + Principal marker pair, on-map speech
 * bubbles, system event bubbles, an awaiting-telemetry pill, and a
 * style toggle.
 *
 * RN drives the canvas via:
 *   window.setRoute({pickup, dropoff, polyline})
 *   window.setNavRoute({traveled, ahead})   // turn-by-turn split (Step 31)
 *   window.setCpo({lat, lng, callsign, heading_deg})
 *   window.setPrincipal({lat, lng})
 *   window.pushBubble({id, kind, sender, name, preview, ttl})
 *   window.pushSystem({id, label, preview, lat, lng, ttl})
 *   window.setStyle('dark' | 'light' | 'sat' | '3d')
 *   window.setAwaiting(true | false)
 */

export function buildAgentTrackerHtml(mapboxToken: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no, viewport-fit=cover"/>
<link href="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.css" rel="stylesheet"/>
<style>
  html, body { margin: 0; padding: 0; background: #05070B; overflow: hidden; height: 100%;
    font-family: "Manrope", -apple-system, "Segoe UI", Roboto, sans-serif; color: #FFF; }
  *, *::before, *::after { box-sizing: border-box; }

  #map { position: absolute; inset: 0; background: #05070B; }
  .grid { position: absolute; inset: 0; pointer-events: none; z-index: 2;
    background-image:
      linear-gradient(rgba(76,194,255,0.05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(76,194,255,0.05) 1px, transparent 1px);
    background-size: 32px 32px;
    -webkit-mask-image: radial-gradient(ellipse 70% 70% at 50% 50%, black 30%, transparent 90%);
    mask-image: radial-gradient(ellipse 70% 70% at 50% 50%, black 30%, transparent 90%);
  }
  /* Issue 42 — this was a hard-coded bottom: 150px, which sat ON TOP of the RN
     journey rail (steps 5 "Protection active" and 6 "Completed"). The WebView
     cannot know the RN overlay's height, so the screen MEASURES its bottom dock
     and sets --recenter-bottom. The literal below is only the pre-measure
     fallback, never the steady state.
     NOTE: this whole file is one template literal — no backticks in comments. */
  .recenter {
    position: absolute; right: 12px; bottom: var(--recenter-bottom, 150px); z-index: 30;
    padding: 6px 10px; border-radius: 6px; cursor: pointer;
    background: rgba(6,20,43,0.92); border: 1px solid #4CC2FF;
    font-family: "JetBrains Mono", monospace;
    font-size: 10px; font-weight: 700; color: #4CC2FF;
    letter-spacing: 1px; text-transform: uppercase;
    display: none; -webkit-tap-highlight-color: transparent; user-select: none;
  }

  /* ── Pins (pickup / dropoff) ───────────────────────────── */
  .pin { position: relative; width: 0; height: 0; }
  .pin .body {
    position: absolute; left: -15px; top: -30px;
    width: 30px; height: 30px; border-radius: 50% 50% 50% 6px;
    transform: rotate(-45deg);
    display: flex; align-items: center; justify-content: center;
    border: 2px solid #fff;
    box-shadow: 0 6px 16px -4px rgba(0,0,0,0.5);
  }
  .pin .body span {
    transform: rotate(45deg);
    font-family: "JetBrains Mono", monospace;
    font-size: 11px; font-weight: 800; color: #fff;
  }
  .pin.pickup .body  { background: #00C853; }
  .pin.dropoff .body { background: #FFC107; }
  .pin.dropoff .body span { color: #04101F; }
  .pin .lbl {
    position: absolute; left: 50%; top: -54px;
    transform: translateX(-50%);
    background: rgba(6,20,43,0.92); border: 1px solid #1C3B66;
    padding: 3px 7px; border-radius: 5px;
    font-family: "JetBrains Mono", monospace;
    font-size: 9px; font-weight: 700; color: #B8C7E0;
    letter-spacing: 1.2px; text-transform: uppercase; white-space: nowrap;
  }

  /* ── Markers (CPO + Principal) ─────────────────────────── */
  .mk { position: relative; width: 0; height: 0; }
  .mk.cpo .core {
    position: absolute; left: -11px; top: -11px;
    width: 22px; height: 22px; border-radius: 50%;
    background: #1E88FF; border: 3px solid #fff;
    box-shadow: 0 0 0 3px rgba(30,136,255,0.3), 0 0 16px rgba(30,136,255,0.7);
  }
  .mk.cpo::before {
    content: ''; position: absolute; left: -23px; top: -23px;
    width: 46px; height: 46px; border-radius: 50%;
    border: 1.5px solid #1E88FF; opacity: 0.4;
    animation: ring 2.4s infinite;
  }
  /* Navigation puck — the Google-Maps / Mapbox chevron that shows WHERE the
     vehicle is and WHICH WAY it is pointing, as one mark sitting on the route.
     It replaces the old detached cone floating 6px above a dot, which read as
     two unrelated marks at speed.
     Shown ONLY once a bearing is known (.nav): an arrowhead pointing an
     arbitrary direction is worse than an honest dot, so with no fix history
     the plain .core dot stays. */
  .mk.cpo .puck {
    position: absolute; left: -19px; top: -19px;
    width: 38px; height: 38px;
    transform-origin: 50% 50%;
    transform: rotate(0deg);
    display: none;
  }
  .mk.cpo .puck svg {
    display: block;
    filter: drop-shadow(0 2px 5px rgba(0,0,0,0.55));
  }
  .mk.cpo.nav .puck { display: block; }
  .mk.cpo.nav .core { display: none; }
  .mk.cpo .callsign {
    position: absolute; left: 16px; top: -8px;
    font-family: "JetBrains Mono", monospace;
    font-size: 9.5px; font-weight: 800; color: #7ED6FF;
    letter-spacing: 1px;
    background: rgba(6,20,43,0.85); padding: 2px 6px;
    border-radius: 4px; border: 1px solid #1C3B66;
    white-space: nowrap;
  }
  .mk.principal .core {
    position: absolute; left: -9px; top: -9px;
    width: 18px; height: 18px; border-radius: 50%;
    background: #7ED6FF; border: 2.5px solid #fff;
    box-shadow: 0 0 12px rgba(126,214,255,0.6);
  }
  .mk.principal .lbl {
    position: absolute; left: 50%; top: 14px;
    transform: translateX(-50%);
    font-family: "JetBrains Mono", monospace;
    font-size: 9px; font-weight: 700; color: #B8C7E0;
    letter-spacing: 0.8px;
    background: rgba(6,20,43,0.85); padding: 2px 5px;
    border-radius: 4px; white-space: nowrap;
  }

  /* ── Speech bubbles (anchored to a marker) ─────────────── */
  .bub {
    position: absolute; transform: translate(-50%, calc(-100% - 32px));
    display: flex; align-items: center; gap: 8px;
    padding: 7px 11px 7px 7px;
    background: #1B3A66; border: 1px solid #244C82;
    border-radius: 14px;
    box-shadow: 0 8px 24px -6px rgba(0,0,0,0.55), 0 0 0 1px rgba(126,214,255,0.06);
    max-width: 240px; pointer-events: auto;
    animation: bubbleIn 200ms ease-out;
  }
  .bub::after {
    content: ''; position: absolute; bottom: -7px; left: 24px;
    width: 12px; height: 12px; background: #1B3A66;
    border-right: 1px solid #244C82; border-bottom: 1px solid #244C82;
    transform: rotate(45deg);
  }
  .bub .av {
    width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-family: "Manrope", sans-serif; font-size: 10px; font-weight: 800; color: #fff;
    background: linear-gradient(135deg, #244C82, #1E88FF);
    border: 1.5px solid rgba(255,255,255,0.18);
  }
  .bub .meta { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .bub .name {
    font-family: "JetBrains Mono", monospace;
    font-size: 9px; font-weight: 800; color: #7ED6FF;
    letter-spacing: 1.2px; text-transform: uppercase;
  }
  .bub .preview {
    font-family: "Manrope", sans-serif; font-size: 12px;
    color: #fff; font-weight: 500;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 190px; line-height: 1.25;
  }

  /* System variant — square, info-blue */
  .bub.sys {
    background: rgba(76,194,255,0.10);
    border: 1px solid rgba(76,194,255,0.4);
    border-radius: 6px; padding: 6px 10px;
  }
  .bub.sys::after {
    background: rgba(76,194,255,0.10);
    border-right-color: rgba(76,194,255,0.4);
    border-bottom-color: rgba(76,194,255,0.4);
  }
  .bub.sys .av {
    width: 14px; height: 14px; border-radius: 3px;
    background: #4CC2FF; color: #04101F;
  }
  .bub.sys .name { color: #4CC2FF; }
  .bub.sys .preview { font-size: 11.5px; }

  /* SOS variant — red, holds indefinitely */
  .bub.sos {
    background: rgba(255,59,59,0.12);
    border-color: #FF3B3B;
    box-shadow: 0 8px 24px -6px rgba(0,0,0,0.55),
                0 0 0 1px rgba(255,59,59,0.4),
                0 0 18px rgba(255,59,59,0.2);
  }
  .bub.sos::after {
    background: rgba(255,59,59,0.12);
    border-right-color: #FF3B3B; border-bottom-color: #FF3B3B;
  }
  .bub.sos .av { background: #FF3B3B; }
  .bub.sos .name { color: #FFB4B4; }

  /* Stacked-behind layer */
  .bub.behind {
    opacity: 0.78;
    transform: translate(-50%, calc(-100% - 32px - 14px)) scale(0.94);
  }

  /* +N collapse chip */
  .chip {
    position: absolute; transform: translate(-50%, calc(-100% - 4px));
    font-family: "JetBrains Mono", monospace;
    font-size: 10px; font-weight: 800; letter-spacing: 0.6px;
    color: #7ED6FF;
    background: rgba(22,47,84,0.95);
    border: 1px solid #244C82;
    padding: 3px 8px; border-radius: 11px;
    box-shadow: 0 4px 10px -2px rgba(0,0,0,0.5);
  }

  /* Bubble unmount */
  .bub.out, .chip.out {
    animation: bubbleOut 180ms ease-in forwards;
  }

  @keyframes ring {
    0% { transform: scale(0.6); opacity: 0.5; }
    100% { transform: scale(2.2); opacity: 0; }
  }
  @keyframes bubbleIn {
    from { opacity: 0; transform: translate(-50%, calc(-100% - 28px)) scale(0.92); }
    to   { opacity: 1; transform: translate(-50%, calc(-100% - 32px)) scale(1); }
  }
  @keyframes bubbleOut {
    from { opacity: 1; }
    to   { opacity: 0; transform: translate(-50%, calc(-100% - 36px)) scale(0.96); }
  }

  /* Bubble layer — overlays the map but doesn't block gestures */
  #bubbles, #chips {
    position: absolute; inset: 0; pointer-events: none; z-index: 8;
  }
  #bubbles .bub, #chips .chip { pointer-events: auto; }
</style>
</head>
<body>
<div id="map"></div>
<div class="grid"></div>
<div id="bubbles"></div>
<div id="chips"></div>
<div class="recenter" id="recenter">⌖ Follow</div>

<script src="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.js"></script>
<script>
  mapboxgl.accessToken = ${JSON.stringify(mapboxToken)};

  const STYLES = {
    dark:  'mapbox://styles/mapbox/dark-v11',
    light: 'mapbox://styles/mapbox/light-v11',
    sat:   'mapbox://styles/mapbox/satellite-streets-v12',
    '3d':  'mapbox://styles/mapbox/standard',
  };
  let currentStyleName = 'dark';

  // Declared BEFORE the map-init try/catch below, which calls it. It used to
  // be declared ~60 lines further down, so the one path that needed it most —
  // a WebGL context-creation failure, which throws synchronously out of the
  // Map constructor — hit the const's temporal dead zone and raised
  // "Cannot access 'post' before initialization" instead of reporting. RN then
  // received nothing and sat out the full 15 s watchdog, which is exactly the
  // fail-fast the catch was written to avoid.

  /**
   * [MAPPERF] Boot cost, split by phase, so a slow map is diagnosed instead of
   * guessed at. glCached is the load-bearing number: Resource Timing reports
   * transferSize===0 for a cache hit, so it answers "did the prewarm work?"
   * directly. Wrapped in try/catch — a browser without Resource Timing must
   * degrade to a normal ready, never break the map.
   */
  function mapPerf() {
    try {
      var rs = (performance.getEntriesByType && performance.getEntriesByType('resource')) || [];
      var out = {tReadyMs: Math.round(performance.now()), glMs: -1, glCached: null,
                 styleMs: 0, tiles: 0, netKb: 0};
      for (var i = 0; i < rs.length; i++) {
        var r = rs[i], n = r.name || '';
        if (n.indexOf('mapbox-gl.js') >= 0) {
          out.glMs = Math.round(r.duration);
          out.glCached = r.transferSize === 0;
        } else if (n.indexOf('/styles/') >= 0) {
          out.styleMs += Math.round(r.duration);
        } else if (n.indexOf('/tiles/') >= 0 || n.indexOf('.pbf') >= 0) {
          out.tiles++;
        }
        out.netKb += (r.transferSize || 0) / 1024;
      }
      out.netKb = Math.round(out.netKb);
      return out;
    } catch (_) { return {}; }
  }

  const post = (msg) => {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    }
  };

  // B-89 MG-12 — coordinate sanity: non-finite / out-of-range / (0,0)
  // payloads must never teleport a marker to null island.
  function validLL(lng, lat) {
    return isFinite(lng) && isFinite(lat)
      && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      && !(lng === 0 && lat === 0);
  }

  // B-89 P3 — WebGL context-creation failures used to throw before any
  // postMessage existed; fail fast so RN skips the 15 s watchdog wait.
  let map;
  try {
    map = new mapboxgl.Map({
      container: 'map',
      style: STYLES.dark,
      center: [55.2708, 25.2048],
      zoom: 13,
      minZoom: 6, maxZoom: 18,
      attributionControl: false,
      interactive: true,
      antialias: true,
    });
  } catch (e) {
    post({type: 'err', where: 'init', msg: String(e)});
    throw e;
  }
  map.addControl(new mapboxgl.AttributionControl({compact: true}), 'bottom-right');

  // MG-11 — surface GL boot errors (bad token, style fetch) to RN; the
  // RN side fast-fails only while pre-ready, so benign post-load tile
  // errors can't remount a working map.
  map.on('error', function(e) {
    post({type: 'err', where: 'map', msg: (e && e.error && e.error.message) || 'map-error'});
  });

  // High-zoom detail: extruded 3D buildings under the first label layer.
  // dark/light only — satellite has imagery, standard is already 3D.
  function addDetailLayers() {
    try {
      if (currentStyleName !== 'dark' && currentStyleName !== 'light') return;
      if (map.getLayer('bravo-3d-buildings')) return;
      const layers = (map.getStyle().layers) || [];
      let labelId;
      for (const l of layers) {
        if (l.type === 'symbol' && l.layout && l.layout['text-field']) { labelId = l.id; break; }
      }
      map.addLayer({
        id: 'bravo-3d-buildings', source: 'composite', 'source-layer': 'building',
        filter: ['==', ['get', 'extrude'], 'true'], type: 'fill-extrusion', minzoom: 14.5,
        paint: {
          'fill-extrusion-color': currentStyleName === 'light' ? '#D9DDE4' : '#1E2634',
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 16, ['get', 'height']],
          'fill-extrusion-base':   ['interpolate', ['linear'], ['zoom'], 14.5, 0, 16, ['get', 'min_height']],
          'fill-extrusion-opacity': 0.6,
        },
      }, labelId);
    } catch (e) {}
  }

  let pickupMk = null, dropoffMk = null, cpoMk = null, principalMk = null;
  // Markers indexed by anchor key so bubbles can re-project from current map state.
  const anchors = { cpo: null, principal: null };

  // Turn-by-turn camera + route ownership (Step 31 review fixes):
  //  - navActive: once setNavRoute drives the line, setRoute stops rewriting the
  //    route source so the two writers never clobber each other.
  //  - framedOnce: fitBounds frames the trip ONCE; after that the camera follows.
  //  - follow: auto-follow the CPO during nav until the user drags the map.
  //  - lastBase/lastNav: cached payloads re-applied after a style swap wipes layers.
  let navActive = false, framedOnce = false, follow = true, centeredOnce = false;
  let lastBasePayload = null, lastNavPayload = null;

  // Track-up camera. In 'course' mode the map rotates so the direction of
  // travel is always screen-up, the view is pitched, and the vehicle sits in
  // the lower third so the road ahead fills the screen — what a driver
  // expects. 'north' pins bearing 0 / pitch 0.
  //
  // Bearing is course-over-ground derived from consecutive fixes, not a
  // compass: it is the direction the vehicle is actually travelling, and it
  // only updates once the vehicle has moved MIN_COURSE_M, so a parked vehicle
  // cannot spin the map on GPS noise. A server-supplied heading_deg seeds it
  // before the first movement.
  const NAV_PITCH = 55, MIN_COURSE_M = 6, NAV_OFFSET_FRAC = 0.20;
  let navMode = 'course', navBearing = 0, haveBearing = false, lastCourseLL = null;

  function bearingDeg(a, b) {
    const y1 = a[1] * Math.PI / 180, y2 = b[1] * Math.PI / 180;
    const dx = (b[0] - a[0]) * Math.PI / 180;
    const y = Math.sin(dx) * Math.cos(y2);
    const x = Math.cos(y1) * Math.sin(y2) - Math.sin(y1) * Math.cos(y2) * Math.cos(dx);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function metresBetween(a, b) {
    const mLat = 111320, mLng = 111320 * Math.cos(a[1] * Math.PI / 180);
    return Math.hypot((b[0] - a[0]) * mLng, (b[1] - a[1]) * mLat);
  }
  // Shortest-arc blend, so 350 -> 10 turns +20 degrees and not -340.
  function blendBearing(from, to, k) {
    const d = ((to - from + 540) % 360) - 180;
    return (from + d * k + 360) % 360;
  }
  function navOffset() {
    const h = (map.getContainer() && map.getContainer().clientHeight) || 0;
    return [0, Math.round(h * NAV_OFFSET_FRAC)];
  }
  function courseUpNow() {
    return navActive && navMode === 'course' && haveBearing;
  }
  // The heading cone is a screen-space DOM element, so in course-up mode
  // (where the map itself is rotated to the course) it must be counter-rotated
  // by the map bearing or the rotation is applied twice.
  function paintNavPuck() {
    if (!cpoMk || !haveBearing) return;
    const root = cpoMk.getElement().querySelector('.mk.cpo');
    // The .nav class is what swaps the honest dot for the directional chevron,
    // so it is set HERE — the same place that proves a bearing exists.
    if (root) root.classList.add('nav');
    const puck = cpoMk.getElement().querySelector('.puck');
    if (!puck) return;
    puck.style.transform = 'rotate(' + (navBearing - map.getBearing()) + 'deg)';
  }

  function makeMk(html, lngLat, opts = {}) {
    const el = document.createElement('div');
    el.innerHTML = html;
    return new mapboxgl.Marker({element: el, anchor: 'center', ...opts}).setLngLat(lngLat).addTo(map);
  }

  function ensureRouteLayer() {
    if (!map.getSource('route')) {
      map.addSource('route', {type: 'geojson', data: {type: 'FeatureCollection', features: []}});
    }
    if (!map.getLayer('route-base')) {
      map.addLayer({
        id: 'route-base', type: 'line', source: 'route',
        filter: ['==', ['get', 'kind'], 'base'],
        paint: {'line-color': '#7ED6FF', 'line-opacity': 0.2, 'line-width': 5,
                'line-cap': 'round'},
      });
    }
    if (!map.getLayer('route-active')) {
      map.addLayer({
        id: 'route-active', type: 'line', source: 'route',
        filter: ['==', ['get', 'kind'], 'active'],
        paint: {'line-color': '#1E88FF', 'line-width': 3, 'line-cap': 'round',
                'line-blur': 0.5},
      });
    }
    if (!map.getLayer('route-future')) {
      map.addLayer({
        id: 'route-future', type: 'line', source: 'route',
        filter: ['==', ['get', 'kind'], 'future'],
        paint: {'line-color': '#7ED6FF', 'line-width': 2.5,
                'line-dasharray': [2, 2], 'line-opacity': 0.5},
      });
    }
  }

  // Decode polyline (Mapbox-encoded). Lifted from the standard
  // implementation — runs once per route change so the cost is fine.
  function decodePolyline(str, precision) {
    const factor = Math.pow(10, precision || 5);
    let index = 0, lat = 0, lng = 0;
    const coords = [];
    while (index < str.length) {
      let result = 0, shift = 0, b;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += ((result & 1) ? ~(result >> 1) : (result >> 1));
      result = 0; shift = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += ((result & 1) ? ~(result >> 1) : (result >> 1));
      coords.push([lng / factor, lat / factor]);
    }
    return coords;
  }

  map.on('load', () => {
    post(Object.assign({type: 'ready'}, mapPerf()));
  });
  // 'style.load' fires when a style becomes fully usable — on the INITIAL
  // style and after every setStyle swap. Never mount layers on the early
  // 'styledata' ticks: adding while a style streams in corrupts the load.
  map.on('style.load', () => {
    try {
      ensureRouteLayer();
      addDetailLayers();
      if (navActive && lastNavPayload) { window.setNavRoute(lastNavPayload); }
      else if (lastBasePayload) { window.setRoute(lastBasePayload); }
      relayoutBubbles();
    } catch (e) {}
  });

  // ── Public API ──────────────────────────────────────────

  window.setRoute = function(payload) {
    try {
      lastBasePayload = payload || {};
      const {pickup, dropoff, polyline} = payload || {};
      if (pickupMk) { pickupMk.remove(); pickupMk = null; }
      if (dropoffMk) { dropoffMk.remove(); dropoffMk = null; }

      if (pickup) {
        pickupMk = makeMk(
          '<div class="pin pickup"><div class="lbl">Pickup</div><div class="body"><span>P</span></div></div>',
          [pickup.lng, pickup.lat]
        );
      }
      if (dropoff) {
        dropoffMk = makeMk(
          '<div class="pin dropoff"><div class="lbl">Dropoff</div><div class="body"><span>D</span></div></div>',
          [dropoff.lng, dropoff.lat]
        );
      }

      ensureRouteLayer();
      // Once turn-by-turn is driving the line (setNavRoute), DON'T rewrite the
      // route source here — the two writers would clobber each other (the base-
      // only redraw would erase the active/future split).
      if (!navActive) {
        const src = map.getSource('route');
        const features = [];
        if (polyline) {
          const coords = decodePolyline(polyline, 6);
          if (coords.length >= 2) {
            features.push({type: 'Feature', properties: {kind: 'base'},
                           geometry: {type: 'LineString', coordinates: coords}});
          }
        } else if (pickup && dropoff) {
          features.push({type: 'Feature', properties: {kind: 'base'},
                         geometry: {type: 'LineString',
                                    coordinates: [[pickup.lng, pickup.lat], [dropoff.lng, dropoff.lat]]}});
        }
        if (src && src.setData) src.setData({type: 'FeatureCollection', features});
      }

      // Frame the trip ONCE; after that the camera follows the CPO (setCpo) so it
      // doesn't snap back to the full overview on every fix.
      if (pickup && dropoff && !framedOnce) {
        const b = new mapboxgl.LngLatBounds();
        b.extend([pickup.lng, pickup.lat]);
        b.extend([dropoff.lng, dropoff.lat]);
        map.fitBounds(b, {padding: {top: 160, bottom: 220, left: 60, right: 60}, duration: 700, maxZoom: 14});
        framedOnce = true;
      }
    } catch (e) { post({type: 'err', where: 'setRoute', msg: String(e)}); }
  };

  // Turn-by-turn split (Step 31). Feed the route-active (traveled, solid glow)
  // and route-future (ahead, dashed) layers from the live Directions geometry so
  // the line behind the guard reads "done" and the line ahead reads "to go" —
  // Google-Maps style. \`traveled\`/\`ahead\` are arrays of [lng,lat] pairs.
  window.setNavRoute = function(payload) {
    try {
      lastNavPayload = payload || {};
      const {traveled, ahead} = payload || {};
      ensureRouteLayer();
      const src = map.getSource('route');
      if (!src || !src.setData) return;
      const clean = (arr) => (Array.isArray(arr) ? arr.filter(c => Array.isArray(c) && c.length === 2) : []);
      const t = clean(traveled);
      const a = clean(ahead);
      const full = t.concat(a);
      const features = [];
      // Base = the whole path (faint underlay).
      if (full.length >= 2) {
        features.push({type: 'Feature', properties: {kind: 'base'},
                       geometry: {type: 'LineString', coordinates: full}});
      }
      // Active = traveled (solid glow); Future = ahead (dashed) — matches the design.
      if (t.length >= 2) {
        features.push({type: 'Feature', properties: {kind: 'active'},
                       geometry: {type: 'LineString', coordinates: t}});
      }
      if (a.length >= 2) {
        features.push({type: 'Feature', properties: {kind: 'future'},
                       geometry: {type: 'LineString', coordinates: a}});
      }
      // B-89 MG-08 — navActive used to LATCH true forever here, so once
      // turn-by-turn had run, an empty nav update (Directions unavailable
      // on a NEW leg) left the previous leg's line on screen and blocked
      // setRoute's base-line writer permanently. Mirror the client HTML:
      // nav owns the line only while it has geometry.
      navActive = features.length > 0;
      src.setData({type: 'FeatureCollection', features});
      if (!navActive && lastBasePayload) { window.setRoute(lastBasePayload); }
    } catch (e) { post({type: 'err', where: 'setNavRoute', msg: String(e)}); }
  };

  // Glide a marker between fixes instead of teleporting; snaps on
  // implausible jumps (~>5 km). Keeps the bubble anchor in sync per frame.
  const mkAnims = {};
  function glideMk(mk, key, target, anchorsKey) {
    if (!mk) return;
    const cur0 = mk.getLngLat();
    const from = [cur0.lng, cur0.lat];
    const dLng = target[0] - from[0], dLat = target[1] - from[1];
    if (mkAnims[key]) cancelAnimationFrame(mkAnims[key]);
    if (Math.abs(dLng) > 0.05 || Math.abs(dLat) > 0.05) {
      mk.setLngLat(target);
      if (anchorsKey) anchors[anchorsKey] = target;
      relayoutBubbles();
      return;
    }
    const start = performance.now(), dur = 900;
    function step(now) {
      const t = Math.min(1, (now - start) / dur);
      const k = t * (2 - t);
      const cur = [from[0] + dLng * k, from[1] + dLat * k];
      mk.setLngLat(cur);
      if (anchorsKey) anchors[anchorsKey] = cur;
      relayoutBubbles();
      if (t < 1) mkAnims[key] = requestAnimationFrame(step);
    }
    mkAnims[key] = requestAnimationFrame(step);
  }

  window.setCpo = function(payload) {
    try {
      const {lat, lng, callsign, heading_deg} = payload || {};
      if (lat == null || lng == null) return;
      if (!validLL(lng, lat)) return; // MG-12 — never draw null island
      if (!cpoMk) {
        // Why: callsign is server data — it must land via textContent, never innerHTML.
        cpoMk = makeMk(
          '<div class="mk cpo">' +
            '<div class="puck"><svg viewBox="0 0 38 38" width="38" height="38" aria-hidden="true">' +
              '<path d="M19 3.5 L31 31.5 L19 24.5 L7 31.5 Z" fill="#1E88FF" stroke="#ffffff" ' +
              'stroke-width="2.6" stroke-linejoin="round"/></svg></div>' +
            '<div class="core"></div>' +
            '<div class="callsign"></div></div>',
          [lng, lat]
        );
        const cs0 = cpoMk.getElement().querySelector('.callsign');
        if (cs0) cs0.textContent = callsign || 'CPO · YOU';
        anchors.cpo = [lng, lat];
      } else {
        const cs = cpoMk.getElement().querySelector('.callsign');
        if (cs && callsign) cs.textContent = callsign;
        glideMk(cpoMk, 'cpo', [lng, lat], 'cpo');
      }
      // Seed the bearing from the server heading so the very first frame is
      // oriented; course over ground takes over as soon as the vehicle moves.
      if (!haveBearing && heading_deg != null) {
        navBearing = heading_deg;
        haveBearing = true;
      }
      if (!lastCourseLL) {
        lastCourseLL = [lng, lat];
      } else if (metresBetween(lastCourseLL, [lng, lat]) >= MIN_COURSE_M) {
        const raw = bearingDeg(lastCourseLL, [lng, lat]);
        navBearing = haveBearing ? blendBearing(navBearing, raw, 0.45) : raw;
        haveBearing = true;
        lastCourseLL = [lng, lat];
      }
      paintNavPuck();
      // Follow-camera during turn-by-turn nav — keep the moving CPO framed until
      // the user takes manual control (dragstart flips the follow flag off).
      if (navActive && follow) {
        const cam = {center: [lng, lat], duration: 800};
        if (!centeredOnce) {
          cam.zoom = Math.max(map.getZoom(), 16);
          centeredOnce = true;
        }
        if (courseUpNow()) {
          cam.bearing = navBearing;
          cam.pitch = NAV_PITCH;
          cam.offset = navOffset();
        } else if (navMode === 'north') {
          cam.bearing = 0;
          cam.pitch = 0;
        }
        map.easeTo(cam);
      }
      relayoutBubbles();
    } catch (e) { post({type: 'err', where: 'setCpo', msg: String(e)}); }
  };

  window.setPrincipal = function(payload) {
    try {
      const {lat, lng} = payload || {};
      if (lat == null || lng == null) {
        if (principalMk) { principalMk.remove(); principalMk = null; }
        anchors.principal = null;
        return;
      }
      if (!validLL(lng, lat)) return; // MG-12 — keep the last good marker
      if (!principalMk) {
        principalMk = makeMk(
          '<div class="mk principal"><div class="core"></div><div class="lbl">Principal</div></div>',
          [lng, lat]
        );
        anchors.principal = [lng, lat];
      } else {
        glideMk(principalMk, 'principal', [lng, lat], 'principal');
      }
      relayoutBubbles();
    } catch (e) { post({type: 'err', where: 'setPrincipal', msg: String(e)}); }
  };

  // Track Up (default during navigation) vs North Up. Selecting either also
  // re-arms follow — choosing an orientation is an explicit request to have
  // the camera driven again, so it must clear a stale manual-pan state.
  window.setNavCamera = function(payload) {
    try {
      navMode = (payload && payload.mode) === 'north' ? 'north' : 'course';
      follow = true;
      const pill = document.getElementById('recenter');
      if (pill) pill.style.display = 'none';
      const c = anchors.cpo;
      if (c) {
        const up = navMode === 'course' && haveBearing;
        map.easeTo({
          center: c,
          bearing: up ? navBearing : 0,
          pitch: up ? NAV_PITCH : 0,
          offset: up ? navOffset() : [0, 0],
          duration: 600,
        });
        centeredOnce = true;
      }
      paintNavPuck();
      post({type: 'navcam', mode: navMode});
    } catch (e) { post({type: 'err', where: 'setNavCamera', msg: String(e)}); }
  };

  // ── Bubbles & system events ─────────────────────────────

  // Per-anchor stack: max 2 visible, rest collapse into +N chip.
  const bubbleHost = document.getElementById('bubbles');
  const chipHost   = document.getElementById('chips');
  const stacks = { cpo: [], principal: [] };
  // System bubbles are anchored to lng/lat (waypoints), not markers.
  const systemBubbles = [];
  // B-406 — hard ceiling on concurrently drawn system cards. Two is what the
  // map band above the dock can hold without covering the route.
  const MAX_SYS_VISIBLE = 2;

  function avInitials(name) {
    if (!name) return 'OP';
    const parts = String(name).split(/\\s+/).filter(Boolean);
    return ((parts[0]?.[0] || 'O') + (parts[1]?.[0] || '')).toUpperCase();
  }

  function nodeForBubble(b) {
    const el = document.createElement('div');
    el.className = 'bub' + (b.kind === 'sos' ? ' sos' : '');
    el.dataset.id = b.id;
    el.innerHTML =
      '<div class="av">' + (b.kind === 'sos' ? '!' : avInitials(b.sender)) + '</div>' +
      '<div class="meta">' +
        '<div class="name"></div>' +
        '<div class="preview"></div>' +
      '</div>';
    el.querySelector('.name').textContent = b.sender || 'OPS';
    el.querySelector('.preview').textContent = b.preview || '';
    el.addEventListener('click', () => post({type: 'bubble.tap', id: b.id, anchor: b.anchor}));
    return el;
  }

  function nodeForSystem(b) {
    const el = document.createElement('div');
    el.className = 'bub sys';
    el.dataset.id = b.id;
    el.innerHTML =
      '<div class="av"><svg width="9" height="9" viewBox="0 0 10 10" fill="none">' +
        '<path d="M5 1 L5 5 M5 7 L5 7.1" stroke="#04101F" stroke-width="1.6" stroke-linecap="round"/>' +
      '</svg></div>' +
      '<div class="meta">' +
        '<div class="name"></div>' +
        '<div class="preview"></div>' +
      '</div>';
    el.querySelector('.name').textContent = 'System · ' + (b.label || 'Event');
    el.querySelector('.preview').textContent = b.preview || '';
    el.addEventListener('click', () => post({type: 'bubble.tap', id: b.id, anchor: 'system'}));
    return el;
  }

  function chipFor(anchor, count) {
    const el = document.createElement('div');
    el.className = 'chip';
    el.dataset.anchor = anchor;
    el.textContent = '+' + count;
    el.addEventListener('click', () => post({type: 'chip.tap', anchor: anchor}));
    return el;
  }

  // B-406 — screen-space de-collision.
  // A .bub renders at translate(-50%, calc(-100% - BUB_LIFT)) from its anchor,
  // so two bubbles whose anchors project to the same pixel land EXACTLY on top
  // of one another. System cards are anchored to WAYPOINT coordinates, which
  // routinely coincide (same pickup, same corner), and nothing separated them:
  // 3 concurrent events rendered as one unreadable pile over the driver's
  // route. Marker bubbles claim their space first (they own their anchor);
  // system cards then hunt upward for the first free slot, and give up rather
  // than intrude on the turn-by-turn banner.
  const BUB_LIFT      = 32;   // MUST match the .bub transform
  const BEHIND_LIFT   = 14;   // MUST match .bub.behind
  const SYS_GAP       = 8;
  // Top of the map that the RN maneuver banner covers. The WebView cannot see
  // that overlay, so the screen MEASURES it and pushes the value in via
  // window.setSysTopGuard (same contract as --recenter-bottom for the dock).
  // The literal is only the pre-measure fallback, never the steady state: it
  // was calibrated to the old 64pt banner and is far too small now that the
  // card is ~115-140 tall and insets.top adds 24-59 on top.
  let sysTopGuard = 156;

  function rectAt(el, cx, baseY) {
    const w = el.offsetWidth || 0;
    const h = el.offsetHeight || 0;
    return {l: cx - w / 2, r: cx + w / 2, t: baseY - h, b: baseY, h: h};
  }
  function overlaps(a, b) {
    return !(a.r <= b.l || a.l >= b.r || a.b <= b.t || a.t >= b.b);
  }

  function relayoutBubbles() {
    // Boxes already claimed this pass — system cards route around them.
    const claimed = [];
    // CPO + Principal stacks
    Object.keys(stacks).forEach(anchorKey => {
      const stack = stacks[anchorKey];
      const ll = anchors[anchorKey];
      stack.forEach((b, idx) => {
        if (!b.el) return;
        if (!ll) { b.el.style.display = 'none'; return; }
        b.el.style.display = '';
        const p = map.project(ll);
        b.el.style.left = p.x + 'px';
        b.el.style.top  = p.y + 'px';
        if (idx === 1) b.el.classList.add('behind');
        else b.el.classList.remove('behind');
        claimed.push(rectAt(b.el, p.x, p.y - BUB_LIFT - (idx === 1 ? BEHIND_LIFT : 0)));
      });
      // Place +N chip at the marker if we have collapsed messages.
      const existingChip = chipHost.querySelector('[data-anchor="' + anchorKey + '"]');
      const collapsedCount = stack.length > 2 ? stack.length - 2 : 0;
      if (collapsedCount > 0 && ll) {
        const p = map.project(ll);
        if (!existingChip) {
          const chip = chipFor(anchorKey, collapsedCount);
          chip.style.left = p.x + 'px';
          chip.style.top  = (p.y + 18) + 'px';
          chipHost.appendChild(chip);
        } else {
          existingChip.textContent = '+' + collapsedCount;
          existingChip.style.left = p.x + 'px';
          existingChip.style.top  = (p.y + 18) + 'px';
        }
      } else if (existingChip) {
        existingChip.remove();
      }
    });
    // System bubbles — anchored by lng/lat, de-collided in screen space.
    systemBubbles.forEach(b => {
      if (!b.el) return;
      // Un-hide BEFORE measuring — the marker branch above does the same.
      // A node still display:none from the PREVIOUS pass measures 0x0, which
      // collapses the whole solve: the walk steps by 8px instead of a card,
      // a zero-area rect overlaps nothing, the top guard passes, and the card
      // is redrawn at its raw anchor — the exact pile-up this code prevents,
      // flickering once per frame because the next pass hides it again.
      b.el.style.display = '';
      const p = map.project([b.lng, b.lat]);
      b.el.style.left = p.x + 'px';
      // Walk upward in whole-card steps until this box hits nothing. Bounded:
      // a card that cannot fit below the banner is hidden instead of drawn
      // over the driver's next maneuver.
      let dy = 0;
      let box = rectAt(b.el, p.x, p.y - BUB_LIFT);
      // An unmeasurable card must not be treated as one that fits — a
      // zero-area box collides with nothing and would land on the anchor.
      if (box.h <= 0 || box.r <= box.l) { b.el.style.display = 'none'; return; }
      let guard = 0;
      while (guard++ < 12 && claimed.some(c => overlaps(box, c))) {
        dy += box.h + SYS_GAP;
        box = rectAt(b.el, p.x, p.y - BUB_LIFT - dy);
      }
      if (box.t < sysTopGuard || claimed.some(c => overlaps(box, c))) {
        b.el.style.display = 'none';
        return;
      }
      b.el.style.display = '';
      b.el.style.top = (p.y - dy) + 'px';
      claimed.push(box);
    });
  }

  function unmount(b, host) {
    if (!b || !b.el) return;
    b.el.classList.add('out');
    setTimeout(() => { if (b.el && b.el.parentNode === host) host.removeChild(b.el); }, 200);
  }

  window.pushBubble = function(payload) {
    try {
      const {id, kind, sender, preview, anchor, ttl} = payload || {};
      const anchorKey = anchor === 'principal' ? 'principal' : 'cpo';
      const stack = stacks[anchorKey];
      // De-dupe by id
      if (stack.some(b => b.id === id)) return;
      const b = {id, kind: kind || 'msg', sender, preview, anchor: anchorKey};
      b.el = nodeForBubble(b);
      bubbleHost.appendChild(b.el);
      stack.unshift(b);
      // Visible window = first two; collapse rest.
      stack.forEach((entry, idx) => {
        if (idx >= 2 && entry.el) {
          entry.el.remove();
          entry.el = null;
        }
      });
      relayoutBubbles();
      // Auto-unmount after TTL (SOS holds indefinitely).
      const holdMs = (kind === 'sos') ? null : (ttl != null ? ttl : 6000);
      if (holdMs != null) {
        setTimeout(() => {
          const idx = stack.findIndex(x => x.id === id);
          if (idx === -1) return;
          const entry = stack.splice(idx, 1)[0];
          unmount(entry, bubbleHost);
          // Promote next collapsed bubble into the visible window.
          stack.forEach((e2, i2) => {
            if (i2 < 2 && !e2.el) {
              e2.el = nodeForBubble(e2);
              bubbleHost.appendChild(e2.el);
            }
          });
          relayoutBubbles();
        }, holdMs);
      }
    } catch (e) { post({type: 'err', where: 'pushBubble', msg: String(e)}); }
  };

  window.pushSystem = function(payload) {
    try {
      const {id, label, preview, lat, lng, ttl} = payload || {};
      if (lat == null || lng == null) return;
      if (systemBubbles.some(b => b.id === id)) return;
      const b = {id, label, preview, lat, lng};
      b.el = nodeForSystem(b);
      bubbleHost.appendChild(b.el);
      // B-406 — newest first, and CAPPED. Unbounded system cards were the
      // other half of the pile-up: every waypoint event mounted its own card
      // and none of them ever yielded. Older cards drop their node (they are
      // transient and TTL'd anyway); the entry stays so its timer still fires.
      systemBubbles.unshift(b);
      systemBubbles.forEach((entry, idx) => {
        if (idx >= MAX_SYS_VISIBLE && entry.el) {
          entry.el.remove();
          entry.el = null;
        }
      });
      relayoutBubbles();
      const holdMs = ttl != null ? ttl : 8000;
      setTimeout(() => {
        const idx = systemBubbles.findIndex(x => x.id === id);
        if (idx === -1) return;
        const entry = systemBubbles.splice(idx, 1)[0];
        unmount(entry, bubbleHost);
        // Promote a capped-out event into the freed slot (mirrors the marker
        // stacks) so a queued card is never silently lost.
        systemBubbles.forEach((e2, i2) => {
          if (i2 < MAX_SYS_VISIBLE && !e2.el) {
            e2.el = nodeForSystem(e2);
            bubbleHost.appendChild(e2.el);
          }
        });
        relayoutBubbles();
      }, holdMs);
    } catch (e) { post({type: 'err', where: 'pushSystem', msg: String(e)}); }
  };

  // B-406 — RN reports how much of the map's top the maneuver banner covers
  // (insets.top + its measured height). Cards never solve into that band.
  window.setSysTopGuard = function(px) {
    try {
      const v = Number(px);
      if (!isFinite(v) || v < 0) return;
      sysTopGuard = v;
      relayoutBubbles();
    } catch (e) { post({type: 'err', where: 'setSysTopGuard', msg: String(e)}); }
  };

  window.setStyle = function(name) {
    try {
      const url = STYLES[name] || STYLES.dark;
      currentStyleName = STYLES[name] ? name : 'dark';
      // A full style swap drops user-added sources/layers — the persistent
      // styledata handler above re-attaches the route layer + last geometry.
      map.setStyle(url);
    } catch (e) { post({type: 'err', where: 'setStyle', msg: String(e)}); }
  };

  // Re-anchor bubbles every animation frame so they ride camera moves
  // without lag (pan, pinch, rotate, fitBounds).
  map.on('move', relayoutBubbles);
  map.on('zoom', relayoutBubbles);
  map.on('rotate', relayoutBubbles);
  map.on('pitch', relayoutBubbles);
  // The cone is counter-rotated against the map bearing, so it has to be
  // repainted throughout a rotation, not only when a new fix lands.
  map.on('rotate', paintNavPuck);
  // User grabbed the map → stop auto-following so we don't fight their pan.
  // The ⌖ Follow pill re-enables auto-follow (mapbox audit M-2 — follow used
  // to be one-way: a single accidental pan disabled it for the whole mission).
  const recenterEl = document.getElementById('recenter');
  function breakFollow() {
    follow = false;
    recenterEl.style.display = 'block';
  }
  recenterEl.addEventListener('click', () => {
    follow = true;
    recenterEl.style.display = 'none';
    if (anchors.cpo) {
      // Restore the FULL navigation camera, not just the centre. A recenter
      // that dropped the driver back into a flat north-up view mid-turn is
      // exactly the unreliability being reported.
      const up = courseUpNow();
      map.easeTo({
        center: anchors.cpo,
        zoom: Math.max(map.getZoom(), 15),
        bearing: up ? navBearing : 0,
        pitch: up ? NAV_PITCH : 0,
        offset: up ? navOffset() : [0, 0],
        duration: 700,
      });
      centeredOnce = true;
    }
  });
  map.on('dragstart', breakFollow);
  map.on('zoomstart', (e) => { if (e.originalEvent) breakFollow(); });
  // A two-finger rotate or pitch is manual control too. Our own easeTo fires
  // these events as well, and only a real gesture carries originalEvent.
  map.on('rotatestart', (e) => { if (e.originalEvent) breakFollow(); });
  map.on('pitchstart', (e) => { if (e.originalEvent) breakFollow(); });
</script>
</body>
</html>`;
}
