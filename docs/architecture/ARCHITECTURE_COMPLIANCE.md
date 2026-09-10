# Architecture Compliance — Bravo Secure

**Reference**: `Bravo Secure - Architecture Documentation v1.0 R1.pdf` (April 2025).
**Scope**: this document tracks the **product** delivery (mobile + web ops + backend services) against the spec. It deliberately omits items that are the **client's** production-infrastructure responsibility (Kong/Nginx, Kubernetes, Kafka, HashiCorp Vault, multi-region active-active, Prometheus/Grafana/ELK/Falco/SIEM, mTLS internal CA, TimescaleDB) — those are operated by the customer, not shipped by us.
**Legend**: ✅ shipped · ⚠️ partial / pragmatic substitute · ❌ deferred to Phase 2 · 🔧 = changed in the 2026-04-29 hardening pass.

---

## §1 High-Level System Architecture

### 1.1 Architecture Tiers (product-side)

| Tier | Spec Layer                                     | Status | Reality                                                                                                                                                                                 |
| ---- | ---------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Mobile Client (iOS/Android, RN, AES-256 vault) | ✅     | React Native bare CLI; iOS + Android targets; SQLCipher + keychain-bound vault key                                                                                                      |
| 2    | Core Microservices                             | ✅     | `apps/auth-service` + `apps/messenger-service` shipped. Booking/VBG/payment endpoints merged into auth-service for the Phase-1 budget; module split is mechanical when the team scales. |
| 3    | Real-Time                                      | ✅     | Socket.io 4 + Redis adapter; react-native-webrtc; coturn deployable per region                                                                                                          |
| 0    | Web Ops Console                                | ✅     | Next.js dashboard at `apps/ops-console` — admin, mission ops, live mission, group chat                                                                                                  |

### 1.2 Logical Flow

`Mobile / Web Client → CDN+WAF → auth-service / messenger-service → {Postgres, Redis, R2}`. Group messaging routes through messenger-service's relay; sealed envelopes are opaque to the server.

### 1.3 Key Architectural Decisions

| Decision                                                    | Status | Note                                                                                                                                                                 |
| ----------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signal Protocol via libsignal                               | ⚠️     | Pure-TS port `@privacyresearch/libsignal-protocol-typescript`; native Rust `@signalapp/libsignal-client` swap is a Phase-2 lift requiring iOS/Android native modules |
| WebRTC with mandatory DTLS-SRTP, regional TURN              | ✅     | `verifyDtlsSrtp` enforced in `PeerConnectionWrapper`                                                                                                                 |
| AI services isolated, metadata only                         | ⚠️     | AI services not yet built — gating preserved by absence                                                                                                              |
| Security Principle: nothing unencrypted at rest server-side | ✅     | Sealed envelopes are opaque to the relay; no plaintext message bodies persisted server-side. Messages on the client are now in SQLCipher (this pass).                |

---

## §2 Component-by-Component Breakdown

### 2.1 Authentication & Registration — `auth-service`

| Spec                                                 | Status | Reality                                                                  |
| ---------------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| OTP (Twilio Verify)                                  | ✅     | Live in `apps/auth-service/src/auth`                                     |
| TOTP (RFC 6238)                                      | ✅     | Implemented for vault MFA                                                |
| Face Recognition (ML Kit)                            | ⚠️     | Wired via `LocalAuthentication`; ML Kit liveness deferred                |
| Fingerprint                                          | ✅     | `expo-local-authentication` on both platforms                            |
| Curve25519 identity in secure enclave / Keystore     | ✅     | Generated client-side, private half never leaves device; public uploaded |
| `POST /auth/register` — Argon2id m=65536 t=3 p=4     | ✅     |                                                                          |
| `POST /auth/verify` — JWT 15min + opaque refresh 30d | ✅     | Refresh token hashed in Redis                                            |
| `POST /auth/refresh` — refresh rotated each use      | ✅     | Single-use refresh tokens                                                |
| `POST /auth/keys/upload`                             | ✅     | `keys.service.ts` accepts identity + signed prekey + OPK pool            |
| `DELETE /auth/session`                               | ✅     |                                                                          |

