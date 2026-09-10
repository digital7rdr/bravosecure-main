-- ⚠️ DO NOT RE-RUN THIS AGAINST A DATABASE THAT HAS WORKSPACES (added 2026-08-11).
--
-- This migration's own header calls re-runs expected, and that was true when it
-- was written. Channels vs2 items 5+12 changed the rule underneath it: a
-- WORKSPACE may now archive or DELETE its #broadcast on purpose, and a new
-- workspace is never given one. The `missing` CTE below has no tenant filter, so
-- a re-run would silently hand every workspace back the channel its admin
-- deliberately removed — resurrecting exactly what the client asked to be rid
-- of. AGENCY orgs are unaffected and still need this backfill.
--
-- If it must be re-run, add to `missing`:
--   AND NOT EXISTS (SELECT 1 FROM public.org_workspaces w
--                    WHERE w.owner_user_id = a.org_id)
-- The SQL below is deliberately UNCHANGED — it is already applied, and editing
-- an applied migration would make the file disagree with the database. This is a
-- process control on a manual operation, which is what the operation is.
--
-- Enterprise Dept Channels scope v2 — F5: BACKFILL the mandatory #broadcast.
--
-- Frame A9: "Create a mandatory non-deletable #broadcast at every hierarchy
-- level." Page 10 rule 1: "#broadcast exists at each level."
--
-- WHAT IS ACTUALLY WRONG TODAY. `ensureBroadcastForLevel` is only ever reached
-- from two places, and neither one runs for an org that already exists:
--
--   * seedOrgWorkspace — early-returns when the org has ANY channel, which is
--     true for every org that was seeded before Phase 2 shipped, so the
--     ensure-call at the bottom of that function is never reached for them.
--   * createChannel — only fires when somebody creates a channel from now on.
--
-- So the rule is "every level of every org" but the code only satisfies it for
-- levels that come into existence AFTER Phase 2. Measured on staging: of ~18
-- orgs with channels, exactly ONE has a row with is_broadcast = true. This
-- migration is the missing third writer — the one-off that covers the past,
-- while the two service paths keep covering the future.
--
-- IDEMPOTENT. It targets only (org, level) pairs that have an active channel
-- and no active broadcast, so a re-run inserts zero rows. Deploys here are
-- manual and re-runs are expected.

