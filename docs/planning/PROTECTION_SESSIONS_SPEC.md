# Bravo Secure — Protection & Surveillance Module (Protection Sessions)

> **Build spec, 2026-08-10.** Written for the implementing session (Opus). Read this whole
> document before writing code. This spec maps the founder's product brief onto the EXISTING
> codebase — most of the hard substrate already exists and MUST be reused, not re-invented.
> Follow `LOOP.md`, `CLAUDE.md`, and `DESIGN_REVIEW_LOOP.md` as always; §14 lists the repo
> gotchas that have burned previous sessions.

---

## 0. One-paragraph summary

A Pro customer (3-month protection plan) can press **Request Protection** at any moment while
their plan is active. That creates a **protection session** — a bounded, consent-gated live
window during which the customer's phone streams location to the backend and the customer's
**ops-assigned dedicated CPO** (no acceptance step — the CPO was assigned by Ops when the plan
activated) monitors them on a live map, with SOS escalation and an Ops monitoring console.
Tracking exists ONLY inside a session. Backend is the single source of truth for session state.

---

## 1. What already exists — REUSE MAP (do not build parallel systems)

| Product concept                                            | Existing implementation                                                                                                                                                                                                                                                                                                                                                 | Verdict                                                                                                                                                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3-month Protection Plan (Pending/Active/Expired/Cancelled) | **Bravo Secure Pro** — `pro_applications` (FSM `PENDING_PROPOSAL → PROPOSAL_CREATED ⇄ REVISION_REQUESTED → ACCEPTED → ACTIVE`, `EXPIRED`, `REJECTED`; lazy expiry sweep; `covered_until` derivation (B-383); renew; family members) in `apps/auth-service/src/pro-applications/`                                                                                        | **REUSE AS-IS.** Plan purchase/activation is DONE. Map UI labels: `PENDING_PROPOSAL..ACCEPTED`→"Pending", `ACTIVE`→"Active", `EXPIRED`→"Expired", `REJECTED`+client cancel→"Cancelled". |
| Ops assigns CPO, no acceptance step                        | `pro_cpo_assignments` (date-windowed, gist no-overlap, PMC mission codes) + **B-415** dedicated-officer routing in `apps/auth-service/src/pro-management/`                                                                                                                                                                                                              | **REUSE AS-IS.** The "assigned CPO" for a session = the `ASSIGNED` row for this application whose window covers today.                                                                  |
| Scheduled protection dates (calendar)                      | `pro_plan_missions` (REQUESTED→SCHEDULED, B-415 auto-schedule)                                                                                                                                                                                                                                                                                                          | **KEEP, separate concern.** Sessions are on-demand and orthogonal to scheduled dates. Do not merge the two.                                                                             |
| Location ingest + fetch                                    | `apps/auth-service/src/telemetry/` — `POST /telemetry/:bookingId/ping` (CPO), `POST /telemetry/:bookingId/client-ping` (customer!), `GET :bookingId/latest                                                                                                                                                                                                              | recent`                                                                                                                                                                                 | **PATTERN TO MIRROR.** Booking-scoped today; add session-scoped endpoints in the new module (do NOT overload bookingId routes). Copy its guard/validation shape — incl. the `$2::uuid` cast lesson in `telemetry.controller.ts` history. |
| Mobile location plumbing                                   | `src/utils/locationPermission.ts`, `src/hooks/useLocation.ts`, `src/screens/vbg/useVbgLocation.ts`, `src/services/vbgTelemetry.ts`, `src/screens/liveops/LiveTrackingScreen.tsx` (already calls `client-ping`), `src/screens/cpo/useLeadTelemetry.ts`                                                                                                                   | **REUSE.** Permission helper + watch pattern exist. Audit `useVbgLocation`/`vbgTelemetry` first and extract a shared session-location service rather than writing a fourth copy.        |
| Realtime fan-out                                           | `MissionEventsService` (`apps/auth-service/src/ops/mission-events.service.ts`) → messenger-service WS gateway **re-emits ANY event name to room `mission:<id>`**. Mobile consumes via `subscribeMission` + frame listener (see `src/screens/securepro/useProAppRealtime.ts` — copy this hook shape). Ops console has no push — SWR polling @2s is the accepted pattern. | **REUSE.** Room key = protection session id. No new gateway code needed.                                                                                                                |
| SOS                                                        | `apps/auth-service/src/sos/` — `sos_events` table, `POST /sos/raise`, `:id/cancel`, `:id/status`, ack/escalate/resolve lifecycle, ops console `/sos` page. Learn from "Issue 44" in `sos.service.ts` (an SOS must carry its parent context id).                                                                                                                         | **EXTEND** with `protection_session_id` column + session-aware raise path. Do NOT fork a second SOS system.                                                                             |
| Push notifications                                         | `BookingPushBridge` (`apps/auth-service/src/ops/booking-push-bridge.service.ts`) — ids-only payload posture; mobile `serverWakeNotifications.ts` + `fcmBootstrap.ts` tap routes. **Kinds must be ENUMERATED `kind === '…'` branches — `startsWith` fails the `serverWakeTapRouting` static parity scan** (caught live before).                                          | **EXTEND** with the §10 kinds.                                                                                                                                                          |
| Live map UI                                                | Mapbox WebView maps (client `LiveTrackingScreen`, agent tracker, VBG maps; ops console `app/live/[id]/page.tsx` uses `mapbox-gl`). Native-SDK migration is deferred repo-wide.                                                                                                                                                                                          | **REUSE** the WebView map components/patterns.                                                                                                                                          |
| Idempotency                                                | `IdempotencyInterceptor` (used by `pro-applications` activate)                                                                                                                                                                                                                                                                                                          | **USE** on session create / end / SOS raise.                                                                                                                                            |
| Ops audit                                                  | `OpsAuditService.recordAdmin`                                                                                                                                                                                                                                                                                                                                           | **USE** for every ops action + location-history access.                                                                                                                                 |
| Client screens shell                                       | `src/screens/pro/ProDashboardScreen.tsx` (module grid), `ProLiveMissionScreen.tsx` (**wireframe — rebuild as the session screen**), `ProAssignedTeamScreen.tsx` (live since B-415)                                                                                                                                                                                      | Rebuild `ProLiveMission` as the live session screen; add the request flow to the dashboard.                                                                                             |
| CPO screens shell                                          | `src/screens/cpo/CpoProMissionScreen.tsx` (PMC-code-gated briefing)                                                                                                                                                                                                                                                                                                     | Keep the code gate as entry; add the sessions dashboard + active-session map screen behind it.                                                                                          |

