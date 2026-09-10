-- B-594 fresh-install restore — carry the user's conversation-delete intent
-- into the backup so a reinstall/device-migration restore does not resurrect a
-- deleted conversation.
--
-- The conversation-tombstone set lived only in per-install AsyncStorage, so a
-- fresh install booted with an empty set and every deleted conversation was
-- re-minted from conversation_backups (then the Home listMine prune removed the
-- server-unlisted ones a couple minutes later — the "flicker"). This adds a
-- server-side flag the delete path mirrors (deleted=true) and a live mirror
-- clears (deleted=false), so restore can arm the tombstone before it applies
-- the staged conversation rows.
--
-- Suppression stays CLIENT-side at the restore upsert (BACKUP_LOOP I3/I7:
-- conversations are not in the message Merkle tree; this touches no message
-- hashing or the flush ledger). Default false = fail-open (I8): an unmarked
-- row is treated as live. Owner-keyed by the existing PK (I5).
ALTER TABLE public.conversation_backups
  ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false;
