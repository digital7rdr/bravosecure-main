# Bravo Secure — Department Chat v2 BUILD RUNBOOK (Service-Provider ↔ CPO)

> **What this file is.** An ordered, **self-contained** build sequence for the _Department
> Chat v2_ module from `Bravo Department Chat Screen Mockups.pdf`, scoped to the
> **service-provider org managing its CPOs**: attendance verification, incident reporting,
> and the org admin console. Each step is a complete work packet — goal, context, exact
> files, backend + frontend how-to, security stop-conditions, acceptance tests — so you can
> hand **one step at a time** to a fresh engineer (or Claude session) without their needing
> to re-read the PDF or the codebase.
>
> **Format/companion reference:** modeled on the auto-dispatch build sequence — now **merged**
> (code in `apps/auth-service/src/dispatch/`; its background-loop/sweep convention is pinned in
> `apps/auth-service/src/dispatch/README.md`) — same packet shape, same gates, same security
> discipline. (There is no standalone `BUILD_RUNBOOK.md` in the repo; the auto-dispatch work
> shipped as code, not a doc.) Where a step says "Resolves: PDF p.N" it points at the matching
> mock-up page.
>
> **Source of truth for security:** the System Architecture Documentation. Any step marked
> with a 🛑 **stop-condition** touches a sensitive flow (biometrics, media, location, E2EE,
> auth) — re-read the architecture doc before coding, per `CLAUDE.md`.
>
> **🔄 Reconciled 2026-06-22** against the just-merged auto-dispatch / escrow / compliance drop
> (227 files). Three Step-1 assumptions changed and are corrected below: (a) `.github/workflows/ci.yml`
> **already** has `auth-service-test` + `auth-service-integration` jobs — don't add them; (b)
> `configuration.ts` **already** has a `featureFlags` block (`autoDispatch`) — add the `deptChatV2`
> key, don't create the block; (c) new migrations must be timestamped **after `20260628000001`**
> (the current max). The org-scoped `org_audit_log` (Step 3) is still net-new — it is **not** the
> HQ-tier `ops_audit` table that now exists. See §0.3 for the adjacent modules that shipped.

---

## 0. Scope, role mapping, and what already exists

### 0.1 Scope (read first)

This runbook builds the **V2 ADDITIONS** only — _attendance verification (face + location)_
and _structured incident reporting_ — plus the channel/dashboard wiring that surfaces them,
**for the service-provider tenant**. The E2EE chat itself (channels, group crypto) already
exists and is **not** rebuilt; chat is the _notification & coordination layer only_. Per the
PDF's key rule: **attendance and incident reports are structured operational objects, not chat
messages.**

### 0.2 PDF roles → Bravo model (the spine of every permission check)

There is **no new role system**. The PDF's four roles map onto the _existing_ tenant model
(verified in `apps/auth-service/src/org/`):

| PDF role (p.16)        | Bravo identity                                                                              | Resolved by                                               |
| ---------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Member**             | Managed CPO (`org_members.member_role='cpo'`, `status='active'`) or a self-registered agent | `JwtAuthGuard` → `user.sub`                               |
| **Department Manager** | `org_members.member_role='manager'`, `status='active'`                                      | `OrgManagerGuard` Path 2                                  |
| **Company Admin**      | the `company` agent itself (`agents.type='company'`, role `service_provider`)               | `OrgManagerGuard` Path 1 (`org_user_id == user_id`)       |
| **Bravo Admin**        | HQ ops staff (`admin_users`)                                                                | `AdminGuard` — a **different trust tier**, never conflate |

**Tenant key:** an org = the `company` agent's `users.id` — the same id `org_members.org_user_id`,
`cpo_shift_sessions.org_user_id`, and `department_channels.org_id` already reference. Every
provider-scoped query is filtered by this id and isolated with `assertOrgScope(manager, targetOrgId)`
(`apps/auth-service/src/org/org-manager.guard.ts`).

