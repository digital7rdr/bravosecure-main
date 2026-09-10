-- Issue 11 (Testing Issues V2, PDF p.16) — "Mission Group Messaging Fails
-- Between Mobile App and Bravo Control System". CRITICAL.
--
-- org-mission.service.assignCrew creates the mission (step 3) and THEN opens the
-- Ops Room (step 5) inside a try/catch that logged at WARN and moved on. When
-- that catch fired the mission was already DISPATCHED with no comms room, so the
-- mobile mission chat had nothing to open and the console answered
-- `conversation_not_found_or_forbidden` — exactly the reported symptom, with no
-- signal anywhere that it had happened.
--
-- This column makes the failure QUERYABLE. It is a marker, not a state: the
-- mission FSM is untouched, and a successful repair simply clears it.

ALTER TABLE missions
  ADD COLUMN IF NOT EXISTS comms_room_failed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS missions_comms_room_failed_idx
  ON missions(comms_room_failed_at) WHERE comms_room_failed_at IS NOT NULL;

COMMENT ON COLUMN missions.comms_room_failed_at IS
  'Set when Ops Room creation failed during crew assign (Issue 11) — the mission is dispatched but has no comms room. Cleared when the room is repaired.';
