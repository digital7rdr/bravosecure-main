-- Bravo Secure Pro — linked-member extensions (founder spec 2026-08-03):
--   · relationship: set when adding a member, rendered as a badge on member rows.
--   · held_until:   owner-imposed hold — while in the future the member cannot
--     spend the owner's credits or use the owner's Pro plan (dashboard access
--     and payer resolution both check it). NULL / past = not held.
-- Invites now also REQUIRE an existing individual Bravo account (enforced in
-- FamilyService.invite — pending-by-phone rows are no longer created).

ALTER TABLE public.family_members
  ADD COLUMN IF NOT EXISTS relationship text,
  ADD COLUMN IF NOT EXISTS held_until timestamptz;

COMMENT ON COLUMN public.family_members.relationship IS
  'Owner-declared relationship of the member (spouse/son/daughter/…) — badge on member rows.';
COMMENT ON COLUMN public.family_members.held_until IS
  'Owner-imposed hold: while > now() the member cannot spend owner credits or use the owner''s Pro plan.';
