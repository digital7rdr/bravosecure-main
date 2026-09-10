/**
 * Inline Mapbox GL JS HTML for the Live-Operations route map.
 *
 * Renders a dark mapbox canvas with an origin → vehicle → dest polyline,
 * a pulsing vehicle marker, and an ETA pill. RN pushes updates via:
 *   window.setRoute({origin, vehicle, dest, etaLabel})
 *
 * A DARK | LIGHT | SAT segment (top-right) swaps the base style in place;
 * the route source/layers + last payloads are re-applied after each swap.
 * High-zoom 3D building extrusions give the vector styles street detail.
 *
 * Camera policy: fitBounds runs once per origin/dest pair (framed once),
 * then the camera is user-owned; a RECENTER pill re-frames on demand.
 * Markers are created once and moved via setLngLat — the vehicle dot
 * glides between fixes with a rAF lerp instead of teleporting.
 */

export function buildLiveRouteHtml(mapboxToken: string): string {
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
      linear-gradient(rgba(76,194,255,0.08) 1px, transparent 1px),
      linear-gradient(90deg, rgba(76,194,255,0.08) 1px, transparent 1px);
    background-size: 20px 20px; mix-blend-mode: screen; }
  body.light .grid, body.sat .grid { display: none; }
  body.light #map { background: #F4F5F7; }

  .styleseg { position: absolute; right: 10px; top: var(--top-guard, 10px); z-index: 20; display: flex;
    background: rgba(6,20,43,0.92); border: 1px solid #1C3B66; border-radius: 6px;
    overflow: hidden; -webkit-tap-highlight-color: transparent; user-select: none; }
  /* 44px minimum touch height — the segment was ~21dp, which is under the
     platform minimum and sat under the RN expand button besides. */
  .styleseg .seg { min-height: 44px; display: flex; align-items: center;
    padding: 0 12px; font-family: "JetBrains Mono", "SF Mono", monospace;
    font-size: 10px; font-weight: 700; letter-spacing: 1px; color: #6E85A8; cursor: pointer; }
  .styleseg .seg.on { background: #1E88FF; color: #fff; }

  /* Compact (collapsed) map: the box is only ~328x252, so the four-corner
     chrome that suits fullscreen swallows the route. Hide the secondary
     controls and keep route context — deck page 10. */
  body.compact .styleseg,
  body.compact .legend,
  body.compact .orient { display: none; }
  body.compact .etc { font-size: 9px; padding: 4px 8px; }

  .orient {
    position: absolute; right: 10px; bottom: 84px; z-index: 20;
    min-width: 44px; min-height: 44px; border-radius: 8px; cursor: pointer;
    background: rgba(6,20,43,0.92); border: 1px solid #4CC2FF;
    font-family: "JetBrains Mono", "SF Mono", monospace;
    font-size: 10px; font-weight: 700; color: #4CC2FF; letter-spacing: 1px;
    display: flex; align-items: center; justify-content: center;
    -webkit-tap-highlight-color: transparent; user-select: none;
  }

  .origin-dot, .dest-dot, .vehicle-dot { position: relative; width: 0; height: 0; }
  /* Deck page 18 — four markers that differ by SHAPE, not only colour, so the
     client can tell them apart at a glance and colour-blind users can too.
     Pick-up is a teardrop pin, drop-off a square flag, the officer a rotating
     arrow, the client a plain dot. */
  .origin-dot .pin {
    position: absolute; left: -8px; top: -8px; width: 16px; height: 16px;
    border-radius: 50% 50% 50% 2px; transform: rotate(-45deg);
    background: #FFC107;
    box-shadow: 0 0 0 3px rgba(255,193,7,0.25), 0 0 14px #FFC107;
  }
  .dest-dot .pin {
    position: absolute; left: -8px; top: -8px; width: 16px; height: 16px;
    border-radius: 3px; background: #00C853;
    box-shadow: 0 0 0 3px rgba(0,200,83,0.25), 0 0 14px #00C853;
  }
  .vehicle-dot .pin {
    position: absolute; left: -9px; top: -9px; width: 0; height: 0;
    border-left: 9px solid transparent; border-right: 9px solid transparent;
    border-bottom: 18px solid #1E88FF;
    transform-origin: 50% 70%;
    filter: drop-shadow(0 0 6px rgba(30,136,255,0.8));
  }
  .vehicle-dot .ring {
    position: absolute; left: -16px; top: -16px; width: 32px; height: 32px;
    border-radius: 50%; border: 1.5px solid #1E88FF;
    animation: pulse 1.8s infinite;
  }
  @keyframes pulse {
    0%   { transform: scale(0.7); opacity: 0.8; }
    100% { transform: scale(1.8); opacity: 0; }
  }
  /* B-214 — "you are here": the client's own live position, a distinct
     avatar circle so it's never mistaken for the CPO's vehicle dot. */
  .self-dot { position: relative; width: 0; height: 0; }
  .self-dot .pin {
    position: absolute; left: -9px; top: -9px; width: 18px; height: 18px;
    border-radius: 50%; background: #9B6BFF; border: 2px solid #FFFFFF;
    box-shadow: 0 0 0 3px rgba(155,107,255,0.28), 0 0 14px #9B6BFF;
  }
  .self-dot .ring {
    position: absolute; left: -17px; top: -17px; width: 34px; height: 34px;
    border-radius: 50%; border: 1.5px solid #9B6BFF;
    animation: pulse 1.8s infinite;
  }
  /* Colour alone did not tell the founder which dot was his and which was the
     officer ("cpo / moving / me" on screen 15). The client's dot now says so. */
  .self-dot .lbl {
    position: absolute; left: 50%; top: 12px; transform: translateX(-50%);
    font-family: "JetBrains Mono", "SF Mono", monospace;
    font-size: 9px; font-weight: 700; color: #D9C6FF;
    background: rgba(6,20,43,0.88); padding: 1px 5px; border-radius: 4px;
    white-space: nowrap; letter-spacing: 0.6px;
  }

  /* Persistent marker key — the deck asks that the client and the Bravo Control
     System read the same map the same way. */
  .legend {
    position: absolute; left: 10px; top: var(--top-guard, 10px); z-index: 20;
    background: rgba(6,20,43,0.88); border: 1px solid #1C3B66;
    border-radius: 6px; padding: 5px 7px;
    display: flex; flex-direction: column; gap: 3px;
    font-family: "JetBrains Mono", "SF Mono", monospace;
    font-size: 8.5px; font-weight: 600; color: #B8C7E0; letter-spacing: 0.4px;
    pointer-events: none;
  }
  .legend .r { display: flex; align-items: center; gap: 5px; white-space: nowrap; }
  .legend .s { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 8px; }

  /* A stored UAE address is ~60 characters; with nowrap and no cap these pins
     drew black bars right across the route. RN now sends a short place name,
     and this cap is the backstop so no future caller can stretch one again. */
  .tag {
    position: absolute; transform: translate(-50%, calc(-100% - 14px));
    padding: 3px 7px; border-radius: 4px;
    background: rgba(6,20,43,0.92); border: 1px solid #1C3B66;
    font-family: "JetBrains Mono", "SF Mono", monospace;
    font-size: 9px; font-weight: 600; color: #FFFFFF;
    letter-spacing: 0.3px; white-space: nowrap;
    max-width: 42vw; overflow: hidden; text-overflow: ellipsis;
  }

  .etc {
    position: absolute; left: 10px; bottom: 10px; z-index: 20;
    padding: 5px 10px; border-radius: 6px;
    background: rgba(6,20,43,0.92); border: 1px solid #00C853;
    font-family: "JetBrains Mono", "SF Mono", monospace;
    font-size: 10px; font-weight: 700; color: #00C853;
    letter-spacing: 1px; text-transform: uppercase;
    display: flex; align-items: center; gap: 6px;
  }
  .etc .d { width: 8px; height: 8px; border-radius: 50%; background: #00C853; }

  .recenter {
    position: absolute; right: 10px; bottom: 44px; z-index: 20;
    padding: 5px 10px; border-radius: 6px; cursor: pointer;
    background: rgba(6,20,43,0.92); border: 1px solid #4CC2FF;
    font-family: "JetBrains Mono", "SF Mono", monospace;
    font-size: 10px; font-weight: 700; color: #4CC2FF;
    letter-spacing: 1px; text-transform: uppercase;
    display: flex; align-items: center; gap: 6px;
    -webkit-tap-highlight-color: transparent; user-select: none;
  }
</style>
</head>
<body>
<div id="map"></div>
<div class="grid"></div>
<div class="legend" id="legend">
  <div class="r"><span class="s" style="background:#9B6BFF"></span>You</div>
  <div class="r"><span class="s" style="background:#1E88FF"></span>Your officer</div>
  <div class="r"><span class="s" style="background:#FFC107"></span>Pick-up</div>
  <div class="r"><span class="s" style="background:#00C853"></span>Drop-off</div>
</div>
<div class="styleseg" id="styleseg">
  <div class="seg on" data-style="dark">DARK</div>
  <div class="seg" data-style="light">LIGHT</div>
  <div class="seg" data-style="sat">SAT</div>
</div>
<div class="etc" id="etc"><div class="d"></div><span id="etaText">ETA —</span></div>
<div class="etc" id="prog" style="left:auto; right:10px; border-color:#1E88FF; color:#1E88FF;"><span id="progText"></span></div>
<div class="orient" id="orient">N</div>
<div class="recenter" id="recenter">⌖ Recenter</div>

<script src="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.js"></script>
<script>
  mapboxgl.accessToken = ${JSON.stringify(mapboxToken)};


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

  function post(type, payload) {
    try {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({type: type}, payload || {})));
      }
    } catch (_) {}
  }

  const STYLES = {
    dark:  'mapbox://styles/mapbox/dark-v11',
    light: 'mapbox://styles/mapbox/light-v11',
    sat:   'mapbox://styles/mapbox/satellite-streets-v12',
  };
  let currentStyle = 'dark';

  // B-89 MG-12 — coordinate sanity for anything that moves a marker or a
  // line: non-finite / out-of-range / (0,0) "null island" payloads must
  // never teleport the map.
  function validLL(lng, lat) {
    return isFinite(lng) && isFinite(lat)
      && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      && !(lng === 0 && lat === 0);
  }

  // B-89 P3 — a WebGL context-creation failure used to throw here BEFORE
  // any postMessage existed, leaving only the slow 15 s watchdog. Fail
  // fast and loud instead.
  let map;
  try {
    map = new mapboxgl.Map({
      container: 'map',
      style: STYLES.dark,
      center: [55.2708, 25.2048],
      zoom: 11.5,
      minZoom: 6, maxZoom: 18,
      attributionControl: false,
      interactive: true,
      antialias: true,
    });
  } catch (e) {
    post('err', {where: 'init', msg: String(e)});
    throw e;
  }
  map.addControl(new mapboxgl.AttributionControl({compact: true}), 'bottom-right');

  // High-zoom detail: extruded 3D buildings under the first label layer
  // (vector styles only). Idempotent — retried from styledata while a
  // freshly-swapped style streams in.
  function addDetailLayers() {
    try {
      if (currentStyle === 'sat') return;
      if (map.getLayer('bravo-3d-buildings')) return;
      var layers = (map.getStyle().layers) || [];
      var labelId;
      for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        if (l.type === 'symbol' && l.layout && l.layout['text-field']) { labelId = l.id; break; }
      }
      map.addLayer({
        id: 'bravo-3d-buildings', source: 'composite', 'source-layer': 'building',
        filter: ['==', ['get', 'extrude'], 'true'], type: 'fill-extrusion', minzoom: 14.5,
        paint: {
          'fill-extrusion-color': currentStyle === 'light' ? '#D9DDE4' : '#1E2634',
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 16, ['get', 'height']],
          'fill-extrusion-base':   ['interpolate', ['linear'], ['zoom'], 14.5, 0, 16, ['get', 'min_height']],
          'fill-extrusion-opacity': 0.6,
        },
      }, labelId);
    } catch (_) {}
  }
  // 'style.load' fires when a style becomes fully usable — on the INITIAL
  // style and after every setStyle swap. Mounting layers here (never on the
  // early 'styledata' ticks) is what keeps the style state healthy: adding
  // while a style is still streaming corrupts the load (verified in a browser
  // smoke — the map never reached isStyleLoaded and addLayer went to a void).
  map.on('style.load', function() {
    try {
      ensureRouteLayer();
      addDetailLayers();
      if (navActive && lastNavPayload) { window.setNavRoute(lastNavPayload); }
      else if (lastRoutePayload) { window.setRoute(lastRoutePayload); }
      if (lastAccPayload) { window.setVehicleAccuracy(lastAccPayload[0], lastAccPayload[1], lastAccPayload[2]); }
      if (lastSelfPayload) { window.setSelf(lastSelfPayload[0], lastSelfPayload[1]); }
    } catch(_) {}
  });

  map.on('error', function(e) {
    post('err', {where: 'map', msg: (e && e.error && e.error.message) || 'map-error'});
  });

  let originMk = null, destMk = null, vehMk = null, selfMk = null;
  let originTag = null, destTag = null, vehTag = null;
  let framedOnce = false;
  let boundsKey = '';
  let lastBounds = null;
  /** [pickup, dropoff, vehicle] from the last setRoute — the Recenter basis. */
  let lastRouteLLs = null;
  let navActive = false;
  let vehAnim = null;
  let vehPos = null;
  // Last payloads, re-applied after a style swap (setStyle drops sources).
  let lastRoutePayload = null;
  let lastNavPayload = null;
  let lastAccPayload = null;
  let lastSelfPayload = null;

  const recenterEl = document.getElementById('recenter');
  /**
   * The camera is ours until the client takes it by panning or pinching; after
   * that only an explicit Recenter hands it back. The CONTROL, however, is
   * always on screen — it used to be display:none until a drag, so a client who
   * never touched the map had no way to re-frame at all.
   */
  let userOwnsCamera = false;
  function showRecenter() { recenterEl.style.display = 'flex'; }

  /** Every active mission marker AND the drawn route — pickup, drop-off, the
   *  officer's vehicle, the client, and the road-following line, which can
   *  bulge well outside the straight three-point box. */
  function missionBounds() {
    var b = new mapboxgl.LngLatBounds();
    var any = false;
    if (lastRouteLLs) {
      for (var i = 0; i < lastRouteLLs.length; i++) {
        if (lastRouteLLs[i]) { b.extend(lastRouteLLs[i]); any = true; }
      }
    }
    if (lastSelfPayload && validLL(lastSelfPayload[0], lastSelfPayload[1])) {
      b.extend(lastSelfPayload); any = true;
    }
    if (lastNavPayload) {
      var segs = [lastNavPayload.traveled || [], lastNavPayload.ahead || []];
      for (var s = 0; s < segs.length; s++) {
        for (var k = 0; k < segs[s].length; k++) {
          var c = segs[s][k];
          if (c && validLL(c[0], c[1])) { b.extend(c); any = true; }
        }
      }
    }
    return any ? b : lastBounds;
  }

  function fitAll(duration) {
    var b = missionBounds();
    if (b) map.fitBounds(b, {padding: 56, duration: duration == null ? 600 : duration, maxZoom: 13});
  }

  recenterEl.addEventListener('click', function() {
    userOwnsCamera = false;
    fitAll(600);
  });

  /** RN calls this whenever the map changes size (expand / collapse). */
  window.refit = function() {
    try { userOwnsCamera = false; fitAll(0); } catch (e) { post('err', {where: 'refit', msg: String(e)}); }
  };

  map.on('dragstart', function() { userOwnsCamera = true; });
  map.on('zoomstart', function(e) { if (e.originalEvent) userOwnsCamera = true; });

  // ── Orientation (deck page 7) ────────────────────────────────────────────
  // North Up is the client's default: they are a passenger watching a detail,
  // not driving it, and rotating a watcher's map is disorienting. Track Up is
  // one tap away and becomes the default once protection is ACTIVE, which is
  // the deck's "during active navigation".
  var orientMode = 'north';
  var vehBearing = 0, haveVehBearing = false, lastCourseLL = null;
  var NAV_PITCH = 45, MIN_COURSE_M = 8;

  function bearingDeg(a, b) {
    var y1 = a[1] * Math.PI / 180, y2 = b[1] * Math.PI / 180;
    var dx = (b[0] - a[0]) * Math.PI / 180;
    var y = Math.sin(dx) * Math.cos(y2);
    var x = Math.cos(y1) * Math.sin(y2) - Math.sin(y1) * Math.cos(y2) * Math.cos(dx);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function metresBetween(a, b) {
    var mLat = 111320, mLng = 111320 * Math.cos(a[1] * Math.PI / 180);
    return Math.hypot((b[0] - a[0]) * mLng, (b[1] - a[1]) * mLat);
  }
  function blendBearing(from, to, k) {
    var d = ((to - from + 540) % 360) - 180;
    return (from + d * k + 360) % 360;
  }
  /** Course over ground from consecutive vehicle fixes; gated on real movement
   *  so a parked vehicle cannot spin the map on GPS noise. */
  function noteVehicleCourse(ll) {
    if (!lastCourseLL) { lastCourseLL = ll; return; }
    if (metresBetween(lastCourseLL, ll) < MIN_COURSE_M) return;
    var raw = bearingDeg(lastCourseLL, ll);
    vehBearing = haveVehBearing ? blendBearing(vehBearing, raw, 0.4) : raw;
    haveVehBearing = true;
    lastCourseLL = ll;
    paintVehicleHeading();
  }
  /** The arrow is a screen-space element, so in track-up it must be
   *  counter-rotated by the map bearing or the rotation is applied twice. */
  function paintVehicleHeading() {
    if (!vehMk || !haveVehBearing) return;
    var pin = vehMk.getElement().querySelector('.pin');
    if (pin) pin.style.transform = 'rotate(' + (vehBearing - map.getBearing()) + 'deg)';
  }
  map.on('rotate', paintVehicleHeading);

  var orientEl = document.getElementById('orient');
  function applyOrient(animate) {
    var up = orientMode === 'track' && haveVehBearing;
    if (orientEl) orientEl.textContent = up ? 'TRK' : 'N';
    map.easeTo({
      bearing: up ? vehBearing : 0,
      pitch: up ? NAV_PITCH : 0,
      duration: animate === false ? 0 : 500,
    });
    paintVehicleHeading();
  }
  if (orientEl) {
    orientEl.addEventListener('click', function() {
      orientMode = orientMode === 'track' ? 'north' : 'track';
      userOwnsCamera = true;
      applyOrient(true);
      post('orient', {mode: orientMode});
    });
  }
  /** RN drives the default: track-up once protection is active. */
  window.setNavCamera = function(payload) {
    try {
      var mode = (payload && payload.mode) === 'track' ? 'track' : 'north';
      if (mode === orientMode) return;
      orientMode = mode;
      applyOrient(true);
    } catch (e) { post('err', {where: 'setNavCamera', msg: String(e)}); }
  };

  /**
   * RN overlays (the fullscreen verify-code bar) float ABOVE this WebView and it
   * cannot see them. RN reports the space they occupy so the legend and the
   * style segment sit below rather than underneath — the same contract the
   * driver map uses for setSysTopGuard.
   */
  window.setTopGuard = function(px) {
    try {
      var v = (typeof px === 'number' && isFinite(px) && px >= 0) ? Math.round(px) : 10;
      document.documentElement.style.setProperty('--top-guard', v + 'px');
    } catch (e) { post('err', {where: 'setTopGuard', msg: String(e)}); }
  };

  /** Collapsed map: drop the secondary chrome so the route keeps the box. */
  window.setCompact = function(v) {
    try {
      document.body.classList.toggle('compact', !!v);
      // The box changed size; re-frame so the route still fits it.
      setTimeout(function() { try { map.resize(); if (!userOwnsCamera) fitAll(0); } catch (_) {} }, 0);
    } catch (e) { post('err', {where: 'setCompact', msg: String(e)}); }
  };

  function ensureRouteLayer() {
    if (!map.getSource('route')) {
      map.addSource('route', {type: 'geojson', data: {type:'FeatureCollection', features:[]}});
    }
    if (!map.getLayer('route-line')) {
      map.addLayer({
        id: 'route-line', type: 'line', source: 'route',
        paint: {
          // match = pairs + ONE default. The previous form had an extra arg
          // (even count) — an invalid expression GL rejects ASYNCHRONOUSLY
          // (map 'error' event), so the whole layer silently never mounted
          // and the route line never rendered. Found by browser smoke.
          'line-color': ['match', ['get', 'kind'], 'done', '#FFC107', '#00C853'],
          'line-width': 2.5, 'line-opacity': 0.9,
        },
      });
    }
  }

  map.on('load', () => {
    post('ready', mapPerf());
  });

  function makeMarker(className, lngLat) {
    const el = document.createElement('div');
    el.className = className;
    el.innerHTML = className === 'self-dot'
      ? '<div class="ring"></div><div class="pin"></div><div class="lbl">YOU</div>'
      : className === 'vehicle-dot'
      ? '<div class="ring"></div><div class="pin"></div>'
      : '<div class="pin"></div>';
    return new mapboxgl.Marker({element: el}).setLngLat(lngLat).addTo(map);
  }

  function addTag(lngLat, text) {
    const el = document.createElement('div');
    el.className = 'tag';
    el.textContent = text;
    return new mapboxgl.Marker({element: el, anchor: 'bottom'}).setLngLat(lngLat).addTo(map);
  }

  function setTag(tag, lngLat, text) {
    tag.setLngLat(lngLat);
    tag.getElement().textContent = text;
    return tag;
  }

  // Glide the vehicle dot between fixes; snap on implausible jumps (~>5 km).
  function animateVehicle(target) {
    if (!vehMk) return;
    const from = vehPos || target;
    const dLng = target[0] - from[0], dLat = target[1] - from[1];
    if (Math.abs(dLng) > 0.05 || Math.abs(dLat) > 0.05) {
      if (vehAnim) cancelAnimationFrame(vehAnim);
      vehPos = target;
      vehMk.setLngLat(target);
      if (vehTag) vehTag.setLngLat(target);
      return;
    }
    if (vehAnim) cancelAnimationFrame(vehAnim);
    const start = performance.now(), dur = 900;
    function step(now) {
      const t = Math.min(1, (now - start) / dur);
      const k = t * (2 - t);
      const cur = [from[0] + dLng * k, from[1] + dLat * k];
      vehPos = cur;
      vehMk.setLngLat(cur);
      if (vehTag) vehTag.setLngLat(cur);
      if (t < 1) vehAnim = requestAnimationFrame(step);
    }
    vehAnim = requestAnimationFrame(step);
  }

  window.setRoute = function(payload) {
    try {
      const {origin, vehicle, dest, etaLabel} = payload;
      // MG-12 — refuse invalid payloads OUTRIGHT (keep the last good frame).
      // 'warn', not 'err': an err post pre-ready would remount a healthy map.
      if (!validLL(origin.lng, origin.lat) || !validLL(dest.lng, dest.lat) || !validLL(vehicle.lng, vehicle.lat)) {
        post('warn', {where: 'setRoute', msg: 'invalid-coords'});
        return;
      }
      lastRoutePayload = payload;
      const oLL = [origin.lng, origin.lat];
      const dLL = [dest.lng, dest.lat];
      const vLL = [vehicle.lng, vehicle.lat];

      if (!originMk) originMk = makeMarker('origin-dot', oLL); else originMk.setLngLat(oLL);
      if (!destMk)   destMk   = makeMarker('dest-dot',   dLL); else destMk.setLngLat(dLL);
      if (!vehMk) {
        vehMk = makeMarker('vehicle-dot', vLL);
        vehPos = vLL;
      } else {
        animateVehicle(vLL);
      }
      // Course over ground for the track-up camera and the arrow marker.
      noteVehicleCourse(vLL);

      if (!originTag) originTag = addTag(oLL, origin.label || 'Origin');
      else setTag(originTag, oLL, origin.label || 'Origin');
      if (!destTag) destTag = addTag(dLL, dest.label || 'Destination');
      else setTag(destTag, dLL, dest.label || 'Destination');
      if (!vehTag) vehTag = addTag(vLL, vehicle.label || 'Vehicle');
      else vehTag.getElement().textContent = vehicle.label || 'Vehicle';

      ensureRouteLayer();
      // Why: once the Directions split owns the route source, the straight-line
      // fallback must not clobber it (two-writer flicker).
      if (!navActive) {
        const src = map.getSource('route');
        if (src && src.setData) {
          src.setData({
            type: 'FeatureCollection',
            features: [
              {type:'Feature', properties:{kind:'done'}, geometry:{type:'LineString', coordinates:[oLL, vLL]}},
              {type:'Feature', properties:{kind:'future'}, geometry:{type:'LineString', coordinates:[vLL, dLL]}},
            ],
          });
        }
      }

      const bounds = new mapboxgl.LngLatBounds();
      bounds.extend(oLL);
      bounds.extend(dLL);
      bounds.extend(vLL);
      lastBounds = bounds;
      // Remembered so an explicit Recenter can re-frame EVERYTHING, including
      // the client's own dot, which the automatic framing deliberately leaves
      // out (see setSelf).
      lastRouteLLs = [oLL, dLL, vLL];
      const key = oLL.map(function(n){return n.toFixed(4);}).join(',') + '|' + dLL.map(function(n){return n.toFixed(4);}).join(',');
      if (!framedOnce || key !== boundsKey) {
        boundsKey = key;
        framedOnce = true;
        fitAll(600);
      } else if (!userOwnsCamera && vehPos && !map.getBounds().contains(vehPos)) {
        // The officer drove out of the viewport. The old policy framed once per
        // leg and never looked again, so the vehicle could sit off-screen for
        // the rest of the mission with no automatic recovery — the founder's
        // "map not centre" / "cannot see cpo". Only re-frames while the camera
        // is still ours; a client who has panned keeps what they chose.
        fitAll(700);
      }

      const txt = document.getElementById('etaText');
      if (txt) txt.textContent = etaLabel || 'ETA —';
    } catch(e) { post('err', {where: 'setRoute', msg: String(e)}); }
  };

  // MONITOR-MAP (#10) — road-following two-tone progress. RN computes the real
  // shortest route (Mapbox Directions) and splits it at the vehicle: traveled
  // (done colour) + ahead (future colour) are arrays of [lng,lat]. Reuses the
  // existing route-line kind colouring; setRoute's straight lines remain the
  // fallback when no route/token is available.
  window.setNavRoute = function(payload) {
    try {
      lastNavPayload = payload;
      var traveled = (payload && payload.traveled) || [];
      var ahead = (payload && payload.ahead) || [];
      ensureRouteLayer();
      var src = map.getSource('route');
      if (!src || !src.setData) return;
      var features = [];
      if (traveled.length >= 2) {
        features.push({type:'Feature', properties:{kind:'done'}, geometry:{type:'LineString', coordinates: traveled}});
      }
      if (ahead.length >= 2) {
        features.push({type:'Feature', properties:{kind:'future'}, geometry:{type:'LineString', coordinates: ahead}});
      }
      navActive = features.length > 0;
      src.setData({type:'FeatureCollection', features: features});
    } catch(e) { post('err', {where: 'setNavRoute', msg: String(e)}); }
  };

  window.setProgress = function(v) {
    try {
      var el = document.getElementById('progText');
      if (!el) return;
      if (v == null) { el.textContent = ''; return; }
      // Prefer a pre-formatted label from RN ("4.2 km to drop-off"). A bare
      // percentage to "B" was not something a client could act on, and it read
      // 0% for the whole approach leg. The numeric form is kept only so an
      // older caller cannot blank the pill.
      el.textContent = (typeof v === 'number') ? (v + '% TO B') : String(v);
    } catch(_) {}
  };

  // B-89 MG-14 — GPS confidence circle under the vehicle dot (radius =
  // the fix's reported accuracy in meters, as a 48-point polygon so the
  // radius is true meters at any zoom). Sits below the route line.
  function circleFeature(lng, lat, radiusM) {
    var latR = radiusM / 111320;
    var lngR = radiusM / (111320 * Math.cos(lat * Math.PI / 180) || 1);
    var pts = [];
    for (var i = 0; i <= 48; i++) {
      var a = (i / 48) * 2 * Math.PI;
      pts.push([lng + lngR * Math.cos(a), lat + latR * Math.sin(a)]);
    }
    return {type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [pts]}};
  }
  function ensureAccuracyLayer() {
    if (!map.getSource('veh-accuracy')) {
      map.addSource('veh-accuracy', {type: 'geojson', data: {type: 'FeatureCollection', features: []}});
    }
    if (!map.getLayer('veh-accuracy-fill')) {
      map.addLayer({
        id: 'veh-accuracy-fill', type: 'fill', source: 'veh-accuracy',
        paint: {'fill-color': '#5B8DEF', 'fill-opacity': 0.14},
      }, map.getLayer('route-line') ? 'route-line' : undefined);
    }
  }
  window.setVehicleAccuracy = function(lng, lat, radiusM) {
    try {
      if (!validLL(lng, lat) || !(radiusM > 0)) return;
      lastAccPayload = [lng, lat, radiusM];
      ensureAccuracyLayer();
      var src = map.getSource('veh-accuracy');
      if (src && src.setData) {
        src.setData({type: 'FeatureCollection', features: [circleFeature(lng, lat, radiusM)]});
      }
    } catch(_) {}
  };
  // Review m-4 — when the WS accuracy stream stops (poll-only fixes carry
  // no accuracy), RN clears the circle so it can't sit frozen at a stale
  // position while the dot moves on.
  window.clearVehicleAccuracy = function() {
    try {
      lastAccPayload = null;
      var src = map.getSource('veh-accuracy');
      if (src && src.setData) {
        src.setData({type: 'FeatureCollection', features: []});
      }
    } catch(_) {}
  };

  // B-214 — "you are here": the client's own live position, a distinct
  // avatar circle from the CPO vehicle dot. Not included in fitBounds —
  // the camera stays framed on the mission route, the self-dot just shows
  // up wherever it falls on the current view (or off-screen if the client
  // has wandered, same as any "you" dot on a live map).
  window.setSelf = function(lng, lat) {
    try {
      if (!validLL(lng, lat)) return;
      lastSelfPayload = [lng, lat];
      var ll = [lng, lat];
      if (!selfMk) selfMk = makeMarker('self-dot', ll);
      else selfMk.setLngLat(ll);
    } catch(e) { post('err', {where: 'setSelf', msg: String(e)}); }
  };
  window.clearSelf = function() {
    try {
      lastSelfPayload = null;
      if (selfMk) { selfMk.remove(); selfMk = null; }
    } catch(_) {}
  };

  // Style swap: setStyle drops user sources/layers — once the new style has
  // fully loaded, re-attach the route layer and re-apply the last payloads.
  // DOM markers (origin/dest/vehicle + tags) survive untouched.
  window.setStyle = function(name) {
    try {
      if (!STYLES[name] || name === currentStyle) return;
      currentStyle = name;
      document.body.classList.remove('dark', 'light', 'sat');
      document.body.classList.add(name);
      var segs = document.querySelectorAll('#styleseg .seg');
      for (var i = 0; i < segs.length; i++) {
        segs[i].classList.toggle('on', segs[i].getAttribute('data-style') === name);
      }
      // Layer + payload re-attach happens in the persistent 'style.load'
      // handler above once the new style is fully usable.
      map.setStyle(STYLES[name]);
    } catch(e) { post('err', {where: 'setStyle', msg: String(e)}); }
  };
  (function() {
    var segs = document.querySelectorAll('#styleseg .seg');
    for (var i = 0; i < segs.length; i++) {
      segs[i].addEventListener('click', function() { window.setStyle(this.getAttribute('data-style')); });
    }
  })();
</script>
</body>
</html>`;
}
