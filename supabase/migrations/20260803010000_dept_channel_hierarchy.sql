-- Enterprise Dept Channels scope v2 — Phase 1: the four-level hierarchy.
--
-- PDF page 1 LOCKED RULES: "Exactly four organisational levels are supported;
-- no fifth level is permitted." Frame A9: "Show the full authorised hierarchy:
-- Enterprise, Main, Sub and Sub-sub Channel."
--
-- Today `department_channels` is FLAT: `department` is a free-text label, not a
-- tree. This adds the tree additively.
--
--   level 0 = Enterprise root      level 1 = Main
--   level 2 = Sub                  level 3 = Sub-sub
--
-- ZERO BEHAVIOUR CHANGE ON EXISTING ROWS. `level` defaults to 1 (Main) and
-- `parent_id` to NULL, so every existing channel reads as a top-level Main
-- channel exactly as it renders today. Same additive shape as
-- 20260629000002_channel_types.sql.
--
-- ON DELETE RESTRICT, not CASCADE: the PDF says "Archive is preferred;
-- permanent deletion is blocked when records require retention." Deleting a
-- parent must never silently take its subtree (and its message history) with it.

ALTER TABLE public.department_channels
  ADD COLUMN IF NOT EXISTS parent_id UUID
    REFERENCES public.department_channels(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS level SMALLINT NOT NULL DEFAULT 1;

-- THE "no fifth level" RULE, in the database. A child of a level-3 channel
-- computes level 4 in the trigger below and is rejected here. The app cannot
-- opt out of this, which is the point — frame A4: "Never rely on hidden UI
-- controls as the security boundary."
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'department_channels_level_range'
  ) THEN
    ALTER TABLE public.department_channels
      ADD CONSTRAINT department_channels_level_range CHECK (level BETWEEN 0 AND 3);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS dept_channels_parent_idx
  ON public.department_channels(parent_id) WHERE archived_at IS NULL;

-- Deploy safety: normalise any parentless row before the trigger is installed.
-- The trigger below raises `root_channel_level_invalid` for a parentless row
-- with level > 1 on EVERY update, so such a row would become permanently
-- un-renamable, un-archivable and un-provisionable. Nothing can produce that
-- state today (level has never been settable through the API), but deploys here
-- are manual and re-runs are expected — this makes the migration self-healing
-- instead of leaving a way to brick a channel. Idempotent; normally affects 0 rows.
UPDATE public.department_channels
   SET level = 1
 WHERE parent_id IS NULL AND level > 1;

