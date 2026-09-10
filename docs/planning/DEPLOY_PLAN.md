# Staging Deploy Plan — Phases 0–5

**Audit reference:** Bravo Lite + Ops Dashboard Audit Tracker (closed Phases 0–5 in this branch)
**Created:** 2026-05-12
**Branch under deploy:** `main`
**Target staging:**

- **Supabase:** `https://qkkfkicgoncxslbwhyhz.supabase.co`
- **Auth-service:** `https://auth.94-136-184-52.sslip.io` (EC2 `13.126.64.19`)
- **Messenger-service:** `https://relay.94-136-184-52.sslip.io` (same host)
- **Ops-console:** TBD — Vercel target not configured yet
- **Mobile:** EAS `preview-staging` channel

This document is the working plan, not a wiki. It tracks every staging touch needed to make the audit fixes real.

---

## A. Current infrastructure state (audited from repo)

| Surface           | Where it lives                     | Deploy mechanism today                         | Gap                                        |
| ----------------- | ---------------------------------- | ---------------------------------------------- | ------------------------------------------ |
| Supabase Postgres | `qkkfkicgoncxslbwhyhz.supabase.co` | `supabase db push` from CLI (manual)           | No CI workflow; 3 new migrations unapplied |
| Auth-service      | EC2 `13.126.64.19` behind sslip.io | Unknown — no Dockerfile committed              | No reproducible build; manual SSH likely   |
| Messenger-service | Same EC2                           | `apps/messenger-service/Dockerfile` exists     | No CI build/push                           |
| Ops-console       | Not deployed anywhere visible      | None                                           | Needs Vercel project + env wiring          |
| Mobile (RN/Expo)  | EAS `preview-staging` channel      | `eas build --profile preview-staging` (manual) | Works but manual; no CI trigger            |

The single hot mess: **no Dockerfile for `apps/auth-service`** and **no GitHub Actions deploy workflows**. Every deploy today is manual SSH or local-machine `supabase db push`. That's where most of this plan focuses.

---

## B. Outstanding deploy-time work, ordered by dependency

### B.1 — Migrations (Supabase)

Three new migrations introduced by Phases 2 and 4 are unapplied in staging:

1. `supabase/migrations/20260509000000_phase1_concurrency.sql` — unique indexes, mission_crew partial unique
2. `supabase/migrations/20260509100000_phase2_data_integrity.sql` — `ops_audit` triggers + CHECKs, FSM triggers, FKs (NOT VALID), demo-admin cleanup
3. `supabase/migrations/20260512000000_phase4_audit_subject_types.sql` — extends `ops_audit.subject_type` to admit `'pii'` and `'conversation'`

**Deploy step:** `supabase db push` from a CI job with the project link configured.

**Post-deploy:** the Phase 2 migration adds FKs with `NOT VALID`. After confirming no orphans, run the VALIDATE step (annotated in the tracker under 2.2). The four ALTER statements are catalog-only on already-valid rows.

### B.2 — Auth-service container

A reproducible image is needed before CI can deploy. Today there's no `apps/auth-service/Dockerfile` — only the messenger has one.

**Deliverables in this plan:**

- `apps/auth-service/Dockerfile` (multi-stage build, node:20-alpine)
- `.github/workflows/deploy-auth.yml` builds + pushes to ECR (or DockerHub) on `main` push
- EC2 host pulls + restarts via systemd unit (or use ECS once we move there)

### B.3 — Messenger-service container

`apps/messenger-service/Dockerfile` already exists. Needs a CI workflow to build + push on `main` push.

**Note for both backend services:** Phase 5.1 added a Redis pub/sub channel `mission:events`. The messenger-service subscribes via a duplicated ioredis connection. Confirm the staging Redis instance is the same one both services point at, and the URL is set in both `REDIS_URL`.

### B.4 — Ops-console (Vercel)

The audit closed Phase 4 against the ops-console but it has no deploy target. Two options:

