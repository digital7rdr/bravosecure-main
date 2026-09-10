-- Enterprise Dept Channels scope v2 — Phase 6: the Enterprise workspace owner.
--
-- ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────────
--
-- A5 ("Create Org Workspace") had no backend. The ONLY existing way to become an
-- org owner was the service-provider funnel — `POST /agents` with type='company'
-- — which flips the user to `role='service_provider'`. That works, and it is why
-- `isOrgAffiliated` has an `account_kind === 'agency'` arm.
--
-- But it is the wrong product. An Enterprise company that wants internal
-- department channels is NOT a security-services agency, and routing them
-- through that funnel puts them in the provider home and the job marketplace.
-- Owner-decided (2026-08-04): mint a distinct workspace owner instead.
--
-- ── WHY A TABLE AND NOT A COLUMN ON users ────────────────────────────────────
--
-- "Owns a workspace" needs a name, a creation stamp and an owner, and it must be
-- possible to say "no workspace" without a sentinel. A nullable text column on
-- `users` would have carried the name and left the *fact* implicit in its
-- null-ness — the exact shape `managed_org` was split apart to escape (see
-- account-kind.ts: one nullable column answering two questions is
-- indistinguishable from unset).
--
-- ── THE ORG IS THE OWNER ─────────────────────────────────────────────────────
--
-- `owner_user_id` IS the org id, matching the existing convention throughout
-- auth-service (org_members.org_user_id, cpo_shifts.org_user_id, and the company
-- agent whose users.id is its own org id). So a workspace needs no new id space
-- and every existing org-scoped read works unchanged the moment the owner has a
-- row here.

CREATE TABLE IF NOT EXISTS public.org_workspaces (
  -- PRIMARY KEY, not just unique: one workspace per owner, and the owner IS the
  -- org. Two workspaces for one user would give that user two org ids, which
  -- every org-scoped query in this service assumes cannot happen.
  owner_user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A workspace with a blank name renders as an empty title everywhere and is
  -- indistinguishable from a bug. Refuse it in the database, not in one DTO.
  CONSTRAINT org_workspaces_name_not_blank CHECK (length(btrim(name)) > 0)
);

-- The membership read already covers org_members; this is the OWNER's own
-- lookup ("do I have a workspace, and what is it called?"), which runs on every
-- session bootstrap.
CREATE INDEX IF NOT EXISTS org_workspaces_owner_idx
  ON public.org_workspaces(owner_user_id);
