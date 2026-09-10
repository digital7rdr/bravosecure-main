# Staging Test Overrides — auto-dispatch single-phone demo (2026-06-23)

> ⚠️ **TEMPORARY, TEST-ONLY.** These changes were applied to the Contabo staging box
> (`94.136.184.52`) + live Supabase so a single tester can exercise the full auto-dispatch
> flow on ONE phone while physically in Germany. **REVERT before any real/production use or
> cut-over.** Prod defaults are restored by the revert steps at the bottom.

Test accounts (one phone, switched by login):

- **Client** `piyaldeb87@gmail.com` — `3165d0e1-0d3f-4d8c-be5d-a4b85d11b453`
- **Agency** `bindawanamir@gmail.com` — `c700ccde-0e7a-4d4c-b644-076524be9b81` (company, region BD)
- **CPO** `bravoariful@gmail.com` — `9a7e0478-e402-4008-be10-eec907c992dc` (managed by the agency)

## What was changed

### 1. Live Supabase — agency seed (DATA)

```sql
UPDATE public.agents
SET last_location_mocked = false, last_location_at = NOW(), on_duty = true, updated_at = NOW()
WHERE user_id = 'c700ccde-0e7a-4d4c-b644-076524be9b81';
```

Why: the matchmaker `RANKING_SQL` excludes mocked + stale agency locations
(`apps/auth-service/src/dispatch/dispatch.service.ts:105,109`). The agency's stored point is
real Dhaka (23.832, 90.380) but was flagged `mocked=true` and 3 h stale.
Revert: not strictly required (a real non-mock heartbeat re-stamps it; staleness self-heals).
It only re-blocks if a _mock_-location heartbeat later arrives.

### 2. Box code — `apps/auth-service/src/dispatch/dispatch.service.ts` (NOT committed)

```diff
-const OFFER_TTL_SECONDS = 30;
+const OFFER_TTL_SECONDS = Number(process.env["DISPATCH_OFFER_TTL_SECONDS"] ?? "30");
```

Why: the offer TTL was the only un-tunable dispatch knob; one-phone testing needs a longer
window than 30 s to switch from the client account to the agency account. Default is unchanged
(30 s) when the env var is absent — so production behavior is identical.
Backup on box: `dispatch.service.ts.bak-testttl`.
**Proper fix (later):** port this env-override into committed source on `feat/auto-dispatch`
(it mirrors the existing `LOCATION_FRESH_MINUTES` / `DISPATCH_RADIUS_M` env pattern at
dispatch.service.ts:48-49), OR restore the `.bak` and rebuild.

### 3. Box compose — `docker-compose.staging.yml` auth block (ENV)

```yaml
DISPATCH_OFFER_TTL_SECONDS: '900' # 15-min offer window   (prod default 30 s)
DISPATCH_LOCATION_FRESH_MINUTES: '1440' # 24-h location freshness (prod default 5 min)
DISPATCH_RADIUS_M: '20000000' # ~global match radius   (prod default 50 km)
```

Backup on box: `docker-compose.staging.yml.bak-testoverrides`.
Why: 15-min window = leisurely one-phone account switching; 24-h freshness = agency location
won't expire mid-switch; wide radius = matching never depends on any device's physical GPS
(tester is in Germany, booking is in Dhaka).

## How to REVERT (before real use / cut-over)

On the box, in `~/bravo`:

```bash
cp apps/auth-service/src/dispatch/dispatch.service.ts.bak-testttl apps/auth-service/src/dispatch/dispatch.service.ts
cp docker-compose.staging.yml.bak-testoverrides docker-compose.staging.yml
docker compose -f docker-compose.staging.yml build auth-service
docker compose -f docker-compose.staging.yml up -d --no-build --force-recreate auth-service
```

(Removing only the 3 env lines + restart reverts #3 with no rebuild; #2 needs the file
restored + a rebuild.) This restores prod defaults: **30 s offer / 5 min freshness / 50 km radius.**

## ⚠️ The "agency keeps getting flagged mocked" trap (root cause — 2026-06-23)

The agency's `last_location_mocked` kept flipping back to `true` even with phone mock-location off.
**Root cause is NOT the device mock flag — it's the anti-spoof _plausibility_ check** in
`AgentService.updateLocation` (`agent.service.ts:1626-1640`): a fix that implies ground speed

> `MAX_PLAUSIBLE_KPH` (900 km/h) vs the _last_ fix is flagged `mocked` AND the location is **not
> advanced** (line 1642-1656), so it stays trapped. We seeded the agency at **Dhaka** but the test
> device is in **Germany** → every real heartbeat is a ~6,900 km Dhaka→Germany "teleport" (>900 km/h)
> → flagged. Re-seeding fresh-Dhaka _re-arms_ the trap each time.
> **Fix (data-only, no control disabled):** backdate the last fix so the real location reads as
> plausible — `UPDATE public.agents SET last_location_mocked=false, last_location_at = NOW() - INTERVAL
'10 hours' WHERE user_id='<agency>';` (900 km/h × 10h = 9,000 km > 6,900 km, and 10h < the 24h
> freshness window). The device's next heartbeat is then accepted and the agency settles at its real
> location; the global `DISPATCH_RADIUS_M` keeps it matching a Dhaka booking. **Better long-term test
> hygiene: seed the agency near where the test device actually is, not the booking city.**

## ⚠️ The "chronic-rejecter cooldown" benches the agency during testing (2026-06-23)

A second NO_PROVIDER cause that looks like "the agency is flagged": the Step-23 anti-fraud
**cooldown** (`dispatch.service.ts:63-68` — `COOLDOWN_MIN_SAMPLE=5`, `COOLDOWN_ACCEPT_FLOOR=0.2`,
`COOLDOWN_MINUTES=30`). Once the agency has _responded to ≥5 offers and accepted <20%_, the
ranking's `(cooldown_until IS NULL OR cooldown_until < NOW())` gate benches it for 30 min. Single-
phone testing trips this fast: you create many bookings but only accept one, so most offers expire
unaccepted → acceptance_rate drops below 0.2 → benched. Diagnose by running every ranking predicate
as a boolean against the latest booking (see this session's diagnostic query); `not_cooldown=false`
is the tell. **Fix (test cleanup):** `UPDATE public.agents SET cooldown_until=NULL, offers_received=0,
offers_accepted=0, offers_rejected=0, acceptance_rate=NULL WHERE user_id='<agency>';`. Resetting
offers_received below the 5-sample floor stops it re-arming on the next expired offer. **Test hygiene:
accept offers promptly, or reset between runs.**

Related: [`AUTO_DISPATCH_BUGFIX_GUIDE.md`](AUTO_DISPATCH_BUGFIX_GUIDE.md),
memory `auto-dispatch-staging-deploy`.
