-- Service-provider org → managed-CPO hierarchy, org-as-applicant/payee job
-- applications, and provider-managed attendance.
--
-- Context: today every CPO self-registers as its own `agents` row (type='cpo')
-- with no link to the `company` agent that employs it; `job_applications.agent_id`
-- is the individual applicant and the payout lands on that individual. This
-- migration makes a service provider a first-class tenant that owns CPO
-- sub-accounts, applies to jobs as the org (org = payee), and runs attendance.
--
-- One tenant key: org = the company agent's users.id (the same id
-- department_channels.org_id already references). No separate provider_orgs table.
--
-- ALL changes are additive + idempotent. Existing self-registered CPOs are
-- backfilled so they remain their own org and their own officer — zero behavior
-- change to the legacy flow. A matching down-migration is at the foot of this file
-- (commented; uncomment to revert).
--
-- Phase 0 of the rollout: schema + backfill only. No application code reads the
-- new columns yet.

-- ── 1. org_members — the org → CPO membership edge ───────────────────────────
CREATE TABLE IF NOT EXISTS public.org_members (
  -- The company agent that owns this membership (a users.id).
  org_user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- The managed CPO (a real users.id with its own login + mobile app).
  member_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- 'cpo' = deployable officer; 'manager' = can manage the org's CPOs.
  member_role    TEXT NOT NULL DEFAULT 'cpo' CHECK (member_role IN ('cpo','manager')),
  call_sign      TEXT,
  status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('invited','active','suspended','removed')),
  invited_by     UUID REFERENCES public.users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_user_id, member_user_id)
);

-- Reverse lookup: "which org owns this CPO".
CREATE INDEX IF NOT EXISTS org_members_member_idx
  ON public.org_members(member_user_id);
-- Active-roster scans for a given org.
CREATE INDEX IF NOT EXISTS org_members_org_active_idx
  ON public.org_members(org_user_id) WHERE status = 'active';

-- ── 2. agents.managed_by_org_id — distinguishes managed vs self-registered ───
-- NULL = legacy self-registered CPO (unchanged onboarding). Set = the org that
-- created and governs this CPO sub-account.
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS managed_by_org_id UUID REFERENCES public.users(id);

CREATE INDEX IF NOT EXISTS agents_managed_by_idx
  ON public.agents(managed_by_org_id) WHERE managed_by_org_id IS NOT NULL;

-- ── 3. job_applications — org is applicant + payee, CPO is deployed officer ───
-- agent_id is left intact (the UNIQUE(job_id, agent_id) still means "one
-- application per applicant per job"). For org applications agent_id = org id.
ALTER TABLE public.job_applications
  ADD COLUMN IF NOT EXISTS applicant_org_id     UUID REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS assigned_cpo_user_id UUID REFERENCES public.users(id);

-- Backfill: a legacy self-registered CPO is simultaneously its own org and its
-- own deployed officer. This keeps every historical row valid under the new
-- model and makes payout resolution fall back to the same wallet as before.
UPDATE public.job_applications
   SET applicant_org_id     = COALESCE(applicant_org_id, agent_id),
       assigned_cpo_user_id = COALESCE(assigned_cpo_user_id, agent_id)
 WHERE applicant_org_id IS NULL OR assigned_cpo_user_id IS NULL;

CREATE INDEX IF NOT EXISTS job_applications_org_idx
  ON public.job_applications(applicant_org_id);

-- ── 4. mission_payouts.payee_user_id — who actually got credited ─────────────
-- agent_user_id stays the deployed officer (attribution); payee_user_id is the
-- wallet that received the credit (the org for managed CPOs, else the officer).
ALTER TABLE public.mission_payouts
  ADD COLUMN IF NOT EXISTS payee_user_id UUID REFERENCES public.users(id);

-- Backfill only where agent_user_id is a real user. Some historical rows from
-- the agent-self-complete path wrote a cpo_pool.id (roster UUID, NOT a users.id)
-- into agent_user_id — the latent bug Phase 2 fixes. Those rows are left with
-- payee_user_id NULL (they reference no real wallet and are read-only history);
-- the FK to users(id) would otherwise reject them. The Phase 2 payout resolver
-- treats NULL payee as "fall back to officer", which is harmless for past rows.
UPDATE public.mission_payouts mp
   SET payee_user_id = mp.agent_user_id
 WHERE mp.payee_user_id IS NULL
   AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = mp.agent_user_id);

CREATE INDEX IF NOT EXISTS mission_payouts_payee_idx
  ON public.mission_payouts(payee_user_id);

-- ── 5. cpo_shift_sessions — provider-managed attendance ──────────────────────
-- Geotagged clock-in/out the CPO performs, visible + editable by the org.
-- Distinct from mission_waypoints (per-mission route marks) and
-- mission_telemetry_last (live GPS) — this is duty attendance, not operations.
CREATE TABLE IF NOT EXISTS public.cpo_shift_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  cpo_user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','closed','edited')),
  clock_in_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  clock_in_lat        DOUBLE PRECISION,
  clock_in_lng        DOUBLE PRECISION,
  clock_in_accuracy_m DOUBLE PRECISION,
  clock_out_at        TIMESTAMPTZ,
  clock_out_lat       DOUBLE PRECISION,
  clock_out_lng       DOUBLE PRECISION,
  -- Provider edit audit (status flips to 'edited' when the org adjusts a row).
  edited_by           UUID REFERENCES public.users(id),
  edited_at           TIMESTAMPTZ,
  edit_reason         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A CPO may hold at most one open shift at a time.
CREATE UNIQUE INDEX IF NOT EXISTS cpo_shift_sessions_open_unique
  ON public.cpo_shift_sessions(cpo_user_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS cpo_shift_sessions_org_idx
  ON public.cpo_shift_sessions(org_user_id, clock_in_at DESC);
CREATE INDEX IF NOT EXISTS cpo_shift_sessions_cpo_idx
  ON public.cpo_shift_sessions(cpo_user_id, clock_in_at DESC);

-- ── 6. RLS: deny-by-default for anon/authenticated, backend bypasses ─────────
-- Matches 20260603100000_enable_rls_deny_by_default.sql. The NestJS auth-service
-- connects as a rolbypassrls role, so backend queries are unaffected; this only
-- denies the EXPO_PUBLIC anon key direct table access. No policies = deny-all.
ALTER TABLE public.org_members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_members        FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.cpo_shift_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cpo_shift_sessions FORCE  ROW LEVEL SECURITY;

-- ── Down migration (uncomment to revert) ─────────────────────────────────────
-- DROP TABLE IF EXISTS public.cpo_shift_sessions;
-- DROP TABLE IF EXISTS public.org_members;
-- ALTER TABLE public.mission_payouts  DROP COLUMN IF EXISTS payee_user_id;
-- ALTER TABLE public.job_applications DROP COLUMN IF EXISTS assigned_cpo_user_id;
-- ALTER TABLE public.job_applications DROP COLUMN IF EXISTS applicant_org_id;
-- ALTER TABLE public.agents           DROP COLUMN IF EXISTS managed_by_org_id;
