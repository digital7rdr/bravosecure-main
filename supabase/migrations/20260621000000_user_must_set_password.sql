-- Managed-CPO temp-password flag (BUILD_RUNBOOK Step 4). Additive + idempotent.
--
-- password_set_at IS NULL means "still on the agency-issued temp password"; the
-- app forces a password reset before the CPO home (must_set_password). It is
-- cleared atomically with the hash by auth.service.changePassword.
--
-- Backfill stamps every existing real login (created_at) so only managed CPOs
-- created AFTER this migration — createManagedCpo deliberately does not set the
-- column — read as must_set_password. Managed CPOs that predate this migration
-- are grandfathered (treated as already-set); acceptable per the runbook.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_set_at timestamptz;

UPDATE public.users
   SET password_set_at = COALESCE(password_set_at, created_at)
 WHERE password_hash IS NOT NULL
   AND password_set_at IS NULL;
