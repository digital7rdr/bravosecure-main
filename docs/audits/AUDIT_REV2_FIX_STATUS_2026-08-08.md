# Audit Rev2 — Fix Status Handout (verified 2026-08-08)

**What this is:** an item-by-item check of `BravoSecure_Audit_Rev2_Corrected_1.pdf`
(13 findings, written 3 Aug 2026 against commit `85ab04d`) against the code on
`main` @ `9726523b` as of **2026-08-08**. Every verdict below was verified by
reading the current source — file and symbol cited for each. **No fixes were
made in this pass; this is status only.**

Companion docs:

- `docs/audits/AUDIT_REV2_FIX_PLAN_2026-08-05.md` — the detailed fix plan (971
  lines). It re-verified all 13 findings, **overturned parts of 8 of the PDF's
  proposed fixes**, and defined the corrected designs referenced below.
- Commit `279b9ce3` (2026-08-05) — the fix commit: _"Audit Rev2 — DB-01,
  SEC-01, SEC-02, CRY-01, SP-01 + QA-01 partial"_.

---

## Scoreboard

| #   | ID     | Finding                                  | Status today                                                                    |
| --- | ------ | ---------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | DB-01  | 7 DB tables with no row-level security   | ✅ **FIXED** (+ applied live; 0 of 94 tables RLS-off)                           |
| 2   | API-01 | Rate limits do nothing                   | ❌ **NOT FIXED** — deliberately blocked; prerequisite landed                    |
| 3   | SEC-01 | JWT works with an empty secret           | ✅ **FIXED** (fail-closed at config load)                                       |
| 4   | API-02 | Anyone can join any group call           | ❌ **NOT FIXED** — needs an authority-design decision                           |
| 5   | SP-01  | Cheap subscription unlocks Pro dashboard | ✅ **FIXED** (front door) — ⚠️ 9 side-door screens still ungated                |
| 6   | SEC-02 | TOTP alone logs you in                   | ✅ **FIXED** (all three sub-claims)                                             |
| 7   | API-04 | No Stripe idempotency keys               | ❌ **NOT FIXED**                                                                |
| 8   | API-06 | Renewal webhook grants free months       | ❌ **NOT FIXED** (+ a related live top-up bug, still open)                      |
| 9   | API-05 | No timeouts on outbound calls            | ❌ **NOT FIXED**                                                                |
| 10  | CRY-01 | Attachment integrity check skippable     | ✅ **FIXED** (legacy branches deleted)                                          |
| 11  | CLI-01 | Tokens in plaintext storage              | ❌ **NOT FIXED** (and worse than the PDF says)                                  |
| 12  | MED-01 | Media downloads fail open                | ❌ **CODE NOT FIXED** — staging mitigated by env var only                       |
| 13  | QA-01  | Test suite can't run on Linux            | ✅ **MOSTLY FIXED** — one test file still owed                                  |
| —   | CI     | Turn CI on                               | ⚠️ **PARTIAL** — `ci.yml` is live, but 4 hard blockers before branch protection |

**Bottom line: 5 fixed, 1 mostly fixed, 7 not fixed.** The fixed set is exactly
what commit `279b9ce3` shipped on Aug 5. Nothing from the audit has been fixed
since. The 7 open items are all designed in the fix plan with an execution
order; none of that design work has shipped.

---

## FIXED — verified in code

### 1. DB-01 — RLS on the seven missed tables ✅

**Evidence:** `supabase/migrations/20260805090816_rls_deny_by_default_catchup.sql`
— enables + forces RLS on all seven named tables, then sweeps the whole
catalogue (`pg_class` where `NOT relrowsecurity`), then **asserts inside the
same transaction** that zero public tables remain RLS-off.

- Applied live: the fix-commit gates recorded **0 of 94 public tables RLS-off**.
- Incident check ran 2026-08-05: **CLEAN** — no unrecognised promo codes,
  redemptions, or invite codes. No evidence the writable window was exploited.
