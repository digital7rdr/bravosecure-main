# Build Spec — Dispatch Inspector (ops-console)

> **Audience:** an engineer (or another Claude session) implementing this feature end to end.
> **Status:** ready to build. All file paths, columns, SQL, and guards below were verified against
> the codebase on branch `feat/auto-dispatch` (= `main`). Where a column/behavior was confirmed,
> a `file:line` is given. Follow the steps in order.
>
> **What you're building:** a read-only ops-console area that lets ops see **every dispatch request**
> and drill into **one request's full lifecycle** — the offer cascade (which agencies were asked, in
> rank order, and who accepted/rejected/expired), the accepting agency, the assigned CPOs (count +
> who's lead), the escrow ledger, the mission state, and a **chronological timeline of every step**.

---

## 0. TL;DR — what changes

| #   | File                                                          | Change                                                                                                 |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | `apps/auth-service/src/dispatch/dispatch.service.ts`          | **EDIT** — add response interfaces + 2 methods: `listDispatchRequests()`, `getDispatchRequestDetail()` |
| 2   | `apps/auth-service/src/dispatch/dispatch-admin.controller.ts` | **EDIT** — add `GET /ops/dispatch/requests` + `GET /ops/dispatch/requests/:id`                         |
| 3   | `apps/auth-service/src/dispatch/dispatch.service.spec.ts`     | **EDIT/ADD** — unit tests for the 2 methods                                                            |
| 4   | `apps/auth-service/src/dispatch/dispatch.module.ts`           | **NO CHANGE** (verify only — controller + service already wired)                                       |
| 5   | `apps/ops-console/src/lib/api.ts`                             | **EDIT** — add 2 `opsApi` methods, the result types, 2 SWR hooks                                       |
| 6   | `apps/ops-console/src/app/dispatch-inspector/page.tsx`        | **NEW** — list view                                                                                    |
| 7   | `apps/ops-console/src/app/dispatch-inspector/[id]/page.tsx`   | **NEW** — detail view                                                                                  |
| 8   | `apps/ops-console/src/components/Shell.tsx`                   | **EDIT** — add one NAV rail entry                                                                      |
| 9   | `apps/ops-console/src/lib/rbac.ts`                            | **NO CHANGE** (read-only; any admin may view)                                                          |

**No DB migration is needed** — every field already exists. **No new module/guard wiring** — both
endpoints live on the already-guarded `DispatchAdminController`.

---

## 1. Design

### 1a. List view — `/dispatch-inspector`

A polling table (SWR, 5 s) of every auto-dispatch booking, newest activity first. Columns:

`Booking # · Status pill · Region · Crew (n requested) · #Offers · Accepting agency · Started`

Row click → detail. Optional status filter chips. Status pill tones:
`CONFIRMED/COMPLETED → ok`, `DISPATCHING → warn`, `LIVE → live`,
`NO_PROVIDER/AGENCY_NO_SHOW/CANCELLED → err`, else `info`.

### 1b. Detail view — `/dispatch-inspector/[id]`

Two columns.

**Left — the "what happened":**

- **Offer cascade** — every `dispatch_offers` row, **rank order**: `#rank · agency (name/email) · distance_km · STATUS · reject_reason`. This is the matchmaker's decision record — who was asked first, who said no, who took it.
- **Timeline** — one chronological feed merging _all_ event sources (see §4).

**Right — the "who/what/money":**

- **Accepting agency** — name, call-sign, rating, email.
- **Assigned crew** — count + each CPO (`★` lead via `is_lead`, role, status, armed).
- **Escrow** — status (`HELD → PENDING_RELEASE → RELEASED/REFUNDED`), gross/provider/fee credits, basis, `review_required`.
- **Mission** — `short_code`, status, PICKUP/LIVE/ended timestamps, link to `/live/[mission_id]`.

---

## 2. Data model reference (verified columns)

> Only the columns the Inspector needs. All under `public.`. `file:line` = the migration that defines them.

**`lite_bookings`** (`20260423113000_booking_module.sql:28-70` + `20260620000000_auto_dispatch.sql:60-65` + `20260620000002_escrow_integrity.sql:124-127` + `20260628000000_arrival_and_noshow.sql:14-15`):
`id, client_id, status (enum lite_booking_status), region_code, region_label, service, cpo_count, armed_required, requirements (jsonb), pickup_address, pickup_time, duration_hours, total_eur, total_aed, rating, created_at, updated_at` + auto: `dispatch_mode (text 'auto'|NULL), assigned_provider_user_id (uuid), dispatch_started_at, dispatch_settled_at, crew_deadline_at, arrival_deadline_at`.

- ⚠️ Booking money is **`total_eur` / `total_aed`** (DECIMAL). There is **no `total_credits`**.
- ⚠️ The Ops Room id is **`comms_channel_id`**, NOT `conversation_id` (that column does not exist).
- `lite_booking_status` enum: `DRAFT, PENDING_OPS, OPS_APPROVED, PAYMENT_PENDING, CONFIRMED, LIVE, COMPLETED, CANCELLED, DISPATCHING, NO_PROVIDER, AGENCY_NO_SHOW`.

**`dispatch_offers`** (`20260620000000_auto_dispatch.sql:27-38`):
`id, booking_id, provider_user_id (= agents.user_id), rank (1=nearest), distance_km (numeric 7,2, straight-line), status (enum), offered_at, expires_at, responded_at, reject_reason`.

- ⚠️ Timestamp is **`offered_at`**, NOT `created_at` (no `created_at` exists).
- Enum `dispatch_offer_status`: `OFFERED, ACCEPTED, REJECTED, EXPIRED, SUPERSEDED, CANCELLED`.

**`escrow_holds`** (`20260620000002_escrow_integrity.sql:26-44`) — one per booking (`booking_id` UNIQUE):
`id, booking_id, offer_id, client_id, provider_user_id, gross_credits (int), currency, status (enum), held_at, completed_at, release_eligible_at, settled_at, to_provider_credits, to_client_credits, platform_fee_credits, basis (text), review_required (bool)`.

- Enum `escrow_hold_status`: `HELD, PENDING_RELEASE, RELEASED, REFUNDED, PARTIAL, DISPUTED`. Money here is **credits (int)**.

**`missions`** (`20260424000000_ops_admin.sql:74-97` + `20260624000000_mission_state_timestamps.sql:10-11`) — one per booking:
`id, booking_id (UNIQUE), status (enum mission_status), short_code, started_at, ended_at, end_reason, comms_channel_id, created_at, updated_at` + `pickup_at, live_at`.

- Enum `mission_status`: `DISPATCHED, PICKUP, LIVE, SOS, COMPLETED, ABORTED`.

**`mission_crew`** (`20260424000000_ops_admin.sql:122-133` + `20260428100000_mission_lead_telemetry.sql:11-13`) — PK `(mission_id, agent_id)`:
`mission_id, agent_id, slot, role ('LEAD'|'CP'|'DRIVER'|'RESERVE'), call_sign, armed, status ('active'|'sos'|'standby'|'off'), is_lead (bool), team_idx`.

- ⚠️ **No timestamp column** — use `missions.created_at` as "crew assigned at". Lead = `is_lead=true` (preferred) or `role='LEAD'`.

**`agents`** (`20260423180000_agent_portal.sql:45-62` + `20260620000000_auto_dispatch.sql:71-76`):
`user_id (PK), type (enum: company|cpo|transport), status, call_sign, display_name (TEXT, **nullable**), rating (decimal 3,2), region_code, …`.

- ⚠️ `display_name` is nullable — fall back to `call_sign` or the `users.email` subselect.
- ⚠️ Agency email is on **`public.users.email`**, NOT `agents`. Use the subselect pattern (see §3).

**`ops_audit`** (`20260424000000_ops_admin.sql:227-238`):
`id BIGSERIAL, actor_id, actor_role, actor_call, action, subject_type, subject_id (TEXT), metadata (jsonb), ip_address, created_at`. Indexed `(subject_type, subject_id, created_at DESC)`.

**`lite_booking_audit`** (`20260423113000_booking_module.sql:76-85`):
`id BIGSERIAL, booking_id, from_status, to_status, actor_id, actor_role, metadata (jsonb), created_at`. The per-booking FSM transition log.

---

## 3. Backend — the query patterns

The service injects `private readonly db: DatabaseService` (`dispatch.service.ts:226`); use
`this.db.q<T>(sql, params)` / `this.db.qOne<T>(sql, params)`. Copy the **`monitor()`** method
(`dispatch.service.ts:319-347`) for style — including the agency-email subselect
`(SELECT email FROM public.users u WHERE u.id = …)`. The service-role connection bypasses
FORCE-RLS exactly as `monitor()` already does — **no policy changes**.

### 3a. List query — `GET /ops/dispatch/requests?status=&limit=`

```sql
SELECT
  b.id                                          AS booking_id,
  b.status::text                                AS status,
  b.region_code, b.region_label, b.service,
  b.cpo_count, b.armed_required, b.dispatch_mode,
  b.dispatch_started_at, b.dispatch_settled_at, b.created_at, b.updated_at,
  b.assigned_provider_user_id,
  pa.display_name                               AS accepting_agency_name,
  pa.call_sign                                  AS accepting_agency_call_sign,
  (SELECT count(*) FROM public.dispatch_offers o WHERE o.booking_id = b.id)     AS offers_count,
  (SELECT count(*) FROM public.mission_crew mc
     JOIN public.missions m ON m.id = mc.mission_id WHERE m.booking_id = b.id)  AS crew_count,
  eh.status::text                               AS escrow_status,
  eh.gross_credits                              AS escrow_gross_credits,
  ms.status::text                               AS mission_status,
  ms.short_code                                 AS mission_short_code,
  GREATEST(
    b.updated_at,
    COALESCE(b.dispatch_settled_at, b.dispatch_started_at, b.created_at),
    COALESCE((SELECT max(GREATEST(o.offered_at, o.responded_at))
                FROM public.dispatch_offers o WHERE o.booking_id = b.id), b.created_at)
  )                                             AS last_activity_at
FROM public.lite_bookings b
LEFT JOIN public.agents       pa ON pa.user_id    = b.assigned_provider_user_id
LEFT JOIN public.escrow_holds eh ON eh.booking_id = b.id
LEFT JOIN public.missions     ms ON ms.booking_id = b.id
WHERE ($1::text IS NULL OR b.status::text = $1)
  AND b.dispatch_mode = 'auto'            -- remove this line to also list legacy admin-flow bookings
ORDER BY last_activity_at DESC
LIMIT $2;
```

Params: `[status ?? null, limit ?? 50]`.

### 3b. Detail — `GET /ops/dispatch/requests/:id`

Run several queries and assemble. Return `null` if the booking query returns nothing (controller → 404).

**Booking + agency + escrow + mission header:**

```sql
SELECT
  b.id AS booking_id, b.status::text AS status, b.dispatch_mode,
  b.region_code, b.region_label, b.service, b.cpo_count, b.armed_required,
  b.requirements, b.client_id, b.assigned_provider_user_id,
  b.pickup_address, b.pickup_time, b.duration_hours, b.total_eur, b.total_aed,
  b.dispatch_started_at, b.dispatch_settled_at, b.crew_deadline_at,
  b.arrival_deadline_at, b.created_at, b.updated_at,
  pa.display_name AS agency_name, pa.call_sign AS agency_call_sign, pa.rating AS agency_rating,
  (SELECT email FROM public.users u WHERE u.id = b.assigned_provider_user_id) AS agency_email
FROM public.lite_bookings b
LEFT JOIN public.agents pa ON pa.user_id = b.assigned_provider_user_id
WHERE b.id = $1;
```

**Offer cascade (rank order):**

```sql
SELECT o.id AS offer_id, o.provider_user_id, o.rank, o.status::text AS status,
       o.distance_km, o.offered_at, o.expires_at, o.responded_at, o.reject_reason,
       a.display_name AS agency_name, a.call_sign AS agency_call_sign,
       a.rating AS agency_rating, a.region_code AS agency_region,
       (SELECT email FROM public.users u WHERE u.id = o.provider_user_id) AS agency_email
FROM public.dispatch_offers o
LEFT JOIN public.agents a ON a.user_id = o.provider_user_id
WHERE o.booking_id = $1
ORDER BY o.rank ASC, o.offered_at ASC;
```

**Escrow hold:**

```sql
SELECT id AS escrow_id, status::text AS status, gross_credits, currency,
       to_provider_credits, to_client_credits, platform_fee_credits, basis,
       review_required, held_at, completed_at, release_eligible_at, settled_at, offer_id
FROM public.escrow_holds WHERE booking_id = $1;
```

**Mission + crew (lead first):**

```sql
SELECT id AS mission_id, status::text AS status, short_code,
       started_at, created_at, pickup_at, live_at, ended_at, end_reason, comms_channel_id
FROM public.missions WHERE booking_id = $1;

SELECT mc.agent_id, mc.is_lead, mc.role, mc.call_sign, mc.slot, mc.team_idx, mc.armed, mc.status,
       a.display_name AS agent_name, a.rating AS agent_rating
FROM public.mission_crew mc
LEFT JOIN public.agents a ON a.user_id = mc.agent_id
WHERE mc.mission_id = $1            -- pass the mission_id from the row above
ORDER BY mc.is_lead DESC, mc.slot ASC;
```

### 3c. Timeline — the complete merge (THIS IS THE IMPORTANT ONE)

> **Do NOT** build the timeline from `ops_audit` alone. Escrow RELEASE/REFUND, mission
> PICKUP/LIVE/COMPLETED, SUPERSEDED offers, and client CANCEL **emit no `ops_audit` row**.
> A complete timeline must UNION six sources. All are reachable from `booking_id` alone
> (missions/escrow/offers all carry `booking_id`), so it's a single query:

```sql
WITH tl AS (
  -- 1. booking FSM transitions (client + admin) incl. CANCELLED
  SELECT created_at, 'status'::text AS source, to_status::text AS label,
         actor_role, NULL::text AS actor_call, metadata
    FROM public.lite_booking_audit WHERE booking_id = $1
  UNION ALL
  -- 2. engine + admin ops-audit (booking-scoped): dispatch.start/offer/reject/expire/
  --    accept/no_provider/agency_no_show/arrival_no_show/cancel/force_assign, dispute.resolve
  SELECT created_at, 'ops_audit', action, actor_role, actor_call, metadata
    FROM public.ops_audit WHERE subject_type = 'booking' AND subject_id = $1::text
  UNION ALL
  -- 3. each offer made (cascade rung)
  SELECT offered_at, 'offer_made',
         ('offer #' || rank || COALESCE(' · ' || distance_km::text || 'km', ''))::text,
         'SYSTEM', NULL,
         jsonb_build_object('offer_id', id, 'provider_user_id', provider_user_id,
                            'rank', rank, 'distance_km', distance_km, 'status', status)
    FROM public.dispatch_offers WHERE booking_id = $1
  UNION ALL
  -- 4. each offer outcome (ACCEPTED/REJECTED/EXPIRED/SUPERSEDED)
  SELECT responded_at, 'offer_outcome', status::text, 'SYSTEM', NULL,
         jsonb_build_object('offer_id', id, 'reject_reason', reject_reason)
    FROM public.dispatch_offers WHERE booking_id = $1 AND responded_at IS NOT NULL
  UNION ALL
  -- 5. escrow money events (held / pending-release-or-review / settled)
  SELECT held_at, 'escrow', 'HELD', 'SYSTEM', NULL,
         jsonb_build_object('gross_credits', gross_credits)
    FROM public.escrow_holds WHERE booking_id = $1
  UNION ALL
  SELECT completed_at, 'escrow',
         CASE WHEN review_required THEN 'REVIEW_REQUIRED' ELSE 'PENDING_RELEASE' END,
         'SYSTEM', NULL, '{}'::jsonb
    FROM public.escrow_holds WHERE booking_id = $1 AND completed_at IS NOT NULL
  UNION ALL
  SELECT settled_at, 'escrow', status::text, 'SYSTEM', NULL,
         jsonb_build_object('basis', basis, 'to_provider', to_provider_credits,
                            'to_client', to_client_credits, 'fee', platform_fee_credits)
    FROM public.escrow_holds WHERE booking_id = $1 AND settled_at IS NOT NULL
  UNION ALL
  -- 6. mission progression (agent-app transitions — never in ops_audit)
  SELECT created_at, 'mission', 'CREW_ASSIGNED', 'SYSTEM', NULL,
         jsonb_build_object('short_code', short_code)
    FROM public.missions WHERE booking_id = $1
  UNION ALL
  SELECT pickup_at, 'mission', 'PICKUP', 'CPO', NULL, '{}'::jsonb
    FROM public.missions WHERE booking_id = $1 AND pickup_at IS NOT NULL
  UNION ALL
  SELECT live_at, 'mission', 'LIVE', 'CPO', NULL, '{}'::jsonb
    FROM public.missions WHERE booking_id = $1 AND live_at IS NOT NULL
  UNION ALL
  SELECT ended_at, 'mission', status::text, 'CPO', NULL,
         jsonb_build_object('end_reason', end_reason)
    FROM public.missions WHERE booking_id = $1 AND ended_at IS NOT NULL
)
SELECT created_at AS at, source, label, actor_role, actor_call, metadata
FROM tl WHERE created_at IS NOT NULL
ORDER BY at ASC;
```

> Note: `subject_id` in `ops_audit` is **TEXT** — the `$1::text` cast is mandatory or the query errors.

### 3d. Response interfaces (put in `dispatch.service.ts`, export them)

```ts
export interface DispatchRequestListRow {
  booking_id: string;
  status: string;
  region_code: string;
  region_label: string;
  service: string;
  cpo_count: number;
  armed_required: boolean;
  dispatch_mode: string | null;
  dispatch_started_at: string | null;
  dispatch_settled_at: string | null;
  created_at: string;
  updated_at: string;
  assigned_provider_user_id: string | null;
  accepting_agency_name: string | null;
  accepting_agency_call_sign: string | null;
  offers_count: number;
  crew_count: number;
  escrow_status: string | null;
  escrow_gross_credits: number | null;
  mission_status: string | null;
  mission_short_code: string | null;
  last_activity_at: string;
}
export interface DispatchRequestOffer {
  offer_id: string;
  provider_user_id: string;
  agency_name: string | null;
  agency_call_sign: string | null;
  agency_email: string | null;
  agency_rating: number | null;
  agency_region: string | null;
  rank: number;
  status: 'OFFERED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'SUPERSEDED' | 'CANCELLED';
  distance_km: number | null;
  offered_at: string;
  expires_at: string;
  responded_at: string | null;
  reject_reason: string | null;
}
export interface DispatchRequestCrew {
  agent_id: string;
  agent_name: string | null;
  agent_rating: number | null;
  call_sign: string;
  role: string;
  is_lead: boolean;
  slot: number;
  team_idx: number;
  armed: boolean;
  status: string;
}
export interface DispatchRequestEscrow {
  escrow_id: string;
  status: 'HELD' | 'PENDING_RELEASE' | 'RELEASED' | 'REFUNDED' | 'PARTIAL' | 'DISPUTED';
  gross_credits: number;
  currency: string;
  to_provider_credits: number | null;
  to_client_credits: number | null;
  platform_fee_credits: number | null;
  basis: string | null;
  review_required: boolean;
  held_at: string;
  completed_at: string | null;
  release_eligible_at: string | null;
  settled_at: string | null;
  offer_id: string | null;
}
export interface DispatchRequestMission {
  mission_id: string;
  status: 'DISPATCHED' | 'PICKUP' | 'LIVE' | 'SOS' | 'COMPLETED' | 'ABORTED';
  short_code: string;
  started_at: string;
  created_at: string;
  pickup_at: string | null;
  live_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  comms_channel_id: string | null;
}
export interface DispatchTimelineEntry {
  at: string;
  source: 'status' | 'ops_audit' | 'offer_made' | 'offer_outcome' | 'escrow' | 'mission';
  label: string;
  actor_role: string | null;
  actor_call: string | null;
  metadata: Record<string, unknown>;
}
export interface DispatchRequestDetail {
  booking: {
    booking_id: string;
    status: string;
    dispatch_mode: string | null;
    region_code: string;
    region_label: string;
    service: string;
    cpo_count: number;
    armed_required: boolean;
    requirements: Record<string, unknown>;
    client_id: string;
    assigned_provider_user_id: string | null;
    agency_name: string | null;
    agency_call_sign: string | null;
    agency_rating: number | null;
    agency_email: string | null;
    pickup_address: string | null;
    pickup_time: string;
    duration_hours: number;
    total_eur: string;
    total_aed: string; // DECIMAL → driver returns string
    dispatch_started_at: string | null;
    dispatch_settled_at: string | null;
    crew_deadline_at: string | null;
    arrival_deadline_at: string | null;
    created_at: string;
    updated_at: string;
  };
  offers: DispatchRequestOffer[];
  escrow: DispatchRequestEscrow | null;
  mission: DispatchRequestMission | null;
  crew: DispatchRequestCrew[];
  timeline: DispatchTimelineEntry[];
}
```

### 3e. Controller additions — `dispatch-admin.controller.ts`

Class is already `@Controller('ops/dispatch')` + `@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard)`
(`:38-39`). Add to the `@nestjs/common` import: `Query`, `NotFoundException`. Add a DTO and two routes:

```ts
class ListDispatchRequestsDto {
  @IsOptional() @IsString() status?: string;          // a lite_booking_status
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

@Get('requests')                                       // any admin (no @RequireRoles), like monitor
listRequests(@Query() q: ListDispatchRequestsDto) {
  return this.dispatch.listDispatchRequests(q.status, q.limit ?? 50);
}

@Get('requests/:id')
async getRequest(@Param('id') id: string) {
  const detail = await this.dispatch.getDispatchRequestDetail(id);
  if (!detail) { throw new NotFoundException('booking_not_found'); }
  return detail;
}
```

`class-validator`/`class-transformer` decorators (`IsOptional, IsString, IsInt, Min, Max, Type`) are
already used elsewhere in the service — import from `class-validator` / `class-transformer`.
**Both endpoints are pure reads — no `IdempotencyInterceptor`, no mutations.**

### 3f. Tests — `dispatch.service.spec.ts`

Add unit tests (mock `db.q`/`db.qOne`):

- `listDispatchRequests` maps rows; passes `[status, limit]`.
- `getDispatchRequestDetail` assembles offers in rank order, merges + sorts the timeline ascending, attaches mission/crew/escrow.
- `getDispatchRequestDetail` returns `null` for an unknown id (drives the controller 404).

---

## 4. Frontend — ops-console

Stack: Next.js 15 App Router, React 19, SWR, custom CSS design-token classes in `globals.css`
(alias `@/` → `apps/ops-console/src/`). Use the **custom-class** style (`.card`/`.pill`/`.dt`/`.tl-ev`),
which matches `bookings`/`live`/`agents` pages (the `/dispatch` monitor uses Tailwind utilities —
either is fine, but custom-class is more consistent here).

### 4a. `src/lib/api.ts`

The fetcher `fetchJson<T>(path, init?)` (`api.ts:43-77`) sends cookies + CSRF automatically; 401/403
auto-redirect to `/login`. `opsApi` object is at `api.ts:536-842`; SWR hooks at `api.ts:871-994`
(`POLL_DASH=5000`, `POLL_MSN=2000`).

**Add the result types** (near `DispatchMonitor` ~`:865`) — mirror the **backend** field names from §3d
(use `gross_credits`/`to_provider_credits`/`platform_fee_credits` as numbers; `total_eur`/`total_aed`
as strings). Re-declare `DispatchRequestListRow`, `DispatchRequestOffer`, `DispatchRequestCrew`,
`DispatchRequestEscrow`, `DispatchRequestMission`, `DispatchTimelineEntry`, `DispatchRequestDetail`
exactly as §3d (frontend copy of the same shapes).

**Add `opsApi` methods** (inside the object, before its close ~`:842`):

```ts
  dispatchRequests: (q?: {status?: string}) => {
    const p = new URLSearchParams();
    if (q?.status) p.set('status', q.status);
    const qs = p.toString();
    return fetchJson<DispatchRequestListRow[]>(`/ops/dispatch/requests${qs ? `?${qs}` : ''}`);
  },
  dispatchRequestDetail: (id: string) =>
    fetchJson<DispatchRequestDetail>(`/ops/dispatch/requests/${id}`),
```

**Add SWR hooks** (after `useDispatchMonitor` ~`:886`):

```ts
export function useDispatchRequests(status?: string) {
  return useSWR<DispatchRequestListRow[]>(
    ['dispatch-requests', status ?? 'all'],
    () => opsApi.dispatchRequests({status}),
    {refreshInterval: POLL_DASH},
  );
}
export function useDispatchRequest(id: string | null) {
  return useSWR(
    id ? ['dispatch-request', id] : null,
    () => (id ? opsApi.dispatchRequestDetail(id) : Promise.resolve(null)),
    {refreshInterval: POLL_MSN},
  );
}
```

### 4b. List page — `src/app/dispatch-inspector/page.tsx` (NEW)

```tsx
'use client';

import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {Shell} from '@/components/Shell';
import {useDispatchRequests} from '@/lib/api';

function tone(s: string): string {
  if (s === 'CONFIRMED' || s === 'COMPLETED') return 'ok';
  if (s === 'DISPATCHING') return 'warn';
  if (s === 'LIVE') return 'live';
  if (s === 'NO_PROVIDER' || s === 'AGENCY_NO_SHOW' || s === 'CANCELLED') return 'err';
  return 'info';
}

export default function DispatchInspector() {
  const router = useRouter();
  const [status, setStatus] = useState<string | undefined>(undefined);
  const {data, error, isLoading} = useDispatchRequests(status);
  const rows = data ?? [];

  return (
    <Shell>
      <div className="page-head">
        <div>
          <div className="page-crumbs">Ops · Dispatch Inspector</div>
          <h2>Dispatch Requests</h2>
        </div>
        <div className="page-head-right">
          <span className="pill">{error ? 'API OFFLINE' : 'LIVE'}</span>
        </div>
      </div>

      <div className="dt-wrap" style={{flex: 1, overflow: 'auto'}}>
        <table className="dt">
          <thead>
            <tr>
              <th style={{width: 170}}>Booking #</th>
              <th style={{width: 150}}>Status</th>
              <th>Region</th>
              <th style={{width: 110}}>Crew</th>
              <th style={{width: 80}}>Offers</th>
              <th>Accepting agency</th>
              <th style={{width: 160}}>Started</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={7} style={{padding: 24, textAlign: 'center', color: 'var(--tx-3)'}}>
                  Loading…
                </td>
              </tr>
            )}
            {error && (
              <tr>
                <td colSpan={7} style={{padding: 24, textAlign: 'center', color: 'var(--err)'}}>
                  Failed to load · {String((error as Error).message)}
                </td>
              </tr>
            )}
            {!isLoading && !error && rows.length === 0 && (
              <tr>
                <td colSpan={7} style={{padding: 24, textAlign: 'center', color: 'var(--tx-3)'}}>
                  No dispatch requests yet.
                </td>
              </tr>
            )}
            {rows.map(r => (
              <tr
                key={r.booking_id}
                style={{cursor: 'pointer'}}
                onClick={() => router.push(`/dispatch-inspector/${r.booking_id}`)}
              >
                <td className="dt-idcell">{r.booking_id.slice(-12).toUpperCase()}</td>
                <td>
                  <span className={`pill pill-${tone(r.status)}`}>
                    ● {r.status.replace(/_/g, ' ')}
                  </span>
                </td>
                <td>
                  <span className="dt-route">
                    {r.region_label} ({r.region_code})
                  </span>
                </td>
                <td>
                  <span className="dt-crew">
                    {r.crew_count}/{r.cpo_count}
                    {r.armed_required ? ' · armed' : ''}
                  </span>
                </td>
                <td>
                  <span className="dt-crew">{r.offers_count}</span>
                </td>
                <td>
                  <span className="dt-route">
                    {r.accepting_agency_name ?? r.accepting_agency_call_sign ?? '—'}
                  </span>
                </td>
                <td>
                  <span className="dt-when">{r.dispatch_started_at ?? '—'}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
```

### 4c. Detail page — `src/app/dispatch-inspector/[id]/page.tsx` (NEW)

```tsx
'use client';

import {use} from 'react';
import Link from 'next/link';
import {Shell} from '@/components/Shell';
import {useDispatchRequest} from '@/lib/api';

function tone(s: string): string {
  if (s === 'CONFIRMED' || s === 'COMPLETED') return 'ok';
  if (s === 'DISPATCHING') return 'warn';
  if (s === 'LIVE') return 'live';
  if (s === 'NO_PROVIDER' || s === 'AGENCY_NO_SHOW' || s === 'CANCELLED') return 'err';
  return 'info';
}
function offerColor(s: string): string {
  if (s === 'ACCEPTED') return 'var(--ok)';
  if (s === 'OFFERED') return 'var(--warn)';
  if (s === 'REJECTED' || s === 'EXPIRED') return 'var(--err)';
  return 'var(--tx-3)';
}

export default function DispatchRequestDetailPage({params}: {params: Promise<{id: string}>}) {
  const {id} = use(params);
  const {data, isLoading} = useDispatchRequest(id);
  const b = data?.booking;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <div className="page-crumbs">Ops · Dispatch Inspector · {id.slice(-12)}</div>
          <h2>
            Request{' '}
            <span className="mono" style={{color: 'var(--acc)'}}>
              {id.slice(-12).toUpperCase()}
            </span>
            {b && (
              <span className={`pill pill-${tone(b.status)}`} style={{marginLeft: 10}}>
                ● {b.status.replace(/_/g, ' ')}
              </span>
            )}
          </h2>
        </div>
        <div className="page-head-right">
          <Link href="/dispatch-inspector" className="btn btn-ghost">
            ← BACK
          </Link>
        </div>
      </div>

      {isLoading && (
        <div className="card" style={{padding: 16, color: 'var(--tx-3)'}}>
          Loading…
        </div>
      )}

      <div className="bk-detail-layout">
        {/* LEFT — cascade + timeline */}
        <div className="card bk-detail-left">
          <div className="card-header">
            <div className="card-header-title">
              <span className="bar" />
              Offer Cascade
            </div>
            <div className="card-header-act">{data?.offers.length ?? 0} OFFERS</div>
          </div>
          <div style={{padding: 14, display: 'flex', flexDirection: 'column', gap: 6}}>
            {(data?.offers ?? []).map(o => (
              <div
                key={o.offer_id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--bd-2)',
                  fontFamily: 'JetBrains Mono',
                  fontSize: 11,
                }}
              >
                <span style={{color: 'var(--tx-2)'}}>
                  #{o.rank} {o.agency_name ?? o.agency_email ?? o.provider_user_id.slice(0, 8)}
                  {o.distance_km != null ? ` · ${Number(o.distance_km).toFixed(1)}km` : ''}
                </span>
                <span style={{color: offerColor(o.status)}}>
                  {o.status}
                  {o.reject_reason ? ` · ${o.reject_reason}` : ''}
                </span>
              </div>
            ))}
            {(data?.offers ?? []).length === 0 && (
              <div style={{color: 'var(--tx-3)', fontSize: 11.5}}>No offers made yet.</div>
            )}
          </div>

          <div
            className="card-header"
            style={{borderTop: '1px solid var(--bd-2)', borderBottom: 0}}
          >
            <div className="card-header-title">
              <span className="bar" />
              Timeline
            </div>
            <div className="card-header-act">{data?.timeline.length ?? 0} EVENTS</div>
          </div>
          {(data?.timeline ?? []).map((t, i) => (
            <div key={i} className="tl-ev">
              <div className="tl-ts">{t.at}</div>
              <div className="tl-who">{t.actor_call ?? t.actor_role ?? t.source}</div>
              <div className="tl-msg">{t.label.replace(/_/g, ' ')}</div>
            </div>
          ))}
        </div>

        {/* RIGHT — agency, crew, escrow, mission */}
        <div className="bk-detail-right">
          <div className="card">
            <div className="card-header">
              <div className="card-header-title">
                <span className="bar" />
                Accepting Agency
              </div>
            </div>
            <div style={{padding: 14, fontSize: 12.5, color: 'var(--tx-2)'}}>
              {b?.agency_name ?? b?.agency_call_sign ?? '—'}
              {b?.agency_rating != null ? ` · ★ ${Number(b.agency_rating).toFixed(1)}` : ''}
              {b?.agency_email ? (
                <div style={{color: 'var(--tx-3)', fontSize: 11}}>{b.agency_email}</div>
              ) : null}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-header-title">
                <span className="bar" />
                Assigned Crew
              </div>
              <div className="card-header-act">
                {data?.crew.length ?? 0}/{b?.cpo_count ?? 0} CPO
              </div>
            </div>
            <div style={{padding: 14, display: 'flex', flexDirection: 'column', gap: 6}}>
              {(data?.crew ?? []).map(c => (
                <div key={c.agent_id} style={{fontSize: 12.5, color: 'var(--tx-1)'}}>
                  {c.is_lead ? '★ ' : '· '}
                  {c.call_sign || c.agent_name || c.agent_id.slice(0, 8)} — {c.role}
                  {c.armed ? ' · armed' : ''}{' '}
                  <span style={{color: 'var(--tx-3)'}}>({c.status})</span>
                </div>
              ))}
              {(data?.crew ?? []).length === 0 && (
                <div style={{color: 'var(--tx-3)', fontSize: 11.5}}>No crew assigned yet.</div>
              )}
            </div>
          </div>

          {data?.escrow && (
            <div className="card">
              <div className="card-header">
                <div className="card-header-title">
                  <span className="bar" />
                  Escrow
                </div>
                <div className="card-header-act">{data.escrow.status}</div>
              </div>
              <div
                style={{
                  padding: 14,
                  fontFamily: 'JetBrains Mono',
                  fontSize: 11.5,
                  color: 'var(--tx-2)',
                  lineHeight: 1.7,
                }}
              >
                gross {data.escrow.gross_credits} {data.escrow.currency}
                <br />→ provider {data.escrow.to_provider_credits ?? '—'} · fee{' '}
                {data.escrow.platform_fee_credits ?? '—'} · client{' '}
                {data.escrow.to_client_credits ?? '—'}
                <br />
                basis {data.escrow.basis ?? '—'}
                {data.escrow.review_required ? ' · ⚠ REVIEW' : ''}
              </div>
            </div>
          )}

          {data?.mission && (
            <div className="card">
              <div className="card-header">
                <div className="card-header-title">
                  <span className="bar" />
                  Mission
                </div>
                <div className="card-header-act">{data.mission.status}</div>
              </div>
              <div style={{padding: 14}}>
                <Link href={`/live/${data.mission.id}`} className="btn btn-sec">
                  {data.mission.short_code} · OPEN →
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
```

### 4d. NAV entry — `src/components/Shell.tsx`

Add to the `NAV` array (`:20-65`), e.g. right after the Dispatch block (~`:44`). Icons are **inline SVGs**
(no icon library):

```tsx
{
  href: '/dispatch-inspector', title: 'Inspector',
  icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
      <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M13.5 13.5l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
},
```

> Cosmetic note: the rail highlight uses `path.startsWith(n.href)` (`Shell.tsx:250`), so on
> `/dispatch-inspector` BOTH the `Dispatch` and `Inspector` items light up. Harmless. If you want
> it clean, use a non-`/dispatch`-prefixed route (e.g. `/inspector`) and update the page folder + links.

### 4e. RBAC

No change. The inspector is read-only; any authenticated admin may view (matches `GET monitor`).
`canViewDispatch` does not exist and is unnecessary. If you later add an admin-only _action_ to the
page, gate it with the existing `rbac.ts` helpers (`canCancelDispatch`/`canForceAssign`/`canFlipKillswitch`)
and `useOpsMe().data?.admin.role`.

---

## 5. Guardrails — MUST NOT break

- **Keep the guard chain.** Both endpoints inherit `@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard)`
  from the controller class. Do **not** add a method-level `@UseGuards` that replaces it, and never add
  a "skip in dev" branch. `AdminGuard` requires an active `admin_users` row.
- **Read-only.** Both are `@Get`; introduce **no** UPDATE/INSERT in the new service methods. No
  `IdempotencyInterceptor`. The existing `cancel`/`force-assign` mutators stay untouched.
- **No new auth bypass / no RLS change.** Reuse `this.db` (service-role, already bypasses FORCE-RLS like
  `monitor()`). Do not add a `@Public()` route or a new DB role.
- **Keep queries booking-scoped** (`WHERE booking_id = $1`). Never widen to "all bookings for a provider"
  without an explicit id. Do **not** reuse any `OrgManagerGuard`/tenant-scoped query here — those are for
  agency self-service. (Admin inspector = global by design; full detail incl. coords/PII/email is
  acceptable because every caller is an authenticated admin.)
- **`ops_audit.subject_id` is TEXT** — the timeline UNION must cast `$1::text`.
- **Use `offered_at`** (not `created_at`) for `dispatch_offers`; **lead = `is_lead`**; **booking money =
  `total_eur`/`total_aed`**, **escrow money = `*_credits`**; **Ops Room = `comms_channel_id`**.

---

## 6. Honest limits (tell the user these)

1. **No per-offer scoring rationale is stored.** The cascade records `rank` (1 = nearest by straight-line
   distance), `distance_km`, `status`, and a free-text `reject_reason`. There is **no persisted "why this
   agency ranked here"** (eligibility/capacity/compliance run in the matchmaker SQL and aren't saved per
   offer). The inspector shows _that_ agency N was rank R at X km and ACCEPTED/REJECTED/EXPIRED — not the
   engine's full scoring.
