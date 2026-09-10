-- Enterprise member invites (scope-v2 Item E, A5+M5).
--
-- An invite is a BOUND, SINGLE-USE, auto-approve variant row on
-- enterprise_referral_links — not a new table, and never a pre-acceptance
-- org_members row (org_members_status_no_pending stays untouched; even an
-- 'invited' row would be read as live membership by org-cpo.service.ts).
-- A row is an invite iff invited_phone IS NOT NULL OR invited_email IS NOT NULL;
-- every other row keeps the original MULTI-use referral semantics unchanged.

ALTER TABLE public.enterprise_referral_links
  ADD COLUMN IF NOT EXISTS invited_phone      TEXT,
  ADD COLUMN IF NOT EXISTS invited_email      TEXT,
  ADD COLUMN IF NOT EXISTS invited_name       TEXT,
  ADD COLUMN IF NOT EXISTS invited_role       TEXT NOT NULL DEFAULT 'employee',
  ADD COLUMN IF NOT EXISTS invited_department TEXT,
  ADD COLUMN IF NOT EXISTS accepted_by        UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS accepted_at        TIMESTAMPTZ;

DO $$
BEGIN
  -- invited_phone is stored E.164 ONLY (the service normalises before insert);
  -- the accept-time binding compares it against users.phone_e164.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'enterprise_referral_links_invited_phone_e164'
  ) THEN
    ALTER TABLE public.enterprise_referral_links
      ADD CONSTRAINT enterprise_referral_links_invited_phone_e164
        CHECK (invited_phone IS NULL OR invited_phone ~ '^\+[0-9]{7,15}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'enterprise_referral_links_invited_role'
  ) THEN
    ALTER TABLE public.enterprise_referral_links
      ADD CONSTRAINT enterprise_referral_links_invited_role
        CHECK (invited_role IN ('employee', 'manager'));
  END IF;

  -- Exactly one contact channel per invite (phone XOR email); plain referral
  -- rows carry neither.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'enterprise_referral_links_one_contact'
  ) THEN
    ALTER TABLE public.enterprise_referral_links
      ADD CONSTRAINT enterprise_referral_links_one_contact
        CHECK (NOT (invited_phone IS NOT NULL AND invited_email IS NOT NULL));
  END IF;

  -- A branch scope only means anything on a manager invite.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'enterprise_referral_links_dept_needs_manager'
  ) THEN
    ALTER TABLE public.enterprise_referral_links
      ADD CONSTRAINT enterprise_referral_links_dept_needs_manager
        CHECK (invited_department IS NULL OR invited_role = 'manager');
  END IF;
END $$;

-- ONE open invite per contact per org. "Open" = neither accepted nor revoked;
-- expiry cannot live in the predicate (NOW() is not immutable), so the mint
-- path auto-revokes an EXPIRED open invite for the same contact before
-- inserting, and maps 23505 to "return the still-valid existing code".
CREATE UNIQUE INDEX IF NOT EXISTS enterprise_invites_one_open_phone
  ON public.enterprise_referral_links (org_user_id, invited_phone)
  WHERE invited_phone IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS enterprise_invites_one_open_email
  ON public.enterprise_referral_links (org_user_id, lower(invited_email))
  WHERE invited_email IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL;

-- "My invites" match indexes (invitee side, open rows only).
CREATE INDEX IF NOT EXISTS enterprise_invites_match_phone
  ON public.enterprise_referral_links (invited_phone)
  WHERE invited_phone IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS enterprise_invites_match_email
  ON public.enterprise_referral_links (lower(invited_email))
  WHERE invited_email IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL;

-- DOWN (manual):
-- DROP INDEX IF EXISTS enterprise_invites_match_email;
-- DROP INDEX IF EXISTS enterprise_invites_match_phone;
-- DROP INDEX IF EXISTS enterprise_invites_one_open_email;
-- DROP INDEX IF EXISTS enterprise_invites_one_open_phone;
-- ALTER TABLE public.enterprise_referral_links
--   DROP CONSTRAINT IF EXISTS enterprise_referral_links_dept_needs_manager,
--   DROP CONSTRAINT IF EXISTS enterprise_referral_links_one_contact,
--   DROP CONSTRAINT IF EXISTS enterprise_referral_links_invited_role,
--   DROP CONSTRAINT IF EXISTS enterprise_referral_links_invited_phone_e164,
--   DROP COLUMN IF EXISTS accepted_at,
--   DROP COLUMN IF EXISTS accepted_by,
--   DROP COLUMN IF EXISTS invited_department,
--   DROP COLUMN IF EXISTS invited_role,
--   DROP COLUMN IF EXISTS invited_name,
--   DROP COLUMN IF EXISTS invited_email,
--   DROP COLUMN IF EXISTS invited_phone;
