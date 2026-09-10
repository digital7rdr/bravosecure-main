/**
 * Inline Mapbox GL JS HTML for the Bravo Map WebView.
 *
 * Originally the design-handoff Leaflet page with a flat TopoJSON world fill —
 * which rendered visibly distorted/low-fidelity on device. Rebuilt on Mapbox
 * GL (dark style, globe projection + atmosphere) with the SAME bridge
 * contract, so the RN side is unchanged in shape:
 *   in : `window.updateThreats([{lat,lng,severity,count,label}])`
 *   out: postMessage 'ready' | 'markerPress' | 'error'
 * The intel HUD chrome (grid overlay, corner readout, glass zoom panel,
 * radar-pulse threat markers) is kept — it now sits over real tiles.
 *
 * Token injected at bundle time from EXPO_PUBLIC_MAPBOX_TOKEN (mapToken).
 */

export function buildBravoMapHtml(mapboxToken: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no, viewport-fit=cover"/>
<title>Bravo Map</title>
<link href="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.css" rel="stylesheet"/>
<style>
  html, body { margin: 0; padding: 0; background: #06080C; color: #F2F4F8;
    font-family: ui-monospace, Menlo, Consolas, "Roboto Mono", monospace;
    -webkit-font-smoothing: antialiased; overflow: hidden; height: 100%; }
  *, *::before, *::after { box-sizing: border-box; }

  .map-wrap { position: absolute; inset: 0; overflow: hidden; background: #06080C; }
  #map { position:absolute; inset:0; background: #06080C; }
  .map-wrap::before { content:''; position:absolute; top:0; left:0; right:0; height:40px; z-index:5;
    background: linear-gradient(to bottom, rgba(7,9,13,0.9), transparent); pointer-events:none; }
  .map-wrap::after  { content:''; position:absolute; bottom:0; left:0; right:0; height:60px; z-index:5;
    background: linear-gradient(to top, rgba(7,9,13,1), transparent); pointer-events:none; }

  .mapboxgl-ctrl-attrib { background: rgba(7,12,22,0.6) !important; }
  .mapboxgl-ctrl-attrib a { color: rgba(180,188,204,0.6) !important; }

  /* crosshair grid overlay
     B-656 - mix-blend-mode REMOVED. A viewport-sized blend element over a
     WebGL canvas forces the compositor to keep the canvas as a readable layer
     and blend it every frame, defeating the fast path where the GL canvas is
     composited directly. This was the single largest per-frame cost in the
     page: unlike the marker blurs it is FULL SCREEN.
     The alphas are bumped 0.04 -> 0.05 to compensate for the lost screen-blend
     brightening; over a near-black basemap the two are visually equivalent. */
  .crosshair { position:absolute; inset:0; pointer-events:none; z-index:4;
    background-image:
      linear-gradient(rgba(91,141,239,0.05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(91,141,239,0.05) 1px, transparent 1px);
    background-size: 40px 40px; }

  /* HUD corner — live grid readout of the map centre */
  /* B-656 - backdrop-filter removed; opaque background instead. Each blur is a
     backdrop READBACK of the region beneath it, re-sampled whenever the map
     moves. Over a near-black basemap a solid panel is visually equivalent. */
  .hud-corner { position:absolute; top:10px; left:10px; z-index:30;
    font-size:8px; letter-spacing:1px; color:rgba(180,188,204,0.5);
    text-transform:uppercase; padding:6px 8px; border-radius:6px;
    background: rgba(12,17,26,0.92); border:1px solid rgba(255,255,255,0.06); }
  .hud-corner .h { color:#7FA8FF; font-weight:700; letter-spacing:1.2px; }

  /* Zoom panel */
  .zoom-panel { position:absolute; top:10px; right:10px; z-index:30;
    display:flex; flex-direction:column; gap:8px; }
  /* B-656 - backdrop-filter removed (see .hud-corner). These three sit at the
     top-right over the globe, so their blur regions were re-sampled on every
     pan/zoom frame. The glass look is carried by the translucent fill, the
     inset highlight and the drop shadow, which are all free. */
  .zoom-btn { width:40px; height:40px; border-radius:12px; cursor:pointer;
    background: rgba(15,20,30,0.94); border:1px solid rgba(255,255,255,0.09);
    display:flex; align-items:center; justify-content:center; color:#F2F4F8;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4), inset 0 1px 1px rgba(255,255,255,0.06);
    transition: transform 0.15s ease, background 0.15s ease; user-select:none;
    -webkit-tap-highlight-color: transparent; }
  .zoom-btn:active { transform: scale(0.93); background: rgba(91,141,239,0.15); }
  .zoom-btn svg { width:16px; height:16px; }

  /* Threat marker — radar pulse + dot + badge + label + sub */
  .threat { position:relative; width:0; height:0; }
  .threat .dot   { position:absolute; left:-6px; top:-6px; width:12px; height:12px; border-radius:50%;
                   background: var(--c); box-shadow: 0 0 12px var(--c); }
  .threat .ring  { position:absolute; left:-19px; top:-19px; width:38px; height:38px; border-radius:50%;
                   border:1.5px solid var(--c); opacity:0.7; }
  /*
    B-656 - the radar ring no longer animates on EVERY marker.

    It is now opt-in via .pulse, which renderThreats applies to CRITICAL and
    HIGH markers only. Previously every marker ran an INFINITE animation, so
    with the camera at rest they were the only thing still producing compositor
    frames - the map could never go idle, and the cost grew with news volume.

    This is also better information design: the pulse now MEANS something
    (severity) instead of being uniform decoration on every bubble.

    will-change keeps the animating ring on its own compositor layer so it does
    not repaint its parent. Only ever applied to the few that animate.
  */
  .threat .ring2 { position:absolute; left:-28px; top:-28px; width:56px; height:56px; border-radius:50%;
                   border:1px solid var(--c); opacity:0.3; }
  .threat .ring2.pulse { animation: radar 2.4s ease-out infinite; will-change: transform, opacity; }
  /* B-656 - backdrop-filter removed. One backdrop READBACK per marker per
     frame, and the region it sampled contained the animating ring above it, so
     it was forced to re-sample continuously. Opaque fill is equivalent here:
     the disc is 24px over a dark basemap. */
  .threat .badge { position:absolute; left:-12px; top:-12px; width:24px; height:24px; border-radius:50%;
                   background: rgba(10,16,32,0.94); border:1.5px solid var(--c);
                   display:flex; align-items:center; justify-content:center;
                   font-size:10px; font-weight:800; color:#fff; }
  .threat .label { position:absolute; left:18px; top:-8px; white-space:nowrap;
                   font-size:9px; font-weight:700; letter-spacing:1.2px;
                   color:#E4EAF7; text-transform:uppercase;
                   text-shadow: 0 1px 3px rgba(0,0,0,0.8); }
  .threat .sub   { position:absolute; left:18px; top:4px; white-space:nowrap;
                   font-size:8px; color: var(--c); letter-spacing:0.8px;
                   text-transform:uppercase; text-shadow: 0 1px 3px rgba(0,0,0,0.8); }
  @keyframes radar {
    0%   { transform: scale(0.5); opacity:0.7; }
    100% { transform: scale(1.6); opacity:0; }
  }
  /*
    B-656 - IDLE MODE. CRITICAL/HIGH markers run an INFINITE .pulse animation,
    and with the camera at rest that animation is the ONLY thing still producing
    compositor frames in this WebView. The host keeps this page MOUNTED at
    opacity:0 when the user is on another tab (so the basemap is not refetched
    on every tab switch), and opacity on the RN parent does NOT change
    document.visibilityState - so Chromium never throttles us and the rings keep
    burning compositor time behind a surface nobody can see.

    The body.idle class is set from RN via window.setMapActive(false). It is
    unobservable by construction: it only ever applies while the surface is
    fully transparent.

    NOTE this pauses the animation only. The backdrop-filter blurs and the
    crosshair blend are untouched - removing those is a VISIBLE change and is
    held pending an on-device measurement (docs/audits/MAPBOX_AUDIT.md flagged
    them in July and they have never been measured).
  */
  body.idle .threat .ring2 { animation-play-state: paused; }
</style>
</head>
<body>
  <div class="map-wrap">
    <div id="map"></div>
    <div class="crosshair"></div>
    <div class="hud-corner">
      <div class="h" id="hudGrid">GRID 22°N</div>
      <div>MERCATOR · WGS84</div>
    </div>
    <div class="zoom-panel">
      <div class="zoom-btn" id="zoomIn" aria-label="Zoom in">
        <svg viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </div>
      <div class="zoom-btn" id="zoomOut" aria-label="Zoom out">
        <svg viewBox="0 0 16 16" fill="none"><path d="M3 8h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </div>
      <div class="zoom-btn" id="zoomGlobe" aria-label="Reset view">
        <svg viewBox="0 0 20 20" fill="none">
          <circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.4"/>
          <path d="M10 2.5v15M2.5 10h15M10 2.5c-2.5 2-4 4.5-4 7.5s1.5 5.5 4 7.5c2.5-2 4-4.5 4-7.5s-1.5-5.5-4-7.5Z" stroke="currentColor" stroke-width="1.2" fill="none"/>
        </svg>
      </div>
    </div>
  </div>

<script src="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.js"></script>
<script>
(function () {
  var post = function (type, payload) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify({type: type, payload: payload}));
      }
    } catch (e) {}
  };

  var HOME = { center: [18, 22], zoom: 1.4 };

  if (typeof mapboxgl.supported === 'function' && !mapboxgl.supported()) {
    post('error', {msg: 'gl-unsupported'});
  }
  mapboxgl.accessToken = ${JSON.stringify(mapboxToken)};
  var map;
  try {
    map = new mapboxgl.Map({
      container: 'map',
      style: 'mapbox://styles/mapbox/dark-v11',
      projection: 'globe',
      center: HOME.center,
      zoom: HOME.zoom,
      minZoom: 1,
      maxZoom: 10,
      attributionControl: false,
      antialias: true,
    });
  } catch (e) {
    post('error', {msg: String(e)});
    throw e;
  }
  map.addControl(new mapboxgl.AttributionControl({compact: true}), 'bottom-right');
  // B-656 - flips true on 'load'; gates the error bridge below.
  var loaded = false;
  /*
    B-656 - only PRE-LOAD errors cross the bridge.

    Mapbox GL fires 'error' for recoverable tile 404s too, so on a flaky
    connection this posted one bridge message per failed tile - each a native
    hop plus a JSON.parse on the RN side - for the entire session, during
    exactly the pan that was already struggling. The RN handler only escalates
    pre-load errors anyway (a post-ready escalation would reboot a healthy map
    whenever a single tile failed), so everything after 'load' was parsed and
    discarded.

    The loaded flag is set by the 'load' handler below.
  */
  map.on('error', function (e) {
    if (loaded) { return; }
    post('error', {msg: (e && e.error && e.error.message) || 'map-error'});
  });

  // Atmosphere for the globe view — vibrant cobalt: a glowing blue horizon
  // rim + blue upper atmosphere over deep space, and the ocean tinted a
  // saturated navy so the planet reads blue instead of near-black.
  map.on('style.load', function () {
    try {
      map.setFog({
        'color': 'rgba(47,111,224,0.45)',
        'high-color': '#2F6FE0',
        'horizon-blend': 0.14,
        'space-color': '#04070E',
        'star-intensity': 0.3
      });
    } catch (e) {}
    try { map.setPaintProperty('water', 'fill-color', '#0E2A55'); } catch (e) {}
    try { map.setPaintProperty('land', 'background-color', '#0A1220'); } catch (e) {}
  });

  // The WebView can mount inside a hidden tab (0-size canvas → blank tiles);
  // force resizes as layout settles and whenever the container changes.
  function fixSize(){ try { map.resize(); } catch(e){} }
  setTimeout(fixSize, 120); setTimeout(fixSize, 500); setTimeout(fixSize, 1200);
  window.addEventListener('resize', fixSize);

  // Live HUD readout: centre latitude band, like a real ops console.
  function updateHud(){
    try {
      var c = map.getCenter();
      var lat = Math.round(Math.abs(c.lat));
      var ns = c.lat >= 0 ? 'N' : 'S';
      document.getElementById('hudGrid').textContent = 'GRID ' + lat + '\\u00B0' + ns;
    } catch(e){}
  }
  map.on('moveend', updateHud);

  // ── Threat markers, replaced whenever the RN side posts new data ──
  // B-656 - the old markers array + clearMarkers() are gone; renderThreats
  // now keys markers by identity in markerByKey and reconciles.

  // Why: label/count come from external news-feed data — escape before innerHTML.
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function severityColor(sev) {
    return sev === 'CRITICAL' ? '#FF5D5D'
         : sev === 'HIGH'     ? '#F5B544'
         : sev === 'MEDIUM'   ? '#7FA8FF'
         :                      '#5B8DEF';
  }

  function subLabel(sev, count) {
    if (sev === 'CRITICAL' || sev === 'HIGH') return sev;
    return count + (count === 1 ? ' SIGNAL' : ' SIGNALS');
  }

  /*
    B-656 - RECONCILE, do not rebuild.

    This used to clearMarkers() and re-create every marker's DOM via innerHTML
    on every push - and the host pushes at least twice per feed load (the feed
    clears mapExtras, then fills it), plus once per filter-chip tap. At ~30
    markers x 7 nodes that was ~200 node creations and 30 mapboxgl.Marker
    constructions per load, each Marker registering its own map 'move' listener.

    Now: key by identity, update survivors in place, remove only the departed,
    create only the genuinely new. An unchanged push is a no-op.
  */
  var markerByKey = Object.create(null);

  function threatKey(t) {
    return t.lat + '_' + t.lng + '_' + (t.label || '');
  }

  function buildThreatEl(t, color, label, sub, count, pulse) {
    var el = document.createElement('div');
    el.className = 'threat';
    el.style.setProperty('--c', color);
    el.innerHTML =
      '<div class="ring2' + (pulse ? ' pulse' : '') + '"></div>' +
      '<div class="ring"></div>' +
      '<div class="dot"></div>' +
      '<div class="badge">' + esc(count) + '</div>' +
      (label ? '<div class="label">' + label + '</div>' : '') +
      '<div class="sub">' + sub + '</div>';
    el.addEventListener('click', function () {
      post('markerPress', { lat: t.lat, lng: t.lng, label: t.label });
    });
    return el;
  }

  function renderThreats(list) {
    var next = Object.create(null);
    (list || []).forEach(function (t) {
      if (typeof t.lat !== 'number' || typeof t.lng !== 'number') return;
      var key   = threatKey(t);
      if (next[key]) return;                      // duplicate in one payload
      var color = severityColor(t.severity);
      var label = esc((t.label || '').toString().toUpperCase());
      var count = Number(t.count) || 1;
      var sub   = esc(subLabel(t.severity, count));
      // Only CRITICAL/HIGH pulse - see the .ring2 note in the stylesheet.
      var pulse = t.severity === 'CRITICAL' || t.severity === 'HIGH';

      var existing = markerByKey[key];
      if (existing) {
        // Survivor: patch only what can actually differ. Touching nothing when
        // nothing changed is the whole point - a rewrite would restart the
        // pulse animation from zero on every feed load.
        var el = existing.el;
        if (existing.color !== color) { el.style.setProperty('--c', color); existing.color = color; }
        if (existing.count !== count) {
          var badge = el.querySelector('.badge');
          if (badge) { badge.textContent = String(count); }
          existing.count = count;
        }
        if (existing.sub !== sub) {
          var subEl = el.querySelector('.sub');
          if (subEl) { subEl.innerHTML = sub; }
          existing.sub = sub;
        }
        if (existing.pulse !== pulse) {
          var ring = el.querySelector('.ring2');
          if (ring) { ring.classList.toggle('pulse', pulse); }
          existing.pulse = pulse;
        }
        next[key] = existing;
        return;
      }

      var created = buildThreatEl(t, color, label, sub, count, pulse);
      next[key] = {
        marker: new mapboxgl.Marker({element: created}).setLngLat([t.lng, t.lat]).addTo(map),
        el: created, color: color, count: count, sub: sub, pulse: pulse,
      };
    });

    // Remove only what actually left.
    Object.keys(markerByKey).forEach(function (key) {
      if (!next[key]) { markerByKey[key].marker.remove(); }
    });
    markerByKey = next;
  }

  // Expose a setter the RN side calls via injectJavaScript
  window.updateThreats = renderThreats;

  /*
    B-656 - the host calls this when the map tab is hidden/shown. Pausing the
    per-marker radar animation removes the only continuous frame source in this
    page while the camera is at rest, so a hidden map stops costing compositor
    time entirely. Guarded and idempotent: RN injects it on every tab change.
  */
  window.setMapActive = function (active) {
    try {
      document.body.classList.toggle('idle', !active);
      // Also stop any in-flight camera easing so a hidden map is fully at rest.
      if (!active && map && map.stop) { map.stop(); }
    } catch (e) { /* never let a cosmetic toggle break the map */ }
  };

  // Zoom controls — GL native easing.
  document.getElementById('zoomIn').onclick   = function () { map.zoomIn({duration: 350}); };
  document.getElementById('zoomOut').onclick  = function () { map.zoomOut({duration: 350}); };
  document.getElementById('zoomGlobe').onclick = function () { map.flyTo({center: HOME.center, zoom: HOME.zoom, duration: 1100}); };

  // Prevent the native-style pinch page zoom from fighting GL's pinch
  document.addEventListener('gesturestart', function (e) {
    if (e.target.closest('#map')) e.preventDefault();
  }, { passive: false });

  map.on('load', function () { loaded = true; updateHud(); post('ready', {}); });
})();
</script>
</body>
</html>`;
}