**The genuinely NEW pieces:** the `protection_sessions` + `protection_session_locations` (+
audit) tables, the session FSM service/controller, session-scoped location endpoints, the three
session UIs (customer live screen, CPO dashboard/active screen, ops Protection Monitoring page),
and the notification kinds.

---

## 2. Data model (new migration, `supabase/migrations/` — apply via direct SQL, NEVER `supabase db push`, see §14)

```sql
CREATE TABLE public.protection_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES public.pro_applications(id),
  customer_id     uuid NOT NULL,               -- requester (owner or active linked member)
  cpo_user_id     uuid NOT NULL,               -- pinned at creation from the covering pro_cpo_assignment
  assignment_id   uuid NOT NULL REFERENCES public.pro_cpo_assignments(id),
  status          text NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN ('REQUESTED','ACTIVE','ENDING','COMPLETED','ABORTED')),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  activated_at    timestamptz,
  ended_at        timestamptz,
  end_reason      text,                        -- 'customer' | 'ops' | 'timeout' | 'failed_activation'
  last_fix_at     timestamptz,                 -- server receive time of newest location
  sos_active      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Business rule 1 + edge cases C/M/N, race-proof in the DB (repo pattern:
-- mission_crew_agent_active_uq / pro_cpo_assignments_no_overlap):
CREATE UNIQUE INDEX protection_sessions_one_live_uq
  ON public.protection_sessions (customer_id)
  WHERE status IN ('REQUESTED','ACTIVE','ENDING');
CREATE INDEX protection_sessions_cpo_idx  ON public.protection_sessions (cpo_user_id, status);
CREATE INDEX protection_sessions_app_idx  ON public.protection_sessions (application_id, created_at DESC);

CREATE TABLE public.protection_session_locations (
  id           bigserial PRIMARY KEY,
  session_id   uuid NOT NULL REFERENCES public.protection_sessions(id) ON DELETE CASCADE,
  customer_id  uuid NOT NULL,                  -- denormalized on purpose (§9: never mix customers)
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  accuracy_m   real,
  recorded_at  timestamptz NOT NULL,           -- device clock (informational)
  received_at  timestamptz NOT NULL DEFAULT now()  -- SERVER clock — ALL staleness math uses this
);
CREATE INDEX psl_session_idx ON public.protection_session_locations (session_id, received_at DESC);

-- CPO/Ops access audit (§9): who looked at whose location history, when.
CREATE TABLE public.protection_access_audit (
  id          bigserial PRIMARY KEY,
  actor_id    uuid NOT NULL,
  actor_role  text NOT NULL,                   -- 'cpo' | 'ops'
  session_id  uuid NOT NULL,
  action      text NOT NULL,                   -- 'view_live' | 'view_history' | 'export'
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sos_events ADD COLUMN IF NOT EXISTS protection_session_id uuid;

ALTER TABLE public.protection_sessions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.protection_session_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.protection_access_audit      ENABLE ROW LEVEL SECURITY;
-- Repo norm: backend service-role access only; RLS on, no anon policies.
```

