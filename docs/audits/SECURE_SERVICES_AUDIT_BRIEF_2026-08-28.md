# Secure Services Module — Complete Audit Brief

> **Date:** 2026-08-28 · **Repo state:** `main` @ `e9146751` (app v1.0.265 / vc309)
> **Purpose:** a single self-contained description of the Secure Services (CPO booking +
> auto-dispatch) module — architecture, code inventory, flows, money model, security posture,
> test coverage, bug history, and known open risks — written so an external auditor (or an
> LLM constructing an audit plan) can work from this document alone.
> **Verification note:** every claim here was compiled from the source tree at the commit
> above, not from memory. File paths are exact; line numbers age fast in this repo — re-grep
> the symbol rather than trusting a stamped line.

---

## 1. What the module is

**Secure Services** is one of the three products in the Bravo Secure app (the other two:
Messenger, VBG). It is a close-protection marketplace with four actors:

| Actor                                                                | What they do                                                                                                                         | App surface                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| **Client** (principal)                                               | Books protection (Secure Transfer / Executive Protection), pays in Bravo Credits, tracks the live mission, verifies the guard, rates | Client shell → `SecureTab` → `BookingNavigator` |
| **Agency** (service provider / "company" agent)                      | Receives dispatch offers, accepts, assigns CPO crew, monitors missions, receives escrow payout                                       | `AgentNavigator` (agency portal)                |
| **CPO** (close protection officer, managed sub-account of an agency) | Goes on duty, runs the assigned mission (Pickup → Go-Live → Complete), streams GPS                                                   | `CpoNavigator` (4-tab shell)                    |
| **Ops (HQ)**                                                         | Approves bookings (ops-gated flow), monitors dispatch, resolves disputes, force-assigns, aborts                                      | Next.js ops-console → `/ops/*` endpoints        |

There are **three product tiers / flows inside the module**:

1. **Lite (auto-dispatch)** — the Uber-style flow: client books → matchmaker offers the job to
   ranked agencies (30 s TTL each) → agency accepts → escrow held → agency assigns crew →
   CPO runs the mission → escrow released. This is the core of the module.
   **⚠️ The auto path has shipped DARK**: the effective state is server-computed —
   `AUTO_DISPATCH_ENABLED=true` (env) AND Redis killswitch `dispatch:enabled ≠ 'false'`
   (`resolveAutoDispatchEnabled()` in `auth/auth.service.ts`) — and mirrored to the client
   as a **global** (not per-user) `auto_dispatch_enabled` field on `/auth/me`. The client
   reads it from `authStore.user.auto_dispatch_enabled`, fail-closed to the legacy path.
   The historical build flag `EXPO_PUBLIC_AUTO_DISPATCH` still exists
   (`src/utils/constants.ts`) but is **inert** — its only remaining consumers are test
   mocks; do not treat it as a gate.
2. **Legacy (ops-gated)** — the older admin-mediated flow: booking → `PENDING_OPS` → ops
   approves → payment → job board / manual crew assignment. Still live; both flows share
   `lite_bookings`. Since `20260706000000_ops_gated_auto_dispatch.sql`, even the auto flow
   is ops-gated (`DRAFT → PENDING_OPS → OPS_APPROVED → DISPATCHING`).
3. **Bravo Secure Pro** — a retainer product: client applies (`pro_applications`) → ops
   builds a proposal → client accepts + pays (full-period wallet debit) → plan `ACTIVE` →
   in-plan booking requests, designated team, assigned fleet/resources, on-demand
   **protection sessions** (live GPS escort with a dedicated FSM). An ACTIVE Pro member
   books Lite only in "now" mode (commit `5c9b8333`, `proNowOnlyBooking.test.ts`) —
   scheduled protection is the Pro plan's own product.

Adjacent-but-in-scope substrate: **wallet/credits** (all booking money is internal credit
ledger), **family seats** (holder pays for members, spend caps), **incident reports**,
**attendance/shifts**, and the **Mission Ops Room** (an E2EE messenger conversation
auto-provisioned per mission — the server queues membership _intents_; clients hold the keys).

---

## 2. Tech stack + where the code lives

- **Mobile:** React Native 0.81 + Expo SDK 54, TypeScript, Zustand (+immer), React Navigation.
  Module code: `src/screens/{booking,executive,ops,liveops,securepro,pro,cpo,agent}/**`,
  `src/store/bookingStore.ts` + friends, `src/services/api.ts`, `src/navigation/**`.
- **Backend:** NestJS in `apps/auth-service` (Postgres via Supabase pooler; Redis for locks,
  pub/sub, killswitch, push-event blobs). Modules: `src/{dispatch,booking,org,agents,ops,
wallet,settlement,family,pro-applications,pro-management,protection,attendance,incident,
events,notifications,sos,telemetry,compliance,users,subscription}/**`.
- **Ops console:** Next.js 15 in `apps/ops-console` (dispatch monitor, finance, pro
  management). **No Jest harness** — tsc + lint + manual only.
- **DB:** Postgres migrations in `supabase/migrations/**`. **Uniform RLS posture:** every
  module table is `ENABLE + FORCE ROW LEVEL SECURITY` with **zero policies** — the backend
  connects as `postgres` (BYPASSRLS); anon/authenticated PostgREST access is deny-all.
  A catch-up migration (`20260805090816`) asserts zero RLS-disabled public tables remain.
- **Cron convention:** `@nestjs/schedule` is deliberately NOT a dependency. Every sweep is a
  `setInterval` + Redis `SET NX` lock (single-fire across pods), several with liveness keys
  feeding `/ready` (see §10).
- **API documentation gap:** `docs/openapi/` covers ONLY auth + messenger. **No booking,
  dispatch, org, agents, ops, or pro-management path has an OpenAPI spec** — the surface is
  documented only in prose (this brief, `LITE_MISSION_AUDIT_AND_IMPROVEMENT_PLAN.md` §1.3,
  `SQA_AUTO_DISPATCH_LIFECYCLE.md` §7.1).

---

## 3. The core flow and its state machines

```
CLIENT books ─► PENDING_OPS ─► OPS_APPROVED ─► DISPATCHING ─► (offer, 30s TTL, ≤8 agencies)
                                                    │
                              AGENCY accepts ◄──────┘
                                    │  escrow HELD · booking CONFIRMED · 15-min crew SLA
                              AGENCY assigns crew ─► mission DISPATCHED · 20-min arrival SLA
                                    │
CLIENT watches (live map, verify code) ◄── CPO: Pickup ─► PICKUP ─► Go-Live ─► LIVE ─► Complete
                                                              (booking CONFIRMED→LIVE at go-live)
                                    │
                      mission+booking COMPLETED ─► proof gate ─► escrow PENDING_RELEASE
                                    │                                   │ (72h dispute window)
                              client rates / disputes                   ▼
                                                          escrow RELEASED ─► agency wallet
```

### 3.1 Booking FSM — `apps/auth-service/src/booking/state-machine.service.ts`

**States (11):** `DRAFT, DISPATCHING, PENDING_OPS, OPS_APPROVED, PAYMENT_PENDING, CONFIRMED,
LIVE, COMPLETED, NO_PROVIDER, AGENCY_NO_SHOW, CANCELLED`. **Actors:** `CLIENT | OPS_HANDLER |
CPO | SYSTEM`.

