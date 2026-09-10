-- Scope v2 — close the RLS gap on the five tables Phases 3/5/6 added.
--
-- FOUND BY THE SUPABASE ADVISOR AFTER APPLYING THE MIGRATIONS TO STAGING, not
-- by review: `rls_disabled_in_public`, level ERROR, facing EXTERNAL, on all
-- five. Supabase exposes every public table through PostgREST to the anon and
-- authenticated roles unless RLS is on, so these shipped externally readable —
-- including `enterprise_referral_links` (join codes) and
-- `attendance_corrections` (the HR audit trail).
--
-- This is the "missing RLS on the new tables" item carried forward from the
-- Phase 5 review. It was recorded as non-blocking there because the review
-- could not see the deployed state; the advisor could.
--
-- ── WHY ENABLE WITH NO POLICIES ──────────────────────────────────────────────
--
-- That is the established pattern in this schema, not an oversight.
-- 20260603100000_enable_rls_deny_by_default did exactly this, and EVERY table
-- auth-service already uses is in that state — RLS on, zero policies:
-- users, agents, org_members, department_channels, department_channel_members,
-- cpo_shifts, cpo_shift_sessions. Verified against those tables before writing
-- this rather than assumed, precisely because enabling RLS on a table the
-- service reads with a non-bypassing role would break every read.
--
-- PostgREST therefore denies everything; auth-service connects with a role that
-- bypasses RLS and is unaffected.
--
-- ── WHY NOT WRITE POLICIES ───────────────────────────────────────────────────
--
-- Policies here would be a SECOND, weaker copy of tenancy rules the service
-- already enforces — OrgManagerGuard's four arms, the membership joins,
-- BRANCH_SCOPE_PREDICATE. Two expressions of one rule is the exact shape this
-- scope has been paying for throughout (six copies of the active-enterprise
-- formula; the branch rule written twice). One rule, one place.

ALTER TABLE public.org_workspaces            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cpo_roster_months         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_corrections    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enterprise_join_requests  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enterprise_referral_links ENABLE ROW LEVEL SECURITY;

-- ── Down migration (uncomment to revert) ─────────────────────────────────────
-- Reverting re-exposes these tables to PostgREST. Do not, without replacing the
-- protection with something equivalent.
-- ALTER TABLE public.org_workspaces            DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.cpo_roster_months         DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.attendance_corrections    DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.enterprise_join_requests  DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.enterprise_referral_links DISABLE ROW LEVEL SECURITY;
