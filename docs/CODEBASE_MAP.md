# Bravo Secure — Codebase Map (the "hunting tree")

> **Purpose:** entry point for any fresh Claude/agent session. Read this first to
> understand the codebase _without_ scanning every file. It is a 3-layer tree:
>
> - **Layer 1 — Surfaces & wiring:** the 5 deployable pieces and how they talk.
> - **Layer 2 — Module tree:** the directories inside each surface + one-line purpose.
> - **Layer 3 — "Go here for X" index:** the key files to open per task.
>
> **How to hunt:** start at Layer 1 to pick a surface → drop into that surface in
> Layer 2 to pick a module → use Layer 3 to jump to the exact file.
>
> **Companion docs (not duplicated here):** `CLAUDE.md` (rules, commands, security
> constraints — authoritative), `sqa.md` (bug log + device reference, read for any QA
> task), `docs/architecture/MESSENGER_BACKEND.md` / `docs/audits/BACKEND_AUDIT.md` /
> `docs/architecture/ARCHITECTURE_COMPLIANCE.md` (deep dives). Full index:
> `docs/README.md`. When this map and `CLAUDE.md` disagree, `CLAUDE.md` wins.
>
> 🔒 = security-sensitive zone. Do not change behavior here without checking the
> System Architecture Documentation (see `CLAUDE.md` → Security constraints).

---

## Layer 1 — Surfaces & how they connect

```
                         ┌──────────────────────────┐
   React Native (mobile) │  packages/messenger-core │  Next.js (ops-console)
   src/  ───────────────▶│  shared libsignal +      │◀───────────────  apps/ops-console/
   CPOs / agents / users │  sealed-sender + groups  │  operator dashboard
        │                └──────────────────────────┘                │
        │                  (E2EE; mobile = source of truth)           │
        │                                                             │
        ▼                                                             ▼
   ┌─────────────────────────────┐              ┌──────────────────────────────┐
   │   apps/auth-service (Nest)  │              │ apps/messenger-service (Nest) │
   │   Postgres                  │              │ Redis                         │
   │   auth, /ops/*, agents,     │              │ relay (transient store),      │
   │   bookings, missions,       │              │ WS gateway (presence/typing), │
   │   payouts, signal-keys,     │              │ sealed-sender envelopes,      │
   │   sender-cert issuance      │              │ group msg, file vault, SFU    │
   └─────────────────────────────┘              └──────────────────────────────┘
```

| Surface               | Path                          | Stack                                | Role                                                                              |
| --------------------- | ----------------------------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| **Mobile** (primary)  | `src/`, `App.tsx`, `index.js` | RN 0.81 + Expo 54, TS, Zustand       | The product: CPOs, agents, customers. Most code lives here.                       |
| **Ops Console**       | `apps/ops-console/`           | Next.js 15 App Router, SWR, Tailwind | Operator dashboard (dispatch, live map, finance, messenger).                      |
| **Auth service**      | `apps/auth-service/`          | NestJS + Postgres                    | Auth, ops/dispatch APIs, bookings, missions, agents, wallet, keys.                |
| **Messenger service** | `apps/messenger-service/`     | NestJS + Redis                       | Message relay, WS presence, group calls (SFU), file vault.                        |
| **Shared core** 🔒    | `packages/messenger-core/`    | TS (platform-agnostic)               | The crypto/transport library mobile + ops both consume (`@bravo/messenger-core`). |

**Golden rule:** mobile (`src/modules/messenger/`) is the source of truth for crypto;
`packages/messenger-core/` is the extracted shared copy; ops-console consumes the package.
The same files (crypto, transport, groups) appear in all three — keep them in sync.

---

## Layer 2 — Module tree per surface

### 📱 Mobile — `src/` (436 files; `modules/messenger` is ~56% of it)

```
src/
├── modules/                 cross-cutting domains (the brains)
│   ├── messenger/    🔒      244 files — E2EE chat, calls, backup. THE core. (expanded below)
│   ├── news/                threat/news feed (vbg-related)
│   ├── booking/             booking domain logic
│   ├── observability/       client telemetry/logging
│   └── vbg/                 "very big group" / threat intel hooks
├── screens/                 UI per feature area
│   ├── messenger/ (27)      chat list, conversation, calls, group call
│   ├── agent/ (28)          CPO/agent operational screens
│   ├── booking/ (17)        customer booking flow
│   ├── pro/ (15)            CPO ("protector") onboarding/profile
│   ├── auth/ (10)           login / register / verify
│   ├── vbg/, news/, ops/, settings/, wallet/, liveops/, dashboard/
├── navigation/              React Navigation stacks (one *Navigator.tsx per area)
├── store/                   Zustand: authStore, messengerStore, bookingStore, walletStore…
├── services/                external SDK clients: api, supabase, stripe, twilio, agora
├── hooks/                   useLocation, useRealtimeMessages, useBookingRealtime, useTransportRtt
├── components/              shared UI primitives (ScreenContainer, DynIcon, video tile…)
├── theme/                   colors, typography, bravo design tokens
├── utils/  types/           helpers, scaling, tier, constants, shared types
```

