-- Channels vs2 items 5 + 12 — a WORKSPACE may remove its #broadcast.
--
-- Scope v1 locked "a mandatory non-deletable #broadcast at every hierarchy
-- level" and this trigger enforced it for every tenant. The vs2 client review
-- crosses those auto-created channels out: a new workspace must start clean,
-- and nothing may be auto-added beneath a main channel. Items 5 and 12 stop
-- CREATING them; this migration lets an existing workspace get rid of the ones
-- it already has. Without it, every workspace created before this change keeps
-- an undeletable #broadcast forever, which is the same complaint one row down.
--
-- ⚠️ SUPERSEDES a locked scope-v1 rule, deliberately and only for the workspace
-- tenant. AGENCY orgs keep the protection unchanged — they never asked for it
-- to go, they use the channel, and their permission surface is out of scope for
-- this phase.
--
-- The discriminator is `org_workspaces.owner_user_id`, the same one the service
-- uses. It is sound only because one users.id cannot be both tenants
-- (workspace.service refuses to create a workspace for a company agent, and
-- `workspaceTenantExclusive.spec.ts` pins the reverse direction).

CREATE OR REPLACE FUNCTION public.dept_channel_block_broadcast_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.is_broadcast
     AND NOT EXISTS (
       SELECT 1 FROM public.org_workspaces w WHERE w.owner_user_id = OLD.org_id
     ) THEN
    RAISE EXCEPTION 'broadcast_channel_cannot_be_deleted';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- The trigger itself is unchanged (same name, same timing); only the predicate
-- inside the function moved, so no DROP/CREATE of the trigger is needed and no
-- window exists where deletes are unguarded.

-- ⚠️ COMPANION CONTROL: `20260805000000_backfill_dept_broadcast_channels.sql`
-- re-mints a #broadcast for every (org, level) that lacks one, with NO tenant
-- filter, and its header invites re-runs. Once a workspace can delete its
-- broadcast, a re-run of that file hands it straight back. A DO-NOT-RE-RUN
-- warning has been added to its header; if it is ever re-run deliberately it
-- must exclude org_workspaces owners first.

COMMENT ON FUNCTION public.dept_channel_block_broadcast_delete() IS
  'vs2 items 5+12: #broadcast is undeletable for AGENCY orgs only. Workspaces '
  'start clean and may remove theirs; agency orgs keep the scope-v1 rule.';

-- ⚠️ DEPLOY ORDER: **AUTH-SERVICE FIRST, THEN THIS MIGRATION.**
--
-- The two artefacts are not interchangeable and the hazardous order is the one
-- that looks safer:
--
--   * MIGRATION FIRST (unsafe) — the trigger is relaxed while the OLD service
--     still calls ensureBroadcastForLevel unconditionally. A workspace deletes
--     its #broadcast, then the next channel created at that level RESURRECTS
--     it. That is the loop the plan's edge P3-4 names.
--   * CODE FIRST (safe) — archive already works (a plain UPDATE, no trigger),
--     creates skip the ensure call, and nothing resurrects. Delete still hits
--     the strict trigger until this lands; deleteChannel now translates that
--     P0001 into a 409 refusal rather than a 500.
--
-- Down migration (uncomment to revert; restores the scope-v1 rule for EVERY
-- tenant). Note that broadcasts a workspace already deleted are NOT restored by
-- this — the next createChannel re-mints one via ensureBroadcastForLevel once
-- the code is also rolled back.
--
-- CREATE OR REPLACE FUNCTION public.dept_channel_block_broadcast_delete()
-- RETURNS TRIGGER AS $$
-- BEGIN
--   IF OLD.is_broadcast THEN
--     RAISE EXCEPTION 'broadcast_channel_cannot_be_deleted';
--   END IF;
--   RETURN OLD;
-- END;
-- $$ LANGUAGE plpgsql;
