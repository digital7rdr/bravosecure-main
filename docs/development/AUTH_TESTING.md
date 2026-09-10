# Bravo Secure — Auth Service: Testing Guide & Spec Compliance

> Generated: 2026-04-17  
> Auth service: `apps/auth-service` · Port **3001** · NestJS 10  
> Mobile app: Expo (package `com.bravosecure.app`)

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Run on Physical Device — Expo](#2-run-on-physical-device--expo)
3. [Service Setup Checklist](#3-service-setup-checklist)
4. [End-to-End Manual Test Flows](#4-end-to-end-manual-test-flows)
   - [4.1 Register + OTP (Twilio Verify)](#41-register--otp-twilio-verify)
   - [4.2 Login + OTP](#42-login--otp)
   - [4.3 JWT Access Token / Protected Route](#43-jwt-access-token--protected-route)
   - [4.4 Refresh Token Rotation](#44-refresh-token-rotation)
   - [4.5 TOTP Setup + Verify](#45-totp-setup--verify)
   - [4.6 TOTP Backup Code](#46-totp-backup-code)
   - [4.7 Biometric Assertion (dev bypass)](#47-biometric-assertion-dev-bypass)
   - [4.8 Signal Pre-Key Upload + Bundle Fetch](#48-signal-pre-key-upload--bundle-fetch)
   - [4.9 Session Delete (single + all devices)](#49-session-delete-single--all-devices)
   - [4.10 Rate Limiting](#410-rate-limiting)
5. [Unit Test Suite](#5-unit-test-suite)
6. [Apple-to-Apple Spec Compliance Matrix](#6-apple-to-apple-spec-compliance-matrix)
7. [Known Gaps & Roadmap](#7-known-gaps--roadmap)

---

## 1. Prerequisites

| Dependency           | Required version                                        | Check command                            |
| -------------------- | ------------------------------------------------------- | ---------------------------------------- |
| Node.js              | ≥ 20                                                    | `node --version`                         |
| pnpm                 | ≥ 9                                                     | `pnpm --version`                         |
| Expo CLI             | latest                                                  | `npx expo --version`                     |
| Android Studio / ADB | any                                                     | `adb devices`                            |
| Supabase (local)     | running on 54321-54324                                  | `npx supabase status`                    |
| Redis                | running on **7379** (not 6379 — Hyper-V port exclusion) | `redis-cli -p 7379 ping`                 |
| NestJS auth service  | running on 3001                                         | `curl http://localhost:3001/auth/health` |

### ADB tunnel (Android physical device over USB)

```powershell
# Run once per USB connection
adb reverse tcp:8081 tcp:8081   # Metro bundler
adb reverse tcp:3001 tcp:3001   # Auth service
adb reverse tcp:7379 tcp:7379   # Redis (not needed by app directly)
adb reverse tcp:54321 tcp:54321 # Supabase API
adb reverse tcp:54322 tcp:54322 # Supabase Postgres
```

Or run the watcher script that does this automatically:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/adb-reverse-watcher.ps1
```

---

## 2. Run on Physical Device — Expo

### Android (USB)

```bash
# 1 — plug in phone, enable USB debugging, trust the computer
adb devices           # verify device appears (e.g. "R3CN...  device")

# 2 — install + launch (builds a debug APK and pushes it)
npx expo run:android

# or, if you want to pick the device explicitly:
npx expo run:android --device

# 3 — if you just want JS bundler (existing install on phone):
npx expo start --tunnel   # or --localhost if adb reverse is set up
```

> **Note:** `npx expo run:android` requires a local Android SDK (ANDROID_HOME set).
> If you only have Expo Go on the device use `npx expo start` and scan the QR code.

### iOS (physical device — Mac only)

```bash
# Requires Xcode + Apple Developer account with device registered
npx expo run:ios --device

# or open in Xcode directly after prebuild:
npx expo prebuild --platform ios
open ios/BravoSecure.xcworkspace
```

### Environment variable for the device

The app needs to reach the auth service. The `adb reverse` tunnel maps
`http://localhost:3001` inside the device to your host machine.

```bash
# .env (root) — already set:
EXPO_PUBLIC_API_BASE_URL=http://10.0.2.2:3001    # Android emulator
# For physical device with adb reverse, localhost:3001 works directly
```

If using a **physical device without USB** (Wi-Fi), replace with your machine's
LAN IP:

```bash
EXPO_PUBLIC_API_BASE_URL=http://192.168.x.x:3001
```

---

## 3. Service Setup Checklist

```bash
# 1 — start local Supabase (runs Postgres + Auth + Storage)
cd "e:/Bravo Secure"
npx supabase start

# 2 — start Redis on port 7379
redis-server --port 7379

# 3 — start the NestJS auth service (dev watch mode)
cd apps/auth-service
pnpm start:dev

# 4 — verify health
curl http://localhost:3001/auth/health
# Expected: {"ok":true,"ts":"2026-04-17T..."}
```

---

## 4. End-to-End Manual Test Flows

All `curl` examples target `http://localhost:3001`. On the device replace with
`http://10.0.2.2:3001` (emulator) or your LAN IP.

---

### 4.1 Register + OTP (Twilio Verify)

**Spec requirement:** User registers with email + password + phone. A 6-digit OTP
is sent to the phone via Twilio Verify. OTP expires in 10 min, max 3 attempts.

```bash
curl -X POST http://localhost:3001/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@bravosecure.com",
    "password": "Str0ngP@ssword!",
    "displayName": "Test User",
    "phoneE164": "+447700900000"
  }'
```

**Expected response (200):**

```json
{
  "userId": "uuid-here",
  "otpSentTo": "+447700900000"
}
```

**What to verify:**

- [ ] SMS received on `+447700900000` with 6-digit code (via Twilio Verify service `VAcaffd79f9204f0fd7dabfffa40075877`)
- [ ] Duplicate registration returns `409 Conflict`
- [ ] Rate limit: 6th request within 1 hour returns `429 Too Many Requests`

---

### 4.2 Login + OTP

```bash
curl -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "test@bravosecure.com", "password": "Str0ngP@ssword!"}'
```

**Expected (200):**

```json
{"userId": "uuid", "otpSentTo": "+447700900000"}
```

**No-enumeration test** — wrong credentials must return the same shape:

```bash
curl -X POST http://localhost:3001/auth/login \
  -d '{"email": "nobody@x.com", "password": "wrong"}'
# Expected: {"userId": null, "otpSentTo": null}   ← NOT 401 / 404
```

---

### 4.3 JWT Access Token / Protected Route

First verify the OTP from step 4.1 or 4.2:

```bash
curl -X POST http://localhost:3001/auth/verify \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "uuid-from-login",
    "code": "123456",
    "deviceId": "my-phone-uuid",
    "platform": "android"
  }'
```

**Expected (200):**

```json
{
  "user": {"id": "...", "email": "...", "role": "individual", ...},
  "accessToken": "eyJhbGci...",
  "refreshToken": "opaque-64-char-hex",
  "expiresIn": 900
}
```

**Test protected route:**

```bash
curl http://localhost:3001/auth/me \
  -H "Authorization: Bearer <accessToken>"
# Expected: {"user": {...}}

curl http://localhost:3001/auth/me
# Expected: 401 Unauthorized — no bearer token
```

**JWT payload must contain:**

- `sub` — user UUID
- `iss` — `"auth-service"`
- `aud` — `"bravo-api"`
- `jti` — UUID v4 (stored in Redis for instant-kill)
- `device_id`
- `role`

---

### 4.4 Refresh Token Rotation

```bash
curl -X POST http://localhost:3001/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken": "<opaque-token-from-verify>"}'
```

**Expected (200):** New `accessToken` + new `refreshToken` (old refresh token is rotated).

**Revocation test:**

```bash
# After refresh, the old refreshToken must be invalid:
curl -X POST http://localhost:3001/auth/refresh \
  -d '{"refreshToken": "<old-token>"}'
# Expected: 401 Unauthorized
```

---

### 4.5 TOTP Setup + Verify

```bash
# Setup — requires valid access token
curl -X POST http://localhost:3001/totp/setup \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"deviceId": "my-phone-uuid"}'
```

**Expected:**

```json
{
  "uri": "otpauth://totp/Bravo%20Secure:test%40bravosecure.com?...",
  "backupCodes": ["ABCD1234", "EFGH5678", ...]   // 10 codes
}
```

Scan the `uri` with Google Authenticator / Authy. Then verify:

```bash
curl -X POST http://localhost:3001/totp/verify \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "uuid",
    "code": "654321",
    "deviceId": "my-phone-uuid",
    "platform": "android"
  }'
```

**Expected:** `{user, accessToken, refreshToken, expiresIn}` — full session issued.

---

### 4.6 TOTP Backup Code

```bash
curl -X POST http://localhost:3001/totp/verify \
  -d '{
    "userId": "uuid",
    "code": "ABCD1234",
    "deviceId": "my-phone-uuid",
    "platform": "android"
  }'
```

- [ ] Backup code is consumed (single-use — second attempt returns 400)
- [ ] All 10 codes are unique
- [ ] Case-insensitive matching

---

### 4.7 Biometric Assertion (dev bypass)

`BIOMETRIC_DEV_BYPASS=true` is set in `.env` so attestation is skipped in dev.

```bash
curl -X POST http://localhost:3001/biometric/assert \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "android",
    "attestationToken": "dev-bypass",
    "purpose": "transfer_confirm"
  }'
```

**Expected (200):**

```json
{
  "actionToken": "eyJhbGci...",
  "expiresIn": 300,
  "purpose": "transfer_confirm"
}
```

Action token has 5-minute TTL. Present to sensitive endpoints as
`X-Action-Token: <token>`.

---

### 4.8 Signal Pre-Key Upload + Bundle Fetch

```bash
# Upload key bundle
curl -X POST http://localhost:3001/keys/upload \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "registrationId": 12345,
    "identityKey": "<base64-32-bytes>",
    "signedPrekeyId": 1,
    "signedPrekey": "<base64>",
    "signedPrekeySig": "<base64-64-bytes>",
    "oneTimePrekeys": [
      {"keyId": 1, "publicKey": "<base64>"},
      {"keyId": 2, "publicKey": "<base64>"}
    ]
  }'
```

**Expected:** `{"ok": true, "oneTimeKeysStored": 2, "poolSize": 2}`

**Fetch bundle (simulate recipient):**

```bash
curl http://localhost:3001/keys/<targetUserId>/bundle \
  -H "Authorization: Bearer <accessToken>"
```

**Expected:** Full X3DH bundle with one OPK. Verify:

- [ ] `X-Pre-Key-Count` response header present (pool size)
- [ ] OPK is deleted after fetch (atomic DELETE … RETURNING)
- [ ] Second fetch returns different OPK (or null if pool exhausted)

---

### 4.9 Session Delete (single + all devices)

**Single device:**

```bash
curl -X DELETE http://localhost:3001/auth/session \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"deviceId": "my-phone-uuid"}'
```

After deletion, the `accessToken` must be immediately invalid (Redis jti revoked):

```bash
curl http://localhost:3001/auth/me \
  -H "Authorization: Bearer <same-accessToken>"
# Expected: 401 Unauthorized
```

**All devices:**

```bash
curl -X DELETE http://localhost:3001/auth/session \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"deviceId": "x", "allDevices": true}'
```

---

### 4.10 Rate Limiting

```bash
# 6 POSTs to /auth/register within 60 seconds
for i in {1..6}; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3001/auth/register \
    -H "Content-Type: application/json" \
    -d '{"email":"x'$i'@x.com","password":"p","displayName":"x","phoneE164":"+1555000000'$i'"}'
done
# Expected: 200 200 200 200 200 429
```

---

## 5. Unit Test Suite

```bash
cd apps/auth-service

# Run all tests
pnpm test

# Run with coverage report
pnpm test:cov

# Run a single spec
pnpm test -- --testPathPattern=auth.service

# Run in watch mode
pnpm test -- --watch
```

### Coverage thresholds (enforced in CI)

| Metric    | Threshold |
| --------- | --------- |
| Lines     | ≥ 90%     |
| Functions | ≥ 90%     |
| Branches  | ≥ 72%     |

### Spec files and what they cover

| File                                          | Tests | Key coverage                                                                                                  |
| --------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------- |
| `auth/auth.service.spec.ts`                   | 16    | register, login (no-enumeration), OTP verify, refresh, getMe, session delete                                  |
| `auth/jwt.service.spec.ts`                    | 13    | sign/verify access + action token, wrong secret rejection, refresh token hash, ttlToSeconds                   |
| `common/services/password.service.spec.ts`    | 5     | Argon2id hash uniqueness, verify correct/wrong/empty                                                          |
| `common/services/totp-crypto.service.spec.ts` | 12    | AES-256-GCM round-trip, random IV, bad encKey throw, generateSecret, verifyCode, backup codes, hashBackupCode |
| `common/services/otp.service.spec.ts`         | 6     | generate(), hash(), Twilio Verify path, SMS fallback, missing credentials                                     |
| `common/guards/jwt-auth.guard.spec.ts`        | 5     | missing bearer, invalid JWT, revoked jti, valid token pass-through                                            |
| `totp/totp.service.spec.ts`                   | 11    | setup, verify TOTP code, backup code consume, bad code, audit events                                          |
| `biometric/biometric.service.spec.ts`         | 9     | dev bypass, Android/iOS failure paths, action token issuance                                                  |
| `keys/keys.service.spec.ts`                   | 9     | upload identity + OPKs, incremental append (ON CONFLICT DO NOTHING), fetch bundle, atomic OPK delete          |

---

## 6. Apple-to-Apple Spec Compliance Matrix

> Legend: **PASS** = fully implemented | **PARTIAL** = implemented with noted caveat | **PENDING** = not yet implemented

### 6.1 Authentication Core

| #   | Spec Requirement                                   | Status   | Implementation                                                                          | File                                  |
| --- | -------------------------------------------------- | -------- | --------------------------------------------------------------------------------------- | ------------------------------------- |
| 1   | User registration with email + password + phone    | **PASS** | `POST /auth/register` with class-validator DTO                                          | `auth/auth.controller.ts:29`          |
| 2   | Passwords hashed with Argon2id (m=65536, t=3, p=4) | **PASS** | `argon2.hash(pwd, {type:argon2.argon2id, memoryCost:65536, timeCost:3, parallelism:4})` | `common/services/password.service.ts` |
| 3   | 6-digit OTP sent via SMS on register + login       | **PASS** | Twilio Verify API (`VAcaffd79f9204f0fd7dabfffa40075877`)                                | `common/services/otp.service.ts`      |
| 4   | OTP expires after 10 minutes                       | **PASS** | `expires_at = now() + OTP_TTL_MINUTES * 60s`                                            | `auth/auth.service.ts:82`             |
| 5   | OTP max 3 attempts before lockout                  | **PASS** | `attempt_count` column, `BadRequestException('otp_max_attempts')`                       | `auth/auth.service.ts:143`            |
| 6   | OTP is single-use (`used_at` timestamp)            | **PASS** | Checked before use; set on success                                                      | `auth/auth.service.ts:141,157`        |
| 7   | No account enumeration on login failure            | **PASS** | Always returns `{userId:null, otpSentTo:null}` regardless of whether account exists     | `auth/auth.service.ts:110-112`        |
| 8   | Login accepts email OR phone                       | **PASS** | `LoginDto` has optional `email` + `phoneE164`; throws `400` if neither provided         | `auth/auth.service.ts:98`             |

### 6.2 JWT Tokens

| #   | Spec Requirement                                                | Status   | Implementation                                         | File                                             |
| --- | --------------------------------------------------------------- | -------- | ------------------------------------------------------ | ------------------------------------------------ |
| 9   | Short-lived access token (15 min)                               | **PASS** | `JWT_ACCESS_TTL=15m`, signed with `jose`               | `auth/jwt.service.ts`                            |
| 10  | JWT payload: `sub, iss, aud, jti, device_id, role, exp`         | **PASS** | All claims present in `signAccessToken`                | `auth/jwt.service.ts`                            |
| 11  | `iss` = `"auth-service"`                                        | **PASS** | Hardcoded                                              | `auth/jwt.service.ts`                            |
| 12  | `aud` = `"bravo-api"`                                           | **PASS** | Hardcoded                                              | `auth/jwt.service.ts`                            |
| 13  | `jti` = UUID v4 (stored in Redis allowlist)                     | **PASS** | `randomUUID()` → `SET jti:{uuid} 1 EX 900`             | `auth/jwt.service.ts` + `redis/redis.service.ts` |
| 14  | Refresh token opaque (random 32-byte hex)                       | **PASS** | `randomBytes(32).toString('hex')`                      | `auth/jwt.service.ts`                            |
| 15  | Refresh token 30-day TTL                                        | **PASS** | `JWT_REFRESH_TTL=30d`                                  | `auth/auth.service.ts:36`                        |
| 16  | Refresh token rotation on use                                   | **PASS** | New token issued + old hash replaced in `auth_devices` | `auth/auth.service.ts:172-193`                   |
| 17  | Action token for biometric-gated operations (5 min, single-use) | **PASS** | `signActionToken`, stored in Redis with 300s TTL       | `biometric/biometric.service.ts:38-39`           |

### 6.3 Redis jti Allowlist (Instant-Kill)

| #   | Spec Requirement                                              | Status   | Implementation                                               | File                              |
| --- | ------------------------------------------------------------- | -------- | ------------------------------------------------------------ | --------------------------------- |
| 18  | Access token jti stored in Redis on issue                     | **PASS** | `redis.storeJti(jti, 900)`                                   | `auth/auth.service.ts:45`         |
| 19  | JwtAuthGuard validates jti against Redis (not just signature) | **PASS** | `redis.isJtiValid(jti)` in guard; 401 if not found           | `common/guards/jwt-auth.guard.ts` |
| 20  | Session delete revokes jti instantly in Redis                 | **PASS** | `redis.revokeJti(current_jti)`                               | `auth/auth.service.ts:218`        |
| 21  | All-devices logout revokes all active jtis                    | **PASS** | `redis.revokeJtis(allJtis)`                                  | `auth/auth.service.ts:210`        |
| 22  | Previous jti revoked on token refresh                         | **PASS** | Looks up `prev.current_jti` → `revokeJti` before issuing new | `auth/auth.service.ts:44`         |

### 6.4 TOTP (RFC 6238)

| #   | Spec Requirement                                          | Status   | Implementation                                    | File                                                   |
| --- | --------------------------------------------------------- | -------- | ------------------------------------------------- | ------------------------------------------------------ |
| 23  | TOTP secret generated with `otpauth` library              | **PASS** | `new OTPAuth.TOTP({...})`                         | `common/services/totp-crypto.service.ts`               |
| 24  | TOTP secret encrypted at rest (AES-256-GCM)               | **PASS** | 12-byte random IV + ciphertext + 16-byte auth tag | `common/services/totp-crypto.service.ts`               |
| 25  | Encryption key must be 64 hex chars (32 bytes)            | **PASS** | Throws on startup if key is wrong length          | `common/services/totp-crypto.service.ts:encryptSecret` |
| 26  | TOTP window ±1 step                                       | **PASS** | `{window: 1}` in `totp.validate()`                | `common/services/totp-crypto.service.ts`               |
| 27  | 10 backup codes, 8 chars each (A-Z, 2-9)                  | **PASS** | `generateBackupCodes()` returns 10 codes          | `common/services/totp-crypto.service.ts`               |
| 28  | Backup codes hashed with SHA-256 before storage           | **PASS** | `hashBackupCode()` — uppercase + trim before hash | `common/services/totp-crypto.service.ts`               |
| 29  | Backup codes are single-use                               | **PASS** | `used_at` set on redemption                       | `totp/totp.service.ts:73`                              |
| 30  | TOTP setup returns `otpauth://` URI for QR                | **PASS** | `uri` returned in `setup()` response              | `totp/totp.service.ts:47`                              |
| 31  | TOTP verify issues full session (access + refresh tokens) | **PASS** | Calls `authService.issueSession()` on success     | `totp/totp.service.ts:94`                              |

### 6.5 Biometric Attestation

| #   | Spec Requirement                                    | Status      | Implementation                                                                | File                                   |
| --- | --------------------------------------------------- | ----------- | ----------------------------------------------------------------------------- | -------------------------------------- |
| 32  | Android Play Integrity API validation               | **PARTIAL** | `validateAndroid()` implemented; requires `GOOGLE_PLAY_INTEGRITY_KEY` env var | `biometric/biometric.service.ts:45`    |
| 33  | iOS DeviceCheck validation                          | **PARTIAL** | HTTP call wired; p8 JWT signing not yet implemented (warns in log)            | `biometric/biometric.service.ts:59-69` |
| 34  | Dev bypass mode (`BIOMETRIC_DEV_BYPASS=true`)       | **PASS**    | Skips attestation; logs warning                                               | `biometric/biometric.service.ts:24-26` |
| 35  | Issues short-lived action token on success          | **PASS**    | 300s TTL, stored in Redis                                                     | `biometric/biometric.service.ts:38-39` |
| 36  | Audit event on biometric assert (success + failure) | **PASS**    | `audit.emit({event_type:'auth.biometric.assert', ...})`                       | `biometric/biometric.service.ts:34,41` |

### 6.6 Signal Protocol Key Exchange

| #   | Spec Requirement                                                  | Status   | Implementation                                                                  | File                         |
| --- | ----------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------- | ---------------------------- |
| 37  | Upload: identity key, signed prekey + signature, one-time prekeys | **PASS** | `POST /keys/upload` persists to `signal_identities` + `signal_one_time_prekeys` | `keys/keys.service.ts:16`    |
| 38  | Ed25519 signature verification on signed prekey                   | **PASS** | `createPublicKey` + `cryptoVerify(null, ...)` for 32-byte keys                  | `keys/keys.service.ts:21-30` |
| 39  | OPK upload is incremental (`ON CONFLICT DO NOTHING`)              | **PASS** | Append-only; never replaces existing keys                                       | `keys/keys.service.ts:50-55` |
| 40  | Bundle fetch atomically deletes one OPK                           | **PASS** | `DELETE … WHERE ctid=(SELECT ctid … LIMIT 1) RETURNING …`                       | `keys/keys.service.ts:79-84` |
| 41  | `X-Pre-Key-Count` header warns when pool < 10                     | **PASS** | Set in `keys.controller.ts` on bundle fetch                                     | `keys/keys.controller.ts`    |
| 42  | Audit event on key upload + bundle fetch                          | **PASS** | `audit.emit` in both `upload()` and `fetchBundle()`                             | `keys/keys.service.ts:63,90` |

### 6.7 Rate Limiting

| #   | Spec Requirement                          | Status   | Implementation                                      | File                         |
| --- | ----------------------------------------- | -------- | --------------------------------------------------- | ---------------------------- |
| 43  | `/auth/register` — 5 requests/hour per IP | **PASS** | `@Throttle({default: {limit:5, ttl:3600_000}})`     | `auth/auth.controller.ts:27` |
| 44  | `/auth/login` — 5 requests/hour per IP    | **PASS** | `@Throttle({default: {limit:5, ttl:3600_000}})`     | `auth/auth.controller.ts:33` |
| 45  | Global rate limit: 100 req/min            | **PASS** | `RATE_LIMIT_GLOBAL_PER_MIN=100` in throttler config | `auth-service.module.ts`     |

### 6.8 Audit Logging

| #   | Spec Requirement                                                                                                                  | Status   | Implementation                                               | File                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------ | ------------------------ |
| 46  | Kafka audit topic `audit-events`                                                                                                  | **PASS** | KafkaJS producer; stdout fallback when `KAFKA_BROKERS` unset | `kafka/audit.service.ts` |
| 47  | Audit event shape: `{event_type, user_id, device_id, ip, outcome, detail?, ts}`                                                   | **PASS** | All calls pass this shape                                    | All `*.service.ts` files |
| 48  | Events for: register, login, verify, refresh, totp.setup, totp.verify, biometric.assert, session.revoked, keys.upload, keys.fetch | **PASS** | All 10 event types emitted                                   | Multiple services        |

### 6.9 OTP Delivery (Twilio)

| #   | Spec Requirement                                                          | Status   | Implementation                                                    | File                             |
| --- | ------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------- | -------------------------------- |
| 49  | Primary: Twilio Verify API (when `TWILIO_VERIFY_SID` set)                 | **PASS** | `client.verify.v2.services(verifySid).verifications.create(...)`  | `common/services/otp.service.ts` |
| 50  | Fallback: Twilio Programmable SMS (when `TWILIO_FROM` set, no Verify SID) | **PASS** | `client.messages.create({to, from, body})`                        | `common/services/otp.service.ts` |
| 51  | Dev mode: silent (no SMS sent, `OTP_DEV_RETURN_CODE=false`)               | **PASS** | Early return when `otp.devReturnCode` is true                     | `common/services/otp.service.ts` |
| 52  | Live credentials configured                                               | **PASS** | `TWILIO_ACCOUNT_SID=AC6a72e9...`, `TWILIO_VERIFY_SID=VAcaffd7...` | `apps/auth-service/.env`         |

---

## 7. Known Gaps & Roadmap

| Item                      | Description                                                                                                     | Priority |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- | -------- |
| iOS biometric (p8 JWT)    | Apple DeviceCheck requires ES256 JWT signed with team p8 key. The HTTP call is wired but JWT signing is a stub. | Medium   |
| Android Play Integrity    | Requires `GOOGLE_PLAY_INTEGRITY_KEY` env var (Google Cloud API key). Not needed in dev due to bypass.           | Medium   |
| Integration tests         | E2E tests against real Postgres + Redis (not mocked). Recommended before production.                            | High     |
| KYC webhook               | `kyc_status` transitions beyond `'approved'` on OTP verify — full third-party KYC flow not wired.               | Low      |
| Kafka in production       | `KAFKA_BROKERS` must be set in prod; currently stdout-only in dev.                                              | Medium   |
| Password reset flow       | `POST /auth/password-reset` not yet implemented.                                                                | Medium   |
| PKCE / OAuth social login | Google/Apple SSO not yet wired.                                                                                 | Low      |
