-- Dept Chat v2 · Attendance verification data model (PDF p.3,5,6,8,16).
--
-- Adds the structures attendance verification needs on top of the existing
-- provider-managed clock-in/out (20260610000000):
--   * cpo_shifts            — an expected duty window + geofence centre + radius
--   * cpo_shift_assignments — which CPOs are rostered to a shift
--   * new columns on cpo_shift_sessions — link to a shift, the face-confirmation
--     RESULT (not biometrics), the radius result, the derived attendance status,
--     and the manager review outcome.
--
-- 🛑 SECURITY (System Architecture Documentation, CLAUDE.md): the face step is
-- presence/liveness confirmation only. This schema stores the RESULT + non-
-- biometric audit metadata ONLY (face_verified boolean + face_meta jsonb holding
-- a model/version tag + confidence bucket). There is deliberately NO column for
-- raw frames or face descriptors — do not add one.
--
-- ALL changes are additive + idempotent. Legacy rows keep attendance_status /
-- face_verified NULL, so the legacy clock-in path stays valid and unchanged.
-- review_status defaults to 'none' so old rows are not dragged into the queue.
-- A matching down-migration is at the foot of this file (commented; uncomment
-- to revert). Behind the DEPT_CHAT_V2 feature flag until rollout (Step 17).

-- ── 1. cpo_shifts — expected duty window + geofence centre + radius (per org) ──
CREATE TABLE IF NOT EXISTS public.cpo_shifts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_user_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  department        TEXT,                        -- free-text label, e.g. 'Operations'
  site_label        TEXT,                        -- e.g. 'Main Office'
  site_lat          DOUBLE PRECISION,            -- geofence centre
  site_lng          DOUBLE PRECISION,
  approved_radius_m INT NOT NULL DEFAULT 150,    -- radius-check tolerance (metres)
  start_at          TIMESTAMPTZ NOT NULL,        -- expected duty window
  end_at            TIMESTAMPTZ NOT NULL,
  created_by        UUID NOT NULL REFERENCES public.users(id),
  archived_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Active-shift scans for an org (today's roster), newest first.
CREATE INDEX IF NOT EXISTS cpo_shifts_org_idx
  ON public.cpo_shifts(org_user_id, start_at DESC) WHERE archived_at IS NULL;

-- ── 2. cpo_shift_assignments — one row per assigned CPO ───────────────────────
CREATE TABLE IF NOT EXISTS public.cpo_shift_assignments (
  shift_id    UUID NOT NULL REFERENCES public.cpo_shifts(id) ON DELETE CASCADE,
  cpo_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (shift_id, cpo_user_id)
);
-- Reverse lookup: "which shift(s) is this CPO assigned to" (today's-shift join).
CREATE INDEX IF NOT EXISTS cpo_shift_assign_cpo_idx
  ON public.cpo_shift_assignments(cpo_user_id);

-- ── 3. extend cpo_shift_sessions — verification result + status + review ──────
-- The original captured geotag/time (20260610000000) is immutable (PDF p.7,9);
-- these columns are purely additive context written once at check-in (the
-- verification result + status) plus the manager review outcome.
ALTER TABLE public.cpo_shift_sessions
  ADD COLUMN IF NOT EXISTS shift_id          UUID REFERENCES public.cpo_shifts(id),
  ADD COLUMN IF NOT EXISTS face_verified     BOOLEAN,            -- presence-check RESULT only
  ADD COLUMN IF NOT EXISTS face_meta         JSONB,              -- audit metadata, NO biometric bytes
  ADD COLUMN IF NOT EXISTS within_radius     BOOLEAN,
  ADD COLUMN IF NOT EXISTS distance_m        INT,                -- coarse, for review context
  ADD COLUMN IF NOT EXISTS attendance_status TEXT
    CHECK (attendance_status IS NULL OR attendance_status IN
      ('present','late','absent','early_checkout','leave','sick_leave','off_duty','pending_review')),
  ADD COLUMN IF NOT EXISTS review_status     TEXT NOT NULL DEFAULT 'none'
    CHECK (review_status IN ('none','pending','approved','rejected')),
  ADD COLUMN IF NOT EXISTS review_reason     TEXT
    CHECK (review_reason IS NULL OR review_reason IN
      ('face_mismatch','out_of_radius','permission_denied','offline')),
  ADD COLUMN IF NOT EXISTS reviewed_by       UUID REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_notes       TEXT;

-- Pending-review queue scan for an org (partial — only flagged rows).
CREATE INDEX IF NOT EXISTS cpo_shift_sessions_review_idx
  ON public.cpo_shift_sessions(org_user_id) WHERE review_status = 'pending';

-- ── 4. RLS: deny-by-default for anon/authenticated, backend bypasses ──────────
-- Matches 20260603100000_enable_rls_deny_by_default.sql + 20260610000000. The
-- NestJS auth-service connects as a rolbypassrls role, so backend queries are
-- unaffected; this only denies EXPO_PUBLIC anon-key direct table access.
-- (cpo_shift_sessions already has RLS from 20260610000000.)
ALTER TABLE public.cpo_shifts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cpo_shifts            FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.cpo_shift_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cpo_shift_assignments FORCE  ROW LEVEL SECURITY;

-- ── Down migration (uncomment to revert) ─────────────────────────────────────
-- ALTER TABLE public.cpo_shift_sessions
--   DROP COLUMN IF EXISTS shift_id,
--   DROP COLUMN IF EXISTS face_verified,
--   DROP COLUMN IF EXISTS face_meta,
--   DROP COLUMN IF EXISTS within_radius,
--   DROP COLUMN IF EXISTS distance_m,
--   DROP COLUMN IF EXISTS attendance_status,
--   DROP COLUMN IF EXISTS review_status,
--   DROP COLUMN IF EXISTS review_reason,
--   DROP COLUMN IF EXISTS reviewed_by,
--   DROP COLUMN IF EXISTS reviewed_at,
--   DROP COLUMN IF EXISTS admin_notes;
-- DROP TABLE IF EXISTS public.cpo_shift_assignments;
-- DROP TABLE IF EXISTS public.cpo_shifts;
