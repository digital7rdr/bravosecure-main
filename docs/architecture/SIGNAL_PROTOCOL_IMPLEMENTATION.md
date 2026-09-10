# Signal Protocol Implementation — Bravo Secure

**A step-by-step walkthrough of every Signal-Protocol stage, mapped against the actual code, with a built / partial / not-built coverage scorecard and a verified "what's broken" list.**

- **Date:** 2026-06-27
- **Branch audited:** `fix/deptchat-audit` (HEAD `4f3289c`)
- **Scope:** mobile client (`src/modules/messenger`), shared crypto package (`packages/messenger-core`), backend services (`apps/auth-service`, `apps/messenger-service`)
- **Method:** 19 parallel code-reading auditors (one per architecture section), every "broken" claim of High/Critical severity re-checked by an independent adversarial verifier. Ground-truth baseline: `npm run test:crypto` → **130 suites / 1118 tests passing**.
- **Crypto library:** `@privacyresearch/libsignal-protocol-typescript` (X3DH + Double Ratchet are delegated to it, _not_ re-implemented — this is correct Signal practice).

> **Legend:** ✅ Built · 🟡 Partial / by-design-delegated · ❌ Not built · ⚠️ Has a broken/risk finding
>
> "Partial" almost always means _the canonical Signal function name has no standalone equivalent because the work is delegated to libsignal or to the native WebRTC layer_ — which is the correct architecture, not a gap. Genuine gaps are called out explicitly.

---

## 0. Executive summary

You asked two things: **(1)** explain each step of the Signal Protocol and show which steps are built vs not, and **(2)** assess your 18-section architecture (chat + calls + groups + group calls) for coverage, noting that "Signal Protocol only covers ~30–40%; calls and group calls are the larger part."

**That framing is accurate, and Bravo Secure has built essentially all four systems.** This is not a Signal-crypto-only prototype — it is a near-complete WhatsApp/Signal-grade stack:

| Major system (your summary)                                             | Coverage | Verdict                                                                  |
| ----------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| 1. Signal crypto engine (identity, X3DH, Double Ratchet, sealed sender) | ~90%     | ✅ Built, faithful to libsignal; **one critical time-bomb bug** (see §1) |
| 2. Messaging backend (relay, offline queue, ACK/retry, dedup)           | ~90%     | ✅ Built, sealed-sender-blind relay, durable outbox                      |
| 3. Call / WebRTC stack (1:1 signaling, DTLS-SRTP, fingerprint pinning)  | ~85%     | ✅ Built; answer/media-state auth is built-but-dormant                   |
| 4. Group-call SFU infrastructure (mediasoup + SFrame/FrameCryptor E2EE) | ~80%     | ✅ Built; **one high-severity rekey bug** + no screen-share/raise-hand   |

**Overall: the system is substantially more complete than "30–40%."** Calls and group calls — the harder, larger part — are real, hardened, and mostly working. The gaps are specific and enumerated below, not structural.

### 0.1 Coverage scorecard (your 18 sections + Sealed Sender as a bonus)

| #   | Section                           | Status | Coverage | Findings                                                    |
| --- | --------------------------------- | :----: | :------: | ----------------------------------------------------------- |
| 1   | Core Crypto Layer — Identity Keys |  ✅⚠️  |   90%    | 🔴 **1 critical** (identity regen), 🟠 1 high, 1 med, 1 low |
| 2   | X3DH Handshake                    |   ✅   |   90%    | 1 med, 2 low                                                |
| 3   | Double Ratchet                    |   ✅   |   85%    | 1 med, 2 low                                                |
| 4   | Message Encryption Layer          |   ✅   |   95%    | 1 low                                                       |
| 5   | Sender Key System (Groups)        |   🟡   |   70%    | 2 med (equivocation, no per-msg FS), 2 low                  |
| 6   | Group Management                  |  ✅⚠️  |   85%    | 🟠 **1 high** (leave ≠ forward secrecy), 1 med, 2 low       |
| 7   | Attachments / Media               |   ✅   |   85%    | 2 med, 2 low; ❌ no thumbnail, no content hash              |
| 8   | Voice Call Signaling              |   ✅   |   90%    | 1 med (answer auth dormant), 1 low                          |
| 9   | Call Key Agreement (DTLS-SRTP)    |   ✅   |   85%    | 3 low; ❌ ZRTP (intentional)                                |
| 10  | Audio/Video Media Pipeline        |   ✅   |   78%    | 3 low (native-delegated)                                    |
| 11  | Group Call Encryption             |  ✅⚠️  |   80%    | 🟠 **1 high** (FrameCryptor rekey), 2 low                   |
| 12  | Group Call Signaling              |   🟡   |   75%    | 1 med; ❌ screen-share, ❌ raised-hand                      |
| 13  | SFU / Media Server (mediasoup)    |   ✅   |   85%    | 2 med (room-token), 2 low                                   |
| 14  | Push / Offline Delivery           |  ✅⚠️  |   85%    | 🟠→🟡 1 med (killed-app calls), 1 med, 2 low                |
| 15  | Persistence Layer                 |   ✅   |   90%    | 1 med, 2 low                                                |
| 16  | Security Hardening                |   ✅   |   92%    | 1 med (strict-trust off), 1 low                             |
| 17  | Multi-Device Support              |   🟡   |   40%    | 🟠 **1 high** (bundle binding), 1 med (2nd device), 2 low   |
| 18  | Backend APIs                      |   ✅   |   90%    | 2 med (fail-open defaults), 2 low; ❌ gRPC (by design)      |
| 19  | Sealed Sender v2 (bonus)          |   ✅   |   92%    | 1 med (revoke-all), 1 low                                   |

### 0.2 Is anything broken? — verified findings (adversarially confirmed)

Every High/Critical claim below was independently re-checked by a second agent that tried to _refute_ it. **None were refuted.** Ranked by severity:

