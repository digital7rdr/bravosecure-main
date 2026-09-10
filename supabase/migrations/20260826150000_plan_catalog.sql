-- 2026-08-26 — ops-editable subscription-package catalog (founder request:
-- "all the subscription package price, description, name all can be changed
-- via ops console").
--
-- PRICES for the self-serve messenger tiers stay in subscription_prices —
-- that table is what SubscriptionService charges from (M1A/S9), and forking
-- the number into a second table is how a display price and a charged price
-- start disagreeing. This table holds the DISPLAY COPY (name + description)
-- for every package card the apps render; the public catalog endpoint merges
-- the two.
--
-- Keys are the app's stable identifiers — the cards keep their hardcoded copy
-- as a FAIL-OPEN fallback when a row is missing or the fetch fails, so an
-- empty or unreachable catalog can never blank a paywall.

CREATE TABLE IF NOT EXISTS public.plan_catalog (
  key          text PRIMARY KEY CHECK (key IN (
                 'messenger_lite', 'messenger_pro', 'messenger_enterprise',
                 'secure_pro', 'secure_lux'
               )),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
  description  text NOT NULL CHECK (char_length(description) <= 500),
  updated_at   timestamptz NOT NULL DEFAULT NOW(),
  updated_by   uuid REFERENCES public.users(id)
);

-- Deny-by-default RLS, same posture as every other table (20260805090816):
-- only the service role reaches it.
ALTER TABLE public.plan_catalog ENABLE ROW LEVEL SECURITY;

-- Seed with the copy the apps ship today, so day one renders identically.
INSERT INTO public.plan_catalog (key, display_name, description) VALUES
  ('messenger_lite', 'Bravo Messenger Lite',
   'Free secure messaging — end-to-end encrypted chats and calls.'),
  ('messenger_pro', 'Bravo Messenger Pro',
   'Encrypted file vault, premium comms features and priority support.'),
  ('messenger_enterprise', 'Bravo Messenger Enterprise',
   'Team workspaces, department channels, attendance and incident tooling.'),
  ('secure_pro', 'Bravo Secure Pro',
   'Custom protection plan for periods beyond 24 hours — dedicated team, journey monitoring and operational support.'),
  ('secure_lux', 'Bravo Secure Lux',
   'Premium white-glove service — private aircraft, armored fleet, yachts and elite protection logistics, arranged worldwide.')
ON CONFLICT (key) DO NOTHING;
