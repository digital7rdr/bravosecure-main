# Developer Feedback August 2026 — Navigation & Mission-Flow Build Spec (for Opus 5)

**Source:** `docs/planning/Bravo_Secure_App_Developer_Feedback_August_2026.pdf` (23 pages,
19 annotated device screenshots, prepared by the founder from on-device testing).
**Written:** 2026-08-18. **Owner of execution:** Opus 5 build session.

This document walks the PDF **page by page**, translates every annotation into concrete,
codebase-anchored work items (WI-N.x), and states the acceptance criteria. Read §1
(anchor map) and §2 (architectural decisions) before touching anything — they prevent
re-inventing machinery that already exists.

---

## §0 Mandatory process gates (repo law — do not skip)

1. **This is a Lite/Secure booking + mission task** → run
   `docs/runbooks/LITE_BOOKING_LOOP.md` at start (baseline) and after changes (regression),
   including the §7 sign-off.
2. **Every screen change** → `DESIGN_REVIEW_LOOP.md` applies. Design system is obsidian
   `#07090D` / cobalt `#5B8DEF` (G8: no deviation). The map HTML files carry their own
   inline palette — keep it consistent with the RN chrome around them.
3. **WI-7.x (mission group calling) touches `src/modules/messenger/**`** → the FULL
messenger gate applies: `npx jest --selectProjects messenger-crypto`**twice** (flake
rule) AND`npx jest --selectProjects app --testPathPattern "screens/messenger"`.
4. **Typecheck baseline:** `npm run typecheck` must not exceed `.tsc-baseline.json` (47).
5. **Bug-regression contract:** every behavioural fix here needs a test that was RED first
   (mutation-prove by reverting). New bugs found along the way → log in `sqa.md`
   (claim numbers by pushing first — parallel-session race rule).
6. **Never import `Alert` from react-native** — use `@utils/alert` (B-88).
7. **No `react-native-reanimated`** (worklets babel plugin absent) — RN `Animated` only.
8. **UTC everywhere** via `@utils/datetime`; the founder's screenshots show `Z`-suffixed
   times — keep them but see WI-6.3 (route-timeline ordering bug).
9. **Booking/mission FSM changes live in `apps/auth-service`** — every transition writes a
   `status_audit` row and is idempotency-keyed (see `src/services/api.ts:1046`). Follow
   that pattern for anything new.
10. **Self-diff rule (founder standing rule 2026-07-30):** before commit, re-read your own
    diff hunting consumer regressions; run the MESSAGE_LOOP §5 caller-completeness sweep
    for any shared symbol you change.

---

## §1 Codebase anchor map — where each PDF surface lives

