-- Bravo Credits audit guards (docs/audits/CREDITS_BC_AUDIT.md, 2026-07-05)
--
--   F-15 — promo_codes / promo_redemptions existed only in the live DB
--          (schema drift); codify them so a fresh environment can run
--          POST /wallet/redeem-promo. Shapes mirror the live tables exactly.
--   F-11 — DB-level backstop against negative balances. Every debit path
--          already guards in code under FOR UPDATE; this catches any future
--          unguarded path or raw script. The two platform system accounts
--          are exempt: the platform-fee account legitimately fronts
--          clawback shortfalls (WalletService.clawbackReleasedHold) and may
--          run negative until recovered.
--
-- Idempotent — safe to re-run.

-- ─── promo tables (codify live shape) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS promo_codes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             TEXT NOT NULL UNIQUE,
  credits          INTEGER NOT NULL CHECK (credits > 0),
  max_redemptions  INTEGER,
  redeemed_count   INTEGER NOT NULL DEFAULT 0,
  expires_at       TIMESTAMPTZ,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  promo_id    UUID NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL,
  credits     INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (promo_id, user_id)
);

-- ─── non-negative balance backstop ──────────────────────────────────────────
-- NOT VALID first so existing rows aren't re-checked in one big lock, then
-- VALIDATE (staging verified: 0 negative balances at migration time).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wallet_balances_nonnegative'
       AND conrelid = 'public.wallet_balances'::regclass
  ) THEN
    ALTER TABLE wallet_balances
      ADD CONSTRAINT wallet_balances_nonnegative
      CHECK (
        bravo_credits >= 0
        OR user_id IN (
          '00000000-0000-0000-0000-0000000000e5',  -- platform escrow account
          '00000000-0000-0000-0000-0000000000fe'   -- platform fee account
        )
      ) NOT VALID;
    ALTER TABLE wallet_balances VALIDATE CONSTRAINT wallet_balances_nonnegative;
  END IF;
END$$;
