claud

# Lite Mission Module — A-to-Z Audit, Fix, Improvement & Feature Plan

> **DELIVERY STATUS (2026-07-05, same day):** Phases 0–6 + F3 are IMPLEMENTED
> (commits `5fb8f87`→`d21f2f4`): every P0/P1 bug in §3 is fixed, the
> notification backbone (§3.3), client/agency/CPO packs (§3.4–3.6), the
> invoice system (F1), completion moment (F2), org earnings (F6) and the
> verify-your-guard handshake (F3) shipped. Auth-service 92/92 suites green;
> mobile tsc at the 47-error baseline (0 new).
> **Remaining (additive features, not bugs):** F4 crew-edit UI (the LM-C7
> request/confirm-completion fallback DID ship), F8 NO_PROVIDER widen/retry +
> exclusion counters, F9 scheduled-booking surface, F10 share-trip (arch-gated),
> F12 audit timeline, LM-C5's native background-location service, and the
> finance-gated fee/FX/VAT values (config paths exist, values ship 0).
>
> **Rollout state: COMPLETE (2026-07-05).** Supabase migrations applied; Contabo
> auth + messenger containers rebuilt from the new sources and verified healthy
> (/ready green, 0 boot errors, all dispatch sweepers running); the temporary
> `missions_booking_id_bridge` compat index was dropped post-deploy, leaving only
> `missions_booking_active_uq` (LM-B1 fully active); APK v1.0.99 (vc125)
> distributed to Firebase QA. Device QA per §8 is the remaining human step.

**Date:** 2026-07-05 · **Status:** implemented through Phase 6 + F3 (see box above)
**Scope:** the "Lite" Uber-style mission flow: client requests a protection detail
(`lite_bookings`) → auto-dispatch offers it to agencies (`dispatch_offers`) → agency
accepts and assigns a crew (`missions` + `mission_crew`) → lead CPO runs the mission
(DISPATCHED → PICKUP → LIVE → COMPLETED) → escrow settles to the agency
(`escrow_holds` → `mission_payouts`).
**POVs covered:** Client · Agency (service provider) · CPO — plus money, invoice,
notifications, and admin/ops surfaces.
**Method:** six parallel code audits (backend lifecycle, client UI, agency UI, CPO UI,
money+notifications, known-issues docs) + direct SQL against the live staging DB.
Every finding cites `file:line`. Design principle honored throughout: **keep the
existing visual design** — new screens copy existing patterns (`MissionStepper`,
card/pill styles, existing navigators).

**Companion docs (do not duplicate, cross-checked):**
`docs/qa/SQA_AUTO_DISPATCH_LIFECYCLE.md` (current engine state, §8 dark surfaces,
§10 cut-over blockers), `docs/handoffs/AUTO_DISPATCH_BUGFIX_GUIDE.md` (Bugs 1–7 —
**all fixed, do not re-fix**), `docs/planning/UBER_DISPATCH_PLAN.md` (original 28-step spec),
`docs/planning/BATCH_FIX_AND_FEATURE_PLAN.md` (2026-06-25 backlog — superseded by
this doc where they overlap), `docs/audits/BACKEND_AUDIT.md`.

---

## 0. Executive summary

The auto-dispatch engine is **substantially built and mostly race-safe** (offer
uniqueness, double-charge guards, IDOR checks, escrow conservation all verified
sound), but the module as a _product_ has three kinds of problems:

1. **Latent flow-killers in the backend** — 4 high-severity bugs that dead-end a
   booking or the money attached to it (§3, LM-B1…LM-B4). The worst: after an
   arrival no-show re-dispatch, **no agency can ever crew the booking again** and
   the client's escrow is stuck `HELD` forever.
2. **A silent, poll-driven UX** — no booking/mission push reaches a backgrounded
   client; offers only reach a _foregrounded_ agency app; no push anywhere
   deep-links; iOS receives zero lifecycle wakes; three screens can dead-end in
   forever-spinners. "Uber-smooth" fails mostly here.
3. **Money/paperwork is placeholder-grade** — platform fee 0%, cancel fee 0%, demo
   FX, price shown to the client is **per-hour** while the charge is the **total**,
   and there is **no invoice/receipt anywhere** (dead button + never-written
   `invoice_pdf_url` column).

**Live staging evidence (queried 2026-07-05):** 171 lite bookings → **76 (44%)
died `NO_PROVIDER`** (only 2 of 34 agents have accepted the DPA → candidate pool ≈
empty), 63 CANCELLED, 19 COMPLETED. 21 offers EXPIRED vs 10 ACCEPTED, **0
REJECTED** (decline flow effectively unused). 8 missions stuck (6 LIVE, 2
DISPATCHED, all 2026-04-24) with bookings still CONFIRMED — exactly the
booking↔mission drift that LM-B3 predicts, and no janitor exists to close them.
`invoice_pdf_url` set on **0/171** bookings. `lite_booking_audit` records only
client-actor transitions — every cron/dispatch/mission transition bypasses it.

**Top 10 actions** (full detail in §3–§6):

| #   | Item                                  | Why it's top-10                                                     |
| --- | ------------------------------------- | ------------------------------------------------------------------- |
| 1   | LM-B1 re-dispatch dead-end            | Booking + client money stuck forever after any arrival no-show      |
| 2   | LM-B3 dual mission-advance paths      | Agency silently never paid; booking/mission status drift            |
| 3   | LM-B2 cancel leaves offers dangling   | Cancelling client benches an innocent agency from all offers        |
| 4   | LM-B4 LIVE-cancel TOCTOU              | Client can cancel a live protection detail and strand the principal |
| 5   | LM-M1 price shown ≠ charged           | Client pays ~4× the number they saw at the paywall                  |
| 6   | LM-N1 offer push + deep-links         | Offers/missions/payouts unseen unless the app is open               |
| 7   | F2 completion + rating flow           | Mission "just disappears" on COMPLETED today                        |
| 8   | F1 invoice/receipt system             | Explicitly requested; column + button exist, feature doesn't        |
| 9   | F4 crew swap / CPO decline            | Sick guard = dead end for agency AND CPO today                      |
| 10  | NO_PROVIDER funnel (F8 + ops seeding) | 44% of demand dies with no recovery or observability                |

---

## 1. How the module works today (A-to-Z reference)

### 1.1 Actors and surfaces

| Actor               | Mobile surface                                                                                                                                                                      | Backend modules                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Client              | `BookingNavigator` → wizard, `FindingDetail`, `AgencyAccepted`, `BookingConfirmation`, `LiveTracking`, `TripSummary`, `RateAgency`                                                  | `booking/`, `dispatch/` (client-dispatch.controller) |
| Agency (SP org)     | `AgentNavigator` (account_kind `agency`): `AgentDashboard`, `IncomingOffer(+Watcher)`, `OrgMissions`, `OrgMissionDetail`, `AgentLiveTracker(mode monitor)`, `OrgRoster`, `Earnings` | `dispatch/` (offers), `org/` (org-mission, org-cpo)  |
| CPO (managed guard) | `CpoNavigator` (account_kind `cpo`): `OnDutyHome`, `AssignedMissionDetail`, `CpoLiveTracker`, Ops Room tab                                                                          | `agents/` (agent.service, mission-lead.service)      |
| Ops/admin           | ops-console (`jobs/` = LEGACY board; `bookings/`; dispatch-inspector built but not deployed)                                                                                        | `ops/`, `dispatch/dispatch-admin.controller`         |

Feature gating: `featureFlags.autoDispatch` = `AUTO_DISPATCH_ENABLED==='true'`
(`apps/auth-service/src/config/configuration.ts:103`) + Redis kill-switch
(`dispatch-killswitch.service.ts`) + per-user `auto_dispatch_enabled` on
`GET /auth/me`.

### 1.2 State machines (verified against code + live DB enums)

