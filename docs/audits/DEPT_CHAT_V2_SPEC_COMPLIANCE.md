# Department Chat v2 — Spec Compliance Report

> Source of truth: **`Bravo Department Chat Screen Mockups.pdf`** (repo root, 17 pages,
> "Department Chat v2 — Developer Specification").
> Verified against: `main` @ `6d19e78` (2026-07-02), mobile + `apps/auth-service` +
> `apps/ops-console`.

> Method: 4 parallel verification agents, one per spec area, every verdict backed by
> file:line evidence.

**Bottom line (updated 2026-07-02): all gaps closed.** The original verification (~49
full / ~20 partial / 1 missing of ~70 items) drove two remediation batches the same
day — first the three wiring bugs, then (with owner sign-off) the full remainder:
real on-device face detection (check-in AND check-out), PDF export, department-level
manager scoping, admin filters end-to-end, the attendance dispute route, complete
audit coverage with original-capture preservation, shift edit/archive, seeded
Announcements board, manual incident site entry, and the My-Attendance rework.
Remaining known deltas: 1:1 face _identity_ matching (needs legal sign-off — current
build is live face-presence detection), a persistent in-app notification inbox
(push + badges serve the intent), and the static "device trusted" chip. ⚠️ The new
camera flow needs a rebuilt APK (new native dep) + device smoke.

---

## Scorecard by spec page

| Spec page                  | Area                                                                | Status                 |
| -------------------------- | ------------------------------------------------------------------- | ---------------------- |
| 01 Main Dashboard          | Quick actions, today's status, role-gated incident tiles, 5-tab nav | ✅ 6/8, 2 partial      |
| 02 Channels Hub            | Board/Dept/Incident grouping, badges, server-side visibility        | ✅ 5/5                 |
| 03 Attendance Dashboard    | Shift card, check-in/out, no-shift block                            | ✅ 4/5, 1 partial      |
| 04 Face + Location Verify  | Radius check, no biometric storage, pending-review on failure       | ⚠️ 4/6, 2 partial      |
| 05 Attendance Result       | Confirmed/pending screens, immutable timestamps                     | ✅ 3/4, 1 partial      |
| 06 My Attendance           | Own-records-only, all 8 statuses                                    | ⚠️ 2/4, 1 missing      |
| 07 Admin Attendance        | Summary, pending queue, approve/reject, shifts                      | ⚠️ 3/8 full, 5 partial |
| 08 Attendance Export       | CSV, columns, audit, biometric-free                                 | ⚠️ 3/5, PDF missing    |
| 09–11 Incident Submit      | 15 categories, severity, photo, ref ID, E2EE evidence               | ✅ 12/15, 3 partial    |
| 12–13 Incident Queue + FSM | 403 for members, sorting, 6-state lifecycle, reopen, assign         | ✅ 8/10, 2 partial     |

---

## SPEC 01 — Main Dashboard (`src/screens/deptchat/DepartmentalHomeScreen.tsx`)

| #   | Item                                                                              | Verdict     | Evidence / notes                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Attendance + Report Incident primary quick actions                                | ✅          | `DepartmentalHomeScreen.tsx:209-240` — quick-action grid; member "Report incident" deep-links the wizard (`:225`)                                                              |
| 2   | Today's attendance status on dashboard                                            | ✅ (member) | `:89-98` derives On shift / Not checked in / No shift today; card `:171-183`. Managers get review tiles instead                                                                |
| 3   | Latest announcement card                                                          | ⚠️ PARTIAL  | Card `:145-169`, first `board`/`read_only` channel + unread badge. **Gap:** default seeding (`department.service.ts:159-163`) creates no board channel → empty for a fresh org |
| 4   | Unread channel activity                                                           | ✅          | Badge `:165-167`; CPO tab-level badge `CpoNavigator.tsx:84`                                                                                                                    |
| 5   | Vault quick action                                                                | ✅          | `:234-239` — "Vault / Files · MFA protected"                                                                                                                                   |
| 6   | Secure connection / device trusted indicator                                      | ⚠️ PARTIAL  | Card `:133-143`, but static always-on text — no live attestation behind it                                                                                                     |
| 7   | Incident alerts only for authorised roles; no sensitive detail in member previews | ✅          | Manager-only tiles gated by `isManager` `:185-206`; counts fetched only when manager `:74-80`; member Home renders no incident detail                                          |
| 8   | 5-tab nav: Home, Channels, Attend, Incident, Vault                                | ✅          | `DepartmentalNavigator.tsx:167-171`; Attend/Incident roots role-branched (`:96-132`)                                                                                           |

