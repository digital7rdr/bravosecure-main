# Bravo Secure — Monorepo & DB Schema Setup

> Phase 1 setup guide. Target stack: pnpm + Turborepo workspace, Node.js/TypeScript modular monolith backend, React Native bare CLI app, PostgreSQL 16 + PostGIS on AWS RDS (Mumbai primary, London replica).

---

## 1. Monorepo Layout

### 1.1 Why a monorepo

- Share **types, validation schemas, and API contracts** between the RN app and the backend (avoids "drifted DTO" bugs).
- One `pnpm install`, one CI pipeline, atomic cross-cutting commits (e.g. add a booking field in DB → API → mobile in one PR).
- Turborepo caches builds + lints per package — keeps CI under ~3 min as the team grows.

### 1.2 Target directory structure

```
bravo-secure/
├── apps/
│   ├── mobile/                 # React Native (current `src/`, `android/`, `ios/`)
│   │   ├── src/
│   │   ├── android/
│   │   ├── ios/
│   │   ├── app.json
│   │   └── package.json
│   │
│   └── api/                    # Node.js/TS modular monolith — api.bravosecure.com
│       ├── src/
│       │   ├── modules/
│       │   │   ├── auth/       # Supabase JWT validation
│       │   │   ├── bookings/   # VBG Lite + Pro
│       │   │   ├── agents/     # KYC, marketplace, earnings
│       │   │   ├── messenger/  # E2E relay + key bundles
│       │   │   ├── vault/      # R2 presigned URLs
│       │   │   ├── liveops/    # GPS, SOS, tracking
│       │   │   ├── news/       # Intel feed ingestion
│       │   │   ├── wallet/     # Credits, payouts
│       │   │   └── ai/         # Itinerary parsing
│       │   ├── db/             # Drizzle client + migrations
│       │   ├── queue/          # Redis/BullMQ workers
│       │   ├── lib/            # errors, logging, config
│       │   └── server.ts
│       ├── drizzle.config.ts
│       └── package.json
│
├── packages/
│   ├── shared-types/           # Domain types + Zod schemas (User, Booking, Agent, Job, Message, …)
│   ├── api-contracts/          # Request/response DTOs — consumed by mobile Axios client
│   ├── config-eslint/          # Shared ESLint preset
│   ├── config-tsconfig/        # Base tsconfig.base.json
│   └── crypto/                 # libsignal helpers shared by mobile + API (key-bundle shape)
│
├── infra/
│   ├── docker/                 # Dockerfile.api, docker-compose.prod.yml, coturn/
│   ├── terraform/              # RDS, ElastiCache, R2, Secrets Manager
│   └── github-actions/         # reusable workflows
│
├── worldmonitor/               # unrelated — keep as-is, NOT a workspace member
│
├── package.json                # root — workspaces + turbo
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.base.json
```

> **Migration note:** existing `src/`, `android/`, `ios/`, `index.js`, `App.tsx` move under `apps/mobile/`. Update `react-native.config.js`, Metro `projectRoot`, and Gradle `rootProject.projectDir` accordingly. `worldmonitor/` stays at the root but is **excluded** from `pnpm-workspace.yaml`.

### 1.3 Root files

**`pnpm-workspace.yaml`**

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

**`turbo.json`** (key pipeline)

```json
{
  "$schema": "https://turbo.build/schema.json",
  "pipeline": {
    "build": {"dependsOn": ["^build"], "outputs": ["dist/**"]},
    "lint": {"dependsOn": ["^build"]},
    "typecheck": {"dependsOn": ["^build"]},
    "test": {"dependsOn": ["^build"]},
    "db:generate": {"cache": false},
    "db:migrate": {"cache": false, "persistent": false},
    "dev": {"cache": false, "persistent": true}
  }
}
```

**Root `package.json`**

```json
{
  "name": "bravo-secure",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "dev": "turbo run dev --parallel",
    "build": "turbo run build",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "db:migrate": "pnpm --filter @bravo/api db:migrate",
    "mobile": "pnpm --filter @bravo/mobile"
  },
  "devDependencies": {
    "turbo": "^2.1.0",
    "typescript": "^5.5.0"
  }
}
```

### 1.4 Shared packages conventions

- Every package publishes as `@bravo/<name>` (scope kept private, never to npm).
- `packages/shared-types` owns **Zod schemas**; TS types are `z.infer<>` — single source of truth.
- Mobile imports via `import { BookingSchema } from "@bravo/shared-types"`. API validates request bodies with the same schema. Drift becomes a compile error.

### 1.5 Bootstrap steps