Key transitions: `DRAFT→PENDING_OPS` (client submit, both flows) · `PENDING_OPS→OPS_APPROVED`
(ops) · `OPS_APPROVED→DISPATCHING` (SYSTEM: Redis pub/sub for 'now', T-15-min cron for
'later') · **`DRAFT→DISPATCHING` (CLIENT) is still a legal edge in both the TS FSM and the
DB trigger** — the create path no longer uses it (it goes DRAFT→PENDING_OPS), so it is
vestigial-but-legal: a new write path could skip the ops board without either layer
objecting (audit target) · `DISPATCHING→CONFIRMED` (accept+charge) ·
`DISPATCHING→NO_PROVIDER` (terminal) ·
`CONFIRMED→AGENCY_NO_SHOW` (crew SLA, terminal) · `CONFIRMED→DISPATCHING` (arrival no-show
re-dispatch, agency withdraw) · `CONFIRMED→LIVE→COMPLETED` (CPO/ops) ·
`CANCELLABLE = {DRAFT, DISPATCHING, PENDING_OPS, OPS_APPROVED, PAYMENT_PENDING, CONFIRMED} → CANCELLED`.

**Critical invariant (the "two-FSM seam"):** on the auto path the booking **stays `CONFIRMED`
for the whole live mission** — only `mission_status` moves (`DISPATCHED/PICKUP/LIVE/SOS`).
`GET /bookings/:id` exposes `mission_status`; the list DTO attaches it too (LB-ST1 fix).
Client code gating on `booking.status === 'LIVE'` is wrong by construction; the single
correct resolver is `resumeTargetFor` / `liveTargetFor` in `src/screens/booking/bookingStatus.ts`.

**DB mirror + drift:** trigger `lite_bookings_fsm_check()`
(`20260706000000_ops_gated_auto_dispatch.sql`) mirrors the graph but is **actor-blind** —
actor discipline exists only in TypeScript. A dedicated drift test exists
(`state-machine.drift.spec.ts`).

**Cancel guards** (`booking.service.ts`, `cancel`): idempotent on terminal; pre-commitment
statuses always cancellable; post-CONFIRMED window = `BOOKING_CANCEL_WINDOW_HOURS` (default
1 h) anchored to `dispatch_settled_at` (auto) / `confirmed_at` (legacy) — LM-B8 fix; mission
`LIVE/SOS` → `400 cancel_blocked_protection_active` under `FOR UPDATE` (LM-B4 fix,
booking→mission lock order).

### 3.2 Mission FSM — `apps/auth-service/src/ops/mission-state-machine.service.ts`

**States (6):** `DISPATCHED → PICKUP → LIVE → COMPLETED`, plus `SOS` (from PICKUP/LIVE;
`SOS→LIVE` ops/admin, `SOS→COMPLETED` agent/ops/admin) and `ABORTED` (ops/admin only, from
any non-terminal). **Actors:** `AGENT | OPS | ADMIN | SYSTEM` — but **no SYSTEM transitions
are declared**, and the FSM's real enforcement footprint is narrow (audit target):

- `MissionStateMachine.assert` is injected/called **only** from `ops/mission.service.ts`
  (ops abort DOES assert) and `ops/job-feed.service.ts`.
- **Everything else writes mission status via raw conditional UPDATEs** (status-guarded
  `WHERE` clauses, not FSM asserts): the entire agent-side advance path
  (pickup/go-live/complete and SOS raise in `agent.service.ts`), the agency withdraw
  stand-down (`org/org-mission.service.ts`), SOS raise (`sos/sos.service.ts`), the client
  cancel path, and the sweeps (`arrival-noshow`, `mission-drift-janitor` — which also
  writes `COMPLETED`, not only `ABORTED`).

### 3.3 Pro application FSM — `apps/auth-service/src/pro-applications/state-machine.service.ts`

`PENDING_PROPOSAL → PROPOSAL_CREATED → {ACCEPTED | REVISION_REQUESTED}`; `ACCEPTED → ACTIVE`
(SYSTEM, post-debit); `ACTIVE → EXPIRED` (lazy read-path sweep + hourly `pro-lapse.cron`);
`REJECTED` (ops, pre-acceptance); `CANCELLED` (client/ops, pre-ACTIVE only — never from ACTIVE).

Other in-scope FSMs: `protection-session.fsm.ts`, `incident-fsm.ts`,
`agents/state-machine.service.ts` (CPO onboarding), `ops/job-state-machine.service.ts` (legacy).

---

## 4. Endpoint map (complete, by surface)

No OpenAPI exists for any of this (§2). Guards per surface in §11.

### Client — `@Controller('bookings')` + dispatch entry

`POST /bookings` (legacy create) · `POST /dispatch/request` (auto create; killswitch-gated;
throttled 5/min; Idempotency-Key) · `GET /bookings` · `GET /bookings/:id` (carries
`mission_status`) · `GET /bookings/:id/provider` (coarse reveal) · `GET /bookings/:id/team` ·
`GET /bookings/:id/verify-code` · `GET /bookings/:id/invoice` · `GET /bookings/:id/escrow` ·
`POST /bookings/:id/{cancel, pay-with-credits, confirm-complete, dispute, rating, escalate,
not-my-guard}` · `GET /bookings/{service-pricing, add-ons, regions/availability}` ·
`POST /bookings/estimate` · telemetry: `POST /telemetry/:bookingId/client-ping`,
`GET /telemetry/:bookingId/{latest,recent}` · SOS: `POST /sos/raise`, `POST /sos/:id/cancel`,
`GET /sos/:id/status`.

### Agency — offers, portal, org console

`GET /dispatch/offers/current` · `GET /dispatch/offers/:id/full` (ACCEPTED+owner only,
fail-closed audit) · `POST /dispatch/offers/:id/{accept,reject}` ·
`POST /dispatch/open-jobs/:bookingId/claim` · `POST /dispatch/bookings/:bookingId/withdraw` ·
`GET/POST /dispatch/room-intents/*` (Ops-Room E2EE intent queue) ·
`@Controller('org')`: `GET {summary, missions, missions/completed, earnings,
missions/:id/live, bookings/:id/escrow, cpos, cpos/:id/missions, cpos/:id/profile,
hierarchy, managers}` · `POST {missions/:id/complete, bookings/:bookingId/crew, cpos,
employees, jobs/:jobId/apply}` · `PATCH {cpos/:id/status, cpos/:id/role,
managers/:id/permissions}` · `POST /org/invites/redeem` · `/org/workspace/*`.

### CPO — `@Controller('agents')` (mission subset)

`PATCH /agents/me/{duty, location, agency-profile}` · `GET /agents/me/{active-mission,
open-jobs}` · `POST /agents/me/missions/:id/{pickup, go-live, complete, respond, sos,
check-in, hourly-checkin, request-complete, telemetry}` ·
`GET /agents/me/missions/:id/verify-code` · `GET /agents/me/missions/:id/deployment` ·
Pro: `POST /agents/me/pro-mission-code`, `GET /agents/me/pro-mission`,
`/agents/me/protection/*` (overview, session, locations, cpo-ping, notes, readiness).

### Ops console — `@Controller('ops')` and children

Bookings: `GET /ops/bookings[, /:id, /:id/applicants, /:id/proposed-payouts]` ·
`POST /ops/bookings/:id/{approve, reject, dispatch, complete}` · Dispatch:
`GET /ops/dispatch/{monitor, killswitch, requests, requests/:id}` ·
`POST /ops/dispatch/{test, :bookingId/cancel, :bookingId/force-assign}` ·
`PUT /ops/dispatch/killswitch` (ADMIN only) · Missions: `abort, waypoint, route-select,
deployment/signoff` · Disputes/finance: `POST /ops/disputes/:id/resolve`,
`GET /ops/finance/{transactions, escrows, payouts, invoices, promos, wallet/:userId}`,
`POST /ops/wallets/:userId/adjust` · Users: suspend/restore/erase ·
`GET /ops/missions/:id/telemetry`, `GET /ops/{sos, audit, analytics}` ·
Pro: `/ops/pro-applications/*` (proposal, reject, schedule/decline missions, messages),
`/ops/pro-management/*` (orgs, cpos, pool, assignments, fleet, resources).

