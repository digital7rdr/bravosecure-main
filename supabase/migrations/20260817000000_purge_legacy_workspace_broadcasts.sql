-- UI corrections 2026-08-15, item 02 — PURGE THE LEGACY WORKSPACE #broadcast ROWS.
--
-- Client review §02: "This must be removed. Broadcasts must be listed under
-- specific channels, where they were created under as a lateral channel, not sub
-- or sub-sub channel."
--
-- The founder confirmed on 2026-08-15 that the rows themselves should go, not
-- just the section that lists them: these are LEGACY SEED DATA. A workspace has
-- not been given a #broadcast since vs2 items 5+12 (both `seedOrgWorkspace` and
-- `createChannel` gate `ensureBroadcastForLevel` on `NOT isWorkspaceTenant`), so
-- every row this deletes was created before that rule and by nobody.
--
-- ⚠️ AGENCIES ARE UNTOUCHED. They use their per-level broadcasts, the A9 rule
-- still applies to them, and `dept_channel_block_broadcast_delete` still refuses
-- the delete for them anyway. The discriminator is `org_workspaces.owner_user_id`
-- — the same one the service, the delete trigger and 20260808050000 all use.
--
-- ⚠️⚠️ RUN IT LIKE THIS, and not any other way:
--
--     psql "$DATABASE_URL" -f 20260817000000_purge_legacy_workspace_broadcasts.sql
--
-- Do NOT add --single-transaction. This file opens its own BEGIN/COMMIT, and
-- psql's wrapper plus an explicit COMMIT means the COMMIT ends the OUTER
-- transaction early — everything after it would run auto-committed, which is
-- exactly the partial-apply hazard the transaction is here to prevent.
-- ON_ERROR_STOP is not optional either: without it psql plows straight past a
-- failed guard and the guards stop being guards.

\set ON_ERROR_STOP on

BEGIN;

-- ── The targets, LOCKED ───────────────────────────────────────────────────────
--
-- FOR UPDATE is not decoration. `removeMember` inserts into
-- `channel_membership_intents`, whose channel_id is an FK to this table — and
-- since PostgreSQL 9.3 an FK check takes FOR KEY SHARE on the referenced parent
-- row, which CONFLICTS with FOR UPDATE. So a concurrent removal blocks here
-- rather than slipping a pending rekey intent in between the guard and the
-- DELETE, where the cascade would silently destroy it.
CREATE TEMP TABLE _purge_targets ON COMMIT DROP AS
SELECT c.id, c.org_id, c.name, c.level
  FROM public.department_channels c
 WHERE c.is_broadcast
   -- Workspace tenants only.
   AND EXISTS (SELECT 1 FROM public.org_workspaces w WHERE w.owner_user_id = c.org_id)
   -- An intentionally ARCHIVED broadcast is a RECOVERABLE state (unarchiveChannel
   -- exists). Destroying it would turn "I hid this" into "I lost this".
   AND c.archived_at IS NULL
 FOR UPDATE OF c;

-- ── Guard 1: PENDING REKEY INTENTS (a security stop-condition) ───────────────
--
-- `channel_membership_intents.channel_id` is ON DELETE CASCADE, and that
-- migration's own header states the stake: "remove → planRemoveAndRekey (remove@E
-- then rekey@E+1 — WITHOUT THE REKEY A REMOVED CPO KEEPS THE MASTER KEY and can
-- decrypt <=30d relay dwell)". Deleting a channel whose rekey has not been
-- broadcast destroys the instruction that closes that window.
--
-- Scoped to state='pending' DELIBERATELY. Unscoped this aborts on every
-- workspace forever: a #broadcast seeds EVERY active member, so every removal
-- ever performed left an intent on it, and acked/expired rows sit there
-- permanently. A guard that can never be satisfied is a cleanup that never ships.
DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n
    FROM public.channel_membership_intents i
    JOIN _purge_targets t ON t.id = i.channel_id
   WHERE i.state = 'pending';
  IF n > 0 THEN
    RAISE EXCEPTION
      'ABORT: % pending rekey intent(s) on target channels. Deleting them would leave a removed member holding the group key. Have an admin device drain them (listMembershipIntents → ack), then re-run.', n;
  END IF;
END $$;

-- ── Guard 2: LIVE INVITES / JOIN REQUESTS bound to a target ──────────────────
--
-- Both `team_channel_id` FKs are ON DELETE SET NULL, and
-- `resolveSeedScopeInTx` returns {kind:'orgWide'} when the channel AND the
-- parent breadcrumb are both null. A workspace #broadcast at level <= 1 is
-- PARENTLESS, so it has neither — meaning a pending team-scoped invite would
-- silently become a WHOLE-WORKSPACE grant the moment its channel disappeared.
--
-- Scoped to LIVE rows: revoked/expired links and decided requests hold the FK
-- forever and grant nothing.
--
-- NOTE the two tables have DIFFERENT liveness columns and it matters:
-- `enterprise_referral_links` is MULTI-use (M5 — a link an admin shares, e.g.
-- printed on an induction sheet), so it has NO `accepted_at` to check — a link
-- stays live until it is revoked or expires. `enterprise_join_requests` is
-- single-use and carries a status.
DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM (
    SELECT 1 FROM public.enterprise_referral_links r
      JOIN _purge_targets t ON t.id = r.team_channel_id
     WHERE r.revoked_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > NOW())
    UNION ALL
    SELECT 1 FROM public.enterprise_join_requests q
      JOIN _purge_targets t ON t.id = q.team_channel_id
     WHERE q.status = 'pending'
  ) x;
  IF n > 0 THEN
    RAISE EXCEPTION
      'ABORT: % live invite(s)/request(s) are bound to a target channel as their TEAM. Deleting it would widen them to a whole-workspace grant. Expire or re-point them, then re-run.', n;
  END IF;
