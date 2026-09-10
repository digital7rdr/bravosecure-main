-- Auto-dispatch (Uber-style nearest-agency matching) — core schema.
-- BUILD_RUNBOOK Step 2. Every statement is additive + idempotent
-- (IF NOT EXISTS / ADD VALUE IF NOT EXISTS), so re-running is a no-op and
-- legacy data is untouched. Pairs with the booking FSM mirror in
-- apps/auth-service/src/booking/state-machine.service.ts.

-- ── Enums ──────────────────────────────────────────────────────────────────
-- Offer-status enum for the cascade. Created fresh (no prior type). CREATE TYPE
-- has no IF NOT EXISTS, so guard it so the migration is re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dispatch_offer_status') THEN
    CREATE TYPE dispatch_offer_status AS ENUM
      ('OFFERED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED');
  END IF;
END$$;

-- New booking lifecycle states for the auto flow. ADD VALUE is additive; the
-- new labels are NOT used in any DML in this migration (the create() /
-- DispatchService branches that write them land in later steps), so there is
-- no same-transaction "unsafe use of a new enum value" hazard.
ALTER TYPE lite_booking_status ADD VALUE IF NOT EXISTS 'DISPATCHING';
ALTER TYPE lite_booking_status ADD VALUE IF NOT EXISTS 'NO_PROVIDER';

-- ── dispatch_offers ────────────────────────────────────────────────────────
-- One row per offer in the nearest-first cascade.
CREATE TABLE IF NOT EXISTS public.dispatch_offers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       uuid NOT NULL REFERENCES public.lite_bookings(id) ON DELETE CASCADE,
  provider_user_id uuid NOT NULL,            -- the company agent (agents.user_id)
  rank             int  NOT NULL,            -- 1 = nearest, 2 = next…
  distance_km      numeric(7,2),             -- straight-line to pickup; coarse, for display/audit only
  status           dispatch_offer_status NOT NULL DEFAULT 'OFFERED',
  offered_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,     -- offered_at + OFFER_TTL_SECONDS
  responded_at     timestamptz,
  reject_reason    text
);

-- One live (OFFERED) offer per provider at a time — race guard ONLY. This does
-- NOT cap concurrent active missions (D6); free-CPO capacity is enforced in the
-- Step 6 eligibility query, not by this index.
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_offers_one_live_per_provider
  ON public.dispatch_offers (provider_user_id) WHERE status = 'OFFERED';
-- "who currently holds / has held the offer for this booking"
CREATE INDEX IF NOT EXISTS dispatch_offers_booking
  ON public.dispatch_offers (booking_id, status);
-- watchdog scan (Step 8): live offers past their TTL
CREATE INDEX IF NOT EXISTS dispatch_offers_expiry
  ON public.dispatch_offers (expires_at) WHERE status = 'OFFERED';

-- Deny-by-default RLS posture (20260603100000_enable_rls_deny_by_default):
-- ENABLE + FORCE with NO public policies so the table is unreachable via
-- PostgREST by anon / authenticated. Only a BYPASSRLS role (service_role /
-- postgres) reads/writes it — matches org_members / cpo_shift_sessions.
ALTER TABLE public.dispatch_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_offers FORCE  ROW LEVEL SECURITY;

-- ── lite_bookings: auto-dispatch columns ───────────────────────────────────
ALTER TABLE public.lite_bookings
  ADD COLUMN IF NOT EXISTS dispatch_mode             text,        -- 'auto' = new flow; NULL = legacy admin flow
  ADD COLUMN IF NOT EXISTS assigned_provider_user_id uuid,        -- set on accept (the company agent)
  ADD COLUMN IF NOT EXISTS dispatch_started_at       timestamptz,
  ADD COLUMN IF NOT EXISTS dispatch_settled_at       timestamptz,
  ADD COLUMN IF NOT EXISTS crew_deadline_at          timestamptz; -- charged-but-never-crewed SLA (Part III LB5)

-- ── agents: region + map-aware location for proximity ranking ──────────────
-- last_lat/last_lng/last_location_at already exist where the agent app writes
-- them; IF NOT EXISTS makes this safe on every env. last_location is the new
-- PostGIS geography point that backs the index-driven nearest search (Step 6).
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS region_code      text,
  ADD COLUMN IF NOT EXISTS last_lat         double precision,
  ADD COLUMN IF NOT EXISTS last_lng         double precision,
  ADD COLUMN IF NOT EXISTS last_location_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_location    geography(Point, 4326);

-- GiST index for ST_DWithin / <-> nearest-neighbour on the agency location.
CREATE INDEX IF NOT EXISTS agents_last_location_gix
  ON public.agents USING GIST (last_location);
-- Covering index for the duty pool the ranking query filters on before geo.
CREATE INDEX IF NOT EXISTS agents_dispatch_pool
  ON public.agents (status, on_duty, type) WHERE type = 'company';
