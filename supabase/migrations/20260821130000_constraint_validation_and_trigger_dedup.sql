-- ──────────────────────────────────────────────────────────────────────
-- Schema hygiene: constraint validation and trigger de-duplication.
--
-- 1. agent_profiles carried two functionally identical updated_at triggers.
-- 2. Five constraints were still NOT VALID — new rows checked, existing rows
--    never verified, so referential integrity may already be broken.
-- ──────────────────────────────────────────────────────────────────────

-- ⚠️ APPLIED 2026-08-29 as `b699_delete_orphan_crew_then_validate`, NOT as
-- this file. It could never apply as written: the VALIDATE below found three
-- orphaned `mission_crew.agent_id` rows on completed dev-era mission
-- 0049b3fa… (2026-04-28) whose `agents` rows were long deleted — exactly the
-- outcome the note at §2 predicts. The reconcile had to be a DELETE
-- (`agent_id` is NOT NULL, so the gentler NULLing rolled back on 23502), and
-- it ran atomically with everything below, founder-authorised. Logged as
-- B-699 in sqa.md. Kept here as the historical record; re-running it now is a
-- clean no-op (the constraints are validated and the trigger is gone).

BEGIN;

-- ── 1. Drop the redundant updated_at trigger ─────────────────────────
-- Both fired BEFORE UPDATE FOR EACH ROW and both do `NEW.updated_at = now()`;
-- touch_agents_updated_at() and touch_updated_at() have identical bodies.
-- Keep `agent_profiles_touch`, which uses the generic touch_updated_at() that
-- the other twelve tables share. touch_agents_updated_at() itself is retained —
-- `agents` still uses it.
DROP TRIGGER IF EXISTS agent_profiles_touch_updated_at ON public.agent_profiles;

-- ── 2. Validate the constraints that were added NOT VALID ────────────
-- VALIDATE takes only a SHARE UPDATE EXCLUSIVE lock, so concurrent reads and
-- writes continue. It scans existing rows once.
--
-- IF THIS MIGRATION FAILS HERE, THAT IS THE POINT: it means live data already
-- violates the constraint. Do not remove the statement — find the orphans, e.g.
--   SELECT m.agent_id FROM mission_crew m
--    WHERE m.agent_id IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.user_id = m.agent_id);
-- and reconcile them before re-running.
ALTER TABLE public.mission_crew      VALIDATE CONSTRAINT mission_crew_agent_id_fk;
ALTER TABLE public.job_applications  VALIDATE CONSTRAINT job_applications_agent_id_fk;
ALTER TABLE public.sos_events        VALIDATE CONSTRAINT sos_events_mission_id_fk;
ALTER TABLE public.admin_users       VALIDATE CONSTRAINT admin_users_user_id_fk;
ALTER TABLE public.lite_bookings     VALIDATE CONSTRAINT lite_bookings_rating_remarks_len;

-- Re-assert the deny-by-default invariant from
-- 20260805090816_rls_deny_by_default_catchup, now that this migration has
-- created new tables. Same predicate, so the two can never disagree: any
-- application table (extension-owned relations excluded) left without RLS
-- fails the migration rather than shipping readable by `anon`.
DO $$
DECLARE missing int;
BEGIN
  SELECT count(*) INTO missing
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind IN ('r', 'p')
     AND NOT c.relrowsecurity
     AND NOT EXISTS (
           SELECT 1 FROM pg_depend d
            WHERE d.objid = c.oid AND d.deptype = 'e');
  IF missing > 0 THEN
    RAISE EXCEPTION 'RLS invariant broken: % public table(s) have RLS disabled', missing;
  END IF;
END $$;

COMMIT;