| PDF surface                                       | File                                                                                                                         | Notes                                                                                                                                                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Client "Protection Active" screen (screens 03–15) | `src/screens/liveops/LiveTrackingScreen.tsx` (~1430 ln)                                                                      | Verify-code card, ROUTE/TEAM/CHAT tabs, EMERGENCY, compact/expanded map                                                                                                                          |
| Client live map canvas                            | `src/modules/booking/bravoLiveRouteMapHtml.ts` (~509 ln)                                                                     | Mapbox GL JS in WebView. `window.setRoute({origin, vehicle, dest, etaLabel})`, DARK\|LIGHT\|SAT segment, RECENTER pill, fitBounds-once camera policy                                             |
| Driver/CPO tracker (screens 17–18)                | `src/screens/agent/AgentLiveTrackerScreen.tsx` (~1312 ln)                                                                    | Header `MSN-…`, message dock, journey rail, nav banner                                                                                                                                           |
| Driver map canvas                                 | `src/modules/booking/bravoAgentTrackerMapHtml.ts` (~892 ln)                                                                  | `setNavRoute({traveled, ahead})`, `setCpo({…heading_deg})`, `setPrincipal`, bubbles, `setStyle('dark'\|'light'\|'sat'\|'3d')`, awaiting-telemetry pill                                           |
| Turn-by-turn engine                               | `src/utils/mapboxDirections.ts` (~286 ln)                                                                                    | Directions API fetch + pure helpers: `nearestIndexOnRoute`, `splitRouteAtProgress`, `nextManeuver`, `formatDistance`, `offRouteDistanceM`. Already targets pickup pre-LIVE and dropoff once LIVE |
| Six-step mission tracker (shared)                 | `src/screens/booking/missionJourney.ts`                                                                                      | SINGLE source of truth; labels at `STEP_LABELS`; monotonic `clampJourney`                                                                                                                        |
| Booking pending/approval screen (screen 01)       | grep `AWAITING BRAVO CONTROL` under `src/screens/booking/`                                                                   | Pending/Approved/Rejected chips + CANCEL REQUEST                                                                                                                                                 |
| Booking confirmed screen (screen 02)              | `src/screens/booking/BookingConfirmationScreen.tsx` (~582 ln)                                                                | Six-step tracker, ASSIGNED TEAM card, INVOICE / AWAITING DISPATCH, CANCEL BOOKING                                                                                                                |
| Mission FSM (server)                              | `apps/auth-service/src/agents/agent.service.ts` (`flipMissionStatus`, ~ln 1526–1720)                                         | `DISPATCHED→PICKUP` (pickup, stamps `pickup_at`), `PICKUP→LIVE` (go-live, stamps `live_at`, flips booking `CONFIRMED→LIVE`, audits, pushes)                                                      |
| Mission API (client)                              | `src/services/api.ts:1046–1069`                                                                                              | `missionPickup`, `missionGoLive`, `missionComplete` (idempotency-keyed, carry GPS fix), `missionVerifyCode`                                                                                      |
| Live GPS pipeline                                 | `src/services/protectionLocationService.ts`, mission FGS (B-89 audit)                                                        | Telemetry mirror + WS emit already real                                                                                                                                                          |
| Mission group call / Ops Room (screen 16)         | `src/modules/messenger/orgWorkspace/dispatchRoomIntents.ts`, `missionOpsRoomStaticScan.test.ts`, `lockedTerminology.test.ts` | Call UI: messenger call screens; ring fan-out `groupCallRingFanout`                                                                                                                              |
| Executive Protection sessions                     | `src/screens/cpo/CpoProtectionSessionScreen.tsx`, `docs/planning/PROTECTION_SESSIONS_SPEC.md`                                | Hourly check-ins model                                                                                                                                                                           |

**Line numbers above go stale — re-grep the symbol before editing (repo rule).**

---

## §2 Architectural decisions (settled here so the build doesn't relitigate them)

### D1 — "Client Picked Up" is the EXISTING `go-live` transition, not a new FSM state

The PDF's required flow (page 3) maps 1:1 onto the shipped mission FSM:

| PDF step               | Existing state/transition           | Already stamps / does                                                                |
| ---------------------- | ----------------------------------- | ------------------------------------------------------------------------------------ |
| 1 Assigned             | mission `DISPATCHED`                | acceptance window (B-377)                                                            |
| 2 Navigate to pickup   | `DISPATCHED` (tracker nav → pickup) | `mapboxDirections` targets pickup                                                    |
| 3 Arrived at pickup    | `missionPickup` → `PICKUP`          | `pickup_at = NOW()`, geofence warn (LM-C3), client push `missionEnRoute`             |
| 4 **Client Picked Up** | `missionGoLive` → `LIVE`            | `live_at = NOW()`, booking `CONFIRMED→LIVE`, `status_audit` row (LM-V6), client push |
| 5 Navigate to drop-off | `LIVE` (tracker nav → dropoff)      | `mapboxDirections` switches target on LIVE                                           |
| 6 Client Dropped Off   | `missionComplete` → `COMPLETED`     | escrow proof-gate + settle (B-76, 30 s timeout)                                      |

**Therefore: do NOT add a new mission status.** The work is (a) surfacing the transition as
a prominent, deliberate, proximity-gated **"Client Picked Up"** button in the CPO UI,
(b) recording the GPS fix + actor identity on it (the endpoint already accepts a fix —
verify it is PERSISTED, not only used for the geofence warn; if not, persist it),
(c) making the Bravo Control System (ops console) surface the event, and (d) auto-switching
navigation — which `mapboxDirections.ts` already keys off LIVE; verify + pin it.

### D2 — Navigation stays Mapbox-GL-in-WebView; upgrade it, don't replace it

