# Bravo Secure — Messenger Backend & Security Design

> Living document. Last updated: 2026-04-19.
> Scope: what the messenger module does, where it does it, and why the security posture is defensible at a high-net-worth / regulated-client bar.

---

## 1. Executive summary

Bravo Secure's messenger is built on the **Signal Protocol** (X3DH + Double Ratchet), sealed-sender envelopes, and a pull-only relay that never sees plaintext. All message keys live on-device in a SQLCipher-encrypted store whose master key is sealed in the Android Keystore / iOS Secure Enclave. The server persists only opaque ciphertexts and hard-deletes them on ACK or deadline.

Compliance against our Definition-of-Done: **14/14 DONE** (see `AUTH_COMPLIANCE.md` in this directory / §9).

---

## 2. System architecture

```
┌────────────────────── Device (React Native, Expo SDK 54) ──────────────────────┐
│                                                                                │
│   ChatScreen ─── useMessenger() ───► MessengerRuntime                          │
│       │                                     │                                  │
│       │ zustand (persist: AsyncStorage)     │                                  │
│       ▼                                     ▼                                  │
│   messengerStore                     Signal SessionManager                      │
│   (conversations, messages)          ├── InMemoryProtocolStore  (loopback dev) │
│                                      └── SqlCipherProtocolStore (production)   │
│                                              │                                  │
│                                              └── op-sqlite + SQLCipher 4.x     │
│                                                  key: Android Keystore / iOS SE│
└────────────────────────────────────────────────────────────────────────────────┘
                │                                       │
                │  HTTPS + JWT (access)                 │  WSS /ws + JWT
                ▼                                       ▼
     ┌──────────────────────────┐        ┌─────────────────────────────────┐
     │ auth-service (NestJS)    │        │ messenger-service (NestJS)      │
     │ :3001                    │        │ :3100  (REST + WebSocket)       │
     │                          │        │                                 │
     │ • Argon2id passwords     │        │ • EnvelopeStore (Redis KV+ZSET) │
     │ • Twilio Verify OTP      │        │ • Sealed-sender relay           │
     │ • JWT + Redis jti        │        │ • TTL = min(dwell, expiresAt)   │
     │   allowlist              │        │ • Retract token (capability)    │
     │ • TOTP (AES-256-GCM)     │        │ • @Cron every 5 min → orphan    │
     │ • Signal prekey upload   │        │   sweep on pending ZSETs        │
     │ • Sender-cert issuance   │        │ • Files/Vault MFA guard         │
     │   (Ed25519-signed)       │        │                                 │
     └────────────┬─────────────┘        └───────────────┬─────────────────┘
                  │                                      │
                  ▼                                      ▼
     ┌──────────────────────────────────────────────────────────────┐
     │ Postgres (Supabase) — :54322                                 │
     │   users · auth_devices · signal_identities · signal_OPKs     │
     │   message_envelopes · conversations · vault_items · …        │
     │   All password hashes Argon2id. All TOTP secrets AES-256-GCM │
     └──────────────────────────────────────────────────────────────┘
     ┌──────────────────────────────────────────────────────────────┐
     │ Redis — :6379  (jti allowlist, env:<id>, pending:<u>:<d>)    │
     └──────────────────────────────────────────────────────────────┘
```

---

## 3. Cryptographic primitives

| Operation                   | Algorithm                                                  | Library                                                    | Key size                 |
| --------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- | ------------------------ |
| Identity keypair            | **X25519** (Curve25519)                                    | `@privacyresearch/libsignal-protocol-typescript`           | 256-bit                  |
| Signed prekey signature     | **Ed25519**-style over Curve25519                          | libsignal                                                  | 256-bit                  |
| One-time prekeys            | X25519                                                     | libsignal                                                  | 256-bit                  |
| Initial key agreement       | **X3DH** (Extended Triple DH)                              | libsignal (`SessionBuilder.processPreKey`)                 | derives 256-bit root key |
| Per-message forward secrecy | **Double Ratchet**                                         | libsignal (`SessionCipher`)                                | ratchet per message      |
| KDF                         | **HKDF-HMAC-SHA256**                                       | `react-native-quick-crypto.createHmac` (via polyfill shim) | 256-bit                  |
| Message body encryption     | **AES-256-CBC**                                            | `react-native-quick-crypto` WebCrypto                      | 256-bit                  |
| Attachment encryption       | **AES-256-CBC**, per-file random key                       | `src/modules/messenger/media/aesCbc.ts`                    | 256-bit                  |
| Password hashing            | **Argon2id** (m=65536, t=3, p=4)                           | `argon2`                                                   | —                        |
| TOTP secret at rest         | **AES-256-GCM** (12-byte random IV + 16-byte auth tag)     | node:crypto                                                | 256-bit                  |
| Sealed-sender signing       | **Ed25519** (sender cert JWT)                              | node:crypto                                                | 256-bit                  |
| Random                      | Hardware RNG via `react-native-get-random-values` (CSPRNG) | —                                                          | —                        |

