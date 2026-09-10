-- Adds file_url / file_hash_sha256 / uploaded_at to agent_kyc_checks so
-- agents can upload supporting evidence for each KYC slot directly from
-- the mobile Verification screen. Ops then verifies on the console.

ALTER TABLE agent_kyc_checks
  ADD COLUMN IF NOT EXISTS file_url         TEXT,
  ADD COLUMN IF NOT EXISTS file_hash_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS uploaded_at      TIMESTAMPTZ;
