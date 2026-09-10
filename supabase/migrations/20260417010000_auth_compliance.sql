-- ═══════════════════════════════════════════════════════════════════════════
-- Auth Module Compliance Migration — Bravo Secure
-- Review: SudeeshRobert / Digital7 Limited — 17 April 2026
-- Addresses: findings 02, 06 (OTP), 08 (TOTP), 10 (key fetch), 11 (OPK pool),
--            12 (RLS note), 16 (OTP attempt cap)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. auth_otps — add attempt counter, update TTL comment ───────────────���─
-- spec: 10-min TTL (from 5 min), max 3 attempts before code invalidation

ALTER TABLE public.auth_otps
  ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.auth_otps.attempt_count IS
  'Incremented on each failed verify attempt. Code invalidated when >= 3.';

COMMENT ON COLUMN public.auth_otps.expires_at IS
  '10 minutes after creation (per plan spec — extended from original 5 min).';

-- ── 2. auth_totp_secrets — TOTP per-user secret (AES-256-GCM encrypted) ────
-- spec: one secret per user; unverified secrets expire after 10 min;
--       encryption key in env (production: HashiCorp Vault)

CREATE TABLE IF NOT EXISTS public.auth_totp_secrets (
  user_id           uuid        PRIMARY KEY
                    REFERENCES public.users(id) ON DELETE CASCADE,
  secret_encrypted  bytea       NOT NULL,          -- AES-256-GCM: 12-byte IV || ciphertext || 16-byte tag
  verified_at       timestamptz,                   -- NULL until first successful TOTP verify
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.auth_totp_secrets IS
  'One TOTP secret per user. secret_encrypted is AES-256-GCM; key from TOTP_ENCRYPTION_KEY env.';
COMMENT ON COLUMN public.auth_totp_secrets.verified_at IS
  'NULL = setup initiated but not yet confirmed. Unverified secrets older than 10 min should be GC''d.';

-- ── 3. auth_totp_backup_codes — 10 single-use backup codes per user ─────────
-- spec: 8-char alphanumeric, SHA-256 hashed; regeneration invalidates all previous

CREATE TABLE IF NOT EXISTS public.auth_totp_backup_codes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL
              REFERENCES public.users(id) ON DELETE CASCADE,
  code_hash   text        NOT NULL,                -- SHA-256 of plaintext backup code
  used_at     timestamptz,                         -- NULL = available; set on consumption (single-use)
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_totp_backup_codes_user_idx
  ON public.auth_totp_backup_codes(user_id)
  WHERE used_at IS NULL;

COMMENT ON TABLE  public.auth_totp_backup_codes IS
  '10 backup codes per user. code_hash is SHA-256. used_at enforces single-use. '
  'All rows deleted and regenerated when setup is re-run.';

-- ── 4. Confirm auth_devices index on refresh_token_hash ─────────────────────
-- spec item 04: index required for sub-5ms lookup at scale

CREATE INDEX IF NOT EXISTS auth_devices_hash_idx
  ON public.auth_devices(refresh_token_hash);

-- ── 5. RLS status comment (accepted deviation) ──────────────────────────────
-- spec item 12: RLS disabled accepted; compensating control = route-level
-- ownership checks (req.user.sub). Risk formally accepted by SudeeshRobert.
-- Tests must maintain >= 95% ownership-check coverage.

COMMENT ON TABLE public.auth_devices IS
  'RLS disabled (accepted deviation). Ownership enforced via req.user.sub at route layer.';
COMMENT ON TABLE public.auth_otps IS
  'RLS disabled (accepted deviation). All queries scoped to user_id from JWT sub.';

-- ── 6. soft-delete guard — add deleted_at index on users ────────────────────
CREATE INDEX IF NOT EXISTS users_not_deleted_idx
  ON public.users(id)
  WHERE deleted_at IS NULL;

-- ── 7. OPK pool size constraint ──────────────���──────────────────────────────
-- spec item 11: max 100 OPKs per batch (enforced at API layer too)
COMMENT ON TABLE public.signal_one_time_prekeys IS
  'Max 100 OPKs per user. Incremental append only — never wholesale replacement. '
  'Deleted on fetch (single-use). Server sends X-Pre-Key-Count header when pool < 10.';
