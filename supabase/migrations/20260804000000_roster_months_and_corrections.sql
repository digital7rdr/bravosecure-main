-- Enterprise Dept Channels scope v2 — Phase 5: Monthly Roster (A7.2) and
-- Attendance Corrections (A7.4).
--
-- ── WHAT THE PDF MAKES MANDATORY ─────────────────────────────────────────────
--
-- A7.2: full calendar-MONTH planning, with Draft / Published / Amended /
--       Archived states and a conflict check before publish. Day-by-day shift
--       creation (which is all we have) is explicitly "not enough".
-- A7.4: a correction must NEVER overwrite the original record. Keep before and
--       after forever, with who changed it, when (SERVER time) and why.
--
-- ── WHY A ROSTER STATE MACHINE AND NOT A BOOLEAN ─────────────────────────────
--
-- "Published" and "amended after publishing" are different facts to a CPO: the
-- second means the plan they already read has changed. A boolean cannot carry
-- that, and the founder-visible failure of collapsing them is "I republished
-- and nobody noticed".
--
-- ── THE GEOMETRY RULE (carried forward from Phase 3/4 review) ────────────────
--
-- A DRAFT month and an EMPTY month must not look alike. Drafts are invisible to
-- members BY CONSTRUCTION here: member-facing reads join through
-- `cpo_roster_months` and require a published state, so a draft returns no rows
-- rather than relying on every future reader to remember a filter.

-- ── 1. cpo_roster_months — one row per org × department × month ──────────────
CREATE TABLE IF NOT EXISTS public.cpo_roster_months (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_user_id   UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- NULL department = the org-wide roster. Matches the free-text `department`
  -- on cpo_shifts and org_members, so branch-scoped managers filter the same
  -- way they do everywhere else.
  department    TEXT,
  -- Always the FIRST of the month. Enforced by the CHECK rather than by
  -- convention, because a stray mid-month date would silently create a second
  -- roster for the same month that the unique index below could not catch.
  month         DATE NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'published', 'amended', 'archived')),
  published_at  TIMESTAMPTZ,
  published_by  UUID REFERENCES public.users(id),
  -- Set on every re-publish of an already-published month, so a CPO can be told
  -- "this changed" rather than just "this exists".
  amended_at    TIMESTAMPTZ,
  archived_at   TIMESTAMPTZ,
  created_by    UUID NOT NULL REFERENCES public.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cpo_roster_months_first_of_month
    CHECK (month = date_trunc('month', month)::date),
  -- A published/amended month MUST carry its publish stamp. Without this a row
  -- could claim to be published with no record of by whom or when, and the
  -- CPO-facing "published on" line would render blank.
  CONSTRAINT cpo_roster_months_publish_stamp
    CHECK (status NOT IN ('published', 'amended')
           OR (published_at IS NOT NULL AND published_by IS NOT NULL))
);

-- One roster per org × department × month. COALESCE because NULL != NULL in a
-- plain unique index, which would let the org-wide roster be created twice.
CREATE UNIQUE INDEX IF NOT EXISTS cpo_roster_months_unique
  ON public.cpo_roster_months(org_user_id, COALESCE(department, ''), month);

-- The admin calendar's own read: this org's months, newest first.
CREATE INDEX IF NOT EXISTS cpo_roster_months_org_idx
  ON public.cpo_roster_months(org_user_id, month DESC);

-- ── 2. link shifts to their month ────────────────────────────────────────────
-- NULLABLE on purpose. Every shift created before this migration — and any
-- created by the existing day-by-day flow — has no roster month, and those must
-- keep working exactly as they do today. A NULL roster_month_id means "not part
-- of a planned month", which member reads treat as visible (it is how shifts
-- have always behaved) rather than as an unpublished draft.
ALTER TABLE public.cpo_shifts
  ADD COLUMN IF NOT EXISTS roster_month_id UUID REFERENCES public.cpo_roster_months(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS cpo_shifts_roster_month_idx
  ON public.cpo_shifts(roster_month_id) WHERE roster_month_id IS NOT NULL;

-- ── 3. attendance_corrections — APPEND ONLY ──────────────────────────────────
--
-- A7.4: "never overwrite the original record". So a correction is a NEW ROW.
-- The session's own captured geotag/time stays immutable (it already is, per
-- the attendance_v2 note), and the effective value is derived as
-- "original, then the latest correction".
--
-- `before_value` is stored as well as `after_value` even though it is
-- reconstructible: reconstruction depends on replaying every prior correction
-- in order, and an audit that requires a replay to answer "what did it say
-- before?" is not an audit trail.
CREATE TABLE IF NOT EXISTS public.attendance_corrections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NO FOREIGN KEY, deliberately.
  --
  -- ON DELETE CASCADE plus the append-only trigger below is a contradiction
  -- that breaks a live write path: a Postgres RI cascade issues a real child
  -- DELETE, the row trigger RAISEs, and the PARENT transaction aborts. The
  -- attendance service's `setDayStatus` upserts by deleting the day's session —
  -- so once a day-status session had been corrected, setting that CPO's day
  -- status would fail forever.
  --
  -- RESTRICT has the same effect from the other direction. A7.4 says the trail
  -- is kept FOREVER, so it must outlive the row it annotates: an audit log that
  -- disappears with its subject is not an audit log. `ops_audit` holds target
  -- ids the same way.
  session_id    UUID NOT NULL,
  -- Denormalised for tenancy: every read is org-scoped, and joining through the
  -- session to get there would make the scope a JOIN condition someone can drop.
  -- Same reasoning: no cascade, so deleting a user cannot erase the record of
  -- what was corrected in their org.
  org_user_id   UUID NOT NULL,
  corrected_by  UUID NOT NULL,
  -- Denormalised so the trail stays attributable after the session is gone.
  cpo_user_id   UUID,
  -- SERVER time, never a client clock. A7.4 says "when (server time)".
  corrected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- WHY. Required and non-empty: a correction without a reason is exactly the
  -- silent overwrite this table exists to prevent.
  reason        TEXT NOT NULL,
  before_value  JSONB NOT NULL,
  after_value   JSONB NOT NULL,
  CONSTRAINT attendance_corrections_reason_not_blank
    CHECK (length(btrim(reason)) > 0),
  -- A correction that changes nothing is noise in the audit trail.
  CONSTRAINT attendance_corrections_changes_something
    CHECK (before_value <> after_value)
);

-- The history read: newest first, per session.
CREATE INDEX IF NOT EXISTS attendance_corrections_session_idx
  ON public.attendance_corrections(session_id, corrected_at DESC);
-- The org-wide audit read.
CREATE INDEX IF NOT EXISTS attendance_corrections_org_idx
  ON public.attendance_corrections(org_user_id, corrected_at DESC);

-- APPEND-ONLY, enforced by the database rather than by convention.
--
-- Every other guard in this phase lives in application code, which a second
-- writer can bypass. "Never overwrite the original" is the one rule where that
-- is not good enough: an UPDATE or DELETE here destroys the evidence the table
-- exists to hold, and no later audit could tell it had happened.
CREATE OR REPLACE FUNCTION public.attendance_corrections_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'attendance_corrections is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS attendance_corrections_no_update ON public.attendance_corrections;
CREATE TRIGGER attendance_corrections_no_update
  BEFORE UPDATE OR DELETE ON public.attendance_corrections
  FOR EACH ROW EXECUTE FUNCTION public.attendance_corrections_append_only();
