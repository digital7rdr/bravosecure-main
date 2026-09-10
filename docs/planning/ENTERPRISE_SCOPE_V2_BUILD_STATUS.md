# Enterprise Department Channels (Scope v2) — Verified Build Status

**Source of truth for the ask:** `Bravo_Department_Channels_Enterprise_Mobile_Scope_v2.pdf` (10 pages, founder handover)
**Verified:** 2026-08-07 against `main` @ `49f15f9`, by four parallel code-verification agents reading the
actual source (every claim below carries file evidence; nothing was taken from docs on faith).
**Companion doc:** `ENTERPRISE_DEPT_CHANNELS_SCOPE_V2_FIT.md` (the plan + build log). This file is the
_status snapshot_; where the two disagree, this one was checked against code later — see §6 "Doc drift".

---

## 1. What the client actually wants (the intention)

The PDF turns Bravo from a **personal secure messenger** (WhatsApp-shaped) into a **company
workspace product** (Slack-shaped) — while keeping the E2EE moat. Reading the locked rules and the
sign-off check on page 10, the client's intent is:

1. **Sell to companies, per-seat.** One person buying a messenger is a small sale; a company buying
   channels + attendance + incidents + a file vault is a big one. That is why the scope is exactly
   four modules and why Meetings/Events are deferred _with no hidden stubs_ — they are protecting
   the release from scope creep.
2. **The server is the security boundary, not the UI.** Repeated on every page: "role, scope,
   visibility and every protected operation are enforced server-side", "hidden metadata is filtered
   by the server, not merely hidden by the client". The client has clearly been burned (or advised)
   about client-side "security" and wants tenancy isolation they can defend to _their_ customers.
3. **Two worlds in one app.** An Admin lands in a control room (approvals, exceptions, incidents);
   a Member lands in their own day (next shift, their incidents, only their channels). Neither may
   see the other's world, and a _pending_ member sees **nothing at all**.
4. **Structure = org chart.** Exactly four channel levels (Enterprise → Main → Sub → Sub-sub), a
   non-deletable `#broadcast` at every level, and "visible does not grant posting" — they want a
   controlled communication tree, not a pile of group chats.
5. **Accountability.** Corrections never overwrite (before/after kept forever with actor + server
   time), rosters have Draft/Published/Amended states, everything audited. This is an
   audit-trail-driven company product — the kind a security firm can show a client or a court.
6. **Phone-only, this build.** Desktop explicitly out of scope; the sign-off is "Admin and Member
   complete their full authorised workflows from a phone."

**Page-10 sign-off, verbatim:** the build passes only when (a) both roles complete full workflows
from a phone, (b) referral access requires Admin approval, (c) all visible channels respect the
four-level hierarchy, (d) protected data is permission-filtered, audited and isolated.
**Where we stand against that:** (b) ✅ (c) ✅ (d) largely ✅ — (a) is blocked by the missing
roster/corrections UI and missing push notifications. See §5.

---

## 2. Frame-by-frame verdict

Legend: ✅ built + wired · 🟠 partial · 🔌 built but NOT wired (server exists, no client) · 🔴 missing

### Admin flow

