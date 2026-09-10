-- Product rename (2026-08-04, same day as 20260804150000_bravo_lux):
-- the fixed-block protection product briefly shipped as "Bravo Lux"
-- (service 'lux') is EXECUTIVE PROTECTION under Bravo Secure Lite;
-- "Bravo Secure Lux" returns to a coming-soon plan card. The wire value
-- reverts to the pre-existing 'executive_protection' and the transport
-- column follows the product name. No behavioural change.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'lite_bookings' AND column_name = 'lux_transport'
  ) THEN
    ALTER TABLE lite_bookings RENAME COLUMN lux_transport TO exec_transport;
  END IF;
END $$;

-- Heal any rows created by the short-lived v1.0.220 client (verified: one
-- CANCELLED test booking at time of writing).
UPDATE lite_bookings SET service = 'executive_protection' WHERE service = 'lux';
