-- Channels vs2 edge A1/A2 — WHICH organisation a notification is about.
--
-- Item 4 made a person able to belong to several organisations, and every
-- org-scoped read is stamped with the workspace they are currently looking at.
-- Nothing on a notification tap ever set that, so a manager of two orgs tapping
-- "Acme: incident reported" read the record with their OTHER org stamped on the
-- request and landed on an empty screen.
--
-- The transient lane can carry the org in its 5-minute Redis blob. The DURABLE
-- lane cannot — and that lane is the one that matters most here: it holds every
-- delivery that missed the blob window (killed app past the TTL, Doze,
-- reinstall, dead token, Redis down), i.e. exactly the cold taps that fail on
-- EVERY non-default org because the context is session-only and null at boot.
--
-- Nullable, and deliberately NOT a foreign key — same contract as
-- `incident_id` above it: this table is an append-only event log that must
-- outlive the records it references, and the reader treats an unknown org id
-- the same as a missing one (it keeps the sticky context, which is exactly
-- today's behaviour). No backfill: rows written before this migration simply
-- degrade to that fallback.
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS org_user_id uuid;

COMMENT ON COLUMN public.notifications.org_user_id IS
  'Org this event belongs to, so a multi-org recipient tap can scope the '
  'workspace surface before it reads. Nullable, no FK: append-only log, '
  'unknown ids degrade to the sticky context.';
