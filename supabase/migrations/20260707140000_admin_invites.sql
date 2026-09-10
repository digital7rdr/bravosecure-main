-- RS-09 — invite-only admin provisioning.
-- Replaces the (deliberately) hard-403'd public admin self-registration:
-- an existing ADMIN mints a single-use invite; the invitee redeems it at
-- /auth/admin/accept-invite with their own phone + password and receives the
-- role BAKED INTO the invite (never client-chosen — that was the original
-- self-grant-ADMIN vulnerability).
--
-- The table stores ONLY the SHA-256 hash of the invite token. The raw token
-- is returned once, in the creating ADMIN's response, and never persisted.

CREATE TABLE IF NOT EXISTS public.admin_invites (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  call_sign        TEXT NOT NULL,
  role             admin_role NOT NULL DEFAULT 'OPS',
  region           TEXT NOT NULL DEFAULT 'AE',
  token_hash       TEXT NOT NULL UNIQUE,
  invited_by       UUID NOT NULL REFERENCES public.users(id),
  expires_at       TIMESTAMPTZ NOT NULL,
  redeemed_at      TIMESTAMPTZ,
  redeemed_user_id UUID REFERENCES public.users(id),
  revoked_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live (unredeemed, unrevoked) invite per email. Expired-but-pending
-- invites are auto-revoked by the service before re-inviting.
CREATE UNIQUE INDEX IF NOT EXISTS admin_invites_pending_email_idx
  ON public.admin_invites (lower(email))
  WHERE redeemed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS admin_invites_recent_idx
  ON public.admin_invites (created_at DESC);

-- Deny-by-default RLS, same trust posture as ops_audit / org_audit_log:
-- only the service (superuser connection) touches this table.
ALTER TABLE public.admin_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_invites FORCE ROW LEVEL SECURITY;