-- ── The backfill ─────────────────────────────────────────────────────────────
--
-- SHAPE MATCHES createChannel/ensureBroadcastForLevel EXACTLY: name
-- '#broadcast', no department, channel_type 'board', access 'standard',
-- created_by = the org itself. post_mode is deliberately NOT set — the
-- dept_channel_broadcast_mode trigger pins it to 'announcement' on any
-- is_broadcast row, and going through the trigger rather than around it is what
-- makes this row indistinguishable from one the service would have made.
--
-- WHY `level` IS IN THE COLUMN LIST when the service deliberately omits it:
-- the service never needs to, because it always inserts either a root (default
-- 1) or a child (derived from the parent). Here the (org, level) pair is the
-- unit of work, and a level-0 Enterprise root has no parent to derive from. It
-- is not a way to assert a depth: dept_channel_set_level OVERWRITES it with
-- parent_level + 1 for every parented row, and rejects a root above level 1.
--
-- PARENT SELECTION. A broadcast at level L > 1 must hang off some level-(L-1)
-- node, and the safest possible choice is the parent an EXISTING active channel
-- at that level already uses: it is guaranteed to be in the same org (the
-- trigger enforces that), at exactly level L-1, and not itself a broadcast
-- (broadcasts are childless by construction — createChannel refuses them as
-- parents). Deterministic tie-break so a re-run would pick the same node.
--
-- LEVELS WITH NO PLACEABLE PARENT ARE SKIPPED, not forced. That cannot happen
-- through the API (an active level-L channel implies an active level-(L-1)
-- parent, since archiveChannel refuses to archive a node with active children),
-- but inventing a parent for a corrupt row would be worse than leaving it for a
-- human. Re-running after the data is repaired picks it up.
WITH active AS (
  SELECT c.org_id, c.level, c.parent_id, c.created_at, c.id, c.is_broadcast
    FROM public.department_channels c
   WHERE c.archived_at IS NULL
),
missing AS (
  -- Every (org, level) that HAS channels but no live broadcast. Archived
  -- broadcasts do not count, matching dept_channels_one_broadcast_per_level,
  -- which is a partial index over archived_at IS NULL.
  SELECT DISTINCT a.org_id, a.level
    FROM active a
   WHERE NOT EXISTS (
           SELECT 1 FROM active b
            WHERE b.org_id = a.org_id AND b.level = a.level AND b.is_broadcast)
),
targets AS (
  SELECT m.org_id,
         m.level,
         CASE
           WHEN m.level <= 1 THEN NULL
           ELSE (SELECT a2.parent_id
                   FROM active a2
                  WHERE a2.org_id = m.org_id
                    AND a2.level  = m.level
                    AND a2.parent_id IS NOT NULL
                  ORDER BY a2.created_at ASC, a2.id ASC
                  LIMIT 1)
         END AS parent_id
    FROM missing m
),
placeable AS (
  SELECT t.org_id, t.level, t.parent_id
    FROM targets t
   WHERE t.level <= 1 OR t.parent_id IS NOT NULL
),
inserted AS (
  INSERT INTO public.department_channels
    (org_id, name, department, channel_type, access, created_by, parent_id, is_broadcast, level)
  SELECT p.org_id, '#broadcast', NULL, 'board', 'standard', p.org_id, p.parent_id, TRUE, p.level
    FROM placeable p
  -- Belt and braces against dept_channels_one_broadcast_per_level: `missing`
  -- already excludes levels that have one, but a concurrent createChannel
  -- during the deploy would race us and the index is the real arbiter.
  ON CONFLICT DO NOTHING
  RETURNING id, org_id
),
-- MEMBERSHIP IS NOT OPTIONAL. listChannels JOINs department_channel_members, so
-- a backfilled channel with no member rows is invisible to every single user —
-- the defect would look fixed in the table and unchanged in the app. These two
-- inserts reproduce seedChannelMembers(access 'standard', type 'board',
-- post_mode 'announcement'): the org account is admin, managers are admin with
-- the 'Manager' label, and everyone else is a viewer with a NULL label (A7.3 —
-- a stored staff noun would win over the tenant's own).
owner_seed AS (
  INSERT INTO public.department_channel_members (channel_id, user_id, role, role_label)
  SELECT i.id, i.org_id, 'admin', NULL
    FROM inserted i
  ON CONFLICT DO NOTHING
  RETURNING 1
)
INSERT INTO public.department_channel_members (channel_id, user_id, role, role_label)
-- DISTINCT ON, because a duplicate active org_members row would make this
-- statement conflict with ITSELF (ON CONFLICT cannot arbitrate two rows the
-- same command inserts). Manager wins the tie so a duplicated member is never
-- silently demoted below what seedChannelMembers would have given them.
SELECT DISTINCT ON (i.id, om.member_user_id)
       i.id,
       om.member_user_id,
       CASE WHEN om.member_role = 'manager' THEN 'admin' ELSE 'viewer' END,
       CASE WHEN om.member_role = 'manager' THEN 'Manager' ELSE NULL END
  FROM inserted i
  JOIN public.org_members om
    ON om.org_user_id = i.org_id AND om.status = 'active'
 -- The org account was seeded as admin above; re-inserting it here would be the
 -- self-conflict this statement cannot arbitrate.
 WHERE om.member_user_id <> i.org_id
 ORDER BY i.id, om.member_user_id, (om.member_role = 'manager') DESC
ON CONFLICT DO NOTHING;

-- ── Verification (run by hand after applying) ────────────────────────────────
--
--   SELECT org_id, level,
--          COUNT(*) FILTER (WHERE is_broadcast) AS broadcasts,
--          COUNT(*)                             AS channels
--     FROM public.department_channels
--    WHERE archived_at IS NULL
--    GROUP BY org_id, level
--   HAVING COUNT(*) FILTER (WHERE is_broadcast) <> 1
--    ORDER BY org_id, level;
--
-- Expected: zero rows. Any row is either a level whose parent could not be
-- resolved (see PARENT SELECTION above) or a level that gained a second
-- broadcast, which the unique index should have made impossible.

-- ── Down migration (uncomment to revert) ─────────────────────────────────────
--
-- There is no safe automatic revert: these rows are indistinguishable from ones
-- the service would have created, which is the whole point, and the BEFORE
-- DELETE trigger refuses to delete a broadcast anyway. Reverting means deciding
-- by hand which broadcasts to archive.
