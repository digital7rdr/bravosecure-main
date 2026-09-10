# 2. Code Architecture & Application Flow

**Bravo Secure — Technical Code & System Handover, Section 2**

|                   |                                                                           |
| ----------------- | ------------------------------------------------------------------------- |
| **Document**      | Code Architecture & Application Flow                                      |
| **Covers**        | Handover checklist §2, items 1–12 + the required end-to-end demonstration |
| **Scope**         | Self-contained — every fact needed for §2 is stated here, not linked out  |
| **Source commit** | `b38e42ea` (branch `main`)                                                |
| **Prepared**      | 2026-08-22                                                                |

> **How this document was produced.** Every module name, route prefix, guard, TTL,
> state name and file path below was read out of the working tree at commit
> `b38e42ea`. Counts were produced by scanning the source, not estimated. Where a
> behaviour is non-obvious the document names the file that implements it so the
> claim can be re-checked; **symbol names are the durable anchor — re-grep the
> symbol rather than trusting a line number**, which moves with every commit.

---

## 2.1 Overall application architecture

Bravo Secure is a **four-surface, two-backend system** in one repository. There is
no npm workspace linkage — the surfaces are joined by TypeScript path aliases and
each backend has its own `package.json`.

```
   ┌───────────────────────────┐                       ┌───────────────────────────┐
   │  MOBILE  (React Native)   │                       │  OPS CONSOLE  (Next.js)   │
   │  src/ · App.tsx           │                       │  apps/ops-console/        │
   │  clients · agencies · CPOs│                       │  HQ operators             │
   └────────┬──────────┬───────┘                       └───────┬───────────┬───────┘
            │          │                                       │           │
            │          └──────────────┐         ┌──────────────┘           │
            │                         ▼         ▼                          │
            │            ┌────────────────────────────────┐                │
            │            │   packages/messenger-core      │                │
            │            │   libsignal · sealed-sender v2 │                │
            │            │   group crypto · wire types    │                │
            │            └────────────────────────────────┘                │
            │                                                              │
            ▼                                                              ▼
 ┌────────────────────────────────────┐   Redis pub/sub   ┌────────────────────────────────────┐
 │  apps/auth-service        :3001    │◀─────────────────▶│  apps/messenger-service     :3100  │
 │  NestJS 10 · Express · pg          │  push:events      │  NestJS 10 · socket.io · Redis     │
 │                                    │  dispatch:*       │                                    │
 │  auth · bookings · dispatch        │  jti:<jti>        │  relay (transient envelopes)       │
 │  missions · wallet/escrow          │                   │  WS gateway (presence/typing/calls)│
 │  agents · orgs · departments       │                   │  file vault (MFA-gated)            │
 │  /ops/* console API · VBG          │                   │  mediasoup SFU · FCM push          │
 └────────────────┬───────────────────┘                   └──────────────────┬─────────────────┘
                  │                                                          │
                  ▼                                                          ▼
        ┌───────────────────┐                                    ┌───────────────────────┐
        │  PostgreSQL 17.6  │                                    │  Redis · S3 storage   │
        │  (Supabase) 103   │                                    │  transient + presence │
        │  103 tables       │                                    │  + object storage     │
        └───────────────────┘                                    └───────────────────────┘
```

### Surface inventory

| Surface               | Path                       | Stack                                                     | Size (`.ts`/`.tsx`)    | Role                                                                     |
| --------------------- | -------------------------- | --------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------ |
| **Mobile**            | `src/`, `App.tsx`          | RN 0.81.5 · Expo SDK 54 · React 19.1 · TS 5.9 · Zustand 5 | **1,426** files        | The product. Clients, agency operators, CPOs — three shells, one binary. |
| **Ops Console**       | `apps/ops-console/`        | Next.js 15.5.20 App Router · React 19 · SWR · Tailwind    | **73** files, 35 pages | HQ operator dashboard — dispatch, live map, finance, compliance.         |
| **Auth service**      | `apps/auth-service/`       | NestJS 10 · `pg` · `ioredis` · `jose` · `argon2`          | **393** files          | The business API. Postgres is its database.                              |
| **Messenger service** | `apps/messenger-service/`  | NestJS 10 · socket.io 4 · `mediasoup` · `firebase-admin`  | **120** files          | Real-time + E2EE transport. Redis is its database.                       |
| **Shared core**       | `packages/messenger-core/` | Platform-agnostic TS                                      | **30** files           | The crypto/transport library mobile and ops-console both consume.        |

### The rule that shapes the whole system

> **The relay never sees plaintext, and the business API never sees message
> content.** Anything that must be private end-to-end (chat, media, group state,
> backups, call SDP auth) travels through `messenger-service` as opaque
> sealed-sender bytes. Anything that is _operational_ (a booking, a mission, a
> wallet balance, an audit row) is ordinary authenticated JSON to `auth-service`
> and lives in Postgres.

Two consequences the incoming team must internalise:

1. **The two backends are deliberately not coupled by HTTP.** They share _Redis_
   and a _JWT secret_, nothing else. `auth-service` publishes an opaque wake
   frame on `push:events`; `messenger-service` subscribes and ships it to FCM.
   Neither calls the other's REST API.
2. **Push notifications carry no business data.** `BookingPushBridge.publish()`
   (`apps/auth-service/src/ops/booking-push-bridge.service.ts`) writes the detail
   blob into Redis under `push-event:<userId>:<eventId>` with a 900 s TTL and
   publishes only `{userId, eventClass, eventId}`. The device then pulls the
   detail back over the authenticated channel via `GET /events/by-id/:eventId`.
   FCM sees a coarse class label and two opaque ids.

### Runtime topology

| Process             | Port   | Scaling                         | State                                                                                   |
| ------------------- | ------ | ------------------------------- | --------------------------------------------------------------------------------------- |
| `auth-service`      | `3001` | Multi-replica (stateless)       | None in-process. Background sweeps are Redis-`SET NX`-locked so only one pod runs each. |
| `messenger-service` | `3100` | Multi-replica via Redis adapter | socket.io rooms fan out through `@socket.io/redis-adapter`; call sessions in-process.   |
| `ops-console`       | `3002` | Stateless SSR                   | Session lives entirely in httpOnly cookies.                                             |
| Mobile              | —      | Per-device                      | SQLCipher DB (schema v20) + hardware keychain.                                          |

---

## 2.2 Frontend architecture — mobile (React Native)

### 2.2.1 Layer map

```
App.tsx                     fonts · i18n · Stripe · ErrorBoundary · BiometricGate · alert host
  └─ RootNavigator          src/navigation/index.tsx — authenticated? → Main : Auth
       └─ MainNavigator     src/navigation/MainNavigator.tsx — picks the SHELL, boots runtimes
            ├─ CpoNavigator / CpoOnboardingNavigator     managed guard
            ├─ AgentNavigator                            agency operator / org manager
            └─ Tab.Navigator (client)                    Booking · Messenger · Wallet · …
                 └─ screens (196 .tsx)  ──uses──▶  stores (Zustand)  ──calls──▶  services/api.ts
                                          │                                            │
                                          └──uses──▶ src/modules/<domain>/  ───────────┘
```

| Directory         | Contents                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `src/screens/`    | 196 screens in 17 domain folders (`agent` 38, `deptchat` 34, `messenger` 28, `booking` 18, …)         |
| `src/navigation/` | 8 navigators + the pure route resolver, deep-link parsers, tab bar                                    |
| `src/store/`      | 12 Zustand stores — `authStore`, `bookingStore`, `walletStore`, `productStore`, `entitlements`, …     |
| `src/services/`   | Cross-cutting clients — `api.ts` (3,268 lines), `tokenVault.ts`, `supabase.ts`, `stripe.ts`           |
| `src/modules/`    | Domain modules — `messenger` (the largest by far), `booking`, `maps`, `vbg`, `agent`, `observability` |
| `src/components/` | 31 shared presentational components                                                                   |
| `src/theme/`      | Obsidian design tokens (`#07090D` surface, `#5B8DEF` cobalt accent)                                   |
| `src/hooks/`      | Cross-screen hooks — notably `useKeyboardLayout`, the app-wide keyboard-inset rule                    |

### 2.2.2 The shell switch — one binary, three products

The post-login experience is chosen from the **server-authenticated account kind**,
never from a client flag. The decision is a pure, exhaustively-tested function:

`src/navigation/resolveRoute.ts` → `resolveAuthedRoute(signals)` returns one of
`access-ended · cpo-activation · cpo-onboarding · cpo · agency · client`.

Its inputs come from `GET /auth/me`, which resolves them server-side in
`apps/auth-service/src/auth/account-kind.ts` (`resolveAccountKind`) by reading
`users`, `agents` and `org_members` on every request. `account_kind` is **not a
JWT claim** — a demoted manager or a suspended CPO re-resolves on the next call
rather than waiting for a token to expire.

### 2.2.3 State management

Zustand, one store per bounded context, with `immer`-style mutation inside `set`:

| Store             | Owns                                                                       |
| ----------------- | -------------------------------------------------------------------------- |
| `authStore`       | Session, `user`, `isAuthenticated`, sign-out, boot `initialize()`          |
| `bookingStore`    | The booking wizard draft, estimate, submit, active booking, live convoy    |
| `walletStore`     | Bravo Credits balance, top-up state                                        |
| `productStore`    | Which product surface (Secure / Lite / Departmental) is active             |
| `activeWorkspace` | The selected org — stamped as `X-Org-Context` on workspace-scoped requests |
| `entitlements`    | Tier-derived feature flags                                                 |

