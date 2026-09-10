# Backend Audit — BE-1 through BE-6

Audit date: 2026-05-16
Branch: main @ aaed18514ba0

## Master status correction table

| ID     | Task                                          | Tracker says                            | Actual %    | Actual status                                                                                                                             | Evidence                                                                                                                         |
| ------ | --------------------------------------------- | --------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| BE-1.1 | Monorepo & DB schema setup                    | Complete / 100%                         | 100%        | Complete                                                                                                                                  | apps/_ + packages/_, 27 SQL migrations in supabase/migrations/                                                                   |
| BE-1.2 | auth-service: register, OTP (Twilio), TOTP    | In Progress / 90%                       | 100% (code) | Code complete — only Kafka broker provisioning remains                                                                                    | auth.controller.ts, auth.service.ts, src/totp/, src/kafka/audit.service.ts                                                       |
| BE-1.3 | JWT issuance + refresh token rotation         | In Progress / 30%                       | 100%        | Complete                                                                                                                                  | jwt.service.ts, auth.service.ts, auth_devices table                                                                              |
| BE-1.4 | Identity key upload endpoint                  | Not Started / 0%                        | 100%        | Complete                                                                                                                                  | keys.controller.ts, signal_identities + signal_one_time_prekeys tables                                                           |
| BE-1.5 | Biometric assertion endpoint                  | Not Started / 0%                        | 70%         | In Progress — Android done, iOS pending                                                                                                   | biometric.service.ts (Play Integrity wired, Apple p8 stub)                                                                       |
| BE-2.1 | libsignal server-side keys + key distribution | Complete (auto-replenish deferred)      | 100%        | Complete — auto-replenish IS wired                                                                                                        | keys.controller.ts X-Pre-Key-Count header + keysClient.ts:111 + productionRuntime.ts:1770 client refill on <10                   |
| BE-2.2 | Sealed sender + sender certificate signing    | Complete (TTL 1h, no revocation)        | 100%        | Complete — TTL is 24h default and revocation IS shipped                                                                                   | sender-cert.service.ts:79 (86400s default), sender-cert.controller.ts (/revoke, /revoke-all, /revocation-list)                   |
| BE-2.3 | WebSocket gateway (Socket.io + Redis adapter) | Complete (raw ws, no Redis adapter)     | 100%        | Complete — Socket.IO + Redis adapter both shipped                                                                                         | messenger.gateway.ts uses @nestjs/websockets + socket.io; redis-io.adapter.ts wires @socket.io/redis-adapter                     |
| BE-2.4 | Presence, typing indicators, read receipts    | Complete (typing has no 500ms debounce) | 95%         | Complete — server-side debounce intentionally absent (correct design)                                                                     | messenger.gateway.ts:93 TYPING_TIMEOUT_MS=6000 (auto-stop), debounce is client-side per Signal/WhatsApp pattern                  |
| BE-3.1 | Group messaging (sealed-sender broadcast)     | Complete / 100%                         | 100%        | Complete — zero server-side group state (O(N) pairwise)                                                                                   | packages/messenger-core/src/groups/groupClient.ts                                                                                |
| BE-3.2 | files-service: S3 pre-signed URL generation   | Complete / 100%                         | 100%        | Complete — works against R2/minio                                                                                                         | media.controller.ts (no MFA), vault.controller.ts (MFA-gated)                                                                    |
| BE-3.3 | File Vault MFA gate                           | Complete / 100%                         | 100%        | Complete — stateless action-token pattern                                                                                                 | vault/mfa.guard.ts (X-Mfa-Proof header, purpose allowlist, freshness check)                                                      |
| BE-4.1 | signalling-service: SDP/ICE relay             | Complete / 100%                         | 100%        | Complete — pure WS relay                                                                                                                  | messenger.gateway.ts handleCallOffer/Answer/Ice (sealed forward)                                                                 |
| BE-4.2 | TURN credential issuance API                  | Complete / 100%                         | 100%        | Complete — coturn REST, 24h HMAC-SHA1                                                                                                     | turn.service.ts (use-auth-secret pattern), turn.controller.ts                                                                    |
| BE-4.3 | VoIP push notifications (APNs/FCM)            | In Progress / 40%                       | 95%         | Complete (real delivery) — only multi-cert rotation outstanding                                                                           | push.service.ts (Firebase Admin + APNs client wired), VoIP wake HMAC-SHA256 signing                                              |
| BE-4.4 | Group call SFU scaffold (mediasoup)           | In Progress / 70%                       | 100%        | Complete — full mediasoup with worker pool, zombie sweeper, 6-cap                                                                         | sfu.service.ts, sfuWorkerPool.ts                                                                                                 |
| BE-5.1 | booking-service: full state machine           | Not Started / 0%                        | 100%        | Complete                                                                                                                                  | state-machine.service.ts (DRAFT→PENDING_OPS→OPS_APPROVED→PAYMENT_PENDING→CONFIRMED→LIVE→COMPLETED), idempotency.interceptor.ts   |
| BE-5.2 | Pricing engine + add-on logic                 | Not Started / 0%                        | 100%        | Complete                                                                                                                                  | pricing.service.ts (EUR base, peak multiplier, EUR/AED), 3hr lead time enforced                                                  |
| BE-5.3 | payment-service (Stripe EUR + Telr AED)       | Not Started / 0%                        | 60%         | In Progress — Stripe wired, Telr not implemented                                                                                          | stripe.client.ts + /wallet/stripe-webhook live; no Telr adapter                                                                  |
| BE-5.4 | Bravo Credits wallet (top-up + deduction)     | Not Started / 0%                        | 100%        | Complete — top-up/deduction live, 12-month expiry tracking shipped                                                                        | wallet.controller.ts, wallet.service.ts (debitBatchesFifo, sweepExpiredCredits), wallet-expiry.cron.ts, migration 20260516000000 |
| BE-6.1 | Ops Room WebSocket + admin approval APIs      | Not Started / 0%                        | 70%         | In Progress — full REST approval API shipped; no dedicated /ops WebSocket namespace                                                       | ops.controller.ts (/ops/bookings/:id/approve, /reject, full surface), AdminGuard + RequireRoles; no WebSocketGateway under ops   |
| BE-6.2 | notification-service (FCM/APNs/Twilio SMS)    | Not Started / 0%                        | 75%         | In Progress — FCM + APNs shipped, emergency SMS via Twilio NOT shipped                                                                    | push.service.ts (FCM + apnsClient), booking-push-bridge.service.ts; no Twilio SMS path for emergencies                           |
| BE-6.3 | Department channel APIs                       | Not Started / 0%                        | 60%         | In Progress — generic conversation create/join/leave + group-message archive shipped; department semantics + Bravo Pro gating NOT shipped | conversations.controller.ts, conversations.service.ts; no role/department-scoped channel layer; no Pro-tier gate                 |

