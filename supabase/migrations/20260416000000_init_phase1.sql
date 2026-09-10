-- Bravo Secure — Phase 1 schema
-- Mirrors sections 3.1–3.10 of "Monorepo & DB schema setup.md".
-- Target: local Supabase (Postgres 17 + PostGIS) and AWS RDS Postgres 16/17 + PostGIS.

-- ─── Extensions ────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── Shared updated_at trigger ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3.1 Identity & roles
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.users (
  id                uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_e164        text UNIQUE,
  email             citext UNIQUE,
  display_name      text NOT NULL,
  role              text NOT NULL DEFAULT 'individual'
                    CHECK (role IN ('individual','corporate','agent','ops')),
  subscription_tier text NOT NULL DEFAULT 'lite'
                    CHECK (subscription_tier IN ('lite','pro')),
  country_code      text,
  kyc_status        text NOT NULL DEFAULT 'none'
                    CHECK (kyc_status IN ('none','pending','approved','rejected')),
  avatar_url        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX users_role_idx ON public.users(role) WHERE deleted_at IS NULL;
CREATE TRIGGER users_touch BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.corporate_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES public.users(id),
  company_name  text NOT NULL,
  billing_email citext NOT NULL,
  seat_limit    int  NOT NULL DEFAULT 5,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.corporate_members (
  corporate_id uuid REFERENCES public.corporate_accounts(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES public.users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('admin','member')),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (corporate_id, user_id)
);

-- Auto-provision a public.users row whenever a Supabase auth user is created.
-- Reads display_name/role/phone from auth metadata (set by client on sign-up).
CREATE OR REPLACE FUNCTION public.handle_new_auth_user() RETURNS trigger AS $$
BEGIN
  INSERT INTO public.users (id, phone_e164, email, display_name, role)
  VALUES (
    NEW.id,
    NEW.phone,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(COALESCE(NEW.email, NEW.phone, NEW.id::text), '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'role', 'individual')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3.2 Agents (KYC + deployment)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.agent_profiles (
  user_id             uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  psira_number        text UNIQUE,
  license_country     text NOT NULL,
  rating_avg          numeric(3,2) NOT NULL DEFAULT 0,
  jobs_completed      int NOT NULL DEFAULT 0,
  availability_status text NOT NULL DEFAULT 'offline'
                      CHECK (availability_status IN ('online','offline','on_job')),
  approved_by_ops     uuid REFERENCES public.users(id),
  approved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER agent_profiles_touch BEFORE UPDATE ON public.agent_profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.agent_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  doc_type    text NOT NULL CHECK (doc_type IN
              ('id','psira','firearm_license','driving_license','vehicle_reg','selfie')),
  r2_key      text NOT NULL,
  mime_type   text NOT NULL,
  reviewed_at timestamptz,
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','approved','rejected')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_documents_user_idx ON public.agent_documents(user_id);

CREATE TABLE public.agent_coverage_zones (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  zone       geography(Polygon, 4326) NOT NULL,
  label      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_zones_gix ON public.agent_coverage_zones USING GIST (zone);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3.3 Bookings (VBG Lite + Pro)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.bookings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id  uuid NOT NULL REFERENCES public.users(id),
  corporate_id    uuid REFERENCES public.corporate_accounts(id),
  booking_type    text NOT NULL CHECK (booking_type IN ('transfer','timeslot','itinerary')),
  tier            text NOT NULL CHECK (tier IN ('lite','pro')),
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','confirmed','in_progress','completed','cancelled')),
  pickup_point    geography(Point, 4326),
  dropoff_point   geography(Point, 4326),
  start_at        timestamptz NOT NULL,
  end_at          timestamptz,
  price_cents     int NOT NULL,
  currency        char(3) NOT NULL DEFAULT 'USD',
  payment_status  text NOT NULL DEFAULT 'unpaid'
                  CHECK (payment_status IN ('unpaid','paid','refunded','failed')),
  notes           text,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bookings_client_idx   ON public.bookings(client_user_id, start_at DESC);
CREATE INDEX bookings_pickup_gix   ON public.bookings USING GIST (pickup_point);
CREATE INDEX bookings_active_start ON public.bookings(start_at)
  WHERE status IN ('confirmed','in_progress');
CREATE TRIGGER bookings_touch BEFORE UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.booking_addons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  code        text NOT NULL,
  price_cents int  NOT NULL
);
CREATE INDEX booking_addons_booking_idx ON public.booking_addons(booking_id);

CREATE TABLE public.booking_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  agent_id    uuid NOT NULL REFERENCES public.users(id),
  role        text NOT NULL DEFAULT 'primary'
              CHECK (role IN ('primary','secondary','driver')),
  accepted_at timestamptz,
  UNIQUE (booking_id, agent_id)
);

CREATE TABLE public.itineraries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id     uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  raw_text       text NOT NULL,
  parsed_payload jsonb NOT NULL,
  risk_score     numeric(3,2),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3.4 Agent marketplace
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.jobs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id     uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  broadcast_area geography(Polygon, 4326) NOT NULL,
  status         text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','assigned','expired','cancelled')),
  payout_cents   int  NOT NULL,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_area_gix ON public.jobs USING GIST (broadcast_area);
CREATE INDEX jobs_open_idx ON public.jobs(expires_at) WHERE status = 'open';

CREATE TABLE public.job_applications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  agent_id   uuid NOT NULL REFERENCES public.users(id),
  status     text NOT NULL DEFAULT 'applied'
             CHECK (status IN ('applied','accepted','rejected','withdrawn')),
  applied_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, agent_id)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3.5 Live operations (GPS + SOS)
-- ═══════════════════════════════════════════════════════════════════════════

-- Partitioned by recorded_at. A DEFAULT partition catches all rows until
-- pg_partman (or equivalent) takes over in production.
CREATE TABLE public.gps_pings (
  id          bigserial,
  booking_id  uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  agent_id    uuid NOT NULL REFERENCES public.users(id),
  point       geography(Point, 4326) NOT NULL,
  speed_kmh   numeric(5,2),
  heading     numeric(5,2),
  battery     smallint,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);

CREATE TABLE public.gps_pings_default PARTITION OF public.gps_pings DEFAULT;
CREATE INDEX gps_pings_booking_idx ON public.gps_pings (booking_id, recorded_at DESC);
CREATE INDEX gps_pings_gix         ON public.gps_pings USING GIST (point);

CREATE TABLE public.sos_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.users(id),
  booking_id   uuid REFERENCES public.bookings(id),
  triggered_at timestamptz NOT NULL DEFAULT now(),
  location     geography(Point, 4326),
  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','acknowledged','resolved','false_alarm')),
  resolved_by  uuid REFERENCES public.users(id),
  resolved_at  timestamptz,
  payload      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX sos_active_idx ON public.sos_events(triggered_at DESC) WHERE status = 'active';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3.6 Messenger (E2E — server is blind)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('direct','group')),
  title      text,
  created_by uuid NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.conversation_members (
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES public.users(id) ON DELETE CASCADE,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  role            text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE public.signal_identities (
  user_id           uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  registration_id   int  NOT NULL,
  identity_key      bytea NOT NULL,
  signed_prekey_id  int  NOT NULL,
  signed_prekey     bytea NOT NULL,
  signed_prekey_sig bytea NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER signal_identities_touch BEFORE UPDATE ON public.signal_identities
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.signal_one_time_prekeys (
  user_id    uuid REFERENCES public.users(id) ON DELETE CASCADE,
  key_id     int  NOT NULL,
  public_key bytea NOT NULL,
  PRIMARY KEY (user_id, key_id)
);

CREATE TABLE public.message_envelopes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id       uuid NOT NULL REFERENCES public.users(id),
  recipient_id    uuid NOT NULL REFERENCES public.users(id),
  ciphertext      bytea NOT NULL,
  ciphertext_type smallint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);
CREATE INDEX envelopes_recipient_idx ON public.message_envelopes(recipient_id, created_at)
  WHERE delivered_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3.7 Vault (R2-backed encrypted files)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.vault_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  r2_key        text NOT NULL,
  encrypted_dek bytea NOT NULL,
  filename      text NOT NULL,
  byte_size     bigint NOT NULL,
  mime_type     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz
);
CREATE INDEX vault_owner_idx ON public.vault_items(owner_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3.8 Wallet & payouts
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.wallets (
  user_id       uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  balance_cents int  NOT NULL DEFAULT 0,
  currency      char(3) NOT NULL DEFAULT 'USD',
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER wallets_touch BEFORE UPDATE ON public.wallets
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.wallet_transactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.users(id),
  kind         text NOT NULL CHECK (kind IN
               ('topup','booking_charge','booking_refund','agent_payout','adjustment')),
  amount_cents int  NOT NULL,
  booking_id   uuid REFERENCES public.bookings(id),
  external_ref text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_tx_user_idx ON public.wallet_transactions(user_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3.9 News / Intel feed
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.intel_sources (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name   text NOT NULL,
  kind   text NOT NULL CHECK (kind IN ('guardian','google_news','internal')),
  config jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE public.intel_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id    uuid NOT NULL REFERENCES public.intel_sources(id),
  external_id  text NOT NULL,
  title        text NOT NULL,
  summary      text,
  url          text NOT NULL,
  location     geography(Point, 4326),
  severity     text CHECK (severity IN ('info','advisory','warning','critical')),
  published_at timestamptz NOT NULL,
  fts          tsvector GENERATED ALWAYS AS (
                 to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,''))
               ) STORED,
  UNIQUE (source_id, external_id)
);
CREATE INDEX intel_gix     ON public.intel_items USING GIST (location);
CREATE INDEX intel_fts_idx ON public.intel_items USING GIN  (fts);
CREATE INDEX intel_pub_idx ON public.intel_items (published_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3.10 Audit log
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.audit_events (
  id         bigserial PRIMARY KEY,
  actor_id   uuid REFERENCES public.users(id),
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  uuid,
  ip         inet,
  payload    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON public.audit_events(entity, entity_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- Row-Level Security
-- ═══════════════════════════════════════════════════════════════════════════
-- Per the doc: "Row-level security is OFF — authorization lives in the API layer."
-- Local dev uses supabase-js with the anon key, so we enable permissive RLS
-- only on tables the mobile app touches directly today. The API service_role
-- bypasses RLS entirely once apps/api is online.

ALTER TABLE public.users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_transactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_profiles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_documents      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vault_items          ENABLE ROW LEVEL SECURITY;

-- users: a signed-in user can read / update their own row.
CREATE POLICY users_self_read  ON public.users
  FOR SELECT USING (auth.uid() = id);
CREATE POLICY users_self_write ON public.users
  FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

CREATE POLICY wallets_owner    ON public.wallets
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY wallet_tx_owner  ON public.wallet_transactions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY bookings_owner   ON public.bookings
  FOR ALL USING (auth.uid() = client_user_id) WITH CHECK (auth.uid() = client_user_id);

CREATE POLICY agent_profile_self ON public.agent_profiles
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY agent_docs_self    ON public.agent_documents
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY vault_owner        ON public.vault_items
  FOR ALL USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);

CREATE POLICY conversations_member ON public.conversations
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.conversation_members m
            WHERE m.conversation_id = id AND m.user_id = auth.uid())
  );

CREATE POLICY conversation_members_self ON public.conversation_members
  FOR SELECT USING (user_id = auth.uid());