### Pro / family / wallet (client)

`/pro-applications`: `POST /`, `GET me`, `POST :id/{renew, accept, request-changes,
activate, cancel, missions, messages}`, `GET :id/{missions, team, messages}` ·
`/protection/sessions`: `POST /`, `GET current`, `POST :id/locations`, `POST :id/end`,
history/notes/readiness/timeline · `/family`: invite, request-seats (cap 4), members, usage,
spend limits/holds, locations, invites accept/decline · `/wallet`: balance, transactions,
topup(+confirm), redeem-promo, payment-methods CRUD, credits/batches,
`POST /wallet/stripe-webhook` (unauthenticated, signature-verified) ·
`GET /events/by-id/:eventId` (push hydration) · `/me/notifications` (durable inbox).

---

## 5. The dispatch engine (matchmaker) — `apps/auth-service/src/dispatch/`

**Entry into DISPATCHING:** ops approve publishes `{bookingId}` on Redis
`dispatch:ops-approved` → `OpsApprovedDispatchService` → `DispatchService.start()`; 'later'
bookings enter via `ScheduledDispatchService` at T-15 min; ops can test-fire; a portal claim
can hop `OPS_APPROVED → DISPATCHING → CONFIRMED` in one transaction.

**Candidate ranking (`RANKING_SQL`)** — hard filters, all must pass:
company agent, ACTIVE, `on_duty`, location fresh < 5 min (`DISPATCH_LOCATION_FRESH_MINUTES`),
not mock-GPS, region match, no cooldown, within `DISPATCH_RADIUS_M` (default 50 km),
`is_eligible_for_dispatch()` (SQL fn: **DPA accepted** + verified unexpired licence +
insurance for the region + armed-capability if required), `has_free_cpo_capacity()`
(roster minus busy minus reserved ≥ requested `cpo_count`), not currently holding any
OFFERED row, not already burned on this booking. Order: 1-km distance band → rating →
exact distance. One offer at a time (`LIMIT 1`).

**Offer lifecycle:** TTL 30 s (`DISPATCH_OFFER_TTL_SECONDS`), max 8 offers/booking, 32
attempt budget. Unique partial indexes `dispatch_offers_one_live_per_booking` /
`dispatch_offers_one_live_per_provider` are the race backstops. Expiry sweep every 8 s (also expires offers whose holder went off-duty
or stale). Decline accounting on reject AND expire: acceptance-rate recompute + 30-min
cooldown bench when `responded ≥ 5 && rate < 0.2`.

**Accept** (one txn, deadlock-retried once): lock offer FOR UPDATE → **IDOR check before
status check** (403 `org_scope_violation`) → conditional win
(`WHERE status='OFFERED' AND expires_at > NOW()`) → lock booking, require DISPATCHING →
**escrow charge** (family payer re-resolved at charge time) → `CONFIRMED` +
`crew_deadline_at = NOW() + 15 min` → siblings retired as `CANCELLED` (not SUPERSEDED —
blameless agencies stay eligible). Charge failure → `abandonUnstarted` → booking CANCELLED,
client gets `paymentFailed` / `familyChargeBlocked` push; agency sees only
`offer_not_available`.

**SUPERSEDED** = "this agency has seen this booking out" — set on client/admin cancel,
abandon, crew-SLA breach, arrival no-show, withdraw, stale-uncrewed expiry; honored by both
the ranker and portal claim.

**NO_PROVIDER:** no candidate or budget exhausted → terminal + full refund of any HELD
escrow (a relisted booking arrives still-HELD). **No safety fallback beyond the hotline
escalation** — explicit `TODO(LB13)` in the source. Historical staging data: **44% of all
bookings** ended NO_PROVIDER, driven by 2/34 agencies holding a DPA — and **DPA acceptance
has no UI or endpoint; it is a DB-only stamp** (`agents.dpa_accepted_at`).

**Crew SLA (15 min, HARDCODED `CREW_ASSIGN_SLA_MINUTES=15`):** CONFIRMED with no mission →
`AGENCY_NO_SHOW`, full refund, `reliability_breaches++`. Terminal.
**Arrival SLA (20 min, env-tunable):** mission DISPATCHED, no pickup → booking back to
DISPATCHING, mission ABORTED (FSM-bypassing raw UPDATE), Ops Room hard-deleted, crew stood
down, offer SUPERSEDED, hold **stays HELD**, re-enters the cascade. **Offer budget NOT
reset** — chronically failing bookings drift toward NO_PROVIDER.

**Job Portal (pull side):** claimable only for auto bookings post-approval; re-runs the
full eligibility+capacity gates; a claim wins an existing OFFERED row or mints a rank-0 row
born ACCEPTED (unraceable by the expiry sweep). **Withdraw:** pre-crew only; hold stays
HELD; no automatic re-offer (portal is the re-offer surface); `RelistTimeoutService`
(60 min) is the terminal backstop to NO_PROVIDER+refund.

**Pre-accept privacy:** coarse payload only — `distance_bucket`, region, time, price,
headcount, boolean-only requirement flags (`pickBooleanFlags` structurally drops strings).
Precise coordinates only via `/full` after ACCEPTED, with fail-closed `dispatch.full_read`
audit (audit-write failure blocks the coords).

**Retention:** `reject_reason` redacted at 24 h; `mission_telemetry_last` purged 24 h
post-terminal (`dispatch-privacy-purge.service.ts`).

---

## 6. Money model (credits, escrow, payout)

**Everything is the internal credit ledger.** Stripe exists ONLY for wallet top-up
(`StripeClient.enabled = !!STRIPE_SECRET_KEY`; without it top-ups mint ledger-only credits —
refused in production unless `ALLOW_NO_STRIPE_TOPUP=1`). **There is no fiat payout rail to
agencies** (no Stripe Connect) — "payout" credits an agency wallet balance.

**Escrow lifecycle** (`escrow_holds`, one per booking — `booking_id` UNIQUE):

```
HELD ──(lead Finish + proof gate PASS)──► PENDING_RELEASE ──(sweep after 72h window / client confirm)──► RELEASED
 │                                             └─(client dispute / ops abort post-finish)──► DISPUTED ─► RELEASED|REFUNDED|PARTIAL
 ├─(no-show / no-provider / cancel pre-crew / abort pre-LIVE / stale expiry)──► REFUNDED
 └─(cancel post-crew w/ fee / abort mid-LIVE pro-rata)──► PARTIAL
RELEASED ──(dispute upheld late)──► clawback (platform-fee account fronts shortfall, may go NEGATIVE)
```

- **Charge at accept only** (`WalletService.holdToEscrow`): paired ledger rows (payer
  `payment` − / escrow account `escrow_hold` +), FIFO credit-batch consumption, FX rate
  stamped in metadata. Family bookings debit the **resolved payer** (`payer_user_id`),
  member stays `actor_user_id`, `family_members.spent_credits` bumped (B-374/375 fixes).
- **Release** (`SettlementService.settleEscrowRelease` — the single owner): gross out of
  escrow, `to_provider` to the agency (idempotent via partial unique index
  `ux_wallet_tx_payout`), fee to the platform-fee account, `mission_payouts` row,
  `jobs_total++`, Ops-Room conversation hard-deleted. Conservation invariant:
  `gross == to_provider + platform_fee`.
