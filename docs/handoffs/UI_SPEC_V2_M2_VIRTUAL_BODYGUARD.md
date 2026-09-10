# UI Spec v2 — M2 · VIRTUAL BODYGUARD (module handoff)

> **IMPLEMENTED 2026-07-16 (B-91 M2 commit).** Shipped: R2 OSINT tile removed from Home;
> R3 Ops Room card removed, GeoRisk embedded inline at the end of the Home scroll (the
> controls/results cluster extracted as `GeoRiskPanel`, screen kept for deep links),
> "Bravo Lite Services" tile → "Secure Services" via `switchProduct('secure')`, "Request
> Support" → messenger module (Q9 default); R4 new `VBGMap` expanded-map screen (fills
> the screen, pin → details card → NAVIGATE handoff, 2 actions max) wired to VIEW ON MAP;
> R5 Nearby sorted nearest-first + legend upgraded to category filter chips feeding map
> AND list from one filtered set; R6 the threat/news feed is now a strict rolling 72 h at
> the query layer (`withinWindowStrict`, undated dropped, no unfiltered fallback; GDELT
> timespan clamped ≤72 h; SRA keeps its lenient user-window path) + LAST 72 HOURS chip and
> spec empty-state on the OSINT screen — ⚠️ auth-service change, needs Contabo deploy;
> R7 footer reduced to Home · News Feed · Messenger (drill-downs light Home; Home returns
> to the dashboard from a drill-down) + top-left profile avatar opens the shared drawer;
> R1 direct product routing via M0. **Deferred:** VBG-specific onboarding intro screens
> (minimal; M0 gate covers selection), hold-to-alert progress-ring polish (existing 1.6 s
> hold animation retained — verify on device), background-location work (unchanged).

> Part II of `Bravo_Platform_UI_Corrections_Implementation_Specification.pdf` (PDF pages
> 14–22). **Prerequisite: M0 shell.** Run THE MODULE LOOP from `UI_SPEC_V2_INDEX.md` per row.

**Target in one sentence:** VBG becomes a standalone product whose Home is ONE vertically
scrollable page — Principal card → real interactive map with key points → View-on-Map /
Location-History → SRA + Nearby tiles → Quick Actions (hold-to-alert SOS first) → embedded
GeoRisk — with exactly three bottom tabs (Home · News Feed · Messenger) and news capped to
the last 72 hours at the query level.

**Target mockup notes (PDF p.16 image):** header "VIRTUAL BODYGUARD / LIVE SAFETY & RISK
INTELLIGENCE" with top-left avatar; PRINCIPAL card (name, VIP chip, "Active · Syncing…");
LIVE LOCATION map card with "KEY POINTS ON" toggle, DARK/LIGHT + HEATMAP controls, Mapbox
attribution, legend Police/Hospital/Embassy/Fire; VIEW ON MAP (primary) + LOCATION HISTORY
buttons; SRA + NEARBY tiles with OPEN links; QUICK ACTIONS: full-width red "HOLD TO ALERT
CONTROL ROOM" then 2×2 grid (Contact Emergency Services · Phone Next of Kin · Request
Support · Secure Services); bottom tabs Home / News Feed / Messenger.

---

## Requirements → current state → plan

### R1 — Onboarding & direct routing (PDF p.15)

**Spec.** Selector keeps its design; choosing VBG runs ONLY VBG onboarding (no Messenger
plans, no booking features), then lands on VBG Home. Returning users with completed
onboarding bypass straight to Home. Never route through the combined command home.

**Current state (verified).** VBG is not a product today — its six screens live INSIDE the
booking stack (`BookingNavigator.tsx:89-152`) and render fullscreen only because
`VBG_FULLSCREEN_ROUTES` hides the root tab bar (`MainNavigator.tsx:68,661-663`). The
product selector card for VBG (`OnboardingScreen.tsx:137`) routes to the same generic
signup as everything else. There is NO VBG onboarding flow at all (the `VbgScanPrompt` on
Home is a recurring biometric check-in, not onboarding).

