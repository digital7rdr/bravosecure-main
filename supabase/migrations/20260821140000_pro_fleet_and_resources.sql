-- Bravo Secure Pro — fleet + resources (Issue 30, 2026-08-21):
-- a SEPARATE Pro vehicle fleet (not the Lite vehicle_pool, which is bound to the
-- Lite booking product) plus assignable "resources" inventory, so the client's
-- Assigned-Team screen can show the real vehicle + registration plate.
--
-- Two catalogs (vehicles, resources) and two plan-scoped link tables. A link
-- attaches a catalog row to a pro_applications plan over a date window, with an
-- OPTIONAL pin to a specific pro_cpo_assignments detail. The client reads by plan
-- (application_id), so the vehicle is visible even before a specific CPO row.
--
-- Vehicle exclusivity is enforced IN THE DATABASE (same repo pattern as
-- pro_cpo_assignments_no_overlap): a gist exclusion rejects two ASSIGNED windows
-- for the same physical vehicle whose date ranges touch — 23P01 on violation,
-- which the service maps to HTTP 409. Resources are catalog + per-assignment qty
-- with NO exclusivity (a generic type can be assigned many times); ops manages
-- double-assignment.
--
-- RLS posture (matches protection_sessions in 20260810120000): the backend
-- connects as `postgres` (rolbypassrls), so RLS never applies to it. Every new
-- public table gets ENABLE + FORCE ROW LEVEL SECURITY and ZERO policies — RLS ON
-- + no policy IS the deny-all rule for anon / authenticated (the anon key ships
-- in the APK). Access separation is enforced in the service-layer WHERE clauses,
-- never by client trust.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── 1. Vehicle catalog ──────────────────────────────────────────────────
-- Retire a vehicle with active=false (no hard delete — historic assignments
-- keep their FK).
CREATE TABLE IF NOT EXISTS public.pro_fleet_vehicles (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  call_sign    text        NOT NULL UNIQUE,
  make_model   text        NOT NULL,
  plate        text        NOT NULL,
  colour       text,
  armored      boolean     NOT NULL DEFAULT true,
  armor_grade  text,
  capacity     integer     NOT NULL DEFAULT 4,
  region_code  text,
  active       boolean     NOT NULL DEFAULT true,
  notes        text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ── 2. Resource catalog ─────────────────────────────────────────────────
-- A row is either a generic type ("comms set", assign qty=2) or a specific
-- tracked asset (label carries the model; optional identifier carries the
-- serial — OPS-INTERNAL, never projected to the client).
CREATE TABLE IF NOT EXISTS public.pro_resources (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text        NOT NULL
    CHECK (kind IN ('comms','medical','tactical','other')),
  label       text        NOT NULL,
  identifier  text,
  active      boolean     NOT NULL DEFAULT true,
  notes       text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 3. Vehicle assignments (plan-scoped, overlap-safe) ──────────────────
CREATE TABLE IF NOT EXISTS public.pro_vehicle_assignments (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid        NOT NULL REFERENCES public.pro_applications(id) ON DELETE CASCADE,
  vehicle_id     uuid        NOT NULL REFERENCES public.pro_fleet_vehicles(id),
  -- Optional pin to the specific CPO detail this vehicle serves.
  assignment_id  uuid        REFERENCES public.pro_cpo_assignments(id) ON DELETE SET NULL,
  starts_on      date        NOT NULL,
  ends_on        date        NOT NULL,
  status         text        NOT NULL DEFAULT 'ASSIGNED'
    CHECK (status IN ('ASSIGNED','RELEASED')),
  note           text,
  assigned_by    uuid        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  released_at    timestamptz,
  CHECK (ends_on >= starts_on),
  -- THE exclusivity rule: one physical vehicle cannot hold two live windows on
  -- touching date ranges ('[]' = inclusive bounds). 23P01 on violation.
  CONSTRAINT pro_vehicle_no_overlap
    EXCLUDE USING gist (
      vehicle_id WITH =,
      daterange(starts_on, ends_on, '[]') WITH &&
    ) WHERE (status = 'ASSIGNED')
);

CREATE INDEX IF NOT EXISTS pro_vehicle_assignments_app_idx
  ON public.pro_vehicle_assignments (application_id, starts_on DESC)
  WHERE status = 'ASSIGNED';
CREATE INDEX IF NOT EXISTS pro_vehicle_assignments_vehicle_idx
  ON public.pro_vehicle_assignments (vehicle_id, status);

-- ── 4. Resource assignments (plan-scoped, qty, no exclusivity) ──────────
CREATE TABLE IF NOT EXISTS public.pro_resource_assignments (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid        NOT NULL REFERENCES public.pro_applications(id) ON DELETE CASCADE,
  resource_id    uuid        NOT NULL REFERENCES public.pro_resources(id),
  assignment_id  uuid        REFERENCES public.pro_cpo_assignments(id) ON DELETE SET NULL,
  qty            integer     NOT NULL DEFAULT 1 CHECK (qty >= 1),
  starts_on      date        NOT NULL,
  ends_on        date        NOT NULL,
  status         text        NOT NULL DEFAULT 'ASSIGNED'
    CHECK (status IN ('ASSIGNED','RELEASED')),
  note           text,
  assigned_by    uuid        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  released_at    timestamptz,
  CHECK (ends_on >= starts_on)
);

CREATE INDEX IF NOT EXISTS pro_resource_assignments_app_idx
  ON public.pro_resource_assignments (application_id, starts_on DESC)
  WHERE status = 'ASSIGNED';

-- ── 5. RLS: ENABLE + FORCE, zero policies (deny-all for anon/authenticated) ──
ALTER TABLE public.pro_fleet_vehicles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pro_fleet_vehicles        FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.pro_resources             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pro_resources             FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.pro_vehicle_assignments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pro_vehicle_assignments   FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.pro_resource_assignments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pro_resource_assignments  FORCE  ROW LEVEL SECURITY;

COMMENT ON TABLE public.pro_fleet_vehicles IS
  'Pro protection fleet catalog (SEPARATE from the Lite vehicle_pool). Retire via active=false. Issue 30.';
COMMENT ON TABLE public.pro_resources IS
  'Pro assignable resource inventory (comms/medical/tactical/other). identifier is the ops-internal serial — never projected to the client. Issue 30.';
COMMENT ON TABLE public.pro_vehicle_assignments IS
  'Vehicle ↔ Pro plan links (date-ranged, exclusivity via gist exclusion). The client reads assigned vehicle + plate by application_id. Issue 30.';
COMMENT ON TABLE public.pro_resource_assignments IS
  'Resource ↔ Pro plan links (per-assignment qty, no exclusivity). Issue 30.';
