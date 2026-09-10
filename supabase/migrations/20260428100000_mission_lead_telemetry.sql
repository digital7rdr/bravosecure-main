-- Mission lead, multi-team prep, route precompute, live telemetry.
--
--   - mission_crew.is_lead          → which CPO is the team lead (manual marks)
--   - mission_crew.team_idx         → 0 = car A, 1 = car B (multi-car future-proof)
--   - missions.route_distance_m     → cached Mapbox Directions total distance
--   - missions.route_duration_s     → cached estimated drive time
--   - missions.route_polyline       → encoded polyline string (mapbox format)
--   - mission_telemetry             → per-push GPS history from lead's phone
--   - mission_waypoints.marked_by   → which agent marked it (manual) or NULL (auto)

ALTER TABLE mission_crew
  ADD COLUMN IF NOT EXISTS is_lead   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS team_idx  INTEGER NOT NULL DEFAULT 0;

-- Only one lead per (mission, team_idx).
CREATE UNIQUE INDEX IF NOT EXISTS mission_crew_one_lead_per_team
  ON mission_crew(mission_id, team_idx)
  WHERE is_lead = TRUE;

ALTER TABLE missions
  ADD COLUMN IF NOT EXISTS route_distance_m   INTEGER,
  ADD COLUMN IF NOT EXISTS route_duration_s   INTEGER,
  ADD COLUMN IF NOT EXISTS route_polyline     TEXT;

ALTER TABLE mission_waypoints
  ADD COLUMN IF NOT EXISTS marked_by  UUID,
  ADD COLUMN IF NOT EXISTS marked_via TEXT;   -- 'lead', 'auto_distance', 'ops'

CREATE TABLE IF NOT EXISTS mission_telemetry (
  id            BIGSERIAL PRIMARY KEY,
  mission_id    UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  agent_id      UUID NOT NULL,
  lat           DOUBLE PRECISION NOT NULL,
  lng           DOUBLE PRECISION NOT NULL,
  heading_deg   DOUBLE PRECISION,
  speed_kph     DOUBLE PRECISION,
  accuracy_m    DOUBLE PRECISION,
  distance_to_dropoff_m  INTEGER,
  battery_pct   INTEGER,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mission_telemetry_mission_idx
  ON mission_telemetry(mission_id, recorded_at DESC);
