-- M1A — Messenger Enterprise tier.
--
-- Extends users.subscription_tier to accept 'enterprise'. The tier reuses
-- pro_active_until / stripe_subscription_id / pro_renew_status as the
-- generic paid-until + auto-renew columns (M1A D-3): one paid window per
-- account, whichever paid tier owns it. TierGuard ranks lite < pro <
-- enterprise, so pro-gated handlers accept enterprise callers.
--
-- The inline CHECK from 20260416000000_init_phase1.sql auto-named itself
-- users_subscription_tier_check; drop defensively in case of a rename.

DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname INTO con_name
    FROM pg_constraint
   WHERE conrelid = 'public.users'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%subscription_tier%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.users DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE public.users
  ADD CONSTRAINT users_subscription_tier_check
  CHECK (subscription_tier IN ('lite', 'pro', 'enterprise'));
