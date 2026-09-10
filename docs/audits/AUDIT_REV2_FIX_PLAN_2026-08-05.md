# Audit Rev2 — Fix Plan (grouped by root cause)

**Source:** `BravoSecure_Audit_Rev2_Corrected_1.pdf`, written 3 Aug 2026 against commit `85ab04d`.
**This plan:** 5 Aug 2026, against `main @ e42d8d9`. **Revision 2** — every fix design below has been
through an adversarial critique pass plus a dedicated edge-case pass. Where a critique overturned
the first draft, the correction is marked **⚠︎ OVERTURNED** and the reasoning is kept, because the
wrong version was plausible and will be re-proposed otherwise.

> `85ab04d` is **not in our history** (`git cat-file -t 85ab04d` → fatal, after `git fetch`).
> Every finding was therefore **re-verified against current `main`**, and three came back
> materially different from the PDF.

---

## 0. Status board

| #   | ID     | PDF sev  | Verified verdict                                     | This session                              |
| --- | ------ | -------- | ---------------------------------------------------- | ----------------------------------------- |
| 1   | DB-01  | Critical | STILL BROKEN — 3 of 7 live, 7 of 7 in migration tree | **✅ FIXED + APPLIED**                    |
| 6   | SEC-02 | High     | STILL BROKEN — all three sub-claims                  | **✅ FIXED**                              |
| 2   | API-01 | Critical | STILL BROKEN — no `providers` array                  | ⛔ BLOCKED (see G2.1)                     |
| 3   | SEC-01 | Critical | STILL BROKEN                                         | 📋 designed, safe                         |
| 4   | API-02 | Critical | STILL BROKEN                                         | 📋 designed, needs authority decision     |
| 5   | SP-01  | Critical | STILL BROKEN                                         | 📋 designed                               |
| 7   | API-04 | High     | STILL BROKEN — premise wrong, see G4.1               | 📋 redesigned                             |
| 8   | API-06 | High     | STILL BROKEN                                         | 📋 redesigned                             |
| 9   | API-05 | High     | STILL BROKEN                                         | 📋 designed                               |
| 10  | CRY-01 | High     | STILL BROKEN                                         | 📋 redesigned — much smaller than the PDF |
| 11  | CLI-01 | High     | STILL BROKEN — worse than the PDF says               | 📋 redesigned                             |
| 12  | MED-01 | Medium   | CODE broken, **staging already mitigated**           | 📋 designed                               |
| 13  | QA-01  | High     | **MOSTLY FIXED ALREADY**                             | **✅ PARTIALLY FIXED** — see G7           |

### Gates run after the changes in this session

| Gate                                             | Result                                                                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/auth-service` — TOTP + crypto specs        | **40/40 pass** (`totp.security.spec.ts` proven RED first)                                                                                                                 |
| `apps/auth-service` — full unit suite (baseline) | 118 suites / 2229 tests green                                                                                                                                             |
| `messenger-crypto` ×2 (flake rule B-126)         | run 1: 3 failed → **run 2 and run 3: 417 suites / 4209 tests green**. The failure did not recur and did not name the same test — the known moving flake, not this change. |
| `app` project, `screens/messenger`               | 29 suites / 314 tests green                                                                                                                                               |
| Live RLS assertion                               | `0` of `94` public tables with RLS off                                                                                                                                    |

### The corrections to the PDF

1. **DB-01 — the live DB was in better shape than the migration tree.** Four of the seven
   (`promo_codes`, `promo_redemptions`, `invoices`, `invoice_sequences`) already had RLS on **live**
   but in **no migration** — switched on out-of-band and never written back. Live exposure was 3
   tables (`provider_invite_codes`, `provider_referral_codes`, `subscription_prices`); a fresh
   environment built from `supabase/migrations/` got all 7 wide open.

2. **MED-01 — staging is not exposed.** `MEDIA_REQUIRE_RECIPIENT_GRANT=true` **is** set on
   `bravo-staging-msgr` (verified by `docker inspect`). The audit inferred "lax in production" from
   the var's absence in the repo. The defect is real but **latent**: the _code_ default is open, so
   a new environment, a rebuild that drops the var, or a local stack fails open.

3. **QA-01 — four of the five files were already fixed** in `1f443c7` (2026-08-04, B-373). The
   `toContain('\r\n')` assertions are gone. What remains is much smaller — see G7.

### Incident check (DB-01 asked for it — result: **CLEAN**)

```
promo_codes             1 row  — BRAVO50, 50 credits, cap 1000, 0 redeemed, created 2026-06-21
promo_redemptions       0 rows
provider_invite_codes   0 rows
provider_referral_codes 0 rows
subscription_prices     2 rows — pro 2500 BC, enterprise 5000 BC
```

No unrecognised rows, no redemptions, no self-issued invites. **No evidence the writable window was
exploited.** The single promo code predates the exposure window and matches an ops-created code.

### The four "already written" regression tests do not exist here

`rlsCoverage.test.ts`, `app.module.throttler.spec.ts`, `jwt.service.secret.spec.ts` and
`scannerPortability.test.ts` are all absent (`git ls-files`). They must be written, and proven RED
first, per the CLAUDE.md bug-regression contract.

---

## Cross-cutting blockers (found by the edge-case pass — these gate several fixes)

### X1 — One non-persistent Redis underpins six of the seven fixes ⛔

`infra/env/{auth,messenger}.env.example` both point at `redis://127.0.0.1:6379/0` — **one instance,
one DB index, shared by both services**. `docker-compose.yml:10-21` runs it
`--save '' --appendonly no` with **no volume**. Into that ephemeral store this programme would put:
SFU invited sets (G1.2), media grants (G1.3, already there), the SMS counter (G2.1), TOTP
replay claims + lockouts (G3), and Stripe idempotency records (G4.1).

One restart drops every call allowlist, every media grant, every rate limit, and **every idempotency
record — turning an in-flight Stripe retry into a double charge**.

> Staging may run the distro `redis-server` (`infra/bootstrap-staging.sh:126-129`), whose default
> _does_ enable RDB. **Verify `CONFIG GET save / appendonly / dir` on the box before flipping
> MED-01.** Persistence is a prerequisite for this programme, not a footnote.

### X2 — Timeouts must land AFTER idempotency, not before ⛔

The PDF's order does G5 (timeouts) before G4.1 (idempotency keys). That is backwards: today a
slow-but-successful `createPaymentIntent` eventually resolves; add a 10s abort and it _rejects while
Stripe has already created the intent_, with no key to collapse the retry. **Adding timeouts first
makes double charges more likely.** Swapped in the execution order below.

### X3 — The Supabase migration history is drifted; `db push` would replay 79 migrations ⛔

117 local files vs 115 remote rows, and **79 local version prefixes have no remote row**. Everything
from `20260611070242` onward was applied via MCP `apply_migration`, which records _its own_
timestamp, not the filename prefix. `deploy-migrations.yml` fires on any push touching
`supabase/migrations/**` and runs `supabase db push --include-all` → a 79-migration replay in lex
order (backfills, `ADD CONSTRAINT`s, seeds), which aborts partway or half-applies.

There are also **two duplicate version prefixes** (`20260628000000` ×2, `20260630000000` ×2);
`schema_migrations.version` is the primary key, so one of each pair can never be recorded.

**Mitigation taken this session:** the new RLS migration file is named `20260805090816_…` to match
the version the MCP apply already recorded, so `db push` sees it as applied and skips it. That stops
_this_ change detonating the replay. **The drift itself is pre-existing and still needs a
`supabase migration repair --status applied <version>` pass before CI is enabled.**

---

## The seven root-cause groups

| Group | Root cause                                            | Findings                     |
| ----- | ----------------------------------------------------- | ---------------------------- |
| G1    | Authorization that fails **open**                     | DB-01, API-02, MED-01, SP-01 |
| G2    | Controls **declared but never wired**                 | API-01, SEC-01               |
| G3    | Two factors collapsed into **one**                    | SEC-02                       |
| G4    | **At-least-once** money treated as exactly-once       | API-04, API-06               |
| G5    | **No deadline** on third-party I/O                    | API-05                       |
| G6    | **Attacker-controlled input picks the security path** | CRY-01, CLI-01               |
| G7    | The **gate that guards the gates** is broken          | QA-01                        |

