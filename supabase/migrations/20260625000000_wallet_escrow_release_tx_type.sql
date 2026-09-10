-- Auto-dispatch Step 11: the escrow RELEASE ledger type — the escrow account is
-- debited and the agency provider (+ platform fee account) credited on verified
-- completion, after the dispute window elapses. Completes the escrow ledger set:
--   escrow_hold    (+escrow at accept)
--   escrow_refund  (-escrow back to client on no-show / refund)
--   escrow_release (-escrow out to provider + platform fee on release)
-- Additive + idempotent; referenced only at runtime by WalletService.releaseEscrowHold.
ALTER TYPE wallet_tx_type ADD VALUE IF NOT EXISTS 'escrow_release';
