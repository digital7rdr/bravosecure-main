-- N-20 / GAP-3 (NOTIFICATION_INDUSTRY_AUDIT_2026-07-27) — the durable
-- notification inbox the auth-service NotificationsService already writes to
-- and serves from (GET /me/notifications, markRead/markAllRead), and the
-- client activitySync.ts already hydrates the in-app bell from.
--
-- The service shipped DEFENSIVELY ("a not-yet-migrated table must never break
-- the push fan-out") — which means every record() since it landed has been
-- silently swallowed because THIS TABLE was never created. This migration is
-- the missing half: after it applies, a wake missed while a device is killed/
-- Dozed/token-dead is durably backfilled on the next foreground sync instead
-- of being permanently lost.
--
-- Scope note (sealed-sender posture): auth-service event classes ONLY
-- (booking / dispatch / mission / payout / sos / agent / incident) — metadata
-- the auth-service already owns end-to-end. NO messenger envelope events are
-- recorded here; a messenger inbox would leak the very sender→recipient
-- metadata sealed sender exists to hide.

CREATE TABLE IF NOT EXISTS public.notifications (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL,
  event_class text        NOT NULL,
  kind        text        NOT NULL,
  booking_id  uuid,
  mission_id  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);

-- list(): WHERE user_id = $1 [AND created_at > $2] ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON public.notifications (user_id, created_at DESC);

-- markRead()/markAllRead(): WHERE user_id = $1 AND read_at IS NULL.
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON public.notifications (user_id)
  WHERE read_at IS NULL;

-- The auth-service reaches this table through its own pg pool (service role).
-- RLS on with no anon policies = PostgREST/anon cannot touch it (the webapp
-- data-coverage audit's RLS-off class — do not repeat it here).
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Retention guard: the inbox is a reconcile buffer, not an archive. A row the
-- client has not synced within 30 days matches the relay's dwell posture; the
-- cleanup is a cheap opportunistic sweep on insert-heavy paths server-side
-- (no pg_cron dependency on this instance).
COMMENT ON TABLE public.notifications IS
  'Durable per-user notification inbox (auth-service event classes only — no messenger metadata). Reconcile buffer, 30-day intended retention.';
