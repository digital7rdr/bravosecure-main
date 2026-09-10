-- Privacy / retention / consent (BUILD_RUNBOOK Step 22).
-- Adds the lawful-basis consent surface for auto-dispatch (the client's precise
-- pickup + live location is shared with a third-party agency, so we record an
-- explicit, versioned location + terms consent), the agency DPA acceptance the
-- dispatch-eligibility gate now requires, and a managed-CPO account-consent stamp.
-- Additive + idempotent. No data is destroyed; existing rows get NULL consent
-- columns (legacy ops-mediated bookings keep their existing implicit flow).

-- ── Client booking consent (lawful basis for sharing precise location) ──────────
-- terms_accepted_at / terms_accepted_version already exist (Step 15 compliance
-- migration); only the location-consent pair is new.
ALTER TABLE public.lite_bookings
  ADD COLUMN IF NOT EXISTS location_consent_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS location_consent_version TEXT;

-- ── Agency data-processing agreement (DPA) acceptance ───────────────────────────
-- An agency may not receive a client's location through an offer until it has
-- accepted the current DPA. The dispatch-eligibility function below now gates on
-- dpa_accepted_at being non-null.
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS dpa_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dpa_version     TEXT;

-- ── Managed-CPO account consent ─────────────────────────────────────────────────
-- A CPO onboarded by an agency consents to being rostered + located while on duty.
ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS account_consent_at TIMESTAMPTZ;

-- ── Dispatch-eligibility gate now requires a current DPA ────────────────────────
-- CREATE OR REPLACE — adds the DPA predicate to the existing licence/insurance/
-- armed gates (Step 6). NO "skip in dev" branch; the whole feature is dark behind
-- AUTO_DISPATCH_ENABLED. An agency with no accepted DPA is simply not dispatchable.
CREATE OR REPLACE FUNCTION public.is_eligible_for_dispatch(p_agency uuid, p_region text, p_requirements jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.agents a
              WHERE a.user_id = p_agency AND a.dpa_accepted_at IS NOT NULL)
    AND EXISTS (SELECT 1 FROM public.compliance_credentials c
              WHERE c.subject_user_id = p_agency AND c.subject_kind = 'agency'
                AND c.kind = 'licence' AND c.region_code = p_region
                AND c.verified AND c.expires_at > NOW())
    AND EXISTS (SELECT 1 FROM public.compliance_credentials c
                  WHERE c.subject_user_id = p_agency AND c.subject_kind = 'agency'
                    AND c.kind = 'insurance' AND c.region_code = p_region
                    AND c.verified AND c.expires_at > NOW())
    AND (
      NOT COALESCE((p_requirements ->> 'armed')::boolean, false)
      OR EXISTS (SELECT 1 FROM public.armed_authorizations aa
                   JOIN public.org_members om ON om.member_user_id = aa.cpo_user_id
                  WHERE om.org_user_id = p_agency AND om.member_role = 'cpo' AND om.status = 'active'
                    AND aa.region_code = p_region AND aa.authorized
                    AND (aa.expires_at IS NULL OR aa.expires_at > NOW()))
    )
$$;
