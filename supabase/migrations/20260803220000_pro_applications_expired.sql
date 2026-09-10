-- Bravo Secure Pro — EXPIRED terminal state (founder spec 2026-08-03):
-- when the covered period ends without renewal the plan reads EXPIRED on the
-- client status screen (with a one-tap "Renew with current details" or a
-- customised re-application) and in the ops console. Flipped lazily by a
-- read-path sweep (no cron): ACTIVE + current_period_end < now() → EXPIRED.
-- EXPIRED is NOT in ux_pro_applications_open, so renewing (a fresh
-- application) is allowed immediately.

ALTER TABLE public.pro_applications
  DROP CONSTRAINT IF EXISTS pro_applications_status_check;
ALTER TABLE public.pro_applications
  ADD CONSTRAINT pro_applications_status_check
  CHECK (status IN ('PENDING_PROPOSAL','PROPOSAL_CREATED','REVISION_REQUESTED','ACCEPTED','ACTIVE','REJECTED','EXPIRED'));