**`lite_bookings.status`** (`booking/state-machine.service.ts:3-14`):
`DRAFT → DISPATCHING → CONFIRMED → LIVE → COMPLETED`, with branches
`DISPATCHING → NO_PROVIDER`, `CONFIRMED → AGENCY_NO_SHOW` (crew SLA),
`CONFIRMED → DISPATCHING` (arrival no-show re-dispatch), `* → CANCELLED`
(window-gated). Legacy path: `DRAFT → PENDING_OPS → OPS_APPROVED → PAYMENT_PENDING → CONFIRMED`. DB-side FSM trigger: `lite_bookings_fsm_check()`
(latest `supabase/migrations/20260630000000_confirmed_to_completed_fsm.sql`) —
**more permissive than the TS map** (see LM-B4).

**`missions.status`** (`ops/mission-state-machine.service.ts:14-20`):
`DISPATCHED → PICKUP → LIVE → COMPLETED`, plus `→ SOS ↔` and `→ ABORTED`.
`missions.booking_id` is **UNIQUE** — one mission row per booking, ever
(root of LM-B1/LM-B9).

**`dispatch_offers.status`**: `OFFERED → ACCEPTED | REJECTED | EXPIRED | SUPERSEDED | CANCELLED`. TTL 30 s (`dispatch.service.ts:42`), max 8 offers per
booking (`:43`), 8-second expiry sweep with 2 s accept-grace
(`offer-expiry.service.ts:32`). Partial-unique indexes: one live offer per
provider AND per booking.

**`escrow_holds.status`**: `HELD → {REFUNDED | PARTIAL | PENDING_RELEASE}; PENDING_RELEASE → {RELEASED | DISPUTED}; DISPUTED → {RELEASED | REFUNDED | PARTIAL}` (`20260620000002_escrow_integrity.sql`).

### 1.3 Endpoint map (auto path)

| Step                | Endpoint                                                                                             | Effect                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request             | `POST /dispatch/request` (throttle 5/min, idempotent, kill-switch)                                   | DRAFT → DISPATCHING (`dispatch.service.ts:424-428`); `booking_mode='later'` stays DRAFT for the scheduled sweep                                     |
| Offer               | internal`offerNext` ranking SQL (`dispatch.service.ts:122-169`)                                      | inserts OFFERED; push`dispatchOffer` to agency                                                                                                      |
| Poll offer          | `GET /dispatch/offers/current` (OrgManagerGuard, coarse)                                             | —                                                                                                                                                   |
| Accept              | `POST /dispatch/offers/:id/accept`                                                                   | OFFERED→ACCEPTED, escrow HELD, DISPATCHING→CONFIRMED,`crew_deadline_at = NOW()+15min`, siblings SUPERSEDED (`:1035-1130`)                           |
| Reject              | `POST /dispatch/offers/:id/reject`                                                                   | REJECTED + cascade to next candidate                                                                                                                |
| Crew                | `POST /org/bookings/:bookingId/crew`                                                                 | creates mission DISPATCHED + crew + waypoints + deploy checks;`arrival_deadline_at = NOW()+20min` (`org-mission.service.ts:252-430`)                |
| Crew SLA            | cron 60 s                                                                                            | no mission by deadline → AGENCY_NO_SHOW + full refund (`crew-sla.service.ts:143-172`)                                                               |
| Arrival SLA         | cron 60 s                                                                                            | mission DISPATCHED with no pickup past deadline → mission ABORTED, booking → DISPATCHING re-offer (`arrival-noshow.service.ts:146-176`)             |
| Advance             | `POST /agents/me/missions/:id/pickup` / `go-live` / `complete` (lead-only)                           | stamps`pickup_at`/`live_at`; go-live flips booking → LIVE; complete flips both → COMPLETED and starts escrow release (`agent.service.ts:1250-1447`) |
| Advance (2nd path!) | `POST .../waypoints/mark`, `.../telemetry`                                                           | ALSO flips mission status but stamps nothing (`mission-lead.service.ts:85-90,195-200`) — LM-B3                                                      |
| Client finish       | `POST /bookings/:id/confirm-complete`, `/dispute`, `/rating`                                         | release / dispute / rating                                                                                                                          |
| Cancel              | `POST /bookings/:id/cancel`                                                                          | window-gated → CANCELLED + refund/split (`booking.service.ts:608-740`)                                                                              |
| Admin               | `/ops/dispatch/:id/cancel`, `/force-assign`, `/ops/bookings/:id/complete`, `/ops/missions/:id/abort` | supervised overrides                                                                                                                                |

### 1.4 Money flow (verbatim values)

- Quote: base **86 EUR/h** (350 AED), +25 %/extra CPO, +25 %/extra vehicle,
  driver-only ×0.65, add-ons per hour, **peak ×1.2 at UTC 17–20 (bug LM-M2)**,
  total = rate × hours (default 4 h). No armed premium (LM-M3). Itemized
  `breakdown[]` computed then **discarded** (`pricing.service.ts`).
- Charge: **credits only**, no Stripe at booking time. Escrow hold on accept
  (`holdToEscrow`, `wallet.service.ts:443-495`). Without `STRIPE_SECRET_KEY`,
  wallet top-ups mint credits for free (`wallet.service.ts:238-259`).
- Release: 60 s sweep after dispute window; pays the **agency org wallet only**
  (CPO split is agency-internal); platform fee **0 %** placeholder; cancel fee
  **0 %** placeholder; demo FX in **three** disagreeing places
  (`configuration.ts:135-171`, `wallet.service.ts:1265-1271`,
  `pricing.service.ts:46`). No fiat cash-out exists anywhere (no Stripe Connect).
- Refunds: full pre-crew, split post-crew (fee=0 ⇒ full), full on agency
  no-show, pro-rata on mid-LIVE admin abort. Conservation + idempotency verified
  sound; daily read-only reconciliation cron exists.

### 1.5 Notification matrix (today)

Pushes that exist: `dispatchOffer`(agency), `providerAccepted`/`noProvider`/
`agencyNoShow`/`bookingReDispatching`(client), `missionDispatched`/
`missionAborted`(CPO), `payoutSettled`(CPO, **legacy path only**), `sosAlert`,
`bookingApproved`(client, legacy), incident + KYC events.
**Silent:** escrow release → agency; completion → client; cancel/refund → both
parties; dispute open/resolve → both; booking rejected (card only); wallet
top-up. **No push tap deep-links** (only chat/call wakes route —
`fcmBootstrap.ts:549-563`). **iOS receives zero server wakes**
(`push.service.ts:289-290` filters `platform === 'android'`).

---

## 2. Live staging evidence (SQL, 2026-07-05)

| Probe                     | Result                                                                                                                                                                                                                        | Implication                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `lite_bookings` by status | NO_PROVIDER 76 · CANCELLED 63 · COMPLETED 19 · CONFIRMED 11 · OPS_APPROVED 2                                                                                                                                                  | 44 % of demand dies with no provider; funnel leak#1                                            |
| `agents` DPA              | **2 / 34** have `dpa_accepted_at` (2 regions)                                                                                                                                                                                 | Candidate pool ≈ empty. UI exists now (`OrgRegionScreen`) but adoption/seeding hasn't happened |
| `dispatch_offers`         | 21 EXPIRED · 10 ACCEPTED · 2 SUPERSEDED ·**0 REJECTED**                                                                                                                                                                       | Agencies let offers rot rather than declining → slower cascade for the client                  |
| Stuck missions            | 6 LIVE + 2 DISPATCHED (2026-04-24), bookings still CONFIRMED                                                                                                                                                                  | Booking↔mission drift is real in data; no janitor closes them                                  |
| `invoice_pdf_url`         | 0/171 non-null                                                                                                                                                                                                                | Invoice feature is a stub column                                                               |
| `lite_booking_audit`      | Only CLIENT/SYSTEM rows: DRAFT→PENDING_OPS(77), OPS_APPROVED→PAYMENT_PENDING(31), PAYMENT_PENDING→CONFIRMED(28), CONFIRMED→CANCELLED(17), DISPATCHING→CANCELLED(6), NO_PROVIDER→NO_PROVIDER(6),**141 rows with NULL from/to** | Dispatch/cron/mission transitions never audited; audit writer accepts null transitions         |

