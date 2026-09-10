-- ──────────────────────────────────────────────────────────────────────
-- Mission-start readiness gate (founder 2026-08-11).
--
-- A protection session must not go LIVE because ONE side happens to send a
-- location fix. Both the protected customer AND the assigned CPO have to hold
-- real, currently-granted device capability: location permission, location
-- services switched on, precise (not coarse) accuracy, connectivity, and an
-- actually-obtained fix. Until then the session sits in its pre-active state
-- and each side is told exactly what IT is missing.
--
--   REQUESTED  (= WAITING_FOR_READINESS while either side is not ready)
--        ↓  customer ready AND cpo ready AND a real fix arrives
--     ACTIVE
--
-- The backend is the source of truth: the apps only REPORT what the OS told
-- them, and this table is what the activation decision reads. A device that
-- merely rendered a map is not ready — `location_available` is reported only
-- after a position is genuinely obtained.
--
-- RLS posture: ENABLE + FORCE, zero policies (deny-all for anon/authenticated;
-- the backend connects as a rolbypassrls role). Access separation lives in the
-- service-layer WHERE clauses, never in client trust.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.protection_session_readiness (
  session_id          uuid NOT NULL REFERENCES public.protection_sessions(id) ON DELETE CASCADE,
  role                text NOT NULL CHECK (role IN ('customer','cpo')),
  user_id             uuid NOT NULL,
  location_permission boolean NOT NULL DEFAULT false,
  location_services   boolean NOT NULL DEFAULT false,
  precise_location    boolean NOT NULL DEFAULT false,
  connectivity        boolean NOT NULL DEFAULT false,
  -- Set only after a position was actually obtained — "the map rendered" is
  -- explicitly NOT evidence of location capability.
  location_available  boolean NOT NULL DEFAULT false,
  -- Derived so no caller can report itself ready while a requirement is false.
  ready               boolean GENERATED ALWAYS AS (
                        location_permission AND location_services AND
                        precise_location AND connectivity AND location_available
                      ) STORED,
  platform            text,
  reported_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, role)
);

CREATE INDEX IF NOT EXISTS protection_session_readiness_ready_idx
  ON public.protection_session_readiness (session_id, ready);

ALTER TABLE public.protection_session_readiness ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.protection_session_readiness FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.protection_session_readiness IS
  'Per-side device readiness for a protection session. Both rows must be ready before REQUESTED→ACTIVE. Reported by the apps, judged by the backend.';
COMMENT ON COLUMN public.protection_session_readiness.ready IS
  'GENERATED — every requirement true. Never client-settable.';
COMMENT ON COLUMN public.protection_session_readiness.location_available IS
  'A real position was obtained. A rendered map does not count.';
