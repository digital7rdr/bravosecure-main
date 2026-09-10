-- Founder QA 2026-08-08 (Q14) — retire the multi-use referral-link lane.
--
-- The mint/list/revoke UI is gone from the client, which left every LIVE
-- referral link claimable until expiry with NO kill switch anywhere (edge
-- review MEDIUM-7) — and API-minted links can carry a NULL expiry, i.e.
-- claimable forever. Revoke them all: the founder's decision is that direct
-- (bound, single-use) invites are the only lane.
--
-- Scope guards: REFERRAL rows only — a row is an invite iff it carries a
-- bound contact (20260808010000's discriminator), and invites stay live.
-- Idempotent: already-revoked rows are untouched.
--
-- Pending join requests submitted through these links are NOT touched — they
-- remain decidable in the admin's JOIN REQUESTS inbox.

UPDATE public.enterprise_referral_links
   SET revoked_at = NOW()
 WHERE revoked_at IS NULL
   AND invited_phone IS NULL
   AND invited_email IS NULL;
