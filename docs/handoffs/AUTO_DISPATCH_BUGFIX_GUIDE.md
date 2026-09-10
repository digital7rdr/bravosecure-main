# Auto-Dispatch — A-to-Z Bug-Fix Guide (hand-off)

> **For:** an engineer / Claude session that will execute the fixes.
> **Verified against:** branch `feat/auto-dispatch` (= `main`), live Supabase `qkkfkicgoncxslbwhyhz`,
> and the staging Contabo box (`ssh admin@94.136.184.52 -i ~/.ssh/bravo-secure/bravo-staging.pem`),
> 2026-06-23. Every load-bearing claim has a `file:line`. Follow the order in §2.
>
> **Scope:** 6 reported bugs. **They are one causal chain:** Bug 1 + Bug 3 are the gate — until the
> client calls `POST /dispatch/request` (Bug 1) _and_ a real agency is rankable (Bug 3), nothing
> downstream (Bug 5+6) can run. Bug 2 (maps) and Bug 4 (refund/purge) are **fully independent** and
> can ship in parallel.

---

## 0. The big picture (read this first)

```
CLIENT books ──(Bug 1: client uses legacy POST /bookings, never POST /dispatch/request)──► dispatch never starts
                                                                                              │
AGENCY eligible? ──(Bug 3: region_code + DPA have NO UI)── + (mocked GPS) ──► is_eligible/ranker = nobody
                                                                                              │
                                                                                              ▼
                                                              no dispatch_offers ──► agency gets no pop-up
                                                                                              │
                                              (Bug 5+6: built correctly, but starved — assigned_provider_user_id stays NULL)
                                                                                              ▼
                                                              OrgMissions board empty · CPO app never lights up

Independent:  Bug 2 (Mapbox token never baked into build)   Bug 4 (ON CONFLICT ON CONSTRAINT vs partial index + enum cast)
```

**The single most important finding:** every "missing constraint / missing column / no eligible agency"
symptom is a **code/UI/build problem, NOT a missing migration.** The live Supabase schema is correct and
is the source of truth — the _code's assumptions_ and the _build env_ drifted from it. **Do not write
`ADD COLUMN` / `ADD CONSTRAINT` migrations** (see §9 risk 1).

---

## 1. Bug → root-cause → category (one-line each)

| #       | Symptom                                                              | Root cause                                                                                                                                                                                             | Category                        | Migration? |
| ------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ---------- |
| **1**   | Client books but request never reaches agencies                      | Client picks legacy `POST /bookings` because the auto/legacy switch is a **build-time** constant `AUTO_DISPATCH` (`src/utils/constants.ts:24`) that baked to `false`                                   | Code+wiring                     | **No**     |
| **2**   | App place-picker/search "stuck"; ops map shows "NO TOKEN" grid       | `EXPO_PUBLIC_MAPBOX_TOKEN` never baked into local APK builds; ops-console image is stale (token not in `.next`)                                                                                        | Build/config + stale deploy     | **No**     |
| **3**   | Agency can't become eligible from the UI                             | `agents.region_code` + `agents.dpa_accepted_at` have **no write path** anywhere in the app — DB-only today                                                                                             | Missing endpoint + UI           | **No**     |
| **4**   | Cancel → no refund; purge errors every 5 min                         | `ON CONFLICT ON CONSTRAINT ux_*` against **partial indexes** (impossible) at 6 wallet sites; `lite_booking_status` enum compared to text w/o cast                                                      | Code bug (×2)                   | **No**     |
| **5+6** | SP "Job Assign" disabled; no missions list; CPO app doesn't light up | Chain is **built correctly but starved** — `assigned_provider_user_id` is NULL everywhere (only the offer-accept path writes it, which never runs). Plus a real dashboard-UX bug for company accounts. | Blocked by Bug 1+3 (+ 1 UX fix) | **No**     |

---

## 2. Master fix order (execute in this sequence)

**Independent, ship immediately (low-risk, high-value):**

- **Bug 4** — §6 (B3+B4+B5+B6): the `ON CONFLICT` fixes + enum cast. Backend only.
- **Bug 2 basemap** — §4 (E1 mobile token, D1 ops rebuild). Config + rebuild only.

**The dispatch-enablement bundle (ship together — neither works alone):**

- **Bug 1** — §3 (B1 backend `/auth/me` field; C1+C2 mobile store + consume).
- **Bug 3** — §5 (B2 backend `agency-profile` endpoint; C3+C4 mobile API + OrgCompliance card).

**After the bundle lands:**

- Use the **A4 one-off seed** (§7) to smoke the whole chain today.
- **Bug 5+6** — §7 (C5 dashboard UX fix is the only mobile code change; the rest is verification).

**Polish (independent, do later):**

- Bug 2C ops-console place-search + locate-me UI (§4).
- B7/D3 NO_PROVIDER diagnostics + deploy the already-built Dispatch Inspector (§7, §8).

**Critical-path smoke = B1 → C1 → C2 → (B2+C3+C4 or A4 seed) → E2 → E3.**

---

