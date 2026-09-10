-- Payout idempotency
--
-- Adds a partial unique index on `wallet_transactions` so a per-
-- (user, booking) payout row exists at most once. Pairs with
-- `WalletService.creditForBooking` which uses
-- `ON CONFLICT ON CONSTRAINT ux_wallet_tx_payout DO NOTHING` to short-
-- circuit duplicate credits.
--
-- Why a partial index: `type = 'payout'` is the only kind that needs
-- per-(user, booking) uniqueness. Top-ups, refunds, and other
-- transaction types may legitimately repeat for the same booking
-- (e.g. multiple top-ups during a single booking) and are explicitly
-- excluded.
--
-- Also adds a unique index on `mission_payouts(mission_id, agent_user_id)`
-- so the audit row inserted by `completeBooking` can't double-fire if
-- the surrounding code is ever retried.

CREATE UNIQUE INDEX IF NOT EXISTS ux_wallet_tx_payout
  ON wallet_transactions (user_id, booking_id)
  WHERE type = 'payout' AND booking_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_mission_payouts_unique
  ON mission_payouts (mission_id, agent_user_id);
