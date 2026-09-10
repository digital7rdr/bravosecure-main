-- Auto-dispatch — booking FSM trigger update for AGENCY_NO_SHOW (Step 8 / LB5).
--
-- SEPARATE migration from 20260622000000 (the ADD VALUE) per the enum-can't-be-used-
-- in-the-same-txn rule. The ONLY change vs 20260620000001 is the CONFIRMED row's
-- IN-list gaining 'AGENCY_NO_SHOW' (the crew-SLA no-show terminal).
--
-- Mirrors apps/auth-service/src/booking/state-machine.service.ts. The drift test
-- (state-machine.drift.spec.ts) parses THIS file — its MIGRATION_PATH was repointed
-- here so TS <-> DB stay in lock-step.
CREATE OR REPLACE FUNCTION lite_bookings_fsm_check() RETURNS TRIGGER AS $$
BEGIN
  -- No-op when status didn't change.
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;

  -- Allowed transitions, mirrored from booking/state-machine.service.ts.
  IF NOT (
    (OLD.status = 'DRAFT'            AND NEW.status IN ('PENDING_OPS','DISPATCHING','CANCELLED'))
    OR (OLD.status = 'DISPATCHING'     AND NEW.status IN ('CONFIRMED','NO_PROVIDER','CANCELLED'))
    OR (OLD.status = 'PENDING_OPS'     AND NEW.status IN ('OPS_APPROVED','CANCELLED'))
    OR (OLD.status = 'OPS_APPROVED'    AND NEW.status IN ('PAYMENT_PENDING','CANCELLED'))
    OR (OLD.status = 'PAYMENT_PENDING' AND NEW.status IN ('CONFIRMED','CANCELLED'))
    OR (OLD.status = 'CONFIRMED'       AND NEW.status IN ('LIVE','AGENCY_NO_SHOW','CANCELLED'))
    OR (OLD.status = 'LIVE'            AND NEW.status IN ('COMPLETED','CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'invalid_booking_transition: % -> %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- CREATE OR REPLACE resets function attributes, so re-pin the hardened search_path
-- (20260603120000) — otherwise this silently reverts the injection hardening.
ALTER FUNCTION public.lite_bookings_fsm_check() SET search_path = pg_catalog;

-- The trigger was attached in 20260509100000_phase2_data_integrity.sql; CREATE OR
-- REPLACE FUNCTION swaps the body in place, so no DROP/CREATE TRIGGER is needed.