## 3. BUG 1 — Booking never reaches agencies (client stuck on legacy path)

### Root cause (verified)

- The auto-vs-legacy decision is **one build-time constant**: `src/utils/constants.ts:24`
  `export const AUTO_DISPATCH = process.env.EXPO_PUBLIC_AUTO_DISPATCH === 'true';`. Expo inlines
  `EXPO_PUBLIC_*` at **Metro bundle time** only; if the var isn't in the shell _at the bundle step_,
  it bakes `false`. `gradlew assembleRelease` does **not** forward an arbitrary shell env var into the
  JS bundle unless it's in a loaded `.env` — which is exactly why the v1.0.58 APK "built with the flag"
  still went legacy.
- It is the sole switch: `src/store/bookingStore.ts:231-233` —
  `AUTO_DISPATCH ? bookingApi.requestAuto(...) /* POST /dispatch/request */ : bookingApi.create(...) /* POST /bookings, dispatch_mode=NULL */`.
  It also gates consent/affordability (`bookingStore.ts:200,216`) and the consent UI + CTA label
  (`CustomizeAddOnsScreen.tsx:137,296,342`).
- **The server auto path is correct** — `client-dispatch.controller.ts:47-81` (`POST /dispatch/request`)
  checks the killswitch (`:56`), creates `dispatch_mode='auto'` (`booking.service.ts:318`), and for "now"
  calls `dispatch.start()` (`:69`). That's the identical `start()` the ops-console test button hits, which
  is why dispatch fires there. The only gap is the client never calls it.

### Fix — make the flag server-driven on `GET /auth/me` (recommended over fixing the bake)

This removes rebuild fragility _and_ keeps the client consistent with the server killswitch.

**B1 — Backend** (`apps/auth-service/src/auth/auth.service.ts`, `getMe` ~line 397):

> `AuthService` **already injects** `this.redis` (RedisService) and `this.config` (ConfigService)
> (`auth.service.ts:47,52`). **Do NOT import `OpsModule`** — `OpsModule` already imports `AuthModule`
> (`ops.module.ts:34`); that's a cycle.

```ts
async getMe(userId: string) {
  const user = await this.db.qOne<UserRow>(/* ...existing... */);
  if (!user) throw new NotFoundException('user_not_found');
  const accountKind = await resolveAccountKind(this.db, userId);
  const auto_dispatch_enabled = await this.resolveAutoDispatchEnabled();   // NEW
  return {user, ...accountKind, auto_dispatch_enabled};                    // NEW field
}

// Mirror DispatchKillswitchService (env AND redis!=='false') WITHOUT importing OpsModule.
private async resolveAutoDispatchEnabled(): Promise<boolean> {
  const envOn = this.config.get<boolean>('featureFlags.autoDispatch') ?? false; // configuration.ts:92
  if (!envOn) return false;
  try {
    const v = await this.redis.client.get('dispatch:enabled');  // same API as dispatch-killswitch.service.ts:46
    return v !== 'false';
  } catch {
    return envOn; // fail-open to env gate; never crash /auth/me
  }
}
```

_(Alternative, cleaner but larger: extract a standalone `KillswitchModule` (deps: Redis+Config only) and
import it in both `AuthModule` and `OpsModule` — matches the existing `DispatchRoomIntentsModule`
extraction. Inline is the smaller diff; either is fine.)_

**C1 — Mobile: thread the field into the auth store (reactive).**

- `src/services/api.ts:254-265` (`authApi.me`) — add `auto_dispatch_enabled?: boolean` to the response type.
- `src/store/authStore.ts:69-92` (`toUser`) — thread the field through; update all four `authApi.me()`
  consumers (`authStore.ts:187,291,334,584`). Add `auto_dispatch_enabled?: boolean` to `User`
  (`src/types/index.ts`). Default **`false`** (fail-closed to legacy).

**C2 — Mobile: consume the store value, not the constant.**

- `src/store/bookingStore.ts` — drop `import {AUTO_DISPATCH}` (`:5`); in `confirmBooking` read
  `const autoDispatch = useAuthStore.getState().user?.auto_dispatch_enabled === true;` and use it at
  `:200, :216, :231`.
- `src/screens/booking/CustomizeAddOnsScreen.tsx:26,137` — replace the constant with
  `const autoDispatch = useAuthStore(s => s.user?.auto_dispatch_enabled === true);` so the consent UI +
  CTA (`:296,:342`) react live.
- `src/utils/constants.ts:24` — keep as a boot default (or delete). Cleanest: store defaults `false`
  until `/auth/me` resolves.

### Migration: **None.**

### Verify

1. auth-service test: `getMe` returns `auto_dispatch_enabled` per the env+redis matrix (mirror
   `dispatch-killswitch.service.spec.ts`). `cd apps/auth-service && npm test`.
2. Mobile `npm run typecheck` ≤ baseline 49; `npm run lint`.
3. Live: set `AUTO_DISPATCH_ENABLED=true` + Redis `dispatch:enabled`≠`'false'`, restart auth →
   `curl -H "Authorization: Bearer <client JWT>" https://auth.94-136-184-52.sslip.io/auth/me` shows
   `"auto_dispatch_enabled": true`. Client CTA reads **"Find an agency"** (not "Submit for Ops Review").
