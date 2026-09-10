-- Family hierarchy + shared credits.
--
-- A holder invites members (by phone). On accept, the member is linked and
-- their bookings are charged to the HOLDER's wallet (see WalletService /
-- BookingService resolvePayer). An optional per-member spend cap bounds how
-- much of the holder's credits a member may consume.
--
-- A member belongs to at most ONE active family at a time. Invites may be
-- pending-by-phone (member_id null) until that phone registers an account.

CREATE TABLE IF NOT EXISTS public.family_members (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  holder_id           UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  member_id           UUID REFERENCES public.users(id) ON DELETE CASCADE,   -- null until accepted / registered
  invite_phone        TEXT,                                                 -- E.164 invited (pending-by-phone)
  status              TEXT NOT NULL DEFAULT 'pending',  -- pending | active | revoked | declined
  spend_limit_credits INTEGER,                          -- null = unlimited (within holder balance)
  spent_credits       INTEGER NOT NULL DEFAULT 0,       -- running family-charged spend (for the cap)
  invited_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at         TIMESTAMPTZ
);

-- A member can be ACTIVE in only one family at a time.
CREATE UNIQUE INDEX IF NOT EXISTS family_members_one_active_per_member
  ON public.family_members(member_id) WHERE status = 'active' AND member_id IS NOT NULL;

-- Don't duplicate a pending invite for the same holder+phone.
CREATE UNIQUE INDEX IF NOT EXISTS family_members_holder_phone_pending
  ON public.family_members(holder_id, invite_phone) WHERE status = 'pending' AND invite_phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS family_members_holder_idx ON public.family_members(holder_id, status);
CREATE INDEX IF NOT EXISTS family_members_member_idx ON public.family_members(member_id, status);
CREATE INDEX IF NOT EXISTS family_members_phone_idx  ON public.family_members(invite_phone) WHERE status = 'pending';
