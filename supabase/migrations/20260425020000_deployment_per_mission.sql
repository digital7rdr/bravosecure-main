-- Deployment checks are now per-mission rather than a one-time onboarding gate.
-- Agents auto-activate when approved; the 4 deployment checks (dress, vehicle,
-- equip, briefing) are seeded per mission when a job is dispatched.

ALTER TABLE agent_deployment_checks
  ADD COLUMN IF NOT EXISTS mission_id UUID REFERENCES missions(id) ON DELETE CASCADE;

-- Existing onboarding-time rows have no mission — set them null (they're legacy).
-- Future rows will always carry a mission_id.

-- Index for fast per-mission lookup.
CREATE INDEX IF NOT EXISTS deploy_checks_mission_idx
  ON agent_deployment_checks(mission_id)
  WHERE mission_id IS NOT NULL;