4. DB: newest booking has `dispatch_mode='auto'`, status `DISPATCHING`/`CONFIRMED`/`NO_PROVIDER`, and
   `SELECT * FROM dispatch_offers WHERE booking_id='<id>'` has ≥1 row.
5. Negative: flip killswitch OFF → `/auth/me` returns `false` → next booking goes legacy, **no**
   `auto_dispatch_disabled` 400.

### Gotchas

- Fail **closed to legacy** on any `/auth/me` error, missing field, or Redis failure. Never default auto.
- Keep the server killswitch check at `client-dispatch.controller.ts:56` — the client flag is a UX mirror,
  not a replacement.
- Don't route auto bookings through `POST /bookings` (never sets `autoDispatch` → silently legacy).
- A mid-session flag flip only takes effect on the next `/auth/me` (re-login or foreground). Acceptable.

---

## 4. BUG 2 — Maps (place select + search + current location) broken

The Mapbox token itself is **valid** (server-side curl to styles/suggest/geocode all returned 200). The
problem on both surfaces is the token **not reaching the built artifact**.

### 2A — MOBILE: token never baked into the APK (PRIMARY — this is the "stuck map")

**Root cause:** `src/screens/booking/LocationPickerScreen.tsx:35`
`const MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';` → passed to the WebView
(`bravoLocationPickerMapHtml.ts:118` `mapboxgl.accessToken`), search (`LocationPickerScreen.tsx:127,170`),
reverse-geocode (`bravoLocationPickerMapHtml.ts:200`). The token lives **only** in `eas.json:30`
(`preview-staging`); it is **absent** from `package.json:14-16` (`apk:staging`/`apk:local`/`apk:dist`),
`.env.staging.local`, and `.env.production`. So a locally-built APK ships `MAPBOX_TOKEN=''` → black
basemap ("stuck"), `/suggest` 401 (no search results), reverse-geocode 401. **Same bug blanks every
Mapbox WebView screen** (VBGGeoRisk, LiveTracking, AgentLiveTracker, BravoBookingMap, etc.).

**E1 — Fix (config only):** add `EXPO_PUBLIC_MAPBOX_TOKEN=pk.<mapbox-public-token>`
to **each** `cross-env`/`cross-env-shell` line in `package.json:14-16` (alongside the existing
`EXPO_PUBLIC_*`), AND to `.env.staging.local` + `.env.production`, AND the committed templates
`.env.staging.local.example` + `.env.example`. Do **both** (the `apk:*` scripts use `cross-env`, not dotenv).
Then **rebuild the APK** (`npm run apk:staging`) — `EXPO_PUBLIC_*` is build-time inlined; restarting an
existing build does nothing.

- _Optional hardening:_ in `bravoLocationPickerMapHtml.ts` after `mapboxgl.accessToken=…`, if the token is
  empty `postMessage({type:'no-token'})` → show a themed "Map unavailable — missing configuration" banner
  in `LocationPickerScreen.tsx` `onMessage` (~:254). Turns a silent black map into a diagnosable error.
- **Verify:** after rebuild, grep the JS bundle for `cmo8akers0d322psaioxmfd9t` (should be present); on
  device the picker shows a real dark basemap, search returns suggestions, crosshair FAB locates you.
- **Don't** move the token out of `EXPO_PUBLIC_` (non-prefixed vars are stripped from the client bundle).
  The `pk.` token is public by design (already in `eas.json`); keep it URL-restricted in the Mapbox dashboard.

### 2B — OPS-CONSOLE: deployed image has no token baked in (rebuild required)

**Root cause:** `BravoMap.tsx:103` `const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';`; empty →
the "MAPBOX · NO TOKEN — fallback grid" placeholder (`:152,:408-447`). Wiring is correct
(`Dockerfile:56,62` ARG→ENV→`npm run build`; compose passes the arg; CSP allows Mapbox at
`middleware.ts:49,85-99`) — **but the running image has no token** (verified: `grep -rl cmo8akers… /app/.next`
= no match). It was built before the arg took effect.

**D1 — Fix (no source change — rebuild from `~/bravo`):**

```bash
ssh -i ~/.ssh/bravo-secure/bravo-staging.pem admin@94.136.184.52
cd ~/bravo
docker compose -f docker-compose.staging.yml build --no-cache ops-console
docker compose -f docker-compose.staging.yml up -d ops-console
```

`--no-cache` matters (else the cached `RUN npm run build` layer keeps the empty token).

- **Verify:** `docker exec bravo-staging-ops grep -rl cmo8akers0d322psaioxmfd9t /app/apps/ops-console/.next`
  now matches; the browser shows a real basemap (not the grid); Network shows `api.mapbox.com` 200s.
