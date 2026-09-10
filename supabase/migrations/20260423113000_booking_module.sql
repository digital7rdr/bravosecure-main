-- Bravo Secure — Lite Booking module (Phase 2)
-- Separate from Phase 1 `bookings` table; new-flow records live in `lite_bookings`.
-- Creates:
--   lite_bookings         — primary booking record for the Lite wizard flow
--   lite_booking_add_ons  — reference table of available add-ons per region
--   lite_booking_audit    — append-only status transition log

-- Status lifecycle:
--   DRAFT → PENDING_OPS → OPS_APPROVED → PAYMENT_PENDING → CONFIRMED → LIVE → COMPLETED
-- Plus terminal: CANCELLED (from any non-terminal state).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lite_booking_status') THEN
    CREATE TYPE lite_booking_status AS ENUM (
      'DRAFT',
      'PENDING_OPS',
      'OPS_APPROVED',
      'PAYMENT_PENDING',
      'CONFIRMED',
      'LIVE',
      'COMPLETED',
      'CANCELLED'
    );
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS lite_bookings (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          UUID NOT NULL,
  status             lite_booking_status NOT NULL DEFAULT 'DRAFT',

  region_code        TEXT NOT NULL,
  region_label       TEXT NOT NULL,
  service            TEXT NOT NULL,

  booking_mode       TEXT NOT NULL DEFAULT 'now',
  pickup_time        TIMESTAMPTZ NOT NULL,
  pickup_address     TEXT NOT NULL,
  pickup_lat         DECIMAL(10, 7),
  pickup_lng         DECIMAL(10, 7),
  dropoff_address    TEXT,
  dropoff_lat        DECIMAL(10, 7),
  dropoff_lng        DECIMAL(10, 7),

  passengers         INTEGER NOT NULL DEFAULT 1,
  cpo_count          INTEGER NOT NULL DEFAULT 1,
  vehicle_count      INTEGER NOT NULL DEFAULT 1,
  driver_only        BOOLEAN NOT NULL DEFAULT FALSE,
  add_ons            JSONB NOT NULL DEFAULT '[]'::jsonb,

  rate_eur_per_hour  DECIMAL(10, 2) NOT NULL,
  rate_aed_per_hour  DECIMAL(10, 2) NOT NULL,
  duration_hours     INTEGER NOT NULL DEFAULT 4,
  total_eur          DECIMAL(10, 2) NOT NULL,
  total_aed          DECIMAL(10, 2) NOT NULL,

  cpo_id             UUID,
  vehicle_id         UUID,
  comms_channel_id   UUID,

  payment_method     TEXT NOT NULL DEFAULT 'card',
  payment_captured   BOOLEAN NOT NULL DEFAULT FALSE,
  invoice_pdf_url    TEXT,
  rating             INTEGER,
  notes              TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS lite_bookings_client_idx  ON lite_bookings(client_id);
CREATE INDEX IF NOT EXISTS lite_bookings_status_idx  ON lite_bookings(status);
CREATE INDEX IF NOT EXISTS lite_bookings_pickup_idx  ON lite_bookings(pickup_time);

CREATE TABLE IF NOT EXISTS lite_booking_audit (
  id           BIGSERIAL PRIMARY KEY,
  booking_id   UUID NOT NULL REFERENCES lite_bookings(id) ON DELETE CASCADE,
  from_status  lite_booking_status,
  to_status    lite_booking_status NOT NULL,
  actor_id     UUID,
  actor_role   TEXT NOT NULL,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS lite_booking_audit_booking_idx ON lite_booking_audit(booking_id);

CREATE TABLE IF NOT EXISTS lite_booking_add_ons (
  id                    TEXT PRIMARY KEY,
  label                 TEXT NOT NULL,
  description           TEXT,
  region_code           TEXT NOT NULL,
  price_eur_per_hour    DECIMAL(10, 2) NOT NULL DEFAULT 0,
  requires_ops_approval BOOLEAN NOT NULL DEFAULT FALSE,
  active                BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO lite_booking_add_ons
  (id, label, description, region_code, price_eur_per_hour, requires_ops_approval, active)
VALUES
  ('female_cpo', 'Female CPO Team',  'Female close protection officer(s)', 'GLOBAL', 30, FALSE, TRUE),
  ('recon',      'Recon Team',       'Area sweep & route assessment',      'GLOBAL', 25, FALSE, TRUE),
  ('medical',    'Medical Support',  'Paramedic on standby',               'GLOBAL', 22, FALSE, TRUE),
  ('comms',      'Comms / SIGINT',   'Encrypted comms specialist',         'GLOBAL', 18, TRUE,  TRUE)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION touch_lite_bookings_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lite_bookings_touch_updated_at ON lite_bookings;
CREATE TRIGGER lite_bookings_touch_updated_at
  BEFORE UPDATE ON lite_bookings
  FOR EACH ROW
  EXECUTE FUNCTION touch_lite_bookings_updated_at();
