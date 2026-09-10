-- Track who last renamed a department channel + when, so the client can
-- surface a WhatsApp-style "X renamed the channel to Y" system line in the
-- (E2EE) thread. The channel NAME itself is already plaintext server
-- metadata (not E2EE) — only the message content in the thread is
-- encrypted — so this is safe to store server-side like the name itself.
ALTER TABLE public.department_channels
  ADD COLUMN IF NOT EXISTS name_changed_by uuid NULL REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS name_changed_at timestamptz NULL;