Turn-by-turn already exists (Directions API, maneuver banner, traveled/ahead split,
`heading_deg`). The blocker is that it doesn't BEHAVE like a nav app: no track-up camera,
no voice, no auto-reroute-on-off-route loop, labels clipped. Extend
`bravoAgentTrackerMapHtml.ts` + `AgentLiveTrackerScreen.tsx`. Do not introduce the native
Mapbox SDK in this task (deferred since the Mapbox audit) and do not add a new map stack.

### D3 — Voice guidance = `expo-speech` (or equivalent already-present TTS), English (UAE)

No audio asset pipeline. Speak the maneuver banner text at threshold distances
(≈800 m / 300 m / 80 m, dedup per step). Must respect the call-audio session — if a
mission call is active, duck or suppress (check `callAudioSession.ts` arbitration before
wiring; that file is messenger-owned, so read-only unless the gate is run).

### D4 — One label policy fixes ~8 screens

Screens 05, 06, 07, 10, 11, 13, 14 are all the same defect: full formatted addresses
(`شارع العريف, Al Raha, Abu Dhabi, Abu Dhabi, United Arab Emirates`) rendered as on-map
labels and route-timeline text. Fix once with a shared helper, e.g.
`src/utils/placeLabel.ts`: `shortPlaceLabel(address): string` → first meaningful
component, English-preferred, ≤ 24 chars + ellipsis; full address available on tap
(bottom-sheet or expandable row). Apply it to BOTH map HTML files (marker popups → compact
pins) and the ROUTE tab timeline. Add a unit test with the real UAE strings from the
screenshots (Arabic segment included).

### D5 — Camera policy: mission-scoped recenter + track-up

- **Recenter** must `fitBounds` over ALL active mission markers (client, CPO/vehicle,
  pickup, destination) + the route — not one endpoint (screen 08).
- **Track Up** (bearing-follow, pitch ~45–60, vehicle pinned low-center) is DEFAULT during
  active driver navigation; **North Up** is a toggle; the client tracker keeps
  fitBounds-once + user-owned camera with a working recenter (screens 03/04).
- Changing zoom/style must never unmount RN overlays (the verify code card lives in RN,
  not the WebView — its disappearance is a RN state bug, see WI-3.1).

---

## §3 Page-by-page requirements

### Page 1 — Cover: PRIMARY RELEASE BLOCKER

> "The current map is not suitable for driver navigation. Replace the static tracking
> experience with a driver-grade, turn-by-turn navigation flow. The driver must confirm
> **Client Picked Up** at pickup, after which navigation must continue to the drop-off
> point and the Bravo Control System must receive the status update."

This is the theme for Phases 1–2 (WI-1.x, WI-2.x). Nothing ships until the page-23
checklist passes on device.

### Page 2 — Non-negotiable functional requirements (01–04)

| #   | Requirement                                                                                                                                                        | Work items     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| 01  | Driver-grade navigation: track-up map, vehicle heading, route line, maneuver card, remaining distance, ETA, voice guidance, automatic rerouting, reliable recenter | WI-1.1…WI-1.7  |
| 02  | Client Picked Up checkpoint: prominent button at pickup; tap timestamps, notifies Bravo Control System, changes mission state, starts/continues nav to drop-off    | WI-2.1…WI-2.5  |
| 03  | Executive Protection visibility: client + assigned CPO/team + venue on one live map, distinct icons/labels, clear legend                                           | WI-4.1…WI-4.3  |
| 04  | Responsive, uncluttered map: long addresses/status labels/controls must not obscure the route; works on normal phones, folds, compact map view, full-screen view   | WI-3.x, WI-5.x |

### Page 3 — Required mission flow + button behaviour + EP map contract

Six steps (see D1 mapping). Two contract boxes:

**Client Picked Up button behaviour (all five bullets are acceptance criteria):**

