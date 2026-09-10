-- B-405 — T-60 start reminder for scheduled ('later') bookings.
-- One reminder per booking: the sweeper's conditional claim flips this
-- column, so it doubles as the idempotency gate.
ALTER TABLE lite_bookings ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;

COMMENT ON COLUMN lite_bookings.reminder_sent_at IS
  'B-405: when the T-60min start reminder push was sent (NULL = not yet). Only ''later'' bookings are swept.';

-- The sweep runs every minute; keep its scan tight. Partial on the unsent
-- 'later' rows only — the predicate deliberately omits status (enum literals
-- in index predicates survive enum changes poorly, and the unsent-later set
-- is small enough that pickup_time alone is selective).
CREATE INDEX IF NOT EXISTS lite_bookings_reminder_due_idx
  ON lite_bookings (pickup_time)
  WHERE booking_mode = 'later' AND reminder_sent_at IS NULL;
