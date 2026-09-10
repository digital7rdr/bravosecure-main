-- Bravo Secure — Phase-1 gap closers
--   • wallet_balances         — per-user Bravo Credits + last Stripe customer id
--   • wallet_transactions     — append-only ledger (topup / payment / refund / payout)
--   • cpo_pool                — active CPO roster (minimal fields for auto-assignment)
--   • vehicle_pool            — active armored-vehicle roster
--   • mission_telemetry_last  — last known GPS fix per booking (Redis Stream is
--                               source-of-truth; this table backs the REST fallback
--                               and survives restarts)
--
-- Idempotent — safe to re-run.

-- ─── wallet ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wallet_balances (
  user_id              UUID PRIMARY KEY,
  bravo_credits        INTEGER NOT NULL DEFAULT 0,
  currency             TEXT    NOT NULL DEFAULT 'AED',
  stripe_customer_id   TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wallet_tx_type') THEN
    CREATE TYPE wallet_tx_type AS ENUM ('topup', 'payment', 'refund', 'payout');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wallet_tx_status') THEN
    CREATE TYPE wallet_tx_status AS ENUM ('pending', 'succeeded', 'failed', 'refunded');
  END IF;
END$$;

-- wallet_transactions is created in `20260416000000_init_phase1.sql` with a
-- different (older) shape: (kind, amount_cents, external_ref). This migration
-- evolves that shape into the wallet ledger format expected by the assignment
-- telemetry features. Use ADD COLUMN IF NOT EXISTS so we're safe to re-run.
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS type                  wallet_tx_type,
  ADD COLUMN IF NOT EXISTS status                wallet_tx_status NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS amount_credits        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_fiat_cents     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fiat_currency         TEXT    NOT NULL DEFAULT 'usd',
  ADD COLUMN IF NOT EXISTS description           TEXT,
  ADD COLUMN IF NOT EXISTS booking_id            UUID,
  ADD COLUMN IF NOT EXISTS stripe_intent_id      TEXT,
  ADD COLUMN IF NOT EXISTS stripe_client_secret  TEXT,
  ADD COLUMN IF NOT EXISTS metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS settled_at            TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS wallet_tx_user_idx    ON wallet_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wallet_tx_intent_idx  ON wallet_transactions(stripe_intent_id);
CREATE INDEX IF NOT EXISTS wallet_tx_booking_idx ON wallet_transactions(booking_id);

-- ─── CPO + vehicle pool ─────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cpo_availability') THEN
    CREATE TYPE cpo_availability AS ENUM ('available', 'on_mission', 'off_duty');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vehicle_status') THEN
    CREATE TYPE vehicle_status AS ENUM ('available', 'on_mission', 'maintenance');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS cpo_pool (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_sign       TEXT NOT NULL UNIQUE,          -- "CPO 44"
  display_name    TEXT NOT NULL,                 -- "R. Al-Rashid"
  role            TEXT NOT NULL DEFAULT 'CPO',   -- "Senior CPO · Armed"
  region_code     TEXT NOT NULL DEFAULT 'AE',
  armed           BOOLEAN NOT NULL DEFAULT FALSE,
  female          BOOLEAN NOT NULL DEFAULT FALSE,
  specialties     TEXT[] NOT NULL DEFAULT '{}',
  availability    cpo_availability NOT NULL DEFAULT 'available',
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cpo_pool_region_avail_idx
  ON cpo_pool(region_code, availability)
  WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS vehicle_pool (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_sign       TEXT NOT NULL UNIQUE,          -- "VEH 11"
  make_model      TEXT NOT NULL,                 -- "Toyota LC300"
  plate           TEXT NOT NULL,                 -- "A 4439"
  region_code     TEXT NOT NULL DEFAULT 'AE',
  armored         BOOLEAN NOT NULL DEFAULT TRUE,
  armor_grade     TEXT,                          -- "B6"
  capacity        INTEGER NOT NULL DEFAULT 4,
  status          vehicle_status NOT NULL DEFAULT 'available',
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vehicle_pool_region_status_idx
  ON vehicle_pool(region_code, status)
  WHERE active = TRUE;

-- Many-to-many: a booking can hold several CPOs (e.g. cpo_count = 2).
-- Vehicle is a single FK on lite_bookings (already exists: vehicle_id).
CREATE TABLE IF NOT EXISTS booking_cpo_assignments (
  booking_id    UUID NOT NULL REFERENCES lite_bookings(id) ON DELETE CASCADE,
  cpo_id        UUID NOT NULL REFERENCES cpo_pool(id),
  slot          INTEGER NOT NULL DEFAULT 0,
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (booking_id, cpo_id)
);

CREATE INDEX IF NOT EXISTS booking_cpo_booking_idx ON booking_cpo_assignments(booking_id);

-- Seed pool so Phase-1 demo lands real rows. Idempotent inserts.
INSERT INTO cpo_pool (call_sign, display_name, role, region_code, armed, female, specialties, availability)
VALUES
  ('CPO 44', 'R. Al-Rashid',  'Senior CPO · Armed',  'AE', TRUE,  FALSE, ARRAY['armed','exec_protection'],   'available'),
  ('CPO 47', 'M. Khaskun',    'CPO · Recon Team',    'AE', TRUE,  FALSE, ARRAY['recon','route_assessment'],  'available'),
  ('CPO 52', 'S. Jameel',     'Senior CPO',          'AE', TRUE,  FALSE, ARRAY['armed','exec_protection'],   'available'),
  ('CPO 61', 'N. Faraj',      'CPO · Female Team',   'AE', FALSE, TRUE,  ARRAY['female_team'],               'available'),
  ('CPO 82', 'D. Voss',       'Senior CPO · Medical','AE', TRUE,  FALSE, ARRAY['medical','armed'],           'available')
ON CONFLICT (call_sign) DO NOTHING;

INSERT INTO vehicle_pool (call_sign, make_model, plate, region_code, armored, armor_grade, capacity, status)
VALUES
  ('VEH 11', 'Toyota Land Cruiser 300', 'A 4439', 'AE', TRUE, 'B6', 5, 'available'),
  ('VEH 14', 'Lexus LX 600',            'A 5512', 'AE', TRUE, 'B6', 5, 'available'),
  ('VEH 22', 'Mercedes-Benz S-Class',   'A 6689', 'AE', TRUE, 'B4', 4, 'available'),
  ('VEH 30', 'BMW X7',                  'A 7812', 'AE', TRUE, 'B4', 5, 'available')
ON CONFLICT (call_sign) DO NOTHING;

-- ─── telemetry (last-fix fallback for the REST stream) ─────────────────────

CREATE TABLE IF NOT EXISTS mission_telemetry_last (
  booking_id   UUID PRIMARY KEY REFERENCES lite_bookings(id) ON DELETE CASCADE,
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  heading_deg  DOUBLE PRECISION,
  speed_kph    DOUBLE PRECISION,
  eta_minutes  INTEGER,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source       TEXT NOT NULL DEFAULT 'agent'
);

CREATE INDEX IF NOT EXISTS mission_telemetry_last_recorded_idx
  ON mission_telemetry_last(recorded_at DESC);

-- ─── helper trigger: keep wallet_balances.updated_at fresh ─────────────────

CREATE OR REPLACE FUNCTION touch_wallet_balances_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wallet_balances_touch_updated_at ON wallet_balances;
CREATE TRIGGER wallet_balances_touch_updated_at
  BEFORE UPDATE ON wallet_balances
  FOR EACH ROW
  EXECUTE FUNCTION touch_wallet_balances_updated_at();
