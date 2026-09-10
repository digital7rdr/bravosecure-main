# Bravo Lite — Auto-Dispatch (Uber-style) Lifecycle for SQA

> Owner: SQA · Branch: `feat/auto-dispatch` (now on `main`) · Verified against HEAD `555039a`
> Scope: the **NEW Uber-style auto-dispatch path** — the 28-step build. This is a **different
> lifecycle** from the legacy admin-mediated booking flow in
> [`SQA_BRAVO_LITE_TEST_FLOW.md`](./SQA_BRAVO_LITE_TEST_FLOW.md) (ops approves each booking +
> hand-picks CPOs). Read that doc for the legacy path; read this one for auto-dispatch.

Every `file:line` below was verified against the codebase — white-box testers can jump straight
to source. Three hats: **User (client)**, **Service Provider (agency)**, **CPO (managed officer)**.

---

## 0. The one-paragraph mental model

A client books protection → a **consent gate** → submit **auto-starts dispatch** → the server
offers the job to the **nearest eligible agency in the same region** for **30 s** → the agency
**accepts** → the **client is charged into escrow on accept** (not before) → booking **CONFIRMED**
→ the agency **assigns its own managed CPOs** as the mission crew → CPOs go **on duty** and run the
mission → the **lead CPO taps Finish** (a 5-check proof-of-completion gate) → escrow flips to
_pending release_ → an auto **release sweep** (or the client, server-side) **pays the agency** →
the client **rates the agency**. No ops admin in the middle. Agencies that misbehave (reject a lot,
no-show, spoof GPS) get **benched**.

---

## 1. ⚠️ READ THIS FIRST — what is and isn't testable today

The auto path is **shipped DARK**. Before you chase a "bug", confirm these:

