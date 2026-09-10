-- Bravo Secure — Server-side sealed-envelope archive
--
-- Closes the "reinstalled and most messages disappeared" gap by giving
-- the relay a long-term mirror table. Every accepted envelope's opaque
-- outer wrap (Sealed Sender v2) is upserted here at submit time, keyed
-- by recipient userId. The server stays cryptographically blind: the
-- bytes are the same opaque blob the relay shipped — no decrypt, no
-- sender link.
--
-- Why this exists alongside messages_backup:
--   messages_backup is the CLIENT-SIDE mirror — it requires the user's
--   master key to be unlocked in app memory, which only happens after
--   they enter their backup password. Many real sessions never unlock
--   the mirror (cold start without prompt, user dismissed prompt, OS
--   killed app between unlocks), so messages sent in those windows
--   never reached messages_backup. On reinstall the user saw "most of
--   my chat is gone" even though the live relay had delivered them.
--
--   This archive is unconditional. The relay writes here on EVERY
--   submit, regardless of whether the recipient is online, regardless
--   of whether their client mirror is unlocked, regardless of any
--   client-side state. On restore, the client pulls these rows and
--   unseals them locally with the recovered identity priv key — same
--   path as a live envelope.deliver, just deferred.
--
-- Privacy:
--   Sealed Sender means outerSealed has no field that links the bytes
--   back to the sender. The server only sees recipient_user_id, which
--   it already learns at submit time anyway (it has to route).
--
-- Retention:
--   90 days, sweep via a separate cron. Long enough to recover from
--   the typical reinstall-after-vacation case, short enough to bound
--   storage. Tune via deployment config.

CREATE TABLE IF NOT EXISTS public.sealed_envelope_archive (
  recipient_user_id UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  envelope_id       UUID        NOT NULL,
  outer_sealed      BYTEA       NOT NULL,
  ts_ms             BIGINT      NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (recipient_user_id, envelope_id)
);

CREATE INDEX IF NOT EXISTS sealed_envelope_archive_recipient_ts_idx
  ON public.sealed_envelope_archive (recipient_user_id, ts_ms);

-- RLS off — service-role-only, same pattern as the rest of the backup
-- tables. Auth is enforced at the messenger-service API layer.
ALTER TABLE public.sealed_envelope_archive DISABLE ROW LEVEL SECURITY;