## BE-1.1 — Monorepo & DB schema setup

| Item            | Required    | Found                                                                     | Status                                     |
| --------------- | ----------- | ------------------------------------------------------------------------- | ------------------------------------------ |
| Monorepo layout | Nx monorepo | Path-alias monorepo (no Nx)                                               | OK (works the same; tracker wording wrong) |
| Shared TS types | Yes         | packages/messenger-core                                                   | OK                                         |
| ESLint          | Yes         | .eslintrc.js at root                                                      | OK                                         |
| Prettier        | Yes         | No .prettierrc found                                                      | Minor gap                                  |
| Husky           | Yes         | .husky/ (pre-commit, pre-push, commit-msg)                                | OK                                         |
| Postgres schema | Yes         | 27 migrations, init at supabase/migrations/20260416000000_init_phase1.sql | OK                                         |

## BE-1.2 — auth-service: register, OTP (Twilio), TOTP

| Item                       | Required             | Found                                                       | Status                                                                     |
| -------------------------- | -------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| POST /auth/register        | Yes                  | auth.controller.ts:119                                      | OK                                                                         |
| POST /auth/register/verify | Yes                  | auth.controller.ts:127                                      | OK                                                                         |
| Twilio OTP                 | Yes                  | auth.service.ts:89-117 with 60203/60410/21608 error mapping | OK                                                                         |
| TOTP module                | Yes                  | src/totp/ (controller, service, spec, otpauth lib)          | OK                                                                         |
| Rate limiting              | Implicit             | @nestjs/throttler 5/10min on register, 10/10min on verify   | OK                                                                         |
| Kafka audit                | "Kafka is remaining" | AuditService wired, KafkaModule @Global in app.module.ts:41 | Code OK — only broker (MSK/Redpanda) provisioning + KAFKA_BROKERS env left |

## BE-1.3 — JWT issuance + refresh token rotation

| Item                  | Required          | Found                                                         | Status                              |
| --------------------- | ----------------- | ------------------------------------------------------------- | ----------------------------------- |
| HS256 JWT             | Yes               | jwt.service.ts:45 (alg HS256)                                 | OK                                  |
| 15min access TTL      | Yes               | jwt.accessTtl default '15m'                                   | OK                                  |
| 256-bit refresh token | Yes               | randomBytes(48) = 384 bits (exceeds spec)                     | OK                                  |
| Refresh hash storage  | "Hashed in Redis" | SHA-256 in Postgres auth_devices.refresh_token_hash           | Design sound; tracker wording wrong |
| jti revocation        | Yes               | current_jti per device, prev jti revoked in Redis on rotation | OK                                  |
| Refresh rotation      | Yes               | /auth/refresh + cookie-bound /auth/session/refresh            | OK                                  |
| Tests                 | Yes               | jwt.service.spec.ts, auth.service.spec.ts                     | OK                                  |

## BE-1.4 — Identity key upload endpoint

| Item                         | Required | Found                                               | Status |
| ---------------------------- | -------- | --------------------------------------------------- | ------ |
| POST /auth/keys/upload       | Yes      | keys.controller.ts:20                               | OK     |
| GET /auth/keys/:userId       | Yes      | keys.controller.ts:32                               | OK     |
| JWT-guarded                  | Yes      | @UseGuards(JwtAuthGuard) at controller level        | OK     |
| Stores Curve25519 public key | Yes      | signal_identities.identity_key bytea                | OK     |
| Stores signed pre-key        | Yes      | signal_identities.signed_prekey + signed_prekey_sig | OK     |
| One-time pre-key pool        | Yes      | signal_one_time_prekeys table                       | OK     |
| Low-pool header              | Bonus    | X-Pre-Key-Count header when poolSize < 10           | OK     |
| Audit events                 | Yes      | auth.keys.upload / auth.keys.fetch                  | OK     |
| Tests                        | Yes      | keys.service.spec.ts                                | OK     |

