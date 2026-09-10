-- Promote legacy workspace roots: level 1 → 0, so every workspace gets the
-- PDF's FOUR levels (B-590, founder repro 2026-08-20).
--
-- WHY. The Phase 1 hierarchy migration (20260803010000) defaulted every
-- pre-existing channel to level 1 ("reads as a top-level Main channel exactly
-- as it renders today"). When such a channel later grew children through
-- "Add sub-level", it became an organisation ROOT — but a level-1 root's tree
-- tops out at stored level 3 after only TWO nestings (1→2→3), one visible tier
-- short of the PDF page 1 LOCKED RULE ("Exactly four organisational levels").
-- vs2 item 8 recorded the asymmetry as permanent (§10.6); the founder has now
-- reported it as a bug: "I can create a sub-channel, then a sub of that, then
-- I can't go further."
--
-- THE FIX, in two halves:
--   1. The trigger gains ONE narrow allowance: a parentless, non-broadcast,
--      non-lateral row may move level 1 → 0. Everything else stays frozen.
--      This is NOT the five-level hazard: that recipe needed a MID-TREE row's
--      level lowered so a child would derive shallower than its true depth.
--      A parentless row IS depth zero — 0 is its truthful level — and its
--      children re-derive from it on their next touch (the trigger already
--      re-derives a parented row's level on EVERY update).
--   2. A data fix promotes every EXISTING legacy root that has children, then
--      touches its descendants generation-by-generation until each row's
--      level agrees with the trigger's own derivation.
--
-- WORKSPACE TENANTS ONLY. An agency keeps per-level #broadcast arithmetic
-- (ensureBroadcastForLevel keys on the stored level, and
-- root_channel_not_supported_for_agency exists precisely so no agency row is
-- ever level 0) — promoting an agency tree would silently re-key it.
--
-- COLLISION SAFETY. A live parented #broadcast inside a shifting tree changes
-- level with its parent, and dept_channels_one_broadcast_per_level is unique
-- on (org_id, level) over live broadcasts — so a legacy parentless #broadcast
-- already sitting at the target level would collide. Measured on production
-- 2026-08-20: 2 of 5 candidate orgs collide. Each root is promoted inside its
-- own exception scope: a collision rolls back THAT org's promotion only, with
-- a NOTICE, and the migration stays re-runnable — after the pending broadcast
-- purge clears the legacy rows, running this again finishes the job.
--
-- The depth CHECK (level BETWEEN 0 AND 3) is untouched: "no fifth level"
-- still holds, and after this the stored level equals the display tier - 1 in
-- every promoted tree.

CREATE OR REPLACE FUNCTION public.dept_channel_set_level()
RETURNS TRIGGER
SET search_path = public, pg_temp
AS $$
DECLARE
  parent_level   SMALLINT;
  parent_org     UUID;
  parent_lateral BOOLEAN;
BEGIN
  -- `level` IS FROZEN ON UPDATE (see 20260803010000 for the five-level recipe
  -- this closes), with ONE allowance: a parentless non-broadcast, non-lateral
  -- row may be promoted 1 → 0 (legacy Main root → Enterprise root). The
  -- allowance cannot lower a MID-TREE level — both sides must be parentless —
  -- so no child can ever derive shallower than its true depth through it.
  -- OLD.*, not NEW.*: is_broadcast has no freeze (unlike is_lateral), so a
  -- NEW-keyed guard could be slipped by `SET is_broadcast = false, level = 0`
  -- in one statement — releasing the row's slot in the one-broadcast-per-level
  -- index. Keying on what the row WAS costs nothing and closes it.
  IF TG_OP = 'UPDATE' AND NEW.level IS DISTINCT FROM OLD.level THEN
    IF OLD.parent_id IS NULL AND NEW.parent_id IS NULL
       AND OLD.level = 1 AND NEW.level = 0
       AND NOT OLD.is_broadcast AND NOT OLD.is_lateral THEN
      NULL;  -- allowed promotion
    ELSE
      NEW.level := OLD.level;
    END IF;
  END IF;

  -- ...AND SO IS is_lateral, for the same reason and with the same mechanism.
  -- Flipping it changes the row's effective tier and can collide with
  -- dept_channels_one_broadcast_per_level.
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
  -- A lateral does not increment level, so a CHAIN of laterals would add
  -- unbounded REAL depth while the column never moves -- the level CHECK would
  -- become decorative and every ancestor walk (bounded at 4 hops precisely
  -- because at most ONE lateral hop can exist) would silently under-reach.
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

-- ── DATA FIX ───────────────────────────────────────────────────────────────
-- Promote every legacy level-1 workspace root that has children, then touch
-- its org's rows generation-by-generation: the trigger re-derives a parented
-- row's level on every update, so the SET value here is deliberately ignored —
-- the WHERE simply finds rows whose stored level disagrees with the trigger's
-- own derivation, and the loop runs until nothing disagrees (bounded: depth is
-- CHECKed, so at most a handful of passes).
--
-- Archived rows are included on purpose: unarchiveChannel exists, and a mixed
-- tree (promoted root, stale archived child) would surface the inconsistency
-- at the worst moment. Archived broadcasts are outside the partial unique
-- index, so they cannot collide.
DO $$
DECLARE
  r        RECORD;
  touched  INTEGER;
  passes   INTEGER;
BEGIN
  FOR r IN
    SELECT c.id, c.org_id
      FROM public.department_channels c
     WHERE c.parent_id IS NULL AND c.level = 1
       AND NOT c.is_broadcast AND NOT c.is_lateral
       AND EXISTS (SELECT 1 FROM public.department_channels k WHERE k.parent_id = c.id)
       AND EXISTS (SELECT 1 FROM public.org_workspaces w WHERE w.owner_user_id = c.org_id)
  LOOP
    BEGIN
      UPDATE public.department_channels SET level = 0 WHERE id = r.id;
      passes := 0;
      LOOP
        UPDATE public.department_channels c
           SET level = 0  -- ignored: the trigger re-derives from the parent
          FROM public.department_channels p
         WHERE c.parent_id = p.id
           AND c.org_id = r.org_id
           AND c.level IS DISTINCT FROM p.level + (CASE WHEN c.is_lateral THEN 0 ELSE 1 END);
        GET DIAGNOSTICS touched = ROW_COUNT;
        passes := passes + 1;
        EXIT WHEN touched = 0 OR passes > 6;
      END LOOP;
      -- The bound is 7 and a legal tree converges in ≤5 (one generation per
      -- pass, max depth 4 + a confirming pass). If this ever fires, the org's
      -- root is at 0 with stale descendants and a re-run would SKIP it (the
      -- root no longer matches the candidate query) — so it must be loud.
      IF touched > 0 THEN
        RAISE WARNING 'promote_legacy_workspace_roots: org % did NOT converge after % passes — investigate before relying on its levels', r.org_id, passes;
      END IF;
    EXCEPTION
      WHEN unique_violation THEN
        -- A live legacy #broadcast occupies the level a shifting broadcast
        -- would land on. This org keeps its level-1 root (three visible tiers)
        -- until the broadcast purge clears the legacy rows — re-run this
        -- migration after the purge and it finishes the job.
        RAISE NOTICE 'promote_legacy_workspace_roots: org % root % left at level 1 (live #broadcast collision; re-run after the broadcast purge)', r.org_id, r.id;
      WHEN OTHERS THEN
        -- Any OTHER failure also rolls back only THIS org — one damaged org
        -- must never abort the promotion of every other workspace. Named so a
        -- re-run can find it.
        RAISE NOTICE 'promote_legacy_workspace_roots: org % root % skipped (%); will retry on re-run', r.org_id, r.id, SQLERRM;
    END;
  END LOOP;
END $$;
