-- Per-manager, per-module dashboard access. Only the true owner can grant
-- these (org_user_id === user_id — the "company account" itself, never a
-- delegated manager). NULL/empty means the manager sees NOTHING beyond the
-- baseline utility rows (Messenger/Intel/Region) until the owner explicitly
-- grants a module — the owner's own dashboard is never filtered by this.
ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS permitted_modules text[] NULL;
