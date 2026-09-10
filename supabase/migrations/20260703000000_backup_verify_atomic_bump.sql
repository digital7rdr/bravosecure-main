-- Bravo Secure — P0-1 hardening: atomic failed-attempt bump (audit M-5)
--
-- The verify protocol (backup.service.ts:verifyProof) throttles offline
-- brute-force by bumping identity_backups.failed_attempts on every wrong
-- proof and locking the row at the threshold. Doing that as a
-- read-then-write in the service under-counts under concurrent proofs
-- (two parallel wrong attempts both read N and both write N+1), which
-- weakens the throttle. This function performs the increment + lockout
-- decision in a single atomic UPDATE so the counter is race-free.
--
-- The service calls this via supabase-js .rpc('bump_backup_failed_attempts')
-- and falls back to read-modify-write when the function is absent (older
-- deploys / the unit spec's fake client), so shipping this migration is
-- a pure improvement with no client change required.

CREATE OR REPLACE FUNCTION public.bump_backup_failed_attempts(
  p_user_id     UUID,
  p_max_attempts INT,
  p_lockout_sec  INT
)
RETURNS TABLE(failed_attempts INT, locked_until TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.identity_backups AS ib
     SET failed_attempts = ib.failed_attempts + 1,
         locked_until = CASE
           WHEN ib.failed_attempts + 1 >= p_max_attempts
             THEN NOW() + make_interval(secs => p_lockout_sec)
           ELSE ib.locked_until
         END,
         updated_at = NOW()
   WHERE ib.user_id = p_user_id
  RETURNING ib.failed_attempts, ib.locked_until;
END;
$$;

COMMENT ON FUNCTION public.bump_backup_failed_attempts(UUID, INT, INT) IS
  'Atomic increment of identity_backups.failed_attempts with lockout at '
  'the threshold. Used by messenger-service verifyProof to keep the '
  'brute-force throttle race-free (audit M-5).';

-- SECURITY — this function is called ONLY by messenger-service via the
-- Supabase service-role key (which bypasses grants). Postgres grants
-- EXECUTE to PUBLIC by default, which would let the anon / authenticated
-- roles call it over PostgREST RPC and lock out ANY user's backup by
-- spraying their user_id. Revoke from PUBLIC so only the service role can
-- invoke it. (REVOKE FROM anon/authenticated alone is insufficient — the
-- PUBLIC grant still applies.)
REVOKE ALL ON FUNCTION public.bump_backup_failed_attempts(UUID, INT, INT) FROM PUBLIC;

-- Backfill note: rows created before 20260524000000_backup_verifier_key
-- have verifier_key IS NULL. verifyProof rejects those with 409
-- verifier_missing and the client prompts a one-time re-setup — no data
-- backfill is possible (the verifier key is derived from the user's
-- password, which the server never sees).
