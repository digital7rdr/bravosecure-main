-- Family spending-quota system — credit requests + quota audit trail.
--
-- The quota mechanics themselves already exist and are NOT re-invented here:
--   · Root Available Credit  = wallet_balances.bravo_credits (INTEGER credits)
--   · Member Allocated Quota = family_members.spend_limit_credits
--   · Member Used Amount     = family_members.spent_credits
--   · The atomic spend + both-limit gate lives in BookingService.payWithCredits
--     and the dispatch escrow accept, under FOR UPDATE on the member row and
--     then the wallet row (MON-4). Refund reversal is pinned to the CHARGE-TIME
--     membership row via wallet_transactions.metadata->>'family_row_id'.
--
-- What was missing, and what this migration adds:
--   1. family_credit_requests — the member "ask Root for more credit" lifecycle
--      (PENDING / APPROVED / REJECTED / CANCELLED / EXPIRED), incl. partial
--      approval.
--   2. family_quota_audit — every quota change, with previous/new values. Quota
--      used to be overwritten in place with no history, so an approval or a
--      manual raise left nothing to audit.
--   3. family_members.quota_notified_pct — the threshold-CROSSING marker that
--      keeps 80/90/100% warnings from re-firing on every transaction.

-- ── 1. Credit requests ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.family_credit_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The membership row the request is about. Requests follow the ROW, not the
  -- user: a revoke → re-invite mints a new row, and an old row's request must
  -- never top up the new one.
  family_row_id     UUID NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  holder_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  member_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  requested_credits INTEGER NOT NULL CHECK (requested_credits > 0),
  -- Set only on APPROVED. May be LESS than requested (partial approval) but
  -- never more, and never <= 0 — enforced in the service and by this CHECK.
  approved_credits  INTEGER CHECK (approved_credits IS NULL OR approved_credits > 0),
  reason            TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','cancelled','expired')),
  decided_by        UUID REFERENCES public.users(id),
  decided_at        TIMESTAMPTZ,
  decision_reason   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Lazily enforced on read/decide — no cron. A forgotten PENDING request would
  -- otherwise block the member from ever asking again (see the unique index).
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
);

-- Spec §12 — at most ONE open request per membership row. This is the
-- request-spam gate, and it is an INDEX rather than a service-side count so two
-- simultaneous taps cannot both pass a check-then-insert.
CREATE UNIQUE INDEX IF NOT EXISTS family_credit_requests_one_pending
  ON public.family_credit_requests(family_row_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS family_credit_requests_holder_idx
  ON public.family_credit_requests(holder_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS family_credit_requests_member_idx
  ON public.family_credit_requests(member_id, created_at DESC);

-- ── 2. Quota audit trail ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.family_quota_audit (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_row_id  UUID NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  holder_id      UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  member_id      UUID REFERENCES public.users(id) ON DELETE SET NULL,
  -- Who performed it. Always derived server-side from the JWT, never from a body.
  actor_id       UUID REFERENCES public.users(id),
  action         TEXT NOT NULL
                   CHECK (action IN ('QUOTA_CREATED','QUOTA_INCREASED','QUOTA_DECREASED',
                                     'QUOTA_CLEARED','CREDIT_APPROVED')),
  -- NULL means "unlimited" on either side — the column is nullable on purpose,
  -- it is not a missing value.
  previous_limit INTEGER,
  new_limit      INTEGER,
  -- Signed change in credits; NULL when either side is unlimited (no delta is
  -- meaningful across an unlimited boundary).
  delta_credits  INTEGER,
  -- The member's used amount at decision time — this is what made a decrease
  -- legal or illegal, so it belongs in the record.
  spent_at_time  INTEGER NOT NULL DEFAULT 0,
  request_id     UUID REFERENCES public.family_credit_requests(id) ON DELETE SET NULL,
  reason         TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS family_quota_audit_row_idx
  ON public.family_quota_audit(family_row_id, created_at DESC);
CREATE INDEX IF NOT EXISTS family_quota_audit_holder_idx
  ON public.family_quota_audit(holder_id, created_at DESC);

-- ── 3. Threshold-crossing marker ───────────────────────────────────────────

-- Highest usage band already announced for the CURRENT quota: 0 / 80 / 90 / 100.
-- Reset to 0 whenever the quota changes or a refund drops usage back under a
-- band, so a member who is topped up can be warned again on the new quota.
ALTER TABLE public.family_members
  ADD COLUMN IF NOT EXISTS quota_notified_pct SMALLINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.family_members.quota_notified_pct IS
  'Highest quota-usage band (0/80/90/100) already notified for the current limit. Crossing-based so warnings do not re-fire per transaction.';

-- ── Deny-by-default RLS ────────────────────────────────────────────────────
-- House rule: the anon key ships in the APK, so a public table without RLS is
-- readable through PostgREST. auth-service reaches these through the direct
-- Postgres pool, which RLS does not constrain.
ALTER TABLE public.family_credit_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_credit_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.family_credit_requests FROM anon, authenticated;

ALTER TABLE public.family_quota_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_quota_audit FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.family_quota_audit FROM anon, authenticated;

COMMENT ON TABLE public.family_credit_requests IS
  'Member requests for additional spending quota. One PENDING row per membership at a time (unique index); partial approval supported via approved_credits.';
COMMENT ON TABLE public.family_quota_audit IS
  'Append-only history of every family spending-quota change. Not editable by normal users (no anon/authenticated grants).';
