-- Bravo Secure — Encrypted ratchet-state snapshot (Sprint-6 backend hand-off)
--
-- Closes the "restore-decrypt:error in DoCipher, status: 2" gap. After a
-- reinstall the identity backup restores the long-lived Signal identity
-- key, but the per-peer Double Ratchet chain state is gone — every
-- envelope from a peer who hasn't yet seen our new identity drops with a
-- bad-MAC / DoCipher failure that the user just experiences as "I lost
-- some of my messages".
--
-- The client serialises its live session-ratchet state, AES-256-GCM
-- encrypts it under the backup master key, and uploads the wrapped blob
-- here. On restore the client pulls the latest snapshot, decrypts
-- locally, and replays every session into the fresh SQLCipher store
-- BEFORE processing any inbound envelope. The plaintext never leaves
-- the device — the server only sees ciphertext.
--
-- Rollback defence:
--   The server enforces a strict monotonic `seq`. An UPSERT whose `seq`
--   is <= the stored seq is rejected with 409, which prevents a
--   compromised server from serving an older snapshot to roll the
--   client back to a prior ratchet state (and thereby re-open a
--   one-time-key window the chain had already burned).
--
-- Trust model:
--   • Only the messenger-service service-role key writes/reads.
--   • Server CANNOT decrypt the blob (no master key).
--   • Server CAN observe the seq + size, which is acceptable — the
--     attacker model already lets a server-side attacker count
--     uploads.
--   • RLS off; anon/authenticated explicitly revoked, matching every
--     other server-mediated table in the backup module.

CREATE TABLE IF NOT EXISTS public.backup_session_snapshots (
  user_id     UUID         PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  -- AES-256-GCM ciphertext over the JSON-serialised RatchetSnapshotPlain,
  -- wrapped under the same backup master key that identity_backups
  -- wraps the identity bundle with. IV is 12 bytes prepended to the
  -- ciphertext (same convention as aesGcmEncrypt in backupCrypto.ts).
  blob        BYTEA        NOT NULL,
  -- Monotonic per-account counter. Server REJECTS upserts whose seq is
  -- <= the stored seq (HTTP 409 conflict). Server-visible so the
  -- restore-time rollback check can verify on the wire BEFORE pulling
  -- the (potentially large) blob.
  seq         BIGINT       NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER backup_session_snapshots_touch
  BEFORE UPDATE ON public.backup_session_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

REVOKE ALL ON public.backup_session_snapshots FROM anon, authenticated;