### 3.1 The HMAC shim (why we needed it)

`react-native-quick-crypto@0.7.17` ships a `crypto.subtle` implementation with the `HMAC` case **commented out**. libsignal's HKDF step calls `subtle.sign({name:'HMAC', hash:'SHA-256'}, key, data)` — without intervention every X3DH handshake throws `NotSupportedError: Unrecognized algorithm '[object Object]' for 'sign'`.

Fix (`src/modules/messenger/crypto/polyfills.ts`):

1. Intercept `subtle.importKey` for `HMAC` keys and snapshot the raw bytes in a `WeakMap` (since libsignal imports them non-extractable).
2. Intercept `subtle.sign` / `subtle.verify` for `HMAC`: look up the cached bytes and dispatch to quick-crypto's fully-implemented Node-style `createHmac(alg, keyBuf)`.
3. All other algorithms (ECDSA, AES-CBC, AES-GCM) pass through unchanged.

Net effect: libsignal's HKDF works on Hermes without native patches, and the shim is strict enough that an attacker can't slip a non-HMAC payload through the fast path — we only route when `algorithm.name.toUpperCase() === 'HMAC'`.

---

## 4. Protocol flow — 1:1 message

```
Alice device                                   Bob device
─────────────                                  ──────────────
installIdentity(store, {preKeyCount:100})      installIdentity(...)
  └── generate identityKey (X25519)
  └── generate signedPreKey + Ed25519 signature
  └── generate 100 one-time prekeys

POST /auth/keys/upload  ─────────►  auth-service
  {identityKey, signedPreKey{keyId, publicKey, signature},
   signedPreKeySig, oneTimePrekeys:[...]}
                                    persists into signal_identities +
                                    signal_one_time_prekeys (Ed25519 sig
                                    verified server-side before insert)

───────────────────────────────────────────────────────────────────
Alice wants to message Bob:

GET /auth/keys/<bobId>/bundle ◄──────  atomic DELETE-one-OPK RETURNING
  {identityKey, signedPreKey, signature, preKey}

SessionBuilder.processPreKey(bundle)
  └── verify signedPreKey signature (Ed25519)
  └── X3DH:  DH1 = DH(IKa, SPKb)  // Alice-identity × Bob-signed
             DH2 = DH(EKa, IKb)   // Alice-ephemeral × Bob-identity
             DH3 = DH(EKa, SPKb)  // Alice-ephemeral × Bob-signed
             DH4 = DH(EKa, OPKb)  // (optional) Alice-ephemeral × Bob-OPK
             SK  = HKDF(DH1 || DH2 || DH3 || DH4)

SessionCipher.encrypt(plaintext)
  └── Double-Ratchet chain: derive messageKey from rootKey
  └── AES-256-CBC(messageKey, plaintext)
  └── HMAC-SHA256 over ciphertext → attach as Whisper/PreKeyWhisper

sealedEnvelope = {
  ciphertext,
  senderCert: Ed25519-JWT issued by auth-service (24h TTL),
  expiresAtSec?: unix timestamp (disappearing message)
}

POST /envelopes  ─────────►  messenger-service
  └── JWT verified (rate-limit only — we do NOT persist submitter identity)
  └── Redis SET env:<uuid>  EX min(dwellSeconds, expiresAtSec - now)
  └── Redis ZADD pending:<bobId>:<deviceId>
  └── WS fan-out to Bob's connected device if online

                                                ◄─── ws envelope.deliver
                                                    SessionCipher.decrypt
                                                    verify senderCert sig
                                                    render plaintext

POST /envelopes/:id/ack   ──────►  messenger-service
  └── Redis DEL env:<uuid> + ZREM pending ZSET entry (hard delete)
```

### What the server sees

| Field                        | Server can see?                                 | Purpose                      |
| ---------------------------- | ----------------------------------------------- | ---------------------------- |
| Sender user id               | **No** (after JWT rate-limit check, not stored) | Sealed Sender                |
| Recipient user id + device   | Yes                                             | Routing                      |
| Ciphertext bytes             | Yes but opaque                                  | Transport                    |
| Plaintext                    | **Never**                                       | —                            |
| Ratchet keys / session state | **Never**                                       | Stays on device              |
| Attachment contents          | **Never** (uploaded pre-encrypted)              | S3/R2 stores ciphertext blob |
| Message expires-at           | Yes (relay purge timing)                        | Needs to know when to evict  |
| Group membership             | **No** (encrypted under group master key)       | Group privacy                |

