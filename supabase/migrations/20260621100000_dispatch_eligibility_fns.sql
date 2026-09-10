-- Dispatch eligibility + capacity SQL functions (BUILD_RUNBOOK Step 6, LB10/LB11/D6).
-- One source of truth for the ranking query's vetting + capacity predicates so
-- they can be tightened without touching DispatchService. Additive + idempotent
-- (CREATE OR REPLACE). SECURITY INVOKER (default) — the auth-service connects as
-- a BYPASSRLS role, so these read the RLS-protected registries directly. Tables
-- are fully schema-qualified and search_path is pinned to pg_catalog (hardening).

-- has_free_cpo_capacity(agency, needed) — D6: an agency can hold several missions
-- at once, bounded only by free CPO seats. free = active roster CPOs
--   − distinct CPOs already on a non-terminal mission of this agency
--   − seats reserved by accepted-but-not-yet-crewed (CONFIRMED, no mission) bookings.
CREATE OR REPLACE FUNCTION public.has_free_cpo_capacity(p_agency uuid, p_needed int)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT (
    (SELECT count(*) FROM public.org_members om
       WHERE om.org_user_id = p_agency AND om.member_role = 'cpo' AND om.status = 'active')
    - (SELECT count(DISTINCT mc.agent_id)
         FROM public.mission_crew mc
         JOIN public.missions m       ON m.id = mc.mission_id
         JOIN public.lite_bookings b  ON b.id = m.booking_id
        WHERE b.assigned_provider_user_id = p_agency
          AND m.status NOT IN ('COMPLETED', 'ABORTED'))
    - COALESCE((SELECT sum(b.cpo_count)
         FROM public.lite_bookings b
        WHERE b.assigned_provider_user_id = p_agency
          AND b.status = 'CONFIRMED'
          AND NOT EXISTS (SELECT 1 FROM public.missions m WHERE m.booking_id = b.id)), 0)
  ) >= p_needed
$$;

-- is_eligible_for_dispatch(agency, region, requirements) — LB10/LB11: the agency
-- must hold a VERIFIED, non-expired licence AND insurance for the region, and if
-- the job needs armed protection it must have an armed-authorized CPO on roster
-- for the region. NO "skip in dev" branch — the whole feature is gated behind
-- AUTO_DISPATCH_ENABLED, so this stays strict; live dispatch needs seeded creds.
CREATE OR REPLACE FUNCTION public.is_eligible_for_dispatch(p_agency uuid, p_region text, p_requirements jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.compliance_credentials c
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
