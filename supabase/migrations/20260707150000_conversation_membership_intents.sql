-- RS-02 — conversation membership-intent queue (generic conversations).
--
-- E2EE INVARIANT (security stop-condition — do NOT weaken): the group master
-- key never reaches the server, so the server cannot rekey. The conversation
-- add/remove-member endpoints previously mutated ONLY conversation_members —
-- a member removed through them kept the group master key indefinitely
-- (no forward secrecy). This queue is the same seam department channels
-- (channel_membership_intents) and booking Ops Rooms (dispatch_room_intents)
-- already use: the server records the metadata change + a pending intent; a
-- conversation ADMIN's device drains it and broadcasts the sanctioned
-- planAddAndRekey / planRemoveAndRekey group actions, then acks.
-- This table holds NO key material.

CREATE TABLE IF NOT EXISTS public.conversation_membership_intents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  member_user_id  UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  action          TEXT NOT NULL CHECK (action IN ('add','remove')),
  state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done')),
  requested_by    UUID REFERENCES public.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at      TIMESTAMPTZ
);

-- Admin devices drain pending intents oldest-first.
CREATE INDEX IF NOT EXISTS conversation_membership_intents_pending_idx
  ON public.conversation_membership_intents (conversation_id, created_at)
  WHERE state = 'pending';

-- RLS deny-by-default (backend connection bypasses; anon denied).
ALTER TABLE public.conversation_membership_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_membership_intents FORCE ROW LEVEL SECURITY;

-- Down:
-- DROP TABLE IF EXISTS public.conversation_membership_intents;
