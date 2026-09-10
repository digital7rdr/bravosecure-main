-- Auto-dispatch Ops Room — group-key membership intent queue (BUILD_RUNBOOK Step 12).
--
-- E2EE INVARIANT (security stop-condition — do NOT weaken): the group master key
-- never reaches the server. When an agency assigns/removes a CPO to a booking's Ops
-- Room (Step 13's POST /org/bookings/:id/crew), the server can only record the
-- METADATA change (conversation_members) and QUEUE an intent here. The AGENCY's own
-- device — the room creator/admin (set on the auto path in createMissionOpsRoom) —
-- drains this queue and performs the actual Signal group change:
--   - add    → planAddAndRekey   (forward secrecy: the new CPO can't read prior msgs)
--   - remove → planRemoveAndRekey (remove@E then rekey@E+1 — without the rekey a
--              removed CPO keeps the master key and can decrypt <=30d relay dwell)
-- Until the agency device is online to broadcast the rekey, the change is only
-- eventually enforced. This table holds NO key material — only "who/which booking/
-- which conversation", so the agency device knows what add/remove+rekey to broadcast.
--
-- This is the booking-Ops-Room parallel of channel_membership_intents (department
-- channels). Scoped by org_user_id (the agency) instead of channel-admin membership.

CREATE TABLE IF NOT EXISTS public.dispatch_room_intents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      UUID NOT NULL REFERENCES public.lite_bookings(id) ON DELETE CASCADE,
  -- The Ops Room Signal group the agency device must rekey (lite_bookings.conversation_id).
  conversation_id UUID NOT NULL,
  -- The agency (company-agent users.id) that owns this room and must drain the intent.
  org_user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- The CPO being added to / removed from the room.
  member_user_id  UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- 'add' → agency device runs planAddAndRekey; 'remove' → planRemoveAndRekey.
  action          TEXT NOT NULL DEFAULT 'add' CHECK (action IN ('add','remove')),
  -- 'pending' until the agency device acks it has broadcast the rekey.
  state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done')),
  requested_by    UUID REFERENCES public.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at      TIMESTAMPTZ
);

-- The agency device drains its pending intents, oldest first.
CREATE INDEX IF NOT EXISTS dispatch_room_intents_pending_idx
  ON public.dispatch_room_intents(org_user_id, created_at)
  WHERE state = 'pending';

-- RLS deny-by-default (backend rolbypassrls bypasses; anon denied).
ALTER TABLE public.dispatch_room_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_room_intents FORCE  ROW LEVEL SECURITY;

-- Down:
-- DROP TABLE IF EXISTS public.dispatch_room_intents;
