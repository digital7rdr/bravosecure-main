-- ──────────────────────────────────────────────────────────────────────
-- Audit Rev2 DB-01 — close the RLS gap on the seven tables created after
-- the 2026-06-03 snapshot, then sweep the catalogue so the CURRENT schema
-- can never have an RLS-off table.
--
-- WHY THIS KEEPS HAPPENING
--   20260603100000_enable_rls_deny_by_default enables RLS by looping over a
--   LITERAL ARRAY of 70 table names. It was a point-in-time snapshot, so every
--   table created afterwards is RLS-off unless its own migration remembers.
--   This is the THIRD catch-up migration for the identical mistake:
--     - 20260603120000_rls_and_search_path_followups   (wallet_credit_batches,
--       missed by the snapshot TWO HOURS earlier)
--     - 20260804020000_enterprise_v2_rls_deny_by_default (five scope-v2 tables,
--       found by the Supabase advisor AFTER a staging apply, not by review)
--
--   The Supabase anon key ships inside the APK (EXPO_PUBLIC_SUPABASE_ANON_KEY,
--   src/utils/constants.ts), and PostgREST exposes every public table to anon
--   unless RLS says otherwise. anon + authenticated currently hold
--   SELECT/INSERT/UPDATE/DELETE/TRUNCATE on all seven of these.
--
--   Worst case is not theoretical: promo_codes writable by anon means an
--   attacker mints {code:'FREE', credits:100000000, active:true}, redeems it
--   through our own /wallet/redeem-promo (whose row lock, redemption cap and
--   per-user PK are all CORRECT — they are simply operating on a promo code
--   the attacker wrote), then deletes their own promo_redemptions row and
--   redeems again. Those credits become real payouts via escrow release.
--   provider_invite_codes are single-use roster-join credentials.
--
-- INCIDENT CHECK (run 2026-08-05, before this migration): CLEAN.
--   promo_codes 1 row (BRAVO50, ops-created 2026-06-21), promo_redemptions 0,
--   provider_invite_codes 0, provider_referral_codes 0, subscription_prices 2
--   (pro 2500 / enterprise 5000). No unrecognised rows.
--
-- LIVE vs TREE DRIFT: at the time of writing, promo_codes, promo_redemptions,
--   invoices and invoice_sequences already had RLS enabled in the LIVE database
--   but in NO migration — switched on out-of-band and never written back. The
--   statements below are idempotent, so this migration both closes the three
--   remaining live gaps AND makes a fresh environment match production.
--
-- SAFETY: the backend connects as `postgres`, which has the rolbypassrls role
--   attribute, so RLS never applies to it. Only direct anon-key access is
--   blocked — which is the point. RLS ON + zero policies IS the deny rule.
--   FORCE matches the 2026-06-03 migration's own rationale (harmless for a
--   BYPASSRLS owner; defence-in-depth against a future non-bypassing owner)
--   and keeps all tables on ONE rule instead of manufacturing more drift.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1. The seven the snapshot missed ────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'promo_codes','promo_redemptions','subscription_prices',
    'invoices','invoice_sequences',
    'provider_invite_codes','provider_referral_codes'
  ]
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', t);
    END IF;
  END LOOP;
END $$;

-- ── 2. Sweep the catalogue for anything else that drifted ──────────────
-- Covers ordinary AND partitioned tables. relkind:
--   'r' ordinary, 'p' partitioned. Views/matviews cannot carry RLS at all and
--   are banned separately by supabase/__tests__/rlsCoverage.test.ts, because a
--   non-security_invoker view runs as its owner (postgres, BYPASSRLS) and would
--   read straight THROUGH RLS — which would silently defeat everything above.
--
-- NOTE THE LIMIT OF THIS BLOCK: a migration runs exactly ONCE. This fixes the
-- schema as it stands today; it does NOT prevent the next new table from
-- shipping RLS-off. The standing gate is the post-`db push` assertion in
-- .github/workflows/deploy-migrations.yml, which fails the deploy when any
-- public table has relrowsecurity = false. Do not treat this block as the
-- permanent fix — it is the third one of its kind.
-- Why the pg_depend exclusion: the sweep must cover every APPLICATION table and
-- nothing else. PostGIS installs spatial_ref_sys into public, and it is owned by
-- the extension installer (supabase_admin), not by `postgres` — the role that
-- runs `supabase db push`. Without this filter the ALTER raises
-- "must be owner of table spatial_ref_sys", the whole migration aborts, and the
-- deny-by-default guarantee is never applied to ANY table. Excluding
-- extension-owned relations is what makes the check RUN; it is not a carve-out
-- for application data. The assertion below uses the identical predicate so the
-- sweep and the proof can never disagree.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r', 'p')
       AND NOT c.relrowsecurity
       AND NOT EXISTS (
             SELECT 1 FROM pg_depend d
              WHERE d.objid = c.oid AND d.deptype = 'e')
  LOOP
    RAISE NOTICE 'RLS catch-up sweep: enabling on public.%', r.relname;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.relname);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', r.relname);
  END LOOP;
END $$;

-- ── 3. Prove it, in the same transaction ───────────────────────────────
DO $$
DECLARE missing int;
BEGIN
  SELECT count(*) INTO missing
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind IN ('r', 'p')
     AND NOT c.relrowsecurity
     AND NOT EXISTS (
           SELECT 1 FROM pg_depend d
            WHERE d.objid = c.oid AND d.deptype = 'e');
  IF missing > 0 THEN
    RAISE EXCEPTION 'RLS catch-up failed: % public table(s) still have RLS disabled', missing;
  END IF;
END $$;