1. _Visible only when the assigned team is at/near the pickup point, with an operational
   override._ → Gate on distance-to-pickup ≤ **150 m** (reuse `haversineM` from
   `mapboxDirections.ts`). Below the gate, show the button disabled with the distance
   remaining; an **override** path (long-press → confirm sheet stating "You are X km from
   pickup — confirm override") satisfies "operational override if required". Server keeps
   its existing geofence-warn (never-block) behaviour — the hard gate is client UX only.
2. _Deliberate tap + confirmation._ → Confirmation sheet (via `@utils/alert` /
   BravoAlertHost pattern), never a bare one-tap.
3. _Records mission ID, user/driver ID, GPS position, timestamp._ → `missionGoLive`
   already sends the fix; server stamps `live_at` + audit row with actor. **Verify the
   fix is persisted** (WI-2.3) — the LM-C3 comment says fixes feed the geofence warning;
   if they aren't stored, add lat/lng (+ accuracy) columns to the audit metadata jsonb.
4. _Immediately notifies the Bravo Control System and updates client-facing status._ →
   client push exists on PICKUP/LIVE; add/verify the **ops console** live event (WS emit
   on the ops channel + row visible in the ops mission monitor) (WI-2.4).
5. _Automatically changes navigation destination from pickup to drop-off._ → already keyed
   off LIVE in `mapboxDirections.ts` header contract; verify end-to-end and pin with a
   test (WI-2.5).

**Executive Protection map (all five bullets → WI-4.x):** client = distinct live marker
with status; CPO/team = verified-identity marker (+ vehicle where applicable); venue =
named static marker; recenter = fits all active markers + route; **privacy: visibility is
mission-scoped and ends when the mission is closed** — the client marker stream must stop
at COMPLETED/ABORTED server-side, not just client-side (check
`protectionLocationService.ts` stop conditions + server emit gating).

### Page 4 — Screen 01: Approval and cancellation layout

Annotations: "last screen chance to cancel request — after this no more cancel", "spacing".

- **WI-6.1** Collapse the duplicated waiting status: currently "AWAITING BRAVO CONTROL
  SYSTEM APPROVAL" panel + `Pending` chip row + "WAITING FOR BRAVO CONTROL SYSTEM" footer
  = three tellings. Keep ONE status panel (chip + copy), delete the redundant footer
  strip, tighten vertical spacing.
- **WI-6.2** Move CANCEL REQUEST to a consistent position near the booking controls
  (bottom action area, same slot every stage), and add explicit copy: **"This is your
  last chance to cancel — once approved, the booking cannot be cancelled."** (founder's
  annotation elevated to product copy).
- Acceptance: reproduce on the original device class; all labels readable; single status
  panel; cancel reachable without scrolling past the summary.

### Page 5 — Screen 02: Confirmed booking status layout

Annotations: "spell & space", "no cancel option" (red strike over CANCEL BOOKING).

- **WI-6.4** Six-step tracker labels truncate ("Accepted ·assigni…", "Team disp atched",
  "Prote ction act…", "Complete d"). Fix in the SHARED tracker component (grep consumers
  of `STEP_LABELS` — client, agency, CPO render it identically): allow 2-line wrap at
  word boundaries, min font, no mid-word breaks, `fontScale ≥ 1.3` safe. Add a render
  test asserting no label is ellipsized/clipped at 320 dp.
- **WI-6.5** **Remove cancellation once assigned/active.** Business rule from page 4 +
  founder strike-through: after approval (booking `CONFIRMED` with team assigned /
  mission exists), CANCEL BOOKING disappears from `BookingConfirmationScreen`. Server:
  verify the cancel endpoint already rejects post-assignment cancels; if not, enforce it
  there too (client hiding alone is not a rule). **Check B-405 parked-semantics memory:**
  legacy `OPS_APPROVED` = payment due — do not break the scheduled-booking cancel window;
  the no-cancel rule starts at assignment, not at approval of a parked later booking.
- **WI-6.6** "AWAITING DISPAT" chip truncates; "344 BC · bravo_credits" exposes an
  internal enum — display "344 BC" (or "344 BC · Bravo Credits").

### Page 6 — Screen 03: Verification code and map centering

Annotations: "when I got in cpo, code gone; cannot see cpo; map not centre".

- **WI-3.1** **Verify-code persistence bug (treat as a real bug, log in sqa.md):** the
  code dots vanish after map interaction/zoom. In `LiveTrackingScreen.tsx`, find what
  conditionally unmounts the verify card (likely collapsed on map gesture or re-render
  race on the rotating-code fetch). The card must stay mounted while the mission is in
  DISPATCHED/PICKUP (pre-handover) regardless of map state; the code re-fetch
  (`missionVerifyCode` mirrors the client rotating code) must not blank the UI between
  rotations. RED test first.
