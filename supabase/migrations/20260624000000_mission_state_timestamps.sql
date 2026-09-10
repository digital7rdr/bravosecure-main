-- Auto-dispatch Step 10: per-state mission timestamps for the proof-of-completion gate.
--
-- missions had only started_at (set at creation/DISPATCHED) and ended_at (set at
-- abort/close). The completion gate (§40) needs to know WHEN the mission entered
-- PICKUP and LIVE to verify real progression (DISPATCHED->PICKUP->LIVE) and to
-- measure on-task time (LIVE duration). updated_at is unusable for this — it's
-- bumped by every telemetry heartbeat. These are additive + nullable: existing
-- rows stay NULL (the gate treats NULL as "unverifiable" and falls back to
-- telemetry evidence), new transitions stamp them.
ALTER TABLE public.missions ADD COLUMN IF NOT EXISTS pickup_at timestamptz;
ALTER TABLE public.missions ADD COLUMN IF NOT EXISTS live_at   timestamptz;
