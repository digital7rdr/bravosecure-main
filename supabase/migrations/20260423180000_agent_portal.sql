-- Bravo Secure — Agent Portal module
-- Backs the 9-screen Agent Portal flow (Security Company / Individual CPO / Transport).
-- Creates:
--   agents                  — primary partner record (one per user, one type)
--   agent_profiles          — company / contact / creds / availability / coverage JSONB
--   agent_kyc_checks        — KYC check states (Gov ID · PoA · SIA Licence · Police)
--   agent_documents         — compliance pack slots (REQ / OPT)
--   agent_review_pipeline   — 5-step admin review timeline
--   agent_deployment_checks — in-person activation checklist
--   agent_audit             — append-only status transition log
--
-- Status lifecycle:
--   DRAFT → PROFILE_COMPLETE → KYC_PENDING → DOCS_PENDING → SUBMITTED
--         → UNDER_REVIEW → APPROVED → ACTIVE
--         (or REJECTED from UNDER_REVIEW)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_type') THEN
    CREATE TYPE agent_type AS ENUM ('company', 'cpo', 'transport');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_status') THEN
    CREATE TYPE agent_status AS ENUM (
      'DRAFT',
      'PROFILE_COMPLETE',
      'KYC_PENDING',
      'DOCS_PENDING',
      'SUBMITTED',
      'UNDER_REVIEW',
      'APPROVED',
      'REJECTED',
      'ACTIVE'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_check_state') THEN
    CREATE TYPE agent_check_state AS ENUM ('queued', 'running', 'done', 'failed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_doc_state') THEN
    CREATE TYPE agent_doc_state AS ENUM ('upload', 'done', 'rejected');
  END IF;
END$$;

-- ─── agents (primary) ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agents (
  user_id        UUID PRIMARY KEY,
  type           agent_type   NOT NULL,
  status         agent_status NOT NULL DEFAULT 'DRAFT',
  tier           INTEGER      NOT NULL DEFAULT 2,        -- 1=Lead, 2=Standard
  call_sign      TEXT,                                    -- e.g. 'AGT-44'
  display_name   TEXT,
  rate_aed_per_hour DECIMAL(10, 2),
  rating         DECIMAL(3, 2),                           -- 0.00 – 5.00
  jobs_total     INTEGER NOT NULL DEFAULT 0,
  duty_hours_mtd INTEGER NOT NULL DEFAULT 0,              -- minutes are overkill; hour precision is fine
  on_duty        BOOLEAN NOT NULL DEFAULT FALSE,
  submitted_at   TIMESTAMPTZ,
  approved_at    TIMESTAMPTZ,
  activated_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agents_status_idx ON agents(status);

-- ─── agent_profiles ─────────────────────────────────────────────────────────
-- One JSONB per section to keep the wizard flexible.

-- Why: init_phase1 created a DIFFERENT agent_profiles (psira_number /
-- license_country / rating_avg / jobs_completed / availability_status), so the
-- CREATE TABLE IF NOT EXISTS below silently did nothing on a clean apply and
-- the portal's JSONB shape never materialised. The guard keys on a
-- Phase-1-ONLY column, so it can never match the portal table and is a no-op
-- on any database that already has the correct shape.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='agent_profiles'
      AND column_name='psira_number'
  ) THEN
    DROP TABLE IF EXISTS public.agent_profiles CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS agent_profiles (
  user_id      UUID PRIMARY KEY REFERENCES agents(user_id) ON DELETE CASCADE,
  company      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- legal name, reg number, regulator, established
  contact      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- primary contact, email, phone
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ['first_aid','firearms','defensive_driving_l2']
  coverage     JSONB NOT NULL DEFAULT '{"countries":[],"services":[]}'::jsonb,
  availability JSONB NOT NULL DEFAULT '{"mode":"full","loadout":[]}'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── agent_kyc_checks ───────────────────────────────────────────────────────
-- 4 fixed slots per agent: gov_id · proof_address · sia_licence · police.

CREATE TABLE IF NOT EXISTS agent_kyc_checks (
  user_id    UUID NOT NULL REFERENCES agents(user_id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                -- 'gov_id' | 'proof_address' | 'sia_licence' | 'police'
  state      agent_check_state NOT NULL DEFAULT 'queued',
  subject    TEXT,                          -- 'Passport GB-231122', 'Utility bill', ...
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, kind)
);

-- ─── agent_documents ────────────────────────────────────────────────────────

-- Why: same collision as agent_profiles above. init_phase1 created an
-- agent_documents keyed on doc_type / r2_key / mime_type; this slot-based
-- table is a different model entirely, and IF NOT EXISTS silently skipped it
-- on a clean apply. Guard keys on the Phase-1-ONLY column `doc_type`.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='agent_documents'
      AND column_name='doc_type'
  ) THEN
    DROP TABLE IF EXISTS public.agent_documents CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS agent_documents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES agents(user_id) ON DELETE CASCADE,
  slot           TEXT NOT NULL,              -- 'sia' | 'passport' | 'insurance' | 'dbs' | 'firstaid' | 'cv'
  required       BOOLEAN NOT NULL DEFAULT TRUE,
  title          TEXT NOT NULL,
  state          agent_doc_state NOT NULL DEFAULT 'upload',
  file_url       TEXT,
  file_hash_sha256 TEXT,
  uploaded_at    TIMESTAMPTZ,
  reviewed_at    TIMESTAMPTZ,
  reviewer_id    UUID,
  UNIQUE (user_id, slot)
);

-- ─── agent_review_pipeline ─────────────────────────────────────────────────
-- 5 steps: submit · docs · kyc · ops · partner.

CREATE TABLE IF NOT EXISTS agent_review_pipeline (
  user_id     UUID NOT NULL REFERENCES agents(user_id) ON DELETE CASCADE,
  step        TEXT NOT NULL,                -- 'submit'|'docs'|'kyc'|'ops'|'partner'
  state       TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'in_progress'|'done'|'rejected'
  settled_at  TIMESTAMPTZ,
  reviewer_id UUID,
  notes       TEXT,
  PRIMARY KEY (user_id, step)
);

-- ─── agent_deployment_checks ───────────────────────────────────────────────
-- In-person activation checklist signed off by Ops supervisor.

CREATE TABLE IF NOT EXISTS agent_deployment_checks (
  user_id     UUID NOT NULL REFERENCES agents(user_id) ON DELETE CASCADE,
  check_key   TEXT NOT NULL,                -- 'dress'|'vehicle'|'equip'|'briefing'
  state       TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'passed'|'failed'
  signed_by   UUID,                          -- Ops supervisor user_id
  signed_at   TIMESTAMPTZ,
  notes       TEXT,
  PRIMARY KEY (user_id, check_key)
);

-- ─── agent_audit ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_audit (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES agents(user_id) ON DELETE CASCADE,
  from_status agent_status,
  to_status   agent_status NOT NULL,
  actor_id    UUID,
  actor_role  TEXT NOT NULL,     -- 'AGENT' | 'ADMIN' | 'SYSTEM' | 'OPS'
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_audit_user_idx ON agent_audit(user_id, created_at DESC);

-- ─── triggers ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION touch_agents_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agents_touch_updated_at ON agents;
CREATE TRIGGER agents_touch_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION touch_agents_updated_at();

DROP TRIGGER IF EXISTS agent_profiles_touch_updated_at ON agent_profiles;
CREATE TRIGGER agent_profiles_touch_updated_at
  BEFORE UPDATE ON agent_profiles
  FOR EACH ROW EXECUTE FUNCTION touch_agents_updated_at();