- Better than the PDF knew: 4 of the 7 already had RLS on **live** (switched on
  out-of-band, never written back); the real live gap was 3 tables. The
  migration reconciles tree and live.

**Still owed on this item:**

- `supabase/__tests__/rlsCoverage.test.ts` (the audit's "already written" red
  test) **does not exist** — the directory isn't even there. Without it, table
  #8 can ship RLS-off next month exactly like the previous three catch-ups.
- The migration's own comment claims _"the standing gate is the post-`db push`
  assertion in `.github/workflows/deploy-migrations.yml`"_ — **that assertion
  is not in the workflow** (verified: the file runs `supabase db push` and a
  status list, nothing else). Either add the assertion step or fix the comment;
  right now the "permanent fix" the migration defers to doesn't exist.
- X3 (fix plan): migration history is drifted — 79 local files have no remote
  row and there are two duplicate version prefixes. `supabase migration repair`
  is a prerequisite before CI/`db push` automation can be trusted.

### 3. SEC-01 — JWT secrets validated ✅

**Evidence:** `apps/auth-service/src/config/configuration.ts:28-94` —
`jwtSecret()` runs at config load (inside `ConfigModule.forRoot`, i.e. before
the service can serve traffic) and in production **refuses to boot** when a
secret is blank, shorter than 32 chars, the `<replace-me>` placeholder from
`auth.env.example`, or one of the dev secrets published in this repo
(the docker-compose one the PDF's regex would have missed). `actionSecret` no
longer inherits `accessSecret` and must differ, or boot fails.
`jwtSecret.spec.ts` exists in the same directory.

Deliberate deviations from the PDF (see fix-plan critique log — don't "fix"
these back):

- The check lives in `configuration.ts`, **not** the `jwt.service.ts` getter
  (a throwing getter would surface as a misleading 401 on every authed route)
  and **not** `main.ts` (would duplicate the rule). `jwt.service.ts:23` still
  reads `?? ''` — that's fine now because config guarantees a real value.
- `bootstrap-staging.sh` still copies the example env when none exists — but
  the placeholder now **fails boot** instead of silently running, which is the
  outcome the audit wanted. `infra/env/auth.env.example` sets
  `NODE_ENV=production`, so the check is armed on staging.

**Still owed:** `infra/env/messenger.env.example` has no `JWT_ACTION_SECRET`
line, so a templated environment gets auth-with-a-secret and
messenger-with-none → File Vault MFA dead on arrival there (fix-plan G2.2).

### 5. SP-01 — Pro dashboard gate ✅ (front door only)

**Evidence:** `src/screens/pro/ProDashboardScreen.tsx:95-116` — the
`legacyPro = isProActive(user)` admitting term is **deleted**; the gate is now
`if (hasLoaded && !planActive) navigation.replace('SecureProStatus')`. Also
fixed (a bigger hole the PDF missed): `src/store/secureProStore.ts:74-84` — the
load-error catch now sets `hasLoaded = true`, so a failed
`/pro-applications/me` **fails closed** instead of rendering the full dashboard
to anyone offline.

Note: the PDF's proposed `!application?.via_owner` term was **not** added — it
is provably dead code (`via_owner` only ever attaches to an ACTIVE row).

**Still owed:** the other ~9 Pro screens (`SecureProCalendar`,
`ProAssignedTeam`, `ProLiveMission`, `SecureProMissions`, `SecureProMembers`,
`ProActivityHistory`, …) are plain `BookingStack` routes with **no gate at
all** and cross-link to each other. No shared `useProPlanGate()` hook exists
yet (verified: zero hits). The front door is locked; the side doors are not.
Product decision on grandfathered legacy-Pro users also still open.

### 6. SEC-02 — TOTP no longer logs you in on its own ✅

**Evidence:** `apps/auth-service/src/totp/totp.controller.ts:16-34` —
`/auth/totp/verify` now has `@UseGuards(JwtAuthGuard)` and takes the account
**from the JWT** (`user.sub`); `TotpVerifyDto`
(`totp/dto/totp-verify.dto.ts`) no longer carries `userId` at all. So the
"UUID + one 6-digit code = full session" attack is dead: you need a valid
session to call it, making it the step-up route the OpenAPI spec always
described.

The replay sub-claim is fixed too: `totp.service.ts:89-96` claims the
**authenticator's** counter (server step + validate delta) in Redis via
`claimTotpCounter`, so a code is single-use across its whole validity window;
`totp.security.spec.ts` asserts replay rejection (proven RED first). Backup
codes consume atomically, suspended accounts are rejected, and the pre-existing
P0-V2 attempt-lockout still applies.

Deliberate deviations: no pending-login token (no shipped client ever called
this endpoint, so the 3-phase rollout protected nobody), and no
`verified_at IS NOT NULL` requirement (it would deadlock enrolment —
`verified_at` is only ever written inside `verify()`).

### 10. CRY-01 — attachment downgrade attack ✅

**Evidence:** `src/modules/messenger/media/aesCbc.ts:256-273` —
`decryptAttachment` now **throws unless the first byte is v2** (`FORMAT_V2 =
0x02`); the v1 and no-version branches are deleted and the `FORMAT_V1`
constant deliberately removed with a comment explaining why it must never come
back. The HMAC already covers `(version byte ‖ ciphertext)`, so the version is
authenticated with **no envelope or schema change** — smaller and stronger than
the PDF's `expectedFormat` plumbing (which was impossible anyway: no sealed
envelope exists at download time).

