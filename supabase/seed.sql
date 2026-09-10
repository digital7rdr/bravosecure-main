-- Bravo Secure — dev seed
-- Idempotent: safe to run repeatedly on a reset DB. Matches section 6 of the doc.

-- Only seed when the users table is empty (i.e. first `supabase db reset`).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.users LIMIT 1) THEN
    RAISE NOTICE 'Seed skipped — users table already populated';
    RETURN;
  END IF;

  -- NOTE: we intentionally do NOT insert into auth.users here.
  -- In local dev you create accounts via the app (phone OTP with the test_otp
  -- map in config.toml, or email/password). The on_auth_user_created trigger
  -- then populates public.users. This seed only loads reference data that is
  -- independent of real auth accounts.

  -- Intel sources (always needed; unrelated to users)
  INSERT INTO public.intel_sources (name, kind, config) VALUES
    ('The Guardian', 'guardian',    '{"endpoint":"https://content.guardianapis.com"}'),
    ('Google News',  'google_news', '{"region":"worldwide"}'),
    ('Bravo Ops',    'internal',    '{}')
  ON CONFLICT DO NOTHING;

  -- A handful of sample intel items so the feed isn't empty on first boot.
  WITH src AS (SELECT id FROM public.intel_sources WHERE kind = 'guardian' LIMIT 1)
  INSERT INTO public.intel_items (source_id, external_id, title, summary, url, severity, published_at)
  SELECT src.id, 'seed-1',
         'Local dev seed: civil unrest reported in sample region',
         'This is a seeded intel item for local development.',
         'https://example.com/seed-1',
         'advisory',
         now() - interval '2 hours'
  FROM src
  ON CONFLICT (source_id, external_id) DO NOTHING;
END $$;
