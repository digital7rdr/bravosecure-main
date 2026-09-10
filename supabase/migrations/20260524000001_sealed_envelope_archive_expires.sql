-- Audit P1-T1 — disappearing-message TTL contract for the sealed-envelope archive.
--
-- The original archive table retained every row for the full 90-day
-- default TTL, regardless of the sender's recipient-side
-- `expiresAtSec` deadline. A "1-hour disappearing" message therefore
-- lived 90 days in the archive even though the active Redis relay
-- correctly self-evicted at the 1-hour mark — silently breaking the
-- disappearing-message contract for any recipient that restored from
-- the archive after the deadline.
--
-- Fix:
--   1. Add `expires_at_sec` (BIGINT, NULLABLE) — populated by
--      `BackupService.archiveSealedEnvelope` when the sender supplied
--      a TTL. NULL means "no per-envelope deadline; the default 90-day
--      archive retention applies."
--   2. Add a partial index so the sweeper / restore filter can scan
--      `expires_at_sec < now()` cheaply without paying for every row.
--
-- Safe to apply on a live deployment:
--   * additive column with a NULL default — no rewrite, no lock beyond
--     the brief ALTER (Postgres adds nullable columns in O(1) since 11).
--   * index built CONCURRENTLY would be ideal but requires the
--     migration runner to opt out of the implicit transaction, which
--     supabase's migration framework doesn't do; the table is small
--     in early production so a synchronous CREATE INDEX is acceptable
--     here. Re-issue CONCURRENTLY in a follow-up DDL if the table
--     grows beyond a few million rows.

ALTER TABLE public.sealed_envelope_archive
  ADD COLUMN IF NOT EXISTS expires_at_sec BIGINT;

CREATE INDEX IF NOT EXISTS sealed_envelope_archive_expires_at_idx
  ON public.sealed_envelope_archive (expires_at_sec)
  WHERE expires_at_sec IS NOT NULL;
