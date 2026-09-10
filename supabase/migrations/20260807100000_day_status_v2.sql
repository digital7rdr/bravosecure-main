-- Scope v2 · A7.3 — add 'emergency_leave' and 'mission' day statuses.
--
-- The PDF's Set Day Status frame requires six manager-settable statuses
-- (Leave, Sick Leave, Emergency Leave, Off Duty, Absent, Mission); the column
-- shipped with four. This widens the CHECK to the full ten-value domain
-- (8 existing + 2 new).
--
-- Additive + idempotent: relaxes the CHECK to ALLOW two more values (no
-- existing row violates it). Safe to re-run. Precedent:
-- 20260630000000_attendance_review_reason_camera.sql (same drop-and-widen on
-- this table's review_reason).
--
-- THE COPY LEDGER (the deliberately brittle drift gates count these): the
-- status domain lives in this CHECK, in `AttendanceStatus` (attendance
-- service), and in `CORRECTABLE_STATUSES` (roster.dto) — plus the
-- manager-settable SUBSET in SetDayStatusDto/DAY_STATUSES, the service's two
-- marker IN-lists, the rollup's skip-list, and the client's chips. All move
-- together in ONE commit; roster.spec's toBe(10) and
-- dayStatusServerContract.test.ts are the gates that force it.
-- (The original CHECK was inline in 20260629000000, so Postgres auto-named it
-- cpo_shift_sessions_attendance_status_check.)

ALTER TABLE public.cpo_shift_sessions
  DROP CONSTRAINT IF EXISTS cpo_shift_sessions_attendance_status_check;

ALTER TABLE public.cpo_shift_sessions
  ADD CONSTRAINT cpo_shift_sessions_attendance_status_check
  CHECK (attendance_status IS NULL OR attendance_status IN
    ('present','late','absent','early_checkout','leave','sick_leave','off_duty',
     'pending_review','emergency_leave','mission'));

-- ── Down migration (uncomment to revert) ─────────────────────────────────────
-- Only valid after removing rows holding the two new values.
-- ALTER TABLE public.cpo_shift_sessions
--   DROP CONSTRAINT IF EXISTS cpo_shift_sessions_attendance_status_check;
-- ALTER TABLE public.cpo_shift_sessions
--   ADD CONSTRAINT cpo_shift_sessions_attendance_status_check
--   CHECK (attendance_status IS NULL OR attendance_status IN
--     ('present','late','absent','early_checkout','leave','sick_leave','off_duty','pending_review'));