- **Proof-of-completion gate** (`proof-of-completion.service.ts`) decides
  PENDING_RELEASE vs `review_required`: (1) real PICKUP→LIVE progression, (2) ≥1 GPS fix
  within `dispatch.arrivalRadiusM` of pickup, (3) ≥ `minPings` fixes during LIVE,
  (4) LIVE ≥ `minOnTaskSeconds` — all three thresholds are env-tunable config with
  defaults 150 m / 5 / 300 s — and
  (5) **identity handshake — a documented permanent PASS (no-op)**. A `review_required`
  hold never auto-releases and blocks client confirm; only exit = admin force release.
- **Refund matrix:** cancel-pre-crew / NO_PROVIDER / AGENCY_NO_SHOW / abort-pre-LIVE /
  stale-uncrewed (60 min past pickup, drift janitor) → full REFUND. Cancel post-crew →
  PARTIAL iff `cancelFeePct > 0`. Abort mid-LIVE → pro-rata PARTIAL on elapsed LIVE
  minutes. Abort post-finish → hold frozen to DISPUTED + auto-opened dispute
  (`admin_abort`) — a human decides (LM-B6 fix).
- **⚠️ All rates ship 0 / demo, unsigned by finance (LM-M4, OPEN):**
  `DISPATCH_PLATFORM_FEE_PCT = 0`, `DISPATCH_CANCEL_FEE_PCT = 0` (⇒ post-crew cancel is
  currently a FULL refund; agency gets nothing for committed crew), FX table + regionTaxPct
  are placeholders. `lite_bookings.dispute_window_seconds` exists per-booking but **is
  never read** — completion always uses the global 72 h.
- **Idempotency, two layers:** HTTP `IdempotencyInterceptor` (`Idempotency-Key`, 8–128
  `[A-Za-z0-9_-]` — a `:` in the key is the historic "PAYMENT FAILED" bug, pinned by
  `idempotencyKeyShape.test.ts`; Redis-cached 24 h; REQUIRED on every money/mutating route)
  - DB truth (conditional status-guarded UPDATEs, `escrow_holds.booking_id` UNIQUE,
    `ux_wallet_tx_payout`, `ux_wallet_tx_booking_refund`, `booking_disputes_one_open`,
    `stripe_processed_events`).
- **Reconciliation:** daily read-only sweep (`escrow-reconciliation.service.ts`) audits the
  money invariants; hourly credit-batch expiry (12-month TTL); `reconcileBalances` in
  wallet service.

---

## 7. Verify ("team") code

`apps/auth-service/src/dispatch/verify-code.util.ts`:
`HMAC-SHA256(JWT_ACTION_SECRET, "<bookingId>:<leadAgentId>:<10-min bucket>")` → first 32
bits → 6 digits. **Never stored; rotates every 10 min**; rotating the secret invalidates all
codes. Client reads via `GET /bookings/:id/verify-code` (owner-scoped; 400
`no_crew_assigned` without a lead — `mission_crew.is_lead=TRUE AND status<>'off'`); the lead
CPO reads the same derivation via `GET /agents/me/missions/:id/verify-code`.
**There is NO server-side check endpoint** — verification is human/visual only; nothing
posts a code back. Consequence: proof-gate check (5) cannot be implemented from existing
data. The negative path is `POST /bookings/:id/not-my-guard` (stamps the booking + raises a
booking-scoped SOS).

---

## 8. Notifications (the full matrix)

**Mechanism (privacy-first, P0-N8):** FCM payloads are **opaque** — `{eventId, eventClass}`
only. `booking-push-bridge.service.ts` stores the detail blob in Redis
(`push-event:<userId>:<eventId>`, TTL 900 s, recipient-bound) and publishes on
`push:events`; the client hydrates via `GET /events/by-id/:eventId` (JWT + recipient-bound)
then routes. A durable `notifications` inbox row is written OUTSIDE the Redis try/catch
(survives Redis outage). Opacity is pinned by `booking-push-bridge.opacity.spec.ts`.

**Server → recipient events:** agency: `dispatchOffer`, `missionResponse`,
`missionCancelledByClient`, `missionCompleteRequested`, `disputeOpened`, `payoutSettled`,
`hourlyCheckinAgency` · client: `providerAccepted`, `noProvider`, `agencyNoShow`,
`bookingReDispatching`, `paymentFailed`, `bookingApproved/Rejected`, `bookingReminder`
(T-60), `crewAssigned`, `missionEnRoute`, `missionLive`, `bookingCompleted`,
`refundIssued`, `disputeResolved`, `hourlyCheckin` · CPO: `missionDispatched`,
`missionAborted`, `agentDecided`, `payoutSettled`, `sosAlert` (all other crew + principal) ·
family: `familyChargeBlocked` (member AND holder), invites · Pro: 7 `pro*` kinds ·
protection sessions: 5 `psession*` kinds · incident/enterprise kinds.

**Client-side routing** (`serverWakeNotifications.ts` 422 ln, `fcmBootstrap.ts`,
`routeServerWakeTap`): kind → channel (`booking-updates`, `dispatch-offers`, `sos-alerts`…)

- deep-link target (`CLIENT_STAGE_SCREEN`: e.g. `crew-assigned`/`detail-enroute`/
  `detail-live`/`provider-accepted` → `LiveTracking`; `booking-completed` →
  `MissionComplete`; `no-provider` → `NoDetail`; `dispatch-offer` → `IncomingOffer` always
  with `{bookingId}`; `sos-cpo-alert` → both CPO mission and client LiveTracking). Every
  `SecureTab` deep-link passes `initial:false` (cold-start back-stack seed, BB-3). Wake rows
  are also mirrored into the in-app Activity Center so a swiped banner isn't lost.
  `bookingId` from a push is shape-validated before navigation.

**Known notification history:** LM-N1..N5 (killed-app offer wake, no deep links, iOS zero
wakes, silent lifecycle events, dead realtime hook) are all marked fixed in the plan;
**iOS device proof is still owed** (LM-N3).

---

## 9. Data model (Postgres, all FORCE-RLS zero-policy)