Safe because v1 never shipped: `git log -S FORMAT_V1` shows V1/V2 were
introduced together, and the pre-versioning format belonged to app ≤ 1.0.12.

### 13. QA-01 — Linux-portable test suite ✅ mostly

- **`.gitattributes` landed** (`279b9ce3`, Aug 5) with `* text=auto`,
  `*.sh text eol=lf`, `patches/** -text`. Deliberately **no**
  `git add --renormalize .` commit — measured: the index was already LF and the
  renormalise would have rewritten a mixed-EOL patch-package patch and broken
  every `npm ci`. Don't add the renormalise step back.
- **The four CRLF-asserting tests were already fixed** before the audit
  landed (`1f443c7`, 2026-08-04, B-373): `chatScreenMutationUi`,
  `composerSendRace`, `messengerSafeAreaSweep`, `mutationLaneWiring` all
  normalise CRLF away now. Zero `toContain('\r\n')` hits repo-wide (verified).
- **`frameCryptorParity.test.ts` fails loudly** on a missing native file
  (`beforeAll` throws — lines 48-67) instead of the PDF's `describe.skip`,
  which would have hidden its positive assertions. Correction to the PDF: all
  four parity targets **are git-tracked** (verified with `git ls-files`), so a
  fresh Linux clone does find them.

**Still owed:** `src/__tests__/scannerPortability.test.ts` does not exist. Per
the fix plan it should target the _real_ Linux hazards — literal `\n` against
file text, unguarded `readFileSync`, hard-coded `\\` separators, and
**case-mismatched paths** (work on NTFS, ENOENT on ext4) — not the CRLF class,
which is extinct. And green-on-Linux has not been demonstrated by an actual CI
run yet.

---

## NOT FIXED — with how to fix

> All seven have corrected designs in
> `docs/audits/AUDIT_REV2_FIX_PLAN_2026-08-05.md`. **Follow that plan, not the
> PDF snippets** — the plan overturned parts of the PDF's fixes with measured
> evidence, and its execution order exists for safety reasons (X1/X2/X3
> below). The summaries here are the short version.

### 2. API-01 — rate limits still do nothing ❌ (deliberately blocked)

**Verified today:** `apps/auth-service/src/app.module.ts` still has **no
`providers` array** — no `APP_GUARD`/`ThrottlerGuard` is registered, so every
`@Throttle(...)` on `/auth/register`, `/auth/login`, `/auth/me/password`,
`/wallet/topup`, `/users/lookup` is inert met
