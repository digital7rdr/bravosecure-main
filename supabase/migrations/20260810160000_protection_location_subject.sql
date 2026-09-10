-- Protection sessions — track BOTH the customer's and the officer's location
-- within a session so ops can render client / CPO / combined maps.
--
-- A `subject` tag on each location row distinguishes the two streams. Existing
-- rows are the customer's (the only stream that existed), so the default is
-- 'customer'. The officer's app posts subject='cpo' via the CPO ping endpoint.
-- Access separation is unchanged — reads stay scoped in the service WHERE
-- clauses (§9); this only adds a discriminator column + its index.

ALTER TABLE public.protection_session_locations
  ADD COLUMN IF NOT EXISTS subject text NOT NULL DEFAULT 'customer';

CREATE INDEX IF NOT EXISTS psl_subject_idx
  ON public.protection_session_locations (session_id, subject, received_at DESC);

-- In-session notes: a lightweight one-way channel. The customer taps a
-- predefined option or types a short comment (customer→officer); the officer
-- can reply (officer→customer). NOT a full chat — no read receipts, no media.
-- RLS on+force, service-layer scoping (§9); the officer sees only their own
-- sessions' notes.
CREATE TABLE IF NOT EXISTS public.protection_session_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES public.protection_sessions(id) ON DELETE CASCADE,
  sender      text NOT NULL,                 -- 'customer' | 'cpo'
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS psn_session_idx ON public.protection_session_notes (session_id, created_at);
ALTER TABLE public.protection_session_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.protection_session_notes FORCE  ROW LEVEL SECURITY;

-- CPO Protect — the officer formally engages protection. One-time (idempotent);
-- null until the officer taps it. Distinct from the session's streaming ACTIVE.
ALTER TABLE public.protection_sessions ADD COLUMN IF NOT EXISTS protect_activated_at timestamptz;
