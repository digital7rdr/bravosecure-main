-- APPEND-ONLY MUST ALSO SURVIVE TRUNCATE.
--
-- Found by adversarial QA against the LIVE database, not by review or by any
-- test. The existing guard (20260804000000) is
-- `BEFORE UPDATE OR DELETE ... FOR EACH ROW`, and TRUNCATE fires NEITHER: it is
-- a statement-level operation that removes every row without producing row
-- events. So `TRUNCATE public.attendance_corrections` silently wiped the entire
-- HR audit trail while the table advertised itself as append-only — the one
-- thing A7.4 exists to make impossible.
--
-- This is the same shape as every other defect in this scope: a rule enforced
-- over a NARROWER SURFACE than the operations the code actually has. UPDATE and
-- DELETE were enumerated; TRUNCATE was not. The lesson generalises — when a
-- guard names operations, ask what operations exist that it did not name.
--
-- FOR EACH STATEMENT, because TRUNCATE has no rows to iterate; a FOR EACH ROW
-- trigger on TRUNCATE is rejected by Postgres outright.

CREATE OR REPLACE FUNCTION public.attendance_corrections_no_truncate()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'attendance_corrections is append-only (attempted TRUNCATE)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS attendance_corrections_no_truncate ON public.attendance_corrections;
CREATE TRIGGER attendance_corrections_no_truncate
  BEFORE TRUNCATE ON public.attendance_corrections
  FOR EACH STATEMENT EXECUTE FUNCTION public.attendance_corrections_no_truncate();

-- ── Down migration (uncomment to revert) ─────────────────────────────────────
-- Reverting re-opens a one-statement wipe of the audit trail. Do not.
-- DROP TRIGGER IF EXISTS attendance_corrections_no_truncate ON public.attendance_corrections;
-- DROP FUNCTION IF EXISTS public.attendance_corrections_no_truncate();
