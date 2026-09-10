-- Issue 28 (Testing Issues V2, PDF p.33) — "Provider or Referral Code Is Missing
-- from the Booking Flow".
--
-- The booking flow had no field for a preferred-provider, partner or referral
-- code, so the Bravo Control System could not attribute a booking to an approved
-- partner (e.g. a travel agency) or record a provider preference.
--
-- SECURITY / OPERATIONAL CONSTRAINT (PDF, verbatim): "Confirm a code never
-- bypasses availability, licensing or operator approval." This table is
-- therefore ATTRIBUTION ONLY. Nothing here is read by the dispatch ranker, the
-- offer cascade or the escrow hold — the code is validated, recorded against the
-- booking and surfaced to ops, and that is all. Any future incentive or
-- preferred-assignment rule is a separate, separately-approved change.

CREATE TABLE IF NOT EXISTS provider_referral_codes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored upper-case; the API upper-cases before lookup so codes are
  -- case-insensitive to the client without a functional index.
  code           TEXT NOT NULL UNIQUE,
  -- Who the attribution belongs to. Exactly one of these is meaningful:
  --   owner_user_id  — an agency/provider (users.id of the company account)
  --   partner_name   — an external partner with no Bravo account (travel agent)
  owner_user_id  UUID REFERENCES public.users(id) ON DELETE SET NULL,
  partner_name   TEXT,
  -- Free text for ops: what this code is for.
  purpose        TEXT,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at     TIMESTAMPTZ,
  redeemed_count INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_referral_codes_owner_or_partner
    CHECK (owner_user_id IS NOT NULL OR partner_name IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS provider_referral_codes_active_idx
  ON provider_referral_codes(code) WHERE active = TRUE;

-- The code recorded ON the booking. Denormalised deliberately: the code row can
-- later be deactivated or renamed, and the booking must keep what was actually
-- submitted for reporting. referral_code_id keeps the join for ops.
ALTER TABLE lite_bookings
  ADD COLUMN IF NOT EXISTS referral_code    TEXT,
  ADD COLUMN IF NOT EXISTS referral_code_id UUID REFERENCES provider_referral_codes(id) ON DELETE SET NULL;

COMMENT ON TABLE provider_referral_codes IS
  'Partner / preferred-provider attribution codes (Issue 28). ATTRIBUTION ONLY — never read by dispatch ranking, the offer cascade or escrow.';
COMMENT ON COLUMN lite_bookings.referral_code IS
  'The code as submitted, denormalised so reporting survives the code row being deactivated (Issue 28).';
