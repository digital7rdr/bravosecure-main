-- Add 'service_provider' to the users.role CHECK constraint.
--
-- The service-provider tenant model grants role='service_provider' when a
-- company agent is created (AgentService.create — the sanctioned,
-- authenticated grant point; anonymous registration still defaults to
-- 'individual' per P0-V1). The original constraint pre-dates the role:
--   CHECK (role IN ('individual','corporate','agent','ops'))
-- and made the grant fail with users_role_check (observed live 2026-06-11).

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users ADD CONSTRAINT users_role_check
  CHECK (role = ANY (ARRAY[
    'individual'::text,
    'corporate'::text,
    'agent'::text,            -- individual officer (managed CPO / legacy)
    'service_provider'::text, -- agency org (owns a CPO roster)
    'ops'::text
  ]));

-- Down:
-- ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
-- ALTER TABLE public.users ADD CONSTRAINT users_role_check
--   CHECK (role = ANY (ARRAY['individual'::text,'corporate'::text,'agent'::text,'ops'::text]));