#### 🔒 `src/modules/messenger/` (expanded — this is where most work happens)

```
messenger/
├── crypto/      (18)  🔒 libsignal: identity, sessionManager, sealedSender, senderCert,
│                          groupCrypto, sqlCipherStore (SQLCipher-backed signal store)
├── runtime/     (20)     productionRuntime.ts = orchestrator; receiveTransaction, messagingLogic,
│                          call*Registry, expirySweeper (disappearing msgs), wipeAtRest
├── transport/   (7)      HTTP/WS clients: relayClient, keysClient, senderCertClient, usersClient
├── webrtc/      (30)     1:1 + group calls: callController, peerConnection, useCall, useGroupCall,
│                          frameCryptor* (call media E2EE), sfuDispatcher, signallingClient
├── backup/      (18)  🔒 encrypted backup/restore: backupCrypto, backupMerkle, ratchetSnapshot,
│                          restoreMessages, messageMirror
├── store/       (11)     SQL stores: sqlMessageStore, sqlOutboxStore, messengerStore,
│                          groupMasterKeyStore, seenEnvelopeStore, privacySettings
├── ui/ (12)  push/ (9)  media/ (6)  vault/ (4)  groups/ (3)  hooks/ (2)  contacts/ (2)
└── __tests__/  (100)     the crypto/runtime regression safety net — run via test:crypto
```

### 🖥️ Ops Console — `apps/ops-console/src/`

```
app/                      Next.js App Router routes (each = a dashboard page)
├── live/ (3)  jobs/  bookings/  agents/  finance/  departments/  analytics/
├── messenger/  settings/  login/  dashboard/  + layout.tsx, page.tsx
lib/
├── messenger/  🔒        browser port of messenger-core: crypto, keys, relay, runtime,
│                          protocolStore, idb (IndexedDB vault), webauthnPrf (vault MFA)
├── api.ts                backend HTTP client      ├── rbac.ts  role gating
components/
├── Shell.tsx  BravoMap.tsx  Redacted.tsx
└── messenger/            MessengerProvider, MissionGroupPanel, VaultUnlockModal
middleware.ts             auth/route protection
```

### ⚙️ Auth service — `apps/auth-service/src/` (Postgres)

```
main.ts · app.module.ts · config/
├── auth/        (14)  🔒 login/register/verify, jwt.service, refresh, sessions
├── ops/         (25)     dispatch brain: ops.controller, mission/job state-machines,
│                          job-feed, mapbox-directions, system-messenger, admin.guard
├── booking/     (15)     booking.service, pricing, state-machine, cpo-assignment, vehicle-pool
├── agents/      (7)      agent lifecycle, mission-lead, state-machine
├── keys/        (6)   🔒 signal prekey upload/fetch, bundle-binding
├── sender-cert/ (6)   🔒 issues sealed-sender sender certificates (cert-format, service)
├── wallet/ (8)  org/ (8)  vbg/ (10)  family/ (5)  subscription/ (5)  attendance/ (5)
├── totp/ (5)  biometric/ (5)  sos/ (4)  department/ (4)  conversations/ (4)
├── telemetry/ (5)  observability/ (2)  redis/ (2)  kafka/ (2)  database/ (2)
└── common/      (14)     guards, decorators, filters, shared utils
```

### 📨 Messenger service — `apps/messenger-service/src/` (Redis)

```
main.ts · app.module.ts · config/
├── gateway/  (17)        WS: messenger.gateway, presence.service/cron, socket-hub,
│                          redis-io.adapter, ws-rate-limiter, connection-registry
├── relay/    (9)   🔒    transient envelope store (≤30d): envelope.controller/service/store,
│                          relay.cron (dwell purge), recipient-purge.guard
├── sfu/      (10)        group-call media server: sfu.service, sfuWorkerPool, room-token
├── vault/    (7)   🔒    file vault: vault.controller/service, mfa.guard (fresh biometric/TOTP),
│                          audit.log
├── push/ (5)  media/ (5)  backup/ (5)  turn/ (4)  auth/ (3)  redis/ (2)  common/ (4)
```

### 🔒 Shared core — `packages/messenger-core/src/` (mirror of mobile crypto)

