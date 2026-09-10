-- ──────────────────────────────────────────────────────────────────────
-- Protection & Surveillance Module — on-demand protection sessions.
--   Spec: docs/planning/PROTECTION_SESSIONS_SPEC.md §2.
--
-- A Pro customer on an ACTIVE 3-month plan can press "Request Protection" at
-- any moment. That opens a bounded, consent-gated LIVE window (a protection
-- session) during which the customer's phone streams location to the backend
-- and their ops-assigned dedicated CPO monitors them on a live map. Tracking
-- exists ONLY inside a session; the backend is the single source of truth.
--
-- This module sits ON TOP of the already-live plan→assignment substrate
-- (pro_applications, pro_cpo_assignments, B-411 dedicated routing). It does
-- NOT touch messenger crypto, booking dispatch, or the scheduled-dates
-- (pro_plan_missions) concern — sessions are on-demand and orthogonal.
--
-- RLS posture (matches 20260805090816 catch-up lesson + rlsCoverage.test.ts):
--   the backend connects as `postgres` (rolbypassrls), so RLS never applies
--   to it. Every new public table gets ENABLE + FORCE ROW LEVEL SECURITY and
--   ZERO policies — RLS ON + no policy IS the deny-all rule for anon /
--   authenticated (the anon key ships in the APK). Access separation is
--   enforced in the service-layer WHERE clauses (§9), never by client trust.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1. Sessions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.protection_sessions (
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

-- Business rule 1 + edge cases C/M/N — one live session per customer, made
-- race-proof in the DB (same repo pattern as mission_crew_agent_active_uq /
-- pro_cpo_assignments_no_overlap). A create that races the index gets 23505,
-- which the service maps to "return the existing live session" (open, never
-- error). The predicate is the three NON-terminal states.
CREATE UNIQUE INDEX IF NOT EXISTS protection_sessions_one_live_uq
  ON public.protection_sessions (customer_id)
  WHERE status IN ('REQUESTED','ACTIVE','ENDING');
CREATE INDEX IF NOT EXISTS protection_sessions_cpo_idx ON public.protection_sessions (cpo_user_id, status);
CREATE INDEX IF NOT EXISTS protection_sessions_app_idx ON public.protection_sessions (application_id, created_at DESC);

-- ── 2. Location fixes ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.protection_session_locations (
  id           bigserial PRIMARY KEY,
  session_id   uuid NOT NULL REFERENCES public.protection_sessions(id) ON DELETE CASCADE,
  customer_id  uuid NOT NULL,                  -- denormalized on purpose (§9: never mix customers)
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  accuracy_m   real,
  recorded_at  timestamptz NOT NULL,           -- device clock (informational)
  received_at  timestamptz NOT NULL DEFAULT now()  -- SERVER clock — ALL staleness math uses this
);
CREATE INDEX IF NOT EXISTS psl_session_idx ON public.protection_session_locations (session_id, received_at DESC);

-- ── 3. CPO/Ops access audit (§9) — who looked at whose location, when ───
CREATE TABLE IF NOT EXISTS public.protection_access_audit (
  id          bigserial PRIMARY KEY,
  actor_id    uuid NOT NULL,
  actor_role  text NOT NULL,                   -- 'cpo' | 'ops'
  session_id  uuid NOT NULL,
  action      text NOT NULL,                   -- 'view_live' | 'view_history' | 'export'
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS protection_access_audit_session_idx
  ON public.protection_access_audit (session_id, created_at DESC);

-- ── 4. SOS linkage (§7) — an SOS carries its parent session forever ─────
ALTER TABLE public.sos_events ADD COLUMN IF NOT EXISTS protection_session_id uuid;

-- ── 5. RLS: ENABLE + FORCE, zero policies (deny-all for anon/authenticated) ──
ALTER TABLE public.protection_sessions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.protection_sessions          FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.protection_session_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.protection_session_locations FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.protection_access_audit      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.protection_access_audit      FORCE  ROW LEVEL SECURITY;
