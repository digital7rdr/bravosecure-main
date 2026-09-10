-- Client review vs2 item 16 — the incident notification must deep-link.
--
-- The transient lane already carries enough to route: the Redis detail blob
-- holds the event's fields for 5 minutes. The DURABLE lane does not — the
-- notifications row records only booking_id / mission_id, both NULL for an
-- incident, so the bell row and every delivery that misses the blob window
-- (killed app past the TTL, Doze, reinstall, dead token, Redis down) can only
-- ever land on a list screen.
--
-- One nullable column closes that. Deliberately NOT a foreign key to
-- incident_reports: this table is an append-only event log that must outlive
-- the records it references, and a cascade or a RESTRICT here would either
-- rewrite history or block a legitimate delete. The reader treats a dangling
-- id the same as a missing one — it falls back to the queue.
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS incident_id uuid;

COMMENT ON COLUMN public.notifications.incident_id IS
  'Deep-link target for incident-* kinds. Nullable, no FK: append-only log, '
  'dangling ids degrade to the list screen.';