```
crypto/    (13)   identity, sessionManager, sealedSender, senderCert, groupCrypto,
                  bundleBinding, outerEcies, callOfferAuth, callControlAuth
transport/ (7)    client, relayClient, keysClient, senderCertClient, usersClient, protocol
groups/    (3)    groupClient (group state encryption/distribution)
calls/     (3)    frameCryptorKeys, groupCallEncryption, sframe (call media E2EE)
runtime/   (2)    certCache, revokedJtiCache
index.ts          public surface re-exported as @bravo/messenger-core
```

---

## Layer 3 — "Go here for X" index (key files)

### Mobile entry & wiring

- App boots: `index.js` → `App.tsx` → `src/navigation/index.tsx` (+ `MainNavigator.tsx`).
- Messenger orchestrator: `src/modules/messenger/runtime/productionRuntime.ts` (boot order, wiring).
- Global state: `src/store/messengerStore.ts`, `authStore.ts`, `bookingStore.ts`.

### Send / receive a message 🔒

- Encrypt + seal: `packages/messenger-core/src/crypto/sessionManager.ts`, `sealedSender.ts` (the mobile `crypto/` copies are tombstone re-exports since audit 2026-08-13 #7).
- Inbound decrypt path: `runtime/receiveTransaction.ts`, `runtime/messagingLogic.ts`,
  `runtime/groupInboundBody.ts` (group text render).
- Wire transport: `packages/messenger-core/src/transport/relayClient.ts` (+ `client.ts` for the WS state machine; the mobile `transport/` copies were deleted in B-152 / tombstoned in audit #8).
- Server side: `apps/messenger-service/src/relay/envelope.service.ts` (+ `.store.ts`, `relay.cron.ts`).
- Local persistence: `src/modules/messenger/store/sqlMessageStore.ts`, `sqlOutboxStore.ts`.

### Voice / video calls

- 1:1: `src/modules/messenger/webrtc/callController.ts`, `useCall.ts`, `peerConnection.ts`,
  `signallingClient.ts`.
- Group: `webrtc/useGroupCall.ts`, `sfuDispatcher.ts`, `groupCall*`; server `apps/messenger-service/src/sfu/sfu.service.ts`.
- Call media E2EE 🔒: `webrtc/frameCryptor*`, `packages/messenger-core/src/calls/`.

### Groups 🔒

- Client: `packages/messenger-core/src/groups/groupClient.ts`; mobile `src/modules/messenger/groups/`.
- Master-key store + rekey: `src/modules/messenger/store/groupMasterKeyStore.ts`.

### Backup / restore 🔒

- `src/modules/messenger/backup/` — start at `backupBoot.ts`, `backupCrypto.ts`, `restoreMessages.ts`.

### File vault 🔒 (MFA gate — do NOT bypass)

- Server gate: `apps/messenger-service/src/vault/mfa.guard.ts`, `vault.service.ts`.
- Mobile UI: `src/modules/messenger/vault/`; ops: `apps/ops-console/src/lib/messenger/idb.ts`, `webauthnPrf.ts`.

### Auth / keys / sender certs 🔒

- Login/JWT: `apps/auth-service/src/auth/auth.service.ts`, `jwt.service.ts`.
- Prekeys: `apps/auth-service/src/keys/keys.service.ts`, `bundle-binding.ts`.
- Sender certs: `apps/auth-service/src/sender-cert/sender-cert.service.ts`.

### Ops / dispatch / bookings (backend)

- Dispatch + missions: `apps/auth-service/src/ops/` (`ops.service.ts`, `mission-state-machine.service.ts`,
  `job-feed.service.ts`). Approval-500 history lives here (see recent commits).
- Bookings: `apps/auth-service/src/booking/booking.service.ts`, `cpo-assignment.service.ts`, `pricing.service.ts`.

### Ops Console (frontend)

- Live map page: `apps/ops-console/src/app/live/`; component `components/BravoMap.tsx`.
- Backend calls: `apps/ops-console/src/lib/api.ts`; access control: `lib/rbac.ts`.

### Tests (the safety net)

- Crypto/messenger: `src/modules/messenger/__tests__/` → `npm run test:crypto`.
- Booking project: `npm test -- --selectProjects=booking`.
- Log-audit (no plaintext/keys in logs) 🔒: `packages/messenger-core/__tests__/logAudit.test.ts`.

### Build / release

- Version: `app.json` (`expo.version`) + `android/app/build.gradle` (`versionCode`/`versionName`).
- Release flow: see `MEMORY` notes / `release-apk.ps1`; commands in `CLAUDE.md` → Build/run/test.

---

## Maintenance

This map is hand-maintained. When you add a top-level module or surface, update Layer 2.
File counts are approximate (snapshot of `git ls-files`) — treat them as relative weight,
not exact. The `code-review-graph` MCP (see `CLAUDE.md`) is the live, queryable version of
this tree when it is connected.
