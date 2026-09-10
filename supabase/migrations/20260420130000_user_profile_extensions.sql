-- Tier-3 messenger features: per-user profile extensions + privacy
-- flags + a blocked-users table. All additive; existing rows get
-- sensible defaults so existing sessions keep working.

-- ─── Profile + privacy columns on public.users ────────────────────────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS bio                      text,
  ADD COLUMN IF NOT EXISTS last_seen_visible        boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS read_receipts_enabled    boolean NOT NULL DEFAULT true;

-- ─── Blocked users (pairwise, directed) ──────────────────────────────
-- "blocker blocks blocked". /users/lookup filters BOTH directions so
-- neither side sees the other in search results once a block exists.
-- ON DELETE CASCADE keeps this clean when an account is removed.
CREATE TABLE IF NOT EXISTS public.blocked_users (
  blocker_user_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  blocked_user_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CHECK (blocker_user_id <> blocked_user_id)
);

CREATE INDEX IF NOT EXISTS blocked_users_blocked_idx
  ON public.blocked_users(blocked_user_id);
