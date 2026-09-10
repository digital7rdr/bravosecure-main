# BravoSecure Audit Rev2 — Fix Status Handout

**Audited:** 2026-08-08 · **Against:** `main` @ `9726523b` · **Source:** `BravoSecure_Audit_Rev2_Corrected_1.pdf` (13 findings, PDF commit `85ab04d` — not in our history)

> This is a **verification pass only** — no code was changed. Each item was re-checked against the
> live tree by reading the named file. Where an item is not fixed, a "How to fix" block is included
> for later work.
>
> One commit did the fixing so far: **`279b9ce3`** — _"fix(security): Audit Rev2 — DB-01, SEC-01,
> SEC-02, CRY-01, SP-01 + QA-01 partial"_ (2026-08-05). The design/critique for every item lives in
> [`docs/audits/AUDIT_REV2_FIX_PLAN_2026-08-05.md`](AUDIT_REV2_FIX_PLAN_2026-08-05.md).

---

## Summary table

| #   | ID     | Finding                        | Severity | Status                                                 | Evidence                                       |
| --- | ------ | ------------------------------ | -------- | ------------------------------------------------------ | ---------------------------------------------- |
| 1   | DB-01  | 7 tables have no RLS           | Critical | ✅ **FIXED**                                           | migration `20260805090816`                     |
| 2   | API-01 | Rate limits do nothing         | Critical | ❌ **NOT FIXED** (prereq done)                         | `app.module.ts` still has no `providers`       |
| 3   | SEC-01 | JWT works with empty secret    | Critical | ✅ **FIXED** (config layer)                            | `configuration.ts:56-94`                       |
| 4   | API-02 | Anyone can join any group call | Critical | ❌ **NOT FIXED**                                       | `sfu.controller.ts:73-94`                      |
| 5   | SP-01  | Cheap subscription unlocks Pro | Critical | ✅ **FIXED** (dashboard) / ⚠️ 9 side-door screens open | `ProDashboardScreen.tsx:112`                   |
| 6   | SEC-02 | TOTP alone logs you in         | High     | ✅ **FIXED**                                           | `totp.controller.ts:29-34`                     |
| 7   | API-04 | No Stripe idempotency keys     | High     | ❌ **NOT FIXED**                                       | `stripe.client.ts:252-272`                     |
| 8   | API-06 | Renewal webhook not idempotent | High     | ❌ **NOT FIXED**                                       | `subscription.service.ts:291`                  |
| 9   | API-05 | No timeouts on outbound calls  | High     | ❌ **NOT FIXED**                                       | `stripe.client.ts`, `biometric.service.ts`     |
| 10  | CRY-01 | Attachment integrity skippable | High     | ✅ **FIXED**                                           | `aesCbc.ts:258`                                |
| 11  | CLI-01 | Tokens in plaintext storage    | High     | ❌ **NOT FIXED**                                       | `src/services/api.ts:22,33,39`                 |
| 12  | MED-01 | Media downloads fail open      | Medium   | ⚠️ **STAGING MITIGATED, CODE NOT FIXED**               | `media.service.ts:220`                         |
| 13  | QA-01  | Test suite can't run on Linux  | High     | ⚠️ **MOSTLY FIXED** (CI enable still blocked)          | `.gitattributes`, `frameCryptorParity.test.ts` |

**Score: 5 fully fixed · 1 partial (SP-01) · 1 staging-only (MED-01) · 1 mostly (QA-01) · 5 not fixed.**

Also found: **one live money bug** (declined-then-retried top-up) discovered during the Rev2 review — **still present** (see bottom).

---

## 1 · DB-01 — Seven tables with no row-level security — ✅ FIXED

**Verified.** Migration `supabase/migrations/20260805090816_rls_deny_by_default_catchup.sql` exists and:

- Enables + `FORCE`s RLS on all seven named tables (`promo_codes`, `promo_redemptions`,
  `subscription_prices`, `invoices`, `invoice_sequences`, `provider_invite_codes`,
  `provider_referral_codes`) — lines 48-64.