## SPEC 02 — Channels Hub (`src/screens/messenger/DepartmentChannelsScreen.tsx`)

| #   | Item                                                  | Verdict | Evidence / notes                                                                                                                                                                   |
| --- | ----------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | Grouped: board / departments / incident               | ✅      | `:217-253` iterates the three `channel_type` groups                                                                                                                                |
| 10  | Read-only / private / restricted badges               | ✅      | `rowState()` `:277-286` → READ-ONLY / PRIVATE / MANAGERS / ADMIN / ACTIVE / INACTIVE                                                                                               |
| 11  | Members can't see incident channels unless authorised | ✅      | Enforced server-side by membership seeding — `department.service.ts:207-228` (`managersOnly` skip for CPOs); `listChannels` is a membership JOIN (`:45-67`). No client-side hiding |
| 12  | Managers access their incident queue channel          | ✅      | Managers always seeded as `admin` into incident/restricted channels (`department.service.ts:219-227`)                                                                              |
| 13  | Unread + member count indicators                      | ✅      | Unread from encrypted store `:263-273`; member count on manager Manage screen (`ManageChannelsScreen.tsx:112`). Member-facing hub row shows unread only                            |

## SPEC 03 — Attendance Dashboard (`src/screens/agent/AttendanceScreen.tsx`)

| #   | Item                                                 | Verdict    | Evidence / notes                                                                                                                                                                          |
| --- | ---------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Today's shift shown before check-in                  | ✅         | `AttendanceScreen.tsx:166-184` (site + department + window + radius); backend `myTodayShift` (`attendance.service.ts:407-422`). No shift `name` column — site+dept+window is the identity |
| 2   | Check-in / check-out actions                         | ✅         | Sticky footer `:227-233`; routes `attendance.controller.ts:31-41`                                                                                                                         |
| 3   | Face + location for check-in AND check-out           | ⚠️ PARTIAL | Check-in: both (`VerifyAttendanceScreen.tsx:36-43`). **Check-out: location only, no face** (`AttendanceScreen.tsx:72-84`, `ClockOutDto` lat/lng only)                                     |
| 4   | Location only during actions, no background tracking | ✅         | `geo.ts:4-28` single-shot `getCurrentPosition`, no watch                                                                                                                                  |
| 5   | No shift → blocked with clear state                  | ✅         | Client `:106,147,233`; server throws `no_active_shift_assigned` (`attendance.service.ts:212-213`)                                                                                         |

## SPEC 04 — Face and Location Verification (`src/screens/deptchat/VerifyAttendanceScreen.tsx`)

| #   | Item                                          | Verdict               | Evidence / notes                                                                                                                                                                                                                                          |
| --- | --------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6   | One controlled flow: face + location + radius | ✅                    | Server-authoritative `deriveCheckIn` (`attendance.service.ts:126-158`), haversine vs `approved_radius_m`                                                                                                                                                  |
| 7   | Face confirmation                             | ⚠️ PARTIAL            | **Presence-only:** `face_ok = camOk === true` — camera _permission_ result, no preview/capture/liveness (`VerifyAttendanceScreen.tsx:29,41`; documented v1 decision `:19-21`)                                                                             |
| 8   | No raw biometric storage                      | ✅                    | Boolean + sanitized meta only; `sanitizeFaceMeta` strips arrays/objects (`attendance.service.ts:108-119`); schema has explicit no-frames note (`20260629000000_attendance_v2.sql:11-15,59-60`)                                                            |
| 9   | Privacy wording before first use              | ✅                    | Shown every check-in (`VerifyAttendanceScreen.tsx:100-109`)                                                                                                                                                                                               |
| 10  | Failures → Pending Review, never absent       | ✅                    | Every failure branch returns `pending_review` (`attendance.service.ts:135-148`)                                                                                                                                                                           |
| 11  | Admin sees failure reason                     | ✅ (fixed 2026-07-02) | All five reasons wired end-to-end. `camera_unavailable` was dead code (stripped by ValidationPipe, never sent, no label) — fixed: `ClockInDto.face_unavailable` added, `VerifyAttendanceScreen` sends it on camera denial, `reviewReasonLabel` renders it |

