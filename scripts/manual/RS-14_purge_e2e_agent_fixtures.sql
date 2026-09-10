-- RS-14 — DESTRUCTIVE. DO NOT COMMIT AS AN AUTO-APPLIED MIGRATION.
-- This file lives under scripts/manual/ (NOT supabase/migrations/) precisely so
-- the deploy pipeline never auto-runs it.
--
-- Purge 3 staging test-fixture accounts: role='agent', display_name='E2E CPO
-- Agent', and NO corresponding agents row. These pollute staging role data.
-- Run MANUALLY, only after a human reviews the SELECT output below.
-- (Deleting public.users does NOT cascade upward to auth.users; purge that
--  separately if desired. Dependent FKs may also block a hard delete — review.)

-- 1) IDENTIFY — run this first and eyeball the rows (expect exactly 3):
SELECT u.id, u.email, u.display_name, u.role, u.created_at, u.deleted_at
  FROM public.users u
 WHERE u.role = 'agent'
   AND u.display_name = 'E2E CPO Agent'
   AND NOT EXISTS (SELECT 1 FROM public.agents a WHERE a.user_id = u.id);

-- 2a) SAFER (recommended) — soft-delete instead of hard delete:
-- UPDATE public.users u
--    SET deleted_at = now()
--  WHERE u.role = 'agent'
--    AND u.display_name = 'E2E CPO Agent'
--    AND u.deleted_at IS NULL
--    AND NOT EXISTS (SELECT 1 FROM public.agents a WHERE a.user_id = u.id);

-- 2b) HARD DELETE — only after confirming step 1 returned exactly the fixtures.
--     Expect: DELETE 3.
-- DELETE FROM public.users u
--  WHERE u.role = 'agent'
--    AND u.display_name = 'E2E CPO Agent'
--    AND NOT EXISTS (SELECT 1 FROM public.agents a WHERE a.user_id = u.id);