- Then **sweeps the whole catalogue** (`pg_class … relkind IN ('r','p') AND NOT relrowsecurity`) so no
  drifted table survives — lines 79-93.
- **Asserts 0 RLS-off tables in the same transaction** and `RAISE EXCEPTION` if any remain — lines 96-107.
- The migration header records the **incident check (CLEAN)** and that the migration was already applied live.
- Standing gate is the post-`db push` assertion in `deploy-migrations.yml` plus this in-transaction check.

Nothing owed on the finding itself. (Note: the plan flags that the standing CI gate depends on the migration-drift repair in QA-01/X3 — see item 13.)

---

## 2 · API-01 — Every rate limit does nothing — ❌ NOT FIXED (prerequisite done)

**Not fixed.** `apps/auth-service/src/app.module.ts` still has **no `providers` array** (lines 37-89) — no
`APP_GUARD`/`ThrottlerGuard` is registered, so all 29 `@Throttle(...)` decorators remain inert metadata.

What _was_ done (prerequisite, in `279b9ce3`): `main.ts:73` changed `trust proxy` from `true` to a hop
count (`TRUST_PROXY_HOPS ?? 1`), so `req.ip` can no longer be spoofed via `X-Forwarded-For`. Without
that, wiring the guard would have enforced nothing — so this was the correct first step, but the guard
itself is still missing.

This was **deliberately blocked**, not overlooked — the plan (§G2.1) measured that binding a bare guard
would take out the ops-console SOS bar (~300 req/10 min vs a 100 default), throttle Stripe webhooks, and
429 the health probes.

### How to fix (ordered — this is a staged rollout, not a one-liner)

1. **Copy messenger's guard**, not a bare one: `messenger-service`'s `GlobalHttpThrottlerGuard` +
   `UserThrottlerGuard` skip logic. Register `{provide: APP_GUARD, useClass: GlobalHttpThrottlerGuard}` in
   `app.module.ts`'s (new) `providers` array. A bare `ThrottlerGuard` re-applies each route's tight
   `@Throttle` on an _IP_ bucket and turns `sos.controller.ts`'s `{limit:3, ttl:60s}` into 3 panic-raises
   per minute per NAT.
2. `@SkipThrottle()` on `HealthController` and **both** `stripe-webhook` routes.
3. Raise the module default above measured peak: `{ttl: 60_000, limit: 120}` as an abuse ceiling; keep
   per-route `@Throttle`s as the real limits.
4. **Ship one release in shadow (log-only) mode** to prove the ceiling against production traffic.
5. Per-SMS counter belongs in **`OtpService.send()`**, not `register()` (two callers: register + login).
   Key it on the **normalized E.164** number (B-154 double-prefix class). Note it's per-destination — the
   same axis Twilio already covers — so it is not the number-rotation defence.

---

## 3 · SEC-01 — JWTs work with an empty secret — ✅ FIXED (config layer)

**Verified.** `apps/auth-service/src/config/configuration.ts` now validates JWT secrets at **config-load**
(inside `ConfigModule.forRoot`), failing **closed** in production:

- `jwtSecret()` (lines 56-75) rejects blank, `<placeholder>` (the `auth.env.example` literal that
  `bootstrap-staging.sh` copies verbatim), `< 32` chars, **and** the dev secret published in
  `docker-compose.yml` (explicit denylist, lines 50-54).
- `actionSecret` **no longer falls back to `accessSecret`** and must differ (lines 77-88) — restores the
  File-Vault step-up separation.

The getter in `jwt.service.ts:22-27` still reads `... ?? ''`, but that path is now unreachable in prod
because config throws first. Fail-at-boot was chosen over a throwing getter deliberately (auth-service has
no global exception filter, so a throwing getter would surface as a misleading 401).

**Residual owed (from the plan, not blocking):** `infra/env/messenger.env.example` has **no
`JWT_ACTION_SECRET` line**, so a templated environment gets auth-with-a-secret + messenger-with-none →
File Vault MFA and recipient-purge are dead on arrival there. Add it with a "must match auth-service" comment.

