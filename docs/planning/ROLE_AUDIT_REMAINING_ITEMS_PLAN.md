# Role Audit — Remaining Items Resolution Plan

**Date:** 2026-07-07
**Source:** `docs/audits/ROLE_AUDIT_2026-07-07.md` (§3 findings, §6 remediation table)
**Status:** ✅ EXECUTED same day — see audit doc §7 for what shipped per item.
RS-02/RS-09/RS-10/RS-14/RS-16 done; RS-08 partial (audit visibility + regression pin;
signed handover still architecture-gated); RS-03 correctly untouched (withdrawn).
The sections below are kept as the design record.

The 2026-07-07 role-lifecycle remediation (commit `26362c3`) fixed RS-01, RS-04–RS-07,
RS-11–RS-13, RS-15, RS-17–RS-19. Seven items were deliberately **not touched — correctly**:

| Group                        | Items            | Why untouched                                                  |
| ---------------------------- | ---------------- | -------------------------------------------------------------- |
| E2E group-key stop-condition | **RS-02, RS-08** | Touch group master-key handling — architecture sign-off first  |
| Withdrawn / ops rollout      | **RS-03, RS-16** | RS-03 withdrawn (audit error); RS-16 is an env-flag ops action |
| Unbuilt features             | **RS-09, RS-10** | Admin invite flow / CPO⇄manager path are features, not fixes   |
| Human-gated data change      | **RS-14**        | Destructive staging purge — must be run by a human, manually   |

This document is the how-to-solve plan for each. **Nothing here changes current
behavior until each item's own preconditions are met.** The dept-chat rekey seam,
the dormant `TierGuard`, the hard-403 admin-register stub, and the manual script
must all stay exactly as they are until the step that explicitly replaces them.

---

## Rules of engagement (apply to every item)

1. **Stop-conditions hold.** RS-02 and RS-08 touch group master-key distribution /
   rekey-on-removal / E2E admin authority — all explicit stop-conditions in
   `CLAUDE.md` → _Security constraints_. **No code before written architecture
   sign-off** against the System Architecture Documentation.
2. **Change-safety gates** (CLAUDE.md): failing test first where practical; targeted
   suite → broad suite; mobile tsc ≤ baseline (`.tsc-baseline.json`); ops-console
   tsc + build clean; auth-service `npm test` green; never commit on a red gate,
   never `--no-verify`.
3. **Copy the model, don't modify it.** The department-channel membership-intent
   seam (`apps/auth-service/src/department/department.service.ts:415-486`) is the
   reference implementation for RS-02/RS-10 rekey work. It is device-verified and
   live — replicate its pattern; do not refactor it while borrowing from it.
4. **Minimal diffs.** Each item ships alone. No opportunistic renames or cleanups.
5. **Every role/membership write gets an audit row** (`ops_audit` or
   `org_audit_log`) — RS-11 established the `user.role.change` precedent; new
   paths follow it.

---

## 1. RS-02 — Conversation `removeMember` has no rekey seam 🚫 stop-condition

### Current state (leave as-is until sign-off)

- `apps/auth-service/src/conversations/conversations.service.ts:179-213` —
  `removeMember` deletes the `conversation_members` row and does **nothing else**:
  no membership intent, no rekey. A removed member of a mission/DM group keeps
  the group master key indefinitely (forward-secrecy gap).
- The correct model already exists for department channels:
  `department.service.ts:425-440` (`removeMember` → `enqueueIntent('remove')`),
  `:442-450` (`channel_membership_intents` insert), `:452-469`
  (`listMembershipIntents` drained by the admin device), `:472-486`
  (`ackMembershipIntent`). The rekey itself happens **on-device** via the
  messenger-core planners (`packages/messenger-core/src/groups/groupClient.ts`,
  convergent planners ~`:767-972`) — the server never sees the master key.

### Preconditions

- [ ] Architecture sign-off: written approval that conversation (mission/ad-hoc
      group) membership removal adopts the dept-chat intent+on-device-rekey model,
      including who the "admin device" is for mission groups (group admin per
      `conversation_members.role='admin'`) and the epoch-bump semantics.