Screen-local state stays in the component. Server data is fetched by the store
action, not by the screen, so a screen can be remounted without re-triggering a
mutation.

### 2.2.4 The API layer — `src/services/api.ts`

A single axios instance (`authHttp`) against `EXPO_PUBLIC_API_BASE_URL`, plus a
`fetch`-based helper for the messenger-service host. Three behaviours are
implemented once here and must not be reimplemented per screen:

1. **Bearer attachment** — a request interceptor reads the access token from
   `tokenVault` (hardware keychain) and sets `Authorization`.
2. **Org context** — `orgContextHeaderFor()` stamps `X-Org-Context` **only** on
   paths in the explicit `ORG_SCOPED_PREFIXES` allowlist, and **only at request
   creation**, never on a retry. The server treats the header as a _narrowing
   request_, never a grant: an org the caller does not belong to is ignored, so
   the header can never widen access.
3. **401 → refresh → replay once** — a single in-flight refresh promise
   (`refreshInFlight`) deduplicates the thundering herd when the app wakes with an
   expired token. Critically, the session is destroyed **only on a genuine auth
   failure** (`401`/`403`/`404` from `/auth/refresh`, or no refresh token at all);
   a timeout, network blip or `5xx` keeps the tokens, because wiping them turned a
   transient outage into a permanent logout. Genuine loss fires `onAuthLost()`,
   which the root navigator uses to route to a clean re-auth.

A `403` whose body is `{code: 'tier_insufficient'}` is fanned out to
`onTierInsufficient` subscribers so a paywall can be shown without coupling axios
to navigation.

### 2.2.5 The messenger module

`src/modules/messenger/` is roughly half the mobile codebase and is the one part
that is _not_ a thin client over the API:

| Sub-module   | Responsibility                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `crypto/`    | libsignal store, identity/pre-keys, sealed-sender seal/unseal, the SQLCipher handle (`db.ts`)     |
| `store/`     | `sqlMessageStore`, `sqlOutboxStore`, group master keys, dedup/seen-envelope tables                |
| `transport/` | socket.io client, HTTP relay clients, ack queue                                                   |
| `runtime/`   | The orchestration layer — `productionRuntime.ts` (10,450 lines) plus ~70 single-rule leaf modules |
| `webrtc/`    | 1:1 PeerConnection and the SFU client for group calls                                             |
| `backup/`    | Encrypted mirror, Merkle commit/verify, restore                                                   |
| `ui/`        | Chat surface components                                                                           |

> **Handover warning.** No test imports `productionRuntime.ts` — it pulls native
> modules. A green Jest run is therefore **not** evidence that a change there is
> safe. The invariants that no unit test can reach are pinned by _static source
> scans_ instead (`messageTopologyInvariants.test.ts`,
> `receivePersistenceInvariants.test.ts`, and the ordering scans listed in
> `CLAUDE.md`). The pipeline's invariant contract is summarised in §2.13.4 —
> read it before changing anything under `runtime/`.

### 2.2.6 Local persistence

| Store                         | Technology                                | Holds                                                                               |
| ----------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| Messenger DB (**schema v20**) | SQLCipher via `@op-engineering/op-sqlite` | Signal session state, message plaintext, outbox, drafts, media cache, backup ledger |
| Token vault                   | `react-native-keychain` (hardware-backed) | Access + refresh tokens                                                             |
| `AsyncStorage`                | Plain KV                                  | Non-sensitive preferences only                                                      |

The SQLCipher page key comes from the hardware keystore — never derived from a
user password at the DB layer. Message ciphertext and key material are kept in
separate tables by design.

---

## 2.3 Frontend architecture — Ops Console (Next.js)

```
apps/ops-console/src/
  middleware.ts          edge session gate + per-request CSP nonce + security headers
  app/                   App Router — 35 pages (dashboard, dispatch, live, bookings, jobs,
                         agents, compliance, finance, incidents, sos, users, vbg, settings…)
  components/            Shell, BravoMap (Mapbox GL, lazy), SosAlertBar, NotificationBell, Redacted
  lib/
    api.ts               typed fetch wrapper + the whole `opsApi` surface
    rbac.ts              role-rank helpers that mirror the server's @RequireRoles
    messenger/           browser-side libsignal + IndexedDB vault (AES-GCM at rest)
    datetime.ts · format.ts · csv.ts · polyline.ts · bc.ts
```

**Session model.** The console never holds a token in JavaScript. `POST
/auth/verify` with `platform: 'web'` sets three cookies — `bravo_ops_token`
(httpOnly, access), `bravo_ops_refresh` (httpOnly, path-scoped to
`/auth/session/refresh`) and `bravo_ops_csrf` (readable, for double-submit).
`lib/api.ts` sends `credentials: 'include'` and echoes the CSRF cookie as
`X-CSRF-Token` on every mutation.

**`middleware.ts`** is a _pre-render_ gate, not an authorisation check: it
redirects to `/login` when no session cookie is present so an unauthenticated
client never receives the RSC payload, and it stamps a per-request CSP nonce.
Signature verification stays in `auth-service` — the HS256 secret is deliberately
never shipped to the edge runtime.

**Data fetching** is SWR against `opsApi`. Every page independently calls
`/ops/me` on mount; that call is what actually proves the session and yields the
admin role used by `lib/rbac.ts` to hide destructive controls. The server enforces
the same rules with `@RequireRoles` — the client copy is UX hygiene only.

**Messenger in the console** reuses `@bravo/messenger-core` and stores keys in
IndexedDB wrapped with AES-GCM. It authenticates to `messenger-service` with a
5-minute _messenger ticket_ (`POST /auth/messenger-ticket`) rather than the
session cookie, because socket.io and the relay need a bearer value that JS can
hold.

---

## 2.4 Backend architecture

Both services are **NestJS 10 on Express**, structured the same way:

```
main.ts        bootstrap — fail-closed env checks, global pipes, CORS, cookies, shutdown hooks
app.module.ts  module composition + global guards
<feature>/
   ├─ *.controller.ts   HTTP surface: routing, DTO binding, guard/interceptor composition
   ├─ *.service.ts      business logic — the only layer allowed to write SQL/Redis
   ├─ *.guard.ts        authorisation
   ├─ dto/              class-validator DTOs
   └─ *.spec.ts         Jest, colocated
```

There is no repository/DAO layer and **no ORM**. Services own parameterised SQL.
This is a deliberate choice (see §2.7).

### 2.4.1 `auth-service` module inventory (34 feature modules)

| Group           | Modules                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------ |
| Identity        | `auth`, `keys`, `sender-cert`, `totp`, `biometric`, `users`                                      |
| Booking & money | `booking`, `wallet`, `subscription`, `family`, `settlement`                                      |
| Field ops       | `dispatch`, `agents`, `protection`, `sos`, `telemetry`, `attendance`, `incident`, `compliance`   |
| Organisations   | `org`, `department`, `pro-applications`, `pro-management`                                        |
| Console API     | `ops`, `ops-deptchat`                                                                            |
| Platform        | `database`, `redis`, `kafka`, `events`, `notifications`, `observability`, `conversations`, `vbg` |

### 2.4.2 Bootstrap contract (`apps/auth-service/src/main.ts`)

The service **refuses to start** rather than run mis-configured. This is the
single most important operational behaviour in the file:

| Condition (production only)                                                                                                                              | Result                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Any of `OTP_DEV_BYPASS`, `BIOMETRIC_DEV_BYPASS`, `OTP_DEV_RETURN_CODE`, `DISPATCH_TRUST_MOCKED_LOCATION`, `DISPATCH_DISABLE_REGION_FILTER` set to `true` | `refusing_to_start`   |
| `CORS_ALLOWED_ORIGINS` unset                                                                                                                             | `refusing_to_start`   |
| `JWT_ACCESS_SECRET` / `JWT_ACTION_SECRET` blank, `<placeholder>`, `< 32` chars, or a secret published in this repo                                       | throws at config load |
| `TOTP_ENCRYPTION_KEY` unset                                                                                                                              | throws at config load |

Also configured here: a global `ValidationPipe` (`whitelist: true`;
`forbidNonWhitelisted` behind `STRICT_VALIDATION` for staged rollout),
`trust proxy = 1` (exactly one hop — `true` would let a caller mint a fresh
rate-limit bucket per request by varying `X-Forwarded-For`), a 20-line cookie
parser, an explicit CORS origin allowlist, `/uploads/*` static serving for KYC
documents, and `enableShutdownHooks()` so the Redis-locked sweeps clear their
timers on a rolling deploy.

### 2.4.3 `messenger-service` module inventory

| Module                     | Responsibility                                                                |
| -------------------------- | ----------------------------------------------------------------------------- |
| `gateway`                  | socket.io gateway (37 events), presence, connection registry, WS rate limiter |
| `relay`                    | Sealed-envelope store-and-forward with bounded dwell + sweep crons            |
| `media`                    | S3 presigned upload/download for encrypted attachments, orphan sweep          |
| `vault`                    | File Vault — MFA-gated download URL issuance                                  |
| `push`                     | FCM delivery, token registry + GC; subscribes `push:events`                   |
| `sfu`                      | mediasoup rooms, transports, producers/consumers, zombie sweeper              |
| `turn`                     | TURN credential minting                                                       |
| `backup`                   | Encrypted backup mirror, Merkle commits, archive retry outbox                 |
| `auth` · `redis` · `users` | Shared JWT verification, Redis client, user privacy lookups                   |