> **v1 simplification (flag, don't silently drop):** the PDF distinguishes _department admin_
> ("sees only assigned departments") from _company admin_ ("sees all departments"). The current
> model has **no per-department manager sub-scoping** — a manager governs the whole org and
> `department` is a free-text label on shifts/incidents/channels. v1 ships **manager = org-wide**;
> per-department manager scoping is a tracked v2.1 refinement. State this in the PR description so
> QA doesn't file it as a bug.

### 0.3 What already exists (verified — do NOT rebuild)

- **Org/CPO model:** `org_members` (roles `cpo`/`manager`, status `invited|active|suspended|removed`),
  `agents.managed_by_org_id`, `OrgCpoService` (`createManagedCpo`, `listRoster`, `setMemberStatus`),
  `OrgManagerGuard` + `assertOrgScope`. Migrations `20260610000000` / `20260610010000`.
- **Attendance (basic):** `cpo_shift_sessions` (geotagged clock-in/out, one open shift per CPO,
  provider edit-with-audit) + `AttendanceService` (`clockIn`/`clockOut`/`myShifts`/`orgShifts`/`editShift`)
  - `AttendanceController` (`/attendance/*`, JwtAuthGuard for CPO self, OrgManagerGuard for provider).
    Mobile: `src/screens/agent/AttendanceScreen.tsx`, `attendanceApi` in `src/services/api.ts`.
- **E2EE chat:** `department_channels` + `department_channel_members` (role `admin`/`viewer`) +
  `channel_membership_intents` (admin-device drains the rekey queue — server holds **no** group key) +
  `DepartmentService` (`seedOrgWorkspace`, `addMember`/`removeMember`, `list*MembershipIntents`/`ack`).
  Mobile: `src/screens/messenger/DepartmentChannelsScreen.tsx` + `MessengerNavigator`. Migrations
  `20260603000000` / `20260610010000`.
- **Encrypted media:** chat attachments are AES-256-CBC, unique key per file, encrypted-before-upload
  to the Supabase S3 endpoint (see memory `project_encrypted_media`). Step 10 reuses this for incident
  evidence — it is **not** reinvented.
- **Auto-dispatch / escrow / compliance (merged 2026-06-22 — adjacent, mostly out of scope, reuse where noted):**
  the `dispatch/` module (FSM-style transitions, Redis-locked sweeps — see its `README.md`), a `settlement/`
  module, a `compliance/` module + ops-console `/compliance` page (booking terms / privacy consent), the
  HQ-tier `ops_audit` table via `OpsAuditService`, and `privacy_consent` + `dispatch-privacy-purge`
  infrastructure. **Reuse candidates to check before building:** the sweep convention (Conventions §4) and
  the privacy-consent/purge pattern for Step 5/14's location + face consent. **Do NOT conflate** `ops_audit`
  (HQ / `AdminGuard` tier) with the org-scoped `org_audit_log` this runbook creates in Step 3.

### 0.4 Gap table (this runbook closes these)

| PDF area                     | Today                   | To build                                                                                 |
| ---------------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| Shift object (p.3,5,16)      | free clock-in, no shift | `cpo_shifts` + assignment, "today's shift", block-if-none                                |
| Face verification (p.6)      | none                    | on-device face-presence confirm, store **result + metadata only**                        |
| Radius/location check (p.6)  | raw geotag only         | approved-radius eval → in/out-of-radius                                                  |
| Statuses (p.8,17)            | open/closed/edited      | present/late/absent/early_checkout/leave/sick_leave/off_duty/pending_review              |
| Pending Review (p.6,7,9)     | none                    | review records + reason + admin approve/reject + immutable original                      |
| Admin attendance view (p.9)  | raw session list        | summary counts + pending queue + filters                                                 |
| Export (p.10)                | none                    | PDF + CSV, filters, export audit log, no biometrics                                      |
| Incident reporting (p.11–15) | **none**                | full subsystem: submit → route → FSM → queue → detail                                    |
| Channels Hub v2 (p.4)        | flat channel list       | channel types + read-only/restricted/incident badges                                     |
| Dashboard v2 (p.3)           | agent dashboard         | Attendance + Report Incident quick actions, today's status                               |
| Channel management (p.4,16)  | 3 auto-seeded defaults  | manager create/configure (type+access) + membership editor + CPO auto-join — **Step 18** |

---

## Conventions (apply to every step)

1. **Build in order.** Steps are dependency-ordered; each lists `Depends on:`.
2. **One step = one focused PR**, behind the `DEPT_CHAT_V2` flag (Step 1) until Step 17 flips it on.
   The legacy attendance/chat flows must keep working the whole time.
3. **Migrations are additive + idempotent** (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`,
   `CREATE INDEX IF NOT EXISTS`), with a commented down-migration at the foot — mirror
   `20260610000000_provider_orgs_and_managed_cpos.sql`. New tables get **RLS deny-by-default**
   (`ENABLE` + `FORCE ROW LEVEL SECURITY`, no policies; the NestJS `rolbypassrls` role bypasses).
   Pick a `<ts>` filename prefix **greater than the current max migration** (`20260628000001` as of the
   2026-06-22 pull) so it applies last — `ls supabase/migrations | tail -1` to recheck before naming.
4. **Background sweeps** (auto-absent rollup, reminders) use the Redis `SET NX`-locked `setInterval`
   pattern — **never** `@nestjs/schedule`. The convention is now pinned in
   `apps/auth-service/src/dispatch/README.md`; copy a shipped example
   (`booking/payment-pending-expiry.service.ts`, `booking/escrow-release-sweep.service.ts`, or
   `dispatch/offer-expiry.service.ts`).
5. **Org scope on every provider query:** `OrgManagerGuard` + `assertOrgScope`. Re-read the DB; never
   trust a JWT claim for org ownership.
6. **No crypto/auth weakening, no PII in logs** (descriptions, coordinates, credential refs, biometric
   bytes). The static log-audit test enforces this.
7. **Gates per step:** `apps/auth-service && npm test`; mobile `npm run typecheck` (≤ the baseline in
   `.tsc-baseline.json`); `cd apps/ops-console && npm run typecheck`; `npm run lint`. Never commit on a
   red gate; never `--no-verify`.

---

## Master step index

**Stage 0 · Foundations**

- **Step 1** — Branch, `DEPT_CHAT_V2` feature flag, CI for attendance/incident, role-map doc _(start here)_
- **Step 2** — Attendance v2 DB migration (`cpo_shifts`, assignments, session statuses + verification + review) _(dep:1)_
- **Step 3** — Incident reporting DB migration (`incident_reports`, `incident_events`, ref seq) + `org_audit_log` _(dep:1)_

**Stage 1 · Attendance verification (provider manages CPO shifts)**

- **Step 4** — Shift CRUD + assignment; CPO "today's shift"; block check-in when none _(dep:2)_
- **Step 5** — Check-in/out v2: face confirmation + approved-radius + status + Pending Review _(dep:2,4)_ 🛑
- **Step 6** — Review workflow: statuses, leave/sick/off-duty, admin approve/reject (immutable original) _(dep:5)_
- **Step 7** — Admin attendance view (summary + pending queue) + Export (PDF/CSV, audit-logged) _(dep:5,6)_

**Stage 2 · Incident reporting**

- **Step 8** — Incident submit API (category/severity/details/location) + ref ID + manager routing _(dep:3)_
- **Step 9** — Incident status FSM + manager queue + internal notes + reopen _(dep:8)_
- **Step 10** — Incident evidence: optional encrypted photo (reuse media vault) + restricted access _(dep:8)_ 🛑
- **Step 11** — Notifications: push + in-app on submit/status-change + attendance reminders _(dep:8,9)_

**Stage 3 · Surfaces (mobile + ops-console)**

- **Step 12** — Channels Hub v2: channel types + read-only/restricted + incident-channel gating _(dep:1)_
- **Step 13** — Dashboard v2: Attendance + Report Incident quick actions + today's status + role-gated alerts _(dep:4,8)_
- **Step 14** — Member mobile screens (Attendance, Verify, Result, My Attendance, Report-Incident wizard, Submitted) _(dep:5,6,8,10)_
- **Step 15** — Manager/Admin screens (Admin Attendance, Pending Review, Export, Incident Queue, Incident Detail) _(dep:7,9)_

**Stage 4 · Cross-cutting & rollout**

- **Step 16** — Permissions matrix enforcement + audit logging + compliance-wording sweep _(dep:4–11)_
- **Step 17** — QA retest checklist, acceptance gates, staged rollout (flag flip) _(dep:all)_

**Stage 5 · Post-v1 additions (scope-gap closure)**

- **Step 18** — Manager channel management (create/configure type+access + membership editor) + CPO auto-join _(dep:12, §0.3 rekey seam)_

**Stage 6 · Dedicated "Departmental" surface (100% PDF realization)**

- **Step 19** — One **Departmental** module with the PDF's 5-tab shell (Home · Channels · Attend · Incident · Vault), role-aware for **both parties** (managed CPO/member + service-provider company/manager), reusing the Step 12–18 screens; closes the scattered-entry-point + CpoNavigator-wiring gaps _(dep:12–18)_

**Stage 7 · Reachability & onboarding gaps (make the built features actually usable)**

> See the **Gap Register** below for the evidence (PDF-intent vs wired reality, with file citations). These steps close the gaps that leave Steps 1–18 _built but unreachable_.

- **Step 20** — **Add-Manager onboarding UI**: role toggle (CPO / Manager) on the roster create screen so a company can actually create a Department Manager _(dep:0.3 org model)_
- **Step 21** — **Shift management UI** (create shift + assign CPOs): the missing surface that today makes every check-in impossible (`myTodayShift` is always null → "No active shift") _(dep:4)_ 🔴 **blocks all attendance**
- **Step 22** — **Delegated-manager mobile surface**: a manager (`member_role='manager'`, `agents.type='cpo'`) currently sees no manager screens because they're `isOrg`-gated on `agent.type==='company'`; fix the gate + add day-status (leave/sick/off-duty) and export entries _(dep:6,7,9,15)_
- **Step 23** — **Member "My submitted incidents" list** (`incidentApi.mine` is built but unused; PDF p.16 "view own submitted incidents") — fold into the Step-19 Incident tab _(dep:8,19)_
- **Step 24** — **Enablement runbook** (operational, not code): server `DEPT_CHAT_V2_ENABLED` per pilot org, client `EXPO_PUBLIC_DEPT_CHAT_V2` build, channel provisioning (admin device bootstraps each group), shift seeding _(dep:17)_

---

## Step 1 — Branch, `DEPT_CHAT_V2` feature flag, CI, role-map doc

**Stage:** Foundations · **Depends on:** (none) · **Resolves:** PDF p.16 (roles) groundwork
**Goal (plain English):** Start the whole module on its own branch, hidden behind one on/off
switch on both server and app, so we can build it "dark" without changing today's attendance or
chat behaviour. Make sure the backend test robot actually runs the new attendance/incident tests,
and write down the PDF-role → Bravo-model mapping once so every later step references it.
**Why it matters:** Without the flag, half-built attendance/incident code could alter live clock-in
or chat. The CI gap that earlier hid `auth-service` specs is **already closed** — the 2026-06-22
auto-dispatch merge added `auth-service-test` (+ `auth-service-integration`) jobs to `ci.yml`, so new
attendance/incident specs run automatically; this step just confirms they appear in PR checks.
**Self-contained context:**

- Backend flags live in `apps/auth-service/src/config/configuration.ts` (built from `process.env[...]`
  with the `=== 'true'` idiom). A `featureFlags` block **already exists**
  (`autoDispatch: process.env['AUTO_DISPATCH_ENABLED'] === 'true'`) — **add a sibling key**
  `deptChatV2: process.env['DEPT_CHAT_V2_ENABLED'] === 'true'` to it, don't recreate the block; read via
  `ConfigService.get('featureFlags.deptChatV2')` (ConfigModule is `isGlobal`).
- Mobile flag home is `src/utils/constants.ts` (inlines `EXPO_PUBLIC_*` at bundle time). Prefer a
  server-driven `deptChatV2: boolean` on the login/bootstrap response (flip without rebuild); fall back
  to `export const DEPT_CHAT_V2 = process.env.EXPO_PUBLIC_DEPT_CHAT_V2 === 'true';`.
- CI: `.github/workflows/ci.yml` **already runs** `auth-service` specs (`auth-service-test` +
  `auth-service-integration` jobs landed with the auto-dispatch merge). **No CI change needed** — just
  verify the new attendance/incident specs are picked up.
  **Files to touch:**
- EXTEND `apps/auth-service/src/config/configuration.ts` — add `featureFlags.deptChatV2` (default OFF) as a sibling of `autoDispatch`.
- EXTEND `src/utils/constants.ts` — add `DEPT_CHAT_V2` and/or plumb `deptChatV2` through bootstrap.
- `.github/workflows/ci.yml` — **no change** (`auth-service-test`/`auth-service-integration` jobs already exist); just ensure new specs land where those jobs pick them up.
- NEW `docs/planning/DEPT_CHAT_V2_RUNBOOK.md` already holds §0.2 — link it from the module README.
- Create branch `feat/dept-chat-v2` off `main` (don't commit until asked).
  **Backend how-to:** Introduce the flag with default OFF; every new controller/route added later checks
  it and 404s/no-ops when false, so the legacy `/attendance/*` surface is byte-for-byte unchanged.
  **Frontend how-to:** Add the constant/bootstrap field; gate new nav entries on it. No screen changes yet.
  **Security stop-conditions:** None — but the flag gates the FEATURE only, never a guard. Do not add a
  "skip in dev" branch to `JwtAuthGuard`/`OrgManagerGuard`/`AdminGuard`.
  **Acceptance & tests:**
- New backend unit test: with `DEPT_CHAT_V2_ENABLED` unset, the new routes are gated off and legacy
  `/attendance/*` is unaffected.
- Gates: `apps/auth-service && npm test`; mobile + ops-console typecheck ≤ baseline; lint. The existing
  `auth-service-test` CI job picks up the new specs (no new job needed).
  **Done when:**
- [ ] Branch `feat/dept-chat-v2` exists; `featureFlags.deptChatV2` (default OFF, sibling of `autoDispatch`) and a mobile flag are readable.
- [ ] New attendance/incident specs run under the existing `auth-service-test` CI job and appear in PR checks.
- [ ] §0.2 role map is committed and linked.

## Step 2 — Attendance v2 DB migration

**Stage:** Data model · **Depends on:** Step 1 · **Resolves:** PDF p.3,5,6,8,16 (Shift, statuses, verification)
**Goal (plain English):** Add the database structures attendance needs: a **Shift** (when/where a CPO is
expected, with an approved radius), a roster of which CPOs are assigned to it, and extra columns on the
existing shift-session so a check-in can record the face-confirmation result, whether it was inside the
radius, the resulting status (present/late/…), and a review outcome — **without** touching the geotagged
data already captured.
**Why it matters:** The current `cpo_shift_sessions` has no shift, no statuses beyond open/closed/edited,
and no verification or review columns — the v2 screens literally cannot render "Today's shift",
"Pending Review", or "Late".
**Self-contained context:**

- The PDF `Shift` object = `{shiftId, departmentId, siteId, startTime, endTime, approvedRadius, assignedMembers}`.
  In our single-tenant model there is no separate `departments`/`sites` table — model `department` and
  `site` as labels + a geofence centre on the shift row.
- Existing `cpo_shift_sessions` (migration `20260610000000`) already has `org_user_id`, `cpo_user_id`,
  `status('open'|'closed'|'edited')`, `clock_in_at/lat/lng/accuracy_m`, `clock_out_at/lat/lng`, edit-audit
  cols. **Keep these; the original captured geotag is immutable** (PDF p.7,9). New columns are _additive_.
- `attendance_status` and `review_status` are small closed sets → use `TEXT` + `CHECK` (additive; avoids
  the well-known Postgres `ALTER TYPE ... ADD VALUE` outside-transaction hazard).
- **Face verification stores RESULT ONLY** (PDF p.6: "Do not store raw biometric data … store verification
  result and audit metadata"). The schema must have **no** column for raw frames/descriptors.
  **Files to touch:**
- NEW `supabase/migrations/<ts>_attendance_v2.sql` (use a `<ts>` after `20260628000001` — see Conventions §3).
- EXTEND `apps/auth-service/src/attendance/attendance.service.ts` row interface `ShiftSession` (+ a new
  `Shift` interface) with the added columns.
  **Backend how-to (migration sketch):**

```sql
-- Shift = expected duty window + geofence centre + radius (per org)
CREATE TABLE IF NOT EXISTS public.cpo_shifts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_user_id      UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  department       TEXT,                       -- label, e.g. 'Operations'
  site_label       TEXT,                       -- e.g. 'Main Office'
  site_lat         DOUBLE PRECISION,
  site_lng         DOUBLE PRECISION,
  approved_radius_m INT NOT NULL DEFAULT 150,  -- the radius check tolerance
  start_at         TIMESTAMPTZ NOT NULL,
  end_at           TIMESTAMPTZ NOT NULL,
  created_by       UUID NOT NULL REFERENCES public.users(id),
  archived_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cpo_shifts_org_idx ON public.cpo_shifts(org_user_id, start_at DESC)
  WHERE archived_at IS NULL;

-- assignedMembers (one row per assigned CPO)
CREATE TABLE IF NOT EXISTS public.cpo_shift_assignments (
  shift_id    UUID NOT NULL REFERENCES public.cpo_shifts(id) ON DELETE CASCADE,
  cpo_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (shift_id, cpo_user_id)
);
CREATE INDEX IF NOT EXISTS cpo_shift_assign_cpo_idx ON public.cpo_shift_assignments(cpo_user_id);

-- extend the session: link to a shift, record verification + status + review
ALTER TABLE public.cpo_shift_sessions
  ADD COLUMN IF NOT EXISTS shift_id              UUID REFERENCES public.cpo_shifts(id),
  ADD COLUMN IF NOT EXISTS face_verified         BOOLEAN,           -- result only
  ADD COLUMN IF NOT EXISTS face_meta             JSONB,             -- audit metadata, NO biometric bytes
  ADD COLUMN IF NOT EXISTS within_radius         BOOLEAN,
  ADD COLUMN IF NOT EXISTS distance_m            INT,               -- coarse, for review context
  ADD COLUMN IF NOT EXISTS attendance_status     TEXT
    CHECK (attendance_status IN
      ('present','late','absent','early_checkout','leave','sick_leave','off_duty','pending_review')),
  ADD COLUMN IF NOT EXISTS review_status         TEXT NOT NULL DEFAULT 'none'
    CHECK (review_status IN ('none','pending','approved','rejected')),
  ADD COLUMN IF NOT EXISTS review_reason         TEXT,              -- face_mismatch|out_of_radius|permission_denied|offline
  ADD COLUMN IF NOT EXISTS reviewed_by           UUID REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_notes           TEXT;

CREATE INDEX IF NOT EXISTS cpo_shift_sessions_review_idx
  ON public.cpo_shift_sessions(org_user_id) WHERE review_status = 'pending';

ALTER TABLE public.cpo_shifts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cpo_shifts             FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.cpo_shift_assignments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cpo_shift_assignments  FORCE  ROW LEVEL SECURITY;
-- (cpo_shift_sessions already has RLS from 20260610000000)
```

**Frontend how-to:** None (pure data model). Re-run typechecks after refreshing row types.
**Security stop-conditions:** 🛑 The schema must store **no raw biometric data** — `face_meta` is metadata
only (timestamp, model/version tag, confidence bucket), never frames or face descriptors. Confirm against
the System Architecture Documentation before merging.
**Acceptance & tests:**

- Migration applies clean on a scratch/branch DB; `list_tables` shows `cpo_shifts`,
  `cpo_shift_assignments`; `cpo_shift_sessions` shows the new columns; legacy rows untouched
  (`attendance_status`/`face_verified` NULL on old rows ⇒ legacy clock-in path still valid).
- Unit test asserting the `CHECK` constraints reject an invalid status/review value.
- Gates as §Conventions.
  **Done when:**
- [ ] `cpo_shifts` + `cpo_shift_assignments` exist with RLS + indexes.
- [ ] `cpo_shift_sessions` has shift link, verification result, status, and review columns; no biometric column.
- [ ] Legacy attendance data + path are unchanged.

## Step 3 — Incident reporting DB migration + `org_audit_log`

**Stage:** Data model · **Depends on:** Step 1 · **Resolves:** PDF p.11–16 (IncidentReport object), p.9/16 (audit)
**Goal (plain English):** Create the tables incident reporting needs: the incident record itself (who/what/
where/how severe/status), an immutable status-history + internal-notes log, a human-readable reference
generator (`INC-2026-00142`), and a generic org audit log every sensitive admin action writes to.
**Why it matters:** There is **no** incident infrastructure today. Without the history table the PDF's
"keep original submitter report immutable" and "every status update requires user + timestamp + note"
(p.15) can't be honoured; without the ref generator p.13 has no reference number.
**Self-contained context:**

- PDF `IncidentReport` = `{incidentId, submitterId, departmentId, category, severity, description,
location, photoRefs, status, assignedTo, managerNotes, timestamps}`.
- Categories (p.11, 15 of them): security_concern, safety_issue, medical_incident, suspicious_activity,
  access_control, property_damage, vehicle_issue, staff_misconduct, visitor_contractor, equipment_failure,
  operational_disruption, harassment_workplace, lost_property, fire_hazard, other.
- Severity: low | medium | high | critical. Status lifecycle: submitted → received → under_review →
  action_assigned → resolved → closed (the FSM lives in Step 9; the column + CHECK live here).
- The submitter's original report is **immutable** — description/category/severity/location are written
  once at submit and never updated. Manager activity (status changes, internal notes, assignment) goes to
  `incident_events`, not back onto the report row.
- `photoRefs` are _pointers_ only; the encrypted bytes live in the media vault (Step 10). Store no media here.
- **`org_audit_log` vs `ops_audit` (do not conflate the trust tiers):** an HQ-tier `ops_audit` table +
  `OpsAuditService` already exist (Bravo-admin / `AdminGuard` actions, written via `INSERT INTO ops_audit`,
  with `live_feed_events` fan-out). This step's `org_audit_log` is the **org-manager-scoped** sibling
  (provider actions on their own CPOs) — intentionally separate and still net-new. Don't repurpose
  `ops_audit` for provider actions, and don't route org actions through `OpsAuditService`.
  **Files to touch:**
- NEW `supabase/migrations/<ts>_incident_reports.sql` (use a `<ts>` after `20260628000001` — see Conventions §3).
- (Optional) re-run type-gen / extend a row interface for the new tables.
  **Backend how-to (migration sketch):**

```sql
CREATE SEQUENCE IF NOT EXISTS incident_ref_seq;   -- human ref counter

CREATE TABLE IF NOT EXISTS public.incident_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref           TEXT UNIQUE,                       -- 'INC-2026-00142', stamped at insert
  org_user_id   UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  submitter_id  UUID NOT NULL REFERENCES public.users(id),
  department    TEXT,                              -- label; routes to org manager(s)
  category      TEXT NOT NULL,                     -- one of the 15 (validated in DTO)
  severity      TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  description   TEXT NOT NULL,                     -- immutable submitter narrative
  location_label TEXT,
  location_lat  DOUBLE PRECISION,
  location_lng  DOUBLE PRECISION,
  status        TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','received','under_review','action_assigned','resolved','closed')),
  assigned_to   UUID REFERENCES public.users(id),  -- action owner
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS incident_org_status_idx ON public.incident_reports(org_user_id, status, severity);
CREATE INDEX IF NOT EXISTS incident_submitter_idx  ON public.incident_reports(submitter_id);

-- immutable status history + internal notes (append-only)
CREATE TABLE IF NOT EXISTS public.incident_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id  UUID NOT NULL REFERENCES public.incident_reports(id) ON DELETE CASCADE,
  actor_id     UUID NOT NULL REFERENCES public.users(id),
  from_status  TEXT,
  to_status    TEXT,
  note         TEXT,                               -- internal manager note (not member-visible)
  note_internal BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS incident_events_idx ON public.incident_events(incident_id, created_at);

-- photo pointers (bytes live encrypted in the media vault — Step 10)
CREATE TABLE IF NOT EXISTS public.incident_attachments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id  UUID NOT NULL REFERENCES public.incident_reports(id) ON DELETE CASCADE,
  storage_key  TEXT NOT NULL,                      -- vault object key, not a URL
  created_by   UUID NOT NULL REFERENCES public.users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- generic org audit (attendance review, exports, incident actions all write here)
CREATE TABLE IF NOT EXISTS public.org_audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_user_id  UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  actor_id     UUID NOT NULL REFERENCES public.users(id),
  action       TEXT NOT NULL,                      -- 'attendance.review.approve', 'incident.status', 'attendance.export'
  target_kind  TEXT,
  target_id    UUID,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb, -- NO PII / coordinates / descriptions
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS org_audit_idx ON public.org_audit_log(org_user_id, created_at DESC);

ALTER TABLE public.incident_reports     ENABLE ROW LEVEL SECURITY; ALTER TABLE public.incident_reports     FORCE ROW LEVEL SECURITY;
ALTER TABLE public.incident_events      ENABLE ROW LEVEL SECURITY; ALTER TABLE public.incident_events      FORCE ROW LEVEL SECURITY;
ALTER TABLE public.incident_attachments ENABLE ROW LEVEL SECURITY; ALTER TABLE public.incident_attachments FORCE ROW LEVEL SECURITY;
ALTER TABLE public.org_audit_log        ENABLE ROW LEVEL SECURITY; ALTER TABLE public.org_audit_log        FORCE ROW LEVEL SECURITY;
```

- `ref` stamping: in the submit transaction, `to_char(now(),'YYYY')` + `lpad(nextval('incident_ref_seq')::text,5,'0')` → `'INC-2026-00142'`.
  **Security stop-conditions:** 🛑 `org_audit_log.metadata` and any log line must hold **no** incident
  description, coordinates, or credential refs (log-audit test). Attachments store an opaque `storage_key`,
  never a signed URL.
  **Acceptance & tests:**
- Migration applies clean; `list_tables` shows the four tables; `incident_reports.ref` is UNIQUE.
- Unit test: severity/status `CHECK` constraints reject bad values; two inserts get distinct refs.
- Gates as §Conventions.
  **Done when:**
- [ ] `incident_reports` (+ ref seq), `incident_events`, `incident_attachments`, `org_audit_log` exist with RLS + indexes.
- [ ] Submitter narrative columns are write-once by design; manager activity is modeled in `incident_events`.

---

## Step 4 — Shift CRUD + assignment; CPO "today's shift"; block check-in when none

**Stage:** Attendance · **Depends on:** Step 2 · **Resolves:** PDF p.3,5 (today's shift, "no active shift" block), p.5 admin-logic (admin assigns shifts)
**Goal (plain English):** Let the org admin create shifts and assign CPOs to them, and let a CPO see
"today's assigned shift" before checking in. If a CPO has no shift today, the app shows "No active shift
assigned" and the check-in button is disabled.
**Why it matters:** Check-in v2 (Step 5) must validate against an assigned shift (radius centre, expected
window); without shift CRUD there's nothing to check against and "block when none" can't be enforced.
**Self-contained context:**

- Provider routes go through `OrgManagerGuard` (company account or active manager). CPO read routes use
  `JwtAuthGuard` scoped to `user.sub`. Mirror `AttendanceController`'s two-scope layout.
- "Today's shift" = the assignment for `cpo_user_id` whose `cpo_shifts.start_at..end_at` window covers now
  (or the soonest upcoming one today). Return it with the site/radius so Step 5/UI can render and geofence.
  **Files to touch:**
- EXTEND `apps/auth-service/src/attendance/attendance.service.ts` — `createShift`, `assignCpos`,
  `listOrgShifts`, `myTodayShift`.
- EXTEND `apps/auth-service/src/attendance/attendance.controller.ts` — `POST /attendance/shifts`,
  `POST /attendance/shifts/:id/assignments`, `GET /attendance/shifts` (manager), `GET /attendance/my-shift/today` (CPO).
- EXTEND `apps/auth-service/src/attendance/dto/attendance.dto.ts` — `CreateShiftDto`, `AssignCposDto`.
- EXTEND `src/services/api.ts` `attendanceApi` — `createShift`, `assignCpos`, `myTodayShift`, `listShifts`.
  **Backend how-to:**
- `createShift(manager.org_user_id, dto)` inserts into `cpo_shifts` with `created_by = manager.user_id`.
- `assignCpos(orgId, shiftId, cpoUserIds)` — **verify each CPO is an active `org_members` row of THIS org**
  (tenant isolation, mirror `applyAsOrg`'s `cpo_not_active_member_of_org` check) before inserting
  `cpo_shift_assignments`.
- `myTodayShift(cpoUserId)` — join `cpo_shift_assignments` → `cpo_shifts` for today's window; return `null`
  when none (UI shows the block state).
  **Frontend how-to:** Wire `attendanceApi.myTodayShift()` into the Attendance dashboard (Step 14); manager
  shift-create UI is part of Step 15. No screen here beyond API plumbing.
  **Security stop-conditions:** None new. Enforce `assertOrgScope` on every `:id` route.
  **Acceptance & tests:**
- Unit: assigning a CPO from another org → 400 `cpo_not_active_member_of_org`; `myTodayShift` returns the
  covering shift and `null` when unassigned.
- Gates as §Conventions.
  **Done when:**
- [ ] Manager can create a shift + assign active org CPOs (cross-org assignment rejected).
- [ ] `GET /attendance/my-shift/today` returns the shift or null; gated behind `DEPT_CHAT_V2`.

## Step 5 — Check-in/out v2: face confirmation + approved-radius + status + Pending Review 🛑

**Stage:** Attendance · **Depends on:** Step 2, Step 4 · **Resolves:** PDF p.4,5,6,7 (verify flow, result, pending review)
**Goal (plain English):** Replace the bare clock-in with a verified one: the CPO confirms their face on
camera and shares location; the server records whether the face check passed, whether they were inside the
shift's approved radius, and derives a status (present / late). If the face check fails, they're outside the
radius, location was denied, or it was an offline submission, the record becomes **Pending Review** — never
silently "Absent".
**Why it matters:** This is the core of attendance verification (PDF p.6–7). The failure semantics are a
QA gate: "Location denied creates Pending Review, not Absent"; "Face failure creates Pending Review with
reason visible to admin" (p.17).
**Self-contained context:**

- Extend the existing `AttendanceService.clockIn`/`clockOut` (don't fork). Inputs gain `face_ok: boolean`,
  `face_meta` (model/version tag, confidence bucket — **no biometric bytes**), and the geo already captured.
- **Status derivation (server-side, authoritative):**
  - `pending_review` if `face_ok=false` OR location denied (no coords) OR `within_radius=false` OR offline-queued submission. Set `review_reason` accordingly (`face_mismatch|out_of_radius|permission_denied|offline`) and `review_status='pending'`.
  - else `late` if `clock_in_at > shift.start_at + grace` (e.g. 10 min), else `present`.
- `within_radius` = haversine(`clock_in`, `shift.site`) ≤ `approved_radius_m`. Compute server-side; the
  client's claim is advisory only.
- Block check-in when `myTodayShift` is null (`no_active_shift_assigned`) — enforce server-side too.
- **Immutable original:** write the captured geotag/time/verification once; later admin review (Step 6)
  writes only the review columns, never overwrites the capture (PDF p.7,9).
  **Files to touch:**
- EXTEND `attendance.service.ts` `clockIn`/`clockOut` (status derivation, radius eval, review flagging).
- EXTEND `dto/attendance.dto.ts` `ClockInDto`/`ClockOutDto` (+ `face_ok`, `face_meta`, `shift_id`).
- EXTEND mobile `attendanceApi.clockIn/clockOut` signatures.
  **Backend how-to:** Resolve the CPO's today shift; if none → `BadRequestException('no_active_shift_assigned')`.
  Compute `within_radius`/`distance_m`; derive `attendance_status` + `review_status`/`review_reason`; persist.
  On clock-out, derive `early_checkout` when `clock_out_at < shift.end_at - grace`.
  **Frontend how-to:** Built in Step 14 (Verify screen → camera presence + geo → confirm). API contract here.
  **Security stop-conditions:** 🛑 **Biometrics + location.** (1) DECIDED for v1: the face step is
  _presence/liveness confirmation_ only — store the boolean result + non-biometric `face_meta`, never
  upload/store/log frames or descriptors. A 1:1 identity matcher is **out of scope for v1** (Appendix A#1);
  do not add one without architecture/legal sign-off. (2) Location is captured **only** during this action —
  no continuous/background tracking (PDF compliance note + `CLAUDE.md`). Do not add a background geolocation task.
  **Acceptance & tests:**
- Unit: denied location → `pending_review` + `permission_denied` (not absent); out-of-radius →
  `pending_review` + `out_of_radius`; `face_ok=false` → `pending_review` + `face_mismatch`; in-radius +
  on-time + face_ok → `present`; late clock-in → `late`; check-in with no shift → `no_active_shift_assigned`.
- Regression: existing `attendance.service.spec.ts` still passes (legacy path when flag off / no shift cols).
- Gates as §Conventions.
  **Done when:**
- [ ] Check-in records face result + radius result + derived status; failures → Pending Review with reason.
- [ ] No biometric bytes stored or logged; no background location added; original capture immutable.

**As-built addendum (2026-07-02, D6-e wiring):** the distinct `camera_unavailable` review reason is now
wired end-to-end — migration `20260630000000_attendance_review_reason_camera.sql` applied;
`ClockInDto.face_unavailable` declared (was being stripped by the whitelist ValidationPipe — regression
test added in `attendance.service.spec.ts`); `VerifyAttendanceScreen` sends `face_unavailable: true` on
camera denial (previously mislabelled as `face_mismatch`); `reviewReasonLabel` renders the new reason.

## Step 6 — Review workflow: statuses, leave/sick/off-duty, admin approve/reject

**Stage:** Attendance · **Depends on:** Step 5 · **Resolves:** PDF p.7,8,9 (statuses, manual approval, immutable capture)
**Goal (plain English):** Give managers the workflow to clear the Pending Review queue (approve/reject with
a note), and support the non-check-in statuses a roster needs — leave, sick leave, off-duty, and an
auto-marked absent when an assigned CPO never checked in.
**Why it matters:** PDF p.8/17 require the full status set and p.9 requires "approve or reject Pending Review
records with notes", "every admin action audit logged", "manual edits keep original captured data".
**Self-contained context:**

- Approve a pending record → `review_status='approved'`, set the final `attendance_status` (present/late),
  `reviewed_by`/`reviewed_at`, optional `admin_notes`; reject → `review_status='rejected'` (status stays
  flagged / treated per policy). Write an `org_audit_log` row each time.
- Leave/sick/off-duty are manager-set (or CPO-requested → manager-approved) statuses on a session row (or a
  zero-duration session for a day with no check-in). Keep it simple in v1: manager sets the status on the day.
- **Auto-absent rollup (background sweep):** a CPO assigned to a shift whose `end_at` passed with no session
  → create an `absent` marker. Use the Redis `SET NX` `setInterval` pattern (never `@nestjs/schedule`).
  **Files to touch:**
- EXTEND `attendance.service.ts` — `reviewSession(orgId, editor, sessionId, decision, notes)`, `setDayStatus`.
- NEW `apps/auth-service/src/attendance/attendance-rollup.service.ts` — Redis-locked absent sweep
  (`OnModuleInit`/`OnModuleDestroy` + `setInterval` + `SET NX`).
- EXTEND `attendance.controller.ts` — `PATCH /attendance/sessions/:id/review`, `POST /attendance/day-status`.
  **Backend how-to:** All provider routes `OrgManagerGuard` + `assertOrgScope`. `reviewSession` updates only
  review columns (never the captured geotag). Sweep lock `LOCK_TTL_MS` < interval.
  **Security stop-conditions:** None new — but every approve/reject/edit **must** write `org_audit_log` (p.9).
  **Acceptance & tests:**
- Unit: approve flips review_status + final status + writes audit; reject is audited; the captured
  `clock_in_lat`/`clock_in_at` are unchanged after review (immutability assertion).
- Sweep test: an assigned-but-no-session CPO past `end_at` → one `absent` row; idempotent under double-fire (lock).
- Gates as §Conventions.
  **Done when:**
- [ ] Managers approve/reject pending records with notes; all actions audited; original capture immutable.
- [ ] Leave/sick/off-duty settable; auto-absent sweep is single-fire across replicas.

**As-built addendum (2026-07-02, notes UI):** the "with notes" half was backend-only — the mobile
`AdminAttendanceScreen` approve/reject called `reviewSession(id, decision)` with no notes argument and had
no input. Now fixed: approve/reject opens a modal (Alert.prompt is iOS-only) with an optional notes field;
trimmed notes flow to `admin_notes` via the existing `ReviewSessionDto.notes`.

## Step 7 — Admin attendance view + Export (PDF/CSV, audit-logged)

**Stage:** Attendance · **Depends on:** Step 5, Step 6 · **Resolves:** PDF p.9 (summary + pending queue + filters), p.10 (export)
**Goal (plain English):** Build the admin attendance read model — counts of Present/Late/Absent, the Pending
Review queue, and filters (date, department, shift, member) — and a controlled export to PDF + CSV that
records who exported what and when, and never includes biometric images.
**Why it matters:** PDF p.9/10. Export access is admin-only and audit-logged; "do not include biometric
images in standard export."
**Self-contained context:**

- Summary = grouped counts over `cpo_shift_sessions` for the org in a date range. Pending queue = rows where
  `review_status='pending'` with their `review_reason`.
- Export columns (p.10): member name, id, department, shift, check-in, check-out, status, verification result,
  admin notes. **No biometric images.** Record an `org_audit_log` row (`action='attendance.export'`,
  metadata = `{from, to, department, shift, format}` — no PII).
- CSV is straightforward server-side; PDF can reuse whatever PDF path the codebase already uses (check before
  adding a new dependency — `npm run deadcode`/reuse rule).
  **Files to touch:**
- EXTEND `attendance.service.ts` — `orgSummary(orgId, filters)`, `pendingQueue(orgId)`, `exportSessions(orgId, filters, format)`.
- EXTEND `attendance.controller.ts` — `GET /attendance/org/summary`, `GET /attendance/org/pending`, `POST /attendance/org/export`.
- ops-console: `apps/ops-console/src/lib/api.ts` + an Admin Attendance page (Bravo-admin oversight).
  **Security stop-conditions:** 🛑 Export must exclude any biometric data and must write an audit row before
  returning the file. Provider scope enforced; Bravo-admin oversight goes through `AdminGuard`, not OrgManagerGuard.
  **Acceptance & tests:**
- Unit: summary counts match seeded data; export omits biometric fields; an audit row is written with the
  filters/format; export by a non-manager → 403.
- Gates as §Conventions.
  **Done when:**
- [ ] Admin sees Present/Late/Absent counts + Pending queue with reasons + filters.
- [ ] PDF + CSV export works, excludes biometrics, and is audit-logged (admin, date, filters, format).

---

## Step 8 — Incident submit API + ref ID + manager routing

**Stage:** Incidents · **Depends on:** Step 3 · **Resolves:** PDF p.11,12,13 (category/severity → details → submitted+ref)
**Goal (plain English):** Let any member submit a structured incident — pick a category and severity, add a
description, optional location and (later) photo — and get back an immutable reference like `INC-2026-00142`.
The incident routes to the submitter's org manager(s) and starts at status `submitted`.
**Why it matters:** This is the spine of the incident subsystem (PDF p.11–13). The ref + initial status +
manager routing are explicit requirements.
**Self-contained context:**

- Any authenticated member may submit (`JwtAuthGuard`, `user.sub`). The org is resolved from `org_members`
  (or self for a self-registered agent) — mirror `AttendanceService.resolveOrg`.
- Validate `category` against the 15-item allow-list and `severity` against the 4-item set in the DTO.
- "Manager routing" = the report is visible to `OrgManagerGuard` callers of that org (queue in Step 9) +
  a notification (Step 11). **Do not post the incident body into any chat channel** (p.13).
- Stamp `ref` in the insert transaction from `incident_ref_seq`.
  **Files to touch:**
- NEW `apps/auth-service/src/incident/incident.module.ts` / `incident.service.ts` / `incident.controller.ts` / `dto/incident.dto.ts`.
- Register `IncidentModule` in `app.module.ts`.
- EXTEND `src/services/api.ts` — `incidentApi.submit`, `incidentApi.mine`.
  **Backend how-to:** `submit(submitterId, dto)` → resolve org → insert `incident_reports` (status `submitted`,
  ref stamped) → insert an `incident_events` row (`to_status='submitted'`, actor=submitter) → return `{id, ref,
status, severity}`. `mine(submitterId)` lists the member's own submitted incidents (p.16: "view own
  submitted incidents").
  **Security stop-conditions:** 🛑 Never write the incident description/location into `org_audit_log` metadata
  or any log line. Never broadcast the body to a channel.
  **Acceptance & tests:**
- Unit: submit returns a unique `INC-YYYY-NNNNN` ref + status `submitted`; invalid category/severity → 400;
  a member can list only their own incidents.
- Gates as §Conventions.
  **Done when:**
- [ ] Any member can submit; ref generated; initial status `submitted`; routed to org (queue-visible) without leaking into chat.

## Step 9 — Incident status FSM + manager queue + internal notes + reopen

**Stage:** Incidents · **Depends on:** Step 8 · **Resolves:** PDF p.14 (manager queue), p.15 (status workflow, internal notes, reopen)
**Goal (plain English):** Give managers the review queue (sorted Critical/High first, filterable) and the
status workflow — move an incident through Received → Under Review → Action Assigned → Resolved → Closed,
each transition recording who/when/optional note, with internal notes members can't see, and a
company-admin reopen.
**Why it matters:** PDF p.14/15. The lifecycle, immutable submitter report, and internal-notes visibility
are explicit.
**Self-contained context:**

- **FSM** (mirror `apps/auth-service/src/booking/state-machine.service.ts` `TRANSITIONS[]` style):
  `submitted→received→under_review→action_assigned→resolved→closed`; `resolved→under_review` (rework);
  `closed→under_review` (company-admin reopen only, p.15). Actors: manager/company-admin. Reject illegal hops.
- Each transition: update `incident_reports.status` + `updated_at`, append an `incident_events` row
  (from/to/actor/note), write `org_audit_log` (`action='incident.status'`). The submitter report row's
  category/severity/description/location are **never** updated.
- Queue: org-scoped, `ORDER BY severity (critical>high>medium>low), updated_at DESC`; filters status/severity/
  category/date/submitter. Manager-only (`OrgManagerGuard`); members never see the queue (p.16,17).
  **Files to touch:**
- EXTEND `incident.service.ts` — `queue(orgId, filters)`, `detail(orgId, id)`, `updateStatus(orgId, actor, id, to, note)`, `assign(orgId, id, ownerId)`, `addNote(...)`.
- NEW `apps/auth-service/src/incident/incident-fsm.ts` (transitions table + `assertTransition`).
- EXTEND `incident.controller.ts` — `GET /incidents/queue`, `GET /incidents/:id`, `PATCH /incidents/:id/status`, `POST /incidents/:id/note`.
- EXTEND `src/services/api.ts` — `incidentApi.queue/detail/updateStatus/addNote`.
  **Security stop-conditions:** 🛑 Internal notes (`incident_events.note_internal=true`) must never be returned
  on the member-facing `mine`/detail view — only on the manager detail. Reopen restricted to company-admin
  (Path 1), not delegated managers, unless policy says otherwise (verify before widening).
  **Acceptance & tests:**
- Unit: legal transitions pass, illegal ones throw; queue sorts Critical/High first; a member cannot fetch the
  queue (403) or see internal notes; each transition writes an event + audit row; submitter fields unchanged.
- Gates as §Conventions.
  **Done when:**
- [ ] Manager queue (sorted + filtered, manager-only); full lifecycle enforced by the FSM; internal notes hidden from members; reopen gated.

## Step 10 — Incident evidence: optional encrypted photo + restricted access 🛑

**Stage:** Incidents · **Depends on:** Step 8 · **Resolves:** PDF p.12 (optional photo, store securely, restrict access), p.16 (storage permission)
**Goal (plain English):** Let a submitter optionally attach a photo (take live or upload existing). The image
is encrypted before upload and stored in the media vault; only authorized managers of the owning org can
fetch it. Photo is always skippable — a report submits fine without one.
**Why it matters:** PDF p.12/16/17. "Photo must be optional", "store photos securely and restrict access",
"existing image upload works only after gallery/storage permission", and "manager sees evidence only for
authorized departments".
**Self-contained context:**

- **Reuse the existing encrypted-media attachment pipeline** (AES-256-CBC, unique key per file,
  encrypt-before-upload to the Supabase S3 endpoint — memory `project_encrypted_media`). Do **not** invent a
  new media path. Store only the opaque `storage_key` in `incident_attachments`; the per-file key rides the
  existing encrypted envelope path, never this DB.
- Access: a fetch endpoint returns a short-lived download only to `OrgManagerGuard` callers of the incident's
  org (or the submitter for their own). Mirror the file-vault access discipline.
  **Files to touch:**
- EXTEND `incident.service.ts` — `attach(incidentId, submitterId, storageKey)`, `listAttachments(orgId/submitter, incidentId)`, `getAttachmentDownload(...)`.
- EXTEND `incident.controller.ts` — `POST /incidents/:id/attachments`, `GET /incidents/:id/attachments`.
- Mobile: reuse the existing attachment encryptor used by chat media; UI in Step 14.
  **Security stop-conditions:** 🛑 **Media + file-vault flow.** Re-read the System Architecture Documentation
  (media encryption + File Vault MFA gate) before wiring download URLs. Encrypt before upload; never store a
  plaintext image or a long-lived public URL; restrict downloads to the owning org's managers + the submitter;
  never log image bytes or keys. If the architecture requires the File Vault MFA gate for sensitive media
  downloads, honour it — do not bypass.
  **Acceptance & tests:**
- Unit/integration: a report submits with no photo (skippable); an attached photo is stored encrypted with an
  opaque key; a manager of another org cannot fetch it (403); no plaintext URL or key is logged.
- Gates as §Conventions.
  **Done when:**
- [ ] Optional photo attaches via the existing encrypted-media pipeline; access restricted to owning-org managers + submitter; nothing sensitive logged.

## Step 11 — Notifications: push + in-app + attendance reminders

**Stage:** Incidents · **Depends on:** Step 8, Step 9 · **Resolves:** PDF p.13 (push + in-app to manager), p.16 (notifications), p.17 (manager receives push)
**Goal (plain English):** When an incident is submitted, alert the org manager(s) by push and in-app; when
status changes, notify the submitter. Optionally remind CPOs of an upcoming/missed check-in. Alerts carry a
ref + severity, never the incident body.
**Why it matters:** PDF p.13/17. The manager-notification on new incident is a QA gate.
**Self-contained context:**

- Reuse the existing push infrastructure (Firebase / the opaque-push path the app already uses — do not build
  a new sender). The notification payload is **metadata only**: `ref`, `severity`, `status` — never the
  description, coordinates, or photo. Resolve manager recipients from `org_members` (manager) + the company
  account for the incident's org.
- In-app: a lightweight unread/alert surface on the dashboard (p.3 "show incident alerts only to authorised
  roles"; "do not expose sensitive incident details in general member previews").
  **Files to touch:**
- EXTEND `incident.service.ts` submit + `updateStatus` to enqueue notifications (call the existing push service).
- (Optional) attendance reminder sweep (Redis-locked) for assigned-but-not-checked-in CPOs near `start_at`.
  **Security stop-conditions:** 🛑 Push payloads are opaque/metadata-only — no incident body, no coordinates,
  no PII (consistent with the project's opaque-push rule). Verify against the architecture doc before changing
  push payload shape.
  **Acceptance & tests:**
- Unit: submit enqueues a manager notification with `{ref, severity}` only; a status change notifies the
  submitter; payload contains no description/coordinates.
- Gates as §Conventions.
  **Done when:**
- [ ] Managers get push + in-app on new incident; submitter notified on status change; payloads metadata-only.

---

## Step 12 — Channels Hub v2: channel types + read-only/restricted + incident-channel gating

**Stage:** Surfaces · **Depends on:** Step 1 · **Resolves:** PDF p.4 (board/department/incident channels, restricted badges)
**Goal (plain English):** Extend the existing department-channels so the hub can group channels as Board /
Department / Incident, mark read-only (announcement) and private/restricted channels with badges, and hide
incident-management channels from normal members.
**Why it matters:** PDF p.4. "Show restricted channel badges"; "normal members must not see incident
management channels unless authorised"; "department managers can access incident queue channel".
**Self-contained context:**

- Add an additive `channel_type TEXT` (`'board'|'department'|'incident'`) and `access TEXT`
  (`'standard'|'read_only'|'restricted'`) to `department_channels` (default `'department'`/`'standard'` →
  zero change to existing channels). The E2EE posting model (admin/viewer roles, intents, rekey) is unchanged.
- Visibility: `listChannels` already filters by membership; for `restricted`/`incident` channels, only seed
  membership for managers (Step 8/9 cohort), so normal CPOs simply never receive the row. Add the badge fields
  to `ChannelSummary`.
  **Files to touch:**
- NEW `supabase/migrations/<ts>_channel_types.sql` (use a `<ts>` after `20260628000001` — see Conventions §3) — `ALTER TABLE department_channels ADD COLUMN IF NOT EXISTS channel_type/access` (+ defaults).
- EXTEND `department.service.ts` `ChannelSummary` + `listChannels`/`listChannelsForOps` to surface type/access.
- EXTEND `src/screens/messenger/DepartmentChannelsScreen.tsx` — render Board/Department/Incident sections + read-only/restricted badges.
  **Security stop-conditions:** 🛑 Do not change the group-key/rekey path. Restricted-channel enforcement is by
  _membership seeding_ (server never adds a normal member), not by a client-side hide. No crypto change.
  **Acceptance & tests:**
- Unit: a normal CPO's `listChannels` excludes incident/restricted channels; a manager's includes them;
  read-only channels carry the badge flag. Regression: `department.service.spec.ts` passes.
- Gates as §Conventions.
  **Done when:**
- [ ] Channels grouped by type with read-only/restricted badges; incident channels invisible to normal members; crypto untouched.

## Step 13 — Dashboard v2: quick actions + today's status + role-gated alerts

**Stage:** Surfaces · **Depends on:** Step 4, Step 8 · **Resolves:** PDF p.3 (dashboard)
**Goal (plain English):** Surface Attendance and Report Incident as first-level quick actions on the
department dashboard, show today's attendance status inline, show channel unread + vault counts, and show
incident alerts only to authorised roles (no sensitive details in a member preview).
**Why it matters:** PDF p.3. Attendance + incident must be first-class, not buried in chat.
**Self-contained context:**

- The org/CPO surface is the agent app (`src/navigation/AgentNavigator.tsx`, `AgentDashboardScreen.tsx`).
  Add the quick-action cards + a `myTodayShift` status chip (Step 4) + an incident-alert badge gated on
  `OrgManagerGuard`-equivalent role (manager/company) from `/auth/me`/roster.
- Keep member previews free of incident detail (p.3 developer instruction).
  **Files to touch:**
- EXTEND `src/screens/agent/AgentDashboardScreen.tsx` (or a new `DeptChatDashboardScreen`) — Attendance +
  Report Incident cards, today's status, unread/vault counts, role-gated incident alerts.
- EXTEND `src/navigation/AgentNavigator.tsx` — register the new attendance/incident routes (flag-gated).
  **Security stop-conditions:** None new; respect role gating (no incident alerts/details for normal members).
  **Acceptance & tests:** Manual: dashboard shows quick actions + today's status; incident alerts appear only
  for manager/company role; member preview shows no incident detail. Typecheck/lint gates.
  **Done when:**
- [ ] Dashboard exposes Attendance + Report Incident, today's status, and role-gated incident alerts (flag-gated).

## Step 14 — Member mobile screens (Attendance, Verify, Result, My Attendance, Report-Incident, Submitted)

**Stage:** Surfaces · **Depends on:** Step 5, Step 6, Step 8, Step 10 · **Resolves:** PDF p.5,6,7,8,11,12,13
**Goal (plain English):** Build the member-facing screens: Attendance dashboard (today's shift + Check In),
Verify Attendance (camera face confirm + location + Confirm), Attendance Result (confirmed / pending review),
My Attendance (weekly history with statuses), Report Incident step 1 (category + severity), step 2 (details +
location + optional photo), and Incident Submitted (ref + status).
**Why it matters:** These are the actual V2 member experiences in the PDF mock-ups.
**Self-contained context:**

- Follow the master design system (memory `design_system_master` — obsidian/cobalt, `BravoFont`, `Colors`,
  `scaleTextStyles`) and reuse the `_shared` primitives (`NavHeader`, `SectionLabel`, `CTAButton`, `BRAND`)
  already used by `AttendanceScreen.tsx`.
- Camera: request permission only for the face step; location only during check-in/incident (PDF p.16; no
  background tracking). Show the privacy wording before first face use (p.6) and the "only capture where safe
  and lawful" warning on the incident photo (p.12).
- Offline/error paths (per `CLAUDE.md` UI verification): denied camera/location, cancelled flow, offline submit
  → Pending Review messaging, never a false "Absent".
  **Files to touch:**
- REPLACE/EXTEND `src/screens/agent/AttendanceScreen.tsx` → today's shift + Check In entry.
- NEW `VerifyAttendanceScreen.tsx`, `AttendanceResultScreen.tsx`, `MyAttendanceScreen.tsx`,
  `ReportIncidentCategoryScreen.tsx`, `ReportIncidentDetailsScreen.tsx`, `IncidentSubmittedScreen.tsx`
  under `src/screens/agent/` (or a new `src/screens/deptchat/`).
- EXTEND `src/navigation/AgentNavigator.tsx` + `src/navigation/types.ts` (flag-gated routes).
  **Security stop-conditions:** 🛑 Face frames never leave the device beyond the presence check; only the result

* metadata are sent (Step 5). Incident photo uses the encrypted pipeline (Step 10). No background location.
  **Acceptance & tests:** Manual golden + error paths (denied permission, offline, cancel). Verify adjacent
  screens (existing `AttendanceScreen` consumers, `DepartmentChannelsScreen`) don't regress. Typecheck/lint.
  If a screen needs a device for camera, say so explicitly rather than claiming success.
  **Done when:**

- [ ] All member screens match the mock-ups, enforce permission-only-on-action, and handle the error paths.

## Step 15 — Manager/Admin screens (Admin Attendance, Pending Review, Export, Incident Queue, Incident Detail)

**Stage:** Surfaces · **Depends on:** Step 7, Step 9 · **Resolves:** PDF p.9,10,14,15
**Goal (plain English):** Build the manager/admin screens: Admin Attendance (Present/Late/Absent counts +
Pending Review queue with approve/reject), Export Report (date/department/shift/format → generate), Incident
Queue (severity-sorted, filterable), and Incident Detail (full record, photo/location review, internal notes,
status workflow, Update Status).
**Why it matters:** These are the provider-management experiences (PDF p.9,10,14,15).
**Self-contained context:**

- Two homes: the **mobile** manager surface (org account / manager logs into the agent app — extend
  `OrgRosterScreen.tsx` neighbours) and the **ops-console** for Bravo-admin oversight + export
  (`apps/ops-console/src/app/...`, `AdminGuard`). Decide per screen; the PDF mock-ups are mobile-first, so
  ship the manager screens on mobile and the heavier export/oversight on ops-console.
- Reuse the design system + existing roster/list patterns. Approve/reject/export/status actions hit the Step
  6/7/9 endpoints (all audited).
  **Files to touch:**
- NEW mobile `AdminAttendanceScreen.tsx`, `AttendanceExportScreen.tsx`, `IncidentQueueScreen.tsx`,
  `IncidentDetailScreen.tsx` (under `src/screens/agent/` or `src/screens/deptchat/`); register in `AgentNavigator`.
- ops-console: Admin Attendance + Export pages + incident oversight (AdminGuard), `apps/ops-console/src/lib/api.ts`.
  **Security stop-conditions:** 🛑 Manager screens are gated by the org-manager role; ops-console oversight by
  `AdminGuard` (separate tier — never conflate). Export excludes biometrics; internal notes never render on any
  member view.
  **Acceptance & tests:** Manual: manager can clear the pending queue (approve/reject with note), export
  (PDF/CSV), walk an incident through the lifecycle; a normal member cannot reach any of these. Verify audit rows
  written. Typecheck/lint.
  **Done when:**
- [ ] Admin attendance + export + incident queue + detail work end-to-end for managers; members are blocked; actions audited.

---

## Step 16 — Permissions matrix enforcement + audit logging + compliance-wording sweep

**Stage:** Cross-cutting · **Depends on:** Steps 4–11 · **Resolves:** PDF p.16 (roles/permissions), p.9/13/15 (audit), p.17 (compliance wording)
**Goal (plain English):** Do a final pass that proves every sensitive route enforces the right role, every
sensitive action writes an audit row, and the UI/strings use the compliant vocabulary ("Attendance
Verification" / "Incident Report", never "tracking"/"surveillance").
**Why it matters:** PDF p.16/17. The permission matrix + audit + wording are explicit acceptance items and a
compliance requirement.
**Self-contained context:**

- Matrix to assert (one test per cell): Member → own attendance + submit/own incidents only; Department
  Manager → dept attendance review + incident queue/status; Company Admin → all org departments + export +
  shifts + roster; Bravo Admin (ops) → configurable oversight, audited. Members blocked from queue + others'
  attendance (p.17 QA gates).
- Audit coverage: review approve/reject, day-status set, export, incident status change, assignment, reopen.
- Wording sweep across new screens/strings + push copy.
  **Files to touch:**
- NEW `apps/auth-service/src/**/permissions.spec.ts` (matrix tests) + audit assertions in service specs.
- String/copy edits across new mobile/ops screens.
  **Security stop-conditions:** 🛑 No "skip in dev" branches on any guard; no PII in audit/logs. Re-confirm the
  biometric (Step 5) and media (Step 10) stop-conditions are closed.
  **Acceptance & tests:** The full permission matrix passes; audit rows asserted for every sensitive action;
  grep for banned wording returns nothing in new code. Gates as §Conventions.
  **Done when:**
- [ ] Every matrix cell is enforced + tested; every sensitive action is audited; compliant wording throughout.

## Step 17 — QA retest checklist, acceptance gates, staged rollout

**Stage:** Operate · **Depends on:** all · **Resolves:** PDF p.17 (MVP must-have + QA retest checklist)
**Goal (plain English):** Run the PDF's QA checklist end-to-end, confirm every MVP must-have, then flip the
`DEPT_CHAT_V2` flag on for a pilot org, watch, and widen.
**Why it matters:** This is the go/no-go gate; the flag flip is the only behaviour change customers see.
**Self-contained context (PDF p.17 QA retest — each is a test or a manual check):**

- Check-in blocked when no shift assigned. · Location denied → Pending Review, not Absent. · Face failure →
  Pending Review with admin-visible reason. · Normal member can't view others' attendance. · Normal member
  can't access the manager incident queue. · Incident photo skippable, report still submits. · Existing-image
  upload only after gallery/storage permission. · Manager gets push + in-app on new incident. · Export logs
  include admin, date, filters, format.
- MVP must-have (p.17): dashboard has Attendance + Report Incident; face+location check-in/out; full status
  set; admin review + PDF/CSV export; any member submits incidents; routes to correct manager at `submitted`;
  manager walks the full lifecycle; all sensitive actions role-controlled + audited.
  **Files to touch:** test files + the rollout flag flip (server `DEPT_CHAT_V2_ENABLED` / bootstrap field).
  **Backend how-to / rollout:** Flip the flag for one pilot org first (server-driven field), smoke the 3-device
  matrix (member check-in, manager review, incident submit→resolve), then widen. Keep the legacy path intact —
  rollback = flag off.
  **Security stop-conditions:** 🛑 Final re-read of the System Architecture Documentation for the three
  sensitive flows (biometric result-only, encrypted incident media, opaque/metadata-only push) before enabling
  for real users.
  **Acceptance & tests:** Every QA-retest item passes (automated where possible, manual otherwise); MVP
  checklist complete; pilot smoke green. Full gates: `apps/auth-service && npm test`, `npm test` (mobile),
  ops-console typecheck, lint.
  **Done when:**
- [ ] All QA-retest items + MVP must-haves verified; flag enabled for the pilot org; rollback (flag off) proven.

## Step 18 — Manager channel management (create / configure / membership) + CPO auto-join

**Stage:** Post-v1 additions (scope-gap closure) · **Depends on:** Step 12 (channel typing), the pre-v1 `addMember`/`removeMember`/rekey-intent seam (§0.3) · **Resolves:** PDF p.4/16 — _"department managers create and manage channels"_, _"set channels read-only / restricted"_ — the create/configure seam **Step 12 left unbuilt** (Step 12 shipped the `channel_type`/`access` columns + badges + read-side visibility, but nothing ever **writes** a non-default type/access or **creates** a channel, so Board/Incident/READ-ONLY/RESTRICTED are inert in practice).

**Goal (plain English):** Give an org's **Department Manager / Company Admin** a surface to (1) create a department channel, (2) configure it — name, department label, type (Board/Department/Incident) and access (standard/read-only/restricted), (3) edit membership (add/remove CPOs & managers, set admin/viewer), and (4) archive it. Make `restricted`/`incident` channels manager-only by _seeding membership_ (the existing rule), and auto-add a newly-activated CPO to the org's standard/read-only channels as a read-only viewer. **No new crypto:** a created channel's Signal group is still bootstrapped lazily by an admin device (existing `makeNewGroup → registerGroup`), and every membership change rides the existing rekey-intent drain.

**Why it matters:** Today channels exist only as the **3 hardcoded defaults** `seedOrgWorkspace` plants on org activation (Operations/Intel/CPO Roster), all `department`/`standard`, seeded to every member. A manager cannot create a channel, mark one announcement-only, stand up an incident-managers channel, or add a CPO hired after activation. The PDF's "managers manage channels" + the Step-12 typing/visibility only become real once something can _set_ type/access and _seed_ membership accordingly.

**Self-contained context:**

- **Trust tier — use `OrgManagerGuard`, not the channel `admin`/`viewer` role.** `/department/*` is gated `JwtAuthGuard + TierGuard + @RequireTier('pro')`; the existing `addMember`/`removeMember` authorize at the _service_ layer via `memberRole(...) === 'admin'` (channel-scoped). **Creating** a channel is an _org-level_ action with no channel to be admin of yet, so the create/configure/archive/manage-list routes must additionally pass `OrgManagerGuard` (company account = Path 1, or active `member_role='manager'` = Path 2) and `assertOrgScope(manager, channel.org_id)` on every `:id`. Never conflate with `AdminGuard` (HQ/ops oversight, which already has its own read-only `listChannelsForOps`).
- **✅ Entitlement (DECIDED 2026-06-23):** the department workspace is **a service-provider-org feature, not an individual-Pro perk**. **Drop `@RequireTier('pro')` + the mobile `isProUser` paywall** and entitle by **org membership**: access is granted to the **service-provider company account** (`agents.type='company'`) **OR** an **active `org_members` row** (CPO or manager). A new `DeptChatAccessGuard` (re-reads the DB, never a JWT claim — modeled on `OrgManagerGuard`) replaces `TierGuard` on `DepartmentController`. This is _stricter_ than the old Lite-blocking gate (you must belong to an org), so audit gap **BE-6.3 stays closed** — non-org callers are rejected, and a non-org user has no `department_channels` rows anyway. Managers manage; CPOs/staff are added to specific channels and receive updates as read-only viewers.
- **Module wiring:** `DepartmentModule` currently `imports: [AuthModule]`. Add `OrgModule` (it **exports `OrgManagerGuard`** — `attendance.module.ts` does exactly this) and make `OrgAuditService` injectable (export it from `OrgModule` if not already).
- **Membership seeding by access (single helper, reused by `seedOrgWorkspace`):**
  - `standard` / `read_only` → seed managers as `admin`, every active CPO as `viewer` (read-only). (read_only = same roles; the **badge** signals announcement-only.)
  - `restricted` / `incident` → seed managers as `admin` **only**; CPOs are _not_ added → `listChannels`' membership JOIN never returns the row (Step-12 rule).
  - Extract `seedChannelMembers(channelId, orgId, access)` from `seedOrgWorkspace` and call it from both.
- **Tightening access on an existing channel is a _membership_ change, not just a column flip.** `standard/read_only → restricted/incident` must **remove every non-manager member through the existing `removeMember` path** so a `remove`+rekey intent is enqueued and the admin device rotates the master key away from them (else the de-scoped CPO keeps the old key — the exact seam §0.3/Step 12 warns about). `read_only ↔ standard` and name/department edits are metadata-only (no rekey).
- **New channel → no rekey yet.** `createChannel` writes the metadata + membership rows with `group_conversation_id = NULL`. The creator (a manager, seeded `admin`) opens it → the existing `openChannel` bootstraps the Signal group (`createGroupChat → registerGroup`) over the _current_ roster. `drainMembershipIntents` already **skips** intents for not-yet-provisioned groups, so later adds apply once the group exists. Zero change to the crypto/rekey code.
- **CPO auto-join already exists — patch, don't rebuild.** `OrgCpoService.syncMemberToOrgChannels` already adds a CPO to the org's channels on `createManagedCpo` and on `setMemberStatus → 'active'` (and removes on suspend/remove), enqueuing the add/remove rekey intents. **But it adds to _every_ non-archived channel** (`SELECT id FROM department_channels WHERE org_id=$1 AND archived_at IS NULL`) — once Step 18 lets managers create `restricted`/`incident` channels, that would **leak a normal CPO into a managers-only channel**. Fix: filter the `add` path to `access IN ('standard','read_only')`.

**Files to touch:**

- EXTEND `apps/auth-service/src/department/department.service.ts` — `createChannel(manager, dto)`, `configureChannel(manager, channelId, dto)`, `archiveChannel(manager, channelId)`, `listOrgChannels(manager)` (org-wide, not membership-filtered), `onCpoActivated(orgId, cpoUserId)`; private `seedChannelMembers(...)`, `assertManagesChannel(manager, channelId)` (loads `org_id`, `assertOrgScope`). Reuse existing `addMember`/`removeMember`.
- EXTEND `apps/auth-service/src/department/department.controller.ts` — `@UseGuards(OrgManagerGuard)` method-level on: `POST /department/channels`, `PATCH /department/channels/:id`, `POST /department/channels/:id/archive`, `GET /department/manage/channels`.
- NEW `apps/auth-service/src/department/dto/channel.dto.ts` — `CreateChannelDto` / `ConfigureChannelDto` (validate `channel_type ∈ board|department|incident`, `access ∈ standard|read_only|restricted`, name length).
- EXTEND `apps/auth-service/src/department/department.module.ts` — `imports: [AuthModule, OrgModule]`; ensure `OrgAuditService` injectable.
- EXTEND `apps/auth-service/src/org/org-cpo.service.ts` — `syncMemberToOrgChannels` already wires CPOs in/out on create/activate/suspend; **add an `access IN ('standard','read_only')` filter to its `add` query** so restricted/incident channels never auto-seed a normal CPO.
- EXTEND `src/services/api.ts` `departmentApi` — `createChannel`, `configureChannel`, `archiveChannel`, `listManagedChannels`.
- NEW mobile `src/screens/deptchat/ManageChannelsScreen.tsx` (+ `ChannelEditorScreen.tsx` create/configure form and `ChannelMembersScreen.tsx` membership editor) — obsidian design system, gated on manager/company role from `/auth/me`/roster and `DEPT_CHAT_V2`.
- EXTEND `src/navigation/AgentNavigator.tsx` + `src/navigation/types.ts` — register the routes (flag-gated); add a "Manage channels" entry for managers and **fix the empty-state copy** in `DepartmentChannelsScreen.tsx` (currently _"Your org admin creates department channels from the Ops console"_ — wrong tier; point managers to the in-app screen).

**Backend how-to:** `createChannel` → `OrgManagerGuard` resolves `manager.org_user_id`; INSERT `department_channels (org_id, name, department, channel_type, access, created_by)` with `created_by = manager.user_id`; `seedChannelMembers(ch.id, org_user_id, access)`; `OrgAuditService.log(org, actor, 'channel.create', {targetKind:'channel', targetId: ch.id, metadata:{channel_type, access}})`. `configureChannel` → `assertManagesChannel`; if `access` tightens to restricted/incident, `for (cpo of nonManagerMembers) removeMember(orgAccount, channelId, cpo)`; UPDATE metadata; audit `'channel.configure'`. `archiveChannel` → `assertManagesChannel`; set `archived_at`; audit. All run with `OrgManagerGuard` + `assertOrgScope`.

**Frontend how-to:** Manager list → create (name/department/type/access) → on save, optionally open the channel to bootstrap its group immediately (reuse `openChannel`). Members editor calls the existing `addMember`/`removeMember`; the hub's `drainMembershipIntents()` (already on focus) does the rekey. CPO-side is unchanged — they keep getting the read-only viewer bar.

**Security stop-conditions:** 🛑 **E2EE / rekey.** No key material is created or moved server-side; the group is bootstrapped on-device (existing path) and every membership delta rides the existing `channel_membership_intents` → `planAddAndRekey`/`planRemoveAndRekey` drain. Restricted/incident visibility is by **membership seeding**, never a client hide. Tightening access **must** rekey de-scoped CPOs out via `removeMember` (never a bare column flip). 🛑 **Auth tiers:** create/configure/archive gated by `OrgManagerGuard` (re-reads DB, never a JWT claim) + the resolved workspace entitlement + flag; never conflate with `AdminGuard`. No "skip in dev" on any guard. Audit every action via `OrgAuditService` (coarse metadata only — `channel_type`/`access`/`role`/counts, **no** names/descriptions/coordinates).

**Acceptance & tests:**

- Unit (`department.service.spec.ts` + a new `channel-management.spec.ts`): create seeds creator as `admin`; standard/read_only seeds CPOs `viewer`; restricted/incident excludes CPOs; configure→restricted enqueues a `remove` intent per CPO; cross-org configure/archive → `assertOrgScope` 403; a CPO/viewer hitting create → `OrgManagerGuard` 403; `onCpoActivated` adds the CPO to standard/read_only channels only; an audit row per action; **no** crypto module imported/changed.
- Regression: `deptchat-permissions.spec.ts`, `department.service.spec.ts`, and `npm run test:crypto` all green (crypto path untouched).
- Manual (device): manager creates a `read_only` Board → CPO sees it with the READ-ONLY badge + viewer bar, can't post; manager creates an `incident` restricted channel → CPO never sees it; manager adds a new CPO → after the admin device drains intents the CPO can read; manager tightens a channel to restricted → CPO loses it after the rekey.
- Gates as §Conventions.

**Done when:**

- [ ] Manager (company/manager tier) can create, configure (name/department/type/access), edit membership, and archive channels — behind `OrgManagerGuard` + the resolved workspace entitlement + `DEPT_CHAT_V2`.
- [ ] `channel_type`/`access` are actually _written_, so Step-12 Board/Incident grouping + READ-ONLY/RESTRICTED badges + manager-only visibility become live (no longer inert).
- [ ] Restricted/incident channels seed managers-only; tightening access rekeys CPOs out via the existing intent path; **`npm run test:crypto` unchanged**.
- [ ] A newly-activated CPO auto-joins the org's standard/read-only channels as a read-only viewer.
- [ ] Every create/configure/archive/membership action writes one `org_audit_log` row (coarse metadata); all gates green.

---

## Step 19 — Dedicated "Departmental" surface (5-tab shell, both parties) — 100% PDF realization

**Stage:** Dedicated surface · **Depends on:** Steps 12–18 (every feature screen + the backend already exist) · **Resolves:** PDF p.2 (Product Map + the fixed **Home · Channels · Attend · Incident · Vault** bottom nav printed on _every_ mock-up), p.3 (Main Dashboard v2), and the **consolidation** of p.4–15 into the PDF's intended single module. Closes the two open gaps in §Build-status: _"member screens live in `AgentNavigator` … CpoNavigator wiring is open"_ and the scattered entry points.

**Goal (plain English):** Every Dept-Chat v2 screen is built — but they are _scattered_: a member's Attendance/Report-Incident are nav rows on the **Agent** dashboard; Channels sit three taps deep under **Comms → Groups → Departmental Chat**; and the **managed CPO** (`CpoNavigator`, the 4-tab On-Duty/Mission/Comms/Me shell) cannot reach Attendance or Incident **at all**. The PDF shows ONE dedicated module with a fixed **5-tab bottom nav**. This step builds that single **"Departmental"** surface and hangs it off **one entry point visible to both parties** — the managed **CPO/member** and the **service-provider company/manager** — with each tab rendering the **role-appropriate screen that already exists**. The only net-new code is the **shell + the Home dashboard (p.3) + Vault wiring + the two entry points**; the feature screens (p.4–15) are reused as-is.

**Why it matters:** Without this, the PDF is ~85% built but **0% reachable as designed** — the mock-ups' whole information architecture (a self-contained department app with its own footer) doesn't exist, and one of the two parties (the managed CPO) has no path to the features at all. "100% of the PDF" = the 5-tab module, for both parties, not just the individual screens existing in a drawer.

> **⭐ THE ENTRY POINT (non-negotiable) — there is exactly ONE new option, labelled "Departmental", and it is the SINGLE entry point for BOTH parties.**
>
> - **Managed CPO / member** → a **`Departmental` bottom tab** in `CpoNavigator` (the CPO's _only_ path to attendance/incident).
> - **Service-provider company / Department Manager** → a **`Departmental` entry** in `AgentNavigator` (replacing the scattered Attendance/Incident/Admin rows).
> - **Both open the SAME `DepartmentalNavigator`** (Home · Channels · Attend · Incident · Vault). Only the per-tab _root screen_ differs by role (member vs manager) — authorization is still decided server-side. **No Dept-Chat feature is reachable from anywhere else** once this ships; the old scattered/buried entry points are removed.

### 19.0 PDF → screen parity matrix (what the 17 pages map to)

| PDF page                          | Screen / surface                                                                                                            | Today                                                              | Step-19 action                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| p.1 Cover / p.2 Product Map       | The 5-tab **Departmental** shell                                                                                            | ❌ none — screens scattered                                        | **NEW** `DepartmentalNavigator` (bottom tabs)                            |
| p.3 Main Dashboard v2             | **Departmental Home** (welcome, secure/device-trust, latest announcement, quick actions, today's status, role-gated alerts) | ⚠️ quick-actions exist only on `AgentDashboardScreen`              | **NEW** `DepartmentalHomeScreen` (member + manager variants)             |
| p.4 Channels Hub v2               | `DepartmentChannelsScreen` (+ `ManageChannels`/`ChannelEditor`/`ChannelMembers`)                                            | ✅ exists (Step 12/18), reached via Comms→Groups                   | **REUSE** as the **Channels** tab                                        |
| p.5 Attendance Dashboard          | `agent/AttendanceScreen` (today's shift + Check In)                                                                         | ✅ exists                                                          | **REUSE** as member **Attend** tab root                                  |
| p.6 Face + Location Verify        | `deptchat/VerifyAttendanceScreen`                                                                                           | ✅ exists                                                          | **REUSE** (pushed from Attend)                                           |
| p.7 Attendance Result             | `deptchat/AttendanceResultScreen`                                                                                           | ✅ exists                                                          | **REUSE**                                                                |
| p.8 My Attendance                 | `deptchat/MyAttendanceScreen`                                                                                               | ✅ exists                                                          | **REUSE**                                                                |
| p.9 Admin Attendance View         | `deptchat/AdminAttendanceScreen`                                                                                            | ✅ exists                                                          | **REUSE** as manager **Attend** tab root                                 |
| p.10 Attendance Export            | `AdminAttendance` EXPORT button → server CSV + ops-console `dept-attendance/page.tsx` (client PDF)                          | ⚠️ no standalone _mobile_ Export screen                            | **OPTIONAL NEW** mobile `AttendanceExportScreen` (else keep ops-console) |
| p.11 Report Incident · Category   | `deptchat/ReportIncidentCategoryScreen`                                                                                     | ✅ exists                                                          | **REUSE** as member **Incident** tab root                                |
| p.12 Report Incident · Details    | `deptchat/ReportIncidentDetailsScreen`                                                                                      | ✅ exists                                                          | **REUSE**                                                                |
| p.13 Incident Submitted           | `deptchat/IncidentSubmittedScreen`                                                                                          | ✅ exists                                                          | **REUSE** (fix terminal nav — see 19.4)                                  |
| p.14 Manager Incident Queue       | `deptchat/IncidentQueueScreen`                                                                                              | ✅ exists                                                          | **REUSE** as manager **Incident** tab root                               |
| p.15 Incident Detail & Workflow   | `deptchat/IncidentDetailScreen`                                                                                             | ✅ exists                                                          | **REUSE**                                                                |
| (p.2 "Secure Vault")              | **Vault** tab — files/policies/incident exports                                                                             | ⚠️ messenger `VaultScreen`/`FilesScreen` exist but not dept-scoped | **NEW wiring** — Vault tab → existing vault (honour File-Vault MFA)      |
| p.16 Permissions/Roles/Data       | backend matrix + guards                                                                                                     | ✅ Step 16                                                         | (no change; the shell only _renders_ what guards allow)                  |
| p.17 Acceptance / QA / Compliance | —                                                                                                                           | ✅ Step 17                                                         | extend QA to the new shell (19.6)                                        |

**Bottom line:** 13 of the 15 feature pages already exist; Step 19 adds **1 shell + 1 Home + Vault wiring + 2 entry points** and re-points the existing screens at the shell.

### 19.1 The shell — `DepartmentalNavigator` (NEW)

- NEW `src/navigation/DepartmentalNavigator.tsx` — a `createBottomTabNavigator` with exactly the PDF's five tabs, obsidian footer matching `MainNavigator`'s `CustomTabBar` tokens (`#07090D` / `#5B8DEF`):
  1. **Home** → `DepartmentalHomeScreen` (19.2)
  2. **Channels** → a thin stack hosting `DepartmentChannelsScreen` → `DepartmentChat` → `ManageChannels`/`ChannelEditor`/`ChannelMembers` (reuse; they currently live in `MessengerNavigator` — register the same components here so the tab is self-contained).
  3. **Attend** → a stack whose **root is role-branched**: member → `agent/AttendanceScreen` → `VerifyAttendance` → `AttendanceResult`, plus `MyAttendance`; manager/company → `AdminAttendanceScreen` (+ optional `AttendanceExport`).
  4. **Incident** → a stack whose **root is role-branched**: member → `ReportIncidentCategory` → `ReportIncidentDetails` → `IncidentSubmitted`, plus a "my reports" list; manager/company → `IncidentQueue` → `IncidentDetail`.
  5. **Vault** → the existing `VaultScreen` (File-Vault MFA gate preserved — see 🛑).
- **Role resolution (single source):** read the resolved role once from `useAuthStore` — `user.account_kind` (`'cpo'` member / `'agency'` company) + `user.membership_status==='active'` + `member_role` (`'manager'`), mirroring `DepartmentChannelsScreen`'s `entitled`/`isManager` logic (lines 31–37). Branch each tab's root component on `isManager`. **Never** branch on a client flag for _authorization_ — the server guards still decide; the branch only picks which already-guarded screen to show first.
- Each tab is its own native-stack so flows push **within** the tab (matching the PDF, where the footer stays put through Verify/Result/Submitted).

### 19.2 Departmental Home — `DepartmentalHomeScreen` (NEW, p.3)

The only genuinely new screen. Two variants from the same component, branched on `isManager`:

- **Member (p.3):** "Welcome, {name}", org line ("{org} Department"), **Secure connection · Device trusted** indicator (reuse the existing trust/secure-session cue), **Latest announcement** (most-recent message from a `board`/`read_only` channel), **quick actions** → Attendance + Report Incident (deep-link into the Attend/Incident tabs), **today's attendance status** chip (`attendanceApi.myTodayShift()` → Not checked in / Present / Late / Pending), **unread channel activity** + **Vault** counts. **No incident details in the member preview** (p.3 dev instruction).
- **Manager/Company (adds):** role-gated alert tiles — **Pending Review** count (`attendanceApi.orgSummary().pendingReview`) and **Open incidents** (`incidentApi.queue()` filtered open), each deep-linking to the manager root of the relevant tab. These already power the `AgentDashboardScreen` badges (lines 355–373) — lift that effect into the Home screen.

### 19.3 The entry point — one "Departmental" option for **both parties**

- **Managed CPO (`CpoNavigator`):** add **Departmental** as a tab (or a prominent card on On-Duty Home) that mounts `DepartmentalNavigator`. Recommended: a 5th bottom tab `Dept` (icon `office-building` / `shield-account`) so the CPO's shell becomes On Duty · Mission · **Dept** · Comms · Me — the CPO's only path to attendance/incident. Gate the tab on `DEPT_CHAT_V2` + the workspace entitlement (active org member).
- **Service provider (`AgentNavigator` / `AgentDashboardScreen`):** replace the scattered Attendance/Report-Incident/Admin-Attendance/Incident-Queue nav rows with **one "Departmental" row** → `navigation.navigate('Departmental')` (register `DepartmentalNavigator` as a screen in `AgentNavigator`). The company/manager lands on the same shell, role-branched to the manager roots.
- **Result:** both parties tap **one** clearly-labelled "Departmental" option and get the PDF's module; the difference is purely which screen each tab opens on (member vs manager), decided by 19.1's role resolution.

### 19.4 Reused-screen touch-ups (small, contained)

- **Terminal nav targets:** `IncidentSubmittedScreen` hard-navigates to `'AgentDashboard'` and `AttendanceResultScreen` to `'Attendance'` (both `AgentStackParamList` names). Inside the Departmental tab-stacks, make these resolve by **either** (a) naming the Incident/Attend stack roots so those names exist, **or** (b) switching the two "Done" buttons to `navigation.popToTop()` (tab-stack root = the correct home for both parties). Prefer (b) for clarity, but verify it does not regress the Agent stack (whose root is `AgentTypeSelect`) — if it would, use (a) and keep the Agent path on the existing hard target.
- **Channels empty-state copy** already corrected in Step 18; ensure the **Manage** affordance shows for managers in the Channels tab.
- **No screen redesigns** — every reused screen keeps its obsidian layout and its own guards.

### 19.5 Files to touch

- NEW `src/navigation/DepartmentalNavigator.tsx` (the 5-tab shell + per-tab stacks).
- NEW `src/screens/deptchat/DepartmentalHomeScreen.tsx` (p.3, member + manager variants).
- OPTIONAL NEW `src/screens/deptchat/AttendanceExportScreen.tsx` (p.10 mobile; else keep ops-console export).
- EXTEND `src/navigation/CpoNavigator.tsx` — add the **Dept** tab mounting `DepartmentalNavigator` (flag + entitlement gated).
  **As-built fix (2026-07-02):** the CpoDept tab had shipped WITHOUT the `DEPT_CHAT_V2` gate (the agent
  row and On-Duty card were gated, the tab was not) — now conditionally rendered on the flag; the
  `cpoCapability` source-scan test still passes (the regex matches the conditional `<Tab.Screen>`).
- EXTEND `src/navigation/AgentNavigator.tsx` — register `Departmental` + collapse the scattered rows into one "Departmental" entry on `AgentDashboardScreen`.
- EXTEND `src/navigation/types.ts` — `DepartmentalTabParamList` + per-tab stack param lists (reuse existing route param shapes from `AgentStackParamList`).
- MINOR `deptchat/IncidentSubmittedScreen.tsx` + `deptchat/AttendanceResultScreen.tsx` — terminal-nav fix (19.4).
- (No backend changes — Steps 4–18 already provide every endpoint, guard, and audit row.)

### 19.6 Security stop-conditions 🛑

- **Authorization stays server-side.** The role-branch in 19.1 only chooses _which already-guarded screen_ to show first. Every attendance/incident/channel/export/vault call still hits its existing guard (`JwtAuthGuard` / `OrgManagerGuard` / `AdminGuard` / `DeptChatAccessGuard`). **No "skip in dev", no client-trust authorization.**
- **Vault tab = File-Vault MFA preserved.** The Vault tab must route through the existing `VaultLock`/MFA gate before any download URL is issued (`CLAUDE.md` File-Vault rule). Do **not** add a dept-scoped bypass.
- **No crypto / channel-key change.** Channels in the new tab reuse `DepartmentChannelsScreen`'s existing group-bootstrap + rekey-intent drain verbatim.
- **Biometric + location + media unchanged** — Verify is still result-only (Step 5); incident photo still rides the encrypted pipeline (Step 10); location only during the action (no background tracking, p.16).
- **No PII in any new log/audit line** (the static log-audit test still applies to the new Home/shell).

### 19.7 Verification & test plan — full-proof (the step is NOT done until **every** row passes)

**A · Direct tests (new behaviour):**

- Unit/RTL: `DepartmentalNavigator` renders **exactly five tabs in order** (Home · Channels · Attend · Incident · Vault).
- Unit: the role-branch picks the right tab roots — mocked `authStore` with `isManager=false` → Attend root = `AttendanceScreen`, Incident root = member Report/My-Reports; `isManager=true` → Attend root = `AdminAttendanceScreen`, Incident root = `IncidentQueueScreen`.
- Unit/snapshot: `DepartmentalHomeScreen` member variant vs manager variant (manager adds pending-review + open-incident tiles; member preview has **no** incident detail).

**B · Regression tests (must stay green — name them):** `src/navigation/__tests__/cpoCapability.test.ts`; the `app` Jest project (`npm test`); manual smoke that the **existing** Comms→Groups→Departmental-Chat path and `AgentNavigator` rows still work during/after migration; CpoNavigator's other tabs (On Duty/Mission/Comms/Me) unaffected.

**C · Edge / negative tests:** terminal "Done" on `IncidentSubmitted` and `AttendanceResult` returns to the **correct tab root for BOTH a CPO and an agency** (the 19.4 fix); Home quick-action deep-links land on the right tab; hardware-back inside a tab pops **within** the tab, never out of the shell; offline + denied camera/location inside Attend → Pending-Review messaging, never a false "Absent".

**D · Security / isolation tests:** member's Attend/Incident tabs **never** render a manager root (assert the route isn't offered with `isManager=false`); **Vault tab triggers the File-Vault MFA gate before any download URL**; the role-branch makes **no authorization decision** client-side — every call still hits its server guard.

**E · Manual device proof (golden + error path):** on a real device, **both parties** — CPO opens the `Departmental` tab → member Home; provider opens the `Departmental` entry → manager Home; all 5 tabs present; footer persists through Verify→Result→Submitted; capture screenshots/log.

**F · Gates (CLAUDE.md change-safety — targeted first, broad second):** mobile `npm run typecheck` ≤ baseline **49** · `cd apps/ops-console && npm run typecheck` · `npm run lint` · `npm test`. No backend suite expected (no backend edits) — if any backend file is touched, also `cd apps/auth-service && npm test`. Never commit on a red gate; no `--no-verify`.

**G · Sign-off:** paste the green test output + the both-parties device screenshots into the PR before checking any box below.

### 19.8 Done when

- [x] A single **`DepartmentalNavigator`** (`src/navigation/DepartmentalNavigator.tsx`) renders the PDF's **Home · Channels · Attend · Incident · Vault** tabs in order, obsidian footer. _(Source-scan test `src/navigation/__tests__/departmentalNavigator.test.ts` locks the 5-tab order.)_
- [x] **Both parties** reach it from **one** "Departmental" option — provider: a single `Departmental` row on `AgentDashboardScreen` (the 4 scattered rows collapsed); CPO: a prominent **"Department" card** on the On-Duty home (the runbook-sanctioned alternative to a 5th tab — a 5th `<Tab.Screen>` would break the `cpoCapability.test.ts` "exactly four guard tabs" lockdown). Pushed full-screen via a thin native-stack wrap of `CpoNavigator` (no nested-tab double footer). Each tab's root is role-branched on `useIsManager()`.
- [x] **Departmental Home (p.3)** exists (`src/screens/deptchat/DepartmentalHomeScreen.tsx`) with member + manager variants (quick actions, today's status, role-gated Pending-Review + Open-Incidents tiles, no member-visible incident detail).
- [x] Every PDF p.4–15 screen is reachable **inside the shell** (reused verbatim, not rebuilt); the flat scattered registrations were removed from `AgentNavigator`. Vault tab reuses the messenger vault flow + honours the File-Vault MFA gate (`VaultLockScreen` unchanged; tab root named `MessengerHome` so its reset target resolves).
- [x] All gates green (mobile tsc **49 = baseline**, ops-console tsc clean, lint clean, `app` Jest project green incl. `cpoCapability` + new structural test); no guard/crypto changed (no backend edits); `npm run test:crypto` untouched. Terminal nav (`IncidentSubmitted`/`AttendanceResult` "Done") → `popToTop()`.

> **✅ Step 19 IMPLEMENTED (2026-06-25, branch `feat/dept-chat-v2`, uncommitted).** Files: NEW `src/navigation/DepartmentalNavigator.tsx`, NEW `src/screens/deptchat/DepartmentalHomeScreen.tsx`, NEW `src/navigation/__tests__/departmentalNavigator.test.ts`; EDIT `src/navigation/types.ts` (Dept\* param lists + `CpoRootStackParamList` + `Departmental` on AgentStack), `CpoNavigator.tsx` (stack-wrap + push), `AgentNavigator.tsx` (register Departmental, drop 10 flat dept routes), `AgentDashboardScreen.tsx` (collapse rows), `OnDutyHomeScreen.tsx` (CPO entry card), `IncidentSubmittedScreen.tsx` + `AttendanceResultScreen.tsx` (popToTop). Adversarially reviewed (nav-runtime / security / quality) — security clean, all nav targets verified resolvable, only an icon nit fixed. **Closes Gap G8.** Device proof (19.7-E) still pending real hardware.

---

## Gap Register — PDF intent vs wired reality (audited 2026-06-24)

> **Why this exists.** Steps 1–18 report "done" and the **backend + screens are real**, but a code audit found the v2 feature set is **largely unreachable in the running app**: a CPO can't check in (no shift exists), a company can't add a manager, a delegated manager sees no manager surface, and a member can't list their own incidents. Each row cites the file evidence. Severity: 🔴 blocks the core flow · 🟠 a party can't do a documented action · 🟡 polish/parity.
>
> **Also corrects a stale note:** the §Build-status 🔴 "dept-chat entitlement bug" is **FIXED** — `DepartmentController` is now `@UseGuards(JwtAuthGuard, DeptChatAccessGuard)` (`apps/auth-service/src/department/department.controller.ts:26`, guard at `dept-chat-access.guard.ts`), which entitles by org membership and replaced `@RequireTier('pro')`. That bullet is superseded.

| ID  | Sev | PDF / runbook expects                                                               | Wired reality (evidence)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Closes in     |
| --- | --- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| G1  | 🟠  | Company/Admin can **add a Department Manager** (PDF p.16; runbook §0.2)             | `OrgCreateCpoScreen.tsx` calls `orgApi.createCpo({…})` **without `member_role`** → always creates a `cpo`. The API + backend accept `member_role:'manager'` (`api.ts:837`, `org-cpo.service.ts:109`), but **no UI sends it**.                                                                                                                                                                                                                                                                                                                   | Step 20       |
| G2  | 🔴  | Admin **assigns shifts**; CPO checks in against today's shift (PDF p.5)             | `attendanceApi.createShift`/`assignCpos`/`listShifts` exist **only in `src/services/api.ts`** — **no screen** (mobile or ops-console) calls them. So `myTodayShift` is always null → check-in shows "No active shift assigned" and is blocked **for everyone**. The entire attendance flow is end-to-end **unreachable**.                                                                                                                                                                                                                       | Step 21       |
| G3  | 🟠  | **Department Manager** reviews attendance, works the incident queue (PDF p.9,14,15) | A managed manager gets `agents.type='cpo'` (`org-cpo.service.ts:154` inserts type `'cpo'` for **all** members) and `account_kind='agency'` (`account-kind.ts:72,77`). But the manager surfaces on `AgentDashboardScreen` are gated `DEPT_CHAT_V2 && isOrg` where `isOrg = me.agent.type==='company'` (`AgentDashboardScreen.tsx:451,476`) → **hidden for a delegated manager**. They land in the agency shell but see the CPO layout. (Channel-manage _does_ work — `DepartmentChannelsScreen` keys `isManager` off `account_kind==='agency'`.) | Step 22       |
| G4  | 🟠  | Member can **view own submitted incidents** (PDF p.16)                              | `incidentApi.mine` is defined but **no screen references it** (grep: 0 hits in `src/screens`). The member flow ends at `IncidentSubmitted` with a "View incident" button but there is **no list**.                                                                                                                                                                                                                                                                                                                                              | Step 23       |
| G5  | 🟡  | Statuses include **leave / sick leave / off-duty**; admin sets them (PDF p.8)       | `attendanceApi.setDayStatus` exists (`api.ts:998`) and `_obsidian.tsx` renders these statuses, but `AdminAttendanceScreen` only does **approve/reject** of pending reviews (`AdminAttendanceScreen.tsx:43–64`) — **no day-status setter UI**.                                                                                                                                                                                                                                                                                                   | Step 22       |
| G6  | 🟡  | **Attendance Export** to PDF/CSV from the admin surface (PDF p.10)                  | No mobile `AttendanceExportScreen` exists; export is the `AdminAttendance` action + ops-console `dept-attendance/page.tsx` only. The PDF mock-up is a **mobile** Export Report screen — mobile parity is absent.                                                                                                                                                                                                                                                                                                                                | Step 22 (opt) |
| G7  | 🔴  | Members/managers actually **see** the v2 surfaces                                   | `DEPT_CHAT_V2` (client) reads `EXPO_PUBLIC_DEPT_CHAT_V2` (`constants.ts:30`), **not set in `.env` → OFF** and **build-time inlined** (needs a Metro restart/rebuild). Server `DEPT_CHAT_V2_ENABLED` is **not set on Contabo**. Auto-seeded channels are **unprovisioned** until an admin device opens each one.                                                                                                                                                                                                                                 | Step 24       |
| G8  | 🟠  | One dedicated **Departmental** module, reachable by **both parties** (PDF p.2)      | Screens scattered across `AgentNavigator` + messenger; **`CpoNavigator` can't reach attendance/incident at all**. (Already planned.)                                                                                                                                                                                                                                                                                                                                                                                                            | Step 19       |

---

## As-built addendum — 2026-07-02 spec-compliance completion batch (owner signed off)

> Everything below shipped in one batch after the PDF-spec compliance audit
> (`docs/audits/DEPT_CHAT_V2_SPEC_COMPLIANCE.md`), closing ALL remaining gaps.
> Gates: auth-service 1601 specs green (2 pre-existing failures verified on the
> pre-change baseline), mobile full Jest 1524 green, all three tsc clean/baseline,
> Android `assembleDebug` green WITH the new native dep, migration applied to
> staging Supabase.

- **Real face confirmation (p.6)** — live front-camera preview (`expo-camera` CameraView)
  - one-frame capture + **on-device MLKit face detection** (`@react-native-ml-kit/face-detection`,
    NEW native dep → **APK must be rebuilt**). `src/screens/deptchat/faceCheck.ts` owns the
    biometric stop-conditions (frame never leaves device, always deleted — unit-tested; scalar-only
    meta; degrades to capture-presence mode without the module). 🛑 Still presence detection,
    NOT 1:1 identity matching (separate legal sign-off required).
- **Verified check-out (p.5)** — same Verify screen in `mode: 'checkout'`; server-side pure
  `deriveCheckOut` flags face/location/radius failures → Pending Review (same reason set);
  `ClockOutDto` gained face fields; result screen is mode-aware ("Checked Out").
- **Dispute route (p.8)** — migration `20260702000000` ('disputed' reason + `dispute_note` +
  `org_members.department`, APPLIED); `POST /attendance/sessions/:id/dispute` (own/closed/
  non-pending, audited); Dispute action + note modal on the month-grouped `MyAttendanceScreen`
  (which now also shows day labels + full review outcomes).
- **Department-level manager scoping (p.9/p.16)** — `org_members.department` (NULL = whole org);
  `OrgManagerGuard` carries it; attendance summary/pending/export and incident queue/detail are
  FORCED to the manager's department; incident push routes to that department's + unscoped managers.
  No assignment UI yet — set via SQL/roster tooling (follow-up if needed).
- **Filters (p.9/p.14)** — attendance date presets + department chips (mobile) and
  department/shift_id server-side; incident date/department (server) + status filter row (mobile);
  export audit metadata now records every filter.
- **Audit completeness + original capture (p.9)** — `incident.submit` audited (no narrative);
  `attendance.shift.create/assign/update/archive` audited; `editShift` transactional with
  before/after clock times in the audit row (original capture preserved).
- **Shift edit/archive (p.9)** — `PATCH`/`DELETE /attendance/shifts/:id`; `ShiftEditorScreen`
  edit mode (assignments untouched); per-row edit/archive on `ShiftManagementScreen`.
- **PDF export (p.10)** — ops-console "Export PDF": client-side print-formatted report from the
  audited CSV endpoint (browser Save-as-PDF, zero new deps) + from/to date inputs.
- **Announcements board (p.3)** — `seedOrgWorkspace` seeds a board/read_only "Announcements"
  channel so the Home announcement card has a source on a fresh org.
- **Incident manual site entry (p.12)** — GPS-denied path offers a manual `location_label` input.

**Deliberately NOT built:** 1:1 face identity matching (legal), persistent in-app notification
inbox (push + badges cover the intent), live device-attestation chip. **Device proof pending:**
camera capture→detect→check-in/out round-trip on hardware (requires APK rebuild for MLKit).

---

## Step 20 — Add-Manager onboarding UI (company creates a Department Manager)

**Stage:** Reachability · **Depends on:** §0.3 org model · **Resolves:** G1; PDF p.16 (Department Manager role)
**Goal (plain English):** Let a service-provider company (or an existing manager) create a **Department Manager** from the app, not just a CPO. The whole backend + API already support it — only the create form is hardcoded to `cpo`.
**Self-contained context:**

- Backend is ready: `POST /org/cpos` → `createManagedCpo(org, dto)` accepts `dto.member_role ∈ {'cpo','manager'}` (default `'cpo'`), validated by `ORG_MEMBER_ROLES` (`org/dto/org.dto.ts:5`). A `'manager'` is seeded as channel **`admin`** and admitted by `OrgManagerGuard` Path 2. `orgApi.createCpo` already types `member_role?: 'cpo' | 'manager'` (`api.ts:837`).
- The **only** missing piece is the UI: `src/screens/agent/OrgCreateCpoScreen.tsx` never sets `member_role`.
  **Files to touch:**
- EXTEND `src/screens/agent/OrgCreateCpoScreen.tsx` — a **CPO / Manager** segmented control (default CPO); pass `member_role` into the `orgApi.createCpo({…})` call; adjust the success copy ("Manager added — they manage attendance, channels and the incident queue"). Reuse the existing obsidian form primitives — no new design.
- EXTEND `src/screens/agent/OrgRosterScreen.tsx` — show a **MANAGER / CPO** badge per row (`member_role` is already on `RosterMember`, `api.ts:826`) so the roster distinguishes them.
  **Security stop-conditions:** None new — the route is already `OrgManagerGuard`-gated and audited. Do not let a CPO reach this screen (it's behind the `isOrg`/manager roster entry).
  **Verification & test plan — full-proof (NOT done until every row passes):**

- **A · Direct:** RTL test — selecting **Manager** posts `member_role:'manager'` to `orgApi.createCpo`; default (untouched toggle) posts `'cpo'`. Roster row renders a **MANAGER** badge from `member_role` (`api.ts:826`).
- **B · Regression:** `apps/auth-service` `org-cpo.service.spec.ts` (createManagedCpo: manager path seeds channel `admin`; defaults to `cpo` when omitted) stays green; existing `OrgRosterScreen`/`OrgCreateCpoScreen` render unchanged for the CPO path; `npm test` (app).
- **C · Edge / negative:** duplicate email/phone → backend `ConflictException` surfaced in the UI (not a silent fail); temp-password generation/visibility unchanged; toggle resets cleanly between creates.
- **D · Security / isolation:** screen unreachable by a CPO (behind the manager/`isOrg` roster entry); endpoint stays `OrgManagerGuard`; assert an `org_audit_log`/audit row is written on manager create.
- **E · Manual device:** create a Manager → appears in roster with badge, `org_members.member_role='manager'`/`status='active'`, seeded as channel `admin`; the new manager logs in and (after Step 22) reaches the manager surfaces.
- **F · Gates:** `cd apps/auth-service && npm test` · mobile `npm run typecheck` ≤ baseline **49** · `npm run lint` · `npm test`. No red-gate commit; no `--no-verify`.
- **G · Sign-off:** green specs + a roster screenshot showing the Manager badge attached to the PR.
  **Done when:**
- [x] Company/manager can create a Manager (role toggle); roster distinguishes Manager vs CPO; backed by the existing audited endpoint. **✅ Step 20 IMPLEMENTED (2026-06-25):** `OrgCreateCpoScreen` gained a CPO/Manager segmented control (default CPO) that sends `member_role` to `orgApi.createCpo` + role-aware header/CTA/success copy; `OrgRosterScreen` shows a **MANAGER** badge per manager row. Backend/API unchanged (already accepted `member_role`). Gates: tsc 49=baseline, lint clean, app Jest green. Device proof (A/E/G) pending.

## Step 21 — Shift management UI (create shift + assign CPOs) 🔴

**Stage:** Reachability · **Depends on:** Step 4 (shift CRUD backend) · **Resolves:** G2; PDF p.5 ("Admin can assign shifts"; "block check-in when none")
**Goal (plain English):** Build the manager surface to **create a shift** (department, site + geofence centre, approved radius, start/end) and **assign CPOs** to it. Without this, `myTodayShift` is always null and **no CPO can ever check in** — the whole attendance feature is dead on arrival. This is the single highest-impact gap.
**Why it matters:** Step 4 shipped `createShift`/`assignCpos`/`listOrgShifts`/`myTodayShift` on the server and `attendanceApi.{createShift,assignCpos,listShifts}` on the client, but **nothing calls them**. The PDF's whole attendance loop (p.5–9) presupposes assigned shifts.
**Self-contained context:**

- All endpoints exist (`attendance.controller.ts`: `POST /attendance/shifts`, `POST /attendance/shifts/:id/assignments`, `GET /attendance/shifts`, `GET /attendance/my-shift/today`). Cross-org assignment is already rejected server-side (`cpo_not_active_member_of_org`).
- Site geofence: reuse the existing map/location pattern (Mapbox token is wired) for the centre; radius default 150 m.
  **Files to touch:**
- NEW `src/screens/deptchat/ShiftManagementScreen.tsx` (list org shifts + "New shift") and `ShiftEditorScreen.tsx` (department/site/lat-lng/radius/start-end + multi-select CPO assignment from the roster). Obsidian design system + `_obsidian` primitives.
- EXTEND `src/services/api.ts` — already has the calls; add `listOrgShifts` if missing.
- WIRE into the **manager Attend tab** (Step 19) and/or `AdminAttendanceScreen` as a "Manage shifts" entry.
  **Security stop-conditions:** 🛑 Provider routes are `OrgManagerGuard` + `assertOrgScope`; never trust a client-supplied org id. No background location — the geofence centre is set by the manager, not by tracking a CPO.
  **Verification & test plan — full-proof (NOT done until every row passes):**

- **A · Direct:** backend specs exist (Step 4) — assert `POST /attendance/shifts` creates, `POST /:id/assignments` assigns, `GET /attendance/my-shift/today` returns the covering shift; RTL: `ShiftEditor` validation (radius > 0, `start_at < end_at`, ≥ 1 CPO selected) blocks an invalid save.
- **B · Regression:** `attendance.service.spec.ts` (shift CRUD + `cpo_not_active_member_of_org`) green; **legacy `/attendance/*` clock-in/out byte-for-byte unchanged**; `npm test` (`app` + `booking` projects).
- **C · Edge / negative:** cross-org CPO assignment → `400 cpo_not_active_member_of_org` surfaced in UI; a CPO with **no** assigned shift → check-in stays blocked with "No active shift assigned"; empty roster / past-window / overlapping-shift handled gracefully.
- **D · Security / isolation:** every `:id` route enforces `assertOrgScope` (manager of org A can't assign/list org B's shifts → 403); **no background-location task added**; geofence centre is manager-set only.
- **E · Manual device (the critical end-to-end):** manager creates + assigns a shift → the assigned CPO's check-in **unblocks** → Verify (face+location) → status derives **present / late / pending-review** (Step 5) → the record appears in `AdminAttendance`. This proves G2 is closed.
- **F · Gates:** `cd apps/auth-service && npm test` · mobile `npm run typecheck` ≤ baseline **49** · `npm run lint` · `npm test`. No red-gate commit.
- **G · Sign-off:** green backend specs + a device capture of a CPO going from "No active shift" → checked-in after assignment.
  **Done when:**
- [x] Manager can create shifts and assign CPOs from the app; an assigned CPO's check-in unblocks end-to-end; cross-org assignment rejected (server `cpo_not_active_member_of_org`); A–D + F verification pass (E/G device proof pending).

> **✅ Step 21 IMPLEMENTED (2026-06-25, branch `feat/dept-chat-v2`).** NEW `src/screens/deptchat/ShiftManagementScreen.tsx` (lists `attendanceApi.listShifts`, upcoming/past, "New shift") + `ShiftEditorScreen.tsx` (department/site label · **optional geofence centre via `getGeo()` "Use current location" + manual radius** — no map picker, no background tracking · start/end via `@react-native-community/datetimepicker`, iOS modal-spinner / Android inline, pattern from `BookingDateTimeScreen` · active-CPO multi-select from `orgApi.listCpos`; Save → `createShift` then `assignCpos`) + `shiftValidation.ts` (pure guard: start<end, ≥1 CPO, radius>0 if coords) + test. Wired into the **manager Attend tab** (Step 19): `AdminAttendanceScreen` retyped to `DeptAttendStackParamList` + a "Manage shifts" card; both routes registered in `DepartmentalNavigator`'s Attend stack. Gates: mobile tsc **49=baseline**, lint clean, full Jest **1327 green** (incl. new `validateShiftDraft` test). No backend change (Step-4 endpoints reused). **Closes Gap G2** — a CPO with an assigned shift can now check in end-to-end. Map-picker for the geofence centre + edit/remove-assignment on an existing shift deferred (no list/remove-assignment API yet); device proof of the picker + the unblock loop pending hardware.

## Step 22 — Delegated-manager mobile surface (gate fix + day-status + export)

**Stage:** Reachability · **Depends on:** Steps 6,7,9,15,19 · **Resolves:** G3, G5, G6; PDF p.8,9,10,14,15
**Goal (plain English):** A **Department Manager** (a managed sub-account, `member_role='manager'`) routes into the agency shell but sees **no** manager screens, because those are gated on `agent.type==='company'`. Fix the gate so delegated managers get Admin Attendance, the Incident Queue, channel + shift management; and add the missing **day-status setter** (leave/sick/off-duty) and a mobile **export** entry.
**Why it matters:** G3 — without this, the _only_ manager who can use the mobile manager tools is the company account itself; a delegated manager (the PDF's primary "Department Manager" persona) is locked out of their own job.
**Self-contained context:**

- Root cause: managers are created with `agents.type='cpo'` (`org-cpo.service.ts:154`), and `account_kind` resolves them to `'agency'` (`account-kind.ts:72,77`), but the dashboard's `isOrg = me.agent.type==='company'` (`AgentDashboardScreen.tsx:451`) is **false** for them, so the manager nav rows (gated `DEPT_CHAT_V2 && isOrg`, lines 476–479) never render.
- Correct discriminator: **manager-or-company**, resolved from `/auth/me` (`account_kind==='agency'` already means "company OR active manager"). Use a `canManage = account_kind==='agency'` (or an explicit `is_org_manager` bootstrap field) instead of `agent.type==='company'` for the **dept-chat** manager surfaces. Keep the company-only surfaces (Missions/Compliance/Roster create) where they genuinely require a company agent, or open them to managers per the permission matrix (§Step 16) — decide per row, citing PDF p.16.
- Day-status: `attendanceApi.setDayStatus` exists; add a setter to `AdminAttendanceScreen` (or the manager Attend tab) for leave/sick/off-duty/absent on a member-day.
- Export: either a mobile `AttendanceExportScreen` (p.10) or a clear "Export on the ops console" affordance — pick one and state it (Appendix A#4 default = heavy export on ops-console).
  **Files to touch:**
- EXTEND `src/screens/agent/AgentDashboardScreen.tsx` (or the Step-19 Departmental Home) — replace the `isOrg` gate on the **dept-chat manager** rows with a manager-aware predicate.
- EXTEND `src/screens/deptchat/AdminAttendanceScreen.tsx` — add day-status setter + (optional) export entry.
- VERIFY `AgentNavigator`/Departmental shell renders sanely for a manager who has no company agent profile (guard `agentApi.getMe()` assumptions; a manager may have a `cpo`-type agent row — don't assume company fields).
  **Security stop-conditions:** 🛑 The fix is **presentation only** — server routes stay `OrgManagerGuard`/`AdminGuard` gated; never widen a guard to match the UI. Re-confirm a CPO still cannot see any manager row. Day-status writes go through the audited Step-6 endpoint.
  **Verification & test plan — full-proof (NOT done until every row passes):**

- **A · Direct:** unit — the new `canManage` predicate is **true** for a delegated manager (`account_kind==='agency'`, `agent.type==='cpo'`) and **false** for a CPO; the day-status setter calls `attendanceApi.setDayStatus` with the correct `{cpo_user_id, status, date?, notes?}`.
- **B · Regression:** the Step-16 permission-matrix specs + `deptchat-permissions.spec.ts` stay green; `AgentDashboardScreen` for a real **company** account renders unchanged (company surfaces untouched).
- **C · Edge / negative:** a manager with **no company agent profile** does not crash `AgentDashboardScreen` (`agentApi.getMe()` company-only fields are guarded); setting day-status on a day that already has a session is handled; the export affordance routes correctly (mobile screen or "export on ops-console" note).
- **D · Security / isolation:** re-run the Step-16 matrix — a **CPO sees zero** manager rows; server routes unchanged and still `OrgManagerGuard`/`AdminGuard`-gated (no guard widened to match UI); every day-status write produces an `org_audit_log` row.
- **E · Manual device:** a **delegated manager** logs in → sees Admin Attendance + Incident Queue + Manage Shifts/Channels; approves/rejects a pending check-in, sets leave/sick/off-duty, walks an incident through the FSM; a **CPO** logged in side-by-side sees none of it.
- **F · Gates:** `cd apps/auth-service && npm test` (matrix) · mobile `npm run typecheck` ≤ baseline **49** · `npm run lint` · `npm test`. No red-gate commit.
- **G · Sign-off:** green matrix specs + side-by-side device captures (manager sees manager surface, CPO does not).
  **Done when:**
- [x] Delegated managers get the full manager surface on mobile; day-status setter works; export path is explicit; CPO isolation intact; no guard weakened. **✅ Step 22 IMPLEMENTED (2026-06-25):** (G3) `AgentDashboardScreen` now gates the dept-chat manager badge/copy on a `canManage` predicate (`role==='service_provider' || account_kind==='agency'`) instead of `agent.type==='company'`, so a **delegated manager** gets the manager experience; the company-only rows (Missions/Compliance/Roster) stay on `isOrg`. Note G3 was already largely closed by **Step 19** — the Departmental entry is flag-gated (not `isOrg`-gated) and the module role-branches on `account_kind==='agency'` (true for delegated managers), so they already reached the manager roots + Manage-shifts. (G5) NEW `DayStatusScreen` (pick CPO + status leave/sick*leave/off_duty/absent + day + note → audited `attendanceApi.setDayStatus`), reached from a "Set day status" card on Admin Attendance; registered in the Attend stack. (G6) **Export stays on the ops-console** (runbook Appendix A#4 default) — no mobile export screen added. Gates: tsc 49=baseline, lint clean, app Jest green. Device proof pending. *(Note: a concurrent live-tracker/Mapbox WIP in the working tree owns the intermittently-failing `mapboxDirections.test.ts` — unrelated to dept-chat.)\_

## Step 23 — Member "My submitted incidents" list

**Stage:** Reachability · **Depends on:** Step 8, Step 19 · **Resolves:** G4; PDF p.16 ("view own submitted incidents")
**Goal (plain English):** Give a member a list of the incidents **they** submitted (ref, category, severity, status), read-only, with a tap-through to a member-safe detail (no internal manager notes). `incidentApi.mine` already returns the data.
**Self-contained context:**

- `incidentApi.mine` exists and is unused; the member detail must **exclude** `note_internal=true` events (Step 9 stop-condition).
- Natural home: the **member root of the Step-19 Incident tab** — "Report Incident" + a "My Reports" list beneath it (the PDF Incident tab for a member).
  **Files to touch:**
- NEW `src/screens/deptchat/MyIncidentsScreen.tsx` (list) + reuse a member-safe `IncidentDetail` (hide internal notes/assignee).
- WIRE as the Incident-tab member root (Step 19) and from `IncidentSubmitted`'s "View incident".
  **Security stop-conditions:** 🛑 Member detail must never render internal notes or other members' incidents (server already scopes `mine` to `submitter_id`; assert the UI requests only `mine`).
  **Verification & test plan — full-proof (NOT done until every row passes):**

- **A · Direct:** RTL — `MyIncidentsScreen` lists rows from `incidentApi.mine` (ref/category/severity/status); the member detail **omits** any `note_internal=true` event and the assignee.
- **B · Regression:** incident `submit`/`mine` service specs + the Step-9 "internal notes hidden from member view" spec stay green; `npm test` (`app`).
- **C · Edge / negative:** empty state when the member has no incidents; status changes by a manager reflect on the member's list/detail on focus; a freshly-submitted incident appears immediately.
- **D · Security / isolation:** a member fetching another member's incident id → **403** (server-scoped to `submitter_id`); the UI only ever calls `mine`; no internal note / assignee / other-member data renders.
- **E · Manual device:** submit an incident → it appears under **My Reports** with `Submitted`; manager advances status → member sees the new status; an internal manager note is **never** visible to the member.
- **F · Gates:** `cd apps/auth-service && npm test` · mobile `npm run typecheck` ≤ baseline **49** · `npm run lint` · `npm test`. No red-gate commit.
- **G · Sign-off:** green specs + a device capture of My Reports with a status change, internal note absent.
  **Done when:**
- [x] Members can list and re-open their own submitted incidents; internal notes hidden; scoped to the submitter. **✅ Step 23 IMPLEMENTED (2026-06-25):** NEW `MyIncidentsScreen` is now the **member root of the Departmental Incident tab** ("Report an Incident" → wizard + a read-only list from `incidentApi.mine`); NEW `MyIncidentDetailScreen` is built ENTIRELY from the passed `IncidentReportDto` (never calls the manager `detail` endpoint → internal notes / assignee / status controls can't leak). Member initialRouteName flipped `ReportIncidentCategory`→`MyIncidents`; `IncidentSubmitted` Done(popToTop) now lands on My-Reports (shows the fresh report); Home's member "Report incident" deep-links to the wizard. Gates: tsc 49=baseline, lint clean, app Jest green (structural test updated). Device proof pending.

## Step 24 — Enablement runbook (turn it on for a pilot) — operational, not code

**Stage:** Operate · **Depends on:** Step 17 + Steps 19–23 · **Resolves:** G7
**Goal (plain English):** The exact switches/seed-data to make the module live for one pilot org, end-to-end, with rollback = off.
**Checklist:**

1. **Server flag:** set `DEPT_CHAT_V2_ENABLED=true` on the Contabo auth-service container (`apps/auth-service` env) and restart — otherwise the v2 routes 404 (`DeptChatV2Guard`). _(Until the server-driven `deptChatV2` bootstrap field lands, this is per-deployment, not per-org.)_
2. **Client flag:** build with `EXPO_PUBLIC_DEPT_CHAT_V2=true` (it's **build-time inlined** in `constants.ts` — a Metro restart re-reads `.env`; a release APK must be rebuilt). State this in the test plan.
3. **Provision channels:** an **admin device** (manager/company) must open each auto-seeded channel once so the Signal group bootstraps (`DepartmentChannelsScreen.openChannel` → `createGroupChat → registerGroup`); until then CPOs see "not yet active".
4. **Seed shifts:** create + assign at least one shift (Step 21) so check-in is reachable.
5. **Smoke the 3-device matrix** (PDF p.17): member check-in (present/late/pending), manager review (approve/reject) + day-status, incident submit → resolve; watch `org_audit_log` + `ops_audit`.
6. **Rollback:** flag off → legacy `/attendance/*` + chat are byte-for-byte unchanged.

   **Verification & test plan — full-proof (NOT done until every row passes):**

- **A · Direct (PDF p.17 QA-retest as live checks):** check-in blocked when no shift · location-denied → Pending Review (not Absent) · face-fail → Pending Review with admin-visible reason · out-of-radius → Pending Review · member can't see others' attendance · member can't open the manager queue · incident photo skippable (report still submits) · unique `INC-YYYY-NNNNN` ref · manager push+in-app on submit · export logs admin/date/filters/format. Run each on the pilot org.
- **B · Regression (flag OFF, proving zero blast radius):** with `DEPT_CHAT_V2_ENABLED` unset, legacy `/attendance/*` + chat behave **identically** — re-run `cd apps/auth-service && npm test` and the mobile `npm test`; confirm the new routes 404 and no legacy screen changed.
- **C · Edge / negative:** unprovisioned channel shows "not yet active" to a viewer until an admin device opens it; a CPO with no shift is blocked (not crashed); a flag-OFF client never shows the Departmental entry.
- **D · Security / isolation:** the 3 sensitive flows re-confirmed on real devices — biometric result-only (no frames leave device), incident media encrypted-before-upload, push payloads metadata-only; File-Vault MFA fires on the Vault tab.
- **E · Manual device (the go/no-go):** the full **both-parties** loop on real hardware — provider creates manager + shift + channels; CPO checks in + reports incident; manager reviews + resolves. Capture evidence.
- **F · Gates:** full `npm run ci:full` (or `apps/auth-service && npm test` + mobile `npm test` + both typechecks ≤ baseline + lint) green before flipping the flag for the pilot.
- **G · Sign-off:** the PDF p.17 QA-retest checklist fully ticked with evidence; pilot smoke green; rollback rehearsed.
  **Done when:**

- [ ] A pilot org runs the full member + manager + incident loop on real devices; **all A–G verification rows pass**; rollback proven.

---

## Appendix A — Decisions

### Decided (locked for v1 — 2026-06-21)

1. **Face verification depth (Step 5, 🛑) — DECIDED: PDF default.** v1 ships \*presence/liveness confirmation
   - result-only\* (store the boolean result + non-biometric `face_meta`, never frames/descriptors). A true
     1:1 identity matcher is **explicitly out of scope for v1**; adding one later requires an approved vendor +
     architecture/legal sign-off.
2. **Incident photo (Step 10, 🛑) — DECIDED: reuse.** Incident evidence reuses the existing encrypted-media
   pipeline (AES-256-CBC, unique key per file, encrypt-before-upload to the Supabase S3 endpoint). No new
   media path. Honour the File Vault MFA gate on download **if** the System Architecture Documentation
   requires it for sensitive media — do not bypass.
3. **Per-department manager scoping (Step 4/16) — DECIDED: v2.1 refinement.** v1 ships **manager = org-wide**;
   `department` is a free-text label on shifts/incidents/channels. The PDF's "department admin sees only
   assigned departments" is a tracked v2.1 refinement, not an MVP blocker. State this in each PR description.

### Still open (defaults stand unless changed)

4. **Manager surface split (Step 15):** which admin screens ship on mobile vs. ops-console. Default: manager
   day-to-day on mobile, heavy export/oversight on ops-console.
5. **Leave/sick/off-duty workflow (Step 6):** v1 = manager-set on the day. Confirm whether a CPO-request →
   manager-approve flow is needed for MVP.

---

## Build status & rollout (2026-06-22, branch `feat/dept-chat-v2`)

**Implemented Steps 1–16** (all behind `DEPT_CHAT_V2` / `featureFlags.deptChatV2`, default OFF):

- Backend (auth-service): flag + `DeptChatV2Guard`; attendance v2 (shift CRUD, verified check-in w/ `deriveCheckIn`,
  review workflow, auto-absent Redis sweep, summary + CSV export); incident submit + FSM + manager queue/detail/
  status/assign/note + evidence pointer layer; `OrgAuditService`; metadata-only incident push; channel typing;
  Bravo-admin oversight controller (`/ops/deptchat/*`). **85 specs green** across 9 suites; `nest build` clean.
- Migrations **applied to staging Supabase** (`qkkfkicgoncxslbwhyhz`): `attendance_v2`, `incident_reports`,
  `channel_types` — verified (tables, columns, seq, RLS).
- Mobile (obsidian #07090D/#5B8DEF): member flow (Attendance → Verify → Result, My Attendance, Report-Incident
  wizard) + manager screens (Admin Attendance, Incident Queue, Incident Detail) + dashboard quick-actions/badges +
  channels hub grouping/badges. tsc at baseline **49**, lint clean.
- Ops-console: Incident Oversight + Attendance Oversight/Export pages (AdminGuard tier). typecheck clean.

**Rollout (Step 17) — flag flip is the only customer-visible change:**

1. Pilot org: set `DEPT_CHAT_V2_ENABLED=true` on the auth-service pod(s). Mobile reads the build-time
   `EXPO_PUBLIC_DEPT_CHAT_V2` (a staged build), pending the server-driven `deptChatV2` bootstrap field.
2. Smoke the 3-device matrix: member check-in (present/late/pending-review), manager review (approve/reject),
   incident submit → resolve. Watch `org_audit_log` + `ops_audit`.
3. Widen after green. **Rollback = flag off** (legacy `/attendance/*` + chat are byte-for-byte unchanged throughout).

**QA-retest (PDF p.17) coverage:** check-in-blocked-no-shift, location-denied→pending (not absent), face-fail→
pending+reason, out-of-radius→pending, member-can't-see-others'-attendance / manager-queue, photo-skippable,
unique ref, manager-push-on-submit, export-audit-logged → **all covered by automated specs**. Device/manual:
camera live-preview, real FCM delivery, 3-device smoke.

> **✅ Post-audit completeness pass (2026-06-25):** a 4-way audit of Steps 19–23 confirmed the core loops complete with zero stubs, and surfaced 3 UI gaps. Two are now closed: (a) **manager assign-incident UI** — `IncidentDetailScreen` gained an "Assigned to" card + assignee picker (any active org member or "Assign to me") wired to `incidentApi.assign`, with roster name resolution; (b) **Home "Latest announcement"** (PDF p.3) — `DepartmentalHomeScreen` surfaces the org's `board`/`read_only` channel with its unread count and deep-links into the thread (message bodies are E2EE / not in metadata, so no preview text is decrypted). The third (incident photo evidence) stays gated below.

**Gated follow-ups (NOT shipped — need sign-off / device):**

- 🛑 **Incident-evidence photo attachment + E2EE key delivery** (Step 10): the report wizard shows a DISABLED "Photo evidence" placeholder; `incidentApi.attach`/`listAttachments` exist but are intentionally unwired. Capturing/encrypting/uploading the photo touches the media-encryption + file-vault 🛑 flow, and delivering the per-file key/iv to managers needs the sealed-envelope mechanism per the System Architecture Documentation — **architecture sign-off required** before wiring (do not bypass).
- **Camera live-preview** (Step 5/14 Verify): v1 is presence/liveness confirmation (result-only). A live
  preview (expo-camera / vision-camera) is a device-tested follow-up.
- **PDF export** (Step 7): server emits CSV; PDF renders client-side on the ops-console (no server PDF dep added).
- **CpoNavigator wiring + scattered entry points → now planned as Step 19 (Stage 6).** Member screens live in
  `AgentNavigator`; the managed CPO (`CpoNavigator` 4-tab shell) can't reach attendance/incident at all; channels
  sit three taps deep. **Step 19** consolidates all of it into one dedicated **Departmental** 5-tab module
  (Home · Channels · Attend · Incident · Vault) reached from a single entry point by **both parties** — the
  100%-PDF realization. This bullet is superseded by that step.
- **Per-department manager scoping** (Appendix A#3): v1 ships manager = org-wide.
- ✅ **Dept-chat entitlement bug — FIXED (verified 2026-06-24).** `DepartmentController` is now `@UseGuards(JwtAuthGuard, DeptChatAccessGuard)` (`department.controller.ts:26`; guard `dept-chat-access.guard.ts`), entitling by **service-provider org membership** (company account / active `org_members` row) — the old `@RequireTier('pro')` + mobile paywall are gone. Lite org members reach their own channels. (Kept here as a resolved-history note; see the **Gap Register** for the remaining open gaps G1–G8.)

## Step 25 — Incident evidence shipped + device-test #1 fixes + sync audit (2026-06-25)

**Step 10 incident photo evidence is now BUILT** (was gated above) via an architecture-consistent reuse seam — see [`INCIDENT_EVIDENCE_E2EE_PLAN.md`](INCIDENT_EVIDENCE_E2EE_PLAN.md) for the full E1–E6 detail. Summary: the photo is AES-encrypted + uploaded via the existing `MediaClient`, and its per-file key is sealed (existing outer-ECIES `wrapOuter`/`unwrapOuter`) to each recipient device; the server stores only opaque sealed blobs in `incident_attachment_keys` (migration applied to Supabase). The ONLY messenger change is the approved additive runtime seam (`uploadEvidence`/`sealOuterTo`/`openOuterAsSelf`/`grantMediaAccess`) — no existing chat/group/call path touched.

**Device test #1 (INC-2026-00001) — two bugs the tester saw + fixes (committed):**

- **Photo invisible to the service/manager viewer.** Live DB showed `incident_attachments`/`incident_attachment_keys` EMPTY (`att_count=0`) — the photo was never uploaded. The submit path failed at/before `uploadEvidence` (prime suspect: media storage not presigning — "S3 keys pending") and **two stacked silent `catch{}`** hid it. Also the capture "refreshed" the app — a multi-MB base64 in screen state got the host activity reclaimed under memory pressure. **Fixes (deptchat-only):** capture by `uri` not `includeBase64` (read bytes at upload via the existing `readUriBytes`); `uploadAndSealEvidence` now returns `EvidenceResult{attached,sealedFor,reason}` and the submit screen shows a clear failure instead of a silent success; non-secret `[bravo.incident-evidence]` diagnostics pinpoint the failing step on the next device run. **NOTE:** `EVIDENCE_DEVICE_ID=1` is the Signal _protocol_ device id (what chat uses for every peer); the `auth_devices.signal_device_id` counter (6/2 after reinstalls) is a separate auth-layer value — NOT the cause, so the seal was left unchanged.
- **Location showed raw coords ("Current location · 23.6801, 90.5240").** **Fix:** new `geo.reverseGeocode(lat,lng)` (Mapbox, `EXPO_PUBLIC_MAPBOX_TOKEN`) sets `location_label` to a readable address (falls back to a coarse label on a miss). Both detail screens already render `location_label`.

**Backend↔frontend sync audit (4-way: API contract · role sync · evidence path · live data-model):** verdict **mostly synced, fails closed** — all 38 mobile API calls map to real routes with matching shapes; every column the code touches exists in Supabase with the right types + the `(attachment_id, recipient_user_id, device_id)` UNIQUE constraint; every manager-only screen is `OrgManagerGuard`-gated server-side. Three real items found + **all fixed (2026-06-25):**

- **B-DC-1 (medium) — manager shown the member surface.** Mobile inferred manager-ness from `account_kind`, but `deriveAccountKind` gives CPO precedence, so a user who is a CPO of org A _and_ a manager of org B collapsed to `account_kind='cpo'` and was routed to the member surface (under-privilege, no leak). **Fix:** `/auth/me` now returns `is_org_manager`, resolved by `resolveIsOrgManager` (account-kind.ts) which mirrors `OrgManagerGuard` exactly (company agent OR active manager membership), independent of the cpo-collapsed row. Mobile threads it through `me()` → `toUser` → `User.is_org_manager`; `useIsManager()` (DepartmentalNavigator) + `DepartmentalHomeScreen` + `DepartmentChannelsScreen` + `AgentDashboardScreen` now prefer the flag (heuristic kept as fallback for pre-flag cached sessions).
- **B-DC-2 (low) — assign-owner picker narrower than the server.** UI restricted assignees to managers; `assign()` allowed any active member. **Fix:** the server now enforces the UI's invariant — `assign()` accepts only the company account or an active `member_role='manager'` (`assignee_must_be_manager`).
- **B-DC-3 (low) — manager had no in-app "Report an Incident" path** (it lived only on the member root). **Fix:** added a "Report an Incident" entry on `IncidentQueueScreen` → the existing report wizard (`submit()` is gated by `JwtAuthGuard` only, so managers can file).

**Open follow-up:** confirm whether `att_count=0` is the messenger-service `/media` presign / S3 storage config on Contabo (the diagnostics will reveal it on the next build); if so it's a deploy/config fix, not code.
