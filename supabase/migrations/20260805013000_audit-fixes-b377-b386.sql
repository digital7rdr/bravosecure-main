-- Audit fix migration (2026-08-05) — B-377..B-386 remediation support.
--
-- 1) B-386 — lite_bookings.confirmed_at: the legacy cancel window is anchored
--    to the actual CONFIRMED flip (stamped in payWithCredits). Old rows stay
--    NULL and the code COALESCEs to created_at (previous behavior).
ALTER TABLE lite_bookings ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

-- 2) B-383 + B-387 — reconcile every ACTIVE Pro plan's current_period_end with
--    the proposal the client actually PAID for:
--
--      current_period_end := latest_proposal.coverage_end + 1 day   (exclusive)
--
--    • B-383: activate() used to write `coverage_end::date::timestamptz` =
--      midnight at the START of the final day, so a plan expired the moment its
--      advertised last day began. The new convention (and the new code) is the
--      EXCLUSIVE end of that day.
--    • B-387: at least one live plan (paid 4 000 BC for 2026-08-03 → 2026-11-03)
--      carries `activated_at + 30 days` instead — written by an intermediate
--      build during the 2026-08-03 Pro session; no committed code path produces
--      it. Left alone it would sweep the plan EXPIRED two months early.
--
--    Deriving from the proposal is VALUE-idempotent: re-running this file is a
--    no-op, so it needs no marker table. Only ACTIVE rows are touched — EXPIRED
--    / CANCELLED history stays exactly as it is.
UPDATE pro_applications pa
   SET current_period_end = (p.coverage_end::date + 1)::timestamptz,
       updated_at = now()
  FROM (
    SELECT DISTINCT ON (application_id) application_id, coverage_end
      FROM pro_proposals
     ORDER BY application_id, version DESC
  ) p
 WHERE p.application_id = pa.id
   AND pa.status = 'ACTIVE'
   AND (pa.current_period_end IS DISTINCT FROM (p.coverage_end::date + 1)::timestamptz);