## SPEC 05 — Attendance Result (`src/screens/deptchat/AttendanceResultScreen.tsx`)

| #   | Item                                     | Verdict    | Evidence / notes                                                                                            |
| --- | ---------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| 12  | Shows time, shift, location              | ⚠️ PARTIAL | Time + site shown (`:55-56`); no shift window; no result screen on check-out                                |
| 13  | Pending Review shown, never "absent"     | ✅         | `:22,40,46-48` — "You have NOT been marked absent."                                                         |
| 14  | Immutable audit timestamp                | ✅         | `clock_in_at` DB-default at INSERT; review touches only review columns (`attendance.service.ts:460-472`)    |
| 15  | View own record, can't edit verification | ✅         | Self endpoints read-only; edit/review are `OrgManagerGuard`-only (`attendance.controller.ts:58-70,113-121`) |

## SPEC 06 — My Attendance (`src/screens/deptchat/MyAttendanceScreen.tsx`)

| #   | Item                                         | Verdict    | Evidence / notes                                                                                     |
| --- | -------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| 16  | Weekly/monthly history, 8 statuses           | ⚠️ PARTIAL | All 8 statuses in DB CHECK + UI meta. **No weekly/monthly grouping** — flat list, 3 counters only    |
| 17  | Status, in/out, shift, review result per row | ⚠️ PARTIAL | Status/in/out/pending-reason shown; **shift label and approved/rejected outcomes missing** from rows |
| 18  | Own records only                             | ✅         | `myShifts(user.sub)` scoping + RLS deny-by-default                                                   |
| 19  | Dispute/support route                        | ❌ MISSING | No attendance dispute endpoint or UI anywhere (booking disputes exist, unrelated)                    |

## SPEC 07 — Admin Attendance View (`src/screens/deptchat/AdminAttendanceScreen.tsx`)

| #   | Item                                             | Verdict               | Evidence / notes                                                                                                                                                                              |
| --- | ------------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Present/late/absent summary                      | ✅                    | `orgSummary` (`attendance.service.ts:529-555`); mobile `:94-98`; ops-console `dept-attendance/page.tsx:83-96`. Org-scoped, not per-department                                                 |
| 2   | Pending queue with reasons                       | ✅                    | `pendingQueue` (`:558-565`) + `reviewReasonLabel` on mobile                                                                                                                                   |
| 3   | Approve/reject WITH notes                        | ✅ (fixed 2026-07-02) | Approve/reject now opens a modal with an optional notes field (`AdminAttendanceScreen`); notes flow to `admin_notes` via `reviewSession`                                                      |
| 4   | Filter by date / department / shift / member     | ⚠️ PARTIAL            | API: date + member only; **department/shift filters don't exist server-side; mobile UI exposes zero filter controls**                                                                         |
| 5   | Every admin action audit logged                  | ⚠️ PARTIAL            | Review/day-status/export logged. **`createShift`/`assignCpos`/`editShift` write no `org_audit_log` row**                                                                                      |
| 6   | Manual edits keep original capture               | ⚠️ PARTIAL            | Geo/face/radius immutable, but **`editShift` overwrites `clock_in_at`/`clock_out_at` in place** (`attendance.service.ts:313-321`) — only `edited_by/at/reason` retained                       |
| 7   | Dept admin / company admin / Bravo admin scoping | ⚠️ PARTIAL            | Company admin ✅ (`OrgManagerGuard`); Bravo admin ✅ (AdminGuard + dual audit, `ops-deptchat.controller.ts:23-24,60-63`); **department-level scoping MISSING** — a manager sees the whole org |
| 8   | Shift assignment                                 | ✅ (CRUD gap)         | Create/Read/Assign + UI (`ShiftEditorScreen`, `ShiftManagementScreen`); **no update/delete/archive endpoint** (`archived_at` column exists, unused)                                           |

