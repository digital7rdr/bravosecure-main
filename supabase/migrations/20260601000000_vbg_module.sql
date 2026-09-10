-- Virtual Bodyguard (VBG) module.
--
-- Two user-scoped tables backing the VBG screens:
--
-- 1. vbg_monitoring — biometric *liveness* monitoring (a duress
--    heartbeat, NOT the device auth gate). One row per user; the app
--    posts a heartbeat each scan window, and a lapsed window past the
--    missed threshold escalates to the Ops Room through the existing
--    sos_events path (see VbgService.heartbeat → SosService.raise).
--
-- 2. vbg_sra_snapshots — a record of each Security Risk Assessment the
--    principal was shown. The mobile screen refines the displayed score
--    with the live (client-side) intel feed, but we persist the server
--    baseline so ops can see what was surfaced.
--
-- Nearby key points are computed in the service from a static reference
-- set (no table) — coarse but deterministic, same philosophy as the
-- client geotag module.

CREATE TABLE IF NOT EXISTS public.vbg_monitoring (
  user_id           UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'active',   -- active | paused
  interval_min      INTEGER NOT NULL DEFAULT 60,
  enrolled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat_at TIMESTAMPTZ,
  missed_count      INTEGER NOT NULL DEFAULT 0,
  lat               DOUBLE PRECISION,
  lng               DOUBLE PRECISION
);

-- Lets a sweeper find enrollments whose window has lapsed.
CREATE INDEX IF NOT EXISTS vbg_monitoring_active_beat_idx
  ON public.vbg_monitoring(status, last_heartbeat_at);

CREATE TABLE IF NOT EXISTS public.vbg_sra_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lat             DOUBLE PRECISION,
  lng             DOUBLE PRECISION,
  risk_score      INTEGER NOT NULL,
  risks           JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS vbg_sra_snapshots_user_created_idx
  ON public.vbg_sra_snapshots(user_id, created_at DESC);