Retention (§9 / rule "location-data retention"): a lazy sweep (same pattern as
`sweepAssignments`) deletes `protection_session_locations` rows older than
**30 days** (constant `LOCATION_RETENTION_DAYS`, single definition). Sessions and the audit
table are kept (history without coordinates beyond the horizon).

---

## 3. Session FSM (backend authoritative — business rule 8)

```
            create (customer)                    first accepted fix OR explicit /activate ack
AVAILABLE ────────────────────► REQUESTED ──────────────────────────────► ACTIVE
(no row — plan active,             │  creation validated + row inserted        │
 no live row for customer)         │                                           │ customer End (K) → ENDING → COMPLETED
                                   │ activation failure /                      │ ops end            → ENDING → COMPLETED
                                   │ 10-min no-fix timeout                     │ 12h max-duration   → ENDING → COMPLETED (end_reason 'timeout', ops alert)
                                   ▼
                                ABORTED (end_reason 'failed_activation')
```

- `AVAILABLE` is **not a row** — it is the absence of a live row while the plan is ACTIVE.
- **Create** (`REQUESTED`) validates, in order: plan ACTIVE (`assertPlanAccess` — owner OR
  active linked member, reuse from `pro-applications.service.ts`), a covering
  `pro_cpo_assignments` row for _today_ (else `409 no_cpo_assigned` + ops alert), then INSERT.
  A unique-index violation (23505 on `protection_sessions_one_live_uq`) → return the EXISTING
  live session with `already_active: true` (edge cases C and M — opening, not erroring).
- **ACTIVE** on the first accepted location fix (proof the stream works) — never on optimism.
  The client shows "Starting protection…" until the backend confirms ACTIVE (edge N).
- **ENDING** is transient and idempotent: repeated end calls are no-ops. `COMPLETED` stamps
  `ended_at`, stops accepting fixes (`410 session_ended` to any straggler ping).
- **SOS interaction (rule 12 / §7):** while `sos_active = true`, the customer **End
  Protection** action requires an extra typed confirmation and does NOT resolve the SOS —
  the SOS stays live and linked; only the SOS lifecycle (ack/resolve/cancel, existing `sos`
  module) closes it. Ending a session never cascades to its SOS.