## SPEC 08 — Attendance Export

| #   | Item                                   | Verdict    | Evidence / notes                                                                                                                                                                                                      |
| --- | -------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | PDF AND CSV/Excel                      | ⚠️ PARTIAL | CSV ✅ (`exportSessions`, `attendance.service.ts:573-620`). **PDF MISSING everywhere** — comments claim "client-side on ops-console" but the page has only Export CSV; no PDF lib in any package.json. No xlsx either |
| 10  | Filters: date range, department, shift | ⚠️ PARTIAL | Date range ✅; **department + shift filters missing**                                                                                                                                                                 |
| 11  | Required columns                       | ✅         | Member, ID, Department, Site, in/out, Status, Face verified, In radius, Admin notes (`:598-609`). "Shift" = site label                                                                                                |
| 12  | Export audit (who/when/filters/format) | ✅ (minor) | `attendance.export` audit row (`:611-613`); `cpo_user_id` filter not recorded in metadata                                                                                                                             |
| 13  | No biometric images                    | ✅         | Only `face_verified` boolean exported; `face_meta` never selected                                                                                                                                                     |

## SPEC 09 — Incident Category and Severity

| #   | Item                                     | Verdict    | Evidence / notes                                                                                                                                  |
| --- | ---------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Any member can submit                    | ✅         | `POST /incidents` — JWT + flag guard only (`incident.controller.ts:24-33`)                                                                        |
| 2   | All 15 categories                        | ✅         | `incident.constants.ts:6-11` + `incidentMeta.ts:10-26` — all 15 present. DTO-enforced; no SQL CHECK on category                                   |
| 3   | Low/Medium/High/Critical                 | ✅         | Constants + SQL CHECK + UI meta                                                                                                                   |
| 4   | Routes to submitter's department manager | ⚠️ PARTIAL | **Org-scoped, not department-scoped** — alerts ALL org managers (`incident.service.ts:71-78,128`); `department` stored but never used for routing |

## SPEC 10 — Incident Details, Photo, Location

| #   | Item                                             | Verdict    | Evidence / notes                                                                                                               |
| --- | ------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 5   | Description field                                | ✅         | Required, `@Length(1,5000)`, NOT NULL                                                                                          |
| 6   | Photo optional                                   | ✅         | Submit first, attach `if (photo)` (`ReportIncidentDetailsScreen.tsx:105-118`)                                                  |
| 7   | Take photo AND upload existing                   | ✅         | `launchCamera` + `launchImageLibrary` (`:40-57`)                                                                               |
| 8   | Safe/lawful warning                              | ✅         | Alert + card subtitle (`:61,199`)                                                                                              |
| 9   | Location via permission or manual site selection | ⚠️ PARTIAL | GPS + reverse-geocode ✅ (`:68-82`); **no manual site picker** for the permission-denied case                                  |
| 10  | Photos stored securely, restricted               | ✅         | Full E2EE: encrypted upload, opaque `storage_key`, per-recipient sealed keys (`incident_attachment_keys`), RLS deny-by-default |

## SPEC 11 — Incident Submitted

| #   | Item                                  | Verdict    | Evidence / notes                                                                                                                      |
| --- | ------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 11  | Ref ID immediate, INC-YYYY-NNNNN      | ✅         | Stamped in the INSERT txn (`incident.service.ts:109`); UNIQUE + sequence                                                              |
| 12  | Initial status Submitted              | ✅         | DB default + initial event row                                                                                                        |
| 13  | Push AND in-app alert to manager      | ⚠️ PARTIAL | Push ✅ (metadata-only FCM to all org managers, best-effort). **No persistent in-app notification/inbox** — "in-app" = queue refresh  |
| 14  | Detail never posted to public channel | ✅         | No channel/message insert on submit (`:96-131`)                                                                                       |
| 15  | Audit log on submission               | ⚠️ PARTIAL | `incident_events` 'submitted' row ✅, but **no `org_audit_log` entry** — inconsistent with status/assign/note actions which all audit |

