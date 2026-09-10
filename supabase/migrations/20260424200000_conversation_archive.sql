-- Conversation archival for mission ops-rooms.
--
-- When a mission reaches a terminal state (COMPLETED / ABORTED) the ops room
-- should stop accepting new traffic. Messages remain readable for audit —
-- we just flip a flag so the client UI and the conversations list query can
-- filter archived rooms out of the active channel list.
--
-- Keeping this as a nullable timestamp (plus a reason) means active chats are
-- still identifiable by `archived_at IS NULL` and queries against mission
-- comms stay trivial.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS archived_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_reason TEXT;

CREATE INDEX IF NOT EXISTS conversations_active_idx
  ON public.conversations(kind, created_at DESC)
  WHERE archived_at IS NULL;
