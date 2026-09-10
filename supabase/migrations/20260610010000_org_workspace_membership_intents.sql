-- Org chat workspace — membership-change propagation seam (Phase 3).
--
-- E2EE INVARIANT (security stop-condition — do NOT weaken): the group master
-- key never reaches the server. When the org adds/removes a CPO from a channel
-- via the ops console / manager API, the server can only record the METADATA
-- change (department_channel_members) and QUEUE an intent. The admin's device
-- drains this queue and performs the actual Signal group change:
--   - add    → planAddAndRekey   (forward secrecy: new member can't read prior)
--   - remove → planRemoveAndRekey (remove@E then rekey@E+1 — without the rekey a
--              removed CPO keeps the master key and can decrypt <=30d relay dwell)
-- Until an admin device is online to broadcast the rekey, the change is only
-- eventually enforced. That window is documented + accepted (see plan).
--
-- This table is the queue. It holds NO key material — only "who/what/which
-- channel", so the admin device knows what add/remove+rekey to broadcast.

CREATE TABLE IF NOT EXISTS public.channel_membership_intents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id    UUID NOT NULL REFERENCES public.department_channels(id) ON DELETE CASCADE,
  -- The member the group change concerns.
  member_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- 'add' → admin device runs planAddAndRekey; 'remove' → planRemoveAndRekey.
  action        TEXT NOT NULL CHECK (action IN ('add','remove')),
  -- 'pending' until an admin device acks it has broadcast the rekey.
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done')),
  requested_by  UUID REFERENCES public.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at    TIMESTAMPTZ
);

-- Admin device drains pending intents per channel, oldest first.
CREATE INDEX IF NOT EXISTS channel_membership_intents_pending_idx
  ON public.channel_membership_intents(channel_id, created_at)
  WHERE state = 'pending';

-- RLS deny-by-default (backend rolbypassrls bypasses; anon denied).
ALTER TABLE public.channel_membership_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_membership_intents FORCE  ROW LEVEL SECURITY;

-- Down:
-- DROP TABLE IF EXISTS public.channel_membership_intents;
