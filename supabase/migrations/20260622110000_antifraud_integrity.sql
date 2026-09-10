-- Anti-fraud / marketplace integrity (BUILD_RUNBOOK Step 23).
-- Adds the columns the dispatch reject-accounting + location-plausibility gates
-- need, plus a hard one-active-agency-per-CPO constraint. Additive + idempotent.
-- (agents.offers_received / offers_accepted / reliability_breaches + region_code +
-- last_lat/last_lng/last_location_at already exist from Steps 2/3 — NOT re-added.)

-- ── Reject-rate / cooldown accounting ───────────────────────────────────────────
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS offers_rejected        INTEGER     NOT NULL DEFAULT 0,
  -- acceptance_rate is a 0..1 ratio (accepted / (accepted+rejected)); NULL until the
  -- agency has responded to at least one offer.
  ADD COLUMN IF NOT EXISTS acceptance_rate        NUMERIC(4,3),
  -- A chronic rejecter is benched until cooldown_until passes (ranking gates on it).
  ADD COLUMN IF NOT EXISTS cooldown_until         TIMESTAMPTZ;

-- ── Location-plausibility / mock-detection ──────────────────────────────────────
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS last_location_accuracy_m DOUBLE PRECISION,
  -- TRUE when the last fix was reported mocked OR failed the impossible-speed check.
  -- The dispatch ranking excludes mocked agents so a spoofed position can't win an offer.
  ADD COLUMN IF NOT EXISTS last_location_mocked     BOOLEAN     NOT NULL DEFAULT FALSE;

-- ── One active agency per CPO ───────────────────────────────────────────────────
-- users.email is already `citext UNIQUE`, so a managed CPO created by two agencies
-- with the same email is already blocked at the users level (createManagedCpo now
-- catches the 23505). This index is defense-in-depth at the membership layer: a
-- single member_user_id may have at most ONE 'active' org_members edge, so a CPO
-- cannot be simultaneously active at two agencies via any other path.
CREATE UNIQUE INDEX IF NOT EXISTS org_members_one_active_agency
  ON public.org_members (member_user_id)
  WHERE status = 'active';
