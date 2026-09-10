-- ──────────────────────────────────────────────────────────────────────
-- Write back two schema changes that exist in the live database but in no
-- migration in this tree. Both were applied by hand and never recorded, so a
-- database rebuilt from `supabase/migrations/**` did not match production.
--
-- Every statement is idempotent and is a NO-OP against the live database,
-- which already has this shape. The effect is only on a fresh build.
-- ──────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. agent_kyc_checks review columns ─────────────────────────────────
-- Present live, added by no migration. The KYC review flow writes both when an
-- operator settles a check; without them a fresh environment fails on review.
ALTER TABLE public.agent_kyc_checks
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewer_id uuid;

-- ── 2. Retire the Phase-1 wallet_transactions columns ──────────────────
-- init_phase1 created wallet_transactions as (kind, amount_cents, external_ref);
-- 20260423160000_wallet_assignment_telemetry evolved it to the credits ledger
-- (type, amount_credits, feature, status, ...) by ADDing the new columns, but
-- never removed the old ones. Live has already dropped them.
--
-- This matters beyond tidiness: `kind` is NOT NULL with a CHECK, so on a fresh
-- build every INSERT written against the credits ledger — which does not supply
-- `kind` — fails. Dropping them is what makes a rebuilt database usable.
ALTER TABLE public.wallet_transactions
  DROP COLUMN IF EXISTS kind,
  DROP COLUMN IF EXISTS amount_cents,
  DROP COLUMN IF EXISTS external_ref;

-- ── 3. Type / nullability corrections ──────────────────────────────────
-- Five more differences that exist live but in no migration. Each statement is
-- a no-op where the column already has the target shape, so this whole block
-- does nothing against the live database.

-- notifications booking/mission ids are TEXT live, not uuid: the inbox carries
-- ids for records that are not always uuids (short codes, synthetic ids), and a
-- uuid column rejects those outright.
ALTER TABLE public.notifications
  ALTER COLUMN booking_id TYPE text USING booking_id::text,
  ALTER COLUMN mission_id TYPE text USING mission_id::text;

-- sos_events.location is unconstrained geography live. The Point,4326 modifier
-- would reject any non-point geometry the panic payload carries.
ALTER TABLE public.sos_events
  ALTER COLUMN location TYPE geography USING location::geography;

-- An SOS with no reason, or a wallet transaction with no type, is not a record
-- worth keeping — both are NOT NULL live. Safe to assert on a fresh build
-- (empty table) and a no-op on live, which already satisfies both.
ALTER TABLE public.sos_events          ALTER COLUMN reason SET NOT NULL;
ALTER TABLE public.wallet_transactions ALTER COLUMN type   SET NOT NULL;

-- Conversely, sos_events.payload and .user_id are NULLABLE live. A client panic
-- can fire before the session is attributed to a user and before any payload is
-- assembled — holding NOT NULL here would reject exactly the alarm that matters
-- most. Relaxing them matches the live contract.
ALTER TABLE public.sos_events
  ALTER COLUMN payload DROP NOT NULL,
  ALTER COLUMN user_id DROP NOT NULL;

COMMIT;
