-- Bravo Secure — Ops Admin Console backend
-- Powers the HQ ops console (apps/ops-console):
--   • admin_users           — OPS / SUPERVISOR / ADMIN roster + role
--   • missions              — live booking execution (DIFC → Palm Jumeirah etc)
--   • mission_waypoints     — per-mission route timeline rows
--   • mission_crew          — CPOs assigned to a mission (many-to-many)
--   • mission_principals    — VIP(s) on board
--   • sos_events            — red-alert triggers, ack + escalation
--   • jobs                  — booking published to agent feed after ops approval
--   • job_applications      — agent applies; admin shortlists/assigns
--   • ops_audit             — append-only admin-action log
--   • live_feed_events      — UI activity stream (SSE source of truth)
--
-- Idempotent migrations — safe to re-run.

-- ─── enums ──────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'admin_role') THEN
    CREATE TYPE admin_role AS ENUM ('OPS', 'SUPERVISOR', 'ADMIN');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mission_status') THEN
    CREATE TYPE mission_status AS ENUM (
      'DISPATCHED',    -- crew en route to pickup
      'PICKUP',        -- principal onboard
      'LIVE',          -- in transit
      'SOS',           -- emergency triggered
      'COMPLETED',     -- dropoff done cleanly
      'ABORTED'        -- ops manually terminated
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_status') THEN
    CREATE TYPE job_status AS ENUM (
      'PUBLISHED',          -- accepting applications
      'REVIEW',             -- admin reviewing apps
      'ASSIGNED',           -- crew selected, not yet dispatched
      'DISPATCHED',         -- mission created
      'CANCELLED'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'application_status') THEN
    CREATE TYPE application_status AS ENUM (
      'PENDING', 'SHORTLISTED', 'ASSIGNED', 'REJECTED', 'WITHDRAWN'
    );
  END IF;
END$$;

-- ─── admin_users ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS admin_users (
  user_id        UUID PRIMARY KEY,
  display_name   TEXT NOT NULL,
  call_sign      TEXT NOT NULL UNIQUE,        -- 'OPS-01', 'SUP-01', etc
  role           admin_role NOT NULL DEFAULT 'OPS',
  region         TEXT NOT NULL DEFAULT 'AE',  -- primary region they manage
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  last_active_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_users_role_idx ON admin_users(role) WHERE active = TRUE;

INSERT INTO admin_users (user_id, display_name, call_sign, role, region)
VALUES
  (gen_random_uuid(), 'Ops Supervisor One', 'OPS-01', 'SUPERVISOR', 'AE'),
  (gen_random_uuid(), 'Ops Handler Two',    'OPS-02', 'OPS',        'AE'),
  (gen_random_uuid(), 'Ops Handler Three',  'OPS-03', 'OPS',        'SA'),
  (gen_random_uuid(), 'Admin Root',         'ADM-01', 'ADMIN',      'AE')
ON CONFLICT (call_sign) DO NOTHING;

-- ─── missions ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS missions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID NOT NULL REFERENCES lite_bookings(id) ON DELETE CASCADE,
  status           mission_status NOT NULL DEFAULT 'DISPATCHED',
  short_code       TEXT NOT NULL,            -- 'MSN-4817'
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at         TIMESTAMPTZ,
  ended_by         UUID,                     -- admin_users.user_id who aborted/closed
  end_reason       TEXT,
  current_lat      DOUBLE PRECISION,
  current_lng      DOUBLE PRECISION,
  heading_deg      DOUBLE PRECISION,
  speed_kph        DOUBLE PRECISION,
  risk_level       TEXT NOT NULL DEFAULT 'LOW',   -- LOW / ELEV / HIGH
  comms_pct        INTEGER NOT NULL DEFAULT 100,
  gps_rtk_lock     BOOLEAN NOT NULL DEFAULT TRUE,
  vehicle_model    TEXT,
  vehicle_plate    TEXT,
  vehicle_armour   TEXT,
  comms_channel_id UUID,                     -- ops-room group conversation (set on dispatch)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (booking_id)
);

CREATE INDEX IF NOT EXISTS missions_status_idx ON missions(status);
CREATE INDEX IF NOT EXISTS missions_short_idx  ON missions(short_code);

-- ─── mission_waypoints ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mission_waypoints (
  id           BIGSERIAL PRIMARY KEY,
  mission_id   UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  tag          TEXT NOT NULL,        -- 'CHKPT 01', 'RECON OK', 'PICKUP', ...
  event        TEXT NOT NULL,        -- 'Checkpoint · Business Bay Bridge'
  sub          TEXT,                 -- 'armed clearance · no delay'
  planned_at   TIMESTAMPTZ,
  settled_at   TIMESTAMPTZ,
  state        TEXT NOT NULL DEFAULT 'pending',  -- pending | current | done | sos
  UNIQUE (mission_id, seq)
);

CREATE INDEX IF NOT EXISTS mission_waypoints_mission_idx
  ON mission_waypoints(mission_id, seq);

-- ─── mission_crew ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mission_crew (
  mission_id   UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  agent_id     UUID NOT NULL,
  slot         INTEGER NOT NULL DEFAULT 0,
  role         TEXT NOT NULL,        -- 'LEAD', 'CP', 'DRIVER', 'RESERVE'
  call_sign    TEXT NOT NULL,        -- 'CPO-22'
  armed        BOOLEAN NOT NULL DEFAULT FALSE,
  comms_ch     INTEGER NOT NULL DEFAULT 1,
  mic_hot      BOOLEAN NOT NULL DEFAULT FALSE,
  status       TEXT NOT NULL DEFAULT 'active',  -- active | sos | standby | off
  PRIMARY KEY (mission_id, agent_id)
);

-- ─── mission_principals ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mission_principals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id   UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  sub_label    TEXT,                 -- 'TIER 1 · PRINCIPAL · ONBOARD'
  phone        TEXT,
  dob_year     INTEGER,
  onboard      BOOLEAN NOT NULL DEFAULT FALSE,
  order_idx    INTEGER NOT NULL DEFAULT 0
);

