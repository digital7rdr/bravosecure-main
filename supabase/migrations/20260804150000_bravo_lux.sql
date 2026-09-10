-- Bravo Lux — executive protection booked in fixed 3–24 h time blocks
-- (service = 'lux' on lite_bookings; dispatch/escrow/mission pipeline shared
-- with Lite auto-dispatch).

-- 1) lite_bookings: what the detail is for + the optional secure-transfer leg.
--    lux_transport JSONB shape:
--    {mode:'one_way'|'return'|'both_ways', pickup:{address,latitude,longitude},
--     dropoff:{address,latitude,longitude}, pickup_time: ISO|null, passengers:int}
ALTER TABLE lite_bookings ADD COLUMN IF NOT EXISTS task_type TEXT;
ALTER TABLE lite_bookings ADD COLUMN IF NOT EXISTS lux_transport JSONB;

-- Regularize an out-of-band column: code reads/writes lite_bookings.conversation_id
-- (org-mission.service.ts:517, booking.service.ts:923) but no migration ever
-- created it — fresh environments break without this guard. The cancel path
-- also filters `WHERE conversation_id = $1`, hence the partial index.
ALTER TABLE lite_bookings ADD COLUMN IF NOT EXISTS conversation_id UUID;
CREATE INDEX IF NOT EXISTS lite_bookings_conversation_idx
  ON lite_bookings (conversation_id) WHERE conversation_id IS NOT NULL;

-- 2) Hourly check-ins — Lux missions carry NO waypoints/checkpoints; instead
--    the lead CPO confirms each elapsed hour ("all smooth" + optional comment).
--    One row per (mission, hour); idempotent re-taps upsert nothing.
CREATE TABLE IF NOT EXISTS mission_hourly_checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES lite_bookings(id) ON DELETE CASCADE,
  hour_index INTEGER NOT NULL CHECK (hour_index >= 1 AND hour_index <= 24),
  status TEXT NOT NULL DEFAULT 'SMOOTH' CHECK (status IN ('SMOOTH', 'ISSUE')),
  comment TEXT CHECK (char_length(comment) <= 300),
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mission_hourly_checkins_uq UNIQUE (mission_id, hour_index)
);

CREATE INDEX IF NOT EXISTS mission_hourly_checkins_booking_idx
  ON mission_hourly_checkins (booking_id);

-- Repo norm (cf. 20260803210000_pro_plan_missions.sql): backend access is
-- service-role; RLS on with no policies keeps anon/PostgREST out.
ALTER TABLE mission_hourly_checkins ENABLE ROW LEVEL SECURITY;