- **Plan expiry during a session (edge B):** the expiry sweep must NOT touch live sessions.
  When the sweep flips a plan to EXPIRED, it checks for a live session; if one exists it
  emits ops alert `plan_expired_session_live` and leaves the session running. New session
  _creation_ on an expired plan is refused as normal.
- **Reassignment during a session (edge J):** `cpo_user_id` is pinned at creation. Ops
  cancelling/changing the covering assignment while a session is live does NOT touch the
  session; the ops console shows an **assignment conflict** banner on that session, and a
  dedicated `POST /ops/protection/sessions/:id/transfer {new_cpo_user_id}` (SUPERVISOR/ADMIN,
  audited, notifies both CPOs + customer) is the ONLY way responsibility moves.

---

## 4. API surface (auth-service; new module `apps/auth-service/src/protection/`)

### Customer (`JwtAuthGuard`, self-access only via `assertPlanAccess`)

| Route                                                | Behavior                                                                                                                                                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /protection/sessions` (IdempotencyInterceptor) | Create → `REQUESTED` (or existing live session, `already_active`). Response includes session + CPO identity (name/callsign/avatar — never the PMC code).                                                 |
| `GET /protection/sessions/current`                   | The live session (or 404 `no_active_session`). Includes status, CPO, `sos_active`, server time.                                                                                                          |
| `POST /protection/sessions/:id/locations`            | Batch of fixes `[{lat,lng,accuracy_m,recorded_at}]` (batching = offline catch-up, edge E). Validates session live + owner. First accepted fix flips REQUESTED→ACTIVE. Updates `last_fix_at`. Broadcasts. |
| `POST /protection/sessions/:id/end` (Idempotency)    | ENDING→COMPLETED, `end_reason:'customer'`.                                                                                                                                                               |
| `GET /protection/sessions?limit=`                    | Customer's session history (times, CPO, SOS flag — no coordinates).                                                                                                                                      |
| `POST /sos/raise` (existing)                         | Extended: when the caller has a live protection session, stamp `protection_session_id` + snapshot last known location into the SOS row.                                                                  |

### CPO (`CpoSessionGuard` — same guard as `/agents/me/pro-mission-code`)

| Route                                                     | Behavior                                                                                                                                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /agents/me/protection/overview`                      | Assigned customers (from live `pro_cpo_assignments` windows) + any live sessions: status, `last_fix_at` age, duration, `sos_active`, connection state (§6). **Scoped to `cpo_user_id = caller` — a CPO can never query another CPO's customers (§9).** |
| `GET /agents/me/protection/sessions/:id`                  | Full live view: customer info, latest fix + age, history tail for the map trail. Writes `protection_access_audit`. 403 unless `session.cpo_user_id = caller`.                                                                                          |
| `GET /agents/me/protection/sessions/:id/locations?since=` | Poll-fallback for the trail (WS is primary). Audited.                                                                                                                                                                                                  |
| `POST /agents/me/protection/sessions/:id/incident`        | File an incident note against the session (reuse `incident` module if its shape fits; else a `note` column table).                                                                                                                                     |

### Ops (`JwtAuthGuard, CsrfGuard, AdminGuard`; mutations `@RequireRoles('SUPERVISOR','ADMIN')` + `OpsAuditService`)

