-- UI corrections 2026-08-15, item 04 — LATERAL CHANNELS.
--
-- Client review PDF §04: "Each level must be able to create lateral channels. A
-- lateral channel is part of the same level, just nested under it, they should
-- not have a colour." §13 checklist: "Admins can create a lateral channel at any
-- level without creating a deeper level."
--
-- WHY THIS NEEDS A COLUMN AND NOT A CONVENTION. With four hierarchy levels AND
-- laterals under each, the current model needs depth 8; the CHECK allows 4:
--
--     UAE(L1) -> #broadcast        level 2   <- consumes a tier today
--     UAE(L1) -> Abu Dhabi(L2)     level 2
--             -> Security(L3)      level 3
--             -> Team 1(L4)        level 4   <- REJECTED by the level CHECK
--
-- So a lateral must NOT increment level. That is a column, not a heuristic: the
-- names are admin-chosen (the PDF says so twice), so no naming rule can carry it.
--
-- ZERO BEHAVIOUR CHANGE ON EXISTING ROWS, and this migration is deliberately
-- safe to apply BEFORE the service that reads the column:
--   is_lateral defaults FALSE, so parent_level + CASE WHEN FALSE THEN 0 ELSE 1 END
--   is identically parent_level + 1. The old service never writes the column, so
--   neither new refusal below can fire. It is provably a no-op until the new
--   service ships. (Deploy order: THIS FILE FIRST, then auth-service, then the
--   APK -- the service SELECTs is_lateral and would 42703 the other way round.)
--
-- NO BACKFILL. Setting is_lateral on an existing parented row would make the
-- trigger re-derive level := parent_level + 0, dropping the row a tier and
-- risking a collision with dept_channels_one_broadcast_per_level. Every existing
-- row stays structural; laterals come only from the new create affordance.

ALTER TABLE public.department_channels
  ADD COLUMN IF NOT EXISTS is_lateral BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS dept_channels_lateral_idx
  ON public.department_channels(parent_id) WHERE is_lateral AND archived_at IS NULL;

-- ⚠️ REPLACING dept_channel_set_level() IS BANNED BY DEFAULT.
--
-- department.hierarchyMigration.spec.ts scans every migration newer than
-- 20260803010000 for exactly this statement and fails unless the filename is
-- listed in its ALLOWED_REPLACEMENTS. That ban is deliberate, and its comment
-- names this case -- a lateral changes how level is DERIVED -- as the expected
-- reason to lift it. This file is listed there, AND the invariants below are
-- re-asserted against this new body. Adding the filename without re-asserting is
-- the failure mode that comment warns about.
--
-- THE BODY BELOW IS 20260803010000's, VERBATIM, PLUS FOUR THINGS:
--   1. is_lateral is FROZEN on UPDATE (coerced, exactly like level)
--   2. lateral_channel_needs_parent
--   3. lateral_channel_cannot_have_children
--   4. the derivation adds 0 for a lateral instead of 1
-- The root bound, BOTH cross-org guards, the re-parent block, the self-parent and
-- missing-parent checks are UNCHANGED. Do not "tidy" them.
--
-- search_path is pinned: none of the three dept_channel_* functions was covered
-- by 20260603110000_harden_function_search_path.sql, and a replacement is the
-- right moment to close that rather than inherit the gap.
CREATE OR REPLACE FUNCTION public.dept_channel_set_level()
RETURNS TRIGGER
SET search_path = public, pg_temp
AS $$
DECLARE
  parent_level   SMALLINT;
  parent_org     UUID;
  parent_lateral BOOLEAN;
