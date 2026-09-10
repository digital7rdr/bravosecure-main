-- Issue 34 (Testing Issues V2, PDF p.39) — "Agent Onboarding Route Is Missing
-- from Role Selection".
--
-- ASSUMPTION ON THE RECORD (fix plan §10 Q1). AgentTypeSelectScreen carries an
-- explicit decision: "Individual-CPO self-onboarding was removed — officers join
-- via their provider's roster (managed sub-accounts), never self-register."
-- The PDF asks for an Agent route gated on a provider INVITATION CODE. Those are
-- compatible: the provider is still the only party that can mint a code, so it
-- still decides who joins. What changes is only who does the typing — the
-- officer enters their own details instead of the provider keying them in.
-- Nothing here lets anyone join a roster uninvited.
--
-- To revert to the stricter reading: drop this table and the redeem endpoint,
-- and remove the 'agent' entry from AgentTypeSelectScreen's TYPES array.

CREATE TABLE IF NOT EXISTS provider_invite_codes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored upper-case; the API upper-cases before lookup.
  code           TEXT NOT NULL UNIQUE,
  -- CASCADE: if the provider account goes, its outstanding invitations must not
  -- outlive it and become orphaned joins.
  org_user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  member_role    TEXT NOT NULL DEFAULT 'cpo',
  -- Optional pre-assigned call sign so a provider can slot the officer into an
  -- existing rota before they accept.
  call_sign      TEXT,
  expires_at     TIMESTAMPTZ,
  -- SINGLE USE. Claimed by a CONDITIONAL UPDATE in the redeem path, so two
  -- people racing the same code cannot both join.
  redeemed_by    UUID REFERENCES public.users(id) ON DELETE SET NULL,
  redeemed_at    TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  created_by     UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_invite_codes_role CHECK (member_role IN ('cpo', 'manager'))
);

-- Partial index over the only rows a redeem can ever match.
CREATE INDEX IF NOT EXISTS provider_invite_codes_open_idx
  ON provider_invite_codes(code)
  WHERE redeemed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS provider_invite_codes_org_idx
  ON provider_invite_codes(org_user_id);

COMMENT ON TABLE provider_invite_codes IS
  'Single-use provider roster invitations (Issue 34). The provider mints the code; the officer redeems it to join that roster. Redemption is a conditional UPDATE, so a code can only ever be used once.';