- [ ] Decision recorded: reuse `channel_membership_intents` generalized, or a new
      `conversation_membership_intents` table (recommendation: **new table**,
      mirrored schema — keeps dept-chat untouched and satisfies rule 3).

### Fix shape (after sign-off — in order)

1. **Migration:** `conversation_membership_intents`
   (`conversation_id, member_user_id, action add|remove, requested_by, state
pending|done, created_at, settled_at`) — mirror of `channel_membership_intents`.
2. **Server:** in `conversations.service.ts:removeMember`, after the DELETE,
   enqueue a `remove` intent. Same for `addMember` (`:168-177`) with `add`
   (dept-chat enqueues both; group-key grant on add already has a path via the
   group create/reshare flow — confirm at sign-off whether add-intent is needed
   or the existing drain covers it).
3. **Server:** intent list/ack endpoints on the conversations controller, gated
   to conversation admins (reuse the `roleOf`/`requireAdmin` helpers,
   `conversations.service.ts:222-235`).
4. **Clients (mobile runtime + ops-console runtime):** extend the existing
   dept-chat intent-drain loop to also poll conversation intents and broadcast
   the remove+rekey using the **existing** groupClient planners — the epoch bump,
   convergent rekey, and G1 epoch-replay guard are already implemented there;
   no new crypto.
5. **Audit:** `conversation.member.remove` (+ `.add`) rows in `ops_audit`.

### Verification

- New unit tests: intent enqueued on remove; ack requires admin; drain planner
  produces a rekey excluding the removed member.
- `npm run test:crypto` (messenger-crypto project) — full pass, zero changes to
  existing group tests.
- Device QA: A removes B from a mission group → B stops decrypting **new**
  messages (old history untouched); remaining members converge on the new epoch;
  removed member's key-request self-heal (B-31/RC2 path) must NOT re-grant.
- Regression: dept-chat add/remove/rekey still works end-to-end (it shares the
  planners).

### Do NOT

- Do not change `department.service.ts`, the planners' epoch logic, sealed-sender
  envelope shape, or the sender-cert path.
- Do not make the server compute or relay any key material — intents carry
  membership facts only (exactly like dept-chat, `department.service.ts:435-437`).

---

## 2. RS-08 — Last-admin auto-promotion is a bare DB flip 🚫 stop-condition

### Current state (leave as-is until sign-off)

- `conversations.service.ts:191-212` — when the last admin leaves, the server
  silently promotes the oldest member to `role='admin'`.
- Ops-console derives E2E admin authority from that roster field:
  `apps/ops-console/src/lib/messenger/groupClientAdapter.ts:80`
  (`admin: m.role === 'admin'`) feeding the `applyAdminAction` gates in
  `groupClient.ts` (~`:429-486`). So a member gains add/remove/rekey power with
  **no cryptographic provenance** — no signed group-admin action in the
  transcript.

### Preconditions

- [ ] Architecture sign-off on the promotion model. Two candidate designs to put
      in front of the architecture owner (decide there, not here):
      **(a) Signed handover** — an admin's departure is only honored with a signed
      `admin-promote` group action naming the successor (leaving admin's device
      emits it before the server roster flip); or
      **(b) Recovery ceremony** — server may flip the roster, but clients treat
      roster-admin-without-signed-lineage as _pending_: the promoted member's
      device must issue a signed rekey/epoch-bump (analogous to the B-35
      OWNER-RECOVERY path) before peers honor its admin actions.
- [ ] RS-02 should land first or together — both touch the same
      `removeMember` seam and the same sign-off review.

### Fix shape (after sign-off)

1. Implement the chosen model in messenger-core (`applyAdminAction` gains a
   provenance check for promotions) + the emitting client path.
2. Server keeps the roster flip (`conversations.service.ts:197-211`) as the
   _availability_ signal but adds an `conversation.admin.autopromote` audit row —
   the crypto layer, not the roster, becomes the authority for admin actions.
3. Backfill/compat: existing groups whose admins were roster-promoted before the
   change must keep working — gate the provenance requirement on a new group
   `epoch`/version marker agreed at sign-off (no retroactive lockout).

### Verification

