# Map · GPS · Directions Audit — "maps should perfectly work" · 2026-07-16

**Trigger (founder):** "audit the map — it should perfectly work with location (GPS) and the
direction route should work."
**Scope:** all map surfaces (mobile WebView Mapbox GL v3.9.0, IntelFeed Leaflet, Job static
images, ops-console), the full GPS pipeline (permissions → acquisition → publish → consume),
and the directions/route layer (client + CPO + ops + backend precompute).
**Status:** **FIXED 2026-07-16 (same day)** — MG-01..MG-16 + P3s remediated (only actual
token ROTATION (MG-09, needs the Mapbox dashboard) and the is_mocked live-feed flag (P3-C,
needs a DB migration) deferred — see §fix log at EOF and the B-89 UPDATE in `sqa.md`.
Server fixes deploy with the push (CI → Contabo). Logged as **B-89** in `sqa.md`.

**Baseline:** the B-77 blank-map fix (2026-07-11) is REAL and wired — 15 s watchdog + one
auto-remount + RETRY overlay + renderer-crash recovery on all 4 operational GL maps
(`src/modules/maps/useMapReload.ts`, `MapFailedOverlay.tsx`). The route line itself (Mapbox
Directions `driving-traffic`, traveled/remaining split, 60 m-deviation reroute, counting-down
ETA, straight-line fallback, pickup→dropoff leg switching) genuinely works on client, CPO and
ops surfaces. What follows is what does NOT work.

---

## P1 — broken end-to-end (each hand-verified at every link)

### MG-01 · The CLIENT's live map never shows the real CPO — it animates a SIMULATED dot all mission

The paying principal watches fake motion. Verified chain:

1. Client polls `GET /telemetry/:bookingId/latest` (`api.ts:1723`, `LiveTrackingScreen.tsx:121`)
   → `TelemetryService.latest` reads Redis stream `telemetry:{bookingId}` + single-row
   `mission_telemetry_last` fallback (`telemetry.service.ts:21-22,130`).
2. The ONLY writer of those stores is `TelemetryService.ping` — reachable solely via
   `POST /telemetry/:bookingId/ping` (`telemetry.controller.ts:38`) — and **the mobile app
   never calls `telemetryApi.ping`** (grep: zero callers). The other historical writer,
   `MissionService.updateTelemetry`, lost its route (`ops.controller.ts:393-395` — removed by
   design, audit fix 1.3).
3. The REAL CPO push (`POST /agents/me/missions/:id/telemetry` →
   `MissionLeadService.pushTelemetry`, `mission-lead.service.ts:175-193`) writes
   `mission_telemetry` history + `missions.current_lat/lng` — and **never**
   `mission_telemetry_last`, **never** Redis, **never** `events.telemetryFix`.
4. `MissionEventsService.telemetryFix` (`mission-events.service.ts:79`, the `mission.telemetry`
   WS frame) has **zero callers** — the client's already-wired WS subscription
   (`LiveTrackingScreen.tsx:379`) can never fire.
5. So `realFix` is null and the screen renders `sim.vehicle` — a canned straight-line
   pickup→dropoff interpolation with an invented ETA (`LiveTrackingScreen.tsx:67-96,469-476`).
   The Directions route is then split at that off-road fake point.

Ops and the CPO tracker are unaffected (they read `missions.current_*`, which IS updated).
`docs/planning/BATCH_FIX_AND_FEATURE_PLAN.md:91` already lists the intended fix, never done.

**Fix direction (small + localized):** in `pushTelemetry`, after the `missions.current_*`
UPDATE: UPSERT `mission_telemetry_last` (booking-keyed) + XADD the Redis stream (reuse the
`TelemetryService.ping` write path) + call `events.telemetryFix(missionId, fix, booking_id)`.
Client WS + poll + newest-wins logic all work the moment the server emits. Also badge or
freeze the pre-first-fix state instead of fake motion (see MG-07).

### MG-02 · Heading is dead end-to-end — the CPO marker's direction cone never rotates

- DB column `missions.heading_deg` IS written on every push (`mission.service.ts:329`,
  `mission-lead.service.ts:186-187`).
- But the crew deployment SELECT (`agent.service.ts:1165-1170`) and org monitor SELECT
  (`org-mission.service.ts:191-195`) **do not select any heading column**, while the client
  reads `current_heading_deg` (`api.ts:618`, `AgentLiveTrackerScreen.tsx:266`) — always
  `undefined` → cone stays at `rotate(0deg)` (`bravoAgentTrackerMapHtml.ts:520-523`).
- Capture is also unreliable: the device only sends heading when the OS reports a course ≥0
  (`useLeadTelemetry.ts:46-47`); stationary devices report −1/null and there is **no
  server-side bearing derivation** from consecutive fixes.

**Fix direction:** `heading_deg AS current_heading_deg` in both live SELECTs; derive bearing
server-side from previous→current fix in `pushTelemetry` when the device value is null
(`bearingDeg` helper already exists in `mapbox-directions.service.ts:179`). Client rotation
code works as-is once a value arrives. (3rd audit to flag this — `docs/audits/MAPBOX_AUDIT.md:452` M-3.)

### MG-03 · No background tracking — CPO GPS stops the moment the phone is pocketed

`onDutyHeartbeat.ts:142-147` foreground-service keep-alive is a **TODO no-op**;
`useLeadTelemetry.ts:14` + `vbgTelemetry.ts:11-13` document that Android suspends the watcher

- timers when backgrounded. `FOREGROUND_SERVICE_LOCATION` + `ACCESS_BACKGROUND_LOCATION` are
  declared in `app.json:42,55` but no service is ever started and background permission is never
  requested. For a close-protection product, live tracking that only works with the screen on is
  an operational hazard. **Fix direction:** a `FOREGROUND_SERVICE_LOCATION` foreground service
  (notifee `registerForegroundService`) wrapping the mission watcher, started at go-live;
  request background permission at that point. NATIVE + permission-flow work → needs a build +
  device pass; schedule deliberately.

### MG-04 · Production builds have no guaranteed Mapbox token — and a tokenless build defeats the B-77 recovery

Verified: `eas.json` `production` AND `preview-staging-device` profiles have **no env block**
(only `preview-staging` pins `EXPO_PUBLIC_MAPBOX_TOKEN`); the `apk:staging`/`apk:dist` scripts
pass API/Supabase vars inline but omit the Mapbox token (`package.json:14,16`). Today's builds
work ONLY because git-tracked `.env.production:10` carries the token through the dotenv →
`expo export:embed` path — the exact mechanism that previously broke API-base-URL baking.
A tokenless build renders `mapboxgl.accessToken=""` → 401 → no `ready` → watchdog → RETRY →
same tokenless HTML → **infinite retry loop**, indistinguishable from "no internet" (no boot
assertion, no misconfigured-build state). **Fix direction:** pin the token in the
`production`/`preview-staging-device` env blocks + apk scripts; assert non-empty at boot and
show a distinct "map unavailable — build misconfiguration" overlay.

---

## P2

| ID    | Finding                                                                                                                                                                                   | Evidence                                                                                                                          | Fix direction                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| MG-05 | GPS-off is silent: both live watchers set `showLocationDialog:false` and every error callback is empty — location services off = frozen map, no prompt                                    | `LiveTrackingScreen.tsx:357`, `MissionLeadConsoleScreen.tsx:194`                                                                  | Detect `POSITION_UNAVAILABLE` → "Enable location services" prompt             |
| MG-06 | Android 12+ "Approximate" grant undetected — every site requests FINE only and treats a coarse grant as full success                                                                      | all request sites (`PermissionsScreen.tsx:52`, `useLocation.ts:24`, …)                                                            | Request FINE+COARSE, detect coarse-only, prompt for precise                   |
| MG-07 | Client shows unbadged FAKE motion + invented ETA until the first real fix (post-MG-01 this still applies pre-first-fix)                                                                   | `LiveTrackingScreen.tsx:67-96,474-476`                                                                                            | Freeze dot at pickup until first real fix, or badge "awaiting live GPS"       |
| MG-08 | CPO tracker: `navActive` latches true forever → after turn-by-turn starts, a failed Directions refresh on a NEW leg leaves the stale previous-leg line under "Navigation unavailable"     | `bravoAgentTrackerMapHtml.ts:444` vs correct client impl `bravoLiveRouteMapHtml.ts:360`                                           | `navActive = features.length > 0` (one line)                                  |
| MG-09 | One shared, git-committed, unrotated `pk.` token across mobile/ops/backend (3rd audit flag); Directions quota rides the same token — any 401/429 degrades every surface at once, silently | `.env.production:10`, `eas.json:30`, `apps/ops-console/.env.local:6`, `apps/auth-service/.env:77`                                 | Rotate; per-consumer tokens w/ URL scopes; EAS secrets; purge from git        |
| MG-10 | IntelFeed Leaflet map has ZERO recovery (only surface the B-77 fix skipped): no onError/onRenderProcessGone/watchdog; CDN-blocked or renderer-kill = permanent blank                      | `IntelFeedScreen.tsx:276-301`, engine from unpkg/jsdelivr                                                                         | Apply `useMapReload` + `MapFailedOverlay` pattern                             |
| MG-11 | GL `error` events not consumed → invalid token vs offline indistinguishable; definite boot failures still wait ~30 s (15 s watchdog ×2) for RETRY                                         | `bravoLiveRouteMapHtml.ts:186` posts `err`, `LiveTrackingScreen.tsx:573-576` ignores; agent/picker HTML have no `map.on('error')` | Fast-fail pre-`ready` `err` posts into `map.onError()`; distinct overlay copy |
| MG-12 | Weak coordinate validation: `clientPing` is typeof-only (no finite/range/0,0 guard); map HTML `setRoute`/`setCpo`/`setPrincipal` accept (0,0) → null-island teleports                     | `telemetry.controller.ts:61`, `bravoAgentTrackerMapHtml.ts:504,541`, `bravoLiveRouteMapHtml.ts:283-289`                           | Finite+range+(0,0) rejection at ingest + render                               |
| MG-13 | No accuracy/outlier gating (M-4, still open): raw fixes hit the map; the >0.05° "snap" HIDES genuine teleports rather than rejecting them                                                 | `bravoLiveRouteMapHtml.ts:258-281`                                                                                                | Accuracy gate + speed-plausibility rejection server- or client-side           |
| MG-14 | Accuracy captured but never rendered — no confidence circle, client DTO doesn't even carry it                                                                                             | `api.ts:1674` (`TelemetryFixDto`)                                                                                                 | Plumb accuracy; draw confidence circle / grey stale-poor fixes                |
| MG-15 | No ops-side "lost signal": LIVE missions with minutes-old fixes render normally (client has its 45 s banner; ops/tracker don't dim)                                                       | sqa.md:1139 follow-up unfixed                                                                                                     | Dim/badge by last-fix age on ops live + tracker                               |
| MG-16 | iOS onboarding requests `always` location with no background impl — most-denied prompt + App-Store review risk                                                                            | `PermissionsScreen.tsx:78`                                                                                                        | Downgrade to `whenInUse` until MG-03 ships                                    |

## P3

Loading skeletons missing on LiveTracking/AgentTracker/VBG (dark void up to 15 s; only picker

- IntelFeed have spinners) · no offline banner/cache on any map WebView (NetInfo installed,
  unused there) · unguarded `new mapboxgl.Map()` (WebGL-unsupported throws pre-postMessage;
  watchdog masks it slowly) · `useLeadTelemetry` watcher not AppState-gated + can double-run
  with the console watcher (duplicate rows) · mock-location flagged only on the duty heartbeat,
  not the live mission feed · dead code: `telemetryApi.ping` + `MissionService.updateTelemetry`
  (the severed writers from MG-01 — rewire or delete) · client Directions uses the pricier
  `driving-traffic` profile per reroute on the shared token · native-SDK migration
  (`@rnmapbox/maps`) remains the strategic ceiling (offline tiles, real location puck).

---

## What already works (verified — do not re-fix)

- **B-77 recovery is real**: watchdog + auto-remount + RETRY + renderer-crash handlers on all
  4 operational GL maps; picker additionally gates Confirm on `ready` with loading/failed
  overlays; injection is `webReady`-gated and try/catch-safe; GL v3.9.0 pinned everywhere;
  token injected via `JSON.stringify` (XSS closed); `react-native-maps` dead dep removed.
- **Directions/route layer**: real road-following polylines on all three live surfaces;
  traveled/remaining split at the vehicle; off-route reroute (perpendicular distance, 6 s
  throttle, "Re-routing" bubble); counting-down ETA; leg switch pickup→dropoff on mission
  stage; straight-line fallback so a Directions outage never blanks the map; backend
  precompute with alternatives + haversine fallback; pure geo helpers unit-tested.
- **GPS hygiene**: watches cleared on unmount everywhere; client watchers focus+AppState
  gated; B-80 stationary-lead heartbeat keeps the dot fresh; SOS fires even when the fix
  fails; honest staleness banners on client ("Telemetry delayed") and CPO ("GPS not reaching
  Ops"); server-side range/finite validation on the CPO push path; Settings deep-link on
  blocked permission.

## Suggested fix order (when approved)

1. **MG-01** — mirror the CPO push to `mission_telemetry_last`/Redis + emit `mission.telemetry`
   (server, ~20 lines; instantly makes the client map real) + MG-07 badge/freeze.
2. **MG-02** — heading SELECTs + server-side bearing derivation (server, small).
3. **MG-04** — token pinning in EAS/apk scripts + boot assertion (config).
4. **MG-08** (one line), **MG-11/MG-12** (fast-fail + coord guards), **MG-05/MG-06**
   (GPS-off + approximate detection), **MG-10** (IntelFeed recovery), **MG-15**.
5. **MG-03** — foreground service (native + permissions; needs build + device pass).
6. **MG-09** — token rotation/split (ops action, coordinate with deploys).

Note deploy surface: MG-01/02 are `auth-service` changes → Contabo deploy; MG-04 is
build-config; the rest are client-side.

---

## Fix log — 2026-07-16 (same day, "fix all and push")

| Finding            | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MG-01**          | `MissionLeadService.pushTelemetry` now mirrors every fix into the client stores (`TelemetryService.ping`: Redis stream + `mission_telemetry_last`, booking-keyed, with ETA computed from `route_duration_s × remaining-fraction`) **and emits `mission.telemetry`** (first-ever caller of `MissionEventsService.telemetryFix`), carrying heading/speed/accuracy/eta. Mirror is best-effort (never fails the CPO push). Client WS/poll paths light up unchanged. Spec: `mission-lead.telemetry-mirror.spec.ts` (9). |
| **MG-02**          | `heading_deg AS current_heading_deg` in both live SELECTs (`agent.service.ts`, `org-mission.service.ts`) + **server-side bearing derivation** from prev→current fix (≥8 m movement, exported `bearingDeg`) when the device reports no course — written to history, `missions`, the mirror and the WS frame. The tracker cone rotates with zero client changes.                                                                                                                                                     |
| **MG-03**          | Real foreground service: `src/modules/agent/missionForegroundService.ts` (notifee runner registered at bundle entry; persistent low-importance "Mission tracking active" notification with `FOREGROUND_SERVICE_TYPE_LOCATION`), manifest merge adds `foregroundServiceType="location"` to notifee's service (Android 14+ requirement), started/stopped by `useLeadTelemetry` with the watcher — CPO GPS now survives screen-off/backgrounding. **Needs the next APK + device verify** (screen-off soak).           |
| **MG-04**          | Token pinned in `eas.json` `production` + `preview-staging-device` env and both `apk:*` scripts; new `src/modules/maps/mapToken.ts` single source (+ boot breadcrumb); every GL surface renders a distinct **"build packaged without a map key"** overlay instead of mounting a doomed WebView into the RETRY loop.                                                                                                                                                                                                |
| **MG-05**          | GPS-off is loud: live watchers use `showLocationDialog: true` + error callbacks detect `POSITION_UNAVAILABLE`/settings errors → one-per-session branded prompt with a jump to the system Location settings (client LiveTracking + CPO console).                                                                                                                                                                                                                                                                    |
| **MG-06**          | `requestPreciseLocation` (FINE+COARSE together, Android 12+ contract) detects an approximate-only grant and prompts for precise; used at onboarding (PermissionsScreen) and inside the live re-ask flow.                                                                                                                                                                                                                                                                                                           |
| **Founder add-on** | **On LIVE, missing GPS access is re-asked**: `ensureLiveLocationAccess` (branded rationale → system re-request → Open Settings when OS-blocked), re-armed on every screen refocus while the mission is live. Wired into client LiveTracking + CPO MissionLeadConsole.                                                                                                                                                                                                                                              |
| **MG-07**          | Simulated telemetry DELETED. Pre-first-fix: dot frozen at pickup + "Awaiting live GPS" banner + `AWAITING LIVE GPS` map chip; ETA/progress never invented; timeline `arrived` now tracks the mission FSM.                                                                                                                                                                                                                                                                                                          |
| **MG-08**          | Tracker HTML `navActive = features.length > 0` (un-latched) + base-line redraw when nav geometry empties — no more stale previous-leg route under "Navigation unavailable".                                                                                                                                                                                                                                                                                                                                        |
| **MG-11**          | All four GL surfaces post `err` (incl. NEW `map.on('error')` on the tracker + constructor try/catch on all builders) and the RN side fast-fails pre-ready posts into the watchdog reducer — definite boot failures surface in ~1 s instead of ~30 s. Loading overlays added to the three screens that had none.                                                                                                                                                                                                    |
| **MG-12**          | Ingest + render coordinate guards: `clientPing` rejects non-finite/out-of-range/(0,0); `validLL` in both tracker HTMLs (setRoute/setCpo/setPrincipal) refuses null-island payloads (posts a non-fatal `warn`).                                                                                                                                                                                                                                                                                                     |
| **MG-13**          | `src/utils/gpsPlausibility.ts` (`acceptGpsFix`: validity + ≤150 m accuracy + ≤70 m/s implied speed; 6 tests) gates BOTH the WS and poll fix paths on the client tracker.                                                                                                                                                                                                                                                                                                                                           |
| **MG-14**          | Accuracy rides the WS frame → `setVehicleAccuracy` draws a true-meter cobalt confidence circle under the vehicle dot (48-point polygon, reapplied across style swaps).                                                                                                                                                                                                                                                                                                                                             |
| **MG-15**          | Ops `/live/[id]`: `missions.updated_at` (bumped by every push) exposed through the API types → `LOST SIGNAL <age>` badge >90 s and a greyed standby marker >5 min on active missions.                                                                                                                                                                                                                                                                                                                              |
| **MG-16**          | iOS onboarding location request downgraded `always` → `whenInUse`.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **P3s**            | Unguarded `new mapboxgl.Map` fixed everywhere; IntelFeed Leaflet map got the full `useMapReload` + renderer-crash + RETRY treatment (MG-10); dead `telemetryApi.ping` removed; `MissionService.updateTelemetry` marked deprecated (unrouted, spec-covered).                                                                                                                                                                                                                                                        |

**Deferred (explicit):** MG-09 token rotation/split — requires the Mapbox dashboard (ops
action; everything code-side is ready for a new token via env). P3-C `is_mocked` on the live
mission feed — needs a `mission_telemetry` migration; follow-up.

**Gates:** mobile eslint 0 errors (19 files) · tsc signatures identical to main (46) · jest
231 suites / 2024 tests (only the 2 known pre-existing failures) incl. booking project
(LITE_BOOKING_LOOP automated gate) + 15 new tests · auth-service tsc clean + 54/54 targeted
specs (mirror, deployment, mission, telemetry, finish, plausibility) · ops-console typecheck +
eslint clean · adversarial review pass pre-push. **Device-verify pending:** notification-tap →
live map shows the REAL dot moving; heading cone rotates; screen-off soak with the FGS
notification present; GPS-off prompt; approximate-grant prompt; misconfig overlay (build w/o
token); ops LOST SIGNAL badge.

**Adversarial review pass (pre-push):** 2 MAJORs + 5 minors CONFIRMED and fixed same-session —
M-1 the ops LOST-SIGNAL badge never re-rendered once the feed froze (SWR payload stops
changing → added the 15 s tick the mobile screen already used); M-2 the mission FGS start/stop
raced (unserialized async → an early stop could leak the service, an A→B switch could kill B's
service; now a serialized op chain with generation tokens, A→B hands the service over
seamlessly); m-1 one bounded FGS re-arm on transient start failure; m-2 fast-fail filtered to
FATAL boot errors only (init/401/403/gl-unsupported — pre-load tile blips no longer burn the
auto-retry); m-3 the tracker now pushes an EMPTY nav frame when Directions is unavailable for a
new leg (the un-latch was unreachable); m-4 accuracy-circle clear path; m-5 the picker consumes
the constructor fast-fail; m-7 the console overlay's iOS `-1` course no longer 400s the whole
telemetry push. Accepted/noted: WS-vs-poll plausibility gates keep separate histories
(self-healing, bounded); `updated_at` staleness can be masked briefly by non-telemetry mission
updates; mirror adds ~3 cheap queries per push. Reviewer-verified clean: mirror wiring/DI,
bearing prev-fix ordering, heading alias flow-through, permission-flow termination, manifest/FGS
plumbing, hooks-order safety, gateway frame pass-through.
