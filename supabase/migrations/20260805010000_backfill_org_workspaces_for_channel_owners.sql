-- Enterprise Dept Channels scope v2 — backfill for the F2 deletion.
--
-- ── WHAT BROKE ───────────────────────────────────────────────────────────────
--
-- F2 removed "an Enterprise tier alone grants org-manager authority" from BOTH
-- mirrors (OrgManagerGuard's Path 3 and resolveIsOrgManager's `is_enterprise`
-- arm). That is correct per PDF frame A4 — paying for a plan is an ENTITLEMENT,
-- not authority over an organisation.
--
-- But it was shipped as a pure deletion, and users had already been created
-- THROUGH the arm it deleted. A user who bought Enterprise before Phase 6
-- existed had no way to mint an `org_workspaces` row, because that route did not
-- exist yet — the tier arm was the only thing making them a manager. The moment
-- it went away they began 403ing on channels they own: createChannel,
-- configureChannel, archiveChannel, the Manage screen's listOrgChannels, the
-- join-approval inbox, roster, and attendance admin.
--
-- Verified on staging before writing this (2026-08-04): five active-Enterprise
-- users own un-archived `department_channels` with `org_id = users.id` and have
-- no `org_workspaces` row, no `agents.type='company'`, and no manager row. One
-- of them has an active org member — an employee whose approvals nobody can
-- action. Those channels can only have been created through the deleted arm.
--
-- ── WHY A BACKFILL AND NOT A CODE ARM ────────────────────────────────────────
--
-- Re-admitting them in code would restore exactly the rule A4 forbids. The
-- correct repair is to give them the thing the new rule asks for — the
-- workspace row Phase 6 would have created had it existed at the time — so they
-- satisfy Path 1b (`owns_workspace`) on its own terms.
--
-- The app does self-heal: `canCreateWorkspace` is true for these users and the
-- "Set up your workspace" CTA renders above the channel list, so a user who
-- finds it recovers in one tap. That is not good enough on its own — nothing
-- tells them the Manage cog vanished or why, and one of them has an employee
-- waiting on an approval queue that is currently unreachable.

-- ── THE NAME ─────────────────────────────────────────────────────────────────
--
-- `users.display_name`, deliberately. `account-kind.ts` resolves the org name as
-- COALESCE(orgws.name, org.display_name), so seeding the workspace with the
-- display name leaves what every employee sees EXACTLY as it is today — this
-- migration restores authority and changes no visible string.
--
-- It is not ideal: for a person-named account the workspace inherits a personal
-- name, which is the very drift Phase 6's `orgws` join exists to fix. It is
-- however strictly not worse than the status quo, and choosing anything else
-- would silently rename live workspaces. Renaming is a product route that does
-- not exist yet (open founder decision); when it lands, these owners can fix it.
--
-- COALESCE + NULLIF because `org_workspaces_name_not_blank` refuses a blank
-- name: an account with a NULL or whitespace display_name would abort the whole
-- migration on the CHECK rather than skip one row.

INSERT INTO public.org_workspaces (owner_user_id, name, created_at)
SELECT u.id,
       COALESCE(NULLIF(btrim(u.display_name), ''), 'My Workspace'),
       -- Stamp the workspace as of the org's OLDEST surviving channel, not now:
       -- the organisation demonstrably existed from that moment, and a NOW()
       -- stamp would read as "created after the channels it contains".
       COALESCE(MIN(c.created_at), NOW())
  FROM public.users u
  JOIN public.department_channels c
    ON c.org_id = u.id
   AND c.archived_at IS NULL
 WHERE u.subscription_tier = 'enterprise'
   -- Lapse-aware, matching activeEnterpriseSql(). A lapsed owner was ALSO
   -- locked out before F2 (Path 3 used the lapse-aware effectiveTierOf), so
   -- minting for them would grant authority the old rule never gave.
   AND (u.pro_active_until IS NULL OR u.pro_active_until > NOW())
   -- A company agent already reaches manager through Path 1 and needs no
   -- workspace; minting one would give them a second, redundant org identity.
   AND NOT EXISTS (
     SELECT 1 FROM public.agents a
      WHERE a.user_id = u.id AND a.type = 'company'
   )
 GROUP BY u.id, u.display_name
-- Idempotent: re-running must not disturb a workspace the owner has since
-- created (or renamed, once that route exists).
    ON CONFLICT (owner_user_id) DO NOTHING;
