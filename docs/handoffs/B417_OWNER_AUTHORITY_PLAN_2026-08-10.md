# B-417 fix plan — restore owner key authority for workspace-joined owners, plus demotion stranded-claims discoverability

Date: 2026-08-10 · Status: PLAN (awaiting critic GO) · Builds on B-416 (claimed key authority, deployed)

## Part A — B-417: the workspace-joined agency owner loses the drain

### The defect (verified chain, all file:line checked this session)

1. Phase B (2026-08-09) lets an agency owner join another org's workspace
   (`enterprise-join.service.ts` owner refusals removed).
2. Their `/auth/me` then resolves `org` NON-NULL: `deriveAccountKind`'s four-arm
   precedence (`account-kind.ts:249-252`) — arm 2 suppressed
   (`member_org_is_workspace` true), arm 3 false (an agency owner owns no
   `org_workspaces` row), arm 4 `?? row.org_user_id` = the joined workspace.
3. `isOpsRoomKeyAuthority` (`dispatchRoomIntents.ts:59`) owner arm is
   `(account_kind === 'agency' && !u.org)` → **false** → their device stops
   draining/claiming their own agency's Ops Rooms entirely. Managers still
   rescue NEW rooms via claims; legacy rooms seeded to the owner stay stuck.
4. The SERVER side is NOT broken for this persona: OrgManagerGuard Path 1
   (`org-manager.guard.ts:70-79`, ACTIVE company agent → org = own id) runs
   BEFORE the workspace-owner and delegated-manager paths, so the owner's
   drain/claim calls would succeed if the client ever made them. The whole
   defect is the client-side proxy discriminator `!org`.

### The fix — expose the direct fact, stop inferring from `org`

Same medicine that fixed the manager arm (`managed_org` was minted precisely to
escape proxy-discriminator rot):

**Server (auth-service):**

- `AccountKindResult` gains `owns_agency: boolean` =
  `row.agent_type === 'company' && row.agent_status === 'ACTIVE'`
  (`isCompanyAgent` is already computed at `account-kind.ts:225`; the ACTIVE
  gate mirrors OrgManagerGuard Path 1's `status = 'ACTIVE'` so the client fact
  and the server admission can never disagree; NO SQL change — `agent_type` and
  `agent_status` are already selected).
- Fail-closed branch (`account-kind.ts:305-309`): `owns_agency: false`.
- `/auth/me` needs NO further change: `getMe` spreads `...accountKind`
  (`auth.service.ts:383`), and it is the ONLY server lane assembling the full
  shape (grep-verified; other `resolveAccountKind` consumers destructure
  specific fields — additive change is invisible to them).

**Client (mobile) — the FULL lane list (critic amendment 2, count corrected):**

- FOUR `authApi.me()` destructure sites (`authStore.ts:276, 416, 460, 769`),
- `toUser()` (kind param AND body),
- **`routingOf` (`authStore.ts:103-118`)** — critic amendment 1: the
  PATCH-profile rebuild lane that carries routing fields when `/auth/me` is
  NOT re-fetched; its own doc comment describes exactly this failure mode.
  Without it a profile edit silently drops `owns_agency` until the next full
  `/auth/me` — the B-394/routingOf rot class verbatim.
- `api.ts` `authApi.me()` return type + the `User` type.
- No `authApi.me()` callers exist outside authStore (critic-verified).
- Predicate becomes a THREE-arm formula:
  `(u.account_kind === 'agency' && !u.org) || !!u.owns_agency || !!u.managed_org`
  — the legacy arm is KEPT deliberately: against an old server (`owns_agency`
  undefined) every currently-working persona keeps working; the new arm only
  ADDS the stranded persona once the server ships. Widening who may TRY is
  safe by construction post-B-416: per-room single-mint is arbitrated by the
  server-side atomic claim, not by this predicate.

