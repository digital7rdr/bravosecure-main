-- Bravo Secure — Backup Round 8 schema fixes
--
-- Audit of the encrypted-backup pipeline found four schema-level gaps
-- that prevented "100% identical backup" on restore:
--
--   1. backup_merkle_commits table referenced by Round 5 / S8 code
--      was never created — every putMerkleCommit / getMerkleCommit
--      silently 503'd, so S8 Merkle integrity protection has been
--      INERT in production since the day it shipped.
--
--   2. messages_backup has no (owner, msg_created_at, message_id)
--      index. The pagination read uses ORDER BY msg_created_at +
--      LIMIT, but with no secondary key the timestamp-tie ordering
--      is non-deterministic between calls. Combined with the
--      timestamp-only `>` cursor (fixed in code), this produced
--      page-boundary row drops on every paginated restore.
--
--   3. conversation_backups was missing columns for is_muted,
--      is_pinned, default_ttl_sec, unread_count, is_custom_name,
--      and group_state. The mirror could not ship them; the
--      restore could not see them. After restore, mute/pin/TTL
--      reset, custom names overwrote, and groups had no admin /
--      master-key state — leaving them effectively read-only.
--
--   4. sealed_envelope_archive ts_ms index lacked envelope_id as
--      secondary key — same tie-skip pattern as messages_backup.
--
-- All migrations IF NOT EXISTS / ADD COLUMN guarded so re-running
-- on a partially-deployed environment is safe.

-- ─── 1. backup_merkle_commits (S8 integrity verification) ─────────────
--
-- One row per user. Stores the latest signed Merkle root over their
-- mirrored message history. The signature is verified at restore time
-- against the user's identity public key (recovered from the unwrapped
-- backup bundle). Server cannot forge a new commit (no priv key) and
-- can only replay an old, legitimately-signed commit; the client's
-- locally-cached last-seen seq closes that gap on same-device
-- restores.

CREATE TABLE IF NOT EXISTS public.backup_merkle_commits (
  user_id     UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  root_b64    TEXT        NOT NULL,
  row_count   INT         NOT NULL,
  seq         BIGINT      NOT NULL,
  sent_at_ms  BIGINT      NOT NULL,
  sig_b64     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER backup_merkle_commits_touch
  BEFORE UPDATE ON public.backup_merkle_commits
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.backup_merkle_commits DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.backup_merkle_commits FROM anon, authenticated;

-- ─── 2. messages_backup tuple-paging index ─────────────────────────────
--
-- Pagination is now (msg_created_at, message_id) ASC. The existing
-- *_owner_since_idx is DESC and the wrong direction for replay; this
-- new index covers the ascending tuple sort exactly.

CREATE INDEX IF NOT EXISTS messages_backup_owner_ts_id_idx
  ON public.messages_backup(owner_user_id, msg_created_at ASC, message_id ASC);

-- ─── 3. conversation_backups extra metadata columns ────────────────────
--
-- ALTER ... ADD COLUMN IF NOT EXISTS is Postgres 9.6+; safe on the
-- Supabase fleet. Defaults are chosen so legacy rows behave like the
-- pre-migration code (mute/pin off, no TTL, no custom name).

ALTER TABLE public.conversation_backups
  ADD COLUMN IF NOT EXISTS is_muted        BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_pinned       BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS default_ttl_sec INTEGER,
  ADD COLUMN IF NOT EXISTS unread_count    INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_custom_name  BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS group_state     JSONB;

COMMENT ON COLUMN public.conversation_backups.group_state IS
  'For kind=group: serialized GroupState ({owner, members, masterKeyB64, epoch, name}). NULL for direct/system rooms.';

-- ─── 4. sealed_envelope_archive tuple-paging index ─────────────────────
--
-- Pagination uses (ts_ms, envelope_id) tuple now. Existing
-- recipient_ts index is fine for filter, but the ORDER BY tuple
-- needs an index that includes envelope_id as the secondary key.

CREATE INDEX IF NOT EXISTS sealed_envelope_archive_recipient_ts_id_idx
  ON public.sealed_envelope_archive (recipient_user_id, ts_ms ASC, envelope_id ASC);

-- ─── 5. messages_backup mirrored_at index for retention sweeper ────────
--
-- Sealed archive sweeper runs by ts_ms; messages_backup retention
-- (currently absent — Phase-2 once we know the storage cost shape)
-- would need this index. Adding now so the next round doesn't have
-- to bump schema again.

CREATE INDEX IF NOT EXISTS messages_backup_mirrored_at_idx
  ON public.messages_backup(mirrored_at);
