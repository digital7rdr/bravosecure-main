# Mapbox Implementation Audit — Bravo Secure

**Date:** 2026-07-04
**Scope:** Entire repository — mobile app (React Native 0.81 / Expo SDK 54), ops console (Next.js 15), Android/iOS native config, backend touchpoints.
**Benchmark:** Google Maps / Uber / Lyft / Bolt / Grab / Careem production map experience.
**Method:** Read-only static audit of every map, location, camera, marker, route, and platform-config file. No code was modified.

---

# Executive Summary

**Overall Score: 42 / 100**

**Production Ready (against the Uber/Google-Maps bar): No.**
The app ships working, demo-able maps, but the implementation is structurally incapable of the "butter-smooth, zero-lag, native-feeling" experience of the benchmark apps — and several live screens have concrete correctness and UX defects on top of that.

**The single most important finding:** there is **no native map SDK in this app at all.** Every mobile map is **Mapbox GL JS v3.7.0 loaded from a CDN at runtime, running inside a `react-native-webview`**, driven by hand-rolled `injectJavaScript` / `postMessage` bridges built from HTML template strings. One screen (Intel Feed) uses **Leaflet** from unpkg instead. Meanwhile `react-native-maps@1.20.1` sits in `package.json` as a **completely dead dependency** (zero imports repo-wide), shipping the Google Maps native SDK into the APK for nothing.

This architecture caps everything downstream: gesture latency, marker animation, offline support, crash recovery, battery, and memory are all limited by the WebView, not by anything fixable inside the current code. Uber, Lyft, Grab, and Careem all render maps on a native GL surface with interpolated pucks and native gesture handling — that experience is **not reachable** from the current architecture regardless of tuning.

| Severity            | Count |
| ------------------- | ----- |
| **Critical Issues** | 4     |
| **High Issues**     | 7     |
| **Medium Issues**   | 11    |
| **Low Issues**      | 9     |

**Critical (detailed in "Critical Issues" section):**

1. WebView-embedded Mapbox GL JS architecture (whole-class ceiling on smoothness, offline, gestures, recovery).
2. LiveOps route map destroys + recreates all markers and re-runs `fitBounds` on **every** telemetry fix — camera fights the user, vehicle dot teleports.
3. Two-writer route race: `setRoute` and `setNavRoute` both write the same GeoJSON source every fix on the client live map — visible route flicker.
4. Ops console `flyTo` re-fires on every 2 s SWR poll (unstable `center` array prop) — the camera yanks the operator back mid-pan, continuously.

**High:** VBG map silently shows stale first-run data on every subsequent analysis; no off-route rerouting on the client live map (stale route re-split forever); ~5 concurrent timers + high-accuracy GPS with no background/focus gating (battery); zero WebView failure handling (no `onRenderProcessGone`, no `onError` on the booking picker → users can confirm a location over a blank map); background location declared in the manifest but not implemented (Play Store policy risk); XSS sink in the Leaflet intel map (external news-feed labels → `innerHTML`); Mapbox token committed to git in four places.

**What is genuinely good:** the ops-console `BravoMap` lifecycle (proper `map.remove()`, diff-by-id marker reuse, `escapeHtml`, listener teardown, complete Mapbox CSP); the agent tracker's route state machine (`navActive`, `framedOnce`, off-route refetch at 60 m, stale-response guard); consistent `JSON.stringify` token injection; `setData`-based GeoJSON updates; exponential-backoff polling with jitter and clean teardown; pinned `play-services-location`; no plaintext coordinate logging anywhere; E2E-encrypted VBG telemetry.

---

# Architecture Review

## Map surface inventory

| #   | Surface                                        | Tech                                                        | Status                                  |
| --- | ---------------------------------------------- | ----------------------------------------------------------- | --------------------------------------- |
| 1   | `LocationPickerScreen` (booking pin drop)      | Mapbox GL JS in WebView (`bravoLocationPickerMapHtml.ts`)   | **Live**                                |
| 2   | `LiveTrackingScreen` (client live view)        | Mapbox GL JS in WebView (`bravoLiveRouteMapHtml.ts`)        | **Live**                                |
| 3   | `AgentLiveTrackerScreen` (CPO/monitor tracker) | Mapbox GL JS in WebView (`bravoAgentTrackerMapHtml.ts`)     | **Live** — most mature                  |
| 4   | `VbgKeyPointsMap` (VBG geo-risk)               | Mapbox GL JS in WebView (`vbgKeyPointsMapHtml.ts`)          | **Live** — stale-data bug               |
| 5   | `IntelFeedScreen` (news intel map)             | **Leaflet 1.9.4** from unpkg in WebView (`bravoMapHtml.ts`) | **Live**                                |
| 6   | `BravoBookingMap` + `bravoBookingMapHtml.ts`   | Mapbox GL JS in WebView                                     | **Orphaned dead code** — zero importers |
| 7   | `JobMarketplaceScreen` / `JobDetailScreen`     | Mapbox **Static Images API** PNGs in `<Image>`              | Live                                    |
| 8   | Ops console `BravoMap.tsx`                     | `mapbox-gl@^3.9.0` native web                               | Live                                    |
| 9   | `ZoneMapScreen`                                | Stylised static card — **not a real map**                   | Live (out of scope)                     |

## Structural findings

- **No native map SDK.** Neither `@rnmapbox/maps` nor an active `react-native-maps` integration exists. All interactive mobile maps run Mapbox GL JS inside Chromium (`react-native-webview 13.15.0`). Confirmed: zero Mapbox native traces in `android/` (no Mapbox maven repo, no downloads token, no RNMapbox autolinking).
- **Dead dependency:** `react-native-maps@1.20.1` (`package.json:116`) has **zero imports** in the entire repo. It ships the Google/Apple Maps native SDKs into every binary for nothing — APK bloat plus a phantom Google Maps API-key configuration burden (`EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` documented in sqa.md env reference).
- **Orphaned component:** `BravoBookingMap.tsx` + `bravoBookingMapHtml.ts` have no importers (only a stale mention in `docs/handoffs/AUTO_DISPATCH_BUGFIX_GUIDE.md:189`). The "Select-Zone pulse map" does not render anywhere in production.
- **Five divergent HTML map implementations.** Each `*MapHtml.ts` re-implements the same concerns (token injection, ready handshake, marker management, camera policy, error reporting) with different levels of maturity. The agent tracker HTML has `navActive`/`framedOnce`/follow-mode/error-reporting; the LiveOps HTML has none of them; the booking HTML has no error reporting; Leaflet is a fourth paradigm entirely. There is no shared bridge abstraction, no shared message protocol, no shared version pin. Fixes demonstrably do not propagate: the camera and two-writer bugs fixed in the agent HTML still exist in the LiveOps HTML.
- **Double bridge hop.** Every map update crosses RN JS → (bridge) → WebView Chromium JS → GL. Every user event crosses back via `postMessage` JSON strings. This is two serialization boundaries where native SDKs have zero.
- **Lifecycle:** map destruction is delegated entirely to WebView unmount (acceptable for WebView), but there is **no recovery path** anywhere: no `onRenderProcessGone` (Android renderer kill → permanent blank map), no `onContentProcessDidTerminate` (iOS), and `webReady` is never reset on reload (`AgentLiveTrackerScreen`), so RN keeps injecting into a blank page after an OS-initiated WebView process restart.
- **State:** map state lives in three places per screen — React state, refs (`webReady`, caches), and WebView-internal JS globals (`navActive`, `follow`, marker arrays) — with hand-maintained synchronization. The style cycler in `LocationPickerScreen.tsx:198-204` keeps two sources of truth (React `styleId` + injected `setMapStyle`); a dropped injection desyncs the FAB label from the actual map.
- **Re-render sources:** every map screen passes `source={{html}}` as a **new object literal each render** (`LocationPickerScreen.tsx:304`, `LiveTrackingScreen.tsx:595`, `AgentLiveTrackerScreen.tsx:686`, `VbgKeyPointsMap.tsx:61`). Correctness currently leans entirely on `react-native-webview`'s internal `source.html` string diff to avoid a full map engine reload on every keystroke/pan/poll re-render. This is a latent full-map-reload trap on a library upgrade.