**Fork-safety argument (for the reviewers):** this change admits at most one
additional device per org (the owner's) to the claim race. B-416's claim table
makes any number of racing admit-listed devices safe (PK first-writer-wins;
losers stand down; fail closed). No E2EE gate, roster check, or key-flow
authority changes.

### Tests (red-first where flippable)

1. `account-kind` spec: `owns_agency` true for ACTIVE company agent; false for
   non-company, false for non-ACTIVE company, false in the fail-closed branch.
2. `dispatchRoomIntents.test.ts` (RED first): the B-417 persona shape
   (`account_kind: 'agency'`, `org: {joined workspace}`, `owns_agency: true`,
   `managed_org: null`) DRAINS with a won claim; same shape with
   `owns_agency: false` (old-server payload) still refuses (pins the
   mixed-version story).
3. `missionOpsRoomStaticScan.test.ts` formula pin: add `owns_agency` to the
   required tokens (keep `is_org_manager` forbidden).
4. Client field-parity (critic amendment 2): EXTEND the existing
   `enterpriseOnboarding.test.ts` destructure scan (not a parallel new one)
   so every `authApi.me()` destructure includes `owns_agency`, AND assert
   `routingOf`'s body carries the field (amendment 1).

## Part B — demotion/removal stranded-claims discoverability

### The problem

Demoting or removing a manager who holds `dispatch_room_crypto_claims` rows
strands those rooms (their device stops draining; everyone else claim-loses).
The B-416 review settled that claims must NOT be auto-deleted (the G-06 repair
the escape hatch depends on is conditional — auto-free converts a bounded
liveness gap into a recurring fork window on a ROUTINE action). What's missing
is discoverability: today the owner learns only if they read sqa.md.

### The fix — detect, report, audit; never touch the claims

**Server (`org-cpo.service.ts`):**

- New private helper `findStrandedRoomClaims(orgUserId, memberUserId)`:
  `SELECT c.conversation_id FROM dispatch_room_crypto_claims c WHERE
c.claimed_by = $2 AND EXISTS (SELECT 1 FROM dispatch_room_intents i WHERE
i.conversation_id = c.conversation_id AND i.org_user_id = $1)`
  (complete for manager-claimed rooms: a manager can only win claims through
  the drain, which only sees intent-bearing rooms; seeded rows carry the org
  account; room teardown cascades both tables).
- `setMemberRole` demote branch (`:1235-1237`) and `setMemberStatus`
  suspended/removed branch (`:1129-1136`): after the mutation succeeds, run
  the helper; when non-empty, add an audit row
  (`member.crypto_claims_stranded`, metadata = the room ids) and return
  `stranded_room_claims: string[]` in the response. Read-only — the claims
  table keeps its zero-UPDATE/DELETE invariant (spec-pinned in B-416).
- Both lanes stay best-effort: a failure in the CHECK must never fail the
  roster change (catch → empty array + error log).

**Client:** one shared helper (duplicate-copy class)
`warnStrandedClaims(rooms: string[])` → Alert explaining the rooms' key
delivery is paused and to contact ops (references the runbook procedure), wired
at the owner-facing call sites of `setCpoRole` / `setCpoStatus`
(`OrgCpoProfileScreen`, `OrgRosterScreen`, `EmployeesScreen`). Only the owner
can demote/remove managers (server rank rules), so the alert only ever fires
on the owner's device.

**Types:** `api.ts` response types for both endpoints gain the optional field.

### Tests

1. Service spec (critic amendment 3 — OrgAuditService is the mocked blind
   spot that hid five live defects on 2026-08-04): demote a manager WITH
   claims → response carries the ids AND the audit call is asserted
   EXPLICITLY with its action name + metadata args; demote with none →
   absent/empty + no stranded audit row; suspend/remove same; the check
   failing does NOT fail the roster change; pin the helper's SQL shape
   (claimed_by param + org-scoped EXISTS on dispatch_room_intents); NO
   UPDATE/DELETE on `dispatch_room_crypto_claims` anywhere in the diff
   (extends the existing B-416 pin).
2. Client: booking-project source scan — each of the three screens routes the
   response through the shared helper (site-anchored, comment-stripped, CRLF).

## Out of scope (stays documented, say so in review)

- The 3b twin (a delegated manager who OWNS an Enterprise workspace resolves
  Path 1b to their own workspace before Path 2 — drain runs, lists nothing,
  fail-safe but no rescue). Fixing it means re-ordering guard paths that were
  deliberately sequenced (`org-manager.guard.ts:96-99`); rare persona, zero
  fork risk, logged in B-417's sqa.md entry.
- Claim TTL / transfer / auto-delete — rejected in B-416 review, unchanged.
- B-417's minor siblings (G-06 targets, `done`-dedup re-add, the
  `ConversationsService.remove` teardown copy, claim-throttle memo).

## Gates & deploy

- Suites: auth-service full + build; messenger-crypto ×2 (flake rule); app
  `screens/messenger`; booking project; tsc ≤ 47; lint. Mutation-prove the
  red-first cases (verify each mutation applied before believing red).
- Deploy: server FIRST (additive field — old APKs ignore it; new predicate
  tolerates old servers via the legacy arm), then APK on the founder's
  schedule. No mixed-fleet fork window is opened: the predicate widening only
  matters on devices that already carry the B-416 claim pass.