Its `main.ts` installs a `RedisIoAdapter` before `useWebSocketAdapter`, so socket
rooms fan out across replicas, and exposes a `/healthz` where **Redis PING is the
only hard readiness gate** — a Redis-partitioned pod is drained by the load
balancer rather than restarted.

---

## 2.5 API / service architecture

### 2.5.1 HTTP surface

| Service             | Controllers | Route decorators | Route prefixes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ----------: | ---------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-service`      |      **49** |          **436** | `auth`, `auth/admin`, `auth/biometric`, `auth/keys`, `auth/totp`, `agents`, `agents/me`, `agents/me/protection`, `attendance`, `attendance/roster`, `bookings`, `compliance`, `conversations`, `department`, `dispatch`, `dispatch/offers`, `dispatch/room-intents`, `enterprise`, `events`, `family`, `incidents`, `me/notifications`, `news`, `ops`, `ops/admins`, `ops/deptchat`, `ops/dispatch`, `ops/pro-applications`, `ops/pro-management`, `ops/protection`, `ops/referral-codes`, `ops/subscription`, `org`, `org/invites`, `org/workspace`, `pro-applications`, `protection`, `sender-cert`, `sos`, `subscription`, `telemetry`, `users`, `vbg`, `wallet` |
| `messenger-service` |       **8** |           **37** | `backup`, `calls`, `envelopes`, `media`, `push`, `sfu`, `vault`, `webrtc`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Machine-readable specifications for both services exist as OpenAPI 3 documents
in the repository (`bravo-auth-service.yaml`, `bravo-messenger-service.yaml`).
They are hand-maintained alongside the controllers rather than generated, so the
controller decorators remain the authority whenever the two disagree.

### 2.5.2 WebSocket surface — 37 events

`apps/messenger-service/src/gateway/messenger.gateway.ts`, namespace `/ws`.

| Group       | Events                                                                                                                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session     | `ping`, `auth.refresh`                                                                                                                                                                                               |
| Messaging   | `envelope.send`, `envelope.pull`, `envelope.ack`, `read-receipt`, `typing`                                                                                                                                           |
| Presence    | `presence`, `presence.subscribe`, `presence.unsubscribe`                                                                                                                                                             |
| 1:1 calls   | `call.offer`, `call.answer`, `call.reoffer`, `call.reanswer`, `call.ice`, `call.hangup`, `call.media-state`, `call.sync`                                                                                             |
| Group calls | `sfu.join`, `sfu.leave`, `sfu.produce`, `sfu.consume`, `sfu.producers`, `sfu.transport.connect`, `sfu.transport.restartIce`, `sfu.producer.pause/resume`, `sfu.consumer.pause/resume`, `sfu.mute-target`, `sfu.kick` |
| Ringing     | `sfu.ring`, `sfu.ring.ack`, `sfu.ring.cancel`, `sfu.ring.decline`                                                                                                                                                    |
| Missions    | `mission.subscribe`, `mission.unsubscribe`                                                                                                                                                                           |

### 2.5.3 Cross-cutting request rules

| Concern           | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Validation**    | `class-validator` DTOs + global `ValidationPipe`. `whitelist: true` strips unknown fields so `role` / `subscription_tier` cannot be smuggled into a DTO that does not declare them.                                                                                                                                                                                                                                        |
| **Rate limiting** | `@nestjs/throttler`. A global abuse ceiling of **120 req / minute** per IP (`GlobalHttpThrottlerGuard`, bound as `APP_GUARD`); the real limits are per-route `@Throttle` decorators — e.g. `POST /auth/register` is 5 / 10 min, `POST /auth/login` 5 / 10 min. Eight controllers bind `UserThrottlerGuard` for per-user buckets, and the global guard skips those routes so they are not re-bucketed by IP.                |
| **Idempotency**   | `IdempotencyInterceptor` on every non-idempotent money/state transition (`pay-with-credits`, `confirm-complete`, `dispute`, `rating`, `escalate`, ops approve/dispatch/complete). Requires an `Idempotency-Key` header (8–128 chars, `[A-Za-z0-9_-]`); the response is cached in Redis for **24 h** under `idem:<sha256(actor:method route:key)>`. A thrown exception is never cached, so a client can retry the same key. |
| **Error shape**   | NestJS `HttpException`. Machine-readable failures carry a body of `{code, message, …context}` — e.g. `{code: 'insufficient_credits', required, balance}`, `{code: 'active_booking_exists', booking_id, booking_status}`, `{code: 'tier_insufficient', required_tier}`. The mobile client branches on `code` and renders `message`.                                                                                         |
| **CSRF**          | `CsrfGuard` — double-submit, applied to state-changing `/ops/*` routes. Two-track: a cookie session must present a matching `X-CSRF-Token`; a bearer caller is exempt because CSRF cannot forge an `Authorization` header.                                                                                                                                                                                                 |
| **Correlation**   | Opaque `eventId` for push wakes; `ops_audit` rows for every operator action.                                                                                                                                                                                                                                                                                                                                               |

---

## 2.6 Business logic layer

All business rules live in `*.service.ts`. Controllers are thin: bind, guard,
delegate. Four patterns carry most of the weight.

### 2.6.1 Explicit state machines

Illegal transitions are impossible to express, not merely unlikely. Each machine
is a table of `(from, to, actor)` triples; anything absent throws
`ForbiddenException`.

**Booking** — `apps/auth-service/src/booking/state-machine.service.ts`

```
DRAFT ─CLIENT─▶ PENDING_OPS ─OPS─▶ OPS_APPROVED ─┬─CLIENT─▶ PAYMENT_PENDING ─SYSTEM─▶ CONFIRMED
                                                  └─SYSTEM─▶ DISPATCHING ──┬─SYSTEM─▶ CONFIRMED
                                                                            └─SYSTEM─▶ NO_PROVIDER (terminal)
CONFIRMED ─SYSTEM─▶ DISPATCHING      (arrival no-show → re-dispatch, escrow hold persists)
CONFIRMED ─SYSTEM─▶ AGENCY_NO_SHOW   (terminal — accepted but never crewed)
CONFIRMED ─CPO|OPS─▶ COMPLETED    ·    CONFIRMED ─CPO─▶ LIVE ─CPO|OPS─▶ COMPLETED
CANCELLED reachable from DRAFT · DISPATCHING · PENDING_OPS · OPS_APPROVED · PAYMENT_PENDING · CONFIRMED
          by CLIENT, SYSTEM or OPS_HANDLER only
```

**Mission** — `apps/auth-service/src/ops/mission-state-machine.service.ts`:
`DISPATCHED → PICKUP → LIVE → COMPLETED`, with `SOS` raisable by the agent from
`PICKUP` or `LIVE`, and `ABORTED` reserved to ops/admin.

**Job** — `apps/auth-service/src/ops/job-state-machine.service.ts` governs the
agent job feed (`PUBLISHED → … → ASSIGNED / DISPATCHED / CANCELLED`).

### 2.6.2 Pricing — one source of truth

`apps/auth-service/src/booking/pricing.service.ts` (`calculate()`) is the only
place a price is computed. It takes CPO count, vehicle count, driver-only,
duration, pickup time, resolved add-ons, region and service, and returns rate,
totals and an itemised `breakdown`. The breakdown is **persisted on the booking
row** (`pricing_breakdown`) so the invoice reflects the lines the client actually
saw rather than a later recomputation.

Two rules the code enforces rather than documents:

- **Reject, never silently reprice.** An add-on id that is unknown, inactive or
  out-of-region is a `400 unknown_add_on` — earlier behaviour dropped it silently
  while persisting the raw list, so the booking advertised a service nobody was
  charged for.
- **Executive Protection is fixed-block.** Duration must be a multiple of 3 hours
  between 3 and 24; a seat-cap clamp that would change the team is a `400`, not a
  quiet adjustment.

The mobile client mirrors this arithmetic for the live estimate, and
`POST /bookings/estimate` exists so the wizard can quote against the _server's_
numbers before submitting.

### 2.6.3 Money — escrow, and "charged ≠ paid"

`apps/auth-service/src/wallet/wallet.service.ts`:

| Method               | Effect                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `holdToEscrow(tx,…)` | `SELECT … FOR UPDATE` the payer's balance → gate on funds → ledger row + balance decrement → FIFO batch debit → credit the platform escrow account. Runs **inside the caller's transaction**. |
| `releaseEscrowHold`  | Release to the provider on completion                                                                                                                                                         |
| `refundEscrowHold`   | Full reversal, rate-stamped so the receipt matches the original charge                                                                                                                        |
| `settleEscrowSplit`  | Dispute outcome — paired split plus possible agency clawback                                                                                                                                  |

Every method takes a `Tx`, so the money move and the state flip commit or roll
back together. There is no path that debits a wallet outside a transaction that
also advances the booking.

### 2.6.4 Dispatch — the ranked offer cascade

`apps/auth-service/src/dispatch/dispatch.service.ts`:

`start()` flips `OPS_APPROVED → DISPATCHING`, then `offerNext()` ranks eligible
agencies (region hard-match, distance, acceptance rate, cooldown) and inserts a
`dispatch_offers` row with `expires_at = NOW() + DISPATCH_OFFER_TTL_SECONDS`
(**default 30 s**). On reject or expiry it cascades to the next rank; when the
list is exhausted the booking becomes `NO_PROVIDER`.

`accept()` is the one money/FSM path, and it is guarded four ways inside a single
transaction (`acceptTxn` → `settleWonOffer`):

1. `SELECT … FOR UPDATE` on the offer row.
2. **IDOR check** — only the agency the offer was made to may accept it.
3. **Conditional UPDATE** — `WHERE status = 'OFFERED' AND expires_at > NOW()`;
   zero rows means someone else won, and the caller gets `offer_not_available`.
4. `settleWonOffer` then does accept accounting, the escrow charge, the single
   writer of `assigned_provider_user_id`, the `DISPATCHING → CONFIRMED` flip and
   the sibling-offer supersede — all in that one transaction.

A `40P01` deadlock victim is retried exactly once (`retryOnDeadlock`), which is
safe because the whole transaction rolled back and every guard re-evaluates
against the winner's committed state.

### 2.6.5 Ops actions

`OpsService` methods follow one shape: transaction → `FOR UPDATE` → region scope
assertion → FSM assert → **conditional** `UPDATE … WHERE status = <expected>` →
audit → best-effort side effects (push, system message, Redis publish) _after_ the
commit. `approveBooking` is the canonical example, and the conditional update is
belt-and-braces on top of the row lock: two operators clicking "Approve"
simultaneously produce one success and one `booking_state_changed_concurrently`.

---

## 2.7 Data access / database layer

### 2.7.1 `auth-service` → PostgreSQL

`apps/auth-service/src/database/database.service.ts` is the entire data-access
layer — about 120 lines.

```ts
export interface Tx {
  q<T>(sql: string, params?: unknown[]): Promise<T[]>; // all rows
  qOne<T>(sql: string, params?: unknown[]): Promise<T | null>; // first row or null
}
```

- One `pg.Pool` created in `onModuleInit`, drained in `onModuleDestroy`.
- `DatabaseService` itself implements `Tx`, and so does a checked-out client — so
  a service method written against `Tx` runs identically standalone or inside a
  transaction. This is what makes `holdToEscrow(tx, …)` composable.
- `withTransaction(fn)` issues `BEGIN`, commits on resolve, rolls back and
  re-throws on reject, and releases the client in `finally` so a thrown exception
  cannot pin a connection. A failed `ROLLBACK` is logged separately — it is the
  only signal that the server-side transaction was left inconsistent.
- Row locking inside the callback is `SELECT … FOR UPDATE`.

**There is no ORM.** All access is parameterised SQL written next to the business
rule it serves. The trade-off was made knowingly: the money and dispatch paths
need explicit lock ordering and conditional updates, which ORMs obscure.
`ops.service.sqli.spec.ts` exists to keep the discipline honest.

### 2.7.2 `messenger-service` → Redis (+ PostgREST)

Redis is the primary store: transient sealed envelopes, presence, connection
registry, JTI validity, push-event blobs, sweep locks, SFU room state. Durable
artifacts that must outlive Redis (backup archives, envelope archive) go to
Supabase over PostgREST with the service-role key. `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are required in production — the process refuses to
boot without them.

### 2.7.3 Mobile → SQLCipher

`src/modules/messenger/crypto/db.ts` opens the encrypted database via
`@op-engineering/op-sqlite` with a key from the hardware keystore, and owns
`SCHEMA_VERSION` (**20**) plus the forward-only migration ladder. The version
history is documented inline, version by version, and is the fastest way to
understand what local state exists and why. Adding a column to any messenger
table requires bumping that constant.

### 2.7.4 Ops Console → IndexedDB

`apps/ops-console/src/lib/messenger/` keeps Signal state in IndexedDB (`idb`)
wrapped with AES-GCM. The console never touches Postgres — it talks only to
`auth-service` over HTTP.

---

## 2.8 Authentication process

### 2.8.1 Registration (two steps — the user row is created _after_ OTP approval)

```
POST /auth/register        {email, phoneE164, …}
   → uniqueness check on (email OR phone) AND deleted_at IS NULL
   → OtpService.send() via Twilio Verify
   → Twilio 60203 → 429 otp_rate_limited · 60410 → 403 otp_number_blocked

POST /auth/register/verify {phoneE164, code, deviceId, platform, …}   [201]
   → OtpService.check() against Twilio Verify
   → re-check uniqueness → INSERT public.users  (role and tier are SERVER-set;
     the DTO does not carry them — the surface is unauthenticated)
   → issueSession()
```

### 2.8.2 Login (password + OTP, two factors, three calls)

```
POST /auth/login    {email|phoneE164, password}
   → argon2 verify (PasswordService)
   → on failure: identical response shape whether or not the account exists
     ({userId: null, otpSentTo: null}) — no enumeration oracle
   → on success: insert auth_otps row (attempt/expiry bookkeeping only; Twilio
     Verify owns the code itself) + send OTP

POST /auth/verify   {userId, code, deviceId, platform}
   → checks: pending OTP exists · not used · not expired · attempt_count < max (3)
   → OtpService.check() → issueSession()
   → platform === 'web' → also set the three ops cookies
```

`POST /auth/admin-register/verify` is **permanently 403** — public admin
self-registration was removed (it allowed anyone to mint an `ADMIN` account). The
endpoint stays routable so monitoring records attempts. Admin accounts are
provisioned by invite (`/ops/admins`, `/accept-invite`).

### 2.8.3 Session issue — `AuthService.issueSession()`

For a verified device this single method:

1. Mints a **refresh token** — 48 random bytes, base64url; only its SHA-256 hash
   is stored.
2. Allocates or reuses the per-user `signal_device_id` (`MAX+1`) — the Signal
   multi-device address, and `NOT NULL` in `auth_devices`.
3. Signs the **access JWT** and, crucially, **revokes the device's previous
   `jti`** before storing the new one.
4. Upserts `auth_devices` on `(user_id, device_id)` — refresh hash, platform,
   expiry, `current_jti`, clearing `revoked_at`.
5. Clears any push-revoke tombstone so the device re-arms its FCM token.
6. On a fresh **login** (not a refresh), evicts the account's _other_ devices of
   the same platform — mobile is single-device by design because two phones would
   fight over the one WS slot. `platform === 'web'` is exempt: the console is
   legitimately multi-tab.

### 2.8.4 Token formats

| Token                | Alg                      | Issuer / Audience               | TTL                         | Where it lives                                                                                               |
| -------------------- | ------------------------ | ------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Access**           | HS256                    | `auth-service` / `bravo-api`    | `JWT_ACCESS_TTL`, **15 m**  | Mobile: keychain. Console: `bravo_ops_token` httpOnly.                                                       |
| **Refresh**          | opaque (48 random bytes) | —                               | `JWT_REFRESH_TTL`, **30 d** | Mobile: keychain. Console: `bravo_ops_refresh` httpOnly, path-scoped. Server stores SHA-256 only.            |
| **Action** (MFA)     | HS256                    | `auth-service` / `bravo-action` | **5 m**                     | Held briefly by the client, sent as `X-Mfa-Proof`. Signed with a **different secret** (`JWT_ACTION_SECRET`). |
| **Messenger ticket** | HS256                    | same as access                  | **5 m**                     | Console only — a short-TTL access token JS may hold.                                                         |

Access-token claims: `sub`, `device_id`, `role`, `jti`, `iss`, `aud`, `iat`, `exp`.
`account_kind`, org membership and admin role are **deliberately not claims** —
they are re-read from the database on every request.

`verifyAccessToken` pins `algorithms: ['HS256']` plus issuer and audience, which
closes the RFC 7519 §8.1 algorithm-confusion class if the secret is ever swapped
for a PEM.

### 2.8.5 Where a token is checked

| Entry point              | Guard / mechanism                                                                                                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-service` HTTP      | `JwtAuthGuard` — accepts `Authorization: Bearer` **or** the `bravo_ops_token` cookie (header wins), verifies, then checks Redis `jti:<jti>` exists. A revoked token is `401 token_revoked`.                                                                                                              |
| `messenger-service` HTTP | `JwtHttpGuard` (+ `AppCheckGuard` where configured)                                                                                                                                                                                                                                                      |
| `messenger-service` WS   | socket.io `server.use()` middleware in `afterInit` — extracts the token from the auth payload (query is accepted but warns), requires `signalDeviceId`, verifies the JWT, then `EXISTS jti:<jti>`. Rejects via `connect_error` so the client gets a clean failure rather than a connect/disconnect blip. |
| Live WS sockets          | A **60 s** `jtiRecheckInterval` sweep re-checks every connected socket's `jti` and soft-disconnects any whose key is gone — this is what makes remote logout act on an already-open socket.                                                                                                              |
| File Vault               | `MfaGuard` on top of `JwtHttpGuard` — see below.                                                                                                                                                                                                                                                         |

### 2.8.6 Step-up MFA (File Vault)

`apps/messenger-service/src/vault/mfa.guard.ts` requires, in addition to a valid
access token:

- an `X-Mfa-Proof` header carrying an **action token**;
- its `purpose` in the configured allowlist (`biometric-verified`,
  `totp-verified`, `vault-access`);
- `iat` fresher than `vault.mfaMaxAgeSec` (**300 s** default);
- `sub` **and** `device_id` matching the access token's caller.

The guard verifies the _cryptographic proof that the step happened_; the biometric
prompt itself is the client's job. **This gate must not be bypassed** — it is a
named stop-condition in the architecture reference.

---

## 2.9 Authorization / RBAC

Authorisation is layered. Each guard answers one question and is composed onto a
route with `@UseGuards(...)`, always **after** `JwtAuthGuard`.

| Guard                 | File                                   | Question answered                                                                          | Failure                               |
| --------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------- |
| `JwtAuthGuard`        | `common/guards/jwt-auth.guard.ts`      | Is this a live, non-revoked session?                                                       | `401 invalid_token` / `token_revoked` |
| `AdminGuard`          | `ops/admin.guard.ts`                   | Is the subject an **active `admin_users` row**, and does its role satisfy `@RequireRoles`? | `403`                                 |
| `OrgManagerGuard`     | `org/org-manager.guard.ts`             | Is the caller a manager **of this org**?                                                   | `403`                                 |
| `CpoSessionGuard`     | `common/guards/cpo-session.guard.ts`   | Is this CPO's agency membership still `active`?                                            | `403 agency_access_ended`             |
| `TierGuard`           | `common/guards/tier.guard.ts`          | Does the **effective** tier meet `@RequireTier`?                                           | `403 tier_insufficient`               |
| `DeptChatAccessGuard` | `department/dept-chat-access.guard.ts` | May this user reach the department-chat module?                                            | `403`                                 |
| `DeptChatV2Guard`     | `common/guards/dept-chat-v2.guard.ts`  | Is the v2 surface enabled for this org?                                                    | `403`                                 |
| `CsrfGuard`           | `common/guards/csrf.guard.ts`          | Double-submit token match (cookie sessions only)                                           | `403 csrf_token_invalid`              |

### 2.9.1 Operator RBAC (HQ)

Three ranked roles in `admin_users`: **`OPS` < `SUPERVISOR` < `ADMIN`**.
`@RequireRoles('SUPERVISOR','ADMIN')` gates every destructive mutation — approve,
reject, dispatch, complete, terminate, payout, wallet adjust, dispute resolve.
`OPS` keeps the lightest mutation (shortlist) and all reads.

`AdminGuard` **re-reads `admin_users` on every request** and stamps
`last_active_at`; a revoked operator loses access immediately rather than at token
expiry. The console mirrors the ranking in `lib/rbac.ts` purely so operators are
not shown buttons that will 403.

### 2.9.2 Region scoping (tenant isolation)

Operators are region-bound (`AE`, `SA`, `BD`, …). `assertRegionScope(admin,
recordRegion)` runs at the service layer immediately after the booking/mission row
is read. `ADMIN` is treated as global by current policy (`isGlobalAdmin`); `OPS`
and `SUPERVISOR` stay scoped. Changing that policy is a one-function edit,
deliberately.

### 2.9.3 Organisation scoping

A manager is one of exactly three things — the company account itself, the owner
of an Enterprise workspace, or an `org_members` row with
`member_role='manager', status='active'`. **Buying a subscription is not one of
them**: a tier arm was removed from this guard after measurement showed a
plain enterprise-tier individual with no workspace reaching
`POST /department/channels` with a 200. The tier gates the _paid surface_
(`WorkspaceService.createWorkspace`); authority comes from _creating_ the
workspace.

Client-side, `X-Org-Context` says which of the caller's own organisations a
request is about. It narrows; it never widens.

### 2.9.4 Subscription tiers

`lite < pro < enterprise`, ranked so `@RequireTier('pro')` accepts Enterprise.
`effectiveTierOf(row)` is the rule: a paid tier counts only while
`pro_active_until` is open; `NULL` means a permanent comp grant; a lapsed window is
Lite _now_, without waiting for the hourly lapse sweep. The identical rule exists
in SQL as `activeEnterpriseSql()` so a query never hand-writes the predicate — it
had already been written six different ways before it was extracted.

---

## 2.10 Session / token management

### 2.10.1 The JTI registry — how revocation actually works

Every access token carries a `jti`. On issue, `auth-service` writes
`jti:<jti>` into Redis with the access TTL and stores it as
`auth_devices.current_jti`. **Both services check that key**; deleting it revokes
the token instantly, everywhere.

| Event                             | Effect                                                                      |
| --------------------------------- | --------------------------------------------------------------------------- |
| New session issued for a device   | The device's **previous** `jti` is revoked (`redis.revokeJti`)              |
| Sign-out (`DELETE /auth/session`) | `jti` revoked, `auth_devices.revoked_at` set                                |
| Password change                   | Session tokens revoked                                                      |
| Single-device takeover (mobile)   | Every other same-platform device's `jti` revoked and its row marked revoked |
| Live WS socket                    | Disconnected within ≤ 60 s by the `jtiRecheckInterval` sweep                |

The 60 s worst case for an already-open socket is a deliberate trade: pub/sub
invalidation would cut it to ~1 s but adds a cross-service contract, and 60 s is
inside the "user-visible promptness" bar for logout / remote-wipe.

### 2.10.2 Refresh

- **Mobile** — `POST /auth/refresh` with the refresh token in the body. The server
  hashes it, finds the `auth_devices` row, rejects `revoked_at`/expired, re-reads
  the user (rejecting soft-deleted or suspended accounts) and issues a fresh pair.
  Refresh tokens **rotate on every use**.
- **Console** — `POST /auth/session/refresh` reads the path-scoped
  `bravo_ops_refresh` cookie. A non-web token found in the web cookie jar clears
  the jar and forces re-login.

Client-side, all of this funnels through one deduplicated promise
(`refreshAccessTokenShared()`), which `productionRuntime` also injects into the
messenger HTTP clients so a 401 inside the relay/keys/sender-cert clients recovers
the same way.

### 2.10.3 Client-side storage

| Where               | What                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Mobile keychain     | Access + refresh tokens (`src/services/tokenVault.ts`)                                                                   |
| Ops Console cookies | `bravo_ops_token` (httpOnly), `bravo_ops_refresh` (httpOnly, path-scoped), `bravo_ops_csrf` (JS-readable, double-submit) |

`tokenStore` in `api.ts` is the only sanctioned accessor;
`tokenStorageContract.test.ts` fails the build if the underlying storage keys are
read directly.

---

## 2.11 Logging and error handling

### 2.11.1 Logging

| Layer                | Mechanism                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NestJS services      | `new Logger(<Service>.name)`; `main.ts` enables `['log','warn','error']`                                                                                                                                                                                                                                                                                             |
| Security audit trail | `AuditService` (`kafka/audit.service.ts`) — typed `AuditEventType` union (`auth.login`, `auth.verify`, `auth.keys.identity_rotated`, `auth.password.changed`, `client.sos.raise`, …). Emits a structured JSON line **always**, and additionally to Kafka when `KAFKA_BROKERS` is set. It is unset in the reference env, so today audit events are structured stdout. |
| Operator audit trail | `OpsAuditService` → the `ops_audit` table: actor id, role, call-sign, action, subject, JSON metadata, IP                                                                                                                                                                                                                                                             |
| Business timeline    | `lite_booking_audit` rows written on every booking FSM transition, with actor and reason                                                                                                                                                                                                                                                                             |
| Error reporting      | `SentryService` — a shim that self-disables when `SENTRY_DSN` is unset, so DSN absence never breaks boot                                                                                                                                                                                                                                                             |
| Mobile               | `src/modules/observability/` — `ErrorBoundary`, `withScreenErrorBoundary`, Crashlytics, Sentry, `fileLog`                                                                                                                                                                                                                                                            |

**`ops_audit` is fail-closed for critical actions.** `OpsAuditService.record()` is
best-effort by default, but for `booking.approve/reject/dispatch/complete`,
`agent.approve/reject/terminate`, `mission.abort/complete`, `sos.*`,
`wallet.payout`, `dispute.resolve` and `dispatch.full_read` a failed insert
**re-throws**, so the surrounding transaction rolls back. A state change either
commits with its audit row or does not happen. `dispatch.full_read` is the
sharpest case: it is a _read_ that discloses the principal's exact pickup and
drop-off, so if the system cannot record who read it, it must not disclose it.

**Never logged:** plaintext message bodies, decrypted media, key material, or
`ArrayBuffer`s containing key bytes. This is enforced by a static test,
`src/modules/messenger/__tests__/logAudit.test.ts`, across `src/modules/messenger`,
`apps/messenger-service/src` and `packages/messenger-core/src`. Renaming a
variable to evade it is out of bounds.

### 2.11.2 Error handling

| Level          | Behaviour                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Controller     | Throws NestJS exceptions; the default filter maps them to status + body                                                                                |
| Service        | Domain errors as `BadRequestException`/`ForbiddenException`/`NotFoundException` with a `{code, …}` body the client can branch on                       |
| Transaction    | `withTransaction` rolls back and re-throws the _original_ error; a failed rollback is logged separately                                                |
| Side effects   | Push, system messages and Redis publishes are **fire-and-forget after commit** — a failed notification must never fail the transaction it followed     |
| Concurrency    | Conditional `UPDATE … WHERE status = <expected>` → `booking_state_changed_concurrently`; a `40P01` deadlock victim retries once                        |
| Mobile network | 401 → single-flight refresh → replay once; transient failures keep the session; genuine auth failure clears it and emits `onAuthLost`                  |
| Mobile UI      | `ErrorBoundary` at the root, `withScreenErrorBoundary` per screen; server `message` surfaced (never a raw `code`) via `humanCreditMessage` and friends |

---

## 2.12 Background jobs and services

### 2.12.1 The convention (read before adding one)

`auth-service` runs **multiple replicas**, so a bare `setInterval` double-fires —
double cascade, double charge, double expiry. Every background loop therefore
follows the pattern documented in `apps/auth-service/src/dispatch/README.md`:

- `@Injectable()` implementing `OnModuleInit` / `OnModuleDestroy`;
- `setInterval` started in `onModuleInit`, cleared in `onModuleDestroy`;
- each tick takes a Redis lock with
  `redis.client.set(LOCK_KEY, ts, 'PX', LOCK_TTL_MS, 'NX')`, bails unless the
  reply is `'OK'`, and releases in `finally`;
- `LOCK_TTL_MS` shorter than the interval so a crashed pod self-releases.

> **`@nestjs/schedule` is deliberately NOT a dependency of `auth-service`.** Adding
> it would reintroduce the per-pod double-fire this convention exists to prevent.
> (`messenger-service` _does_ use it, and guards the ones that must be singular
> with `replica-lock.ts`.)

### 2.12.2 `auth-service` sweeps

| Service                                          | Interval | Redis lock                      | Job                                                               |
| ------------------------------------------------ | -------: | ------------------------------- | ----------------------------------------------------------------- |
| `offer-expiry.service`                           |      8 s | `lock:dispatch-offer-expiry`    | Expire timed-out dispatch offers, cascade to the next agency      |
| `scheduled-dispatch.service`                     |     60 s | `lock:scheduled-dispatch`       | Start dispatch for `later` bookings near pickup time              |
| `crew-sla.service`                               |     60 s | `lock:dispatch-crew-sla`        | `CONFIRMED → AGENCY_NO_SHOW` when crew is never assigned          |
| `arrival-noshow.service`                         |     60 s | `lock:dispatch-arrival-noshow`  | Re-dispatch when crew never reaches pickup (escrow hold persists) |
| `relist-timeout.service`                         |     60 s | `lock:dispatch-relist-timeout`  | Re-list a stalled job                                             |
| `booking-reminder.service`                       |     60 s | `lock:booking-reminder`         | T-60 reminder for scheduled bookings                              |
| `payment-pending-expiry.service`                 |     60 s | `lock:payment-pending-expiry`   | Expire unpaid `PAYMENT_PENDING` bookings                          |
| `escrow-release-sweep.service`                   |     60 s | `lock:escrow-release`           | Release matured escrow holds                                      |
| `dispatch-slo.service`                           |     60 s | `lock:dispatch-slo`             | SLO metrics                                                       |
| `attendance-rollup.service`                      |      5 m | `lock:attendance-absent-rollup` | Roll up absences                                                  |
| `dispatch-privacy-purge.service`                 |      5 m | `lock:dispatch-privacy-purge`   | Retention purge of precise-location disclosures                   |
| `mission-drift-janitor.service`                  |     10 m | `lock:mission-drift-janitor`    | Reconcile missions that drifted from their booking                |
| `escrow-reconciliation.service`                  |     24 h | `lock:escrow-recon`             | Daily ledger vs. balance reconciliation                           |
| `pro-lapse.cron` · `wallet-expiry.cron`          |   hourly | (own keys)                      | Lapse Pro windows; expire credit batches                          |
| `vbg.service` watchdog · `newsfeed.service` warm |     10 m | —                               | Overdue-monitoring sweep; news cache warm                         |

### 2.12.3 `messenger-service` jobs

| Job                                             | Schedule      | Purpose                                       |
| ----------------------------------------------- | ------------- | --------------------------------------------- |
| `envelope-sweep`                                | every 5 min   | Purge expired relay envelopes (dwell ceiling) |
| `presence.reaper`                               | every 5 min   | Drop stale presence entries                   |
| `archive-retry-outbox`                          | every 5 min   | Retry failed backup-archive writes            |
| `relay.orphan-sweep`                            | daily 03:00   | Orphaned relay rows                           |
| `backup.archive-sweep`                          | daily 03:30   | Backup archive retention                      |
| `media.orphan-sweep`                            | daily 04:00   | Unreferenced S3 objects                       |
| JTI recheck                                     | 60 s interval | Disconnect sockets whose token was revoked    |
| SFU zombie sweeper                              | interval      | Reap rooms whose participants all vanished    |
| Push token GC · presence re-assert · adapter GC | interval      | Transport hygiene                             |

---

## 2.13 Required demonstration — one complete transaction, end to end

> **Checklist requirement:** _User Action → UI → API → Backend Logic → Database →
> Response → UI._

The transaction demonstrated is **"Client books an on-demand protection detail
(Bravo Lite auto-dispatch), an agency accepts, and the client is charged."** It is
chosen because it exercises every layer in this document: validation, tier gating,
pricing, FSM, transactions with row locks, escrow, background sweeps, cross-service
Redis, privacy-preserving push, and the return trip to the UI.

### 2.13.1 Sequence

```
 CLIENT APP            auth-service            PostgreSQL        Redis        messenger-svc      AGENCY APP
     │                       │                      │              │                │               │
 (1) tap "Confirm"           │                      │              │                │               │
     │  bookingStore.submit  │                      │              │                │               │
 (2) POST /dispatch/request ──────────────────────▶ │              │                │               │
     │  Idempotency-Key      │                      │              │                │               │
     │                  (3) JwtAuthGuard → jti:… ───┼────────────▶ │                │               │
     │                  (4) ValidationPipe → DTO    │              │                │               │
     │                  (5) BookingService.create() │              │                │               │
     │                       │  tier · one-active · region ·       │                │               │
     │                       │  lead-time · consent · add-ons ─────▶ SELECT          │               │
     │                       │  PricingService.calculate()         │                │               │
     │                       │  resolvePayer + affordability ──────▶ SELECT          │               │
     │                       │  fsm.assert(DRAFT→PENDING_OPS)      │                │               │
     │                       │  INSERT lite_bookings ─────────────▶ INSERT           │               │
     │                       │  + lite_booking_audit ──────────────▶ INSERT           │               │
 (6) ◀── 201 {booking: {id, status:'PENDING_OPS', total_aed, …}}   │                │               │
 (7) UI → "Awaiting approval"│                      │              │                │               │
     │                       │                      │              │                │               │
     │            (8) OPERATOR approves in the console             │                │               │
     │                POST /ops/bookings/:id/approve               │                │               │
     │                       │  txn: FOR UPDATE → assertRegionScope →              │               │
     │                       │       fsm.assert → UPDATE … WHERE status='PENDING_OPS'               │
     │                       │  ops_audit (fail-closed) ──────────▶ INSERT           │               │
     │                       │  bookingPush.bookingApproved ──────┼──▶ SET push-event:<uid>:<eid>   │
     │                       │                                    │   PUBLISH push:events            │
     │                       │  PUBLISH dispatch:ops-approved ────┼──▶                │               │
 (9) ◀── FCM {eventClass:'booking', eventId} ───────┼──────────────┼──── ships data-only push        │
(10) GET /events/by-id/:eventId ──────────────────▶ │  reads push-event:<uid>:<eid>  │               │
     │ ◀── {kind:'booking-approved', bookingId}     │              │                │               │
(11) notifee draws "Booking approved"               │              │                │               │
     │                       │                      │              │                │               │
     │           (12) OpsApprovedDispatchService (one pod, Redis-locked)             │               │
     │                       │  dispatch.start(): OPS_APPROVED → DISPATCHING ─────▶ UPDATE           │
     │                       │  offerNext(): rank agencies, INSERT dispatch_offers (expires +30s)    │
     │                       │  push.dispatchOffer ───────────────┼────────────────┼──────────────▶ (13) offer
     │                       │                      │              │                │               │
     │                       │ ◀────────────── (14) POST /dispatch/offers/:id/accept ───────────────│
     │                       │  txn: FOR UPDATE offer → IDOR check →                │               │
     │                       │       UPDATE … WHERE status='OFFERED' AND expires_at>NOW()           │
     │                       │       settleWonOffer():                              │               │
     │                       │         · accept accounting on agents                │               │
     │                       │         · wallet.holdToEscrow()  ──▶ debit client, credit escrow     │
     │                       │         · assigned_provider_user_id (single writer)  │               │
     │                       │         · fsm DISPATCHING → CONFIRMED                │               │
     │                       │       COMMIT ──────────────────────▶ one atomic write │               │
     │                       │  push.providerAccepted ────────────┼──▶ push:events   │               │
(15) ◀── FCM wake → hydrate → "Agency accepted"     │              │                │               │
(16) GET /bookings/:id ────────────────────────────▶ SELECT → {status:'CONFIRMED', team, verify code}│
(17) UI → live tracking screen                      │              │                │               │
```

### 2.13.2 The same flow, layer by layer

|   # | Layer           | Where                                                                    | What happens                                                                                                                                                                                                                                                                                                                                                                 |
| --: | --------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | **User action** | `src/screens/booking/…` review screen                                    | The client confirms the quoted detail.                                                                                                                                                                                                                                                                                                                                       |
|   2 | **UI → store**  | `src/store/bookingStore.ts` → `submit`                                   | Builds `BookingCreateBody` from the draft; reads `auto_dispatch_enabled` from `authStore` (**fail-closed to the legacy path** if `/auth/me` has not confirmed it); stamps versioned location + terms consent; runs an **advisory** affordability check that routes to the paywall _before_ dispatch rather than blocking.                                                    |
|   3 | **Store → API** | `src/services/api.ts` → `bookingApi.requestAuto(body, key)`              | Request interceptor attaches the bearer token; a per-attempt `Idempotency-Key` prevents a network-blip retry creating two bookings.                                                                                                                                                                                                                                          |
|   4 | **API guard**   | `common/guards/jwt-auth.guard.ts`                                        | Verify HS256 + `iss`/`aud`; `EXISTS jti:<jti>` in Redis.                                                                                                                                                                                                                                                                                                                     |
|   5 | **Validation**  | `booking/dto/create-booking.dto.ts` + global `ValidationPipe`            | Unknown fields stripped; types coerced.                                                                                                                                                                                                                                                                                                                                      |
|   6 | **Business**    | `booking/booking.service.ts` → `create()`                                | Tier gate (itinerary = Pro) · one-active-booking guard (with the parked-reservation carve-out and a 3-reservation cap) · region support · lead time · consent · Executive-Protection block validation · add-on resolution (**reject, never silently reprice**) · vehicle/seat capacity · `PricingService.calculate()` · payer resolution + family spend cap · affordability. |
|   7 | **FSM**         | `booking/state-machine.service.ts`                                       | `fsm.assert('DRAFT','PENDING_OPS','CLIENT')`.                                                                                                                                                                                                                                                                                                                                |
|   8 | **Database**    | `database/database.service.ts` → `qOne(INSERT … RETURNING *)`            | One row in `lite_bookings` carrying the **resolved** add-on set, the itemised `pricing_breakdown`, consent stamps, payer, referral attribution; plus a `lite_booking_audit` row.                                                                                                                                                                                             |
|   9 | **Response**    | `booking.controller.ts`                                                  | `201 {booking: ClientBooking}`.                                                                                                                                                                                                                                                                                                                                              |
|  10 | **UI**          | `bookingStore` → screens                                                 | Booking unshifted into the list (**deduped by id**), the wizard draft cleared, "Awaiting approval" rendered.                                                                                                                                                                                                                                                                 |
|  11 | **Operator**    | `apps/ops-console/src/app/bookings/[id]` → `ops.service.approveBooking`  | Transaction: `FOR UPDATE` → `assertRegionScope` → `fsm.assert` → conditional `UPDATE`. Fail-closed `ops_audit` row. Then, after commit: push wake + `PUBLISH dispatch:ops-approved`.                                                                                                                                                                                         |
|  12 | **Push**        | `ops/booking-push-bridge.service.ts` → `messenger-service` `PushService` | Detail blob into Redis (900 s TTL, recipient-bound key); only `{userId, eventClass, eventId}` on the wire; a durable `notifications` row is written **unconditionally**, even if Redis threw.                                                                                                                                                                                |
|  13 | **Device**      | `src/modules/messenger/push/serverWakeNotifications.ts`                  | `hydratePushEvent()` calls `GET /events/by-id/:eventId` (with a 401 → refresh → retry), then `notifee` draws on the `booking-updates` channel.                                                                                                                                                                                                                               |
|  14 | **Dispatch**    | `dispatch/ops-approved-dispatch.service.ts` → `dispatch.service.ts`      | One pod (Redis-locked) runs `start()` then `offerNext()`; a `dispatch_offers` row with a 30 s expiry; the agency is woken on the `dispatch-offers` channel.                                                                                                                                                                                                                  |
|  15 | **Accept**      | `dispatch.service.ts` → `acceptTxn` → `settleWonOffer`                   | Lock → IDOR check → conditional win → accept accounting → `holdToEscrow` → single-writer assignment → `DISPATCHING → CONFIRMED`, all in one transaction.                                                                                                                                                                                                                     |
|  16 | **Response**    | `POST /dispatch/offers/:id/accept`                                       | `{offer_id, booking_id, status: 'CONFIRMED'}` to the agency; a push wake to the client.                                                                                                                                                                                                                                                                                      |
|  17 | **UI**          | `bookingStore.loadBooking` → `GET /bookings/:id`                         | The client sees `CONFIRMED`, the assigned team, and the verify code; the screen switches to live tracking. Polling backs up the push, so a dropped wake degrades rather than breaks.                                                                                                                                                                                         |

### 2.13.3 What this demonstration is meant to prove

- **Every mutation is transactional and lock-ordered.** The wallet debit, the
  escrow credit, the provider assignment and the status flip are one commit.
- **Every transition is asserted against a table**, not an `if`.
- **Concurrency is handled by the database**, not by application timing —
  `FOR UPDATE` plus a conditional `UPDATE` means the loser of any race gets a
  deterministic, correct error.
- **Side effects follow the commit** and never fail it.
- **Push carries no business data**; the device pulls detail over the
  authenticated channel.
- **The client degrades to polling** whenever the real-time lane is lost.

### 2.13.4 Second demonstration — the end-to-end encrypted message path

The booking flow above is the _business_ transaction. The messaging flow is its
opposite in every respect, and it is included because it is the half of the
system a reader could otherwise mis-model: it **never touches Postgres and never
reaches the business API**, and no server on the path can read what it carries.

#### Outbound

```
 (1) ChatScreen — the composer is cleared BEFORE the await, so a slow send never
     eats the typed text.
 (2) sendText(conversationId, text, opts)        src/modules/messenger/runtime/
        │   Topology is decided by ONE function, messagingLogic.isGroupConversation.
        │   A conversation that denotes a 1:1 can never enter group fan-out.
        ├── 1:1 ──▶ optimistic bubble appended, then
        │             X3DH (fetch the peer bundle if there is no session)
        │             → Double Ratchet encrypt
        │             → Sealed Sender v2 seal (sender hidden from the relay)
        │             → outer wrap → ship → durable outbox row
        └── group ─▶ optimistic bubble, group master key re-read under the admin
                     lock, body encrypted once to the group key, then fanned out
                     per member over pairwise Signal sessions
 (3) Transport: WS `envelope.send` when the socket is up; HTTP relay POST otherwise.
 (4) The relay stores the opaque envelope in Redis under a dwell TTL
     (RELAY_DWELL_SECONDS, default 30 days — the Signal-protocol default) and wakes
     the recipient: over WS if connected, otherwise an FCM data push with no content.
```

#### Inbound

```
 (5) Two lanes deliver the same envelope — the WS handler and the HTTP drain used
     after being offline. They run the SAME validation set and the SAME ack rule;
     divergence between them is the single largest historical bug source here.
 (6) The whole receive runs inside one ratchet transaction:
        decrypt (the ratchet advances INSIDE the transaction)
        → mark seen (persistent dedup, so a redelivery cannot double-apply)
        → verifySenderCert
        → verifySealedAad
        → route to a lane: 1:1 text · group text · group admin · reaction ·
          edit / delete · call control
        → appendMessage + sqlMessages.upsert in the SAME transaction
 (7) The relay ack is sent only AFTER the commit, so every early return in the
     handler is an explicit decision to destroy or to accept the envelope —
     there is no neutral exit.
 (8) A TRANSIENT verification failure (clock skew) leaves the envelope on the relay
     to be redelivered; a stale or replayed one drops by design.
 (9) Persistence floor: one physical row per relay envelope, enforced by the primary
     key plus a partial UNIQUE index on `envelope_id` (schema v20). N inbound
     envelopes produce exactly N rows, in order, with no duplicates.
(10) A notification fires if and only if the row committed — in both directions.
```

#### The invariant contract this path is held to

| #   | Rule                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------- |
| 1   | One function decides "is this a group?" for message fan-out; call routing uses a differently named one.  |
| 2   | `sendText` never throws or returns above the optimistic bubble — typed text is never silently destroyed. |
| 3   | The WS and HTTP receive lanes run identical validation and identical ack rules.                          |
| 4   | A transient verification failure leaves the envelope redeliverable; a stale one drops.                   |
| 5   | Never log plaintext bodies, media or key material (statically enforced across five source roots).        |
| 6   | N envelopes → exactly N rows, in order, no duplicates.                                                   |
| 7   | Append and SQL upsert share one transaction; the ack happens only after COMMIT.                          |
| 8   | Drains and replays run OUTSIDE the receive transaction, each opening its own.                            |
| 9   | Lock order is the same everywhere: the global transaction chain first, then any finer lock.              |
| 10  | A replayed or stashed envelope passes the SAME gates as a live one.                                      |
| 11  | A notification never fires for an uncommitted message, and every committed message notifies.             |

Several of these are pinned by **static source scans** rather than unit tests,
because the file they guard cannot be imported by the Node test project. A source
scan is a real gate, but only as good as its anchor: strip comments before any
ordering or absence assertion, and remember these files are CRLF — a
newline-anchored regex written for LF matches nothing and the test passes
vacuously.

---

## 2.14 Verification appendix

Every claim above can be re-derived from the working tree. These commands were
used to produce the counts and inventories in this document.

```bash
# Surface sizes
for d in src apps/auth-service/src apps/messenger-service/src apps/ops-console/src packages/messenger-core/src; do
  echo "$d $(find $d -type f \( -name '*.ts' -o -name '*.tsx' \) | wc -l)"
done

# HTTP surface
grep -rh "@Controller(" apps/auth-service/src --include=*.ts | grep -v spec | sort -u
grep -rh "@Get(\|@Post(\|@Patch(\|@Put(\|@Delete(" apps/auth-service/src --include=*.ts | grep -v spec | wc -l

# WebSocket surface
grep -rh "^  @SubscribeMessage(" apps/messenger-service/src --include=*.ts | sort -u

# Guards
grep -rl "implements CanActivate" apps/auth-service/src apps/messenger-service/src --include=*.ts | grep -v spec

# Background loops and their locks
grep -rn "SWEEP_INTERVAL_MS *=\|LOCK_KEY *=\|@Cron(" apps/auth-service/src apps/messenger-service/src --include=*.ts | grep -v spec
```

### Quality gates that protect this architecture

| Gate              | Command                                                               | Enforces                                                      |
| ----------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| Mobile typecheck  | `npm run typecheck`                                                   | Must not exceed the baseline in `.tsc-baseline.json` (**47**) |
| Console typecheck | `cd apps/ops-console && npm run typecheck`                            | Own baseline                                                  |
| Crypto suite      | `npx jest --selectProjects messenger-crypto` (**run twice**)          | Signal/relay/backup invariants — known moving flake (B-126)   |
| Messenger screens | `npx jest --selectProjects app --testPathPattern "screens/messenger"` | The render tests the crypto project does not run              |
| Booking suite     | `npm test -- --selectProjects=booking`                                | Pricing, FSM, escrow                                          |
| Log audit         | part of the messenger suite (`logAudit.test.ts`)                      | No plaintext or key material reaches a log                    |
| Keyboard contract | `npx jest --selectProjects app --testPathPattern keyboardContract`    | The single keyboard-inset rule                                |
| Full local CI     | `npm run ci:local` / `npm run ci:full`                                | The bundle                                                    |

---

## 2.15 Reference summaries

Everything a reader would otherwise have to look up elsewhere is summarised here,
so this document stands on its own.

### 2.15.1 Codebase orientation

| Looking for                          | Location                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| Mobile entry and wiring              | `App.tsx` → `src/navigation/index.tsx` → `src/navigation/MainNavigator.tsx`        |
| Which shell a user gets              | `src/navigation/resolveRoute.ts` (pure) + `auth/account-kind.ts` (server-side)     |
| Send / receive a message             | `src/modules/messenger/runtime/productionRuntime.ts` + the `runtime/*.ts` leaves   |
| Local encrypted storage + migrations | `src/modules/messenger/crypto/db.ts` (`SCHEMA_VERSION`)                            |
| Voice / video calls                  | `src/modules/messenger/webrtc/`, `runtime/callRegistry.ts`, `groupCallRegistry.ts` |
| Backup / restore / Merkle            | `src/modules/messenger/backup/`, `apps/messenger-service/src/backup/`              |
| File vault (MFA-gated)               | `apps/messenger-service/src/vault/` (`mfa.guard.ts`)                               |
| Auth / keys / sender certs           | `apps/auth-service/src/auth`, `.../keys`, `.../sender-cert`                        |
| Bookings, dispatch, missions, money  | `apps/auth-service/src/booking`, `.../dispatch`, `.../ops`, `.../wallet`           |
| Operator console pages               | `apps/ops-console/src/app/<route>/page.tsx`                                        |
| Shared crypto library                | `packages/messenger-core/src/`                                                     |

**Golden rule:** mobile (`src/modules/messenger/`) is the source of truth for
crypto; `packages/messenger-core/` is the extracted shared copy that the ops
console consumes. The same concerns — crypto, transport, groups — exist in all
three places and must be kept in sync.

### 2.15.2 Database, in one paragraph

PostgreSQL **17.6** on Supabase, with PostGIS 3.3 for geofences and last-known
positions. The `public` schema holds **103 tables, 1,106 columns, 296 indexes,
148 foreign keys, 75 check constraints, 26 unique constraints, 16 enum types, 17
functions and 19 triggers**, and no views. Row-level security is enabled on **all
103 tables** and denies the `anon` role everywhere — which is why the public
Supabase anon key can safely ship inside the Android package. `auth-service`
connects over TCP as `postgres` (which holds `BYPASSRLS`); `messenger-service`
reaches PostgREST with the service-role key; mobile uses Supabase Storage only
and never queries tables. Primary keys default to `gen_random_uuid()`.
Table-by-table detail belongs to the database-architecture section of this
handover, not to §2.

### 2.15.3 Cryptographic contract (the locked parts)

| Concern               | Implementation                                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key agreement         | X3DH (`@privacyresearch/libsignal-protocol-typescript`)                                                                                                         |
| Message encryption    | Double Ratchet, per-session message keys                                                                                                                        |
| Metadata protection   | Sealed Sender v2 — the relay never learns the sender                                                                                                            |
| Group messaging       | Sealed-sender broadcast; group state encrypted under the group master key and distributed over pairwise Signal sessions; rekey on member removal, epoch-tracked |
| Local storage         | SQLCipher SQLite; page key from the hardware keystore; message ciphertext stored apart from key material                                                        |
| Media attachments     | AES-256-CBC, unique key per file, encrypted on device before upload to S3-compatible storage; the key travels in-band inside the encrypted envelope             |
| Voice / video         | WebRTC with DTLS-SRTP; signalling over the WS gateway; SFrame for group-call media, with the SFU forwarding bytes it cannot read                                |
| Backups               | Encrypted mirror with signed Merkle commits; restore verifies the root before applying                                                                          |
| Disappearing messages | Client-side timer plus a server instruction to purge the relay cache                                                                                            |

**Stop conditions — verify against the architecture reference before changing:**
encryption primitives (algorithm, mode, key length, IV/nonce handling);
sealed-sender envelope shape, sender-cert verification, AAD binding; group
master-key distribution, rekey and epoch handling; auth tokens (access, refresh,
action, sender certs), session storage, biometric/TOTP gates; relay dwell
semantics, ack/retract tokens, envelope-id handling; the File Vault MFA gate and
download-URL issuance. Never add a "skip in dev" branch to an existing check, and
never weaken Merkle commit verification to make a restore succeed.

### 2.15.4 Messenger backend contract

The relay **transports**; it does not store conversations. Envelopes live in
Redis under a dwell ceiling (`RELAY_DWELL_SECONDS`, default **30 days**) and are
deleted on ack or by the sweep. Pull pages are capped (default 100 per request),
and an outer-sealed body above the configured ceiling is rejected outright rather
than truncated. The WS gateway carries presence, typing and read-receipt fan-out
— none of which contain message content. Group membership and admin lists are
opaque to the server. The mediasoup SFU forwards media only and never holds
SFrame keys.

### 2.15.5 Verification loops that govern changes here

Three module-specific loops sit alongside the general change-safety gates. Their
essentials:

| Loop                 | Applies to                                                                                 | Non-negotiables                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lite booking**     | Client booking screens, agency dispatch, CPO mission, escrow/payout, booking notifications | All three actors must be exercised: client (book → cancel while waiting → resume freely → notified at every step → verify code shows → money deducted accurately), agency (receive offer → assign CPO → monitor mission → top-up/payout), CPO (assigned job → live mission → real-time GPS → pickup / go-live / complete). Run once as a baseline and again as a regression. |
| **Backup / Merkle**  | Mirror pipeline, Merkle commits, restore/repair, ratchet snapshots, backup screens         | Idle boots upload nothing (persistent flush ledger); every flush owes a commit; the verifier is never weakened; repair never launders bad state; a server wipe purges the ledger. A new `root_mismatch` is answered by asking "what wrote server bytes without a covering commit?" — never by softening verification.                                                        |
| **Message pipeline** | Send, receive, message store, receive transaction, notifications, the call→message seam    | The invariant contract in §2.13.4; the caller-completeness protocol for any change to a shared symbol (list every call site and prove each is updated or unaffected); and the knowledge that a green suite is not evidence, because no test imports `productionRuntime.ts`.                                                                                                  |

Two traps that have each cost a full working session: the crypto Jest project
**flakes intermittently**, so one red run is not evidence — run it twice, and only
a failure naming the same test both times is real; and line numbers in internal
notes go stale within days, so re-grep the symbol rather than trusting a stamped
line.

### 2.15.6 Known-issues register

A running QA log lives at the repository root as `sqa.md` — roughly 22,800 lines
covering **134 numbered bugs** with status, root cause, log evidence and the files
involved, plus the device-and-identity reference used for on-device testing. The
standing rule from B-143 onward is that **a bug is not fixed until a test would
catch it coming back**: a fix lands together with a test that was red first
(mutation-proved by reverting the fix), and a bug that is found but not fixed
lands a test pinning the current broken behaviour under a `DOCUMENTS B-NNN` name,
which the eventual fix commit flips. Those tests are never deleted to make a run
green.
