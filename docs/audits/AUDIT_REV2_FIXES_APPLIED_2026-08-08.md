# Audit Rev2 — Fixes Applied (session 2026-08-08)

Companion to `AUDIT_REV2_STATUS_HANDOUT_2026-08-08.md` (the pre-fix audit) and
`AUDIT_REV2_FIX_PLAN_2026-08-05.md` (the corrected designs). This records what was
**implemented and verified this session**, following the plan's corrected designs (not the
PDF's originals, several of which were overturned). Every fix went through a **fixer →
critic → edge-case** review loop; the findings each round surfaced are folded in below.

## Verification method

- Each fix has a direct + regression test; the closest existing suite was re-run.
- `apps/auth-service` typecheck: **clean (exit 0)**. `apps/messenger-service` typecheck:
  clean except one **pre-existing** `helmet` module-not-found in `main.ts` (untouched).
- Mobile typecheck: **44 errors ≤ 47 baseline**, none in the files changed here.
- Two auth-service suites fail in isolation — `auth.service.account-kind.spec` and
  `org/workspace.spec` — but both are **pre-existing working-tree edits** to
  `account-kind.ts` / `workspace.service.ts` (Modified before this session, not touched
  here). Not regressions from this work.

---

## Status change

| #   | ID              | Before (handout)            | After this session                                                        |
| --- | --------------- | --------------------------- | ------------------------------------------------------------------------- |
| 5   | SP-01           | FIXED (dashboard) / partial | ✅ **FULL** — shared `useProPlanGate` on all 7 paywalled screens          |
| 12  | MED-01          | staging-only                | ✅ **CODE FIXED** — strict default + owner grant at upload                |
| 2   | API-01          | NOT FIXED                   | ✅ **WIRED (shadow mode)** — guard bound, per-dest SMS cap                |
| 7   | API-04          | NOT FIXED                   | ✅ **CORE FIXED** — orphan cancel + idempotency + interceptor             |
| 8   | API-06          | NOT FIXED                   | ✅ **FIXED** — convergent + `(event_id,handler)` dedupe                   |
| 9   | API-05          | NOT FIXED                   | ✅ **FIXED** — `fetchWithDeadline` on all non-news outbound               |
| —   | live top-up bug | still present               | ✅ **FIXED** — `payment_failed` non-terminal, no false credit             |
| 11  | CLI-01          | NOT FIXED                   | ⚠️ **SERVER DETECTION added**; client token move deferred (device-verify) |
| 4   | API-02          | NOT FIXED                   | ⛔ **NOT SHIPPED** — E2EE stop-condition, needs authority decision        |

Already-fixed before this session (unchanged): DB-01, SEC-01, SEC-02, CRY-01, QA-01(partial).

---

## G4 — money (API-06 + API-04 + the live top-up bug)

**Migration** `supabase/migrations/20260808120000_stripe_processed_events.sql` — a
`(event_id, handler)` dedupe ledger (RLS on + forced, matching DB-01).

**API-06** (`subscription.service.ts handleSubscriptionEvent`):