- **WI-3.2** Map must keep user + assigned CPO visible: default camera = fit
  {client, CPO} (+ pickup) — see D5; RECENTER pill always visible and functional in
  compact view.

### Page 7 — Screen 04: Map orientation controls

- **WI-1.4** (driver) Track Up default during navigation; North Up toggle — see D5.
  For the CLIENT tracker this screen shows, add the toggle only if trivially cheap;
  the requirement's force is on the driver map.
- **WI-5.1** Full-screen control must be obvious (labelled icon, ≥44 dp target) and must
  preserve route + all markers on expand/collapse (re-apply sources after style/container
  change — the map HTML already re-applies payloads on style swap; extend that to
  container resize).
- **WI-5.2** Map + control panel must stay centred across screen sizes ("off-center"
  annotation): audit the WebView container for hard-coded widths; use `useContentWidth`
  (foldable helper) — the fold work is screens 08/11's WI-5.4.

### Page 8 — Screen 05: Map labels obscure operational information

- **WI-3.3** Apply D4 short-label policy to the client map: compact pickup/drop-off pins,
  no full-address floating labels. Full address on tap.
- **WI-3.4** Keep map centred on the active mission (D5 camera).
- **WI-3.5** Mission chat stays reachable (CHAT tab) without covering navigation — no
  regression while restructuring; the chat entry ("Open mission chat") keeps working with
  ops + assigned CPOs group (disappears when ops closes the mission — existing contract).

### Page 9 — Screen 06: Route timeline and destination clarity

Annotations: "Screen off-center", "destination?" (arrow at events), ordering circled.

- **WI-6.3** **Route timeline bugs:** (a) events show identical pickup-area addresses for
  every row — each event must carry ITS OWN place (Departed = origin, Approaching =
  destination); (b) ordering is wrong (06:00 → 06:06 → 06:04 top-to-bottom) — sort
  descending by timestamp consistently; (c) "ETA —" placeholder — hide the row or show a
  real ETA from the live route. Make the DESTINATION explicit in the Route tab header
  ("→ {shortPlaceLabel(dropoff)}").
- **WI-6.7** Short English place labels (D4) in the timeline; full address on tap.

### Page 10 — Screen 07: Closed (collapsed) map view is too obstructed

- **WI-5.3** The compact map must still show: route line, current location, CPO/vehicle
  marker, pickup + destination pins — with D4 pins instead of address banners. Define a
  compact-mode flag in the map HTML (`window.setCompact(true)`) that hides the style
  segment + shrinks pills so ~100 % of the canvas is map.

### Page 11 — Screen 08: Fold/full map view

Annotations: "fold view — cannot see agent. B? dest? →".

- **WI-5.4** Foldable pass: on fold-width viewports the CPO marker and destination fell
  outside the frame. Recenter = fit ALL mission markers (D5). Re-run fitBounds on
  container-size change (WebView `onLayout` → `window.refit()`).
