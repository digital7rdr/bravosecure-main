# Issue 30 — Pro fleet + resources (Assigned-Team screen shows real vehicle + plate)

**Status:** ✅ SHIPPED + DEPLOYED (2026-08-21). Layers 1-3 on main (`489f6570`, `2b6c9b14`,
`5b3bc5a9`) + old-server guard `49a171f2`. Migration applied to Supabase (verified). auth-service +
ops-console deployed to staging & verified healthy (manual tar flow; watchdog snapshot refreshed).
Mobile APK deferred (founder). Testable now in ops-console; appears in-app once an APK ships.
Founder decisions: **separate Pro fleet** (not the Lite `vehicle_pool`); **Resources = real
assignable inventory** (treated like vehicles). Full investigation + design in the
session transcript; this doc is the buildable contract.

## Why

Client Issue 30 (HIGH): "Client Is Not Shown the Assigned Vehicle and Registration Number."
No Pro-side vehicle/resource assignment model existed — `pro_cpo_assignments` /
`protection_sessions` carry no vehicle link, and `vehicle_pool` is bound to the Lite booking
product only. The honest empty state already shipped (`2e4eb55c`); this feature makes the tabs
show real data.

## Settled implementation decisions (defaults chosen under the "build now" directive)

1. **Vehicle exclusivity: YES** — a vehicle cannot hold two overlapping ASSIGNED windows
   (gist exclusion, mirrors `pro_cpo_assignments`). A physical vehicle can't be two places.
2. **Resource model: catalog + per-assignment `qty`, no exclusivity** — one `pro_resources`
   row is either a generic type ("comms set", assign qty=2) or a specific tracked asset
   (label carries the model, optional `identifier` carries the serial, assign qty=1). No gist
   for v1; ops manages double-assignment.
3. **Granularity: plan-scoped** — vehicle/resource link to `application_id`, with an OPTIONAL
   `assignment_id` to pin a specific CPO detail. The client screen reads by plan (appId), so a
   client can see the vehicle even before/without a specific CPO row.
4. **Region: nullable, informational** — Pro `coverage_area` is free text; no region-gated
   auto-pick like Lite.
5. **Empty-state copy: keep** — "…will appear here once it's allocated to your protection
   detail" (still true under plan-scoping).
6. **Resource serial (`identifier`): WITHHELD from the client** — ops-internal only, same
   discipline as `mission_code` never reaching the member.

## Layer 1 — schema + auth-service backend (the contract)

### Migration `supabase/migrations/<ts>_pro_fleet_and_resources.sql`

Four tables, all `ENABLE + FORCE ROW LEVEL SECURITY` with zero policies (newest pro\_\* convention;
backend runs as `postgres`/rolbypassrls so RLS never blocks it; deny-all for anon):

- **`pro_fleet_vehicles`** (catalog): `id uuid PK`, `call_sign text UNIQUE NOT NULL`,
  `make_model text NOT NULL`, `plate text NOT NULL`, `colour text`, `armored bool DEFAULT true`,
  `armor_grade text`, `capacity int DEFAULT 4`, `region_code text` (nullable), `active bool DEFAULT true`,
  `notes text`, `created_by uuid`, timestamps. Retire = `active=false` (no hard delete).
- **`pro_resources`** (catalog): `id`, `kind text CHECK IN ('comms','medical','tactical','other')`,
  `label text NOT NULL`, `identifier text` (ops-internal serial), `active bool DEFAULT true`,
  `notes`, `created_by`, timestamps.
- **`pro_vehicle_assignments`** (link): `id`, `application_id uuid NOT NULL REFERENCES pro_applications(id) ON DELETE CASCADE`,
  `vehicle_id uuid NOT NULL REFERENCES pro_fleet_vehicles(id)`, `assignment_id uuid REFERENCES pro_cpo_assignments(id) ON DELETE SET NULL`,
  `starts_on date NOT NULL`, `ends_on date NOT NULL`, `status text DEFAULT 'ASSIGNED' CHECK IN ('ASSIGNED','RELEASED')`,
  `note`, `assigned_by uuid NOT NULL`, timestamps, `released_at`, `CHECK (ends_on >= starts_on)`,
  gist exclusion `pro_vehicle_no_overlap (vehicle_id =, daterange(starts_on,ends_on,'[]') &&) WHERE status='ASSIGNED'`.
  Indexes: `(application_id, starts_on DESC) WHERE status='ASSIGNED'`, `(vehicle_id, status)`.
- **`pro_resource_assignments`** (link): as above but `resource_id`, `qty int DEFAULT 1 CHECK (qty>=1)`,
  no gist. Index `(application_id, starts_on DESC) WHERE status='ASSIGNED'`.