| Route                                        | Behavior                                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /ops/protection/sessions?status=`       | Monitoring list (§8).                                                                                                                                         |
| `GET /ops/protection/sessions/:id`           | Detail incl. location trail (audited).                                                                                                                        |
| `POST /ops/protection/sessions/:id/end`      | Ops end (`end_reason:'ops'`, reason text required — `ConfirmReasonModal` exists in the console).                                                              |
| `POST /ops/protection/sessions/:id/transfer` | Edge J explicit transfer.                                                                                                                                     |
| CPO management                               | Already exists under `/ops/pro-management` (pool, assignments, DEDICATED) — link, don't duplicate. Add `live_sessions` count to the pool/workload projection. |

**Session events** broadcast via `MissionEventsService.broadcast(sessionId, event, payload)` —
room `mission:<sessionId>`; ids-only payloads (opaque posture): `psession.status`,
`psession.location` (lat/lng/ts to the room — the room is only joinable by authenticated
participants; verify gateway room-join authorization covers this or gate CPO map data behind
the REST poll + WS as trigger-to-refetch, the `useProAppRealtime` pattern), `psession.sos`.

---

## 5. Customer app flow

**Plan screen** (`ProDashboardScreen` + `SecureProStatusScreen` already show plan state,
dates, `covered_until`): add the **assigned CPO** (from `GET /pro-applications/:id/team` —
built in B-415) and sessions used / history (new `GET /protection/sessions`).

**Request Protection** (new prominent card on `ProDashboardScreen`, ACTIVE plans only):

1. Tap → consent sheet: _"Your live location will be shared with your protection officer
   {name} for the duration of this session only."_ — explicit consent every session
   (rule 13).
2. Permission via `src/utils/locationPermission.ts` (fine/foreground; edge G: if denied,
   the actionable settings-instructions state — never bypass, never start).
3. `POST /protection/sessions` → navigate to the session screen in "Starting protection…"
   state; stream fixes; backend flip to ACTIVE is what renders **Protection Active**
   (edge N: no local active state without a backend session — mirror the wallet/activate
   "backend txn first" discipline).

**Live session screen** (rebuild `src/screens/pro/ProLiveMissionScreen.tsx` — currently a
wireframe): Protection Active banner + duration ticker (from server `activated_at`), CPO
identity card, own-position map (reuse the LiveTracking WebView map), live-location status
("Sharing live · last sent Xs ago" / "Connection lost — retrying" edge E), **SOS button**
(reuse the existing SOS raise flow + persistent-dock pattern from the tracker, B-408), **End
Protection** with confirm (edge K), extra typed confirm while SOS active (§3).

**Streaming**: extract a `protectionLocationService` from the `useVbgLocation`/`vbgTelemetry`
pattern — watch position (~10s / 25m), batch + retry queue for offline (edge E), stop ONLY on
session end. **App closed/killed (edge D/L): the backend session stays live regardless of the
device.** For the client device, in-app foreground streaming is the v1 contract; an Android
foreground-service location stream (the app already ships FGS types for calls/missions) is a
**founder decision** (§13) — do NOT silently add background collection. When the app is not
streaming, the CPO/Ops truthful-staleness UI (§6) is the designed behavior, not a bug.

**States on reopen**: `GET /protection/sessions/current` on dashboard focus — if a live
session exists, surface "Protection Active — return to session" (edge C/M UX).

## 6. CPO app flow

Entry stays behind the existing **PMC code gate** (`CpoProMissionScreen`) — the code was
issued at assignment; there is no acceptance step anywhere. Add to the unlocked view:

- **Protection dashboard section**: assigned customers (name, avatar, window), per-customer
  session state: `No active session` / `ACTIVE · 00:42:13 · last fix 12s ago · SOS?` +
  connection pill.
- **Active session screen**: customer card, Mapbox WebView live map (marker + recent trail),
  **"Last updated Xs ago" computed from server `received_at` vs server `now` — never the
  device clock** (clock-drift burned the group-call "stale" investigation; both timestamps
  come from the same server), staleness ladder: `<45s` LIVE (green) · `45s–3m` DELAYED
  (amber, "Last update Xs ago") · `>3m` **"Location unavailable — last update X min ago"**
  (red, marker greyed; never a live-looking stale marker — rule 9), session duration, SOS
  banner (acknowledge via existing SOS lifecycle), incident note, connection status.
- Realtime: subscribe to `mission:<sessionId>` (the `useProAppRealtime` hook shape) + 5s
  poll fallback. Wake path: push kind `psession-*` (§10) → tap route to the session screen.
- Edge I (device change): nothing special — state is server-side; a fresh login sees the same
  overview. Verify the session-token single-device rules (`signal_device_id` machinery) don't
  fight this — the CPO endpoints are plain JWT REST, so they shouldn't.
- Edge H (CPO offline): sessions never depend on CPO liveness. CPO "online" = WS presence
  or recent overview poll; when offline >2 min with a live session → ops alert
  `cpo_offline_session_live`. No silent transfer (only §3 edge-J transfer).

## 7. SOS specifics

Reuse `sos` module end-to-end. Delta: session linkage (§2 column), location snapshot at raise,
fan-out adds the session's CPO push + `psession.sos` room event + ops alert. SOS lifecycle
states already exist (raise/ack/escalate/resolve/cancel + `/sos` console page) — map the
brief's `Triggered/Acknowledged/In Progress/Resolved/Cancelled` onto them rather than adding
new states. Rule 12: the SOS row keeps `protection_session_id` forever; §3 protects it from
session-end cascades.

## 8. Ops console — new `/protection` page (`apps/ops-console/src/app/protection/page.tsx`)

- **Active sessions table** (SWR 2s): customer, CPO (+offline badge), start, duration,
  last-fix age with §6 staleness colors, connection, SOS pill, status; row → detail with
  `mapbox-gl` map (copy `app/live/[id]/page.tsx` patterns), trail, event timeline, END
  (ConfirmReasonModal) and TRANSFER actions.
- **Alerts strip** (from §10 ops kinds): expired-plan-during-session, CPO offline,
  location-silent >configured period, assignment conflict.
- **Customer detail**: plan + assignment (links into existing `/pro-applications/[id]` and
  `/pro-management`), session history, SOS history, incidents.
- **CPO workload**: extend the existing pro-management pool projection with live-session
  counts.
- Design system: obsidian `#07090D` / cobalt `#5B8DEF` tokens — G8, no legacy navy.