**Plan item LM-D1 (data hygiene):** one-off janitor + recurring sweep that closes
missions whose booking is terminal (or vice-versa) and flags drift to Sentry.
The 8 stuck April rows should be closed by that janitor, not by hand.

---

## 3. BUG REGISTER — root cause and fix plan

Severity: **P0** = breaks the flow or the money. **P1** = breaks the experience.
**P2** = polish. Every fix lands with: direct test + regression suite
(`npm test -- --selectProjects=booking` for backend; typecheck ≤ baseline 96) per
CLAUDE.md change-safety rules.

### 3.1 P0 — Backend flow/money correctness

---

**LM-B1 · Arrival no-show re-dispatch permanently dead-ends the booking** — P0

- **Symptom:** after `ArrivalNoShowService` re-dispatches (crew never arrived), a
  replacement agency accepts, then crew-assign always returns 409
  `booking_not_assignable`. Booking stuck CONFIRMED forever; escrow stuck HELD;
  neither SLA cron can rescue it.
- **Why (root cause):** `reDispatch` sets the old mission to `ABORTED` but never
  deletes it (`arrival-noshow.service.ts:160-164`), and `missions.booking_id` is
  UNIQUE. `assignCrew`'s tenant/state gate requires `NOT EXISTS (SELECT 1 FROM missions WHERE booking_id=$1)` (`org-mission.service.ts:274`) → UPDATE matches
  0 rows → falls into the "resume" branch, which only succeeds when crew members
  lack add-intents — but the _old_ agency's crew already have them → throws at
  `:391`. The `ON CONFLICT (booking_id) DO UPDATE` revive at `:329` is
  unreachable behind the gate. Watchdogs can't help: crew-SLA requires no
  mission (`crew-sla.service.ts:93`), arrival-SLA requires `DISPATCHED`
  (`arrival-noshow.service.ts:99`).
