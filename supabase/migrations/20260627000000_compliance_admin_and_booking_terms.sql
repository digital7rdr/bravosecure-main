-- Vetting / compliance operational surface + per-request terms (BUILD_RUNBOOK Step 15).
--
-- The eligibility GATE already exists: is_eligible_for_dispatch (Step 6) reads
-- compliance_credentials (licence/insurance VERIFIED + non-expired) and
-- armed_authorizations (armed). This migration adds the columns needed to OPERATE that
-- gate — provider upload (file ref + hash), admin verify/reject (who/when/why) — and the
-- per-request compliance capture on the booking. Additive; the eligibility fn is unchanged
-- (it still keys off `verified AND expires_at > NOW()`).

-- Admin-tracking + encrypted-cert reference on the existing credential row.
ALTER TABLE public.compliance_credentials
  ADD COLUMN IF NOT EXISTS file_url         TEXT,    -- S3 key (AES-256-CBC encrypted before upload) — NEVER a plaintext cert
  ADD COLUMN IF NOT EXISTS file_hash_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS verified_by      UUID,
  ADD COLUMN IF NOT EXISTS verified_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reject_reason    TEXT,    -- set => REJECTED; verified=false + no reason => PENDING
  ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- At most one VERIFIED credential per (subject, kind, region) — a re-verify supersedes.
CREATE UNIQUE INDEX IF NOT EXISTS compliance_one_verified
  ON public.compliance_credentials(subject_user_id, kind, region_code)
  WHERE verified;

-- Admin-tracking on the armed authorization (armed is per-CPO, per-region).
ALTER TABLE public.armed_authorizations
  ADD COLUMN IF NOT EXISTS verified_by   UUID,
  ADD COLUMN IF NOT EXISTS verified_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reject_reason TEXT,
  ADD COLUMN IF NOT EXISTS created_by    UUID;

-- Per-request compliance capture. armed_required already exists (Step 9); add the
-- female-team requirement + the terms/waiver acceptance the auto flow must record.
ALTER TABLE public.lite_bookings
  ADD COLUMN IF NOT EXISTS female_required        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS terms_accepted_version TEXT,
  ADD COLUMN IF NOT EXISTS terms_accepted_at      TIMESTAMPTZ;
