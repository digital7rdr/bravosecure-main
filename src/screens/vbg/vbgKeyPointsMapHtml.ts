/**
 * Inline Mapbox GL JS HTML for the VBG "Nearby Key Points" map.
 *
 * Renders a real interactive map centered on the principal, with the
 * principal's locator dot + colour-coded key-point markers (police / hospital
 * / embassy / fire) at their TRUE coordinates. RN pushes the centre + points
 * in via `window.updateKeyPoints(centre, points)` and listens for taps.
 *
 * A DARK | LIGHT segment (top-right) swaps between the obsidian dark style
 * and a white-background light style in place; the radius circle, heatmap and
 * detail layers are re-mounted after each swap (setStyle drops user layers).
 * High-zoom 3D building extrusions give the map real street-level detail.
 *
 * A HEATMAP chip (under the style segment, default ON) SWITCHES the point
 * representation (founder rule 2026-08-01): ON = density heatmap with the
 * individual key-point pins + labels hidden (decluttered), OFF = pins +
 * labels with the heat layer hidden. The principal locator always shows.
 * Points carry no severity client-side today, so weight is uniform — but an
 * optional numeric `weight` per point is honoured if the payload carries one.
 *
 * Token injected at bundle time from EXPO_PUBLIC_MAPBOX_TOKEN.
 */