-- ─── sos_events ─────────────────────────────────────────────────────────────

-- sos_events is created in `20260416000000_init_phase1.sql` as a booking-scoped
-- table. This migration adds the ops-admin / mission-scoped columns onto the
-- same table so both consumers share one row. ALTER … ADD COLUMN IF NOT EXISTS
-- keeps it safe to re-run.
CREATE TABLE IF NOT EXISTS sos_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sos_events
  ADD COLUMN IF NOT EXISTS mission_id        UUID,
  ADD COLUMN IF NOT EXISTS agent_id          UUID,
  ADD COLUMN IF NOT EXISTS agent_call_sign   TEXT,
  ADD COLUMN IF NOT EXISTS reason            TEXT,
  ADD COLUMN IF NOT EXISTS lat               DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng               DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS acknowledged_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acknowledged_by   UUID,
  ADD COLUMN IF NOT EXISTS escalated_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escalated_to      TEXT,
  ADD COLUMN IF NOT EXISTS resolved_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolution        TEXT;

-- mission_id FK can't be added inline above because some existing rows from
-- the booking-scoped flow may have NULL — keep it as a plain UUID column.
CREATE INDEX IF NOT EXISTS sos_events_mission_idx ON sos_events(mission_id);
CREATE INDEX IF NOT EXISTS sos_events_unacked_idx
  ON sos_events(triggered_at DESC) WHERE acknowledged_at IS NULL;

-- ─── jobs ───────────────────────────────────────────────────────────────────

