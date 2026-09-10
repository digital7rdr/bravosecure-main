# Uber-Style Bodyguard Auto-Dispatch — A-to-Z Implementation Plan

> **Purpose of this file.** This is a complete, ordered build plan for turning Bravo
> Secure's current _admin-mediated job board_ into an _Uber-style auto-dispatch_ flow:
> a client requests protection from point A → point B, the server pushes the job to the
> **nearest on-duty agency**, the agency **accepts or rejects**, rejection cascades to the
> next-nearest agency, and on acceptance the client sees the agency's **rating + missions
> completed** and a shared **Ops Room** opens for comms.
>
> It is written so a _fresh_ Claude Code session can execute it step by step with minimal
> extra thinking. Every step has a **▶ Plain English** summary so the product owner can
> read it and cut anything not needed before the engineer starts.

---

## 0. Read me first (rules for the implementing session)

1. **This plan does not authorize blanket changes.** Do the phases in order. Land each
   phase behind the feature flag (Phase 1) and keep the _existing_ admin flow working
   until Phase 13 says otherwise.
2. **Follow `CLAUDE.md`.** Small diffs, 2-space indent, single quotes, path aliases,
   no comments unless a `// Why:` is warranted. Run the change-safety gates after every
   phase (Phase 14).
3. **Security stop-conditions.** Three areas touch security-reviewed code. Do **not**
   improvise them — re-read the System Architecture Documentation first (see §16):
   - The **Ops Room** is E2E-encrypted group messaging. We only ever call the existing
     `SystemMessengerService.ensureBookingOpsRoom(...)` (metadata-only). Never write
     message envelopes or touch sender-key distribution.
   - **Push** payloads that reach FCM must stay opaque (audit tag **P0-N8**). Always go
     through `BookingPushBridge.publish(...)`; never add `bookingId` / `providerId` /
     literal `kind` to the Redis `push:events` channel message.
   - Do not add a "skip in dev" branch to any guard (`JwtAuthGuard`, `OrgManagerGuard`,
     `AdminGuard`, AppCheck).