1. **It is OFF by default.** Two gates must BOTH be ON (see [§3](#3-how-to-enable-auto-dispatch)).
   With either OFF, the client wizard **falls back to the legacy `OpsRoomReview` flow** and the
   agency offer screens never fire. `POST /dispatch/request` returns `400 auto_dispatch_disabled`.

2. **No live account is dispatch-eligible out of the box.** The three known company agents
   (`kamrul0628`, `kamrul06`, `omnidevxstudio`) all have `region_code = NULL`, no verified
   licence/insurance, no DPA, and ~0 managed CPOs → they fail eligibility. You must **hand-seed**
   an eligible agency in the DB (see [§9](#9-test-accounts--how-to-seed-an-eligible-agency)).

3. **Some surfaces are wired backend-only — there is NO button for them yet.** Do not file these
   as broken UI; they are known gaps (see [§8](#8-known-gaps--unreachable-surfaces-do-not-file-as-bugs)):
   - **Identity handshake** (verify-code) — endpoints exist for BOTH client and lead-CPO, **no screen calls either**.
   - **"Not my guard"** panic — wrapper exists, no screen calls it.
   - **Confirm-complete / dispute / escrow receipt** — server endpoints only, no client wrapper, no screen.
   - **Agency DPA acceptance** — required by the eligibility gate but **has no endpoint or UI at all** (DB-only).
   - Background location heartbeat — foreground-only (the keep-alive foreground-service is a no-op stub).

---

## 2. Persona routing — which shell each login lands in

The root switch is the **server-computed `account_kind`** (re-read from the DB every request,
never a JWT claim), resolved by `resolveAuthedRoute(...)` (`src/navigation/resolveRoute.ts:29`),
branched in `MainNavigator.tsx:512-523`.

| `account_kind`                                                    | + condition                              | Lands in                          | Shell / first screen                    |
| ----------------------------------------------------------------- | ---------------------------------------- | --------------------------------- | --------------------------------------- |
| `cpo`                                                             | `membership_status` suspended/removed    | `AccessEndedScreen`               | locked out                              |
| `cpo`                                                             | `must_set_password = true` (first login) | `CpoActivationScreen`             | set-password gate                       |
| `cpo`                                                             | active                                   | **`CpoNavigator`**                | On Duty · Mission · Comms · Me          |
| `agency` _(or legacy `agent`/`service_provider`/pendingProvider)_ | —                                        | **`AgentNavigator`**              | `AgentDashboard` (or onboarding)        |
| anything else (`individual`)                                      | —                                        | **Client tabs** (`MainNavigator`) | Home · Messenger · **Secure** · Profile |

`account_kind` rule (`apps/auth-service/src/auth/account-kind.ts:68`): `cpo` when
`agents.type='cpo' AND managed_by_org_id IS NOT NULL` **OR** an active `org_members` row with
`member_role='cpo'`; `agency` when `agents.type='company'`; else `individual`. A suspended CPO
still resolves to `cpo` so the guard can eject it (rather than silently downgrading).

---

## 3. How to enable auto-dispatch

**`effective = envEnabled AND (redis !== 'false')`.** Both gates must be ON.

| Gate                    | What                                        | Where                                                                            | Notes                                                                                   |
| ----------------------- | ------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Env flag (boot)**     | `AUTO_DISPATCH_ENABLED=true` (auth-service) | `apps/auth-service/src/config/configuration.ts:92` → `featureFlags.autoDispatch` | OFF ⇒ sweeps don't start their timers; `/dispatch/request` 400s. Default OFF.           |
| **Mobile build flag**   | `EXPO_PUBLIC_AUTO_DISPATCH=true`            | `src/utils/constants.ts:24`                                                      | OFF ⇒ wizard uses the legacy `OpsRoomReview` path. Baked at build time.                 |
| **Runtime kill-switch** | Redis key `dispatch:enabled`                | `apps/auth-service/src/ops/dispatch-killswitch.service.ts:22,47`                 | Fail-safe: can only force **OFF**. Absent/`'true'` ⇒ on; `'false'` ⇒ killed. 2 s cache. |

**Kill-switch from the ops console:** `apps/ops-console/.../dispatch/page.tsx` ("Auto-Dispatch
Monitor") — banner + flip button (`canFlipKillswitch(role)`, **ADMIN only**), polls every 5 s.
API: `GET /ops/dispatch/killswitch`, `PUT /ops/dispatch/killswitch` (`dispatch-admin.controller.ts:53,93`, audited).

---

## 4. USER (Client) lifecycle

Client tabs → **Secure** tab (always resets to `BookingHome`). All screens in `BookingNavigator.tsx`.

### 4.1 Wizard → consent → submit (navigation)

| Step                                      | Screen (`name=`)  | File                        | Reached from               |
| ----------------------------------------- | ----------------- | --------------------------- | -------------------------- |
| Region/zone                               | `ZoneMap`         | `ZoneMapScreen.tsx`         | BookingHome → "Book"       |
| Service type                              | `ServiceType`     | `ServiceTypeScreen.tsx`     | ZoneMap → Continue         |
| Date/time **+ now/later mode** + location | `BookingDateTime` | `BookingDateTimeScreen.tsx` | ServiceType → Continue     |
| Location pin (modal)                      | `LocationPicker`  | `LocationPickerScreen.tsx`  | BookingDateTime → pin      |
| Package                                   | `BaselinePackage` | `BaselinePackageScreen.tsx` | BookingDateTime → Continue |
| **Add-ons + CONSENT + Submit**            | `CustomizeAddOns` | `CustomizeAddOnsScreen.tsx` | BaselinePackage → Continue |

**The consent gate (Step 22)** — on `CustomizeAddOnsScreen`, only when `AUTO_DISPATCH` is on:
a single checkbox _"I consent to sharing my live location with the assigned agency… and I accept
the Dispatch Terms."_ The **CTA is blocked until checked** (`CustomizeAddOnsScreen.tsx:137-139`).
The one box derives **both** `location_consent:true` + `terms_accepted:true` (+ version stamps)
on submit (`bookingStore.ts:200-210`). Backend rejects a missing consent with
`400 {code:'consent_required'}` (`booking.service.ts:230-235`).

**Submit** → `bookingApi.requestAuto(body, idempotencyKey)` → **`POST /dispatch/request`**
(`api.ts:373`, `client-dispatch.controller.ts:46-81`):

- Kill-switch gated → else `400 auto_dispatch_disabled`.
- Creates booking `DRAFT` with `dispatch_mode='auto'`.
- **"now"** → `dispatch.start()` flips **DRAFT → DISPATCHING** + offers the nearest agency inline.
  ("now" auto **skips** the 3-hour lead-time gate.)
- **"later"** → stays `DRAFT(auto)`; `ScheduledDispatchService` flips it to DISPATCHING ~15 min
  before pickup.
- **Affordability is an advisory client-side soft-check only** (`bookingStore.ts:216-225`) → routes
  to `CreditPaywall` if short. **The client is NOT charged at submit.**

Routing after submit: `DISPATCHING → FindingDetail`, `NO_PROVIDER → NoDetail`,
else (legacy) `→ OpsRoomReview`.

### 4.2 Finding an agency → accepted → confirmed

| Screen (`name=`)                                | What happens                                                                                                                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`FindingDetail`** (swipe-back disabled)       | Polls `GET /bookings/:id` every 5 s, hard cap 5 min. Radar + _"You won't be charged until a detail accepts."_ SOS button present. On `CONFIRMED` → `replace('AgencyAccepted')`; on `NO_PROVIDER` → `replace('NoDetail')`. Cancel → `bookingApi.cancel`. |
| **`AgencyAccepted`** _(transient interstitial)_ | An agency accepted → **client is now charged into escrow** (HELD). Shows agency name/call-sign + ★rating + missions (coarse — **never** coords). "Continue" → `BookingConfirmation`.                                                                    |
| **`NoDetail`**                                  | NO_PROVIDER. **`escalate` IS wired here** (`NoDetailScreen.tsx:45` → `POST /bookings/:id/escalate`) — the one reachable Step-16 safety surface.                                                                                                         |
| **`BookingConfirmation`**                       | Polls team + booking every 5 s until the agency crews the mission and status flips to `LIVE`. Client team payload has the **internal agent UUID stripped** (anti-enumeration).                                                                          |
| **`LiveTracking`**                              | Live map + telemetry. Generic **SOS** button. (Identity handshake / "not my guard" are **not wired** — see §8.)                                                                                                                                         |
| **`TripSummary` → `RateAgency`**                | On completion. `RateAgency` (`RateAgencyScreen.tsx:40`) → stars (≥1) + tags → `POST /bookings/:id/rating`, recomputes `agents.rating`. **Only entry is TripSummary's "Rate" CTA.**                                                                      |

### 4.3 Booking status FSM (auto path) — `state-machine.service.ts`

Statuses: `DRAFT, DISPATCHING, PENDING_OPS, OPS_APPROVED, PAYMENT_PENDING, CONFIRMED, LIVE,
COMPLETED, NO_PROVIDER, AGENCY_NO_SHOW, CANCELLED`.

| From → To                    | Actor             | Meaning                                                                                         |
| ---------------------------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| DRAFT → DISPATCHING          | CLIENT            | submitted auto request; matchmaker starts                                                       |
| DISPATCHING → CONFIRMED      | SYSTEM            | an agency accepted + **client charged to escrow**                                               |
| DISPATCHING → NO_PROVIDER    | SYSTEM            | nobody available — **terminal, auto-only**                                                      |
| CONFIRMED → AGENCY_NO_SHOW   | SYSTEM            | agency accepted but never crewed by deadline → **refunds the hold**; terminal, auto-only        |
| CONFIRMED → DISPATCHING      | SYSTEM            | crew never reached pickup → **re-dispatch same booking**, hold persists (client not re-charged) |
| CONFIRMED → LIVE → COMPLETED | CPO               | crew check-in → mission → lead Finish                                                           |
| any CANCELLABLE → CANCELLED  | CLIENT/SYSTEM/OPS | CANCELLABLE = DRAFT, DISPATCHING, PENDING_OPS, OPS_APPROVED, PAYMENT_PENDING, CONFIRMED         |

> **Tester note:** `CONFIRMED → LIVE → COMPLETED` is driven **entirely by the lead CPO's mission
> footer**, not by any client action. Watching only the client app, you'll see the status flip with
> no client tap. No-show re-dispatch (CONFIRMED → DISPATCHING) also has no dedicated client screen —
> poll `lite_bookings.status` to confirm it.

### 4.4 Privacy / PII (verified)

- **Pre-accept** the agency sees only a **bucketed distance** + boolean requirement flags — no
  coords, address, or client identity (`dispatch.service.ts:198-211`).
- **Post-accept** precise coords are revealed only to the **owning** agency via `GET /dispatch/offers/:id/full`,
  every read audited fail-closed (`dispatch.full_read`).
- Client only ever sees the **coarse** provider card; internal agent UUIDs are stripped from the team read.

---

## 5. SERVICE PROVIDER (Agency) lifecycle

An **agency** = an `agents` row with `type='company'`; the org id **is** the company user's id
(no `provider_orgs` table). Shell = `AgentNavigator`; activated agencies land on `AgentDashboard`.

### 5.1 Become a provider, then become _eligible_

1. **Register** — `RoleSelection` → Agency card → onboarding stack (`AgentTypeSelect` → wizard →
   coverage → availability → docs → `AgentAdminApproval` → `AgentDashboard`). `service_provider`
   role is granted at the authenticated self-create of the company agent (`POST /agents`).
2. **Compliance** — `AgentDashboard` → "Compliance" card → **`OrgCompliance`** (`OrgComplianceScreen.tsx`):
   submit **Licence / Insurance** for a region → `POST /compliance`. Ops verifies them in the console
   (`GET /ops/compliance/pending` → `POST /ops/compliance/:id/verify`). Docs start UNVERIFIED.

**Eligibility gate — `is_eligible_for_dispatch(agency, region, requirements)`**
(`supabase/migrations/20260622100000_privacy_consent.sql:33-58`). ALL of:

1. `dpa_accepted_at IS NOT NULL` ⚠️ **(no endpoint/UI — DB-only, see §8)**
2. verified, non-expired **licence** for the region
3. verified, non-expired **insurance** for the region
4. if `armed`: an active roster CPO with a regional `armed_authorizations` row

Plus, separately, in the **ranking** SQL: `agents.region_code = booking region`, fresh non-mocked
location (<5 min), not in `cooldown_until`, and `has_free_cpo_capacity` ≥ `cpo_count`.

### 5.2 Go on duty → receive an offer → accept/reject

- **On duty** — duty switch on `AgentDashboardScreen` → `PATCH /agents/me/duty`. While on duty +
  location granted, the heartbeat PATCHes `/agents/me/location` every ~45 s (foreground-only).
- **Offer arrives** — `IncomingOfferWatcher` (always mounted, `AgentNavigator.tsx:60`) polls
  `GET /dispatch/offers/current` every 5 s and deep-links to **`IncomingOffer`** on a new offer.
  30 s countdown bound to the server `expires_at`. Card shows **coarse** data only
  (region, bucketed distance, time, duration, cpo_count, AED pay, requirement chips) — **no coords/PII**.
- **ACCEPT** (`POST /dispatch/offers/:id/accept`, idempotent) — one txn: race-win the offer →
  booking `DISPATCHING → CONFIRMED` → **charge the client into `escrow_holds` (HELD)** (short
  balance rolls the whole thing back) → set `crew_deadline_at = NOW()+15 min`. UI → `OrgMissions`.
- **REJECT / EXPIRE** — `OFFERED → REJECTED/EXPIRED` + **decline accounting**: `offers_rejected++`,
  recompute `acceptance_rate`, and after ≥5 responded offers with <20% accept → **30-min cooldown**
  (`cooldown_until`). A timed-out offer counts as a soft decline. Then cascade to the next agency
  (up to `MAX_OFFERS=8`, else `NO_PROVIDER`).

### 5.3 Assign crew → mission → payout

- **`OrgMissions`** (Dashboard → "Missions") — board grouped needs-crew/active/recent. Tap a
  **NEEDS CREW** card → assign sheet: pick exactly `cpo_count` guards, **star one as Leader** →
  `POST /org/bookings/:id/crew` (`OrgMissionService.assignCrew`). Race-safe txn validates count,
  lead∈crew, same-org active members, free, armed-if-required. Creates `missions` + `mission_crew`
  (lead slot 0). **Ops Room created here with the AGENCY as the key owner** (CPOs rekeyed in).
  ⚠️ female/medical requirements are **not enforced** (no per-CPO column; only `armed`).
- **`OrgRoster` / `OrgCreateCpo`** — manage the managed-CPO roster (see §6.1).
- **Payout (escrow RELEASE)** — after lead Finish, escrow flips to _pending release_; a release
  sweep (or client confirm) runs `settleEscrowRelease`: escrow → **agency** payout + platform fee,
  a **single agency `mission_payouts` row** (NOT per-CPO), `jobs_total++`, Ops Room dissolved.
  Surface: **`Earnings`**.
- **Crew-SLA → AGENCY_NO_SHOW** — accept but don't crew within 15 min → `crew-sla.service.ts` flips
  `CONFIRMED → AGENCY_NO_SHOW`, **refunds the escrow**, +1 reliability breach.

---

## 6. CPO (Managed Officer) lifecycle

A CPO is owned by an agency and **assigned** to missions (never accepts offers). Shell =
`CpoNavigator` (4 tabs: **On Duty / Mission / Comms / Me**). Capability hiding is _structural_ —
no booking, wallet, offer, roster, or assign-crew screen is registered in the CPO shell.

### 6.1 Created by the agency

Agency Dashboard → "CPO Roster" (`OrgRoster`) → add-CPO → **`OrgCreateCpo`**: display_name, email,
phone, temp_password (+ optional call_sign) → `POST /org/cpos` (`OrgCpoService.createManagedCpo`).
One txn inserts `users` (role `agent`, **`password_set_at` omitted → NULL**), `agents`
(`type='cpo'`, `managed_by_org_id=<org>`), and `org_members` (`member_role='cpo'`, `status='active'`).
A CPO can belong to **one active agency** (`org_members_one_active_agency` unique index → 23505 →
clean `409 user_already_exists`).

### 6.2 First login → set password → land in the shell

`password_set_at = NULL` ⇒ `must_set_password=true` ⇒ **`CpoActivationScreen`** (Welcome →
Permissions → Set password → `POST /auth/me/password`). ⚠️ Setting the password **revokes all
sessions and returns no new tokens** — the CPO is signed out and must log in again with the new
password; next login `must_set_password=false` → routed into `CpoNavigator`.

### 6.3 On duty → assigned → run → Finish

- **On Duty (`CpoDuty`)** — duty toggle drives the heartbeat (`onDutyHeartbeat.ts`, 45 s, foreground-only).
  Each fix reports `accuracy_m / speed_kph / is_mocked`. **Anti-fraud:** a mocked fix OR an
  implausible jump (> `MAX_PLAUSIBLE_KPH=900` + accuracy + 150 m jitter, judged only for ≥5 s gaps)
  sets `last_location_mocked=TRUE` and **does not advance** `last_location` — so a spoofer can't win
  dispatch and is excluded by the ranking's `last_location_mocked=FALSE` filter.
- **Assigned** — the agency crews them; the "YOUR MISSION" card appears on On Duty home with a
  **★ LEAD / CREW** chip. `mission_crew` row, lead has `is_lead=true, role='LEAD'`.
- **Mission (`CpoMission`)** — `AssignedMissionDetailScreen`: brief, crew roster (lead starred,
  "YOU" tag), waypoints, deploy checks, "Open Ops Room", SOS FAB (PICKUP/LIVE/SOS).
- **Lead Finish** — footer button DISPATCHED→Start, PICKUP→Go live, LIVE→**Finish** (confirm:
  "releases payment to your agency"). **Lead-only** (`lead_only` guard); non-leads see a read-only
  note + chat + SOS. `POST /agents/me/missions/:id/complete`.
- **Proof-of-completion gate** (auto path, `proof-of-completion.service.ts`) — 5 server-side checks:
  (1) real progression PICKUP→LIVE; (2) reached pickup (GPS within 150 m); (3) ≥5 telemetry pings
  during LIVE; (4) ≥300 s on task; (5) identity handshake — currently **"offered/pass"** because no
  UI emits a code. **PASS** → escrow `HELD → PENDING_RELEASE` (nothing paid yet). **FAIL** →
  `review_required=TRUE`, the hold **never auto-releases**.

### 6.4 Payout note — agency receives, not per-CPO

In the auto path the escrow release pays the **agency** a single `mission_payouts` row; the agency
settles its own CPOs off-platform. (The legacy path's per-CPO even-split only runs when there is no
escrow hold.)

### CPO cheat-sheet

| Goal                     | Route                   | How to reach                                      |
| ------------------------ | ----------------------- | ------------------------------------------------- |
| CPO On Duty home         | `CpoDuty`               | first tab on CPO login                            |
| CPO Mission              | `CpoMission`            | "Mission" tab / "YOUR MISSION" card               |
| CPO Ops Room             | `CpoComms`              | "Comms" tab / "Open Ops Room"                     |
| First-login set password | _(no route — injected)_ | log in as fresh CPO with temp password            |
| Access-ended             | `AccessEnded`           | agency suspends/removes CPO → CPO foregrounds app |
| (Agency) create CPO      | `OrgCreateCpo`          | Dashboard → CPO Roster → add                      |
| (Agency) assign crew     | `OrgMissions`           | Dashboard → Missions → crew a CONFIRMED booking   |

---

## 7. Reference — endpoints, watchdogs, DB, migrations

### 7.1 Endpoints by persona

**Client** (`JwtAuthGuard`):

| Method/Path                                                                                                                     | Purpose                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `POST /dispatch/request`                                                                                                        | Create auto booking + start matchmaker (5/min, idempotent, kill-switch gated) |
| `GET /bookings/:id`                                                                                                             | Poll status                                                                   |
| `GET /bookings/:id/provider`                                                                                                    | Coarse accepting-agency reveal                                                |
| `GET /bookings/:id/team`                                                                                                        | Assigned crew (UUID-stripped)                                                 |
| `POST /bookings/:id/escalate`                                                                                                   | NO_PROVIDER safety escalation ✅ wired (NoDetail)                             |
| `POST /bookings/:id/rating`                                                                                                     | Rate agency on COMPLETED ✅ wired (RateAgency)                                |
| `POST /bookings/:id/cancel`                                                                                                     | Cancel (pro-rata on hold)                                                     |
| `GET /bookings/:id/verify-code` · `POST .../not-my-guard` · `POST .../confirm-complete` · `POST .../dispute` · `GET .../escrow` | ⚠️ backend only — **no screen** (see §8)                                      |
| `PATCH /users/me/preferences`                                                                                                   | Language/currency/notif/app-lock                                              |

**Agency** (`Jwt → OrgManager [→ Throttler]`):

| Method/Path                                         | Purpose                                   |
| --------------------------------------------------- | ----------------------------------------- |
| `GET /dispatch/offers/current`                      | This org's live offer, COARSE             |
| `GET /dispatch/offers/:id/full`                     | Precise loc, ACCEPTED+owner only, audited |
| `POST /dispatch/offers/:id/accept` · `/reject`      | Win/decline → escrow charge / cascade     |
| `GET /org/summary` · `GET /org/missions`            | Capacity strip · mission board            |
| `POST /org/bookings/:id/crew`                       | Assign crew + leader (idempotent)         |
| `POST/GET /org/cpos` · `PATCH /org/cpos/:id/status` | Managed-CPO roster                        |
| `POST /compliance` · `GET /compliance/me`           | Submit/list licence+insurance             |

**CPO** (`agents`, self-scoped): `PATCH /agents/me/duty`, `PATCH /agents/me/location`,
`GET /agents/me/active-mission`, `POST /agents/me/missions/:id/{pickup,go-live,complete,sos}`,
`GET /agents/me/missions/:id/verify-code` (⚠️ unwired).

**Admin/Ops** (`Jwt → Csrf → Admin`): `GET /ops/dispatch/monitor`, `GET|PUT /ops/dispatch/killswitch`
(PUT = ADMIN), `POST /ops/dispatch/test`, `POST /ops/dispatch/:id/{cancel,force-assign}`,
`GET /ops/compliance/pending`, `POST /ops/compliance/:id/{verify,reject}`, `POST /ops/armed/:id/verify`,
`POST /ops/disputes/:id/resolve`.

### 7.2 Health & watchdogs

`GET /health`, `GET /ready` (503 if db/redis/watchdog stale), `GET /metrics` (Prometheus). Confirm
sweeps alive: `GET /ready → checks.watchdog:true`, or Redis `GET dispatch:watchdog:offer:last_run`.

| Sweep                 | Cadence | Does                                                                                 |
| --------------------- | ------- | ------------------------------------------------------------------------------------ |
| offer-expiry          | 8 s     | expire lapsed offers → cascade                                                       |
| crew-sla              | 60 s    | CONFIRMED past crew deadline → AGENCY_NO_SHOW + refund (**the only crew-SLA sweep**) |
| arrival-noshow        | 60 s    | mission never reached pickup → re-dispatch (hold stays)                              |
| scheduled-dispatch    | 60 s    | flip "later" DRAFT bookings to DISPATCHING ~15 min before pickup                     |
| privacy-purge         | 5 min   | NULL stale reject_reason / purge terminal telemetry after 24 h                       |
| escrow-release        | 60 s    | release PENDING_RELEASE holds past dispute window → agency                           |
| escrow-reconciliation | daily   | read-only money-invariant audit → metric + Sentry                                    |

### 7.3 Inspect a booking's full dispatch state (SQL)

```sql
SELECT b.id, b.status, b.dispatch_mode, b.region_code, b.cpo_count, b.armed_required,
       b.assigned_provider_user_id, b.dispatch_started_at,
       b.crew_deadline_at, b.arrival_deadline_at, b.conversation_id
  FROM lite_bookings b WHERE b.id = :booking_id;

SELECT o.rank, o.provider_user_id, o.status, o.distance_km, o.expires_at, o.responded_at
  FROM dispatch_offers o WHERE o.booking_id = :booking_id ORDER BY o.rank;

SELECT h.status, h.gross_credits, h.to_provider_credits, h.to_client_credits,
       h.platform_fee_credits, h.basis, h.release_eligible_at, h.review_required
  FROM escrow_holds h WHERE h.booking_id = :booking_id;

SELECT wt.type, wt.user_id, wt.amount_credits, wt.created_at
  FROM wallet_transactions wt WHERE wt.booking_id = :booking_id ORDER BY wt.created_at;

SELECT m.id, m.status, m.pickup_at, m.live_at, mc.agent_id, mc.is_lead, mc.status AS crew_status
  FROM missions m LEFT JOIN mission_crew mc ON mc.mission_id = m.id
 WHERE m.booking_id = :booking_id;
```

Confirm an agency is dispatchable:

```sql
SELECT public.is_eligible_for_dispatch(:agency_uuid, :region, '{"armed":false}'::jsonb) AS eligible,
       public.has_free_cpo_capacity(:agency_uuid, 1) AS has_capacity;
```

### 7.4 Feature migrations (confirm applied)

`20260620000000_auto_dispatch` · `…0001_fsm_trigger` · `…0002_escrow_integrity` ·
`20260621000000_user_must_set_password` · `…100000_dispatch_eligibility_fns` ·
`…110000_one_live_offer` · `20260622000000_agency_no_show_status` (+trigger) ·
`…100000_privacy_consent` (DPA + current eligibility fn) · `…110000_antifraud_integrity` ·
`…120000_user_preferences` · `…130000_ops_audit_system_subject` ·
`20260623000000_wallet_escrow_tx_types` · `20260624000000_mission_state_timestamps` ·
`20260625000000_wallet_escrow_release_tx_type` · `20260626000000_dispatch_room_intents` ·
`20260627000000_compliance_admin_and_booking_terms` · `20260628000000_arrival_and_noshow` (+trigger).

---

## 8. Known gaps & unreachable surfaces (do NOT file as bugs)

| Surface                       | Backend                                      | Mobile wrapper                | Screen   | Status                                           |
| ----------------------------- | -------------------------------------------- | ----------------------------- | -------- | ------------------------------------------------ |
| Identity handshake (client)   | `GET /bookings/:id/verify-code` ✅           | `bookingApi.getVerifyCode` ✅ | **none** | dark both ends                                   |
| Identity handshake (lead CPO) | `GET /agents/me/missions/:id/verify-code` ✅ | none                          | **none** | dark both ends                                   |
| "Not my guard" panic          | `POST /bookings/:id/not-my-guard` ✅         | `bookingApi.notMyGuard` ✅    | **none** | unreachable                                      |
| Confirm-complete              | `POST /bookings/:id/confirm-complete` ✅     | none                          | **none** | auto-release sweep covers it                     |
| Dispute                       | `POST /bookings/:id/dispute` ✅              | none                          | **none** | no client dispute button                         |
| Escrow receipt                | `GET /bookings/:id/escrow` ✅                | none                          | **none** | no receipt screen                                |
| **Agency DPA accept**         | **none**                                     | none                          | **none** | **required by eligibility gate — DB-only stamp** |
| Background heartbeat          | —                                            | keep-alive stubs are no-ops   | —        | foreground-only                                  |

Pre-LIVE client safety = **generic SOS only** (on FindingDetail + LiveTracking). The identity-specific
"not my guard" panic is dark. `AgencyAccepted` and `IncomingOffer` are transient/poll-driven — you
can't reach them by tapping; they require a real live offer/accept in-window.

---

## 9. Test accounts & how to seed an eligible agency

There are **no committed live test accounts.** `apps/auth-service/test/fixtures/dispatch-seed.ts`
has synthetic helpers (`seedClient/seedAgency/seedCpo/seedBooking/seedEscrowHold`) for the
integration harness only. The named live agents (`kamrul0628`, `kamrul06`, `omnidevxstudio`) are
**not eligible** (no `region_code`, no verified docs, no DPA, ~0 CPOs).

**To exercise auto-dispatch, hand-seed a live agency** (mirror `seedAgency`):

1. `agents`: `type='company'`, `status='ACTIVE'`, `on_duty=TRUE`, set `region_code`, fresh
   `last_location`/`last_location_at` (<5 min), `last_location_mocked=FALSE`, `cooldown_until=NULL`,
   **`dpa_accepted_at = NOW()`** (no UI for this — DB-only).
2. `compliance_credentials`: verified, non-expired **licence** + **insurance** for that region.
3. ≥1 active managed CPO (`agents type='cpo' managed_by_org_id` + active `org_members`).
4. Flip both gates: `AUTO_DISPATCH_ENABLED=true` (env) + Redis `dispatch:enabled ≠ 'false'`, and use
   an app build with `EXPO_PUBLIC_AUTO_DISPATCH=true`.
5. Verify: `SELECT public.is_eligible_for_dispatch(:agency, :region, '{"armed":false}'::jsonb),
public.has_free_cpo_capacity(:agency, 1);` → both `true`.

Then book as a client in the same region with `booking_mode='now'`.

---

## 10. Pre-flag-flip blockers (ops/business, not code)

- **24 legacy-CPO `account_kind` backfill** — legacy CPOs resolve `individual`; need a roster mapping.
- **Finance sign-off** on FX (SAR/BDT/GBP), `platformFeePct`, `cancelFeePct` — currently demo/0
  placeholders; `/dispatch/request` is gated until signed off.
- **3-device manual smoke** — procedure at `apps/auth-service/test/smoke/3device-dispatch.md`.

---

## 11. Bug report template (auto-dispatch)

1. **Persona + step** (e.g. "§5.2 Agency — accept").
2. **Booking ID + the §7.3 SQL dump** (status, offers, escrow, ledger, mission).
3. **Both gates' state** (`AUTO_DISPATCH_ENABLED`, Redis `dispatch:enabled`, app `EXPO_PUBLIC_AUTO_DISPATCH`).
4. **Eligibility check** output for the agency (§9 query).
5. What happened vs expected · reproducibility · platform · screenshots · UTC timestamp.
6. Cross-check against **§8** first — confirm it's not a known dark surface.
