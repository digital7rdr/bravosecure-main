-- Dept Chat v2 · Attendance — D6-e: add a distinct 'camera_unavailable' review reason.
--
-- A check-in where the camera/face step could not run (permission denied / no camera) was
-- previously recorded as 'face_mismatch' — indistinguishable from a genuine presence-check
-- failure. This adds a separate reason so the manager review queue can tell them apart.
--
-- Additive + idempotent: relaxes the CHECK to ALLOW one more value (no existing row violates
-- it). Safe to re-run. Behind the DEPT_CHAT_V2 feature flag like the rest of attendance v2.

ALTER TABLE public.cpo_shift_sessions
  DROP CONSTRAINT IF EXISTS cpo_shift_sessions_review_reason_check;

ALTER TABLE public.cpo_shift_sessions
  ADD CONSTRAINT cpo_shift_sessions_review_reason_check
  CHECK (review_reason IS NULL OR review_reason IN
    ('face_mismatch','out_of_radius','permission_denied','offline','camera_unavailable'));

-- ── Down migration (uncomment to revert) ─────────────────────────────────────
-- ALTER TABLE public.cpo_shift_sessions
--   DROP CONSTRAINT IF EXISTS cpo_shift_sessions_review_reason_check;
-- ALTER TABLE public.cpo_shift_sessions
--   ADD CONSTRAINT cpo_shift_sessions_review_reason_check
--   CHECK (review_reason IS NULL OR review_reason IN
--     ('face_mismatch','out_of_radius','permission_denied','offline'));