---

## 4 · API-02 — Anyone can join any group call — ❌ NOT FIXED

**Not fixed.** `apps/messenger-service/src/sfu/sfu.controller.ts` `findRoomForConversation` (lines 73-94)
still mints a room token for **whoever asks** — `this.roomToken.issue(roomId, callerId)` with no membership
check. The docstring still says _"Does NOT verify caller is in the conversation"_ (line 70).

Impact is narrower than the PDF stated (the plan overturned it): group-call media is
SFrame/FrameCryptor-encrypted with the group master key on top of DTLS-SRTP, so a token-holder **without the
group key gets ciphertext**. Real exposure = unauthorized presence + call metadata, a 10-slot `room_full`
DoS, and genuine media **only for a removed member who kept the old group key** (a key-rotation problem).
Still a real gap for a secure-comms product.

### How to fix

- **Bind conversation membership, not the ring list** — the same relationship the relay already uses to
  route envelopes for that `conversationId`. The ring list is _not_ a sound authority: `POST /sfu/rooms`
  takes `conversationId` from the body with no check and stamps the caller as `hostUserId`, so any user can
  claim host of any conversation.
- Gate **both** mint sites — `by-conversation` _and_ the `POST /sfu/rooms` reuse branch (host is never
  reassigned on reuse).
- Run authorization **before** the room lookup — `findRoomForConversation` currently `router.close()`s
  zero-participant rooms on a GET, so any authed user can reap rooms by polling.
- Refresh the invited-set TTL on every join/re-mint and delete the set in **all six** room-destroy paths,
  or a finite TTL strands a live participant (`remintRoomToken` returns `undefined`, leaves the ref stale).
- Multi-pod: invited state is per-pod `Map`s while socket.io uses a Redis adapter — needs shared state or
  `POST /sfu/rooms` on pod B creates a second room for the same conversation (split call).

---

## 5 · SP-01 — Cheap subscription unlocks the Pro dashboard — ✅ FIXED (dashboard) / ⚠️ side doors open

**Verified for the reported screen.** `src/screens/pro/ProDashboardScreen.tsx:112-116` — the `legacyPro =
isProActive(user)` admitting term is gone; the gate is now `if (hasLoaded && !planActive) replace(...)`.
Buying Messenger Pro no longer opens the Secure Pro dashboard.

**Bonus fix shipped:** the store's fail-open was also closed — `secureProStore.ts:83` now sets
`hasLoaded = true` in the `catch`, so a failed `/pro-applications/me` (offline, 500, timeout, 401) no longer
renders the full dashboard for anyone. This was a _bigger_ hole than the reported one.

### Still owed (⚠️ partial)

- **Nine other Pro screens have no gate at all** — `SecureProCalendar`, `ProAssignedTeam`,
  `ProLiveMission`, `SecureProMissions`, `SecureProMembers`, `ProActivityHistory`, … They are plain
  `BookingStack` routes that cross-link to each other. No `useProPlanGate()` hook exists yet (grep: 0 hits).
  Fixing only the dashboard closes the front door and leaves nine side doors. **Fix:** build a shared
  `useProPlanGate()` and apply it to the whole route group.
- **Product decision still open** on grandfathered `legacyPro` users. Size it with
  `pro_active_until IS NULL` (permanent/comp grants). If any exist, migrate them to comped
  `pro_applications` rows rather than keying off `subscription_tier`.

---

## 6 · SEC-02 — TOTP on its own logs you in — ✅ FIXED

**Verified.** `apps/auth-service/src/totp/totp.controller.ts`:

- `/auth/totp/verify` now carries `@UseGuards(JwtAuthGuard)` (line 29) and takes the account from
  **`user.sub` (the JWT)**, not the request body (line 32-33). `TotpVerifyDto` no longer contains `userId`
  (`dto/totp-verify.dto.ts`). A guard alone was not enough — binding the userId to the token stops one user
  minting a session for another.
