-- B-706 (NOTIFICATION_ACTIVITY_AUDIT_2026-08-30) — make deletion durable, and stop the
-- watermark re-delivering the row it just read.
--
-- Two defects, one migration, because they are the same user-visible bug:
-- "I delete the notification, again it came back."
--
-- ── A-3: there was no deletion ────────────────────────────────────────────────
-- The controller exposed only GET and POST /read. `Clear` in the app was a local
-- zustand `set({rows: []})` and nothing else, so the server never learned a thing and
-- the next sync — or any reinstall, or a second device — handed the whole inbox back.
-- `dismissed_at` is the missing state. Nullable with no default, so this is a
-- metadata-only ALTER (no table rewrite, no lock of consequence) and OLD CLIENTS ARE
-- SAFE IN BOTH DIRECTIONS: they never dismiss, so every row they wrote stays NULL and
-- `list()` behaves for them exactly as it does today.
--
-- Deliberately NOT a hard DELETE: same contract as `incident_id` / `org_user_id` above
-- it — this table is an append-only event log, and a dismissal is the RECIPIENT'S view
-- of a row, not the disappearance of the event. It also keeps the dismissal idempotent
-- under retry, which a DELETE would not be.
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;

COMMENT ON COLUMN public.notifications.dismissed_at IS
  'When the recipient cleared this row from their in-app feed. Suppression-only: '
  'list() filters it, nothing else reads it. Nullable, no FK, never back-filled.';

-- list() is `WHERE user_id = $1 AND dismissed_at IS NULL [AND created_at >= $2]`.
-- The existing (user_id, created_at DESC) index still drives it; this partial index
-- keeps the common "not dismissed" scan tight as the table grows.
CREATE INDEX IF NOT EXISTS notifications_user_active_idx
  ON public.notifications (user_id, created_at DESC)
  WHERE dismissed_at IS NULL;

-- ── A-2: the µs column vs the ms watermark ───────────────────────────────────
-- `created_at` is timestamptz(6) — microseconds. But node-postgres parses it into a JS
-- `Date`, which is millisecond-only: `postgres-date` computes `1000 * parseFloat('.090116')`
-- = 90.116 and `Date.UTC` TRUNCATES it to 90. The controller then emits `.toISOString()`
-- (3 fractional digits), the client stores that verbatim as its `since` cursor, and the
-- server filters `created_at > $since`. A row stored at `…02.090116` is therefore always
-- greater than the `…02.090` the client just echoed back — so it was returned again on
-- EVERY sync, forever. Measured on the live table: 500 of 500 rows (100%).
--
-- Harmless while the row is still on screen (the client dedupes by id). Fatal the moment
-- the user presses Clear: the row is gone locally, the cursor still points below it, and
-- the next foreground puts it straight back, unread.
--
-- The fix is to truncate the COLUMN, not the wire. Two rejected alternatives, both of
-- which look right and are not:
--   * `to_char(created_at,'…US OF')` — emits `+00`, and `new Date('…090116+00')` is
--     Invalid Date in JS, so every row's relative-time label would render "NaNd". It also
--     silently breaks the client's LEXICOGRAPHIC watermark compare ('Z' > '1'), stalling
--     the cursor for every user mid-upgrade.
--   * a `bigserial` cursor — sequence values are assigned at INSERT but transactions
--     COMMIT OUT OF ORDER, so a reader can see seq 105 before 104 commits, advance past
--     it, and permanently SKIP 104. That turns today's safe over-return into real loss.
-- Truncating the column keeps the wire format byte-identical, needs no client change,
-- and makes `stored == emitted` so the comparison is exact.
ALTER TABLE public.notifications
  ALTER COLUMN created_at SET DEFAULT date_trunc('milliseconds', now());

UPDATE public.notifications
   SET created_at = date_trunc('milliseconds', created_at)
 WHERE created_at <> date_trunc('milliseconds', created_at);

-- ── A-6: the retention sweep the original migration promised but never shipped ─
-- 20260727210000_notifications_inbox.sql called this table a "reconcile buffer, 30-day
-- intended retention" and said cleanup would be "a cheap opportunistic sweep on
-- insert-heavy paths server-side". No such sweep was ever written — no DELETE on this
-- table exists anywhere in apps/auth-service. Live consequence: 215 of 500 rows (43%)
-- were older than 30 days and the oldest was 52 days, which is why a fresh install
-- pulled down a feed of 50-day-old notifications.
--
-- The recurring sweep lives in NotificationsService (sampled, OFF the push fan-out's hot
-- path — BookingPushBridge deliberately orders the wake BEFORE durability so an SOS
-- fan-out never queues behind Postgres, and a DELETE must not reintroduce that).
--
-- The ONE-TIME catch-up for the 215 already-stale rows is deliberately NOT in this
-- migration: it destroys live user data across 52 accounts and is irreversible, so it is
-- a decision to take explicitly, not a side effect of a schema change. Run it once the
-- policy is confirmed:
--
--   DELETE FROM public.notifications WHERE created_at < now() - interval '30 days';
--
-- RUN 2026-08-30, founder-authorised, OUT OF BAND (not part of this migration, so a replay of
-- this file on another environment does not silently destroy data there):
--   215 rows deleted, 500 -> 285. Pre-flight: 0 inbound FKs, 29 users affected, clean 30-day
--   boundary (newest deleted 2026-07-30 19:48, oldest kept 2026-07-31 20:34). Oldest row went
--   from 52 days to 30. The sampled sweep in NotificationsService now holds the line.
