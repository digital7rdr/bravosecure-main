    //Bravo Secure — Batch Fix & Feature Implementation Plan

> **Generated:** 2026-06-25 · **Source:** 16-agent diagnostic workflow over the live `main` working tree.
> **Status:** Planning document — no code changed. Each section is a self-contained brief you can hand to Claude.

## How to use this document

This plan turns ~20 reported issues into 15 work areas. For each area you get: the diagnosed root cause (with `file:line` evidence), the exact files to touch, the concrete changes, the **copy-paste step-by-step prompts** to give Claude, and the regressions to watch for.

**Work the areas in the build order below** — it groups shared files and respects dependencies (e.g. region before region-matching; group membership before group calls). Items marked 🔒 touch encryption / group-key / auth and **require architecture sign-off** before Claude writes code — do not let those steps weaken a security check.

## Decisions locked (2026-06-25)

These override anything in the area specs below that says "deferred / unclear":

1. **iOS group calls → IN SCOPE on both iOS and Android** _(reversed 2026-06-25 — supersedes the earlier "Android-only" call)._ Group/mission-room calling must work on iOS as well as Android. The blocker was that group-call media E2EE (FrameCryptor/sframe) was treated as Android-only; enabling iOS is a security-gated native-crypto epic now folded into this batch. See **Addendum B — iOS group calls** (appended below) for the iOS enablement spec (native module/podspec, CallKit + PushKit VoIP for incoming calls, build/signing) and what is reuse vs net-new. CALLS-GROUP / MISSION-GROUP now target both platforms.
2. **Region list → include South Africa (ZA / ZAR).** v1 supported regions are **AE (Dubai/UAE), SA (Saudi Arabia/SAR), BD (Bangladesh/BDT), GB (UK/GBP), and ZA (South Africa/ZAR)**; anything outside the list = `N/A`. The user has authorized ZA — **no finance sign-off gate.** One caveat that is config, not permission: the **ZAR FX rate value** must be set to a real number (it is a placeholder default today) before any ZAR money flows are live. Add `ZA`/`ZAR` to the canonical region+currency list in REGION's Step that defines the enum.
3. **SP Mission-Detail → build the org escrow/payout endpoint now.** Do **not** ship the detail page with `escrow: null`. Add a new org-scoped read endpoint (e.g. `GET /org/missions/:id/escrow`) that returns the escrow-hold + payout state for a mission the agency owns, reusing the `assigned_provider_user_id` tenant gate (IDOR-safe). Show only what an agency may see (their payout figure + hold status — not the client's wallet internals). Money figures still get a finance review before the column is trusted, but the endpoint + page ship in this batch. This adds ~2 steps to SP-MISSION-DETAIL (a backend escrow-read route + the UI block).

## Quick index

| #  | Area                                                                                                                                                                                                                                                                                                    | Security-gated | Steps |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----- |
| 1  | [MSG-RECONNECT — Messenger WS reconnect loop, messages-not-sent, and disappearing chat history](#1-msg-reconnect-messenger-ws-reconnect-loop-messages-not-sent-and-disappearing-chat-history)                                                                                                             | 🔒 yes         | 9     |
| 2  | [booking-wizard — Booking wizard: require pickup + dropoff; fix Driver-only-Client-Vehicle &#34;vehicle_count must not be less than 1&#34;](#2-booking-wizard-booking-wizard-require-pickup-dropoff-fix-driver-only-client-vehicle-vehicle-count-must-not-be-less-than-1-)                                | no             | 9     |
| 3  | [region — Region setting + region-based client/SP matching with detect / change / N/A](#3-region-region-setting-region-based-client-sp-matching-with-detect-change-n-a)                                                                                                                                   | no             | 11    |
| 4  | [CALLS-1to1 — 1:1 call: End must reliably tear down (audio) without crashing; hardware Back must minimize (PiP) not end](#4-calls-1to1-1-1-call-end-must-reliably-tear-down-audio-without-crashing-hardware-back-must-minimize-pip-not-end)                                                               | no             | 11    |
| 5  | [MISSION-GROUP — Mission Ops Room: add assigned CPOs to the auto-created group + archive the group (hide from client &amp; SP) on completion](#5-mission-group-mission-ops-room-add-assigned-cpos-to-the-auto-created-group-archive-the-group-hide-from-client-sp-on-completion)                          | 🔒 yes         | 12    |
| 6  | [dept-chat — Department Chat — CPO message visibility, channel/announcement/@mention, SP+CPO+manager wiring](#6-dept-chat-department-chat-cpo-message-visibility-channel-announcement-mention-sp-cpo-manager-wiring)                                                                                     | 🔒 yes         | 9     |
| 7  | [CALLS-GROUP — Group call audio+video availability and &#34;Call failed&#34; in groups (incl. mission/ops rooms)](#7-calls-group-group-call-audio-video-availability-and-call-failed-in-groups-incl-mission-ops-rooms-)                                                                                   | 🔒 yes         | 8     |
| 8  | [LIVE-MONITOR-CHAT — Live-monitor (CPO + principal) chat composer keeps &#34;connecting&#34;/records infinitely + mission group call fails](#8-live-monitor-chat-live-monitor-cpo-principal-chat-composer-keeps-connecting-records-infinitely-mission-group-call-fails)                                   | no             | 6     |
| 9  | [rating-card — Rating card shows &#34;0 jobs&#34; — agency jobs_total never bumped on the legacy completion path](#9-rating-card-rating-card-shows-0-jobs-agency-jobs-total-never-bumped-on-the-legacy-completion-path)                                                                                  | no             | 7     |
| 10 | [mission-history — CPO completed-mission history (call-log) in the roster + Service-Provider all-completed-missions list with count and step-flow](#10-mission-history-cpo-completed-mission-history-call-log-in-the-roster-service-provider-all-completed-missions-list-with-count-and-step-flow)        | no             | 13    |
| 11 | [SP-MISSION-DETAIL — Service Provider: tap a mission to open a full Mission Detail page](#11-sp-mission-detail-service-provider-tap-a-mission-to-open-a-full-mission-detail-page)                                                                                                                         | no             | 9     |
| 12 | [CPO-WAYPOINTS — CPO multiple waypoints — fill/progress as the CPO advances on the mission](#12-cpo-waypoints-cpo-multiple-waypoints-fill-progress-as-the-cpo-advances-on-the-mission)                                                                                                                   | no             | 9     |
| 13 | [client-tracking — Client mission status + live-tracking parity and realtime propagation](#13-client-tracking-client-mission-status-live-tracking-parity-and-realtime-propagation)                                                                                                                        | no             | 12    |
| 14 | [MONITOR-MAP — Monitor map: pickup (A) marker, shortest-route highlight, and A→B traveled/remaining live progress line (Google-Maps live-share style)](#14-monitor-map-monitor-map-pickup-a-marker-shortest-route-highlight-and-a-b-traveled-remaining-live-progress-line-google-maps-live-share-style-) | no             | 11    |
| 15 | [MISSION-CANCEL — Client cancel → mission ABORTED + shows in history; enforce 1h window AND protection-active cutoff](#15-mission-cancel-client-cancel-mission-aborted-shows-in-history-enforce-1h-window-and-protection-active-cutoff)                                                                  | no             | 8     |

---

## Recommended build order

### Phase 1: P1 · transport-foundation (ship first; deploy + arch-gated code)

- **Areas:** `MSG-RECONNECT`
- **Why:** The WS reconnect loop is dominated by a DEPLOY/config issue: JWT_ACCESS_SECRET drift between auth-service and messenger-service. That same drifted secret 401s the HTTP relay (messages-not-sent) and is the shared root cause behind LIVE-MONITOR-CHAT's 'keeps connecting', DEPT-CHAT messages not sending, and CALLS-GROUP 'no-transport'. Align the secret FIRST (immediate, no code) so the other chat/call fixes are observable rather than masked by a sick transport. Then land the isolated code-hardening: client unauthorized-refresh attempt-cap/backoff (auth-token, arch-gated), messenger-service crash guards (low-risk), and the keychain mint-on-miss data-loss fix (SQLCipher key handling, arch-gated — the claimed prior `readKeychainWithRetry` fix is absent from main, verify git history before re-implementing).

### Phase 2: P2 · standalone fixes (parallel with P1)

- **Areas:** `BOOKING-WIZARD`, `REGION`
- **Why:** Fully independent of the transport/crypto stack and of each other. BOOKING-WIZARD is a contained DTO+UI fix (vehicle_count @Min(1)→@Min(0) for driver-only; require pickup AND dropoff). REGION is feature/config work whose prerequisite is reconciling the 5-way-forked supported-region list into one canonical source — that hygiene must precede any region-matching validation (the matcher itself already enforces client↔SP region equality). No shared files with the messenger crypto; safe to build in parallel.

### Phase 3: P3 · one-to-one calls (parallel)

- **Areas:** `CALLS-1to1`
- **Why:** Isolated to the 1:1 call surface (callRegistry/useCall/CallScreen/FloatingCallOverlay); not security-gated and shares no files with the group-crypto work. First confirm the failing build is current main (the repo already implements Back→minimize and End teardown; QA logged steady-state End as PASS), then fix the boot-window null-controller End no-op, the RTCView teardown crash freeze, and the 'idle'-state Back-cuts-call gap.

### Phase 4: P4 · group-crypto provisioning (ARCHITECTURE SIGN-OFF GATE)

- **Areas:** `MISSION-GROUP`, `DEPT-CHAT`
- **Depends on:** `MSG-RECONNECT`
- **Why:** Same provisioning seam and same locked files: productionRuntime.createGroupChat/addGroupMember, group/room membership intents, groupClient. Both require architecture sign-off on group master-key distribution (MISSION-GROUP's externally-assigned-id `makeAssignedGroup`; DEPT-CHAT's silent-partial-fan-out + unknown-group fixes). Sequence the shared createGroupChat return-shape change (surface failures[]) ONCE here so DEPT-CHAT and MISSION-GROUP don't both rewrite it. MISSION-GROUP membership is the hard prerequisite for group calls: no CPOs added ⇒ no group master key ⇒ mission/ops-room call fails. Needs a healthy WS (P1) to actually deliver the admin `create`/add envelopes.

### Phase 5: P5 · group calls + live-monitor chat

- **Areas:** `CALLS-GROUP`, `LIVE-MONITOR-CHAT`
- **Depends on:** `MISSION-GROUP`, `MSG-RECONNECT`
- **Why:** CALLS-GROUP reliability depends on the mission-room key existing (P4) and a working transport (P1); its main deliverable is reason-aware failure surfacing plus a launch preflight. LIVE-MONITOR-CHAT shares launchCall.ts with CALLS-GROUP (its group-call 'fail' is the same unhydrated-conversation misroute) and AgentLiveTrackerScreen.tsx with MONITOR-MAP. Build together so the launchCall group-routing fix and the conversation-hydration land once. The VoiceNoteRecorder 'records infinitely' race is independent and can proceed regardless; the 'keeps connecting' symptom is P1's responsibility.

### Phase 6: P6 · agency mission data (history + rating; parallel with P4/P5)

- **Areas:** `RATING-CARD`, `MISSION-HISTORY`
- **Why:** Data-correctness layer that must precede the detail/rating UIs (the 'mission-history data before RATING-CARD/SP-MISSION-DETAIL' rule). RATING-CARD fixes jobs_total on the legacy completion path + a one-time backfill so the agency card stops reading 0. MISSION-HISTORY adds the org-scoped per-CPO history endpoint + completed counts (IDOR-gated by assigned_provider_user_id). Both operate on the org/agent mission tables (backend + auth-service suite) and don't touch the messenger crypto, so they parallelize with the group-chat phases. Coordinate the shared org-mission.service.ts/agent.service.ts edits.

### Phase 7: P7 · SP mission detail

- **Areas:** `SP-MISSION-DETAIL`
- **Depends on:** `MISSION-HISTORY`
- **Why:** Heavy file overlap with MISSION-HISTORY: org-mission.service.ts, org.controller.ts, OrgMissionsScreen.tsx, MissionStepper, src/navigation/types.ts + AgentNavigator.tsx. Build after MISSION-HISTORY to avoid merge conflicts and so the detail page is the single drill-in that history rows link INTO (rather than duplicating layouts). Reuses the same org-scoped tenant-gate pattern.

### Phase 8: P8 · CPO waypoint progress

- **Areas:** `CPO-WAYPOINTS`
- **Why:** Backend waypoint-settling on the FSM transitions (Start/Go-live/Finish settle the implied seqs) plus inline lead marking and duty-bound telemetry. This is the data layer that MONITOR-MAP and CLIENT-TRACKING read for progress, so it must precede them. Shares mission-lead.service.ts and agent.service.ts with CLIENT-TRACKING — land the waypoint/telemetry edits first to reduce conflict.

### Phase 9: P9 · client realtime tracking parity

- **Areas:** `CLIENT-TRACKING`
- **Depends on:** `CPO-WAYPOINTS`
- **Why:** Closes the propagation gap: inject MissionEventsService + TelemetryService into mission-lead.service.ts so auto-dispatch status flips emit WS frames and the lead's GPS fix mirrors to mission_telemetry_last/Redis. Overlaps CPO-WAYPOINTS in mission-lead.service.ts (pushTelemetry) and agent.service.ts, so sequence after it. Also fixes the client header label keyed off LIVE-only. Best validated with AUTO_DISPATCH on staging.

### Phase 10: P10 · monitor map progress line

- **Areas:** `MONITOR-MAP`
- **Depends on:** `CLIENT-TRACKING`, `CPO-WAYPOINTS`
- **Why:** Consumes the now-propagating live position (P9) and waypoint state (P8) to draw the pickup(A) marker, shortest-route highlight, and traveled/remaining two-tone progress line on the client LiveTrackingScreen + ops-console map. Shares AgentLiveTrackerScreen.tsx and LiveTrackingScreen.tsx with the tracking/live-monitor work; build last in the tracking cluster so the data it visualizes is real, not simulated.

### Phase 11: P11 · client cancel → mission ABORTED

- **Areas:** `MISSION-CANCEL`
- **Depends on:** `MISSION-HISTORY`
- **Why:** Adds 'CANCELLED' to org-mission.service.ts listMissions (so an aborted-via-cancel mission shows in agency history) — a direct edit to the same query MISSION-HISTORY/SP-MISSION-DETAIL modify, so sequence after they settle. Adds the protection-active cutoff (mission LIVE/SOS blocks cancel — the booking FSM can't enforce it because the booking stays CONFIRMED) and the in-txn mission→ABORTED + crew capacity-free. Money-adjacent: runs inside the existing escrow cancel txn and must NOT change refund math; finance sign-off still pending on cancelFeePct placeholder.

## Cross-cutting risks (read before starting)

- SHARED ROOT CAUSE — WS transport / JWT_ACCESS_SECRET drift (MSG-RECONNECT) underlies multiple symptoms: LIVE-MONITOR-CHAT 'keeps connecting', DEPT-CHAT messages-not-sending, CALLS-GROUP 'no-transport', and general messaging/history. Fix the deploy drift FIRST or every downstream chat/call fix will appear broken in the field. The reconnect storm also has a code amplifier (no attempt cap) that must fail-closed to 'unauthorized', never skip verification.
- ARCHITECTURE-GATED GROUP CRYPTO (LOCKED) — MISSION-GROUP (makeAssignedGroup / externally-assigned group id with derivation-verify skipped), DEPT-CHAT (silent-partial-fan-out + addGroupMember unknown-group), and CALLS-GROUP (FrameCryptor fail-closed gate) all touch group master-key distribution and require System Architecture sign-off. Rule: HARDEN ONLY — never add a skip-verification/skip-auth/dev branch; keep signGroupCreate, sender-cert verify, epoch/rekey intact; run packages/messenger-core/__tests__/logAudit.test.ts + test:crypto.
- SHARED RUNTIME SIGNATURE CHANGE — productionRuntime.createGroupChat is edited by BOTH MISSION-GROUP and DEPT-CHAT (return failures[]/result shape) and is a widely-called method (1:1 create, group create, ops-room create). Changing it breaks all callers + typecheck/test:crypto. Land the shared change once in P4 and update every caller together.
- messenger-core ⇄ mobile groupClient.ts MIRROR — makeAssignedGroup (MISSION-GROUP) must be added to packages/messenger-core/src/groups/groupClient.ts AND src/modules/messenger/groups/groupClient.ts; groupClientMirror.test.ts enforces parity or the suites drift.
- KEYCHAIN DATA-LOSS LANDMINE (MSG-RECONNECT) — getOrCreateDbKey/getOrCreateCompartmentDbKey mint-on-miss permanently bricks SQLCipher history on a transient keystore miss; the fix is security-gated (key handling) and must only retry-before-mint, never overwrite on an ambiguous read, and must still mint freely for genuine fresh installs (existsForOwner guard).
- NEVER LOG PLAINTEXT/KEYS — DEPT-CHAT @mention tokens ride INSIDE the already-E2EE message body; any logging of the parsed mention/body leaks plaintext and fails logAudit. Same caution on MISSION-GROUP conversation-id+key-byte logging.
- MONEY/ESCROW CONSERVATION — MISSION-CANCEL aborts the mission inside the existing escrow cancel txn and must NOT reorder/duplicate refund math; RATING-CARD's jobs_total backfill SET must exactly match the going-forward increment definition or the column re-drifts; FX/platformFee/cancelFee remain finance-gated placeholders (no AUTO_DISPATCH flip without CFO sign-off).
- IDOR ON NEW ORG ENDPOINTS — MISSION-HISTORY and SP-MISSION-DETAIL add org-scoped reads that must replicate the assigned_provider_user_id tenant gate (copy getMissionLive's WHERE) + negative ForbiddenException specs; they expose client PII (display_name only — never phone/email) and managed-CPO payout figures (finance confirm).
- AUTO_DISPATCH STILL FLAG-GATED — CLIENT-TRACKING, CALLS-GROUP mission-room, MISSION-GROUP, CPO-WAYPOINTS realtime, and MISSION-CANCEL abort are only fully observable with AUTO_DISPATCH enabled on staging; several need a dispatch-eligible seeded agency to test end-to-end.
- iOS GROUP CALLS OUT OF SCOPE — CALLS-GROUP / mission-room calls are Android-only (FrameCryptor native module is Android-only); making them work on iOS is a separate security-gated native-crypto epic, not a code tweak.

## Shared files (sequencing / merge-conflict hazards)

| File                                                                                                         | Touched by                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/messenger/runtime/productionRuntime.ts`                                                       | `DEPT-CHAT`, `MISSION-GROUP`, `CALLS-GROUP`, `MSG-RECONNECT`                                                                                      |
| `packages/messenger-core/src/groups/groupClient.ts (+ src/modules/messenger/groups/groupClient.ts mirror)` | `MISSION-GROUP`                                                                                                                                         |
| `src/modules/messenger/orgWorkspace/dispatchRoomIntents.ts`                                                | `MISSION-GROUP`, `CALLS-GROUP`, `LIVE-MONITOR-CHAT`                                                                                                 |
| `src/modules/messenger/orgWorkspace/membershipIntents.ts`                                                  | `DEPT-CHAT`, `MISSION-GROUP`                                                                                                                          |
| `apps/auth-service/src/org/org-mission.service.ts`                                                         | `MISSION-HISTORY`, `SP-MISSION-DETAIL`, `MISSION-CANCEL`                                                                                            |
| `apps/auth-service/src/org/org.controller.ts`                                                              | `MISSION-HISTORY`, `SP-MISSION-DETAIL`                                                                                                                |
| `apps/auth-service/src/org/org-cpo.service.ts`                                                             | `MISSION-HISTORY`                                                                                                                                       |
| `src/screens/agent/OrgMissionsScreen.tsx`                                                                  | `MISSION-HISTORY`, `SP-MISSION-DETAIL`                                                                                                                |
| `src/components/mission/MissionStepper.tsx`                                                                | `MISSION-HISTORY`, `SP-MISSION-DETAIL`                                                                                                                |
| `src/navigation/types.ts`                                                                                  | `MISSION-HISTORY`, `SP-MISSION-DETAIL`                                                                                                                |
| `src/navigation/AgentNavigator.tsx`                                                                        | `MISSION-HISTORY`, `SP-MISSION-DETAIL`                                                                                                                |
| `src/screens/booking/missionJourney.ts`                                                                    | `SP-MISSION-DETAIL`, `MISSION-HISTORY`, `CLIENT-TRACKING`, `MISSION-CANCEL`                                                                       |
| `apps/auth-service/src/agents/mission-lead.service.ts`                                                     | `CPO-WAYPOINTS`, `CLIENT-TRACKING`                                                                                                                    |
| `apps/auth-service/src/agents/agent.service.ts`                                                            | `CPO-WAYPOINTS`, `CLIENT-TRACKING`, `MISSION-HISTORY`                                                                                               |
| `src/modules/messenger/webrtc/launchCall.ts`                                                               | `CALLS-GROUP`, `LIVE-MONITOR-CHAT`                                                                                                                    |
| `src/screens/agent/AgentLiveTrackerScreen.tsx`                                                             | `MONITOR-MAP`, `LIVE-MONITOR-CHAT`, `SP-MISSION-DETAIL`, `MISSION-HISTORY`                                                                        |
| `src/screens/messenger/ChatScreen.tsx`                                                                     | `CALLS-GROUP`, `DEPT-CHAT`, `LIVE-MONITOR-CHAT`                                                                                                     |
| `src/screens/liveops/LiveTrackingScreen.tsx`                                                               | `CLIENT-TRACKING`, `MONITOR-MAP`                                                                                                                      |
| `apps/auth-service/src/ops/ops.service.ts`                                                                 | `RATING-CARD`, `MISSION-CANCEL`                                                                                                                       |
| `apps/auth-service/src/settlement/settlement.service.ts`                                                   | `MISSION-GROUP`, `RATING-CARD`                                                                                                                        |
| `src/services/api.ts`                                                                                      | `MISSION-HISTORY`, `SP-MISSION-DETAIL`, `REGION`, `CALLS-GROUP`, `LIVE-MONITOR-CHAT`, `CLIENT-TRACKING`, `MISSION-GROUP`, `CPO-WAYPOINTS` |
| `src/utils/constants.ts (+ canonical regions module)`                                                      | `REGION`                                                                                                                                                |

## Coverage check (did we map all 20 asks?)

**Covered:**

- #1/#11/#14(messenger) reconnect+messages-not-sent+disappearing history → MSG-RECONNECT
- #5(partial) messenger history disappears → MSG-RECONNECT
- #2 1:1 call End-doesn't-end + Back-should-minimize → CALLS-1to1
- #2nd SP tap-mission detail page → SP-MISSION-DETAIL
- #3rd pickup+dropoff both required → BOOKING-WIZARD
- #4th Driver-only-Client-Vehicle vehicle_count<1 → BOOKING-WIZARD
- #3 CPO completed-mission history in roster + SP all-completed count+steps → MISSION-HISTORY
- #5(partial) dept chat SP can post but CPO can't see → DEPT-CHAT
- #15/#18 departmental chat not working → DEPT-CHAT
- #16 Discord-like manager channel/add-CPO/announcement/@mention + SP-adds-manager → DEPT-CHAT
- #16(2nd)/#20 audit+wire each dept-chat feature → DEPT-CHAT
- #6/#6th mission group add assigned CPOs + archive-on-complete → MISSION-GROUP
- #7/#7th group call buttons present but call fails → CALLS-GROUP
- #9(partial) mission-accepted group call fails audio+video → CALLS-GROUP / MISSION-GROUP
- #8 Region setting + detect/change/N/A + client↔SP region match → REGION
- #9/#9th live-monitor composer keeps connecting/records infinitely + mission group call → LIVE-MONITOR-CHAT
- #10 monitor pickup mark + shortest-route highlight + A→B progress line → MONITOR-MAP
- #10(2nd) rating card shows 0 jobs → RATING-CARD
- #12 CPO multiple waypoints fill as he advances → CPO-WAYPOINTS
- #13 client status+live-tracking parity + realtime no-reload + statuses-not-changing → CLIENT-TRACKING
- #14 client cancel → mission ABORTED + history + 1h window + protection-active cutoff → MISSION-CANCEL

**Missing / unclear / needs your decision:**

- #17 — no area spec references requirement #17 (gap: unmapped original ask, needs clarification/spec)
- #19 — no area spec references requirement #19 (gap: unmapped original ask, needs clarification/spec)
- ✅ RESOLVED (2026-06-25, then REVERSED same day) — iOS group calls (CALLS-GROUP/MISSION-GROUP): **now IN SCOPE on both iOS and Android.** The iOS native-crypto enablement is specced in **Addendum B — iOS group calls**. See "Decisions locked" §1.
- ✅ RESOLVED (2026-06-25) — ZA/South-Africa region + ZAR (REGION): **include ZA in v1** (regions AE/SA/BD/GB/ZA); user authorized, no sign-off gate; only the ZAR FX rate *value* must be set to a real number. See "Decisions locked" §2.
- ✅ RESOLVED (2026-06-25) — escrow/payout on SP mission-detail page (SP-MISSION-DETAIL): **build a new org-scoped `GET /org/missions/:id/escrow` endpoint now** (IDOR-gated by assigned_provider_user_id) and show the payout/hold block; figures get a finance review but ship this batch. See "Decisions locked" §3.

### Sequencing notes

SHIP-FIRST / DEPLOY vs CODE: MSG-RECONNECT's JWT_ACCESS_SECRET alignment is a DEPLOY/ops action (compare auth-service vs messenger-service env, force-recreate the messenger container) and should be done before any other chat/call work — it is the cheapest, highest-leverage fix and unmasks the real state of DEPT-CHAT, CALLS-GROUP, and LIVE-MONITOR-CHAT. Other deploy/config items: REGION needs MAPBOX_ACCESS_TOKEN present in auth-service env (else detection always returns N/A) and a new users.home_region migration; MISSION-GROUP/DEPT-CHAT use existing migrations (no new schema for archive); RATING-CARD needs a one-time backfill migration applied on staging; MISSION-HISTORY/SP-MISSION-DETAIL/MISSION-CANCEL are code-only on existing schema.

ARCHITECTURE SIGN-OFF GATES (do not start coding until signed off): MSG-RECONNECT keychain + auth-refresh-cap; MISSION-GROUP externally-assigned group id; DEPT-CHAT createGroupChat/addGroupMember error-surfacing; CALLS-GROUP must keep the FrameCryptor fail-closed gate. These are the P1/P4/P5 blockers — schedule the architecture review early so P4 isn't stalled.

PARALLELIZABLE: P2 (BOOKING-WIZARD, REGION) and P3 (CALLS-1to1) can run alongside P1 — no shared files. P6 (RATING-CARD, MISSION-HISTORY) is backend/auth-service-only and parallelizes with the P4/P5 messenger-crypto stream (different teams, different files). The two work-streams converge only at src/services/api.ts (high-churn shared client) — coordinate merges there.

STRICT ORDERINGS (dependency, not just preference): (1) MISSION-GROUP membership BEFORE CALLS-GROUP/LIVE-MONITOR group calls — no CPOs in the room ⇒ no group key ⇒ call fails. (2) MISSION-HISTORY BEFORE SP-MISSION-DETAIL and BEFORE MISSION-CANCEL — all three edit org-mission.service.ts; history is the data source the detail page links into and MISSION-CANCEL only adds CANCELLED to the same listMissions filter. (3) CPO-WAYPOINTS (waypoint settling) → CLIENT-TRACKING (realtime propagation from mission-lead.service.ts) → MONITOR-MAP (visualize live position + waypoint state) — each consumes the prior's data and they overlap in mission-lead.service.ts / AgentLiveTrackerScreen.tsx. (4) The shared createGroupChat return-shape change must be made once in P4 and propagated to all callers before CALLS-GROUP builds on it.

MERGE-CONFLICT HOTSPOTS to serialize rather than parallelize: org-mission.service.ts (MISSION-HISTORY→SP-MISSION-DETAIL→MISSION-CANCEL), productionRuntime.ts (DEPT-CHAT+MISSION-GROUP), mission-lead.service.ts (CPO-WAYPOINTS→CLIENT-TRACKING), AgentLiveTrackerScreen.tsx (LIVE-MONITOR-CHAT + MONITOR-MAP), and src/services/api.ts (almost everything — land each area's client additions in small, frequent merges).

GATES throughout (per CLAUDE.md): write the failing test first; run the narrow suite then the broad (test:crypto for any messenger/crypto change incl. logAudit; auth-service npm test for backend; --selectProjects=booking for booking; mobile typecheck must stay ≤ baseline 96/49 and ops-console typecheck). Do not commit on a red gate. Several fixes (CLIENT-TRACKING, CALLS-GROUP mission-room, MISSION-GROUP, MISSION-CANCEL) need a 3-device manual smoke with AUTO_DISPATCH enabled and a dispatch-eligible seeded agency — treat that as the final acceptance step, not unit tests.

---

# Detailed area specs

## 1. MSG-RECONNECT — Messenger WS reconnect loop, messages-not-sent, and disappearing chat history 🔒 (architecture sign-off required)

**Covers your requests:**

- #1/#11/#14: messenger keeps reconnecting and connecting; messages are not sent; messages disappear.
- #5 (partial): for the messenger module, why does the chat history disappear? check it.
- Distinguish CODE bug vs DEPLOY/config drift for the reconnect loop (JWT-secret drift vs ping-ack vs client backoff vs token-refresh expiry).
- Determine whether disappearing history is the keychain/db-key issue (B-15b) vs disappearing-message expiry vs a re-key/reset.

### Root cause

Three independent root causes behind the user's three symptoms.

A. RECONNECT LOOP = JWT_ACCESS_SECRET drift between auth-service and messenger-service (DEPLOY/config, not code). Every WS handshake fails signature verification (gateway:312), is reported to the client as code='unauthorized' (gateway:2066-2073), the client triggers a token refresh + reopen (client.ts:318-339), and the freshly-minted token still fails against the wrong server secret → infinite reconnect+refresh. A secondary CODE gap amplifies it: the client's unauthorized-refresh path has no attempt cap/backoff (client.ts:324-339, 359-387), so a persistent reject becomes an unbounded refresh storm rather than terminating in 'unauthorized'.

B. MESSAGES NOT SENT = downstream of (A): the HTTP relay verifies the same drifted JWT secret, so relay.send 401s and the outbox row backs off to 'failed' (relayClient.ts:114-151 → productionRuntime.ts:1806-1817). The send/outbox machinery itself is sound.

C. HISTORY DISAPPEARS (code bug, live on main) = mint-on-miss in getOrCreateDbKey/getOrCreateCompartmentDbKey (keychain.ts:127-140, 186-199): a single flaky Keychain.getGenericPassword miss causes a brand-new SQLCipher key to overwrite the real one, after which the existing per-owner DB file (runtime.ts:592) can no longer be decrypted (db.ts:372-404) and the corruption is persisted for all future boots. The `readKeychainWithRetry` hardening that MEMORY claims fixed this is NOT present in the codebase (grep: 0 hits). Disappearing-message expiry is ruled out as a whole-history cause (no global TTL; per-message only; restore grace window).

### Current behavior (as built)

RECONNECT LOOP — two layered causes, one DEPLOY and one CODE.

(1) DEPLOY/CONFIG DRIFT (the dominant cause of "keeps reconnecting and connecting"). messenger-service verifies the access JWT on every WS handshake: `const claims = await this.jwt.verifyAccessToken(token)` (apps/messenger-service/src/gateway/messenger.gateway.ts:312). Its secret comes from `accessSecret: process.env['JWT_ACCESS_SECRET']` (apps/messenger-service/src/config/configuration.ts:42), and configuration.ts:5-6 explicitly warns it "MUST read the SAME env var (JWT_ACCESS_SECRET)" as auth-service. If the two containers drift (auth redeployed, messenger not — see MEMORY note `messenger-ws-jwt-secret-drift`), `verifyAccessToken` throws "invalid signature", the catch does `next(handshakeError(msg))` (gateway:328-332), and `handshakeError` ALWAYS stamps `code: 'unauthorized'` regardless of reason (gateway:2066-2073: "const code = ... ? 'unauthorized' : 'unauthorized'"). The client's `connect_error` handler then sees `err.data.code === 'unauthorized'` → `isAuthReject = true` (src/modules/messenger/transport/client.ts:318-324) → disconnects, calls `refreshToken()`, reopens (client.ts:324-339). The fresh token is signed with auth's (correct) secret but messenger still verifies with the WRONG secret → "invalid signature" again → loop. The HTTP relay path verifies the same JWT with the same wrong secret, so HTTP fallback also 401s — which is why messages also stop sending. This is config drift, NOT a code defect.

(2) CODE HARDENING GAP — the unauthorized-refresh path has NO attempt cap or backoff. Both the inline-error branch (client.ts:359-387) and the connect_error branch (client.ts:324-339) reset `unauthorizedRefreshInFlight=false` in `.then()` and immediately call `this.open()` again. On a PERSISTENT auth reject (secret drift, clock skew, or a refresh that returns a token the server still rejects) this becomes an unbounded refresh storm against auth-service `/auth/refresh` — one refresh per failed handshake, forever, with the UI pinned on "reconnecting". There is no max-attempt fuse that finally lands on `unauthorized` and stops.

(3) B-05 server WS drop (backend, separate): apps/messenger-service/src/main.ts has NO `process.on('uncaughtException')`/`('unhandledRejection')` guards and ends with bare `void bootstrap()` (main.ts:98) — an unhandled throw crashes the process and drops every socket simultaneously, producing synchronized client reconnect churn (sqa.md B-05, 15/15 calls killed). heartbeatGrace is 25000 in config (configuration.ts:26) but main.ts:30 keeps a stale `?? 10_000` fallback that bites only if the config key is unresolved.

PING-ACK (B-05 keepalive) is already FIXED in code: handlePing emits the `pong` event AND returns an event-less ack (gateway:703-720) — so this is NOT the cause of the current loop.

MESSAGES NOT SENT — the send path is otherwise robust: every send is persisted to a durable outbox BEFORE shipping (productionRuntime.ts:1760-1772 → sqlOutboxStore.enqueue), WS send is fire-and-forget with a 5s ack-watchdog that force-reconnects + retries over HTTP (productionRuntime.ts:1843-1855), `envelope.accepted` clears the pending + outbox row (handleAccepted, productionRuntime.ts:3461-3483), and `drainOutbox` replays due rows on every reconnect (productionRuntime.ts:4956-5011, wired at :776). So "messages not sent" is a DOWNSTREAM symptom: when both WS and HTTP relay are rejected by the drifted JWT secret, `relay.send` 401s → refresh → still 401 → throw → message flips to 'failed' and the outbox row backs off (sqlOutboxStore.recordAttempt, MAX_ATTEMPTS=10).

HISTORY DISAPPEARS — PRIMARY ROOT CAUSE is a live data-loss landmine in the keychain read path. `getOrCreateDbKey` (src/modules/messenger/runtime/keychain.ts:127-140) does a SINGLE `Keychain.getGenericPassword({service})` (keychain.ts:129); if that read transiently returns `false` (a known-flaky Android keystore miss on cold boot / under load), `existing` is falsy and the function MINTS A NEW random 32-byte key and overwrites the real one via `setStrictGenericPassword` (keychain.ts:134-138). `getOrCreateCompartmentDbKey` has the identical mint-on-miss flaw (keychain.ts:191-198). The DB file is scoped by ownerKey, not by the key value (runtime.ts:592 `messenger-${slug}-${Platform.OS}.db`), so the existing encrypted file is then re-opened with the WRONG key in `openCryptoDb` (resolveOwnStore, runtime.ts:591-593) → the first real statement fails ("file is not a database" / HMAC mismatch, db.ts:372-404) → runtime init throws and the chat shows empty. Because the wrong key is now PERSISTED, the next cold boot reads it back and fails identically — the account is bricked on that device until reinstall/restore. The MEMORY note `b15b-keychain-read-hardening` says a `readKeychainWithRetry` guard was written to close exactly this landmine, but a grep of src/ shows ZERO occurrences of `readKeychainWithRetry` — the fix was never landed on main. sqa.md B-15b documents the same chain: "keychain-miss → forced RESTORE → orphaned in-flight msgs → ACK-drop".

DISAPPEARING-MESSAGE EXPIRY is NOT a blanket wipe: ExpirySweeper only removes messages whose `expires_at` is set and elapsed (src/modules/messenger/runtime/expirySweeper.ts:117), there is no global/default TTL (privacySettings.ts has no expires_at/ttl field — grep returned no matches), and a 5-minute post-restore grace window suppresses sweeps right after a restore (expirySweeper.ts:45-59,110). So the sweeper can only drop individual timed messages, not whole history.

INBOUND "messages disappear" (secondary): handleDeliver ACK-drops any envelope that fails to decrypt for a non-recoverable reason and then acks it off the relay (productionRuntime.ts:3740-3769) — so a first inbound on a re-established session can be silently lost (sqa.md B-15b/B-30, "first-inbound-on-reconnect silent drop is unrecoverable").

wipeUserAtRest (src/modules/messenger/runtime/wipeAtRest.ts:78-178) deletes the DB file + all keychain keys; if signOut is ever triggered spuriously (e.g. a misclassified token-revoke), it wipes history — worth guarding but not the primary cause.

### Key files

| File                                                        | Role                                                                                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/messenger/transport/client.ts`               | WS TransportClient: reconnect/backoff state machine, unauthorized-refresh loop (no attempt cap), connect_error/error classification      |
| `src/modules/messenger/transport/relayClient.ts`          | HTTP relay client: send/pull/ack with single 401-refresh retry — fails when JWT secret drifts                                           |
| `src/modules/messenger/runtime/keychain.ts`               | PRIMARY history-loss landmine: getOrCreateDbKey / getOrCreateCompartmentDbKey mint-on-miss with no read retry                            |
| `src/modules/messenger/runtime/runtime.ts`                | resolveOwnStore: opens the SQLCipher DB with getOrCreateDbKey(persistenceKey) (line 591-593)                                             |
| `src/modules/messenger/crypto/db.ts`                      | openCryptoDb: throws on wrong-key open (line 335-415) — where the minted-key file becomes undecryptable                                 |
| `src/modules/messenger/runtime/productionRuntime.ts`      | Transport wiring, send path + ack-watchdog + httpFallback (1760-1862), handleAccepted/handleDeliver (3461-3780), drainOutbox (4956-5011) |
| `src/modules/messenger/store/sqlOutboxStore.ts`           | Durable outbox: enqueue/dueRows/markDelivered/recordAttempt — the retry backbone for un-acked sends                                     |
| `src/modules/messenger/runtime/expirySweeper.ts`          | Disappearing-message sweep (per-message expires_at only, 5-min restore grace) — ruled OUT as blanket history wipe                       |
| `src/modules/messenger/runtime/wipeAtRest.ts`             | wipeUserAtRest: destroys DB + keys on signOut — spurious trigger = history loss                                                         |
| `apps/messenger-service/src/gateway/messenger.gateway.ts` | WS handshake JWT verify (312), handshakeError always 'unauthorized' (2066-2073), ping-ack fixed (703-720)                                |
| `apps/messenger-service/src/config/configuration.ts`      | jwt.accessSecret (42) must equal auth-service JWT_ACCESS_SECRET; ws.heartbeatGrace 25000 (26)                                            |
| `apps/messenger-service/src/main.ts`                      | Boot: no process.on crash guards, bare void bootstrap() (98), stale heartbeatGrace ?? 10_000 (30)                                        |
| `apps/messenger-service/src/gateway/redis-io.adapter.ts`  | socket.io pingInterval/pingTimeout + connectionStateRecovery (94-97) wiring                                                              |

### Proposed changes (per file)

**1. `apps/messenger-service deploy config (ops, no source change)`**

- **Change:** Verify auth-service and messenger-service run with the SAME JWT_ACCESS_SECRET (and JWT_ISSUER/JWT_AUDIENCE). Compare the two containers' env; if drifted, recreate bravo-staging-msgr via the staging compose so it inherits the current secret (per MEMORY messenger-ws-jwt-secret-drift). Confirm /healthz green and a single client connects without a reconnect loop.
- **Why:** This is the dominant cause of the reconnect+messages-not-sent symptoms; it is configuration, not code.
- **Risk:** Low — recreating the messenger container briefly drops live WS; clients auto-reconnect. Must NOT change the secret value, only align it.

**2. `src/modules/messenger/runtime/keychain.ts`**

- **Change:** Add a private `readKeychainWithRetry(service, attempts=3, delayMs=120)` helper that calls Keychain.getGenericPassword and retries on a falsy result (and on throw) before giving up. Route getOrCreateDbKey (129), hasDbKey (170,174), getOrCreateCompartmentDbKey (191), loadCompartmentDbKey (210), loadLegacyDbKey (226), loadMirrorMasterKey (273), getOrCreateGroupWrapKey (321), getOrCreateMerkleSeqHmacKey (365) through it. CRITICAL: in getOrCreateDbKey and getOrCreateCompartmentDbKey, only mint+write a NEW key when the retried read is CONCLUSIVELY empty AND no DB file exists for this owner — never overwrite on an ambiguous miss.
- **Why:** Closes the live data-loss landmine: a transient keystore read miss currently overwrites the real DB key and bricks history permanently.
- **Risk:** SECURITY-GATED (key handling). The change only HARDENS (retry-before-mint); it must not alter key derivation, length, or the mint path for genuine fresh installs. Needs architecture sign-off + the existing keychain/restore tests.

**3. `src/modules/messenger/transport/client.ts`**

- **Change:** Add an `unauthorizedRefreshAttempts` counter and a small backoff. In both the connect_error auth-reject branch (324-339) and the inline error branch (359-387): increment on each attempt, and after a cap (e.g. 4) stop refreshing, set closedByUser-equivalent stop + setState('unauthorized'), and surface a distinct state so the UI shows an actionable error instead of a perpetual 'reconnecting'. Reset the counter to 0 inside the socket.on('connect') success handler (284-306).
- **Why:** Prevents an unbounded refresh storm against auth-service when the reject is persistent (secret drift, clock skew); makes the failure visible instead of an endless spinner.
- **Risk:** SECURITY-GATED (auth-token refresh). Must NOT weaken verification or add a skip-auth branch — it only bounds retries and then fails closed to 'unauthorized'.

**4. `apps/messenger-service/src/main.ts`**

- **Change:** Before `void bootstrap()` (98), register `process.on('uncaughtException', err => logger.error(...))` and `process.on('unhandledRejection', ...)` that log and (optionally) trigger a graceful shutdown rather than letting Node crash silently; and change `void bootstrap()` to `bootstrap().catch(err => { console.error(...); process.exit(1); })` so boot failures are visible to the process manager. Also drop the stale `?? 10_000` on line 30 (rely on configuration.ts default 25000) to avoid a low grace if the config key ever fails to resolve.
- **Why:** Addresses B-05 mass-drop reconnect churn from process crashes and removes a heartbeat-grace footgun.
- **Risk:** Low. Adding crash guards must not swallow fatal errors that should restart the pod — pair with the PM2/systemd restart policy noted in sqa.md.

**5. `src/modules/messenger/runtime/wipeAtRest.ts (guard only)`**

- **Change:** Confirm wipeUserAtRest is only ever called from an explicit user signOut/account-delete, never from a transport 'unauthorized' or token-revoke path. Add a one-line assertion/log at the call site (authStore.signOut) so an accidental wipe is traceable. No behavior change unless a spurious caller is found.
- **Why:** Defense-in-depth against history loss via an unintended wipe trigger.
- **Risk:** Low — investigative; only add logging unless a bad caller is found.

### Step-by-step prompts for Claude

_Hand these to Claude one at a time, in order._

> **Step 1:** STEP 1 (DEPLOY, do first — fixes reconnect + messages-not-sent if it is drift): SSH to the staging host (admin@94.136.184.52 per MEMORY). Print the JWT_ACCESS_SECRET, JWT_ISSUER, JWT_AUDIENCE env for BOTH the auth-service container and the messenger-service container (bravo-staging-msgr). If JWT_ACCESS_SECRET differs, recreate the messenger container from the staging compose so it picks up the same secret: `docker compose -f docker-compose.staging.yml up -d --force-recreate bravo-staging-msgr`. Then connect ONE device, watch messenger-service logs for `[handshake] reject verify_throw ... invalid signature`; if those lines stop and the client reaches `ws open`, the loop is the secret drift and is now fixed. Do NOT change the secret value, only align the two services.

> **Step 2:** STEP 2 (diagnose, no code change): On a device exhibiting the loop, capture adb logcat and grep for the client transport state transitions and `unauthorized`/`refresh` lines from src/modules/messenger/transport/client.ts. Simultaneously tail messenger-service logs for the gateway:312/328 handshake reject lines. Confirm whether the reject reason is `invalid signature` (secret drift), `expired`/`exp` (clock skew / token TTL), or `token_revoked` (logout). Record which, because STEP 1 only fixes the signature case.

> **Step 3:** STEP 3 (CODE — history loss, highest-leverage code fix): In src/modules/messenger/runtime/keychain.ts add `async function readKeychainWithRetry(service: string, attempts = 3, delayMs = 120)` that loops attempts, calls `await Keychain.getGenericPassword({service})`, returns the credential on a truthy/>=64-len result, sleeps delayMs on a falsy result or caught error, and returns false after the last attempt. Replace the single reads at lines 129, 170, 174, 191, 210, 226, 273, 321, 365 with this helper.

> **Step 4:** STEP 4 (CODE — history loss, the actual guard): In getOrCreateDbKey (keychain.ts:127-140) and getOrCreateCompartmentDbKey (186-199), only fall through to the mint+`setStrictGenericPassword` branch when readKeychainWithRetry returned CONCLUSIVELY empty after all retries. Add a guard that, before minting, checks whether a DB file already exists for this owner (import a tiny existsForOwner helper, or pass a flag from resolveOwnStore) and if so THROW a typed `KeychainReadMissError` instead of minting — so the runtime surfaces 'temporary unlock problem, retry' rather than silently overwriting the real key. Wire resolveOwnStore (runtime.ts:591) to catch that error, NOT mint, and abort boot with a ret`able state.

> **Step 5:** STEP 5 (CODE — reconnect storm cap): In src/modules/messenger/transport/client.ts add a private field `private unauthorizedRefreshAttempts = 0;` and `private static readonly MAX_UNAUTH_REFRESH = 4;`. In both auth-reject branches (connect_error 324-339 and inline error 359-387), before kicking refresh, do `if (this.unauthorizedRefreshAttempts >= TransportClient.MAX_UNAUTH_REFRESH) { this.closedByUser = true; this.setState('unauthorized'); try { socket.disconnect(); } catch {} return; }` then `this.unauthorizedRefreshAttempts++;`. In the socket.on('connect') success handler (284-306) reset `this.unauthorizedRefreshAttempts = 0;`. Add a short backoff (e.g. await a 500ms*attempt delay) inside the refresh `.then()` before `this.open()`.

> **Step 6:** STEP 6 (CODE — backend crash guards): In apps/messenger-service/src/main.ts, immediately before `void bootstrap()` (line 98) add `process.on('uncaughtException', e => console.error('[messenger-service] uncaughtException', e));` and `process.on('unhandledRejection', e => console.error('[messenger-service] unhandledRejection', e));`. Change `void bootstrap();` to `bootstrap().catch(e => { console.error('[messenger-service] bootstrap failed', e); process.exit(1); });`. Remove the `?? 10_000` on line 30 so heartbeatGrace falls back to the configuration.ts default (25000) only.

> **Step 7:** STEP 7 (CODE — wipe guard, investigative): Open authStore.signOut (the only intended caller of wipeUserAtRest) and confirm no transport 'unauthorized'/token-revoke handler calls it. Add a single `console.log('[wipeAtRest] invoked by signOut owner=' + ownerKey)` breadcrumb at the call site. If any non-signOut caller is found, gate it behind explicit user intent.

> **Step 8:** STEP 8 (TESTS): Add a keychain test that mocks Keychain.getGenericPassword to return `false` once then a real credential, and asserts getOrCreateDbKey returns the REAL credential and never calls setGenericPassword (proves no mint-on-flaky-miss). Add a transport test that drives repeated connect_error{code:'unauthorized'} and asserts refresh is called at most MAX_UNAUTH_REFRESH times then state becomes 'unauthorized'. Run `npm run test:crypto` and the transport/keychain suites.

> **Step 9:** STEP 9 (VERIFY): Rebuild the staging APK, cold-boot on a device, confirm chat history is present after several cold boots (keychain retry holds), send a 1:1 and a group message and confirm delivery, then kill networking briefly and confirm reconnect + outbox drain without a refresh storm in logs.

### ⚠️ Regressions this could introduce (guard against these)

- readKeychainWithRetry that throws instead of minting could BLOCK a legitimate fresh install if the existsForOwner check is wrong — guard by minting freely when NO DB file exists for the owner; only refuse-and-retry when a file is present. Cover with a fresh-install test (no file → mint succeeds).
- Adding retries/backoff to keychain reads lengthens cold-boot time; keep attempts low (3) and delay short (~120ms) so worst case adds <0.5s. Verify boot timing on a low-end device.
- The transport refresh cap, if reset in the wrong place, could permanently strand a recoverable socket in 'unauthorized'. Reset the counter ONLY on a successful socket connect, and ensure a manual app-foreground/forceReconnect clears closedByUser so the user can recover after fixing connectivity.
- Backend process.on('uncaughtException') handlers that swallow errors can mask a fatal state and keep a zombie process alive. Pair with a process manager restart policy and DO log+exit on truly fatal boot errors (the bootstrap().catch path).
- Touching auth-token refresh or the SQLCipher key path risks weakening security gates — these are LOCKED. Changes must only HARDEN (retry-before-mint, cap-then-fail-closed) and must not add any skip-verification/skip-auth branch; run the log-audit test and get architecture sign-off.
- Any change near handleDeliver/ACK-drop is out of scope here but note: do not 'fix' the inbound ACK-drop by skipping verification — that is the B-15b/B-30 first-message path and is security-sensitive.

### Tests / verification

- npm run test:crypto (messenger-crypto Jest project — covers keychain, restore, transport, receive paths)
- Targeted: the keychain unit test (mint-on-miss regression) + a transport unit test (refresh-attempt cap) added in STEP 8
- apps/messenger-service: npm test (gateway handshake + ping-ack + relay)
- npm run typecheck (mobile) and cd apps/ops-console && npm run typecheck — must not exceed baselines
- Manual smoke: cold-boot the staging APK 3-5x and confirm history persists (keychain retry); send+receive a 1:1 and a group message; toggle airplane mode and confirm reconnect + outbox drain with NO refresh storm in logcat; verify one device connects to messenger-service without a handshake-reject loop after the JWT-secret alignment

### Open questions / decisions needed

- Is the production/staging reconnect loop actually JWT_ACCESS_SECRET drift, or token-expiry/clock-skew? STEP 2 must confirm the handshake reject reason (invalid signature vs expired vs token_revoked) before assuming the deploy fix is sufficient.
- Does op-sqlite's open() with a WRONG key throw at first statement, or silently create/replace the file? Confirm on-device — it determines whether the minted-key case bricks (throw) or produces a visibly-empty chat (silent), and whether any auto-recreate path compounds the loss.
- MEMORY claims the readKeychainWithRetry/B-15b hardening shipped in a staging APK but it is absent from main — was it reverted, lost in a merge, or only ever local? Check git history for the commit before re-implementing to avoid duplicating an existing branch.
- Should the client distinguish 'auth temporarily unverifiable' (server secret drift) from 'token genuinely expired' so it does not burn refreshes on a server-side problem? Needs the handshake to return a more specific code than the blanket 'unauthorized' (gateway:2066-2073) — a small server change that would also help diagnosis.
- Confirm there is exactly one intended caller of wipeUserAtRest (authStore.signOut) and that no token-revoke/unauthorized path reaches it.

---

## 2. booking-wizard — Booking wizard: require pickup + dropoff; fix Driver-only-Client-Vehicle "vehicle_count must not be less than 1"

**Covers your requests:**

- #3rd: a client booking has pickup + dropoff location — both must be required; if either missing, block advancing to the next step.
- #4th: the booking option 'Driver only Client Vehicle' — turning it on then booking fails with 'vehicle count must not be less than 1'. Fix it.

### Current behavior (as built)

REQUIREMENT #4 (driver-only vehicle bug) — ROOT-CAUSED.

1) UI sets vehicle_count to 0 when the toggle is on. `src/screens/booking/CustomizeAddOnsScreen.tsx:107-114`:

```
const toggleDriverOnly = () => {
  const next = !driver_only;
  updateDraft({
    driver_only: next,
    vehicle_count: next ? 0 : minVehicles,   // ← line 111: driver-only ⇒ 0
    cpo_count: next ? Math.min(cpo_count, maxCposForClientVehicle(passengers)) : cpo_count,
  });
};
```

2) The store forwards that 0 to BOTH the create and the estimate API calls. `src/store/bookingStore.ts:204` (confirmBooking) `vehicle_count: draft.vehicle_count,` and `src/store/bookingStore.ts:170` (estimatePrice) `vehicle_count: draft.vehicle_count,`.
3) The backend DTO rejects 0. `apps/auth-service/src/booking/dto/create-booking.dto.ts:54-55`:

```
@IsOptional() @IsInt() @Min(1) @Max(4)
vehicle_count?: number;
```

and the identical rule on the estimate DTO at `dto/create-booking.dto.ts:95-96`. class-validator's `@IsOptional()` only skips validation when the value is `null`/`undefined`; the numeric `0` is "present", so `@Min(1)` runs and fails with the default message `vehicle_count must not be less than 1` (the user's "vehicle count must not be less than 1"). The global pipe is `whitelist:true, transform:true` (`apps/auth-service/src/main.ts:52-55`), which does not change this.

4) The service ALREADY expects/normalizes driver-only to 0, so the DTO validator is the *sole* blocker. `apps/auth-service/src/booking/booking.service.ts:249-250`:

```
const driverOnly = dto.driver_only ?? false;
const vehicleCount = driverOnly ? 0 : (dto.vehicle_count ?? 1);
```

and pricing handles 0 cleanly via `Math.max(0, input.vehicleCount - 1)` (`apps/auth-service/src/booking/pricing.service.ts:62`). Net: the request never reaches the service — it 400s at the DTO. Both the price estimate (driver-only) and the final submit fail.

REQUIREMENT #3 (pickup+dropoff required) — diagnosed.

The Next/CTA gate lives on the Schedule step. `src/screens/booking/BookingDateTimeScreen.tsx:191`:

```
const canContinue = Boolean(pickup);   // ← dropoff NOT required
```

The CTA uses it at `BookingDateTimeScreen.tsx:447` `disabled={!canContinue}` and `handleContinue` guards only pickup at `:193-194` `if (!canContinue || !pickup) {return;}`.

Worse, pickup is seeded with a HARDCODED non-null default when the draft has none, so "pickup required" is currently hollow — a user who never picks a pickup still advances with a Dubai placeholder. `BookingDateTimeScreen.tsx:112-116`:

```
const [pickup, setPickup] = useState<PickedLocation | null>(
  draft.pickup
    ? {address: draft.pickup.address ?? 'Pick-up', lat: draft.pickup.latitude, lng: draft.pickup.longitude}
    : {address: 'DIFC Gate Building 4, Dubai', lat: 25.2132, lng: 55.2806},  // ← default
);
```

dropoff correctly defaults to null (`:117-121`). The two location rows render at `:295-308`. The picked location round-trips through `LocationPickerScreen` confirm → navigates back with `pickedKind` and is merged at `BookingDateTimeScreen.tsx:148-166`. The backend DTO already treats dropoff as optional (`dto/create-booking.dto.ts:18` `@IsOptional() dropoff?: LocationDto;`) and the store sends `dropoff: draft.dropoff ?? undefined` (`bookingStore.ts:193`), so the required-ness must be enforced at the wizard step (the UI gate), which is where "advance to next step" happens.

### Key files

| File                                                        | Role                                                                                                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/screens/booking/BookingDateTimeScreen.tsx`           | Schedule step (#3): owns the pickup/dropoff rows, the canContinue gate, the hardcoded pickup default, and handleContinue → BaselinePackage.                   |
| `src/screens/booking/CustomizeAddOnsScreen.tsx`           | Team & Add-ons step (#4): the Driver Only (Client Vehicle) toggle that sets vehicle_count=0 (line 111).                                                        |
| `src/store/bookingStore.ts`                               | Forwards draft.vehicle_count (0 when driver-only) to estimate (line 170) and create (line 204); also confirmBooking pickup/dropoff body build (lines 192-193). |
| `apps/auth-service/src/booking/dto/create-booking.dto.ts` | THE bug for #4: @Min(1) on vehicle_count in CreateBookingDto (54-55) and EstimateBookingDto (95-96) rejects the legitimate driver-only 0.                      |
| `apps/auth-service/src/booking/booking.service.ts`        | Already normalizes driver-only ⇒ vehicleCount 0 (line 250); non-driver-only path lets a stray 0 pass through (?? only catches null/undefined).                |
| `apps/auth-service/src/booking/pricing.service.ts`        | Pricing math; already 0-safe (Math.max(0, vehicleCount-1) at line 62).                                                                                         |
| `apps/auth-service/src/main.ts`                           | Global ValidationPipe config (whitelist/transform, lines 52-55) — context for why 0 still fails @Min(1).                                                      |

### Proposed changes (per file)

**1. `apps/auth-service/src/booking/dto/create-booking.dto.ts`**

- **Change:** Change `@Min(1)` to `@Min(0)` on `vehicle_count` in BOTH CreateBookingDto (line 54: `@IsOptional() @IsInt() @Min(1) @Max(4)` → `@Min(0)`) and EstimateBookingDto (line 95, same). Keep `@IsOptional() @IsInt() @Max(4)` unchanged. This admits the driver-only 0 that the UI sends.
- **Why:** vehicle_count=0 is a legitimate value meaning 'client supplies the vehicle' (driver-only). The service and pricing already handle 0; the validator is the only thing rejecting it.
- **Risk:** Low. @Min(0) still rejects negatives and @Max(4) still caps. A non-driver-only caller could now send 0 — guarded by the service clamp below.

**2. `apps/auth-service/src/booking/booking.service.ts`**

- **Change:** Harden line 250 from `const vehicleCount = driverOnly ? 0 : (dto.vehicle_count ?? 1);` to `const vehicleCount = driverOnly ? 0 : Math.max(1, dto.vehicle_count ?? 1);` so a stray vehicle_count=0 with driver_only=false (now allowed past the relaxed DTO) cannot create a 0-vehicle, non-driver-only booking that still prices/dispatches as if it had a Bravo vehicle.
- **Why:** `?? 1` only substitutes for null/undefined, not 0. After relaxing @Min, a 0 with driver_only false would slip through; clamp it back to the 1-vehicle baseline.
- **Risk:** Low. Only affects the previously-impossible (rejected) input vehicle_count=0 && driver_only=false. No existing valid input changes.

**3. `src/screens/booking/BookingDateTimeScreen.tsx`**

- **Change:** (a) Remove the hardcoded pickup default so missing pickup is genuinely empty — line 112-116 init becomes `draft.pickup ? {address: draft.pickup.address ?? 'Pick-up', lat: draft.pickup.latitude, lng: draft.pickup.longitude} : null`. (b) Require both at line 191: `const canContinue = Boolean(pickup) && Boolean(dropoff);`. (c) Tighten handleContinue guard at line 194: `if (!canContinue || !pickup || !dropoff) {return;}`. (d) Optionally add a small inline note above/near the CTA (e.g. when `!pickup || !dropoff`, render a one-line 'Add both pick-up and drop-off to continue' under the location rows) so the greyed CTA isn't confusing.
- **Why:** #3 verbatim: both required; block advancing if either missing. The Dubai default made pickup-required hollow, so it must be removed for the gate to mean anything.
- **Risk:** Medium. Requiring dropoff blocks bookings that legitimately have no destination (e.g. hourly executive_protection / timeslot details). See open_questions — may need to scope the dropoff requirement to `draft.type === 'transfer'` per product. Removing the pickup default also means the screen opens with an empty pickup row (correct, but a visible UX change).

**4. `src/store/bookingStore.ts`**

- **Change:** Optional defense-in-depth (not required once the DTO is relaxed): in confirmBooking (line 204) and estimatePrice (line 170) send `vehicle_count: draft.driver_only ? undefined : draft.vehicle_count` so the client never transmits a 0. Lets the server normalize from driver_only alone.
- **Why:** Decouples the client from the DTO's min rule and makes a future DTO that re-tightens @Min(1) non-breaking. Belt-and-suspenders.
- **Risk:** Very low. Server already derives vehicleCount from driver_only; sending undefined hits the `?? 1`/clamp path identically.

### Step-by-step prompts for Claude

_Hand these to Claude one at a time, in order._

> **Step 1:** Fix #4 backend DTO. Open `apps/auth-service/src/booking/dto/create-booking.dto.ts`. On the `vehicle_count` field of CreateBookingDto (currently `@IsOptional() @IsInt() @Min(1) @Max(4)` at line 54, field at line 55) change `@Min(1)` to `@Min(0)`. Do the SAME on the `vehicle_count` field of EstimateBookingDto (line 95-96). Leave `@IsOptional()`, `@IsInt()`, and `@Max(4)` unchanged. This is the single change that unblocks the Driver-Only path (the UI sends vehicle_count=0 and class-validator's @IsOptional does not skip 0).

> **Step 2:** Harden the service so a 0 can't sneak into a non-driver booking. Open `apps/auth-service/src/booking/booking.service.ts`, line 250. Change `const vehicleCount = driverOnly ? 0 : (dto.vehicle_count ?? 1);` to `const vehicleCount = driverOnly ? 0 : Math.max(1, dto.vehicle_count ?? 1);`. (`?? 1` does not replace 0, so without Math.max a 0 with driver_only=false would create a 0-vehicle non-driver booking.)

> **Step 3:** Add a backend test for #4. Create/extend a spec under `apps/auth-service/src/booking/` (e.g. add to `booking-flow.spec.ts`). Test A: instantiate CreateBookingDto with `vehicle_count: 0, driver_only: true` and run class-validator `validate()` — expect NO errors (today it returns a 'vehicle_count must not be less than 1' error). Test B (service): with a mocked db, call create with `driver_only:true, vehicle_count:0` and assert the INSERT binds vehicle_count=0 and pricing applies the driver-only 0.65× (PricingService already covered by the existing 'driver-only shaves 35%' test at booking-flow.spec.ts:208).

> **Step 4:** Run the backend booking suite: `cd apps/auth-service && npm test`. Confirm the new tests pass and the existing pricing/state-machine specs (booking-flow.spec.ts, pricing.service.spec.ts, booking.step16/19/22/24.spec.ts) stay green.

> **Step 5:** Fix #3 pickup/dropoff gating. Open `src/screens/booking/BookingDateTimeScreen.tsx`. (a) Line 112-116: replace the hardcoded fallback object `{address: 'DIFC Gate Building 4, Dubai', lat: 25.2132, lng: 55.2806}` with `null` so the pickup row starts empty when there's no draft.pickup. (b) Line 191: change `const canContinue = Boolean(pickup);` to `const canContinue = Boolean(pickup) && Boolean(dropoff);`. (c) Line 194: change `if (!canContinue || !pickup) {return;}` to `if (!canContinue || !pickup || !dropoff) {return;}`.

> **Step 6:** Add a 'why disabled' hint in `BookingDateTimeScreen.tsx`. Below the two LocationRow blocks (after line 308) render a small inline note when `!pickup || !dropoff`, e.g. `<Text style={s.hintText}>Add both pick-up and drop-off to continue.</Text>` reusing the existing `s.hint`/`s.hintText` styles, so the greyed-out 'Confirm Schedule' button has a visible reason.

> **Step 7:** (Optional, recommended) Make the gate unit-testable. Extract a pure helper in `BookingDateTimeScreen.tsx` (or a sibling `scheduleGate.ts` in src/screens/booking/): `export const canAdvanceSchedule = (pickup, dropoff) => Boolean(pickup) && Boolean(dropoff);` and use it for `canContinue`. Add `src/screens/booking/__tests__/scheduleGate.test.ts` asserting it's false when either side is null and true when both are set (this file lands in the mobile 'booking' jest project, which globs src/screens/booking/__tests__/**/*.test.ts).

> **Step 8:** (Optional defense-in-depth for #4) In `src/store/bookingStore.ts` set `vehicle_count: draft.driver_only ? undefined : draft.vehicle_count` in both estimatePrice (line 170) and confirmBooking (line 204), so the client never transmits 0 even if the DTO is re-tightened later.

> **Step 9:** Run mobile gates: `npm test -- --selectProjects=booking` (pricing.test.ts + the new scheduleGate test) and `npm run typecheck` (must not exceed the .tsc-baseline.json count). Then a manual smoke (device/emulator): (i) Schedule step — with only pickup set the CTA stays disabled; set dropoff too and it enables and advances. (ii) Team & Add-ons — toggle 'Driver Only (Client Vehicle)' ON, submit; confirm NO 'vehicle_count must not be less than 1' 400, the booking is created, and the price reflects the driver-only discount.

### ⚠️ Regressions this could introduce (guard against these)

- Requiring dropoff may block legitimately destination-less bookings (hourly executive_protection / 'timeslot' details). Guard: confirm with product whether dropoff is required for ALL types or only `type==='transfer'`; if scoped, make `canContinue` require dropoff only when the booking is a point-to-point transfer.
- Removing the hardcoded pickup default changes the screen's first-render appearance (pickup row now shows the 'Select pick-up…' placeholder instead of a Dubai address). Verify LocationRow renders cleanly with pickup=null (it already keys off `filled={!!pickup}` and optional `address?`) and that openPicker('pickup') opens with `initial: undefined` without crashing.
- Relaxing the DTO to @Min(0) lets a direct/legacy API caller submit vehicle_count=0 with driver_only=false; the booking.service Math.max(1, …) clamp (Step 2) is what prevents a mispriced 0-vehicle non-driver booking — do NOT skip Step 2.
- estimatePrice (bookingStore.ts:170) ALSO sends vehicle_count=0 in driver-only mode; if only the create DTO were relaxed and the estimate DTO left at @Min(1), the live price preview would silently 400 (error surfaced via the estimate catch). Make sure BOTH DTOs (create + estimate) are changed in Step 1.
- Make sure the @Max(4) and @IsInt remain on vehicle_count after the edit (only @Min changes) so the upper bound and type are still enforced.

### Tests / verification

- Backend: `cd apps/auth-service && npm test` (booking-flow.spec.ts, pricing.service.spec.ts, booking.step16/19/22/24.spec.ts) + the new DTO-validation and driver-only-create tests.
- Mobile: `npm test -- --selectProjects=booking` (src/screens/booking/__tests__ — pricing.test.ts + new scheduleGate.test.ts).
- Mobile: `npm run typecheck` (must not exceed .tsc-baseline.json baseline).
- Manual smoke 1 (#3): Schedule step blocks advancing with only pickup set; enables and advances when both pickup AND dropoff are set; CTA shows a reason hint while disabled.
- Manual smoke 2 (#4): toggle 'Driver Only (Client Vehicle)' ON → estimate shows driver-only discounted price (no 400) → submit succeeds and creates a booking with vehicle_count=0.

### Open questions / decisions needed

- Is dropoff truly required for EVERY booking type, or only for point-to-point 'transfer' bookings? Hourly executive_protection / 'timeslot' details may have no destination. If the latter, scope the dropoff gate to `draft.type === 'transfer'` rather than all types.
- Should the backend also enforce dropoff (e.g. make `dropoff` required on CreateBookingDto for transfers) as a backstop, or is the UI step-gate sufficient? Backend enforcement would harden against direct API callers but risks breaking the auto-dispatch and legacy paths that currently allow a null dropoff.
- Preferred fix layer for #4: relax the DTO to @Min(0) (server accepts 0) vs. stop the client from sending 0 (bookingStore sends undefined). Recommended is the DTO relax (authoritative, fixes any caller) PLUS the optional client guard; confirm the team wants both.

---

## 3. region — Region setting + region-based client/SP matching with detect / change / N/A

**Covers your requests:**

- #8: add a Region option in Settings. Detect region at account creation from the location (Bangladesh / Dubai / South Africa etc. — from our supported list).
- #8: client and SP region must match — if a person is in the BD region, only BD client requests (nearest to client) should come.
- #8: provide an option to change region; on change, re-check current location and set region from our list; if outside any supported region, set N/A. Same change option for client and SP.

### Root cause

Not a bug — a feature gap plus a pre-existing data-hygiene defect. The matcher already enforces client↔SP region equality + nearest-first (dispatch.service.ts:131, 159-168) and region-matched compliance (eligibility fn). What is missing for #8: (a) no persisted per-user region (no users.home_region — region is per-booking + manual, ZoneMapScreen.tsx:219 / bookingStore.ts:76); (b) no reverse-geocode-on-create or change-and-redetect flow (mobile ships only react-native-geolocation-service with no geocoder; the backend GeocodeService at geocode.service.ts:36-83 is unused for region); (c) no Region option in Settings (SettingsScreen.tsx); (d) no N/A concept (agent.service.ts:1565 hard-rejects). Compounding defect: the supported-region list is forked 5 ways (constants.ts:38 AE/GB/ZA/US vs the AE/SA/BD/GB used by dispatch/compliance/agent allow-list), so a 'ZA' actor is silently un-rankable today — reconciling to one canonical list is prerequisite work.

### Current behavior (as built)

REGION MATCHING ALREADY EXISTS AND WORKS — the gap is purely the *region selection/detection* UX plus a canonical-list reconciliation, not the matcher.

1) The matchmaker is hard region-scoped. `apps/auth-service/src/dispatch/dispatch.service.ts:131` filters the agency pool by `AND a.region_code = $3`, where `$3` is the booking's region (`offerNext` binds `b.region_code` at dispatch.service.ts:684 + 708). The ORDER BY (dispatch.service.ts:159-168) is PostGIS nearest-first (`ST_Distance` bucket → rating → `<->` KNN), so within the same region the *nearest agency to the client pickup* wins — exactly requirement #8's "nearest to client". Eligibility also region-matches: `is_eligible_for_dispatch(agency, region, requirements)` requires a VERIFIED licence AND insurance whose `c.region_code = p_region` (`supabase/migrations/20260621100000_dispatch_eligibility_fns.sql:48-54`). So an SP only receives client requests whose `region_code` equals the SP's `agents.region_code` AND for which it holds region-matched compliance.
2) The CLIENT's booking region is chosen MANUALLY, never detected. `apps/auth-service/src/booking/booking.service.ts:299` persists `dto.region` straight into `lite_bookings.region_code`. Mobile sets it in the zone picker: `src/screens/booking/ZoneMapScreen.tsx:219` `updateDraft({zone_code: selected.code, zone_label: selected.name, region: selected.code})`; the store default is hardcoded `region: 'AE'` (`src/store/bookingStore.ts:76`). There is NO `users` region column and NO reverse-geocode-on-create — region is per-booking and manual.
3) The SP's region is set only by the agency, manually, in one screen. `src/screens/agent/OrgComplianceScreen.tsx:30` `const REGIONS = ['AE','SA','BD','GB']`; the chips call `agentApi.setAgencyProfile({region_code,...})` (OrgComplianceScreen.tsx:95) → `PATCH /agents/me/agency-profile` (`agent.controller.ts:163`) → `setAgencyProfile` (`agent.service.ts:1551-1582`) which server-allow-lists `['AE','SA','BD','GB']` (agent.service.ts:1564) and writes `agents.region_code` (agent.service.ts:1570). No GPS detection; company-agents only.
4) Settings has NO region option at all. `src/screens/settings/SettingsScreen.tsx` exposes Language / Currency / Notifications / Location-scope / App-lock only (saved via `PATCH /users/me/preferences`, SettingsScreen.tsx:55). The user-preferences column set (`supabase/migrations/20260622120000_user_preferences.sql:9-17`) has language/currency/notif_prefs/location_scope/app_lock — no region. `users.service.ts:199-225` (updatePreferences) + DTO `lookup-users.dto.ts:82-104` have no region field.
5) Reverse-geocoding capability EXISTS server-side but is unused for region. `apps/auth-service/src/vbg/geocode.service.ts:36-83` `GeocodeService.reverse(lat,lng)` returns `country` as a 2-letter ISO code via Mapbox (degrades to a coarse fallback with `country: null`). Mobile CANNOT reverse-geocode locally — it ships `react-native-geolocation-service` (`package.json:101`, `src/hooks/useLocation.ts:2`, `src/services/onDutyHeartbeat.ts:54`) which gives raw lat/lng only, no place names. So detection must be a backend call.
6) THE SUPPORTED-REGION LIST IS FORKED 5 WAYS (documented drift, AUTO_DISPATCH_BUGFIX_GUIDE.md:345-346, BUILD_RUNBOOK.md:228): `src/utils/constants.ts:38-43` SUPPORTED_REGIONS = AE/GB/ZA/US (drives currency); `apps/auth-service/src/booking/booking.service.ts:37-42` = AE/SA/BD/GB; `OrgComplianceScreen.tsx:30` = AE/SA/BD/GB; `agent.service.ts:1564` = AE/SA/BD/GB; `ZoneMapScreen.tsx:70-75` REGION_SEED = AE/SA/BD/GB. The user names BD/AE(Dubai)/ZA(South Africa) — ZA exists ONLY in constants.ts, NOT in the dispatch allow-list, so a 'ZA' SP today is silently un-rankable (setAgencyProfile would 400 'unsupported_region'). The de-facto dispatch canonical is AE/SA/BD/GB. Currency CHECK allows AED/SAR/BDT/GBP only (`user_preferences.sql:13`) — no ZAR.
7) There is no N/A concept anywhere: `agent.service.ts:1565` rejects any non-allow-listed region; booking create requires a non-empty region (`create-booking.dto.ts:33` `@IsNotEmpty()`).

### Key files

| File                                                                | Role                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/auth-service/src/dispatch/dispatch.service.ts`              | Matchmaker — region filter`a.region_code = $3` (line 131) + nearest-first ORDER BY (159-168). Already enforces client↔SP region match + nearest. No change needed beyond verifying N/A bookings never reach here. |
| `supabase/migrations/20260621100000_dispatch_eligibility_fns.sql` | is_eligible_for_dispatch — region-matched licence/insurance gate (48-54). SP region_code must equal booking region AND compliance region.                                                                            |
| `apps/auth-service/src/agents/agent.service.ts`                   | setAgencyProfile (1551-1582) writes agents.region_code with allow-list (1564); updateLocation (1620-1688) writes last_location geography used by the ranker. The SP region setter.                                    |
| `src/screens/agent/OrgComplianceScreen.tsx`                       | The ONLY SP region UI — manual chips REGIONS (line 30). Needs a 'detect from current location' button + N/A handling.                                                                                                |
| `src/screens/settings/SettingsScreen.tsx`                         | Client/user Settings — needs a new Region section (view current + change/re-detect + N/A).                                                                                                                           |
| `apps/auth-service/src/users/users.service.ts`                    | getMe (133-159) + updatePreferences (199-225) — add home_region read/write.                                                                                                                                          |
| `apps/auth-service/src/users/dto/lookup-users.dto.ts`             | PreferencesDto (82-104) — add homeRegion field with allow-list incl 'N/A'.                                                                                                                                           |
| `supabase/migrations/20260622120000_user_preferences.sql`         | Precedent for additive users-column migration — a new sibling migration adds users.home_region.                                                                                                                      |
| `apps/auth-service/src/vbg/geocode.service.ts`                    | GeocodeService.reverse → country ISO (36-83). Reuse for backend region detection (country→region_code mapping).                                                                                                     |
| `src/utils/constants.ts`                                          | SUPPORTED_REGIONS (38-43) AE/GB/ZA/US — the divergent list; must become the single canonical source (or import from one).                                                                                            |
| `apps/auth-service/src/booking/booking.service.ts`                | SUPPORTED_REGIONS (37-42) + booking create persists dto.region (299). Canonical backend list; booking region default/validation lives here.                                                                           |
| `src/store/bookingStore.ts`                                       | Booking draft default region 'AE' (76) — should default to the user's home_region.                                                                                                                                   |
| `src/screens/booking/ZoneMapScreen.tsx`                           | REGION_SEED (70-75) + manual region pick (219). Should pre-select/honor the user's home_region.                                                                                                                       |
| `src/services/api.ts`                                             | preferencesApi (305-308), agentApi.setAgencyProfile (651) — add region-detect call + homeRegion to UserPreferences (297-303).                                                                                        |

### Proposed changes (per file)

**1. `NEW src/shared/regions.ts (mobile) + apps/auth-service/src/common/regions.ts (backend)`**

- **Change:** Create ONE canonical region table: `[{code:'AE',label:'UAE — Dubai',currency:'AED'},{code:'SA',label:'Saudi Arabia',currency:'SAR'},{code:'BD',label:'Bangladesh',currency:'BDT'},{code:'GB',label:'United Kingdom',currency:'GBP'},{code:'ZA',label:'South Africa',currency:'ZAR'}]` plus `REGION_NA='N/A'` and a `countryToRegion: Record<ISO2,RegionCode>` map (AE→AE, SA→SA, BD→BD, GB→GB, ZA→ZA). Re-export from constants.ts/booking.service.ts and replace the 5 forked lists. DECISION REQUIRED from user/finance on whether ZA ships now (it needs a ZAR currency CHECK + FX rate).
- **Why:** Removes the documented 5-way drift (AUTO_DISPATCH_BUGFIX_GUIDE.md:345) so agents.region_code, compliance region, booking region, and the currency list cannot diverge — divergence today = silent NO_PROVIDER.
- **Risk:** Adding ZA without a ZAR currency CHECK + FX entry breaks currency save (user_preferences.sql:13) and escrow FX. Keep ZA out until finance signs off, OR add ZAR everywhere in the same change.

**2. `supabase/migrations/20260628000000_user_home_region.sql (NEW)`**

- **Change:** `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS home_region TEXT;` with `CHECK (home_region IS NULL OR home_region IN ('AE','SA','BD','GB','ZA','N/A'))`. Additive + idempotent, mirroring user_preferences.sql.
- **Why:** Clients have no persisted region today (per-booking only). #8 needs a stored, settable region per user.
- **Risk:** CHECK must match the canonical code list exactly or inserts fail. Keep NULL-allowed so legacy rows + the 'not yet detected' state are valid.

**3. `apps/auth-service/src/users/users.service.ts + lookup-users.dto.ts + users.controller.ts`**

- **Change:** (a) getMe: SELECT + return `homeRegion: row.home_region`. (b) updatePreferences: `if (patch.homeRegion !== undefined) push('home_region', patch.homeRegion)` with allow-list validation. (c) DTO: add `@IsOptional() @IsIn(['AE','SA','BD','GB','ZA','N/A']) homeRegion?`. (d) NEW endpoint `POST /users/me/region/detect` body `{lat,lng}` → `geocode.reverse` → `countryToRegion[fix.country] ?? 'N/A'` → persist to home_region → return `{homeRegion, detectedCountry}`.
- **Why:** Backend is the only place that can reverse-geocode (mobile has no geocoder). One endpoint serves both 'change region (re-detect)' and 'detect at account creation'.
- **Risk:** GeocodeService degrades to country:null with no Mapbox token → always N/A. Verify MAPBOX_ACCESS_TOKEN is set in auth-service env; expose `detectedCountry` so the UI can explain an N/A result. GeocodeService lives in VbgModule — either move it to a shared module or import VbgModule into UsersModule (watch for a circular import).

**4. `apps/auth-service/src/agents/agent.service.ts + agent.controller.ts`**

- **Change:** Add `POST /agents/me/region/detect` (company-only) reusing the same geocode→countryToRegion mapping, writing `agents.region_code` via the existing setAgencyProfile path (do NOT bypass the allow-list at 1564 — extend it to the canonical list incl 'ZA' if shipped). Reject 'N/A' here (an SP cannot operate region-less) → return it so the UI shows 'outside supported area'.
- **Why:** Same detect/change flow for the SP, per #8 'Same change option for client and SP'. Keeps agents.region_code == compliance region invariant (the eligibility join).
- **Risk:** If the SP's detected region != its verified compliance region, it silently becomes un-rankable (passes ranker, fails eligibility — BUGFIX_GUIDE:342). Warn in the UI when detected region has no VERIFIED licence for that region.

**5. `src/screens/settings/SettingsScreen.tsx`**

- **Change:** Add a Region `<Section>`: show current `homeRegion` (label or 'Not set / N/A'), a 'Detect from my location' button (getCurrentPosition → `regionApi.detect({lat,lng})` → refresh), and a manual override list of canonical regions (calls `preferencesApi.patch({homeRegion})`). On N/A result show 'Your location is outside our supported regions.'
- **Why:** The literal #8 'add a Region option in Settings' + 'option to change region; on change re-check current location'.
- **Risk:** Requires location permission; handle denied/cancelled (error path per CLAUDE.md UI rule). Don't block save if GPS fails — keep the manual override.

**6. `src/screens/agent/OrgComplianceScreen.tsx`**

- **Change:** Add a 'Detect region from my location' button next to the REGIONS chips (line 139-145) that calls the new SP detect endpoint and updates the selected chip; keep manual chips as override. Replace the local `REGIONS` (line 30) with the shared canonical import.
- **Why:** #8 same change option for SP; removes one forked list.
- **Risk:** Detected region may diverge from already-submitted compliance docs — surface a warning, don't auto-delete docs.

**7. `src/store/bookingStore.ts + src/screens/booking/ZoneMapScreen.tsx`**

- **Change:** Default the booking draft region to the user's `homeRegion` (fetched via preferencesApi.get / authStore) instead of hardcoded 'AE' (bookingStore.ts:76); in ZoneMapScreen pre-select the home_region row and, if home_region is 'N/A'/null, prompt the user to set a region before booking. Replace REGION_SEED (70-75) with the shared canonical list (keep city labels).
- **Why:** Makes the client's requests originate in their detected region by default so client↔SP matching 'just works'; honors #8 'only BD client requests come to a BD SP'.
- **Risk:** A client physically in BD but with a stale home_region=AE would dispatch into AE. Consider also detecting at booking time from pickup coords (pickup already has lat/lng) — but the pickup region should win over home_region for the actual booking. FLAG as open question (home_region vs pickup-derived region).

**8. `apps/auth-service/src/booking/booking.service.ts (create)`**

- **Change:** Reject auto bookings whose region is 'N/A' / unsupported with a clear 'region_unsupported' error before persisting (currently only @IsNotEmpty, create-booking.dto.ts:33). Optionally derive/validate region from pickup coords via geocode to prevent a region/pickup mismatch.
- **Why:** An N/A or wrong region silently produces NO_PROVIDER (no SP matches). Fail fast with an actionable message.
- **Risk:** Adding a geocode call into the hot booking path adds latency + a Mapbox dependency; gate it behind the auto path only and cache (GeocodeService already caches 1h).

### Step-by-step prompts for Claude

_Hand these to Claude one at a time, in order._

> **Step 1:** STEP 1 (canonical list, do FIRST): Create the single source of truth. Add `apps/auth-service/src/common/regions.ts` exporting `SUPPORTED_REGIONS` (array of {code,label,currency}) for codes AE/SA/BD/GB, `REGION_CODES` (string[]), `REGION_NA='N/A'`, and `COUNTRY_TO_REGION: Record<string,string>` ({AE:'AE',SA:'SA',BD:'BD',GB:'GB',...}). Do NOT add ZA yet (it needs ZAR — see STEP 9 open question). Then replace `apps/auth-service/src/booking/booking.service.ts:37-42` SUPPORTED_REGIONS and `apps/auth-service/src/agents/agent.service.ts:1564` `const SUPPORTED=['AE','SA','BD','GB']` to import from this file. Run `cd apps/auth-service && npm run build` and `npm test -- booking agents`.

> **Step 2:** STEP 2 (mobile canonical list): Add `src/shared/regions.ts` mirroring STEP 1 (codes + labels + currency + COUNTRY_TO_REGION + REGION_NA). Replace `src/utils/constants.ts:38-43` SUPPORTED_REGIONS to re-export from it (reconciling AE/GB/ZA/US → AE/SA/BD/GB), `src/screens/agent/OrgComplianceScreen.tsx:30` REGIONS, and `src/screens/booking/ZoneMapScreen.tsx:70-75` REGION_SEED (keep the city/label strings). Run `npm run typecheck` (must stay ≤ baseline 96).

> **Step 3:** STEP 3 (DB): Create `supabase/migrations/20260628000000_user_home_region.sql` with `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS home_region TEXT;` and a `CHECK (home_region IS NULL OR home_region IN ('AE','SA','BD','GB','N/A'))`. Apply it (Supabase MCP apply_migration) and confirm via list_tables.

> **Step 4:** STEP 4 (backend read/write region): In `apps/auth-service/src/users/users.service.ts` getMe (133-159) add `home_region` to the SELECT and return `homeRegion: row.home_region`; in updatePreferences (199-225) add `if (patch.homeRegion !== undefined) push('home_region', patch.homeRegion);` after validating it is in REGION_CODES∪{'N/A'}. In `apps/auth-service/src/users/dto/lookup-users.dto.ts` PreferencesDto (82-104) add `@IsOptional() @IsIn([...REGION_CODES,'N/A']) homeRegion?: string;`. Update the MeRow/Me types. Run `npm test -- users`.

> **Step 5:** STEP 5 (backend detect endpoint): Add `POST /users/me/region/detect` in `apps/auth-service/src/users/users.controller.ts` (after the @Patch('me/preferences') at line 79) taking `{lat:number,lng:number}`, calling `usersService.detectAndSetRegion(userId,lat,lng)`. Implement that method in users.service.ts: call `GeocodeService.reverse(lat,lng)` → `COUNTRY_TO_REGION[fix.country ?? ''] ?? 'N/A'` → persist to users.home_region → return `{homeRegion, detectedCountry: fix.country}`. Wire GeocodeService into UsersModule (export it from VbgModule or relocate it to a shared module; check for circular imports). Add a unit test stubbing GeocodeService for AE / unsupported (→N/A) / null-country (→N/A).

> **Step 6:** STEP 6 (SP detect endpoint): Add `POST /agents/me/region/detect` in `apps/auth-service/src/agents/agent.controller.ts` (after line 163) company-only, calling a new `agents.detectRegion(userId,lat,lng)` that maps country→region via COUNTRY_TO_REGION, REJECTS 'N/A' (SPs must have a region), and writes via the existing `setAgencyProfile` write (reuse the allow-list at agent.service.ts:1564, now the shared list). Return `{region_code, detectedCountry}`. Add a spec.

> **Step 7:** STEP 7 (mobile api client): In `src/services/api.ts` add to UserPreferences (297-303) `homeRegion?: string`; add `regionApi = { detect: (b:{lat:number;lng:number}) => authHttp.post<{homeRegion:string;detectedCountry:string|null}>('/users/me/region/detect', b) }`; add `agentApi.detectRegion: (b:{lat:number;lng:number}) => authHttp.post<{region_code:string;detectedCountry:string|null}>('/agents/me/region/detect', b)`.

> **Step 8:** STEP 8 (mobile Settings UI): In `src/screens/settings/SettingsScreen.tsx` add state `homeRegion` (load from preferencesApi.get at line 41), a new `<Section title=Region>` showing the current region label (or 'Not set' / 'N/A — outside supported area'), a 'Detect from my location' button (use the existing geolocation: `Geolocation.getCurrentPosition` from react-native-geolocation-service like onDutyHeartbeat.ts:54 → `regionApi.detect({lat,lng})` → setHomeRegion + Alert on N/A), and a manual list of SUPPORTED_REGIONS rows calling `save({homeRegion: code})`. Handle permission-denied/cancelled (error path). Run `npm run typecheck`.

> **Step 9:** STEP 9 (mobile SP UI): In `src/screens/agent/OrgComplianceScreen.tsx` add a 'Detect region from my location' TouchableOpacity above the REGIONS chips (around line 139) calling `agentApi.detectRegion({lat,lng})` and setRegion(result.region_code); show a warning if the detected region has no VERIFIED licence in `docs`. Keep manual chips.

> **Step 10:** STEP 10 (booking default + N/A guard): In `src/store/bookingStore.ts:76` default `region` from the user's homeRegion (read from authStore/preferences at booking start) instead of 'AE'; in `src/screens/booking/ZoneMapScreen.tsx` pre-select the home_region row and, when home_region is null/'N/A', show a prompt to set a region first. In `apps/auth-service/src/booking/booking.service.ts` create(), for the auto path reject region not in REGION_CODES with a `region_unsupported` BadRequest before insert (currently only @IsNotEmpty at create-booking.dto.ts:33).

> **Step 11:** STEP 11 (tests + smoke): Run `cd apps/auth-service && npm test` (users, agents, booking, dispatch projects), `npm run typecheck` (mobile + ops-console), and a manual smoke: register/login → Settings → Region → Detect → confirm region persists; OrgComplianceScreen → Detect → region chip updates; create an auto booking and confirm dispatch.service ranking still offers only same-region agencies.

### ⚠️ Regressions this could introduce (guard against these)

- Region-list reconciliation can break currency: constants.ts SUPPORTED_REGIONS (drives currency selection) currently lists ZA/US; dropping them to AE/SA/BD/GB changes the currency picker. Guard: keep the currency mapping in the canonical table and run `npm run typecheck` + visual check of the booking currency UI.
- Adding ZA without ZAR everywhere breaks saves: user_preferences.sql:13 currency CHECK and the PreferencesDto @IsIn only allow AED/SAR/BDT/GBP. If ZA ships, ZAR must be added to the CHECK, the DTO, dispatch FX, and escrow FX in the same change or currency-save 500s. Guard: do NOT add ZA until finance signs off (open question).
- GeocodeService with no Mapbox token returns country:null → every detect yields N/A, making clients/SPs think detection is broken. Guard: verify MAPBOX_ACCESS_TOKEN in auth-service env; surface detectedCountry in the response so the UI can show 'could not determine region' distinctly from 'outside supported area'.
- SP detected region diverging from its VERIFIED compliance region makes it pass the ranker but fail eligibility → silent NO_PROVIDER (BUGFIX_GUIDE.md:342). Guard: warn in OrgComplianceScreen when the detected region has no verified licence; keep agents.region_code and compliance region driven from one selection.
- home_region vs pickup region mismatch: a client whose stored home_region is AE but who books a pickup in BD would dispatch into AE and get NO_PROVIDER. Guard: decide whether the booking region should be derived from pickup coords (which already exist) rather than home_region — flag as open question; at minimum validate region against pickup before dispatch.
- Moving/importing GeocodeService out of VbgModule can introduce a circular module import (Users↔Vbg). Guard: relocate GeocodeService to a shared/common module rather than cross-importing feature modules; run `npm run build` in auth-service.
- N/A bookings must never reach the matchmaker (dispatch.service.ts:131 would just match nothing → NO_PROVIDER with no explanation). Guard: STEP 10 rejects unsupported/N/A region at booking create with an actionable error.

### Tests / verification

- cd apps/auth-service && npm test (users.service.spec, agent.agency-profile.spec, booking.service specs, dispatch.service.spec — region filter unchanged)
- New unit tests: users.detectAndSetRegion (AE country→AE, unsupported country→N/A, null country→N/A) and agents.detectRegion (rejects N/A)
- npm run typecheck (mobile, must stay ≤ baseline 96) + cd apps/ops-console && npm run typecheck
- Manual smoke: Settings → Region → Detect-from-location (golden path + denied-permission + cancelled GPS + outside-region→N/A); OrgComplianceScreen detect; create an auto booking and confirm same-region nearest agency is offered (dispatch monitor)
- Regression: npm test -- --selectProjects=booking (booking create still persists region) and the dispatch eligibility specs

### Open questions / decisions needed

- Canonical region set: the user names Bangladesh/Dubai/South Africa but ZA exists only in constants.ts and is NOT in the dispatch allow-list or the currency CHECK (no ZAR). Ship AE/SA/BD/GB now and add ZA+ZAR (DTO + user_preferences CHECK + dispatch FX + escrow FX) as a finance-gated follow-up, or include ZA now? Needs a product/finance decision.
- Should the booking's region be the client's stored home_region, or derived live from the pickup coordinates (which already carry lat/lng)? Pickup-derived is more correct for 'nearest BD client to BD SP' when a user travels; home_region is simpler. Recommend pickup-derived for the booking, home_region only as the default/pre-selection.
- N/A SP handling: an SP whose detected location is outside all regions — block detection (keep prior region) or force them off-duty? Current proposal rejects N/A for SPs and keeps the prior region.
- Does account-creation detection belong in the register flow (auth.service.ts register, which today sets no region) or as a first-run prompt after login on the client home screen? Mobile can only detect after location permission is granted, which is requested post-onboarding (PermissionsScreen).
- MAPBOX_ACCESS_TOKEN availability in the auth-service runtime env (staging + prod) — detection silently degrades to N/A without it.

---

## 4. CALLS-1to1 — 1:1 call: End must reliably tear down (audio) without crashing; hardware Back must minimize (PiP) not end

**Covers your requests:**

- #2: after clicking the End button (audio) the call does not end — make sure it does not crash.
- #2: clicking the Back button cuts the call; instead it should minimize like WhatsApp (when 2 participants, starting a call then pressing Back should minimize, not end).

### Current behavior (as built)

REAL 1:1 audio/video calls run through `src/screens/messenger/CallScreen.tsx` (the `VoiceCall` route maps to a __DEV__-only demo placeholder — `VoiceCallScreen.tsx:27-35` returns null in release, and its End/Minimise are stubbed to `navigation.goBack()` only, `VoiceCallScreen.tsx:114,173`).

END BUTTON path (audio): the End button is `onPress={endCall}` (`CallScreen.tsx:2259` voice layout; also `:2081` and video `:2022+`). `endCall` (`CallScreen.tsx:1301-1307`) is: `if (hangupInFlightRef.current) return; hangupInFlightRef.current = true; Vibration.vibrate(...); try { liveCall.hangup(); } catch {}` and then RELIES on the state→'ended' auto-dismiss effect to navigate: `useEffect(...) { ... else if (liveCall.state === 'ended') { const t = setTimeout(() => navigation.goBack(), 50); ... } }` (`CallScreen.tsx:1237-1246`). `liveCall.hangup` = `controllerRef.current?.hangup('ended')` (`useCall.ts:874-876`). `controller.hangup` → `end('ended')` → `setState('ended')` → `opts.onState('ended')` (`callController.ts:524-532, 1071-1136`). useCall's onState('ended') stops tracks and calls `endActiveCall(s)` (`useCall.ts:469-520`), which stops mic/cam, `controller.hangup`, unregister, clears the registry and stops the foreground service (`callRegistry.ts:139-201`). On unmount the audio-session cleanup runs `InCallManager.stop()` only when the registry no longer owns the call (`CallScreen.tsx:859-893`).

ROOT-CAUSE of \"End does not end\": `endCall` is fire-and-forget through the controller. If `controllerRef.current` is null (the call is still booting — `useCall` waits on `iceServers`+`transport`+real peer before building the controller, `useCall.ts:257-266,360-669`; outgoing `state` starts as `'idle'`, `useCall.ts:147`), then `liveCall.hangup()` is a silent no-op (`useCall.ts:874-876` optional-chains a null controller), state NEVER reaches 'ended', the auto-dismiss effect never fires, AND `hangupInFlightRef` is now latched true so EVERY subsequent End tap is swallowed (`CallScreen.tsx:1302`). The user is stuck on a call screen whose End button is dead — exactly \"End does not end\". The same no-op applies if `endActiveCall` was bypassed because the registry had no controller yet.

CRASH surface on teardown: CallScreen renders heavy native `RTCView` subtrees with conditionally-swapped, structurally-different children (remote tile vs 'Camera off' vs avatar `:1855-1881`; local PiP RTCView vs CameraView vs avatar `:1909-1981`) and pops via `navigation.goBack()` in the same window the tree collapses. There is NO `tearingDown` freeze guard and no stable always-mounted key in CallScreen (grep: zero `tearingDown` occurrences; keys are content-derived like `key={\\`remote-${...}\\`}` `:1870`, `key={\\`local-${...}\\`}` `:1927`). This is the identical pattern that produced the B-37/B-25 group-call native Fabric crash \"child already has a parent\" (sqa.md:1069,1082,1273), where the fix was a stable `key=\"empty-hero\"` + a `tearingDown` flag that freezes `renderEntries` before `call.leave()`. The 1:1 screen never received that defense, so an End during certain render states can crash natively (uncatchable by the JS ErrorBoundary).

BACK BUTTON path: contrary to the report, the CURRENT code already attempts WhatsApp-style minimize. The hardware-back handler swallows back and minimizes for live states: `if (st === 'calling' || 'ringing' || 'connecting' || 'connected' || 'reconnecting') { setMinimized(true); navigation.goBack(); return true; }` (`CallScreen.tsx:265-291`), and a `beforeRemove` listener covers OneUI swipe-back that doesn't fire hardwareBackPress (`CallScreen.tsx:322-345`). `setMinimized(true)` flips `isMinimized+keepAlive` (`callRegistry.ts:88-92`); the globally-mounted `FloatingCallOverlay` (mounted once in `App.tsx:78`) renders the minimized pill/PiP and a working End (`FloatingCallOverlay.tsx:93,129,187-202`). MessengerNavigator keeps gestures ON for CallScreen specifically so beforeRemove can fire (`MessengerNavigator.tsx:83-89`).

ROOT-CAUSE of \"Back still cuts the call\": the minimize allowlists OMIT the initial `'idle'` state. An outgoing audio call sits in `'idle'` (useCall.ts:147) from mount until `controller.startOutgoing` flips it to `'calling'` (callController.ts:394) — a multi-second window while it waits on TURN creds + getUserMedia. Pressing Back in that window: handler sees `st='idle'` not in the liveStates list (`CallScreen.tsx:279`) → falls to the \"No live call → normal pop\" branch (`:285`) WITHOUT `setMinimized` → boot-effect cleanup runs with `keepAlive=false` and tears the controller down (`useCall.ts:760-800`). So \"start a call, immediately press Back\" ends it instead of minimizing — matching the report precisely. The `beforeRemove` allowlist has the same omission (`CallScreen.tsx:335`).

Note: QA previously marked steady-state \"1:1 clean hang-up (End Call) → finalState: ended both ends\" as PASS (sqa.md:855), so the defects are in the boot-window / teardown-race edges, not the happy path.

### Key files

| File                                                                 | Role                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/screens/messenger/CallScreen.tsx`                             | The real 1:1 call screen (2889 lines). Owns endCall/declineCall, hardware-back + beforeRemove minimize handlers, auto-dismiss-on-ended effect, audio-session lifecycle, and all RTCView render subtrees. |
| `src/modules/messenger/webrtc/useCall.ts`                          | React hook wrapping CallController. hangup()/decline()/accept(); onState('ended'/'failed') stops tracks + endActiveCall; boot/cleanup keyed on keepAlive.                                                |
| `src/modules/messenger/webrtc/callController.ts`                   | 1:1 state machine. hangup()→end()→setState. end() is idempotent + terminal-state-guarded (good); never flips back from ended/failed.                                                                   |
| `src/modules/messenger/runtime/callRegistry.ts`                    | Singleton active-call registry. endActiveCall(reason,source) stops mic/cam+controller+unregister+FG service+clears slot; setMinimized flips isMinimized+keepAlive; markAudioSessionStarted guard.        |
| `src/screens/messenger/FloatingCallOverlay.tsx`                    | Globally-mounted minimized-call UI (pill for audio, draggable PiP for video). restore()=navigate back to CallScreen; hangup()=endActiveCall('ended','local'). Renders only when isMinimized.             |
| `App.tsx`                                                          | Mounts`<FloatingCallOverlay/>` once at the root (line 78) so minimize works over any screen.                                                                                                           |
| `src/navigation/MessengerNavigator.tsx`                            | Registers CallScreen with gestureEnabled left ON (lines 83-89) so beforeRemove minimize-on-swipe fires.                                                                                                  |
| `src/screens/messenger/VoiceCallScreen.tsx`                        | Legacy DEMO-only screen (release returns null); NOT the production audio path — do not wire real calls here.                                                                                            |
| `src/modules/messenger/__tests__/callHangupWhileRinging.test.ts`   | Existing controller hangup test to extend with the null-controller / boot-window hangup case.                                                                                                            |
| `src/screens/messenger/__tests__/GroupCallScreen.autopop.test.tsx` | Precedent test for screen teardown/auto-pop — model for a new CallScreen End/teardown test.                                                                                                             |

### Proposed changes (per file)

**1. `src/modules/messenger/webrtc/useCall.ts`**

- **Change:** Harden hangup() (currently lines 874-876) so it ALWAYS tears down even when the controller hasn't booted: `const hangup = useCallback(() => { const c = controllerRef.current; if (c) { c.hangup('ended'); } else { try { const { endActiveCall } = require('../runtime/callRegistry'); endActiveCall('ended','local'); } catch {} } }, []);`. This guarantees registry+audio+FG teardown for a still-booting audio call, and is a no-op-safe addition when the controller exists (endActiveCall is idempotent).
- **Why:** Removes the silent no-op that strands the End button when the controller is null (boot window).
- **Risk:** Low. endActiveCall is idempotent and null-safe (callRegistry.ts:143). require() keeps the existing circular-import-avoidance pattern already used throughout useCall.

**2. `src/screens/messenger/CallScreen.tsx`**

- **Change:** Make endCall (lines 1301-1307) self-terminating with a watchdog + crash-freeze. Add near the other refs: `const tearingDownRef = useRef(false); const [tearingDown, setTearingDown] = useState(false); const dismissedRef = useRef(false);`. Rewrite endCall: set `tearingDownRef.current = true; setTearingDown(true);` FIRST (freezes the RTCView tree this render), keep `hangupInFlightRef`, vibrate, `try { liveCall.hangup(); } catch {}`, then `try { const { endActiveCall } = require('@/modules/messenger/runtime/callRegistry'); endActiveCall('ended','local'); } catch {}` (forces local-source classification + teardown regardless of controller), then arm a watchdog: `setTimeout(() => { if (dismissedRef.current) return; dismissedRef.current = true; try { navigation.goBack(); } catch {} }, 800);`. In the existing auto-dismiss effect (1237-1246) set `dismissedRef.current = true` before goBack so the watchdog and the effect can't double-pop. Apply the same `setTearingDown(true)` to declineCall (1308-1314).
- **Why:** Guarantees End ends the call (and pops the screen) even if state never reaches 'ended'; sets the teardown-freeze flag so the heavy native subtree stops mutating before the pop.
- **Risk:** Medium. Must guard against double-goBack (dismissedRef) and ensure the call-record append effect (1173-1216, runs on unmount) still fires once. tearingDown must not block that effect.

**3. `src/screens/messenger/CallScreen.tsx`**

- **Change:** Crash-proof the render: gate the heavy remote/local RTCView branches on `!tearingDown`. Wrap the remote tile return (around 1862-1881) and the local PiP IIFE (1901-1981) so that when `tearingDown` is true they render a STABLE, always-keyed placeholder, e.g. remote: `if (tearingDown) return <View key="remote-teardown" style={StyleSheet.absoluteFill} />;` and local: `if (tearingDown) return <View key="local-teardown" style={styles.pipFill} />;`. Keep the keys constant (not content-derived) so Fabric sees a stable child identity through the unmount commit.
- **Why:** Mirrors the B-37/B-25 group fix (sqa.md:1082) — freeze + stable key prevents the native 'child already has a parent' crash when the tree collapses in the same commit as goBack.
- **Risk:** Low-medium. Placeholder must occupy the same slot/index as the RTCView it replaces; verify no sibling re-index. This is a render-only change.

**4. `src/screens/messenger/CallScreen.tsx`**

- **Change:** Fix Back-cuts-call: replace the state allowlists in BOTH the hardwareBackPress handler (line 279) and the beforeRemove listener (line 335) with a terminal-state check that also covers 'idle'. In hardwareBackPress: `const st = liveCallStateRef.current; const reg = require('@/modules/messenger/runtime/callRegistry'); const live = reg.getActiveCall(); if (live && st !== 'ended' && st !== 'failed') { reg.setMinimized(true); try { navigation.goBack(); } catch {} return true; }` then fall through to normal pop only when there is no live registry call. In beforeRemove: `const liveStates = ['idle','calling','ringing','connecting','connected','reconnecting']` (add 'idle'), keeping the existing `live && !live.isMinimized` guard.
- **Why:** An outgoing audio call sits in 'idle' until startOutgoing flips to 'calling' (useCall.ts:147 vs callController.ts:394); Back in that window currently ends it. Gating on `getActiveCall()` + non-terminal minimizes any real in-flight call.
- **Risk:** Medium. Minimizing an 'idle' call shows the overlay as 'Connecting…' (FloatingCallOverlay.tsx:192) — acceptable. Must confirm the overlay auto-dismisses if that call then fails/times out (registry cleared on ended/failed by endActiveCall → overlay returns null). The 45s ring timeout (callController.ts:99,441) bounds a never-answered outgoing call.

**5. `src/screens/messenger/CallScreen.tsx`**

- **Change:** Minor classification: the local End now calls endActiveCall('ended','local') directly (above), so CallKit/Recents logs the hangup as user-declined rather than the default 'remote' that useCall's onState path passes (useCall.ts:493 calls endActiveCall(s) with no source). No further change needed; document that the controller-driven onState path remains 'remote' for peer-ended calls.
- **Why:** Correct end-reason glyph without threading a source flag through the controller.
- **Risk:** Low. Cosmetic (call-log glyph).

### Step-by-step prompts for Claude

_Hand these to Claude one at a time, in order._

> **Step 1:** In `src/modules/messenger/webrtc/useCall.ts`, locate the `hangup` callback (lines 874-876: `const hangup = useCallback(() => { controllerRef.current?.hangup('ended'); }, []);`). Replace it so it falls back to a hard registry teardown when the controller hasn't booted yet: `const hangup = useCallback(() => { const c = controllerRef.current; if (c) { c.hangup('ended'); } else { try { const { endActiveCall } = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry'); endActiveCall('ended','local'); } catch {} } }, []);`. Do not change decline/accept. Run `npm run test:crypto` to confirm no controller-test regressions.

> **Step 2:** In `src/screens/messenger/CallScreen.tsx`, add three refs/state near the existing `hangupInFlightRef` declaration (line 1300): `const tearingDownRef = useRef(false);`, `const [tearingDown, setTearingDown] = useState(false);`, `const dismissedRef = useRef(false);`.

> **Step 3:** In `src/screens/messenger/CallScreen.tsx`, rewrite `endCall` (lines 1301-1307) to: `const endCall = () => { if (hangupInFlightRef.current) return; hangupInFlightRef.current = true; tearingDownRef.current = true; setTearingDown(true); Vibration.vibrate([0,80,60,80]); try { liveCall.hangup(); } catch {} try { const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry'); reg.endActiveCall('ended','local'); } catch {} setTimeout(() => { if (dismissedRef.current) return; dismissedRef.current = true; try { (navigation as unknown as {goBack:()=>void}).goBack(); } catch {} }, 800); };`. Also add `tearingDownRef.current = true; setTearingDown(true);` as the first two statements of `declineCall` (lines 1308-1314).

> **Step 4:** In `src/screens/messenger/CallScreen.tsx`, update the auto-dismiss effect (lines 1237-1246) so the `state==='ended'` branch sets `dismissedRef.current = true` before scheduling goBack, and the `state==='failed'` branch's `dismiss` closure also sets `dismissedRef.current = true`. This prevents the new watchdog and the effect from both popping the screen.

> **Step 5:** In `src/screens/messenger/CallScreen.tsx`, freeze the remote tile during teardown: at the top of the remote-tile render branch (just before the `return ( <RTCView key={\`remote-${...}\`} ... />`at lines 1862-1881) add`if (tearingDown) { return `<View key="remote-teardown" style={StyleSheet.absoluteFill} />`; }`. Keep the key literal and constant.

> **Step 6:** In `src/screens/messenger/CallScreen.tsx`, freeze the local PiP during teardown: inside the PiP IIFE (lines 1901-1981), as the first statement add `if (tearingDown) { return <View key="local-teardown" style={styles.pipFill} />; }` so it short-circuits before computing `localUrl`/mounting RTCView/CameraView.

> **Step 7:** In `src/screens/messenger/CallScreen.tsx`, fix the hardware-back handler (lines 265-291). Replace the allowlist `if (st === 'calling' || ... )` with: `const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry'); const live = reg.getActiveCall(); const st = liveCallStateRef.current; if (live && st !== 'ended' && st !== 'failed') { reg.setMinimized(true); try { (navigation as unknown as {goBack:()=>void}).goBack(); } catch {} return true; } try { (navigation as unknown as {goBack:()=>void}).goBack(); } catch {} return true;`. Keep the `if (modalsOpenRef.current) return false;` guard above it unchanged.

> **Step 8:** In `src/screens/messenger/CallScreen.tsx`, fix the beforeRemove listener (lines 322-345): change `const liveStates = ['calling','ringing','connecting','connected','reconnecting'];` to `const liveStates = ['idle','calling','ringing','connecting','connected','reconnecting'];`, keeping the existing `if (live && !live.isMinimized && liveStates.includes(live.state)) reg.setMinimized(true);`.

> **Step 9:** Add a controller-level test in `src/modules/messenger/__tests__/callHangupWhileRinging.test.ts` (or a new `callHangupBootWindow.test.ts`): assert that calling the useCall `hangup` equivalent with a null controller triggers `endActiveCall` (mock callRegistry) and that `controller.end` is idempotent (second hangup is a no-op, state stays 'ended'). Run `npm run test:crypto`.

> **Step 10:** Add a screen test in `src/screens/messenger/__tests__/` modeled on `GroupCallScreen.autopop.test.tsx`: render CallScreen for an audio call with a mocked useCall whose `state` stays 'idle' and `hangup` is a jest.fn; tap End; assert (a) `tearingDown` placeholder renders (no RTCView), (b) `endActiveCall('ended','local')` was invoked, (c) `navigation.goBack` is called within the watchdog window (use fake timers). Run the app Jest project.

> **Step 11:** Run gates: `npm run typecheck` (mobile, must stay <= baseline 96), `npm run test:crypto`, the app Jest project, and `npm run lint`. Then do the manual smokes listed in the tests field on a device/emulator.

### ⚠️ Regressions this could introduce (guard against these)

- Double navigation.goBack() popping the parent screen (user lands two screens deep): the new 800ms watchdog and the existing state==='ended' auto-dismiss can both fire. Guard with `dismissedRef` set in BOTH paths (step 4) — verify only one pop occurs.
- Stuck FloatingCallOverlay after minimizing an 'idle' outgoing call that then fails/times out. Guard: endActiveCall on 'ended'/'failed' clears the registry (callRegistry.ts:143-159) → overlay returns null (FloatingCallOverlay.tsx:93); confirm the 45s ring timeout path (callController.ts:441 / handleRingExpire 1049) and the failed-state path both reach endActiveCall.
- tearingDown freeze accidentally swallowing the single-source call-record append (CallScreen.tsx:1173-1216 runs on unmount). The freeze is render-only and the append effect is unmount-only — verify the call bubble still lands exactly once after End (no duplicate, no missing).
- Placeholder View replacing RTCView at a different child index could itself trip the Fabric reconciler. Keep the placeholder at the SAME slot with a constant key; verify sibling order (BlurView, footer) is unaffected.
- endActiveCall called twice for a local End (once directly from endCall, once from useCall's onState('ended')→endActiveCall). It is idempotent (`if (!active) return;` callRegistry.ts:143) — confirm no double FG-service stop error and no double CallKit reportEnded surfaced to the user.
- Minimizing on 'idle' could let a user background a call that never sent an offer (controller not built) — the overlay End must still clear it. Covered by step 1 (useCall.hangup null-controller fallback) and FloatingCallOverlay hangup=endActiveCall.
- Regression to incoming-ringing Decline: declineCall now sets tearingDown; ensure the ringing Answer/Decline subtree (CallScreen.tsx:2304-2324, 1990-2011) is not the frozen subtree (only the RTCView tiles are gated), so Decline UI stays interactive until pop.

### Tests / verification

- npm run test:crypto (covers src/modules/messenger/__tests__ controller + signalling suites — extend with the null-controller hangup test)
- npm test (app Jest project — add the CallScreen End/teardown screen test modeled on GroupCallScreen.autopop.test.tsx)
- npm run typecheck (mobile; must not exceed baseline 96)
- npm run lint
- Manual smoke A (golden): device 2 accounts, place 1:1 AUDIO call, connect, press End on the caller → both ends show 'ended', notification cleared, no crash, screen pops to chat.
- Manual smoke B (boot-window End): place a 1:1 audio call and press End within ~1s (before it connects, while controller may be null) → call tears down, screen pops, no stuck dead End button.
- Manual smoke C (Back minimize): place a 1:1 audio call, press hardware Back immediately (idle/calling) AND after connect → FloatingCallOverlay pill appears ('Connecting…'/'On call'), call stays alive, tap pill restores CallScreen, End from the pill ends it.
- Manual smoke D (swipe-back on OneUI/Samsung): connected 1:1 call, edge-swipe back → minimizes (beforeRemove), not ends.
- Manual smoke E (crash check): repeat End during video and during a mid-call audio→video upgrade to exercise the RTCView teardown freeze — confirm no native 'child already has a parent' crash (compare to B-37).
- Regression smoke: send+receive a 1:1 text and a group message, and run a group call End, to confirm no collateral damage to adjacent call/registry flows.

### Open questions / decisions needed

- Is the user's reported build actually CURRENT main, or a pre-fix APK? The repo already implements Back→minimize (CallScreen.tsx:265-345) and End teardown; QA logged steady-state End as PASS (sqa.md:855). Confirm the failing build/version to know whether this is a regression vs. a stale binary before investing in code changes.
- Do we want an 'idle' outgoing call to be minimizable at all, or should Back during pre-offer dialing CANCEL (like a phone dialer)? The spec proposes minimize-if-registry-has-a-call; product may prefer cancel-before-offer. Decide the desired UX.
- Should the 800ms End watchdog be shorter/longer? Too short risks popping before the clean 'ended' frame ships to the peer (peer would then ICE-time-out to 'failed' as in B-23/sqa.md:3691); the watchdog is a fallback only — confirm liveCall.hangup() already sent call.hangup over the wire before the pop.
- Is a native Android Picture-in-Picture (enterPictureInPictureMode) expected, or is the in-app FloatingCallOverlay pill sufficient? The current design is an in-app overlay, not OS PiP. Clarify the WhatsApp-parity expectation.

---

## 5. MISSION-GROUP — Mission Ops Room: add assigned CPOs to the auto-created group + archive the group (hide from client & SP) on completion 🔒 (architecture sign-off required)

**Covers your requests:**

- #6/#6th: after accepting/crewing a mission a group is created with admin = service provider, but the assigned CPOs are NOT added. All CPOs assigned to that mission must be in the group (able to read/send in the encrypted Ops Room).
- #6th: after completing the mission the message group must be archived out of chat history — the client and the service provider must NOT see the archived chat. Persist it in the DB for later (audit), just hide it from their interface.

### Root cause

CPO-not-added: the mission Ops Room is created as a SERVER conversations row (system-messenger.service.ts:189 `convs.create(...)`) with a server-generated UUID and the agency only as a metadata admin (role='admin' in conversation_members). The agency device never runs `makeNewGroup`/`createGroupChat`, so it holds NO local GroupState and NO group master key for that conversation id. `addGroupMember` requires an existing local group (productionRuntime.ts:2513-2514 `store.groups[groupId]` must be set) and throws 'unknown group' otherwise, so `drainDispatchRoomIntents` fails on every CPO add-intent and the intents loop pending forever. The architecture mismatch: add-intents assume the agency device already bootstrapped the group (the department-channel model), but the mission flow built the room on the server-conversations primitive and skipped the bootstrap step. Because `makeNewGroup` derives and receivers verify the group id (groupClient.ts:523,573), the agency device cannot bootstrap a normal makeNewGroup group whose id matches the server conversation UUID without an externally-assigned-id variant.\n\nArchive-not-hidden-from-SP: the auto-dispatch completion chokepoint (settlement.service.ts:119-132) hides the room by deleting only role='member' conversation_members, which keeps the agency (role='admin') a member, so the SP keeps seeing it; and it never sets archived_at, so listMine's archived filter never engages.

### Current behavior (as built)

CPO-ADD (broken): When an agency crews a booking, `OrgMissionService.assignCrew` (apps/auth-service/src/org/org-mission.service.ts:332-347) calls `systemMsg.createMissionOpsRoom({... crew_user_ids: [], ops_admin_user_id: provider, creator_user_id: provider})` then enqueues one add-intent per CPO via `roomIntents.enqueueRoomIntent(orgUserId, bookingId, room.conversation_id, cpo, 'add', requestedBy)`. `createMissionOpsRoom` (apps/auth-service/src/ops/system-messenger.service.ts:160-217) creates a SERVER conversations row via `this.convs.create(creator, 'group', memberIds, title)` — i.e. the room's id is a server-generated UUID, with the agency as role='admin' and the client as role='member' in conversation_members. The agency device drains intents on dashboard focus: AgentDashboardScreen.tsx:201-202 `if (data.agent.type === 'company') { void drainDispatchRoomIntents().catch(()=>{}); }` → src/modules/messenger/orgWorkspace/dispatchRoomIntents.ts:53-56 calls `runtime.addGroupMember({groupId: intent.conversation_id, newMember:{userId, deviceId:1}})`. ROOT PROBLEM: `addGroupMember` in src/modules/messenger/runtime/productionRuntime.ts:2512-2514 does `const cur = store.groups[groupId]; if (!cur) {throw new Error('addGroupMember: unknown group ' + groupId);}`. The agency device NEVER ran `createGroupChat`/`makeNewGroup` for this room (the conversation was minted server-side), so `store.groups[serverConvUuid]` is undefined → addGroupMember throws → drain's catch increments `failed` and never acks → the intent stays 'pending' forever and the CPO is never rekeyed in. No device holds a master key for the room, so the Ops Room E2EE chat is non-functional for everyone (client included), and a group call would also fail (no key). The proven WORKING pattern is department channels: the admin device lazily bootstraps the Signal group itself — DepartmentChannelsScreen.tsx:50-77 `openChannel` calls `rt.createGroupChat({name, members})` (which runs `makeNewGroup` → fresh master key + broadcasts the admin `create` envelope to all members) then `departmentApi.registerGroup(channelId, conversationId)` to write the derived group id back (apps/auth-service/src/department/department.service.ts:88-101). Mission Ops Rooms have NO equivalent agency-device bootstrap step. Note `makeNewGroup` DERIVES the group id cryptographically (packages/messenger-core/src/groups/groupClient.ts:523 `const groupId = deriveGroupId(salt, Object.keys(members))`) and receivers verify it (`verifyGroupIdDerivation`, groupClient.ts:573-581) — so the server cannot simply dictate that a makeNewGroup group id equal the server conversations UUID.\n\nARCHIVE (partially built, gap on the auto-dispatch path): The infra exists. `archiveConversation` flips `archived_at` (system-messenger.service.ts:253-261: `UPDATE conversations SET archived_at = COALESCE(archived_at, NOW()), archived_reason = COALESCE(archived_reason,$2)`; columns added in supabase/migrations/20260424200000_conversation_archive.sql:13-14). `conversations.service.listMine` already filters archived for EVERYONE (apps/auth-service/src/conversations/conversations.service.ts:83-95 `WHERE c.archived_at IS NULL`). The mobile chat list (MessengerHomeScreen.tsx:124-179) calls `conversationApi.listMine()` (src/services/api.ts:1510) and PRUNES local UUID conversations no longer returned (lines 167-175) — so an archived room disappears from the client AND SP mobile chat list on next sync. GroupsScreen.tsx:124 reads the same local store (`type==='group'`), so it follows the prune. GAP: only `mission.service.complete` (mission.service.ts:399) and `mission.service.abort` (mission.service.ts:534) call `archiveConversation`. The AUTO-DISPATCH completion funnel does NOT: the single chokepoint `SettlementService.settleEscrowRelease` (apps/auth-service/src/settlement/settlement.service.ts:119-132) only does `DELETE FROM conversation_members WHERE conversation_id=$1 AND role='member'` + appends ' · COMPLETED' to the title. That deletes the CPOs and the CLIENT (role='member') but KEEPS the AGENCY (role='admin', the creator) — so the SP STILL SEES the room, violating the requirement. ops.service.completeBooking (ops.service.ts:1292-1313) uses the same per-member-delete and explicitly chose it over archived_at (ops.service.ts:1288-1291) to keep ops visibility. So no auto-dispatch completion path sets archived_at, and the per-member approach leaves the SP/agency in the room.

### Key files

| File                                                                | Role                                                                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/auth-service/src/org/org-mission.service.ts`                | assignCrew — creates mission+crew, opens Ops Room (createMissionOpsRoom), enqueues per-CPO add-intents (lines 332-353). The CPO-add entry point.                        |
| `apps/auth-service/src/ops/system-messenger.service.ts`           | createMissionOpsRoom (160-217) server-creates the conversations row; archiveConversation (253-261) flips archived_at. Already has the archive primitive.                 |
| `apps/auth-service/src/dispatch/dispatch-room-intents.service.ts` | enqueue/list/ack of dispatch_room_intents (the agency's membership to-do queue).                                                                                         |
| `src/modules/messenger/orgWorkspace/dispatchRoomIntents.ts`       | drainDispatchRoomIntents() on the agency device — calls runtime.addGroupMember per intent. Where the bootstrap-before-add step must be inserted.                        |
| `src/modules/messenger/runtime/productionRuntime.ts`              | addGroupMember (2509-2526) throws 'unknown group' when no local GroupState; createGroupChat (2187-...) is the makeNewGroup bootstrap path to mirror.                     |
| `packages/messenger-core/src/groups/groupClient.ts`               | makeNewGroup (508-539) derives groupId; verifyGroupIdDerivation (573-581) — back-compat no-verify when saltB64 absent. Source of the externally-assigned-id constraint. |
| `src/screens/agent/AgentDashboardScreen.tsx`                      | agency-device drain trigger (201-202), company-agent gated.                                                                                                              |
| `src/screens/messenger/DepartmentChannelsScreen.tsx`              | the proven working bootstrap reference (openChannel 50-77: createGroupChat + registerGroup).                                                                             |
| `apps/auth-service/src/settlement/settlement.service.ts`          | settleEscrowRelease (85-135) — the auto-dispatch completion chokepoint; currently per-member delete, must archive instead.                                              |
| `apps/auth-service/src/ops/mission.service.ts`                    | complete (399) + abort (534) already archive; the legacy/admin reference for archive-on-completion.                                                                      |
| `apps/auth-service/src/conversations/conversations.service.ts`    | listMine (83-95) filters archived_at IS NULL — the server-side hide that drives the mobile prune.                                                                       |
| `src/screens/messenger/MessengerHomeScreen.tsx`                   | mobile chat list sync+prune (124-179) — hides rooms dropped from listMine. No change needed for archive-hide, but drives GroupsScreen.                                  |
| `supabase/migrations/20260424200000_conversation_archive.sql`     | archived_at/archived_reason columns already exist (no new migration needed for archive).                                                                                 |
| `supabase/migrations/20260626000000_dispatch_room_intents.sql`    | the intent queue table (conversation_id, org_user_id, member_user_id, action, state).                                                                                    |

### Proposed changes (per file)

**1. `packages/messenger-core/src/groups/groupClient.ts (+ mirror src/modules/messenger/groups/groupClient.ts)`**

- **Change:** Add a sanctioned externally-assigned-id constructor `makeAssignedGroup({groupId, name, owner, ownerDeviceId, members})` that builds a GroupState IDENTICAL to makeNewGroup (fresh masterKey via genMasterKey, epoch 0, owner admin) but sets `groupId` to the caller-supplied value and leaves `saltB64` undefined so receivers use the back-compat no-verify branch of verifyGroupIdDerivation (groupClient.ts:574). Export it from groups/index.ts and packages/messenger-core/src/index.ts. This lets the agency device bootstrap a Signal group whose id == the server conversations UUID so the existing conversations/conversation_members/system_broadcasts/push wiring keeps working unchanged.
- **Why:** makeNewGroup derives+verifies the id, which cannot equal a server UUID. An assigned-id variant is the minimal reconciliation that preserves the conversations-based room infra (cards, push, IDOR).
- **Risk:** SECURITY-GATED: relies on the saltB64-absent branch that skips groupId-derivation verification for this group type. Must get architecture sign-off; does NOT alter the Double-Ratchet/epoch/rekey/masterKey primitives. Keep the create-broadcast signature (signGroupCreate) intact so member-substitution protection still holds.

**2. `src/modules/messenger/runtime/productionRuntime.ts`**

- **Change:** Add a runtime method `ensureAssignedGroup({groupId, name, members})` (and surface it on the runtime interface in runtime.ts): if `store.groups[groupId]` already exists, no-op; else build state via `makeAssignedGroup({groupId, name, owner: ownAddress.userId, ownerDeviceId: signalDeviceId, members})`, `store.setGroupState(state)` + `store.upsertConversation(...)`, then broadcast the admin `create` envelope to all members using the SAME machinery as createGroupChat (ensureSession→ensureOutgoingSession, signGroupCreate, broadcastToGroup admin:{type:'create',state,creatorSignature}, wrapOuter, transport.send/relay.send). Members passed in = [clientId] only (CPOs are added afterward by the existing add-intents so each add advances the epoch).
- **Why:** Mirrors createGroupChat (the approved bootstrap) but for an externally-assigned id; gives the agency device a real master key so addGroupMember stops throwing.
- **Risk:** Reuses the proven create path; main risk is mis-wiring the per-recipient session establishment. Covered by test:crypto + a new unit test.

**3. `src/modules/messenger/orgWorkspace/dispatchRoomIntents.ts`**

- **Change:** Before the add/remove loop, group pending intents by conversation_id. For each conversation the agency device is admin of but has no local GroupState (`!store.groups[conversation_id]`), fetch the room's members via conversationApi.get(conversation_id) (or a lightweight new field on listRoomIntents), compute clientMembers = members excluding the agency self and excluding all crew member_user_ids in pending add-intents, and call `runtime.ensureAssignedGroup({groupId: conversation_id, name, members: clientMembers})`. THEN run the existing per-intent addGroupMember/removeGroupMember loop (now succeeds because the group exists). On bootstrap failure, skip that conversation's intents (leave pending) — never ack.
- **Why:** Folds the bootstrap into the existing drain so a single agency-device trigger both creates the group (client gets key) and adds each CPO (rekey per add). No assignCrew change needed.
- **Risk:** If the create-broadcast races a CPO add, ordering must be bootstrap→adds; enforce by doing all bootstraps first. Guard with the per-group admin lock already in addGroupMember.

**4. `apps/auth-service/src/dispatch/dispatch-room-intents.service.ts`**

- **Change:** Extend listRoomIntents to also return, per intent (or grouped), the room's non-crew member set the device needs to bootstrap — e.g. add `client_id` by joining lite_bookings.client_id for the booking. Avoids a second round-trip and an over-broad conversationApi.get.
- **Why:** Gives the drain everything it needs to bootstrap without widening conversation read scope.
- **Risk:** Low; pure read addition, keep org-scoped WHERE org_user_id=$1.

**5. `apps/auth-service/src/settlement/settlement.service.ts`**

- **Change:** In settleEscrowRelease (lines 119-132) REPLACE the `DELETE FROM conversation_members ... role='member'` with an archive flip in the same tx: `UPDATE public.conversations SET archived_at = COALESCE(archived_at, NOW()), archived_reason = COALESCE(archived_reason, 'mission_completed') WHERE id = $1`. Keep the title ' · COMPLETED' suffix optional. This hides the room from client AND SP via listMine while preserving all rows/envelopes (soft hide).
- **Why:** archived_at hides for everyone (client + SP) and persists in DB — exactly the requirement; the per-member delete left the agency admin in the room.
- **Risk:** Behavior change for OPS: the room also drops from ops-console listMine (still reachable by direct id via getForUser, which does not filter archived). Flag in PR; if ops must keep list visibility, gate the archive to auto-dispatch (dispatch_mode) bookings only.

**6. `apps/auth-service/src/booking/booking.service.ts (cancel/partial path ~640-695) and any AGENCY_NO_SHOW/abort auto path`**

- **Change:** Ensure terminal auto-dispatch transitions that close the room also archive it (call the same archived_at flip) so cancellations/no-shows hide consistently. mission.service.abort already archives (534); verify the auto cancel/no-show funnels do too.
- **Why:** Consistent hide across all terminal states, not just clean completion.
- **Risk:** Low; idempotent COALESCE flip.

### Step-by-step prompts for Claude

_Hand these to Claude one at a time, in order._

> **Step 1:** STEP 1 (security sign-off FIRST): Do NOT write code yet. Open packages/messenger-core/src/groups/groupClient.ts:508-581 and confirm with the System Architecture Documentation owner that an externally-assigned group id (saltB64 omitted → verifyGroupIdDerivation no-op at groupClient.ts:574) is acceptable for mission Ops Rooms, and that the bootstrap must use the existing admin-`create` broadcast (signGroupCreate intact) so epoch/rekey/masterKey and member-substitution protections are unchanged. Record the sign-off in the PR. If denied, fall back to the full dept-channel model (move the room off conversations) — larger, separate spec.

> **Step 2:** STEP 2: In packages/messenger-core/src/groups/groupClient.ts add `export function makeAssignedGroup(params: {groupId: string; name: string; owner: string; ownerDeviceId: number; members: Array<{userId: string; deviceId: number}>}): GroupState` — copy makeNewGroup (groupClient.ts:508-539) verbatim but set `groupId: params.groupId`, omit `saltB64` (leave undefined), keep `masterKeyB64: genMasterKey()`, `epoch: 0`. Export it from packages/messenger-core/src/groups/index.ts (or wherever makeNewGroup is exported) and re-export from packages/messenger-core/src/index.ts. Mirror the SAME addition into src/modules/messenger/groups/groupClient.ts (the mobile copy) and src/modules/messenger/groups/index.ts to keep the two in sync (see CODEBASE_MAP golden rule).

> **Step 3:** STEP 3: In src/modules/messenger/runtime/productionRuntime.ts add an `ensureAssignedGroup` method on the runtime object, placed near createGroupChat (~2187) and addGroupMember (~2509). Implementation: `const store = useMessengerStore.getState(); if (store.groups[groupId]) return {conversationId: groupId, created:false};` else build `const state = makeAssignedGroup({groupId, name, owner: ownAddress.userId, ownerDeviceId: signalDeviceId, members: members.map(uid=>({userId:uid, deviceId:1}))});` then replicate createGroupChat's body from store.setGroupState(state) + store.upsertConversation(...) through the broadcastToGroup admin create fan-out (ensureSession/ensureOutgoingSession, certCache.get, signGroupCreate(creatorIdentity.privKey, state), wrapOuter, transport.send/relay.send). Return {conversationId: groupId, created:true}. Add `ensureAssignedGroup?: (args:{groupId:string; name:string; members:string[]}) => Promise<{conversationId:string; created:boolean}>` to the runtime interface in src/modules/messenger/runtime/runtime.ts.

> **Step 4:** STEP 4: In apps/auth-service/src/dispatch/dispatch-room-intents.service.ts extend listRoomIntents (lines 58-66) to also SELECT the booking's client id: join `lite_bookings b ON b.id = dri.booking_id` and add `b.client_id`. Add `client_id: string` to the DispatchRoomIntent interface (lines 4-11). Keep WHERE org_user_id=$1 AND state='pending'. Update apps/auth-service/src/dispatch/dispatch-room-intents.service.spec.ts to expect the new field.

> **Step 5:** STEP 5: In src/services/api.ts update the dispatchApi.listRoomIntents (~1374) return type to include `client_id: string` per intent. No new endpoint needed.

> **Step 6:** STEP 6: In src/modules/messenger/orgWorkspace/dispatchRoomIntents.ts: after fetching intents and the runtime, FIRST pass — build a Map<conversation_id, Set`<crewUserId>`> from the pending add-intents and a Map<conversation_id, clientId> from intent.client_id. For each distinct conversation_id where `useMessengerStore.getState().groups[conversation_id]` is undefined, call `await runtime.ensureAssignedGroup?.({groupId: conversation_id, name: 'MISSION OPS ROOM', members: [clientId].filter(Boolean)})`; on throw, record those intents as skipped and `continue` (do not proceed to add them this cycle). SECOND pass — the existing per-intent loop (lines 36-67) unchanged; now addGroupMember finds the bootstrapped group and succeeds, then acks. Keep 'ack only on success'.

> **Step 7:** STEP 7: Update src/modules/messenger/__tests__/dispatchRoomIntents.test.ts: add a case where the group is NOT yet in store.groups → expect runtime.ensureAssignedGroup called once with {groupId: conversation_id, members:[client_id]} BEFORE addGroupMember; and a case where the group already exists → ensureAssignedGroup NOT called, addGroupMember called directly. Keep the existing 'ack only on success / pending on throw / skip unbootstrapped' assertions.

> **Step 8:** STEP 8 (archive): In apps/auth-service/src/settlement/settlement.service.ts replace the block at lines 120-132 (the conversation_members DELETE + title suffix) with: `await tx.q("UPDATE public.conversations SET archived_at = COALESCE(archived_at, NOW()), archived_reason = COALESCE(archived_reason, 'mission_completed') WHERE id = $1", [ctx.conversation_id]);` (keep it inside `if (ctx?.conversation_id)`). Optionally keep the ' · COMPLETED' title update for ops cosmetics. This runs in the existing settlement tx (tx-aware).

> **Step 9:** STEP 9: Update apps/auth-service/src/settlement/settlement.service.spec.ts to assert the archive UPDATE (archived_at/archived_reason) is issued for the room and that conversation_members is NOT deleted anymore.

> **Step 10:** STEP 10: Verify the other terminal funnels archive consistently. Confirm apps/auth-service/src/ops/mission.service.ts:399 (complete) and :534 (abort) still archive. In apps/auth-service/src/booking/booking.service.ts cancel/partial path (~640-695) and any AGENCY_NO_SHOW auto path, add the same COALESCE archived_at flip on lite_bookings.conversation_id if absent. Add/extend specs.

> **Step 11:** STEP 11: No mobile change is required to HIDE archived rooms — MessengerHomeScreen.tsx:124-179 already prunes UUID conversations dropped from listMine, and conversations.service.listMine (apps/auth-service/src/conversations/conversations.service.ts:92) already filters archived_at IS NULL. Manually confirm GroupsScreen.tsx:124 reflects the prune after a home-screen sync; if a lingering-until-next-home-sync window is unacceptable, add a `void conversationApi.listMine()`-driven prune to GroupsScreen's focus effect too (optional robustness).

> **Step 12:** STEP 12: Run gates: auth-service `npm run build` + `npm test` (org-mission, dispatch-room-intents, settlement, mission specs); mobile `npm run test:crypto` (dispatchRoomIntents + group bootstrap + group send/receive regression) and `npm run typecheck` (must stay ≤ baseline). Then a 3-device manual smoke: agency crews a 2-CPO mission → on agency dashboard focus both CPOs appear in and can read/send the Ops Room within one drain cycle, client can read/send; complete the mission → the room disappears from BOTH client and SP chat lists but the row + envelopes remain in DB.

### ⚠️ Regressions this could introduce (guard against these)

- Infinite-pending intent loop: if ensureAssignedGroup includes a CPO in the create broadcast AND an add-intent also targets that CPO, addGroupMember throws 'already a member' (productionRuntime.ts:2520-2522), never acks, loops each focus. Guard: bootstrap with members=[client] ONLY; CPOs are added solely via add-intents so each add advances the epoch.
- Externally-assigned id weakens groupId-derivation verification for this group type (saltB64 omitted). Guard: architecture sign-off (STEP 1); keep signGroupCreate/verifyGroupCreateSignature so member-substitution protection is unchanged; do NOT touch epoch/rekey/masterKey; never log the conversation id paired with key bytes (logAudit test enforces).
- messenger-core vs mobile-copy drift: makeAssignedGroup must be added to BOTH packages/messenger-core/src/groups/groupClient.ts and src/modules/messenger/groups/groupClient.ts. Guard: groupClientMirror.test.ts (src/modules/messenger/__tests__/groupClientMirror.test.ts) must be updated/pass.
- Archive hides the room from OPS console too (listMine filters archived). Guard: confirm ops only needs direct-id/audit access (getForUser does not filter archived); if ops list visibility is required, scope the archive flip to auto-dispatch (dispatch_mode) bookings, or add an ops-only includeArchived path.
- Group CALL regression: a mission group call needs the master key. Before this fix no device had it (call would fail); after the fix all members hold it post-bootstrap+adds, so calls start working — re-test group call join in the smoke. Risk: if bootstrap runs but a CPO add-intent is still pending, that CPO can't join the call yet (expected until drain completes).
- Resume/idempotency: assignCrew's resume path (org-mission.service.ts:304-323) re-enqueues intents; ensure ensureAssignedGroup is idempotent (no-op when store.groups already has the id) so a re-drive doesn't mint a second group / re-broadcast create.
- Race: two agency devices (multi-device) could both bootstrap. Phase-1 is single-device (signalDeviceId=1), so low risk now; note for multi-device. The per-group admin lock (runWithGroupAdminLock) serialises adds.

### Tests / verification

- auth-service Jest: apps/auth-service/src/dispatch/dispatch-room-intents.service.spec.ts (listRoomIntents now returns client_id, org-scoped/IDOR), apps/auth-service/src/org/org-mission.service.spec.ts (assignCrew enqueue unchanged), apps/auth-service/src/settlement/settlement.service.spec.ts (archive flip instead of member delete), apps/auth-service/src/ops/mission.service.spec.ts (complete/abort still archive). Run `cd apps/auth-service && npm test` + `npm run build`.
- mobile crypto suite: `npm run test:crypto` — update src/modules/messenger/__tests__/dispatchRoomIntents.test.ts (bootstrap-before-add) and src/modules/messenger/__tests__/groupClientMirror.test.ts (makeAssignedGroup mirror); confirm packages/messenger-core/__tests__/groupBroadcast.test.ts + group send/receive regressions stay green.
- log-audit (security): packages/messenger-core/__tests__/logAudit.test.ts and the legacy mobile log-audit test must pass (no group id + key bytes logged).
- typecheck baselines: `npm run typecheck` (mobile ≤ baseline) and `cd apps/ops-console && npm run typecheck`.
- Manual 3-device smoke: (a) agency crews a 2-CPO mission → both CPOs + client can read/send the Ops Room within one agency-dashboard drain cycle; (b) start a group call in the room (key present); (c) complete the mission → room vanishes from client AND SP chat lists; (d) verify in DB the conversation row + system_broadcasts + message_envelopes still exist with archived_at set (e.g. via scripts/e2e-ops-load.ts which already checks archived_at, lines 333-337).

### Open questions / decisions needed

- Architecture sign-off: is an externally-assigned group id (saltB64 omitted, derivation-verify skipped) acceptable for mission Ops Rooms, or must we adopt the full dept-channel model (room moved off the conversations table, system cards + push retargeted to the makeNewGroup-derived id)? This decides scope.
- Should completion archive the room for OPS as well, or must ops-console retain it in its messenger list? If the latter, scope the archived_at flip to dispatch_mode='auto' bookings only, or add an includeArchived ops path.
- Bootstrap members: confirm the room should be client+agency at creation (CPOs added via rekey) — i.e. the client is added at bootstrap, not via an intent. Current createMissionOpsRoom already seeds the client as a metadata member; bootstrap should broadcast create to the client so they actually get the key.
- Where to trigger the bootstrap besides AgentDashboardScreen focus — also wire it on OrgMissionsScreen focus so an agency that crews and immediately opens Missions provisions the room without bouncing to the dashboard.
- Multi-device (Phase 2): which agency device owns/bootstraps the room key when the company account has >1 device? Current single-device (deviceId=1) sidesteps this; flag for the multi-device epic.
- Should a removed CPO (future remove-intent) also be archived/blocked from the room before completion, and does the existing planRemoveAndRekey path cover mid-mission crew changes once the group actually exists?

---

## 6. dept-chat — Department Chat — CPO message visibility, channel/announcement/@mention, SP+CPO+manager wiring 🔒 (architecture sign-off required)

**Covers your requests:**

- #5 (partial): in dept chat threads the service provider can message but CPOs cannot see those messages.
- #15/#18: departmental chat messages are not working — fix.
- #16: Discord-like — Manager can create a channel, add CPOs, post announcements with @mention; service providers can add a manager as a CPO.
- #16(2nd)/#20: audit each dept-chat feature for whether it works; implement/wire what is broken or missing across SP + CPO + managers.

### Root cause

"SP can post but CPOs can't see" has THREE compounding root causes, all in the lazy E2EE-group provisioning seam:

(1) SILENT PARTIAL FAN-OUT. createGroupChat returns success when `delivered>0` (productionRuntime.ts:2300-2307). Any CPO whose pairwise X3DH session can't be built at create time — no published Signal prekeys yet, never opened the messenger, or unreachable — is pushed to `failures` and silently skipped. The channel is still registerGroup'd and the SP posts; the skipped CPO has no GroupState/master key and cannot decrypt → "can't see." Symptom matches exactly.

(2) MULTI-ADMIN PROVISIONING RACE / KEY DIVERGENCE. Both the org/company account AND every manager are seeded role='admin' (department.service.ts:198-212), and the provisioning screen is reachable from two navigators. The first admin to open provisions; registerGroup is last-writer-wins (department.service.ts:92-98). If two admins open before the id is registered, two distinct groups/master keys are created; the channel ends up pointing at one group id while some members hold the other key — the SP posts into one conversation id and CPOs read a different one. This is the same class as the logged B-35 "group owner key divergence."

(3) ADD-INTENT CANNOT APPLY WITHOUT LOCAL GROUP STATE. addGroupMember throws `unknown group` when the draining device lacks the group (productionRuntime.ts:2514). CPOs are normally created AFTER the workspace is seeded (org-cpo.service.ts:127 → addMember → add-intent), so the add path — not the create path — is the common one. If the channel-admin device draining the intent did not provision the group (only the SP did), every add-intent fails and stays pending forever → those CPOs are never keyed in. drainMembershipIntents only retries on the next focus and never surfaces the permanent failure.

### Current behavior (as built)

DEPT CHAT IS E2EE, NOT PLAINTEXT. The auth-service `department` module stores METADATA ONLY (channel directory, membership+role, the messenger group linkage, unread=0 placeholder); message bodies ride the messenger relay as sealed-sender Signal group envelopes via the existing `broadcastToGroup` crypto. department.service.ts:22-31 + migration 20260603000000 confirm "Message content is end-to-end encrypted ... no plaintext or ciphertext is stored here."

DATA MODEL (supabase/migrations):

- `department_channels` (20260603000000): id, org_id→users, name, description, department, group_conversation_id (NULL until an admin device bootstraps the Signal group), created_by, archived_at. 20260629000002 added `channel_type` ('board'|'department'|'incident', default 'department') + `access` ('standard'|'read_only'|'restricted', default 'standard').
- `department_channel_members` (20260603000000): channel_id, user_id, role ('admin' can post / 'viewer' read-only), role_label, last_read_at (RESERVED, unused). UNIQUE(channel_id,user_id).
- `channel_membership_intents` (20260610010000): the rekey-intent queue (channel_id, member_user_id, action add|remove, state pending|done). Holds NO key material; the admin DEVICE drains it and broadcasts planAddAndRekey/planRemoveAndRekey.

PROVISIONING / SEND PATH (the bug surface):

- listChannels returns only rows where caller is in department_channel_members (department.service.ts:42-63: `JOIN department_channel_members m ... WHERE m.user_id=$1`). So a CPO that is not a member never sees the channel.
- seedChannelMembers (department.service.ts:193-214) seeds the ORG ACCOUNT as 'admin' AND every active org_member: managers→'admin', CPOs→'viewer'; restricted/incident channels seed managers ONLY.
- The Signal group is bootstrapped LAZILY: DepartmentChannelsScreen.openChannel (DepartmentChannelsScreen.tsx:50-77) — `if (!groupConversationId && c.my_role==='admin')` calls `rt.createGroupChat({name, members: listMembers(...)})` then `departmentApi.registerGroup`. registerGroup is last-writer-wins (department.service.ts:88-101: bare `UPDATE ... SET group_conversation_id=$2`).
- Send: DepartmentChatScreen.send (DepartmentChatScreen.tsx:72-90) gated `myRole!=='admin'` → `rt.sendText(groupConversationId, text)` (plain group fan-out; no announcement/mention payload).
- createGroupChat (productionRuntime.ts:2187-2310) builds a fresh master key, fans the admin `create` envelope (carrying the master key) to each member's pairwise X3DH session, and at :2300-2307 returns SUCCESS when `delivered>0` — pushing any member whose session could not be built into `failures` and SILENTLY DROPPING them. addGroupMember (productionRuntime.ts:2509-2518) throws `unknown group ${groupId}` if `store.groups[groupId]` is absent on the draining device.
- drainMembershipIntents (membershipIntents.ts:28-70) runs on DepartmentChannelsScreen focus; acks an intent only after addGroupMember/removeGroupMember succeeds.
- New CPOs are auto-added to open channels post-create: org-cpo.service.ts:49-91 syncMemberToOrgChannels → department.addMember (enqueues add-intent), called at :127-129.

ROLE GATING: is_org_manager is server-resolved in /auth/me (auth.service.ts:407-412 resolveIsOrgManager mirroring OrgManagerGuard). Mobile prefers it (DepartmentChannelsScreen.tsx:39, DepartmentalNavigator.tsx:63-67). SP-adds-manager is WIRED: OrgCreateCpoScreen has a cpo/manager selector (OrgCreateCpoScreen.tsx:129-156) sending member_role; ORG_MEMBER_ROLES=['cpo','manager'] in the DTO.

ENTRY POINTS: DepartmentChannelsScreen is reachable from BOTH DepartmentalNavigator (Channels tab) AND MessengerNavigator (MessengerNavigator.tsx:147) — i.e. the same lazy-provisioning logic is reachable from two stacks.

ANNOUNCEMENTS/@MENTION: there is NO @mention parsing, highlight, notification, or announcement post-type anywhere (grep mention/announcement across src + both services returns only the channel-type label 'board'/'read_only' UI strings in DepartmentalHomeScreen.tsx:138-162 and ChannelEditorScreen.tsx:23-27). An 'announcement' today = a normal text post into a board/read_only channel. Ops-console departments/page.tsx is read-only oversight (member counts + provisioned dot), no create/manage.

### Key files

| File                                                                          | Role                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/auth-service/src/department/department.service.ts`                    | Channel directory, membership+role seeding, registerGroup (last-writer-wins), add/remove member + rekey-intent enqueue, manager create/configure/archive. Root-cause #2 (registerGroup:88-101) and the seeding rules live here. |
| `apps/auth-service/src/department/department.controller.ts`                 | /department REST surface; DeptChatAccessGuard + OrgManagerGuard wiring; where a new ensure-provision / announcement endpoint would be added.                                                                                    |
| `apps/auth-service/src/department/dept-chat-access.guard.ts`                | Entitlement: company account OR active org_members. Confirms CPO/manager access scope.                                                                                                                                          |
| `apps/auth-service/src/department/dto/channel.dto.ts`                       | CreateChannelDto/ConfigureChannelDto + channel_type/access enums.                                                                                                                                                               |
| `apps/auth-service/src/org/org-cpo.service.ts`                              | syncMemberToOrgChannels (auto add/remove member to channels + enqueue rekey intent); createManagedCpo with member_role manager\|cpo — the SP-adds-manager path.                                                                |
| `src/screens/messenger/DepartmentChannelsScreen.tsx`                        | Channel list + lazy openChannel provisioning (createGroupChat→registerGroup) + drainMembershipIntents trigger. Root-cause #2 trigger site (openChannel:50-77).                                                                 |
| `src/screens/messenger/DepartmentChatScreen.tsx`                            | The thread UI: renders decrypted messages from messengerStore, admin-only composer→sendText. Where @mention parse/render + announcement styling would land.                                                                    |
| `src/modules/messenger/runtime/productionRuntime.ts`                        | createGroupChat (2187-2310, silent delivered>0 success = root-cause #1), addGroupMember (2509+, unknown-group throw = root-cause #3), removeGroupMember. SECURITY-LOCKED group crypto.                                          |
| `src/modules/messenger/orgWorkspace/membershipIntents.ts`                   | drainMembershipIntents — applies add/remove intents via runtime; acks only on success. Where failure surfacing/repair is added.                                                                                                |
| `src/navigation/DepartmentalNavigator.tsx`                                  | The 5-tab Departmental module; DepartmentChat/ChannelEditor/ChannelMembers wiring; useIsManager role branch.                                                                                                                    |
| `src/screens/deptchat/ChannelEditorScreen.tsx`                              | Manager create/edit channel UI (type+access). Works; would gain announcement/mention hints.                                                                                                                                     |
| `src/screens/deptchat/ChannelMembersScreen.tsx`                             | Add/remove CPOs to a channel (roster picker). Works at metadata layer.                                                                                                                                                          |
| `src/services/api.ts`                                                       | departmentApi client (1321-1365) — listChannels/listMembers/registerGroup/create/configure/archive/add/removeMember/intents.                                                                                                   |
| `supabase/migrations/20260603000000_pro_subscription_and_dept_channels.sql` | department_channels + department_channel_members schema (incl. unused last_read_at).                                                                                                                                            |
| `supabase/migrations/20260629000002_channel_types.sql`                      | channel_type + access columns.                                                                                                                                                                                                  |
| `supabase/migrations/20260610010000_org_workspace_membership_intents.sql`   | channel_membership_intents rekey queue + E2EE invariant doc.                                                                                                                                                                    |
| `apps/ops-console/src/app/departments/page.tsx`                             | Read-only ops oversight of channels (member count + provisioned). No create/manage.                                                                                                                                             |

### Proposed changes (per file)

**1. `apps/auth-service/src/department/department.service.ts`**

- **Change:** Make registerGroup idempotent/first-writer-wins instead of last-writer-wins: change the UPDATE at :92-98 to `UPDATE ... SET group_conversation_id=$2 WHERE id=$1 AND archived_at IS NULL AND group_conversation_id IS NULL RETURNING id`. When zero rows return because a group is already registered, re-SELECT the existing group_conversation_id and return it (a winner exists) rather than overwriting. This closes the multi-admin race (root-cause #2): the second admin adopts the first registered group instead of minting a divergent key.
- **Why:** Eliminates divergent-key / wrong-conversation-id provisioning (B-35 class). Pure metadata guard, no key material touched.
- **Risk:** Behaviour change to provisioning; a legitimate re-provision of a deliberately reset channel now needs an explicit clear path. Guard with a department.service.spec test for the conditional UPDATE + adopt-existing branch.

**2. `apps/auth-service/src/department/department.controller.ts + department.service.ts`**

- **Change:** Add `GET /department/channels/:id/provision-state` (or extend listMembers) returning {group_conversation_id, my_role, unkeyed_member_count} so a device can detect 'registered but some members lack the key', and add a server endpoint the admin device hits after a successful re-key to mark members keyed. Optionally add a single canonical-provisioner hint field (e.g. prefer the company/org account) so only ONE deterministic admin provisions.
- **Why:** Gives the client an explicit signal to run a repair pass instead of silently leaving CPOs un-keyed (root-cause #1/#3).
- **Risk:** New surface; keep it metadata-only and behind DeptChatAccessGuard. No crypto.

**3. `src/modules/messenger/runtime/productionRuntime.ts`**

- **Change:** SECURITY-GATED. In createGroupChat, return the per-member delivery result (delivered + failures[]) to the caller instead of only throwing when delivered===0 (:2300-2307). Do NOT weaken the crypto; just surface which members were not keyed so the provisioning caller can enqueue an add-intent / retry for each failure. Also harden addGroupMember to no-op-with-clear-error path when the draining device lacks the group (so the intent can be routed to a device that holds it) — needs architecture sign-off.
- **Why:** Root-cause #1: stop silently dropping un-reachable CPOs at create; root-cause #3: make missing-group-state explicit so intents route to a keyed device.
- **Risk:** Touches group master-key distribution/rekey — LOCKED. Requires architecture sign-off before implementation. Must keep verifySenderCert/admin-auth/per-group-lock intact; add no dev-skip branch.

**4. `src/screens/messenger/DepartmentChannelsScreen.tsx`**

- **Change:** In openChannel (:50-77): (a) only attempt provisioning from a single deterministic admin (e.g. when the server marks this caller the canonical provisioner) to avoid two devices racing; (b) after createGroupChat, for each returned failure enqueue an add-intent (via departmentApi.addMember idempotent) so the next drain retries that CPO; (c) re-call registerGroup which now adopts the existing id. Surface a non-blocking toast when some members could not be keyed.
- **Why:** Converts silent partial provisioning into a self-healing add-intent retry loop visible to the manager.
- **Risk:** UI/UX change; ensure the toast does not block navigation. Guard with the existing departmentalNavigator test + a new render test.

**5. `src/modules/messenger/orgWorkspace/membershipIntents.ts`**

- **Change:** Return per-intent outcomes and, for intents that fail with 'unknown group' on this device, mark them 'skipped-no-local-group' so the UI/another device can pick them up; add a bounded retry/backoff and surface a persistent-failure count to the channels screen. Do NOT ack on failure (already correct).
- **Why:** Root-cause #3: a manager device that didn't provision currently spins forever silently; make the failure observable and routable.
- **Risk:** Idempotency must hold (addGroupMember already safe to retry). Add a unit test asserting no ack on the unknown-group path.

**6. `src/screens/messenger/DepartmentChatScreen.tsx`**

- **Change:** FEATURE (#16 @mention, NOT security-gated — app-layer content inside the already-E2EE body). In the composer, detect `@` and show a member autocomplete sourced from departmentApi.listMembers; encode chosen mentions inside the message body (e.g. a lightweight `@[displayName](userId)` token already inside the plaintext that gets sealed normally by sendText). On render, parse those tokens, highlight them, and when myId is mentioned show an in-thread emphasis + bump a local 'mentions' unread. Add an 'Announcement' affordance for board/read_only channels (a pinned/priority styling + optional 'notify @all').
- **Why:** Implements the Discord-like @mention + announcements requirement entirely client-side; the relay never sees plaintext, so no crypto change.
- **Risk:** Mentions ride inside the encrypted body — never log them (logAudit test). @all on a large channel could be noisy; cap and confirm. Add a parser unit test.

**7. `src/services/api.ts`**

- **Change:** Add the new departmentApi endpoints (provision-state / mark-keyed / announcement-meta if added) mirroring the existing metadata-only client (1321-1365).
- **Why:** Client wiring for the repair + announcement metadata.
- **Risk:** Low; keep types in sync with the controller DTOs.

**8. `apps/ops-console/src/app/departments/page.tsx`**

- **Change:** Optionally surface an 'unkeyed members' / 'provisioning incomplete' badge using the new provision-state so ops can see channels where CPOs are not yet keyed (oversight only; no plaintext).
- **Why:** Makes the silent-drop failure visible to operators.
- **Risk:** Read-only; no security impact.

### Step-by-step prompts for Claude

_Hand these to Claude one at a time, in order._

> **Step 1:** STEP 1 (diagnose, no code): Reproduce the CPO-can't-see bug. In apps/auth-service, confirm for an affected channel that department_channels.group_conversation_id is set, then for each department_channel_members row check whether that user holds the group master key on-device. Add temporary structured logging (NO plaintext/keys) in src/modules/messenger/runtime/productionRuntime.ts createGroupChat around :2300 to print delivered + failures[].length and in src/modules/messenger/orgWorkspace/membershipIntents.ts drain to print processed/skipped/failed. Boot the app as SP, provision a channel, then as a CPO open it; capture which root cause (1 silent-drop, 2 race, 3 unknown-group) fires. Document findings; do not fix yet.

> **Step 2:** STEP 2 (server, low-risk, no crypto): In apps/auth-service/src/department/department.service.ts registerGroup (:88-101), change the UPDATE to first-writer-wins: `UPDATE public.department_channels SET group_conversation_id=$2 WHERE id=$1 AND archived_at IS NULL AND group_conversation_id IS NULL RETURNING id`. If it returns no row, SELECT the existing group_conversation_id; if one exists return {ok:true} (adopt) instead of overwriting; only throw not_found when the channel itself is missing. Add department.service.spec.ts cases: (a) first register sets the id, (b) second register with a different id is rejected/adopts the first. Run the auth-service suite.

> **Step 3:** STEP 3 (client, low-risk): In src/screens/messenger/DepartmentChannelsScreen.tsx openChannel (:50-77), after `rt.createGroupChat(...)` returns, call `departmentApi.registerGroup` (now idempotent) and use the id it confirms (re-fetch via listChannels) rather than assuming the local one won. If createGroupChat reports any un-keyed members (after STEP 4), call departmentApi.addMember for each to enqueue an add-intent, and show a non-blocking toast 'Some members will be added when next online.' Do not block navigation.

> **Step 4:** STEP 4 (SECURITY-GATED — get architecture sign-off FIRST): In src/modules/messenger/runtime/productionRuntime.ts createGroupChat, change the return shape to include {conversationId, groupId, failures: string[]} without weakening any crypto, sender-cert, or admin-auth check (keep :2245-2293 fan-out, ensureSession, wrapOuter intact; add NO dev-skip). Update the runtime.ts interface (createGroupChat signature ~:236) and all callers. This converts root-cause #1 from a silent drop into an actionable list. Re-run `npm run test:crypto` and the log-audit test.

> **Step 5:** STEP 5 (SECURITY-GATED — same sign-off): In productionRuntime.ts addGroupMember (:2509-2518), when `store.groups[groupId]` is absent, throw a typed error the drain can distinguish ('NO_LOCAL_GROUP') rather than a generic Error. In src/modules/messenger/orgWorkspace/membershipIntents.ts, map that to result.skipped (do NOT ack) and return per-intent reasons so the UI can show 'add pending — needs the channel owner online.' Add a unit test asserting no ack on NO_LOCAL_GROUP. Re-run test:crypto.

> **Step 6:** STEP 6 (deterministic provisioner): Decide (with architecture) a single canonical provisioner per channel — recommended: the org/company account, or the channel's created_by manager. Add a server field on listChannels (e.g. can_provision boolean) computed in department.service.ts listChannels, and in DepartmentChannelsScreen.openChannel only call createGroupChat when can_provision is true; other admins wait and adopt the registered id. This removes the two-device race at the source. Add a spec for the new flag.

> **Step 7:** STEP 7 (@mention + announcements, NOT security-gated): In src/screens/messenger/DepartmentChatScreen.tsx, add an @-autocomplete in the composer sourced from departmentApi.listMembers(channelId); encode selected mentions as `@[name](userId)` tokens inside the message text passed to rt.sendText (the body is sealed normally — no crypto change). On render (the messages.map at :143-169), parse the tokens, render highlighted chips, and when m mentions myId apply emphasis. For board/read_only channels add an 'Announcement' send mode (pinned styling + optional notify-all confirmation). Add a pure parser util + unit test. NEVER console.log the parsed mention/body (logAudit test).

> **Step 8:** STEP 8 (ops visibility, optional): Add a department.service.ts query for per-channel unkeyed/pending-intent count, expose it on the ops oversight endpoint, and render a 'provisioning incomplete' badge in apps/ops-console/src/app/departments/page.tsx. Read-only, no plaintext.

> **Step 9:** STEP 9 (verify end-to-end): Manual 3-account smoke — SP provisions a channel, adds 2 CPOs (one with no prior messenger session), SP posts; confirm BOTH CPOs eventually decrypt after a drain pass; remove one CPO and confirm rekey-out. Re-run auth-service suite, `npm run test:crypto`, mobile `npm run typecheck` (≤ baseline), and the departmentalNavigator test.

### ⚠️ Regressions this could introduce (guard against these)

- registerGroup first-writer-wins could block a legitimate re-provision after a deliberate channel reset — add an explicit admin 'clear group linkage' path before relying on idempotency; cover both branches with a spec.
- Changing createGroupChat's return shape (STEP 4) touches a widely-called runtime method — every caller (1:1/group create, ops-room create) must be updated or typecheck/`test:crypto` will break. Run the full crypto suite + a 1:1 and group send smoke (CLAUDE.md change-safety rule 6).
- Enqueuing add-intents for failed members on every open could create duplicate pending intents; rely on addMember's ON CONFLICT upsert (department.service.ts:358-363) and de-dupe intents, or the drain will repeatedly retry. Add an intent-dedupe guard.
- @mention tokens live INSIDE the E2EE body — any logging of the parsed mention or body would leak plaintext and fail packages/messenger-core/__tests__/logAudit.test.ts. Guard: never log message content; assert in the parser test.
- notify-@all on a large roster could spam; cap recipients and require a confirm dialog.
- The deterministic-provisioner flag (STEP 6) must not lock out a channel whose canonical provisioner never logs in (e.g. company account with no device) — fall back to created_by manager and document the precedence.
- Any addGroupMember/removeGroupMember error-typing change must not alter the remove-then-rekey ordering or admin-auth gate (productionRuntime.ts:2336-2356) — regression-test removeGroupMember forward secrecy.

### Tests / verification

- apps/auth-service: `npm test` (department.service.spec.ts — extend for idempotent registerGroup + adopt-existing; org-cpo.service.spec.ts for syncMemberToOrgChannels add/remove).
- Mobile crypto safety net: `npm run test:crypto` (createGroupChat / addGroupMember / removeGroupMember regressions after STEP 4-5).
- Log-audit: the static no-plaintext test packages/messenger-core/__tests__/logAudit.test.ts and the mobile equivalent (must stay green after @mention work).
- Mobile typecheck: `npm run typecheck` (must not exceed .tsc-baseline.json, currently 96) and `cd apps/ops-console && npm run typecheck`.
- Nav regression: src/navigation/__tests__/departmentalNavigator.test.ts.
- New unit tests: membershipIntents drain (no-ack on NO_LOCAL_GROUP), the @mention parser util.
- Manual 3-device smoke (no automated coverage possible): SP provision → add 2 CPOs (one with no prior session) → SP posts → both CPOs decrypt after drain; remove a CPO → rekey-out; manager creates a channel and adds CPOs; SP adds a manager via OrgCreateCpoScreen and that manager provisions/posts.

### Open questions / decisions needed

- Which account is the canonical channel provisioner — the org/company account (may have no physical device) or the created_by manager? This decides STEP 6 and the whole single-key-holder model.
- Is the observed bug primarily root-cause #1 (CPOs lacked published Signal prekeys at create) or #3 (add-intent never applied)? STEP 1 instrumentation must confirm before the security-gated STEP 4/5 work is justified to architecture.
- Do CPOs reliably have published Signal prekeys after the managed-CPO onboarding (org-cpo.service.ts) before they first open the messenger? If not, the real fix may be ensuring prekey publication during CPO activation rather than in the group layer.
- Should @mention trigger a push wake? Dept posts currently ride the relay with no FCM wake (per the opaque-push work, B-14/Step14) — adding a mention wake needs an opaque eventClass, not plaintext, and architecture review.
- Should 'announcement' become a real post-type (pinned, priority, read-tracked via the reserved last_read_at column) or remain just a board/read_only channel post? Affects whether a schema/DTO change is needed.
- For multi-device CPOs (future), the drain assumes deviceId=1 (membershipIntents.ts:53) — does the eventual multi-device key distribution (B-18) change the add path here?
- Is the dual entry to DepartmentChannelsScreen (DepartmentalNavigator + MessengerNavigator) intended? It doubles the race surface; consider routing all dept-chat through the Departmental module only.

---

## 7. CALLS-GROUP — Group call audio+video availability and "Call failed" in groups (incl. mission/ops rooms) 🔒 (architecture sign-off required)

**Covers your requests:**

- #7/#7th: groups created (including mission groups) show audio-call and video-call buttons but the call fails — check if OK.
- #9 (partial): the messenger group call auto-created after accepting a mission fails for audio + video — fix.

### Current behavior (as built)

Group calls route through the mediasoup SFU with native FrameCryptor (AES-256-GCM) E2E layered on top of SRTP. Any conversation with type 'group'/'ops_channel' or 3+ members is dialed via GroupCallScreen, never the 1:1 path (src/modules/messenger/webrtc/launchCall.ts:92-98 isGroupConversation, :134-194 launchCall). ChatScreen wires both call buttons to it (src/screens/messenger/ChatScreen.tsx:983-986). The hook boots a long sequence in src/modules/messenger/webrtc/useGroupCall.ts.\n\nThere are SEVEN distinct ways a group call ends in 'failed'/'unavailable', and the UI collapses all of them to one opaque label. GroupCallScreen renders a single blocking screen for full/kicked/failed/unavailable with no diagnostic reason: src/screens/messenger/GroupCallScreen.tsx:1408-1413 — `call.state === 'failed' ? 'Call failed' : 'Group call unavailable'`, Close button only (:1424).\n\nFAILURE CAUSES (current behavior, cited):\n1. iOS ALWAYS fails. frameCryptorTransport.isAvailable() returns false on any non-Android platform: src/modules/messenger/webrtc/frameCryptorTransport.ts:63-71 `if (Platform.OS !== 'android') {return false;}`. useGroupCall step=3 then refuses and sets 'failed': useGroupCall.ts:1090-1097 `if (!frameCryptorOrchestratorAvailable()) { ... setState('failed') ... }`. sqa.md:736 confirms 'FrameCryptor is NOT implemented on iOS'. So every group call on iOS shows 'Call failed' — by design, but the buttons are still shown, so users perceive a broken feature.\n2. Native module missing in the Android build. isAvailable() also returns false if NativeModules.BravoFrameCryptor is absent or the react-native-webrtc Stream-fork patch wasn't applied (frameCryptorTransport.ts:60,63-71). The source IS present (android/app/src/main/java/com/bravosecure/app/BravoFrameCryptorModule.kt, registered in MainApplication.kt; patches/react-native-webrtc+124.0.7.patch exists), so a correctly-built release APK has it. A JS-only OTA over a stale native binary, or a build that skipped patch-package, fails. This is build/native, not code.\n3. Group master key absent → fail-closed after 25s. The cryptor keys off groups[conversationId].masterKeyB64. A joiner with no key stays in 'joining' for up to 25s then throws and goes 'failed': useGroupCall.ts:1181-1215 (waitForGroupCallKey) and :1211-1213 `if (waitOutcome === 'timeout' || !hasKey()) { throw new Error('...no group master key...') }`, caught at :1259-1266 → setState('failed'). Window/ceiling: src/modules/messenger/webrtc/groupCallKeyWait.ts:66 (25_000ms).\n4. Non-owner caller WITHOUT the real-group key throws immediately. ensureCallGroupKey only re-broadcasts when the caller owns the group state (productionRuntime.ts:2701 `existing?.masterKeyB64 && existing.owner === ownAddress.userId`); otherwise for a real named group it hits the owner-poison guard and THROWS 'missing real-group master key' (productionRuntime.ts:2765). For a host that DOES have the key the call proceeds.\n5. MISSION/OPS ROOM specifics (#9 root cause). The auto-created mission group's key is owned by the AGENCY device; CPOs are rekeyed in via dispatch room intents (drainDispatchRoomIntents / enqueueRoomIntent, per Step12/13). Until a CPO's device drains the intent and processes the group 'create'/admin envelope, groups[missionConvoId].masterKeyB64 is undefined → a CPO who opens the mission group and taps call hits cause #3 (25s → 'Call failed') if joining, or cause #4 (immediate throw) if it is the caller and not the owner. The SFU server imposes NO membership/key gate (sfu.service.ts createRoom:142-165 only de-dupes by conversationId; room-token is a per-recipient HMAC, room-token.service.ts), so the failure is purely client-side key availability.\n6. SFU/TURN routing. /sfu/* and /webrtc/* are mounted on relay.*, NOT auth.* — a misconfigured MSG_BASE_URL 404s POST /sfu/rooms → throw `sfu_rooms_404` → 'failed' (useGroupCall.ts:90-94 comment, :872). No live WS transport → 'unavailable' (useGroupCall.ts:797-800).\n7. recipientUserIds empty. otherMembers() reads conversations[cid].participants (launchCall.ts:81-86); a mission group row with stale/empty participants rings nobody (the caller can still create+join solo, so this looks like 'nobody answers' not a hard fail).\n\nNet: the buttons are always shown (ChatScreen.tsx:983-986) regardless of platform or key readiness, and 'Call failed' hides which of the 7 causes fired — making both #7 'check if OK' and #9 'fix' undiagnosable in the field.

### Key files

| File                                                                         | Role                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/messenger/webrtc/useGroupCall.ts`                             | Group-call boot/teardown hook. step=3 FrameCryptor-availability refusal (1090-1097), key wait + fail-closed (1181-1215), FrameCryptor init catch → 'failed' (1259-1266). |
| `src/modules/messenger/webrtc/frameCryptorTransport.ts`                    | JS bridge to native BravoFrameCryptor. isAvailable() returns false on iOS or when native module/patch absent (60-71). This is the single availability gate.               |
| `src/modules/messenger/webrtc/frameCryptorOrchestrator.ts`                 | Per-call key provider; init() throws when no group master key (108-110). Drives cause #3/#4.                                                                              |
| `src/modules/messenger/webrtc/groupCallKeyWait.ts`                         | Pure 25s fail-closed key wait (66). Where mission-group CPOs hang then fail.                                                                                              |
| `src/modules/messenger/webrtc/launchCall.ts`                               | Decides group vs 1:1 routing, builds recipientUserIds/roomToken, probes live room. Right place for a preflight gate (134-194).                                            |
| `src/modules/messenger/runtime/productionRuntime.ts`                       | ensureCallGroupKey: host re-broadcast vs owner-poison throw (2678-2838, throw at 2765). Determines whether a non-owner caller can key the call.                           |
| `src/screens/messenger/GroupCallScreen.tsx`                                | Renders the opaque 'Call failed'/'Group call unavailable' blocker with no reason (1408-1430).                                                                             |
| `src/screens/messenger/ChatScreen.tsx`                                     | Hosts the voice/video call buttons, unconditionally (983-986).                                                                                                            |
| `apps/messenger-service/src/sfu/sfu.service.ts`                            | Server room create/join — no membership/key gate; confirms failures are client-side (142-178).                                                                           |
| `apps/messenger-service/src/sfu/room-token.service.ts`                     | Per-recipient HMAC join gate; verify reasons (room_token_required/expired/mismatch) that can surface as 'failed'.                                                         |
| `android/app/src/main/java/com/bravosecure/app/BravoFrameCryptorModule.kt` | Native AES-256-GCM cryptor; presence here + registration in MainApplication.kt is what makes Android calls work.                                                          |
| `src/modules/messenger/orgWorkspace/dispatchRoomIntents.ts`                | CPO-side drain that delivers the mission/ops-room group key; if it hasn't run, the CPO has no key (cause #5).                                                             |

### Proposed changes (per file)

**1. `src/screens/messenger/GroupCallScreen.tsx`**

- **Change:** Replace the opaque blocker (1408-1430) with a reason-aware message. Add a `failReason` field to the GroupCallHandle (plumbed from useGroupCall) and map it to human text: 'no-encryption' (iOS/native missing) → 'Group calls aren’t available on this device', 'no-key' → 'Couldn’t set up call encryption — the group key hasn’t arrived yet. Open the group chat to sync, then retry', 'no-transport' → 'You’re offline', 'room-token' → 'Call link expired — retry', 'sfu-unreachable' → 'Call server unreachable'. Keep generic 'Call failed' only as the default.
- **Why:** Both #7 (check if OK) and #9 (fix) are undiagnosable today because all 7 causes collapse to 'Call failed'. A reason string is the single highest-value change and unblocks field triage.
- **Risk:** Low — additive UI + one new optional handle field. No crypto/transport behavior change.

**2. `src/modules/messenger/webrtc/useGroupCall.ts`**

- **Change:** Add a `failReason` state (union: 'no-encryption'|'no-key'|'no-transport'|'room-token'|'sfu-unreachable'|'generic') and set it alongside each setState('failed'/'unavailable'): at 1090-1097 set 'no-encryption'; at 1211-1213/1259-1266 set 'no-key' when the throw message includes 'master key', else 'generic'; at 797-800 set 'no-transport'; at the sfu.join catch (1054-1062) set 'room-token' when message includes 'room_token', else 'generic'; at the POST /sfu/rooms !res.ok (872) set 'sfu-unreachable' on 404/5xx. Expose failReason on the returned handle.
- **Why:** Source of truth for the reason mapping. Pure additive — each branch already exists; we only tag it.
- **Risk:** Low. Must NOT change the fail-closed semantics at 1211-1213 (security: no key → no media). Only annotate, never weaken.

**3. `src/modules/messenger/webrtc/launchCall.ts`**

- **Change:** Add a preflight inside the isGroupConversation branch (before nav.navigate at 179): (a) if Platform.OS !== 'android' (or a new frameCryptorOrchestratorAvailable() probe) show an Alert 'Group calls are Android-only in this build' and return — don’t navigate into a guaranteed-fail screen; (b) compute hasGroupKey = !!useMessengerStore.getState().groups[conversationId]?.masterKeyB64; if false, fire a best-effort key request (for mission/ops rooms: trigger drainDispatchRoomIntents; for owned groups: ensureCallGroupKey resync) and show a transient notice 'Preparing secure call… retry in a moment' instead of launching a doomed 25s attempt. Still allow launch if hasGroupKey is true.
- **Why:** Stops the two most common 'Call failed' field reports (iOS, and CPO-without-key in mission groups) before they consume a 25s dead wait, and proactively pulls the mission-group key.
- **Risk:** Medium — must reuse existing key paths (no new crypto). Gating launch on hasGroupKey could over-block if the store hasn’t hydrated; guard by only blocking when BOTH masterKeyB64 missing AND a drain/resync was actually kicked. Do not bypass the in-call fail-closed gate.

**4. `src/screens/messenger/ChatScreen.tsx`**

- **Change:** Optionally disable/dim the call buttons (983-986) when frameCryptorOrchestratorAvailable() is false (iOS / native missing), with a tooltip/Alert explaining group calls aren’t available on this device, mirroring the existing callRoleGate pattern used by launchCall.
- **Why:** #7 asks whether the buttons being present is OK — on iOS they are present but always fail. Hiding/disabling them on unsupported builds resolves the perception of a broken feature.
- **Risk:** Low UI-only. Keep the buttons enabled on Android.

**5. `src/modules/messenger/orgWorkspace/dispatchRoomIntents.ts`**

- **Change:** No behavior change required, but verify (and document) that drainDispatchRoomIntents is invoked when a CPO opens a mission/ops conversation — not only on AgentDashboard focus — so the group key is present by the time the call buttons are tapped. If it is dashboard-only, add a drain trigger on mission-group ChatScreen focus.
- **Why:** Cause #5: the mission-group key only lands after the CPO drains intents. Ensuring a drain on chat-open closes the window where a CPO has the chat but not the key.
- **Risk:** Medium — touches the org-workspace key-arrival path. Drain is idempotent; main risk is extra WS traffic. Does NOT change key crypto, only when the existing drain runs.

### Step-by-step prompts for Claude

_Hand these to Claude one at a time, in order._

> **Step 1:** In src/modules/messenger/webrtc/useGroupCall.ts, add a new state `const [failReason, setFailReason] = useState<'no-encryption'|'no-key'|'no-transport'|'room-token'|'sfu-unreachable'|'generic'|null>(null);` near the other useState calls (~line 287-318). Add `failReason` to the GroupCallHandle interface (~208-269) and return it in the handle object. Do not change any crypto or fail-closed logic.

> **Step 2:** In the same file, tag each failure branch by calling setFailReason just before the existing setState: at the FrameCryptor-unavailable refusal (1090-1097) set 'no-encryption'; at the no-live-WS branch (797-800) set 'no-transport'; at the sfu.join catch (1054-1062) set 'room-token' if `(e as Error).message?.includes('room_token')` else 'generic'; at the FrameCryptor init catch (1259-1266) set 'no-key' if the message includes 'master key' else 'generic'; at the POST /sfu/rooms `if (!res.ok)` (872) set 'sfu-unreachable'. Leave the throw/setState statements themselves unchanged — the 1211-1213 fail-closed must stay intact.

> **Step 3:** In src/screens/messenger/GroupCallScreen.tsx, replace the stateLabel ternary (1409-1413) so that when call.state==='failed' it consults call.failReason and renders the mapped human text from proposed_changes; keep 'Call is full (6/6)'/'You were removed' as-is and default to 'Call failed'. Add a one-line subtitle `<Text>` under the title (after 1423) showing a remediation hint for 'no-key' and 'no-encryption'.

> **Step 4:** In src/modules/messenger/webrtc/launchCall.ts, inside the `if (isGroupConversation(...))` block (155), before the findLiveRoom navigate (163-192): import frameCryptorOrchestratorAvailable from './frameCryptorOrchestrator'; if it returns false, Alert.alert('Group calls unavailable', 'Group calls aren’t supported on this device/build.') and return. Then compute `const hasKey = !!useMessengerStore.getState().groups[opts.conversationId]?.masterKeyB64;` — if false, kick a best-effort key sync (drainDispatchRoomIntents for ops_channel/mission rooms, else ensureCallGroupKey resync via the runtime) and Alert.alert('Preparing secure call', 'The group key is still syncing — try again in a few seconds.') and return. Only navigate when hasKey is true OR the conversation is owned by self.

> **Step 5:** In src/screens/messenger/ChatScreen.tsx, import frameCryptorOrchestratorAvailable and, for the voice/video buttons (983-986), set disabled + reduced opacity when it returns false, with an onPress that Alert.alerts 'Group calls aren’t available on this device.' Leave 1:1 behavior unchanged.

> **Step 6:** Verify the mission/ops-room key arrival: read src/modules/messenger/orgWorkspace/dispatchRoomIntents.ts and its callers; confirm drainDispatchRoomIntents runs when a CPO opens the mission group (not only AgentDashboard focus). If it does not, add an idempotent drain trigger on mission-group ChatScreen mount/focus so groups[missionConvoId].masterKeyB64 is present before the call buttons are usable.

> **Step 7:** Add/extend unit tests: groupCallKeyWait already covers fail-closed; add a test asserting useGroupCall sets failReason='no-encryption' when frameCryptorOrchestratorAvailable() is mocked false, and 'no-key' on the timeout path. Add a launchCall test asserting it blocks (no nav) on iOS and on missing key. Run `npm run test:crypto` and the messenger jest project.

> **Step 8:** BUILD/NATIVE verification (no code change): confirm the release APK actually contains BravoFrameCryptor — grep the built dex or run `adb shell` + logcat for the [bravo.groupcall.keydiag] / FrameCryptor breadcrumb on a real Android device. Confirm MSG_BASE_URL points at relay.* (not auth.*) and SFU_ROOM_TOKEN_SECRET parity between client token issuance and gateway verify. This rules out causes #2 and #6.

### ⚠️ Regressions this could introduce (guard against these)

- Weakening the fail-closed gate: if the launchCall preflight or the failReason tagging accidentally lets a call proceed without a key, the SFU could see plaintext media. Guard: never alter useGroupCall.ts:1211-1213 or frameCryptorOrchestrator.init() throw; only annotate. The preflight must BLOCK (return) not bypass.
- Over-blocking on store-not-hydrated: gating launch on groups[cid].masterKeyB64 could refuse a legitimate call if the store hasn’t loaded. Guard: only block when masterKeyB64 is missing AND a drain/resync was kicked; always allow when the conversation is self-owned (host re-broadcasts its own key).
- Hiding call buttons on iOS could regress 1:1 calls (which are NOT FrameCryptor-gated). Guard: apply the disable ONLY in the group-call path / when isGroupConversation, never to 1:1.
- Adding a drain trigger on mission-group ChatScreen focus could increase WS traffic or race the existing dashboard drain. Guard: reuse the existing idempotent drainDispatchRoomIntents (it already de-dupes); do not duplicate intent processing.
- Mislabeling failReason (e.g. tagging a genuine SFU outage as 'no-key') would mislead triage. Guard: derive 'no-key' strictly from the throw message containing 'master key', everything else defaults to 'generic'.

### Tests / verification

- npm run test:crypto (FrameCryptor key derivation + group crypto + adhocCallKeyLookup)
- messenger jest project: groupCallKeyWait, groupCallResume, groupCallMissedRing, sfuDispatcher, adhocCallKeyLookup, plus new useGroupCall failReason + launchCall preflight tests
- npm run typecheck (mobile) — must stay at/under baseline; cd apps/ops-console && npm run typecheck if touched
- Manual smoke on a real ANDROID device (FrameCryptor is Android-only): (a) 3-person named-group video call, (b) accept a mission → open the auto-created mission group on a CPO device → confirm group key present → audio + video call connects, (c) force key-absent (fresh CPO before drain) and confirm the new 'group key still syncing' message instead of a 25s 'Call failed', (d) iOS device → confirm buttons disabled/explained rather than launching into 'Call failed'
- Backend: apps/messenger-service npm test for sfu.service / room-token (no change expected, regression only)

### Open questions / decisions needed

- Is the mission/ops-room call expected to work on iOS at all? FrameCryptor is Android-only today (frameCryptorTransport.ts:64; sqa.md:736). If iOS group calls are in scope, that requires implementing the native iOS cryptor — a security-gated architecture item, not a code tweak.
- For mission/ops rooms, is drainDispatchRoomIntents currently invoked anywhere other than AgentDashboard focus? Need to confirm the CPO reliably holds groups[missionConvoId].masterKeyB64 by the time call buttons are tapped (cause #5).
- When a non-owner CPO initiates the mission-group call, should they be allowed to host/key it at all, or should only the agency (owner) be the host? ensureCallGroupKey throws for a non-owner without the key (productionRuntime.ts:2765) — product decision on who may start a mission-group call.
- Is SFU_ROOM_TOKEN_SECRET set in staging/prod, and does the by-conversation probe always return a roomToken? A set secret without a client token surfaces as 'failed' (room_token_required).
- Is MSG_BASE_URL correctly pointing at relay.* in the current builds, or could cause #6 be live (the 404 path is documented as a past staging incident, useGroupCall.ts:90-94)?

---

## 8. LIVE-MONITOR-CHAT — Live-monitor (CPO + principal) chat composer keeps "connecting"/records infinitely + mission group call fails

**Covers your requests:**

- #9/#9th: after accepting + assigning crew, the SP admin opens Live Monitor (cpo+principal); the send-message interface, after sending, keeps connecting and recording infinitely — fix.
- #9th: the messenger group call generated after accepting the mission (audio+video) fails — fix.

### Root cause

Two distinct in-area root causes plus one cross-area symptom. (1) 'Records infinitely' = VoiceNoteRecorder press-and-hold race: `start()` is async (permission + Audio.Recording.createAsync) while `onPressOut` is synchronous and no-ops when `startedAt` is still null (VoiceNoteRecorder.tsx:76-88,112-127); a quick tap — exactly what happens because ChatScreen swaps the send button for the mic at the same coordinate after `setText('')` (ChatScreen.tsx:536,1212-1230) — arms a recording that only the 5-minute auto-finalise can stop (VoiceNoteRecorder.tsx:60-65,26). (2) 'Group call fails' = launchCall misroutes the mission ops_channel to a broken 1:1: AgentLiveTracker calls `launchCall(commsChannelId)` (AgentLiveTrackerScreen.tsx:613-624) but never upserts `conversations[commsChannelId]` into messengerStore, so `isGroupConversation` returns false for the unhydrated row (launchCall.ts:92-98) and `resolvePeerForCall` returns null (launchCall.ts:67-78), producing a CallScreen nav with undefined peer/callId (launchCall.ts:196-205). (3) 'Keeps connecting' = the ConnectionBanner truthfully reporting a transport stuck in connecting/reconnecting (ConnectionBanner.tsx:53, client.ts:225-231,405) — the MSG-RECONNECT/JWT-drift family, not fixable inside this screen; partly conflated with the stuck recorder bar.

### Current behavior (as built)

ENTRY POINT. The "Live monitor · CPO + principal" button lives on the SP-admin missions board: `src/screens/agent/OrgMissionsScreen.tsx:93-97` renders it for ACTIVE jobs and `:219` navigates `navigation.navigate('AgentLiveTracker', {missionId: j.mission_id, mode: 'monitor'})`.

THE MONITOR SCREEN. `src/screens/agent/AgentLiveTrackerScreen.tsx` is the map-first tracker; in `mode='monitor'` it reads the org-scoped live endpoint (`:221-223` `orgApi.getMissionLive(missionId)`) and exposes a bottom message dock (`:768-814`) with a TextInput (`:778-788`), voice/video call buttons (`:769-776`), and a send handler. The dock does NOT send: `sendDraft` (`:626-635`) calls `openChat(trimmed)` which `navigation.navigate('Chat', {conversationId: commsChannelId, ... draft: prefilled})` (`:593-611`). `commsChannelId` is set only from the poll (`:254 setCommsChannelId(data.mission?.comms_channel_id ?? null)`).

SEND-MESSAGE INTERFACE = ChatScreen. `src/screens/messenger/ChatScreen.tsx` seeds its composer from the passed draft (`:114 const [text, setText] = useState(draft ?? '')`). The composer (`:1183-1231`) shows EITHER a send button OR a voice recorder at the SAME screen position: `:1212 {text.trim() ? (<send button>) : (<VoiceNoteRecorder .../>)}`. `send()` (`:533-567`) clears the text immediately (`:536 setText('')`), so the instant a text send completes the composer swaps the send button for the mic at the identical coordinate.

ROOT BUG — "records infinitely". `src/modules/messenger/ui/VoiceNoteRecorder.tsx` is press-and-hold. Idle branch `:112-127`: `onPressIn={() => { void start(); }}` and `onPressOut={() => { /* not recording yet; no-op */ }}`. But `start()` (`:76-88`) is ASYNC — it awaits `Audio.requestPermissionsAsync()`, `Audio.setAudioModeAsync(...)`, and `Audio.Recording.createAsync(...)` before `setStartedAt(Date.now())`. On a quick tap (which is exactly what a user does after a send, expecting another send button), `onPressOut` fires while `startedAt` is still null → it hits the no-op branch → no stop is ever scheduled. When `start()` later resolves, `startedAt` is set and the component re-renders into the ACTIVE recording UI (`:130-144`) with the red animated bars + counting timer — but the finger is long gone. The ONLY thing that ends it is the 5-minute auto-finalise timer (`:60-65 setTimeout(... stopRef.current(false), remaining)` with `DEFAULT_MAX_DURATION_MS = 5*60*1000` at `:26`), which then AUTO-SENDS a 5-minute voice note. To the user this is "recording infinitely" (red bar + climbing timer that never stops on release).

"keeps connecting". ChatScreen renders `<ConnectionBanner state={connectionState} />` (`:1000`, `connectionState` from store `:242`). `src/modules/messenger/ui/ConnectionBanner.tsx:53` shows "Connecting…" whenever the transport state is `'connecting'`/`'reconnecting'` (`src/modules/messenger/transport/client.ts:225-231,307,326,340,405`). If the SP-admin device's messenger WS is stalled in connect/reconnect (the MSG-RECONNECT / JWT-secret-drift family — see memory note "Messenger WS JWT secret drift"), the banner sits at "Connecting…" forever and outbound text parks in the outbox. This symptom is shared with MSG-RECONNECT and is NOT fixable purely inside this screen; the in-area contributor is that the animated recorder bar is easily misread as a perpetual "connecting" state, and that nothing on this screen forces a transport (re)boot.

ROOT BUG — "group call fails". The dock call buttons call `onCall('voice'|'video')` (`:613-624`) → `launchCall(navX, {conversationId: commsChannelId, callType})`. `src/modules/messenger/webrtc/launchCall.ts:155 if (isGroupConversation(opts.conversationId))` decides group-vs-1:1. `isGroupConversation` (`:92-98`) reads `useMessengerStore.getState().conversations[conversationId]` and returns `false` when that row is undefined (`:94-95 if (!convo) {return false;}`). The live tracker only ever writes `s.messages[commsChannelId]` / `s.groupMemberNames[commsChannelId]` (subscriptions at `:362-363`) — it NEVER upserts `conversations[commsChannelId]`. So when the SP admin goes accept → assign crew → live monitor → call WITHOUT first visiting Messenger Home or opening the Chat (the only two places that hydrate `conversations` via `conversationApi.listMine()`), the mission ops_channel is absent from the store → `isGroupConversation` returns false → launchCall falls through to the 1:1 branch (`:196-205`) where `resolvePeerForCall` (`:67-78`) also returns null (convo undefined and id is a UUID, not `direct:`), navigating to `CallScreen` with `remoteUserId: undefined, callId: undefined` → the call can never establish → "group call fails." (When the room IS hydrated as ops_channel the call routes correctly to GroupCallScreen; deeper group-call key failures B-12/B-13 are a separate CALLS-GROUP/MISSION-GROUP concern, but the agency is the room OWNER per Step 13 so the owner-host key path is the good case.)

### Key files

| File                                               | Role                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/messenger/ui/VoiceNoteRecorder.tsx` | Press-and-hold mic; async start() vs sync onPressOut race = the 'records infinitely' root cause (lines 76-127, 60-65)                                         |
| `src/screens/messenger/ChatScreen.tsx`           | The real send-message interface; composer swaps send-button↔mic at same position (1212-1230), send() clears text (536), ConnectionBanner host (1000)         |
| `src/screens/agent/AgentLiveTrackerScreen.tsx`   | The Live Monitor screen (mode='monitor'); dock send hands off to Chat (626-635, 593-611), onCall→launchCall without hydrating the conversation (613-624)     |
| `src/modules/messenger/webrtc/launchCall.ts`     | Group-vs-1:1 routing; misroutes mission call to broken 1:1 when conversations[id] is unhydrated (92-98, 67-78, 155-205)                                       |
| `src/screens/agent/OrgMissionsScreen.tsx`        | Entry point: Live Monitor button + navigate to AgentLiveTracker monitor mode (93-97, 219)                                                                     |
| `src/modules/messenger/ui/ConnectionBanner.tsx`  | Renders 'Connecting…' for transport state connecting/reconnecting (53-54) — the 'keeps connecting' surface                                                  |
| `src/services/api.ts`                            | orgApi.getMissionLive returns mission.comms_channel_id but NOT conversation participants (868-869, 571), so the store row is not hydrated by the monitor poll |

### Proposed changes (per file)

**1. `src/modules/messenger/ui/VoiceNoteRecorder.tsx`**

- **Change:** Fix the async-start / sync-release race. Add `const pressActiveRef = useRef(false);`. In the idle branch (lines 112-127): `onPressIn` sets `pressActiveRef.current = true` then `void start()`; `onPressOut` sets `pressActiveRef.current = false` and, if recording is already live, `void stop(false)` — and CRUCIALLY, at the END of `start()` (after `setStartedAt(Date.now())`, lines 82-84) check `if (!pressActiveRef.current) { void stop(false); }` so a release that landed before the async setup completes immediately finalises/discards the just-started clip instead of leaving it open until the 5-min cap. Keep the existing <400ms discard (line 100) so an accidental flick is dropped rather than sent.
- **Why:** Eliminates the stuck-recording state — a quick tap (the exact gesture after a text send) can no longer arm a recorder that only the 5-minute auto-finalise can stop.
- **Risk:** Low. Touches only recorder lifecycle, no crypto/transport. Guard: a genuine long press still records and sends normally; a sub-400ms press still discards.

**2. `src/screens/messenger/ChatScreen.tsx`**

- **Change:** Decouple the mic from the send hot-zone so a post-send tap can't arm recording. In the composer (lines 1212-1230) keep the send button visible (disabled) for a brief settle window after a send, OR render the VoiceNoteRecorder only when `ready && !justSent`. Minimal version: add a `justSentRef`/short `useState` toggled true in `send()` (after line 536) and cleared ~350ms later; while true, render a disabled send glyph instead of the recorder. Do NOT change send() crypto.
- **Why:** Even with the recorder race fixed, swapping a send button for a press-to-record mic at the identical pixel invites accidental recordings; a short settle window matches WhatsApp/Signal behaviour.
- **Risk:** Low/visual. Guard: ensure the recorder reappears after the window so intentional voice notes still work; verify no extra re-render storm (use a ref + single timeout).

**3. `src/screens/agent/AgentLiveTrackerScreen.tsx`**

- **Change:** Hydrate the mission conversation into messengerStore before any call/chat hand-off so launchCall classifies it as a group. In `refresh()` where `commsChannelId` is set (line 254), when a new non-null `comms_channel_id` arrives, call `conversationApi.listMine()` once and `useMessengerStore.getState().upsertConversation(...)` for the matching row (mirror ChatScreen's group-sync effect at ChatScreen.tsx:325-360), OR add a guard in `onCall` (613-624): if `useMessengerStore.getState().conversations[commsChannelId]` is missing, run that same hydration and await it before `launchCall`. Set `type:'ops_channel'` and the real participant list.
- **Why:** Without the store row, launchCall.isGroupConversation returns false and the mission call misroutes to a broken 1:1 CallScreen. Hydrating first makes it route to GroupCallScreen with the correct member fan-out.
- **Risk:** Medium — adds a network call on the call path. Guard: dedupe (only fetch when row absent), keep it best-effort (proceed on failure), and reuse the exact upsert shape ChatScreen already uses to avoid divergent conversation rows.

**4. `src/modules/messenger/webrtc/launchCall.ts`**

- **Change:** Make group detection robust when the store row is missing but the caller knows it's a mission room. Option A: have AgentLiveTracker pass an explicit `isGroup`/`participants` hint into a launchCall option and prefer it over the store lookup in isGroupConversation (92-98). Option B (defensive): if `convo` is undefined AND the id is a UUID (not `direct:`), do a synchronous best-effort: treat as group and let GroupCallScreen hydrate. Prefer Option A (explicit) to avoid mislabeling true 1:1 UUID conversations.
- **Why:** Belt-and-braces so a future caller can't silently misroute a group call to the 1:1 path when hydration lags.
- **Risk:** Medium — changing routing heuristics can mislabel real 1:1s. Guard: only apply the hint when the caller explicitly provides it; add a unit test for both group-hint and direct: cases.

**5. `(diagnosis only) src/modules/messenger/transport/client.ts + MSG-RECONNECT`**

- **Change:** No code change proposed here for the perpetual 'Connecting…' banner — it is the shared MSG-RECONNECT / JWT-secret-drift symptom. Confirm whether the SP-admin device's WS actually reaches 'connected' (logcat for transport.setState) before attributing 'keeps connecting' to this screen. If the WS is healthy, the only in-area 'connecting'-looking artifact is the stuck recorder bar, fixed above.
- **Why:** Avoid a wrong fix: the banner faithfully reports transport state; the cure is in the transport/auth layer, not the chat screen.
- **Risk:** None (diagnostic). Coordinate with the MSG-RECONNECT area owner.

### Step-by-step prompts for Claude

_Hand these to Claude one at a time, in order._

> **Step 1:** In `src/modules/messenger/ui/VoiceNoteRecorder.tsx`, fix the press-and-hold async race so a quick tap can never leave the mic recording until the 5-minute cap. Add `const pressActiveRef = useRef(false);` near the other refs (around line 49). In the idle `TouchableOpacity` (lines 113-119) change `onPressIn` to `onPressIn={() => { pressActiveRef.current = true; void start(); }}` and `onPressOut` to `onPressOut={() => { pressActiveRef.current = false; if (startedAt) { void stop(false); } }}`. At the end of `start()` (after `setStartedAt(Date.now());` on line 83), add `if (!pressActiveRef.current) { void stop(false); return; }` so a release that beat the async setup immediately finalises (and the existing <400ms discard at line 100 drops accidental flicks). Keep all other logic unchanged.

> **Step 2:** In `src/screens/messenger/ChatScreen.tsx`, prevent a post-send tap from arming the recorder. Add `const justSentRef = useRef(false);` and a `const [justSent, setJustSent] = useState(false);`. In `send()` after `setText('')` (line 536), set `setJustSent(true)` and schedule `setTimeout(() => setJustSent(false), 350)`. In the composer conditional (line 1212), change to `text.trim() || justSent ? (<send button, disabled when !text.trim()>) : (<VoiceNoteRecorder .../>)`. Verify the recorder still appears after 350ms so intentional voice notes work.

> **Step 3:** In `src/screens/agent/AgentLiveTrackerScreen.tsx`, hydrate the mission conversation into messengerStore so the group call routes correctly. Import `conversationApi` from `@services/api` and `upsertConversation` access via `useMessengerStore.getState()`. In `onCall` (lines 613-624), before calling `launchCall`, add: if `commsChannelId && !useMessengerStore.getState().conversations[commsChannelId]`, await a helper that runs `conversationApi.listMine()`, finds the row with `id === commsChannelId`, and `upsertConversation({id: commsChannelId, type: row.kind, name: shortCode || row.title || 'Mission', participants: row.members.map(m=>m.userId), unread_count:0, is_muted:false, is_pinned:false, default_ttl_sec:null, created_at: row.createdAt, session_state:'fresh'})` — copy the exact shape from `ChatScreen.tsx:341-354`. Then call `launchCall`. Do the same guard before `openChat` is unnecessary because ChatScreen already hydrates, but reuse the helper for both.

> **Step 4:** (Optional hardening) In `src/modules/messenger/webrtc/launchCall.ts`, extend `LaunchOpts` with optional `isGroup?: boolean` and `participants?: string[]`. In `launchCall` (line 134) prefer `opts.isGroup` over `isGroupConversation(opts.conversationId)` when provided, and in the group branch use `opts.participants ?? otherMembers(...)`. Have AgentLiveTracker pass `{isGroup: true}` from `onCall` so a lagging store hydration can never misroute a known mission room to the 1:1 path. Add a Jest test asserting an explicit group hint routes to GroupCallScreen and a bare `direct:` id still routes to CallScreen.

> **Step 5:** Diagnose the 'keeps connecting' banner separately from this screen: with the SP-admin device, capture logcat for transport state transitions (`client.ts setState`) while opening the live-monitor chat. If the WS reaches 'connected', the only remaining 'connecting'-looking artifact is the recorder bar (fixed in step 1) — close it out. If the WS stays in connecting/reconnecting, escalate to the MSG-RECONNECT area (JWT_ACCESS_SECRET drift between auth and messenger containers per the memory note) — do NOT patch ConnectionBanner, which is reporting truthfully.

> **Step 6:** Add/extend tests: a VoiceNoteRecorder unit test simulating onPressIn → (async start resolves) → onPressOut-before-resolve, asserting no open recording remains (stop called, onCancel/onComplete fired appropriately). Re-run `npm run test:crypto` for regression on the messenger runtime, then a manual 3-device smoke: SP admin assigns crew → opens Live Monitor → sends a text (composer reverts cleanly, no stuck mic) → taps Voice and Video call (routes to GroupCallScreen, not CallScreen).

### ⚠️ Regressions this could introduce (guard against these)

- Recorder fix: if `pressActiveRef`/`startedAt` checks are wrong, a legitimate long-press could be cut off at start. Guard with the existing <400ms discard and a manual hold-to-record smoke.
- ChatScreen justSent window: too-long a window blocks intentional voice notes; too-short doesn't help. Keep ~300-400ms and verify the recorder reappears.
- AgentLiveTracker hydration on the call path adds latency and a possible duplicate conversation row if the upsert shape diverges from ChatScreen's. Mitigate by copying ChatScreen.tsx:341-354 verbatim and deduping (only when row absent).
- launchCall heuristic change could mislabel a genuine 1:1 UUID conversation as a group if the explicit hint is misused. Only honor an explicit caller-provided isGroup flag; add the direct: regression test.
- Do NOT 'fix' the ConnectionBanner to hide 'Connecting…' — that would mask a real transport outage and was previously deliberately made visible (ConnectionBanner.tsx:18-21).

### Tests / verification

- npm run test:crypto (messenger runtime/crypto regression)
- New VoiceNoteRecorder unit test (press-in → async-resolve → press-out race)
- launchCall routing unit test (group hint → GroupCallScreen; direct: id → CallScreen)
- npm run typecheck (mobile, must stay at/under baseline) + ops-console typecheck (no change expected)
- Manual 3-device smoke: SP admin assign crew → Live Monitor → send text (no stuck mic / no perpetual recorder bar) → start voice + video group call (routes to GroupCallScreen, media flows) → on the CPO device confirm the inbound ring/join

### Open questions / decisions needed

- Is the 'keeps connecting' symptom an actual WS stall on the SP-admin device (MSG-RECONNECT / JWT-secret drift) or just the stuck recorder bar being misread? Needs a logcat capture of transport.setState to settle.
- On the agency device, does assignCrew / drainDispatchRoomIntents already upsert conversations[commsChannelId] (Step 12/13 room creation)? If so, the live-tracker hydration may only be needed for races/cold-opens — confirm with the MISSION-GROUP owner.
- Should the live-monitor dock send directly (via runtime.sendText with the hydrated group) instead of bouncing the user into ChatScreen? Current hand-off is intentional but means two surfaces with composers.
- Are the deeper group-call key failures (B-12/B-13) reproducible when the AGENCY (room owner) hosts? Per Step 13 the agency owns the key, so owner-host should be the good path — verify with CALLS-GROUP before assuming the call still fails after routing is fixed.
- Does 'monitor' mode SP admin actually appear in the ops_channel membership/fan-out for both chat and call, or only as room creator? Affects whether their messages/calls reach the CPO + principal.

---

## 9. rating-card — Rating card shows "0 jobs" — agency jobs_total never bumped on the legacy completion path

**Covers your requests:**

- #10(2nd): in the rating card the short info says 0 jobs — it should reflect the multiple missions the agency completed, not 0.

### Root cause

`agents.jobs_total` (the column the rating card reads) is only incremented for the agency on the AUTO-dispatch escrow path (`settlement.service.ts:117`). The legacy admin `completeBooking` path increments jobs_total only for the crew CPO officers (`ops.service.ts:1340-1354`, where `paidIds` come from `payouts.push({user_id: o.officerId})` at `:1262`), never for the agency org user (`lite_bookings.assigned_provider_user_id`). Since most/all of the agency's missions completed through the legacy path (auto-dispatch still flag-gated), the agency's `jobs_total` row was never bumped and stays at its DEFAULT 0 — so the card renders \"0 jobs\" even though `OrgMissionService.listMissions` shows the completed missions. Two parts to fix: (a) the going-forward increment gap on the legacy path, and (b) the already-accumulated historical 0s, which need a one-time backfill SET to the computed completed-mission count.

### Current behavior (as built)

The rating card is on the mobile Agent/Agency dashboard. `src/screens/agent/AgentDashboardScreen.tsx:436` reads `const jobsTotal = me?.agent.jobs_total ?? 0;` and renders it at `:649`: `<Stat cap=\"Rating\" value={rating} star sub={`${jobsTotal} jobs`} />`. The same `me.agent.jobs_total` field also drives `src/screens/agent/AgentHomeScreen.tsx:55,70` (\"Jobs Done\") and `src/screens/agent/EarningsScreen.tsx:69,178-179` (\"JOBS COMPLETED\"), and the client-facing agency trust badge `src/screens/booking/AgencyAcceptedScreen.tsx:85` (`TrustBadgeRow ... jobsTotal=...`) plus ops-console `apps/ops-console/src/app/agents/[id]/page.tsx:375` and `apps/ops-console/src/app/agents/page.tsx:103`.\n\nThe value comes straight from the denormalized DB column `agents.jobs_total`. Backend read path: `agent.controller` GET /agents/me → `AgentService.getMe` (`apps/auth-service/src/agents/agent.service.ts:254`) → `requireAgent(userId)` which does `SELECT * FROM agents WHERE user_id = $1` (`agent.service.ts:165`), so `me.agent.jobs_total` is literally the `agents.jobs_total` column (defined `supabase/migrations/20260423180000_agent_portal.sql:54`: `jobs_total INTEGER NOT NULL DEFAULT 0`). The client-facing card uses the same column via `BookingService.getProvider` (`apps/auth-service/src/booking/booking.service.ts:1012`: `SELECT display_name, call_sign, rating, jobs_total FROM agents WHERE user_id = $1` on `assigned_provider_user_id`).\n\nThere are exactly three writers of `agents.jobs_total`:\n1. `apps/auth-service/src/settlement/settlement.service.ts:117` (escrow-release / AUTO-dispatch completion): `UPDATE agents SET jobs_total = jobs_total + 1 WHERE user_id = $1` with `$1 = providerId = escrow_holds.provider_user_id` — i.e. it DOES bump the AGENCY, but only on the escrow path.\n2. `apps/auth-service/src/ops/ops.service.ts:1340-1354` (legacy admin `completeBooking`): bumps `WHERE user_id = ANY($1)` with `$1 = paidIds = payouts.map(p => p.user_id)`. Those entries are pushed at `ops.service.ts:1262` as `payouts.push({user_id: o.officerId, ...})` — i.e. the CPO OFFICERS (crew), NOT the agency org user. The agency (`lite_bookings.assigned_provider_user_id`) is never bumped here.\n3. `apps/auth-service/src/agents/agent.service.ts:1690` `bumpStats` — internal/backfill helper only; the controller route was removed (`agent.controller.ts:178-183`) so it is never called in production.\n\n`completeBooking` routes escrow bookings through SettlementService and returns early (`ops.service.ts:1135-1170`), so writer #1 fires only for AUTO-dispatch bookings; everything else hits writer #2. Because AUTO_DISPATCH_ENABLED is still gated/just-staged (per memory), the agency's real missions complete via the legacy admin path → writer #2 → only the crew CPOs get +1 and the agency org row stays at 0. Hence the agency's own rating card reads \"0 jobs\" despite completed missions. The MISSION-HISTORY surface reads the truth from a different source: `OrgMissionService.listMissions` (`apps/auth-service/src/org/org-mission.service.ts:56-73`) counts `missions m JOIN lite_bookings b WHERE b.assigned_provider_user_id = $1 AND b.status IN ('CONFIRMED','LIVE','COMPLETED','AGENCY_NO_SHOW')`, so it correctly shows the completed missions the rating card cannot.

### Key files

| File                                                            | Role                                                                                                                                          |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/screens/agent/AgentDashboardScreen.tsx`                  | Rating card UI: reads me.agent.jobs_total (:436), renders`${jobsTotal} jobs` on the Rating Stat (:649)                                      |
| `src/screens/agent/AgentHomeScreen.tsx`                       | Secondary read of jobs_total (:55,:70) 'Jobs Done' tile — same column, same bug                                                              |
| `src/screens/agent/EarningsScreen.tsx`                        | Secondary read of jobs_total (:69,:178-179) 'JOBS COMPLETED'                                                                                  |
| `src/screens/booking/AgencyAcceptedScreen.tsx`                | Client-facing agency trust badge (:85) jobsTotal — same column via getProvider                                                               |
| `apps/auth-service/src/agents/agent.service.ts`               | getMe→requireAgent SELECT * FROM agents (:165,:254) returns jobs_total to the card; bumpStats helper (:1690)                                 |
| `apps/auth-service/src/settlement/settlement.service.ts`      | Writer #1: bumps AGENCY jobs_total +1 on escrow/auto-dispatch completion (:117)                                                               |
| `apps/auth-service/src/ops/ops.service.ts`                    | Writer #2 / legacy completeBooking: bumps only crew CPOs, not the agency (:1135-1170 escrow branch, :1340-1354 legacy bump, :1107 row SELECT) |
| `apps/auth-service/src/booking/booking.service.ts`            | getProvider feeds the client agency card from the same jobs_total column (:1012)                                                              |
| `apps/auth-service/src/org/org-mission.service.ts`            | MISSION-HISTORY data source (:56-73) — canonical completed-mission count per agency to cross-check / backfill against                        |
| `supabase/migrations/20260423180000_agent_portal.sql`         | agents.jobs_total column definition (:54)                                                                                                     |
| `apps/auth-service/src/settlement/settlement.service.spec.ts` | Asserts the escrow-path agency bump SQL (:36) — regression guard                                                                             |

### Proposed changes (per file)

**1. `apps/auth-service/src/ops/ops.service.ts`**

- **Change:** In completeBooking, add `assigned_provider_user_id` to the FOR UPDATE row SELECT at :1107 (`SELECT status, total_eur, conversation_id, region_code, assigned_provider_user_id FROM lite_bookings ...`) and widen the typed row. Then in the legacy stats-bump block (:1340-1354), after the existing crew bump, add a SEPARATE guarded UPDATE that bumps the agency provider once per completed booking: only when `row.assigned_provider_user_id` is non-null AND not already in `paidIds` (avoid double-count when an individual CPO is their own provider). Keep it as its own statement so the existing crew-bump assertion is undisturbed.
- **Why:** Closes the going-forward gap so every legacy completion bumps the agency's jobs_total exactly as the escrow path already does for auto-dispatch.
- **Risk:** Double-count if provider also appears as crew — guarded by the `provider NOT IN paidIds` / IS DISTINCT FROM check. Wrapped in try/catch like the existing bump so a failure never rolls back the completion.

**2. `supabase/migrations/20260625000000_backfill_jobs_total.sql`**

- **Change:** New idempotent backfill migration that SETs agents.jobs_total to the true historical count: for each agent, (# COMPLETED bookings where they are assigned_provider_user_id) + (# COMPLETED missions where they are crew AND not the booking's provider). Use `IS DISTINCT FROM` so the crew leg never double-counts a self-provider. Example: `UPDATE agents a SET jobs_total = (SELECT COUNT(*) FROM lite_bookings b WHERE b.assigned_provider_user_id = a.user_id AND b.status='COMPLETED') + (SELECT COUNT(DISTINCT mc.mission_id) FROM mission_crew mc JOIN missions m ON m.id=mc.mission_id AND m.status='COMPLETED' JOIN lite_bookings b2 ON b2.id=m.booking_id WHERE mc.agent_id=a.user_id AND b2.assigned_provider_user_id IS DISTINCT FROM a.user_id);`
- **Why:** Corrects the agencies (and CPOs) already sitting at 0/partial. SET (not increment) makes it idempotent and self-healing regardless of which writers fired before.
- **Risk:** Overwrites any manual jobs_total edits (none expected). Definition must match the going-forward increments (provider-as-booking + crew-as-mission) or the column will drift again. Verify column/type names against live schema before applying.

**3. `apps/auth-service/src/ops/ops.service.spec.ts`**

- **Change:** Add a completeBooking legacy-path test asserting that a non-escrow completion issues an `UPDATE agents SET jobs_total = jobs_total + 1` for `assigned_provider_user_id` (in addition to the crew bump), and a guard test that a provider who is also in the crew is bumped only once.
- **Why:** Locks the fix with a direct test per change-safety rule #1/#5.
- **Risk:** If no ops.service.spec exists, create one or fold into an existing completeBooking spec; mock db.q to capture the new statement.

### Step-by-step prompts for Claude

_Hand these to Claude one at a time, in order._

> **Step 1:** In `apps/auth-service/src/ops/ops.service.ts`, locate `completeBooking` (~:1081). In the FOR UPDATE row SELECT at ~:1107 change `SELECT status, total_eur, conversation_id, region_code FROM lite_bookings WHERE id = $1 FOR UPDATE` to also select `assigned_provider_user_id`, and add `assigned_provider_user_id: string | null` to the inline row type at ~:1104-1106. Do not change any control flow.

> **Step 2:** In the same file, in the legacy stats-bump block (~:1340-1354, the `if (cpos.length > 0 && payouts.length > 0)` branch that runs `UPDATE agents SET jobs_total = jobs_total + 1, duty_hours_mtd = ... WHERE user_id = ANY($1)`), add AFTER that statement a new guarded block: `if (row.assigned_provider_user_id && !paidIds.includes(row.assigned_provider_user_id)) { try { await this.db.q(`UPDATE agents SET jobs_total = jobs_total + 1 WHERE user_id = $1`, [row.assigned_provider_user_id]); } catch (e) { this.log.warn(`Agency jobs_total bump failed for ${row.assigned_provider_user_id}: ${(e as Error).message}`); } }`. This bumps the agency exactly once per legacy completion, never double-counting a self-provider CPO. Keep it a separate statement so the existing crew-bump test still matches.

> **Step 3:** Create migration `supabase/migrations/20260625000000_backfill_jobs_total.sql` with the idempotent backfill: `UPDATE agents a SET jobs_total = (SELECT COUNT(*) FROM lite_bookings b WHERE b.assigned_provider_user_id = a.user_id AND b.status = 'COMPLETED') + (SELECT COUNT(DISTINCT mc.mission_id) FROM mission_crew mc JOIN missions m ON m.id = mc.mission_id AND m.status = 'COMPLETED' JOIN lite_bookings b2 ON b2.id = m.booking_id WHERE mc.agent_id = a.user_id AND b2.assigned_provider_user_id IS DISTINCT FROM a.user_id);`. Before finalizing, confirm the exact column names/types (`mission_crew.agent_id`, `mission_crew.mission_id`, `missions.booking_id`, `lite_bookings.assigned_provider_user_id`, `agents.user_id`) against the live schema via `mcp__supabase list_tables` / a read-only `execute_sql` SELECT on a couple of known agencies.

> **Step 4:** Add/extend `apps/auth-service/src/ops/ops.service.spec.ts`: mock the db so completeBooking takes the legacy (no escrow_holds row) branch, then assert (a) the crew bump `UPDATE agents SET jobs_total = jobs_total + 1, duty_hours_mtd ...` fires for the crew ids, and (b) a separate `UPDATE agents SET jobs_total = jobs_total + 1 WHERE user_id = $1` fires for `assigned_provider_user_id`. Add a second test where `assigned_provider_user_id` equals a crew id and assert the agency bump does NOT fire (single count).

> **Step 5:** Run `cd apps/auth-service && npm test` — confirm the new tests pass and that `settlement.service.spec.ts` (escrow agency bump, :36) and `org-mission.service.spec.ts` (listMissions COMPLETED, :132-141) still pass.

> **Step 6:** Apply the backfill on staging via Supabase, then verify: `SELECT user_id, type, jobs_total FROM agents WHERE type='company'` and cross-check a sample agency's value against `OrgMissionService.listMissions` recent/COMPLETED count. Then re-open the mobile agency dashboard and confirm the Rating card sub now reads the real `N jobs` (not 0).

> **Step 7:** Run `npm run typecheck` (mobile, must stay <= baseline) and `cd apps/ops-console && npm run typecheck`. No mobile/ops-console code change is required — the fix is server-side + data — but confirm baselines are untouched.

### ⚠️ Regressions this could introduce (guard against these)

- Double-count of jobs_total when an individual CPO is also their own booking's provider — guarded by `!paidIds.includes(assigned_provider_user_id)` in code and `IS DISTINCT FROM` in the backfill. Verify with the second unit test.
- Backfill SET overwrites the column, so if any prior increment was already correct the SET is a no-op; but if the backfill's definition diverges from the going-forward increments the column will drift again. Keep both definitions identical (provider-per-completed-booking + crew-per-completed-mission).
- The new agency bump runs OUTSIDE the completion transaction (like the existing crew bump) and is wrapped in try/catch, so a bump failure must NOT roll back or block the booking completion — preserve that behavior.
- Adding a second UPDATE statement could break a brittle spec that asserts the exact number/shape of db.q calls in completeBooking — run the full auth-service suite and adjust expectations rather than weakening the new statement.
- AGENCY_NO_SHOW / aborted / disputed bookings must NOT be counted as completed jobs — both the increment (gated on the COMPLETED path) and the backfill (status='COMPLETED' only) exclude them; double-check no other terminal status leaks in.
- Secondary (note, not in scope): the escrow/auto-dispatch path bumps only the agency, never the individual crew CPOs, so a CPO's own dashboard under an auto-dispatch agency will read 0. The backfill's crew leg corrects history; flag the going-forward crew gap as a follow-up.

### Tests / verification

- cd apps/auth-service && npm test (new ops.service completeBooking legacy-bump test + regression: settlement.service.spec.ts, org-mission.service.spec.ts)
- npm run typecheck (mobile, <= baseline) and cd apps/ops-console && npm run typecheck
- Manual smoke: admin completeBooking on a non-escrow mission → reopen mobile Agent dashboard → Rating card sub shows N jobs (incremented), and EarningsScreen 'JOBS COMPLETED' matches
- Manual data check on staging: run the backfill migration, then SELECT agents.jobs_total for a known agency and compare to OrgMissionService.listMissions COMPLETED count for the same org_user_id

### Open questions / decisions needed

- Should the rating card ultimately read a COMPUTED count (from missions/bookings) instead of the denormalized agents.jobs_total to permanently eliminate drift? Denormalized is cheaper and is read in 4 places; the proposed fix keeps it denormalized + correct. Decide if the team wants the read switched to a computed aggregate instead.
- Going forward, the auto-dispatch escrow path (settlement.service.ts:117) bumps only the agency, not the crew CPOs — should individual CPOs also get a per-mission bump on the escrow path? Out of scope for #10(2nd) but it is the same class of bug for the CPO dashboard.
- Confirm exact live-schema column names/types for the backfill (mission_crew.agent_id vs cpo_user_id, missions.booking_id, lite_bookings.assigned_provider_user_id) before applying — verify via Supabase MCP read-only query.

---

## 10. mission-history — CPO completed-mission history (call-log) in the roster + Service-Provider all-completed-missions list with count and step-flow

**Covers your requests:**

- #3: when a CPO completes a mission there should be a history of which missions he completed (like a call log of who called me). Show it in the CPO roster.
- #3: the service provider account should show all missions completed — count + the 6-7 step flow per mission.

### Root cause

Not a bug — this is a missing-feature/gap. The CPO-self history endpoint and the shared waypoint/step-flow infrastructure already exist; what is absent is (1) any org-scoped per-roster-member mission-history endpoint and roster surfacing, and (2) a Service-Provider completed-mission count + completed list and a drill-in to the per-mission step flow for finished work.

### Current behavior (as built)

There are TWO distinct surfaces here and the gap is on the ORG/manager side, not the CPO-self side.

(1) CPO SELF history ALREADY EXISTS and works. `GET /agents/me/missions` → `AgentService.getMyMissionHistory(userId)` returns the logged-in agent's terminal missions newest-first with the agent's own payout. apps/auth-service/src/agents/agent.service.ts:957-972 quotes the exact query: `FROM mission_crew mc JOIN missions m ON m.id = mc.mission_id JOIN lite_bookings b ON b.id = m.booking_id LEFT JOIN mission_payouts mp ON mp.mission_id = m.id AND mp.agent_user_id = mc.agent_id WHERE mc.agent_id = $1 AND m.status IN ('COMPLETED','ABORTED') ORDER BY m.ended_at DESC NULLS LAST, m.started_at DESC LIMIT $2`. It is SELF-SCOPED to `user.sub` only (agent.controller.ts:229-232 `getMyMissions(@CurrentUser() user) { return this.agents.getMyMissionHistory(user.sub); }`). Mobile client: api.ts:778-786 `getMissionHistory()`; consumed by EarningsScreen.tsx:66, AgentHomeScreen.tsx:50, src/screens/pro/ProActivityHistoryScreen.tsx:69, src/screens/pro/TripHistoryScreen.tsx:118.

(2) The terminal mission states are exactly COMPLETED and ABORTED. mission-state-machine.service.ts:14-20 declares `export type MissionStatus = ... | 'COMPLETED' | 'ABORTED'` (DISPATCHED→PICKUP→LIVE→COMPLETED). There is NO separate RELEASED status on the missions table (RELEASED lives on escrow_holds). So a 'completed mission' = `missions.status='COMPLETED'`.

(3) The '6-7 step flow' = the mission waypoint timeline. ops/mission-defaults.ts:11-21 `DEFAULT_MISSION_WAYPOINTS` has exactly 7 rows: DISPATCH, RECON, PICKUP, CHKPT 01, EN ROUTE, CHKPT 02, DROPOFF. These are seeded per-mission into `mission_waypoints` (org-mission.service.ts:280-286) and are already surfaced (with state/settled_at) via `getMissionLive` (org-mission.service.ts:135-139, 159-163). The client also has a 6-label MissionStepper: src/screens/booking/missionJourney.ts:35-42 STEP_LABELS, rendered by src/components/mission/MissionStepper.tsx (already used inline on the OrgMissions JobCard, OrgMissionsScreen.tsx:88-90).

(4) ORG/manager side — THE GAP. `GET /org/missions` → `OrgMissionService.listMissions(orgUserId)` (org-mission.service.ts:53-85) returns the org's bookings grouped needs_crew/active/recent. The `recent` bucket (org-mission.service.ts:82) is a catch-all for anything not needs-crew/not-active, so COMPLETED+AGENCY_NO_SHOW land there mixed together. There is NO completed COUNT anywhere and no completed-only list. The SQL filter `b.status IN ('CONFIRMED','LIVE','COMPLETED','AGENCY_NO_SHOW')` (org-mission.service.ts:71) deliberately omits CANCELLED/ABORTED bookings. The `recent` JobCards are NOT tappable into any detail (OrgMissionsScreen.tsx:226 renders them with neither onAssign nor onMonitor), so the manager cannot drill into the step flow of a finished mission.

(5) CPO ROSTER — THE GAP. OrgRosterScreen.tsx shows the roster (orgApi.listCpos, OrgRosterScreen.tsx:121) and the whole row press only toggles suspend/reinstate (OrgRosterScreen.tsx:268-269 onPress={() => toggleSuspend(m)}). RosterMember (org-cpo.service.ts:24-33 / api.ts:837-846) carries NO mission-history or completed-count field. There is NO org-scoped per-member mission endpoint at all — a grep for `org/cpos/.../missions` / `getMemberMissionHistory` returns nothing. `OrgCpoService.listRoster` (org-cpo.service.ts:228-239) selects only roster columns; `getCapacity` (org-cpo.service.ts:247-279) counts active/busy but not completed.

Net: the CPO can see his own history; the AGENCY manager cannot see a roster member's completed missions, and the SP account has no completed-count or completed-list view, and no drill-in to the per-mission step flow for finished work.

### Key files

| File                                                      | Role                                                                                                                                                                                      |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/auth-service/src/agents/agent.service.ts`         | Reusable query shape: getMyMissionHistory (931-990, self-scoped terminal-mission list + payout) and getPayoutSummary (719-775). Copy/adapt the JOIN for the org-scoped variant.           |
| `apps/auth-service/src/agents/agent.controller.ts`      | Existing self route GET /agents/me/missions (229-232) — the pattern the new org route mirrors.                                                                                           |
| `apps/auth-service/src/org/org-cpo.service.ts`          | Roster service. listRoster (228-239) needs a completed_count column; add new listMemberMissionHistory + an org-membership tenant gate (IDOR guard).                                       |
| `apps/auth-service/src/org/org-mission.service.ts`      | listMissions (53-85) — add completed_count and/or a completed-only list; getMissionLive (96-167) already returns the 7-step waypoints for drill-in.                                      |
| `apps/auth-service/src/org/org.controller.ts`           | Add GET /org/cpos/:memberUserId/missions (and optionally GET /org/missions/completed). All under JwtAuthGuard+OrgManagerGuard, scoped to manager.org_user_id (never a path-supplied org). |
| `apps/auth-service/src/org/dto/org.dto.ts`              | Add a MemberMissionsQueryDto if a limit query param is wanted; otherwise no DTO needed.                                                                                                   |
| `apps/auth-service/src/ops/mission-defaults.ts`         | DEFAULT_MISSION_WAYPOINTS (11-21) — the canonical 7-step timeline the per-mission flow renders.                                                                                          |
| `src/services/api.ts`                                   | orgApi (848-887), RosterMember (837-846), OrgMissionDto (909-927), agentApi.getMissionHistory (778-786). Add orgApi.listMemberMissions + completed_count typing.                          |
| `src/screens/agent/OrgRosterScreen.tsx`                 | CPO roster UI. Add per-row completed-mission count + navigate to a new per-CPO history screen; preserve suspend/reinstate (move it off the full-row tap).                                 |
| `src/screens/agent/OrgMissionsScreen.tsx`               | SP missions board. Add a completed-count chip/section; make recent/completed JobCards tappable into the step-flow detail (ties to SP-MISSION-DETAIL).                                     |
| `src/components/mission/MissionStepper.tsx`             | The shared 6-step bar to reuse in the per-CPO history rows and the SP detail (consumes journeyStep(booking, mission)).                                                                    |
| `src/navigation/types.ts`                               | AgentStackParamList (256-291). Register the new OrgCpoMissions route param {memberUserId, displayName?}.                                                                                  |
| `src/navigation/AgentNavigator.tsx`                     | Register the new OrgCpoMissions screen (headerShown:false) alongside OrgRoster/OrgMissions (180-202).                                                                                     |
| `apps/auth-service/src/org/org-mission.service.spec.ts` | Jest mock-db pattern (mk() at 10-47) to copy for the new service-method specs.                                                                                                            |

### Proposed changes (per file)

**1. `apps/auth-service/src/org/org-cpo.service.ts`**

- **Change:** Add async listMemberMissionHistory(orgUserId, memberUserId, limit=50). STEP 1 tenant gate: `const m = await this.db.qOne('SELECT 1 AS ok FROM org_members WHERE org_user_id=$1 AND member_user_id=$2', [orgUserId, memberUserId]); if (!m) throw new ForbiddenException('not_your_org_member');` — this is the IDOR close. STEP 2 run the org-scoped history query: copy agent.service.ts:957-972 but add `JOIN lite_bookings b` already present and a tenant predicate `AND b.assigned_provider_user_id = $1` so the manager only ever sees missions their org owned, plus `mc.agent_id = $2 AND m.status IN ('COMPLETED','ABORTED')`. Return short_code, status, role, is_lead, started_at, ended_at, route_distance_m, route_duration_s, pickup_address, dropoff_address, region_label, mission_id, booking_id, paid_credits, deduction_credits (Number()-coerce the credits like agent.service.ts:987-988). Clamp limit with Math.min(Math.max(1,limit),100).
- **Why:** Gives the agency manager a per-CPO completed-mission call-log. Reuses the proven getMyMissionHistory query shape but adds org tenancy so it is IDOR-safe by row, matching getMissionLive's org gate (org-mission.service.ts:113).
- **Risk:** Medium — payout columns (paid_credits) for a managed CPO are exposed to the manager. For managed CPOs the org IS the payee, so this is acceptable, but confirm with finance before exposing deduction_reason text. Mitigate by NOT selecting deduction_reason in v1.

**2. `apps/auth-service/src/org/org-cpo.service.ts`**

- **Change:** Extend listRoster (228-239) to add a completed-count per member: add `, COALESCE(mc_cnt.completed, 0)::int AS missions_completed` and a `LEFT JOIN (SELECT mc.agent_id, count(*) AS completed FROM mission_crew mc JOIN missions m ON m.id=mc.mission_id JOIN lite_bookings b ON b.id=m.booking_id WHERE b.assigned_provider_user_id=$1 AND m.status='COMPLETED' GROUP BY mc.agent_id) mc_cnt ON mc_cnt.agent_id = om.member_user_id`. Add `missions_completed: number` to the RosterMember interface (24-33).
- **Why:** Surfaces the per-CPO completed count directly on the roster list so the manager sees the call-log volume without an extra request; the org-scoped subquery keeps the count to this agency's missions only.
- **Risk:** Low — additive column; subquery is org-scoped. Watch perf on large rosters (index on missions.booking_id + lite_bookings.assigned_provider_user_id already exist per dispatch design). Guard with the existing roster-list spec.

**3. `apps/auth-service/src/org/org-mission.service.ts`**

- **Change:** Add async listCompletedMissions(orgUserId, limit=50) returning {completed_count: number; missions: Array<...>}. Query missions joined to lite_bookings where `b.assigned_provider_user_id=$1 AND m.status='COMPLETED'` ordered by m.ended_at DESC LIMIT, plus a `SELECT count(*)` for completed_count. Reuse the OrgMissionRow crew json_agg shape (57-66) so the client renders the same crew chips. Optionally also return AGENCY_NO_SHOW separately. Alternatively (smaller diff) just add `completed_count` to the existing listMissions return by appending a count(*) FILTER (WHERE m.status='COMPLETED') over the same rows.
- **Why:** Gives the SP account the all-completed list + count the requirement asks for, distinct from the conflated `recent` bucket.
- **Risk:** Low — read-only, org-scoped. If extending listMissions instead of a new method, the response shape changes; update the api.ts type + OrgMissionsScreen consumer together to avoid a tsc break.

**4. `apps/auth-service/src/org/org.controller.ts`**

- **Change:** Add `@Get('cpos/:memberUserId/missions') listMemberMissions(@Param('memberUserId') memberUserId, @CurrentOrgManager() manager) { return this.orgCpo.listMemberMissionHistory(manager.org_user_id, memberUserId); }`. Optionally add `@Get('missions/completed') listCompleted(@CurrentOrgManager() manager) { return this.orgMission.listCompletedMissions(manager.org_user_id); }`. Both inherit the class-level JwtAuthGuard+OrgManagerGuard (org.controller.ts:22).
- **Why:** Exposes the two new reads on the existing org surface; org is resolved server-side from the guard, never from a path param (org.controller.ts:14-19 contract).
- **Risk:** Low — but do NOT add a ParseUUIDPipe-less :id mutation; these are GETs only. Keep memberUserId scoped through the service tenant gate, not the controller.

**5. `src/services/api.ts`**

- **Change:** In orgApi (848-887) add `listMemberMissions: (memberUserId: string) => authHttp.get<Array<{mission_id:string; booking_id:string; short_code:string; status:string; role:string; is_lead:boolean; started_at:string|null; ended_at:string|null; route_distance_m:number|null; route_duration_s:number|null; pickup_address:string; dropoff_address:string|null; region_label:string|null; paid_credits:number|null}>>(`/org/cpos/${memberUserId}/missions`)` and (if added) `listCompletedMissions: () => authHttp.get<{completed_count:number; missions: OrgMissionDto[]}>('/org/missions/completed')`. Add `missions_completed: number` to RosterMember (837-846).
- **Why:** Wires the new endpoints into the typed client the screens consume.
- **Risk:** Low — additive. Adding missions_completed to RosterMember is a required field; ensure the backend always returns it (COALESCE 0) so existing RosterMember consumers don't get undefined.

**6. `src/screens/agent/OrgRosterScreen.tsx`**

- **Change:** On each populated member row (265-290): show the completed count (e.g. a small `{m.missions_completed} missions` meta under the call sign, OrgRosterScreen.tsx:281-283) and change the row tap to navigate to the new history screen: `onPress={() => navigation.navigate('OrgCpoMissions', {memberUserId: m.member_user_id, displayName: m.display_name})}`. Move suspend/reinstate off the full-row tap onto a trailing kebab/long-press so it is preserved (currently OrgRosterScreen.tsx:269). Keep the deployedCount=0 placeholder note (139) honest.
- **Why:** Satisfies 'show it in the CPO roster' — the manager taps a CPO to see his call-log of completed missions, and the count is visible at a glance.
- **Risk:** Medium — repurposing the row tap can break the existing suspend flow muscle-memory; guard by keeping an explicit suspend affordance and exercising both paths in a manual smoke.

**7. `src/screens/agent/OrgCpoMissionsScreen.tsx (NEW)`**

- **Change:** New screen (model on ProActivityHistoryScreen.tsx for layout). Reads route.params.memberUserId, calls orgApi.listMemberMissions, renders a call-log list: each row = route (pickup→dropoff), short_code, status pill (COMPLETED/ABORTED), role/lead, ended_at date, paid_credits. Header shows displayName + total count. Tapping a row opens the per-mission step flow — reuse MissionStepper with booking={status:'COMPLETED'} mission={{status}} OR navigate to the SP mission detail (SP-MISSION-DETAIL) passing mission_id to getMissionLive for the full 7-waypoint timeline.
- **Why:** The actual call-log UI. Reuses MissionStepper (the shared 6-step bar) and the existing dark theme tokens.
- **Risk:** Low/UI — verify empty state and that the list is org-scoped (it is, server-side).

**8. `src/screens/agent/OrgMissionsScreen.tsx`**

- **Change:** Add a completed-count chip in the header (near needChip, 189-191) fed by listCompletedMissions().completed_count, and render a COMPLETED section (or relabel RECENT, 223-228) whose JobCards are tappable into the step-flow detail. For the drill-in, pass mission_id to the existing AgentLiveTracker monitor (already wired for active, OrgMissionsScreen.tsx:219) or a dedicated SP detail using orgApi.getMissionLive (api.ts:868) which returns the 7 waypoints.
- **Why:** Satisfies 'the service provider account should show all missions completed — count + the 6-7 step flow per mission.'
- **Risk:** Medium — getMissionLive on a COMPLETED mission still returns waypoints (org-mission.service.ts:135) but its live-map mode expects current_lat/lng which may be stale; verify the monitor view degrades gracefully for terminal missions or build a read-only detail variant.

**9. `src/navigation/types.ts + src/navigation/AgentNavigator.tsx`**

- **Change:** types.ts: add `OrgCpoMissions: {memberUserId: string; displayName?: string | null};` to AgentStackParamList (after OrgCreateCpo, 280). AgentNavigator.tsx: register `<Stack.Screen name="OrgCpoMissions" component={OrgCpoMissionsScreen} options={{headerShown:false}} />` near OrgCreateCpo (188-192). Also add it to MainNavigator.tsx allow-list if such a list gates agent routes (mirror the OrgRoster registration).
- **Why:** Makes the new screen navigable from the roster.
- **Risk:** Low — missing registration yields a runtime navigation error; typecheck catches the param-list mismatch.

### Step-by-step prompts for Claude

_Hand these to Claude one at a time, in order._

> **Step 1:** In apps/auth-service/src/org/org-cpo.service.ts: (a) add `missions_completed: number;` to the RosterMember interface (currently lines 24-33). (b) In listRoster (228-239) add the column `COALESCE(mc_cnt.completed, 0)::int AS missions_completed` to the SELECT and a `LEFT JOIN (SELECT mc.agent_id, count(*) AS completed FROM mission_crew mc JOIN missions m ON m.id=mc.mission_id JOIN lite_bookings b ON b.id=m.booking_id WHERE b.assigned_provider_user_id=$1 AND m.status='COMPLETED' GROUP BY mc.agent_id) mc_cnt ON mc_cnt.agent_id = om.member_user_id` before the WHERE. Keep the $1=orgUserId binding. Return missions_completed in the row mapping.

> **Step 2:** In apps/auth-service/src/org/org-cpo.service.ts add a new method `async listMemberMissionHistory(orgUserId: string, memberUserId: string, limit = 50)`. First run a tenant gate: `const ok = await this.db.qOne<{ok:number}>('SELECT 1 AS ok FROM org_members WHERE org_user_id=$1 AND member_user_id=$2', [orgUserId, memberUserId]); if (!ok) throw new ForbiddenException('not_your_org_member');` (import ForbiddenException from @nestjs/common). Then copy the query from apps/auth-service/src/agents/agent.service.ts:957-972 and adapt: `WHERE mc.agent_id = $2 AND b.assigned_provider_user_id = $1 AND m.status IN ('COMPLETED','ABORTED') ORDER BY m.ended_at DESC NULLS LAST, m.started_at DESC LIMIT $3` with params [orgUserId, memberUserId, Math.min(Math.max(1,limit),100)]. Select short_code, status, role, is_lead, started_at, ended_at, route_distance_m, route_duration_s, b.pickup_address, b.dropoff_address, b.region_label, m.id AS mission_id, m.booking_id, mp.paid_credits, mp.deduction_credits. Number()-coerce paid_credits/deduction_credits as in agent.service.ts:987-988. Do NOT select deduction_reason (finance gate).

> **Step 3:** In apps/auth-service/src/org/org-mission.service.ts add `async listCompletedMissions(orgUserId: string, limit = 50): Promise<{completed_count: number; missions: OrgMissionRow[]}>`. Reuse the OrgMissionRow SELECT shape from listMissions (57-73) but `WHERE b.assigned_provider_user_id = $1 AND b.status = 'COMPLETED'` and `ORDER BY b.pickup_time DESC LIMIT $2`. Add a separate `const c = await this.db.qOne<{n:string}>('SELECT count(*)::text AS n FROM lite_bookings WHERE assigned_provider_user_id=$1 AND status=\'COMPLETED\'', [orgUserId]);` and return {completed_count: Number(c?.n ?? 0), missions: rows}.

> **Step 4:** In apps/auth-service/src/org/org.controller.ts add two GET routes under the existing class guards: `@Get('cpos/:memberUserId/missions') listMemberMissions(@Param('memberUserId') memberUserId: string, @CurrentOrgManager() manager: OrgManagerContext) { return this.orgCpo.listMemberMissionHistory(manager.org_user_id, memberUserId); }` and `@Get('missions/completed') listCompleted(@CurrentOrgManager() manager: OrgManagerContext) { return this.orgMission.listCompletedMissions(manager.org_user_id); }`. Place them next to the existing org/missions routes (35-50). No new imports beyond what is already present.

> **Step 5:** Add backend specs: in apps/auth-service/src/org/org-cpo.service.spec.ts (or a new file) add tests modeled on org-mission.service.spec.ts:10-47 mk() — (1) listMemberMissionHistory throws ForbiddenException when org_members gate returns null (IDOR), (2) returns rows when gate passes and asserts the SQL carries `b.assigned_provider_user_id = $1`, (3) listRoster returns missions_completed. Add an org-mission.service.spec test that listCompletedMissions filters status='COMPLETED' and returns completed_count.

> **Step 6:** Run the backend gate from apps/auth-service: `npm test` (full suite, ~1300+). Confirm the new specs pass and no regression in org-cpo/org-mission/agent specs.

> **Step 7:** In src/services/api.ts: add `missions_completed: number;` to the RosterMember interface (837-846). In the orgApi object (848-887) add `listMemberMissions: (memberUserId: string) => authHttp.get<Array<{mission_id:string; booking_id:string; short_code:string; status:string; role:string; is_lead:boolean; started_at:string|null; ended_at:string|null; route_distance_m:number|null; route_duration_s:number|null; pickup_address:string; dropoff_address:string|null; region_label:string|null; paid_credits:number|null; deduction_credits:number|null}>>(`/org/cpos/${memberUserId}/missions`)` and `listCompletedMissions: () => authHttp.get<{completed_count:number; missions: OrgMissionDto[]}>('/org/missions/completed')`.

> **Step 8:** In src/navigation/types.ts add `OrgCpoMissions: {memberUserId: string; displayName?: string | null};` to AgentStackParamList after OrgCreateCpo (line 280). If MainNavigator.tsx has an agent-route allow-list (mirror where OrgRoster/OrgMissions are listed), add 'OrgCpoMissions' there too.

> **Step 9:** Create src/screens/agent/OrgCpoMissionsScreen.tsx. Model the layout/theme on src/screens/pro/ProActivityHistoryScreen.tsx (header, stat strip, card list) but use the obsidian tokens from OrgRosterScreen.tsx (D = {...}). Read `const {memberUserId, displayName} = route.params;`, call `orgApi.listMemberMissions(memberUserId)` in a useCallback/useEffect, render newest-first cards: route (pickup→dropoff), short_code, a COMPLETED/ABORTED pill, role/★lead, ended_at date, and paid_credits. Header count = list length. Each card renders `<MissionStepper booking={{status:'COMPLETED'}} mission={{status: row.status}} />` (import from @components/mission/MissionStepper) for the step flow, and onPress can navigate into the SP mission detail (SP-MISSION-DETAIL) passing row.mission_id. Include loading + empty states.

> **Step 10:** Register the screen in src/navigation/AgentNavigator.tsx: import OrgCpoMissionsScreen and add `<Stack.Screen name="OrgCpoMissions" component={OrgCpoMissionsScreen} options={{headerShown:false}} />` next to OrgCreateCpo (188-192).

> **Step 11:** Update src/screens/agent/OrgRosterScreen.tsx: in the populated member row (265-290) (a) add a completed-count line in the meta (near 281-283): `{m.missions_completed} completed`; (b) change the row onPress (269) to `navigation.navigate('OrgCpoMissions', {memberUserId: m.member_user_id, displayName: m.display_name})`; (c) preserve suspend/reinstate by moving toggleSuspend onto a trailing icon button or onLongPress so it is still reachable. Keep RefreshControl and error/empty states.

> **Step 12:** Update src/screens/agent/OrgMissionsScreen.tsx: (a) fetch listCompletedMissions in load() (118-130) and store completed_count; (b) render a count chip in the header near needChip (189-191); (c) make the RECENT/COMPLETED JobCards (223-228) tappable into the step-flow detail by passing an onMonitor/onPress that navigates with mission_id (reuse AgentLiveTracker monitor as active does at 219, or a read-only SP detail). Verify getMissionLive degrades for terminal missions (no live coords).

> **Step 13:** Run mobile gates: `npm run typecheck` (must stay ≤ baseline 96 / per-memory 49) and `npm run lint`. Then boot the app and smoke: log in as a service-provider manager → CPO Roster shows per-CPO completed counts → tap a CPO → OrgCpoMissions shows the call-log with step flow → suspend/reinstate still works → Missions board shows the completed count and a completed mission drills into the 7-step flow. Test the empty path (a CPO with zero completed missions) and the error path (offline).

### ⚠️ Regressions this could introduce (guard against these)

- IDOR: the new GET /org/cpos/:memberUserId/missions must reject a memberUserId that is not in the caller's org. Guard = the org_members tenant gate (step 2) PLUS the `b.assigned_provider_user_id = $1` predicate in the history query, so even a member who later left only ever returns missions THIS org owned. Add the negative spec (ForbiddenException) so it can't regress.
- OrgRosterScreen row-tap repurposing can silently break suspend/reinstate (currently the whole row triggers it, OrgRosterScreen.tsx:269). Guard: keep an explicit suspend affordance (kebab/long-press) and manually exercise both navigate and suspend in the smoke.
- Adding required `missions_completed` to RosterMember (api.ts:837) will tsc-break any consumer if the backend ever omits it. Guard: COALESCE(...,0) server-side so it is always present; keep the field non-optional only after confirming listRoster returns it.
- getMissionLive on a terminal (COMPLETED) mission returns null/stale current_lat/lng; reusing the live-map monitor for finished missions could render a broken map. Guard: branch the SP detail to a read-only waypoint-timeline view for terminal status, or assert the tracker handles null coords.
- Payout exposure: surfacing paid_credits/deduction to the manager for a managed CPO is acceptable (org is payee) but exposing deduction_reason free-text may leak ops commentary. Guard: omit deduction_reason in v1 and get finance sign-off before adding it.
- Perf: the per-member completed-count subquery in listRoster runs once per roster load; on large rosters ensure it uses the existing indexes on missions.booking_id and lite_bookings.assigned_provider_user_id. Guard: keep the subquery GROUP BY org-scoped (already) and watch the org-cpo spec / EXPLAIN if rosters grow.

### Tests / verification

- apps/auth-service: `npm test` (full suite). New/updated specs: org-cpo.service.spec.ts (listMemberMissionHistory IDOR + happy path + missions_completed column), org-mission.service.spec.ts (listCompletedMissions filter + count).
- Mobile: `npm run typecheck` (must not exceed the tsc baseline) and `npm run lint`.
- Manual smoke (service-provider manager account on a device/emulator): CPO Roster shows per-CPO completed counts; tap a CPO opens OrgCpoMissions call-log with the 6/7-step MissionStepper; suspend/reinstate still works; Missions board shows the completed count chip; a COMPLETED mission drills into the step flow; empty-state for a CPO with zero completed; offline error path.
- Regression: re-run the agent self-history path (EarningsScreen / ProActivityHistoryScreen / TripHistoryScreen still load via GET /agents/me/missions) to confirm the shared query/type changes didn't break the self surface.

### Open questions / decisions needed

- Should the manager see the CPO's payout amounts (paid_credits/deduction) at all, or only mission metadata? For managed CPOs the org is the payee so amounts are reasonable, but confirm with finance — and decide on deduction_reason (recommended: omit in v1).
- For the SP 'all missions completed' view: is COMPLETED-only sufficient, or should ABORTED / AGENCY_NO_SHOW be shown as separate buckets/counts? The terminal mission states are only COMPLETED+ABORTED (mission-state-machine.service.ts:14-20); AGENCY_NO_SHOW is a booking status.
- Drill-in target for the per-mission step flow: reuse the existing AgentLiveTracker 'monitor' mode (built for ACTIVE missions, may show stale coords on terminal) or build a dedicated read-only SP-MISSION-DETAIL screen? This overlaps the SP-MISSION-DETAIL area — coordinate so the same detail screen serves both.
- Count semantics: does 'missions completed' mean missions where this CPO was crew (mission_crew) or specifically where they were the lead? The current proposal counts any crew membership on a COMPLETED mission — confirm with product.
- Should the per-CPO history and SP completed list paginate (limit currently 50/100) or is a single page acceptable for the expected volume (≤10 CPOs per agency per the roster cap)?

---

## 11. SP-MISSION-DETAIL — Service Provider: tap a mission to open a full Mission Detail page

**Covers your requests:**

- #2nd: in the service provider, missions show steps + little details; tapping a mission should open another page showing all important information (you design which info + the layout).

### Current behavior (as built)

The SP missions board is `src/screens/agent/OrgMissionsScreen.tsx`. It loads `orgApi.listMissions()` (`src/services/api.ts:861`) which hits `GET /org/missions` and returns three groups `{needs_crew, active, recent}` of `OrgMissionDto` (`src/services/api.ts:909-927`). Each group is rendered as a `JobCard` (`OrgMissionsScreen.tsx:63-101`).\n\nTapping behavior today is INCONSISTENT and there is NO detail page:\n- needs_crew cards: `onPress={onAssign}` opens the assign-crew Modal sheet (`OrgMissionsScreen.tsx:211`, `openSheet` at :141, sheet at :235-279). No detail view.\n- active cards: card body is NOT tappable — `<TouchableOpacity activeOpacity={onAssign ? 0.85 : 1} onPress={onAssign} disabled={!onAssign}>` (`:66`) is disabled when no `onAssign`; only the inner `monitorBtn` navigates to `AgentLiveTracker` in monitor mode (`:218-219`, `:92-98`).\n- recent cards: `<JobCard key={...} job={j} />` with no `onAssign`/`onMonitor` — completely inert (`:226`).\n\nSo the card already shows 'steps + little details' (service, region+pickup time `:73-74`, crew count + lead `:77-79`, the shared 6-step `MissionStepper` at `:88-89`), but there is nowhere to drill in for the full picture. That is exactly the gap #2nd describes.\n\nThe `OrgMissionDto` the list already holds (org-scoped, IDOR-safe per the service comment `org-mission.service.ts:51-52`) contains: `booking_id`, `booking_status`, `service`, `region_label`, `pickup_time`, `pickup_address`, `pickup_lat/lng`, `dropoff_address`, `dropoff_lat/lng`, `cpo_count`, `armed_required`, `mission_id`, `mission_status`, `short_code`, and `crew[]` ({user_id, call_sign, role, is_lead}) — see `api.ts:909-927` and the SQL at `org-mission.service.ts:56-74`. This is enough for a v1 detail page WITHOUT a new endpoint.\n\nRicher fields (waypoint timeline with `settled_at`, client display_name, comms `conversation_id`, live coords) are NOT in the list DTO but ARE already produced — `OrgMissionService.getMissionLive(orgUserId, missionId)` (`org-mission.service.ts:96-167`) returns `waypoints[]` (seq/tag/event/state/settled_at), `booking.client_name` (from `users.display_name`, `:128-131`), `comms_channel_id`, and the route/coords — all org-scoped via `WHERE m.id=$1 AND b.assigned_provider_user_id=$2` (`:113`). It throws `ForbiddenException('not_your_org_mission')` on a foreign/absent mission (`:117-119`). BUT it requires a `mission_id`, which needs_crew jobs do not have yet.\n\nNavigation: the SP screens live in `AgentNavigator` (`src/navigation/AgentNavigator.tsx`) under `AgentStackParamList` (`src/navigation/types.ts:256-327`). `OrgMissions` is registered at `AgentNavigator.tsx:171-175`; reached from `AgentDashboardScreen.tsx:467` and `:731`. The monitor live map is `AgentLiveTracker: {missionId, mode?: 'agent'|'cpo'|'monitor'}` (`types.ts:267`), navigated at `OrgMissionsScreen.tsx:219` with `mode:'monitor'`. There is NO `OrgMissionDetail` route. (Note: a `BookingStackParamList` route `OpsMissionDetail:{missionId}` exists at `types.ts:201` but that is the HQ ops-console-style flow in the booking/pro stack, not the SP agent stack — do not reuse it.)\n\nThe stepper labels (the '6-7 step flow') come from `src/screens/booking/missionJourney.ts:35-42` (STEP_LABELS: Searching / Accepted·assigning team / Team dispatched / En route to pickup / Protection active / Completed) via the pure `journeyStep(booking, mission)` (`missionJourney.ts:48-75`), rendered by `src/components/mission/MissionStepper.tsx:29-56`.\n\nEscrow/payout is NOT currently exposed on any `/org/*` route — grep of `apps/auth-service/src/org` for escrow/payout returns nothing. Escrow lives in `wallet`/`booking`/`settlement` modules. So 'escrow/payout state' on the detail page requires either a new org-scoped query or is deferred (open question below).

### Key files

| File                                                      | Role                                                                                                            |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/screens/agent/OrgMissionsScreen.tsx`               | SP missions board — JobCard + assign sheet; the tap-source that must navigate into the new detail page         |
| `src/services/api.ts`                                   | orgApi.listMissions/getMissionLive/assignCrew + OrgMissionDto type (lines 848-927) — add getMissionDetail here |
| `src/navigation/types.ts`                               | AgentStackParamList (256-327) — add the OrgMissionDetail route param                                           |
| `src/navigation/AgentNavigator.tsx`                     | register the new OrgMissionDetail screen                                                                        |
| `src/components/mission/MissionStepper.tsx`             | reusable 6-step progress bar to render full-size on the detail page                                             |
| `src/screens/booking/missionJourney.ts`                 | STEP_LABELS + journeyStep — source of truth for the status timeline labels                                     |
| `apps/auth-service/src/org/org.controller.ts`           | add GET /org/bookings/:bookingId/detail handler (org-scoped, mirror getMissionLive guarding)                    |
| `apps/auth-service/src/org/org-mission.service.ts`      | add getMissionDetail(orgUserId, bookingId) — org-scoped query reusing the list+live SQL shapes                 |
| `apps/auth-service/src/org/org-mission.service.spec.ts` | unit test pattern to copy for the new service method                                                            |

### Proposed changes (per file)

**1. `src/navigation/types.ts`**

- **Change:** In AgentStackParamList (around the OrgMissions entry at line 278) add: `OrgMissionDetail: {bookingId: string; missionId?: string | null};`. Pass bookingId (always present) + optional missionId so the detail screen can call getMissionLive only when a mission exists.
- **Why:** Typed route so the screen + navigate() calls type-check. bookingId is the stable key for all three groups; missionId is only present once crewed.
- **Risk:** Low — additive param type.

**2. `src/services/api.ts`**

- **Change:** Add `orgApi.getMissionDetail: (bookingId: string) => authHttp.get<OrgMissionDetailDto>(`/org/bookings/${bookingId}/detail`)` next to getMissionLive (after line 869), and export an `OrgMissionDetailDto` interface = OrgMissionDto fields + `client_name: string|null`, `conversation_id: string|null`, `duration_hours: number|null`, `waypoints: Array<{seq:number; tag:string; event:string; state:string; settled_at:string|null}>`, and an optional `escrow: {state:string; amount:{eur:string}}|null`.
- **Why:** Gives the detail screen fresh, richer data (timeline, client name, comms room) than the cached list DTO, while staying one round-trip.
- **Risk:** Low — new endpoint; no change to existing calls.

**3. `apps/auth-service/src/org/org-mission.service.ts`**

- **Change:** Add `async getMissionDetail(orgUserId: string, bookingId: string)`. ONE org-scoped query on lite_bookings `WHERE b.id=$1 AND b.assigned_provider_user_id=$2` (mirror the IDOR gate of getMissionLive at line 113) LEFT JOIN missions m, LEFT JOIN users u for display_name, plus the crew json_agg (copy lines 61-69) and a LEFT-JOIN-LATERAL of mission_waypoints ORDER BY seq. Return null→throw `ForbiddenException('not_your_org_mission')` exactly like line 117-119. Do NOT select client phone/email. Include conversation_id from lite_bookings. Leave escrow out of v1 (return escrow:null) unless finance signs off the amount source.
- **Why:** Reuses the existing, audited org-scoping pattern; works for needs_crew (no mission) AND active/recent. Single source keeps the screen honest.
- **Risk:** Medium — new SQL; must replicate the exact tenant WHERE clause or it becomes an IDOR. Guard with a spec test that a foreign org gets ForbiddenException.

**4. `apps/auth-service/src/org/org.controller.ts`**

- **Change:** Add `@Get('bookings/:bookingId/detail')` handler `getMissionDetail(@Param('bookingId', ParseUUIDPipe) bookingId, @CurrentOrgManager() manager)` → `this.orgMission.getMissionDetail(manager.org_user_id, bookingId)`. Mounted under the existing `@UseGuards(JwtAuthGuard, OrgManagerGuard)` (line 21-22) so org scoping + ParseUUIDPipe (reject non-UUID) come for free.
- **Why:** Same controller, same guards as listMissions/getMissionLive — no new trust surface.
- **Risk:** Low — additive route; guards already enforce manager-only + org resolution server-side.

**5. `src/screens/agent/OrgMissionDetailScreen.tsx`**

- **Change:** NEW screen. Read route.params {bookingId, missionId}. Paint instantly from any passed-through summary (optional) then fetch orgApi.getMissionDetail(bookingId). Layout (obsidian theme cloned from OrgMissionsScreen styles): (1) Header with short_code or short booking ref + back chevron; (2) full-width MissionStepper(booking={status:booking_status}, mission); (3) Schedule card (pickup_time via fmtTime, duration_hours); (4) Route card (pickup_address, dropoff_address, ARMED pill); (5) Crew card (lead ★ first, then CPOs with call_sign + role badge); (6) Client card — display_name ONLY + 'Coordinate via Ops Room' CTA (no raw phone); (7) Status timeline from waypoints (settled_at timestamps, pending vs done); (8) primary CTA row: if mission active → 'Live monitor' → navigation.navigate('AgentLiveTracker',{missionId, mode:'monitor'}); if needs_crew → 'Assign crew' (see sheet decision); always → 'Open Ops Room' when conversation_id present. Handle loading/error/Forbidden states.
- **Why:** Satisfies #2nd — a real detail page with all important info, designed layout, reusing existing tokens + MissionStepper + monitor entry.
- **Risk:** Medium — native UI not unit-verifiable; needs device smoke. Privacy: must NOT render client phone/email.

**6. `src/screens/agent/OrgMissionsScreen.tsx`**

- **Change:** Make every card open the detail page. (a) Active cards (line 217-220): add `onOpen={() => navigation.navigate('OrgMissionDetail',{bookingId:j.booking_id, missionId:j.mission_id})}` and wire the card's outer TouchableOpacity to it. (b) Recent cards (line 226): same onOpen. (c) needs_crew: keep the assign sheet as the PRIMARY tap (line 211) BUT add a secondary 'Details' affordance, OR (recommended) make the card tap open detail and move the existing assign sheet to be triggered from the detail screen — see step_by_step for the lower-risk extract. Update JobCard signature to accept an `onOpen` and make the outer TouchableOpacity call onOpen when no onAssign.
- **Why:** Active & recent cards are currently dead on tap — pure additive fix. needs_crew gets a detail view without losing the one-tap assign.
- **Risk:** Medium — touching the JobCard press logic could regress the assign-sheet trigger; guard by keeping onAssign precedence and adding a render test.

### Step-by-step prompts for Claude

_Hand these to Claude one at a time, in order._

> **Step 1:** In `src/navigation/types.ts`, find the `AgentStackParamList` block and the line `OrgMissions: undefined;` (line 278). Immediately after it add: `OrgMissionDetail: {bookingId: string; missionId?: string | null};`. Save. This is the typed route for the new screen.

> **Step 2:** In `apps/auth-service/src/org/org-mission.service.ts`, add a new public method `getMissionDetail(orgUserId: string, bookingId: string)` AFTER `getMissionLive` (after line 167). Implement it as a single org-scoped read: `SELECT b.id AS booking_id, b.status AS booking_status, b.service, b.region_label, b.pickup_time, b.pickup_address, b.pickup_lat, b.pickup_lng, b.dropoff_address, b.dropoff_lat, b.dropoff_lng, b.cpo_count, b.armed_required, b.duration_hours, b.conversation_id, u.display_name AS client_name, m.id AS mission_id, m.status AS mission_status, m.short_code, COALESCE(json_agg(...crew...) FILTER (WHERE mc.agent_id IS NOT NULL),'[]') AS crew FROM lite_bookings b LEFT JOIN missions m ON m.booking_id=b.id LEFT JOIN mission_crew mc ON mc.mission_id=m.id LEFT JOIN public.users u ON u.id=b.client_id WHERE b.id=$1 AND b.assigned_provider_user_id=$2 GROUP BY b.id, m.id, u.display_name` (copy the crew json_build_object exactly from lines 62-65; copy the IDOR WHERE clause shape from line 113). Then separately fetch waypoints: `SELECT seq, tag, event, state, settled_at FROM mission_waypoints WHERE mission_id=$1 ORDER BY seq` (only if mission_id present). If the booking row is null, `throw new ForbiddenException('not_your_org_mission')` exactly like lines 117-119. Return `{...row, pickup_time as ISO, waypoints: waypoints.map(w=>({...w, settled_at: w.settled_at?.toISOString() ?? null})), escrow: null}`. Do NOT select client phone/email. Verify `b.duration_hours` column exists; if not, drop it and return duration_hours:null.

> **Step 3:** In `apps/auth-service/src/org/org.controller.ts`, after the `getMissionLive` handler (line 50) add: `@Get('bookings/:bookingId/detail') getMissionDetail(@Param('bookingId', ParseUUIDPipe) bookingId: string, @CurrentOrgManager() manager: OrgManagerContext) { return this.orgMission.getMissionDetail(manager.org_user_id, bookingId); }`. The class already has `@UseGuards(JwtAuthGuard, OrgManagerGuard)` (line 22) so org scoping is automatic.

> **Step 4:** In `apps/auth-service/src/org/org-mission.service.spec.ts`, add a `describe('OrgMissionService.getMissionDetail')` with two tests using the existing `mk` harness pattern (lines 10-47): (a) returns the detail when the booking belongs to ORG; (b) throws ForbiddenException('not_your_org_mission') when the org-scoped query returns null. Run `cd apps/auth-service && npm test -- org-mission`.

> **Step 5:** In `src/services/api.ts`, after the `getMissionLive` entry (line 869) add `getMissionDetail: (bookingId: string) => authHttp.get<OrgMissionDetailDto>(`/org/bookings/${bookingId}/detail`),`. Then, after the `OrgMissionDto` interface (line 927), export `export interface OrgMissionDetailDto extends OrgMissionDto { client_name: string | null; conversation_id: string | null; duration_hours: number | null; waypoints: Array<{seq: number; tag: string; event: string; state: string; settled_at: string | null}>; escrow: {state: string; amount: {eur: string}} | null; }`.

> **Step 6:** Create `src/screens/agent/OrgMissionDetailScreen.tsx`. Clone the `D` design tokens, `fmtTime`, and `initials` helpers and the StyleSheet idiom from `OrgMissionsScreen.tsx` (lines 42-61, 284-335) so the look matches. Read `route.params` ({bookingId, missionId}) via `useRoute<RouteProp<AgentStackParamList,'OrgMissionDetail'>>()`. On mount call `orgApi.getMissionDetail(bookingId)` into state with loading/error handling (catch Forbidden → 'This mission is no longer yours' empty state). Render, top to bottom: a header (back chevron like OrgMissionsScreen lines 183-192 + short_code/booking ref + status chip); a full-width `<MissionStepper booking={{status: d.booking_status}} mission={d.mission_status ? {status: d.mission_status} : undefined} />`; a Schedule card (fmtTime(d.pickup_time) + duration_hours+'h'); a Route card (pickup_address, dropoff_address, ARMED pill from d.armed_required); a Crew card (d.crew sorted is_lead first, ★ on lead, call_sign + role); a Client card showing ONLY d.client_name (never phone/email) with an 'Open Ops Room' button when d.conversation_id; a Status-timeline list from d.waypoints (label each via its event/tag, show settled_at ? fmtTime : 'pending'); and a bottom CTA: when d.mission_status in DISPATCHED/PICKUP/LIVE/SOS show 'Live monitor' → `navigation.navigate('AgentLiveTracker',{missionId: d.mission_id!, mode:'monitor'})`.

> **Step 7:** In `src/navigation/AgentNavigator.tsx`, import the new screen near the other org imports (after line 27): `import OrgMissionDetailScreen from '@screens/agent/OrgMissionDetailScreen';`. Then register it after the `OrgMissions` Stack.Screen (after line 175): `<Stack.Screen name="OrgMissionDetail" component={OrgMissionDetailScreen} options={{headerShown: false}} />`.

> **Step 8:** In `src/screens/agent/OrgMissionsScreen.tsx`, wire taps into the detail page. Extend `JobCard` props with `onOpen?: () => void` and change the outer `TouchableOpacity` (line 66) so it calls `onAssign ?? onOpen` (assign keeps precedence for needs_crew) and is enabled when EITHER handler exists. In the render: active cards (line 217-220) add `onOpen={() => navigation.navigate('OrgMissionDetail',{bookingId:j.booking_id, missionId:j.mission_id})}`; recent cards (line 226) add the same `onOpen`. For needs_crew, ALSO add a small 'Details' text/icon affordance inside the card that calls the same onOpen (so the one-tap assign sheet is preserved AND a detail path exists). Run `npm run typecheck` and confirm it does not exceed the baseline (49 per memory / 96 per CLAUDE.md — use the repo's `.tsc-baseline.json`).

> **Step 9:** Smoke on a device as a service-provider/company manager account: open the Missions board, tap an ACTIVE card → detail opens with stepper, crew, route, timeline; tap 'Live monitor' → AgentLiveTracker monitor map; tap a RECENT card → detail (read-only, no monitor CTA); tap a NEEDS-CREW card → assign sheet still opens (regression check) and the 'Details' affordance opens detail. Confirm client phone/email are NOT shown anywhere. Try a stale/foreign bookingId → graceful 'no longer yours' state (no crash).

### ⚠️ Regressions this could introduce (guard against these)

- IDOR on the new endpoint: if the `WHERE b.assigned_provider_user_id = $2` clause is omitted or the param order swapped, any manager could read any booking's detail (incl. client name + pickup/dropoff). Guard: copy the exact gate from getMissionLive (`org-mission.service.ts:113`) and add the spec test that a foreign org gets ForbiddenException.
- Privacy leak: the detail page must show client display_name only. If a dev adds phone/email to the SELECT or the DTO, principal PII leaks to every roster manager. Guard: do not select phone/email in the SQL; review the DTO; route contact through the Ops Room CTA.
- Regression on the needs_crew assign sheet: editing JobCard's onPress precedence could make tapping a needs-crew card open detail instead of the assign sheet (a workflow regression for the primary action). Guard: keep `onAssign ?? onOpen` precedence and add a render/interaction test asserting needs_crew tap still calls openSheet.
- Non-serializable nav params warning: pass only `{bookingId, missionId}` (strings) — do NOT pass the whole OrgMissionDto object as a param, which React Navigation warns about and breaks deep-link/state-persistence. The screen re-fetches via getMissionDetail.
- Stale data / race: a needs_crew job may already be crewed by another manager by the time detail opens (mission_id now set). Guard: the screen fetches fresh detail on mount and renders whatever state comes back; the stepper + CTA derive from the live booking/mission status.
- duration_hours / column assumptions: if `lite_bookings.duration_hours` does not exist the new SQL throws 500. Guard: verify the column via `\d lite_bookings` (or list_tables) before shipping; fall back to returning null.

### Tests / verification

- cd apps/auth-service && npm test -- org-mission (new getMissionDetail unit tests: happy path + ForbiddenException for foreign org)
- cd apps/auth-service && npm run build (NestJS controller/service compiles)
- npm run typecheck (mobile — must not exceed .tsc-baseline.json baseline)
- cd apps/ops-console && npm run typecheck (only if api.ts types are shared; otherwise skip)
- Manual device smoke: SP/company-manager account → Missions board → tap active/recent/needs-crew cards → detail page renders, Live monitor + Ops Room CTAs work, assign sheet unregressed, no client PII, foreign/stale bookingId handled gracefully

### Open questions / decisions needed

- Escrow/payout state on the detail page: #2nd's intent includes 'escrow/payout state' per the area brief, but NO /org/* route exposes escrow today (grep of apps/auth-service/src/org finds none; it lives in wallet/booking/settlement). Should v1 omit it (return escrow:null) and add it in a finance-signed-off follow-up, or query escrow_holds/mission_payouts now? Money figures need finance sign-off (FX/fee placeholders per memory).
- needs_crew interaction: should tapping a needs-crew card open the DETAIL page (with an Assign CTA inside it) or keep opening the assign sheet directly? Recommended: keep the one-tap assign as primary + add a 'Details' affordance, to avoid a larger refactor of the assign Modal — confirm the desired UX.
- Client identity privacy tier: is display_name acceptable to show pre-LIVE, or should the principal be masked (e.g. initials only) until the mission is LIVE, consistent with the coarse-pre-accept rule in the auto-dispatch design? Coordinate with CLIENT-TRACKING/privacy owner.
- Coordination with MISSION-HISTORY and CLIENT-TRACKING: the 'recent' group overlaps a mission-history surface, and the Live monitor entry overlaps client-tracking — confirm the detail page is the single drill-in and history/tracking link INTO it rather than duplicating layouts.

---

## 12. CPO-WAYPOINTS — CPO multiple waypoints — fill/progress as the CPO advances on the mission

**Covers your requests:**

- #12: a CPO has multiple waypoints — how to make them fill (mark progress) as they are on the mission.

### Root cause

For the managed CPO (auto-dispatch flow), the Mission tab `AssignedMissionDetailScreen` shows waypoints read-only and exposes no marking/telemetry, while the FSM controls it does expose (`missionPickup/GoLive/Complete` → agent.service.ts:1193-1221 `flipMissionStatus`) update only `missions.status` and never settle `mission_waypoints`. Marking + GPS auto-marking live exclusively in the legacy `MissionLeadConsoleScreen`, reachable only via a buried slide handle on the live-tracker map (AgentLiveTrackerScreen.tsx:745-753, 843-860). Net: the waypoints do not fill as the CPO advances unless they detour into the legacy console; the status and the waypoint timeline diverge.

### Current behavior (as built)

The waypoint-progress system is ALREADY built end-to-end on the backend and in the LEGACY agent UI; the gap is that the NEW auto-dispatch CPO flow's primary screen renders waypoints read-only and never drives them.\n\nSCHEMA — `mission_waypoints` (supabase/migrations/20260424000000_ops_admin.sql:104-115): `seq, tag, event, sub, planned_at, settled_at, state TEXT DEFAULT 'pending'` with `UNIQUE(mission_id, seq)`. State enum constrained to `pending|current|done|sos` (supabase/migrations/20260509100000_phase2_data_integrity.sql:128-133: \"CHECK (state IN ('pending','current','done','sos'))\"). `marked_by UUID` + `marked_via TEXT` added by supabase/migrations/20260428100000_mission_lead_telemetry.sql:25-27 (\"-- 'lead', 'auto_distance', 'ops'\"), alongside `mission_telemetry` (lines 29-44).\n\nSEED — 7 default waypoints inserted at dispatch from the single source of truth mission-defaults.ts:11-21: seq1 DISPATCH, 2 RECON, 3 PICKUP, 4 CHKPT 01, 5 EN ROUTE, 6 CHKPT 02, 7 DROPOFF. Seeded identically in three dispatch paths: apps/auth-service/src/org/org-mission.service.ts:280-285 (agency crew-assign), apps/auth-service/src/ops/job-feed.service.ts:298-303, apps/auth-service/src/ops/ops.service.ts:884-889.\n\nBACKEND MARKING — apps/auth-service/src/agents/mission-lead.service.ts: `markWaypoint` (lines 40-111) is LEAD-ONLY (requireLead lines 29-37) and only accepts DISPATCH/RECON/PICKUP/DROPOFF (LEAD_MARKABLE line 27); it sets `state='done', settled_at=NOW(), marked_via='lead'` (lines 50-57). PICKUP auto-fires EN ROUTE (seq5, lines 64-73) and flips `missions.status DISPATCHED→PICKUP` (lines 81-85). `pushTelemetry` (lines 118-222) is LEAD-ONLY, writes mission_telemetry + missions.current_lat/lng, flips `PICKUP→LIVE` on first push (lines 186-190), and AUTO-FIRES CHKPT 01 (seq4) at progress≥50% and CHKPT 02 (seq6) at ≥80% where progress = `1 - distance_to_dropoff / route_distance_m` (lines 154-219, marked_via='auto_distance'). Ops-side manual override: apps/auth-service/src/ops/mission.service.ts:646-653 `advanceWaypoint(missionId, seq, 'current'|'done')`.\n\nENDPOINTS — apps/auth-service/src/agents/agent.controller.ts:345-365: `POST /agents/me/missions/:missionId/waypoints/mark` (body {tag}) and `POST /agents/me/missions/:missionId/telemetry`. Mobile client methods exist: src/services/api.ts:809-826 `agentApi.markWaypoint(missionId, tag)` and `agentApi.pushTelemetry(missionId, sample)`.\n\nREAD — `getMissionDeployment` (apps/auth-service/src/agents/agent.service.ts:1035-1085) returns `waypoints[]` of `{seq, tag, event, state, settled_at, marked_via}`, crew-gated (IDOR guard lines 1069-1071). Client type at src/services/api.ts:576-579.\n\nMOBILE UI — TWO surfaces:\n(1) LEGACY agent flow: src/screens/agent/MissionLeadConsoleScreen.tsx FULLY implements 'fill as you advance' — tap-to-mark buttons for the 4 manual waypoints (lines 210-224, 312-357), a real GPS watcher pushing every ~10s that drives auto-marks (lines 119-206), a progress bar with checkpoint ticks (lines 298-309), and a 7-step timeline (lines 360-383). Registered in src/navigation/AgentNavigator.tsx:122-123 and embedded as a slide-in overlay inside the live tracker (src/screens/agent/AgentLiveTrackerScreen.tsx:843-860).\n(2) NEW auto-dispatch CPO flow (the one a managed CPO actually uses): src/navigation/CpoNavigator.tsx:85-86 mounts `AssignedMissionDetailScreen` as the 'Mission' tab. There the WAYPOINTS section is READ-ONLY (src/screens/cpo/AssignedMissionDetailScreen.tsx:181-193): it maps `dep.waypoints` to rows showing a check-circle when `w.state === 'done'` but has NO mark control and NO GPS push. The only progression on this screen is the FSM control Start/Go-live/Finish (lines 77-104) calling `agentApi.missionPickup/missionGoLive/missionComplete`, plus an 'Open live map · Navigate' CTA → CpoLiveTracker (lines 195-201).\n\nKEY DEFECT FOR #12: the FSM controls only flip `missions.status` and DO NOT settle waypoints — agent.service.ts:1193-1207 `missionPickup/missionGoLive/missionComplete` each just call `flipMissionStatus` (lines 1209-1221) which touches only `missions`. So a CPO who taps Start→Go-live→Finish on the Mission tab advances the mission to COMPLETED while DISPATCH/RECON/PICKUP/EN ROUTE/DROPOFF waypoints all stay 'pending' (only CHKPT 01/02 can auto-fire, and only if the live tracker overlay is open pushing GPS). To actually fill waypoints today a managed CPO must: open live map → tap the buried right-edge slide handle (AgentLiveTrackerScreen.tsx:745-753) → mark in the embedded MissionLeadConsoleScreen. The waypoints therefore do not 'fill as you advance' from the screen the CPO lives on.

### Key files

| File                                                              | Role                                                                                                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/screens/cpo/AssignedMissionDetailScreen.tsx`               | PRIMARY CPO Mission tab (new auto-dispatch flow); renders waypoints READ-ONLY (lines 181-193), owns FSM Start/Go-live/Finish (77-104). The screen to make waypoint-aware. |
| `src/screens/agent/MissionLeadConsoleScreen.tsx`                | Legacy lead console — already implements mark buttons + GPS auto-push + progress bar; reference implementation / source of reusable logic.                               |
| `apps/auth-service/src/agents/mission-lead.service.ts`          | Backend markWaypoint (manual) + pushTelemetry (GPS auto-marks CHKPT 01/02, EN ROUTE, status flips).                                                                       |
| `apps/auth-service/src/agents/agent.service.ts`                 | getMissionDeployment read (1035-1085) + missionPickup/GoLive/Complete FSM flips (1193-1221) that currently DO NOT settle waypoints.                                       |
| `apps/auth-service/src/ops/mission-defaults.ts`                 | DEFAULT_MISSION_WAYPOINTS — single source of truth for the 7-step timeline + seq numbering.                                                                              |
| `apps/auth-service/src/agents/agent.controller.ts`              | Endpoints: waypoints/mark + telemetry (345-365), pickup/go-live/complete (277-314).                                                                                       |
| `src/services/api.ts`                                           | agentApi.markWaypoint / pushTelemetry / getMissionDeployment client methods + MissionDeployment type (560-585, 809-826).                                                  |
| `supabase/migrations/20260424000000_ops_admin.sql`              | mission_waypoints table definition (104-115).                                                                                                                             |
| `supabase/migrations/20260428100000_mission_lead_telemetry.sql` | marked_by/marked_via cols + mission_telemetry table.                                                                                                                      |
| `src/services/onDutyHeartbeat.ts`                               | Existing duty-gated location heartbeat — candidate host for background GPS telemetry so auto-marks fire without the live tracker open (per MEMORY Step5).                |
| `src/navigation/CpoNavigator.tsx`                               | CPO shell; mounts AssignedMissionDetailScreen (CpoMission) + CpoLiveTracker. Add MissionLeadConsole route here if routing to it.                                          |

### Proposed changes (per file)

**1. `apps/auth-service/src/agents/agent.service.ts`**

- **Change:** In missionPickup/missionGoLive/missionComplete (1193-1207), after a SUCCESSFUL flipMissionStatus, settle the waypoints that the FSM transition implies, idempotently and only-forward (UPDATE ... SET state='done', settled_at=COALESCE(settled_at,NOW()), marked_via='lead' WHERE mission_id=$1 AND seq=ANY($seqs) AND state<>'done'): Start(→PICKUP) settles DISPATCH(1),RECON(2),PICKUP(3),EN ROUTE(5); Go-live(→LIVE) leaves CHKPT auto-marks to GPS; Finish(→COMPLETED) settles DROPOFF(7) and any still-pending seqs. Reuse the exact pattern already in mission-lead.service.ts:64-73. Keeps timeline never lagging the status the CPO drives from the Mission tab.
- **Why:** Makes the FSM buttons the CPO already taps the thing that fills the waypoints — closes the status/waypoint divergence and satisfies #12 even with no GPS.
- **Risk:** Medium — touches mission FSM write path. Must be only-forward + idempotent so a re-tap / lost-200 retry is safe; must NOT change which transitions are allowed.

**2. `src/screens/cpo/AssignedMissionDetailScreen.tsx`**

- **Change:** For the LEAD only, make the WAYPOINTS section actionable: render an inline 'Mark `<tag>`' button for the next un-done manual waypoint (DISPATCH/RECON/PICKUP/DROPOFF) calling agentApi.markWaypoint(missionId, tag) then load(); show a small N/7 done progress count + 'AUTO' tag for marked_via auto. Reuse the busy/idempotent + Alert(extractMsg) pattern from MissionLeadConsoleScreen.tsx:210-224. Gate behind isLead (non-leads keep read-only, matching crew-gated server).
- **Why:** Surfaces 'fill as you advance' on the screen the CPO actually lives on instead of behind the buried slide handle.
- **Risk:** Low-Medium — UI only; must guard non-lead (server already 403s via requireLead) and avoid double-fire while busy.

**3. `src/services/onDutyHeartbeat.ts`**

- **Change:** When the on-duty CPO is the LEAD of an active (PICKUP/LIVE) mission, also POST agentApi.pushTelemetry(missionId, sample) on the existing heartbeat cadence (reuse the coords already gathered), so CHKPT 01/02 auto-marks + the live-map position fire even when the Mission tab / live tracker is not open. Keep it best-effort (swallow transient errors but surface sustained failure like MissionLeadConsoleScreen.tsx:175-184).
- **Why:** Today auto-marks + ops/client live position only update while the live-tracker overlay is foregrounded; binding telemetry to duty makes progress continuous.
- **Risk:** Medium — battery/permission + duplicate-push concerns. Throttle (~10s) and only when lead+active; do not push for non-leads or terminal missions.

**4. `src/screens/cpo/AssignedMissionDetailScreen.tsx`**

- **Change:** Add a secondary CTA next to 'Open live map' — 'Mark waypoints / Lead console' — that navigates the lead to the full MissionLeadConsole experience (either the embedded overlay via CpoLiveTracker, or a newly-registered CpoNavigator route). Optional if the inline buttons above are adopted; provides the GPS progress bar view.
- **Why:** Gives the lead one discoverable tap to the full progress UI rather than hunting the slide handle.
- **Risk:** Low — navigation only; if registering a new route, update CpoNavigator.tsx + types.ts (CpoRootStackParamList).

**5. `apps/auth-service/src/ops/mission-defaults.ts`**

- **Change:** No change to the timeline, but treat this file + the TAG_TO_SEQ map in mission-lead.service.ts:23-26 as a paired contract: if any new seq settlement logic is added (server step above), reference these constants so seq numbers never drift.
- **Why:** Prevent seq hardcode drift between dispatch seed, manual marks, and the new FSM settlement.
- **Risk:** Low.

### Step-by-step prompts for Claude

_Hand these to Claude one at a time, in order._

> **Step 1:** In apps/auth-service/src/agents/agent.service.ts, locate missionPickup/missionGoLive/missionComplete (lines ~1193-1207) and the private flipMissionStatus (~1209). Add a private helper `settleWaypointSeqs(missionId: string, seqs: number[], userId: string)` that runs: `UPDATE mission_waypoints SET state='done', settled_at=COALESCE(settled_at,NOW()), marked_by=$3, marked_via='lead' WHERE mission_id=$1 AND seq = ANY($2::int[]) AND state <> 'done'` (only-forward, idempotent). Mirror the conditional-UPDATE style already used in apps/auth-service/src/agents/mission-lead.service.ts:64-73.

> **Step 2:** In the SAME file, after flipMissionStatus succeeds inside missionPickup call `await this.settleWaypointSeqs(missionId, [1,2,3,5], userId)` (DISPATCH,RECON,PICKUP,EN ROUTE); inside missionComplete call `await this.settleWaypointSeqs(missionId, [1,2,3,4,5,6,7], userId)` so DROPOFF + any stragglers close. Do NOT settle CHKPT 01/02 in missionGoLive — leave those to GPS auto-marks. Keep settlement non-fatal (wrap in try/catch + this.log.warn) so a waypoint write failure never blocks the status flip.

> **Step 3:** Add/extend a unit test in apps/auth-service/src/agents (e.g. mission-lead.service.spec.ts sibling or a new agent.service.spec.ts): assert that calling missionPickup issues an UPDATE mission_waypoints with seq ANY [1,2,3,5] and that missionComplete settles 7; assert idempotency (state<>'done' guard present). Run `cd apps/auth-service && npm test`.

> **Step 4:** In src/screens/cpo/AssignedMissionDetailScreen.tsx, add lead-only waypoint marking. Near the existing WAYPOINTS block (lines 181-193): compute `isLead` (already in state, line 37/64), the ordered manual tags ['DISPATCH','RECON','PICKUP','DROPOFF'], and the next un-done manual waypoint from `wp`. When isLead && that tag exists, render a 'Mark `<label>`' TouchableOpacity that calls a new `markWp(tag)` which does `await agentApi.markWaypoint(missionId, tag); await load();` guarded by a `marking` busy flag and `Alert.alert('Mark failed', (e as Error).message)` on error. Reuse the icon/state styling already in the file (s.wpRow etc).

> **Step 5:** In the SAME screen, add a small progress affordance to the WAYPOINTS header: `WAYPOINTS · {done}/{wp.length}` where done = wp.filter(w=>w.state==='done').length, and append a muted '· AUTO' suffix when `w.marked_via?.startsWith('auto')` on each row (mirror MissionLeadConsoleScreen.tsx:362-363,371-373). Non-leads keep the rows read-only.

> **Step 6:** In src/services/onDutyHeartbeat.ts, when the on-duty user is the lead of an active mission (status PICKUP/LIVE — derive from the active-mission/getActiveMission data the heartbeat already has, or add a lightweight read), call `agentApi.pushTelemetry(missionId, {lat,lng,heading_deg,speed_kph,accuracy_m})` reusing the coords the heartbeat already collects. Throttle to ~10s, swallow transient errors, and skip when not lead / terminal. Confirm the heartbeat is duty-gated so it stops when off duty.

> **Step 7:** Manual smoke (device, lead CPO on an auto-dispatched mission): open the Mission tab, confirm waypoints show 0/7; tap Start → confirm DISPATCH/RECON/PICKUP/EN ROUTE flip to done (check-circle) and status badge → PICKUP; tap Go-live → status LIVE; with telemetry pushing, confirm CHKPT 01/02 auto-fill as you approach dropoff; tap Finish → DROPOFF + all remaining fill, status COMPLETED. Verify a non-lead crew member sees the same timeline read-only with no Mark button.

> **Step 8:** Cross-area check (coordinate with MONITOR-MAP + CLIENT-TRACKING): confirm the monitor view (AgentLiveTrackerScreen mode='monitor') and the client tracking screen both read waypoint state from the same server rows and reflect the new fills on their ~4s poll. No change should be needed because waypoints are server state, but verify the client/monitor read includes `state`/`settled_at`.

> **Step 9:** Run gates: `cd apps/auth-service && npm test` (full auth suite), mobile `npm run typecheck` (must stay ≤ baseline 96 / per-MEMORY 49) and `npm run lint`. Then re-run the device smoke from step 7.

### ⚠️ Regressions this could introduce (guard against these)

- FSM/waypoint double-write race: marking PICKUP via markWaypoint already flips DISPATCHED→PICKUP (mission-lead.service.ts:81-85) AND now missionPickup settles the PICKUP waypoint — both paths can run. Guard: both use only-forward conditional UPDATEs (state<>'done', status='DISPATCHED'), so concurrent/duplicate calls converge; add no unconditional overwrite.
- Settling waypoints inside the FSM flip could fail and (if not isolated) roll back the status transition. Guard: wrap settlement in try/catch + log.warn so it is best-effort and never blocks the canonical status change; keep it AFTER the status UPDATE.
- Non-lead marking: a non-lead tapping a Mark button would hit a 403 (requireLead). Guard: render the button only when isLead===true (server stays authoritative).
- Background telemetry from onDutyHeartbeat could double-push with MissionLeadConsoleScreen's own ~10s watcher when both are active, or drain battery. Guard: throttle, only-when-lead+active, and treat pushTelemetry as idempotent (it appends telemetry + only-forward auto-marks, so duplicates are harmless but wasteful).
- Completing via Finish now settles ALL seqs incl. CHKPT 01/02 that GPS may legitimately never have reached — could misrepresent that checkpoints were physically hit. Guard: decide product intent; if checkpoints must reflect real GPS, exclude 4/6 from the Finish settlement set and only close DISPATCH/RECON/PICKUP/EN ROUTE/DROPOFF.
- Monitor mode opening the embedded MissionLeadConsole overlay (AgentLiveTrackerScreen.tsx:843-860, slide handle ungated by mode) would show Mark buttons to a non-crew manager whose marks 403. Pre-existing; if touching the tracker, gate the slide handle/overlay marking off in mode==='monitor'.

### Tests / verification

- cd apps/auth-service && npm test (full auth-service suite — covers mission-lead.service.spec.ts, org-mission.service.spec.ts, job-feed.service.spec.ts that already assert waypoint seeding/marking)
- New/updated agent.service spec asserting missionPickup/missionComplete settle the correct seqs idempotently (only-forward)
- Mobile: npm run typecheck (stay within baseline) + npm run lint
- Mobile manual smoke on device: lead CPO advances a mission via the Mission tab (Start→Go-live→Finish) and watches waypoints fill; non-lead sees read-only timeline
- Cross-surface smoke: ops monitor map + client tracking reflect the same waypoint fills on poll (coordinate with MONITOR-MAP + CLIENT-TRACKING areas)
- npm test -- --selectProjects=booking is NOT required (no booking-FSM change) but run if the telemetry/duty hook touches booking state

### Open questions / decisions needed

- Product intent: should Finish auto-settle CHKPT 01/02 even if GPS never crossed the 50%/80% thresholds, or should checkpoints only ever reflect real GPS progress? This decides the seq set in missionComplete settlement.
- Should the managed CPO's primary path be inline marking on AssignedMissionDetailScreen, or a one-tap route into the full MissionLeadConsole (progress bar + GPS view)? Both are viable; inline is the smaller diff.
- Is onDutyHeartbeat the right host for continuous telemetry, or should a dedicated lead-active foreground service own it (battery/permission policy)? Confirm against the Step5 duty-heartbeat design.
- Multi-team (team_idx) missions: TAG_TO_SEQ + the seed assume a single 7-step timeline per mission; if car A / car B ever get distinct waypoint sets, the seq-based settlement needs revisiting (mission_crew.team_idx exists but waypoints are mission-scoped, not team-scoped).
- Do the MONITOR-MAP and CLIENT-TRACKING reads already include waypoint state/settled_at, or only mission status + position? Needs confirmation in those areas so progress actually propagates to the client/monitor.

---

## 13. client-tracking — Client mission status + live-tracking parity and realtime propagation

**Covers your requests:**

- #13: the status + live-tracking-of-the-mission view that the service provider has is not present for the client — it should be there too.
- #13: the statuses are not changing — fix; and updates should be instant/realtime so no reload is needed.

### Root cause

In the auto-dispatch flow the lead-CPO transitions are driven exclusively by `MissionLeadService` (apps/auth-service/src/agents/mission-lead.service.ts), which updates `missions.status` and `missions.current_lat/lng` with raw SQL but (a) never injects/calls `MissionEventsService`, so no `mission.status` WS frame is published to the `mission:<bookingId>` room the client is subscribed to, and (b) never mirrors the lead's GPS fix into `mission_telemetry_last` / the Redis `telemetry:{bookingId}` stream / `mission.telemetry`, so the client's `GET /telemetry/:bookingId/latest` returns null and the live map falls back to a simulated dot. The realtime transport, gateway room, Redis bridge, and client subscription are all correctly wired (proven by the OPS path in mission.service.ts using the exact same MissionEventsService) — the single missing link is propagation from the auto-dispatch lead path. A secondary UI bug (LiveTrackingScreen header keyed off `isLive` = LIVE-only) makes DISPATCHED/PICKUP render as 'Awaiting Dispatch', amplifying the 'status not changing' perception.

### Current behavior (as built)

The client DOES already have a status + live-tracking surface: `src/screens/liveops/LiveTrackingScreen.tsx` (registered in `src/navigation/BookingNavigator.tsx:203-205` as route `LiveTracking`). It renders a Mapbox WebView, the shared 6-step `MissionStepper`, a Route/Team/Chat panel, ETA, and an EMERGENCY CTA. The client reaches it automatically: `src/screens/booking/AgencyAcceptedScreen.tsx:44-63` polls `GET /bookings/:id` every 5s and `navigation.replace('LiveTracking', {bookingId})` the moment `mission_status` (or status LIVE/COMPLETED) appears; `BookingConfirmationScreen.tsx:174` also navigates there on "Track".\n\nStatus source: `src/store/bookingStore.ts:122-132` `loadActiveBooking` → `bookingApi.getById` → `GET /bookings/:id`. The server surfaces the mission lifecycle as `mission_status` only on `getById` (`apps/auth-service/src/booking/booking.service.ts:522-537`: `booking.mission_status = mission?.status ?? null`). The shared progress logic is `src/screens/booking/missionJourney.ts:48-75` (`journeyStep`), driven by booking.status + mission.status; the booking FSM stays CONFIRMED while the mission advances DISPATCHED→PICKUP→LIVE→COMPLETED, so the client view must read `mission_status`.\n\nRealtime wiring that IS connected: `LiveTrackingScreen.tsx:308-323` uses `useMissionEvents(transport, bookingId, {...})` (`src/modules/messenger/runtime/useMissionEvents.ts`). That hook calls `transport.subscribeMission(bookingId)` (`packages/messenger-core/src/transport/client.ts:248` → emits `mission.subscribe`), the gateway joins the socket to room `mission:<bookingId>` (`apps/messenger-service/src/gateway/messenger.gateway.ts:768`), and re-emits any auth-service `mission:events` Redis frame to that room (`messenger.gateway.ts:419-438`, emitting `frame.event` with `{missionId, ...data}`). The auth-service publisher is `apps/auth-service/src/ops/mission-events.service.ts` (`statusChanged`/`teamChanged`/`telemetryFix` → `broadcastBoth` fans out to BOTH `mission:<missionId>` and `mission:<bookingId>`).\n\nROOT-CAUSE GAP — the auto-dispatch lead path emits NOTHING. `apps/auth-service/src/agents/mission-lead.service.ts` is the single source of truth for status + position in the auto-dispatch flow (lead CPO marks waypoints / pushes GPS via `POST /agents/me/missions/:id/telemetry` from `src/screens/agent/MissionLeadConsoleScreen.tsx:157` → `agentApi.pushTelemetry`). It flips `missions.status` DISPATCHED→PICKUP via raw SQL (`mission-lead.service.ts:81-85`) and PICKUP→LIVE (`mission-lead.service.ts:186-190`), and writes `missions.current_lat/lng` (`:170-179`), but its constructor only injects `DatabaseService` (`:20`) — it never calls `MissionEventsService`. So NO `mission.status` WS frame is emitted on auto-dispatch transitions: the client only learns of status changes on the next REST poll, not in realtime. By contrast the OPS path `apps/auth-service/src/ops/mission.service.ts:363/376/401/520` DOES call `this.events?.statusChanged(...)`.\n\nSECOND GAP — live position never reaches the client on the auto-dispatch path. `mission-lead.service.ts:161-179` writes `mission_telemetry` + `missions.current_*` ONLY. The client's map polls `GET /telemetry/:bookingId/latest` (`LiveTrackingScreen.tsx:106-150` `useLiveTelemetry` → `telemetryApi.latest`), which reads `mission_telemetry_last` (booking-keyed) / Redis stream `telemetry:{bookingId}` (`apps/auth-service/src/telemetry/telemetry.service.ts:113-145`). Nobody mirrors the lead's fix into `mission_telemetry_last` on the auto path (the `POST /telemetry/:bookingId/ping` writer is gated to `booking_cpo_assignments` and the lead app doesn't call it; the OPS path at `mission.service.ts:330-343` is the only `mission_telemetry_last` + `mission.telemetry` emitter). Result: `live.hasLive` stays false and the client falls back to the SIMULATED interpolated dot (`LiveTrackingScreen.tsx:76-91,385-390`), so the client never sees the SP's real CPO position.\n\nHEADER BUG — `LiveTrackingScreen.tsx:380` sets `isLive = missionStatus === 'LIVE' || bookingStatus === 'LIVE'`; the header (`:473-480`) shows 'AWAITING DISPATCH'/'Confirmed' whenever `!isLive`, so during DISPATCHED and PICKUP the big banner still reads 'Awaiting Dispatch' even though the mission is dispatched/en route — reinforcing the 'status not changing' perception (the stepper advances but the headline contradicts it).\n\nDEAD HOOK — `src/hooks/useBookingRealtime.ts` (Supabase `postgres_changes` on `bookings`) is defined but imported nowhere (grep: only self-reference). It is NOT the wired path; `realtimeService.subscribeToTable` (`src/services/supabase.ts:54-67`) is unused for bookings. The canonical realtime path is the messenger WS (`useMissionEvents`).\n\nClient-side WS telemetry handler is a no-op: `LiveTrackingScreen.tsx:311-322` `onTelemetry` deliberately does nothing but `void fix` because `useLiveTelemetry` owns the poll state — so even if a `mission.telemetry` frame arrived, the map would not update until the next poll tick.

### Key files

| File                                                        | Role                                                                                                                                                                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/auth-service/src/agents/mission-lead.service.ts`    | ROOT CAUSE: auto-dispatch lead path flips missions.status + writes current_lat/lng but emits no MissionEvents and never mirrors the fix into mission_telemetry_last/Redis. Inject MissionEventsService + TelemetryService here. |
| `apps/auth-service/src/ops/mission-events.service.ts`     | The Redis pub/sub publisher (statusChanged/teamChanged/telemetryFix → broadcastBoth fans out to mission:`<missionId>` and mission:`<bookingId>`). Reference for the calls to add.                                          |
| `apps/auth-service/src/ops/mission.service.ts`            | Reference implementation of the correct pattern (emits statusChanged on PICKUP/LIVE/COMPLETED/ABORTED + writes mission_telemetry_last + emits telemetryFix).                                                                    |
| `apps/auth-service/src/telemetry/telemetry.service.ts`    | ping() writes mission_telemetry_last + Redis telemetry:{bookingId} stream; latest() is what the client reads. Reuse ping() to mirror the lead fix.                                                                              |
| `apps/auth-service/src/agents/agent.module.ts`            | DI wiring: must gain access to MissionEventsService + TelemetryService without importing OpsModule (OpsModule already imports AgentModule → cycle).                                                                            |
| `apps/auth-service/src/ops/ops.module.ts`                 | Currently provides+exports MissionEventsService; imports AgentModule (the cycle constraint).                                                                                                                                    |
| `apps/auth-service/src/booking/booking.service.ts`        | getById surfaces mission_status to the client (the status field the client view reads).                                                                                                                                         |
| `src/screens/liveops/LiveTrackingScreen.tsx`              | The client status + live-tracking view. Polls booking + telemetry, subscribes via useMissionEvents. Fix header label + wire onTelemetry to force an immediate refetch.                                                          |
| `src/modules/messenger/runtime/useMissionEvents.ts`       | The wired WS realtime hook (mission.status/team/telemetry). onStatus already triggers loadActiveBooking.                                                                                                                        |
| `src/screens/booking/AgencyAcceptedScreen.tsx`            | Auto-advances client into LiveTracking when mission_status appears (entry path).                                                                                                                                                |
| `src/screens/booking/missionJourney.ts`                   | Shared journeyStep mapping booking/mission status → 6-step bar; reuse for the header label fix.                                                                                                                                |
| `src/screens/agent/AgentLiveTrackerScreen.tsx`            | The SP/agency/CPO rich tracker (polls crew-gated getMissionDeployment). Reference for parity; should NOT be reused verbatim for the client (crew-gated + over-exposes call signs/turn-by-turn).                                 |
| `src/hooks/useBookingRealtime.ts`                         | DEAD CODE: Supabase postgres_changes hook, imported nowhere. Not the wired path; candidate for deletion or documentation.                                                                                                       |
| `apps/messenger-service/src/gateway/messenger.gateway.ts` | mission.subscribe handler (joins mission:`<id>` room) + mission:events Redis subscriber re-emit. Already correct — no change needed.                                                                                         |

### Proposed changes (per file)

**1. `apps/auth-service/src/agents/mission-lead.service.ts`**

- **Change:** Inject `MissionEventsService` and `TelemetryService` into the constructor (alongside DatabaseService). In markWaypoint(): change the DISPATCHED→PICKUP UPDATE (lines 81-85) to `... RETURNING id` and, only when a row is returned, also fetch booking_id (add it to the same SELECT or a small lookup) and call `void this.events.statusChanged(missionId, 'PICKUP', bookingId)`. In pushTelemetry(): (1) extend the route SELECT (lines 132-144) to also return `m.booking_id`; (2) change the PICKUP→LIVE UPDATE (lines 186-190) to `... RETURNING id` and call `void this.events.statusChanged(missionId, 'LIVE', bookingId)` ONLY when a row was returned (a real transition), so LIVE isn't re-emitted on every fix; (3) after writing missions.current_* mirror the fix for the client by calling `await this.telemetry.ping(bookingId, {lat, lng, heading_deg, speed_kph, source: 'agent'})` (populates mission_telemetry_last + Redis stream the client reads) and `void this.events.telemetryFix(missionId, {lat, lng, recordedAt: new Date().toISOString()}, bookingId)` for the WS push.
- **Why:** Closes the single propagation gap: makes auto-dispatch status transitions realtime on the client (and agency) and makes the real CPO position reach the client's live map exactly as the OPS path already does (mission.service.ts:330-401).
- **Risk:** Re-emitting LIVE on every telemetry push if the RETURNING-gate is omitted (WS spam + stepper churn). Mitigate by emitting only when the conditional UPDATE actually returns a row. telemetry.ping adds a small write per fix — acceptable (lead pushes ~every 10s).

**2. `apps/auth-service/src/agents/agent.module.ts`**

- **Change:** Give AgentModule access to MissionEventsService + TelemetryService WITHOUT importing OpsModule (would cycle: OpsModule already imports AgentModule). Preferred: extract MissionEventsService into a new standalone `MissionEventsModule` (providers+exports MissionEventsService; relies on the @Global RedisModule) and import it in BOTH ops.module.ts and agent.module.ts. Also add `TelemetryModule` to AgentModule imports (TelemetryModule imports only AuthModule → no cycle, exports TelemetryService). Simpler fallback if extraction is undesired: add `MissionEventsService` directly to AgentModule's providers (it is a stateless Redis publisher and RedisService is @Global, so a second instance is harmless) and import TelemetryModule.
- **Why:** Enables DI of the two services into MissionLeadService while respecting the existing OpsModule→AgentModule dependency direction.
- **Risk:** Accidental circular import if someone imports OpsModule instead of the extracted module. The extracted-module approach mirrors the existing DispatchRoomIntentsModule precedent and is cycle-safe.

**3. `src/screens/liveops/LiveTrackingScreen.tsx`**

- **Change:** (1) Header parity: replace the LIVE-only `isLive` headline (lines 473-480) with a label derived from `journeyStep({status: bookingStatus}, missionStatus ? {status: missionStatus} : undefined)` so DISPATCHED→'Team dispatched', PICKUP→'En route to pickup', LIVE→'Protection active', plus the terminal/SOS side-states. Keep the existing dispatch banner only for steps 1-2. (2) Realtime telemetry: add a `telemetrySeq` state and bump it in the `onTelemetry` handler (lines 311-322); pass `telemetrySeq` into `useLiveTelemetry` as an extra dependency (add it to the effect deps at line 141) so a `mission.telemetry` WS frame forces an immediate poll instead of waiting for the timer. onStatus already calls loadActiveBooking — keep it.
- **Why:** Makes the headline track the real mission state (kills the 'status not changing' look) and makes the live dot move on WS push with no reload.
- **Risk:** journeyStep import is pure/no-IO (safe). Forcing a poll on every telemetry frame could raise request rate; the lead emits ~every 10s so it is bounded — optionally throttle to >=2s.

**4. `src/hooks/useBookingRealtime.ts`**

- **Change:** Delete this file (dead Supabase postgres_changes hook, imported nowhere) OR add a header comment marking it deprecated in favour of useMissionEvents. Do NOT wire it as the realtime path — the messenger WS path is canonical and avoids exposing a second Supabase realtime dependency.
- **Why:** Removes a misleading second 'realtime' path that a junior dev might wire by mistake.
- **Risk:** None (unused). If kept, ensure it is not imported anywhere later.

### Step-by-step prompts for Claude

_Hand these to Claude one at a time, in order._

> **Step 1:** In apps/auth-service/src/agents/mission-lead.service.ts: import MissionEventsService from '../ops/mission-events.service' and TelemetryService from '../telemetry/telemetry.service', and add both as constructor params after `private readonly db: DatabaseService` (e.g. `private readonly events: MissionEventsService, private readonly telemetry: TelemetryService`).

> **Step 2:** In the same file, markWaypoint(): change the DISPATCHED→PICKUP UPDATE (currently lines 81-85) to return the row and the booking id, e.g. `UPDATE missions SET status='PICKUP', updated_at=NOW() WHERE id=$1 AND status='DISPATCHED' RETURNING id, booking_id`. Capture the result; if a row came back, call `void this.events.statusChanged(missionId, 'PICKUP', row.booking_id)`.

> **Step 3:** In the same file, pushTelemetry(): add `m.booking_id AS booking_id` to the route SELECT (lines 137-142) so you have the bookingId. After the `UPDATE missions SET current_lat...` write (lines 170-179), add `await this.telemetry.ping(route.booking_id, {lat: sample.lat, lng: sample.lng, heading_deg: sample.heading_deg, speed_kph: sample.speed_kph, source: 'agent'});` to mirror the fix into mission_telemetry_last + the Redis stream the client reads, then `void this.events.telemetryFix(missionId, {lat: sample.lat, lng: sample.lng, recordedAt: new Date().toISOString()}, route.booking_id);`.

> **Step 4:** In the same file, change the PICKUP→LIVE UPDATE (lines 186-190) to `UPDATE missions SET status='LIVE' WHERE id=$1 AND status='PICKUP' RETURNING id` and, only if a row is returned, call `void this.events.statusChanged(missionId, 'LIVE', route.booking_id)`. Do NOT emit LIVE unconditionally.

> **Step 5:** Create apps/auth-service/src/ops/mission-events.module.ts: a @Module that has `providers: [MissionEventsService]` and `exports: [MissionEventsService]` (RedisService comes from the @Global RedisModule). Update apps/auth-service/src/ops/ops.module.ts to import this new module and remove the local MissionEventsService provider/export duplication (keep it exported via the new module). [Fallback if you prefer no extraction: add MissionEventsService directly to AgentModule providers since RedisService is @Global.]

> **Step 6:** In apps/auth-service/src/agents/agent.module.ts: add `MissionEventsModule` (the new module) and `TelemetryModule` (from '../telemetry/telemetry.module') to the `imports` array. Do NOT import OpsModule (it imports AgentModule and would create a cycle). Verify `cd apps/auth-service && npm run build` compiles with no Nest DI errors.

> **Step 7:** Add apps/auth-service/src/agents/mission-lead.events.spec.ts: mock MissionEventsService + TelemetryService; assert that markWaypoint('PICKUP') calls statusChanged(missionId,'PICKUP',bookingId) exactly once and only when the status was DISPATCHED; assert pushTelemetry calls telemetry.ping + telemetryFix on every fix, and statusChanged(...,'LIVE',...) exactly once across two consecutive pushes (transition guarded by RETURNING). Run `cd apps/auth-service && npm test`.

> **Step 8:** In src/screens/liveops/LiveTrackingScreen.tsx: import { journeyStep } from '@screens/booking/missionJourney' (or relative). Replace the headline block (lines 471-481) so the title/pill text comes from `journeyStep({status: activeBooking?.status}, missionStatus ? {status: missionStatus} : undefined).label`, mapping DISPATCHED/PICKUP/LIVE to their step labels and keeping CANCELLED/ABORTED/COMPLETED side-states. Leave the dispatch banner (lines 494-504) gated to journey index <= 2.

> **Step 9:** In the same file, add `const [telemetrySeq, setTelemetrySeq] = useState(0);`. In the useMissionEvents onTelemetry handler (lines 311-322) replace the no-op body with `setTelemetrySeq(n => n + 1);`. Change the `useLiveTelemetry` call (line 381) to pass telemetrySeq and add `telemetrySeq` to that hook's effect dependency array (line 141) so a WS telemetry frame forces an immediate `telemetryApi.latest` fetch.

> **Step 10:** Delete src/hooks/useBookingRealtime.ts (confirm `grep -r useBookingRealtime src` shows only the file itself) OR add a `// DEPRECATED — use useMissionEvents (WS). Not wired.` header. Do not import it.

> **Step 11:** Run gates: `cd apps/auth-service && npm test` (agents + ops + telemetry), `npm run typecheck` (mobile, must stay <= baseline 96/49), `cd apps/ops-console && npm run typecheck`, `npm test -- --selectProjects=booking`, `npm run test:crypto` (regression on the messenger transport that carries the frames).

> **Step 12:** Manual smoke (auto-dispatch, AUTO_DISPATCH on staging): client books → AgencyAccepted → agency assigns crew → confirm client auto-lands on LiveTracking; lead marks PICKUP → client header flips to 'En route to pickup' within a frame (no reload); lead pushes GPS → client map dot jumps to the real CPO position and PICKUP→LIVE flips header to 'Protection active'; lead Finish/ops complete → client popToTop. Verify the agency AgentLiveTrackerScreen still updates (it polls, unaffected).

### ⚠️ Regressions this could introduce (guard against these)

- Emitting 'LIVE' on every telemetry push if the PICKUP→LIVE UPDATE is not RETURNING-gated → WS frame spam + stepper fl/churn on the client. Guard: emit statusChanged('LIVE') only when the conditional UPDATE returns a row.
- DI circular dependency if AgentModule imports OpsModule to get MissionEventsService (OpsModule already imports AgentModule). Guard: use the extracted MissionEventsModule (or provide MissionEventsService locally in AgentModule); run `npm run build` to catch the Nest cycle error.
- telemetry.ping adds a Postgres UPSERT + Redis XADD per lead fix; at ~10s cadence this is negligible, but a misconfigured high-frequency pusher could amplify. Guard: keep the lead push throttle (already 10s on the agent side) and rely on the booking-keyed UPSERT (idempotent on conflict).
- Header label change could mislabel terminal/SOS states if hand-rolled. Guard: reuse journeyStep (already handles COMPLETED/CANCELLED/NO_PROVIDER/ABORTED/SOS) rather than ad-hoc string mapping.
- Forcing a telemetry poll on every WS frame could double up with the backoff poller and increase /telemetry/latest load. Guard: optionally throttle the forced refetch to >=2s; the WS frame already implies a fresh fix exists so a single fetch is cheap.
- Privacy check (not a regression but verify): the new mission.telemetry/status frames go to room mission:`<bookingId>`; ensure only the booking owner's socket joins it — the gateway joins on the client's own mission.subscribe(bookingId), and the data is the same {lat,lng,status} the client already gets via /telemetry/latest, so no new exposure. NOT crypto/auth-token related.

### Tests / verification

- cd apps/auth-service && npm test (covers agents/mission-lead, ops/mission.service, telemetry; add mission-lead.events.spec.ts asserting statusChanged + telemetryFix + ping are called with bookingId and that LIVE is emitted once per real transition)
- npm test -- --selectProjects=booking (booking FSM + missionJourney unit tests for the header label change)
- npm run test:crypto (regression on the messenger transport / TransportClient.subscribeMission + addFrameListener carrying the frames)
- npm run typecheck (mobile, baseline 96/49) and cd apps/ops-console && npm run typecheck
- Manual smoke: full auto-dispatch run on staging (AUTO_DISPATCH on) — verify client LiveTracking shows DISPATCHED→PICKUP→LIVE header changes instantly and the real CPO dot moves with no reload; verify agency AgentLiveTrackerScreen still tracks (unchanged); verify COMPLETED/ABORTED still pops the client out.

### Open questions / decisions needed

- Does the user want literal UI parity (the SP's AgentLiveTrackerScreen map with turn-by-turn + waypoint bubbles) on the client, or just a working status+position view? Recommendation: keep the client on LiveTrackingScreen (the SP tracker reads crew-gated getMissionDeployment and exposes crew call signs + driver turn-by-turn that the client should not see); fixing propagation makes the existing client view show real status + real CPO position. Confirm before building a client-facing rich endpoint.
- Re-entry path: is there a 'Track active mission' CTA on the booking home/dashboard so a client who backs out can return to LiveTracking? AgencyAccepted/BookingConfirmation cover the forward path; verify BookingHomeScreen/dashboard exposes re-entry for an in-progress booking (otherwise add one).
- Should the lead's telemetry mirror also feed the agency's own /telemetry view, or is missions.current_* (read by getMissionDeployment) sufficient for the SP? Current plan mirrors to mission_telemetry_last (booking-keyed) which the client reads; the SP reads missions.current_* directly, so both are covered — confirm no double-counting in any analytics on mission_telemetry_last.
- Is Supabase realtime actually enabled on the bookings/missions tables in this deployment? If yes, useBookingRealtime is a viable belt-and-suspenders path; if no (current evidence: WS is canonical), delete it. Confirm before keeping.

---

## 14. MONITOR-MAP — Monitor map: pickup (A) marker, shortest-route highlight, and A→B traveled/remaining live progress line (Google-Maps live-share style)

**Covers your requests:**

- #10: in the monitor app there should be a pickup mark too
- the shortest route should be highlighted
- when the CPO picks up the client and protection activates, from that point the map line should show progress from A (pickup) to B (endpoint) like Google Maps live-location sharing — showing how much of the route is completed

### Current behavior (as built)

There are THREE 'monitor' surfaces; the requirement is only fully met on one of them.\n\n1) CLIENT MONITOR (mobile) — `src/screens/liveops/LiveTrackingScreen.tsx` — THE GAP. It drives a WebView map (`buildLiveRouteHtml`, src/modules/booking/bravoLiveRouteMapHtml.ts). The route geometry it draws is a STRAIGHT LINE, not the real road route: `buildTrack(origin,dest)` linearly interpolates 7 points (LiveTrackingScreen.tsx:63-74), and `bravoLiveRouteMapHtml.ts:160-167` draws only two straight segments `[origin→vehicle]` (kind 'done', yellow) and `[vehicle→dest]` (kind 'future', green). So 'shortest route highlighted' is UNMET. A pickup dot DOES exist (`origin-dot`, yellow, label `A · Pickup`, bravoLiveRouteMapHtml.ts:30-35,147,151) but there is no road-following A→B route and no real traveled-fraction. Position is largely simulated: `useSimulatedTelemetry` ticks a canned index every 8s (LiveTrackingScreen.tsx:76-91,382); real fixes only come from `useLiveTelemetry`→`telemetryApi.latest` polling (LiveTrackingScreen.tsx:106-150) and only when LIVE (`isLive = missionStatus==='LIVE' || bookingStatus==='LIVE'`, :380). The booking DTO (`src/types/index.ts:117-162`) has `pickup: Location`, `dropoff: Location|null`, `mission_status` but NO `route_polyline`, so the monitor cannot reuse the ops-committed route — it must fetch its own.\n\n2) ORG-MANAGER MONITOR (mobile) — `src/screens/agent/AgentLiveTrackerScreen.tsx` mode='monitor' (:61,221-223) — ALREADY SATISFIES the requirement and is the reference implementation. It draws pickup+dropoff pins and a two-tone traveled/ahead line: `splitRouteAtProgress(rt.coordinates, cpo)` → `window.setNavRoute({traveled, ahead})` (:493-497), rendered by bravoAgentTrackerMapHtml.ts route layers `route-base` (faint underlay), `route-active` (solid, traveled) and `route-future` (dashed, ahead) at :286-309,394-423. Active target flips pickup→dropoff exactly on protection-active: `missionStatus==='LIVE' ? dropoffCoord : pickupCoord` (:481-484). Geometry comes from `fetchDirections` (geojson) in src/utils/mapboxDirections.ts.\n\n3) OPS-CONSOLE MONITOR — `apps/ops-console/src/app/live/[id]/page.tsx` + `apps/ops-console/src/components/BravoMap.tsx`. Has A/B markers already: `{id:'pick',label:'A · PICKUP',type:'pickup'}` and `{id:'drop',label:'B · DROPOFF',type:'dropoff'}` (page.tsx:285-289). Shortest route IS highlighted: `alternativeRoutes` overlay highlights the selected/primary in chunky color, alternates dashed-ghost (BravoMap.tsx:264-330); single `route` line otherwise (:208-235). Progress EXISTS but only as a side BAR, not on the map: `progressPct` from haversine `1 - distToDropoff/route_distance_m` (page.tsx:149-173) drives a `PICKUP → DROPOFF` bar (:948-975). The MAP polyline is single-tone — it does NOT show a traveled-vs-remaining split following `current_lat/current_lng`.\n\nReusable pure helpers already exist and are unit-tested (src/utils/mapboxDirections.ts): `fetchDirections` (geojson, public EXPO_PUBLIC_MAPBOX_TOKEN, :258-284), `splitRouteAtProgress` (:141-154), `remainingRouteM` (:123-134), `nearestIndexOnRoute` (:66-77), `haversineM`. Server route source: `apps/auth-service/src/ops/mapbox-directions.service.ts` (`geometries=polyline6`, :106). LATENT BUG found: `bravoAgentTrackerMapHtml.ts:365` decodes the server polyline at precision 5 (`decodePolyline(polyline,5)`) while the server emits polyline6 and ops-console `lib/polyline.ts` correctly defaults to 6 — the agent tracker's base polyline underlay is therefore mis-scaled (10x); the agent path masks it because `setNavRoute` (geojson via fetchDirections) overwrites the route source once a fix arrives.

### Key files

| File                                                | Role                                                                                                                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/screens/liveops/LiveTrackingScreen.tsx`      | Client monitor screen (PRIMARY gap). Drives the WebView map; currently uses straight-line buildTrack + simulated telemetry. Needs real fetchDirections + splitRouteAtProgress wiring.    |
| `src/modules/booking/bravoLiveRouteMapHtml.ts`    | Client monitor map HTML (PRIMARY). Currently 2 straight segments. Needs distinct A/B pins + a setNavRoute two-tone route layer (base/active/future), ported from the agent tracker HTML. |
| `src/utils/mapboxDirections.ts`                   | Pure, tested helpers to REUSE: fetchDirections (geojson), splitRouteAtProgress, remainingRouteM, nearestIndexOnRoute. No changes needed.                                                 |
| `src/modules/booking/bravoAgentTrackerMapHtml.ts` | Reference implementation of the two-tone route layers + setNavRoute contract to copy. Also site of the polyline6-vs-5 latent bug (:365).                                                 |
| `src/screens/agent/AgentLiveTrackerScreen.tsx`    | Reference: org-manager 'monitor' mode already meets the requirement (split at fix, pickup→dropoff flip on LIVE).                                                                        |
| `apps/ops-console/src/app/live/[id]/page.tsx`     | Ops monitor page. Has A/B markers + route + progress BAR; needs map-level traveled/remaining split passed to BravoMap.                                                                   |
| `apps/ops-console/src/components/BravoMap.tsx`    | Ops map component. Needs optional traveled/remaining two-tone polyline props.                                                                                                            |
| `apps/ops-console/src/lib/polyline.ts`            | decodePolyline(precision=6) — correct precision reference; use to split the ops route at current position.                                                                              |
| `src/services/api.ts`                             | telemetryApi.latest (vehicle fix), Booking/Location types via src/types/index.ts. No route_polyline on the client booking DTO.                                                           |
| `src/utils/__tests__/mapboxDirections.test.ts`    | Existing tests for the split/geo helpers; extend with monitor-progress cases.                                                                                                            |

### Proposed changes (per file)

**1. `src/modules/booking/bravoLiveRouteMapHtml.ts`**

- **Change:** Upgrade the map HTML to support a road-following two-tone route. (a) Add distinct pin styles + labels for A (pickup) and B (dropoff) instead of the generic origin/dest dots, keep the blue vehicle dot+ring. (b) Replace `ensureRouteLayer` with three layers ported from bravoAgentTrackerMapHtml.ts:286-309: `route-base` (faint #7ED6FF underlay = whole shortest path), `route-active` (solid blue = traveled A→vehicle), `route-future` (dashed = remaining vehicle→B). (c) Add `window.setNavRoute({traveled, ahead})` (copy :394-423) that feeds those three layers from arrays of [lng,lat]. (d) Keep `window.setRoute` for markers + initial full route (decode via geojson coords passed from RN, NOT a precision-5 polyline). (e) Keep the ETA pill; add a small 'X% to B' progress chip fed from RN.
- **Why:** Gives the client monitor the same Google-Maps two-tone progress the org-manager monitor already has, without inventing a new pattern.
- **Risk:** Medium — WebView template literal; mismatched layer ids or escaping break the map silently. Mitigate by copying the proven agent-tracker layer block verbatim and testing on device.

**2. `src/screens/liveops/LiveTrackingScreen.tsx`**

- **Change:** Wire the real route + live split. (1) Import `fetchDirections, splitRouteAtProgress, remainingRouteM, type LngLat` from '@utils/mapboxDirections'. (2) Add refs/state: `navRouteRef` (cached DirectionsRoute), `navTargetRef` ('A2B'|'CPO2A'), and fetch the driving route between the active A and B. Active leg mirrors the FSM: while NOT live show CPO→pickup (or just the full pickup→dropoff dim) ; once `isLive` show pickup→dropoff as the A→B route. (3) On each vehicle fix (`vehicle.lng/lat` from live telemetry; freeze at pickup when not live), call `splitRouteAtProgress(route.coordinates, vehicleFix)` and inject `window.setNavRoute({traveled, ahead})`. (4) Inject `window.setRoute({pickup, dropoff, coords})` once so the A/B pins + base route draw. (5) Compute progress % = `1 - remainingRouteM/route.distanceM` and pass to the HTML chip + the route tab. (6) Keep `useSimulatedTelemetry` ONLY as the dot fallback when `!live.hasLive`, but stop using `buildTrack` for the drawn polyline (the real route replaces it). Throttle directions fetches (reuse the 6s/off-route throttle pattern from AgentLiveTrackerScreen.tsx:519-562).
- **Why:** Replaces straight-line simulation with the real shortest road route and a real traveled fraction that advances as the CPO/vehicle moves, switching the endpoint to B exactly when protection activates.
- **Risk:** Medium — directions fetch is async/network; must keep last-good route on failure and never blank the map. Guard against fetch churn on every render (depend on primitive lng/lat, mirror the existing effect-deps fix at LiveTrackingScreen.tsx:400-418).

**3. `apps/ops-console/src/components/BravoMap.tsx`**

- **Change:** Add optional props `traveledRoute?: [number,number][]` and `remainingRoute?: [number,number][]`. In a new effect (mirror the existing route effect at :208-235, keyed on styleNonce) add two layers: a solid 'route-traveled' (e.g. #00C853) and a dashed 'route-remaining' (#7E8AA6), idempotently re-added after style swaps. Keep the existing single `route` as fallback when the split props are absent.
- **Why:** Lets the ops live map show progress ON the map (traveled vs remaining), not only in the side bar, matching 'the map line should show progress'.
- **Risk:** Low-Medium — must replicate the style-swap re-add + teardown discipline already in BravoMap so layers don't leak or vanish on Dark/Streets/Sat cycle.

**4. `apps/ops-console/src/app/live/[id]/page.tsx`**

- **Change:** Decode the mission route (`decodePolyline(m.route_polyline)`, already at :328) and split it at `current_lat/current_lng` using a nearest-vertex index (port `nearestIndexOnRoute` or import a shared helper). Pass `traveledRoute`/`remainingRoute` to `<BravoMap>`. Only when alt-routes overlay is not suppressing the line (the existing `route={altRoutes...?[]:route}` guard at :657 — extend it to suppress the split too when the picker overlay owns the map).
- **Why:** Feeds the new BravoMap split from the already-available current position + committed polyline; A/B markers already exist.
- **Risk:** Low — read-only display; main hazard is double-drawing route + split, avoided via the existing suppression guard.

**5. `src/modules/booking/bravoAgentTrackerMapHtml.ts`**

- **Change:** OPTIONAL bug-fix (separate from #10): line 365 `decodePolyline(polyline, 5)` → `decodePolyline(polyline, 6)` to match the server's polyline6 (mapbox-directions.service.ts:106) and ops-console lib/polyline default 6.
- **Why:** The agent/CPO base-route underlay is currently decoded at the wrong precision (10x off); masked only because setNavRoute later overwrites it.
- **Risk:** Low — one-character precision fix; verify the base underlay aligns with the geojson active line on device.

### Step-by-step prompts for Claude

_Hand these to Claude one at a time, in order._

> **Step 1:** STEP 1 (map HTML — client monitor): In `src/modules/booking/bravoLiveRouteMapHtml.ts`, port the route-layer system from `src/modules/booking/bravoAgentTrackerMapHtml.ts`. Replace the current single `ensureRouteLayer` (lines 98-111) with the three-layer version from bravoAgentTrackerMapHtml.ts:282-310 (`route-base` faint #7ED6FF width5 opacity .2; `route-active` solid #1E88FF width3; `route-future` #7ED6FF width2.5 dasharray [2,2] opacity .5 — all filtered by ['==',['get','kind'], …]). Then add `window.setNavRoute = function(payload){…}` by copying bravoAgentTrackerMapHtml.ts:394-423 verbatim (base = traveled.concat(ahead); active = traveled; future = ahead). Keep the existing pulsing blue vehicle marker. Change the origin/dest dots into labeled A/B pins: keep the yellow pickup dot but ensure its tag reads 'A · PICKUP' and the green dropoff tag reads 'B · DROPOFF' (current code at lines 147-153). Do NOT remove `window.setRoute`; keep it drawing the markers, but have it accept an optional `coords` array ([[lng,lat],…]) for the full route base instead of decoding a polyline. Leave the ETA pill (#etc) as-is and add a small progress chip element `<div id="prog">` styled like .etc, with `window.setProgress(pct)` that sets its text to `pct + '% TO B'`.

> **Step 2:** STEP 2 (screen wiring — fetch real route): In `src/screens/liveops/LiveTrackingScreen.tsx`, add `import {fetchDirections, splitRouteAtProgress, remainingRouteM, type DirectionsRoute, type LngLat} from '@utils/mapboxDirections';`. Add refs near the other refs: `const navRouteRef = useRef<DirectionsRoute|null>(null); const navTargetRef = useRef(''); const navInFlightRef = useRef(false); const navFetchAtRef = useRef(0);`. Add state `const [progressPct, setProgressPct] = useState<number|null>(null);`. The A point is `origin` (pickup) and B is `dest` (dropoff) — both already computed at lines 357-372.

> **Step 3:** STEP 3 (screen wiring — split on each fix): In `src/screens/liveops/LiveTrackingScreen.tsx`, add a new effect that depends on `[webReady, isLive, vehicle.lng, vehicle.lat, origin.lng, origin.lat, dest.lng, dest.lat]`. Inside: define `const target = isLive ? {lng:dest.lng,lat:dest.lat} : {lng:origin.lng,lat:origin.lat};` and `const from = isLive ? {lng:origin.lng,lat:origin.lat} : {lng:vehicle.lng,lat:vehicle.lat};` (when LIVE the highlighted route is the full A→B; before LIVE show CPO→pickup). Build `targetKey = (isLive?'A2B':'C2A')+target.lng.toFixed(4)+','+target.lat.toFixed(4)`. If `navRouteRef.current` is null or `navTargetRef.current!==targetKey` and not in-flight and `Date.now()-navFetchAtRef.current>6000`, call `fetchDirections(from, target)` (guarded by navInFlightRef), store the result in navRouteRef + navTargetRef, and on success/cache call an `applySplit(rt)` helper.

> **Step 4:** STEP 4 (screen wiring — applySplit + inject): In `src/screens/liveops/LiveTrackingScreen.tsx`, write `applySplit(rt)`: `const veh:LngLat={lng:vehicle.lng,lat:vehicle.lat}; const {traveled, remaining}=splitRouteAtProgress(rt.coordinates, veh);` then `webRef.current?.injectJavaScript('try{window.setNavRoute('+JSON.stringify({traveled:traveled.map(c=>[c.lng,c.lat]), ahead:remaining.map(c=>[c.lng,c.lat])})+');}catch(e){} true;');`. Compute `const remM=remainingRouteM(rt.coordinates, veh); const pct = rt.distanceM>0 ? Math.max(0,Math.min(100,Math.round(100*(1-remM/rt.distanceM)))) : 0; setProgressPct(isLive?pct:0);` and inject `window.setProgress(pct)`. Keep the existing `setRoute` injection effect (lines 400-418) but pass `pickup:origin, dropoff:dest` so the A/B pins draw; stop relying on the straight `buildTrack` polyline for the drawn line.

> **Step 5:** STEP 5 (screen — fallback + freeze): In `src/screens/liveops/LiveTrackingScreen.tsx`, keep `useSimulatedTelemetry` ONLY as the dot position fallback when `!live.hasLive` (already the logic at :385-390). When `fetchDirections` returns null (no token / network), do NOT blank the map — skip the setNavRoute and leave the last good split; show the existing 'AWAITING DISPATCH' / simulated dot. Before LIVE, freeze the vehicle dot at pickup (existing :386-387) and draw the A→B base route dim so the user can preview the planned route.

> **Step 6:** STEP 6 (route tab UI): In `src/screens/liveops/LiveTrackingScreen.tsx` route tab (the `tab==='route'` block ~:562-585), add a compact progress row above the timeline showing `progressPct` as a thin bar + '{pct}% of route complete' when `isLive` — mirror the ops-console bar at apps/ops-console/src/app/live/[id]/page.tsx:948-975 for visual consistency.

> **Step 7:** STEP 7 (ops map component): In `apps/ops-console/src/components/BravoMap.tsx`, add `traveledRoute?: [number,number][]` and `remainingRoute?: [number,number][]` to `Props` (after `route`, ~line 83). Add a new effect modeled on the existing route effect (:208-235), keyed `[traveledRoute, remainingRoute, fallback, styleNonce]`, that idempotently adds/updates two GeoJSON sources+layers: `route-traveled` (solid '#00C853' width 3.2) and `route-remaining` (dashed [2,2] '#7E8AA6' width 2.5 opacity .6). Use `getSource(...).setData` when present, else addSource+addLayer, exactly like the route effect. Ensure the initial-style-load guard `map.isStyleLoaded()?apply():map.once('load',apply)` is preserved.

> **Step 8:** STEP 8 (ops page wiring): In `apps/ops-console/src/app/live/[id]/page.tsx`, after decoding `route` (:328), compute the split: import a `nearestIndexOnRoute([lng,lat][], point)` helper (add to apps/ops-console/src/lib/polyline.ts or a small geo util) and, when `m.current_lat/current_lng` are finite and `route.length>1`, slice `traveled=route.slice(0,idx+1)` and `remaining=[[current_lng,current_lat],...route.slice(idx+1)]`. Pass `traveledRoute`/`remainingRoute` to `<BravoMap>` (:651). Extend the existing suppression guard at :657 so when the RE-ROUTE picker overlay is open (altRoutes visible) the split is also suppressed to avoid a triple line.

> **Step 9:** STEP 8b (OPTIONAL latent-bug fix): In `src/modules/booking/bravoAgentTrackerMapHtml.ts` line 365 change `decodePolyline(polyline, 5)` to `decodePolyline(polyline, 6)` so the agent/CPO base-route underlay matches the server polyline6. Verify on device that the faint base line now overlaps the solid nav line.

> **Step 10:** STEP 9 (tests): Extend `src/utils/__tests__/mapboxDirections.test.ts` with monitor cases: (a) splitRouteAtProgress at 0%, ~50% and ~100% of a 3-point route returns the expected traveled/remaining lengths; (b) remainingRouteM at the end ≈ 0 and at start ≈ distanceM. Add an ops-console unit test for the new `nearestIndexOnRoute` if it lands in lib/polyline.ts. Run `npm run test:crypto` is NOT needed; run the targeted util test + mobile typecheck + ops-console typecheck/lint.

> **Step 11:** STEP 10 (verify gates): Run `npm run typecheck` (must stay ≤ baseline 96; the auto-dispatch memory notes mobile baseline ~49 — do not regress), `cd apps/ops-console && npm run typecheck && npm run lint`, and `npm test -- src/utils/__tests__/mapboxDirections.test.ts`. Then device smoke: book → dispatch → CPO marks PICKUP → mission LIVE; confirm the client LiveTrackingScreen draws the A pin, the shortest road route, and a two-tone line whose solid (traveled) portion grows from A toward B as the vehicle moves; confirm ops /live/[id] map shows the same split.

### ⚠️ Regressions this could introduce (guard against these)

- Directions-fetch churn: an effect keyed on the live vehicle lng/lat could refetch Mapbox Directions on every 5s poll. Guard with the 6s throttle + targetKey cache (copy AgentLiveTrackerScreen.tsx:519-562) and only refetch when the target endpoint changes or the fix goes >60m off-route.
- Map blanking on Directions failure / missing token: if fetchDirections returns null the screen must keep the last good route and fall back to the simulated dot, never clear the route source. EXPO_PUBLIC_MAPBOX_TOKEN may be absent in some builds — preserve the existing graceful behavior.
- WebView injectJavaScript spam / re-render storms: depend on PRIMITIVE lng/lat fields not object identities (the exact bug already fixed at LiveTrackingScreen.tsx:400-418) or the map will flicker and burn CPU.
- Endpoint-flip race when mission goes LIVE mid-flight: a late pickup-leg fetch could paint the stale A-leg over the A→B route. Use the desired-target-key staleness guard (drop a resolved fetch whose key ≠ current desired key), as AgentLiveTrackerScreen.tsx:544-545 does.
- Ops-console style-swap layer loss/leak: setStyle drops user layers; the new traveled/remaining layers must re-add on styleNonce and tear down cleanly, matching the discipline already in BravoMap.tsx for `route`/`alternativeRoutes`. Failure = ghost layers or a blank line after Dark/Streets/Sat cycle.
- Double/triple route lines on ops map: drawing `route` + `traveled` + `remaining` + alt-routes simultaneously. Extend the existing suppression guard (page.tsx:657) so only one representation owns the map at a time.
- Polyline precision regression: if any new code reuses the precision-5 decode path it inherits the 10x bug. The client monitor avoids it by using geojson via fetchDirections; if you instead decode a server polyline, use precision 6.
- Progress reading 'NaN%' or >100 from a corrupt GPS fix: clamp and require Number.isFinite on every coord before computing the fraction (mirror page.tsx:158-171).

### Tests / verification

- npm test -- src/utils/__tests__/mapboxDirections.test.ts (extend with split/progress cases)
- npm run typecheck (mobile; must not exceed the .tsc-baseline.json count)
- cd apps/ops-console && npm run typecheck && npm run lint
- Device smoke (mobile client monitor): book → dispatch → CPO PICKUP → LIVE; verify A pin, shortest road route highlighted, two-tone traveled/remaining line advancing A→B, progress % climbs
- Adjacent-screen regression smoke: AgentLiveTrackerScreen (agent + org 'monitor' mode) still renders pickup→dropoff split; ops /live and /live/[id] still load and the RE-ROUTE picker still works
- Error-path smoke: no Mapbox token / airplane-mode — map must not blank, falls back to last route + simulated dot

### Open questions / decisions needed

- Which surface does the user mean by 'the monitor app'? The org-manager monitor (AgentLiveTrackerScreen mode='monitor') already meets the requirement; the gap is the CLIENT LiveTrackingScreen and the ops-console map. Spec assumes both client + ops are in scope; confirm if only one is wanted.
- Should the highlighted route be the client's own freshly-fetched shortest route, or the exact route ops committed (mission.route_polyline) so re-routes propagate? The client booking DTO (src/types/index.ts:117) currently lacks route_polyline; surfacing it via GET /bookings/:id would keep client+ops consistent but requires a backend field add. Spec defaults to client-side fetchDirections (no backend change).
- Before protection-active, should the monitor show CPO→pickup progress, or just a dim full A→B preview? Spec proposes CPO→pickup leg pre-LIVE and full A→B with progress once LIVE — confirm desired pre-LIVE visual.
- Is the precision-5 polyline decode at bravoAgentTrackerMapHtml.ts:365 an accepted known issue or should the bug-fix (STEP 8b) ship with this work?
- ETA: keep the simulated 6-min-per-step ETA, or switch the client monitor to the live route-duration ETA (remainingRouteM-scaled, as the CPO tracker does at AgentLiveTrackerScreen.tsx:512-516)?

---

## 15. MISSION-CANCEL — Client cancel → mission ABORTED + shows in history; enforce 1h window AND protection-active cutoff

**Covers your requests:**

- #14: when the client cancels, the mission should be ABORTED and shown in history.
- #14: the client may only cancel within 1 hour of booking (already implemented) — after that they cannot; and once the flow reaches protection-active they cannot cancel afterwards.

### Current behavior (as built)

CLIENT CANCEL PATH. The mobile cancel button (`src/screens/booking/BookingConfirmationScreen.tsx:198` and `FindingDetailScreen.tsx:67`) calls `bookingApi.cancel(id)` → `api.ts:397-398` POST `/bookings/:id/cancel` → `booking.controller.ts:68-74` `cancel()` → `booking.service.ts:596` `cancel(clientId,id)`.

1H WINDOW — ALREADY IMPLEMENTED AND CORRECT. `booking.service.ts:607-615`: `const windowHours = this.config.get<number>('booking.cancelWindowHours') ?? 1; const ageMs = Date.now() - new Date(row.created_at).getTime(); if (ageMs > windowHours * 3_600_000) { throw new BadRequestException({code:'cancel_window_expired', ...}); }`. Default 1h via `config/configuration.ts:141` `cancelWindowHours: parseFloat(process.env['BOOKING_CANCEL_WINDOW_HOURS'] ?? '1')`. Verified by test `booking.escrow.spec.ts:134-141`.

BUG A — CLIENT CANCEL DOES NOT ABORT THE MISSION. `cancel()` only flips the booking: `booking.service.ts:627` `UPDATE lite_bookings SET status = 'CANCELLED' WHERE id = $1`, handles the escrow hold (`:628-666`), then releases LEGACY pool crew/vehicle via `cpoAssign.release(id)` + `vehicles.release(id)` (`:669-672`). It NEVER touches the `missions` table. So for an auto-dispatch booking that already has a mission (crew assigned), the booking goes CANCELLED while the mission row stays DISPATCHED/PICKUP/LIVE forever. By contrast the Ops/Admin abort (`ops/mission.service.ts:405-536`) DOES flip mission→ABORTED atomically with booking→CANCELLED (`:422-455`) and frees crew. The client path has no equivalent.

BUG B — PROTECTION-ACTIVE CUTOFF NOT ENFORCED. The booking FSM intentionally keeps the booking at `CONFIRMED` while the mission advances DISPATCHED→PICKUP→LIVE (`booking.service.ts:529-532` comment: \"The booking FSM intentionally stays CONFIRMED while the mission advances\"; `state-machine.service.ts:42-58` auto-dispatch transitions never move booking to LIVE for the auto path). `CANCELLABLE` includes `CONFIRMED` (`state-machine.service.ts:61-63`), and `assert()` only checks booking status (`:69-77`). So `fsm.assert(row.status,'CANCELLED','CLIENT')` at `booking.service.ts:602` PASSES even when the mission is LIVE (protection active). The only thing standing between a client and cancelling a live mission is the 1h window — and on-demand missions routinely go LIVE inside that hour. The code comment at `:606` (\"The FSM already blocks cancel once LIVE\") and the mobile comment at `BookingConfirmationScreen.tsx:220-222` are WRONG for auto-dispatch because the booking is CONFIRMED, not LIVE.

BUG B (CLIENT MIRROR). `BookingConfirmationScreen.tsx:108-109` `const liveStatus = (activeBooking?.status ?? '').toUpperCase(); const dispatchedLive = liveStatus === 'LIVE';` and `:223` `const canCancel = !dispatchedLive;` read ONLY the booking status. For an auto mission that is LIVE, booking status is CONFIRMED → `dispatchedLive=false` → the Cancel button is still shown during protection-active. The correct pattern already exists in `LiveTrackingScreen.tsx:378-380`: `const missionStatus = (activeBooking?.mission_status ?? '').toUpperCase(); const isLive = missionStatus === 'LIVE' || bookingStatus === 'LIVE';`.

HISTORY. (a) CPO/agent history ALREADY shows ABORTED: `agent.service.ts:957-972` `getMyMissionHistory` selects `WHERE mc.agent_id=$1 AND m.status IN ('COMPLETED','ABORTED')` joined on `mission_crew` with NO status filter, so once the mission is ABORTED (and crew rows kept) the CPO sees it. (b) Ops console history shows ABORTED: `ops/mission.service.ts:126-127` `listClosed` → `listByStatus(['COMPLETED','ABORTED'],...)`. (c) BUG C — AGENCY (org) history will NOT show it: `org/org-mission.service.ts:70-71` filters `WHERE b.assigned_provider_user_id=$1 AND b.status IN ('CONFIRMED','LIVE','COMPLETED','AGENCY_NO_SHOW')` — CANCELLED is excluded, so a client-cancelled+aborted mission vanishes from the agency's `recent` bucket (`:79-83`). (d) Client side: `booking.service.ts:511-519` `list()` returns all bookings incl. CANCELLED ordered by created_at, and `TripSummaryScreen.tsx:84,212-216` already renders the CANCELLED read-only summary.

### Key files

| File                                                           | Role                                                                                                                                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/auth-service/src/booking/booking.service.ts`           | Client cancel() — add protection-active guard (Bug B) + inline mission→ABORTED flip and crew-capacity free (Bug A). Lines 596-676.                                                                  |
| `apps/auth-service/src/booking/state-machine.service.ts`     | Booking FSM. CANCELLABLE list (61-63) includes CONFIRMED — explains why FSM alone can't block live-mission cancel; the mission-status guard must live in cancel().                                   |
| `apps/auth-service/src/ops/mission.service.ts`               | Reference implementation of mission abort (405-536): atomic mission+booking flip, crew/vehicle release, escrow refund/pro-rata matrix to mirror (DO NOT change its refund math).                      |
| `apps/auth-service/src/ops/mission-state-machine.service.ts` | Mission FSM: MissionStatus enum incl. ABORTED (14-20); ABORTABLE = DISPATCHED/PICKUP/LIVE/SOS (47-49). Defines what is 'protection-active'.                                                           |
| `apps/auth-service/src/org/org-mission.service.ts`           | Agency mission history (listMissions 53-85). Bug C: status IN filter at line 71 excludes CANCELLED — must add it so aborted-via-cancel missions appear in 'recent'.                                  |
| `apps/auth-service/src/agents/agent.service.ts`              | CPO mission history getMyMissionHistory (957-972) already includes ABORTED; flipMissionStatus COMPLETED (1250) shows the mission_crew status='off' capacity-free + history-preserve pattern to reuse. |
| `apps/auth-service/src/booking/booking.escrow.spec.ts`       | Existing cancel test suite (100-142) — extend with mission-abort + protection-active-block cases.                                                                                                    |
| `apps/auth-service/src/config/configuration.ts`              | cancelWindowHours (141) + cancelFeePct (130) config knobs.                                                                                                                                            |
| `src/screens/booking/BookingConfirmationScreen.tsx`          | Client cancel button + canCancel gate (108-109,184-223). Bug B mirror: gate reads booking status only, not mission_status.                                                                            |
| `src/screens/liveops/LiveTrackingScreen.tsx`                 | Correct mission_status-aware 'isLive/protection-active' pattern (378-380) to copy into BookingConfirmationScreen.                                                                                     |
| `src/services/api.ts`                                        | bookingApi.cancel (397-398) — may need to surface the new 'cancel_blocked_protection_active' error code to the UI.                                                                                   |

### Proposed changes (per file)

**1. `apps/auth-service/src/booking/booking.service.ts`**

- **Change:** In cancel() (596-615), after the existing fsm.assert + 1h-window guard, add a protection-active cutoff. Change the initial SELECT to also need nothing extra; then query the latest mission: `const mission = await this.db.qOne<{id:string; status:string}>("SELECT id, status FROM missions WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1", [id]);` and if `mission && ['LIVE','SOS'].includes(mission.status)` throw `new BadRequestException({code:'cancel_blocked_protection_active', message:'Protection is already active. Contact support to end the mission.'})`.
- **Why:** Enforces requirement #14: no client cancel once protection is active. The booking FSM can't enforce it because the booking stays CONFIRMED through the live mission (state-machine.service.ts:61-63).
- **Risk:** Must read the SAME latest mission the client UI sees (getById uses created_at DESC LIMIT 1 at booking.service.ts:533-536) so a re-dispatched mission doesn't false-positive. Low risk; pure read + early throw.

**2. `apps/auth-service/src/booking/booking.service.ts`**

- **Change:** Inside the existing `withTransaction` block (626-652), AFTER the booking is flipped to CANCELLED and escrow is handled, abort any non-terminal mission for this booking ATOMICALLY: `await tx.q("UPDATE missions SET status='ABORTED', ended_at=NOW(), ended_by=$2, end_reason='client_cancel' WHERE booking_id=$1 AND status IN ('DISPATCHED','PICKUP')", [id, clientId]);` (LIVE/SOS are already blocked by the new guard, so only DISPATCHED/PICKUP reach here). Then free auto-dispatch crew capacity while preserving history: `await tx.q("UPDATE mission_crew SET status='off' WHERE mission_id IN (SELECT id FROM missions WHERE booking_id=$1)", [id]);`. Do NOT delete mission_crew rows (the CPO history join at agent.service.ts:962 needs them).
- **Why:** Requirement #14 part 1: client cancel must ABORT the mission. Mirrors the atomic mission+booking flip in ops/mission.service.ts:422-455 and the capacity-free pattern in agent.service.ts:1250, but scoped to the client cancel txn. Keeping mission_crew rows (status='off') makes the ABORTED mission appear in CPO history (agent.service.ts:957-972).
- **Risk:** MONEY-ADJACENT but does NOT change refund math (escrow handling at 628-666 is untouched and runs first). Must stay inside the same txn so a reader can never see booking CANCELLED with mission still LIVE. Guard the UPDATE to DISPATCHED/PICKUP only to avoid racing a concurrent ops abort.

**3. `apps/auth-service/src/org/org-mission.service.ts`**

- **Change:** In listMissions (line 71), add 'CANCELLED' to the status filter: `AND b.status IN ('CONFIRMED','LIVE','COMPLETED','AGENCY_NO_SHOW','CANCELLED')`. Rows with mission_status='ABORTED' (or no mission) then fall into the `recent` bucket via the existing classifier (79-83).
- **Why:** Bug C: without this, a client-cancelled+aborted mission disappears from the agency's history because CANCELLED is filtered out. Requirement #14 says the aborted mission must show in history.
- **Risk:** Will also surface bookings the agency accepted but the client cancelled BEFORE crew assignment (mission_id NULL, booking CANCELLED) in `recent`. That is arguably correct agency history, but confirm with product. Low query-cost risk.

**4. `src/screens/booking/BookingConfirmationScreen.tsx`**

- **Change:** Mirror the server cutoff client-side. Add `const missionStatus = (activeBooking?.mission_status ?? '').toUpperCase();` and redefine `const dispatchedLive = liveStatus === 'LIVE' || missionStatus === 'LIVE' || missionStatus === 'SOS';` (lines 108-109). canCancel (223) then correctly hides the Cancel button once protection is active even though the booking is still CONFIRMED. Update the stale comment at 220-222.
- **Why:** Bug B mirror: the current gate reads only booking status (which stays CONFIRMED for auto), so the Cancel button is shown during a live mission. Copy the proven pattern from LiveTrackingScreen.tsx:378-380.
- **Risk:** UI-only; verify activeBooking.mission_status is populated on this screen (it comes from getById/loadActiveBooking which sets mission_status at booking.service.ts:537). If list() path is used instead, mission_status may be null — confirm loadActiveBooking uses getById.

**5. `src/screens/booking/BookingConfirmationScreen.tsx`**

- **Change:** In handleCancel's catch (208-209), special-case the new backend error: if the message/code is `cancel_blocked_protection_active` or `cancel_window_expired`, show a clear non-retry alert ('Protection is active — contact support' / 'Cancellation window has passed') instead of the generic 'Could not cancel … Please try again.'
- **Why:** Gives the user an accurate reason rather than implying a transient failure they should retry.
- **Risk:** Cosmetic; depends on how the error body is surfaced through authHttp (verify the code/message field reaches e.message).

### Step-by-step prompts for Claude

_Hand these to Claude one at a time, in order._

> **Step 1:** In `apps/auth-service/src/booking/state-machine.service.ts`, confirm (do NOT change) that CANCELLABLE (lines 61-63) includes 'CONFIRMED' and that `assert` (68-84) only inspects booking status. This is WHY the protection-active cutoff must live in booking.service.cancel(), not the FSM. No edit — just orient.

> **Step 2:** In `apps/auth-service/src/booking/booking.service.ts`, in `cancel(clientId,id)` (starts line 596), AFTER the 1h-window guard (ends line 615) and BEFORE the `withTransaction` block (line 626), insert a protection-active guard: query `const mission = await this.db.qOne<{id:string; status:string}>('SELECT id, status FROM missions WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1', [id]);` then `if (mission && (mission.status === 'LIVE' || mission.status === 'SOS')) { throw new BadRequestException({code:'cancel_blocked_protection_active', message:'Protection is already active. Contact support to end the mission.'}); }`. This enforces requirement #14's 'no cancel after protection-active'.

> **Step 3:** In the same `cancel()` `withTransaction` callback (lines 626-652 in `apps/auth-service/src/booking/booking.service.ts`), AFTER the escrow handling returns its `escrow` object but still INSIDE the txn (i.e. add statements right after line 627's booking UPDATE, or just before the callback's return — keep them in the txn), add: `await tx.q("UPDATE missions SET status='ABORTED', ended_at=NOW(), ended_by=$2, end_reason='client_cancel' WHERE booking_id=$1 AND status IN ('DISPATCHED','PICKUP')", [id, clientId]);` and `await tx.q("UPDATE mission_crew SET status='off' WHERE mission_id IN (SELECT id FROM missions WHERE booking_id=$1)", [id]);`. Do NOT delete mission_crew rows. Do NOT modify any wallet/escrow call. This implements requirement #14 part 1 (mission→ABORTED) atomically with the booking CANCELLED flip, mirroring ops/mission.service.ts:422-455.

> **Step 4:** In `apps/auth-service/src/org/org-mission.service.ts`, in `listMissions` (line 71), change the filter to `AND b.status IN ('CONFIRMED', 'LIVE', 'COMPLETED', 'AGENCY_NO_SHOW', 'CANCELLED')` so the aborted-via-cancel mission appears in the agency's `recent` history bucket. No other change needed — the classifier at 79-83 already routes ABORTED/terminal rows into `recent`.

> **Step 5:** In `apps/auth-service/src/booking/booking.escrow.spec.ts`, in the `describe('cancel — escrow-aware')` block (line 100), add a test: a CONFIRMED booking whose latest mission is LIVE → `svc.cancel('c1','b1')` rejects with `{response:{code:'cancel_blocked_protection_active'}}` and NO wallet call fires (mirror the window-expired test at 134-141, but stub the mission SELECT to return {status:'LIVE'}). Add a second test: a booking with a DISPATCHED mission → cancel succeeds AND the txn issues an `UPDATE missions SET status='ABORTED'` (assert via the txRows matcher used at 115-118).

> **Step 6:** In `src/screens/booking/BookingConfirmationScreen.tsx`, change lines 108-109 to also read mission status: add `const missionStatus = (activeBooking?.mission_status ?? '').toUpperCase();` and set `const dispatchedLive = liveStatus === 'LIVE' || missionStatus === 'LIVE' || missionStatus === 'SOS';`. Update the stale comment at 220-222 to note the gate now follows mission_status (matching LiveTrackingScreen.tsx:378-380). This hides the Cancel button once protection is active for auto-dispatch bookings.

> **Step 7:** In `src/screens/booking/BookingConfirmationScreen.tsx` handleCancel catch (lines 208-209), branch on the backend error: if the surfaced message/code matches `cancel_blocked_protection_active` show 'Protection is already active — contact support to end the mission.'; if `cancel_window_expired` show the window message; else keep the generic retry alert. Verify how authHttp surfaces the error body (check `src/services/api.ts` error shape) so you read the right field.

> **Step 8:** Run the booking test project: `cd apps/auth-service && npm test -- booking` (or root `npm test -- --selectProjects=booking`). Then run the full auth-service suite `cd apps/auth-service && npm test` to catch mission/org regressions. Then mobile typecheck `npm run typecheck` (must not exceed baseline 49/96 per CLAUDE.md).

### ⚠️ Regressions this could introduce (guard against these)

- DOUBLE-REFUND / escrow conservation: the new mission-ABORT statements run in the SAME txn as the existing escrow handling (booking.service.ts:626-666). They must be ADDED, never reordered around the wallet calls, and must NOT call any refund themselves — the escrow path already fully reverses the hold. Guard by running booking.escrow.spec.ts (conservation assertions) and confirming wallet.refundEscrowHold/settleEscrowSplit call counts are unchanged for the non-protection-active cases.
- RACE with ops/mission.service.abort(): both can fire near-simultaneously. The new UPDATE is guarded `WHERE status IN ('DISPATCHED','PICKUP')` so if ops already flipped it to ABORTED the client UPDATE is a no-op; and the booking row is locked by the txn's CANCELLED UPDATE. Confirm no path lets both refund — the escrow hold FOR UPDATE lock (line 629) + status guards make the second writer see a non-HELD hold and skip.
- LATEST-MISSION ambiguity: a re-dispatched booking (CONFIRMED→DISPATCHING→CONFIRMED, state-machine.service.ts:58) can have multiple mission rows. The protection-active guard and the abort UPDATE must target the CURRENT mission. The guard uses created_at DESC LIMIT 1 (same as getById:533-536); the abort UPDATE intentionally aborts ALL non-terminal DISPATCHED/PICKUP missions for the booking — verify an old ABORTED mission is untouched (status guard) and only the live one is hit.
- ORG history noise: adding 'CANCELLED' to org-mission.service.ts:71 also surfaces bookings cancelled before crew assignment (mission_id NULL) in `recent`. If product wants ONLY missions that actually existed, additionally require a mission: filter `recent` client-side or add `AND (m.id IS NOT NULL OR b.status<>'CANCELLED')`. Guard: eyeball the OrgMissionsScreen recent list after a pre-crew cancel.
- CLIENT mission_status freshness: BookingConfirmationScreen's new gate depends on activeBooking.mission_status being populated. If the store hydrates activeBooking from list() (which may omit mission_status) rather than getById (which sets it at booking.service.ts:537), the gate silently no-ops. Guard: confirm loadActiveBooking calls GET /bookings/:id (getById).
- MISSION_CREW status='off' side effects: setting crew rows to 'off' frees the auto-dispatch capacity unique index (mission_crew_agent_active_uq). Verify no live-tracking/agent screen treats 'off' crew as an error and that getMyMissionHistory (no status filter, agent.service.ts:962) still returns the row so the CPO sees the ABORTED mission.

### Tests / verification

- apps/auth-service booking project: `npm test -- --selectProjects=booking` (covers booking.escrow.spec.ts cancel cases, state-machine.service.spec.ts, state-machine.drift.spec.ts, booking-flow.spec.ts).
- apps/auth-service full suite: `cd apps/auth-service && npm test` (mission.service.spec.ts abort path, org-mission, ops-flow.smoke.spec.ts).
- New/extended unit tests in booking.escrow.spec.ts: protection-active block + mission→ABORTED-on-cancel.
- Mobile typecheck: `npm run typecheck` (must not exceed baseline).
- Manual smoke (3 roles): client books on-demand → agency accepts → CPO assigned (mission DISPATCHED) → client cancels within 1h → assert mission shows ABORTED in (a) CPO 'my missions' history, (b) agency OrgMissionsScreen recent, (c) ops console Completed tab, and client sees CANCELLED TripSummary with refund line.
- Manual smoke (negative): drive the mission to LIVE (protection active) within the 1h window → assert the client Cancel button is hidden (BookingConfirmationScreen) AND a direct POST /bookings/:id/cancel returns 400 cancel_blocked_protection_active.
- Manual smoke (window): wait past BOOKING_CANCEL_WINDOW_HOURS with no mission → cancel returns 400 cancel_window_expired (unchanged).

### Open questions / decisions needed

- Protection-active set: is it LIVE+SOS only, or should PICKUP (CPO has physically arrived at the principal) also block client cancel? Current spec blocks LIVE/SOS and allows DISPATCHED/PICKUP cancel-with-fee. Confirm with product whether arrival-at-pickup should also lock cancellation.
- Should the inline client-cancel abort also notify the agency/CPO the way ops/mission.service.abort() does (ops-room post line 518-519, crew push wake 525-532, archiveConversation 533-535)? BookingService does not inject bookingPush/systemMsg/events. If notification is required, either inject those deps (watch for circular module deps Ops↔Booking) or emit a lightweight event. Currently the agency/CPO would only learn via polling their mission list flipping to ABORTED.
- Agency-history scope: should pre-crew CANCELLED bookings (no mission ever created) appear in the agency 'recent' list, or only bookings where a mission existed and was aborted? Affects the exact org-mission.service.ts:71 filter.
- Cancellation fee on a DISPATCHED-but-not-live cancel: the existing partial-fee logic (booking.service.ts:637-648) fires when a mission row exists. With the new abort, confirm the fee policy is still desired for a DISPATCHED (crew en route) cancel and that finance has signed off on dispatch.cancelFeePct (currently a placeholder 0 per MEMORY).
- Does any backend watchdog (crew-SLA / arrival-no-show) need to ignore client-ABORTED missions to avoid double-processing? Verify the sweeps key off mission.status NOT IN terminal so an ABORTED-by-cancel mission is skipped.

---

---

# Addendum A — Messenger group calls + group-key self-healing

> **Added 2026-06-25** (follow-up ask). Investigation: 3-agent workflow (group-call-fail + self-heal design + adversarial crypto-guard). **Both areas are security-locked (group master-key distribution) — implement only after architecture sign-off, and harden only.**

**TL;DR:** The group "Call failed" is **not** a missing FrameCryptor build — the native module is present and compiled. The call **fails closed on a missing/un-distributable group master key**, and because one media-agnostic key covers both tracks, **audio and video fail together**. The deeper fix is the same as self-healing: when a member lacks the current group key (reinstall / app delete / 2nd device / keychain miss), the **group admin/owner must silently re-key and redistribute** over pairwise Signal sessions. The crypto-guard gave a **CONDITIONAL PASS** with mandatory guardrails (see verdict below — the big one: the heal must never become a "send me the key" oracle).

### A1: GROUP-CALL-FAIL-GENERAL — Audio+video call fails in a normal user-created messenger group — fail-closed on a missing/un-distributable group master key (not a missing FrameCryptor build) 🔒 (architecture sign-off required)

**Covers your requests:**

- A voice call started from the audio button in a general (user-created) group conversation must connect for participants who are legitimate group members.
- A video call started from the video button in the same group must connect for those participants.
- The fix must stay inside the locked E2EE contract: group call media stays SFrame/FrameCryptor-encrypted on top of SRTP; the SFU never sees plaintext; the call still fails CLOSED (no media) if a participant genuinely has no group key — never falls back to plaintext-on-SFU.
- Diagnose whether the failure is (a) missing/disabled FrameCryptor native module, (b) SFU room-token/TURN/ICE, (c) signalling/launch misroute, (d) missing group master / group-call key, or (e) a UI/launch bug, and separate audio-specific vs video-specific causes.
- Do not duplicate the CALLS-GROUP (mission/ops-room call) or MISSION-GROUP areas; focus on the general group and the gaps those miss.

#### Root cause / gap analysis

"For a general user-created group the call is gated fail-closed on the GROUP MASTER KEY, and that gate — working as designed — is what surfaces as 'Call failed' for both audio and video. The native FrameCryptor module is present (cause (a) is excluded in this build), and audio/video share one media-agnostic key gate, which is exactly why BOTH fail together rather than one or the other. The failure is therefore (d) missing/un-distributable group key, with three concrete general-group triggers:\n\n1) NON-OWNER-HOST GAP (code): when the member who taps 'call' is not the group's owner, `ensureCallGroupKey` reuses its own key but does NOT fan it out (productionRuntime.ts:2755-2766). Any recipient who is missing the group key (reinstall, 2nd device per B-18, B-15b keychain read miss that minted a fresh DB key, or B-35 owner-key divergence) never receives it from this host, waits the full 25s (groupCallKeyWait.ts:66) and fails closed. The owner-only forgery guard (recipient drops an admin/create whose owner != sender) is WHY a non-owner cannot simply re-broadcast — so there is no on-demand owner-mediated redelivery path today.\n\n2) HOST LACKS THE KEY (code): if the initiator itself has no real-group key, `ensureCallGroupKey` throws immediately (productionRuntime.ts:2762-2765) => host 'Call failed' before anyone is rung.\n\n3) EMPTY RECIPIENTS (code/launch): recipients come only from `conversations[cid].participants` (launchCall.ts:81-86). If the group row isn't synced from /conversations/mine (restored-from-backup, fresh login), `participants` is empty => host `ensureCallGroupKey` throws 'no other participants' (productionRuntime.ts:2683-2685) => 'Call failed', even though `groups[cid].members` may hold the roster.\n\nSecondary, shared-infra (cross-ref, not owned here): WS not connected => 'Group call unavailable' (useGroupCall.ts:800; ties to the messenger WS JWT-secret-drift memory note), and SFU_ROOM_TOKEN_SECRET config drift => room_token_required at sfu.join (CALLS-GROUP area). Audio-specific vs video-specific: the only video-only path is camera acquisition + the B-07 mid-call video retry; since BOTH fail, a camera-permission-only cause is excluded and the common key gate is implicated."

#### Current behavior (as built)

"General-group calls route to the SFU. ChatScreen renders both call buttons for a group and both call `launchCall` (src/screens/messenger/ChatScreen.tsx:983 voice, :986 video). `launchCall` treats any `type==='group'|'ops_channel'` (or 2+ other members) as a group, derives recipients via `otherMembers()` = `convo.participants` minus self, and navigates to GroupCallScreen (launchCall.ts:92-98, :155-194). `useGroupCall` boots: get live WS (`getLiveTransport()`; null => setState('unavailable'), useGroupCall.ts:797-801), POST /sfu/rooms (host) or join existing room, then a HARD E2EE gate before any media flows.\n\nThe E2EE gate is media-agnostic and fail-closed:\n1) `if (!frameCryptorOrchestratorAvailable()) { setState('failed'); ... return; }` (useGroupCall.ts:1090-1097).\n2) Host calls `ensureCallGroupKey` (useGroupCall.ts:1170-1180). Joiner without a key `await waitForGroupCallKey(...)` up to 25s; on 'timeout' or still-no-key it `throw`s (useGroupCall.ts:1181-1213, groupCallKeyWait.ts:59-90).\n3) `new FrameCryptorOrchestrator(...).init()` — `init()` throws 'no group master key' if `keySource.current(conversationId)` is null (frameCryptorOrchestrator.ts:105-124, messengerStoreKeySource.ts:15-20).\nAny throw is caught at useGroupCall.ts:1259-1266 => `setState('failed')` => GroupCallScreen renders the blank 'Call failed' (GroupCallScreen.tsx:1408-1413). Both audio AND video die identically because one per-participant key covers both tracks — `attachSenderCryptor` ignores `kind` (frameCryptorOrchestrator.ts:162-174) and `deriveParticipantKey` is per (master,epoch,participantTag) only (packages/messenger-core/src/calls/frameCryptorKeys.ts:75-115).\n\nThe native module is PRESENT in this build (not the historical 'missing FrameCryptor' note): android/app/src/main/java/com/bravosecure/app/BravoFrameCryptorModule.kt + BravoFrameCryptorPackage.kt, registered at MainApplication.kt:28 (`add(BravoFrameCryptorPackage())`), compiled into both debug and release dex, backed by `io.getstream:stream-webrtc-android:1.3.10` which ships the `org.webrtc.FrameCryptor*` classes `isAvailable()` probes (node_modules/react-native-webrtc/android/build.gradle:36-45, BravoFrameCryptorModule.kt:34-43). The earlier device-only break (WebCrypto HKDF unimplemented on Hermes) is already fixed by switching to @noble HKDF (frameCryptorKeys.ts:101-114).\n\nThe key-distribution seam for a real named group: `ensureCallGroupKey` re-broadcasts the group key ONLY when this device OWNS the group state (`existing.owner === ownAddress.userId`, productionRuntime.ts:2701-2735). When the caller is a NON-owner host of a real group it just `return {keyConversationId}` reusing the local key with NO fan-out (productionRuntime.ts:2755-2766); if it lacks the key it throws. Recipients also only ever resolve the key they already hold (resolveKeyId in useGroupCall.ts:1126-1164)."

#### Key files

| File                                                                         | Role                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/messenger/webrtc/useGroupCall.ts`                             | Group-call boot/orchestrator. Lines 797-801 WS gate; 1085-1097 FrameCryptor-availability gate; 1126-1215 joiner key resolve + 25s wait; 1229-1266 orchestrator init + fail-closed catch; 1701-1728 ring fan-out. |
| `src/modules/messenger/runtime/productionRuntime.ts`                       | ensureCallGroupKey (2678-2837): owner re-broadcast (2701-2735), NON-OWNER no-fan-out gap (2755-2766), empty-recipients throw (2683-2685).                                                                        |
| `src/modules/messenger/webrtc/groupCallKeyWait.ts`                         | 25s fail-closed wait for the group key (59-90) and the B-07 video-encryptor retry (140-166).                                                                                                                     |
| `src/modules/messenger/webrtc/frameCryptorOrchestrator.ts`                 | E2EE init; throws 'no group master key' (105-124); media-agnostic per-participant key (162-174).                                                                                                                 |
| `src/modules/messenger/webrtc/frameCryptorTransport.ts`                    | Native bridge; isAvailable() probes org.webrtc.FrameCryptor classes (60-71); refusal contract (163-169).                                                                                                         |
| `src/modules/messenger/webrtc/messengerStoreKeySource.ts`                  | Adapts groups[cid].masterKeyB64/epoch as the FrameCryptor key source (15-33) — null => init throws.                                                                                                             |
| `packages/messenger-core/src/calls/frameCryptorKeys.ts`                    | deriveParticipantKey HKDF (75-115); one key per (master,epoch,tag) covers both audio+video; @noble HKDF fix (101-114).                                                                                           |
| `src/modules/messenger/webrtc/launchCall.ts`                               | Group routing + recipient derivation from conversations[].participants (81-98, 155-194).                                                                                                                         |
| `src/screens/messenger/ChatScreen.tsx`                                     | Group call buttons -> launchCall voice (983) / video (986).                                                                                                                                                      |
| `src/screens/messenger/GroupCallScreen.tsx`                                | Failure UI: 'Call failed' / 'Group call unavailable' (1408-1413) — currently no actionable reason.                                                                                                              |
| `src/screens/messenger/IncomingGroupCallScreen.tsx`                        | Incoming join: passes hostUserId=fromUserId + roomToken into GroupCallScreen (50, 134-144).                                                                                                                      |
| `android/app/src/main/java/com/bravosecure/app/BravoFrameCryptorModule.kt` | Native FrameCryptor (present); isAvailable via class probe (34-43). Registered at MainApplication.kt:28.                                                                                                         |
| `apps/messenger-service/src/sfu/room-token.service.ts`                     | Per-recipient HMAC room token issue/verify — shared infra (CALLS-GROUP cross-ref).                                                                                                                              |

#### Proposed changes (per file)

**1. `src/screens/messenger/GroupCallScreen.tsx + src/modules/messenger/webrtc/useGroupCall.ts`**

- **Change:** Add a typed failure REASON to GroupCallState transitions (e.g. 'failed-no-key' | 'failed-sfu' | 'failed-transport') and render an actionable message instead of a blank 'Call failed' — e.g. 'Waiting for group encryption key. Open the chat to sync, then retry.' for the key-timeout/no-key path (useGroupCall.ts:1211-1213,1259-1266) vs 'Call unavailable — check connection' for WS/SFU (useGroupCall.ts:800, sfu_rooms_* throws).
- **Why:** Today every distinct gate collapses to 'Call failed' (GroupCallScreen.tsx:1408-1413), which is why the bug is hard to triage and gives the user no recovery. Pure UI/telemetry change.
- **Risk:** Low — no crypto/transport behavior change; only state-reason plumbing + copy. Keep the existing 'failed' value as a superset to avoid breaking adjacent state checks.

**2. `src/modules/messenger/webrtc/launchCall.ts`**

- **Change:** When `conversations[cid].participants` is empty/<1 other, fall back to the group roster in `useMessengerStore.getState().groups[cid].members` (keys minus self) to build `recipientUserIds`.
- **Why:** Removes the empty-recipients hard-fail (productionRuntime.ts:2683-2685) for synced-by-key-but-not-by-conversation groups (restore/fresh login). groups[].members is already the authoritative membership for the master key.
- **Risk:** Medium — must filter self and dedupe exactly like otherMembers(); over-broad recipients would ring extra users. Covered by a unit test on the recipient-derivation helper. Not security-gated (membership is client-local, already used for key fan-out).

**3. `src/modules/messenger/runtime/productionRuntime.ts (ensureCallGroupKey) + a new owner-mediated key-request envelope`**

- **Change:** Add an owner-mediated key redelivery: a keyless joiner (or a non-owner host that detects a recipient is missing the key) sends a pairwise Signal 'group-key-request' to the group OWNER; the owner responds by re-running its existing owner-only re-broadcast (productionRuntime.ts:2701-2735). Non-owner host path (2755-2766) stays no-fan-out (the forgery guard forbids it) but now triggers the request.
- **Why:** Closes the non-owner-host gap and the keyless-member precondition WITHOUT weakening fail-closed: the key still comes only from the real owner over Signal, and absence still fails closed after the window. This is the durable fix that makes general-group calls reliable regardless of who initiates.
- **Risk:** HIGH / security-gated — new message type in the group key-distribution path. Must verify: request carries no key material, owner re-broadcast keeps owner===sender forgery guard, no new way to coerce a rekey/epoch change, and it cannot be used to probe membership. Requires architecture sign-off.

**4. `src/modules/messenger/webrtc/useGroupCall.ts`**

- **Change:** On the joiner key-wait 'timeout' path (useGroupCall.ts:1208-1213), before failing closed, fire the owner-mediated key-request (above) once and extend the benign wait a bounded amount; on still-no-key after the bounded window, fail closed exactly as today.
- **Why:** Turns the silent 25s death into an active recovery while preserving the no-key => no-media invariant.
- **Risk:** HIGH / security-gated — same key-distribution gate as the change above; the bounded extra wait must not become an unbounded retry loop and must not relax the closed-fail outcome.

**5. `src/modules/messenger/webrtc/useGroupCall.ts (diagnostics)`**

- **Change:** At each fail-closed branch (1092, 1212, 1261) and the WS gate (800), emit a crashLog breadcrumb tagging WHICH gate fired (no-fc / no-key-timeout / init-throw / no-ws) alongside the existing keydiag fingerprint (1245-1258).
- **Why:** Lets a field capture distinguish (a)/(b)/(c)/(d)/(e) without a debugger, since console.* is not in release logcat (the reason crashLog exists).
- **Risk:** Low — log-only; must keep the no-plaintext/no-key-bytes rule (only the SHA-256 fingerprint, never the key).

#### Step-by-step prompts for Claude

_Hand these to Claude one at a time, in order._

> **Step 1:** Confirm the build excludes cause (a): run `grep -n 'add(BravoFrameCryptorPackage' android/app/src/main/java/com/bravosecure/app/MainApplication.kt` and `grep -n 'stream-webrtc-android' node_modules/react-native-webrtc/android/build.gradle`. Both must hit. Then on a device, log the result of `frameCryptorOrchestratorAvailable()` at useGroupCall boot — if true, FrameCryptor is NOT the cause and you are in the key-gate path (d).

> **Step 2:** Reproduce and classify: start a group call as the group OWNER (should connect if recipients have the key) and then as a NON-OWNER member, with at least one recipient that reinstalled/lacks the key. Capture the crashLog keydiag line (useGroupCall.ts:1257). Same masterKeyFp+epoch on both devices => key is fine, look at SFU/native; different/absent fp => key desync/absence (the expected general-group root cause).

> **Step 3:** Add a typed failure reason: in src/modules/messenger/webrtc/useGroupCall.ts, thread a `failReason` ('no-fc'|'no-key'|'sfu'|'transport') alongside each `setState('failed')` (1092,1212,1261) and `setState('unavailable')` (800); surface it through the GroupCallHandle. In src/screens/messenger/GroupCallScreen.tsx replace the blank message at 1408-1413 with reason-specific copy ('Waiting for group encryption key — open the chat to sync, then retry' for no-key). Add a unit test asserting each branch maps to the right reason.

> **Step 4:** Fix empty recipients in src/modules/messenger/webrtc/launchCall.ts: extract a `groupCallRecipients(conversationId)` helper that returns `otherMembers()` if non-empty, else `Object.keys(groups[cid].members)` minus self/ownId, deduped. Use it in the group branch (currently otherMembers at line 156). Add a test covering: participants populated, participants empty + members populated, and self-filtering.

> **Step 5:** Add fail-closed diagnostics: at useGroupCall.ts:800/1092/1212/1261 call crashLog with the gate tag (no plaintext/key bytes). Verify against the log-audit test (`npm run test:crypto` includes packages/messenger-core/__tests__/logAudit.test.ts) that no key material is logged.

> **Step 6:** SECURITY-GATED — design the owner-mediated key request: write a short design note and get architecture sign-off BEFORE coding. Specify the new pairwise envelope (request carries conversationId only, no key bytes), that the OWNER answers via the existing owner-only re-broadcast (productionRuntime.ts:2701-2735) preserving the owner===sender forgery guard, that epoch/rekey is untouched, and that absence after a bounded window still fails closed. Do NOT implement until signed off.

> **Step 7:** After sign-off, implement the key-request: keyless joiner timeout path (useGroupCall.ts:1208-1213) fires one request to the owner then waits a bounded extra window; non-owner-host path in productionRuntime.ts ensureCallGroupKey (2755-2766) fires the request for recipients it can't serve. Add tests: keyless joiner recovers when owner is online; still fails closed when owner is offline/absent; request never carries key bytes.

> **Step 8:** Regression: `npm run test:crypto` (crypto/runtime safety net), the booking project untouched, then `npm run typecheck` (mobile, must stay <= baseline) and `cd apps/ops-console && npm run typecheck`. Manual smoke per CLAUDE.md rule 6: boot app, 1:1 call, group call as owner AND as non-owner with a keyless recipient, both audio and video.

> **Step 9:** Cross-check shared infra without duplicating CALLS-GROUP/MISSION-GROUP: if calls fail at the WS/SFU layer (state 'unavailable' or sfu_rooms_*/room_token_required), confirm messenger WS is connected (JWT-secret-drift memory note) and that SFU_ROOM_TOKEN_SECRET matches across the createRoom/by-conversation/gateway instances; file findings under those areas, not here.

#### ⚠️ Regressions this could introduce

- Threading a failReason could accidentally change which branch shows minimize-vs-failed UI (GroupCallScreen.tsx:1285-1291,1408) — keep 'failed'/'unavailable' as the canonical states and treat reason as additive metadata only.
- launchCall members-fallback could ring users who are in groups[].members but were removed from the live conversation, or ring self if filtering is wrong — mirror otherMembers' self/ownId filter exactly and dedupe.
- The owner-mediated key request is the highest-risk change: a naive implementation could (a) let a non-owner trigger an epoch/rekey, (b) leak membership by responding to requests from non-members, (c) create an unbounded retry loop, or (d) re-introduce the B-35/B-10 owner-poison overwrite. Must preserve the owner===sender guard and the no-mint-over-foreign-group guard (productionRuntime.ts:2737-2766).
- Extending the key-wait window risks holding the user on 'Joining…' too long; cap it and keep the hard fail-closed timeout.
- Diagnostic breadcrumbs risk logging key bytes if copied carelessly — only the existing SHA-256 fingerprint is permitted (logAudit.test.ts enforces).

#### Tests / verification

- src/modules/messenger/__tests__/groupCallKeyWait.test.ts — extend: timeout path yields fail-closed reason 'no-key' and never 'ready' without a key.
- New launchCall recipient-derivation test: participants populated; participants empty + groups[].members populated; self/ownId filtered + deduped.
- New GroupCallScreen failure-reason test: each of no-fc/no-key/sfu/transport maps to the correct user-facing copy.
- src/modules/messenger/__tests__/adhocCallKeyLookup.test.ts — re-run to confirm resolveKeyId real-group vs ad-hoc slot logic is unchanged.
- packages/messenger-core/__tests__/logAudit.test.ts + npm run test:crypto — confirm new breadcrumbs log no key/plaintext.
- (Security-gated change) new owner-mediated key-request tests: keyless joiner recovers when owner online; fails closed when owner offline; request carries no key bytes; non-owner cannot force rekey/epoch; non-members get no response.
- Manual device smoke: group voice + group video, initiated by owner AND by a non-owner, with a recipient that reinstalled (keyless).

#### Open questions

- Which concrete failure does the field device actually hit — 'Call failed' (key gate) or 'Group call unavailable' (WS down)? The keydiag/breadcrumb from step 1-2 decides this before any code change.
- Is SFU_ROOM_TOKEN_SECRET set consistently across the createRoom/by-conversation HTTP controller and the WS gateway on the current staging deploy? A mismatch would fail ALL general-group calls at sfu.join regardless of keys (belongs to CALLS-GROUP but must be ruled out first).
- Is the failing group genuinely a user-created group (type==='group') vs an ops_channel/mission room? Confirm so this stays distinct from MISSION-GROUP.
- For the owner-mediated key request: does the architecture allow a keyless member to request redelivery from any admin, or strictly the owner? (affects multi-admin groups and B-18 multi-device).
- Does the failing recipient's local group key absence stem from B-18 (2nd device never provisioned), B-15b (keychain read miss minted a fresh DB key), or B-35 (owner divergence)? Each implies a slightly different long-term remediation.

### A2: GROUP-SELF-HEAL — Group master-key self-healing: admin-mediated re-key + redistribute when a member loses the key (reinstall/clear-data) 🔒 (architecture sign-off required)

**Covers your requests:**

- Determine whether group self-healing exists today (it does NOT, by design — the codebase explicitly leaves a truly-lost key fail-closed and labels re-seeding an 'owner-side resync' that is architecture-gated).
- Distinguish what is lost on app UPDATE (keystore + SQLCipher DB preserved → nothing lost) vs UNINSTALL/REINSTALL or CLEAR-DATA (keystore compartments + SQLCipher DB wiped → group master key, DB key, Signal identity, sessions all lost).
- Design a within-contract self-heal: a keyless member re-establishes X3DH/pairwise Signal sessions, the GROUP ADMIN detects the member can no longer decrypt, BEHIND THE SCENES advances the epoch (new master key) via existing rekey machinery, and redistributes the new key to all current members over pairwise Signal.
- Keep the locked contract intact: server stays key-blind, sender-cert verification stays, epoch stays monotonic, no plaintext to relay, no 'send me the key' oracle.
- Define who 'admin' is per group type (user group = owner; mission/ops room = agency room-creator) and what triggers the heal (member-side keyless signal vs admin presence detection).
- Identify exact functions to REUSE vs ADD; flag every architecture-gated step (security_gated=true).

#### Root cause / gap analysis

"GAP ANALYSIS (what exists vs what is missing). EXISTS: (1) full epoch/rekey machinery (genFreshGroupMasterKey, applyAdminAction rekey, broadcastToGroup, deriveRekeyMasterKey); (2) durable no_key/divergence stash + auto-drain on key arrival (productionRuntime.ts:4567-4601, 1192-1200) — so the moment a new key lands the keyless member's queued messages render automatically; (3) backup-restore of GroupState (restoreMessages.ts:217-244) covering the WITH-backup case. MISSING: (a) NO bare 'rekey current members' planner — grep for planRekey/healGroup/keyRequest across the repo returns nothing; all three planners bundle a membership change. (b) NO member-side signal that says 'I am a member of group X but hold no key for epoch N' that reaches the admin — the no_key path only stashes locally + shows a banner (productionRuntime.ts:4598-4601). (c) NO admin-side handler that, on such a signal, mints a fresh key and redistributes. (d) A crypto-mechanics blocker: a `rekey` body is wrapped under the CURRENT master key (groupClient.ts:146-149), which the keyless requester does NOT have — so a plain rekey cannot reach the very member it is meant to heal (chicken-and-egg). The heal therefore needs a keyless-safe delivery for the requester (the `create`-style plaintext-under-pairwise channel, groupClient.ts:146-149 + createGroupChat:2225-2231), which is a change to group-key-distribution semantics and is exactly the 'owner-side resync' the code defers as architecture-gated (bootGroupStashDrain.ts:18-27, B-26(a)/B-13). Net: the building blocks are all present; what is missing is a sanctioned heal request channel + an admin heal entrypoint + a keyless-safe re-seed delivery, all gated by the security contract."

#### Current behavior (as built)

"Self-healing does NOT exist on main; the design is deliberately fail-closed. When a member has no master key for a group, inbound group text takes the `no_key` branch — `parseGroupMessage` returns `{ok:false, reason:'no_key'}` (packages/messenger-core/src/groups/groupClient.ts:301-305) — and productionRuntime durably stashes the envelope + shows a banner but NEVER recovers the key: `productionRuntime.ts:4567-4601` ('Waiting for this group's encryption key — the message will appear once it syncs.'). Key-divergence (wrong/old key) takes the `tamper` branch and is likewise stashed fail-closed (productionRuntime.ts:4521-4565). The ONLY drain triggers are (a) boot warm-up for groups whose key is ALREADY on disk (selectGroupIdsToDrain, productionRuntime.ts:1192-1200) and (b) a post-txn `drain-group` after an inbound admin create/rekey commits a key — never a live out-of-band key fetch. bootGroupStashDrain.ts:18-27 states the policy verbatim: 'Re-seeding a truly-lost key is an owner-side resync — a group-master-key-distribution change, a CLAUDE.md stop-condition decided fail-closed (sqa.md B-26(a), B-13). This helper MUST NOT request or distribute keys.'\n\nWhere keys live: group master keys are AES-GCM-wrapped under a per-user group-wrap secret (a SEPARATE keychain entry, getOrCreateGroupWrapKey, runtime/keychain.ts:318-339) and stored in the SQLCipher `group_master_keys` table (msg compartment, keychain.ts:27). GroupMasterKeyStore.getKey returns `undefined` when the row is missing OR the GCM tag fails — never a soft-recover (store/groupMasterKeyStore.ts:120-138). Keychain keys use WHEN_PASSCODE_SET_THIS_DEVICE_ONLY + SECURE_HARDWARE (keychain.ts:82-85), so they are this-device-only and do NOT migrate to a new phone.\n\nThe rekey machinery the heal must reuse already exists: broadcastToGroup fans out one sealed Signal ciphertext per current member (groupClient.ts:127-229) and only sends PLAINTEXT-under-pairwise for `admin:'create'` — every other admin body, including `rekey`, is groupEncrypt-wrapped under the CURRENT master key (`skipGroupKey = params.admin?.type === 'create'`, groupClient.ts:146-149). applyAdminAction handles `rekey` (epoch++ + masterKeyB64 swap, groupClient.ts:460-468) and `create` (bootstrap, groupClient.ts:395-408). planRemoveAndRekey/planAddAndRekey/planLeaveAndRekey + deriveRekeyMasterKey + genFreshGroupMasterKey exist (groupClient.ts:631-859). The runtime removeGroupMember (productionRuntime.ts:2340-2487) is the template for a two-step membership-change+rekey fan-out. createGroupChat (productionRuntime.ts:2187-2310) is the template for minting + signing (signGroupCreate) + plaintext-under-pairwise distribution of a NEW key to members who don't yet hold one.\n\nPartial recovery that DOES exist: encrypted backup/restore restores GroupState including masterKeyB64 (backup/restoreMessages.ts:217-244, group_state blob encrypted per backupWireV3.ts). So a user WITH a backup who restores gets group keys back and needs no heal. The gap is the no-backup reinstall and the multi-device case (B-18: a 2nd device that was never an envelope recipient and has no backup of that group)."

#### Key files

| File                                                     | Role                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/messenger-core/src/groups/groupClient.ts`    | Authoritative group crypto: broadcastToGroup (skipGroupKey only for create, :146-149), parseGroupMessage no_key/tamper (:280-327), applyAdminAction rekey/create (:385-486), planRemove/Add/LeaveAndRekey + deriveRekeyMasterKey + genFreshGroupMasterKey (:631-859), signGroupCreate/verifyGroupCreateSignature (:885-966). ADD the bare heal planner here. |
| `src/modules/messenger/groups/groupClient.ts`          | Thin re-export mirror of the package (must stay reference-equal; groupClientMirror test locks it). New exports added to the package must be re-exported here.                                                                                                                                                                                                |
| `src/modules/messenger/runtime/productionRuntime.ts`   | Orchestrator. Group create/remove/rekey wrappers (:2187-2487), inbound group no_key stash + banner (:4567-4601), key-divergence stash (:4521-4565), boot key warm-up + fail-closed drain (:1138-1206). ADD the admin heal entrypoint + member-side heal-request emit + inbound heal-request handler here.                                                    |
| `src/modules/messenger/runtime/bootGroupStashDrain.ts` | Documents the current fail-closed policy ('re-seeding a truly-lost key is an owner-side resync', :18-27). Self-heal is precisely the controlled lifting of Scenario B.                                                                                                                                                                                       |
| `src/modules/messenger/store/groupMasterKeyStore.ts`   | SQLCipher-backed wrapped master-key store. getKey/loadAll return undefined on missing/GCM-fail (:120-171); setKey is the persistence sink the heal must write through after the new key commits.                                                                                                                                                             |
| `src/modules/messenger/runtime/keychain.ts`            | Key compartments. getOrCreateGroupWrapKey (separate keychain entry, :318-339), this-device-only STRICT_KEY_OPTS (:82-85) — explains why reinstall/new-phone loses the wrap key and hence every wrapped group key; hasDbKey (:169-178) distinguishes fresh-install from existing.                                                                            |
| `src/modules/messenger/backup/restoreMessages.ts`      | Existing WITH-backup recovery: restores GroupState incl. masterKeyB64 (:217-244). Self-heal complements this for the no-backup / 2nd-device case.                                                                                                                                                                                                            |
| `sqa.md`                                               | Bug log: B-18 (receiver/2nd-device missing master key, no live drain), B-35 (member outbound undecryptable / owner key divergence), B-26(a)/B-13 (owner-side resync deferred fail-closed). Confirms the gap is known and the resync is architecture-gated.                                                                                                   |

#### Proposed changes (per file)

**1. `packages/messenger-core/src/groups/groupClient.ts (+ src mirror re-export)`**

- **Change:** ADD `planHealRekey(state)`: a bare rekey to the SAME current member set — epoch E→E+1, fresh key via genFreshGroupMasterKey(), no membership change. Returns `{rekey, newMasterKeyB64}`. Optionally also expose a `makeHealReseedCreate(state, newKey)` that produces a signed `admin:'create'` carrying the EXISTING groupId+salt, the CURRENT member set, the NEW master key, and epoch E+1 — the keyless-safe delivery form.
- **Why:** There is no bare-rekey planner today; all planners bundle a membership change. Heal needs a pure key rotation. The create-style re-seed is the only existing envelope that ships the key plaintext-under-pairwise so a keyless member can open it (groupClient.ts:146-149).
- **Risk:** high — changing create/rekey semantics touches epoch + key distribution. The re-seed create MUST enforce epoch monotonicity (only accept if action.state.epoch > local epoch) or a replayed old create could roll members/epoch back. applyAdminAction `create` today trusts create unconditionally (groupClient.ts:395-408) — that must be hardened in lockstep. ARCHITECTURE SIGN-OFF REQUIRED.

**2. `packages/messenger-core/src/groups/groupClient.ts — broadcastToGroup`**

- **Change:** Extend the keyless-safe delivery: either (a) route the heal via the existing `admin:'create'` re-seed (no change to broadcastToGroup needed — create is already skipGroupKey), or (b) add an explicit `healReseed: true` flag that makes the rekey body plaintext-under-pairwise for the heal fan-out. Prefer (a) to avoid widening the wrap-skip surface.
- **Why:** A normal rekey body is groupEncrypt-wrapped under the CURRENT key (groupClient.ts:146-149), which the keyless requester does not hold — it could never decrypt its own heal. Reusing the create channel avoids new plaintext branches.
- **Risk:** high — any new plaintext-under-pairwise path is a stop-condition (sealed-sender/group-key-distribution). Must keep cert-verify + signGroupCreate + verifyGroupIdDerivation + monotonic-epoch gate. ARCHITECTURE SIGN-OFF REQUIRED.

**3. `src/modules/messenger/runtime/productionRuntime.ts — inbound group handling (~:4567-4601) + a new emit`**

- **Change:** Member-side: when a group envelope lands in `no_key` (and we believe we are/were a member, or the envelope's sender is a current member), emit ONE sealed `groupKeyRequest` control envelope to the message SENDER over the existing pairwise Signal session: `{groupId, requesterUserId, knownEpoch}`. Rate-limited per (groupId, sender) with a small cooldown + budget (reuse the firstMessageRetryBudget pattern). NEVER spammed; never broadcast.
- **Why:** After reinstall the SQLCipher DB is wiped so the member has no group state and cannot know the owner — but the inbound envelope tells it the groupId + a current member (the sender). The request is only a hint; authority stays with the admin.
- **Risk:** high — new control-message kind on the wire. Must be sealed (sender-cert verified), carry no key material, and be unforgeable. ARCHITECTURE SIGN-OFF REQUIRED.

**4. `src/modules/messenger/runtime/productionRuntime.ts — new inbound `groupKeyRequest` handler`**

- **Change:** Admin-side: on receiving a cert-verified `groupKeyRequest`, the handler runs ONLY if (i) we hold the group state, (ii) we are the admin/owner for it (members[self].admin === true, i.e. owner for user groups / room-creator for mission rooms), and (iii) the requester is a CURRENT member (isGroupMember, groupClient.ts:556-561). If so, call `healGroupKey(groupId)`. Otherwise drop SILENTLY (no membership probe, no key echo). Rate-limit per (groupId, requester) to prevent rekey-amplification DoS.
- **Why:** Closes the oracle: the admin never hands back the existing key on request — it re-keys + fans the NEW key to all VERIFIED current members. A non-member or non-admin path is a no-op. Mirrors the silent-drop discipline already used for non-admin admin actions (groupClient.ts:429-432).
- **Risk:** high — this is the 'owner-side resync' the code currently defers (bootGroupStashDrain.ts:18-27). ARCHITECTURE SIGN-OFF REQUIRED.

**5. `src/modules/messenger/runtime/productionRuntime.ts — new `healGroupKey(groupId)` runtime method`**

- **Change:** Admin entrypoint, modeled on removeGroupMember (:2340-2487) MINUS the membership change: mint fresh key (planHealRekey), ensureOutgoingSession to each current member (re-X3DH; the requester re-uploaded prekeys on reinstall via identity install), fan out the keyless-safe re-seed (create-style, signed) to ALL current members, then applyAdminAction locally + persist via the groupMasterKeyStore sink + dispose the old key from cache (same as :2472-2487). Idempotent / debounced per group.
- **Why:** Reuses the proven fan-out + local-rotate + key-dispose pattern; the only new piece is the keyless-safe delivery so the requester (and any other keyless member) can open it.
- **Risk:** high — key rotation + distribution. Must remain server-blind, monotonic-epoch, fail-closed on 0-peer delivery (keep the :2456-2462 retry+warn pattern). ARCHITECTURE SIGN-OFF REQUIRED.

**6. `src/modules/messenger/runtime/bootGroupStashDrain.ts (doc) + auto-drain reuse`**

- **Change:** No drain logic change needed: once healGroupKey commits the new key into groups[gid].masterKeyB64, the EXISTING post-rekey `drain-group` path (and boot selectGroupIdsToDrain, :1192-1200) renders the requester's stashed messages automatically. Update the Scenario-B comment to point at the new sanctioned heal path instead of 'architecture-gated, do not'.
- **Why:** The recovery rendering is already built; heal only needs to make the key arrive. Avoids a second drain mechanism.
- **Risk:** low — documentation + reuse of existing drain; behavior unchanged once the key lands.

**7. `src/modules/messenger/store/ (new small heal-rate-limit store) + groupMasterKeyStore.ts`**

- **Change:** ADD a tiny per-(groupId, requester) heal-request rate-limit/cooldown table (or in-memory budget) to bound both the member-side emit and the admin-side accept. groupMasterKeyStore.setKey already persists the rotated key — no schema change there.
- **Why:** Prevents a rekey-amplification / DoS where a malicious or flapping member forces continuous rotations (each rotation invalidates queued ciphertext for everyone briefly).
- **Risk:** medium — anti-abuse logic; get the window right so legitimate reinstalls still heal promptly.

#### Step-by-step prompts for Claude

_Hand these to Claude one at a time, in order._

> **Step 1:** Read packages/messenger-core/src/groups/groupClient.ts in full and src/modules/messenger/runtime/productionRuntime.ts lines 2187-2487 and 4480-4610. Confirm: (a) `skipGroupKey` is true ONLY for admin:'create' (groupClient.ts:146-149); (b) applyAdminAction 'create' does NOT enforce epoch monotonicity (groupClient.ts:395-408); (c) there is no bare-rekey planner. Write a one-paragraph design note stating the chicken-and-egg (a rekey body is wrapped under the current key the keyless member lacks) and that the heal must reuse the create-style plaintext-under-pairwise channel. DO NOT CODE YET.

> **Step 2:** [ARCHITECTURE SIGN-OFF REQUIRED] Draft the heal protocol spec for the System Architecture Documentation: (1) trigger = member-side sealed `groupKeyRequest` to the inbound message's sender; (2) admin = members[self].admin (owner for user groups, room-creator for mission/ops rooms); (3) admin verifies cert + requester∈current members + rate-limit, then mints a FRESH key (epoch E→E+1) and redistributes via a SIGNED create-style re-seed to ALL current members; (4) the admin NEVER echoes the existing key on request (no oracle); (5) re-seed create MUST be accepted only when action.state.epoch > local epoch (monotonic). Get sign-off before implementation.

> **Step 3:** In packages/messenger-core/src/groups/groupClient.ts add `planHealRekey(state)` (bare rekey, same member set, fresh genFreshGroupMasterKey(), epoch+1) and `makeHealReseedCreate(state, newMasterKeyB64)` (signed admin:'create' carrying existing groupId+saltB64, current members, NEW key, epoch+1). Re-export both from src/modules/messenger/groups/groupClient.ts. Harden applyAdminAction 'create' to reject when action.state.epoch <= state.epoch for an EXISTING group (monotonic re-seed guard) — keep first-ever create (no local state) accepted. Add unit tests in __tests__ for planHealRekey convergence, monotonic-reseed reject, and groupClientMirror reference-equality.

> **Step 4:** In src/modules/messenger/runtime/productionRuntime.ts add a `healGroupKey(groupId)` method modeled on removeGroupMember (:2340-2487) but with NO membership change: assert self is admin, ensureOutgoingSession to every current member, fan out makeHealReseedCreate via broadcastToGroup, then applyAdminAction locally, persist through the groupMasterKeyStore sink, dispose the old key from cache (mirror :2472-2487), keep the 0-peer retry+warn (mirror :2456-2462). Debounce per group. Add a test that a heal fan-out delivers the new key to a keyless member fixture and that the old key is disposed.

> **Step 5:** In src/modules/messenger/runtime/productionRuntime.ts inbound handling: in the `no_key` branch (~:4567-4601), after stashing, emit ONE sealed `groupKeyRequest` {groupId, requesterUserId, knownEpoch} to the envelope SENDER over the pairwise Signal session, gated by a per-(groupId,sender) cooldown/budget (reuse firstMessageRetryBudget). Keep the existing stash + banner. Add a test that a no_key inbound emits exactly one request and respects the cooldown.

> **Step 6:** In src/modules/messenger/runtime/productionRuntime.ts add an inbound `groupKeyRequest` handler: cert-verify (already done upstream), then require we hold the group + members[self].admin===true + isGroupMember(state, requester); on pass call healGroupKey(groupId) (rate-limited per requester); else drop SILENTLY. Add tests: non-admin recipient = no-op; non-member requester = no-op + no key echo; valid request from a current member = exactly one heal rotation; repeated requests within the window = single rotation.

> **Step 7:** Update src/modules/messenger/runtime/bootGroupStashDrain.ts comment (Scenario B) to reference the sanctioned heal path. Confirm via test that once healGroupKey commits the key, the existing drain (selectGroupIdsToDrain / post-rekey drain-group) renders the previously-stashed messages — no new drain code.

> **Step 8:** Run gates: `npm run test:crypto` (group + sealed-sender regression), the new targeted tests, `npm run typecheck` (must stay ≤ baseline 96 / mobile 49), `npm run lint`, and the logAudit test (no key material logged). Then a 3-device manual smoke: reinstall on device B (no backup), have device A (admin) send to the group, confirm B sends a heal-request, A re-keys behind the scenes, and B's stashed + new messages render — while a removed/non-member device gets nothing.

#### ⚠️ Regressions this could introduce

- Rekey-amplification / DoS: a flapping or malicious member spamming groupKeyRequest could force continuous key rotations, each briefly invalidating queued ciphertext for the whole group. Mitigate with the per-(groupId,requester) rate-limit + debounce in healGroupKey.
- Oracle leak: if the admin handler ever echoes the EXISTING key (instead of always minting a fresh one) or skips the isGroupMember/admin checks, a removed member could re-obtain access. The design forbids echo and requires verified current membership — must not regress.
- Monotonic-epoch rollback: the create-style re-seed overwrites GroupState; without the new `action.state.epoch > local epoch` guard a replayed OLD re-seed could roll back membership/epoch (applyAdminAction create currently trusts create, groupClient.ts:395-408).
- Transcript-hash divergence: re-seeding via create reseeds transcriptHash from scratch (groupClient.ts:406-407) while existing members were on a chained hash — members could diverge on the P1-G1 transcript check. Must define the post-heal transcript baseline so all members converge.
- Mirror drift: new primitives added to the package but not re-exported from src/modules/messenger/groups/groupClient.ts will fail the groupClientMirror reference-equality test (the file is a thin re-export, src groupClient.ts:17-36).
- Wrong-admin for mission/ops rooms: for auto-dispatch rooms the 'admin' is the agency room-creator (creator_user_id), not SYSTEM and not a CPO — misidentifying admin would either fail to heal or let the wrong party rotate. Must branch admin selection by group type.
- 0-peer heal silently lost: if the heal fan-out reaches no peers it must stay fail-closed with retry+warn (mirror :2456-2462), not silently mark healed.

#### Tests / verification

- packages/messenger-core/__tests__: planHealRekey produces epoch+1 + fresh key, same member set; makeHealReseedCreate is signed and verifies via verifyGroupCreateSignature + verifyGroupIdDerivation.
- applyAdminAction monotonic re-seed: a create with epoch <= local epoch on an EXISTING group is rejected (state unchanged); first-ever create still accepted.
- groupClientMirror reference-equality test still passes after adding + re-exporting the new primitives.
- productionRuntime: a no_key inbound emits exactly ONE sealed groupKeyRequest to the sender and respects the cooldown (no spam).
- productionRuntime: groupKeyRequest from a non-admin recipient = no-op; from a non-member requester = no-op AND no key on the wire; from a current member to the admin = exactly one heal rotation; duplicate requests within the window = single rotation.
- End-to-end fixture: keyless member receives the heal re-seed (plaintext-under-pairwise), commits the new key, and the existing drain renders both the previously-stashed and new messages; the old key is disposed from cache.
- Regression: npm run test:crypto (group master-key, sealed-sender, rekey-on-remove) green; logAudit test green (no key/plaintext logged); typecheck ≤ baseline.
- Removed-member negative: after a heal, a previously-removed member cannot decrypt the new key (forward secrecy preserved).

#### Open questions

- Trigger target: the keyless reinstalled member has NO group state, so it cannot know the owner — should the groupKeyRequest go to the inbound message's SENDER (who may be a non-admin member that must then forward to the admin), or should non-admin recipients forward/notify the admin? Forwarding adds a hop and complexity; sending only to the sender may not reach the admin if the sender isn't admin.
- Admin presence vs member request: requirement says 'from the admin, behind the scenes' — should heal also fire proactively when the admin merely detects a member's outbound is undecryptable (B-35), or strictly on a member-initiated request? Proactive detection needs a member/device list the backend does not expose today (B-18 notes 'needs backend device-list API').
- Re-seed vs per-recipient wrap: prefer reusing the create channel (plaintext-under-pairwise for everyone) vs adding a per-recipient wrap-skip only for keyless members? Create is simpler but rotates the key for ALL members on every heal (more churn).
- Transcript-hash baseline after a re-seed create: how do all members converge their P1-G1 transcriptHash post-heal so a later add/remove doesn't diverge?
- Mission/ops room admin: confirm the agency room-creator (creator_user_id, Step 12/13) is the authoritative healer and that CPOs/SYSTEM are never healers; define behavior when the agency device is offline.
- Backup interplay: should the member attempt a backup-restore (which already restores GroupState, restoreMessages.ts:217-244) BEFORE requesting a heal, to avoid an unnecessary global rekey when the key is recoverable locally?
- Rate-limit window: what cooldown/budget balances prompt healing for legitimate reinstalls against rekey-amplification abuse?

### A3: 🔒 Crypto-guard verdict (adversarial security review)

**Verdict:** CONDITIONAL PASS — both specs are designed within the locked contract and neither makes the server hold a key, relays plaintext, nor adds a dev/skip-verify branch. The keyless-safe delivery in both reuses the existing `admin:'create'` plaintext-under-PAIRWISE-Signal channel (broadcastToGroup groupClient.ts:146-149), so the relay still only sees sealed ciphertext. HOWEVER, neither spec is safe to implement as written. Three hard blockers must be closed IN THE SAME CHANGE, not after: (1) `applyAdminAction('create')` (groupClient.ts:395-408) today accepts any signature-valid create with NO epoch-monotonicity check — the moment heal makes signed creates a routine, repeated operation carrying incrementing epochs, an attacker (or the relay, which holds <=30d of envelopes) can REPLAY an older signed create to roll back epoch/master-key/membership, and because a create envelope lists members, a replayed old create RE-ADMITS a since-removed member and re-arms them with a key they may still hold. This is the exact removed-member-reinstall re-admit hole the review must block. (2) Spec A heals by RE-SENDING THE EXISTING key (no rotation) — it is closer to a 'give me the current key' redelivery than a rekey; it is only saved by broadcastToGroup being membership-scoped, and it cannot repair same-epoch key divergence (B-35/B-15b) and re-arms removed members on any momentary membership desync. Same-epoch divergence and lost-key cases MUST route through Spec B's true REKEY (epoch++ fresh key), not Spec A's same-key re-broadcast. (3) Spec B's create-style re-seed reseeds transcriptHash from scratch (extendTranscript(undefined) at groupClient.ts:407) for the healed member while existing members chained from genesis — transcripts permanently FORK, defeating the P1-G1 tamper-detection chain on the next shared add/remove. A converging post-heal transcript baseline must be defined and applied identically by ALL members. With the monotonic-create guard, isGroupMember+admin authority gate bound to the VERIFIED CERT sender (never the self-asserted requesterUserId), a global per-group rekey debounce, group-type-correct admin selection, and a defined transcript baseline — all under architecture sign-off — the design respects the contract. Without them it opens a rollback/re-admit oracle and a rekey-amplification DoS.

#### Security violations / risks to fix before implementing

| Severity | Claim reviewed                                                                                                                                                                                                                                       | Why it is a problem                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| critical | Spec B reuses the admin:'create' re-seed to deliver the healed key, but relies on applyAdminAction('create') which has NO epoch-monotonicity guard (groupClient.ts:395-408 accepts any sig-valid + groupId-derivation-valid create).                 | Once heal makes signed creates routine and incrementing, a replayed OLD signed create (still on the relay <=30d, or captured) rolls the group BACK to an earlier epoch/master-key/member-set. Because the create body enumerates members, replaying a pre-removal create RE-ADMITS a removed member and re-installs the old key they retained — directly violating rekey-on-removal + epoch monotonicity. The spec's own monotonic guard (accept create only if action.state.epoch > local epoch, with first-ever-create exception) is MANDATORY and must land in the same commit.                                                                     |
| high     | Spec A 'owner-mediated key request' answers by re-running ensureCallGroupKey's owner re-broadcast (productionRuntime.ts:2701-2735), which re-sends the EXISTING master key at the SAME epoch — no rotation.                                         | This is a same-key redelivery on demand, the weakest form the contract warns against. It does not rekey, so (a) it cannot repair same-epoch key divergence (B-35 owner-divergence, B-15b minted-fresh-DB-key) — and worse, under the required monotonic-create guard a same-epoch re-broadcast is REJECTED by members who already hold epoch E, so it heals nothing for them; and (b) if the owner's local membership is even momentarily stale (remove not yet applied) the re-broadcast re-arms a removed member with the CURRENT key. Lost-key and divergence cases must be routed to Spec B's true REKEY heal, not Spec A's same-key re-broadcast. |
| high     | Spec B's create-style re-seed reseeds transcriptHash from scratch for the healed member (extendTranscript(undefined, action), groupClient.ts:407) while other members keep their chained hash.                                                       | The P1-G1 transcript chain is a tamper-detection mechanism; a healed member ending on H(create@E+1) while peers are on a genesis-chained hash makes the two diverge permanently and the next shared add/remove fails the transcript check (or silently masks a real tamper). The heal must define a single converging post-heal transcript baseline that EVERY current member applies identically, or it weakens the integrity invariant.                                                                                                                                                                                                               |
| high     | Both specs gate the admin/owner response on the requester being a current member but the request envelope carries a self-asserted requesterUserId; the specs say 'cert-verify already done upstream' without binding requester identity to the cert. | If the admin authorizes off the self-asserted requesterUserId rather than the VERIFIED sender-cert identity, a member could request a heal naming a different/removed user, or a spoofer could probe membership. Authority MUST be the verified sender-cert userId; isGroupMember/admin checks must run against that, and a self-asserted field must never be trusted.                                                                                                                                                                                                                                                                                  |
| high     | Each heal rotates the master key for ALL current members; the no_key/tamper inbound path can fire heal-requests, and the codebase already labels auto-rekey-on-failure 'abusable as a rekey-amplification vector' (productionRuntime.ts:4552-4554).  | A flapping or malicious member spamming groupKeyRequest forces continuous global rotations, each invalidating in-flight ciphertext for everyone (DoS). Spec B's per-(group,requester) cooldown is necessary but insufficient: a GLOBAL per-group rekey debounce that coalesces multiple keyless requesters into one rotation is required, plus the member-side emit must be a single rate-limited request, never a broadcast/retry-loop.                                                                                                                                                                                                                |
| medium   | For mission/ops rooms the 'admin/healer' is the agency room-creator (creator_user_id), never SYSTEM or a CPO; the specs note this but do not enforce admin-selection by group type.                                                                  | Misidentifying the healer for a SYSTEM/agency room either fails to heal or lets the wrong party rotate the room key. The heal must branch admin selection by group type and must NOT fire for SYSTEM-owned rooms; a CPO must never become the healer.                                                                                                                                                                                                                                                                                                                                                                                                   |

#### Invariants the implementation MUST preserve

- Server/relay key-blindness: the heal request carries conversationId/groupId ONLY (zero key bytes); the new key is delivered exclusively plaintext-under-PAIRWISE-Signal via the create channel (broadcastToGroup groupClient.ts:147-149) so the relay sees only sealed ciphertext; the key never enters HTTP relay payloads, push/FCM data (stays opaque per B-14), or any server-readable field.
- Epoch monotonicity: applyAdminAction must NEVER lower or repeat an epoch on an EXISTING group; the heal rekey advances E->E+1 with a fresh genFreshGroupMasterKey, and create re-seed is accepted only when action.state.epoch > local epoch (first-ever create, no local state, still accepted).
- No key-recovery oracle: the admin NEVER echoes the existing master key in response to a request; it ALWAYS mints a fresh key and fans it only to currently-authorized, isGroupMember-verified members; a non-member or non-admin request is a SILENT no-op with zero key on the wire and no observable membership signal.
- Sender-cert verification + create-signature verification stay mandatory: requester authority = verified sender-cert userId (never the self-asserted requesterUserId); the heal create is verified via verifyGroupCreateSignature (binds groupId+members+masterKey+epoch, groupClient.ts:885-896) AND verifyGroupIdDerivation before install; no skip-in-dev branch.
- Rekey-on-removal forward secrecy: a removed member who reinstalls MUST NOT be re-admitted — the heal re-keys to the CURRENT member set only, and the monotonic-create guard blocks replay of a pre-removal create that would re-list them; the fresh key is not derivable by a non-member.
- Fail-closed media: the call still produces NO media without FrameCryptor + a valid group key; the key-wait extension is a single bounded request with a hard timeout, never an unbounded retry, and never a plaintext-on-SFU fallback.
- Transcript-chain integrity (P1-G1): post-heal all current members converge on one identical transcriptHash baseline; the heal must not silently fork the chain.
- AAD binding preserved: heal envelopes keep the per-recipient sealPayload AAD (to/ts/sender/conversationId/groupId/epoch, groupClient.ts:189-205); epoch is stamped for the post-heal value so stale-epoch replays are rejected.
- Log-audit: heal diagnostics emit only SHA-256 key fingerprints, never key bytes/plaintext (logAudit.test.ts must stay green).

#### Required design adjustments (do these)

- MERGE the two specs' delivery models: route ALL true-lost-key and same-epoch-divergence (B-35/B-15b) heals through Spec B's REKEY (epoch++ fresh key). Restrict Spec A's same-key owner re-broadcast to the narrow call case where the recipient is a CURRENT member who merely missed the original fan-out and has NO local state at that epoch — under the monotonic-create guard a member already at epoch E ignores it, which is correct.
- Ship the applyAdminAction('create') epoch-monotonicity guard IN THE SAME COMMIT as any heal create: reject when local state exists and action.state.epoch <= local epoch; accept first-ever create (no local state). This single guard closes both the rollback and the removed-member re-admit replay. Add a direct test replaying an old signed create and asserting rejection.
- Bind requester authority to the verified sender cert, not the wire field: the admin handler computes requester = cert.senderUserId, then requires self holds state AND members[self].admin===true AND isGroupMember(state, certSenderUserId); otherwise silent no-op (mirror the non-admin silent-drop at groupClient.ts:429-432). Apply the SAME isGroupMember gate to Spec A's owner response so a non-member request triggers neither a fan-out nor any observable traffic.
- Add a GLOBAL per-group rekey debounce in addition to per-(group,requester) cooldown: coalesce concurrent keyless requesters into a SINGLE rotation, cap rotations/interval, so a flapping member cannot drive continuous global rekeys (anti-amplification). The member-side emit fires exactly one sealed request per cooldown window — never a broadcast or retry loop.
- Define the converging post-heal transcript baseline: have every current member apply the heal as the SAME deterministic action so all transcriptHash values match afterward (e.g. a dedicated heal action type, or all members re-seed from the same create bytes). Add a multi-member fixture asserting identical transcriptHash post-heal and that a subsequent add/remove still chains cleanly.
- Branch healer selection by group type: user group => owner; mission/ops room => agency creator_user_id (Step 12/13); SYSTEM-owned rooms => heal disabled. The handler must reject/no-op if self is not the type-correct admin, and a CPO must never heal.
- Attempt local backup-restore (restoreMessages.ts:217-244 already restores masterKeyB64) BEFORE emitting a heal request, so a recoverable key never triggers an unnecessary global rotation — reduces churn and DoS surface.
- Keep the call fix's launchCall members-fallback (groups[].members) strictly membership-correct: mirror otherMembers() self/ownId filtering + dedupe so it cannot ring a since-removed member or self; this is ring-list only and must not touch the fail-closed media key gate.
- Make heal diagnostics fingerprint-only (reuse the existing keydiag SHA-256), tag which gate fired, and run them past logAudit.test.ts; any wake/push for an offline admin must carry only {eventId,eventClass} (B-14), never key or group plaintext.
- Handle the reinstalled-member identity re-pin explicitly: when the keyless member re-runs X3DH it re-pins the admin's identity key; do not silently auto-accept an admin identity-key CHANGE — surface a safety-number change per the existing TOFU policy (architecture-gated).

#### Changes that need architecture sign-off

- Spec A: new pairwise 'group-key-request' control envelope + the owner-mediated key-redelivery handler in ensureCallGroupKey — any new message type in the group-key-distribution path is a CLAUDE.md stop-condition (security_gated=true).
- Spec A: joiner key-wait timeout firing a key-request + bounded wait extension (useGroupCall.ts:1208-1213) — changes the fail-closed window timing in the call key-distribution gate.
- Spec B: planHealRekey + makeHealReseedCreate (new bare-rekey planner and create-style re-seed carrying a NEW key at epoch E+1) — alters create/rekey distribution semantics.
- Spec B: hardening applyAdminAction('create') with an epoch-monotonicity guard (reject create when action.state.epoch <= local epoch for an existing group; keep first-ever create) — touches epoch monotonicity, a locked invariant, and MUST ship in lockstep with the heal.
- Spec B: member-side sealed groupKeyRequest emit on the no_key inbound branch (productionRuntime.ts:4567-4601) — new control-message kind on the wire.
- Spec B: admin-side groupKeyRequest handler + healGroupKey(groupId) runtime entrypoint — this is precisely the 'owner-side resync' the code defers as architecture-gated (bootGroupStashDrain.ts:18-27, B-26(a)/B-13).
- Definition of the converging post-heal transcriptHash baseline applied by all members (P1-G1 chain).
- Admin-selection-by-group-type rule for who may heal (user group = owner; mission/ops room = agency creator_user_id; SYSTEM rooms = no heal).
- Identity-key re-pin policy when a reinstalled keyless member (or a reinstalled admin) re-runs X3DH before accepting a heal create — safety-number change handling.

#### Required sign-offs

- System Architecture Documentation owner — group-master-key distribution change (heal request channel + admin heal entrypoint + keyless-safe re-seed): both specs are security_gated=true and touch a CLAUDE.md stop-condition.
- Architecture sign-off specifically on the applyAdminAction('create') epoch-monotonicity hardening (epoch is a locked invariant; the change is mandatory but must be reviewed for interop with legacy salt-absent creates).
- Architecture sign-off on the new sealed control-message kind 'groupKeyRequest' (must be sealed-sender, cert-verified, carry no key material, be unforgeable, and not be a membership probe).
- Mission/ops-room owner sign-off that the agency room-creator (creator_user_id) is the authoritative healer and CPO/SYSTEM are never healers (Step 12/13 semantics).
- Finance/ops gating is N/A here, but B-14 push-opacity owner sign-off if any heal triggers a wake (push must stay opaque {eventId,eventClass}, no key, no group plaintext).

---

# Addendum B — iOS group calls (cross-platform parity)

> **Added 2026-06-25** (decision reversal: iOS group calls are now IN SCOPE). Investigation: 3-agent workflow (iOS media-crypto + iOS signalling/CallKit + adversarial feasibility). **Security-locked (call media E2EE must stay fail-closed on iOS too).**

**TL;DR:** Feasible, but it is a real native-engineering epic, **not a config toggle**. Everything *above* the native bridge is already cross-platform (JS key orchestration, epoch/rekey, SFU, WS signalling). The single deep blocker is that the **call-media encryption primitive (FrameCryptor) exists only as Android-native code** — it rides on an Android-only `patch-package` swap to `io.getstream:stream-webrtc-android` plus a Kotlin module. iOS uses the stock `JitsiWebRTC` pod, which ships **no FrameCryptor binding**, and there is no iOS-native Bravo cryptor. Because the design is correctly fail-closed, iOS gets *no* group call rather than an insecure one. Separately, the app **does not build for iOS yet** (managed Expo, no committed `ios/`, missing `GoogleService-Info.plist`), and **background ringing needs PushKit/CallKit + an Apple VoIP cert** (currently a gated-off skeleton). **1:1 calls already work cross-platform** (P2P DTLS-SRTP) and need no media-crypto work. See the feasibility verdict (B3) for effort and the recommended path.

### B1: IOS-GROUP-CALL-MEDIA — Enable iOS group calls: iOS FrameCryptor media-E2EE native module + libwebrtc pod swap + VoIP/CallKit + build prereqs (fail-closed preserved) 🔒 (architecture sign-off required)

**Covers your requests:**

- Group calls must work on BOTH iOS and Android (currently Android-only).
- Group-call media E2EE (FrameCryptor/sframe AES-256-GCM over the mediasoup SFU) must run on iOS and stay FAIL-CLOSED: no media if the per-participant key/cryptor is absent (no plaintext-on-SFU fallback).
- Server (apps/messenger-service/src/sfu) must remain KEY-BLIND — the iOS path must derive/hold keys on-device only, like Android.
- VoIP push payloads for iOS (PushKit/APNs) must stay OPAQUE — no caller identity/plaintext/ids that leak; HMAC-signed wake only.
- Sender-cert / call-offer auth and the libsignal group-master-key distribution must remain unchanged — reuse the existing key source.
- 1:1 calls already work cross-platform (P2P, DTLS-SRTP); the change is scoped to GROUP-call media crypto + iOS build/VoIP enablement, not the 1:1 path.

#### Root cause / gap analysis

"iOS group calls don't work for ONE structural reason: the call-media E2EE primitive (FrameCryptor AES-256-GCM, mandated by docs/ARCHITECTURE_AMENDMENT_SFRAME.md to sit on top of SRTP because the mediasoup SFU terminates DTLS-SRTP and would otherwise see plaintext) exists ONLY as Android-native code. It depends on (1) a libwebrtc build that exposes `org.webrtc.FrameCryptor` — supplied on Android by swapping Jitsi for `io.getstream:stream-webrtc-android` via patch-package — and (2) the Kotlin `BravoFrameCryptorModule`. The iOS react-native-webrtc pod uses stock `JitsiWebRTC ~> 124` which ships no FrameCryptor binding, and there is no iOS-native Bravo cryptor module. Because the design is correctly FAIL-CLOSED, `frameCryptorTransport.isAvailable()` returns false on iOS (an explicit `Platform.OS !== 'android'` guard, frameCryptorTransport.ts:64) and `useGroupCall` refuses to start the call (useGroupCall.ts:1090) — so iOS gets no group call rather than an insecure one. Everything ABOVE the native bridge (key derivation `deriveParticipantKey`, epoch/rekey orchestration, the SFU signalling, the messenger-service SFU itself) is already platform-agnostic. What is genuinely iOS-only-missing for GROUP calls is therefore narrow but deep-native: (a) an iOS libwebrtc pod that ships `RTCFrameCryptor`/`RTCFrameCryptorKeyProvider` (e.g. the LiveKit/Stream `stream-webrtc-ios` WebRTC-SDK pod, replacing JitsiWebRTC), (b) an Objective-C/Swift `BravoFrameCryptor` native module mirroring the Kotlin one (createKeyProvider/setKey/ratchetKey/attachSender|ReceiverCryptor/setEnabled/setKeyIndex/dispose + isAvailable), exposing RtpSender/Receiver lookup the same way the rn-webrtc iOS patch must expose them, and (c) flipping the `Platform.OS` gate to permit iOS once (b) is wired. Separately (NOT required for an in-app/foreground group call, but required for parity with Android background ringing): iOS VoIP via PushKit/CallKit is a skeleton that needs an Apple VoIP cert + a PushKit dep + server APNs. And the app simply does not build for iOS yet (managed Expo, no prebuild, missing GoogleService-Info.plist + a few Info.plist/plugin entries)."

#### Current behavior (as built)

"This is a managed-Expo app (no committed `ios/` dir; `expo prebuild --platform ios` is required — `android/` IS prebuilt and checked in). Group-call media E2EE is ANDROID-ONLY by construction.\n\nCODE: The JS crypto orchestration is platform-agnostic UNTIL the native bridge. `frameCryptorTransport.ts:39-71` imports `NativeModules.BravoFrameCryptor` (line 60) and `isAvailable()` HARD-GATES to Android: `if (Platform.OS !== 'android') {return false;}` (frameCryptorTransport.ts:64). The header comment (lines 44-45) states verbatim: 'iOS is not implemented in this round; on iOS isAvailable() returns false and useGroupCall refuses.' `FrameCryptorOrchestrator` throws in its constructor when unavailable (frameCryptorOrchestrator.ts:90-95, fail-closed), and the group-call hook refuses to start at boot step=3: `if (!frameCryptorOrchestratorAvailable()) { ... refusing to start unencrypted group call (S6) }` (useGroupCall.ts:1090-1091). So on iOS today, a group call cannot start at all.\n\nNATIVE/POD: The whole FrameCryptor capability rides on an Android-only patch. `patches/react-native-webrtc+124.0.7.patch` is 89 diffs, 100% under `node_modules/react-native-webrtc/android/` (mostly committed build artifacts). The load-bearing edits are: (a) `android/build.gradle` swaps `api 'org.jitsi:webrtc:124.+'` → `api 'io.getstream:stream-webrtc-android:1.3.10'` because the Stream build ships `org.webrtc.FrameCryptor/FrameCryptorFactory/FrameCryptorKeyProvider` (Jitsi 124 does not); (b) `PeerConnectionObserver.java` makes `getSender`/`getReceiver` public; (c) `WebRTCModule.java` adds `getRtpSenderById/getRtpReceiverById/getPeerConnectionFactory`. These are consumed by the app-side Kotlin module `android/app/src/main/java/com/bravosecure/app/BravoFrameCryptorModule.kt` (+ `BravoFrameCryptorPackage.kt`). `patches/react-native-callkeep+4.3.16.patch` is likewise Android-only (`RNCallKeepModule.java`). The iOS pod is stock: `node_modules/react-native-webrtc/react-native-webrtc.podspec` declares `s.dependency 'JitsiWebRTC', '~> 124.0.0'`, and there are zero FrameCryptor symbols under `node_modules/react-native-webrtc/ios/`. There is NO `ios/` BravoFrameCryptor module (no .swift/.mm in the repo).\n\n1:1 CALLS: The 1:1 path (`useCall.ts`, `callController.ts`, `peerConnection.ts`) has NO frameCryptor/sframe/SFU references — 1:1 is peer-to-peer, so DTLS-SRTP is already end-to-end (TURN only relays SRTP). 1:1 therefore needs no media-crypto work on iOS; it should function once the iOS app simply builds.\n\nVoIP/BACKGROUND CALLS: iOS PushKit/CallKit is a documented SKELETON, gated OFF. `callKitBridge.ts:66` `const IOS_RUNTIME_ENABLED = false;` and `isBridgeActive()` returns false on iOS until that flips (callKitBridge.ts:74-78). `voipPush.ts` no-ops on iOS (lines 53-64), `require('react-native-voip-push-notification')` which is NOT a dependency in package.json. Pending hard prereqs (callKitBridge.ts:19-28): Apple VoIP Services Certificate, PushKit token registration, server APNs HTTP/2 env. The signed wake fields are opaque-ish (callId UUID + nonce + exp + sig, voipPush.ts:158-168) but the inbound handler currently passes `notif.callerName` to CallKit (voipPush.ts:139-143) — enabling iOS must ensure the APNs payload carries NO plaintext caller identity.\n\nBUILD CONFIG (app.json ios): bundleIdentifier `com.bravosecure.app`, `aps-environment: production`, `UIBackgroundModes: [voip, audio, remote-notification]`, NSMicrophoneUsageDescription + NSCameraUsageDescription present, deploymentTarget 15.1 (expo-build-properties), config plugins for `@config-plugins/react-native-webrtc` and `@config-plugins/react-native-callkeep` present. MISSING: `googleServicesFile` (no GoogleService-Info.plist; @react-native-firebase will fail iOS build), `NSPhotoLibraryUsageDescription`, `location` in UIBackgroundModes, iOS config plugins for `@stripe/stripe-react-native` (dep at package.json) and `react-native-permissions` (dep). eas.json has iOS simulator profiles (`preview-staging`, `preview-staging-device`) and `eas:build:ios:*` scripts exist, but there is no iOS production/submit profile or Apple credentials wired. sqa.md section 15 ('iOS Build Status: NOT BUILDABLE') and line 736 independently confirm all of the above."

#### Key files

| File                                                                         | Role                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/messenger/webrtc/frameCryptorTransport.ts`                    | JS bridge to native FrameCryptor; line 64 hard-gates to Android (`Platform.OS !== 'android'` → isAvailable false); line 60 resolves NativeModules.BravoFrameCryptor; this is THE platform switch to extend for iOS |
| `src/modules/messenger/webrtc/frameCryptorOrchestrator.ts`                 | Platform-agnostic JS: key-provider lifecycle, deriveParticipantKey, epoch/rekey, attach sender/receiver. Fail-closed constructor (lines 90-95). Reusable as-is on iOS once the transport reports available            |
| `src/modules/messenger/webrtc/useGroupCall.ts`                             | Group-call hook; boot step=3 refuses when frameCryptorOrchestratorAvailable() is false (lines 1090-1091). Attaches cryptors to producers/consumers                                                                    |
| `patches/react-native-webrtc+124.0.7.patch`                                | Android-only (89 diffs, all under android/). Swaps Jitsi→Stream libwebrtc for FrameCryptor + exposes RtpSender/Receiver/factory accessors. NO iOS equivalent exists — an iOS analogue is required                   |
| `node_modules/react-native-webrtc/react-native-webrtc.podspec`             | iOS pod depends on`JitsiWebRTC ~> 124.0.0` which ships NO FrameCryptor. Must be swapped to a WebRTC-SDK pod that exposes RTCFrameCryptor (stream-webrtc-ios / LiveKit)                                              |
| `android/app/src/main/java/com/bravosecure/app/BravoFrameCryptorModule.kt` | Reference Android-native cryptor module (+ BravoFrameCryptorPackage.kt). The iOS Obj-C/Swift module must mirror its method surface exactly                                                                            |
| `src/modules/messenger/push/callKitBridge.ts`                              | CallKit/Telecom bridge. iOS gated by`IOS_RUNTIME_ENABLED = false` (line 66). Needed only for background ringing parity                                                                                              |
| `src/modules/messenger/push/voipPush.ts`                                   | iOS PushKit skeleton (no-op until cert + dep land). Opacity check point: must not put caller identity in the APNs payload (lines 139-143, 158-168)                                                                    |
| `app.json`                                                                 | Expo iOS config: bundleId/entitlements/infoPlist/plugins. Missing googleServicesFile, NSPhotoLibraryUsageDescription,`location` background mode, stripe + permissions iOS plugins                                   |
| `eas.json`                                                                 | iOS simulator build profiles + scripts exist; no iOS production/submit/credentials profile                                                                                                                            |
| `sqa.md`                                                                   | Section 15 'iOS Build Status: NOT BUILDABLE' + line 736 — independent confirmation of every gap                                                                                                                      |
| `docs/architecture/ (ARCHITECTURE_AMENDMENT_SFRAME.md, referenced)`        | The architecture amendment that mandates FrameCryptor frame-level E2E over SRTP; the contract any iOS crypto change must be signed off against                                                                        |

#### Proposed changes (per file)

**1. `node_modules/react-native-webrtc/react-native-webrtc.podspec (via a new patches/ entry or @config-plugins override)`**

- **Change:** NATIVE/POD: Replace the iOS WebRTC pod dependency `JitsiWebRTC ~> 124.0.0` with a libwebrtc build that ships RTCFrameCryptor/RTCFrameCryptorKeyProvider (e.g. `stream-webrtc-ios` / LiveKit WebRTC-SDK), mirroring the Android Jitsi→Stream swap. Add an iOS hunk to patches/react-native-webrtc+124.0.7.patch (or a config plugin) exposing RTCRtpSender/RTCRtpReceiver-by-id + the PeerConnectionFactory to the Bravo native module, symmetric to the Android WebRTCModule.java patch.
- **Why:** FrameCryptor symbols simply do not exist in the stock JitsiWebRTC iOS pod; the SFU sees plaintext without it. Must match the Android cipher (AES-256-GCM, same key index/epoch scheme) so cross-platform calls interop.
- **Risk:** HIGH — crypto-primitive-bearing dependency swap on a new platform; pod version/ABI drift; must verify the iOS WebRTC-SDK FrameCryptor is wire-compatible with the Android Stream 1.3.10 FrameCryptor (same SFrame/GCM framing) or A↔iOS calls won't decrypt. Architecture sign-off required.

**2. `ios/ (new) BravoFrameCryptor module — Obj-C/Swift, created via an expo config plugin`**

- **Change:** NATIVE/POD: Implement the iOS-native `BravoFrameCryptor` module mirroring BravoFrameCryptorModule.kt method-for-method: isAvailable, createKeyProvider(ratchetWindowSize, failureTolerance, keyRingSize), setKey, ratchetKey, attachSenderCryptor(pcId, senderId, participantId), attachReceiverCryptor, setCryptorEnabled, setCryptorKeyIndex, disposeCryptor, disposeKeyProvider — driving RTCFrameCryptor/RTCFrameCryptorKeyProvider. Since there is no committed ios/ dir, ship it as an Expo config plugin (adds the source + registers the module) so `expo prebuild` regenerates it.
- **Why:** This is the single missing native piece. Keeping the exact method surface means frameCryptorTransport.ts only needs the platform gate relaxed — zero changes to the JS orchestrator/hook.
- **Risk:** HIGH — new native crypto module; key material crosses the JS bridge (must never be logged — logAudit test); incorrect key-index/epoch mapping silently breaks decryption. Architecture sign-off required.

**3. `src/modules/messenger/webrtc/frameCryptorTransport.ts`**

- **Change:** CODE: Relax the line-64 gate from `Platform.OS !== 'android'` to allow iOS ONLY when `NativeModules.BravoFrameCryptor?.isAvailable()` is truthy (i.e. `if (Platform.OS !== 'android' && Platform.OS !== 'ios') return false;` then rely on the existing Native-null + try/catch checks). Update the lines 44-45 comment.
- **Why:** Once the iOS native module exists, the JS only needs to stop short-circuiting iOS. The existing `!Native` and try/catch around `Native.isAvailable()` already keep it fail-closed if the module is absent/broken.
- **Risk:** MEDIUM — this is the fail-closed boundary. If relaxed BEFORE the iOS native module truly encrypts, iOS could start a group call that is NOT E2E over the SFU. Must be the LAST change, gated behind a verified native isAvailable(). Security_gated.

**4. `app.json`**

- **Change:** BUILD: Add iOS `googleServicesFile: ./GoogleService-Info.plist` (and commit the plist or inject via EAS secret); add `NSPhotoLibraryUsageDescription`; add `location` to ios.infoPlist.UIBackgroundModes (voip/audio already present); add iOS config plugins for `@stripe/stripe-react-native` and `react-native-permissions`; consider `aps-environment: development` for non-prod profiles.
- **Why:** Without GoogleService-Info.plist the @react-native-firebase iOS build fails outright; the missing Info.plist strings/plugins cause runtime permission crashes or App Store rejection.
- **Risk:** LOW–MEDIUM — config only, but a wrong bundleId/entitlement mismatch breaks signing; aps-environment change interacts with VoIP cert.

**5. `package.json + src/modules/messenger/push/voipPush.ts + callKitBridge.ts`**

- **Change:** BUILD/CODE (parity, not strictly required for foreground group calls): Add `react-native-voip-push-notification` dependency; provision the Apple VoIP Services Certificate + APNs HTTP/2 env on messenger-service; flip `IOS_RUNTIME_ENABLED` to true (callKitBridge.ts:66) ONLY after a TestFlight smoke; ensure the server APNs VoIP payload is OPAQUE (callId UUID + nonce + exp + sig only — no callerName/handle/plaintext).
- **Why:** Needed for iOS background/lock-screen group-call ringing to match Android. Independent of the media-crypto path (an already-foregrounded iOS app can join a group call without PushKit).
- **Risk:** MEDIUM — VoIP payload opacity is a locked security contract; CallKit 5s-or-revoke contract; getting the opaque-payload wrong leaks call metadata. Security_gated.

**6. `eas.json`**

- **Change:** BUILD/SIGNING: Add an iOS production build profile + Apple credentials (Apple Team ID, distribution cert, provisioning profile / EAS-managed) and a submit profile; keep the existing simulator profiles for QA. Run `expo prebuild --platform ios` in CI or rely on EAS managed prebuild.
- **Why:** Current eas.json only has iOS simulator profiles; shipping needs signed device/TestFlight builds. QA (Mac) is the only iOS builder (sqa.md:2938).
- **Risk:** LOW — provisioning/signing config; main risk is bundleId/cert mismatch.

#### Step-by-step prompts for Claude

_Hand these to Claude one at a time, in order._

> **Step 1:** 1. Architecture sign-off FIRST (security_gated): take docs/architecture/ARCHITECTURE_AMENDMENT_SFRAME.md to the architecture owner and confirm (a) swapping the iOS WebRTC pod from JitsiWebRTC to a FrameCryptor-capable WebRTC-SDK (stream-webrtc-ios/LiveKit) is approved, and (b) that its RTCFrameCryptor framing is wire-compatible with Android's io.getstream:stream-webrtc-android:1.3.10 FrameCryptor (same AES-256-GCM SFrame framing + key index/epoch). Cross-platform interop depends on this.

> **Step 2:** 2. NATIVE/POD: Author the iOS pod swap. Add an iOS hunk to patches/react-native-webrtc+124.0.7.patch (or a config plugin) changing react-native-webrtc.podspec `s.dependency 'JitsiWebRTC', '~> 124.0.0'` to the chosen FrameCryptor-capable WebRTC-SDK pod, and expose RTCRtpSender/RTCRtpReceiver-by-id + RTCPeerConnectionFactory to app code (mirror the Android WebRTCModule.java getRtpSenderById/getRtpReceiverById/getPeerConnectionFactory accessors).

> **Step 3:** 3. NATIVE/POD: Implement the iOS BravoFrameCryptor native module (Obj-C/Swift) as an Expo config plugin (no committed ios/ dir). Mirror BravoFrameCryptorModule.kt EXACTLY: isAvailable, createKeyProvider(ratchetWindowSize=8, failureTolerance=-1, keyRingSize=16 — match frameCryptorTransport.ts:85-87 defaults), setKey, ratchetKey, attachSenderCryptor, attachReceiverCryptor, setCryptorEnabled, setCryptorKeyIndex, disposeCryptor, disposeKeyProvider. NEVER log key bytes (logAudit test).

> **Step 4:** 4. BUILD: Make the app iOS-buildable. In app.json add ios.googleServicesFile (commit/secret GoogleService-Info.plist), NSPhotoLibraryUsageDescription, add `location` to UIBackgroundModes, and add iOS config plugins for @stripe/stripe-react-native and react-native-permissions. Run `expo prebuild --platform ios` then `npm run ios` (or `eas:build:ios:staging`) on a Mac to get a clean simulator build.

> **Step 5:** 5. CODE (LAST, security_gated): Relax frameCryptorTransport.ts:64 so iOS is permitted ONLY when NativeModules.BravoFrameCryptor.isAvailable() is true; keep the `!Native` + try/catch fail-closed. Update the lines 44-45 comment. Verify FrameCryptorOrchestrator (fail-closed ctor) and useGroupCall step=3 refusal still fire when the module is intentionally absent.

> **Step 6:** 6. VERIFY media E2EE on-device (cannot be unit-tested): on a real iPhone + an Android device, start a 3-party group call. Confirm (a) call connects, (b) on the messenger-service SFU the media is ciphertext (server key-blind), (c) add/remove a member → epoch rekey → removed member's frames stop decrypting, (d) with the native module force-disabled the call REFUSES to start (no plaintext).

> **Step 7:** 7. PARITY (optional for foreground, required to match Android background ring): add react-native-voip-push-notification, provision Apple VoIP cert, set APNs HTTP/2 env on messenger-service, ensure the VoIP APNs payload is OPAQUE (callId UUID + nonce + exp + sig only — strip callerName/handle), then flip callKitBridge.ts:66 IOS_RUNTIME_ENABLED=true after a TestFlight smoke (lock-screen ring + accept/decline + background→foreground answer).

> **Step 8:** 8. BUILD/SIGNING: add an iOS production + submit profile to eas.json with Apple credentials; ship to TestFlight.

#### ⚠️ Regressions this could introduce

- Fail-open regression: relaxing the Platform.OS gate (frameCryptorTransport.ts:64) before the iOS native module actually encrypts would let iOS join a group call with NO frame-crypto over the SFU = plaintext media to the server. The gate MUST stay subordinate to a verified native isAvailable().
- Cross-platform decrypt failure: if the iOS WebRTC-SDK FrameCryptor framing/key-index/epoch differs from Android's Stream 1.3.10 build, iOS↔Android group calls connect but render black/silent (frames never decrypt) — a silent, hard-to-debug interop break.
- Key-material logging: a new native module + JS key pushes risk leaking key bytes into logs, tripping the logAudit static test (packages/messenger-core/__tests__/logAudit.test.ts) — or worse, leaking in release.
- VoIP payload metadata leak: enabling iOS PushKit while passing notif.callerName/handle into the APNs payload (voipPush.ts:139-143) would violate the opaque-push contract and leak who-is-calling-whom to Apple/the push path.
- CallKit 5s-or-revoke: mis-ordering reportIncomingCall vs verification on iOS can get the Apple VoIP entitlement revoked (app pulled).
- Build breakage / 1:1 regression: the pod swap touches the shared react-native-webrtc iOS pod used by 1:1 calls too — a bad swap could break the already-working iOS 1:1 path. Smoke 1:1 on iOS after the swap.
- app.json/aps-environment or bundleId mismatch breaking signing or push delivery across dev/prod.

#### Tests / verification

- JS unit (already green, keep): frameCryptorKeys.test.ts (deriveParticipantKey/epochToKeyIndex) — run `npm run test:crypto`; the iOS path reuses these so no new JS derivation logic.
- Add a JS test asserting frameCryptorTransport.isAvailable() is FALSE on iOS when NativeModules.BravoFrameCryptor is undefined/throws (fail-closed) and TRUE only when the mocked native isAvailable() returns true — codifies the relaxed gate.
- Add/extend a useGroupCall test asserting boot step=3 still refuses to start when frameCryptorOrchestratorAvailable() is false (regression guard for the gate change).
- logAudit static test (packages/messenger-core/__tests__/logAudit.test.ts) must stay green after the iOS native module + any new JS logging.
- Typecheck gates: `npm run typecheck` (mobile, must not exceed .tsc-baseline.json=96 per CLAUDE.md / 49 per MEMORY) + ops-console typecheck.
- DEVICE/MANUAL (the real verification — native crypto is not unit-testable, per frameCryptorOrchestrator.ts:30-34): iPhone↔Android 3-party group call: connect, server-side ciphertext capture (SFU key-blind), member add/remove rekey, and force-disabled-module REFUSE-to-start. Plus iOS 1:1 smoke after the pod swap, and a TestFlight VoIP ring smoke before flipping IOS_RUNTIME_ENABLED.

#### Open questions

- Is there an iOS WebRTC-SDK pod whose RTCFrameCryptor is BYTE-compatible with Android's io.getstream:stream-webrtc-android:1.3.10 FrameCryptor (same SFrame/GCM framing, key index, ratchet)? If not, A↔iOS group calls won't interop and the Android side may need to move in lockstep — needs a spike + architecture review.
- Does docs/architecture/ARCHITECTURE_AMENDMENT_SFRAME.md already anticipate an iOS implementation (method surface/key scheme), or does adding iOS require a new amendment? (File referenced but not read in this pass.)
- Is iOS group-call parity needed WITH background/lock-screen ringing (PushKit/CallKit) in this round, or is a foreground-only group call acceptable first? PushKit needs an Apple VoIP cert + server APNs that are not yet provisioned.
- Will GoogleService-Info.plist be committed or injected via EAS secret, and is a separate iOS Firebase app already registered in the Firebase console?
- Who owns the Mac build/signing pipeline — sqa.md:2938 says QA is the only iOS builder; is there Apple Developer Program enrollment + distribution certs/provisioning for EAS?
- Should aps-environment be split development/production across EAS profiles (currently hardcoded production in app.json)?

### B2: IOS-GROUP-CALL-SIGNALLING — iOS incoming group-call ring + signalling (CallKit + PushKit VoIP) — wire up the already-scaffolded path 🔒 (architecture sign-off required)

**Covers your requests:**

- iOS group calls must be added: incoming group calls must ring/launch on iOS like Android (lock-screen system call UI, accept/decline).
- Incoming-call wake on backgrounded/locked iOS must use APNs VoIP push (PushKit) + CallKit (FCM data wakes cannot reliably wake iOS for a call).
- WS signalling / SFU room-token path must work unchanged on iOS (it is transport-only, server KEY-BLIND).
- Outgoing group call + multi-participant ringing must work from an iOS caller.
- LOCKED: VoIP push payload stays OPAQUE (no caller name / call kind / ids); HMAC wake-verify intact; CallKit must report incoming call within ~5s of every PushKit delivery (Apple revoke-or-die); media E2EE fail-closed preserved (no media without the FrameCryptor key).

#### Root cause / gap analysis

iOS group-call SIGNALLING is not 'missing' — it is fully coded and wired but intentionally inert, blocked by three concrete gaps, only one of which is in this signalling area:\n\n1) CLIENT NATIVE MODULE + FLAGS (this area): the PushKit module react-native-voip-push-notification is NOT installed (confirmed absent from package.json and node_modules), so voipPush.getPushKit() returns null, and the two activation flags voipPush.RUNTIME_ENABLED (voipPush.ts:42) and callKitBridge.IOS_RUNTIME_ENABLED (callKitBridge.ts:66) are hard-coded false. Without the module + a PKPushRegistry hook in the generated AppDelegate (config plugin), iOS never acquires a VoIP token, never registers it, and never reports an incoming call — so a backgrounded/locked iPhone cannot ring for a 1:1 or group call. Normal FCM data pushes do NOT wake a suspended iOS app for a call; only APNs VoIP/PushKit does. The @config-plugins/react-native-callkeep plugin generates CallKeep/CallKit scaffolding but does NOT register a PKPushRegistry — that registration is what react-native-voip-push-notification (or a custom config plugin) provides.\n\n2) SERVER/PUSH CONFIG (deployment, not code): the APNs VoIP sender is complete but dormant because APNS_VOIP_* env vars are unset and no Apple VoIP Services .p8 key is provisioned/shipped (no .voip key referenced anywhere in app.json/eas.json/.env files). ensureApnsClient() returns null → sendVoipApns no-ops for iOS. This is config + an Apple Developer artifact, not code.\n\n3) MEDIA E2EE (separate area, HARD DEPENDENCY): even with ringing fully wired, useGroupCall.ts:1090 refuses to start because FrameCryptor is Android-only (frameCryptorTransport.ts:64). So iOS ringing alone is necessary-but-not-sufficient: the call would ring, the user would accept, and then the call would refuse-to-start at media init unless an iOS FrameCryptor path (native RTCFrameCryptor in react-native-webrtc iOS, or the messenger-core JS SFrame path) is delivered. Per the locked security contract this must NOT be softened to allow plaintext media.\n\nThe SFU/WS signalling and the server ring fan-out are already platform-agnostic and require no iOS-specific change.

#### Current behavior (as built)

There is NO native ios/ directory — the app is a managed Expo prebuild, so the iOS Info.plist/entitlements are generated from app.json at build time. The iOS surface is already largely scaffolded:\n\nNATIVE CONFIG (app.json): ios.bundleIdentifier=com.bravosecure.app (app.json:16); entitlements aps-environment=production (app.json:17-19); infoPlist already declares UIBackgroundModes ['voip','audio','remote-notification'] (app.json:26) plus NSMicrophoneUsageDescription / NSCameraUsageDescription (app.json:24-25); deploymentTarget 15.1 (app.json:71-73). Config plugins @config-plugins/react-native-webrtc and @config-plugins/react-native-callkeep are registered (app.json:60-67), so CallKit native scaffolding is generated on prebuild. package.json has react-native-callkeep ^4.3.16 and react-native-webrtc ^124.0.0; it does NOT have react-native-voip-push-notification.\n\nCLIENT CALL LAYER (cross-platform, gated OFF on iOS): callKitBridge.ts is fully written for both platforms but iOS is gated by IOS_RUNTIME_ENABLED=false (callKitBridge.ts:66; isBridgeActive callKitBridge.ts:74-78; setup deferred callKitBridge.ts:185-188). It has the iOS CXProvider options block (callKitBridge.ts:197-208), reportIncomingCall (callKitBridge.ts:255-274), reportOutgoing/Connected/Ended/Mute, and subscribeToCallKitEvents (callKitBridge.ts:415-462). voipPush.ts is the PushKit token-registration + inbound-wake handler skeleton, gated by RUNTIME_ENABLED=false (voipPush.ts:42); it posts the VoIP token to /push/register-voip with platform:'ios' (voipPush.ts:185-222), persists the per-device wake key, HMAC-verifies inbound wakes (voipWakeVerify), and calls reportIncomingCall SYNCHRONOUSLY before any await to honor Apple's 5s contract (voipPush.ts:107-149). getPushKit() lazy-requires 'react-native-voip-push-notification' which is NOT INSTALLED, so it returns null today (voipPush.ts:250-259). Both flags are documented to 'MUST flip together' (voipPush.ts:36-42). Both bootstraps ARE wired into startup: fcmBootstrap.ts:181-185 calls setupCallKit() then startVoipPushBootstrap(), and fcmBootstrap runs after auth from MainNavigator.tsx:280-281.\n\nSIGNALLING / SFU (already platform-agnostic): the group ring is pure WS. Gateway handleSfuRing emits sfu.ring.incoming to each recipient's userRoom AND fires push.sendVoipWake(uid, roomId, callerId) (messenger.gateway.ts:1431-1502). Client groupCallRingDispatcher.ts subscribes to sfu.ring.incoming/cancelled/declined with NO Platform gate (groupCallRingDispatcher.ts:66-82) and navigates to IncomingGroupCallScreen; fcmBootstrap also routes group wakes to IncomingGroupCallScreen (fcmBootstrap.ts:379-389). SFU/room-token is WS-only — no iOS-specific change.\n\nSERVER PUSH (iOS path fully built, env-gated): push.controller exposes POST /push/register-voip accepting platform 'ios' (push.controller.ts:66-81). push.service.sendVoipWake splits records into signedAndroid/signedIos and sends iOS via sendVoipApns (push.service.ts:571-729, iOS loop 713-725). apnsClient.ts is a complete hand-rolled APNs HTTP/2 VoIP sender (apns-push-type=voip, topic `<bundle>`.voip, ES256 .p8 JWT, P0-N7 key-pin). It is built lazily by ensureApnsClient() which returns null unless APNS_VOIP_KEY_ID / TEAM_ID / BUNDLE_ID / KEY_PATH env vars are set, in which case iOS is simply skipped and Android FCM is unaffected (push.service.ts:801-843). The VoIP wake payload is already opaque: generic 'Incoming call' notification, data block only {kind:'voip-wake', callId, nonce, exp, sig} with caller name/kind deliberately stripped (push.service.ts:550-570, 757-764; Audit P1-N2).\n\nWHY ANDROID-ONLY TODAY: testing has been BlueStacks/Redmi only (sqa.md device reference). The media-E2EE FrameCryptor native module (Kotlin BravoFrameCryptor) and the react-native-webrtc patch are Android-only (patches/react-native-webrtc+124.0.7.patch adds io.getstream:stream-webrtc-android for org.webrtc.FrameCryptor). frameCryptorTransport.isAvailable() returns false on any non-Android platform (frameCryptorTransport.ts:62-71), and useGroupCall refuses to START a group call when FrameCryptor is unavailable (useGroupCall.ts:1090-1091; orchestrator throws frameCryptorOrchestrator.ts:90-95) — fail-closed, never plaintext.

#### Key files

| File                                                        | Role                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.json`                                                | Managed-Expo iOS config source: bundleId, aps-environment entitlement, infoPlist UIBackgroundModes voip/audio/remote-notification, mic/cam strings, webrtc+callkeep config plugins (lines 14-28, 60-73). No native ios/ dir exists. |
| `eas.json`                                                | Build profiles; ios.simulator profiles only (lines 22,46); NO iOS credentials / APNs key block — needs Apple creds + VoIP .p8 for device builds.                                                                                   |
| `src/modules/messenger/push/callKitBridge.ts`             | Cross-platform CallKit/Telecom bridge; iOS gated by IOS_RUNTIME_ENABLED=false (l.66). Flip + verify after PushKit lands.                                                                                                            |
| `src/modules/messenger/push/voipPush.ts`                  | iOS PushKit token registration + inbound-wake → reportIncomingCall (5s contract) skeleton; RUNTIME_ENABLED=false (l.42); requires react-native-voip-push-notification (l.250-259).                                                 |
| `src/modules/messenger/push/voipWakeVerify.ts`            | HMAC wake-verify (per-device wake key); reused by iOS inbound path — keep intact (security).                                                                                                                                       |
| `src/modules/messenger/push/fcmBootstrap.ts`              | Calls setupCallKit()+startVoipPushBootstrap() post-auth (l.181-185); routes group wakes to IncomingGroupCallScreen (l.379-389); installCallKitEventHandlers (l.209-218).                                                            |
| `src/navigation/MainNavigator.tsx`                        | Invokes startFcmBootstrap after auth (l.280-281) — the single startup entry for call wiring.                                                                                                                                       |
| `src/modules/messenger/webrtc/groupCallRingDispatcher.ts` | Platform-agnostic sfu.ring.incoming/cancelled/declined handler → IncomingGroupCallScreen (l.66-82). No iOS change needed.                                                                                                          |
| `src/modules/messenger/webrtc/useGroupCall.ts`            | Group-call boot; REFUSES to start when FrameCryptor unavailable (l.1090-1091) — the media-layer blocker that also stops iOS group calls (separate area).                                                                           |
| `src/modules/messenger/webrtc/frameCryptorTransport.ts`   | isAvailable() returns false on non-Android (l.62-71) — root of 'FrameCryptor is Android-only'. Media E2EE dependency, do not soften.                                                                                               |
| `apps/messenger-service/src/push/apnsClient.ts`           | Complete APNs HTTP/2 VoIP sender (.voip topic, push-type voip, ES256 .p8, key-pin). Dormant until APNS_VOIP_* env set.                                                                                                              |
| `apps/messenger-service/src/push/push.service.ts`         | sendVoipWake fans to Android FCM + iOS APNs (l.571-729); sendVoipApns (l.745-793); ensureApnsClient env gate (l.801-843); opaque payload (l.550-570,757-764).                                                                       |
| `apps/messenger-service/src/push/push.controller.ts`      | POST /push/register-voip accepts platform 'ios', returns per-device wakeKeyB64 (l.66-81).                                                                                                                                           |
| `apps/messenger-service/src/gateway/messenger.gateway.ts` | handleSfuRing: host-only group ring → emit sfu.ring.incoming + sendVoipWake per recipient (l.1431-1502); 1:1 wake (l.1006). Platform-agnostic.                                                                                     |
| `patches/react-native-webrtc+124.0.7.patch`               | ANDROID-ONLY patch (adds io.getstream:stream-webrtc-android for FrameCryptor). No iOS side — confirms the media gap is iOS-native.                                                                                                 |

#### Proposed changes (per file)

**1. `package.json`**

- **Change:** Add react-native-voip-push-notification (the PushKit/PKPushRegistry RN module that voipPush.getPushKit lazily requires). Run npm install + pod install via prebuild.
- **Why:** Without it iOS can never acquire/register a VoIP token nor receive inbound PushKit notifications; getPushKit() returns null today (voipPush.ts:250-259).
- **Risk:** Low for Android (module is iOS-only, voipPush no-ops on Android). Adds a native dep → must rebuild; verify autolink.

**2. `app.json`**

- **Change:** Add an Expo config plugin that (a) registers PKPushRegistry in the generated AppDelegate and routes pushRegistry didReceiveIncomingPushWith → JS, and (b) ensures CallKit/CallKeep + voip background mode. Either react-native-voip-push-notification's plugin or a small custom plugin under plugins/. Entitlement aps-environment + UIBackgroundModes voip are already present (app.json:17-26).
- **Why:** Managed prebuild has no ios/AppDelegate to hand-edit; the PKPushRegistry hook must be injected via a config plugin so the bridge in voipPush.ts actually receives wakes.
- **Risk:** Medium — config-plugin AppDelegate mods can conflict with @config-plugins/react-native-callkeep; must order plugins and test a prebuild diff.

**3. `src/modules/messenger/push/voipPush.ts`**

- **Change:** Flip RUNTIME_ENABLED=true (l.42) ONLY after the module + plugin land and a TestFlight smoke passes. Confirm getPushKit()/getToken/addEventListener('register'|'notification') match the installed module's API (adapt the PushKitLike shape if needed).
- **Why:** Activates token acquisition, /push/register-voip POST, wake-key persistence, and synchronous reportIncomingCall on inbound wake.
- **Risk:** High if flipped early: a PushKit token without a working CallKit display-call = guaranteed Apple entitlement revocation. Flip together with the callKitBridge flag, post-smoke only.

**4. `src/modules/messenger/push/callKitBridge.ts`**

- **Change:** Flip IOS_RUNTIME_ENABLED=true (l.66) in the SAME commit as the voipPush flag, after verifying setupCallKit() CXProvider init + displayIncomingCall + system-UI accept/decline event handlers on a real device.
- **Why:** Gates the whole iOS CallKit surface; isBridgeActive() (l.74-78) keys off it.
- **Risk:** High — same 5s-or-revoke contract; must be device-verified, not just typechecked.

**5. `eas.json / EAS credentials`**

- **Change:** Provision Apple credentials for iOS device/TestFlight builds and add APNS_VOIP_* env (server) — see step_by_step. No code change in eas.json beyond enabling a non-simulator iOS build profile.
- **Why:** Current iOS profiles are simulator-only (eas.json:22,46); PushKit can only be exercised on a real device + TestFlight.
- **Risk:** Low (config).

**6. `apps/messenger-service (deploy env only)`**

- **Change:** Set APNS_VOIP_KEY_ID, APNS_VOIP_TEAM_ID, APNS_VOIP_BUNDLE_ID(=com.bravosecure.app.voip topic derives from com.bravosecure.app), APNS_VOIP_KEY_PATH (the Apple VoIP Services .p8), optional APNS_VOIP_KEY_SHA256 pin + APNS_VOIP_SANDBOX=1 for TestFlight. No code change — apnsClient.ts already consumes these.
- **Why:** ensureApnsClient() returns null until these are set (push.service.ts:801-826); the sender is complete.
- **Risk:** Low code / Medium ops — wrong topic or sandbox/prod mismatch silently fails delivery; .p8 is a secret (key-pin guards swap).

**7. `(separate area) iOS FrameCryptor media E2EE`**

- **Change:** DEPENDENCY ONLY — not in this signalling area: deliver an iOS FrameCryptor path so useGroupCall.ts:1090 stops refusing on iOS (native RTCFrameCryptor exposure in react-native-webrtc iOS, or wire messenger-core JS SFrame). Must remain fail-closed.
- **Why:** Ringing wakes the device and shows CallKit, but the group call will refuse to start at media init on iOS without it; ringing alone is necessary-but-not-sufficient.
- **Risk:** High / architecture-gated — touches the locked media-E2EE contract; do not soften the refusal.

#### Step-by-step prompts for Claude

_Hand these to Claude one at a time, in order._

> **Step 1:** 1. Confirm the gap set: react-native-voip-push-notification absent (verified), RUNTIME_ENABLED/IOS_RUNTIME_ENABLED both false, APNS_VOIP_* unset, FrameCryptor iOS missing. Decide scope: this area = ringing/signalling only; media E2EE is a tracked hard dependency.

> **Step 2:** 2. Apple Developer setup (manual, no code): create a VoIP Services Certificate / APNs Auth Key (.p8) with PushKit capability for Team + bundle com.bravosecure.app; record keyId/teamId. Store the .p8 as a server secret (never in repo).

> **Step 3:** 3. Add react-native-voip-push-notification to package.json; npm install; add the PushKit config plugin (or custom plugin) to app.json plugins so prebuild injects PKPushRegistry into AppDelegate and bridges didReceiveIncomingPush → the 'notification' event voipPush.ts listens for. Verify the generated AppDelegate via npx expo prebuild -p ios diff.

> **Step 4:** 4. Reconcile voipPush.ts PushKitLike (l.243-259) with the installed module's actual API (event names 'register'/'notification', token shape). Adjust the shim only — keep the synchronous reportIncomingCall-before-await ordering (voipPush.ts:107-149) intact for the 5s contract.

> **Step 5:** 5. Server: set APNS_VOIP_KEY_ID/TEAM_ID/BUNDLE_ID/KEY_PATH (+ optional SHA256 pin, +SANDBOX=1 for TestFlight) on messenger-service; restart; confirm log push.voip.ios-init (not ios-skip). No code change — apnsClient.ts + sendVoipApns already handle it.

> **Step 6:** 6. Build a non-simulator iOS dev/TestFlight build (eas.json preview-staging-device or a new ios profile with credentials). Simulator cannot exercise PushKit.

> **Step 7:** 7. Device verify token path: launch on a real iPhone, log in → voipPush bootstrap should getToken + POST /push/register-voip (platform:'ios') and persist the wake key (voipPush.ts:185-222). Confirm server stored an iOS VoIP token.

> **Step 8:** 8. With BOTH flags still false, confirm no regression: Android calls + iOS app launch unaffected (flags gate everything).

> **Step 9:** 9. Flip voipPush.RUNTIME_ENABLED=true AND callKitBridge.IOS_RUNTIME_ENABLED=true in ONE commit. Rebuild TestFlight.

> **Step 10:** 10. Smoke 1:1 first (smallest blast radius): from an Android caller, ring the iPhone backgrounded/locked → APNs VoIP wake → CallKit lock-screen ring within 5s → accept surfaces in-app call → hangup propagates. Verify HMAC-reject path: a forged/expired wake calls reportEnded('failed') (voipPush.ts:169-175) without a sustained ring.

> **Step 11:** 11. Smoke GROUP ring: host fires sfu.ring → iPhone receives sfu.ring.incoming over WS (foreground) and an APNs VoIP wake (background) → IncomingGroupCallScreen / CallKit. NOTE: accepting will hit useGroupCall.ts:1090 refusal until the iOS FrameCryptor dependency (separate area) lands — track this explicitly; do not relax the refusal.

> **Step 12:** 12. Verify opacity: capture the actual APNs payload and confirm it carries only {kind:'voip-wake',callId,nonce,exp,sig} — no caller name, call kind, conversationId, or userId (push.service.ts:757-764).

> **Step 13:** 13. Run gate suite: npm run test:crypto, the push opacity specs (push-events.opacity.spec.ts, booking-push-bridge.opacity.spec.ts), voipWakeVerify.test.ts, and mobile typecheck baseline; do not exceed baseline.

#### ⚠️ Regressions this could introduce

- Apple entitlement revocation: flipping the flags or installing PushKit while CallKit display-call isn't actually firing within ~5s of every VoIP push gets the app permanently banned from VoIP push (callKitBridge.ts:40-47, voipPush.ts:116-128). Must device-verify before flag flip.
- Flag desync: flipping only one of voipPush.RUNTIME_ENABLED / callKitBridge.IOS_RUNTIME_ENABLED violates the 'flip together' invariant (voipPush.ts:36-42) → token registered but no ring, or ring path with no token = revoke risk.
- Config-plugin collision: a PushKit AppDelegate mod can conflict with @config-plugins/react-native-callkeep, producing a broken prebuild (duplicate didFinishLaunching/AppDelegate hooks). Verify prebuild diff.
- Accepting an iOS group call before the FrameCryptor iOS dependency lands will refuse-to-start at media init (useGroupCall.ts:1090) — a confusing 'rings then dies' UX. Sequence media-area work or gate the iOS group-call ENTRY until media is ready.
- APNs topic/env mismatch: wrong bundle/topic or sandbox-vs-prod (.voip topic, apnsClient.ts:109) fails silently (Android unaffected) → 'iOS never rings' with no obvious error beyond push.voip.ios-fail logs.
- Opacity regression: any future change that re-adds callerName/callKind to the VoIP payload would leak metadata to Apple — guarded by push opacity specs; keep them green.

#### Tests / verification

- npm run test:crypto (messenger-crypto project) — regression for call/group crypto after any wiring change.
- Server push opacity specs: apps/messenger-service/src/push/push-events.opacity.spec.ts and apps/auth-service/src/ops/booking-push-bridge.opacity.spec.ts — assert VoIP/event payloads carry no plaintext/ids.
- src/modules/messenger/__tests__/voipWakeVerify.test.ts — HMAC wake verify/reject (replay/forge) still passes for the iOS inbound path.
- apps/messenger-service/src/push/push.service.spec.ts — sendVoipWake Android+iOS split, budget enforcement, bad-token cleanup.
- New unit test: voipPush.ts handleInboundVoipPush reports CallKit synchronously then HMAC-verifies, and calls reportEnded('failed') on verify-fail (mock the PushKit + callKitBridge modules).
- Mobile typecheck (npm run typecheck) must stay at/under .tsc-baseline.json (96).
- Manual device smoke (cannot be unit-tested): real-iPhone TestFlight — lock-screen 1:1 ring + accept/decline + group sfu.ring; capture raw APNs payload to verify opacity.

#### Open questions

- MEDIA DEPENDENCY (architecture sign-off): how will iOS group-call media E2EE be provided so useGroupCall.ts:1090 stops refusing? Options: expose native RTCFrameCryptor from react-native-webrtc 124 iOS (does the bundled iOS WebRTC binary include FrameCryptor?), build an iOS BravoFrameCryptor native module mirroring the Kotlin one, or wire the messenger-core JS SFrame path. Must stay fail-closed. Without this, iOS group calls ring but refuse to start.
- Which PushKit module/plugin: react-native-voip-push-notification + its config plugin, vs callkeep's own PKPushRegistry path, vs a custom Expo config plugin. Need to confirm the installed module's event API matches voipPush.ts's PushKitLike shape (voipPush.ts:243-259).
- Is there an Apple Developer account with VoIP Services capability + a place to store the .p8 securely for messenger-service (EAS secret / Contabo file)? No .voip key is referenced anywhere today.
- apns-topic is hard-coded as `<bundleId>`.voip (apnsClient.ts:109); confirm APNS_VOIP_BUNDLE_ID is the base bundle com.bravosecure.app (topic becomes ...app.voip), matching the provisioned VoIP cert.
- iOS audio session: with selfManaged CallKit, confirm InCallManager / WebRTC audio session category activates on CallKit didActivateAudioSession (react-native-callkeep handles this on iOS, but verify no double-management vs react-native-incall-manager).
- eas.json has only simulator iOS profiles (lines 22,46) — a device/TestFlight profile with real credentials must be added to test PushKit at all.
- Single-device assumption: X-Signal-Device-Id is hard-coded '1' in voipPush registerVoipToken (voipPush.ts:194) — fine for the current single-device model, but confirm it matches the auth device model before multi-device iOS.

### B3: Feasibility & effort verdict (adversarial)

**Verdict:** FEASIBLE but genuinely hard and security-gated — not a config toggle. The architecture is already cross-platform ABOVE the native bridge: the JS key orchestrator, epoch/rekey, SFU, WS signalling and ring fan-out are all platform-agnostic, and the design is correctly FAIL-CLOSED (verified: frameCryptorTransport.ts:64 hard-gates Platform.OS!=='android'; useGroupCall.ts:1090-1091 refuses to start when unavailable). So iOS today gets NO group call rather than an insecure one — good. The single deep blocker is real: the call-media E2EE primitive (RTCFrameCryptor) does NOT exist in any stock react-native-webrtc on iOS. The iOS pod is JitsiWebRTC ~> 124.0.0 (verified in podspec) which ships zero FrameCryptor symbols; Android only got it by patch-swapping to io.getstream:stream-webrtc-android:1.3.10 (verified: patches/react-native-webrtc+124.0.7.patch is 100% android/, 0 ios/ references) plus a Kotlin BravoFrameCryptorModule (exists). iOS therefore needs (a) an iOS WebRTC pod swap to a FrameCryptor-capable libwebrtc build, (b) a symmetric iOS rn-webrtc source patch exposing RtpSender/Receiver/factory, and (c) a brand-new Obj-C/Swift BravoFrameCryptor native module — all crypto-bearing, deep-native, architecture-gated. The honest hard truth: no react-native-webrtc version gives iOS FrameCryptor out of the box, AND the iOS WebRTC-SDK build's frame framing must be PROVEN byte/wire-compatible with Android's Stream 1.3.10 (same AES-256-GCM SFrame, key index, ratchet) before committing — that interop is an ASSUMPTION today, not verified, and is the single biggest risk. Scope reality: ~70% is real reuse, but the remaining ~30% is the hardest, security-gated 30%. Realistic elapsed effort ~4-7 weeks of a senior iOS/WebRTC engineer assuming Apple artifacts and a Mac/iPhone are available, dominated by the crypto interop spike + native module.

**Effort estimate:** ~4-7 weeks elapsed for a senior iOS/WebRTC engineer, ASSUMING a Mac, a real iPhone, and Apple Developer enrollment + a VoIP .p8 are available. Breakdown: FrameCryptor interop spike + iOS native module + on-device decrypt debugging = 2-4 wk (the dominant cost; silent-decrypt-failure debugging is slow); iOS build/Firebase/signing bring-up = 3-5 days; PushKit/CallKit parity + Apple cert + TestFlight smoke = 1-1.5 wk; plus architecture sign-off latency. RISK MULTIPLIER: if the interop spike fails (iOS-SDK framing != Android Stream 1.3.10), Android must migrate to the same WebRTC vendor in lockstep — that pushes this to 2-3+ months and re-tests the whole Android group-call surface. Foreground-only iOS group calls (skip PushKit) are achievable faster (~3-4 wk) since background ringing is a separable parity workstream."

**Recommended path:** Phase 0 — Architecture sign-off FIRST (security_gated): take docs/architecture/ARCHITECTURE_AMENDMENT_SFRAME.md to the owner; approve the iOS pod swap and confirm whether an iOS implementation is anticipated or needs a new amendment; decide foreground-first vs background-ring parity scope this round. Phase 1 — DE-RISK THE #1 BLOCKER with a throwaway spike: prove a FrameCryptor-capable iOS WebRTC-SDK pod (stream-webrtc-ios/LiveKit) decrypts Android-Stream-1.3.10-encrypted frames and vice versa in a 2-party test. Hard GO/NO-GO gate — do not invest further until this passes. Phase 2 — Make the app iOS-buildable: add GoogleService-Info.plist (commit/secret), NSPhotoLibraryUsageDescription, 'location' bg mode; expo prebuild -p ios; clean simulator build; SMOKE 1:1 on iOS to prove the shared rn-webrtc pod isn't broken by the swap. Phase 3 — Build the iOS BravoFrameCryptor native module + iOS rn-webrtc patch as a config plugin; keep the Platform gate CLOSED. Phase 4 — Flip frameCryptorTransport.ts:64 subordinate to a verified native isAvailable() (LAST); on-device iPhone↔Android 3-party group call: confirm connect, SFU-side ciphertext (key-blind), member add/remove → rekey → removed member's frames stop decrypting, and force-disabled-module REFUSES to start. Phase 5 (separable parity) — Apple VoIP cert/.p8 + APNS_VOIP_* env + react-native-voip-push-notification + PKPushRegistry plugin; flip voipPush RUNTIME_ENABLED + callKitBridge IOS_RUNTIME_ENABLED together AFTER a TestFlight smoke; capture the raw APNs payload to confirm opacity. Phase 6 — iOS prod/submit EAS profile + signing + TestFlight. Keep logAudit + push-opacity + test:crypto green throughout; typecheck must not exceed baseline.

#### ✅ Already works on iOS (reuse, not new)

- 1:1 calls are P2P with DTLS-SRTP end-to-end (TURN only relays SRTP) — verified the 1:1 path (useCall/callController/peerConnection) has NO frameCryptor/sframe/SFU refs, so it needs zero media-crypto work and should function once the app simply builds for iOS
- JS crypto orchestration is fully platform-agnostic — frameCryptorOrchestrator.ts (deriveParticipantKey, key-provider lifecycle, epoch/rekey, attach sender/receiver) has no platform branch; only the native bridge below it is Android-gated
- WS signalling + mediasoup SFU room-token + group ring fan-out are platform-agnostic — messenger.gateway handleSfuRing emits sfu.ring.incoming + fires sendVoipWake with no platform gate; SFU stays KEY-BLIND on both platforms
- groupCallRingDispatcher.ts subscribes to sfu.ring.incoming/cancelled/declined with NO Platform gate and routes to IncomingGroupCallScreen — reusable as-is
- Server-side APNs VoIP sender is COMPLETE and dormant only on env — apnsClient.ts (HTTP/2, apns-push-type=voip, topic `<bundle>`.voip, ES256 .p8 JWT, P0-N7 key-pin) + push.service sendVoipApns + ensureApnsClient env-gate; returns null until APNS_VOIP_* set, so Android FCM is unaffected
- Server VoIP wake payload is ALREADY opaque (Audit P1-N2): verified body = {kind:'voip-wake', callId, nonce, exp, sig} only — no callerName/callKind/conversationId; real caller identity comes from the parallel WS call.offer frame post-reconnect
- iOS CallKit JS is fully written but flag-gated OFF — callKitBridge.ts has the CXProvider block, reportIncomingCall, reportOutgoing/Connected/Ended/Mute, event subscriptions; gated by IOS_RUNTIME_ENABLED=false (line 66)
- iOS PushKit JS skeleton fully wired but inert — voipPush.ts token registration, /push/register-voip POST (platform:'ios'), wake-key persist, synchronous reportIncomingCall-before-await (honors 5s contract), HMAC verifyVoipWake; gated by RUNTIME_ENABLED=false (line 42)
- HMAC wake verification (voipWakeVerify) and the libsignal group-master-key distribution are reused unchanged on iOS
- app.json iOS surface is partially in place: bundleIdentifier com.bravosecure.app, aps-environment=production entitlement, UIBackgroundModes [voip,audio,remote-notification], NSMicrophoneUsageDescription + NSCameraUsageDescription, deploymentTarget 15.1, and @config-plugins for react-native-webrtc + react-native-callkeep are registered

#### 🔴 True blockers (ranked)

| Severity | Blocker                                                                                                             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CRITICAL | No iOS FrameCryptor media-E2EE primitive anywhere in the toolchain                                                  | Verified: the iOS pod is JitsiWebRTC ~> 124.0.0 (react-native-webrtc.podspec) which ships zero RTCFrameCryptor/RTCFrameCryptorKeyProvider symbols, and there is no ios/ BravoFrameCryptor module in the repo (no committed ios/ dir at all — managed Expo). Without it the mediasoup SFU (which terminates DTLS-SRTP) sees plaintext, violating the locked E2EE contract. Requires a libwebrtc iOS pod swap to a FrameCryptor-capable build (stream-webrtc-ios / LiveKit WebRTC-SDK) PLUS a new Obj-C/Swift native module mirroring BravoFrameCryptorModule.kt method-for-method. This is the deepest, hardest, architecture-gated piece. |
| CRITICAL | Cross-platform FrameCryptor wire-compatibility is unverified (iOS WebRTC-SDK vs Android Stream 1.3.10)              | iOS↔Android group calls only interop if the iOS WebRTC-SDK RTCFrameCryptor uses identical SFrame/AES-256-GCM framing, key index and ratchet as Android's io.getstream:stream-webrtc-android:1.3.10. This is an ASSUMPTION, not proven. If they diverge, calls connect but render black/silent (frames never decrypt) — a silent, hard-to-debug interop break, and the Android side may have to move vendors in lockstep (much larger blast radius). MUST be de-risked with a spike before any commitment.                                                                                                                                |
| HIGH     | react-native-webrtc upstream exposes no FrameCryptor on iOS — a pod swap AND an iOS source patch are both required | The Android FrameCryptor capability rides on a patch (WebRTCModule.java getRtpSenderById/getRtpReceiverById/getPeerConnectionFactory + public getSender/getReceiver). iOS needs the symmetric patch to the rn-webrtc Obj-C side to expose RTCRtpSender/RTCRtpReceiver-by-id + the factory to the Bravo native module. So it is not 'just swap the pod' — it is pod swap + iOS source patch + new native module + an Expo config plugin to inject all of it (since there is no committed ios/ dir). Plainly: no rn-webrtc version ships this turnkey on either platform.                                                                   |
| HIGH     | No Apple VoIP push infrastructure (PushKit-must-report-to-CallKit-within-5s / revoke-or-die)                        | Verified: react-native-voip-push-notification is NOT in package.json (getPushKit returns null), RUNTIME_ENABLED=false and IOS_RUNTIME_ENABLED=false, no Apple VoIP Services .p8 referenced anywhere, APNS_VOIP_* env unset (ensureApnsClient returns null → ios-skip). No PKPushRegistry is injected (the callkeep config plugin does not register one). Needed ONLY for background/locked ringing parity with Android — a foregrounded iOS app can join a group call without PushKit. Apple's 5s-or-revoke rule makes the flag flip device-verify-gated.                                                                                |
| HIGH     | App is not iOS-buildable at all                                                                                     | No committed ios/ dir (managed Expo — expo prebuild --platform ios required; android/ is prebuilt and checked in). Missing googleServicesFile/GoogleService-Info.plist will hard-fail the @react-native-firebase iOS build. Also missing NSPhotoLibraryUsageDescription and 'location' in UIBackgroundModes; no iOS device/production/submit EAS profile and no Apple Developer signing wired (QA is the only Mac builder per sqa.md). External hard deps: Mac, real iPhone, Apple Developer Program enrollment + distribution certs.                                                                                                     |
| MEDIUM   | Fail-OPEN regression risk if the Platform.OS gate is relaxed prematurely                                            | frameCryptorTransport.ts:64 is the fail-closed boundary. Relaxing it to permit iOS BEFORE the iOS native module truly encrypts would let an iPhone join a group call with NO frame-crypto over the SFU = plaintext media to the server. The gate must stay subordinate to a verified native isAvailable() and be the LAST change. Mitigated by the existing !Native + try/catch and the orchestrator's fail-closed constructor, but the ordering is a security invariant.                                                                                                                                                                  |
| MEDIUM   | Client-side VoIP payload opacity latent landmine                                                                    | Server payload is opaque today (P1-N2 verified: {kind,callId,nonce,exp,sig} only). But the client handleInboundVoipPush (voipPush.ts:139-143) still reads notif.callerName/notif.callKind into reportIncomingCall. It does not leak today (server omits those fields → falls back to 'Bravo contact'/'voice'), but it is a trap: re-adding callerName server-side would silently leak who-is-calling-whom to Apple. Must keep the server payload minimal and the push-opacity specs green.                                                                                                                                                |

#### Reuse vs net-new

- REUSE (platform-agnostic, genuinely already done): JS frameCryptorOrchestrator key/epoch/rekey + deriveParticipantKey; useGroupCall fail-closed boot; mediasoup SFU + WS signalling + handleSfuRing ring fan-out; groupCallRingDispatcher; server apnsClient.ts + sendVoipApns + opaque payload (env-gated only); callKitBridge + voipPush JS (flag-gated only); voipWakeVerify HMAC; libsignal group-master-key distribution; 1:1 DTLS-SRTP path; most of app.json iOS config
- NET-NEW iOS-ONLY (1): iOS WebRTC pod swap from JitsiWebRTC to a FrameCryptor-capable build (stream-webrtc-ios/LiveKit) via a patches/ entry or config plugin override
- NET-NEW iOS-ONLY (2): symmetric iOS rn-webrtc source patch exposing RTCRtpSender/RTCRtpReceiver-by-id + RTCPeerConnectionFactory (mirror of the Android WebRTCModule.java patch)
- NET-NEW iOS-ONLY (3): an Obj-C/Swift BravoFrameCryptor native module mirroring BravoFrameCryptorModule.kt method-for-method (createKeyProvider/setKey/ratchetKey/attachSender|ReceiverCryptor/setCryptorEnabled/setCryptorKeyIndex/dispose + isAvailable), delivered as an Expo config plugin since there is no committed ios/ dir
- NET-NEW iOS-ONLY (4): the cross-platform FrameCryptor interop spike (prove iOS-SDK frames decrypt Android-Stream-1.3.10 frames and vice versa) — pure de-risking work with a GO/NO-GO outcome
- NET-NEW iOS-ONLY (5): Apple VoIP Services .p8 + APNS_VOIP_* env on messenger-service + react-native-voip-push-notification dep + a PKPushRegistry config plugin (only for background-ring parity)
- NET-NEW iOS-ONLY (6): build bring-up — GoogleService-Info.plist (commit or EAS secret), NSPhotoLibraryUsageDescription, 'location' background mode, iOS device/prod/submit EAS profile + Apple signing creds
- NET-NEW (small, security-gated): flip three gates in order — frameCryptorTransport.ts:64 (LAST, subordinate to verified native isAvailable()), then voipPush RUNTIME_ENABLED + callKitBridge IOS_RUNTIME_ENABLED together (post-TestFlight)

#### Risks

- Silent cross-platform decrypt failure: if iOS-SDK FrameCryptor framing/key-index/epoch differs from Android Stream 1.3.10, iOS↔Android calls connect but render black/silent — hard to debug, and may force an Android vendor migration in lockstep
- Fail-OPEN regression: relaxing frameCryptorTransport.ts:64 before the iOS native module truly encrypts = plaintext group media to the SFU. The gate MUST stay subordinate to a verified native isAvailable() and be the last change
- Key-material logging: a new native crypto module + JS key pushes risk leaking key bytes into logs and tripping packages/messenger-core/__tests__/logAudit.test.ts — or worse leaking in release
- Apple VoIP entitlement revocation: flipping the push flags before CallKit reliably reports within ~5s of every PushKit delivery → permanent VoIP-push ban (no appeal). Device-verify before flag flip; flip both flags together
- 1:1 iOS regression: the pod swap touches the shared rn-webrtc iOS pod used by the working 1:1 path — a bad swap could break it. Smoke 1:1 on iOS immediately after the swap
- Build breakage: missing GoogleService-Info.plist hard-fails the RNFirebase iOS build; wrong bundleId/aps-environment/topic breaks signing or silently drops push delivery (Android unaffected, so 'iOS never rings' with no obvious error)
- Config-plugin collision: a PushKit AppDelegate injection can conflict with @config-plugins/react-native-callkeep (duplicate didFinishLaunching hooks) — verify the prebuild diff
- Opacity regression: any future re-add of callerName/callKind to the VoIP payload leaks call metadata to Apple; client voipPush.ts:139-143 already reads those fields defensively, so the server payload must stay minimal and opacity specs green

#### iOS-specific security / sign-off items

- Media E2EE must FAIL-CLOSED on iOS exactly like Android: the frameCryptorTransport.ts:64 gate stays subordinate to a verified native BravoFrameCryptor.isAvailable(); it is flipped LAST and the orchestrator's fail-closed constructor + useGroupCall step=3 refusal must still fire when the module is intentionally absent (regression-test this).
- The iOS WebRTC pod swap is a crypto-PRIMITIVE-bearing dependency change — requires explicit architecture sign-off against docs/architecture/ARCHITECTURE_AMENDMENT_SFRAME.md, and the iOS-vs-Android FrameCryptor wire-compatibility (AES-256-GCM SFrame, key index, ratchet) must be proven before commit.
- Server must remain KEY-BLIND: the iOS native module derives/holds keys on-device via the same JS orchestrator + libsignal group-master-key source — no key ever crosses to messenger-service/SFU; the change is scoped to media crypto + build, not key distribution.
- The new iOS native crypto module must NEVER log key bytes / ArrayBuffers — must keep packages/messenger-core/__tests__/logAudit.test.ts green, including release builds.
- VoIP push payload must stay OPAQUE: server is already P1-N2 compliant ({kind,callId,nonce,exp,sig}); keep it minimal and keep the push-opacity specs green. Treat the client reading notif.callerName (voipPush.ts:139-143) as a latent landmine — do not re-introduce caller identity server-side.
- PushKit/CallKit: keep the synchronous reportIncomingCall-before-await ordering (5s-or-revoke) and HMAC verifyVoipWake intact; flip voipPush.RUNTIME_ENABLED + callKitBridge.IOS_RUNTIME_ENABLED together, only after a TestFlight device smoke.
- Sender-cert / call-offer auth and the WS/SFU signalling are unchanged and must stay so — no 'skip in dev' branches introduced on the iOS path.
