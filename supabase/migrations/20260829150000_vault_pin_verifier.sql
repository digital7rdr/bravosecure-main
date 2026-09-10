-- B-696 Phase B (VAULT_DURABILITY_DESIGN_2026-08-29 §4) — server-side vault
-- PIN verifier. The PIN follows the PERSON: after a reinstall the user types
-- their same PIN once, auth-service verifies it against this argon2id hash,
-- and the client re-mints its local gate. A verifier, not an escrow — the
-- server can answer yes/no but can never open anything.
--
-- Attempt counting / lockout lives in Redis (the TOTP pattern), NOT here.

CREATE TABLE IF NOT EXISTS public.vault_pins (
  user_id     uuid        PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  verifier    text        NOT NULL,   -- argon2id PHC string (PasswordService)
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Deny-by-default RLS (house rule — the anon key ships in the APK, so a
-- public table without RLS is readable through PostgREST; see
-- 20260805090816_rls_deny_by_default_catchup.sql). auth-service reaches it
-- through the direct Postgres pool, which RLS does not constrain.
ALTER TABLE public.vault_pins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vault_pins FROM anon, authenticated;

COMMENT ON TABLE public.vault_pins IS
  'B-696: vault PIN verifier (argon2id PHC). Verify-only — no key material derives from the PIN.';