BEGIN
  -- `level` IS FROZEN ON UPDATE. (See 20260803010000 for the five-level recipe
  -- this closes: UPDATE ... SET level = 2 slipped past a column-scoped trigger.)
  IF TG_OP = 'UPDATE' AND NEW.level IS DISTINCT FROM OLD.level THEN
    NEW.level := OLD.level;
  END IF;

  -- ...AND SO IS is_lateral, for the same reason and with the same mechanism.
  --
  -- Flipping it changes the row's effective tier. On a parented row this trigger
  -- re-derives level on EVERY update, so a flip would silently re-level the row
  -- -- which can collide with dept_channels_one_broadcast_per_level, and which
  -- no descendant re-level accompanies. Coerced rather than raised, matching the
  -- level freeze one clause up: a silent no-op is what the neighbouring rule
  -- does, and two adjacent rules that disagree about their failure mode is worse
  -- than either choice.
  IF TG_OP = 'UPDATE' AND NEW.is_lateral IS DISTINCT FROM OLD.is_lateral THEN
    NEW.is_lateral := OLD.is_lateral;
  END IF;

  -- Same hole, tenancy edition. BOTH ENDS: testing only NEW.parent_id IS NOT NULL
  -- reads symmetric and is not -- moving a ROOT that has children is silent,
  -- because the root's own parent_id is NULL.
  IF TG_OP = 'UPDATE' AND NEW.org_id IS DISTINCT FROM OLD.org_id
     AND (NEW.parent_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM public.department_channels
                      WHERE parent_id = NEW.id)) THEN
    RAISE EXCEPTION 'cannot_move_child_channel_between_orgs';
  END IF;

  -- RE-PARENTING IS BLOCKED. This trigger is FOR EACH ROW, so moving a node
  -- recomputes only ITS level -- descendants keep stale ones. When a move UI is
  -- built, replace this with a recursive descendant re-level inside the same
  -- transaction; do NOT simply delete the guard.
  IF TG_OP = 'UPDATE' AND NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    RAISE EXCEPTION 'channel_reparenting_not_supported';
  END IF;

  IF NEW.parent_id IS NULL THEN
    -- A LATERAL WITHOUT A PARENT IS MEANINGLESS. There is no level to be lateral
    -- to, and the derivation below is the only thing that gives a lateral its
    -- level -- a parentless one would silently take the root default instead.
    IF NEW.is_lateral THEN
      RAISE EXCEPTION 'lateral_channel_needs_parent';
    END IF;
    -- A root is Enterprise (0) or Main (1).
    IF NEW.level > 1 THEN
      RAISE EXCEPTION 'root_channel_level_invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'channel_cannot_parent_itself';
  END IF;

  SELECT level, org_id, is_lateral INTO parent_level, parent_org, parent_lateral
    FROM public.department_channels WHERE id = NEW.parent_id;

  IF parent_level IS NULL THEN
    RAISE EXCEPTION 'parent_channel_not_found';
  END IF;

  IF parent_org <> NEW.org_id THEN
    RAISE EXCEPTION 'parent_channel_in_other_org';
  END IF;

  -- A LATERAL MUST STAY A LEAF, and this is what keeps the depth rule real.
  --
  -- A lateral does not increment level, so a CHAIN of laterals would add
  -- unbounded REAL depth while the column never moves -- the level CHECK would
  -- become decorative and every ancestor walk (bounded at 4 hops precisely
  -- because at most ONE lateral hop can exist) would silently under-reach.
  -- Same reasoning createChannel already applies to #broadcast: keeping the
  -- hanging object childless is what makes ignoring it sound.
  IF parent_lateral THEN
    RAISE EXCEPTION 'lateral_channel_cannot_have_children';
  END IF;

  -- THE DERIVATION. A lateral belongs to its parent's level ("part of the same
  -- level, just nested under it"); a structural child is one deeper. The CHECK
  -- still rejects 4, so no fifth level.
  NEW.level := parent_level + CASE WHEN NEW.is_lateral THEN 0 ELSE 1 END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The trigger itself is UNCHANGED (same name, same timing, same FOR EACH ROW on
-- INSERT OR UPDATE), so it is not dropped and re-created and there is no window
-- where writes are unguarded. 20260803010000 installed it; only the function
-- body moved.

COMMENT ON COLUMN public.department_channels.is_lateral IS
  'UI corrections 2026-08-15 item 04: a chat channel attached to a hierarchy '
  'level without consuming a tier. Inherits its parent level, must have a '
  'parent, must stay a leaf, and is frozen after insert.';

-- ── Verification (run by hand after applying) ────────────────────────────────
--
--   -- every lateral shares its parent's level, and none has children
--   SELECT c.id, c.level, p.level AS parent_level
--     FROM public.department_channels c
--     JOIN public.department_channels p ON p.id = c.parent_id
--    WHERE c.is_lateral AND c.level <> p.level;
--   -- expected: zero rows
--
--   SELECT k.id FROM public.department_channels k
--     JOIN public.department_channels p ON p.id = k.parent_id
--    WHERE p.is_lateral;
--   -- expected: zero rows
--
-- ── Down migration ───────────────────────────────────────────────────────────
--
-- ⚠️ REVERTING THE FUNCTION ALONE BRICKS EVERY LATERAL ROW. The trigger
-- re-derives level on EVERY update of a parented row, so once the derivation is
-- back to parent_level + 1 a lateral under a level-3 parent computes 4, the
-- level CHECK rejects it, and the row becomes permanently un-renamable,
-- un-archivable and un-provisionable -- the exact state 20260803010000 added a
-- self-healing normalising UPDATE to prevent. Flatten the laterals FIRST:
--
-- BEGIN;
--   -- 1. demote every lateral to a structural child at its correct depth
--   UPDATE public.department_channels c
--      SET is_lateral = FALSE
--    WHERE c.is_lateral;
--   -- the freeze above coerces is_lateral back, so it must be dropped first;
--   -- in a real revert, drop the column and let the old body take over:
--   -- 2. restore the previous function body (copy from 20260803010000)
--   -- 3. ALTER TABLE public.department_channels DROP COLUMN IF EXISTS is_lateral;
--   -- 4. DROP INDEX IF EXISTS dept_channels_lateral_idx;
-- COMMIT;
--
-- Order matters: dropping the column first removes the freeze AND makes every
-- surviving row structural in one step, which is why step 3 is what actually
-- performs the demotion. Rehearse it on staging (plan §7.3 item 18).
