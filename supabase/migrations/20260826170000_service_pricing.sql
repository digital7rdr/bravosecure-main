-- 2026-08-26 — ops-editable SERVICE pricing (founder: "start adding the
-- prices for services like secure transfers, executive protection… 1x CPO,
-- vehicle, female, price per hour… everywhere where the price applicable").
--
-- Same shape as plan_catalog: a keyed table of the numbers the pricing
-- engine uses, seeded with EXACTLY the compiled values, read fail-open at
-- charge time. The compiled constants stay in code as the fallback, so an
-- unreachable table charges what the app charges today — never zero, never
-- a surprise.
--
-- numeric, not integer: the factors (0.25 / 0.65 / 1.2) are part of the
-- price model and the founder asked for "everywhere".

CREATE TABLE IF NOT EXISTS public.service_pricing (
  key        text PRIMARY KEY CHECK (key IN (
               'eur_per_bc',                 -- THE ROOT: 1 BC = X EUR (founder 2026-08-26)
               'transfer_base_rate_bc',      -- 1 CPO + vehicle + driver, per hour
               'transfer_extra_unit_factor', -- each extra CPO/vehicle = factor x base
               'transfer_driver_only_factor',-- driver-only multiplier on the rate
               'peak_multiplier',            -- 17:00-20:00 local surcharge
               'base_rate_aed',              -- AED display conversion anchor
               'exec_cpo_rate_bc',           -- executive: per CPO per hour
               'exec_vehicle_rate_bc',       -- executive: per vehicle+driver per hour
               'exec_driver_only_rate_bc',   -- executive: Bravo driver, client's car
               'addon_female_cpo_bc',        -- per hour
               'addon_recon_bc',
               'addon_medical_bc',
               'addon_comms_bc'
             )),
  value      numeric(10,4) NOT NULL CHECK (value > 0 AND value < 100000),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  updated_by uuid REFERENCES public.users(id)
);

ALTER TABLE public.service_pricing ENABLE ROW LEVEL SECURITY;

INSERT INTO public.service_pricing (key, value) VALUES
  ('eur_per_bc',                  1.0),
  ('transfer_base_rate_bc',       86),
  ('transfer_extra_unit_factor',  0.25),
  ('transfer_driver_only_factor', 0.65),
  ('peak_multiplier',             1.2),
  ('base_rate_aed',               350),
  ('exec_cpo_rate_bc',            86),
  ('exec_vehicle_rate_bc',        30),
  ('exec_driver_only_rate_bc',    20),
  ('addon_female_cpo_bc',         120),
  ('addon_recon_bc',              100),
  ('addon_medical_bc',            90),
  ('addon_comms_bc',              75)
ON CONFLICT (key) DO NOTHING;