- **WI-3.6** **Replace "% TO B" progress pill** with meaningful units: remaining distance
  - ETA ("4.2 km · 11 min") or stage-aware copy ("Arriving at pickup · 350 m"). The bare
    percentage ("0% TO B", "8% TO B") is explicitly rejected. Progress source = live route
    remaining distance (`splitRouteAtProgress`), not straight-line fraction; it must be
    linked to pickup/drop-off mission stage (screen 13 annotation "obscure map… progress
    must update consistently and be linked to pickup and drop-off mission states").

### Page 12 — Screen 09: Team identity

Annotations: "onboard photo of worker, guard, cpo, employee" + avatar sketch.

- **WI-4.4** TEAM tab: real profile photo for every assigned CPO/guard (initials only as
  fallback). Photo source: agent profile (check `agents` table / profile endpoint for an
  avatar URL; if the mobile profile upload exists for CPOs, reuse; if no photo pipeline
  exists for agents, surface that as a blocked item rather than inventing storage).
- **WI-4.5** Team row exposes: verified identity (name + VERIFIED badge tied to the
  verify-code contract), role (LEAD/member), company (org name from service-provider
  orgs), and live availability/status dot. Data likely already on the mission detail
  payload (`/org/missions/:id/live` returns deployment) — verify the client-facing
  mission endpooint carries org display name; extend server-side if absent.

### Page 13 — Screen 10: Route descriptions

Annotations: "descriptions is not what I chose", "description - English (UAE)".

- **WI-6.8** **Route description must match the user-selected destination.** The
  screenshot shows "Departed …Al Raha…" and "Approaching …Al Raha…" with the SAME
  address — the timeline is echoing the pickup for every event (same defect family as
  WI-6.3a; verify one root cause: the event-builder probably interpolates one address
  field for all events). Fix at the event source, add a unit test: departed uses origin,
  approaching/arrived use the ACTUAL selected drop-off.
- **WI-6.9** English (UAE) concise navigation descriptions: request
  `language=en` on the Directions call if not already, and D4-shorten place names.
  Do not repeat the full address on every route event.

### Page 14 — Screen 11: Expanded map and long names

- **WI-3.3 / WI-5.4 apply** (labels + fold). Additional acceptance: the EXPANDED view
  must fit the complete active route and all mission markers on first open (fitBounds on
  expand with padding that accounts for the overlaid pills).

### Page 15 — Screen 12: Reference — expanded route view

No new defect; the founder's argument for full navigation mode. Acceptance evidence for
Phase 1 should include a re-shoot of this exact view: active route line, maneuver
guidance, ETA, remaining distance, vehicle heading visible.

### Page 16 — Screen 13: Map obstruction and progress

- **WI-3.3** (oversized address overlays — remove) and **WI-3.6** (progress must update
  consistently and be LINKED to pickup/drop-off states; "0% TO B" while step 5 active is
  the shown inconsistency).

### Page 17 — Screen 14: Map detail, layers, and progress state

Annotations: "description obscure detail", "over sat function" (labels covering the
DARK/LIGHT/SAT control), progress 76%.

- **WI-5.5** Style controls (Dark/Light/Sat + full-screen) must be readable and never
  overlapped by address labels (z-order + D4 removal solves it); controls stay ≥44 dp,
  don't cover the route corridor (top-right stack with margin).
- **WI-6.10** Verify progress calculation across a complete mission: write the
  stage-aware progress function once (remaining-distance based), unit-test it at
  boundaries (pre-pickup, at pickup, post-pickup, arrival), and drive BOTH the pill and
  any tracker copy from it.

### Page 18 — Screen 15: Differentiate client and CPO

Annotations: "CPO moving / me" — two nearly identical dots.

- **WI-4.1** Distinct marker set (client map + driver map + EP map share it):
  - **Client/principal:** violet pulse dot (existing) — label "You".
  - **CPO/vehicle:** shield glyph in cobalt, rotated by `heading_deg` when moving;
    callsign label ("Ranger").
  - **Pickup:** amber pin; **Destination/venue:** green flag pin with short name.
- **WI-4.2** Small persistent legend (collapsible chip → expands to icon key) so client
  and Bravo Control System read markers identically. Same glyph set in the ops console
  map later — keep the SVGs in one exported module used by both HTML builders.

### Page 19 — Screen 16: Mission group calling

Annotations: "agent call all". Header shows raw `MISSION MSN-956AF85E0956 · OPS ROOM`.

**Messenger gate applies (see §0.3).**

- **WI-7.1** **Agent Call All:** one action on the mission surface (driver tracker +
  mission detail) that rings the whole assigned mission group (ops + CPOs) via the
  existing group-call ring fan-out (`groupCallRingFanout`, mission ring roster). This is
  a launch-site addition, NOT new call machinery — use the existing
  launch/`launchCall.ts` group path with the mission room, and respect every call-registry
  identity rule (`{callId, gen}` keys, `endActiveCall(ref, reason, source)`).
- **WI-7.2** Human-readable call screen: display the mission's human name/booking ref
  ("Mission BS-2026-0956") + caller identity + participant count — not the raw
  `MSN-…` id. Map id→display where the ring payload is built (server ring frame or
  client resolve at present time; prefer resolving client-side from the known mission to
  avoid a wire-format change).
- **WI-7.3** **Terminology:** "Ops Room" must not appear in client-facing text — use
  "Bravo Control System". `lockedTerminology.test.ts` and
  `missionOpsRoomStaticScan.test.ts` already police terminology — extend them to pin the
  new copy (strip comments before scanning; CRLF-safe anchors — repo scan traps).

### Pages 20 & 22 — Screens 17/19: Driver navigation reference — text clipping (logged twice)

Annotations (red): "Words are cut off" — maneuver banner + tracker labels + "Prote ction
act…" chip.

- **WI-1.6** Driver-safe nav layout: maneuver card = large glyph + distance + instruction
  with `numberOfLines={2}` + auto-shrink, never mid-word clip; ETA + remaining distance +
  status row fixed at bottom; mission-stage labels per WI-6.4. There is an existing
  `navBannerLegibility.test.ts` — extend it to cover the failure shown (long instruction
  at 320 dp, fontScale 1.3).
- **WI-5.6** Map style controls become secondary in nav mode (collapsed behind one layers
  button) so they can't interfere with navigation (screens 17/18 red circles on the
  DARK/LIGHT/SAT stack).