- **Codes are single-use:** `totp.service.ts:95-96` claims the authenticator's counter
  (`claimTotpCounter(userId, counter)`, server counter + delta), and rejects a replay. Backup codes consume
  atomically. Regression pinned by `totp.security.spec.ts` (proven RED first).

The audit's proposed 3-phase pending-login-token rollout was skipped deliberately — the endpoint has **no
shipped caller**, so the phased flag would only have kept the hole alive. `verified_at IS NOT NULL` was also
_not_ added (it would be a permanent enrolment deadlock — `verified_at` is only written inside `verify()`).

---

## 7 · API-04 — No Stripe idempotency keys — ❌ NOT FIXED

**Not fixed.** `apps/auth-service/src/wallet/stripe.client.ts` `post()` (lines 252-272) sends **no
`Idempotency-Key`** header on any write. No `idempotencyKey` param anywhere in the client.

The plan **redesigned** this — the PDF's premise is partly wrong: `/subscription/pro` debits **Bravo
Credits** first (not the card), so a retry double-spends 2000/5000 BC and a Stripe key on `/v1/subscriptions`
would not help. The PDF's two suggested keys are also unimplementable as written (`periodStart` doesn't
exist at call time; `ledgerTxId` is inserted after the Stripe call).

### How to fix (redesigned)

- Add an optional `idempotencyKey?` param to `post()`; set `headers['Idempotency-Key']` when present.
- Anchor the key on the **`wallet_transactions` row id** created by `debitForFeature` — not on
  `periodStart` (Postgres-computed, differs per retry) and not a forever-stable day bucket (documented to
  replay a stale response — `api.ts:1729`). Retry under the same key only on network error / 5xx / 429,
  never a 4xx.
- Fix the **real orphan**: `enableAutoRenew` unconditionally overwrites `stripe_subscription_id`, and the
  stale-sub cancel only fires on a _tier switch_ — so a same-tier re-subscribe orphans a live subscription
  that bills forever. Use `SELECT … FOR UPDATE`; if `stripe_subscription_id IS NOT NULL`, verify/reuse or
  cancel before replacing.
- Apply the **`OptionalIdempotencyInterceptor`** (not the strict one) to `/wallet/topup` — strict throws
  `idempotency_key_required` and breaks every installed client. Also give the interceptor an in-flight
  reservation (it currently GET→handler→SET, so two concurrent taps both miss) and include the request body
  in its cache key.
- **Sequence after API-06** (idempotency before timeouts — see item 9 / plan §X2).

---

## 8 · API-06 — Renewal webhook grants free months — ❌ NOT FIXED

**Not fixed.** `apps/auth-service/src/subscription/subscription.service.ts` `invoice.paid` handler still runs
`pro_active_until = GREATEST(COALESCE(pro_active_until, NOW()), NOW()) + INTERVAL '30 days'`
**unconditionally** (lines 291-292). No `stripe_processed_events` table, no dedupe on `event.id` (never
destructured). Every duplicate `invoice.paid` (Stripe delivers at-least-once, retries 3 days) silently adds 30 days.

### How to fix (redesigned — convergence beats dedupe)

- **Assign from Stripe's own period end**, so duplicates/out-of-order become arithmetic no-ops:
  `pro_active_until = GREATEST(COALESCE(pro_active_until, NOW()), to_timestamp($3))`. This also fixes an
  unflagged bug: the handler grants a flat 30 days regardless of the Price's real interval (an annual Price
  under-grants by 11 months).
- If you also add an event ledger: PK must be **`(event_id, handler)`** — Stripe delivers the same
  `event.id` to every endpoint and two exist; a shared PK lets one endpoint's claim silently no-op the other.
  Claim **after** the type filter. Use `… ON CONFLICT DO NOTHING RETURNING event_id` and test `rows.length`
  — `rowCount` **does not exist** in this DB layer (`db.q` returns `res.rows`), so the PDF's `rowCount === 0`
  is a silent no-dedupe.
- Put the claim **and** the side effect in **one `withTransaction`** — "commit the claim first" permanently
  loses the grant if the process dies before the update.