`CREATE EXTENSION IF NOT EXISTS btree_gist;` at the top.

### Auth-service `apps/auth-service/src/pro-management/`

New `pro-fleet.service.ts` + `pro-fleet-ops.controller.ts`, registered in `pro-management.module.ts`.
Controller `@Controller('ops/pro-management')`, guards `JwtAuthGuard, CsrfGuard, AdminGuard`, mutations
`@RequireRoles('SUPERVISOR','ADMIN')` + `await this.audit.recordAdmin(req.admin, '<action>', '<subject_type>', id, {meta})`:

| Method | Route                                                                                         | audit action                               |
| ------ | --------------------------------------------------------------------------------------------- | ------------------------------------------ |
| GET    | `/fleet`, `/resources`                                                                        | —                                          |
| POST   | `/fleet`, `/resources`                                                                        | `pro_fleet.create` / `pro_resource.create` |
| POST   | `/fleet/:id`, `/resources/:id` (update/retire)                                                | `pro_fleet.update` / `pro_resource.update` |
| GET    | `/applications/:id/vehicles`, `/applications/:id/resources`                                   | —                                          |
| POST   | `/applications/:id/vehicles` (`vehicle_id, starts_on, ends_on, assignment_id?, note?`)        | `pro_vehicle.assign`                       |
| POST   | `/vehicle-assignments/:id/release`                                                            | `pro_vehicle.release`                      |
| POST   | `/applications/:id/resources` (`resource_id, qty, starts_on, ends_on, assignment_id?, note?`) | `pro_resource.assign`                      |
| POST   | `/resource-assignments/:id/release`                                                           | `pro_resource.release`                     |

New class-validator DTOs (mirror `CreateProAssignmentDto`): `CreateProFleetVehicleDto`,
`CreateProResourceDto`, `AssignProVehicleDto`, `AssignProResourceDto` (dates `@Matches(/^\d{4}-\d{2}-\d{2}$/)`).
A gist clash (Postgres 23P01) → HTTP 409.

### `listTeam` extension (`pro-applications.service.ts`, the `/pro-applications/:id/team` route)

Return `{ team, vehicles, resources }` (one client round-trip). Client-visible projections ONLY:

- vehicles: `id, call_sign, make_model, plate, colour, armored, armor_grade, capacity, starts_on, ends_on, live_today` (`CURRENT_DATE BETWEEN starts_on AND ends_on`). **Plate IS shown** (Issue 30 headline).
- resources: `id, kind, label, qty, starts_on, ends_on, live_today`. **`identifier` WITHHELD.**

### Layer-1 tests

- `pro-fleet.spec.ts` (mocked-DB SQL-text pins): create inserts the right cols; assign scopes by
  `application_id` + writes the window + `status='ASSIGNED'`; gist clash → 409; **projection test:
  listTeam vehicles expose `plate` but resources do NOT expose `identifier`**.
- authorization spec: each mutation calls `recordAdmin` + is `@RequireRoles('SUPERVISOR','ADMIN')`.

## Layer 2 — ops-console (parallel with Layer 3, after Layer 1 contract fixed)

- `apps/ops-console/src/lib/api.ts`: `proFleetApi` (list/create/update fleet + resources,
  assign/release vehicle + resource, applicationVehicles/Resources), types, SWR hooks, `newIdempotencyKey()` on POSTs.
- `pro-management/page.tsx`: add `'FLEET'` + `'RESOURCES'` sections (copy the CREATE CPO modal pattern).
- `pro-applications/[id]/page.tsx`: a "PROTECTION RESOURCES" card (assigned vehicles + resources,
  plate/label + RELEASE) + an assign modal seeded from `useProFleet`/`useProResources`, date window
  defaulting to the plan coverage.

## Layer 3 — mobile (parallel with Layer 2)

- `src/services/api.ts`: `ProAssignedVehicle` + `ProAssignedResource` types; `secureProApi.team` returns
  `{team, vehicles, resources}`.
- `src/screens/pro/ProAssignedTeamScreen.tsx`: store vehicles/resources in `loadTeam`; render real rows —
  **plate as the prominent hero field**, make/model + colour + armor secondary, `live_today` → ON DUTY;
  resources grouped by kind; keep the honest empty state when arrays are empty. Cobalt `#5B8DEF` accents.
- Flip `proAssignedTeamVehicles.test.ts` RED-first: add assertions that real rows render (`plate`/`make_model`),
  keep the empty-state + anti-fake-literal guards.

## Deploy order (HARD): migration → auth-service (staging) → ops-console → mobile APK

Batch the auth-service + migration deploy with the OWED Wave-3 `/family/request-seats` deploy (both
auth-service-only). Device-verify per the founder rule (post-install log).