- Page 22 adds: device-test responsive layouts on standard phones, folds, and
  expanded/full-screen — that's the §5 device matrix, evidence required.

### Page 21 — Screen 18: Driver controls during navigation

- **WI-1.7** Keep call, video, mission message ("Message ops or crew…"), and emergency
  accessible during navigation without blocking the route: dock them in one bottom strip
  above the journey rail; never overlay the route corridor mid-screen.
- **WI-2.1** **The primary mission action is contextual** — one slot, stage-driven:
  `DISPATCHED` → "Arrived at pickup" (fires `missionPickup`); `PICKUP` →
  **"CLIENT PICKED UP"** (page-3 behaviour contract, D1); `LIVE` → "Complete mission /
  Client Dropped Off" (fires `missionComplete`). `canAdvanceBy` from `journeyStep()`
  gates it to the lead.
- **WI-6.4** applies (tracker chips clipped here too).

### Page 23 — Release acceptance checklist (return WITH EVIDENCE)

Every box maps to WIs; reproduce on-device and attach screenshots/logs per item:

| Checklist item                                                    | Covered by                          |
| ----------------------------------------------------------------- | ----------------------------------- |
| Turn-by-turn works team→pickup                                    | WI-1.1–1.5                          |
| Client Picked Up shown at correct stage                           | WI-2.1                              |
| Pickup confirmation timestamped + visible to Bravo Control System | WI-2.3, WI-2.4                      |
| Nav auto-switches pickup→drop-off after confirmation              | WI-2.5                              |
| Drop-off arrival + Client Dropped Off/mission completion recorded | existing `missionComplete` + WI-2.1 |
| EP map shows client + CPO/team + venue simultaneously             | WI-4.1–4.3                          |
| Distinct icons, labels, legend                                    | WI-4.1, WI-4.2                      |
| Recenter + Track Up behave correctly during motion                | WI-1.4, D5                          |
| Auto rerouting, ETA, remaining distance, maneuver guidance        | WI-1.2, WI-1.3, WI-1.6              |
| Long addresses don't obscure route/markers                        | D4, WI-3.3                          |
| All six mission-stage labels readable on supported sizes          | WI-6.4                              |
| Compact, fold, full-screen map views device-tested                | WI-5.3, WI-5.4, §5 matrix           |
| Mission group call + messaging accessible during nav              | WI-1.7, WI-7.1                      |
| Emergency prominent, doesn't block navigation                     | WI-1.7                              |
| Bravo Control System terminology consistent in client copy        | WI-7.3                              |

---

## §4 Work-item index by phase (build order)

**Phase 1 — Driver-grade navigation (the release blocker)**