- `npm run test:crypto` + new tests: promotion without signed action is not
  honored (new-format groups); legacy groups unaffected; replayed promotion at an
  old epoch rejected (G1 guard).
- Device QA: last admin leaves → successor gains admin per the approved ceremony;
  group calls and membership ops keep working across the transition.

### Do NOT

- Do not remove the server-side auto-promotion before the crypto path exists —
  that would strand groups with zero admins (a worse availability bug).

---

## 3. RS-03 — Server Pro paywall ❌ withdrawn (audit error) — nothing to fix

The §3 finding was **factually wrong** and formally withdrawn in §6 + errata:
`booking.service.ts` enforces `tier_insufficient` inline for itinerary bookings
(now expiry-aware after RS-19), and the mobile 403→ProPaywall pipeline
(`src/services/api.ts:105-110` → `MainNavigator`) is live.

### The only correct action today: none

- `TierGuard` / `@RequireTier` (`apps/auth-service/src/common/guards/tier.guard.ts`)
  stays **dormant infrastructure, mounted on no handler**. It was already
  hardened during RS-19 (lapsed `pro_active_until` → effective Lite; NULL =
  permanent comp grant per RS-17) so it is correct whenever it is first mounted.
- **Do not** apply `@RequireTier('pro')` to the shared `POST /bookings` handler —
  it also serves Lite bookings and a blanket guard would 403 every Lite booking
  (the exact mistake the withdrawal caught).

### When it becomes actionable (future trigger, not now)

Only when dedicated Pro-only endpoints land (the intended `/ai/*` itinerary
endpoints, or whatever product picks per the Q3 note in `tier.guard.ts:19-22`):

