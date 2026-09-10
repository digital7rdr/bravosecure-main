-- FRAUD-2 / P0 — server-verified guard-identity handshake on a mission.
--
-- Before this, the on-arrival verify code was shown on both screens but never
-- checked by the server, and proof-of-completion check 5 was a permanent pass —
-- so escrow could auto-release for a mission whose guard identity was never
-- verified. This records the fact that the assigned lead proved presence by
-- entering the client-displayed arrival code (see AgentService.verifyArrival):
--   identity_verified_at  — when the handshake succeeded (NULL = not verified)
--   identity_verified_by  — the lead user id that submitted the matching code
--
-- Proof-gate check 5 consults identity_verified_at when
-- DISPATCH_REQUIRE_IDENTITY_HANDSHAKE is on. Additive + idempotent.
ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS identity_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS identity_verified_by text;
