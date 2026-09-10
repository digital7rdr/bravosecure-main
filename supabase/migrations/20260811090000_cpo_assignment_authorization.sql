-- CPO assignment authorization persistence.
--
-- The mission code (PMC-XXXXXX) is a ONE-TIME authorization gate, not a login
-- credential. Before this migration the only thing that survived an app restart
-- was the code itself cached in AsyncStorage on the device — so an uninstall /
-- reinstall / new phone wiped it and the CPO was wrongly asked for the code
-- again, even though ops had an active approved assignment for them.
--
-- Authorization now lives server-side on the assignment row: once the CPO
-- verifies the code, `authorized_at` is stamped and the mission view is restored
-- on any device after a normal login. Access ends only when the assignment
-- stops being live (ops revokes/cancels → CANCELLED + revoked_at, schedule
-- finishes → swept to COMPLETED, or the officer is replaced).

ALTER TABLE public.pro_cpo_assignments
  ADD COLUMN IF NOT EXISTS authorized_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at    timestamptz;

COMMENT ON COLUMN public.pro_cpo_assignments.authorized_at IS
  'First successful mission-code verification by the assigned CPO. Non-null = the CPO may restore this mission after reinstall/new device without re-entering the code. Idempotent: never re-stamped.';
COMMENT ON COLUMN public.pro_cpo_assignments.revoked_at IS
  'When ops revoked/cancelled this assignment. Set alongside status=CANCELLED.';

-- Existing cancelled rows predate the column; stamp them so the audit trail is
-- not silently null. updated_at is the closest known revocation moment.
UPDATE public.pro_cpo_assignments
   SET revoked_at = updated_at
 WHERE status = 'CANCELLED' AND revoked_at IS NULL;

-- The restore lookup: "does this CPO have a live, already-authorized
-- assignment?" — runs on every CPO app launch, so it gets its own index.
CREATE INDEX IF NOT EXISTS pro_cpo_assignments_active_authorized_idx
  ON public.pro_cpo_assignments (cpo_user_id, ends_on DESC)
  WHERE status = 'ASSIGNED' AND authorized_at IS NOT NULL;