## BE-1.5 — Biometric assertion endpoint

| Item                                 | Required | Found                                                          | Status                                 |
| ------------------------------------ | -------- | -------------------------------------------------------------- | -------------------------------------- |
| POST /auth/biometric/assert          | Yes      | biometric.controller.ts:14                                     | OK                                     |
| Validates SafetyNet / Play Integrity | Yes      | biometric.service.ts:45-57 (verdict MEETS_DEVICE_INTEGRITY)    | OK                                     |
| Validates DeviceCheck (iOS)          | Yes      | biometric.service.ts:59-69 — returns apple_jwt_signing_pending | STUB — p8 ES256 signer not implemented |
| Returns short-lived action token     | Yes      | 5-min action JWT, single-use via Redis jti                     | OK                                     |
| Audit events                         | Yes      | auth.biometric.assert                                          | OK                                     |
| Tests                                | Yes      | biometric.service.spec.ts                                      | OK                                     |

## BE-2.1 — libsignal server-side keys + key distribution

| Item                                  | Required                | Found                                                                               | Status                  |
| ------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------- | ----------------------- |
| Identity key + signed pre-key storage | Yes                     | signal_identities (registration_id, identity_key, signed_prekey, signed_prekey_sig) | OK                      |
| One-time pre-key pool                 | Yes                     | signal_one_time_prekeys, atomic single-use DELETE...RETURNING                       | OK                      |
| Signed pre-key signature verification | Yes                     | keys.service.ts:25-30 Ed25519 verify on upload                                      | OK                      |
| Identity rotation handling            | Yes                     | keys.service.ts:44-69 wipes orphaned OPKs on identity change                        | OK (beyond spec)        |
| Pool low-water signal                 | Yes                     | X-Pre-Key-Count header when poolSize<10                                             | OK                      |
| Client auto-refill                    | Tracker says "deferred" | productionRuntime.ts:1770-1794 triggers refill on header                            | OK — tracker note stale |
| Tests                                 | Yes                     | keys.service.spec.ts                                                                | OK                      |

## BE-2.2 — Sealed sender + sender certificate signing

| Item                   | Required                   | Found                                                           | Status                                 |
| ---------------------- | -------------------------- | --------------------------------------------------------------- | -------------------------------------- |
| Sender cert minting    | Yes                        | POST /sender-cert, XEd25519 over Curve25519                     | OK                                     |
| Cert TTL               | Tracker says "1h"          | Default 86400s (24h), env-tunable via SENDER_CERT_TTL_SECONDS   | Tracker WRONG — default is 24h, not 1h |
| Per-cert revocation    | Tracker says "not shipped" | POST /sender-cert/revoke (jti + ttl)                            | Tracker WRONG — shipped                |
| Bulk revoke-all        | Bonus                      | POST /sender-cert/revoke-all (advances per-user generation)     | OK                                     |
| Public revocation list | Bonus                      | GET /sender-cert/revocation-list (unauthenticated, opaque jtis) | OK                                     |
| Tests                  | Yes                        | sender-cert.service.spec.ts                                     | OK                                     |

## BE-2.3 — WebSocket gateway (Socket.io + Redis adapter)

| Item                               | Required                       | Found                                                                | Status                              |
| ---------------------------------- | ------------------------------ | -------------------------------------------------------------------- | ----------------------------------- |
| Socket.IO transport                | Tracker says "raw ws"          | @nestjs/websockets + socket.io, transports:['websocket']             | Tracker WRONG — Socket.IO confirmed |
| JWT-gated handshake                | Yes                            | Middleware verifies access JWT before connection                     | OK                                  |
| Connection registry                | Yes                            | connection-registry.ts + spec                                        | OK                                  |
| Redis adapter for horizontal scale | Tracker says "deferred to M12" | redis-io.adapter.ts wires @socket.io/redis-adapter (pub+sub ioredis) | Tracker WRONG — shipped             |
| Connection-state recovery          | Bonus                          | 2-min recovery window for reconnects (subway/elevator blips)         | OK                                  |
| Heartbeat tuning                   | Yes                            | WS_HEARTBEAT_MS / WS_HEARTBEAT_GRACE env                             | OK                                  |

## BE-2.4 — Presence, typing, read receipts

| Item                      | Required                 | Found                                                                            | Status                                      |
| ------------------------- | ------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------- |
| Presence (online/offline) | Yes                      | presence.service.ts + presence.cron.ts                                           | OK                                          |
| Typing fan-out            | Yes                      | messenger.gateway.ts:1221 handleTyping                                           | OK                                          |
| Typing auto-stop          | Yes                      | TYPING_TIMEOUT_MS=6000 server-side fallback                                      | OK                                          |
| Typing debounce           | Tracker flags as missing | Intentionally client-side (Signal/WhatsApp pattern); server forwards immediately | Design correct; tracker note is a non-issue |
| Read receipts             | Yes                      | ClientReadReceipt / ServerReadReceipt in protocol.ts                             | OK                                          |
| Cross-replica fan-out     | Yes                      | Redis adapter handles room.emit across nodes                                     | OK                                          |