- **Gotcha:** `NEXT_PUBLIC_*` is build-time inlined — it will _never_ appear in `docker exec … env`; that's
  expected, not misconfig. Confirm **which compose drives the container** — two exist (`~/bravo` and `~/mb`).
  Don't relax the CSP (keep `worker-src 'self' blob:` at `middleware.ts:95`).

### 2C — OPS-CONSOLE: place-search + "use current location" do not exist (net-new, do AFTER 2B)

`BravoMap` is display-only (center/markers/route props); there is no search box / locate-me, and
`middleware.ts:112` sets `Permissions-Policy: geolocation=()` (disables browser geolocation).
**Fix (feature work):** (1) `middleware.ts:112` → `geolocation=(self)`; (2) add `@mapbox/mapbox-gl-geocoder`

- `mapboxgl.GeolocateControl` to `BravoMap.tsx` behind optional props (`enableSearch`/`enableLocate`/`onPick`)
  so existing read-only consumers are unchanged; add the dep to `apps/ops-console/package.json`. Confirm the
  **target page** with product first — no current consumer is a location-entry form, so 2C may be deferrable.
  (CSP already allows `api.mapbox.com` for the geocoder XHR; only the Permissions-Policy needs the edit.)

---

## 5. BUG 3 — region_code + DPA have no UI (wire into agency onboarding)

### Root cause (verified)

Two eligibility inputs are **never written by any app code** — DB-only, set by hand-seeding:
| Input | Read at | Written at |
|---|---|---|
| `agents.region_code` | ranker `dispatch.service.ts:106` (`AND a.region_code = $3`), SLO `dispatch-slo.service.ts:103` | **nowhere** |
| `agents.dpa_accepted_at` | eligibility fn `20260622100000_privacy_consent.sql:41` (`a.dpa_accepted_at IS NOT NULL`) | **nowhere** (only test fixture) |
Licence+insurance per region are **already** covered by `OrgComplianceScreen` → `POST /compliance` →
`ComplianceService.submit` (`compliance.service.ts:40-78`). All three columns exist + nullable on Supabase.
**No migration.**

### Design decision — put both on `OrgComplianceScreen` (not the onboarding wizard)

It's already the agency's "get dispatch-eligible" surface (empty state says so, `OrgComplianceScreen.tsx:141`),
already has a region picker (`REGIONS = ['AE','SA','BD','GB']`, `:30,:114-121`), and is re-visitable
post-approval (dashboard Compliance card, `AgentDashboardScreen.tsx:439`). The Coverage screen is **wrong**
(it writes `agent_profiles.coverage` JSON, unrelated to the scalar `agents.region_code`).
→ Add a new **"Operating region & data agreement"** card at the top of `OrgComplianceScreen`.

### Changes

**B2 — Backend.** New `SetAgencyProfileDto` (`agents/dto/agent.dto.ts` ~:114; add `MaxLength` to imports):

```ts
export class SetAgencyProfileDto {
  @IsString() @Length(2, 8) region_code!: string;
  @IsBoolean() dpa_accepted!: boolean;
  @IsOptional() @IsString() @MaxLength(32) dpa_version?: string;
}
```

New `AgentService.setAgencyProfile` (next to `setDuty`):

```ts
async setAgencyProfile(userId: string, dto: {region_code: string; dpa_accepted: boolean; dpa_version?: string}) {
  const agent = await this.requireAgent(userId);
  if (agent.type !== 'company') throw new BadRequestException('agency_profile_is_company_only');
  const region = dto.region_code.trim().toUpperCase();
  const SUPPORTED = ['AE','GB','ZA','US','SA','BD'];           // reconcile to ONE canonical set (see gotcha)
  if (!SUPPORTED.includes(region)) throw new BadRequestException('unsupported_region');
  const row = await this.db.qOne<{region_code: string; dpa_accepted_at: Date | null}>(
    `UPDATE public.agents
        SET region_code    = $2,
            dpa_accepted_at = CASE WHEN $3 THEN COALESCE(dpa_accepted_at, NOW()) ELSE dpa_accepted_at END,
            dpa_version     = CASE WHEN $3 THEN $4 ELSE dpa_version END,
            updated_at      = NOW()
      WHERE user_id = $1
      RETURNING region_code, dpa_accepted_at`,
    [userId, region, dto.dpa_accepted === true, dto.dpa_version ?? 'v1']);
  if (!row) throw new NotFoundException('agent_not_found');
  await this.audit(userId, agent.status, agent.status, userId, 'AGENT',
    {reason: 'agency_profile_set', region_code: region, dpa: dto.dpa_accepted === true});
  return {region_code: row.region_code, dpa_accepted_at: row.dpa_accepted_at?.toISOString() ?? null};
}
```

New route (`agent.controller.ts` ~:157, under the existing `@Controller('agents') @UseGuards(JwtAuthGuard)`):

```ts
@Patch('me/agency-profile')
setAgencyProfile(@Body() dto: SetAgencyProfileDto, @CurrentUser() user: AccessClaims) {
  return this.agents.setAgencyProfile(user.sub, dto);
}
```