| Table                                                                                                                                                                                             | Role                           | Key columns / constraints                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lite_bookings`                                                                                                                                                                                   | The booking row, both flows    | status enum, `dispatch_mode`, `assigned_provider_user_id`, `dispatch_settled_at`, `crew_deadline_at`, `arrival_deadline_at`, `payer_user_id` (family), `location_consent_at/version`, `terms_accepted_at/version`, `not_my_guard_at`, `requirements` jsonb, `pricing_breakdown`, `dispute_window_seconds` (unread!), `conversation_id` (Ops Room) |
| `lite_booking_audit`                                                                                                                                                                              | FSM audit                      | from/to status, actor id+role — historically missed cron transitions (LM-V6, fixed)                                                                                                                                                                                                                                                               |
| `dispatch_offers`                                                                                                                                                                                 | The cascade                    | rank, `distance_km`, status enum, `expires_at`; partial uniques `dispatch_offers_one_live_per_booking`, `dispatch_offers_one_live_per_provider`                                                                                                                                                                                                   |
| `escrow_holds`                                                                                                                                                                                    | Money                          | `booking_id` UNIQUE, gross/to_provider/to_client/platform_fee credits, status, `release_eligible_at`, `review_required`, basis                                                                                                                                                                                                                    |
| `booking_disputes`                                                                                                                                                                                | Disputes                       | `booking_disputes_one_open` partial unique                                                                                                                                                                                                                                                                                                        |
| `missions`                                                                                                                                                                                        | Mission FSM                    | `booking_id` + partial unique `missions_booking_active_uq WHERE status<>'ABORTED'` (the LM-B1 fix enabling re-dispatch), `pickup_at`, `live_at`, `short_code`                                                                                                                                                                                     |
| `mission_crew`                                                                                                                                                                                    | Crew                           | PK (mission, agent), `is_lead`, `call_sign`, status; partial unique: one active mission per agent                                                                                                                                                                                                                                                 |
| `mission_payouts`                                                                                                                                                                                 | Payout ledger                  | unique (mission, agent)                                                                                                                                                                                                                                                                                                                           |
| `mission_waypoints`, `mission_telemetry`, `mission_telemetry_last`, `mission_hourly_checkins`, `mission_principals`                                                                               | Telemetry/exec                 | last-position purged 24 h post-terminal                                                                                                                                                                                                                                                                                                           |
| `agents`                                                                                                                                                                                          | Provider + CPO registry        | `region_code`, `last_location` (GiST), `last_location_mocked`, `on_duty`, `dpa_accepted_at/version`, offer counters, `acceptance_rate`, `cooldown_until`, `reliability_breaches`, rating, `jobs_total`                                                                                                                                            |
| `compliance_credentials`, `armed_authorizations`                                                                                                                                                  | Eligibility inputs             | licence/insurance per region, expiry, verified; armed permits                                                                                                                                                                                                                                                                                     |
| `wallet_balances`, `wallet_transactions`, `wallet_credit_batches`                                                                                                                                 | Ledger                         | platform accounts `…e5` (escrow) / `…fe` (fees) seeded as rows; tx types incl. `escrow_hold/refund/release`                                                                                                                                                                                                                                       |
| `vehicle_pool`                                                                                                                                                                                    | Lite fleet (legacy assignment) | region/capacity/status                                                                                                                                                                                                                                                                                                                            |
| `pro_applications`, `pro_proposals`, `pro_plan_missions`, `pro_application_events/messages`                                                                                                       | Pro plan                       | status CHECK, coverage, counts                                                                                                                                                                                                                                                                                                                    |
| `pro_cpo_assignments`                                                                                                                                                                             | Pro staffing                   | `mission_code` UNIQUE (PMC-XXXXXX), gist no-overlap                                                                                                                                                                                                                                                                                               |
| `pro_fleet_vehicles`, `pro_resources`, `pro_vehicle_assignments` (gist no-overlap), `pro_resource_assignments`                                                                                    | Issue-30 fleet                 | resource `identifier` (serial) never projected to clients                                                                                                                                                                                                                                                                                         |
| `family_members`, `family_member_locations`                                                                                                                                                       | Family seats                   | one-active-per-member unique, spend limits/spent                                                                                                                                                                                                                                                                                                  |
| `incident_reports/_events/_attachments/_attachment_keys`                                                                                                                                          | Incidents                      | per-recipient wrapped keys                                                                                                                                                                                                                                                                                                                        |
| `cpo_shifts`, `cpo_shift_sessions`, `cpo_roster_months`, `attendance_corrections`                                                                                                                 | Attendance                     | one open session per CPO                                                                                                                                                                                                                                                                                                                          |
| `org_members`                                                                                                                                                                                     | Roster                         | member_role manager/cpo/employee, department, module_permissions                                                                                                                                                                                                                                                                                  |
| `dispatch_room_intents`, `dispatch_room_crypto_claims`                                                                                                                                            | Ops-Room E2EE                  | server never holds keys                                                                                                                                                                                                                                                                                                                           |
| `invoices` + `invoice_sequences`, `service_pricing`, `plan_catalog`, `notifications`, `ops_audit`, `org_audit_log`, `stripe_processed_events`, `provider_referral_codes`, `provider_invite_codes` | Supporting                     | numbered receipts; ops-editable pricing                                                                                                                                                                                                                                                                                                           |

SQL functions: `is_eligible_for_dispatch(uuid,text,jsonb)` (includes the DPA predicate),
`has_free_cpo_capacity(uuid,int)`, `lite_bookings_fsm_check()` — all
`SET search_path = pg_catalog`.

---

## 10. Background jobs (all Redis-locked `setInterval`)

| Sweep                    | Interval | Effect                                                                                             | Gated by AUTO_DISPATCH? |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------- | ----------------------- |
| `offer-expiry`           | 8 s      | expire lapsed/off-duty/stale-holder offers → cascade                                               | yes                     |
| `crew-sla`               | 60 s     | CONFIRMED+auto, deadline passed, no mission → AGENCY_NO_SHOW + refund                              | yes                     |
| `arrival-noshow`         | 60 s     | DISPATCHED, no pickup past deadline → re-dispatch (hold stays HELD)                                | yes                     |
| `relist-timeout`         | 60 s     | offer-less DISPATCHING > 60 min → NO_PROVIDER + refund                                             | yes                     |
| `scheduled-dispatch`     | 60 s     | 'later' OPS_APPROVED → DISPATCHING at T-15                                                         | yes                     |
| `dispatch-slo`           | 60 s     | SLO breaches → Sentry (stuck DISPATCHING, dead watchdog, zero-supply region)                       | yes                     |
| `dispatch-privacy-purge` | 5 min    | 24 h redactions/purges                                                                             | yes                     |
| `escrow-release-sweep`   | 60 s     | PENDING_RELEASE past window → settle                                                               | yes                     |
| `escrow-reconciliation`  | 24 h     | read-only money-invariant audit                                                                    | yes                     |
| `payment-pending-expiry` | 60 s     | 15-min PAYMENT_PENDING → CANCELLED                                                                 | no                      |
| `booking-reminder`       | 60 s     | T-60 client push                                                                                   | no                      |
| `mission-drift-janitor`  | 10 min   | close missions orphaned under terminal bookings; expire stale-uncrewed (60 min) → CANCELLED+refund | no                      |
| `wallet-expiry`          | 1 h      | 12-month credit-batch expiry                                                                       | env-disable             |
| `pro-lapse`              | 1 h      | ACTIVE → EXPIRED                                                                                   | —                       |

Liveness: watchdog `last_run` keys feed `/ready` (503 when the offer sweep is stale and
auto-dispatch is on) and `/metrics` gauges. **⚠️ Every dispatch-critical sweep is
flag-gated: if `AUTO_DISPATCH_ENABLED` is on but the sweeps misbehave, `/ready` is the
detection path; if the flag is off, none of them run at all.**

---

## 11. Auth, roles, org scoping

Three trust tiers, never conflated:

| Tier           | Truth source                                                                | Guard                                                                               |
| -------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| HQ ops staff   | `admin_users` (re-read per request) — roles `OPS < SUPERVISOR < ADMIN`      | `AdminGuard` + `@RequireRoles` (+ `CsrfGuard`)                                      |
| Agency manager | `agents(type='company')` / workspace owner / `org_members(manager, active)` | `OrgManagerGuard` — no role tiers; **no subscription-tier admission arm by design** |
| CPO device     | `agents` + session                                                          | `CpoSessionGuard`                                                                   |

- Client booking routes: `JwtAuthGuard` + owner-scoped SQL (`WHERE client_id = $2`).
- Money/override ops routes require `SUPERVISOR|ADMIN`; killswitch write and user-erase are
  `ADMIN` only; `ADMIN` is a global region bypass while `OPS/SUPERVISOR` are region-locked
  (`assertRegionScope`).
- Multi-org: `X-Org-Context` header **narrows** the caller's real membership set, never
  grants; cross-tenant asserts (`assertOrgScope`, inline `provider_user_id !== org →
