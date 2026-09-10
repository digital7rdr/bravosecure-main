-- Follow-up hardening for objects created by the backfilled migrations.
-- (wallet_credit_batches is created in 20260516; the FSM/append-only trigger
-- functions in 20260509100000.) Kept as a separate, idempotent migration so
-- environments that already ran the broad RLS / search_path migrations still
-- pick up these specific objects.

-- 1. RLS on wallet_credit_batches (deny-by-default; the postgres backend
--    bypasses RLS, so this only locks out anon/authenticated).
ALTER TABLE public.wallet_credit_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_credit_batches FORCE ROW LEVEL SECURITY;

-- 2. Pin search_path on the FSM / append-only trigger functions.
ALTER FUNCTION public.missions_fsm_check()      SET search_path = pg_catalog;
ALTER FUNCTION public.lite_bookings_fsm_check() SET search_path = pg_catalog;
ALTER FUNCTION public.ops_audit_no_mutation()   SET search_path = pg_catalog;