1. Register `TierGuard` in the owning module's providers.
2. Annotate **only** the Pro-only handlers with `@RequireTier('pro')` (after
   `JwtAuthGuard`, per the guard's doc comment).
3. Tests: Lite user → `403 tier_insufficient`; active Pro → 200; **lapsed** Pro
   (`pro_active_until` in the past, column still `'pro'`) → 403; NULL-expiry comp
   Pro → 200. Re-run the subscription suite
   (`apps/auth-service` `subscription.service.spec.ts`) untouched-green.
4. Mobile needs nothing — the `tier_insufficient` paywall pipeline already exists.

---

## 4. RS-16 — `forbidNonWhitelisted` rollout ⏸️ ops env-flag action, not code

### Current state (already correct in code)

`apps/auth-service/src/main.ts:51-56` — `STRICT_VALIDATION=true` makes the global
`ValidationPipe` reject unknown body fields (400) instead of silently stripping
them. Already `true` in **staging**; prod default stays strip-only so old
in-field APKs sending stale fields don't start failing. Not exploitable today
(no DTO declares `role`); the flag is a tripwire, not a hole.

### Rollout plan (pure ops — zero code changes)

1. **Staging soak check:** confirm no unexpected-400 spike in auth-service logs
   attributable to `forbidNonWhitelisted` since the staging flip (grep structured
   logs for ValidationPipe 400s on `/auth/*`, `/bookings/*`, `/ops/*`).
2. **Prod canary:** set `STRICT_VALIDATION=true` in the prod auth-service `.env`
   and restart that container only, during a low-traffic window. Do **not**
   rotate any secrets in the same operation (known failure class: JWT-secret
   drift between auth and messenger when containers are recreated separately —
   see `docs/runbooks/`, messenger-ws-jwt-secret-drift).
3. **Monitor 24-48h:** 400 rate on `/auth/*`, `/bookings/*`, `/ops/*` vs
   baseline. Any spike → identify the offending client field, fix or wait out the
   old APK, retry.
4. **Rollback:** unset the env var + restart. Behavior returns to strip-only.
5. **(Optional, much later)** once the oldest supported APK is known-clean, flip
   the code default to `true` and delete the flag — that IS a code change and
   goes through the normal gates.

---

## 5. RS-09 — Admin invite flow 🚫 feature (build to the design already on file)

### Current state (keep exactly as-is until the feature ships)

- The self-grant-ADMIN dead code and its DTO were **deleted** in the remediation
  (regression-pinned by `auth.service.spec.ts:446-448`). What remains is a
  deliberate hard-403 stub: `auth.controller.ts:151-156`
  (`POST /auth/admin-register/verify` → `admin_self_registration_disabled`),
  kept routable so monitoring sees probe attempts. **Keep the stub.**
- The target design is already written as `TODO(invite-flow)` at
  `auth.controller.ts:142-148`.
- The login page promises the flow (`apps/ops-console/src/app/login/page.tsx:80`).
- Adjacent gaps to close in the same feature: no endpoint changes
  `admin_users.role` (raw SQL only, zero audit trail), and 8/9 admins are
  SUPERVISOR / 0 OPS — least-privilege isn't exercised.

### Build plan (backend first, then console)

1. **`POST /ops/admin/invites`** — guarded `AdminGuard` + ADMIN-only
   (`RequireRoles('ADMIN')`, matching existing ops RBAC). Body: email + role
   (default **OPS**, not SUPERVISOR — start least-privilege). Server signs a
   single-use JWT (email + role baked in, 24h TTL, `jti` tracked in Redis),
   emails the link. Audit: `admin.invite.create`.
2. **`POST /auth/admin/accept-invite`** — public, throttled like
   `registerVerify` (`auth.controller.ts:128`). Verifies the invite JWT, atomic
   single-use redemption (`DEL jti` from Redis must be the check-and-consume —
   guard the race), creates the `admin_users` row with the **baked-in** role
   (never a client-supplied one — that's the exact vuln that was deleted), sets
   password + TOTP enrollment. Audit: `admin.invite.redeem`.
3. **`PATCH /ops/admin/users/:id/role`** — ADMIN-only role change for
   `admin_users.role`, self-demotion of the last ADMIN forbidden, session revoke
   via the shared `AuthService.revokeAllUserSessions` (the RS-01/DC-04 mechanism),
   audit `admin.role.change`. This closes the "role changes happen by raw SQL"
   gap in the same feature.
4. **Console:** invite management UI (create/list/revoke pending invites) +
   `/admin/accept-invite` page; replace the login-page promise text only when the
   flow actually works.
5. Retire nothing: the 403 stub at `admin-register/verify` stays (monitoring).

### Verification

- New specs: invite create requires ADMIN; redeem is single-use (parallel
  double-redeem race test); expired invite rejected; role comes from the token,
  not the request body; last-ADMIN demotion blocked; audit rows written.
- Regression: full auth-service suite; ops-console tsc + build;
  `authStore.signOut` / login flows untouched.

---

## 6. RS-10 — CPO ⇄ manager org role-change path 🚫 feature

### Current state (the seams assume no path exists)

- `org_members.member_role` is written **once** at creation
  (`apps/auth-service/src/org/org-cpo.service.ts:116`, insert at `:210`); no
  endpoint updates it (only `status`).
- Channel seeding branches on it at `org-cpo.service.ts:65-69`: manager →
  dept-channel `admin` + restricted channels; cpo → `viewer` + open channels.
  A raw DB flip would **not** reseed channels or rekey — silent access-control
  gap if a path is added naively (this is exactly why it wasn't rushed).
- Adjacent gap: any org manager can mint another `manager` via `POST /org/cpos`
  with no ops approval and no audit action.

### Build plan

1. **`PATCH /org/cpos/:memberId/role`** (`OrgManagerGuard`-tenanted; decide at
   design review whether promotions to `manager` require the org **owner** —
   recommended, given the manager-minting gap). Body: `member_role: cpo|manager`.
2. **Transactional side-effects — this is the whole point of the feature:**
   - Update `org_members.member_role`.
   - Reseed `department_channel_members` using the **same branch logic** as
     creation (`org-cpo.service.ts:65-69`): promote → upsert channel `admin` +
     add to restricted channels **with `add` intents**; demote → flip to
     `viewer` + **remove from restricted channels with `remove` intents** so the
     existing on-device rekey seam (`department.service.ts:442-450`) revokes the
     restricted-channel keys. Reuse `department.service.ts` members/role helpers
     (a channel role-change method already exists at `department.service.ts:488+`)
     — do not duplicate the intent machinery.
   - Audit: `member.role` action in `org_audit_log` (first `member.*` action —
     RS-11 called out that none exist).
   - Session handling: org routes fresh-read `member_role`, so no revoke is
     strictly required; a JTI nudge (RS-05 soft-revoke pattern) is optional
     polish for warm-app UI.
3. **Demotion is the security-critical direction** — a demoted manager must lose
   restricted-channel access cryptographically (rekey), not just cosmetically.
   The rekey itself is the existing dept-chat mechanism — **no new crypto, so no
   stop-condition** — but confirm that reading at design review; if review finds
   it touches planner internals after all, it inherits the RS-02 sign-off gate.
4. **Same feature, close the minting gap:** audit `member.add` on
   `POST /org/cpos` and (product decision) require owner/ops approval for
   creating `manager`-role members.
5. **Mobile/console:** roster UI gains promote/demote (org-manager surface);
   promoted/demoted member's app picks the change up via the existing
   AppState-resume `/auth/me` + membership recheck (RS-06 machinery).

### Verification

- Specs: role flip persists; reseed adds/removes the right channels; intents
  enqueued on demotion; tenancy (manager of org A cannot touch org B); audit rows.
- Regression: `org-cpo.service.spec.ts`, dept-chat suites, booking project
  untouched-green; device QA — demote a manager, verify they can no longer read
  **new** messages in restricted channels after the admin device drains intents.

---

## 7. RS-14 — E2E fixture purge 🟡 prepared; run manually, human-gated

### Current state

`scripts/manual/RS-14_purge_e2e_agent_fixtures.sql` — deliberately under
`scripts/manual/` (NOT `supabase/migrations/`) so no pipeline ever auto-runs it.
Targets the 3 staging accounts `role='agent'`, `display_name='E2E CPO Agent'`,
with no `agents` row. **Never move or convert this file into a migration.**

### Runbook (a human executes this, step by step)

1. **Identify:** run the script's step-1 SELECT against staging Supabase
   (`qkkfkicgoncxslbwhyhz`) — via the Supabase MCP `execute_sql` or SQL editor.
   **Expect exactly 3 rows.** Any other count → STOP, re-audit, do not proceed.
2. **Choose 2a (soft delete) — recommended, and the script says so:** uncomment
   and run the `UPDATE … SET deleted_at = now()` block. Soft delete is
   reversible and honored by the live queries (`deleted_at IS NULL` filters,
   e.g. `tier.guard.ts:61`).
3. Re-run the step-1 SELECT filtered `deleted_at IS NULL` → **expect 0 rows.**
4. **Hard delete (2b) only if actually required:** be aware of the script's own
   caveats — `public.users` does not cascade up to `auth.users`, and dependent
   FKs may block the delete. If a hard delete is truly wanted, enumerate FK
   references first and stop at the first surprise.
5. **Record the run:** append the executed SQL + row counts + date to `sqa.md`
   (per project convention) and mark RS-14 ✅ in
   `docs/audits/ROLE_AUDIT_2026-07-07.md` §6.
6. Out of scope, already documented: the historical terminate-semantics drift
   (one old terminate deleted the `agents` row; newer ones set `REJECTED`) is a
   data-history note, not something to "fix" retroactively.

---

## Recommended execution order

| #   | Item          | Effort              | Blocker                                                          |
| --- | ------------- | ------------------- | ---------------------------------------------------------------- |
| 1   | RS-14         | ~10 min, manual     | A human at the SQL console                                       |
| 2   | RS-16         | Ops only            | Prod canary window + 24-48h monitoring                           |
| 3   | RS-09         | Feature, ~1 session | Email-send capability for invite links                           |
| 4   | RS-10         | Feature, ~1 session | Design decision: owner-only manager promotion                    |
| 5   | RS-02 + RS-08 | Feature-sized       | **Architecture sign-off — request it now**; implement only after |
| —   | RS-03         | **None**            | Withdrawn; act only when `/ai/*` Pro endpoints exist             |

The single action available immediately with zero risk: **draft the RS-02/RS-08
sign-off request** (the designs in §1–§2 above are the material) and hand RS-14's
runbook to whoever owns staging data.