|       Sev       | What's broken                                                                                                                                                                                                                                                                                                                           | Where                                                                                                                   | Effect                                                                                                                                                                                                                              |
| :-------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔴 **CRITICAL** | **Long-term identity key silently regenerates after the first signed-prekey rotation.** The "install complete" sentinel is hardcoded to signed-prekey id 1, but the 30-day SPK rotation _deletes_ id 1 (retention window == rotation interval). On the next boot, the installer sees the sentinel missing and regenerates the identity. | `packages/messenger-core/src/crypto/identity.ts:43-45,174-183,294-296`                                                  | Every existing Signal session breaks (peers hold the old identity key → Bad-MAC / handshake failures). Deterministic for any install that survives ~30 days. **Fix before any long-lived release.**                                 |
|     🟠 HIGH     | **MITM bundle-binding (P0-I2) ships disabled.** The protection is fully built and tested but the live `KeysHttpClient` is constructed without `authorityPubKeyB64`, so `verifyOrThrow` early-returns and accepts any peer bundle.                                                                                                       | `src/modules/messenger/runtime/productionRuntime.ts:385`; `packages/messenger-core/src/transport/keysClient.ts:213-214` | A malicious/coerced keys-service can swap a peer's identity key during X3DH and the client trusts it. Pure config fix (pass the authority key that's already in `config`).                                                          |
|     🟠 HIGH     | **Leaving a group provides no forward secrecy.** `leaveGroup` broadcasts only the `leave` action and never rotates the master key (the leaver can't authorize the rekey, and no remaining-admin auto-rekey exists).                                                                                                                     | `src/modules/messenger/runtime/productionRuntime.ts:2977-3028`                                                          | A departed member keeps the still-current master key and can decrypt all future group messages. (Note: **`removeGroupMember` IS forward-secure** — only voluntary _leave_ is affected.)                                             |
|     🟠 HIGH     | **Group-call rekey doesn't switch the sender's encryption key.** `FrameCryptorOrchestrator.rotate()` pushes new keys at a new ring index but never calls `setCryptorKeyIndex` (zero call sites repo-wide), so the sender keeps encrypting under the old epoch's key.                                                                    | `src/modules/messenger/webrtc/frameCryptorOrchestrator.ts:135-145`                                                      | A removed member who kept the prior epoch key can still decrypt post-removal group-call media. Mitigated (not replaced) by the host kicking them off the SFU. Also explains the B-42 "joiner never produces → Call failed" symptom. |
|     🟡 MED      | **Killed-app incoming calls don't ring.** The FCM headless handler is dead code (registration removed because a 2nd JS VM fought the SQLCipher lock); only foreground/recently-backgrounded wakes work.                                                                                                                                 | `src/modules/messenger/push/fcmHeadless.ts:32`; `index.js:31-54`                                                        | A fully killed/frozen Android process won't ring on an incoming call. Intentional documented deferral; message banners still appear natively.                                                                                       |

**Other notable (un-verified, medium) issues worth a look:** strict identity-trust is OFF by default so a MITM key-flip is accepted on receive (§16); `revoke-all`/sign-out doesn't actually invalidate outstanding sender certs (§19); group messages have no per-member signing key (a malicious member can equivocate) and no within-epoch forward secrecy (§5); SFU room tokens have no conversation-membership check and fail open if the secret is unset (§12/13/18); media download URLs default to lax (open) mode (§7); a 2nd device would silently receive no messages (§17).

---

## Part A — The Signal Protocol, step by step

This is the conceptual walkthrough you asked for. Each step says **what it is**, **how Bravo implements it**, and **whether it's built**. (Detailed per-file evidence is in Part B.)

### Step 1 — Long-term identity keys ✅

Every user generates a long-term **Curve25519 identity key pair** + a 14-bit **registration ID**.
In Bravo: `installIdentity()` (`packages/messenger-core/src/crypto/identity.ts:32-103`) calls libsignal's `KeyHelper.generateIdentityKeyPair()` + `generateRegistrationId()` once on first boot, inside a SQLCipher transaction. **Built.** ⚠️ But see the critical regeneration bug in §1.

### Step 2 — Prekeys (signed + one-time) ✅

A medium-lived **signed prekey** (signed by the identity key) and a pool of single-use **one-time prekeys** are published so others can start a session while you're offline.
In Bravo: generated in `installIdentity()`, rotated every 30 days (`rotateSignedPreKey`), refilled when the server reports the pool is low (`maybeReplenishOwnOpks`), and uploaded as a bundle via `POST /auth/keys/upload`. The server verifies the signed-prekey signature and pops exactly one OPK per fetch. **Built.**

### Step 3 — X3DH key agreement (first contact) ✅

Alice fetches Bob's prekey bundle and performs the **4 Diffie-Hellman operations** to derive a shared root secret — without Bob being online.
In Bravo: `SessionManager.initOutgoingSession()` (`sessionManager.ts:99-132`) wraps libsignal's `SessionBuilder.processPreKey()`, which performs the actual 4 DHs and root-secret derivation. The bundle is fetched via `GET /auth/keys/:userId`. **Built** (the DH math is correctly delegated to libsignal; there is no hand-rolled `deriveSharedSecret`, which is the right call). Bravo adds a non-standard **authority-signed bundle binding** to defeat a malicious keys-service — but it ships disabled (HIGH, §17).

### Step 4 — Double Ratchet (per-message keys) ✅

Every message gets a fresh key via a **DH ratchet** (key changes each direction-switch → break-in recovery) + **symmetric send/receive chains** (one key per message → forward secrecy), with counters and skipped-message-key caching for out-of-order delivery.
In Bravo: delegated to libsignal `SessionCipher` (`sessionManager.encrypt/decrypt`). The app adds a **per-peer mutex** and an **atomic receive transaction** so the ratchet advance + plaintext + dedup all commit together. Ratchet state (root key, chain keys, counters, skipped keys) lives inside libsignal's opaque serialized record in the SQLCipher `sessions` table. **Built.**

### Step 5 — Message body encryption ✅ (with an important clarification)

> Your section 4 suggested "AES-GCM OR ChaCha20-Poly1305" for the body. **Signal does not do that, and neither does Bravo — correctly.** The body is encrypted by the Double Ratchet (AES-256-CBC + HMAC-SHA256 inside libsignal). AES-GCM appears only at the _outer_ layers (sealed-sender wrap, group master key, call SFrame).
> The send pipeline: `sealPayload` (binds AAD) → libsignal ratchet encrypt → `wrapOuter` (sealed-sender ECIES) → durable outbox → WS/HTTP relay. **Built**, with delivery ACK + exponential-backoff retry + dedup. (§4)

### Step 6 — Sealed Sender v2 (metadata protection) ✅

Hides _who sent the message_ from the relay: a server-issued **sender certificate**, an outer **X25519 ECIES + AES-GCM envelope** with the cert bound into the AEAD's AAD. The relay sees only opaque bytes.
In Bravo: `senderCert.ts` + `outerEcies.ts` (v3 binds the cert into the GCM AAD), verified _before_ libsignal decrypt. **Built** (§19). One gap: `revoke-all`/sign-out doesn't invalidate outstanding certs.

### Step 7 — Groups: key distribution & messaging 🟡 (deliberate design divergence)

> Your section 5 asked for **Signal Sender Keys** (per-member ratcheted chain key + per-member signing key). **Bravo does NOT use Sender Keys.** It uses a documented **group master-key broadcast** model: one shared 32-byte AES-256-GCM key, distributed to each member inside sealed pairwise Signal envelopes, rotated on membership change. This is sanctioned by the architecture contract (CLAUDE.md), but it has two real consequences vs canonical Signal:
>
> - **No per-member signing key** → a malicious member can _equivocate_ (send different bodies to different members); recipients can't cryptographically prove they got the same bytes.
> - **No per-message ratchet** → no within-epoch forward secrecy; one leaked epoch key exposes every message in that epoch.
>   Forward secrecy exists only at epoch boundaries (rekey on add/remove). **Built but partial** vs the canonical concept. (§5)

### Step 8 — Calls (signaling + media keys) ✅

- **Signaling** (offer/answer/ICE/hangup) rides the authenticated WebSocket relay; `call.offer` is additionally bound to a signed sender certificate. (§8)
- **Media keys** for 1:1 are derived automatically by **DTLS-SRTP** inside libwebrtc — there is no manual `callMasterKey`, which is correct. Bravo adds **SDP fingerprint pinning + cert continuity + an SRTP cipher allowlist** as MITM defense (stronger than the bare contract). (§9)

### Step 9 — Group calls (SFU + frame encryption) ✅

Media flows through a **mediasoup SFU** (server forwards but can't decrypt). On top of DTLS-SRTP, every frame is E2E-encrypted with **SFrame / native FrameCryptor**, keyed by an HKDF of the group master key, with a strict **fail-closed** posture (no plaintext-to-SFU fallback). **Built** (§11/§13). ⚠️ The rekey-on-leave key-index switch is missing (HIGH, §11).

### Step 10 — Hardening, persistence, push, multi-device 🟡

Replay dedup, safety numbers, hardware keystore, SQLCipher-at-rest, offline relay queue, FCM/APNs wake — all **built** (§14–16). **Multi-device is the one genuinely thin area**: the backend supports per-device identities, but the client is hardcoded to device 1 (Phase-1 by design). (§17)

---

## Part B — Section-by-section audit

Each section: status, your checklist mapped to real code, a plain-English "how it actually works," gaps, and broken findings with `file:line` evidence.

---

### 1. Core Crypto Layer — Identity Keys — ✅⚠️ 90%

**Concept:** long-term Curve25519 identity + 14-bit registration ID + signed prekey + one-time prekeys, published as a bundle; signed prekey rotated periodically, OPKs single-use and refilled; encrypted backup for device restore.

| Your checklist item        | Status | Actual name in code                                                                                                        | Evidence                                              |
| -------------------------- | :----: | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `generateIdentityKey()`    |   ✅   | `installIdentity()` → `KeyHelper.generateIdentityKeyPair()` + `generateRegistrationId()`                                   | `messenger-core/src/crypto/identity.ts:68-69`         |
| `generateSignedPreKey()`   |   ✅   | `KeyHelper.generateSignedPreKey()` in `installIdentity` & `rotateSignedPreKey`                                             | `identity.ts:92, :274`                                |
| `generateOneTimePreKeys()` |   ✅   | loop of `KeyHelper.generatePreKey()` (pool of 50); `maybeReplenishOwnOpks()` for refill                                    | `identity.ts:86-89`; `productionRuntime.ts:3726-3730` |
| `uploadKeysToServer()`     |   ✅   | `publishOwnBundle()` → `uploadBundle()` → `POST /auth/keys/upload`                                                         | `productionRuntime.ts:3568`; `keys.controller.ts:20`  |
| key generation module      |   ✅   | `messenger-core/src/crypto/identity.ts`                                                                                    | `identity.ts:32-103`                                  |
| key storage                |   ✅   | SQLCipher (`identity`/`pre_keys`/`signed_pre_keys`) local; Postgres `signal_identities`/`signal_one_time_prekeys` server   | `sqlCipherStore.ts:482-491`; `keys.service.ts:90-136` |
| key rotation               |   ✅   | `shouldRotateSignedPreKey`/`rotateSignedPreKey` (30-day cadence). No client-side _identity_-key rotation (matches Signal). | `identity.ts:202-307`                                 |
| secure backup              |   ✅   | `identityBackup.ts`: argon2id(password) → AES-GCM-wrapped 32B master key wrapping the serialized identity                  | `backup/identityBackup.ts:101-301`                    |

**How it actually works:** First boot runs `installIdentity()` inside a SQLCipher transaction — generates registration ID + identity key pair, then N one-time prekeys, then **last** writes the signed prekey at fixed id 1 as a "complete install" sentinel so a crash mid-loop rolls back cleanly. `publishOwnBundle()` uploads the public bundle; the server verifies the XEd25519 signed-prekey signature, detects identity rotation (wiping orphaned OPKs), and pops one OPK atomically per peer fetch. Signed prekeys rotate every 30 days; OPKs refill when the server header reports the pool < 10. Backups encrypt the private keys under an argon2id-derived key.

**Gaps:** No scheduled rotation of the _long-term identity_ key (consistent with Signal). `ownIdentityRotation.ts` depends on a relay purge endpoint that isn't built yet (no-op today). Two divergent copies of `identity.ts`/`keysClient.ts` exist (mobile vs messenger-core); only the messenger-core copy has rotation + bundle binding.

**⚠️ Broken findings:**

- 🔴 **CRITICAL — identity regenerates after first SPK rotation.** `SIGNED_PRE_KEY_RETENTION_MS` == `SIGNED_PRE_KEY_ROTATION_INTERVAL_MS` (both 30d), so when rotation first fires, the retention sweep deletes signed-prekey id 1 _in the same pass_. Next boot: `installIdentity` finds the identity present but `loadSignedPreKey(1) === null`, logs "signed prekey missing — re-running install," and regenerates a brand-new registration ID + identity key via `INSERT OR REPLACE`. This silently rotates the user's long-term identity and breaks every existing session. `identity.ts:43-45,174-183,294-296`. **Verified, not refuted.** _Suggested fix: use a dedicated completion flag (or `getIdentityKeyPair()` alone) as the sentinel, and make retention strictly greater than the rotation interval._
- 🟠 **HIGH — P0-I2 bundle binding dormant** (see §17 for the confirmed write-up). `productionRuntime.ts:385-389`; `keysClient.ts:213-214`.
- 🟡 MED — retention window == rotation interval defeats the SPK cross-over grace period (in-flight PreKey messages built against the old key may fail to decrypt). `identity.ts:174,183,294`.
- 🔵 LOW — `publishOwnBundle` hardcodes the OPK scan to ids 1..50, brittle coupling to `preKeyCount`. `productionRuntime.ts:3582-3585`.

---

### 2. X3DH Handshake — ✅ 90%

| Your checklist item                | Status | Actual name                                                                       | Evidence                                           |
| ---------------------------------- | :----: | --------------------------------------------------------------------------------- | -------------------------------------------------- |
| `createSession(alice, bobPreKeys)` |   ✅   | `SessionManager.initOutgoingSession()` → libsignal `SessionBuilder.processPreKey` | `sessionManager.ts:99-132`                         |
| `deriveSharedSecret()`             |   🟡   | none — the 4-DH derivation is inside libsignal `processPreKey`                    | `sessionManager.ts:121`                            |
| `initializeRatchet()`              |   🟡   | none — ratchet seeding is inside libsignal                                        | `sessionManager.ts:121,140-154`                    |
| fetch recipient prekeys            |   ✅   | `fetchPeerBundle(WithPoolSize)()` → `GET /auth/keys/:userId` (pops 1 OPK)         | `keysClient.ts:116-190`; `keys.service.ts:165-228` |
| 4 DH operations                    |   🟡   | delegated to libsignal (correct)                                                  | `sessionManager.ts:100-121`                        |
| derive root secret                 |   🟡   | delegated to libsignal                                                            | `sessionManager.ts:121`                            |
| session initialization             |   ✅   | `initOutgoingSession()` persists; first encrypt emits `PreKeyWhisper`             | `sessionManager.ts:84-154`                         |

**How it actually works:** When the app needs to send to a peer with no session, it fetches the peer bundle, runs `verifyOrThrow` (the authority-binding check — see the dormancy bug), then hands the verified bundle to `SessionBuilder.processPreKey`, which performs the 4 DHs and seeds the Double Ratchet. The first message is a libsignal `PreKeyWhisper` (type 3) carrying the X3DH header; subsequent are `Whisper` (type 1). On receive, `resolveExpectedSenderIdentity` resolves the trusted identity (local trust row → authority-verified bundle fetch → undefined) before verifying the sender cert.

**Gaps:** The canonical names (`deriveSharedSecret`, `initializeRatchet`, explicit 4 DHs) have no standalone functions — correctly delegated to libsignal, so only exercised end-to-end (`handshake.test.ts`), not unit-tested in isolation.

**⚠️ Broken findings:** 🟡 MED — bundle-binding silently disabled when `authorityPubKeyB64` unset (`keysClient.ts:213-220`, the production manifestation is the §1/§17 HIGH). 🔵 LOW — server signed-prekey signature check warns-and-accepts on a Node `createPublicKey` import failure (`keys.service.ts:51-68`). 🔵 LOW — cold-contact identity resolution fails open (returns `undefined`, cert continuity skipped) on dual-lookup failure (`expectedSenderIdentity.ts:63-69`).

---

### 3. Double Ratchet — ✅ 85%

| Your checklist item                      | Status | Actual name                                                        | Evidence                                   |
| ---------------------------------------- | :----: | ------------------------------------------------------------------ | ------------------------------------------ |
| `encryptMessage` / `advanceSendChain`    |   ✅   | `SessionManager.encrypt` → libsignal `SessionCipher.encrypt`       | `sessionManager.ts:140-154`                |
| `decryptMessage` / `advanceReceiveChain` |   ✅   | `SessionManager.decrypt` → `decryptPreKeyWhisper`/`decryptWhisper` | `sessionManager.ts:161-177`                |
| store root key                           |   🟡   | inside libsignal's opaque session record (`sessions.record` TEXT)  | `sqlCipherStore.ts:447-452`; `db.ts:70-74` |
| store send chain key                     |   🟡   | same opaque record, written every encrypt                          | `sqlCipherStore.ts:440-452`                |
| store receive chain key                  |   🟡   | same opaque record, written inside the receive txn                 | `receiveTransaction.ts:78-105`             |
| store message counters                   |   🟡   | inside the record (proven by the 10-msg alternating test)          | `ratchet.test.ts:33-46`                    |
| store skipped message keys               |   🟡   | cached inside the record (proven by out-of-order 1,3,2 test)       | `ratchet.test.ts:48-65`                    |

**How it actually works:** The ratchet algebra is libsignal's; `SessionManager` is a thin per-peer façade. All four operations run under a per-address Promise-chain mutex (`withLock` keyed by `${userId}.${deviceId}`) so two concurrent encrypts can't read the same chain key. The receive path wraps decrypt + cert/AAD verify + plaintext upsert in one `BEGIN IMMEDIATE`/`COMMIT` (`runWithRatchetTxn`) so a crash can't burn a message key without persisting the plaintext. Ratchet state survives reinstall only via the AES-256-GCM `ratchetSnapshot` backup (server sees ciphertext only; monotonic-seq rollback defense; no-clobber guard).

**Gaps:** Ratchet sub-components aren't individually inspectable (libsignal owns serialization — correct). The ratchet-snapshot backup is currently wired to an in-memory transport; the backend `/backup/.../sessions` endpoints are an open task, so on a truly wiped device recovery falls back to a "couldn't decrypt" counter.

**⚠️ Broken findings:** 🟡 MED — a same-peer send dispatched _during_ an open receive transaction can join that transaction on the shared SQLite connection and be rolled back, desyncing the send chain (`receiveTransaction.ts:83`). 🔵 LOW — `applyRatchetSnapshot` needlessly refuses restore on stores lacking `listSessions` (`sessionRatchetRecovery.ts:109`). 🔵 LOW — contradictory header comment claims snapshotting isn't shipped when it is (`sessionRatchetRecovery.ts:38`).

---

### 4. Message Encryption Layer — ✅ 95%

| Your checklist item                                 | Status | Actual name                                                                                                                 | Evidence                                                     |
| --------------------------------------------------- | :----: | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| serialize message                                   |   ✅   | `sealPayload`/`unsealPayload` (JSON `SealedPayload`)                                                                        | `sealedSender.ts:268-288,444-465`                            |
| encrypt                                             |   ✅   | inner Double Ratchet **then** outer Sealed Sender v3 (ECIES + AES-GCM)                                                      | `productionRuntime.ts:2088-2090`; `outerEcies.ts:175-250`    |
| MAC / AEAD verify                                   |   ✅   | inner HMAC (libsignal) + outer GCM tag + sender-cert + AAD binding                                                          | `productionRuntime.ts:4939,5022,5067`                        |
| delivery ACK                                        |   ✅   | recipient `relay.ack(envelopeId, ackToken)`; sender double-tick via `envelope.delivered`                                    | `envelope.service.ts:308-357`; `envelopeDelivered.ts:35`     |
| retry logic                                         |   ✅   | durable `SqlOutboxStore` (backoff 1s/4s/15s/60s/5m) + WS ack-watchdog → HTTP fallback                                       | `sqlOutboxStore.ts:59-189`; `productionRuntime.ts:2204-2216` |
| payload shape (sender/receiver/ciphertext/nonce/ts) |   ✅   | `RelayEnvelope` — **`sender` deliberately absent on the wire** (sealed sender); nonce = 12-byte GCM IV inside `outerSealed` | `relayClient.ts:19-39`; `outerEcies.ts:194-200`              |

**How it actually works:** Send stamps an AAD block `{to, ts, sender, conversationId}` _inside_ the ratchet, encrypts (ratchet → outer ECIES), writes the durable outbox row **before** shipping, then sends over WS with a 5s ack-watchdog that force-reconnects and fires the HTTP relay fallback. The relay mints an envelope id + retract token, dedups on `(recipient, clientMsgId)`, and fans out a `deliver` frame with a possession-proof ack token. Receive dedups (`seenEnvelopes`), unwraps the outer GCM, verifies the cert _before_ libsignal decrypt, and commits ratchet + dedup + plaintext atomically. The first message on a fresh session is left on the relay for a bounded number of redeliveries instead of being ack-dropped (B-30).

**⚠️ Broken findings:** 🔵 LOW — recipient/archive `expiresAtSec` is stored unclamped, so a buggy client can set a bogus disappearing-message deadline (Redis dwell TTL is still capped, so no storage exhaustion) (`envelope.service.ts:120-149`).

---

### 5. Sender Key System (Groups) — 🟡 70%

> **Design divergence (sanctioned):** Bravo uses a **group master-key broadcast** model, not Signal Sender Keys. See Part A Step 7.

| Your checklist item          | Status | Actual name                                                                                    | Evidence                     |
| ---------------------------- | :----: | ---------------------------------------------------------------------------------------------- | ---------------------------- |
| `createGroupSenderKey()`     |   🟡   | `genMasterKey()`/`makeNewGroup()` (one shared AES-256 key, not per-member chain+signing key)   | `groupClient.ts:700,544-575` |
| `distributeSenderKey()`      |   ✅   | `broadcastToGroup()` admin `create` — master key sealed once per member over pairwise sessions | `groupClient.ts:138-251`     |
| `encryptGroupMessage()`      |   ✅   | `groupEncrypt()` — AES-256-GCM, fresh 12-byte IV                                               | `groupCrypto.ts:152-162`     |
| `decryptGroupMessage()`      |   ✅   | `groupDecrypt()` + `parseGroupMessage()`                                                       | `groupCrypto.ts:164-174`     |
| creator generates key        |   ✅   | `makeNewGroup()` → `genMasterKey()` (`getRandomValues` 32B)                                    | `groupClient.ts:558-575`     |
| key encrypted to each member |   ✅   | per-recipient `sealPayload` + `session.encrypt`                                                | `groupClient.ts:211-231`     |
| shared key for messages      |   ✅   | one `masterKeyB64` for all members within an epoch                                             | `groupClient.ts:165-167`     |
| O(N) not O(N²)               |   ✅   | single fan-out loop, body GCM-encrypted once then re-sealed per recipient                      | `groupClient.ts:177-249`     |

**How it actually works:** `makeNewGroup` derives a deterministic `groupId = sha256(salt ‖ sortedMemberIds)` and mints one random 32-byte master key; the creator signs the canonical create bytes with their identity key. `broadcastToGroup` seals the create payload (carrying the master key) once per member over pairwise Signal sessions — `create`/`key-request` are the only kinds shipped unwrapped (the recipient has no group key yet). At rest the master key is wrapped under a _second_ per-user keychain key in the `group_master_keys` table. Plaintext group messages are rejected (downgrade-attack defense). Rekey on add/remove derives a new key deterministically (`sha256(prevKey ‖ ids ‖ epoch)`) so racing admins converge.

**Gaps & ⚠️ findings:**

- 🟡 MED — **sender equivocation possible**: no per-member group signing key, so two recipients can't prove they got the same bytes (`groupClient.ts:27-50`, self-documented deferred).
- 🟡 MED — **no within-epoch forward secrecy**: one static master key per epoch encrypts every body; a leaked epoch key exposes all of that epoch (`groupCrypto.ts:152-162`).
- 🔵 LOW — ~~stale orphan copy `src/modules/messenger/crypto/groupCrypto.ts` has an unbounded key cache and no dispose (dead code today, re-wiring landmine)~~ **RESOLVED 2026-08-14** (audit #7: the orphan is a tombstone re-export of messenger-core; `deadForkLock.test.ts` prevents code returning).
- 🔵 LOW — random 96-bit IV birthday bound (~2⁻³² near 2³² encryptions) on a long-lived key; accepted (P1-G7).

---

### 6. Group Management — ✅⚠️ 85%

| Your checklist item        | Status | Actual name                                                                   | Evidence                                          |
| -------------------------- | :----: | ----------------------------------------------------------------------------- | ------------------------------------------------- |
| `createGroup()`            |   ✅   | `createGroupChat` → `makeNewGroup` + `signGroupCreate` + broadcast            | `productionRuntime.ts:2548`                       |
| `addMember()`              |   ✅   | `addGroupMember` → `planAddAndRekey` + `reshareGroupKeyState` to new member   | `productionRuntime.ts:3050`; `groupClient.ts:921` |
| `removeMember()`           |   ✅   | `removeGroupMember` → `planRemoveAndRekey` (remove+rekey two-step)            | `productionRuntime.ts:2799`                       |
| `leaveGroup()`             |   🟡   | `leaveGroup` broadcasts **leave-only** (rekey deliberately omitted)           | `productionRuntime.ts:2958,2977-2985`             |
| `rotateGroupKeys()`        |   🟡   | no standalone method — `rekey` action only chained inside add/remove/leave    | `groupClient.ts:803,713`                          |
| admins list                |   🟡   | per-member `admin` flag (owner only; **no promote/demote action**)            | `groupClient.ts:466-468,478`                      |
| rotate sender key on leave |   🟡   | planner produces a rekey but `leaveGroup` never broadcasts it                 | `productionRuntime.ts:2977-2986`                  |
| forward-secure removal     |   ✅   | `removeGroupMember` chains remove→rekey to post-remove set + disposes old key | `productionRuntime.ts:2884-2948`                  |

**How it actually works:** Create/add/remove all go through a pure reducer (`applyAdminAction`) gated on admin + monotonic epoch. Add is a two-step `add` then `rekey`; because the new member never held the old key, the runtime re-shares the post-rekey state to them as an unwrapped signed `create` (RC1). Remove fans `remove` to all (so the removed member learns it), then `rekey` to the post-remove set only, and disposes the old key — forward-secure. Department channels reuse all of this via `ensureChannelProvisioned` + `drainMembershipIntents`.

**⚠️ Broken findings:**

- 🟠 **HIGH — `leaveGroup` provides no forward secrecy** (verified, not refuted). It broadcasts only `leave`; the reducer advances the epoch but copies `masterKeyB64` forward unchanged, so the departed member keeps a working key. The in-code comment admits it "needs a REMAINING admin to rekey after the leave (a separate follow-up)" — which doesn't exist. **`removeGroupMember` is fine; only voluntary leave is affected.** `productionRuntime.ts:2977-3028`.
- 🟡 MED — **owner-leaves bricks the group**: only the owner is admin and there's no promote/demote, so if the owner leaves, no one can add/remove/rekey ever again (`productionRuntime.ts:2958`).
- 🔵 LOW — stale `planAddAndRekey` docstring falsely claims the new member can unwrap the rekey (`groupClient.ts:858-868`).
- 🔵 LOW — 0-peer rekey fan-out still rotates the local key (fail-closed), which can silently desync members who missed the rekey (`productionRuntime.ts:2916-2936`).

---

### 7. Attachments / Media — ✅ 85%

| Your checklist item            | Status | Actual name                                                             | Evidence                      |
| ------------------------------ | :----: | ----------------------------------------------------------------------- | ----------------------------- |
| `encryptFile()`                |   ✅   | `encryptAttachment()` (AES-256-CBC + encrypt-then-HMAC)                 | `media/aesCbc.ts:132-156`     |
| `uploadEncryptedMedia()`       |   ✅   | `MediaClient.uploadEncrypted()` (presigned PUT to R2)                   | `media/mediaClient.ts:56-124` |
| `downloadAndDecrypt()`         |   ✅   | `MediaClient.downloadEncrypted()` / `runtime.downloadMedia()`           | `mediaClient.ts:143-201`      |
| random media key               |   ✅   | `randomBytes(32)` key + `randomBytes(16)` IV per file                   | `aesCbc.ts:133-134`           |
| encrypt-before-upload          |   ✅   | encrypt → presign → PUT ciphertext; server never sees plaintext         | `mediaClient.ts:57-69`        |
| key shared via Signal envelope |   ✅   | `SealedAttachment {objectKey,keyB64,ivB64,mime,size}` in sealed payload | `sealedSender.ts:69-87,259`   |
| metadata: mime                 |   ✅   | `SealedAttachment.mimeType`                                             | `sealedSender.ts:77`          |
| metadata: size                 |   ✅   | `SealedAttachment.size`                                                 | `mediaClient.ts:113-114`      |
| metadata: hash                 |   🟡   | no content digest field; integrity via inline HMAC-SHA256 tag instead   | `aesCbc.ts:137-149`           |
| metadata: thumbnail            |   ❌   | none — image bubbles eagerly download the full file                     | not found                     |

**How it actually works:** A fresh 32-byte key + 16-byte IV per file; AES-256-CBC then encrypt-then-MAC (HKDF-derived HMAC key, tag over `0x02 ‖ ciphertext`). The blob is PUT to R2 via a 5-minute presigned URL; the key/IV/objectKey ride _in-band_ inside the sealed-sender envelope; `registerGrants` tells the server who may download. Receive fetches the ciphertext, verifies the HMAC (constant-time) before AES, and writes the plaintext to an app-private cache file. Retract/expiry purges the R2 object (owner-checked).

**Gaps:** no thumbnail; no content/ciphertext digest in the pointer (Signal carries one). MIME + size present.

**⚠️ Broken findings:**

- 🟡 MED — **integrity downgrade**: `decryptAttachment` picks the verification path from the _first byte of the untrusted blob_; an attacker who can modify the stored ciphertext can set version v1 to skip the HMAC and bit-flip CBC. Blind corruption/DoS (key stays secret), but it bypasses the encrypt-then-MAC guarantee. The version should come from the trusted envelope, not the blob (`aesCbc.ts:174-200`).
- 🟡 MED — the audit-fix upload size check is a no-op (GET-signed URL used with HTTP HEAD → 403 → treated as "can't verify, accept") (`mediaClient.ts:131-141`).
- 🔵 LOW — HMAC doesn't cover the IV (`aesCbc.ts:141-149`). 🔵 LOW — download grant gate defaults to lax/open (`media.service.ts:147-165`).

---

### 8. Voice Call Signaling — ✅ 90%

| Your checklist item             | Status | Actual name                                                                                                                                      | Evidence                                               |
| ------------------------------- | :----: | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `sendCallOffer()`               |   ✅   | `CallSignalling.sendOffer()` / `CallController.startOutgoing()`                                                                                  | `signallingClient.ts:197`; `callController.ts:391`     |
| `sendAnswer()`                  |   ✅   | `sendAnswer()` / `CallController.accept()`                                                                                                       | `signallingClient.ts:205-216`; `callController.ts:470` |
| `exchangeIceCandidates()`       |   ✅   | `sendIce()` + `onIce` + trickle + dispatcher queue                                                                                               | `signallingClient.ts:232-255`                          |
| offer/answer/reject/hangup msgs |   🟡   | `call.offer`/`call.answer`/`call.hangup` (+reoffer/reanswer/media-state); **no distinct `reject`** — it's a hangup with reason `declined`/`busy` | `callController.ts:448,516-521`                        |
| ICE candidate exchange          |   ✅   | trickle ICE with pre-remote-description queueing                                                                                                 | `callController.ts:1179-1191`                          |
| over WebSocket                  |   ✅   | socket.io; gateway `call.*` relay                                                                                                                | `messenger.gateway.ts:905`                             |
| signaling authenticated         |   ✅   | JWT socket + server-stamped `from` + per-call participant gate; **+ XEd25519 sender-cert binding on `call.offer`**                               | `gateway.ts:1884`; `callOfferAuth.ts:191-284`          |

**How it actually works:** `startOutgoing` builds the PC, creates the offer, asks for a signed auth block, and sends `call.offer`. The gateway fail-closes if auth is missing, pins caller/callee, and stamps the authenticated `from` from JWT. Incoming offers run `verifyCallOfferAuth` (cert + sig + AAD + freshness) before the call screen mounts. ICE trickles both ways with a 64-candidate pending buffer; every inbound answer/ice is dropped unless `from` matches the expected peer. DTLS-SRTP is verified via `getStats` before the call is marked connected.

**⚠️ Broken findings:**

- 🟡 MED — **`call.answer`/`call.media-state` identity binding is dead end-to-end**: the answerer never signs, the gateway strips `data.auth` when forwarding, and no receiver verifies. So answer authenticity rests solely on the relay-stamped `from` (the exact thing the crypto layer was meant to back up). `call.offer` is fully wired. `messenger.gateway.ts:1037`.
- 🔵 LOW — a `buildOfferAuth` failure ships an unsigned offer that the gateway now hard-rejects, so the call dies silently at ring timeout instead of "Could not connect" (`callController.ts:420`).

---

### 9. Call Key Agreement (media keys) — ✅ 85%

| Your checklist item                  | Status | Actual name                                                                                            | Evidence                          |
| ------------------------------------ | :----: | ------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `callMasterKey` / `deriveCallKeys()` |   🟡   | **1:1: none by design** (DTLS-SRTP auto-derives). Group: `deriveParticipantKey()` HKDF over master key | `frameCryptorKeys.ts:75`          |
| SRTP key + auth + salt               |   🟡   | 1:1 derived inside libwebrtc (app only validates the cipher); group uses AES-256-GCM FrameCryptor keys | `peerConnection.ts:452-531`       |
| DTLS-SRTP                            |   ✅   | `verifyDtlsSrtp()` (asserts dtlsState + negotiated cipher, polled 24×250ms)                            | `peerConnection.ts:452-483`       |
| SDP fingerprint pinning              |   ✅   | `extractDtlsFingerprints` + `pinRemoteFingerprints` + `assertRemoteFingerprintPinned`                  | `sdpFingerprint.ts:50-115`        |
| cipher allowlist                     |   ✅   | `SRTP_CIPHER_ALLOWLIST` (GCM preferred, fail-closed on unknown)                                        | `peerConnection.ts:47-59,485-515` |
| ZRTP (optional)                      |   ❌   | not present — fingerprint pinning substitutes for the SAS                                              | not found                         |

**How it actually works:** For 1:1, key derivation is delegated to DTLS-SRTP; the app's job is to _authenticate the handshake_. The first remote SDP's DTLS fingerprints become an immutable baseline; any later SDP must be a subset (cert continuity — defeats a mid-call MITM cert-swap). After ICE connects, the app polls `getStats`, requires `dtlsState` connected, enforces the cipher allowlist (fail-closed on missing/unknown), and matches the active transport's remote cert against the pinned set; any failure tears the call down. TURN creds are short-lived HMAC with an opaque per-credential id (no who-called-whom oracle). Group calls instead derive a per-(participant,epoch) AES-256 key via HKDF of the group master key.

**⚠️ Broken findings (all LOW):** ICE-restart "recovered" path skips a fresh stats-level cert re-verify (SDP-time continuity still applies) (`callController.ts:1204-1211`); a non-transient pin mismatch is retried for ~6s before failing closed (`callController.ts:846-906`); `AES_CM_128_HMAC_SHA1_32` (32-bit auth tag) is accepted unconditionally on the allowlist (`peerConnection.ts:57-58`).

---

### 10. Audio/Video Media Pipeline — ✅ 78%

| Your checklist item | Status | Actual name                                                           | Evidence                                          |
| ------------------- | :----: | --------------------------------------------------------------------- | ------------------------------------------------- |
| `captureAudio()`    |   ✅   | `getLocalMedia()` → `getUserMedia({audio:true})`                      | `peerConnectionFactory.ts:28-92`                  |
| `encodeAudio()`     |   🟡   | no app fn — native Opus; app sets codec params                        | `useCall.ts:695-708`                              |
| `encryptRtp()`      |   ✅   | 1:1 native DTLS-SRTP; group SFrame/FrameCryptor                       | `peerConnection.ts:452-531`                       |
| microphone capture  |   ✅   | `audio:true` + Android `RECORD_AUDIO` runtime permission              | `peerConnectionFactory.ts:42,78`                  |
| echo cancellation   |   🟡   | no explicit AEC — bare `audio:true` lets native APM apply defaults    | `peerConnectionFactory.ts:65-78`                  |
| jitter buffer       |   🟡   | native NetEq; app only samples jitter for the HUD                     | `useCall.ts:903`                                  |
| opus codec          |   ✅   | configured (`opusFec/Dtx/MaxAvgBitrate:32k/Ptime:10`); codec native   | `useGroupCall.ts:1690-1696`                       |
| camera capture      |   ✅   | `getLocalMedia` video constraints + flip/recover                      | `peerConnectionFactory.ts:79-185`                 |
| H264/VP8/AV1        |   🟡   | no `setCodecPreferences` — native SDP negotiation; AV1 not referenced | `useCall.ts:613,656`                              |
| bitrate adaptation  |   ✅   | 1:1 `maxBitrate 600k`+`maintain-framerate`; group 3-layer simulcast   | `useCall.ts:664-684`; `useGroupCall.ts:1743-1756` |

**How it actually works:** This is correctly a thin configuration + encryption-wiring shell over libwebrtc — a Signal-grade client does **not** reimplement Opus/NetEq/AEC. Outgoing calls acquire media up front; incoming calls defer acquisition to `accept()` so a ringing/declined call never lights the mic/camera. Senders are configured with bitrate caps and `degradationPreference`. Group video produces a 3-layer simulcast ladder. SFrame transforms attach to every producer/receiver; an attach failure tears the call down (no plaintext-to-SFU fallback).

**⚠️ Broken findings (all LOW):** AEC not enforced (relies on native default APM; no app-side assertion) (`peerConnectionFactory.ts:65-78`); in-call stats sample only audio jitter, never video (`useCall.ts:896-906`); `toggleVideo ON` depends on a stopped track still reporting `kind:'video'` on its sender — a webrtc build that nulls it would silently fail to re-enable the camera (`peerConnectionFactory.ts:165-167`).

---

### 11. Group Call Encryption — ✅⚠️ 80%

| Your checklist item        | Status | Actual name                                                                                         | Evidence                                                      |
| -------------------------- | :----: | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `createGroupCallKey()`     |   ✅   | `deriveParticipantKey()` (native path) / `deriveSframeBaseKey()` (legacy)                           | `frameCryptorKeys.ts:75`; `sframe.ts:180`                     |
| `encryptAudioFrame()`      |   🟡   | **native** libwebrtc FrameCryptor (no JS fn in prod); legacy JS `SframeSender.encryptFrame` is dead | `BravoFrameCryptorModule.kt:156`; `sframe.ts:352`             |
| `decryptAudioFrame()`      |   🟡   | native (`createFrameCryptorForRtpReceiver`); legacy JS dead                                         | `BravoFrameCryptorModule.kt:204`                              |
| SFU client-side E2EE       |   ✅   | FrameCryptor over mediasoup; fail-closed if native module missing                                   | `frameCryptorTransport.ts:13-37`; `useGroupCall.ts:1152-1159` |
| per-frame AES-GCM          |   ✅   | native `FrameCryptorAlgorithm.AES_GCM`                                                              | `BravoFrameCryptorModule.kt:160`                              |
| key rotation on join/leave |   🟡   | `rotate()` re-derives keys **but never switches the sender's key index**                            | `frameCryptorOrchestrator.ts:119-145`                         |

**How it actually works:** On group-call boot, the app hard-gates encryption (no FrameCryptor or no group key → fail closed and leave). Per-participant keys are `HKDF-SHA256(ikm=masterKey, salt='bravo-fc-v1', info='epoch=…|p=tag')`, derived identically on every device so a late joiner derives everyone's key locally with no key exchange. Native libwebrtc FrameCryptor encrypts each RTP frame with AES-256-GCM _before_ SRTP, so the SFU forwards ciphertext-inside-ciphertext. There is also a full RFC-9605-style JS SFrame implementation (`sframe.ts`) but it is **dead code** (rn-webrtc 124.x lacks `createEncodedStreams` on Android).

**⚠️ Broken findings:**

- 🟠 **HIGH — rekey doesn't switch the sender's FrameCryptor key index** (verified, not refuted). `rotate()` pushes new keys at a new ring index but never calls `setCryptorKeyIndex` (zero call sites repo-wide); the sender cryptor's `key_index_` stays 0, old keys remain resident in the 16-slot ring. So after a leave-rekey the sender keeps encrypting under the old key and a removed member can still decrypt — defeating `ARCHITECTURE_AMENDMENT_SFRAME.md`'s stated property. Also: a call starting at epoch>0 pushes the self key at a non-zero index while encrypting at 0 → encryption fails (the B-42 "joiner never produces" symptom). `rotate()` failures are swallowed (fails open). Mitigated by the host kicking removed members off the SFU, but that's host-only/race-prone. `frameCryptorOrchestrator.ts:135-145`.
- 🔵 LOW — two divergent SFrame implementations in-tree; the legacy JS cipher is dead but still tested (looks live) (`sframe.ts:1-61`). 🔵 LOW — `epoch→keyIndex = epoch & 0x0F` wraps every 16 rotations with no collision handling (`frameCryptorKeys.ts:59-65`).

---

### 12. Group Call Signaling — 🟡 75%

| Your checklist item  | Status | Actual name                                                             | Evidence                                          |
| -------------------- | :----: | ----------------------------------------------------------------------- | ------------------------------------------------- |
| `joinRoom()`         |   ✅   | WS `sfu.join` → `SfuService.joinRoom`; reconnect re-join                | `useGroupCall.ts:1115`; `sfu.service.ts:205`      |
| `leaveRoom()`        |   ✅   | `leaveInternal()` → WS `sfu.leave`                                      | `useGroupCall.ts:3202`; `sfu.service.ts:530`      |
| `muteParticipant()`  |   ✅   | WS `sfu.mute-target` → host-enforced server-side producer pause         | `sfu.service.ts:293,329`                          |
| participant tracking |   ✅   | `identityByTag` + observed-tag registry (`sfu.participant.joined/left`) | `useGroupCall.ts:293,529`                         |
| mute state           |   ✅   | `isMuted` + incoming `sfu.muted` + server pause                         | `useGroupCall.ts:2884,1027`                       |
| active speaker       |   ✅   | 500ms `getStats` audioLevel poll → hero tile with 3s hold               | `useGroupCall.ts:2519`; `GroupCallScreen.tsx:509` |
| screen share         |   ❌   | none (no `getDisplayMedia`/screenshare anywhere)                        | not found                                         |
| raised hand          |   ❌   | none                                                                    | not found                                         |

**How it actually works:** Host opens a mediasoup Router (`POST /sfu/rooms`), client `sfu.join`s with an HMAC room token, loads a mediasoup Device, creates send/recv transports, produces audio/video (with SFrame transforms), and consumes existing producers. The SFU only ever sees an opaque random `participantTag`; the tag→displayName mapping travels over pairwise Signal sessions (the SFU never learns identity). Host moderation (`muteParticipant`/kick) is enforced server-side against `room.hostUserId`. Active speaker is a client-side loudest-audioLevel heuristic. A 4s reconcile tick self-heals missed tiles.

**Gaps & ⚠️ findings:** **No screen share, no raised hand.** Active speaker is client-derived (no server frame; own voice never measured). Host-unmute is server-capable but unreachable from the client UI.

- 🟡 MED — **no conversation-membership check on room join**: any authed user who knows a `conversationId` can mint a token and join the media room (they can't decrypt without the group key, but they occupy a slot and learn participant count/timing) (`sfu.controller.ts:70`).
- 🔵 LOW — host-unmute unwired client-side (`sfuDispatcher.ts:103`); 🔵 LOW — `sfu.mute-target`/`sfu.kick` resolve the actor tag without a `roomId` hint (edge case with two concurrent sessions) (`messenger.gateway.ts:1615`).

---

### 13. SFU / Media Server — ✅ 85%

| Your checklist item | Status | Actual name                                                                       | Evidence                                   |
| ------------------- | :----: | --------------------------------------------------------------------------------- | ------------------------------------------ |
| SFU implementation  |   ✅   | **mediasoup** — `SfuWorkerPool` + `SfuService` (1 Worker/core)                    | `sfuWorkerPool.ts:96`; `sfu.service.ts:42` |
| RTP forwarding      |   ✅   | Router/Producer/Consumer (`produce`/`consume`/`canConsume`)                       | `sfu.service.ts:401,455,438`               |
| bandwidth control   |   🟡   | `initialAvailableOutgoingBitrate` + per-layer maxBitrate (no server incoming cap) | `sfu.service.ts:734,741`                   |
| simulcast           |   ✅   | 3-layer encodings (150k/500k/1.2M)                                                | `useGroupCall.ts:1743-1747`                |
| congestion control  |   🟡   | mediasoup built-in transport-cc/REMB + simulcast layer drop (no explicit tuning)  | `sfu.service.ts:741`                       |
| room token auth     |   ✅   | `RoomTokenService` HMAC-SHA256, `timingSafeEqual`                                 | `room-token.service.ts:57-92`              |

**How it actually works:** mediasoup workers spawn one per core with backoff-limited restart. Rooms are idempotent per conversation; join enforces a 6-participant cap, assigns an ephemeral `randomUUID` tag, and creates send+recv transports. Media is SRTP client↔SFU; the SFU forwards encrypted RTP only, and group payloads are additionally SFrame-encrypted (so mediasoup never sees plaintext). A zombie-room sweeper GCs empty rooms after 60s.

**⚠️ Broken findings:**

- 🟡 MED — room-token gate has no conversation-membership check (`sfu.controller.ts:73`).
- 🟡 MED — **host server-side mute is bypassable**: `authoriseMute` pauses the _current_ producer; a patched client can close it and create a fresh (unpaused) producer to resume (`sfu.service.ts:396`).
- 🔵 LOW — token auth silently disabled when `SFU_ROOM_TOKEN_SECRET` is unset (the default) (`messenger.gateway.ts:1220`). 🔵 LOW — `createRoom` reuse returns inaccurate `createdAt`/`participants` (`sfu.service.ts:151`).

---

### 14. Push Notifications / Offline Delivery — ✅⚠️ 85%

| Your checklist item       | Status | Actual name                                                                                       | Evidence                                 |
| ------------------------- | :----: | ------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `queueOfflineMessage()`   |   ✅   | `EnvelopeStore.put()` — Redis pending ZSET + `env:{id}` with dwell TTL                            | `envelope.store.ts:123-160`              |
| `sendPushNotification()`  |   ✅   | `PushService.sendChatWake()`/`sendVoipWake()` (firebase-admin)                                    | `push.service.ts:426,581`                |
| offline message store     |   ✅   | Redis env STRING + pending ZSET, 30-day dwell, 10k/device cap                                     | `envelope.store.ts:70-108`               |
| incoming call push (VoIP) |   ✅   | `sendVoipWake` (HMAC-signed) → notifee + Telecom/CallKit                                          | `push.service.ts:581-739`                |
| wake device               |   🟡   | Android FCM high-priority + Doze bypass; **killed-app headless path UNWIRED**                     | `index.js:31-54`                         |
| FCM                       |   ✅   | firebase-admin server; `@react-native-firebase/messaging` client                                  | `push.service.ts:885-920`                |
| APNS                      |   🟡   | server `ApnsClient` (ES256 .p8 JWT, voip push) built; **client iOS PushKit is an inert skeleton** | `apnsClient.ts:78-148`; `voipPush.ts:42` |
| opaque payloads           |   ✅   | voip-wake = `{callId,nonce,exp,sig}` only; push:events forwards only `{eventId,eventClass}`       | `push.service.ts:686-694`                |

**How it actually works:** After auth, the client registers the FCM token to `/push/register` + `/push/register-voip` (the latter returns a per-device HMAC wake key stored in the keychain). Offline envelopes are stored in Redis with a 30-day dwell. A chat wake is a **data-only** FCM message (no body); a call wake is an **HMAC-signed** VoIP push verified client-side (sig + freshness + nonce-LRU replay window) before it rings. Cross-service events are forwarded as an opaque `{eventId,eventClass}` and hydrated over a JWT-gated route.

**⚠️ Broken findings:**

- 🟡 MED (downgraded from HIGH by the verifier) — **killed-app incoming calls don't ring**: `handleHeadlessFcm` is dead code; the headless task was removed because a 2nd JS VM fought the SQLCipher lock. Only foreground/recently-backgrounded wakes work. Intentional documented deferral; message banners still render natively. `fcmHeadless.ts:32`; `index.js:31-54`.
- 🟡 MED — stale comment claims `sendChatWake` sends a notification block; it sends data-only (`index.js:41-46` vs `push.service.ts:458-483`).
- 🔵 LOW — VoIP wake budget `INCR`-then-`EXPIRE` is non-atomic; a crash between can strand the counter with no TTL (`push.service.ts:549-554`). 🔵 LOW — chat-wake carries `conversationId`/`senderUserId` in cleartext FCM data (below the project's own opacity bar) (`push.service.ts:471-475`).

---

### 15. Persistence Layer — ✅ 90%

| Your checklist item                   | Status | Actual name                                                                                                                | Evidence                                   |
| ------------------------------------- | :----: | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| encrypted local store (SQLCipher)     |   ✅   | `openCryptoDb` + cipher PRAGMAs; key from `getOrCreateDbKey` (hardware keychain, per-user)                                 | `db.ts:335-415`; `keychain.ts:169-182`     |
| Users (id/identity_key/prekeys)       |   ✅   | local `identity`/`pre_keys`/`signed_pre_keys`/`trusted_identities`; Postgres `signal_identities`/`signal_one_time_prekeys` | `db.ts:51-89`; `keys.service.ts:91-134`    |
| Sessions (peer_id/root_key/chain_key) |   ✅   | `sessions` (opaque libsignal record TEXT; keys inside the blob)                                                            | `db.ts:70-74`; `sqlCipherStore.ts:440-480` |
| Messages (ciphertext/status/ts)       |   ✅   | `messages` (holds **plaintext** body, protected by SQLCipher page encryption)                                              | `db.ts:101-148`                            |
| Calls (call_id/participants/state)    |   🟡   | **no dedicated table** — calls persist as `messages` rows (`type='call'`); live state ephemeral                            | `db.ts:140-146`                            |
| Postgres (auth)                       |   ✅   | auth-service over Postgres (users + signal keys + auth_devices)                                                            | `keys.service.ts:83-160`                   |
| Redis (relay/WS)                      |   ✅   | `EnvelopeStore` (env STRING TTL=dwell, pending ZSET, dedup/ack/retract keys)                                               | `envelope.store.ts:70-211`                 |
| session/message/outbox persistence    |   ✅   | `SqlCipherProtocolStore` / `SqlMessageStore` / `SqlOutboxStore`                                                            | `sqlOutboxStore.ts:62-211`                 |

**How it actually works:** All mobile durable state is one SQLCipher file (or a 3-compartment id/rt/msg split) whose key is hardware-backed and **pinned to the immutable user.id** (this fixed the prior OWNERKEY-DRIFT data-loss bug). Cipher hardening PRAGMAs (`cipher_memory_security`, `cipher_use_hmac`) are asserted on open before the forward-only migrations (schema v12). Session/ratchet keys live in separate tables from the message body. Outgoing sends are made durable _before_ hitting the WS. The relay is a blind transient Redis store with a per-device 10k cap and atomic Lua put-with-cap.

**⚠️ Broken findings:**

- 🟡 MED — `upsertBatch` issues an **unguarded `BEGIN`** on the SQLite handle shared with the ratchet transaction; if the coalesced flush overlaps an open receive txn, the batch is silently dropped from disk (in-memory copy survives) (`sqlMessageStore.ts:271`).
- 🔵 LOW — `openCryptoDb` accepts a non-hex SQLCipher key (PRAGMA-quoting surface) while the compartmented path validates strictly; not exploitable today since the key is always 64-hex (`db.ts:339`). 🔵 LOW — outbox `recordAttempt` does a non-atomic SELECT-then-UPDATE of attempts (backoff skew only) (`sqlOutboxStore.ts:153`).

---

### 16. Security Hardening — ✅ 92%

| Your checklist item                    | Status | Actual name                                                                                                                | Evidence                                               |
| -------------------------------------- | :----: | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| replay: counters / seen-envelope dedup |   ✅   | `SeenEnvelopeStore` (persistent wasSeen/markSeen) + in-flight set                                                          | `seenEnvelopeStore.ts:41-61`                           |
| MITM: safety numbers / fingerprints    |   ✅   | `computeSafetyNumber` (60-digit) + verify state + strict-trust flag                                                        | `safetyNumber.ts:82-107`; `ChatInfoScreen.tsx:180-202` |
| device compromise: enclave/keystore    |   ✅   | `keychain.ts` (`SECURE_HARDWARE`/StrongBox + `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`), per-compartment keys, `wipeUserAtRest` | `keychain.ts:82-85,226-239`                            |
| sealed-sender cert revocation          |   ✅   | `RevokedJtiCache` (5-min poll, fail-open, isFresh gate) → `verifySenderCert`                                               | `revokedJtiCache.ts:51-115`; `senderCert.ts:116-118`   |

**How it actually works:** Replay is defended by an SQLCipher-persisted `seen_envelopes` table (survives the cold-start relay catch-up flood) + an in-flight Set to close the TOCTOU window, with dedup committed inside the same receive transaction as the ratchet advance. Safety numbers hash the _actual_ local+remote identity keys (order-independent), shown for out-of-band verification; verification auto-clears when a peer's key flips. At-rest keys live in the hardware secure enclave, split into id/rt/msg compartments + a separate group-wrap key (single-entry exploit yields at most one compartment). Sender-cert revocation polls a list and rejects revoked JTIs.

**⚠️ Broken findings:**

- 🟡 MED — **strict identity-trust is OFF by default**, so a MITM key-flip is _accepted_ on receive (only the safety-number verification record auto-clears; detection relies on the user manually comparing numbers). Flag-gated, intentional for reinstall recovery, but it's the dominant MITM gap. `sqlCipherStore.ts:282`.
- 🔵 LOW — revocation fail-opens when the poll is stale (>30 min outage), widening the leaked-cert window during an auth-service outage (`productionRuntime.ts:4206`).

---

### 17. Multi-Device Support — 🟡 40%

| Your checklist item                                    | Status | Actual name                                                                                                    | Evidence                                               |
| ------------------------------------------------------ | :----: | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| per-device sessions `deviceSessions[userId][deviceId]` |   🟡   | `SessionAddress {userId,deviceId}` keyed by `${userId}.${deviceId}` (no literal nested map)                    | `types.ts:14-17`; `sessionManager.ts:57-67`            |
| each device own identity                               |   🟡   | **server**: per-(user,device) rows + `resolveSignalDeviceId` (B-18). **client**: single identity at deviceId 1 | `keys.service.ts:73,90-99`; `productionRuntime.ts:339` |
| multi-device prekey fetch                              |   🟡   | server `GET /auth/keys/:userId/devices` exists; **client has no `fetchDevices` caller**                        | `keys.controller.ts:35-42`; `keysClient.ts:142,170`    |
| multi-device group key distribution                    |   ❌   | group fan-out targets each member at deviceId 1 only                                                           | `productionRuntime.ts:1575,2561,2706,3346,5480`        |

**How it actually works:** Multi-device is **half-built**: the auth-service was upgraded (B-18 — per-device identity rows, `signal_device_id` resolution, `/devices` fan-out endpoint, per-device authority binding), but the **client was never switched over**. The live runtime builds a single `KeysHttpClient`, only calls `/auth/keys/:userId` (primary device), hardcodes `deviceId:1` everywhere, and never sets `config.signalDeviceId`. The session store _could_ hold multiple devices, but the live code only ever populates device 1.

**⚠️ Broken findings:**

- 🟠 **HIGH — live `KeysHttpClient` omits `authorityPubKeyB64`** (verified, not refuted) → the P0-I2 bundle-binding MITM defense is inert. (This is the same defect surfaced in §1; found again while tracing the bundle-fetch path.) A coerced keys-service can swap a peer's identity key during X3DH. `productionRuntime.ts:385`.
- 🟡 MED — **a 2nd device receives nothing**: if any user ever uploads a 2nd identity (server assigns `signal_device_id=2`), no sender targets it → silent message/group-key loss. Latent because `config.signalDeviceId` is never set >1, but the server path exists. `productionRuntime.ts:1575`.
- 🔵 LOW — `fetchDevices` multi-device path is untested (`keys.service.spec.ts:107`). 🔵 LOW — dead duplicate `src/modules/messenger/transport/keysClient.ts` with a false comment and no bundle-binding check.

---

### 18. Backend APIs — ✅ 90%

| Your checklist item     | Status | Actual name                                                                                                                            | Evidence                                      |
| ----------------------- | :----: | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `POST /register`        |   ✅   | `POST /auth/register` + `/auth/register/verify`; Signal-key reg is `POST /auth/keys/upload` + `POST /sender-cert`                      | `auth.controller.ts:123,130`                  |
| `POST /prekeys`         |   ✅   | `POST /auth/keys/upload`, `GET /auth/keys/:userId`, `GET /auth/keys/:userId/devices`                                                   | `keys.controller.ts:20,35,44`                 |
| `POST /message` (relay) |   ✅   | `POST /envelopes` + WS `envelope.send` (+ pull/ack/retract/purge)                                                                      | `envelope.controller.ts:62`; `gateway.ts:808` |
| group create            |   🟡   | no crypto relay endpoint (group state is E2E over `/envelopes`); app containers via `POST /conversations`, `POST /department/channels` | `conversations.controller.ts:17`              |
| call invite             |   ✅   | WS `call.offer` (signed); group via WS `sfu.ring`. No REST endpoint                                                                    | `gateway.ts:905,1435`                         |
| groupcall join          |   ✅   | `POST /sfu/rooms` + `GET /sfu/rooms/by-conversation/:id` → token; WS `sfu.join`                                                        | `sfu.controller.ts:32,73`                     |
| WebSocket gateway       |   ✅   | `MessengerGateway` (JWT handshake, JTI re-check, all handlers)                                                                         | `messenger.gateway.ts:167,291,356`            |
| gRPC streams            |   ❌   | not implemented — socket.io WS + REST only                                                                                             | not found                                     |

**How it actually works:** Account registration is in auth-service; Signal-key publishing is decoupled (`/auth/keys/upload`, with an `X-Pre-Key-Count` header to trigger OPK refill). The relay accepts sealed-sender v2 envelopes over WS or REST and **deliberately drops submitter identity before storage** to preserve sealed sender. Call signalling is pure pass-through (the gateway never parses SDP/ICE). Group calls use the mediasoup room-token model. All HTTP surfaces share `JwtHttpGuard` + throttling; the WS gateway adds a token-bucket rate limiter + 60s JTI-revocation sweep.

**⚠️ Broken findings:**

- 🟡 MED — media `createDownloadUrl` **fails open in lax mode (default)**: any authed user who learns an `objectKey` can pull the ciphertext (`media.service.ts:147`).
- 🟡 MED — SFU room-token verification **fails open when the secret is unset** (prod misconfig silently disables admission control) (`messenger.gateway.ts:1220`).
- 🔵 LOW — SFU room discovery has no membership check (`sfu.controller.ts:73`); 🔵 LOW — `mission.subscribe` has no membership authorization (metadata leak) (`messenger.gateway.ts:768`).

---

### 19. Sealed Sender v2 (bonus — beyond your 18) — ✅ 92%

| Item                                | Status | Actual name                                                                                                   | Evidence                                           |
| ----------------------------------- | :----: | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| sender cert issuance + verification |   ✅   | `SenderCertService.issue()` + `verifySenderCert()` ('BSC' XEd25519, JWT-shaped)                               | `sender-cert.service.ts:77`; `senderCert.ts:100`   |
| sealed-sender envelope shape        |   ✅   | inner JSON `SealedPayload` + outer binary `wrapOuter`/`unwrapOuter` (v2/v3)                                   | `sealedSender.ts:268,444`; `outerEcies.ts:175,262` |
| AAD binding                         |   ✅   | inner `SealedAad {to,ts,sender,conversationId,groupId,epoch}`; outer GCM AAD `ephPub‖recipPub‖certBytes` (v3) | `sealedSender.ts:371`; `outerEcies.ts:214`         |
| outer ECIES                         |   ✅   | X25519 ephemeral DH + HKDF + AES-256-GCM                                                                      | `outerEcies.ts:181-189,386-407`                    |
| cert revocation / jti cache         |   🟡   | per-jti revocation works end-to-end; **revoke-all generation counter NOT enforced on receivers**              | `sender-cert.service.ts:166`; `senderCert.ts:150`  |

**How it actually works:** Each message fetches a cached sender cert, seals the body with an AAD block bound _inside_ the ratchet, then wraps it in an outer ECIES envelope whose v3 AAD includes the cert bytes — so the relay sees opaque bytes and the cert is GCM-bound. On receive, the cert is verified (signature, expiry, identity continuity, revocation) **before** any libsignal decrypt, and the trusted peer address is taken from the _cert claims_, not the forgeable inner field.

**⚠️ Broken findings:**

- 🟡 MED — **`revoke-all`/sign-out doesn't invalidate outstanding certs**: `revokeAllForUser` bumps a per-user generation counter, but the cert payload has no generation claim and no receiver consults it. Only per-jti revocation works, which sign-out doesn't enumerate. So already-issued certs stay valid up to their 1h TTL after "revoke all sessions." `sender-cert.service.ts:166`.
- 🔵 LOW — revocation verification fail-opens on a stale jti cache (stalling a client's polling re-opens a revoked cert for its 1h TTL) (`productionRuntime.ts:4206`).

---

## Part C — Consolidated "what to fix" backlog

Ranked, with the verified ones first:

1. **🔴 CRITICAL — identity-key regeneration after first SPK rotation** (§1). Use a dedicated install-complete flag instead of signed-prekey id 1 as the sentinel; make SPK retention strictly longer than the rotation interval. _This is the one finding that can silently break every conversation for a long-lived install — fix before any release that stays installed ~30 days._
2. **🟠 HIGH — enable P0-I2 bundle binding** (§1/§17). Pass the already-available `config.authorityPubKeyB64` (and `requireBundleBinding`) into the live `KeysHttpClient` constructor at `productionRuntime.ts:385`. Roughly a one-line config fix that closes an X3DH MITM hole.
3. **🟠 HIGH — forward secrecy on group leave** (§6). Have a remaining admin auto-rekey after a `leave` (the planner already exists; only the broadcast is missing).
4. **🟠 HIGH — group-call rekey key-index switch** (§11). Retain sender cryptor IDs and call `setCryptorKeyIndex` (currently zero call sites) on rekey; stop swallowing `rotate()` failures.
5. **🟡 MED cluster** — strict identity-trust default (§16), revoke-all enforcement (§19), SFU room membership + fail-open-when-secret-unset (§12/13/18), media lax-mode default (§7/18), attachment integrity-downgrade (§7), killed-app call wake (§14), host-mute bypass (§13), shared-handle `upsertBatch BEGIN` (§15).

## Part D — What's genuinely NOT built (vs your checklist)

- **Signal Sender Keys** — replaced by group master-key broadcast (sanctioned design). No per-member signing key, no per-message ratchet. (§5)
- **Screen share** and **raised hand** in group calls. (§12)
- **ZRTP** — substituted by SDP fingerprint pinning (intentional). (§9)
- **gRPC streams** — socket.io WS + REST only (intentional). (§18)
- **Attachment thumbnails** and **content-hash metadata**. (§7)
- **Client multi-device** — backend ready, client hardcoded to device 1. (§17)
- **iOS offline delivery (PushKit)** and **Android killed-app wake** — skeletons/deferrals. (§14)
- **Dedicated Calls table** — calls fold into the messages table. (§15)
- **Long-term identity-key rotation** — only signed prekeys rotate (matches Signal). (§1)

## Appendix — Method & evidence

- **Audit method:** 19 parallel auditors each read the actual source for one section and reported built/partial/not-built with `file:line` evidence; every High/Critical "broken" claim was re-checked by an independent adversarial verifier instructed to refute it. 6 High/Critical claims were confirmed, **0 refuted**.
- **Empirical baseline:** `npm run test:crypto` → **130 suites / 1118 tests passing** (exit 0). The crypto layer is green; the critical identity-regen bug is a _time-dependent_ path the existing tests don't exercise (the rotation test rotates a 0-age key, so it never deletes id 1 — see §1).
- **Crypto modules exist in two synchronized copies:** `packages/messenger-core/src/crypto` (source of truth) and `src/modules/messenger/crypto` (mobile mirror). Only messenger-core has signed-prekey rotation + bundle-binding; the mobile copies of `identity.ts`/`keysClient.ts` are stale in places (flagged in §1/§17).
- **Architecture references consulted:** `docs/architecture/MESSENGER_BACKEND.md`, `MESSENGER_SPEC_COVERAGE.md`, `ARCHITECTURE_COMPLIANCE.md`, `ARCHITECTURE_AMENDMENT_SFRAME.md`, and the CLAUDE.md security constraints (the locked contract).