**Verdict:** the WebView architecture was a rational fast path to shipped maps, but it is the ceiling on every axis the project brief cares about. The dead `react-native-maps` dependency proves a native path was once considered and abandoned without cleanup.

---

# Rendering Audit

- **Engine delivery is a runtime network dependency.** Mapbox GL JS v3.7.0 JS+CSS load from `api.mapbox.com/mapbox-gl-js/v3.7.0/*` inside every map HTML (`bravoLocationPickerMapHtml.ts:43`, `bravoLiveRouteMapHtml.ts:15`, `bravoBookingMapHtml.ts:18`, `bravoAgentTrackerMapHtml.ts:24`, `vbgKeyPointsMapHtml.ts:17`). The Leaflet map loads leaflet from unpkg **plus** `topojson-client` and a world-atlas TopoJSON from jsdelivr at runtime (`bravoMapHtml.ts:117,167,169`). Offline or CDN-blocked → **white/blank map**, and on most screens nothing tells the user (see UX).
- **No WebView cache tuning:** `cacheEnabled`/`cacheMode` are set on **zero** WebViews (grep-confirmed), so cold-start tile/engine reuse depends purely on default Chromium HTTP cache behavior.
- **Version skew:** mobile pins GL JS **3.7.0**, ops console uses **3.9.0** (`apps/ops-console/package.json:20`) — two rendering behaviors and bug surfaces to track.
- **Blank-tile guard exists only on VBG:** repeated `map.resize()` at 120/500/1200 ms + on resize (`vbgKeyPointsMapHtml.ts:59-61`) works around the 0×0-canvas blank-map class. The other HTMLs don't have it.
- **Style loading/switching:** done correctly in-place via `map.setStyle` + re-mount of custom layers on `styledata`/`style.load` (`bravoLocationPickerMapHtml.ts:189-191, 244-250`; `bravoAgentTrackerMapHtml.ts:651-656` re-applies the last route payload after swap; ops `BravoMap.tsx:194-202` uses a `styleNonce`). Minor: the picker's `styledata` handler runs on every styledata event (frequent), idempotent but wasteful.
- **Terrain / globe / 3D buildings:** none anywhere.
- **Layer ordering:** static and simple (route base/active/future sub-layers filtered by `kind`, `bravoAgentTrackerMapHtml.ts:282-310`) — fine.
- **Render thread reality:** GL runs on the WebView's compositor/GPU process, decoupled from the RN JS thread — pan/zoom inside the WebView is _internally_ smooth. What breaks smoothness is (a) marker DOM churn (LiveOps rebuilds all markers per fix), (b) infinite CSS pulse/radar animations on every marker (`bravoBookingMapHtml.ts:64-72`, threat markers `bravoMapHtml.ts:87-90`) burning compositor time continuously, (c) `fitBounds` storms (below), and (d) per-frame `map.project` DOM re-anchoring for every bubble on move/zoom/rotate/pitch (`bravoAgentTrackerMapHtml.ts:663-666`).
- **Map reload triggers:** IntelFeed's map is conditionally mounted (`{activeTab === 'map' && <WebView …>}`, `IntelFeedScreen.tsx:263`) — every tab switch **fully destroys and re-boots** the Leaflet map, re-fetching CDN scripts and world atlas.
- **White-map failure modes with no handling:** empty token → GL throws in-page, no `ready`, permanent blank (documented in `docs/handoffs/AUTO_DISPATCH_BUGFIX_GUIDE.md:183-191`); offline → blank; renderer crash → blank. Only `JobMarketplaceScreen.tsx:147-174` / `JobDetailScreen.tsx:335-348` (static images) and the ops console (SVG fallback grid, `BravoMap.tsx:408-447`) have fallbacks.

---

# Camera Audit

The camera layer is the **worst-scoring area** of the audit. Three of the four critical issues are camera issues.

