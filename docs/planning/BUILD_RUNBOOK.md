# Bravo Secure â€” Auto-Dispatch BUILD RUNBOOK

> **What this file is.** An ordered, **self-contained** build sequence for the Uber-style
> bodyguard auto-dispatch system. Each step below is a complete work packet â€” goal, context,
> exact files, backend + frontend how-to, security stop-conditions, and acceptance tests â€” so
> you can hand **one step at a time** to a fresh engineer (or a fresh Claude session) and they
> have everything they need _without_ reading the full design doc.
>
> **Companion design doc:** `docs/planning/UBER_DISPATCH_PLAN.md` (Parts Iâ€“V + Â§35A) holds the deeper
> rationale and the 12-perspective hardening review. This runbook is the _executable_ version
> of it. Where a step says "Resolves: Phase X / LB# / PV# / Â§##", that points back into the
> plan if you want the full story â€” but you shouldn't need to.

## How to use this runbook

1. **Build in order.** Steps are dependency-ordered. Each packet lists its `Depends on:`.
2. **One step = one focused PR**, behind the `AUTO_DISPATCH_ENABLED` flag (Step 1) until the
   rollout step flips it on. The legacy admin-mediated flow must keep working the whole time.
3. **Every step ends with `Acceptance & tests` and `Done when`** â€” don't mark a step done
   until those pass, including the project gates (typecheck baseline 96, the relevant Jest
   project, `test:crypto` if you touched messaging, lint).
4. **Honor the security stop-conditions** in each packet â€” they mark the places that touch
   E2E encryption, opaque push, money, or auth, where you must re-read the System Architecture
   Documentation before coding.
5. **Build-time flag lockstep (B-51, 2026-07-06).** `EXPO_PUBLIC_*` feature flags are baked at
   bundle time from whichever env reaches `expo export:embed`. The `apk:staging` npm script sets
   them inline; the Firebase release pipeline (`scripts/release-apk.ps1` -> bare
   `gradlew assembleRelease`) bakes **`.env.production`**. v1.0.100 shipped with
   `EXPO_PUBLIC_DEPT_CHAT_V2`/`EXPO_PUBLIC_AUTO_DISPATCH` silently OFF (Departmental module
   vanished, B-51) because they existed only in the script env. Any new `EXPO_PUBLIC_*` flag MUST
   be added to BOTH the `apk:staging` script line AND `.env.production`.

## âš ï¸ Six corrections the design review found in the code (read before Step 1)

These were verified against the real source and are baked into the steps below:

1. **Background loops use the Redis `SET NX`-locked `setInterval` pattern** in
   `apps/auth-service/src/booking/payment-pending-expiry.service.ts` â€” **NOT** `@nestjs/schedule`
   (not a dependency; auth-service is multi-replica, so a bare loop double-fires per pod).
2. **The lead's one-tap Finish does not settle money today** (settlement is admin-only in
   `OpsService.completeBooking`) â€” you must extract a `SettlementService` (Step 10).
3. **The offer must be coarse pre-accept** â€” never ship exact pickup/dropoff to offered/
   rejecting agencies; precise location only after accept (Step 7).
4. **`agents` has no `region_code`** and haversine-in-SQL is a full scan â€” add region + use
   **PostGIS `geography`+GiST+`ST_DWithin`** (Steps 2 & 6). (The `last_lat/last_lng/
last_location_at` columns are also missing from any migration though code writes them â€” add
   them defensively in Step 2.)
5. **The server cannot add a CPO to the E2E Ops Room** (no group-key path for `conversations`
   rooms) â€” the agency device must own the rekey (Step 12).
6. **CI does not run `auth-service` tests** (Jest matrix is `[app, messenger-crypto, booking]`)
   â€” fix CI in Step 1 or your new tests are invisible.

## Locked product decisions (quick reference)

`D1` fully automatic (admin only monitors/overrides) Â· `D2` charge on accept **into escrow**,
released only on verified completion Â· `D3` the **agency** accepts then deploys its own CPOs Â·
`D4` nearest within same region (AE/SA/BD/GB) Â· `D5` agency registers up to ~10 real CPO login
emails (one email = one agency) Â· `D6` agency runs multiple concurrent missions bounded by free
CPO capacity Â· `D7` accept does **not** auto-pick crew (agency assigns crew+leader, which
creates the mission) Â· `D8` shared stepper + leader-only status + one-tap finish.

## Master step index

**Stage 0 Â· Foundations**

- **Step 1** â€” Branch, dual feature flag & build/CI foundations _(start here)_
- **Step 2** â€” Core dispatch DB migration (`dispatch_offers`, booking cols/statuses, agents region + PostGIS) _(dep: 1)_
- **Step 3** â€” Money + compliance DB migration (`escrow_holds`, `booking_disputes`, licence/insurance, armed) _(dep: 1)_

**Stage 1 Â· Identity & availability**

- **Step 4** â€” Role discriminator (`account_kind`) + CPO session guard _(dep: 1)_
- **Step 5** â€” Provider go-online + background location heartbeat _(dep: 2)_

**Stage 2 Â· Dispatch engine**

- **Step 6** â€” `DispatchService`: proximity ranking + offer cascade _(dep: 2,3,5)_
- **Step 7** â€” Offer endpoints: coarse visibility + IDOR scope + idempotency + throttle _(dep: 6)_
- **Step 8** â€” Watchdogs (Redis-locked): offer-expiry cascade + crew-assign SLA _(dep: 6,7)_

**Stage 3 Â· Money**

- **Step 9** â€” Escrow on accept (charge â‰  pay) _(dep: 3,7)_
- **Step 10** â€” `SettlementService` + lead one-tap Finish + proof-of-completion gate _(dep: 3,9)_
- **Step 11** â€” Dispute window, release sweep, refund/pro-rata/cancel-fee matrix, FX _(dep: 8,9,10)_

**Stage 4 Â· Comms & crew**

- **Step 12** â€” Ops Room group-key distribution under auto-dispatch _(dep: 4)_
- **Step 13** â€” Crew assignment + leader (creates the mission) _(dep: 9,12)_
- **Step 14** â€” Opaque push wiring + fix the consumer leak _(dep: 7,13)_

**Stage 5 Â· Safety & trust**

- **Step 15** â€” Vetting / licence / insurance / armed gates + client terms _(dep: 3,6)_
- **Step 16** â€” Identity handshake + pre-live SOS + no-show + no-provider fallback _(dep: 13)_

**Stage 6 Â· Apps (role-separated UI)**

- **Step 17** â€” Role routing + CPO activation + revocation _(dep: 4)_
- **Step 18** â€” Shared backbone: stepper + activity feed + component library _(dep: 4)_
- **Step 19** â€” CLIENT app UI (Finding / No-detail / Accepted / stepper) _(dep: 7,9,18)_
- **Step 20** â€” AGENCY app UI (cockpit / incoming-offer / missions board / assign-crew) _(dep: 7,13,18)_
- **Step 21** â€” CPO app UI (CpoNavigator, assigned mission, lead-only Finish) _(dep: 10,17,18)_

**Stage 7 Â· Cross-cutting & lifecycle**

- **Step 22** â€” Privacy, retention & consent _(dep: 7)_
- **Step 23** â€” Anti-fraud & marketplace integrity _(dep: 5,7)_
- **Step 24** â€” Lifecycle completeness & ratings loop _(dep: 6,10)_
- **Step 25** â€” i18n / RTL + currency _(dep: 18)_

**Stage 8 Â· Operate (observability, testing, rollout)**

- **Step 26** â€” Observability, kill-switch & ops monitor _(dep: 8,11)_
- **Step 27** â€” Testing strategy _(dep: all backend)_
- **Step 28** â€” Reconciliation + staged rollout _(dep: all)_

**Stage 9 Â· Live tracking & navigation** _(added after the 1â€“28 sequence shipped)_

- **Step 29** â€” Backend: mission deployment exposes the principal's live position (dual-marker telemetry) _(dep: 5,13)_
- **Step 30** â€” Dual live markers on the tracker (wire the principal marker in) _(dep: 29)_
- **Step 31** â€” CPO Live Mission Tracker + Google-Maps-style turn-by-turn navigation _(dep: 21,29,30)_
- **Step 32** â€” Service-provider (org manager) per-mission live monitor _(dep: 13,29,30,31)_

---

<!-- The 28 self-contained step packets follow, in order. -->

## Step 1 â€” Branch, dual feature flag & build/CI foundations

**Stage:** Foundations Â· **Depends on:** (none â€” first step) Â· **Resolves:** Part I Phase 0 (corrected by Part III âš ï¸ correction 1 & 6), Part III LB9, LB21
**Goal (plain English):** Start the whole auto-dispatch feature on its own branch, hidden behind an on/off switch on both the server and the phone app so we can build it "dark" without changing what customers experience today. Also fix the test robot (CI) so it actually runs the backend tests we're about to write, and lock in the right way to write background timers so we don't accidentally run them many times at once on our multi-server setup.
**Why it matters / what breaks without it:** Without the flag, half-built dispatch code could change live booking behavior; without the CI fix, every backend test we write for dispatch/escrow is invisible and a broken change ships green; without the agreed timer pattern, every background watchdog double-fires on each server replica (double-charging, double-cascading).
**Self-contained context (inline â€” do not make the reader open the plan):**

- LOCKED DECISION D1: dispatch is fully automatic; admin only monitors/overrides. The feature must ship behind one switch and the legacy admin-mediated flow (`POST /bookings` â†’ `PENDING_OPS` â†’ admin approve) must behave EXACTLY as today when the switch is off.
- Backend env flag lives in `apps/auth-service/src/config/configuration.ts` (verified): config is built from `process.env[...]` with defaults, e.g. `otp.devBypass: process.env['OTP_DEV_BYPASS'] === 'true'`. There is no feature-flags block yet â€” add one. Read it via NestJS `ConfigService` (ConfigModule is `isGlobal: true` in `app.module.ts`).
- Mobile runtime flag: the mobile config home is `src/utils/constants.ts` (verified) which inlines `EXPO_PUBLIC_*` vars at bundle time (`API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? ...`). The plan also allows a server-driven bootstrap field `autoDispatch: boolean`. Prefer a server-driven field so the flag can flip without a rebuild; fall back to an `EXPO_PUBLIC_AUTO_DISPATCH` constant for build-time gating. NOTE: Part III LB-observability flags the env flag is boot-time only â€” design the read so a later step can swap in a runtime kill-switch.
- CORRECTION (Part III âš ï¸1, LB9): `auth-service` runs MULTIPLE replicas. Every background loop (offer-expiry watchdog, book-later trigger, escrow sweeps) MUST copy the Redis `SET NX`-locked `setInterval` pattern in `apps/auth-service/src/booking/payment-pending-expiry.service.ts` (verified â€” note: it is in `booking/`, NOT `ops/` as some plan text says). It is explicitly NOT `@nestjs/schedule` â€” that package is NOT a dependency of `apps/auth-service` (verified: absent from `apps/auth-service/package.json`) and `ScheduleModule` is NOT imported in `app.module.ts` (verified). Do not add it.
- The canonical lock shape (verified, copy this): `const got = await this.redis.client.set(LOCK_KEY, String(Date.now()), 'PX', LOCK_TTL_MS, 'NX'); if (got !== 'OK') return {skipped_lock:true}; try { ...work... } finally { await this.redis.client.del(LOCK_KEY); }` with `LOCK_TTL_MS` shorter than the interval so a crashed sweeper self-releases.
- CORRECTION (Part III âš ï¸6, LB21): CI does NOT run `auth-service` backend tests. Verified `.github/workflows/ci.yml` Jest matrix is `project: [app, messenger-crypto, booking]` â€” all root/mobile Jest projects; there is no `auth-service` job at all. New `DispatchService`/escrow specs would never run in the gate.
  **Files to touch:**
- EXTEND `apps/auth-service/src/config/configuration.ts` â€” add a `featureFlags: { autoDispatch: process.env['AUTO_DISPATCH_ENABLED'] === 'true' }` block (mirror the existing `=== 'true'` boolean-env idiom).
- EXTEND `src/utils/constants.ts` â€” add `export const AUTO_DISPATCH = process.env.EXPO_PUBLIC_AUTO_DISPATCH === 'true';` AND/OR plumb an `autoDispatch` boolean through the server bootstrap response the app already fetches at login (preferred for flag-without-rebuild).
- EXTEND `.github/workflows/ci.yml` â€” add an `auth-service` Jest job (separate from the root matrix) that runs `cd apps/auth-service && npm ci --legacy-peer-deps && npm test`; gate it like the other test jobs. Optionally add `messenger-service` too.
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
  **Frontend / ops-console how-to:** Add the `AUTO_DISPATCH` constant / bootstrap field in `src/utils/constants.ts` (and the bootstrap type). No screen changes here â€” later client steps gate the new "Findingâ€¦" route on this flag. Ops-console needs no change in this step.
  **Security stop-conditions:** None beyond standard guards. Do NOT add a "skip in dev" branch to any guard while wiring the flag (CLAUDE.md: no dev-skip on `JwtAuthGuard`, `OrgManagerGuard`, `AdminGuard`, AppCheck). The flag gates the FEATURE path, never a security check.
  **Acceptance & tests:**
- New test: a backend unit test asserting that with `AUTO_DISPATCH_ENABLED` unset/false, the booking-create path takes the legacy branch (place under `apps/auth-service/src/booking/*.spec.ts`).
- Regression: run the `booking` Jest project `npm test -- --selectProjects=booking`; run `apps/auth-service` `npm test` locally and confirm the new CI job runs it.
- Gates: `npm run typecheck` (mobile, â‰¤ baseline 96), `cd apps/ops-console && npm run typecheck`, `npm run lint`. CI must show the new `auth-service` job executing. Never commit on a red gate; never `--no-verify`.
- Manual smoke: build with flag OFF â†’ submit a booking â†’ confirm it lands `PENDING_OPS` (legacy) exactly as before.
  **Done when:**
- [ ] Branch `feat/auto-dispatch` exists off `main`.
- [ ] `AUTO_DISPATCH_ENABLED` exists in `configuration.ts` (default OFF) and a mobile `autoDispatch` flag is readable.
- [ ] Flag OFF â‡’ `POST /bookings` is byte-for-byte the legacy flow.
- [ ] `ci.yml` runs `apps/auth-service` tests and they appear in the PR checks.
- [ ] No `@nestjs/schedule` added; the Redis `SET NX` `setInterval` pattern is documented as the convention.

## Step 2 â€” Core dispatch DB migration

**Stage:** Data model Â· **Depends on:** Step 1 Â· **Resolves:** Part I Â§4 (4.1â€“4.3), Part III reliability (region/PostGIS) + scalability, LB10 (region/geo prerequisites), corrections âš ï¸4
**Goal (plain English):** Create the new database structures the matchmaker needs: a table that records who got offered each job and whether they said yes, a few new columns and statuses on the booking so it can show "searching" / "no one available," a region label on each agency, and a proper map-aware location field so "find the nearest agency" is a fast geo-search instead of scanning everyone. Ship every index it needs in this one migration.
**Why it matters / what breaks without it:** The dispatch engine (later step) literally cannot run its ranking query â€” `agents` has no `region_code` and the current haversine-in-SQL approach is a full table scan. Without `dispatch_offers` there's nowhere to record the offer cascade; without the new booking statuses the FSM can't represent "searching" or "no provider."
**Self-contained context (inline â€” do not make the reader open the plan):**

- New table `dispatch_offers` records each offer in the nearest-first cascade. Status enum `dispatch_offer_status` = `OFFERED | ACCEPTED | REJECTED | EXPIRED | SUPERSEDED | CANCELLED`. One PENDING ("OFFERED") offer per provider at a time (race guard) but this must NOT cap concurrent active missions â€” D6 lets an agency run several missions at once, bounded only by free CPO capacity (enforced later in the eligibility query, not by this index).
- LOCKED DECISIONS: D4 = nearest within the SAME region (AE/SA/BD/GB); D6 = multiple concurrent missions per agency.
- CORRECTION (Part III âš ï¸4 / reliability / LB10): `agents` has NO `region_code` column (verified: original `agents` schema in `supabase/migrations/20260423180000_agent_portal.sql` has user_id, type, status, tier, call_sign, display_name, rate_aed_per_hour, rating, jobs_total, duty_hours_mtd, on_duty, timestamps â€” and nothing else). Add `region_code`. ALSO verified landmine: `apps/auth-service/src/agents/agent.service.ts:1438` writes `agents.last_lat`, `last_lng`, `last_location_at` but NO migration creates those columns (they appear in zero migration files). Add them defensively with `ADD COLUMN IF NOT EXISTS`, AND add a PostGIS `geography(Point,4326)` location column with a GiST index so `ST_DWithin`/`<->` nearest-neighbour is index-backed.
- PostGIS is available and already used: verified `CREATE EXTENSION IF NOT EXISTS postgis;` in `20260416000000_init_phase1.sql`, which also uses `geography(Point,4326)` and `CREATE INDEX ... USING GIST (...)` (e.g. `bookings_pickup_gix`). Copy that exact idiom.
- The booking status type is a REAL Postgres ENUM `lite_booking_status` (verified in `20260423113000_booking_module.sql`), and `lite_bookings.status` is typed as that enum. New statuses must be added via `ALTER TYPE lite_booking_status ADD VALUE 'DISPATCHING'` / `'NO_PROVIDER'`. CAUTION: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction in some Postgres versions and the new value may be unusable in the same migration transaction â€” add the enum values in a statement that commits before any DML uses them (split or order accordingly).
- FSM (TypeScript mirror) lives in `apps/auth-service/src/booking/state-machine.service.ts` (verified). Current `BookingStatus` union: `DRAFT|PENDING_OPS|OPS_APPROVED|PAYMENT_PENDING|CONFIRMED|LIVE|COMPLETED|CANCELLED`; actors `CLIENT|OPS_HANDLER|CPO|SYSTEM`; transitions are a `TRANSITIONS[]` table; `CANCELLABLE` is a `readonly BookingStatus[]`. New transitions to ADD (keep all existing intact): `DRAFTâ†’DISPATCHING` (actor CLIENT), `DISPATCHINGâ†’CONFIRMED` (actor SYSTEM â€” means "accepted, awaiting crew"), `DISPATCHINGâ†’NO_PROVIDER` (actor SYSTEM, terminal), and make `DISPATCHING` cancellable by CLIENT/SYSTEM (add to `CANCELLABLE`).
- `lite_bookings` already has `pickup_lat/lng`, `dropoff_lat/lng` as `DECIMAL(10,7)`, `region_code TEXT NOT NULL`, `cpo_count`, `total_eur`/`total_aed`, `comms_channel_id` (the Ops Room link â€” reuse it). New columns to add: `dispatch_mode TEXT` ('auto' = new flow, NULL = legacy), `assigned_provider_user_id UUID` (set on accept), `dispatch_started_at TIMESTAMPTZ`, `dispatch_settled_at TIMESTAMPTZ`, and `crew_deadline_at TIMESTAMPTZ` (the charged-but-never-crewed SLA, Part III LB5 â€” add here so escrow Step 3 / sweeps can use it).
- Hot-path indexes to ship in THIS migration: partial unique index for one-live-offer-per-provider; `dispatch_offers(booking_id, status)`; an index over `dispatch_offers(expires_at) WHERE status='OFFERED'` for the watchdog; a GiST index on the new agents geography column; and a covering index for the duty pool, e.g. `agents(status, on_duty, type) WHERE type='company'`.
  **Files to touch:**
- NEW `supabase/migrations/<ts>_auto_dispatch.sql` â€” the enum, `dispatch_offers`, `lite_bookings` ALTERs, the two new `lite_booking_status` enum values, `agents` ALTERs (region_code + last_lat/lng/last_location_at IF NOT EXISTS + geography column), and all indexes.
- EXTEND `apps/auth-service/src/booking/state-machine.service.ts` â€” add `DISPATCHING` and `NO_PROVIDER` to the `BookingStatus` union, add the three transitions to `TRANSITIONS`, add `DISPATCHING` to `CANCELLABLE`. (Code change paired with the migration so the FSM and DB agree.)
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
-- one live offer per provider (race guard; does NOT cap active missions â€” D6)
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

- Keep `last_lat/last_lng/last_location_at` for back-compat with `agent.service.ts:1438`, but the ranking query in the engine step should prefer `ST_DWithin(last_location, pickup_geog, radius_m)` ordered by `last_location <-> pickup_geog`. Decide whether `PATCH /agents/me/location` also writes `last_location = ST_SetSRID(ST_MakePoint(lng,lat),4326)::geography` â€” flag this so the engine step keeps the geography column populated.
- `region_code` derivation: if you can't cleanly source it, derive from the agent's coverage (`agent_profiles.coverage.countries`) â€” but the column must exist for the ranking `WHERE a.region_code = :region`. NOTE drift to flag: D4 regions are AE/SA/BD/GB, but mobile `SUPPORTED_REGIONS` in `src/utils/constants.ts` currently lists AE/GB/ZA/US â€” reconcile region codes before relying on the match.
- Conditional-UPDATE/idempotency pattern is enforced in the engine/accept steps, not here; this step only provides the columns/indexes those conditional updates rely on (`WHERE status='OFFERED'`, `WHERE status='DISPATCHING'`).
  **Frontend / ops-console how-to:** None (pure data model). Re-run mobile/ops-console typecheck after any generated-type refresh.
  **Security stop-conditions:** None beyond standard. STOP/verify only that the new columns store NO precise principal location to anyone unauthorized â€” `dispatch_offers` intentionally holds only `distance_km` (coarse), never pickup/dropoff coordinates (Part III LB1 crown-jewel rule; the precise-location ACCEPTED-only endpoint is a later step). Do not add address/coordinate columns to `dispatch_offers`.
  **Acceptance & tests:**
- New test: FSM unit test (`state-machine.service.spec.ts` style) asserting the three new transitions are allowed for the stated actors and that, e.g., `DISPATCHINGâ†’LIVE` or a non-SYSTEM `DISPATCHINGâ†’NO_PROVIDER` is rejected; and that `DISPATCHING` is cancellable.
- Migration applies cleanly on a scratch/branch DB (`mcp__supabase__list_tables` shows `dispatch_offers`; `agents` shows the new columns; old tables untouched).
- Run `EXPLAIN ANALYZE` of the prospective nearest-agency query against hundreds of synthetic on-duty company agents with locations, confirming GiST index usage (no seq scan on the hot path).
- Gates: `apps/auth-service` `npm test` (now in CI from Step 1), `npm run typecheck` (mobile â‰¤96), `cd apps/ops-console && npm run typecheck`, `npm run lint`. Never commit on red.
  **Done when:**
- [ ] `dispatch_offers` + `dispatch_offer_status` enum exist with the partial unique index + booking/status + expiry indexes.
- [ ] `lite_bookings` has dispatch_mode, assigned_provider_user_id, dispatch_started_at, dispatch_settled_at, crew_deadline_at.
- [ ] `lite_booking_status` includes DISPATCHING + NO_PROVIDER; the TS FSM mirrors the new statuses + transitions and its spec passes.
- [ ] `agents` has region_code + last_lat/lng/last_location_at + a `geography(Point,4326)` column with a GiST index, plus the duty-pool covering index.
- [ ] `EXPLAIN ANALYZE` shows the nearest query is index-backed at scale; legacy data untouched.

## Step 3 â€” Money + compliance DB migration

**Stage:** Data model Â· **Depends on:** Step 1, Step 2 Â· **Resolves:** Part V Â§38 (escrow_holds + booking_disputes + accounts), Part III LB10/LB20 (licence/insurance/armed registries with expiry) + LB11 (requirements honored)
**Goal (plain English):** Add the "holding pot" money model that keeps the customer's payment safe until the job is really done â€” a table that tracks each job's escrow state and final split, a table for customer disputes, and two special platform accounts (one to hold the money, one for the platform's fee). Also add the compliance records the law requires for a bodyguard service: a licence/insurance registry with expiry dates per agency, per guard, and per region; an "is this guard authorized to be armed" model; and an "armed / requirements" field on the request. No encryption is touched.
**Why it matters / what breaks without it:** Today the customer is debited straight off their wallet with no holding account and the agency is credited at completion â€” so a cancelling or lying agency could be paid, and there's nothing to refund from. Without the licence/insurance/armed registries the matcher cannot legally gate who gets dispatched (Part III says this is a launch-blocker for a regulated, multi-region service). Without the requirements field on the request, "armed/female/medical" the client paid for is silently dropped.
**Self-contained context (inline â€” do not make the reader open the plan):**

- CORE PRINCIPLE (Part V Â§36): "charged" â‰  "paid." On accept, the client's credits go INTO a platform escrow (held-funds) account, NOT the agency wallet. The agency is paid only after a proof-of-completion gate + a client dispute window. This migration provides the tables/accounts; the transactional moves and sweeps are later steps (PV2â€“PV8).
- CORRECTION (Part III âš ï¸2 / payments LB4): settlement today is ADMIN-ONLY â€” verified `apps/auth-service/src/ops/ops.service.ts completeBooking` (line ~1079) computes `escrow = Math.round(Number(row.total_eur))`, even-splits it across CPOs, and credits via the wallet; "escrow" there is just the booking total, NOT a held-funds account. A later step extracts a `SettlementService`; this migration adds the real held-funds layer the plan Â§36 says is missing.
- Money state machine (Part V Â§37): `escrow_hold_status` = `HELD | PENDING_RELEASE | RELEASED | REFUNDED | PARTIAL | DISPUTED`. Transitions: `HELD â†’ {REFUNDED|PARTIAL|PENDING_RELEASE}`; `PENDING_RELEASE â†’ {RELEASED|DISPUTED}`; `DISPUTED â†’ {RELEASED|REFUNDED|PARTIAL}`; RELEASED/REFUNDED terminal.
- Wallet ledger to reuse (verified, `apps/auth-service/src/wallet/`): `wallet_balances(user_id PK, bravo_credits INT, currency TEXT default 'AED', stripe_customer_id, updated_at)`; `wallet_transactions(id, user_id, type wallet_tx_type ['topup','payment','refund','payout'], status, amount_credits INT, amount_fiat_cents, fiat_currency default 'usd', description, booking_id, metadata jsonb, settled_at)`. Helper methods exist: `wallet.service.ts` `creditForBooking` (idempotent via partial unique constraint `ux_wallet_tx_payout`), `refundForBooking` (idempotent via `ux_wallet_tx_booking_refund`, derives amount server-side from the original debit), `debitForBooking`/`debitForFeature`. The escrow moves are PAIRED ledger rows (debit one account, credit the other) so the books always balance.
- Settlement reuse target: `mission_payouts` (verified `20260428000000_dress_and_payouts.sql`) has `mission_id, booking_id, agent_user_id, call_sign, proposed_credits, paid_credits, deduction_credits, deduction_reason, decided_by, decided_at`. NOTE: the payee column on `mission_payouts` is `agent_user_id` (NOT `payee_user_id`); `payee_user_id` was added to a DIFFERENT table in `20260610000000_provider_orgs_and_managed_cpos.sql` (line 75) â€” verify the exact target column before the settlement step writes a payout to the AGENCY org wallet. Partials reuse `deduction_credits`/`deduction_reason`; refunds reuse `refundForBooking`.
- LOCKED DECISIONS feeding compliance: D4 region (AE/SA/BD/GB) â†’ registries are per-region; D5 = up to ~10 managed CPOs per agency (roster lives in `org_members`, verified `org_members(org_user_id, member_user_id, member_role ['cpo','manager'], call_sign, status default 'active')`); requirements (armed/female/medical) already partly modeled â€” `cpo_pool` has `armed`/`female`/`specialties`, and `lite_booking_add_ons` seeds `female_cpo`/`recon`/`medical`/`comms` (verified) â€” but there is no per-request `armed` flag and no licence/insurance EXPIRY registry.
- `agents.rating` (DECIMAL(3,2)) and `agents.jobs_total` (INT) EXIST (verified in agent_portal migration) â€” do NOT re-add; reliability/acceptance counters are new.
- Multi-replica / background-sweep constraint (Part V Â§42, Part III LB9): the release sweep, crew-SLA sweep and reconciliation sweep all use the Redis `SET NX`-locked `setInterval` pattern from `apps/auth-service/src/booking/payment-pending-expiry.service.ts` â€” never `@nestjs/schedule`. This migration just provides the index they query: `escrow_release_due ON escrow_holds(release_eligible_at) WHERE status='PENDING_RELEASE'`.
  **Files to touch:**
- NEW `supabase/migrations/<ts>_escrow_integrity.sql` â€” `escrow_hold_status` enum, `escrow_holds`, `booking_disputes`, the seeded platform escrow + platform-fee accounts, the licence/insurance registry, the armed-authorization model, and the `armed`/requirements field on `lite_bookings`; plus reliability/acceptance counters on agents.
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
-- one open dispute per booking (Part V Â§41)
CREATE UNIQUE INDEX IF NOT EXISTS booking_disputes_one_open
  ON booking_disputes(booking_id) WHERE status = 'open';

-- platform escrow + fee accounts: seed dedicated wallet_balances rows under
-- fixed system user ids (mirror the SYSTEM actor 0000â€¦0001 convention).
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

-- armed / requirements on the request itself (LB11 â€” honor what the client paid for)
ALTER TABLE lite_bookings
  ADD COLUMN IF NOT EXISTS armed_required  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS requirements    JSONB NOT NULL DEFAULT '{}'::jsonb; -- {female, medical, ...}

-- agency reliability / acceptance counters (rating/jobs_total already exist on agents)
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS offers_received     INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS offers_accepted     INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reliability_breaches INT NOT NULL DEFAULT 0;

-- (optional, per Part V Â§38) per-booking dispute window override
ALTER TABLE lite_bookings
  ADD COLUMN IF NOT EXISTS dispute_window_seconds INT;
```

- The escrow/fee account user ids must be defined as named constants in config (e.g. `ESCROW_ACCOUNT_ID`, `PLATFORM_FEE_ACCOUNT_ID` in `configuration.ts`) so later money steps reference them, not magic strings. Confirm they don't collide with the messenger SYSTEM actor id `00000000-0000-0000-0000-000000000001`.
- Conditional-UPDATE/idempotency pattern (used by later money steps, enabled by this schema): every escrow transition will be `UPDATE escrow_holds SET status=$next WHERE id=$1 AND status=$expected RETURNING id` inside `db.withTransaction`, paired with the wallet ledger move â€” 0 rows â‡’ 409/no-op (mirrors `payWithCredits` and `refundForBooking`). The `escrow_holds.booking_id UNIQUE` + the `booking_disputes_one_open` partial unique index are the at-most-once anchors.
- Currency note (Part III payments): wallet defaults are AED/usd and only usd/aed/eur are really supported (verified `creditsPerUsd` fixed-FX in config). The migration's `currency` column allows AED/SAR/BDT/GBP, but actually charging in BDT/GBP needs an `fx_rate` stamped per txn â€” flag that the FX work is a separate step; the column just must not block it.
  **Frontend / ops-console how-to:** None in this step (pure data model). The ops-console dispute-resolve screen and client receipt/dispute screens come in later steps; ensure their eventual types match the new tables (re-run `cd apps/ops-console && npm run typecheck` after type-gen).
  **Security stop-conditions:** No crypto/E2E/auth primitives touched (Part V is explicit: wallet/ledger only). STOP/verify: do NOT log credential references, permit numbers, or any PII from `compliance_credentials`/`armed_authorizations` (the static log-audit test enforces no-PII logging). The escrow/fee accounts are ordinary `wallet_balances` rows â€” do not bypass the existing wallet idempotency constraints when later steps move money.
  **Acceptance & tests:**
- New tests (later money steps consume them, but assert schema/invariants now): a migration-applies-clean check; a test asserting the seeded escrow + fee `wallet_balances` rows exist at 0; a test asserting `escrow_holds.booking_id` is UNIQUE (double-insert for one booking fails) and only one `open` dispute per booking is allowed.
- Money invariant placeholder (Part V Â§43): the reconciliation step will assert `sum(client debits) == held` and `held == to_provider + to_client + platform_fee` at terminal â€” this migration's columns must support that arithmetic. Add a TODO test stub referencing it.
- `EXPLAIN`/`list_tables` confirm `escrow_holds`, `booking_disputes`, `compliance_credentials`, `armed_authorizations` exist; `agents` shows the new counters; old tables untouched.
- Gates: `apps/auth-service` `npm test` (CI from Step 1), the `booking` Jest project for booking-adjacent changes, `npm run typecheck` (mobile â‰¤96), `cd apps/ops-console && npm run typecheck`, `npm run lint`. Never commit on red; never `--no-verify`.
  **Done when:**
- [ ] `escrow_holds` (+ `escrow_hold_status` enum) and `booking_disputes` exist, with the `release_eligible_at WHERE PENDING_RELEASE` index and the one-open-dispute partial unique index.
- [ ] Seeded platform escrow + platform-fee `wallet_balances` accounts exist; their ids are named config constants and don't collide with the SYSTEM actor.
- [ ] `compliance_credentials` (licence/insurance with `expires_at`, per agency/CPO/region) and `armed_authorizations` (per CPO/region, with expiry) exist and are indexed for the eligibility gate.
- [ ] `lite_bookings` has `armed_required` + `requirements` (and optional `dispute_window_seconds`); `agents` has reliability/acceptance counters; `agents.rating`/`jobs_total` were reused, not duplicated.
- [ ] Migration applies clean on a scratch/branch DB with no impact on legacy data; no crypto/auth code touched.

---

## Step 4 â€” Role discriminator (`account_kind`) + CPO session guard

**Stage:** Identity Â· **Depends on:** Step 3 (managed-CPO accounts already exist via `org_members` + `agents.managed_by_org_id`) Â· **Resolves:** Â§35A Â§A/Â§B/Â§F, PR1 (and enables PR2/PR6)
**Goal (plain English):** When anyone logs in, the server itself decides "this account is a customer, a security firm, or a guard" and tells the app exactly that, plus which firm a guard belongs to and whether they still have a temporary password. The app then opens the matching front door â€” a guard never lands in the customer or firm app by accident â€” and if the firm later suspends or removes a guard, the next time the app checks in the guard is kicked out to an "access ended" screen.
**Why it matters / what breaks without it:** Today routing is derived from a loosely-trusted `users.role` and AsyncStorage flags (the `pendingProvider` stuck-register bug). Without one server-computed `account_kind`, a managed CPO would re-derive its own role client-side and could land in the wrong app, and a removed guard could keep a live guard interface (and stay in Ops Rooms) indefinitely.

**Self-contained context (inline â€” do not make the reader open the plan):**

- **Locked decision (Â§35A):** Bravo is one binary, three app experiences. The experience is chosen at login **from the server's authenticated identity, never from a client-chosen flag**. Never trust a value the client could set.
- **The discriminator precedence (compute server-side, return as a single field):**
  1. **`cpo`** â€” caller has an `agents` row with `type='cpo'` **and** `managed_by_org_id` set, **OR** an `org_members` row where `member_role='cpo'` **and** `status='active'`.
  2. **`agency`** â€” caller is a company agent (`agents.type='company'`) **OR** an `org_members` row with `member_role='manager'` (status `active`).
  3. **`individual`** â€” everything else (`users.role='individual'`, no agent/org membership).
- **Confirmed schema (real code):** `org_members` (PK `org_user_id`,`member_user_id`) has `member_role TEXT CHECK IN ('cpo','manager')` and `status TEXT CHECK IN ('invited','active','suspended','removed')` (`supabase/migrations/20260610000000_provider_orgs_and_managed_cpos.sql:22-35`). `agents.managed_by_org_id UUID` is nullable (NULL = legacy self-registered CPO) (same file :47-48). `agents.type` is the enum `('company','cpo','transport')` and `agents.status` is `agent_status` (`supabase/migrations/20260423180000_agent_portal.sql:19-23,47-48`).
- **`must_set_password` does NOT exist yet.** Managed CPOs are created with a real `password_hash` from the agency-supplied `temp_password` (`apps/auth-service/src/org/org-cpo.service.ts:84-95`) but there is **no flag** marking "still on the temp password." This step must add one (a nullable `password_set_at TIMESTAMPTZ` on `users`, or a `must_set_password BOOLEAN`), set it for managed CPOs at creation, and clear it when the CPO completes `POST /auth/me/password` (`apps/auth-service/src/auth/auth.controller.ts:~325`, `auth.service.changePassword`).
- **Where to surface it:** `GET /agents/me` returns `{agent, profile, kyc, documents, review, deployment}` today (`apps/auth-service/src/agents/agent.service.ts:202-225`); `GET /auth/me` returns only `{user}` (`apps/auth-service/src/auth/auth.service.ts:395-402`). The plan accepts either; prefer **`/auth/me`** because every account (including pure clients with no `agents` row) calls it, whereas a client has no `agents` row so `/agents/me` 404s for them via `requireAgent`.
- **Existing trust pattern to reuse â€” do NOT bake role into the JWT:** `OrgManagerGuard` (`apps/auth-service/src/org/org-manager.guard.ts`) re-reads the DB on every request (Path 1 = own `company` agent; Path 2 = active `manager` `org_members` row) rather than trusting a claim. The JWT shape is intentionally left unchanged (auth-token security stop-condition). The new session guard for CPOs follows the same "re-read on every request" model.
- **Mid-session revocation rule (Â§B):** on every app-focus/token-refresh the app re-checks `membership_status`. If a CPO's `org_members.status != 'active'`, force-logout to "Your agency access has ended," set them offline, and drop from Ops Rooms.

**Files to touch:**

- **NEW migration** `supabase/migrations/<ts>_user_must_set_password.sql` â€” `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_set_at TIMESTAMPTZ;` (idempotent, additive; the `must_set_password` boolean is then derived as `password_set_at IS NULL` for managed CPOs). STOP: also fix the latent gap that `agents.last_lat/last_lng/last_location_at` have no committed migration (see Step 5) â€” keep these in separate migration files.
- **EXTEND** `apps/auth-service/src/org/org-cpo.service.ts` (`createManagedCpo`, the `INSERT INTO public.users ... RETURNING id` at :88-95) â€” do **not** set `password_set_at` for managed CPOs (leave NULL â‡’ `must_set_password=true`).
- **EXTEND** `apps/auth-service/src/auth/auth.service.ts` (`changePassword`, ~:417) â€” on a successful change, `SET password_set_at = NOW()` so first password set clears the flag.
- **EXTEND** `apps/auth-service/src/auth/auth.service.ts` (`getMe`, :395-402) â€” add a private `resolveAccountKind(userId)` helper and return `{user, account_kind, org: {id,name} | null, must_set_password, membership_status}`.
- **NEW** `apps/auth-service/src/common/guards/cpo-session.guard.ts` â€” a `CanActivate` that, for a caller resolving to `account_kind='cpo'`, throws `ForbiddenException('agency_access_ended')` when their `org_members.status != 'active'`. Apply it on CPO-scoped mission/comms routes (NOT on `/auth/me` itself â€” `/auth/me` must still answer so the app can read `membership_status` and route to the "access ended" screen).
- **EXTEND** `src/services/api.ts` (`authApi.me` / `agentApi.getMe` consumer, and the `AgentPortalState`/auth-me response types at :405-460) â€” add `account_kind`, `org`, `must_set_password`, `membership_status` to the typed response.
- **EXTEND** `src/store/authStore.ts` (:91-96, user shape) â€” store `account_kind` + `membership_status` on the user so the navigator can switch on it (Step relating to PR2 reads this).
- **NEW spec** `apps/auth-service/src/auth/auth.service.account-kind.spec.ts` (mirror `apps/auth-service/src/org/org-cpo.service.spec.ts` style).

**Backend how-to:**

1. **Migration (additive, idempotent):**
   ```sql
   ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_set_at TIMESTAMPTZ;
   -- Backfill: every existing login already chose its own password.
   UPDATE public.users SET password_set_at = COALESCE(password_set_at, created_at)
     WHERE password_hash IS NOT NULL AND password_set_at IS NULL;
   ```
   Managed CPOs created after this migration land with `password_set_at = NULL` (createManagedCpo doesn't set it) â‡’ `must_set_password = (password_set_at IS NULL)`.
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
   - **Guard against a stale `om` row matching twice:** if a user is both `manager` of one org and `cpo` of another, the JOIN can fan out â€” fetch `org_members` with an inner ordered subquery (active first, then by `member_role='cpo'` precedence) or `ORDER BY (status='active') DESC, (member_role='cpo') DESC LIMIT 1`. Cite a `// Why:` for the LIMIT.
3. **CPO session guard (re-read, no skip-in-dev):** model on `OrgManagerGuard`. Apply `JwtAuthGuard` then `CpoSessionGuard`; the guard runs `resolveAccountKind`, and **only** when `account_kind==='cpo'` enforces `membership_status==='active'`, else 403 `agency_access_ended`. Non-CPO callers pass through untouched. Never add a "skip in dev" branch.
4. **Idempotency/race:** `changePassword` already revokes all sessions; add `password_set_at = NOW()` to the same `UPDATE public.users SET password_hash=$1, updated_at=now() ...` statement (`auth.service.ts:432-435`) so the flag clears atomically with the hash â€” no separate write to race.

**Frontend / ops-console how-to:**

- After auth bootstrap, read `user.account_kind` from the store and mount exactly one stack (PR2 â€” separate step): `individual`â†’ClientNavigator, `agency`â†’AgencyNavigator, `cpo`â†’CpoNavigator. A CPO never sees `RoleSelectionScreen` (`src/screens/auth/RoleSelectionScreen.tsx`). Today `RootNavigator` (`src/navigation/index.tsx:18-65`) only switches on `isAuthenticated`/`permsShown` â€” extend it to also branch on `account_kind` (that wiring is PR2; this step just guarantees the field is present and typed).
- `must_set_password===true` â‡’ force the CPO activation flow (set password) before the CPO home.
- On every app-focus/token-refresh, re-fetch `/auth/me`; if `account_kind==='cpo' && membership_status!=='active'`, route to an "Your agency access has ended" screen and sign out (this is PR6; wired here only as the data contract).
- ops-console: none for this step.

**Security stop-conditions:**

- **STOP / verify against the System Architecture Documentation:** the JWT shape and session/token storage are auth-token stop-conditions. **Do not** add `account_kind` or `org_id` as a JWT claim â€” derive it per-request from the DB exactly like `OrgManagerGuard`. No "skip in dev" branch on `CpoSessionGuard`.
- Never log `password_hash`, the temp password, or any key material. Mid-session revocation drops the CPO from Ops Rooms â€” Ops Room membership is metadata-only via `ensureBookingOpsRoom`; do not touch group plaintext or group keys here.

**Acceptance & tests:**

- **Backend unit (auth-service jest, run from `apps/auth-service`):** `resolveAccountKind` returns `cpo` for a `type='cpo'+managed_by_org_id` user and for an active `member_role='cpo'`; returns `agency` for a `company` agent and an active `manager`; returns `individual` otherwise; `must_set_password` flips from `true`â†’`false` after `changePassword`; `CpoSessionGuard` throws `agency_access_ended` when a CPO's `org_members.status='suspended'`/`'removed'` and passes when `'active'` and for non-CPO callers. (Mirror `org-cpo.service.spec.ts`.)
- **Mobile typecheck:** `npm run typecheck` (must stay â‰¤ baseline **96**).
- **ops-console typecheck:** `cd apps/ops-console && npm run typecheck`.
- **Lint:** `npm run lint`.
- **Regression:** run the auth-service suite (`cd apps/auth-service && npm test`) and the mobile `app` Jest project (`npm test -- --selectProjects=app`). **Correction #6: CI does not run auth-service tests today â€” this step's backend spec is only protected once CI is fixed; note that dependency.**
- Never commit on a red gate; never `--no-verify`.

**Done when:**

- [ ] `/auth/me` returns `account_kind âˆˆ {individual, agency, cpo}` plus `org{id,name}|null`, `must_set_password`, `membership_status`, all server-computed.
- [ ] A managed CPO created via `createManagedCpo` reports `must_set_password=true` until they set a password, then `false`.
- [ ] `CpoSessionGuard` 403s a suspended/removed CPO on CPO-scoped routes and is a no-op for agency/individual.
- [ ] No new JWT claim; the discriminator is re-read from the DB every request.
- [ ] Typecheck (mobile â‰¤96 + ops-console), lint, auth-service spec all green.

---

## Step 5 â€” Provider go-online + background-capable on-duty location heartbeat

**Stage:** Availability Â· **Depends on:** Step 4 (an `agency` account exists and is routed to the agency app) Â· **Resolves:** Part I Phase 2, LB16
**Goal (plain English):** Like an Uber driver tapping "Go Online," an agency taps a switch to say "we're available," and while it's on, the app quietly reports the agency's location on a timer â€” even when the app is backgrounded â€” so the dispatch engine knows who's nearby. If an agency hasn't reported a location in 5 minutes we treat it as not really online. The dashboard shows an honest "are we locatable" health dot.
**Why it matters / what breaks without it:** The matchmaker (Phase 3/4) can only rank agencies it can locate. The existing location watcher only runs **during a live mission and only in the foreground**, so a freshly-online agency with no active mission reports nothing â€” the ranking pool is empty/stale and no jobs ever get offered (LB16, listed P0). A real background-capable on-duty heartbeat is the missing piece.

**Self-contained context (inline â€” do not make the reader open the plan):**

- **Locked decision (Phase 2):** v1 ranks an _agency_ by its own reported location (the manager/dispatcher device), not by its nearest CPO. Keep v1 simple.
- **Backend already exists â€” confirm, don't rebuild:**
  - `PATCH /agents/me/duty` â†’ `AgentService.setDuty(userId, on_duty)` sets `agents.on_duty` and keeps the dispatch mirror in sync: `UPDATE cpo_pool SET availability='available' WHERE id=$1 AND availability='off_duty'` when going on, `â†’'off_duty'` when going off (never touches an `'on_mission'` row). (`apps/auth-service/src/agents/agent.controller.ts:157-160`, `agent.service.ts:1393-1427`; DTO `SetDutyDto { on_duty:boolean }` at `dto/agent.dto.ts:112-114`).
  - `PATCH /agents/me/location` â†’ `AgentService.updateLocation(userId, lat, lng)` validates finite + in-range coords and writes `UPDATE agents SET last_lat=$2, last_lng=$3, last_location_at=NOW() WHERE user_id=$1`. **Accepts any valid coords** (no plausibility/mock-location gating yet â€” that's a later hardening item P0/Â§Part III). (`agent.controller.ts:162-168`, `agent.service.ts:1429-1441`; DTO `UpdateLocationDto { lat:[-90,90], lng:[-180,180] }` at `dto/agent.dto.ts:152-157`.)
  - Mobile clients: `agentApi.setDuty(on_duty)` and `agentApi.updateLocation(lat,lng)` already exist (`src/services/api.ts:530-531`).
- **Staleness rule (define the constant, enforced by the ranking query, not here):** an agency is _locatable_ only if `on_duty=true AND last_location_at > NOW() - INTERVAL '5 minutes'`. Define `LOCATION_FRESH_MINUTES = 5` as the shared cutoff (the dispatch ranking in Phase 3/4 uses the same value). The health dot in the app uses this same threshold against `last_location_at`.
- **What exists vs what's missing (the real gap):** `AgentDashboardScreen` already has a working **Go Online** toggle and an optimistic-with-rollback `commitDuty` (`src/screens/agent/AgentDashboardScreen.tsx:242-283`). It also has a location-reporting `useEffect`, but it is **gated on `missionActive`** (`DISPATCHED|PICKUP|LIVE|SOS`) AND uses `react-native-geolocation-service` `watchPosition` inside a screen-lifecycle effect â€” i.e. **foreground-only and mission-only** (`AgentDashboardScreen.tsx:203-240`). The copy-source `LiveTrackingScreen.tsx:268-295` is the same foreground `whenInUse` pattern (its own comment: "we only push GPS while the screen is foregrounded"). **There is no background-capable on-duty heartbeat today.**
- **Confirmed platform note:** the project's only geolocation lib is `react-native-geolocation-service@^5.3.1` (foreground/`whenInUse`); `@notifee/react-native` is present (usable for an Android foreground-service notification). No background-location/task-manager lib is installed â€” adding background capability requires either a foreground-service approach (notifee + a headless interval) or adding a background-geolocation dependency. Call this out explicitly; do not silently assume background "just works."
- **Schema gap to fix (verified):** `agents.last_lat/last_lng/last_location_at` are written by `updateLocation` and read by the ranking query but **have no committed migration** in `supabase/migrations` (the original `agent_portal.sql` agents DDL at :45-62 has no such columns; they were added ad-hoc on the live DB). This step must add the missing migration so the ranking query is reproducible on a fresh DB.

**Files to touch:**

- **NEW migration** `supabase/migrations/<ts>_agents_location_columns.sql` â€” additive/idempotent: `ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS last_lat DOUBLE PRECISION, ADD COLUMN IF NOT EXISTS last_lng DOUBLE PRECISION, ADD COLUMN IF NOT EXISTS last_location_at TIMESTAMPTZ;` plus the dispatch-pool partial index from the plan: `CREATE INDEX IF NOT EXISTS agents_dispatch_pool ON agents (status, on_duty, type) WHERE type='company';`. STOP-adjacent: correction #4 (PostGIS `geography(Point,4326)`+GiST+`ST_DWithin`, region*code) is a \_later* dispatch-ranking step â€” do not implement geo indexing here; this migration just makes the lat/lng/timestamp columns real.
- **NEW** `src/modules/location/onDutyHeartbeat.ts` (or `src/services/onDutyHeartbeat.ts`) â€” a background-capable heartbeat controller: `start()` (acquire foreground-service / background-geo, push `agentApi.updateLocation` every ~30â€“60s), `stop()`, idempotent start/stop, and `LOCATION_FRESH_MINUTES = 5` exported.
- **EXTEND** `src/screens/agent/AgentDashboardScreen.tsx` â€” drive the heartbeat from **duty state, not mission state**: start the heartbeat when `onDuty && locStatus==='granted'`, stop when off-duty or permission lost. Keep the existing mission-gated high-frequency live-map watcher separate (it's for the live map, not for "are we online"). Add the **"locatable" health dot** computed from `last_location_at` vs `LOCATION_FRESH_MINUTES` (green = fresh, amber/red = stale/offline) next to the Go Online toggle.
- **EXTEND** Android config â€” `android/app/src/main/AndroidManifest.xml` (foreground-service + `ACCESS_BACKGROUND_LOCATION` permission) and the notifee channel; iOS `Info.plist` (`NSLocationAlwaysAndWhenInUseUsageDescription`) if background on iOS is in scope. Verify exact paths before editing.
- **NEW spec** `src/screens/agent/__tests__/onDutyHeartbeat.test.ts` (Jest `app` project â€” the agent specs live under `src/screens/agent/__tests__/`).

**Backend how-to:**

- No new endpoints â€” reuse `PATCH /agents/me/duty` and `PATCH /agents/me/location`. **Confirm `updateLocation` in `agent.service.ts:1429-1441`** validates coords (`invalid_coords`, `coords_out_of_range`) and writes `last_location_at=NOW()` â€” it does. The DTO already clamps `latâˆˆ[-90,90]`, `lngâˆˆ[-180,180]`.
- **Migration only** (above). After it, the Phase 3/4 ranking query (`WHERE a.type='company' AND a.status='ACTIVE' AND a.on_duty=true AND a.last_location_at > NOW() - (:fresh_minutes||' minutes')::interval ...`) runs on a fresh DB.
- **Note for the later hardening step (do not do here):** mock-location/plausibility gating on the heartbeat and PostGIS geo indexing are separate items.

**Frontend / ops-console how-to:**

- **Go Online toggle** already wired via `commitDuty`â†’`agentApi.setDuty` with optimistic rollback and an on-mission confirm dialog (`AgentDashboardScreen.tsx:242-283`); only `ACTIVE` company agents should be allowed to flip it (gate on `me.agent.status==='ACTIVE'`).
- **Heartbeat:** copy the permission-request shape from `LiveTrackingScreen.tsx:241-263` (`PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION` on Android; `Geolocation.requestAuthorization` on iOS) but, for background, additionally request `ACCESS_BACKGROUND_LOCATION` and run inside a notifee foreground service (Android) so the OS doesn't suspend the watcher. Push `agentApi.updateLocation(lat,lng)` on a 30â€“60s timer (throttle, swallow transient network errors like the existing watchers do). `start()` on `onDuty` true, `stop()` on false/permission-lost â€” explicitly NOT gated on an active mission.
- **Health dot:** compute `locatable = onDuty && me.agent.last_location_at && (Date.now() - new Date(last_location_at).getTime()) < LOCATION_FRESH_MINUTES*60_000`. Render green (locatable) / amber (online but stale) / grey (offline) next to the toggle, with a tooltip explaining "you must keep location on to receive jobs." This is the "honest are-we-locatable" surface from LB16.
- ops-console: none required for this step (optional: show the same staleness in the agency monitor later).

**Security stop-conditions:**

- None beyond standard guards for the heartbeat itself (location is the agency's own coords, written only to its own row via `user.sub`-scoped endpoints). **Do not** weaken or remove `updateLocation`'s coord validation. **Note (not this step):** location-spoofing/mock-location gating is a known P0 hardening follow-up â€” flag it, don't skip the eventual gate. Never log raw GPS streams beyond what's necessary; never log key material (the heartbeat carries none).

**Acceptance & tests:**

- **Mobile unit (`app` Jest project, `src/screens/agent/__tests__/`):** `onDutyHeartbeat.start()` calls `agentApi.updateLocation` on its interval and `stop()` clears it (fake timers + mocked `agentApi`); start/stop is idempotent (double-start doesn't double-fire); heartbeat is driven by duty, not mission (assert it fires with no active mission). Run: `npm test -- --selectProjects=app`.
- **Health-dot logic:** unit-test the `locatable` staleness computation against `LOCATION_FRESH_MINUTES` (fresh â†’ true, >5min â†’ false, off-duty â†’ false).
- **Mobile typecheck:** `npm run typecheck` (â‰¤ baseline **96**). **Lint:** `npm run lint`.
- **Manual smoke (native â€” say so if no device):** toggle Online on a real device with **no active mission** â†’ DB shows `agents.on_duty=true` and `last_lat/last_lng/last_location_at` updating on the timer; background the app â†’ updates continue (foreground service / background-geo working); toggle Offline â†’ updates stop and the health dot goes grey. Also exercise an **error path** (deny location permission â†’ toggle stays/flips back, health dot shows "not locatable," no crash).
- **Regression:** the existing mission-gated live-map watcher (`AgentDashboardScreen` + `LiveTrackingScreen`) still works during a live mission (don't break it by reusing its effect). Re-run the `app` project.
- This is not near messaging/crypto, so `npm run test:crypto` is not required. Never commit on a red gate; never `--no-verify`.

**Done when:**

- [ ] A committed migration adds `agents.last_lat/last_lng/last_location_at` + the `agents_dispatch_pool` partial index (fresh-DB reproducible).
- [ ] Toggling Online starts a background-capable heartbeat that `PATCH /agents/me/location` on a 30â€“60s timer **with no active mission required**; toggling Offline stops it.
- [ ] The dashboard shows an honest "locatable" health dot driven by `last_location_at` vs `LOCATION_FRESH_MINUTES=5`.
- [ ] `updateLocation` coord validation is unchanged; no spoofing-gate bypass introduced.
- [ ] `app` Jest project + typecheck (â‰¤96) + lint green; manual on-device smoke (golden + denied-permission path) passes, or the device limitation is stated explicitly.

---

## Step 6 â€” DispatchService: proximity ranking + offer cascade

**Stage:** Dispatch engine Â· **Depends on:** Step 1 (feature flag `AUTO_DISPATCH_ENABLED`), Step 2 (migration: `dispatch_offers` table + enum + `lite_bookings.dispatch_mode/assigned_provider_user_id/dispatch_started_at/dispatch_settled_at` + `agents.region_code` + PostGIS geo column/GiST index), Step 5 (provider "Go Online" + location heartbeat writing `agents.last_lat/last_lng/last_location_at`) Â· **Resolves:** Part I Â§8 (Phase 3, the matchmaker), Part III "Reliability & correctness" + "Scalability & performance" + "Trust & safety", LB8 (every transition a conditional UPDATE), LB10 (vetting/eligibility gate), LB11 (honor what the client paid for)
**Goal (plain English):** Build the server-side "brain" that, the instant a client submits an auto request, looks at every security agency that is online and nearby in the same country, picks the closest one that is genuinely able to take the job, and offers it to them for 30 seconds. If they decline or don't answer, it offers the next-closest â€” up to a cap â€” and if nobody takes it, it tells the customer no one is available. It never picks the crew; it only commits the agency.
**Why it matters / what breaks without it:** This is the core of "Uber for bodyguards." Without it the request is invisible until a human approves it (the flow we are replacing), and a naive version would leak the client's location, double-offer the same agency, dispatch unlicensed guards, or let two pods race the same offer.
**Self-contained context (inline â€” do not make the reader open the plan):**

- **Locked decisions:** D1 fully automatic (no admin in the path). D3 the _agency_ (`agents.type='company'`) accepts, then later deploys its own CPOs. D4 nearest **within the same region** (AE/SA/BD/GB). D6 one agency runs several concurrent missions, bounded by free CPO capacity. D7 accept does NOT auto-pick crew â€” that is a later step that materializes the mission.
- **Booking FSM** (`apps/auth-service/src/booking/state-machine.service.ts`, `BookingStateMachine.assert(from,to,actor)`): today it is `DRAFTâ†’PENDING_OPSâ†’OPS_APPROVEDâ†’PAYMENT_PENDINGâ†’CONFIRMEDâ†’LIVEâ†’COMPLETED`, actors `CLIENT|OPS_HANDLER|CPO|SYSTEM`. This feature adds (in Step 2's FSM edit) `DRAFTâ†’DISPATCHING` (CLIENT), `DISPATCHINGâ†’CONFIRMED` (SYSTEM, = "accepted, awaiting crew"), `DISPATCHINGâ†’NO_PROVIDER` (SYSTEM, terminal), `DISPATCHINGâ†’CANCELLED` (CLIENT/SYSTEM). Do not delete existing transitions â€” the legacy admin flow still uses them.
- **`dispatch_offers`** (from Step 2): columns `id, booking_id, provider_user_id, rank, distance_km, status dispatch_offer_status('OFFERED','ACCEPTED','REJECTED','EXPIRED','SUPERSEDED','CANCELLED'), offered_at, expires_at, responded_at, reject_reason`. Constants: `OFFER_TTL_SECONDS=30`, `MAX_OFFERS=8`, `LOCATION_FRESH_MINUTES=5`.
- **CORRECTION (Part III #4):** `agents` has **no `region_code`** today and DECIMAL-haversine `ORDER BY` is a full table scan. Step 2 must add `agents.region_code TEXT` plus a PostGIS `geography(Point,4326)` location column (e.g. `last_geog`) + GiST index. PostGIS is already enabled (`CREATE EXTENSION postgis` in `20260416000000_init_phase1.sql`; `geography(Point,4326)` already used by `zones`, `lite_bookings.pickup_point`). Rank with `ST_DWithin(a.last_geog, :pickup_geog, :radius_m)` filtered + `ORDER BY a.last_geog <-> :pickup_geog` (or `ST_Distance`) â€” NOT a per-row `acos()` haversine.
- **CORRECTION (Part III #3):** the offer must be **coarse pre-accept** â€” the ranking + offer creation here must NOT push pickup/dropoff coords anywhere a rejecting agency can read them. Exact coords are exposed only by the ACCEPTED-only endpoint built in Step 7. Persist `distance_km` for audit/display only.
- **Eligibility = ACTIVE company agent + on_duty + fresh location + region-matched + licence/insurance valid & non-expired & region-matched (LB10) + armed-authorized IF the job requires armed (LB10/LB11) + `has_free_cpo_capacity` (D6/LB11).** `agents` today has `type, status, tier, rating, jobs_total, on_duty` and (added by the agent-portal location work that `agent.service.ts:1438` writes) `last_lat/last_lng/last_location_at`. Licence/insurance/armed registries with expiry do **not** exist yet â€” Step 2/LB10 must add them; if they are not yet built, gate behind the flag and treat the eligibility predicate as a named SQL function so it can be tightened without touching this service.
- **Capacity formula (D6, Part II Â§24):** `free_cpos(agency) = (active org_members CPOs) âˆ’ (distinct CPOs in a non-completed mission_crew) âˆ’ (Î£ cpo_count of this agency's CONFIRMED bookings that have no mission yet)`. Offer eligible â‡” `free_cpos >= booking.cpo_count`. Roster lives in `org_members` (`member_user_id, member_role IN ('cpo','manager'), status='active'`, org = the company agent's `users.id`); crew in `mission_crew` (`is_lead BOOLEAN`); `missions` is the mission table. The agency's accepted-uncrewed bookings are `lite_bookings.assigned_provider_user_id = agency AND status='CONFIRMED'` with no `missions` row.
- **Requirements the client paid for (LB11):** `lite_bookings` carries `cpo_count` (booking-level integer) and `add_ons JSONB` (e.g. `'female_cpo'`, `'medical'`); there is no booking-level `armed` boolean today (Step 2/LB10 must add an `armed`/requirements field). Carry `cpo_count`, armed, female, medical into BOTH the ranking predicate here and (later step) the crew-assign validation â€” they must not be silently dropped.
- **Reuse points:** `DatabaseService` (`db.q<T>(sql,params)`, `db.qOne<T>(sql,params)`, `db.withTransaction(async tx => â€¦)` where `tx.q/tx.qOne` exist; `SELECT â€¦ FOR UPDATE` inside the txn). `OpsAuditService.record({actor_id:null, actor_role:'SYSTEM', action, subject_type, subject_id, metadata})` (note: `record` fails-closed/re-throws for actions in its CRITICAL set; pick non-critical action names like `'dispatch.offer'`, `'dispatch.no_provider'` unless you intend a rollback-on-audit-failure). `BookingPushBridge.publish(...)` for offer/no-provider wakes (wired in Step 7). `SystemMessengerService.ensureBookingOpsRoom` is NOT called here (only at accept, Step in Phase 6). The wallet is NOT touched here (charge happens at accept).
- **Race-safety pattern (the contract for every state-changing method) â€” mirror `job-feed.service.ts cancel()`:**
  ```ts
  await this.db.withTransaction(async tx => {
    const cur = await tx.qOne<{status: string}>(
      `SELECT status FROM dispatch_offers WHERE id=$1 FOR UPDATE`,
      [offerId],
    );
    if (!cur || cur.status !== 'OFFERED')
      throw new BadRequestException('offer_state_changed_concurrently'); // â†’ 409
    const upd = await tx.q(
      `UPDATE dispatch_offers SET status='EXPIRED', responded_at=NOW() WHERE id=$1 AND status='OFFERED' RETURNING id`,
      [offerId],
    );
    if (upd.length === 0) throw new BadRequestException('offer_state_changed_concurrently');
    // â€¦then cascade inside or after the txn
  });
  ```
  **Files to touch:**
- NEW `apps/auth-service/src/dispatch/dispatch.service.ts` â€” the `DispatchService` class with `start/offerNext/expire/reject/noProvider/cancel` (accept lives in the Phase 6 step but stub its signature here).
- NEW `apps/auth-service/src/dispatch/dispatch.module.ts` â€” `@Module` importing `DatabaseModule`, `RedisModule`, the booking FSM provider, `OpsAuditService`/its module, `BookingPushBridge`/its module; providing/exporting `DispatchService`.
- EXTEND `apps/auth-service/src/app.module.ts` â€” register `DispatchModule`.
- NEW `apps/auth-service/src/dispatch/dispatch.service.spec.ts` â€” unit tests (next-step file but author the spec here per change-safety rule "write the failing test first").
- VERIFY (do not edit here): `apps/auth-service/src/booking/state-machine.service.ts` (the new statuses land in Step 2), `apps/auth-service/src/ops/job-feed.service.ts` (race pattern reference, lines ~400â€“420), `apps/auth-service/src/ops/ops-audit.service.ts` (`record` signature, lines 68â€“102).
  **Backend how-to:**
- **Constants** at top of `dispatch.service.ts`: `OFFER_TTL_SECONDS=30`, `MAX_OFFERS=8`, `LOCATION_FRESH_MINUTES=5`.
- **`start(bookingId)`:** in a txn, `SELECT status, region_code, cpo_count, pickup_lat, pickup_lng FROM lite_bookings WHERE id=$1 FOR UPDATE`; assert booking is at the pre-dispatch state and `dispatch_mode='auto'`; `fsm.assert(cur.status,'DISPATCHING','CLIENT')` (or `'SYSTEM'` per the FSM table); `UPDATE lite_bookings SET status='DISPATCHING', dispatch_started_at=NOW() WHERE id=$1 AND status=$expected RETURNING id` (0 rows â‡’ 409); audit `'dispatch.start'`. Then call `offerNext(bookingId)`.
- **Ranking query (inside `offerNext`)** â€” region-scoped, PostGIS, eligibility-filtered, exclusion-filtered, NO coords returned to callers:
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
- **`offerNext(bookingId)`:** count existing offers for the booking; if `>= MAX_OFFERS` â†’ `noProvider(bookingId)`. Else run the ranking query; if no candidate â†’ `noProvider(bookingId)`. Else `INSERT INTO dispatch_offers (booking_id, provider_user_id, rank, distance_km, status, offered_at, expires_at) VALUES ($1,$2,$nextRank,$dist,'OFFERED',NOW(),NOW()+($ttl||' seconds')::interval) RETURNING id`. The partial unique index `dispatch_offers_one_live_per_provider (provider_user_id) WHERE status='OFFERED'` makes a concurrent double-offer of the same provider fail the INSERT â€” catch the unique violation and re-run `offerNext` (advance to the next candidate) rather than 500. Then call the Step-7 push (`BookingPushBridge.dispatchOffer(providerUserId, â€¦)`) outside the critical section, best-effort. Audit `'dispatch.offer'` with `{rank, distance_km, provider_user_id}`.
- **`reject(offerId, providerUserId, reason?)`:** conditional `UPDATE â€¦ SET status='REJECTED', responded_at=NOW(), reject_reason=$reason WHERE id=$1 AND status='OFFERED' AND provider_user_id=$2 RETURNING id` (0 rows â‡’ 409; ownership is also re-checked at the controller in Step 7). Then `offerNext(bookingId)`. (Redact PII from `reject_reason` â€” Part III privacy P1.)
- **`expire(offerId)`** (called by Step 8 watchdog): conditional `UPDATE â€¦ SET status='EXPIRED', responded_at=NOW() WHERE id=$1 AND status='OFFERED' RETURNING booking_id`; if 0 rows, no-op (raced with accept). Then `offerNext(returned booking_id)`.
- **`noProvider(bookingId)`:** conditional `UPDATE lite_bookings SET status='NO_PROVIDER', dispatch_settled_at=NOW() WHERE id=$1 AND status='DISPATCHING' RETURNING id` (0 rows â‡’ booking already moved on; no-op). `fsm.assert('DISPATCHING','NO_PROVIDER','SYSTEM')`. Push client `BookingPushBridge.noProvider(clientUserId, â€¦)` (Step 7). Audit `'dispatch.no_provider'`. (LB13: NO_PROVIDER should later offer a safety fallback, not just "no one available" â€” note it; out of scope for this step.)
- **`cancel(bookingId)`** (client cancels while searching): in a txn, `UPDATE dispatch_offers SET status='SUPERSEDED' WHERE booking_id=$1 AND status='OFFERED' RETURNING provider_user_id, id`; `fsm.assert(cur,'CANCELLED','CLIENT'); UPDATE lite_bookings SET status='CANCELLED' WHERE id=$1 AND status='DISPATCHING' RETURNING id`. Notify the current holder (push). No charge (money only moves at accept). Audit `'dispatch.cancel'`.
- **`accept(...)`** â€” stub the signature here returning a TODO/throw; full implementation (charge into escrow + Ops Room + bookingâ†’CONFIRMED) is the Phase 6 / Part V escrow step. Its body MUST be the offer-anchored conditional UPDATE (`â€¦ WHERE id=$1 AND status='OFFERED' AND expires_at>NOW() RETURNING`).
  **Frontend / ops-console how-to:** None (pure backend).
  **Security stop-conditions:**
- **STOP/verify against the System Architecture Documentation** before exposing ANY coordinate: this step must keep pickup/dropoff out of everything a rejecting/offered agency can read (LB1, Part III #3). Persist only `distance_km` (and bucket it for display in Step 7). Do not add coords to `dispatch_offers` rows that the provider can query.
- Do NOT touch encryption, sealed-sender, or the Ops Room here. The Ops Room is created later (accept) via `ensureBookingOpsRoom` only.
- Do NOT add a "skip in dev" branch to the eligibility/vetting predicate (LB10) â€” if the licence/insurance/armed registry isn't built yet, gate the whole feature behind `AUTO_DISPATCH_ENABLED` rather than weakening the filter.
- Never log plaintext addresses/coords or PII from `reject_reason` (static log-audit test enforces no plaintext leaks).
  **Acceptance & tests:**
- NEW unit tests in `dispatch.service.spec.ts` (mock `DatabaseService`/`RedisService`): (a) pool of 3 agencies at increasing distance â†’ offers go out nearest-first; (b) reject #1 â†’ #2 gets the offer and #1 is in the booking's `REJECTED` exclusion; (c) accept-state guard: `expire`/`reject` on a non-`OFFERED` offer returns/raises the concurrent-change error (409 path); (d) empty/zero-eligible pool â†’ `noProvider` flips booking to `NO_PROVIDER`; (e) `MAX_OFFERS` reached â†’ `noProvider`; (f) capacity: agency with `free_cpos < cpo_count` is excluded; (g) requirements: a job needing armed/female excludes a non-qualifying agency; (h) the `one-live-offer-per-provider` unique-violation path re-runs `offerNext` instead of 500.
- Regression: run the **booking** Jest project â€” `npm test -- --selectProjects=booking` â€” and the ops smoke specs (`ops-flow.smoke.spec.ts`); the legacy admin flow and existing FSM transitions must still pass.
- Gates: `cd apps/auth-service && npm run build` (backend typecheck/build); root `npm run typecheck` (mobile, â‰¤ baseline 96) and `cd apps/ops-console && npm run typecheck` (no mobile/ops changes here, so just confirm no drift); `npm run lint`. `npm run test:crypto` not required (no messaging touched). **CORRECTION (Part III #6): CI does not run auth-service tests today** â€” these specs are invisible to the gate until Step (CI fix) lands; run them locally and do not rely on CI green for this module yet.
- Never commit on a red gate; never `--no-verify`.
  **Done when:**
- `DispatchService` exists and is registered in `app.module.ts`; `start â†’ offerNext` produces an `OFFERED` row for the nearest eligible same-region agency only.
- Every state-changing method (`start/offerNext/expire/reject/noProvider/cancel`) is a conditional `UPDATE â€¦ WHERE <expected status> RETURNING` inside `withTransaction`; concurrent callers get a 409-style error, never a double-action.
- Ranking uses PostGIS `ST_DWithin`/distance ordering (no per-row haversine) and applies region + capacity + requirements + vetting filters.
- No coordinates are persisted or returned to offered/rejecting agencies.
- Cascade advances on reject/expire, stops on accept, and resolves to `NO_PROVIDER` on empty pool or `MAX_OFFERS`; all unit tests above pass locally; booking Jest project still green.

## Step 7 â€” Offer endpoints: coarse visibility + IDOR scope + idempotency + throttle

**Stage:** Dispatch engine Â· **Depends on:** Step 6 (`DispatchService` methods + `dispatch_offers` rows), Step 2 (migration), Step 1 (feature flag) Â· **Resolves:** Part I Â§9 (Phase 4 provider accept/reject), Part III "Security & threat model" + "Anti-fraud" + "Privacy", LB1 (principal location is the crown jewel), LB3 (money offer-anchored & race-safe â€” accept path), LB7 (cross-tenant IDOR), Audit H5 (UUID-stripping both directions)
**Goal (plain English):** Build the HTTP endpoints the agency app calls to see and respond to an incoming job. Before the agency accepts, they only ever see _coarse_ details â€” region, a bucketed distance, a truncated/zone pickup, the time window, and the price â€” never the customer's exact address. The precise location is revealed only after they accept, through a separate endpoint that refuses anyone who isn't the accepting agency. Accept and decline are tap-safe (no double-charge from a double-tap) and rate-limited.
**Why it matters / what breaks without it:** Shipping the exact pickup/dropoff to every offered (and every rejecting) agency is the single worst data leak in this system â€” it tells firms that DIDN'T take the job exactly where the protected person will be (Part III's "crown-jewel leak"). Without tenant scoping, one firm could accept/read another firm's job (IDOR). Without idempotency, a double-tap or two devices could double-charge. Without throttling, the free request/poll becomes a fleet-reconnaissance and denial-of-coverage oracle.
**Self-contained context (inline â€” do not make the reader open the plan):**

- **Endpoints (all `@UseGuards(JwtAuthGuard, UserThrottlerGuard)`):**
  - `GET /dispatch/offers/current` â†’ the caller's single live `OFFERED` offer (or `null`), joined to the booking but returning **COARSE ONLY**: `{ offer_id, expires_at, region_code, distance_bucket (e.g. "<2km"/"2â€“5km"/"5â€“10km"/">10km"), pickup_zone_or_truncated, time_window, price, cpo_count, requirements (armed/female/medical flags) }`. **NEVER** exact `pickup_lat/lng`, `dropoff_lat/lng`, full address, or client identity pre-accept (LB1).
  - `GET /dispatch/offers/:id/full` â†’ precise `{ pickup_lat/lng, pickup_address, dropoff_lat/lng, dropoff_address, â€¦ }` returned **ONLY when** `offer.status='ACCEPTED' AND caller's org == offer.provider_user_id`; **403** otherwise. Write an `ops_audit` row on **every** read of this endpoint (LB1: "audit every full read").
  - `POST /dispatch/offers/:id/accept` â†’ `DispatchService.accept(offerId, providerUserId)`; `@UseInterceptors(IdempotencyInterceptor)` (client sends `Idempotency-Key`); offer-state guard.
  - `POST /dispatch/offers/:id/reject` body `{ reason? }` â†’ `DispatchService.reject(offerId, providerUserId, reason)`; offer-state guard.
- **Offer-state guard:** accept/reject return **409** if the offer is not `OFFERED` (already expired/superseded/accepted) â€” the app then shows "this job was reassigned." The real exactly-once guarantee is the conditional `UPDATE â€¦ WHERE status='OFFERED' RETURNING` inside `DispatchService` (Step 6 / LB3/LB8), NOT the idempotency cache.
- **Caller-org resolution (LB7 â€” the IDOR fix):** the offer's `provider_user_id` is the **company agent's `users.id`** (the org). The caller may be the company account itself OR an active _manager_ of that org â€” NOT necessarily `req.user.sub`. Resolve the caller's org exactly like `OrgManagerGuard` does (`apps/auth-service/src/org/org-manager.guard.ts`): (1) if `req.user.sub` is a `company` agent â†’ org = `sub`; (2) else if an `org_members` row exists with `member_role='manager', status='active'` â†’ org = `org_user_id`; else 403. Then require **resolved org == `offer.provider_user_id`**, else **403** â€” use `assertOrgScope(manager, offer.provider_user_id)` (exported from `org-manager.guard.ts`). Apply this on `current`, `full`, `accept`, and `reject`. Apply `OrgManagerGuard` to the controller so `req.orgManager: OrgManagerContext {user_id, org_user_id}` is populated.
- **UUID-stripping (Audit H5) â€” both directions:** mirror `BookingService.getTeam` (`booking.service.ts:390`), which strips the internal agent UUID from the client payload via `cpos.map(({id: _id, ...rest}) => rest)`. Here: (a) the COARSE offer to the agency must NOT carry the client's `users.id` or any cross-correlatable UUID; (b) any provider-facing payload must not leak other tenants' ids. "Both directions" = neither the agency-facing nor (later) the client-facing payload exposes the counterpart's internal account UUID.
- **Reuse points (confirmed in code):** `IdempotencyInterceptor` (`apps/auth-service/src/common/interceptors/idempotency.interceptor.ts`) â€” requires header `Idempotency-Key` (8â€“128 chars `[A-Za-z0-9_-]`), caches per (actor, method+route, key) for 24h, never caches thrown errors. `UserThrottlerGuard` (`common/guards/user-throttler.guard.ts`) â€” buckets by `user:<sub>`; apply AFTER `JwtAuthGuard`. `@Throttle({default:{limit,ttl}})` from `@nestjs/throttler` â€” exact usage in `sos/sos.controller.ts:13,25` (`@UseGuards(JwtAuthGuard, UserThrottlerGuard)` on the class, `@Throttle({default:{limit:3,ttl:60_000}})` per route). `OpsAuditService.record({actor_id, actor_role:'SYSTEM'|provider, action:'dispatch.full_read'|'dispatch.accept'|'dispatch.reject', subject_type:'booking', subject_id, metadata})`. `AccessClaims.sub` is the user id.
- **Booking FSM context:** accept (Step 6/Phase 6) flips `DISPATCHING â†’ CONFIRMED` (SYSTEM) and charges into escrow; reject leaves the booking `DISPATCHING` and cascades. This step is the controller surface; the transactional guts live in `DispatchService`.
  **Files to touch:**
- NEW `apps/auth-service/src/dispatch/dispatch.controller.ts` â€” the four routes above with guards/interceptors; resolves caller org and calls `assertOrgScope`.
- NEW `apps/auth-service/src/dispatch/dto/` â€” `CoarseOfferDto`, `FullOfferDto`, `RejectOfferDto { reason?: string }`. Keep DTOs focused; do NOT widen any existing client/team DTO.
- EXTEND `apps/auth-service/src/dispatch/dispatch.module.ts` â€” declare the controller; ensure `RedisModule` (for `IdempotencyInterceptor`), `ThrottlerModule` (already configured app-wide in `app.module.ts`), `DatabaseService`, `OrgManagerGuard`, `OpsAuditService` are available.
- EXTEND `apps/auth-service/src/dispatch/dispatch.service.ts` â€” add coarse/full read helpers (`getCurrentOfferForOrg(orgUserId)`, `getFullOffer(orgUserId, offerId)`), bucketing helper for `distance_km â†’ distance_bucket`, and pickup truncation/zone helper. (`reject` + `accept` already exist from Step 6.)
- NEW `apps/auth-service/src/dispatch/dispatch.controller.spec.ts` â€” controller/auth tests.
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

- **`getCurrentOfferForOrg(orgUserId)`** in the service: `SELECT o.id, o.expires_at, o.distance_km, b.region_code, b.pickup_time, b.duration_hours, b.total_eur, b.cpo_count, b.add_ons FROM dispatch_offers o JOIN lite_bookings b ON b.id=o.booking_id WHERE o.provider_user_id=$1 AND o.status='OFFERED' ORDER BY o.offered_at DESC LIMIT 1`. Map to coarse DTO: bucket `distance_km`; derive `pickup_zone` (zone name via PostGIS `ST_Contains(zones.zone, pickup_point)` or truncate coords to ~2 decimals / round to a grid) instead of returning raw lat/lng; derive `time_window` from `pickup_time` (Â±window); derive `requirements` from `add_ons` (+ the armed flag added in Step 2). **Strip every counterpart UUID** (no `client_id`, no `booking_id` if it enables `/full` enumeration â€” if you must return `offer_id`, that's the only handle the agency needs).
- **`getFullOffer(orgUserId, offerId)`:** `SELECT o.status, o.provider_user_id, o.booking_id FROM dispatch_offers o WHERE o.id=$1`; if not found â†’ 404; if `o.provider_user_id !== orgUserId` â†’ 403 (also call `assertOrgScope(req.orgManager, o.provider_user_id)`); if `o.status !== 'ACCEPTED'` â†’ 403 `offer_not_accepted`. Only then `SELECT pickup_lat,pickup_lng,pickup_address,dropoff_lat,dropoff_lng,dropoff_address FROM lite_bookings WHERE id=o.booking_id`. Return the precise DTO. The controller audits the read.
- **Purge note (LB1/privacy):** rejected/expired/superseded offers must not retain any way to fetch precise location â€” `/full` already gates on `status='ACCEPTED'`, so a SUPERSEDED/REJECTED offer can never read coords. (A separate retention/purge job for `dispatch_offers` PII is a later privacy step.)
  **Frontend / ops-console how-to:** None in this step (the provider mobile `dispatchApi.getCurrentOffer/getFull/accept/reject` client + incoming-offer card are a later mobile step). Note for that step: the countdown must bind to the server `expires_at` (not a local 30s timer), the accept call must send an `Idempotency-Key`, and a network error on accept must re-fetch truth (a lost-200 is possible) rather than assume failure.
  **Security stop-conditions:**
- **STOP/verify against the System Architecture Documentation** that coarse-only pre-accept disclosure + ACCEPTED-only precise reveal is the agreed contract (LB1). The exact pickup/dropoff/address must never appear in `GET /dispatch/offers/current` or in any payload an offered/rejecting agency can read.
- No "skip in dev" on `JwtAuthGuard`/`OrgManagerGuard`/the ownership 403 â€” every offer endpoint stays JWT-guarded with the resolved-org ownership check.
- Idempotency on accept is for tap-safety only; the authoritative exactly-once is the conditional UPDATE in `DispatchService.accept` (LB3) â€” do not let the idempotency cache substitute for the DB lock.
- Audit every `/full` read; redact PII from `reject_reason` before storing/logging; never log addresses/coords (static log-audit test enforces no plaintext leaks).
- This step touches no encryption/sealed-sender/Ops-Room/group-key code.
  **Acceptance & tests:**
- NEW controller/unit tests in `dispatch.controller.spec.ts`: (a) `GET /current` returns coarse fields only â€” assert the response object has NO `pickup_lat/lng`, `dropoff_*`, full address, or `client_id`; (b) `GET /:id/full` 403 when offer is `OFFERED`/`REJECTED` (not `ACCEPTED`); 403 when caller org â‰  provider; 200 + coords + an `ops_audit` row when `ACCEPTED` and caller is the provider; (c) accept/reject 409 when offer not `OFFERED`; (d) IDOR: a different org's manager calling accept/reject/full on this offer â†’ 403 via `assertOrgScope`; (e) accept replays (same `Idempotency-Key`) â†’ single side-effect; (f) missing/invalid `Idempotency-Key` on accept â†’ 400; (g) throttle: exceeding the per-route limit â†’ 429.
- Regression: **booking** Jest project (`npm test -- --selectProjects=booking`) + ops smoke specs; legacy flow unaffected.
- Gates: `cd apps/auth-service && npm run build`; root `npm run typecheck` (â‰¤96) and `cd apps/ops-console && npm run typecheck`; `npm run lint`. `npm run test:crypto` not required. Remember CI does not yet run auth-service tests (Part III #6) â€” run these locally.
- Never commit on red; never `--no-verify`.
  **Done when:**
- `GET /dispatch/offers/current` returns coarse-only data (no exact location, no client UUID); a test asserts the precise fields are absent.
- `GET /dispatch/offers/:id/full` returns coords only for `status='ACCEPTED'` and the owning org, 403s everyone else, and writes an audit row on every successful read.
- accept/reject resolve the caller's org (company self or active manager), enforce `assertOrgScope` against `offer.provider_user_id`, and 409 on a non-`OFFERED` offer.
- accept is wrapped in `IdempotencyInterceptor`; all four routes carry `UserThrottlerGuard` + `@Throttle`.
- All controller tests pass locally; booking Jest project still green.

## Step 8 â€” Watchdogs (Redis-locked): offer-expiry cascade + crew-assign SLA

**Stage:** Dispatch engine Â· **Depends on:** Step 6 (`DispatchService.expire/offerNext/noProvider`), Step 7 (accept path sets booking `CONFIRMED` + writes the escrow hold / `crew_deadline_at`), Step 2 (migration: `dispatch_offers`, `lite_bookings.crew_deadline_at` or escrow `crew_deadline_at`) Â· **Resolves:** Part I Phase 5 (re-dispatch cascade + timeout) **as corrected by Part III #1**, Part III "Reliability & correctness" + "Observability" + "Scalability", LB5 (charged-but-never-crewed orphan), LB9 (multi-pod-safe watchdog)
**Goal (plain English):** Add background timers that run safely even though the server runs as many copies (replicas). Timer 1 watches every outstanding 30-second offer; when one lapses (or the holding agency drops offline), it cancels that offer and moves the job to the next-nearest agency â€” no human needed. Timer 2 watches jobs an agency accepted-and-was-charged-for but never staffed; if they miss the deadline, it auto-refunds the customer, flags the agency, and (optionally) re-dispatches.
**Why it matters / what breaks without it:** The cascade in Step 6 only advances on an _active_ reject/expire call â€” without a watchdog, an offer the agency simply ignores would freeze the customer on "Findingâ€¦" forever. And because the customer is charged into escrow at accept (Part V), a job the agency never crews would leave the customer's money trapped with no guard coming (LB5). **CORRECTION (Part III #1):** `auth-service` runs **multiple replicas**, so a bare `setInterval`/`@nestjs/schedule` loop would have _every pod_ fire the same expiry and double-cascade â€” the watchdog MUST use the Redis `SET NX` lock pattern.
**Self-contained context (inline â€” do not make the reader open the plan):**

- **The proven pattern to copy (do NOT use `@nestjs/schedule`):** `apps/auth-service/src/booking/payment-pending-expiry.service.ts`. It is a `@Injectable()` implementing `OnModuleInit`/`OnModuleDestroy`; `onModuleInit` starts `setInterval(() => void this.sweepOnce(), SWEEP_INTERVAL_MS)`; `onModuleDestroy` clears it. `sweepOnce()` first does `const got = await this.redis.client.set(LOCK_KEY, String(Date.now()), 'PX', LOCK_TTL_MS, 'NX'); if (got !== 'OK') return {skipped_lock:true};` then `try { â€¦workâ€¦ } finally { await this.redis.client.del(LOCK_KEY) }`. `LOCK_TTL_MS` is set **shorter than the interval** so a crashed sweeper doesn't pin the lock. Each candidate is processed in its own `db.withTransaction` with `SELECT â€¦ FOR UPDATE` + a status re-check + conditional `UPDATE â€¦ WHERE status=$expected` (the looser branch no-ops if the row already moved on). `sweepOnce()` is `public` for tests.
- **Sweep 1 â€” offer-expiry cascade:** every ~5â€“10s, find `OFFERED` offers past `expires_at` (with a **clock-skew grace**, e.g. `expires_at < NOW() - INTERVAL '2 seconds'`, to avoid expiring an offer the same instant the agency accepts). For each, call `DispatchService.expire(offerId)` â€” which does the conditional `UPDATE â€¦ SET status='EXPIRED' WHERE id=$1 AND status='OFFERED' RETURNING booking_id` and then `offerNext(booking_id)`. **Accept-vs-expire ordering (LB9):** because both `accept` (Step 6/7) and `expire` use the same `WHERE status='OFFERED' RETURNING` guard, whichever commits first wins; the loser sees 0 rows and no-ops â€” so an accept landing during the grace window cannot be clobbered by an expire. **Provider-went-offline mid-offer:** also expire offers whose holder went `on_duty=false` or whose `last_location_at` is now stale (older than `LOCATION_FRESH_MINUTES`) â€” extend the WHERE clause (`JOIN agents a ON a.user_id=o.provider_user_id WHERE o.status='OFFERED' AND (o.expires_at < NOW()-grace OR a.on_duty=false OR a.last_location_at < NOW()-fresh_interval)`).
- **Sweep 2 â€” crew-assign SLA (LB5):** at accept (Step 6/Phase 6) the booking goes `DISPATCHING â†’ CONFIRMED` ("accepted, awaiting crew"), the client is charged **into escrow** (`escrow_holds.status='HELD'`, Part V), and a `crew_deadline_at` is stamped. This sweep finds bookings still `CONFIRMED` (or escrow `HELD`) past `crew_deadline_at` with **no `missions` row** â†’ in one txn: refund the client from escrow (`WalletService.refundForBooking(clientId, bookingId, reason)` / escrowâ†’client per Part V), set `escrow_holds.status='REFUNDED'`, flip booking to `AGENCY_NO_SHOW` (or `CANCELLED`/`NO_PROVIDER` per the FSM you defined), supersede any live offer, increment an agency reliability/breach counter, push the client, and (optional) re-dispatch via `DispatchService.start` to find a replacement agency. Each booking in its own `withTransaction` + `FOR UPDATE` + conditional `UPDATE â€¦ WHERE status='CONFIRMED' AND NOT EXISTS(SELECT 1 FROM missions WHERE booking_id=â€¦) RETURNING`.
- **Liveness metric (LB9/observability):** each sweep emits a self-reported liveness signal (e.g. write a Redis key `dispatch:watchdog:last_run` with `NOW()` + counters, or increment a metric) so an alert can fire if the watchdog dies â€” "no human watches dispatch" (D1), so a dead watchdog must page someone.
- **Reuse points:** `DatabaseService` (`db.q/db.qOne/db.withTransaction`, `tx.q/tx.qOne`, `SELECT â€¦ FOR UPDATE`), `RedisService` (`redis.client.set(â€¦, 'PX', ttl, 'NX')`, `redis.client.del`), `BookingStateMachine.assert`, `DispatchService.expire/offerNext/start`, `WalletService.refundForBooking(userId, bookingId, description)` (confirmed at `wallet.service.ts:251`), `BookingPushBridge.noProvider/providerAccepted` (Step 7), `OpsAuditService.record`.
- **Constants (mirror the reference service):** `OFFER_SWEEP_INTERVAL_MSâ‰ˆ5_000â€“10_000`, `OFFER_LOCK_KEY='lock:dispatch-offer-expiry'`, `OFFER_LOCK_TTL_MS` < interval; `CREW_SLA_SWEEP_INTERVAL_MSâ‰ˆ60_000`, `CREW_LOCK_KEY='lock:dispatch-crew-sla'`, `CREW_LOCK_TTL_MS` < interval; `EXPIRY_GRACE_SECONDS=2`; `LOCATION_FRESH_MINUTES=5`. Cap each sweep's batch (`LIMIT 50`) and `ORDER BY` the relevant timestamp `ASC` like the reference.
  **Files to touch:**
- NEW `apps/auth-service/src/dispatch/offer-expiry.service.ts` â€” Sweep 1 (`OfferExpiryService`), a near-copy of `payment-pending-expiry.service.ts` calling `DispatchService.expire`.
- NEW `apps/auth-service/src/dispatch/crew-sla.service.ts` â€” Sweep 2 (`CrewAssignSlaService`), same Redis-locked shape, refund + flag + supersede + optional re-dispatch. (May instead live in the Part V escrow module; if so, keep the Redis-lock contract identical.)
- EXTEND `apps/auth-service/src/dispatch/dispatch.module.ts` â€” provide both sweep services; ensure `RedisModule`, `WalletModule` (for `refundForBooking`), `DatabaseModule`, `OpsAuditService`, `DispatchService`, the booking FSM, and `BookingPushBridge` are imported/available.
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
        // expire() is itself a conditional UPDATE â€¦ WHERE status='OFFERED' RETURNING + offerNext
        this.log.warn(`offer-expiry failed for ${r.id}: ${(e as Error).message}`);
      }
    }
    await this.redis.client.set('dispatch:watchdog:offer:last_run', String(Date.now()), 'EX', 600); // liveness
    return {expired: due.length, skipped_lock: false};
  } finally {
    await this.redis.client.del(OFFER_LOCK_KEY).catch(() => undefined);
  }
  ```
- **Sweep 2 `sweepOnce()`:** lock with `CREW_LOCK_KEY`; `SELECT b.id, b.client_id FROM lite_bookings b WHERE b.status='CONFIRMED' AND b.crew_deadline_at < NOW() AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.booking_id=b.id) ORDER BY b.crew_deadline_at ASC LIMIT 50`. For each, in its own `withTransaction`: `SELECT status FROM lite_bookings WHERE id=$1 FOR UPDATE`; re-check still `CONFIRMED` with no mission (skip if raced); `fsm.assert(cur,'AGENCY_NO_SHOW'|'CANCELLED','SYSTEM')`; conditional `UPDATE lite_bookings SET status=â€¦ WHERE id=$1 AND status='CONFIRMED' RETURNING id` (0 rows â‡’ skip); refund escrowâ†’client (`refundForBooking` / Part V escrow transition `HELDâ†’REFUNDED`); `UPDATE dispatch_offers SET status='SUPERSEDED' WHERE booking_id=$1 AND status='OFFERED'`; bump agency breach counter; audit `'dispatch.crew_sla_refund'` (non-critical action name so the audit path doesn't force-rollback unless you want it to). After the txn, push the client (`BookingPushBridge`) and optionally `DispatchService.start($1)` to re-dispatch a replacement. Emit liveness key.
- **Wiring:** both services implement `OnModuleInit`/`OnModuleDestroy`, start/stop their `setInterval`, and are listed as providers in `DispatchModule` (which is registered in `app.module.ts` per Step 6). Behind `AUTO_DISPATCH_ENABLED` â€” when the flag is off, the sweeps should no-op (skip the work) so the dark feature has zero side effects.
  **Frontend / ops-console how-to:** None (pure backend). (The ops-console dispatch monitor surfaces the cascade trail and the watchdog-liveness/stuck-DISPATCHING alerts in a later step.)
  **Security stop-conditions:**
- No "skip in dev" on the Redis lock â€” the multi-pod safety IS the security/correctness property (Part III #1/LB9). Do not replace it with a bare interval "just for local."
- The crew-SLA refund moves money â€” every refund is the conditional-UPDATE-inside-txn + idempotent `refundForBooking` (idempotent per (user, booking) â€” see `booking.service.ts cancel()` comment "refund is idempotent per (user, booking) so a retry can't double-credit"); never double-refund. This touches the wallet/escrow ledger only â€” STOP/verify against Part V's money-invariant (`held == to_provider + to_client + platform_fee`) before changing any ledger move; no crypto/auth involved.
- Never log client coords/addresses or PII in sweep logs (static log-audit test).
  **Acceptance & tests:**
- NEW unit tests (mock `RedisService` + `DatabaseService` + `DispatchService`/`WalletService`): (a) **lock contention** â€” when `redis.set(...'NX')` returns non-`'OK'`, `sweepOnce` returns `skipped_lock:true` and does NO work (this is the multi-pod double-cascade guard, Part III testing P0); (b) an `OFFERED` offer past `expires_at + grace` â†’ `DispatchService.expire` called once â†’ next agency offered; (c) an offer still inside the grace window is NOT expired; (d) provider `on_duty=false`/stale-location holding an offer â†’ expired + cascaded; (e) accept-vs-expire ordering â€” if the offer flips to `ACCEPTED` between SELECT and the expire UPDATE, `expire` no-ops (0 rows), no cascade; (f) Sweep 2 â€” `CONFIRMED` booking past `crew_deadline_at` with no mission â†’ refund called once, offer SUPERSEDED, booking flipped, agency flagged; idempotent on re-run; (g) Sweep 2 skips a booking that already has a `missions` row.
- Regression: **booking** Jest project (`npm test -- --selectProjects=booking`) + the existing `payment-pending-expiry` spec (confirm the pattern wasn't regressed) + ops smoke.
- Gates: `cd apps/auth-service && npm run build`; root `npm run typecheck` (â‰¤96) and `cd apps/ops-console && npm run typecheck`; `npm run lint`. `npm run test:crypto` not required. CI does not run auth-service tests yet (Part III #6) â€” run locally; the multi-pod lock test is a Part III P0, so make it explicit.
- Never commit on red; never `--no-verify`.
  **Done when:**
- Both sweeps run via the Redis `SET NX`-locked `setInterval` pattern (copied from `payment-pending-expiry.service.ts`), with lock TTL < interval and a `finally`-block `del`.
- An ignored/lapsed offer (or an offline/stale holder) is auto-expired with a clock-skew grace and cascades to the next agency; an accept landing in the grace window always wins over expiry.
- A charged-but-never-crewed booking past its `crew_deadline_at` is auto-refunded, the offer superseded, the agency flagged, and (if enabled) re-dispatched â€” money is never trapped.
- Each sweep emits a liveness signal; the lock-contention path is unit-tested (no double-cascade across pods); all new specs pass locally; booking Jest project still green.

---

## Step 9 â€” Escrow on accept (charge â‰  pay)

**Stage:** Money Â· **Depends on:** Step 7 (offer-accept txn / `DispatchService.accept`), Step 8 (escrow + platform-fee account migration `escrow_holds`/`booking_disputes`) Â· **Resolves:** Part V Â§39.1 / Â§38, Part I Â§6 + Â§11.1, LB3, PV2
**Goal (plain English):** When an agency taps Accept, the customer's money is taken out of their wallet and parked in a neutral "holding pot" (escrow) â€” it is NOT given to the agency. If the customer can't actually pay at that instant, the acceptance is undone so no guard is committed to an unpaid job. We also check the customer can afford it back at request-submit time so this almost never happens at accept.
**Why it matters / what breaks without it:** Without escrow, "charged" and "paid" collapse into one event â€” the agency could be paid before doing the job, and a cancel/no-show would mean clawing money back from the agency's wallet. The held-funds layer is the foundation every later money step (release, refund, dispute, pro-rata) builds on.

**Self-contained context (inline â€” do not make the reader open the plan):**

- LOCKED DECISIONS: D2 = charge on accept INTO ESCROW (released only on verified completion); D1 = fully automatic (no admin in the accept money loop); D3 = the AGENCY accepts then later deploys its own CPOs.
- The core principle (Â§36): "charged â‰  paid." On accept, debit the client and credit a dedicated **platform escrow (held-funds) account** â€” never the agency wallet. Every move is a **paired** `wallet_transactions` row (one debit, one credit) so the ledger always balances.
- Money state machine (Â§37): the hold starts at `HELD`. ENUM `escrow_hold_status = ('HELD','PENDING_RELEASE','RELEASED','REFUNDED','PARTIAL','DISPUTED')`. `escrow_holds` (created in Step 8) has UNIQUE `booking_id`, plus `offer_id`, `client_id`, `provider_user_id` (the agency payee, set at accept), `gross_credits`, `currency`, `status DEFAULT 'HELD'`, `held_at`.
- Accept's order of operations (Â§39.1 / Part I Â§11): inside ONE `withTransaction` â€” (1) conditional UPDATE flips the offer `OFFERED â†’ ACCEPTED` (the race-safe lock; loser sees 0 rows and aborts) and verifies the booking is `DISPATCHING`; (2) debit client â†’ credit escrow account (paired ledger rows); (3) INSERT `escrow_holds (... status 'HELD', provider_user_id, gross_credits, currency, offer_id)`; (4) flip booking `DISPATCHING â†’ CONFIRMED` (FSM actor `SYSTEM`). If the debit fails (`insufficient_credits`): **abort the accept** â€” the offer is NOT won, NO hold is written.
- Affordability pre-check at **request submit** (Â§11.1): soft-check the client can afford the estimate; route a short balance to `CreditPaywallScreen` _before_ dispatch so a guard is never offered an unpayable job. The real debit still happens at accept.
- **Reuse the locked-balance pattern** from `booking.service.ts payWithCredits()` (verified): it `withTransaction` â†’ `SELECT bravo_credits, currency FROM wallet_balances WHERE user_id=$1 FOR UPDATE` â†’ `if (have < cost) throw BadRequestException('insufficient_credits')` â†’ INSERT `wallet_transactions (type='payment', amount_credits=-cost, ...)` â†’ `UPDATE wallet_balances SET bravo_credits = bravo_credits - $1`. Factor this debit core into a shared method (or call a wallet-service method) â€” do not duplicate. The mirror credit to escrow is the same pattern with a positive `amount_credits` against `ESCROW_ACCOUNT_ID`.
- The client debit must be **idempotent on `booking_id`** (one hold per booking even on double-tap accept). `escrow_holds.booking_id` is `UNIQUE`, so the INSERT naturally collapses; add `ON CONFLICT (booking_id) DO NOTHING` and treat 0-rows-inserted as "already held." The ledger debit reuses the existing per-booking idempotency convention.
- **Idempotency-Key required** on the accept endpoint via the existing `IdempotencyInterceptor` (header `Idempotency-Key`, 8â€“128 chars `[A-Za-z0-9_-]`, scoped per-actor + method+route, 24 h Redis cache; thrown errors are NOT cached so retry works).
- Stamp ledger `metadata.offer_id` on both paired rows (today `payWithCredits` writes `metadata='{}'::jsonb` â€” extend to `'{"offer_id":"..."}'::jsonb`).
- NOTE: `dispatch_offers` does NOT exist in code yet (only in the plan) â€” it is created by the dispatch/offer track (Step 7). The booking states `DISPATCHING`/`CONFIRMED` and `lite_bookings.assigned_provider_user_id`/`dispatch_settled_at` likewise land in earlier steps. Verify those exist before wiring this step. The escrow currency is the booking's `lite_bookings.total_eur` magnitude (an integer credit amount, despite the `_eur` name) and the wallet row's `currency`.

**Files to touch:**

- EXTEND `apps/auth-service/src/wallet/wallet.service.ts` â€” NEW method e.g. `holdToEscrow(clientId, bookingId, escrowAccountId, credits, currency, offerId, tx)` that runs the locked debit-client + credit-escrow paired rows; reuse the `payWithCredits` locking pattern. Keep it callable INSIDE an existing transaction (accept needs all-or-nothing with the offer flip).
- EXTEND the dispatch service that owns accept (the `DispatchService.accept(offerId, providerUserId)` created in Step 7) â€” inside the offer-flip txn, after `OFFEREDâ†’ACCEPTED` + booking `DISPATCHING` check, call the escrow hold + INSERT `escrow_holds`; on `insufficient_credits` let the exception unwind the whole txn (offer stays `OFFERED`).
- EXTEND `apps/auth-service/src/booking/booking.service.ts` (or the submit/estimate path) â€” add the **affordability soft-check at submit** so a short balance routes to the paywall pre-dispatch. Reuse `estimate()` for the amount.
- EXTEND the accept controller route â€” add `@UseInterceptors(IdempotencyInterceptor)` (mirror the existing `@Post('bookings/:id/pay-with-credits')` decoration).
- EXTEND the Step 8 migration (or a follow-up) only if the seeded `ESCROW_ACCOUNT_ID` / platform-fee account ids need a `wallet_balances` row â€” verify they were seeded in Step 8.

**Backend how-to:**

- Endpoint (from Step 7): `POST /ops/dispatch/offers/:offerId/accept` (or the agency-facing route) â€” `@UseGuards(JwtAuthGuard, â€¦)` + `@UseInterceptors(IdempotencyInterceptor)`. Body none; actor = the agency company-agent user.
- Race-safe core, all in one `db.withTransaction(async tx => { â€¦ })`:
  ```sql
  -- 1) win the offer (race lock)
  UPDATE dispatch_offers SET status='ACCEPTED', responded_at=NOW()
   WHERE id=$1 AND status='OFFERED' AND expires_at > NOW()
   RETURNING booking_id, /* coarse fields */;
  -- 0 rows â†’ throw BadRequestException('offer_not_available')
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
- Affordability pre-check (submit): in the submit handler, after `estimate()`, `SELECT bravo_credits FROM wallet_balances WHERE user_id=$client`; if short, return a structured `{code:'insufficient_credits', required, balance}` so the mobile client routes to the paywall before the booking enters dispatch. Add a `// Why:` line (per Â§11.1).
- The Ops Room open (`ensureBookingOpsRoom`) and accept push stay where Step 7 placed them (best-effort, outside the money txn) â€” do not move them inside.

**Frontend / ops-console how-to:**

- Mobile request wizard: on submit, if the API returns `insufficient_credits`, navigate to `CreditPaywallScreen` (existing) instead of dispatching. Pass the required top-up amount.
- Agency accept action (ops-console or agency mobile): mint and send an `Idempotency-Key` (e.g. `accept:<offerId>`) on the accept call so a double-tap collapses to one hold; surface `offer_not_available` (lost the race) and `insufficient_credits` (rare) distinctly.

**Security stop-conditions:** This step is wallet/ledger only â€” **no crypto, no E2E, no sender-cert, no auth-primitive changes**. The Ops Room remains metadata-only via `ensureBookingOpsRoom` (untouched here). Do NOT log plaintext, key bytes, or wallet PII beyond ids/amounts already conventional in the ledger (the static log-audit test enforces this). Do not add any "skip in dev" branch to the idempotency or balance guard. No stop-condition surfaces beyond standard guards, but if you find yourself touching the room/push payload, STOP and verify against the System Architecture Documentation (push payload must stay exactly `{userId,eventClass,eventId}`).

**Acceptance & tests:**

- New unit/integration (booking + a new wallet/dispatch spec): accept â†’ exactly ONE client debit into escrow, escrow account credited the same amount, NO agency credit row exists, `escrow_holds.status='HELD'`, booking `CONFIRMED`. Double-tap accept (same Idempotency-Key AND a concurrent no-key race) â†’ still exactly one hold, one debit. Accept with short balance â†’ `insufficient_credits`, offer stays `OFFERED`, NO hold, NO debit, booking still `DISPATCHING`. Submit with short balance â†’ `insufficient_credits` before dispatch.
- Money-invariant assertion: `sum(client debits for booking) == escrow_holds.gross_credits` and escrow account delta equals the debit (paired rows balance).
- Run `npm test -- --selectProjects=booking` (booking project) + the wallet spec; `npm run lint`; `npm run typecheck` (mobile must stay â‰¤ baseline 96) and `cd apps/ops-console && npm run typecheck`. Not near messaging, so `test:crypto` not required. Manual smoke: submit a job, accept from the agency, confirm wallet debited once and booking shows "Accepted Â· assigning team."
- Do NOT commit on a red gate; never `--no-verify`.

**Done when:**

- [ ] Accept debits the client and credits the escrow account in one txn (paired rows, ledger balances).
- [ ] An `escrow_holds` row exists at `HELD` with `offer_id`/`provider_user_id`/`gross_credits`/`currency`; no agency credit anywhere.
- [ ] Debit failure aborts accept (offer back/stays `OFFERED`, no hold).
- [ ] Idempotency-Key wired; double-tap = one hold; ledger `metadata.offer_id` stamped.
- [ ] Submit-time affordability check routes short balances to the paywall.
- [ ] Booking project + wallet tests, typecheck (both), lint all green.

---

## Step 10 â€” SettlementService + lead one-tap Finish + proof-of-completion gate

**Stage:** Money Â· **Depends on:** Step 9 (escrow `HELD` exists at accept), Step 8 (escrow schema) Â· **Resolves:** Part V Â§39.5 / Â§40, LB4, LB2, PV3, PV4
**Goal (plain English):** Pull the "pay everybody out" logic out of the admin-only close and into one shared service so both an admin AND a mission lead can drive a completion. Give the lead a one-tap Finish button. But Finish does NOT release money â€” it first checks the job objectively happened (the guard's phone actually reached the pickup, stayed a real amount of time, etc.). If the evidence passes, the hold moves to "pending release" and a dispute window opens; if it fails, the mission still closes but goes to human review and never auto-pays.
**Why it matters / what breaks without it:** Today the lead-complete path (`agent.service.ts missionComplete`) pays the crew INLINE (Audit C1), and settlement logic is duplicated between there and admin `completeBooking`. That means a lead tapping Finish â€” or an agency falsely marking "completed" â€” pays out immediately with zero proof. LB4/LB2 require: no money moves at Finish, settlement is one extractable service, and "completed" must be backed by evidence.

**Self-contained context (inline â€” do not make the reader open the plan):**

- LOCKED DECISIONS: D8 = one-tap finish, leader-only status. D2 = released only on verified completion. D1 = admin is the exception path, not the default money mover.
- CORRECTION (LB4): today the lead one-tap Finish does NOT correctly defer settlement â€” it pays inline. The fix is to (a) extract an **actor-agnostic `SettlementService`** from the settlement core of `ops.service.ts completeBooking`, and (b) make Finish open `PENDING_RELEASE` instead of paying.
- Current code reality (verified): `agent.service.ts missionComplete()` â†’ `flipMissionStatus(userId, missionId, 'COMPLETED', ['LIVE'])` does the lead check (`SELECT is_lead FROM mission_crew WHERE mission_id=$1 AND agent_id=$2`; throws `not_assigned_to_mission` / `lead_only`), conditional `UPDATE missions SET status='COMPLETED' ... WHERE id=$1 AND status IN ('LIVE') RETURNING booking_id`, flips booking `LIVEâ†’COMPLETED`, then calls `disburseMissionPayout()` (Audit C1 inline even-split credit + `mission_payouts` insert). **This inline disburse is exactly what must be REMOVED from the Finish path** (replaced by opening `PENDING_RELEASE`).
- Current admin settlement (verified, `ops.service.ts completeBooking`, lines ~1079â€“1372): conditional `UPDATE lite_bookings SET status='COMPLETED' WHERE id=$1 AND status='LIVE' RETURNING id` (loser sees 0 rows â†’ throws), `assertRegionScope(admin, region_code)`, resolves crew via `cpoAssign.getCrewForPayout`, even-split of `Math.round(Number(total_eur))`, per-officer override/deduction validation, aggregates per payee, `wallet.creditForBooking(payeeId, bookingId, sum, ...)` (idempotent on `ux_wallet_tx_payout`), writes `mission_payouts (mission_id, booking_id, agent_user_id, payee_user_id, call_sign, proposed_credits, paid_credits, deduction_credits, deduction_reason, decided_by)` `ON CONFLICT (mission_id, agent_user_id) DO NOTHING`, `platformFee = escrow - totalPaid`, releases pool, dissolves the conversation group (DELETE `conversation_members WHERE role='member'`, title `Â· COMPLETED`), bumps `agents.jobs_total + duty_hours_mtd`, broadcasts a summary, audits via `OpsAuditService.recordAdmin` + `.emit`. **This whole block is what `SettlementService.settle(...)` must own.**
- Mission FSM (verified `mission-state-machine.service.ts`): `DISPATCHED â†’ PICKUP â†’ LIVE â†’ COMPLETED` (AGENT actor for each forward step); `SOS` reachable from PICKUP/LIVE; `ABORTED` is the Ops/Admin escape. Lead-gated forward moves go through the AGENT actor.
- Proof-of-completion gate (Â§40) â€” all server-side, read from data already collected:
  | Check | Rule | Source |
  |---|---|---|
  | Real progression | mission actually went `DISPATCHEDâ†’PICKUPâ†’LIVE` via the lead-gated FSM | mission FSM / `missions.started_at` + audit |
  | Reached pickup | â‰¥1 GPS ping within `ARRIVAL_RADIUS_M` of `pickup_lat/lng` | `mission_telemetry_last` (booking-keyed) / `mission_telemetry` history |
  | Telemetry coverage | â‰¥ `MIN_PINGS` GPS pings during LIVE (not a 30-second "live") | `mission_telemetry` (per-push history, `mission_id`,`recorded_at`) |
  | Min on-task time | LIVE duration â‰¥ `MIN_ONTASK_SECONDS` | mission timestamps (`started_at`/PICKUPâ†’LIVEâ†’now) |
  | Identity handshake | arrival code/photo confirm happened (or was offered) | LB12 verify-code (if Step for it exists; else treat as "offered") |
  - **PASS** â†’ `escrow_holds.status='PENDING_RELEASE'`, `completed_at=NOW()`, `release_eligible_at = NOW() + disputeWindow(trustTier)`. **No money moves.**
  - **FAIL** â†’ mission still marked COMPLETED operationally, but `escrow_holds.review_required=TRUE`; do NOT open auto-release. Emit metric `dispatch_completion_gate_fail_total{reason}`.
- Geo data (verified): `lite_bookings.pickup_lat/lng` + `dropoff_lat/lng`; telemetry tables `mission_telemetry_last` (PK `booking_id`, last fix) and `mission_telemetry` (history, `mission_id`,`recorded_at DESC`).
- One-lead invariant (verified): a partial unique index already exists â€” `mission_crew_one_lead_per_team ON mission_crew(mission_id, team_idx) WHERE is_lead=TRUE`. The plan asks to enforce "one is_lead per mission" â€” confirm whether the per-team index is sufficient or whether a per-mission partial unique index (`ON mission_crew(mission_id) WHERE is_lead=TRUE`) is also wanted; do NOT silently weaken the existing one.
- `escrow_holds` columns available (Step 8): `completed_at`, `release_eligible_at`, `review_required BOOLEAN DEFAULT FALSE`, `status`, plus the partial index `escrow_release_due ON escrow_holds(release_eligible_at) WHERE status='PENDING_RELEASE'`.
- Trust tier: `agents` has `rating` (and `jobs_total`); a `tier` column may NOT exist â€” verify before relying on it. `disputeWindow(tier)` computed at completion (e.g. new/low-rating â†’ 72 h; established/high-rating â†’ short). Constants `ARRIVAL_RADIUS_M`, `MIN_PINGS`, `MIN_ONTASK_SECONDS`, `DISPUTE_WINDOW_SECONDS` config-driven.

**Files to touch:**

- NEW `apps/auth-service/src/ops/settlement.service.ts` â€” `SettlementService.settle(bookingId, actor: {kind:'admin'|'lead'; userId; admin?: AdminContext}, body?)`. Owns the extracted settlement core (paired escrowâ†’agency + escrowâ†’platform-fee moves, `mission_payouts`, group dissolve, stats bump, broadcast, audit). For the Finish (lead) path this is NOT called at completion â€” it is called later by the release sweep (Step 11). Extract so both the admin path and the eventual release path share one implementation.
- EXTEND `apps/auth-service/src/ops/ops.service.ts` â€” `completeBooking` now delegates its settlement core to `SettlementService.settle(bookingId, {kind:'admin', admin})`. Keep the region-scope + conditional `LIVEâ†’COMPLETED` pin.
- EXTEND `apps/auth-service/src/agents/agent.service.ts` â€” `missionComplete()` / `flipMissionStatus(... 'COMPLETED' ...)`: REMOVE the inline `disburseMissionPayout()` call; instead, after the conditional `UPDATE missions ... status='COMPLETED' WHERE ... status='LIVE'` and `lite_bookings LIVEâ†’COMPLETED`, run the proof gate and set the `escrow_holds` row to `PENDING_RELEASE`(+`release_eligible_at`,`completed_at`) on PASS or `review_required=TRUE` on FAIL. NO `creditForBooking` here.
- NEW `apps/auth-service/src/ops/proof-of-completion.service.ts` (or a method on SettlementService) â€” `runProofGate(bookingId, missionId): {pass: boolean; reasons: string[]}` reading the five checks.
- EXTEND `apps/auth-service/src/agents/agent.controller.ts` â€” the route already exists: `@Post('me/missions/:missionId/complete')` `@HttpCode(200)` `@UseInterceptors(IdempotencyInterceptor)` under `@UseGuards(JwtAuthGuard)`. Confirm the lead-gate stays (`requireLead` via the `mission_crew.is_lead` check). The plan names it `POST /agents/me/missions/:id/complete` â€” same route.
- NEW migration `supabase/migrations/<ts>_one_lead_per_mission.sql` ONLY if a per-mission (not per-team) lead index is required â€” additive, `CREATE UNIQUE INDEX IF NOT EXISTS ... WHERE is_lead=TRUE`.
- EXTEND a metrics module (existing prom/metric helper if present) for `dispatch_completion_gate_fail_total{reason}`.

**Backend how-to:**

- Lead Finish, race-safe, in `withTransaction`:
  ```sql
  -- lead gate (verified existing pattern)
  SELECT is_lead FROM mission_crew WHERE mission_id=$1 AND agent_id=$2;  -- !rowâ†’not_assigned; !is_leadâ†’lead_only
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
- Proof gate queries (read-only): progression = `missions.started_at IS NOT NULL` + an audit/FSM trace through PICKUPâ†’LIVE; reached-pickup = haversine (or PostGIS `ST_DWithin` if Step for geo landed) between `mission_telemetry_last`/`mission_telemetry` fixes and `lite_bookings.pickup_lat/lng` â‰¤ `ARRIVAL_RADIUS_M`; coverage = `SELECT count(*) FROM mission_telemetry WHERE mission_id=$1 AND recorded_at BETWEEN <live_start> AND <now>` â‰¥ `MIN_PINGS`; on-task = `now - live_start` â‰¥ `MIN_ONTASK_SECONDS`; identity = the verify-code row (or "offered"). Collect failing reasons â†’ metric.
- `disputeWindow(tier)`: read `agents.rating` (and `tier` if it exists â€” verify) for the agency/lead; map to seconds via config; default to a safe long window if no tier.
- `SettlementService.settle` is the lift-and-shift of the Â§completeBooking body (verified above): take `actor.kind` to pick region-scope assertion (admin) vs. system (release). Keep all idempotency: `wallet.creditForBooking` (idempotent on `ux_wallet_tx_payout`), `mission_payouts ON CONFLICT (mission_id, agent_user_id) DO NOTHING`. **At Finish, settle() is NOT called** â€” money waits for the Step 11 release sweep.
- Idempotency: the Finish route already wraps `IdempotencyInterceptor`; the conditional UPDATEs make it internally race-safe regardless.

**Frontend / ops-console how-to:**

- Mobile shared stepper (D8): the lead sees a one-tap **Finish** at the LIVE step; non-lead crew see status only (read-only). On tap, call `POST /agents/me/missions/:missionId/complete` with an `Idempotency-Key` (e.g. `complete:<missionId>`). After success show "Completed Â· awaiting release" (NOT "Paid"). If the gate failed, the UX is still "Completed" â€” the review/hold state is internal; do not surface "your job failed proof" to the lead.
- Ops-console mission/booking view: show the hold state (`HELD`/`PENDING_RELEASE`/`review_required`) so an operator can see what's awaiting release vs. flagged for review.

**Security stop-conditions:** Wallet/ledger + mission-state only â€” **no crypto/E2E/auth changes**. The group dissolve reuses the existing `conversation_members`/`conversations` server-side metadata path (already in `completeBooking`); do NOT touch group keys or sender-keys. Never log telemetry coordinates as plaintext beyond aggregate counts in metrics (the log-audit test enforces no plaintext/keys). Do NOT add a "skip the proof gate in dev" branch â€” the gate is a trust control. The lead-gate (`is_lead`) must not be weakened. If extraction tempts you to change the Ops Room teardown semantics or push payload, STOP and verify against the System Architecture Documentation.

**Acceptance & tests:**

- New tests (ops + agent specs): (1) lead Finish with passing proof â†’ mission COMPLETED, `escrow_holds.status='PENDING_RELEASE'` with `release_eligible_at` set, **no `creditForBooking` call, no `mission_payouts` row, no agency wallet delta**. (2) lead Finish with FAILING proof (zero telemetry / never reached pickup) â†’ mission COMPLETED, `review_required=TRUE`, NOT `PENDING_RELEASE`, no payout, `dispatch_completion_gate_fail_total{reason}` incremented. (3) non-lead crew tap â†’ `lead_only`; non-crew â†’ `not_assigned_to_mission`. (4) admin `completeBooking` still works via `SettlementService.settle({kind:'admin'})` â€” same payouts/deductions as before (regression: the existing `ops.service` completion specs must still pass). (5) double-tap Finish (idempotent) â†’ one transition, one hold update.
- Regression: re-run the existing `ops.service.concurrency.spec.ts`, `mission-state-machine.service.spec.ts`, and any `completeBooking`/payout spec; they must stay green after the extraction.
- Gates: `npm test -- --selectProjects=booking` + the auth-service jest run for ops/agents specs; `npm run lint`; `npm run typecheck` (â‰¤96) and `cd apps/ops-console && npm run typecheck`. Manual smoke: run a mission to LIVE, lead taps Finish, verify NO wallet movement and the hold flips to `PENDING_RELEASE`.
- Never commit on red; never `--no-verify`.

**Done when:**

- [ ] `SettlementService.settle(bookingId, actor)` exists and owns the settlement core; admin `completeBooking` delegates to it; payouts/deductions unchanged for admin.
- [ ] Lead Finish removes the inline disburse â€” Finish moves NO money.
- [ ] Proof gate runs server-side; PASS â†’ `PENDING_RELEASE`+`release_eligible_at`; FAIL â†’ `review_required`, never auto-pays; metric emitted.
- [ ] One-lead invariant enforced (existing per-team index confirmed sufficient or per-mission index added â€” not weakened).
- [ ] Idempotency-Key on `complete` route; conditional `LIVEâ†’COMPLETED` race-safe.
- [ ] New + regression tests, typecheck (both), lint green.

---

## Step 11 â€” Dispute window, release sweep, refund/pro-rata/cancel-fee matrix, FX

**Stage:** Money Â· **Depends on:** Step 9 (escrow `HELD`), Step 10 (`SettlementService.settle`, `PENDING_RELEASE`/`review_required`, proof gate), Step 8 (escrow + `booking_disputes` schema) Â· **Resolves:** Part V Â§41 / Â§42 / Â§39.3-4, LB6, LB5/LB9, PV5/PV6/PV7, payments P1s
**Goal (plain English):** After the lead taps Finish, the customer gets a window to flag a problem; if they stay silent, the money releases to the agency on its own (a safe background timer pays it out). If the customer flags it, the money freezes and a staff member decides the split â€” and can even pull money back from the agency if it was paid by mistake. We also make cancels and early-aborts pay out fairly (full refund before the job starts, a fee-share if cancelled late, a worked-share split if ended mid-job) instead of always refunding everything. Finally, money is shown in the right currency.
**Why it matters / what breaks without it:** Without the release sweep nothing ever pays the agency after Finish; without the dispute path a fake completion can never be reversed; without the refund/pro-rata matrix the current abort code (verified: full `refundForBooking` against the OLD `cpo_pool`/`booking_cpo_assignments` tables) always full-refunds and never credits the agency for work done or frees crew capacity; without FX, SAR/BDT/GBP holds are mis-valued (the existing `computeCreditsForFiat` only handles usd/aed/eur).

**Self-contained context (inline â€” do not make the reader open the plan):**

- LOCKED DECISIONS: D1 = admin is the exception path (the single place a human stays in the money loop is dispute `resolve`). D2 = released only after the dispute window + proof. D6 = agency runs concurrent missions bounded by FREE CPO capacity (so an abort must free capacity).
- Money state machine (Â§37): `PENDING_RELEASE â†’ {RELEASED | DISPUTED}`; `DISPUTED â†’ {RELEASED | REFUNDED | PARTIAL}`; `HELD â†’ {REFUNDED | PARTIAL | PENDING_RELEASE}`. `RELEASED`/`REFUNDED` terminal. ENUM `escrow_hold_status=('HELD','PENDING_RELEASE','RELEASED','REFUNDED','PARTIAL','DISPUTED')`.
- `escrow_holds` cols (Step 8): `status`, `release_eligible_at`, `completed_at`, `settled_at`, `to_provider_credits`, `to_client_credits`, `platform_fee_credits`, `basis` (`full_release|pro_rata|refund|partial|clawback`), `review_required`. Index `escrow_release_due ON escrow_holds(release_eligible_at) WHERE status='PENDING_RELEASE'`.
- `booking_disputes` cols (Step 8): `booking_id`, `raised_by`(=client), `category`(`not_performed|left_early|wrong_guard|conduct|billing`), `reason`, `status`(`open|upheld|rejected|resolved`), `to_client_credits`, `to_provider_credits`, `decided_by`(admin), `created_at`, `decided_at`. ADD a **partial unique index** for one OPEN dispute per booking: `CREATE UNIQUE INDEX ux_one_open_dispute ON booking_disputes(booking_id) WHERE status='open'`.
- Endpoints (Â§41):
  | Endpoint | Who | Purpose |
  |---|---|---|
  | `POST /bookings/:id/confirm-complete` | client | confirm early â†’ release NOW (same as the sweep, immediately) |
  | `POST /bookings/:id/dispute` | client `{category,reason}` | `escrow_holds.status='DISPUTED'`, freeze release, INSERT `booking_disputes` |
  | `GET /bookings/:id/escrow` | client/agency | show hold state + (final) split for the receipt/UI |
  | `POST /ops/disputes/:id/resolve` | admin `{to_client,to_provider,penalty?,reason}` | final paired ledger moves + clawback + `decided_by` + audit |
  - `dispute` valid ONLY while `PENDING_RELEASE` (not after `RELEASED`). Client-owns-booking check (`WHERE client_id=$client`).
  - `resolve` is the one admin-in-the-loop point (D1): final paired moves, records `decided_by`, audits via `OpsAuditService.recordAdmin`+`.emit`.
  - **Clawback:** if a dispute is upheld AFTER an erroneous release, `resolve` debits the agency wallet and refunds the client; if the agency balance is short, flag a negative-balance recovery (withhold future payouts).
- Three Redis-locked sweeps (Â§42), each copying the verified `payment-pending-expiry.service.ts` pattern (NOT `@nestjs/schedule`, because auth-service is multi-replica): `setInterval` â†’ `redis.client.set(LOCK_KEY, ts, 'PX', LOCK_TTL_MS, 'NX')` â†’ if not `'OK'` skip â†’ batch `SELECT â€¦ LIMIT 50` â†’ per-row `withTransaction` + `SELECT â€¦ FOR UPDATE` + conditional `UPDATE â€¦ WHERE <state>` â†’ `finally del(LOCK_KEY)`. The sweeps:
  1. **Crew-assign SLA sweep** (LB5): `escrow_holds.status='HELD'` + booking past `crew_deadline_at` + NO mission â†’ one txn: `escrowâ†’client` full refund (`refundForBooking`), `escrow_holds.status='REFUNDED'`, booking `â†’ AGENCY_NO_SHOW`, offer `SUPERSEDED`, agency `reliability_breaches++`, push client (optional auto-re-dispatch).
  2. **Release sweep**: `status='PENDING_RELEASE' AND release_eligible_at < NOW() AND NOT review_required AND no open dispute` â†’ call `SettlementService.settle(bookingId, {kind:'system'})`: `escrowâ†’agency` payout + `escrowâ†’platform` fee, write `mission_payouts`, bump `agents.jobs_total`, dissolve group, `status='RELEASED'`, `basis='full_release'`.
  3. **Reconciliation sweep (daily)**: assert the money invariant (Â§43) and alert on drift.
- Money invariant (Â§43): for each booking `sum(client debits) == held`; at terminal `held == to_provider + to_client + platform_fee`; NO agency credit row may exist before `release_eligible_at` (or an early client confirm / dispute resolve). Concurrency rule: release sweep vs client dispute firing together â†’ **dispute wins (freeze), no payout** (enforced by the conditional `UPDATE â€¦ WHERE status='PENDING_RELEASE'` â€” whichever flips first wins; dispute flips to `DISPUTED`, so the release `WHERE status='PENDING_RELEASE'` matches 0 rows).
- Termination â†’ refund matrix (Â§39.3-4, LB6) â€” operate on **`mission_crew`, NOT the old pool tables**:
  - Pre-LIVE abort/cancel â†’ FULL refund (`escrowâ†’client`), `escrow_holds.status='REFUNDED'`, `basis='refund'`.
  - Cancel AFTER grace (agency already committed crew) â†’ `PARTIAL`: `escrowâ†’client` minus a cancellation fee; the fee â†’ agency via the settlement path; `basis='partial'`.
  - Abort / SOS-end DURING LIVE â†’ `PARTIAL` pro-rata against minutes actually on task: `escrowâ†’client` unworked share, `escrowâ†’agency` worked share (+ platform fee), `basis='pro_rata'`; **AND free capacity via `mission_crew`** (not `cpo_pool`).
  - CURRENT CODE TO REPLACE (verified `ops.service`/`mission.service` abort): it does an unconditional `wallet.refundForBooking(client, bookingId, ...)` when `payment_captured`, and releases crew via `UPDATE cpo_pool SET availability='available' WHERE id IN (SELECT cpo_id FROM booking_cpo_assignments WHERE booking_id=$1)`. Both must move to the escrow matrix + `mission_crew`.
- FX: `wallet.service.ts computeCreditsForFiat(amount, currency)` (verified, lines 688â€“698) only maps `usd` (1:1Ã—perUsd), `aed` (/3.67), `eur` (Ã—1.08); SAR/BDT/GBP fall through to the `amount` (1:1) default â†’ wrong. Add SAR/BDT/GBP rates and **stamp the fx rate + currency on each `wallet_transactions` row** so a refund reverses at the SAME rate it was held at (avoid round-trip FX drift). Regions are AE/SA/BD/GB (D4).

**Files to touch:**

- EXTEND `apps/auth-service/src/wallet/wallet.service.ts` â€” extend `computeCreditsForFiat` with `sar`/`bdt`/`gbp` rates; add fx-rate + currency stamping into the ledger metadata on hold/refund/payout rows (so reversals use the stored rate). Verify `refundForBooking` (idempotent on `ux_wallet_tx_booking_refund`) is reused for escrowâ†’client refunds.
- NEW `apps/auth-service/src/booking/escrow-release-sweep.service.ts` â€” sweep #2 (copy `payment-pending-expiry.service.ts`; LOCK_KEY `lock:escrow-release`). Calls `SettlementService.settle({kind:'system'})`.
- NEW `apps/auth-service/src/booking/crew-sla-sweep.service.ts` â€” sweep #1 (LOCK_KEY `lock:crew-sla`).
- NEW `apps/auth-service/src/booking/escrow-reconciliation.service.ts` â€” sweep #3, daily; asserts the money invariant + alerts.
- EXTEND `apps/auth-service/src/booking/booking.controller.ts` â€” add `@Post(':id/confirm-complete')`, `@Post(':id/dispute')`, `@Get(':id/escrow')` under existing `@Controller('bookings')` `@UseGuards(JwtAuthGuard)`; the two POSTs get `@UseInterceptors(IdempotencyInterceptor)` (mirror `pay-with-credits`).
- EXTEND `apps/auth-service/src/booking/booking.service.ts` â€” `confirmComplete(clientId, bookingId)`, `dispute(clientId, bookingId, {category,reason})`, `getEscrow(userId, bookingId)`.
- EXTEND `apps/auth-service/src/ops/ops.controller.ts` â€” add `@Post('disputes/:id/resolve')` `@RequireRoles('SUPERVISOR','ADMIN')` `@UseInterceptors(IdempotencyInterceptor)` under existing `@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard)`.
- EXTEND `apps/auth-service/src/ops/ops.service.ts` (or `settlement.service.ts`) â€” `resolveDispute(disputeId, admin, {to_client,to_provider,penalty?,reason})` incl. clawback; reuse `OpsAuditService`.
- EXTEND `apps/auth-service/src/ops/mission.service.ts` â€” REPLACE the abort refund/release: pro-rata matrix on `escrow_holds` + free capacity via `mission_crew` (drop the `cpo_pool`/`booking_cpo_assignments` refund path for dispatched-via-crew missions; keep legacy-pool fallback only if old bookings need it).
- EXTEND the abort/cancel paths to compute on-task minutes (use `missions.started_at`/LIVE timestamps) for pro-rata.
- NEW migration `supabase/migrations/<ts>_dispute_open_unique.sql` â€” `CREATE UNIQUE INDEX IF NOT EXISTS ux_one_open_dispute ON booking_disputes(booking_id) WHERE status='open';` and (if needed) `AGENCY_NO_SHOW` booking status + `agents.reliability_breaches` + `lite_bookings.crew_deadline_at`/`dispute_window_seconds` columns (verify which already exist from the dispatch track).
- EXTEND `apps/auth-service/src/booking/booking.module.ts` (and/or ops module) â€” register the three sweep services as providers.

**Backend how-to:**

- Client dispute (race-safe; freeze beats release):
  ```sql
  -- in withTransaction
  SELECT eh.status FROM escrow_holds eh JOIN lite_bookings b ON b.id=eh.booking_id
    WHERE eh.booking_id=$1 AND b.client_id=$2 FOR UPDATE;          -- ownership + lock
  -- must be 'PENDING_RELEASE' else throw dispute_not_allowed
  UPDATE escrow_holds SET status='DISPUTED' WHERE booking_id=$1 AND status='PENDING_RELEASE' RETURNING id;
  -- 0 rows â†’ lost to a release/terminal â†’ throw
  INSERT INTO booking_disputes (booking_id, raised_by, category, reason, status)
    VALUES ($1,$2,$cat,$reason,'open');   -- ux_one_open_dispute prevents a 2nd open dispute
  ```
- Client confirm-early: same as the release sweep body but immediate â€” conditional `UPDATE escrow_holds SET status='RELEASED' WHERE booking_id=$1 AND status='PENDING_RELEASE' AND NOT review_required` then `SettlementService.settle({kind:'system'})`; ownership `WHERE client_id=$client`.
- Release sweep (#2) per-row:
  ```sql
  SELECT id, booking_id FROM escrow_holds
    WHERE status='PENDING_RELEASE' AND release_eligible_at < NOW() AND NOT review_required
      AND NOT EXISTS (SELECT 1 FROM booking_disputes d WHERE d.booking_id=escrow_holds.booking_id AND d.status='open')
    ORDER BY release_eligible_at ASC LIMIT 50;
  -- per row, in withTransaction:
  SELECT status FROM escrow_holds WHERE booking_id=$1 FOR UPDATE;        -- re-check under lock
  UPDATE escrow_holds SET status='RELEASED', basis='full_release', settled_at=NOW()
    WHERE booking_id=$1 AND status='PENDING_RELEASE' RETURNING id;       -- 0 rows (disputed) â†’ skip
  -- then SettlementService.settle(bookingId,{kind:'system'}) â†’ escrowâ†’agency + escrowâ†’platform fee,
  -- mission_payouts, jobs_total++, dissolve group.
  ```
- Crew-SLA sweep (#1) per-row: `SELECT` `HELD` holds whose booking `crew_deadline_at < NOW()` and no `missions` row; in txn â†’ `refundForBooking(client,...)`, `UPDATE escrow_holds SET status='REFUNDED', basis='refund'`, booking `â†’AGENCY_NO_SHOW`, offer `SUPERSEDED`, `UPDATE agents SET reliability_breaches=reliability_breaches+1`, push.
- Dispute resolve (admin): validate the dispute is `open`, the hold is `DISPUTED` (or `RELEASED` for clawback). Final paired moves: e.g. `escrowâ†’client` `to_client`, `escrowâ†’provider` `to_provider` (+ platform fee remainder); set `escrow_holds.status` to `REFUNDED`/`PARTIAL`/`RELEASED` + `to_*_credits` + `basis`. Clawback when already `RELEASED`: debit agency wallet (`debitForBooking` or a ledger debit), `refundForBooking(client)`; if agency short â†’ flag negative-balance recovery. Record `booking_disputes.status='upheld'|'rejected'|'resolved'`, `decided_by=admin.user_id`, `decided_at=NOW()`. Audit.
- Abort/cancel matrix (mission.service): determine phase from mission/booking status. Pre-LIVE â†’ full `refundForBooking` + `escrow_holds REFUNDED`/`basis='refund'`. Post-grace cancel â†’ `escrowâ†’client` minus fee, fee â†’ agency via settle, `PARTIAL`/`basis='partial'`. Mid-LIVE abort/SOS-end â†’ compute worked minutes from `started_at`â†’now (cap sane), split `to_client`/`to_provider`, `PARTIAL`/`basis='pro_rata'`. Free capacity: `UPDATE mission_crew SET status='off' WHERE mission_id=$1` (verify the column/value vs. existing `active|sos|standby|off`) instead of touching `cpo_pool`.
- Reconciliation sweep (#3, daily): for a batch of recent bookings assert `sum(client debits)==held` and terminal `held==to_provider+to_client+platform_fee`; log + alert on drift (no mutation).
- All sweeps register via `OnModuleInit`/`OnModuleDestroy` `setInterval` with their own LOCK_KEY + LOCK_TTL shorter than the interval (copy the verified pattern). Expose a `sweepOnce()` public for tests.

**Frontend / ops-console how-to:**

- Mobile client: after a mission shows "Completed Â· awaiting release," show a **dispute window countdown** with two actions â€” "Confirm complete" (`POST /bookings/:id/confirm-complete`) and "Report a problem" (`POST /bookings/:id/dispute` with a `{category}` picker from `not_performed|left_early|wrong_guard|conduct|billing` + free-text `reason`). Both send an `Idempotency-Key`. Use `GET /bookings/:id/escrow` to render the receipt/hold state + final split.
- Ops-console: a Disputes queue (open disputes) with a resolve form `{to_client, to_provider, penalty?, reason}` â†’ `POST /ops/disputes/:id/resolve` (Idempotency-Key). Show hold status + `basis` on the booking detail. Surface `review_required` holds so an operator adjudicates flagged completions.

**Security stop-conditions:** Wallet/ledger + booking/mission state only â€” **no crypto/E2E/auth-primitive changes**. Group dissolve in the release path reuses the existing server-side `conversation_members`/`conversations` metadata teardown (from `completeBooking`); do NOT touch group keys/sender-keys. Never log dispute free-text `reason`, client PII, telemetry coordinates, or key bytes (the static log-audit test enforces no plaintext/keys). Do NOT add a "skip the dispute window in dev" or "auto-release ignoring review_required" branch. The client-owns-booking check (`WHERE client_id=$client`) and the admin `RequireRoles` guard on resolve must not be weakened. The FX rates feed real money â€” get the SAR/BDT/GBP rates signed off (CFO/billing) and stamp them so reversals can't drift; if FX touches anything beyond the credit math, STOP and verify against the System Architecture Documentation.

**Acceptance & tests:**

- New tests (booking + ops + wallet specs): (1) Release sweep: `PENDING_RELEASE` past `release_eligible_at`, no dispute, not review_required â†’ released ONCE (escrowâ†’agency + escrowâ†’platform fee, `mission_payouts` written, `jobs_total++`); a second sweep pass is a no-op. (2) Concurrency: release sweep vs dispute firing together â†’ dispute wins, hold `DISPUTED`, NO payout (the conditional `WHERE status='PENDING_RELEASE'` proves it). (3) Dispute only valid in `PENDING_RELEASE`; a second open dispute â†’ unique-index violation; non-owner client â†’ rejected. (4) Resolve: paired moves split correctly; clawback when already `RELEASED` debits agency + refunds client; `decided_by` recorded; audited. (5) Crew-SLA sweep: `HELD` past deadline, no mission â†’ full refund, `REFUNDED`, booking `AGENCY_NO_SHOW`, `reliability_breaches++`, idempotent (re-run = no double refund â€” `refundForBooking` is idempotent). (6) Matrix: pre-LIVE abort â†’ full refund; post-grace cancel â†’ partial (feeâ†’agency); abort mid-LIVE â†’ pro-rata split + `mission_crew` capacity freed (verify the crew row is no longer counted as busy). (7) FX: a BDT (and GBP) hold + refund reverse EXACTLY at the stamped rate (no drift); `computeCreditsForFiat` returns the right credits for sar/bdt/gbp. (8) Money invariant holds across all of the above; reconciliation sweep flags an injected imbalance.
- Regression: re-run `ops.service.concurrency.spec.ts`, the abort/mission specs, and the Step 10 settlement specs; the admin `completeBooking` path must still pass.
- Gates: `npm test -- --selectProjects=booking` + the auth-service ops/wallet specs; `npm run lint`; `npm run typecheck` (â‰¤96) and `cd apps/ops-console && npm run typecheck`. Manual smoke: finish a mission, let the window elapse â†’ released once; separately finish, dispute â†’ frozen, resolve in ops â†’ correct split; abort a LIVE mission â†’ pro-rata + crew freed.
- Never commit on red; never `--no-verify`.

**Done when:**

- [ ] Release sweep, crew-SLA sweep, and daily reconciliation sweep all run on the Redis `SET NX`-locked `setInterval` pattern (multi-replica safe), each with `sweepOnce()` for tests.
- [ ] `confirm-complete`, `dispute`, `GET escrow`, and admin `disputes/:id/resolve` endpoints exist with the right guards + Idempotency-Key; one-open-dispute index added; dispute only in `PENDING_RELEASE`; client ownership enforced.
- [ ] Dispute wins any race with the release sweep (no payout when frozen); resolve does final paired moves + clawback + `decided_by` + audit.
- [ ] Abort/cancel refund matrix runs on `mission_crew` (pre-LIVE full / post-grace partial / mid-LIVE pro-rata) and frees crew capacity; the old `cpo_pool`/`booking_cpo_assignments` full-refund path is replaced.
- [ ] FX covers SAR/BDT/GBP and stamps the rate so refunds reverse exactly; money invariant asserted in tests + reconciliation.
- [ ] New + regression tests, typecheck (both), lint green.

---

## Step 12 â€” Ops Room group-key distribution under auto-dispatch (agency device owns the rekey)

**Stage:** Comms & crew Â· **Depends on:** Step 6 (accept opens the Ops Room with client+agency only), Step 11 (`POST /org/bookings/:id/crew` exists), Step 13 (crew-assign is the caller of the enqueue) Â· **Resolves:** Part I Â§6 (corrected), Part II Â§24 step 3, Part III correction #5, **LB2** (P0)
**Goal (plain English):** When an agency adds its guards (CPOs) to a job, those guards must be able to read the encrypted Ops Room chat. The server cannot hand out the chat's encryption key â€” only a real device that already holds the key can. So we make the _agency's own phone_ the owner of each Ops Room, and we add a tiny "to-do list" the server gives that phone ("add guard X to room Y") which the phone drains and acts on, re-keying the group so the new guard can decrypt going forward (and a removed guard cannot decrypt anything new).
**Why it matters / what breaks without it:** Without this, assigned CPOs join the room as metadata only and see _nothing_ â€” the chat is dead for the crew, which is the whole point of the Ops Room during a live protection mission. This is a P0 launch-blocker.
**Self-contained context (inline â€” do not make the reader open the plan):**

- **The hard constraint (security-reviewed):** The relay/server holds **no group master key**. `apps/auth-service/src/conversations/conversations.service.ts addMember()` (line 168) only writes a `conversation_members` metadata row (`role='member'`); it does **not** distribute the Signal group key. The only thing that can rekey is a member device, via the mobile runtime: `getMessengerRuntime('production').addGroupMember({groupId, newMember:{userId, deviceId:1}})` (`src/modules/messenger/runtime/productionRuntime.ts:2663`), which wraps `planAddAndRekey` from `@bravo/messenger-core` (epoch E `add` â†’ epoch E+1 fresh master key; the new member can decrypt only from this point forward â€” Signal forward-secrecy contract).
- **The existing serverâ†’device intent mechanism covers ONLY department channels, not booking rooms.** `src/modules/messenger/orgWorkspace/membershipIntents.ts drainMembershipIntents()` reads `departmentApi.listMembershipIntents()` â†’ for each pending intent calls `runtime.addGroupMember`/`removeGroupMember` â†’ acks **only after** the rekey broadcast succeeds (at-least-once; never ack on failure). The server side is `apps/auth-service/src/department/department.service.ts` (`enqueueIntent` â†’ `channel_membership_intents`, `listMembershipIntents`, `ackMembershipIntent`) exposed by `department.controller.ts` (`GET /department/membership-intents`, `POST /department/membership-intents/:intentId/ack`). **This is for `department_channels` â€” it has no path for `conversations`-scoped (booking Ops Room) rooms.** Step 12 builds the parallel mechanism for booking conversations.
- **The room owner today is wrong for this flow.** `ensureBookingOpsRoom` (`apps/auth-service/src/ops/system-messenger.service.ts:228`) currently creates the conversation with `creator = ops_admin_user_id` and the plan's Step 6 passed `SystemMessengerService.SYSTEM_USER_ID` (`00000000-0000-0000-0000-000000000001`). The SYSTEM/admin user is a server-side metadata author that holds **no key** â€” so it cannot be the rekey admin. For auto-dispatch the **agency company-agent device must be the room creator/admin/owner** so it (and only it) can run `addGroupMember`.
- **What Step 13 enqueues:** `POST /org/bookings/:id/crew` (Step 13) must, after creating the mission + `mission_crew`, enqueue one _add-intent per assigned CPO_ into the new booking-scoped intent table; the agency device drains them on focus and runs `planAddAndRekey`.
  **Files to touch:**
- **NEW migration** `supabase/migrations/<ts>_dispatch_room_intents.sql` â€” create `dispatch_room_intents` table (mirror `channel_membership_intents`).
- **EXTEND** `apps/auth-service/src/ops/system-messenger.service.ts` â€” `ensureBookingOpsRoom(...)`: for auto bookings make the **agency company-agent user** the `creator`/admin (so add `creator_user_id`/`admin_user_id` to args, defaulting to the provider user id; do NOT pass SYSTEM as creator on the auto path). Keep the metadata-only first-card broadcast.
- **NEW** `apps/auth-service/src/dispatch/dispatch-room-intents.service.ts` (or extend the dispatch module): `enqueueRoomAddIntent(bookingId, conversationId, memberUserId, requestedBy)`, `listRoomIntents(agencyUserId)`, `ackRoomIntent(agencyUserId, intentId)` â€” copied 1:1 from `department.service.ts` intent methods but scoped to the booking conversation + the agency org.
- **NEW/EXTEND controller** `apps/auth-service/src/dispatch/dispatch.controller.ts` â€” `GET /dispatch/room-intents` and `POST /dispatch/room-intents/:intentId/ack` (JWT + OrgManagerGuard; scoped to caller's org).
- **NEW** `src/modules/messenger/orgWorkspace/dispatchRoomIntents.ts` â€” `drainDispatchRoomIntents()`, a near-exact copy of `drainMembershipIntents()` but calling `dispatchApi.listRoomIntents()/ackRoomIntent()` and `runtime.addGroupMember({groupId: intent.conversation_id, newMember:{userId, deviceId:1}})`.
- **EXTEND** `src/services/api.ts` â€” add `dispatchApi.listRoomIntents()` / `dispatchApi.ackRoomIntent(id)`.
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
- `listRoomIntents(agencyUserId)`: `SELECT id, booking_id, conversation_id, member_user_id, action, created_at FROM dispatch_room_intents WHERE org_user_id = $1 AND state = 'pending' ORDER BY created_at ASC`. Scope to the caller's `manager.org_user_id` (from `OrgManagerGuard` / `assertOrgScope`) â€” never a path param.
- `ackRoomIntent` = race-safe conditional UPDATE (mirror `department.service.ts:250`):

```sql
UPDATE dispatch_room_intents
   SET state='done', settled_at=NOW()
 WHERE id=$1 AND state='pending' AND org_user_id=$2
 RETURNING id;
```

0 rows â†’ `404 intent_not_found_or_not_org`. Only ack **after** the device confirms the rekey broadcast landed (the drain function does this).

- `ensureBookingOpsRoom`: on the auto path, pass the **agency company-agent user id** as the creator so `conversations.service.create()` stamps them admin; that device is then authorized to call `addGroupMember`. STOP/verify (below) before finalizing the creator choice.
  **Frontend / ops-console how-to:**
- `drainDispatchRoomIntents()` â€” copy `membershipIntents.ts` exactly: skip intents whose group isn't bootstrapped, `await runtime.addGroupMember(...)`, ack **only on success**, leave pending on throw (at-least-once retry). `addGroupMember`/`removeGroupMember` are idempotent-safe to retry (already-in/out throws and stays pending).
- Wire the drain into the agency app's focus hook (same trigger pattern department channels use). The drain runs **on the agency company-agent device** only (it owns the room key).
  **Security stop-conditions:** This step is squarely on the E2EE stop-condition line. **STOP / verify against the System Architecture Documentation before coding:** (a) that `SYSTEM_USER_ID`/admin **may not** be the group-key admin and the **agency company-agent device** is the correct room creator/owner for a clientâ†”agencyâ†”CPO room; (b) that the add path **advances the epoch** via `planAddAndRekey` (epoch E+1, fresh master key) so the new CPO can decrypt only from join-forward; (c) that a **removed** CPO (future remove-intent) cannot decrypt new messages after the corresponding rekey. Never write message envelopes or touch sender-key distribution from the server; the server only ever writes the `conversation_members` metadata row + the intent queue. Never log group ids paired with key bytes (static log-audit test enforces this).
  **Acceptance & tests:**
- Backend unit (`*.spec.ts` next to the service, auth-service Jest): enqueue add-intent â†’ `listRoomIntents` returns it for the owning org only (cross-org caller gets none, IDOR check); `ackRoomIntent` is a conditional UPDATE (second ack â†’ 404; wrong org â†’ 404).
- Mobile unit (mirror `src/modules/messenger/__tests__/membershipIntents.test.ts`): `drainDispatchRoomIntents` calls `runtime.addGroupMember` with `{groupId: conversation_id, newMember:{userId, deviceId:1}}`, acks only on success, leaves pending on throw, skips not-yet-bootstrapped groups.
- Regression: `npm run test:crypto` (this touches the group-key path indirectly via the runtime), plus the booking Jest project for anything that calls `ensureBookingOpsRoom`.
- Gates: `npm run typecheck` (mobile â‰¤ baseline 96) **and** `cd apps/ops-console && npm run typecheck`; `npm run lint`; auth-service `npm run build`. Manual 3-device smoke: accept (room = client + agency) â†’ assign 2 CPOs + lead â†’ both CPOs see and can read/send in the Ops Room within a drain cycle. Never commit on a red gate; never `--no-verify`.
  **Done when:**
- [ ] `dispatch_room_intents` migration applies; old tables untouched.
- [ ] Auto-flow Ops Rooms are created with the **agency device** as creator/admin (verified against the architecture doc).
- [ ] `POST /org/bookings/:id/crew` enqueues one add-intent per CPO; the agency device drains them on focus and the CPOs can decrypt new Ops Room messages.
- [ ] `listRoomIntents`/`ackRoomIntent` are org-scoped + race-safe (conditional UPDATE), proven by tests.
- [ ] `npm run test:crypto`, both typechecks, lint, and auth-service build are green.

---

## Step 13 â€” Crew assignment + leader (the step that creates the mission)

**Stage:** Comms & crew Â· **Depends on:** Step 6 (accept flips booking `DISPATCHINGâ†’CONFIRMED`, sets `assigned_provider_user_id`, opens Ops Room with client+agency), Step 11/Phase 15 (managed-CPO roster: `org_members` + `POST /org/cpos`), Step 12 (Ops Room add-intent enqueue), Step 14 (per-CPO push) Â· **Resolves:** Part II Â§24, Part II Â§27 amendments 1â€“2, **LB7** (P0 IDOR), **LB8** (P0 conditional-UPDATE), **LB11** (P0 honor-what-client-paid)
**Goal (plain English):** After an agency accepts a job, it must pick which of its registered guards go and name one as the team leader. That single confirm is what actually creates the mission. We add an endpoint that lists all of this agency's jobs (grouped: needs-crew / active / recent) and another that takes the chosen guards + leader, validates everything, creates the mission + crew rows, seeds the mission's waypoints and deployment checks, queues the guards into the encrypted Ops Room, and notifies each guard's phone.
**Why it matters / what breaks without it:** Per D7, accept does **not** auto-pick crew â€” the booking sits at `CONFIRMED` with no mission until the agency crews it. Without this step the job is accepted, the client is charged, but no mission/crew ever materializes and the guards never get the job. This is the hand-off that replaces the old admin "Dispatch" click.
**Self-contained context (inline â€” do not make the reader open the plan):**

- **Decisions:** D3 the agency accepts then deploys its own CPOs; D5 the agency's CPOs are real login accounts (`org_members` + `agents type='cpo' managed_by_org_id=org`); D6 an agency runs multiple concurrent missions bounded by free CPO capacity; D7 accept does NOT auto-pick crew â€” crew-assign creates the mission; D8 one CPO is the leader (`mission_crew.is_lead`/`role='LEAD'`).
- **FSM states:** booking FSM `apps/auth-service/src/booking/state-machine.service.ts` â€” at this point the booking is `CONFIRMED` (= "accepted, awaiting crew"); it stays `CONFIRMED` until the assigned lead checks in (`CONFIRMEDâ†’LIVE` later). Mission FSM `apps/auth-service/src/ops/mission-state-machine.service.ts` â€” the mission is created at `DISPATCHED` (then `PICKUPâ†’LIVEâ†’â€¦COMPLETED`).
- **Reuse the dispatch() shape** from `apps/auth-service/src/ops/job-feed.service.ts` (lines ~292â€“345): `short = 'MSN-' + booking_id.replace(/-/g,'').slice(-12).toUpperCase()` (race-free, UUID-derived); `INSERT INTO missions (booking_id, status, short_code) VALUES ($1,'DISPATCHED',$2) ON CONFLICT (booking_id) DO UPDATE SET status=EXCLUDED.status RETURNING id`; per crew member `INSERT INTO mission_crew (mission_id, agent_id, slot, role, call_sign) VALUES (...) ON CONFLICT DO NOTHING` with the lead getting `role='LEAD'` (slot 0 in the legacy path); `INSERT INTO mission_waypoints (mission_id, seq, tag, event)` from `DEFAULT_MISSION_WAYPOINTS` (mission-defaults.ts); `INSERT INTO agent_deployment_checks (user_id, check_key, state, mission_id) VALUES ($1,$2,'pending',$3)` for checks `['dress','vehicle','equip','briefing']`. Then `UPDATE missions SET comms_channel_id = lite_bookings.conversation_id` to reuse the already-open Ops Room.
- **Note on the leader column:** the legacy `dispatch()` uses `role='LEAD'`/slot-0 to denote the leader (not an `is_lead` boolean). The plan asks for `mission_crew.is_lead` with a **partial unique index** so exactly one lead per mission. Verify the live `mission_crew` schema: if `is_lead` does not exist, add it in this step's migration plus `CREATE UNIQUE INDEX mission_crew_one_lead ON mission_crew(mission_id) WHERE is_lead;` â€” and set both `is_lead=true` and `role='LEAD'` for the leader so existing lead-gated agent endpoints keep working.
- **Tenant + guard primitives:** `OrgManagerGuard` (`apps/auth-service/src/org/org-manager.guard.ts`) resolves the caller's org into `req.orgManager = {user_id, org_user_id}` (company self OR active manager) by re-reading the DB; `assertOrgScope(manager, targetOrgId)` throws `org_scope_violation` on cross-tenant. The org controller (`apps/auth-service/src/org/org.controller.ts`) is `@UseGuards(JwtAuthGuard, OrgManagerGuard)` and every handler scopes to `manager.org_user_id`, never a path param. Roster lives in `org_members` (filter `member_role`, `status='active'`); managed CPOs also have `agents.managed_by_org_id = org`.
- **Capacity (D6, feeds Step's eligibility / Step 9 ranking):** `free_cpos(agency) = active roster CPOs âˆ’ distinct CPOs in a non-completed mission_crew âˆ’ Î£ cpo_count of this agency's CONFIRMED bookings with no mission yet`. Crew-assign must consume capacity so the agency stops being offered jobs it can't crew.
- **LB11:** the request's `cpo_count`, `armed`, female-CPO and medical requirements (on `lite_bookings`) must constrain crew-assign validation, not be silently dropped.
  **Files to touch:**
- **EXTEND** `apps/auth-service/src/org/org.controller.ts` â€” add `GET /org/missions` and `POST /org/bookings/:bookingId/crew` (+ optional `POST /org/missions/:missionId/reassign`), all already behind `JwtAuthGuard + OrgManagerGuard`, scoped to `@CurrentOrgManager()`.
- **NEW** `apps/auth-service/src/org/org-mission.service.ts` (or extend `org-cpo.service.ts`) â€” `listOrgMissions(orgUserId)`, `assignCrew(orgUserId, bookingId, {cpoUserIds, leadUserId})`, `reassign(...)`.
- **NEW DTO** in `apps/auth-service/src/org/dto/org.dto.ts` â€” `AssignCrewDto { cpo_user_ids: string[]; lead_user_id: string }`.
- **EXTEND** mission/crew migration (only if `mission_crew.is_lead` + the partial unique index don't already exist) â€” `supabase/migrations/<ts>_mission_crew_is_lead.sql`.
- **REUSE** `apps/auth-service/src/ops/mission-defaults.ts` (`DEFAULT_MISSION_WAYPOINTS`), `system-messenger.service.ts` (room already open from accept), Step 12's `enqueueRoomAddIntent`, Step 14's `BookingPushBridge.missionAssigned`.
- **EXTEND** mobile `src/screens/agent/*` â€” multi-mission board (OrgMissions, grouped needs-crew/active/recent) + assign-crew/leader sheet; `src/services/api.ts` `orgApi.listMissions()/assignCrew(...)`.
  **Backend how-to:**
- `GET /org/missions` â†’ `listOrgMissions(manager.org_user_id)`: one query joining `lite_bookings` (where `assigned_provider_user_id = $org`) LEFT JOIN `missions` ON `booking_id` LEFT JOIN `mission_crew`, returning per job: pickup/dropoff (precise â€” this caller is the assigned provider), `booking.status` + `mission.status` (both, for the shared stepper), crew array, and the lead. Group by state: `CONFIRMED` + no mission = _needs-crew_; mission `DISPATCHED..LIVE` = _active_; mission `COMPLETED` = _recent_.
- `POST /org/bookings/:bookingId/crew` â†’ `assignCrew(manager.org_user_id, bookingId, dto)` inside `withTransaction`:
  1. **Tenant + state gate (race-safe, LB7+LB8):**
     ```sql
     UPDATE lite_bookings
        SET status='CONFIRMED'                         -- no-op flip used as the lock
      WHERE id=$1 AND assigned_provider_user_id=$2      -- assertOrgScope-by-row
        AND status='CONFIRMED'
        AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.booking_id=$1)
      RETURNING id, cpo_count, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, conversation_id, client_id;
     ```
     0 rows â†’ `409 booking_not_assignable` (wrong org / not CONFIRMED / already crewed). Also call `assertOrgScope(manager, row.assigned_provider_user_id)` defensively.
  2. **Validate crew (LB11 + D7):** every `cpo_user_id` is an **active member of THIS org** (`org_members WHERE org_user_id=$org AND member_user_id=ANY($ids) AND status='active'` count must equal `ids.length`) **and free** (not in a non-completed `mission_crew`); `lead_user_id âˆˆ cpo_user_ids`; `cpo_user_ids.length === booking.cpo_count`; honor armed/female/medical flags against each CPO's attributes. Any failure â†’ `400`/`409` with a specific code (`cpo_not_in_org`, `cpo_busy`, `lead_not_in_crew`, `crew_count_mismatch`, `requirement_unmet`).
  3. **Create mission + crew** (reuse `job-feed.service.ts dispatch()` shape): insert `missions` (`DISPATCHED`, `short_code`), insert `mission_crew` rows (leader `is_lead=true`, `role='LEAD'`, slot 0; others `role='CP'`), seed `mission_waypoints` from `DEFAULT_MISSION_WAYPOINTS`, seed `agent_deployment_checks` for `['dress','vehicle','equip','briefing']`, and `UPDATE missions SET comms_channel_id = booking.conversation_id`.
  4. **Enqueue Ops Room add-intents (Step 12):** for each `cpo_user_id`, `enqueueRoomAddIntent(bookingId, conversation_id, cpoUserId, manager.user_id)`. The server does NOT call `conversations.addMember` to grant chat access â€” the agency device owns the rekey.
  5. **Push each CPO (Step 14):** `BookingPushBridge.missionAssigned(cpoUserId, ...)` (opaque; details in Redis).
  6. Idempotency: wire the `Idempotency-Key` interceptor (`apps/auth-service/src/common/interceptors/idempotency.interceptor.ts`) so a double-confirm yields one mission (the `ON CONFLICT (booking_id)` on `missions` is the backstop).
- `POST /org/missions/:missionId/reassign` (optional, pre-LIVE only): conditional `UPDATE missions ... WHERE id=$1 AND status='DISPATCHED'` then swap `mission_crew`; enqueue add/remove room-intents accordingly.
  **Frontend / ops-console how-to:**
- Agency mobile (`src/screens/agent/*`): a **missions list** ("you have N jobs") with a needs-crew badge; tap a job â†’ **assign-crew sheet** picking guards from the roster by email/name (free/busy badges from `orgApi.listCpos`), tap one â˜… Leader, confirm â†’ `orgApi.assignCrew(bookingId, {cpo_user_ids, lead_user_id})`. After confirm the job moves to "Team dispatched" on the shared stepper. `src/services/api.ts`: add `orgApi.listMissions()` and `orgApi.assignCrew(...)`.
  **Security stop-conditions:** Adding CPOs to the Ops Room is the E2EE seam â€” do it **only** via Step 12's add-intent enqueue (agency device runs `planAddAndRekey`); the server must **not** distribute the group key. **STOP/verify** the group rekey/sender-key flow on member add against the System Architecture Documentation. Keep all guards intact (no "skip in dev"); resolve the caller's org from `OrgManagerGuard`/`assertOrgScope`, never from a raw `sub` or path param (LB7). Never log crew/booking ids paired with key/plaintext.
  **Acceptance & tests:**
- Backend unit (`org-mission.service.spec.ts`, auth-service Jest): assign 2 guards + lead to a `CONFIRMED` no-mission booking â†’ one `missions` row + 2 `mission_crew` rows (one `is_lead`), waypoints + deployment checks seeded, `comms_channel_id` set; assigning a CPO already on a non-completed mission â†’ `409 cpo_busy`; lead not in crew â†’ `400`; crew count â‰  `cpo_count` â†’ `409`; cross-org booking â†’ `403 org_scope_violation`; second assign (idempotent) â†’ still one mission. `GET /org/missions` groups correctly and shows the lead.
- Regression: booking Jest project (`npm test -- --selectProjects=booking`); `npm run test:crypto` (touches the Ops Room add path via Step 12).
- Gates: `npm run typecheck` (â‰¤ 96) + `cd apps/ops-console && npm run typecheck`; `npm run lint`; auth-service `npm run build`. Manual 3-device smoke: accept 3 jobs â†’ all 3 in `GET /org/missions` â†’ crew one with a leader â†’ mission + 2 crew rows; both guards see the job + join chat; non-leader has no status buttons; capacity is consumed so the agency stops being offered jobs it can't crew. Never commit on red; never `--no-verify`.
  **Done when:**
- [ ] `POST /org/bookings/:id/crew` creates the mission (`DISPATCHED`) + `mission_crew` (one lead) + waypoints + deployment checks + reuses the existing Ops Room, all in one race-safe transaction.
- [ ] Validation enforces same-org + free + lead-in-crew + count==`cpo_count` + armed/female/medical (LB11); cross-tenant is rejected (LB7).
- [ ] Crew-assign enqueues Step 12 add-intents and Step 14 pushes; double-confirm is idempotent (one mission).
- [ ] `GET /org/missions` returns this agency's jobs grouped needs-crew/active/recent with `booking.status`+`mission.status`+crew+lead.
- [ ] booking project + crypto tests, both typechecks, lint, auth-service build all green.

---

## Step 14 â€” Opaque push wiring + fix the real consumer cleartext leak

**Stage:** Comms & crew Â· **Depends on:** Step 8/Phase 3 (DispatchService emits offers), Step 6 (accept), Step 13 (crew-assign pushes each CPO) Â· **Resolves:** Part I Â§12 (Phase 7 Â§12.1), Part II Â§24 step 4, Part III correction #6 area, **LB15** (P0 â€” push wake stays opaque), audit **P0-N8**
**Goal (plain English):** When the system needs to wake a phone (a new job offer for an agency, "your agency accepted" for a client, "no detail available", or "you've been assigned to a mission" for a guard), it must send a _content-free_ ping â€” never the booking id, the job type, or who it's about â€” because that ping passes through Google/Apple in the clear. We add the four new wake types behind the existing opaque bridge, fix the messenger-service consumer that currently reconstructs and re-broadcasts the sensitive fields in cleartext FCM data, and add a static test that fails if any sensitive field ever appears on the channel.
**Why it matters / what breaks without it:** A leak here exposes a per-user, real-time feed of "this person is requesting/accepting bodyguard protection for booking X" to the push intermediary â€” exactly the metadata Sealed Sender exists to hide. The bridge already does the right thing, but the **consumer** in messenger-service still reads `kind/bookingId/missionId` off the channel and ships them as FCM data â€” a live P0 leak.
**Self-contained context (inline â€” do not make the reader open the plan):**

- **The opaque contract (P0-N8):** the channel message published on Redis `push:events` must be **exactly** `{userId, eventClass, eventId}` â€” nothing else. All real detail (`kind`, `bookingId`, etc.) is stored separately under `push-event:<eventId>` in Redis with a 5-minute TTL and is fetched by the device over the **JWT-gated encrypted relay** (`/events/by-id/:eventId`), never over FCM. This is already correctly implemented in `apps/auth-service/src/ops/booking-push-bridge.service.ts` `publish()` (lines 51â€“70): it mints an opaque `eventId = crypto.randomBytes(16)`, `SET push-event:<eventId> <details> EX 300`, then `publish(CHANNEL, JSON.stringify({userId, eventClass, eventId}))`. `eventClass` is intentionally coarse (`'agent'|'booking'|'mission'|'payout'|'sos'`) â€” one bit per category, no per-instance id.
- **The real leak (LB15):** `apps/messenger-service/src/push/push.service.ts` `bootstrapPushEventsSubscriber()` (lines 132â€“178) parses the channel frame as `{kind, userId, bookingId, missionId, status, credits}` and switches on `frame.kind`, then calls e.g. `sendMissionLifecycleWake(userId, kind, missionId, bookingId)` (line 189) â†’ `sendDataOnlyToUser(userId, {kind, missionId, bookingId}, ...)` (line 192) and `sendSosAlertWake` â†’ `sendDataOnlyToUser(userId, {kind:'sos-cpo-alert', missionId, bookingId}, ...)` (line 201). That puts `kind` + `bookingId` + `missionId` into the cleartext FCM `data` payload. This consumer also assumes a channel shape the bridge **no longer publishes** (the bridge sends `{userId, eventClass, eventId}`, not `{kind, bookingId}`) â€” so it is both leaking and broken. Fix: the consumer must read **only** `{userId, eventClass, eventId}` and forward **only** `{eventId}` (and at most the coarse `eventClass`) as FCM data â€” the device then fetches details by `eventId` over the relay (same as chat wakes via `sendChatWake`/`sendDataOnlyToUser`).
- **New bridge methods needed (Part I Â§12.1 + Part II Â§24 step 4):** `dispatchOffer(providerUserId, offerId, bookingId)` â†’ `publish(providerUserId, 'dispatch', {kind:'dispatch-offer', offerId, bookingId})`; `providerAccepted(clientUserId, bookingId)` â†’ `publish(clientUserId, 'booking', {kind:'provider-accepted', bookingId})`; `noProvider(clientUserId, bookingId)` â†’ `publish(clientUserId, 'booking', {kind:'no-provider', bookingId})`; `missionAssigned(cpoUserId, missionId, bookingId)` â†’ `publish(cpoUserId, 'mission', {kind:'mission-assigned', missionId, bookingId})`. All sensitive args go into `details` (Redis), never the channel. Add a **new coarse `eventClass: 'dispatch'`** to the `publish()` union for offers.
- **Device fetch-on-wake:** the mobile client, on a data-wake, fetches detail from the JWT-gated endpoint by `eventId` (the same pattern chat uses) and routes â€” never trusts cleartext fields.
  **Files to touch:**
- **EXTEND** `apps/auth-service/src/ops/booking-push-bridge.service.ts` â€” widen the `eventClass` union to add `'dispatch'`; add `dispatchOffer`, `providerAccepted`, `noProvider`, `missionAssigned`. Do **not** change `publish()`'s channel message shape.
- **EXTEND** `apps/messenger-service/src/push/push.service.ts` â€” rewrite `bootstrapPushEventsSubscriber()` to parse `{userId, eventClass, eventId}` only and forward only `{eventId}` (+ coarse `eventClass`) via `sendDataOnlyToUser`; add a `'dispatch'` branch. **Delete** the cleartext reconstruction in `sendMissionLifecycleWake`/`sendSosAlertWake`/`sendPayoutSettledWake`/`sendBookingApprovedWake` that injects `bookingId/missionId/kind` into `data`.
- **NEW static test** `apps/auth-service/src/ops/booking-push-bridge.opacity.spec.ts` (or alongside the existing log-audit tests) â€” assert the published channel JSON contains exactly the keys `userId,eventClass,eventId` and **no** `bookingId/offerId/missionId/kind/status/credits`.
- **EXTEND** mobile data-wake handler (where chat wakes are handled) + `src/services/api.ts` â€” add a `'dispatch'` wake route that fetches the offer/booking detail from the JWT-gated endpoint by `eventId` and surfaces the incoming-offer card / status change.
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
- New static test (auth-service Jest): the four new bridge methods publish a channel JSON whose keys are exactly `userId,eventClass,eventId` and which contains no booking/offer/mission id â€” **fails first** against the current leaking consumer assumptions, passes after.
- messenger-service unit (its own Jest): `bootstrapPushEventsSubscriber` parses `{userId,eventClass,eventId}` and calls `sendDataOnlyToUser` with `data` limited to `{eventId, eventClass}` â€” assert `bookingId`/`missionId`/`kind` never appear in the `data` arg.
- Regression: `npm run test:crypto` (push opacity is part of the messaging metadata story); booking Jest project for the accept/offer wiring.
- Gates: `npm run typecheck` (â‰¤ 96) + `cd apps/ops-console && npm run typecheck`; `npm run lint`; both backend services `npm run build`. Manual: agency backgrounded â†’ offer wakes it; client "Findingâ€¦" flips to "Accepted"; assigned CPO is woken to the mission; verify (logcat / FCM data inspection) the wake carries no booking/offer/mission id. Never commit on red; never `--no-verify`.
  **Done when:**
- [ ] `dispatchOffer`/`providerAccepted`/`noProvider`/`missionAssigned` exist on `BookingPushBridge`, all routing detail through Redis (`details`), with a new coarse `'dispatch'` eventClass.
- [ ] The messenger-service consumer no longer reconstructs `kind/bookingId/missionId` into FCM `data`; it forwards only `{eventId, eventClass}` and the device hydrates by `eventId`.
- [ ] A static test asserts the channel payload is exactly `{userId,eventClass,eventId}` and is wired into the suite.
- [ ] Offer/accept/no-provider/mission-assigned wakes are emitted from DispatchService + the crew handler; device fetch-on-wake hydrates from JWT-gated endpoints.
- [ ] crypto + booking tests, both typechecks, lint, and both backend builds are green.

---

## Step 15 â€” Vetting / licence / insurance / armed eligibility gates + per-request client terms

**Stage:** Safety & trust Â· **Depends on:** Step 6 (eligibility/ranking query that the dispatcher filters on), Step 5 (`agents.region_code` + on-duty heartbeat columns), Step 1â€“2 (auto-dispatch migration + `dispatch_offers`/`lite_bookings.dispatch_mode`) Â· **Resolves:** Part III legal table LB10 + LB20 + LB11 (P0 rows: "No vetting gate in the match", "Per-region/agency/CPO licence registry with expiry", "Mandatory insurance certificate on file + expiry", "Armed-protection authorization + an `armed` request field", "Client terms / waiver acceptance captured per request"); Trust & safety P0 "can dispatch unvetted/unlicensed/uninsured agencies".

**Goal (plain English):** Before the system can auto-offer a job to a firm, that firm (and the guards it would deploy) must be proven legit: KYC-active, holding a non-expired licence for the job's region, holding a non-expired insurance certificate, and â€” if the client asked for armed protection â€” authorised to carry. We store each of these as a verifiable record with an expiry date and an admin "verified" stamp, and the matchmaker only ever considers providers who pass all of them. We also record the client's acceptance of the terms / service agreement / waiver on the booking itself each time they request.

**Why it matters / what breaks without it:** This is an armed-protection product across four regulated regions; dispatching an unvetted, unlicensed, uninsured, or unauthorised-armed provider is the single biggest legal and safety liability. Without the per-request terms capture there is no record the client agreed to anything.

**Self-contained context (inline â€” do not make the reader open the plan):**

- LOCKED DECISIONS in play: D1 the flow is fully automatic (admin only monitors/overrides), D3 the AGENCY accepts then deploys its own CPOs, D4 nearest-eligible within the same region (AE / SA / BD / GB), D5 one login email = one agency with up to ~10 real CPO emails.
- The match must dispatch ONLY providers that are KYC-ACTIVE + licensed (valid, non-expired, region-matched) + insured (cert on file, non-expired) + armed-authorised when the request requires it. This is the eligibility filter Step 6's ranking query consumes.
- What already exists (verified in code â€” reuse, don't reinvent):
  - `agents` table â€” company/cpo agents with `status` driven by the KYC FSM in `apps/auth-service/src/agents/agent-state-machine.service.ts` (`PROFILE_COMPLETE â†’ KYC_PENDING â†’ DOCS_PENDING â†’ â€¦ â†’ ACTIVE`). The match's "KYC-ACTIVE" = `agents.status='ACTIVE'`.
  - `agent_kyc_checks` (kinds in `apps/auth-service/src/agents/dto/agent.dto.ts`: `KYC_KINDS = ['gov_id','proof_address','sia_licence','police']`) with `file_url`, `file_hash_sha256`, `uploaded_at` (migration `supabase/migrations/20260425000000_agent_kyc_uploads.sql`). **No expiry column exists.**
  - `agent_documents` (DOC_SLOTS in the same DTO: `['sia','passport','insurance','dbs','firstaid','cv']`) â€” upload slots, **no expiry, no admin-verified flag, no region binding.**
  - `agents` has NO `region_code` today (Step 5 adds it). The old `cpo_pool` table (migration `20260423160000_wallet_assignment_telemetry.sql`) has `armed`/`female`/`region_code`/`specialties` columns but is the LEGACY admin pool â€” do NOT extend the auto-flow off it (correction #6 / "capacity drift across two un-reconciled availability models"). The new flow keys off `agents` + `org_members`.
  - `lite_bookings` (migration `20260423113000_booking_module.sql`) has `cpo_count`, `add_ons JSONB`, `region_code`, `pickup_lat/lng`, `dropoff_lat/lng`. It has **NO `armed`, `female`, or `waiver`/`terms` columns** â€” those must be added. ("female_cpo" exists only as an `lite_booking_add_ons` row, not a first-class field.)
- LB11 ("honor what the client paid for"): `armed`, `cpo_count`, female-CPO, medical requirements must constrain BOTH the match (this step's eligibility filter) AND the Step-7 crew-assign validation â€” not be silently dropped.
- These are compliance gates to ENCODE in software, not legal advice; the plan flags "confirm the actual regimes with counsel per region" and "cross-border jurisdiction mismatch" as a follow-up.

**Files to touch:**

- NEW migration `supabase/migrations/<ts>_provider_compliance_registry.sql` â€” the compliance registry tables + booking compliance columns (SQL below).
- EXTEND `apps/auth-service/src/agents/dto/agent.dto.ts` â€” add a `ComplianceDocDto` (type, region, issued/expiry, file_url, file_hash) and an `ArmedAuthDto`; export a `COMPLIANCE_DOC_TYPES = ['licence','insurance','armed_permit'] as const`.
- EXTEND `apps/auth-service/src/agents/agent.service.ts` + `agent.controller.ts` â€” provider-side CRUD to submit/replace compliance docs (`POST /agents/me/compliance`, `GET /agents/me/compliance`).
- EXTEND `apps/auth-service/src/ops/ops.controller.ts` + `ops.service.ts` â€” admin verify/reject of a compliance record (`POST /ops/compliance/:id/verify`), audited via the existing `OpsAuditService`.
- EXTEND the eligibility query authored in Step 6 (the dispatcher's "nearest eligible provider" SQL, in the new `apps/auth-service/src/dispatch/dispatch.service.ts`) â€” add the compliance JOIN/EXISTS filters.
- EXTEND `apps/auth-service/src/booking/dto/booking.dto.ts` (the create-booking DTO) + `booking.service.ts` â€” accept + persist `armed: boolean`, `female_required: boolean`, and `terms_accepted_version`/`terms_accepted_at` on auto-mode requests.
- Mobile: EXTEND the request wizard (Package / AddOns step, under `src/screens/`) to surface an "Armed protection" toggle and a "I accept the terms & waiver" gate; EXTEND `src/services/api.ts` booking-create call to send the new fields. Agency-side: EXTEND the "Agency Profile & Compliance" screen (per Â§30, v1.1) for licence/insurance/armed-permit upload + expiry.

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
    file_url         TEXT,                          -- S3 key (AES-256-CBC encrypted before upload, key in-band) â€” NEVER a plaintext cert
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

- Admin verify endpoint â€” race-safe conditional UPDATE inside `withTransaction`, mirroring the `payWithCredits`/waypoint pattern (`UPDATE â€¦ WHERE <expected state> RETURNING`):
  ```sql
  UPDATE provider_compliance_docs
     SET state='VERIFIED', verified_by=$2, verified_at=NOW(), updated_at=NOW()
   WHERE id=$1 AND state='PENDING'
   RETURNING provider_user_id, doc_type, region_code, expires_at;
  ```
  If `doc_type='armed_permit'` and the row verifies non-expired, set `agents.armed_authorized=TRUE` in the SAME txn; recompute on reject/expiry. Audit via `OpsAuditService.emit({kind:'compliance', actor, subject: providerUserId, message:'licence verified'})`.
- Eligibility filter to ADD to Step 6's dispatcher query â€” only consider a provider when, for the booking's `region_code`:
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
  Keep this as ONE filter block so the offer cascade (reject â†’ next-nearest) can never skip it.
- Expiry: add a small Redis `SET NX`-locked `setInterval` sweep (copy `apps/auth-service/src/.../payment-pending-expiry.service.ts`, NOT `@nestjs/schedule` â€” auth-service is multi-replica) that flips `state='VERIFIED' â†’ 'EXPIRED' WHERE expires_at < NOW()` and recomputes `agents.armed_authorized`. A provider whose licence/insurance silently lapsed must drop out of the pool the moment it expires, without a manual touch.
- Booking create: in `booking.service.ts`, when `dispatch_mode='auto'`, REQUIRE `terms_accepted_version` (reject the request with `400 terms_not_accepted` if absent) and persist `armed`/`female_required` from the DTO. Cross-border note: if the client's `region_code` differs from the requested-service region, mark for review rather than silently dispatching (jurisdiction mismatch is a flagged P1 â€” leave a `// Why:` comment and a TODO referencing counsel sign-off).

**Frontend / ops-console how-to:**

- Mobile request wizard (Package/AddOns step): add an "Armed protection" switch wired to `armed`, a female-team requirement toggle wired to `female_required`, and a blocking "I accept the Terms of Service & Liability Waiver (vX)" checkbox; the Submit button stays disabled until checked, and the create call sends `terms_accepted_version` + `armed` + `female_required`. Render TrustProfile badges (vetted/licensed/insured) only from real backend fields â€” never fabricate a badge (per Â§32).
- Agency app "Agency Profile & Compliance": upload licence/insurance/armed-permit with an expiry date picker; show each doc's state (Pending / Verified / Rejected / Expired) and days-to-expiry; surface the admin reject_reason. CPO compliance is uploaded under the existing Docs/Credentials screen.
- Ops-console: a compliance review queue (list `PENDING` docs, view the (decryptable) cert, Verify/Reject with reason) under `apps/ops-console/src/app/`.

**Security stop-conditions:**

- Compliance certs are sensitive PII/regulatory documents: store them via the SAME media path as other uploads â€” AES-256-CBC, unique key per file, encrypted locally before upload to S3, key shipped in-band. **STOP/verify against the System Architecture Documentation before issuing any download URL** â€” the File Vault MFA gate (fresh biometric/TOTP before a download URL is returned) applies; do not bypass it.
- Do NOT add a "skip vetting in dev" branch on the eligibility filter â€” a missing/expired licence must hard-exclude in every environment (CLAUDE.md: never weaken a check with a dev skip).
- Never log cert file bytes, file_url contents, or hashes that could leak document identity into logs (the static log-audit test enforces no plaintext/key logging).
- The eligibility filter only reads provider compliance â€” it must NOT expand the coarse pre-accept offer payload (the offer stays coarse: no exact pickup/dropoff to offered/rejecting agencies â€” correction #3).

**Acceptance & tests:**

- New unit tests (auth-service Jest â€” note correction #6: ensure CI actually runs the auth-service project): expired-licence provider is excluded; missing-insurance provider is excluded; `armed=TRUE` request with `armed_authorized=FALSE` provider is excluded; all-valid provider passes; verify endpoint flips state only from `PENDING` (double-verify is a no-op); armed-permit verify sets `agents.armed_authorized`; expiry sweep clears it.
- Booking test (run the `booking` Jest project): auto request without `terms_accepted_version` is rejected; with it, `armed`/`female_required`/`terms_*` persist on the row.
- Regression: re-run the booking project + the dispatcher/eligibility tests from Step 6.
- Gates: `npm run typecheck` (mobile â‰¤ baseline 96) AND `cd apps/ops-console && npm run typecheck`; `npm run lint`; manual smoke of the wizard terms gate + an agency compliance upload + an ops verify. Never commit on a red gate; never `--no-verify`.

**Done when:**

- [ ] `provider_compliance_docs` + `agents.armed_authorized` + `lite_bookings.armed/female_required/terms_accepted_*` migrated.
- [ ] Provider can submit licence/insurance/armed-permit with expiry; admin can verify/reject (audited).
- [ ] Step-6 eligibility query excludes non-ACTIVE / unlicensed / uninsured / out-of-region / armed-required-but-unauthorised providers, proven by tests.
- [ ] Expiry sweep (Redis `SET NX`, not @nestjs/schedule) flips lapsed docs to `EXPIRED` and clears `armed_authorized`.
- [ ] Auto request blocks until terms accepted; `armed`/`female_required`/`terms_*` persist and feed both the match and Step-7 crew validation.
- [ ] All listed gates green.

## Step 16 â€” Identity handshake + pre-live SOS coverage + no-show auto-re-dispatch + NO_PROVIDER safety fallback

**Stage:** Safety & trust Â· **Depends on:** Step 15 (vetting gates â€” only verified providers ever reach this), Step 6/7 (offer cascade + crew-assign that creates the mission), Step 5 (mission FSM wiring `pickup`), the escrow accept txn (Step PV2) so re-dispatch can reuse the held funds Â· **Resolves:** Part III LB12 (clientâ†”guard identity handoff), LB13 (SOS covers the pre-live window + no-show + `NO_PROVIDER` safety fallback); Trust & safety P0 rows "No clientâ†”guard identity handoff (impersonation risk)", "No SOS coverage during DISPATCHING / awaiting-crew", "No no-show / never-arrives detection or auto-re-dispatch", and P1 "`NO_PROVIDER` leaves a threatened client alone"; feeds the Â§40 proof-of-completion gate ("Identity handshake â€¦ happened or was offered").

**Goal (plain English):** When the guard arrives, the app shows the SAME rotating code to both the client and the lead guard so each can confirm the other is the real party; the lead's "Arrived" confirm advances the mission to PICKUP, and a client "this is NOT my guard" button instantly fires the panic alarm. The panic button also has to work during the scary in-between moments â€” while still searching for a firm and while a firm has accepted but hasn't put a crew on the job yet. If the guard never shows up, the system notices and re-dispatches automatically. And if nobody is available at all, the client isn't just told "sorry" â€” they're given a real safety fallback (a hotline / escalation / widen-the-search).

**Why it matters / what breaks without it:** Impersonation of a bodyguard is a direct attack on the principal; the client is MOST exposed in the windows before the mission goes LIVE, exactly where SOS currently doesn't reach; a no-show with no detection strands a charged client; and a bare "no one available" dead-end abandons a person who may be in danger.

**Self-contained context (inline â€” do not make the reader open the plan):**

- Booking FSM (auto flow, from `apps/auth-service/src/booking/state-machine.service.ts` extended in Step 2): `DRAFT â†’ DISPATCHING` (CLIENT submits auto request) â†’ `CONFIRMED` (SYSTEM: agency accepted + charged into escrow; CONFIRMED now means "accepted, awaiting crew assignment") â†’ `LIVE` â†’ `COMPLETED`; failure `DISPATCHING â†’ NO_PROVIDER` (terminal: nobody available / all rejected). The client is exposed during `DISPATCHING` and during `CONFIRMED`-awaiting-crew (before LIVE).
- Mission FSM (`apps/auth-service/src/ops/mission-state-machine.service.ts`): `DISPATCHED â†’ PICKUP â†’ LIVE â†’ COMPLETED`, with SOS overlay from PICKUP/LIVE. Today PICKUP is fired ONLY by the lead via `MissionLeadService.markWaypoint('PICKUP')` (verified: lead-gated `UPDATE missions SET status='PICKUP' WHERE id=$1 AND status='DISPATCHED'`). The arrival-confirm path must reuse this exact lead-gated, conditional transition.
- SOS today (verified in `apps/auth-service/src/sos/sos.service.ts` + `sos.controller.ts`): `SosService.raise(userId, {bookingId?, lat?, lng?, reason?, payload?})` is NOT booking-scoped â€” a panic press from anywhere is recorded (`sos_events` row, `status='active'`), it emits ops-audit + Kafka, and when `bookingId` is present it fans a `kind:'sos-cpo-alert'` wake over Redis `push:events` to every crew member found via `mission_crew JOIN missions ON booking_id`. `POST /sos/raise` is throttled 3/min/user via `UserThrottlerGuard`. Agent-side SOS exists at `POST /agents/me/missions/:missionId/sos` (controller line ~302). So raising SOS already works in any state â€” the gap is (a) a client-facing "not my guard" path that calls it with the booking context, and (b) ensuring the client SOS UI is mounted/available during DISPATCHING and CONFIRMED-awaiting-crew, plus crew-fanout gracefully no-ops when no crew exists yet.
- Identity handshake (LB12): a rotating shared code/passphrase (+ photo/call-sign) shown IDENTICALLY to client and lead CPO at arrival. New endpoint `GET /bookings/:id/verify-code` (server-issued, rotating). It is read by the client's new `IdentityVerifyScreen` and the lead's new "Arrival / Identity Confirmation" screen. The Â§40 proof gate later checks "the arrival code/photo confirm happened (or was offered)".
- No-show (LB13): after CONFIRMED + crew assigned (mission DISPATCHED), there must be an arrival deadline; if PICKUP isn't reached by it, auto-re-dispatch (re-offer to the next eligible agency) WITHOUT restarting the client payment â€” the escrow hold persists. This is a watchdog.
- `NO_PROVIDER` fallback (LB13): instead of a bare dead-end, offer a safety fallback (hotline / escalate / widen the search radius/region) â€” the client may be a threatened person.
- KEY CORRECTIONS to honor: (1) ALL watchdogs/sweeps use the Redis `SET NX`-locked `setInterval` pattern from `payment-pending-expiry.service.ts`, NOT `@nestjs/schedule` (auth-service is multi-replica) â€” the no-show sweep included; (3) the re-dispatch offer stays COARSE pre-accept (next agency gets no exact pickup/dropoff until it accepts via the ACCEPTED-only `/offers/:id/full` endpoint); (5) the server cannot add a CPO to the E2E Ops Room (no group-key path) â€” re-dispatch that lands a NEW agency requires the new agency's device to own the rekey, not the server.

**Files to touch:**

- NEW `apps/auth-service/src/booking/verify-code.service.ts` (or extend `booking.service.ts`) â€” issue/rotate the verify code; persist nothing secret-in-plaintext-logged.
- EXTEND `apps/auth-service/src/booking/booking.controller.ts` â€” add `GET :id/verify-code` (client-owns-booking guard) and `POST :id/not-my-guard` (client â†’ fire SOS).
- EXTEND `apps/auth-service/src/agents/agent.controller.ts` + `agent.service.ts` â€” add `POST /agents/me/missions/:missionId/arrive` (lead-gated arrival confirm â†’ fires the existing `DISPATCHED â†’ PICKUP` conditional UPDATE) and `GET /agents/me/missions/:missionId/verify-code` (lead reads the SAME code).
- EXTEND `apps/auth-service/src/sos/sos.service.ts` â€” confirm crew-fanout no-ops cleanly when `mission_crew` is empty (DISPATCHING / awaiting-crew) and the row still records; add a `reason:'not_my_guard'` tag path.
- NEW `apps/auth-service/src/dispatch/no-show-sweep.service.ts` â€” Redis `SET NX`-locked `setInterval` watchdog (copy `payment-pending-expiry.service.ts`) for arrival-deadline â†’ auto-re-dispatch.
- NEW migration `supabase/migrations/<ts>_arrival_and_verify.sql` â€” `lite_bookings.arrival_deadline_at`, `verify_code` (or derive deterministically), `verify_code_rotated_at`, `not_my_guard_at`; `missions.arrived_at`.
- NEW `apps/auth-service/src/booking/fallback.service.ts` (or extend) â€” `NO_PROVIDER` safety fallback details for `GET :id` / a `POST :id/escalate`.
- Mobile NEW `src/screens/IdentityVerifyScreen.tsx` (client) + extend CPO "Arrival / Identity Confirmation" screen + extend `NoDetailScreen` (NO_PROVIDER fallback) + ensure the SOS bar is mounted on FindingDetailScreen/AgencyAcceptedScreen; EXTEND `src/services/api.ts` (verify-code, not-my-guard, arrive, escalate) and `src/services/bookingStatus.ts` `resumeTargetFor`.

**Backend how-to:**

- Verify code: server-issued, rotating, shown identically to both sides. Generate per booking (e.g. derive an HMAC over `booking_id` + a coarse time bucket so it rotates every N minutes without storing a secret in cleartext, OR store a `verify_code` + `verify_code_rotated_at` and rotate on read). `GET /bookings/:id/verify-code` returns `{code, rotates_at, lead: {display_name, call_sign, photo_url}}` gated by `WHERE client_id=$user`; the lead's `GET /agents/me/missions/:id/verify-code` returns the SAME `code` gated by lead membership (`mission_crew.is_lead`). Never log the code value.
- Arrival confirm (lead-gated, reuse the proven pattern): mirror `MissionLeadService.markWaypoint('PICKUP')` â€” require lead (`SELECT is_lead FROM mission_crew WHERE mission_id=$1 AND agent_id=$2`), then the existing conditional UPDATE `UPDATE missions SET status='PICKUP', updated_at=NOW() WHERE id=$1 AND status='DISPATCHED'` inside the txn, stamp `missions.arrived_at=NOW()`, fire the EN_ROUTE auto-mark as today. Idempotent: a second call is a no-op because the WHERE no longer matches.
- "Not my guard": `POST /bookings/:id/not-my-guard` (client-owns guard) â†’ call `SosService.raise(user.sub, {bookingId: id, reason:'not_my_guard', lat, lng})` â€” this records the `sos_events` row AND fans the existing `sos-cpo-alert` wake. Keep it under `UserThrottlerGuard` like `/sos/raise`. This is a panic path: do NOT gate it behind any "are you sure" server check.
- Pre-live SOS coverage: no new transition needed â€” `SosService.raise` already works state-independently. Verify the crew-fanout block (`mission_crew JOIN missions`) returns empty cleanly during DISPATCHING/awaiting-crew and the row still records + ops-audit fires. The FIX is purely (a) keep the client SOS UI mounted in the FindingDetailScreen/AgencyAcceptedScreen states (frontend) and (b) ensure ops sees these pre-live SOS events in the unacknowledged feed.
- No-show watchdog (Redis `SET NX`-locked `setInterval`, copy `payment-pending-expiry.service.ts`; NOT `@nestjs/schedule`): set `arrival_deadline_at = crew_assigned_at + ARRIVAL_SLA` at crew-assign. The sweep finds `missions.status='DISPATCHED' AND lite_bookings.arrival_deadline_at < NOW()` and re-dispatches via a race-safe conditional UPDATE so two pods can't both re-dispatch:
  ```sql
  UPDATE lite_bookings
     SET status='DISPATCHING', assigned_provider_user_id=NULL, dispatch_started_at=NOW(), updated_at=NOW()
   WHERE id=$1 AND status='CONFIRMED' AND arrival_deadline_at < NOW()
   RETURNING id;
  ```
  Only the pod whose UPDATE returns a row proceeds to mark the no-showing offer/agency (flag for penalty) and re-enter the Step-6 cascade. The escrow hold from the original accept STAYS â€” re-dispatch must NOT re-charge the client (reuse the held funds; if the new agency accepts, no new debit). Emit a metric for no-show rate.
- `NO_PROVIDER` fallback: when the cascade exhausts â†’ `DISPATCHING â†’ NO_PROVIDER` (SYSTEM), `dispatch_settled_at=NOW()`, and `GET /bookings/:id` returns a fallback block `{hotline_e164, can_widen: bool, can_escalate: bool}`; a `POST /bookings/:id/escalate` either widens the region/radius and re-enters the cascade or routes to a human safety line. Confirm the client was NEVER charged on this path (escrow only opens on accept).

**Frontend / ops-console how-to:**

- `IdentityVerifyScreen` (client, new): polls `GET /bookings/:id/verify-code`, shows the big rotating code + the lead's photo/name/call-sign, and a prominent red "This is NOT my guard" button â†’ `POST /bookings/:id/not-my-guard` â†’ immediate SOS UX. Reachable from LiveTrackingScreen's "Arrived â€” verify your guard" affordance.
- CPO "Arrival / Identity Confirmation" (lead-only, new): shows the SAME code + an "Arrived" confirm â†’ `POST /agents/me/missions/:id/arrive` (fires PICKUP). Non-lead sees read-only.
- `FindingDetailScreen` + `AgencyAcceptedScreen`: ensure the SOS bar/button is mounted so the client can panic during DISPATCHING and CONFIRMED-awaiting-crew.
- `NoDetailScreen`: replace the bare dead-end with the fallback (call hotline / widen search / escalate) + "you weren't charged."
- `bookingStatus.ts` `resumeTargetFor`: route DISPATCHINGâ†’Finding, CONFIRMEDâ†’Confirmation (with verify affordance once a crew is assigned), LIVEâ†’LiveTracking, NO_PROVIDERâ†’NoDetail fallback â€” for client AND agency/CPO roles.

**Security stop-conditions:**

- Re-dispatch can land a DIFFERENT agency on the Ops Room. **STOP/verify against the System Architecture Documentation:** the server CANNOT add the new agency's CPOs to the E2E Ops Room â€” there is no server-side Signal group-key path for conversation rooms (the serverâ†’client rekey-intent drain covers only department_channels, not booking conversations). The new agency's device must own the rekey (`groupClient.planAddAndRekey` / `runtime.addGroupMember`). Do not have the server inject group membership.
- The verify code is a security token: never log its value; the `not-my-guard` and arrival endpoints must not leak it into audit detail. Honor the static log-audit test.
- The re-dispatch offer to the next agency stays COARSE (no exact pickup/dropoff pre-accept; precise only via the ACCEPTED-only endpoint) â€” do not widen the offer payload to "help" the new agency.
- Keep the panic push wake OPAQUE â€” the Redis `push:events` payload stays exactly `{userId,eventClass,eventId}` shape (audit P0-N8); do not add `not_my_guard`/booking detail to the wake.
- No "skip in dev" on the lead check for arrival confirm or on the SOS throttle guard.

**Acceptance & tests:**

- New unit tests (auth-service Jest â€” and confirm CI runs the auth-service project, correction #6): client and lead read the SAME verify code; the code rotates; `not-my-guard` raises an `sos_events` row with `reason='not_my_guard'` and fans crew alerts; SOS raised during DISPATCHING (no crew) records cleanly with empty fanout; arrival confirm fires `DISPATCHED â†’ PICKUP` only for the lead and is idempotent; non-lead arrival confirm is `403`.
- No-show watchdog test: past `arrival_deadline_at` + still DISPATCHED â†’ exactly ONE pod re-dispatches (simulate the conditional UPDATE returning a row for only one caller â€” mirror the multi-pod lock test pattern), escrow hold unchanged (no second client debit), no-showing agency flagged.
- `NO_PROVIDER` test: exhausted cascade â†’ fallback block present, client never charged.
- Regression: run the `booking` Jest project and the mission/SOS suites; since this touches messaging-adjacent Ops Room membership, run `npm run test:crypto`.
- Gates: `npm run typecheck` (mobile â‰¤ baseline 96) AND `cd apps/ops-console && npm run typecheck`; `npm run lint`; manual smoke â€” client+lead show matching code, "not my guard" fires SOS, kill the crew (no PICKUP) to trigger re-dispatch, exhaust agencies to hit the NO_PROVIDER fallback. Never commit on red; never `--no-verify`.

**Done when:**

- [ ] Client and lead each fetch the SAME rotating verify code (+ lead photo/call-sign); code value never logged.
- [ ] Lead "Arrived" confirm fires `DISPATCHED â†’ PICKUP` (lead-gated, conditional, idempotent); `arrived_at` stamped.
- [ ] Client "This is NOT my guard" fires `SosService.raise` with booking context and crew fanout.
- [ ] SOS works (records + ops-audit) during DISPATCHING and CONFIRMED-awaiting-crew; UI is mounted there.
- [ ] No-show watchdog (Redis `SET NX`, not @nestjs/schedule) auto-re-dispatches past the arrival deadline, single-pod-safe, with NO re-charge (escrow hold preserved), no-showing agency flagged; re-dispatch keeps the offer coarse and leaves Ops Room rekey to the agency device.
- [ ] `NO_PROVIDER` returns a real safety fallback (hotline / widen / escalate), client confirmed never charged.
- [ ] All listed gates green.

---

## Step 17 â€” Role routing + CPO activation + revocation

**Stage:** Apps Â· **Depends on:** Step 4 (server returns `account_kind` + `org{id,name}` + `must_set_password` + `membership_status` on `/agents/me` / `/auth/me`), Step 15 (agency CPO roster: `org_members` + `POST /org/cpos`) Â· **Resolves:** Â§35A Â§Aâ€“Â§F, PR1â€“PR6 (PR2/PR3/PR4 routing+activation, PR5 capability hiding, PR6 revocation)
**Goal (plain English):** Bravo is one app download that opens three different front doors â€” customer, agency, or guard (CPO) â€” and which door you get is decided entirely by what the server says your account is, not by anything the app picks. A guard logs in with the email/password their agency created, sets a real password on first login, gets a short "you belong to {agency}" walkthrough, then lands in a stripped-down guard interface. If the agency later removes or suspends that guard, the app shuts the door on them the next time it checks in.
**Why it matters / what breaks without it:** Without server-driven routing a managed CPO would land in the consumer client app (or the agency cockpit) and could see "book a guard," wallets, or accept jobs â€” none of which a worker may do. Routing off a client flag re-creates the `pendingProvider` stuck-screen bug class. Without mid-session revocation, a fired guard keeps a live guard interface (and stays in encrypted Ops Rooms) indefinitely.

**Self-contained context (inline â€” do not make the reader open the plan):**

- **THE RULE (Â§35A):** route purely from the **server's authenticated identity**, never a client-chosen flag. This is the lesson from the `pendingProvider` stuck-register bug â€” see `src/store/pendingProvider.ts` (now in-memory + reactive precisely so a cold launch routes by role only).
- **Discriminator precedence (Â§35A Â§A), computed server-side in Step 4 as `account_kind`:**
  1. **`cpo`** â€” user has an `agents` row with `type='cpo'` AND `managed_by_org_id` set, OR an `org_members` row where `member_role='cpo'` and `status='active'`. â†’ CPO interface.
  2. **`agency`** â€” company agent (`agents.type='company'`, `service_provider` role) OR `org_members` with `member_role='manager'`. â†’ Agency operator interface.
  3. **`individual`** â€” everything else (`users.role='individual'`, no agent/org membership). â†’ Client interface.
- **Extra server fields (Step 4):** `org: {id, name}`, `must_set_password: boolean` (true on the agency-set temp password / first login), `membership_status` (from `org_members.status`: `active|suspended|removed`).
- **Routing (Â§35A Â§B):** in the root, after auth bootstrap, mount **exactly one** of ClientNavigator / AgencyNavigator / **CpoNavigator** by `account_kind`.
  - A CPO **never sees `RoleSelectionScreen`** (`src/screens/auth/RoleSelectionScreen.tsx`) â€” they did not self-register.
  - **First login** (`must_set_password=true`) â†’ force the **CPO account-activation** flow first (set password â†’ optional biometric â†’ location + notification permissions â†’ "you belong to {agency}" + on-duty/SOS explainer), THEN the CPO home.
  - **Mid-session revocation (Â§35A Â§B/Â§F):** on every app-focus / token-refresh, re-check `membership_status`. If `!= 'active'`, force-logout to an "Your agency access has ended â€” contact your agency" screen, set the CPO **offline** (`PATCH /agents/me/duty {on_duty:false}`), and drop them from Ops Rooms.
- **Capability matrix the CPO build HIDES (Â§35A Â§D):** no "Protect me now"/booking wizard, no client wallet/credits, no client booking history/receipts, no family hub, no VBG client suite, **no incoming job offer (the agency accepts, never the CPO)**, no roster management, no assign-crew/name-leader, no multi-mission board, no org earnings rollup. A CPO sees only their own assigned mission, runs it **only if lead**, has Ops Room comms + SOS + own-share earnings + own docs.
- **Current code reality (verified):** `src/navigation/index.tsx` (RootNavigator) mounts `AuthNavigator` / `PermissionsScreen` / `MainNavigator`. `src/navigation/MainNavigator.tsx` branches: `isAgent = user?.role === 'agent' || user?.role === 'service_provider' || pendingProv` â†’ returns `<AgentNavigator/>`; else the client `Tab.Navigator` (Dashboard / MessengerTab / SecureTab / ProfileTab). `useAuthStore` (`src/store/authStore.ts`) holds `user` (mapped via `toUser(ApiUser)`); `initialize()`, `completeAuth()`, `biometricSignIn()` all call `authApi.me()` â†’ `{user}`; `signOut()` does the full runtime/Ops-Room/keychain teardown and is the function to reuse for forced logout. `agentApi.setDuty(on_duty)` lives at `src/services/api.ts:530`.

**Files to touch:**

- **EXTEND** `src/services/api.ts` â€” extend `ApiUser` (line ~202) with `account_kind?: 'individual'|'agency'|'cpo'`, `org?: {id: string; name: string} | null`, `must_set_password?: boolean`, `membership_status?: 'active'|'suspended'|'removed' | null`. Add `authApi.me()` already returns these once Step 4 ships; no new call needed. Add `agentApi` already has `setDuty` â€” reuse.
- **EXTEND** `src/store/authStore.ts` â€” carry the new fields through `toUser()` and the `User` type; add a selector/derived `accountKind` and `membershipStatus`. Add an action `recheckMembership()` that calls `authApi.me()` and, if `account_kind==='cpo' && membership_status!=='active'`, triggers the revocation path (set offline, signOut, route to access-ended).
- **EXTEND** `src/navigation/index.tsx` (RootNavigator) â€” switch the post-auth mount on `account_kind`. For `cpo` + `must_set_password` â†’ mount the activation flow before CpoNavigator.
- **EXTEND** `src/navigation/MainNavigator.tsx` â€” replace the `isAgent` role-string branch with `account_kind`: `agency`â†’`AgentNavigator`, `cpo`â†’`CpoNavigator`, else client tabs. Keep `pendingProvider` only for the agency self-signup window (it maps to `account_kind` not yet flipped server-side; leave as a fallback for `agency` only).
- **NEW** `src/navigation/CpoNavigator.tsx` â€” the 4-tab shell scaffold (On Duty / Mission / Comms / Me). (Tab contents are built in Step PX4; this step wires the shell + the activation gate + the access-ended screen.)
- **NEW** `src/screens/cpo/CpoActivationScreen.tsx` â€” first-login activation (set password â†’ optional biometric â†’ location+notification permission primers â†’ "you belong to {agency}" + on-duty/SOS explainer).
- **NEW** `src/screens/cpo/AccessEndedScreen.tsx` â€” terminal "Your agency access has ended â€” contact your agency" screen.
- **EXTEND** `src/navigation/types.ts` â€” add `CpoStackParamList`, `CpoActivation`, `AccessEnded` routes; thread into `RootStackParamList`.
- **REUSE (no change)** `src/store/authStore.ts signOut()` for the forced-logout teardown (it already drops the user from Ops Rooms / tears down the runtime / wipes at-rest).

**Backend how-to:** This step is mobile-only; it **consumes** the server fields added in Step 4 and reuses the roster endpoints from Step 15. The only backend call this step makes is `authApi.me()` (already `GET /auth/me` + `GET /agents/me`) and `agentApi.setDuty(false)` (`PATCH /agents/me/duty`). Do **not** re-derive `account_kind` client-side â€” read the server value. The session re-check is a plain authenticated `me()` re-fetch; if Step 4 also adds a session guard that 401/403s a suspended/removed CPO, treat that 401/403 on `me()` as a revocation signal too.

**Frontend / ops-console how-to:**

- **Root switch:** in `RootNavigator`, after `isAuthenticated && user`, read `user.account_kind`. Render: `individual` â†’ existing client `MainNavigator` tabs; `agency` â†’ `AgentNavigator`; `cpo` â†’ if `user.must_set_password` mount `CpoActivationScreen` (on completion, refresh `me()` so `must_set_password` clears, then fall through to `CpoNavigator`), else `CpoNavigator`. Keep the existing `PermGate`/PermissionsScreen behavior for `individual`/`agency`; CPO permissions are gathered inside activation.
- **Never show RoleSelection to a CPO:** RoleSelection lives only in the `AuthNavigator` self-register path; a CPO authenticates straight into the CPO branch, so do not add any RoleSelection route to `CpoNavigator`. Verify the login success handler routes by `account_kind`, not to RoleSelection.
- **Activation flow:** `CpoActivationScreen` steps â€” (1) set a new password (POST the change via the auth password-change endpoint; reuse the existing password change path), (2) optional biometric enrolment primer (reuse `expo-local-authentication` as `authStore.biometricSignIn` does), (3) location + notification permission primers (reuse `PermissionsScreen` patterns), (4) "you belong to **{org.name}**" identity card + a short on-duty/SOS explainer. On finish, call `authStore.completeAuth()`/`me()` to refresh and route into `CpoNavigator`.
- **Revocation re-check:** add an `AppState.addEventListener('change', â€¦)` (pattern already used in `src/screens/agent/AgentLiveTrackerScreen.tsx` and `BookingConfirmationScreen.tsx`) in a small CPO-scoped hook/effect (e.g. in `CpoNavigator`) that, on `active` + on token refresh, calls `authStore.recheckMembership()`. If revoked: `await agentApi.setDuty(false)` (best-effort), then `await authStore.signOut()` (this tears down Ops Rooms / runtime), then route the now-unauthenticated app to `AccessEndedScreen` (render it from the Auth branch via a transient flag, or as a standalone screen shown before the login form).
- **Capability hiding (PR5):** `CpoNavigator`'s 4 tabs register only CPO-scoped screens â€” no booking wizard, no client wallet, no IncomingOffer/OrgMissions/AssignCrew/OrgRoster. The hiding is structural (those screens are simply not in the CPO stack), not a runtime `if`.

**Security stop-conditions:**

- **Route only off the server-authenticated `account_kind`.** Never trust a client-set value; never add a "skip in dev" branch to the routing or to any guard. (CLAUDE.md: no weakening of guards.)
- **Forced logout must actually drop the CPO from Ops Rooms.** Reuse `authStore.signOut()` â€” it runs the existing runtime/Ops-Room/keychain teardown. Do not hand-roll a partial logout that leaves the encrypted group session live. **STOP/verify against the System Architecture Documentation** that a revoked member is removed from the booking/Ops-Room group via the existing rekey path (group keys are client-side; the server cannot evict a member from an E2E room) â€” the agency device owns the rekey, as in the conversations-scoped membership-intent drain.
- Do not log the temp/new password, tokens, or any key material during activation (the static log-audit test enforces this).

**Acceptance & tests:**

- **Direct unit:** a pure resolver test for the root switch â€” given `account_kind` âˆˆ {individual, agency, cpo} Ã— `must_set_password` true/false Ã— `membership_status` active/suspended/removed, assert the chosen navigator/screen (client tabs / AgentNavigator / CpoActivation / CpoNavigator / AccessEnded). Add a `recheckMembership()` store test: suspended/removed CPO â†’ calls `setDuty(false)` + `signOut()` + routes to AccessEnded; active CPO â†’ no-op.
- **Regression:** existing routing for `individual` and `agency`/`service_provider` is unchanged (the `pendingProvider` agency-signup window still works); run the app Jest project.
- **Gates:** `npm run typecheck` (mobile, must stay â‰¤ baseline 96); `npm run lint`. Not near messaging crypto, so `test:crypto` only if the Ops-Room drop wiring is touched.
- **Manual smoke (real dev build):** (1) agency creates a CPO (Step 15) â†’ log in on a 2nd device with the temp password â†’ activation runs (password set, "you belong to {agency}") â†’ CPO home, no "Protect me now"/wallet/offer UI, RoleSelection never appears. (2) Agency suspends the CPO â†’ CPO backgrounds/foregrounds the app â†’ forced to AccessEnded, set offline, no longer in the Ops Room. (3) Individual and agency logins still route correctly.

**Done when:**

- [ ] Root mounts exactly one of ClientNavigator / AgencyNavigator / CpoNavigator strictly by server `account_kind`.
- [ ] A CPO never sees RoleSelectionScreen and is routed straight into activation-then-CPO.
- [ ] First login (`must_set_password`) runs activation (password â†’ biometric â†’ permissions â†’ agency/SOS explainer) before the CPO home.
- [ ] On focus/refresh a suspended/removed CPO is force-logged-out to AccessEnded, set offline, and dropped from Ops Rooms.
- [ ] CPO build structurally lacks booking/wallet/offer/roster/assign-crew/org-money screens.
- [ ] Typecheck â‰¤ 96, lint clean, unit tests pass.

## Step 18 â€” Shared backbone: stepper + activity feed + component library

**Stage:** Apps Â· **Depends on:** Step 4 (feed endpoints return `booking.status` + `mission.status`), Step 17 (CpoNavigator exists so the Bell/stepper can mount in all three shells) Â· **Resolves:** Part IV Â§28 (B1â€“B3), Â§34 (UI-state matrix), PX1, plus Â§25 (the shared stepper truth table)
**Goal (plain English):** Build the three foundations every role's app shares: one progress bar so the customer, the agency, and each guard always see the identical step of the mission; one notifications inbox (with a bell) so a missed offer or alert never just vanishes after the silent push wake; and one set of reusable building blocks (badges, rating stars, countdown pill, etc.) so all three apps look and behave the same. Consistency is trust for a safety app.
**Why it matters / what breaks without it:** Every client/agency/CPO screen in later steps renders the stepper and these components; building them once prevents three divergent progress bars telling three different stories. Without the ActivityCenter, the opaque FCM wakes (which by design carry no detail) leave the user with no durable, actionable history â€” a missed 30-second offer is simply gone.

**Self-contained context (inline â€” do not make the reader open the plan):**

- **B1 â€” `missionJourney.ts` + `<MissionStepper>` (Â§25, Â§28):** one **pure** helper `journeyStep(booking, mission?) â†’ { index, label, canAdvanceBy }` driving ONE horizontal 6-step bar rendered identically on client, agency, and CPO. The 6 steps and their real backing state (verified against the FSMs):

  | #   | Step label                 | Real state                              | Who advances          |
  | --- | -------------------------- | --------------------------------------- | --------------------- |
  | 1   | Searching for your detail  | booking `DISPATCHING`                   | system (auto-cascade) |
  | 2   | Accepted Â· assigning team | booking `CONFIRMED`, **no mission yet** | agency (assigns crew) |
  | 3   | Team dispatched            | mission `DISPATCHED`                    | lead CPO (Start)      |
  | 4   | En route to pickup         | mission `PICKUP`                        | lead CPO (Go live)    |
  | 5   | Protection active          | mission `LIVE`                          | lead CPO (Finish)     |
  | 6   | Completed                  | mission `COMPLETED`                     | â€”                   |

  Off-path side-states: **SOS** overlays any active step (a ribbon, not a 7th step); `CANCELLED` / `NO_PROVIDER` / `ABORTED` are terminal side-states with their own honest rendering. `canAdvanceBy` encodes who may advance from the current step (`system | agency | lead | none`) so the CPO field UI can gate the lead-only button.

- **Booking FSM context (verified `apps/auth-service/src/booking/state-machine.service.ts`):** `DRAFTâ†’PENDING_OPSâ†’OPS_APPROVEDâ†’PAYMENT_PENDINGâ†’CONFIRMEDâ†’LIVEâ†’COMPLETED` (+`CANCELLED`). The auto flow adds `DRAFTâ†’DISPATCHING`, `DISPATCHINGâ†’CONFIRMED`, `DISPATCHINGâ†’NO_PROVIDER`, `DISPATCHINGâ†’CANCELLED`. CONFIRMED-with-no-mission = "accepted, awaiting crew."
- **Mission FSM context (verified `apps/auth-service/src/ops/mission-state-machine.service.ts`):** `DISPATCHEDâ†’PICKUPâ†’LIVEâ†’SOSâ†’COMPLETED|ABORTED`.
- **B2 â€” ActivityCenter + notification Bell (Â§28, Â§34):** a **durable, role-filtered, locally-persisted** feed that turns opaque FCM wakes into glanceable, actionable rows (offers, accepts, status changes, payments, SOS). On each data-wake the app **fetches detail from existing endpoints** (exactly as chat does on a wake) and appends a row â€” the push payload itself stays content-free. Offer rows are actionable with a live countdown (bound to `expires_at`). A Bell + unread badge sits on every header. **This keeps push opaque (audit P0-N8): the FCM-facing channel payload is exactly `{userId, eventClass, eventId}` â€” detail is fetched, never carried.**
- **B3 â€” shared component library (Â§28):** `StepperBar`, `TrustBadgeRow`, `VerificationBadge`, `RatingStars` (display + input), `RoleBadge`, `ActivityRow`, `EncryptionPill`, `CountdownPill` (offer TTL), `EmptyState`, `PermissionPrimer`. **All RTL- and text-scale-aware** â€” wrap StyleSheets with `scaleTextStyles` and respect `I18nManager.isRTL`.
- **Cross-app rule (Â§34):** one truth via the shared stepper; a monotonic guard so apps polling on different schedules never appear to go backwards; deep-links resolve through the existing `navigationRef` (`src/navigation/navigationRef.ts`); offline = freeze at last-known + an "offline" tint, never fabricate a terminal state; never show "done"/"safe" unless the server confirmed it.
- **Current code reality (verified):** no `MissionStepper`, `ActivityCenter`, or `missionJourney.ts` exist yet (greenfield). `src/utils/scaling.ts` exports `scale`, `scaleFont`, `scaleTextStyles<T>(styles): T`, and `useResponsive()`. RTL via `I18nManager` is already used in `src/services/api.ts`. `src/screens/booking/bookingStatus.ts` has `describeStatus`, `resumeTargetFor`, `findResumableBooking` and only knows the legacy statuses â€” it does **not** yet include `DISPATCHING`/`NO_PROVIDER`; the new stepper must understand them. `navigationRef` lives at `src/navigation/navigationRef.ts`.

**Files to touch:**

- **NEW** `src/screens/booking/missionJourney.ts` â€” the pure `journeyStep(booking, mission?)` helper + step/label/side-state constants + `canAdvanceBy`. No React, no I/O, no backend logic (pure â†’ trivially unit-testable).
- **NEW** `src/components/mission/MissionStepper.tsx` â€” the horizontal 6-step bar consuming `journeyStep(...)`; SOS overlay ribbon; Cancelled/No-provider/Aborted terminal rendering. RTL + `scaleTextStyles`.
- **NEW** `src/components/ui/` shared library: `StepperBar.tsx`, `TrustBadgeRow.tsx`, `VerificationBadge.tsx`, `RatingStars.tsx`, `RoleBadge.tsx`, `ActivityRow.tsx`, `EncryptionPill.tsx`, `CountdownPill.tsx`, `EmptyState.tsx`, `PermissionPrimer.tsx` (one file each; all RTL + scale-aware).
- **NEW** `src/store/activityStore.ts` â€” Zustand store for the durable, role-filtered activity feed (persisted locally; append-on-wake; unread count; per-role filter). Mirror the persistence/owner-keying discipline used by the messenger store (wipe/scope per identity).
- **NEW** `src/screens/activity/ActivityCenterScreen.tsx` + `src/components/ActivityBell.tsx` â€” the feed screen + the header bell with unread badge.
- **EXTEND** `src/screens/booking/bookingStatus.ts` â€” add `DISPATCHING` and `NO_PROVIDER` to the status config/`describeStatus` and to `resumeTargetFor` (DISPATCHINGâ†’Finding, NO_PROVIDERâ†’empty state) so the stepper and resume logic agree. (Resume routing detail itself is finished in the client-UI step; here add the status knowledge the stepper depends on.)
- **REUSE (no change)** `src/utils/scaling.ts` (`scaleTextStyles`, `useResponsive`), `src/navigation/navigationRef.ts`.

**Backend how-to:** Mostly frontend. The only backend dependency (owned by Step 4 and the feed steps) is that the three feed endpoints each return **both** `booking.status` and `mission.status` so `journeyStep` has its inputs: client `GET /bookings/:id`, agency `GET /org/missions`, CPO `GET /agents/me/active-mission`. Confirm those fields are present; if a feed omits `mission.status`, that is a one-field read addition in the respective endpoint (no FSM/crypto change). The ActivityCenter fetches row detail from these same existing endpoints on each opaque wake â€” no new "detail in push" path.

**Frontend / ops-console how-to:**

- **`journeyStep` (pure):** signature `journeyStep(booking: {status: string}, mission?: {status: string} | null): {index: number; label: string; canAdvanceBy: 'system'|'agency'|'lead'|'none'; sos: boolean; sideState?: 'CANCELLED'|'NO_PROVIDER'|'ABORTED'}`. Map: `DISPATCHING`â†’1/system; `CONFIRMED` & no missionâ†’2/agency; mission `DISPATCHED`â†’3/lead; `PICKUP`â†’4/lead; `LIVE`â†’5/lead; `COMPLETED`â†’6/none. `mission.status==='SOS'` â†’ `sos:true`, keep `index` at the last active step. Terminal `CANCELLED`/`NO_PROVIDER` (booking) / `ABORTED` (mission) â†’ `sideState`. Add a **monotonic clamp helper** so a slow poll can't render a lower index than already shown (cross-app Â§34 rule).
- **`<MissionStepper>`:** render the 6 dots/labels, fill up to `index`, show the SOS ribbon when `sos`, and render the side-state banner when `sideState` is set. Lay out RTL-aware (reverse step order under `I18nManager.isRTL`); wrap text styles with `scaleTextStyles`.
- **ActivityCenter / Bell / store:** on each push data-wake (hook into the existing wake path that chat uses), look up the event by `eventId`, fetch its detail from the relevant existing endpoint, then `activityStore.append(row)` (role-filtered). Persist locally and scope to the signed-in identity (wipe on user switch, like the messenger store). The Bell shows `unreadCount`; tapping a row deep-links via `navigationRef` to the right screen (offerâ†’IncomingOffer overlay, accepted/no-providerâ†’booking, mission-assignedâ†’tracker, SOSâ†’SOS). Offer rows render a `<CountdownPill>` bound to `expires_at`.
- **Component library:** keep each component presentational and prop-driven; `RatingStars` supports both display and input modes; `EncryptionPill` is a static "end-to-end encrypted" affordance (never renders any key material). Mount the Bell in the headers of all three shells (client tabs, AgentNavigator, CpoNavigator).

**Security stop-conditions:**

- **Push opacity (P0-N8):** the ActivityCenter must build its rows by **fetching detail on wake**, exactly like chat. The FCM-facing channel payload stays `{userId, eventClass, eventId}` â€” never let the activity feed depend on (or cause anyone to add) `bookingId`/`kind`/address into the push payload. **STOP/verify against the System Architecture Documentation** before touching anything that shapes the push channel message.
- **No plaintext/keys in logs or in `EncryptionPill`/`ActivityRow`** â€” render only non-sensitive metadata; the static log-audit test enforces no plaintext message bodies/keys.
- The stepper/feed are metadata-only views; they never read or render decrypted Ops-Room message bodies.

**Acceptance & tests:**

- **Direct unit (the pure helper is the high-value test):** `missionJourney.spec.ts` â€” every `(booking.status, mission?.status)` combination maps to the expected `{index, label, canAdvanceBy, sos, sideState}`; SOS overlays without changing index; CANCELLED/NO_PROVIDER/ABORTED produce side-states; the monotonic clamp never regresses index. Add an `activityStore` test: append/dedupe by `eventId`, unread count, per-role filter, identity-scoped wipe.
- **Component:** snapshot/RTL test that `MissionStepper` and at least `CountdownPill`/`RatingStars` render under `I18nManager.isRTL=true` and with scaled text.
- **Regression:** `bookingStatus.ts` additions don't break existing `describeStatus`/`resumeTargetFor`/`findResumableBooking` (run the app Jest project; touch the `booking` project if booking helpers are covered there).
- **Gates:** `npm run typecheck` (mobile, â‰¤ baseline 96); `npm run lint`. Run `npm run test:crypto` only if the wake/detail-fetch wiring brushes the messenger runtime; the feed itself should not.
- **Manual smoke:** drive a booking through DISPATCHINGâ†’CONFIRMEDâ†’DISPATCHEDâ†’PICKUPâ†’LIVEâ†’COMPLETED on a dev build and confirm the same step lights up on client + agency + CPO within a poll cycle; trigger an offer wake with the app backgrounded and confirm an actionable, countdown-bearing row appears in the ActivityCenter and the Bell badge increments.

**Done when:**

- [ ] `journeyStep` is a pure, fully unit-tested helper covering all 6 steps + SOS overlay + 3 terminal side-states + monotonic clamp.
- [ ] `<MissionStepper>` renders identically (RTL + scaled) on client, agency, and CPO from the same helper output.
- [ ] ActivityCenter + Bell show a durable, locally-persisted, role-filtered feed built by fetching detail on each opaque wake (push payload unchanged).
- [ ] The shared component library (StepperBar, TrustBadgeRow, VerificationBadge, RatingStars, RoleBadge, ActivityRow, EncryptionPill, CountdownPill, EmptyState, PermissionPrimer) exists, all RTL + `scaleTextStyles`-aware.
- [ ] `bookingStatus.ts` understands `DISPATCHING`/`NO_PROVIDER`.
- [ ] Typecheck â‰¤ 96, lint clean, unit + component tests pass; push payload remains `{userId, eventClass, eventId}`.

---

## Step 19 â€” CLIENT app UI (Finding / No-detail / Accepted / extended Confirmation+Live + shared stepper)

**Stage:** Apps Â· **Depends on:** Step 15 (booking FSM `DISPATCHING`/`NO_PROVIDER` + `dispatch_mode='auto'` submit branch), Step 16 (`GET /bookings/:id/provider`), Step 18 (`missionJourney.ts` + `<MissionStepper>` shared backbone), Step 12 (client "provider-accepted"/"no-provider" push wake) Â· **Resolves:** Part IV Â§29, Â§34 client-state matrix, Â§35 endpoints; Phase 8 (Â§13); PX2

**Goal (plain English):** Give the customer the three-screen Uber-style flow: a "Protect me now" entry, a calm "finding your detailâ€¦" search screen, an "agency accepted â€” here's their â˜…rating and track record" reveal, and an honest "no one available" dead-end. The request now submits as fully-automatic (no admin approval) and pre-checks the wallet so an agency is never offered a job the client can't pay for. Every status screen shows the same shared progress bar.

**Why it matters / what breaks without it:** This is the entire customer-facing surface of auto-dispatch; without it the new backend has no UI and the client is stuck on the legacy admin-approval screens. Skipping the affordability pre-check strands an agency with an unpayable job; skipping the `DISPATCHING`/`NO_PROVIDER` resume + active-mission fix traps the client so "try again" is impossible.

**Self-contained context (inline â€” do not make the reader open the plan):**

- **Locked decisions:** D1 fully automatic (no admin in the loop â€” the old "ops handler watches your trip" copy is now FALSE, rewrite it); D2 charge-on-accept into escrow (so the client is NOT charged while searching â€” the search screen must say "you won't be charged until a detail accepts"); D4 nearest agency within same region (AE/SA/BD/GB); D7 accept locks in the agency but crew is assigned a moment later (so the "accepted" screen reads _"agency accepted â€” your detail is being assigned"_, then the stepper advances).
- **Booking FSM (extended in Step 15, `apps/auth-service/src/booking/state-machine.service.ts`):** auto request is `DRAFT â†’ DISPATCHING` (actor CLIENT); `DISPATCHING â†’ CONFIRMED` (SYSTEM, = "accepted, awaiting crew"); `DISPATCHING â†’ NO_PROVIDER` (SYSTEM, terminal); `DISPATCHING â†’ CANCELLED`. Legacy `PENDING_OPS â†’ OPS_APPROVED â†’ PAYMENT_PENDING â†’ CONFIRMED â†’ LIVE â†’ COMPLETED` stays intact.
- **Shared stepper (Step 18, `src/screens/booking/missionJourney.ts`):** pure `journeyStep(booking, mission?) â†’ {index, label, canAdvanceBy}` â†’ 6 steps: 1 Searching (`DISPATCHING`) Â· 2 AcceptedÂ·assigning team (`CONFIRMED`, no mission) Â· 3 Team dispatched (mission `DISPATCHED`) Â· 4 En route (`PICKUP`) Â· 5 Protection active (`LIVE`) Â· 6 Completed. SOS overlays any active step; `NO_PROVIDER`/`CANCELLED`/`ABORTED` are terminal side-states.
- **Reuse points (verified in code):** `OpsRoomReviewScreen.tsx` already polls `GET /bookings/:id` every `POLL_EVERY_MS = 4000` (line 34) and branches on status (`OPS_APPROVED`/`PAYMENT_PENDING`/`CONFIRMED`/`LIVE`/`CANCELLED`, lines 270â€“291) with a 5-min hard cap (`pollGaveUp`) â€” repurpose this exact poll for the `DISPATCHING` "Finding" state. `src/screens/booking/bookingStatus.ts` owns `resumeTargetFor(id, raw)` (returns `OpsRoomReview`/`BookingConfirmation`/`LiveTracking`) and the `RESUMABLE` set + `describeStatus` CONFIG map. The one-active-mission guard lives in `BookingHomeScreen.tsx` (line 128, `activeBooking = bookings.find(...)` driven by `findResumableBooking`/`RESUMABLE`). The client live screen is `src/screens/liveops/LiveTrackingScreen.tsx` (reads `route.params.bookingId`, polls telemetry, routes to `SOSScreen`). `CreditPaywallScreen.tsx` exists and is registered with params `{bookingId?, source?: 'booking-flow'|'opsroom'|'wallet', amountDue?}`.
- **New client endpoint (Step 16):** `GET /bookings/:id/provider` â†’ `{ display_name, call_sign, rating, jobs_total }` (coarse-safe; NO pickup/dropoff/address â€” that stays agency-only post-accept per LB1). `dispatch_mode:'auto'` is added to the `POST /bookings` body.
- **Navigation facts (verified):** `BookingStackParamList` (`src/navigation/types.ts`) already has `BookingConfirmation`, `LiveTracking:{bookingId}`, `SOSScreen:{bookingId}`, `TripSummary:{bookingId}`, `OpsRoomReview`, `CreditPaywall`. `bookingApi.create` body (`src/services/api.ts:320`) currently has `booking_mode?:'now'|'later'` but NO `dispatch_mode` â€” add it. Routing to the client tabs vs agent stack happens in `MainNavigator.tsx:190` (`isAgent`), so client screens live under `BookingNavigator`.

**Files to touch:**

- EXTEND `src/services/api.ts` â€” `bookingApi.create` body: add `dispatch_mode?: 'auto'`. Add `bookingApi.getProvider(id) => authHttp.get<{display_name; call_sign; rating; jobs_total}>('/bookings/${id}/provider')`.
- NEW `src/screens/booking/FindingDetailScreen.tsx` â€” the `DISPATCHING` search state (radar animation, "you won't be charged until a detail accepts" trust line, optional cascade-reassurance copy, **Cancel** â†’ `bookingApi.cancel`). Built by repurposing `OpsRoomReviewScreen`'s 4s poll on `GET /bookings/:id`; on flip to `CONFIRMED` route to the Accepted reveal, on `NO_PROVIDER` route to NoDetail, on `CANCELLED` go home.
- NEW `src/screens/booking/NoDetailScreen.tsx` â€” `NO_PROVIDER` calm dead-end (NOT a red error): "no detail available right now," "you weren't charged," Try-again / Schedule-for-later CTAs.
- NEW `src/screens/booking/AgencyAcceptedScreen.tsx` (or an inline reveal card) â€” agency name, â˜…`rating`, "`jobs_total` missions completed," trust line, then the shared `<MissionStepper>`; data from `bookingApi.getProvider`.
- EXTEND `src/screens/booking/BookingConfirmationScreen.tsx` â€” render `<MissionStepper>`; relabel any "awaiting dispatch"/"ops will approve" copy to the auto flow.
- EXTEND `src/screens/liveops/LiveTrackingScreen.tsx` â€” render `<MissionStepper>` above the map; keep the SOS CTA reachable; show the agency â˜… chip.
- EXTEND `src/screens/booking/bookingStatus.ts` â€” add `DISPATCHING` + `NO_PROVIDER` to the `CONFIG` map; add `DISPATCHING` to `RESUMABLE`; extend `resumeTargetFor` so `DISPATCHING â†’ {screen:'FindingDetail'}` and `NO_PROVIDER â†’ {screen:'NoDetail'}` (add both to the `ResumeTarget` union).
- EXTEND `src/screens/booking/BookingHomeScreen.tsx` â€” the request wizard CTA preset to auto; affordability pre-check before submit; ensure `NO_PROVIDER` does NOT count as an active booking (see guard fix below).
- EXTEND `src/screens/DashboardScreen.tsx` â€” add the "Protect me now" hero that deep-links into the auto wizard (keep the SOS bar).
- EXTEND `src/navigation/BookingNavigator.tsx` + `src/navigation/types.ts` â€” register `FindingDetail:{bookingId}`, `NoDetail:{bookingId}`, `AgencyAccepted:{bookingId}` in `BookingStackParamList`.
- (v1.1) NEW `RateAgencyScreen` (writes `lite_bookings.rating` via `POST /bookings/:id/rating`), `ReceiptScreen` (`GET /bookings/:id/receipt`), `IdentityVerifyScreen` (`GET /bookings/:id/verify-code`), `ShareLiveTripScreen` (`POST /bookings/:id/share`); wire "View receipt"/"Rate this agency" into `TripSummaryScreen.tsx`.

**Backend how-to:** Pure frontend for MVP â€” the auto-submit branch, `GET /bookings/:id/provider`, and the lifecycle/active-mission backend fix are owned by Steps 15/16/17. This step only sends `dispatch_mode:'auto'` and consumes the new read endpoint. (Cross-ref: the active-mission trap fix LB17 must let terminal/failed states `NO_PROVIDER`/`CANCELLED` free the guard â€” that's the lifecycle step; on the client side, simply ensure `NO_PROVIDER` is NOT in `RESUMABLE`/`activeBooking`.)

**Frontend / ops-console how-to:**

1. **Submit as auto + affordability pre-check.** In the wizard's submit handler, when the auto flag is on, set `dispatch_mode:'auto'` on `bookingApi.create`. Before/at submit, compare the price estimate against wallet balance; if short, `navigation.navigate('CreditPaywall', {source:'booking-flow', amountDue})` and only proceed to dispatch after top-up. (Reuse the existing estimate + wallet read.)
2. **FindingDetailScreen.** Copy `OpsRoomReviewScreen`'s poll skeleton (4s interval on `bookingApi.getById`, 5-min `pollGaveUp` cap, lockBack while healthy). Render the radar + trust line + Cancel. On status: `CONFIRMED` â†’ `navigation.replace('AgencyAccepted', {bookingId})`; `NO_PROVIDER` â†’ `replace('NoDetail', {bookingId})`; `CANCELLED` â†’ `popToTop()`.
3. **AgencyAccepted reveal.** Fetch `bookingApi.getProvider(id)`, show name/â˜…/jobs + the stepper at step 2, then "Continue" â†’ `BookingConfirmation`/`LiveTracking`.
4. **Resume + guard.** Extend `resumeTargetFor` and `RESUMABLE` (add `DISPATCHING` only; keep `NO_PROVIDER` terminal). Verify `BookingHomeScreen.activeBooking` excludes `NO_PROVIDER`/`CANCELLED` so "Protect me now" is tappable again after a failed search.
5. **Stepper everywhere.** Drop `<MissionStepper>` (from Step 18) into Confirmation + LiveTracking, feeding it `{booking.status, mission?.status}`.
6. **Keep SOS reachable** from Finding, Accepted, Confirmation, and Live (the SOS CTA â†’ `SOSScreen:{bookingId}` exists; do not gate it behind mission-LIVE â€” SOS must work during `DISPATCHING`/`CONFIRMED` per LB13).

**Security stop-conditions:** The Ops Room (opened at accept by the server) is metadata-only via `ensureBookingOpsRoom` â€” the client just deep-links into the existing Messenger conversation; do NOT write envelopes or touch group keys. The "provider-accepted"/"no-provider" push wake stays opaque: the app reacts by re-fetching `GET /bookings/:id` â€” never read booking details from the FCM payload. The coarse-safe rule (LB1): the client provider card shows name/rating/jobs only; do not surface any agency-side precise-location field. STOP/verify against the System Architecture Documentation before adding any new message type or reading anything beyond `{userId, eventClass, eventId}` from a push.

**Acceptance & tests:**

- **New tests (`booking` Jest project, `npm test -- --selectProjects=booking`):** `bookingStatus.spec` â€” `resumeTargetFor('id','DISPATCHING')â†’FindingDetail`, `'NO_PROVIDER'â†’NoDetail`, `describeStatus('DISPATCHING'/'NO_PROVIDER')` non-fallback; `findResumableBooking` treats `NO_PROVIDER` as terminal (not active).
- **Regression:** rerun the `booking` project (covers the existing `OpsRoomReview`/confirmation logic you derived from). `npm run test:crypto` is not required (no messaging change â€” only deep-linking into an existing room).
- **Gates:** `npm run typecheck` (mobile, must stay â‰¤ baseline 96 â€” adding the new `ResumeTarget` union members and screen params must not regress it); `npm run lint`.
- **Manual smoke (dev build, real device, 2 accounts):** submit auto â†’ "Findingâ€¦" (trust line shows, no charge) â†’ accept on a 2nd device â†’ "Accepted â˜…rating Â· N missions" â†’ stepper advances â†’ SOS reachable throughout; empty pool â†’ "no detail available, you weren't charged" â†’ "try again" works (not trapped); relaunch mid-search returns to FindingDetail. Test one error path: cancel while searching â†’ no charge, returns home.
- **Do not commit on a red gate; never `--no-verify`.**

**Done when:**

- [ ] Auto request submits `dispatch_mode:'auto'` and ends in `DISPATCHING`, not `PENDING_OPS`.
- [ ] FindingDetail / NoDetail / AgencyAccepted screens render and route on status flips.
- [ ] `bookingStatus.ts` resumes `DISPATCHING` to FindingDetail and keeps `NO_PROVIDER` terminal; active-mission guard no longer traps after a failed search.
- [ ] Shared `<MissionStepper>` shows on Confirmation + LiveTracking + Accepted.
- [ ] Affordability short-balance routes to CreditPaywall before dispatch; trust line "no charge until accept" is shown.
- [ ] SOS is one tap from every auto-flow screen.
- [ ] typecheck â‰¤ 96, lint clean, booking project green, manual smoke (golden + cancel/empty paths) passes.

---

## Step 20 â€” AGENCY app UI (ops cockpit + global incoming-offer interrupt + multi-mission board + assign-crew + roster caps)

**Stage:** Apps Â· **Depends on:** Step 9 (`GET /dispatch/offers/current` + accept/reject endpoints), Step 16 (`GET /org/summary`), Step 17 (`GET /org/missions` + `POST /org/bookings/:id/crew`), Step 15 (roster rules: 10-cap, one-email-one-agency 409, can't-remove-active-lead), Step 18 (`missionJourney.ts` + `<MissionStepper>`) Â· **Resolves:** Part IV Â§30, Â§34 agency-offer states; Phase 9 (Â§14), Phase 15 (Â§23), Phase 16 (Â§24); PX3

**Goal (plain English):** Turn the agency's existing dashboard into a control room: a go-online switch, a "X of Y guards free" capacity strip, a board of all current jobs, and a full-screen pop-up that interrupts from any screen when a new job is offered (with a 30-second countdown ring, distance/ETA/pay, and an inline "you can crew this" check). Accept locks in the agency and charges the client; the agency then picks which guards go and taps one as leader, which creates the mission. The roster screen enforces the 10-guard cap, the one-email-one-agency rule, and blocks firing the leader of a running mission.

**Why it matters / what breaks without it:** The agency is the only party that can accept jobs (D3) and crew them (D7); without this UI the dispatch engine has no one to answer the offer, no job is ever accepted, and no mission is ever created. Without the global interrupt + triple-surfacing, a 30-second offer is missed; without capacity gating the agency accepts jobs it can't staff.

**Self-contained context (inline â€” do not make the reader open the plan):**

- **Locked decisions:** D3 the AGENCY (company agent) accepts the whole job; D5 agency registers up to ~10 real CPO login emails, one email = one agency at a time (fire/leave to free it); D6 one agency runs several concurrent missions, bounded by free-CPO capacity; D7 accept does NOT auto-pick crew â€” assigning crew + naming a leader is a separate step and _that step creates the mission_ (it replaces the old admin "dispatch" click).
- **Offer model:** an offer is live for `OFFER_TTL_SECONDS = 30`; the agency Accepts (â†’ charge client into escrow + Ops Room opens client+agency only) or Declines (â†’ cascades to next-nearest). `GET /dispatch/offers/current` returns the caller's single live `OFFERED` offer joined with **coarse** booking data (region + bucketed distance/ETA + price + `expires_at`) â€” NO exact pickup/dropoff pre-accept (LB1). Accept/reject 409 if the offer is no longer `OFFERED` ("passed to another detail" â€” neutral tone, no fault).
- **Capacity (D6, from `GET /org/summary`):** `free_cpos = active roster CPOs âˆ’ CPOs on a non-completed mission âˆ’ Î£ cpo_count of this agency's CONFIRMED-no-mission bookings`; show as "X of Y guards free." The offer card shows "N guards needed Â· M free" inline.
- **Shared stepper (Step 18):** 6 steps Searching â†’ AcceptedÂ·assigning team â†’ Team dispatched â†’ En route â†’ Protection active â†’ Completed; render it on every mission row and the per-mission monitor.
- **Reuse points (verified in code):** the agency runs inside the existing **`AgentNavigator`** (stack, not tabs) reached via `MainNavigator.tsx:496` (`isAgent` â†’ `<AgentNavigator/>`). `AgentDashboardScreen.tsx` already has the duty toggle (`agentApi.setDuty` â†’ `PATCH /agents/me/duty`, lines 242â€“261), `isOrg = me?.agent.type === 'company'` (line 313), and an org-only "CPO Roster" tile â†’ `navigation.navigate('OrgRoster')` (line 320). The global **incoming-call overlay pattern** is in `MainNavigator.tsx`: `setIncomingCallHandler((data)=>{ if(!navigationRef.isReady()) return; navigationRef.navigate('Main',{screen:..., params:...}) })` (lines 286â€“394) using `src/navigation/navigationRef.ts` â€” mirror this for the incoming offer. `orgApi` (`src/services/api.ts:733`) has `listCpos()/createCpo()/setCpoStatus()` over `RosterMember{member_user_id, display_name, email, call_sign, member_role, status, agent_status, created_at}`. `OrgRosterScreen.tsx` + `OrgCreateCpoScreen.tsx` exist. `AgentLiveTrackerScreen.tsx` (per-mission monitor) polls every 4s (line 281).
- **New endpoints (all confirmed ABSENT today â€” created in Steps 9/16/17):** `dispatchApi.getCurrentOffer/accept/reject`; `GET /org/summary`; `GET /org/missions`; `POST /org/bookings/:id/crew` body `{cpo_user_ids: string[], lead_user_id: string}`. All `/org/*` are `OrgManagerGuard`-gated and resolve the caller's org server-side.

**Files to touch:**

- EXTEND `src/services/api.ts` â€” add `dispatchApi = { getCurrentOffer(), accept(id), reject(id, reason?) }`; add `orgApi.getSummary()`, `orgApi.listMissions()`, `orgApi.assignCrew(bookingId, {cpo_user_ids, lead_user_id})`. Put a stable `Idempotency-Key: accept-<offerId>` header on accept (mirror `bookingApi.payWithCredits`'s `paywc-` pattern; separator `-`, never `:`).
- EXTEND `src/screens/agent/AgentDashboardScreen.tsx` â€” for `isOrg`: keep online toggle; add a **capacity strip** ("X of Y guards free" from `getSummary`), today's tiles, and a **persistent active-offer banner** (poll `getCurrentOffer` while Online).
- NEW `src/screens/agent/IncomingOfferScreen.tsx` â€” full-screen interrupt: countdown **ring** bound to server `expires_at` (not a local 0-start timer), coarse route/distance/ETA/pay, inline "N needed Â· M free," Accept/Decline. On Accept â†’ `dispatchApi.accept` then `navigate('AssignCrew', {bookingId})`; on Decline â†’ `dispatchApi.reject`; on countdown-zero or 409 â†’ "offer passed to another detail."
- NEW `src/screens/agent/OrgMissionsScreen.tsx` â€” multi-mission board grouped **Needs crew / Active / Recent**, each row with `<MissionStepper>`, crew, leader, SOS flag; data from `orgApi.listMissions`.
- NEW `src/screens/agent/AssignCrewScreen.tsx` (sheet) â€” roster picker (free/busy badges from `listCpos` + summary), tap one â˜… Leader, confirm â†’ `orgApi.assignCrew` (creates the mission). On success, the row moves to "Team dispatched."
- EXTEND `src/screens/agent/OrgRosterScreen.tsx` â€” "X / 10 used" counter on Add, surface the one-email-one-agency `409 email_already_in_an_agency` and `409 roster_full`, per-row on-duty + "on mission" tag, fire-guard surfacing the `409 reassign_leader_first` block.
- EXTEND `src/screens/agent/AgentLiveTrackerScreen.tsx` â€” render `<MissionStepper>`; status buttons stay hidden (leader-only is the CPO app).
- EXTEND `src/navigation/AgentNavigator.tsx` + `src/navigation/types.ts` (`AgentStackParamList`) â€” register `OrgMissions`, `AssignCrew:{bookingId}`, `IncomingOffer:{offerId, bookingId}`.
- EXTEND `src/navigation/MainNavigator.tsx` â€” register a **global incoming-offer handler** (mirror `setIncomingCallHandler` / `navigationRef.navigate`) surfaced by the offer push wake; gate it to `isAgent`/`isOrg` so clients/CPOs never see it.
- (v1.1) NEW/EXTEND `EarningsScreen.tsx` (org payout rollup, `GET /org/earnings`), a Reputation panel (`GET /agents/me/reputation`), CpoDetail drill-in.

**Backend how-to:** Pure frontend â€” the offer/summary/missions/crew endpoints + the capacity formula + the roster 409s + the accept-charges-escrow transaction are owned by Steps 9/15/16/17. This step consumes them. (Reminder of the server contract this UI relies on: accept must be a race-safe conditional `UPDATE dispatch_offers SET status='ACCEPTED' WHERE id=$1 AND status='OFFERED' AND expires_at>NOW() RETURNING` with the debit in the same txn â€” the UI must treat a 409/empty result as "offer passed," never retry into a double-charge.)

**Frontend / ops-console how-to:**

1. **Global interrupt (triple-surface).** In `MainNavigator`, register an offer handler beside `setIncomingCallHandler`: on the `dispatch` push wake, call `dispatchApi.getCurrentOffer`; if an offer exists and `navigationRef.isReady()`, `navigationRef.navigate('Main', {screen:'SecureTab', params:{screen:'IncomingOffer', params:{offerId, bookingId}}})` (or the AgentNavigator route, matching the existing nested-navigate cast). Also poll `getCurrentOffer` every few seconds while Online, and render the dashboard banner â€” so a missed push still surfaces.
2. **Countdown ring.** Bind the ring to `expires_at` from the server payload (compute remaining = `expires_at âˆ’ now`), add a small clock-skew grace; never start from a hardcoded 30. On expiry, flip to the neutral "passed" state.
3. **Accept â†’ AssignCrew.** Accept calls `dispatchApi.accept(offerId)`; on success navigate to `AssignCrew`. On network error after accept, **re-fetch truth** (`getCurrentOffer` / `listMissions`) rather than assuming failure â€” a lost-200 may have already won the offer (idempotency-keyed accept makes a re-tap safe).
4. **AssignCrew.** Show roster with free/busy from `listCpos` + summary; require exactly `booking.cpo_count` picks (or the allowed range) and one â˜… leader âˆˆ picks; `orgApi.assignCrew`. Surface server validation errors (guard not free, wrong count) inline.
5. **Roster caps.** Show "X / 10"; disable Add at 10; map the three 409 codes to friendly messages; block firing an active lead and show "reassign the leader first."

**Security stop-conditions:** When the agency assigns crew, the CPOs are added to the existing Ops Room â€” but the **server cannot distribute the Signal group key** (LB2/Correction 5): the agency company device must own the rekey/sender-key add (mirror the conversations-scoped membership-intent drain, NOT the `department_channels`-only path). This UI triggers the add; STOP/verify against the System Architecture Documentation that the agency device performs the group rekey before assuming a CPO can read the room. The offer card must show only coarse data (LB1) â€” never render exact pickup/dropoff pre-accept. Push stays opaque: react to the wake by calling `getCurrentOffer`, never read offer details from FCM. No "skip in dev" on `OrgManagerGuard`.

**Acceptance & tests:**

- **New tests (`booking` Jest project + agent screen tests under `src/screens/agent/__tests__`):** offer-countdown helper computes remaining from `expires_at` (not 0-start) and handles already-expired; capacity-strip math renders "X of Y free"; AssignCrew validation (count match, leader âˆˆ picks, busy guard rejected) before the network call.
- **Regression:** rerun the `booking` project and the existing agent screen tests; `npm run test:crypto` only if the agency-device rekey wiring is touched here (if so, run it â€” but the rekey itself is Step 17/LB2's deliverable).
- **Gates:** `npm run typecheck` (mobile â‰¤ baseline 96 â€” new `AgentStackParamList` routes and `dispatchApi`/`orgApi` types must not regress it); `npm run lint`.
- **Manual smoke (dev build, 3 accounts â€” 1 client, 2 agencies):** agency Online â†’ capacity strip shows free count â†’ client requests â†’ offer interrupts from any screen with a live countdown ring â†’ Decline cascades to the 2nd agency â†’ 2nd Accepts â†’ AssignCrew (pick 2 + â˜…leader) â†’ mission created, board shows it under Active with the stepper â†’ guards appear on their phones (Step 21). Error paths: let the offer expire ("passed to another detail"); try to assign a busy guard (rejected); add an 11th CPO (409 roster_full); add an email already in another agency (409); fire an active lead (blocked).
- **Do not commit on a red gate; never `--no-verify`.**

**Done when:**

- [ ] AgentDashboard (isOrg) shows online toggle + capacity strip + persistent active-offer banner.
- [ ] A new offer interrupts full-screen from any screen (push + poll-on-Online + banner), countdown bound to `expires_at`.
- [ ] Accept â†’ charge happens server-side â†’ AssignCrew â†’ `orgApi.assignCrew` creates the mission and crew.
- [ ] OrgMissions board groups Needs-crew / Active / Recent with the shared stepper.
- [ ] OrgRoster enforces 10-cap, surfaces one-email-one-agency 409 + can't-remove-active-lead.
- [ ] Offer card is coarse-only (no exact address pre-accept); push reactions re-fetch, never read FCM details.
- [ ] typecheck â‰¤ 96, lint clean, booking + agent tests green, 3-account smoke (cascade â†’ accept â†’ crew) passes.

---

## Step 21 â€” CPO (guard) app UI (new CpoNavigator 4-tab shell, lead-only one-tap mission control, capability lockdown)

**Stage:** Apps Â· **Depends on:** Step 20 (agency assigns crew â†’ CPO is on a mission + added to the Ops Room), Step 18 (`missionJourney.ts` + `<MissionStepper>`), Step 10 (lead-gated `complete` endpoint that opens settlement/`PENDING_RELEASE`), the role-separation backend (`account_kind`/`must_set_password`/`membership_status` on `/agents/me`) Â· **Resolves:** Part IV Â§31, Â§35A Â§Aâ€“Â§F (role separation + capability matrix), Â§34 CPO states; Phase 18 (Â§26); PX4, PR2â€“PR6

**Goal (plain English):** Give the guard their own stripped-down app: log in with the agency-issued email, land in a 4-tab shell (On Duty / Mission / Comms / Me), see only the mission their agency assigned them, and â€” if they're the team leader â€” run it with one context-aware button (Start â†’ Go-live â†’ swipe-to-Finish), like an Uber driver ending a trip. Non-leaders see the same job read-only and can chat + hit SOS. The guard's app must HIDE every client and agency power: no booking, no accepting offers, no roster, no org money.

**Why it matters / what breaks without it:** The lead literally cannot drive the mission stepper today â€” the field UI for Start/Go-live/Finish is unbuilt, so the agency never gets paid and the customer's progress bar never advances past "team dispatched." Routing a guard into the client or agency app (the `pendingProvider` stuck-register bug class) exposes them to powers they must not have and breaks the one-email-one-agency model.

**Self-contained context (inline â€” do not make the reader open the plan):**

- **Locked decisions:** D8 shared stepper + leader-only status changes + one-tap finish. Â§35A rule: Bravo is **one binary, three app experiences**, decided **at login from the server's authenticated identity, never a client flag** (the `pendingProvider` lesson). A managed CPO is a _worker_ and must get the CPO interface â€” not the client app, not the agency app.
- **The discriminator (Â§35A Â§A, server-computed `account_kind` on `/agents/me` or `/auth/me`, precedence):** (1) `cpo` if `agents.type='cpo'` AND `managed_by_org_id` set, OR `org_members.member_role='cpo'` + `status='active'` â†’ CPO interface; (2) `agency` if company agent (`agents.type='company'`, `service_provider` role) OR `org_members.member_role='manager'` â†’ agency interface; (3) `individual` otherwise â†’ client interface. Also return `org:{id,name}`, `must_set_password`, `membership_status`. Never trust a client-set value.
- **Mission FSM (`apps/auth-service/src/ops/mission-state-machine.service.ts`):** `DISPATCHED â†’ PICKUP â†’ LIVE â†’ SOS â†’ COMPLETED|ABORTED`. The lead advances it via the existing lead-gated endpoints. Shared stepper steps 3â€“6 map to mission `DISPATCHED`/`PICKUP`/`LIVE`/`COMPLETED`.
- **Â§35A Â§D capability matrix â€” what the CPO build MUST HIDE:** "Protect me now"/booking wizard âŒ, client wallet/credits top-up âŒ, client booking history/receipts âŒ, family hub âŒ, VBG client safety suite âŒ, **incoming job offer accept/decline âŒ (the agency accepts, never the CPO)**, roster management âŒ, assign-crew/name-leader âŒ, multi-mission board âŒ (sees ONLY their own assigned mission), org earnings/payouts âŒ (sees ONLY their own share). What it SHOWS: run an assigned mission (Start/Go-live/Finish) âœ… lead-only, Ops Room comms âœ…, SOS/lone-worker check-in âœ…, own credentials/docs âœ….
- **Reuse points (verified in code):** `agentApi` (`src/services/api.ts:462`) already has the lead-gated FSM calls â€” `missionPickup(id)` (`POST /agents/me/missions/:id/pickup`, `DISPATCHEDâ†’PICKUP`), `missionGoLive(id)` (`â€¦/go-live`, `PICKUPâ†’LIVE`), `missionComplete(id)` (`â€¦/complete`, `LIVEâ†’COMPLETED`) â€” each idempotency-keyed (`pickup-`/`golive-`/`complete-`). `agentApi.getActiveMission()` (`/agents/me/active-mission`) returns `{mission_id, short_code, status, is_lead, role, pickup_address, dropoff_address, pickup_time, region_label}` or null â€” drives the assigned-mission card and the lead/non-lead split. `agentApi.getMissionDeployment(id)` returns `crew_role.{is_lead, role, call_sign}`, `waypoints[]`, `dress_instructions`, and `booking.{pickup/dropoff}` â€” extend (Step 17) to also return `booking.status`, full `crew[]`, and client name for the roster-with-lead-starred view. `agentApi.raiseSos(id, {reason, lat?, lng?})` exists (60s-bucketed idempotency). `agentApi.setDuty(on_duty)` + `updateLocation(lat,lng)` for the duty toggle + heartbeat. `attendanceApi` (clockIn/clockOut/myShifts) for availability/attendance. The root role decision is `MainNavigator.tsx:190` (`isAgent = role==='agent' || role==='service_provider' || pendingProv`) â€” today there is NO `cpo` branch; CPOs currently fall into either the agent or client stack. The agent stack is `AgentNavigator.tsx` (a plain `createNativeStackNavigator`, not tabs). Global push-deep-link uses `navigationRef.navigate('Main', {...})` (the incoming-call pattern, `MainNavigator.tsx:286+`).
- **First-login + revocation (Â§35A Â§B):** if `must_set_password=true` â†’ force CPO account-activation (set password â†’ optional biometric â†’ location + notification permissions â†’ "you belong to {agency}" + on-duty/SOS explainer) before the home; a CPO never sees `RoleSelectionScreen`. On every app-focus/token-refresh, re-check `membership_status`; if the agency suspended/removed them (`org_members.status != 'active'`), force-logout to an "Your agency access has ended" screen, set them offline, drop from Ops Rooms.

**Files to touch:**

- NEW `src/navigation/CpoNavigator.tsx` â€” a `createBottomTabNavigator` 4-tab shell: **On Duty / Mission / Comms / Me**, with a floating persistent SOS button above the tabs once mission is `PICKUP`/`LIVE`. Reuse existing agent screens where possible; register the messenger/call screens (mirror what `AgentNavigator` registers) so the Ops Room + calls work in the Comms tab.
- NEW `src/screens/cpo/OnDutyHomeScreen.tsx` â€” duty toggle (`agentApi.setDuty` + location heartbeat via `updateLocation`), "you belong to **{agency}**" banner (from `account_kind` payload `org.name`), today's shifts (`attendanceApi.myShifts`), the assigned-mission card with a stepper mini-bar + LEAD/CREW chip (from `getActiveMission`); calm "No active mission â€” stand by" empty state.
- NEW `src/screens/cpo/AssignedMissionDetailScreen.tsx` â€” client name, route, dress brief, **crew roster with the lead starred + "YOU"**, waypoints, full `<MissionStepper>`; data from extended `getMissionDeployment`.
- NEW `src/screens/cpo/CpoFieldModeScreen.tsx` (or extend `AgentLiveTrackerScreen.tsx`) â€” map + ONE context-aware **lead-only** button: `DISPATCHED`â†’Start (`missionPickup`), `PICKUP`â†’Go-live (`missionGoLive`), `LIVE`â†’swipe-to-FINISH (`missionComplete`, deliberate confirm). Non-lead = read-only "lead is advancing" + chat + SOS. On error stays at current state (never false "completed"); idempotent re-tap after lost-200 is safe.
- NEW `src/screens/cpo/CpoActivationScreen.tsx` â€” first-login set-password + biometric + permissions + "you belong to {agency}" explainer.
- NEW `src/screens/cpo/AccessEndedScreen.tsx` â€” the suspended/removed force-logout screen.
- NEW (Me tab) reuse/extend `EarningsScreen.tsx` scoped to **own share only**, plus docs/credentials (reuse `AgentDocsUploadScreen.tsx`) and availability/attendance.
- EXTEND `src/navigation/MainNavigator.tsx` â€” add a third branch: `account_kind==='cpo'` â†’ `<CpoNavigator/>` (alongside the existing `isAgent â†’ <AgentNavigator/>` and the client tabs). Add a focus/refresh `membership_status` re-check that force-routes to AccessEnded.
- EXTEND `src/navigation/types.ts` â€” add a `CpoStackParamList`/tab param list and a root `CpoStack` entry; register mission-assigned/SOS deep-link routes.
- EXTEND `src/services/api.ts` â€” add the `account_kind`/`org`/`must_set_password`/`membership_status` fields to the `agentApi.getMe()` (`AgentPortalState`) type so the app switches on the authoritative value; extend the `getMissionDeployment` return type with `booking.status` + `crew[]` + client name (mirrors the Step 17 server change).
- EXTEND the auth bootstrap (`src/store/authStore.ts`) â€” resolve `account_kind` from `/agents/me` after login so the root navigator can branch.
- (v1.1/later) NEW Arrival/Identity confirmation, Lone-Worker check-in (`POST /agents/me/missions/:id/check-in`).

**Backend how-to:** Pure frontend except for what is owned upstream: the `account_kind`/`must_set_password`/`membership_status` computation on `/agents/me` (Â§35A Â§F, a focused read â€” no new crypto/auth power), the extended `getMissionDeployment` payload (Step 17), and the lead-gated `complete` that opens settlement (Step 10/LB4). This step consumes them. (Contract reminder for the FINISH button: server-side `complete` is a conditional `UPDATE missions SET status='COMPLETED' WHERE id=$1 AND status='LIVE' AND EXISTS(...is_lead)` inside a txn, idempotent â€” so a re-tap after a lost-200 returns the cached success, never double-settles.)

**Frontend / ops-console how-to:**

1. **Root routing by `account_kind`.** In `MainNavigator`, after auth bootstrap, branch: `cpo â†’ <CpoNavigator/>`, `agency`(`isAgent`)`â†’ <AgentNavigator/>`, else client tabs. Drive it off the server-computed `account_kind`, NOT a client flag.
2. **First login.** If `must_set_password`, push `CpoActivation` before the CPO home; never show `RoleSelectionScreen` to a CPO.
3. **One context-aware button.** Compute the action from `getActiveMission().status` + `is_lead`. Lead: render Start/Go-live/swipe-Finish wired to `missionPickup`/`missionGoLive`/`missionComplete`. Non-lead: render the same screen read-only with "lead is advancing"; keep chat + SOS active.
4. **Capability lockdown (Â§35A Â§D).** Build the CPO tabs from ONLY the CPO-scoped screens. Do not register or link to the booking wizard, wallet top-up, family hub, VBG client suite, incoming-offer, roster, assign-crew, multi-mission board, or org earnings. Earnings shows the guard's own share only.
5. **Revocation.** On app-focus/token-refresh, re-fetch `membership_status`; if `!= 'active'`, force-logout â†’ `AccessEnded`, set offline (`setDuty(false)`), and let the Ops Room drop happen server-side.
6. **Deep-links.** Route `mission-assigned` and SOS push wakes into the **Mission** tab via `navigationRef.navigate('Main', {screen:'CpoStack'/'Mission', ...})` (mirror the incoming-call cast).

**Security stop-conditions:** The Comms tab hosts the existing E2E Ops Room â€” metadata-only via `ensureBookingOpsRoom`; the CPO was added to the room by the agency device's group rekey (LB2), so the CPO app only opens the existing conversation; do NOT write envelopes or touch sender keys. `account_kind`/`membership_status` are server-authoritative â€” never let the client choose its app experience or self-promote to lead. Push stays opaque: react to `mission-assigned`/SOS wakes by re-fetching `getActiveMission`/deployment, never read mission details from FCM. No "skip in dev" on the membership/session guard. The duty-location heartbeat and SOS must not log plaintext coordinates as key-bearing buffers. STOP/verify against the System Architecture Documentation before changing anything about the Ops Room membership or the session/revocation guard.

**Acceptance & tests:**

- **New tests (`booking`/agent Jest project + `src/screens/cpo/__tests__`):** the context-aware-button selector (statusÃ—is_lead â†’ Start/Go-live/Finish/read-only); `account_kind` precedence resolver (cpo > agency > individual); the capability matrix â€” assert the CPO navigator does NOT include booking/roster/offer/org-earnings routes; revocation reducer routes to AccessEnded when `membership_status!='active'`.
- **Regression:** rerun the `booking`/agent project; `npm run test:crypto` if the Ops Room open/membership path is touched (it should only _open_ an existing room â€” if so confirm green).
- **Gates:** `npm run typecheck` (mobile â‰¤ baseline 96 â€” the new `CpoStackParamList` + extended `AgentPortalState`/`getMissionDeployment` types must not regress it); `npm run lint`. (No ops-console change here; if any shared lib is touched, also `cd apps/ops-console && npm run typecheck`.)
- **Manual smoke (dev build, real device, leader + non-leader logins):** agency assigns crew (Step 20) â†’ leader logs in (first-login activation forces password) â†’ lands in CpoNavigator â†’ Mission tab shows the job + roster with lead starred + "YOU" â†’ Start â†’ Go-live â†’ swipe-Finish advances the mission and every party's stepper to Completed â†’ agency paid (settlement, Step 10). Non-leader: same job read-only, chat + SOS work, no status buttons. Verify HIDDEN: no booking wizard, no offer card, no roster, no org money. Verify revocation: agency suspends the CPO â†’ next focus force-routes to "access ended." Error path: tap Finish offline â†’ stays LIVE, no false "completed."
- **Do not commit on a red gate; never `--no-verify`.**

**Done when:**

- [ ] `CpoNavigator` 4-tab shell (On Duty / Mission / Comms / Me) + floating persistent SOS once PICKUP/LIVE.
- [ ] Root navigator mounts CpoNavigator strictly by server `account_kind`; first-login activation forces password; no RoleSelection for CPOs.
- [ ] Lead sees ONE context-aware Startâ†’Go-liveâ†’swipe-Finish wired to `missionPickup`/`missionGoLive`/`missionComplete`; non-lead is read-only with chat + SOS.
- [ ] Assigned-Mission Detail shows client/route/dress/waypoints + crew roster with the lead starred + "YOU" + the shared stepper.
- [ ] Every client + agency capability from the Â§35A matrix is absent from the CPO build; Earnings shows own share only.
- [ ] Mid-session revocation force-logs-out to "access ended," sets offline, drops from Ops Rooms.
- [ ] Push wakes (mission-assigned/SOS) deep-link into the Mission tab; reactions re-fetch, never read FCM details.
- [ ] typecheck â‰¤ 96, lint clean, booking/agent + cpo tests green, leader/non-leader + revocation smoke passes.

---

## Step 22 â€” Privacy, retention & consent (PII minimization, telemetry purge, lawful-basis gate, disclosure rewrite)

**Stage:** Cross-cutting Â· **Depends on:** Step 6 (PostGIS region/eligibility match), Step 7 (`dispatch_offers` table + coarse-offer split), Step 8 (acceptâ†’escrow + `/offers/:id/full` ACCEPTED-only), Step 16 (settlement/telemetry wiring) Â· **Resolves:** Part III privacy LB14 + the "Privacy & multi-region compliance" table P0 rows (purge `dispatch_offers`, telemetry retention, lawful-basis consent, false-disclosure rewrite, DPA/CPO consent, PII redaction, data-residency)
**Goal (plain English):** Make sure the customer's exact location is only ever seen by the one firm that took the job, gets deleted from the firms that didn't, and is only shared at all after the customer agrees. Also stop holding live-tracking data forever, rewrite the old "our staff watch your trip" promise (we no longer have a staff handler), and make sure no new screen, log, or admin panel leaks personal data.
**Why it matters / what breaks without it:** Leaking a protected person's pickup/home address to firms that rejected the job is the single highest-severity privacy harm in this product (UAE PDPL / Saudi PDPL / UK GDPR exposure); a false privacy disclosure and unbounded location retention are direct compliance failures that can block launch in the four regions.
**Self-contained context (inline â€” do not make the reader open the plan):**

- **Decisions in play:** D1 (fully automatic â€” there is NO ops handler watching the trip anymore; admin only monitors/overrides); D3 (a third-party AGENCY accepts and gets the precise location); correction (3) coarse offer pre-accept â€” offered/rejecting agencies must never see exact pickup/dropoff; precise location is exposed only after accept via a separate ACCEPTED-only endpoint (`GET /offers/:id/full`).
- **Data model touched:** `dispatch_offers` (cols incl. `provider_user_id`, `status` âˆˆ OFFERED/ACCEPTED/REJECTED/EXPIRED/SUPERSEDED, `reject_reason TEXT`, `expires_at`) holds coarse geo for the offer; `lite_bookings` holds the precise `pickup_lat/lng` + `dropoff_lat/lng` + addresses + `region_code`; live location lives in `mission_telemetry_last` (Postgres latest-point) AND a Redis stream (telemetry.service.ts already sets `redis.client.expire(key, this.streamTtlSec)` â€” confirm/standardize that TTL here).
- **Reuse points:** the multi-replica-safe background sweep is the Redis `SET NX`-locked `setInterval` pattern in `apps/auth-service/src/booking/payment-pending-expiry.service.ts` (NOT `@nestjs/schedule` â€” auth-service is multi-replica, per correction (1)); the PII-redaction precedent is the static log-audit assertions enforced inside the messenger-core crypto tests (`packages/messenger-core/__tests__/sealedSender.test.ts`, `outerEcies.test.ts`, `groupPlaintextReject.test.ts` â€” there is no standalone `logAudit.test.ts`; the assertion pattern is "this string/key must never appear in logged output"); the consent/disclosure copy lives on the client request wizard + Finding/Confirmation screens (`src/screens/booking/*`).
- **Constraint:** the Ops Room is metadata-only via `SystemMessengerService.ensureBookingOpsRoom` â€” do NOT add location into any system_broadcast; the precise location flows over the existing E2E booking conversation, never through a server-readable surface.
  **Files to touch:**
- NEW `supabase/migrations/<ts>_privacy_consent.sql` â€” add `lite_bookings.location_consent_at TIMESTAMPTZ`, `lite_bookings.location_consent_version TEXT`, `lite_bookings.terms_accepted_at TIMESTAMPTZ`; add `agents.dpa_accepted_at TIMESTAMPTZ`, `agents.dpa_version TEXT` (agency processor terms) and a managed-CPO consent column (e.g. `org_members.account_consent_at TIMESTAMPTZ`).
- NEW `apps/auth-service/src/dispatch/offer-purge.service.ts` â€” Redis-locked sweep that nulls geo/PII on terminal offers.
- EXTEND `apps/auth-service/src/booking/booking.service.ts` `createBooking()` â€” require `location_consent` + `terms_accepted` in the create DTO and reject the request if absent (lawful-basis gate at request time, BEFORE any dispatch).
- EXTEND `apps/auth-service/src/agents/agent.service.ts` (or `org` service) â€” gate dispatch-eligibility on `agents.dpa_accepted_at` non-null; the agency cannot receive offers until processor terms are accepted.
- EXTEND `apps/auth-service/src/telemetry/telemetry.service.ts` â€” confirm/centralize `streamTtlSec`; add the Postgres `mission_telemetry_last` purge on mission terminal (COMPLETED/ABORTED) + a retention sweep.
- EXTEND/NEW redaction helper used by dispatch/ops logs + the ops-console monitor (`apps/ops-console/...`) so `reject_reason`, addresses, and lat/lng are never logged or shown un-redacted to admin.
- EXTEND client copy: `src/screens/booking/*` (request wizard + Finding/Confirmation) â€” rewrite the "an ops handler watches your trip" disclosure to the D1 reality + add a consent checkpoint UI.
- NEW doc note: a data-residency/cross-border section (one DB today; document the AE/SA/BD/GB plan).
  **Backend how-to:**
- **Lawful-basis gate (request time):** in `createBooking()`, after the existing `active_booking_exists` + `MIN_LEAD_HOURS` checks and BEFORE persisting, require `dto.location_consent === true` and `dto.terms_accepted === true`; persist `location_consent_at = NOW()`, `location_consent_version`, `terms_accepted_at = NOW()`. Reject with `BadRequestException({code:'consent_required'})` otherwise. This is the consent checkpoint BEFORE any precise location can be disclosed to a third-party agency.
- **Offer purge sweep** (mirror `payment-pending-expiry.service.ts` exactly â€” `SET NX` lock key e.g. `lock:offer-purge`, `setInterval`, clock-skew grace):
  ```sql
  UPDATE dispatch_offers
     SET coarse_lat = NULL, coarse_lng = NULL, coarse_label = NULL, reject_reason = NULL
   WHERE status IN ('REJECTED','EXPIRED','SUPERSEDED')
     AND (coarse_lat IS NOT NULL OR reject_reason IS NOT NULL)
     AND updated_at < NOW() - INTERVAL '<TTL>'
  RETURNING id;
  ```
  Run inside `withTransaction`; the conditional `WHERE status IN (...)` is the race guard (an offer that flipped back to ACCEPTED is never purged). Idempotent by construction (re-running nulls already-null rows = no-op).
- **Telemetry retention:** on mission terminal in the mission FSM path, `DELETE FROM mission_telemetry_last WHERE mission_id = $1` (or move to a short-retention archive per the residency note); for Redis, keep the existing `expire(key, streamTtlSec)` and add a sweep that trims any stream past the retention window. Define the window explicitly (e.g. 30 days max, mirroring the Signal relay dwell ceiling â€” STOP/verify the exact window against the System Architecture Documentation before finalizing).
- **PII redaction:** add a small `redactPii()` used wherever dispatch/offer/mission rows are logged; never log addresses/lat/lng/`reject_reason` in cleartext. The ops-console monitor (`GET /ops/dispatch/active`) must return coarse/region-level data to the admin view unless the admin opens a specific row under audit.
  **Frontend / ops-console how-to:**
- Client request wizard (`src/screens/booking/*`): add a consent step â€” a checkbox/affirmation "Bravo will share your pickup and drop-off with the security firm that accepts this job" + a terms acceptance, both required to submit; submit `location_consent:true, terms_accepted:true` on the create call in `src/services/api.ts`.
- Rewrite every instance of the now-false "an ops handler / our team watches your trip" copy (search booking + confirmation + live-tracking screens) to D1 reality: "This is an automated dispatch; your detail is run by {agency}. SOS reaches emergency response."
- Ops-console monitor: render region/coarse data by default; gate any precise-location reveal behind an audited admin action.
  **Security stop-conditions:**
- STOP/verify against the System Architecture Documentation before setting the telemetry retention window and before any change to what the Ops Room (`ensureBookingOpsRoom`) carries â€” the Ops Room stays metadata-only; precise location must NOT be added to any `system_broadcast`. Push wake stays opaque (`{userId,eventClass,eventId}` only). Never log plaintext addresses, lat/lng, or `reject_reason` â€” extend the redaction precedent, do not rename variables to dodge it.
  **Acceptance & tests:**
- Unit (auth-service Jest, run from `apps/auth-service`): (a) `createBooking` rejects with `consent_required` when consent/terms absent and persists timestamps when present; (b) offer-purge sweep nulls geo+`reject_reason` on REJECTED/EXPIRED/SUPERSEDED and leaves ACCEPTED/OFFERED untouched; (c) telemetry purge removes `mission_telemetry_last` on terminal mission; (d) dispatch-eligibility excludes an agency with `dpa_accepted_at IS NULL`.
- Static redaction test: extend the log-audit precedent (assert addresses/lat/lng/`reject_reason` never appear in logged output for the new dispatch/offer/telemetry code).
- Manual smoke: submit a request without consent â†’ blocked; with consent â†’ dispatched; reject from one agency â†’ confirm that agency's offer row geo is nulled after the sweep; confirm the disclosure copy no longer says "ops handler."
- Gates: `npm run lint`; `npm run typecheck` (mobile, â‰¤ baseline 96) and `cd apps/ops-console && npm run typecheck`; wire the new specs into the auth-service Jest run (CI must execute them â€” see Step on CI). Do not commit on red; never `--no-verify`.
  **Done when:**
- [ ] Request creation is blocked without explicit location-consent + terms acceptance, and both timestamps/versions are persisted.
- [ ] Rejected/expired/superseded offers have geo + `reject_reason` purged by a multi-replica-safe Redis-locked sweep.
- [ ] Telemetry (Postgres latest-point + Redis stream) has a defined, enforced retention window with a purge path; the window is signed off against the architecture doc.
- [ ] The "ops handler watches your trip" disclosure is gone and replaced with D1-accurate copy on every surface.
- [ ] Agencies must accept processor (DPA) terms before they are dispatch-eligible; managed-CPO logins record account consent.
- [ ] Logs and the ops-console monitor never expose precise location/`reject_reason`; a static test enforces it; a data-residency/cross-border note exists for AE/SA/BD/GB.

---

## Step 23 â€” Anti-fraud & marketplace integrity (location-plausibility, request throttle + payment gate, accept-rate cooldown, device-binding, one-email-one-agency)

**Stage:** Cross-cutting Â· **Depends on:** Step 5 (duty/location heartbeat on `agents`), Step 6 (PostGIS region match + ranking), Step 7 (`dispatch_offers` + accept/reject), Step 9 (managed-CPO roster `org_members` + `POST /org/cpos`) Â· **Resolves:** Part III anti-fraud LB18 + the "Anti-fraud & marketplace integrity" table P0 rows (location spoofing, free-request recon/DoS, mass-reject gaming, shared-login binding, one-email-one-agency)
**Goal (plain English):** Stop firms from cheating to win jobs. Catch fake/jumpy GPS and mock-location on the "I'm on duty here" heartbeat; stop people spamming the free "find me a guard" button to spy on guard locations or knock the service over; penalize firms that accept-then-reject everything; lock down the shared guard logins so a leaked password can't be used everywhere at once; and make "one email = one agency" a hard database rule, not a hope.
**Why it matters / what breaks without it:** A two-sided dispatch marketplace is gamed the moment it's live â€” a firm that spoofs GPS always appears nearest and starves honest firms; a free unauthenticated-cost request is a recon oracle for where every guard is; shared 10-CPO logins (D5) are an account-sharing vector; and a `SELECT`-only uniqueness check races, so the same email can land in two agencies.
**Self-contained context (inline â€” do not make the reader open the plan):**

- **Decisions in play:** D4 (nearest within same region wins â†’ spoofed location directly steals jobs); D5 (one agency registers up to ~10 real CPO login emails; one email = one agency); D6 (an agency runs multiple concurrent missions bounded by free-CPO capacity â†’ mass-accept-then-can't-crew must be penalized); D2 (charge on accept â†’ the requesting/DISPATCHING side is FREE today, so the request endpoint is a free oracle).
- **Data model touched:** `agents.last_lat/last_lng/last_location_at/on_duty/rating/jobs_total` updated via `PATCH /agents/me/location` (DTO `UpdateLocationDto{lat,lng}`) and `PATCH /agents/me/duty` (`SetDutyDto{on_duty}`) â€” confirmed in `apps/auth-service/src/agents/agent.controller.ts` lines 157-168 and `dto/agent.dto.ts`; `agents` has NO region_code today (correction (4)) and the location DTO has NO mock-location/accuracy field today â€” both must be added. Managed CPOs live in `org_members` (`member_role`, `status`) + are created via `POST /org/cpos` under `OrgManagerGuard`. Acceptance/reject accounting needs new counters on `agents` (e.g. `offers_received`, `offers_accepted`, `offers_rejected`, `cooldown_until`).
- **Reuse points:** rate limiting = `UserThrottlerGuard` + `@Throttle` (already in the codebase); idempotency = `common/interceptors/idempotency.interceptor.ts`; JTI / refresh-token / push-token revocation lives in `apps/auth-service/src/auth/jwt.service.ts` + `auth.service.ts` (reuse for per-login session cap + revocable push token); the accept/reject conditional-UPDATE race pattern mirrors `payWithCredits` (`booking.service.ts`) â€” `UPDATE ... WHERE <expected-state> RETURNING` inside `withTransaction`.
- **Constraint:** the request (`DISPATCHING`) path is free â†’ it MUST require a verified payment method before it can run the cascade, and be throttled per-user; the duty/location heartbeat must reject implausible jumps server-side (never trust the client's self-reported coordinates blindly).
  **Files to touch:**
- NEW `supabase/migrations/<ts>_antifraud_integrity.sql` â€” add `agents.region_code TEXT` + offer-accounting counters (`offers_received INT`, `offers_accepted INT`, `offers_rejected INT`, `cooldown_until TIMESTAMPTZ`, `acceptance_rate NUMERIC`); add `agents.last_location_accuracy_m NUMERIC`, `agents.last_location_mocked BOOLEAN`; add a **PARTIAL UNIQUE INDEX** for one-email-one-agency; add device-binding/session columns if not already on the auth/session tables.
- EXTEND `apps/auth-service/src/agents/dto/agent.dto.ts` `UpdateLocationDto` â€” add optional `accuracy_m`, `is_mocked`, `speed`, `ts` so the server can run plausibility.
- EXTEND `apps/auth-service/src/agents/agent.service.ts` `updateLocation()` â€” server-side plausibility (impossible-speed jump vs `last_lat/last_lng/last_location_at`) + mock-location gating (drop on-duty eligibility / flag when `is_mocked`).
- EXTEND `apps/auth-service/src/booking/booking.controller.ts` (request/DISPATCHING start) â€” add `@Throttle` via `UserThrottlerGuard` + a verified-payment-method gate; cap concurrent client DISPATCHING.
- EXTEND `apps/auth-service/src/dispatch/*` reject handler â€” increment reject counters, recompute `acceptance_rate`, apply `cooldown_until` + a ranking penalty on mass-reject.
- EXTEND `apps/auth-service/src/agents/org/*` (`POST /org/cpos`) â€” verified-email gate before a CPO is assignable; reject self/client-email enrolment; surface the one-email-one-agency 409.
- EXTEND `apps/auth-service/src/auth/jwt.service.ts` / `auth.service.ts` â€” device-binding + concurrent-session cap + revocable per-login push token for managed-CPO logins.
  **Backend how-to:**
- **One-email-one-agency (hard rule, not a SELECT):**
  ```sql
  -- a CPO email may belong to at most one active agency
  CREATE UNIQUE INDEX org_members_one_active_agency_per_email
    ON org_members (lower(email)) WHERE status = 'active';
  ```
  In `POST /org/cpos`, do the INSERT and catch the unique-violation â†’ return `409 {code:'email_taken'}`; do NOT pre-check with a `SELECT` (it races). Add a verified-email gate: a CPO is not `assignable` until email is verified; reject if the email equals the manager's own (`self_enrolment`) or matches an existing client account (`client_email`).
- **Location plausibility + mock gating** in `updateLocation()`:
  - If `dto.is_mocked === true` â†’ reject/flag (`agents.last_location_mocked = true`, exclude from the on-duty dispatch pool).
  - Compute implied speed from previous fix: `dist(last_lat,last_lng â†’ lat,lng) / (now - last_location_at)`. If it exceeds a plausible ceiling (e.g. > 300 km/h or accuracy_m too large), reject the update (keep the prior fix) and increment a suspicion counter. Do this server-side; the client value is untrusted.
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
- **Device-binding + session cap + revocable push:** on managed-CPO login, bind the JTI to a device id, enforce a concurrent-session cap (revoke oldest on overflow via the existing JTI revocation), and issue a per-login revocable push token so a removed/suspended CPO's wake can be killed (ties into Â§35A mid-session revocation).
- All money-adjacent and state-flip operations stay idempotent and use the conditional `UPDATE ... WHERE <state> RETURNING` inside `withTransaction`.
  **Frontend / ops-console how-to:**
- Agency roster screen (`OrgRoster`): surface the `409 email_taken` cleanly ("this email already belongs to another agency"), show "X / 10 used" cap, and a verified/unverified email badge per CPO; block assignment of unverified CPOs.
- Client request UI: if the verified-payment-method gate fails, route to the existing CreditPaywall/payment-method add flow before allowing dispatch.
  **Security stop-conditions:**
- STOP/verify against the System Architecture Documentation before changing session/JTI, refresh-token, or push-token issuance/revocation (these are listed auth stop-conditions). Push wake stays opaque (`{userId,eventClass,eventId}`). No "skip in dev" branch on the payment-method gate, the plausibility check, or the verified-email gate. Never log raw coordinates from the heartbeat (reuse the Step-22 redaction precedent).
  **Acceptance & tests:**
- Unit (auth-service Jest): (a) `updateLocation` rejects mock/implausible-speed fixes and keeps the prior fix; (b) the partial unique index causes a `409 email_taken` on a second active agency for the same email; (c) self-email and client-email enrolment are rejected; (d) reject path increments counters, recomputes `acceptance_rate`, and sets `cooldown_until` past threshold; (e) ranking excludes cooled-down agencies; (f) DISPATCHING-start requires a verified payment method and is throttled.
- Integration: concurrent `POST /org/cpos` with the same email â†’ exactly one succeeds (index race), the other 409s.
- Manual smoke: spoof a mock location on a test device â†’ agency drops out of the offer pool; spam the request endpoint â†’ throttled.
- Gates: `npm run lint`; `npm run typecheck` (mobile â‰¤ 96) + `cd apps/ops-console && npm run typecheck`; run the auth-service Jest project (ensure CI executes it). Do not commit on red; never `--no-verify`.
  **Done when:**
- [ ] The duty/location heartbeat rejects mock-location and impossible-speed jumps server-side; flagged agencies leave the dispatch pool.
- [ ] The free DISPATCHING request requires a verified payment method and is per-user throttled with a concurrent-DISPATCHING cap.
- [ ] Mass-reject is accounted (acceptance-rate), penalized (rank), and cooled down; the ranking honors `cooldown_until`/`acceptance_rate`.
- [ ] Managed-CPO logins are device-bound, session-capped, and have a revocable push token.
- [ ] One-email-one-agency is enforced by a partial unique index (409 on race), email is verified before assignability, and self/client-email enrolment is rejected.

---

## Step 24 â€” Lifecycle completeness & ratings loop (on-demand lead-time exemption, free the active-booking guard, ratings writeâ†’ranking, jobs_total, scheduled auto-dispatch, cancellation policy, ETA)

**Stage:** Cross-cutting Â· **Depends on:** Step 6 (ranking that consumes `agents.rating`), Step 7/8 (offer + accept FSM and the new DISPATCHING/NO_PROVIDER statuses), Step 16 (extracted `SettlementService` / lead one-tap Finish), Step 12 (escrow refund matrix for cancellation fee) Â· **Resolves:** Part III lifecycle LB17 + the "Lifecycle completeness & business rules" table P0/P1 rows (MIN_LEAD_HOURS collision, DISPATCHING/NO_PROVIDER trap, ratings loop unbuilt, jobs_total not incremented, scheduled auto-dispatch undesigned, no cancellation policy, no ETA)
**Goal (plain English):** Finish the "the demo works but the product is unfinished" gaps. Let an "I need a guard NOW" request skip the 3-hour-minimum rule; let a customer try again after a failed search instead of being locked out; build the missing star-rating loop so a customer can rate the firm and that rating actually changes who gets future jobs; count a finished job toward the firm's total; design scheduled/recurring auto-dispatch; add a fair cancellation policy; and show an arrival ETA.
**Why it matters / what breaks without it:** As written, an on-demand request is rejected by the 3-hour lead-time gate (the headline feature can't run), a failed search traps the customer behind the one-active-booking guard so "try again" is impossible, and the ranking reads `agents.rating` that is never written â€” so the whole "best firms rise" promise is a fabricated trust signal.
**Self-contained context (inline â€” do not make the reader open the plan):**

- **Decisions in play:** D1 (fully automatic on-demand); the booking FSM is `DRAFTâ†’PENDING_OPSâ†’OPS_APPROVEDâ†’PAYMENT_PENDINGâ†’CONFIRMEDâ†’LIVEâ†’COMPLETED` (`apps/auth-service/src/booking/state-machine.service.ts`), plus the NEW dispatch statuses DISPATCHING / NO_PROVIDER added by the dispatch steps; the mission FSM is `DISPATCHEDâ†’PICKUPâ†’LIVEâ†’SOSâ†’COMPLETED|ABORTED` (`mission-state-machine.service.ts`).
- **Confirmed code facts (verify, don't transcribe):** in `apps/auth-service/src/booking/booking.service.ts`: `MIN_LEAD_HOURS = 3` (line 18); the active-booking guard is a `SELECT id,status FROM lite_bookings WHERE client_id=$1 AND status NOT IN ('COMPLETED','CANCELLED') ... LIMIT 1` then throw `active_booking_exists` (lines 154-169); the lead-time check is `pickupTime < now + MIN_LEAD_HOURS*3600_000` (lines 176-180). The lead's one-tap Finish does NOT settle money today and `jobs_total` is currently bumped by `OpsService.completeBooking` on payout, NOT on finish (confirmed by the removed `PATCH /agents/me/stats` comment in `agent.controller.ts` lines 170-176) â€” so incrementing `jobs_total` "on the lead's finish" requires the extracted `SettlementService` from Step 16 (correction (2): the lead Finish has no settlement path today).
- **Data model touched:** `lite_bookings.rating` exists but is UNUSED (the ratings target); `agents.rating` is read by the ranking but never written; `agents.jobs_total` increments only at admin payout today. New: a cancellation-policy needs grace/fee config + ties into the Step-12 escrow PARTIAL/refund matrix; scheduled dispatch needs a recurrence rule + a Redis-locked cron.
- **Reuse points:** the multi-replica-safe cron is the Redis `SET NX`-locked `setInterval` in `payment-pending-expiry.service.ts` (NOT `@nestjs/schedule`, correction (1)); the conditional state flip mirrors `payWithCredits`; ETA comes from Mapbox (ops-console already uses `mapbox-gl`; mobile uses the existing map stack); the new ratings/receipt endpoints are simple reads/writes over existing tables (Part IV Â§35: `POST /bookings/:id/rating`).
  **Files to touch:**
- EXTEND `apps/auth-service/src/booking/booking.service.ts` â€” exempt on-demand (`booking_mode:'now'`/`dispatch_mode:'auto'`) from `MIN_LEAD_HOURS`; relax the active-booking guard so terminal/failed states (NO_PROVIDER, CANCELLED, COMPLETED, and an expired DISPATCHING) do NOT block a new request.
- NEW `apps/auth-service/src/booking/rating.controller.ts` + service method â€” `POST /bookings/:id/rating`.
- EXTEND the settlement/finish path (`SettlementService` from Step 16 + `apps/auth-service/src/ops/ops.service.ts`) â€” increment `agents.jobs_total` on the lead's verified finish/settlement (not only admin payout).
- NEW `apps/auth-service/src/dispatch/scheduled-dispatch.service.ts` â€” Redis-locked cron that calls `DispatchService.start()` at `pickup_time âˆ’ lead` for `booking_mode:'later'`/recurring rows.
- NEW `supabase/migrations/<ts>_lifecycle_ratings.sql` â€” recurrence-rule columns on `lite_bookings` (or a `booking_schedules` table), cancellation-policy config, and any rating index.
- EXTEND client mobile: `src/screens/booking/*` (NoDetailScreen "try again", RateAgencyScreen), `src/store/bookingStatus.ts` (`resumeTargetFor` for DISPATCHING/NO_PROVIDER), `src/services/api.ts` (rating + receipt + schedule calls), LiveTracking/Confirmation ETA via Mapbox.
  **Backend how-to:**
- **On-demand lead-time exemption:** wrap the lead-time throw in a mode check â€” `if (!isOnDemand(dto) && pickupTime.getTime() < now + MIN_LEAD_HOURS*3600_000) throw ...`. `isOnDemand` = `dto.dispatch_mode === 'auto'` or `dto.booking_mode === 'now'`. Scheduled requests keep the gate.
- **Free the active-booking guard:** change the guard's `status NOT IN (...)` to also exclude terminal/failed dispatch states: `AND status NOT IN ('COMPLETED','CANCELLED','NO_PROVIDER')` and treat an expired-DISPATCHING booking as non-blocking (or auto-transition it to NO_PROVIDER in the same path). This makes "try again" possible after a failed search while still preventing two concurrent live missions.
- **Ratings write â†’ ranking feed:** `POST /bookings/:id/rating` body `{stars:1..5, tags?:string[], tip?:number}`, guarded so only the booking's `client_id` can rate and only when the booking is COMPLETED (conditional check). Inside `withTransaction`:
  ```sql
  UPDATE lite_bookings SET rating=$2 WHERE id=$1 AND client_id=$3 AND status='COMPLETED' AND rating IS NULL RETURNING id;
  -- then recompute the agency's rolling average from lite_bookings.rating for that provider:
  UPDATE agents SET rating = (SELECT AVG(rating) FROM lite_bookings WHERE provider_user_id=$prov AND rating IS NOT NULL) WHERE user_id=$prov;
  ```
  The `AND rating IS NULL` clause makes it idempotent / one-rating-per-booking; wrap with `IdempotencyInterceptor`. The recomputed `agents.rating` is exactly what the Step-6 ranking reads.
- **jobs_total on finish:** inside the extracted `SettlementService` (Step 16), on a verified lead finish, `UPDATE agents SET jobs_total = jobs_total + 1 WHERE user_id=$payeeUserId` in the same settlement txn (do not also bump at admin payout â€” pick one source of truth to avoid double counting; the comment in `agent.controller.ts` notes it is server-written only).
- **Scheduled/recurring auto-dispatch:** Redis `SET NX`-locked `setInterval` (copy `payment-pending-expiry.service.ts`), every ~60s `SELECT` rows whose `pickup_time âˆ’ lead <= NOW()` and `dispatch_state` not yet started, then call `DispatchService.start()`; flip a `scheduled_dispatched_at` flag in the same conditional UPDATE so a re-run can't double-dispatch (multi-replica safe). Recurrence = expand the rule to the next occurrence on completion.
- **Cancellation policy:** define `CANCEL_FEE_GRACE` + `CANCEL_FEE_PCT`; on client cancel, branch by phase â€” within grace / pre-accept â†’ full refund (no fee); after accept but pre-LIVE â†’ PARTIAL (fee â†’ agency for the wasted commit); these route through the Step-12 escrow PARTIAL/REFUND matrix, not a fresh refund path.
  **Frontend / ops-console how-to:**
- `NoDetailScreen` (NO_PROVIDER): "you weren't charged" + a working **Try again** (now unblocked by the guard fix) + Schedule.
- `RateAgencyScreen` / RateMissionSheet: â˜… + tags + optional tip â†’ `POST /bookings/:id/rating`; show on TripSummary.
- `src/store/bookingStatus.ts` `resumeTargetFor`: route DISPATCHINGâ†’Finding, NO_PROVIDERâ†’NoDetail, plus the existing CONFIRMED/LIVE targets.
- ETA: render Mapbox time-to-arrival on Finding/Confirmation/LiveTracking (client) and the agency monitor (ops-console `mapbox-gl`).
  **Security stop-conditions:** None beyond standard guards for the lifecycle/rating/cron changes (no crypto/auth/escrow primitive changes here). The cancellation-fee money movement must obey the escrow rules from Step 12 (idempotent, conditional UPDATE) â€” STOP/verify the refund/partial split there, not invent a new one. Never log plaintext (rating tags/tip are non-sensitive but keep addresses out of cron logs).
  **Acceptance & tests:**
- Unit (auth-service Jest, booking project): (a) on-demand request bypasses MIN_LEAD_HOURS, scheduled does not; (b) active-booking guard no longer blocks after NO_PROVIDER/CANCELLED and a new request succeeds; (c) `POST /bookings/:id/rating` writes once (idempotent), only by the client, only on COMPLETED, and recomputes `agents.rating`; (d) settlement increments `jobs_total` exactly once; (e) scheduled cron dispatches once under a simulated two-replica race; (f) cancellation fee branches by phase through the escrow matrix.
- Manual smoke: fail a search â†’ tap Try again â†’ new search starts; complete a mission â†’ rate the agency â†’ confirm `agents.rating` moves and the next ranking reflects it.
- Gates: run the **booking** Jest project (`npm test -- --selectProjects=booking`) for the booking changes, then the auth-service suite; `npm run lint`; `npm run typecheck` (mobile â‰¤ 96) + ops-console typecheck; manual UI smoke. Do not commit on red; never `--no-verify`.
  **Done when:**
- [ ] On-demand requests skip the 3-hour lead-time gate; scheduled requests still honor it.
- [ ] A failed/terminal booking no longer traps the client â€” "try again" works.
- [ ] `POST /bookings/:id/rating` writes `lite_bookings.rating` (once, client-only, COMPLETED-only), recomputes `agents.rating`, and the dispatch ranking consumes it.
- [ ] `agents.jobs_total` increments on the lead's verified finish/settlement from one source of truth.
- [ ] Scheduled/recurring auto-dispatch runs on a Redis-locked, multi-replica-safe cron without double-dispatching; a cancellation policy with phase-based fees exists; ETA shows via Mapbox.

---

## Step 25 â€” i18n / RTL + per-region currency + SettingsScreen

**Stage:** Cross-cutting Â· **Depends on:** Step 22 (consent/disclosure copy that now needs translating), Step 24 (rating/receipt screens that need strings), the shared component library (PX1/Â§28 B3) Â· **Resolves:** Part III mobile-ux LB19 + Part IV Â§32 (SettingsScreen, Localization/RTL, notification categories, location-sharing scope, app-lock), Â§34 (no i18n/RTL P0 row)
**Goal (plain English):** The app has zero translation support today â€” everything is hard-coded English. Add a real language layer with English, Arabic (full right-to-left), and Bengali, defaulting to the phone's language and remembered in the user's settings; format money in the right currency per region (AED / SAR / BDT / GBP); and build a Settings screen where a user picks language, currency, notification categories (with Safety always on), how much location to share, and an app-lock. Make the shared building blocks flip correctly for right-to-left and respect the OS text-size setting.
**Why it matters / what breaks without it:** Arabic (RTL) + Bengali are table-stakes for the UAE / Saudi / Bangladesh launch regions â€” without them those regions cannot go live; and showing GBP/BDT amounts formatted as the wrong currency mis-charges/mis-displays in 2 of the 4 regions.
**Self-contained context (inline â€” do not make the reader open the plan):**

- **Decisions in play:** the four regions are AE / SA / BD / GB (D4); each maps to a currency: AEâ†’AED, SAâ†’SAR, BDâ†’BDT, GBâ†’GBP.
- **Confirmed code facts (verify, don't transcribe):** there is NO i18n today â€” `package.json` has no `i18n`, `expo-localization`, `react-i18next`, `i18next`, or `I18nManager`-based layer (grep returned no matches); the only "i18n/RTL/expo-localization" string hits in `src/` are incidental (`src/services/api.ts`, `JobMarketplaceScreen.tsx`), not a localization framework. There is NO `/me/preferences` endpoint today (grep on auth-service found only wallet/booking pricing `currency` usages). Text/RTL-awareness must reuse the existing responsive helper `src/utils/scaling.ts` (`scaleTextStyles`/`useResponsive`, tested in `src/utils/__tests__/scaling.test.ts`) â€” note its documented limit: static styles read `Dimensions.get('window')` at module load and do NOT reflow mid-session, so RTL direction must be applied at the right layer (`I18nManager` + per-component logical styles), not via a static re-read.
- **Reuse points:** Expo SDK 54 is the stack â†’ use `expo-localization` to read the device locale; `react-native`'s `I18nManager.forceRTL`/`isRTL` for layout direction; persist the choice via the NEW `PATCH /me/preferences`; format currency with `Intl.NumberFormat`. The shared component library (StepperBar, RatingStars, CountdownPill, etc., Â§28 B3) must be made RTL- and text-scale-aware here.
- **Constraint:** the Safety notification category is forced-on (cannot be disabled by the user) per Â§32; the location-sharing scope is a privacy control that pairs with the Step-22 consent model.
  **Files to touch:**
- EXTEND `package.json` â€” add `expo-localization` and a lightweight i18n runtime (e.g. `i18next` + `react-i18next`, or a minimal in-house dictionary if you want zero new deps); verify the dep is allowed by `npm run deadcode`/audit.
- NEW `src/i18n/index.ts` + `src/i18n/locales/{en,ar,bn}.json` â€” the i18n init (default from `expo-localization` device locale, fallback en), the translation catalogs, and an `applyRtl(locale)` that calls `I18nManager.forceRTL(true)` for `ar`.
- NEW `src/screens/settings/SettingsScreen.tsx` â€” language picker (English / Ø§Ù„Ø¹Ø±Ø¨ÙŠØ© / à¦¬à¦¾à¦‚à¦²à¦¾), currency, notification categories (Safety forced-on, disabled toggle), location-sharing scope, app-lock + auto-lock.
- NEW `src/utils/currency.ts` â€” `formatCurrency(amount, region)` mapping AEâ†’AED, SAâ†’SAR, BDâ†’BDT, GBâ†’GBP via `Intl.NumberFormat`.
- EXTEND `src/utils/scaling.ts` consumers + the shared component library (Â§28 B3 components) â€” make them RTL-aware (logical `start/end` instead of `left/right`) and text-scale-aware.
- EXTEND `src/services/api.ts` â€” `patchPreferences({language, currency, notification_categories, location_scope, app_lock})`.
- NEW backend: `apps/auth-service/src/users/preferences.controller.ts` (or extend an existing users controller) â€” `PATCH /me/preferences`; NEW migration `supabase/migrations/<ts>_user_preferences.sql` for the columns (`users.language`, `users.currency`, `users.notif_prefs JSONB`, `users.location_scope`, `users.app_lock`).
- EXTEND existing screens that hard-code English strings on the dispatch path (booking wizard, Finding/NoDetail/AgencyAccepted/Confirmation/LiveTracking, agency IncomingOffer, CPO mission screens) to use `t('...')`.
  **Backend how-to:**
- `PATCH /me/preferences` guarded by the standard auth guard (`@CurrentUser`), body validated (`language âˆˆ {en,ar,bn}`, `currency âˆˆ {AED,SAR,BDT,GBP}`, `notif_prefs` with Safety forced true server-side, `location_scope`, `app_lock`). Persist on the `users` row; the Safety category is coerced on server (`notif_prefs.safety = true` always), so a client cannot disable it. Idempotent partial update (`UPDATE users SET ... WHERE id=$sub RETURNING ...`).
  **Frontend / ops-console how-to:**
- `src/i18n/index.ts`: initialize from `Localization.getLocales()[0].languageCode`, fallback `en`; load the persisted preference (from `/me/preferences` / local store) on boot and override the device default; call `applyRtl(locale)` â€” note `I18nManager.forceRTL` requires an app reload to take full effect, so on language change show a "restart to apply" prompt for the RTL flip (standard RN constraint).
- SettingsScreen: language + currency + notification categories (Safety toggle rendered disabled/on) + location-sharing scope + app-lock/auto-lock; on save call `patchPreferences`.
- Wire `formatCurrency(amount, booking.region_code)` everywhere money is shown (pricing, receipt, earnings) so AED/SAR/BDT/GBP render correctly per region.
- Make the Â§28 shared components flip for RTL (use `flexDirection` logical handling / `I18nManager.isRTL`) and honor OS font scale via the existing `scaling.ts` helpers.
  **Security stop-conditions:** None beyond standard guards (i18n/currency/preferences are non-sensitive). The location-sharing scope control must not weaken the Step-22 consent/lawful-basis model â€” STOP/verify it only narrows, never silently widens, what the accepting agency receives. Do not log preference values that could be sensitive in aggregate.
  **Acceptance & tests:**
- Unit (mobile app Jest project): (a) `formatCurrency` returns correctly formatted AED/SAR/BDT/GBP; (b) i18n falls back to `en` for an unknown device locale and resolves `ar`/`bn` keys; (c) `applyRtl('ar')` sets RTL, `applyRtl('en')` clears it; (d) preferences server coerces Safety notifications on regardless of input.
- Manual smoke (UI cannot be fully verified without a device for the RTL reload â€” say so explicitly): switch language to Arabic â†’ layout mirrors after reload; switch currency â†’ amounts reformat; toggle a notification category â†’ Safety stays on/disabled; verify text scales with OS font-size setting; check an adjacent screen (e.g. DashboardScreen) is not broken by the RTL flip.
- Gates: `npm run lint`; `npm run typecheck` (mobile, must stay â‰¤ baseline 96) + `cd apps/ops-console && npm run typecheck`; `npm run deadcode` (new i18n deps must not trip knip); run the mobile app Jest project. If the RTL behavior can't be confirmed in this environment (native reload), state that rather than claiming success. Do not commit on red; never `--no-verify`.
  **Done when:**
- [ ] An i18n layer exists (none today) with en + ar (RTL via `I18nManager`) + bn, defaulting from the device locale and overridable in Settings.
- [ ] `PATCH /me/preferences` persists language/currency/notification-categories/location-scope/app-lock; Safety category is server-forced on.
- [ ] Per-region currency formatting (AED/SAR/BDT/GBP) is applied wherever money is shown.
- [ ] SettingsScreen exposes language, currency, notification categories, location-sharing scope, and app-lock/auto-lock.
- [ ] The shared Â§28 components are RTL- and text-scale-aware; dispatch-path screens render translated strings; gates are green (or device-only RTL verification is explicitly flagged as pending).

---

## Step 26 â€” Observability, kill-switch & ops monitor

**Stage:** Operate Â· **Depends on:** Step 5 (region+PostGIS ranking), Step 7 (offer/cascade + watchdog), Step 9 (acceptâ†’escrow charge saga), Step 14 (SettlementService + lead Finish), Step 18 (Ops Room conversations-scoped rekey drain), Step 22 (push-bridge dispatch eventClass) Â· **Resolves:** Part III "Observability & operability" (P0 metric set / runtime kill switch / SLO alerts / health checks), LB9 (watchdog liveness), LB21 (runtime kill-switch + canary), Â§42 (Redis-locked sweeps)
**Goal (plain English):** Since no human runs dispatch (D1 â€” admin only monitors/overrides), the system must watch itself: emit a dispatch-health metric set, log PII-safely with a correlation id that follows a job across services, page a human when something breaks that a person can't watch 24/7, expose real health/readiness checks, and provide ONE runtime switch that safely turns auto-dispatch off and falls back to the old admin-mediated job board. Plus a read-only ops-console `/dispatch` monitor with a money-taken/no-mission watch and a SUPERVISOR+ cancel/force-assign override that is attributable in the audit log.
**Why it matters / what breaks without it:** Without metrics + alerts + a kill switch, a stuck cascade, a dead watchdog, a charged-but-uncrewed booking, or a region with zero on-duty agencies silently strands real (safety-critical, money-handling) customers with no human in the loop and no way to bleed off to the legacy flow.
**Self-contained context (inline â€” do not make the reader open the plan):**

- D1 = fully automatic dispatch; the admin only monitors/overrides. So observability is the only human eye on the system.
- The dispatch lifecycle this step observes: client request â†’ booking `DISPATCHING` â†’ server offers nearest in-region agency via `dispatch_offers` (status `OFFERED`â†’`ACCEPTED`/`REJECTED`/`EXPIRED`/`SUPERSEDED`); reject/expire cascades to next-nearest (watchdog); on accept the client is charged into escrow (`escrow_holds.status='HELD'`); agency assigns crew+leader â†’ `missions` (`DISPATCHEDâ†’PICKUPâ†’LIVEâ†’COMPLETED|ABORTED`); lead one-tap Finish opens `PENDING_RELEASE`; release sweep pays the agency; `NO_PROVIDER` = cascade exhausted with no accept (no charge).
- Required metric set (this is the spec): `dispatch_rank_query_ms` (the PostGIS ST_DWithin ranking query latency), `dispatch_acceptance_rate`, `dispatch_avg_cascade_depth`, `dispatch_no_provider_rate{region}`, `dispatch_offer_timeout_rate`, `dispatch_time_to_crew_ms` (acceptâ†’mission created), `dispatch_charge_failure_rate`, `dispatch_watchdog_sweep_duration_ms` + `dispatch_watchdog_last_run_ts{sweep}` (liveness), `dispatch_money_drift_total` (incremented by the reconciliation sweep in Step 28), `dispatch_completion_gate_fail_total{reason}` (from the proof gate).
- Reuse â€” observability already exists: `apps/auth-service/src/observability/sentry.service.ts` exposes `SentryService.captureException(e, ctx)`, `addBreadcrumb`, `opsDecisionBreadcrumb(action, admin, subject)`, `reportCriticalAuditFailure(action, subject, err)` and an `isEnabled` flag; it is a no-op shim when `SENTRY_DSN` is unset (CI/dev stay silent). The module is `observability.module.ts`. There is NO Prometheus registry today and NO `/health` route in `main.ts` (only `app.listen`). The metric sink and health controller are NEW.
- Reuse â€” Redis-locked sweep liveness: the canonical multi-pod-safe pattern is `apps/auth-service/src/booking/payment-pending-expiry.service.ts` â€” `setInterval` + `redis.client.set(LOCK_KEY, ts, 'PX', LOCK_TTL_MS, 'NX')`, work only if `got==='OK'`, `finally { redis.client.del(LOCK_KEY) }`, `LOCK_TTL_MS < SWEEP_INTERVAL_MS`. The dispatch watchdog + the Step-28 sweeps MUST copy this (NOT `@nestjs/schedule`; auth-service is multi-replica). Each sweep stamps `dispatch_watchdog_last_run_ts` on every successful (lock-won) run; the alert fires if any sweep's last-run is older than 2Ã— its interval.
- Reuse â€” audit + feed: `apps/auth-service/src/ops/ops-audit.service.ts` `OpsAuditService.record(entry)` / `recordAdmin(admin, action, subject_type, subject_id, metadata)` writes `ops_audit`; critical actions (in `CRITICAL_ACTIONS`) are fail-closed (re-throw â†’ caller txn rolls back) and fan to Sentry. `emit(FeedEvent)` writes `live_feed_events` (the dashboard activity stream); `recentFeed(limit)` reads it. The override actor MUST be recorded here.
- Reuse â€” push stays opaque: `apps/auth-service/src/ops/booking-push-bridge.service.ts` `publish(userId, eventClass, details)` stores `details` under `push-event:<eventId>` (TTL 300s) and publishes EXACTLY `{userId, eventClass, eventId}` on Redis channel `push:events` (`BookingPushBridge.CHANNEL`). messenger-service `src/push/push.service.ts` consumes. P0-N8: never add `bookingId`/`missionId`/`kind` to the published payload. SLO alerts here go to Sentry/PagerDuty, NOT through the opaque push channel.
- Reuse â€” ops-console: Next.js App Router under `apps/ops-console/src/app/` (existing siblings: `live/`, `dashboard/`, `bookings/`, `finance/`). API client `apps/ops-console/src/lib/api.ts` (`fetchJson`, CSRF via `bravo_ops_csrf`, base from `NEXT_PUBLIC_API_BASE_URL`). Role gating `apps/ops-console/src/lib/rbac.ts`: `AdminRole = 'OPS'|'SUPERVISOR'|'ADMIN'`, `hasRole(actual, atLeast)`, hierarchy `ADMIN>SUPERVISOR>OPS`; cancel/force-assign override gates on `hasRole(role,'SUPERVISOR')` (mirror `canDispatchBooking`).
- Correlation id: a single `dispatchCorrelationId` (uuid) minted at request/offer creation, carried through the offer/accept/charge/mission rows (column or metadata), echoed into every structured log line, into the `push-event:<eventId>` detail blob (NOT the opaque channel payload), and forwarded to messenger-service so a single job is traceable auth-serviceâ†’Redisâ†’messenger-serviceâ†’device.
  **Files to touch:**
- NEW `apps/auth-service/src/observability/dispatch-metrics.service.ts` â€” in-memory metric registry (counters/gauges/histograms) with `inc(name, labels)`, `observe(name, ms, labels)`, `setGauge(name, value, labels)`, `snapshot()`; emit to the sink (Prometheus text on `/metrics`, or push to the existing Sentry as breadcrumbs/measurements where appropriate). EXTEND `observability.module.ts` to provide+export it.
- NEW `apps/auth-service/src/observability/health.controller.ts` â€” `GET /health` (liveness: process up) and `GET /ready` (readiness: Redis reachable via `RedisService`, dispatch DB reachable via `DatabaseService.q('SELECT 1')`, watchdog last-run within 2Ã— interval). Public (no JWT) but returns only booleans/coarse status â€” no PII.
- NEW `apps/auth-service/src/ops/dispatch-killswitch.service.ts` â€” runtime flag read from a Redis key (e.g. `dispatch:enabled`) with a short in-process cache; `isAutoDispatchEnabled()`. NOT boot-time env only. When OFF, the request path skips auto-offer and the booking follows the legacy admin flow (`OpsService` job board); the watchdog/sweeps keep running for in-flight jobs.
- NEW `apps/auth-service/src/ops/dispatch-monitor.controller.ts` â€” read-only `GET /ops/dispatch` (in-flight offers/bookings: current holder org, rank/distance bucket, server `expires_at` countdown, reject trail, escrow/money state) + `POST /ops/dispatch/:bookingId/cancel` + `POST /ops/dispatch/:bookingId/force-assign` (SUPERVISOR+). Add `PUT /ops/dispatch/killswitch` (ADMIN) to flip the runtime flag.
- EXTEND `apps/auth-service/src/main.ts` â€” register the health controller's routes are picked up by the module; add `app.enableShutdownHooks()` so sweeps' `onModuleDestroy` runs on SIGTERM.
- EXTEND the dispatch service + watchdog + accept saga (from Steps 7/9) â€” call `DispatchMetricsService` at each instrumented point; mint/propagate `dispatchCorrelationId`; check `dispatch-killswitch` at offer time.
- NEW `apps/ops-console/src/app/dispatch/page.tsx` (+ `dispatch/[id]/page.tsx`) â€” read-only monitor table + money-taken/no-mission watch banner + SUPERVISOR+ cancel / force-assign buttons. EXTEND `apps/ops-console/src/lib/api.ts` with `dispatchApi` (`listDispatch`, `cancelDispatch`, `forceAssign`, `setKillswitch`).
  **Backend how-to:**
- Metrics: build a tiny in-memory registry (avoid a new heavy dep if `prom-client` isn't present â€” confirm with `grep prom-client apps/auth-service/package.json`; if absent, emit Prometheus text by hand on `GET /metrics`). Instrument: wrap the ranking query with `const t=Date.now(); â€¦; metrics.observe('dispatch_rank_query_ms', Date.now()-t, {region})`; on offer accept/expire update acceptance + cascade-depth counters; on acceptâ†’mission-created stamp `time_to_crew`; on charge failure `inc('dispatch_charge_failure_rate')`.
- Watchdog liveness: in each sweep's lock-won branch, `metrics.setGauge('dispatch_watchdog_last_run_ts', Date.now(), {sweep})` and `metrics.observe('dispatch_watchdog_sweep_duration_ms', dur, {sweep})`. `/ready` and the alert evaluator read these gauges.
- Runtime kill switch (race-safe + safe fallback): store `dispatch:enabled` in Redis; `isAutoDispatchEnabled()` reads it (cache â‰¤5s). The offer path is a conditional gate, not a partial commit: `if (!await killswitch.isAutoDispatchEnabled()) { route booking to legacy admin flow; return; }`. Flipping OFF MUST NOT cancel in-flight escrow holds â€” only stop NEW auto-offers. Record every flip in `ops_audit` via `recordAdmin(admin, 'dispatch.killswitch', 'booking'|'system', 'global', {enabled})`.
- Override actions (attributable): each is a conditional UPDATE inside `db.withTransaction`, mirroring `payWithCredits`/the expiry sweep:
  - cancel: `UPDATE lite_bookings SET status='CANCELLED' WHERE id=$1 AND status IN ('DISPATCHING') RETURNING` (0 rows â‡’ 409); if an escrow hold exists, refund via `refundForBooking` in the same txn; then `opsAudit.recordAdmin(admin,'dispatch.cancel','booking',id,{correlationId})`.
  - force-assign: bind the booking to a chosen agency offer (`UPDATE dispatch_offers SET status='ACCEPTED' WHERE booking_id=$1 AND status='OFFERED' RETURNING`), charge into escrow in the same txn (reuse the Step-9 accept saga), then `recordAdmin(admin,'dispatch.force_assign','booking',id,{org})`. Wrap both with the idempotency interceptor: `apps/auth-service/src/common/interceptors/idempotency.interceptor.ts` requires header `Idempotency-Key` (8â€“128, `[A-Za-z0-9_-]`).
  - Guard: reuse `apps/auth-service/src/ops/admin.guard.ts`; gate cancel/force-assign at SUPERVISOR, killswitch at ADMIN.
- SLO alerts (an evaluator that runs in the same Redis-locked sweep cadence): stuck `DISPATCHING` (booking in DISPATCHING > N min with no live offer), watchdog dead (`now - last_run_ts > 2Ã—interval`), region with zero on-duty agencies (`COUNT(*)=0 WHERE on_duty AND region_code=$1` for an active region), `NO_PROVIDER` surge (rate over baseline), charge failures (rate>0 over window), unacked SOS (an `sos` row older than M min with no ack â€” cross-check `OpsController` `POST sos/:id/ack` / `missions.ackSos`). Each alert â†’ `SentryService.captureException(new Error('slo:<name>'), {tags:{kind:'dispatch_slo', slo}})`. Never put PII in the alert payload.
- Correlation id: add `correlation_id UUID` to `dispatch_offers` (and stamp it on the booking metadata + the `push-event` detail blob + forward to messenger-service in the relay metadata). Log lines use it as a prefix; never log lat/lng, addresses, names, or key bytes (the static log-audit test enforces this).
  **Frontend / ops-console how-to:**
- `apps/ops-console/src/app/dispatch/page.tsx`: SWR poll `dispatchApi.listDispatch()` â†’ table of in-flight jobs: current-holder org name, rank #/coarse distance bucket, a CountdownPill driven by server `expires_at`, the reject trail (org + reason, PII-redacted), and an escrow/money column. A red "money taken / no mission" row state when `escrow_holds.status='HELD'` and no `missions` row past a threshold. Buttons (Cancel, Force-assign) render only when `hasRole(role,'SUPERVISOR')` (import from `lib/rbac.ts`); both call through `fetchJson` with a generated `Idempotency-Key`. Read-only for OPS.
  **Security stop-conditions:**
- Push stays opaque: alerts and correlation ids must NOT leak through the `push:events` channel â€” its payload stays exactly `{userId,eventClass,eventId}` (P0-N8). STOP / verify against the System Architecture Documentation before adding any field to the push payload.
- Ops Room is metadata-only: the monitor reads booking/offer/escrow state and `ops_audit`/`live_feed_events` only â€” it must NEVER read or render Ops Room message plaintext or group-key material. STOP / verify against the System Architecture Documentation if the monitor needs any conversation data.
- No "skip in dev" on the admin guard, idempotency, or the killswitch read. The kill switch only changes routing (auto vs legacy); it must never bypass escrow, the proof gate, or any auth guard.
- Never log plaintext message bodies, lat/lng, addresses, names, or ArrayBuffers with key bytes; the static log-audit test enforces this.
  **Acceptance & tests:**
- New unit tests (`apps/auth-service`, Jest): metrics registry inc/observe/snapshot; killswitch reads Redis + caches + defaults safe on Redis error; `/ready` returns false when watchdog last-run is stale or Redis down; override cancel/force-assign are conditional-UPDATE race-safe (0-rows â‡’ 409, no double charge) and each writes an `ops_audit` row with the actor; SLO evaluator fires on each synthetic condition; killswitch flip routes a new request to the legacy flow without touching in-flight holds.
- Regression: the existing `payment-pending-expiry` and ops concurrency specs (`ops.service.concurrency.spec.ts`) still pass; the static log-audit test passes against the new log lines.
- Gates to run: wire these new specs into the auth-service Jest project (Step 27); `npm run lint`; `npm run typecheck` (mobile, â‰¤ baseline 96) and `cd apps/ops-console && npm run typecheck`; manual smoke of the `/dispatch` page (golden: in-flight job renders with countdown; error: OPS role sees no override buttons; flip killswitch â†’ new request goes legacy). Never commit on a red gate; never `--no-verify`.
  **Done when:**
- [ ] `GET /metrics` exposes the full metric set with region labels; `GET /health` + `GET /ready` reflect Redis/DB/watchdog reality.
- [ ] A single `dispatchCorrelationId` traces one job through auth-service logs â†’ Redis â†’ messenger-service â†’ device.
- [ ] `dispatch:enabled` flipped at runtime stops new auto-offers and falls back to the legacy admin flow without disturbing in-flight escrow.
- [ ] Each SLO condition pages via Sentry with no PII; the static log-audit test is green.
- [ ] `/dispatch` monitor shows holder/rank/countdown/reject-trail + money-taken/no-mission watch; SUPERVISOR+ cancel/force-assign work and land an attributable `ops_audit` row.

## Step 27 â€” Testing strategy (CI + unit + integration + contract + chaos + fixtures + gates)

**Stage:** Operate Â· **Depends on:** Step 5 (ranking/region/PostGIS), Step 6 (capacity `has_free_cpo_capacity`), Step 7 (offer/cascade/watchdog), Step 9 (acceptâ†’escrow charge saga), Step 14 (SettlementService + lead Finish), Step 15 (proof-of-completion gate), Steps 9/14 (FSM guards), Step 26 (metrics/killswitch) Â· **Resolves:** Part III "Testing, QA & release engineering" + LB21 + Â§43 must-have tests; the six corrections (esp. #6 "CI does not run auth-service tests")
**Goal (plain English):** Make the automated gate actually exercise the new dispatch engine. Today CI does NOT run the auth-service backend tests, so the new ranking/cascade/money/proof/FSM code would ship untested. This step wires auth-service into CI, adds the unit + real-DB integration + contract + multi-pod-lock + load + chaos tests + seed fixtures, and a legacy-flow regression matrix with the flag OFF â€” and wires the project gates.
**Why it matters / what breaks without it:** Correction #6 proved CI's Jest matrix is `[app, messenger-crypto, booking]` only â€” a new `DispatchService` spec is invisible to the gate. Without this, money bugs (double-charge, never-paid agency), watchdog double-cascade, and capacity over-commit ship green.
**Self-contained context (inline â€” do not make the reader open the plan):**

- CI today (`.github/workflows/ci.yml`): the `test` job is a matrix `project: [app, messenger-crypto, booking]` run via `npx jest --selectProjects <project>`. There is NO `auth-service` entry, so backend specs never run in CI. Correction #6 = fix this.
- The integration harness EXISTS but is unused by default: `apps/auth-service/jest.integration.config.js` (script `npm run test:integration`, `testMatch: test/integration/**/*.itest.ts`) + `apps/auth-service/test/integration/harness.ts` (testcontainers: ephemeral pg, applies every migration, `describeIfDb` collapses to `describe.skip` when Docker is unreachable so CI without Docker still goes green). Existing examples: `concurrency.itest.ts`, `fk-constraints.itest.ts`, `fsm-triggers.itest.ts`. The acceptâ†’chargeâ†’assignâ†’settle saga integration test is the missing one (Â§43).
- The saga under test (LOCKED decisions): D2 charge on accept INTO ESCROW; D3 agency accepts then deploys its own CPOs; D7 accept does NOT auto-pick crew (crew+leader assign creates the mission); settlement is released only after the proof gate + dispute window. Money invariant (Â§43): per booking `sum(client debits)==held`; at terminal `held==to_provider+to_client+platform_fee`; no agency credit row before `release_eligible_at` (or early client-confirm / dispute-resolve).
- Race-safe pattern every transition must follow (and must be tested): one `UPDATE â€¦ WHERE <expected-state> RETURNING` inside `db.withTransaction` (mirror `booking.service.ts payWithCredits` and `payment-pending-expiry.service.ts`). 0 rows â‡’ 409, no side effect. Accept charges the client in the SAME txn as `UPDATE dispatch_offers SET status='ACCEPTED' WHERE id=$1 AND status='OFFERED' AND expires_at>NOW() RETURNING`.
- Watchdog multi-pod lock (the thing the existing test plan ignores): Redis `SET NX` lock from `payment-pending-expiry.service.ts` (`redis.client.set(LOCK, ts, 'PX', ttl, 'NX')`, work only if `'OK'`). The test must prove two concurrent sweepers do NOT both cascade the same offer.
- Capacity gate to test: `has_free_cpo_capacity` (Step 6) â€” D6 = agency runs multiple concurrent missions bounded by free CPO capacity; D5 = ~10 CPO logins per agency. The gate must reject an accept that would over-commit.
- Existing seed gap: no fixtures of on-duty agencies with `agents.last_lat/last_lng/last_location_at/on_duty/region_code` + wallets. These unblock the ranking tests AND the 3-device smoke (Step 28).
- Reuse â€” existing backend specs already present (don't duplicate, run them): `booking/booking-flow.spec.ts`, `booking/state-machine.service.spec.ts`, `ops/ops.service.concurrency.spec.ts`, `ops/mission-state-machine.service.spec.ts`, `ops/job-state-machine.service.spec.ts`, `ops/ops-flow.smoke.spec.ts`.
- Gates: mobile `npm run typecheck` â‰¤ baseline 96; `cd apps/ops-console && npm run typecheck`; `npm run test:crypto` when a change is near messaging (Ops Room rekey/push); the `booking` Jest project for booking changes; `npm run lint`.
  **Files to touch:**
- EXTEND `.github/workflows/ci.yml` â€” add an `auth-service` backend test job (run its Jest unit project) and an integration job that boots Docker and runs `npm run test:integration` inside `apps/auth-service` (gracefully skips when Docker unavailable, but in CI provide a pg service so it actually runs).
- NEW unit specs in `apps/auth-service/src/...`: `dispatch.service.spec.ts` (ranking/cascade), `dispatch-capacity.spec.ts` (`has_free_cpo_capacity`), `settlement.service.spec.ts` (money + proof-gate), plus FSM-guard specs alongside `state-machine.service.spec.ts` / `mission-state-machine.service.spec.ts`.
- NEW `apps/auth-service/test/integration/dispatch-saga.itest.ts` â€” the real-DB acceptâ†’charge(escrow)â†’assignâ†’settle saga incl. failure/compensation, using `harness.ts` `describeIfDb`.
- NEW `apps/auth-service/test/integration/watchdog-lock.itest.ts` â€” two concurrent sweepers, assert no double-cascade.
- NEW contract specs for the new endpoints (offer-coarse/full, accept, reject, crew-assign, lead-complete, dispute/confirm/resolve, `/ops/dispatch/*`) â€” request/response shape + guard/403 + idempotency.
- NEW `apps/auth-service/test/fixtures/dispatch-seed.ts` â€” on-duty agencies with locations + region + wallets + escrow/fee accounts.
- NEW `apps/auth-service/test/load/` (k6 or autocannon script) and `apps/auth-service/test/chaos/` notes/specs.
- NEW `apps/auth-service/test/integration/legacy-flow.itest.ts` â€” regression matrix with the dispatch flag OFF (the legacy admin job board still works end to end).
  **Backend how-to:**
- CI fix (correction #6): add to `ci.yml` a job that runs the auth-service unit suite (either add `auth-service` to the matrix if a root Jest project exists for it, or `cd apps/auth-service && npm ci && npm test`). Add a second job for integration with a Postgres service container so `describeIfDb` does NOT skip: spin pg, set the harness DB env, `cd apps/auth-service && npm run test:integration`.
- Unit (ranking/cascade): seed in-memory/mocked rows, assert nearest-in-region ordering via the PostGIS `ST_DWithin` path, cascade picks next-nearest on reject/expire, region isolation (AE/SA/BD/GB never cross). Capacity: assert `has_free_cpo_capacity` blocks an accept that exceeds free CPOs (D6 bound).
- Money/proof unit (`settlement.service.spec.ts`): accept â†’ exactly one client debit into escrow, NO agency credit; double-tap accept â†’ ONE hold (idempotency + conditional UPDATE); finish with passing proof â†’ `PENDING_RELEASE`, no money moved; finish with failing proof (no telemetry) â†’ `review_required`, never auto-released; assert the Â§43 money invariant at each terminal state.
- Saga integration (`dispatch-saga.itest.ts`, real pg via harness): run acceptâ†’chargeâ†’assignâ†’lead-completeâ†’release; then failure paths: charge fails â‡’ offer NOT won, no hold; crash after charge before booking flip â‡’ reconcile/compensate (the accept-saga crash-recovery from Step 9); agency-no-show sweep â‡’ full refund, no payout. Assert ledger rows balance (paired escrow debit/credit).
- Watchdog lock (`watchdog-lock.itest.ts`): invoke `sweepOnce()` from two instances racing on the same Redis key; assert exactly one wins the lock and exactly one cascade INSERT happens (mirror the expiry service's `skipped_lock` return).
- Contract tests: for each new endpoint assert the exact JSON shape, the guard (e.g. `/dispatch/offers/:id/full` 403 unless `offer.status='ACCEPTED' AND caller==provider`; `assertOrgScope` IDOR 403 cross-tenant), and that POSTs require `Idempotency-Key` (interceptor: header 8â€“128 `[A-Za-z0-9_-]`).
- Load test: simulate an N-deep cascade + client AND provider polling at volume; capture `dispatch_rank_query_ms` and the pollâ†’WS tipping point. Run `EXPLAIN ANALYZE` on the ranking query against 100s of seeded agencies.
- Chaos: kill the watchdog mid-cascade (assert recovery/no orphan), drop Redis (assert killswitch defaults safe, offers degrade, no crash), kill a pod mid-accept (assert no double-charge via the conditional UPDATE + idempotency), expire-vs-accept race (assert one winner: accept inside grace wins, expire after loses).
- Legacy regression: with the runtime flag OFF (Step 26), assert the old `OpsService` admin job board flow (approve/dispatch/complete) is unchanged.
  **Frontend / ops-console how-to:** omit (backend + CI; ops-console is covered by its own `typecheck` gate in Acceptance).
  **Security stop-conditions:**
- Tests must NOT weaken guards to pass â€” no "skip in dev" branch on `verifySenderCert`/`assertOrgScope`/idempotency/admin guard; if a test needs a guard satisfied, satisfy it, don't bypass it. STOP / verify against the System Architecture Documentation if a test appears to need a sealed-sender or group-key shortcut.
- Fixtures and load/chaos logs must not contain plaintext message bodies, real lat/lng beyond synthetic test values, or key bytes â€” the static log-audit test still applies to test helpers that ship in `src`.
- `npm run test:crypto` is required whenever a test touches the Ops Room rekey/push path (near messaging).
  **Acceptance & tests:**
- CI proof: open a PR; the `auth-service` unit job and the integration job both appear and pass (integration actually runs, not skipped, because the pg service is present). A deliberately-broken `DispatchService` change turns CI red (proving the gate now sees backend specs).
- Suites green: new unit specs, `dispatch-saga.itest.ts`, `watchdog-lock.itest.ts`, contract specs, `legacy-flow.itest.ts`; existing `booking`/`messenger-crypto`/`app` projects still pass.
- Gates: `npm run lint`; `npm run typecheck` (â‰¤ baseline 96) + `cd apps/ops-console && npm run typecheck`; `npm run test:crypto` if any change touched messaging; the `booking` Jest project for booking-touching changes. Never commit on red; never `--no-verify`.
  **Done when:**
- [ ] `ci.yml` runs auth-service unit + integration tests; a broken backend change fails CI.
- [ ] Unit coverage exists for ranking, cascade, `has_free_cpo_capacity`, money/proof-gate, and FSM guards.
- [ ] `dispatch-saga.itest.ts` exercises acceptâ†’charge(escrow)â†’assignâ†’settle + failure/compensation against real pg via the harness.
- [ ] Contract tests cover every new endpoint (shape + guard/403 + idempotency); the multi-pod watchdog-lock test proves no double-cascade.
- [ ] Seed fixtures (on-duty agencies + locations + wallets) exist and unblock ranking tests + the 3-device smoke; load + chaos + legacy-flag-OFF matrices run.

## Step 28 â€” Reconciliation + staged rollout + final 3-device smoke

**Stage:** Operate Â· **Depends on:** Step 9 (acceptâ†’escrow charge), Step 14 (SettlementService + lead Finish), Step 15 (proof gate), Step 16 (dispute window/confirm/dispute/resolve), Step 17 (the three Redis-locked sweeps), Step 26 (metrics/killswitch/monitor), Step 27 (fixtures + tests) Â· **Resolves:** Part V Â§43 (money-invariant reconciliation + PV8), Â§42 (Redis-locked sweeps), Part III rollout (dark-launch â†’ canary-by-region â†’ ramp + kill-switch drill), LB21
**Goal (plain English):** Add a nightly money-invariant reconciliation job that proves every booking's wallets still add up (and alerts on any drift), then turn the feature on safely in stages â€” dark launch behind the flag, then one region, then ramp â€” with a deliberate kill-switch drill, and finish with the full 3-device end-to-end smoke plus one no-agency error path.
**Why it matters / what breaks without it:** This is money-handling and safety-critical. Without a daily reconciliation, escrow drift (a charged-but-never-held booking, or a payout without a release) goes unnoticed until a customer complains. Without staged rollout + the kill-switch drill, the first flip exposes all four regions at once with no rehearsed off-switch. The smoke is the only proof the whole loop works on real devices.
**Self-contained context (inline â€” do not make the reader open the plan):**

- Money invariant to assert (Â§43): for every booking, `sum(client debits) == held`; at terminal `held == to_provider + to_client + platform_fee`; and NO agency credit row may exist before `release_eligible_at` (unless an early client `confirm-complete` or a dispute `resolve` moved it). Escrow lives in `escrow_holds` (status `HELDâ†’PENDING_RELEASEâ†’RELEASED`, plus `REFUNDED`/`PARTIAL`/`DISPUTED`); every money move is a PAIRED `wallet_transactions` row (debit one account, credit the other) so the ledger balances; a seeded escrow account + platform-fee account are the counterparties; the final `RELEASED` payout still writes `mission_payouts` (agency = `payee_user_id`) exactly as `OpsService.completeBooking` does today; partials reuse `deduction_credits`/`deduction_reason`; refunds reuse `wallet.service.ts refundForBooking`.
- Reconciliation MUST be a Redis `SET NX`-locked `setInterval` sweep (multi-pod-safe), copying `apps/auth-service/src/booking/payment-pending-expiry.service.ts` (NOT `@nestjs/schedule`; auth-service is multi-replica). It runs daily, recomputes the invariant per booking, and on any mismatch increments the metric `dispatch_money_drift_total` (Step 26) and fires a Sentry SLO alert. It is the 3rd of the three Â§42 sweeps (the other two: crew-assign SLA refund, and release-to-agency).
- Rollout stages: (1) dark launch â€” code deployed, runtime flag `dispatch:enabled` OFF (Step 26 kill switch), legacy admin flow live, watchdog/reconciliation already running; (2) canary by a single region (D4 regions = AE/SA/BD/GB; gate the offer path on `agents.region_code` so only one region auto-dispatches); (3) ramp to remaining regions. Each stage watched via the Step-26 metric set + SLO alerts. A kill-switch drill = deliberately flip OFF mid-traffic and confirm safe fallback to legacy with no stranded escrow.
- The full smoke loop (LOCKED decisions D1â€“D8): register a ~10-CPO roster (D5, one agency = one email set) â†’ client requests close protection Aâ†’B (D1 auto) â†’ server offers nearest on-duty agency in-region, COARSE pre-accept (no exact pickup/dropoff to offered/rejecting agencies â€” correction #3) â†’ agency accepts (D3) â†’ client charged INTO ESCROW on accept (D2) â†’ an E2E Ops Room opens (server `ensureBookingOpsRoom` writes metadata only; the agency company device owns the group-key rekey for added CPOs â€” correction #5) â†’ agency assigns its own crew + leader (D7 â€” this step creates the mission) â†’ CPOs see it + join the Ops Room â†’ lead runs `DISPATCHEDâ†’PICKUPâ†’LIVE` then one-tap Finish (D8) â†’ proof-of-completion gate â†’ dispute window â†’ auto-release to agency â†’ client rates. Error path: no agency online â†’ `NO_PROVIDER`, NO charge.
- Reuse â€” sweep pattern, `refundForBooking`, `mission_payouts` + `deduction_credits/reason`, `OpsAuditService`, the metric/killswitch/monitor from Step 26, the seed fixtures from Step 27. NO crypto/E2E/auth changes here.
  **Files to touch:**
- NEW `apps/auth-service/src/booking/reconciliation.service.ts` (or under `wallet/`) â€” the daily Redis-locked reconciliation sweep; `sweepOnce()` returns `{checked, drifted, skipped_lock}` (mirror `PaymentPendingExpiryService`). EXTEND its module to provide it.
- EXTEND `apps/auth-service/src/observability/dispatch-metrics.service.ts` (Step 26) â€” `inc('dispatch_money_drift_total', {region})` on each detected drift; stamp the reconciliation sweep's `dispatch_watchdog_last_run_ts{sweep:'reconciliation'}`.
- NEW `apps/auth-service/test/integration/reconciliation.itest.ts` â€” real-DB: a clean book passes; a hand-injected drift (orphan debit, or payout-before-release) is detected and counted.
- EXTEND rollout docs/runbook only (no canary-by-region code if region gating already lives in the Step-5 ranking + Step-26 killswitch); confirm the offer path honors a per-region enable.
- NEW (test artifact) `apps/auth-service/test/smoke/3device-dispatch.md` â€” the scripted manual smoke (devices/accounts/steps), reusing the Device & Identity Reference in `sqa.md`.
  **Backend how-to:**
- Reconciliation sweep (copy `payment-pending-expiry.service.ts` exactly): `onModuleInit` â†’ `setInterval(()=>void this.sweepOnce(), DAILY_MS)`; `sweepOnce` â†’ `redis.client.set('lock:reconciliation', ts, 'PX', LOCK_TTL_MS, 'NX')`, run only if `'OK'`, `finally { redis.client.del(...) }`, `LOCK_TTL_MS < interval`. For each booking with a hold: compute `sum(client debits)` from `wallet_transactions` and compare to `escrow_holds.gross_credits` (HELD), and at terminal compare `held == to_provider + to_client + platform_fee`; assert no agency credit row exists before `release_eligible_at`. On mismatch: `metrics.inc('dispatch_money_drift_total')`, `sentry.captureException(new Error('money_drift'), {tags:{kind:'dispatch_money_drift', booking:'<redacted-id-ok>'}})`, and `opsAudit.emit({kind:'money_drift', severity:'err', subject:bookingId, message:'reconciliation drift'})`. The sweep is read-mostly â€” it ALERTS, it does not auto-move money (admin resolves via the Â§41 dispute/resolve path).
- Add `app.enableShutdownHooks()` (if not already from Step 26) so the sweep's `onModuleDestroy` clears its timer on SIGTERM.
- Canary-by-region: ensure the offer path gates on `agents.region_code` + a per-region enable list (Redis-backed, sibling to `dispatch:enabled`), so one region can be flipped on while others stay legacy. No partial-commit risk: it's a routing gate before any charge.
- Kill-switch drill: flip `dispatch:enabled` OFF during canary traffic; assert new requests route legacy and in-flight escrow holds are untouched (use the Step-27 chaos assertions).
  **Frontend / ops-console how-to:**
- No new screens; the Step-26 `/dispatch` monitor surfaces drift via the money-taken/no-mission watch and the rollout metrics. Confirm the monitor renders the reconciliation alert row. (Mobile smoke uses the existing client/agency/CPO apps.)
  **Security stop-conditions:**
- Ops Room stays metadata-only via `SystemMessengerService.ensureBookingOpsRoom`; the server cannot distribute the Signal group key â€” the smoke MUST verify CPOs receive the group key via the AGENCY DEVICE's rekey (correction #5 / the conversations-scoped membership-intent drain), NOT via a server add. STOP / verify against the System Architecture Documentation before touching the rekey path.
- Reconciliation logs/alerts must NOT contain plaintext bodies, lat/lng, addresses, names, or key bytes (static log-audit test). A bare booking id is acceptable in audit/Sentry; PII is not.
- Push stays opaque during the smoke: the wake payload is exactly `{userId,eventClass,eventId}` (P0-N8) â€” verify in messenger-service consumer that no `kind`/`bookingId` leaks.
- No "skip in dev" on the proof gate, escrow, dispute freeze, or any guard during canary.
  **Acceptance & tests:**
- `reconciliation.itest.ts` (auth-service integration project, via the testcontainers harness): clean book â†’ 0 drift; injected orphan debit / payout-before-release â†’ drift detected, `dispatch_money_drift_total` incremented, alert fired. Concurrency: two pods racing the sweep â†’ one wins the lock (assert `skipped_lock`).
- Money-invariant unit assertions from Â§43 (Step 27) still pass: double-tap accept â†’ one hold; finish-with-failing-proof â†’ `review_required`, never released; dispute-vs-release race â†’ dispute freezes, no payout.
- Manual 3-device smoke executed and recorded: the full loop completes (charge into escrow on accept, Ops Room joinable by CPOs via agency rekey, lead PICKUPâ†’LIVEâ†’Finish, proof gate, dispute window, auto-release to agency, client rates) AND the no-agency path yields `NO_PROVIDER` with NO charge (verify wallet unchanged). Log any defects to `sqa.md` per the SQA convention.
- Gates: `npm run lint`; `npm run typecheck` (â‰¤ baseline 96) + `cd apps/ops-console && npm run typecheck`; `npm run test:crypto` (the smoke touches Ops Room messaging); the `booking` Jest project. Never commit on red; never `--no-verify`.
  **Done when:**
- [ ] A daily Redis-locked reconciliation sweep asserts `sum(client debits)==held` and `held==to_provider+to_client+platform_fee`, increments `dispatch_money_drift_total` and alerts on drift, and is multi-pod-safe.
- [ ] Rollout proceeds dark launch (flag OFF) â†’ single-region canary â†’ ramp, each watched by the Step-26 metrics/SLOs; a kill-switch drill confirms safe fallback to legacy with no stranded escrow.
- [ ] `reconciliation.itest.ts` passes (clean = 0 drift; injected drift detected + counted; lock race produces one winner).
- [ ] The full 3-device smoke passes end to end including agency-device group-key rekey, escrow charge-on-accept, lead one-tap Finish â†’ proof gate â†’ dispute window â†’ auto-release â†’ client rating.
- [ ] The no-agency error path yields `NO_PROVIDER` with the client wallet unchanged (no charge); push stayed opaque throughout.

Key verified paths (all confirmed to exist): `apps/auth-service/src/booking/payment-pending-expiry.service.ts` (Redis SET NX sweep pattern), `apps/auth-service/src/ops/booking-push-bridge.service.ts` (opaque `{userId,eventClass,eventId}` on `push:events`), `apps/auth-service/src/ops/ops-audit.service.ts` (`record`/`recordAdmin`/`emit`, fail-closed criticals), `apps/auth-service/src/observability/sentry.service.ts` (shim), `apps/auth-service/src/common/interceptors/idempotency.interceptor.ts`, `apps/auth-service/src/common/guards/user-throttler.guard.ts`, `.github/workflows/ci.yml` (Jest matrix `[app, messenger-crypto, booking]` â€” no auth-service), `apps/auth-service/jest.integration.config.js` + `apps/auth-service/test/integration/harness.ts` (unused saga harness, `describeIfDb`), `apps/ops-console/src/lib/api.ts` + `apps/ops-console/src/lib/rbac.ts` (`AdminRole`, `hasRole`) + `apps/ops-console/src/app/` (App Router, no `dispatch/` dir yet).

---

<!-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Stage 9 Â· Live tracking & navigation (post-1â€“28) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ -->

## Step 29 â€” Backend: mission deployment exposes the principal's live position (dual-marker telemetry)

**Stage:** Live tracking & navigation Â· **Depends on:** Step 5 (duty/location heartbeat), Step 13 (crew/mission), the existing `telemetryApi.clientPing` (client GPS â†’ `missions.client_lat/lng`) Â· **Resolves:** the "map shows BOTH the CPO leader and the user" requirement (dual-marker monitor)
**Goal (plain English):** The live-mission map needs to draw two dots at once â€” the assigned guard (the team **leader/CPO**) AND the **person being protected** (the principal/client). The guard's position already flows to the server (`missions.current_lat/lng`); the client's own phone already pushes its GPS too (`missions.client_lat/lng` via `client-ping`). The deployment read that the map polls just doesn't return the client's dot yet. This step adds the principal's last-known position to that one read, gated to mission crew only.
**Why it matters / what breaks without it:** Without it the agency's per-mission monitor and the CPO's tracker can only ever render one marker â€” the guard. There is no way to see where the principal actually is relative to the guard (the whole point of "show both"). The map HTML already supports a principal marker; only the data is missing.
**Self-contained context (inline â€” do not make the reader open the plan):**

- VERIFIED: the client already pushes its own GPS via `telemetryApi.clientPing(bookingId,{lat,lng})` â†’ `POST /telemetry/:bookingId/client-ping`, stored by `apps/auth-service/src/telemetry/telemetry.controller.ts` as `UPDATE missions SET client_lat, client_lng, client_recorded_at`. So the columns already exist and are populated when the principal's app is on `LiveTrackingScreen` during a LIVE mission.
- VERIFIED: the per-mission map polls `agentApi.getMissionDeployment(missionId)` â†’ `GET /agents/me/missions/:id/deployment`, implemented in `apps/auth-service/src/agents/agent.service.ts` `getMyMissionDeployment()`. Its `missions` SELECT (â‰ˆ line 1007) returns `short_code, status, booking_id, route_distance_m, route_duration_s, route_polyline, current_lat, current_lng, comms_channel_id` â€” but NOT `client_lat/client_lng`.
- VERIFIED: the method already enforces a crew-only membership gate (`if (!crew) throw new ForbiddenException('not_assigned_to_mission')`, â‰ˆ line 1060) â€” a non-crew agent cannot read this mission's coords. Principal coords inherit that same gate; do not loosen it.
  **Files to touch:**
- EXTEND `apps/auth-service/src/agents/agent.service.ts` â€” in `getMyMissionDeployment`, add `client_lat, client_lng, client_recorded_at` to the `missions` SELECT and to the returned `mission` object's TS type.
- EXTEND `src/services/api.ts` â€” add `client_lat: number | null; client_lng: number | null; client_recorded_at: string | null;` to the `getMissionDeployment` `mission` return type.
- EXTEND `apps/auth-service/src/agents/agent.deployment.spec.ts` â€” assert the principal coords round-trip on the payload and that the non-crew 403 still holds.
  **Backend how-to:** Add the three columns to the existing `qOne` SELECT on `missions` and widen its generic type; pass them straight through on the `mission` object (they are already-coarse last-known points the principal volunteered â€” no transform). Do not add a new endpoint; do not log the coordinates. Leave `current_lat/lng` (the guard) exactly as-is.
  **Security stop-conditions:** Principal location is sensitive PII. It must stay behind the existing crew-only membership gate (assigned crew of THIS mission) â€” never returned to a non-crew caller, never to a rejected/offered agency (LB1 coarse-pre-accept is unaffected; this is post-assign, crew-scoped). Do NOT log `client_lat/lng` (CLAUDE.md plaintext-coords rule). No "skip in dev" on the membership gate. STOP/verify against the System Architecture Documentation before widening who can read this beyond mission crew.
  **Acceptance & tests:**
- New/extended (`apps/auth-service` Jest): the deployment payload includes `mission.client_lat/lng/client_recorded_at` when the missions row has them; a non-crew agent still gets 403; null when the principal hasn't pinged.
- Gates: `cd apps/auth-service && npm test`; `npm run typecheck` (mobile, â‰¤ baseline) for the api.ts type change.
  **Done when:**
- [ ] `getMissionDeployment` returns the principal's last-known `client_lat/lng/client_recorded_at`, crew-gated.
- [ ] The api.ts deployment type carries the three fields.
- [ ] Spec covers presence + null + the non-crew 403; auth-service tests green; mobile typecheck â‰¤ baseline.

## Step 30 â€” Dual live markers on the tracker (wire the principal marker in)

**Stage:** Live tracking & navigation Â· **Depends on:** Step 29 Â· **Resolves:** "the map shows the live location for BOTH â€” the CPO (leader) and the user," for the service-provider (agency) monitor and the CPO tracker
**Goal (plain English):** Actually draw the second dot. The map canvas already knows how to render a principal marker (`window.setPrincipal`), but the screen never calls it. Read the principal's position from the Step-29 payload and push it to the map, so on every mission the monitor shows the guard AND the protected person moving in real time.
**Why it matters / what breaks without it:** Step 29 ships the data; without this the map still shows one dot. This is the visible half of "show both."
**Self-contained context (inline):**

- VERIFIED: `src/modules/booking/bravoAgentTrackerMapHtml.ts` already exposes `window.setPrincipal({lat,lng})` (renders the glow `.mk.principal` marker + "Principal" label; passing null/omitted clears it) and `window.setCpo({lat,lng,callsign,heading_deg})`.
- VERIFIED: `src/screens/agent/AgentLiveTrackerScreen.tsx` polls `getMissionDeployment` every 4s and already injects `window.setCpo` from `mission.current_lat/lng`. There is NO `setPrincipal` call today, and no state for the principal coords.
- This screen is the agency per-mission monitor (Step 20) and is the base for the CPO tracker (Step 31). One wiring covers both.
  **Files to touch:**
- EXTEND `src/screens/agent/AgentLiveTrackerScreen.tsx` â€” add `principalLat/principalLng` state, set them in `refresh()` from `data.mission?.client_lat/client_lng`, and add a `useEffect` that injects `window.setPrincipal({lat,lng})` when present and `window.setPrincipal(null)` when absent. (Optional polish: when this screen is the agency monitor, label the CPO marker with the lead's call sign rather than "Â· YOU".)
  **Backend how-to:** none (Step 29).
  **Frontend / ops-console how-to:** Mirror the existing `setCpo` effect: a small `useEffect([webReady, principalLat, principalLng])` that calls `inject(...)`. Guard on `webReady`. Clearing on null keeps a stale principal dot from lingering after the client closes their app.
  **Security stop-conditions:** Render-only; no new fetch beyond the crew-gated deployment read. Do not log the coordinates. Don't surface the principal dot on any pre-accept/coarse surface â€” this screen is post-assign crew-only.
  **Acceptance & tests:**
- New (screen test / mock inject): when `mission.client_lat/lng` are present, `setPrincipal` is injected; when null, `setPrincipal(null)` clears it.
- Manual smoke: 2 devices on one LIVE mission (guard + client both moving) â†’ both dots track on the monitor.
- Gates: mobile typecheck â‰¤ baseline; lint; the `app` Jest project.
  **Done when:**
- [ ] The monitor renders the CPO-leader marker AND the principal marker, both live.
- [ ] The principal marker clears when the client stops pinging.
- [ ] typecheck â‰¤ baseline, lint clean, app tests green, 2-device smoke shows both dots.

## Step 31 â€” CPO Live Mission Tracker + Google-Maps-style turn-by-turn navigation

**Stage:** Live tracking & navigation Â· **Depends on:** Step 21 (CpoNavigator + lead-only mission FSM calls), Step 29/30 (dual markers), the design `Bravo Agent Live Tracker.html` Â· **Resolves:** "for the CPO, implement Bravo Agent Live Tracker.html" + "at the end it updates the route like Google Maps (e.g. 200 m, turn left; cross this area)"
**Goal (plain English):** Give the guard their own live tracker â€” the map-first screen from the design â€” and make the route behave like Google Maps: as the guard drives, the line behind them is "done," the line ahead is "to go," a banner at the top says the next move ("In 200 m, turn left onto Sheikh Zayed Rd"), and the ETA ticks down. The leader still has their one-tap mission control (Start â†’ Go-live â†’ Finish) and SOS.
**Why it matters / what breaks without it:** The CPO's Mission tab today is the static `AssignedMissionDetailScreen` (roster/dress/route text) â€” there is no live map for the guard and no navigation. The guard can't see turn-by-turn guidance to the principal/pickup. The design exists; the map screen exists for the agency; this step brings them to the guard and adds real maneuver guidance.
**Self-contained context (inline):**

- VERIFIED: the design `Bravo Agent Live Tracker.html` is already implemented as `src/screens/agent/AgentLiveTrackerScreen.tsx` + `bravoAgentTrackerMapHtml.ts` (8 z-layers, CPO + principal markers, route base/active/future, on-map chat bubbles, system bubbles, awaiting-telemetry pill, style toggle, mini-status strip, msg dock). Reuse it â€” do NOT re-build the screen.
- VERIFIED MISSING: turn-by-turn. `setRoute` only ever emits a single `base` polyline feature; the `route-active`/`route-future` layers exist but are never fed split data; there is no maneuver banner and no Mapbox **Directions** call anywhere in the repo. ETA is a coarse `now + route_duration_s` decay.
- VERIFIED: the Mapbox token is `process.env.EXPO_PUBLIC_MAPBOX_TOKEN` (public; valid for the Directions API).
- VERIFIED: `CpoNavigator.tsx` is a native stack wrapping the 4 guard tabs (`CpoTabs`) + `Departmental`. The Mission tab = `AssignedMissionDetailScreen`. Lead-only FSM calls exist: `agentApi.missionPickup/missionGoLive/missionComplete` (idempotency-keyed). `getActiveMission()` gives `{status, is_lead, ...}`.
- DECISION (reuse over duplicate): mount `AgentLiveTrackerScreen` in a CPO route with a `mode:'cpo'|'agency'` param rather than copy 800 lines. In `mode:'cpo'` add the lead-only one-tap control (Step 21) and keep SOS; the agency monitor stays `mode:'agency'` (read-only, no FSM buttons). Both share the dual-marker + turn-by-turn map.
  **Files to touch:**
- NEW `src/utils/mapboxDirections.ts` â€” `fetchDirections(from,to,{profile:'driving'})` â†’ `{polyline, distanceM, durationS, steps:[{instruction, distanceM, maneuverType, modifier, location:[lng,lat], bannerPrimary, bannerSecondary}]}` via `GET https://api.mapbox.com/directions/v5/mapbox/driving/{lng,lat;lng,lat}?steps=true&overview=full&geometries=polyline&banner_instructions=true&access_token=â€¦`. Pure parse helpers (`nextManeuver(steps, cpoLatLng)`, `splitRouteAtProgress(coords, cpoLatLng)`, `haversineM`) exported for unit tests. Throttle (â‰¥ every N s) + cache by rounded endpoints; re-fetch only when the CPO deviates from the line beyond a threshold or the destination leg changes (pickup â†’ dropoff).
- EXTEND `src/modules/booking/bravoAgentTrackerMapHtml.ts` â€” feed `route-active`/`route-future` as split features; add `window.setNavRoute({traveled, ahead})` (or extend `setRoute`) and a top **nav-banner** overlay element + `window.setManeuver({distanceLabel, primary, secondary, icon})` / `window.clearManeuver()`. Banner sits at z-layer 7 under the top bar; obeys the brand tokens.
- EXTEND `src/screens/agent/AgentLiveTrackerScreen.tsx` â€” add the `mode` param; in `cpo` mode render the lead-only one-tap Start/Go-live/swipe-Finish (wired to `missionPickup/GoLive/Complete`, non-lead read-only) and keep SOS; drive the maneuver banner + active/future split + ETA from `fetchDirections(cpo â†’ activeTarget)`; advance the maneuver as the CPO passes each step; surface a "Re-routingâ€¦" system bubble on deviation. Agency mode = today's behavior (no FSM buttons).
- EXTEND `src/navigation/CpoNavigator.tsx` + `src/navigation/types.ts` â€” register a `CpoLiveTracker:{missionId}` route on the CPO root stack (pushed full-screen over the tabs, like `Departmental`); add `mode` to `AgentStackParamList['AgentLiveTracker']` (default `'agency'`).
- EXTEND `src/screens/cpo/AssignedMissionDetailScreen.tsx` â€” add an "Open live tracker / Navigate" CTA when the mission is `DISPATCHED|PICKUP|LIVE` â†’ navigate to `CpoLiveTracker:{missionId}`.
  **Backend how-to:** none required â€” Directions is a client-side Mapbox call with the public token; the route/ETA stay client-computed. (Optional later: persist the chosen polyline server-side; out of scope here.)
  **Frontend how-to:**

1. **Active target:** pickup while `DISPATCHED/PICKUP`, dropoff while `LIVE` (mirror the mission FSM). Fetch directions CPO â†’ activeTarget.
2. **Split:** project the CPO onto the returned geometry; everything behind = `traveled` (active/solid), ahead = `future` (dashed). Re-split each fix; no server round-trip.
3. **Maneuver banner:** pick the first step whose `maneuver.location` is still ahead of the CPO; distance = haversine(cpo, step.location); show `bannerPrimary` ("Turn left onto â€¦") + `bannerSecondary`; format distance ("200 m" / "1.2 km"). "Cross this area"-type cues come straight from the banner text. Clear within ~30 m of the final arrival.
4. **ETA:** from the Directions `durationS` (live), replacing the coarse decay.
5. **Lead-only control (cpo mode):** compute the action from `getActiveMission().status` + `is_lead` exactly as Step 21; idempotent; on error stay at the current state.
   **Security stop-conditions:** Directions uses the existing PUBLIC Mapbox token â€” no secret added, no key logged. Do NOT log principal/CPO coordinates or pass them through any server log. The CPO tracker is crew-gated by the Step-29 read; the lead-only FSM endpoints already enforce lead identity server-side â€” never self-promote to lead on the client. Comms reuse the existing Ops Room (no new message types/envelopes). SOS path unchanged. STOP/verify against the System Architecture Documentation before changing mission FSM transitions or Ops Room membership.
   **Acceptance & tests:**

- New unit (`app`/booking Jest, mock `fetch`): `mapboxDirections` parses steps/banners; `nextManeuver` advances correctly as the CPO passes a step; `splitRouteAtProgress` yields traveled+ahead; `haversineM` sanity. Pure functions â€” no map needed.
- New: the `modeâ†’button` selector (cpo+lead â†’ Start/Go-live/Finish; cpo+non-lead â†’ read-only; agency â†’ none).
- Regression: the `app` Jest project (covers the existing tracker); `npm run test:crypto` only if the Ops Room path is touched (it isn't â€” read-only deep-link).
- Gates: mobile typecheck â‰¤ baseline (new route param + util types); lint.
- Manual smoke (dev build, leader device): open tracker from the Mission tab â†’ both dots render â†’ drive â†’ banner shows next maneuver with live distance, route splits traveled/ahead, ETA ticks down, maneuver advances at each turn; deviate â†’ "Re-routingâ€¦" â†’ fresh line. Lead one-tap Start â†’ Go-live â†’ Finish advances every party's stepper. Non-lead = read-only + chat + SOS. Error path: directions fetch fails â†’ keep the last route + "navigation unavailable," map still tracks.
  **Done when:**
- [ ] The CPO reaches a live map tracker (the design) from the Mission tab; both CPO + principal markers render.
- [ ] Turn-by-turn: top banner shows the next maneuver + live distance; route splits traveled (solid) / ahead (dashed); ETA is Directions-driven and ticks down; maneuver advances as the CPO passes each step; deviation re-routes.
- [ ] Lead-only one-tap Start/Go-live/Finish + SOS in cpo mode; agency mode stays read-only.
- [ ] `mapboxDirections` pure-function unit tests + the mode/button selector test pass; app project green; typecheck â‰¤ baseline; lint clean; leader smoke passes.

**As-built (Steps 29â€“32 shipped 2026-06-25 on `main`, commit `2dabd87`) â€” deviations + review hardening:**

- The maneuver banner renders in **React Native** (in `AgentLiveTrackerScreen`), not in the WebView HTML â€” consistent with the rest of the chrome; the HTML only gains `window.setNavRoute({traveled, ahead})` for the split line.
- Directions use `geometries=geojson` (no polyline decode). `src/utils/mapboxDirections.ts` exposes pure helpers `haversineM`, `nearestIndexOnRoute`, `offRouteDistanceM`, `remainingRouteM`, `splitRouteAtProgress`, `nextManeuver`, `formatDistance`, `parseDirectionsRoute`, `fetchDirections`.
- The lead-only one-tap control (Start/Go-live/Finish) stays on `AssignedMissionDetailScreen` (which already owns it) â€” the tracker is the map/nav surface only (matches the design, which has no FSM buttons). The shared `AgentLiveTrackerScreen` serves three modes via a `mode` route param: `agent` (AgentNavigator), `cpo` (CpoNavigator; commsâ†’Comms tab, terminalâ†’`goBack`), `monitor` (Step 32; org-scoped read, SOS hidden).
- Adversarial multi-agent review (security: **0** findings) â†’ **7 fixes applied**: (1) **ETA counts down** â€” scale `durationS` by `remainingRouteM/distanceM`, not the full cached duration; (2) **follow-camera + one-shot framing** â€” `fitBounds` once (`framedOnce`), then `easeTo` follows the CPO until the user drags (`follow` flag); (3) **off-route = perpendicular distance to the nearest segment**, not nearest vertex (kills the false re-fetch loop on straight roads); (4) **re-route bubble fires only on the rising edge** of a deviation; (5) **target-staleness guard** â€” the cached route is reused only when its target key matches, and a late in-flight result for a stale target is dropped (no pickup leg after going LIVE); (6) **style swap re-applies** the last route via cached `lastNav/lastBase` payloads; (7) `nextManeuver` uses `>=` so the turn stays shown while the guard is on it. Left intentionally: the tracker keeps the navy "Brand Kit v4" palette of the supplied design (not the obsidian CPO chrome).
- Jest gotcha: a module that reads `process.env.EXPO_PUBLIC_*` cannot be imported under the `app` Jest project (babel-preset-expo rewrites it to `expo/virtual/env`, which that project does not transform) â€” the directions test mocks `expo/virtual/env`.

## Step 32 â€” Service-provider (org manager) per-mission live monitor

**Stage:** Live tracking & navigation Â· **Depends on:** Step 13 (org missions board + `assigned_provider_user_id` tenant gate), Step 29/30 (dual-marker data + wiring), Step 31 (the shared tracker + `mode` param) Â· **Resolves:** the "service provider, for each mission, sees the live location for BOTH the CPO leader and the user" requirement for the company/manager (desk) view â€” not just the on-scene crew
**Goal (plain English):** The company manager who assigned the crew (but isn't on-scene) gets a per-mission live map from their missions board â€” the same dual-marker tracker, showing the CPO leader and the principal moving in real time. It reads through an org-scoped endpoint so a manager can only ever watch their OWN org's deployments.
**Why it matters / what breaks without it:** The crew-gated deployment read (Step 29) only serves an agent who is ON the mission; the manager (non-crew) would get 403. Without an org-scoped read there is no manager monitor â€” only the assigned guard could see the map.
**Self-contained context (inline):**

- VERIFIED: `apps/auth-service/src/org/org-mission.service.ts` `listMissions(orgUserId)` already tenant-scopes every row by `lite_bookings.assigned_provider_user_id = $1`; the controller (`org.controller.ts`, `@UseGuards(JwtAuthGuard, OrgManagerGuard)`) resolves the caller's org via `@CurrentOrgManager()` â†’ `manager.org_user_id` (never a path param â€” IDOR-safe).
- VERIFIED: `missions` carries `current_lat/lng` (CPO leader) and now `client_lat/lng/client_recorded_at` (principal, Step 29). The shared tracker (`AgentLiveTrackerScreen`, Step 31) takes a `mode` param and reads a deployment-shaped payload.
  **Files to touch:**
- EXTEND `apps/auth-service/src/org/org-mission.service.ts` â€” `getMissionLive(orgUserId, missionId)`: a single org-gated mission SELECT (`JOIN lite_bookings b â€¦ WHERE m.id=$1 AND b.assigned_provider_user_id=$2`; null â†’ `ForbiddenException` = IDOR closed) returning the SAME shape as `getMyMissionDeployment` (mission incl. current+client coords, `crew_role` = the lead so the marker is labelled, booking, waypoints, crew; `checks`/`dress` null). ISO-normalize `client_recorded_at`.
- EXTEND `apps/auth-service/src/org/org.controller.ts` â€” `@Get('missions/:missionId/live')` â†’ `orgMission.getMissionLive(manager.org_user_id, missionId)`.
- EXTEND `src/services/api.ts` â€” extract the deployment response into a shared `MissionDeploymentResponse` type, reuse it for `agentApi.getMissionDeployment`, and add `orgApi.getMissionLive(missionId)` returning the SAME type so the tracker consumes either source unchanged.
- EXTEND `src/screens/agent/AgentLiveTrackerScreen.tsx` â€” add `'monitor'` to the `mode` union; fetch via `orgApi.getMissionLive` when `mode==='monitor'`; hide SOS (the manager is off-scene and `raiseSos` is crew-gated); terminal â†’ `goBack`; comms/calls use the AgentNavigator routes (Chat/CallScreen, already registered).
- EXTEND `src/screens/agent/OrgMissionsScreen.tsx` â€” a "Monitor" CTA on Active rows â†’ `navigation.navigate('AgentLiveTracker', {missionId, mode:'monitor'})`.
- EXTEND `src/navigation/types.ts` â€” widen `AgentLiveTracker` mode union to `'agent' | 'cpo' | 'monitor'`.
  **Security stop-conditions:** Principal location is PII. The monitor read is OWNER-ORG only (SQL tenant gate, mirrors `listMissions`; null â†’ Forbidden) â€” never a rejected/non-owning agency, never via a path-param org id. Do NOT log coords. SOS is hidden in monitor mode (and the server keeps `raiseSos` crew-gated regardless). No "skip in dev" on `OrgManagerGuard`. STOP/verify against the System Architecture Documentation before exposing principal location beyond owner-org crew + owner-org manager.
  **Acceptance & tests:**
- New (`apps/auth-service` Jest, `org-mission.live.spec.ts`): a non-owned/unknown mission â†’ `ForbiddenException`; the owning org gets both `current_lat/lng` + `client_lat/lng` (ISO `client_recorded_at`) + the lead call sign.
- Gates: `cd apps/auth-service && npm test`; mobile typecheck â‰¤ baseline; lint.
- Manual smoke: manager opens OrgMissions â†’ Monitor on an active mission â†’ both dots track; opening another org's mission id is rejected.
  **Done when:**
- [ ] `GET /org/missions/:id/live` is owner-org gated and returns both positions in the deployment shape.
- [ ] The manager reaches the dual-marker map from OrgMissions (mode `monitor`); SOS hidden; terminal goes back.
- [ ] org-mission live spec green (Forbidden + both-coords); typecheck â‰¤ baseline; lint clean.

## Hotfix 2026-07-02 â€” `bundle_authority_sig_missing` on send (P0-I2 controller drop)

**Symptom:** every new-session send fails with `KeysHttpError(495, 'bundle_authority_sig_missing')` after pulling the messenger audit batch (`fa1d9fc`).
**Root cause:** the audit batch flipped the client strict (`productionRuntime.ts` â†’ `requireBundleBinding: true` + pinned `authorityPubKeyB64`), but `keys.controller.ts` `GET /auth/keys/:userId` destructured only `{bundle, poolSize}` from `keys.service.fetchBundle()` and returned `bundle` â€” silently dropping the sibling `authoritySig` the service computes. The client reads `resp.authoritySig` at the TOP level of that response, so strict mode always threw. (`GET :userId/devices` was unaffected â€” it returns per-entry `authoritySig` verbatim.)
**Fix:** controller now returns `{...bundle, authoritySig}` (`apps/auth-service/src/keys/keys.controller.ts`). New regression spec `keys.controller.spec.ts` (controller had ZERO coverage â€” how the drop shipped) asserts top-level `authoritySig` present, and null passthrough when the server has no authority key.
**Deploy (Contabo staging):** full-`src` sync (62 files drifted since 2026-06-23 deploy) â†’ `tar` â†’ `scp` â†’ replace `~/bravo/apps/auth-service/src` (backup `~/auth-predeploy-backup-20260702-195905.tgz`, prior image `336c808a6d8d`) â†’ `docker compose build auth-service && up -d --no-deps --force-recreate`. Verified: container healthy, `/auth/health` 200, empty login â†’ 400 (not 500; `grep -c signal_device_id dist/auth/auth.service.js` = 4), `grep -c authoritySig dist/keys/keys.controller.js` = 2, startup logs clean.
**Gates:** keys suites 10/10 green; full auth-service run = 1603 passed, 3 pre-existing failures (`dispatch-room-intents.service.spec.ts`, `booking-flow.spec.ts`) verified pre-existing via stash-rerun â€” unrelated to this change.

## Remediation batch 2026-07-04 - Mapbox audit fixes (docs/audits/MAPBOX_AUDIT.md)

**Scope:** all code-fixable findings from `docs/audits/MAPBOX_AUDIT.md` (repo root). One batch, flag-free (behavior fixes to existing surfaces).

**Mobile map HTML (WebView Mapbox GL JS, bumped 3.7.0 -> 3.9.0 everywhere):**

- `bravoLiveRouteMapHtml.ts` (C-2/C-3): markers created once + `setLngLat`; vehicle dot glides via rAF lerp (snaps on >~5 km jumps); `fitBounds` only on first frame or A/B change (`framedOnce`/`boundsKey`); RECENTER pill after user pan/zoom; `navActive` guard so the straight-line fallback no longer clobbers the Directions split; errors now `post({type:'err'})`; compact attribution restored (ToS).
- `bravoAgentTrackerMapHtml.ts` (M-2/H-6): "Follow" pill re-enables the follow camera after a manual pan (was one-way forever); CPO/principal markers glide (rAF lerp, bubble anchors ride along); `callsign` + system-bubble `label` moved to `textContent` (XSS sinks closed); attribution restored.
- `bravoLocationPickerMapHtml.ts` (L-9/M-10): map `center` now `JSON.stringify`-injected (no raw numeric interpolation); reverse-geocode debounce 180->350 ms + skipped when the pin moved <25 m (quota + latency); attribution restored.
- `vbgKeyPointsMapHtml.ts`: version bump + attribution restored.

**Screens:**

- `LiveTrackingScreen.tsx` (H-2/H-3/M-1/L-8/L-1/H-4): ALL polls + the GPS watch now gate on `useIsFocused()` + `AppState` (battery); WS `onTelemetry` fix now feeds the map directly (newest-of WS/poll wins); off-route >60 m on a REAL fix triggers a throttled reroute from the live position (sim track exempt - it is off-road by construction); "Telemetry delayed" banner when the winning fix is >45 s old; `source` memoized; `onRenderProcessGone`/`onContentProcessDidTerminate` remount + `webReady` reset.
- `AgentLiveTrackerScreen.tsx` (M-6/L-6/M-3): `webReady` resets on `onLoadStart` + crash handlers remount the WebView (no more injecting into a blank map after an OS WebView kill); waypoint `seenWaypoints.add` moved AFTER the coord null-check (waypoints that arrived before the first fix are no longer permanently dropped); `heading_deg` passes through to the HTML cone when the deployment read provides it (`MissionDeploymentResponse.mission.current_heading_deg?` added - BACKEND STILL PENDING: deployment/live reads do not return heading yet).
- `LocationPickerScreen.tsx` (H-4/M-8): loading + failed overlays (retry button remounts); Confirm gated on map `ready` (no more confirming over a blank map); regions with no coverage zones (GB/ZA) get an explicit "NOT AVAILABLE IN THIS REGION" CTA.
- `VbgKeyPointsMap.tsx` (H-1): props are re-pushed on `[centre, points, radiusKm]` change - the second GeoRisk analysis no longer shows the first run's map; crash remount added. `VBGGeoRiskScreen.tsx` (M-9): autocomplete fetch aborts superseded requests (AbortController) + alive-guards on the async setQuery paths.
- `IntelFeedScreen.tsx` + `bravoMapHtml.ts` (H-6/L-4): news-feed `label`/`sub`/count HTML-escaped before `innerHTML` (external-data XSS closed); map WebView stays mounted across tab switches (hidden, pointerEvents off) instead of full Leaflet reboot; `mixedContentMode` always->compatibility; stable `MAP_SOURCE`.
- `JobMarketplaceScreen.tsx` (L-5): static map URL memoized. `useLocation.ts`: one-shot gets `timeout`/`maximumAge`; watch gets `interval`/`fastestInterval`. `AgentDashboardScreen.tsx` (M-11): GPS errors now `console.warn` the error CODE (no coords).

**Ops console:** `BravoMap.tsx` flyTo now value-diffs center/zoom (no more camera yank every 2 s poll); alt-route layers rebuilt only on a real content change (signature guard); `live/[id]/page.tsx` memoizes `route`/`altRoutes`/`mapCenter`.

**Config/hygiene:** `driving-traffic` is the default Directions profile (congestion-aware ETAs; new URL test in `mapboxDirections.test.ts`); `react-native-maps` REMOVED from package.json (dead dep - zero imports; lockfile synced); orphaned `BravoBookingMap.tsx` + `bravoBookingMapHtml.ts` DELETED; inline Mapbox token removed from `apk:*` scripts (comes from `.env`/`.env.production`); real token replaced with a placeholder in `.env.staging.local.example`; static-image URLs no longer strip `logo/attribution` (ToS). H-5 (declared-but-unbuilt background location): removal was applied then REVERTED by product decision - the `ACCESS_BACKGROUND_LOCATION`/`FOREGROUND_SERVICE_LOCATION` declarations and iOS `'always'` requests STAY; the Play-review risk remains open until the location foreground service + iOS `location` background mode are actually built.

**Still open (not code-fixable here):** rotate + URL-restrict the pk token in the Mapbox dashboard and move it to EAS secrets / untracked env (it remains in git history and `.env.production`/`eas.json`); backend `current_heading_deg` on deployment/live reads; the strategic `@rnmapbox/maps` native-SDK migration (audit C-1).

**Gates:** mobile typecheck 46 errors before AND after (all pre-existing baseline; APK still requires a device smoke of the map surfaces - GL JS 3.9.0 bump is untested on-device); ops-console typecheck + lint clean; changed-file eslint clean; Jest all projects - see session notes.

## Fix batch 2026-07-05 - B-46 offline-message loss on recipient identity churn (client-only)

**Symptom (SQA):** a 1:1 message A sends while B is logged out never appears on B after B re-logs-in - no bubble, no placeholder, no error. Root-caused by code audit (full analysis: `sqa.md` B-46 + `docs/audits/MESSAGING_AUDIT.md` addendum).

**Root cause:** NOT relay routing (all device-id `1`, dwell/queue sound, plain sign-out non-destructive). It is identity CHURN: any event that leaves B with a fresh Signal identity (reinstall / cleared data / `wipeAtRest` / cross-install login / a failed BackupRestore - the last hard-broken on v1.0.92-94 per B-45) makes A's already-sealed envelope (outer-ECIES bound to B's OLD identity) undecryptable. B's drain then `unwrapOuter`-throws and acks the envelope `'discarded'` (hard-delete) with zero trace; sealed sender means no per-conversation placeholder is possible. The relay tells A via `envelope.undeliverable` and A flips the bubble `undelivered`, but there was NO auto-resend and NO resend affordance.

**Fix (client-only - NO server deploy / NO DB migration; the relay/auth paths are all sound):**

- **Fix 1 - sender auto-resend.** New `src/modules/messenger/runtime/undeliverableResend.ts` (`selectUndeliverableResend`: pure eligibility + 1-attempt LRU budget). The `envelope.undeliverable` handler (`productionRuntime.ts`) now runs a `resendUndeliverable` closure: evict `peerIdentityCache`, `forceRefreshOutgoingSession` (overwrite trusted identity + `removeSession` + fresh X3DH against the peer's CURRENT authority-signed bundle - send-side mirror of `peerIdentityRefresh.ts`), re-seal the row's plaintext, re-submit over HTTP relay under a NEW `clientMsgId` (old id is dedup-poisoned for the dwell window). Own outbound 1:1 TEXT only, non-expired, direct convo, one automatic attempt. Success -> bubble `sent`; failure -> stays `undelivered`.
- **Fix 1b - manual fallback.** `ChatScreen.retrySend` + status chip now treat `undelivered` like `failed` -> "Tap to retry" on a 1:1 text bubble.
- **Fix 2 - recipient banner.** `messengerStore.undecryptableDropCount` + `noteUndecryptableDrop`/`clearUndecryptableDrops` (session-scoped, envelopeId-deduped, LRU-bounded, NON-persisted). Both outer-unwrap discard sites (`productionRuntime.ts` drain catch + WS `handleDeliver` catch) count before ack-`discarded`; `MessengerHomeScreen` shows a dismissable amber banner. Count banner is the disclosure ceiling (per-thread placeholders impossible by design).
- **Fix 3 - DEFERRED (stop-condition).** Auto-purging the stale recipient queue on fresh-identity boot needs an architecture-approved MFA-token mint for `RecipientPurgeGuard` (P1-T2). Left for a dedicated pass.

**Security posture:** no crypto/ack/dwell primitive weakened. Resend is an ordinary new submit against an authority-signed bundle (same trust model as first-contact send + receive-side rotation refresh); the counter is UI-only. Messages already sealed to a dead identity remain unrecoverable on B by design (sealed sender, no escrow) - Fix 1 recovers from the SENDER; Fix 2 makes the loss visible on the recipient. **Client mirrors server:** the relay `envelope.undeliverable` contract and the `signal_device_id`/dwell semantics are unchanged - the fix is purely how the client REACTS to the existing server signal.

**Tests:** `src/modules/messenger/__tests__/undeliverableResend.test.ts` (13 cases). **Gates:** messenger-crypto 1348 pass, full suite 1657 pass, mobile tsc 46 (<=49 baseline, no new errors), lint 0 errors.

**On-device retest (this build):** repro B-46, confirm (a) A's message re-lands on churned B via the auto-resend, and (b) B's MessengerHome banner shows for any residual undecryptable drop; also confirm the "Tap to retry" chip appears on an `undelivered` 1:1 text bubble.

## Fix batch 2026-07-05 (PM) - B-48 killed-app notification blackout (push-token lifecycle)

**Symptom (SQA):** notification-heavy app but NO banners while killed/backgrounded (messages AND calls); everything appears on next open. Prior 2026-07-02 push audit (PUSH-B1..B6) verified LIVE and working - failure was the recipient having NO/DEAD token at send time (7-day Contabo census: 28 `no-tokens` + 4 dead-token of 74 chat wakes ~= 43% never reached FCM). Full analysis: `sqa.md` B-48.

**Fixes:**

- **Server (deployed to Contabo 2026-07-05 ~11:20 UTC, overlay + restart, verified healthy):** `push.service.ts` (1) `cleanupBadTokens` reaps a dead FCM token from BOTH keyspaces by exact token match (kills the half-alive DATA/VOIP twin state; iOS-safe - APNs token never matches); (2) `sendChatWake` falls back to the recipient's android VOIP-channel token when the DATA copy is missing (`push.chat.voip-fallback` log).
- **Client (NEXT APK - rebuild required):** `fcmBootstrap.ts` new `ensurePushRegistered()` (60s-throttled, idempotent re-register of both `/push/register*` rows) called from `productionRuntime.ts` on every WS `connected` - heals server-side token reaping the `serverRegistered` flag can't see, and partial registrations, without waiting for an app restart.
- **NOT changed:** logout/single-device-takeover push-revoke tombstones (P0-N2 security design).

**Client mirrors server:** no wire/contract change - client fix only re-POSTs the existing register endpoints; server fixes only change Redis-side token hygiene + token selection.

**Tests:** +7 specs `push.service.spec.ts` (twin reap both directions, iOS non-match, other-device isolation, VOIP fallback android-only + no-token paths). Gates: messenger-service 195/195 + build clean; mobile messenger-crypto 1348/1348; mobile tsc 46 (<=49 baseline).

**On-device retest (next APK):** kill app WITHOUT logging out -> send msg + call from another device -> banner + ring must show; server log must show `push.chat.delivered`/`voip.delivered` (or `voip-fallback`), and after an account-switch + switch-back, wakes must resume within one WS reconnect (no app restart).

## Fix batch 2026-07-05 (PM-2) - Call-UI parity P1: device-default RINGTONE (client-only, APK rebuild REQUIRED)

**Plan:** `docs/planning/CALL_UI_WHATSAPP_PARITY.md` §4 Option A. The old ring played the looped default NOTIFICATION chime (channel `sound:'default'` != TYPE_RINGTONE) and our Telecom bridge is selfManaged so the OS never rings for us.

**Changes:**

- **NEW native module** `android/.../BravoRingtoneModule.kt` (+Package, registered in `MainApplication.kt`): plays `RingtoneManager.getActualDefaultRingtoneUri(TYPE_RINGTONE)` looped with USAGE_NOTIFICATION_RINGTONE + transient audio focus; skips playback in silent/vibrate ringer modes (channel vibration still buzzes); **native 45s auto-stop** (killed-app headless JS can die before a JS stop arrives) matching PUSH-B5 `timeoutAfter`; stops on module invalidate (app teardown); idempotent per callId, new callId preempts.
- `src/modules/messenger/push/incomingRingtone.ts` (NEW): JS bridge, silent no-op when module absent (old APK/iOS), `RING_TIMEOUT_MS=45_000` must stay == the notification `timeoutAfter`.
- `callNotification.ts`: channel migrated `bravo-incoming-call` -> **`bravo-incoming-call-v2`** (channels are immutable; v2 is SILENT - no `sound` key; v1 deleted at ensure); `loopSound` removed; `showIncomingCallNotif` starts the ringtone AFTER the card displays; `dismissCallNotif` (the single ring-exit funnel: accept/decline/remote-hangup/slim killed-app tap) stops it.

**Invariants preserved:** PUSH-B5 45s timeout + missed-call notif; PUSH-B6 group decline; B-21 killed-app ring (headless-safe, no runtime boot); notifee/Telecom callId dedupe; P1-N2 generic wake payload untouched. No server/protocol change.

**Tests:** `src/modules/messenger/__tests__/incomingRingtone.test.ts` (6 cases: 45s contract, stop funnel, silent-v2-channel + v1 delete, no loopSound, missing-module no-op, native-throw containment). Gates: messenger-crypto 1354/1354, tsc 46 (<=49), Kotlin compile - see session notes.

**On-device retest (next APK):** ring on killed/background/foreground/locked; change phone ringtone in OS settings -> next ring uses it; silent + vibrate modes -> no sound, vibration only; answer/decline/remote-hangup/45s-timeout all stop the sound (grep logcat `bravo.ring`/`BravoRingtone`); regression: missed-call notif still posts, group decline still works.

## Fix batch 2026-07-05 (PM-3) - Call-UI parity G5: PiP corner snap (client-only)

CallScreen already had draggable PiP + tap-to-toggle chrome + chrome auto-hide; the remaining WhatsApp-smoothness delta was release behavior: the self-view parked wherever the finger stopped (clamp-only). Now it SPRINGS to the nearest of the four corners, staying clear of header chrome (top inset 120) and the control row (bottom inset 140). Pure snap math in NEW `src/modules/messenger/webrtc/pipLayout.ts` (no RN imports - node-testable); wired in `CallScreen.tsx` pipResponder release. Tap-slop chrome-toggle behavior unchanged. Tests: `pipLayout.test.ts` (7 cases incl. fling-off-screen + degenerate viewport). Gates: messenger-crypto 1361/1361, tsc 46 (<=49). On-device: drag self-view during a 1:1 video call -> snaps to nearest corner with spring; tap still toggles controls.

## Fix batch 2026-07-05 (PM-4) - Parity SS5: caller identity on the ring (server LIVE, client next APK) + call-screen polish pass

- **SS5 (Ranak-approved, relaxes audit P1-N2):** VoIP wake now carries pseudonymous `fromUserId` + `callKind` (UNSIGNED - HMAC canonical form unchanged, old APKs verify; display-only, admission still HMAC-gated). Server: `push.service.ts` sendVoipWake param + data fields; `messenger.gateway.ts` both call sites (1:1 voice/video, group group-voice/group-video). **Deployed to Contabo via overlay (push.service.js + messenger.gateway.js) + restart, healthz 200.** Client: `fcmBootstrap.ts` warm bg handler resolves the LOCAL contact name from messengerStore by peer userId (fallback 'Bravo contact'), correct kind labeling + group roomId routing; killed-app headless path already passed the fields through. Gates: messenger-service push+gateway 78/78 + build clean.
- **Call-screen polish pass (P2-P4 replacement per Ranak: keep today's screens, professional padding/spacing):** styles-only sweep over CallScreen / GroupCallScreen / IncomingGroupCallScreen / FloatingCallOverlay - see commit diff for specifics.

## Fix batch 2026-07-05 (PM-5) - VBG full audit remediation + light "white background" map style + map detail (client APK rebuild REQUIRED; auth-service deploy REQUIRED)

**Audit:** `docs/audits/VBG_AUDIT_2026-07-05.md` (score 64/100, 4 HIGH / 10 MEDIUM / 7 LOW). ALL findings remediated this session (H-3 partially — see doc). Per-finding status table appended to the audit file.

**Maps (all 5 surfaces — user request "white background option + more detail"):**

- Every map gained a **LIGHT (light-v11, white background)** style option: VBG key-points map (new in-map DARK|LIGHT segment), LiveTracking route map (new in-map DARK|LIGHT|SAT segment + brand-new `window.setStyle` swap API with payload re-apply), agent tracker (RN toggle now DARK|LIGHT|SAT|3D), location picker (cycle dark→light→streets→satellite; grid overlay hidden on light/streets), ops-console BravoMap (`light` style id + live/[id] cycler; pages that don't control `styleId` now get a built-in cycler button).
- Every vector map gained **high-zoom 3D building extrusions** (`bravo-3d-buildings`, minzoom 14.5, inserted under the first label layer) + `antialias:true`; LiveTracking maxZoom 16→18, picker 18→19. Layer mounting standardized on **`style.load`** (initial + after every swap) — mounting on early `styledata` ticks corrupts the style load (browser-verified).
- **PRE-EXISTING SHIPPED BUG found & fixed by browser smoke:** `bravoLiveRouteMapHtml` route-line used an invalid `match` expression (even arg count, no default) — GL rejects the layer **asynchronously**, so the LiveTracking A→B route line NEVER rendered in v1.0.93 (error was posted to the absent RN bridge, invisible). Fixed to pairs+default; verified rendering (amber traveled / green ahead) in dark AND after light swap.

**VBG backend (auth-service — NOT yet deployed to Contabo):**

- **H-1 watchdog:** 60s `sweepOverdueMonitoring()` (OnModuleInit) escalates `active` rows whose heartbeat lapsed `interval_min×3`, once per silent window via new `vbg_monitoring.escalated_at` (migration `vbg_watchdog_and_snapshot_columns` APPLIED to Supabase, additive + index).
- **H-4:** all escalation SMS (panic / biometric 3rd-fail / watchdog / geofence breach) now target the **Next-of-Kin favorites** (`escalationPhones()`, fallback principal). Geofence fan-out takes a lazy phone resolver.
- **M-1:** Overpass keypoints `node[...]` → `nwr[...]` + `out center` (way/relation-mapped hospitals/police now found). **M-2:** telemetry stream MAXLEN 500→3000 + 30s downsample (≈25h trail — Location History "last 24 hours" now true). **M-4:** ingest errors are BadRequestException (400s not 500s). **M-5:** AES-GCM AAD binding `vbg1:<userId>` (server verifies AAD-first, legacy no-AAD fallback) + `recordedAt` clamped to [now-10m, now+2m]. **M-6:** geofence eval skipped for zone-less users (60s cached count; zone CRUD invalidates + resets `last_zone_state`). **M-7:** bounded `TtlCache` for gdelt/newsdata/gnews/geocode caches. **M-8:** score media-volume bias documented at the formula. **M-10:** snapshots persist region/context/level/summary/counts (same migration). **L-2:** undated articles no longer stamped "now". **L-5:** `/vbg/threats` returns `country` ISO2. **L-7:** key-at-rest trust model documented.
- Tests: vbg suites 43→**49 passing** (watchdog, AAD accept/reject, recordedAt clamp, kin-SMS, principal fallback, Overpass way/center, M-6 skip). Pre-existing failures elsewhere (booking-flow FSM, dispatch-room-intents) unchanged — fail identically on clean HEAD.

**VBG mobile (client mirrors server):**

- **H-2:** NEW `VbgScanPrompt` on Home — polls monitoring status, when the interval window lapses prompts a device-biometric verify → `POST /vbg/biometric/checkin` pass|fail (unconfigured devices: tap = pass, mirroring BiometricGate). **H-3 (partial):** 3s encrypted-telemetry loop moved out of VBGHomeScreen into app-wide `src/services/vbgTelemetry.ts` (onDutyHeartbeat idiom; AppState-gated; started from MainNavigator boot + SRA enroll + VBG Home). True background survival still needs the location FGS (owner-deferred, same as onDutyHeartbeat).
- **M-3:** Home geofence badge is now live (`listGeofences`): "Geofence Active" only with ≥1 zone, else "No Geofence". **M-9:** Home "Live Location" card renders the REAL `VbgKeyPointsMap` mini-map (with nearby pins) when a fix exists; schematic TacticalMap is only the no-fix placeholder. **M-5:** client seals telemetry with the user-bound AAD. **L-1:** key-point pins show name labels (textContent — XSS-safe). **L-3:** `useVbgLocation` re-fixes on every screen focus (failed refresh never clobbers a good fix). **L-4:** GeoRisk keypoints continuation alive-guarded. **L-5:** Emergency screen pins by geocoded ISO first (name/device-locale fallbacks). **L-6:** SRA enroll button reflects server `monitoringStatus`.

**Gates:** auth-service tsc clean + vbg jest 49/49; mobile tsc 47 errs (HEAD was 49; baseline 96; none in touched files); ops-console tsc clean; mobile vbg+heartbeat jest 31/31; eslint clean on all touched files (repo-idiom `no-void` warnings only). Browser runtime smoke (Chrome, real token): all 4 WebView maps — light swap, 3D detail, radius/route/marker survival, zero console errors.

**Deploy checklist:** (1) Supabase migrations — DONE (additive). (2) auth-service → Contabo — **DEPLOYED 2026-07-05 ~13:43 UTC** (dist/vbg overlay via docker cp into `bravo-staging-auth` + restart; backup at `~/vbg-audit-bak-<stamp>` on the host; container healthy, Nest boot clean). (3) Mobile — next APK (joins the pending vc123 rebuild queue). (4) Ops console — redeploy for the light style.

**Deploy fallout — B-49 (CRITICAL, pre-existing, FIXED):** the watchdog's first sweep exposed that `SosService.raise` was broken on staging — `sos_events` never got the client-panic columns (`user_id/booking_id/location/status/payload/resolved_by`) and carried an agent-era `mission_id NOT NULL`. Every VBG panic / escalation SOS insert had been failing silently. Fixed with additive migrations `sos_events_client_panic_columns` + `sos_events_mission_id_nullable`; **watchdog then live-verified end-to-end** (re-armed stale test enrollment → SOS row `vbg_biometric_missed` created + `escalated_at` stamped at 13:47:25 UTC, no re-fire on later sweeps; verification row resolved). Full entry: `sqa.md` B-49.

---

## 2026-07-05 — Bravo Credits BC-peg remediation (CREDITS_BC_AUDIT)

Full audit + same-day remediation of the BC top-up / deduction / manage / add flows. Findings + fix log: `docs/audits/CREDITS_BC_AUDIT.md` (F-01..F-15).

**Money-rule change (affects several planned steps):** the peg is now **1 fiat unit = 1 BC**, hard-coded in `WalletService.computeCreditsForFiat` (round(amount); FX table is receipt metadata only). `BRAVO_CREDITS_PER_USD` env is removed. Client mirror `src/screens/booking/creditMath.ts` (`BC_PER_USD = 1`, packages price == credits, discount tier removed). **All user-facing money renders as "BC"** — mobile + ops-console fiat/"cr" renders were swept; ops dashboard GMV KPI now uses the new `gmv_today_bc` (SUM(total_eur)) wire field.

> ⚠️ **Step 25 (i18n / per-region currency) conflict:** that step plans `formatCurrency(amount, region)` → AED/SAR/BDT/GBP renders. Under the BC rule this must NOT be applied to in-app money (everything stays "BC"); `src/utils/currency.ts` was rewritten as a BC formatter. Revisit Step 25's currency scope before implementing it.

Other changes shipped in this pass:

- Race-proof top-up settle (`settlePendingTopup`: status-guarded flip + credit in one txn; webhook/client-confirm double-credit closed) and transactional `applyCreditDelta` / promo redeem / fallback top-up.
- `GET /wallet/credits/batches` implemented (expiry finally visible in CreditsScreen); mobile client switched to authHttp.
- Purchase reachability: `Credits`/`PaymentMethods` registered in the Agent (agency) navigator; Top-Up button on EarningsScreen; CPO shell deliberately excluded (§35A §D capability lockdown, cpoCapability.test.ts); `onTierInsufficient` → ProPaywall (client shell); ProRetainers footer link to ProPaywall.
- Ops manual adjustment: `POST /ops/wallets/:userId/adjust` (SUPERVISOR/ADMIN, ±100k, reason mandatory, idempotent) + Finance-page Credit Adjustment card (`canAdjustWallet` RBAC).
- Migration `20260705000000_wallet_bc_audit_guards.sql` (promo tables codified + `CHECK (bravo_credits >= 0)` with platform-account exemption) — **applied to Supabase staging**.
- Hourly cron now also runs `reconcileBalances()` (ledger↔balance drift detection, warn-only).
- Deleted dead racy `WalletService.debitForBooking` (payWithCredits remains the locked debit path).

**Remnants closed (round 2, same day):** agent hourly rates + Est. Earnings now render BC via the canonical 350 AED = 86 BC ratio (`bcFromAed` helpers, mirrors pricing.service.ts); `POST /wallet/topup` accepts usd/aed/eur/sar/gbp/bdt (industry settlement-currency whitelist, award = round(amount) under the 1:1 peg).

**Deploy checklist:** Contabo auth-service redeploy required (peg + settle + new endpoints); Supabase migration already applied; mobile needs a rebuild for the client-side changes.

---

## 2026-07-07 — Webapp data-coverage remediation (WEBAPP_DATA_COVERAGE_AUDIT)

Full remediation of the webapp-vs-DB coverage audit (`docs/audits/WEBAPP_DATA_COVERAGE_AUDIT_2026-07-07.md`, DC-01..DC-21). Score 61 -> ~82/100. Report-then-fix, same day.

**DB (Supabase migrations applied):**

- `webapp_audit_rls_bucket_index_hygiene` — RLS enabled on promo_codes/promo_redemptions/invoices/invoice_sequences (DC-05, cleared 4 ERROR advisors); dropped `avatars_public_read` listing policy (DC-13); dropped duplicate `idx_vbg_monitoring_active_beat`; added covering FK indexes (job_applications.agent_id, escrow_holds.offer_id, cpo_shift_sessions.shift_id, dispatch_room_intents.booking_id); one-time null of `wallet_transactions.stripe_client_secret` on non-pending rows (DC-14).
- `webapp_audit_retention_cron` — pg_cron nightly purges: expired OTPs >7d, dead auth_devices >90d, live_feed_events >90d (DC-11). Backlog purged immediately (654 OTP rows).
- `webapp_audit_drop_legacy_tables` — dropped 16 dead tables (DC-12): bookings/booking_addons/booking_assignments/itineraries/gps_pings(+default)/corporate_accounts/corporate_members/wallets/audit_events/message_envelopes/vault_items/media_recipient_grants/agent_coverage_zones/intel_items/intel_sources. Public table count 91 -> 75.

**Backend (auth-service):** new `OpsDataController`/`OpsDataService` under `/ops` — disputes list, finance reads (transactions/escrows/payouts/invoices/promos/wallet-overview), user directory + detail + device revoke, SOS log, VBG monitoring, global audit browser + org/agent-audit readers, analytics rollups (incl. signal prekey low-watermark), mission telemetry replay, broadcasts-recent. Compliance service: armed permits now ride `/ops/compliance/pending` + new `POST /ops/armed/:id/reject`. Pagination `?limit=` on bookings/agents/completed-missions. Wallet settle paths null stripe_client_secret. Removed the dead `message_envelopes` DELETEs from booking/settlement (table dropped). agent_audit surfaced on agent detail (`state_audit`).

**Ops-console:** nav +Users/SOS Log/VBG/Audit; new pages /users(+[id]) /sos /vbg /audit; Finance rebuilt (7 tabs incl. Disputes + wallet-context adjust + CSV); Analytics + Messenger stubs replaced with real data; Compliance handles armed rows; bookings search/service-chips/load-more wired (DC-17); agents real filters + load-more; live completed load-more; fake topbar Cmd-K removed. `opsDataApi` + SWR hooks added to `lib/api.ts`.

**Deferred (rationale in the audit doc):** DC-04 account suspension/erasure (auth-flow stop-condition), DC-11 messenger backup sweep (product decision), DC-16 telemetry map overlay UI (next UI pass — API shipped), DC-20 broadcast composer (product), DC-21 (NEW) avatars anon write/overwrite — needs a coordinated mobile release to signed upload URLs before dropping the anon policies.

**Gates:** auth-service tsc clean + jest 94 suites / 1663 tests; ops-console tsc clean + next lint clean + production build. Security advisors: 0 ERROR / 0 WARN (was 4 ERROR + 1 WARN).

**Deploy checklist:** (1) Supabase migrations — DONE. (2) auth-service + ops-console — push-to-main staging auto-deploy (deploy-staging.yml). (3) Mobile — DC-21 avatars signed-upload switch queued for the next APK.

### Follow-up — 2026-07-07 (second pass: DC-04, DC-21, users-filter)

- **DC-21 (avatars anon write) closed.** Edge Function `avatar-upload-url` (service-role, verify_jwt off) verifies the Bravo JWT via auth-service `/auth/me` and mints a signed upload URL scoped to `<userId>/avatar.<ext>`. Mobile `src/services/supabase.ts` uploads via `uploadToSignedUrl`. Migration `avatars_drop_anon_write_policies` dropped `avatars_anon_insert`/`avatars_anon_update`. Advisors 0 ERROR/0 WARN. **Avatar upload needs the next APK** (old build still uses anon path); reads unaffected.
- **DC-04 (suspension + erasure) closed.** Migration `users_account_suspension` (+suspended_at/reason/by). auth-service login/verify/refresh gate on `suspended_at IS NULL`. Ops endpoints: POST /ops/users/:id/suspend (SUPERVISOR+, revokes sessions), /restore, /erase (ADMIN-only GDPR: deleted_at + PII scrub + revoke). User-detail page controls + banner. Regression test in auth.service.spec.
- **Users-page filter fix.** role chip Client→individual, KYC Verified→approved, added Lite/Pro tier filter (backend ?tier=). Fixes the empty "Client" filter.
- **Gates:** auth-service tsc + jest (auth.service.spec 32/32 incl. suspension gate); ops-console tsc + lint + build clean; mobile tsc 47 (baseline 49). **Deploy:** Supabase migrations + edge function DONE; auth-service + ops-console via push-to-main; mobile avatar change rides the next APK.

### Follow-up — 2026-07-07 (ops-console UX bugs: scroll, sidebar, sign-out)

Three reported ops-console defects (`apps/ops-console`), all deployed via push-to-main staging auto-deploy.

- **Page not scrollable (commit 28fe870).** `.main-area` in `globals.css` was `overflow: hidden`, clipping any page taller than the viewport (users/finance/audit lists couldn't be scrolled). Now `overflow-y: auto` + `overflow-x: hidden`. Map pages (`/live`) are unaffected — their content fits exactly via `flex:1; min-height:0`, so no scrollbar appears for them.
- **Sidebar confusing → grouped, collapsible (commit 207cf09).** The 64px icon-only rail (18 flat items, hover tooltips only) is now a labelled sidebar grouped into Overview / Operations / Dispatch / Safety / Comms & Org / Finance, with a collapse toggle back to the icon rail (persisted in `localStorage` under `bravo_ops_rail_collapsed`). `Shell.tsx` renders `NAV_GROUPS` (icons reused from `NAV` by href); `.app-shell[data-rail]` switches grid width 216px↔64px.
- **Can't sign out (commit 207cf09).** Logout depended on the server's `DELETE /auth/session` Set-Cookie deletions landing; if that 401s (expired access token), fails CORS on the cross-subdomain call, or the delete attributes don't match, the JS-readable `bravo_ops_csrf` cookie survived and both the login page and `Shell` read its presence as "logged in" → bounce loop. `clearSession()` now expires `bravo_ops_csrf` directly from JS across all domain candidates, and `logout()` does a hard `window.location.replace('/login')` so the refresh/idle timers, SWR cache and messenger provider tear down and can't resurrect the session.
- **KNOWN follow-up (auth stop-condition, NOT changed):** `DELETE /auth/session` still needs a valid access token to revoke the device/refresh row server-side. On an expired-token logout the client fix logs the user out of the console (Shell won't re-arm refresh once csrf is gone), but the DB device row + httpOnly refresh cookie survive until natural expiry. Hardening the server to always revoke touches an auth/session stop-condition — flag for architecture sign-off before changing.
- **Gates:** ops-console tsc + next lint + production build all clean. **Deploy:** ops-console deployed to Contabo staging (run 28851353290, Deploy ops-console 2m41s); live smoke `/login` 200, `/` 307→/login, CSP intact.

### Follow-up — 2026-07-07 (finance white-screen + /departments scroll)

- **Finance page crashed on load (commit 32e00ca).** The 7 finance tabs render `{data!.map(...)}` inside a `<Panel>` wrapper that gates loading/error/empty internally — but JSX children evaluate eagerly in the parent before Panel runs, so on first render (SWR `data` still undefined) `data!.map` threw `Cannot read properties of undefined (reading 'map')` and the default LEDGER tab white-screened. Fixed by guarding all six maps with `(data ?? [])`. **Root pattern to avoid:** a wrapper component that "guards" via internal early-returns does NOT protect its eagerly-evaluated children — the other new pages (users/sos/vbg/audit/compliance/messenger/incidents) use a lazy ternary (`… === 0 ? <empty/> : (<>…{data!.map}…</>)`) so only Finance was affected. Shipped in the finance rebuild because gates were tsc/lint/build only, never a live render.
- **/departments not scrollable (commit 3b481bf).** `.main-area` is a flex column; the departments table sits in a direct child with `overflow:'hidden'`, whose automatic flex `min-height` therefore collapses to 0 — so it shrank to the leftover viewport height and clipped the table with no scroll. Added `flexShrink:0` so it keeps full content height and `.main-area` scrolls. Only page with a crushable `overflow:hidden` direct child of main-area and no inner scroll region (dashboard/live cards share the overflow but live inside `flex:1;min-height:0` grids with inner `overflow:auto`). The `.main-area` `overflow:hidden→auto` change (commit 28fe870) already covers all natural-height (`space-y-6 p-6`) pages.
- **Gates:** ops-console tsc + build clean. **Deploy:** run 28852797267 success; `/login` 200.

## 2026-07-07 — Role & tier lifecycle remediation (ROLE_AUDIT RS-01..RS-19)

Full remediation of the role/tier audit (`docs/audits/ROLE_AUDIT_2026-07-07.md`). Method: design workflow (6 cluster patch-specs + stop-condition critic) → implement → adversarial verify workflow (3 cluster reviewers + synthesis) → fix the 2 confirmed defects → re-verify. Client-mirror strip: mobile `tier.ts` `PRO_MONTHLY_BC=2000` still mirrors auth-service `SubscriptionService.PRO_MONTHLY_BC`.

**auth-service:**

- RS-01: `CpoSessionGuard` mounted on `AgentController` (+provided in `AgentModule`); new shared `AuthService.revokeAllUserSessions` (Redis JTI + auth_devices + push — the DC-04 mechanism); `OrgCpoService.setMemberStatus` revokes sessions on suspend/remove (injects `AuthService`).
- RS-04/RS-11: `OpsService.revertRoleOnAgentExit` (terminate/reject → `users.role`='individual', **guarded against reverting an active agency owner/manager/agent** via 3 `NOT EXISTS`), + `user.role.change` ops_audit + session revoke. `OpsService` injects `AuthService` (`@Optional`, mirrors redis/sentry so positional specs survive).
- RS-05: messenger ticket minted from `AuthService.getCurrentRole` (fresh DB); `AgentService.create` role-flip revokes access JTIs (soft, refresh preserved).
- RS-09: deleted dead `adminRegisterVerify` + `admin-register-verify.dto.ts` (403 stub kept). Invite flow still unbuilt (feature).
- RS-17/18: `SubscriptionService` — NULL `pro_active_until` = permanent comp grant (consistent webhook+sweep, no user stripped); `sweepLapsedPro` backstop downgrades stripe-linked past_due/canceled rows **>14 days** past (past Stripe retry window) and **does NOT null `stripe_subscription_id`** (invoice.paid self-heal depends on it — verify-fix).
- server RS-19 + TierGuard: `booking.service.ts` itinerary gate + `TierGuard` (dormant) both honor `pro_active_until` (lapsed Pro = Lite immediately).

**mobile:** RS-06 root AppState-resume `/auth/me` refresh for all shells (`MainNavigator`; CpoNavigator mount-only) — **teardown gated to `account_kind==='cpo'`** so a transient refresh outage can't logout the warm userbase (verify-fix); RS-07 clear `pendingProvider` on signOut; RS-19 `tier.ts` local-expiry guard at 4 call-sites; RS-15 `roleLabel` badge.

**ops-console:** RS-15 shared `roleLabel` (`lib/format.ts`) in users list/detail + finance; `canResolveDispute` decoupled from `canAdjustWallet`.

**DB (applied to staging + committed):** `20260707120000_tighten_users_role_taxonomy.sql` (demoted 1 `ops` row → individual, still an active admin; `users_role_check` → 3 values), `20260707120100_normalize_cpo_pool_role_casing.sql` (4× `cpo`→`CPO`). **Manual/human-gated:** `scripts/manual/RS-14_purge_e2e_agent_fixtures.sql` (3 E2E fixtures — NOT auto-run).

**Deferred/withdrawn:** RS-03 **withdrawn** (audit error — paywall is live inline in booking.service; blanket `@RequireTier` would 403 Lite bookings); RS-16 env-flag rollout (`STRICT_VALIDATION`, old-APK risk); RS-02/RS-08 E2E group-key stop-conditions (need architecture sign-off); RS-10 CPO⇄manager feature.

**Gates:** auth-service **96 suites / 1679 tests** + tsc; mobile tsc **47 ≤ 49** + RS-19 tier unit test (6/6); ops-console tsc + build; migrations verified on staging (0 ops/corporate rows, cpo_pool 32 CPO, constraint tightened, Ops-1 still active admin). Adversarial verify workflow: auth session/role cluster CLEAN; 2 confirmed defects (RS-06 logout-wave, RS-18 sub-link null) both fixed + re-verified.

## 2026-07-08 — Splash screen redesign (design import) + tsc baseline 49→47

Reimplemented `src/screens/auth/SplashScreen.tsx` from the Claude Design project (id `04cfb9f1…`, file **"Bravo Secure Splash.html"** / `src/vbg-splash.jsx`, the "premium redesign" splash). The design's placeholder winged-V `WingMark` was **replaced with the official `@components/BravoMark`** (logo kept intact, per request). No backend/DB/flow change — still `navigation.replace('Onboarding')` after the ~2.5s bar fill.

- **Build:** 3-stop bg gradient (`#0B1830→#0A1428→#070C18`), accent `#2F6FE0`. Logo tile 132/r32 with border + top-highlight, continuous float, two staggered pulse rings. Wordmark "BRAVO SECURE" (33/800/ls8) + mono tagline "ENTERPRISE SECURITY PLATFORM". Bottom loader: 3px track, gradient fill (`#1E4FB0→#2F6FE0→#7FA8FF`) eased `Easing.out(poly 2.2)`, dot + "LOADING · MAX 2.5S". Uses `expo-linear-gradient` + `react-native-svg` (both app-standard).
- **Reuse:** ambient halo uses the existing shared `@components/Halo` (unique-gradient-id safe) instead of a hand-rolled SVG; vignette is a static SVG radial overlay.
- **Review (adversarial workflow — 3 reviewers → per-finding verify):** 9 raw → 3 confirmed, all fixed — (low) infinite `Animated.loop`s + `ring2` `setTimeout` now captured and `.stop()`/`clearTimeout`'d on unmount; (nit) bar ease-out to match spec; (nit) tile gradient angle → ~160°. Dismissed: sequential rise-in, halo 42%-vs-38% (co-located with vignette by design).
- **tsc baseline 49→47** (`npm run tsc:rebaseline`; ratchet down-only) — CLAUDE.md updated 96→47 to match.
- **Gates:** mobile tsc **47 = baseline** (0 errors in `SplashScreen.tsx`) + ESLint clean. **On-device visual smoke: PENDING** — debug build is installed on the Pixel 6a and Metro is up, but the phone can't reach Metro (Windows Firewall Private-profile block on inbound `:8081`; Wi-Fi `adb reverse` doesn't deliver). Needs a firewall allow (elevated) or a USB cable to hot-reload + screenshot.
- **Update (device link):** the firewall block WAS opened (elevated: disabled the 2 node Private BLOCK rules + added an inbound TCP 8081 Private allow), but Metro still got no bundle. Root cause proven: **Wi-Fi AP/client isolation** — `ping 192.168.1.159` _from the phone_ is 100% loss even though phone (`192.168.4.195/21`) and PC (`192.168.1.159/21`) share `192.168.0.0/21` and the phone's route is on-link. The AP forwards PC->phone (adb works) but drops phone->PC. So wireless Metro is impossible on this network regardless of firewall; **USB** (loopback) is the only reliable live-check path. Firewall allow rule `Bravo Metro 8081 (dev)` left in place.

## 2026-07-08 - Department Channels redesign (design import)

Restyled `src/screens/messenger/DepartmentChannelsScreen.tsx` (the Channels-tab list in `DepartmentalNavigator`) from the Claude Design file **"Bravo Department Channels.html"** / `src/vbg-channels.jsx` to the obsidian design language. **All functional logic preserved** - a git-diff regression reviewer confirmed the entitlement gate, `departmentApi.listChannels`, `openChannel`/`recoverChannel` provisioning + orphaned-owner reactivate, `drainMembershipIntents`, the single `useFocusEffect` loader, store-sourced unread, `DepartmentChat`/`ManageChannels` nav params, board/department/incident grouping, and the INACTIVE (D1-i) state are byte-identical to HEAD.

- **Build:** reuses the shared `_obsidian` kit (`OB` palette, `AmbientBg`, `Card`+`EdgeLight`, `SectionLabel`, `BravoFont`) - same primitives as `DepartmentalHomeScreen`. New: left-aligned header (back + title + subtitle + manager-only gear), 3 summary chips (Channels / Unread / Admin, accent-tinted when active), grouped channel cards with a 46px type tile (brighter on unread), name + role badge, preview, and a gradient unread pill (`#6E9BF5`->accentDeep) vs chevron. Bottom 5-tab bar is the navigator's native tab bar (not rebuilt).
- **Reuse:** badge state delegates to the shared `channelStateMeta` (replacing the local `rowState` duplicate); a `badgeTone` map converts its OB colours (some are `rgba()`) into valid `{fg,bg,border}` tints - avoiding the invalid hex-alpha concat the design's `color+'1A'` trick would produce on rgba tokens.
- **Review (adversarial workflow - regression + RN + design -> per-finding verify):** 12 raw -> 3 confirmed, 2 fixed - (low) non-manager/gate header rendered a phantom bordered box in the gear slot -> transparent `hSpacer`; (nit) row name 16->16.5. Skipped 1 nit (store-selector churn - idiomatic zustand, returns a primitive so no re-render).
- **Gates:** mobile tsc **47 = baseline** (0 errors in the file) + ESLint 0 errors (pre-existing `useNavigation<any>` warning only, unchanged from the original). **On-device smoke PENDING** - same Wi-Fi client-isolation blocker as above; USB needed to hot-reload the Channels tab.

## 2026-07-08 - Files / File Vault redesign (design import)

Restyled `src/screens/messenger/FilesScreen.tsx` (root of the **Vault** tab in `DepartmentalNavigator`, also used by `MessengerNavigator`) from the Claude Design file **"Bravo Files Vault.html"** / `src/vbg-files.jsx` - the Files screen with filter tabs, a dashed drop-zone empty state, and a **gold File Vault promo**. This is the navy->obsidian migration for the screen. **Security-critical:** the File-Vault MFA gate (`openVault(navigation)`) is untouched - a security-regression reviewer confirmed byte-identical logic vs HEAD, and `vaultMoveGuard.test.ts` (7/7) still passes.

- **Build:** OB obsidian palette + `AmbientBg` + `BravoFont`; header (back + "FILES" wordmark ls3 + search), ALL/DOCS/IMG/VID/VOICE filter tabs (mono key + count, glowing accent underline, accentSoft active count), empty state with an **SVG dashed drop-ring** (react-native-svg `strokeDasharray` - RN `borderStyle:'dashed'`+`borderRadius` renders solid on Android) + folder glyph + 2 trust chips (E2EE-accent / R2-neutral), and a **gold gradient File Vault promo** (`rgba(46,39,24)`->`rgba(20,20,17)` card, gold border, `Halo` corner glow, `#EBD9AE`->`#E2C893`->`#C9AB6F` "OPEN VAULT" button).
- **Preserved:** media-derived rows/counts/visible (`selectMediaMessages`), `pushToVault` audit-S1 honest-fail (in-vault->remove, else "coming soon"), per-row shield (now gold), `AttachmentFileViewer` + `removeMessage`-on-delete, and the `openVault` MFA entry.
- **Review (adversarial workflow - security-regression + RN + design -> per-finding verify):** 13 raw -> 1 confirmed (nit: Android dashed->solid drop ring), fixed via the SVG ring. Regression reviewer verified the MFA gate + all data logic unchanged; nested LinearGradient, non-memoized `visible`, and timestamp concerns all dismissed as non-issues.
- **Gates:** mobile tsc **47 = baseline** (the lone FilesScreen error is the pre-existing `Icon name={iconConf.name}` string, unchanged) + ESLint 0 errors (pre-existing `||`->`??` warning only) + `vaultMoveGuard` 7/7. **On-device smoke PENDING** - same Wi-Fi client-isolation blocker; USB needed.

## 2026-07-08 - Channel Thread redesign (design import)

Restyled `src/screens/messenger/DepartmentChatScreen.tsx` (the `DepartmentChat` route - E2EE department channel thread) from the Claude Design file **"Bravo Channel Thread.html"** / `src/vbg-channel-chat.jsx`. **Security-critical & preserved:** the role gate (admin-only composer + **send-time `departmentApi.listMembers` re-verify -> viewer block**) and the E2EE fan-out (`rt.sendText` -> broadcastToGroup) are byte-identical to HEAD - a security-regression reviewer confirmed send(), both useFocusEffects (roster hydration + key self-heal `requestGroupKeyResync`), the useEffect (pullEnvelopes/markRead), @mention/slash/announce, the provisioning gate, and AttachmentFileViewer are all unchanged.

- **Build:** OB obsidian palette + `AmbientBg` + `BravoFont`; header (back + cobalt glyph tile with # + glow, title, "N members · [lock] Encrypted" meta) keeping the manager-only members button; pinned notice; **sender-grouped** messages (32px gradient avatar + initials + mono name shown once per consecutive-sender run), **day dividers**, edge-lit bubbles (incoming rgba-white r16/top-left-4; mine accentDeep right-aligned + `check-all` read ticks), design file cards (doc tile + OPEN), amber announcement + accentSoft/amber @mentions, composer (amber announce toggle + lock+input pill + cobalt-gradient send).
- **Additive rendering-only helpers:** message grouping (showDay/showHeader), day dividers, header member count. Verified not to drop/reorder/alter any message's content.
- **Review (adversarial workflow - security-regression + RN + design -> per-finding verify):** 12 raw -> 6 confirmed, **0 fixed by design** - all 3 substantive findings are PRE-EXISTING (present in HEAD, not regressions), logged for a future messenger-perf pass: ScrollView-not-FlatList + per-message recompute [medium], `onContentSizeChange` unconditional scroll-to-end [low], inline `/announce` send-failure loses announce intent on retry [low]. The other 3 are nits (placeholder/`memberCount` cosmetic; redundant-but-TS-required `!prev`; first-of-day time appears in both divider and bubble meta = design-faithful). Security reviewer: role gate + E2EE send path UNCHANGED.
- **Gates:** mobile tsc **47 = baseline** (0 errors in the file) + ESLint 0 errors (3 pre-existing warnings: `navigation as any` cast + two `||` fallbacks). **On-device smoke PENDING** - Wi-Fi client-isolation blocker; USB needed.

---

## 2026-07-10 (PM) — B-62..B-70 device-audit remediation (calls/notifications/backup)

**Source audit:** `docs/audits/CALL_NOTIFICATION_DEVICE_AUDIT_2026-07-10.md` (Pixel-7a retest of v1.0.104/vc130). All client-side; NO server changes, NO migrations. **Requires APK rebuild** (native Kotlin + manifest + res changed).

- **B-70** — `.CallForegroundService` FGS type now `phoneCall|microphone|camera` (`AndroidManifest.xml` service tag + `MANAGE_OWN_CALLS` uses-permission + `CallForegroundService.kt` type composition). Restores the Telecom while-in-use exemption on background FGS starts (killed-app answer path mic denial).
- **B-62** — `callController.ts`: new `'connecting'` watchdog (20 s, `connectingWatchdogMs` opt for tests) armed on the connecting transition, cleared on exit/end; on fire it re-checks the pc's live `iceConnectionState` (promotes on connected — missed-event/double-mount safety) else `hangup('failed')`. `CallScreen.tsx` autoAccept: accept-failure now retries once after 1.5 s then ends the call (`[WEBRTC] accept-failed` greppable) — no more silent wedge behind "Answering…".
- **B-64** — `callDispatcher.ts`: `endZombieSession()` on `call.missed` + unmatched `call.hangup` hard-ends a live registry session the server declared dead. `FloatingCallOverlay.tsx`: renders for ANY live in-progress call whose CallScreen isn't the focused route (auth/OTP gate case), not just minimized. `CallForegroundService.kt`: notification gains a **Hang up** action → broadcast → `BravoCallForegroundModule` → JS `bravoCallFgHangup` → `endActiveCall` (native also stops the FGS immediately so a dead JS runtime can't strand the notif).
- **B-63** — `BravoBatteryOptimizationModule.kt` + `batteryOptimization.ts`: `canUseFullScreenIntent()` / `openFullScreenIntentSettings()` (Android 14+ FSI deny-by-default). `NotificationReliabilityCard.tsx` now shows an FSI row ("Incoming calls can't ring on your lock screen") with the Settings deep-link.
- **B-67** — `ratchetSnapshotScheduler.ts`: stale_seq adopt-and-retry (server `currentSeq`+1, retry once — mirrors merkleCommit's B-50 fix) + failure now advances `lastCaptureAtMs` so the 5-min debounce holds (kills the 4 s retry hammer). Structural error check (no backupClient import — Jest module-graph constraint).
- **B-66** — `ic_stat_bravo.xml` now the real Bravo winged-shield mark (from `assets/bravo-mark.svg`) instead of the Material placeholder; `@color/notificationAccent` `#5B8DEF` + FCM `default_notification_color` meta-data; `color` passed on message/missed/reply/server-wake notifee paths (`NOTIF_ACCENT`).
- **B-65** — message-preview default flipped **ON** (`backgroundMessageNotifier.ts` `contentPreviewEnabled=true`, pref `bravo:notif-content-preview` reads `!== '0'`; `MessengerSettingsScreen` matches). Killed/warm wakes with an explicit conversationId resolve the conversation (incl. GROUP) display name via `resolveConversationMeta` (`fcmHeadless.ts`, `fcmBootstrap.ts`).
- **B-69** — camera FGS type ratchets UP only (`CallScreen.tsx` upgrade effect: no downgrade on camera-off → no 192→128→192 thrash); `CallForegroundService.kt` `goForeground` walks a fallback ladder (full → -phoneCall → mic-only → typeless) and never `stopSelf()`s on a typed failure.

**Tests:** NEW `callController.connectingWatchdog.test.ts` (5), `callDispatcherZombieEnd.test.ts` (4), +3 stale_seq/debounce specs in `ratchetSnapshotScheduler.test.ts`. Gates: messenger-crypto suite green, tsc ≤ baseline 47, Kotlin compile green. **Device verify pending** (killed-app answer + lock-screen FSI + icon on Pixel 7a/TECNO; capture: `adb logcat -v time ReactNativeJS:V WebRTCModule:V InCallManager:D *:W` + `-b crash,main` for B-68).
**Open (not fixed):** B-68 crash-holding-FGS (needs crash buffer), B-59/60/61 recurrence (unverified, suspect controller-identity race `fcmBootstrap.ts:970-983` — trace follow-up), Telecom `reportIncomingCall` headless path (B-57 long-term).

## 2026-07-11 — B-72/B-73/B-74 rapid-message-burst remediation (messenger client)

**Source:** `sqa.md` 2026-07-11 session (rapid burst Sirajul/Parvez→Ronok + emulator 5556/5558 retest with logcat; relay logs cross-checked on Contabo). All client-side; NO server changes, NO migrations. **Requires APK rebuild** (TS-only).

- **B-72 (nested-txn aggravator)** — `sqlCipherStore.ts` `saveIdentity`: the own-transaction case now queues on `runWithRatchetTxn` (the ONE per-connection txn runner) instead of a raw `BEGIN IMMEDIATE`; inside-chain calls still run the body raw. Kills the field crash `[sqlMessageStore] coalesced flush failed — cannot start a transaction within a transaction` (send-path X3DH `saveIdentity` racing the 50 ms coalesced flush during rapid sends). Residual documented in sqa.md: ambient `isInsideRatchetTxn()` is caller-unaware (wrong-atomicity interleave possible, no crash).
- **B-73** — `ChatScreen.tsx`: composer send now imperatively clears the native field (`inputRef.current?.clear()` + `ref` on the TextInput) alongside `setText('')`; fixes rapid-send digit concatenation (`2→23→234`) and duplicate sends.
- **B-74** — NEW `src/screens/messenger/sendErrorText.ts`: maps session/crypto-internal send errors to a user-facing string and redacts uuid(.deviceId) addresses from pass-through messages; wired into all four `ChatScreen` `setError` sites (send/retry/forward/media+Alert). No more raw `No record for <userId>.1` banners.
- **NOT done (design-blocked):** receiver-side ordering fix for recovered/re-sent messages needs an original-timestamp field inside the sealed payload — sealed-sender payload-shape change = architecture stop condition.

**Tests:** NEW `sendErrorText.test.ts` (5), NEW "B-72" block in `receiveTransaction.test.ts` (2 — strict SQLite-semantics stub, nested BEGIN throws). Gates: messenger-crypto 179/179 suites (1590 tests), tsc 46 ≤ baseline 47. Known pre-existing scheduling flake can fail 1–2 unrelated suites (`incomingRingtone` load) on some full runs — rerun or `npm run flake:crypto`.
**Device verify pending (next APK):** rapid-type `1..0` burst → single-digit bubbles, no dupes, no red banner; established-chat burst → all 10 land on receiver in order (watch `coalesced flush failed` — must be absent).

## 2026-07-11 (PM) — B-75/B-76/B-77 post-pull triage remediation

**Source audit:** `docs/audits/TRIAGE_AUDIT_2026-07-11.md` (founder-reported: backup slow after 3ae4790, Lite finish-mission API error, Mapbox blank/load-failed). Adversarial multi-agent review verified the diff (2 confirmed findings, both B-75, both fixed). Client-side (B-75/B-77 + B-76 client) needs an **APK rebuild**; B-76 server needs a **Contabo auth-service deploy**. NO migrations.

- **B-75 (P0 — the "backup slow" cause) — regression from `3ae4790`.** The B-72 fix routed `saveIdentity` onto the global `txnChain`; reached from a `runOnTxnChain` decrypt-recovery frame it re-queued behind the frame awaiting it → **permanent chain deadlock** → inbound stopped committing, backup mirrored a frozen snapshot (green verify), restore hung. **Fix:** `receiveTransaction.ts` adds `_onChainDepth`/`isOnTxnChain()` + `runRatchetTxnInline(db, work)` (opens a `BEGIN IMMEDIATE`/`COMMIT` WITHOUT chain-appending, safe only while chain-resident). `sqlCipherStore.saveIdentity` dispatches by context: (1) receive-txn → raw; (2) recovery → `runRatchetTxnInline` (own atomic BEGIN); (3) off-chain send → `runWithRatchetTxn`. Race-safe (`_txnOpen` flips synchronously before the BEGIN await). The **adversarial review caught a first-cut regression** where context-2 ran raw autocommit and dropped the P0-S6 `trusted_identities`+`identity_rotations` atomicity — the inline-BEGIN fixes both deadlock and atomicity. `identityBackup.ts:207` raw `BEGIN` left as a documented restore-time follow-up.
- **B-76 (Lite finish-mission API error).** Client: new `src/services/authError.ts isAuthLostError()`; `AssignedMissionDetailScreen.runAction` routes a genuine `token_revoked` (single-device takeover) to a clear "Signed out" alert + idempotent `signOut()` instead of a raw banner. `api.ts missionComplete` timeout 15s→30s (lost-200 guard). Server: `agent.service.settleEscrowOnFinish` now best-effort with a LOUD `log.error` (mission is already COMPLETED before settle — a throw no longer 500s the Finish or silently strands escrow; `EscrowReconciliationService` is read-only so it alerts, not repairs).
- **B-77 (Mapbox blank / load-failed).** New `src/modules/maps/useMapReload.ts` (pure `mapHealthReducer` + hook): no `{type:'ready'}` within 15s → auto-remount once → shared `MapFailedOverlay` (RETRY). Watchdog-driven (not `map.on('error')`) so a post-load tile 404 can't remount a working map. Wired into `VbgKeyPointsMap`, `LiveTrackingScreen`, `AgentLiveTrackerScreen` (derive `webReady` from `map.status`) + `LocationPickerScreen` (own watchdog + `manualRetryMap`, making its Android-unreachable `failed` overlay reachable). `vbgKeyPointsMapHtml.ts` guarded the removed-in-v3 `mapboxgl.supported` check. Token rotation + per-build `EXPO_PUBLIC_MAPBOX_TOKEN` pinning remain open (pre-existing amplifiers).

**Tests:** B-75 4 specs in `receiveTransaction.test.ts` (incl. key-rotation atomicity — both writes in one BEGIN/COMMIT); B-76 +1 server (`agent.mission-finish.spec.ts`) +4 client (`isAuthLostError.test.ts`); B-77 7 `mapHealth.test.ts`. Gates: messenger-crypto 1588 green (1 pre-existing load-order flake suite), auth-service agent+escrow 382 green, booking 139 green, tsc 46 ≤ baseline 47, ESLint clean on changed files.
**Device verify (in progress):** staging release APK (`npm run apk:staging`, Contabo) building + installing to Pixel 6a (`192.168.4.195:39029`, currently vc133). Verify: (B-75) reinstall-peer burst → recovery, then inbound keeps rendering + backup completes fast + restore % advances; (B-77) airplane-mode a map at mount → RETRY/auto-remount recovers instead of eternal blank; (B-76) OTP-login the CPO on a 2nd device then tap Finish → clean "Signed out" → login (not a raw banner). **B-76 server settle fix NOT yet deployed to Contabo.**

### 2026-07-11 (PM) — SHIPPED: B-75..B-79 (+B-78/B-79 on-device follow-ups)

- **Committed:** `2bdda3b` fix(triage) + `5212c19` chore(release) v1.0.108 (versionCode 135), pushed to main.
- **APK:** v1.0.108/vc135 built (release-apk.ps1) + distributed to Firebase App Distribution **qa** group. GOTCHA: set `$env:NODE_ENV='production'` before the script (else gradlew loads .env.local not .env.production and PowerShell wraps the stderr warning as a fatal NativeCommandError); `-SkipPreflight` bypasses the pre-existing `incomingRingtone` messenger-crypto load flake.
- **B-76 server:** deployed to Contabo via **manual overlay** (build `apps/auth-service` locally → `docker cp dist/agents/agent.service.js` into `bravo-staging-auth` → `docker restart`) — verified **healthy**. GOTCHA: the "Deploy to Contabo staging" GitHub Action is **pre-existing broken** (fails at ~3s on every push — repo secrets/runner, not the commit), so CI auto-deploy does NOT ship server changes; overlay manually.
- **B-78/B-79** (new this session, on-device found): B-78 = chat list mis-ordered after restore + empty previews (move-to-front conversationOrder + `last_message` stripped on persist & never rehydrated) → display-sort by real last-message time + `hydrateMessages` seeds `last_message` from SQLCipher. B-79 = direct chats showed `Bravo · <hex>` / bare-id placeholders → `useRegisteredNames` resolves the registered name via `/users/profiles` (precedence custom > saved > registered > placeholder; `isPlaceholderName` matches both `Bravo · <8hex>` and bare `userId.slice(0,8)`/full userId). Both device-verified on Pixel 6a.

### 2026-07-11 (late PM) — B-80 telemetry heartbeat + B-81 backup-restore repair

- **B-80** (committed `52e5dca`): `useLeadTelemetry` gains a 15s `getCurrentPosition` heartbeat alongside the movement watch (shared 5s-throttled `pushSample`) — a stationary lead no longer freezes the ops live map (DB forensics: the only LIVE mission sat at the emulator-default GPS, 10h stale, after ONE fix).
- **B-81**: restore dead-end `root_mismatch` on the owner's own device. PROVEN via a plpgsql replica of the client Merkle tree (`pg_temp.bravo_merkle_root` — PostgREST `to_json` timestamps + newline-stripped base64): 4/6 accounts matched their signed roots; the 2 heavy-test accounts drifted at EQUAL count (re-mirrors re-encrypt rows with fresh AES-GCM IVs; app kill inside the flush→commit debounce window leaves the server ahead of the signed root; the P2-B-1 verifier hard-fails equal-count forever and nothing re-commits). FIX (verifier byte-untouched): `repairBackupCommit(owner)` — precheck local rows (no side effects on refusal) → clear owner dedup → `backupNow` full re-upload of LOCAL truth → `drainMirrorOutbox` → ABORT unless fully drained → sign directly via new `commitMerkleRootNow(owner)`; `BackupRestoreScreen` auto-repairs + retries ONCE on `root_mismatch` (budget spent only on a committed repair; biometric gate still runs; overlay cleared on cancel); boot catch-up sweep now drains + fast-forwards its pending commit (`fireMerkleHookNowIfPending`). **Adversarial review caught the first cut committing via the ambient after-flush hook — which is NEVER installed on the backupBoot RESTORE/RESTORE-RESUME paths — a silent no-op returning false success; anything on the restore path must sign via `commitMerkleRootNow`.** Tests: 6 (`backupRepairCommit.test.ts`); messenger-crypto 182 suites / 1608 green; tsc 46 ≤ 47. The two poisoned accounts (Ranak, Shirajul) self-repair on their owner devices at next restore.

## 2026-07-12 — Lite/Booking design-loop sweep (navy→obsidian sync + a11y/responsive/states)

**Source:** `docs/audits/BOOKING_DESIGN_LOOP_2026-07-12.md`; operating procedure `DESIGN_REVIEW_LOOP.md` (new this session, referenced from `CLAUDE.md`). UI-only, NO server/migrations. **Requires APK rebuild** (RN/TS-only). Orchestrated under ultracode via `Workflow` (fan-out migrate → fan-out audit → fan-out adversarial-verify → fix).

- **Navy→obsidian migration (5 lagging screens):** `AddOnsScreen`, `CreditPaywallScreen`, `BookingConfirmationScreen`, `TripSummaryScreen`, `LocationPickerScreen` moved off legacy `@theme/colors` (`Colors`, `#0A1F3F`/`#1E88FF`) onto the canonical obsidian `@components/ui/tokens` (`UI`, `#07090D`/`#5B8DEF`). grep for the banned navy set + `Colors.` across `src/screens/booking` → **0**. Status colors (green/amber/red/purple), JetBrains-Mono ref codes, dark-on-amber button text deliberately kept.
- **Design-loop audit + fixes (13 already-obsidian screens, 68 findings / 30 major):** family-wide `accessibilityRole`/`accessibilityLabel`/`accessibilityState` on icon-only back/FAB/SOS/stepper/chip/CTA controls; `hitSlop` on every sub-44/48dp target; `numberOfLines`/`ellipsizeMode`/`flexShrink`/`maxWidth` overflow guards for 320dp/fontScale-1.3; `importantForAccessibility="no"` on decorative icons; `accessibilityLiveRegion` on the AgencyAccepted async note. **States:** `BookingHistoryScreen` gained a 3-way `ListEmptyComponent` (loading spinner → error + **Retry** → true empty) closing a G5 false-empty dead-end; `ZoneMapScreen` shows "Checking…" until availability loads.
- **Structural changes (3):** `BookingHistoryScreen` store selectors (`isLoading`/`error`/`clearError`) + retry wiring; `RateAgencyScreen` and `NoDetailScreen` body wrapped in `ScrollView` so content scrolls at fontScale 1.3 instead of clipping behind the pinned footer.
- **Adversarial review caught + fixed 5 regressions the fix/migration agents introduced:** (layout) `RateAgencyScreen` ScrollView missing `style={{flex:1}}` → footer would unpin from bottom; `NoDetailScreen` wrapped `s.center` kept `flex:1` → clamps child to viewport, defeats the scroll it was added for. (contrast) `AddOnsScreen` unchecked checkbox border mapped to `UI.hair` (9%, ~1.25:1 — the only selection affordance nearly vanished) → `rgba(255,255,255,0.22)`; `AddOnsScreen` `addonDesc` on `UI.textMute` (2.9:1, below AA) → `UI.textDim`; `BookingConfirmationScreen` CPO avatar fill on `UI.surface` (2.5%, near-invisible + inverted person/vehicle hierarchy) → `rgba(91,141,239,0.14)`.
- **LESSON (migration rule):** a mechanical `Colors.*`→`UI.*` map is safe for backgrounds/text tiers but NOT for control outlines or depth-hierarchy fills — `UI.hair`/`UI.surface` are the faintest tokens and silently erase affordances a solid navy carried. Re-check contrast per element, not per token.

**Gates:** grep 0 navy; `tsc --noEmit` 46 ≤ baseline 47 (no increase); `eslint src/screens/booking` 0 errors (1 pre-existing `||`→`??` warning untouched). **On-device screenshots pending** — Pixel wireless-ADB endpoint (`192.168.4.195:39029`) dropped mid-session and could not be re-paired; recorded per DESIGN_REVIEW_LOOP §"UI verification" rather than claimed. Scores: UX 96 · A11y 97 · Responsive 96 · Perf 95 · Foldable 92 · Prod-Ready 95.

## 2026-07-16 — B-84 keyboard-covers-input remediation (17 screens, client-only)

**What:** Full-codebase fix for "keyboard hides the focused text box" (founder repro: backup
password). Root cause: edge-to-edge (RN 0.81 / target SDK 36) nulls `adjustResize`, the
`behavior={ios ? 'padding' : undefined}` KAV idiom is inert on Android, and Android `Modal`
windows never resize for the IME. Register: `docs/audits/KEYBOARD_FOCUS_AUDIT_2026-07-16.md`.

**New shared hooks:** `src/hooks/useKeyboardHeight.ts` — `useKeyboardHeight()` (manual IME
height tracking, ChatScreen noise-floor) + `useRevealOnKeyboard(scrollRef)` (event-driven
scroll-into-view onFocus; replaces fixed-timer reveal hacks). Tests:
`src/hooks/__tests__/useKeyboardHeight.test.tsx` (6).

**Screens patched (Android kb padding via the hook; iOS keeps KAV 'padding'):**
BackupRestore + BackupSetup (KB-01/02, also removed `behavior='height'` + 120 ms timer),
DepartmentChat + AgentLiveTracker composers (KB-03/04), GroupCall in-call chat sheet (KB-05),
JobDetail pledge sheet (KB-06), Profile name modal + Credits promo modal (KB-07/08 — had zero
handling, cross-platform pad), CpoActivation (KB-09, root pad + reveal), ChatInfo rename,
NewChat ×2, IndividualProfile, AdminAttendance, MyAttendance modals (KB-10..14), DayStatus +
OrgCompliance scroll forms (KB-15/16), Login (KB-17, + new ScrollView wrapper,
`body` flex:1→flexGrow:1).

**Build impact:** none native — pure TS/JS change, OTA-compatible, no new deps, no config
change. Gates: tsc 46 ≤ 47 baseline, eslint 0 errors on changed files, targeted jest green.
**Device verify pending** (keyboard behavior needs a physical device — Pixel 7a + Gboard).

## 2026-07-16 — B-85/B-86/B-87 + MX-05..13 messenger UX remediation (client-only)

**What shipped (same-day fix of `docs/audits/MESSENGER_UX_AUDIT_2026-07-16.md`, see §7):**

- **B-85 back-nav (two-part):** `MessengerNavigator` declares `initialRouteName="MessengerHome"`
  AND every Chat deep-link passes `initial: false` (`fcmBootstrap.ts` message/missed-call taps,
  `OpsMissionDetailScreen.tsx` hop) — the nested `screen` param otherwise OVERRIDES
  initialRouteName on first mount (adversarial review caught the prop-only version as a no-op).
  Back from a notification-opened chat now lands on the chat list, not the Dashboard. Locked by
  `src/navigation/__tests__/navigatorConfig.test.ts`. MX-13: AgentNavigator Chat route mirrors
  the chat polish options.
- **MX-05 inverted chat list:** ChatScreen FlatList is `inverted` — opens ON the newest message
  (the 4-shot `scrollToEnd` timer hack is deleted), older-history paging via `onEndReached`,
  incoming-message follow via `maintainVisibleContentPosition.autoscrollToTopThreshold`.
  New pure module `src/modules/messenger/ui/chatListItems.ts` (+8 tests) builds the
  day-separator/unread-divider stream and reverses it; rows are identity-stable (MX-07).
  **Watch on device:** `removeClippedSubviews` stays ON (Android) with inverted — if blank
  cells appear on Fabric, flipping that one prop is the revert.
- **MX-06:** swipe-to-reply on the UI thread (RNGH `PanGestureHandler` + native
  `Animated.event`); vertical scroll wins via `failOffsetY`, right-drag activates at 16 dp.
- **B-87 media:** multi-photo select (`MAX_PICKED_ASSETS = 10`) + new `MediaPreviewTray`
  (review, per-item remove, "Send N"); pinch-zoom/double-tap/pan `ZoomableImage` in the
  FileViewer (classic RNGH + core Animated native driver — **no reanimated**; the worklets babel
  plugin is deliberately absent). `zoomMath.ts` + `pickedAssets.ts` are pure + unit-tested.
- **MX-09 non-blocking sends:** all media sends run a SERIAL queue (composer stays live,
  "k of n" chip); determinate upload ring on sending bubbles via
  `MediaClient.uploadEncrypted(onProgress?)` — XHR upload path ONLY when the callback is
  passed; the fetch path (and its unit tests) are untouched. Transient progress registry:
  `src/modules/messenger/media/uploadProgress.ts`.
- **MX-08 haptics seam:** `src/utils/haptics.ts` (tap/select/impact/heavy) replaces raw
  `Vibration.vibrate(ms)` in ChatScreen + FileViewer; swap in a real haptics engine here later.
- **B-86 vault:** Move-to-Vault is REAL end-to-end — `vault/vaultOps.ts`: biometric ceremony →
  `mintActionToken('vault-access')` (`POST /auth/biometric/assert`) → `VaultClient` encrypt +
  upload with single-use `X-Mfa-Proof` → real key material indexed (`VaultFile.sourceKey` added
  for dedup). Fail-closed preserved: no proof ⇒ honest alert + zero writes; `vaultStore.addFile`
  refuses key-less rows (M-02). Wired in FileViewer, FilesScreen, VaultScreen (incl. real
  open-with-decrypt + direct uploads). **Env note:** works on staging
  (`BIOMETRIC_DEV_BYPASS=true` on auth-service); production vault moves stay server-gated until
  a real Play Integrity attestation ships — expected posture, not a regression.

**Build impact:** none native — pure TS/JS, no new deps (gesture-handler + svg already shipped
in the APK), no config/manifest change; next APK picks everything up. Gates: tsc error
signatures identical to main (46), eslint 0 errors, 149 suites/1274 tests green (+38 new),
only the two known pre-existing failures elsewhere (`authStore.recheckMembership`,
`uploadAvatar`). **Device verify pending:** inverted-list feel, gesture arbitration,
multi-pick tray, vault MFA round-trip on staging.

## 2026-07-16 — B-88 branded Alert dialog replaces the native AlertDialog (client-only)

All 252 `Alert.alert` call sites (71 files) now render an obsidian/cobalt dialog instead of
the white system AlertDialog. Drop-in: `src/utils/alert.ts` keeps the exact RN signature —
call sites unchanged, only import lines swapped (`from 'react-native'` → `from '@utils/alert'`,
plus 4 lazy requires in launchCall/NewChat). Host: `src/components/BravoAlertHost.tsx`
mounted once in `App.tsx` (transparent Modal → stacks above other Modals on Android).
Semantics mirror RN Android (default OK, cancelable back/backdrop → onDismiss only, FIFO
queue). A static sweep test fails the build if anyone imports Alert from react-native again.
**Rule for new code:** `import {Alert} from '@utils/alert';` — never from react-native.
Build impact: none native — pure TS/JS, no new deps. Gates: tsc 46 = HEAD, eslint 0 errors,
230 suites / 2018 tests (only known pre-existing failures). Device pass pending
(alert-over-modal stacking, fontScale 1.3, 320dp).

## 2026-07-16 — B-89 map/GPS/route remediation (client + auth-service + ops-console + MANIFEST)

- **Server (auto-deploys on push):** CPO telemetry now mirrors to the client stores + emits
  `mission.telemetry` (client live map shows the REAL vehicle — MG-01); heading selected +
  server-side bearing derivation (MG-02); clientPing coord validation.
- **Client:** simulated live dot DELETED (honest "Awaiting live GPS" pre-first-fix); GPS
  plausibility gate + accuracy circle; GPS-off prompts; FINE+COARSE w/ approximate detection;
  LIVE-mission GPS access RE-ASK flow; iOS whenInUse; map fast-fail + loading overlays +
  coord guards on all GL surfaces; IntelFeed recovery; Mapbox token via `mapToken.ts` with a
  misconfigured-build overlay.
- **⚠ NATIVE/MANIFEST CHANGE (next APK required):** `AndroidManifest.xml` merges
  `foregroundServiceType="location"` onto notifee's ForegroundService, and the new mission
  FGS (`missionForegroundService.ts`, registered in `index.js`) keeps CPO GPS alive with the
  screen off. The manifest lives in the force-added `android/` tree — nothing else to do,
  but this change does NOT ride OTA; it needs the next `apk:staging` build.
- **Build config:** `EXPO_PUBLIC_MAPBOX_TOKEN` pinned in eas `production` +
  `preview-staging-device` env blocks and both `apk:*` scripts — production builds can no
  longer bake an empty token.
- **Deferred:** Mapbox token ROTATION (dashboard action — rotate, then update `.env.production`,
  `eas.json`, `package.json` apk scripts, ops-console + auth-service envs); `is_mocked` on
  `mission_telemetry` (migration).

## 2026-07-17 — B-94 backup root_mismatch recurrence killed at the source (client-only, schema v14)

The recurring restore dead-end ("Backup integrity check failed (root_mismatch)") was being
manufactured by the WRITE side: the mirror dedup was in-memory only, so every boot's catch-up
sweep re-encrypted (fresh AES-GCM IV) + re-uploaded the ENTIRE history, re-opening the B-81
"rows uploaded, signed commit pending" kill-window on every launch. Fix:

- **New SQLCipher table `mirror_flushed`** (schema v13→**v14** in `crypto/db.ts`) + new
  `src/modules/messenger/backup/mirrorLedger.ts` — persists which row versions reached the
  server; the boot sweep hydrates its dedup from it, so **idle boots upload nothing**.
- **Pending-commit flag** (`bravo:backup:merkle-pending:<owner>`, flush-epoch-guarded) — a
  session killed between flush and commit is healed by the next boot's sweep (one commit,
  zero uploads).
- **Restore seeds the ledger** post-Merkle-verify; **wipe/forget/fresh-setup/repair purge it**.
- Verifier + B-81 repair posture untouched (CLAUDE.md stop-conditions).

Build impact: none native — pure TS/JS (schema bump runs via the idempotent DDL block on
first open). Gates: new `mirrorLedgerBootSweep.test.ts` 8/8, crypto 1638 tests green, tsc
46 ≤ 47, eslint 0 on touched files. **Process:** new `docs/runbooks/BACKUP_LOOP.md`
(invariants I1–I9 + idle-boot/kill-window/restore device probes) is now routed from
CLAUDE.md for ANY backup-module work — run it before and after touching the trigger files.

## 2026-07-17 — M1A tier system: Lite / Bravo Pro / Enterprise (full-stack, B-97)

The founder-approved tier matrix is now implemented end-to-end (spec + status:
`docs/handoffs/UI_SPEC_V2_M1A_TIER_MATRIX.md` §8). What ships where:

- **Server (auth-service):** `subscription_tier` accepts `enterprise` (constraint
  migration APPLIED to live Supabase); `POST /subscription/enterprise`; charge-time
  prices from the new ops-editable `subscription_prices` table (pro=2000 seeded,
  **enterprise=5000 PLACEHOLDER — founder must set the real price in ops Settings**);
  BC auto-renew sweep (`users.bc_auto_renew`, runs before the lapse sweep; never
  alongside a live Stripe sub); tier-switch cancels the old Stripe sub; vault
  action-token issuance now tier-gated (Pro+/org — MFA untouched); enterprise tier
  admitted by DeptChatAccessGuard/OrgManagerGuard as own single-tenant org.
  New env (optional): `STRIPE_ENTERPRISE_PRICE_ID` — unset ⇒ BC-only auto-renew.
- **Mobile:** 4-card tier screen (full matrix columns + Operator Partner card as-is);
  post-auth paywall for a pending paid tier with "Start as Lite today" decline;
  Settings → Pricing (matrix + up/downgrade); vault + dept-card entry points gated
  with branded upgrade asks; dept screens say "Employee" for enterprise individuals
  ("CPO" kept for provider orgs). Pure TS/JS — **no native change, rides any JS
  build; no APK/manifest impact.**
- **Ops console:** Settings → "Subscription pricing" editor (price change applies
  from every NEXT charge/renewal); users/[id] inline tier editor (comp grants,
  permanent RS-17 grants, lite-downgrade also cancels renewals).

Gates: auth tsc 0 + suite 102/103 (pre-existing vbg fail), mobile tsc 46 ≤ 47,
app+booking 419 green, crypto 186/186 (1646), ops tsc 0, eslint 0 new. Deploy:
auth-service overlay + ops-console rebuild on Contabo (Actions still dead — billing).

## 2026-07-29 — News feed live + VBG/Intel maps (aa9a290, c1619b0, 6178895)

- **auth-service:** new `GET /news/feed?countries=&categories=` (NewsController in
  the VBG module) — Google News RSS blend per country×category pair, 15-min TTL
  cache, JWT + per-user throttle. NewsData/GDELT untouched (threat-blend budget).
  DEPLOYED to Contabo manually (Actions billing-dead): tar-overlay of
  `apps/auth-service/src/vbg` over SSH + `docker compose build/up auth-service`
  (no rsync on the Windows box — deploy-staging.sh needs it; tar-pipe is the
  fallback). Verified: route mapped, 401 unauth, container healthy.
- **Mobile (pure TS/JS — rides any JS build, no APK/manifest impact):**
  news prefs v2 (`@modules/news/newsPrefs`, migrates v1), NewsPreferences =
  countries+categories, NewsFeedScreen live fetch + prefs chips + pull-refresh,
  NewsHub live previews; VBG maps get corner-expand → fullscreen `VBGMap`
  (optional route context) + heatmap first-push race fix; Intel Bravo Map
  rebuilt on Mapbox GL (globe) — `BRAVO_MAP_HTML` const → `buildBravoMapHtml(token)`.

Gates: auth vbg suites 10/10 new-file green (3 pre-existing vbg.service fails on
clean main), mobile tsc 45 ≤ 47, news+navigatorConfig+mapbox app suites green,
eslint 0 new. Release APK: `cd android; gradlew assembleRelease --max-workers=3`
with staging EXPO*PUBLIC*\* env exported (apk:staging needs a connected device).

## 2026-08-03 — Bravo Secure Pro applications (request-and-approval custom plans)

- **DB (applied to live Supabase via psql-in-pg-container over SSH):**
  `20260803150000_pro_applications.sql` — `pro_applications` (one OPEN app per
  user via partial unique index; status CHECK mirrors the FSM), versioned
  `pro_proposals`, append-only `pro_application_events` (client timeline + ops
  audit), `pro_application_messages` (client↔BCS thread). RLS on, no anon policies.
- **auth-service:** new `pro-applications/` module — client `/pro-applications`
  (create / me / accept / request-changes / activate / messages) + ops
  `/ops/pro-applications` (list / detail / proposal / reject / internal-notes /
  messages; decisions SUPERVISOR/ADMIN). FSM `ProApplicationStateMachine`
  (PENDING_PROPOSAL → PROPOSAL_CREATED ⇄ REVISION_REQUESTED → ACCEPTED → ACTIVE,
  REJECTED terminal; spec-covered). Activation debits `wallet.debitForFeature`
  IN the same txn as the ACTIVE flip. **Never writes users.subscription_tier**
  (M1A untouched). Realtime rides the existing lanes: `MissionEventsService`
  publishes `proapp.status`/`proapp.message` with the APPLICATION id as the
  room key (zero messenger-service changes — the gateway re-emits any event to
  `mission:<id>`); push via `BookingPushBridge` kinds `pro-*` (opaque eventId
  posture unchanged). Deployed to Contabo (tar-overlay), healthy, routes 401-live.
- **Mobile (pure TS/JS — rides any JS build, no APK/manifest impact):** new
  `src/screens/securepro/` — SecureServices (Lite/Pro/Executive-coming-soon
  chooser), SecureProIntro (no pricing), SecureProApply (single requirements
  form → POST), SecureProStatus ("My Pro Application" — 5s poll + WS push via
  `useProAppRealtime`), SecureProProposal (accept / request-changes sheet),
  SecureProPayment (shortfall → CreditPaywall; Pay & Activate; in-place
  "Activated" state). BookingHome gets a PLANS & SERVICES card + live
  "My Pro Application" row. `secureProStore` (zustand) + `secureProApi`.
  Push kinds mapped in serverWakeNotifications + fcmBootstrap tap-routing
  (statically enumerated for serverWakeTapRouting parity). Screens registered
  in lockedTerminology CLIENT_FACING.
- **Ops console:** new `/pro-applications` section (Operations nav group) —
  status-tab card feed @ 2s poll, detail page with requirements, timeline,
  client thread, internal notes, proposal builder modal (monthly BC, validity,
  coverage, services, team rows, terms) + reject modal; RBAC
  `canDecideProApplication` (SUPERVISOR+). Deployed to Contabo, healthy.

Gates: auth `nest build` clean + FSM spec 6/6; mobile tsc 46 ≤ 47; messenger
crypto suite full-green ×2 (serverWakeTapRouting caught the unrouted pro-\*
kinds — fixed by enumerating branches); booking lockedTerminology 59/59;
ops tsc 0 + eslint 0. Deploys manual tar-overlay (Actions billing-dead).

## 2026-08-03 (later) — Pro phase 2+3: family/members, full-period pricing, missions+calendar, expiry/renewal, ops Pro Management

- **DB (all applied live):** `20260803190000` pro_proposals.monthly_credits→**total_credits**
  (proposal = ONE total for the whole coverage period; activation debits it once;
  current_period_end = coverage_end; no monthly renewal). `20260803200000` family_members
  - relationship/held_until. `20260803210000` pro_plan_missions (multi-date in-plan
    requests). `20260803220000` pro_applications +'EXPIRED'. `20260803230000`
    **btree_gist** + agents.created_by_ops + `pro_cpo_assignments` with a gist EXCLUDE
    (cpo_user_id =, daterange &&) WHERE status='ASSIGNED' — overlapping/duplicate CPO
    assignments are impossible at the DB level; COMPLETED/CANCELLED free the officer.
- **auth-service:** family invite requires a registered individual (resolveAccountKind),
  relationship + windowed hold (held member pays self + loses shared plan);
  auto-dispatch escrow now bumps family spent_credits; payWithCredits stamps
  payer_user_id; ops bookings expose payer_name/payer ("UNDER <owner>").
  /pro-applications/me → owner-plan fallback w/ via_owner + history + lazy EXPIRED
  sweep + POST :id/renew. pro_plan_missions client+ops endpoints. NEW
  `pro-management/` module: /ops/pro-management (orgs list/create-internal/detail,
  cpos create via OrgCpoService + windowed suspension, availability pool,
  assignments CRUD w/ 409 conflict listing, schedule-cpos for client requests) +
  /agents/me/pro-mission-code (CpoSessionGuard; PMC-XXXXXX codes, foreign codes
  indistinguishable from unknown). NO payout on pro mission completion.
- **Mobile:** SecureProMembers (messenger-style contact picker, relationship chips,
  limits, hold 7/14/30), SecureProCalendar (month grid across coverage months,
  multi-date select requests), SecureProMissions, EXPIRED renew/customize +
  PREVIOUS PLANS, custom top-up tile on CreditPaywall, ProDashboard tile rewires +
  via_owner pill; CPO shell gains CpoProMission (code gate + mission view; entry on
  the no-active-mission empty state; code persisted + revalidated).
- **Ops console:** /pro-management page (ASSIGNMENTS / CPO POOL / ORGANIZATIONS, create
  org+CPO with system-generated creds shown once, suspend/reinstate, assign w/ conflict
  messages, finish/cancel); pro-applications detail: request SCHEDULE → **ASSIGN CPOS**
  (availability-checked picker; creates assignments + flips request), CLIENT HISTORY,
  EXPIRED tab, filter chips fixed to a row.

Gates: auth nest build clean + specs (FSM 6/6, mission-code 2/2); mobile tsc 46 ≤ 47 +
eslint 0 err; ops tsc 0 + lint 0 err. Deploys: tar-overlay ×5 total this day, all
healthy. STILL UNCOMMITTED at time of writing — commit before any deploy from another
tree.

## 2026-08-03 (later) — tier-family separation + v1.0.219 (vc250) to Firebase qa

Commits `a2c25c9` (separation) + `c5450d0` (version bump), both pushed.

- **Naming contract:** `TIER_LABELS` (the MESSENGER subscription ladder,
  `users.subscription_tier`) now reads **Bravo Messenger Lite / Bravo Messenger
  Pro / Enterprise**; "Bravo Secure Pro" is reserved for the request-and-approval
  plan and may only appear in `PRODUCT_PLANS.secure`. Pinned by
  `lockedTerminology.test.ts` ("keeps the two product families apart").
- **Chips:** Messenger home header wears LITE / PRO / ENTERPRISE (lapse-aware via
  `deriveEntitlements`; org accounts read ENTERPRISE). Secure home keeps its
  LITE ↔ PRO / PRO·FAMILY chip. One family per dashboard, never mixed.
- **Profile:** "Secure Plans · PRO" row → SecureServices chooser (replaces the old
  "Bravo Secure Pro · UPGRADE" → ProRetainers funnel row); "Pricing" row renamed
  **Messenger Plans** (org-hide filter keyed on route, not label).
- **Signup:** only a MESSENGER-path paid pick sets pendingTier (post-auth paywall);
  a Secure-path Pro pick starts Lite — Secure Pro is not buyable.
- **Deleted** the orphaned old-Pro mock suite (ProRetainers, ProClientProfile,
  ProTeamConfig, ProAIScheduling, ProRiskReview, ItineraryUpload) + routes/types +
  dead ProStackParamList + scan-list entries. CorporateProfile static BRAVO PRO
  badge removed.
- **Ops console:** settings card "Messenger subscription pricing" (Messenger Pro),
  users detail row "Messenger tier", departments empty-state says Enterprise.
  Tar-overlay deployed to Contabo, healthy. **No DB migration needed.**
- **Release:** `scripts/release-apk.ps1` → v1.0.219 / versionCode 250,
  gradle 15m25s, 490 MB APK, distributed to Firebase App Distribution `qa` group.
  Preflight green (crypto suite, tsc 46 ≤ baseline, callkeep patch fingerprint).

---

## 2026-08-04 — Bravo Lux (executive protection, fixed 3–24 h blocks) — FULL PRODUCT

**What it is:** the "Secure Executive" plan, renamed **Bravo Lux** and shipped as a
complete product: 7-step client wizard → same auto-dispatch/escrow/mission pipeline
as Lite (`service = 'lux'` on `lite_bookings`) → missions with **NO waypoints** —
the lead CPO instead confirms each **elapsed hour** ("all smooth" + optional
comment, `mission_hourly_checkins`), visible to client, agency, and ops.

- **Wizard** (`src/screens/lux/`): LuxDuration (3/6/…/24 h blocks) → LuxSchedule
  (Book Now = immediate, lead-time-exempt on BOTH paths; Book Later = real 3 h
  floor, reject+auto-correct) → inherited LocationPicker (new `onPickRouteKey`
  honored; LuxTask sits under the modal so confirm POPS back, Lite-style) →
  LuxTask (task type + 0/500 brief) → LuxTransport (optional secure-transfer leg:
  one-way/return/both-ways, own pickup/dropoff, pickup time defaults to start,
  pax → vehicle floor) → LuxTeam (per-unit rate card + debounced server estimate)
  → LuxReview (line-item calculation + consent → confirmBooking; routes exactly
  like Lite: FindingDetail/NoDetail/OpsRoomReview/CreditPaywall).
- **Entry points:** SecureServices "executive" card unlocked → Bravo Lux;
  ServiceType executive card routes to the wizard (dirty-draft guard B-91);
  shared draft in bookingStore (`startLuxDraft` seeds; Lite re-selection restores
  duration 4 h/vehicle 1 and clears lux residuals — pinned in
  `hourlyExecutiveProtection.test.ts` + `luxDraftSeed.test.ts`).
- **Pricing (flat, no peak):** rate/hr = CPO×86 + vehicle&driver×30 (+20
  driver-only, client vehicle) + add-ons (female_cpo 120 / recon 100 / medical 90
  / comms 75 — display == charge). Server `calculateLux` + fixed lux catalogue;
  client mirror `src/screens/lux/luxPricing.ts`; lockstep pinned by
  `pricing.lux.spec.ts` (server) + `luxPricing.test.ts` (client). Estimate
  endpoint takes `service`+`passengers` and mirrors create()'s clamps; create()
  400s (`lux_cpo_seat_cap`) instead of silently repricing.
- **Validation:** duration multiple-of-3 in 3..24; vehicles/driver-only require a
  transfer leg (`lux_transport_required`) and a leg requires something to drive it
  (`lux_vehicle_required`); transfer time must fall in [start−2 h, start+block];
  unknown lux add-on → 400 (never a silent underprice).
- **Mission side:** waypoint seeding skipped at ALL THREE dispatch paths
  (org assignCrew, ops dispatch, job-feed); deploy checks kept. New
  `POST /agents/me/missions/:id/hourly-checkin` (lead-only, lux-only, LIVE/SOS,
  hour ≤ block, elapsed-gated with 2-min grace, idempotent per (mission, hour)) —
  spec `agent.hourly-checkin.spec.ts` (11 tests). Ops vehicle gate now keyed on
  `vehicle_count > 0`, so protection-only lux dispatches without locking a pool
  vehicle.
- **Distribution (all four actors):** CPO AssignedMissionDetail = lux brief card
  - transfer + hourly timeline + confirm; agency IncomingOffer shows task +
    transfer-included (CoarseOffer additions), OrgMissions/OrgMissionDetail show
    Bravo Lux label + LUX DETAIL + live hourly list; client LiveTracking shows the
    hour-by-hour card (GET /bookings/:id carries `hourly_checkins`, scoped to the
    live mission on re-crew); ops console booking detail gets Task + Lux Transfer
    rows and the live page swaps the waypoint card for the hourly timeline. Pushes:
    `detail-hour-checkin` (client) + `mission-hour-checkin` (agency), wired into
    wake meta + bell backfill. Legacy waypoint lead-console hidden on lux missions.
- **Migration:** `supabase/migrations/20260804150000_bravo_lux.sql` —
  `lite_bookings.task_type/lux_transport`, regularizes the out-of-band
  `conversation_id` (+ partial index), `mission_hourly_checkins` (RLS on).
  **APPLY BEFORE deploying auth-service** — the booking INSERT names the new
  columns, so an un-migrated DB breaks ALL booking creates.
- **Release:** `scripts/release-apk.ps1` → v1.0.220 / versionCode 252, gradle
  4m18s (incremental), 490.2 MB APK, distributed to Firebase App Distribution
  `qa` group. Baked URLs verified in-bundle (auth/relay sslip.io — not dev).
  Server: migration + auth-service + ops-console live on Contabo since bb70afb.
  GOTCHA repeated: run the script with `NODE_ENV=production` set and NO
  stderr redirect wrapper — PS 5.1 + `$ErrorActionPreference='Stop'` turns
  expo's NODE_ENV warning into a fatal NativeCommandError at the gradlew call.

### 2026-08-04 correction — renamed: "Bravo Lux" → **Executive Protection (under Lite)**

The product described in the section above shipped briefly as "Bravo Lux";
same session it was renamed to its real identity: **Executive Protection**,
the second service under **Bravo Secure Lite** (next to Secure Transfer).
Wire value reverted to the pre-existing `service='executive_protection'`
(the `'lux'` value is gone from the DTOs; migration
`20260804233000_exec_protection_rename.sql` renames `lite_bookings.
lux_transport → exec_transport` and heals the one test row). Screens/routes:
`src/screens/executive/Exec*` / `ExecDuration…ExecReview`. The Secure Plans
third card is now **Bravo Secure Lux — COMING SOON, locked** (premium
white-glove tier: private aircraft, armored fleet, elite logistics) — the
only place "Lux" appears in the product. v1.0.220 (which sent 'lux') breaks
against the renamed server; v1.0.221 is the fixed build.

---

## 2026-08-05 — Production sync audit (B-377…B-386) + remediation

**Trigger:** founder goal — "audit with critic (3 agent): all functions perfectly
synced with all endpoints, and will production go smooth". Audit report:
`docs/audits/PRODUCTION_SYNC_AUDIT_2026-08-05.md`; bug log: `sqa.md` B-377…B-386.

### Audit result

- **Endpoint sync: PASS.** ~200 mobile calls + ~80 ops-console paths all map to
  live routes; zero verb/path mismatches; zero DTO body drift. Verified idempotency
  keys, exec pricing lockstep, hourly ±120 s boundary, escrow exactly-once, refund
  conservation, the three waypoint-seeding guards.
- **Ten bugs found** (5×P1, 5×P2) + a P2/P3 tail — all fixed the same session.

### Remediation shipped

Server: officer accept/decline seam completed (B-377); crewed-cancel now wakes CPO +
agency (B-378, new `mission-cancelled` kind); Pro activation re-checks proposal expiry
and coverage before debiting (B-381); Pro period end is exclusive end-of-final-day
(B-383); family cap/hold/revoke re-checked at CHARGE time (B-384); unresolved Lite
add-ons rejected + resolved ids persisted (B-385); legacy cancel window anchored to
`confirmed_at` (B-386); estimate mirrors create's reject rules + capacity floor
(E-9/E-14); optional idempotency on subscribe (E-10, wire-safe for old builds);
Gulf-day date checks (E-11); DTO length caps (E-12); family invite/accept pushes (R-3);
exec brief on the legacy job-feed lane (R-6); C-5…C-8 response/read fixes.

Client: accept/decline card (AssignedMissionDetail), escrow release/dispute card
(TripSummary, B-379), humanized family-cap error (B-380), transfer day-resolution +
inline window gate (B-382), live add-on catalogue prices, KIND_META +14 kinds (R-4),
JobDetail exec cells, dead API functions deleted (C-4), one `MIN_LEAD_HOURS` (E-13).

**Migration `20260805013000_audit-fixes-b377-b386.sql`** — `lite_bookings.confirmed_at`
(nullable; old rows fall back to `created_at`) + a **marker-guarded** one-time
`current_period_end + 1 day` bump for live ACTIVE Pro plans. Idempotent; safe to
re-run. Apply BEFORE deploying auth-service (payWithCredits writes `confirmed_at`).

### New permanent regression pins (bug-regression contract)

| Suite                                  | Pins                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `booking.executive-validation.spec.ts` | all 8 `exec_*` reject codes + `unknown_add_on` + `vehicle_capacity_insufficient` + estimate/create parity (closes the E-7 gap)    |
| `serverWakeKindParity.test.ts`         | every server-emitted push kind ⊆ client wake-meta + bell backfill + tap router — the exact escape hatch B-377/R-1 slipped through |
| `transferTime.test.ts`                 | B-382 day-resolution + window boundaries                                                                                          |
| `auditFixPins.test.ts`                 | source pins for the RN-screen / transaction paths no node test can execute                                                        |

### B-376 recurrence #2 (same night) + containment

The stale machine (ED25519 `SHA256:LmTaeKZnQf2y…` from `82.38.84.176`) redeployed
July code at 00:14 IST — **its build succeeded this time, so the stale image actually
served**. Restored from main; poisoned trees quarantined (`/home/admin/quarantine-*`).
Containment added:

- `deploy-staging.sh` now runs **feature-route probes** after health (auth-service
  `/pro-applications/me` must be 401, not 404) and refreshes a box-side pristine
  snapshot after every green deploy.
- **Self-heal watchdog** on the box: `/home/admin/bravo-watchdog/watchdog.sh` via cron
  every 5 min. Fires only on the stale signature (`/ready` 200 **and**
  `/pro-applications/me` 404, or the `pro-applications` source dir missing), then
  quarantines, restores the snapshot, rebuilds. Verified: silent no-op on a healthy
  box; `WATCHDOG_FORCE=1` heal run restored to `ready=200 feat=401`.
- Tripwire note at `/home/admin/bravo/STOP--STALE-DEPLOY--READ-ME.md` (box-root files
  survive the per-service rsyncs).

**Still founder-only:** rotate that ED25519 key out of the box's `authorized_keys`, or
get that machine to `git pull`. The repo-side guard cannot stop a pre-guard copy of the
script; the watchdog only limits the damage window to ≤5 min.

### 2026-08-05 addendum — the fix diff got its own trio, and it mattered

A second 3-agent review ran over the REMEDIATION diff (not just the audit) and
found **six regressions inside the fixes**. All corrected pre-commit:

| Regression                                                                                         | Why it mattered                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-383 changed `current_period_end` to an EXCLUSIVE end, but three UIs render it as "COVERED UNTIL" | every Pro holder would be told they're covered through a day the app refuses to serve. Fixed with a derived `covered_until` column (server) consumed by both mobile screens + the ops console.          |
| B-385's server reject + a client that only re-priced                                               | an ops catalogue edit turned Lite booking into an unrecoverable dead end (row still selectable, submit 400s). Client now FILTERS de-listed rows and clears stale toggles.                               |
| E-10's day-bucketed idempotency key                                                                | a deliberate same-day re-subscribe replayed the first response — paid extension silently lost. Now a per-attempt nonce.                                                                                 |
| B-377 decline was irreversible                                                                     | `mission_crew` is PK'd on (mission, agent) and re-crew is ON CONFLICT DO NOTHING, so nothing ever cleared `declined_at`. Added an "ACCEPT AFTER ALL" affordance + a server-side DISPATCHED-only window. |
| B-378 gated the agency wake on crew existing                                                       | an agency that accepted but hadn't crewed yet — inside its crew-assign SLA — still learned nothing. Now gated on the provider alone (nullable missionId).                                               |
| `dispute-opened` routed to `SecureTab/TripSummary`                                                 | that route doesn't exist in the agency shell, so the banner drew and the tap died. B-379 made it reachable for the first time. Now agency-first.                                                        |

Also from that review: Lite offline add-on prices were the EXECUTIVE table (4× the
real charge), the Lite estimate never sent `passengers` (so the new capacity mirror
could never fire), the job-feed CONFIRMED flip didn't stamp `confirmed_at`, the
`family-charge-blocked` path now tells the member AND the holder something true
instead of "top up and try again", and the deploy probes were widened (two auth
routes, a real ops-console App-Router page, messenger on :3100/healthz — every URL
validated against the live box before shipping).

**B-387** (see `sqa.md`): the founder's own 3-month Pro plan was dated to expire in
one. The migration now derives each ACTIVE plan's period from the proposal it was
paid for, repairing B-383 + B-387 in one value-idempotent statement (re-runnable,
no marker table).

### 2026-08-05 — ship record (audit remediation)

| Step      | Result                                                                                                                                                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit    | `a56739e0` — B-377..B-387 + fix-diff trio findings, pushed to main                                                                                                                                                                                                                                            |
| Migration | `20260805013000` applied to Supabase staging: `ALTER TABLE` (confirmed_at) + `UPDATE 3` (every ACTIVE Pro plan reconciled to its paid proposal). Verified: all three plans' `covered_until` == proposal `coverage_end`; the founder's own plan recovered from 2026-09-02 → **2026-11-03** (B-387).            |
| Deploy    | auth-service + ops-console rebuilt from `a56739e0` and restarted. Feature probes: `/pro-applications/me` 401 · `hourly-checkin` 401 · ops `/pro-applications` 307 · messenger `/healthz` 200 · `/ready` 200. Running image confirmed to contain `covered_until`, `charge_failed_family`, `mission-cancelled`. |
| Watchdog  | pristine snapshot refreshed to the DEPLOYED build (a stale snapshot would otherwise heal backwards); no-op verified on the healthy box.                                                                                                                                                                       |
| APK       | v1.0.222 (versionCode 256) → Firebase App Distribution, `qa` group.                                                                                                                                                                                                                                           |

**Deploy ORDER matters and is now written down:** migration first, service second.
`payWithCredits` and `cancel()` both reference `lite_bookings.confirmed_at`, so
shipping the image against an un-migrated DB 500s every legacy payment and every
cancel. The migration is additive + value-idempotent, so applying it early is
always safe.

**B-376 recurrence #3 (11:31 IST) was found by this deploy**, not by monitoring:
the rogue machine had re-seeded its feature-branch files, the box stayed healthy
(their checkout now contains main), and the contamination only surfaced when
`nest build` hit `activeEnterpriseSql`. Quarantined to
`/home/admin/quarantine-stale-20260805-1240/`, re-extracted, rebuilt. See `sqa.md`.

### 2026-08-07 — ops-console audit remediation, batch 1 of 3 (F1–F17)

Three-agent audit (skeptic / code / industry-standard) over the whole ops console →
`docs/audits/OPS_CONSOLE_AUDIT_2026-08-07.md` (68/100 pre-remediation scorecard, full
findings table with per-batch status). Batch 1 landed all seven P1s + ten P2s:

| Area            | What shipped                                                                                                                                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pro visibility  | `covered_until` (derived, never the exclusive period end) on both ops projections + list cards; LINKED MEMBERS card on Pro detail w/ hold state; `GET /ops/users/:id/family` + both-directions family card on the user page; decider identity (name/email) on decisions      |
| Pro attribution | `OpsAuditService.recordAdmin` wired into ALL 12 mutating Pro endpoints (proposal/reject/cancel, mission schedule/decline, CPO create/suspend/reinstate, org create, assignment create/finish/cancel)                                                                         |
| Dispatch gates  | Driver-only / exec protection-only bookings dispatch WITHOUT a vehicle (console mirrors `ops.service` rule); lead agent always explicit + server loads picks via `array_position`                                                                                            |
| Money UX        | Dispute resolution = structured modal (split inputs, live remainder, `≤ gross` check) replacing 3 chained prompts; escrow chips = the real 6-value enum; exec bookings get a server-computed `price_breakdown` composition table (PricingService is the single price source) |
| Queue standard  | Pro list: oldest-first actionable buckets, LOAD MORE, search, per-tab counts; bookings list shows the actual client name (server join); booking status model covers DISPATCHING / NO_PROVIDER / AGENCY_NO_SHOW                                                               |
| Confirm hygiene | Shared `ConfirmReasonModal` (Tailwind dialect); `window.prompt` is now ZERO across the console (suspend, erase w/ double-confirm kept, SOS resolve, compliance reject); Pro-queue destructive actions all have confirm steps                                                 |
| Dashboard/nav   | Pro KPIs (pending apps + waiting date-requests) computed server-side in the one dashboard query; nav badges on both PRO items ride the same poll                                                                                                                             |
| Compliance      | Pending queue rows carry provider name (linked to the agent record) + VIEW DOC file_url                                                                                                                                                                                      |

New pins: `pro-applications.service.spec.ts`, `pro-ops-audit.spec.ts` ×2,
`ops.service.projections.spec.ts`, 2 additions to `compliance.service.spec.ts`.
Gates: auth-service tsc 0 · targeted 407 tests green · full suite 126/126 green ·
console typecheck 0 / lint clean / build exit 0. Batches 2–3 cover the remaining
QUEUED rows (design-system unification is batch 3). NOT deployed — repo only.

### 2026-08-07 — ops-console audit remediation, batch 2 of 3 (G1–G24)

All 22 batch-2 rows from `docs/audits/OPS_CONSOLE_AUDIT_2026-08-07.md` (P3 set + SK-06a,
IS-09, IS-13) landed; SK-06(b) deferred with rationale, SK-11 documented in the audit doc.

| Area         | What shipped                                                                                                                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type debt    | `MissionDetail` carries `hourly_checkins` + exec booking fields — inline casts in `live/[id]` deleted; booking detail types `confirmed_at`                                                                                          |
| RBAC         | jobs REJECT gates on new `canRejectApplication` (SUPERVISOR+, mirrors server)                                                                                                                                                       |
| Datetime     | Hand-rolled formatters in jobs / bookings detail / live / dashboard replaced with `@lib/datetime`; audit trails + activity stamps now carry a date component                                                                        |
| Hygiene      | Pro thread send + admin-invite POST keyed; `sendReply` busy-guard; `genPassword` rejection sampling; `useProApplication` poll dropped to `POLL_DASH` (kills per-tab `sweepExpired` UPDATE spam); `addMonths` end-of-month clamp     |
| CSV          | Shared hardened `lib/csv.ts` (formula-injection neutralised); audit page + finance ledger reuse it; NEW exports on escrows / payouts / invoices / disputes (loaded rows)                                                            |
| Live page    | Deploy checklist polls w/ 404-vs-failure split; LOST SIGNAL corrected for client clock skew; ISSUE check-ins badge `!` on the danger token; humanized service label                                                                 |
| Fail-closed  | `lib/messenger/relay.ts` throws at first BROWSER use in prod when the base URL is unset (build/prerender unaffected — `next build` verified green)                                                                                  |
| Route shadow | Org-audit reader → `/ops/audit-log/org/:orgUserId` (spec-pinned) and finally CONSUMED: pro-management org drill-down (roster + protected members + audit log)                                                                       |
| Navigation   | Booking client id + payer pill, Pro applicant, incidents org (server-joined `org_name`) all link to identities; `CopyId` affordances; users tier filter gains `enterprise`; dept-attendance org picker (select + manual-UUID hatch) |
| Departments  | `/departments` renders the channel hierarchy (indent by level) + type/access badges from fields the server already returned                                                                                                         |
| Drafts       | Proposal-builder + internal-notes drafts survive logout/close via sessionStorage per application id                                                                                                                                 |

New pins: `ops-data.routes.spec.ts` (SK-08), `adminIncidents` org-name join in
`incident.service.spec.ts`. Gates: auth-service tsc 0 · targeted 617 tests green ·
full suite green · console typecheck 0 / lint clean / build exit 0.
Batch 3 = design-system unification (IS-10); note the two dialects now in play:
new inline-style UI (departments tree, org drill-down modal) vs Tailwind
(finance exports, dept-attendance picker, `CopyId` is style-neutral).
NOT deployed — repo only.

### 2026-08-07 — ops-console audit remediation, batch 3 of 3 (IS-10 obsidian migration)

The whole console left the legacy Command-Navy palette: `globals.css` `:root`
retokened to the obsidian system (canvas `#07090D`, shell `#0B0E14`, surface
ramp `#171C26/#10141C/#0D1119`, cobalt accent `#5B8DEF` + tints `#7CA5F4/#8FB0F7/#A9C5FF`,
text `#F2F4F8/#B7C0CE/#8B95A8`, new `--err-solid #DC2626` for white-text red
fills) with every token NAME kept, so all token-dialect pages (bookings, live,
dispatch, jobs, agents, dashboard, pro-_, settings, Shell, login) re-skinned
without a diff. `tailwind.config.ts` aliases mirror the same hexes (literal, so
alpha modifiers work — keep-in-sync comment in both files). The 13 zinc-dialect
pages + `ConfirmReasonModal` mapped color utilities → token aliases
(zinc→t_/s*/bd*, sky/blue→act/acc, emerald→ok, red→err(-solid), amber→warn);
layout classes untouched; solid green buttons now use dark ink (`text-canvas`).
All literal navy hexes / rgba tints in tsx swept (live wall/detail, BravoMap
markers+routes, MissionGroupPanel, SosAlertBar, auth-primitives, settings,
analytics); `var(--glow, var(--acc))` normalized; unused `aq-ico-ok/rej`
deleted. Contrast computed (table in the audit doc): all text roles ≥ 4.5:1;
known exceptions documented (white-on-cobalt CTA 3.2:1 = locked house style,
decorative hairlines). Gates: console `typecheck` 0 · `lint` clean ·
`next build` exit 0. Docs: IS-10 → FIXED in
`docs/audits/OPS_CONSOLE_AUDIT_2026-08-07.md` (+ §Batch 3 note w/ WCAG table).
NOT deployed — repo only.

### 2026-08-07 — ops-console audit remediation DEPLOYED to Contabo staging

All three audit batches (`d720af5c` F1-F17, `025f638d` G1-G24, `4a4fa5e6` IS-10)
pushed to main (`e67a8b30..4a4fa5e6`) after the full messenger push gate
(crypto ×2: 420 suites / 4235 tests green both runs; app screens 29 green).
Deploy method: `git archive HEAD apps/auth-service apps/ops-console
packages/messenger-core` → scp to box → tar-overlay into `~/bravo` (overlay
proven exact: `git diff --diff-filter=DR a56739e0..HEAD` on those trees = 0
deletions/renames) → `docker compose build auth-service ops-console` → `up -d`.
Pre-deploy backup `~/predeploy-backup-20260807-214805.tgz`; deploy archive
`~/deploy-4a4fa5e6.tgz` retained on box.
Verified live: both containers healthy on first poll; `/auth/health` 200;
`/auth/login {}` 400; NEW `/ops/users/:id/family` 401-not-404 (post-B-376
feature-route probe); renamed `/ops/audit-log/org/:id` 401-not-404; ops console
307→/login; public sslip.io mirrors same. In-container markers: `covered_until`
×3 in compiled pro-applications projection, `price_breakdown` in ops.service,
`recordAdmin` ×5 in pro-applications-ops controller, cobalt `5B8DEF` in served
CSS. Known pre-existing staging warning unchanged:
`NEXT_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64` unset (dev authority key fallback).

### 2026-08-08 — founder batch: B-393 product landing, ISO alpha-3, Operator Partner, albums, Step 5 skew

Five fixes pushed to main as separate commits (`889a531c..f7a5a919`), each
revertable alone.

**B-393 — the SWITCH DASHBOARD row for the product you are ALREADY in was a
silent no-op** (`a6474378`). The rows are a PRODUCT SWITCH, not a navigate:
`switchProduct` only writes `activeProduct`, and MainNavigator keys the whole
client tab tree on it (`key={activeProduct}`), so re-selecting the same product
wrote the value it already held — no remount, so `SecureTab`'s `initialParams`
(`{screen:'SecureServices', initial:false}`, B-390) never re-applied and the
drawer closed on the screen the user was already on. B-390 fixed where a real
SWITCH lands; nothing covered the non-switch. Not Secure-only: "Messenger" and
"Virtual Bodyguard" from ProfileTab were dead the same way. **The trap in the
fix:** the landing is `navigate`, not `push` — StackRouter pops back to an
existing route, so landing on a product root already in the stack truncates
everything above it, and `SecureProApplyScreen` keeps 15 fields in local
`useState` with no store and no `beforeRemove`. New `mountedStackHasRoutesAbove`
(`navigation/navigationRef.ts`) confirms ONLY when something would actually be
popped, so the founder's path (BookingHome → drawer → Secure Services) is a push
and stays one tap; deliberately NOT keyed on `isBookingDraftDirty`, which is
true whenever a pickup has ever been set. Store untouched on that path —
`setActiveProduct` would clear B-352's `returnProduct`. Back hint on Secure
Plans renders CONDITIONALLY (it is the a11y label too, and two cross-product
entries land elsewhere). B-390's `tabPress` listener was found UNREACHABLE:
`tabPress` is emitted only by the library tab bar, this app replaces it with
`CustomTabBar`, and `PRODUCT_TABS` renders `SecureTab` for no product — which is
why this control had to exist at all.

**ISO 3166-1 alpha-3 everywhere** (`b0b3af20`). New `utils/countryCodes.ts`,
198 entries, validated for well-formedness/uniqueness/exact coverage.
DISPLAY ONLY and that is load-bearing: alpha-2 remains the persisted news
preference, the `/news/feed` parameter, the dispatch/pricing key and the
flag-emoji source — rewriting it would drop every user's saved country
selection. Five display sites wrapped in `alpha3()`; REGIONS badges retire
UAE/KSA/RSA for ARE/SAU/ZAF and are now DERIVED from `code` (Issue 37 was a
hand-typed badge disagreeing with its own contract). Two defects the change
itself created and closed: country SEARCH matched only `c.code`, so "DZA" — the
only code now on screen — returned nothing; and Macau is in the VBG emergency
directory but not the 197 news countries, found because completeness is
asserted against EVERY source list.

**Operator Partner removed from the Virtual Bodyguard path only** (`87a87521`).
One guard in `cardsForProduct` removes the card and its "WHAT YOU GET" sub-card
together (the block renders from `card.id === 'provider'`). Scoped to vbg: D-5
still holds elsewhere — the funnel is how a security company signs up.
`cardsForProduct` exported so the rule is tested behaviourally, not by regex;
`productScopedPlans` RE-POINTED, not deleted.

**Albums in Files and Vault** (`b2010dee`). TWO INDEPENDENT spaces, never one
list — a Files album groups chat attachments still living in conversations, a
Vault album groups MFA-gated objects; sharing a list would put two security
states in one folder. Vault album state lives INSIDE `vaultStore`'s persisted
blob so `reset()` (Forgot PIN) wipes album NAMES with the file list; a separate
store would outlive the wipe and leave "Contracts"/"Licences" readable. An album
never owns bytes: deleting one UNFILES its items, a torn assignment surfaces as
Unfiled rather than hidden, counts run against items that EXIST, and
`pruneAssignments` stops the Files tab (a VIEW over messages) accumulating a
dead entry per deleted/expired attachment forever. Module named `fileAlbums` —
messenger already has `ui/imageAlbums.ts`. **Vault multi-select NOT included:**
there long-press already means "remove from vault" and images render
`slice(0,3)`, so bolting selection on risks deleting files.

**Step 5 TEAM COMPOSITION skew** (`13a6cbc7`). `teamCols` leaves `alignItems` at
`stretch` so both cells share a HEIGHT, but content was top-aligned and the
captions are not the same height ("CPOs" one line, "VEHICLES + DRIVERS" two), so
the steppers sat on different baselines. Fixed twice over: `space-between`
bottom-anchors the stepper (survives fontScale 1.3+, where a caption reaches
three lines) and a two-line `minHeight` keeps the internal rhythm identical in
the ordinary case. Plus `textAlign: center` (the cell centres the Text BOX, not
its lines) and the Driver-Only chip pinned to the stepper's 36.

**Review.** Three adversarial agents (critic / regression / iOS+Android UI) ran
against the B-393 diff. They independently found the stack-truncation defect
above and two surviving mutations (`DRAWER_FADE_MS = 220 → 0`, and
`activeProduct → current`) — both now pinned. Their false-copy finding is why
the back hint became conditional.

**Gates (post-rebase, on the combined tree with the enterprise scope-v2 merge):**
app 117 suites / 1429 tests · booking 50 / 594 · messenger-crypto 421 / 4242
(first run showed `freeSpacePrecheck` red; passes in isolation and clean on the
second full run — B-126 moving flake, suite untouched here) · messenger screens
30 / 327 · tsc 43 vs baseline 47, none in changed files · eslint 0 errors ·
pre-push hook 23 suites / 246. No `--no-verify`.

**Numbering collision, recorded:** the enterprise branch that landed mid-flight
had already claimed **B-392** for the ApprovalStatus naming bug. This work was
renumbered to **B-393** across all 13 code/test references (`f7a5a919`). The
five fix commits still say "B-392" in their MESSAGES — written before that
branch merged, left rather than rewriting history adjacent to the remote. Code,
tests and `sqa.md` are the authority.

**Open, deliberately not fixed:** `ProfileScreen.handleRow` omits
`initial: false`, so Profile → Secure Plans while the active product is
`messenger` roots the lazy booking stack AT that screen and **iOS has no back
gesture at all**. Pre-existing, already on `nestedNavigationInitialFlag`'s
known-backlog list. Adding the flag changes back behaviour for every
Profile-hosted row (back → BookingHome instead of ProfileTab), contradicting
`PROFILE_HOSTED_ROUTES` intent — needs a product decision, not a patch.

**Environment note:** the Pixel 6a re-enumerates on USB (`transport_id`
increments), and every re-enumeration silently drops `adb reverse`, which
presents as "Metro disconnected" while Metro is alive. A 5 s watchdog that
re-adds `tcp:8081` is the practical fix; Wi-Fi is not an option (AP isolation,
`env_metro_device_wifi_isolation`).

### 2026-08-08 — VBG news joins share-to-messenger (OSINT + GeoRisk)

Founder: "anyone can share news on messenger (group or individual)" from the
VBG news surfaces, with the shared message carrying the headline and a rich
preview in the chat bubble.

**What already existed (5d088eaa, 2026-08-05):** Bravo Intel and the Regional
News Feed (`NewsFeedScreen`) already share via `ShareNewsSheet` → `ForwardList`
picker → `rt.sendText` with `buildShareText` ("Headline \n via Source \n URL").
The bubble side needs nothing: `firstUrlIn` matches a URL ANYWHERE in the text,
so the last-line URL triggers `LinkPreviewCard` (OG title/image) under the
headline text. The founder's screenshot showing no share glyph on the feed rows
is a PRE-5d088eaa build — the code has it; the device needs a newer APK.

**What was missing — the two VBG surfaces that render news with no share:**
`VBGOSINTScreen` threat cards and `VBGGeoRiskScreen` per-risk article rows.
Both item shapes already carry `{title, url, source}` = `ShareableNews`.

- `vbgUi.tsx` — new `ShareIcon` (the same Material share-variant glyph the news
  feed uses, drawn with Svg because VBG screens don't load the icon font;
  default `VBG.accent` cobalt).
- `VBGOSINTScreen.tsx` — share button at the right end of each card footer
  (`marginLeft:'auto'`; `threatSrc` gained `flexShrink:1` + `numberOfLines={1}`
  so a long source can't push it off), gated on `t.url`, + `ShareNewsSheet`.
- `VBGGeoRiskScreen.tsx` — share button on each expanded risk-article row.
  State + sheet live in **`GeoRiskPanel`**, NOT the screen wrapper — the panel
  is also embedded on the VBG Home dashboard (B-91 M2 R3), so hoisting to the
  screen would silently drop share from the embed. Pinned by test.
- `shareNews.test.ts` — VBG surfaces pinned (share wiring, panel-scoped
  GeoRisk assertion, no `Share.share(` on any sharing surface).

Not touched: `ShareNewsSheet`/`buildShareText` (unchanged, gained callers),
department channels stay excluded via `ForwardList`, no `navigate('Chat')`
(the door-sweep test stands), no messenger-module changes.

**Gates:** shareNews 10/10 · keyboardContract 40/40 · tsc 7 errors, all
pre-existing icon-name TS2322, none in changed files (baseline 47) · eslint 0
on the four changed files.

### 2026-08-08 — one loading screen everywhere (founder screenshot rule)

Founder, with a screenshot of the BiometricGate lock screen: "all loading
screen must be this screen." That screen was `LockView` in
`BiometricGate.tsx` — a bespoke layout on the LEGACY palette
(`#0A0F1E`/`#2563EB`), while every other loading state used `LoadingView`'s
different medallion + "BRAVO / SECURE ACCESS" composition. Unified in one
direction: the screenshot's composition became `LoadingView`, and the gate
now composes `LoadingView` instead of drawing a lookalike.

- `LoadingView.tsx` — REWRITTEN to the reference composition: circular
  `BravoShieldBadge` (exported; filled `shield-lock` MaterialCommunityIcons
  glyph — the exact glyph from the screenshot), "Bravo Secure" brand title on
  `fullscreen`, status line = `label` (then `hint`), small `ActivityIndicator`
  below — exactly the lock screen. Obsidian/cobalt tokens (#07090D/#5B8DEF);
  legacy BravoMark block, encrypted footer, halo pulse and sweep arc REMOVED.
  `steps` mode (navigation/index VERIFY/SIGNOUT checklists) kept: progress
  ring drawn around the badge + the staged checklist. API unchanged — all
  ~60 call sites (label/hint/fullscreen/steps/accent/compact) compile as-is.
- `BiometricGate.tsx` — waiting states render
  `<LoadingView fullscreen label="Verifying identity…"/>` (the gate IS the
  loading screen now); the failed state keeps its in-flow UNLOCK retry button,
  rebuilt on `BravoShieldBadge` + Manrope + obsidian tokens. Legacy palette
  gone.
- NOT changed: `SplashScreen` (the animated brand-reveal tile + progress bar
  — a designed brand moment, deliberately outside the loading rule since the
  a292d31 sweep); inline button/row spinners (not screens).
- Pinned by `src/components/__tests__/loadingScreenIdentity.test.ts` (source
  scans: badge + brand title + gate composition + legacy-palette ABSENCE —
  red against the pre-change gate, which contained `#2563EB`).

**Gates:** loadingScreenIdentity 4/4 · full app 118 suites / 1435 (incl. all
messenger screen suites) · booking 50 / 594 · tsc 43 vs baseline 47, none in
changed files · eslint 0 errors (6 pre-existing no-void warnings) · crypto on
the final tree: see push record below.

## 2026-08-09 — B-404 referral-code write side (auth-service + ops-console; no client change)

**What broke.** Issue 28 (2026-07-25) shipped the booking-side referral-code
READ path — `CustomizeAddOnsScreen` field → `create-booking.dto` → submit-time
lookup in `provider_referral_codes` — with no way to create a row (no seed, no
endpoint, no ops screen; live count 0 per the 2026-08-05 RLS migration's
incident check). Every non-blank code therefore 400'd `referral_code_invalid`;
the founder hit it by typing the field's own placeholder example.

**The build (write side, attribution-only contract intact):**

- `apps/auth-service/src/ops/referral-codes.{service,controller}.ts` —
  `GET/POST /ops/referral-codes`, `PATCH /ops/referral-codes/:id/active`.
  List = any admin; mint/(de)activate = `SUPERVISOR/ADMIN` (same gate as
  subscription pricing) + `IdempotencyInterceptor` on the POST. Mint enforces
  exactly-one of `owner_user_id` (live user checked) / `partner_name`,
  uppercases before insert (booking lookup is uppercase), 23505 →
  `code_already_exists`, rejects past expiry. Audited as `referral.create` /
  `referral.deactivate` / `referral.reactivate`, subject_type `system`
  (already in `ops_audit_subject_type_chk` — no constraint migration).
- `apps/ops-console`: `/referral-codes` page (mint form + codes table with
  derived status active/expired/inactive, booking counts, deactivate/
  reactivate), `opsApi.{listReferralCodes,createReferralCode,
setReferralCodeActive}`, `canManageReferralCodes` (rbac), nav entry in the
  Operations group.
- `booking.service.ts` — the `redeemed_count` bump moved OUT of
  `resolveReferralCode` (validation time) to AFTER the successful
  `lite_bookings` INSERT: a booking that failed after validation still counted
  a redemption. Still fire-and-forget (`.catch` → warn).
- Migration `20260809110000_referral_codes_write_side.sql` — partial index on
  `lite_bookings(referral_code_id)` for the list view's booking-count join.
  No new tables ⇒ no new RLS surface.
- **Deliberately NO seed migration** — partner codes are real business data;
  ops mints them from the console (e.g. `TRAVELCO-01` takes seconds).

**Pinned by:** `referralCode.test.ts` extended — B-404 write-side existence
(service/controller/module/console/api/nav), bump-after-insert ordering +
`resolveReferralCode` purity (mutation-proved RED by reinserting the bump),
and the write service never mentioning dispatch/cascade/escrow/rank; the
original never-read-by-dispatch pins unchanged. New
`referral-codes.service.spec.ts` (uppercase insert, exactly-one attribution
incl. whitespace/zero-width partner, owner-not-found, past + calendar-invalid
expiry, 23505, (de/re)activate audit actions incl. lapsed-expiry clear, 404,
list status derivation).

**Ship record (2026-08-09):** commit `b4f9c041` pushed to main (messenger gate:
crypto green ×2 with one moving-flake red between — B-126 pattern; screens
327/331). Migration applied to the live DB via psql-in-pg-container using the
auth container's own `DATABASE_URL` (index verified in `pg_indexes`;
`provider_referral_codes` count 0). Deploy: tar-overlay of `git archive
b4f9c041` (no local rsync), pre-deploy backup tgz on the box, both images
rebuilt + restarted, healthy in 39 s. Probes: auth `/ready` 200,
`/pro-applications/me` 401, **`/ops/referral-codes` 401** (live+guarded), ops
`/pro-applications` 307, **`/referral-codes` 307**, messenger `/healthz` 200.
FORCE-RLS write probe as the service role: INSERT `SMOKE-B404` → found by the
exact booking-lookup query → deleted (the silent-deny lookalike is disproven).
Watchdog pristine snapshot refreshed from the deployed tree (5 referral-codes
entries confirmed inside). REMAINING founder smoke: console login → mint
`TRAVELCO-01` → mobile booking with the code (accept), deactivate → reject.

**3-agent review round (critic / edge-cases / deployment) — fixes applied:**
strict ISO8601 + NaN expiry guard (calendar-invalid date 500'd); reactivation
clears a lapsed expiry (expired codes were unrevivable while the console
promised otherwise); two static pins re-anchored per the CLAUDE.md
weak-anchor rule and BOTH mutation-proved RED (controller dropped from the
`controllers:` array; `@RequireRoles` dropped from `@Post`); console loading
row, UTC expiry label, Bookings tooltip, leading-dash strip on the mobile
input, zero-width partner strip, bare-token `owner_or_partner_required`,
DTO `@MinLength(2)`. Deployment conditions: commit+push BEFORE deploy
(git-archive ships committed content only); apply the migration via direct
SQL, NEVER `supabase db push` (ledger drift → 79-migration replay); a manual
tar-overlay must refresh the watchdog pristine snapshot; sign-off includes
one real staging mint (FORCE-RLS deny would look exactly like B-404 with all
suites green).

---

## 2026-08-10 — B-415 dedicated-officer routing (Pro): request → dedicated CPO directly + live Assigned Team

> (Shipped in a commit titled B-411; renumbered to B-415 after the parallel session's push
> claimed B-411..B-414 — see the sqa.md renumber note.)

**Change (uncommitted at write time).** A Pro member's protection request whose dates are
covered by an ops-assigned dedication window now auto-schedules to that officer
(`requestMission` fast path — SCHEDULED insert, `system` event, push; no ops step). The
ops pool picker gets `application_id` context: the member's own officer shows
**DEDICATED** (selectable, sorted first) instead of BUSY, and manual scheduling REUSES the
covering `pro_cpo_assignments` row (gist exclusion forbids a duplicate; rollback never
cancels the pre-existing row; `createAssignment` idempotent over a covered window). New
client endpoint `GET /pro-applications/:id/team` (identity+window only — mission_code
never reaches the member) feeds a now-LIVE `ProAssignedTeamScreen` (WS `proapp.*` +
10s poll, ON DUTY / SCHEDULED).

**Deploy notes:** auth-service (pro-applications + pro-management modules) + ops-console
via the manual Contabo tar-overlay (GH Actions dead — billing); NO DB migration. Mobile
(`ProAssignedTeamScreen`, `SecureProCalendarScreen`, `services/api.ts`) needs an APK
rebuild before the founder can see the live team screen. Smoke after deploy: member with
an active dedication requests covered dates → response mission SCHEDULED, appears on the
CPO's PMC view dates, ops REQUESTS queue does NOT gain a row; pool picker with
`application_id` shows DEDICATED. Suites: pro-\* 41 tests green, full auth-service suite
green, ops tsc clean, mobile tsc 43 ≤ 47.

---

## Protection & Surveillance — Protection Sessions (2026-08-10, Opus build)

Spec: `docs/planning/PROTECTION_SESSIONS_SPEC.md`. On-demand live-tracking sessions layered on
the live Pro plan→assignment substrate (reuses pro_applications / pro_cpo_assignments / B-415
dedicated routing; touches NO messenger crypto or booking dispatch). Founder §13 defaults all
confirmed (max 12h, no-fix 10min, conn-lost 3min, ops-silent 10min, retention 30d, foreground-app
streaming v1 — Android location-FGS a deliberate fast-follow, not a drive-by).

**Backend — SHIPPED + DEPLOYED (commit `8c5fb7e8`, origin/main).**

- Migration `20260810120000_protection_sessions.sql` — `protection_sessions` /
  `protection_session_locations` / `protection_access_audit` (RLS enable+FORCE, zero policies)
  - `sos_events.protection_session_id` + the one-live-session-per-customer partial unique index.
    **APPLIED to Supabase** via box psql against the auth container's DATABASE_URL (§14 direct-SQL,
    idempotent; NEVER `supabase db push`); verified relrowsecurity+relforcerowsecurity=t on all 3.
- Module `apps/auth-service/src/protection/` — pure FSM (`REQUESTED→ACTIVE` on first accepted fix,
  idempotent end, no-fix/12h/retention lazy sweeps), customer surface (create w/ 23505→open-existing,
  current, locations-ingest, end, history), CPO surface (`cpo_user_id`-scoped + access-audited
  overview/detail/locations), Ops surface (AdminGuard end/transfer + OpsAudit, session list/detail).
  Server-clock staleness ladder (`protection.staleness.ts`, ≤45s live / ≤3m delayed / >3m
  unavailable). `psession.*` broadcasts are refetch TRIGGERS only — coordinates stay behind the
  audited REST poll (§9). `MissionEvent` union extended (additive; gateway re-emits any name).
- Tests: 45 specs (FSM mutation-proof, create validations, 23505 handler, end idempotency,
  SOS-vs-end isolation, ingest activation-on-first-fix + 410 straggler + invalid-fix drop, foreign
  CPO 403 + access audit, ops end/transfer-only). Full auth-service suite green (2507).
- Deployed to Contabo via tar-overlay (rsync unavailable on the Windows box); `nest build`
  typecheck gated it; routes probe 401 (loaded+guarded, not 404); no `/pro-applications` regression;
  **watchdog pristine snapshot refreshed** to include `protection/`.

**Customer mobile — CODE-COMPLETE, device-verification PENDING (APK rebuild needed).**

- `services/api.ts` `protectionApi`; `services/protectionLocationService.ts` (singleton GPS watch +
  batch/retry offline queue, never logs coords, surfaces backend-confirmed status for the
  Starting→Active flip); `screens/pro/useProtectionSessionRealtime.ts`; rebuilt
  `ProLiveMissionScreen` (request→consent→permission→Starting…→Active + CPO card + own-position
  Mapbox WebView + truthful "last sent Xs ago"/"Connection lost — retrying" + SOS + End w/
  SOS-active confirm); prominent "Request Protection" card on `ProDashboardScreen` (ACTIVE only).
- Mobile tsc 42 ≤ 47 baseline, zero new errors. NOT yet run on device.

**REMAINING (next sessions):** SOS backend linkage (§7 — stamp `protection_session_id` + snapshot
on `/sos/raise` when caller has a live session; column already exists); CPO app screens (Phase 4);
ops-console `/protection` page (Phase 5, deployable w/o device); notifications matrix (Phase 6 —
`psession-*` bridge kinds + enumerated `serverWakeNotifications`/`fcmBootstrap` branches + parity
scan); full staging E2E + device pass (Phase 7). Plan-expiry ops-alert (`plan_expired_session_live`)
and CPO-offline alert are ops-alert-phase adds (live sessions already survive expiry — sweepExpired
only touches pro_applications).

### Protection Sessions — phases 4-6 + SOS §7 (2026-08-10, same session)

**Backend (redeploy needed):**

- §7 SOS linkage (`sos.service.ts` + `MissionEventsService` injected): `/sos/raise` now detects
  the caller's live protection session, stamps `protection_session_id`, snapshots the last known
  location when no fix was sent, flags the session `sos_active`, broadcasts `psession.sos`, and
  wakes the session's CPO. The SOS stays owned by the sos lifecycle (§3) — session-end never
  resolves it. 2 red-first specs (`sos.session-link.spec.ts`).
- §10 push kinds (`BookingPushBridge`): `psession-started`/`-ended`/`-new`/`-sos`/`-conn-lost` +
  `pro-cpo-changed`, wired into ProtectionService (create→psessionNew CPO, ingest-ACTIVE→
  psessionStarted customer, opsEnd→psessionEnded, transfer→proCpoChanged + psessionNew).
- Full auth-service suite 2513 green; tsc clean.

**Mobile (APK rebuild needed) — CODE-COMPLETE:**

- Phase 4 CPO: `cpoProtectionApi` + `CpoProtectionScreen` (overview, 5s poll, staleness pills) +
  `CpoProtectionSessionScreen` (Mapbox trail map + server-clock staleness ladder + SOS banner),
  registered on the CPO RootStack + an On-Duty home entry card.
- Phase 6 notifications: 6 kinds added to `AGENT_WAKE_META` + `activitySync KIND_META` +
  `kindToActivityClass` + `fcmBootstrap` tap routes. **Both parity scans green**
  (serverWakeKindParity 5, serverWakeTapRouting 15). mobile tsc 42 ≤ 47, eslint clean.

**Ops-console (deploy needed) — Phase 5:** `/protection` page (SWR 2s list + detail with BravoMap,
staleness colours, SOS strip, END via ConfirmReasonModal + TRANSFER); `opsProtectionApi` +
`useProtectionSessions`/`useProtectionSession` hooks; Shell nav entry under Safety. ops tsc clean.

**Remaining:** staging E2E + on-device pass (Phase 7); CPO conn-lost push sweep + plan-expiry
ops-alert are deferred nice-to-haves (staleness UI already truthful; live sessions survive expiry).

### Protection — CPO-loc/notes/protect/satellite/retry + Mission History (2026-08-10, same session)

**Shipped + deployed to staging** (migrations 20260810160000 + ...180000 applied; auth-service +
ops-console deployed; watchdog snapshot refreshed):

- **CPO location** (`protection_session_locations.subject`) + `cpo-ping`; **3 SATELLITE maps**
  (ops Client/CPO/Combined tabs; phone maps satellite; CPO combined marker) — fixed blank map
  (BravoMap needs a height).
- **In-session notes** (`protection_session_notes`): customer predefined+comment (one-way) + CPO
  reply; CPO status updates → Ops. **CPO Protect** (`protect_activated_at`, idempotent one-time,
  recorded+notified). **Persistent "Not sent — tap to retry"** offline state on both screens.
- **Mission History** (§1-9): ONE canonical append-only `protection_session_events` timeline
  (seq, event_type, actor_id/role, prev/new status, comment, visibility, server ts) → role-filtered
  views. recordEvent at every transition. Role-scoped, paginated, server-enforced timelines
  (customer=visibility'all' only; cpo=owns; ops=full+audited). `opsListSessions` filters
  (status/cpo/user/date). Mobile `CpoProtectionHistoryScreen` (loading/empty/error+retry/pagination/
  read-only). Ops detail: canonical timeline + Mission-vs-Protection status labels (§9).

**Gates:** auth-service 44 protection/sos specs (timeline pins) + full suite; auth/ops tsc clean;
mobile tsc 42<=47 + eslint 0 + keyboardContract 40.

**APKs:** v1.0.229 distributed (satellite/maps/notes/CPO-Protect/CPO-loc). v1.0.230 = +offline retry

- Mission History (building/pinned; earlier 1.0.230 build was cancelled before distribution → number
  reused). Version bump commits land with each build; git commits: 84324e64 (loc/maps/notes/protect),
  e8c0180a (retry), 8b2c07d1 (mission history) — rebased onto parallel-session pushes.

**Remaining:** dedicated USER mission-history screen (backend+API ready; user currently sees live
session + notes + session history endpoint); optional ops CSV export respecting filters (§6).

### CPO assignment authorization persists across reinstall (2026-08-11)

**The bug (founder):** Vinod is assigned + approved to protect Sirajul, enters the Mission Code,
sees the mission — then uninstalls/reinstalls and is asked for the Mission Code AGAIN. Root cause:
the ONLY thing that survived a restart was the code itself, cached in AsyncStorage
(`cpo:pro-mission-code`) and re-validated on focus. Uninstall wipes AsyncStorage → gate returns.
The code was doing double duty as a login credential.

**The fix — authorization is a server-side fact on the assignment row.**

- Migration `20260811090000_cpo_assignment_authorization.sql`: `pro_cpo_assignments.authorized_at`
  - `revoked_at`, backfill of `revoked_at` for existing CANCELLED rows, and a partial index on
    `(cpo_user_id, ends_on DESC) WHERE status='ASSIGNED' AND authorized_at IS NOT NULL` (the restore
    lookup runs on every CPO app launch).
- `resolveMissionCode` stamps `authorized_at = COALESCE(authorized_at, now())` — idempotent, so a
  duplicate submission never re-authorizes or duplicates a record (edge case 8).
- **NEW** `GET /agents/me/pro-mission` → `getActiveMission`: returns the mission with NO code, but
  only when `cpo_user_id = caller AND status='ASSIGNED' AND authorized_at IS NOT NULL AND
ends_on >= CURRENT_DATE`, after `sweepAssignments()` completes finished schedules. Ops revoke
  (CANCELLED) / schedule end / never-authorized all 404 → the gate returns, server-decided.
- Both revocation paths (`cancelAssignment` + the assignment rollback) now stamp `revoked_at`.
- Mobile `CpoProMissionScreen`: AsyncStorage cache DELETED repo-wide; on focus it asks the server.
  New states — "Checking your assignment…" (no gate flash) and an offline **Retry** card, because a
  4xx means "no authorization" but a network error must NOT imply revoked and must NOT restore
  protected data from a device cache (edge case 7).

**ASSIGNMENT_COLS gotcha:** 3 call sites build `RETURNING` via `ASSIGNMENT_COLS.replace(/pca\./g,'')`,
so the 2 new columns make the migration a HARD prerequisite of the code deploy. Migration was
applied first, then auth-service rebuilt.

**Gates:** new `mission-authorization.spec.ts` (11 specs) — **mutation-proven RED twice**: inverting
the stamp condition fails 3, deleting the `authorized_at IS NOT NULL` restore guard fails exactly
the guard spec (the mock deliberately dispatches on `ORDER BY pca.starts_on ASC`, not on an
asserted clause). All 46 `pro-*` auth specs pass; auth tsc 0; mobile tsc 42<=47; eslint 0 errors.

**Staging E2E (Vinod → Shirajul, `PMC-8HWXV6`):** device A before code → 404; enter code once → 201
(`authorized_at` stamped); **device B with a brand-new deviceId (= reinstall) → 200 with the mission,
no code**. 3 repeat submissions → still 1 row, original stamp unchanged.

### Mission-start readiness gate — both sides must be device-ready (2026-08-11)

**Founder rule:** a protection session may become ACTIVE only when BOTH the protected customer AND
the assigned CPO hold real device capability. One ready side is never enough.

- Migration `20260811140000_protection_session_readiness.sql`: `protection_session_readiness`
  (session_id, role, user_id, location_permission, location_services, precise_location,
  connectivity, **location_available**, `ready` **GENERATED ALWAYS AS** all-five, platform,
  reported_at; PK (session_id, role); RLS ENABLE+FORCE, zero policies). `ready` is generated so
  **no client can assert readiness** while a requirement is false.
- **The gate** lives inside the ingest UPDATE (`WITH gate AS (SELECT count(*) FILTER (WHERE ready)=2
…)`), so a readiness flip racing the first fix can never produce a half-ready ACTIVE. The
  deferred half — `tryActivateWhenReady` — runs after every readiness report, so whichever side is
  LAST to become ready activates the session if a fix is already banked (edge case 11); neither
  ordering of "ready" and "first fix" can strand a session.
- `POST /protection/sessions/:id/readiness` + `POST /agents/me/protection/sessions/:id/readiness`.
  `sessionReadiness()` returns per-side `{ready, reported, missing[]}` + `state`
  (`READY` | `WAITING_FOR_READINESS`) + `blocked_by[]`; a side that never reported owes EVERYTHING
  (never optimistic). Added to getCurrent / cpoSessionDetail / opsSessionDetail.
- Losing readiness mid-session records a `readiness` timeline event (edge case 6), once — not on
  every repeat report.
- Mobile: pure `@utils/protectionReadiness` (labels, hints, `applyLocationError`) +
  `useProtectionReadiness` hook (permission/precise/services/NetInfo/real fix, re-checks on
  AppState foreground so returning from Settings needs no restart) + shared `ReadinessGate`
  ("Protection Setup Required" / "Mission Not Ready", exact missing items, Open Settings, Check
  again, and a "waiting for the other side" state).

**GEOLOCATION ERROR TRAP:** code 3 (TIMEOUT) means "no fix YET" — it must NOT be reported as
"Location Services off" or the user is sent to the wrong setting. Only codes 2/5 clear
`location_services`; code 1 clears permission. Pinned by `protectionReadiness.test.ts`.

**BREAKING FOR OLD CLIENTS:** an APK that never reports readiness can no longer activate a session
(it will sit at "Starting protection…"). Backend + APK must ship together.

**Gates:** 59 auth-service protection specs (16 new readiness) — the gate is **mutation-proven**:
deleting `AND g.both_ready` fails the activation spec. 23 mobile `protectionReadiness` specs.
auth tsc 0; mobile tsc 42<=47; eslint 0 errors.

### iOS black map — every map surface needed a baseUrl (2026-08-11)

**Founder:** "the map appears black on iPhone" (CPO + User apps). Root cause is systemic, not
protection-specific: **no map in the repo passed a `baseUrl`**.

`source={{html}}` makes WKWebView call `loadHTMLString:baseURL:nil`, giving the document a **NULL
(opaque) origin**. Mapbox GL JS v3 starts its render/worker threads from **`blob:` URLs**, and
WKWebView refuses blob workers on a null origin — GL never initialises, the canvas is never
painted, and the div keeps its CSS background: a correctly-sized **black rectangle with no error**
(the main frame loaded fine, so `onError` never fires, and B-77's `useMapReload` watchdog only
catches surfaces that wire it). Android's WebView is permissive, which is why the same build looks
right there.

**Fix:** one helper — `@/modules/maps/mapWebViewSource` → `mapHtmlSource(html)` returns
`{html, baseUrl: 'https://api.mapbox.com'}` (a real secure origin, and same-origin for the GL
script/CSS). Applied to ALL 7 surfaces: ProLiveMission, CpoProtectionSession, LiveTracking,
AgentLiveTracker, LocationPicker, VbgKeyPointsMap, MapPrewarm (the prewarm must share the origin or
it warms a cache the real maps cannot reuse).

Also for the two protection maps: `mixedContentMode`, `androidLayerType`, and
`onRenderProcessGone`/`onContentProcessDidTerminate` remounts — iOS reclaims the WebView content
process while backgrounded, so without them the map returns from the background blank
(spec: "recover after app background/foreground transitions"). Both protection maps now build their
HTML ONCE (memoised) and move markers via `injectJavaScript`; CpoProtectionSession previously
rebuilt the html string on every 5s poll, which reloaded the whole map mid-mission.

**Gate:** `mapWebViewSource.test.ts` — 9 specs incl. a **static source scan** over all 7 surfaces
banning `source={{html` and `useMemo(() => ({html}))`. Comments are stripped before the absence
assertions and scanning is line-based (files are CRLF) per the CLAUDE.md scan rules.
**Mutation-proven:** reverting MapPrewarm to `source={{html}}` fails exactly its case.

**NOT DEVICE-VERIFIED:** there is no iPhone/Mac in this environment. The diagnosis and fix follow
from the WKWebView null-origin/blob-worker behaviour and are pinned by tests, but the black-map
symptom itself has not been reproduced or confirmed fixed on a real device.

---

## 2026-08-26 — Channel-tenant unification: every org starts CLEAN (client request)

Client (verbatim intent): "There must never be pre made channels, even on service provider
channels. It must always come out clean like on the new enterprise channels… All Channels must be
exactly the same and should also start the same… no need for 2 different types."

**Server (`department.service.ts`):** `seedOrgWorkspace` is now a declared no-op for BOTH tenants
(the agency Announcements/Operations/Intel/'CPO Roster' set and founding level-1 #broadcast are
gone); the per-level auto-#broadcast producer `ensureBroadcastForLevel` is deleted outright (both
call sites); laterals, roots and the B-590 legacy-root promotion now apply to every tenant; a
legacy #broadcast is archivable AND deletable by every tenant's owner (`canDeleteChannel` lost its
tenant arm). **Kept workspace-gated on purpose:** the restricted-root refusals on both verbs —
`seedsManagersOnly` also covers `channel_type 'incident'`, and agencies legitimately run top-level
incident channels.

**Migration `20260826130000_unify_channel_tenants_clean_start.sql`:** drops the BEFORE DELETE
broadcast trigger (already workspace-exempted by 20260811160000). No data touched — existing
seeded channels stay until an owner removes them; the 20260817 purge script remains the manual
bulk option.

**Gates (flipped tests-first, red -> green):** `workspaceCleanStart` (agency twins now assert
parity, the level-0-trap pin is now an ABSENCE scan), `department.service.spec`,
`channelAccessInvariants` (Phase-2 pin flipped to "no producer left"), `broadcastBackfill` F5,
`channelTreeFields` (agency owner/broadcast delete flips). Full auth-service suite: 149/149,
2794 pass. tsc 0. Mobile untouched: no screen keys on the seeded names, and the old refusal
error-code mappings stay for rolling-deploy compat.

**NOT COVERED:** the mobile workspace-style tree/organisation-picker UI is not yet offered on
agency orgs (they keep the flat rendering); unify that UI in a follow-up if the client wants the
full four-level experience on service providers too.

## 2026-08-26 — Ops-console control-room hardening (OC-01..OC-13) + messenger search + vault fixes

**Batch 1 — ops console (commit 39b13df8).** Full audit
`docs/audits/OPS_CONSOLE_MONITORING_AUDIT_2026-08-26.md` (managing 82/100, monitoring 58/100),
then the P0/P1 remediation same session: SOS poll survives hidden tabs + browser Notification
push + idle-logout deferral while an SOS is live (OC-01/02); audit rows + confirms + role gates
on every pricing/tier/catalog mutation incl. eur_per_bc (OC-03, pinned by
`ops-pricing-audit.spec.ts`); doc/KYC review endpoints SUPERVISOR+ and audited (OC-04);
error.tsx/global-error/not-found + real `/api/health` + Docker healthcheck + ops-console CI job
(OC-05); amber alert tier for critical incidents + LOST SIGNAL (OC-06); `/live` staleness
(OC-07); admin offboarding endpoint + UI with last-ADMIN guard (OC-09); role-filtered nav
(OC-12); audit-viewer actor filter + subject-type fix (OC-13). Gates: ops-console
tsc/lint/build, auth-service tsc + 152 suites green. NOT deployed to Contabo yet.

**Batch 2 — messenger search + vault (client requests, this session).**

- B-636-style message search on MessengerHome (snippet hit-list under the chat rows) and a NEW
  in-conversation search sheet in ChatScreen; both scoped through the same
  `runtime.searchMessages` allow-list contract. New `focusMessageId` route param + a bounded
  deep-jump that pages older history until the hit is loaded (replyJumpParity's pinned
  `jumpToMessage` untouched — the deep loop hands off to it).
- B-662: chat-list "(encrypted)" preview — shared `conversationPreview.ts` rule (call rows,
  delete-for-everyone tombstones, system rows); residual cold-start/stale-pointer mechanisms
  documented OPEN in sqa.md.
- B-663: Vault FILES search icon was decorative — now a real filter row; plus direct
  device→vault upload (document/photo pickers → `moveBytesToVault`, tier-gated, personal-shelf
  only) from the empty-state tile and an UPLOAD pill.
- Test deltas: `conversationPreview.test.ts` (new), picker mocks added to two FilesScreen
  suites, `vaultProvenanceForwarding` FilesScreen pin moved to the counted form (1 legitimate
  `conversationId: null` — the local-pick lane, same rule as VaultScreen).

**Device verification OWED** (B-662/B-663 + all three features) — release APK pass pending.

## Fix batch 2026-08-26 (PM) — back-navigation + rapid-use remediation NAV-01..23 / B-664..B-679 (client-only, APK rebuild REQUIRED — ships as v1.0.264)

**Source audit:** `docs/audits/NAV_BACK_RAPID_USE_AUDIT_2026-08-26.md` (client: "not smooth
swipe back (back button also) and rapid use"; founder repro: button ×20 → rapid back/forward).
Full bug table in sqa.md (B-664..B-679, next free B-680). All client-side TS/JS — NO server
changes, NO migrations, NO native/manifest changes.

- **Swallowed back presses:** MessengerHome ×2 + FilesScreen `BackHandler`s are now
  `useFocusEffect`-scoped (they ate the first back press on every pushed screen); `NavHeader`
  got the BB-7 double-tap guard (with a `backGuardMs` opt-out for wizard step-backs); four agent
  screens' handlers read `handleBack` through a ref.
- **Rapid use:** NEW `navigateOnce` (forward twin of `goBackOnce`, keyed per nav object +
  name+params, 500 ms leading) wired into dashboard module cards, both tab bars, chat
  rows/headers, BookingHome, AgentDashboard (~45 sites). Sync in-flight guards on: CreditPaywall
  pay (was N Stripe charges), all six secureProStore mutators (THROW, never silent-resolve),
  reactions, biometric toggle, unblock, save-contact, incident assign, mark-all-read. Alert
  queue coalesces identical HANDLER-LESS requests only (promise-wrapped alerts must never be
  dropped); `confirmSwitchDashboard` has its own 600 ms source latch.
- **Nav-lifecycle cost:** `sameIdSet` identity guard on both dept-channel focus refetches (no
  more full chat-list re-sort per focus); `loadApplication` single-flight; BookingHome
  one-live-run focus load (poll still arms every focus) + isFocused resume guard; DeptHome six
  sequential awaits → `Promise.all`; ChatScreen draft flush deferred off the pop commit;
  `freezeOnBlur: true` on 7 stacks (root tabs deliberately NOT — device verify first); bare
  `useAuthStore()` at the nav root → field selectors. NEW shared
  `src/store/debouncedJsonStorage.ts` (B-633 adapter extracted from messengerStore verbatim);
  activityStore switched onto it + idempotent markRead.
- **NOT done (gated):** NAV-01/02 Android finger-following swipe-back (RNS
  GestureDetectorProvider — arch/design + device matrix), NAV-09 swallow feedback, shared
  Button consolidation, BB-1..BB-13.

**Gates:** typecheck 47 = HEAD 47 (stash-diffed, zero new); changed-file eslint 0 errors;
messenger-crypto 548 suites ×2 (only the B-126 moving flake, different suite each run, both
green in isolation); app messenger screens 51 suites green; booking 72 suites/851 green; full
app project green (see sqa). Five pins mutation-proved RED-first. Adversarial critic pass found
6 defects in the first cut — all corrected pre-commit (see sqa entry).

**Device verify OWED (founder rule):** v1.0.264 Firebase qa build — back-press sweep
(MessengerHome non-Chats tab → open chat → ONE back returns; Files multi-select), button-×20 on
dashboard cards → open Messenger (client's video repro — Samsung device if available: lag is
JS-thread + device-dependent, a Pixel 6a can absorb what a throttled/older device cannot), pay
double-tap, wizard step-backs, product-switch mash = one dialog, offer cascade on a buried
IncomingOffer.

## 2026-08-27 — Pro module-card ART asset contract (founder: "tell me the img size")

The 08-26 `contain` detour is reverted — `art` renders `cover` (edge-to-edge) again. The fix is
the asset shape, not the renderer. **Card art contract:**

- **Export: 1200 × 900 px, 4:3 landscape, JPEG (≤350 KB each).** The tiles are ~155-190dp wide ×
  ~130dp tall depending on phone width (width '48%', height content-driven), so 4:3 sits mid-range
  and 1200px covers 3x density with headroom.
- **Safe zone:** all important subject matter inside the CENTRAL 80% both axes — `cover` crops up
  to ~10% on one axis across the 360→430dp width range.
- **Copy zone:** left ~40% fades to near-black `#07090D` (icon top-left, title+description bottom
  sit under the scrim there); put the subject in the RIGHT ~55-60%.
- **Files (drop-in replace, same names):** `src/assets/imagery/proItinerary.jpg`,
  `proDesignatedTeam.jpg`, `proLiveMap.jpg`, `proBookingRequests.jpg`, `proReports.jpg`.

Turn-by-turn nav (1ef93230, 08-26 late): speed-limit ring (`annotations=maxspeed`, never guesses
where coverage is missing) + current-speed chip + "ON <road>" banner line on the native CPO
tracker — see `navSpeedRoad.test.ts` pins. Deliberately NOT the sales-contracted Mapbox
Navigation SDK. Device verify owed.

## Docs 2026-08-27 — NAV_RAPID_USE_LOOP born (founder: "all edits should take care of this")

`docs/runbooks/NAV_RAPID_USE_LOOP.md` created as the standing verification loop for the
B-664..B-679 domain (invariants N1-N11, gates, device probes, stop conditions, the critic's
DO-NOT-RE-PROPOSE table) and wired into CLAUDE.md alongside the BACKUP/MESSAGE/LITE loops —
any diff touching navigators, BackHandlers, navigating/mutating onPress sites, focus fetches,
persisted stores, @utils/alert, or freeze options must run it. Docs-only; no code, no APK.

## 2026-08-27 — B-680 font-scale "fix all" + B-681 designated-team missions + backup pw 4 + PermissionsScreen redesign

- **RN is now patched** (`patches/react-native+0.81.5.patch`): `Text`/`TextInput` default
  `maxFontSizeMultiplier` to 1.3 (element value wins, `0` = opt out), mirrored in RN's jest
  mocks. `npm install` MUST run patch-package cleanly — an RN upgrade must re-carry these four
  hunks or `textScaleCap.test.tsx` goes red. `utils/textDefaults.ts` is docs + constant only.
- ~45 screens/components got fontScale-hardening (badges minHeight+clamp, FitLine tab labels,
  flexShrink pairs, numeric-width removals, minHeight text boxes) — audit + fix record:
  `docs/audits/FONT_SCALE_LAYOUT_AUDIT_2026-08-27.md`, sqa.md B-680.
- **New pins:** `textScaleCap`, `badgeGeometry` (components), `tabLabelFit` (navigation),
  `missionTeamSections` (screens/pro), alert long-label cases. Re-anchored:
  `chatScreenMutationUi` (minHeight), `backupKdfHardening` (=4).
- `ProAssignedTeamScreen` now also fetches `secureProApi.missions` (allSettled) and renders
  "Mission teams — scheduled dates" (B-681, `screens/pro/missionTeam.ts`).
- `MIN_BACKUP_PASSWORD_CHARS` = **4** (founder decision; restore/unlock unchanged non-empty).
- `PermissionsScreen` = obsidian + BravoMark logo hero, per the imported Claude Design
  `Bravo Permissions - Android.html`; permission logic untouched.
- **Owed before release:** device fontScale sweep (`adb shell settings put system font_scale 1.3`
  then 2.0) on ProDashboard/tab bars/OTP/Register/calls; Pro scheduled-team round-trip;
  4-char backup enable→restore round-trip.

## 2026-08-27 — ops-console monitoring follow-up (OC-06/13 closed, OC-11 partial)

- `SosAlertBar` amber tier: + dispatch NO_PROVIDER/AGENCY_NO_SHOW + VBG stale/escalated sweeps.
- auth-service: audit rows on pro-app internal notes (SUPERVISOR+ now), ops messages, waypoint
  advance — audit-viewer actions `pro_application.internal_notes`, `pro_application.ops_message`,
  `mission.waypoint_advance`.
- /live/[id]: TRAIL toggle → telemetry breadcrumb polyline (useMissionTelemetry finally consumed).
- /live/wall de-linked + SAMPLE DATA banner.
- OC-08 (ops WS push) remains open: needs @nestjs/websockets deps in auth-service + arch sign-off
  on WS auth over the httpOnly ops session.
- Deploy note: 2026-08-26 batch (39b13df8) + this batch are BOTH undeployed → next tar-overlay
  deploy ships both (auth-service restart required for the new audit actions).

## 2026-08-31 — Brand card art for EVERY non-Pro dashboard (founder: "exactly same for others")

Founder drop `Bravo other dashboard/` (24 PNGs, deduped from 31) — the same purpose-made art
language as the 08-26 Pro set, extended to the agent/org, departmental and VBG surfaces.
Sources live in the gitignored drop root (`Proton Drive Download - 2026-08-25/Bravo other
dashboard/`) and are now a second `SMART_DIRS` entry; **25 generated assets, zero pre-existing
asset bytes changed** (`src/assets/imagery` 3.26 MB, budget 4 MB).

**Two new pipeline roles — `row` (4.8:1) and `wide` (2.9:1).** Founder call: the agent dashboard
KEEPS its full-width nav rows rather than becoming a Pro-style 2-column photo grid. A row is
~4.8:1, and no drop can be _cropped_ to that — `cover` would take a thin band out of the middle
and throw the subject away. So those roles are **PLATED**, the generalisation of what
`scripts/compose-card-art.py` did for the portrait AI-Itinerary drop:

1. cut the art to its bright bbox (`bright_box`, shared with `smart_crop`),
2. `_to_obsidian` — sample the border ring and subtract its excess over `#07090D`, so a drop
   authored on a grey studio ground (Org Chart) does not read as a lighter rectangle,
3. cap the plate at `PLATE_MAX_W` of the canvas so every row's art starts at the same x,
4. right-align it on an obsidian canvas at the role aspect, `PLATE_H_FRAC` 0.92 tall so a wider
   card crops obsidian rather than artwork,
5. feather all four edges (`PLATE_FEATHER`, long on the LEFT — that edge points into the copy
   field) so the plate melts into the card instead of showing a seam.

Every plate renders through `ImageryBackdrop variant="art"` (0.85 obsidian at the left, clear at
the right) — the copy field is real obsidian, so contrast is the flat-card baseline.

**Surfaces wired:**

| Surface                         | Cards                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentDashboardScreen` nav rows | Missions / Job Assigned, Job Portal, Compliance, CPO Roster, Org Chart, Departmental, Bravo Feed, Region, Earnings, Manager Permissions |
| `DepartmentalHomeScreen`        | Secure-connection row + Attendance, Report incident, Channels, Vault, Approvals quick-action cards                                      |
| `WorkspaceHubScreen`            | "No workspaces yet" empty card (hero)                                                                                                   |
| `VBGHomeScreen`                 | Live Location card, Security Risk + Nearby mini cards, Contact Emergency Services / Phone Next of Kin / Request Support tiles           |
| `VBGGeoRiskScreen`              | Search Location card                                                                                                                    |
| `NewsFeedScreen`                | "No news yet" placeholder                                                                                                               |

`_obsidian.Card` and `vbgUi.VbgCard` each learned optional `img` / `imgVariant` (rendered UNDER
the edge-light and rail, decorative-only) — additive, every existing caller unaffected.
`s.action` (deptchat) and `actionTile` (VBG) gained `overflow: 'hidden'` to clip the
absoluteFill backdrop.

**Gates:** full app project 234 suites / 3227 green; tsc 46 = baseline; changed-file eslint 0
errors. New pin `imageryRegistry` → "plated roles are emitted at their card aspect", mutation-
proved RED by setting `PLATE_ROLES = ()` and regenerating (the art fell back to a ~2.1:1
smart-crop, exactly the regression it guards).

**Device pass 1 (v1.0.275) found the one real defect — variant, not asset.** The `art`
scrim is a HORIZONTAL ramp (obsidian at the left edge, clear at the right), so it only
protects copy that stays inside that left field. That holds for the PLATED rows (agent nav
rows, the departmental secure-connection row - both verified good on device) and fails
everywhere copy spans the full width: the departmental quick-action cards, the VBG
quick-action tiles, the VBG intel mini-cards, the VBG live-location card and the GeoRisk
search card all put their title/description tail on bare photo. Those nine sites moved to
`variant="card"`, whose scrim ramps along the bottom-left diagonal UNDER the copy with a
test-pinned 0.82 floor. The agent rows keep `art` and additionally bound their copy column
(`navCopyInset`) so a long single-line sub ellipsises before the plate.

> **Rule for the next drop:** `art` is for a PLATED asset whose card keeps its copy inside
> the obsidian field. A full-frame smart crop, or copy that spans the card, wants `card`.

Also: `sectionHeader` in `_obsidian` carries a `marginBottom` but no `marginTop`, so
"NEEDS ATTENTION" / "QUICK ACTIONS" sat flush under the card above. Fixed with a scoped
`sectionGap` on DepartmentalHome rather than the shared style - ~10 other deptchat screens
already hand-roll their own spacer View and a global margin would double up.

**Device verify OWED:** the corrected screens on a phone — the art is only approximated here by a
PIL mock of the `art` scrim, and B-703 was precisely a case where imagery rendered fine in tests
and wrong on device.

## 2026-08-31 — R8 keep rules restored + `proguard-rules.pro` now TRACKED

`gradlew assembleRelease` died in `minifyReleaseWithR8` on the Stripe push-provisioning
classes. Cause: `android/app/proguard-rules.pro` was back to the stock Android template, so
B-685's `-dontobfuscate` + RN keeps + Stripe `-dontwarn` block were gone. `android/` is
gitignored and — unlike `build.gradle`, `AndroidManifest.xml`, `google-services.json` and the
Kotlin sources — that file had never been `git add -f`'d, so a regenerated `android/` folder
wiped the R8 config with no way to recover it from git.

Restored (the `-dontwarn` lines taken verbatim from R8's own
`app/build/outputs/mapping/release/missing_rules.txt`) and **force-added**, so it now follows
the same convention as every other native file the build depends on. `keep.xml` was fine —
that half of B-685 is build-generated, not hand-written.

> **Trap worth naming:** the first failure reported `exit code 0` because the Gradle run was
> piped through `tail`. Same exit-masking class as the `git push | tail` rule. Capture Gradle
> to a log file and read `$?` from gradle itself.

## 2026-08-31 — Cold-start security-check intro (client request)

Client (Corne Breytenbach, via founder): the encryption loading screen "was very nice, could
you add that back... make that a thing that runs for 1.5 seconds as a type of display." The
founder pushed back — "it will be annoying when someone rapidly use the app" — and the client
scoped it themselves:

> "When you close App completely on phone and Open again it should show as like part of the
> security check display (like an intro almost). If the App is open, but just minimised on the
> phone in background, it must not load."

`src/components/useColdStartIntro.ts` — **cold start is detected by MODULE STATE, not
AppState.** RN evaluates the module once per JS runtime: a killed-and-relaunched app gets a
fresh one (intro plays), a background→foreground resume keeps it alive (intro skipped). An
AppState listener CANNOT distinguish them — it sees the same `'active'` transition for both —
which is exactly the case the client asked us to exclude. The flag burns on MOUNT, not on
timer expiry, so a remount inside the window cannot replay it.

- 1.5 s is a display FLOOR, not a measurement (founder: "i will faking this"). It never
  shortens a genuinely slow boot — it only widens the existing `isLoading` condition.
- The four `COLD_START_STEPS` name work a cold boot GENUINELY does (SQLCipher open, identity
  keys, secure channel, session restore) and read correctly signed-out too, unlike
  VERIFY_STEPS' "Validating credentials" — the intro also plays on a cold open to sign-in.
  Deliberately nothing like "integrity attestation", which we do not perform.
- `LoadingView` gained a `stepMs` prop (default 850 unchanged). At 850 ms only two of the four
  checks would ever appear inside 1.5 s.
- The intro overlay CAPTURES touches (`pointerEvents` 'auto' vs the loader's 'none') — it is
  opaque, so a pass-through tap would land blind on the screen underneath, the B-664..B-679
  rapid-use shape.

Gates: `coldStartIntro` 6 pins; the `loadingScreenIdentity` scan updated (its exact-string
match went stale) and STRENGTHENED with a wiring pin, mutation-proved RED by deleting the
`|| coldIntro` term — without it every hook test stays green while the feature silently
vanishes on a fast boot, which is how it disappeared the first time. tsc 46 = baseline; app
project 3287/3295 (the rest is the B-126 moving flake: three sweeps, three DIFFERENT suites,
every failure a 60 s hook timeout under worker saturation, all green in isolation).

**Device verify OWED:** force-close→reopen shows it; home→reopen shows NOTHING; sign-out/in
still uses the old "Verifying session…" path.