```bash
# from repo root
corepack enable && corepack prepare pnpm@9.12.0 --activate
pnpm init -y
# create workspace files above
mkdir -p apps packages infra
git mv src App.tsx index.js android ios app.json react-native.config.js babel.config.js apps/mobile/
pnpm add -D turbo typescript -w
pnpm install
```

---

## 2. Database: PostgreSQL 16 + PostGIS

### 2.1 Local dev

**`infra/docker/docker-compose.dev.yml`**

```yaml
services:
  postgres:
    image: postgis/postgis:16-3.4
    environment:
      POSTGRES_USER: bravo
      POSTGRES_PASSWORD: bravo
      POSTGRES_DB: bravo_dev
    ports: ['5432:5432']
    volumes: ['pgdata:/var/lib/postgresql/data']

  redis:
    image: redis:7-alpine
    ports: ['6379:6379']

volumes:
  pgdata:
```

`pnpm db:up` → `docker compose -f infra/docker/docker-compose.dev.yml up -d`.

### 2.2 Migration tool — Drizzle ORM

Chosen over Prisma because:

- No runtime engine binary (smaller Docker images, no RDS proxy weirdness).
- Raw SQL migrations — PostGIS types, GIST indexes, `tsvector`, partial indexes all work without escape hatches.
- Zero-cost typed query builder; Zod schema inference via `drizzle-zod` pairs with `@bravo/shared-types`.

**`apps/api/drizzle.config.ts`**

```ts
import type {Config} from 'drizzle-kit';
export default {
  schema: './src/db/schema/*.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {url: process.env.DATABASE_URL!},
  strict: true,
  verbose: true,
} satisfies Config;
```

Scripts in `apps/api/package.json`:

```json
"db:generate": "drizzle-kit generate",
"db:migrate":  "tsx src/db/migrate.ts",
"db:studio":   "drizzle-kit studio"
```

### 2.3 Extensions (run once per env)

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;        -- case-insensitive emails/handles
CREATE EXTENSION IF NOT EXISTS pg_trgm;       -- fuzzy search on names
```

---

## 3. Phase 1 Schema (minimum viable)

Grouped by module. All tables use `id uuid primary key default gen_random_uuid()`, `created_at timestamptz default now()`, `updated_at timestamptz` (trigger-maintained).

### 3.1 Identity & roles

```sql
-- users: mirrors Supabase auth.users; backend is source of truth for profile
CREATE TABLE users (
  id                uuid PRIMARY KEY,              -- == supabase auth.users.id
  phone_e164        text UNIQUE NOT NULL,
  email             citext UNIQUE,
  display_name      text NOT NULL,
  role              text NOT NULL
                    CHECK (role IN ('individual','corporate','agent','ops')),
  subscription_tier text NOT NULL DEFAULT 'lite'
                    CHECK (subscription_tier IN ('lite','pro')),
  country_code      text,                          -- ISO-3166-1 alpha-2
  kyc_status        text NOT NULL DEFAULT 'none'
                    CHECK (kyc_status IN ('none','pending','approved','rejected')),
  avatar_url        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX users_role_idx ON users(role) WHERE deleted_at IS NULL;

CREATE TABLE corporate_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  company_name  text NOT NULL,
  billing_email citext NOT NULL,
  seat_limit    int  NOT NULL DEFAULT 5
);

CREATE TABLE corporate_members (
  corporate_id uuid REFERENCES corporate_accounts(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('admin','member')),
  PRIMARY KEY (corporate_id, user_id)
);
```

### 3.2 Agents (KYC + deployment)

```sql
CREATE TABLE agent_profiles (
  user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  psira_number        text UNIQUE,              -- SA regulator; null for non-SA
  license_country     text NOT NULL,
  rating_avg          numeric(3,2) NOT NULL DEFAULT 0,
  jobs_completed      int NOT NULL DEFAULT 0,
  availability_status text NOT NULL DEFAULT 'offline'
                      CHECK (availability_status IN ('online','offline','on_job')),
  approved_by_ops     uuid REFERENCES users(id),
  approved_at         timestamptz
);

CREATE TABLE agent_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type    text NOT NULL CHECK (doc_type IN
              ('id','psira','firearm_license','driving_license','vehicle_reg','selfie')),
  r2_key      text NOT NULL,                    -- Cloudflare R2 object key
  mime_type   text NOT NULL,
  reviewed_at timestamptz,
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','approved','rejected')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_coverage_zones (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  zone       geography(Polygon, 4326) NOT NULL,
  label      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_zones_gix ON agent_coverage_zones USING GIST (zone);
