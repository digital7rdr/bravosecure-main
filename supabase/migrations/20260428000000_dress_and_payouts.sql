-- Dressing instructions (per-mission) + payout deductions (per-CPO).
--
--   1. lite_bookings.dress_instructions — ops fills this in on the dispatch
--      picker; agents see it on their pre-departure deployment screen and
--      acknowledge before going LIVE.
--
--   2. mission_crew.dress_acknowledged_at — set by the agent app when the
--      CPO confirms they're kitted up. NULL until acknowledged.
--
--   3. mission_payouts — written by ops.completeBooking after the payout
--      review modal. Captures the per-CPO amount + any deduction reason.
--      The original even-split is the proposed default; ops can edit each
--      row before submitting.

ALTER TABLE lite_bookings
  ADD COLUMN IF NOT EXISTS dress_instructions TEXT;

ALTER TABLE mission_crew
  ADD COLUMN IF NOT EXISTS dress_acknowledged_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS mission_payouts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id          UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  booking_id          UUID NOT NULL REFERENCES lite_bookings(id) ON DELETE CASCADE,
  agent_user_id       UUID NOT NULL,
  call_sign           TEXT,
  proposed_credits    INTEGER NOT NULL,        -- even-split default
  paid_credits        INTEGER NOT NULL,        -- what ops actually approved
  deduction_credits   INTEGER NOT NULL DEFAULT 0,
  deduction_reason    TEXT,
  decided_by          UUID,                    -- admin_users.user_id
  decided_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mission_payouts_mission_idx ON mission_payouts(mission_id);
CREATE INDEX IF NOT EXISTS mission_payouts_booking_idx ON mission_payouts(booking_id);
CREATE INDEX IF NOT EXISTS mission_payouts_agent_idx   ON mission_payouts(agent_user_id);