## 9. Security & privacy (CLAUDE.md stop-conditions apply)

- Access separation is enforced **in SQL WHERE clauses, not UI**: customer → own rows only
  (`customer_id = caller` / plan access); CPO → `cpo_user_id = caller`; Ops → AdminGuard +
  role. Add a spec test per denial path (foreign customer 403/404, foreign CPO 403).
- Every location row carries `customer_id + session_id + timestamps` (§2) — never queryable
  across customers except by Ops.
- **Never log coordinates** in server or client logs — treat lat/lng like key material
  (extend the `logAudit` posture; add a static scan asserting no `console.*` of
  lat/lng/fix objects in the new modules).
- CPO/Ops reads of live/history data write `protection_access_audit` (§2); ops mutations go
  through `OpsAuditService.recordAdmin`.
- Transport is TLS via the existing sslip.io endpoints; WS auth is the existing gateway
  admission. No new crypto is introduced — if tempted to add any, that's an architecture-doc
  stop-condition.
- Retention sweep per §2. Session history (sans coordinates) is permanent.

## 10. Notifications (BookingPushBridge — ids-only payloads; ENUMERATED kinds)

| Audience                                            | Kind                                               | Trigger                                                                              |
| --------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Customer                                            | `psession-started`                                 | REQUESTED→ACTIVE                                                                     |
| Customer                                            | `psession-ended`                                   | COMPLETED (by anyone; tells which)                                                   |
| Customer                                            | `pro-cpo-changed`                                  | assignment create/cancel/transfer                                                    |
| CPO                                                 | `psession-new`                                     | session created for their customer (the "automatic receive")                         |
| CPO                                                 | `psession-sos`                                     | SOS raised on their session                                                          |
| CPO                                                 | `psession-conn-lost`                               | customer silent > threshold                                                          |
| CPO                                                 | `psession-ended`                                   | session completed                                                                    |
| Ops (console alerts, not push — no ops push exists) | rows in an `ops_alerts` feed or reuse audit events | request created, SOS, CPO offline, location silent, expired-during-session, conflict |