-- Why: init_phase1 created a DIFFERENT `jobs` / `job_applications` pair (the
-- geo-broadcast model: broadcast_area / payout_cents / expires_at, booking_id
-- -> bookings). The CREATE TABLE IF NOT EXISTS below therefore silently did
-- nothing on a clean apply, and the indexes that follow referenced columns
-- (dispatch_at, fit_score) that were never created — aborting this migration
-- before ops_audit and failing five later ones. The ops dispatch board below
-- is a different table that happens to share the name, and it is the shape
-- auth-service actually queries (cpo_slots, slots_filled, decided_at).
-- The guard keys on a Phase-1-ONLY column so a Phase-2 table can never match,
-- which makes this a no-op on any database that already has the board.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'jobs'
      AND column_name  = 'broadcast_area'
  ) THEN
    DROP TABLE IF EXISTS public.job_applications CASCADE;
    DROP TABLE IF EXISTS public.jobs CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID NOT NULL REFERENCES lite_bookings(id) ON DELETE CASCADE,
  short_code       TEXT NOT NULL UNIQUE,     -- 'JF-2026-0094'
  status           job_status NOT NULL DEFAULT 'PUBLISHED',
  region_code      TEXT NOT NULL,
  route_label      TEXT NOT NULL,            -- 'KAUST → Ritz JED'
  dispatch_at      TIMESTAMPTZ NOT NULL,
  duration_hours   INTEGER NOT NULL DEFAULT 4,
  cpo_slots        INTEGER NOT NULL DEFAULT 1,
  requires_armed   BOOLEAN NOT NULL DEFAULT FALSE,
  requires_armour  TEXT,                     -- 'B4' / 'B6' / NULL
  slots_filled     INTEGER NOT NULL DEFAULT 0,
  published_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_by     UUID,                     -- admin_users.user_id
  closed_at        TIMESTAMPTZ,
  UNIQUE (booking_id)
);

CREATE INDEX IF NOT EXISTS jobs_status_idx     ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_dispatch_idx   ON jobs(dispatch_at)     WHERE status IN ('PUBLISHED', 'REVIEW');

-- ─── job_applications ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS job_applications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  agent_id        UUID NOT NULL,
  agent_call_sign TEXT NOT NULL,
  status          application_status NOT NULL DEFAULT 'PENDING',
  rank            INTEGER,
  fit_score       INTEGER,                   -- 0-100
  distance_km     NUMERIC(6, 2),
  rate_ccy        TEXT NOT NULL DEFAULT 'AED',
  rate_per_hour   NUMERIC(10, 2),
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at      TIMESTAMPTZ,
  decided_by      UUID,
  UNIQUE (job_id, agent_id)
);

CREATE INDEX IF NOT EXISTS job_applications_job_idx
  ON job_applications(job_id, fit_score DESC NULLS LAST);

-- ─── ops_audit ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ops_audit (
  id            BIGSERIAL PRIMARY KEY,
  actor_id      UUID,
  actor_role    TEXT NOT NULL,                -- 'OPS' | 'SUPERVISOR' | 'ADMIN' | 'SYSTEM'
  actor_call    TEXT,                         -- cached display value e.g. 'OPS-01'
  action        TEXT NOT NULL,                -- 'booking.approve' | 'mission.abort' | ...
  subject_type  TEXT NOT NULL,                -- 'booking' | 'mission' | 'agent' | 'job' | 'sos'
  subject_id    TEXT NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ops_audit_subject_idx
  ON ops_audit(subject_type, subject_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ops_audit_actor_idx
  ON ops_audit(actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ops_audit_recent_idx
  ON ops_audit(created_at DESC);

-- ─── live_feed_events ──────────────────────────────────────────────────────
-- Powers the Dashboard > Activity stream. Events expire after 7 days.

CREATE TABLE IF NOT EXISTS live_feed_events (
  id            BIGSERIAL PRIMARY KEY,
  kind          TEXT NOT NULL,           -- 'sos' | 'booking.submit' | 'booking.approve' | ...
  severity      TEXT NOT NULL DEFAULT 'info',  -- info | ok | warn | err
  actor         TEXT,                    -- 'OPS-01', 'CPO-44', 'SYSTEM'
  subject       TEXT,                    -- short id reference
  message       TEXT NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS live_feed_recent_idx
  ON live_feed_events(created_at DESC);

-- ─── triggers ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION touch_missions_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS missions_touch_updated_at ON missions;
CREATE TRIGGER missions_touch_updated_at
  BEFORE UPDATE ON missions
  FOR EACH ROW EXECUTE FUNCTION touch_missions_updated_at();
