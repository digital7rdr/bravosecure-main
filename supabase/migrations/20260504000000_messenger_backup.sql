-- Bravo Secure — Encrypted messenger backup (WhatsApp parity)
--
-- Three tables that together let a user reinstall the app, log back in,
-- enter their backup password, and rehydrate every conversation +
-- message. The Supabase row never sees plaintext — ciphertext stays
-- wrapped with the user's Signal session keys (mirrored as-is from the
-- live envelope flow), and the Signal identity itself is wrapped with
-- a master key derived from the backup password via argon2id.
--
-- Trust model:
--   • Server (messenger-service via service-role key) is the only
--     writer/reader. RLS is OFF on all three tables — auth lives in
--     the API layer, matching the existing convention from
--     20260416000000_init_phase1.sql.
--   • Brute-force protection is enforced server-side: failed_attempts
--     counter on identity_backups, locked_until cools off for 1h
--     after 5 wrong attempts. Mirrors WhatsApp's HSM-backed throttling
--     (we have no HSM; this is the closest a stock Postgres can get).
--   • If the user forgets the password and burns through the lockout
--     repeatedly, the row stays — but they can manually delete it via
--     POST /backup/forget and start fresh, matching WhatsApp's
--     "permanently lost" flow.

-- ─── messages_backup ─────────────────────────────────────────────────────
-- One row per (owner, message). The same envelope can produce TWO rows
-- (one for sender, one for recipient) so each side rehydrates their own
-- view of the conversation independently. PK on (owner_user_id,
-- message_id) so duplicate mirror writes from a flaky network are no-ops.

CREATE TABLE IF NOT EXISTS public.messages_backup (
  owner_user_id   UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  message_id      TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  recipient_id    TEXT,
  msg_type        TEXT NOT NULL DEFAULT 'text',  -- 'text' | 'image' | 'call' | 'system' | 'admin'
  ciphertext      BYTEA NOT NULL,                -- already E2E-wrapped
  ciphertext_type SMALLINT NOT NULL DEFAULT 1,   -- libsignal whisper type
  envelope_meta   JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {kind, group_id, sealed_sender, ...}
  msg_created_at  TIMESTAMPTZ NOT NULL,
  mirrored_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_user_id, message_id)
);

CREATE INDEX IF NOT EXISTS messages_backup_owner_conv_idx
  ON public.messages_backup(owner_user_id, conversation_id, msg_created_at);

CREATE INDEX IF NOT EXISTS messages_backup_owner_since_idx
  ON public.messages_backup(owner_user_id, msg_created_at DESC);

-- ─── conversation_backups ────────────────────────────────────────────────
-- Conversation list rehydrates from here so the chat list isn't empty
-- on restore. Members for groups stored as a JSONB array of
-- {userId, displayName} so the receiver UI can render names without a
-- separate lookup. Direct chats store a single peer entry the same way.

CREATE TABLE IF NOT EXISTS public.conversation_backups (
  owner_user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('direct','group','system')),
  name             TEXT,
  members          JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_message_at  TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_user_id, conversation_id)
);

CREATE TRIGGER conversation_backups_touch
  BEFORE UPDATE ON public.conversation_backups
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE INDEX IF NOT EXISTS conversation_backups_owner_idx
  ON public.conversation_backups(owner_user_id, last_message_at DESC NULLS LAST);

-- ─── identity_backups ────────────────────────────────────────────────────
-- The wrapped Signal identity bundle + KDF parameters needed to unwrap
-- it. failed_attempts / locked_until enforce the brute-force throttle.
--
-- Wire format (set by the client):
--   wrapped_master_key      : AES-256-GCM(master_key) under argon2id(password,salt)
--   wrapped_identity_bundle : AES-256-GCM(json(identity bundle)) under master_key
--   salt                    : 16 random bytes — argon2id input
--   kdf_params              : {algo:'argon2id', iters, mem_kib, parallelism, version}
--
-- The two-layer wrap (master key + bundle) means rotating the password
-- only re-wraps a 32-byte master key, not the entire identity payload.
-- It also matches WhatsApp's design where the user-facing password
-- protects a vault key, not the chat key directly.

CREATE TABLE IF NOT EXISTS public.identity_backups (
  user_id                 UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  wrapped_master_key      BYTEA NOT NULL,
  salt                    BYTEA NOT NULL,
  kdf_params              JSONB NOT NULL,
  wrapped_identity_bundle BYTEA NOT NULL,
  failed_attempts         INT  NOT NULL DEFAULT 0,
  locked_until            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER identity_backups_touch
  BEFORE UPDATE ON public.identity_backups
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─── RLS posture ─────────────────────────────────────────────────────────
-- Per Phase-1 convention: server (service_role) is the only client of
-- these tables. The mobile app reaches them via messenger-service REST,
-- never via supabase-js directly. Leaving RLS OFF + denying anon role
-- explicitly so a leaked anon key can't enumerate ciphertexts.

REVOKE ALL ON public.messages_backup        FROM anon, authenticated;
REVOKE ALL ON public.conversation_backups   FROM anon, authenticated;
REVOKE ALL ON public.identity_backups       FROM anon, authenticated;