Optionally surface `region_code`/`dpa_accepted_at` on `GET /agents/me` (add to `AgentRow` `agent.service.ts:49`
— **verify `requireAgent` uses `SELECT *`**; if it selects explicit columns, add the two there).

**C3 — Mobile API** (`src/services/api.ts` ~:607, in `agentApi`):

```ts
setAgencyProfile: (dto: {region_code: string; dpa_accepted: boolean; dpa_version?: string}) =>
  authHttp.patch<{region_code: string; dpa_accepted_at: string | null}>('/agents/me/agency-profile', dto),
```

Extend the `getMe` agent type with `region_code?`/`dpa_accepted_at?`.

**C4 — Mobile UI** (`src/screens/agent/OrgComplianceScreen.tsx`, new card above `:104`): region chips bound to
a new `operatingRegion` state + a DPA checkbox + a "Save region & agreement" button calling
`agentApi.setAgencyProfile(...)`; hydrate both from `agentApi.getMe()` on mount. **Drive the document-submit
region from the same `operatingRegion`** so the licence region can't diverge from `agents.region_code`
(full JSX sketch is in the investigation; reuse the screen's `D` theme + `s` styles + the existing
`Icon`/chip pattern).

### Migration: **None.** (Columns exist; do not re-CREATE the locked `is_eligible_for_dispatch` fn.)

### Verify

- Unit: `setAgencyProfile` upper-cases region, stamps DPA only on literal `true`, COALESCE keeps first-accept
  time, rejects unsupported region + non-company agent.
- Live: agency sets region=BD + accepts DPA + submits BD licence/insurance → admin verifies → on-duty with a
  **real** (non-mocked) fresh BD location → `SELECT region_code,dpa_accepted_at FROM agents WHERE user_id=…`
  both non-null → a BD dispatch creates a `dispatch_offers` row for it (replaces the `bindawanamir` DB hack).

### Gotchas

- **Region invariant (critical):** `agents.region_code` (ranker) and `compliance_credentials.region_code`
  (eligibility) must be the **same code** for the same agency, or it passes the ranker but fails eligibility →
  silent NO_PROVIDER. Drive both from one selection.
- **Reconcile the 3 REGIONS lists** — they disagree today: `constants.ts SUPPORTED_REGIONS = ['AE','GB','ZA','US']`
  vs `OrgComplianceScreen.REGIONS = ['AE','SA','BD','GB']` vs the backend allow-list. Pick one canonical set.
- DPA fail-closed (only `=== true`); `COALESCE` so re-save doesn't reset the legal timestamp; company-only;
  no side-effects (must not auto-flip `on_duty`).
- `org_members.account_consent_at` exists but is **not** read by eligibility — out of scope; optional
  follow-up to stamp in `OrgCpoService.createManagedCpo`.

---

## 6. BUG 4 — Cancel refund fails + DB "drift" (both are CODE bugs, no migration)

### 4A — `ON CONFLICT ON CONSTRAINT` against a PARTIAL index (6 sites)

**Root cause:** `ux_wallet_tx_booking_refund` + `ux_wallet_tx_payout` exist in the live DB **only as
partial unique indexes** (verified: zero `pg_constraint` rows). A partial unique index has no backing
constraint, so `ON CONFLICT ON CONSTRAINT <name>` throws `42704 constraint "…" does not exist` every time —
that's the `refund failed on cancel` log. The migrations (`20260515000000_payout_idempotency`,
`20260529000000_refund_idempotency`) **are applied** — they just create _indexes_. So it's code drift, not
a missing migration. **Cancel still flips `status='CANCELLED'` (`booking.service.ts:606`) but the money is
never refunded** (`booking.service.ts:637-640` catches + logs).

**B3 — Fix all 6 sites** in `apps/auth-service/src/wallet/wallet.service.ts` — replace
`ON CONFLICT ON CONSTRAINT <name> DO NOTHING` with the index-inference form whose `WHERE` **exactly matches**
the index predicate (confirmed via `EXPLAIN` to bind the right arbiter index):

| Line    | Method                         | Replace with                                                                                                                         |
| ------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **402** | `refundForBooking`             | `ON CONFLICT (user_id, booking_id) WHERE type='refund' AND booking_id IS NOT NULL AND metadata->>'kind'='booking_refund' DO NOTHING` |
| **331** | `creditForBooking`             | `ON CONFLICT (user_id, booking_id) WHERE type='payout' AND booking_id IS NOT NULL DO NOTHING [RETURNING id]`                         |
| **612** | `releaseEscrowHold` (provider) | same payout form                                                                                                                     |
| **632** | `releaseEscrowHold` (fee)      | same payout form                                                                                                                     |
| **716** | `settleEscrowSplit` (provider) | same payout form                                                                                                                     |
| **754** | `settleEscrowSplit` (fee)      | same payout form                                                                                                                     |

Keep each site's existing trailing `RETURNING id`. **Do NOT** add a non-partial `ADD CONSTRAINT` (Postgres
forbids partial predicates on table constraints, and it would change idempotency behavior).

