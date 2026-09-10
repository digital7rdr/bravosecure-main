-- Bravo Secure — System messenger
--
-- Extends the existing messenger (conversations + members + envelopes) with
-- server-authored "system broadcasts" so ops workflows can post structured
-- notifications inside conversations WITHOUT breaking end-to-end encryption
-- of user→user message_envelopes.
--
-- Examples:
--   • Booking approved → inserts a system_broadcast of kind='booking_approved'
--     into the client's direct Bravo System conversation.
--   • Mission dispatched → creates a group ops-room conversation with crew +
--     client + ops, then inserts a 'mission_started' broadcast as the first
--     card in that thread.
--
-- Client renders system_broadcasts inline alongside decrypted envelopes.

-- ─── System actor user ─────────────────────────────────────────────────────
-- A deterministic UUID so every dev/staging DB has the same system user id.
-- Display name is a plain row in `users` — it has no Signal identity, no
-- device, and can never hold the session key for any E2E channel; it exists
-- purely so `conversations.created_by` + `conversation_members.user_id` FK
-- constraints are satisfied.

DO $$
DECLARE
  system_uid CONSTANT UUID := '00000000-0000-0000-0000-000000000001';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = system_uid) THEN
    INSERT INTO public.users (id, display_name, email, created_at)
    VALUES (system_uid, 'Bravo System', 'system@bravo.secure', NOW())
    ON CONFLICT (id) DO NOTHING;
  END IF;
END$$;

-- ─── system_broadcasts ────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'system_broadcast_kind') THEN
    CREATE TYPE system_broadcast_kind AS ENUM (
      'booking_submitted',
      'booking_approved',
      'booking_rejected',
      'booking_cancelled',
      'mission_started',
      'mission_pickup',
      'mission_live',
      'mission_sos',
      'mission_sos_ack',
      'mission_sos_resolved',
      'mission_abort',
      'mission_complete',
      'agent_approved',
      'agent_rejected',
      'payment_captured',
      'custom'
    );
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS public.system_broadcasts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  kind            system_broadcast_kind NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  severity        TEXT NOT NULL DEFAULT 'info',   -- info | ok | warn | err
  subject_type    TEXT,                            -- 'booking' | 'mission' | 'job' | 'agent'
  subject_id      TEXT,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by      UUID REFERENCES public.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS system_broadcasts_conv_idx
  ON public.system_broadcasts(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS system_broadcasts_subject_idx
  ON public.system_broadcasts(subject_type, subject_id)
  WHERE subject_type IS NOT NULL;

-- ─── link missions → their ops-room group conversation ────────────────────
-- `missions.comms_channel_id` already exists; add an index + fk if it isn't
-- referenced yet.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'missions_comms_channel_fk'
  ) THEN
    -- Table may have been created without the FK; add it now.
    BEGIN
      ALTER TABLE public.missions
        ADD CONSTRAINT missions_comms_channel_fk
        FOREIGN KEY (comms_channel_id)
        REFERENCES public.conversations(id)
        ON DELETE SET NULL;
    EXCEPTION WHEN undefined_column OR undefined_table THEN
      -- missions table lives under a different search_path or doesn't exist
      -- yet; skip gracefully so this migration is safe on fresh DBs.
      NULL;
    END;
  END IF;
END$$;
