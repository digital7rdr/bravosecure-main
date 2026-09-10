-- Dept Chat v2 · Incident reporting data model (PDF p.11-16) + org audit log.
--
-- Net-new subsystem. Tables:
--   * incident_reports     — the structured report (who/what/where/how severe).
--                            The submitter narrative (category/severity/
--                            description/location) is WRITE-ONCE by design.
--   * incident_events      — append-only status history + internal notes
--                            (immutable original report; manager activity lives
--                            here, never back on the report row — PDF p.15).
--   * incident_attachments — opaque vault pointers ONLY; the encrypted bytes
--                            live in the media vault (Step 10). No media here.
--   * org_audit_log        — generic ORG-MANAGER-scoped audit (attendance review,
--                            exports, incident actions).
--   * incident_ref_seq     — human-readable reference counter (INC-2026-00142).
--
-- 🛑 TRUST-TIER NOTE: org_audit_log is the org-manager-scoped sibling of the
-- HQ-tier ops_audit table (AdminGuard / OpsAuditService). They are INTENTIONALLY
-- separate — do not route provider actions through ops_audit, or vice versa.
--
-- 🛑 SECURITY: org_audit_log.metadata and every attachment row hold NO PII —
-- no incident description, no coordinates, no credential refs, no signed URLs
-- (the static log-audit test + CLAUDE.md enforce this). storage_key is an opaque
-- vault object key, never a URL.
--
-- ALL changes are additive + idempotent. New tables get RLS deny-by-default.
-- A matching down-migration is at the foot (commented). Behind the DEPT_CHAT_V2
-- feature flag until rollout (Step 17).

-- Human-readable reference counter, stamped at insert as 'INC-YYYY-NNNNN'.
CREATE SEQUENCE IF NOT EXISTS public.incident_ref_seq;

-- ── 1. incident_reports — the structured report (submitter narrative is write-once) ──
CREATE TABLE IF NOT EXISTS public.incident_reports (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref            TEXT UNIQUE,                      -- 'INC-2026-00142', stamped at insert
  org_user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  submitter_id   UUID NOT NULL REFERENCES public.users(id),
  department     TEXT,                             -- label; routes to org manager(s)
  category       TEXT NOT NULL,                    -- one of the 15 (validated in the DTO)
  severity       TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  description    TEXT NOT NULL,                    -- immutable submitter narrative
  location_label TEXT,
  location_lat   DOUBLE PRECISION,
  location_lng   DOUBLE PRECISION,
  status         TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','received','under_review','action_assigned','resolved','closed')),
  assigned_to    UUID REFERENCES public.users(id),  -- action owner
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Manager queue scan: org-scoped, filterable by status/severity.
CREATE INDEX IF NOT EXISTS incident_org_status_idx
  ON public.incident_reports(org_user_id, status, severity);
-- A member's "my submitted incidents" list.
CREATE INDEX IF NOT EXISTS incident_submitter_idx
  ON public.incident_reports(submitter_id);

-- ── 2. incident_events — append-only status history + internal notes ──────────
CREATE TABLE IF NOT EXISTS public.incident_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id   UUID NOT NULL REFERENCES public.incident_reports(id) ON DELETE CASCADE,
  actor_id      UUID NOT NULL REFERENCES public.users(id),
  from_status   TEXT,
  to_status     TEXT,
  note          TEXT,                              -- manager note (internal unless flagged)
  note_internal BOOLEAN NOT NULL DEFAULT TRUE,     -- internal notes are NOT member-visible
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS incident_events_idx
  ON public.incident_events(incident_id, created_at);

-- ── 3. incident_attachments — opaque vault pointers (bytes encrypted in vault) ─
CREATE TABLE IF NOT EXISTS public.incident_attachments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES public.incident_reports(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,                       -- opaque vault object key, NOT a URL
  created_by  UUID NOT NULL REFERENCES public.users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS incident_attachments_idx
  ON public.incident_attachments(incident_id);

-- ── 4. org_audit_log — generic org-manager-scoped audit (NOT ops_audit) ───────
CREATE TABLE IF NOT EXISTS public.org_audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  actor_id    UUID NOT NULL REFERENCES public.users(id),
  action      TEXT NOT NULL,                       -- 'attendance.review.approve' | 'incident.status' | 'attendance.export'
  target_kind TEXT,
  target_id   UUID,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,  -- NO PII / coordinates / descriptions
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS org_audit_idx
  ON public.org_audit_log(org_user_id, created_at DESC);

-- ── 5. RLS: deny-by-default for anon/authenticated, backend bypasses ──────────
ALTER TABLE public.incident_reports     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_reports     FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.incident_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_events      FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.incident_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_attachments FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.org_audit_log        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_audit_log        FORCE  ROW LEVEL SECURITY;

-- ── Down migration (uncomment to revert) ─────────────────────────────────────
-- DROP TABLE IF EXISTS public.org_audit_log;
-- DROP TABLE IF EXISTS public.incident_attachments;
-- DROP TABLE IF EXISTS public.incident_events;
-- DROP TABLE IF EXISTS public.incident_reports;
-- DROP SEQUENCE IF EXISTS public.incident_ref_seq;
