-- BE-7.6 — Virtual Bodyguard "Next of Kin" favorites.
--
-- Up to 3 emergency contacts per principal, stored server-side and keyed
-- by phone number so the set survives an app reinstall: after the user
-- logs back in, GET /vbg/favorites rehydrates the Home "Phone Next of Kin"
-- action without any local state. The phone is stored as the user typed
-- it (display) plus a normalized E.164 form used as the uniqueness key.
--
-- This table holds raw phone numbers (no message content / key material),
-- so it carries no Signal-protocol constraints — it is plain contact data
-- scoped to the owning user, same shape as the rest of the VBG tables.

CREATE TABLE IF NOT EXISTS public.vbg_favorites (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  -- As entered (kept for display); phone_e164 is the canonical key.
  phone        TEXT NOT NULL,
  phone_e164   TEXT NOT NULL,
  position     SMALLINT NOT NULL DEFAULT 0,   -- 0..2, slot order on the card
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One row per (user, phone): re-adding the same number updates the name
  -- instead of creating a duplicate favorite.
  CONSTRAINT vbg_favorites_user_phone_uniq UNIQUE (user_id, phone_e164)
);

CREATE INDEX IF NOT EXISTS vbg_favorites_user_idx
  ON public.vbg_favorites(user_id, position);

-- Match the deny-by-default RLS posture of every other VBG table
-- (20260603100000_enable_rls_deny_by_default): enable + FORCE with NO
-- policies. The auth-service backend connects as `postgres` (rolbypassrls)
-- so its queries are unaffected; this only closes direct anon/authenticated
-- (EXPO_PUBLIC anon key) access to raw favorites rows.
ALTER TABLE public.vbg_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vbg_favorites FORCE  ROW LEVEL SECURITY;
