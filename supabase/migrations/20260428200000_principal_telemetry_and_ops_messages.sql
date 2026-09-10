-- Principal/client live GPS + ops console free-form messaging.
--
-- Two additions, both consumed by /live in the ops console:
--
-- 1. missions.client_lat/lng/recorded_at — latest position pushed by the
--    booking client's app (LiveTrackingScreen). Mirrors the existing
--    current_lat/current_lng/heading_deg/speed_kph that the CPO Lead
--    pushes via the mission-lead endpoint, but kept in separate columns
--    so the live map can render two distinct markers without the two
--    feeds racing for one row.
--
-- 2. system_broadcasts already supports an 'ops_message' kind; no schema
--    change is needed for messaging itself (the ops console writes
--    plaintext rows into system_broadcasts pointed at
--    missions.comms_channel_id). This file just documents the contract.

ALTER TABLE missions
  ADD COLUMN IF NOT EXISTS client_lat           DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS client_lng           DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS client_recorded_at   TIMESTAMPTZ;
