-- B-404 — the referral-code WRITE side (Issue 28 follow-up).
--
-- 20260725140000 shipped the read side: the booking flow validates a
-- submitted code against provider_referral_codes — but nothing could ever
-- populate that table (no migration, no ops screen, no endpoint), so every
-- non-blank code failed with referral_code_invalid. The write side is
-- /ops/referral-codes (mint / deactivate) + the ops-console page.
--
-- This migration only adds the index the ops list view needs: it counts
-- bookings per code via a join on lite_bookings.referral_code_id, which
-- has no index (the column shipped with the read side).
--
-- No new tables ⇒ no new RLS surface (the 2026-08-05 catch-up lesson).

CREATE INDEX IF NOT EXISTS lite_bookings_referral_code_id_idx
  ON lite_bookings(referral_code_id)
  WHERE referral_code_id IS NOT NULL;