| Frame  | Name                                                  | Verdict | Evidence / gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | ----------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| A1     | Welcome / service selection                           | ✅      | `AuthNavigator` (Splash / Onboarding / Register)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| A2     | Enterprise plan, no Professional                      | ✅      | Satisfied structurally — the fork screen shows **no plan tiers at all**; pinned by `src/screens/deptchat/__tests__/enterpriseOnboarding.test.ts:50-56` + `onboardingPlanScope.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A3     | Create secure account                                 | ✅      | existing Register + OTP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| A4     | Select role (route ≠ authority)                       | ✅      | `EnterpriseSetupScreen.tsx` registered in BOTH shells (`MessengerNavigator.tsx:214`, `DepartmentalNavigator.tsx:120`); authority is server-side only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A5     | Create org workspace                                  | 🟠      | Chain fully wired: screen → `api.ts:1859` → `POST /org/workspace` (`workspace.controller.ts:32`) → `20260804010000_enterprise_workspaces.sql`. Enterprise-subscription gate ✅ (`workspace.service.ts:68-74`); owner does NOT become `service_provider` ✅; seeds 4 channels + `#broadcast` ✅ (`department.service.ts:386-424`). **Missing: logo, country, timezone (name only), and ALL admin invitations** (see A5-inv below)                                                                                                                                                                                                                                                                                                                                                                    |
| A5-inv | Invite admins by phone/email, with level/branch scope | ✅      | **Item E shipped 2026-08-08** (2-round adversarial review). Bound single-use auto-approve rows on `enterprise_referral_links` (`20260808010000_enterprise_member_invites.sql`); mint/list/revoke/me/accept on `EnterpriseJoinController`; `InviteMemberScreen` (dual-mounted) with B-154 normalise-before-mint, team picker, role toggle + branch scope; accept = one tx (claim → born-approved request → shared `grantMembership`), manager invites seed managers-only channels as `admin`/'Manager'. Security posture: phone invites are OTP-bound; email invites surface WITHOUT the code (unverified email must never receive the credential — myInvites strips it); ONE safe accept message across nine failure classes; workspace owners / self / suspended / role-mismatched rosters refused |
| A6     | Admin home dashboard                                  | ✅      | `DepartmentalHomeScreen.tsx` — manager gets 5 cards (4 + Approvals w/ live pending badge `:283`), pending-review tile, open-incidents tile, unread-broadcast card. (PDF said 4 cards; we ship 5 — Approvals is the extra)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A7     | Admin attendance overview                             | ✅      | `AdminAttendanceScreen.tsx` — totals, manage-shifts + day-status entries, pending-review queue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A7.1   | Manage shifts                                         | ✅      | Site + geofence + radius ✅ (haversine server-side); multi-member assign ✅; **G-ab (2026-08-08):** un-assign + edit-mode assignment (`PATCH shifts/:id/assignments`, diff semantics, sessions never touched); **G-c:** department-wide assignment (`assign_department` expansion input — never scope — server-expanded to the branch's active non-managers; branch toggle-chips client-side); **G-d:** weekly recurrence (`repeat_weeks` 2..12 → N real rows sharing `recurrence_group_id`, one tx incl. assignees + audits, per-occurrence month resolution, archived-month refusal). Series edit + non-weekly patterns deferred, stated                                                                                                                                                          |
| A7.2   | Monthly roster                                        | ✅      | **B2 shipped 2026-08-08** (2-round adversarial review). `MonthlyRosterScreen` on the Attend stack: month calendar (overlap filter, overnight shifts in both months), draft/published/amended/archived banners, "Start planning" is the ONLY `ensure` caller (B1 pinned), publish → blocking-conflict list + audited force override, archive, race-guarded month switching, 404-flag-off copy. api.ts gained the five roster methods. Still absent (unscoped v1): copy day/week/month, templates                                                                                                                                                                                                                                                                                                     |
| A7.3   | Set day status                                        | 🟠      | Screen + API wired. **Only 4 of 6 statuses (Emergency Leave and Mission missing), single date only (no ranges), single member only, no member notification**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A7.4   | Attendance corrections                                | ✅      | **C1 shipped 2026-08-08** (2-round adversarial review; C2 reader fold live since 2026-08-07 — every reader + CSV shows corrected values). `CorrectionsScreen`: list mode (pending queue + recent closed, branch-scoped — `orgShifts` gained the corrections COALESCE rule) + editor (recorded-value card w/ dispute note, 9-chip status picker mirroring the pinned 10-list, HH:MM times anchored to the effective clock-in w/ explicit next-day warning, mandatory reason, append-only history). Server gained the effective-PAIR guard (`correction_out_before_in`, time-touching corrections only). Entries: AdminAttendance cards + per-row "Correct" on the pending queue                                                                                                                      |
| A8     | Admin incidents                                       | ✅      | Queue + detail + assign/escalate/resolve/reopen FSM + internal notes + audit + timeline all wired. **Item H (2026-08-08):** category chips, date presets (7/30/90d) and branch chips all wired to the already-accepted server params (scoped managers' branch stays server-forced); stale-response guard on the queue. Assignee filter remains API-only (no UI ask in the PDF)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A9     | Manage channels (hierarchy + modes)                   | ✅/🟠   | Hierarchy fully real (see §3). Modes: **4 names in the DB CHECK but only 2 behaviours** — `memberRoleFor` maps `open`→poster, everything else→viewer, and the client editor never produces `admin_only`. "Four communication modes" is a schema promise, not yet a behavioural fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A10    | Admin vault                                           | ✅      | **FOUNDER DECIDED 2026-08-08: the vault is each member's INDIVIDUAL feature — no admin master view, by design.** A member joining from Messenger Lite gets his own vault via org affiliation (`entitlements.ts` `hasCloudVault: effective !== 'lite' \|\| isOrgAffiliated` — verified). The member-scoped shelf that shipped IS the intended end state; `adminVaultScope.test.ts` pins it as correct (blueprint §11 records the decision + why I-b vault audit stays closed)                                                                                                                                                                                                                                                                                                                        |     |
| A11    | Approvals inbox                                       | 🟠      | Inbox + Approve/Decline wired, `OrgManagerGuard`-gated, **first-decision-wins is real** (status-guarded UPDATE in a tx → 409 `join_request_already_decided`, rendered "Already decided"). **Missing: any push** — submit/decision write in-app inbox rows only (`NotificationsService.record` = bare INSERT, "NO push wake here (R13-2)" stated in code). Branch routing is flat `org_members.department` matching, not hierarchy-derived                                                                                                                                                                                                                                                                                                                                                           |

### Member flow

| Frame | Name                                         | Verdict | Evidence / gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----- | -------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| M1–M3 | Welcome / plan / account                     | ✅      | shared with admin flow; A2 rule holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M4    | Select role — member                         | ✅      | same fork screen, Join arm                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| M5    | Join workspace / referral                    | ✅      | `JoinWorkspaceScreen.tsx` → resolve link → submit → `enterprise_join_requests` (`20260803030000`), idempotency index, link mint/revoke with audit. Distinct from the agency `provider_*_codes` tables                                                                                                                                                                                                                                                                                                                     |
| M11A  | Approval status (pending = blank)            | ✅      | Blank wall is **structural**: pending creates NO `org_members` row, and a CHECK (`org_members_status_no_pending`) makes storing one impossible; channel list joins through membership → zero rows. Pinned: status screen may not call any org API (`joinApprovalFlow.test.ts:73-80`). **One real bug found: `myJoinRequest` returns `u.display_name` as org_name — the pending screen shows the founder's personal name instead of the workspace name** (`enterprise-join.service.ts:365` vs the fixed sibling at `:189`) |
| M6    | Member home dashboard                        | ✅      | 4 cards, today's-attendance card, open-incident count, unread broadcasts                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| M7    | My attendance                                | ✅      | On/Off Shift lives in `agent/AttendanceScreen.tsx` (AttendStack root) with face + geo verification (`VerifyAttendanceScreen`), distance-from-site recorded at check-in/out (no continuous tracking, by design), history + dispute flow in `MyAttendanceScreen.tsx`                                                                                                                                                                                                                                                        |
| M8    | Channel dashboard, 4 levels                  | ✅      | Level sections rendered unconditionally (`LEVEL 1 — ENTERPRISE` … `LEVEL 4`), member counts per row. **Gap: visible-depth projection still open** — a visible child under a hidden parent renders with raw `level` and no parent above it (rendering defect, not a leak; algorithm written down in FIT doc carry-forward)                                                                                                                                                                                                 |
| M9    | Channel chat, modes enforced, no call button | ✅      | Send-side viewer block + receive-side non-poster discard (fails open only when roster unknown); mode is server-authoritative. No-call rule pinned by the 7-layer scan `deptChannelNoCallAffordance.test.ts` (incl. one-hop transitive import scan)                                                                                                                                                                                                                                                                        |
| M10   | Member incidents                             | ✅      | Report (15 categories, severity), E2EE evidence sealed to managers, own-incidents-only server-side, status chips. **Item H (2026-08-08):** up to 5 photos/videos per report (60s/50MB caps + post-read backstop), sequential seal loop with in-place Retry on partial failure, expo-video rendering in EvidenceSection, per-user drafts (URIs only, resume card, cleared on submit + swept on logout, resurrection race killed)                                                                                           |     |
| M11B  | Member vault                                 | 🟠      | Personal/company separation is the strongest part: disjoint types + disjoint storage + one choke point that refuses to copy company files into the personal vault, all behaviourally tested. **Gaps: company shelf bounded by the 200-msg hydration window (older files invisible), no per-file MFA on company files (screen-level unlock only), forwarding a company file to a DM creates an untracked personal copy (documented)**                                                                                      |

### Cross-cutting (page 10)

| Rule                                           | Verdict    | Notes                                                                                                                                                                                                           |
| ---------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exactly 4 levels, DB-enforced                  | ✅         | `20260803010000` — derived level trigger + `CHECK (level BETWEEN 0 AND 3)` + cross-org + re-parent refusal + `ON DELETE RESTRICT`                                                                               |
| `#broadcast` per level, protected              | ✅         | auto-create on both creation paths, DELETE trigger, forced `announcement`, archive guard, one-per-level unique index                                                                                            |
| Paging / lazy loading                          | 🟠         | Keyset paging **is built** for `listChannels` + ops (contrary to the FIT doc's deferral note). `listOrgChannels` (A9 admin list) still unpaged                                                                  |
| Tenancy / hidden metadata filtered server-side | ✅         | membership-join structure; pending impossible to store in `org_members`; `parent_id` masked when parent invisible                                                                                               |
| Bottom nav Home + Messenger only               | ✅         | `HIDDEN_TAB` on 4 tabs, `ObsidianTabBar` honours `tabBarButton`, Messenger tab = exit, Home stand-in highlight; 9 navigate call sites preserved                                                                 |
| Notifications deep-link to authorised record   | 🟠         | In-app inbox rows route correctly (ActivityCenter). **No push anywhere in this scope: not on join request, not on decision, not on roster publish/amend, not on day status**                                    |
| Audit everything                               | 🟠         | 5 of 6 domains write `org_audit_log` (workspace, membership/appointments, channels, roster/attendance, incidents). **Missing: any `vault.*` org-audit event, and channel-member add/remove write no audit row** |
| No Meetings/Events stubs                       | ✅         | verified absent (only false-positive symbol matches)                                                                                                                                                            |
| Duplicate-submission idempotency               | ✅ (joins) | partial-unique open-request index; not re-verified for other modules                                                                                                                                            |

---

## 3. How the big loops are wired (the chains that matter)

**The join loop (the one the FIT doc calls "if this works, the product works") — WIRED end to end:**

```
GroupsScreen / DepartmentChannelsScreen CTA
  → EnterpriseSetupScreen (fork, both shells)
      ├─ Create → CreateWorkspaceScreen → api.ts:1859 → POST /org/workspace
      │     → workspace.service.ts (enterprise-sub gate → org_workspaces row
      │        → seedOrgWorkspace: 4 channels + #broadcast)  → replace('Departmental')
      └─ Join → JoinWorkspaceScreen → GET /enterprise/referral-links/:code
            → POST /enterprise/join-requests (pending row, idempotent)
            → ApprovalStatusScreen (blank wall)
Admin: DepartmentalHomeScreen Approvals card (live badge)
  → ApprovalsScreen → POST approve/decline (tx, WHERE status='pending' → 409 for 2nd admin)
  → approve creates org_members + channel seeding → member's next focus unlocks Home
```

Weak link in that chain: **the "push notification arrives" arrow does not exist** — both sides poll
on focus/app-open.

**The attendance v2 lane — server wired, client half-wired:**
shift create/assign/edit (wired UI) → check-in/out with face+geo (wired) → review/day-status
(wired) → **roster months + corrections (server only — no API client, no screens)**.
The entire v2 lane 404s until `DEPT_CHAT_V2_ENABLED=true` server-side.

**The vault lane:** channel attachment (wired, existing pipeline) → company shelf derivation
(client-side view, membership-scoped, fail-closed) → VaultScreen shelf switch / FilesScreen scope.
No server component was added; personal vault untouched.

## 4. Built but NOT wired / dead ends (the honest list)

1. **Roster + corrections server slice** — `roster.controller.ts` has no client caller at all
   (zero matches for `attendance/roster` in `src/`). Biggest single unwired asset.
2. **`effectiveSession`** — defined, tested by nothing, called by nothing. Until orgSummary /
   pendingQueue / exportSessions / myShifts fold corrections in, A7.4's promise is invisible.
3. **Ops-console hierarchy** — server ships `parent_id`/`level`; `DepartmentChannelRow`
   (`apps/ops-console/src/lib/api.ts:1545`) drops both; departments page renders flat.
4. **Incident queue filters** — category/branch/assignee/date accepted by API, no UI controls.
5. **`admin_only` post mode** — in the CHECK, unreachable from any client, seeds same as read_only.
6. ~~**`getMonth` writes on GET**~~ — **FIXED 2026-08-07** (the verb split): `GET month` is
   read-only (`readMonth`, returns `{month: RosterMonth | null}`); creation is an explicit
   `POST month/ensure`; publish/archive now REQUIRE an opened month (404
   `roster_month_not_planned`) instead of silently minting one. Pinned by the VERB SPLIT
   describe in `roster.spec.ts` incl. an ensureMonth-single-caller source scan.

## 5. What's left, prioritized

**Blockers for the page-10 sign-off ("full authorised workflows from a phone"):**

1. Roster UI (A7.2): month calendar + publish/amend + conflicts surface, wired to the existing
   server slice; then copy day/week/month + templates (server work too — none exists).
2. Corrections UI (A7.4) + wire `effectiveSession` into the four readers (N4 in FIT doc — a
   ship-gate for the correction UI, not after it).
3. Push notifications: join submitted (→ admin), decision (→ member), roster publish/amend
   (→ affected members), day status (→ member). The FCM plumbing exists elsewhere in the app
   (BookingPushBridge) but has no `enterprise` event class.
4. ~~Fix `getMonth` GET-write~~ — DONE 2026-08-07 (see §4 item 6).
5. Run the three migrations (`20260803010000/20`, `20260803030000`, `20260804000000/30`,
   `20260804010000`) against a real Postgres once and exercise the triggers + the
   `ON CONFLICT` expression-index inference (42P10 risk) — **no test in this repo executes that
   SQL**; every DB invariant is currently pinned by source scans only.

**PDF requirements still missing (non-blocking to a demo, blocking to "done"):** 6. Admin invitations by phone/email with level/branch scope (A5) — entirely absent. 7. Workspace profile: logo, country, timezone (A5). 8. Emergency Leave + Mission day statuses, date ranges, multi-member, member notify (A7.3). 9. Recurring shifts, team assignment, un-assign (A7.1). 10. Incident video evidence + multi-photo + draft saving (M10). 11. Org-wide admin vault view (A10) — decide the architecture first (needs a server-side org file
registry or an admin membership rule; the F14 test documents the current member-scoped state). 12. Visible-depth projection for M8 (algorithm already written down in the FIT carry-forward). 13. Vault + channel-membership events into `org_audit_log`. 14. Incident filter UI; `listOrgChannels` paging; ops-console hierarchy view.

**Small bugs found during this verification (not yet in sqa.md):**

- `myJoinRequest` org-name leak: pending screen shows the founder's personal display name
  (`enterprise-join.service.ts:365` — the sibling query at `:189` was already fixed; same file).
- `CreateWorkspaceScreen` shows generic "Something went wrong" when the server flag is off
  (404 not distinguished) — confusing failure for the exact first-run persona.
- Stale comments contradicting code: `DepartmentChannelsScreen.tsx:551-561` ("progressive"
  grouping that is now unconditional), `20260803020000...sql:112-120` (archive guard described as
  deferred; it's built at `department.service.ts:776`).

## 6. Doc drift — where the FIT doc no longer matches code (verified 2026-08-07)

| FIT doc claim                                                 | Reality                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paging deferred to Phase 6                                    | Keyset paging built for `listChannels` + `listChannelsForOps` (`departmentPaging.spec.ts`); only `listOrgChannels` remains                        |
| Broadcast archive guard deferred                              | Built: `broadcast_channel_cannot_be_archived` (`department.service.ts:776`)                                                                       |
| "All three paths call `assertNotUnderCorrection` and throw"   | `reviewSession` deliberately _withholds_ the disputed field instead of throwing (safer; doc wording wrong)                                        |
| Appendix table says A9/M8 "exists", A10/A11/M5/M11A "missing" | Appendix predates Phases 3–6; superseded by §2 above                                                                                              |
| "Phase 4 — Enterprise Vault"                                  | Overstates: what shipped is a client-side company _shelf_; no server/org storage changed (the doc's own body concedes this; the F14 test pins it) |

## 7. Feature-flag map (who is live today)

| Surface                                                                                    | Flag-gated?                                                          |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Channel hierarchy + post modes + `#broadcast` (server)                                     | **NOT gated** — live for any entitled org now                        |
| Dept chat send/receive enforcement (client)                                                | not gated                                                            |
| Join/approval loop (server `EnterpriseJoinController`)                                     | **not gated**                                                        |
| `POST/GET /org/workspace`                                                                  | gated: 404 unless `DEPT_CHAT_V2_ENABLED=true`                        |
| Attendance v2 (shifts CRUD, my-shift, review, day-status, org summary/export, rollup cron) | gated per-route                                                      |
| Roster + corrections controller                                                            | gated (class level)                                                  |
| Incident controller                                                                        | gated (class level)                                                  |
| Mobile entry points (5 nav sites)                                                          | `EXPO_PUBLIC_DEPT_CHAT_V2` — **`true` in `.env.production` already** |

Asymmetry worth knowing: with the server flag off, a user can still _join_ a workspace (join
controller ungated) but the owner cannot _create_ one (workspace controller gated), and the
create screen shows a generic error for that 404.