END $$;

-- ── Guard 3: CHILDREN ────────────────────────────────────────────────────────
--
-- The self-FK is ON DELETE RESTRICT and counts ARCHIVED children too. The
-- service refuses a broadcast as a parent, but that is a SERVICE guard — there
-- is no DB constraint, so one legacy row would abort the whole DELETE with an
-- opaque 23503 instead of the sentence below.
DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n
    FROM public.department_channels k
    JOIN _purge_targets t ON t.id = k.parent_id;
  IF n > 0 THEN
    RAISE EXCEPTION
      'ABORT: % channel(s) are parented under a target broadcast. That should be impossible; investigate before deleting.', n;
  END IF;
END $$;

-- ── Report: which orgs will be left with no announcement channel ─────────────
--
-- ⚠️ A NOTICE, NOT AN ABORT, and the distinction matters.
--
-- §8 gate 4 is a CAPABILITY check ("this build can create an announcement
-- lateral"). A per-org DATA check ("this org has already created one") is a
-- different assertion, and as an abort it fires for EVERY workspace on day one —
-- the feature is new, so nobody has used it yet — which would deadlock the
-- rollout permanently. There is even a shape it can never satisfy: a legacy
-- workspace whose channels are all restricted parentless roots cannot host a
-- lateral at all (`restricted_root_cannot_take_children`).
--
-- So it reports, and the founder decides who to chase.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT t.org_id FROM _purge_targets t
     WHERE NOT EXISTS (
       SELECT 1 FROM public.department_channels a
        WHERE a.org_id = t.org_id AND a.archived_at IS NULL
          AND a.post_mode = 'announcement' AND NOT a.is_broadcast)
  LOOP
    RAISE NOTICE 'org % will have no announcement channel after this purge', r.org_id;
  END LOOP;
END $$;

-- ── The delete, with a RELATIVE count assertion ──────────────────────────────
--
-- Relative, never a hardcoded number: `test/integration/harness.ts` replays every
-- migration in this directory, so this file executes with ZERO targets on a
-- fixture DB and must pass rather than abort. (That harness cannot currently
-- boot at all — @testcontainers/postgresql is not installed — but the assertion
-- is written to survive it being fixed.)
DO $$
DECLARE expected INT; actual INT;
BEGIN
  SELECT COUNT(*) INTO expected FROM _purge_targets;
  DELETE FROM public.department_channels c USING _purge_targets t WHERE c.id = t.id;
  GET DIAGNOSTICS actual = ROW_COUNT;
  IF actual <> expected THEN
    RAISE EXCEPTION 'ABORT: expected to delete % row(s), deleted %.', expected, actual;
  END IF;
  RAISE NOTICE 'purged % legacy workspace #broadcast channel(s)', actual;
END $$;

COMMIT;

-- ── Snapshot to take BEFORE running (keep the output) ────────────────────────
--
--   SELECT c.id, c.org_id, c.name, c.level, c.created_at
--     FROM public.department_channels c
--    WHERE c.is_broadcast
--      AND c.archived_at IS NULL
--      AND EXISTS (SELECT 1 FROM public.org_workspaces w WHERE w.owner_user_id = c.org_id)
--    ORDER BY c.org_id, c.level;
--
-- ── Verification AFTER ────────────────────────────────────────────────────────
--
--   SELECT COUNT(*) FROM public.department_channels c
--    WHERE c.is_broadcast AND c.archived_at IS NULL
--      AND EXISTS (SELECT 1 FROM public.org_workspaces w WHERE w.owner_user_id = c.org_id);
--   -- expected: 0
--
-- ── Residue this SQL cannot clean, stated plainly ────────────────────────────
--
-- `department_channel_members` cascades, so no orphan rows remain server-side.
-- But `deptGroupByChannel` / `deptConversationIds` are PERSISTED ON DEVICES and
-- never pruned, and they drive push routing and mute lookup. A stale pointer to
-- a deleted channel therefore survives on every member's phone until reinstall.
-- Run OFF-PEAK, and see plan §7.3 item 17 for the device check.
--
-- ── Companion control ─────────────────────────────────────────────────────────
--
-- `20260805000000_backfill_dept_broadcast_channels.sql` re-mints a #broadcast for
-- every (org, level) that lacks one and its `missing` CTE has NO tenant filter,
-- so re-running it would hand every one of these straight back. Its header
-- already carries a DO-NOT-RE-RUN warning and the exact clause to add.
--
-- ── Down migration ───────────────────────────────────────────────────────────
--
-- There is none, and there cannot be: these rows are indistinguishable from ones
-- the service would have created, which is why the snapshot above is mandatory.
-- Restoring means re-inserting from it by hand — and their E2EE groups are gone
-- either way, since the key material never lived on the server.
