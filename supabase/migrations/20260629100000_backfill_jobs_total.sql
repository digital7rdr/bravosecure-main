-- RATING-CARD (#10) backfill — agents.jobs_total drifted to 0 for AGENCIES
-- because the legacy completeBooking path bumped only the deployed crew CPOs
-- (paidIds), never the agency org user (lite_bookings.assigned_provider_user_id).
-- The going-forward gap is closed in ops.service.ts (agency +1 per completion);
-- this corrects the already-accumulated history.
--
-- SET (not increment) makes it idempotent / self-healing regardless of which
-- writers fired before. The definition MUST stay identical to the going-forward
-- bumps or the column will drift again:
--   provider leg: COMPLETED bookings where the agent is assigned_provider_user_id
--   crew leg:     COMPLETED missions where the agent is crew AND is NOT the
--                 booking's provider (IS DISTINCT FROM avoids double-counting a
--                 self-provider CPO, who is already covered by the provider leg).
-- AGENCY_NO_SHOW / ABORTED / CANCELLED are excluded (status = 'COMPLETED' only).
UPDATE agents a
SET jobs_total =
  (SELECT COUNT(*) FROM lite_bookings b
     WHERE b.assigned_provider_user_id = a.user_id
       AND b.status = 'COMPLETED')
  +
  (SELECT COUNT(DISTINCT mc.mission_id) FROM mission_crew mc
     JOIN missions m  ON m.id  = mc.mission_id AND m.status = 'COMPLETED'
     JOIN lite_bookings b2 ON b2.id = m.booking_id
     WHERE mc.agent_id = a.user_id
       AND b2.assigned_provider_user_id IS DISTINCT FROM a.user_id);