---

# G1 — Authorization that fails open

**The shared mistake:** the default answer to "may this caller have it?" is _yes_, and the deny only
fires when some optional thing is present — an entry in a hand-maintained list, an env var, a grant
set, a field that happens to be set. Fail-open is invisible in testing because the happy path is
identical. Only the attacker sees the difference.

**The rule:** _enumerate what is allowed, deny everything else._ Never enumerate what is denied.

---

## G1.1 — DB-01: seven tables with no row-level security ✅ FIXED

### Why it happened

`20260603100000_enable_rls_deny_by_default.sql` enables RLS by looping a **literal array of 70 table
names** (the PDF says 69). It was a snapshot of 3 June 2026; every table created after is RLS-off
unless its own migration remembers. The Supabase anon key ships in the APK
(`EXPO_PUBLIC_SUPABASE_ANON_KEY`, `src/utils/constants.ts:16`), and PostgREST exposes every `public`
table to `anon` unless RLS says otherwise. `anon` and `authenticated` held
`SELECT/INSERT/UPDATE/DELETE/TRUNCATE` on all seven.

**This was the third occurrence:** `20260603120000` caught `wallet_credit_batches` (missed by the
snapshot _two hours earlier_), and `20260804020000` caught five scope-v2 tables — its own header says
it was found **"BY THE SUPABASE ADVISOR AFTER APPLYING THE MIGRATIONS TO STAGING, not by review"**.
The list is the bug.

### What it cost

Mint `{"code":"FREE","credits":100000000,"active":true}` into `promo_codes`, redeem it through our
own `/wallet/redeem-promo`. The wallet code is _correct_ — row lock, redemption cap, per-user PK all
work — it is simply operating on a promo code the attacker wrote. `promo_redemptions` is writable
too, so delete the redemption row and redeem again. Credits become real payouts via escrow release.
`provider_invite_codes` are single-use roster-join credentials.

### ⚠︎ OVERTURNED — `FORCE` stays

