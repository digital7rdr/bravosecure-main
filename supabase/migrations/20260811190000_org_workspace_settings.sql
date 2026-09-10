-- Channels vs2 item 17b — per-organisation module hiding.
--
-- "Let an org hide Attendance / Incidents from its home screen." No org-level
-- settings storage existed: `org_workspaces` is owner/name/created_at, and
-- `permitted_modules` is per-MANAGER (consumed only by AgentDashboardScreen) —
-- the wrong shape for a decision that applies to everyone in the workspace.
--
-- ⚠️ HIDING IS PRESENTATION, NEVER A PERMISSION.
-- The routes stay registered and every server guard keeps enforcing exactly
-- what it enforced before. A hidden module is one the home screen stops
-- ADVERTISING; a deep link, a push tap or a stale in-app back-stack must still
-- work, or hiding a card would break notifications that are already in flight.
-- Nothing in this table is read by an authorisation check, and nothing should
-- start reading it for one.

CREATE TABLE IF NOT EXISTS public.org_workspace_settings (
  -- PK = FK to USERS, not to org_workspaces.
  --
  -- An org is one of two things in this system: a workspace
  -- (org_workspaces.owner_user_id) or an agency (agents.type='company'), and
  -- BOTH are a users.id. Pointing at org_workspaces looked tighter and
  -- structurally forbade every agency org from ever holding a row — while the
  -- home screen still offered its admins the control, so the company account
  -- got a 403 and its delegated managers got a raw FK violation. users.id is
  -- the id both org kinds actually share.
  org_user_id     uuid PRIMARY KEY
                    REFERENCES public.users(id) ON DELETE CASCADE,
  -- The modules this workspace does NOT advertise. Empty array = show
  -- everything, which is also the DEFAULT, so a workspace with no row behaves
  -- exactly as it did before this migration.
  --
  -- Values are validated in the SERVICE against a fixed list ('attendance',
  -- 'incidents') rather than by a CHECK constraint: the set is a product
  -- decision that will grow, and a constraint would turn each addition into a
  -- migration that has to be deployed before the code that uses it.
  hidden_modules  text[] NOT NULL DEFAULT '{}',
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- WHO, not just when. An admin asking "who hid Attendance?" is the first
  -- question this table will ever be asked, and the audit row alone is not
  -- enough once it ages out.
  updated_by      uuid REFERENCES public.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.org_workspace_settings IS
  'vs2 item 17b: per-workspace presentation settings. hidden_modules controls '
  'what the home screen ADVERTISES and is never consulted by an authorisation '
  'check — routes stay registered and server guards are unchanged.';

-- RLS: this database denies by default (rls_deny_by_default_catchup), and the
-- auth-service connects as the owner role, so no policy is required for the
-- service. Enabling it keeps the table consistent with its neighbours rather
-- than being the one table a future anon/authenticated grant would expose.
ALTER TABLE public.org_workspace_settings ENABLE ROW LEVEL SECURITY;
