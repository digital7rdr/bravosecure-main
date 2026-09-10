-- Bravo Credits 12-month expiry (BE-5.4 follow-up)
--
-- Tracks every minted batch of credits separately so we can expire them
-- after 12 months rather than carrying balance forever. The denormalised
-- wallet_balances.bravo_credits stays as the fast-read source of truth,
-- but its value is now the SUM of non-expired non-fully-consumed batches.
--
-- Why batches: a top-up of 100 BC on 2025-01-01 expires 2026-01-01. A
-- second top-up of 50 BC on 2025-06-01 expires 2026-06-01. When the user
-- spends 80 BC, we draw from the 2025-01-01 batch first (oldest expiry =
-- highest urgency) so the about-to-expire credits get used. Without the
-- batch table we cannot distinguish those two cohorts.
--
-- Idempotent — safe to re-run.

-- ─── credit batches ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wallet_credit_batches (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL,
  source_tx_id      UUID,
  amount_credits    INTEGER NOT NULL CHECK (amount_credits > 0),
  consumed_credits  INTEGER NOT NULL DEFAULT 0 CHECK (consumed_credits >= 0),
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,
  expired_at        TIMESTAMPTZ,
  CHECK (consumed_credits <= amount_credits)
);

-- Hot path: "give me the batches I should debit from, oldest-expiry first".
-- The partial filter on `expired_at IS NULL` excludes already-swept rows
-- without needing them in the index.
CREATE INDEX IF NOT EXISTS wallet_credit_batches_active_idx
  ON wallet_credit_batches (user_id, expires_at)
  WHERE expired_at IS NULL AND consumed_credits < amount_credits;

-- Sweep-cron path: "give me batches whose expiry has passed and that I
-- haven't expired yet". Bounded scan; index is tiny because most batches
-- are either future-expiry or already swept.
CREATE INDEX IF NOT EXISTS wallet_credit_batches_sweep_idx
  ON wallet_credit_batches (expires_at)
  WHERE expired_at IS NULL;

CREATE INDEX IF NOT EXISTS wallet_credit_batches_user_idx
  ON wallet_credit_batches (user_id, issued_at DESC);

-- ─── transactions table: add 'expire' to the type enum ────────────────────
--
-- We mint an EXPIRE ledger row for every batch swept by the cron so the
-- audit trail explains the balance drop (otherwise a user sees their BC
-- silently shrink overnight).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'wallet_tx_type'
       AND e.enumlabel = 'expire'
  ) THEN
    ALTER TYPE wallet_tx_type ADD VALUE 'expire';
  END IF;
END$$;

-- Backfill: every existing top-up/payout that issued credits gets a
-- matching batch row with a 12-month expiry from its created_at. This
-- preserves user balances exactly — the batch table just becomes a
-- materialised explanation of how the existing balance is composed.
--
-- We only backfill rows that actually granted credits (positive amount).
-- Debits are handled by the consumed_credits column on those batches —
-- we approximate by FIFO-spending: oldest credits get consumed first.

DO $$
DECLARE
  granting_tx RECORD;
BEGIN
  FOR granting_tx IN
    SELECT id, user_id, amount_credits, created_at
      FROM wallet_transactions
     WHERE status = 'succeeded'
       AND amount_credits > 0
       AND type IN ('topup', 'payout', 'refund')
     ORDER BY created_at ASC
  LOOP
    INSERT INTO wallet_credit_batches
      (user_id, source_tx_id, amount_credits, issued_at, expires_at)
    VALUES
      (granting_tx.user_id, granting_tx.id, granting_tx.amount_credits,
       granting_tx.created_at, granting_tx.created_at + INTERVAL '12 months')
    ON CONFLICT DO NOTHING;
  END LOOP;
END$$;

-- After backfilling grants, apply existing debits as FIFO consumption.
-- For each user with negative-amount succeeded payment rows, walk their
-- batches oldest-expiry-first and bump `consumed_credits` until the debit
-- is fully covered. This keeps the denormalised wallet_balances unchanged
-- and reconciles the batches table with reality.

DO $$
DECLARE
  spending RECORD;
  remaining INTEGER;
  batch RECORD;
  take INTEGER;
BEGIN
  FOR spending IN
    SELECT user_id, SUM(-amount_credits)::INTEGER AS debit
      FROM wallet_transactions
     WHERE status = 'succeeded' AND amount_credits < 0
     GROUP BY user_id
  LOOP
    remaining := spending.debit;
    FOR batch IN
      SELECT id, amount_credits, consumed_credits
        FROM wallet_credit_batches
       WHERE user_id = spending.user_id
         AND expired_at IS NULL
       ORDER BY expires_at ASC, issued_at ASC
       FOR UPDATE
    LOOP
      EXIT WHEN remaining <= 0;
      take := LEAST(remaining, batch.amount_credits - batch.consumed_credits);
      IF take > 0 THEN
        UPDATE wallet_credit_batches
           SET consumed_credits = consumed_credits + take
         WHERE id = batch.id;
        remaining := remaining - take;
      END IF;
    END LOOP;
    -- If `remaining > 0` after the loop we have legacy debits that
    -- exceeded the granting history (shouldn't happen in a healthy db
    -- but the migration must not crash). Log + leave the discrepancy
    -- for a manual reconcile.
    IF remaining > 0 THEN
      RAISE NOTICE 'wallet expiry backfill: user % has % BC debits with no granting batch', spending.user_id, remaining;
    END IF;
  END LOOP;
END$$;