## BE-3.1 — Group messaging (sealed-sender broadcast)

| Item                                  | Required | Found                                                                              | Status             |
| ------------------------------------- | -------- | ---------------------------------------------------------------------------------- | ------------------ |
| Zero server-side group state          | Yes      | groupClient.ts — broadcast is N pairwise sealed copies; relay has no group concept | OK                 |
| Shared clientMsgId for dedupe         | Yes      | Same clientMsgId on every recipient copy                                           | OK                 |
| Admin actions (create, add, remove)   | Yes      | GroupAdminAction encoded inside sealed payload                                     | OK                 |
| Disappearing-message TTL pass-through | Yes      | BroadcastParams.ttlSeconds optional                                                | OK                 |
| Discriminated-union parse result      | Yes      | ParseGroupResult: no_key / tamper / malformed / not_group                          | OK (audit fix #27) |
| Master-key distribution               | Yes      | Shared via pairwise Signal sessions per architecture doc                           | OK                 |

## BE-3.2 — files-service: S3 pre-signed URL generation

| Item                     | Required                             | Found                                                                                                                                                                                                                           | Status                                            |
| ------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| /media/upload-url        | Yes                                  | media.controller.ts (no MFA — for media attachments)                                                                                                                                                                            | OK                                                |
| /media/download-url/:key | Yes                                  | media.controller.ts                                                                                                                                                                                                             | OK                                                |
| /vault/upload-url        | Yes                                  | vault.controller.ts (MFA-required)                                                                                                                                                                                              | OK                                                |
| /vault/download-url/:key | Yes                                  | vault.controller.ts (MFA-required)                                                                                                                                                                                              | OK                                                |
| R2/minio support         | Yes                                  | Works against any S3-compatible backend per code                                                                                                                                                                                | OK                                                |
| TTL values               | Tracker says "vault 60s, media 5min" | vault.service.ts reads `vault.presignTtlSeconds` (env `VAULT_PRESIGN_TTL_SECONDS`, default 60); media.service.ts reads `media.presignTtlSeconds` (env `MEDIA_PRESIGN_TTL_SECONDS`, default 300) — see configuration.ts:52, :184 | OK — both env-tunable, defaults match the tracker |

## BE-3.3 — File Vault MFA gate

| Item                                     | Required         | Found                                                                      | Status |
| ---------------------------------------- | ---------------- | -------------------------------------------------------------------------- | ------ |
| MFA challenge on every download          | Yes              | MfaGuard requires X-Mfa-Proof header on EVERY route                        | OK     |
| Stateless action-token pattern           | Tracker confirms | HS256 action JWT, single-use via Redis jti, 5-min default                  | OK     |
| Purpose allowlist                        | Yes              | vault.mfaPurposes config (biometric-verified, totp-verified, vault-access) | OK     |
| Action-token freshness check             | Yes              | iat must be within vault.mfaMaxAgeSec (default 300)                        | OK     |
| sub/deviceId cross-check vs access token | Yes              | mfa.guard.ts:55-59                                                         | OK     |
| MFA on upload (not just download)        | Bonus            | Yes — also gates uploads (architecture doc only mandates downloads)        | OK     |
| Tests                                    | Yes              | mfa.guard.spec.ts                                                          | OK     |

## BE-4.1 — signalling-service: SDP/ICE relay

| Item                           | Required | Found                                                                           | Status |
| ------------------------------ | -------- | ------------------------------------------------------------------------------- | ------ |
| Pure WS relay (no SDP parsing) | Yes      | messenger.gateway.ts handleCallOffer/Answer/Ice forwards opaque blobs           | OK     |
| Call lifecycle tracking        | Yes      | CallSession state machine (ringing/active/ended) for auth + cleanup             | OK     |
| Participant pinning            | Yes      | Caller + callee pinned at offer time; 3rd-party frames dropped with auth_failed | OK     |
| Tombstone retention            | Yes      | CALL_TOMBSTONE_TTL_MS retains ended-call IDs to reject duplicate offers         | OK     |
| Cross-replica routing          | Yes      | Redis adapter (BE-2.3) — call.offer from node A reaches callee on node B        | OK     |

## BE-4.2 — TURN credential issuance API

| Item                              | Required           | Found                                                                               | Status |
| --------------------------------- | ------------------ | ----------------------------------------------------------------------------------- | ------ |
| GET /webrtc/turn-credentials      | Yes                | turn.controller.ts                                                                  | OK     |
| coturn use-auth-secret pattern    | Yes                | turn.service.ts: username=`${ts}:${userId}`, credential=HMAC-SHA1(secret, username) | OK     |
| TTL                               | Tracker says "24h" | turn.ttlSeconds default 86400 (24h)                                                 | OK     |
| User-id in username for abuse log | Bonus              | Sanitized userId embedded in username                                               | OK     |
| STUN URLs in response             | Bonus              | stunUrls precede turnUrls in iceServers entry                                       | OK     |
| Tests                             | Yes                | turn.service.spec.ts                                                                | OK     |

## BE-4.3 — VoIP push notifications (APNs/FCM)

| Item                             | Required                       | Found                                                                                                    | Status                  |
| -------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------- |
| Token registration endpoints     | Yes                            | push.controller.ts exposes DATA + VOIP channels                                                          | OK                      |
| Real APNs delivery               | Tracker says "remains Phase-2" | apnsClient.ts present and used by push.service.ts                                                        | Tracker WRONG — shipped |
| Real FCM delivery                | Tracker says "remains Phase-2" | Firebase Admin SDK, credentials auto-discovered from GOOGLE_APPLICATION_CREDENTIALS / staging path / cwd | Tracker WRONG — shipped |
| Wake-only payload (no plaintext) | Yes                            | Push payloads carry wake hints only; enforced by log-audit test                                          | OK                      |
| VoIP wake auth                   | Bonus                          | Per-device HMAC-SHA256 wake key, prevents replay-induced ring spam (Round 5 / S3)                        | OK                      |
| Multi-cert rotation runbook      | Implicit                       | p8 signing in code, but rotation procedure not documented                                                | Minor gap               |
| 90-day token TTL                 | Bonus                          | TOKEN_TTL_DAYS=90 (stale-token cleanup)                                                                  | OK                      |

## BE-4.4 — Group call SFU scaffold (mediasoup)

| Item                                    | Required | Found                                                         | Status |
| --------------------------------------- | -------- | ------------------------------------------------------------- | ------ |
| mediasoup Node.js cluster               | Yes      | sfuWorkerPool.ts spawns workers, sfu.service.ts uses them     | OK     |
| Selective forwarding                    | Yes      | Router.canConsume + Consumer per peer                         | OK     |
| 6-participant cap (WhatsApp parity)     | Bonus    | MAX_PARTICIPANTS_PER_ROOM=6                                   | OK     |
| Server-side roomId generation           | Yes      | 16-byte hex; clients never supply directly                    | OK     |
| Zombie-room sweeper                     | Bonus    | 60s grace + 30s sweep interval                                | OK     |
| participantTag anonymization            | Bonus    | Fresh UUID per joinRoom — SFU log never sees userId           | OK     |
| conversationId → roomId index           | Bonus    | Prevents parallel ghost rooms when 2nd member taps phone icon | OK     |
| Group key distribution via Signal group | Yes      | Handled at messenger-core layer (BE-3.1)                      | OK     |

## BE-5.1 — booking-service: full state machine

| Item                                           | Required            | Found                                                                                    | Status |
| ---------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------- | ------ |
| State enum                                     | Yes                 | DRAFT, PENDING_OPS, OPS_APPROVED, PAYMENT_PENDING, CONFIRMED, LIVE, COMPLETED, CANCELLED | OK     |
| Allowed transitions table                      | Yes                 | state-machine.service.ts TRANSITIONS list                                                | OK     |
| Actor enforcement                              | Yes                 | CLIENT / OPS_HANDLER / CPO / SYSTEM per transition                                       | OK     |
| Idempotent transitions                         | Tracker requirement | idempotency.interceptor.ts on POST routes                                                | OK     |
| Cancel rules                                   | Yes                 | CANCELLABLE set; client/system/ops only                                                  | OK     |
| Ops fast-path: CONFIRMED→LIVE & LIVE→COMPLETED | Bonus               | Ops-handler shortcut transitions for console-driven dispatch/close                       | OK     |
| Drift detection tests                          | Bonus               | state-machine.drift.spec.ts                                                              | OK     |
| Tests                                          | Yes                 | state-machine.service.spec.ts, booking-flow.spec.ts                                      | OK     |

## BE-5.2 — Pricing engine + add-on logic

| Item                             | Required | Found                                              | Status |
| -------------------------------- | -------- | -------------------------------------------------- | ------ |
| Base rate                        | Yes      | EUR 86/hr ≈ AED 350/hr (canonical conversion 4.07) | OK     |
| Extra CPOs/vehicles              | Yes      | +25% per additional unit                           | OK     |
| Driver-only mode                 | Yes      | 0.65× base (client supplies vehicle)               | OK     |
| Add-on composite                 | Yes      | lite_booking_add_ons table summed per-hour         | OK     |
| Peak-hour multiplier             | Yes      | 17:00–20:00 local → 1.2×                           | OK     |
| EUR source of truth, AED display | Yes      | pricing.service.ts:46                              | OK     |
| 3hr lead-time validation         | Yes      | booking.service.ts:10 MIN_LEAD_HOURS=3             | OK     |
| Passenger-to-vehicle mapping     | Yes      | dto/create-booking.dto.ts                          | OK     |
| Tests                            | Yes      | pricing.service.spec.ts                            | OK     |

## BE-5.3 — payment-service (Stripe EUR + Telr AED)

| Item                                  | Required         | Found                                                       | Status          |
| ------------------------------------- | ---------------- | ----------------------------------------------------------- | --------------- |
| Stripe PaymentIntents                 | Yes              | stripe.client.ts createPaymentIntent                        | OK              |
| Stripe Elements tokenisation (client) | Yes              | Mobile/web use Stripe SDK with client_secret                | OK              |
| Idempotent payment intents            | Yes              | Server-side idempotency key on intent creation              | OK              |
| Webhook signature verification        | Yes              | createHmac + timingSafeEqual in stripe.client.ts            | OK              |
| Webhook handler                       | Yes              | POST /wallet/stripe-webhook (wallet.controller.ts:80)       | OK              |
| Telr (AED for GCC corporate)          | Tracker requires | No payment-service/, no Telr/TELR matches in apps/\* source | NOT IMPLEMENTED |
| Fallback "stripe_disabled" mode       | Bonus            | StripeClient.enabled flag → 503 with structured error       | OK              |
| Tests                                 | Yes              | stripe.client.spec.ts                                       | OK              |

## BE-5.4 — Bravo Credits wallet (top-up + deduction)

| Item                              | Required         | Found                                                                                                                            | Status |
| --------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Credits balance per user          | Yes              | wallet.service.ts getBalance                                                                                                     | OK     |
| Top-up via Stripe                 | Yes              | POST /wallet/topup → PaymentIntent → settlement on webhook                                                                       | OK     |
| Deduction on booking confirmation | Yes              | wallet.service.ts deduction path                                                                                                 | OK     |
| Transactions ledger               | Yes              | GET /wallet/transactions (paginated)                                                                                             | OK     |
| Idempotent settlement             | Yes              | Webhook handler is idempotent (per Stripe event id)                                                                              | OK     |
| Canonical credits-per-USD FX      | Yes              | StripeClient.creditsPerUsd (default 10)                                                                                          | OK     |
| 12-month expiry tracking          | Tracker requires | wallet_credit_batches table (migration 20260516000000), WalletExpiryCron hourly sweep, debitBatchesFifo prefers expiring-soonest | OK     |
| Tests                             | Yes              | wallet.service.spec.ts, stripe.client.spec.ts                                                                                    | OK     |

## BE-6.1 — Ops Room WebSocket + admin approval APIs

| Item                       | Required         | Found                                                                                                                                         | Status                                 |
| -------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Namespace /ops (WebSocket) | Tracker requires | No WebSocketGateway in apps/auth-service; ops realtime is via Redis push → FCM only                                                           | NOT IMPLEMENTED — no /ops WS namespace |
| Booking approval API       | Yes              | POST /ops/bookings/:id/approve (ops.controller.ts:85)                                                                                         | OK                                     |
| Booking reject API         | Yes              | POST /ops/bookings/:id/reject (ops.controller.ts:95)                                                                                          | OK                                     |
| JWT admin-role required    | Yes              | JwtAuthGuard + CsrfGuard + AdminGuard at controller level; @RequireRoles per-route                                                            | OK                                     |
| Booking queue list         | Yes              | GET /ops/bookings with filters (ops.controller.ts:72)                                                                                         | OK                                     |
| Agent availability query   | Yes              | ops.service.ts:497 cpo_availability ('available' / 'on_mission')                                                                              | OK                                     |
| Idempotent approvals       | Yes              | IdempotencyInterceptor on POST routes                                                                                                         | OK                                     |
| Activity feed              | Bonus            | GET /ops/activity (audit recent feed), pii-reveal audit                                                                                       | OK                                     |
| Mission state machine      | Bonus            | mission-state-machine.service.ts + 120-transition matrix test                                                                                 | OK                                     |
| Job feed (post-approval)   | Bonus            | job-feed.service.ts publishes JF-XXXX to agent feed on approval                                                                               | OK                                     |
| Tests                      | Yes              | admin.guard.spec.ts, mission-state-machine.service.spec.ts, ops.service.concurrency.spec.ts, ops-flow.smoke.spec.ts, ops.service.sqli.spec.ts | OK                                     |

## BE-6.2 — notification-service (FCM/APNs/Twilio SMS)

| Item                         | Required         | Found                                                                       | Status                                                                                |
| ---------------------------- | ---------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| FCM delivery                 | Yes              | push.service.ts (Firebase Admin SDK)                                        | OK                                                                                    |
| APNs delivery                | Yes              | apnsClient.ts wired in push.service.ts                                      | OK                                                                                    |
| Booking status push          | Yes              | BookingPushBridge.bookingApproved → 'booking-approved' kind                 | OK                                                                                    |
| Agent decision push          | Yes              | BookingPushBridge.agentDecided → 'agent-approved' / 'agent-rejected'        | OK                                                                                    |
| Mission dispatch push        | Bonus            | missionDispatched, missionAborted, payoutSettled, sosAlert all wired        | OK                                                                                    |
| Cross-service bridge         | Yes              | Redis `push:events` channel; messenger-service subscribes                   | OK                                                                                    |
| Deep-link payload routing    | Tracker requires | No deeplink/deep-link/payload-route matches in push code                    | LIKELY CLIENT-SIDE — server sends `kind` discriminator; client maps to route. Verify. |
| Silent push for message sync | Yes              | push.service.ts wake-only payloads (enforced by log-audit test)             | OK                                                                                    |
| Emergency SMS via Twilio     | Tracker requires | Twilio used only for OTP (auth.service.ts); no SMS path for ops emergencies | NOT IMPLEMENTED                                                                       |
| VoIP wake-key HMAC signing   | Bonus            | Per-device HMAC-SHA256 wake key (Round 5 / S3)                              | OK                                                                                    |

## BE-6.3 — Department channel APIs

| Item                                               | Required                              | Found                                                                                                 | Status                          |
| -------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------- |
| Channel create                                     | Yes (as conversation)                 | conversations.controller.ts POST                                                                      | OK (generic group conversation) |
| Channel join                                       | Yes                                   | Generic group membership add                                                                          | OK                              |
| Channel leave                                      | Yes                                   | Generic group leave (last-admin promotion handled)                                                    | OK                              |
| Message history (encrypted)                        | Yes                                   | conversation_archive table + sealed envelope archive migrations                                       | OK                              |
| File sharing endpoint                              | Yes                                   | vault.controller.ts + media.controller.ts (BE-3.2)                                                    | OK                              |
| Department semantics (role/dept-scoped membership) | Tracker requires                      | No department concept in conversations service; only generic admin/member roles within a conversation | NOT IMPLEMENTED                 |
| Corporate Pro tier gate                            | Tracker requires "Corporate Pro only" | No subscription_tier check on conversation create                                                     | NOT IMPLEMENTED                 |
| Tests                                              | Yes                                   | conversations.service tests                                                                           | OK                              |

## Unlisted gaps (not on tracker but should be)

| ID ref     | Item                               | Why it matters                                                                                                                                                                        | Where                                                                                                                           |
| ---------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| BE-1.5     | Apple DeviceCheck p8 ES256 signer  | iOS biometric assertion always fails until done                                                                                                                                       | biometric.service.ts:60-68                                                                                                      |
| BE-1.x     | Admin invite flow                  | /auth/admin-register/verify hard-403'd; invite JWT replacement is a follow-up                                                                                                         | auth.controller.ts:141-146                                                                                                      |
| ~~BE-1.1~~ | ~~.prettierrc at root~~            | Resolved — `.prettierrc` added at repo root with project style (2sp, single quotes, no bracket-spacing, trailingComma:all, printWidth:100)                                            | repo root                                                                                                                       |
| BE-1.2     | KAFKA_BROKERS env in staging/prod  | Without it, audit events are stdout-only                                                                                                                                              | apps/auth-service/.env, infra                                                                                                   |
| BE-2.2     | Sender cert signing primitive note | Uses XEd25519 over Curve25519 (not native Ed25519) — deliberate for RN compatibility; document for audit                                                                              | sender-cert.service.ts:12-19                                                                                                    |
| BE-2.2     | Sender cert private key location   | Lives in process memory from base64 env; rotation requires restart                                                                                                                    | sender-cert.service.ts:51-67                                                                                                    |
| ~~BE-2.1~~ | ~~OPK pool max size~~              | Resolved — `OPK_POOL_CAP = 200` enforced in keys.service.ts upload path; over-cap tail silently dropped with warn log                                                                 | keys.service.ts:71-95                                                                                                           |
| ~~BE-3.2~~ | ~~Vault TTL config~~               | Resolved — both env-tunable via `VAULT_PRESIGN_TTL_SECONDS` (default 60) and `MEDIA_PRESIGN_TTL_SECONDS` (default 300)                                                                | configuration.ts:52, :184                                                                                                       |
| ~~BE-4.3~~ | ~~APNs cert rotation runbook~~     | Resolved — `docs/KEY_ROTATION_RUNBOOK.md` covers APNs p8, FCM service account, sender-cert XEd25519, JWT access secret, TURN shared secret                                            | docs/KEY_ROTATION_RUNBOOK.md                                                                                                    |
| BE-5.3     | Telr (AED) integration             | Tracker mandates Stripe EUR + Telr AED for GCC corporate; only Stripe is implemented                                                                                                  | needs new module                                                                                                                |
| ~~BE-5.4~~ | ~~Credits 12-month expiry~~        | Resolved — wallet_credit_batches table tracks per-batch expiry; WalletExpiryCron sweeps hourly; debitBatchesFifo prefers expiring-soonest. Migration 20260516000000 includes backfill | wallet.service.ts, wallet-expiry.cron.ts, migration                                                                             |
| BE-6.1     | /ops WebSocket namespace           | Tracker spec calls for a WS namespace for live booking/queue updates; today the console either polls or rides FCM pushes                                                              | New @WebSocketGateway({namespace:'/ops'}) with AdminGuard handshake, room per region/team, fan-out from approval/dispatch flows |
| BE-6.2     | Twilio emergency SMS               | If FCM/APNs both fail (device offline, push token stale), there's no fallback for SOS / emergency dispatch                                                                            | New TwilioSmsService (separate from OTP Verify service), call it from sosAlert path                                             |
| BE-6.2     | Deep-link payload routing audit    | Server sends `kind`; client-side mapping needs verification end-to-end                                                                                                                | Audit mobile push handler to confirm each `kind` lands on the right screen                                                      |
| BE-6.3     | Department channels                | Generic conversations exist but no role/department-scoped channel layer                                                                                                               | New `department_channels` table or `department_code` column on conversations + admin-only create + scoped membership            |
| BE-6.3     | Bravo Pro gate (server)            | Spec says "Corporate Pro only" — today any user can create groups; mobile (MOB-4.1) renders the gate but server doesn't enforce it                                                    | Subscription tier check on the channel-create path                                                                              |

## Recommended tracker edits

| ID         | Edit                                                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BE-1.2     | Change yellow note from "Kafka is reamiaing" to "Kafka broker provisioning remaining (code complete)". Bump to 100% or leave at 95% pending broker.                   |
| BE-1.3     | Mark Complete / 100%. Fix description from "hashed in Redis" to "hashed in Postgres auth_devices" (or move to Redis if spec is binding).                              |
| BE-1.4     | Mark Complete / 100%.                                                                                                                                                 |
| BE-1.5     | Mark In Progress / 70%. Add sub-task "iOS DeviceCheck p8 ES256 signer".                                                                                               |
| BE-1.x     | Add new row: Admin invite flow — Not Started.                                                                                                                         |
| BE-2.1     | Drop the "auto-replenish deferred" note — client refill on X-Pre-Key-Count<10 is shipped.                                                                             |
| BE-2.2     | Change "cert TTL 1h" to "cert TTL 24h default, env-tunable". Drop "no revocation endpoint shipped" — /sender-cert/revoke, /revoke-all, /revocation-list are all live. |
| BE-2.3     | Drop "raw ws (not Socket.io); in-memory connection registry (no Redis adapter for horizontal scaling yet — that's M12)". Socket.IO + Redis adapter are both shipped.  |
| BE-2.4     | Drop the "no 500ms debounce" deficiency note — typing debounce is correctly client-side; server has a 6s auto-stop fallback.                                          |
| ~~BE-2.x~~ | ~~Add a row for OPK pool cap policy and sender-cert key rotation runbook~~ — both shipped this round (cap=200, runbook at docs/KEY_ROTATION_RUNBOOK.md).              |
| ~~BE-3.2~~ | ~~Verify the claimed "vault TTL 60s, media TTL 5min" against actual presign config~~ — verified, both env-tunable, defaults match. No tracker edit needed.            |
| BE-4.3     | Bump from 40% to 95% / Complete. Drop the "real APNs/FCM delivery remains Phase-2" note — both are wired. Add follow-up: cert rotation runbook.                       |
| BE-4.4     | Bump from 70% to 100% / Complete. Group call key distribution via Signal group is already covered by BE-3.1.                                                          |
| BE-5.1     | Mark Complete / 100%. Full state machine + idempotency + ops fast-paths shipped.                                                                                      |
| BE-5.2     | Mark Complete / 100%. Pricing engine, add-on composite, peak multiplier, 3hr lead time all live.                                                                      |
| BE-5.3     | Bump from 0% to 60% / In Progress. Stripe path fully shipped; carve out a separate sub-task for Telr (AED) integration.                                               |
| BE-5.4     | Bump from 0% to **100% / Complete**. Top-up/deduction live; 12-month credit expiry shipped (wallet_credit_batches + WalletExpiryCron + FIFO debit).                   |
| BE-6.1     | Bump from 0% to 70% / In Progress. REST approval surface is fully shipped and well-tested. Add sub-task "Build /ops WebSocket namespace".                             |
| BE-6.2     | Bump from 0% to 75% / In Progress. FCM and APNs are live (not Phase-2). Add sub-tasks: "Twilio emergency SMS fallback" and "Deep-link payload audit".                 |
| BE-6.3     | Bump from 0% to 60% / In Progress. Generic conversations exist; the gap is department scoping + Pro-tier gating, not the underlying messaging plumbing.               |

## Headline

- **BE-1**: tracker shows ~64% complete; reality is ~94%. Four of five rows are under-reported.
- **BE-2**: tracker shows 100% but with four false "deficiency" notes that should be cleared.
- **BE-3**: tracker shows 100% — matches reality. Only verify vault/media TTL config values.
- **BE-4**: tracker shows ~78%; reality is ~99%. APNs/FCM and SFU rows are significantly under-reported.
- **BE-5**: tracker shows 0% across all 4 rows; reality is ~85% overall. Two rows are Complete, two are In Progress with clear remaining work (Telr + credits expiry).
- **BE-6**: tracker shows 0% across all 3 rows; reality is ~68%. REST + push plumbing essentially done. Genuine gaps: /ops WS namespace, Twilio emergency SMS, department-channel + Pro-tier semantics.
- **Real remaining work (whole audit)**: iOS DeviceCheck signer, admin invite flow, Kafka broker provisioning, OPK pool cap, sender-cert rotation runbook, vault TTL verification, APNs cert rotation runbook, Telr (AED) integration, credits 12-month expiry, /ops WebSocket namespace, Twilio emergency SMS fallback, department-channel layer with Pro-tier gating.