- **Fix plan (choose A; B is the fallback):**
  - **A (preferred, schema):** replace the UNIQUE on `missions.booking_id` with a
    partial unique `ON (booking_id) WHERE status <> 'ABORTED'`. `reDispatch`
    leaves the ABORTED row as history; `assignCrew` inserts a **fresh** mission.
    Update every "mission by booking" read (`getById`/`getTeam`
    `booking.service.ts:129-133,542-544`, org-mission list joins, ops queries) to
    pick the non-ABORTED row (`ORDER BY created_at DESC LIMIT 1` where needed) —
    note the code comments already _claim_ this model, so most call-sites read
    naturally after the change (this also retires LM-B9's false comments).
  - **B (no schema change):** make the `assignCrew` gate accept
    `EXISTS (mission WHERE status='ABORTED')`, use the `ON CONFLICT DO UPDATE`
    revive, and **clear** `ended_at/end_reason/pickup_at/live_at/started_at`,
    regenerate `short_code`, wipe old `mission_crew`, reset waypoints/deploy
    checks. Riskier: revived rows must not poison the proof gate (LM-B9).
  - Either way: add an integration test — request → accept → crew → arrival
    no-show fires → second agency accepts → crew succeeds → mission completes →
    escrow releases.
- **Files:** `arrival-noshow.service.ts`, `org-mission.service.ts`, migration,
  `booking.service.ts` reads, `crew-sla.service.ts` gate re-check.

---

**LM-B2 · Client cancel strands live offers; the correct cancel is dead code** — P0

- **Symptom:** client cancels while DISPATCHING → the outstanding `OFFERED` row
  stays live. The `one_live_per_provider` unique index then **benches that
  agency from every other booking's offers** until the expiry sweep happens to
  reap it; the agency also sees a phantom offer for a cancelled job.
- **Why:** the only wired cancel is `BookingService.cancel`
  (`booking.controller.ts:73`), which never touches `dispatch_offers`
  (`booking.service.ts:608-740`). The purpose-built `DispatchService.cancel`
  (`dispatch.service.ts:884-917`) supersedes offers correctly but **no
  controller calls it** — dead code.
- **Fix plan:** inside `BookingService.cancel`'s transaction, when
  `dispatch_mode='auto'`, supersede all non-terminal offers for the booking
  (reuse the SQL from `DispatchService.cancel`, or call into it with the shared
  txn client). Delete or repurpose the dead method to be _the_ implementation.
  Add a race test: offer OFFERED → client cancel → assert offer status
  CANCELLED/SUPERSEDED and the provider is immediately eligible elsewhere; also
  push `offer_cancelled` to the agency so the IncomingOffer screen flips to its
  existing "passed" state.
- **Files:** `booking.service.ts`, `dispatch.service.ts`,
  `booking-push-bridge.service.ts` (new event), agency watcher (no change — the
  3 s truth-poll already handles disappearance).

---

**LM-B3 · Two mission-advance paths diverge → escrow never auto-releases; booking/mission drift** — P0 (money)

- **Symptom:** if the lead advances the mission via **waypoints/telemetry**
  instead of the explicit Start/Go-live buttons, (a) the agency is silently
  never paid — the proof-of-completion gate flags `no_progression` and
  `review_required=TRUE`, which the release sweep skips forever; (b) the booking
  stays CONFIRMED while the mission is LIVE (exactly the drift observed in
  staging §2); (c) the client's realtime frame fires on this path but _not_ on
  the button path.
- **Why:** `pickup_at`/`live_at` are stamped only by
  `AgentService.flipMissionStatus` (`agent.service.ts:1372-1391`), which also
  flips booking status. But `MissionLeadService.markWaypoint` flips
  DISPATCHED→PICKUP (`mission-lead.service.ts:85-90`) and `pushTelemetry` flips
  PICKUP→LIVE (`:195-200`) **without stamping timestamps or advancing the
  booking**. The proof gate hard-requires both stamps
  (`proof-of-completion.service.ts:55`); failure → `review_required=TRUE`
  (`agent.service.ts:1438-1442`) → sweep excludes it
  (`escrow-release-sweep.service.ts:73`).
- **Fix plan:** extract one shared `advanceMission(missionId, to, actor)` helper
  (in `agent.service.ts` or a small `mission-progress.service.ts`) that: guards
  the FSM, stamps `pickup_at`/`live_at`, flips the booking (CONFIRMED→LIVE on
  go-live), emits the realtime `events.statusChanged` frame, and writes
  `lite_booking_audit`. Call it from _both_ `flipMissionStatus` and the two
  `mission-lead.service.ts` side-effect sites. Add tests: waypoint-driven
  mission completes → proof gate passes → sweep releases; button-driven mission
  emits realtime frame.
- **Files:** `agent.service.ts`, `mission-lead.service.ts`,
  `proof-of-completion.service.ts` (unchanged, now satisfied), events bridge.

---

**LM-B4 · Client can cancel a LIVE mission (TOCTOU + FSM drift)** — P0 (safety)

- **Symptom:** with unlucky interleaving (client taps cancel as the lead taps
  go-live), a **live protection detail is cancelled**: crew set `off`, client
  refunded, LIVE mission left un-aborted — principal stranded mid-mission.
- **Why:** three stacked causes. (1) The DB FSM trigger permits
  `LIVE→CANCELLED` (`20260630000000_confirmed_to_completed_fsm.sql:29`) while
  the TS `CANCELLABLE` set excludes LIVE (`state-machine.service.ts:69-71`) —
  drift means the DB won't catch what the app logic missed. (2)
  `BookingService.cancel` reads status **unlocked**, then runs
  `UPDATE ... SET status='CANCELLED' WHERE id=$1` with **no status guard, no
  FOR UPDATE** (`booking.service.ts:654`). (3) Its mission-abort filter only
  covers `('DISPATCHED','PICKUP')` (`:661-663`) so a just-went-LIVE mission is
  skipped, yet crew are still stood down (`:666-668`).
- **Fix plan:** inside the txn, `SELECT ... FOR UPDATE` the booking row first,
  re-check the status against `CANCELLABLE`, and make the UPDATE conditional
  (`WHERE id=$1 AND status = ANY(CANCELLABLE) RETURNING`). Tighten the DB
  trigger to remove `LIVE→CANCELLED` for non-ops actors (keep an ops/admin
  bypass path for `abort`). Add a concurrency test (two parallel txns:
  go-live vs cancel — exactly one wins).
- **Files:** `booking.service.ts`, new migration adjusting
  `lite_bookings_fsm_check()`, `state-machine.drift.spec.ts` (extend — the drift
  spec exists and missed this).

---

**LM-B5 · `assignCrew` double-confirm 409s instead of idempotent success** — P0→P1

- **Why:** the header comment claims idempotency (`org-mission.service.ts:248-250`)
  but a second confirm (different Idempotency-Key: second manager, retry after
  key rotation) hits the `NOT EXISTS(mission)` gate → resume branch → all crew
  already have add-intents → `ConflictException('booking_not_assignable')`
  (`:391`). Same mechanism that makes LM-B1 fatal.
- **Fix plan:** in the resume branch, when a mission already exists for the
  booking **and belongs to this org**, compare the requested crew set with the
  existing `mission_crew`; if equal → return the existing mission (200); if
  different → 409 `crew_already_assigned` (until F4 crew-editing lands). Unit
  tests for both.

---

**LM-B6 · Admin abort after lead-finish still pays the agency** — P0 (money policy)

- **Why:** `mission.service.ts:478-498` reverses money only when the hold is
  `HELD`. If the lead already completed (hold `PENDING_RELEASE`) an admin abort
  flips the booking CANCELLED but leaves the hold → release sweep pays the
  agency **in full for an aborted mission** (comment at `:462-467` acknowledges
  it).
- **Fix plan:** on abort with a `PENDING_RELEASE` hold, transition it to
  `DISPUTED` with `basis='admin_abort'` so it enters the existing dispute-resolve
  path (admin decides the split) instead of silently releasing. Test: complete →
  abort → sweep does NOT release; ops resolves.

---

**LM-B7 · Affordability: agency sees client's `insufficient_credits`; family members can't book** — P0 (privacy + correctness)

- **Why:** accept → `holdToEscrow` throws `insufficient_credits`
  (`wallet.service.ts:458-459`) which rolls back the accept and surfaces to the
  **agency** (`dispatch.service.ts:1082-1089`) — leaking client financial state
  and wasting the agency's accept. There is no submit-time affordability check
  (gap acknowledged at `dispatch.service.ts:405-410`). Separately,
  `holdToEscrow` debits `clientId` directly (`wallet.service.ts:454-475`) —
  unlike the legacy `payWithCredits` which resolves the **family payer**
  (`booking.service.ts:405-451`) — so family members structurally can't
  auto-book.
- **Fix plan:** (1) at `POST /dispatch/request`, resolve the payer
  (`family.resolvePayer`) and soft-check balance ≥ estimated total; reject with
  a client-facing `insufficient_credits` before any agency is involved; persist
  `payer_user_id` on the booking. (2) `holdToEscrow` debits the stored payer.
  (3) If the hold still fails at accept (balance changed), return a **generic**
  `booking_unavailable` to the agency, cancel dispatch, and push the client a
  "payment failed — top up and retry" wake. Tests for all three.

---

**LM-B8 · Cancel window keyed to `created_at` traps scheduled bookings** — P0→P1

- **Why:** cancel blocks when `now - created_at > cancelWindowHours` (1 h
  default, `booking.service.ts:619-627`). A `booking_mode='later'` job created a
  day ahead becomes un-cancellable an hour after creation — before dispatch even
  starts. Compounding: the one-active-booking gate counts DRAFT (`:195-210`), so
  the client is also locked out of any other booking.
- **Fix plan:** anchor the window to `dispatch_settled_at` (accept time) for
  auto bookings — free cancel any time before an agency accepts; post-accept the
  existing window + (future) cancel-fee policy applies. Allow scheduled DRAFTs
  to be cancelled unconditionally. Revisit whether DRAFT-'later' should count
  toward the active-booking cap (recommend: it counts, but cancellable).

---

**LM-B9 · False "fresh mission per re-dispatch" model in comments/reads** — P1 (folds into LM-B1)

`booking.service.ts:129-133,542-544` claim newest-mission-wins; UNIQUE makes it
false today. Fix A of LM-B1 makes the comments true — update the reads and
delete the stale comments as part of that change.

**LM-B10 · Lead cannot close an SOS mission** — P1

`missionComplete` allows only `LIVE` (`agent.service.ts:1268`) though the FSM
permits `SOS→COMPLETED` for AGENT (`mission-state-machine.service.ts:42`).
An SOS that de-escalates on the ground leaves the crew stuck; ops must close.
**Fix:** accept `['LIVE','SOS']` with a required `end_reason` when closing from
SOS + system-message to the Ops Room; keep ops override. (Pairs with F5 agency
SOS visibility.)

### 3.2 P0 — Money/pricing

**LM-M1 · Client sees per-hour, is charged total** — P0
Why: auto wizard never calls `estimatePrice`; `CustomizeAddOnsScreen.tsx:147`
stores `estimated_price = rateBc` (per-hour, `:119-130`), the paywall
affordability check and "PAID" figure reuse it
(`bookingStore.ts:232-238`, `CreditPaywallScreen.tsx:188,226`,
`BookingConfirmationScreen.tsx:326-332`), while escrow holds
`round(total_eur)` = rate × hours (`dispatch.service.ts:1067-1068`). Default 4 h
⇒ ~4× surprise. **Fix plan:** call `bookingApi.estimatePrice` (already used by
the non-auto `AddOnsScreen.tsx:68-96`) on the review step; store
`{rate_per_hour, duration_hours, total}` in the draft; run affordability + all
"PAID/DUE" displays off **total**; show the same line-item breakdown the server
returns (groundwork for F1 invoices). Test: paywall shortfall math for a 4 h
booking.

**LM-M2 · Peak surcharge fires on UTC hours** — P1
`pricing.service.ts:84` uses `getUTCHours()` for a "17:00–20:00 local" rule
(`:10`). **Fix:** per-region UTC offset map on `lite_booking_add_ons.region_code`
(or a `regions` table column) → convert pickup_time to local before the window
check; test AE (+4) and GB (+0/+1).

**LM-M3 · `armed_required` is free** — P1 (product/finance)
Armed is an eligibility gate, never a price line (`pricing.service.ts:22-29`).
**Fix:** add `armed_premium_pct` config (finance-signed) → include in breakdown.

**LM-M4 · Fee/FX placeholders** — P0 for cut-over, business-gated
`platformFeePct=0`, `cancelFeePct=0`, demo FX ×3 sources
(`configuration.ts:135-171`, `wallet.service.ts:1265-1271`,
`pricing.service.ts:46`). **Plan:** single FX source (config service or
`fx_rates` table with provenance) consumed by pricing AND wallet; finance
sign-off task (already tracked as a cut-over blocker); no code enables non-zero
values silently.

**LM-M5 · Legacy completion path mints unbacked credits + drops platform fee** —
P1 (legacy-only): `ops.service.ts:1249-1286`. Plan: fold legacy completion into
`SettlementService` or add the missing fee credit; low priority since auto path
replaces it.

### 3.3 P0/P1 — Notifications & realtime (the "smoothness backbone")

**LM-N1 · Offers don't reach a backgrounded/killed agency app** — P0
Why: `dispatchOffer` FCM wake is sent but the client never routes it —
`AGENT_WAKE_META` has no offer kind (`serverWakeNotifications.ts:57-64`,
watcher comment `IncomingOfferWatcher.tsx:5-6`), and the watcher polls only
while foregrounded (`:38`, 5 s cadence + 2.5 s first delay vs 30 s TTL).
**Fix plan:** add an `offer` wake kind → high-priority notifee notification with
full-screen intent + deep-link to `IncomingOffer`; shorten first poll to ~0.5 s;
keep the server-side TTL/truth-poll model unchanged.

**LM-N2 · No push tap deep-links; CPO/client land "wherever the app was"** — P0
Why: `fcmBootstrap.ts:549-563` routes only chat/call wakes;
`serverWakeNotifications.ts:117,150-153` uses default pressAction.
**Fix plan:** notification-tap router: wake kind → navigation intent
(`mission-dispatched`→CpoMission; `provider-accepted`/`re-dispatching`→client
booking screen; `payout-settled`→earnings; `sos-cpo-alert`→tracker;
`booking-approved`→BookingConfirmation). Use the existing `navigationRef`; cover
cold-start (queue the intent until nav ready — same pattern the messenger wake
uses).

**LM-N3 · iOS receives zero lifecycle wakes** — P0 (if iOS ships)
`push.service.ts:289-290` filters android-only; `fcmBootstrap.ts:135-138` never
prompts on iOS. **Fix:** include iOS tokens (FCM handles APNs) + request
permission; verify killed-app delivery on a device before claiming done.

**LM-N4 · Silent lifecycle events** — P1
Add pushes/cards for: mission complete → client ("rate & receipt" deep-link);
escrow released → agency (amount + booking ref, from
`settlement.service.ts:105-137`); refund issued → client (amount, reason) on
cancel/no-show/abort; dispute opened/resolved → both; booking rejected → client
push (`ops.service.ts:302` currently card-only); crew assigned → client
("your detail is being prepared" — `assignCrew` currently pushes CPOs only,
`org-mission.service.ts:425-427`). Each event: bridge method + wake meta + tap
route + test.

**LM-N5 · Client realtime is polling-only; `useBookingRealtime` is dead code** — P1
Decide one backbone: (a) wire the existing `events.statusChanged` frames (now
emitted from the shared helper after LM-B3) into a lightweight WS/SSE the client
already holds via messenger transport, or (b) delete `useBookingRealtime`
(`src/hooks/useBookingRealtime.ts`) and standardize on the poll pattern with the
fixes in §4. Recommendation: (b) now (polling is fine at this scale once
LM-U1/U2 land), (a) later with the ops-console WS namespace (BACKEND_AUDIT
BE-6.1).

### 3.4 P1 — Client UX

| ID    | Bug                                                                                                                                                                                | Why                                                                                                                                  | Fix plan                                                                                                                                                                                                   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LM-U1 | FindingDetail 5-min forever-spinner                                                                                                                                                | `HARD_CAP_MS` tick `return`s without rescheduling (`FindingDetailScreen.tsx:57`); back gesture disabled (`BookingNavigator.tsx:277`) | Keep polling at a slower cadence after 5 min; add "Still searching · Retry now / Cancel" affordance; server timeout will normally fire NO_PROVIDER first                                                   |
| LM-U2 | AgencyAccepted: no cancel, no cap, polls forever (`AgencyAcceptedScreen.tsx:44-63`)                                                                                                | Screen assumes crew-assign follows promptly                                                                                          | Add cancel button (same handler as BookingConfirmation) + after`crew_deadline_at` show "agency is taking long — keep waiting / cancel free" (deadline is already on the booking row — expose in `getById`) |
| LM-U3 | ABORTED unhandled on LiveTracking (`:230,238` branch only COMPLETED/CANCELLED)                                                                                                     | Stepper knows ABORTED, screen doesn't                                                                                                | Branch ABORTED → dedicated "Crew stood down — we're re-dispatching" interstitial that returns to FindingDetail when booking flips DISPATCHING (re-dispatch) or TripSummary (terminal)                      |
| LM-U4 | `AGENCY_NO_SHOW`/`DISPATCHING`/`NO_PROVIDER` missing from `BookingStatus` union (`types/index.ts:71-79`) and AGENCY_NO_SHOW missing from `bookingStatus.ts:17-31` → "UNKNOWN" chip | Type drift with server enum                                                                                                          | Add all server enum values to the union + CONFIG entry ("Agency didn't show — fully refunded"); add an exhaustiveness test against the server enum list                                                    |
| LM-U5 | Paywall "40% of required" hardcoded (`CreditPaywallScreen.tsx:331`)                                                                                                                | Copy/paste stub                                                                                                                      | Compute from`balanceProgress`                                                                                                                                                                              |
| LM-U6 | Resume auto-route yanks user on every Home focus after restart (`BookingHomeScreen.tsx:112-144`, in-memory `seenRef`)                                                              | Guard not persisted                                                                                                                  | Persist "dismissed resume for booking X" (AsyncStorage) or show a resume banner instead of auto-navigating                                                                                                 |
| LM-U7 | Poll errors swallowed (`FindingDetail:52`, `AgencyAccepted:35,58`, `NoDetail:33`)                                                                                                  | `catch {}`                                                                                                                           | Adopt the tracker's stale/reconnecting pattern (`AgentLiveTrackerScreen.tsx:128-341`) — after 3 consecutive failures show "reconnecting…" pill                                                             |
| LM-U8 | "View All" bookings button no-op (`BookingHomeScreen.tsx:307`), history capped 5                                                                                                   | Handler never written                                                                                                                | Small`BookingHistoryScreen` (list + status chips, existing card style) — pairs with F1 receipts                                                                                                            |
| LM-U9 | Live map a11y: WebView with no labels, color-only status                                                                                                                           | —                                                                                                                                    | `accessibilityLabel` on status pills/ETA; `accessibilityRole="button"` on EMERGENCY; text alternative line under the map ("Detail is 4 min away")                                                          |

### 3.5 P1 — Agency UX

| ID    | Bug                                                                                                                                                                                                         | Why                                                    | Fix plan                                                                                                                                                                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LM-A1 | OrgMissions board loads once; detail screen renders a frozen nav-param snapshot (`OrgMissionsScreen.tsx:135`; `OrgMissionDetailScreen.tsx:52`, `types.ts:289`)                                              | No focus/interval refresh; full object passed as param | Pass`booking_id` only; detail fetches + 8 s poll (reuse dashboard pattern `AgentDashboardScreen.tsx:235`); board gets `useFocusEffect` refresh                                                                                                             |
| LM-A2 | Failed decline traps offer (watcher`handled` set + screen backs out) (`IncomingOfferScreen.tsx:115-121`, `IncomingOfferWatcher.tsx:42-43`)                                                                  | handled-set marks before server confirm                | Only add to`handled` after server-confirmed accept/reject/expiry; on decline failure keep it eligible for re-surface                                                                                                                                       |
| LM-A3 | No decline reason UI (`IncomingOfferScreen.tsx:111`; API supports it `api.ts:1455-1456`)                                                                                                                    | Never built                                            | 3-chip sheet on Decline (No capacity / Region / Requirements) + free text; feeds ranking + NO_PROVIDER analytics (F8)                                                                                                                                      |
| LM-A4 | Assign sheet availability is guess-work: busy-set derived only from own active missions (`OrgMissionsScreen.tsx:138-142`); no armed badge (`:251-272`); no on-duty signal (`RosterMember` `api.ts:841-851`) | Server truth not exposed                               | Extend`GET /org/cpos` with `on_duty`, `active_mission_id`, `armed_authorized` (data exists server-side: `agents.on_duty`, `mission_crew_agent_active_uq`, `armed_authorizations`); render badges + disable ineligible rows; keep server as final validator |
| LM-A5 | `deployedCount` hardcoded 0 (`OrgRosterScreen.tsx:139`)                                                                                                                                                     | Stat never wired                                       | Compute from active missions crew (same query as LM-A4)                                                                                                                                                                                                    |
| LM-A6 | Suspend gesture undiscoverable; no`removed` offboarding (`OrgRosterScreen.tsx:145-146,270`; API supports `removed` `api.ts:861`)                                                                            | UI gap                                                 | Row overflow menu: Suspend / Reactivate / Remove (confirm dialog), existing action-sheet style                                                                                                                                                             |
| LM-A7 | Escrow errors swallowed on detail (`OrgMissionDetailScreen.tsx:60-63`); `platform_fee_credits` fetched, never shown (`api.ts:913`)                                                                          | —                                                      | Error state + full split line (gross / fee / net) — groundwork for F6 statements                                                                                                                                                                           |
| LM-A8 | Empty-roster dead end in assign sheet (`OrgMissionsScreen.tsx:249-250`)                                                                                                                                     | —                                                      | "Add CPOs" button →`OrgCreateCpo`                                                                                                                                                                                                                          |

### 3.6 P1 — CPO UX

| ID    | Bug                                                                                                                                                                                                                                                       | Why                                               | Fix plan                                                                                                                                                                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LM-C1 | Assignment discovery fragile: OnDuty tab loads once (`OnDutyHomeScreen.tsx:57`); no deep-link (LM-N2); Ops Room join waits for the **agency's** device to drain intents (`dispatchRoomIntents.ts:28-95` invoked only from `AgentDashboardScreen.tsx:213`) | Three gaps stack                                  | OnDuty:`useFocusEffect` + 15 s poll; LM-N2 deep-link; **backend**: also enqueue room add-intents for drain on the _CPO's_ device runtime (the intent-drain pattern already exists in the messenger runtime — reuse; 🔒 arch-gated, see §6)                                          |
| LM-C2 | Deploy checks seeded but never shown/enforced (`org-mission.service.ts:361-368` seeds; `AssignedMissionDetailScreen.tsx:175-177` shows dress only; `flipMissionStatus` has no check gate `agent.service.ts:1295-1306`)                                    | Screen + gate never wired for CPO shell           | Render`data.checks` as a tick list (reuse `AgentDeploymentRequirementsScreen` UI); block the lead's **Start** action until all four acknowledged (server-side gate in the shared `advanceMission` helper from LM-B3: DISPATCHED→PICKUP requires checks complete, with ops override) |
| LM-C3 | No geofence on Start/Go-live/Finish (`agent.controller.ts:277-315` take no coords)                                                                                                                                                                        | Never designed                                    | Send device fix with each transition; server warns (not blocks) when > 500 m from pickup/dropoff — log to mission audit + show ops flag; hard-block only behind a config flag after field trials                                                                                    |
| LM-C4 | Non-lead has zero function: no telemetry (`MissionLeadConsoleScreen.tsx:117`, `mission-lead.service.ts:33-41`), no check-in, invisible on map                                                                                                             | Lead-only design                                  | Phase 1: non-lead check-in ("I'm in position") writing`mission_crew.status='active'` timestamp + shown in agency monitor; Phase 2: per-officer telemetry (new `mission_telemetry` rows keyed by agent — table already exists)                                                       |
| LM-C5 | Background location dead: keep-alive no-op (`onDutyHeartbeat.ts:142-147`), mission GPS only while tracker modal open (`AgentLiveTrackerScreen.tsx:864-881`), battery_pct never sent (`MissionLeadConsoleScreen.tsx:157-163`)                              | FOREGROUND_SERVICE_LOCATION never built           | Android foreground service (notifee`asForegroundService` or expo-location background) active while `on_duty` or mission active; move `watchPosition` out of the modal into a mission-scoped hook; include battery in payload                                                        |
| LM-C6 | No unable-to-attend/stand-down (nothing in`src/screens/cpo/**`)                                                                                                                                                                                           | Never built                                       | See F4                                                                                                                                                                                                                                                                              |
| LM-C7 | Finish is lead-only with no fallback (`agent.service.ts:1305-1306`)                                                                                                                                                                                       | Lead phone dies ⇒ stuck LIVE                      | Allow any crew member to*request* completion → notifies agency + ops; agency manager confirm (new `POST /org/missions/:id/complete` OrgManagerGuard) closes it; keep lead one-tap path                                                                                              |
| LM-C8 | No earnings/history/summary in CPO shell (endpoints exist unused:`api.ts:700,782`; completion just `goBack()` `AgentLiveTrackerScreen.tsx:243-250`) — and backend writes **no per-CPO payout row on the auto path** (`settlement.service.ts:105-113`)     | Shell excludes Earnings; settlement pays org lump | See F2b + F6; backend: optionally write informational per-CPO`mission_payouts` rows (0-credit, `basis='org_internal'`) OR expose org payout share via mission history — product decision, default = show mission history + "paid via your agency"                                   |

### 3.7 P1 — Backend validation / hygiene

| ID    | Item                                                                                                                                      | Fix                                                                                                                                                                         |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LM-V1 | female/medical requirements unenforced (`org-mission.service.ts:311-313`); `female_required` column exists                                | Add`gender`/`medical_cert` to agents (or `org_members` attrs); enforce in `assignCrew` like armed; show badges in assign sheet (LM-A4)                                      |
| LM-V2 | Managers crewable as CPOs; capacity counts only`member_role='cpo'` (`org-mission.service.ts:284-296`)                                     | Filter assignable members to`member_role='cpo'` (or count managers in capacity)                                                                                             |
| LM-V3 | `AssignCrewDto` uses `@IsString`, `ArrayMaxSize(16)` vs `MAX_CPOS=4` (`org/dto/org.dto.ts:10-14`)                                         | `@IsUUID('4', {each:true})`, `ArrayMaxSize(4)`                                                                                                                              |
| LM-V4 | `ops.completeBooking` requires LIVE only (`ops.service.ts:1130-1134`) — can't rescue stuck CONFIRMED (LM-B1's manual escape hatch)        | Allow CONFIRMED→COMPLETED per FSM`state-machine.service.ts:66` with reason + audit                                                                                          |
| LM-V5 | `can_widen: true` advertised, no widen endpoint (`booking.service.ts:982-990`; TODO(LB13) `dispatch.service.ts:879`)                      | See F8                                                                                                                                                                      |
| LM-V6 | `lite_booking_audit` misses cron/dispatch/mission transitions + accepts NULL from/to (§2)                                                 | Route every status write through one audit helper (natural after LM-B3/LM-B4 refactors); backfill nothing                                                                   |
| LM-V7 | 3 region allow-lists disagree (`constants SUPPORTED_REGIONS` vs `OrgComplianceScreen` vs backend — AUTO_DISPATCH_BUGFIX_GUIDE.md:345,498) | Single source:`GET /regions` (backend list) consumed by both mobile surfaces; delete local lists                                                                            |
| LM-D1 | Stale-mission janitor (§2: 8 stuck rows; no drift sweeper)                                                                                | Cron: mission non-terminal + booking terminal (or mission LIVE > 24 h past pickup_time+duration) → flag to Sentry + ops queue; one-off cleanup of the April rows through it |