## SPEC 12 — Manager Incident Queue

| #   | Item                                                        | Verdict    | Evidence / notes                                                                                                         |
| --- | ----------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| 16  | Restricted queue; member → 403                              | ✅         | `OrgManagerGuard` → `org_manager_access_required` (403); Bravo admin via separate `/ops/deptchat/incidents` (AdminGuard) |
| 17  | Critical/High sorted above                                  | ✅         | `ORDER BY CASE severity …` (`incident.service.ts:158-161`)                                                               |
| 18  | Filters: status/severity/category/date/submitter/department | ⚠️ PARTIAL | API: 4 of 6 (**date + department missing**); mobile UI exposes severity only                                             |
| 19  | Concise previews                                            | ✅         | Ref, category, severity/status tags, relative time                                                                       |

## SPEC 13 — Incident Detail and Status Workflow

| #   | Item                               | Verdict            | Evidence / notes                                                                                                                                                    |
| --- | ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20  | Exact 6-state lifecycle            | ✅                 | `incident-fsm.ts:23-33` — submitted→received→under_review→action_assigned→resolved→closed (+ rework + reopen)                                                       |
| 21  | Updates record user/timestamp/note | ✅                 | `incident_events(actor_id, from, to, note)` on every transition                                                                                                     |
| 22  | Original report immutable          | ✅ (by convention) | No edit paths exist; not DB-trigger-enforced                                                                                                                        |
| 23  | Internal notes hidden from members | ✅                 | Member detail screen built from `mine()` list param, never calls manager endpoint. Minor: `mine()` is `SELECT *` so `assigned_to` rides the payload (not displayed) |
| 24  | Company admin can reopen closed    | ✅                 | FSM actor gate `company_admin` only; delegated manager gets 403                                                                                                     |
| 25  | Assign-to workflow                 | ✅                 | Validated assign + timeline event + audit + UI picker ("Assign to me")                                                                                              |

## SPEC 14/15 — Roles, permissions, acceptance criteria

