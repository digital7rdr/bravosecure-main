-- Pro subscription (incl. auto-renew) + Department Channels metadata layer.
--
-- 1. users.pro_active_until — timestamp the current paid Pro period runs
--    until. subscription_tier='pro' is the live gate (TierGuard + mobile
--    paywall); pro_active_until is the expiry the renewal flow extends.
--    stripe_subscription_id / pro_renew_status back the Stripe auto-renew:
--    invoice.paid extends the period, payment_failed -> past_due, the
--    subscription being deleted (or a lapse with no live sub) -> downgrade
--    to Lite.
--
-- 2. Department Channels — METADATA ONLY. Message content is end-to-end
--    encrypted and rides the messenger relay as Signal group envelopes
--    (reusing the existing broadcastToGroup crypto — no plaintext or
--    ciphertext is stored here). A channel maps to a messenger group via
--    group_conversation_id; this layer owns the directory, membership +
--    role (admin posts / viewer read-only), and the E2EE group linkage.

-- ── 1. Pro subscription period + auto-renew ──────────────────────────────────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS pro_active_until        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id  TEXT,
  ADD COLUMN IF NOT EXISTS pro_renew_status        TEXT;

-- ── 2. Department channels (metadata only) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.department_channels (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Owning org/account. For corporate Pro this is the company; for an
  -- individual Pro user it is their own user id (single-tenant channels).
  org_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,                       -- pinned as the channel notice
  department   TEXT,                       -- e.g. 'Operations', 'Intel'
  -- E2EE linkage: the messenger group conversation id this channel maps to.
  -- The admin's device creates the Signal group (makeNewGroup) and registers
  -- its id here so members can resolve the encrypted thread. The group
  -- master key never reaches the server; posts ride the relay as sealed-
  -- sender group envelopes, never this DB.
  group_conversation_id TEXT,
  created_by   UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dept_channels_org_idx
  ON public.department_channels(org_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS public.department_channel_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id  UUID NOT NULL REFERENCES public.department_channels(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- 'admin' can post; 'viewer' is read-only (sees "You are a viewer"
  -- instead of an input bar — per the product brief).
  role        TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','viewer')),
  role_label  TEXT,                        -- display badge, e.g. 'CPO Surveillance'
  last_read_at TIMESTAMPTZ,                -- reserved for server-side read marks
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS dept_channel_members_unique
  ON public.department_channel_members(channel_id, user_id);
CREATE INDEX IF NOT EXISTS dept_channel_members_user_idx
  ON public.department_channel_members(user_id);