2. **`distance_km` is straight-line**, not routed (routed distance only exists on `missions.route_distance_m`
   after a mission is created). Label it "≈".
3. **`mission_crew` has no per-CPO timestamp** — "crew assigned at" = `missions.created_at`. You cannot show
   per-officer add times.
4. **Some events have no `ops_audit` row** — escrow RELEASE/REFUND, mission PICKUP/LIVE/COMPLETED,
   SUPERSEDED offers, and client CANCEL. The §3c timeline reads them from `escrow_holds`/`missions`/
   `dispatch_offers`/`lite_booking_audit` directly, which is why it UNIONs six sources. Do not "simplify"
   it down to the two audit tables or those events vanish.

---

## 7. Build order + gates

1. Backend: interfaces → `listDispatchRequests` / `getDispatchRequestDetail` (§3) → controller routes (§3e) → spec (§3f).
2. `cd apps/auth-service && npm test` (dispatch suite green) + `npm run build`.
3. Frontend: `api.ts` (§4a) → list page (§4b) → detail page (§4c) → NAV (§4d).
4. `cd apps/ops-console && npm run typecheck && npm run lint && npm run build`.
5. Mobile typecheck unaffected, but if CI runs it: `npm run typecheck` (baseline 49) must not regress.
6. Manual smoke (staging): log into ops-console as admin → **Inspector** → a row → confirm cascade,
   crew, escrow, mission, and timeline render; cross-check one request against the DB with the §3 SQL.

---

## 8. Deploy (staging is on Contabo, built from source images)

This repo's ops-console is served on the Contabo box from a locally-built Docker image (`bravo/ops-console:staging`,
behind Caddy at `ops.94-136-184-52.sslip.io`) and auth-service likewise (`bravo/auth-service:staging`,
Supabase DB). After merging:

- Sync `apps/ops-console` + `packages/messenger-core` to `~/bravo` and `cd ~/bravo && docker compose -f docker-compose.staging.yml build ops-console && up -d --no-build ops-console`.
- Sync `apps/auth-service` to `~/bravo` and rebuild/recreate `auth-service` the same way (keep a `staging-bak-<date>` image tag for rollback).
  See `auto-dispatch-staging-deploy` in the project memory for the exact rollback assets and the auth-service
  fork-vs-main caveat.