export function buildVbgKeyPointsMapHtml(
  mapboxToken: string,
  opts?: {
    /**
     * false = plain embed (booking zone map): no HEATMAP chip and heat OFF by
     * default, so pushed markers (if any) stay visible. Default true.
     */
    heatChip?: boolean;
  },
): string {
  const heatChip = opts?.heatChip !== false;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no, viewport-fit=cover"/>
<link href="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.css" rel="stylesheet"/>
<style>
  html, body { margin:0; padding:0; height:100%; background:#07090D; overflow:hidden;
    font-family:-apple-system,"Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased; }
  *,*::before,*::after { box-sizing:border-box; }
  #map { position:absolute; inset:0; background:#07090D; }
  body.light #map { background:#F4F5F7; }

  /* style segment control */
  /* B-409 — the host may render this map FULL-BLEED behind its own header
     (VBGMapScreen uses absoluteFillObject), and the WebView cannot see that
     overlay. The screen measures its header and pushes the offset in via
     --chrome-top, exactly like --recenter-bottom on the tracker map. The
     literal is only the pre-measure fallback, correct for embedded cards
     that have no chrome above the map. */
  .styleseg { position:absolute; top:var(--chrome-top, 10px); right:10px; z-index:20; display:flex;
    background:rgba(7,12,22,0.85); border:1px solid rgba(255,255,255,0.15); border-radius:9px;
    overflow:hidden; -webkit-tap-highlight-color:transparent; user-select:none; }
  .styleseg .seg { padding:5px 10px; font-size:9px; font-weight:700; letter-spacing:1px;
    color:rgba(180,188,204,0.6); cursor:pointer; }
  .styleseg .seg.on { background:#5B8DEF; color:#fff; }

  /* heatmap toggle chip — same chrome language as the style segment */
  .heatchip { position:absolute; top:calc(var(--chrome-top, 10px) + 32px); right:10px; z-index:20; padding:5px 10px;
    background:rgba(7,12,22,0.85); border:1px solid rgba(255,255,255,0.15); border-radius:9px;
    font-size:9px; font-weight:700; letter-spacing:1px; color:rgba(180,188,204,0.6);
    cursor:pointer; -webkit-tap-highlight-color:transparent; user-select:none; }
  .heatchip.on { background:#5B8DEF; border-color:rgba(255,255,255,0.18); color:#fff; }

  /* principal locator */
  .me { width:0; height:0; }
  .me .core { position:absolute; left:-8px; top:-8px; width:16px; height:16px; border-radius:50%;
    background:#5B8DEF; border:2px solid #fff; box-shadow:0 0 10px #5B8DEF; }
  .me .ring { position:absolute; left:-18px; top:-18px; width:36px; height:36px; border-radius:50%;
    border:1px solid rgba(91,141,239,0.5); animation:pulse 2s infinite; }
  @keyframes pulse { 0%{transform:scale(0.6);opacity:0.9} 100%{transform:scale(1.4);opacity:0} }

  /* key-point marker */
  .kp { width:0; height:0; cursor:pointer; }
  .kp .pin { position:absolute; left:-7px; top:-7px; width:14px; height:14px; border-radius:50%;
    border:1.5px solid rgba(255,255,255,0.7); box-shadow:0 0 8px currentColor; }
  .kp .tip { position:absolute; left:50%; bottom:12px; transform:translateX(-50%);
    white-space:nowrap; background:rgba(7,12,22,0.9); border:1px solid rgba(255,255,255,0.15);
    border-radius:6px; padding:3px 7px; font-size:10px; color:#F2F4F8; font-weight:600; }
</style>
</head>
<body>
<div id="map"></div>
<div class="styleseg" id="styleseg">
  <div class="seg on" data-style="dark">DARK</div>
  <div class="seg" data-style="light">LIGHT</div>
</div>
${heatChip ? '<div class="heatchip on" id="heatchip">HEATMAP</div>' : ''}
<script src="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.js"></script>
<script>
  var RN = window.ReactNativeWebView;
  var COLOR = { police:'#5B8DEF', hospital:'#4ADE80', embassy:'#F5B544', fire:'#FF7A5C' };
  var STYLES = { dark:'mapbox://styles/mapbox/dark-v11', light:'mapbox://styles/mapbox/light-v11' };
  var currentStyle = 'dark';
  function tell(type, extra){ try { RN && RN.postMessage(JSON.stringify(Object.assign({type:type}, extra||{}))); } catch(e){} }
  // mapboxgl.supported was REMOVED in GL JS v3 — guard on its existence so we
  // do not post a spurious gl-unsupported error on every load (the old
  // negation was always truthy once the API vanished).
  if (typeof mapboxgl.supported === 'function' && !mapboxgl.supported()) { tell('error', {reason:'gl-unsupported'}); }
  mapboxgl.accessToken = ${JSON.stringify(mapboxToken)};
  // B-89 P3 — a WebGL context failure used to throw before any postMessage;
  // fail fast so RN skips the 15 s watchdog wait.
  var map;
  try {
    map = new mapboxgl.Map({
      container:'map', style:STYLES.dark,
      center:[90.4,23.7], zoom:12, attributionControl:false, antialias:true
    });
  } catch (e) {
    tell('error', {reason: String(e)});
    throw e;
  }
  map.addControl(new mapboxgl.AttributionControl({compact:true}), 'bottom-right');
  // The map mounts inside a ScrollView card whose height may be 0 at first
  // paint, leaving Mapbox with a 0x0 canvas (blank tiles). Force a resize once
  // layout settles, and again on every data push, so tiles render.
  map.on('error', function(e){ tell('error', {reason: (e && e.error && e.error.message) || 'map-error'}); });
  function fixSize(){ try { map.resize(); } catch(e){} }
  setTimeout(fixSize, 120); setTimeout(fixSize, 500); setTimeout(fixSize, 1200);
  window.addEventListener('resize', fixSize);
  var markers = [];
  // Key-point marker ELEMENTS, kept separately so the HEATMAP chip can show/
  // hide the pins without touching the principal locator.
  var kpEls = [];
  function clear(){ markers.forEach(function(m){m.remove();}); markers = []; kpEls = []; }
  function setKpVisible(show){
    kpEls.forEach(function(el){ el.style.display = show ? '' : 'none'; });
  }

  // High-zoom detail: extruded 3D buildings, inserted under the first label
  // layer so street/POI names still read on top.
  function addDetailLayers(){
    try {
      if (map.getLayer('vbg-3d-buildings')) return;
      var layers = (map.getStyle().layers) || [];
      var labelId;
      for (var i=0;i<layers.length;i++){
        var l = layers[i];
        if (l.type === 'symbol' && l.layout && l.layout['text-field']) { labelId = l.id; break; }
      }
      map.addLayer({
        id:'vbg-3d-buildings', source:'composite', 'source-layer':'building',
        filter:['==',['get','extrude'],'true'], type:'fill-extrusion', minzoom:14.5,
        paint:{
          'fill-extrusion-color': currentStyle === 'light' ? '#D9DDE4' : '#1E2634',
          'fill-extrusion-height': ['interpolate',['linear'],['zoom'],14.5,0,16,['get','height']],
          'fill-extrusion-base':   ['interpolate',['linear'],['zoom'],14.5,0,16,['get','min_height']],
          'fill-extrusion-opacity': 0.6
        }
      }, labelId);
    } catch(e){}
  }

  // Build a circle polygon (GeoJSON) of radiusKm around [lng,lat].
  function circlePolygon(lng, lat, radiusKm){
    var pts = [], n = 64, R = 6371;
    var latR = lat * Math.PI/180;
    for (var i=0;i<=n;i++){
      var brng = (i/n) * 2*Math.PI;
      var dr = radiusKm / R;
      var lat2 = Math.asin(Math.sin(latR)*Math.cos(dr) + Math.cos(latR)*Math.sin(dr)*Math.cos(brng));
      var lng2 = (lng*Math.PI/180) + Math.atan2(Math.sin(brng)*Math.sin(dr)*Math.cos(latR), Math.cos(dr)-Math.sin(latR)*Math.sin(lat2));
      pts.push([lng2*180/Math.PI, lat2*180/Math.PI]);
    }
    return {type:'Feature', geometry:{type:'Polygon', coordinates:[pts]}};
  }
  // ── Heatmap layer ──────────────────────────────────────────────────────
  // Density heatmap of the pushed points. Weight is uniform (client data
  // carries no per-point severity today) but honours an optional numeric
  // p.weight if the payload ever adds one. Ramp: transparent → amber →
  // red; radius/intensity tuned for city zoom (the fitBounds range is
  // ~z7 for a 200km ring up to maxZoom 14 for 5km); opacity fades to 0 by
  // z15.5 where the individual DOM markers take over.
  var heatOn = ${heatChip ? 'true' : 'false'};
  var lastHeatPoints = [];
  function heatFeatures(points){
    return (points||[]).filter(function(p){
      return p && typeof p.lat === 'number' && typeof p.lng === 'number';
    }).map(function(p){
      return {type:'Feature',
        properties:{weight: typeof p.weight === 'number' ? p.weight : 1},
        geometry:{type:'Point', coordinates:[p.lng, p.lat]}};
    });
  }
  // A data push can land BEFORE the style finishes loading (RN pushes as soon
  // as the fetch resolves); addSource would throw and the swallow left the
  // heat layer unmounted until a second push happened to arrive. Defer to
  // 'idle' instead so the FIRST push always mounts the layer.
  function heatSafe(points){
    lastHeatPoints = points || [];
    if (map.isStyleLoaded()){ try { updateHeat(lastHeatPoints); } catch(e){} return; }
    map.once('idle', function(){ try { updateHeat(lastHeatPoints); } catch(e){} });
  }
  function updateHeat(points){
    lastHeatPoints = points || [];
    var data = {type:'FeatureCollection', features: heatFeatures(lastHeatPoints)};
    var src = map.getSource('vbg-heat');
    if (src){ src.setData(data); return; }
    // Insert beneath the radius ring so the search-area outline stays crisp;
    // with no radius drawn, slot under the first label layer so place names
    // stay readable. Point pins are DOM markers — always above canvas layers.
    var beforeId;
    if (map.getLayer('radius-line')) { beforeId = 'radius-line'; }
    else {
      var lyrs = (map.getStyle().layers) || [];
      for (var i=0;i<lyrs.length;i++){
        if (lyrs[i].type === 'symbol' && lyrs[i].layout && lyrs[i].layout['text-field']) { beforeId = lyrs[i].id; break; }
      }
    }
    map.addSource('vbg-heat', {type:'geojson', data:data});
    map.addLayer({
      id:'vbg-heat', type:'heatmap', source:'vbg-heat', maxzoom:16,
      layout:{visibility: heatOn ? 'visible' : 'none'},
      paint:{
        'heatmap-weight': ['coalesce', ['get','weight'], 1],
        'heatmap-intensity': ['interpolate',['linear'],['zoom'], 7,0.7, 11,1.2, 14,1.8],
        'heatmap-color': ['interpolate',['linear'],['heatmap-density'],
          0,    'rgba(0,0,0,0)',
          0.15, 'rgba(245,181,68,0.25)',
          0.4,  'rgba(245,181,68,0.55)',
          0.65, 'rgba(255,122,92,0.70)',
          1,    'rgba(255,93,93,0.88)'],
        'heatmap-radius': ['interpolate',['linear'],['zoom'], 7,16, 11,32, 14,46],
        'heatmap-opacity': ['interpolate',['linear'],['zoom'], 7,0.85, 13,0.7, 15.5,0]
      }
    }, beforeId);
  }
  function setHeatVisible(on){
    heatOn = on;
    var chip = document.getElementById('heatchip');
    if (chip) { chip.classList.toggle('on', on); }
    try {
      if (map.getLayer('vbg-heat')) { map.setLayoutProperty('vbg-heat', 'visibility', on ? 'visible' : 'none'); }
      // Toggled ON before the layer ever mounted (e.g. first push raced the
      // style load) — mount it now instead of doing nothing.
      else if (on && lastHeatPoints.length) { heatSafe(lastHeatPoints); }
    } catch(e){}
    // The chip is the key-point toggle (founder rule): heat ON = pins hidden.
    setKpVisible(!on);
  }
  (function(){
    var chip = document.getElementById('heatchip');
    if (chip) { chip.addEventListener('click', function(){ setHeatVisible(!heatOn); }); }
  })();

  var lastCircle = null;
  function drawCircle(lng, lat, radiusKm){
    lastCircle = {lng:lng, lat:lat, radiusKm:radiusKm};
    var data = circlePolygon(lng, lat, radiusKm);
    if (map.getSource('radius')){ map.getSource('radius').setData(data); return; }
    map.addSource('radius', {type:'geojson', data:data});
    map.addLayer({id:'radius-fill', type:'fill', source:'radius',
      paint:{'fill-color':'#5B8DEF','fill-opacity':0.10}});
    map.addLayer({id:'radius-line', type:'line', source:'radius',
      paint:{'line-color':'#5B8DEF','line-width':1.5,'line-opacity':0.7}});
  }

  // Style swap: setStyle drops user sources/layers — re-mount the radius +
  // detail layers once the new style is ready. DOM markers survive untouched.
  window.setMapStyle = function(styleId){
    if (!STYLES[styleId] || styleId === currentStyle) return;
    currentStyle = styleId;
    document.body.classList.remove('dark','light');
    document.body.classList.add(styleId);
    var segs = document.querySelectorAll('#styleseg .seg');
    for (var i=0;i<segs.length;i++){ segs[i].classList.toggle('on', segs[i].getAttribute('data-style') === styleId); }
    map.once('style.load', function(){
      addDetailLayers();
      if (lastCircle){ try { drawCircle(lastCircle.lng, lastCircle.lat, lastCircle.radiusKm); } catch(e){} }
      // setStyle dropped the heat source/layer — re-mount with the last data
      // (after the circle, so the layer lands back beneath the radius ring).
      try { updateHeat(lastHeatPoints); } catch(e){}
    });
    map.setStyle(STYLES[styleId]);
  };
  (function(){
    var segs = document.querySelectorAll('#styleseg .seg');
    for (var i=0;i<segs.length;i++){
      segs[i].addEventListener('click', function(){ window.setMapStyle(this.getAttribute('data-style')); });
    }
  })();

  window.updateKeyPoints = function(centre, points, radiusKm){
    if (!centre || typeof centre.lat!=='number') return;
    fixSize();
    map.setCenter([centre.lng, centre.lat]);
    clear();
    if (radiusKm && radiusKm > 0){ try { drawCircle(centre.lng, centre.lat, radiusKm); } catch(e){} }
    heatSafe(points);
    // principal locator
    var meEl = document.createElement('div'); meEl.className='me';
    meEl.innerHTML = '<div class="ring"></div><div class="core"></div>';
    markers.push(new mapboxgl.Marker({element:meEl}).setLngLat([centre.lng, centre.lat]).addTo(map));
    // key points
    (points||[]).forEach(function(p){
      var c = COLOR[p.kind] || '#5B8DEF';
      var el = document.createElement('div'); el.className='kp'; el.style.color=c;
      el.innerHTML = '<div class="pin" style="background:'+c+'"></div>';
      // Label via textContent — OSM names are untrusted, never innerHTML.
      if (p.label){
        var tip = document.createElement('div'); tip.className='tip';
        tip.textContent = p.label;
        el.appendChild(tip);
      }
      el.addEventListener('click', function(){
        try { RN && RN.postMessage(JSON.stringify({type:'tap', point:p})); } catch(e){}
      });
      // Respect the chip state on (re)push — heat ON keeps the pins hidden.
      if (heatOn) { el.style.display = 'none'; }
      kpEls.push(el);
      markers.push(new mapboxgl.Marker({element:el}).setLngLat([p.lng, p.lat]).addTo(map));
    });
    // fit the radius circle (+ points) in view so the whole search area shows
    var b = new mapboxgl.LngLatBounds([centre.lng, centre.lat],[centre.lng, centre.lat]);
    (points||[]).forEach(function(p){ b.extend([p.lng, p.lat]); });
    if (radiusKm && radiusKm > 0){
      var c = circlePolygon(centre.lng, centre.lat, radiusKm).geometry.coordinates[0];
      c.forEach(function(pt){ b.extend(pt); });
    }
    try { map.fitBounds(b, {padding:40, maxZoom:14, duration:500}); } catch(e){}
  };
  map.on('load', function(){
    addDetailLayers();
    try { RN && RN.postMessage(JSON.stringify({type:'ready'})); } catch(e){}
  });
</script>
</body>
</html>`;
}