Idempotency: one notification per state transition — key on `(session_id, kind, transition)`
via the existing push-bridge dedupe posture; threshold-based kinds (`conn-lost`) latch once
per outage, reset on recovery. **Mobile side: every kind gets an explicit `kind === '…'`
branch in `serverWakeNotifications.ts` AND a tap route in `fcmBootstrap.ts` — the
`serverWakeTapRouting` static parity scan fails otherwise.**

## 11. Edge-case → mechanism index (A–N from the brief)

| #   | Case                     | Mechanism (section)                                                                                                            |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| A   | No active subscription   | Create-time plan check → 409 `plan_not_active`; UI paywall/renew (§3, §5)                                                      |
| B   | Plan expires mid-session | Sweep never touches live sessions; ops alert (§3)                                                                              |
| C   | Double request           | DB unique index → return existing session (§3)                                                                                 |
| D   | App closed               | Backend session persists; end only via §3 exits (§5)                                                                           |
| E   | Customer offline         | Batch+retry queue; truthful staleness on CPO side; auto-resume (§5, §6)                                                        |
| F   | GPS unavailable          | No fixes sent; staleness ladder renders "Location unavailable"; never stale-as-live (§6)                                       |
| G   | Permission denied        | Blocked start + settings instructions; no bypass (§5)                                                                          |
| H   | CPO offline              | Session unaffected; ops alert; no silent transfer (§6)                                                                         |
| I   | CPO device change        | Server-side state; new login sees sessions (§6)                                                                                |
| J   | Reassignment             | Pinned `cpo_user_id`; conflict surfaced; explicit `/transfer` only (§3)                                                        |
| K   | Customer ends            | Confirm → ENDING→COMPLETED → stop sharing, notify CPO+Ops (§3, §4)                                                             |
| L   | Force close/logout       | Same as D; CPO/Ops see last-known status (§6)                                                                                  |
| M   | Multi-device duplicate   | Same unique index as C; second device opens existing (§3)                                                                      |
| N   | Backend failure          | ACTIVE only after backend-confirmed session + first fix; failure UI "We couldn't start protection. Please try again." (§3, §5) |

## 12. Test contract (the repo's bar — a feature is not done until tests pin it)

- **Red-first** for every new service rule (write the failing spec, then implement —
  mutation-prove at least the FSM guards and the unique-index 23505 handler).
- auth-service specs (the `q/qOne` regex-mock pattern used by
  `pro-applications.service.spec.ts` / `pro-management.dedicated.spec.ts`): create-validations
  (plan gate, covering-assignment gate, 23505→existing), activation-on-first-fix, end
  idempotency, SOS-vs-end isolation, expiry-sweep skip + alert, transfer-only reassignment,
  access denials (foreign customer/CPO), retention sweep SQL, staleness fields
  (`received_at` server-stamped).
- Mobile: screen tests where mountable; static scans for the banned patterns (§14) — comment-
  strip before ordering/absence assertions, `\r?\n` (CRLF!), anchor the DECISION SITE.
- Notification parity: extend the existing `serverWakeTapRouting` scan coverage to the new
  kinds.
- Gates before done: targeted suites → full auth-service suite → `npx jest --selectProjects
app --testPathPattern <new screens>` → `npm run typecheck` (baseline ≤ 47, currently 43) →
  ops-console `npm run typecheck` → device pass per §5/§6 golden + one error path each
  (offline, permission-denied, double-tap).
- Staging E2E: the OTP_DEV_BYPASS throwaway-account pattern (see
  `project_securepro_applications` memory / scratchpad `proapp-e2e.mjs` pattern) — script:
  register throwaway → (ops fixtures via temp admin row) → activate plan → assign CPO →
  request session → post fixes → assert ACTIVE + CPO overview shows it → SOS → end. Use
  throwaway accounts, never real users' credentials.

## 13. Founder decisions needed before/while building (defaults proposed)

1. **Background location on the customer device** — v1 = foreground-app streaming only
   (default), or Android location-FGS so streaming survives app-switch? (iOS "Always"
   permission is a store-review commitment — recommend v1 foreground, FGS fast-follow.)
