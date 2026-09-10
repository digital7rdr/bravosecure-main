-- Dept Chat v2 · Step 10 (E2) — per-recipient-device sealed keys for incident
-- evidence. Each row holds the per-file AES key+iv for ONE attachment, sealed to
-- ONE recipient device's Signal identity via the existing outer-ECIES wrap. The
-- server stores ONLY the opaque sealed blob — NEVER a plaintext key. The
-- encrypted bytes themselves live in the media vault (R2/Supabase), referenced by
-- incident_attachments.storage_key. Additive + idempotent.

CREATE TABLE IF NOT EXISTS public.incident_attachment_keys (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id     UUID NOT NULL REFERENCES public.incident_attachments(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  device_id         INT  NOT NULL,
  -- outer-ECIES sealed JSON {keyB64, ivB64, mime}; opaque ciphertext, never plaintext.
  sealed_key        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (attachment_id, recipient_user_id, device_id)
);

CREATE INDEX IF NOT EXISTS incident_attachment_keys_lookup_idx
  ON public.incident_attachment_keys (attachment_id, recipient_user_id, device_id);

ALTER TABLE public.incident_attachment_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_attachment_keys FORCE  ROW LEVEL SECURITY;
-- Deny-by-default (no policies). The NestJS `rolbypassrls` role bypasses RLS; all
-- access is gated in IncidentService (submitter stores; submitter|org-manager reads).

-- down:
-- DROP TABLE IF EXISTS public.incident_attachment_keys;
