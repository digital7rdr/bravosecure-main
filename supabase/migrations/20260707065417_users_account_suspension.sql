-- DC-04 — account suspension. Reversible lockout (distinct from deleted_at,
-- which is the irreversible erasure tombstone). The login/verify/refresh paths
-- gate on `suspended_at IS NULL`; suspending also revokes all devices so the
-- effect is immediate (access tokens age out within their <=15-min TTL).
alter table public.users
  add column if not exists suspended_at     timestamptz,
  add column if not exists suspended_reason text,
  add column if not exists suspended_by     uuid;

create index if not exists users_suspended_idx on public.users (suspended_at)
  where suspended_at is not null;
