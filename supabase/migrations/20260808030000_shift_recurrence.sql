-- G-d (scope-v2, A7.1) — minimal weekly recurrence.
--
-- No rrule engine: a repeating shift is N REAL cpo_shifts rows at +7d·k that
-- share a recurrence_group_id, so the four read paths (listShifts, calendar,
-- conflicts, myTodayShift) need zero changes. Series edit/archive, bi-weekly/
-- monthly, and DST wall-clock drift are deferred and stated in the blueprint.

ALTER TABLE public.cpo_shifts
  ADD COLUMN IF NOT EXISTS recurrence_group_id UUID;

CREATE INDEX IF NOT EXISTS cpo_shifts_recurrence_idx
  ON public.cpo_shifts (org_user_id, recurrence_group_id)
  WHERE recurrence_group_id IS NOT NULL;

-- DOWN (manual):
-- DROP INDEX IF EXISTS cpo_shifts_recurrence_idx;
-- ALTER TABLE public.cpo_shifts DROP COLUMN IF EXISTS recurrence_group_id;