1. **Recommended:** Create a Vercel project `bravo-ops-staging`, link to the GitHub repo, scope deploys to `apps/ops-console/`, set the `NEXT_PUBLIC_API_BASE_URL` env to `https://auth.94-136-184-52.sslip.io`. Vercel handles preview + production deploys automatically.
2. Static export + S3/CloudFront. Cheaper, but loses middleware (the audit's 4.1 silent-refresh + idle-timeout relies on Next.js middleware running per-request).

**Pick option 1.** The audit's 0.5 (edge auth on Next.js) explicitly requires middleware.

### B.5 — Mobile (EAS)

Build pipeline exists. What's missing for the Phase 4–5 changes:

- **Sentry**: install `@sentry/react-native`, run the wizard, set `EXPO_PUBLIC_SENTRY_DSN` in EAS env (per profile). Shim auto-detects.
- **EAS env additions** (verify present):
  - `EXPO_PUBLIC_API_BASE_URL` ✓ already set
  - `EXPO_PUBLIC_MSG_BASE_URL` ✓ already set
  - `EXPO_PUBLIC_SENTRY_DSN` ✗ needs adding
  - `EXPO_PUBLIC_MAPBOX_TOKEN` — verify in `preview-staging` profile

Build: `eas build --profile preview-staging --platform all`.

### B.6 — Sentry org + DSNs

The audit's 5.4 shim looks for `SENTRY_DSN` (auth-service) and `EXPO_PUBLIC_SENTRY_DSN` (mobile). The shims no-op without DSNs, so nothing breaks if they're absent — but the audit-failure alert path is the whole point.

**Pre-deploy step:** create the Sentry org / project, drop DSNs into:

- EC2 systemd env for auth-service (`SENTRY_DSN=…`)
- EAS env for `preview-staging` profile (`EXPO_PUBLIC_SENTRY_DSN=…`)

Then `npm install @sentry/node` in `apps/auth-service` and `@sentry/react-native` at repo root. Both shims dynamic-require so the SDK install is the only thing that flips them on.

### B.7 — Testcontainers integration tests in CI

The Phase 5.5 itests need Docker. Add a `test-integration` job to `.github/workflows/ci.yml` running on the same runner — GitHub-hosted ubuntu has Docker. Don't gate `main` merges on it yet (slow + flaky boot); run on PR label `run-integration` for now.

---

## C. CI workflows to add

### C.1 — `.github/workflows/deploy-migrations.yml`

```yaml
name: Deploy Supabase migrations
on:
  push:
    branches: [main]
    paths: ['supabase/migrations/**']
  workflow_dispatch:

jobs:
  push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - run: supabase link --project-ref qkkfkicgoncxslbwhyhz
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
      - run: supabase db push --include-all
        env:
          SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
```

Required secrets: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`.

### C.2 — `.github/workflows/deploy-auth.yml`

Multi-stage Docker build → push to ECR → SSH into EC2 → pull + restart systemd unit.

```yaml
name: Deploy auth-service
on:
  push:
    branches: [main]
    paths: ['apps/auth-service/**', '.github/workflows/deploy-auth.yml']
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-region: ap-south-1
          aws-access-key-id: ${{ secrets.AWS_DEPLOY_KEY }}
          aws-secret-access-key: ${{ secrets.AWS_DEPLOY_SECRET }}
      - uses: aws-actions/amazon-ecr-login@v2
      - run: |
          docker build -f apps/auth-service/Dockerfile -t $ECR_REPO:${{ github.sha }} .
          docker push $ECR_REPO:${{ github.sha }}
        env:
          ECR_REPO: ${{ secrets.ECR_AUTH_REPO }}
      - uses: appleboy/ssh-action@v1
        with:
          host: 13.126.64.19
          username: ubuntu
          key: ${{ secrets.EC2_SSH_KEY }}
          script: |
            docker pull $ECR_AUTH_REPO:${{ github.sha }}
            sudo systemctl restart bravo-auth.service
```

Required secrets: `AWS_DEPLOY_KEY`, `AWS_DEPLOY_SECRET`, `ECR_AUTH_REPO`, `EC2_SSH_KEY`.

### C.3 — `.github/workflows/deploy-messenger.yml`

Identical shape to C.2; replace paths + image + service unit.

### C.4 — `.github/workflows/deploy-ops-console.yml`

Vercel does this automatically once the project is linked. The only repo-side bit is the project config:

```jsonc
// apps/ops-console/vercel.json — for the Vercel project
{
  "buildCommand": "npm run build",
  "outputDirectory": ".next",
  "framework": "nextjs",
  "installCommand": "npm install --prefix ../.. --legacy-peer-deps && npm install",
}
```

### C.5 — `.github/workflows/build-mobile.yml`

```yaml
name: Build mobile (EAS)
on:
  workflow_dispatch:
  push:
    branches: [main]
    paths: ['src/**', 'App.tsx', 'app.config.ts', 'eas.json']

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci --legacy-peer-deps
      - run: npx eas-cli build --profile preview-staging --platform all --non-interactive --no-wait
        env:
          EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}
