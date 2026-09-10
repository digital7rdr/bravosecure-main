-- Security hardening (advisor 0011): pin search_path on the updated_at
-- trigger functions so a role-mutable search_path can't be exploited to
-- shadow built-ins. These functions only touch NEW.updated_at, so an empty
-- search_path is safe (no unqualified object references).
--
-- Guarded so it's a no-op where a function doesn't exist in a given env.
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'touch_updated_at','touch_wallet_balances_updated_at','touch_agents_updated_at',
    'touch_lite_bookings_updated_at','touch_missions_updated_at',
    -- FSM / append-only trigger functions (from phase2_data_integrity)
    'missions_fsm_check','lite_bookings_fsm_check','ops_audit_no_mutation'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname=fn
    ) THEN
      EXECUTE format('ALTER FUNCTION public.%I() SET search_path = '''';', fn);
    END IF;
  END LOOP;
END $$;
