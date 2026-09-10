# Enterprise Scope v2 — Wiring & Build Blueprint

**Written:** 2026-08-07 · repo `main` @ `49f15f9` · designs produced by a 5-agent swarm
(constraint mapping, infra inventory, and three design agents), every claim grounded in
code with file:line evidence at design time. **Line numbers go stale — re-grep the symbol
before editing.**

**Companions:** `ENTERPRISE_SCOPE_V2_BUILD_STATUS.md` (what is/isn't built, verified 2026-08-07)
and `ENTERPRISE_DEPT_CHANNELS_SCOPE_V2_FIT.md` (the phase history). This file is the
**forward plan**: for each remaining gap — where it appears, when it appears, and how it wires
(screen → client API → server route → DB), with the test pins and RED mutations.

**Goal (founder, 2026-08-07):** the full scope PDF working inside the Enterprise plan — a
company manages its internal attendance, incidents, channels, vault and membership there.
The Enterprise workspace and the agency (service-provider) product are **different things**
and must never be conflated in copy or routing.

---

## §1 Master build order

| #    | Item                                               | Size | Depends on                      | Status                                                                                                                                             |
| ---- | -------------------------------------------------- | ---- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| D    | Entry-resolver fix (the "agency popup" bug)        | S    | —                               | **implement first**                                                                                                                                |
| A    | Push for the join loop (`enterprise` event class)  | M    | —                               | ready                                                                                                                                              |
| B1   | Roster verb split (`GET month` never writes)       | S    | —                               | ready; MUST land before `DEPT_CHAT_V2_ENABLED` flips anywhere                                                                                      |
| C2   | Corrections fold into the 4 readers (N4 ship-gate) | M    | —                               | ready                                                                                                                                              |
| F    | Day Status completion (6 statuses, batch, notify)  | M    | —                               | ready (atomic commit; two drift gates flip)                                                                                                        |
| I-a  | Channel member add/remove audit                    | S    | —                               | ready                                                                                                                                              |
| G-ab | Shift un-assign + edit-mode assignment             | M    | —                               | ready                                                                                                                                              |
| E    | Invitations by phone/email (Slack-style)           | L    | A (for the buzz; works without) | **DONE 2026-08-08** (2-round adversarial review; see §6 note)                                                                                      |
| B2   | MonthlyRosterScreen (calendar)                     | M    | B1                              | **DONE 2026-08-08** (2-round review; race-guarded loads)                                                                                           |
| C1   | CorrectionsScreen                                  | M    | C2                              | **DONE 2026-08-08** (2-round review; pair guard + branch picker)                                                                                   |
| G-c  | Department-wide shift assignment                   | S    | F (shares expansion helper)     | **DONE 2026-08-08** (expansion input, never scope)                                                                                                 |
| H    | Incidents: multi-photo/video/drafts/filter UI      | M    | —                               | ready                                                                                                                                              |
| G-d  | Weekly shift recurrence                            | M    | own migration                   | **DONE 2026-08-08** — ⚠ DEPLOY SERVER FIRST (prod ValidationPipe strips the new create fields on an old server: one shift, zero assignees, silent) |
| J    | Admin master vault view                            | —    | **FOUNDER DECISION**            | **DECIDED 2026-08-08: NOT BUILT — vault stays each member's own (§11)**                                                                            |
| I-b  | vault.\* audit                                     | —    | J option (b)                    | **CLOSED with J** — no org-attributable vault surface exists to audit                                                                              |

Shared files needing coordination when items land together: `src/services/api.ts`,
`src/navigation/types.ts`, `src/navigation/DepartmentalNavigator.tsx`.

**Pre-flag-flip checklist: ✅ CLOSED 2026-08-08.** All enterprise migrations applied to the
real Supabase Postgres (day_status_v2 + enterprise_member_invites + shift_recurrence were
the pending tail; verified by object probes — columns, partial indexes, the 10-value CHECK,
11 invite constraints). auth-service rebuilt from `main` and redeployed on staging
(bravo-staging-auth healthy; roster/invites/shifts route families answer 401 = registered).
`DEPT_CHAT_V2_ENABLED=true` was already set in the staging compose. Remaining exposure:
the CLIENT builds still predate scope-v2 — build+install a new APK to exercise it
(server-first order satisfied by construction).

---

## §2 Item D — Entry-resolver fix (the founder-reported bug)

**Bug:** `src/components/ProfileDrawerModal.tsx` "Departmental Chat" row →
`openDepartmentChannels()` (`src/navigation/departmentalEntry.ts:112-137`). From the
Secure/Booking tab or VBG home, no ancestor registers `Departmental`/`DepartmentChannels`
(they live under the **sibling** `MessengerTab`), so the resolver alerts _"Sign in with your
organisation account"_ — wrong audience — and because `hasDeptChannels === true` for an
Enterprise subscriber, the drawer's upsell fallback never runs either. A Lite/Pro user gets
**two stacked dialogs** (alerts queue FIFO in `@utils/alert`).

**Fix (both `openDepartmentChannels` and `openAttendance`):** insert a sibling branch
**after** the `shell` branch, mirroring `openJoinFlowScreen`'s R7-1 branch verbatim:

```ts
if (mountedTreeHasRoute('MessengerTab') && navigationRef.isReady()) {
  navigationRef.dispatch(
    CommonActions.navigate('Main', {
      screen: 'MessengerTab',
      params: {
        screen: 'Departmental',
        params: {screen: 'Channels', params: {screen: 'DepartmentChannels', initial: false}},
      },
    }),
  );
  return {ok: true, via: 'sibling'};
}
// openAttendance variant: params: {screen: 'Departmental', params: {screen: 'Attend'}}
```

Then replace both alert copies with account-neutral text ("…couldn't be opened right now.
Try again from the Messenger tab.") — with the sibling branch, `via:'none'` only remains
reachable in torn/pre-auth trees, so the copy must not claim an account problem. The
upgrade upsell stays where it is (drawer, `!hasDeptChannels` only).

**Landing screen for an Enterprise user with no workspace is already right:** the M8
directory's `JoinCta` shows "Set up your workspace" → `EnterpriseSetup`
(`DepartmentChannelsScreen.tsx` `canCreateWorkspace` + `target` fork). No change there.

**Constraint pins (from the constraint-mapping agent) — obey exactly:**

- Sibling branch AFTER `shell` (agency shells must keep resolving via `Departmental`).
- `initial: false` mandatory on `screen: 'Departmental'` and `screen: 'DepartmentChannels'`
  literals (`nestedNavigationInitialFlag.test.ts` scans repo-wide; `MessengerTab`/`Channels`/
  `Attend` are exempt TAB_LEAVES; the KNOWN_PREEXISTING allowlist is frozen at 8 — you may
  not extend it).
- Do NOT reorder exported functions in `departmentalEntry.ts` (`joinApprovalFlow.test.ts`
  slices positionally from `export function openJoinFlowScreen`).
- ProfileDrawerModal must keep the exact literals `openDepartmentChannels(navigation)` before
  `showEnterpriseUpgradePrompt({onViewPlans: openPricing})` (raw-text order pin) and the
  `ENTERPRISE` pill (lockedTerminology).
- Alert copy is unpinned — free to change.
- New tests: client-shell sibling cases for both functions **with payload inspection**
  (assert the nested shape + `initial: false`); keep the existing `via:'none'` cases by
  explicitly setting a MessengerTab-less `mockRootState`. Add an ordering test (rootState
  with MessengerTab AND a nav chain with `Departmental` → must still be `via:'shell'`).

Suites: `npx jest --selectProjects app --testPathPattern "departmentalEntry|nestedNavigationInitialFlag|deptChatEntryPoints|joinApprovalFlow|mountedTreeSearch"`.

---

## §3 Item A — Push notifications for the join loop

**Design: extend `BookingPushBridge`, do not build a second bridge** (it carries three
audited invariants: P0-N8 payload opacity, A2 recipient-bound blobs, N-20 durable row).

Server:

1. `apps/auth-service/src/ops/booking-push-bridge.service.ts` — add `'enterprise'` to the
   `eventClass` union (~:61); add `enterpriseJoinRequested(adminUserId)` and
   `enterpriseJoinDecided(applicantUserId, decision)` publishing
   `{kind: 'enterprise.join.requested' | 'enterprise.join.approved' | 'enterprise.join.declined'}`.
   **No requestId/org/applicant fields in the blob** — taps land on list screens that refetch.
2. `apps/auth-service/src/department/enterprise-join.service.ts` — inject the bridge; replace
   `notifyJoin`'s direct `notifications.record` with the bridge call (**not both** — the
   bridge already writes the inbox row; keeping both = duplicate rows). Update the R13-2
   comment. Existing `.catch` guards stay.
3. `apps/auth-service/src/department/department.module.ts` — provide `BookingPushBridge`
   directly (the `FamilyModule` pattern; Redis is `@Global`).
4. messenger-service: **no change**; enterprise stays normal FCM priority.

Mobile:

1. `src/modules/messenger/push/serverWakeNotifications.ts` — three `AGENT_WAKE_META` entries
   (titles mirroring `activitySync.ts` KIND_META so wake and bell read identically), channel
   `'enterprise-updates': 'Workspace updates'` in `CHANNEL_NAMES`, `'enterprise'` in
   `ActivityClassLike` + `kindToActivityClass` (`startsWith('enterprise.')`).
2. `src/modules/messenger/push/fcmBootstrap.ts` — `routeServerWakeTap` gains an enterprise
   branch (candidate-list pattern, NOT `openJoinFlowScreen` — that needs a
   `ResolvableNavigation`; this path runs on the bare navigationRef in a cold VM):
   candidates `Departmental→Channels→{target}` / `{target}` / `Main→MessengerTab→{target}`,
   target = `Approvals` for `.requested` else `ApprovalStatus`, `initial: false` throughout.
3. Widen kind-extraction regexes from `[a-z0-9-]+` to `[a-z0-9.-]+` in
   `serverWakeTapRouting.test.ts` and `serverWakeKindParity.test.ts` — otherwise the dotted
   kinds are invisible to both parity gates and ship unguarded.

RED mutations: keep old `record` alongside bridge → duplicate-row assertion fails; publish
with applicant PII → opacity spec fails; drop `initial:false` / route `.approved`→`Approvals`
→ tap-routing spec fails.

---

## §4 Item B — Monthly Roster (A7.2)

### B1 — verb split (MUST precede any `DEPT_CHAT_V2_ENABLED` flip)

`apps/auth-service/src/attendance/roster.service.ts`: rename `getMonth` → `ensureMonth`
(body unchanged); add `readMonth` = the SELECT only, returns `RosterMonth | null`.
`roster.controller.ts`: `GET month` → `readMonth` (returns `{month: … | null}`); new
`POST month/ensure` (`@HttpCode(200)`, DTO = the `@Matches` month field from
`PublishMonthDto`). Callers audited: `publishMonth`/`archiveMonth` keep `ensureMonth`;
`resolveRosterMonthId` never created months; no mobile caller exists. Spec: move the
"creates a DRAFT on first read" case to `ensureMonth`; add "GET month never writes"
(mutation: restore INSERT on read → RED).

### B2 — MonthlyRosterScreen

- `src/services/api.ts` (attendanceApi): `rosterMonth(month)`, `ensureRosterMonth(month)`,
  `rosterConflicts(id)`, `publishRosterMonth(month, force?)`, `archiveRosterMonth(month)`;
  DTOs mirror `RosterMonth`/`RosterConflict`/`PublishResult` (discriminated `ok` union).
- New `src/screens/deptchat/MonthlyRosterScreen.tsx` (obsidian primitives; no TextInput →
  no keyboard hook). Registered on AttendStack; `DeptAttendStackParamList` gains
  `MonthlyRoster: {month?: string} | undefined`. Entry card "Monthly roster" on
  `AdminAttendanceScreen` next to Manage shifts.
- Data: `rosterMonth` (the GET) on focus/month-change; `ensureRosterMonth` ONLY from an
  explicit "Start planning" tap on the `month: null` empty state — NOT on focus (a focus
  handler fires on every back-swipe/tab-switch, which would mint phantom draft months
  through the POST and defeat the verb split; B1 review, 2026-08-07). Publish/Archive are
  hidden while `month: null` — the server 404s them (`roster_month_not_planned`) anyway.
  Shifts from existing `listShifts`
  filtered to the month by **overlap** (`start < monthEnd && end > monthStart` — overnight
  shifts appear in both months); conflicts badge pre-publish.
- Per-state renders: draft = amber "DRAFT — not visible to your team" + Publish; published =
  green + "Publish changes" (server flips to amended); amended = both stamps; archived =
  read-only. Publish `{ok:false}` → inline conflict list + destructive "Publish anyway"
  (`force: true`, note "recorded in the audit log").
- Day tap → `navigate('ShiftManagement')`; the calendar never mutates shifts.
- 404 (flag off) → `ErrorState("This feature isn't enabled for your workspace yet.")`.
- Branch-scoped managers get their own `(org, department)` month bucket — NO department
  picker in the UI (mirrors the DTO's deliberate omission).

---

## §5 Item C — Corrections (A7.4)

### C2 — the reader fold (N4 ship-gate; land with or before C1)

**SQL-side lateral fold** (not service-side: exportSessions reads 5000 rows; orgSummary
groups in SQL). One rule, one fragment in `attendance.service.ts`:

```sql
(SELECT c.after_value->>'<field>' FROM public.attendance_corrections c
  WHERE c.session_id = ses.id AND c.org_user_id = ses.org_user_id
    AND c.after_value ? '<field>'
  ORDER BY c.corrected_at DESC LIMIT 1)
```

COALESCEd over `ses.<field>` for the three CORRECTABLE_FIELDS, applied to: `orgSummary`
(GROUP BY the folded expression), `pendingQueue` + `myShifts` (aliases appended AFTER
`ses.*` — last duplicate column wins in node-postgres; pin the ordering), `exportSessions`
(replace the three columns; CSV headers unchanged). Verify an index on
`attendance_corrections(session_id, corrected_at)` exists in `20260804000000`; add if not.
`effectiveSession` stays as the single-session canonical fold with a cross-link comment.
RED mutations: `DESC`→`ASC`; drop the `?` field test (clock-only correction nulls status);
group by raw column; aliases moved before `ses.*`.

### C1 — CorrectionsScreen

New `src/screens/deptchat/CorrectionsScreen.tsx` on AttendStack
(`Corrections: {sessionId?: string} | undefined`). Entries: (1) "Correct…" action on
disputed rows in AdminAttendanceScreen's pending queue (shows `dispute_note` in the editor
header); (2) a "Corrections" card → list mode (pendingQueue + recent orgSessions).
Editor: fold `listCorrections(sessionId)` ascending over the session to show the effective
"Recorded value"; proposed-value pickers limited to the 8 CORRECTABLE_STATUSES (pin count
`toBe(8)` — deliberately brittle, moves with item F to 10); mandatory reason (keyboard rule
hook); full append-only history below. Submit → `recordCorrection`; `correction_changes_nothing`
→ "Nothing changed". API additions: `listCorrections`, `recordCorrection` (routes verbatim
from `roster.controller.ts`). Dispute loop closes visibly: correction recorded → Approve
clears the queue (`reviewSession` withholds status; already built) → member's history shows
the corrected value via C2.

---

## §6 Item E — Invitations by phone/email (A5+M5, Slack-style)

> **SHIPPED 2026-08-08** with these review-driven deltas from the spec below:
> **(1)** `GET /enterprise/invites/me` returns the CODE only for PHONE-matched
> rows — an account email is unverified, so an email string-match must never
> hand over the acceptance credential (critic P1: register the invited email →
> collect a manager code). Email invites surface codeless; the admin shares the
> code out-of-band and the client points at "Enter invite code".
> **(2)** myInvites excludes orgs the caller is ACTIVE in, and JoinCta stays
> suppressed for org-affiliated callers — no zombie 90-day CTA.
> **(3)** `grantMembership` (the extracted single org_members writer) also
> refuses self-grants, workspace OWNERS (`org_workspaces` probe — ownership
> dodges the one-active-org index) and SUSPENDED rows, in BOTH lanes.
> **(4)** Accept pre-checks every roster-history class behind the ONE safe
> message (nine indistinguishable failure classes; the two honest 409s are the
> caller's own state: already_a_member, workspace_owner_cannot_join).
> **(5)** Duplicate-mint adoption is config-compared (role+team+branch scope) —
> mismatch is 409 `invite_exists_for_contact`, never a silently-wrong live
> code — and runs before the cap. **(6)** The accepted fan-out is
> branch-scoped (team department, else the manager invite's own branch).
> **(7)** myInvites' exclusion mirrors the accept pre-check exactly, so no
> surfaced invite can be unacceptable (the removed-employee re-entry lane
> stays open). **NEW FOLLOW-UP (8): no workspace-deletion path exists** — the
> owner refusal is deliberately lapse-blind (re-subscribe would resurrect the
> split-brain), so a lapsed owner cannot join any org until a deletion/transfer
> path ships; client copy says "contact support".

**Core decision:** an invite is a **bound, single-use, auto-approve variant row on
`enterprise_referral_links`** — not a new table, and NEVER any pre-acceptance `org_members`
row (the `org_members_status_no_pending` CHECK stays untouched; even `'invited'` would be
read as live membership by `org-cpo.service.ts` reads).

### Data (new migration `20260807xxxxxx_enterprise_member_invites.sql`, additive/idempotent)

Columns on `enterprise_referral_links`: `invited_phone` (E.164, CHECK regex),
`invited_email`, `invited_name`, `invited_role` (`employee|manager`, default employee),
`invited_department` (CHECK: only with role manager), `accepted_by`, `accepted_at`.
CHECK one-contact-only (phone XOR email). Partial unique indexes: one OPEN invite per
contact per org (phone + lower(email) variants); open-invite match indexes for the
"my invites" query. Mint auto-revokes an expired open invite for the same contact.
An invite row = `invited_phone IS NOT NULL OR invited_email IS NOT NULL`; all other rows
keep multi-use referral semantics unchanged.

### Endpoints (on `EnterpriseJoinController` — accept must reuse the service's private grant helpers)

| Route                                   | Guard          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /enterprise/invites`              | Jwt+OrgManager | mint; exactly one contact; team tenancy + `seedsManagersOnly` refusal shared with `createReferralLink`; branch-scoped minters: team must match their branch, `role='manager'` refused (`scoped_manager_cannot_grant_admin`); cap 50 open/org; 23505 → return existing open code; **silent match**: if the contact resolves to a user, `record(matchedUserId, kind:'enterprise.invite.received')` — response is byte-identical matched or not (no existence oracle) |
| `GET /enterprise/invites`               | Jwt+OrgManager | list w/ status PENDING/ACCEPTED/EXPIRED/REVOKED; branch-filtered                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /enterprise/invites/:code/revoke` | Jwt+OrgManager | conditional UPDATE + `accepted_at IS NULL`; already-accepted → 409 `invite_already_accepted`                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /enterprise/invites/me`            | Jwt            | match `phone_e164 = invited_phone` (+ legacy-digits fallback) OR lower(email); returns org/team/role — the invite is addressed to the caller, naming the org is correct                                                                                                                                                                                                                                                                                            |
| `POST /enterprise/invites/accept`       | Jwt            | below                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /enterprise/referral-links/:code`  | Jwt            | extended: invite rows resolve with `invite: true` + role so the client shows "Join" not "Submit request"                                                                                                                                                                                                                                                                                                                                                           |

### Accept flow (one tx, mirrors `decideJoinRequest`)

Pre-tx: load open invite (one safe 400 `invite_invalid_or_expired` for EVERY failure class —
no oracle); **phone binding enforced** (OTP-verified), **email binding surfacing-only**
(emails are unverified — code possession + single-use + revocable bounds it; stated
trade-off); minting admin must STILL be authorized (demotion kills their outstanding
invites); already-active-in-this-org → 409.
Tx: (1) conditional-UPDATE claim (`accepted_at IS NULL AND revoked_at IS NULL … RETURNING`,
race → safe 400, first decision wins); (2) close any open pending join request as approved,
else INSERT an already-approved request row (M11A then reads "approved"; audit anchor);
(3) `grantMembership` — the block **extracted** from `decideJoinRequest` into a shared
private helper: reinstatement rules, else INSERT org_members `(role from invite, department
CASE manager, 'active', invited_by = created_by)`; 23505 on the one-active-org index →
409 `already_active_in_another_org`, whole tx rolls back, invite stays open.
Post-commit best-effort: `seedApprovedMemberChannels(org, user, {asManager})` — manager
seeding mirrors `seedChannelMembers`'s isManager branch, **every add via
`DepartmentService.addMember`** (the only rekey-intent writer; group-key machinery below it
is a stop-condition — route through, never around); audit `enterprise.invite.accept`
(contact_kind only, NO raw phone/email in metadata); notify invitee with the existing
`enterprise.join.approved` kind + admins with `enterprise.invite.accepted`.

### Scoped-admin grant

The invite carries role+department; accept writes them to `org_members`; `OrgManagerGuard`
Path 2 already reads `department` into the forced branch filter. **No guard change.**

### Client

- New `src/screens/deptchat/InviteMemberScreen.tsx` — registered in BOTH MessengerNavigator
  and DepartmentalNavigator Channels stack (dual-mount rule). Phone input normalized with
  `normalizeToE164` + `callingCodeFromOwnPhone` BEFORE minting (B-154); or email; or device
  contact picker (existing expo-contacts machinery). Team picker (managed channels minus
  archived/broadcast/restricted/incident). Role toggle + branch scope (unscoped minters
  only). Mint → code card + `Share.share`. Status list never shows "is on Bravo".
- `ApprovalsScreen` — "Invite by phone or email" button + open-invites section w/ revoke.
- `ChannelMembersScreen` — "Invite someone new…" row (pre-selects the channel as team).
- `ApprovalStatusScreen` — **the invitee surface**: no request + `myInvites()` non-empty →
  "You've been invited to {org} ({team})" + Accept → shared helper
  `src/screens/deptchat/inviteAccept.ts` → reload shows approved → Enter Department Channels.
- `JoinWorkspaceScreen` — resolve returns `invite: true` → button "Join {org}", calls the
  shared accept helper instead of `submitJoinRequest` (typed/pasted-code path).
- `DepartmentChannelsScreen` JoinCta — open invite outranks the fork: "You've been invited
  to {org}" → `openJoinFlowScreen(nav, 'ApprovalStatus')` (never thread the code through the
  resolver — its params drop on 3 of 5 branches; the destination self-hydrates).
- `activitySync.ts` KIND_META + ActivityCenter route for `enterprise.invite.*`.
- `api.ts`: `createInvite/listInvites/revokeInvite/myInvites/acceptInvite`.

### Non-goals v1 (stated, not implied)

No SMS/email dispatch (SmsService/Twilio exists but stays escalation-only; NO email sender
exists in the repo — delivery = in-app match + share sheet); no push wake beyond item A; no
email verification loop; no bulk/CSV; one team per invite; no `bravo://` deep link (no
linking config/scheme exists — a named follow-up); no relay/crypto changes of any kind.

### Key tests

Safe-message identity across all accept-failure classes; claim SQL has `accepted_at IS NULL`
in the UPDATE (read-then-write mutation → RED); grant on tx client, seed post-commit
`.catch`-guarded; mint response identical matched/unmatched; no
`INSERT INTO (public.)?org_members` outside the shared helper and no direct
`department_channel_members` INSERT in enterprise-join.service.ts (bare-name anchors);
client scans: normalize-before-mint, no existence-leak tokens, dual registration,
JoinWorkspace invite branch calls accept not submit.

---

## §7 Item F — Day Status completion (A7.3)

New statuses `emergency_leave`, `mission` → **nine copies change in ONE commit**:
client union+chips (`DayStatusScreen.tsx`), client api type, `_obsidian.tsx` status meta
(icons), server DTO `@IsIn` (order matters — F13 compares order), `AttendanceStatus` type,
BOTH service marker `IN(...)` lists, rollup skip list (`attendance-rollup.service.ts` — else
the sweep writes absent over mission), `CORRECTABLE_STATUSES`, and a **new migration**
`day_status_v2.sql` dropping + re-adding the auto-named
`cpo_shift_sessions_attendance_status_check` widened to 10 (precedent:
`20260630000000_attendance_review_reason_camera.sql`).
**Drift gates flip deliberately:** `roster.spec.ts` migration path → the NEW file, `toBe(8)`
→ `toBe(10)` (never `>=`); `dayStatusServerContract.test.ts` repoints `dbStatuses()` and
follows its own header's flip protocol; `attendance.service.spec.ts` regex widens.

**Batch API (server-side, chosen over client loop):** extend `SetDayStatusDto` with
`member_ids[]` (≤100) XOR `department` (server-expanded) XOR legacy `cpo_user_id`, plus
`dates[]` (≤62, client expands ranges via its own `toDayString`) — cap
`targets×days ≤ 500`. One tx: validate all targets active; collect prior marker ids;
`assertNotUnderCorrection` over the UNION **before any delete** (all-or-nothing; 409 names
offending pairs); one DELETE + one `INSERT…SELECT unnest × unnest`; audit per member in-tx.
Post-commit: `notifications.record(memberId, {eventClass:'enterprise',
kind:'enterprise.day_status'})` once per member + KIND_META entry client-side.
"Team" == `org_members.department` (no team entity exists — say so in a comment).
UI: 6 chips, checkbox multi-select + Select all + department headers (needs `om.department`
added to `listRoster` SELECT + the RosterMember interface), [Single|Multiple|Range] date
modes on the existing DateTimePicker. **Attachment: deferred, stated** (would need an
`incident_attachment_keys`-shaped E2EE pair; cleanly separable).
RED mutations: one service IN-list unwidened → contract test; guard after DELETE → no-DELETE-
on-refusal spec; notify dropped; rollup list unwidened → mission-overwrite spec.

---

## §8 Item G — Shift management completion (A7.1)

**(a) Un-assign + (b) edit-mode assignment (P1 — a mis-assignment is currently permanent):**
`PATCH /attendance/shifts/:id/assignments` `{add?, remove?, department?}` (+
`GET /attendance/shifts/:id/assignments` to prefill), guards `DeptChatV2Guard+OrgManagerGuard`.
Remove = plain DELETE, **no active-member check** (must un-assign the suspended), idempotent,
audit rows. **Sessions are never touched**: closed sessions are the immutable record; open
sessions close normally; the rollup joins assignments so no auto-absent after un-assign
(un-assign inside the sweep window erases the would-be absent — the audit row is the record).
`ShiftEditorScreen`: drop the `editing ? null :` fence, prefill from GET, diff on save,
replace the `selectedCount: 1` hack; edit may go to 0 behind a confirm.
**(c) Department-wide assignment:** `department` in the PATCH/create body, server-expanded
(the `activeOrgMembers` query + `AND department=$2 AND member_role<>'manager'`, written
locally in attendance.service.ts with a source comment — shared shape with item F).
**(d) Recurrence (minimal):** `repeat_weeks` (2..12) + optional `cpo_user_ids[]` on create;
one tx materialises N real `cpo_shifts` rows at +7d·k sharing a new `recurrence_group_id`
(migration adds the column + partial index); **each occurrence resolves its own roster
month** (months are never created here); assignments copied; server-side `end_at > start_at`
guard added. No rrule engine — real rows mean zero changes in the four read paths.
Deferred, stated: series edit/archive, bi-weekly/monthly, DST wall-clock drift.
RED mutations: ownership check off remove; month resolved once for all occurrences;
un-assign deleting sessions.

---

## §9 Item H — Incidents completion (M10 + A8 filters)

Server already supports N attachments and the sealing pipeline is byte/mime-agnostic —
**all client work**: media state becomes an array (cap 5); add video capture/pick
(`durationLimit: 60`, size cap 50 MB via `asset.fileSize`, NO transcode v1 — `readUriBytes`
loads whole files into RAM, cap accordingly); submit loops `uploadAndSealEvidence`
sequentially, aggregates "2 of 3 attachments secured"; `loadEvidenceUri` widens to return
`{uri, mime}`; `EvidenceSection` renders `video/*` via expo-video (`FileViewer.tsx`
precedent). **Drafts:** new `src/screens/deptchat/incidentDraft.ts` — AsyncStorage, keyed
per user, URIs only (never bytes), debounced save, "Resume draft?" card on the category
screen, cleared on submit; header comment states why this is safe (incident descriptions are
server-plaintext already — no new confidentiality class; lives outside src/modules/messenger
so the drafts-ban scans are not weakened). **Admin queue filter UI:** category chips +
date-range + branch picker (unscoped managers only) wired to the already-accepted
`category/from/to/department` params.
RED mutations: draft cleared before submit resolves; upload loop aborts on first failure;
video always rendered as Image.

---

## §10 Item I — Audit gaps

**(a) NOW:** `addMember`/`removeMember` in `department.service.ts` — wrap membership write +
`enqueueIntent` + new `member.channel_add`/`member.channel_remove` audit in ONE
`withTransaction` (the intent row drives the security-critical rekey; audit and intent must
not diverge). `assertOutranks` already returns the channel row incl. `org_id` — capture it.
Metadata: `channel_id` + `role` only (NO PII). Re-grep for direct
`department_channel_members` writers (`configureChannel` tighten, `syncMemberToOrgChannels`)
— each needs its own audit call or a documented exemption. These routes are LIVE and not
flag-gated — the audit change alters no route surface. RED: audit without `{tx}`.
**(b) vault.\*: blocked by design** — company files are a client-derived view; the only
server touchpoint (`POST /media/download-url/:key`) is not org-attributable and teaching it
org semantics hits the relay stop-condition. Rides item J option (b). Optional adjacent win:
audit `incident.evidence_key.fetch` at `getMyAttachmentKey` (org-attributable today).

---

## §11 Item J — Admin master vault view (A10): **DECIDED 2026-08-08 — NOT BUILT, by design**

> **Founder (2026-08-08): "vault is each person's individual feature… a member who is on
> messenger lite, as per pricing and spec, will get his vault."** The vault stays
> member-private; there is NO admin master view. Code already matches:
> `entitlements.ts` `hasCloudVault: effective !== 'lite' || isOrgAffiliated` — joining a
> workspace grants a Lite member his OWN vault, and `adminVaultScope.test.ts` (F14) keeps
> pinning the member-scoped reality as the CORRECT state (its DOCUMENTS framing can be
> retitled to a positive pin at next touch, not flipped). Consequently **I-b (vault.\*
> org-audit) stays closed**: there is no org-attributable vault surface to audit, and
> teaching the download-URL endpoint org semantics remains a stop-condition.

The two candidate architectures below are kept for the record only — **neither is to be
built**:

- **(a) Admin auto-membership** in every channel: no new infra, but silently changes channel
  privacy semantics, multiplies rekey blast radius on every promotion/demotion (group-key
  stop-condition), concentrates every group key on admin devices — and still is NOT an
  archive (the ~200-message hydration window caps history).
- **(b) Server-side org file registry** (recommended to present): mirror the shipped
  incident-attachments pattern — registry + per-file keys sealed to org managers at post
  time, OrgManagerGuard-gated list/download endpoints. Durable, auditable (gives I-b its
  audit point), no relay/group-key changes. Cost: seal-to-N-managers fan-out per upload;
  later-appointed managers need a re-seal backfill by a key-holder device (same limitation
  incidents already accept).
  When it lands, flip `adminVaultScope.test.ts` (DOCUMENTS F14) deliberately per its own flip
  protocol.

---

## §12 Cross-cutting

- **Feature flags:** roster/corrections/incidents/attendance-v2/workspace-create 404 until
  `DEPT_CHAT_V2_ENABLED=true` server-side; join loop + channel hierarchy are live now.
  Client `.env.production` already has `EXPO_PUBLIC_DEPT_CHAT_V2=true`. B1 lands first.
- **Gates per landing:** auth-service `npm test` (its own dir) + `tsc` 0 errors; mobile
  `npm run typecheck` ≤ baseline 47; touched-suite runs (navigation / deptchat / messenger
  screens per the CLAUDE.md messenger gate when `src/screens/messenger/**` is touched —
  crypto project twice, flake rule B-126).
- **Self-diff rule 8** before every commit: enumerate consumers of anything deleted/changed
  (the §5 caller-completeness sweep) — five instances of the one-layer-out defect class in
  this program's history.
- **sqa.md:** the verification bugs (org_name leak `enterprise-join.service.ts:365`,
  double-alert queue, stale comments) still need B-numbers — fetch latest sqa.md first
  (parallel-session numbering collisions are a known hazard).
- **Follow-ups from the I-a/C2 review loops (read-side, non-blocking):**
  (1) the ops org-audit reader (`ops-data.service.ts` listOrgAudit) has no cursor/action
  filter — one bulk channel tighten now fills its whole 200-row window with
  `member.channel_*` rows; give it `browseAudit`-style paging before orgs grow.
  NOTE the M2 fix WIDENED this gap: a demote now writes one row per channel
  (`member.channel_remove` + `member.channel_role` both branches), not half.
  (2) The wake-row vs backfill-row double bell entry (different id keyspaces) is
  PRE-EXISTING for booking/mission classes — fix needs an eventId on the notifications
  row. (3) `redeemInviteCode` creates org membership without channel seeding — the one
  membership path producing no `member.channel_add` (pre-existing product gap).
  (4) CSV export audit metadata could carry a `corrections_applied` count for
  compliance reconciliation of re-exports. (5) D6-f's one-marker-per-day rule
  needs a partial unique index to survive two concurrent no-prior batches
  (`(org_user_id, cpo_user_id, ((clock_in_at AT TIME ZONE 'UTC')::date))
WHERE shift_id IS NULL AND attendance_status IN (<the 6 markers>)`) — the
  predicate is another copy of the marker list, so land it WITH the next
  status change and extend the F13 gate to read it. (6) Day-marker rendering
  for UTC+12..+14 members needs `timeZone: 'UTC'` at the render sites (noon
  storage covers -11..+11 only). (7) **PREREQUISITE for provisioning the
  FIRST branch-scoped manager (G-ab NEW-1, latent HIGH):** nothing in the
  codebase writes `org_members.department` — no INSERT includes it, no UPDATE
  sets it, no DTO carries it — so every
  `($n::text IS NULL OR department = $n)` predicate currently takes the NULL
  arm and the scoped-manager paths (F day-status, all five G-ab shift
  handlers, roster) are exercised by unit tests ONLY. Before the first scoped
  manager exists: build the member-branch writer (roster surface,
  RS-10-adjacent) + a backfill, AND scope the `listRoster`/`listCpos` pickers
  to `manager.department` — otherwise the picker shows the whole org while
  the scoped membership predicates refuse everyone (a visible wall, but a
  wall). Also pre-existing: `findConflicts` joins shifts org-wide while
  gating the month by department, so a scoped manager's conflict list can
  name other branches' shift ids.