403 org_scope_violation`) run **before** status checks so foreign callers can't probe
  offer state.
- Note for auditors: `SUPERVISOR/ADMIN` are ops-console roles; agency-side roles are
  `manager|cpo|employee` on `org_members`. Don't conflate.
- Stripe webhook is unauthenticated by design (HMAC signature verification).
- Rate limits: `/dispatch/request` 5/min; offer routes 10–30/min; `UserThrottlerGuard`.

---

## 12. Mobile client inventory (condensed)

### Screens (all paths under `src/screens/`)

- **Booking wizard + post-confirm** (`booking/`, ~27 files): `BookingHomeScreen` (shell Home
  tab for Lite), `ServiceTypeScreen` (Book tab), `ZoneMapScreen`, `BookingDateTimeScreen`,
  `LocationPickerScreen`, `BaselinePackageScreen`, `CustomizeAddOnsScreen` (**the
  consolidated Secure Transfer dashboard**, W5b), `CreditPaywallScreen` (3 doors via
  `source` param), `FindingDetailScreen` (DISPATCHING poll, 5 s/5-min cap),
  `AgencyAcceptedScreen`, `NoDetailScreen` (NO_PROVIDER), `BookingConfirmationScreen`,
  `SecureSummaryScreen` (Summary tab), `BookingHistoryScreen`, `TripSummaryScreen`,
  `MissionCompleteScreen`, `RateAgencyScreen`, `InvoiceScreen`. Pure logic:
  `bookingStatus.ts` (see §3.1), `pricing.ts` + `servicePricingOverrides.ts` (client
  PREVIEW mirror of server pricing, hydrated from `GET /bookings/service-pricing`),
  `creditMath.ts`/`creditErrors.ts`, `bookingSummaryRows.ts` (B-617: renders server echo
  only), `missionJourney.ts`.
- **Executive wizard** (`executive/`): 6 screens consolidated into `ExecReviewScreen`
  dashboard (W5c) + pure pricing helpers.
- **Ops-gate client screens** (`ops/`): `OpsRoomReviewScreen` (PENDING_OPS wait),
  `OpsDashboardScreen`/`OpsMissionDetailScreen`.
- **Live ops** (`liveops/`): `LiveTrackingScreen` (1740 ln — Mapbox WebView, verify-code
  panel, "Not my guard", SOS, backoff poll ladder 5 s→60 s, 30-min cap then 30 s slow
  poll — LB-ST3 fix), `SOSScreen` (3-s hold).
- **Secure Pro client** (`securepro/`): `SecureLandingScreen` (tier resolver),
  `secureRoot.ts` (**`secureRootRoute()` now constantly returns `'SecureShell'`** — B-661:
  one shell for everyone, tier decides the Home tab content), `SecureServicesScreen` (plan
  chooser: Pro + Lux, Lite card removed per founder D3), apply/status/proposal/payment/
  members/calendar/missions screens, `useProAppRealtime` (socket push-over-poll).
- **Pro dashboard** (`pro/`): `ProDashboardScreen` (ACTIVE-plan hub, rendered as shell Home
  for Pro), `ProLiveMissionScreen` (protection sessions), `ProAssignedTeamScreen` (team +
  Issue-30 fleet/resources; serial never rendered), `ProtectionHistoryScreen`,
  `TierPaywall*` (messenger tiers — NOT Secure Pro; naming trap).
- **CPO shell** (`cpo/`): `OnDutyHomeScreen` (duty toggle + heartbeat),
  `AssignedMissionDetailScreen` (the ONE lead-only advance button via `missionAction.ts` +
  `useMissionAdvance.ts`), `useLeadTelemetry.ts` (see below), activation/access-ended,
  CPO protection-session screens (server-computed staleness ladder).
- **Agency portal** (`agent/`, ~40 files): 9-screen onboarding + `AgentInviteCodeScreen`
  (the only door onto a roster), `IncomingOfferScreen` (30-s countdown bound to server
  `expires_at`) + `IncomingOfferWatcher` (5-s foreground poll, 500 ms first tick),
  `JobPortalScreen`/`JobMarketplaceScreen`, `MissionLeadConsoleScreen` (waypoints +
  manual marks), `AgentLiveTrackerScreen` (2152 ln, also mounted as `CpoLiveTracker`),
  `OrgMissionsScreen` (assign-crew sheet), roster/earnings/hierarchy/region/compliance/
  attendance screens.
- **Wallet + activity** (`wallet/`, `activity/`): the top-up / payment-methods /
  transactions surface (all booking money flows through it) and the Activity Center
  (durable in-app notification feed that mirrors every push wake).

### Navigation

`resolveAuthedRoute()` (pure, `src/navigation/resolveRoute.ts`) forks
`access-ended | cpo-activation | cpo-onboarding | cpo | agency | client` **off the server
`account_kind`** — capability hiding is structural (a CPO shell simply has no booking/
wallet/org routes registered). Client shell: root tabs `MessengerTab` + `SecureTab`
(`BookingNavigator` — ONE flat native stack of ~62 registered routes, `BookingHome` seeded
at the bottom). `SecureShell` (`SecureTabNavigator.tsx`) = 4 leaf-tabs Home/Book/Summary/Messenger
mounted INSIDE BookingNavigator; tabs are leaves so deeper navigation bubbles up and no
route duplicates (W5d). `secureFlowTab.ts` decides which tab the root footer lights for
deep routes (B-612). Product switch remounts via `activeProduct` keying.

### Stores

`bookingStore` (draft/bookings/activeBooking — **in-memory only; app kill loses the
draft**; resume relies wholly on server rows + `resumeTargetFor`), `secureProStore`
(fail-closed Pro gate; reset on signOut — was a cross-user PII leak, W2),
`walletStore`, `servicePricingStore` + `planCatalogStore` (fail-open hydration),
`productStore` (persisted `bravo:product`), `activityStore` (persisted notification
center), `emergencyCallLog` (persisted SOS/emergency call log), `pendingProvider` /
`pendingTier` (onboarding holds), `adoptOrgContext` + `activeWorkspace` (the mobile half
of the multi-org `X-Org-Context` narrowing in §11), `entitlements` (render-only mirror;
server guards authoritative).
Consent versions `LOCATION_CONSENT_VERSION`/`TERMS_VERSION = '2026-06-22'` are
**hardcoded in `bookingStore.ts`** and stamped onto auto bookings.

### GPS / telemetry reality (important for any "live tracking" audit claim)

- **Lead CPO (`useLeadTelemetry`)**: the ONLY background-capable path — Android foreground
  service (`missionForegroundService`), 5-s min push interval + 15-s stationary heartbeat →
  `POST /agents/me/missions/:id/telemetry`. Active only for the lead on a live mission.
- **Client (`clientPing`)**: foreground-only, ~10-s throttle, only while LiveTracking is
  focused and mission live.
- **On-duty heartbeat** (`onDutyHeartbeat.ts`): 45-s `PATCH /agents/me/location` with
  `is_mocked` anti-spoof — but `acquireKeepAlive/releaseKeepAlive` are **TODO no-ops**, so
  it is **foreground-only in practice** (file header says so). This feeds the dispatch
  ranking freshness gate — a backgrounded agency app goes stale in 5 min and silently
  drops out of the candidate pool.
- **Pro protection sessions** (`protectionLocationService.ts`): foreground-only **by
  founder decision (v1)**, batched queue flush every 10 s, offline catch-up, coords never
  logged. CPO mirror via `cpoPing`.
- Agency/CPO tracker maps: 4-s foreground polls; own position from a shared
  `ownPositionBus` (1 Hz nav cadence / ambient fallback).

### Client-side test coverage

`booking` Jest project = **only** `src/screens/booking/__tests__` (43 files) +
`src/screens/agent/__tests__` (30 files), pure-logic/source-scan, node env.
**Gap:** Secure-Pro, `pro/`, `cpo/`, `liveops/`, navigation, and store tests live in the
`app` project — `--selectProjects=booking` does NOT run them. Ops-console has no test
harness at all.

---

## 13. Backend test inventory (auth-service)

~95 spec files across the module: dispatch 18 (incl. `offer-expiry`, `crew-sla`,
`arrival-noshow`, `relist-timeout`, `claim-withdraw`, `dispatch-slo`, `verify-code.util`),
booking 22 recursive incl. `assignment/` (incl. `state-machine.drift`, `booking.escrow`,
`escrow-release-sweep`, `escrow-reconciliation`, `auto-dispatch-flag`), ops 21 (incl.
`booking-push-bridge.opacity`, `ops.service.concurrency`, `ops.service.sqli`,
`mission-drift-janitor`), org 9 (incl. `org-manager.guard`, `multiOrgContext`), money 4
(`wallet.service`, `settlement.service`, `stripe.client`, `idempotency.interceptor`),
agents 13 (incl. `proof-of-completion`, `agent.mission-finish`,
`agent.location-plausibility`, `agent.jobdetail-idor`), pro/family/attendance/incident 13+,
observability 2.

**Structural blind spot (repo-documented):** these are mocked-pg unit tests — **no test
executes real SQL**. A 2026-08-04 memory records 2,100 green tests missing 5 live
DB-only defects. Migrations/SQL behavior (FSM trigger, gist exclusions, partial uniques)
are pinned by SQL-text scans and mocks, not a real engine, except where noted in audit
docs. The known 3 pre-existing failures on some HEADs in booking-flow specs must be
confirmed pre-existing (stash + clean-HEAD run) before blaming a change.

---

## 14. Bug history (what already broke, and what it taught)

Full log: `sqa.md` (bug numbering runs through **B-684** at this HEAD; several hundred
logged entries). Module-relevant clusters:

- **B-82 / LB-\*** (client cluster, 2026-07-11 audit): 10 confirmed — verify-code card
  unreachable on resume (LB-OTP1), swallowed errors as permanent dots (LB-OTP2), dead OTP
  autofill (LB-OTP3), missing `is_lead` on legacy crew (LB-OTP4), token-wipe on network
  blip (LB-API1), swallowed poll errors (LB-API2), frozen dashboard/confirmation/
  completion routing (LB-ST1..ST4). **All fixed.**
- **LM-\*** (2026-07-05 deep audit, 827-line plan): 40+ findings across backend flow
  (LM-B1..B10: re-dispatch dead-end, dangling offers, dual advance paths, LIVE-cancel
  TOCTOU, unpaid-agency proof-gate, privacy leaks, cancel-window traps), money (LM-M1
  per-hour-shown-total-charged), notifications (LM-N1..N5), client/agency/CPO UX
  (LM-U*/A*/C*), validation (LM-V*). **Phases 0–6 all implemented + deployed.** Open
  remainders listed in §15.
- **Driver-nav + client-deck lanes (B-505..B-545):** 40 findings from founder screenshot
  decks — all fixed except two decision-gated items (§15).
- **Aug-2026 client-PDF program (W1–W5 + Issue 30 + B-612..B-622):** Pro landing, seat
  requests, fleet/resources, both wizards consolidated to single dashboards, Secure 4-tab
  shell, Messenger persistent bar. The program's core lesson: **"✅ in the tracker meant
  the wave landed, not that the client can see it"** — an independent re-audit found 11
  real client-visible gaps after all waves were "done".
- **Money bugs:** B-374/B-375 (family refunds credited the wrong party), LM-M5 (legacy
  completion minted unbacked credits), B-76 (session-revoke killed mission finish).
- **Ops incidents:** B-376 (a stale-checkout deploy script **wiped ~6 weeks of
  auth-service code off staging**), B-388 (bookings list down for everyone).
- **Recurring defect classes** (fixed pointwise, **no lint/pin prevents reintroduction**):
  (a) _silent catch_ — swallowed errors rendering as permanent placeholder UI;
  (b) _status-source drift_ — screens keying off `booking.status` when only
  `mission_status` is live; (c) _duplicate-copy drift_ — one behavior, N drifted copies
  (tier vocabulary existed in four places, B-589).

---

## 15. Currently OPEN items (the audit's starting backlog)

**Code-level, known and deliberate:**

1. **B-517 (P2, deliberately deferred):** a second, less-gated path into `PICKUP` —
   `MissionLeadService.markWaypoint('PICKUP')` bypasses the deployment-checks gate and the
   geofence warning; on the agent build it is currently the _only_ path into PICKUP.
2. **B-640 (root-caused, fix NOT shipped):** Ops-Room "Call failed" — `addGroupMember`
   resolves even when inline key delivery reached zero members; intent acked `done`,
   member seated keyless, call dies at the 25-s key gate.
3. **Proof-gate check 5 is a permanent pass** (§6) and cannot be implemented — no endpoint
   accepts a verify-code submission.
4. **Mission FSM bypass by all sweeps** (§3.2) — SYSTEM transitions undeclared, raw UPDATEs.
5. **`lite_bookings.dispute_window_seconds` never read** (§6).
6. **`CREW_ASSIGN_SLA_MINUTES=15` hardcoded**; source comment says "tune before cut-over".
7. **NO_PROVIDER has no fallback** beyond hotline escalation (`TODO(LB13)`).
8. **`clawbackReleasedHold` can drive the platform-fee account negative** with no
   automated recovery (documented "withhold from future payouts", unenforced).
9. **Staging bypass flags** `DISPATCH_TRUST_MOCKED_LOCATION` and
   `DISPATCH_DISABLE_REGION_FILTER` are single-env-var switches over the anti-fraud +
   compliance gates (double-guarded: boot refusal in production `main.ts`).
10. In-flight missions still ring as "MISSION MSN-… · OPS ROOM" (rename early-return +
    client name cache) — needs a backfill decision.
11. **Post-assignment cancel refund rule undecided** (`DISPATCH_CANCEL_FEE_PCT=0` ⇒ full
    refund after crew committed).

**Business/ops-gated (block the flag flip, not code):** 12. **LM-M4:** platform fee %, cancel fee %, FX (3 disagreeing sources), VAT — all 0/demo,
awaiting finance sign-off. 13. **DPA acceptance has no UI/endpoint** — dispatch eligibility requires a DB-only stamp;
at last measurement only 2/34 agencies had it ⇒ 44% NO_PROVIDER. 14. Legacy-CPO `account_kind` backfill (24 rows) owed. 15. The **3-device manual smoke** (`apps/auth-service/test/smoke/3device-dispatch.md`) —
"the never-run cut-over blocker".

**Feature remainders (planned, not bugs):** F4 crew-edit/CPO-decline UI, F8 NO_PROVIDER
widen/retry + **deploying the already-built Dispatch Inspector** (`DISPATCH_INSPECTOR_BUILD_SPEC.md`),
F9 scheduled-booking surface, F10 share-trip (arch-gated), F12 mission timeline,
LM-C5's native background-location service (CPO GPS beyond the lead's FGS), LM-N3 iOS
device proof, Android location-FGS for protection sessions.

**Verification debt:** the entire W5 consolidation + Issue-30 mobile surface is
**device-verification OWED** (founder standing rule: not "fixed" until seen in a
post-install device log); mobile APK owed at the time of writing.

---

## 16. Deployment / environment facts

- **Staging:** a single docker-compose VPS (coordinates deliberately redacted from this
  external-bound copy; they live in the internal runbooks). The database is a managed
  Supabase pooler — the box's local postgres container is NOT the auth DB (a known
  deploy-time trap). A self-heal watchdog reverts drift against a pristine snapshot —
  **manual deploys must refresh the snapshot or be silently reverted**. The scripted
  deploy path needs rsync/WSL (absent on the dev machine); the manual tar/scp flow is the
  safe path (B-376 lesson: a stale-checkout scripted deploy once wiped ~6 weeks of
  auth-service code off staging).
- **Deploy order is HARD:** migration → auth-service → ops-console → mobile APK
  (old-server/new-client crashes are a known class, B-605).
- **Backend booking specs:** 3 pre-existing failures on some HEADs (§13).
- Quality gates: `npm run typecheck` ≤ 47 baseline; `npm test -- --selectProjects=booking`;
  `cd apps/auth-service && npm test`; module loop = `docs/runbooks/LITE_BOOKING_LOOP.md`
  (5 lanes × 3 devices + SQL probes + §6 regression watchlist — its §4 SQL probes are the
  canonical data-drift checks: status distribution, booking↔mission drift, stranded HELD
  holds, lead-less active missions, offer rot).

---

## 17. What an auditor should probe (prioritized)

1. **Money conservation under concurrency and partial failure.** Accept-txn vs cancel vs
   crew-SLA vs arrival-no-show racing on one booking; withdraw-then-relist keeping the hold
   HELD across a NO_PROVIDER refund; clawback with an under-funded agency; family payer
   re-resolution at charge time; double-settle via sweep + client confirm-complete racing
   (idempotent index is the only barrier). The reconciliation cron is read-only — verify it
   would actually catch each class.
2. **The FSM seams.** Actor-blind DB trigger vs TS FSM; sweeps bypassing the mission FSM;
   the CONFIRMED-while-live seam (any new screen or endpoint keying on `booking.status`);
   terminal-state races (cancel vs accept at the DISPATCHING→CONFIRMED boundary — covered
   by conditional UPDATEs, but every new write path must repeat the pattern).
3. **Eligibility/compliance gate integrity.** `is_eligible_for_dispatch` is one SQL
   function called from the ranker AND the portal claim; the staging bypass flags disable
   it wholesale; DPA has no product surface. Probe: can any path (legacy job board, ops
   dispatch) seat a non-eligible agency? Ops force-assign is `SUPERVISOR|ADMIN`, IS
   audited (`dispatch.force_assign`), and by its controller contract binds the booking to
   its **current live offer** and runs the real accept saga (escrow charge included) — so
   the open probes are narrower: can it act on an expired/lapsed offer, and can any
   force-assign target exist that never passed the ranker?
4. **Verify-code trust model.** Unstored HMAC, 10-min rotation, no server check, no replay
   protection needed — but the client card's failure modes were a P0 cluster once (LB-OTP\*),
   and check-5 of the proof gate silently passes forever. Is a visual-only code an
   acceptable identity control for a protection product?
5. **Location trust.** `last_location_mocked` is self-reported by the client
   (`is_mocked` from the RN geolocation lib); plausibility test exists
   (`agent.location-plausibility.spec.ts`) — probe spoofing beyond the mock flag (rooted
   device, replayed pings) and the proof-gate's 150-m arrival check as a payment gate.
6. **Push/privacy envelope.** Opaque event ids (P0-N8) + coarse pre-accept offers +
   boolean-only requirement flags + 24-h redactions — verify no other surface (ops
   endpoints, org endpoints, logs, invoices, Dispatch Inspector read models) leaks
   principal PII to agencies pre-accept or post-terminal.
7. **AuthZ matrix.** IDOR checks ordered before status checks (probe-resistance) — verify
   uniformly across newer surfaces (pro-fleet, attendance, incidents, room-intents,
   protection sessions). Multi-org `X-Org-Context` narrowing. Region-scoped ops roles vs
   global ADMIN. The B-610 incident-report org leak already happened once in this family.
8. **Sweep/watchdog failure modes.** Every dispatch-critical transition depends on a
   flag-gated `setInterval` + Redis lock; probe Redis outage (locks unobtainable, pub/sub
   lost — does an OPS_APPROVED 'now' booking ever dispatch?), clock skew, batch starvation
   (50/sweep), and the SLO service's coverage of each.
9. **Client resilience.** In-memory-only booking draft/stores (kill = lost draft — is
   that acceptable UX?); poll-ladder caps; killed-app wake → deep-link on every lifecycle
   event (LM-N matrix); foreground-only GPS everywhere except the lead (the ranking
   freshness gate makes backgrounded agencies silently invisible — supply-side dropout).
10. **Test-reality gap.** Mocked-pg suites (no real SQL), no ops-console harness, `booking`
    Jest project not covering pro/cpo/liveops screens, device verification owed on the
    entire W5 surface, the 3-device smoke never run. An audit should treat "green suite"
    as weak evidence for anything DB- or device-shaped, per this repo's own documented
    history (B-125, DB-only defect memory).

---

## 18. Companion documents (for deeper pulls)

| Doc                                                        | What it holds                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| `docs/runbooks/LITE_BOOKING_LOOP.md`                       | The module verification loop (5 lanes, SQL probes, sign-off) |
| `docs/runbooks/BOOKING_TO_PAYMENT.md`                      | File/endpoint/column trace, tap → GPS fix                    |
| `docs/planning/LITE_MISSION_AUDIT_AND_IMPROVEMENT_PLAN.md` | The 827-line deep audit + fix program (LM-\*)                |
| `docs/audits/LITE_BOOKING_CLIENT_BUGS_AUDIT_2026-07-11.md` | The LB-\* client cluster (B-82)                              |
| `docs/qa/SQA_AUTO_DISPATCH_LIFECYCLE.md`                   | Engine lifecycle + §8 dark surfaces + §10 flag-flip blockers |
| `docs/qa/LITE_BOOKING_SIMULATION_A_TO_Z.md`                | Non-technical 3-device happy-path walkthrough                |
| `docs/planning/UBER_DISPATCH_PLAN.md`                      | The original 28-step build plan                              |
| `docs/planning/SECURE_SERVICES_CHANGES_2026-08.md`         | The Aug-2026 client-PDF program (W1–W5)                      |
| `docs/planning/PRO_FLEET_RESOURCES_ISSUE30.md`             | Pro fleet/resources contract                                 |
| `docs/planning/PROTECTION_SESSIONS_SPEC.md`                | Protection sessions build spec                               |
| `docs/handoffs/DISPATCH_INSPECTOR_BUILD_SPEC.md`           | Built-but-undeployed ops inspector                           |
| `docs/handoffs/AUTO_DISPATCH_BUGFIX_GUIDE.md`              | Bugs 1–7, fixed, "do NOT re-fix"                             |
| `sqa.md` (repo root)                                       | The full bug log (numbered through B-684)                    |
| `apps/auth-service/src/dispatch/README.md`                 | The cron/lock convention                                     |

---

_End of brief. Compiled 2026-08-28 from three independent source sweeps (mobile, backend,
docs/bug-history) and adversarially reviewed before publication._