- Claim `(event.id,'subscription')` **and** the users UPDATE in **one** `withTransaction`
  — a redelivery no-ops; a crash between claim and grant rolls back both (never a lost
  grant). `rows.length`, not `rowCount` (which this DB layer doesn't expose).
- `invoice.paid` assigns **convergently** from Stripe's period end
  (`GREATEST(pro_active_until, to_timestamp($3))`), so duplicates / out-of-order become
  no-ops and an annual Price extends by a year.
- **Edge-case fixes from review:** preserves a NULL (permanent/comp, RS-17) grant instead
  of `COALESCE`-ing it to a finite expiry the sweep would downgrade; reads
  `subscription_details.metadata` so a swept-to-lite **enterprise** account isn't restored
  as `pro`; the +30d fallback is `GREATEST(…, NOW()+30d)` so it can't stack.
- 90-day retention sweep added to `ProLapseCron.tick()`.

**Live top-up bug** (`wallet.service.ts`): `payment_failed` is now **non-terminal** — the
settle guard and webhook SELECT accept `status IN ('pending','failed')`, so a
declined-then-retried PaymentIntent's success credits exactly once; `confirmIntent` returns
`credits_awarded: 0` for a failed/refunded row instead of falsely reporting the amount.

**API-04** (`stripe.client.ts`, `subscription.service.ts`, `wallet.controller.ts`):

- `post()` gains an optional `Idempotency-Key`; `createSubscription` forwards a business-op
  key.
- **Orphan fix:** `enableAutoRenew` cancels any existing `stripe_subscription_id` before
  creating the replacement — a same-tier re-subscribe no longer orphans a sub that billed
  the card forever.
- `/wallet/topup` gets `OptionalIdempotencyInterceptor` (replay when a client sends a key;
  pass-through otherwise — the strict variant would 400 every current client).
- **Review-driven hardening** (the money-path critic found these and each now has a
  RED-first regression test): (a) `enableAutoRenew` NULLs the sub link **immediately after
  cancel**, so a later `createSubscription` throw can't leave the row pointing at a cancelled
  sub (which also blocked the BC-renew fallback); (b) an **ambiguous** create failure
  (deadline / 5xx — Stripe may have created the sub but we lost the response) sets
  `pro_renew_status='reconcile_pending'` instead of silently returning `auto_renew:false`
  into an orphan (a 4xx decline created nothing → no flag); (c) the idempotency key is
  **per-attempt** (`Date.now()`) so it can't replay a 24h-cached decline — client double-taps
  are deduped at the HTTP layer instead; (d) the inline Stripe GET/DELETE fetches
  (`getPaymentIntent`, `cancelSubscription`, `get()`) now also carry the 10s deadline —
  `cancelSubscription` is on the orphan-fix hot path of every subscribe.
- **Deferred (documented):** the write-ahead top-up ledger reorder and the shared
  interceptor's in-flight reservation / body-in-key fixes — invasive, unverifiable on
  staging (Stripe keys unset), high blast radius across booking/dispatch. A
  `reconcile_pending` **reconciliation job** (list Stripe subs with no matching
  `users.stripe_subscription_id`) is still owed to consume the flag.

## G5 — API-05 outbound timeouts

New `apps/auth-service/src/common/http/fetchWithDeadline.ts` (`isDeadlineError` matches
**both** `AbortError` and `TimeoutError`; composes a caller budget via `AbortSignal.any`).
Applied to: `biometric.service` (replaced the raw `https.request` that had no timeout at
all — a slow-loris never settled), Mapbox directions/geocode, GDELT, and the Mapbox
`keyPoints` loop (one shared 12s budget so it can't sum to ~20s). Stripe `post()` carries a
10s deadline — landed **with** the idempotency work (a timeout without a key would convert
a hang into a double charge, per the plan's X2).

## G1.3 — MED-01 media downloads fail open

`configuration.ts` default is now **strict** (`… !== 'false'` — fails closed on any typo);
`createDownloadUrl` reads it via `ConfigService`. `createUploadUrl` now **stamps the owner
grant** (SADD + owner NX) before the PUT, which fixes the two traps the flip alone would
create: the uploader's post-PUT length probe (before `registerGrants`) and note-to-self.
Review also had me correct a now-false docstring (removed members retain access via the
on-download TTL refresh — no revoke path yet) and teach the test's fake Redis to honour NX.
**Ops prerequisite (flagged, not code):** strict mode assumes a durable grant registry — a
full Redis wipe 403s live media until the 30-day sweep. That's the audit's X1
(Redis-persistence) item; staging already runs strict, so this change adds no new staging
risk.

## G1.4 — SP-01 Pro paywall

New shared `src/hooks/useProPlanGate.ts` — loads the application on focus and
`StackActions.replace('SecureProStatus')` when the plan isn't ACTIVE, failing closed.
Mounted on all **7** paywalled screens (dashboard + the 6 side-door screens). The dashboard's
inline gate was removed (one gate, not nine). **Review caught a commit-blocker:** the move
broke `secureProGate.test.ts` (it scanned the dashboard for the redirect); it's re-pointed
at the hook and now also enforces the duplicate-copy rule — a source scan asserting every
paywalled screen mounts the gate, so a new Pro screen added without it fails CI.

## G2.1 — API-01 rate limiting

`GlobalHttpThrottlerGuard` (copy of messenger's, skips the 8 `UserThrottlerGuard`
controllers and non-HTTP) bound as `APP_GUARD`; default raised to `{ttl:60s, limit:120}`;
`@SkipThrottle()` on health + both Stripe webhooks; per-**destination** SMS cap in
`OtpService.send()` (covers register **and** login).

- **Shadow mode by default** (`THROTTLE_ENFORCE` unset → log-only): the plan's mandated
  first step. The critic confirmed the reason — the IP-keyed default would 429 authenticated
  pollers on shared NAT. So the guard is bound and limits are now _observed_, but not
  enforced until the ceilings are sized from the `[throttle-shadow]` logs.
- **Poller fix:** the safety-critical live-mission GPS (`TelemetryController`) is moved to
  per-user keying so an enforce-flip can't 429 a mission mid-stream. (Booking/keys/
  notifications/events should get the same before enforce — logged as the remaining step.)
- **OTP counter fails OPEN** on a Redis blip (a limiter must never 500 register/login).

## G6.2 — CLI-01 (partial: server detection)

`/auth/keys/upload` now emits a distinct **`auth.keys.identity_rotated`** audit event +
`[KEYDIAG]` warn on an identity-key rotation — the amplification that makes a stolen
15-minute access token dangerous (silent Signal-identity takeover) is now **detectable**
instead of buried in a generic success. A hard step-up gate is **not** shipped: legit
rotations (reinstall, the ~30-day identity regen) hit the same path, so blocking needs a
coordinated client step-up rollout + device verification. The client token move to Keychain
is likewise deferred — it is the largest client blast radius (a push on a locked device can
log everyone out via B-15b) and must be device-verified.

## API-02 — NOT SHIPPED (deliberate)

Group-call room-join authority is a **CLAUDE.md security stop-condition** (room tokens,
sealed-sender, group membership). The relay is E2EE and has **no roster**, so a sound gate
needs the authority-design decision the fix plan (§G1.2) flagged — the ring list alone is
unsound because `POST /sfu/rooms` lets any user claim host of any conversationId. A blind
partial gate would either lock out legitimate members or manufacture false confidence.
Requires the architecture decision **and** device verification before it ships.

---

## Remaining owed (unchanged from the plan)

- **X1** Redis persistence (gates MED-01/API-01/API-04 durability), **X3** migration-drift
  repair (gates CI + `db push`).
- API-04 write-ahead ledger + interceptor internals; API-01 enforce-flip after sizing +
  remaining poller keying; CLI-01 client token move + step-up gate; **API-02** authority decision.
- SEC-01 residual: add `JWT_ACTION_SECRET` to `infra/env/messenger.env.example`.

### Money-path convergence review — two accepted follow-ups (both rated NOT blockers)

The final convergence pass verified the `users` row is consistent in every outcome and no new
orphan/strand was introduced. Two open items remain, matching the plan's "owed" list:

1. **`reconcile_pending` has no consumer yet.** The ambiguous-failure flag is written but
   nothing acts on it. In the rare true-ambiguous case (5xx/timeout where Stripe _did_ create
   the sub) a live-but-unlinked sub keeps charging the card **and** the row is BC-auto-renewed
   — a double charge — until the reconciliation job (list Stripe subs with no matching
   `users.stripe_subscription_id`, then link or cancel) exists. **Strictly better than the
   pre-fix silent orphan** (the condition is now flagged), but the loop closes only with the cron.
2. **Concurrent keyless double-tap can create two subs.** The per-attempt idempotency key
   (which correctly kills the 24h decline-replay) means two _truly simultaneous_ taps from a
   build that sends no `Idempotency-Key` header each get a distinct key, so Stripe no longer
   dedupes them; the cancel-existing step only catches _sequential_ re-taps. Narrow (also
   gated by `@Throttle`), net still an improvement. Follow-up: a short per-user advisory lock
   around `enableAutoRenew`, or auto-generate a key in `OptionalIdempotencyInterceptor`.
3. **Product decision:** after a card decline the API returns `auto_renew:false` while
   `bc_auto_renew` stays `TRUE`, so the user is silently BC-renewed at period end. This is the
   documented "BC is the fallback" invariant, but the response and behavior diverge — confirm
   product wants the silent credit charge.
