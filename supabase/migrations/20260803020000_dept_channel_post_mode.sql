-- Enterprise Dept Channels scope v2 — Phase 2: split VISIBILITY from POSTING.
--
-- Frame A9: "Support Open Chat, Read-only, Announcement-only and Admin-only modes."
-- Page 10 rule 2: "Visible does not automatically grant posting, upload or
-- management rights."
--
-- WHAT IS ACTUALLY WRONG TODAY. `access` is doing two unrelated jobs, and only
-- one of them works:
--
--   * VISIBILITY (works) — `access = 'restricted'` (or channel_type='incident')
--     makes seedChannelMembers skip non-managers, so they never get a
--     department_channel_members row and listChannels' JOIN never returns it.
--   * POSTING (does NOT work) — posting is gated by the member row's `role`
--     ('admin' posts, 'viewer' cannot), and seeding gives EVERY non-manager
--     'viewer' whatever the access value is. So `standard` and `read_only` seed
--     identically and behave identically: `read_only` is a display badge only.
--
-- So we do not have three posting modes, we have one ("managers post"). This
-- adds the column that actually drives it and leaves `access` to mean exactly
-- one thing: who can SEE the channel.
--
-- DEFAULT IS 'read_only' ON PURPOSE — that is precisely today's behaviour
-- (managers post, members read), so every existing channel keeps behaving as it
-- does now. `open` is the genuinely NEW capability. Same additive discipline as
-- 20260629000002 and the Phase 1 hierarchy migration: zero behaviour change on
-- existing rows.

ALTER TABLE public.department_channels
  ADD COLUMN IF NOT EXISTS post_mode TEXT NOT NULL DEFAULT 'read_only';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'department_channels_post_mode_valid'
  ) THEN
    ALTER TABLE public.department_channels
      ADD CONSTRAINT department_channels_post_mode_valid
        CHECK (post_mode IN ('open', 'read_only', 'announcement', 'admin_only'));
  END IF;
END $$;

-- ─── The mandatory #broadcast ────────────────────────────────────────────────
--
-- Page 10 rule 1: "#broadcast exists at each level; Members cannot post, reply
-- or call in it." Frame A9: "Create a mandatory non-deletable #broadcast at
-- every hierarchy level."
--
-- `is_broadcast` is what makes it non-deletable, and the rule is enforced in the
-- DB rather than in the delete handler: a service-level `if` is one code path
-- among several (deleteChannel, a future bulk purge, a script), which is exactly
-- the enumeration trap this scope keeps falling into. A BEFORE DELETE trigger
-- covers every writer at once.
ALTER TABLE public.department_channels
  ADD COLUMN IF NOT EXISTS is_broadcast BOOLEAN NOT NULL DEFAULT FALSE;

-- EXACTLY ONE #broadcast per (org, level) — A9 says "at every hierarchy LEVEL",
-- so an org has at most four, not one per channel. This index is the guarantee:
-- a second insert at the same level fails regardless of which code path tries.
--
-- ⚠️ READING NOTE for whoever revisits this: "at every hierarchy level" is read
-- here as one-per-level (4 max per org). The alternative reading is one per
-- NODE (every channel gets a #broadcast child). Per-level is the plainer
-- reading and far cheaper; if the founder means per-node, change this index to
-- (org_id, parent_id) and the ensure-call moves from level scope to node scope.
-- Flagged in the plan doc rather than decided silently.
CREATE UNIQUE INDEX IF NOT EXISTS dept_channels_one_broadcast_per_level
  ON public.department_channels(org_id, level)
  WHERE is_broadcast AND archived_at IS NULL;

CREATE OR REPLACE FUNCTION public.dept_channel_block_broadcast_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.is_broadcast THEN
    RAISE EXCEPTION 'broadcast_channel_cannot_be_deleted';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dept_channel_block_broadcast_delete_trg ON public.department_channels;
CREATE TRIGGER dept_channel_block_broadcast_delete_trg
  BEFORE DELETE ON public.department_channels
  FOR EACH ROW EXECUTE FUNCTION public.dept_channel_block_broadcast_delete();

-- A #broadcast is announcement-mode by definition. Enforced here rather than
-- trusted from the caller, for the same reason `level` is derived in Phase 1:
-- a writer must not be able to create a "broadcast" that members can post in.
CREATE OR REPLACE FUNCTION public.dept_channel_broadcast_mode()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_broadcast THEN
    NEW.post_mode := 'announcement';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dept_channel_broadcast_mode_trg ON public.department_channels;
CREATE TRIGGER dept_channel_broadcast_mode_trg
  BEFORE INSERT OR UPDATE ON public.department_channels
  FOR EACH ROW EXECUTE FUNCTION public.dept_channel_broadcast_mode();

-- ── THE PRECISE SCOPE OF THE NON-DELETE TRIGGER ─────────────────────────────
--
-- "A BEFORE DELETE trigger covers every writer at once" is true of every writer
-- of DELETE, which is what it says — but two things sit outside it, and the
-- claim reads broader than it is:
--
--   1. `UPDATE ... SET is_broadcast = false` followed by DELETE defeats it in
--      two statements. Unreachable through the API (nothing writes that column:
--      it is absent from every DTO by design), so this is DDL-only.
--   2. ARCHIVE is guarded in the SERVICE (`archiveChannel`), not here — and the
--      PDF calls archive the PREFERRED operation over delete. That is the
--      enumeration trap this file argues against, applied to the less-used verb.
--
-- (2) is not a one-liner and is deliberately left as a follow-up: archive has a
-- direct-vs-cascade distinction (a child #broadcast IS archived when its parent
-- is, on purpose), so a trigger has to express "no direct archive, yes cascade
-- archive" rather than a flat refusal. Recorded so it is a known asymmetry
-- rather than an implicit one.

-- ── Down migration (uncomment to revert) ─────────────────────────────────────
-- DROP TRIGGER IF EXISTS dept_channel_broadcast_mode_trg ON public.department_channels;
-- DROP TRIGGER IF EXISTS dept_channel_block_broadcast_delete_trg ON public.department_channels;
-- DROP FUNCTION IF EXISTS public.dept_channel_broadcast_mode();
-- DROP FUNCTION IF EXISTS public.dept_channel_block_broadcast_delete();
-- DROP INDEX IF EXISTS dept_channels_one_broadcast_per_level;
-- ALTER TABLE public.department_channels
--   DROP CONSTRAINT IF EXISTS department_channels_post_mode_valid,
--   DROP COLUMN IF EXISTS is_broadcast,
--   DROP COLUMN IF EXISTS post_mode;
