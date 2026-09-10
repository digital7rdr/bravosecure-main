-- Bravo Secure Pro — CANCELLED terminal state (founder spec 2026-08-04):
-- the client can withdraw their application any time before activation
-- (Pending Proposal / Proposal Ready / Revision Requested / Accepted), and
-- ops can cancel on the client's behalf from the console. Terminal like
-- REJECTED; the status screen offers "Apply Again".
-- CANCELLED is NOT in ux_pro_applications_open (the index enumerates the
-- open statuses), so a fresh application is allowed immediately.

ALTER TABLE public.pro_applications
  DROP CONSTRAINT IF EXISTS pro_applications_status_check;
ALTER TABLE public.pro_applications
  ADD CONSTRAINT pro_applications_status_check
  CHECK (status IN ('PENDING_PROPOSAL','PROPOSAL_CREATED','REVISION_REQUESTED','ACCEPTED','ACTIVE','REJECTED','EXPIRED','CANCELLED'));