```

### 3.3 Bookings (VBG Lite + Pro)

```sql
CREATE TABLE bookings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id  uuid NOT NULL REFERENCES users(id),
  corporate_id    uuid REFERENCES corporate_accounts(id),
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
CREATE INDEX bookings_client_idx    ON bookings(client_user_id, start_at DESC);
CREATE INDEX bookings_pickup_gix    ON bookings USING GIST (pickup_point);
CREATE INDEX bookings_active_start  ON bookings(start_at)
  WHERE status IN ('confirmed','in_progress');

CREATE TABLE booking_addons (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  code       text NOT NULL,        -- e.g. 'armed_agent','discreet_vehicle'
  price_cents int NOT NULL
);

CREATE TABLE booking_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  agent_id    uuid NOT NULL REFERENCES users(id),
  role        text NOT NULL DEFAULT 'primary'
              CHECK (role IN ('primary','secondary','driver')),
  accepted_at timestamptz,
  UNIQUE (booking_id, agent_id)
);

-- Pro-tier itineraries (AI parsed)
CREATE TABLE itineraries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  raw_text        text NOT NULL,
  parsed_payload  jsonb NOT NULL,
  risk_score      numeric(3,2),
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

### 3.4 Agent marketplace (jobs)

```sql
CREATE TABLE jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  broadcast_area  geography(Polygon, 4326) NOT NULL,
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','assigned','expired','cancelled')),
  payout_cents    int NOT NULL,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_area_gix ON jobs USING GIST (broadcast_area);
CREATE INDEX jobs_open_idx ON jobs(expires_at) WHERE status = 'open';

CREATE TABLE job_applications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  agent_id   uuid NOT NULL REFERENCES users(id),
  status     text NOT NULL DEFAULT 'applied'
             CHECK (status IN ('applied','accepted','rejected','withdrawn')),
  applied_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, agent_id)
);
```

### 3.5 Live operations (GPS + SOS)

```sql
-- Hot table; partitioned daily. Phase 2 → TimescaleDB hypertable.
CREATE TABLE gps_pings (
  id         bigserial,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  agent_id   uuid NOT NULL REFERENCES users(id),
  point      geography(Point, 4326) NOT NULL,
  speed_kmh  numeric(5,2),
  heading    numeric(5,2),
  battery    smallint,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);
CREATE INDEX gps_pings_booking_idx ON gps_pings (booking_id, recorded_at DESC);
CREATE INDEX gps_pings_gix         ON gps_pings USING GIST (point);

CREATE TABLE sos_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  booking_id    uuid REFERENCES bookings(id),
  triggered_at  timestamptz NOT NULL DEFAULT now(),
  location      geography(Point, 4326),
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','acknowledged','resolved','false_alarm')),
  resolved_by   uuid REFERENCES users(id),
  resolved_at   timestamptz,
  payload       jsonb NOT NULL DEFAULT '{}'  -- audio clip ref, photo refs
);
CREATE INDEX sos_active_idx ON sos_events(triggered_at DESC) WHERE status = 'active';
```

### 3.6 Messenger (E2E — server is blind)

Server stores ciphertext envelopes and key bundles only; never plaintext.

```sql
CREATE TABLE conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('direct','group')),
  title       text,                            -- null for direct
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation_members (
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  role            text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  PRIMARY KEY (conversation_id, user_id)
);

-- Signal-style prekey bundles per device
CREATE TABLE signal_identities (
  user_id           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  registration_id   int  NOT NULL,
  identity_key      bytea NOT NULL,
  signed_prekey_id  int  NOT NULL,
  signed_prekey     bytea NOT NULL,
  signed_prekey_sig bytea NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE signal_one_time_prekeys (
  user_id   uuid REFERENCES users(id) ON DELETE CASCADE,
  key_id    int  NOT NULL,
  public_key bytea NOT NULL,
  PRIMARY KEY (user_id, key_id)
);

-- Encrypted envelope; deleted after delivery (relay, not store).
CREATE TABLE message_envelopes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        uuid NOT NULL REFERENCES users(id),
  recipient_id     uuid NOT NULL REFERENCES users(id),
  ciphertext       bytea NOT NULL,
  ciphertext_type  smallint NOT NULL,      -- signal message type
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz
);
CREATE INDEX envelopes_recipient_idx ON message_envelopes(recipient_id, created_at)
  WHERE delivered_at IS NULL;
```

### 3.7 Vault (R2-backed encrypted files)

