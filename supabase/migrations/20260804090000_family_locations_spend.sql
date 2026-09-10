-- Bravo Secure Pro — linked-member last location + per-member spend attribution
-- (founder spec 2026-08-04, mock pages 15-17 residuals).
--
-- 1) family_member_locations: one row per user — the last GPS fix a family
--    MEMBER's device reported, shown to their plan owner on Linked Members.
--    Written only for ACTIVE, non-held members whose users.location_scope is
--    not 'never' (enforced in FamilyService.reportLocation). Modeled on
--    vbg_telemetry_last (20260601100000_vbg_be7.sql).
--
-- 2) wallet_transactions.actor_user_id / feature: WHO triggered a debit and
--    WHAT it was for. Until now the ledger only knew the payer (user_id), so
--    "which member spent what on which feature" was unanswerable — the
--    family usage() view string-matched descriptions and silently missed
--    every escrow-path charge. Backfilled from lite_bookings for history.

CREATE TABLE IF NOT EXISTS public.family_member_locations (
  user_id     uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  accuracy_m  double precision,
  label       text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.family_member_locations ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.family_member_locations IS
  'Last known device fix per family member (owner-visible on Linked Members). Foreground reports only; row absence is the normal cold state.';

ALTER TABLE public.wallet_transactions
  ADD COLUMN IF NOT EXISTS actor_user_id uuid,
  ADD COLUMN IF NOT EXISTS feature text;

COMMENT ON COLUMN public.wallet_transactions.actor_user_id IS
  'Who TRIGGERED the movement (family member on an owner-paid booking); user_id stays the wallet owner/payer.';
COMMENT ON COLUMN public.wallet_transactions.feature IS
  'Spend category: booking | secure_pro_plan | messenger_plan | … (free text, UI maps to labels).';

-- Owner-side per-member spend listing: WHERE user_id = holder AND actor_user_id = member.
CREATE INDEX IF NOT EXISTS wallet_tx_actor_idx
  ON public.wallet_transactions (user_id, actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

-- Backfill 1 — booking-bound rows: the actor is the booking's client (the
-- person the protection was FOR), regardless of which wallet paid. Covers the
-- legacy payment rows, escrow holds, and their refunds/releases.
UPDATE public.wallet_transactions wt
   SET actor_user_id = lb.client_id,
       feature       = COALESCE(wt.feature, 'booking')
  FROM public.lite_bookings lb
 WHERE wt.booking_id = lb.id
   AND wt.actor_user_id IS NULL
   AND wt.type IN ('payment','refund','escrow_hold','escrow_refund','escrow_release');

-- Backfill 2 — non-booking rows that already carry a metadata.kind (tier
-- subscriptions, pro activations, promo/escrow markers): lift it into feature,
-- normalised onto the SAME taxonomy the writers stamp going forward
-- ('messenger_plan' / 'secure_pro_plan') so pre- and post-migration spend of
-- one concept never keys differently.
UPDATE public.wallet_transactions
   SET feature = CASE
     WHEN metadata->>'kind' LIKE '%\_subscription' ESCAPE '\' THEN 'messenger_plan'
     WHEN metadata->>'kind' = 'pro_application'                THEN 'secure_pro_plan'
     ELSE metadata->>'kind'
   END
 WHERE feature IS NULL
   AND metadata ? 'kind'
   AND COALESCE(metadata->>'kind', '') <> '';
