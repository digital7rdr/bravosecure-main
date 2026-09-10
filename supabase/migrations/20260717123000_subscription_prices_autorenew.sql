-- M1A/S9 — ops-editable tier pricing + BC auto-renew.
--
-- 1. subscription_prices — the live BC price per paid tier, edited from the
--    ops console. Prices are read AT CHARGE TIME (subscribe + renewal), so a
--    price change applies to every charge after it while already-paid
--    periods finish untouched — the founder's "from next month it applies
--    to all" semantics with no scheduling machinery.
--
-- 2. users.bc_auto_renew — renew from Bravo Credits at period end (the
--    Stripe card path already exists; this covers BC-funded accounts). The
--    renewal sweep debits the CURRENT price; insufficient credits → the
--    ordinary lapse sweep downgrades to Lite.

CREATE TABLE IF NOT EXISTS public.subscription_prices (
  tier       text PRIMARY KEY CHECK (tier IN ('pro', 'enterprise')),
  price_bc   integer NOT NULL CHECK (price_bc > 0),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  updated_by uuid REFERENCES public.users(id)
);

INSERT INTO public.subscription_prices (tier, price_bc)
VALUES ('pro', 2000), ('enterprise', 5000)
ON CONFLICT (tier) DO NOTHING;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS bc_auto_renew boolean NOT NULL DEFAULT false;