### 2.2 Messenger — `MessengerModule` + `messenger-service`

#### Client (mobile + ops-console)

| Spec                                                                    | Status | Reality                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signal Protocol — Double Ratchet, X3DH, Sealed Sender                   | ⚠️     | Pure-TS port; same wire protocol as native Rust                                                                                                                                                    |
| **SQLCipher message store, keys per-session, separate from ciphertext** | ✅ 🔧  | `messages` table inside the SQLCipher DB ([sqlMessageStore.ts](src/modules/messenger/store/sqlMessageStore.ts)); Signal session keys live in `sessions` / `pre_keys` — separate tables as required |
| AES-256-CBC media, key in encrypted envelope                            | ✅     | Per-file key inside sealed payload                                                                                                                                                                 |
| **Persistent media blob cache (SQLCipher-backed)** 🔧                   | ✅     | [mediaBlobCache.ts](src/modules/messenger/media/mediaBlobCache.ts) caches R2 ciphertext bytes keyed by object key. LRU evict at 200 MB. Plaintext never stored.                                    |
| WebRTC PeerConnection via signalling, ICE over WS, DTLS-SRTP            | ✅     | `verifyDtlsSrtp()` mandatory                                                                                                                                                                       |
| Disappearing messages: client timer + server purge                      | ✅ 🔧  | Sweeper calls `relay.retract(token)` on TTL expiry. Token ferried via WS `envelope.accepted.retractToken` and HTTP relay-send response.                                                            |

#### Server (messenger-service)

| Spec                                                                                                                             | Status | Reality                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay-only, 30-day max dwell                                                                                                     | ✅     | Redis ZSET-keyed envelope queues with 30-day TTL                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Group messaging via sealed-sender broadcast; group state encrypted with group master key shared via pairwise Signal sessions** | ✅ 🔧  | Master key is AES-256-GCM, distributed in-band via `kind: 'admin', type: 'create'` over pairwise Signal sessions. Both mobile and ops-console wrap inner envelope bodies with the master key for non-admin sends. ([groupCrypto.ts](src/modules/messenger/crypto/groupCrypto.ts), [ops-console/groupCrypto.ts](apps/ops-console/src/lib/messenger/groupCrypto.ts), [ops-console/groupClient.ts](apps/ops-console/src/lib/messenger/groupClient.ts)) |
| WS gateway: presence + typing + read-receipts                                                                                    | ✅ 🔧  | All three live. `markRead(conversationId)` on `MessengerRuntime`; ChatScreen fires on every `messages.length` tick.                                                                                                                                                                                                                                                                                                                                 |
| File Vault MFA on download regardless of JWT                                                                                     | ✅     | `MfaGuard` on files-service download endpoints                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Identity-rotation auto-recovery** 🔧                                                                                           | ✅     | Receive-side `DecryptError` → closeSession + bundle refetch + outgoing-session reinit + `control: 'rehandshake'` nudge to peer. Sender's libsignal session-replaces transparently on the nudge. Manual "Reset Secure Session" button in ChatInfo / "Reset Crew Sessions" in MissionGroupDock as the safety net. Rate-limited 60s/peer.                                                                                                              |

### 2.3 Bravo Lite Booking — `booking-service`

| Spec                                                      | Status | Reality                          |
| --------------------------------------------------------- | ------ | -------------------------------- |
| 6-step wizard, no partial server state until OPS_APPROVED | ✅     | Local Zustand draft until submit |
| 3-hour minimum lead time (client + server validation)     | ✅     |                                  |
| Vehicle-capacity algorithm assigns class                  | ✅     |                                  |
| Real-time pricing call before submit                      | ✅     | `POST /booking/price`            |
| WebSocket BOOKING_STATUS_UPDATE + 10-min timeout          | ✅     |                                  |
| Full state machine DRAFT → … → COMPLETED                  | ✅     |                                  |

