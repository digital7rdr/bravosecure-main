-- Auto-dispatch — booking FSM trigger update (BUILD_RUNBOOK Step 2).
--
-- Deliberately a SEPARATE migration from 20260620000000_auto_dispatch.sql: that
-- migration ADDs the 'DISPATCHING' / 'NO_PROVIDER' values to lite_booking_status,
-- and Postgres forbids referencing a freshly-added enum value in the SAME
-- transaction. By the time this file runs, those values are committed and the
-- trigger body below can name them safely.
--
-- Mirrors the TypeScript FSM in apps/auth-service/src/booking/state-machine.service.ts.
-- The drift test state-machine.drift.spec.ts parses THIS file and asserts the
-- DB trigger and the TS FSM stay in lock-step (a service method that bypasses
-- the FSM helper still can't write an illegal transition).
CREATE OR REPLACE FUNCTION lite_bookings_fsm_check() RETURNS TRIGGER AS $$
BEGIN
  -- No-op when status didn't change.
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;

  -- Allowed transitions, mirrored from booking/state-machine.service.ts.
  -- Listed exhaustively so an audit reader sees the legal graph at a glance.
  -- Any pair not in this set raises. (DISPATCHING / NO_PROVIDER are the
  -- auto-dispatch additions; everything else is unchanged.)
  IF NOT (
    (OLD.status = 'DRAFT'            AND NEW.status IN ('PENDING_OPS','DISPATCHING','CANCELLED'))
    OR (OLD.status = 'DISPATCHING'     AND NEW.status IN ('CONFIRMED','NO_PROVIDER','CANCELLED'))
    OR (OLD.status = 'PENDING_OPS'     AND NEW.status IN ('OPS_APPROVED','CANCELLED'))
    OR (OLD.status = 'OPS_APPROVED'    AND NEW.status IN ('PAYMENT_PENDING','CANCELLED'))
    OR (OLD.status = 'PAYMENT_PENDING' AND NEW.status IN ('CONFIRMED','CANCELLED'))
    OR (OLD.status = 'CONFIRMED'       AND NEW.status IN ('LIVE','CANCELLED'))
    OR (OLD.status = 'LIVE'            AND NEW.status IN ('COMPLETED','CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'invalid_booking_transition: % -> %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- CREATE OR REPLACE resets function attributes, so re-pin the hardened
-- search_path that 20260603120000_rls_and_search_path_followups applied —
-- otherwise this silently reverts the search-path-injection hardening.
ALTER FUNCTION public.lite_bookings_fsm_check() SET search_path = pg_catalog;

-- The trigger itself was attached in 20260509100000_phase2_data_integrity.sql;
-- CREATE OR REPLACE FUNCTION swaps the body in place, so no DROP/CREATE TRIGGER
-- is needed here.