```sql
CREATE TABLE vault_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key       text NOT NULL,
  encrypted_dek bytea NOT NULL,             -- per-item data-encryption key, wrapped
  filename     text NOT NULL,
  byte_size    bigint NOT NULL,
  mime_type    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz                  -- burn-after
);
CREATE INDEX vault_owner_idx ON vault_items(owner_id, created_at DESC);
```

### 3.8 Wallet & payouts

```sql
CREATE TABLE wallets (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_cents int NOT NULL DEFAULT 0,
  currency      char(3) NOT NULL DEFAULT 'USD',
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallet_transactions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL CHECK (kind IN
              ('topup','booking_charge','booking_refund','agent_payout','adjustment')),
  amount_cents int NOT NULL,                -- signed: +credit / -debit
  booking_id   uuid REFERENCES bookings(id),
  external_ref text,                         -- Stripe/gateway id
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_tx_user_idx ON wallet_transactions(user_id, created_at DESC);
```

### 3.9 News / Intel feed

```sql
CREATE TABLE intel_sources (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('guardian','google_news','internal')),
  config jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE intel_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   uuid NOT NULL REFERENCES intel_sources(id),
  external_id text NOT NULL,
  title       text NOT NULL,
  summary     text,
  url         text NOT NULL,
  location    geography(Point, 4326),
  severity    text CHECK (severity IN ('info','advisory','warning','critical')),
  published_at timestamptz NOT NULL,
  fts         tsvector GENERATED ALWAYS AS (
                to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,''))
              ) STORED,
  UNIQUE (source_id, external_id)
);
CREATE INDEX intel_gix     ON intel_items USING GIST (location);
CREATE INDEX intel_fts_idx ON intel_items USING GIN  (fts);
CREATE INDEX intel_pub_idx ON intel_items (published_at DESC);
```

### 3.10 Audit log

```sql
CREATE TABLE audit_events (
  id         bigserial PRIMARY KEY,
  actor_id   uuid REFERENCES users(id),
  action     text NOT NULL,                 -- e.g. 'booking.create', 'agent.approve'
  entity     text NOT NULL,
  entity_id  uuid,
  ip         inet,
  payload    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_events(entity, entity_id);
```

---

## 4. Conventions

- **UUIDs everywhere** (no sequential IDs leaking counts to attackers).
- **Money in cents (`int`)** — never `float`. `currency char(3)` alongside.
- **Geo** — always `geography(_, 4326)` + GIST index; use meters for distance queries.
- **Soft delete** only on `users` (`deleted_at`). Everything else is hard-delete or status-field.
- **`updated_at`** maintained by a single trigger:
  ```sql
  CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
  BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;
  ```
  Attach to every table with an `updated_at` column.
- **Row-level security** is OFF — authorization lives in the API layer (JWT → Zod → Drizzle query). RLS re-evaluated in Phase 2 if we expose PostgREST.

---

## 5. Migration workflow

1. Edit a schema file in `apps/api/src/db/schema/*.ts`.
2. `pnpm --filter @bravo/api db:generate` → Drizzle writes a SQL file to `src/db/migrations/`.
3. Commit the generated SQL **together with** the schema change (reviewers read SQL, not TS DSL).
4. CI runs `db:migrate` against an ephemeral Postgres container + executes integration tests.
5. Prod rollout: GitHub Actions job runs `db:migrate` against RDS **before** the new API container goes live (blue-green).

Never edit an applied migration — append a new one.

---

## 6. Seed & fixtures

- `apps/api/src/db/seed.ts` — idempotent, creates: 1 ops user, 2 agents (approved), 3 individual clients, 1 corporate, 5 bookings across statuses, 10 intel items.
- Mobile dev builds point at `http://10.0.2.2:3000` (Android emulator) / `http://localhost:3000` (iOS sim) with the seeded JWT baked into a `.env.development`.

---

## 7. Checklist to "monorepo-ready"

- [ ] `pnpm-workspace.yaml`, `turbo.json`, root `package.json` committed
- [ ] `src/`, `App.tsx`, `index.js`, `android/`, `ios/` moved to `apps/mobile/`
- [ ] `apps/api/` scaffolded with Fastify + Drizzle + BullMQ
- [ ] `packages/shared-types` exports Zod schemas; mobile + api both consume
- [ ] `infra/docker/docker-compose.dev.yml` brings up Postgres + Redis
- [ ] Drizzle migrations for sections 3.1–3.10 generated & applied locally
- [ ] Seed script runs clean on an empty DB
- [ ] CI runs `turbo run lint typecheck test build` in under 5 min
- [ ] `worldmonitor/` explicitly excluded from workspace globs