- `verifyWebhook` reads a single `stripe.webhookSecret`, but Stripe issues a distinct secret per endpoint —
  with two endpoints, at most one verifies.

---

## 9 · API-05 — No timeouts on outbound calls — ❌ NOT FIXED

**Not fixed.** `stripe.client.ts` `fetch` calls carry **no `AbortSignal`** (all sites, incl. `post()` line
256). `biometric.service.ts:112` uses a raw `https.request` with **no `setTimeout`** — a stalled socket
never settles. Mapbox/GDELT calls likewise unbounded. Only the low-value news feeds (`newsdata`,
`googlenews`, `newsfeed`) pass `AbortSignal.timeout(...)`.

### How to fix (with the plan's corrections)

- **Sequence AFTER API-04** (§X2): a timeout without an idempotency key converts a Stripe hang into a
  **double charge**. And the dangerous route is `/subscription/*` (charges synchronously via
  `error_if_incomplete`), **not** `/wallet/topup` (card charged later by the client PaymentSheet).
- **Do not inline `AbortSignal.timeout` at nine sites** — this repo already has two timeout helpers. Add one
  `apps/auth-service/src/common/http/fetchWithDeadline.ts` (auth-service can't import `@bravo/messenger-core`).
  Note the two primitives throw **different** errors (`AbortError` vs `TimeoutError`); the classifier must
  match both.
- A subscription timeout must resolve to **"unknown"** (`pro_renew_status = 'reconcile_pending'`), not "off"
  — the current catch returns HTTP 200 `auto_renew:false` while a live Stripe sub exists, manufacturing the
  very orphan API-04 fixes.
- **`biometric.service.ts`:** the PDF's `req.setTimeout` fix targets the wrong bug — `req.on('error')` is
  already wired, and `setTimeout` is a socket-_idle_ timeout that never fires against a slow dribble.
  **Replace the raw `https.request` with the `fetch` helper**, which bounds headers + body. (Android only —
  iOS returns before I/O.)
- Map deadline errors to **503** (distinct from 402 decline / 500 our-bug). Move `res.ok` check before
  `res.json()`. Time-bound `/ready`'s DB+Redis probes with `Promise.race`.
- **Do NOT build the circuit breaker** — nothing consumes a 503 (no orchestrator/LB integration), and
  `get enabled()` (unset `STRIPE_SECRET_KEY` → `503 stripe_disabled` + BC fallback) already _is_ a manual
  breaker.

---

## 10 · CRY-01 — Attachment integrity check can be skipped — ✅ FIXED

**Verified.** `src/modules/messenger/media/aesCbc.ts` now requires format v2:

- `decryptAttachment` throws on `ct[0] !== FORMAT_V2` (line 258) _"attachment format not supported —
  possible downgrade attack"_.
- The `FORMAT_V1` and no-version branches are **deleted** — the constant is intentionally gone (lines 71-78)
  with a comment warning not to reintroduce it. `git log -S FORMAT_V1` confirmed v1 was never emitted by any
  commit, so `0x01` was only ever an attacker's byte.
- The MAC covers `(version || ciphertext)` (lines 268-273), so requiring v2 also authenticates the version
  byte — no envelope field or DB column needed. This is smaller and stronger than the PDF's
  `expectedFormat`-from-envelope proposal (no envelope exists at download time).

---

## 11 · CLI-01 — Session tokens in plaintext storage — ❌ NOT FIXED

**Not fixed.** `src/services/api.ts` still keeps both tokens in **AsyncStorage** (unencrypted SQLite on
Android): reads at lines 22, 33, 114, 193; writes via `multiSet` at 39-40 and `tokenStore` at 166-167. No
`react-native-keychain` usage for auth tokens.

The plan flags this is **worse than the PDF says**, and identifies a higher-value fix.

### How to fix (redesigned — do the server gate first)

- **Gate `/auth/keys/upload` on identity rotation first.** `keys.service.ts:88` computes `identityRotated`
  but never blocks — the `INSERT … ON CONFLICT DO UPDATE SET identity_key` (lines 90-99) means a stolen
  15-min access token **overwrites the victim's Signal identity key** → permanent, silent E2EE takeover
  (peers fetch the attacker's identity). Require fresh re-auth when `identityRotated`. This retires more risk
  than the whole client-side token move, and `/auth/messenger-ticket` already refuses the Bearer path for
  exactly this class.
- **Then move tokens to Keychain**, but with care the draft missed:
  - Needs a distinct `KeychainUnavailableError` excluded from the `authFailed` branch — four **headless**
    modules drive `refreshAccessTokenShared` (`serverWakeNotifications`, `fcmBootstrap`, `pendingActions`,
    `headlessDrain`), and `WHEN_UNLOCKED_THIS_DEVICE_ONLY` returns nothing on a locked device. Without the
    guard, a push on a locked phone logs the user out (B-15b class).
  - `keychain.ts` is entirely userId-scoped, but the refresh token must be readable **before** the userId is
    known — needs an unscoped service name. Reuse the `getGenericPassword`-returns-`false` guard.
  - Land a **global Keychain jest mock first** (38 files reference `services/api`). `refreshAccessToken`
    bypasses `tokenStore` and writes AsyncStorage raw at **six sites** — that's the real choke point, not
    `tokenStore`. Sign-out must explicitly destroy the Keychain entry.
- **CLI-02 (no TLS pinning)** compounds this — an MITM with a rogue CA gets the token and thereby the
  identity takeover. Assess pinning + plaintext token + ungated keys-upload together.

---

## 12 · MED-01 — Media downloads fail open — ⚠️ STAGING MITIGATED, CODE NOT FIXED

**Code not fixed; staging mitigated.** `apps/messenger-service/src/media/media.service.ts:220` still defaults
**lax**: `const strict = process.env.MEDIA_REQUIRE_RECIPIENT_GRANT === 'true'` — an unset var means any
authenticated caller with the object key gets a presigned URL, and a grant set expiring at its 30-day TTL
flips an object from "recipients only" to "any Bravo user".

Per the plan, `MEDIA_REQUIRE_RECIPIENT_GRANT=true` **is set on `bravo-staging-msgr`** (verified by
`docker inspect`), so staging is not exposed — but the defect is **latent**: a new environment, a rebuild
that drops the var, or a local stack fails open. Exposure is bounded (object keys are random UUIDs inside
sealed envelopes; blobs stay encrypted), but the invariant is backwards.

### How to fix (with the trap)

- Flip the code default: `const strict = (process.env.MEDIA_REQUIRE_RECIPIENT_GRANT ?? 'true') === 'true'`
  and move it into `configuration.ts` where defaults get reviewed. Treat a missing grant set as **deny**.
- **⚠️ Not sufficient alone — the flip silently disables the upload-truncation guard.** `mediaClient.ts:113`
  calls `headObjectLength` immediately after PUT (via `POST /media/download-url`) — **before** `registerGrants`
  runs — so under strict it 403s, and the 403 is swallowed by `.catch(() => null)`, taking the "accept the
  upload" path. **Land first:** stamp the owner grant inside `createUploadUrl` (`SADD media-grant:<key>
caller`). The client comment at `mediaClient.ts:385` already _claims_ this happens — it does not.
- Answer two blockers before flipping: a **Redis restart** 403s every attachment < 30 days old (state is
  ephemeral — plan §X1), and **backup restore never re-registers grants** (no `registerGrants` under
  `backup/**`; a restoring user can't re-grant someone else's media).
- Update the two specs that pin lax behaviour (`media.service.spec.ts:118` inverts, `:127` stays) — don't
  delete them.

---

## 13 · QA-01 — Test suite can't run on Linux — ⚠️ MOSTLY FIXED (CI enable still blocked)

**Mostly fixed.**

- ✅ `.gitattributes` shipped with `* text=auto` (+ `*.sh text eol=lf`, `patches/** -text`, binary globs).
  Deliberately **no `git add --renormalize`** — the index is already 2382 LF, and a blanket rewrite would
  touch `patches/react-native-argon2+4.0.0.patch` (mixed EOL) and break `npm install` (patch-package hard-fails
  when `CI` is set).
- ✅ The four `toContain('\r\n')` CRLF assertions were already removed in `1f443c7` (B-373). Zero hits
  repo-wide now.
- ✅ `frameCryptorParity.test.ts` fails **loudly** on a missing prebuild target (`beforeAll` existence +
  non-empty check, lines 60-65) rather than `describe.skip`-ing into a vacuous pass. (Correction to the PDF:
  the Kotlin file is git-tracked, so a fresh Linux clone does find it.)

### Still owed — "turn CI on" is NOT executable yet (4 measured blockers + drift, none in the PDF)

`ci.yml` is already live on `push`/`pull_request` to `main`, so "enable CI" means branch protection. On its
first run it fails for:

1. **TypeScript** — `npm run typecheck` is raw `tsc --noEmit`; the 47-error baseline lives only in
   `.husky/pre-push`. Measured 43 errors → exit 2. CI red while the local ratchet is green.
2. **ESLint** — `--max-warnings=0`; measured 6 errors (3 parse errors from `scripts/e2e-*.ts` outside
   `tsconfig` include, one `eqeqeq`, two `no-misused-promises`) + 169 warnings.
3. **gitleaks** — root `GoogleService-Info.plist` and `.env.production` fall outside the allowlist anchors.
4. **auth-service integration** — passes **vacuously**: `@testcontainers/postgresql` isn't installed →
   `MODULE_NOT_FOUND` → `describeIfDb` short-circuits and reports _passed_. This is the exact
   manufactured-confidence failure QA-01 exists to prevent — inside QA-01's own enabling step.

Plus prerequisites: **migration-history drift repair (§X3)** — 79 local version prefixes have no remote row,
so enabling `deploy-migrations.yml`'s `db push --include-all` replays 79 migrations; and two duplicate
migration prefixes need renaming. Also quarantine the ~50%-flaky `messenger-crypto` suite (B-126) before it
becomes the team's first CI experience.

The four "already written" regression tests the PDF references (`rlsCoverage.test.ts`,
`app.module.throttler.spec.ts`, `jwt.service.secret.spec.ts`, `scannerPortability.test.ts`) **do not exist**
in this repo — they must be written (and proven RED first) per the CLAUDE.md bug-regression contract.

---

## Bonus — live money bug found during the Rev2 review — ❌ STILL PRESENT

A **declined-then-retried top-up charges the user, credits nothing, and reports success.**
`wallet.service.ts:1178-1184` marks a `payment_failed`/`canceled` intent **terminally** `status='failed'`
with no status guard. Stripe permits re-confirming a failed PaymentIntent → the retry succeeds →
`payment_intent.succeeded` looks up `AND status='pending'`, finds nothing, logs "unknown pending intent" →
**no credit** → the client's `confirmTopUp` sees `status !== 'pending'` and returns early with
`credits_awarded: tx.amount_credits` → the UI says "N BC added".

**How to fix:** make `payment_failed` **non-terminal** (allow the row back to `pending` on re-confirm), and
return `credits_awarded: 0` for a `failed` row.

---

## What to do next (revised execution order from the plan)

Prereqs (`0`, `1`) gate everything DB/security-state-shaped:

0. Repair migration-history drift + rename duplicate prefixes (§X3).
1. Make Redis persistent (§X1) — six fixes store security state in an ephemeral store.

Then the still-open items, in dependency order:
**4 · `trust proxy`** (done) → **API-06** (9) → **API-04** (10) → **API-05** (11, after 10) →
**API-01** (12, shadow mode) → **API-02** (13) → **CLI-01** (14, keys-upload gate first) → **QA-01 + enable CI** (15).

SP-01's 9 side-door screens (item 5) and MED-01's code flip (item 12) can land independently once their
respective traps (shared route gate; `createUploadUrl` grant) are handled.