Draft 1 said "apply `ENABLE` only; `FORCE` is a no-op against `anon` and risks a future
owner-connected job", citing the 2026-08-04 migration as the house precedent. **Wrong on the facts:**
`20260603100000:52` applies `FORCE` to all 70 tables and its header explains exactly why
(_"tables are owned by `postgres` (which bypasses via the role attribute, unaffected by FORCE), so
this is harmless defence-in-depth against a future non-bypassing owner connection"_). Live counts
were ~73 forced vs 18 enable-only — the 5-table minority was the deviation, not the rule. And the
risk argument was incoherent: `BYPASSRLS` is a _role attribute_ and the owner **is** `postgres`,
which has it. **Shipped with `ENABLE` + `FORCE`.**

### What shipped

`supabase/migrations/20260805090816_rls_deny_by_default_catchup.sql`, applied live:

1. `ENABLE` + `FORCE` on the seven, guarded by `information_schema` existence (the live DB and the
   tree hold different table sets — ~20 tree tables don't exist live, so a bare `ALTER` would fail).
2. A catalogue sweep over `relkind IN ('r','p')` — **`'p'` matters**: the tree contains
   `gps_pings` `PARTITION BY` + `gps_pings_default` `PARTITION OF`, and RLS on the leaf does not gate
   a PostgREST query against the parent.
3. A closing assertion that raises if any public table is still RLS-off, so the migration cannot
   half-succeed.

**Verified live: `0` of `94` public tables have RLS off.**

### What is still owed

- **The sweep is still a snapshot.** A `DO` block runs once. The durable fix is at the grant layer:
  `pg_default_acl` currently grants `arwdDxtm` to **both `anon` and `authenticated`** for new tables
  in `public` — that default is _why_ every new table is world-writable.
  `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;` kills
  the class at source. Second choice: a post-`db push` assertion in `deploy-migrations.yml`.
- **`rlsCoverage.test.ts`** — and it must be written carefully. A naive scan reports **67** uncovered
  tables where the true answer is **7**, because 71 covered names exist only as quoted strings inside
  the `ARRAY[…]` literal, never as `ALTER TABLE <name> ENABLE ROW LEVEL SECURITY`. It must union
  both forms, and use `(public\.)?` anchors — **34 of 116 `CREATE TABLE` statements are unqualified**
  (`CREATE TABLE IF NOT EXISTS lite_bookings`), the exact trap CLAUDE.md records.
- A repo-only scan cannot see out-of-band DDL (which is how 4 of these 7 got fixed). Pair it with the
  **live** count assertion.

---

## G1.2 — API-02: any logged-in user can join any group call

### Why it happened

`sfu.controller.ts`, `GET /sfu/rooms/by-conversation/:conversationId` mints a room token for whoever
asks. Its own docstring says so: _"Does NOT verify caller is in the conversation — server has no view
of group membership (the messenger is E2E encrypted)."_ That sentence is the root cause and it is
_half_ true: the server genuinely cannot read the encrypted roster, but it does not follow that it
cannot authorize — it used the wrong authority. `RoomTokenService` is stateless by design
(_"the HMAC IS the allowlist"_), which is sound **only if minting is authorized**. It isn't, so the
HMAC attests to nothing more than "this user asked".

### ⚠︎ OVERTURNED — the impact, and the authority

**Impact is smaller than the PDF states.** Group call media is **SFrame/FrameCryptor-encrypted with
the group master key on top of DTLS-SRTP**: `launchCall.ts:292-299` blocks the call outright when the
orchestrator is unavailable, and `useGroupCall.ts:1818` throws _"no group master key — refusing to
start"_. An attacker with a room token but no group key gets **ciphertext frames**. The real damage
is unauthorized presence + call metadata, a 10-slot `room_full` DoS
(`MAX_PARTICIPANTS_PER_ROOM = 10`), and genuine media **only for a removed member who retained the
old group key** — which is a key-rotation problem a room token cannot fix.

**The ring list is not a sound authority.** `POST /sfu/rooms` takes `conversationId` straight from
the body with no membership check and stamps `hostUserId` from the JWT (`sfu.service.ts:233`). So X
can POST any conversationId, become host, and real members later _join X's room_ via the reuse
branch — `hostUserId` is never reassigned. Host powers are real (`sfu.kick`, `sfu.mute-target`, ring
authority). Seeding an invited set from that host inherits trust from an unauthenticated caller.

**Therefore the fix must bind conversation membership, not the ring list** — the same relationship the
relay already uses to route envelopes for that `conversationId`. Honest minimum if that is
unavailable: `POST /sfu/rooms` may only **create**, never reuse; the reuse branch goes through the
same gate as `by-conversation`; and the host claim attaches to the first _invited_ join.

### Edge cases that must be handled (not exhaustive — see §Edge log)

- **Mid-call removal stays open.** A member removed _during_ a call was rung at start, so an invited
  set admits their re-mint for its whole TTL. No server path revokes anything on removal — the server
  has no roster. B-339's eject runs on the removed member's _own device_.
- **Rooms have no wall-clock TTL**, so any finite invited-set TTL expires mid-call; `remintRoomToken`
  then returns `undefined` and **leaves `roomTokenRef.current` stale**, so the participant cannot
  rejoin. Refresh the TTL on every join/re-mint and delete the set in **all six** room-destroy paths.
- **`findRoomForConversation` mutates on a GET** — it `router.close()`s zero-participant rooms past
  30s. Any authed user can reap a room by polling. **Run authorization before the lookup.**
- **State is per-pod `Map`s** while socket.io has a Redis adapter, so on multi-pod the gate collapses
  and `POST /sfu/rooms` on pod B creates a _second room for the same conversation_ — a split call.
- **Ring authority is any participant** (B-334), each able to name 250 arbitrary userIds — so
  "alert on a mint from a user never rung" needs one accomplice, not zero.

---

## G1.3 — MED-01: media downloads fail open

### Why it happened

Written as a **rollout window** — enforcement deliberately off until clients shipped grant
registration. They did (7 sites in `productionRuntime.ts`). The flag was never flipped and the window
never closed; a temporary default became permanent. It reads `process.env` directly rather than
`ConfigService`, so the default lives in an expression instead of in `configuration.ts` where
defaults get reviewed.

### The fix, and the trap in it

```ts
const strict = (process.env.MEDIA_REQUIRE_RECIPIENT_GRANT ?? 'true') === 'true';
```

**⚠︎ Not sufficient alone. The flip silently disables the upload-truncation guard.**
`mediaClient.ts:113` calls `headObjectLength(objectKey)` immediately after the PUT, which goes through
`POST /media/download-url` — **before `registerGrants` has run** (that happens later, at send time).
Under strict it 403s, and the 403 is swallowed by `.catch(() => null)`, taking the documented
_"can't verify, accept the upload"_ path. Net effect: the guard against silently truncated R2 uploads
is off on **every** upload, with no error and no log — and truncation surfaces to the _recipient_ as
"media unreadable".

**Land this first:** stamp the owner grant inside `createUploadUrl` (`SADD media-grant:<key> caller`

- the owner record). The client comment at `mediaClient.ts:385` already _claims_ this happens
  ("the implicit grant the server stamps on createUploadUrl") — it does not. That also fixes
  note-to-self (where `registerGrants` short-circuits with no HTTP call and the sender is never
  granted → the sender 403s on their own upload) and makes ownership established at the presigner
  rather than by "first `registerGrants` wins by NX".

**Other blockers:** Redis restart 403s every attachment under 30 days old (X1) while the R2 object
survives — neither downloadable nor swept. **Backup restore never re-registers grants** (verified: no
`registerGrants` anywhere under `backup/**`), and the restoring user _cannot_ re-grant someone else's
media (`not_object_owner`). Both must be answered before the flip.

Two existing specs pin the lax behaviour and must be **updated, not deleted**:
`media.service.spec.ts:118` (inverts) and `:127` (stays).

---

## G1.4 — SP-01: a cheap messenger subscription unlocks the Pro dashboard

### Why it happened

Two products deliberately share one tier vocabulary. `tierMatrix.ts:52-64` says it out loud
(_"the tier IDS (lite/pro/enterprise) stay shared"_) while the same file's header says Bravo Secure
Pro is a **different product**. So `isProActive(user)` answers _"did they buy Messenger Pro?"_ and is
read as _"do they have an active Secure Pro plan?"_. One identifier, two meanings.

Buy the 2500 BC Messenger Pro subscription → navigate to ProDashboard → the gate admits. Server data
endpoints still hold (`assertPlanAccess` is a real ownership + active-family check), so this is a
**paywall bypass and a half-empty UI, not a data breach**.

### ⚠︎ OVERTURNED — the PDF's fix adds dead code

The PDF (and draft 1) proposed `!planActive && !application?.via_owner`. **`via_owner` can never
change the outcome.** `getMine` attaches it _only_ to a row selected `WHERE status = 'ACTIVE'`, and
returns that row as `application` — so `via_owner` ⟹ `status === 'ACTIVE'` ⟹ `planActive === true`.
The clause is unreachable, and in a section whose rule is "enumerate what is allowed", adding a
second deny-unless term is the wrong shape — it becomes a live bypass the moment anyone surfaces a
non-ACTIVE owner plan.

**Correct fix:** `if (hasLoaded && !planActive) { navigation.replace('SecureProStatus'); }` — delete
`legacyPro`, add nothing. Family members are already covered by `planActive`.

### Two bigger holes in the same area

1. **The gate fails OPEN on a load error.** `secureProStore.loadApplication`'s catch sets `s.error`
   but **not** `hasLoaded`. Any failed `/pro-applications/me` — offline, 500, the 15s axios timeout,
   a 401 mid-refresh — leaves `hasLoaded === false`, the redirect never runs, and the full dashboard
   renders **for anyone**. That is a bigger hole than the one being fixed.
2. **Nine other Pro screens have no gate at all** — `SecureProCalendar`, `ProAssignedTeam`,
   `ProLiveMission`, `SecureProMissions`, `SecureProMembers`, `ProActivityHistory` … all plain
   `BookingStack` routes, and they cross-link to each other. Fixing only `ProDashboardScreen` closes
   the front door and leaves nine side doors. Needs a shared `useProPlanGate()` applied to the route
   group — this repo's own prescription for the duplicate-copy bug class.

**Product decision still required** on grandfathered `legacyPro` users. Size it with
`pro_active_until IS NULL` (per `subscription.service.ts:319`, NULL marks permanent/comp grants —
the genuinely grandfathered ones, distinct from lapsed payers).

---

# G2 — Controls declared but never wired

Both members are minutes to fix and both survived a full development cycle, because nothing in the
pipeline could see them. This is the strongest argument in the audit for turning CI on.

---

## G2.1 — API-01: every rate limit in auth-service does nothing ⛔ BLOCKED

`app.module.ts` imports `ThrottlerModule.forRoot([...])` and 29 routes carry `@Throttle(...)`. **The
`@Module({})` object has no `providers` array at all.** In `@nestjs/throttler` v6 `@Throttle()` is
metadata; without a guard in the chain it is inert. The module's own comment — _"Route-level
`@Throttle` decorators narrow the limit for /register, /login, /users/lookup"_ — is confidently
wrong, which is why review kept passing over it. messenger-service fixed exactly this
(`{provide: APP_GUARD, useClass: GlobalHttpThrottlerGuard}`) and it was never brought across.

### ⚠︎ Why this is BLOCKED rather than shipped

**(a) The tracker is attacker-controlled, so the headline fix would enforce nothing.**
`main.ts:60` sets `app.set('trust proxy', true)`. Express then takes the **leftmost**
`X-Forwarded-For` as `req.ip`, and nothing strips inbound XFF. An attacker sends a random XFF per
request and lands in a fresh bucket every time — defeating the `/auth/register` and `/auth/login`
limits entirely, which is the _entire point_. They can also spoof a victim's IP to exhaust the
victim's bucket. `auth.controller.ts:23`'s `ip()` helper takes the leftmost XFF too, so every audit
row logs an attacker-chosen IP. **`app.set('trust proxy', 1)` (or the LB's CIDR) must land first**,
after confirming the real hop count — otherwise G2.1 ships a control that reads correctly and
enforces nothing, which is the literal definition of this group's root cause.

**(b) The default ceiling is several-fold below normal traffic — binding the guard is an outage.**
Measured, per handler per IP, against a 100 req / 10 min default:

| Route                                                             | Legit load / 10 min   |            |
| ----------------------------------------------------------------- | --------------------- | ---------- |
| `GET /ops/sos` (SWR @2s, mounted on **every** ops-console page)   | **~300 per open tab** | 3× over    |
| `GET /ops/missions/:id`, `/ops/missions`, `/ops/dispatch/monitor` | **~300 each**         | 3× over    |
| `GET /agents/me/missions/:id/deployment` (3s + 8s pollers)        | **~275**              | 2.75× over |
| `POST /agents/me/missions/:id/telemetry`                          | **~186**              | over       |
| `GET /telemetry/:bookingId/latest`                                | **~120**              | over       |

Shipping this takes down the ops-console SOS alert bar — the panic surface — within ~3.5 minutes of
opening the console. NAT multiplies it further, and because APP_GUARDs run _before_ `JwtAuthGuard`,
the tracker is the IP, not the user.

**(c) Stripe webhooks would be throttled.** Both webhook routes are public and bind no guard; all
deliveries arrive from a small egress IP set → one bucket. 429 → Stripe retries for 3 days → more
429s. It also **silently voids G4.2**: dedupe is moot if events are rejected at the guard.
`@SkipThrottle()` is used **nowhere** in this repo today.

**(d) Health checks.** `/health`, `/ready`, `/metrics` bind no guard and carry no `@SkipThrottle`. A
5s liveness probe = 120/10 min > 100 → `/ready` 429s → the orchestrator pulls the pod → crashloop.

### The correct sequence

1. `app.set('trust proxy', 1)` (or LB CIDR list) — **prerequisite**.
2. Copy messenger's `GlobalHttpThrottlerGuard` (its skip logic is **mandatory**: 8 auth controllers
   already bind `UserThrottlerGuard` at class level, and a bare `ThrottlerGuard` would re-apply each
   route's own tight `@Throttle` on an _IP_ bucket — turning `sos.controller.ts`'s
   `{limit:3, ttl:60s}` into **3 panic raises per minute per IP**, resurrecting the exact NAT bug
   that file's comment says audit fix #12 killed).
3. `@SkipThrottle()` on `HealthController` and both `stripe-webhook` routes.
4. Raise the module default well above measured peak (`{ttl: 60_000, limit: 120}`) as an abuse
   ceiling, leaving per-route `@Throttle`s as the real limits.
5. Ship one release in **shadow mode** (log-only) so production traffic proves the ceiling.
6. Emit `Retry-After` and honour it client-side — nothing backs off on a 429 today.
7. Redis-backed `ThrottlerStorage`, or accept per-replica limits (note: `forRoot([...])` array form
   **ignores** `options.storage`; it is honoured only in the object form).

**Per-phone SMS counter — wrong layer as specified.** `otp.send()` has **two** callers (register
_and_ login); a counter in `register` alone leaves login unmetered — the "one layer out" shape.
Put it in `OtpService.send()`. And stop calling it the rotation defence: it is per-destination, the
same axis Twilio already enforces; against 50,000 distinct numbers, 3-per-number still permits
150,000 SMS. Key it on the **normalized** E.164 value (B-154 double-prefix class).

---

## G2.2 — SEC-01: JWTs work with an empty secret

```ts
return new TextEncoder().encode(this.config.get<string>('jwt.accessSecret') ?? '');
```

`configuration.ts:35` defaults it to `''`. Signing and verifying HS256 with a zero-length key is
**self-consistent** — the service boots, tokens round-trip, every test passes. Nothing looks wrong
until someone else signs `{sub: <any user>, role: 'admin'}` with the same empty key. The `?? ''` is a
TypeScript-strictness reflex: `config.get` returns `string | undefined`, the compiler demands a
default, and `''` is the shortest thing that compiles. The type system was satisfied; the security
property was not.

Aggravating: `configuration.ts:36` falls `actionSecret` back to `accessSecret`, so a File Vault MFA
step-up token and an ordinary session token can share a key. And `bootstrap-staging.sh:87-98` copies
`auth.env.example` verbatim, which contains the literal
`JWT_ACCESS_SECRET=<replace-with-output-of-openssl-rand-base64-64>` — **not empty**, so an
empty-check alone would not save us.

The same file already knows better: `totpEncryptionKey()` fails closed in production and
`TotpCryptoService.encKey()` rejects a placeholder. The pattern was never applied to JWT.

### ⚠︎ OVERTURNED — where the check goes, and what to check

- **Not in the getter.** auth-service has **no global exception filter**, so a throwing getter
  becomes a bare 500 on the sign path and — because `JwtAuthGuard` catches everything and rethrows
  `UnauthorizedException('invalid_token')` — a **misleading 401** on every authed route. Fail once,
  loudly, at boot.
- **Not in `main.ts` either**, at least not at the dev-flag block: that runs _before_
  `NestFactory.create`, so it would have to re-read `process.env` and re-implement the rule — two
  copies of one rule. **Put it in `configuration.ts` beside `totpEncryptionKey()`**, which already
  throws at config-load inside `ConfigModule.forRoot({load:[configuration]})`.
- **A length rule alone green-lights the one published secret in the tree.**
  `docker-compose.yml:33` ships `JWT_ACCESS_SECRET: 'dev-access-secret-do-not-use-in-prod-xxxxxxxxxxxxxxxx'`
  — 53 chars, no angle brackets, passes both `length >= 32` and `/^<.*>$/`. **Add an explicit
  denylist of the repo's own literals.** Keep the floor at `>= 32`: existing fixtures are 35 chars,
  and `>= 64` would break them.

### Blast radius — verified, and better than feared

Checked on `bravo-staging-auth` (booleans only, no values read):

```
access: len=64  placeholder=false  blank=false
action: len=88  placeholder=false  blank=false
action_equals_access=false
```

- **No mass logout.** Refresh tokens are **not JWTs** — `newRefreshToken()` is 48 random bytes and
  only the SHA-256 hash is stored; `/auth/refresh` looks the device up by hash. Outstanding access
  JWTs 401 and the client's interceptor immediately refreshes and replays. Cost: one round-trip.
- **Removing the `actionSecret → accessSecret` fallback cannot break a live token.** auth-service
  only _signs_ action tokens; messenger-service only _verifies_ them, with its own
  `JWT_ACTION_SECRET` and **no fallback**. If auth were falling back, messenger would need
  action == access, which its own getter rejects. So MFA either already works with distinct secrets
  (removal is a no-op) or is already dead.
- **⚠︎ The check that matters was not the one the PDF asked for.** The binding requirement is that
  `JWT_ACTION_SECRET` is **identical** on auth and messenger, not merely "present and distinct".
  And `infra/env/messenger.env.example` has **no `JWT_ACTION_SECRET` line at all** — so
  `bootstrap-staging.sh` produces auth-with-a-secret and messenger-with-none, meaning **File Vault
  MFA and recipient-purge are dead on arrival in every templated environment**. Add it to the
  messenger template with a must-match comment.
- **A third consumer of `actionSecret` the PDF misses:** mission/booking verify codes
  (`booking.service.ts:1609`, `agent.service.ts:1996`, `dispatch/verify-code.util.ts:35`) use it as a
  raw HMAC key. `verify-code.util.ts:18` says it outright: _"Rotating JWT_ACTION_SECRET also
  invalidates every outstanding code at once."_ Rotating mid-mission invalidates every team/verify
  code clients and CPOs are holding. Rotate in a window.
- Issuer/audience are a second, independent drift vector (auth hardcodes them; messenger reads env).
  Assert those too.

---

# G3 — Two factors collapsed into one ✅ FIXED

## SEC-02: TOTP on its own logs you in

### Why it happened

```ts
@UseGuards(JwtAuthGuard)
@Post('setup')   setup(...)     // guarded
@Post('verify')                 // NOT guarded
verify(@Body() dto: TotpVerifyDto, @Req() req) { return this.totp.verify(dto, ip(req)); }
```

`TotpVerifyDto` carried `userId` **from the request body**, and on a valid code the service called
`authService.issueSession(...)` and returned real access + refresh tokens.

The guard asymmetry is the tell. `setup` needs a session because you must be logged in to enrol.
`verify` cannot require an _access_ token at login time — so the guard was simply dropped, and with
it any proof that a first factor ever happened.

### ⚠︎ OVERTURNED — the fix is a guard, not a pending-login token

Draft 1 specified a pending-login token and a **3-phase API-contract rollout** to protect shipped
clients. **There are no shipped clients.** Verified: `grep -rn "auth/totp" src/ apps/ops-console/src/`
returns exactly **one** hit and it is a **docstring** in `vault/vaultClient.ts`. ops-console's login
uses the SMS OTP; `VaultOTPVerifyScreen` is hard-disabled (`VAULT_RESET_BACKEND_AVAILABLE = false`);
`AuthService.login` has no TOTP branch at all and always sends an SMS. The endpoint's own OpenAPI
spec already describes it as _"the second half of a step-up auth flow (bearer + TOTP code)"_ — the
implementation contradicted its own contract.

**So the whole 3-phase rollout was unnecessary, and the "legacy branch behind a flag" it recommended
would have been actively harmful** — a config surface keeping the vulnerability one env var away in
every environment.

### ⚠︎ OVERTURNED — "require `verified_at IS NOT NULL`" would have been a permanent deadlock

Draft 1 called this "safe to enforce immediately". It is the most dangerous line in the draft.
`verified_at` is written in exactly **one** place in the backend — inside `verify()` itself — and
`setup()` explicitly resets it to NULL. There is no confirm endpoint. Requiring it inside `verify()`
means it can only be set by `verify()`, which refuses to run until it is set: **TOTP enrolment
becomes impossible forever**, and any existing user who re-runs `setup()` bricks their own TOTP.
Not shipped. With the guard in place, enrolment (setup authed → verify authed) works and the stamp
is preserved.

### What shipped

| Change                                                                                   | File                                           |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `@UseGuards(JwtAuthGuard)` on `verify`                                                   | `totp.controller.ts`                           |
| `userId` **removed** from the DTO; account taken from `@CurrentUser().sub`               | `dto/totp-verify.dto.ts`, `totp.controller.ts` |
| `verify(userId, dto, ip)` — id is a parameter, never a body field                        | `totp.service.ts`                              |
| `verifyCode` returns the matched step **delta** (`number \| null`) instead of a boolean  | `totp-crypto.service.ts`                       |
| Replay protection: `claimTotpCounter(userId, floor(now/30) + delta)` via `SET NX EX 150` | `redis.service.ts`, `totp.service.ts`          |
| Backup code consume: one atomic `UPDATE … WHERE used_at IS NULL RETURNING id`            | `totp.service.ts`                              |
| User lookup gained `AND suspended_at IS NULL`                                            | `totp.service.ts`                              |
| `verified_at` stamp moved **after** the user lookup                                      | `totp.service.ts`                              |

**Why the guard alone was not enough:** with only a guard, any authenticated user could post someone
else's `userId` and receive a session for that account — a privilege escalation strictly worse than
the original bug. Binding the account to the token is the load-bearing half.

**Why the delta, not the server clock.** With `window: 1` the codes for t-1, t and t+1 all validate.
Claiming the _server's_ step would leave the other two replayable, and would permanently lock out a
user whose authenticator runs a step slow. Sign confirmed empirically against the installed
`otpauth` (`delta = i - counter`, so matched = current + delta; a previous-step token returns `-1`).
Callers must keep testing `!== null` — **delta 0 is valid and falsy**.

**Backup codes were NOT correctly single-use**, contrary to the PDF: `SELECT … WHERE used_at IS NULL`
then a separate unconditional `UPDATE` is a TOCTOU — two concurrent posts of one code both passed the
SELECT and both got a session. Now one atomic statement.

**Gates:** `totp.security.spec.ts` (new, 7 cases) proven RED first — it failed to compile, because the
safe signature did not exist. `totp.service.spec.ts` and `totp-crypto.service.spec.ts` were
**updated, not deleted**, per the bug-regression contract. **40/40 pass.**

### Residual, recorded deliberately

- **SMS-OTP remains an independent full-session entrypoint.** `login` never reads
  `auth_totp_secrets`, so TOTP and SMS are two parallel paths, not first/second factors. This fix
  closes "TOTP alone logs you in"; it does not make TOTP a _second_ factor. Doing that means adding
  a TOTP-required branch to `login`.
- A replayed code counts toward the 10-attempt lockout. Harmless now: the account comes from the
  token, so a caller can only ever lock out **themselves**.
- `docs/openapi/bravo-auth-service.yaml` still documents `userId` in the body — owed.

---

# G4 — At-least-once money treated as exactly-once

Stripe guarantees _at-least-once_ delivery inbound and offers idempotency keys outbound. We use
neither. The repo already knows better — `wallet.service.ts:1234` dedupes by selecting
`WHERE stripe_intent_id = $1 AND status = 'pending'`, so a replay finds no pending row and no-ops.

**`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are UNSET on `bravo-staging-auth`** — neither fix
can be exercised end-to-end on staging.

## G4.1 — API-04: no Stripe idempotency keys ⚠︎ REDESIGNED

**The PDF's premise is wrong.** `/subscription/pro` does **not** charge the card for the first
period — it debits **Bravo Credits** in a transaction, and only then optionally calls
`enableAutoRenew`, whose throw is _caught and swallowed_ (HTTP 200, `auto_renew:false`). So a retry
double-spends **2000/5000 BC**, and a Stripe key on `/v1/subscriptions` does nothing about it.

**The orphan is misdiagnosed too.** `enableAutoRenew` unconditionally overwrites
`stripe_subscription_id`, and the stale-sub cancel only fires on a _tier switch_. So a **same-tier**
re-subscribe (renew early, flip auto-renew on, double-tap) creates a second Stripe subscription and
orphans the first, which bills monthly forever with no row pointing at it. Idempotency keys are
irrelevant — the two calls are legitimately distinct, days apart. **Fix:** `SELECT … FOR UPDATE`, and
if `stripe_subscription_id IS NOT NULL`, verify and reuse or cancel before replacing.

**Both proposed keys are unimplementable as written:**

- `sub:${userId}:${tier}:${periodStart}` — `periodStart` does not exist at call time, and is computed
  by Postgres as `GREATEST(…) + INTERVAL '30 days'`, so a retry yields T+60d where the first yielded
  T+30d: **a different key every attempt**, i.e. the "random key" failure wearing a determinism
  costume. Anchor instead on the `wallet_transactions` row id already created by `debitForFeature`.
- `topup:${ledgerTxId}` — the row is inserted **after** the Stripe call. Requires a write-ahead
  reorder (insert pending → call Stripe with `topup-<txid>` → update with the intent id), plus a
  `metadata.tx_id` fallback lookup in the webhook for the crash-in-between case.

**A forever-stable key is dangerous, and the repo already documents it.** `src/services/api.ts:1729`:
_"a day-bucketed key replayed the first response for 24 h, so a same-day re-subscribe … silently did
nothing while reporting success."_ Do not re-propose it. Scope keys to a **user-initiated attempt**,
and retry under the same key only on network error / 5xx / 429 — never a 4xx, or a fixed card
replays the original `card_declined` until the key ages out.

**⚠︎ Applying the STRICT `IdempotencyInterceptor` to `/wallet/topup` is a full purchase outage.**
`walletApi.topUp` sends no header, and the strict interceptor throws
`BadRequestException('idempotency_key_required')` → **nobody on any installed build can buy credits**.
`OptionalIdempotencyInterceptor` exists precisely for this. Both `/subscription/*` routes are already
Optional; going strict breaks any build older than `subscribeKey`.

Two further interceptor defects: it has **no in-flight reservation** (GET → handler → SET), so two
concurrent requests both miss and both execute — and double-tap _is_ the concurrent case; and its
cache key omits the **request body**, so the same key with a different amount replays the wrong
`client_secret`. It would also cache `client_secret` in Redis for 24h, re-opening an exposure the
codebase deliberately closed (DC-14).

## G4.2 — API-06: renewal webhook grants free months ⚠︎ REDESIGNED

`invoice.paid` runs `pro_active_until = GREATEST(COALESCE(pro_active_until, NOW()), NOW()) + INTERVAL '30 days'`
unconditionally; `event.id` is destructured nowhere. Neighbouring branches are naturally convergent,
so the file _looks_ replay-safe on a skim — only the additive branch isn't, and additive is the one
that costs money.

**The real fix is convergence, not dedupe.** Assign from Stripe's own period end:

```sql
pro_active_until = GREATEST(COALESCE(pro_active_until, NOW()), to_timestamp($3))
```

Duplicates and out-of-order deliveries become arithmetic no-ops. This also fixes a bug nobody
flagged: the handler grants exactly 30 days per paid invoice **regardless of the Price's real
interval** — an annual Price under-grants by 11 months.

Corrections to the dedupe table as specified:

- **`rowCount` does not exist in this DB layer.** `db.q` returns `res.rows`. Written literally it is
  a type error; written loosely it is `undefined === 0` → **dedupe silently never fires** and the fix
  ships looking correct. Use `… ON CONFLICT DO NOTHING RETURNING event_id` and test `rows.length`.
- **"Commit the claim before the side effect" is the money-loss design.** Claim commits → process
  dies → Stripe retries → we return early → the grant is never applied and is now _permanently_
  unrecoverable. Put the claim **and** the side effect in one `withTransaction` (the helper exists
  and is used in this same file).
- **Primary key must be `(event_id, handler)`.** Stripe delivers the same `event.id` to _every_
  configured endpoint, and two exist. A shared `event_id` PK means whichever endpoint is delivered
  first claims the id and **the second silently no-ops**. Claim only _after_ the type filter, or the
  wallet endpoint burns event ids for every event type in the account, including `invoice.paid`.
- **Do not add dedupe to the wallet handler.** Its existing `status='pending'` guard is already
  exactly-once _and_ covers the client-confirm path, which produces no Stripe event at all.
- `verifyWebhook` reads a **single** `stripe.webhookSecret`, but Stripe issues a distinct signing
  secret **per endpoint**. With two endpoints registered, at most one verifies.
- Retention sweep: add a `DELETE … < NOW() - INTERVAL '90 days'` to the existing `ProLapseCron.tick()`
  (no `@nestjs/schedule` in this repo, deliberately), replica-locked, plus an index on `processed_at`.

### A live money bug found while reviewing, in scope for this group

**A declined-then-retried top-up charges the user, credits nothing, and reports success.** Stripe
permits re-confirming a failed PaymentIntent. Decline → `payment_intent.payment_failed` marks the row
**terminally** `failed` with no status guard → the retry succeeds → `payment_intent.succeeded` looks
up `AND status='pending'`, finds nothing, logs "unknown pending intent" → **no credit** → the client's
`confirmTopUp` sees `status !== 'pending'` and returns early **with `credits_awarded: tx.amount_credits`**
→ the UI says "N BC added". Fix: make `payment_failed` non-terminal, and return `credits_awarded: 0`
for a `failed` row.

---

# G5 — No deadline on third-party I/O

Node's `fetch` has **no default request timeout**; a server that accepts and then stalls holds our
promise ~5 minutes. Missing on Stripe (4 sites), Mapbox directions/geocode/keypoints, GDELT, and
device attestation (a raw `https.request` with no `setTimeout`, no `timeout:` option and no
`'timeout'` listener — a stalled socket never settles).

**We clearly know the pattern**: `newsdata`, `googlenews` and `newsfeed` all pass
`AbortSignal.timeout(6_000)`. It got applied to the low-value news feeds and skipped on payments —
even inside `vbg.service.ts`, where the Overpass call is timed and the Mapbox call 30 lines later is
not.

Refinements from critique (several overturn the PDF):

- **Sequence after G4.1** (X2) — a timeout without an idempotency key converts a hang into a double
  charge. **And the dangerous route is the opposite of the one the PDF names:** `/wallet/topup` does
  _not_ move money (`automatic_payment_methods`; the card is charged later by the client's
  PaymentSheet), whereas `/subscription/*` charges **synchronously**
  (`payment_behavior=error_if_incomplete`).
- **⚠︎ A subscription timeout currently manufactures the very orphan G4.1 is trying to prevent.**
  `subscription.service.ts:174-180` catches and logs, returning **HTTP 200, `auto_renew:false`** —
  while a live auto-renewing Stripe subscription exists that `users.stripe_subscription_id` never
  recorded. Adding a timeout makes this _more_ likely. A timeout must resolve to **"unknown"**, not
  "off": write `pro_renew_status = 'reconcile_pending'` and let the reconciliation job settle it.
- **⚠︎ Do not inline `AbortSignal.timeout` at nine sites — this repo already has the helper, twice**
  (`packages/messenger-core/src/transport/fetchWithTimeout.ts`, `src/modules/news/httpTimeout.ts`).
  A third inline copy is the duplicate-copy bug class. Add one
  `apps/auth-service/src/common/http/fetchWithDeadline.ts` (auth-service cannot import
  `@bravo/messenger-core`). **Critically, the two primitives throw different errors** — measured:
  `AbortController.abort()` → `AbortError`, `AbortSignal.timeout()` → `TimeoutError`. The existing
  classifier tests `name === 'AbortError'` and would **not** recognise a timeout. The new
  `isDeadlineError` must match **both**.
- Map deadline errors to **503**, distinct from a decline (402) and from our own bug (500). There is
  no global exception filter, so today a `DOMException` becomes a bare 500. While in the file:
  `await res.json()` runs _before_ the `res.ok` check, so a proxy HTML error body throws a
  `SyntaxError` into the same unshaped 500.
- **⚠︎ The Mapbox budget is worse than N×5s.** `keyPoints()` runs Overpass _first_ (2 endpoints ×
  `OVERPASS_BUDGET_MS` = 8s) and only then 4 sequential Mapbox calls: worst case **2×8 + 4×5 = 36s**
  for one request. A per-call timeout is not a deadline — create one shared budget signal in
  `keyPoints()` and combine with `AbortSignal.any`.
- **⚠︎ The PDF's `biometric.service.ts` fix is aimed at a bug that isn't there, and misses the one
  that is.** `req.on('error', reject)` is already wired, so `destroy(err)` _does_ reject — measured.
  But `req.setTimeout` is a socket-**idle** timeout: measured against a server dribbling one byte
  every 300ms, `req.setTimeout(1000)` **never fires** while `AbortSignal.timeout(1000)` rejects
  correctly. A slow-loris or a genuinely slow Play Integrity response still hangs forever. **Replace
  the raw `https.request` with the `fetch` helper**, which bounds headers _and_ body. (iOS returns
  before any I/O, so only Android is affected.)
- `/ready`'s own DB and Redis probes are **un-timed**, and a `try/catch` cannot see a hang — use
  `Promise.race` with a deadline.
- **⚠︎ The PDF's `/health` story does not survive contact with the deployment.** The Docker
  HEALTHCHECK probes **`/auth/health`** (a _different_, also-static route), and there is **no
  orchestrator at all** — `docker-compose.yml` has no auth-service; staging runs a systemd
  `docker run` with `Restart=always`, which restarts on process _exit_, never on unhealthy. Nothing
  polls `/health` or `/ready` continuously. So the conclusion "no automatic recovery" is **true for
  the opposite reason**: nothing acts on health signals whatsoever, and deepening `/health` would
  produce zero recovery. The actionable items are: point the HEALTHCHECK at `/ready`, time-bound
  `/ready`'s probes, and add something that _acts_. Keep `/health` static — liveness must not fail on
  a downstream outage, or you get restart storms.
- **⚠︎ Do NOT build the circuit breaker.** Nothing consumes a 503 (no orchestrator, no LB health
  integration, no retry budget), and a manual kill switch already exists and is free:
  `stripe.client.ts:40` `get enabled()` is `!!secretKey`, and every method already degrades to
  `503 stripe_disabled` with a documented BC-only fallback. An operator unsetting
  `STRIPE_SECRET_KEY` _is_ the breaker, with a human deciding when to trip it. Adding stateful
  per-process breaker logic on top of nine new timeout sites and an idempotency refactor — on the one
  path where a bug costs real money — is the wrong risk, for a stall this repo has never observed.

---

# G6 — Attacker-controlled input picks the security path

## G6.1 — CRY-01: attachment integrity check can be skipped ⚠︎ REDESIGNED (much smaller)

`decryptAttachment` decides **whether to verify the MAC based on the first byte of the blob it just
downloaded**, and that byte is attacker-controlled. The sealed envelope carries no authenticated
"this must be v2" flag. This is **version-negotiation-before-authentication** — the same shape as TLS
downgrade. The encrypt-then-MAC construction is correct; **the bug is only the branch selector.**

Someone who can modify stored ciphertext — a storage or server compromise, explicitly in our threat
model — prepends `0x01`, we take the legacy branch and AES-CBC-decrypt with **no integrity check**,
and CBC malleability returns: targeted bit-flips produce attacker-chosen changes in a document or
image that renders as authentic **from a verified sender**.

### ⚠︎ OVERTURNED — the PDF's fix is architecturally impossible; the right fix is ~6 lines

The PDF says "have `mediaClient.downloadEncrypted` pass `expectedFormat` through from the envelope."
**The envelope is not in scope there.** It is parsed once at receive and its fields are written to DB
columns; downloads read the _row_. A photo opened after an app restart has no envelope. Threading it
would mean persisting `media_meta.format`, populating **both** drifted copies of
`attachmentMediaMeta`, and carrying it through `backupWireV3` / `restoreMessages` / `messageMirror` /
`mirrorBootstrap` — dragging in the BACKUP_LOOP contract.

**And v1 never existed.** Git proves it: the initial implementation (`0b5f371`) had **no version byte
at all**, and `FORMAT_V1` and `FORMAT_V2` were introduced **together** in `e69fd03`. So `0x01` was
never produced by any commit, ever — that branch is 100% attacker-only. The no-version branch maps to
a real 17-day window at app version ≤ 1.0.12 (current: 1.0.218), and is _already_ probabilistically
broken: a raw blob's first byte is random ciphertext, so ~0.78% of legacy blobs already take the
wrong branch and fail.

**Therefore: require v2 unconditionally and delete both legacy branches.** The MAC already covers the
version byte (`macInput[0] = FORMAT_V2`), so once v2 is required the version is authenticated for
free — no envelope field, no DB column, no backup-wire change. No test covers the legacy branches, so
deleting breaks nothing. Gate on an R2 survey of the oldest objects' first byte before deleting the
no-version branch.

Also noted: `src/modules/messenger/crypto/sealedSender.ts` is **dead code** (the barrel re-exports
messenger-core instead) and is **already drifted** — missing `isForwarded`/`mentions`/`edit`/
`deleteFor`. Delete it or it will be "fixed" by someone eventually. If any field ever _is_ added to
the envelope, it must go inside `attachment` — the top-level and `aad` key-iteration guards reject
unknown keys and would **destroy every message from a new sender to an old receiver**.

## G6.2 — CLI-01: session tokens in plaintext storage ⚠︎ the PDF understates this

`src/services/api.ts` keeps both tokens in `AsyncStorage` — on Android an unencrypted SQLite file,
readable by root and captured by `adb backup`. The reason is ordinary: `AsyncStorage` was there on
day one, and when the Keychain helper arrived it was written _for the SQLCipher database key_ and
correctly scoped to that job. Nobody went back.

### ⚠︎ OVERTURNED — "the access token is low-value because it's 15 minutes" is false

`POST /auth/keys/upload` is guarded by `JwtAuthGuard` alone, and its handler does
`INSERT … ON CONFLICT (user_id, device_id) DO UPDATE SET identity_key = …`. **A stolen access token
overwrites the victim's Signal identity key.** Every peer that later calls `fetchBundle` receives the
_attacker's_ identity, and all future messages are encrypted to the attacker. `identityRotated` is
computed and merely reported, never blocked — and the cover is perfect, because identity keys already
silently self-rotate ~30 days after install. A bare access token also mints a 1-hour **sender
certificate**. Fifteen minutes bounds the window of _use_, not the damage: the damage is permanent,
silent E2EE identity takeover.

Credit where due: `/auth/messenger-ticket` explicitly refuses the Bearer path for exactly this
amplification class — so the codebase already recognises the pattern and `/auth/keys/upload` is the
one that got missed. **Gating `/auth/keys/upload` on identity rotation (require fresh re-auth when
`identityRotated`) retires more risk than the entire client-side token move.**

### ⚠︎ OVERTURNED — the "refresh-token-only" split had a false justification

Draft 1 scoped the move to the refresh token because "the refresh path always runs foregrounded".
**It does not.** `refreshAccessTokenShared` is called from **four headless modules** —
`serverWakeNotifications`, `fcmBootstrap`, `pendingActions`, `headlessDrain`. Keychain's
`WHEN_UNLOCKED_THIS_DEVICE_ONLY` returns nothing on a locked device, and push wakes arrive on locked
devices constantly. Worse, `refreshAccessToken` throws `'No refresh token'` on a falsy read, which
`api.ts:126` classifies as `authFailed` → `multiRemove` + `emitAuthLost`. **A push arriving on a
locked phone would log the user out.**

The split may still be the right call on blast-radius grounds — but it needs a distinct
`KeychainUnavailableError` excluded from the `authFailed` branch, or B-15b turns from "history gone"
into "everyone logged out".

Other required work the draft missed: **no global Keychain jest mock exists** (38 test files
reference `services/api`) — land the mock first; `keychain.ts` is entirely **userId-scoped** but the
refresh token must be readable before the userId is known, so it needs an unscoped service name;
`tokenStore` is **not** the choke point (`refreshAccessToken` bypasses it and writes AsyncStorage
raw — six sites, not one); and sign-out must explicitly destroy the Keychain entry or the token
outlives logout forever.

**CLI-02 (no TLS pinning) compounds this**: an MITM with a rogue CA obtains the access token and
thereby permanent E2EE identity takeover. Pinning, the plaintext token, and the ungated
`/auth/keys/upload` should be assessed together, not filed in three places.

---

# G7 — The gate that guards the gates

`productionRuntime.ts` is ~10,000 lines — the whole send path — and **no test can import it** (native
`op-sqlite`). Static source scans are its only defence, and B-125 shipped critical data loss on a
fully green suite. If CI turns on while these scans behave differently on Linux, we get a green badge
over an unguarded code path — **worse than no CI, because it manufactures confidence.**

**Four of the five files were already fixed** in `1f443c7`. What remains:

### ⚠︎ OVERTURNED — the renormalise step is nearly a no-op, and is dangerous as written

The PDF prescribes `.gitattributes` + `git add --renormalize .` in its own commit, implying a
tree-wide rewrite. **Measured: the index is already 2382 LF.** Exactly **two** files would be
rewritten — and one of them is `patches/react-native-argon2+4.0.0.patch`, which is `i/mixed`.
`patch-package` matches context lines byte-for-byte, so rewriting it **breaks `npm install`**.

The 2095 "CRLF files" are CRLF in the **working tree** (local `core.autocrlf=true`) and LF in the
index — which is precisely why the scans must normalise, and why adding `text eol=lf` would rewrite
every Windows developer's working copy on the next checkout.

**⚠︎ And `patch-package` makes the renormalise genuinely dangerous, not merely pointless.** That
patch is 815 bytes of **11 CRLF + 5 lone LF**. `package.json`'s `postinstall` is `patch-package`, so
it runs on **every `npm ci`** — including all six CI jobs — and patch-package v8 **hard-fails when
`CI` is set**. Rewriting those bytes risks breaking every CI job and every developer's install, to
normalise one workflow file.

**⚠︎ Use `text=auto`, never a bare `* text`.** A bare `text` force-classifies the 70 files git
detects as binary — a set that includes `src/modules/messenger/backup/backupCrypto.ts`, a real
TypeScript source in the BACKUP_LOOP-guarded crypto path, which git reads as binary because it
embeds a **literal NUL byte** (a `[...].join(' ')`). Running an EOL filter over that file is
stop-condition-adjacent risk for zero benefit.

**✅ SHIPPED:** `.gitattributes` with `* text=auto`, `*.sh text eol=lf` (these are tar-synced to
Contabo from Windows, where a CRLF shebang is a hard "bad interpreter" failure), `patches/** -text`,
and explicit binary globs. Verified afterwards: `backupCrypto.ts` still resolves to `text: auto` and
stays `i/-text`, the argon2 patch resolves to `text: unset`, and `git status` shows **no mass
restaging**. **No renormalise commit was made.**

### ⚠︎ One piece of repo folklore is measurably wrong

CLAUDE.md says a `\n`-anchored regex "matches nothing" on CRLF files and passes vacuously. Measured:
ECMA-262 `LineTerminator` **includes CR**, so `/m` anchors are CR-aware — `/a$/m.test('a\r\nb')` is
`true`. Only a **literal** `\n` inside a pattern or `split('\n')` is CR-unsafe. Three scans a sweep
flagged as "will change behaviour" were re-measured and all three behave **identically** on CRLF and
LF. The `toContain('\r\n')` class is now extinct repo-wide (zero hits). The real Linux hazards are
different, and `scannerPortability.test.ts` should be aimed at them: literal `\n` against file text,
unguarded `readFileSync`, hard-coded `\\` separators, and — the one most likely to actually break CI
and absent from the PDF — **case-mismatched paths**, which work on NTFS and ENOENT on ext4.

### ⚠︎ `describe.skip` is the wrong guard for `frameCryptorParity.test.ts`

`readFileSync` **throws** on a missing file — it does not return `''` — so a missing Kotlin file
already makes the suite red, correctly. The file is mostly _positive_ assertions with only two
negatives; skipping hides the positives, which is backwards given CLAUDE.md's rule that a vacuous
pass is worse than a failure. Prefer `expect(existsSync(KOTLIN)).toBe(true)` plus a non-empty
assertion on each read. (Correction to the PDF: `android/` is **not** gitignored for this path — all
four targets are git-tracked, so a fresh Linux clone does find them.)

### ⚠︎ "Then turn CI on" is NOT executable today — four hard blockers, none in the PDF

`ci.yml` is **already live** on `push`/`pull_request` to `main`, so "enable CI" means branch
protection, not a file change. It fails on its first run for reasons the PDF never names — measured:

| #   | Job                          | Why it fails                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **TypeScript**               | `npm run typecheck` is raw `tsc --noEmit`. **Measured: 43 errors, exit 2.** The 47-error baseline lives **only** in `.husky/pre-push` — the script CI runs has no baseline wrapper. So the local ratchet is green (43 ≤ 47) while CI is red.                                                                                                                                                                                                                                 |
| 2   | **ESLint**                   | `--max-warnings=0`. **Measured: 6 errors + 169 warnings.** It fails on the _errors_ first: 3 parse errors (`scripts/e2e-*.ts` sit outside `tsconfig.json`'s `include`, so `parserOptions.project` cannot parse them), one `eqeqeq`, two `no-misused-promises`.                                                                                                                                                                                                               |
| 3   | **gitleaks**                 | `fetch-depth: 0`, `--exit-code=1`. Two tracked files fall outside the allowlist: root `GoogleService-Info.plist` (allowlist is anchored to `ios/.*`, and no tracked `ios/` copy exists) and `.env.production` (allowlist is anchored to `.env.example`).                                                                                                                                                                                                                     |
| 4   | **auth-service integration** | **Passes VACUOUSLY** — `@testcontainers/postgresql` is not in `apps/auth-service/package.json` and has zero lockfile hits. `MODULE_NOT_FOUND` → `bootIntegrationDb()` returns false → every test body short-circuits, and because `describeIfDb` is evaluated at module load the suites report **passed**, not skipped. The workflow comment claims they run. **This is precisely the manufactured-confidence failure G7 exists to prevent, inside G7's own enabling step.** |

Also: `ci.yml` publishes **11** check names, not 9 (`Jest (${{ matrix.project }})` interpolates into
three); two jobs are pure decoration (`continue-on-error: true` **and** `|| true`). Branch protection
currently demands 9 checks that have never existed — re-point at one aggregate job and type the
interpolated names exactly.

### Remaining prerequisites

1. Repair the migration drift (X3) — enabling `ci.yml` while `deploy-migrations.yml` is live on
   `push: main` detonates the 79-migration replay.
2. Rename the two duplicate migration version prefixes.
3. `messenger-crypto` **flakes ~50%** (B-126) and `ci.yml` runs a `fail-fast: false` matrix — a flaky
   red will be the team's first CI experience and they will learn to ignore it. Quarantine first.
4. The `app` project's `testPathIgnorePatterns` **replaces** Jest's default `["/node_modules/"]` and
   never re-adds it — one dependency shipping a `__tests__/` dir turns it red.
5. `scannerPortability.test.ts` will scan 213 test files that call `readFileSync`. Use the
   comment-stripper guarded by `src/__tests__/sourceScanSafety.test.ts` — the house version is
   documented to eat real code when it sees `/*` inside a string — and exclude **self by
   `__filename` identity**, not by name, composing the banned needles at runtime so the scanner
   cannot match its own source.

---

# Execution order (revised)

| Step | Item                                                                                 | Why here                                                             |
| ---- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 0    | Migration-history repair + duplicate prefixes (X3)                                   | Everything DB-shaped is gated on it                                  |
| 1    | Redis persistence (X1)                                                               | Six fixes store security state in an ephemeral Redis                 |
| 2    | **DB-01** ✅ done                                                                    | Critical, isolated, zero server blast radius                         |
| 3    | **SEC-02** ✅ done                                                                   | Critical, and it turned out to be a few lines with no shipped caller |
| 4    | `trust proxy` hop count                                                              | Prerequisite for G2.1 being real                                     |
| 5    | SEC-01 (in `configuration.ts`)                                                       | Minutes; verified safe on staging                                    |
| 6    | CRY-01 (require v2, delete legacy)                                                   | ~6 lines once the redesign is accepted                               |
| 7    | MED-01 — `createUploadUrl` grant **first**, then flip the default                    | The flip alone disables the truncation guard                         |
| 8    | SP-01 — delete `legacyPro`, fix the `hasLoaded` fail-open, add the shared route gate | Product sign-off gates release only                                  |
| 9    | API-06 — convergent assignment + `(event_id, handler)` claim in a transaction        | Stops ongoing revenue leak                                           |
| 10   | API-04 — write-ahead ledger row, Optional interceptor, reuse-or-cancel               | Money paths; needs 9 first                                           |
| 11   | API-05 — timeouts                                                                    | **After** 10, per X2                                                 |
| 12   | API-01 — throttler, shadow mode first                                                | Needs 4; highest outage risk                                         |
| 13   | API-02 — membership authority for both mint sites                                    | Real design work                                                     |
| 14   | CLI-01 — `/auth/keys/upload` gate first, then the token move                         | Largest client blast radius                                          |
| 15   | QA-01 + enable CI                                                                    | Needs 0                                                              |

---

# Critique log — deliberate deviations, so nobody "fixes" them back

| #   | Source says                                                     | This plan does                                               | Reason                                                                                                                                      |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | PDF: add `FORCE`                                                | **Agreed — `FORCE` shipped**                                 | Draft 1 said ENABLE-only; overturned — `20260603100000` applies FORCE to all 70 with a documented rationale, and the owner has `BYPASSRLS`. |
| 2   | PDF: pending-login token + 3-phase rollout for TOTP             | **Guard + bind userId to the JWT**                           | Zero shipped callers; the phased rollout protected nobody and its "legacy flag" would have kept the hole alive.                             |
| 3   | PDF: require `verified_at IS NOT NULL`                          | **Not done**                                                 | It is a permanent enrolment deadlock — `verified_at` is only ever written inside `verify()`.                                                |
| 4   | PDF: `expectedFormat` from the sealed envelope                  | **Require v2, delete legacy branches**                       | No envelope exists at download time; v1 never shipped; the MAC already covers the version byte.                                             |
| 5   | PDF: `!application?.via_owner`                                  | **Delete `legacyPro`, add nothing**                          | `via_owner` ⟹ ACTIVE ⟹ `planActive`; the clause is unreachable dead code.                                                                   |
| 6   | PDF: strict `IdempotencyInterceptor` on `/wallet/topup`         | **Optional variant**                                         | Strict 400s every shipped client → nobody can buy credits.                                                                                  |
| 7   | PDF: dedupe with `rowCount`, commit before the side effect      | **`RETURNING` + one transaction, `(event_id, handler)`**     | `rowCount` doesn't exist here (silent no-dedupe); commit-first permanently loses the grant on a crash.                                      |
| 8   | PDF: `git add --renormalize .`                                  | **`.gitattributes` only, no renormalise**                    | Index is already LF; the blanket rewrite touches a mixed-EOL patch file and breaks `npm install`.                                           |
| 9   | PDF: `describe.skip` when prebuild is absent                    | **Assert existence instead**                                 | `readFileSync` already throws; skipping hides the positive assertions.                                                                      |
| 10  | Draft 1: refresh-token-only because "refresh runs foregrounded" | **Split may stand, justification replaced**                  | Four headless modules drive the refresh path; the stated reason was false.                                                                  |
| 11  | PDF: gate `by-conversation`                                     | **Gate both mint sites; bind membership, not the ring list** | `POST /sfu/rooms` lets any user claim HOST of any conversationId, making ring-list authority circular.                                      |