### 3.8 P2 — Polish (do after the above)

Per-mission call signs at assign time (agency); external-maps handoff
(Google/Waze) from CPO tracker (`AgentLiveTrackerScreen.tsx:488-573` keeps
in-app nav); turn-by-turn driven by device GPS instead of the 4 s server poll
(`:253-254`); simulated-telemetry dot visually distinguished ("locating…"
pulse instead of a fake moving vehicle, `LiveTrackingScreen.tsx:64-93`); CPO
photos for client trust (privacy-gated — call-signs may be intentional; product
decision); offer first-poll delay 2.5 s → 0.5 s; `NO_PROVIDER→NO_PROVIDER`
self-transition audit noise; CreditPaywall copy; Android back-stack hygiene on
the wizard.

---

## 4. IMPROVEMENT PLAN — make the existing flow smooth (no redesign)

These change **behavior**, not visual design:

1. **One status-propagation pattern.** After LM-B3, every transition flows
   through `advanceMission`/audited booking updates → each emits (a) audit row,
   (b) push where the matrix (§3.3) says so, (c) realtime frame. Screens keep
   their existing polling but gain trust: poll + push-nudge (a received push
   triggers an immediate refetch — pattern already in the messenger runtime).
2. **Kill every dead-end:** LM-U1/U2/U3 (client), LM-A2 (agency), LM-C7 (CPO),
   LM-B1/LM-V4 (backend). After this, **no state exists that a user can reach
   and not leave** — the core Uber-smoothness property.
