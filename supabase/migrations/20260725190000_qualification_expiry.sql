-- Issue 39 (Testing Issues V2, PDF p.44) — "Service Provider Cannot View
-- Sufficient Agent Roster Information".
--
-- The first pass surfaced rating + capabilities. Two of the PDF's required
-- fields had nowhere to live:
--
--   1. QUALIFICATION EXPIRY. `agent_documents` records a compliance pack slot
--      (SIA, first aid, insurance, DBS…) with an upload + review state but no
--      validity window, so a provider could not tell an in-date certificate
--      from one that lapsed two years ago. Only `armed_authorizations` carried
--      an expiry, and only for the armed permit.
--
--   2. ISSUING BODY. Required by the PDF alongside expiry, and by Issue 36's
--      structured medical qualification (level + certificate + expiry +
--      issuing body) — which currently has nowhere to record the last two.
--
-- Both are NULLable and purely additive: every existing row keeps working and
-- an absent expiry means "no expiry recorded", never "expired".
--
-- 🛑 No PII lands here. `issuing_body` is an organisation name (e.g. "SIA",
-- "Red Cross"), not a certificate holder or a document reference — permit_ref
-- style values stay on armed_authorizations, which is RLS-locked.

ALTER TABLE public.agent_documents
  ADD COLUMN IF NOT EXISTS expires_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS issuing_body TEXT;

-- The provider roster asks "what is expiring on this officer" and ops asks
-- "what is expiring across the roster" — both are expiry-ordered scans over
-- rows that HAVE an expiry, so index only those.
CREATE INDEX IF NOT EXISTS agent_documents_expiry_idx
  ON public.agent_documents (expires_at)
  WHERE expires_at IS NOT NULL;

COMMENT ON COLUMN public.agent_documents.expires_at IS
  'Validity end of this qualification/document (Issue 39). NULL = no expiry recorded — never treat NULL as expired.';
COMMENT ON COLUMN public.agent_documents.issuing_body IS
  'Organisation that issued the qualification (Issue 39 / Issue 36). Organisation name only — never a holder name or certificate reference.';