- **LiveOps map (client-facing): `fitBounds` on every telemetry fix.** `window.setRoute` runs `map.fitBounds(bounds, {padding:56, duration:600, maxZoom:13})` unconditionally (`bravoLiveRouteMapHtml.ts:172-176`), and RN calls `setRoute` on every vehicle fix (8 s sim / ~5 s poll). Consequences: any user pan/zoom is **overridden within one tick**; the camera perpetually re-animates; there is no `framedOnce` guard, no follow flag, no gesture detection. The agent HTML fixed exactly this (`framedOnce`, `bravoAgentTrackerMapHtml.ts:380-386`) — the fix never propagated.
- **Ops console: `flyTo` on every render.** `useEffect(() => map.flyTo({center, zoom, speed:1.2}), [center, zoom, fallback])` (`BravoMap.tsx:403-406`) with `center` passed as a **fresh array literal** by every caller (`live/page.tsx:98`, `dashboard/page.tsx:114`, `live/[id]/page.tsx:357-362`). SWR polls every 2 s (`lib/api.ts:990-991`), each poll re-renders, each re-render is a new array reference, each new reference re-fires `flyTo`. The operator's map re-centers itself every ~2 s, indefinitely. This is the single biggest ops-console UX defect.
- **Follow mode is one-way (agent tracker).** `map.on('dragstart', () => { follow = false })` (`bravoAgentTrackerMapHtml.ts:668`) disables camera-follow when the user pans — correct — but **nothing ever re-enables it** and there is no recenter button. One accidental pan and the CPO loses auto-follow for the remainder of the mission.
- **Camera easing:** `easeTo` with 800 ms duration for follow (`bravoAgentTrackerMapHtml.ts:447-454`) is reasonable; `flyTo` durations of 600–900 ms on the picker/booking maps are fine. No custom interpolation curves, no interruption arbitration anywhere (Mapbox's default gesture-cancels-animation is the only mechanism).
- **Double camera work at startup (orphaned booking map):** `updateZones` (and therefore `fitBounds`/`flyTo`) runs twice on cold start due to the redundant `onLoadEnd` + `ready` triggers (`BravoBookingMap.tsx:43,61`).
- **No camera queue / no conflict resolution:** concurrent programmatic camera calls simply last-write-win. On the live maps this manifests as the fitBounds fight above.
- **Bearing/pitch:** never used. No heading-up navigation camera mode exists (see Navigation).

---

# User Location Audit

Location comes exclusively from `react-native-geolocation-service`; permissions are hand-rolled (`PermissionsAndroid` + `Geolocation.requestAuthorization`). Twelve call sites audited.

**What's done well**

- Every watcher is cleaned up (`clearWatch` + cancelled flags) — no watcher leaks found (`LiveTrackingScreen.tsx:301-307`, `MissionLeadConsoleScreen.tsx:201-203`, `AgentDashboardScreen.tsx:320-323`, `useLocation.ts:64-66`).
- Sensible tiered options per use case: mission telemetry `{highAccuracy, distanceFilter:10, interval:10000, fastestInterval:5000}`; duty watcher `{interval:30000, fastestInterval:15000, distanceFilter:20}`; SOS panic `{timeout:3000, maximumAge:30000}` with a **fire-SOS-anyway-on-error** path (`DashboardScreen.tsx:363-367`) — good safety engineering.
- `play-services-location` pinned to 21.3.0 with `resolutionStrategy.force` (`android/build.gradle:10-11,59`) to prevent the FusedLocationProvider `IncompatibleClassChangeError` — a real production-grade fix.
- Anti-spoof signals reported: `accuracy_m`, `speed_kph`, `is_mocked` (`onDutyHeartbeat.ts:60-63`).
- VBG telemetry is AES-256-GCM sealed client-side before POST (`VBGHomeScreen.tsx:131-136`).

**Defects**

- **No smoothing of any kind.** No Kalman filter, no jump/outlier rejection, no accuracy gating, no speed-plausibility check, no dead reckoning — anywhere (grep-confirmed). Raw fixes go straight to the server and straight onto maps. GPS jumps render as literal marker teleports.
- **Heading is dead end-to-end.** The agent HTML supports a rotating heading cone (`bravoAgentTrackerMapHtml.ts:441-443`) but RN never sends `heading_deg` in `setCpo` (`AgentLiveTrackerScreen.tsx:458-461`) — the cone permanently points north. `MissionLeadConsoleScreen` captures heading and sends it to the _server_, but the render path drops it. No compass/magnetometer fallback for stationary heading.
- **Background location is declared but not implemented.** Manifest declares `ACCESS_BACKGROUND_LOCATION` + `FOREGROUND_SERVICE_LOCATION` (`AndroidManifest.xml:7,32`); code requests iOS `'always'` (`AgentDashboardScreen.tsx:273,570`, `PermissionsScreen.tsx:78`); but **no location foreground service exists** (only the call FGS, type `microphone|camera`, `AndroidManifest.xml:123-126`), `onDutyHeartbeat.ts:142-147` keep-alive is a TODO no-op, and `app.json:26` `UIBackgroundModes` has **no `location` entry**. Net: background GPS silently dies on both platforms while the manifest tells Google Play you use it — a **Play policy/review risk** (declared, justifiable-in-review permission with no functioning feature) _and_ a product gap (duty heartbeat stops when the agent pockets the phone).
- **Errors swallowed silently** at the duty watcher (`AgentDashboardScreen.tsx:311,316` — empty callbacks) and heartbeat (`onDutyHeartbeat.ts:90-96`). Ops can see an agent go dark with no client-side signal as to why. (Contrast: `MissionLeadConsoleScreen.tsx:180-183` counts failures and shows a degraded indicator — the good pattern exists in-repo.)
- **Cold start:** one-shot seed fix before the watch on the dashboard (good, `AgentDashboardScreen.tsx:309-313`); the picker's "Locate me" uses `maximumAge:30_000` (good). No last-known-location persistence for instant map centering on cold app start.
- `useLocation.ts` hook: watch options omit `interval`/`timeout` entirely (`useLocation.ts:53`) and the one-shot has no timeout (`:58`) — can hang forever on some devices. Appears unused by production screens, but it's a footgun on the shelf.

---

# Marker Audit

- **No marker animation anywhere.** Every live position update is a teleport: agent tracker uses `setLngLat` with no interpolation (`bravoAgentTrackerMapHtml.ts:436` — jumps every 4 s poll); LiveOps is worse — it **destroys and recreates all three markers on every fix** (`bravoLiveRouteMapHtml.ts:143-154`), restarting the CSS pulse ring from zero each time. Benchmark apps interpolate vehicle position over the update interval (Uber's cars glide); nothing here does.
- **Marker strategy is DOM markers everywhere** (`mapboxgl.Marker` with custom HTML elements). Fine at current counts (≤10 per screen), but DOM markers don't scale — no symbol-layer/feature-state path exists for larger datasets.
- **Update paths by surface:**
  - Ops console: **excellent** — diff-by-id map, `setLngLat` only on actual coordinate change, restyle only on type change, popup rebuild only on label change, non-finite coords filtered (`BravoMap.tsx:337-400`). This is the reference implementation the mobile HTMLs should have had.
  - LiveOps HTML: full teardown/rebuild per fix (critical, above).
  - VBG HTML: clear-all + rebuild per push, but pushes only happen on load (masked by the stale-data bug).
  - Leaflet intel map: `clearLayers()` + full rebuild on every feed refresh (`bravoMapHtml.ts:203-224`) — acceptable at refresh cadence, wasteful pattern.
  - Booking picker: the "pin" is a fixed CSS crosshair (`bravoLocationPickerMapHtml.ts:58-81`) — zero marker churn on pan. Genuinely smart choice.
- **Clustering:** no real clustering (no Mapbox `cluster: true` source anywhere). Two manual approximations: intel feed `clusterMarkers` bucketing (`IntelFeedScreen.tsx:101`) and static-image whole-degree bucketing capped at 30 pins (`news/mapbox.ts:45-60,96`). Adequate for current data volumes; not a scalable mechanism.
- **Marker images:** all CSS-drawn (dots, rings, cones) — no raster fetching, no image cache concerns. Infinite pulse/radar keyframe animations on every marker burn compositor continuously.
- **Selection/callouts:** ops console popups with `escapeHtml` (`BravoMap.tsx:60-67,378,391`) — safe. Mobile: taps post through the bridge and are handled natively (VBG `:104`, intel `markerPress`) — clean pattern.
- **Stale markers:** `BravoBookingMap` never re-pushes on `zones` prop change (`BravoBookingMap.tsx:33-38` — dead code today); `VbgKeyPointsMap` has the same class of bug **live** (see Critical/High).

---

# Route Audit

- **Two route stacks, wildly different maturity:**
  - **Agent tracker (good):** Directions response cached per target key; refetch only when off-route > 60 m with a 6 s throttle and in-flight guard (`AgentLiveTrackerScreen.tsx:525-530`); late responses dropped via `desiredTargetKeyRef` staleness check (`:545`); rising-edge "Re-routing" bubble (`:536,562`); route split into traveled/ahead at the live fix (`splitRouteAtProgress`, `mapboxDirections.ts:141`); `navActive` guard prevents the plain route writer from clobbering the nav route (`bravoAgentTrackerMapHtml.ts:361`); ETA counts down by remaining fraction (`:512-516`). This is near-industry-grade logic.
  - **Client LiveTracking (poor):** the same fix triggers **two** effects that both write the same `route` source — `setRoute` draws straight origin→dest lines (`bravoLiveRouteMapHtml.ts:162-167`), then `setNavRoute` overwrites with the real geometry (`:196-202`). **No `navActive` guard exists in this HTML** → visible straight-line flicker every fix. And the Directions cache key only tracks origin/dest (`LiveTrackingScreen.tsx:452`), so **there is no off-route detection at all** — if the vehicle deviates, the screen re-splits a stale route forever.
- **No traffic.** Profile is always `driving`; `driving-traffic` is never requested (`mapboxDirections.ts:266` + zero callers passing a profile). ETAs ignore congestion entirely — a first-order ETA-quality gap versus every benchmark app.
- **Geometry:** requested as `geometries=geojson` (no decode cost) in `mapboxDirections.ts:270`; the agent HTML separately carries a correct precision-6 polyline decoder for the server-supplied `route_polyline` (`bravoAgentTrackerMapHtml.ts:314-328`); ops console decodes precision-6 in `lib/polyline.ts` (clean, though decoded route coords are not NaN-filtered before hitting the LineString — low risk, server-generated).
- **Alternative routes (ops only):** fetched once, selectable — but **layers are fully torn down and rebuilt on every 2 s poll** because `altRoutes` is a fresh array each render (`BravoMap.tsx:240-334` deps; `live/[id]/page.tsx:334-344`). Handlers are correctly `off`'d (no leak) but it's flicker + wasted GL churn every 2 s.
- **`setData` is used consistently** for route updates on all surfaces (no remove/re-add of layers) — correct.
- **Perf note:** `nearestIndexOnRoute` is O(coords) and runs 3+ times per fix, plus once **per step** inside `nextManeuver` (`mapboxDirections.ts:161`) → O(steps·coords) per fix. Irrelevant at city scale, measurable on long inter-emirate routes.
- **Tests:** pure helpers well covered; `fetchDirections` has only the no-token test — no non-OK/malformed/abort coverage (`__tests__/mapboxDirections.test.ts:191-195`).

---

# Gesture Audit

- **All gestures are delegated to Mapbox GL JS / Leaflet inside the WebView.** Pan/pinch/rotate/double-tap work, with GL JS's own inertia and easing. But every touch first traverses RN's touch pipeline → WebView → Chromium input pipeline. This adds irreducible latency and occasional first-touch hitches versus native map SDKs; it is inherent to the architecture, not a code bug.
- **Gesture vs. camera arbitration is the real problem:** on the LiveOps map, user pans are simply overridden by the next `fitBounds` tick (Critical #2); on the ops console, `flyTo` overrides operator pans every poll (Critical #4). The agent tracker respects `dragstart` but never restores follow (High). Only the booking picker has a clean gesture story (map is fully user-owned; crosshair pattern).
- **No gesture conflicts with RN:** map WebViews are full-bleed; the agent screen's PanResponder bottom sheet (`AgentLiveTrackerScreen.tsx:643-665`) is outside the WebView. No nested-scroll fights observed in code.
- **Leaflet map:** thoughtful tuning — `zoomSnap: 0.25`, inertia parameters, `gesturestart` preventDefault to stop page-pinch fighting map-pinch (`bravoMapHtml.ts:128-153, 236-238`). Best-tuned gesture config in the repo, ironically on the least critical map.
- **No double-tap-drag zoom customization, no rotate-lock option, no two-finger pitch** (pitch is unused app-wide).

---

# Performance Audit

- **JS thread:** map rendering itself doesn't touch the RN JS thread (it's in the WebView process) — the RN thread's map cost is bridge injects (small strings, every 4–10 s) and screen re-renders. Not a bottleneck. The real cost centers:
  - **Timer population on `LiveTrackingScreen`:** up to five concurrent loops — 8 s sim interval, 5→60 s telemetry poll, booking-hydration poll (30-min capped), team poll, and a high-accuracy GPS watch — with **no `AppState` or navigation-focus gating** (grep: zero `useFocusEffect`/`useIsFocused` in map screens). Pushing SOS or Chat on top leaves all of it running; backgrounding the app leaves JS timers to the OS's mercy while the GPS watch keeps drawing power.
  - **Agent tracker:** 4 s `setInterval` poll IS `AppState`-gated (`AgentLiveTrackerScreen.tsx:342-346` — good) but not focus-gated, and the interval is torn down/recreated (with an extra immediate `refresh()`) every time `webReady`/`statusStale` flips (`:335-347`).
  - **Ops console:** 2 s poll → every 2 s: full marker-sync effect pass, route `setData`, alt-route teardown/rebuild, and a `flyTo`. The map is doing continuous unnecessary work at idle.
- **Bridge traffic:** modest by volume (single-fix JSON payloads). The design correctly avoids high-frequency bridge traffic — but only because updates are slow polls; there is no headroom for smooth 1 Hz+ tracking without interpolation moving into the WebView.
- **Memory:** each live map screen = one Chromium WebView instance + GL JS map (~120–250 MB working set on mid-range Android) on top of the RN app. Two map screens stacked (e.g., tracker → chat → back) keep it resident. Native SDK equivalents share a single GL context at a fraction of that.
- **Battery:** high-accuracy GPS watches with 5–10 s intervals during missions are appropriate for the product; the defect is the missing background/focus gating and the WebView+CDN stack keeping radios and compositor busier than a native map would.
- **CPU/GPU:** continuous CSS pulse/radar animations on all markers; per-frame `map.project` bubble re-anchoring; fitBounds animation storms — all avoidable GPU/compositor burn.
- **Network:** reverse-geocode fired on **every pan-stop** in the picker (180 ms debounce, `bravoLocationPickerMapHtml.ts:222-241`) plus one at startup — chatty and it costs Mapbox API quota; benchmark apps geocode on gesture-end with heavier debounce + client cache. Static map URLs rebuilt per render on the marketplace list (`JobMarketplaceScreen.tsx:139` — not memoized; `JobDetailScreen` memoizes correctly).
- **Dropped frames / jank:** inside-WebView panning is smooth by construction; observable jank comes from marker churn ticks, camera storms, and full map reboots (IntelFeed tab switch). RN-side, the intel screen re-renders every second from the clock `setInterval` (`IntelFeedScreen.tsx:176-180`) — cheap but pointless churn on a screen hosting a WebView.

---

# React Native Integration Audit

- **Memoization:** mostly correct where it matters — `html` strings are `useMemo`'d once (`LocationPickerScreen.tsx:69-82`, `LiveTrackingScreen.tsx:417`, `AgentLiveTrackerScreen.tsx:579-587`, `VbgKeyPointsMap.tsx:29`); `onMessage` handlers stable; the LiveTracking inject effects deliberately depend on primitive lat/lng with a comment documenting the prior object-dep injection-spam bug (`LiveTrackingScreen.tsx:419-424`) — good institutional memory in code.
- **The `source={{html}}` inline-object anti-pattern is universal** (4 screens) — see Architecture. One-line fix per screen (`useMemo(() => ({html}), [html])`), currently a latent reload bomb.
- **`useEffect` hygiene:** multiple `eslint-disable-next-line react-hooks/exhaustive-deps` in map effects (`LocationPickerScreen.tsx:81`, `LiveTrackingScreen.tsx:436,480`, `BravoMap.tsx:177`). Each is individually reasoned, but hand-managed dep arrays around injection effects are exactly where the `VbgKeyPointsMap` stale-data bug came from (missing effect entirely).
- **Prop-change propagation bugs:** `VbgKeyPointsMap` (live) and `BravoBookingMap` (dead) both push data only on load/ready and never on prop change — a systemic pattern error in the WebView-map wrappers.
- **Search effect over-subscription:** picker's suggest effect lists `pin.lng, pin.lat` in deps → re-subscribes on every pan even when search is closed (early-return saves the fetch, not the effect churn) (`LocationPickerScreen.tsx:104-170`).
- **Fetch cancellation:** `fetchDirections` supports `AbortSignal` but no caller passes one; VBG geocode/autocomplete fetches have **no AbortController** → stale-response races and setState-after-unmount potential (`VBGGeoRiskScreen.tsx:123-194`). The staleness is hand-guarded on the agent tracker only.
- **State managers:** Zustand slice subscription for live chat bubbles is clean and event-driven (`AgentLiveTrackerScreen.tsx:362-425`, dedupe via `seenMsgIds`). No Redux. No context misuse found.
- **New Architecture:** `newArchEnabled=true` + Hermes (`android/gradle.properties:43,47`). `react-native-webview` 13.15 is Fabric-compatible; since no native map view exists, Fabric/TurboModule considerations are moot for maps — but it also means the app gets **zero** benefit from Fabric's synchronous rendering for its most performance-critical surface.
- **WS telemetry is wired but wasted:** `useMissionEvents.onTelemetry` explicitly discards the pushed fix and just triggers another HTTP poll (`LiveTrackingScreen.tsx:322-329`). The sub-second-update transport exists and is thrown away.

---

# Offline Maps Audit

**Score: 0 — nothing exists.**

- No offline packs, no region downloads, no tile caching, no style caching, no service worker (grep-confirmed zero across all map HTML generators).
- WebView `cacheEnabled`/`cacheMode` unset on all map WebViews.
- GL JS itself, Leaflet, topojson-client, and the world-atlas basemap are all **runtime CDN fetches** — offline cold start = no map engine at all, not just no tiles.
- Only resilience: last-good route retained on Directions failure (`mapboxDirections.ts:280-283`), static-image style fallback for rate-limit (`news/mapbox.ts:117-119`), ops-console SVG grid fallback.
- For a **security/close-protection product** whose agents drive through connectivity dead zones, zero offline capability is a product-level gap, not just an engineering nicety. Note: offline tile packs are a native-SDK feature (`@rnmapbox/maps` `offlineManager`) — unreachable from the WebView architecture.

---

# Navigation Audit

Measured against turn-by-turn readiness (Uber driver app / Mapbox Navigation SDK baseline):

| Capability                                         | Status                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Route fetch + steps                                | ✅ `steps=true`, `banner_instructions=true` requested (`mapboxDirections.ts:270`)                |
| Maneuver extraction                                | ✅ `nextManeuver` with turn-now boundary (`mapboxDirections.ts:161`) — agent screen shows banner |
| Route progress / traveled split                    | ✅ agent + client (split at live fix)                                                            |
| ETA                                                | ⚠️ duration scaled by remaining fraction — **no traffic**, no re-fetch cadence                   |
| Off-route detection                                | ⚠️ agent only (60 m threshold); **absent on client live map**                                    |
| Rerouting                                          | ⚠️ agent only, 6 s throttle; client never reroutes                                               |
| Navigation camera (heading-up, pitched, auto-zoom) | ❌ none — top-down north-up only                                                                 |
| Voice guidance                                     | ❌ none (no TTS dependency in package.json)                                                      |
| Arrival detection                                  | ❌ none client-side (server mission states only)                                                 |
| Lane guidance / speed limits                       | ❌ none                                                                                          |
| Background navigation                              | ❌ impossible (no FGS, no iOS location background mode)                                          |

**Verdict:** ~30 % of a turn-by-turn stack exists, all of it on the agent tracker. This is "live tracking with a maneuver banner," not navigation. If turn-by-turn is on the roadmap, the Mapbox Navigation SDK requires the native-SDK migration anyway.

---

# Android Audit

- **WebView is the map renderer** — so TextureView/SurfaceView/`mapbox-gl` native concerns don't apply; instead the app inherits **WebView renderer-process risk with zero mitigation**: no `onRenderProcessGone` on any of the 6 map WebViews (grep-confirmed). On memory pressure Android kills the WebView renderer → permanent blank map until screen remount. This _will_ happen on low-RAM devices during missions.
- `androidLayerType="hardware"` set on all map WebViews — correct.
- **Manifest** (`android/app/src/main/AndroidManifest.xml`): FINE+COARSE+BACKGROUND location declared (L2-7); `FOREGROUND_SERVICE_LOCATION` declared (L32) **with no corresponding service** — Play policy exposure (see User Location). `usesCleartextTraffic="false"`, `allowBackup="false"` — good. No `largeHeap` (defensible), hardware acceleration default-on.
- **Build:** `newArchEnabled=true`, Hermes, targetSdk 36, four ABIs, `useLegacyPackaging=false` (`android/gradle.properties`). No Mapbox native artifacts anywhere (confirmed). `play-services-location` force-pinned 21.3.0 with an explanatory comment (`android/build.gradle:10-11,59`) — production-quality dependency hygiene.
- **Dead weight:** `react-native-maps` autolinks its Android module + pulls Play Services Maps transitively into every APK for zero usage.
- **Lifecycle/config changes:** Expo defaults; WebView state is lost on activity recreation and every map screen re-boots its map from scratch (no state restoration of camera/route — acceptable at current polish bar, but a visible reload on rotation/theme change).
- **Battery/OEM:** no battery-optimization exemption flow, no OEM (Xiaomi/Oppo) keep-alive guidance for the duty heartbeat — combined with the missing FGS this means duty tracking dies quickly on aggressive OEMs.

---

# iOS Audit

- **No `ios/` directory** — EAS prebuild only. Cannot audit a Podfile/Info.plist directly; `app.json` is the source of truth.
- `NSLocationWhenInUseUsageDescription` + `NSLocationAlwaysAndWhenInUseUsageDescription` present (`app.json:21-22`) — prompts will work.
- **Inconsistency:** code requests `'always'` authorization (`AgentDashboardScreen.tsx:273`, `PermissionsScreen.tsx:78`) but `UIBackgroundModes` = `["voip","audio","remote-notification"]` — **no `location`** (`app.json:26`). Background fixes will never be delivered; the Always prompt asks users for a permission the app cannot honor. Also an App Review flag risk (Always request without visible background-location feature).
- **Rendering:** maps run in WKWebView (WebKit, Metal-backed) — Mapbox GL JS is fine there, but `onContentProcessDidTerminate` is not handled → WKWebView content-process kill (common under memory pressure) blanks the map permanently.
- **Low-power mode / thermal:** no handling; GPS watch options are Android-flavored (`interval`/`fastestInterval` are ignored on iOS; `distanceFilter` applies) — acceptable but untuned.
- **Reality check:** all recent QA evidence in the repo (sqa.md, BlueStacks device matrix) is Android-only. The iOS map experience appears **untested in practice**. Treat every mobile finding in this audit as unverified-worse on iOS.

---

# Security Audit

**Good**

- No secret (`sk.`) tokens anywhere (grep-confirmed). Backend services read `MAPBOX_ACCESS_TOKEN` from env.
- Token injection into HTML uses `JSON.stringify` everywhere (no string-breakout).
- Ops console: `escapeHtml` on popup content; per-request-nonce CSP with a complete, correct Mapbox allowlist including `*.tiles.mapbox.com` and `worker-src blob:` (`middleware.ts:49,65-105`).
- No plaintext coordinate/key logging found in any map screen (grep-confirmed); VBG telemetry E2E-encrypted before POST.
- User input into geocode/search URLs is `encodeURIComponent`-wrapped at every call site.

**Findings**

1. **XSS sink, live (Medium-High):** the Leaflet intel map interpolates `t.label` (derived from **external news-feed data** — GDELT/NewsData location strings via `i.loc`) directly into marker `innerHTML` (`bravoMapHtml.ts:210-217`; fed from `IntelFeedScreen.tsx:98`). A crafted location string in a feed item executes JS inside a WebView that holds a `postMessage` bridge. Escape before interpolation.
2. **Latent XSS sinks:** agent tracker first-render `callsign` (server-supplied) into `innerHTML` (`bravoAgentTrackerMapHtml.ts:431-433`; later updates correctly use `textContent`); `label` into `innerHTML` in `nodeForSystem` (`:520` — constants today); orphaned booking map `z.label` (`bravoBookingMapHtml.ts:141-144`); raw numeric interpolation `center: [${lng}, ${lat}]` un-stringified (`bravoLocationPickerMapHtml.ts:127`).
3. **Token hygiene (Medium):** one public `pk.` token shared by mobile + ops + auth-service, committed to git in `.env.production:10`, `eas.json:30`, `package.json:14-16`, `.env.staging.local.example:25`. Public-token bundle exposure is unavoidable, but committing it plus reuse across all surfaces maximizes blast radius; URL restriction is account-side and unverifiable from source. Rotate, scope per-surface, restrict, and move out of committed files.
4. **Mapbox ToS exposure (Low-Medium):** attribution and the Mapbox logo are hidden on every mobile map (`bravoBookingMapHtml.ts:55`, `bravoLocationPickerMapHtml.ts:83`, `bravoLiveRouteMapHtml.ts:28`, plus `logo=false&attribution=false` on static images `news/mapbox.ts:155`). Mapbox's ToS requires attribution; this is a compliance risk for a commercial account.
5. **WebView posture (Low):** `originWhitelist={['*']}` on all 6 WebViews; `mixedContentMode="compatibility"` (needless — all content HTTPS) and `"always"` on IntelFeed (weakest); no `onShouldStartLoadWithRequest` navigation guards; intel map loads third-party CDN JS (unpkg/jsdelivr) — SRI present on Leaflet but **not** on topojson-client or the world-atlas fetch (supply-chain surface inside a bridged WebView).
6. **Token in URL query strings (Info):** Directions/Geocoding/Static Images all carry `access_token` in the query — standard for Mapbox but visible to any TLS-terminating proxy/CDN logs; static-image URLs with tokens flow through RN's image pipeline.
7. **Location privacy (Info):** user coordinates are sent to `api.mapbox.com` (reverse geocoding from picker WebView and VBG) — third-party disclosure worth a privacy-policy line; mission telemetry is TLS-only plaintext JSON to the backend (per architecture, acceptable).

---

# UX Audit

- **Loading states:** only IntelFeed (`startInLoadingState`) and the static-image screens have any. The booking picker, LiveOps map, agent tracker, and VBG map show a **silent dark void** while GL JS + style + tiles load over the network — first paint on cold cell connections will read as "broken" for seconds. Benchmark apps never show an unexplained blank.
- **Failure states:** worst finding — the booking picker has no `onError`/`renderError`/fallback: offline or token-less, the crosshair and Confirm button render over a **blank map**, the pin silently stays at the initial center (which is in-coverage), and the user can confirm a location they never saw (`LocationPickerScreen.tsx:302-314`). The static-image screens (`onError → fallback band`) prove the team knows the pattern.
- **Camera feel:** LiveOps yanks the camera every fix; ops console yanks every 2 s; agent follow dies on first pan with no recenter affordance. This is the #1 perceived-quality gap versus Uber/Careem.
- **Marker feel:** teleporting dots + restarting pulse animations read as glitchy versus interpolated gliding vehicles.
- **Stale-data honesty:** telemetry `recordedAt` is captured and discarded (`LiveTrackingScreen.tsx:130`) — the client shows a confident live dot even when the fix is minutes old. The agent tracker's "RECONNECTING…" after 3 failed polls (`AgentLiveTrackerScreen.tsx:180-183,707`) is the right pattern; it exists on one screen out of three.
- **Style/dark-mode:** dark-v11 default matches the obsidian design system well; picker has a 3-style cycler; ops has Dark/Streets/Satellite. Good. No system dark/light auto-switching (app is dark-only by design — acceptable).
- **Polish gaps:** no scale bar, no compass control, no accuracy ring around the user fix, heading cone dead, timeline pacing on LiveTracking is fake (`sim.idx` even when live, `LiveTrackingScreen.tsx:415`), fake GRID/MERCATOR HUD chrome on intel map (fun, harmless).
- **Consistency:** four different map look-and-feels (GL dark, Leaflet vector-fill, static PNGs, ops web) with different marker/interaction languages. Benchmark apps have one map identity.

---

# Scalability Review

**10,000 users — survivable with bruises.** Server does the heavy lifting (polylines, telemetry fan-out); client maps render ≤10 markers. The Mapbox API bill is the first pain point: reverse-geocode-per-pan on the picker, geocode-per-keystroke autocomplete (250 ms debounce, no session tokens on the VBG geocoding calls — the picker's Search Box correctly uses `session_token`), static images per marketplace card render, and Directions per off-route event — all on one shared token with no client-side caching layer. A single abusive/leaked token affects every surface at once.

**100,000 users — architecture starts costing real money and reviews.** Geocoding/static-image quota costs scale linearly with the chatty patterns above. WebView memory footprint drives OOM-kills and blank maps on the low-RAM Android fleet (no renderer-crash recovery = 1-star-review generator). Ops console polling (2 s × N operators × missions+detail+dashboard) needs the WS path it already half-has.

**1M+ users — not viable as built.** No offline, no tile-cost control (every session re-pulls tiles through the WebView with no shared cache), no map-feature flags, five divergent HTML map stacks to maintain, and the per-session Mapbox API consumption patterns above. The benchmark apps at this scale run native SDKs, aggressive tile caching, interpolation to hide 4-8 s server cadence, and server-side route caching. The migration (native SDK + shared map component + telemetry over WS) is a prerequisite, not an optimization.

**Maintainability:** the biggest scalability liability is internal — five hand-rolled map implementations where bug fixes demonstrably don't propagate (fitBounds guard, navActive guard, error reporting, resize guard each exist in exactly one HTML). Every new map feature currently costs 5×.

**Extensibility:** clean seams do exist — `mapboxDirections.ts` is a well-factored pure module, the bridge message pattern is consistent in shape, and the ops `BravoMap` is a proper reusable component. A consolidation has good raw material.

---

# Missing Industry Features

Standard in Google Maps / Uber / Lyft / Bolt / Grab / Careem; absent here:

**Motion & smoothness**

1. Marker position interpolation / animated vehicle glide between fixes (the #1 perceived-smoothness feature).
2. Animated user-location puck with accuracy ring and smooth heading rotation.
3. Bearing smoothing / compass fusion (heading is captured but never rendered; cone dead).
4. Predictive smoothing / Kalman filtering / GPS outlier rejection.
5. Snap-to-road for the vehicle dot (Uber snaps cars to the route polyline).
6. Camera interpolation queue (single owner arbitrating follow vs. gesture vs. reframe, with recenter affordance).

**Navigation** 7. Heading-up pitched navigation camera with auto-zoom by speed. 8. Voice guidance (TTS). 9. Live-traffic routing (`driving-traffic`) and traffic layer rendering. 10. Arrival detection and geofenced pickup/dropoff states. 11. Periodic ETA refresh (traffic-aware) rather than fraction-scaling a stale duration.

**Platform & resilience** 12. Offline maps / region packs / tile caching (requires native SDK). 13. Map render-process crash recovery (auto-reload on `onRenderProcessGone` / `onContentProcessDidTerminate`). 14. Loading skeletons and offline/error map states on every surface. 15. Background location via Android foreground service + iOS `location` background mode (declared, unbuilt). 16. Battery-adaptive location profiles (reduced cadence when stationary; significant-change mode). 17. Last-known-location persistence for instant cold-start centering.

**Map content** 18. Real marker clustering (source-level `cluster:true`) and marker virtualization for large datasets. 19. Route drawing animation (progressive polyline reveal on route set). 20. 3D buildings / terrain / custom brand style (using stock `dark-v11`; benchmark apps run bespoke styles). 21. Scale bar, compass reset control, attribution (required, currently hidden). 22. Session-token usage on all geocoding (only Search Box has it) + client-side geocode caching.

---

# Critical Issues

### C-1 — Entire mobile map stack is Mapbox GL JS inside WebViews

- **Description:** All interactive mobile maps run CDN-loaded Mapbox GL JS (or Leaflet) inside `react-native-webview`, bridged by hand-rolled `injectJavaScript`/`postMessage` protocols in five divergent HTML template files. No native map SDK exists; `react-native-maps` is installed but never imported.
- **Files involved:** `src/modules/booking/bravo*MapHtml.ts` (×4), `src/screens/vbg/vbgKeyPointsMapHtml.ts`, `src/modules/news/bravoMapHtml.ts`, all six host screens, `package.json:116,128`.
- **Severity:** Critical (architectural).
- **Risk:** Permanent ceiling on gesture latency, marker/camera animation quality, offline capability, crash recovery, memory, and battery. CDN outage or offline = no map engine at all. Blank-map failures already documented in the repo's own handoff notes.
- **Impact:** The stated product bar (Uber-grade smoothness) is unreachable; every polish investment in the current stack has a low ceiling.
- **Recommended Fix:** Adopt `@rnmapbox/maps` (native Mapbox SDK) behind ONE shared `BravoMapView` component; migrate surfaces incrementally (picker → agent tracker → live tracking → VBG); delete the five HTML stacks and `react-native-maps`. This also unlocks offline packs, the location puck, and the Navigation SDK path.
- **Priority:** P0 (strategic — start now, land incrementally).

### C-2 — LiveOps map: full marker teardown + `fitBounds` on every telemetry fix

- **Description:** `window.setRoute` removes and recreates origin/destination/vehicle markers and re-runs `fitBounds({duration:600})` on every call; RN calls it on every fix (5–8 s cadence). Vehicle teleports, pulse animation restarts, and any user pan/zoom is overridden within one tick. The sibling agent HTML already contains the correct pattern (`framedOnce`, `setLngLat`).
- **Files involved:** `src/modules/booking/bravoLiveRouteMapHtml.ts:143-176`; caller effects `src/screens/liveops/LiveTrackingScreen.tsx:425-443`.
- **Severity:** Critical.
- **Risk:** Client-facing flagship screen (customer watching their protection detail) feels broken/glitchy; users cannot inspect the map during an active mission.
- **Impact:** Direct, continuous, visible on every live booking.
- **Recommended Fix:** Port the agent HTML's state machine: create markers once, move via `setLngLat`, frame once (`framedOnce`), add follow flag + `dragstart` handler + recenter button.
- **Priority:** P0.

### C-3 — Two-writer route race on the client live map (route flicker)

- **Description:** Each fix triggers two RN effects: `setRoute` draws straight origin→dest placeholder lines into the `route` source, then `setNavRoute` overwrites them with real Directions geometry. The LiveOps HTML lacks the `navActive` ownership guard the agent HTML has — the route visibly flickers straight-line → real every fix.
- **Files involved:** `src/modules/booking/bravoLiveRouteMapHtml.ts:156-202` (no guard); `src/screens/liveops/LiveTrackingScreen.tsx:425-481` (both writers).
- **Severity:** Critical.
- **Risk:** Route appears unstable/untrustworthy on the customer's screen; combined with C-2 the screen visibly "breathes" every few seconds.
- **Impact:** Every live booking with a route.
- **Recommended Fix:** Copy the `navActive` guard from `bravoAgentTrackerMapHtml.ts:361` (one-line class of fix), or remove the straight-line writer once a nav route exists.
- **Priority:** P0.

### C-4 — Ops console camera re-centers every 2 s poll (operator camera hijack)

- **Description:** `flyTo` runs in an effect keyed on `center`, and every parent passes `center` as a fresh array literal per render; SWR polls every 2 s (missions/detail) / 5 s (dashboard), so the map animates back to the configured center continuously, overriding operator pan/zoom mid-investigation.
- **Files involved:** `apps/ops-console/src/components/BravoMap.tsx:403-406`; `apps/ops-console/src/app/live/page.tsx:98`, `app/dashboard/page.tsx:114`, `app/live/[id]/page.tsx:357-362`; poll intervals `src/lib/api.ts:990-991`.
- **Severity:** Critical.
- **Risk:** Ops operators cannot examine live missions — the tool fights its primary user during incidents (including SOS response).
- **Impact:** All three ops map pages, continuously.
- **Recommended Fix:** Memoize center (or compare values, not references) and fly only on genuine change; add a "follow" toggle for intentional re-centering. Same value-diff treatment for the alt-routes rebuild (`BravoMap.tsx:240-334`).
- **Priority:** P0 (small fix, large payoff).

### High issues (summary — full evidence in section bodies)

| ID  | Issue                                                                                                                                                                                                                                             | Files                                                                                 | Fix direction                                                                                     | Priority |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------- |
| H-1 | VBG map never re-pushes on prop change; second analysis shows first run's centre/points/radius (no remount, no `[centre,points,radiusKm]` effect)                                                                                                 | `src/screens/vbg/VbgKeyPointsMap.tsx:31-55`, `VBGGeoRiskScreen.tsx:363-375`           | Add push effect on props or `key` the component per analysis                                      | P1       |
| H-2 | No off-route detection/reroute on client live map — stale route re-split forever after deviation                                                                                                                                                  | `src/screens/liveops/LiveTrackingScreen.tsx:450-481`                                  | Port agent's `offRouteDistanceM > 60` refetch + staleness guard                                   | P1       |
| H-3 | Battery: ~5 timers + high-accuracy GPS watch, zero `AppState`/focus gating on LiveTrackingScreen (keeps burning under pushed screens & background)                                                                                                | `LiveTrackingScreen.tsx:77-151,191-231,245-308`                                       | Gate all loops on focus + AppState (pattern exists at `AgentLiveTrackerScreen.tsx:342-346`)       | P1       |
| H-4 | Zero WebView failure handling: no `onRenderProcessGone`/`onContentProcessDidTerminate`/`onError`/loading state on map surfaces; picker allows confirming over a blank map                                                                         | all 6 map WebViews; worst `LocationPickerScreen.tsx:302-314`                          | Add crash-reload + error fallback + loading skeleton to every map WebView                         | P1       |
| H-5 | Background location declared (manifest BACKGROUND + FGS_LOCATION; iOS 'always' requested) but unimplemented (no FGS service, no iOS `location` background mode, keep-alive TODO) — Play/App-Review policy risk + duty tracking dies in background | `AndroidManifest.xml:7,32`, `app.json:26`, `onDutyHeartbeat.ts:12-19,142-147`         | Either build the FGS + background mode, or remove the declarations/'always' request               | P1       |
| H-6 | XSS: external news-feed `label` interpolated into `innerHTML` in Leaflet map (live); latent `callsign`/`label` `innerHTML` sinks in agent HTML                                                                                                    | `bravoMapHtml.ts:210-217`, `bravoAgentTrackerMapHtml.ts:431-433,520`                  | Escape/`textContent` everywhere; lint rule against `innerHTML` in map HTML                        | P1       |
| H-7 | Token hygiene: shared pk. token committed to git ×4, reused across all surfaces, attribution hidden (ToS)                                                                                                                                         | `.env.production:10`, `eas.json:30`, `package.json:14-16`; CSS hides in all map HTMLs | Rotate; per-surface scoped tokens; account URL restrictions; restore attribution; move out of VCS | P1       |

### Medium issues (index)

M-1 push-telemetry no-op (WS fix discarded, re-polls) `LiveTrackingScreen.tsx:322-329` · M-2 follow never re-enables after drag, no recenter `bravoAgentTrackerMapHtml.ts:668` · M-3 `heading_deg` never sent — heading cone dead `AgentLiveTrackerScreen.tsx:458-461` · M-4 no GPS smoothing/outlier rejection anywhere · M-5 no `driving-traffic` profile — ETAs ignore congestion `mapboxDirections.ts:266` · M-6 `webReady` never reset after WebView reload — injects into blank map `AgentLiveTrackerScreen` · M-7 ops alt-routes torn down/rebuilt every 2 s `BravoMap.tsx:240-334` · M-8 GB/ZA regions have no coverage zones → picker opens on Dubai, Confirm never enables `regions.ts:21-27` vs `coverageZones.ts:21-35`, `LocationPickerScreen.tsx:52-53` · M-9 geocode fetches without AbortController (stale-response races) `VBGGeoRiskScreen.tsx:123-194` · M-10 reverse-geocode per pan-stop + startup (quota + chatter) `bravoLocationPickerMapHtml.ts:222-241` · M-11 duty-watcher/heartbeat errors swallowed (agent goes dark silently) `AgentDashboardScreen.tsx:311,316`, `onDutyHeartbeat.ts:90-96`.

### Low issues (index)

L-1 `source={{html}}` fresh object per render on all 4 GL WebViews (latent full-reload) · L-2 dead `react-native-maps` dependency `package.json:116` · L-3 orphaned `BravoBookingMap` + stale double-push/no-prop-effect bugs inside it · L-4 IntelFeed map destroyed/rebooted on every tab switch + `mixedContentMode="always"` + un-SRI'd CDN fetches · L-5 marketplace static-map URL not memoized `JobMarketplaceScreen.tsx:139` · L-6 waypoint bubble permanently dropped when coords null (`seenWaypoints.add` before null check) `AgentLiveTrackerScreen.tsx:303,309` · L-7 GL JS version skew 3.7.0 (mobile) vs 3.9.0 (web) · L-8 `recordedAt` captured but no stale-fix indicator `LiveTrackingScreen.tsx:130` · L-9 raw numeric interpolation into picker HTML `center:[${lng},${lat}]` `bravoLocationPickerMapHtml.ts:127`.

---

# Performance Metrics

Static-analysis estimates (no on-device profiling performed; Android mid-range reference device):

| Metric                         | Estimate                                      | Notes                                                                                                                                     |
| ------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Estimated FPS (map canvas)** | 45–60 idle pan; **20–40 during update ticks** | GL JS in WebView pans smoothly; marker churn + fitBounds storms + pulse animations dent it every fix                                      |
| **Estimated Memory**           | +120–250 MB per mounted map WebView           | Chromium renderer + GL JS heap + tiles; stacked screens keep it resident                                                                  |
| **Estimated CPU**              | Low idle / spiky per tick                     | Poll → JSON → inject → DOM churn → GL reframe every 2–10 s per surface                                                                    |
| **Estimated GPU**              | Moderate, continuous                          | Infinite CSS pulse/radar animations on all markers; per-frame bubble re-projection                                                        |
| **Bridge Load**                | Low volume, low frequency (4–10 s injects)    | Well designed for polling; no headroom for 1 Hz+ smooth tracking without in-WebView interpolation                                         |
| **Rendering Efficiency**       | 4/10                                          | `setData` used well; negated by marker rebuild storms and full map reboots (tab switch, activity recreation)                              |
| **Re-render Score**            | 5/10                                          | Good primitive-dep discipline in places; `source={{html}}` identity trap universal; ops-side unstable array props drive 2 s effect storms |
| **Animation Score**            | 2/10                                          | Zero marker interpolation, zero route animation, dead heading; only camera easing exists                                                  |
| **Camera Smoothness Score**    | 2/10                                          | Individual animations smooth; ownership model broken (fitBounds/flyTo fighting) on 2 of 3 live surfaces + ops                             |
| **Map Responsiveness Score**   | 5/10                                          | In-map gestures OK (WebView-inherent latency aside); programmatic camera overrides destroy perceived responsiveness                       |

---

# Final Scorecard

| Area                     | Score      | One-line justification                                                                                       |
| ------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------ |
| Architecture             | **3/10**   | WebView GL JS everywhere, 5 divergent HTML stacks, dead native-SDK dependency, orphaned components           |
| Rendering                | **4/10**   | setData discipline is good; CDN-dependent engine, no crash recovery, blank-map failure modes                 |
| Camera                   | **2/10**   | fitBounds/flyTo fights on 3 surfaces; one-way follow; no ownership model                                     |
| Location                 | **4/10**   | Clean permissions/teardown, anti-spoof signals; no smoothing, dead heading, phantom background location      |
| Markers                  | **3/10**   | Teleports everywhere, full-rebuild storms on LiveOps; ops-console diffing is the lone bright spot            |
| Routes                   | **5/10**   | Agent stack is near-industry-grade; client stack flickers and never reroutes; no traffic                     |
| Gestures                 | **4/10**   | GL JS gestures fine but WebView-latent; camera arbitration broken                                            |
| Performance              | **3/10**   | Timer sprawl without focus gating, WebView memory tax, avoidable churn every tick                            |
| React Native             | **5/10**   | Real memoization discipline and documented past fixes; systemic source-identity and prop-push gaps           |
| Android                  | **4/10**   | Solid build hygiene (Hermes, new-arch, pinned play-services); zero WebView-crash story, policy-risk manifest |
| iOS                      | **3/10**   | Managed-only, permission/background-mode mismatch, effectively untested                                      |
| Security                 | **5/10**   | No secret keys, safe token injection, strong web CSP; live XSS sink, committed token, hidden attribution     |
| UX                       | **3/10**   | Dark-void loading, blank-map confirms, camera hijacks, teleporting dots; style choices themselves are good   |
| Scalability              | **4/10**   | Server-heavy design helps; API-cost patterns, WebView memory, and 5× maintenance kill it at scale            |
| **Production Readiness** | **3/10**   | Ships and works in demos; fails the stated Uber/Google-Maps bar structurally                                 |
| **Overall**              | **42/100** |                                                                                                              |

## Bottom line

The team has built real, working live-tracking features with some genuinely sophisticated pieces (the agent tracker's route state machine, the ops marker differ, the backoff polling). But the map layer is five hand-rolled WebView implementations of the same product at five different maturity levels, sitting on an architecture that cannot deliver the smoothness bar this audit was asked to measure against. The highest-leverage sequence: **(1)** land the four P0 camera/marker fixes inside the current stack (days, massive perceived-quality gain), **(2)** fix the P1 correctness/safety items (VBG staleness, blank-map confirm, background-location policy exposure, XSS escape), **(3)** begin the native-SDK (`@rnmapbox/maps`) migration behind a single shared map component — because every remaining item on the "missing industry features" list is either impossible or uneconomical in WebViews.

_Audit complete. No code was modified._

---

# Remediation Status — 2026-07-04

All code-fixable findings were remediated in a single batch (see `docs/planning/BUILD_RUNBOOK.md` → "Remediation batch 2026-07-04"). Status per finding:

| Finding                                      | Status                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1 WebView architecture                     | **Open (strategic)** — requires the `@rnmapbox/maps` native-SDK migration; all other fixes raise quality within the current stack                                                                                                                                                                                       |
| C-2 LiveOps marker rebuild + fitBounds storm | **Fixed** — create-once markers, rAF glide, frame-once + recenter pill                                                                                                                                                                                                                                                  |
| C-3 Two-writer route flicker                 | **Fixed** — `navActive` guard ported to the LiveOps HTML                                                                                                                                                                                                                                                                |
| C-4 Ops-console flyTo hijack                 | **Fixed** — value-diffed flyTo + memoized centers/routes upstream                                                                                                                                                                                                                                                       |
| H-1 VBG stale data                           | **Fixed** — props re-pushed on change + crash remount                                                                                                                                                                                                                                                                   |
| H-2 No off-route reroute (client map)        | **Fixed** — 60 m off-route reroute from the live fix (real fixes only)                                                                                                                                                                                                                                                  |
| H-3 Battery/timer sprawl                     | **Fixed** — all LiveTracking polls + GPS watch gated on focus + AppState                                                                                                                                                                                                                                                |
| H-4 No WebView failure handling              | **Fixed** — crash-remount handlers on all live map surfaces; picker adds loading/failed overlays and a ready-gated Confirm                                                                                                                                                                                              |
| H-5 Background location declared but unbuilt | **Open by product decision** — declarations + iOS `always` kept (user call); risk closes when the location FGS + iOS background mode are built                                                                                                                                                                          |
| H-6 XSS sinks                                | **Fixed** — intel-map labels escaped; agent-tracker callsign/label via `textContent`                                                                                                                                                                                                                                    |
| H-7 Token hygiene / attribution              | **Partially fixed** — inline tokens removed from `package.json` scripts, example env sanitized, attribution restored on all GL maps + static images. **Open:** rotate + URL-restrict the token in the Mapbox dashboard; move out of committed `.env.production`/`eas.json` (EAS secrets); git history still contains it |
| M-1 WS telemetry discarded                   | **Fixed** — pushed fix feeds the map (newest of WS/poll wins)                                                                                                                                                                                                                                                           |
| M-2 One-way follow                           | **Fixed** — "⌖ Follow" pill re-enables                                                                                                                                                                                                                                                                                  |
| M-3 Dead heading cone                        | **Client fixed** — `heading_deg` passes through when present. **Open:** backend must return `current_heading_deg` on deployment/live reads                                                                                                                                                                              |
| M-4 No GPS smoothing                         | **Partially fixed** — visual glide on all live markers; no Kalman/outlier filter (needs design + device tuning)                                                                                                                                                                                                         |
| M-5 No traffic profile                       | **Fixed** — `driving-traffic` default + URL test                                                                                                                                                                                                                                                                        |
| M-6 webReady never reset                     | **Fixed** — reset on load-start + crash remount                                                                                                                                                                                                                                                                         |
| M-7 Ops alt-route churn                      | **Fixed** — content-signature guard + upstream memoization                                                                                                                                                                                                                                                              |
| M-8 GB/ZA coverage gap                       | **UX fixed** — explicit "NOT AVAILABLE IN THIS REGION" state. **Open:** actual GB/ZA coverage zones are business data                                                                                                                                                                                                   |
| M-9 Geocode races                            | **Fixed** — AbortController + alive guards                                                                                                                                                                                                                                                                              |
| M-10 Geocode per pan-stop                    | **Fixed** — 350 ms debounce + <25 m reuse cache                                                                                                                                                                                                                                                                         |
| M-11 Swallowed GPS errors                    | **Fixed** — error codes now logged (no coords)                                                                                                                                                                                                                                                                          |
| L-1 source identity                          | **Fixed** on all four GL WebViews + intel map                                                                                                                                                                                                                                                                           |
| L-2 react-native-maps dead dep               | **Fixed** — removed, lockfile synced                                                                                                                                                                                                                                                                                    |
| L-3 Orphaned BravoBookingMap                 | **Fixed** — deleted                                                                                                                                                                                                                                                                                                     |
| L-4 IntelFeed remount/mixed-content          | **Fixed** — keep-mounted + compatibility mode                                                                                                                                                                                                                                                                           |
| L-5 Marketplace URL memo                     | **Fixed**                                                                                                                                                                                                                                                                                                               |
| L-6 Waypoint drop                            | **Fixed** — seen-set marked only after bubbling                                                                                                                                                                                                                                                                         |
| L-7 GL JS version skew                       | **Fixed** — all mobile HTML on 3.9.0 (matches web). Needs device smoke                                                                                                                                                                                                                                                  |
| L-8 No staleness indicator                   | **Fixed** — "Telemetry delayed" banner >45 s                                                                                                                                                                                                                                                                            |
| L-9 Raw numeric interpolation                | **Fixed** — JSON.stringify'd center                                                                                                                                                                                                                                                                                     |

**Verification:** mobile typecheck 46 errors before and after (all pre-existing baseline); ops-console typecheck + lint clean; changed-file eslint clean; full Jest run 182 suites / 1642 tests green. On-device smoke of the six map surfaces (GL JS 3.9.0 bump, recenter pills, marker glide, picker overlays) is still required — no device/emulator was attached during remediation.
