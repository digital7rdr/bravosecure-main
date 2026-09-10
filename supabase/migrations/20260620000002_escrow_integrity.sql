-- Money + compliance schema for auto-dispatch (BUILD_RUNBOOK Step 3).
-- Additive + idempotent. Provides the "charged != paid" escrow model, the
-- dispute record, the licence/insurance + armed-authorization registries a
-- regulated multi-region service needs to gate dispatch, and the per-request
-- requirements the client paid for. NO crypto / auth / E2E primitives touched —
-- wallet/ledger only. Depends on 20260620000000_auto_dispatch.sql (dispatch_offers).

-- ── Escrow hold status enum ────────────────────────────────────────────────
-- Money state machine (Part V §37): HELD -> {REFUNDED|PARTIAL|PENDING_RELEASE};
-- PENDING_RELEASE -> {RELEASED|DISPUTED}; DISPUTED -> {RELEASED|REFUNDED|PARTIAL}.
-- Fresh type (CREATE TYPE has no IF NOT EXISTS) — guard for re-runnability. A
-- freshly created enum CAN be used in the same transaction (unlike ADD VALUE),
-- so escrow_holds below may default to 'HELD' here.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'escrow_hold_status') THEN
    CREATE TYPE escrow_hold_status AS ENUM
      ('HELD', 'PENDING_RELEASE', 'RELEASED', 'REFUNDED', 'PARTIAL', 'DISPUTED');
  END IF;
END$$;

-- ── escrow_holds ───────────────────────────────────────────────────────────
-- "charged != paid": on accept the client's credits move INTO this hold (a
-- platform escrow account), NOT the agency wallet. Released only after a
-- proof-of-completion gate + the client dispute window. One hold per booking.
CREATE TABLE IF NOT EXISTS public.escrow_holds (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id           uuid NOT NULL UNIQUE REFERENCES public.lite_bookings(id),
  offer_id             uuid REFERENCES public.dispatch_offers(id),
  client_id            uuid NOT NULL,
  provider_user_id     uuid,                 -- agency payee, set at accept
  gross_credits        int  NOT NULL,        -- Bravo Credits held
  currency             text NOT NULL,        -- AED/SAR/BDT/GBP (fx_rate is stamped on the wallet txn, not here)
  status               escrow_hold_status NOT NULL DEFAULT 'HELD',
  held_at              timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz,          -- lead Finish + proof gate pass
  release_eligible_at  timestamptz,          -- completed_at + dispute window (trust-tiered)
  settled_at           timestamptz,
  to_provider_credits  int,
  to_client_credits    int,
  platform_fee_credits int,
  basis                text,                 -- full_release|pro_rata|refund|partial|clawback
  review_required      boolean NOT NULL DEFAULT false
);
-- release sweep (Step 11): holds whose dispute window has elapsed.
CREATE INDEX IF NOT EXISTS escrow_release_due
  ON public.escrow_holds (release_eligible_at) WHERE status = 'PENDING_RELEASE';

-- ── booking_disputes ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.booking_disputes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          uuid NOT NULL REFERENCES public.lite_bookings(id),
  raised_by           uuid NOT NULL,
  category            text NOT NULL,         -- not_performed|left_early|wrong_guard|conduct|billing
  reason              text,
  status              text NOT NULL DEFAULT 'open',  -- open|upheld|rejected|resolved
  to_client_credits   int,
  to_provider_credits int,
  decided_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  decided_at          timestamptz
);
-- At most one OPEN dispute per booking (Part V §41).
CREATE UNIQUE INDEX IF NOT EXISTS booking_disputes_one_open
  ON public.booking_disputes (booking_id) WHERE status = 'open';

-- ── Platform escrow + fee wallet accounts ──────────────────────────────────
-- Plain wallet_balances rows under fixed system ids (wallet_balances has NO FK
-- to users, so no pseudo-user rows are needed). These ids are mirrored as config
-- constants in apps/auth-service/src/config/configuration.ts (platformAccounts)
-- and MUST stay in sync (a unit test guards the drift). Distinct from the
-- messenger SYSTEM actor ...0001. ON CONFLICT keeps the seed idempotent.
INSERT INTO public.wallet_balances (user_id, bravo_credits, currency)
VALUES
  ('00000000-0000-0000-0000-0000000000e5', 0, 'AED'),  -- ESCROW_ACCOUNT_ID  (held funds)
  ('00000000-0000-0000-0000-0000000000fe', 0, 'AED')   -- PLATFORM_FEE_ACCOUNT_ID
ON CONFLICT (user_id) DO NOTHING;

-- ── Compliance: licence / insurance registry (per agency + CPO + region) ────
CREATE TABLE IF NOT EXISTS public.compliance_credentials (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id uuid NOT NULL,             -- agency (org_user_id) or CPO (member_user_id)
  subject_kind    text NOT NULL,             -- 'agency' | 'cpo'
  kind            text NOT NULL,             -- 'licence' | 'insurance'
  region_code     text NOT NULL,             -- AE/SA/BD/GB
  reference       text,                      -- credential ref / PII — never logged
  issued_at       timestamptz,
  expires_at      timestamptz NOT NULL,      -- the validity gate
  verified        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- eligibility-gate lookup: valid creds for a subject in a region (by expiry).
CREATE INDEX IF NOT EXISTS compliance_subject_idx
  ON public.compliance_credentials (subject_user_id, kind, region_code, expires_at);

-- ── Compliance: armed authorization (per CPO + region, permit + expiry) ─────
CREATE TABLE IF NOT EXISTS public.armed_authorizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cpo_user_id uuid NOT NULL,
  region_code text NOT NULL,
  permit_ref  text,                          -- permit number / PII — never logged
  authorized  boolean NOT NULL DEFAULT false,
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS armed_auth_cpo_idx
  ON public.armed_authorizations (cpo_user_id, region_code);

-- ── Deny-by-default RLS on all new tables (20260603100000) ─────────────────
-- ENABLE + FORCE with NO public policies => unreachable via PostgREST by anon /
-- authenticated, and RLS applies even to the table owner. Only a BYPASSRLS role
-- (service_role / postgres) reads/writes them — matches the base hardening
-- (20260603100000:49-50) and org_members / cpo_shift_sessions (20260610000000).
ALTER TABLE public.escrow_holds           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.escrow_holds           FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.booking_disputes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_disputes       FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.compliance_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_credentials FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.armed_authorizations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.armed_authorizations   FORCE  ROW LEVEL SECURITY;

-- ── lite_bookings: requirements the client paid for (LB11) ──────────────────
ALTER TABLE public.lite_bookings
  ADD COLUMN IF NOT EXISTS armed_required         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requirements           jsonb   NOT NULL DEFAULT '{}'::jsonb, -- {female, medical, …}
  ADD COLUMN IF NOT EXISTS dispute_window_seconds int;   -- per-booking dispute-window override (Part V §38)

-- ── agents: reliability / acceptance counters ──────────────────────────────
-- rating + jobs_total already exist (agent_portal migration) — do NOT re-add.
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS offers_received      int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS offers_accepted      int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reliability_breaches int NOT NULL DEFAULT 0;