3. **Staleness pattern:** adopt the tracker's reconnecting/stale pill
   (`AgentLiveTrackerScreen.tsx:128-341`) on FindingDetail, AgencyAccepted,
   OrgMissions, OrgMissionDetail, OnDutyHome.
4. **Foreground-return refresh:** `useFocusEffect` reload on every list/detail
   screen in the module (board, roster, missions, history).
5. **Error visibility:** replace `catch {}` with the shared error-state
   components already used by `OrgMissionsScreen:199-234` and
   `EarningsScreen:88-93`.
6. **Preserve what's good:** offer race-handling (`IncomingOfferScreen`
   expiry/won-elsewhere flows), SOS UX, escrow idempotency, coarse-offer privacy,
   MissionStepper — explicitly out of scope for change.

---

## 5. NEW FEATURES — specs (existing visual style, existing patterns)

### F1 · Invoice & receipt system (A-to-Z) — the detailed one

**Why:** dead INVOICE button (`BookingConfirmationScreen.tsx:308-311`),
`BaselinePackage` advertises "Detailed report & invoice" (`:55`),
`invoice_pdf_url` never written (0/171 live rows), no VAT anywhere — while all
the money data needed already exists.

**Data model (new migration):**

- `invoices` table: `id`, `invoice_number` (per-region sequence, e.g.
  `AE-2026-000123`), `booking_id`, `mission_id`, `kind`
  (`client_receipt` | `agency_statement_line`), `issued_at`, `currency`,
  `subtotal`, `tax_rate`, `tax_amount`, `total`, `fx_rate` + `fx_currency`
  (provenance from `wallet_transactions` metadata — `wallet.service.ts:1298-1301`),
  `line_items jsonb` (persisted pricing breakdown), `seller jsonb` (agency legal
  name/TRN — new `org_billing_profiles` table), `buyer jsonb` (client billing
  name/address — new optional profile fields), `pdf_url`, `status`
  (`issued`|`void`).