```

Required secret: `EXPO_TOKEN`.

---

## D. Required Dockerfile (auth-service)

Create `apps/auth-service/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.6
FROM node:20-alpine AS builder
WORKDIR /app
COPY apps/auth-service/package*.json ./
RUN npm ci --legacy-peer-deps
COPY apps/auth-service/ ./
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
EXPOSE 3001
CMD ["node", "dist/main.js"]
```

The messenger-service Dockerfile already exists. Audit it for parity before deploy.

---

## E. Environment variable checklist (staging)

### auth-service

```
DATABASE_URL=postgresql://… (Supabase pooler URL)
REDIS_URL=redis://… (Phase 5.1 mission:events depends on this matching messenger-service)
JWT_ACCESS_SECRET=… (shared with messenger-service)
JWT_REFRESH_TTL=30d (Phase 4.1)
STRICT_VALIDATION=true (Phase 1.4; flip after confirming no 400 spike)
CORS_ALLOWED_ORIGINS=https://ops-staging.bravosecure.app (Phase 1.6)
NODE_ENV=production
SENTRY_DSN=… (Phase 5.4)
SENTRY_TRACES_SAMPLE_RATE=0.05
TWILIO_… (existing)
STRIPE_… (existing)
```

### messenger-service

```
DATABASE_URL=… (or postgres-less if it doesn't need pg)
REDIS_URL=… (same instance as auth-service for mission:events)
JWT_ACCESS_SECRET=… (must match auth-service)
SENDER_CERT_PRIVATE_KEY_B64=…
NODE_ENV=production
SENTRY_DSN=… (optional, same project)
```

### ops-console (Vercel env)

```
NEXT_PUBLIC_API_BASE_URL=https://auth.94-136-184-52.sslip.io
NEXT_PUBLIC_MAPBOX_TOKEN=… (URL-restricted to ops-staging.bravosecure.app per Phase 4.5)
NODE_ENV=production
```

### mobile (EAS profile `preview-staging`)

Already set; add:

```
EXPO_PUBLIC_SENTRY_DSN=…
```

---

## F. Deploy-time smoke tests (the 5 Phase-0/3/5 staging checks)

After every full deploy, run these. They're already documented in the audit tracker with exact commands; reproducing here for one-page reference:

### F.1 — 0.1: admin self-registration disabled

```sh
curl -sS -i -X POST https://auth.94-136-184-52.sslip.io/auth/admin-register/verify \
  -H 'content-type: application/json' \
  -d '{"email":"x@y.com","otp":"000000","role":"ADMIN","password":"P@ssword1!"}'
# Expect: HTTP/1.1 403  body {"message":"admin_self_registration_disabled"}
```

### F.2 — 0.3: PENDING_OPS booking detail renders

Manual — open any PENDING_OPS booking on the ops-console staging URL; click "Approve"; verify the modal opens and posts.

### F.3 — 0.5: middleware redirect

```sh
curl -sS -i --max-redirs 0 https://ops-staging.bravosecure.app/dashboard
# Expect: HTTP/2 307  location: /login?next=%2Fdashboard
```

### F.4 — 0.6: security headers

```sh
curl -sS -I https://ops-staging.bravosecure.app/login | grep -iE \
  'strict-transport-security|x-frame-options|x-content-type-options|referrer-policy|permissions-policy|content-security-policy'
# Expect: HSTS, X-Frame-Options DENY, nosniff, no-referrer,
# Permissions-Policy camera=() microphone=() geolocation=(),
# CSP with `'nonce-…'` instead of `'unsafe-inline'` on script-src.
```

### F.5 — 2.2: FK VALIDATE post-deploy

After confirming no orphans (via a quick `SELECT COUNT(*)` against the four tables):

```sql
ALTER TABLE mission_crew     VALIDATE CONSTRAINT mission_crew_agent_id_fk;
ALTER TABLE job_applications VALIDATE CONSTRAINT job_applications_agent_id_fk;
ALTER TABLE sos_events       VALIDATE CONSTRAINT sos_events_mission_id_fk;
ALTER TABLE admin_users      VALIDATE CONSTRAINT admin_users_user_id_fk;
```

Brief table-level locks; run in a low-traffic window.

---

## G. Order of operations

1. **(prep)** Create Sentry org + projects, capture DSNs.
2. **(prep)** Create Vercel project `bravo-ops-staging`, link to repo, set env.
3. **(repo)** Land this `DEPLOY_PLAN.md` + the auth-service Dockerfile + the 5 GitHub Actions workflows under `.github/workflows/`.
4. **(secrets)** Add the GitHub repo secrets listed in section C.
5. **(deploy)** Merge to `main`. The migrations workflow + backend deploy workflows fire automatically. Mobile build fires too.
6. **(verify)** Run section F smoke tests.
7. **(close)** Re-run the Phase 2.2 FK VALIDATE step against the live DB. Mark the 5 tracker QA items as closed.

---

## H. What I'm NOT doing in this plan

- **No prod deploy.** Staging only. Prod requires a second audit pass + sign-off.
- **No infra-as-code migration.** The EC2 host stays manually managed for now. Long-term: move both backend services to ECS Fargate or App Runner so the deploy workflow doesn't need SSH.
- **No DB rollback automation.** Supabase migrations are forward-only here. A rollback is `supabase db reset --linked` against staging + re-push from an older commit. Treat with caution.
- **No load test.** The Phase 5.1 WS channel ought to be load-tested before prod (1k concurrent mission subscriptions); deferred.
- **No actual `@sentry/node` install.** I added the shim that lazily requires the SDK. Installing the package is a one-line `npm install` once the DSN is provisioned.
- **No mobile store submit.** EAS builds produce APK/IPA; submission to Play/App Store stays a separate manual step.