**B4 — Update the pinning spec** `wallet.service.spec.ts:382` (it asserts the **old broken** SQL today) to
assert the inference form; write the test change **first** so it fails on the old SQL (CLAUDE.md rule 5).

### 4B — Privacy-purge: enum compared to text (1 line)

**Root cause:** `dispatch-privacy-purge.service.ts:99` `AND b.status = ANY($1::text[])` — `lite_bookings.status`
is the `lite_booking_status` enum → `42883 operator does not exist: lite_booking_status = text` every 5 min;
the telemetry-retention purge silently never runs.
**B5 — Fix:** `AND b.status::text = ANY($1::text[])` (cast the column). **B6:** assert the cast in
`dispatch-privacy-purge.service.spec.ts`.

### Migration: **None** (both objects/columns exist; the bug is the code's `ON CONFLICT` form + a missing cast).

### Verify

- Bug 4A: cancel a paid **legacy** booking → no `refund failed on cancel` log; a `type='refund',
metadata->>'kind'='booking_refund'` row appears; wallet balance increments; re-cancel is a no-op (idempotent).
  `SELECT type,amount_credits,metadata->>'kind' FROM wallet_transactions WHERE booking_id=$BK ORDER BY created_at;`
- Bug 4B: tail `bravo-staging-auth` 5+ min → the purge error stops.
- `cd apps/auth-service && npm test` (wallet + purge specs).

### Gotchas

- Keep the `WHERE` predicate on the inference (without it, a _partial_ index won't match → `42P10`).
- Don't touch the `type='refund'` insert at `wallet.service.ts:736` (intentionally no `ON CONFLICT`; idempotent
  via the FOR-UPDATE status guard).
- Blast radius is exactly these 6 sites (grep confirmed `ON CONFLICT ON CONSTRAINT` appears nowhere else).

---

## 7. BUG 5+6 — Service-provider missions / assign-crew + CPO enablement

### Diagnosis: the chain is **built correctly, but starved** (verified link by link)

- **Only writer of `assigned_provider_user_id`** is the offer-accept path
  `dispatch.service.ts:1081-1088` (`UPDATE lite_bookings SET status='CONFIRMED', assigned_provider_user_id=$2 WHERE status='DISPATCHING'`).
  Grep confirms no other SET (only `arrival-noshow.service.ts:149` clears it).
- **`listMissions` filters on it** (`org-mission.service.ts:56-74` `WHERE b.assigned_provider_user_id=$1`).
  Live: every CONFIRMED/LIVE/COMPLETED booking has it **NULL** → board always empty → nothing to crew.
- **No offer ever fires** → no accept → it stays NULL. (Bug 1: client never calls `/dispatch/request`;
  Bug 3: no rankable agency.)
- **Once a mission exists, the CPO side works** — `assignCrew` (`org-mission.service.ts:96-274`) creates
  `missions`(DISPATCHED)+`mission_crew`(lead slot 0); CPO poll `getMyActiveMission` (`agent.service.ts:876-917`)
  returns it → `OnDutyHomeScreen.tsx:110-128` shows "YOUR MISSION" + the Mission tab populates. Nav + Ops-Room
  drain are correct (`AgentNavigator.tsx:168`, `AgentDashboardScreen.tsx:192,438`).

**⚠️ NEW critical finding:** the hand-seeded BD agency `bindawanamir` (`c700ccde…`) is eligible **but excluded
from ranking** because `agents.last_location_mocked = TRUE` and the ranker has `AND a.last_location_mocked = FALSE`
(`dispatch.service.ts:109`). The tester's agency device is using a **mock GPS** (emulator/mock-location). So
even the seeded agency yields NO_PROVIDER. This is anti-fraud working as designed.

### What to actually change here

**Issue 1 (board empty):** nothing in org-mission — it's **blocked by Bug 1+3**. Do **not** relax the
`assigned_provider_user_id` tenant filter, back-fill legacy bookings, or weaken the mocked-location filter
(each is a cross-tenant/IDOR or anti-fraud regression).

