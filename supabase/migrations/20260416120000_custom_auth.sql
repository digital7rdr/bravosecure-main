-- Custom auth replacement for Supabase GoTrue.
-- Adds password storage, device-bound refresh tokens, and OTP storage.
-- Drops the on_auth_user_created trigger + FK to auth.users, since the API
-- now owns user identity end-to-end.

BEGIN;

-- ── Decouple public.users from auth.users ──────────────────────────────────
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_auth_user();

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_id_fkey;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS password_hash text;

-- Per the architecture doc: authorization lives in the API layer, not RLS.
-- Drop every RLS policy + disable RLS across the schema.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;

  FOR r IN
    SELECT schemaname, tablename
      FROM pg_tables
     WHERE schemaname = 'public' AND rowsecurity = true
  LOOP
    EXECUTE format('ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY', r.schemaname, r.tablename);
  END LOOP;
END $$;

-- ── Device-bound refresh tokens ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.auth_devices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  device_id           text NOT NULL,                    -- client-generated install id
  platform            text NOT NULL DEFAULT 'android'
                      CHECK (platform IN ('ios','android','web')),
  refresh_token_hash  text NOT NULL,                    -- SHA-256 of the opaque refresh token
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  UNIQUE (user_id, device_id)
);
CREATE INDEX IF NOT EXISTS auth_devices_hash_idx  ON public.auth_devices(refresh_token_hash);
CREATE INDEX IF NOT EXISTS auth_devices_user_idx  ON public.auth_devices(user_id) WHERE revoked_at IS NULL;

-- ── Short-lived OTP codes (phone / email / totp) ───────────────────────────
CREATE TABLE IF NOT EXISTS public.auth_otps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('phone','email','totp')),
  code_hash   text NOT NULL,                            -- SHA-256
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_otps_user_idx ON public.auth_otps(user_id, created_at DESC);

COMMIT;