**Plan.** Under the M0 shell: VBG becomes a first-class product root (new `VbgNavigator`
hosting the VBG\* screens moved out of `BookingStackParamList`). VBG onboarding is
NET-NEW and should stay minimal: a 1–2 screen intro (what VBG monitors, location
permission rationale → request via the existing `locationPermission.ts` helpers) with a
persisted completion flag in the M0 product-state record; returning users skip per M0 §3.

**Blast radius.** VBG routes currently live in `BookingStackParamList` — moving them
breaks every `navigate('SecureTab', {screen: 'VBGHome'})` caller (grep list in M0 §6;
includes B-90 T-03's news-hub banner, itself removed by M1 R8 — net: delete, don't migrate,
that caller).

---

### R2 — Home upper half: Principal + real map + key points (PDF p.16)

**Spec.** Content order (single scroll): Principal card (name/profile, active + syncing
status) → OFFICIAL interactive map (approved provider; user's live location + key points
on the SAME map; categories: hospitals, police, fire stations, embassies + approved
others) → "View on Map" + "Location History" directly under the map → SRA + Nearby tiles.
REMOVE the OSINT tile from Home (intelligence belongs in News Feed). Data states: loading
states for location/key-points/tiles; permission-denied explains + retry/manual location;
empty key-points keeps the map + neutral message. One provider consistently across Home,
expanded map, Nearby, navigation handoff. Progressive loading — map must not block the
rest of Home.

**Current state (verified — closer to target than the spec assumes).**
`VBGHomeScreen.tsx` is ALREADY one scrollable page with: topbar + status badge (:171-183)
→ `VbgScanPrompt` (:187) → Principal card (:190-204 — name/email from auth user, PRO/VIP
tag, "Active · Updated…" line) → Live Location card (:207-251) → three mini cards
(Security Risk→SRA :255-263, **OSINT tile :264-267 ← REMOVE**, Nearby :268-276) → Quick
Actions (:280-308) → **Ops Room Live Monitoring card :311-323 ← REMOVE**. The map is
ALREADY the real Mapbox key-points map (`VbgKeyPointsMap` at :219-233, mini 132px,
`styles.miniMap` :421) with an abstract `TacticalMap` only as the no-GPS-fix fallback
(:227-232); "VIEW ON MAP" currently goes to `VBGNearby` (:243-250) and "LOCATION HISTORY"
opens the modal. Key-point categories today: police/hospital/embassy/fire
(`vbgKeyPointsMapHtml.ts:77`) — fire stations ✓, spec also wants them; data comes from
`GET /vbg/keypoints` → OpenStreetMap Overpass (server-computed `distanceKm`).

