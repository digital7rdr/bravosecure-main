-- Bravo Secure Pro — request-and-approval custom protection plans.
--
-- A Pro APPLICATION is the client's requirements form (submitted from the
-- mobile app). The Bravo Control System reviews it and answers with a
-- versioned PROPOSAL (custom monthly Bravo Credits price, included services,
-- assigned team). The client accepts (or requests changes → a new proposal
-- version), then activates by paying the first month from their wallet.
--
-- DISTINCT from the M1A subscription tier system (users.subscription_tier /
-- subscription_prices): a Pro application NEVER writes those columns. The two
-- share only the user id and the wallet.
--
-- Status machine (pro-applications/state-machine.service.ts is the code
-- mirror): PENDING_PROPOSAL → PROPOSAL_CREATED → (REVISION_REQUESTED →
-- PROPOSAL_CREATED)* → ACCEPTED → ACTIVE, with REJECTED reachable from any
-- pre-ACCEPTED review state.

CREATE TABLE IF NOT EXISTS public.pro_applications (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL,
  status              text        NOT NULL DEFAULT 'PENDING_PROPOSAL'
    CHECK (status IN ('PENDING_PROPOSAL','PROPOSAL_CREATED','REVISION_REQUESTED','ACCEPTED','ACTIVE','REJECTED')),
  intended_use        text        NOT NULL
    CHECK (intended_use IN ('family_support','executive_protection','travel_protection','residential_support','event_support','custom')),
  intended_use_note   text,
  duration_months     smallint,
  duration_note       text,
  start_date          date        NOT NULL,
  coverage_area       text        NOT NULL,
  cpo_count           smallint    NOT NULL DEFAULT 0,
  driver_count        smallint    NOT NULL DEFAULT 0,
  support_staff_count smallint    NOT NULL DEFAULT 0,
  gender_preference   text        NOT NULL DEFAULT 'no_preference'
    CHECK (gender_preference IN ('no_preference','male','female','mixed')),
  services            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  service_other_note  text,
  notes               text,
  internal_notes      text,
  rejected_reason     text,
  submitted_at        timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  decided_at          timestamptz,
  decided_by          uuid,
  activated_at        timestamptz,
  current_period_end  timestamptz
);

-- One OPEN application per user (REJECTED closes the slot; a re-apply after a
-- rejection creates a fresh row). The service maps 23505 on this index to
-- `pro_application_exists`.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pro_applications_open
  ON public.pro_applications (user_id)
  WHERE status IN ('PENDING_PROPOSAL','PROPOSAL_CREATED','REVISION_REQUESTED','ACCEPTED','ACTIVE');

-- Ops board: WHERE status = $1 ORDER BY submitted_at DESC.
CREATE INDEX IF NOT EXISTS pro_applications_status_idx
  ON public.pro_applications (status, submitted_at DESC);

-- Client "my application": WHERE user_id = $1 ORDER BY submitted_at DESC.
CREATE INDEX IF NOT EXISTS pro_applications_user_idx
  ON public.pro_applications (user_id, submitted_at DESC);

-- Versioned proposals — REVISION_REQUESTED produces version n+1; the client
-- always sees the highest version.
CREATE TABLE IF NOT EXISTS public.pro_proposals (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid        NOT NULL REFERENCES public.pro_applications(id) ON DELETE CASCADE,
  version           integer     NOT NULL,
  proposal_number   text        NOT NULL,
  valid_until       timestamptz NOT NULL,
  coverage_start    date        NOT NULL,
  coverage_end      date        NOT NULL,
  monthly_credits   integer     NOT NULL CHECK (monthly_credits > 0),
  included_services jsonb       NOT NULL DEFAULT '[]'::jsonb,
  assigned_team     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  terms             text,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, version)
);

CREATE INDEX IF NOT EXISTS pro_proposals_app_idx
  ON public.pro_proposals (application_id, version DESC);

-- Append-only timeline — powers the client status screen and the ops audit
-- trail (same posture as agent_audit).
CREATE TABLE IF NOT EXISTS public.pro_application_events (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid        NOT NULL REFERENCES public.pro_applications(id) ON DELETE CASCADE,
  actor          text        NOT NULL CHECK (actor IN ('client','ops','system')),
  event          text        NOT NULL,
  message        text,
  meta           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pro_application_events_app_idx
  ON public.pro_application_events (application_id, created_at DESC);

-- Client ↔ Bravo Control System conversation thread (REVISION_REQUESTED and
-- general questions). Plain operational metadata — NOT messenger E2EE traffic.
CREATE TABLE IF NOT EXISTS public.pro_application_messages (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid        NOT NULL REFERENCES public.pro_applications(id) ON DELETE CASCADE,
  sender         text        NOT NULL CHECK (sender IN ('client','ops')),
  sender_id      uuid,
  body           text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pro_application_messages_app_idx
  ON public.pro_application_messages (application_id, created_at ASC);

-- auth-service reaches these tables through its own service-role pool. RLS on
-- with no anon policies = PostgREST/anon cannot touch them.
ALTER TABLE public.pro_applications         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pro_proposals            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pro_application_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pro_application_messages ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.pro_applications IS
  'Bravo Secure Pro applications (request-and-approval custom plans). Separate concept from users.subscription_tier.';
COMMENT ON TABLE public.pro_proposals IS
  'Versioned Bravo Control System proposals for a Pro application (monthly BC price, services, team).';
COMMENT ON TABLE public.pro_application_events IS
  'Append-only Pro application timeline (client status screen + ops audit).';
COMMENT ON TABLE public.pro_application_messages IS
  'Client ↔ Bravo Control System thread per Pro application (revision requests etc.).';