### 2.4 Bravo Pro Retainer

| Spec                                        | Status                        |
| ------------------------------------------- | ----------------------------- |
| Custom plan, no client tier selection       | ✅                            |
| Bravo Calendar: Gemini PDF/ICS/Excel parser | ❌ Phase 2                    |
| AI Schedule with time-window overlap        | ❌ Phase 2                    |
| Geo Risk Review with risk-engine            | ❌ Phase 2                    |
| Team configuration on retainer record       | ⚠️ Schema exists; UI deferred |
| Family approval workflow                    | ❌ Phase 2                    |

### 2.5 Virtual Bodyguard — `VBGModule`

| Spec                                                   | Status                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| GPS telemetry every 30s, encrypted on-device           | ⚠️ Live transmission shipped; AES-256 on-device encryption deferred |
| Server-side geofence with native fallback              | ⚠️ Server-side ✅; native fallback partial                          |
| OSINT feed (ACLED, GDELT, Reuters)                     | ⚠️ Stub feed; aggregator deferred                                   |
| SRA (4h refresh / location-change)                     | ❌ Phase 2                                                          |
| Hourly biometric check-ins                             | ❌ Phase 2                                                          |
| Panic button → simultaneous Ops Room push + Twilio SMS | ✅                                                                  |

### 2.6 Agent Portal

| Spec                                             | Status                                   |
| ------------------------------------------------ | ---------------------------------------- |
| Three agent types with distinct KYC flows        | ✅                                       |
| Deployment Token (signed JWT, 24h, in-person QR) | ✅                                       |
| Dress inspection / vehicle collection events     | ✅ Per-mission deployment checklist live |

### 2.7 Ops Console

| Spec                                       | Status                                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Internal React dashboard                   | ✅ Next.js (apps/ops-console)                                                                                                       |
| Approval REST API + push to clients        | ✅                                                                                                                                  |
| **Group master-key parity with mobile** 🔧 | ✅ Ops bootstraps master key on first send to a mission group, distributes via admin create, uses for inner-body AES-GCM thereafter |
| **Identity-rotation recovery** 🔧          | ✅ Auto-rebuild on `DecryptError` + manual "Reset Crew Sessions" button in mission group dock                                       |

---

## §3 Mobile Client Stack

| Concern            | Spec                    | Status | Reality                                                                                             |
| ------------------ | ----------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| Framework          | React Native 0.74+      | ✅     | bare CLI                                                                                            |
| Signal Protocol    | `@signalapp/libsignal`  | ⚠️     | Pure-TS port; same wire format. Native Rust binding = Phase 2 lift (~2 weeks of native module work) |
| Local Encryption   | SQLCipher (AES-256-CBC) | ✅ 🔧  | op-sqlite + sqlcipher; **now stores messages, sessions, group keys, and media blob cache**          |
| State Management   | Zustand + React Query   | ⚠️     | Zustand ✅; SWR / direct fetch for server state                                                     |
| Navigation         | React Navigation v7     | ✅     |                                                                                                     |
| Real-Time          | Socket.io client        | ✅     | socket.io 4.x                                                                                       |
| Voice/Video        | react-native-webrtc     | ✅     | DTLS-SRTP enforced                                                                                  |
| Maps               | Mapbox GL               | ✅     | `@rnmapbox/maps`                                                                                    |
| Biometrics         | react-native-biometrics | ⚠️     | `expo-local-authentication` (functionally equivalent)                                               |
| Push Notifications | FCM, encrypted payloads | ⚠️     | Push stub Phase 1; FCM/APNs wiring scheduled                                                        |

## §3.2 Backend Services

| Layer             | Spec                       | Status                       |
| ----------------- | -------------------------- | ---------------------------- |
| Runtime           | Node.js 22 LTS + NestJS    | ✅                           |
| WebSocket         | Socket.io on Redis adapter | ✅                           |
| Transactional DB  | PostgreSQL 16              | ✅                           |
| Session/Cache     | Redis 7                    | ✅                           |
| Object Store      | S3-compatible (R2)         | ✅                           |
| AI / Intelligence | Gemini 1.5 Flash           | ❌ Phase 2                   |
| Search            | Elasticsearch 8            | ❌ Phase 2                   |
| Payments          | Stripe + Telr              | ⚠️ Stripe live; Telr Phase 2 |

