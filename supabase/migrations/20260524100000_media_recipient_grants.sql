-- Audit P0-A1 — Media-attachment recipient grants
--
-- Closes the "any authed JWT can sign a download URL for any object key"
-- hole on `POST /media/download-url/:key`. Before this migration, the
-- MediaService had no way to know who was authorized to fetch a given
-- attachment — sealed-sender by design keeps the relay blind to the
-- envelope's recipient list, but that left the download-url path with
-- ZERO authorization. A user knowing any UUID could pull every blob.
--
-- The fix is a separate, recipient-scoped table the SENDER populates
-- at upload time (`POST /media/upload-url` returns an `uploadHandle`
-- the client uses to register the intended recipient set alongside the
-- sealed envelope submission). At download time, MediaService consults
-- this table and refuses to sign for any caller not in the grant set.
--
-- The grant set lives in a SEPARATE table from sealed_envelope_archive
-- because:
--   1. one attachment can be referenced by N envelopes (group chat —
--      same object_key fans out to N recipients);
--   2. envelope archives are 90-day retention; grants should match the
--      maximum dwell of any envelope that referenced them, expiring
--      independently as envelopes age out;
--   3. keeping object_key indexed separately lets MediaService check
--      authorization without touching the archive table on every
--      download request.
--
-- Privacy: this table holds (object_key, recipient_user_id) pairs — no
-- sender link (sealed-sender preserved), no plaintext, no key material.
-- The object_key is already known to the recipient (it travels inside
-- the sealed envelope they fetch), so the table holds no information
-- the recipient didn't already have.

CREATE TABLE IF NOT EXISTS public.media_recipient_grants (
  object_key        TEXT        NOT NULL,
  recipient_user_id UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  granted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Tracks the max relay dwell of any envelope that referenced this
  -- object. Defaults to 30 days (Signal-spec relay dwell); media
  -- delete-on-retract / delete-on-expire also remove the matching
  -- grant rows so this is the long-tail safety net for archived
  -- envelopes the sender didn't explicitly retract.
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  PRIMARY KEY (object_key, recipient_user_id)
);

-- Lookup index for the read path: "is this caller in the grant set
-- for this object_key?" — covered by the PK, but a separate index
-- on recipient_user_id helps the "list every object this user can
-- still read" path the future P0-A4 expire-side cleanup needs.
CREATE INDEX IF NOT EXISTS media_recipient_grants_recipient_idx
  ON public.media_recipient_grants (recipient_user_id);

-- Sweep index: drop grants whose expires_at is in the past on the
-- daily orphan cron (already wired in relay.cron.ts).
CREATE INDEX IF NOT EXISTS media_recipient_grants_expires_idx
  ON public.media_recipient_grants (expires_at);

-- RLS off — service-role-only, same pattern as sealed_envelope_archive.
-- Auth is enforced at the messenger-service API layer.
ALTER TABLE public.media_recipient_grants DISABLE ROW LEVEL SECURITY;