- **Persist the pricing breakdown**: `lite_bookings.pricing_breakdown jsonb`
  written at quote time (`PricingResult.breakdown[]` currently discarded —
  `pricing.service.ts:31-101`). Invoices must reflect the quoted lines, not a
  recomputation.
- Tax: `region_tax` config (AE 5 % VAT, GB 20 %, others 0 until finance says) —
  applied at invoice issue, displayed as a line; **finance sign-off gate before
  enabling non-zero**, same as LM-M4.

**Generation:** `InvoiceService` in auth-service. Trigger: on
`settleEscrowRelease` success (client receipt + agency statement line) and on
refund paths (credit-note kind). PDF: server-side render (small HTML template →
`puppeteer`/`pdf-lib` — decide by what's already in the server image; HTML
template matches app branding) → upload to a new private storage bucket
`invoices/` → signed URL on demand (never public); write `invoice_pdf_url`.
Numbering via a per-region sequence table to guarantee gapless order.

**Surfaces (all reuse existing styles):**

- Client: `InvoiceScreen` (line items, totals, tax, payment method, download
  PDF button) reachable from: wired INVOICE button on `BookingConfirmation`,
  `TripSummary` ("View invoice"), completion screen (F2), booking history
  (LM-U8). Card/typography copied from `TripSummaryScreen`.
- Agency: per-mission payout slip inside `OrgMissionDetail` escrow card
  (gross / platform fee / net — LM-A7) + monthly statement list in F6 screen;
  PDF export per month.
- CPO: per-mission summary (F2b) shows "settled via your agency" + agency
  amount ONLY if org opts in (privacy default: hidden — matches
  `MissionSummaryScreen.tsx:183` behavior).
- Ops-console: finance page gains invoice list + void/reissue (admin-guarded).

**Tests:** numbering uniqueness under concurrency; totals == escrow split ==
wallet rows (extend reconciliation cron to also check invoices); PDF snapshot.

### F2 · Completion flow (client) + F2b mission summary (CPO)