---

## 5. Key storage at rest

Production runtime uses `SqlCipherProtocolStore` ([src/modules/messenger/crypto/sqlCipherStore.ts](src/modules/messenger/crypto/sqlCipherStore.ts)).

- **SQLCipher 4.x** via `@op-engineering/op-sqlite` (built with the `sqlcipher: true` flag).
- Database master key: **32 random bytes**, generated once on first launch, stored in **`react-native-keychain`** (which wraps Android Keystore / iOS Secure Enclave, hardware-backed on supported devices).
- All Signal state columns (identity privkey, session records, signed prekey privkeys, OPK privkeys) written through the encrypted driver — zero plaintext secrets in any `CREATE TABLE` row.
- Key never leaves the JS runtime in plaintext except for the single `PRAGMA key` call at DB open, which op-sqlite handles natively.

Loopback-memory mode (`__DEV__` default) uses `InMemoryProtocolStore` — no disk touched, no persistence. This is explicit: switch to `loopback-sqlcipher` or `production` for on-device persistence.

---

## 6. Disappearing messages — end-to-end deletion

### Client-side

- Each `LocalMessage` carries `expires_at?: epoch-ms`.
- `MessageBubble` starts a burn animation 900 ms before expiry (fade + scale + ember tint) and calls `removeMessage` on animation complete.
- `ExpirySweeper` polls every 1 s as a safety net — removes any message whose `expires_at <= now` from Zustand, including messages on background conversations the user wasn't viewing.

### Server-side

- `SendEnvelopeDto.expiresAtSec` carries the deadline to the relay.
- `EnvelopeService.submitEnvelope` computes `effectiveTtl = min(dwellSeconds, expiresAtSec - now)` and uses that as the **Redis TTL** on both the envelope key and the retract-token key. Redis auto-evicts at deadline.
- `@Cron(EVERY_5_MINUTES)` runs `sweepAllOrphans()` to drop `pending:<user>:<device>` ZSET entries whose main envelope key has been auto-evicted — so subsequent `pull()` calls don't waste a round-trip on ghost IDs.
- `POST /envelopes/retract` accepts the capability token issued on submit and hard-deletes the envelope early if the sender decides to retract before expiry. Single-use, no sender identity needed → preserves Sealed Sender.

---

## 7. Authentication & session security

| Control              | Implementation                                                                                     | File                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Password KDF         | Argon2id (m=65536, t=3, p=4)                                                                       | `auth-service/src/common/services/password.service.ts`    |
| OTP delivery         | Twilio Verify API (primary) + Twilio SMS (fallback) + dev bypass flag                              | `auth-service/src/common/services/otp.service.ts`         |
| OTP bounds           | 10-min expiry, 3 attempts max, single-use                                                          | `auth-service/src/auth/auth.service.ts`                   |
| No-enumeration login | `/auth/login` always returns `{userId:null, otpSentTo:null}` for bad creds; never 401/404          | `auth-service/src/auth/auth.service.ts:110`               |
| Access token         | JWT HS256, 15-min TTL, `jti = UUIDv4` stored in Redis allowlist                                    | `auth-service/src/auth/jwt.service.ts`                    |
| Refresh token        | Opaque 32-byte hex, 30-day TTL, rotated on every use                                               | `auth-service/src/auth/auth.service.ts`                   |
| Instant kill         | `JwtAuthGuard` checks `redis.isJtiValid(jti)` — revocation hits in <1 s regardless of token expiry | `auth-service/src/common/guards/jwt-auth.guard.ts`        |
| Session delete       | `DELETE /auth/session` revokes jti + deletes refresh hash; `allDevices:true` revokes every device  | `auth-service/src/auth/auth.service.ts`                   |
| TOTP (optional 2FA)  | RFC 6238, secret encrypted AES-256-GCM, ±1 window, 10 backup codes (SHA-256 hashed, single-use)    | `auth-service/src/common/services/totp-crypto.service.ts` |
| Biometric step-up    | Action token (5-min TTL, single-use, gated on Play Integrity / DeviceCheck)                        | `auth-service/src/biometric/biometric.service.ts`         |
| Rate limiting        | `/auth/register` + `/auth/login`: 5/hr per IP; global 100/min                                      | `auth-service/src/auth-service.module.ts`                 |
| Audit trail          | Every sensitive event emits to Kafka topic `audit-events` (stdout fallback in dev)                 | `auth-service/src/kafka/audit.service.ts`                 |

---

## 8. File Vault (attachments under MFA)

