-- REGION (#8) — persisted per-user home region (clients have none today; region
-- was per-booking + manual). NULL = not yet detected; 'N/A' = outside coverage.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS home_region TEXT
  CHECK (home_region IS NULL OR home_region IN ('AE','SA','BD','GB','ZA','N/A'));