4. **Verify before you code.** File paths and line numbers below were captured on
   branch `fix/2026-06-18-call-history-group-recovery` @ `8857db2`. Open each file and
   confirm the symbol still exists before editing (project rule: _verify, don't guess_).
5. **No DB writes to production from your machine.** Migrations are authored as files and
   applied through the project's normal Supabase migration flow.

### Locked product decisions (from the product owner, 2026-06-20)

| #   | Decision            | Choice                                                                                                                                                                                   |
| --- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Admin's role        | **Fully automatic.** Server dispatches. Admin (ops-console) only _monitors_ and can _override/cancel_; never in the critical path.                                                       |
| D2  | Payment timing      | **Charge after a guard accepts.** Request is free to send; client's Bravo Credits are charged the moment an agency accepts.                                                              |
| D3  | Who accepts         | **The agency / company agent** (`agents.type='company'`) accepts the whole job, then deploys its own CPO(s).                                                                             |
| D4  | Matching scope (v1) | **Nearest within the same region** (AE/SA/BD/GB). Straight-line (haversine) distance to pickup.                                                                                          |
| D5  | Agency teams        | The agency **registers up to ~10 real CPO login accounts** (managed CPOs, by email) and hands them to its guards. One email belongs to **one agency at a time** (leave/fire to move it). |
| D6  | Multiple missions   | One agency can **hold/run several missions at once**, bounded by its free CPO capacity.                                                                                                  |
| D7  | Crew assignment     | Accepting a job does **not** auto-pick guards. The agency **assigns its own CPOs per mission and names a leader** afterward.                                                             |
| D8  | Mission control     | A **shared step-tracker** shows every party the same progress; only the **leader** changes status; the leader taps **one button to finish** the mission (Uber-style).                    |

> **Phases 15–18 (Part II, §23–§27) cover D5–D8 and amend Phases 3, 6, and 8.** Read Part II
> alongside Part I — where they disagree, **Part II wins** (it is the newer requirement).

---

## 1. The system as it exists today (so you understand what you're replacing)

**Tech:** mobile = React Native/Expo (`src/`); backend = NestJS (`apps/auth-service`,
`apps/messenger-service`); admin web = Next.js (`apps/ops-console`); DB = Postgres/Supabase
(`supabase/migrations`); realtime = socket.io + Redis; push = FCM/APNs.

**Today's flow (admin-mediated job board):**

```
CLIENT app                         OPS-CONSOLE (admin website)              AGENCY/CPO app
──────────                         ───────────────────────────             ──────────────
submit booking ─────────────────►  booking = PENDING_OPS
(DRAFT→PENDING_OPS)                 admin clicks APPROVE  ◄── THE GATE
                                    (PENDING_OPS→OPS_APPROVED)
                                    publishFromBooking() ─────────────────► job = PUBLISHED
                                                                            agency sees it in feed,
client pays credits  ◄────────────  (OPS_APPROVED→…→CONFIRMED)              APPLIES (job_application)
                                    admin SHORTLISTS / ASSIGNS applicants
                                    (manual pick of crew + vehicle)
                                    admin clicks DISPATCH ────────────────► mission created
Ops Room opens (at ASSIGNED)        (CONFIRMED→LIVE)                        crew runs mission
live tracking ◄──── telemetry ────────────────────────────────────────────  PICKUP→LIVE→COMPLETED
```

**Canonical state machines (do not delete; we _extend_ them):**

- **Booking FSM** — `apps/auth-service/src/booking/state-machine.service.ts`
  `DRAFT → PENDING_OPS → OPS_APPROVED → PAYMENT_PENDING → CONFIRMED → LIVE → COMPLETED`
  (`CANCELLED` from any non-terminal). Actors: `CLIENT`, `OPS_HANDLER`, `CPO`, `SYSTEM`.
- **Job FSM** — `apps/auth-service/src/ops/job-state-machine.service.ts`
  `PUBLISHED → REVIEW → ASSIGNED → DISPATCHED` (`CANCELLED`).
- **Mission FSM** — `apps/auth-service/src/ops/mission-state-machine.service.ts`
  `DISPATCHED → PICKUP → LIVE → SOS → COMPLETED` (`ABORTED`).

**The admin gate we are bypassing (D1):**

- `POST /ops/bookings/:id/approve` → `ops.service.ts approveBooking()` (~line 169) does
  `PENDING_OPS → OPS_APPROVED` **and** calls `jobFeed.publishFromBooking()`
  (`job-feed.service.ts:64`). Until this fires, no agency can see the request.
- `apps/ops-console/src/app/bookings/[id]/page.tsx` is the admin UI for it (Approve modal,
  then the manual Team & Dispatch picker).

▶ **Plain English.** Right now a customer's request is invisible until a Bravo staff member
on the website clicks "Approve," and then staff hand-pick the guards. We're replacing the
staff approval + hand-picking with a computer that instantly offers the job to the closest
available security agency, just like Uber finds the nearest driver.

---

## 2. The target flow (what we're building)

```
CLIENT app                         SERVER (auth-service)                    AGENCY app
──────────                         ─────────────────────                    ──────────
submit request ────────────────►  booking = DISPATCHING
(point A→B, free)                  DispatchService.start():
                                     rank on-duty agencies in region
                                     by distance to pickup
"Finding your detail…"  ◄───────   create offer #1 → push ───────────────► INCOMING JOB card
(polls status)                                                              [Accept] [Reject] (30s)
                                   on REJECT/timeout → offer #2 → next…
                                   on ACCEPT:
                                     • charge client credits (D2)
                                     • create mission + crew (agency's CPO)
                                     • open Ops Room
"Guard accepted ★4.9 · 212 jobs" ◄ booking = CONFIRMED ───────────────────► agency = on mission
open Ops Room / live tracking      (admin only WATCHES on ops-console)      runs PICKUP→LIVE→DONE
```

**No-match path:** if every eligible agency rejects or none are online → booking goes to
`NO_PROVIDER` (terminal) and the client is told "no detail available right now."

▶ **Plain English.** The customer taps "request," sees a "finding your guard…" screen, the
nearest agency gets a pop-up to accept or decline, and if they decline it bounces to the
next nearest. When someone accepts, the customer's card is charged, they see who's coming
(with star rating and job count), and a private chat room opens. Staff can watch but don't
have to lift a finger.

---

## 3. Entity & concept map (old → new)

| Concept           | Existing thing to reuse                                                                                                             | New thing to add                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| The request       | `lite_bookings` row (has `pickup_lat/lng`, `dropoff_lat/lng`, `cpo_count`, `region_code`, `total_*`)                                | new `booking_mode='auto'` + new statuses             |
| The provider      | `agents` where `type='company'`, `status='ACTIVE'` (has `rating`, `jobs_total`, `last_lat/last_lng`, `last_location_at`, `on_duty`) | "go online + heartbeat location" loop                |
| The offer         | —                                                                                                                                   | **`dispatch_offers`** table + `DispatchService`      |
| Accept/Reject     | — (today agency _applies_, admin decides)                                                                                           | provider endpoints `accept` / `reject`               |
| Crew on the job   | `mission_crew`, `missions`                                                                                                          | created at accept instead of at admin-dispatch       |
| Comms             | `SystemMessengerService.ensureBookingOpsRoom()` (Ops Room)                                                                          | called at **accept** instead of at **assignment**    |
| Push to one user  | `BookingPushBridge.publish(userId, eventClass, details)`                                                                            | new `kind: 'dispatch-offer'` / `'provider-accepted'` |
| Client waiting UI | `BookingConfirmationScreen`, `OpsRoomReviewScreen` (already poll `/bookings/:id`)                                                   | new "Finding / Accepted" states                      |
| Provider job UI   | `JobMarketplaceScreen`, `JobDetailScreen`                                                                                           | new "Incoming offer" card                            |
| Admin             | `apps/ops-console` `/live`, `/bookings/[id]`                                                                                        | read-only dispatch monitor + cancel/override         |

▶ **Plain English.** We're not rebuilding the app. The "booking," the "agency profile," the
"chat room," and the "notifications" all already exist. We're adding one new piece — the
matchmaker that offers a job to the nearest agency and handles accept/decline — and wiring
the existing pieces to it.

---

## 4. New data model (Phase 1 detail lives here for reference)

### 4.1 `dispatch_offers` (new table)

```sql
-- supabase/migrations/<timestamp>_auto_dispatch.sql
CREATE TYPE dispatch_offer_status AS ENUM
  ('OFFERED','ACCEPTED','REJECTED','EXPIRED','SUPERSEDED','CANCELLED');

CREATE TABLE dispatch_offers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        UUID NOT NULL REFERENCES lite_bookings(id) ON DELETE CASCADE,
  provider_user_id  UUID NOT NULL,            -- the company agent (agents.user_id)
  rank              INT  NOT NULL,            -- 1 = nearest, 2 = next…
  distance_km       NUMERIC(7,2),            -- straight-line to pickup, for display/audit
  status            dispatch_offer_status NOT NULL DEFAULT 'OFFERED',
  offered_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,     -- offered_at + OFFER_TTL_SECONDS
  responded_at      TIMESTAMPTZ,
  reject_reason     TEXT
);
-- one PENDING offer per provider at a time. NOTE (D6): an agency can still run MANY
-- concurrent ACTIVE missions — this index only prevents double-offering races, it does
-- NOT cap active missions. Capacity is enforced in the Phase 3 eligibility query (§27).
CREATE UNIQUE INDEX dispatch_offers_one_live_per_provider
  ON dispatch_offers(provider_user_id) WHERE status = 'OFFERED';
-- fast "who currently holds the offer for this booking":
CREATE INDEX dispatch_offers_booking ON dispatch_offers(booking_id, status);
```

### 4.2 `lite_bookings` additions (new columns)

```sql
ALTER TABLE lite_bookings
  ADD COLUMN dispatch_mode     TEXT,        -- 'auto' for the new flow, NULL/legacy = old flow
  ADD COLUMN assigned_provider_user_id UUID,-- set on accept (the company agent)
  ADD COLUMN dispatch_started_at TIMESTAMPTZ,
  ADD COLUMN dispatch_settled_at TIMESTAMPTZ;
```

> Note: `conversation_id` / `comms_channel_id` already exists (the Ops Room link). Reuse it.

### 4.3 Booking FSM — new statuses & transitions

Add to `BookingStatus` in `apps/auth-service/src/booking/state-machine.service.ts`:

```
DRAFT → DISPATCHING            (actor CLIENT)   -- auto request submitted
DISPATCHING → CONFIRMED        (actor SYSTEM)   -- agency accepted + paid; CONFIRMED now means
                                                -- "accepted, awaiting crew assignment" (Part II §24)
DISPATCHING → NO_PROVIDER      (actor SYSTEM)   -- nobody available / all rejected (terminal)
DISPATCHING → CANCELLED        (actor CLIENT/SYSTEM)
-- CONFIRMED → LIVE → COMPLETED unchanged (mission is created when the agency assigns crew)
```

Keep all _existing_ transitions intact (legacy admin flow still uses `PENDING_OPS` etc.).

▶ **Plain English.** We add one new tracking table ("who got offered the job and did they
say yes") and a few new labels on the booking ("searching," "agreed," "no one available").
Nothing existing is removed, so the old staff flow keeps working while we build.

---

## 5. PHASE 0 — Branch, flag, and ground rules

**Steps**

1. Create a branch off `main`: `feat/auto-dispatch`.
2. Add a single feature flag the whole feature hides behind:
   - Backend: env `AUTO_DISPATCH_ENABLED` (read in the booking module + a new dispatch
     module). When false, `POST /bookings` behaves exactly as today.
   - Mobile: a runtime flag (e.g. a field in the bootstrap/config response, or an Expo
     `extra` constant) `autoDispatch: boolean` so the client app can route to the new
     "Finding…" screen only when on.
3. Confirm the project's scheduler exists for the watchdog (Phase 7): grep for
   `@nestjs/schedule` / `@Cron` / `ScheduleModule` in `apps/auth-service`. If present,
   reuse it; if not, add `ScheduleModule.forRoot()` to `app.module.ts` (this is the only
   infra addition).

**Verify:** app builds, old flow unaffected with flag off.

▶ **Plain English.** Put all the new work behind an on/off switch so we can ship it dark and
flip it on only when it's ready, without breaking the current product.

---

## 6. PHASE 1 — Database migration

**Files:** one new migration `supabase/migrations/<ts>_auto_dispatch.sql` (contents from §4).

**Steps**

1. Author the migration: `dispatch_offers` table + enum, `lite_bookings` new columns.
2. (Optional, performance) Add a covering index to speed the nearest-provider query:
   `CREATE INDEX agents_dispatch_pool ON agents (status, on_duty, type) WHERE type='company';`
   Proximity itself is computed in SQL (haversine) at query time — see Phase 4.
3. Regenerate types if the project does so (`mcp__supabase__generate_typescript_types` or
   the repo's documented type-gen). Update any hand-written row interfaces.

**Verify:** migration applies cleanly on a scratch/branch DB; `list_tables` shows the new
table; old tables untouched.

▶ **Plain English.** Create the one new table and a few new columns the matchmaker needs.
This is additive — it can't disturb existing data.

---

## 7. PHASE 2 — Provider "go online" + live location

The matchmaker can only rank agencies it can locate. These hooks **already exist** — we make
the agency app actually use them.

**Backend (already present — confirm, don't rebuild):**

- `PATCH /agents/me/duty` → `agent.service.ts` sets `agents.on_duty` (and flips `cpo_pool`
  availability). (`agent.controller.ts:157`)
- `PATCH /agents/me/location` → `agent.service.ts:1438` writes `agents.last_lat`,
  `last_lat`, `last_location_at = NOW()`. (`agent.controller.ts:162`)

**Steps**

1. **Provider app — "Go Online" toggle.** On the agency dashboard, add an online/offline
   switch that calls `PATCH /agents/me/duty`. Only `ACTIVE` company agents can go online.
   (Reuse the existing duty plumbing; this is just a visible control + state.)
2. **Provider app — location heartbeat while online.** When online, start a foreground
   location watcher (the project already uses `Geolocation.watchPosition` in
   `LiveTrackingScreen.tsx:221+` — copy that pattern) that `PATCH /agents/me/location`
   every ~30–60s. Stop it when offline/backgrounded.
3. **Staleness rule (backend).** Treat a provider as _locatable_ only if
   `on_duty = true AND last_location_at > NOW() - INTERVAL '5 minutes'`. This is enforced
   in the Phase 4 ranking query, not here.

**Verify:** toggle online on a device → `agents.on_duty=true` and `last_lat/lng` updates on
a timer; toggle offline → updates stop.

▶ **Plain English.** Like an Uber driver tapping "Go Online," an agency taps a switch to say
"we're available," and while it's on the app quietly reports their location so the system
knows who's nearby. If an agency hasn't reported a location in 5 minutes, we treat them as
not really online.

> **Decision point (trim-able):** v1 ranks an _agency_ by its own reported location (the
> manager/dispatcher device). A future refinement ranks by the agency's nearest on-duty CPO.
> Keep v1 simple unless you say otherwise.

---

## 8. PHASE 3 — The dispatch engine (server-side matchmaker)

**New module:** `apps/auth-service/src/dispatch/` with `DispatchService`,
`dispatch.controller.ts`, `dispatch.module.ts`. Wire it into `app.module.ts`. Reuse
`DatabaseService`, `SystemMessengerService`, `BookingPushBridge`, `OpsAuditService`,
the booking FSM, and (Phase 12) the wallet/credits service.

### 8.1 Constants

```ts
const OFFER_TTL_SECONDS = 30; // how long an agency has to accept before it cascades
const MAX_OFFERS = 8; // how many agencies to try before giving up
const LOCATION_FRESH_MINUTES = 5; // staleness cutoff from Phase 2
```

### 8.2 Ranking query (nearest eligible agency in region)

```sql
-- :pickup_lat, :pickup_lng, :region come from lite_bookings
SELECT a.user_id,
       a.display_name, a.call_sign, a.rating, a.jobs_total,
       (6371 * acos(
          cos(radians(:pickup_lat)) * cos(radians(a.last_lat)) *
          cos(radians(a.last_lng) - radians(:pickup_lng)) +
          sin(radians(:pickup_lat)) * sin(radians(a.last_lat))
       )) AS distance_km
FROM agents a
WHERE a.type = 'company'
  AND a.status = 'ACTIVE'
  AND a.on_duty = true
  AND a.last_location_at > NOW() - (:fresh_minutes || ' minutes')::interval
  AND a.region_code = :region          -- D4: same-region only
  AND has_free_cpo_capacity(a.user_id, :needed_cpos)  -- D6: free = active roster − committed (see §27)
  AND a.user_id NOT IN (               -- exclude agencies already holding a live offer
        SELECT provider_user_id FROM dispatch_offers WHERE status = 'OFFERED')
  AND a.user_id NOT IN (               -- exclude agencies already rejected/expired THIS booking
        SELECT provider_user_id FROM dispatch_offers
        WHERE booking_id = :booking_id AND status IN ('REJECTED','EXPIRED'))
ORDER BY distance_km ASC
LIMIT 1;
```

> If `agents` has no `region_code` column, derive region from the agency's coverage
> (`agent_profiles`/coverage) — confirm the column name before writing the query.

### 8.3 Core methods

- `start(bookingId)` — set booking `DISPATCHING`, `dispatch_started_at=NOW()`, then
  `offerNext(bookingId)`.
- `offerNext(bookingId)` — run the ranking query; if a candidate exists and offer count
  `< MAX_OFFERS`: insert a `dispatch_offers` row (`OFFERED`, `expires_at=NOW()+TTL`,
  next `rank`), then push the offer (Phase 7). If none / cap hit: `noProvider(bookingId)`.
- `accept(offerId, providerUserId)` — Phase 6. (Charges the client + opens the Ops Room; it
  does **not** pick crew — the agency crews each mission itself afterward, Part II §24.)
- `reject(offerId, providerUserId, reason?)` — mark `REJECTED`, `responded_at=NOW()`, then
  `offerNext`.
- `expire(offerId)` — mark `EXPIRED`, then `offerNext` (called by watchdog, Phase 7).
- `noProvider(bookingId)` — booking → `NO_PROVIDER`, `dispatch_settled_at=NOW()`, push the
  client a "no detail available" event, audit.
- `cancel(bookingId)` — supersede the live offer, booking → `CANCELLED`, notify the holder.

**Concurrency:** every state-changing method must do a conditional `UPDATE … WHERE
status='OFFERED' RETURNING id` (or `SELECT … FOR UPDATE` in a transaction) so two callers
can't both accept/expire the same offer — mirror the existing race-safe pattern in
`job-feed.service.ts cancel()` and `booking.service.ts payWithCredits()`.

**Verify (unit):** a fake pool of 3 agencies at different distances → offers go out nearest
first; reject advances to #2; #2 accept stops the cascade; empty pool → `NO_PROVIDER`.

▶ **Plain English.** This is the brain. It looks at every agency that's online and nearby,
picks the closest one, and offers them the job for 30 seconds. If they say no (or don't
answer in time), it offers the next closest, and so on — up to 8 tries. If nobody takes it,
it tells the customer no one's available.

---

## 9. PHASE 4 — Provider accept / reject endpoints

**File:** `apps/auth-service/src/dispatch/dispatch.controller.ts` (JWT-guarded; the caller
must be the offer's `provider_user_id`).

```
GET    /dispatch/offers/current          -> the caller's single live OFFERED offer (or null),
                                            joined with booking pickup/dropoff/eta/total + expires_at
POST   /dispatch/offers/:id/accept       -> DispatchService.accept(); Idempotency-Key
POST   /dispatch/offers/:id/reject        body: { reason? }   -> DispatchService.reject()
```

**Rules**

- `accept`/`reject` 409 if the offer is not `OFFERED` (already expired/superseded) — the app
  shows "this job was reassigned."
- Ownership check: `offer.provider_user_id === req.user.sub`, else 403.
- Idempotency on `accept` (two taps / two devices) — reuse the project's
  `Idempotency-Key` pattern (same as `pay-with-credits`).

**Verify:** accept an expired offer → 409; reject → next agency gets an offer; accept twice →
single mission.

▶ **Plain English.** Two buttons for the agency: Accept and Decline. Accept only works if the
offer is still live (not already grabbed or timed out). If they decline, the job instantly
moves on to the next agency.

---

## 10. PHASE 5 — Re-dispatch cascade + timeout watchdog

**Files:** `DispatchService` (the `expire`/`offerNext` loop) + a small cron.

**Steps**

1. **Watchdog cron** (every 5–10s): `SELECT id FROM dispatch_offers WHERE status='OFFERED'
AND expires_at < NOW()` → for each, call `DispatchService.expire(id)` (which marks
   `EXPIRED` and calls `offerNext`). Use the project scheduler from Phase 0.
2. **Provider-went-offline mid-offer:** if a provider toggles offline (`on_duty=false`) or
   their location goes stale while holding an offer, the watchdog should also expire that
   offer (extend the WHERE clause, or check at expiry time).
3. **Cascade safety:** `offerNext` already excludes `REJECTED`/`EXPIRED` providers for this
   booking and providers holding any live offer, so it always advances and never re-offers a
   declined agency.

**Verify:** offer a job, let the 30s lapse with no response → watchdog expires it and the next
agency is offered; provider goes offline holding an offer → it expires and cascades.

▶ **Plain English.** A timer in the background watches every outstanding offer. If 30 seconds
pass with no answer (or the agency goes offline), it cancels that offer and moves to the next
agency automatically — no human needed.

---

## 11. PHASE 6 — What happens on ACCEPT (the money + comms + mission moment)

This is the heart of `DispatchService.accept(offerId, providerUserId)`. Do it as one
logical transaction where the DB parts are atomic; the comms part is best-effort (mirrors
the existing `ensureBookingOpsRoom` try/catch pattern).

**Order of operations**

1. **Lock & validate** the offer (`FOR UPDATE`, must be `OFFERED` and not expired) and the
   booking (must be `DISPATCHING`). Mark offer `ACCEPTED`, `responded_at=NOW()`; mark all
   other offers for this booking `SUPERSEDED`.
2. **Charge the client (D2).** Debit the client's Bravo Credits for `total_eur` (or your
   chosen currency) using the existing wallet logic. **Reuse, don't duplicate:** factor the
   debit core out of `booking.service.ts payWithCredits()` (the `withTransaction` block that
   locks `wallet_balances`, checks balance, inserts the ledger row, decrements) into a
   shared method both can call — or call a wallet service method directly.
   - If the debit fails (`insufficient_credits`): **do not** complete. Either (a) roll the
     offer back to `OFFERED` and let the client top up, or (b) cancel and notify both sides.
     Recommended: pre-check balance at **request submit** (Phase 8) so this is rare; on
     failure here, cancel the acceptance and push the client to top-up. See §11.1.
3. **Set the assignment:** `lite_bookings.assigned_provider_user_id = providerUserId`,
   `dispatch_settled_at = NOW()`.
4. **Do NOT create the mission or crew here (changed in v2 — D7).** Accepting only commits
   the _agency_ to the job. The agency picks which of its own CPOs go, and names a leader,
   in **Part II §24** — and _that_ step materializes the `missions` + `mission_crew` rows.
   Between accept and crew-assignment the booking sits at `CONFIRMED` with no mission yet
   (this is the "Accepted · assigning team" step of the shared stepper, §25).
5. **Flip the booking** `DISPATCHING → CONFIRMED` (FSM actor `SYSTEM`). Here `CONFIRMED`
   means "agency accepted + paid, awaiting crew assignment." (The existing
   `CONFIRMED → LIVE` still fires later when the assigned crew checks in.)
6. **Open the Ops Room (metadata-only — security-reviewed path).** Call
   `SystemMessengerService.ensureBookingOpsRoom({ booking_id, short_code, client_id,
crew_user_ids: [providerUserId], ops_admin_user_id: SystemMessengerService.SYSTEM_USER_ID })`.
   - At accept the room has just the **client + the agency (company agent user)**. The
     assigned **CPOs are added to this same conversation in Part II §24** when the agency
     crews the mission (existing group member-add path).
   - **Why `SYSTEM_USER_ID` as creator:** there is no admin in the loop (D1). The system
     actor (`00000000-0000-0000-0000-000000000001`) is the existing server author for
     metadata. This stamps `lite_bookings.conversation_id` and posts the room's first card.
   - **STOP/verify:** confirm with the architecture doc that (a) the SYSTEM actor may create
     a client↔agency room, and (b) adding CPO members later uses the existing group
     rekey/sender-key path. If not, make the agency user the creator.
7. **Push the client** "provider-accepted" (Phase 7) and audit the whole thing
   (`OpsAuditService`) with `dispatch_source='auto'`.

### 11.1 Payment edge (chosen approach)

- At **request submit** (Phase 8): soft-check the client can afford the estimate; if not,
  route them to `CreditPaywallScreen` _before_ dispatching (so guards are never offered an
  unpayable job).
- At **accept**: do the real debit. On the rare failure, cancel the acceptance, re-open the
  offer or mark `NO_PROVIDER`, and push the client to top up. Document this in the code with
  a `// Why:` line.

**Verify:** accept → client wallet debited once, Ops Room (client + agency) opens and
`conversation_id` is stamped, booking `CONFIRMED`, **no mission row yet**, client receives the
accepted push; double-tap accept → still one debit (idempotent). The mission appears only
after the agency assigns crew (Part II §24).

▶ **Plain English.** When an agency taps Accept: we charge the customer's wallet, lock in
that agency, create the mission and put their guard on it, and open the private chat room —
all in one go. If the customer somehow can't pay at that instant, we don't strand the agency;
we undo and ask the customer to top up. (We try to catch that earlier so it rarely happens.)

---

## 12. PHASE 7 — Real-time delivery (push now, WebSocket later)

We use the **existing** opaque-push bridge so we touch zero crypto. WebSocket is an optional
enhancement, not required for v1.

### 12.1 Provider gets the offer (required)

- **Backend:** add methods on `apps/auth-service/src/ops/booking-push-bridge.service.ts`:
  ```ts
  dispatchOffer(providerUserId: string, offerId: string, bookingId: string) {
    return this.publish(providerUserId, 'dispatch', { kind: 'dispatch-offer', offerId, bookingId });
  }
  providerAccepted(clientUserId: string, bookingId: string) {
    return this.publish(clientUserId, 'booking', { kind: 'provider-accepted', bookingId });
  }
  noProvider(clientUserId: string, bookingId: string) {
    return this.publish(clientUserId, 'booking', { kind: 'no-provider', bookingId });
  }
  ```
  **P0-N8 STOP:** these IDs live in `details` (stored in Redis, fetched over the encrypted
  relay). The channel payload that reaches FCM stays `{userId, eventClass, eventId}` only —
  `publish()` already guarantees this. Do **not** change `publish()`'s channel message.
- **Consumer:** `apps/messenger-service/src/push/push.service.ts`
  `bootstrapPushEventsSubscriber` (lines ~132–178) routes by `eventClass`. Add a branch for
  `'dispatch'` that calls `sendDataOnlyToUser(...)` (same data-wake path as chat). No new
  push channel, no notification body.
- **Mobile (provider):** on the data-wake (and on app foreground), call
  `GET /dispatch/offers/current` and show the incoming-offer card (Phase 10). Also poll
  `/dispatch/offers/current` every few seconds while the agency is "Online" so a missed push
  still surfaces the job.

### 12.2 Client learns of acceptance (required, already easy)

- The client app **already polls** `GET /bookings/:id` (`OpsRoomReviewScreen` every 4s,
  `BookingConfirmationScreen` every 5s). When status flips `DISPATCHING → CONFIRMED` with
  `assigned_provider_user_id` set, the UI advances (Phase 9). The `provider-accepted` push
  just makes it feel instant. **No gateway change needed.**

### 12.3 (Optional, later) WebSocket for instant delivery

If you want sub-second delivery instead of polling, mirror the existing `mission:events`
Redis→gateway bridge (`messenger.gateway.ts:401–438`): publish `dispatch:events` from
auth-service, subscribe in the gateway, re-emit to `u:{providerId}` / `u:{clientId}` rooms.
**This edits the security-reviewed gateway — defer it, and treat it as its own reviewed
change.** Not required for v1.

**Verify:** with the provider app backgrounded, an offer wakes it; with it foregrounded,
polling shows the offer within a few seconds; client's "Finding…" screen flips to "Accepted"
on the next poll.

▶ **Plain English.** We reuse the exact notification system the app already uses for
messages — it only ever sends a tiny "wake up and check" ping, never private details, which
keeps it secure. The agency gets a pop-up; the customer's screen updates on its own. (A
fancier instant version over the live socket is possible later but not needed now.)

---

## 13. PHASE 8 — Client mobile: the request + "Finding your detail" experience

**Files:** `src/store/bookingStore.ts`, `src/services/api.ts`, `src/screens/booking/*`,
`src/screens/ops/OpsRoomReviewScreen.tsx`, `src/screens/booking/bookingStatus.ts`,
`src/navigation/types.ts`.

**Steps**

1. **Submit as auto.** When `autoDispatch` flag is on, `POST /bookings` sends
   `dispatch_mode: 'auto'` (or a dedicated `POST /bookings/auto` if you prefer not to
   overload). Backend: `BookingService.create()` branches — auto mode skips `PENDING_OPS`
   and calls `DispatchService.start(bookingId)`, leaving the booking `DISPATCHING`. (Legacy
   mode unchanged.)
2. **Affordability pre-check (D2).** Before/at submit, verify the client's credits cover the
   estimate; if short, route to `CreditPaywallScreen` first (existing screen).
3. **"Finding your detail" screen.** Repurpose `OpsRoomReviewScreen` (or add
   `FindingDetailScreen`) for the `DISPATCHING` state: animated "searching for your nearest
   protection detail…", optional live count of agencies being tried (derive from
   `dispatch_offers` via a `GET /bookings/:id/dispatch-status` if you want the ticker — nice
   to have, not required). Keep the existing 4s poll on `GET /bookings/:id`.
4. **"Guard accepted" card.** On `DISPATCHING → CONFIRMED`, show the accepted agency: name,
   ★ `rating`, "`jobs_total` missions completed," then continue to `BookingConfirmationScreen`
   (team + Ops Room deep-link already there) and `LiveTrackingScreen`. Data comes from
   `GET /bookings/:id/provider` (Phase 11/§14).
5. **"No detail available."** On `DISPATCHING → NO_PROVIDER`, show a clear empty state with
   "try again" / "schedule for later." (Route to `TripSummary` or a dedicated screen.)
6. **Resume logic.** Extend `bookingStatus.ts resumeTargetFor()` so a relaunch during
   `DISPATCHING` returns to the Finding screen; `NO_PROVIDER` → the empty state.
7. **Cancel while searching.** Wire the existing cancel button to `POST /bookings/:id/cancel`
   (which, for auto bookings, calls `DispatchService.cancel`).

**Verify (real device/dev build):** submit → "Finding…" → (accept on a 2nd device) →
"Accepted ★rating" → Ops Room opens → live tracking; submit with empty pool → "no detail
available"; relaunch mid-search resumes correctly.

▶ **Plain English.** The customer's side gets three new screens: a "finding your guard…"
spinner, an "agency accepted — here's their rating and track record" card, and a "sorry, no
one's available right now" message. It reuses the screens that already poll for status, so
it's mostly new visuals, not new plumbing.

---

## 14. PHASE 9 — Provider mobile: the incoming-offer card

**Files:** `src/screens/agent/*` (reuse `JobDetailScreen` / `JobMarketplaceScreen` styling),
`src/services/api.ts` (add `dispatchApi.getCurrentOffer/accept/reject`), provider dashboard.

**Steps**

1. **Online control** (from Phase 2) on the agency dashboard.
2. **Incoming-offer card.** When `GET /dispatch/offers/current` returns an offer (via push
   wake or poll): full-screen/modal card showing pickup → dropoff, distance/ETA, pay, and a
   **countdown** to `expires_at`, with **Accept** / **Decline**. On Accept →
   `POST /dispatch/offers/:id/accept` → go to the active mission / Ops Room. On Decline →
   `POST /dispatch/offers/:id/reject`. On countdown reaching zero or a 409 → "offer expired."
3. **(D3) Deploy a CPO.** If you chose explicit deploy (§11 step 4a), the Accept action lets
   the agency pick which on-duty CPO to send (list from the org roster); otherwise auto-pick.
4. **After accept**, the agency lands in the existing mission UI (`/agents/me/active-mission`,
   `AgentLiveTrackerScreen`) and the Ops Room chat.

**Verify:** online agency receives the card, countdown ticks, Accept creates the mission and
opens chat, Decline bounces the job onward, letting it expire shows "expired."

▶ **Plain English.** The agency sees an Uber-driver-style pop-up: where, how far, how much, a
30-second timer, and Accept/Decline. Accept puts their guard on the job and opens the chat;
Decline passes it on.

---

## 15. PHASE 10 — Expose rating + missions-completed to the client

The numbers already exist on `agents` (`rating`, `jobs_total`) but aren't sent to clients.

**Steps**

1. **New endpoint** `GET /bookings/:id/provider` (client owns booking) returning the
   assigned agency card: `{ display_name, call_sign, rating, jobs_total, … }` by joining
   `agents` on `lite_bookings.assigned_provider_user_id`. (Don't widen the existing
   `AssignedCpoDto`; add a focused `ProviderCardDto`.)
2. **Mobile type + call** in `src/services/api.ts`; render in the "Guard accepted" card
   (Phase 8 step 4) and optionally enrich `BookingConfirmationScreen`'s team card.
3. (Optional, future) Post-mission rating: `lite_bookings.rating` exists but is unused — a
   later phase lets the client rate the agency and recomputes `agents.rating`. Out of scope
   for v1 unless you want it.

**Verify:** accepted booking returns real rating/jobs_total; client card shows them.

▶ **Plain English.** Show the customer the agency's star rating and how many jobs they've
done — the data's already stored, we just need to send it to the customer's screen.

---

## 16. PHASE 11 — Ops-console: monitor + override (admin watches only, D1)

**Files:** `apps/ops-console/src/app/live/*`, `apps/ops-console/src/app/bookings/*`,
`apps/ops-console/src/lib/api.ts`, `apps/ops-console/src/lib/rbac.ts`.

**Steps**

1. **Dispatch monitor.** Add a read-only view (extend `/live` or a new `/dispatch`) listing
   `DISPATCHING` bookings with: which agency currently holds the offer, its rank/distance,
   the countdown, and the trail of rejected/expired offers. Back it with a
   `GET /ops/dispatch/active` (admin-guarded) reading `dispatch_offers` + bookings.
2. **Override / cancel.** Buttons (SUPERVISOR+) to cancel a stuck dispatch
   (`DispatchService.cancel`) or force-assign a specific agency (calls `accept` server-side
   with an admin actor). These are _exceptional_, not the normal path.
3. **Keep what stays.** `/live/[id]` (telemetry, SOS, route, deployment checklist), payout
   review/completion, and `/agents` roster all remain. The manual approve+pick UI on
   `/bookings/[id]` stays available for the _legacy_ flow but is no longer the default.
4. **`dispatch_source` audit.** Surface whether a mission was `auto` or `manual override` on
   the mission detail page.

**Verify:** with auto-dispatch on, a request appears in the monitor and resolves without any
admin click; cancel/override works when used.

▶ **Plain English.** Staff get a live "control tower" screen that shows requests finding their
agency in real time — but they don't have to do anything. They keep their override and
cancel buttons for emergencies, and all the live-mission monitoring they have today.

---

## 17. PHASE 12 — Payment wiring (charge-after-accept, D2)

Covered operationally in Phase 6 step 2 / §11.1. Concretely:

**Steps**

1. **Refactor** the credit-debit core out of `booking.service.ts payWithCredits()` into a
   reusable wallet method (keeps the family-payer + lock + ledger logic in one place).
2. **Call it from `DispatchService.accept`** to debit at acceptance.
3. **Affordability pre-check** at request submit (Phase 8 step 2).
4. **Failure handling** at accept (§11.1): cancel acceptance, push client to top up.
5. Keep `lite_bookings` payment fields (`payment_captured`, totals) consistent with the
   legacy meaning so the ops-console payout/completion flow (`completeBooking`) still settles
   correctly at mission end.

**Verify:** accept debits exactly once; insufficient-funds at accept is handled cleanly;
mission completion still pays out the agency via the existing `completeBooking` path.

▶ **Plain English.** The customer pays the moment an agency accepts, using the wallet system
that already exists — we just trigger the charge at "accept" instead of after staff approval.
We double-check the customer can afford it before we even start searching, so an agency is
never left holding an unpayable job.

---

## 18. PHASE 13 — Edge cases & cut-over

**Handle explicitly (write a test for each):**

1. **No agency online / all reject / cap reached** → `NO_PROVIDER`, client notified.
2. **Client cancels while searching** → live offer superseded, current holder notified, no
   charge.
3. **Provider offline / location stale mid-offer** → watchdog expires + cascades (Phase 5).
4. **Double-accept / accept-after-expiry** → idempotent; 409 on stale.
5. **Two bookings, one nearby agency** → the `one-live-offer-per-provider` unique index
   prevents double-offering; the second booking skips that agency.
6. **App killed mid-flow** (both sides) → resume via polling + `resumeTargetFor`.
7. **Scheduled ("book later") requests** → either dispatch at `pickup_time - lead` (a cron
   that calls `start()` when due) or keep scheduled bookings on the legacy admin path for
   v1. Recommend: **v1 handles "now" requests via auto-dispatch; "later" stays legacy** to
   limit scope. Flag this with the product owner.

**Cut-over:** once Phases 1–14 pass on staging and a real 3-device smoke works, flip
`AUTO_DISPATCH_ENABLED` + the mobile flag on for "book now." Leave the legacy admin flow in
place as the fallback and for scheduled bookings.

▶ **Plain English.** Make sure the awkward situations are handled: nobody available, customer
cancels, agency drops off, double taps, two jobs wanting the same agency, and the app being
killed. For the first release, only instant ("now") requests go through the new system;
scheduled-for-later bookings keep using the current staff flow until we extend it.

---

## 19. PHASE 14 — Tests & quality gates (run after every phase)

Per `CLAUDE.md` change-safety rules:

1. **New unit tests** (the direct test): `DispatchService` ranking + cascade + accept;
   accept/reject controller; payment-at-accept; FSM additions. Put backend specs next to the
   services (`*.spec.ts`), following `job-feed.service.spec.ts` style.
2. **Regression tests** (the related flow): run the **booking** Jest project
   (`npm test -- --selectProjects=booking`) and the ops smoke specs; run
   `npm run test:crypto` if anything near messaging changed (it shouldn't — we only call
   `ensureBookingOpsRoom`).
3. **Typecheck baselines:** `npm run typecheck` (mobile, ≤ 96 baseline) **and**
   `cd apps/ops-console && npm run typecheck`. Backend services: their own `npm run build`.
4. **Lint:** `npm run lint`.
5. **Targeted first, broad second:** narrow suite, then `npm test`.
6. **Manual smoke (the feature test):** real dev build, 3 accounts (1 client, 2 agencies):
   request → offer to nearest → reject → cascade to 2nd → accept → charge → Ops Room → live
   tracking → complete. Plus one error path (no agency online).
7. **Do not commit on a red gate.** Don't use `--no-verify`.

▶ **Plain English.** After each chunk of work, run the automated tests and type checks the
project already enforces, then actually try the feature on real phones with one customer and
two agencies — including the "nobody available" case. Don't ship if anything's red.

---

## 20. File-touch quick index (where the work lands)

**Backend — `apps/auth-service/src/`**

- `dispatch/` **(new)** — `dispatch.service.ts`, `dispatch.controller.ts`, `dispatch.module.ts`, specs
- `booking/booking.service.ts` — auto-mode branch in `create()`; extract wallet-debit core
- `booking/state-machine.service.ts` — new statuses/transitions (`DISPATCHING`, `NO_PROVIDER`)
- `booking/booking.controller.ts` — auto submit; `GET /bookings/:id/provider`
- `ops/booking-push-bridge.service.ts` — `dispatchOffer/providerAccepted/noProvider`
- `ops/system-messenger.service.ts` — **reuse** `ensureBookingOpsRoom` (no change ideally)
- `agents/agent.service.ts` / `agent.controller.ts` — **reuse** duty + location + lead-gated
  mission endpoints (pickup / go-live / **complete** = one-tap finish)
- `org/org.controller.ts` / `org-cpo.service.ts` — **extend** managed-CPO create (real-email
  validation, one-email-one-agency, 10-cap); add `GET /org/missions` + `POST /org/bookings/:id/crew`
  (Part II §23–§24)
- `app.module.ts` — register `DispatchModule` (+ `ScheduleModule` if missing)

**Backend — `apps/messenger-service/src/`**

- `push/push.service.ts` — add `'dispatch'` branch in the push:events subscriber (data-wake)
- _(optional, deferred)_ `gateway/messenger.gateway.ts` — `dispatch:events` bridge

**DB — `supabase/migrations/`**

- `<ts>_auto_dispatch.sql` **(new)** — `dispatch_offers` + `lite_bookings` columns + indexes

**Mobile — `src/`**

- `store/bookingStore.ts`, `services/api.ts` — auto submit, `dispatchApi`, provider card
- `screens/ops/OpsRoomReviewScreen.tsx` or `screens/booking/FindingDetailScreen.tsx` **(new)**
- `screens/booking/BookingConfirmationScreen.tsx`, `bookingStatus.ts`, `navigation/types.ts`
- `screens/booking/missionJourney.ts` **(new)** — shared stepper helper (Part II §25)
- `screens/agent/*` (agency) — Online toggle + location heartbeat + incoming-offer card +
  **roster management** + **multi-mission dashboard** + **assign-crew/leader sheet** (Part II §23–§24)
- `screens/agent/*` (CPO) — assigned-mission view + stepper + lead-only Start/Go-live/**Finish** (Part II §26)

**Admin — `apps/ops-console/src/`**

- `app/live/*` or `app/dispatch/*` **(new)** — dispatch monitor
- `lib/api.ts`, `lib/rbac.ts` — `GET /ops/dispatch/active`, override/cancel gating

---

## 21. Security stop-conditions (re-read the architecture doc before touching)

| Area                        | Rule                                                                                 | Where it bites in this plan |
| --------------------------- | ------------------------------------------------------------------------------------ | --------------------------- |
| Ops Room / group E2E        | Metadata-only via `ensureBookingOpsRoom`; never write envelopes or sender keys       | Phase 6 step 6              |
| Push opacity (P0-N8)        | FCM-facing payload stays `{userId, eventClass, eventId}`; details live in Redis only | Phase 7 §12.1               |
| Sealed sender / sender-cert | Untouched — we add no new message types                                              | n/a (don't add any)         |
| Auth guards                 | No "skip in dev"; provider endpoints stay JWT-guarded with ownership checks          | Phase 4                     |
| WS gateway                  | Security-reviewed; the optional `dispatch:events` bridge is its own reviewed change  | Phase 7 §12.3               |
| File Vault MFA              | Not involved; do not touch                                                           | n/a                         |

▶ **Plain English.** Three things are security-sensitive and must reuse the existing,
already-reviewed machinery exactly: the encrypted chat room, the notification pings (which
must stay content-free), and the login guards. Don't get creative there — copy the existing
pattern and, if in doubt, check the security doc first.

---

## 22. Suggested execution order (TL;DR checklist)

- [ ] **P0** Branch + feature flag + scheduler check
- [ ] **P1** Migration (`dispatch_offers` + booking columns)
- [ ] **P2** Provider "Go Online" + location heartbeat
- [ ] **P3** `DispatchService` (ranking + offer cascade) + unit tests
- [ ] **P4** Provider accept/reject endpoints
- [ ] **P5** Watchdog cron (timeout + offline cascade)
- [ ] **P6** Accept side-effects (charge + mission + crew + Ops Room + client push)
- [ ] **P7** Push wiring (provider offer wake + client accepted)
- [ ] **P8** Client UI (Finding → Accepted → No-provider, resume logic)
- [ ] **P9** Provider UI (incoming-offer card + countdown)
- [ ] **P10** Expose rating + jobs_total to client
- [ ] **P11** Ops-console monitor + override
- [ ] **P12** Payment-at-accept wiring
- [ ] **P13** Edge cases + cut-over (now-only v1; later = legacy)
- [ ] **P15** Agency CPO roster — register real emails, one-email-one-agency, 10-cap (§23)
- [ ] **P16** Agency multi-mission dashboard + assign crew + leader (creates the mission) (§24)
- [ ] **P17** Shared mission stepper across client + agency + CPO (§25)
- [ ] **P18** CPO experience + one-tap **Finish mission** (lead-only) (§26)
- [ ] **P14** Tests + gates + 3-device smoke — run continuously and as the final gate
      (now also covers roster, crew-assign, leader rules, and complete)

> When in doubt, prefer the smallest diff that keeps the legacy flow working, and verify each
> symbol against the live code before editing. This whole feature ships dark behind one flag.

---

# PART II — Agency teams, mission stepper & one-tap complete (v2, 2026-06-20)

> **Why this part exists.** After Part I was written, the product owner added four things:
> agencies run **teams of CPOs** and several missions at once; the agency **assigns its own
> guards per mission and names a leader**; everyone sees a **shared progress tracker**; and
> the leader **finishes the mission with one tap** (Uber-driver style). These map almost
> exactly onto Bravo's _existing managed-CPO model_ (`org_members` + `POST /org/cpos`) and the
> _existing lead-only mission controls_ — so this is mostly _wiring + UI_, not new crypto or
> new auth.
>
> **Where Part II changes Part I:** accept no longer auto-picks crew (see §27). Read §27 first.

---

## 23. PHASE 15 — Agency CPO roster (register real emails → login accounts) [D5]

The agency sets up its guards **once**: it registers real email addresses as login accounts,
hands the logins to its guards, and can fire/replace them later.

**This already mostly exists — confirm before building:**

- `POST /org/cpos` (`apps/auth-service/src/org/org.controller.ts:24`, `org-cpo.service.ts`)
  creates a managed CPO: a `users` row + `agents` row (`type='cpo'`, `managed_by_org_id=org`,
  `status='DOCS_PENDING'`) + `org_members` row (`member_role='cpo'|'manager'`,
  `status='active'`). The agency sets `email` + `temp_password`; the CPO logs in with those.
- `GET /org/cpos` lists the roster; `PATCH /org/cpos/:memberUserId/status` →
  `active|suspended|removed` is the **fire / suspend / reinstate** control, and already
  removes a member from chat channels on suspend/remove.
- Guarded by `OrgManagerGuard` (`apps/auth-service/src/org/org-manager.guard.ts`) — tenant
  isolation is already enforced.

**What to ADD (on top of `org-cpo.service.ts` create path):**

1. **Real-email validation (D5 — "valid mail not random").** Strict RFC-5322 format check,
   reject obvious junk/disposable domains, normalize (lowercase/trim). _Recommended:_ a
   lightweight **verify step** — send a 6-digit code to the email (dev stub `123456`) that
   must be entered before the account activates (or an MX/deliverability probe). This is the
   only safe way to guarantee the email is genuine. **Trim-able** if the owner accepts
   format-only validation.
2. **One email = one agency (D5).** Before create, reject if the email already maps to any
   `users`/`org_members` row that is `active` or `suspended` in _any_ agency → `409
email_already_in_an_agency`. Allow re-registration only if the prior membership is
   `removed` (i.e. they left / were fired). This is the "one mail, one agency until they
   leave" rule.
3. **Roster cap (D5/D6).** `MAX_CPOS_PER_AGENCY = 10` (config constant). Count `active`
   `org_members` for the org; `409 roster_full` if exceeded.
4. **Safe fire.** When `PATCH …/status → removed`: also force the CPO offline
   (`on_duty=false`), drop them from any Ops Rooms, and **block the removal if they are the
   current LEAD on a non-completed mission** (`409 reassign_leader_first`).

**Verify:** register a valid email → CPO can log in; register a fake/invalid email →
rejected; register an email already in another agency → `409`; register an 11th CPO → `409`;
fire a CPO → freed to join elsewhere; can't fire an active lead without reassigning.

▶ **Plain English.** The agency creates up to ten guard logins from real email addresses
(the system checks each email is genuine and refuses an email already used by another
agency), then gives those logins to its guards. Firing a guard just switches them off the
roster, which frees that email to be used by another agency later.

> **Security note:** this touches identity (account creation + the one-agency rule). Keep all
> guards intact, validate server-side, never trust the client. No change to JWT/sessions.

---

## 24. PHASE 16 — Agency dashboard: many missions, assign crew, name a leader [D6/D7]

The agency runs in the **mobile app** (it is a company agent). It can hold several accepted
jobs at once and crew each one from its roster. **Assigning crew is the step that creates the
mission** (it replaces the old admin "dispatch" click).

**Capacity rule (D6) — feeds Phase 3 eligibility (§27):**

```
free_cpos(agency) = (active roster CPOs)
                  − (distinct CPOs currently in a non-completed mission_crew)
                  − (Σ cpo_count of this agency's CONFIRMED bookings that have no mission yet)
offer eligible  ⇢  free_cpos(agency) >= booking.cpo_count
```

**New endpoints (`OrgManagerGuard`-guarded):**

- `GET /org/missions` — every job belonging to this agency across states:
  _accepted-awaiting-crew_ (booking `CONFIRMED`, no mission), _crewed/active_ (mission
  `DISPATCHED→…→LIVE`), _recent completed_. Each row carries pickup/dropoff, the shared
  stepper state (§25), assigned crew, and who the leader is.
- `POST /org/bookings/:bookingId/crew` — **assign crew + name the leader.** Body:
  `{ cpo_user_ids: string[], lead_user_id: string }` (the agency picks roster members, shown
  by their registered **email**/name). This handler:
  1. Validates every `cpo_user_id` is an **active member of THIS agency** and is **free**
     (not on another non-completed mission); validates `lead_user_id ∈ cpo_user_ids`;
     validates `length` matches `booking.cpo_count` (or your allowed range); booking must be
     this agency's and `CONFIRMED` with no mission yet.
  2. **Creates the mission** (reuse the shape from `job-feed.service.ts dispatch()`): insert
     `missions` (`status='DISPATCHED'`, `short_code`), insert `mission_crew` rows (the lead
     gets `is_lead=true`, `role='LEAD'`; others `CP`), seed `mission_waypoints` +
     `agent_deployment_checks`.
  3. **Adds the CPOs to the existing Ops Room** (client + agency already there from accept)
     via the existing group member-add path. **STOP/verify** the group rekey/sender-key flow
     on member add (security-reviewed).
  4. **Pushes each assigned CPO** (`BookingPushBridge` → `kind:'mission-assigned'`) so the
     job shows up on their phone (Phase 18).
- `POST /org/missions/:missionId/reassign` _(optional)_ — swap a CPO / change the leader
  **before** the mission goes `LIVE`.

**Agency mobile UI:**

- A **missions list** ("you have 3 jobs") with a badge on those still needing crew.
- Tap a job → **assign-crew sheet**: pick guards from the roster (by email/name), tap one as
  ★ **Leader**, confirm. After confirm, the job moves to "Team dispatched" on the stepper.
- For active jobs, show the live stepper (§25) and the Ops Room.

**Verify:** accept 3 jobs → all 3 show in `GET /org/missions`; assign 2 guards + a leader to
one → mission row + 2 crew rows created, both guards see it on their phones and join the chat,
the non-leader has no status buttons; try to assign a guard already on another live mission →
rejected; capacity is consumed so the agency stops being offered jobs it can't crew.

▶ **Plain English.** The agency sees all its accepted jobs in a list. It opens a job and picks
which of its registered guards to send, tapping one as the team leader. The instant it
confirms, the mission is created, those guards get the job on their phones, and they join the
customer's chat room. An agency only keeps getting new offers while it still has free guards.

---

## 25. PHASE 17 — Shared mission stepper (one truth for client + agency + CPO) [D8]

One small helper turns `(booking.status, mission?.status)` into a step so **all three apps
show the same progress**.

| #   | Step label                | Real state                      | Who advances it            |
| --- | ------------------------- | ------------------------------- | -------------------------- |
| 1   | Searching for your detail | booking `DISPATCHING`           | system (auto-cascade)      |
| 2   | Accepted · assigning team | booking `CONFIRMED`, no mission | agency (assigns crew, §24) |
| 3   | Team dispatched           | mission `DISPATCHED`            | lead CPO (Start)           |
| 4   | En route to pickup        | mission `PICKUP`                | lead CPO (Go live)         |
| 5   | Protection active         | mission `LIVE`                  | lead CPO (Finish)          |
| 6   | Completed                 | mission `COMPLETED`             | —                          |

Off-path: **SOS** overlays any active step; `CANCELLED` / `NO_PROVIDER` / `ABORTED` are
terminal side-states.

**Build:**

1. A **pure function** in shared mobile code, e.g. `src/screens/booking/missionJourney.ts`:
   `journeyStep(booking, mission?) → { index, label, canAdvanceBy }`. No new backend logic.
2. A reusable **horizontal stepper component** rendered on: the client's
   `BookingConfirmationScreen`/`LiveTrackingScreen`, the agency's mission detail (§24), and
   the CPO's mission screen (§26).
3. Make sure the three feed endpoints all return `booking.status` **and** `mission.status`:
   client `GET /bookings/:id`, agency `GET /org/missions`, CPO `GET /agents/me/active-mission`.

**Verify:** as the lead advances the mission, the same step lights up on the customer's, the
agency's, and the other guards' screens within a poll cycle.

▶ **Plain English.** Everyone — customer, agency, and each guard — sees the identical progress
bar: _Searching → Accepted → Team sent → On the way → Protecting → Done._ One piece of code
decides the current step, so nobody ever sees a different story.

---

## 26. PHASE 18 — CPO experience: log in, see your job, leader finishes with one tap [D8]

The guard logs in with the **agency-issued email**, sees the job, and runs it. Status control
is **leader-only** (this already exists — the agent mission endpoints are lead-gated).

**Steps:**

1. **Login = no new auth.** The CPO signs in with the email + password the agency set in §23,
   landing in the CPO/agent side of the mobile app.
2. **See the assigned job.** `GET /agents/me/active-mission` returns the mission the agency
   assigned (in §24). Show the stepper (§25), the mission details (pickup/dropoff, client,
   dress brief, waypoints), and the Ops Room chat.
3. **Leader-only controls (reuse existing, already lead-enforced):**
   - **Start / En route** → `POST /agents/me/missions/:id/pickup` (`DISPATCHED→PICKUP`)
   - **Go live** → `POST /agents/me/missions/:id/go-live` (`PICKUP→LIVE`)
   - **Finish mission (one tap, Uber-style)** → `POST /agents/me/missions/:id/complete`
     (`LIVE→COMPLETED`) — a big confirm button or swipe-to-complete. This already triggers
     payout settlement.
4. **Non-leader CPOs:** identical screen, but the status buttons are hidden/disabled — they
   watch the stepper, use the chat, and can still push their own telemetry / raise SOS.
5. **On finish:** mission `COMPLETED` → booking `COMPLETED`; payout credited to the **agency
   wallet** (existing `completeBooking`/settlement path — confirm it credits the org payee,
   `mission_payouts.payee_user_id`); the CPOs are **freed** (capacity returns to the pool so
   the agency can be offered new jobs); Ops Room archived.

**Verify:** leader sees Start/Go-live/Finish and can advance; a non-leader sees the same job
read-only; tapping **Finish** completes the mission, pays the agency, frees the guards, and
flips every party's stepper to _Completed_.

▶ **Plain English.** A guard opens the app, logs in with the account the agency gave them, and
sees their job and the same progress bar. The team leader gets the buttons — Start, Go live,
and a big **Finish mission** button like an Uber driver ending a trip. The other guards can
watch and chat but can't change anything. Finishing the job pays the agency and frees the
guards for the next one.

---

## 27. Amendments to Part I (apply these — Part II overrides where they differ)

1. **Phase 3 eligibility (§8.2):** add the capacity filter `has_free_cpo_capacity(agency,
needed_cpos)` using the formula in §24. An agency with no free guards is **not** offered a
   job. (Keep the one-PENDING-offer index; multiple _active_ missions are allowed.)
2. **Phase 6 (accept):** accept **no longer creates the mission or crew**. It charges the
   client (D2), sets `assigned_provider_user_id`, flips booking `DISPATCHING→CONFIRMED`
   (= "accepted, awaiting crew"), and opens the Ops Room with **client + agency only**. The
   mission + crew are created in **§24** when the agency assigns its team; CPOs are added to
   the Ops Room there.
3. **Phase 8 (client UI):** the "Guard accepted" card now reads as _"agency accepted — your
   detail is being assigned,"_ then the shared stepper (§25) advances through team-dispatched
   → en-route → active → completed.
4. **Data model:** no new _mission_ state is needed (a `CONFIRMED` booking with no mission =
   "accepted, awaiting crew"). `org_members` (roster) + `mission_crew.is_lead` (leader) +
   the lead-gated agent endpoints already support teams, leaders, and one-tap finish. Add
   only: `MAX_CPOS_PER_AGENCY`, the email-validation + one-agency checks (§23), the capacity
   helper (§24), and the new `/org/missions` + `/org/bookings/:id/crew` endpoints.
5. **Tests (Phase 14):** extend the 3-device smoke to: register a roster → accept 3 jobs →
   crew each with a leader → guards see jobs + chat → leader runs and **one-tap finishes** →
   agency paid + guards freed. Add unit tests for email/one-agency validation, capacity, and
   leader-only status changes.

▶ **Plain English.** Three earlier steps shift: the system only offers jobs to agencies that
have a free guard; "accept" now just locks in the agency and charges the customer (the agency
picks its guards a moment later); and the customer's "accepted" screen now leads into the
shared progress bar. Everything else in Part I stays the same.

---

# PART III — Production hardening (12 expert perspectives)

> **What this part is.** Part I/II make the feature _work_; Part III makes it _survive
> production_ for a safety-critical, money-handling, multi-jurisdiction service. It is the
> output of 12 adversarial reviews (security, payments, reliability, trust & safety, privacy,
> mobile-UX, observability, anti-fraud, scalability, lifecycle, legal, testing) run against
> this plan and the real code. Everything is tagged **P0** (must fix before flipping the flag
> on), **P1** (fast-follow), **P2** (later). Read **## P0 launch-blockers** first.

### ⚠️ Corrections to Part I / II (these reviews proved the earlier text wrong in 6 places)

1. **Watchdog must NOT use `@nestjs/schedule` or a bare `setInterval`.** `auth-service` runs
   **multiple replicas**, so every in-process loop (the offer-expiry watchdog, any
   book-later trigger, reconciliation) must copy the existing **Redis `SET NX`-locked
   `setInterval`** pattern in `payment-pending-expiry.service.ts`, or N pods double-cascade.
   _(Supersedes Phase 0 step 3 and Phase 5 step 1.)_
2. **The lead's one-tap Finish does NOT settle money today.** Payout lives only in
   `OpsService.completeBooking` (admin-only). Part II §26's claim is false — you must extract
   an actor-agnostic `SettlementService` and add a lead-gated complete endpoint, or the
   agency is **never paid** in the auto flow.
3. **The offer must not carry the principal's address.** Part I §9/§14 ship pickup/dropoff to
   every offered (and rejecting) agency — that's the crown-jewel leak. Pre-accept = coarse
   only; precise location only after accept.
4. **`agents` has no `region_code` column** — the §8.2 ranking query can't run as written.
   Add region (or derive from coverage) **and** prefer **PostGIS `geography`+GiST+`ST_DWithin`**
   over DECIMAL haversine on the hot path.
5. **The Ops Room member-add path Part II §24 assumes does not exist** for booking rooms —
   the server can't distribute the Signal group key. The agency device must own the rekey.
6. **CI does not run backend (`auth-service`) tests** — your new `DispatchService` specs would
   be invisible to the gate. Fix CI before relying on those tests.

---

## ## P0 launch-blockers (consolidated & de-duplicated — do not flip the flag until these are done)

- [ ] **LB1 · Principal location is the crown jewel.** Pre-accept, `GET /dispatch/offers/current`
      returns only coarse data (region + bucketed distance + truncated/zone pickup + time window +
      price). Precise pickup/dropoff/address only via a separate `GET /dispatch/offers/:id/full`
      that 403s unless `offer.status='ACCEPTED' AND caller==provider`. Purge/invalidate location
      for rejected/expired/superseded offers; audit every full read. _(security, privacy, mobile-UX)_
- [ ] **LB2 · Ops Room group-key distribution.** Server `conversations.addMember` writes
      metadata only — it cannot hand a CPO the Signal group key. Make the **agency company device**
      the room admin/owner and wire a conversations-scoped membership-intent drain (mirror
      `orgWorkspace/membershipIntents.ts`, which today only covers `department_channels`). **STOP /
      verify** against the architecture doc. _(security)_
- [ ] **LB3 · Money is offer-anchored & race-safe.** The debit happens _inside_ the same
      transaction as `UPDATE dispatch_offers SET status='ACCEPTED' WHERE id=$1 AND status='OFFERED'
AND expires_at>NOW() RETURNING` (0 rows ⇒ 409, no charge); booking must be `DISPATCHING`;
      ledger row stamped with `offer_id`; `Idempotency-Key` interceptor wired on accept. _(security, payments)_
- [ ] **LB4 · Lead Finish actually settles.** Extract `SettlementService.settle(bookingId,
actor)` from `OpsService.completeBooking`; add lead-gated `POST /agents/me/missions/:id/complete`
      (idempotent, conditional `UPDATE ... WHERE status='LIVE' AND is_lead`). _(payments)_
- [ ] **LB5 · Charged-but-never-crewed orphan.** Add `crew_deadline_at` at accept + a
      crew-assignment SLA sweep (Redis-locked) that auto-refunds + flags the agency if no crew is
      assigned in time. _(payments)_
- [ ] **LB6 · Abort/refund correctness.** Migrate abort cleanup from the OLD pool tables
      (`cpo_pool`/`booking_cpo_assignments`/`vehicle_pool`) to `mission_crew`/`org_members` (so
      capacity is actually freed) and replace the always-100% refund with a termination→refund
      matrix (pre-LIVE full / post-LIVE pro-rata + agency credited the worked share). _(payments, lifecycle)_
- [ ] **LB7 · Cross-tenant IDOR.** Every `/org` dispatch handler does `assertOrgScope` (booking
      `assigned_provider_user_id` == caller's org; each CPO ∈ caller's org). accept/reject resolve
      the caller's org (company self OR active manager), not raw `sub`; offer-state guard on all. _(security)_
- [ ] **LB8 · Every transition is a conditional UPDATE.** accept / expire / cancel / crew-assign /
      complete each = one `UPDATE ... WHERE <expected-state> RETURNING` inside a txn (mirror
      `payWithCredits`/`raiseSos`). Fix the `one-live-offer-per-provider` index so it doesn't break
      D6 or race the cascade INSERT. Define accept-saga crash recovery (charge committed, booking
      not flipped). _(reliability, security)_
- [ ] **LB9 · Multi-pod-safe watchdog.** Redis `SET NX`-locked `setInterval` (copy
      `PaymentPendingExpiryService`), clock-skew grace on `expires_at`, accept-vs-expire ordering,
      self-reported liveness metric. _(reliability, observability, scalability, testing)_
- [ ] **LB10 · Vetting/eligibility gate in the match.** Only dispatch agencies/CPOs that are
      KYC-ACTIVE, **licensed** (valid + non-expired + region-matched), **insured** (cert on file +
      non-expired), and **armed-authorized** when the job needs it. Requires: add `agents.region_code`,
      a licence + insurance registry **with expiry**, an armed-authorization model, and an `armed`/
      requirements field on the request. _(trust & safety, legal, reliability)_
- [ ] **LB11 · Honor what the client paid for.** `cpo_count`, armed, female-CPO, and medical
      requirements must constrain both the match and the crew-assign validation — not be silently dropped. _(trust & safety)_
- [ ] **LB12 · Client↔guard identity handoff.** A rotating shared code/passphrase (+ photo/
      call-sign) shown to client and lead CPO at arrival; "this is NOT my guard" fires SOS. _(trust & safety)_
- [ ] **LB13 · SOS covers the pre-live window + no-show.** SOS must work while `DISPATCHING`
      and `CONFIRMED`-awaiting-crew (the most exposed moments); add guard-never-arrives detection +
      auto-re-dispatch; `NO_PROVIDER` must offer a safety fallback, not just "no one available." _(trust & safety)_
- [ ] **LB14 · Privacy & lawful basis.** Consent checkpoint before disclosing the client's
      location to a third-party agency; telemetry + `dispatch_offers` retention/purge jobs; rewrite
      the now-false "ops handler watches your trip" disclosure (D1 removed the ops handler); DPA/
      processor controls + CPO email-account consent. _(privacy)_
- [ ] **LB15 · Push wake stays opaque.** The **real** messenger consumer currently leaks
      `kind+bookingId` in cleartext on the wake — fix it and add a static test asserting the channel
      payload is exactly `{userId,eventClass,eventId}`. _(mobile-UX, security)_
- [ ] **LB16 · Agency "online + locatable" heartbeat.** The pattern Part I §Phase-2 says to copy
      only runs during a live mission and is foreground-only — build a real background-capable
      on-duty location heartbeat + staleness, or the ranking pool is empty/stale. _(mobile-UX)_
- [ ] **LB17 · Lifecycle traps.** On-demand requests collide with the 3-hour `MIN_LEAD_HOURS`
      gate; `DISPATCHING`/`NO_PROVIDER` trap the client behind the "one active booking" guard so
      "try again" is impossible — both must be fixed. _(lifecycle)_
- [ ] **LB18 · Anti-fraud at the matching layer.** Server-side location-plausibility + mock-
      location gating on the duty heartbeat (agencies spoofing to win jobs); throttle + verified-
      payment-method gate on the free request (anti-recon/DoS); acceptance-rate/mass-reject cooldown;
      device-binding + concurrent-session cap + revocable push for the shared 10-CPO logins;
      hard one-email-one-agency **partial unique index** + email verification. _(anti-fraud, security)_
- [ ] **LB19 · i18n / RTL.** No i18n exists; Arabic (RTL) + Bengali are required for the launch
      regions before those regions go live. _(mobile-UX)_
- [ ] **LB20 · Legal gates & consent.** Licence-validity + insurance + armed-permit gates in
      eligibility (overlaps LB10); capture client terms/waiver acceptance per request. _(legal)_
- [ ] **LB21 · Testability.** Make CI run `auth-service` tests; add the real-DB integration test
      for accept→charge→assignment; seed fixtures of on-duty agencies with locations + wallets; a
      test plan for the capacity/eligibility gate; a runtime kill-switch + canary-by-region. _(testing, observability)_

▶ **Plain English.** Before turning this on for real customers, the non-negotiables are:
never leak where the client is to firms that didn't take the job; make sure the encrypted chat
actually works for the guards; make the money bullet-proof (charge once, pay the agency, refund
if no one shows); only ever send vetted/licensed/insured guards and verify the person who
arrives is really them; keep the panic button working even before the guard arrives; make the
background timer safe to run on many servers; and make sure the tests actually run.

---

## Security & threat model

| Sev | Finding                                                                           | Fix / where                                                                                     |
| --- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| P0  | Principal pickup/dropoff/GPS leaked to all offered (incl. rejecting) agencies     | Coarse offer pre-accept; `/offers/:id/full` ACCEPTED-only; purge rejected; audit reads. _(LB1)_ |
| P0  | Ops Room CPO-add has no Signal group-key path (server holds no key)               | Agency device owns rekey; conversations-scoped intent drain; STOP/verify. _(LB2)_               |
| P0  | Charge keyed on booking status, not offer → double-charge / charge-after-cancel   | Offer-scoped conditional UPDATE + debit in same txn + Idempotency-Key. _(LB3)_                  |
| P0  | IDOR: no tenant re-check on accept/reject/`/org` crew + missing offer-state guard | `assertOrgScope` per row; resolve org (company/active manager) not raw `sub`. _(LB7)_           |
| P1  | No rate-limit on request/accept/reject/poll → fleet recon + denial-of-coverage    | `UserThrottlerGuard` + `@Throttle`; cap concurrent DISPATCHING/client; reject-cooldown.         |
| P1  | Opaque-push erosion via new eventClass + detail-fetch                             | Keep `dispatch` a single coarse class; static-test the channel payload shape. _(LB15)_          |
| P1  | Roster identity abuse (weak email verify, one-agency race, self-enrolment)        | Verified-email gate + **partial unique index** on email; reject self/client email. _(LB18)_     |
| P1  | Lead-only Finish TOCTOU + post-reassign authority gap on payout                   | Lead check inside the conditional UPDATE; one-`is_lead`-per-mission partial unique index.       |

▶ **Plain English.** The biggest risks are leaking the client's location, the encrypted chat
silently not working, charging wrong, and one firm reaching into another firm's job. All have
concrete, code-level fixes that reuse patterns already in the app.

## Payments & financial integrity

| Sev | Finding                                                                      | Fix / where                                                                                  |
| --- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| P0  | Lead Finish has **no** settlement path (payout is admin-only today)          | Extract `SettlementService`; lead-gated complete endpoint. _(LB4)_                           |
| P0  | Charged-but-never-crewed orphan (accept charges; crew deferred, no deadline) | `crew_deadline_at` + SLA sweep → auto-refund + penalize. _(LB5)_                             |
| P0  | Abort/refund hits OLD pool tables + always full-refunds                      | Move to `mission_crew`; termination→refund matrix. _(LB6)_                                   |
| P1  | No cancellation fee → client cancels free a second after accept              | `CANCEL_FEE_GRACE`/`PCT`; fee → agency for a committed-then-cancelled job.                   |
| P1  | No FX for BDT/GBP (only usd/aed/eur) → mis-charge in 2 of 4 regions          | Add SAR/BDT/GBP + a recorded `fx_rate` stamped on each txn; charge in booking currency.      |
| P1  | No escrow/held-funds account (money debited "to nowhere")                    | Client→escrow hold at accept; escrow→agency/platform at completion; `held_funds` view.       |
| P1  | Idempotency only mentioned on accept; not on lead-complete                   | Wire `IdempotencyInterceptor` on accept **and** complete; both internally race-safe. _(LB3)_ |
| P2  | No reconciliation job; no client receipt for the auto-charge                 | Daily ledger-integrity cron; `GET /bookings/:id/receipt`.                                    |

▶ **Plain English.** As written, nobody ever pays the agency and the customer can be charged
for a guard who never comes. Fix settlement, add a "must crew within N minutes or auto-refund"
timer, refund fairly on abort, and support all four currencies.

## Reliability & correctness

| Sev | Finding                                                                 | Fix / where                                                                    |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| P0  | Accept saga has no crash-recovery (charge done, booking not flipped)    | Define transactional boundary + compensating action / reconcile. _(LB8)_       |
| P0  | "Exactly-once accept" leans on the idempotency cache, not a lock        | Real conditional UPDATE on `offer.status='OFFERED'`. _(LB3/LB8)_               |
| P0  | `one-live-offer-per-provider` index breaks D6 + races the INSERT        | Re-model (it gates pending offers only); allow N active missions. _(LB8)_      |
| P0  | Watchdog has no leader-lock / clock-skew grace / accept-vs-expire order | Redis `SET NX` lock (PaymentPendingExpiryService); ordering guarantee. _(LB9)_ |
| P1  | No dead-letter / stuck-`DISPATCHING` detection                          | Liveness sweep + alert on stuck bookings.                                      |
| P1  | Capacity drift across two un-reconciled availability models             | Single source of truth (mission_crew/org_members), reconcile cpo_pool.         |
| P1  | `agents` has no `region_code` → ranking query can't run                 | Add column / derive from coverage. _(LB10)_                                    |

▶ **Plain English.** Under an 8-try cascade with a 30-second timer running on several servers,
races _will_ happen. Make every state change an atomic "change only if still in the expected
state," and make the background timer safe across servers.

## Trust & safety (protective-services — the make-or-break lens)

| Sev | Finding                                                                            | Fix / where                                                              |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| P0  | No vetting gate in the match → can dispatch unvetted/unlicensed/uninsured agencies | Eligibility filters: KYC-ACTIVE + licence + insurance + region. _(LB10)_ |
| P0  | Armed/female/medical requirements dropped → client doesn't get what they paid for  | Carry requirements into ranking + crew-assign validation. _(LB11)_       |
| P0  | No client↔guard identity handoff (impersonation risk)                              | Shared rotating code + photo; "not my guard" → SOS. _(LB12)_             |
| P0  | No SOS coverage during DISPATCHING / awaiting-crew (most exposed window)           | Extend SOS to pre-live states. _(LB13)_                                  |
| P0  | No no-show / never-arrives detection or auto-re-dispatch                           | Arrival deadline + re-dispatch. _(LB13)_                                 |
| P0  | `agents` lacks region + licence/insurance expiry → can't enforce validity          | Schema additions. _(LB10)_                                               |
| P1  | No arrival/duty-of-care checkpoint distinct from self-reported status              | Independent arrival confirmation.                                        |
| P1  | No incident / after-action report (required for a regulated operator)              | `GET /bookings/:id/report` + incident capture.                           |
| P1  | `NO_PROVIDER` leaves a threatened client alone                                     | Safety fallback (hotline / escalate / widen).                            |

▶ **Plain English.** This is a bodyguard service: only vetted, licensed, insured, correctly-
equipped guards should ever be sent; the customer must be able to confirm the person who shows
up is really theirs; and the panic button must work even while still searching.

## Privacy & multi-region compliance (UAE PDPL / Saudi PDPL / Bangladesh / UK GDPR)

| Sev | Finding                                                                         | Fix / where                       |
| --- | ------------------------------------------------------------------------------- | --------------------------------- |
| P0  | Minimize the offer payload (rejecting agencies must not see exact location)     | Coarse pre-accept (overlaps LB1). |
| P0  | Purge `dispatch_offers` location/PII for rejected/expired/superseded            | Purge job + short TTL.            |
| P0  | Telemetry retention/purge (mission_telemetry + Redis stream) undefined          | Define windows + purge cron.      |
| P0  | No lawful-basis/consent checkpoint for sharing location with a 3rd-party agency | Consent gate at request. _(LB14)_ |
| P0  | D1 removed the ops handler → existing privacy disclosure is now false           | Rewrite the disclosure copy.      |
| P0  | No DPA/processor controls for agencies + no CPO email-account consent           | Processor terms + CPO consent.    |
| P1  | Data-residency / cross-border story for 4 regions (one DB today)                | Document + plan residency.        |
| P1  | PII redaction in new surfaces (logs, ops monitor, `reject_reason`)              | Redact; reuse log-audit test.     |
| P1  | Right-to-erasure vs append-only audit/encrypted history                         | Define deletion contract.         |

▶ **Plain English.** Live location is the most sensitive data here; only the firm that takes
the job should ever see the exact address, it must be deleted from the firms that didn't, and
the customer must consent to it being shared at all — and the old "our staff watch your trip"
promise is no longer true.

## Mobile UX, offline & state robustness

| Sev | Finding                                                                                   | Fix / where                                    |
| --- | ----------------------------------------------------------------------------------------- | ---------------------------------------------- |
| P0  | Real push consumer leaks kind+bookingId (contradicts P0-N8)                               | Fix consumer + static test. _(LB15)_           |
| P0  | Agency online+locatable heartbeat doesn't exist (copy-pattern is mission-only/foreground) | Build background-capable heartbeat. _(LB16)_   |
| P0  | Offer countdown is a local timer (no server clock, no grace, no buzzer-accept)            | Bind to server `expires_at` + grace.           |
| P0  | Network loss at charge-accept has no optimistic/retry/dup story                           | Re-fetch truth (lost-200 safe); idempotent.    |
| P0  | Resume coverage doesn't include new states or the agency/CPO apps                         | Extend `resumeTargetFor` for all roles/states. |
| P0  | No i18n/RTL for Arabic + Bengali launch regions                                           | Add i18n + RTL. _(LB19)_                       |
| P1  | Stepper inconsistency across apps polling on different schedules                          | Monotonic guard on the shared helper.          |
| P1  | No push-tap deep-link router (30s window wasted on wrong screen)                          | Route each wake to the right screen.           |
| P1  | Long-cascade reassurance / notification-denied / battery cost undefined                   | Define copy + degradation + poll budget.       |

▶ **Plain English.** The polish layer: never show a stale or wrong screen, handle no-network at
the moment money changes hands, make the countdown honest, and ship Arabic/Bengali for the
launch markets.

## Observability & operability (admin only watches — it must be watchable)

| Sev | Finding                                                                                             | Fix / where                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| P0  | No dispatch-health metric set or emission sink                                                      | Define + emit `rank_query_ms`, acceptance rate, cascade depth, no-provider rate, time-to-crew, charge-failure, etc. |
| P0  | Watchdog must use Redis-lock pattern + self-report liveness                                         | (overlaps LB9).                                                                                                     |
| P0  | No runtime kill switch (env flag is boot-time only)                                                 | Runtime flag → safe fallback to legacy.                                                                             |
| P0  | No SLO-backed alerts for the modes a human can't watch 24/7                                         | Stuck-DISPATCHING, watchdog dead, zero-agency region, charge failures, unacked SOS.                                 |
| P1  | Structured PII-safe logging; correlation ID across services; real health checks; ops monitor panels | Per the lens specs.                                                                                                 |

▶ **Plain English.** Since no human runs dispatch, the system must page someone when it breaks —
and there must be a single switch to safely turn it off and fall back to the old staff flow.

## Anti-fraud & marketplace integrity

| Sev | Finding                                                                                                  | Fix / where                                                                         |
| --- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| P0  | Location spoofing / mock-location to win nearby jobs                                                     | Server-side plausibility + mock-location gating on the heartbeat.                   |
| P0  | Free request = recon/DoS oracle                                                                          | Throttle + verified-payment-method gate before dispatch.                            |
| P0  | Mass-reject / cherry-pick gaming                                                                         | Acceptance-rate accounting + cooldown + rank penalty.                               |
| P0  | Shared 10-CPO logins (D5) = account-sharing risk                                                         | Device binding + session cap + revocable per-login push.                            |
| P0  | Capacity over-commit race (accept jobs you can't crew)                                                   | Atomic capacity check (overlaps reliability).                                       |
| P1  | Phase-10 rating is a fabricated trust signal (pipeline missing); top-up/refund abuse; sybil/self-booking | Build the ratings pipeline; track refund/cancel abuse; sybil + collusion detection. |

▶ **Plain English.** Two-sided marketplaces get gamed: firms faking their location, fake
requests to spy on guards, firms rejecting everything, and shared logins. Add the standard
server-side defenses for each.

## Scalability & performance

| Sev | Finding                                                                     | Fix / where                                                                                                   |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| P1  | §8.2 haversine ORDER BY = full table scan on the hot path                   | **PostGIS `geography(Point,4326)` + GiST + `ST_DWithin`** (PostGIS is already enabled).                       |
| P1  | Multi-replica watchdog needs Redis `SET NX` lock                            | (overlaps LB9).                                                                                               |
| P1  | No `PG_POOL_MAX`, missing dispatch indexes, undefined poll→WS tipping point | Set pool, ship indexes in the same migration (EXPLAIN ANALYZE on 100s of agencies), define WS trigger metric. |
| P2  | Serial Redis SET+PUBLISH fan-out on the SOS/broadcast path                  | Pipeline `redis.multi()` (payload shape unchanged).                                                           |

▶ **Plain English.** The "find nearest" query and the background timer must be built for many
firms from day one — use the database's real geo-search instead of scanning everyone, and ship
the indexes with the migration.

## Lifecycle completeness & business rules

| Sev | Finding                                                                                                    | Fix / where                                         |
| --- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| P0  | On-demand collides with the 3-hour `MIN_LEAD_HOURS` gate                                                   | Exempt auto/now requests. _(LB17)_                  |
| P0  | `DISPATCHING`/`NO_PROVIDER` trapped behind the one-active-booking guard ("try again" impossible)           | Let terminal/failed states free the guard. _(LB17)_ |
| P0  | No refund/compensation when aborted/dropped after charge                                                   | (overlaps LB6).                                     |
| P1  | Guard drops mid-mission → no auto re-dispatch/replacement                                                  | Replacement-crew path without restarting payment.   |
| P1  | Ratings loop unbuilt (`agents.rating` never written; matcher ignores it)                                   | Build write + feed ranking.                         |
| P1  | `jobs_total` not incremented on finish; scheduled auto-dispatch undesigned; no cancellation policy; no ETA | Per lens specs.                                     |

▶ **Plain English.** Several "the demo works but the product is unfinished" gaps: an instant
request hits a 3-hour-minimum rule, a failed search leaves the customer unable to try again,
and there's no proper refund when things end early.

## Legal, regulatory, licensing & insurance (UAE / Saudi / Bangladesh / UK)

| Sev | Finding                                                                                                                                            | Fix / where                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| P0  | Per-region/agency/CPO **licence registry with expiry** + hard validity gate in eligibility                                                         | Schema + gate (overlaps LB10). |
| P0  | Mandatory **insurance certificate** on file + expiry, gating dispatch                                                                              | Schema + gate.                 |
| P0  | **Armed-protection authorization** + per-jurisdiction firearms-permit gate + an `armed` request field                                              | Model + gate.                  |
| P0  | Client **terms / waiver** acceptance captured per request                                                                                          | Capture + store. _(LB20)_      |
| P1  | Cross-border jurisdiction mismatch; CPO classification/liability posture; AML/sanctions/KYC on charge & onboarding; regulator-grade record-keeping | Per lens specs.                |

> These are product/compliance requirements to **encode and enforce in software**, not legal
> advice — confirm the actual regimes with counsel per region.

▶ **Plain English.** Running armed protection is regulated everywhere you launch: the app must
store and check each firm's and guard's licence, insurance, and weapons authorization (with
expiry) before ever dispatching them, and capture the customer's agreement to terms each time.

## Testing, QA & release engineering

| Sev | Finding                                                                                                                                                | Fix / where                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| P0  | **CI does not run backend tests** — new `DispatchService` specs are invisible                                                                          | Wire `auth-service` tests into CI. _(LB21)_        |
| P0  | No real-DB integration test for accept→charge→assignment (harness exists, unused)                                                                      | Add it.                                            |
| P0  | Watchdog test ignores multi-pod lock → double-cascade                                                                                                  | Test the Redis-lock path.                          |
| P0  | No seed/fixtures for on-duty agencies + locations + wallets                                                                                            | Build fixtures (also unblocks the 3-device smoke). |
| P0  | Capacity/eligibility (`has_free_cpo_capacity`) has no test plan                                                                                        | Add it (the gate that prevents over-dispatch).     |
| P1  | No load test (cascade + polling), no chaos tests, no flag rollout metrics / canary-by-region / kill-switch semantics, no legacy-flow regression matrix | Per lens specs.                                    |

▶ **Plain English.** Right now the automated gate wouldn't even run the new server tests, and
the riskiest paths (money, the timer, "is there a free guard") have no tests. Fix CI and add
real integration + load + chaos tests before launch.

---

# PART IV — Experience & screen design (client / agency / CPO)

> **What this part is.** Part I/II say _how the engine works_; Part IV says _what each person
> sees and does_. It's a screen-by-screen + feature backlog for the three apps, grounded in
> the screens that already exist. The headline finding: the client journey is **~80% already
> built** and the agency/CPO surfaces reuse existing screens too — most of this is **new
> visuals + wiring over existing plumbing**, plus one shared progress bar and a notifications
> feed.
>
> **Legend.** Screen status: **exists** (reuse as-is) · **extend** (add to it) · **new**
> (build it). Priority: **MVP** (ship the core loop) · **v1.1** (fast-follow) · **later**.

---

## 28. The shared backbone (build these first — every role depends on them)

These three things are rendered/used by all three apps. Build them once.

| #   | Thing                                        | Status | Priority | What it is                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | **`missionJourney.ts` + `<MissionStepper>`** | new    | **MVP**  | One pure helper `journeyStep(booking, mission?) → {index,label,canAdvanceBy}` + one horizontal 6-step bar (Searching → Accepted · assigning team → Team dispatched → En route → Protection active → Completed; SOS overlay ribbon; Cancelled/No-provider/Aborted side-states). Rendered identically on client, agency, CPO. (Part II §25)           |
| B2  | **ActivityCenter + notification Bell**       | new    | **MVP**  | A durable, role-filtered feed that turns the opaque FCM _wakes_ into a glanceable, actionable history (offers, accepts, status changes, payments, SOS). On each data-wake the app fetches detail from existing endpoints (like chat does) and appends a row, persisted locally. Bell + unread badge on every header. **Keeps push opaque (P0-N8).** |
| B3  | **Shared component library**                 | new    | **MVP**  | `StepperBar`, `TrustBadgeRow`, `VerificationBadge`, `RatingStars` (display+input), `RoleBadge`, `ActivityRow`, `EncryptionPill`, `CountdownPill` (offer TTL), `EmptyState`, `PermissionPrimer`. All RTL- and text-scale-aware (reuse `scaleTextStyles`).                                                                                            |

▶ **Plain English.** Three foundations everyone shares: one progress bar so the customer,
agency and guard always see the same step; one notifications inbox so a missed offer or alert
never vanishes; and one set of reusable building blocks so all three apps look and behave
consistently (consistency _is_ trust for a safety app).

---

## 29. CLIENT app — what the customer sees

**Navigation:** keep the existing 4 tabs (**Home / Messenger / Secure / Profile**) — do _not_
add tabs. The journey lives in the **Secure** tab; **Messenger** hosts the Ops Room;
**Home** gets a "Protect me now" hero. Enforce one-active-mission-at-a-time. `resumeTargetFor`
routes a relaunch to the right step (DISPATCHING→Finding, CONFIRMED→Confirmation,
LIVE→LiveTracking, NO_PROVIDER→empty state).

| Screen                                                          | Status | Priority         | Purpose / key elements / data                                                                                                                                                              |
| --------------------------------------------------------------- | ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DashboardScreen                                                 | extend | **MVP**          | Add one **"Protect me now"** hero that deep-links to the wizard preset to auto-dispatch. Keep the SOS bar.                                                                                 |
| BookingHomeScreen                                               | extend | **MVP**          | "Protect me now" + "Scheduled" + (later) "Rebook last detail"; rewrite the how-it-works copy to the Uber flow.                                                                             |
| Request wizard (ZoneMap→ServiceType→DateTime→Package→AddOns)    | extend | **MVP**          | Submit with `dispatch_mode:'auto'`; **affordability pre-check** routes short balance to CreditPaywall _before_ dispatch (§11.1).                                                           |
| **FindingDetailScreen**                                         | new    | **MVP**          | The "finding your detail…" search state (radar animation, "you won't be charged until a detail accepts," **Cancel**). Repurposes OpsRoomReviewScreen's poll.                               |
| **NoDetailScreen**                                              | new    | **MVP**          | Honest `NO_PROVIDER` dead-end: "no detail available," "you weren't charged," Try-again / Schedule.                                                                                         |
| **AgencyAcceptedScreen** (or reveal card)                       | new    | **MVP**          | The "your detail is X" reveal: agency name, ★rating, "N missions completed," trust line, then the stepper. Data: **new** `GET /bookings/:id/provider`.                                     |
| BookingConfirmationScreen                                       | extend | **MVP**          | Render the stepper; relabel "awaiting dispatch" copy; make the dead Invoice button open the Receipt; add "Share live trip."                                                                |
| LiveTrackingScreen                                              | extend | **MVP**          | Stepper above the map; "Share live trip"; "Arrived — verify your guard" affordance; agency ★ chip.                                                                                         |
| SOSScreen / Ops Room Chat / Credits / CreditPaywall / VBG suite | exists | **MVP**          | Reuse as-is (Ops Room metadata-only; VBG telemetry stays AES-GCM — don't weaken).                                                                                                          |
| TripSummaryScreen                                               | extend | **MVP**          | Add "View receipt" + "Rate this agency."                                                                                                                                                   |
| **IdentityVerifyScreen**                                        | new    | **v1.1**         | Trust-critical: rotating verify code/passphrase shown to client **and** lead CPO at arrival + photo/name; "this is NOT my guard" fires SOS. Data: **new** `GET /bookings/:id/verify-code`. |
| **RateAgencyScreen**                                            | new    | **v1.1**         | Post-mission ★ + tags + optional tip → writes the unused `lite_bookings.rating`, recomputes `agents.rating`. Data: **new** `POST /bookings/:id/rating`.                                    |
| **ReceiptScreen**                                               | new    | **v1.1**         | Real itemised receipt (turns the dead Invoice buttons live). Data: **new** `GET /bookings/:id/receipt`.                                                                                    |
| **ShareLiveTripScreen**                                         | new    | **v1.1**         | Time-boxed tokenised read-only live link to a trusted contact. Data: **new** `POST /bookings/:id/share`.                                                                                   |
| SavedPlaces / EmergencyContacts / FavouriteAgencies             | new    | **v1.1 / later** | Speed + trust: one-tap Home/Work, emergency contacts (feeds Share + SOS fan-out), prefer trusted agencies in the cascade.                                                                  |

**Client features (priority-ordered):** _(MVP)_ "Protect me now" auto request · shared stepper
· cancel-while-searching (no charge) · agency reveal with rating/jobs/ETA · affordability
pre-check · resume-mid-flow · opaque accepted/no-provider push wake · SOS everywhere.
_(v1.1)_ arrival identity verification · share live trip · rate-the-agency · receipts.
_(later)_ saved places · favourite agencies.

▶ **Plain English.** The customer's app barely changes structurally — it gets a "find me a
guard now" button, a reassuring "searching…" screen, a proud "here's who's coming (★rating,
N jobs)" reveal, the shared progress bar on every screen, and — the two new trust screens —
a way to verify the guard who arrives is really theirs and to rate them afterwards.

---

## 30. AGENCY app — what the operator sees (runs a roster + many missions)

The agency is a **mobile** user (the company agent). Reuse the existing `AgentNavigator`
stack; make `AgentDashboard` a true **ops cockpit** for `isOrg` and register a **global
incoming-offer overlay** (like the existing incoming-call screen) so an offer interrupts from
any screen. (A bottom-tab shell is a v1.1 nicety, not MVP.)

| Screen                                 | Status | Priority | Purpose / key elements / data                                                                                                                                                                                                                                                                      |
| -------------------------------------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AgentDashboard (Ops Cockpit)           | extend | **MVP**  | Go-online toggle (exists) + **capacity strip** ("X of Y guards free") + today's tiles + earnings snapshot + **persistent active-offer banner**. Data: **new** `GET /org/summary`, `GET /dispatch/offers/current`.                                                                                  |
| **IncomingOffer** (full-screen)        | new    | **MVP**  | Uber-driver accept/decline card with **countdown ring** to `expires_at`, route, distance/ETA, pay, "2 guards needed · 4 free" inline capacity. Surfaced via push + poll-on-Online + the dashboard banner (triple-surface so it's never missed). Data: `dispatchApi.getCurrentOffer/accept/reject`. |
| **OrgMissions** (multi-mission board)  | new    | **MVP**  | All concurrent jobs grouped **Needs crew / Active / Recent**, each with the stepper, crew, leader, SOS flag. Data: **new** `GET /org/missions`.                                                                                                                                                    |
| **AssignCrew** (sheet)                 | new    | **MVP**  | Pick N guards from roster (free/busy badges) + tap one ★ Leader → **creates the mission**. Data: `orgApi.listCpos` + **new** `POST /org/bookings/:id/crew`.                                                                                                                                        |
| OrgRoster                              | extend | **MVP**  | "X / 10 used" cap on Add, one-email-one-agency 409 surfacing, per-row on-duty + "on mission" tag, fire-guard with the "can't remove active lead" block (§23.4).                                                                                                                                    |
| AgentLiveTracker (per-mission monitor) | extend | **MVP**  | Agency watches its crew pins live + Ops Room; status buttons hidden (leader-only).                                                                                                                                                                                                                 |
| Coverage & Availability                | extend | **MVP**  | Region toggles scope dispatch eligibility (D4); note "you only get offers in active regions."                                                                                                                                                                                                      |
| CpoDetail                              | new    | **v1.1** | Drill into one guard: status, login email/reset, stats, recent missions, suspend/fire.                                                                                                                                                                                                             |
| Earnings (org mode)                    | extend | **v1.1** | Per-mission + per-guard payout rollup, deductions, withdrawal. Data: **new** `GET /org/earnings`.                                                                                                                                                                                                  |
| Agency Profile & Compliance            | extend | **v1.1** | License/insurance upload + expiry, the public trust card preview clients see.                                                                                                                                                                                                                      |
| Reputation panel                       | extend | **v1.1** | Own rating, acceptance rate, recent reviews + "ranking factors" explainer. Data: **new** `GET /agents/me/reputation`.                                                                                                                                                                              |

**Agency features:** _(MVP)_ global incoming-offer interrupt (push+poll+banner) · capacity-aware
accept · assign-crew+name-leader = mission creation · multi-mission board with stepper ·
live "where are my guards" · roster cap + one-email rule + verify · fire/suspend safety
guards. _(v1.1)_ earnings/payout rollup · acceptance-rate performance · decline-with-reason.
_(later)_ pre-mission crew/leader reassignment.

▶ **Plain English.** The agency's phone becomes a control room: a switch to go online, a
pop-up that interrupts with each new job (with a countdown and a "you can crew this" check), a
board of all its current jobs, and a simple "pick guards + tap the leader" step that puts a
team on a job. It can never accept a job it can't staff, and it can't accidentally remove the
leader of a running mission.

---

## 31. CPO (guard) app — what the field officer sees

The most under-built surface today, but the plumbing exists (lead-gated `pickup`/`go-live`/
`complete` endpoints, telemetry, SOS, deployment). Reuse the existing agent screens; add a
**bottom-tab shell** (On Duty / Mission / Comms / Me) so a guard mid-mission isn't
stack-trapped, with a **persistent SOS** above the tabs once LIVE/PICKUP.

| Screen                                                   | Status | Priority         | Purpose / key elements / data                                                                                                                                                                                            |
| -------------------------------------------------------- | ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| On-Duty Home                                             | extend | **MVP**          | Duty toggle, stats, today's shifts strip, "Next on Ops" assigned-mission card with the stepper mini-bar + LEAD/CREW chip.                                                                                                |
| **Assigned-Mission Detail**                              | new    | **MVP**          | One source of truth before field mode: client name, route, dress brief, **crew roster with the lead starred + "YOU"**, stepper. Data: extend `getMissionDeployment` to return `booking.status` + `crew[]` + client name. |
| Field / Navigation Mode (Live Tracker)                   | extend | **MVP**          | Map + the single context-aware **lead-only** button: Start → Go live → **swipe-to-Finish**; non-lead sees read-only "lead is advancing"; persistent SOS. Wires existing `missionPickup/goLive/complete`.                 |
| Mission Lead Console (waypoints)                         | extend | **MVP**          | Keep as advanced drawer; mirror the Start/Go-live/Finish row; non-lead controls disabled (not hidden) so the chain of command is legible.                                                                                |
| Mission Ops Room / My Earnings / Post-Mission Summary    | exists | **MVP**          | Reuse (CPO added to the room at crew-assign; "YOU EARNED" share; payout summary).                                                                                                                                        |
| Deployment Requirements (checklist + dress)              | extend | **v1.1**         | Add the stepper; route to the field button on completion.                                                                                                                                                                |
| **Arrival / Identity Confirmation**                      | new    | **v1.1**         | Lead confirms arrival (fires PICKUP) + surfaces verifiable identity (photo, call sign, shared code) toward the client.                                                                                                   |
| Profile · Docs · Credentials / Availability / Attendance | exists | **v1.1 / later** | Reuse (SIA/licence/insurance/DBS; availability; clock-in/out).                                                                                                                                                           |
| **Lone-Worker Check-In** (proof-of-life)                 | new    | **later**        | Periodic "I'm OK"; missed window escalates to Ops/agency. Data: **new** `POST /agents/me/missions/:id/check-in` + watchdog.                                                                                              |
| **CPO bottom-tab shell**                                 | new    | **v1.1**         | On Duty / Mission / Comms / Me + floating SOS — pure navigation refactor over existing screens.                                                                                                                          |

**CPO features:** _(MVP)_ wire the lead-only Start/Go-live/one-tap **Finish** into the field UI
(currently un-built — the lead literally can't drive the stepper today) · crisp LEAD vs
NON-LEAD treatment · shared stepper · crew-roster view · persistent SOS. _(v1.1)_ arrival +
verifiable identity · telemetry-health visibility everywhere · today's-schedule strip ·
tab shell. _(later)_ lone-worker proof-of-life check-in.

▶ **Plain English.** The guard logs in with the agency account and sees their job and the same
progress bar. The team leader gets the big buttons (Start, Go live, and a swipe-to-Finish like
ending an Uber trip); the other guards watch and can chat/SOS but can't change status. SOS is
always one tap from anywhere.

---

## 32. Cross-cutting experience (all three roles)

| Item                                               | Status     | Priority     | What / data                                                                                                                                                                                                      |
| -------------------------------------------------- | ---------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ActivityCenter + Bell (B2)                         | new        | **MVP**      | The durable feed over opaque push (see §28).                                                                                                                                                                     |
| Role-aware onboarding + **CPO account activation** | extend/new | **MVP**      | Reuse the AuthStack; detect a managed-CPO at login → one-time "activate your guard account" (set password, biometric, permissions, on-duty/SOS explainer). Avoids the "stuck guard" bug class.                   |
| PermissionsScreen                                  | extend     | **MVP**      | Role-aware copy ("location lets the system offer you nearby jobs"); add biometric-lock primer.                                                                                                                   |
| ProfileScreen (role-aware)                         | extend     | **MVP**      | RoleBadge; agency sees Roster/Reputation/Payouts, CPO sees Mission/On-Duty/Standing; shared Settings/Help/Activity entries.                                                                                      |
| **SettingsScreen**                                 | extend     | **MVP→v1.1** | Privacy + location-sharing scope, notification categories (**Safety category forced-on**), app-lock + auto-lock, **language (English / العربية RTL / বাংলা)** + currency. Data: **new** `PATCH /me/preferences`. |
| **TrustProfile** (provider trust card)             | new        | **MVP**      | Vetted/license/insurance badges + rating + encryption pill — the conversion/confidence moment. Render only real backend fields, never fake a badge.                                                              |
| RateMissionSheet / Reputation panel                | new/extend | **v1.1**     | Two-sided ratings feeding the dispatch ranking over time.                                                                                                                                                        |
| Help/Support + **Dispute & Incident report**       | extend     | **v1.1**     | In-app, mission-scoped tickets (Billing/No-show/Conduct/Safety); safety category cross-links to SOS. Data: **new** `POST/GET /support/tickets`.                                                                  |
| Receipts / Payout statements                       | extend     | **v1.1**     | Client receipt + agency payout statement.                                                                                                                                                                        |
| **Localization (i18n) + RTL**                      | new        | **v1.1**     | No i18n exists today; add English/Arabic-RTL/Bengali + per-region currency. Table-stakes for the UAE/Saudi/BD/UK regions.                                                                                        |

▶ **Plain English.** The glue that makes it feel like one trustworthy product: a notifications
inbox, the right starting experience for each role (including a clean first-login for guards),
trust badges that show a real vetted/licensed/insured agency, two-way ratings, in-app help &
incident reporting, receipts, and — important for your regions — Arabic (right-to-left) and
Bengali language support.

---

## 33. Premium / differentiator & retention features (security-grade, not a ride reskin)

The biggest unused assets already in the codebase: **`familyApi`** (fully built, _no UI_),
the mocked **Bravo Pro / `subscriptionApi`** retainers, and the **VBG** safety stack
(risk assessment, geofences, keypoints, biometric monitoring). Wire them into the dispatch loop.

| Feature                                     | Priority     | What it adds / reuses                                                                                                                                                                                                          |
| ------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Family / Executive accounts**             | **MVP→v1.1** | Holder invites members, sets spend caps, books _for_ them, watches their live detail. `familyApi` exists → build **FamilyHub**; needs `on_behalf_of_member_id` on booking + family-scoped telemetry read. Highest LTV lock-in. |
| **Verified guard/agency profile at accept** | **MVP**      | ★rating, missions, vetted/insured/licensed badges, per-CPO specialties — reuses `GET /bookings/:id/provider` + `getTeam`.                                                                                                      |
| **Rebook last detail / Favourite agency**   | **MVP→v1.1** | One-tap repeat booking + bias the cascade toward a trusted agency. Mostly existing booking endpoints.                                                                                                                          |
| **Pre-trip Route Risk brief**               | **v1.1**     | Run `vbgApi.sra()` on the actual destination/route; show risk + recommendations (upsell add-ons) on the Finding/Confirmation screens.                                                                                          |
| **Scheduled & recurring protection**        | **v1.1**     | `booking_mode:'later'` already exists; add a recurrence rule + a cron that calls `DispatchService.start()` at `pickup−lead`. The backbone of real retainers.                                                                   |
| **Real-time Trip-Share**                    | **v1.1**     | Scoped, auto-expiring live feed to a trusted contact.                                                                                                                                                                          |
| **Retainer / subscription tiers**           | **v1.1**     | Make the Bravo Pro mock real via `subscriptionApi` → priority dispatch + reserved capacity. Recurring revenue.                                                                                                                 |
| **Post-incident reports**                   | **v1.1**     | Exportable record (timeline, SOS events, route trail, team, rating) — corporate/compliance-grade.                                                                                                                              |
| **Geofenced safe/danger zones**             | **later**    | `vbgApi` geofences + a server breach-check on live telemetry → proactive alerts.                                                                                                                                               |
| **Safe-word / duress code (silent alarm)**  | **later**    | A duress PIN silently fires SOS. **STOP/verify** with the architecture doc (silent-alarm semantics, no plaintext code logging).                                                                                                |
| **Panic-to-Dispatch (nearest guard now)**   | **later**    | From the SOS bar, fire an emergency auto-dispatch to current GPS — reuses the whole engine + an EMERGENCY priority flag.                                                                                                       |
| **Biometric liveness monitoring tie-in**    | **v1.1**     | Surface the existing VBG 3-strike escalation → Live Action Protocol/dispatch as a 24/7 safety layer.                                                                                                                           |

▶ **Plain English.** This is what makes people keep paying for a _security_ app rather than a
taxi app: protect your family on one account, see your guard's verified credentials, get a
risk briefing for where you're going, schedule a daily detail, share your trip with a loved
one, a silent duress code, and — the headline — a panic button that sends the nearest guard to
you. Most of it is wiring up code that's already in the app but has no screen yet.

---

## 34. Complete UI-state matrix (the polish that makes it production-grade)

Every key moment is a **state** layered on screens that already poll — not a new screen.
Build all of these; honest empty/loading/error/**offline**/permission-denied variants are
what separate a demo from a product. (Full detail came from the UX-states lens.)

**Client lifecycle states:** Searching (radar, never blank) · Searching-taking-long (calm
escalation, _never_ leak who declined) · Accepted·assigning-team (reveal + skeleton, not an
empty card) · Team-dispatched (real crew) · En-route/Live (map + stepper + SOS) · Completed
(+ rate) · **NO_PROVIDER** (calm dead-end, "not charged," not a red error) · **Cancelled**
(confirm first; correct money copy per phase) · **Payment-failed-at-accept** (reuse the
existing pay-sheet; "top up to confirm") · **SOS active** (dominates UI; "sending" vs
"confirmed by Ops"; never falsely green).

**Agency offer states:** Incoming (countdown bound to `expires_at` from the push, not 0) ·
Accepted→committed (spinner; on network error **re-fetch truth**, don't assume failure — could
be a lost-200) · Expired/Superseded (neutral "passed to another detail," no fault tone).

**CPO states:** Assigned (lead vs non-lead) · One-tap Finish (deliberate confirm; on error
stays LIVE, never false "completed"; idempotent so a re-tap after a lost-200 is safe).

**Cross-app rules:** one truth via the shared stepper; deep-links resolve through the existing
`navigationRef` (dispatch-offer→offer overlay; accepted/no-provider→booking; mission-assigned→
tracker; SOS→SOS screen); optimistic UI only where reversible; offline = freeze at last known

- "offline" tint, never fabricate a terminal state.

▶ **Plain English.** The difference between a flashy demo and a real product is handling all
the in-between and bad moments: no network, no guards found, a tapped button that didn't get a
reply, an SOS that's still sending. The rule throughout: never lie to the user (don't show
"done" or "safe" unless the server confirmed it) and never leave them on a blank screen.

---

## 35. New endpoints & screens introduced by Part IV (consolidated)

**New endpoints (beyond Part I/II):** `GET /bookings/:id/provider` (already in §15) ·
`GET /bookings/:id/receipt` · `POST /bookings/:id/rating` · `GET /bookings/:id/verify-code` ·
`POST /bookings/:id/share` · `GET /bookings/:id/report` · `GET /org/summary` ·
`GET /org/earnings` · `GET /agents/me/reputation` · extend `getMissionDeployment`
(+`booking.status`, `crew[]`, client name) · `PATCH /me/preferences` ·
`GET/POST /me/places` · `/me/emergency-contacts` · `/me/favourite-agencies` ·
`POST/GET /support/tickets` · booking `on_behalf_of_member_id` (family) ·
recurrence rule + scheduler (scheduled/recurring) · `POST /agents/me/missions/:id/check-in`
(lone-worker). _Most are simple reads over existing tables; none change crypto/auth._

**New shared/MVP screens to build:** `MissionStepper`(+`missionJourney.ts`), `ActivityCenter`

- Bell, the shared component library, `FindingDetailScreen`, `NoDetailScreen`,
  `AgencyAcceptedScreen`/reveal, `IncomingOffer`, `OrgMissions`, `AssignCrew`, CPO
  Assigned-Mission Detail, TrustProfile, CPO account-activation.

**Updated checklist (experience track — run alongside Part III):**

- [ ] **PX1** Shared backbone — stepper + ActivityCenter + component library (§28)
- [ ] **PX2** Client journey screens — Finding / No-detail / Accepted / extended Confirmation+Live (§29)
- [ ] **PX3** Agency cockpit — IncomingOffer + OrgMissions + AssignCrew + roster caps (§30)
- [ ] **PX4** CPO field — Assigned-Mission + wired lead-only Start/Go-live/**Finish** + tab shell (§31)
- [ ] **PX5** Cross-cutting — onboarding/CPO-activation, settings/i18n, TrustProfile, ratings (§32)
- [ ] **PX6** Premium/retention — Family hub, verified profile, route-risk, scheduled, trip-share (§33)
- [ ] **PX7** Full UI-state coverage incl. offline/error/permission for every state (§34)

▶ **Plain English.** A tidy list of the new little API calls (mostly simple data reads, nothing
touching encryption) and the new screens to build, with a checklist you can hand off
phase-by-phase next to the hardening checklist.

---

## 35A. App separation by role — Client vs Agency vs CPO (detect at login, route to a different interface)

> **The rule.** Bravo is **one binary, three distinct app experiences.** Which one a person sees
> is decided **at login, from the server's authenticated identity — never from a client-chosen
> flag** (this is the lesson from the `pendingProvider` stuck-register bug: route purely by the
> role the backend confirms). A managed **CPO** is a _worker_, so they must get a CPO interface,
> **not** the individual client app and **not** the agency operator app. This section amends
> Part IV §31 (CPO screens) and §32 (onboarding/activation).

### A. The discriminator — how the system knows "this is a CPO"

On a successful login the app fetches identity (`/auth/me` + `/agents/me`) and resolves a single
`account_kind` with this **precedence**:

1. **`cpo`** — the user has an `agents` row with `type='cpo'` **and** `managed_by_org_id` set,
   **or** an `org_members` row where `member_role='cpo'` and `status='active'`. → **CPO interface.**
2. **`agency`** — the user is a company agent (`agents.type='company'`, `service_provider` role)
   **or** an `org_members` row with `member_role='manager'`. → **Agency operator interface.**
3. **`individual`** — everything else (`users.role='individual'`, no agent/org membership). →
   **Client interface** (the existing consumer tabs).

**Make this a server-computed field.** Add `account_kind` (+ `org: {id, name}`, `must_set_password`,
and `membership_status`) to the `/agents/me` (or `/auth/me`) response so the app switches on one
authoritative value instead of re-deriving the rules client-side. Never trust a value the client
could set.

▶ **Plain English.** The moment someone logs in, the server tells the app "this account is a
customer, a firm, or a guard," and the app shows the matching home — the guard never lands in the
customer or firm app by accident.

### B. Routing — one root switch, three navigators

In the root navigator, after auth bootstrap, mount exactly one stack by `account_kind`:

- `individual` → the existing **ClientNavigator** (Home / Messenger / Secure / Profile).
- `agency` → the **AgencyNavigator** cockpit (Part IV §30).
- `cpo` → a **new CpoNavigator** — a 4-tab shell **On Duty / Mission / Comms / Me** (Part IV §31).

Rules:

- A CPO **never sees** `RoleSelectionScreen` (they didn't self-register — the agency created the
  account). Login goes straight to the CPO stack.
- **First login** (`must_set_password=true`, the agency-set temp password) → force the **CPO
  account-activation** flow first (set password → optional biometric → location + notification
  permissions → "you belong to {agency}" + on-duty/SOS explainer), _then_ the CPO home (§32).
- **Mid-session revocation:** on every app-focus/token refresh, re-check `membership_status`. If
  the agency **suspended/removed** the CPO (`org_members.status != 'active'`), force-logout to an
  "Your agency access has ended — contact your agency" screen, set the CPO offline, and drop them
  from Ops Rooms. (A removed login must not keep a live guard interface open.)

▶ **Plain English.** There are three separate front doors. A guard's login always opens the guard
door, sets a real password the first time, and is shut immediately if the firm removes them.

### C. What the CPO interface SHOWS (purpose-built for a working guard)

The four CPO tabs (full screen detail in Part IV §31):

- **On Duty (Home):** available/unavailable duty toggle; "you belong to **{agency}**" identity
  banner; today's shifts/schedule; the **assigned-mission card** with the shared stepper +
  LEAD/CREW chip; location-heartbeat health dot.
- **Mission:** the assigned-mission detail (client name, route, dress brief, crew roster with the
  **lead starred + "YOU"**, waypoints, deployment checklist); field/navigation map mode; **lead-only**
  Start → Go-live → one-tap **Finish** (non-lead = read-only "lead is advancing"); arrival/identity
  confirmation toward the client; **persistent SOS**; lone-worker proof-of-life check-in.
- **Comms:** the mission **Ops Room** (E2E chat + voice/video), and (optional) an agency broadcast
  thread.
- **Me:** profile + **documents/credentials** (SIA / licence / insurance / DBS) with expiry;
  availability/coverage (within agency limits); **My Earnings = the guard's own share only**;
  attendance/shifts; settings (biometric lock, language, notifications).

### D. What the CPO interface HIDES (the differentiator)

| Capability                                         | Individual (client) | Agency (operator) |                **CPO (guard)**                |
| -------------------------------------------------- | :-----------------: | :---------------: | :-------------------------------------------: |
| "Protect me now" / booking wizard                  |         ✅          |         —         |                    **❌**                     |
| Wallet / Bravo Credits top-up (client)             |         ✅          |         —         |                    **❌**                     |
| Client booking history / receipts                  |         ✅          |         —         |                    **❌**                     |
| Family hub / book-for-others                       |         ✅          |         —         |                    **❌**                     |
| VBG client safety suite (SRA, geofences)           |         ✅          |         —         |          **❌** (or read-only later)          |
| **Incoming job offer (accept/decline)**            |          —          |        ✅         |  **❌ — the agency accepts, never the CPO**   |
| Roster management (add/fire CPOs)                  |          —          |        ✅         |                    **❌**                     |
| Assign-crew / name-leader                          |          —          |        ✅         |                    **❌**                     |
| Multi-mission board (all org jobs)                 |          —          |        ✅         | **❌ — sees only their own assigned mission** |
| Org earnings / payouts rollup                      |          —          |        ✅         |      **❌ — sees only their own share**       |
| **Run an assigned mission (Start/Go-live/Finish)** |          —          |   monitor only    |               **✅ lead-only**                |
| Ops Room comms for their mission                   |  ✅ (client side)   |        ✅         |                    **✅**                     |
| SOS / lone-worker check-in                         |         ✅          |         —         |                    **✅**                     |
| Credentials/docs upload                            |          —          |    ✅ (agency)    |                 **✅ (own)**                  |

The three "❌ for CPO" rows that matter most: a CPO **cannot book protection, cannot accept jobs,
and cannot manage a roster or see org money** — those are client/agency powers. A CPO only ever
**works the missions their agency assigns them**, and only the **lead** can change a mission's status.

▶ **Plain English.** The guard's app is stripped down to their job: see the mission you were given,
chat with the client/team, run it if you're the leader, hit SOS, and check your own pay and
documents. No "book a guard," no "accept jobs," no firm-level money or roster — those belong to
customers and the firm.

### E. Decisions & edge cases

- **Single-purpose account (recommended).** A managed-CPO account is for work only — it cannot
  also book protection as a client (keeps billing/identity and the one-email-one-agency rule
  clean). If a guard wants to be a customer too, they use a separate personal account. _(Flag if
  you want CPOs to also be clients — that needs a role-switcher and a billing split.)_
- **No active mission** → the Mission tab shows a calm "No active mission — stand by" empty state;
  On Duty still works so the agency can assign them.
- **Lead vs non-lead** is a _within-mission_ state, not a different app — the same CPO interface
  shows the lead the action buttons and shows others the read-only view.
- **Push deep-links** (`mission-assigned`, SOS) route into the CPO **Mission** tab via the existing
  `navigationRef`.

### F. Backend additions for this section

- Compute and return **`account_kind`** + `org{id,name}` + `must_set_password` + `membership_status`
  on `/agents/me` (or `/auth/me`).
- A **session guard** that fails a CPO whose `org_members.status != 'active'` (force re-route to
  the "access ended" screen) — re-checked on focus/refresh.
- Everything else (mission endpoints, Ops Room, earnings share, docs) already exists; this is
  mostly **routing + a role-scoped UI**, not new backend power.

**Checklist (role-separation track):**

- [ ] **PR1** Server returns `account_kind` (+ org, must_set_password, membership_status) (§A/§F)
- [ ] **PR2** Root navigator mounts ClientNavigator / AgencyNavigator / **CpoNavigator** by `account_kind` (§B)
- [ ] **PR3** CPO first-login activation + skip RoleSelection (§B, §32)
- [ ] **PR4** CpoNavigator 4-tab shell with only the CPO-scoped screens (§C, Part IV §31)
- [ ] **PR5** Hide all client/agency capabilities from the CPO build (§D matrix)
- [ ] **PR6** Mid-session revocation → "access ended" + force-offline + drop from Ops Rooms (§B)

▶ **Plain English.** Most of this is just _which screens the app shows_, decided by what the server
says the account is — the guard, the customer, and the firm each get their own app out of the same
download, and a removed guard is locked out on the spot.

---

# PART V — Escrow & completion-integrity (the money state machine)

> **What this part is.** This is the detailed money design that makes the feature safe to take
> real payments on. It **implements and supersedes** the payment handling sketched in Part I §6
> (accept), §11.1, Phase 12 (§17), and Part II §26 (lead finish), and it **resolves** Part III's
> money launch-blockers **LB3, LB4, LB5, LB6** and the "no escrow / held-funds account" finding.
> It touches only the wallet/ledger — **no crypto, no E2E, no auth primitives** — but it must
> obey the same two rules everything else does: every money move is **idempotent** and is a
> **conditional `UPDATE ... WHERE <expected-state> RETURNING` inside a transaction**, and every
> background sweep uses the **Redis `SET NX`-locked** pattern (`payment-pending-expiry.service.ts`)
> because `auth-service` is multi-replica.

## 36. The core principle — "charged" ≠ "paid"

When the agency accepts and the client's credits are taken, the money goes into a **platform
escrow (held-funds) account — never the agency's wallet**. The agency is paid **only** when the
job is **genuinely, verifiably done** and a **client dispute window** has passed. Everything
below follows from this one rule:

- **Agency cancels / no-shows after accept** → money is still in escrow → **auto-refunded to the
  client in full**; agency gets nothing + a reliability penalty. _Nothing was ever lost because
  nothing was ever paid out._
- **Agency falsely marks "completed"** → the payout is **gated on proof-of-work + a dispute
  window**, not the agency's word → a fake completion never auto-pays; it routes to review and,
  on a client dispute, to refund + clawback.

> Today the code debits the client **straight off their wallet** with no escrow account
> (`booking.service.ts payWithCredits`), and settlement credits the agency at completion
> (`ops.service.ts completeBooking`). Part V inserts the **held-funds layer in between**.

▶ **Plain English.** Taking the customer's money and paying the firm are two separate events
with a holding pot in the middle. The firm only gets the money once the job is really done and
the customer hasn't disputed it — so cancelling or lying never gets them paid.

## 37. The money state machine

```
                         ┌──────────────────────────── client cancels within grace ─┐
                         │                              agency no-show / SLA miss     │
                         │                              abort BEFORE mission LIVE     ▼
 client wallet ─accept→  ESCROW: HELD ───────────────────────────────────────────► REFUNDED
                         │  │                                                     (escrow → client, full)
                         │  │── client cancels AFTER grace ──► PARTIAL ──► (escrow → client minus fee;
                         │  │                                              fee → agency for the wasted commit)
                         │  │── abort/SOS-end DURING live ───► PARTIAL ──► (pro-rata: client refund +
                         │  │                                              agency credited the worked share)
                         │  ▼
                         │ lead taps FINISH  ──(proof-of-completion gate, §40)──┐
                         │                                                      │ gate PASS
                         │                              gate FAIL → REVIEW      ▼
                         │                              (no auto-release;   PENDING_RELEASE
                         │                               ops must adjudicate)  (dispute window open, §41)
                         │                                                      │
                         │           client disputes ─► DISPUTED/FROZEN ◄───────┤
                         │                                  │                   │ window elapses (no dispute)
                         │             ops upholds client   │   ops rejects     │ OR client confirms early
                         │        (refund/partial+clawback) │   (release)       ▼
                         └──────────────────────────────────┴──────────────► RELEASED
                                                                          (escrow → agency payout
                                                                           + platform fee; writes
                                                                           mission_payouts as today)
```

States: `HELD → {REFUNDED | PARTIAL | PENDING_RELEASE}`; `PENDING_RELEASE → {RELEASED | DISPUTED}`;
`DISPUTED → {RELEASED | REFUNDED | PARTIAL}`. `RELEASED/REFUNDED` are terminal.

▶ **Plain English.** The diagram is the whole life of the money: into the holding pot on accept,
then either back to the customer (cancel/no-show), split fairly (cancelled-late or ended-early),
or — only after the job is proven done and the dispute window passes — out to the firm.

## 38. Data model

```sql
-- supabase/migrations/<ts>_escrow_integrity.sql
CREATE TYPE escrow_hold_status AS ENUM
  ('HELD','PENDING_RELEASE','RELEASED','REFUNDED','PARTIAL','DISPUTED');

CREATE TABLE escrow_holds (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         UUID NOT NULL UNIQUE REFERENCES lite_bookings(id),
  offer_id           UUID REFERENCES dispatch_offers(id),
  client_id          UUID NOT NULL,
  provider_user_id   UUID,                          -- agency payee (set at accept)
  gross_credits      INT  NOT NULL,                 -- amount taken from the client
  currency           TEXT NOT NULL,                 -- AED/SAR/BDT/GBP (+ fx_rate stamped on the txn)
  status             escrow_hold_status NOT NULL DEFAULT 'HELD',
  held_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at       TIMESTAMPTZ,                   -- lead tapped Finish & passed the gate
  release_eligible_at TIMESTAMPTZ,                  -- completed_at + dispute window (trust-tiered)
  settled_at         TIMESTAMPTZ,
  to_provider_credits INT,                          -- final amounts at settlement
  to_client_credits   INT,
  platform_fee_credits INT,
  basis              TEXT,                           -- full_release | pro_rata | refund | partial | clawback
  review_required    BOOLEAN NOT NULL DEFAULT FALSE  -- proof-gate failed → ops must adjudicate
);
CREATE INDEX escrow_release_due ON escrow_holds(release_eligible_at)
  WHERE status = 'PENDING_RELEASE';

CREATE TABLE booking_disputes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    UUID NOT NULL REFERENCES lite_bookings(id),
  raised_by     UUID NOT NULL,                       -- client_id
  category      TEXT NOT NULL,                        -- not_performed | left_early | wrong_guard | conduct | billing
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'open',         -- open | upheld | rejected | resolved
  to_client_credits   INT,
  to_provider_credits INT,
  decided_by    UUID,                                 -- admin actor on resolve
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at    TIMESTAMPTZ
);
```

- **Accounts:** add a seeded **platform escrow account** (a dedicated user id, e.g.
  `ESCROW_ACCOUNT_ID`) and a **platform-fee account**. Every move is a **paired**
  `wallet_transactions` row (debit one account, credit the other) so the ledger always balances.
- **Reuse:** the final `RELEASED` payout still writes **`mission_payouts`** exactly as
  `completeBooking` does today (the agency wallet is `payee_user_id`), and **partials** reuse the
  existing `deduction_credits` / `deduction_reason` columns. Refunds reuse `refundForBooking`.
- `lite_bookings`: add `dispute_window_seconds` (resolved per trust tier at completion) if you
  don't want it purely config-driven.

▶ **Plain English.** One table tracks each job's holding-pot status and the final split; one
table tracks disputes; the actual money rows live in the existing wallet ledger so the books
always add up.

## 39. Lifecycle — the exact transactional operations

1. **On accept** (extends Part I §6 / LB3). In the same txn that flips the offer
   `OFFERED→ACCEPTED` (conditional UPDATE) and verifies booking `DISPATCHING`: debit the client
   and **credit the escrow account** (paired ledger rows), then `INSERT escrow_holds (... status
'HELD', provider_user_id, gross_credits, currency, offer_id)`. If the debit fails →
   abort the accept (no hold, offer not won). **Idempotency-Key required.**
2. **Agency no-show / crew-SLA miss** (LB5). The crew-assign watchdog (§42) finds a `HELD` booking
   past `crew_deadline_at` with no mission → in one txn: `escrow → client` full refund
   (`refundForBooking`), `escrow_holds.status='REFUNDED'`, booking → `AGENCY_NO_SHOW`, offer
   `SUPERSEDED`, agency `reliability_breaches++`, push client (optionally auto-re-dispatch).
3. **Client cancels while still HELD** (LB6 / lifecycle). Within grace → full `escrow→client`,
   `REFUNDED`. After grace (agency already committed crew) → `PARTIAL`: `escrow→client` minus a
   cancellation fee; the fee → agency via the settlement path; record `basis='partial'`.
4. **Abort / SOS-end during LIVE** (LB6). Replace the current unconditional full refund: compute
   pro-rata against minutes actually on task; `escrow→client` the unworked share, `escrow→agency`
   the worked share (+ platform fee), `basis='pro_rata'`. **And free capacity via `mission_crew`**
   (not the old `cpo_pool` tables).
5. **Lead taps FINISH** (LB4). Lead-gated `POST /agents/me/missions/:id/complete`, idempotent.
   Conditional `UPDATE missions SET status='COMPLETED' WHERE id=$1 AND status='LIVE' AND
EXISTS(... is_lead)`. Run the **proof-of-completion gate (§40)**:
   - **PASS** → `escrow_holds.status='PENDING_RELEASE'`, `completed_at=NOW()`,
     `release_eligible_at = NOW() + disputeWindow(trustTier)`. **No money moves yet.**
   - **FAIL** → still mark the mission COMPLETED operationally but set `review_required=TRUE`,
     **do not** open auto-release; it waits for ops adjudication.
6. **Auto-release** (§42 watchdog). When `status='PENDING_RELEASE' AND release_eligible_at<NOW()
AND NOT review_required AND no open dispute`: in one txn move `escrow→agency` payout +
   `escrow→platform` fee, write `mission_payouts`, bump `agents.jobs_total`, dissolve the group,
   `status='RELEASED'`, `basis='full_release'`.
7. **Client confirms early** → same release as step 6, immediately (skip the wait).
8. **Client disputes** → §41.

▶ **Plain English.** Money goes into the pot at accept; it's auto-returned if the firm flakes;
it's split fairly if the job ends early; and on "finish" it does **not** pay out — it waits for
proof and the dispute window before the firm finally gets it.

## 40. Proof-of-completion gate — what makes "completed" trustworthy

A `FINISH` only opens auto-release if the job shows **objective evidence it happened**. Checks
(all server-side, read from data the system already collects):

| Check                | Rule                                                                  | Source                               |
| -------------------- | --------------------------------------------------------------------- | ------------------------------------ |
| Real progression     | mission actually went `DISPATCHED→PICKUP→LIVE` via the lead-gated FSM | mission FSM transitions              |
| Reached the pickup   | ≥1 GPS ping within `ARRIVAL_RADIUS_M` of `pickup_lat/lng`             | `mission_telemetry_last` / gps pings |
| Telemetry coverage   | ≥ `MIN_PINGS` GPS pings during `LIVE` (not a 30-second "live")        | telemetry stream                     |
| Minimum on-task time | `LIVE` duration ≥ `MIN_ONTASK_SECONDS`                                | mission timestamps                   |
| Identity handshake   | the arrival code/photo confirm happened (or was offered)              | LB12 verify-code                     |

- **All pass** → eligible for auto-release after the dispute window.
- **Any fail** → `review_required=TRUE`: the mission can still close (a legit job may have spotty
  GPS), but it **never auto-pays** — ops must adjudicate. A "completed" with zero telemetry and no
  pickup is exactly the fraud signal you asked about, and it lands in review, not the agency wallet.
- Emit a metric `dispatch_completion_gate_fail_total{reason}` so repeat offenders surface.

▶ **Plain English.** "Done" has to be backed by evidence — the guard's phone actually went to
the pickup, stayed for a real amount of time, and the customer confirmed them. A "finished" with
no trace of any of that doesn't get paid automatically; a human checks it first.

## 41. Dispute window & endpoints

The dispute window (`DISPUTE_WINDOW_SECONDS`, trust-tiered — see §42) is the customer's chance to
say "this didn't really happen / they left early / wrong person."

| Endpoint                                | Who           | Purpose                                                                                          |
| --------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------ |
| `POST /agents/me/missions/:id/complete` | lead CPO      | finish + run proof gate + open `PENDING_RELEASE` (LB4)                                           |
| `POST /bookings/:id/confirm-complete`   | client        | confirm early → release now                                                                      |
| `POST /bookings/:id/dispute`            | client        | `{category, reason}` → `escrow_holds.status='DISPUTED'`, freeze release, open `booking_disputes` |
| `GET /bookings/:id/escrow`              | client/agency | show the current hold state + (final) split, for the receipt/UI                                  |
| `POST /ops/disputes/:id/resolve`        | admin         | `{to_client, to_provider, penalty?, reason}` → settle the frozen hold                            |

- `dispute` only valid while `PENDING_RELEASE` (not after `RELEASED`). One open dispute per booking
  (partial unique index). Client-owns-booking check (`WHERE client_id=$2`).
- `resolve` is the **one place the admin stays in the money loop** (consistent with D1: admin is
  the exception path). It does the final paired ledger moves + records `decided_by` + audits.
- **Clawback:** if a dispute is upheld _after_ an erroneous release (e.g. review missed), the
  resolve path debits the agency wallet and refunds the client; if the agency balance is short,
  flag a negative-balance recovery (withhold future payouts).

▶ **Plain English.** After the firm taps finish, the customer has a window to flag a problem; if
they don't, the money releases on its own. If they do, it freezes and a staff member decides the
split — and can pull money back from the firm if they already grabbed it.

## 42. Watchdogs & trust-tiered holds (all Redis-locked, multi-pod-safe)

Three sweeps, each copying the `payment-pending-expiry.service.ts` Redis `SET NX` lock (NOT
`@nestjs/schedule`):

1. **Crew-assign SLA sweep** — `HELD` + past `crew_deadline_at` + no mission → auto-refund + flag
   agency (§39 step 2). _(LB5)_
2. **Release sweep** — `PENDING_RELEASE` + `release_eligible_at < NOW()` + `!review_required` + no
   open dispute → release to agency (§39 step 6).
3. **Reconciliation sweep (daily)** — assert the money invariant (§43) and alert on drift.

**Trust-tiered dispute window / hold:** new or low-rating agencies get a **longer** hold
(e.g. 72h) and may require the proof gate to fully pass; established, high-rating agencies get a
**short/instant** release. Store the tier on `agents` (reuse `tier`/`rating`); compute
`disputeWindow(tier)` at completion. This makes good actors fast and bad/new actors slow — the
standard marketplace defense.

▶ **Plain English.** Background timers (safe to run on many servers) handle the auto-refunds and
the auto-payouts, and trusted firms get their money faster while new or low-rated firms are held
longer until they've proven themselves.

## 43. Invariants, tests & status

**Money invariant (assert in the reconciliation sweep + tests):** for every booking,
`sum(client debits) == held`, and at terminal `held == to_provider + to_client + platform_fee`.
No agency credit row may exist before `release_eligible_at` (or an early client confirm / dispute
resolve).

**Must-have tests:**

- Accept → exactly one client debit into escrow; no agency credit. Double-tap accept → one hold.
- Agency no-show → full refund, no payout, agency flagged; idempotent.
- Abort mid-LIVE → pro-rata split + `mission_crew` capacity freed.
- Finish with passing proof → `PENDING_RELEASE`, no money moved; after window → released once.
- Finish with **failing** proof (no telemetry) → `review_required`, **never** auto-released.
- Client dispute during window → frozen; ops resolve splits correctly; clawback works if released-in-error.
- Concurrency: release sweep vs client dispute firing together → dispute wins (freeze), no payout.
- Currency: BDT/GBP holds and refunds reverse exactly at the stamped fx rate.

**What exists vs new:** _reuse_ — locked wallet txn pattern, `refundForBooking`, `mission_payouts`

- `deduction_credits/reason`, `OpsAuditService`, the `PaymentPendingExpiry` sweep pattern.
  _New_ — the escrow + platform-fee accounts, `escrow_holds` + `booking_disputes` tables, the
  `SettlementService` extraction (LB4), the proof-of-completion gate, the dispute/confirm/resolve
  endpoints, and the three sweeps. **No crypto/E2E/auth changes.**

**Build checklist (escrow track):**

- [ ] **PV1** Migration: `escrow_holds`, `booking_disputes`, escrow + fee accounts (§38)
- [ ] **PV2** Accept moves client→escrow in the offer-accept txn (§39.1, LB3)
- [ ] **PV3** `SettlementService` extraction + lead-gated complete that opens `PENDING_RELEASE` (§39.5, LB4)
- [ ] **PV4** Proof-of-completion gate (§40)
- [ ] **PV5** Dispute window + confirm/dispute/resolve endpoints (§41)
- [ ] **PV6** Three Redis-locked sweeps + trust-tiered holds (§42, LB5/LB9)
- [ ] **PV7** Abort/cancel → refund/pro-rata matrix on `mission_crew` (§39.3-4, LB6)
- [ ] **PV8** Money-invariant reconciliation + the test suite (§43)

▶ **Plain English.** A nightly check makes sure every wallet still adds up, and a list of tests
proves the firm can never get paid for a job they cancelled or faked. Most of it reuses money
code the app already has; the new part is the holding pot, the proof check, and the dispute flow.