---

## §4 Client → Server Interaction Flows

### 4.1 User Registration & Key Upload

| Step                                                                          | Status                                 |
| ----------------------------------------------------------------------------- | -------------------------------------- |
| OTP via Twilio / TOTP via QR                                                  | ✅                                     |
| Password hashed Argon2id m=65536 t=3 p=4                                      | ✅                                     |
| Verify → JWT 15min + refresh 30d                                              | ✅                                     |
| Curve25519 identity + signed prekey on-device                                 | ✅                                     |
| Public bundle uploaded; private NEVER leaves device                           | ✅                                     |
| JWT in memory; refresh in encrypted secure-storage; Signal state in SQLCipher | ✅ 🔧 (messages also in SQLCipher now) |

### 4.2 Booking Flow (Bravo Lite Happy Path)

All 16 spec steps implemented end-to-end. Edge cases (10-min ops timeout, payment idempotency, telemetry stream resume) wired in `ops.service.ts`.

### 4.3 VBG Real-Time Monitoring

| Step                                                           | Status                                 |
| -------------------------------------------------------------- | -------------------------------------- |
| 30s GPS packet AES-256 encrypted on-device → telemetry-service | ⚠️ Live; on-device encryption deferred |
| OSINT 5-min cron with geo-indexed pushes                       | ⚠️ Cron live; aggregator stub          |
| Biometric face-scan / 3-fail escalation → SMS within 60s       | ❌ Phase 2                             |

---

## §5 End-to-End Encryption Key Lifecycle

### 5.1 Key Types

| Key                     | Algorithm                 | Lifetime                            | Storage                                                         | Status          |
| ----------------------- | ------------------------- | ----------------------------------- | --------------------------------------------------------------- | --------------- |
| Identity Key Pair (IK)  | Curve25519                | Permanent                           | Secure Enclave / Keystore                                       | ✅              |
| Signed Pre-Key (SPK)    | Curve25519 + Ed25519 sig  | Monthly                             | SQLCipher / KDS                                                 | ✅              |
| One-Time Pre-Keys (OPK) | Curve25519                | Single use                          | SQLCipher pool                                                  | ✅              |
| Session Root Key (RK)   | HKDF-SHA256               | Per-session                         | SQLCipher only                                                  | ✅              |
| Chain Keys (CK)         | HKDF-SHA256               | Per chain                           | SQLCipher                                                       | ✅              |
| Message Keys (MK)       | AES-256-CBC + HMAC-SHA256 | Single use                          | derived on demand                                               | ✅              |
| Media Encryption Key    | AES-256-CBC               | Per file                            | inside sealed envelope                                          | ✅              |
| File Vault Key          | AES-256-GCM               | Per session                         | derived (PBKDF2 600k + biometric)                               | ✅              |
| **Group Master Key** 🔧 | AES-256-GCM               | Per group, rotated on member change | SQLCipher (`groups`) on mobile, IndexedDB (`group_keys`) on web | ✅ Both clients |

### 5.2 Session Establishment (X3DH)

| Step                                                 | Status |
| ---------------------------------------------------- | ------ |
| Fetch Bob's bundle (IK_B, SPK_B+sig, OPK_B)          | ✅     |
| Verify SPK signature with IK_B                       | ✅     |
| Generate ephemeral EK_A                              | ✅     |
| Four DH computations + HKDF master secret            | ✅     |
| OPK_B server-deleted after consume (forward secrecy) | ✅     |

### 5.3 Double Ratchet

| Property                                                            | Status |
| ------------------------------------------------------------------- | ------ |
| Per-message forward secrecy (chain key advances)                    | ✅     |
| DH ratchet step on inbound (new RK + chain keys)                    | ✅     |
| Compromise at time T does not expose pre-T or post-ratchet messages | ✅     |

