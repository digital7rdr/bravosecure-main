-- Channels vs2 item 2 (P2-d) — path-scoped accept-time seeding.
--
-- Accepting an invite currently seeds the joiner into EVERY eligible channel in
-- the workspace, ignoring the team the admin picked. Once a workspace has more
-- than one organisation that is not "a generous default", it is a
-- cross-organisation grant issued every time anyone joins. This migration adds
-- the two columns the scoped version needs.
--
-- ⚠️ MIGRATION FIRST, MANDATORY. THIS IS NOT AN OPTIONAL ORDERING.
--
-- An earlier version of this header said "a server running ahead of this
-- migration simply behaves as it does today". That is FALSE and was the most
-- dangerous line in the change. Both columns are nullable and additive, which
-- makes the migration safe to apply to a RUNNING OLD SERVER — that direction,
-- and only that direction, is what "additive" buys.
--
-- Deploying the CODE first takes the entire enterprise onboarding lane to 500
-- with `42703 undefined column`: POST /enterprise/invites, /referral-links,
-- /invites/accept, and BOTH /join-requests/:id/approve and /decline. Nobody can
-- be invited, nobody can join, and no admin can approve or decline. Nothing
-- corrupts (the transactional paths roll back) but onboarding is fully down.
--
-- There is no migration runner in auth-service, so the ordering is manual.
-- Staging is SUPABASE-backed: apply via bravo-staging-auth's $DATABASE_URL,
-- NOT the local pg container's own credentials.

-- 1. A NON-FK breadcrumb of the invited team's parent, captured at MINT.
--
-- `team_channel_id` is ON DELETE SET NULL, and deleting a leaf channel is
-- permitted (ON DELETE RESTRICT only guards parents). So a deleted team makes
-- the invite byte-identical to "minted with no team at all" — which routes to
-- the org-wide seed, quietly promoting a branch-scoped grant into a full
-- cross-branch one through the delete door. With the parent recorded, the
-- ancestor chain is still resolvable after the team row is gone.
--
-- Deliberately NOT a foreign key: its entire job is to outlive the row it
-- names. `team_department` cannot serve the same purpose — it is a LEFT JOIN
-- alias that is itself archive-gated to NULL.
ALTER TABLE public.enterprise_referral_links
  ADD COLUMN IF NOT EXISTS team_parent_id uuid;

COMMENT ON COLUMN public.enterprise_referral_links.team_parent_id IS
  'Parent of team_channel_id at mint time. Non-FK on purpose: it must survive '
  'the team being deleted, so accept-time seeding can still resolve the chain.';

-- 2. A per-PERSON marker that the channel seed did not complete.
--
-- The seed runs AFTER the transaction commits and is contractually best-effort
-- (a throw there does not fail the accept: the caller gets 200, `accepted_at`
-- is set, and the member lands in the workspace with zero channels). A marker
-- WRITTEN post-commit would be swallowed by the very catch it compensates for,
-- so this is set INSIDE the transaction and CLEARED by the seeder on success —
-- which inverts the failure mode: silence leaves the flag set rather than
-- losing the signal entirely.
--
-- It lives on join_requests, not referral_links, because there are TWO seeding
-- lanes and only this table is written by both: acceptInvite inserts-or-updates
-- a row here, and decideJoinRequest claims one. The link row is an OPEN
-- multi-use record serving N applicants, so a flag there would be per-link
-- rather than per-person and racy across concurrent approvals.
ALTER TABLE public.enterprise_join_requests
  ADD COLUMN IF NOT EXISTS seed_pending_at timestamptz;

COMMENT ON COLUMN public.enterprise_join_requests.seed_pending_at IS
  'Set in-tx on approval, cleared by the channel seeder on success. Non-null '
  'means the member may be short some channels and needs a re-seed.';

-- The repair reader is "show me everyone still owed a seed", which is a tiny
-- slice of a table that grows with every join. Partial, so it stays small.
CREATE INDEX IF NOT EXISTS enterprise_join_requests_seed_pending_idx
  ON public.enterprise_join_requests (org_user_id, seed_pending_at)
  WHERE seed_pending_at IS NOT NULL;
