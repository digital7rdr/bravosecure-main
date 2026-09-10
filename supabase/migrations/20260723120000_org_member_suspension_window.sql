-- CPO suspension window + mandatory reason (2026-07-23).
--
-- Suspension keeps every existing security side-effect (session revoke, channel
-- strip, group-key rotation) — these columns only add WHY and UNTIL WHEN:
--   * suspend_reason  — mandatory at write time; shown to the CPO on the
--                       AccessEndedScreen when they try to log back in.
--   * suspended_until — NULL means indefinite (the pre-existing behaviour).
--                       Non-NULL auto-expires via the lazy sweep in
--                       OrgCpoService.expireLapsedSuspensions, which runs the
--                       normal reinstate path so channels are re-added.
-- Additive + idempotent: existing suspended rows keep working with all-NULL
-- columns and simply read as "indefinite, no reason recorded".

ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS suspended_from  timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_until timestamptz,
  ADD COLUMN IF NOT EXISTS suspend_reason  text,
  ADD COLUMN IF NOT EXISTS suspended_by    uuid REFERENCES public.users(id);

-- The expiry sweep only ever scans timed suspensions for one org.
CREATE INDEX IF NOT EXISTS org_members_suspension_expiry_idx
  ON public.org_members (org_user_id, suspended_until)
  WHERE status = 'suspended' AND suspended_until IS NOT NULL;

COMMENT ON COLUMN public.org_members.suspended_until IS
  'NULL = indefinite suspension. Non-NULL = auto-expires; the lazy sweep reinstates via setMemberStatus so channel membership is restored.';
COMMENT ON COLUMN public.org_members.suspend_reason IS
  'Mandatory when status=suspended. Surfaced to the suspended CPO at login.';
