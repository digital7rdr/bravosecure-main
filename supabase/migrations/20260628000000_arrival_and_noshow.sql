-- Arrival deadline + identity-handshake markers (BUILD_RUNBOOK Step 16).
--
-- arrival_deadline_at — set at crew-assign (Step 13). The no-show watchdog re-dispatches a
-- booking whose crew was assigned (mission DISPATCHED) but never reached PICKUP by this
-- deadline, WITHOUT re-charging the client (the escrow hold persists). Distinct from
-- crew_deadline_at (Step 7), which bounds the agency CREWING the job, not arriving.
--
-- not_my_guard_at — stamped when the client fires "this is NOT my guard" (which also raises
-- a booking-scoped SOS). The verify code itself is HMAC-derived (booking_id + time bucket +
-- server secret) and NEVER stored, so there is no verify_code column. missions.pickup_at
-- (Step 10) already serves as the arrival timestamp — no separate arrived_at column.

ALTER TABLE public.lite_bookings
  ADD COLUMN IF NOT EXISTS arrival_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS not_my_guard_at     TIMESTAMPTZ;

-- The no-show sweep scans CONFIRMED bookings whose crew hasn't arrived in time.
CREATE INDEX IF NOT EXISTS lite_bookings_arrival_due
  ON public.lite_bookings(arrival_deadline_at)
  WHERE status = 'CONFIRMED' AND arrival_deadline_at IS NOT NULL;
