-- Dept Chat v2 — spec-compliance batch (2026-07-02):
--   (1) Member attendance DISPUTE route (PDF p.8 "simple support route for disputed
--       records"): a CPO can flag their own reviewed/closed record back into the
--       manager Pending Review queue with reason 'disputed' + a short note.
--   (2) Department-level manager scoping (PDF p.9/p.16): org_members.department —
--       NULL = whole org (company admin / unscoped manager), set = the manager only
--       sees that department's attendance + incidents.
--
-- Additive + idempotent: relaxes one CHECK to allow one more value and adds two
-- nullable columns (no existing row violates anything). Safe to re-run.

-- (1a) 'disputed' review reason
ALTER TABLE public.cpo_shift_sessions
  DROP CONSTRAINT IF EXISTS cpo_shift_sessions_review_reason_check;

ALTER TABLE public.cpo_shift_sessions
  ADD CONSTRAINT cpo_shift_sessions_review_reason_check
  CHECK (review_reason IS NULL OR review_reason IN
    ('face_mismatch','out_of_radius','permission_denied','offline','camera_unavailable','disputed'));

-- (1b) the member's dispute note (manager-visible; distinct from admin_notes which
--      the MANAGER writes on review). Write-once by the disputing member.
ALTER TABLE public.cpo_shift_sessions
  ADD COLUMN IF NOT EXISTS dispute_note TEXT;

-- (2) department scope for delegated managers. NULL = all departments.
ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS department TEXT;

-- ── Down migration (uncomment to revert) ─────────────────────────────────────
-- ALTER TABLE public.cpo_shift_sessions DROP COLUMN IF EXISTS dispute_note;
-- ALTER TABLE public.org_members DROP COLUMN IF EXISTS department;
-- ALTER TABLE public.cpo_shift_sessions
--   DROP CONSTRAINT IF EXISTS cpo_shift_sessions_review_reason_check;
-- ALTER TABLE public.cpo_shift_sessions
--   ADD CONSTRAINT cpo_shift_sessions_review_reason_check
--   CHECK (review_reason IS NULL OR review_reason IN
--     ('face_mismatch','out_of_radius','permission_denied','offline','camera_unavailable'));
