-- Bravo Secure Pro — ops management layer (founder spec 2026-08-03 phase 3):
-- internal orgs created from ops, ops-created CPOs, and CPO↔Pro-member
-- assignments with OVERLAP-SAFE date scheduling + per-assignment mission codes.
--
-- Org model unchanged: an org IS the agents(type='company') row's users.id
-- (no orgs table). Ops-created orgs/CPOs are marked by agents.created_by_ops.
--
-- Overlap safety is enforced IN THE DATABASE: a gist exclusion constraint
-- rejects any two ASSIGNED rows for the same CPO whose date ranges touch —
-- overlapping and duplicate assignments become impossible, not just checked.
-- COMPLETED/CANCELLED rows leave the constraint, so reassignment after a
-- finished protection period works naturally.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Marks orgs/CPOs provisioned from the Operations Console ("internal").
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS created_by_ops uuid;

CREATE TABLE IF NOT EXISTS public.pro_cpo_assignments (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid        NOT NULL REFERENCES public.pro_applications(id) ON DELETE CASCADE,
  -- Optional link to the client's multi-date request this assignment fulfils.
  mission_id     uuid        REFERENCES public.pro_plan_missions(id) ON DELETE SET NULL,
  cpo_user_id    uuid        NOT NULL,
  org_user_id    uuid,
  starts_on      date        NOT NULL,
  ends_on        date        NOT NULL,
  status         text        NOT NULL DEFAULT 'ASSIGNED'
    CHECK (status IN ('ASSIGNED','COMPLETED','CANCELLED')),
  -- The code the CPO types after login to open the mission view (PMC-XXXXXX).
  mission_code   text        NOT NULL UNIQUE,
  note           text,
  assigned_by    uuid        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  CHECK (ends_on >= starts_on),
  -- THE overlap rule: one CPO cannot hold two live assignments on touching
  -- date ranges ('[]' = inclusive bounds). 23P01 on violation.
  CONSTRAINT pro_cpo_assignments_no_overlap
    EXCLUDE USING gist (
      cpo_user_id WITH =,
      daterange(starts_on, ends_on, '[]') WITH &&
    ) WHERE (status = 'ASSIGNED')
);

-- Ops boards: by application, by CPO, by status/date.
CREATE INDEX IF NOT EXISTS pro_cpo_assignments_app_idx
  ON public.pro_cpo_assignments (application_id, starts_on DESC);
CREATE INDEX IF NOT EXISTS pro_cpo_assignments_cpo_idx
  ON public.pro_cpo_assignments (cpo_user_id, status, starts_on DESC);
CREATE INDEX IF NOT EXISTS pro_cpo_assignments_status_idx
  ON public.pro_cpo_assignments (status, ends_on);

ALTER TABLE public.pro_cpo_assignments ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.pro_cpo_assignments IS
  'CPO ↔ Pro-member protection assignments (date-ranged, overlap-safe via gist exclusion; mission_code opens the CPO mission view). No payout — covered by the plan.';