Client: on COMPLETED, instead of `popToTop` (`LiveTrackingScreen:231`), navigate
to `MissionCompleteScreen`: stepper full, duration, crew call-signs, fare total,
buttons **Rate agency** (existing `RateAgencyScreen`) / **View invoice** (F1) /
Done. Reuse `TripSummary` layout.
CPO: on terminal status, tracker navigates to a read-only
`CpoMissionSummary` (duration, waypoints hit, SOS events, "payout via your
agency") instead of `goBack()`; add "History" row on `CpoMe` using
`getMissionHistory` (`api.ts:782`, currently unused).

### F3 · Verify-your-guard identity handshake + not-my-guard (client + lead CPO)

Backend already done (`GET /bookings/:id/verify-code` both sides;
`POST /bookings/:id/not-my-guard` → SOS; proof-of-completion check #5 currently
auto-passes because no UI emits it — `SQA_AUTO_DISPATCH_LIFECYCLE.md:264`).
Client: on mission DISPATCHED/PICKUP, LiveTracking shows a "Verify your detail"
card → 6-digit code + "This isn't my guard" (red, confirm dialog → not-my-guard
→ SOS flow). Lead CPO: `AssignedMissionDetail` shows the matching code
pre-pickup. Mark verified in `mission_principals`/booking (`not_my_guard_at`
column already exists). This turns the proof-gate check real.

### F4 · Crew management after dispatch (agency) + CPO decline

Agency: `OrgMissionDetail` gains **Edit crew** (pre-LIVE only): swap member,
reassign lead (server errors `reassign_leader_first`/`booking_not_assignable`
already anticipate it — `OrgMissionsScreen.tsx:31-32`). Backend: new
`PATCH /org/missions/:id/crew` (OrgManagerGuard): validates like `assignCrew`,
updates `mission_crew`, enqueues room add/remove intents, re-pushes
`missionDispatched` to added CPOs, audit row. 🔒 room-membership changes ride
the existing intent-drain mechanism (arch-compliant — same as agency add).
CPO: `AssignedMissionDetail` gains **Can't attend** (pre-PICKUP): sets own crew
row `standby` + notifies agency (push + Ops Room card) → agency uses Edit crew.
No self-removal from a LIVE mission.

### F5 · Agency SOS visibility & live alerting

Monitor mode currently hides SOS entirely (`AgentLiveTrackerScreen.tsx:824`) and
no push targets the agency (`sos-cpo-alert` is crew-only). Add: `sosAlert` fan-out
to the org manager (backend: include `assigned_provider_user_id` in recipients —
`sos.service.ts:137`); monitor mode gets a red SOS banner + status pill already
supports SOS (`:724`); OrgMissions active cards get an SOS badge. Deep-link tap
→ monitor (LM-N2).

### F6 · Org earnings & statements (agency)

Replace the "Org Earnings" row's redirect to the personal `EarningsScreen`
(`AgentDashboardScreen.tsx:507`) with `OrgEarningsScreen`: totals (month,
lifetime), per-mission list from the **already-built but never-called**
`orgApi.listCompletedMissions` (`api.ts:905-906`) + escrow splits
(gross/fee/net incl. `platform_fee_credits`), monthly statement PDF (F1). Same
card styles as `EarningsScreen`.

### F7 · Notification completeness + deep-links

= LM-N1..N5 executed as one feature: wake-kind registry, tap router, event
matrix table in code comments mirroring §1.5, device QA checklist (killed-app
delivery on the Redmi per `dev-phone-and-build-setup` memory).

### F8 · NO_PROVIDER recovery & dispatch observability

Client side: NoDetail screen's dead `can_widen` becomes real — new
`POST /bookings/:id/retry-dispatch` accepting `{widen_km?, defer_minutes?}`
(re-enters `DispatchService.start` with widened radius; replaces today's
self-transition retry). Show "notify me when providers are available" (push on
retry success).
Ops side: exclusion-reason counters in the ranker (mocked/stale/cooldown/
region/capacity/dpa — `AUTO_DISPATCH_BUGFIX_GUIDE.md:447`) persisted per
dispatch round + surfaced in the (built, undeployed) dispatch-inspector; deploy
the inspector.
Business side (no code): DPA/eligibility drive — only 2/34 agents eligible; the
in-app flow exists (`OrgRegionScreen`); needs an onboarding nudge card on
`AgentDashboard` when `dpa_accepted_at IS NULL` ("Activate dispatch offers").

### F9 · Scheduled bookings surface

Backend sweep exists (`scheduled-dispatch.service.ts:65-84`, dark). Client:
"Book later" already sets `booking_mode='later'` but the booking then sits as an
invisible DRAFT — show it in Home/history as "Scheduled · dispatches at T-lead"
with Cancel (free — LM-B8). Agency/CPO: unchanged (they see it when dispatched).

### F10 · Share-trip & trusted contacts (P2, security-gated)

Read-only share link (web page with live coarse location + status) is a
**new data-exposure surface** → requires architecture sign-off per CLAUDE.md
security constraints. Spec only; do not build without approval.

### F11 · CPO availability & duty in roster

= LM-A4/LM-A5 plus: CPO OnDuty toggle state surfaced to org
(`agents.on_duty` already written by `setDuty`); roster rows show ON DUTY /
OFF / ON MISSION; assign sheet filters accordingly.

### F12 · Mission timeline (all POVs, audit-backed)

After LM-V6, every transition is audited → render a per-booking timeline
(requested → offered → accepted → crew → pickup → live → complete + money
events) in: client TripSummary/Invoice, agency OrgMissionDetail, ops-console
booking detail. Pure read; strong support/debug value.

---

## 6. Explicitly gated / not in this plan

- 🔒 **Ops Room membership changes from server-side triggers** (F4, LM-C1
  backend half): rides the existing encrypted intent-drain — any deviation
  (e.g. server holding group keys) is forbidden; if the drain pattern needs
  extension, stop and check the System Architecture Documentation first.
- **Fee %, cancel fee %, FX table, VAT rates:** code paths land behind config;
  enabling non-zero values requires finance sign-off (existing cut-over
  blocker).
- **Fiat cash-out (Stripe Connect)** for agencies: business decision + KYC
  scope; out of plan (flagged as the missing end of the money loop).
- **i18n/RTL** (AR/BN): tracked in docs/planning/UBER_DISPATCH_PLAN.md:1287; not bundled here.
- **Legacy ops-mediated path refactors**: only LM-M5 touches it; everything else
  targets the auto path.

---

## 7. Phased delivery plan

Each phase ends with: targeted tests green → `npm test` (booking project) →
typecheck ≤ 96 baseline → staging deploy (auth-service; **remember msgr JWT
drift rule: redeploy messenger-service if auth env changes**) → device smoke.

| Phase                              | Contents                                                                                                                                              | Exit gate                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **0 · Hygiene** (small, immediate) | LM-D1 janitor + April cleanup; LM-U4 type unions; LM-U5; LM-V3 DTO; LM-B9 comments; delete-or-wire`useBookingRealtime`; region list unification LM-V7 | booking tests + tsc                                                                                                 |
| **1 · Backend correctness**        | LM-B1, LM-B2, LM-B3 (shared advanceMission), LM-B4, LM-B5, LM-B6, LM-B7, LM-B8, LM-B10, LM-V2, LM-V4, LM-V6                                           | new integration tests incl. re-dispatch E2E + concurrency cancel test; state-machine.drift.spec extended            |
| **2 · Notification backbone**      | F7 (LM-N1 offer wake, LM-N2 tap router, LM-N3 iOS, LM-N4 events)                                                                                      | killed-app device QA on offer + mission-dispatched + payout                                                         |
| **3 · Client smoothness**          | LM-M1 real quote, LM-U1/U2/U3/U6/U7/U8/U9, LM-M2                                                                                                      | 2-device golden path + error paths (offline, no-provider, abort)                                                    |
| **4 · Agency pack**                | LM-A1..A8, F5 SOS, F11 availability                                                                                                                   | agency device QA: offer→accept→crew→monitor→SOS drill                                                               |
| **5 · CPO pack**                   | LM-C1..C5, LM-C7, F2b summary                                                                                                                         | CPO device QA incl. background-location soak + lead-handoff drill                                                   |
| **6 · Invoice system**             | F1 + F2 completion screen + F6 org earnings (+LM-M3 armed premium behind config)                                                                      | invoice reconciliation test + PDF on device; finance review of template                                             |
| **7 · Feature round**              | F3 verify-guard, F4 crew edit + CPO decline, F8 NO_PROVIDER recovery + inspector deploy, F9 scheduled surface, F12 timeline                           | 3-device smoke (`apps/auth-service/test/smoke/3device-dispatch.md`) run end-to-end — the never-run cut-over blocker |

Rollout: phases 1–2 are safe while the feature stays dark; flip
`AUTO_DISPATCH_ENABLED` broadly only after Phase 2 + finance sign-off + the
3-device smoke (§10 blockers in SQA_AUTO_DISPATCH_LIFECYCLE.md).

---

## 8. QA / verification plan (per POV)

**SQL probes (run before/after each backend phase):** status distribution
(§2 query), stuck-mission drift join, escrow holds by status ×
`review_required`, offers by status, audit coverage per transition.

**Client golden path:** request → watch searching → accept on agency device →
crew → verify-guard code → pickup/live on CPO device → complete → completion
screen → rate → invoice PDF opens. Error paths: cancel at each stage (searching /
accepted-no-crew / confirmed-crewed / live-must-fail), NO_PROVIDER → retry-widen,
agency no-show (let crew SLA fire, verify refund push + banner), abort mid-live
(ops) → client interstitial.

**Agency:** killed-app offer push wakes + deep-links inside TTL; decline with
reason; assign with a busy/off-duty CPO (server rejects, UI pre-warns); edit
crew pre-live; SOS drill visible on monitor + push; earnings row shows fee
split; statement PDF.

**CPO:** killed-app mission-dispatched push deep-links; deploy checks gate
Start; geofence warning fires when far; background-location soak (screen off
30 min, dot keeps moving); can't-attend flow; lead-phone-dies →
crew-request-complete → agency confirm; mission summary + history.

**Money:** every cancel/refund/release path asserts wallet conservation (extend
`booking.escrow.spec.ts`); invoice totals == escrow split; reconciliation cron
green after each phase.

---

## 9. Appendix

**Fixed previously — do NOT re-fix:** AUTO_DISPATCH_BUGFIX_GUIDE Bugs 1–7
(auto flag on /auth/me; Mapbox token; OrgRegionScreen DPA/region write; wallet
ON CONFLICT; privacy-purge enum cast; SP board starvation; stale pickup pin) ·
B-37/B-38 dashboard crashes · B-49 sos_events schema.

**Verified sound (leave alone):** offer double-accept/double-charge guards;
offer-expiry vs accept race (2 s grace); lead/crew/org IDOR checks; crew
busy/roster/count/armed validation; escrow conservation + idempotent payouts +
daily reconciliation; coarse-offer PII model; IncomingOffer race UX; SOS UX.

**Staging data snapshot (2026-07-05):** §2 tables. DPA-eligible agents: 2/34.
Live enum values match code enums exactly (no drift there).

**Doc updates on landing:** update `docs/qa/SQA_AUTO_DISPATCH_LIFECYCLE.md` §8
dark-surface table as UI lands (F3 kills POC-5 auto-pass); mark BATCH-10/11
superseded (endpoints existed; UI lands in F6/LM-A7); note in
`docs/planning/REMAINING_TODO.md`.
