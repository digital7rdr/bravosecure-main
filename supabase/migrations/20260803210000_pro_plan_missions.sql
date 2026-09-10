-- Bravo Secure Pro — in-plan mission requests (founder spec 2026-08-03):
-- the client (owner or an active linked member) selects MULTIPLE DATES inside
-- the covered period; the Bravo Control System schedules CPOs/responsibilities
-- for those dates. No per-mission payment — covered by the plan total.
-- These dates are also what the premium period calendar highlights.

CREATE TABLE IF NOT EXISTS public.pro_plan_missions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid        NOT NULL REFERENCES public.pro_applications(id) ON DELETE CASCADE,
  requested_by   uuid        NOT NULL,
  mission_dates  date[]      NOT NULL,
  note           text,
  status         text        NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN ('REQUESTED','SCHEDULED','DECLINED','COMPLETED')),
  assigned_team  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  ops_note       text,
  decided_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Client list + ops card: WHERE application_id = $1 ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS pro_plan_missions_app_idx
  ON public.pro_plan_missions (application_id, created_at DESC);

ALTER TABLE public.pro_plan_missions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.pro_plan_missions IS
  'Multi-date protection requests inside an ACTIVE Bravo Secure Pro plan (no per-mission charge).';