2. **Session caps** — max duration default **12h** auto-end with ops alert; no-fix activation
   timeout default **10 min**; connection-lost threshold **3 min**; ops "location silent"
   alert **10 min**. Confirm numbers.
3. **Location retention** — default **30 days** of coordinates.
4. **Sessions quota** — plans currently have no per-month session limit; unlimited during
   coverage (default) or metered?
5. **Family members** — can an active linked member start their own session against the
   owner's plan (assertPlanAccess allows it today for mission requests)? Default: yes, but
   the session is theirs alone (their location only).

## 14. Repo gotchas the implementing session MUST respect (each has burned a session)

- `CLAUDE.md` is law: read `LOOP.md` first; security stop-conditions; never weaken guards.
- **Mobile**: `Alert` only from `@utils/alert` (B-88) · keyboard insets ONLY via
  `useKeyboardLayout`/`bottomPad` (B-184, contract scan enforces) · **no reanimated**
  (worklets babel absent) · axios responses need `.data` (`authHttp.get(...)` returns
  AxiosResponse) · UTC formatting via `@utils/datetime` · obsidian design tokens, no navy ·
  push kinds enumerated (§10) · foldables use `useContentWidth`.
- **Server**: no backticks-in-comments inside SQL template literals (terminates the string)
  · psql `$n` gets ONE type — don't `::uuid`-pin a param you also compare as text ·
  `IdempotencyInterceptor` for money/state creation endpoints.
- **Tests**: static scans — strip comments, CRLF `\r?\n`, anchor the decision site,
  `(public\.)?` on table names · `test:crypto` flake rule (run twice) if messenger tests get
  touched · verify a mutation actually applied before trusting a green.
- **Migrations**: file in `supabase/migrations/`, apply to Supabase via **direct SQL** (psql
  in the box's pg container against the auth container's `DATABASE_URL`) — `supabase db push`
  causes ledger drift/79-migration replay.
- **Deploy**: commit+push FIRST, then `scripts/deploy-staging.sh` semantics (B-376 stale
  guard; no rsync on the Windows box → tar-pipe the changed paths; build gates deploy;
  feature-route probes — remember POST-only routes 404 on GET probes; **refresh the watchdog
  pristine snapshot after every green deploy** or self-heal reverts you in ≤5 min). Mobile
  needs `scripts/release-apk.ps1` (NODE_ENV=production; ~13 min; verify the baked
  `auth.94-136-184-52.sslip.io` URL in the bundle; Firebase upload needs
  `FIREBASE_SERVICE_ACCOUNT`).
- **Process**: self-diff every change hunting consumer regressions (founder standing rule —
  enumerate live consumers of anything you delete/move); critic pass after each phase;
  sqa.md bug numbering (claim the next free B-number by pushing the sqa.md edit first);
  sync `docs/planning/BUILD_RUNBOOK.md` with every change.

## 15. Suggested build order (each phase lands green + deployable on its own)

1. **Migration + session service/controller + specs** (FSM, gates, unique index, retention
   sweep) — deployable dark, no UI.
2. **Location ingest + fetch + staleness fields + WS broadcasts** — probe-able with curl/E2E.
3. **Customer flow** (consent → request → live screen → end; SOS linkage) + APK.
4. **CPO flow** (overview + active-session map) + APK.
5. **Ops `/protection` page + alerts + transfer/end actions** + console deploy.
6. **Notifications matrix** (bridge kinds + mobile branches + parity scan) + APK.
7. **Full-loop staging E2E + device pass + sqa.md/BUILD_RUNBOOK entries.**

---

_Spec author note: B-415 (2026-08-10, commit `5061ccfd`) already shipped the dedicated-officer
routing this module presumes — plan→assignment→auto-scheduled dates all work and are live on
staging. This module adds the session layer on top. Nothing here requires touching messenger
crypto, sealed sender, or the booking dispatch paths._
