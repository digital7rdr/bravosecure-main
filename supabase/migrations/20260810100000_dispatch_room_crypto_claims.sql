-- ──────────────────────────────────────────────────────────────────────
-- B-416 fix (founder-approved 2026-08-10) — single claimed E2EE authority
-- for mission Ops Rooms.
--
-- The room's group key could only ever be minted/distributed by the agency
-- OWNER's device; an offline owner stranded every CPO/manager keyless
-- ("waiting for group master key" → call failed after 25s). Key authority
-- now goes to WHOEVER WINS THIS ATOMIC CLAIM — owner or delegated manager —
-- and everyone else stands down, which is what makes two admin devices
-- structurally unable to mint diverging keys for one room (the B-35
-- permanent-fork class; inboundGroupCreateGate drops cross-owner creates,
-- so a double mint is unrecoverable by design).
--
-- The PRIMARY KEY is the entire arbitration mechanism: the first
-- INSERT ... ON CONFLICT DO NOTHING wins, every later caller reads the
-- existing claimant back. No TTL / force-reclaim in V1 — a reclaim lane
-- would reintroduce the exact fork surface this table closes (dead-claimant
-- escape hatch is a manual DELETE; the winner's key is then recovered from
-- any keyed member via the G-06 window before a re-mint).
--
-- claimed_by carries NO delete action on purpose (matches
-- conversations.created_by): a claim row is a permanent crypto-authority
-- record, and silently freeing it on a manual user hard-delete would turn
-- an arbitrated room back into a claimable one whose members are keyed
-- under the deleted account's mint — the exact re-mint fork this table
-- exists to prevent. A user hard-delete must fail loudly here instead.
--
-- RLS: deny-by-default like every sibling table; the backend connects as
-- postgres (BYPASSRLS).
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.dispatch_room_crypto_claims (
  conversation_id UUID PRIMARY KEY
                  REFERENCES public.conversations(id) ON DELETE CASCADE,
  claimed_by      UUID NOT NULL REFERENCES public.users(id),
  claimed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.dispatch_room_crypto_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_room_crypto_claims FORCE  ROW LEVEL SECURITY;

-- Seed every EXISTING mission Ops Room with the pre-B-416 DE-FACTO key
-- authority: the AGENCY ORG account (org id == company users.id) — the only
-- identity whose device ever ran the drain (and therefore ever minted or
-- could mint) before this migration. NOT raw conversations.created_by: the
-- legacy job-feed lane creates rooms with created_by = an HQ OPS ADMIN, who
-- can never pass OrgManagerGuard for the agency and never runs the mobile
-- drain — seeding such a room to its creator would strand it un-drainable
-- for everyone, forever (strictly worse than pre-B-416, where the owner
-- would have claimed-and-minted it on the assignCrew resume path). On the
-- auto path created_by IS the provider, so the COALESCE chain changes
-- nothing there:
--   1) the org that owns the room's pending/settled intents (the de-facto
--      drain authority — one org per room; reassignment deletes the room),
--   2) the booking's assigned provider (both room↔booking linkages).
-- Rooms with NO org linkage are deliberately left UNSEEDED (no created_by
-- fallback): such a room provably has no key anywhere (the pre-B-416 drain
-- only ever minted where intents existed, and intents imply arm 1), so the
-- first legitimate org claimant minting fresh over it is self-healing —
-- strictly better than a dead ops-admin seed that only the manual hatch
-- could clear.
INSERT INTO public.dispatch_room_crypto_claims (conversation_id, claimed_by)
SELECT c.id,
       COALESCE(
         (SELECT i.org_user_id
            FROM public.dispatch_room_intents i
           WHERE i.conversation_id = c.id
           LIMIT 1),
         (SELECT b.assigned_provider_user_id
            FROM public.lite_bookings b
           WHERE b.conversation_id = c.id
             AND b.assigned_provider_user_id IS NOT NULL
           LIMIT 1),
         (SELECT b2.assigned_provider_user_id
            FROM public.missions m
            JOIN public.lite_bookings b2 ON b2.id = m.booking_id
           WHERE m.comms_channel_id = c.id
             AND b2.assigned_provider_user_id IS NOT NULL
           LIMIT 1))
  FROM public.conversations c
 WHERE (EXISTS (SELECT 1 FROM public.missions m              WHERE m.comms_channel_id = c.id)
     OR EXISTS (SELECT 1 FROM public.lite_bookings b         WHERE b.conversation_id  = c.id)
     OR EXISTS (SELECT 1 FROM public.dispatch_room_intents i WHERE i.conversation_id  = c.id))
   AND COALESCE(
         (SELECT i.org_user_id FROM public.dispatch_room_intents i WHERE i.conversation_id = c.id LIMIT 1),
         (SELECT b.assigned_provider_user_id FROM public.lite_bookings b
           WHERE b.conversation_id = c.id AND b.assigned_provider_user_id IS NOT NULL LIMIT 1),
         (SELECT b2.assigned_provider_user_id FROM public.missions m
            JOIN public.lite_bookings b2 ON b2.id = m.booking_id
           WHERE m.comms_channel_id = c.id AND b2.assigned_provider_user_id IS NOT NULL LIMIT 1)) IS NOT NULL
ON CONFLICT (conversation_id) DO NOTHING;

-- Down: DROP TABLE IF EXISTS public.dispatch_room_crypto_claims;