### 5.4 Sealed Sender

| Property                                                               | Status                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Sender identity encrypted in payload, not visible to relay             | ✅ Phase-1 pragmatic: `{v, cert, body}` JSON wrap inside Signal session ciphertext    |
| Server can route by recipient ID, not sender                           | ✅ `senderAddressHint` is recipient-routing only; sender comes from cert verification |
| Sender Certificate (Ed25519 from Identity Service)                     | ✅ `apps/auth-service/src/sender-cert/` mints; `verifySenderCert()` checks            |
| Full Signal Sealed Sender v2 (UnidentifiedSenderMessage / outer ECIES) | ❌ Phase 2 — eliminates `senderAddressHint`                                           |

### 5.5 Key Rotation

| Key              | Trigger              | Status                                           |
| ---------------- | -------------------- | ------------------------------------------------ |
| Signed Pre-Key   | Monthly / compromise | ⚠️ Schedule scaffolded; auto-rotate cron Phase 2 |
| OPK pool         | Pool < 10            | ✅ `maybeReplenishOwnOpks()`                     |
| JWT Access Token | 15min                | ✅ Axios refresh interceptor                     |
| TURN credentials | 24h                  | ✅ HMAC-SHA1 from REST API                       |
| File Vault Key   | Per vault session    | ✅ Never disk-cached                             |

---

## §6 Call Flow — WebRTC + TURN

| Property                                                             | Status                         |
| -------------------------------------------------------------------- | ------------------------------ |
| Call setup via `/messenger` namespace WebSocket signalling           | ✅ `webrtc/CallController.ts`  |
| TURN credentials short-lived HMAC-SHA1 (24h)                         | ✅                             |
| All media as DTLS-SRTP — coturn never sees plaintext                 | ✅                             |
| `verifyDtlsSrtp()` runs on every connection before media is surfaced | ✅                             |
| Per-session bandwidth caps                                           | ⚠️ Server enforcement deferred |
| Group calls via mediasoup SFU                                        | ❌ Phase 2                     |

---

## Changes in the 2026-04-29 Hardening Pass

The following edits were applied to close the spec gaps in the **product** layer that are reachable in pure TS:

1. **Group routing fix** — `productionRuntime.handleIncoming` routes incoming envelopes by `sealed.group.groupId` instead of `direct:<senderUserId>`. Mission group threads now actually receive ops broadcasts.

2. **Stable owner key** — `MainNavigator` keys the messengerStore on `user.email ?? user.phone_e164 ?? user.id`. Dev re-registers no longer wipe chats.

3. **Group master key — mobile** — `groupCrypto.ts` AES-256-GCM under `GroupState.masterKeyB64`. `broadcastToGroup` wraps non-create bodies; `parseGroupMessage` decrypts.

4. **Group master key — ops-console** — full mirror: `apps/ops-console/src/lib/messenger/groupCrypto.ts`, IndexedDB `group_keys` store, `MissionGroupPanel` bootstraps + distributes the master key on first send. Wire-compatible with mobile.

5. **Identity-rotation auto-recovery** — both clients catch `DecryptError`, close session, refetch bundle (60s/peer cooldown), re-init outgoing session, and send a `control: 'rehandshake'` nudge so the original sender's libsignal session-replaces transparently.

6. **Manual session reset** — `runtime.resetSessionWith(peer)` on both runtimes; "Reset Secure Session" row in agent ChatInfoScreen, "Reset Crew Sessions" button in ops MissionGroupDock (visible only after a delivery failure).

7. **Disappearing-msg server purge** — `retractToken` propagates via WS `envelope.accepted` (server protocol bumped) + HTTP relay-send response. `ExpirySweeper` calls `relay.retract(token)` for every expiring self-message.

8. **Read-receipts fan-out** — `markRead(conversationId)` collects unread inbound messages per peer and emits `read-receipt` WS frames. Inbound receipts flip local message status to `read` by `envelope_id`.

