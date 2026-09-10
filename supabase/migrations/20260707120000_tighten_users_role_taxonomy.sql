-- RS-12 — Tighten users.role taxonomy to the 3 live values.
-- Legacy 'corporate' (0 rows) and 'ops' (1 row) are removed from the allowed set.
-- The single ops row (164867b8, "Ops-1", ranak@texzipperbd.com) is an admin_users
-- identity: ops-console authority comes from admin_users.role, NOT users.role, and
-- resolveAccountKind (apps/auth-service/src/auth/account-kind.ts) has no 'ops'
-- branch, so demoting it to 'individual' is behaviourally safe.

BEGIN;

-- 1. Demote the one legacy ops identity row. (corporate has 0 rows — no-op there.)
UPDATE public.users
   SET role = 'individual'
 WHERE role = 'ops';

-- 2. Guard: abort loudly if ANY row would violate the tightened constraint,
--    so the migration fails cleanly instead of erroring on ADD CONSTRAINT.
DO $$
DECLARE
  bad_count integer;
BEGIN
  SELECT count(*) INTO bad_count
    FROM public.users
   WHERE role NOT IN ('individual','agent','service_provider');
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'RS-12 abort: % users.role row(s) outside the new taxonomy', bad_count;
  END IF;
END $$;

-- 3. Rewrite the CHECK to the 3 live values only.
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users ADD CONSTRAINT users_role_check
  CHECK (role = ANY (ARRAY[
    'individual'::text,
    'agent'::text,            -- individual officer (managed CPO / legacy)
    'service_provider'::text  -- agency org (owns a CPO roster)
  ]));

COMMIT;

-- Down:
-- ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
-- ALTER TABLE public.users ADD CONSTRAINT users_role_check
--   CHECK (role = ANY (ARRAY['individual'::text,'corporate'::text,'agent'::text,'service_provider'::text,'ops'::text]));