**Plan.** Rebuild `VBGHomeScreen` as one `ScrollView` in the spec's order. Map card =
the existing key-points map component (Mapbox GL WebView — the app's approved provider,
matching the mockup's attribution) embedded at fixed height with lite interactivity, and
the B-77/B-90 warm-up + recovery patterns (`useMapReload`, `MapFailedOverlay`,
`MapPrewarm`) reused — not re-invented. Key-point categories per spec; legend + "KEY
POINTS ON" toggle. Location permission flow reuses `ensureLiveLocationAccess`
(B-89 add-on) for the explain-retry-settings dance.

**Blast radius.** vbg tests (`src/screens/vbg/__tests__`), the key-points map html, GPS
permission flows shared with booking/tracking (`src/utils/locationPermission.ts` — B-89
work, do not fork).

---

### R3 — Home lower half: Quick Actions + embedded GeoRisk (PDF p.17)

**Spec.** Quick Actions EXACT order: (1) Hold to Alert Control Room — press-AND-HOLD with
visible progress and cancel opportunity before dispatch; (2) Contact Emergency Services —
device calling workflow, confirm before dialing where policy requires; (3) Phone Next of
Kin — verified contact from profile, else route to profile setup; (4) Request Support;
(5) Secure Services — opens the Secure Services product/booking per entitlement +
onboarding state. DELETE the "Ops Room Live Monitoring / All Clear / Open Feed" card.
Then, same page, GeoRisk Analysis: search location, locate-me, radius 5/50/200 km, window
24/48/72 h, "Run Security Analysis" (disabled until valid inputs), results render beneath
without losing inputs. Acceptance: scroll Principal → Run Security Analysis without
changing tabs.

**Current state (verified).** Quick Actions exist at `VBGHomeScreen.tsx:280-308` and are
CLOSE to spec: **Hold to Alert Control Room already implemented** (Pressable :281-284,
1600 ms hold via `handlePanicIn/Out` :142-153 → `vbgApi.panic(fix)` = `POST /vbg/panic`,
server fans out SOS+SMS+WS with a 3-per-60s throttle; label flips to "✓ Control Room
Alerted"). Grid: Contact Emergency Services → `VBGEmergency` (bundled offline per-country
numbers, `emergencyNumbers.ts`, universal 112) ✓; Phone Next of Kin → `NextOfKinModal`
(server-backed, up to 3 contacts via `PUT /vbg/favorites` — name+phone only, NO verified
flag, NOT a profile field) ✓; **Request Support → currently just navigates to VBGOSINT
(placeholder, :298-302 — no support API exists)**; **"Bravo Lite Services" → ZoneMap
(:303-307) — rename to "Secure Services" and route through the M0 product switch**. The
Ops Room card to delete is :311-323. GeoRisk controls ALREADY exist — but on the separate
`VBGGeoRiskScreen`: search + Mapbox geocode autocomplete (:304-363), radius `RADII=[5,50,
200]` (:29,369-374), window 24/48/72h (:30-34,376-381), RUN button (:385-396) → `vbgApi.
sra({lat,lng,radiusKm,timeWindowHours})` with results sections (:414-525). `VBGSRAScreen`
is a separate auto-run summary (no controls) + biometric-monitoring enrolment card.

**Plan.** Reorder to spec: hold-to-alert FIRST (full-width red per mockup), then the 2×2
grid. Upgrade the existing 1600 ms hold with a VISIBLE progress affordance + explicit
cancel-on-release (spec requires visible progress and a cancellation opportunity —
today's hold has no progress UI); keep `vbgApi.panic` as the dispatch (already throttled
server-side; add initiation/cancel audit events server-side if not present). "Request
Support" needs a REAL action — smallest honest option: route to the messenger module
addressed to the ops/support channel, or a new `POST /vbg/support-request` — ⛔ boss
decision, currently a placeholder navigate. "Secure Services" tile = M0 `switchProduct
('secure')` (or its booking flow per entitlement). GeoRisk embed: extract
`VBGGeoRiskScreen`'s control cluster + results into a `GeoRiskSection` used by Home
(screen itself stays reachable for deep links until M0 P5 cleanup deletes the tab).

**Blast radius.** SOS plumbing: the combined-home SOS (`sosApi`, M0 §4) vs VBG panic
(`vbgApi.panic`) are DIFFERENT systems — M0 re-homes the client SOS here; decide whether
they merge (one control-room pipeline) or the VBG hold-to-alert simply becomes the
surviving panic entry (recommended: keep `vbgApi.panic`, retire the Dashboard `sosApi`
flow WITH boss sign-off — it has ops-console implications). Next-of-kin storage is the
`vbg_favorites` server set (name+phone, max 3) — the spec's "verified next-of-kin in the
user profile" is aspirational; treat favorites as the source and skip verification v1.

---

### R4 — Expanded map interaction (PDF p.18)

**Spec.** "View on Map" opens a map occupying ≥70% of the screen; pinch/pan/rotate/
recenter gestures; location + key-point pins with consistent category icons/colors;
selecting a pin opens a compact card (name, category, distance, actions) with a Navigate
action handing off to the approved navigation provider (or in-app); Back returns to the
SAME Home scroll position. Privacy: show approximate/stale/unavailable location status;
background location only if a monitoring feature requires it, explained BEFORE the OS
dialog; never expose precise location to other users without an explicit sharing feature.
Acceptance: one-handed usable; navigation ≤ 2 actions after selecting a key point.

**Current state (verified).** No expanded/fullscreen map exists — `VbgKeyPointsMap` is
used at fixed heights only (Home 132px, Nearby 300px, GeoRisk 280px). The component is
Mapbox GL JS v3.9.0 in a WebView with pin taps (`onTapPoint`), DARK/LIGHT + HEATMAP
controls, 3D buildings, radius circle, fitBounds (`VbgKeyPointsMap.tsx` +
`vbgKeyPointsMapHtml.ts:242-277`) — gestures work INSIDE the canvas already. Navigation
handoff today is a `geo:`/Apple/Google-Maps PIN link (`openInMaps`,
`VBGNearbyScreen.tsx:59-67`) — opens the location, not turn-by-turn (no
`google.navigation:` intent anywhere).

**Plan.** Full-screen route hosting the same map WebView with gestures enabled; pin-tap →
bottom card; "Navigate" → `geo:`/Google-Maps intent via `Linking` (Android) preserving
return; Home scroll position preserved (keep Home mounted under the modal route or store
scroll offset).

---

### R5 — Nearby key points list (PDF p.19)

**Spec.** List sorted by distance (nearest first) from current/selected location; fields:
name, category, distance (optional open/closed + travel time); map and list show the SAME
filtered set; item tap → details + Navigate; handoff passes destination coords and
preserves the return path; category filters Police/Hospital/Embassy/Fire stay; routing
failure keeps details + Retry/Copy Address; same category colors/icons across map, legend,
list; comfortable touch targets.

**Current state (verified).** `VBGNearbyScreen.tsx`: map (300px) + static legend
(:99-104) + a plain list of server-returned key points (:128-142 — label, kind, server
`distanceKm`, tap → `openInMaps`). **No client-side sorting** (renders server order),
**no category filter chips** (legend is decorative), loading/retry/no-fix/empty states
exist (:111-125, Overpass 429s handled via `retryTransient`).

**Plan.** One shared key-points data hook (source: `GET /vbg/keypoints` → Overpass, with
server `distanceKm`) feeding map + list so the sets can't diverge; sort by `distanceKm`
ascending client-side; category filter chips (Police/Hospital/Embassy/Fire) filtering
BOTH list and map (`updateKeyPoints` already accepts the filtered array); Copy
Address/Retry on handoff failure via clipboard.

---

### R6 — News Feed: last 72 hours only (PDF p.20)

**Spec.** Keep the approved feed layout; return ONLY items published within the previous
72 h — enforced in the QUERY/API layer, not by hiding cards; visible "Last 72 Hours"
label; refresh on entry + pull-to-refresh evicts aged items; empty state "No relevant
updates in the last 72 hours" + Refresh; no Secure-Services ads, VBG upsells or product
cards; content = security intelligence + personalized news for the user's region/
interests. News Feed is the CENTER tab. Switching back to Home preserves scroll position
where practical.

**Current state (verified).** The VBG "News Feed" tab points at `VBGOSINTScreen`
(`VbgFooter.tsx:69`) — the OSINT threat feed, which blends three live sources server-side
(GDELT + NewsData.io + Google News RSS, deduped —
`apps/auth-service/src/vbg/vbg.service.ts:562-639,1055-1070`). **There is NO 72 h limit
today:** the OSINT client passes no window (`VBGOSINTScreen.tsx:49`), `regionThreats`
applies no filter, and GDELT's query-level `timespan` DEFAULTS TO 21 DAYS
(`gdelt.service.ts:36,46-68`); NewsData/GoogleNews get no timeframe at all (paid feature
note at `vbg.service.ts:663-664`). The only window logic is `withinWindow()` on the SRA
path (post-fetch, user-selected 24/48/72 h, and it FALLS BACK to the unfiltered set when
empty — `vbg.service.ts:667,1045-1053`). Severity filter chips exist client-side
(All/Critical/Caution/Information).

**Plan.** Server (auth-service vbg module): `GET /vbg/threats` gains a 72 h window —
GDELT `timespan=72h` at the query level (`gdelt.service.ts` — change the default or pass
`timeWindowHours: 72` from `regionThreats`), plus a hard `withinWindow(items, 72)` on the
blended result WITHOUT the falls-back-to-unfiltered escape (the spec's acceptance is "no
article older than 72 h is returned" — the fallback violates it; empty is the correct
answer). Undated items: currently `withinWindow` KEEPS items with unparsable dates —
decide to drop them on this surface (recommended) since "no older than 72 h" can't be
proven for them. Client: "Last 72 Hours" filter chip, refresh-on-entry + pull-to-refresh
(exists?—verify), empty state with Refresh. NOTE: the SRA/GeoRisk path keeps its
USER-SELECTED 24/48/72 window — only the News surface pins 72. Coordinate with M1 R8:
Messenger's news hub is a DIFFERENT surface (IntelFeed/NewsFeed) — the 72 h rule in this
spec applies to the VBG feed only.

---

### R7 — Bottom navigation + profile drawer (PDF p.21)

**Spec.** Bottom taskbar EXACTLY: Home · News Feed · Messenger. Remove Key Points and
GeoRisk tabs (integrated into Home). The Messenger TAB opens the communication module
INSIDE the VBG product context; the PROFILE switch to Messenger opens the full standalone
Messenger product. Top-left profile avatar on VBG screens opens the drawer; Switch
Dashboard shows Messenger + Secure Services ONLY (never the current product); switching
closes VBG context, resets its stack, opens the destination's onboarding-or-dashboard per
its saved state.

**Current state (verified).** `VbgFooter.tsx` renders FIVE tabs (`TABS` :81-125): Home /
News Feed / **Key Points** / **GeoRisk** / Messenger — the two bold ones must go.
Targets (`TAB_TARGET` :61-71): home→VBGHome, keypoints→VBGNearby, georisk→VBGGeoRisk,
news→VBGOSINT, messenger→`{kind:'tab', tab:'MessengerTab', screen:'MessengerHome'}` (a
cross-TAB jump today — under M0 this becomes the in-context messenger MODULE mount).
Active-tab map `VBG_ROUTE_TO_TAB` :38-44 (SRA highlights georisk); dispatch `go()`
:134-148; tests `src/screens/vbg/__tests__/VbgFooter.test.tsx`; header comment (:13-27)
still says "5-tab footer". No profile avatar exists on VBG screens today.

**Plan.** VBG product shell gets its own 3-tab bar (M0 per-product tab config); the
Messenger tab mounts the messenger module navigator nested in VBG context (M0 defines the
"module vs product" mounting — one messenger codebase, two mount modes); drawer matrix
from M0 `switchProduct()`.

**Blast radius.** `VbgFooter` consumers; any VBG deep links/notifications.

---

## Module acceptance checklist (PDF p.22 — verbatim release gate)

Onboarding: splash 2 s → selector → VBG onboarding → direct Home. Home order: Principal →
map → View-on-Map/Location-History → SRA/Nearby → Quick Actions → GeoRisk. Removed: no
OSINT tile in Home, no Ops Room card. Map: current location + key points, ≥70% expanded
view, gestures, details, navigation. Quick Actions: SOS hold, emergency services, next of
kin, request support, Secure Services. Bottom nav: Home/News Feed/Messenger only. News:
rolling 72 h at data-query level. Profile switch: Messenger + Secure Services only.
States: loading/offline/permission-denied/no-results/retry implemented. Security:
location + alert actions behind permissions, confirmation and audit logging where required.

## Module loop additions (on top of INDEX loop)

- Map work rides the B-89/B-77 recovery machinery — after EVERY map change re-run the
  kill-network-mid-load test (overlay must appear, watchdog must remount) and the
  MapFailedOverlay path.
- Hold-to-alert: verify cancel-before-threshold NEVER dispatches (log server side); test
  with fontScale 1.3 + TalkBack (accessibility of a long-press control needs an
  alternative affordance — document what's chosen).
- 72 h filter: device-clock skew test (client sends window, server computes cutoff —
  server time wins).
- Isolation: booking flows and client SOS screen untouched; agent/CPO shells unaffected.
- GPS permission flows: re-run the B-89 permission matrix (denied / approximate-only /
  granted) on Home, expanded map, Nearby.
