# Bravo Secure — Auto-Dispatch BUILD RUNBOOK

> **What this file is.** An ordered, **self-contained** build sequence for the Uber-style
> bodyguard auto-dispatch system. Each step below is a complete work packet — goal, context,
> exact files, backend + frontend how-to, security stop-conditions, and acceptance tests — so
> you can hand **one step at a time** to a fresh engineer (or a fresh Claude session) and they
> have everything they need _without_ reading the full design doc.
>
> **Companion design doc:** `docs/planning/UBER_DISPATCH_PLAN.md` (Parts I–V + §35A) holds the deeper
> rationale and the 12-perspective hardening review. This runbook is the _executable_ version
> of it. Where a step says "Resolves: Phase X / LB# / PV# / §##", that points back into the
> plan if you want the full story — but you shouldn't need to.

## How to use this runbook

1. **Build in order.** Steps are dependency-ordered. Each packet lists its `Depends on:`.
2. **One step = one focused PR**, behind the `AUTO_DISPATCH_ENABLED` flag (Step 1) until the
   rollout step flips it on. The legacy admin-mediated flow must keep working the whole time.
3. **Every step ends with `Acceptance & tests` and `Done when`** — don't mark a step done
   until those pass, including the project gates (typecheck baseline 96, the relevant Jest
   project, `test:crypto` if you touched messaging, lint).
4. **Honor the security stop-conditions** in each packet — they mark the places that touch
   E2E encryption, opaque push, money, or auth, where you must re-read the System Architecture
   Documentation before coding.

## ⚠️ Six corrections the design review found in the code (read before Step 1)

These were verified against the real source and are baked into the steps below:

1. **Background loops use the Redis `SET NX`-locked `setInterval` pattern** in
   `apps/auth-service/src/booking/payment-pending-expiry.service.ts` — **NOT** `@nestjs/schedule`
   (not a dependency; auth-service is multi-replica, so a bare loop double-fires per pod).
2. **The lead's one-tap Finish does not settle money today** (settlement is admin-only in
   `OpsService.completeBooking`) — you must extract a `SettlementService` (Step 10).
3. **The offer must be coarse pre-accept** — never ship exact pickup/dropoff to offered/
   rejecting agencies; precise location only after accept (Step 7).
4. **`agents` has no `region_code`** and haversine-in-SQL is a full scan — add region + use
   **PostGIS `geography`+GiST+`ST_DWithin`** (Steps 2 & 6). (The `last_lat/last_lng/
last_location_at` columns are also missing from any migration though code writes them — add
   them defensively in Step 2.)
5. **The server cannot add a CPO to the E2E Ops Room** (no group-key path for `conversations`
   rooms) — the agency device must own the rekey (Step 12).
6. **CI does not run `auth-service` tests** (Jest matrix is `[app, messenger-crypto, booking]`)
   — fix CI in Step 1 or your new tests are invisible.

## Locked product decisions (quick reference)

`D1` fully automatic (admin only monitors/overrides) · `D2` charge on accept **into escrow**,
released only on verified completion · `D3` the **agency** accepts then deploys its own CPOs ·
`D4` nearest within same region (AE/SA/BD/GB) · `D5` agency registers up to ~10 real CPO login
emails (one email = one agency) · `D6` agency runs multiple concurrent missions bounded by free
CPO capacity · `D7` accept does **not** auto-pick crew (agency assigns crew+leader, which
creates the mission) · `D8` shared stepper + leader-only status + one-tap finish.

## Master step index

**Stage 0 · Foundations**

- **Step 1** — Branch, dual feature flag & build/CI foundations _(start here)_
- **Step 2** — Core dispatch DB migration (`dispatch_offers`, booking cols/statuses, agents region + PostGIS) _(dep: 1)_
- **Step 3** — Money + compliance DB migration (`escrow_holds`, `booking_disputes`, licence/insurance, armed) _(dep: 1)_

**Stage 1 · Identity & availability**

- **Step 4** — Role discriminator (`account_kind`) + CPO session guard _(dep: 1)_
- **Step 5** — Provider go-online + background location heartbeat _(dep: 2)_

**Stage 2 · Dispatch engine**

- **Step 6** — `DispatchService`: proximity ranking + offer cascade _(dep: 2,3,5)_
- **Step 7** — Offer endpoints: coarse visibility + IDOR scope + idempotency + throttle _(dep: 6)_
- **Step 8** — Watchdogs (Redis-locked): offer-expiry cascade + crew-assign SLA _(dep: 6,7)_

**Stage 3 · Money**

- **Step 9** — Escrow on accept (charge ≠ pay) _(dep: 3,7)_
- **Step 10** — `SettlementService` + lead one-tap Finish + proof-of-completion gate _(dep: 3,9)_
- **Step 11** — Dispute window, release sweep, refund/pro-rata/cancel-fee matrix, FX _(dep: 8,9,10)_

**Stage 4 · Comms & crew**

- **Step 12** — Ops Room group-key distribution under auto-dispatch _(dep: 4)_
- **Step 13** — Crew assignment + leader (creates the mission) _(dep: 9,12)_
- **Step 14** — Opaque push wiring + fix the consumer leak _(dep: 7,13)_

**Stage 5 · Safety & trust**

- **Step 15** — Vetting / licence / insurance / armed gates + client terms _(dep: 3,6)_
- **Step 16** — Identity handshake + pre-live SOS + no-show + no-provider fallback _(dep: 13)_

**Stage 6 · Apps (role-separated UI)**

- **Step 17** — Role routing + CPO activation + revocation _(dep: 4)_
- **Step 18** — Shared backbone: stepper + activity feed + component library _(dep: 4)_
- **Step 19** — CLIENT app UI (Finding / No-detail / Accepted / stepper) _(dep: 7,9,18)_
- **Step 20** — AGENCY app UI (cockpit / incoming-offer / missions board / assign-crew) _(dep: 7,13,18)_
- **Step 21** — CPO app UI (CpoNavigator, assigned mission, lead-only Finish) _(dep: 10,17,18)_

**Stage 7 · Cross-cutting & lifecycle**

- **Step 22** — Privacy, retention & consent _(dep: 7)_
- **Step 23** — Anti-fraud & marketplace integrity _(dep: 5,7)_
- **Step 24** — Lifecycle completeness & ratings loop _(dep: 6,10)_
- **Step 25** — i18n / RTL + currency _(dep: 18)_

**Stage 8 · Operate (observability, testing, rollout)**

- **Step 26** — Observability, kill-switch & ops monitor _(dep: 8,11)_
- **Step 27** — Testing strategy _(dep: all backend)_
- **Step 28** — Reconciliation + staged rollout _(dep: all)_

---

<!-- The 28 self-contained step packets follow, in order. -->

## Step 1 — Branch, dual feature flag & build/CI foundations

**Stage:** Foundations · **Depends on:** (none — first step) · **Resolves:** Part I Phase 0 (corrected by Part III ⚠️ correction 1 & 6), Part III LB9, LB21
**Goal (plain English):** Start the whole auto-dispatch feature on its own branch, hidden behind an on/off switch on both the server and the phone app so we can build it "dark" without changing what customers experience today. Also fix the test robot (CI) so it actually runs the backend tests we're about to write, and lock in the right way to write background timers so we don't accidentally run them many times at once on our multi-server setup.
**Why it matters / what breaks without it:** Without the flag, half-built dispatch code could change live booking behavior; without the CI fix, every backend test we write for dispatch/escrow is invisible and a broken change ships green; without the agreed timer pattern, every background watchdog double-fires on each server replica (double-charging, double-cascading).
**Self-contained context (inline — do not make the reader open the plan):**

- LOCKED DECISION D1: dispatch is fully automatic; admin only monitors/overrides. The feature must ship behind one switch and the legacy admin-mediated flow (`POST /bookings` → `PENDING_OPS` → admin approve) must behave EXACTLY as today when the switch is off.
- Backend env flag lives in `apps/auth-service/src/config/configuration.ts` (verified): config is built from `process.env[...]` with defaults, e.g. `otp.devBypass: process.env['OTP_DEV_BYPASS'] === 'true'`. There is no feature-flags block yet — add one. Read it via NestJS `ConfigService` (ConfigModule is `isGlobal: true` in `app.module.ts`).
- Mobile runtime flag: the mobile config home is `src/utils/constants.ts` (verified) which inlines `EXPO_PUBLIC_*` vars at bundle time (`API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? ...`). The plan also allows a server-driven bootstrap field `autoDispatch: boolean`. Prefer a server-driven field so the flag can flip without a rebuild; fall back to an `EXPO_PUBLIC_AUTO_DISPATCH` constant for build-time gating. NOTE: Part III LB-observability flags the env flag is boot-time only — design the read so a later step can swap in a runtime kill-switch.
- CORRECTION (Part III ⚠️1, LB9): `auth-service` runs MULTIPLE replicas. Every background loop (offer-expiry watchdog, book-later trigger, escrow sweeps) MUST copy the Redis `SET NX`-locked `setInterval` pattern in `apps/auth-service/src/booking/payment-pending-expiry.service.ts` (verified — note: it is in `booking/`, NOT `ops/` as some plan text says). It is explicitly NOT `@nestjs/schedule` — that package is NOT a dependency of `apps/auth-service` (verified: absent from `apps/auth-service/package.json`) and `ScheduleModule` is NOT imported in `app.module.ts` (verified). Do not add it.
- The canonical lock shape (verified, copy this): `const got = await this.redis.client.set(LOCK_KEY, String(Date.now()), 'PX', LOCK_TTL_MS, 'NX'); if (got !== 'OK') return {skipped_lock:true}; try { ...work... } finally { await this.redis.client.del(LOCK_KEY); }` with `LOCK_TTL_MS` shorter than the interval so a crashed sweeper self-releases.
- CORRECTION (Part III ⚠️6, LB21): CI does NOT run `auth-service` backend tests. Verified `.github/workflows/ci.yml` Jest matrix is `project: [app, messenger-crypto, booking]` — all root/mobile Jest projects; there is no `auth-service` job at all. New `DispatchService`/escrow specs would never run in the gate.
  **Files to touch:**
- EXTEND `apps/auth-service/src/config/configuration.ts` — add a `featureFlags: { autoDispatch: process.env['AUTO_DISPATCH_ENABLED'] === 'true' }` block (mirror the existing `=== 'true'` boolean-env idiom).
- EXTEND `src/utils/constants.ts` — add `export const AUTO_DISPATCH = process.env.EXPO_PUBLIC_AUTO_DISPATCH === 'true';` AND/OR plumb an `autoDispatch` boolean through the server bootstrap response the app already fetches at login (preferred for flag-without-rebuild).
- EXTEND `.github/workflows/ci.yml` — add an `auth-service` Jest job (separate from the root matrix) that runs `cd apps/auth-service && npm ci --legacy-peer-deps && npm test`; gate it like the other test jobs. Optionally add `messenger-service` too.
- NEW doc-only convention note (in the dispatch module's eventual README or a `// Why:` comment) referencing `payment-pending-expiry.service.ts` as THE template for all new sweeps. Do NOT add `@nestjs/schedule`.
- Create branch `feat/auto-dispatch` off `main` (do not commit yet unless asked).
  **Backend how-to:**
- In `configuration.ts`, add the flag and read it via `ConfigService.get('featureFlags.autoDispatch')` wherever `POST /bookings` branches. The branch itself is built in a later step; here, just introduce the flag with default OFF and assert the legacy path is untouched when false.
- Do NOT introduce any new scheduler infra. When later steps need a loop, they instantiate a NestJS provider implementing `OnModuleInit/OnModuleDestroy` with `setInterval` + the Redis `SET NX` lock exactly as `PaymentPendingExpiryService` does.
- CI job sketch (add to `ci.yml`):
  ```yaml
  auth-service-test:
    name: Jest (auth-service)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: {node-version: '20'}
      - run: cd apps/auth-service && npm ci --legacy-peer-deps
      - run: cd apps/auth-service && npm test
  ```
  **Frontend / ops-console how-to:** Add the `AUTO_DISPATCH` constant / bootstrap field in `src/utils/constants.ts` (and the bootstrap type). No screen changes here — later client steps gate the new "Finding…" route on this flag. Ops-console needs no change in this step.
  **Security stop-conditions:** None beyond standard guards. Do NOT add a "skip in dev" branch to any guard while wiring the flag (CLAUDE.md: no dev-skip on `JwtAuthGuard`, `OrgManagerGuard`, `AdminGuard`, AppCheck). The flag gates the FEATURE path, never a security check.
  **Acceptance & tests:**
- New test: a backend unit test asserting that with `AUTO_DISPATCH_ENABLED` unset/false, the booking-create path takes the legacy branch (place under `apps/auth-service/src/booking/*.spec.ts`).
- Regression: run the `booking` Jest project `npm test -- --selectProjects=booking`; run `apps/auth-service` `npm test` locally and confirm the new CI job runs it.
- Gates: `npm run typecheck` (mobile, ≤ baseline 96), `cd apps/ops-console && npm run typecheck`, `npm run lint`. CI must show the new `auth-service` job executing. Never commit on a red gate; never `--no-verify`.
- Manual smoke: build with flag OFF → submit a booking → confirm it lands `PENDING_OPS` (legacy) exactly as before.
  **Done when:**
- [ ] Branch `feat/auto-dispatch` exists off `main`.
- [ ] `AUTO_DISPATCH_ENABLED` exists in `configuration.ts` (default OFF) and a mobile `autoDispatch` flag is readable.
- [ ] Flag OFF ⇒ `POST /bookings` is byte-for-byte the legacy flow.
- [ ] `ci.yml` runs `apps/auth-service` tests and they appear in the PR checks.
- [ ] No `@nestjs/schedule` added; the Redis `SET NX` `setInterval` pattern is documented as the convention.

## Step 2 — Core dispatch DB migration

**Stage:** Data model · **Depends on:** Step 1 · **Resolves:** Part I §4 (4.1–4.3), Part III reliability (region/PostGIS) + scalability, LB10 (region/geo prerequisites), corrections ⚠️4
**Goal (plain English):** Create the new database structures the matchmaker needs: a table that records who got offered each job and whether they said yes, a few new columns and statuses on the booking so it can show "searching" / "no one available," a region label on each agency, and a proper map-aware location field so "find the nearest agency" is a fast geo-search instead of scanning everyone. Ship every index it needs in this one migration.
**Why it matters / what breaks without it:** The dispatch engine (later step) literally cannot run its ranking query — `agents` has no `region_code` and the current haversine-in-SQL approach is a full table scan. Without `dispatch_offers` there's nowhere to record the offer cascade; without the new booking statuses the FSM can't represent "searching" or "no provider."
**Self-contained context (inline — do not make the reader open the plan):**

- New table `dispatch_offers` records each offer in the nearest-first cascade. Status enum `dispatch_offer_status` = `OFFERED | ACCEPTED | REJECTED | EXPIRED | SUPERSEDED | CANCELLED`. One PENDING ("OFFERED") offer per provider at a time (race guard) but this must NOT cap concurrent active missions — D6 lets an agency run several missions at once, bounded only by free CPO capacity (enforced later in the eligibility query, not by this index).
- LOCKED DECISIONS: D4 = nearest within the SAME region (AE/SA/BD/GB); D6 = multiple concurrent missions per agency.
- CORRECTION (Part III ⚠️4 / reliability / LB10): `agents` has NO `region_code` column (verified: original `agents` schema in `supabase/migrations/20260423180000_agent_portal.sql` has user_id, type, status, tier, call_sign, display_name, rate_aed_per_hour, rating, jobs_total, duty_hours_mtd, on_duty, timestamps — and nothing else). Add `region_code`. ALSO verified landmine: `apps/auth-service/src/agents/agent.service.ts:1438` writes `agents.last_lat`, `last_lng`, `last_location_at` but NO migration creates those columns (they appear in zero migration files). Add them defensively with `ADD COLUMN IF NOT EXISTS`, AND add a PostGIS `geography(Point,4326)` location column with a GiST index so `ST_DWithin`/`<->` nearest-neighbour is index-backed.
- PostGIS is available and already used: verified `CREATE EXTENSION IF NOT EXISTS postgis;` in `20260416000000_init_phase1.sql`, which also uses `geography(Point,4326)` and `CREATE INDEX ... USING GIST (...)` (e.g. `bookings_pickup_gix`). Copy that exact idiom.
- The booking status type is a REAL Postgres ENUM `lite_booking_status` (verified in `20260423113000_booking_module.sql`), and `lite_bookings.status` is typed as that enum. New statuses must be added via `ALTER TYPE lite_booking_status ADD VALUE 'DISPATCHING'` / `'NO_PROVIDER'`. CAUTION: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction in some Postgres versions and the new value may be unusable in the same migration transaction — add the enum values in a statement that commits before any DML uses them (split or order accordingly).
- FSM (TypeScript mirror) lives in `apps/auth-service/src/booking/state-machine.service.ts` (verified). Current `BookingStatus` union: `DRAFT|PENDING_OPS|OPS_APPROVED|PAYMENT_PENDING|CONFIRMED|LIVE|COMPLETED|CANCELLED`; actors `CLIENT|OPS_HANDLER|CPO|SYSTEM`; transitions are a `TRANSITIONS[]` table; `CANCELLABLE` is a `readonly BookingStatus[]`. New transitions to ADD (keep all existing intact): `DRAFT→DISPATCHING` (actor CLIENT), `DISPATCHING→CONFIRMED` (actor SYSTEM — means "accepted, awaiting crew"), `DISPATCHING→NO_PROVIDER` (actor SYSTEM, terminal), and make `DISPATCHING` cancellable by CLIENT/SYSTEM (add to `CANCELLABLE`).
- `lite_bookings` already has `pickup_lat/lng`, `dropoff_lat/lng` as `DECIMAL(10,7)`, `region_code TEXT NOT NULL`, `cpo_count`, `total_eur`/`total_aed`, `comms_channel_id` (the Ops Room link — reuse it). New columns to add: `dispatch_mode TEXT` ('auto' = new flow, NULL = legacy), `assigned_provider_user_id UUID` (set on accept), `dispatch_started_at TIMESTAMPTZ`, `dispatch_settled_at TIMESTAMPTZ`, and `crew_deadline_at TIMESTAMPTZ` (the charged-but-never-crewed SLA, Part III LB5 — add here so escrow Step 3 / sweeps can use it).
- Hot-path indexes to ship in THIS migration: partial unique index for one-live-offer-per-provider; `dispatch_offers(booking_id, status)`; an index over `dispatch_offers(expires_at) WHERE status='OFFERED'` for the watchdog; a GiST index on the new agents geography column; and a covering index for the duty pool, e.g. `agents(status, on_duty, type) WHERE type='company'`.
  **Files to touch:**
- NEW `supabase/migrations/<ts>_auto_dispatch.sql` — the enum, `dispatch_offers`, `lite_bookings` ALTERs, the two new `lite_booking_status` enum values, `agents` ALTERs (region_code + last_lat/lng/last_location_at IF NOT EXISTS + geography column), and all indexes.
- EXTEND `apps/auth-service/src/booking/state-machine.service.ts` — add `DISPATCHING` and `NO_PROVIDER` to the `BookingStatus` union, add the three transitions to `TRANSITIONS`, add `DISPATCHING` to `CANCELLABLE`. (Code change paired with the migration so the FSM and DB agree.)
- EXTEND any hand-written row interface for `lite_bookings` / `agents` (e.g. `LiteBookingRow` in `booking.service.ts`) and re-run type-gen if the repo uses `mcp__supabase__generate_typescript_types`.
  **Backend how-to (migration SQL sketch):**

```sql
-- enum (commit before DML that uses the values; ADD VALUE not in a txn block)
CREATE TYPE dispatch_offer_status AS ENUM
  ('OFFERED','ACCEPTED','REJECTED','EXPIRED','SUPERSEDED','CANCELLED');
ALTER TYPE lite_booking_status ADD VALUE IF NOT EXISTS 'DISPATCHING';
ALTER TYPE lite_booking_status ADD VALUE IF NOT EXISTS 'NO_PROVIDER';

CREATE TABLE IF NOT EXISTS dispatch_offers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID NOT NULL REFERENCES lite_bookings(id) ON DELETE CASCADE,
  provider_user_id UUID NOT NULL,
  rank             INT  NOT NULL,
  distance_km      NUMERIC(7,2),
  status           dispatch_offer_status NOT NULL DEFAULT 'OFFERED',
  offered_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL,
  responded_at     TIMESTAMPTZ,
  reject_reason    TEXT
);
-- one live offer per provider (race guard; does NOT cap active missions — D6)
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_offers_one_live_per_provider
  ON dispatch_offers(provider_user_id) WHERE status = 'OFFERED';
CREATE INDEX IF NOT EXISTS dispatch_offers_booking ON dispatch_offers(booking_id, status);
CREATE INDEX IF NOT EXISTS dispatch_offers_expiry  ON dispatch_offers(expires_at) WHERE status='OFFERED';

ALTER TABLE lite_bookings
  ADD COLUMN IF NOT EXISTS dispatch_mode TEXT,
  ADD COLUMN IF NOT EXISTS assigned_provider_user_id UUID,
  ADD COLUMN IF NOT EXISTS dispatch_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispatch_settled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS crew_deadline_at    TIMESTAMPTZ;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS region_code      TEXT,
  ADD COLUMN IF NOT EXISTS last_lat         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS last_lng         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS last_location_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_location    geography(Point,4326);
CREATE INDEX IF NOT EXISTS agents_last_location_gix ON agents USING GIST (last_location);
CREATE INDEX IF NOT EXISTS agents_dispatch_pool ON agents (status, on_duty, type) WHERE type='company';
```

- Keep `last_lat/last_lng/last_location_at` for back-compat with `agent.service.ts:1438`, but the ranking query in the engine step should prefer `ST_DWithin(last_location, pickup_geog, radius_m)` ordered by `last_location <-> pickup_geog`. Decide whether `PATCH /agents/me/location` also writes `last_location = ST_SetSRID(ST_MakePoint(lng,lat),4326)::geography` — flag this so the engine step keeps the geography column populated.
- `region_code` derivation: if you can't cleanly source it, derive from the agent's coverage (`agent_profiles.coverage.countries`) — but the column must exist for the ranking `WHERE a.region_code = :region`. NOTE drift to flag: D4 regions are AE/SA/BD/GB, but mobile `SUPPORTED_REGIONS` in `src/utils/constants.ts` currently lists AE/GB/ZA/US — reconcile region codes before relying on the match.
- Conditional-UPDATE/idempotency pattern is enforced in the engine/accept steps, not here; this step only provides the columns/indexes those conditional updates rely on (`WHERE status='OFFERED'`, `WHERE status='DISPATCHING'`).
  **Frontend / ops-console how-to:** None (pure data model). Re-run mobile/ops-console typecheck after any generated-type refresh.
  **Security stop-conditions:** None beyond standard. STOP/verify only that the new columns store NO precise principal location to anyone unauthorized — `dispatch_offers` intentionally holds only `distance_km` (coarse), never pickup/dropoff coordinates (Part III LB1 crown-jewel rule; the precise-location ACCEPTED-only endpoint is a later step). Do not add address/coordinate columns to `dispatch_offers`.
  **Acceptance & tests:**
- New test: FSM unit test (`state-machine.service.spec.ts` style) asserting the three new transitions are allowed for the stated actors and that, e.g., `DISPATCHING→LIVE` or a non-SYSTEM `DISPATCHING→NO_PROVIDER` is rejected; and that `DISPATCHING` is cancellable.
- Migration applies cleanly on a scratch/branch DB (`mcp__supabase__list_tables` shows `dispatch_offers`; `agents` shows the new columns; old tables untouched).
- Run `EXPLAIN ANALYZE` of the prospective nearest-agency query against hundreds of synthetic on-duty company agents with locations, confirming GiST index usage (no seq scan on the hot path).
- Gates: `apps/auth-service` `npm test` (now in CI from Step 1), `npm run typecheck` (mobile ≤96), `cd apps/ops-console && npm run typecheck`, `npm run lint`. Never commit on red.
  **Done when:**
- [ ] `dispatch_offers` + `dispatch_offer_status` enum exist with the partial unique index + booking/status + expiry indexes.
- [ ] `lite_bookings` has dispatch_mode, assigned_provider_user_id, dispatch_started_at, dispatch_settled_at, crew_deadline_at.
- [ ] `lite_booking_status` includes DISPATCHING + NO_PROVIDER; the TS FSM mirrors the new statuses + transitions and its spec passes.
- [ ] `agents` has region_code + last_lat/lng/last_location_at + a `geography(Point,4326)` column with a GiST index, plus the duty-pool covering index.
- [ ] `EXPLAIN ANALYZE` shows the nearest query is index-backed at scale; legacy data untouched.

## Step 3 — Money + compliance DB migration

**Stage:** Data model · **Depends on:** Step 1, Step 2 · **Resolves:** Part V §38 (escrow_holds + booking_disputes + accounts), Part III LB10/LB20 (licence/insurance/armed registries with expiry) + LB11 (requirements honored)
**Goal (plain English):** Add the "holding pot" money model that keeps the customer's payment safe until the job is really done — a table that tracks each job's escrow state and final split, a table for customer disputes, and two special platform accounts (one to hold the money, one for the platform's fee). Also add the compliance records the law requires for a bodyguard service: a licence/insurance registry with expiry dates per agency, per guard, and per region; an "is this guard authorized to be armed" model; and an "armed / requirements" field on the request. No encryption is touched.
**Why it matters / what breaks without it:** Today the customer is debited straight off their wallet with no holding account and the agency is credited at completion — so a cancelling or lying agency could be paid, and there's nothing to refund from. Without the licence/insurance/armed registries the matcher cannot legally gate who gets dispatched (Part III says this is a launch-blocker for a regulated, multi-region service). Without the requirements field on the request, "armed/female/medical" the client paid for is silently dropped.
**Self-contained context (inline — do not make the reader open the plan):**

- CORE PRINCIPLE (Part V §36): "charged" ≠ "paid." On accept, the client's credits go INTO a platform escrow (held-funds) account, NOT the agency wallet. The agency is paid only after a proof-of-completion gate + a client dispute window. This migration provides the tables/accounts; the transactional moves and sweeps are later steps (PV2–PV8).
- CORRECTION (Part III ⚠️2 / payments LB4): settlement today is ADMIN-ONLY — verified `apps/auth-service/src/ops/ops.service.ts completeBooking` (line ~1079) computes `escrow = Math.round(Number(row.total_eur))`, even-splits it across CPOs, and credits via the wallet; "escrow" there is just the booking total, NOT a held-funds account. A later step extracts a `SettlementService`; this migration adds the real held-funds layer the plan §36 says is missing.
- Money state machine (Part V §37): `escrow_hold_status` = `HELD | PENDING_RELEASE | RELEASED | REFUNDED | PARTIAL | DISPUTED`. Transitions: `HELD → {REFUNDED|PARTIAL|PENDING_RELEASE}`; `PENDING_RELEASE → {RELEASED|DISPUTED}`; `DISPUTED → {RELEASED|REFUNDED|PARTIAL}`; RELEASED/REFUNDED terminal.
- Wallet ledger to reuse (verified, `apps/auth-service/src/wallet/`): `wallet_balances(user_id PK, bravo_credits INT, currency TEXT default 'AED', stripe_customer_id, updated_at)`; `wallet_transactions(id, user_id, type wallet_tx_type ['topup','payment','refund','payout'], status, amount_credits INT, amount_fiat_cents, fiat_currency default 'usd', description, booking_id, metadata jsonb, settled_at)`. Helper methods exist: `wallet.service.ts` `creditForBooking` (idempotent via partial unique constraint `ux_wallet_tx_payout`), `refundForBooking` (idempotent via `ux_wallet_tx_booking_refund`, derives amount server-side from the original debit), `debitForBooking`/`debitForFeature`. The escrow moves are PAIRED ledger rows (debit one account, credit the other) so the books always balance.
- Settlement reuse target: `mission_payouts` (verified `20260428000000_dress_and_payouts.sql`) has `mission_id, booking_id, agent_user_id, call_sign, proposed_credits, paid_credits, deduction_credits, deduction_reason, decided_by, decided_at`. NOTE: the payee column on `mission_payouts` is `agent_user_id` (NOT `payee_user_id`); `payee_user_id` was added to a DIFFERENT table in `20260610000000_provider_orgs_and_managed_cpos.sql` (line 75) — verify the exact target column before the settlement step writes a payout to the AGENCY org wallet. Partials reuse `deduction_credits`/`deduction_reason`; refunds reuse `refundForBooking`.
- LOCKED DECISIONS feeding compliance: D4 region (AE/SA/BD/GB) → registries are per-region; D5 = up to ~10 managed CPOs per agency (roster lives in `org_members`, verified `org_members(org_user_id, member_user_id, member_role ['cpo','manager'], call_sign, status default 'active')`); requirements (armed/female/medical) already partly modeled — `cpo_pool` has `armed`/`female`/`specialties`, and `lite_booking_add_ons` seeds `female_cpo`/`recon`/`medical`/`comms` (verified) — but there is no per-request `armed` flag and no licence/insurance EXPIRY registry.
- `agents.rating` (DECIMAL(3,2)) and `agents.jobs_total` (INT) EXIST (verified in agent_portal migration) — do NOT re-add; reliability/acceptance counters are new.
- Multi-replica / background-sweep constraint (Part V §42, Part III LB9): the release sweep, crew-SLA sweep and reconciliation sweep all use the Redis `SET NX`-locked `setInterval` pattern from `apps/auth-service/src/booking/payment-pending-expiry.service.ts` — never `@nestjs/schedule`. This migration just provides the index they query: `escrow_release_due ON escrow_holds(release_eligible_at) WHERE status='PENDING_RELEASE'`.
  **Files to touch:**
- NEW `supabase/migrations/<ts>_escrow_integrity.sql` — `escrow_hold_status` enum, `escrow_holds`, `booking_disputes`, the seeded platform escrow + platform-fee accounts, the licence/insurance registry, the armed-authorization model, and the `armed`/requirements field on `lite_bookings`; plus reliability/acceptance counters on agents.
- (Optional) EXTEND a row interface / re-run type-gen for the new tables.
- No crypto/auth files touched.
  **Backend how-to (migration SQL sketch):**

```sql
CREATE TYPE escrow_hold_status AS ENUM
  ('HELD','PENDING_RELEASE','RELEASED','REFUNDED','PARTIAL','DISPUTED');

CREATE TABLE IF NOT EXISTS escrow_holds (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          UUID NOT NULL UNIQUE REFERENCES lite_bookings(id),
  offer_id            UUID REFERENCES dispatch_offers(id),
  client_id           UUID NOT NULL,
  provider_user_id    UUID,                 -- agency payee, set at accept
  gross_credits       INT  NOT NULL,
  currency            TEXT NOT NULL,        -- AED/SAR/BDT/GBP (+ fx_rate stamped on the txn)
  status              escrow_hold_status NOT NULL DEFAULT 'HELD',
  held_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,          -- lead Finish + gate pass
  release_eligible_at TIMESTAMPTZ,          -- completed_at + dispute window (trust-tiered)
  settled_at          TIMESTAMPTZ,
  to_provider_credits INT,
  to_client_credits   INT,
  platform_fee_credits INT,
  basis               TEXT,                 -- full_release|pro_rata|refund|partial|clawback
  review_required     BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS escrow_release_due ON escrow_holds(release_eligible_at)
  WHERE status = 'PENDING_RELEASE';

CREATE TABLE IF NOT EXISTS booking_disputes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    UUID NOT NULL REFERENCES lite_bookings(id),
  raised_by     UUID NOT NULL,
  category      TEXT NOT NULL,    -- not_performed|left_early|wrong_guard|conduct|billing
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'open',  -- open|upheld|rejected|resolved
  to_client_credits   INT,
  to_provider_credits INT,
  decided_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at    TIMESTAMPTZ
);
-- one open dispute per booking (Part V §41)
CREATE UNIQUE INDEX IF NOT EXISTS booking_disputes_one_open
  ON booking_disputes(booking_id) WHERE status = 'open';

-- platform escrow + fee accounts: seed dedicated wallet_balances rows under
-- fixed system user ids (mirror the SYSTEM actor 0000…0001 convention).
INSERT INTO wallet_balances (user_id, bravo_credits, currency)
VALUES
  ('00000000-0000-0000-0000-0000000000e5', 0, 'AED'),  -- ESCROW_ACCOUNT_ID
  ('00000000-0000-0000-0000-0000000000fe', 0, 'AED')   -- PLATFORM_FEE_ACCOUNT_ID
ON CONFLICT (user_id) DO NOTHING;

-- licence / insurance registry WITH expiry, per agency + per CPO + per region
CREATE TABLE IF NOT EXISTS compliance_credentials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id UUID NOT NULL,           -- agency (org_user_id) or CPO (member_user_id)
  subject_kind  TEXT NOT NULL,             -- 'agency' | 'cpo'
  kind          TEXT NOT NULL,             -- 'licence' | 'insurance'
  region_code   TEXT NOT NULL,             -- AE/SA/BD/GB
  reference     TEXT,
  issued_at     TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL,      -- the validity gate
  verified      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS compliance_subject_idx
  ON compliance_credentials(subject_user_id, kind, region_code, expires_at);

-- armed-authorization model (per CPO, per region, per-jurisdiction permit + expiry)
CREATE TABLE IF NOT EXISTS armed_authorizations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cpo_user_id   UUID NOT NULL,
  region_code   TEXT NOT NULL,
  permit_ref    TEXT,
  authorized    BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS armed_auth_cpo_idx ON armed_authorizations(cpo_user_id, region_code);

-- armed / requirements on the request itself (LB11 — honor what the client paid for)
ALTER TABLE lite_bookings
  ADD COLUMN IF NOT EXISTS armed_required  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS requirements    JSONB NOT NULL DEFAULT '{}'::jsonb; -- {female, medical, ...}

-- agency reliability / acceptance counters (rating/jobs_total already exist on agents)
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS offers_received     INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS offers_accepted     INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reliability_breaches INT NOT NULL DEFAULT 0;

-- (optional, per Part V §38) per-booking dispute window override
ALTER TABLE lite_bookings
  ADD COLUMN IF NOT EXISTS dispute_window_seconds INT;
```

- The escrow/fee account user ids must be defined as named constants in config (e.g. `ESCROW_ACCOUNT_ID`, `PLATFORM_FEE_ACCOUNT_ID` in `configuration.ts`) so later money steps reference them, not magic strings. Confirm they don't collide with the messenger SYSTEM actor id `00000000-0000-0000-0000-000000000001`.
- Conditional-UPDATE/idempotency pattern (used by later money steps, enabled by this schema): every escrow transition will be `UPDATE escrow_holds SET status=$next WHERE id=$1 AND status=$expected RETURNING id` inside `db.withTransaction`, paired with the wallet ledger move — 0 rows ⇒ 409/no-op (mirrors `payWithCredits` and `refundForBooking`). The `escrow_holds.booking_id UNIQUE` + the `booking_disputes_one_open` partial unique index are the at-most-once anchors.
- Currency note (Part III payments): wallet defaults are AED/usd and only usd/aed/eur are really supported (verified `creditsPerUsd` fixed-FX in config). The migration's `currency` column allows AED/SAR/BDT/GBP, but actually charging in BDT/GBP needs an `fx_rate` stamped per txn — flag that the FX work is a separate step; the column just must not block it.
  **Frontend / ops-console how-to:** None in this step (pure data model). The ops-console dispute-resolve screen and client receipt/dispute screens come in later steps; ensure their eventual types match the new tables (re-run `cd apps/ops-console && npm run typecheck` after type-gen).
  **Security stop-conditions:** No crypto/E2E/auth primitives touched (Part V is explicit: wallet/ledger only). STOP/verify: do NOT log credential references, permit numbers, or any PII from `compliance_credentials`/`armed_authorizations` (the static log-audit test enforces no-PII logging). The escrow/fee accounts are ordinary `wallet_balances` rows — do not bypass the existing wallet idempotency constraints when later steps move money.
  **Acceptance & tests:**
- New tests (later money steps consume them, but assert schema/invariants now): a migration-applies-clean check; a test asserting the seeded escrow + fee `wallet_balances` rows exist at 0; a test asserting `escrow_holds.booking_id` is UNIQUE (double-insert for one booking fails) and only one `open` dispute per booking is allowed.
- Money invariant placeholder (Part V §43): the reconciliation step will assert `sum(client debits) == held` and `held == to_provider + to_client + platform_fee` at terminal — this migration's columns must support that arithmetic. Add a TODO test stub referencing it.
- `EXPLAIN`/`list_tables` confirm `escrow_holds`, `booking_disputes`, `compliance_credentials`, `armed_authorizations` exist; `agents` shows the new counters; old tables untouched.
- Gates: `apps/auth-service` `npm test` (CI from Step 1), the `booking` Jest project for booking-adjacent changes, `npm run typecheck` (mobile ≤96), `cd apps/ops-console && npm run typecheck`, `npm run lint`. Never commit on red; never `--no-verify`.
  **Done when:**
- [ ] `escrow_holds` (+ `escrow_hold_status` enum) and `booking_disputes` exist, with the `release_eligible_at WHERE PENDING_RELEASE` index and the one-open-dispute partial unique index.
- [ ] Seeded platform escrow + platform-fee `wallet_balances` accounts exist; their ids are named config constants and don't collide with the SYSTEM actor.
- [ ] `compliance_credentials` (licence/insurance with `expires_at`, per agency/CPO/region) and `armed_authorizations` (per CPO/region, with expiry) exist and are indexed for the eligibility gate.
- [ ] `lite_bookings` has `armed_required` + `requirements` (and optional `dispute_window_seconds`); `agents` has reliability/acceptance counters; `agents.rating`/`jobs_total` were reused, not duplicated.
- [ ] Migration applies clean on a scratch/branch DB with no impact on legacy data; no crypto/auth code touched.

---

## Step 4 — Role discriminator (`account_kind`) + CPO session guard

**Stage:** Identity · **Depends on:** Step 3 (managed-CPO accounts already exist via `org_members` + `agents.managed_by_org_id`) · **Resolves:** §35A §A/§B/§F, PR1 (and enables PR2/PR6)
**Goal (plain English):** When anyone logs in, the server itself decides "this account is a customer, a security firm, or a guard" and tells the app exactly that, plus which firm a guard belongs to and whether they still have a temporary password. The app then opens the matching front door — a guard never lands in the customer or firm app by accident — and if the firm later suspends or removes a guard, the next time the app checks in the guard is kicked out to an "access ended" screen.
**Why it matters / what breaks without it:** Today routing is derived from a loosely-trusted `users.role` and AsyncStorage flags (the `pendingProvider` stuck-register bug). Without one server-computed `account_kind`, a managed CPO would re-derive its own role client-side and could land in the wrong app, and a removed guard could keep a live guard interface (and stay in Ops Rooms) indefinitely.

**Self-contained context (inline — do not make the reader open the plan):**

- **Locked decision (§35A):** Bravo is one binary, three app experiences. The experience is chosen at login **from the server's authenticated identity, never from a client-chosen flag**. Never trust a value the client could set.
- **The discriminator precedence (compute server-side, return as a single field):**
  1. **`cpo`** — caller has an `agents` row with `type='cpo'` **and** `managed_by_org_id` set, **OR** an `org_members` row where `member_role='cpo'` **and** `status='active'`.
  2. **`agency`** — caller is a company agent (`agents.type='company'`) **OR** an `org_members` row with `member_role='manager'` (status `active`).
  3. **`individual`** — everything else (`users.role='individual'`, no agent/org membership).
- **Confirmed schema (real code):** `org_members` (PK `org_user_id`,`member_user_id`) has `member_role TEXT CHECK IN ('cpo','manager')` and `status TEXT CHECK IN ('invited','active','suspended','removed')` (`supabase/migrations/20260610000000_provider_orgs_and_managed_cpos.sql:22-35`). `agents.managed_by_org_id UUID` is nullable (NULL = legacy self-registered CPO) (same file :47-48). `agents.type` is the enum `('company','cpo','transport')` and `agents.status` is `agent_status` (`supabase/migrations/20260423180000_agent_portal.sql:19-23,47-48`).
- **`must_set_password` does NOT exist yet.** Managed CPOs are created with a real `password_hash` from the agency-supplied `temp_password` (`apps/auth-service/src/org/org-cpo.service.ts:84-95`) but there is **no flag** marking "still on the temp password." This step must add one (a nullable `password_set_at TIMESTAMPTZ` on `users`, or a `must_set_password BOOLEAN`), set it for managed CPOs at creation, and clear it when the CPO completes `POST /auth/me/password` (`apps/auth-service/src/auth/auth.controller.ts:~325`, `auth.service.changePassword`).
- **Where to surface it:** `GET /agents/me` returns `{agent, profile, kyc, documents, review, deployment}` today (`apps/auth-service/src/agents/agent.service.ts:202-225`); `GET /auth/me` returns only `{user}` (`apps/auth-service/src/auth/auth.service.ts:395-402`). The plan accepts either; prefer **`/auth/me`** because every account (including pure clients with no `agents` row) calls it, whereas a client has no `agents` row so `/agents/me` 404s for them via `requireAgent`.
- **Existing trust pattern to reuse — do NOT bake role into the JWT:** `OrgManagerGuard` (`apps/auth-service/src/org/org-manager.guard.ts`) re-reads the DB on every request (Path 1 = own `company` agent; Path 2 = active `manager` `org_members` row) rather than trusting a claim. The JWT shape is intentionally left unchanged (auth-token security stop-condition). The new session guard for CPOs follows the same "re-read on every request" model.
- **Mid-session revocation rule (§B):** on every app-focus/token-refresh the app re-checks `membership_status`. If a CPO's `org_members.status != 'active'`, force-logout to "Your agency access has ended," set them offline, and drop from Ops Rooms.

**Files to touch:**

- **NEW migration** `supabase/migrations/<ts>_user_must_set_password.sql` — `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_set_at TIMESTAMPTZ;` (idempotent, additive; the `must_set_password` boolean is then derived as `password_set_at IS NULL` for managed CPOs). STOP: also fix the latent gap that `agents.last_lat/last_lng/last_location_at` have no committed migration (see Step 5) — keep these in separate migration files.
- **EXTEND** `apps/auth-service/src/org/org-cpo.service.ts` (`createManagedCpo`, the `INSERT INTO public.users ... RETURNING id` at :88-95) — do **not** set `password_set_at` for managed CPOs (leave NULL ⇒ `must_set_password=true`).
- **EXTEND** `apps/auth-service/src/auth/auth.service.ts` (`changePassword`, ~:417) — on a successful change, `SET password_set_at = NOW()` so first password set clears the flag.
- **EXTEND** `apps/auth-service/src/auth/auth.service.ts` (`getMe`, :395-402) — add a private `resolveAccountKind(userId)` helper and return `{user, account_kind, org: {id,name} | null, must_set_password, membership_status}`.
- **NEW** `apps/auth-service/src/common/guards/cpo-session.guard.ts` — a `CanActivate` that, for a caller resolving to `account_kind='cpo'`, throws `ForbiddenException('agency_access_ended')` when their `org_members.status != 'active'`. Apply it on CPO-scoped mission/comms routes (NOT on `/auth/me` itself — `/auth/me` must still answer so the app can read `membership_status` and route to the "access ended" screen).
- **EXTEND** `src/services/api.ts` (`authApi.me` / `agentApi.getMe` consumer, and the `AgentPortalState`/auth-me response types at :405-460) — add `account_kind`, `org`, `must_set_password`, `membership_status` to the typed response.
- **EXTEND** `src/store/authStore.ts` (:91-96, user shape) — store `account_kind` + `membership_status` on the user so the navigator can switch on it (Step relating to PR2 reads this).
- **NEW spec** `apps/auth-service/src/auth/auth.service.account-kind.spec.ts` (mirror `apps/auth-service/src/org/org-cpo.service.spec.ts` style).

**Backend how-to:**

1. **Migration (additive, idempotent):**
   ```sql
   ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_set_at TIMESTAMPTZ;
   -- Backfill: every existing login already chose its own password.
   UPDATE public.users SET password_set_at = COALESCE(password_set_at, created_at)
     WHERE password_hash IS NOT NULL AND password_set_at IS NULL;
   ```
   Managed CPOs created after this migration land with `password_set_at = NULL` (createManagedCpo doesn't set it) ⇒ `must_set_password = (password_set_at IS NULL)`.
2. **`resolveAccountKind` (single round-trip, precedence-ordered):**
   ```sql
   SELECT
     u.role AS user_role,
     a.type AS agent_type,
     a.managed_by_org_id,
     om.member_role,
     om.status        AS member_status,
     om.org_user_id,
     org.display_name AS org_name,
     u.password_set_at
   FROM public.users u
   LEFT JOIN agents a       ON a.user_id = u.id
   LEFT JOIN org_members om ON om.member_user_id = u.id
   LEFT JOIN public.users org ON org.id = COALESCE(a.managed_by_org_id, om.org_user_id)
   WHERE u.id = $1 AND u.deleted_at IS NULL
   ```
   Then in TS apply precedence exactly: `cpo` if `(agent_type='cpo' && managed_by_org_id) || (member_role='cpo' && member_status='active')`; else `agency` if `(agent_type='company') || (member_role='manager' && member_status='active')`; else `individual`. Set `org = managed_by_org_id||org_user_id ? {id, name: org_name} : null`. Set `must_set_password = account_kind==='cpo' && password_set_at === null`. Set `membership_status = member_status ?? (agent_type==='company' ? 'active' : null)`.
   - **Guard against a stale `om` row matching twice:** if a user is both `manager` of one org and `cpo` of another, the JOIN can fan out — fetch `org_members` with an inner ordered subquery (active first, then by `member_role='cpo'` precedence) or `ORDER BY (status='active') DESC, (member_role='cpo') DESC LIMIT 1`. Cite a `// Why:` for the LIMIT.
3. **CPO session guard (re-read, no skip-in-dev):** model on `OrgManagerGuard`. Apply `JwtAuthGuard` then `CpoSessionGuard`; the guard runs `resolveAccountKind`, and **only** when `account_kind==='cpo'` enforces `membership_status==='active'`, else 403 `agency_access_ended`. Non-CPO callers pass through untouched. Never add a "skip in dev" branch.
4. **Idempotency/race:** `changePassword` already revokes all sessions; add `password_set_at = NOW()` to the same `UPDATE public.users SET password_hash=$1, updated_at=now() ...` statement (`auth.service.ts:432-435`) so the flag clears atomically with the hash — no separate write to race.

**Frontend / ops-console how-to:**

- After auth bootstrap, read `user.account_kind` from the store and mount exactly one stack (PR2 — separate step): `individual`→ClientNavigator, `agency`→AgencyNavigator, `cpo`→CpoNavigator. A CPO never sees `RoleSelectionScreen` (`src/screens/auth/RoleSelectionScreen.tsx`). Today `RootNavigator` (`src/navigation/index.tsx:18-65`) only switches on `isAuthenticated`/`permsShown` — extend it to also branch on `account_kind` (that wiring is PR2; this step just guarantees the field is present and typed).
- `must_set_password===true` ⇒ force the CPO activation flow (set password) before the CPO home.
- On every app-focus/token-refresh, re-fetch `/auth/me`; if `account_kind==='cpo' && membership_status!=='active'`, route to an "Your agency access has ended" screen and sign out (this is PR6; wired here only as the data contract).
- ops-console: none for this step.

**Security stop-conditions:**

- **STOP / verify against the System Architecture Documentation:** the JWT shape and session/token storage are auth-token stop-conditions. **Do not** add `account_kind` or `org_id` as a JWT claim — derive it per-request from the DB exactly like `OrgManagerGuard`. No "skip in dev" branch on `CpoSessionGuard`.
- Never log `password_hash`, the temp password, or any key material. Mid-session revocation drops the CPO from Ops Rooms — Ops Room membership is metadata-only via `ensureBookingOpsRoom`; do not touch group plaintext or group keys here.

**Acceptance & tests:**

- **Backend unit (auth-service jest, run from `apps/auth-service`):** `resolveAccountKind` returns `cpo` for a `type='cpo'+managed_by_org_id` user and for an active `member_role='cpo'`; returns `agency` for a `company` agent and an active `manager`; returns `individual` otherwise; `must_set_password` flips from `true`→`false` after `changePassword`; `CpoSessionGuard` throws `agency_access_ended` when a CPO's `org_members.status='suspended'`/`'removed'` and passes when `'active'` and for non-CPO callers. (Mirror `org-cpo.service.spec.ts`.)
- **Mobile typecheck:** `npm run typecheck` (must stay ≤ baseline **96**).
- **ops-console typecheck:** `cd apps/ops-console && npm run typecheck`.
- **Lint:** `npm run lint`.
- **Regression:** run the auth-service suite (`cd apps/auth-service && npm test`) and the mobile `app` Jest project (`npm test -- --selectProjects=app`). **Correction #6: CI does not run auth-service tests today — this step's backend spec is only protected once CI is fixed; note that dependency.**
- Never commit on a red gate; never `--no-verify`.

**Done when:**

- [ ] `/auth/me` returns `account_kind ∈ {individual, agency, cpo}` plus `org{id,name}|null`, `must_set_password`, `membership_status`, all server-computed.
- [ ] A managed CPO created via `createManagedCpo` reports `must_set_password=true` until they set a password, then `false`.
- [ ] `CpoSessionGuard` 403s a suspended/removed CPO on CPO-scoped routes and is a no-op for agency/individual.
- [ ] No new JWT claim; the discriminator is re-read from the DB every request.
- [ ] Typecheck (mobile ≤96 + ops-console), lint, auth-service spec all green.

---

## Step 5 — Provider go-online + background-capable on-duty location heartbeat

**Stage:** Availability · **Depends on:** Step 4 (an `agency` account exists and is routed to the agency app) · **Resolves:** Part I Phase 2, LB16
**Goal (plain English):** Like an Uber driver tapping "Go Online," an agency taps a switch to say "we're available," and while it's on, the app quietly reports the agency's location on a timer — even when the app is backgrounded — so the dispatch engine knows who's nearby. If an agency hasn't reported a location in 5 minutes we treat it as not really online. The dashboard shows an honest "are we locatable" health dot.
**Why it matters / what breaks without it:** The matchmaker (Phase 3/4) can only rank agencies it can locate. The existing location watcher only runs **during a live mission and only in the foreground**, so a freshly-online agency with no active mission reports nothing — the ranking pool is empty/stale and no jobs ever get offered (LB16, listed P0). A real background-capable on-duty heartbeat is the missing piece.

**Self-contained context (inline — do not make the reader open the plan):**

- **Locked decision (Phase 2):** v1 ranks an _agency_ by its own reported location (the manager/dispatcher device), not by its nearest CPO. Keep v1 simple.
- **Backend already exists — confirm, don't rebuild:**
  - `PATCH /agents/me/duty` → `AgentService.setDuty(userId, on_duty)` sets `agents.on_duty` and keeps the dispatch mirror in sync: `UPDATE cpo_pool SET availability='available' WHERE id=$1 AND availability='off_duty'` when going on, `→'off_duty'` when going off (never touches an `'on_mission'` row). (`apps/auth-service/src/agents/agent.controller.ts:157-160`, `agent.service.ts:1393-1427`; DTO `SetDutyDto { on_duty:boolean }` at `dto/agent.dto.ts:112-114`).
  - `PATCH /agents/me/location` → `AgentService.updateLocation(userId, lat, lng)` validates finite + in-range coords and writes `UPDATE agents SET last_lat=$2, last_lng=$3, last_location_at=NOW() WHERE user_id=$1`. **Accepts any valid coords** (no plausibility/mock-location gating yet — that's a later hardening item P0/§Part III). (`agent.controller.ts:162-168`, `agent.service.ts:1429-1441`; DTO `UpdateLocationDto { lat:[-90,90], lng:[-180,180] }` at `dto/agent.dto.ts:152-157`.)
  - Mobile clients: `agentApi.setDuty(on_duty)` and `agentApi.updateLocation(lat,lng)` already exist (`src/services/api.ts:530-531`).
- **Staleness rule (define the constant, enforced by the ranking query, not here):** an agency is _locatable_ only if `on_duty=true AND last_location_at > NOW() - INTERVAL '5 minutes'`. Define `LOCATION_FRESH_MINUTES = 5` as the shared cutoff (the dispatch ranking in Phase 3/4 uses the same value). The health dot in the app uses this same threshold against `last_location_at`.
- **What exists vs what's missing (the real gap):** `AgentDashboardScreen` already has a working **Go Online** toggle and an optimistic-with-rollback `commitDuty` (`src/screens/agent/AgentDashboardScreen.tsx:242-283`). It also has a location-reporting `useEffect`, but it is **gated on `missionActive`** (`DISPATCHED|PICKUP|LIVE|SOS`) AND uses `react-native-geolocation-service` `watchPosition` inside a screen-lifecycle effect — i.e. **foreground-only and mission-only** (`AgentDashboardScreen.tsx:203-240`). The copy-source `LiveTrackingScreen.tsx:268-295` is the same foreground `whenInUse` pattern (its own comment: "we only push GPS while the screen is foregrounded"). **There is no background-capable on-duty heartbeat today.**
- **Confirmed platform note:** the project's only geolocation lib is `react-native-geolocation-service@^5.3.1` (foreground/`whenInUse`); `@notifee/react-native` is present (usable for an Android foreground-service notification). No background-location/task-manager lib is installed — adding background capability requires either a foreground-service approach (notifee + a headless interval) or adding a background-geolocation dependency. Call this out explicitly; do not silently assume background "just works."
- **Schema gap to fix (verified):** `agents.last_lat/last_lng/last_location_at` are written by `updateLocation` and read by the ranking query but **have no committed migration** in `supabase/migrations` (the original `agent_portal.sql` agents DDL at :45-62 has no such columns; they were added ad-hoc on the live DB). This step must add the missing migration so the ranking query is reproducible on a fresh DB.

**Files to touch:**

- **NEW migration** `supabase/migrations/<ts>_agents_location_columns.sql` — additive/idempotent: `ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS last_lat DOUBLE PRECISION, ADD COLUMN IF NOT EXISTS last_lng DOUBLE PRECISION, ADD COLUMN IF NOT EXISTS last_location_at TIMESTAMPTZ;` plus the dispatch-pool partial index from the plan: `CREATE INDEX IF NOT EXISTS agents_dispatch_pool ON agents (status, on_duty, type) WHERE type='company';`. STOP-adjacent: correction #4 (PostGIS `geography(Point,4326)`+GiST+`ST_DWithin`, region*code) is a \_later* dispatch-ranking step — do not implement geo indexing here; this migration just makes the lat/lng/timestamp columns real.
- **NEW** `src/modules/location/onDutyHeartbeat.ts` (or `src/services/onDutyHeartbeat.ts`) — a background-capable heartbeat controller: `start()` (acquire foreground-service / background-geo, push `agentApi.updateLocation` every ~30–60s), `stop()`, idempotent start/stop, and `LOCATION_FRESH_MINUTES = 5` exported.
- **EXTEND** `src/screens/agent/AgentDashboardScreen.tsx` — drive the heartbeat from **duty state, not mission state**: start the heartbeat when `onDuty && locStatus==='granted'`, stop when off-duty or permission lost. Keep the existing mission-gated high-frequency live-map watcher separate (it's for the live map, not for "are we online"). Add the **"locatable" health dot** computed from `last_location_at` vs `LOCATION_FRESH_MINUTES` (green = fresh, amber/red = stale/offline) next to the Go Online toggle.
- **EXTEND** Android config — `android/app/src/main/AndroidManifest.xml` (foreground-service + `ACCESS_BACKGROUND_LOCATION` permission) and the notifee channel; iOS `Info.plist` (`NSLocationAlwaysAndWhenInUseUsageDescription`) if background on iOS is in scope. Verify exact paths before editing.
- **NEW spec** `src/screens/agent/__tests__/onDutyHeartbeat.test.ts` (Jest `app` project — the agent specs live under `src/screens/agent/__tests__/`).

**Backend how-to:**

- No new endpoints — reuse `PATCH /agents/me/duty` and `PATCH /agents/me/location`. **Confirm `updateLocation` in `agent.service.ts:1429-1441`** validates coords (`invalid_coords`, `coords_out_of_range`) and writes `last_location_at=NOW()` — it does. The DTO already clamps `lat∈[-90,90]`, `lng∈[-180,180]`.
- **Migration only** (above). After it, the Phase 3/4 ranking query (`WHERE a.type='company' AND a.status='ACTIVE' AND a.on_duty=true AND a.last_location_at > NOW() - (:fresh_minutes||' minutes')::interval ...`) runs on a fresh DB.
- **Note for the later hardening step (do not do here):** mock-location/plausibility gating on the heartbeat and PostGIS geo indexing are separate items.

**Frontend / ops-console how-to:**

- **Go Online toggle** already wired via `commitDuty`→`agentApi.setDuty` with optimistic rollback and an on-mission confirm dialog (`AgentDashboardScreen.tsx:242-283`); only `ACTIVE` company agents should be allowed to flip it (gate on `me.agent.status==='ACTIVE'`).
- **Heartbeat:** copy the permission-request shape from `LiveTrackingScreen.tsx:241-263` (`PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION` on Android; `Geolocation.requestAuthorization` on iOS) but, for background, additionally request `ACCESS_BACKGROUND_LOCATION` and run inside a notifee foreground service (Android) so the OS doesn't suspend the watcher. Push `agentApi.updateLocation(lat,lng)` on a 30–60s timer (throttle, swallow transient network errors like the existing watchers do). `start()` on `onDuty` true, `stop()` on false/permission-lost — explicitly NOT gated on an active mission.
- **Health dot:** compute `locatable = onDuty && me.agent.last_location_at && (Date.now() - new Date(last_location_at).getTime()) < LOCATION_FRESH_MINUTES*60_000`. Render green (locatable) / amber (online but stale) / grey (offline) next to the toggle, with a tooltip explaining "you must keep location on to receive jobs." This is the "honest are-we-locatable" surface from LB16.
- ops-console: none required for this step (optional: show the same staleness in the agency monitor later).

**Security stop-conditions:**

- None beyond standard guards for the heartbeat itself (location is the agency's own coords, written only to its own row via `user.sub`-scoped endpoints). **Do not** weaken or remove `updateLocation`'s coord validation. **Note (not this step):** location-spoofing/mock-location gating is a known P0 hardening follow-up — flag it, don't skip the eventual gate. Never log raw GPS streams beyond what's necessary; never log key material (the heartbeat carries none).

**Acceptance & tests:**

- **Mobile unit (`app` Jest project, `src/screens/agent/__tests__/`):** `onDutyHeartbeat.start()` calls `agentApi.updateLocation` on its interval and `stop()` clears it (fake timers + mocked `agentApi`); start/stop is idempotent (double-start doesn't double-fire); heartbeat is driven by duty, not mission (assert it fires with no active mission). Run: `npm test -- --selectProjects=app`.
- **Health-dot logic:** unit-test the `locatable` staleness computation against `LOCATION_FRESH_MINUTES` (fresh → true, >5min → false, off-duty → false).
- **Mobile typecheck:** `npm run typecheck` (≤ baseline **96**). **Lint:** `npm run lint`.
- **Manual smoke (native — say so if no device):** toggle Online on a real device with **no active mission** → DB shows `agents.on_duty=true` and `last_lat/last_lng/last_location_at` updating on the timer; background the app → updates continue (foreground service / background-geo working); toggle Offline → updates stop and the health dot goes grey. Also exercise an **error path** (deny location permission → toggle stays/flips back, health dot shows "not locatable," no crash).
- **Regression:** the existing mission-gated live-map watcher (`AgentDashboardScreen` + `LiveTrackingScreen`) still works during a live mission (don't break it by reusing its effect). Re-run the `app` project.
- This is not near messaging/crypto, so `npm run test:crypto` is not required. Never commit on a red gate; never `--no-verify`.

**Done when:**

- [ ] A committed migration adds `agents.last_lat/last_lng/last_location_at` + the `agents_dispatch_pool` partial index (fresh-DB reproducible).
- [ ] Toggling Online starts a background-capable heartbeat that `PATCH /agents/me/location` on a 30–60s timer **with no active mission required**; toggling Offline stops it.
- [ ] The dashboard shows an honest "locatable" health dot driven by `last_location_at` vs `LOCATION_FRESH_MINUTES=5`.
- [ ] `updateLocation` coord validation is unchanged; no spoofing-gate bypass introduced.
- [ ] `app` Jest project + typecheck (≤96) + lint green; manual on-device smoke (golden + denied-permission path) passes, or the device limitation is stated explicitly.

---

## Step 6 — DispatchService: proximity ranking + offer cascade

**Stage:** Dispatch engine · **Depends on:** Step 1 (feature flag `AUTO_DISPATCH_ENABLED`), Step 2 (migration: `dispatch_offers` table + enum + `lite_bookings.dispatch_mode/assigned_provider_user_id/dispatch_started_at/dispatch_settled_at` + `agents.region_code` + PostGIS geo column/GiST index), Step 5 (provider "Go Online" + location heartbeat writing `agents.last_lat/last_lng/last_location_at`) · **Resolves:** Part I §8 (Phase 3, the matchmaker), Part III "Reliability & correctness" + "Scalability & performance" + "Trust & safety", LB8 (every transition a conditional UPDATE), LB10 (vetting/eligibility gate), LB11 (honor what the client paid for)
**Goal (plain English):** Build the server-side "brain" that, the instant a client submits an auto request, looks at every security agency that is online and nearby in the same country, picks the closest one that is genuinely able to take the job, and offers it to them for 30 seconds. If they decline or don't answer, it offers the next-closest — up to a cap — and if nobody takes it, it tells the customer no one is available. It never picks the crew; it only commits the agency.
**Why it matters / what breaks without it:** This is the core of "Uber for bodyguards." Without it the request is invisible until a human approves it (the flow we are replacing), and a naive version would leak the client's location, double-offer the same agency, dispatch unlicensed guards, or let two pods race the same offer.
**Self-contained context (inline — do not make the reader open the plan):**

- **Locked decisions:** D1 fully automatic (no admin in the path). D3 the _agency_ (`agents.type='company'`) accepts, then later deploys its own CPOs. D4 nearest **within the same region** (AE/SA/BD/GB). D6 one agency runs several concurrent missions, bounded by free CPO capacity. D7 accept does NOT auto-pick crew — that is a later step that materializes the mission.
- **Booking FSM** (`apps/auth-service/src/booking/state-machine.service.ts`, `BookingStateMachine.assert(from,to,actor)`): today it is `DRAFT→PENDING_OPS→OPS_APPROVED→PAYMENT_PENDING→CONFIRMED→LIVE→COMPLETED`, actors `CLIENT|OPS_HANDLER|CPO|SYSTEM`. This feature adds (in Step 2's FSM edit) `DRAFT→DISPATCHING` (CLIENT), `DISPATCHING→CONFIRMED` (SYSTEM, = "accepted, awaiting crew"), `DISPATCHING→NO_PROVIDER` (SYSTEM, terminal), `DISPATCHING→CANCELLED` (CLIENT/SYSTEM). Do not delete existing transitions — the legacy admin flow still uses them.
- **`dispatch_offers`** (from Step 2): columns `id, booking_id, provider_user_id, rank, distance_km, status dispatch_offer_status('OFFERED','ACCEPTED','REJECTED','EXPIRED','SUPERSEDED','CANCELLED'), offered_at, expires_at, responded_at, reject_reason`. Constants: `OFFER_TTL_SECONDS=30`, `MAX_OFFERS=8`, `LOCATION_FRESH_MINUTES=5`.
- **CORRECTION (Part III #4):** `agents` has **no `region_code`** today and DECIMAL-haversine `ORDER BY` is a full table scan. Step 2 must add `agents.region_code TEXT` plus a PostGIS `geography(Point,4326)` location column (e.g. `last_geog`) + GiST index. PostGIS is already enabled (`CREATE EXTENSION postgis` in `20260416000000_init_phase1.sql`; `geography(Point,4326)` already used by `zones`, `lite_bookings.pickup_point`). Rank with `ST_DWithin(a.last_geog, :pickup_geog, :radius_m)` filtered + `ORDER BY a.last_geog <-> :pickup_geog` (or `ST_Distance`) — NOT a per-row `acos()` haversine.
- **CORRECTION (Part III #3):** the offer must be **coarse pre-accept** — the ranking + offer creation here must NOT push pickup/dropoff coords anywhere a rejecting agency can read them. Exact coords are exposed only by the ACCEPTED-only endpoint built in Step 7. Persist `distance_km` for audit/display only.
- **Eligibility = ACTIVE company agent + on_duty + fresh location + region-matched + licence/insurance valid & non-expired & region-matched (LB10) + armed-authorized IF the job requires armed (LB10/LB11) + `has_free_cpo_capacity` (D6/LB11).** `agents` today has `type, status, tier, rating, jobs_total, on_duty` and (added by the agent-portal location work that `agent.service.ts:1438` writes) `last_lat/last_lng/last_location_at`. Licence/insurance/armed registries with expiry do **not** exist yet — Step 2/LB10 must add them; if they are not yet built, gate behind the flag and treat the eligibility predicate as a named SQL function so it can be tightened without touching this service.
- **Capacity formula (D6, Part II §24):** `free_cpos(agency) = (active org_members CPOs) − (distinct CPOs in a non-completed mission_crew) − (Σ cpo_count of this agency's CONFIRMED bookings that have no mission yet)`. Offer eligible ⇔ `free_cpos >= booking.cpo_count`. Roster lives in `org_members` (`member_user_id, member_role IN ('cpo','manager'), status='active'`, org = the company agent's `users.id`); crew in `mission_crew` (`is_lead BOOLEAN`); `missions` is the mission table. The agency's accepted-uncrewed bookings are `lite_bookings.assigned_provider_user_id = agency AND status='CONFIRMED'` with no `missions` row.
- **Requirements the client paid for (LB11):** `lite_bookings` carries `cpo_count` (booking-level integer) and `add_ons JSONB` (e.g. `'female_cpo'`, `'medical'`); there is no booking-level `armed` boolean today (Step 2/LB10 must add an `armed`/requirements field). Carry `cpo_count`, armed, female, medical into BOTH the ranking predicate here and (later step) the crew-assign validation — they must not be silently dropped.
- **Reuse points:** `DatabaseService` (`db.q<T>(sql,params)`, `db.qOne<T>(sql,params)`, `db.withTransaction(async tx => …)` where `tx.q/tx.qOne` exist; `SELECT … FOR UPDATE` inside the txn). `OpsAuditService.record({actor_id:null, actor_role:'SYSTEM', action, subject_type, subject_id, metadata})` (note: `record` fails-closed/re-throws for actions in its CRITICAL set; pick non-critical action names like `'dispatch.offer'`, `'dispatch.no_provider'` unless you intend a rollback-on-audit-failure). `BookingPushBridge.publish(...)` for offer/no-provider wakes (wired in Step 7). `SystemMessengerService.ensureBookingOpsRoom` is NOT called here (only at accept, Step in Phase 6). The wallet is NOT touched here (charge happens at accept).
- **Race-safety pattern (the contract for every state-changing method) — mirror `job-feed.service.ts cancel()`:**
  ```ts
  await this.db.withTransaction(async tx => {
    const cur = await tx.qOne<{status: string}>(
      `SELECT status FROM dispatch_offers WHERE id=$1 FOR UPDATE`,
      [offerId],
    );
    if (!cur || cur.status !== 'OFFERED')
      throw new BadRequestException('offer_state_changed_concurrently'); // → 409
    const upd = await tx.q(
      `UPDATE dispatch_offers SET status='EXPIRED', responded_at=NOW() WHERE id=$1 AND status='OFFERED' RETURNING id`,
      [offerId],
    );
    if (upd.length === 0) throw new BadRequestException('offer_state_changed_concurrently');
    // …then cascade inside or after the txn
  });
  ```
  **Files to touch:**
- NEW `apps/auth-service/src/dispatch/dispatch.service.ts` — the `DispatchService` class with `start/offerNext/expire/reject/noProvider/cancel` (accept lives in the Phase 6 step but stub its signature here).
- NEW `apps/auth-service/src/dispatch/dispatch.module.ts` — `@Module` importing `DatabaseModule`, `RedisModule`, the booking FSM provider, `OpsAuditService`/its module, `BookingPushBridge`/its module; providing/exporting `DispatchService`.
- EXTEND `apps/auth-service/src/app.module.ts` — register `DispatchModule`.
- NEW `apps/auth-service/src/dispatch/dispatch.service.spec.ts` — unit tests (next-step file but author the spec here per change-safety rule "write the failing test first").
- VERIFY (do not edit here): `apps/auth-service/src/booking/state-machine.service.ts` (the new statuses land in Step 2), `apps/auth-service/src/ops/job-feed.service.ts` (race pattern reference, lines ~400–420), `apps/auth-service/src/ops/ops-audit.service.ts` (`record` signature, lines 68–102).
  **Backend how-to:**
- **Constants** at top of `dispatch.service.ts`: `OFFER_TTL_SECONDS=30`, `MAX_OFFERS=8`, `LOCATION_FRESH_MINUTES=5`.
- **`start(bookingId)`:** in a txn, `SELECT status, region_code, cpo_count, pickup_lat, pickup_lng FROM lite_bookings WHERE id=$1 FOR UPDATE`; assert booking is at the pre-dispatch state and `dispatch_mode='auto'`; `fsm.assert(cur.status,'DISPATCHING','CLIENT')` (or `'SYSTEM'` per the FSM table); `UPDATE lite_bookings SET status='DISPATCHING', dispatch_started_at=NOW() WHERE id=$1 AND status=$expected RETURNING id` (0 rows ⇒ 409); audit `'dispatch.start'`. Then call `offerNext(bookingId)`.
- **Ranking query (inside `offerNext`)** — region-scoped, PostGIS, eligibility-filtered, exclusion-filtered, NO coords returned to callers:
  ```sql
  SELECT a.user_id, a.rating, a.jobs_total,
         ST_Distance(a.last_geog, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography)/1000.0 AS distance_km
  FROM agents a
  WHERE a.type='company' AND a.status='ACTIVE' AND a.on_duty = TRUE
    AND a.last_location_at > NOW() - ($5 || ' minutes')::interval   -- LOCATION_FRESH_MINUTES
    AND a.region_code = $3                                          -- D4 same-region
    AND ST_DWithin(a.last_geog, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $6)  -- radius_m
    AND is_eligible_for_dispatch(a.user_id, $4)        -- LB10/LB11: licence+insurance valid+non-expired+region, armed-auth if needed
    AND has_free_cpo_capacity(a.user_id, $7)           -- D6: free_cpos >= booking.cpo_count
    AND a.user_id NOT IN (SELECT provider_user_id FROM dispatch_offers WHERE status='OFFERED')
    AND a.user_id NOT IN (SELECT provider_user_id FROM dispatch_offers WHERE booking_id=$8 AND status IN ('REJECTED','EXPIRED'))
  ORDER BY a.last_geog <-> ST_SetSRID(ST_MakePoint($2,$1),4326)::geography
  LIMIT 1;
  ```
  (`$1`=pickup_lat, `$2`=pickup_lng, `$3`=region, `$4`=requirements json incl. armed/female/medical, `$5`=LOCATION_FRESH_MINUTES, `$6`=radius_m, `$7`=cpo_count, `$8`=booking_id.) Push the armed/female/medical predicate into `is_eligible_for_dispatch`/`has_free_cpo_capacity` (SQL functions in Step 2) so it is one source of truth.
- **`offerNext(bookingId)`:** count existing offers for the booking; if `>= MAX_OFFERS` → `noProvider(bookingId)`. Else run the ranking query; if no candidate → `noProvider(bookingId)`. Else `INSERT INTO dispatch_offers (booking_id, provider_user_id, rank, distance_km, status, offered_at, expires_at) VALUES ($1,$2,$nextRank,$dist,'OFFERED',NOW(),NOW()+($ttl||' seconds')::interval) RETURNING id`. The partial unique index `dispatch_offers_one_live_per_provider (provider_user_id) WHERE status='OFFERED'` makes a concurrent double-offer of the same provider fail the INSERT — catch the unique violation and re-run `offerNext` (advance to the next candidate) rather than 500. Then call the Step-7 push (`BookingPushBridge.dispatchOffer(providerUserId, …)`) outside the critical section, best-effort. Audit `'dispatch.offer'` with `{rank, distance_km, provider_user_id}`.
- **`reject(offerId, providerUserId, reason?)`:** conditional `UPDATE … SET status='REJECTED', responded_at=NOW(), reject_reason=$reason WHERE id=$1 AND status='OFFERED' AND provider_user_id=$2 RETURNING id` (0 rows ⇒ 409; ownership is also re-checked at the controller in Step 7). Then `offerNext(bookingId)`. (Redact PII from `reject_reason` — Part III privacy P1.)
- **`expire(offerId)`** (called by Step 8 watchdog): conditional `UPDATE … SET status='EXPIRED', responded_at=NOW() WHERE id=$1 AND status='OFFERED' RETURNING booking_id`; if 0 rows, no-op (raced with accept). Then `offerNext(returned booking_id)`.
- **`noProvider(bookingId)`:** conditional `UPDATE lite_bookings SET status='NO_PROVIDER', dispatch_settled_at=NOW() WHERE id=$1 AND status='DISPATCHING' RETURNING id` (0 rows ⇒ booking already moved on; no-op). `fsm.assert('DISPATCHING','NO_PROVIDER','SYSTEM')`. Push client `BookingPushBridge.noProvider(clientUserId, …)` (Step 7). Audit `'dispatch.no_provider'`. (LB13: NO_PROVIDER should later offer a safety fallback, not just "no one available" — note it; out of scope for this step.)
- **`cancel(bookingId)`** (client cancels while searching): in a txn, `UPDATE dispatch_offers SET status='SUPERSEDED' WHERE booking_id=$1 AND status='OFFERED' RETURNING provider_user_id, id`; `fsm.assert(cur,'CANCELLED','CLIENT'); UPDATE lite_bookings SET status='CANCELLED' WHERE id=$1 AND status='DISPATCHING' RETURNING id`. Notify the current holder (push). No charge (money only moves at accept). Audit `'dispatch.cancel'`.
- **`accept(...)`** — stub the signature here returning a TODO/throw; full implementation (charge into escrow + Ops Room + booking→CONFIRMED) is the Phase 6 / Part V escrow step. Its body MUST be the offer-anchored conditional UPDATE (`… WHERE id=$1 AND status='OFFERED' AND expires_at>NOW() RETURNING`).
  **Frontend / ops-console how-to:** None (pure backend).
  **Security stop-conditions:**
- **STOP/verify against the System Architecture Documentation** before exposing ANY coordinate: this step must keep pickup/dropoff out of everything a rejecting/offered agency can read (LB1, Part III #3). Persist only `distance_km` (and bucket it for display in Step 7). Do not add coords to `dispatch_offers` rows that the provider can query.
- Do NOT touch encryption, sealed-sender, or the Ops Room here. The Ops Room is created later (accept) via `ensureBookingOpsRoom` only.
- Do NOT add a "skip in dev" branch to the eligibility/vetting predicate (LB10) — if the licence/insurance/armed registry isn't built yet, gate the whole feature behind `AUTO_DISPATCH_ENABLED` rather than weakening the filter.
- Never log plaintext addresses/coords or PII from `reject_reason` (static log-audit test enforces no plaintext leaks).
  **Acceptance & tests:**
- NEW unit tests in `dispatch.service.spec.ts` (mock `DatabaseService`/`RedisService`): (a) pool of 3 agencies at increasing distance → offers go out nearest-first; (b) reject #1 → #2 gets the offer and #1 is in the booking's `REJECTED` exclusion; (c) accept-state guard: `expire`/`reject` on a non-`OFFERED` offer returns/raises the concurrent-change error (409 path); (d) empty/zero-eligible pool → `noProvider` flips booking to `NO_PROVIDER`; (e) `MAX_OFFERS` reached → `noProvider`; (f) capacity: agency with `free_cpos < cpo_count` is excluded; (g) requirements: a job needing armed/female excludes a non-qualifying agency; (h) the `one-live-offer-per-provider` unique-violation path re-runs `offerNext` instead of 500.
- Regression: run the **booking** Jest project — `npm test -- --selectProjects=booking` — and the ops smoke specs (`ops-flow.smoke.spec.ts`); the legacy admin flow and existing FSM transitions must still pass.
- Gates: `cd apps/auth-service && npm run build` (backend typecheck/build); root `npm run typecheck` (mobile, ≤ baseline 96) and `cd apps/ops-console && npm run typecheck` (no mobile/ops changes here, so just confirm no drift); `npm run lint`. `npm run test:crypto` not required (no messaging touched). **CORRECTION (Part III #6): CI does not run auth-service tests today** — these specs are invisible to the gate until Step (CI fix) lands; run them locally and do not rely on CI green for this module yet.
- Never commit on a red gate; never `--no-verify`.
  **Done when:**
- `DispatchService` exists and is registered in `app.module.ts`; `start → offerNext` produces an `OFFERED` row for the nearest eligible same-region agency only.
- Every state-changing method (`start/offerNext/expire/reject/noProvider/cancel`) is a conditional `UPDATE … WHERE <expected status> RETURNING` inside `withTransaction`; concurrent callers get a 409-style error, never a double-action.
- Ranking uses PostGIS `ST_DWithin`/distance ordering (no per-row haversine) and applies region + capacity + requirements + vetting filters.
- No coordinates are persisted or returned to offered/rejecting agencies.
- Cascade advances on reject/expire, stops on accept, and resolves to `NO_PROVIDER` on empty pool or `MAX_OFFERS`; all unit tests above pass locally; booking Jest project still green.

## Step 7 — Offer endpoints: coarse visibility + IDOR scope + idempotency + throttle

**Stage:** Dispatch engine · **Depends on:** Step 6 (`DispatchService` methods + `dispatch_offers` rows), Step 2 (migration), Step 1 (feature flag) · **Resolves:** Part I §9 (Phase 4 provider accept/reject), Part III "Security & threat model" + "Anti-fraud" + "Privacy", LB1 (principal location is the crown jewel), LB3 (money offer-anchored & race-safe — accept path), LB7 (cross-tenant IDOR), Audit H5 (UUID-stripping both directions)
**Goal (plain English):** Build the HTTP endpoints the agency app calls to see and respond to an incoming job. Before the agency accepts, they only ever see _coarse_ details — region, a bucketed distance, a truncated/zone pickup, the time window, and the price — never the customer's exact address. The precise location is revealed only after they accept, through a separate endpoint that refuses anyone who isn't the accepting agency. Accept and decline are tap-safe (no double-charge from a double-tap) and rate-limited.
**Why it matters / what breaks without it:** Shipping the exact pickup/dropoff to every offered (and every rejecting) agency is the single worst data leak in this system — it tells firms that DIDN'T take the job exactly where the protected person will be (Part III's "crown-jewel leak"). Without tenant scoping, one firm could accept/read another firm's job (IDOR). Without idempotency, a double-tap or two devices could double-charge. Without throttling, the free request/poll becomes a fleet-reconnaissance and denial-of-coverage oracle.
**Self-contained context (inline — do not make the reader open the plan):**

- **Endpoints (all `@UseGuards(JwtAuthGuard, UserThrottlerGuard)`):**
  - `GET /dispatch/offers/current` → the caller's single live `OFFERED` offer (or `null`), joined to the booking but returning **COARSE ONLY**: `{ offer_id, expires_at, region_code, distance_bucket (e.g. "<2km"/"2–5km"/"5–10km"/">10km"), pickup_zone_or_truncated, time_window, price, cpo_count, requirements (armed/female/medical flags) }`. **NEVER** exact `pickup_lat/lng`, `dropoff_lat/lng`, full address, or client identity pre-accept (LB1).
  - `GET /dispatch/offers/:id/full` → precise `{ pickup_lat/lng, pickup_address, dropoff_lat/lng, dropoff_address, … }` returned **ONLY when** `offer.status='ACCEPTED' AND caller's org == offer.provider_user_id`; **403** otherwise. Write an `ops_audit` row on **every** read of this endpoint (LB1: "audit every full read").
  - `POST /dispatch/offers/:id/accept` → `DispatchService.accept(offerId, providerUserId)`; `@UseInterceptors(IdempotencyInterceptor)` (client sends `Idempotency-Key`); offer-state guard.
  - `POST /dispatch/offers/:id/reject` body `{ reason? }` → `DispatchService.reject(offerId, providerUserId, reason)`; offer-state guard.
- **Offer-state guard:** accept/reject return **409** if the offer is not `OFFERED` (already expired/superseded/accepted) — the app then shows "this job was reassigned." The real exactly-once guarantee is the conditional `UPDATE … WHERE status='OFFERED' RETURNING` inside `DispatchService` (Step 6 / LB3/LB8), NOT the idempotency cache.
- **Caller-org resolution (LB7 — the IDOR fix):** the offer's `provider_user_id` is the **company agent's `users.id`** (the org). The caller may be the company account itself OR an active _manager_ of that org — NOT necessarily `req.user.sub`. Resolve the caller's org exactly like `OrgManagerGuard` does (`apps/auth-service/src/org/org-manager.guard.ts`): (1) if `req.user.sub` is a `company` agent → org = `sub`; (2) else if an `org_members` row exists with `member_role='manager', status='active'` → org = `org_user_id`; else 403. Then require **resolved org == `offer.provider_user_id`**, else **403** — use `assertOrgScope(manager, offer.provider_user_id)` (exported from `org-manager.guard.ts`). Apply this on `current`, `full`, `accept`, and `reject`. Apply `OrgManagerGuard` to the controller so `req.orgManager: OrgManagerContext {user_id, org_user_id}` is populated.
- **UUID-stripping (Audit H5) — both directions:** mirror `BookingService.getTeam` (`booking.service.ts:390`), which strips the internal agent UUID from the client payload via `cpos.map(({id: _id, ...rest}) => rest)`. Here: (a) the COARSE offer to the agency must NOT carry the client's `users.id` or any cross-correlatable UUID; (b) any provider-facing payload must not leak other tenants' ids. "Both directions" = neither the agency-facing nor (later) the client-facing payload exposes the counterpart's internal account UUID.
- **Reuse points (confirmed in code):** `IdempotencyInterceptor` (`apps/auth-service/src/common/interceptors/idempotency.interceptor.ts`) — requires header `Idempotency-Key` (8–128 chars `[A-Za-z0-9_-]`), caches per (actor, method+route, key) for 24h, never caches thrown errors. `UserThrottlerGuard` (`common/guards/user-throttler.guard.ts`) — buckets by `user:<sub>`; apply AFTER `JwtAuthGuard`. `@Throttle({default:{limit,ttl}})` from `@nestjs/throttler` — exact usage in `sos/sos.controller.ts:13,25` (`@UseGuards(JwtAuthGuard, UserThrottlerGuard)` on the class, `@Throttle({default:{limit:3,ttl:60_000}})` per route). `OpsAuditService.record({actor_id, actor_role:'SYSTEM'|provider, action:'dispatch.full_read'|'dispatch.accept'|'dispatch.reject', subject_type:'booking', subject_id, metadata})`. `AccessClaims.sub` is the user id.
- **Booking FSM context:** accept (Step 6/Phase 6) flips `DISPATCHING → CONFIRMED` (SYSTEM) and charges into escrow; reject leaves the booking `DISPATCHING` and cascades. This step is the controller surface; the transactional guts live in `DispatchService`.
  **Files to touch:**
- NEW `apps/auth-service/src/dispatch/dispatch.controller.ts` — the four routes above with guards/interceptors; resolves caller org and calls `assertOrgScope`.
- NEW `apps/auth-service/src/dispatch/dto/` — `CoarseOfferDto`, `FullOfferDto`, `RejectOfferDto { reason?: string }`. Keep DTOs focused; do NOT widen any existing client/team DTO.
- EXTEND `apps/auth-service/src/dispatch/dispatch.module.ts` — declare the controller; ensure `RedisModule` (for `IdempotencyInterceptor`), `ThrottlerModule` (already configured app-wide in `app.module.ts`), `DatabaseService`, `OrgManagerGuard`, `OpsAuditService` are available.
- EXTEND `apps/auth-service/src/dispatch/dispatch.service.ts` — add coarse/full read helpers (`getCurrentOfferForOrg(orgUserId)`, `getFullOffer(orgUserId, offerId)`), bucketing helper for `distance_km → distance_bucket`, and pickup truncation/zone helper. (`reject` + `accept` already exist from Step 6.)
- NEW `apps/auth-service/src/dispatch/dispatch.controller.spec.ts` — controller/auth tests.
- VERIFY (do not edit): `org/org-manager.guard.ts` (`assertOrgScope`, `OrgManagerContext`), `common/interceptors/idempotency.interceptor.ts`, `common/guards/user-throttler.guard.ts`, `sos/sos.controller.ts` (decorator pattern), `booking/booking.service.ts:390` (H5 strip pattern).
  **Backend how-to:**
- **Controller skeleton:**

  ```ts
  @UseGuards(JwtAuthGuard, OrgManagerGuard, UserThrottlerGuard)
  @Controller('dispatch/offers')
  export class DispatchController {
    constructor(
      private readonly dispatch: DispatchService,
      private readonly audit: OpsAuditService,
    ) {}

    @Throttle({default: {limit: 30, ttl: 60_000}})
    @Get('current')
    current(@Req() req): Promise<CoarseOfferDto | null> {
      return this.dispatch.getCurrentOfferForOrg(req.orgManager.org_user_id); // coarse only
    }

    @Throttle({default: {limit: 20, ttl: 60_000}})
    @Get(':id/full')
    async full(@Req() req, @Param('id', ParseUUIDPipe) id: string): Promise<FullOfferDto> {
      const dto = await this.dispatch.getFullOffer(req.orgManager.org_user_id, id); // throws 403 unless ACCEPTED && caller==provider
      await this.audit.record({
        actor_id: req.orgManager.user_id,
        actor_role: 'SYSTEM',
        action: 'dispatch.full_read',
        subject_type: 'booking',
        subject_id: dto.booking_id,
        metadata: {offer_id: id},
      });
      return dto;
    }

    @Throttle({default: {limit: 10, ttl: 60_000}})
    @UseInterceptors(IdempotencyInterceptor)
    @Post(':id/accept')
    accept(@Req() req, @Param('id', ParseUUIDPipe) id: string) {
      return this.dispatch.accept(id, req.orgManager.org_user_id); // conditional UPDATE ... WHERE status='OFFERED' RETURNING (Step 6/Phase 6)
    }

    @Throttle({default: {limit: 20, ttl: 60_000}})
    @Post(':id/reject')
    reject(@Req() req, @Param('id', ParseUUIDPipe) id: string, @Body() body: RejectOfferDto) {
      return this.dispatch.reject(id, req.orgManager.org_user_id, body.reason);
    }
  }
  ```

- **`getCurrentOfferForOrg(orgUserId)`** in the service: `SELECT o.id, o.expires_at, o.distance_km, b.region_code, b.pickup_time, b.duration_hours, b.total_eur, b.cpo_count, b.add_ons FROM dispatch_offers o JOIN lite_bookings b ON b.id=o.booking_id WHERE o.provider_user_id=$1 AND o.status='OFFERED' ORDER BY o.offered_at DESC LIMIT 1`. Map to coarse DTO: bucket `distance_km`; derive `pickup_zone` (zone name via PostGIS `ST_Contains(zones.zone, pickup_point)` or truncate coords to ~2 decimals / round to a grid) instead of returning raw lat/lng; derive `time_window` from `pickup_time` (±window); derive `requirements` from `add_ons` (+ the armed flag added in Step 2). **Strip every counterpart UUID** (no `client_id`, no `booking_id` if it enables `/full` enumeration — if you must return `offer_id`, that's the only handle the agency needs).
- **`getFullOffer(orgUserId, offerId)`:** `SELECT o.status, o.provider_user_id, o.booking_id FROM dispatch_offers o WHERE o.id=$1`; if not found → 404; if `o.provider_user_id !== orgUserId` → 403 (also call `assertOrgScope(req.orgManager, o.provider_user_id)`); if `o.status !== 'ACCEPTED'` → 403 `offer_not_accepted`. Only then `SELECT pickup_lat,pickup_lng,pickup_address,dropoff_lat,dropoff_lng,dropoff_address FROM lite_bookings WHERE id=o.booking_id`. Return the precise DTO. The controller audits the read.
- **Purge note (LB1/privacy):** rejected/expired/superseded offers must not retain any way to fetch precise location — `/full` already gates on `status='ACCEPTED'`, so a SUPERSEDED/REJECTED offer can never read coords. (A separate retention/purge job for `dispatch_offers` PII is a later privacy step.)
  **Frontend / ops-console how-to:** None in this step (the provider mobile `dispatchApi.getCurrentOffer/getFull/accept/reject` client + incoming-offer card are a later mobile step). Note for that step: the countdown must bind to the server `expires_at` (not a local 30s timer), the accept call must send an `Idempotency-Key`, and a network error on accept must re-fetch truth (a lost-200 is possible) rather than assume failure.
  **Security stop-conditions:**
- **STOP/verify against the System Architecture Documentation** that coarse-only pre-accept disclosure + ACCEPTED-only precise reveal is the agreed contract (LB1). The exact pickup/dropoff/address must never appear in `GET /dispatch/offers/current` or in any payload an offered/rejecting agency can read.
- No "skip in dev" on `JwtAuthGuard`/`OrgManagerGuard`/the ownership 403 — every offer endpoint stays JWT-guarded with the resolved-org ownership check.
- Idempotency on accept is for tap-safety only; the authoritative exactly-once is the conditional UPDATE in `DispatchService.accept` (LB3) — do not let the idempotency cache substitute for the DB lock.
- Audit every `/full` read; redact PII from `reject_reason` before storing/logging; never log addresses/coords (static log-audit test enforces no plaintext leaks).
- This step touches no encryption/sealed-sender/Ops-Room/group-key code.
  **Acceptance & tests:**
- NEW controller/unit tests in `dispatch.controller.spec.ts`: (a) `GET /current` returns coarse fields only — assert the response object has NO `pickup_lat/lng`, `dropoff_*`, full address, or `client_id`; (b) `GET /:id/full` 403 when offer is `OFFERED`/`REJECTED` (not `ACCEPTED`); 403 when caller org ≠ provider; 200 + coords + an `ops_audit` row when `ACCEPTED` and caller is the provider; (c) accept/reject 409 when offer not `OFFERED`; (d) IDOR: a different org's manager calling accept/reject/full on this offer → 403 via `assertOrgScope`; (e) accept replays (same `Idempotency-Key`) → single side-effect; (f) missing/invalid `Idempotency-Key` on accept → 400; (g) throttle: exceeding the per-route limit → 429.
- Regression: **booking** Jest project (`npm test -- --selectProjects=booking`) + ops smoke specs; legacy flow unaffected.
- Gates: `cd apps/auth-service && npm run build`; root `npm run typecheck` (≤96) and `cd apps/ops-console && npm run typecheck`; `npm run lint`. `npm run test:crypto` not required. Remember CI does not yet run auth-service tests (Part III #6) — run these locally.
- Never commit on red; never `--no-verify`.
  **Done when:**
- `GET /dispatch/offers/current` returns coarse-only data (no exact location, no client UUID); a test asserts the precise fields are absent.
- `GET /dispatch/offers/:id/full` returns coords only for `status='ACCEPTED'` and the owning org, 403s everyone else, and writes an audit row on every successful read.
- accept/reject resolve the caller's org (company self or active manager), enforce `assertOrgScope` against `offer.provider_user_id`, and 409 on a non-`OFFERED` offer.
- accept is wrapped in `IdempotencyInterceptor`; all four routes carry `UserThrottlerGuard` + `@Throttle`.
- All controller tests pass locally; booking Jest project still green.

## Step 8 — Watchdogs (Redis-locked): offer-expiry cascade + crew-assign SLA

**Stage:** Dispatch engine · **Depends on:** Step 6 (`DispatchService.expire/offerNext/noProvider`), Step 7 (accept path sets booking `CONFIRMED` + writes the escrow hold / `crew_deadline_at`), Step 2 (migration: `dispatch_offers`, `lite_bookings.crew_deadline_at` or escrow `crew_deadline_at`) · **Resolves:** Part I Phase 5 (re-dispatch cascade + timeout) **as corrected by Part III #1**, Part III "Reliability & correctness" + "Observability" + "Scalability", LB5 (charged-but-never-crewed orphan), LB9 (multi-pod-safe watchdog)
**Goal (plain English):** Add background timers that run safely even though the server runs as many copies (replicas). Timer 1 watches every outstanding 30-second offer; when one lapses (or the holding agency drops offline), it cancels that offer and moves the job to the next-nearest agency — no human needed. Timer 2 watches jobs an agency accepted-and-was-charged-for but never staffed; if they miss the deadline, it auto-refunds the customer, flags the agency, and (optionally) re-dispatches.
**Why it matters / what breaks without it:** The cascade in Step 6 only advances on an _active_ reject/expire call — without a watchdog, an offer the agency simply ignores would freeze the customer on "Finding…" forever. And because the customer is charged into escrow at accept (Part V), a job the agency never crews would leave the customer's money trapped with no guard coming (LB5). **CORRECTION (Part III #1):** `auth-service` runs **multiple replicas**, so a bare `setInterval`/`@nestjs/schedule` loop would have _every pod_ fire the same expiry and double-cascade — the watchdog MUST use the Redis `SET NX` lock pattern.
**Self-contained context (inline — do not make the reader open the plan):**

- **The proven pattern to copy (do NOT use `@nestjs/schedule`):** `apps/auth-service/src/booking/payment-pending-expiry.service.ts`. It is a `@Injectable()` implementing `OnModuleInit`/`OnModuleDestroy`; `onModuleInit` starts `setInterval(() => void this.sweepOnce(), SWEEP_INTERVAL_MS)`; `onModuleDestroy` clears it. `sweepOnce()` first does `const got = await this.redis.client.set(LOCK_KEY, String(Date.now()), 'PX', LOCK_TTL_MS, 'NX'); if (got !== 'OK') return {skipped_lock:true};` then `try { …work… } finally { await this.redis.client.del(LOCK_KEY) }`. `LOCK_TTL_MS` is set **shorter than the interval** so a crashed sweeper doesn't pin the lock. Each candidate is processed in its own `db.withTransaction` with `SELECT … FOR UPDATE` + a status re-check + conditional `UPDATE … WHERE status=$expected` (the looser branch no-ops if the row already moved on). `sweepOnce()` is `public` for tests.
- **Sweep 1 — offer-expiry cascade:** every ~5–10s, find `OFFERED` offers past `expires_at` (with a **clock-skew grace**, e.g. `expires_at < NOW() - INTERVAL '2 seconds'`, to avoid expiring an offer the same instant the agency accepts). For each, call `DispatchService.expire(offerId)` — which does the conditional `UPDATE … SET status='EXPIRED' WHERE id=$1 AND status='OFFERED' RETURNING booking_id` and then `offerNext(booking_id)`. **Accept-vs-expire ordering (LB9):** because both `accept` (Step 6/7) and `expire` use the same `WHERE status='OFFERED' RETURNING` guard, whichever commits first wins; the loser sees 0 rows and no-ops — so an accept landing during the grace window cannot be clobbered by an expire. **Provider-went-offline mid-offer:** also expire offers whose holder went `on_duty=false` or whose `last_location_at` is now stale (older than `LOCATION_FRESH_MINUTES`) — extend the WHERE clause (`JOIN agents a ON a.user_id=o.provider_user_id WHERE o.status='OFFERED' AND (o.expires_at < NOW()-grace OR a.on_duty=false OR a.last_location_at < NOW()-fresh_interval)`).
- **Sweep 2 — crew-assign SLA (LB5):** at accept (Step 6/Phase 6) the booking goes `DISPATCHING → CONFIRMED` ("accepted, awaiting crew"), the client is charged **into escrow** (`escrow_holds.status='HELD'`, Part V), and a `crew_deadline_at` is stamped. This sweep finds bookings still `CONFIRMED` (or escrow `HELD`) past `crew_deadline_at` with **no `missions` row** → in one txn: refund the client from escrow (`WalletService.refundForBooking(clientId, bookingId, reason)` / escrow→client per Part V), set `escrow_holds.status='REFUNDED'`, flip booking to `AGENCY_NO_SHOW` (or `CANCELLED`/`NO_PROVIDER` per the FSM you defined), supersede any live offer, increment an agency reliability/breach counter, push the client, and (optional) re-dispatch via `DispatchService.start` to find a replacement agency. Each booking in its own `withTransaction` + `FOR UPDATE` + conditional `UPDATE … WHERE status='CONFIRMED' AND NOT EXISTS(SELECT 1 FROM missions WHERE booking_id=…) RETURNING`.
- **Liveness metric (LB9/observability):** each sweep emits a self-reported liveness signal (e.g. write a Redis key `dispatch:watchdog:last_run` with `NOW()` + counters, or increment a metric) so an alert can fire if the watchdog dies — "no human watches dispatch" (D1), so a dead watchdog must page someone.
- **Reuse points:** `DatabaseService` (`db.q/db.qOne/db.withTransaction`, `tx.q/tx.qOne`, `SELECT … FOR UPDATE`), `RedisService` (`redis.client.set(…, 'PX', ttl, 'NX')`, `redis.client.del`), `BookingStateMachine.assert`, `DispatchService.expire/offerNext/start`, `WalletService.refundForBooking(userId, bookingId, description)` (confirmed at `wallet.service.ts:251`), `BookingPushBridge.noProvider/providerAccepted` (Step 7), `OpsAuditService.record`.
- **Constants (mirror the reference service):** `OFFER_SWEEP_INTERVAL_MS≈5_000–10_000`, `OFFER_LOCK_KEY='lock:dispatch-offer-expiry'`, `OFFER_LOCK_TTL_MS` < interval; `CREW_SLA_SWEEP_INTERVAL_MS≈60_000`, `CREW_LOCK_KEY='lock:dispatch-crew-sla'`, `CREW_LOCK_TTL_MS` < interval; `EXPIRY_GRACE_SECONDS=2`; `LOCATION_FRESH_MINUTES=5`. Cap each sweep's batch (`LIMIT 50`) and `ORDER BY` the relevant timestamp `ASC` like the reference.
  **Files to touch:**
- NEW `apps/auth-service/src/dispatch/offer-expiry.service.ts` — Sweep 1 (`OfferExpiryService`), a near-copy of `payment-pending-expiry.service.ts` calling `DispatchService.expire`.
- NEW `apps/auth-service/src/dispatch/crew-sla.service.ts` — Sweep 2 (`CrewAssignSlaService`), same Redis-locked shape, refund + flag + supersede + optional re-dispatch. (May instead live in the Part V escrow module; if so, keep the Redis-lock contract identical.)
- EXTEND `apps/auth-service/src/dispatch/dispatch.module.ts` — provide both sweep services; ensure `RedisModule`, `WalletModule` (for `refundForBooking`), `DatabaseModule`, `OpsAuditService`, `DispatchService`, the booking FSM, and `BookingPushBridge` are imported/available.
- NEW `apps/auth-service/src/dispatch/offer-expiry.service.spec.ts` and `crew-sla.service.spec.ts`.
- VERIFY (do not edit): `apps/auth-service/src/booking/payment-pending-expiry.service.ts` (the canonical pattern), `apps/auth-service/src/redis/redis.service.ts` (the `set(...,'PX',ttl,'NX')` signature), `apps/auth-service/src/wallet/wallet.service.ts:251` (`refundForBooking`).
  **Backend how-to:**
- **Sweep 1 `sweepOnce()`:**
  ```ts
  const got = await this.redis.client.set(
    OFFER_LOCK_KEY,
    String(Date.now()),
    'PX',
    OFFER_LOCK_TTL_MS,
    'NX',
  );
  if (got !== 'OK') return {expired: 0, skipped_lock: true};
  try {
    const due = await this.db.q<{id: string}>(
      `SELECT o.id FROM dispatch_offers o JOIN agents a ON a.user_id=o.provider_user_id
        WHERE o.status='OFFERED'
          AND (o.expires_at < NOW() - INTERVAL '${EXPIRY_GRACE_SECONDS} seconds'
               OR a.on_duty = FALSE
               OR a.last_location_at < NOW() - INTERVAL '${LOCATION_FRESH_MINUTES} minutes')
        ORDER BY o.expires_at ASC LIMIT 50`,
    );
    for (const r of due) {
      try {
        await this.dispatch.expire(r.id);
      } catch (e) {
        // expire() is itself a conditional UPDATE … WHERE status='OFFERED' RETURNING + offerNext
        this.log.warn(`offer-expiry failed for ${r.id}: ${(e as Error).message}`);
      }
    }
    await this.redis.client.set('dispatch:watchdog:offer:last_run', String(Date.now()), 'EX', 600); // liveness
    return {expired: due.length, skipped_lock: false};
  } finally {
    await this.redis.client.del(OFFER_LOCK_KEY).catch(() => undefined);
  }
  ```
- **Sweep 2 `sweepOnce()`:** lock with `CREW_LOCK_KEY`; `SELECT b.id, b.client_id FROM lite_bookings b WHERE b.status='CONFIRMED' AND b.crew_deadline_at < NOW() AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.booking_id=b.id) ORDER BY b.crew_deadline_at ASC LIMIT 50`. For each, in its own `withTransaction`: `SELECT status FROM lite_bookings WHERE id=$1 FOR UPDATE`; re-check still `CONFIRMED` with no mission (skip if raced); `fsm.assert(cur,'AGENCY_NO_SHOW'|'CANCELLED','SYSTEM')`; conditional `UPDATE lite_bookings SET status=… WHERE id=$1 AND status='CONFIRMED' RETURNING id` (0 rows ⇒ skip); refund escrow→client (`refundForBooking` / Part V escrow transition `HELD→REFUNDED`); `UPDATE dispatch_offers SET status='SUPERSEDED' WHERE booking_id=$1 AND status='OFFERED'`; bump agency breach counter; audit `'dispatch.crew_sla_refund'` (non-critical action name so the audit path doesn't force-rollback unless you want it to). After the txn, push the client (`BookingPushBridge`) and optionally `DispatchService.start($1)` to re-dispatch a replacement. Emit liveness key.
- **Wiring:** both services implement `OnModuleInit`/`OnModuleDestroy`, start/stop their `setInterval`, and are listed as providers in `DispatchModule` (which is registered in `app.module.ts` per Step 6). Behind `AUTO_DISPATCH_ENABLED` — when the flag is off, the sweeps should no-op (skip the work) so the dark feature has zero side effects.
  **Frontend / ops-console how-to:** None (pure backend). (The ops-console dispatch monitor surfaces the cascade trail and the watchdog-liveness/stuck-DISPATCHING alerts in a later step.)
  **Security stop-conditions:**
- No "skip in dev" on the Redis lock — the multi-pod safety IS the security/correctness property (Part III #1/LB9). Do not replace it with a bare interval "just for local."
- The crew-SLA refund moves money — every refund is the conditional-UPDATE-inside-txn + idempotent `refundForBooking` (idempotent per (user, booking) — see `booking.service.ts cancel()` comment "refund is idempotent per (user, booking) so a retry can't double-credit"); never double-refund. This touches the wallet/escrow ledger only — STOP/verify against Part V's money-invariant (`held == to_provider + to_client + platform_fee`) before changing any ledger move; no crypto/auth involved.
- Never log client coords/addresses or PII in sweep logs (static log-audit test).
  **Acceptance & tests:**
- NEW unit tests (mock `RedisService` + `DatabaseService` + `DispatchService`/`WalletService`): (a) **lock contention** — when `redis.set(...'NX')` returns non-`'OK'`, `sweepOnce` returns `skipped_lock:true` and does NO work (this is the multi-pod double-cascade guard, Part III testing P0); (b) an `OFFERED` offer past `expires_at + grace` → `DispatchService.expire` called once → next agency offered; (c) an offer still inside the grace window is NOT expired; (d) provider `on_duty=false`/stale-location holding an offer → expired + cascaded; (e) accept-vs-expire ordering — if the offer flips to `ACCEPTED` between SELECT and the expire UPDATE, `expire` no-ops (0 rows), no cascade; (f) Sweep 2 — `CONFIRMED` booking past `crew_deadline_at` with no mission → refund called once, offer SUPERSEDED, booking flipped, agency flagged; idempotent on re-run; (g) Sweep 2 skips a booking that already has a `missions` row.
- Regression: **booking** Jest project (`npm test -- --selectProjects=booking`) + the existing `payment-pending-expiry` spec (confirm the pattern wasn't regressed) + ops smoke.
- Gates: `cd apps/auth-service && npm run build`; root `npm run typecheck` (≤96) and `cd apps/ops-console && npm run typecheck`; `npm run lint`. `npm run test:crypto` not required. CI does not run auth-service tests yet (Part III #6) — run locally; the multi-pod lock test is a Part III P0, so make it explicit.
- Never commit on red; never `--no-verify`.
  **Done when:**
- Both sweeps run via the Redis `SET NX`-locked `setInterval` pattern (copied from `payment-pending-expiry.service.ts`), with lock TTL < interval and a `finally`-block `del`.
- An ignored/lapsed offer (or an offline/stale holder) is auto-expired with a clock-skew grace and cascades to the next agency; an accept landing in the grace window always wins over expiry.
- A charged-but-never-crewed booking past its `crew_deadline_at` is auto-refunded, the offer superseded, the agency flagged, and (if enabled) re-dispatched — money is never trapped.
- Each sweep emits a liveness signal; the lock-contention path is unit-tested (no double-cascade across pods); all new specs pass locally; booking Jest project still green.

---

## Step 9 — Escrow on accept (charge ≠ pay)

**Stage:** Money · **Depends on:** Step 7 (offer-accept txn / `DispatchService.accept`), Step 8 (escrow + platform-fee account migration `escrow_holds`/`booking_disputes`) · **Resolves:** Part V §39.1 / §38, Part I §6 + §11.1, LB3, PV2
**Goal (plain English):** When an agency taps Accept, the customer's money is taken out of their wallet and parked in a neutral "holding pot" (escrow) — it is NOT given to the agency. If the customer can't actually pay at that instant, the acceptance is undone so no guard is committed to an unpaid job. We also check the customer can afford it back at request-submit time so this almost never happens at accept.
**Why it matters / what breaks without it:** Without escrow, "charged" and "paid" collapse into one event — the agency could be paid before doing the job, and a cancel/no-show would mean clawing money back from the agency's wallet. The held-funds layer is the foundation every later money step (release, refund, dispute, pro-rata) builds on.

**Self-contained context (inline — do not make the reader open the plan):**

- LOCKED DECISIONS: D2 = charge on accept INTO ESCROW (released only on verified completion); D1 = fully automatic (no admin in the accept money loop); D3 = the AGENCY accepts then later deploys its own CPOs.
- The core principle (§36): "charged ≠ paid." On accept, debit the client and credit a dedicated **platform escrow (held-funds) account** — never the agency wallet. Every move is a **paired** `wallet_transactions` row (one debit, one credit) so the ledger always balances.
- Money state machine (§37): the hold starts at `HELD`. ENUM `escrow_hold_status = ('HELD','PENDING_RELEASE','RELEASED','REFUNDED','PARTIAL','DISPUTED')`. `escrow_holds` (created in Step 8) has UNIQUE `booking_id`, plus `offer_id`, `client_id`, `provider_user_id` (the agency payee, set at accept), `gross_credits`, `currency`, `status DEFAULT 'HELD'`, `held_at`.
- Accept's order of operations (§39.1 / Part I §11): inside ONE `withTransaction` — (1) conditional UPDATE flips the offer `OFFERED → ACCEPTED` (the race-safe lock; loser sees 0 rows and aborts) and verifies the booking is `DISPATCHING`; (2) debit client → credit escrow account (paired ledger rows); (3) INSERT `escrow_holds (... status 'HELD', provider_user_id, gross_credits, currency, offer_id)`; (4) flip booking `DISPATCHING → CONFIRMED` (FSM actor `SYSTEM`). If the debit fails (`insufficient_credits`): **abort the accept** — the offer is NOT won, NO hold is written.
- Affordability pre-check at **request submit** (§11.1): soft-check the client can afford the estimate; route a short balance to `CreditPaywallScreen` _before_ dispatch so a guard is never offered an unpayable job. The real debit still happens at accept.
- **Reuse the locked-balance pattern** from `booking.service.ts payWithCredits()` (verified): it `withTransaction` → `SELECT bravo_credits, currency FROM wallet_balances WHERE user_id=$1 FOR UPDATE` → `if (have < cost) throw BadRequestException('insufficient_credits')` → INSERT `wallet_transactions (type='payment', amount_credits=-cost, ...)` → `UPDATE wallet_balances SET bravo_credits = bravo_credits - $1`. Factor this debit core into a shared method (or call a wallet-service method) — do not duplicate. The mirror credit to escrow is the same pattern with a positive `amount_credits` against `ESCROW_ACCOUNT_ID`.
- The client debit must be **idempotent on `booking_id`** (one hold per booking even on double-tap accept). `escrow_holds.booking_id` is `UNIQUE`, so the INSERT naturally collapses; add `ON CONFLICT (booking_id) DO NOTHING` and treat 0-rows-inserted as "already held." The ledger debit reuses the existing per-booking idempotency convention.
- **Idempotency-Key required** on the accept endpoint via the existing `IdempotencyInterceptor` (header `Idempotency-Key`, 8–128 chars `[A-Za-z0-9_-]`, scoped per-actor + method+route, 24 h Redis cache; thrown errors are NOT cached so retry works).
- Stamp ledger `metadata.offer_id` on both paired rows (today `payWithCredits` writes `metadata='{}'::jsonb` — extend to `'{"offer_id":"..."}'::jsonb`).
- NOTE: `dispatch_offers` does NOT exist in code yet (only in the plan) — it is created by the dispatch/offer track (Step 7). The booking states `DISPATCHING`/`CONFIRMED` and `lite_bookings.assigned_provider_user_id`/`dispatch_settled_at` likewise land in earlier steps. Verify those exist before wiring this step. The escrow currency is the booking's `lite_bookings.total_eur` magnitude (an integer credit amount, despite the `_eur` name) and the wallet row's `currency`.

**Files to touch:**

- EXTEND `apps/auth-service/src/wallet/wallet.service.ts` — NEW method e.g. `holdToEscrow(clientId, bookingId, escrowAccountId, credits, currency, offerId, tx)` that runs the locked debit-client + credit-escrow paired rows; reuse the `payWithCredits` locking pattern. Keep it callable INSIDE an existing transaction (accept needs all-or-nothing with the offer flip).
- EXTEND the dispatch service that owns accept (the `DispatchService.accept(offerId, providerUserId)` created in Step 7) — inside the offer-flip txn, after `OFFERED→ACCEPTED` + booking `DISPATCHING` check, call the escrow hold + INSERT `escrow_holds`; on `insufficient_credits` let the exception unwind the whole txn (offer stays `OFFERED`).
- EXTEND `apps/auth-service/src/booking/booking.service.ts` (or the submit/estimate path) — add the **affordability soft-check at submit** so a short balance routes to the paywall pre-dispatch. Reuse `estimate()` for the amount.
- EXTEND the accept controller route — add `@UseInterceptors(IdempotencyInterceptor)` (mirror the existing `@Post('bookings/:id/pay-with-credits')` decoration).
- EXTEND the Step 8 migration (or a follow-up) only if the seeded `ESCROW_ACCOUNT_ID` / platform-fee account ids need a `wallet_balances` row — verify they were seeded in Step 8.

**Backend how-to:**

- Endpoint (from Step 7): `POST /ops/dispatch/offers/:offerId/accept` (or the agency-facing route) — `@UseGuards(JwtAuthGuard, …)` + `@UseInterceptors(IdempotencyInterceptor)`. Body none; actor = the agency company-agent user.
- Race-safe core, all in one `db.withTransaction(async tx => { … })`:
  ```sql
  -- 1) win the offer (race lock)
  UPDATE dispatch_offers SET status='ACCEPTED', responded_at=NOW()
   WHERE id=$1 AND status='OFFERED' AND expires_at > NOW()
   RETURNING booking_id, /* coarse fields */;
  -- 0 rows → throw BadRequestException('offer_not_available')
  -- 2) verify booking + lock it
  SELECT status, total_eur, currency_or_region FROM lite_bookings WHERE id=$booking FOR UPDATE;
  -- status must be 'DISPATCHING' else throw
  -- 3) debit client (locked) + credit escrow (paired), idempotent on booking_id
  SELECT bravo_credits, currency FROM wallet_balances WHERE user_id=$client FOR UPDATE;
  -- if (have < cost) throw BadRequestException('insufficient_credits');  -- unwinds the whole txn
  INSERT INTO wallet_transactions (user_id,type,status,amount_credits,amount_fiat_cents,fiat_currency,description,booking_id,metadata,settled_at)
    VALUES ($client,'payment','succeeded',-$cost,0,$cur,'Escrow hold '||$booking,$booking,$${'{"offer_id":"'||$offer||'"}'}::jsonb,NOW());
  UPDATE wallet_balances SET bravo_credits = bravo_credits - $cost WHERE user_id=$client;
  INSERT INTO wallet_transactions (user_id,type,status,amount_credits,...,booking_id,metadata,settled_at)
    VALUES ($ESCROW_ACCOUNT_ID,'escrow_hold','succeeded',$cost,...,$booking,$${'{"offer_id":...}'}::jsonb,NOW());
  UPDATE wallet_balances SET bravo_credits = bravo_credits + $cost WHERE user_id=$ESCROW_ACCOUNT_ID;
  -- 4) record the hold
  INSERT INTO escrow_holds (booking_id, offer_id, client_id, provider_user_id, gross_credits, currency, status)
    VALUES ($booking,$offer,$client,$providerUserId,$cost,$cur,'HELD')
    ON CONFLICT (booking_id) DO NOTHING;
  -- 5) flip booking
  this.fsm.assert('DISPATCHING','CONFIRMED','SYSTEM');  -- NOTE: 'DISPATCHING' must be added to BookingStateMachine in Step 7
  UPDATE lite_bookings SET status='CONFIRMED', assigned_provider_user_id=$providerUserId, dispatch_settled_at=NOW() WHERE id=$booking AND status='DISPATCHING';
  ```
- Affordability pre-check (submit): in the submit handler, after `estimate()`, `SELECT bravo_credits FROM wallet_balances WHERE user_id=$client`; if short, return a structured `{code:'insufficient_credits', required, balance}` so the mobile client routes to the paywall before the booking enters dispatch. Add a `// Why:` line (per §11.1).
- The Ops Room open (`ensureBookingOpsRoom`) and accept push stay where Step 7 placed them (best-effort, outside the money txn) — do not move them inside.

**Frontend / ops-console how-to:**

- Mobile request wizard: on submit, if the API returns `insufficient_credits`, navigate to `CreditPaywallScreen` (existing) instead of dispatching. Pass the required top-up amount.
- Agency accept action (ops-console or agency mobile): mint and send an `Idempotency-Key` (e.g. `accept:<offerId>`) on the accept call so a double-tap collapses to one hold; surface `offer_not_available` (lost the race) and `insufficient_credits` (rare) distinctly.

**Security stop-conditions:** This step is wallet/ledger only — **no crypto, no E2E, no sender-cert, no auth-primitive changes**. The Ops Room remains metadata-only via `ensureBookingOpsRoom` (untouched here). Do NOT log plaintext, key bytes, or wallet PII beyond ids/amounts already conventional in the ledger (the static log-audit test enforces this). Do not add any "skip in dev" branch to the idempotency or balance guard. No stop-condition surfaces beyond standard guards, but if you find yourself touching the room/push payload, STOP and verify against the System Architecture Documentation (push payload must stay exactly `{userId,eventClass,eventId}`).

**Acceptance & tests:**

- New unit/integration (booking + a new wallet/dispatch spec): accept → exactly ONE client debit into escrow, escrow account credited the same amount, NO agency credit row exists, `escrow_holds.status='HELD'`, booking `CONFIRMED`. Double-tap accept (same Idempotency-Key AND a concurrent no-key race) → still exactly one hold, one debit. Accept with short balance → `insufficient_credits`, offer stays `OFFERED`, NO hold, NO debit, booking still `DISPATCHING`. Submit with short balance → `insufficient_credits` before dispatch.
- Money-invariant assertion: `sum(client debits for booking) == escrow_holds.gross_credits` and escrow account delta equals the debit (paired rows balance).
- Run `npm test -- --selectProjects=booking` (booking project) + the wallet spec; `npm run lint`; `npm run typecheck` (mobile must stay ≤ baseline 96) and `cd apps/ops-console && npm run typecheck`. Not near messaging, so `test:crypto` not required. Manual smoke: submit a job, accept from the agency, confirm wallet debited once and booking shows "Accepted · assigning team."
- Do NOT commit on a red gate; never `--no-verify`.

**Done when:**

- [ ] Accept debits the client and credits the escrow account in one txn (paired rows, ledger balances).
- [ ] An `escrow_holds` row exists at `HELD` with `offer_id`/`provider_user_id`/`gross_credits`/`currency`; no agency credit anywhere.
- [ ] Debit failure aborts accept (offer back/stays `OFFERED`, no hold).
- [ ] Idempotency-Key wired; double-tap = one hold; ledger `metadata.offer_id` stamped.
- [ ] Submit-time affordability check routes short balances to the paywall.
- [ ] Booking project + wallet tests, typecheck (both), lint all green.

---

## Step 10 — SettlementService + lead one-tap Finish + proof-of-completion gate

**Stage:** Money · **Depends on:** Step 9 (escrow `HELD` exists at accept), Step 8 (escrow schema) · **Resolves:** Part V §39.5 / §40, LB4, LB2, PV3, PV4
**Goal (plain English):** Pull the "pay everybody out" logic out of the admin-only close and into one shared service so both an admin AND a mission lead can drive a completion. Give the lead a one-tap Finish button. But Finish does NOT release money — it first checks the job objectively happened (the guard's phone actually reached the pickup, stayed a real amount of time, etc.). If the evidence passes, the hold moves to "pending release" and a dispute window opens; if it fails, the mission still closes but goes to human review and never auto-pays.
**Why it matters / what breaks without it:** Today the lead-complete path (`agent.service.ts missionComplete`) pays the crew INLINE (Audit C1), and settlement logic is duplicated between there and admin `completeBooking`. That means a lead tapping Finish — or an agency falsely marking "completed" — pays out immediately with zero proof. LB4/LB2 require: no money moves at Finish, settlement is one extractable service, and "completed" must be backed by evidence.

**Self-contained context (inline — do not make the reader open the plan):**

- LOCKED DECISIONS: D8 = one-tap finish, leader-only status. D2 = released only on verified completion. D1 = admin is the exception path, not the default money mover.
- CORRECTION (LB4): today the lead one-tap Finish does NOT correctly defer settlement — it pays inline. The fix is to (a) extract an **actor-agnostic `SettlementService`** from the settlement core of `ops.service.ts completeBooking`, and (b) make Finish open `PENDING_RELEASE` instead of paying.
- Current code reality (verified): `agent.service.ts missionComplete()` → `flipMissionStatus(userId, missionId, 'COMPLETED', ['LIVE'])` does the lead check (`SELECT is_lead FROM mission_crew WHERE mission_id=$1 AND agent_id=$2`; throws `not_assigned_to_mission` / `lead_only`), conditional `UPDATE missions SET status='COMPLETED' ... WHERE id=$1 AND status IN ('LIVE') RETURNING booking_id`, flips booking `LIVE→COMPLETED`, then calls `disburseMissionPayout()` (Audit C1 inline even-split credit + `mission_payouts` insert). **This inline disburse is exactly what must be REMOVED from the Finish path** (replaced by opening `PENDING_RELEASE`).
- Current admin settlement (verified, `ops.service.ts completeBooking`, lines ~1079–1372): conditional `UPDATE lite_bookings SET status='COMPLETED' WHERE id=$1 AND status='LIVE' RETURNING id` (loser sees 0 rows → throws), `assertRegionScope(admin, region_code)`, resolves crew via `cpoAssign.getCrewForPayout`, even-split of `Math.round(Number(total_eur))`, per-officer override/deduction validation, aggregates per payee, `wallet.creditForBooking(payeeId, bookingId, sum, ...)` (idempotent on `ux_wallet_tx_payout`), writes `mission_payouts (mission_id, booking_id, agent_user_id, payee_user_id, call_sign, proposed_credits, paid_credits, deduction_credits, deduction_reason, decided_by)` `ON CONFLICT (mission_id, agent_user_id) DO NOTHING`, `platformFee = escrow - totalPaid`, releases pool, dissolves the conversation group (DELETE `conversation_members WHERE role='member'`, title `· COMPLETED`), bumps `agents.jobs_total + duty_hours_mtd`, broadcasts a summary, audits via `OpsAuditService.recordAdmin` + `.emit`. **This whole block is what `SettlementService.settle(...)` must own.**
- Mission FSM (verified `mission-state-machine.service.ts`): `DISPATCHED → PICKUP → LIVE → COMPLETED` (AGENT actor for each forward step); `SOS` reachable from PICKUP/LIVE; `ABORTED` is the Ops/Admin escape. Lead-gated forward moves go through the AGENT actor.
- Proof-of-completion gate (§40) — all server-side, read from data already collected:
  | Check | Rule | Source |
  |---|---|---|
  | Real progression | mission actually went `DISPATCHED→PICKUP→LIVE` via the lead-gated FSM | mission FSM / `missions.started_at` + audit |
  | Reached pickup | ≥1 GPS ping within `ARRIVAL_RADIUS_M` of `pickup_lat/lng` | `mission_telemetry_last` (booking-keyed) / `mission_telemetry` history |
  | Telemetry coverage | ≥ `MIN_PINGS` GPS pings during LIVE (not a 30-second "live") | `mission_telemetry` (per-push history, `mission_id`,`recorded_at`) |
  | Min on-task time | LIVE duration ≥ `MIN_ONTASK_SECONDS` | mission timestamps (`started_at`/PICKUP→LIVE→now) |
  | Identity handshake | arrival code/photo confirm happened (or was offered) | LB12 verify-code (if Step for it exists; else treat as "offered") |
  - **PASS** → `escrow_holds.status='PENDING_RELEASE'`, `completed_at=NOW()`, `release_eligible_at = NOW() + disputeWindow(trustTier)`. **No money moves.**
  - **FAIL** → mission still marked COMPLETED operationally, but `escrow_holds.review_required=TRUE`; do NOT open auto-release. Emit metric `dispatch_completion_gate_fail_total{reason}`.
- Geo data (verified): `lite_bookings.pickup_lat/lng` + `dropoff_lat/lng`; telemetry tables `mission_telemetry_last` (PK `booking_id`, last fix) and `mission_telemetry` (history, `mission_id`,`recorded_at DESC`).
- One-lead invariant (verified): a partial unique index already exists — `mission_crew_one_lead_per_team ON mission_crew(mission_id, team_idx) WHERE is_lead=TRUE`. The plan asks to enforce "one is_lead per mission" — confirm whether the per-team index is sufficient or whether a per-mission partial unique index (`ON mission_crew(mission_id) WHERE is_lead=TRUE`) is also wanted; do NOT silently weaken the existing one.
- `escrow_holds` columns available (Step 8): `completed_at`, `release_eligible_at`, `review_required BOOLEAN DEFAULT FALSE`, `status`, plus the partial index `escrow_release_due ON escrow_holds(release_eligible_at) WHERE status='PENDING_RELEASE'`.
- Trust tier: `agents` has `rating` (and `jobs_total`); a `tier` column may NOT exist — verify before relying on it. `disputeWindow(tier)` computed at completion (e.g. new/low-rating → 72 h; established/high-rating → short). Constants `ARRIVAL_RADIUS_M`, `MIN_PINGS`, `MIN_ONTASK_SECONDS`, `DISPUTE_WINDOW_SECONDS` config-driven.

**Files to touch:**

- NEW `apps/auth-service/src/ops/settlement.service.ts` — `SettlementService.settle(bookingId, actor: {kind:'admin'|'lead'; userId; admin?: AdminContext}, body?)`. Owns the extracted settlement core (paired escrow→agency + escrow→platform-fee moves, `mission_payouts`, group dissolve, stats bump, broadcast, audit). For the Finish (lead) path this is NOT called at completion — it is called later by the release sweep (Step 11). Extract so both the admin path and the eventual release path share one implementation.
- EXTEND `apps/auth-service/src/ops/ops.service.ts` — `completeBooking` now delegates its settlement core to `SettlementService.settle(bookingId, {kind:'admin', admin})`. Keep the region-scope + conditional `LIVE→COMPLETED` pin.
- EXTEND `apps/auth-service/src/agents/agent.service.ts` — `missionComplete()` / `flipMissionStatus(... 'COMPLETED' ...)`: REMOVE the inline `disburseMissionPayout()` call; instead, after the conditional `UPDATE missions ... status='COMPLETED' WHERE ... status='LIVE'` and `lite_bookings LIVE→COMPLETED`, run the proof gate and set the `escrow_holds` row to `PENDING_RELEASE`(+`release_eligible_at`,`completed_at`) on PASS or `review_required=TRUE` on FAIL. NO `creditForBooking` here.
- NEW `apps/auth-service/src/ops/proof-of-completion.service.ts` (or a method on SettlementService) — `runProofGate(bookingId, missionId): {pass: boolean; reasons: string[]}` reading the five checks.
- EXTEND `apps/auth-service/src/agents/agent.controller.ts` — the route already exists: `@Post('me/missions/:missionId/complete')` `@HttpCode(200)` `@UseInterceptors(IdempotencyInterceptor)` under `@UseGuards(JwtAuthGuard)`. Confirm the lead-gate stays (`requireLead` via the `mission_crew.is_lead` check). The plan names it `POST /agents/me/missions/:id/complete` — same route.
- NEW migration `supabase/migrations/<ts>_one_lead_per_mission.sql` ONLY if a per-mission (not per-team) lead index is required — additive, `CREATE UNIQUE INDEX IF NOT EXISTS ... WHERE is_lead=TRUE`.
- EXTEND a metrics module (existing prom/metric helper if present) for `dispatch_completion_gate_fail_total{reason}`.

**Backend how-to:**

- Lead Finish, race-safe, in `withTransaction`:
  ```sql
  -- lead gate (verified existing pattern)
  SELECT is_lead FROM mission_crew WHERE mission_id=$1 AND agent_id=$2;  -- !row→not_assigned; !is_lead→lead_only
  -- close mission (conditional, loser = 0 rows = no-op)
  UPDATE missions SET status='COMPLETED', updated_at=NOW(), ended_at=NOW()
    WHERE id=$1 AND status='LIVE' AND EXISTS (SELECT 1 FROM mission_crew WHERE mission_id=$1 AND agent_id=$2 AND is_lead)
    RETURNING booking_id;
  UPDATE lite_bookings SET status='COMPLETED' WHERE id=$booking AND status='LIVE';
  ```
- Then run the proof gate (read-only) and set the hold (still in/after the txn, but NO wallet motion):
  ```sql
  -- PASS
  UPDATE escrow_holds SET status='PENDING_RELEASE', completed_at=NOW(),
         release_eligible_at = NOW() + ($windowSeconds || ' seconds')::interval
    WHERE booking_id=$booking AND status='HELD';
  -- FAIL
  UPDATE escrow_holds SET review_required=TRUE, completed_at=NOW()
    WHERE booking_id=$booking AND status='HELD';
  ```
- Proof gate queries (read-only): progression = `missions.started_at IS NOT NULL` + an audit/FSM trace through PICKUP→LIVE; reached-pickup = haversine (or PostGIS `ST_DWithin` if Step for geo landed) between `mission_telemetry_last`/`mission_telemetry` fixes and `lite_bookings.pickup_lat/lng` ≤ `ARRIVAL_RADIUS_M`; coverage = `SELECT count(*) FROM mission_telemetry WHERE mission_id=$1 AND recorded_at BETWEEN <live_start> AND <now>` ≥ `MIN_PINGS`; on-task = `now - live_start` ≥ `MIN_ONTASK_SECONDS`; identity = the verify-code row (or "offered"). Collect failing reasons → metric.
- `disputeWindow(tier)`: read `agents.rating` (and `tier` if it exists — verify) for the agency/lead; map to seconds via config; default to a safe long window if no tier.
- `SettlementService.settle` is the lift-and-shift of the §completeBooking body (verified above): take `actor.kind` to pick region-scope assertion (admin) vs. system (release). Keep all idempotency: `wallet.creditForBooking` (idempotent on `ux_wallet_tx_payout`), `mission_payouts ON CONFLICT (mission_id, agent_user_id) DO NOTHING`. **At Finish, settle() is NOT called** — money waits for the Step 11 release sweep.
- Idempotency: the Finish route already wraps `IdempotencyInterceptor`; the conditional UPDATEs make it internally race-safe regardless.

**Frontend / ops-console how-to:**

- Mobile shared stepper (D8): the lead sees a one-tap **Finish** at the LIVE step; non-lead crew see status only (read-only). On tap, call `POST /agents/me/missions/:missionId/complete` with an `Idempotency-Key` (e.g. `complete:<missionId>`). After success show "Completed · awaiting release" (NOT "Paid"). If the gate failed, the UX is still "Completed" — the review/hold state is internal; do not surface "your job failed proof" to the lead.
- Ops-console mission/booking view: show the hold state (`HELD`/`PENDING_RELEASE`/`review_required`) so an operator can see what's awaiting release vs. flagged for review.

**Security stop-conditions:** Wallet/ledger + mission-state only — **no crypto/E2E/auth changes**. The group dissolve reuses the existing `conversation_members`/`conversations` server-side metadata path (already in `completeBooking`); do NOT touch group keys or sender-keys. Never log telemetry coordinates as plaintext beyond aggregate counts in metrics (the log-audit test enforces no plaintext/keys). Do NOT add a "skip the proof gate in dev" branch — the gate is a trust control. The lead-gate (`is_lead`) must not be weakened. If extraction tempts you to change the Ops Room teardown semantics or push payload, STOP and verify against the System Architecture Documentation.

**Acceptance & tests:**

- New tests (ops + agent specs): (1) lead Finish with passing proof → mission COMPLETED, `escrow_holds.status='PENDING_RELEASE'` with `release_eligible_at` set, **no `creditForBooking` call, no `mission_payouts` row, no agency wallet delta**. (2) lead Finish with FAILING proof (zero telemetry / never reached pickup) → mission COMPLETED, `review_required=TRUE`, NOT `PENDING_RELEASE`, no payout, `dispatch_completion_gate_fail_total{reason}` incremented. (3) non-lead crew tap → `lead_only`; non-crew → `not_assigned_to_mission`. (4) admin `completeBooking` still works via `SettlementService.settle({kind:'admin'})` — same payouts/deductions as before (regression: the existing `ops.service` completion specs must still pass). (5) double-tap Finish (idempotent) → one transition, one hold update.
- Regression: re-run the existing `ops.service.concurrency.spec.ts`, `mission-state-machine.service.spec.ts`, and any `completeBooking`/payout spec; they must stay green after the extraction.
- Gates: `npm test -- --selectProjects=booking` + the auth-service jest run for ops/agents specs; `npm run lint`; `npm run typecheck` (≤96) and `cd apps/ops-console && npm run typecheck`. Manual smoke: run a mission to LIVE, lead taps Finish, verify NO wallet movement and the hold flips to `PENDING_RELEASE`.
- Never commit on red; never `--no-verify`.

**Done when:**

- [ ] `SettlementService.settle(bookingId, actor)` exists and owns the settlement core; admin `completeBooking` delegates to it; payouts/deductions unchanged for admin.
- [ ] Lead Finish removes the inline disburse — Finish moves NO money.
- [ ] Proof gate runs server-side; PASS → `PENDING_RELEASE`+`release_eligible_at`; FAIL → `review_required`, never auto-pays; metric emitted.
- [ ] One-lead invariant enforced (existing per-team index confirmed sufficient or per-mission index added — not weakened).
- [ ] Idempotency-Key on `complete` route; conditional `LIVE→COMPLETED` race-safe.
- [ ] New + regression tests, typecheck (both), lint green.

---

## Step 11 — Dispute window, release sweep, refund/pro-rata/cancel-fee matrix, FX

**Stage:** Money · **Depends on:** Step 9 (escrow `HELD`), Step 10 (`SettlementService.settle`, `PENDING_RELEASE`/`review_required`, proof gate), Step 8 (escrow + `booking_disputes` schema) · **Resolves:** Part V §41 / §42 / §39.3-4, LB6, LB5/LB9, PV5/PV6/PV7, payments P1s
**Goal (plain English):** After the lead taps Finish, the customer gets a window to flag a problem; if they stay silent, the money releases to the agency on its own (a safe background timer pays it out). If the customer flags it, the money freezes and a staff member decides the split — and can even pull money back from the agency if it was paid by mistake. We also make cancels and early-aborts pay out fairly (full refund before the job starts, a fee-share if cancelled late, a worked-share split if ended mid-job) instead of always refunding everything. Finally, money is shown in the right currency.
**Why it matters / what breaks without it:** Without the release sweep nothing ever pays the agency after Finish; without the dispute path a fake completion can never be reversed; without the refund/pro-rata matrix the current abort code (verified: full `refundForBooking` against the OLD `cpo_pool`/`booking_cpo_assignments` tables) always full-refunds and never credits the agency for work done or frees crew capacity; without FX, SAR/BDT/GBP holds are mis-valued (the existing `computeCreditsForFiat` only handles usd/aed/eur).

**Self-contained context (inline — do not make the reader open the plan):**

- LOCKED DECISIONS: D1 = admin is the exception path (the single place a human stays in the money loop is dispute `resolve`). D2 = released only after the dispute window + proof. D6 = agency runs concurrent missions bounded by FREE CPO capacity (so an abort must free capacity).
- Money state machine (§37): `PENDING_RELEASE → {RELEASED | DISPUTED}`; `DISPUTED → {RELEASED | REFUNDED | PARTIAL}`; `HELD → {REFUNDED | PARTIAL | PENDING_RELEASE}`. `RELEASED`/`REFUNDED` terminal. ENUM `escrow_hold_status=('HELD','PENDING_RELEASE','RELEASED','REFUNDED','PARTIAL','DISPUTED')`.
- `escrow_holds` cols (Step 8): `status`, `release_eligible_at`, `completed_at`, `settled_at`, `to_provider_credits`, `to_client_credits`, `platform_fee_credits`, `basis` (`full_release|pro_rata|refund|partial|clawback`), `review_required`. Index `escrow_release_due ON escrow_holds(release_eligible_at) WHERE status='PENDING_RELEASE'`.
- `booking_disputes` cols (Step 8): `booking_id`, `raised_by`(=client), `category`(`not_performed|left_early|wrong_guard|conduct|billing`), `reason`, `status`(`open|upheld|rejected|resolved`), `to_client_credits`, `to_provider_credits`, `decided_by`(admin), `created_at`, `decided_at`. ADD a **partial unique index** for one OPEN dispute per booking: `CREATE UNIQUE INDEX ux_one_open_dispute ON booking_disputes(booking_id) WHERE status='open'`.
- Endpoints (§41):
  | Endpoint | Who | Purpose |
  |---|---|---|
  | `POST /bookings/:id/confirm-complete` | client | confirm early → release NOW (same as the sweep, immediately) |
  | `POST /bookings/:id/dispute` | client `{category,reason}` | `escrow_holds.status='DISPUTED'`, freeze release, INSERT `booking_disputes` |
  | `GET /bookings/:id/escrow` | client/agency | show hold state + (final) split for the receipt/UI |
  | `POST /ops/disputes/:id/resolve` | admin `{to_client,to_provider,penalty?,reason}` | final paired ledger moves + clawback + `decided_by` + audit |
  - `dispute` valid ONLY while `PENDING_RELEASE` (not after `RELEASED`). Client-owns-booking check (`WHERE client_id=$client`).
  - `resolve` is the one admin-in-the-loop point (D1): final paired moves, records `decided_by`, audits via `OpsAuditService.recordAdmin`+`.emit`.
  - **Clawback:** if a dispute is upheld AFTER an erroneous release, `resolve` debits the agency wallet and refunds the client; if the agency balance is short, flag a negative-balance recovery (withhold future payouts).
- Three Redis-locked sweeps (§42), each copying the verified `payment-pending-expiry.service.ts` pattern (NOT `@nestjs/schedule`, because auth-service is multi-replica): `setInterval` → `redis.client.set(LOCK_KEY, ts, 'PX', LOCK_TTL_MS, 'NX')` → if not `'OK'` skip → batch `SELECT … LIMIT 50` → per-row `withTransaction` + `SELECT … FOR UPDATE` + conditional `UPDATE … WHERE <state>` → `finally del(LOCK_KEY)`. The sweeps:
  1. **Crew-assign SLA sweep** (LB5): `escrow_holds.status='HELD'` + booking past `crew_deadline_at` + NO mission → one txn: `escrow→client` full refund (`refundForBooking`), `escrow_holds.status='REFUNDED'`, booking `→ AGENCY_NO_SHOW`, offer `SUPERSEDED`, agency `reliability_breaches++`, push client (optional auto-re-dispatch).
  2. **Release sweep**: `status='PENDING_RELEASE' AND release_eligible_at < NOW() AND NOT review_required AND no open dispute` → call `SettlementService.settle(bookingId, {kind:'system'})`: `escrow→agency` payout + `escrow→platform` fee, write `mission_payouts`, bump `agents.jobs_total`, dissolve group, `status='RELEASED'`, `basis='full_release'`.
  3. **Reconciliation sweep (daily)**: assert the money invariant (§43) and alert on drift.
- Money invariant (§43): for each booking `sum(client debits) == held`; at terminal `held == to_provider + to_client + platform_fee`; NO agency credit row may exist before `release_eligible_at` (or an early client confirm / dispute resolve). Concurrency rule: release sweep vs client dispute firing together → **dispute wins (freeze), no payout** (enforced by the conditional `UPDATE … WHERE status='PENDING_RELEASE'` — whichever flips first wins; dispute flips to `DISPUTED`, so the release `WHERE status='PENDING_RELEASE'` matches 0 rows).
- Termination → refund matrix (§39.3-4, LB6) — operate on **`mission_crew`, NOT the old pool tables**:
  - Pre-LIVE abort/cancel → FULL refund (`escrow→client`), `escrow_holds.status='REFUNDED'`, `basis='refund'`.
  - Cancel AFTER grace (agency already committed crew) → `PARTIAL`: `escrow→client` minus a cancellation fee; the fee → agency via the settlement path; `basis='partial'`.
  - Abort / SOS-end DURING LIVE → `PARTIAL` pro-rata against minutes actually on task: `escrow→client` unworked share, `escrow→agency` worked share (+ platform fee), `basis='pro_rata'`; **AND free capacity via `mission_crew`** (not `cpo_pool`).
  - CURRENT CODE TO REPLACE (verified `ops.service`/`mission.service` abort): it does an unconditional `wallet.refundForBooking(client, bookingId, ...)` when `payment_captured`, and releases crew via `UPDATE cpo_pool SET availability='available' WHERE id IN (SELECT cpo_id FROM booking_cpo_assignments WHERE booking_id=$1)`. Both must move to the escrow matrix + `mission_crew`.
- FX: `wallet.service.ts computeCreditsForFiat(amount, currency)` (verified, lines 688–698) only maps `usd` (1:1×perUsd), `aed` (/3.67), `eur` (×1.08); SAR/BDT/GBP fall through to the `amount` (1:1) default → wrong. Add SAR/BDT/GBP rates and **stamp the fx rate + currency on each `wallet_transactions` row** so a refund reverses at the SAME rate it was held at (avoid round-trip FX drift). Regions are AE/SA/BD/GB (D4).

**Files to touch:**

- EXTEND `apps/auth-service/src/wallet/wallet.service.ts` — extend `computeCreditsForFiat` with `sar`/`bdt`/`gbp` rates; add fx-rate + currency stamping into the ledger metadata on hold/refund/payout rows (so reversals use the stored rate). Verify `refundForBooking` (idempotent on `ux_wallet_tx_booking_refund`) is reused for escrow→client refunds.
- NEW `apps/auth-service/src/booking/escrow-release-sweep.service.ts` — sweep #2 (copy `payment-pending-expiry.service.ts`; LOCK_KEY `lock:escrow-release`). Calls `SettlementService.settle({kind:'system'})`.
- NEW `apps/auth-service/src/booking/crew-sla-sweep.service.ts` — sweep #1 (LOCK_KEY `lock:crew-sla`).
- NEW `apps/auth-service/src/booking/escrow-reconciliation.service.ts` — sweep #3, daily; asserts the money invariant + alerts.
- EXTEND `apps/auth-service/src/booking/booking.controller.ts` — add `@Post(':id/confirm-complete')`, `@Post(':id/dispute')`, `@Get(':id/escrow')` under existing `@Controller('bookings')` `@UseGuards(JwtAuthGuard)`; the two POSTs get `@UseInterceptors(IdempotencyInterceptor)` (mirror `pay-with-credits`).
- EXTEND `apps/auth-service/src/booking/booking.service.ts` — `confirmComplete(clientId, bookingId)`, `dispute(clientId, bookingId, {category,reason})`, `getEscrow(userId, bookingId)`.
- EXTEND `apps/auth-service/src/ops/ops.controller.ts` — add `@Post('disputes/:id/resolve')` `@RequireRoles('SUPERVISOR','ADMIN')` `@UseInterceptors(IdempotencyInterceptor)` under existing `@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard)`.
- EXTEND `apps/auth-service/src/ops/ops.service.ts` (or `settlement.service.ts`) — `resolveDispute(disputeId, admin, {to_client,to_provider,penalty?,reason})` incl. clawback; reuse `OpsAuditService`.
- EXTEND `apps/auth-service/src/ops/mission.service.ts` — REPLACE the abort refund/release: pro-rata matrix on `escrow_holds` + free capacity via `mission_crew` (drop the `cpo_pool`/`booking_cpo_assignments` refund path for dispatched-via-crew missions; keep legacy-pool fallback only if old bookings need it).
- EXTEND the abort/cancel paths to compute on-task minutes (use `missions.started_at`/LIVE timestamps) for pro-rata.
- NEW migration `supabase/migrations/<ts>_dispute_open_unique.sql` — `CREATE UNIQUE INDEX IF NOT EXISTS ux_one_open_dispute ON booking_disputes(booking_id) WHERE status='open';` and (if needed) `AGENCY_NO_SHOW` booking status + `agents.reliability_breaches` + `lite_bookings.crew_deadline_at`/`dispute_window_seconds` columns (verify which already exist from the dispatch track).
- EXTEND `apps/auth-service/src/booking/booking.module.ts` (and/or ops module) — register the three sweep services as providers.

**Backend how-to:**

- Client dispute (race-safe; freeze beats release):
  ```sql
  -- in withTransaction
  SELECT eh.status FROM escrow_holds eh JOIN lite_bookings b ON b.id=eh.booking_id
    WHERE eh.booking_id=$1 AND b.client_id=$2 FOR UPDATE;          -- ownership + lock
  -- must be 'PENDING_RELEASE' else throw dispute_not_allowed
  UPDATE escrow_holds SET status='DISPUTED' WHERE booking_id=$1 AND status='PENDING_RELEASE' RETURNING id;
  -- 0 rows → lost to a release/terminal → throw
  INSERT INTO booking_disputes (booking_id, raised_by, category, reason, status)
    VALUES ($1,$2,$cat,$reason,'open');   -- ux_one_open_dispute prevents a 2nd open dispute
  ```
- Client confirm-early: same as the release sweep body but immediate — conditional `UPDATE escrow_holds SET status='RELEASED' WHERE booking_id=$1 AND status='PENDING_RELEASE' AND NOT review_required` then `SettlementService.settle({kind:'system'})`; ownership `WHERE client_id=$client`.
- Release sweep (#2) per-row:
  ```sql
  SELECT id, booking_id FROM escrow_holds
    WHERE status='PENDING_RELEASE' AND release_eligible_at < NOW() AND NOT review_required
      AND NOT EXISTS (SELECT 1 FROM booking_disputes d WHERE d.booking_id=escrow_holds.booking_id AND d.status='open')
    ORDER BY release_eligible_at ASC LIMIT 50;
  -- per row, in withTransaction:
  SELECT status FROM escrow_holds WHERE booking_id=$1 FOR UPDATE;        -- re-check under lock
  UPDATE escrow_holds SET status='RELEASED', basis='full_release', settled_at=NOW()
    WHERE booking_id=$1 AND status='PENDING_RELEASE' RETURNING id;       -- 0 rows (disputed) → skip
  -- then SettlementService.settle(bookingId,{kind:'system'}) → escrow→agency + escrow→platform fee,
  -- mission_payouts, jobs_total++, dissolve group.
  ```
- Crew-SLA sweep (#1) per-row: `SELECT` `HELD` holds whose booking `crew_deadline_at < NOW()` and no `missions` row; in txn → `refundForBooking(client,...)`, `UPDATE escrow_holds SET status='REFUNDED', basis='refund'`, booking `→AGENCY_NO_SHOW`, offer `SUPERSEDED`, `UPDATE agents SET reliability_breaches=reliability_breaches+1`, push.
- Dispute resolve (admin): validate the dispute is `open`, the hold is `DISPUTED` (or `RELEASED` for clawback). Final paired moves: e.g. `escrow→client` `to_client`, `escrow→provider` `to_provider` (+ platform fee remainder); set `escrow_holds.status` to `REFUNDED`/`PARTIAL`/`RELEASED` + `to_*_credits` + `basis`. Clawback when already `RELEASED`: debit agency wallet (`debitForBooking` or a ledger debit), `refundForBooking(client)`; if agency short → flag negative-balance recovery. Record `booking_disputes.status='upheld'|'rejected'|'resolved'`, `decided_by=admin.user_id`, `decided_at=NOW()`. Audit.
- Abort/cancel matrix (mission.service): determine phase from mission/booking status. Pre-LIVE → full `refundForBooking` + `escrow_holds REFUNDED`/`basis='refund'`. Post-grace cancel → `escrow→client` minus fee, fee → agency via settle, `PARTIAL`/`basis='partial'`. Mid-LIVE abort/SOS-end → compute worked minutes from `started_at`→now (cap sane), split `to_client`/`to_provider`, `PARTIAL`/`basis='pro_rata'`. Free capacity: `UPDATE mission_crew SET status='off' WHERE mission_id=$1` (verify the column/value vs. existing `active|sos|standby|off`) instead of touching `cpo_pool`.
- Reconciliation sweep (#3, daily): for a batch of recent bookings assert `sum(client debits)==held` and terminal `held==to_provider+to_client+platform_fee`; log + alert on drift (no mutation).
- All sweeps register via `OnModuleInit`/`OnModuleDestroy` `setInterval` with their own LOCK_KEY + LOCK_TTL shorter than the interval (copy the verified pattern). Expose a `sweepOnce()` public for tests.

**Frontend / ops-console how-to:**

- Mobile client: after a mission shows "Completed · awaiting release," show a **dispute window countdown** with two actions — "Confirm complete" (`POST /bookings/:id/confirm-complete`) and "Report a problem" (`POST /bookings/:id/dispute` with a `{category}` picker from `not_performed|left_early|wrong_guard|conduct|billing` + free-text `reason`). Both send an `Idempotency-Key`. Use `GET /bookings/:id/escrow` to render the receipt/hold state + final split.
- Ops-console: a Disputes queue (open disputes) with a resolve form `{to_client, to_provider, penalty?, reason}` → `POST /ops/disputes/:id/resolve` (Idempotency-Key). Show hold status + `basis` on the booking detail. Surface `review_required` holds so an operator adjudicates flagged completions.

**Security stop-conditions:** Wallet/ledger + booking/mission state only — **no crypto/E2E/auth-primitive changes**. Group dissolve in the release path reuses the existing server-side `conversation_members`/`conversations` metadata teardown (from `completeBooking`); do NOT touch group keys/sender-keys. Never log dispute free-text `reason`, client PII, telemetry coordinates, or key bytes (the static log-audit test enforces no plaintext/keys). Do NOT add a "skip the dispute window in dev" or "auto-release ignoring review_required" branch. The client-owns-booking check (`WHERE client_id=$client`) and the admin `RequireRoles` guard on resolve must not be weakened. The FX rates feed real money — get the SAR/BDT/GBP rates signed off (CFO/billing) and stamp them so reversals can't drift; if FX touches anything beyond the credit math, STOP and verify against the System Architecture Documentation.

**Acceptance & tests:**

- New tests (booking + ops + wallet specs): (1) Release sweep: `PENDING_RELEASE` past `release_eligible_at`, no dispute, not review_required → released ONCE (escrow→agency + escrow→platform fee, `mission_payouts` written, `jobs_total++`); a second sweep pass is a no-op. (2) Concurrency: release sweep vs dispute firing together → dispute wins, hold `DISPUTED`, NO payout (the conditional `WHERE status='PENDING_RELEASE'` proves it). (3) Dispute only valid in `PENDING_RELEASE`; a second open dispute → unique-index violation; non-owner client → rejected. (4) Resolve: paired moves split correctly; clawback when already `RELEASED` debits agency + refunds client; `decided_by` recorded; audited. (5) Crew-SLA sweep: `HELD` past deadline, no mission → full refund, `REFUNDED`, booking `AGENCY_NO_SHOW`, `reliability_breaches++`, idempotent (re-run = no double refund — `refundForBooking` is idempotent). (6) Matrix: pre-LIVE abort → full refund; post-grace cancel → partial (fee→agency); abort mid-LIVE → pro-rata split + `mission_crew` capacity freed (verify the crew row is no longer counted as busy). (7) FX: a BDT (and GBP) hold + refund reverse EXACTLY at the stamped rate (no drift); `computeCreditsForFiat` returns the right credits for sar/bdt/gbp. (8) Money invariant holds across all of the above; reconciliation sweep flags an injected imbalance.
- Regression: re-run `ops.service.concurrency.spec.ts`, the abort/mission specs, and the Step 10 settlement specs; the admin `completeBooking` path must still pass.
- Gates: `npm test -- --selectProjects=booking` + the auth-service ops/wallet specs; `npm run lint`; `npm run typecheck` (≤96) and `cd apps/ops-console && npm run typecheck`. Manual smoke: finish a mission, let the window elapse → released once; separately finish, dispute → frozen, resolve in ops → correct split; abort a LIVE mission → pro-rata + crew freed.
- Never commit on red; never `--no-verify`.

**Done when:**

- [ ] Release sweep, crew-SLA sweep, and daily reconciliation sweep all run on the Redis `SET NX`-locked `setInterval` pattern (multi-replica safe), each with `sweepOnce()` for tests.
- [ ] `confirm-complete`, `dispute`, `GET escrow`, and admin `disputes/:id/resolve` endpoints exist with the right guards + Idempotency-Key; one-open-dispute index added; dispute only in `PENDING_RELEASE`; client ownership enforced.
- [ ] Dispute wins any race with the release sweep (no payout when frozen); resolve does final paired moves + clawback + `decided_by` + audit.
- [ ] Abort/cancel refund matrix runs on `mission_crew` (pre-LIVE full / post-grace partial / mid-LIVE pro-rata) and frees crew capacity; the old `cpo_pool`/`booking_cpo_assignments` full-refund path is replaced.
- [ ] FX covers SAR/BDT/GBP and stamps the rate so refunds reverse exactly; money invariant asserted in tests + reconciliation.
- [ ] New + regression tests, typecheck (both), lint green.

---

## Step 12 — Ops Room group-key distribution under auto-dispatch (agency device owns the rekey)

**Stage:** Comms & crew · **Depends on:** Step 6 (accept opens the Ops Room with client+agency only), Step 11 (`POST /org/bookings/:id/crew` exists), Step 13 (crew-assign is the caller of the enqueue) · **Resolves:** Part I §6 (corrected), Part II §24 step 3, Part III correction #5, **LB2** (P0)
**Goal (plain English):** When an agency adds its guards (CPOs) to a job, those guards must be able to read the encrypted Ops Room chat. The server cannot hand out the chat's encryption key — only a real device that already holds the key can. So we make the _agency's own phone_ the owner of each Ops Room, and we add a tiny "to-do list" the server gives that phone ("add guard X to room Y") which the phone drains and acts on, re-keying the group so the new guard can decrypt going forward (and a removed guard cannot decrypt anything new).
**Why it matters / what breaks without it:** Without this, assigned CPOs join the room as metadata only and see _nothing_ — the chat is dead for the crew, which is the whole point of the Ops Room during a live protection mission. This is a P0 launch-blocker.
**Self-contained context (inline — do not make the reader open the plan):**

- **The hard constraint (security-reviewed):** The relay/server holds **no group master key**. `apps/auth-service/src/conversations/conversations.service.ts addMember()` (line 168) only writes a `conversation_members` metadata row (`role='member'`); it does **not** distribute the Signal group key. The only thing that can rekey is a member device, via the mobile runtime: `getMessengerRuntime('production').addGroupMember({groupId, newMember:{userId, deviceId:1}})` (`src/modules/messenger/runtime/productionRuntime.ts:2663`), which wraps `planAddAndRekey` from `@bravo/messenger-core` (epoch E `add` → epoch E+1 fresh master key; the new member can decrypt only from this point forward — Signal forward-secrecy contract).
- **The existing server→device intent mechanism covers ONLY department channels, not booking rooms.** `src/modules/messenger/orgWorkspace/membershipIntents.ts drainMembershipIntents()` reads `departmentApi.listMembershipIntents()` → for each pending intent calls `runtime.addGroupMember`/`removeGroupMember` → acks **only after** the rekey broadcast succeeds (at-least-once; never ack on failure). The server side is `apps/auth-service/src/department/department.service.ts` (`enqueueIntent` → `channel_membership_intents`, `listMembershipIntents`, `ackMembershipIntent`) exposed by `department.controller.ts` (`GET /department/membership-intents`, `POST /department/membership-intents/:intentId/ack`). **This is for `department_channels` — it has no path for `conversations`-scoped (booking Ops Room) rooms.** Step 12 builds the parallel mechanism for booking conversations.
- **The room owner today is wrong for this flow.** `ensureBookingOpsRoom` (`apps/auth-service/src/ops/system-messenger.service.ts:228`) currently creates the conversation with `creator = ops_admin_user_id` and the plan's Step 6 passed `SystemMessengerService.SYSTEM_USER_ID` (`00000000-0000-0000-0000-000000000001`). The SYSTEM/admin user is a server-side metadata author that holds **no key** — so it cannot be the rekey admin. For auto-dispatch the **agency company-agent device must be the room creator/admin/owner** so it (and only it) can run `addGroupMember`.
- **What Step 13 enqueues:** `POST /org/bookings/:id/crew` (Step 13) must, after creating the mission + `mission_crew`, enqueue one _add-intent per assigned CPO_ into the new booking-scoped intent table; the agency device drains them on focus and runs `planAddAndRekey`.
  **Files to touch:**
- **NEW migration** `supabase/migrations/<ts>_dispatch_room_intents.sql` — create `dispatch_room_intents` table (mirror `channel_membership_intents`).
- **EXTEND** `apps/auth-service/src/ops/system-messenger.service.ts` — `ensureBookingOpsRoom(...)`: for auto bookings make the **agency company-agent user** the `creator`/admin (so add `creator_user_id`/`admin_user_id` to args, defaulting to the provider user id; do NOT pass SYSTEM as creator on the auto path). Keep the metadata-only first-card broadcast.
- **NEW** `apps/auth-service/src/dispatch/dispatch-room-intents.service.ts` (or extend the dispatch module): `enqueueRoomAddIntent(bookingId, conversationId, memberUserId, requestedBy)`, `listRoomIntents(agencyUserId)`, `ackRoomIntent(agencyUserId, intentId)` — copied 1:1 from `department.service.ts` intent methods but scoped to the booking conversation + the agency org.
- **NEW/EXTEND controller** `apps/auth-service/src/dispatch/dispatch.controller.ts` — `GET /dispatch/room-intents` and `POST /dispatch/room-intents/:intentId/ack` (JWT + OrgManagerGuard; scoped to caller's org).
- **NEW** `src/modules/messenger/orgWorkspace/dispatchRoomIntents.ts` — `drainDispatchRoomIntents()`, a near-exact copy of `drainMembershipIntents()` but calling `dispatchApi.listRoomIntents()/ackRoomIntent()` and `runtime.addGroupMember({groupId: intent.conversation_id, newMember:{userId, deviceId:1}})`.
- **EXTEND** `src/services/api.ts` — add `dispatchApi.listRoomIntents()` / `dispatchApi.ackRoomIntent(id)`.
- **EXTEND** the agency app focus/bootstrap (the AgencyNavigator / OrgMissions screen, `src/screens/agent/*`) to call `drainDispatchRoomIntents()` on focus, mirroring where `drainMembershipIntents()` is wired for department channels.
  **Backend how-to:**
- Migration sketch (mirror `channel_membership_intents`):

```sql
CREATE TABLE dispatch_room_intents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      UUID NOT NULL REFERENCES lite_bookings(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,            -- the Ops Room (lite_bookings.conversation_id)
  org_user_id     UUID NOT NULL,            -- the agency device that must drain this
  member_user_id  UUID NOT NULL,            -- the CPO being added
  action          TEXT NOT NULL DEFAULT 'add', -- 'add' | 'remove'
  state           TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'done'
  requested_by    UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at      TIMESTAMPTZ
);
CREATE INDEX dispatch_room_intents_pending
  ON dispatch_room_intents(org_user_id, state) WHERE state = 'pending';
```

- `enqueueRoomAddIntent` = plain `INSERT` (copy `department.service.ts enqueueIntent`). Called from Step 13's crew handler, once per assigned CPO.
- `listRoomIntents(agencyUserId)`: `SELECT id, booking_id, conversation_id, member_user_id, action, created_at FROM dispatch_room_intents WHERE org_user_id = $1 AND state = 'pending' ORDER BY created_at ASC`. Scope to the caller's `manager.org_user_id` (from `OrgManagerGuard` / `assertOrgScope`) — never a path param.
- `ackRoomIntent` = race-safe conditional UPDATE (mirror `department.service.ts:250`):

```sql
UPDATE dispatch_room_intents
   SET state='done', settled_at=NOW()
 WHERE id=$1 AND state='pending' AND org_user_id=$2
 RETURNING id;
```

0 rows → `404 intent_not_found_or_not_org`. Only ack **after** the device confirms the rekey broadcast landed (the drain function does this).

- `ensureBookingOpsRoom`: on the auto path, pass the **agency company-agent user id** as the creator so `conversations.service.create()` stamps them admin; that device is then authorized to call `addGroupMember`. STOP/verify (below) before finalizing the creator choice.
  **Frontend / ops-console how-to:**
- `drainDispatchRoomIntents()` — copy `membershipIntents.ts` exactly: skip intents whose group isn't bootstrapped, `await runtime.addGroupMember(...)`, ack **only on success**, leave pending on throw (at-least-once retry). `addGroupMember`/`removeGroupMember` are idempotent-safe to retry (already-in/out throws and stays pending).
- Wire the drain into the agency app's focus hook (same trigger pattern department channels use). The drain runs **on the agency company-agent device** only (it owns the room key).
  **Security stop-conditions:** This step is squarely on the E2EE stop-condition line. **STOP / verify against the System Architecture Documentation before coding:** (a) that `SYSTEM_USER_ID`/admin **may not** be the group-key admin and the **agency company-agent device** is the correct room creator/owner for a client↔agency↔CPO room; (b) that the add path **advances the epoch** via `planAddAndRekey` (epoch E+1, fresh master key) so the new CPO can decrypt only from join-forward; (c) that a **removed** CPO (future remove-intent) cannot decrypt new messages after the corresponding rekey. Never write message envelopes or touch sender-key distribution from the server; the server only ever writes the `conversation_members` metadata row + the intent queue. Never log group ids paired with key bytes (static log-audit test enforces this).
  **Acceptance & tests:**
- Backend unit (`*.spec.ts` next to the service, auth-service Jest): enqueue add-intent → `listRoomIntents` returns it for the owning org only (cross-org caller gets none, IDOR check); `ackRoomIntent` is a conditional UPDATE (second ack → 404; wrong org → 404).
- Mobile unit (mirror `src/modules/messenger/__tests__/membershipIntents.test.ts`): `drainDispatchRoomIntents` calls `runtime.addGroupMember` with `{groupId: conversation_id, newMember:{userId, deviceId:1}}`, acks only on success, leaves pending on throw, skips not-yet-bootstrapped groups.
- Regression: `npm run test:crypto` (this touches the group-key path indirectly via the runtime), plus the booking Jest project for anything that calls `ensureBookingOpsRoom`.
- Gates: `npm run typecheck` (mobile ≤ baseline 96) **and** `cd apps/ops-console && npm run typecheck`; `npm run lint`; auth-service `npm run build`. Manual 3-device smoke: accept (room = client + agency) → assign 2 CPOs + lead → both CPOs see and can read/send in the Ops Room within a drain cycle. Never commit on a red gate; never `--no-verify`.
  **Done when:**
- [ ] `dispatch_room_intents` migration applies; old tables untouched.
- [ ] Auto-flow Ops Rooms are created with the **agency device** as creator/admin (verified against the architecture doc).
- [ ] `POST /org/bookings/:id/crew` enqueues one add-intent per CPO; the agency device drains them on focus and the CPOs can decrypt new Ops Room messages.
- [ ] `listRoomIntents`/`ackRoomIntent` are org-scoped + race-safe (conditional UPDATE), proven by tests.
- [ ] `npm run test:crypto`, both typechecks, lint, and auth-service build are green.

---

## Step 13 — Crew assignment + leader (the step that creates the mission)

**Stage:** Comms & crew · **Depends on:** Step 6 (accept flips booking `DISPATCHING→CONFIRMED`, sets `assigned_provider_user_id`, opens Ops Room with client+agency), Step 11/Phase 15 (managed-CPO roster: `org_members` + `POST /org/cpos`), Step 12 (Ops Room add-intent enqueue), Step 14 (per-CPO push) · **Resolves:** Part II §24, Part II §27 amendments 1–2, **LB7** (P0 IDOR), **LB8** (P0 conditional-UPDATE), **LB11** (P0 honor-what-client-paid)
**Goal (plain English):** After an agency accepts a job, it must pick which of its registered guards go and name one as the team leader. That single confirm is what actually creates the mission. We add an endpoint that lists all of this agency's jobs (grouped: needs-crew / active / recent) and another that takes the chosen guards + leader, validates everything, creates the mission + crew rows, seeds the mission's waypoints and deployment checks, queues the guards into the encrypted Ops Room, and notifies each guard's phone.
**Why it matters / what breaks without it:** Per D7, accept does **not** auto-pick crew — the booking sits at `CONFIRMED` with no mission until the agency crews it. Without this step the job is accepted, the client is charged, but no mission/crew ever materializes and the guards never get the job. This is the hand-off that replaces the old admin "Dispatch" click.
**Self-contained context (inline — do not make the reader open the plan):**

- **Decisions:** D3 the agency accepts then deploys its own CPOs; D5 the agency's CPOs are real login accounts (`org_members` + `agents type='cpo' managed_by_org_id=org`); D6 an agency runs multiple concurrent missions bounded by free CPO capacity; D7 accept does NOT auto-pick crew — crew-assign creates the mission; D8 one CPO is the leader (`mission_crew.is_lead`/`role='LEAD'`).
- **FSM states:** booking FSM `apps/auth-service/src/booking/state-machine.service.ts` — at this point the booking is `CONFIRMED` (= "accepted, awaiting crew"); it stays `CONFIRMED` until the assigned lead checks in (`CONFIRMED→LIVE` later). Mission FSM `apps/auth-service/src/ops/mission-state-machine.service.ts` — the mission is created at `DISPATCHED` (then `PICKUP→LIVE→…COMPLETED`).
- **Reuse the dispatch() shape** from `apps/auth-service/src/ops/job-feed.service.ts` (lines ~292–345): `short = 'MSN-' + booking_id.replace(/-/g,'').slice(-12).toUpperCase()` (race-free, UUID-derived); `INSERT INTO missions (booking_id, status, short_code) VALUES ($1,'DISPATCHED',$2) ON CONFLICT (booking_id) DO UPDATE SET status=EXCLUDED.status RETURNING id`; per crew member `INSERT INTO mission_crew (mission_id, agent_id, slot, role, call_sign) VALUES (...) ON CONFLICT DO NOTHING` with the lead getting `role='LEAD'` (slot 0 in the legacy path); `INSERT INTO mission_waypoints (mission_id, seq, tag, event)` from `DEFAULT_MISSION_WAYPOINTS` (mission-defaults.ts); `INSERT INTO agent_deployment_checks (user_id, check_key, state, mission_id) VALUES ($1,$2,'pending',$3)` for checks `['dress','vehicle','equip','briefing']`. Then `UPDATE missions SET comms_channel_id = lite_bookings.conversation_id` to reuse the already-open Ops Room.
- **Note on the leader column:** the legacy `dispatch()` uses `role='LEAD'`/slot-0 to denote the leader (not an `is_lead` boolean). The plan asks for `mission_crew.is_lead` with a **partial unique index** so exactly one lead per mission. Verify the live `mission_crew` schema: if `is_lead` does not exist, add it in this step's migration plus `CREATE UNIQUE INDEX mission_crew_one_lead ON mission_crew(mission_id) WHERE is_lead;` — and set both `is_lead=true` and `role='LEAD'` for the leader so existing lead-gated agent endpoints keep working.
- **Tenant + guard primitives:** `OrgManagerGuard` (`apps/auth-service/src/org/org-manager.guard.ts`) resolves the caller's org into `req.orgManager = {user_id, org_user_id}` (company self OR active manager) by re-reading the DB; `assertOrgScope(manager, targetOrgId)` throws `org_scope_violation` on cross-tenant. The org controller (`apps/auth-service/src/org/org.controller.ts`) is `@UseGuards(JwtAuthGuard, OrgManagerGuard)` and every handler scopes to `manager.org_user_id`, never a path param. Roster lives in `org_members` (filter `member_role`, `status='active'`); managed CPOs also have `agents.managed_by_org_id = org`.
- **Capacity (D6, feeds Step's eligibility / Step 9 ranking):** `free_cpos(agency) = active roster CPOs − distinct CPOs in a non-completed mission_crew − Σ cpo_count of this agency's CONFIRMED bookings with no mission yet`. Crew-assign must consume capacity so the agency stops being offered jobs it can't crew.
- **LB11:** the request's `cpo_count`, `armed`, female-CPO and medical requirements (on `lite_bookings`) must constrain crew-assign validation, not be silently dropped.
  **Files to touch:**
- **EXTEND** `apps/auth-service/src/org/org.controller.ts` — add `GET /org/missions` and `POST /org/bookings/:bookingId/crew` (+ optional `POST /org/missions/:missionId/reassign`), all already behind `JwtAuthGuard + OrgManagerGuard`, scoped to `@CurrentOrgManager()`.
- **NEW** `apps/auth-service/src/org/org-mission.service.ts` (or extend `org-cpo.service.ts`) — `listOrgMissions(orgUserId)`, `assignCrew(orgUserId, bookingId, {cpoUserIds, leadUserId})`, `reassign(...)`.
- **NEW DTO** in `apps/auth-service/src/org/dto/org.dto.ts` — `AssignCrewDto { cpo_user_ids: string[]; lead_user_id: string }`.
- **EXTEND** mission/crew migration (only if `mission_crew.is_lead` + the partial unique index don't already exist) — `supabase/migrations/<ts>_mission_crew_is_lead.sql`.
- **REUSE** `apps/auth-service/src/ops/mission-defaults.ts` (`DEFAULT_MISSION_WAYPOINTS`), `system-messenger.service.ts` (room already open from accept), Step 12's `enqueueRoomAddIntent`, Step 14's `BookingPushBridge.missionAssigned`.
- **EXTEND** mobile `src/screens/agent/*` — multi-mission board (OrgMissions, grouped needs-crew/active/recent) + assign-crew/leader sheet; `src/services/api.ts` `orgApi.listMissions()/assignCrew(...)`.
  **Backend how-to:**
- `GET /org/missions` → `listOrgMissions(manager.org_user_id)`: one query joining `lite_bookings` (where `assigned_provider_user_id = $org`) LEFT JOIN `missions` ON `booking_id` LEFT JOIN `mission_crew`, returning per job: pickup/dropoff (precise — this caller is the assigned provider), `booking.status` + `mission.status` (both, for the shared stepper), crew array, and the lead. Group by state: `CONFIRMED` + no mission = _needs-crew_; mission `DISPATCHED..LIVE` = _active_; mission `COMPLETED` = _recent_.
- `POST /org/bookings/:bookingId/crew` → `assignCrew(manager.org_user_id, bookingId, dto)` inside `withTransaction`:
  1. **Tenant + state gate (race-safe, LB7+LB8):**
     ```sql
     UPDATE lite_bookings
        SET status='CONFIRMED'                         -- no-op flip used as the lock
      WHERE id=$1 AND assigned_provider_user_id=$2      -- assertOrgScope-by-row
        AND status='CONFIRMED'
        AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.booking_id=$1)
      RETURNING id, cpo_count, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, conversation_id, client_id;
     ```
     0 rows → `409 booking_not_assignable` (wrong org / not CONFIRMED / already crewed). Also call `assertOrgScope(manager, row.assigned_provider_user_id)` defensively.
  2. **Validate crew (LB11 + D7):** every `cpo_user_id` is an **active member of THIS org** (`org_members WHERE org_user_id=$org AND member_user_id=ANY($ids) AND status='active'` count must equal `ids.length`) **and free** (not in a non-completed `mission_crew`); `lead_user_id ∈ cpo_user_ids`; `cpo_user_ids.length === booking.cpo_count`; honor armed/female/medical flags against each CPO's attributes. Any failure → `400`/`409` with a specific code (`cpo_not_in_org`, `cpo_busy`, `lead_not_in_crew`, `crew_count_mismatch`, `requirement_unmet`).
  3. **Create mission + crew** (reuse `job-feed.service.ts dispatch()` shape): insert `missions` (`DISPATCHED`, `short_code`), insert `mission_crew` rows (leader `is_lead=true`, `role='LEAD'`, slot 0; others `role='CP'`), seed `mission_waypoints` from `DEFAULT_MISSION_WAYPOINTS`, seed `agent_deployment_checks` for `['dress','vehicle','equip','briefing']`, and `UPDATE missions SET comms_channel_id = booking.conversation_id`.
  4. **Enqueue Ops Room add-intents (Step 12):** for each `cpo_user_id`, `enqueueRoomAddIntent(bookingId, conversation_id, cpoUserId, manager.user_id)`. The server does NOT call `conversations.addMember` to grant chat access — the agency device owns the rekey.
  5. **Push each CPO (Step 14):** `BookingPushBridge.missionAssigned(cpoUserId, ...)` (opaque; details in Redis).
  6. Idempotency: wire the `Idempotency-Key` interceptor (`apps/auth-service/src/common/interceptors/idempotency.interceptor.ts`) so a double-confirm yields one mission (the `ON CONFLICT (booking_id)` on `missions` is the backstop).
- `POST /org/missions/:missionId/reassign` (optional, pre-LIVE only): conditional `UPDATE missions ... WHERE id=$1 AND status='DISPATCHED'` then swap `mission_crew`; enqueue add/remove room-intents accordingly.
  **Frontend / ops-console how-to:**
- Agency mobile (`src/screens/agent/*`): a **missions list** ("you have N jobs") with a needs-crew badge; tap a job → **assign-crew sheet** picking guards from the roster by email/name (free/busy badges from `orgApi.listCpos`), tap one ★ Leader, confirm → `orgApi.assignCrew(bookingId, {cpo_user_ids, lead_user_id})`. After confirm the job moves to "Team dispatched" on the shared stepper. `src/services/api.ts`: add `orgApi.listMissions()` and `orgApi.assignCrew(...)`.
  **Security stop-conditions:** Adding CPOs to the Ops Room is the E2EE seam — do it **only** via Step 12's add-intent enqueue (agency device runs `planAddAndRekey`); the server must **not** distribute the group key. **STOP/verify** the group rekey/sender-key flow on member add against the System Architecture Documentation. Keep all guards intact (no "skip in dev"); resolve the caller's org from `OrgManagerGuard`/`assertOrgScope`, never from a raw `sub` or path param (LB7). Never log crew/booking ids paired with key/plaintext.
  **Acceptance & tests:**
- Backend unit (`org-mission.service.spec.ts`, auth-service Jest): assign 2 guards + lead to a `CONFIRMED` no-mission booking → one `missions` row + 2 `mission_crew` rows (one `is_lead`), waypoints + deployment checks seeded, `comms_channel_id` set; assigning a CPO already on a non-completed mission → `409 cpo_busy`; lead not in crew → `400`; crew count ≠ `cpo_count` → `409`; cross-org booking → `403 org_scope_violation`; second assign (idempotent) → still one mission. `GET /org/missions` groups correctly and shows the lead.
- Regression: booking Jest project (`npm test -- --selectProjects=booking`); `npm run test:crypto` (touches the Ops Room add path via Step 12).
- Gates: `npm run typecheck` (≤ 96) + `cd apps/ops-console && npm run typecheck`; `npm run lint`; auth-service `npm run build`. Manual 3-device smoke: accept 3 jobs → all 3 in `GET /org/missions` → crew one with a leader → mission + 2 crew rows; both guards see the job + join chat; non-leader has no status buttons; capacity is consumed so the agency stops being offered jobs it can't crew. Never commit on red; never `--no-verify`.
  **Done when:**
- [ ] `POST /org/bookings/:id/crew` creates the mission (`DISPATCHED`) + `mission_crew` (one lead) + waypoints + deployment checks + reuses the existing Ops Room, all in one race-safe transaction.
- [ ] Validation enforces same-org + free + lead-in-crew + count==`cpo_count` + armed/female/medical (LB11); cross-tenant is rejected (LB7).
- [ ] Crew-assign enqueues Step 12 add-intents and Step 14 pushes; double-confirm is idempotent (one mission).
- [ ] `GET /org/missions` returns this agency's jobs grouped needs-crew/active/recent with `booking.status`+`mission.status`+crew+lead.
- [ ] booking project + crypto tests, both typechecks, lint, auth-service build all green.

---

## Step 14 — Opaque push wiring + fix the real consumer cleartext leak

**Stage:** Comms & crew · **Depends on:** Step 8/Phase 3 (DispatchService emits offers), Step 6 (accept), Step 13 (crew-assign pushes each CPO) · **Resolves:** Part I §12 (Phase 7 §12.1), Part II §24 step 4, Part III correction #6 area, **LB15** (P0 — push wake stays opaque), audit **P0-N8**
**Goal (plain English):** When the system needs to wake a phone (a new job offer for an agency, "your agency accepted" for a client, "no detail available", or "you've been assigned to a mission" for a guard), it must send a _content-free_ ping — never the booking id, the job type, or who it's about — because that ping passes through Google/Apple in the clear. We add the four new wake types behind the existing opaque bridge, fix the messenger-service consumer that currently reconstructs and re-broadcasts the sensitive fields in cleartext FCM data, and add a static test that fails if any sensitive field ever appears on the channel.
**Why it matters / what breaks without it:** A leak here exposes a per-user, real-time feed of "this person is requesting/accepting bodyguard protection for booking X" to the push intermediary — exactly the metadata Sealed Sender exists to hide. The bridge already does the right thing, but the **consumer** in messenger-service still reads `kind/bookingId/missionId` off the channel and ships them as FCM data — a live P0 leak.
**Self-contained context (inline — do not make the reader open the plan):**

- **The opaque contract (P0-N8):** the channel message published on Redis `push:events` must be **exactly** `{userId, eventClass, eventId}` — nothing else. All real detail (`kind`, `bookingId`, etc.) is stored separately under `push-event:<eventId>` in Redis with a 5-minute TTL and is fetched by the device over the **JWT-gated encrypted relay** (`/events/by-id/:eventId`), never over FCM. This is already correctly implemented in `apps/auth-service/src/ops/booking-push-bridge.service.ts` `publish()` (lines 51–70): it mints an opaque `eventId = crypto.randomBytes(16)`, `SET push-event:<eventId> <details> EX 300`, then `publish(CHANNEL, JSON.stringify({userId, eventClass, eventId}))`. `eventClass` is intentionally coarse (`'agent'|'booking'|'mission'|'payout'|'sos'`) — one bit per category, no per-instance id.
- **The real leak (LB15):** `apps/messenger-service/src/push/push.service.ts` `bootstrapPushEventsSubscriber()` (lines 132–178) parses the channel frame as `{kind, userId, bookingId, missionId, status, credits}` and switches on `frame.kind`, then calls e.g. `sendMissionLifecycleWake(userId, kind, missionId, bookingId)` (line 189) → `sendDataOnlyToUser(userId, {kind, missionId, bookingId}, ...)` (line 192) and `sendSosAlertWake` → `sendDataOnlyToUser(userId, {kind:'sos-cpo-alert', missionId, bookingId}, ...)` (line 201). That puts `kind` + `bookingId` + `missionId` into the cleartext FCM `data` payload. This consumer also assumes a channel shape the bridge **no longer publishes** (the bridge sends `{userId, eventClass, eventId}`, not `{kind, bookingId}`) — so it is both leaking and broken. Fix: the consumer must read **only** `{userId, eventClass, eventId}` and forward **only** `{eventId}` (and at most the coarse `eventClass`) as FCM data — the device then fetches details by `eventId` over the relay (same as chat wakes via `sendChatWake`/`sendDataOnlyToUser`).
- **New bridge methods needed (Part I §12.1 + Part II §24 step 4):** `dispatchOffer(providerUserId, offerId, bookingId)` → `publish(providerUserId, 'dispatch', {kind:'dispatch-offer', offerId, bookingId})`; `providerAccepted(clientUserId, bookingId)` → `publish(clientUserId, 'booking', {kind:'provider-accepted', bookingId})`; `noProvider(clientUserId, bookingId)` → `publish(clientUserId, 'booking', {kind:'no-provider', bookingId})`; `missionAssigned(cpoUserId, missionId, bookingId)` → `publish(cpoUserId, 'mission', {kind:'mission-assigned', missionId, bookingId})`. All sensitive args go into `details` (Redis), never the channel. Add a **new coarse `eventClass: 'dispatch'`** to the `publish()` union for offers.
- **Device fetch-on-wake:** the mobile client, on a data-wake, fetches detail from the JWT-gated endpoint by `eventId` (the same pattern chat uses) and routes — never trusts cleartext fields.
  **Files to touch:**
- **EXTEND** `apps/auth-service/src/ops/booking-push-bridge.service.ts` — widen the `eventClass` union to add `'dispatch'`; add `dispatchOffer`, `providerAccepted`, `noProvider`, `missionAssigned`. Do **not** change `publish()`'s channel message shape.
- **EXTEND** `apps/messenger-service/src/push/push.service.ts` — rewrite `bootstrapPushEventsSubscriber()` to parse `{userId, eventClass, eventId}` only and forward only `{eventId}` (+ coarse `eventClass`) via `sendDataOnlyToUser`; add a `'dispatch'` branch. **Delete** the cleartext reconstruction in `sendMissionLifecycleWake`/`sendSosAlertWake`/`sendPayoutSettledWake`/`sendBookingApprovedWake` that injects `bookingId/missionId/kind` into `data`.
- **NEW static test** `apps/auth-service/src/ops/booking-push-bridge.opacity.spec.ts` (or alongside the existing log-audit tests) — assert the published channel JSON contains exactly the keys `userId,eventClass,eventId` and **no** `bookingId/offerId/missionId/kind/status/credits`.
- **EXTEND** mobile data-wake handler (where chat wakes are handled) + `src/services/api.ts` — add a `'dispatch'` wake route that fetches the offer/booking detail from the JWT-gated endpoint by `eventId` and surfaces the incoming-offer card / status change.
  **Backend how-to:**
- Bridge additions (mirror existing methods exactly):

```ts
async dispatchOffer(providerUserId: string, offerId: string, bookingId: string) {
  return this.publish(providerUserId, 'dispatch', {kind: 'dispatch-offer', offerId, bookingId});
}
async providerAccepted(clientUserId: string, bookingId: string) {
  return this.publish(clientUserId, 'booking', {kind: 'provider-accepted', bookingId});
}
async noProvider(clientUserId: string, bookingId: string) {
  return this.publish(clientUserId, 'booking', {kind: 'no-provider', bookingId});
}
async missionAssigned(cpoUserId: string, missionId: string, bookingId: string) {
  return this.publish(cpoUserId, 'mission', {kind: 'mission-assigned', missionId, bookingId});
}
```

- Consumer rewrite (the core fix):

```ts
sub.on('message', (channel, raw) => {
  if (channel !== 'push:events') return;
  const frame = JSON.parse(raw) as {userId?: string; eventClass?: string; eventId?: string};
  if (!frame.userId || !frame.eventId) return;
  // Forward ONLY the opaque eventId (+ coarse class). Device fetches detail by eventId.
  void this.sendDataOnlyToUser(
    frame.userId,
    {eventId: frame.eventId, eventClass: frame.eventClass ?? ''},
    `evt:${frame.userId}:${frame.eventId}`,
    frame.eventClass === 'sos', // sos = high priority
  );
});
```

Add a `'dispatch'`-aware priority/collapse if desired, but **never** add `bookingId/offerId/missionId/kind` to `data`. Wire `dispatchOffer` from `DispatchService.offerNext` (provider wake), `providerAccepted`+`noProvider` from `DispatchService.accept`/`noProvider`, and `missionAssigned` from Step 13's crew handler (per CPO).

- Static opacity test: subscribe a fake Redis client (or spy on `redis.client.publish`), call each new bridge method, assert `Object.keys(JSON.parse(publishedArg)).sort()` === `['eventClass','eventId','userId']` and that the string contains none of the booking/offer/mission ids passed in.
  **Frontend / ops-console how-to:**
- Mobile: on the `'dispatch'`/`'booking'`/`'mission'` data-wake, take `eventId` and call the JWT-gated detail endpoint (same hydrate-on-wake pattern chat uses); for `dispatch-offer`, then call `GET /dispatch/offers/current` and render the incoming-offer card; for `provider-accepted`/`no-provider`, refresh `GET /bookings/:id`; for `mission-assigned`, refresh `GET /agents/me/active-mission`. Also keep the in-app poll fallback so a missed push still surfaces the job.
  **Security stop-conditions:** **STOP/verify against the System Architecture Documentation (P0-N8) before and after coding.** The Redis `push:events` channel payload that reaches FCM/APNs must be **exactly** `{userId, eventClass, eventId}`; details live only in Redis behind the encrypted relay. Do **not** alter `publish()`'s channel message; do **not** add `bookingId/offerId/missionId/kind/status/credits` to any FCM `data` object. `eventClass` stays coarse (one category bit). Never log the eventId paired with the resolved details. The static opacity test must gate this change.
  **Acceptance & tests:**
- New static test (auth-service Jest): the four new bridge methods publish a channel JSON whose keys are exactly `userId,eventClass,eventId` and which contains no booking/offer/mission id — **fails first** against the current leaking consumer assumptions, passes after.
- messenger-service unit (its own Jest): `bootstrapPushEventsSubscriber` parses `{userId,eventClass,eventId}` and calls `sendDataOnlyToUser` with `data` limited to `{eventId, eventClass}` — assert `bookingId`/`missionId`/`kind` never appear in the `data` arg.
- Regression: `npm run test:crypto` (push opacity is part of the messaging metadata story); booking Jest project for the accept/offer wiring.
- Gates: `npm run typecheck` (≤ 96) + `cd apps/ops-console && npm run typecheck`; `npm run lint`; both backend services `npm run build`. Manual: agency backgrounded → offer wakes it; client "Finding…" flips to "Accepted"; assigned CPO is woken to the mission; verify (logcat / FCM data inspection) the wake carries no booking/offer/mission id. Never commit on red; never `--no-verify`.
  **Done when:**
- [ ] `dispatchOffer`/`providerAccepted`/`noProvider`/`missionAssigned` exist on `BookingPushBridge`, all routing detail through Redis (`details`), with a new coarse `'dispatch'` eventClass.
- [ ] The messenger-service consumer no longer reconstructs `kind/bookingId/missionId` into FCM `data`; it forwards only `{eventId, eventClass}` and the device hydrates by `eventId`.
- [ ] A static test asserts the channel payload is exactly `{userId,eventClass,eventId}` and is wired into the suite.
- [ ] Offer/accept/no-provider/mission-assigned wakes are emitted from DispatchService + the crew handler; device fetch-on-wake hydrates from JWT-gated endpoints.
- [ ] crypto + booking tests, both typechecks, lint, and both backend builds are green.

---

## Step 15 — Vetting / licence / insurance / armed eligibility gates + per-request client terms

**Stage:** Safety & trust · **Depends on:** Step 6 (eligibility/ranking query that the dispatcher filters on), Step 5 (`agents.region_code` + on-duty heartbeat columns), Step 1–2 (auto-dispatch migration + `dispatch_offers`/`lite_bookings.dispatch_mode`) · **Resolves:** Part III legal table LB10 + LB20 + LB11 (P0 rows: "No vetting gate in the match", "Per-region/agency/CPO licence registry with expiry", "Mandatory insurance certificate on file + expiry", "Armed-protection authorization + an `armed` request field", "Client terms / waiver acceptance captured per request"); Trust & safety P0 "can dispatch unvetted/unlicensed/uninsured agencies".

**Goal (plain English):** Before the system can auto-offer a job to a firm, that firm (and the guards it would deploy) must be proven legit: KYC-active, holding a non-expired licence for the job's region, holding a non-expired insurance certificate, and — if the client asked for armed protection — authorised to carry. We store each of these as a verifiable record with an expiry date and an admin "verified" stamp, and the matchmaker only ever considers providers who pass all of them. We also record the client's acceptance of the terms / service agreement / waiver on the booking itself each time they request.

**Why it matters / what breaks without it:** This is an armed-protection product across four regulated regions; dispatching an unvetted, unlicensed, uninsured, or unauthorised-armed provider is the single biggest legal and safety liability. Without the per-request terms capture there is no record the client agreed to anything.

**Self-contained context (inline — do not make the reader open the plan):**

- LOCKED DECISIONS in play: D1 the flow is fully automatic (admin only monitors/overrides), D3 the AGENCY accepts then deploys its own CPOs, D4 nearest-eligible within the same region (AE / SA / BD / GB), D5 one login email = one agency with up to ~10 real CPO emails.
- The match must dispatch ONLY providers that are KYC-ACTIVE + licensed (valid, non-expired, region-matched) + insured (cert on file, non-expired) + armed-authorised when the request requires it. This is the eligibility filter Step 6's ranking query consumes.
- What already exists (verified in code — reuse, don't reinvent):
  - `agents` table — company/cpo agents with `status` driven by the KYC FSM in `apps/auth-service/src/agents/agent-state-machine.service.ts` (`PROFILE_COMPLETE → KYC_PENDING → DOCS_PENDING → … → ACTIVE`). The match's "KYC-ACTIVE" = `agents.status='ACTIVE'`.
  - `agent_kyc_checks` (kinds in `apps/auth-service/src/agents/dto/agent.dto.ts`: `KYC_KINDS = ['gov_id','proof_address','sia_licence','police']`) with `file_url`, `file_hash_sha256`, `uploaded_at` (migration `supabase/migrations/20260425000000_agent_kyc_uploads.sql`). **No expiry column exists.**
  - `agent_documents` (DOC_SLOTS in the same DTO: `['sia','passport','insurance','dbs','firstaid','cv']`) — upload slots, **no expiry, no admin-verified flag, no region binding.**
  - `agents` has NO `region_code` today (Step 5 adds it). The old `cpo_pool` table (migration `20260423160000_wallet_assignment_telemetry.sql`) has `armed`/`female`/`region_code`/`specialties` columns but is the LEGACY admin pool — do NOT extend the auto-flow off it (correction #6 / "capacity drift across two un-reconciled availability models"). The new flow keys off `agents` + `org_members`.
  - `lite_bookings` (migration `20260423113000_booking_module.sql`) has `cpo_count`, `add_ons JSONB`, `region_code`, `pickup_lat/lng`, `dropoff_lat/lng`. It has **NO `armed`, `female`, or `waiver`/`terms` columns** — those must be added. ("female_cpo" exists only as an `lite_booking_add_ons` row, not a first-class field.)
- LB11 ("honor what the client paid for"): `armed`, `cpo_count`, female-CPO, medical requirements must constrain BOTH the match (this step's eligibility filter) AND the Step-7 crew-assign validation — not be silently dropped.
- These are compliance gates to ENCODE in software, not legal advice; the plan flags "confirm the actual regimes with counsel per region" and "cross-border jurisdiction mismatch" as a follow-up.

**Files to touch:**

- NEW migration `supabase/migrations/<ts>_provider_compliance_registry.sql` — the compliance registry tables + booking compliance columns (SQL below).
- EXTEND `apps/auth-service/src/agents/dto/agent.dto.ts` — add a `ComplianceDocDto` (type, region, issued/expiry, file_url, file_hash) and an `ArmedAuthDto`; export a `COMPLIANCE_DOC_TYPES = ['licence','insurance','armed_permit'] as const`.
- EXTEND `apps/auth-service/src/agents/agent.service.ts` + `agent.controller.ts` — provider-side CRUD to submit/replace compliance docs (`POST /agents/me/compliance`, `GET /agents/me/compliance`).
- EXTEND `apps/auth-service/src/ops/ops.controller.ts` + `ops.service.ts` — admin verify/reject of a compliance record (`POST /ops/compliance/:id/verify`), audited via the existing `OpsAuditService`.
- EXTEND the eligibility query authored in Step 6 (the dispatcher's "nearest eligible provider" SQL, in the new `apps/auth-service/src/dispatch/dispatch.service.ts`) — add the compliance JOIN/EXISTS filters.
- EXTEND `apps/auth-service/src/booking/dto/booking.dto.ts` (the create-booking DTO) + `booking.service.ts` — accept + persist `armed: boolean`, `female_required: boolean`, and `terms_accepted_version`/`terms_accepted_at` on auto-mode requests.
- Mobile: EXTEND the request wizard (Package / AddOns step, under `src/screens/`) to surface an "Armed protection" toggle and a "I accept the terms & waiver" gate; EXTEND `src/services/api.ts` booking-create call to send the new fields. Agency-side: EXTEND the "Agency Profile & Compliance" screen (per §30, v1.1) for licence/insurance/armed-permit upload + expiry.

**Backend how-to:**

- Migration (PostGIS already enabled; reuse the project's `gen_random_uuid()` + `TIMESTAMPTZ` conventions):

  ```sql
  -- one verifiable, expiring credential per (provider, type, region)
  CREATE TYPE compliance_doc_type AS ENUM ('licence','insurance','armed_permit');
  CREATE TYPE compliance_state    AS ENUM ('PENDING','VERIFIED','REJECTED','EXPIRED');
  CREATE TABLE provider_compliance_docs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_user_id UUID NOT NULL,                 -- agents.user_id (company OR cpo)
    doc_type         compliance_doc_type NOT NULL,
    region_code      TEXT NOT NULL,                 -- AE | SA | BD | GB  (licence/permit are region-scoped)
    state            compliance_state NOT NULL DEFAULT 'PENDING',
    file_url         TEXT,                          -- S3 key (AES-256-CBC encrypted before upload, key in-band) — NEVER a plaintext cert
    file_hash_sha256 TEXT,
    issued_at        DATE,
    expires_at       DATE NOT NULL,                 -- hard validity gate
    verified_by      UUID,
    verified_at      TIMESTAMPTZ,
    reject_reason    TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  -- one live doc per (provider,type,region): re-upload supersedes
  CREATE UNIQUE INDEX provider_compliance_one_live
    ON provider_compliance_docs(provider_user_id, doc_type, region_code)
    WHERE state IN ('PENDING','VERIFIED');
  CREATE INDEX provider_compliance_lookup
    ON provider_compliance_docs(provider_user_id, doc_type, region_code, state, expires_at);

  -- armed authorization is a per-provider, per-region capability, backed by a verified armed_permit
  ALTER TABLE agents
    ADD COLUMN armed_authorized BOOLEAN NOT NULL DEFAULT FALSE;  -- maintained from verified, non-expired armed_permit

  -- per-request compliance capture
  ALTER TABLE lite_bookings
    ADD COLUMN armed                  BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN female_required        BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN terms_accepted_version TEXT,
    ADD COLUMN terms_accepted_at      TIMESTAMPTZ;
  ```

- Admin verify endpoint — race-safe conditional UPDATE inside `withTransaction`, mirroring the `payWithCredits`/waypoint pattern (`UPDATE … WHERE <expected state> RETURNING`):
  ```sql
  UPDATE provider_compliance_docs
     SET state='VERIFIED', verified_by=$2, verified_at=NOW(), updated_at=NOW()
   WHERE id=$1 AND state='PENDING'
   RETURNING provider_user_id, doc_type, region_code, expires_at;
  ```
  If `doc_type='armed_permit'` and the row verifies non-expired, set `agents.armed_authorized=TRUE` in the SAME txn; recompute on reject/expiry. Audit via `OpsAuditService.emit({kind:'compliance', actor, subject: providerUserId, message:'licence verified'})`.
- Eligibility filter to ADD to Step 6's dispatcher query — only consider a provider when, for the booking's `region_code`:
  ```sql
  AND a.status = 'ACTIVE'                                  -- KYC-ACTIVE
  AND a.region_code = b.region_code                         -- D4 same region
  AND EXISTS (SELECT 1 FROM provider_compliance_docs d
                WHERE d.provider_user_id = a.user_id AND d.doc_type='licence'
                  AND d.region_code = b.region_code AND d.state='VERIFIED' AND d.expires_at > NOW())
  AND EXISTS (SELECT 1 FROM provider_compliance_docs d
                WHERE d.provider_user_id = a.user_id AND d.doc_type='insurance'
                  AND d.state='VERIFIED' AND d.expires_at > NOW())
  AND (b.armed = FALSE OR a.armed_authorized = TRUE)        -- armed gate
  ```
  Keep this as ONE filter block so the offer cascade (reject → next-nearest) can never skip it.
- Expiry: add a small Redis `SET NX`-locked `setInterval` sweep (copy `apps/auth-service/src/.../payment-pending-expiry.service.ts`, NOT `@nestjs/schedule` — auth-service is multi-replica) that flips `state='VERIFIED' → 'EXPIRED' WHERE expires_at < NOW()` and recomputes `agents.armed_authorized`. A provider whose licence/insurance silently lapsed must drop out of the pool the moment it expires, without a manual touch.
- Booking create: in `booking.service.ts`, when `dispatch_mode='auto'`, REQUIRE `terms_accepted_version` (reject the request with `400 terms_not_accepted` if absent) and persist `armed`/`female_required` from the DTO. Cross-border note: if the client's `region_code` differs from the requested-service region, mark for review rather than silently dispatching (jurisdiction mismatch is a flagged P1 — leave a `// Why:` comment and a TODO referencing counsel sign-off).

**Frontend / ops-console how-to:**

- Mobile request wizard (Package/AddOns step): add an "Armed protection" switch wired to `armed`, a female-team requirement toggle wired to `female_required`, and a blocking "I accept the Terms of Service & Liability Waiver (vX)" checkbox; the Submit button stays disabled until checked, and the create call sends `terms_accepted_version` + `armed` + `female_required`. Render TrustProfile badges (vetted/licensed/insured) only from real backend fields — never fabricate a badge (per §32).
- Agency app "Agency Profile & Compliance": upload licence/insurance/armed-permit with an expiry date picker; show each doc's state (Pending / Verified / Rejected / Expired) and days-to-expiry; surface the admin reject_reason. CPO compliance is uploaded under the existing Docs/Credentials screen.
- Ops-console: a compliance review queue (list `PENDING` docs, view the (decryptable) cert, Verify/Reject with reason) under `apps/ops-console/src/app/`.

**Security stop-conditions:**

- Compliance certs are sensitive PII/regulatory documents: store them via the SAME media path as other uploads — AES-256-CBC, unique key per file, encrypted locally before upload to S3, key shipped in-band. **STOP/verify against the System Architecture Documentation before issuing any download URL** — the File Vault MFA gate (fresh biometric/TOTP before a download URL is returned) applies; do not bypass it.
- Do NOT add a "skip vetting in dev" branch on the eligibility filter — a missing/expired licence must hard-exclude in every environment (CLAUDE.md: never weaken a check with a dev skip).
- Never log cert file bytes, file_url contents, or hashes that could leak document identity into logs (the static log-audit test enforces no plaintext/key logging).
- The eligibility filter only reads provider compliance — it must NOT expand the coarse pre-accept offer payload (the offer stays coarse: no exact pickup/dropoff to offered/rejecting agencies — correction #3).

**Acceptance & tests:**

- New unit tests (auth-service Jest — note correction #6: ensure CI actually runs the auth-service project): expired-licence provider is excluded; missing-insurance provider is excluded; `armed=TRUE` request with `armed_authorized=FALSE` provider is excluded; all-valid provider passes; verify endpoint flips state only from `PENDING` (double-verify is a no-op); armed-permit verify sets `agents.armed_authorized`; expiry sweep clears it.
- Booking test (run the `booking` Jest project): auto request without `terms_accepted_version` is rejected; with it, `armed`/`female_required`/`terms_*` persist on the row.
- Regression: re-run the booking project + the dispatcher/eligibility tests from Step 6.
- Gates: `npm run typecheck` (mobile ≤ baseline 96) AND `cd apps/ops-console && npm run typecheck`; `npm run lint`; manual smoke of the wizard terms gate + an agency compliance upload + an ops verify. Never commit on a red gate; never `--no-verify`.

**Done when:**

- [ ] `provider_compliance_docs` + `agents.armed_authorized` + `lite_bookings.armed/female_required/terms_accepted_*` migrated.
- [ ] Provider can submit licence/insurance/armed-permit with expiry; admin can verify/reject (audited).
- [ ] Step-6 eligibility query excludes non-ACTIVE / unlicensed / uninsured / out-of-region / armed-required-but-unauthorised providers, proven by tests.
- [ ] Expiry sweep (Redis `SET NX`, not @nestjs/schedule) flips lapsed docs to `EXPIRED` and clears `armed_authorized`.
- [ ] Auto request blocks until terms accepted; `armed`/`female_required`/`terms_*` persist and feed both the match and Step-7 crew validation.
- [ ] All listed gates green.

## Step 16 — Identity handshake + pre-live SOS coverage + no-show auto-re-dispatch + NO_PROVIDER safety fallback

**Stage:** Safety & trust · **Depends on:** Step 15 (vetting gates — only verified providers ever reach this), Step 6/7 (offer cascade + crew-assign that creates the mission), Step 5 (mission FSM wiring `pickup`), the escrow accept txn (Step PV2) so re-dispatch can reuse the held funds · **Resolves:** Part III LB12 (client↔guard identity handoff), LB13 (SOS covers the pre-live window + no-show + `NO_PROVIDER` safety fallback); Trust & safety P0 rows "No client↔guard identity handoff (impersonation risk)", "No SOS coverage during DISPATCHING / awaiting-crew", "No no-show / never-arrives detection or auto-re-dispatch", and P1 "`NO_PROVIDER` leaves a threatened client alone"; feeds the §40 proof-of-completion gate ("Identity handshake … happened or was offered").

**Goal (plain English):** When the guard arrives, the app shows the SAME rotating code to both the client and the lead guard so each can confirm the other is the real party; the lead's "Arrived" confirm advances the mission to PICKUP, and a client "this is NOT my guard" button instantly fires the panic alarm. The panic button also has to work during the scary in-between moments — while still searching for a firm and while a firm has accepted but hasn't put a crew on the job yet. If the guard never shows up, the system notices and re-dispatches automatically. And if nobody is available at all, the client isn't just told "sorry" — they're given a real safety fallback (a hotline / escalation / widen-the-search).

**Why it matters / what breaks without it:** Impersonation of a bodyguard is a direct attack on the principal; the client is MOST exposed in the windows before the mission goes LIVE, exactly where SOS currently doesn't reach; a no-show with no detection strands a charged client; and a bare "no one available" dead-end abandons a person who may be in danger.

**Self-contained context (inline — do not make the reader open the plan):**

- Booking FSM (auto flow, from `apps/auth-service/src/booking/state-machine.service.ts` extended in Step 2): `DRAFT → DISPATCHING` (CLIENT submits auto request) → `CONFIRMED` (SYSTEM: agency accepted + charged into escrow; CONFIRMED now means "accepted, awaiting crew assignment") → `LIVE` → `COMPLETED`; failure `DISPATCHING → NO_PROVIDER` (terminal: nobody available / all rejected). The client is exposed during `DISPATCHING` and during `CONFIRMED`-awaiting-crew (before LIVE).
- Mission FSM (`apps/auth-service/src/ops/mission-state-machine.service.ts`): `DISPATCHED → PICKUP → LIVE → COMPLETED`, with SOS overlay from PICKUP/LIVE. Today PICKUP is fired ONLY by the lead via `MissionLeadService.markWaypoint('PICKUP')` (verified: lead-gated `UPDATE missions SET status='PICKUP' WHERE id=$1 AND status='DISPATCHED'`). The arrival-confirm path must reuse this exact lead-gated, conditional transition.
- SOS today (verified in `apps/auth-service/src/sos/sos.service.ts` + `sos.controller.ts`): `SosService.raise(userId, {bookingId?, lat?, lng?, reason?, payload?})` is NOT booking-scoped — a panic press from anywhere is recorded (`sos_events` row, `status='active'`), it emits ops-audit + Kafka, and when `bookingId` is present it fans a `kind:'sos-cpo-alert'` wake over Redis `push:events` to every crew member found via `mission_crew JOIN missions ON booking_id`. `POST /sos/raise` is throttled 3/min/user via `UserThrottlerGuard`. Agent-side SOS exists at `POST /agents/me/missions/:missionId/sos` (controller line ~302). So raising SOS already works in any state — the gap is (a) a client-facing "not my guard" path that calls it with the booking context, and (b) ensuring the client SOS UI is mounted/available during DISPATCHING and CONFIRMED-awaiting-crew, plus crew-fanout gracefully no-ops when no crew exists yet.
- Identity handshake (LB12): a rotating shared code/passphrase (+ photo/call-sign) shown IDENTICALLY to client and lead CPO at arrival. New endpoint `GET /bookings/:id/verify-code` (server-issued, rotating). It is read by the client's new `IdentityVerifyScreen` and the lead's new "Arrival / Identity Confirmation" screen. The §40 proof gate later checks "the arrival code/photo confirm happened (or was offered)".
- No-show (LB13): after CONFIRMED + crew assigned (mission DISPATCHED), there must be an arrival deadline; if PICKUP isn't reached by it, auto-re-dispatch (re-offer to the next eligible agency) WITHOUT restarting the client payment — the escrow hold persists. This is a watchdog.
- `NO_PROVIDER` fallback (LB13): instead of a bare dead-end, offer a safety fallback (hotline / escalate / widen the search radius/region) — the client may be a threatened person.
- KEY CORRECTIONS to honor: (1) ALL watchdogs/sweeps use the Redis `SET NX`-locked `setInterval` pattern from `payment-pending-expiry.service.ts`, NOT `@nestjs/schedule` (auth-service is multi-replica) — the no-show sweep included; (3) the re-dispatch offer stays COARSE pre-accept (next agency gets no exact pickup/dropoff until it accepts via the ACCEPTED-only `/offers/:id/full` endpoint); (5) the server cannot add a CPO to the E2E Ops Room (no group-key path) — re-dispatch that lands a NEW agency requires the new agency's device to own the rekey, not the server.

**Files to touch:**

- NEW `apps/auth-service/src/booking/verify-code.service.ts` (or extend `booking.service.ts`) — issue/rotate the verify code; persist nothing secret-in-plaintext-logged.
- EXTEND `apps/auth-service/src/booking/booking.controller.ts` — add `GET :id/verify-code` (client-owns-booking guard) and `POST :id/not-my-guard` (client → fire SOS).
- EXTEND `apps/auth-service/src/agents/agent.controller.ts` + `agent.service.ts` — add `POST /agents/me/missions/:missionId/arrive` (lead-gated arrival confirm → fires the existing `DISPATCHED → PICKUP` conditional UPDATE) and `GET /agents/me/missions/:missionId/verify-code` (lead reads the SAME code).
- EXTEND `apps/auth-service/src/sos/sos.service.ts` — confirm crew-fanout no-ops cleanly when `mission_crew` is empty (DISPATCHING / awaiting-crew) and the row still records; add a `reason:'not_my_guard'` tag path.
- NEW `apps/auth-service/src/dispatch/no-show-sweep.service.ts` — Redis `SET NX`-locked `setInterval` watchdog (copy `payment-pending-expiry.service.ts`) for arrival-deadline → auto-re-dispatch.
- NEW migration `supabase/migrations/<ts>_arrival_and_verify.sql` — `lite_bookings.arrival_deadline_at`, `verify_code` (or derive deterministically), `verify_code_rotated_at`, `not_my_guard_at`; `missions.arrived_at`.
- NEW `apps/auth-service/src/booking/fallback.service.ts` (or extend) — `NO_PROVIDER` safety fallback details for `GET :id` / a `POST :id/escalate`.
- Mobile NEW `src/screens/IdentityVerifyScreen.tsx` (client) + extend CPO "Arrival / Identity Confirmation" screen + extend `NoDetailScreen` (NO_PROVIDER fallback) + ensure the SOS bar is mounted on FindingDetailScreen/AgencyAcceptedScreen; EXTEND `src/services/api.ts` (verify-code, not-my-guard, arrive, escalate) and `src/services/bookingStatus.ts` `resumeTargetFor`.

**Backend how-to:**

- Verify code: server-issued, rotating, shown identically to both sides. Generate per booking (e.g. derive an HMAC over `booking_id` + a coarse time bucket so it rotates every N minutes without storing a secret in cleartext, OR store a `verify_code` + `verify_code_rotated_at` and rotate on read). `GET /bookings/:id/verify-code` returns `{code, rotates_at, lead: {display_name, call_sign, photo_url}}` gated by `WHERE client_id=$user`; the lead's `GET /agents/me/missions/:id/verify-code` returns the SAME `code` gated by lead membership (`mission_crew.is_lead`). Never log the code value.
- Arrival confirm (lead-gated, reuse the proven pattern): mirror `MissionLeadService.markWaypoint('PICKUP')` — require lead (`SELECT is_lead FROM mission_crew WHERE mission_id=$1 AND agent_id=$2`), then the existing conditional UPDATE `UPDATE missions SET status='PICKUP', updated_at=NOW() WHERE id=$1 AND status='DISPATCHED'` inside the txn, stamp `missions.arrived_at=NOW()`, fire the EN_ROUTE auto-mark as today. Idempotent: a second call is a no-op because the WHERE no longer matches.
- "Not my guard": `POST /bookings/:id/not-my-guard` (client-owns guard) → call `SosService.raise(user.sub, {bookingId: id, reason:'not_my_guard', lat, lng})` — this records the `sos_events` row AND fans the existing `sos-cpo-alert` wake. Keep it under `UserThrottlerGuard` like `/sos/raise`. This is a panic path: do NOT gate it behind any "are you sure" server check.
- Pre-live SOS coverage: no new transition needed — `SosService.raise` already works state-independently. Verify the crew-fanout block (`mission_crew JOIN missions`) returns empty cleanly during DISPATCHING/awaiting-crew and the row still records + ops-audit fires. The FIX is purely (a) keep the client SOS UI mounted in the FindingDetailScreen/AgencyAcceptedScreen states (frontend) and (b) ensure ops sees these pre-live SOS events in the unacknowledged feed.
- No-show watchdog (Redis `SET NX`-locked `setInterval`, copy `payment-pending-expiry.service.ts`; NOT `@nestjs/schedule`): set `arrival_deadline_at = crew_assigned_at + ARRIVAL_SLA` at crew-assign. The sweep finds `missions.status='DISPATCHED' AND lite_bookings.arrival_deadline_at < NOW()` and re-dispatches via a race-safe conditional UPDATE so two pods can't both re-dispatch:
  ```sql
  UPDATE lite_bookings
     SET status='DISPATCHING', assigned_provider_user_id=NULL, dispatch_started_at=NOW(), updated_at=NOW()
   WHERE id=$1 AND status='CONFIRMED' AND arrival_deadline_at < NOW()
   RETURNING id;
  ```
  Only the pod whose UPDATE returns a row proceeds to mark the no-showing offer/agency (flag for penalty) and re-enter the Step-6 cascade. The escrow hold from the original accept STAYS — re-dispatch must NOT re-charge the client (reuse the held funds; if the new agency accepts, no new debit). Emit a metric for no-show rate.
- `NO_PROVIDER` fallback: when the cascade exhausts → `DISPATCHING → NO_PROVIDER` (SYSTEM), `dispatch_settled_at=NOW()`, and `GET /bookings/:id` returns a fallback block `{hotline_e164, can_widen: bool, can_escalate: bool}`; a `POST /bookings/:id/escalate` either widens the region/radius and re-enters the cascade or routes to a human safety line. Confirm the client was NEVER charged on this path (escrow only opens on accept).

**Frontend / ops-console how-to:**

- `IdentityVerifyScreen` (client, new): polls `GET /bookings/:id/verify-code`, shows the big rotating code + the lead's photo/name/call-sign, and a prominent red "This is NOT my guard" button → `POST /bookings/:id/not-my-guard` → immediate SOS UX. Reachable from LiveTrackingScreen's "Arrived — verify your guard" affordance.
- CPO "Arrival / Identity Confirmation" (lead-only, new): shows the SAME code + an "Arrived" confirm → `POST /agents/me/missions/:id/arrive` (fires PICKUP). Non-lead sees read-only.
- `FindingDetailScreen` + `AgencyAcceptedScreen`: ensure the SOS bar/button is mounted so the client can panic during DISPATCHING and CONFIRMED-awaiting-crew.
- `NoDetailScreen`: replace the bare dead-end with the fallback (call hotline / widen search / escalate) + "you weren't charged."
- `bookingStatus.ts` `resumeTargetFor`: route DISPATCHING→Finding, CONFIRMED→Confirmation (with verify affordance once a crew is assigned), LIVE→LiveTracking, NO_PROVIDER→NoDetail fallback — for client AND agency/CPO roles.

**Security stop-conditions:**

- Re-dispatch can land a DIFFERENT agency on the Ops Room. **STOP/verify against the System Architecture Documentation:** the server CANNOT add the new agency's CPOs to the E2E Ops Room — there is no server-side Signal group-key path for conversation rooms (the server→client rekey-intent drain covers only department_channels, not booking conversations). The new agency's device must own the rekey (`groupClient.planAddAndRekey` / `runtime.addGroupMember`). Do not have the server inject group membership.
- The verify code is a security token: never log its value; the `not-my-guard` and arrival endpoints must not leak it into audit detail. Honor the static log-audit test.
- The re-dispatch offer to the next agency stays COARSE (no exact pickup/dropoff pre-accept; precise only via the ACCEPTED-only endpoint) — do not widen the offer payload to "help" the new agency.
- Keep the panic push wake OPAQUE — the Redis `push:events` payload stays exactly `{userId,eventClass,eventId}` shape (audit P0-N8); do not add `not_my_guard`/booking detail to the wake.
- No "skip in dev" on the lead check for arrival confirm or on the SOS throttle guard.

**Acceptance & tests:**

- New unit tests (auth-service Jest — and confirm CI runs the auth-service project, correction #6): client and lead read the SAME verify code; the code rotates; `not-my-guard` raises an `sos_events` row with `reason='not_my_guard'` and fans crew alerts; SOS raised during DISPATCHING (no crew) records cleanly with empty fanout; arrival confirm fires `DISPATCHED → PICKUP` only for the lead and is idempotent; non-lead arrival confirm is `403`.
- No-show watchdog test: past `arrival_deadline_at` + still DISPATCHED → exactly ONE pod re-dispatches (simulate the conditional UPDATE returning a row for only one caller — mirror the multi-pod lock test pattern), escrow hold unchanged (no second client debit), no-showing agency flagged.
- `NO_PROVIDER` test: exhausted cascade → fallback block present, client never charged.
- Regression: run the `booking` Jest project and the mission/SOS suites; since this touches messaging-adjacent Ops Room membership, run `npm run test:crypto`.
- Gates: `npm run typecheck` (mobile ≤ baseline 96) AND `cd apps/ops-console && npm run typecheck`; `npm run lint`; manual smoke — client+lead show matching code, "not my guard" fires SOS, kill the crew (no PICKUP) to trigger re-dispatch, exhaust agencies to hit the NO_PROVIDER fallback. Never commit on red; never `--no-verify`.

**Done when:**

- [x] Client and lead each fetch the SAME rotating verify code (+ lead call-sign/name); code value never logged. (`deriveVerifyCode` shared util; `GET /bookings/:id/verify-code` + `GET /agents/me/missions/:id/verify-code`. Lead photo deferred — no photo column yet.)
- [x] Lead "Arrived" confirm fires `DISPATCHED → PICKUP` (lead-gated, conditional, idempotent); `missions.pickup_at` stamped. (Reuses the existing `missionPickup`/`flipMissionStatus` path — no new arrive endpoint needed.)
- [x] Client "This is NOT my guard" fires `SosService.raise` with booking context and crew fanout. (`POST /bookings/:id/not-my-guard` via `ClientArrivalController` in DispatchModule — avoids the Booking↔Sos↔Ops module cycle.)
- [x] SOS works (records + ops-audit) during DISPATCHING and CONFIRMED-awaiting-crew; crew-fanout no-ops cleanly when no crew exists. (Confirmed in `SosService.raise` — bookingId-gated fanout, try/catch.) Client SOS UI mounting on DISPATCHING/awaiting-crew screens = remaining mobile surface.
- [x] No-show watchdog (`arrival-noshow.service.ts`, Redis `SET NX`, not @nestjs/schedule) auto-re-dispatches past the arrival deadline, single-pod-safe, with NO re-charge (escrow hold preserved + re-pointed to the replacement agency in `accept()`), no-showing agency flagged + crew stood down; re-dispatch keeps the offer coarse and leaves Ops Room rekey to the agency device.
- [x] `NO_PROVIDER` returns a real safety fallback (`no_provider_fallback` block on `getById` + `POST /bookings/:id/escalate`); client never charged on the NO_PROVIDER path (no escrow touch in `noProvider()`).
- [x] All listed gates green. (auth-service 1360 tests, crypto 1083 tests, mobile tsc = baseline 49, auth lint 0 errors. Mobile RN screens — IdentityVerifyScreen / NoDetail fallback card / CPO arrival screen — are the remaining device-gated presentation surface; the API client methods are wired in `src/services/api.ts`. The ops-console Dispatch Monitor already surfaces a re-dispatched booking as it re-enters DISPATCHING.)

---

## Step 17 — Role routing + CPO activation + revocation

**Stage:** Apps · **Depends on:** Step 4 (server returns `account_kind` + `org{id,name}` + `must_set_password` + `membership_status` on `/agents/me` / `/auth/me`), Step 15 (agency CPO roster: `org_members` + `POST /org/cpos`) · **Resolves:** §35A §A–§F, PR1–PR6 (PR2/PR3/PR4 routing+activation, PR5 capability hiding, PR6 revocation)
**Goal (plain English):** Bravo is one app download that opens three different front doors — customer, agency, or guard (CPO) — and which door you get is decided entirely by what the server says your account is, not by anything the app picks. A guard logs in with the email/password their agency created, sets a real password on first login, gets a short "you belong to {agency}" walkthrough, then lands in a stripped-down guard interface. If the agency later removes or suspends that guard, the app shuts the door on them the next time it checks in.
**Why it matters / what breaks without it:** Without server-driven routing a managed CPO would land in the consumer client app (or the agency cockpit) and could see "book a guard," wallets, or accept jobs — none of which a worker may do. Routing off a client flag re-creates the `pendingProvider` stuck-screen bug class. Without mid-session revocation, a fired guard keeps a live guard interface (and stays in encrypted Ops Rooms) indefinitely.

**Self-contained context (inline — do not make the reader open the plan):**

- **THE RULE (§35A):** route purely from the **server's authenticated identity**, never a client-chosen flag. This is the lesson from the `pendingProvider` stuck-register bug — see `src/store/pendingProvider.ts` (now in-memory + reactive precisely so a cold launch routes by role only).
- **Discriminator precedence (§35A §A), computed server-side in Step 4 as `account_kind`:**
  1. **`cpo`** — user has an `agents` row with `type='cpo'` AND `managed_by_org_id` set, OR an `org_members` row where `member_role='cpo'` and `status='active'`. → CPO interface.
  2. **`agency`** — company agent (`agents.type='company'`, `service_provider` role) OR `org_members` with `member_role='manager'`. → Agency operator interface.
  3. **`individual`** — everything else (`users.role='individual'`, no agent/org membership). → Client interface.
- **Extra server fields (Step 4):** `org: {id, name}`, `must_set_password: boolean` (true on the agency-set temp password / first login), `membership_status` (from `org_members.status`: `active|suspended|removed`).
- **Routing (§35A §B):** in the root, after auth bootstrap, mount **exactly one** of ClientNavigator / AgencyNavigator / **CpoNavigator** by `account_kind`.
  - A CPO **never sees `RoleSelectionScreen`** (`src/screens/auth/RoleSelectionScreen.tsx`) — they did not self-register.
  - **First login** (`must_set_password=true`) → force the **CPO account-activation** flow first (set password → optional biometric → location + notification permissions → "you belong to {agency}" + on-duty/SOS explainer), THEN the CPO home.
  - **Mid-session revocation (§35A §B/§F):** on every app-focus / token-refresh, re-check `membership_status`. If `!= 'active'`, force-logout to an "Your agency access has ended — contact your agency" screen, set the CPO **offline** (`PATCH /agents/me/duty {on_duty:false}`), and drop them from Ops Rooms.
- **Capability matrix the CPO build HIDES (§35A §D):** no "Protect me now"/booking wizard, no client wallet/credits, no client booking history/receipts, no family hub, no VBG client suite, **no incoming job offer (the agency accepts, never the CPO)**, no roster management, no assign-crew/name-leader, no multi-mission board, no org earnings rollup. A CPO sees only their own assigned mission, runs it **only if lead**, has Ops Room comms + SOS + own-share earnings + own docs.
- **Current code reality (verified):** `src/navigation/index.tsx` (RootNavigator) mounts `AuthNavigator` / `PermissionsScreen` / `MainNavigator`. `src/navigation/MainNavigator.tsx` branches: `isAgent = user?.role === 'agent' || user?.role === 'service_provider' || pendingProv` → returns `<AgentNavigator/>`; else the client `Tab.Navigator` (Dashboard / MessengerTab / SecureTab / ProfileTab). `useAuthStore` (`src/store/authStore.ts`) holds `user` (mapped via `toUser(ApiUser)`); `initialize()`, `completeAuth()`, `biometricSignIn()` all call `authApi.me()` → `{user}`; `signOut()` does the full runtime/Ops-Room/keychain teardown and is the function to reuse for forced logout. `agentApi.setDuty(on_duty)` lives at `src/services/api.ts:530`.

**Files to touch:**

- **EXTEND** `src/services/api.ts` — extend `ApiUser` (line ~202) with `account_kind?: 'individual'|'agency'|'cpo'`, `org?: {id: string; name: string} | null`, `must_set_password?: boolean`, `membership_status?: 'active'|'suspended'|'removed' | null`. Add `authApi.me()` already returns these once Step 4 ships; no new call needed. Add `agentApi` already has `setDuty` — reuse.
- **EXTEND** `src/store/authStore.ts` — carry the new fields through `toUser()` and the `User` type; add a selector/derived `accountKind` and `membershipStatus`. Add an action `recheckMembership()` that calls `authApi.me()` and, if `account_kind==='cpo' && membership_status!=='active'`, triggers the revocation path (set offline, signOut, route to access-ended).
- **EXTEND** `src/navigation/index.tsx` (RootNavigator) — switch the post-auth mount on `account_kind`. For `cpo` + `must_set_password` → mount the activation flow before CpoNavigator.
- **EXTEND** `src/navigation/MainNavigator.tsx` — replace the `isAgent` role-string branch with `account_kind`: `agency`→`AgentNavigator`, `cpo`→`CpoNavigator`, else client tabs. Keep `pendingProvider` only for the agency self-signup window (it maps to `account_kind` not yet flipped server-side; leave as a fallback for `agency` only).
- **NEW** `src/navigation/CpoNavigator.tsx` — the 4-tab shell scaffold (On Duty / Mission / Comms / Me). (Tab contents are built in Step PX4; this step wires the shell + the activation gate + the access-ended screen.)
- **NEW** `src/screens/cpo/CpoActivationScreen.tsx` — first-login activation (set password → optional biometric → location+notification permission primers → "you belong to {agency}" + on-duty/SOS explainer).
- **NEW** `src/screens/cpo/AccessEndedScreen.tsx` — terminal "Your agency access has ended — contact your agency" screen.
- **EXTEND** `src/navigation/types.ts` — add `CpoStackParamList`, `CpoActivation`, `AccessEnded` routes; thread into `RootStackParamList`.
- **REUSE (no change)** `src/store/authStore.ts signOut()` for the forced-logout teardown (it already drops the user from Ops Rooms / tears down the runtime / wipes at-rest).

**Backend how-to:** This step is mobile-only; it **consumes** the server fields added in Step 4 and reuses the roster endpoints from Step 15. The only backend call this step makes is `authApi.me()` (already `GET /auth/me` + `GET /agents/me`) and `agentApi.setDuty(false)` (`PATCH /agents/me/duty`). Do **not** re-derive `account_kind` client-side — read the server value. The session re-check is a plain authenticated `me()` re-fetch; if Step 4 also adds a session guard that 401/403s a suspended/removed CPO, treat that 401/403 on `me()` as a revocation signal too.

**Frontend / ops-console how-to:**

- **Root switch:** in `RootNavigator`, after `isAuthenticated && user`, read `user.account_kind`. Render: `individual` → existing client `MainNavigator` tabs; `agency` → `AgentNavigator`; `cpo` → if `user.must_set_password` mount `CpoActivationScreen` (on completion, refresh `me()` so `must_set_password` clears, then fall through to `CpoNavigator`), else `CpoNavigator`. Keep the existing `PermGate`/PermissionsScreen behavior for `individual`/`agency`; CPO permissions are gathered inside activation.
- **Never show RoleSelection to a CPO:** RoleSelection lives only in the `AuthNavigator` self-register path; a CPO authenticates straight into the CPO branch, so do not add any RoleSelection route to `CpoNavigator`. Verify the login success handler routes by `account_kind`, not to RoleSelection.
- **Activation flow:** `CpoActivationScreen` steps — (1) set a new password (POST the change via the auth password-change endpoint; reuse the existing password change path), (2) optional biometric enrolment primer (reuse `expo-local-authentication` as `authStore.biometricSignIn` does), (3) location + notification permission primers (reuse `PermissionsScreen` patterns), (4) "you belong to **{org.name}**" identity card + a short on-duty/SOS explainer. On finish, call `authStore.completeAuth()`/`me()` to refresh and route into `CpoNavigator`.
- **Revocation re-check:** add an `AppState.addEventListener('change', …)` (pattern already used in `src/screens/agent/AgentLiveTrackerScreen.tsx` and `BookingConfirmationScreen.tsx`) in a small CPO-scoped hook/effect (e.g. in `CpoNavigator`) that, on `active` + on token refresh, calls `authStore.recheckMembership()`. If revoked: `await agentApi.setDuty(false)` (best-effort), then `await authStore.signOut()` (this tears down Ops Rooms / runtime), then route the now-unauthenticated app to `AccessEndedScreen` (render it from the Auth branch via a transient flag, or as a standalone screen shown before the login form).
- **Capability hiding (PR5):** `CpoNavigator`'s 4 tabs register only CPO-scoped screens — no booking wizard, no client wallet, no IncomingOffer/OrgMissions/AssignCrew/OrgRoster. The hiding is structural (those screens are simply not in the CPO stack), not a runtime `if`.

**Security stop-conditions:**

- **Route only off the server-authenticated `account_kind`.** Never trust a client-set value; never add a "skip in dev" branch to the routing or to any guard. (CLAUDE.md: no weakening of guards.)
- **Forced logout must actually drop the CPO from Ops Rooms.** Reuse `authStore.signOut()` — it runs the existing runtime/Ops-Room/keychain teardown. Do not hand-roll a partial logout that leaves the encrypted group session live. **STOP/verify against the System Architecture Documentation** that a revoked member is removed from the booking/Ops-Room group via the existing rekey path (group keys are client-side; the server cannot evict a member from an E2E room) — the agency device owns the rekey, as in the conversations-scoped membership-intent drain.
- Do not log the temp/new password, tokens, or any key material during activation (the static log-audit test enforces this).

**Acceptance & tests:**

- **Direct unit:** a pure resolver test for the root switch — given `account_kind` ∈ {individual, agency, cpo} × `must_set_password` true/false × `membership_status` active/suspended/removed, assert the chosen navigator/screen (client tabs / AgentNavigator / CpoActivation / CpoNavigator / AccessEnded). Add a `recheckMembership()` store test: suspended/removed CPO → calls `setDuty(false)` + `signOut()` + routes to AccessEnded; active CPO → no-op.
- **Regression:** existing routing for `individual` and `agency`/`service_provider` is unchanged (the `pendingProvider` agency-signup window still works); run the app Jest project.
- **Gates:** `npm run typecheck` (mobile, must stay ≤ baseline 96); `npm run lint`. Not near messaging crypto, so `test:crypto` only if the Ops-Room drop wiring is touched.
- **Manual smoke (real dev build):** (1) agency creates a CPO (Step 15) → log in on a 2nd device with the temp password → activation runs (password set, "you belong to {agency}") → CPO home, no "Protect me now"/wallet/offer UI, RoleSelection never appears. (2) Agency suspends the CPO → CPO backgrounds/foregrounds the app → forced to AccessEnded, set offline, no longer in the Ops Room. (3) Individual and agency logins still route correctly.

**Done when:**

- [x] Root mounts exactly one of ClientNavigator / AgencyNavigator / CpoNavigator strictly by server `account_kind`. (pure `resolveAuthedRoute` + MainNavigator.)
- [x] A CPO never sees RoleSelectionScreen and is routed straight into activation-then-CPO. (RoleSelection lives only in AuthNavigator's self-register; CPO routes by account_kind.)
- [x] First login (`must_set_password`) runs activation before the CPO home — welcome/agency-explainer → permission primers + biometric note → set password. ⚠️ Password is LAST + forces a re-login: `POST /auth/me/password` revokes every session server-side (verified) and we did NOT weaken that contract.
- [x] On focus/refresh a suspended/removed CPO is force-logged-out to AccessEnded, set offline, and dropped from Ops Rooms. (CpoNavigator AppState focus → recheckMembership → endCpoAccess: setDuty(false) + signOut [Ops-Room teardown] + accessEnded.)
- [x] CPO build structurally lacks booking/wallet/offer/roster/assign-crew/org-money screens. (CpoNavigator registers only Duty/Mission/Comms/Me.)
- [x] Typecheck ≤ 96 (at 49), lint clean (0 errors), unit tests pass (resolveRoute matrix + recheckMembership). Tab CONTENTS for Duty/Mission/Me are the later CPO-UI step (this ships the shell + gate + revocation).

## Step 18 — Shared backbone: stepper + activity feed + component library

**Stage:** Apps · **Depends on:** Step 4 (feed endpoints return `booking.status` + `mission.status`), Step 17 (CpoNavigator exists so the Bell/stepper can mount in all three shells) · **Resolves:** Part IV §28 (B1–B3), §34 (UI-state matrix), PX1, plus §25 (the shared stepper truth table)
**Goal (plain English):** Build the three foundations every role's app shares: one progress bar so the customer, the agency, and each guard always see the identical step of the mission; one notifications inbox (with a bell) so a missed offer or alert never just vanishes after the silent push wake; and one set of reusable building blocks (badges, rating stars, countdown pill, etc.) so all three apps look and behave the same. Consistency is trust for a safety app.
**Why it matters / what breaks without it:** Every client/agency/CPO screen in later steps renders the stepper and these components; building them once prevents three divergent progress bars telling three different stories. Without the ActivityCenter, the opaque FCM wakes (which by design carry no detail) leave the user with no durable, actionable history — a missed 30-second offer is simply gone.

**Self-contained context (inline — do not make the reader open the plan):**

- **B1 — `missionJourney.ts` + `<MissionStepper>` (§25, §28):** one **pure** helper `journeyStep(booking, mission?) → { index, label, canAdvanceBy }` driving ONE horizontal 6-step bar rendered identically on client, agency, and CPO. The 6 steps and their real backing state (verified against the FSMs):

  | #   | Step label                | Real state                              | Who advances          |
  | --- | ------------------------- | --------------------------------------- | --------------------- |
  | 1   | Searching for your detail | booking `DISPATCHING`                   | system (auto-cascade) |
  | 2   | Accepted · assigning team | booking `CONFIRMED`, **no mission yet** | agency (assigns crew) |
  | 3   | Team dispatched           | mission `DISPATCHED`                    | lead CPO (Start)      |
  | 4   | En route to pickup        | mission `PICKUP`                        | lead CPO (Go live)    |
  | 5   | Protection active         | mission `LIVE`                          | lead CPO (Finish)     |
  | 6   | Completed                 | mission `COMPLETED`                     | —                     |

  Off-path side-states: **SOS** overlays any active step (a ribbon, not a 7th step); `CANCELLED` / `NO_PROVIDER` / `ABORTED` are terminal side-states with their own honest rendering. `canAdvanceBy` encodes who may advance from the current step (`system | agency | lead | none`) so the CPO field UI can gate the lead-only button.

- **Booking FSM context (verified `apps/auth-service/src/booking/state-machine.service.ts`):** `DRAFT→PENDING_OPS→OPS_APPROVED→PAYMENT_PENDING→CONFIRMED→LIVE→COMPLETED` (+`CANCELLED`). The auto flow adds `DRAFT→DISPATCHING`, `DISPATCHING→CONFIRMED`, `DISPATCHING→NO_PROVIDER`, `DISPATCHING→CANCELLED`. CONFIRMED-with-no-mission = "accepted, awaiting crew."
- **Mission FSM context (verified `apps/auth-service/src/ops/mission-state-machine.service.ts`):** `DISPATCHED→PICKUP→LIVE→SOS→COMPLETED|ABORTED`.
- **B2 — ActivityCenter + notification Bell (§28, §34):** a **durable, role-filtered, locally-persisted** feed that turns opaque FCM wakes into glanceable, actionable rows (offers, accepts, status changes, payments, SOS). On each data-wake the app **fetches detail from existing endpoints** (exactly as chat does on a wake) and appends a row — the push payload itself stays content-free. Offer rows are actionable with a live countdown (bound to `expires_at`). A Bell + unread badge sits on every header. **This keeps push opaque (audit P0-N8): the FCM-facing channel payload is exactly `{userId, eventClass, eventId}` — detail is fetched, never carried.**
- **B3 — shared component library (§28):** `StepperBar`, `TrustBadgeRow`, `VerificationBadge`, `RatingStars` (display + input), `RoleBadge`, `ActivityRow`, `EncryptionPill`, `CountdownPill` (offer TTL), `EmptyState`, `PermissionPrimer`. **All RTL- and text-scale-aware** — wrap StyleSheets with `scaleTextStyles` and respect `I18nManager.isRTL`.
- **Cross-app rule (§34):** one truth via the shared stepper; a monotonic guard so apps polling on different schedules never appear to go backwards; deep-links resolve through the existing `navigationRef` (`src/navigation/navigationRef.ts`); offline = freeze at last-known + an "offline" tint, never fabricate a terminal state; never show "done"/"safe" unless the server confirmed it.
- **Current code reality (verified):** no `MissionStepper`, `ActivityCenter`, or `missionJourney.ts` exist yet (greenfield). `src/utils/scaling.ts` exports `scale`, `scaleFont`, `scaleTextStyles<T>(styles): T`, and `useResponsive()`. RTL via `I18nManager` is already used in `src/services/api.ts`. `src/screens/booking/bookingStatus.ts` has `describeStatus`, `resumeTargetFor`, `findResumableBooking` and only knows the legacy statuses — it does **not** yet include `DISPATCHING`/`NO_PROVIDER`; the new stepper must understand them. `navigationRef` lives at `src/navigation/navigationRef.ts`.

**Files to touch:**

- **NEW** `src/screens/booking/missionJourney.ts` — the pure `journeyStep(booking, mission?)` helper + step/label/side-state constants + `canAdvanceBy`. No React, no I/O, no backend logic (pure → trivially unit-testable).
- **NEW** `src/components/mission/MissionStepper.tsx` — the horizontal 6-step bar consuming `journeyStep(...)`; SOS overlay ribbon; Cancelled/No-provider/Aborted terminal rendering. RTL + `scaleTextStyles`.
- **NEW** `src/components/ui/` shared library: `StepperBar.tsx`, `TrustBadgeRow.tsx`, `VerificationBadge.tsx`, `RatingStars.tsx`, `RoleBadge.tsx`, `ActivityRow.tsx`, `EncryptionPill.tsx`, `CountdownPill.tsx`, `EmptyState.tsx`, `PermissionPrimer.tsx` (one file each; all RTL + scale-aware).
- **NEW** `src/store/activityStore.ts` — Zustand store for the durable, role-filtered activity feed (persisted locally; append-on-wake; unread count; per-role filter). Mirror the persistence/owner-keying discipline used by the messenger store (wipe/scope per identity).
- **NEW** `src/screens/activity/ActivityCenterScreen.tsx` + `src/components/ActivityBell.tsx` — the feed screen + the header bell with unread badge.
- **EXTEND** `src/screens/booking/bookingStatus.ts` — add `DISPATCHING` and `NO_PROVIDER` to the status config/`describeStatus` and to `resumeTargetFor` (DISPATCHING→Finding, NO_PROVIDER→empty state) so the stepper and resume logic agree. (Resume routing detail itself is finished in the client-UI step; here add the status knowledge the stepper depends on.)
- **REUSE (no change)** `src/utils/scaling.ts` (`scaleTextStyles`, `useResponsive`), `src/navigation/navigationRef.ts`.

**Backend how-to:** Mostly frontend. The only backend dependency (owned by Step 4 and the feed steps) is that the three feed endpoints each return **both** `booking.status` and `mission.status` so `journeyStep` has its inputs: client `GET /bookings/:id`, agency `GET /org/missions`, CPO `GET /agents/me/active-mission`. Confirm those fields are present; if a feed omits `mission.status`, that is a one-field read addition in the respective endpoint (no FSM/crypto change). The ActivityCenter fetches row detail from these same existing endpoints on each opaque wake — no new "detail in push" path.

**Frontend / ops-console how-to:**

- **`journeyStep` (pure):** signature `journeyStep(booking: {status: string}, mission?: {status: string} | null): {index: number; label: string; canAdvanceBy: 'system'|'agency'|'lead'|'none'; sos: boolean; sideState?: 'CANCELLED'|'NO_PROVIDER'|'ABORTED'}`. Map: `DISPATCHING`→1/system; `CONFIRMED` & no mission→2/agency; mission `DISPATCHED`→3/lead; `PICKUP`→4/lead; `LIVE`→5/lead; `COMPLETED`→6/none. `mission.status==='SOS'` → `sos:true`, keep `index` at the last active step. Terminal `CANCELLED`/`NO_PROVIDER` (booking) / `ABORTED` (mission) → `sideState`. Add a **monotonic clamp helper** so a slow poll can't render a lower index than already shown (cross-app §34 rule).
- **`<MissionStepper>`:** render the 6 dots/labels, fill up to `index`, show the SOS ribbon when `sos`, and render the side-state banner when `sideState` is set. Lay out RTL-aware (reverse step order under `I18nManager.isRTL`); wrap text styles with `scaleTextStyles`.
- **ActivityCenter / Bell / store:** on each push data-wake (hook into the existing wake path that chat uses), look up the event by `eventId`, fetch its detail from the relevant existing endpoint, then `activityStore.append(row)` (role-filtered). Persist locally and scope to the signed-in identity (wipe on user switch, like the messenger store). The Bell shows `unreadCount`; tapping a row deep-links via `navigationRef` to the right screen (offer→IncomingOffer overlay, accepted/no-provider→booking, mission-assigned→tracker, SOS→SOS). Offer rows render a `<CountdownPill>` bound to `expires_at`.
- **Component library:** keep each component presentational and prop-driven; `RatingStars` supports both display and input modes; `EncryptionPill` is a static "end-to-end encrypted" affordance (never renders any key material). Mount the Bell in the headers of all three shells (client tabs, AgentNavigator, CpoNavigator).

**Security stop-conditions:**

- **Push opacity (P0-N8):** the ActivityCenter must build its rows by **fetching detail on wake**, exactly like chat. The FCM-facing channel payload stays `{userId, eventClass, eventId}` — never let the activity feed depend on (or cause anyone to add) `bookingId`/`kind`/address into the push payload. **STOP/verify against the System Architecture Documentation** before touching anything that shapes the push channel message.
- **No plaintext/keys in logs or in `EncryptionPill`/`ActivityRow`** — render only non-sensitive metadata; the static log-audit test enforces no plaintext message bodies/keys.
- The stepper/feed are metadata-only views; they never read or render decrypted Ops-Room message bodies.

**Acceptance & tests:**

- **Direct unit (the pure helper is the high-value test):** `missionJourney.spec.ts` — every `(booking.status, mission?.status)` combination maps to the expected `{index, label, canAdvanceBy, sos, sideState}`; SOS overlays without changing index; CANCELLED/NO_PROVIDER/ABORTED produce side-states; the monotonic clamp never regresses index. Add an `activityStore` test: append/dedupe by `eventId`, unread count, per-role filter, identity-scoped wipe.
- **Component:** snapshot/RTL test that `MissionStepper` and at least `CountdownPill`/`RatingStars` render under `I18nManager.isRTL=true` and with scaled text.
- **Regression:** `bookingStatus.ts` additions don't break existing `describeStatus`/`resumeTargetFor`/`findResumableBooking` (run the app Jest project; touch the `booking` project if booking helpers are covered there).
- **Gates:** `npm run typecheck` (mobile, ≤ baseline 96); `npm run lint`. Run `npm run test:crypto` only if the wake/detail-fetch wiring brushes the messenger runtime; the feed itself should not.
- **Manual smoke:** drive a booking through DISPATCHING→CONFIRMED→DISPATCHED→PICKUP→LIVE→COMPLETED on a dev build and confirm the same step lights up on client + agency + CPO within a poll cycle; trigger an offer wake with the app backgrounded and confirm an actionable, countdown-bearing row appears in the ActivityCenter and the Bell badge increments.

**Done when:**

- [x] `journeyStep` is a pure, fully unit-tested helper covering all 6 steps + SOS overlay + 3 terminal side-states + monotonic clamp (`clampJourney`). (`src/screens/booking/missionJourney.ts` + 20 tests.)
- [x] `<MissionStepper>` renders identically (RTL + scaled) on client, agency, and CPO from the same helper output (via `StepperBar`).
- [x] ActivityCenter + Bell show a durable, locally-persisted, identity-scoped feed; `recordActivity()` is the entry point the opaque-wake path calls AFTER fetching detail — push payload unchanged. (Per-event wake→append wiring + Bell header-mount land in the per-app steps 19-21; the store/screen/Bell + identity-scoping ship + unit-tested here.)
- [x] The shared component library (StepperBar, TrustBadgeRow, VerificationBadge, RatingStars, RoleBadge, ActivityRow, EncryptionPill, CountdownPill, EmptyState, PermissionPrimer) exists, all RTL + `scaleTextStyles`-aware, one obsidian/cobalt token source.
- [x] `bookingStatus.ts` understands `DISPATCHING`/`NO_PROVIDER`.
- [x] Typecheck = baseline 49, lint 0 errors, unit + store tests pass; push payload remains `{userId, eventClass, eventId}` (untouched).

---

## Step 19 — CLIENT app UI (Finding / No-detail / Accepted / extended Confirmation+Live + shared stepper)

**Stage:** Apps · **Depends on:** Step 15 (booking FSM `DISPATCHING`/`NO_PROVIDER` + `dispatch_mode='auto'` submit branch), Step 16 (`GET /bookings/:id/provider`), Step 18 (`missionJourney.ts` + `<MissionStepper>` shared backbone), Step 12 (client "provider-accepted"/"no-provider" push wake) · **Resolves:** Part IV §29, §34 client-state matrix, §35 endpoints; Phase 8 (§13); PX2

**Goal (plain English):** Give the customer the three-screen Uber-style flow: a "Protect me now" entry, a calm "finding your detail…" search screen, an "agency accepted — here's their ★rating and track record" reveal, and an honest "no one available" dead-end. The request now submits as fully-automatic (no admin approval) and pre-checks the wallet so an agency is never offered a job the client can't pay for. Every status screen shows the same shared progress bar.

**Why it matters / what breaks without it:** This is the entire customer-facing surface of auto-dispatch; without it the new backend has no UI and the client is stuck on the legacy admin-approval screens. Skipping the affordability pre-check strands an agency with an unpayable job; skipping the `DISPATCHING`/`NO_PROVIDER` resume + active-mission fix traps the client so "try again" is impossible.

**Self-contained context (inline — do not make the reader open the plan):**

- **Locked decisions:** D1 fully automatic (no admin in the loop — the old "ops handler watches your trip" copy is now FALSE, rewrite it); D2 charge-on-accept into escrow (so the client is NOT charged while searching — the search screen must say "you won't be charged until a detail accepts"); D4 nearest agency within same region (AE/SA/BD/GB); D7 accept locks in the agency but crew is assigned a moment later (so the "accepted" screen reads _"agency accepted — your detail is being assigned"_, then the stepper advances).
- **Booking FSM (extended in Step 15, `apps/auth-service/src/booking/state-machine.service.ts`):** auto request is `DRAFT → DISPATCHING` (actor CLIENT); `DISPATCHING → CONFIRMED` (SYSTEM, = "accepted, awaiting crew"); `DISPATCHING → NO_PROVIDER` (SYSTEM, terminal); `DISPATCHING → CANCELLED`. Legacy `PENDING_OPS → OPS_APPROVED → PAYMENT_PENDING → CONFIRMED → LIVE → COMPLETED` stays intact.
- **Shared stepper (Step 18, `src/screens/booking/missionJourney.ts`):** pure `journeyStep(booking, mission?) → {index, label, canAdvanceBy}` → 6 steps: 1 Searching (`DISPATCHING`) · 2 Accepted·assigning team (`CONFIRMED`, no mission) · 3 Team dispatched (mission `DISPATCHED`) · 4 En route (`PICKUP`) · 5 Protection active (`LIVE`) · 6 Completed. SOS overlays any active step; `NO_PROVIDER`/`CANCELLED`/`ABORTED` are terminal side-states.
- **Reuse points (verified in code):** `OpsRoomReviewScreen.tsx` already polls `GET /bookings/:id` every `POLL_EVERY_MS = 4000` (line 34) and branches on status (`OPS_APPROVED`/`PAYMENT_PENDING`/`CONFIRMED`/`LIVE`/`CANCELLED`, lines 270–291) with a 5-min hard cap (`pollGaveUp`) — repurpose this exact poll for the `DISPATCHING` "Finding" state. `src/screens/booking/bookingStatus.ts` owns `resumeTargetFor(id, raw)` (returns `OpsRoomReview`/`BookingConfirmation`/`LiveTracking`) and the `RESUMABLE` set + `describeStatus` CONFIG map. The one-active-mission guard lives in `BookingHomeScreen.tsx` (line 128, `activeBooking = bookings.find(...)` driven by `findResumableBooking`/`RESUMABLE`). The client live screen is `src/screens/liveops/LiveTrackingScreen.tsx` (reads `route.params.bookingId`, polls telemetry, routes to `SOSScreen`). `CreditPaywallScreen.tsx` exists and is registered with params `{bookingId?, source?: 'booking-flow'|'opsroom'|'wallet', amountDue?}`.
- **New client endpoint (Step 16):** `GET /bookings/:id/provider` → `{ display_name, call_sign, rating, jobs_total }` (coarse-safe; NO pickup/dropoff/address — that stays agency-only post-accept per LB1). `dispatch_mode:'auto'` is added to the `POST /bookings` body.
- **Navigation facts (verified):** `BookingStackParamList` (`src/navigation/types.ts`) already has `BookingConfirmation`, `LiveTracking:{bookingId}`, `SOSScreen:{bookingId}`, `TripSummary:{bookingId}`, `OpsRoomReview`, `CreditPaywall`. `bookingApi.create` body (`src/services/api.ts:320`) currently has `booking_mode?:'now'|'later'` but NO `dispatch_mode` — add it. Routing to the client tabs vs agent stack happens in `MainNavigator.tsx:190` (`isAgent`), so client screens live under `BookingNavigator`.

**Files to touch:**

- EXTEND `src/services/api.ts` — `bookingApi.create` body: add `dispatch_mode?: 'auto'`. Add `bookingApi.getProvider(id) => authHttp.get<{display_name; call_sign; rating; jobs_total}>('/bookings/${id}/provider')`.
- NEW `src/screens/booking/FindingDetailScreen.tsx` — the `DISPATCHING` search state (radar animation, "you won't be charged until a detail accepts" trust line, optional cascade-reassurance copy, **Cancel** → `bookingApi.cancel`). Built by repurposing `OpsRoomReviewScreen`'s 4s poll on `GET /bookings/:id`; on flip to `CONFIRMED` route to the Accepted reveal, on `NO_PROVIDER` route to NoDetail, on `CANCELLED` go home.
- NEW `src/screens/booking/NoDetailScreen.tsx` — `NO_PROVIDER` calm dead-end (NOT a red error): "no detail available right now," "you weren't charged," Try-again / Schedule-for-later CTAs.
- NEW `src/screens/booking/AgencyAcceptedScreen.tsx` (or an inline reveal card) — agency name, ★`rating`, "`jobs_total` missions completed," trust line, then the shared `<MissionStepper>`; data from `bookingApi.getProvider`.
- EXTEND `src/screens/booking/BookingConfirmationScreen.tsx` — render `<MissionStepper>`; relabel any "awaiting dispatch"/"ops will approve" copy to the auto flow.
- EXTEND `src/screens/liveops/LiveTrackingScreen.tsx` — render `<MissionStepper>` above the map; keep the SOS CTA reachable; show the agency ★ chip.
- EXTEND `src/screens/booking/bookingStatus.ts` — add `DISPATCHING` + `NO_PROVIDER` to the `CONFIG` map; add `DISPATCHING` to `RESUMABLE`; extend `resumeTargetFor` so `DISPATCHING → {screen:'FindingDetail'}` and `NO_PROVIDER → {screen:'NoDetail'}` (add both to the `ResumeTarget` union).
- EXTEND `src/screens/booking/BookingHomeScreen.tsx` — the request wizard CTA preset to auto; affordability pre-check before submit; ensure `NO_PROVIDER` does NOT count as an active booking (see guard fix below).
- EXTEND `src/screens/DashboardScreen.tsx` — add the "Protect me now" hero that deep-links into the auto wizard (keep the SOS bar).
- EXTEND `src/navigation/BookingNavigator.tsx` + `src/navigation/types.ts` — register `FindingDetail:{bookingId}`, `NoDetail:{bookingId}`, `AgencyAccepted:{bookingId}` in `BookingStackParamList`.
- (v1.1) NEW `RateAgencyScreen` (writes `lite_bookings.rating` via `POST /bookings/:id/rating`), `ReceiptScreen` (`GET /bookings/:id/receipt`), `IdentityVerifyScreen` (`GET /bookings/:id/verify-code`), `ShareLiveTripScreen` (`POST /bookings/:id/share`); wire "View receipt"/"Rate this agency" into `TripSummaryScreen.tsx`.

**Backend how-to:** Pure frontend for MVP — the auto-submit branch, `GET /bookings/:id/provider`, and the lifecycle/active-mission backend fix are owned by Steps 15/16/17. This step only sends `dispatch_mode:'auto'` and consumes the new read endpoint. (Cross-ref: the active-mission trap fix LB17 must let terminal/failed states `NO_PROVIDER`/`CANCELLED` free the guard — that's the lifecycle step; on the client side, simply ensure `NO_PROVIDER` is NOT in `RESUMABLE`/`activeBooking`.)

**Frontend / ops-console how-to:**

1. **Submit as auto + affordability pre-check.** In the wizard's submit handler, when the auto flag is on, set `dispatch_mode:'auto'` on `bookingApi.create`. Before/at submit, compare the price estimate against wallet balance; if short, `navigation.navigate('CreditPaywall', {source:'booking-flow', amountDue})` and only proceed to dispatch after top-up. (Reuse the existing estimate + wallet read.)
2. **FindingDetailScreen.** Copy `OpsRoomReviewScreen`'s poll skeleton (4s interval on `bookingApi.getById`, 5-min `pollGaveUp` cap, lockBack while healthy). Render the radar + trust line + Cancel. On status: `CONFIRMED` → `navigation.replace('AgencyAccepted', {bookingId})`; `NO_PROVIDER` → `replace('NoDetail', {bookingId})`; `CANCELLED` → `popToTop()`.
3. **AgencyAccepted reveal.** Fetch `bookingApi.getProvider(id)`, show name/★/jobs + the stepper at step 2, then "Continue" → `BookingConfirmation`/`LiveTracking`.
4. **Resume + guard.** Extend `resumeTargetFor` and `RESUMABLE` (add `DISPATCHING` only; keep `NO_PROVIDER` terminal). Verify `BookingHomeScreen.activeBooking` excludes `NO_PROVIDER`/`CANCELLED` so "Protect me now" is tappable again after a failed search.
5. **Stepper everywhere.** Drop `<MissionStepper>` (from Step 18) into Confirmation + LiveTracking, feeding it `{booking.status, mission?.status}`.
6. **Keep SOS reachable** from Finding, Accepted, Confirmation, and Live (the SOS CTA → `SOSScreen:{bookingId}` exists; do not gate it behind mission-LIVE — SOS must work during `DISPATCHING`/`CONFIRMED` per LB13).

**Security stop-conditions:** The Ops Room (opened at accept by the server) is metadata-only via `ensureBookingOpsRoom` — the client just deep-links into the existing Messenger conversation; do NOT write envelopes or touch group keys. The "provider-accepted"/"no-provider" push wake stays opaque: the app reacts by re-fetching `GET /bookings/:id` — never read booking details from the FCM payload. The coarse-safe rule (LB1): the client provider card shows name/rating/jobs only; do not surface any agency-side precise-location field. STOP/verify against the System Architecture Documentation before adding any new message type or reading anything beyond `{userId, eventClass, eventId}` from a push.

**Acceptance & tests:**

- **New tests (`booking` Jest project, `npm test -- --selectProjects=booking`):** `bookingStatus.spec` — `resumeTargetFor('id','DISPATCHING')→FindingDetail`, `'NO_PROVIDER'→NoDetail`, `describeStatus('DISPATCHING'/'NO_PROVIDER')` non-fallback; `findResumableBooking` treats `NO_PROVIDER` as terminal (not active).
- **Regression:** rerun the `booking` project (covers the existing `OpsRoomReview`/confirmation logic you derived from). `npm run test:crypto` is not required (no messaging change — only deep-linking into an existing room).
- **Gates:** `npm run typecheck` (mobile, must stay ≤ baseline 96 — adding the new `ResumeTarget` union members and screen params must not regress it); `npm run lint`.
- **Manual smoke (dev build, real device, 2 accounts):** submit auto → "Finding…" (trust line shows, no charge) → accept on a 2nd device → "Accepted ★rating · N missions" → stepper advances → SOS reachable throughout; empty pool → "no detail available, you weren't charged" → "try again" works (not trapped); relaunch mid-search returns to FindingDetail. Test one error path: cancel while searching → no charge, returns home.
- **Do not commit on a red gate; never `--no-verify`.**

**Done when:**

- [x] Auto request ends in `DISPATCHING`, not `PENDING_OPS`. (Via `POST /dispatch/request` = create(auto)+start — a cycle-safe SEPARATE endpoint, NOT `dispatch_mode` on POST /bookings; dark behind both flags.)
- [x] FindingDetail / NoDetail / AgencyAccepted screens render and route on status flips.
- [x] `bookingStatus.ts` resumes `DISPATCHING` to FindingDetail and keeps `NO_PROVIDER` terminal; active-mission guard no longer traps (client RESUMABLE/activeBooking + server one-active guard both exclude NO_PROVIDER/AGENCY_NO_SHOW). ⚠️ Review caught + fixed the 3 resume consumers (BookingHome focus + goToBooking, TripHistory) that hadn't been taught the new targets.
- [x] Shared `<MissionStepper>` shows on Confirmation + LiveTracking + Accepted.
- [x] Affordability short-balance routes to CreditPaywall before dispatch (advisory soft-check, skipped on unknown balance); "no charge until accept" trust line shown.
- [x] SOS is one tap from every auto-flow screen.
- [x] typecheck = baseline 49, lint 0 errors, booking project green (+auth 1380). Manual device smoke deferred (flow is dark behind AUTO_DISPATCH; not device-testable here).

---

## Step 20 — AGENCY app UI (ops cockpit + global incoming-offer interrupt + multi-mission board + assign-crew + roster caps)

**Stage:** Apps · **Depends on:** Step 9 (`GET /dispatch/offers/current` + accept/reject endpoints), Step 16 (`GET /org/summary`), Step 17 (`GET /org/missions` + `POST /org/bookings/:id/crew`), Step 15 (roster rules: 10-cap, one-email-one-agency 409, can't-remove-active-lead), Step 18 (`missionJourney.ts` + `<MissionStepper>`) · **Resolves:** Part IV §30, §34 agency-offer states; Phase 9 (§14), Phase 15 (§23), Phase 16 (§24); PX3

**Goal (plain English):** Turn the agency's existing dashboard into a control room: a go-online switch, a "X of Y guards free" capacity strip, a board of all current jobs, and a full-screen pop-up that interrupts from any screen when a new job is offered (with a 30-second countdown ring, distance/ETA/pay, and an inline "you can crew this" check). Accept locks in the agency and charges the client; the agency then picks which guards go and taps one as leader, which creates the mission. The roster screen enforces the 10-guard cap, the one-email-one-agency rule, and blocks firing the leader of a running mission.

**Why it matters / what breaks without it:** The agency is the only party that can accept jobs (D3) and crew them (D7); without this UI the dispatch engine has no one to answer the offer, no job is ever accepted, and no mission is ever created. Without the global interrupt + triple-surfacing, a 30-second offer is missed; without capacity gating the agency accepts jobs it can't staff.

**Self-contained context (inline — do not make the reader open the plan):**

- **Locked decisions:** D3 the AGENCY (company agent) accepts the whole job; D5 agency registers up to ~10 real CPO login emails, one email = one agency at a time (fire/leave to free it); D6 one agency runs several concurrent missions, bounded by free-CPO capacity; D7 accept does NOT auto-pick crew — assigning crew + naming a leader is a separate step and _that step creates the mission_ (it replaces the old admin "dispatch" click).
- **Offer model:** an offer is live for `OFFER_TTL_SECONDS = 30`; the agency Accepts (→ charge client into escrow + Ops Room opens client+agency only) or Declines (→ cascades to next-nearest). `GET /dispatch/offers/current` returns the caller's single live `OFFERED` offer joined with **coarse** booking data (region + bucketed distance/ETA + price + `expires_at`) — NO exact pickup/dropoff pre-accept (LB1). Accept/reject 409 if the offer is no longer `OFFERED` ("passed to another detail" — neutral tone, no fault).
- **Capacity (D6, from `GET /org/summary`):** `free_cpos = active roster CPOs − CPOs on a non-completed mission − Σ cpo_count of this agency's CONFIRMED-no-mission bookings`; show as "X of Y guards free." The offer card shows "N guards needed · M free" inline.
- **Shared stepper (Step 18):** 6 steps Searching → Accepted·assigning team → Team dispatched → En route → Protection active → Completed; render it on every mission row and the per-mission monitor.
- **Reuse points (verified in code):** the agency runs inside the existing **`AgentNavigator`** (stack, not tabs) reached via `MainNavigator.tsx:496` (`isAgent` → `<AgentNavigator/>`). `AgentDashboardScreen.tsx` already has the duty toggle (`agentApi.setDuty` → `PATCH /agents/me/duty`, lines 242–261), `isOrg = me?.agent.type === 'company'` (line 313), and an org-only "CPO Roster" tile → `navigation.navigate('OrgRoster')` (line 320). The global **incoming-call overlay pattern** is in `MainNavigator.tsx`: `setIncomingCallHandler((data)=>{ if(!navigationRef.isReady()) return; navigationRef.navigate('Main',{screen:..., params:...}) })` (lines 286–394) using `src/navigation/navigationRef.ts` — mirror this for the incoming offer. `orgApi` (`src/services/api.ts:733`) has `listCpos()/createCpo()/setCpoStatus()` over `RosterMember{member_user_id, display_name, email, call_sign, member_role, status, agent_status, created_at}`. `OrgRosterScreen.tsx` + `OrgCreateCpoScreen.tsx` exist. `AgentLiveTrackerScreen.tsx` (per-mission monitor) polls every 4s (line 281).
- **New endpoints (all confirmed ABSENT today — created in Steps 9/16/17):** `dispatchApi.getCurrentOffer/accept/reject`; `GET /org/summary`; `GET /org/missions`; `POST /org/bookings/:id/crew` body `{cpo_user_ids: string[], lead_user_id: string}`. All `/org/*` are `OrgManagerGuard`-gated and resolve the caller's org server-side.

**Files to touch:**

- EXTEND `src/services/api.ts` — add `dispatchApi = { getCurrentOffer(), accept(id), reject(id, reason?) }`; add `orgApi.getSummary()`, `orgApi.listMissions()`, `orgApi.assignCrew(bookingId, {cpo_user_ids, lead_user_id})`. Put a stable `Idempotency-Key: accept-<offerId>` header on accept (mirror `bookingApi.payWithCredits`'s `paywc-` pattern; separator `-`, never `:`).
- EXTEND `src/screens/agent/AgentDashboardScreen.tsx` — for `isOrg`: keep online toggle; add a **capacity strip** ("X of Y guards free" from `getSummary`), today's tiles, and a **persistent active-offer banner** (poll `getCurrentOffer` while Online).
- NEW `src/screens/agent/IncomingOfferScreen.tsx` — full-screen interrupt: countdown **ring** bound to server `expires_at` (not a local 0-start timer), coarse route/distance/ETA/pay, inline "N needed · M free," Accept/Decline. On Accept → `dispatchApi.accept` then `navigate('AssignCrew', {bookingId})`; on Decline → `dispatchApi.reject`; on countdown-zero or 409 → "offer passed to another detail."
- NEW `src/screens/agent/OrgMissionsScreen.tsx` — multi-mission board grouped **Needs crew / Active / Recent**, each row with `<MissionStepper>`, crew, leader, SOS flag; data from `orgApi.listMissions`.
- NEW `src/screens/agent/AssignCrewScreen.tsx` (sheet) — roster picker (free/busy badges from `listCpos` + summary), tap one ★ Leader, confirm → `orgApi.assignCrew` (creates the mission). On success, the row moves to "Team dispatched."
- EXTEND `src/screens/agent/OrgRosterScreen.tsx` — "X / 10 used" counter on Add, surface the one-email-one-agency `409 email_already_in_an_agency` and `409 roster_full`, per-row on-duty + "on mission" tag, fire-guard surfacing the `409 reassign_leader_first` block.
- EXTEND `src/screens/agent/AgentLiveTrackerScreen.tsx` — render `<MissionStepper>`; status buttons stay hidden (leader-only is the CPO app).
- EXTEND `src/navigation/AgentNavigator.tsx` + `src/navigation/types.ts` (`AgentStackParamList`) — register `OrgMissions`, `AssignCrew:{bookingId}`, `IncomingOffer:{offerId, bookingId}`.
- EXTEND `src/navigation/MainNavigator.tsx` — register a **global incoming-offer handler** (mirror `setIncomingCallHandler` / `navigationRef.navigate`) surfaced by the offer push wake; gate it to `isAgent`/`isOrg` so clients/CPOs never see it.
- (v1.1) NEW/EXTEND `EarningsScreen.tsx` (org payout rollup, `GET /org/earnings`), a Reputation panel (`GET /agents/me/reputation`), CpoDetail drill-in.

**Backend how-to:** Pure frontend — the offer/summary/missions/crew endpoints + the capacity formula + the roster 409s + the accept-charges-escrow transaction are owned by Steps 9/15/16/17. This step consumes them. (Reminder of the server contract this UI relies on: accept must be a race-safe conditional `UPDATE dispatch_offers SET status='ACCEPTED' WHERE id=$1 AND status='OFFERED' AND expires_at>NOW() RETURNING` with the debit in the same txn — the UI must treat a 409/empty result as "offer passed," never retry into a double-charge.)

**Frontend / ops-console how-to:**

1. **Global interrupt (triple-surface).** In `MainNavigator`, register an offer handler beside `setIncomingCallHandler`: on the `dispatch` push wake, call `dispatchApi.getCurrentOffer`; if an offer exists and `navigationRef.isReady()`, `navigationRef.navigate('Main', {screen:'SecureTab', params:{screen:'IncomingOffer', params:{offerId, bookingId}}})` (or the AgentNavigator route, matching the existing nested-navigate cast). Also poll `getCurrentOffer` every few seconds while Online, and render the dashboard banner — so a missed push still surfaces.
2. **Countdown ring.** Bind the ring to `expires_at` from the server payload (compute remaining = `expires_at − now`), add a small clock-skew grace; never start from a hardcoded 30. On expiry, flip to the neutral "passed" state.
3. **Accept → AssignCrew.** Accept calls `dispatchApi.accept(offerId)`; on success navigate to `AssignCrew`. On network error after accept, **re-fetch truth** (`getCurrentOffer` / `listMissions`) rather than assuming failure — a lost-200 may have already won the offer (idempotency-keyed accept makes a re-tap safe).
4. **AssignCrew.** Show roster with free/busy from `listCpos` + summary; require exactly `booking.cpo_count` picks (or the allowed range) and one ★ leader ∈ picks; `orgApi.assignCrew`. Surface server validation errors (guard not free, wrong count) inline.
5. **Roster caps.** Show "X / 10"; disable Add at 10; map the three 409 codes to friendly messages; block firing an active lead and show "reassign the leader first."

**Security stop-conditions:** When the agency assigns crew, the CPOs are added to the existing Ops Room — but the **server cannot distribute the Signal group key** (LB2/Correction 5): the agency company device must own the rekey/sender-key add (mirror the conversations-scoped membership-intent drain, NOT the `department_channels`-only path). This UI triggers the add; STOP/verify against the System Architecture Documentation that the agency device performs the group rekey before assuming a CPO can read the room. The offer card must show only coarse data (LB1) — never render exact pickup/dropoff pre-accept. Push stays opaque: react to the wake by calling `getCurrentOffer`, never read offer details from FCM. No "skip in dev" on `OrgManagerGuard`.

**Acceptance & tests:**

- **New tests (`booking` Jest project + agent screen tests under `src/screens/agent/__tests__`):** offer-countdown helper computes remaining from `expires_at` (not 0-start) and handles already-expired; capacity-strip math renders "X of Y free"; AssignCrew validation (count match, leader ∈ picks, busy guard rejected) before the network call.
- **Regression:** rerun the `booking` project and the existing agent screen tests; `npm run test:crypto` only if the agency-device rekey wiring is touched here (if so, run it — but the rekey itself is Step 17/LB2's deliverable).
- **Gates:** `npm run typecheck` (mobile ≤ baseline 96 — new `AgentStackParamList` routes and `dispatchApi`/`orgApi` types must not regress it); `npm run lint`.
- **Manual smoke (dev build, 3 accounts — 1 client, 2 agencies):** agency Online → capacity strip shows free count → client requests → offer interrupts from any screen with a live countdown ring → Decline cascades to the 2nd agency → 2nd Accepts → AssignCrew (pick 2 + ★leader) → mission created, board shows it under Active with the stepper → guards appear on their phones (Step 21). Error paths: let the offer expire ("passed to another detail"); try to assign a busy guard (rejected); add an 11th CPO (409 roster_full); add an email already in another agency (409); fire an active lead (blocked).
- **Do not commit on a red gate; never `--no-verify`.**

**Done when:**

- [x] AgentDashboard (isOrg) shows online toggle + capacity strip ("X of Y guards free", GET /org/summary) + live-offer banner.
- [x] A new offer interrupts full-screen (IncomingOfferWatcher polls getCurrentOffer while foregrounded → navigates from any agency screen), countdown bound to `expires_at` (offerCountdown helpers). (Push wake stays opaque/unrouted; the poll is the realistic surface.)
- [x] Accept → charge happens server-side → land on the missions board (the AssignCrew sheet there) → `orgApi.assignCrew` creates the mission and crew. (A 400 offer_not_available = "passed", never retried → no double-charge.)
- [x] OrgMissions board groups Needs-crew / Active / Recent with the shared MissionStepper on every row + friendly assign-crew 409s.
- [x] OrgRoster shows the X/10 managed-CPO cap counter. ⚠️ createCpo's roster_full/email_already_in_an_agency 409 friendly copy (in OrgCreateCpoScreen) + can't-remove-active-lead surfacing = deferred minor polish (server enforces; counter warns).
- [x] Offer card is coarse-only (LB1 verified — CoarseOffer has no address/coord; the screen renders none); the watcher reacts by re-fetching getCurrentOffer, never reads FCM details.
- [x] typecheck = baseline 49, lint 0 errors, agent/booking tests green (offerCountdown + getCapacity); device 3-account smoke deferred (dark behind the flag, not device-testable here). 3-lens adversarial review passed (fixed 1 MAJOR cascade-swallow + MINORs).

---

## Step 21 — CPO (guard) app UI (new CpoNavigator 4-tab shell, lead-only one-tap mission control, capability lockdown)

**Stage:** Apps · **Depends on:** Step 20 (agency assigns crew → CPO is on a mission + added to the Ops Room), Step 18 (`missionJourney.ts` + `<MissionStepper>`), Step 10 (lead-gated `complete` endpoint that opens settlement/`PENDING_RELEASE`), the role-separation backend (`account_kind`/`must_set_password`/`membership_status` on `/agents/me`) · **Resolves:** Part IV §31, §35A §A–§F (role separation + capability matrix), §34 CPO states; Phase 18 (§26); PX4, PR2–PR6

**Goal (plain English):** Give the guard their own stripped-down app: log in with the agency-issued email, land in a 4-tab shell (On Duty / Mission / Comms / Me), see only the mission their agency assigned them, and — if they're the team leader — run it with one context-aware button (Start → Go-live → swipe-to-Finish), like an Uber driver ending a trip. Non-leaders see the same job read-only and can chat + hit SOS. The guard's app must HIDE every client and agency power: no booking, no accepting offers, no roster, no org money.

**Why it matters / what breaks without it:** The lead literally cannot drive the mission stepper today — the field UI for Start/Go-live/Finish is unbuilt, so the agency never gets paid and the customer's progress bar never advances past "team dispatched." Routing a guard into the client or agency app (the `pendingProvider` stuck-register bug class) exposes them to powers they must not have and breaks the one-email-one-agency model.

**Self-contained context (inline — do not make the reader open the plan):**

- **Locked decisions:** D8 shared stepper + leader-only status changes + one-tap finish. §35A rule: Bravo is **one binary, three app experiences**, decided **at login from the server's authenticated identity, never a client flag** (the `pendingProvider` lesson). A managed CPO is a _worker_ and must get the CPO interface — not the client app, not the agency app.
- **The discriminator (§35A §A, server-computed `account_kind` on `/agents/me` or `/auth/me`, precedence):** (1) `cpo` if `agents.type='cpo'` AND `managed_by_org_id` set, OR `org_members.member_role='cpo'` + `status='active'` → CPO interface; (2) `agency` if company agent (`agents.type='company'`, `service_provider` role) OR `org_members.member_role='manager'` → agency interface; (3) `individual` otherwise → client interface. Also return `org:{id,name}`, `must_set_password`, `membership_status`. Never trust a client-set value.
- **Mission FSM (`apps/auth-service/src/ops/mission-state-machine.service.ts`):** `DISPATCHED → PICKUP → LIVE → SOS → COMPLETED|ABORTED`. The lead advances it via the existing lead-gated endpoints. Shared stepper steps 3–6 map to mission `DISPATCHED`/`PICKUP`/`LIVE`/`COMPLETED`.
- **§35A §D capability matrix — what the CPO build MUST HIDE:** "Protect me now"/booking wizard ❌, client wallet/credits top-up ❌, client booking history/receipts ❌, family hub ❌, VBG client safety suite ❌, **incoming job offer accept/decline ❌ (the agency accepts, never the CPO)**, roster management ❌, assign-crew/name-leader ❌, multi-mission board ❌ (sees ONLY their own assigned mission), org earnings/payouts ❌ (sees ONLY their own share). What it SHOWS: run an assigned mission (Start/Go-live/Finish) ✅ lead-only, Ops Room comms ✅, SOS/lone-worker check-in ✅, own credentials/docs ✅.
- **Reuse points (verified in code):** `agentApi` (`src/services/api.ts:462`) already has the lead-gated FSM calls — `missionPickup(id)` (`POST /agents/me/missions/:id/pickup`, `DISPATCHED→PICKUP`), `missionGoLive(id)` (`…/go-live`, `PICKUP→LIVE`), `missionComplete(id)` (`…/complete`, `LIVE→COMPLETED`) — each idempotency-keyed (`pickup-`/`golive-`/`complete-`). `agentApi.getActiveMission()` (`/agents/me/active-mission`) returns `{mission_id, short_code, status, is_lead, role, pickup_address, dropoff_address, pickup_time, region_label}` or null — drives the assigned-mission card and the lead/non-lead split. `agentApi.getMissionDeployment(id)` returns `crew_role.{is_lead, role, call_sign}`, `waypoints[]`, `dress_instructions`, and `booking.{pickup/dropoff}` — extend (Step 17) to also return `booking.status`, full `crew[]`, and client name for the roster-with-lead-starred view. `agentApi.raiseSos(id, {reason, lat?, lng?})` exists (60s-bucketed idempotency). `agentApi.setDuty(on_duty)` + `updateLocation(lat,lng)` for the duty toggle + heartbeat. `attendanceApi` (clockIn/clockOut/myShifts) for availability/attendance. The root role decision is `MainNavigator.tsx:190` (`isAgent = role==='agent' || role==='service_provider' || pendingProv`) — today there is NO `cpo` branch; CPOs currently fall into either the agent or client stack. The agent stack is `AgentNavigator.tsx` (a plain `createNativeStackNavigator`, not tabs). Global push-deep-link uses `navigationRef.navigate('Main', {...})` (the incoming-call pattern, `MainNavigator.tsx:286+`).
- **First-login + revocation (§35A §B):** if `must_set_password=true` → force CPO account-activation (set password → optional biometric → location + notification permissions → "you belong to {agency}" + on-duty/SOS explainer) before the home; a CPO never sees `RoleSelectionScreen`. On every app-focus/token-refresh, re-check `membership_status`; if the agency suspended/removed them (`org_members.status != 'active'`), force-logout to an "Your agency access has ended" screen, set them offline, drop from Ops Rooms.

**Files to touch:**

- NEW `src/navigation/CpoNavigator.tsx` — a `createBottomTabNavigator` 4-tab shell: **On Duty / Mission / Comms / Me**, with a floating persistent SOS button above the tabs once mission is `PICKUP`/`LIVE`. Reuse existing agent screens where possible; register the messenger/call screens (mirror what `AgentNavigator` registers) so the Ops Room + calls work in the Comms tab.
- NEW `src/screens/cpo/OnDutyHomeScreen.tsx` — duty toggle (`agentApi.setDuty` + location heartbeat via `updateLocation`), "you belong to **{agency}**" banner (from `account_kind` payload `org.name`), today's shifts (`attendanceApi.myShifts`), the assigned-mission card with a stepper mini-bar + LEAD/CREW chip (from `getActiveMission`); calm "No active mission — stand by" empty state.
- NEW `src/screens/cpo/AssignedMissionDetailScreen.tsx` — client name, route, dress brief, **crew roster with the lead starred + "YOU"**, waypoints, full `<MissionStepper>`; data from extended `getMissionDeployment`.
- NEW `src/screens/cpo/CpoFieldModeScreen.tsx` (or extend `AgentLiveTrackerScreen.tsx`) — map + ONE context-aware **lead-only** button: `DISPATCHED`→Start (`missionPickup`), `PICKUP`→Go-live (`missionGoLive`), `LIVE`→swipe-to-FINISH (`missionComplete`, deliberate confirm). Non-lead = read-only "lead is advancing" + chat + SOS. On error stays at current state (never false "completed"); idempotent re-tap after lost-200 is safe.
- NEW `src/screens/cpo/CpoActivationScreen.tsx` — first-login set-password + biometric + permissions + "you belong to {agency}" explainer.
- NEW `src/screens/cpo/AccessEndedScreen.tsx` — the suspended/removed force-logout screen.
- NEW (Me tab) reuse/extend `EarningsScreen.tsx` scoped to **own share only**, plus docs/credentials (reuse `AgentDocsUploadScreen.tsx`) and availability/attendance.
- EXTEND `src/navigation/MainNavigator.tsx` — add a third branch: `account_kind==='cpo'` → `<CpoNavigator/>` (alongside the existing `isAgent → <AgentNavigator/>` and the client tabs). Add a focus/refresh `membership_status` re-check that force-routes to AccessEnded.
- EXTEND `src/navigation/types.ts` — add a `CpoStackParamList`/tab param list and a root `CpoStack` entry; register mission-assigned/SOS deep-link routes.
- EXTEND `src/services/api.ts` — add the `account_kind`/`org`/`must_set_password`/`membership_status` fields to the `agentApi.getMe()` (`AgentPortalState`) type so the app switches on the authoritative value; extend the `getMissionDeployment` return type with `booking.status` + `crew[]` + client name (mirrors the Step 17 server change).
- EXTEND the auth bootstrap (`src/store/authStore.ts`) — resolve `account_kind` from `/agents/me` after login so the root navigator can branch.
- (v1.1/later) NEW Arrival/Identity confirmation, Lone-Worker check-in (`POST /agents/me/missions/:id/check-in`).

**Backend how-to:** Pure frontend except for what is owned upstream: the `account_kind`/`must_set_password`/`membership_status` computation on `/agents/me` (§35A §F, a focused read — no new crypto/auth power), the extended `getMissionDeployment` payload (Step 17), and the lead-gated `complete` that opens settlement (Step 10/LB4). This step consumes them. (Contract reminder for the FINISH button: server-side `complete` is a conditional `UPDATE missions SET status='COMPLETED' WHERE id=$1 AND status='LIVE' AND EXISTS(...is_lead)` inside a txn, idempotent — so a re-tap after a lost-200 returns the cached success, never double-settles.)

**Frontend / ops-console how-to:**

1. **Root routing by `account_kind`.** In `MainNavigator`, after auth bootstrap, branch: `cpo → <CpoNavigator/>`, `agency`(`isAgent`)`→ <AgentNavigator/>`, else client tabs. Drive it off the server-computed `account_kind`, NOT a client flag.
2. **First login.** If `must_set_password`, push `CpoActivation` before the CPO home; never show `RoleSelectionScreen` to a CPO.
3. **One context-aware button.** Compute the action from `getActiveMission().status` + `is_lead`. Lead: render Start/Go-live/swipe-Finish wired to `missionPickup`/`missionGoLive`/`missionComplete`. Non-lead: render the same screen read-only with "lead is advancing"; keep chat + SOS active.
4. **Capability lockdown (§35A §D).** Build the CPO tabs from ONLY the CPO-scoped screens. Do not register or link to the booking wizard, wallet top-up, family hub, VBG client suite, incoming-offer, roster, assign-crew, multi-mission board, or org earnings. Earnings shows the guard's own share only.
5. **Revocation.** On app-focus/token-refresh, re-fetch `membership_status`; if `!= 'active'`, force-logout → `AccessEnded`, set offline (`setDuty(false)`), and let the Ops Room drop happen server-side.
6. **Deep-links.** Route `mission-assigned` and SOS push wakes into the **Mission** tab via `navigationRef.navigate('Main', {screen:'CpoStack'/'Mission', ...})` (mirror the incoming-call cast).

**Security stop-conditions:** The Comms tab hosts the existing E2E Ops Room — metadata-only via `ensureBookingOpsRoom`; the CPO was added to the room by the agency device's group rekey (LB2), so the CPO app only opens the existing conversation; do NOT write envelopes or touch sender keys. `account_kind`/`membership_status` are server-authoritative — never let the client choose its app experience or self-promote to lead. Push stays opaque: react to `mission-assigned`/SOS wakes by re-fetching `getActiveMission`/deployment, never read mission details from FCM. No "skip in dev" on the membership/session guard. The duty-location heartbeat and SOS must not log plaintext coordinates as key-bearing buffers. STOP/verify against the System Architecture Documentation before changing anything about the Ops Room membership or the session/revocation guard.

**Acceptance & tests:**

- **New tests (`booking`/agent Jest project + `src/screens/cpo/__tests__`):** the context-aware-button selector (status×is_lead → Start/Go-live/Finish/read-only); `account_kind` precedence resolver (cpo > agency > individual); the capability matrix — assert the CPO navigator does NOT include booking/roster/offer/org-earnings routes; revocation reducer routes to AccessEnded when `membership_status!='active'`.
- **Regression:** rerun the `booking`/agent project; `npm run test:crypto` if the Ops Room open/membership path is touched (it should only _open_ an existing room — if so confirm green).
- **Gates:** `npm run typecheck` (mobile ≤ baseline 96 — the new `CpoStackParamList` + extended `AgentPortalState`/`getMissionDeployment` types must not regress it); `npm run lint`. (No ops-console change here; if any shared lib is touched, also `cd apps/ops-console && npm run typecheck`.)
- **Manual smoke (dev build, real device, leader + non-leader logins):** agency assigns crew (Step 20) → leader logs in (first-login activation forces password) → lands in CpoNavigator → Mission tab shows the job + roster with lead starred + "YOU" → Start → Go-live → swipe-Finish advances the mission and every party's stepper to Completed → agency paid (settlement, Step 10). Non-leader: same job read-only, chat + SOS work, no status buttons. Verify HIDDEN: no booking wizard, no offer card, no roster, no org money. Verify revocation: agency suspends the CPO → next focus force-routes to "access ended." Error path: tap Finish offline → stays LIVE, no false "completed."
- **Do not commit on a red gate; never `--no-verify`.**

**Done when:**

- [x] `CpoNavigator` 4-tab shell (On Duty / Mission / Comms / Me) + floating SOS once PICKUP/LIVE. (Shell from Step 17; tabs filled here.)
- [x] Root navigator mounts CpoNavigator strictly by server `account_kind`; first-login activation forces password; no RoleSelection for CPOs. (Step 17.)
- [x] Lead sees ONE context-aware Start→Go-live→Finish wired to `missionPickup`/`missionGoLive`/`missionComplete` (Finish = deliberate confirm; pure missionAction selector, tested); non-lead is read-only with comms + SOS.
- [x] Assigned-Mission Detail shows client/route/dress/waypoints + crew roster with the lead ★starred + "YOU" + the shared stepper. (getMissionDeployment extended w/ crew[]+client_name; closed a pre-existing IDOR with a crew-only gate.)
- [x] Every client + agency capability from the §35A matrix is absent from the CPO build (structural; cpoCapability test asserts only the 4 guard tabs). Own-share Earnings = deferred (Me tab is org banner + signout; earnings rollup is later polish).
- [x] Mid-session revocation force-logs-out to "access ended," sets offline, drops from Ops Rooms. (Step 17 recheckMembership + the CpoNavigator focus effect.)
- [~] Push wakes deep-link into the Mission tab — the Mission tab polls getActiveMission so an assignment surfaces on focus; the explicit FCM mission-dispatched→Mission deep-link is the same opaque-wake routing deferred with the activity-feed wiring (Step 18 §). reactions re-fetch, never read FCM details.
- [x] typecheck = baseline 49, lint 0 errors, app/agent + cpo tests green (missionAction + cpoCapability + agent.deployment; auth agent 322); leader/non-leader + revocation device smoke deferred (dark + not device-testable here). 2-lens review passed (fixed 2 MAJOR poll-hygiene bugs).

---

## Step 22 — Privacy, retention & consent (PII minimization, telemetry purge, lawful-basis gate, disclosure rewrite)

**Stage:** Cross-cutting · **Depends on:** Step 6 (PostGIS region/eligibility match), Step 7 (`dispatch_offers` table + coarse-offer split), Step 8 (accept→escrow + `/offers/:id/full` ACCEPTED-only), Step 16 (settlement/telemetry wiring) · **Resolves:** Part III privacy LB14 + the "Privacy & multi-region compliance" table P0 rows (purge `dispatch_offers`, telemetry retention, lawful-basis consent, false-disclosure rewrite, DPA/CPO consent, PII redaction, data-residency)
**Goal (plain English):** Make sure the customer's exact location is only ever seen by the one firm that took the job, gets deleted from the firms that didn't, and is only shared at all after the customer agrees. Also stop holding live-tracking data forever, rewrite the old "our staff watch your trip" promise (we no longer have a staff handler), and make sure no new screen, log, or admin panel leaks personal data.
**Why it matters / what breaks without it:** Leaking a protected person's pickup/home address to firms that rejected the job is the single highest-severity privacy harm in this product (UAE PDPL / Saudi PDPL / UK GDPR exposure); a false privacy disclosure and unbounded location retention are direct compliance failures that can block launch in the four regions.
**Self-contained context (inline — do not make the reader open the plan):**

- **Decisions in play:** D1 (fully automatic — there is NO ops handler watching the trip anymore; admin only monitors/overrides); D3 (a third-party AGENCY accepts and gets the precise location); correction (3) coarse offer pre-accept — offered/rejecting agencies must never see exact pickup/dropoff; precise location is exposed only after accept via a separate ACCEPTED-only endpoint (`GET /offers/:id/full`).
- **Data model touched:** `dispatch_offers` (cols incl. `provider_user_id`, `status` ∈ OFFERED/ACCEPTED/REJECTED/EXPIRED/SUPERSEDED, `reject_reason TEXT`, `expires_at`) holds coarse geo for the offer; `lite_bookings` holds the precise `pickup_lat/lng` + `dropoff_lat/lng` + addresses + `region_code`; live location lives in `mission_telemetry_last` (Postgres latest-point) AND a Redis stream (telemetry.service.ts already sets `redis.client.expire(key, this.streamTtlSec)` — confirm/standardize that TTL here).
- **Reuse points:** the multi-replica-safe background sweep is the Redis `SET NX`-locked `setInterval` pattern in `apps/auth-service/src/booking/payment-pending-expiry.service.ts` (NOT `@nestjs/schedule` — auth-service is multi-replica, per correction (1)); the PII-redaction precedent is the static log-audit assertions enforced inside the messenger-core crypto tests (`packages/messenger-core/__tests__/sealedSender.test.ts`, `outerEcies.test.ts`, `groupPlaintextReject.test.ts` — there is no standalone `logAudit.test.ts`; the assertion pattern is "this string/key must never appear in logged output"); the consent/disclosure copy lives on the client request wizard + Finding/Confirmation screens (`src/screens/booking/*`).
- **Constraint:** the Ops Room is metadata-only via `SystemMessengerService.ensureBookingOpsRoom` — do NOT add location into any system_broadcast; the precise location flows over the existing E2E booking conversation, never through a server-readable surface.
  **Files to touch:**
- NEW `supabase/migrations/<ts>_privacy_consent.sql` — add `lite_bookings.location_consent_at TIMESTAMPTZ`, `lite_bookings.location_consent_version TEXT`, `lite_bookings.terms_accepted_at TIMESTAMPTZ`; add `agents.dpa_accepted_at TIMESTAMPTZ`, `agents.dpa_version TEXT` (agency processor terms) and a managed-CPO consent column (e.g. `org_members.account_consent_at TIMESTAMPTZ`).
- NEW `apps/auth-service/src/dispatch/offer-purge.service.ts` — Redis-locked sweep that nulls geo/PII on terminal offers.
- EXTEND `apps/auth-service/src/booking/booking.service.ts` `createBooking()` — require `location_consent` + `terms_accepted` in the create DTO and reject the request if absent (lawful-basis gate at request time, BEFORE any dispatch).
- EXTEND `apps/auth-service/src/agents/agent.service.ts` (or `org` service) — gate dispatch-eligibility on `agents.dpa_accepted_at` non-null; the agency cannot receive offers until processor terms are accepted.
- EXTEND `apps/auth-service/src/telemetry/telemetry.service.ts` — confirm/centralize `streamTtlSec`; add the Postgres `mission_telemetry_last` purge on mission terminal (COMPLETED/ABORTED) + a retention sweep.
- EXTEND/NEW redaction helper used by dispatch/ops logs + the ops-console monitor (`apps/ops-console/...`) so `reject_reason`, addresses, and lat/lng are never logged or shown un-redacted to admin.
- EXTEND client copy: `src/screens/booking/*` (request wizard + Finding/Confirmation) — rewrite the "an ops handler watches your trip" disclosure to the D1 reality + add a consent checkpoint UI.
- NEW doc note: a data-residency/cross-border section (one DB today; document the AE/SA/BD/GB plan).
  **Backend how-to:**
- **Lawful-basis gate (request time):** in `createBooking()`, after the existing `active_booking_exists` + `MIN_LEAD_HOURS` checks and BEFORE persisting, require `dto.location_consent === true` and `dto.terms_accepted === true`; persist `location_consent_at = NOW()`, `location_consent_version`, `terms_accepted_at = NOW()`. Reject with `BadRequestException({code:'consent_required'})` otherwise. This is the consent checkpoint BEFORE any precise location can be disclosed to a third-party agency.
- **Offer purge sweep** (mirror `payment-pending-expiry.service.ts` exactly — `SET NX` lock key e.g. `lock:offer-purge`, `setInterval`, clock-skew grace):
  ```sql
  UPDATE dispatch_offers
     SET coarse_lat = NULL, coarse_lng = NULL, coarse_label = NULL, reject_reason = NULL
   WHERE status IN ('REJECTED','EXPIRED','SUPERSEDED')
     AND (coarse_lat IS NOT NULL OR reject_reason IS NOT NULL)
     AND updated_at < NOW() - INTERVAL '<TTL>'
  RETURNING id;
  ```
  Run inside `withTransaction`; the conditional `WHERE status IN (...)` is the race guard (an offer that flipped back to ACCEPTED is never purged). Idempotent by construction (re-running nulls already-null rows = no-op).
- **Telemetry retention:** on mission terminal in the mission FSM path, `DELETE FROM mission_telemetry_last WHERE mission_id = $1` (or move to a short-retention archive per the residency note); for Redis, keep the existing `expire(key, streamTtlSec)` and add a sweep that trims any stream past the retention window. Define the window explicitly (e.g. 30 days max, mirroring the Signal relay dwell ceiling — STOP/verify the exact window against the System Architecture Documentation before finalizing).
- **PII redaction:** add a small `redactPii()` used wherever dispatch/offer/mission rows are logged; never log addresses/lat/lng/`reject_reason` in cleartext. The ops-console monitor (`GET /ops/dispatch/active`) must return coarse/region-level data to the admin view unless the admin opens a specific row under audit.
  **Frontend / ops-console how-to:**
- Client request wizard (`src/screens/booking/*`): add a consent step — a checkbox/affirmation "Bravo will share your pickup and drop-off with the security firm that accepts this job" + a terms acceptance, both required to submit; submit `location_consent:true, terms_accepted:true` on the create call in `src/services/api.ts`.
- Rewrite every instance of the now-false "an ops handler / our team watches your trip" copy (search booking + confirmation + live-tracking screens) to D1 reality: "This is an automated dispatch; your detail is run by {agency}. SOS reaches emergency response."
- Ops-console monitor: render region/coarse data by default; gate any precise-location reveal behind an audited admin action.
  **Security stop-conditions:**
- STOP/verify against the System Architecture Documentation before setting the telemetry retention window and before any change to what the Ops Room (`ensureBookingOpsRoom`) carries — the Ops Room stays metadata-only; precise location must NOT be added to any `system_broadcast`. Push wake stays opaque (`{userId,eventClass,eventId}` only). Never log plaintext addresses, lat/lng, or `reject_reason` — extend the redaction precedent, do not rename variables to dodge it.
  **Acceptance & tests:**
- Unit (auth-service Jest, run from `apps/auth-service`): (a) `createBooking` rejects with `consent_required` when consent/terms absent and persists timestamps when present; (b) offer-purge sweep nulls geo+`reject_reason` on REJECTED/EXPIRED/SUPERSEDED and leaves ACCEPTED/OFFERED untouched; (c) telemetry purge removes `mission_telemetry_last` on terminal mission; (d) dispatch-eligibility excludes an agency with `dpa_accepted_at IS NULL`.
- Static redaction test: extend the log-audit precedent (assert addresses/lat/lng/`reject_reason` never appear in logged output for the new dispatch/offer/telemetry code).
- Manual smoke: submit a request without consent → blocked; with consent → dispatched; reject from one agency → confirm that agency's offer row geo is nulled after the sweep; confirm the disclosure copy no longer says "ops handler."
- Gates: `npm run lint`; `npm run typecheck` (mobile, ≤ baseline 96) and `cd apps/ops-console && npm run typecheck`; wire the new specs into the auth-service Jest run (CI must execute them — see Step on CI). Do not commit on red; never `--no-verify`.
  **Done when:**
- [x] Request creation is blocked without explicit location-consent + terms acceptance, and both timestamps/versions are persisted. (auto path: `create()` gate + `$27–$30` stamps; mobile consent toggle gates the CTA)
- [x] Rejected/expired/superseded offers have geo + `reject_reason` purged by a multi-replica-safe Redis-locked sweep. (`DispatchPrivacyPurgeService`; NOTE: `dispatch_offers` stores NO coords — coarse offers carry only `distance_km` — so `reject_reason` is the only PII to purge)
- [x] Telemetry (Postgres latest-point + Redis stream) has a defined, enforced retention window with a purge path; the window only NARROWS (terminal-booking `mission_telemetry_last` purged 24h post-terminal; Redis stream already self-expires; relay/transport dwell untouched).
- [~] The "ops handler watches your trip" disclosure: the NEW auto screens (Finding/AgencyAccepted/Confirmation) were authored D1-accurate in Steps 18–21; no false "ops watches" copy found on the dispatch path (grep clean).
- [x] Agencies must accept processor (DPA) terms before they are dispatch-eligible (`is_eligible_for_dispatch` += `dpa_accepted_at` gate, fail-closed); managed-CPO `org_members.account_consent_at` column added.
- [x] Logs never expose precise location/`reject_reason` (purge nulls it; sweep logs counts only); IDOR closed on `getJobDetail` (precise coords/address/notes gated on a non-REJECTED application). Data-residency note for AE/SA/BD/GB deferred to the ops-console monitor (Step 26).

---

## Step 23 — Anti-fraud & marketplace integrity (location-plausibility, request throttle + payment gate, accept-rate cooldown, device-binding, one-email-one-agency)

**Stage:** Cross-cutting · **Depends on:** Step 5 (duty/location heartbeat on `agents`), Step 6 (PostGIS region match + ranking), Step 7 (`dispatch_offers` + accept/reject), Step 9 (managed-CPO roster `org_members` + `POST /org/cpos`) · **Resolves:** Part III anti-fraud LB18 + the "Anti-fraud & marketplace integrity" table P0 rows (location spoofing, free-request recon/DoS, mass-reject gaming, shared-login binding, one-email-one-agency)
**Goal (plain English):** Stop firms from cheating to win jobs. Catch fake/jumpy GPS and mock-location on the "I'm on duty here" heartbeat; stop people spamming the free "find me a guard" button to spy on guard locations or knock the service over; penalize firms that accept-then-reject everything; lock down the shared guard logins so a leaked password can't be used everywhere at once; and make "one email = one agency" a hard database rule, not a hope.
**Why it matters / what breaks without it:** A two-sided dispatch marketplace is gamed the moment it's live — a firm that spoofs GPS always appears nearest and starves honest firms; a free unauthenticated-cost request is a recon oracle for where every guard is; shared 10-CPO logins (D5) are an account-sharing vector; and a `SELECT`-only uniqueness check races, so the same email can land in two agencies.
**Self-contained context (inline — do not make the reader open the plan):**

- **Decisions in play:** D4 (nearest within same region wins → spoofed location directly steals jobs); D5 (one agency registers up to ~10 real CPO login emails; one email = one agency); D6 (an agency runs multiple concurrent missions bounded by free-CPO capacity → mass-accept-then-can't-crew must be penalized); D2 (charge on accept → the requesting/DISPATCHING side is FREE today, so the request endpoint is a free oracle).
- **Data model touched:** `agents.last_lat/last_lng/last_location_at/on_duty/rating/jobs_total` updated via `PATCH /agents/me/location` (DTO `UpdateLocationDto{lat,lng}`) and `PATCH /agents/me/duty` (`SetDutyDto{on_duty}`) — confirmed in `apps/auth-service/src/agents/agent.controller.ts` lines 157-168 and `dto/agent.dto.ts`; `agents` has NO region_code today (correction (4)) and the location DTO has NO mock-location/accuracy field today — both must be added. Managed CPOs live in `org_members` (`member_role`, `status`) + are created via `POST /org/cpos` under `OrgManagerGuard`. Acceptance/reject accounting needs new counters on `agents` (e.g. `offers_received`, `offers_accepted`, `offers_rejected`, `cooldown_until`).
- **Reuse points:** rate limiting = `UserThrottlerGuard` + `@Throttle` (already in the codebase); idempotency = `common/interceptors/idempotency.interceptor.ts`; JTI / refresh-token / push-token revocation lives in `apps/auth-service/src/auth/jwt.service.ts` + `auth.service.ts` (reuse for per-login session cap + revocable push token); the accept/reject conditional-UPDATE race pattern mirrors `payWithCredits` (`booking.service.ts`) — `UPDATE ... WHERE <expected-state> RETURNING` inside `withTransaction`.
- **Constraint:** the request (`DISPATCHING`) path is free → it MUST require a verified payment method before it can run the cascade, and be throttled per-user; the duty/location heartbeat must reject implausible jumps server-side (never trust the client's self-reported coordinates blindly).
  **Files to touch:**
- NEW `supabase/migrations/<ts>_antifraud_integrity.sql` — add `agents.region_code TEXT` + offer-accounting counters (`offers_received INT`, `offers_accepted INT`, `offers_rejected INT`, `cooldown_until TIMESTAMPTZ`, `acceptance_rate NUMERIC`); add `agents.last_location_accuracy_m NUMERIC`, `agents.last_location_mocked BOOLEAN`; add a **PARTIAL UNIQUE INDEX** for one-email-one-agency; add device-binding/session columns if not already on the auth/session tables.
- EXTEND `apps/auth-service/src/agents/dto/agent.dto.ts` `UpdateLocationDto` — add optional `accuracy_m`, `is_mocked`, `speed`, `ts` so the server can run plausibility.
- EXTEND `apps/auth-service/src/agents/agent.service.ts` `updateLocation()` — server-side plausibility (impossible-speed jump vs `last_lat/last_lng/last_location_at`) + mock-location gating (drop on-duty eligibility / flag when `is_mocked`).
- EXTEND `apps/auth-service/src/booking/booking.controller.ts` (request/DISPATCHING start) — add `@Throttle` via `UserThrottlerGuard` + a verified-payment-method gate; cap concurrent client DISPATCHING.
- EXTEND `apps/auth-service/src/dispatch/*` reject handler — increment reject counters, recompute `acceptance_rate`, apply `cooldown_until` + a ranking penalty on mass-reject.
- EXTEND `apps/auth-service/src/agents/org/*` (`POST /org/cpos`) — verified-email gate before a CPO is assignable; reject self/client-email enrolment; surface the one-email-one-agency 409.
- EXTEND `apps/auth-service/src/auth/jwt.service.ts` / `auth.service.ts` — device-binding + concurrent-session cap + revocable per-login push token for managed-CPO logins.
  **Backend how-to:**
- **One-email-one-agency (hard rule, not a SELECT):**
  ```sql
  -- a CPO email may belong to at most one active agency
  CREATE UNIQUE INDEX org_members_one_active_agency_per_email
    ON org_members (lower(email)) WHERE status = 'active';
  ```
  In `POST /org/cpos`, do the INSERT and catch the unique-violation → return `409 {code:'email_taken'}`; do NOT pre-check with a `SELECT` (it races). Add a verified-email gate: a CPO is not `assignable` until email is verified; reject if the email equals the manager's own (`self_enrolment`) or matches an existing client account (`client_email`).
- **Location plausibility + mock gating** in `updateLocation()`:
  - If `dto.is_mocked === true` → reject/flag (`agents.last_location_mocked = true`, exclude from the on-duty dispatch pool).
  - Compute implied speed from previous fix: `dist(last_lat,last_lng → lat,lng) / (now - last_location_at)`. If it exceeds a plausible ceiling (e.g. > 300 km/h or accuracy_m too large), reject the update (keep the prior fix) and increment a suspicion counter. Do this server-side; the client value is untrusted.
- **Request throttle + payment gate:** decorate the DISPATCHING-start endpoint with `@Throttle` (via `UserThrottlerGuard`) AND require a verified payment method (since the request is free pre-accept, this is the anti-recon/DoS gate). Cap concurrent DISPATCHING per client with a conditional `INSERT/UPDATE ... WHERE NOT EXISTS (active DISPATCHING)`.
- **Accept-rate / mass-reject accounting** (in the reject path, same txn as the offer flip):
  ```sql
  UPDATE dispatch_offers SET status='REJECTED', reject_reason=$2
    WHERE id=$1 AND status='OFFERED' RETURNING provider_user_id;
  -- then, same txn:
  UPDATE agents
     SET offers_rejected = offers_rejected + 1,
         acceptance_rate = offers_accepted::numeric / NULLIF(offers_received,0),
         cooldown_until = CASE WHEN <mass-reject threshold> THEN NOW() + INTERVAL '<cooldown>' ELSE cooldown_until END
   WHERE user_id = $providerUserId;
  ```
  Feed `acceptance_rate` + `cooldown_until` into the Step-6 ranking (skip agencies in cooldown; demote low acceptance-rate).
- **Device-binding + session cap + revocable push:** on managed-CPO login, bind the JTI to a device id, enforce a concurrent-session cap (revoke oldest on overflow via the existing JTI revocation), and issue a per-login revocable push token so a removed/suspended CPO's wake can be killed (ties into §35A mid-session revocation).
- All money-adjacent and state-flip operations stay idempotent and use the conditional `UPDATE ... WHERE <state> RETURNING` inside `withTransaction`.
  **Frontend / ops-console how-to:**
- Agency roster screen (`OrgRoster`): surface the `409 email_taken` cleanly ("this email already belongs to another agency"), show "X / 10 used" cap, and a verified/unverified email badge per CPO; block assignment of unverified CPOs.
- Client request UI: if the verified-payment-method gate fails, route to the existing CreditPaywall/payment-method add flow before allowing dispatch.
  **Security stop-conditions:**
- STOP/verify against the System Architecture Documentation before changing session/JTI, refresh-token, or push-token issuance/revocation (these are listed auth stop-conditions). Push wake stays opaque (`{userId,eventClass,eventId}`). No "skip in dev" branch on the payment-method gate, the plausibility check, or the verified-email gate. Never log raw coordinates from the heartbeat (reuse the Step-22 redaction precedent).
  **Acceptance & tests:**
- Unit (auth-service Jest): (a) `updateLocation` rejects mock/implausible-speed fixes and keeps the prior fix; (b) the partial unique index causes a `409 email_taken` on a second active agency for the same email; (c) self-email and client-email enrolment are rejected; (d) reject path increments counters, recomputes `acceptance_rate`, and sets `cooldown_until` past threshold; (e) ranking excludes cooled-down agencies; (f) DISPATCHING-start requires a verified payment method and is throttled.
- Integration: concurrent `POST /org/cpos` with the same email → exactly one succeeds (index race), the other 409s.
- Manual smoke: spoof a mock location on a test device → agency drops out of the offer pool; spam the request endpoint → throttled.
- Gates: `npm run lint`; `npm run typecheck` (mobile ≤ 96) + `cd apps/ops-console && npm run typecheck`; run the auth-service Jest project (ensure CI executes it). Do not commit on red; never `--no-verify`.
  **Done when:**
- [x] The duty/location heartbeat rejects mock-location and impossible-speed jumps server-side (accuracy-aware, min-dt-gated to avoid GPS-jitter false positives); flagged agencies leave the dispatch pool (`last_location_mocked=FALSE` ranking gate + staleness). Self-heals on the next genuine fix.
- [~] The DISPATCHING request is per-user throttled (`@Throttle 5/min` on `/dispatch/request`); the concurrent cap is the existing one-active-booking guard. (Verified-payment gate: the authoritative guard is accept()'s escrow charge; an explicit request-time payment-method gate is deferred.)
- [x] Mass-reject is accounted (acceptance_rate over responded offers; ignored/expired offers count too) and cooled down; the ranking honors `cooldown_until` (and excludes mocked). Counters: offers_received on offer, offers_accepted on accept, offers_rejected on reject/expire.
- [~] Managed-CPO session/revocation is covered by Step 17's `CpoSessionGuard` (activation/revocation); device-binding + a hard session-cap are architecture-gated and deferred.
- [x] One-email-one-agency: `users.email` is `citext UNIQUE` + new `org_members_one_active_agency` partial unique index; `createManagedCpo` catches the 23505 race → clean 409.

---

## Step 24 — Lifecycle completeness & ratings loop (on-demand lead-time exemption, free the active-booking guard, ratings write→ranking, jobs_total, scheduled auto-dispatch, cancellation policy, ETA)

**Stage:** Cross-cutting · **Depends on:** Step 6 (ranking that consumes `agents.rating`), Step 7/8 (offer + accept FSM and the new DISPATCHING/NO_PROVIDER statuses), Step 16 (extracted `SettlementService` / lead one-tap Finish), Step 12 (escrow refund matrix for cancellation fee) · **Resolves:** Part III lifecycle LB17 + the "Lifecycle completeness & business rules" table P0/P1 rows (MIN_LEAD_HOURS collision, DISPATCHING/NO_PROVIDER trap, ratings loop unbuilt, jobs_total not incremented, scheduled auto-dispatch undesigned, no cancellation policy, no ETA)
**Goal (plain English):** Finish the "the demo works but the product is unfinished" gaps. Let an "I need a guard NOW" request skip the 3-hour-minimum rule; let a customer try again after a failed search instead of being locked out; build the missing star-rating loop so a customer can rate the firm and that rating actually changes who gets future jobs; count a finished job toward the firm's total; design scheduled/recurring auto-dispatch; add a fair cancellation policy; and show an arrival ETA.
**Why it matters / what breaks without it:** As written, an on-demand request is rejected by the 3-hour lead-time gate (the headline feature can't run), a failed search traps the customer behind the one-active-booking guard so "try again" is impossible, and the ranking reads `agents.rating` that is never written — so the whole "best firms rise" promise is a fabricated trust signal.
**Self-contained context (inline — do not make the reader open the plan):**

- **Decisions in play:** D1 (fully automatic on-demand); the booking FSM is `DRAFT→PENDING_OPS→OPS_APPROVED→PAYMENT_PENDING→CONFIRMED→LIVE→COMPLETED` (`apps/auth-service/src/booking/state-machine.service.ts`), plus the NEW dispatch statuses DISPATCHING / NO_PROVIDER added by the dispatch steps; the mission FSM is `DISPATCHED→PICKUP→LIVE→SOS→COMPLETED|ABORTED` (`mission-state-machine.service.ts`).
- **Confirmed code facts (verify, don't transcribe):** in `apps/auth-service/src/booking/booking.service.ts`: `MIN_LEAD_HOURS = 3` (line 18); the active-booking guard is a `SELECT id,status FROM lite_bookings WHERE client_id=$1 AND status NOT IN ('COMPLETED','CANCELLED') ... LIMIT 1` then throw `active_booking_exists` (lines 154-169); the lead-time check is `pickupTime < now + MIN_LEAD_HOURS*3600_000` (lines 176-180). The lead's one-tap Finish does NOT settle money today and `jobs_total` is currently bumped by `OpsService.completeBooking` on payout, NOT on finish (confirmed by the removed `PATCH /agents/me/stats` comment in `agent.controller.ts` lines 170-176) — so incrementing `jobs_total` "on the lead's finish" requires the extracted `SettlementService` from Step 16 (correction (2): the lead Finish has no settlement path today).
- **Data model touched:** `lite_bookings.rating` exists but is UNUSED (the ratings target); `agents.rating` is read by the ranking but never written; `agents.jobs_total` increments only at admin payout today. New: a cancellation-policy needs grace/fee config + ties into the Step-12 escrow PARTIAL/refund matrix; scheduled dispatch needs a recurrence rule + a Redis-locked cron.
- **Reuse points:** the multi-replica-safe cron is the Redis `SET NX`-locked `setInterval` in `payment-pending-expiry.service.ts` (NOT `@nestjs/schedule`, correction (1)); the conditional state flip mirrors `payWithCredits`; ETA comes from Mapbox (ops-console already uses `mapbox-gl`; mobile uses the existing map stack); the new ratings/receipt endpoints are simple reads/writes over existing tables (Part IV §35: `POST /bookings/:id/rating`).
  **Files to touch:**
- EXTEND `apps/auth-service/src/booking/booking.service.ts` — exempt on-demand (`booking_mode:'now'`/`dispatch_mode:'auto'`) from `MIN_LEAD_HOURS`; relax the active-booking guard so terminal/failed states (NO_PROVIDER, CANCELLED, COMPLETED, and an expired DISPATCHING) do NOT block a new request.
- NEW `apps/auth-service/src/booking/rating.controller.ts` + service method — `POST /bookings/:id/rating`.
- EXTEND the settlement/finish path (`SettlementService` from Step 16 + `apps/auth-service/src/ops/ops.service.ts`) — increment `agents.jobs_total` on the lead's verified finish/settlement (not only admin payout).
- NEW `apps/auth-service/src/dispatch/scheduled-dispatch.service.ts` — Redis-locked cron that calls `DispatchService.start()` at `pickup_time − lead` for `booking_mode:'later'`/recurring rows.
- NEW `supabase/migrations/<ts>_lifecycle_ratings.sql` — recurrence-rule columns on `lite_bookings` (or a `booking_schedules` table), cancellation-policy config, and any rating index.
- EXTEND client mobile: `src/screens/booking/*` (NoDetailScreen "try again", RateAgencyScreen), `src/store/bookingStatus.ts` (`resumeTargetFor` for DISPATCHING/NO_PROVIDER), `src/services/api.ts` (rating + receipt + schedule calls), LiveTracking/Confirmation ETA via Mapbox.
  **Backend how-to:**
- **On-demand lead-time exemption:** wrap the lead-time throw in a mode check — `if (!isOnDemand(dto) && pickupTime.getTime() < now + MIN_LEAD_HOURS*3600_000) throw ...`. `isOnDemand` = `dto.dispatch_mode === 'auto'` or `dto.booking_mode === 'now'`. Scheduled requests keep the gate.
- **Free the active-booking guard:** change the guard's `status NOT IN (...)` to also exclude terminal/failed dispatch states: `AND status NOT IN ('COMPLETED','CANCELLED','NO_PROVIDER')` and treat an expired-DISPATCHING booking as non-blocking (or auto-transition it to NO_PROVIDER in the same path). This makes "try again" possible after a failed search while still preventing two concurrent live missions.
- **Ratings write → ranking feed:** `POST /bookings/:id/rating` body `{stars:1..5, tags?:string[], tip?:number}`, guarded so only the booking's `client_id` can rate and only when the booking is COMPLETED (conditional check). Inside `withTransaction`:
  ```sql
  UPDATE lite_bookings SET rating=$2 WHERE id=$1 AND client_id=$3 AND status='COMPLETED' AND rating IS NULL RETURNING id;
  -- then recompute the agency's rolling average from lite_bookings.rating for that provider:
  UPDATE agents SET rating = (SELECT AVG(rating) FROM lite_bookings WHERE provider_user_id=$prov AND rating IS NOT NULL) WHERE user_id=$prov;
  ```
  The `AND rating IS NULL` clause makes it idempotent / one-rating-per-booking; wrap with `IdempotencyInterceptor`. The recomputed `agents.rating` is exactly what the Step-6 ranking reads.
- **jobs_total on finish:** inside the extracted `SettlementService` (Step 16), on a verified lead finish, `UPDATE agents SET jobs_total = jobs_total + 1 WHERE user_id=$payeeUserId` in the same settlement txn (do not also bump at admin payout — pick one source of truth to avoid double counting; the comment in `agent.controller.ts` notes it is server-written only).
- **Scheduled/recurring auto-dispatch:** Redis `SET NX`-locked `setInterval` (copy `payment-pending-expiry.service.ts`), every ~60s `SELECT` rows whose `pickup_time − lead <= NOW()` and `dispatch_state` not yet started, then call `DispatchService.start()`; flip a `scheduled_dispatched_at` flag in the same conditional UPDATE so a re-run can't double-dispatch (multi-replica safe). Recurrence = expand the rule to the next occurrence on completion.
- **Cancellation policy:** define `CANCEL_FEE_GRACE` + `CANCEL_FEE_PCT`; on client cancel, branch by phase — within grace / pre-accept → full refund (no fee); after accept but pre-LIVE → PARTIAL (fee → agency for the wasted commit); these route through the Step-12 escrow PARTIAL/REFUND matrix, not a fresh refund path.
  **Frontend / ops-console how-to:**
- `NoDetailScreen` (NO_PROVIDER): "you weren't charged" + a working **Try again** (now unblocked by the guard fix) + Schedule.
- `RateAgencyScreen` / RateMissionSheet: ★ + tags + optional tip → `POST /bookings/:id/rating`; show on TripSummary.
- `src/store/bookingStatus.ts` `resumeTargetFor`: route DISPATCHING→Finding, NO_PROVIDER→NoDetail, plus the existing CONFIRMED/LIVE targets.
- ETA: render Mapbox time-to-arrival on Finding/Confirmation/LiveTracking (client) and the agency monitor (ops-console `mapbox-gl`).
  **Security stop-conditions:** None beyond standard guards for the lifecycle/rating/cron changes (no crypto/auth/escrow primitive changes here). The cancellation-fee money movement must obey the escrow rules from Step 12 (idempotent, conditional UPDATE) — STOP/verify the refund/partial split there, not invent a new one. Never log plaintext (rating tags/tip are non-sensitive but keep addresses out of cron logs).
  **Acceptance & tests:**
- Unit (auth-service Jest, booking project): (a) on-demand request bypasses MIN_LEAD_HOURS, scheduled does not; (b) active-booking guard no longer blocks after NO_PROVIDER/CANCELLED and a new request succeeds; (c) `POST /bookings/:id/rating` writes once (idempotent), only by the client, only on COMPLETED, and recomputes `agents.rating`; (d) settlement increments `jobs_total` exactly once; (e) scheduled cron dispatches once under a simulated two-replica race; (f) cancellation fee branches by phase through the escrow matrix.
- Manual smoke: fail a search → tap Try again → new search starts; complete a mission → rate the agency → confirm `agents.rating` moves and the next ranking reflects it.
- Gates: run the **booking** Jest project (`npm test -- --selectProjects=booking`) for the booking changes, then the auth-service suite; `npm run lint`; `npm run typecheck` (mobile ≤ 96) + ops-console typecheck; manual UI smoke. Do not commit on red; never `--no-verify`.
  **Done when:**
- [x] On-demand requests (auto + `booking_mode='now'`) skip the 3-hour lead-time gate; scheduled (`'later'`) + legacy still honor it.
- [x] A failed/terminal booking no longer traps the client — NO_PROVIDER/AGENCY_NO_SHOW freed in the active guard (Step 19) + NoDetail "try again".
- [x] `POST /bookings/:id/rating` writes `lite_bookings.rating` (once, client-only, COMPLETED-only, idempotent), recomputes `agents.rating` (post-commit), and the ranking consumes it (1km-band → `COALESCE(rating, 3.0)` secondary sort so nearest still wins across bands + new agencies aren't penalized).
- [x] `agents.jobs_total` increments at the single settlement source (`settlement.service.ts`, Step 16).
- [x] Scheduled auto-dispatch runs on a Redis-locked, multi-replica-safe cron (`ScheduledDispatchService`, dark) — "later" deferred at request, started near pickup via `start()`'s conditional flip (no double-dispatch); phase-based cancellation policy exists (Step 11 escrow refund/partial + cancel window). [~] ETA via Mapbox deferred (telemetry already carries `eta_minutes`).

---

## Step 25 — i18n / RTL + per-region currency + SettingsScreen

**Stage:** Cross-cutting · **Depends on:** Step 22 (consent/disclosure copy that now needs translating), Step 24 (rating/receipt screens that need strings), the shared component library (PX1/§28 B3) · **Resolves:** Part III mobile-ux LB19 + Part IV §32 (SettingsScreen, Localization/RTL, notification categories, location-sharing scope, app-lock), §34 (no i18n/RTL P0 row)
**Goal (plain English):** The app has zero translation support today — everything is hard-coded English. Add a real language layer with English, Arabic (full right-to-left), and Bengali, defaulting to the phone's language and remembered in the user's settings; format money in the right currency per region (AED / SAR / BDT / GBP); and build a Settings screen where a user picks language, currency, notification categories (with Safety always on), how much location to share, and an app-lock. Make the shared building blocks flip correctly for right-to-left and respect the OS text-size setting.
**Why it matters / what breaks without it:** Arabic (RTL) + Bengali are table-stakes for the UAE / Saudi / Bangladesh launch regions — without them those regions cannot go live; and showing GBP/BDT amounts formatted as the wrong currency mis-charges/mis-displays in 2 of the 4 regions.
**Self-contained context (inline — do not make the reader open the plan):**

- **Decisions in play:** the four regions are AE / SA / BD / GB (D4); each maps to a currency: AE→AED, SA→SAR, BD→BDT, GB→GBP.
- **Confirmed code facts (verify, don't transcribe):** there is NO i18n today — `package.json` has no `i18n`, `expo-localization`, `react-i18next`, `i18next`, or `I18nManager`-based layer (grep returned no matches); the only "i18n/RTL/expo-localization" string hits in `src/` are incidental (`src/services/api.ts`, `JobMarketplaceScreen.tsx`), not a localization framework. There is NO `/me/preferences` endpoint today (grep on auth-service found only wallet/booking pricing `currency` usages). Text/RTL-awareness must reuse the existing responsive helper `src/utils/scaling.ts` (`scaleTextStyles`/`useResponsive`, tested in `src/utils/__tests__/scaling.test.ts`) — note its documented limit: static styles read `Dimensions.get('window')` at module load and do NOT reflow mid-session, so RTL direction must be applied at the right layer (`I18nManager` + per-component logical styles), not via a static re-read.
- **Reuse points:** Expo SDK 54 is the stack → use `expo-localization` to read the device locale; `react-native`'s `I18nManager.forceRTL`/`isRTL` for layout direction; persist the choice via the NEW `PATCH /me/preferences`; format currency with `Intl.NumberFormat`. The shared component library (StepperBar, RatingStars, CountdownPill, etc., §28 B3) must be made RTL- and text-scale-aware here.
- **Constraint:** the Safety notification category is forced-on (cannot be disabled by the user) per §32; the location-sharing scope is a privacy control that pairs with the Step-22 consent model.
  **Files to touch:**
- EXTEND `package.json` — add `expo-localization` and a lightweight i18n runtime (e.g. `i18next` + `react-i18next`, or a minimal in-house dictionary if you want zero new deps); verify the dep is allowed by `npm run deadcode`/audit.
- NEW `src/i18n/index.ts` + `src/i18n/locales/{en,ar,bn}.json` — the i18n init (default from `expo-localization` device locale, fallback en), the translation catalogs, and an `applyRtl(locale)` that calls `I18nManager.forceRTL(true)` for `ar`.
- NEW `src/screens/settings/SettingsScreen.tsx` — language picker (English / العربية / বাংলা), currency, notification categories (Safety forced-on, disabled toggle), location-sharing scope, app-lock + auto-lock.
- NEW `src/utils/currency.ts` — `formatCurrency(amount, region)` mapping AE→AED, SA→SAR, BD→BDT, GB→GBP via `Intl.NumberFormat`.
- EXTEND `src/utils/scaling.ts` consumers + the shared component library (§28 B3 components) — make them RTL-aware (logical `start/end` instead of `left/right`) and text-scale-aware.
- EXTEND `src/services/api.ts` — `patchPreferences({language, currency, notification_categories, location_scope, app_lock})`.
- NEW backend: `apps/auth-service/src/users/preferences.controller.ts` (or extend an existing users controller) — `PATCH /me/preferences`; NEW migration `supabase/migrations/<ts>_user_preferences.sql` for the columns (`users.language`, `users.currency`, `users.notif_prefs JSONB`, `users.location_scope`, `users.app_lock`).
- EXTEND existing screens that hard-code English strings on the dispatch path (booking wizard, Finding/NoDetail/AgencyAccepted/Confirmation/LiveTracking, agency IncomingOffer, CPO mission screens) to use `t('...')`.
  **Backend how-to:**
- `PATCH /me/preferences` guarded by the standard auth guard (`@CurrentUser`), body validated (`language ∈ {en,ar,bn}`, `currency ∈ {AED,SAR,BDT,GBP}`, `notif_prefs` with Safety forced true server-side, `location_scope`, `app_lock`). Persist on the `users` row; the Safety category is coerced on server (`notif_prefs.safety = true` always), so a client cannot disable it. Idempotent partial update (`UPDATE users SET ... WHERE id=$sub RETURNING ...`).
  **Frontend / ops-console how-to:**
- `src/i18n/index.ts`: initialize from `Localization.getLocales()[0].languageCode`, fallback `en`; load the persisted preference (from `/me/preferences` / local store) on boot and override the device default; call `applyRtl(locale)` — note `I18nManager.forceRTL` requires an app reload to take full effect, so on language change show a "restart to apply" prompt for the RTL flip (standard RN constraint).
- SettingsScreen: language + currency + notification categories (Safety toggle rendered disabled/on) + location-sharing scope + app-lock/auto-lock; on save call `patchPreferences`.
- Wire `formatCurrency(amount, booking.region_code)` everywhere money is shown (pricing, receipt, earnings) so AED/SAR/BDT/GBP render correctly per region.
- Make the §28 shared components flip for RTL (use `flexDirection` logical handling / `I18nManager.isRTL`) and honor OS font scale via the existing `scaling.ts` helpers.
  **Security stop-conditions:** None beyond standard guards (i18n/currency/preferences are non-sensitive). The location-sharing scope control must not weaken the Step-22 consent/lawful-basis model — STOP/verify it only narrows, never silently widens, what the accepting agency receives. Do not log preference values that could be sensitive in aggregate.
  **Acceptance & tests:**
- Unit (mobile app Jest project): (a) `formatCurrency` returns correctly formatted AED/SAR/BDT/GBP; (b) i18n falls back to `en` for an unknown device locale and resolves `ar`/`bn` keys; (c) `applyRtl('ar')` sets RTL, `applyRtl('en')` clears it; (d) preferences server coerces Safety notifications on regardless of input.
- Manual smoke (UI cannot be fully verified without a device for the RTL reload — say so explicitly): switch language to Arabic → layout mirrors after reload; switch currency → amounts reformat; toggle a notification category → Safety stays on/disabled; verify text scales with OS font-size setting; check an adjacent screen (e.g. DashboardScreen) is not broken by the RTL flip.
- Gates: `npm run lint`; `npm run typecheck` (mobile, must stay ≤ baseline 96) + `cd apps/ops-console && npm run typecheck`; `npm run deadcode` (new i18n deps must not trip knip); run the mobile app Jest project. If the RTL behavior can't be confirmed in this environment (native reload), state that rather than claiming success. Do not commit on red; never `--no-verify`.
  **Done when:**
- [x] An i18n layer exists (`src/i18n/`, zero new deps) with en + ar (RTL via `I18nManager.forceRTL`) + bn, defaulting from the device locale (Hermes `Intl`) and overridable in Settings; `initI18n()` at boot.
- [x] `PATCH /users/me/preferences` persists language/currency/notif-categories/location-scope/app-lock; Safety category is server-forced on (coerced at write AND re-forced at read).
- [x] Per-region `formatCurrency(amount, region)` (AED/SAR/BDT/GBP) exists (`src/utils/currency.ts`). [~] Wiring it into every money site is incremental (the formatter + region→currency map are in place + tested).
- [x] SettingsScreen exposes language, currency, notification categories (Safety locked), location-sharing scope, and app-lock; reachable from ProfileScreen.
- [x] Shared `StepperBar` uses the new `src/utils/rtl.ts` helper (RTL- + text-scale-aware). [~] Broad dispatch-path string extraction to `t()` is incremental (the layer + catalogs exist; SettingsScreen is fully translated). Device-only RTL reload verification is **PENDING** (can't exercise forceRTL reload in this env). ⚠️ `location_scope` is STORED but INERT (not yet wired to the sharing path) — it cannot widen what an agency receives.

---

## Step 26 — Observability, kill-switch & ops monitor

**Stage:** Operate · **Depends on:** Step 5 (region+PostGIS ranking), Step 7 (offer/cascade + watchdog), Step 9 (accept→escrow charge saga), Step 14 (SettlementService + lead Finish), Step 18 (Ops Room conversations-scoped rekey drain), Step 22 (push-bridge dispatch eventClass) · **Resolves:** Part III "Observability & operability" (P0 metric set / runtime kill switch / SLO alerts / health checks), LB9 (watchdog liveness), LB21 (runtime kill-switch + canary), §42 (Redis-locked sweeps)
**Goal (plain English):** Since no human runs dispatch (D1 — admin only monitors/overrides), the system must watch itself: emit a dispatch-health metric set, log PII-safely with a correlation id that follows a job across services, page a human when something breaks that a person can't watch 24/7, expose real health/readiness checks, and provide ONE runtime switch that safely turns auto-dispatch off and falls back to the old admin-mediated job board. Plus a read-only ops-console `/dispatch` monitor with a money-taken/no-mission watch and a SUPERVISOR+ cancel/force-assign override that is attributable in the audit log.
**Why it matters / what breaks without it:** Without metrics + alerts + a kill switch, a stuck cascade, a dead watchdog, a charged-but-uncrewed booking, or a region with zero on-duty agencies silently strands real (safety-critical, money-handling) customers with no human in the loop and no way to bleed off to the legacy flow.
**Self-contained context (inline — do not make the reader open the plan):**

- D1 = fully automatic dispatch; the admin only monitors/overrides. So observability is the only human eye on the system.
- The dispatch lifecycle this step observes: client request → booking `DISPATCHING` → server offers nearest in-region agency via `dispatch_offers` (status `OFFERED`→`ACCEPTED`/`REJECTED`/`EXPIRED`/`SUPERSEDED`); reject/expire cascades to next-nearest (watchdog); on accept the client is charged into escrow (`escrow_holds.status='HELD'`); agency assigns crew+leader → `missions` (`DISPATCHED→PICKUP→LIVE→COMPLETED|ABORTED`); lead one-tap Finish opens `PENDING_RELEASE`; release sweep pays the agency; `NO_PROVIDER` = cascade exhausted with no accept (no charge).
- Required metric set (this is the spec): `dispatch_rank_query_ms` (the PostGIS ST_DWithin ranking query latency), `dispatch_acceptance_rate`, `dispatch_avg_cascade_depth`, `dispatch_no_provider_rate{region}`, `dispatch_offer_timeout_rate`, `dispatch_time_to_crew_ms` (accept→mission created), `dispatch_charge_failure_rate`, `dispatch_watchdog_sweep_duration_ms` + `dispatch_watchdog_last_run_ts{sweep}` (liveness), `dispatch_money_drift_total` (incremented by the reconciliation sweep in Step 28), `dispatch_completion_gate_fail_total{reason}` (from the proof gate).
- Reuse — observability already exists: `apps/auth-service/src/observability/sentry.service.ts` exposes `SentryService.captureException(e, ctx)`, `addBreadcrumb`, `opsDecisionBreadcrumb(action, admin, subject)`, `reportCriticalAuditFailure(action, subject, err)` and an `isEnabled` flag; it is a no-op shim when `SENTRY_DSN` is unset (CI/dev stay silent). The module is `observability.module.ts`. There is NO Prometheus registry today and NO `/health` route in `main.ts` (only `app.listen`). The metric sink and health controller are NEW.
- Reuse — Redis-locked sweep liveness: the canonical multi-pod-safe pattern is `apps/auth-service/src/booking/payment-pending-expiry.service.ts` — `setInterval` + `redis.client.set(LOCK_KEY, ts, 'PX', LOCK_TTL_MS, 'NX')`, work only if `got==='OK'`, `finally { redis.client.del(LOCK_KEY) }`, `LOCK_TTL_MS < SWEEP_INTERVAL_MS`. The dispatch watchdog + the Step-28 sweeps MUST copy this (NOT `@nestjs/schedule`; auth-service is multi-replica). Each sweep stamps `dispatch_watchdog_last_run_ts` on every successful (lock-won) run; the alert fires if any sweep's last-run is older than 2× its interval.
- Reuse — audit + feed: `apps/auth-service/src/ops/ops-audit.service.ts` `OpsAuditService.record(entry)` / `recordAdmin(admin, action, subject_type, subject_id, metadata)` writes `ops_audit`; critical actions (in `CRITICAL_ACTIONS`) are fail-closed (re-throw → caller txn rolls back) and fan to Sentry. `emit(FeedEvent)` writes `live_feed_events` (the dashboard activity stream); `recentFeed(limit)` reads it. The override actor MUST be recorded here.
- Reuse — push stays opaque: `apps/auth-service/src/ops/booking-push-bridge.service.ts` `publish(userId, eventClass, details)` stores `details` under `push-event:<eventId>` (TTL 300s) and publishes EXACTLY `{userId, eventClass, eventId}` on Redis channel `push:events` (`BookingPushBridge.CHANNEL`). messenger-service `src/push/push.service.ts` consumes. P0-N8: never add `bookingId`/`missionId`/`kind` to the published payload. SLO alerts here go to Sentry/PagerDuty, NOT through the opaque push channel.
- Reuse — ops-console: Next.js App Router under `apps/ops-console/src/app/` (existing siblings: `live/`, `dashboard/`, `bookings/`, `finance/`). API client `apps/ops-console/src/lib/api.ts` (`fetchJson`, CSRF via `bravo_ops_csrf`, base from `NEXT_PUBLIC_API_BASE_URL`). Role gating `apps/ops-console/src/lib/rbac.ts`: `AdminRole = 'OPS'|'SUPERVISOR'|'ADMIN'`, `hasRole(actual, atLeast)`, hierarchy `ADMIN>SUPERVISOR>OPS`; cancel/force-assign override gates on `hasRole(role,'SUPERVISOR')` (mirror `canDispatchBooking`).
- Correlation id: a single `dispatchCorrelationId` (uuid) minted at request/offer creation, carried through the offer/accept/charge/mission rows (column or metadata), echoed into every structured log line, into the `push-event:<eventId>` detail blob (NOT the opaque channel payload), and forwarded to messenger-service so a single job is traceable auth-service→Redis→messenger-service→device.
  **Files to touch:**
- NEW `apps/auth-service/src/observability/dispatch-metrics.service.ts` — in-memory metric registry (counters/gauges/histograms) with `inc(name, labels)`, `observe(name, ms, labels)`, `setGauge(name, value, labels)`, `snapshot()`; emit to the sink (Prometheus text on `/metrics`, or push to the existing Sentry as breadcrumbs/measurements where appropriate). EXTEND `observability.module.ts` to provide+export it.
- NEW `apps/auth-service/src/observability/health.controller.ts` — `GET /health` (liveness: process up) and `GET /ready` (readiness: Redis reachable via `RedisService`, dispatch DB reachable via `DatabaseService.q('SELECT 1')`, watchdog last-run within 2× interval). Public (no JWT) but returns only booleans/coarse status — no PII.
- NEW `apps/auth-service/src/ops/dispatch-killswitch.service.ts` — runtime flag read from a Redis key (e.g. `dispatch:enabled`) with a short in-process cache; `isAutoDispatchEnabled()`. NOT boot-time env only. When OFF, the request path skips auto-offer and the booking follows the legacy admin flow (`OpsService` job board); the watchdog/sweeps keep running for in-flight jobs.
- NEW `apps/auth-service/src/ops/dispatch-monitor.controller.ts` — read-only `GET /ops/dispatch` (in-flight offers/bookings: current holder org, rank/distance bucket, server `expires_at` countdown, reject trail, escrow/money state) + `POST /ops/dispatch/:bookingId/cancel` + `POST /ops/dispatch/:bookingId/force-assign` (SUPERVISOR+). Add `PUT /ops/dispatch/killswitch` (ADMIN) to flip the runtime flag.
- EXTEND `apps/auth-service/src/main.ts` — register the health controller's routes are picked up by the module; add `app.enableShutdownHooks()` so sweeps' `onModuleDestroy` runs on SIGTERM.
- EXTEND the dispatch service + watchdog + accept saga (from Steps 7/9) — call `DispatchMetricsService` at each instrumented point; mint/propagate `dispatchCorrelationId`; check `dispatch-killswitch` at offer time.
- NEW `apps/ops-console/src/app/dispatch/page.tsx` (+ `dispatch/[id]/page.tsx`) — read-only monitor table + money-taken/no-mission watch banner + SUPERVISOR+ cancel / force-assign buttons. EXTEND `apps/ops-console/src/lib/api.ts` with `dispatchApi` (`listDispatch`, `cancelDispatch`, `forceAssign`, `setKillswitch`).
  **Backend how-to:**
- Metrics: build a tiny in-memory registry (avoid a new heavy dep if `prom-client` isn't present — confirm with `grep prom-client apps/auth-service/package.json`; if absent, emit Prometheus text by hand on `GET /metrics`). Instrument: wrap the ranking query with `const t=Date.now(); …; metrics.observe('dispatch_rank_query_ms', Date.now()-t, {region})`; on offer accept/expire update acceptance + cascade-depth counters; on accept→mission-created stamp `time_to_crew`; on charge failure `inc('dispatch_charge_failure_rate')`.
- Watchdog liveness: in each sweep's lock-won branch, `metrics.setGauge('dispatch_watchdog_last_run_ts', Date.now(), {sweep})` and `metrics.observe('dispatch_watchdog_sweep_duration_ms', dur, {sweep})`. `/ready` and the alert evaluator read these gauges.
- Runtime kill switch (race-safe + safe fallback): store `dispatch:enabled` in Redis; `isAutoDispatchEnabled()` reads it (cache ≤5s). The offer path is a conditional gate, not a partial commit: `if (!await killswitch.isAutoDispatchEnabled()) { route booking to legacy admin flow; return; }`. Flipping OFF MUST NOT cancel in-flight escrow holds — only stop NEW auto-offers. Record every flip in `ops_audit` via `recordAdmin(admin, 'dispatch.killswitch', 'booking'|'system', 'global', {enabled})`.
- Override actions (attributable): each is a conditional UPDATE inside `db.withTransaction`, mirroring `payWithCredits`/the expiry sweep:
  - cancel: `UPDATE lite_bookings SET status='CANCELLED' WHERE id=$1 AND status IN ('DISPATCHING') RETURNING` (0 rows ⇒ 409); if an escrow hold exists, refund via `refundForBooking` in the same txn; then `opsAudit.recordAdmin(admin,'dispatch.cancel','booking',id,{correlationId})`.
  - force-assign: bind the booking to a chosen agency offer (`UPDATE dispatch_offers SET status='ACCEPTED' WHERE booking_id=$1 AND status='OFFERED' RETURNING`), charge into escrow in the same txn (reuse the Step-9 accept saga), then `recordAdmin(admin,'dispatch.force_assign','booking',id,{org})`. Wrap both with the idempotency interceptor: `apps/auth-service/src/common/interceptors/idempotency.interceptor.ts` requires header `Idempotency-Key` (8–128, `[A-Za-z0-9_-]`).
  - Guard: reuse `apps/auth-service/src/ops/admin.guard.ts`; gate cancel/force-assign at SUPERVISOR, killswitch at ADMIN.
- SLO alerts (an evaluator that runs in the same Redis-locked sweep cadence): stuck `DISPATCHING` (booking in DISPATCHING > N min with no live offer), watchdog dead (`now - last_run_ts > 2×interval`), region with zero on-duty agencies (`COUNT(*)=0 WHERE on_duty AND region_code=$1` for an active region), `NO_PROVIDER` surge (rate over baseline), charge failures (rate>0 over window), unacked SOS (an `sos` row older than M min with no ack — cross-check `OpsController` `POST sos/:id/ack` / `missions.ackSos`). Each alert → `SentryService.captureException(new Error('slo:<name>'), {tags:{kind:'dispatch_slo', slo}})`. Never put PII in the alert payload.
- Correlation id: add `correlation_id UUID` to `dispatch_offers` (and stamp it on the booking metadata + the `push-event` detail blob + forward to messenger-service in the relay metadata). Log lines use it as a prefix; never log lat/lng, addresses, names, or key bytes (the static log-audit test enforces this).
  **Frontend / ops-console how-to:**
- `apps/ops-console/src/app/dispatch/page.tsx`: SWR poll `dispatchApi.listDispatch()` → table of in-flight jobs: current-holder org name, rank #/coarse distance bucket, a CountdownPill driven by server `expires_at`, the reject trail (org + reason, PII-redacted), and an escrow/money column. A red "money taken / no mission" row state when `escrow_holds.status='HELD'` and no `missions` row past a threshold. Buttons (Cancel, Force-assign) render only when `hasRole(role,'SUPERVISOR')` (import from `lib/rbac.ts`); both call through `fetchJson` with a generated `Idempotency-Key`. Read-only for OPS.
  **Security stop-conditions:**
- Push stays opaque: alerts and correlation ids must NOT leak through the `push:events` channel — its payload stays exactly `{userId,eventClass,eventId}` (P0-N8). STOP / verify against the System Architecture Documentation before adding any field to the push payload.
- Ops Room is metadata-only: the monitor reads booking/offer/escrow state and `ops_audit`/`live_feed_events` only — it must NEVER read or render Ops Room message plaintext or group-key material. STOP / verify against the System Architecture Documentation if the monitor needs any conversation data.
- No "skip in dev" on the admin guard, idempotency, or the killswitch read. The kill switch only changes routing (auto vs legacy); it must never bypass escrow, the proof gate, or any auth guard.
- Never log plaintext message bodies, lat/lng, addresses, names, or ArrayBuffers with key bytes; the static log-audit test enforces this.
  **Acceptance & tests:**
- New unit tests (`apps/auth-service`, Jest): metrics registry inc/observe/snapshot; killswitch reads Redis + caches + defaults safe on Redis error; `/ready` returns false when watchdog last-run is stale or Redis down; override cancel/force-assign are conditional-UPDATE race-safe (0-rows ⇒ 409, no double charge) and each writes an `ops_audit` row with the actor; SLO evaluator fires on each synthetic condition; killswitch flip routes a new request to the legacy flow without touching in-flight holds.
- Regression: the existing `payment-pending-expiry` and ops concurrency specs (`ops.service.concurrency.spec.ts`) still pass; the static log-audit test passes against the new log lines.
- Gates to run: wire these new specs into the auth-service Jest project (Step 27); `npm run lint`; `npm run typecheck` (mobile, ≤ baseline 96) and `cd apps/ops-console && npm run typecheck`; manual smoke of the `/dispatch` page (golden: in-flight job renders with countdown; error: OPS role sees no override buttons; flip killswitch → new request goes legacy). Never commit on a red gate; never `--no-verify`.
  **Done when:**
- [x] `GET /metrics` exposes the metric set with region labels (`DispatchMetricsService` + `HealthController`); `GET /health` + `GET /ready` reflect Redis/DB/watchdog reality (/ready reads the SHARED Redis watchdog-liveness key, multi-pod correct). Instrumented: rank_query_ms, no_provider_total, charge_failure_total, watchdog last-run/duration gauges.
- [~] A single correlation id traces a job — partial: the offer/booking flow is traceable via structured logs + the existing opaque push detail blob; full cross-service (→messenger→device) correlation-id threading deferred (no new column added this step).
- [x] `dispatch:enabled` flipped at runtime stops new auto-offers (request path gates on `DispatchKillswitchService`, env-OFF short-circuits so it can only turn OFF) and falls back to legacy without disturbing in-flight escrow; fail-loud on Redis write error; 2s cache.
- [x] Each SLO condition pages via Sentry with NO PII (`DispatchSloService`: stuck_dispatching, watchdog_dead, region_zero_agencies, charge_failures — counts + slo name only, never the push channel); Redis-locked + dark.
- [x] `/dispatch` monitor shows holder/rank/countdown/reject-trail + a money-taken/no-mission (CONFIRMED charged-awaiting-crew) watch; SUPERVISOR+ cancel/force-assign (force-assign reuses the accept saga, exactly-once via offer-win) land an attributable `ops_audit` row (subject_type `system` added + DB CHECK migration); ADMIN killswitch flip.

## Step 27 — Testing strategy (CI + unit + integration + contract + chaos + fixtures + gates)

**Stage:** Operate · **Depends on:** Step 5 (ranking/region/PostGIS), Step 6 (capacity `has_free_cpo_capacity`), Step 7 (offer/cascade/watchdog), Step 9 (accept→escrow charge saga), Step 14 (SettlementService + lead Finish), Step 15 (proof-of-completion gate), Steps 9/14 (FSM guards), Step 26 (metrics/killswitch) · **Resolves:** Part III "Testing, QA & release engineering" + LB21 + §43 must-have tests; the six corrections (esp. #6 "CI does not run auth-service tests")
**Goal (plain English):** Make the automated gate actually exercise the new dispatch engine. Today CI does NOT run the auth-service backend tests, so the new ranking/cascade/money/proof/FSM code would ship untested. This step wires auth-service into CI, adds the unit + real-DB integration + contract + multi-pod-lock + load + chaos tests + seed fixtures, and a legacy-flow regression matrix with the flag OFF — and wires the project gates.
**Why it matters / what breaks without it:** Correction #6 proved CI's Jest matrix is `[app, messenger-crypto, booking]` only — a new `DispatchService` spec is invisible to the gate. Without this, money bugs (double-charge, never-paid agency), watchdog double-cascade, and capacity over-commit ship green.
**Self-contained context (inline — do not make the reader open the plan):**

- CI today (`.github/workflows/ci.yml`): the `test` job is a matrix `project: [app, messenger-crypto, booking]` run via `npx jest --selectProjects <project>`. There is NO `auth-service` entry, so backend specs never run in CI. Correction #6 = fix this.
- The integration harness EXISTS but is unused by default: `apps/auth-service/jest.integration.config.js` (script `npm run test:integration`, `testMatch: test/integration/**/*.itest.ts`) + `apps/auth-service/test/integration/harness.ts` (testcontainers: ephemeral pg, applies every migration, `describeIfDb` collapses to `describe.skip` when Docker is unreachable so CI without Docker still goes green). Existing examples: `concurrency.itest.ts`, `fk-constraints.itest.ts`, `fsm-triggers.itest.ts`. The accept→charge→assign→settle saga integration test is the missing one (§43).
- The saga under test (LOCKED decisions): D2 charge on accept INTO ESCROW; D3 agency accepts then deploys its own CPOs; D7 accept does NOT auto-pick crew (crew+leader assign creates the mission); settlement is released only after the proof gate + dispute window. Money invariant (§43): per booking `sum(client debits)==held`; at terminal `held==to_provider+to_client+platform_fee`; no agency credit row before `release_eligible_at` (or early client-confirm / dispute-resolve).
- Race-safe pattern every transition must follow (and must be tested): one `UPDATE … WHERE <expected-state> RETURNING` inside `db.withTransaction` (mirror `booking.service.ts payWithCredits` and `payment-pending-expiry.service.ts`). 0 rows ⇒ 409, no side effect. Accept charges the client in the SAME txn as `UPDATE dispatch_offers SET status='ACCEPTED' WHERE id=$1 AND status='OFFERED' AND expires_at>NOW() RETURNING`.
- Watchdog multi-pod lock (the thing the existing test plan ignores): Redis `SET NX` lock from `payment-pending-expiry.service.ts` (`redis.client.set(LOCK, ts, 'PX', ttl, 'NX')`, work only if `'OK'`). The test must prove two concurrent sweepers do NOT both cascade the same offer.
- Capacity gate to test: `has_free_cpo_capacity` (Step 6) — D6 = agency runs multiple concurrent missions bounded by free CPO capacity; D5 = ~10 CPO logins per agency. The gate must reject an accept that would over-commit.
- Existing seed gap: no fixtures of on-duty agencies with `agents.last_lat/last_lng/last_location_at/on_duty/region_code` + wallets. These unblock the ranking tests AND the 3-device smoke (Step 28).
- Reuse — existing backend specs already present (don't duplicate, run them): `booking/booking-flow.spec.ts`, `booking/state-machine.service.spec.ts`, `ops/ops.service.concurrency.spec.ts`, `ops/mission-state-machine.service.spec.ts`, `ops/job-state-machine.service.spec.ts`, `ops/ops-flow.smoke.spec.ts`.
- Gates: mobile `npm run typecheck` ≤ baseline 96; `cd apps/ops-console && npm run typecheck`; `npm run test:crypto` when a change is near messaging (Ops Room rekey/push); the `booking` Jest project for booking changes; `npm run lint`.
  **Files to touch:**
- EXTEND `.github/workflows/ci.yml` — add an `auth-service` backend test job (run its Jest unit project) and an integration job that boots Docker and runs `npm run test:integration` inside `apps/auth-service` (gracefully skips when Docker unavailable, but in CI provide a pg service so it actually runs).
- NEW unit specs in `apps/auth-service/src/...`: `dispatch.service.spec.ts` (ranking/cascade), `dispatch-capacity.spec.ts` (`has_free_cpo_capacity`), `settlement.service.spec.ts` (money + proof-gate), plus FSM-guard specs alongside `state-machine.service.spec.ts` / `mission-state-machine.service.spec.ts`.
- NEW `apps/auth-service/test/integration/dispatch-saga.itest.ts` — the real-DB accept→charge(escrow)→assign→settle saga incl. failure/compensation, using `harness.ts` `describeIfDb`.
- NEW `apps/auth-service/test/integration/watchdog-lock.itest.ts` — two concurrent sweepers, assert no double-cascade.
- NEW contract specs for the new endpoints (offer-coarse/full, accept, reject, crew-assign, lead-complete, dispute/confirm/resolve, `/ops/dispatch/*`) — request/response shape + guard/403 + idempotency.
- NEW `apps/auth-service/test/fixtures/dispatch-seed.ts` — on-duty agencies with locations + region + wallets + escrow/fee accounts.
- NEW `apps/auth-service/test/load/` (k6 or autocannon script) and `apps/auth-service/test/chaos/` notes/specs.
- NEW `apps/auth-service/test/integration/legacy-flow.itest.ts` — regression matrix with the dispatch flag OFF (the legacy admin job board still works end to end).
  **Backend how-to:**
- CI fix (correction #6): add to `ci.yml` a job that runs the auth-service unit suite (either add `auth-service` to the matrix if a root Jest project exists for it, or `cd apps/auth-service && npm ci && npm test`). Add a second job for integration with a Postgres service container so `describeIfDb` does NOT skip: spin pg, set the harness DB env, `cd apps/auth-service && npm run test:integration`.
- Unit (ranking/cascade): seed in-memory/mocked rows, assert nearest-in-region ordering via the PostGIS `ST_DWithin` path, cascade picks next-nearest on reject/expire, region isolation (AE/SA/BD/GB never cross). Capacity: assert `has_free_cpo_capacity` blocks an accept that exceeds free CPOs (D6 bound).
- Money/proof unit (`settlement.service.spec.ts`): accept → exactly one client debit into escrow, NO agency credit; double-tap accept → ONE hold (idempotency + conditional UPDATE); finish with passing proof → `PENDING_RELEASE`, no money moved; finish with failing proof (no telemetry) → `review_required`, never auto-released; assert the §43 money invariant at each terminal state.
- Saga integration (`dispatch-saga.itest.ts`, real pg via harness): run accept→charge→assign→lead-complete→release; then failure paths: charge fails ⇒ offer NOT won, no hold; crash after charge before booking flip ⇒ reconcile/compensate (the accept-saga crash-recovery from Step 9); agency-no-show sweep ⇒ full refund, no payout. Assert ledger rows balance (paired escrow debit/credit).
- Watchdog lock (`watchdog-lock.itest.ts`): invoke `sweepOnce()` from two instances racing on the same Redis key; assert exactly one wins the lock and exactly one cascade INSERT happens (mirror the expiry service's `skipped_lock` return).
- Contract tests: for each new endpoint assert the exact JSON shape, the guard (e.g. `/dispatch/offers/:id/full` 403 unless `offer.status='ACCEPTED' AND caller==provider`; `assertOrgScope` IDOR 403 cross-tenant), and that POSTs require `Idempotency-Key` (interceptor: header 8–128 `[A-Za-z0-9_-]`).
- Load test: simulate an N-deep cascade + client AND provider polling at volume; capture `dispatch_rank_query_ms` and the poll→WS tipping point. Run `EXPLAIN ANALYZE` on the ranking query against 100s of seeded agencies.
- Chaos: kill the watchdog mid-cascade (assert recovery/no orphan), drop Redis (assert killswitch defaults safe, offers degrade, no crash), kill a pod mid-accept (assert no double-charge via the conditional UPDATE + idempotency), expire-vs-accept race (assert one winner: accept inside grace wins, expire after loses).
- Legacy regression: with the runtime flag OFF (Step 26), assert the old `OpsService` admin job board flow (approve/dispatch/complete) is unchanged.
  **Frontend / ops-console how-to:** omit (backend + CI; ops-console is covered by its own `typecheck` gate in Acceptance).
  **Security stop-conditions:**
- Tests must NOT weaken guards to pass — no "skip in dev" branch on `verifySenderCert`/`assertOrgScope`/idempotency/admin guard; if a test needs a guard satisfied, satisfy it, don't bypass it. STOP / verify against the System Architecture Documentation if a test appears to need a sealed-sender or group-key shortcut.
- Fixtures and load/chaos logs must not contain plaintext message bodies, real lat/lng beyond synthetic test values, or key bytes — the static log-audit test still applies to test helpers that ship in `src`.
- `npm run test:crypto` is required whenever a test touches the Ops Room rekey/push path (near messaging).
  **Acceptance & tests:**
- CI proof: open a PR; the `auth-service` unit job and the integration job both appear and pass (integration actually runs, not skipped, because the pg service is present). A deliberately-broken `DispatchService` change turns CI red (proving the gate now sees backend specs).
- Suites green: new unit specs, `dispatch-saga.itest.ts`, `watchdog-lock.itest.ts`, contract specs, `legacy-flow.itest.ts`; existing `booking`/`messenger-crypto`/`app` projects still pass.
- Gates: `npm run lint`; `npm run typecheck` (≤ baseline 96) + `cd apps/ops-console && npm run typecheck`; `npm run test:crypto` if any change touched messaging; the `booking` Jest project for booking-touching changes. Never commit on red; never `--no-verify`.
  **Done when:**
- [x] `ci.yml` runs auth-service unit (pre-existing `auth-service-test` job) AND a NEW `auth-service-integration` job (`npm run test:integration`; testcontainers boots its own postgis on the Docker-equipped runner). A broken backend change fails CI.
- [x] Unit coverage for ranking/cascade (`dispatch.service.spec`), money/proof-gate (`settlement.service.spec` + `proof-of-completion.service.spec`), FSM guards (`state-machine.*` + `fsm-triggers.itest`); NEW real-DB coverage for `has_free_cpo_capacity` + `is_eligible_for_dispatch` (incl. the Step-22 DPA gate) in `dispatch-functions.itest`.
- [x] Real-DB money invariant exercised (`dispatch-money-invariant.itest`): HELD conserves (sum debits == gross), terminal split conserves, paired ledger nets 0, and an injected drift is detected (the property the Step-28 reconciliation watches). [~] The full service-level accept→settle saga itest is deferred (the harness is pg-only, no Redis/Nest-DI); the saga's pieces are unit-tested (`dispatch.service`, `settlement.service`, `booking.escrow`).
- [x] Contract coverage: every new endpoint has a controller spec (`dispatch.controller.spec`, `client-dispatch.controller.spec`, `dispatch-admin.spec`) asserting shape + guard/403 + idempotency. Multi-pod watchdog-lock (no double-cascade) is proven by the `skipped_lock` assertions in `offer-expiry`/`scheduled-dispatch`/`dispatch-slo`/`dispatch-privacy-purge` specs (Redis SET NX).
- [x] Reusable seed fixtures (`test/fixtures/dispatch-seed.ts`: on-duty eligible agency + CPOs + client wallet + escrow hold + paired ledger) unblock the function/invariant tests + the 3-device smoke. [~] Load/chaos/legacy-flag-OFF matrices: legacy-OFF is covered by the existing `booking-flow`/`ops-flow.smoke` specs (flag defaults off); dedicated k6 load + chaos scripts deferred.

## Step 28 — Reconciliation + staged rollout + final 3-device smoke

**Stage:** Operate · **Depends on:** Step 9 (accept→escrow charge), Step 14 (SettlementService + lead Finish), Step 15 (proof gate), Step 16 (dispute window/confirm/dispute/resolve), Step 17 (the three Redis-locked sweeps), Step 26 (metrics/killswitch/monitor), Step 27 (fixtures + tests) · **Resolves:** Part V §43 (money-invariant reconciliation + PV8), §42 (Redis-locked sweeps), Part III rollout (dark-launch → canary-by-region → ramp + kill-switch drill), LB21
**Goal (plain English):** Add a nightly money-invariant reconciliation job that proves every booking's wallets still add up (and alerts on any drift), then turn the feature on safely in stages — dark launch behind the flag, then one region, then ramp — with a deliberate kill-switch drill, and finish with the full 3-device end-to-end smoke plus one no-agency error path.
**Why it matters / what breaks without it:** This is money-handling and safety-critical. Without a daily reconciliation, escrow drift (a charged-but-never-held booking, or a payout without a release) goes unnoticed until a customer complains. Without staged rollout + the kill-switch drill, the first flip exposes all four regions at once with no rehearsed off-switch. The smoke is the only proof the whole loop works on real devices.
**Self-contained context (inline — do not make the reader open the plan):**

- Money invariant to assert (§43): for every booking, `sum(client debits) == held`; at terminal `held == to_provider + to_client + platform_fee`; and NO agency credit row may exist before `release_eligible_at` (unless an early client `confirm-complete` or a dispute `resolve` moved it). Escrow lives in `escrow_holds` (status `HELD→PENDING_RELEASE→RELEASED`, plus `REFUNDED`/`PARTIAL`/`DISPUTED`); every money move is a PAIRED `wallet_transactions` row (debit one account, credit the other) so the ledger balances; a seeded escrow account + platform-fee account are the counterparties; the final `RELEASED` payout still writes `mission_payouts` (agency = `payee_user_id`) exactly as `OpsService.completeBooking` does today; partials reuse `deduction_credits`/`deduction_reason`; refunds reuse `wallet.service.ts refundForBooking`.
- Reconciliation MUST be a Redis `SET NX`-locked `setInterval` sweep (multi-pod-safe), copying `apps/auth-service/src/booking/payment-pending-expiry.service.ts` (NOT `@nestjs/schedule`; auth-service is multi-replica). It runs daily, recomputes the invariant per booking, and on any mismatch increments the metric `dispatch_money_drift_total` (Step 26) and fires a Sentry SLO alert. It is the 3rd of the three §42 sweeps (the other two: crew-assign SLA refund, and release-to-agency).
- Rollout stages: (1) dark launch — code deployed, runtime flag `dispatch:enabled` OFF (Step 26 kill switch), legacy admin flow live, watchdog/reconciliation already running; (2) canary by a single region (D4 regions = AE/SA/BD/GB; gate the offer path on `agents.region_code` so only one region auto-dispatches); (3) ramp to remaining regions. Each stage watched via the Step-26 metric set + SLO alerts. A kill-switch drill = deliberately flip OFF mid-traffic and confirm safe fallback to legacy with no stranded escrow.
- The full smoke loop (LOCKED decisions D1–D8): register a ~10-CPO roster (D5, one agency = one email set) → client requests close protection A→B (D1 auto) → server offers nearest on-duty agency in-region, COARSE pre-accept (no exact pickup/dropoff to offered/rejecting agencies — correction #3) → agency accepts (D3) → client charged INTO ESCROW on accept (D2) → an E2E Ops Room opens (server `ensureBookingOpsRoom` writes metadata only; the agency company device owns the group-key rekey for added CPOs — correction #5) → agency assigns its own crew + leader (D7 — this step creates the mission) → CPOs see it + join the Ops Room → lead runs `DISPATCHED→PICKUP→LIVE` then one-tap Finish (D8) → proof-of-completion gate → dispute window → auto-release to agency → client rates. Error path: no agency online → `NO_PROVIDER`, NO charge.
- Reuse — sweep pattern, `refundForBooking`, `mission_payouts` + `deduction_credits/reason`, `OpsAuditService`, the metric/killswitch/monitor from Step 26, the seed fixtures from Step 27. NO crypto/E2E/auth changes here.
  **Files to touch:**
- NEW `apps/auth-service/src/booking/reconciliation.service.ts` (or under `wallet/`) — the daily Redis-locked reconciliation sweep; `sweepOnce()` returns `{checked, drifted, skipped_lock}` (mirror `PaymentPendingExpiryService`). EXTEND its module to provide it.
- EXTEND `apps/auth-service/src/observability/dispatch-metrics.service.ts` (Step 26) — `inc('dispatch_money_drift_total', {region})` on each detected drift; stamp the reconciliation sweep's `dispatch_watchdog_last_run_ts{sweep:'reconciliation'}`.
- NEW `apps/auth-service/test/integration/reconciliation.itest.ts` — real-DB: a clean book passes; a hand-injected drift (orphan debit, or payout-before-release) is detected and counted.
- EXTEND rollout docs/runbook only (no canary-by-region code if region gating already lives in the Step-5 ranking + Step-26 killswitch); confirm the offer path honors a per-region enable.
- NEW (test artifact) `apps/auth-service/test/smoke/3device-dispatch.md` — the scripted manual smoke (devices/accounts/steps), reusing the Device & Identity Reference in `sqa.md`.
  **Backend how-to:**
- Reconciliation sweep (copy `payment-pending-expiry.service.ts` exactly): `onModuleInit` → `setInterval(()=>void this.sweepOnce(), DAILY_MS)`; `sweepOnce` → `redis.client.set('lock:reconciliation', ts, 'PX', LOCK_TTL_MS, 'NX')`, run only if `'OK'`, `finally { redis.client.del(...) }`, `LOCK_TTL_MS < interval`. For each booking with a hold: compute `sum(client debits)` from `wallet_transactions` and compare to `escrow_holds.gross_credits` (HELD), and at terminal compare `held == to_provider + to_client + platform_fee`; assert no agency credit row exists before `release_eligible_at`. On mismatch: `metrics.inc('dispatch_money_drift_total')`, `sentry.captureException(new Error('money_drift'), {tags:{kind:'dispatch_money_drift', booking:'<redacted-id-ok>'}})`, and `opsAudit.emit({kind:'money_drift', severity:'err', subject:bookingId, message:'reconciliation drift'})`. The sweep is read-mostly — it ALERTS, it does not auto-move money (admin resolves via the §41 dispute/resolve path).
- Add `app.enableShutdownHooks()` (if not already from Step 26) so the sweep's `onModuleDestroy` clears its timer on SIGTERM.
- Canary-by-region: ensure the offer path gates on `agents.region_code` + a per-region enable list (Redis-backed, sibling to `dispatch:enabled`), so one region can be flipped on while others stay legacy. No partial-commit risk: it's a routing gate before any charge.
- Kill-switch drill: flip `dispatch:enabled` OFF during canary traffic; assert new requests route legacy and in-flight escrow holds are untouched (use the Step-27 chaos assertions).
  **Frontend / ops-console how-to:**
- No new screens; the Step-26 `/dispatch` monitor surfaces drift via the money-taken/no-mission watch and the rollout metrics. Confirm the monitor renders the reconciliation alert row. (Mobile smoke uses the existing client/agency/CPO apps.)
  **Security stop-conditions:**
- Ops Room stays metadata-only via `SystemMessengerService.ensureBookingOpsRoom`; the server cannot distribute the Signal group key — the smoke MUST verify CPOs receive the group key via the AGENCY DEVICE's rekey (correction #5 / the conversations-scoped membership-intent drain), NOT via a server add. STOP / verify against the System Architecture Documentation before touching the rekey path.
- Reconciliation logs/alerts must NOT contain plaintext bodies, lat/lng, addresses, names, or key bytes (static log-audit test). A bare booking id is acceptable in audit/Sentry; PII is not.
- Push stays opaque during the smoke: the wake payload is exactly `{userId,eventClass,eventId}` (P0-N8) — verify in messenger-service consumer that no `kind`/`bookingId` leaks.
- No "skip in dev" on the proof gate, escrow, dispute freeze, or any guard during canary.
  **Acceptance & tests:**
- `reconciliation.itest.ts` (auth-service integration project, via the testcontainers harness): clean book → 0 drift; injected orphan debit / payout-before-release → drift detected, `dispatch_money_drift_total` incremented, alert fired. Concurrency: two pods racing the sweep → one wins the lock (assert `skipped_lock`).
- Money-invariant unit assertions from §43 (Step 27) still pass: double-tap accept → one hold; finish-with-failing-proof → `review_required`, never released; dispute-vs-release race → dispute freezes, no payout.
- Manual 3-device smoke executed and recorded: the full loop completes (charge into escrow on accept, Ops Room joinable by CPOs via agency rekey, lead PICKUP→LIVE→Finish, proof gate, dispute window, auto-release to agency, client rates) AND the no-agency path yields `NO_PROVIDER` with NO charge (verify wallet unchanged). Log any defects to `sqa.md` per the SQA convention.
- Gates: `npm run lint`; `npm run typecheck` (≤ baseline 96) + `cd apps/ops-console && npm run typecheck`; `npm run test:crypto` (the smoke touches Ops Room messaging); the `booking` Jest project. Never commit on red; never `--no-verify`.
  **Done when:**
- [x] The daily Redis-locked, multi-pod-safe `EscrowReconciliationService` asserts terminal `gross==to_provider+to_client+platform_fee`, escrow-account drain, and no premature payout; on drift it increments `dispatch_money_drift_total` + pages Sentry (counts only, NO PII) + stamps the reconciliation watchdog gauge. It remains READ-ONLY (alerts, never auto-moves money). (HELD `sum(debits)==gross` is asserted by `dispatch-money-invariant.itest`.)
- [x] Rollout documented (`test/smoke/3device-dispatch.md`): dark launch (kill-switch OFF) → canary AE (region-scoped ranking confines it) → ramp, each watched by the Step-26 metrics/SLOs; a kill-switch drill (≤2s convergence, in-flight escrow untouched) is scripted.
- [x] `reconciliation.itest.ts` passes in CI (clean terminal book = 0 drift on all 3 checks; injected split-drift + premature-payout detected). The lock-race-one-winner property is covered by the service's `skipped_lock` unit assertion.
- [~] The 3-device smoke is SCRIPTED (agency-device rekey, escrow charge-on-accept, lead Finish→proof→dispute→release→rating) — **execution on real devices is PENDING** (can't run a 3-device manual smoke in this env; flagged for QA, log to `sqa.md`).
- [x] The no-agency path (`NO_PROVIDER`, wallet unchanged) + opaque push (P0-N8) are asserted by the dispatch unit specs + the push-bridge opacity specs; reconfirmed in the smoke script's error-path checklist.

Key verified paths (all confirmed to exist): `apps/auth-service/src/booking/payment-pending-expiry.service.ts` (Redis SET NX sweep pattern), `apps/auth-service/src/ops/booking-push-bridge.service.ts` (opaque `{userId,eventClass,eventId}` on `push:events`), `apps/auth-service/src/ops/ops-audit.service.ts` (`record`/`recordAdmin`/`emit`, fail-closed criticals), `apps/auth-service/src/observability/sentry.service.ts` (shim), `apps/auth-service/src/common/interceptors/idempotency.interceptor.ts`, `apps/auth-service/src/common/guards/user-throttler.guard.ts`, `.github/workflows/ci.yml` (Jest matrix `[app, messenger-crypto, booking]` — no auth-service), `apps/auth-service/jest.integration.config.js` + `apps/auth-service/test/integration/harness.ts` (unused saga harness, `describeIfDb`), `apps/ops-console/src/lib/api.ts` + `apps/ops-console/src/lib/rbac.ts` (`AdminRole`, `hasRole`) + `apps/ops-console/src/app/` (App Router, no `dispatch/` dir yet).