-- Level is DERIVED, never trusted from the caller.
--
-- Why a trigger and not just the CHECK: the CHECK bounds the depth but cannot
-- see the parent row, so a caller could still insert a level-1 child under a
-- level-3 parent and flatten the tree. Computing it here means no writer —
-- service, script or psql — can state its own depth.
--
-- Scope of that claim, stated honestly: this holds for INSERT and UPDATE
-- through this trigger. It can still be defeated by DDL (dropping the trigger
-- or the CHECK in a later migration), which is why
-- department.hierarchyMigration.spec.ts scans EVERY later migration for exactly
-- that. It is a strong invariant, not an unfalsifiable one.
--
-- It also closes a TENANCY hole: without the org check, one Enterprise could
-- parent a channel under another Enterprise's channel, which is exactly what
-- page 10 rule 2 forbids ("One Enterprise must never access another
-- Enterprise's records or metadata").
CREATE OR REPLACE FUNCTION public.dept_channel_set_level()
RETURNS TRIGGER AS $$
DECLARE
  parent_level SMALLINT;
  parent_org   UUID;
BEGIN
  -- `level` IS FROZEN ON UPDATE.
  --
  -- The trigger used to be `BEFORE INSERT OR UPDATE OF parent_id`, which fires
  -- ONLY when parent_id appears in the SET list. That left a five-level recipe
  -- that passed every constraint:
  --     UPDATE department_channels SET level = 2 WHERE id = <a level-3 row>;
  --       -- trigger silent (parent_id not in SET), CHECK passes (2 is in range)
  --     INSERT ... parent_id = <that row>;   -- derives 3 under a real depth of 4
  -- Now the trigger fires on EVERY update and simply refuses to let `level`
  -- move on its own; the parent branch below re-derives it, so the column can
  -- never disagree with the tree.
  IF TG_OP = 'UPDATE' AND NEW.level IS DISTINCT FROM OLD.level THEN
    NEW.level := OLD.level;
  END IF;

  -- Same hole, tenancy edition: `UPDATE ... SET org_id = <other org>` never
  -- mentioned parent_id either, so a row could be moved between Enterprises
  -- while keeping a parent in the org it just left (page 10 rule 2).
  -- BOTH ENDS. The first version tested only `NEW.parent_id IS NOT NULL`,
  -- which reads symmetric and is not: moving a ROOT that has children is
  -- silent, because the root's own parent_id is NULL — and its children stay
  -- in the old org pointing at a parent that has left it. That is the exact
  -- state this guard exists to prevent, reached from the other end.
  --
  -- No API path writes org_id (there is no SET org_id anywhere in the service),
  -- so this was DDL-only — the same class as the caveat above. Closed anyway:
  -- a guard that is asymmetric in a way its own name does not admit is worse
  -- than no guard, because the next reader trusts it.
  IF TG_OP = 'UPDATE' AND NEW.org_id IS DISTINCT FROM OLD.org_id
     AND (NEW.parent_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM public.department_channels
                      WHERE parent_id = NEW.id)) THEN
    RAISE EXCEPTION 'cannot_move_child_channel_between_orgs';
  END IF;

  -- RE-PARENTING IS BLOCKED IN PHASE 1, deliberately.
  --
  -- This trigger is FOR EACH ROW, so moving a node recomputes only ITS level —
  -- its descendants keep their old ones. Moving a subtree down would then store
  -- a level-4 grandchild as level 3, silently defeating the "no fifth level"
  -- rule with no error anywhere. Re-parenting to NULL has the mirror problem
  -- (the row keeps a stale non-root level).
  --
  -- Nothing in Phase 1 moves a channel, so the safe thing is to refuse. When a
  -- move UI is built, replace this with a recursive descendant re-level inside
  -- the same transaction — do NOT simply delete this guard.
  IF TG_OP = 'UPDATE' AND NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    RAISE EXCEPTION 'channel_reparenting_not_supported';
  END IF;

  IF NEW.parent_id IS NULL THEN
    -- A root is Enterprise (0) or Main (1). The CHECK alone allows 0-3, so
    -- without this a caller could INSERT a parentless row at level 3 and then
    -- hang a derived child off it — a fifth level reached from a bare insert.
    IF NEW.level > 1 THEN
      RAISE EXCEPTION 'root_channel_level_invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'channel_cannot_parent_itself';
  END IF;

  SELECT level, org_id INTO parent_level, parent_org
    FROM public.department_channels WHERE id = NEW.parent_id;

  IF parent_level IS NULL THEN
    RAISE EXCEPTION 'parent_channel_not_found';
  END IF;

  IF parent_org <> NEW.org_id THEN
    RAISE EXCEPTION 'parent_channel_in_other_org';
  END IF;

  NEW.level := parent_level + 1;   -- CHECK rejects 4 → no fifth level
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dept_channel_set_level_trg ON public.department_channels;
-- NOT `UPDATE OF parent_id`. A column-scoped trigger fires only when that column
-- is in the SET list, so `SET level = …` and `SET org_id = …` slipped past it.
-- It must see every UPDATE.
CREATE TRIGGER dept_channel_set_level_trg
  BEFORE INSERT OR UPDATE ON public.department_channels
  FOR EACH ROW EXECUTE FUNCTION public.dept_channel_set_level();

-- ── TRIGGER FIRING ORDER, recorded because it is invisible at the call site ──
--
-- Postgres fires BEFORE ROW triggers in ALPHABETICAL order, so
-- `dept_channel_broadcast_mode_trg` (Phase 2) runs BEFORE
-- `dept_channel_set_level_trg` (here). They touch disjoint columns —
-- `post_mode` vs `level` — so the order is immaterial today and nothing
-- depends on it.
--
-- It stops being immaterial the moment a trigger needs to read the DERIVED
-- level: such a trigger must sort AFTER `dept_channel_set_level_trg`, and the
-- only lever is its name. Nothing in the schema enforces that, which is why it
-- is written down rather than left to be rediscovered.

-- ── Down migration (uncomment to revert) ─────────────────────────────────────
-- DROP TRIGGER IF EXISTS dept_channel_set_level_trg ON public.department_channels;
-- DROP FUNCTION IF EXISTS public.dept_channel_set_level();
-- DROP INDEX IF EXISTS dept_channels_parent_idx;
-- ALTER TABLE public.department_channels
--   DROP CONSTRAINT IF EXISTS department_channels_level_range,
--   DROP COLUMN IF EXISTS level,
--   DROP COLUMN IF EXISTS parent_id;
