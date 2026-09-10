-- Mission History — ONE canonical, append-only activity timeline per protection
-- session (spec §5/§8). Every role (User / CPO / Ops) reads role-filtered views
-- of THIS single record; there is no separate per-role history. Append-only:
-- events are never overwritten. Chronological by created_at, deterministic
-- tie-break by `seq`. Server timestamps only.
--
-- `visibility`: 'all' rows appear in every role's timeline (incl. the customer);
-- 'internal' rows (ops/cpo operational detail, ops reasons) are filtered from the
-- customer view (§7). Access is enforced in the service WHERE clauses (§7) — RLS
-- on+force, no policies (deny-all for anon/authenticated).

CREATE TABLE IF NOT EXISTS public.protection_session_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq         bigint GENERATED ALWAYS AS IDENTITY,   -- deterministic ordering tie-break
  session_id  uuid NOT NULL REFERENCES public.protection_sessions(id) ON DELETE CASCADE,
  event_type  text NOT NULL,        -- created|activated|note|protect|sos|ended|aborted|timeout|transfer|reassigned
  actor_id    uuid,                 -- null for system events
  actor_role  text NOT NULL,        -- 'customer' | 'cpo' | 'ops' | 'system'
  prev_status text,
  new_status  text,
  comment     text,
  visibility  text NOT NULL DEFAULT 'all',  -- 'all' | 'internal'
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pse_session_idx ON public.protection_session_events (session_id, seq);
CREATE INDEX IF NOT EXISTS pse_actor_idx   ON public.protection_session_events (actor_id, created_at DESC);

ALTER TABLE public.protection_session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.protection_session_events FORCE  ROW LEVEL SECURITY;