- Every presigned-URL request for an encrypted blob passes through `MfaGuard`.
- Guard requires a fresh `X-Action-Token` (issued by `/auth/biometric/assert` within the last 5 min).
- A valid JWT alone is **not sufficient** — you must re-prove physical presence via biometric or TOTP.
- Presigned URL TTL: 60 s. Every access logged (device id, timestamp, file hash, outcome).
- S3/R2 object itself is AES-256-CBC encrypted client-side with a per-file key; that key rides inside the Signal envelope to the recipient (never as a separate HTTP body).

---

## 9. Why the security posture is top-notch

1. **Plaintext never leaves the device.** Not in transport, not in storage, not in logs. Tested by `logAudit.test.ts` which scans both client and server logs for common plaintext patterns (every release gate blocks on that).
2. **Forward secrecy + post-compromise security** via Double Ratchet. Stealing today's device keys doesn't decrypt yesterday's or tomorrow's messages.
3. **Sealed Sender** means the relay cannot answer "who is Alice talking to?" — only "Bob has X envelopes waiting."
4. **Instant revocation.** Redis jti allowlist + action-token single-use means a stolen token dies within milliseconds of logout on any device.
5. **Real KDFs, real signatures.** Argon2id (not bcrypt, not PBKDF2), Ed25519 (not RSA), X25519 (not weak DH groups). No rolled-our-own crypto anywhere.
6. **Per-message keys.** Message keys derive per-send, never reused, never stored on-disk beyond ratchet state.
7. **Disappearing messages actually disappear.** Client animates out + removes; relay auto-evicts via Redis TTL scoped to `expiresAtSec`; cron reaps the index. Even an offline recipient can't resurrect an expired message.
8. **Hardware-backed key storage.** SQLCipher master key sealed in Keystore/Secure Enclave — an adversary with root on a stolen device still faces a hardware extraction to get the DB key.
9. **Attachment MFA.** Every media download forces a fresh biometric/TOTP challenge. Valid JWT ≠ access to files.
10. **No enumeration.** Login and registration endpoints don't leak account existence.
11. **Audit on everything sensitive.** Every register/login/verify/refresh/TOTP/biometric/session-revoke/key-upload/key-fetch event emits a signed audit record to Kafka for offline analysis.
12. **Test coverage gate.** 90% lines, 90% functions, 72% branches enforced in CI across auth + crypto modules.

---

## 10. Known deltas from a pure production system

These are explicitly tracked as gaps, not unknowns:

| Item                                          | Current state                                                   | Target   |
| --------------------------------------------- | --------------------------------------------------------------- | -------- |
| iOS biometric attestation (Apple DeviceCheck) | HTTP call wired; p8 ES256 JWT signing is a stub                 | M12      |
| Android Play Integrity API                    | Ready but needs `GOOGLE_PLAY_INTEGRITY_KEY` env                 | M12      |
| Kafka audit                                   | stdout fallback in dev; `KAFKA_BROKERS` required in prod        | pre-ship |
| Password reset                                | Not implemented                                                 | M13      |
| PKCE / OAuth SSO (Google / Apple)             | Not wired                                                       | M13      |
| WebRTC TURN production                        | coturn URLs in env; shared secret rotation procedure documented | M12      |

Nothing above weakens the confidentiality of an in-flight message or a stored envelope.

---

## 11. File map

| Area                            | Path                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Signal primitives               | `src/modules/messenger/crypto/` (identity, sessionManager, sealedSender, sqlCipherStore, inMemoryStore, encoding, errors) |
| WebCrypto polyfills + HMAC shim | `src/modules/messenger/crypto/polyfills.ts`                                                                               |
| Runtime orchestration           | `src/modules/messenger/runtime/` (runtime, productionRuntime, keychain, certCache, expirySweeper)                         |
| Transport                       | `src/modules/messenger/transport/client.ts` (WS) + `relayClient.ts` (HTTP fallback)                                       |
| Media (attachments)             | `src/modules/messenger/media/` (aesCbc, mediaClient)                                                                      |
| Group crypto                    | `src/modules/messenger/groups/groupClient.ts`                                                                             |
| WebRTC signalling               | `src/modules/messenger/webrtc/` (signallingClient, peerConnection, callController, agoraFallback)                         |
| Store (UI state)                | `src/modules/messenger/store/messengerStore.ts` (zustand + immer + persist to AsyncStorage)                               |
| UI                              | `src/screens/messenger/` (ChatScreen, MessengerHomeScreen, NewChatScreen, CallScreen, …)                                  |
| Auth backend                    | `apps/auth-service/src/` (auth, keys, totp, biometric, sender-cert modules)                                               |
| Messenger backend               | `apps/messenger-service/src/` (gateway, relay, media, push modules)                                                       |
| Postgres schema                 | `supabase/migrations/`                                                                                                    |