**C5 (the one real mobile fix here) — dashboard "Job Assigned" lock is wrong for company accounts.**
`AgentDashboardScreen.tsx:434-436` shows a permanently-**locked** "Job Assigned" card for orgs (an agency is
never itself crew), reading the meaningless "Assigned when ops places you on a mission." **Fix:** suppress that
row for `isOrg`; make **"Missions / N needs crew"** the prominent first row (badge sourced from
`orgApi.listMissions()` or by extending the existing company-only capacity poll — don't add a 2nd interval).
Keep the individual-CPO branch byte-for-byte (regression: `CpoNavigator` + the capability-hiding test
`src/navigation/__tests__/cpoCapability.test.ts:31` must stay green).

**Issue 3 (observability, ship with the inspector — §8):** add NO_PROVIDER exclusion-reason counters
(mocked / stale / cooldown / region / capacity) so "nothing shows" is debuggable. Don't weaken the filter.

**Issue 4 (data, not code):** managed CPOs are created `DOCS_PENDING` (`org-cpo.service.ts:131`) and
`assignCrew` rejects non-`ACTIVE`/`APPROVED` guards (`cpo_not_approved_for_deployment`,
`org-mission.service.ts:136-140`). A brand-new CPO can't be crewed until ops approves it. Document this
(runbook), or decide on self-serve auto-approval (separate scope).

### A4 — one-off seed to smoke the WHOLE chain TODAY (not a code change)

```sql
-- make the seeded BD agency rankable (clear the mock flag + refresh location time)
UPDATE agents SET last_location_mocked = FALSE, last_location_at = NOW()
 WHERE user_id = 'c700ccde-0e7a-4d4c-b644-076524be9b81';
-- then fire a BD auto request (ops-console test button → POST /ops/dispatch/test, or a BD client booking)
-- and ACCEPT on the bindawanamir device → booking CONFIRMED + assigned_provider_user_id set → OrgMissions populates.
```

**Gotcha:** re-stamp `last_location_at` if it ages past the freshness window before firing. This is a _seed_,
not a fix — but it lets a tester walk accept → OrgMissions "NEEDS CREW" → assign CPO + star a leader → the
CPO's `OnDutyHomeScreen` lights up, proving the UI side is genuinely done.

### Migration: **None.** **Key files:** `dispatch.service.ts:97-134,1081-1088`; `org-mission.service.ts:56-85,96-274`;

`agent.service.ts:876-917`; `src/screens/agent/AgentDashboardScreen.tsx:425-449` (the only change);
OrgMissions/CPO screens unchanged.

---

## 8. Already built, just not deployed — Dispatch Inspector

`apps/ops-console/src/app/dispatch-inspector/*` + `GET /ops/dispatch/requests[/:id]` are **committed to `main`
but not deployed** to the box. Deploying it (rebuild auth + ops images per §4 D1 + the auth flow) gives ops a
live view of every request, its offer cascade, and (with Issue 3) _why_ a dispatch went NO_PROVIDER — the
natural home for the mocked-location diagnostics. Spec: `docs/handoffs/DISPATCH_INSPECTOR_BUILD_SPEC.md`.

---

## 9. Cross-cutting risks (read before touching the DB)

1. **DB "drift" is a _kind_ mismatch — never write `ADD COLUMN`/`ADD CONSTRAINT`.** Symptoms are: a partial
   **index** the code wrongly calls a **constraint** (Bug 4A → fix the `ON CONFLICT` form), an **enum** vs
   **text** without a cast (Bug 4B → `::text`), or columns that **exist** with **no write path** (Bug 3 → build
   endpoint+UI). The live Supabase schema is the source of truth. A migration here risks re-CREATEing the
   locked `is_eligible_for_dispatch` gate or changing idempotency semantics.
2. **Build-flag fragility = same root for Bug 1 and Bug 2A** — an `EXPO_PUBLIC_*` constant that bakes at Metro
   time and silently defaults empty/false. Bug 1's server-driven fix _eliminates_ it for dispatch; adopt that
   pattern for future runtime flags.
3. **Agency eligibility is a conjunction** — region_code + matching region + verified licence + verified
   insurance (region-matched) + DPA + on_duty + fresh **non-mocked** location within range + capacity. Two have
   no UI (Bug 3); the seeded agency fails a third (mocked GPS). **Invariant:** `agents.region_code` and the
   licence `compliance_credentials.region_code` must match; reconcile the 3 REGIONS lists.
4. **Anti-fraud filter has zero observability** — add exclusion-reason diagnostics; do not weaken the filter.
5. **Don't relax tenant isolation** to "fix" the empty mission board — it's correct given NULL
   `assigned_provider_user_id`; it populates the moment a real offer is accepted.

---

## 10. Open decisions for the human (confirm before/while executing)

1. **Bug 1 flag:** server-driven `/auth/me` (recommended) vs fixing the gradle bake. Also: delete the
   `AUTO_DISPATCH` constant or keep as boot default?
2. **Bug 1 wiring:** inline killswitch read in `AuthService` (smaller) vs extract `KillswitchModule` (cleaner).
3. **Bug 3:** confirm `OrgComplianceScreen` placement + the **canonical region set** for all three lists.
4. **Bug 3:** stamp `org_members.account_consent_at` now (in `createManagedCpo`) or defer?
5. **Bug 2C:** which ops-console page gets the place-picker — or defer 2C (2B alone makes existing maps real)?
   Geocoder dep (Option A) vs mirror mobile's suggest→retrieve (Option B)?
6. **Bug 5+6 Issue 4:** document "ops must approve new CPOs before crewing", or build self-serve auto-approval?
7. **Pre-prod only:** finance sign-off on FX/fee placeholders + the 24 legacy-CPO `account_kind` backfill
   (not needed for a staging smoke).

---

## 11. End-to-end smoke (after the Bug 1 + Bug 3 bundle + Bug 2A rebuild)

1. Server: `AUTO_DISPATCH_ENABLED=true` + Redis `dispatch:enabled`≠`'false'`; restart auth. `curl /auth/me` →
   `auto_dispatch_enabled:true`.
2. Agency `bindawanamir` (or a fresh one via the Bug 3 UI): on-duty, **real GPS in Dhaka** (not mocked),
   region=BD + DPA accepted + verified BD licence+insurance, ≥1 ACTIVE CPO.
3. Client (rebuilt APK with map token + this code): book a **Dhaka/BD pickup within range**, tick consent →
   CTA reads "Find an agency" → "Finding your detail".
4. Agency device: offer pop-up within ~5 s → accept within 30 s → booking `CONFIRMED`,
   `assigned_provider_user_id` set.
5. Agency: dashboard "Missions" → the booking shows **NEEDS CREW** → assign CPO + star a leader.
6. CPO device: `OnDutyHomeScreen` shows "YOUR MISSION"; Mission tab populated.
7. DB confirms: `dispatch_offers` row exists; `assigned_provider_user_id IS NOT NULL`; `mission_crew` rows.

---

## 12. Prompt to start the executing session

> Read `docs/handoffs/AUTO_DISPATCH_BUGFIX_GUIDE.md` end-to-end, then implement the fixes in the order in §2.
> Start with the independent, low-risk batch (Bug 4 §6 and Bug 2A/2B §4), running the gates after each
> (`cd apps/auth-service && npm test`; mobile `npm run typecheck` ≤ baseline 49 + `npm run lint`;
> `cd apps/ops-console && npm run typecheck && npm run lint && npm run build`). Then implement the Bug 1 §3 +
> Bug 3 §5 bundle together (they don't work apart). Then the Bug 5+6 §7 dashboard UX fix. For each bug:
> write/adjust the failing test first where one is specified, verify against the live Supabase schema before
> trusting any SQL, and **do not write `ADD COLUMN`/`ADD CONSTRAINT` migrations** — every DB-shaped symptom is a
> code/UI/build fix (§9 risk 1). Stop and ask me the §10 open decisions before committing the Bug 1 and Bug 3
> changes. Commit per bug area with clear messages; do not push until I confirm. After code lands, follow the
> §11 smoke. Confirm you've read the guide and list the exact files you'll touch for Bug 4 before you start.

---

## 13. Bug 7 — stale pickup pins the picker to the wrong country (found during device test, 2026-06-23) — FIXED

**Symptom (device, v1.0.58):** client selects **Bangladesh** on the zone screen (selects fine — BD shows
"4 CPOs online"), but the pickup **map opens on Dubai** and the address search returns no Bangladesh
results ("search Dhaka → nothing").

**Root cause (NOT availability — BD is available):** a pickup left over from an earlier UAE draft stays in
`bookingStore.draft.pickup`. `BookingDateTimeScreen.openPicker` (`src/screens/booking/BookingDateTimeScreen.tsx:172-176`)
passes that stale pickup as `initial` to the picker, and `LocationPickerScreen` (`src/screens/booking/LocationPickerScreen.tsx:49-55`)
**centres on `initial` and ignores `countryCode`** when `initial` is present. The map then sits on Dubai, the
centre reverse-geocodes to `ae`, and the Search Box query is scoped `country=ae` (`LocationPickerScreen.tsx:123`)
— so Dhaka POIs never appear. Switching the zone never cleared the old pickup. (Confirmed the Mapbox token
itself is fine: a direct Search Box call with `country=bd` returns Dhaka results.)

**Fix — two layers:**

1. `src/store/bookingStore.ts` `updateDraft`: when `zone_code` changes, null out `pickup` + `dropoff`.
   Test: `src/store/__tests__/bookingStore.zoneChange.test.ts`. (Shipped v1.0.59.)
2. **The real cure (v1.0.60):** `src/screens/booking/LocationPickerScreen.tsx` `initialCenter` now only
   honours the passed-in `initial` pin if it falls inside the SELECTED country's coverage zones
   (`distanceKm` ≤ a zone `radiusKm`); otherwise it centres on the chosen country's zone. This is the
   bulletproof catch — layer 1 only fires on a zone _change_, but the bug also reproduces when the zone is
   already BD and a Dubai pickup was set earlier (device-confirmed v1.0.59: Schedule kept "DIFC Gate
   Building 4, Dubai" and the picker stayed on Dubai). With layer 2, a BD booking's picker always opens on
   Dhaka regardless of any stale pickup, so address search scopes to `bd`.
   Gates: lint clean, tsc 49 = baseline (0 added), store tests green. Built into **v1.0.60 (vc84)**, installed
   to the device over ADB (NOT Firebase).

**Also observed — VERIFIED OK (not a blocker):** the Schedule screen shows _"Minimum 3-hour lead time …
earliest 16:35"_ even on **Book Now**. This is only the _pickup time_; dispatch still fires immediately.
`client-dispatch.controller.ts:64-69` branches purely on `booking_mode`: `'later'` stays DRAFT for
`ScheduledDispatchService`, anything else (`'now'`, set by the Book Now toggle → `bookingStore` `booking_mode:
draft.mode`) calls `dispatch.start()` right away. So Book Now triggers an immediate matchmaker run with a
3-h-out pickup — fine for the live test.
