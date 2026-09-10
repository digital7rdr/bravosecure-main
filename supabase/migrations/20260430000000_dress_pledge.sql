-- Agent dress pledge (per-application).
--
-- Captured at apply-time so ops can audit what each candidate said
-- they would actually wear, against the dress brief on the booking.
--   • job_applications.dress_pledge       — agent's free-form description
--   • job_applications.dress_pledged_at   — when they pledged (UTC)
--
-- Required for new applies; older rows stay NULL until the agent
-- re-applies, which the API now forces through the pledge sheet.

ALTER TABLE job_applications
  ADD COLUMN IF NOT EXISTS dress_pledge     TEXT,
  ADD COLUMN IF NOT EXISTS dress_pledged_at TIMESTAMPTZ;