- WI-1.1 Track-up camera in `bravoAgentTrackerMapHtml.ts`: `window.setNavCamera({follow: true, bearing, pitch})`, vehicle pinned low-center, smooth easeTo between fixes.
- WI-1.2 Auto-reroute loop: when `offRouteDistanceM > ~40 m` for 2 consecutive fixes → refetch Directions, show "Re-routing" toast (the SYSTEM · RE-ROUTING bubble exists — verify it's driven by a real refetch, not decorative).
- WI-1.3 ETA + remaining distance from live route (`durationS`/`splitRouteAtProgress`), updating per fix.
- WI-1.4 Track Up default / North Up toggle; recenter re-enters follow mode.
- WI-1.5 Voice guidance per D3.
- WI-1.6 Maneuver card + label legibility (RED-first via `navBannerLegibility`).
- WI-1.7 Nav-mode control layout (comms dock, emergency, collapsed style controls).

**Phase 2 — Client Picked Up checkpoint**

- WI-2.1 Contextual primary action on the CPO surface (Arrived / CLIENT PICKED UP / Complete).
- WI-2.2 Proximity gate (≤150 m) + long-press override + confirmation sheet.
- WI-2.3 Persist fix + actor in the go-live audit metadata (server, verify-first).
- WI-2.4 Ops console live event on PICKUP and LIVE (WS emit + visible in mission monitor).
- WI-2.5 Pin nav-target switch pickup→dropoff on LIVE (test on `mapboxDirections` consumer).

**Phase 3 — Map clarity (client tracker)**

- WI-3.1 Verify-code persistence bug (sqa.md entry, RED test first).
- WI-3.2 Default camera fits client+CPO; recenter always visible.
- WI-3.3 D4 short labels/pins on all maps. WI-3.4 mission-centred camera.
- WI-3.5 Chat reachability regression guard. WI-3.6 progress pill → distance/ETA, stage-linked.

**Phase 4 — Executive Protection map + team identity**

- WI-4.1 Marker set (shared module). WI-4.2 legend. WI-4.3 mission-scoped privacy verify (stream stops at close, server-side).
- WI-4.4 Team photos. WI-4.5 verified identity/role/company/status rows.

**Phase 5 — Responsive/layout**

- WI-5.1 full-screen control. WI-5.2 centring. WI-5.3 compact mode. WI-5.4 fold refit. WI-5.5 style-control legibility. WI-5.6 nav-mode secondary controls.

**Phase 6 — Booking screens + timeline correctness**

- WI-6.1/6.2 approval screen. WI-6.3 timeline order/addresses/ETA. WI-6.4 tracker labels. WI-6.5 cancel rule (client+server, B-405-aware). WI-6.6 chips/enum leak. WI-6.7–6.10 labels/descriptions/progress.

**Phase 7 — Mission group calling (messenger gate)**

- WI-7.1 Agent Call All. WI-7.2 human-readable call screen. WI-7.3 terminology.

---

## §5 Test & verification plan

**Unit/render (RED-first where fixing behaviour):**

- `placeLabel.test.ts` — UAE strings incl. Arabic segment, length caps.
- `missionJourney` consumers render test — no clipped labels at 320 dp / fontScale 1.3.
- Progress function boundary tests (pre-pickup / at pickup / LIVE / arrival).
- Nav-target-switch pin (pickup pre-LIVE, dropoff at LIVE).
- Verify-code persistence pin (card stays mounted across map interaction state).
- Timeline event-address test (departed=origin, approaching=destination, ordering).
- Terminology static scans extended (comment-stripped, `\r?\n`-safe — repo trap list).
- Cancel-rule test: server rejects post-assignment cancel; client hides the button.

**Suites/gates:** `npm run typecheck` (≤47) · booking project (`npm test -- --selectProjects=booking`) · messenger gate for Phase 7 (crypto ×2 + app screens) · `npm test` before done.

**Device matrix (LITE_BOOKING_LOOP + page 22):** standard phone (Pixel), small width
(320 dp), fold inner+outer, fontScale 1.3; compact / expanded / full-screen map; real
drive test for track-up + reroute + voice (or state explicitly which lane couldn't be
exercised and why — repo sign-off rule). Release APK for anything measured (console
stripping + baked env rules apply; `NODE_ENV=production`, no stderr wrapper).

**Three-actor loop:** client books → ops approves → CPO runs Arrived → CLIENT PICKED UP →
drop-off complete; verify client pushes at each step, ops console shows timestamps, escrow
settles (LITE_BOOKING_LOOP §7 sign-off).

---

## §6 Out of scope / do-not-do

- No new mission FSM state (D1). No native Mapbox SDK migration (D2). No new map stack.
- No reanimated. No `Alert` from react-native. No weakening of the verify-code contract
  (it is an identity-safety surface).
- Do not re-propose the measured lag dead-ends (CLAUDE.md) while "making the map faster".
- Do not touch `verifyMerkleCommit`/backup, and keep messenger changes to the Phase-7
  launch site only.
