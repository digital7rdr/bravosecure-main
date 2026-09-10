-- Auto-dispatch escrow (BUILD_RUNBOOK Step 9): add the wallet_transactions.type
-- labels for the ESCROW-account side of each paired move.
--
-- Every escrow money move is a PAIRED ledger (one debit row, one credit row) so
-- the ledger always balances (§37). The CLIENT side keeps its existing labels —
-- 'payment' for the hold debit, 'refund' for the no-show credit — but the
-- platform ESCROW account's rows need distinct types so held funds are never
-- miscounted as real client payments/refunds in analytics or reconciliation:
--   - 'escrow_hold'   : +credits onto the escrow account at accept (the hold)
--   - 'escrow_refund' : -credits off the escrow account on a no-show/refund
--
-- Additive + idempotent. Used only by WalletService.holdToEscrow / refundEscrowHold;
-- this migration just ADDs the labels (the values are referenced at runtime, never
-- in this transaction, so no enum-same-txn hazard).
ALTER TYPE wallet_tx_type ADD VALUE IF NOT EXISTS 'escrow_hold';
ALTER TYPE wallet_tx_type ADD VALUE IF NOT EXISTS 'escrow_refund';