- **Roles:** Member / manager / company / Bravo-admin separation enforced server-side (`OrgManagerGuard`, `DeptChatAccessGuard`, `AdminGuard`). **No department-manager tier** — see gap #3.
- **Permission prompts:** camera only for attendance verify + incident photo; location single-shot at action time; no background tracking anywhere. ✅
- **Compliance wording:** no "tracking"/"surveillance" wording (swept in Step 16). ✅
- **QA Retest Checklist (page 17):** no-shift blocks check-in ✅ · location denied → Pending Review not Absent ✅ · face failure → Pending Review with admin-visible reason ✅ (but camera-denied mislabels, gap #7) · member can't view others' attendance ✅ · member 403 on incident queue ✅ · photo skippable ✅ · gallery upload via system picker ✅ · manager push on new incident ✅ (in-app inbox missing) · export logs admin/date/format ✅ (member filter not logged).

---

## Gap list, ranked

### Product decisions — ✅ ALL BUILT 2026-07-02 (owner sign-off given)

1. ~~**Face verification is a camera-permission check.**~~ **BUILT** — `VerifyAttendanceScreen` now renders a live front-camera preview (`expo-camera` CameraView), captures one frame on confirm, and runs **on-device MLKit face detection** (`@react-native-ml-kit/face-detection`, new native dep — Android build verified green). `faceCheck.ts` enforces the biometric stop-conditions: frame never leaves the device, deleted immediately (pass/fail/crash — unit-tested), scalar-only metadata. Degrades to capture-presence mode if the native module is absent, and to Pending Review (`camera_unavailable`) on camera denial. Still face _presence_, NOT 1:1 identity matching (that stays gated on separate legal sign-off). ⚠️ Device smoke of the camera flow still pending — needs a rebuilt APK on hardware.
2. ~~**PDF export doesn't exist.**~~ **BUILT** — ops-console dept-attendance page has an "Export PDF" button: client-side print-formatted report (org, range, generated-at, full table) from the same audited CSV endpoint; browser Save-as-PDF. No new dependency; server audit row unchanged.
3. ~~**"Department-level" is org-level.**~~ **BUILT** — `org_members.department` (migration applied): `OrgManagerGuard` carries the scope; a department-scoped manager's attendance summary/queue/export and incident queue/detail are FORCED to their department; incident push routes to that department's managers + org-wide managers only. Company account and unscoped managers see the whole org (unchanged).
4. ~~**Check-out has no face verification.**~~ **BUILT** — verified check-out goes through the same Verify screen (face + location); server `deriveCheckOut` (pure, tested) flags failures Pending Review with the same reason set; legacy clients keep the plain geotag path. Check-out now also gets the result screen ("Checked Out").
5. ~~**Admin filters.**~~ **BUILT** — attendance: date presets + department chips on `AdminAttendanceScreen`, department/shift_id server-side on summary/pending/export (+ all filters recorded in the export audit metadata); incidents: date + department filters server-side, status filter row added to `IncidentQueueScreen` (severity row already existed).
6. ~~**No attendance dispute route.**~~ **BUILT** — `POST /attendance/sessions/:id/dispute` (own, closed, non-pending records; `disputed` reason + `dispute_note`, audited) + a Dispute action per row on `MyAttendanceScreen` with a note modal. Manager clears it via the normal review flow.

### Wiring bugs — ✅ ALL FIXED 2026-07-02

7. ~~**`camera_unavailable` dead end-to-end**~~ **FIXED** — `face_unavailable` added to `ClockInDto` (with a whitelist-ValidationPipe regression test), `VerifyAttendanceScreen` sends it on camera denial, `camera_unavailable` label added to `reviewReasonLabel`.
8. ~~**Review notes UI missing**~~ **FIXED** — approve/reject on `AdminAttendanceScreen` now collects optional notes via a modal (Alert.prompt is iOS-only) and passes them to `reviewSession`.
9. ~~**CPO "Dept" tab not flag-gated**~~ **FIXED** — `CpoNavigator` CpoDept tab now renders only when `DEPT_CHAT_V2` is on, matching the agent-dashboard row and On-Duty home card.

Gates: auth-service 36/36 attendance specs + tsc clean; mobile app-project Jest 160 green (incl. `cpoCapability` source scan); lint clean; zero new tsc errors in changed files.

### Audit / immutability soft spots — ✅ FIXED 2026-07-02

10. ~~No audit on incident submit / shift create/assign/edit~~ **FIXED** — `incident.submit` (category/severity only, narrative never logged), `attendance.shift.create/assign/edit/update/archive` all write `org_audit_log` rows.
11. ~~`editShift` overwrites captured clock times~~ **FIXED** — `editShift` is now transactional and records the ORIGINAL `clock_in_at`/`clock_out_at` (before/after + reason) in the audit metadata, so the pre-edit capture is always recoverable.

### Cosmetic / UX partials — ✅ mostly closed 2026-07-02

12. ~~Announcement card empty~~ **FIXED** — `seedOrgWorkspace` now seeds a board/read_only "Announcements" channel (all members as viewers).
13. "Device trusted" indicator is static text — **left as-is** (cosmetic; E2EE is always on).
14. ~~My Attendance flat list~~ **FIXED** — month-grouped sections, day labels, and the full review outcome per row (pending reason / approved / rejected).
15. ~~No manual site picker~~ **FIXED** — GPS-denied path offers a manual site text entry (`location_label`).
16. Manager "in-app alert" = push + badge counts + queue — **left as-is** (a persistent notification inbox is a separate feature; push + dashboard tiles satisfy the alerting intent).
17. ~~Shift management lacks edit/delete~~ **FIXED** — `PATCH /attendance/shifts/:id` + `DELETE` (archive, soft) with audited before/after; `ShiftEditorScreen` edit mode + per-row edit/archive actions.
18. ~~No check-out result screen~~ **FIXED** — check-out flows through Verify → `AttendanceResult` (mode-aware).