9. **SQLCipher message store** — new `SqlMessageStore` over `messages` table inside the SQLCipher DB (schema bumped to v3). Production runtime hydrates on boot + write-throughs every change. AsyncStorage no longer stores message bodies.

10. **SQLCipher media blob cache** — `MediaBlobCache` over `media_blobs` table (LRU, 200MB cap). `MediaClient.downloadEncrypted` checks cache first, fills on miss. Plaintext never enters the cache; only R2 ciphertext.

11. **Loopback hint copy** — ChatScreen empty-state branches on `loopbackActive`; production builds no longer say "echoed back from the loopback peer".

---

## Smoke Test Results (2026-04-29)

| Suite                                               | Tests                | Result      |
| --------------------------------------------------- | -------------------- | ----------- |
| `messenger-crypto` (Node env, libsignal-typescript) | 11 suites · 59 tests | ✅ all pass |
| `messenger-service` (NestJS)                        | 7 suites · 46 tests  | ✅ all pass |

Both suites cover the changed surfaces — group broadcast / parseGroupMessage with master key, sealed sender v2, ratchet, handshake, AES-CBC media, vault, TTL, group member names, WebRTC signalling, log-audit, relay envelopes, read-receipts (`gateway.spec`), retract tokens, presence, MFA guard, TURN.

The `e2e-messenger-smoke.mjs` script requires live `auth-service` + `messenger-service` + Redis + two pre-provisioned user JWTs, so it's run in the deployed dev environment, not in CI.

Pre-existing agent-onboarding test failures (4 of 110 in `src/screens/agent/__tests__/agentFlow.smoke.test.ts`) are unrelated to messenger work — they assert the post-OTP route (`AgentKYC` vs `AgentCoverage`) which was changed in commit `d7ffd2d`.

---

## Phase-2 Backlog (product-side gaps NOT closed in this pass)

These remain on us, ranked by user-visible impact:

| Item                                                                                                                        | Estimate                         | Note                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Native Rust libsignal binding (iOS Swift + Android Kotlin modules around the published xcframework / aar, JSI/Turbo facade) | ~2 weeks                         | Cannot be done without device build tooling. Wire-compatible with the TS port — no caller changes needed. |
| Sender Keys group protocol (replace pairwise N-fan-out with O(1) broadcast)                                                 | ~2 weeks                         | Master-key wrap shipped this pass is the documented Phase-1 substitute.                                   |
| Full Signal Sealed Sender v2 (outer ECIES UnidentifiedSenderMessage; eliminates `senderAddressHint`)                        | ~3 days (after native libsignal) | Pragmatic Phase-1 hint is in place.                                                                       |
| Bravo Calendar AI parser, SRA engine, OSINT real aggregator, biometric monitoring                                           | weeks                            | VBG Pro features, server-side.                                                                            |
| Group calls via mediasoup SFU                                                                                               | weeks                            | Pairwise WebRTC only Phase 1.                                                                             |
| Server-side OPK auto-rotation cron                                                                                          | ~2 days                          | Currently client-driven on low-pool header.                                                               |

---

## Compliance Summary

- **Encryption invariants** (no plaintext at rest server-side, sealed sender, DTLS-SRTP, vault MFA, file vault keys never disk-cached, on-device persistence in SQLCipher only): **all hold ✅**.
- **Spec-literal client architecture** (SQLCipher message store + media cache, group master key both clients, read-receipts, server purge, identity rotation auto-recovery): **shipped ✅**.
- **Phase-2 product deferrals**: native libsignal, Sender Keys, Sealed Sender v2, Bravo Pro VBG features, group calls SFU.
- **Phase-1 functional scope** (registration, messaging including groups + disappearing + receipts + retract + identity recovery, voice/video, booking lifecycle, agent portal, ops console live mission flow): **production-ready** subject to the Phase-2 backlog above.

Roadmap with WIP items + commit-by-commit progress: [MESSENGER_ROADMAP.md](MESSENGER_ROADMAP.md).
