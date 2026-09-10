-- Enterprise Dept Channels scope v2 — Phase 3: the join → approve loop.
--
-- Frames M5 (Join Workspace / Referral Request), M11A (Approval Result) and
-- A11 (Approvals / Notifications). Page 10 rule 3: "Join referral creates an
-- Admin approval notification with referrer and requested team."
--
-- ── THE STRUCTURAL DECISION ─────────────────────────────────────────────────
--
-- M11A: "Pending means no Enterprise content or metadata is visible."
-- A11:  "Pending applicants receive no Department Channels, Attendance,
--        Incident or Vault access."
--
-- The tempting reading is "add a pending check to every module" — channels,
-- attendance, incidents, vault, search, notifications. That is an enumeration
-- trap: it is a list of the modules we thought of, and the next module added
-- silently leaks.
--
-- So a join request does NOT live in org_members and creates NO membership row.
-- Approval is the thing that creates it.
--
-- ⚠️ STATE THE REASON PRECISELY, because a weaker one licenses the shortcut
-- that breaks this. The reason is NOT "every reader filters on
-- status = 'active'" — that is FALSE. Twelve of the ~39 org_members reads in
-- auth-service do not filter on status at all (org-cpo.service.ts:91, 172, 293,
-- 516, 1076, 1154 and the roster JOINs at 484, 633, 767, 833; ops.service.ts:479),
-- correctly, because an admin roster has to show suspended and removed members.
--
-- The real reason is stronger: THERE IS NO ROW, so every read returns nothing
-- whether it filters or not — today's modules and tomorrow's alike.
--
-- If anyone later "simplifies" this by storing a pending applicant as
-- org_members(status='pending'), those twelve unfiltered reads become live
-- leaks: org-cpo.service.ts:293 (`status <> 'removed'`) would hand a pending
-- user the target org outright, and :91 / :1076 / :1154 would resolve a
-- member_role for them. The CHECK below makes that impossible to write rather
-- than merely discouraged.
--
-- Nor does the module guard save us: dept-chat-access.guard.ts Path 3 admits an
-- ACTIVE Enterprise-tier individual with NO org_members row at all (their org is
-- their own user id). It is a MODULE gate, not a TENANCY gate — and a pending
-- joiner is very often exactly that user, since they had to pick a plan to reach
-- M5. "Pending sees nothing of the TARGET org" therefore rests on org-id
-- resolution: with no membership row, their org resolves to themselves, so they
-- see their own empty workspace and never the Enterprise they applied to.

-- org_members.status had a CHECK when the table was created; re-assert it here
-- so a 'pending' value cannot be introduced by a later migration or a script.
-- Defence in depth for the paragraph above: the invariant should be impossible
-- to violate, not just documented.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_members_status_no_pending'
  ) THEN
    ALTER TABLE public.org_members
      ADD CONSTRAINT org_members_status_no_pending
        CHECK (status IN ('invited', 'active', 'suspended', 'removed'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.enterprise_referral_links (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored upper-case; the API upper-cases before lookup (same convention as
  -- provider_invite_codes).
  code           TEXT NOT NULL UNIQUE,
  org_user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- M5: "The link records the Enterprise, referrer and exact originating team."
  -- The team is a channel, so approval can place the member in the right branch
  -- and A11 can route the approval to the Admin who owns that branch.
  referrer_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  team_channel_id  UUID REFERENCES public.department_channels(id) ON DELETE SET NULL,
  -- MULTI-use, unlike provider_invite_codes: M5 describes a link a member
  -- SHARES (e.g. printed on an induction sheet), so several applicants may
  -- arrive through one link. Each still needs its own approval.
  expires_at     TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  created_by     UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The only rows a redeem can ever match.
CREATE INDEX IF NOT EXISTS enterprise_referral_links_open_idx
  ON public.enterprise_referral_links(code)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.enterprise_join_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  applicant_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  link_id        UUID REFERENCES public.enterprise_referral_links(id) ON DELETE SET NULL,
  -- A11: "Show applicant name, mobile, email, referrer, Enterprise and exact
  -- team requested." Captured at SUBMIT time so the admin sees what the
  -- applicant actually entered, even if their profile changes later.
  applicant_name  TEXT,
  applicant_phone TEXT,
  applicant_email TEXT,
  referrer_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  team_channel_id  UUID REFERENCES public.department_channels(id) ON DELETE SET NULL,
  message        TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'declined')),
  -- Page 10 rule 4 — the decision is auditable: who, when.
  decided_by     UUID REFERENCES public.users(id) ON DELETE SET NULL,
  decided_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- IDEMPOTENCY (page 10 rule 3: "Duplicate submissions are prevented with
-- operation IDs/idempotency"). At most ONE open request per applicant per
-- Enterprise — a double-tap on Submit, or a retry after a dropped response,
-- cannot produce two pending rows for one admin to reconcile. Partial, so a
-- declined applicant can legitimately re-apply later.
CREATE UNIQUE INDEX IF NOT EXISTS enterprise_join_requests_one_open
  ON public.enterprise_join_requests(org_user_id, applicant_user_id)
  WHERE status = 'pending';

-- The admin inbox query.
CREATE INDEX IF NOT EXISTS enterprise_join_requests_pending_idx
  ON public.enterprise_join_requests(org_user_id, created_at DESC)
  WHERE status = 'pending';

-- A11: "If two Admins act, the first decision wins and the second receives a
-- conflict state." That is enforced by a CONDITIONAL UPDATE in the service
-- (`... WHERE status = 'pending'`, then check whether a row came back) rather
-- than a read-then-write, which would let both admins read 'pending' and both
-- write. The same technique provider_invite_codes uses to make a code
-- single-use under a race.

-- ── Down migration (uncomment to revert) ─────────────────────────────────────
-- DROP INDEX IF EXISTS enterprise_join_requests_pending_idx;
-- DROP INDEX IF EXISTS enterprise_join_requests_one_open;
-- DROP TABLE IF EXISTS public.enterprise_join_requests;
-- DROP INDEX IF EXISTS enterprise_referral_links_open_idx;
-- DROP TABLE IF EXISTS public.enterprise_referral_links;
