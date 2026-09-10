-- Issue 41 (Testing Issues V2, PDF p.46) — "Agent Acceptance Is Missing Before
-- Client Confirmation and Dispatch". CRITICAL.
--
-- ASSUMPTION ON THE RECORD (fix plan §10 Q4). The open question was WHERE escrow
-- is held once an acceptance stage exists. This change does not answer it and
-- does not need to: **escrow timing is UNCHANGED**. It is still taken at
-- provider-accept (dispatch.service -> wallet.service.holdToEscrow), exactly as
-- today. Nothing here moves money.
--
-- What changes is only what the CLIENT is told. The PDF's acceptance check is
-- "Confirm the client is not told the team is dispatched before agent
-- acceptance" — and that is a reporting defect, not a money one. `missions.status`
-- also stays untouched, so the ops console, the CPO screens and the mission FSM
-- all behave exactly as before; only the client-facing derived `mission_status`
-- waits for a real acceptance.
--
-- The stricter reading (reserve at provider-accept, hold escrow only at agent
-- acceptance, reassign on decline/timeout) remains open and needs the finance
-- decision. This is the safe subset that removes the lie without touching funds.

ALTER TABLE mission_crew
  ADD COLUMN IF NOT EXISTS accepted_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS declined_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decline_reason TEXT;

-- The client-facing read asks "has ANY crew member accepted this mission yet?",
-- so index the accepted rows.
CREATE INDEX IF NOT EXISTS mission_crew_accepted_idx
  ON mission_crew(mission_id) WHERE accepted_at IS NOT NULL;

COMMENT ON COLUMN mission_crew.accepted_at IS
  'When this officer accepted the assignment (Issue 41). NULL = assigned but not yet accepted; the client is NOT told the team is dispatched until at least one crew member has accepted.';
COMMENT ON COLUMN mission_crew.declined_at IS
  'When this officer declined (Issue 41). The provider re-crews; no automatic reassignment yet.';
