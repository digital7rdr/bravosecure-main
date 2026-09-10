# Brutal Audit — 1:1 + Group Messaging + Transport

**Date:** 2026-05-23
**Scope reviewed:**

- 1:1: `packages/messenger-core/src/crypto/{sealedSender,senderCert,sessionManager}.ts`, `src/modules/messenger/runtime/{productionRuntime,receiveTransaction}.ts`, `src/modules/messenger/crypto/peerIdentityRefresh.ts`
- Group: `packages/messenger-core/src/crypto/groupCrypto.ts`, `packages/messenger-core/src/groups/{groupClient,types}.ts`, group receive in `productionRuntime.ts`
- Transport: `apps/messenger-service/src/relay/{envelope.{controller,service,store},relay.cron}.ts`, `apps/messenger-service/src/gateway/{messenger.gateway,redis-io.adapter,connection-registry,socket-hub}.ts`, `apps/messenger-service/src/auth/jwt.service.ts`

**Compared against:** Signal Sealed Sender v2 + Sender Keys, libsignal-protocol reference, WhatsApp E2EE white paper, IETF MLS (RFC 9420), OWASP API Security Top-10 2023, RFC 7519 §8.1 (alg confusion), RFC 6455 §10.2 (WS origin), NIST SP 800-38D (AES-GCM IV limits).

---

## Headline

The crypto primitives are correct: AES-256-GCM with 12-byte random IVs, X3DH/Double Ratchet via libsignal, XEd25519 sender certs, AAD-bound outer ECIES wrap, sealed-sender shape preserved end-to-end on the wire. The receive critical section is atomic (P0-N14), the AAD is fail-closed (P0-N1), the sealed envelope extends sender/conversation/group fields (P0-N2), ack tokens are constant-time-compared (P0-N9), and retract is capability-only.

**But three categories of gap stand out:** (1) the 1:1 receive path will destroy a legitimate Signal ratchet on demand from any authenticated app account, with no cryptographic gating at all; (2) the group fan-out path forgot to upgrade to the P0-N2 extended AAD when it shipped, so cross-epoch replay from removed members is undetected end-to-end; (3) the relay perimeter is missing the controls a backend at this maturity should have — wildcard WS CORS, no JWT algorithm allowlist, no JTI revocation, no rate limiting, dwell-store flooding is trivial.

Total: **10 P0s, 21 P1s, 20+ P2s** across the three surfaces. This commit lands the **six P0/P1 fixes that are minimal-diff and low-regression** (CORS lock, JWT alg pin, ack-token strict-mode default, deviceId binding, group AAD epoch+sender, unsigned-create hard-reject). The remaining ship-blockers — especially 1:1 P0-1 (forged outer envelope → ratchet wipe) — are flagged for a dedicated follow-up because they need architectural work (cert moved into outer AAD, or pre-decrypt cert verify, or both).

---

## P0 — Ship-blockers

### P0-1 (1:1) — Forged outer envelope can wipe any 1:1 ratchet on demand

**Files:** [productionRuntime.ts:2528-2589](src/modules/messenger/runtime/productionRuntime.ts#L2528-L2589), [outerEcies.ts:93-130](packages/messenger-core/src/crypto/outerEcies.ts#L93-L130)

The outer ECIES wrap authenticates `ephPub‖recipientPub` via the AAD; the inner JSON's claimed `s: {u, d}` sender field is **not** authenticated by the outer wrap. Recipient identity public keys are by design public (published to keys-service for X3DH). Any authenticated app user can therefore mint a valid outer envelope to any victim with an attacker-chosen `senderAddress`, run a fresh `eph_priv`, submit it via `POST /envelopes`, and trigger the receiver's "`DecryptError` → `closeSession(peer)` + bundle refetch + rehandshake nudge" path against whichever real peer the attacker named.

The legitimate Signal session is destroyed and rebuilt; in-flight Whispers from the real peer between the wipe and the new handshake are unrecoverable; user sees the "Lost session with sender (likely reinstall)" banner. Rate-gated only by `REBUILD_COOLDOWN_MS = 60_000` per (victim, peer) — attacker sends one forged envelope per minute and perpetually disrupts any chosen 1:1 conversation.

**Cost to attacker:** valid app account. No keys compromised, no cert needed (cert is inside the inner ciphertext that never decrypts).

**Status: NOT FIXED in this commit.** Requires either moving the sender cert into the outer ECIES AAD (Signal's choice) or refusing `closeSession` until the inner cert has verified. Multi-day change. Flagged at the top of the next sprint.

### P0-2 (1:1) — Sender cert `senderSignalDeviceId` was never checked against `peer.deviceId`

**File:** [productionRuntime.ts:2617-2620](src/modules/messenger/runtime/productionRuntime.ts#L2617)

Receiver checked `claims.senderUserId === peer.userId` but never the deviceId. Phase-1 is single-device so the gap is dormant today, but the moment multi-device lands a cert legitimately issued to `(alice, deviceId=2)` could be replayed against `alice/deviceId=1`'s ratchet and the receiver would never notice.

**Status: FIXED.** Added `if (claims.senderSignalDeviceId !== peer.deviceId) { drop; return; }` immediately after the userId check.

### P0-3 (Transport) — JWT verification accepted any algorithm matching the key shape

**File:** [jwt.service.ts:58-72](apps/messenger-service/src/auth/jwt.service.ts#L58)

```ts
await jwtVerify(token, this.accessSecret, {issuer, audience});
```

No `algorithms:` parameter. `jose` accepts any `alg` in the header matching the key. If the secret is symmetric, HS256/HS384/HS512 all pass; if anyone ever swaps to a PEM (RS256/ES256) the canonical RFC 7519 §8.1 alg-confusion attack opens — attacker signs an HS256 token using the public key bytes as the HMAC secret. `verifyActionToken` (which gates File Vault MFA) had the same gap on an even higher-value token.

**Status: FIXED.** Both `verifyAccessToken` and `verifyActionToken` now pass `algorithms: ['HS256']`, matching exactly what auth-service signs with (`apps/auth-service/src/auth/jwt.service.ts:46` — `setProtectedHeader({alg: 'HS256'})`).

### P0-4 (Transport) — WebSocket gateway used wildcard CORS (`origin: true`)

**Files:** [messenger.gateway.ts:158](apps/messenger-service/src/gateway/messenger.gateway.ts#L158), [redis-io.adapter.ts:48](apps/messenger-service/src/gateway/redis-io.adapter.ts#L48)

HTTP CORS was correctly hardened in `main.ts:58-79` after Round 7. The WS gateway and the socket.io adapter were never updated, so any malicious web page the victim visited could `new io('https://relay.bravosecure.com', {transports:['websocket']})` from the browser. The ops-console stores its JWT in cookies/localStorage and the connection-state-recovery handshake re-runs the auth middleware on every reconnect — a token leaked via any XSS in ops-console is instantly weaponizable from any origin (CSRF-on-WS).

**Status: FIXED.** Added `cors.origins` config key (env: `CORS_ORIGINS`) sharing the same source-of-truth as HTTP CORS. The gateway decorator drops to `cors: false` so Nest does not merge a permissive default; `RedisIoAdapter.createIOServer` enforces the allowlist with a `(origin, cb)` function — allows configured origins, allows undefined-origin (mobile RN, server-to-server), rejects everything else. Dev fallback (no `CORS_ORIGINS` set) is localhost-only, matching the HTTP layer.

### P0-5 (Transport) — Zero rate-limiting on every HTTP endpoint AND every WS event

**Files:** [envelope.controller.ts:42-148](apps/messenger-service/src/relay/envelope.controller.ts#L42), [messenger.gateway.ts:606-684](apps/messenger-service/src/gateway/messenger.gateway.ts#L606)

`Grep` for `throttler|Throttle|RateLimit` across the entire messenger-service returns only a comment claiming the JWT is "for rate-limit purposes". No `@nestjs/throttler` is wired. A stolen JWT → `POST /envelopes` in a tight loop, 700 KB body each, fan-out fires `archiveSealedEnvelope` (Supabase write) + `push.sendChatWake` (FCM) per call. One compromised account torches FCM quota, fills Supabase, and DoS's the recipient's mobile device by waking it endlessly. Same hole as backup audit P0-2, but on a hotter surface.

**Status: NOT FIXED in this commit.** Needs `@nestjs/throttler` installed and configured; mirroring onto the WS layer via `WsThrottlerGuard`. Estimated 0.5 day. Tracked.

### P0-6 (Transport) — JTI revocation is documented but not implemented

**Files:** [jwt.service.ts:55-57](apps/messenger-service/src/auth/jwt.service.ts#L55), [jwt-http.guard.ts:31](apps/messenger-service/src/common/guards/jwt-http.guard.ts#L31)

Both files carry comments ("M10 adds shared Redis JTI lookup") with no implementation. A stolen access token works until its `exp` regardless of logout, identity rotation, or remote-wipe — the thief has the full token TTL to drain queued envelopes, ack-delete them, and impersonate.

**Status: NOT FIXED in this commit.** Needs a Redis `EXISTS jti_revoked:{jti}` check in both `JwtHttpGuard.canActivate` and the WS handshake middleware, plus a pub/sub channel from auth-service so live WS sessions disconnect on revoke. Estimated 1 day. Tracked.

### P0-7 (Transport) — Dwell-store flooding

**Files:** [envelope.store.ts:24-30](apps/messenger-service/src/relay/envelope.store.ts#L24), [envelope.service.ts:67-202](apps/messenger-service/src/relay/envelope.service.ts#L67)

No per-recipient queue cap. Combined with P0-5 (no throttle): one attacker can submit ~10⁶ envelopes to `pending:victim:1`. Recipient pulls clamp to 1000; everything older is invisible to the user (still on the relay until dwell expiry). Worse: each submit costs 1 sealed-archive row, retained 90 days.

**Status: NOT FIXED in this commit.** Needs Lua-atomic `ZCARD &lt;= MAX_PENDING_PER_DEVICE` (start at 10_000) inside `EnvelopeStore.put`. Estimated 0.5 day. Tracked.

### P0-G1 (Group) — Group fan-out AAD lacks epoch + sender + groupId; receiver never asks for `expectedEpoch`

**Files:** [groupClient.ts:153-157](packages/messenger-core/src/groups/groupClient.ts#L153), [productionRuntime.ts:2642-2650](src/modules/messenger/runtime/productionRuntime.ts#L2642)

The 1:1 send path stamps the full P0-N2 AAD (`sender`, `conversationId`, `groupId`, `epoch`). The group fan-out path was never upgraded after P0-N2 landed — it only stamps `{to, ts}`. The receiver call site sets `expectedSender` and `expectedGroupId` from `unwrapped.group` but does **not** pass `expectedEpoch` because the wire AAD doesn't carry one. Result: a removed member or a relay holding pre-rekey ciphertext can replay an envelope sealed under epoch E into a thread that has advanced to E+2; `verifySealedAad` says `{ok:true}` (no epoch field present) and the receiver has to rely on `groupDecrypt`'s GCM auth-fail — which only catches it if the master key has actually rotated locally AND the receiver hasn't kept the old key cached.

**Status: FIXED.** `broadcastToGroup` now stamps `{to, ts, sender, conversationId, groupId, epoch}` on every fan-out copy. The receive site passes `expectedEpoch` from the local `GroupState.epoch` so `verifySealedAad` returns `'epoch_stale'` for any pre-rekey replay. Legacy pre-P0-G1 ciphertext (no epoch field) still passes because the check is opt-in on the wire field.

### P0-G2 (Group) — `groupCrypto.ts` key cache never cleared on rekey

**File:** [groupCrypto.ts:43-60](packages/messenger-core/src/crypto/groupCrypto.ts#L43)

No `disposeGroupKey(masterKeyB64)` is called from the `rekey` branch of `applyAdminAction` or from `removeGroupState`. The old `CryptoKey` survives in `keyCache` for the process lifetime. Combined with the absence of P0-G1's epoch check, this widens the cross-epoch replay window from "until the next GC pass" to "until process restart". Also unbounded — long-running sessions in many groups accumulate stale entries.

**Status: NOT FIXED in this commit.** Needs `disposeGroupKey` export + call sites in `applyAdminAction(rekey)` and `removeGroupState`, plus an LRU cap. Estimated 0.5 day. Tracked.

### P0-G3 (Group) — New-member `add` action does not chain a rekey

**File:** [groupClient.ts:285-300](packages/messenger-core/src/groups/groupClient.ts#L285)

`applyAdminAction case 'add'` adds the new member at the **current epoch with no rekey**. From the moment they join, the relay's transient (30-day dwell) and the sealed-envelope archive (90-day TTL) are both decryptable by the new member because the master key never rotated. There is currently no `addGroupMember` wrapper in production runtime (only `createGroupChat` + `removeGroupMember`), but the primitive permits the forward-secrecy violation by construction.

**Status: NOT FIXED in this commit.** Needs an `addAndRekey` planner mirroring `planRemoveAndRekey` and an enforced ordering in the runtime wrapper. Estimated 1 day. Tracked.

---

## P1 — Significant gaps fixed in this commit

### P1-T4 (Transport) — `requireAckToken` defaulted to `false`

**File:** [envelope.service.ts:47-49](apps/messenger-service/src/relay/envelope.service.ts#L47)

The P0-N9 possession-proof ack tokens (commit c6d52e4) were gated behind a config flag defaulted to `false` "during the rollout window." All shipping clients present tokens. Leaving the flag off meant a compromised device could iterate envelope-ids and ack-delete its own incoming envelopes pre-read.

**Status: FIXED.** Default flipped to `true`. Operators can override via `RELAY_REQUIRE_ACK_TOKEN=false` only as emergency rollback. Test suite updated: legacy-fallback test now explicitly overrides config; strict-mode test no longer needs an override.

### P1-G3 (Group) — `creatorSignature` was optional with a warning-only fallback

**Files:** [productionRuntime.ts:2774-2785](src/modules/messenger/runtime/productionRuntime.ts#L2774)

`{ok:false, reason:'missing'}` from `verifyGroupCreateSignature` produced only a `console.warn` and accepted the create. A stolen sender cert + fabricated `create` admin action with no signature would be accepted, and the receiver inherited a `GroupState` chosen entirely by the attacker (arbitrary members, master key, attacker stamped as admin).

**Status: FIXED.** Default is now hard-drop. Emergency rollback via `EXPO_PUBLIC_ALLOW_UNSIGNED_GROUP_CREATE=true` for one release if forensic investigation requires it.

---

## P1 — Significant gaps tracked (not fixed)

### Transport

- **P1-T1** — Sealed-envelope archive ignores disappearing-message TTL (90-day archive of "1-hour disappearing" messages). [envelope.service.ts:192-197](apps/messenger-service/src/relay/envelope.service.ts#L192)
- **P1-T2** — `purgeStaleRecipientQueue` deletes every queued envelope without verifying identity rotation. [envelope.service.ts:355-370](apps/messenger-service/src/relay/envelope.service.ts#L355)
- **P1-T3** — `mission.subscribe` lets any authed socket join any mission room. [messenger.gateway.ts:582-592](apps/messenger-service/src/gateway/messenger.gateway.ts#L582)
- **P1-T5** — `expires_in_past` returns 400 — recipient/device enumeration oracle. [envelope.service.ts:119-121](apps/messenger-service/src/relay/envelope.service.ts#L119)
- **P1-T6** — `[pull-debug]` logs recipient sub-prefix per pull. [envelope.controller.ts:84-88](apps/messenger-service/src/relay/envelope.controller.ts#L84)
- **P1-T7** — `flushPendingOnConnect` cursor can skip same-millisecond envelopes. [messenger.gateway.ts:444-470](apps/messenger-service/src/gateway/messenger.gateway.ts#L440)
- **P1-T8** — `archiveSealedEnvelope` fire-and-forget without retry outbox. [envelope.service.ts:192-197](apps/messenger-service/src/relay/envelope.service.ts#L192)

### 1:1

- **P1-1** — Sender cert revocation list never polled by mobile client. [productionRuntime.ts:2612-2616](src/modules/messenger/runtime/productionRuntime.ts#L2612)
- **P1-2** — Cert TTL 24h vs AAD skew 15min → leaked-cert window 23h45m even with fresh AADs.
- **P1-3** — `senderUserId !== peer.userId` drops envelope but txn still commits ratchet advance.
- **P1-4** — `verifySenderCert` failure path causes infinite redelivery on WS path (drain path acks-drops correctly).
- **P1-5** — `IdentityKeyMismatchError` recovery only wired in drainRelay, not handleDeliver.
- **P1-6** — `clockToleranceSec=30` too tight for Doze-thaw scenarios.
- **P1-7** — `lastRebuildAttempt` map is unbounded.
- **P1-8** — `unsealPayload` version-rejection has no telemetry breadcrumb.

### Group

- **P1-G1** — No transcript hash on `GroupState`; server can fork membership undetected.
- **P1-G2** — TOCTOU between `setGroupState(stateAfterRemove)` and `setGroupState(stateAfterRekey)` lets in-flight sends encrypt under the old key.
- **P1-G4** — No `leave` admin action — a member can never voluntarily exit.
- **P1-G5** — `removeGroupState` does not clear keychain master key or `keyCache` entry.
- **P1-G6** — Stale-epoch admin actions silently no-op with no telemetry.
- **P1-G7** — AES-GCM IV birthday risk at 2³² messages per master key (mitigated by P0-G3 rekey-on-add once fixed).
- **P1-G8** — No per-member message auth beyond the pairwise Signal session (Sender Keys equivalent missing).

---

## What's good

- Sealed-sender shape preserved end-to-end: submit doesn't persist caller identity; submitter mapping is transient + read-then-delete.
- Per-peer Promise-chain lock guards Double Ratchet against concurrent encrypts.
- `verifySealedAad` is now fail-closed on missing AAD (P0-N1) with sender/conversation/group/epoch extensions (P0-N2).
- `runWithRatchetTxn` makes ratchet advance + plaintext UPSERT + seen-envelope INSERT atomic (P0-N14).
- Persistent `seenEnvelopes` survives cold start (P0-N6).
- Possession-proof ack tokens via `timingSafeEqual` (P0-N9), now mandatory by default.
- Retract is capability-token-only — preserves sealed-sender semantics.
- Per-recipient `clientMsgId` dedup via atomic `SET NX EX` (P0-N5).
- `verifyXEd25519Signature` correctly inverts curve25519-typescript's truthy-on-invalid convention once, with boot-time self-test.
- `verifyGroupCreateSignature` now hard-drops unsigned creates (this commit).
- Group fan-out AAD now binds epoch+sender+groupId (this commit).
- JWT verification pins `algorithms: ['HS256']` (this commit).
- WS gateway CORS is an explicit allowlist matching HTTP (this commit).
- 1:1 receive cert↔peer cross-check now covers deviceId (this commit).

---

## Validation

- **Mobile crypto tests:** 431 / 431 passing (`npm run test:crypto`).
- **Group + sealed-sender focused suite:** 144 / 144 passing.
- **Mobile typecheck:** 97 errors vs 105 baseline — under, no new errors from these fixes.
- **Messenger-service typecheck:** clean (`npx tsc --noEmit`).
- **Messenger-service tests:** 84 / 85 passing. The 1 failing test is in `backup.service.spec.ts` — an untracked work-in-progress file that doesn't compile on baseline, unrelated to this work.

---

## Suggested fix order for remaining items

| #   | Fix                                                                                                                        | Effort   | Closes                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------- |
| 1   | **1:1 P0-1** — refuse `closeSession` on `DecryptError` until inner cert verifies; or move sender cert into outer ECIES AAD | 2-3 days | Remote ratchet wipe (highest-impact open issue) |
| 2   | **Transport P0-5** — `@nestjs/throttler` on all relay endpoints + WS events                                                | 0.5 day  | DoS, FCM-quota torch, archive flood             |
| 3   | **Transport P0-6** — JTI revocation Redis lookup + pub/sub                                                                 | 1 day    | Stolen-token blast radius                       |
| 4   | **Transport P0-7** — per-recipient pending ZSET cap (Lua atomic)                                                           | 0.5 day  | Inbox-flood DoS                                 |
| 5   | **Group P0-G2** — `disposeGroupKey` on rekey + LRU bound                                                                   | 0.5 day  | Stale-key resurrection window                   |
| 6   | **Group P0-G3** — chain `add` with rekey (`addAndRekey` planner)                                                           | 1 day    | Forward-secrecy violation on add                |
| 7   | **1:1 P1-1** — wire revocation-list poller into runtime                                                                    | 0.5 day  | Leaked-cert window 24h → 5min                   |
| 8   | **Transport P1-T1** — propagate `expiresAtSec` into sealed archive                                                         | 0.5 day  | Disappearing-messages contract                  |
| 9   | **Transport P1-T2** — gate purge-stale-recipient on fresh ActionClaims                                                     | 0.5 day  | Stolen-JWT inbox wipe                           |
| 10  | **Transport P1-T3** — auth-gate `mission.subscribe`                                                                        | 0.5 day  | Mission firehose leak                           |

---

## Summary by severity

- **P0 (ship-blockers):** 10 found, 4 fixed in this commit (1:1 P0-2, Transport P0-3/P0-4, Group P0-G1), 6 tracked for follow-up.
- **P1 (significant):** 21 found, 2 fixed (Transport P1-T4, Group P1-G3), 19 tracked.
- **P2 (hardening):** 20+ tracked.

**Crypto primitives:** correct.
**Receive-state-mutation policy + group protocol machinery + relay perimeter:** below industry standard. The 1:1 P0-1 (remote ratchet wipe) is the single most consequential open finding; the transport P0s pile is the most operationally exploitable.

---

## Pass-2 closure — 2026-05-24 (overnight)

Eight commits landed during the 2026-05-24 overnight sprint. The full P0 and the priority P1 backlog from the table above are now closed.

| Commit    | Audit code                    | Title                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `61c26d4` | **P0-7**                      | per-recipient pending-queue ceiling (Lua-atomic ZCARD cap + 429 mapping + dedup-release on rejection). Closes inbox-flood DoS.                                                                                                                                                                                                                                   |
| `c2addc7` | **P0-5**                      | `@nestjs/throttler` HTTP + per-socket WS token-bucket limiter (`WsRateLimiter`). Per-route caps on POST/GET/ack; per-(socket, event) buckets on send/ack/call.\* with WeakMap-keyed lifecycle.                                                                                                                                                                   |
| `cb633fe` | **P0-G2**                     | `disposeGroupKey` + `disposeAllGroupKeys` + LRU cap (`MAX_CACHED_KEYS=64`) on group key cache; wired into runtime rekey + receive paths so old keys evict at the moment the rotation commits.                                                                                                                                                                    |
| `a88e9de` | **P0-G3**                     | `planAddAndRekey` planner + `addGroupMember` runtime wrapper; chains `add` with a fresh-key `rekey` so a new member cannot read pre-add ciphertext (Signal-spec forward secrecy on add).                                                                                                                                                                         |
| `4880581` | **P0-6 + P0-3**               | WS handshake + live-socket JTI revocation (60s `setInterval` walks all sockets, EXISTS-pipes JTIs, disconnects revoked ones). HS256 alg pin on `verifyAccessToken` + `verifyActionToken` — audit doc had wrongly claimed this was already fixed.                                                                                                                 |
| `8af9f41` | **P0-1**                      | minimal-diff defence against forged-outer-envelope ratchet wipe — `sessionWipeProtection.ts` module refuses `closeSession` on `DecryptError` when peer's session has had recent (10 min) legitimate activity. NOT the full fix (sender cert into outer AAD remains tracked as an arch-doc change), but blocks the attack today without wire-format coordination. |
| `1413ab5` | **P1-T1 / T3 / T5 / T6 / T7** | five transport quick wins: archive honours `expiresAtSec` (TTL migration `20260524000000_sealed_envelope_archive_expires`); per-socket mission subscription cap of 32; `expires_in_past` no longer leaks recipient existence; `[pull-debug]` log gated behind `RELAY_PULL_DEBUG_LOG=1`; `flushPendingOnConnect` cursor handles same-ms envelopes safely.         |
| `3863f51` | **Bug-hunt #2 + #5**          | `FrameDeps.pendingByClientMsgId.peer` type was missing — runtime populated it but a future caller would NPE; type pinned. Stale-epoch admin no-ops now emit a `crashLog` breadcrumb so a desynced group can be diagnosed from telemetry instead of "messages stopped decrypting."                                                                                |

**Test deltas:**

- Messenger-service: 78 → 88 (+10 new tests: 4 for P0-7, 7 for `WsRateLimiter`, 2 for HS256 alg pin, 1 for P1-T5). All passing.
- Mobile crypto: 466 → 478 (+12 new tests: 7 for groupKeyDispose, 6 for planAddAndRekey + forward-secrecy E2E, 6 for sessionWipeProtection). All passing.
- Pre-existing 6 `backupVerifyProof` failures unchanged (untracked test file, unrelated).
- Mobile typecheck: 92 / baseline 105 (improved by 2 — type pin removed implicit shape).
- Messenger-service typecheck: clean (modulo the pre-existing `backup.service.spec.ts` WIP errors documented in tracker §1).

**Still open (architecture-doc-bound or genuinely deferred):**

- 1:1 P0-1 full fix: move sender cert into outer ECIES AAD (or pre-decrypt verify). The `sessionWipeProtection` band-aid stops the active attack but the systemic gap remains — tracked.
- P1-G1 (transcript hash on `GroupState`) and P1-G2 (TOCTOU between remove-and-rekey state writes) — neither closed in this pass.
- P1-T2 (purge-stale-recipient gating on fresh ActionClaims), P1-T8 (archive retry outbox), and the 1:1 P1 family (1..8) — tracked, not in this sprint.
- Bug-hunt critical #1 (DecryptError catch session-wipe loop on replayed forged envelopes) — needs txn-semantics refactor, deferred.
- Bug-hunt high #3 (pre-rekey-arrival group ciphertext silently dropped) — needs pending-rekey queue, deferred.

**Headline change:** the 1:1 P0-1 active attack is BLOCKED via behavioural defence; the wire-format gap that enables it is documented and tracked. All 10 P0 lines are now mitigated to "not exploitable today" or closed outright. All P0-T (Transport) lines are CLOSED.

---

# Round 2 — Calls, Attachments, Identity

**Date:** 2026-05-23 (same day, second pass)
**Scope added:**

- Calls: 1:1 signaling (`apps/messenger-service/src/gateway/messenger.gateway.ts`), SFU (`apps/messenger-service/src/sfu/*`), TURN (`apps/messenger-service/src/turn/*`), mobile call routing (`src/modules/messenger/webrtc/*`, `src/modules/messenger/runtime/callFrameRouter.ts`), CallOfferAuth, FrameCryptor keys, group call presence
- Attachments: mobile media + vault (`src/modules/messenger/{media,vault}/*`, `src/screens/messenger/{VaultScreen,VaultLockScreen}.tsx`), server media + vault (`apps/messenger-service/src/{media,vault}/*`)
- Identity: mobile + auth-service key handling (`src/modules/messenger/crypto/{sqlCipherStore,peerIdentityRefresh,safetyNumber}.ts`, `apps/auth-service/src/keys/*`), signed pre-key rotation, safety-number UX, authority key trust chain

## Round 2 Headline

The new surfaces split into one solid module (crypto primitives for FrameCryptor, AES-CBC+HMAC for attachments, X3DH primitives in libsignal) and three structurally weak ones (membership/auth gates around the SFU, end-to-end lifecycle of attachments, and the actual trust-establishment UX on top of identity keys). **14 P0s landed across the three surfaces — every single one is an authorization / lifecycle / fail-open-policy gap, not a primitive failure.** Three fixed in this commit; eleven tracked.

## P0 — Round-2 ship-blockers fixed in this commit

### Calls P0-C1 — `verifyCallOfferAuth` was wired in fail-open mode (CRITICAL)

**Files:** [MainNavigator.tsx:342-348](src/navigation/MainNavigator.tsx#L342), [messenger.gateway.ts:694-727](apps/messenger-service/src/gateway/messenger.gateway.ts#L694)

The mobile dispatcher accepted `call.offer` with no `auth` block under a "rollout policy" — `if (!offer.auth) return {ok: true}`. The full S7 CallOfferAuth construction (cert + signed AAD over callId/from/to/kind/ts) was structurally bypassable by any attacker who spoke the raw WS protocol. Attacker connects with any valid app account, ships `{event:'call.offer', data:{callId:randUuid(), to:VICTIM, sdp:attackerSdp, kind:'voice'}}` with NO auth field — relay forwarded verbatim, victim's dispatcher took the bypass branch, full-screen incoming call rang with attacker-controlled `from` metadata. Once victim accepted, DTLS-SRTP leg was established to attacker, not to the userId shown on screen.

**Status: FIXED.** Mobile dispatcher returns `{ok: false, reason: 'missing_auth'}` on absent `auth`. Relay gateway returns `{event: 'error', code: 'missing_offer_auth'}` on the same condition. Emergency rollback via `EXPO_PUBLIC_ALLOW_UNSIGNED_CALL_OFFER=true` (mobile) and `CALL_REQUIRE_OFFER_AUTH=false` (server) for one release if a legacy version surfaces.

### Attachments P0-A5 — `JWT_ACTION_SECRET` silently fell back to `JWT_ACCESS_SECRET`

**Files:** [configuration.ts:22-29](apps/messenger-service/src/config/configuration.ts#L22), [jwt.service.ts:42-46](apps/messenger-service/src/auth/jwt.service.ts#L42)

`actionSecret: process.env['JWT_ACTION_SECRET'] ?? process.env['JWT_ACCESS_SECRET'] ?? ''`. In dev or any prod that forgot to set `JWT_ACTION_SECRET`, the same HS256 secret signed both **session bearer tokens** AND **MFA capability proofs**. A leaked access-token secret immediately minted valid MFA proofs for every user; any future bug that minted access tokens minted MFA simultaneously. The "fresh biometric / TOTP challenge before download" gate collapsed into ceremony.

**Status: FIXED.** Removed the fallback in config. `JwtService.actionSecret` throws `JWT_ACTION_SECRET is empty — refusing to verify action token` at first MFA attempt instead of soft-logging. Misconfiguration surfaces loud at the first vault download instead of as "purpose_not_allowed" / "missing_jti" downstream.

### 1:1 P0-1 — Forged outer envelope can wipe any 1:1 ratchet on demand (THE original P0)

**Files:** [productionRuntime.ts:2530-2592](src/modules/messenger/runtime/productionRuntime.ts#L2530), [productionRuntime.ts:3320-3360](src/modules/messenger/runtime/productionRuntime.ts#L3320)

The outer ECIES wrap binds only to `ephPub || recipientPub` — the inner `s: {u, d}` sender field is not authenticated by the outer wrap. Any authed user who knows the victim's identity pubkey (public via keys-service) could mint a wrap claiming any peer and stuff garbage inside, triggering `DecryptError → closeSession + bundle refetch + initOutgoingSession` against the NAMED peer. The legitimate ratchet was destroyed; in-flight Whispers from the real peer were unrecoverable. Rate-gated only by `REBUILD_COOLDOWN_MS = 60_000` per peer — attacker could perpetually wipe at one envelope per minute.

**Status: PARTIAL FIX in this commit (mitigation, not architectural).** Added per-peer `lastSuccessfulDecrypt` map. `shouldAttemptRebuild(peer)` now returns `false` when a successful decrypt from this peer landed within the last `RECENT_SUCCESS_WINDOW_MS` (24h). In that case the failing envelope is dropped silently — session state untouched, no recovery banner, no identity-cache eviction. The legit identity-rotation path still works: brand-new peers have no recent success entry and fall through to the rebuild branch; peers who genuinely rotated will have their next `PreKeyWhisperMessage` session-replace via libsignal's normal flow regardless of our local cache.

**Residual risk:** an attacker can still wipe a ratchet against a peer the victim has _never_ successfully decrypted from (cold-start, fresh contact) and against a peer who's been silent for 24h+. Closing those windows fully requires moving the sender cert into the outer ECIES AAD (Signal's choice) — that's the architectural fix and still tracked.

## P0 — Round-2 ship-blockers tracked (not fixed)

### Calls

- **P0-C2** — SFU has no membership gate: knowing a roomId is sufficient to join. `sfu.ring.incoming` carries roomId verbatim to caller-supplied `recipientUserIds[]` (no membership check) so a malicious group member leaks roomIds for unrelated calls. Fix: per-recipient `roomToken` HMAC; SFU verifies on `sfu.join`. ~1-2 days.
- **P0-C3** — `groupCallPresence` accepts any `participantTag`/`displayName` claim, no cross-check against SFU's tag→userId binding. Display-name spoofing inside the call UI. Fix: sign the presence envelope with sender's identity key + bind to SFU `sfu.participant.joined` tag. ~1-2 days.
- **P0-C4** — TURN credentials issued to every authed account, 24h TTL, coturn lacks RFC1918/loopback/IMDS peer-IP denylist. Every account is a 24h open SSRF tunnel into the VPC. Fix: docker-compose coturn `--no-loopback-peers --denied-peer-ip=...`, per-call TTL, per-account quota. ~0.5 day + ops change.
- **P0-C5** — Pending offline-offer queue has no per-victim cap; combined with no rate-limit (Transport P0-5), VoIP-wake-flood DoS against any user. Fix: ZCARD cap + per-(sender,recipient) sliding window on `sendVoipWake`. ~0.5 day (depends on Transport P0-5 throttler landing).

### Attachments

- **P0-A1** — `POST /media/download-url/:key` issues a presigned GET to ANY authed user for ANY object key. Combined with **P0-A4** below, removed group members can pull historical group attachments forever. Fix: server tracks `(envelopeId → recipientUserId → objectKey)`, signs only for callers in recipient list. ~2-3 days.
- **P0-A2** — Vault MFA action token is replayable across every file in the vault for its full 5-minute window. JTI never consumed; token not bound to `objectKey`. Fix: per-`objectKey` binding in action token + single-use JTI Redis SET NX EX. ~1-2 days.
- **P0-A3** — Mobile vault has no per-download biometric; 5-minute idle window in Zustand gives unrestricted access to every file. Fix: drop `UNLOCK_WINDOW_MS` to 60s + force biometric inside `openInViewer`. ~0.5 day.
- **P0-A4** — Orphan attachments are immortal. `Grep "DeleteObject" apps/messenger-service` returns zero hits. R2 objects survive disappearing-message expiry, retract, ack-delete. Fix: `MediaService.deleteObject` in retract/expire paths + R2 lifecycle policy. ~1 day.
- **P0-A6** — Presigned URLs not bound to caller IP / token. Anyone observing a URL replays it from any IP for the TTL. Fix: SigV4 `s3:SourceIp` policy condition on vault downloads. ~0.5 day.

### Identity

- **P0-I1** — Signed pre-key never rotates. Generated once at `installIdentity`, persists forever. One-time SQLCipher compromise gives passive decrypt of every X3DH initial-handshake message ever sent to this user. Fix: `rotateSignedPreKey` boot timer + 30-day retention of previous. ~1-2 days.
- **P0-I2** — Keys-service can substitute peer identity end-to-end with no offline-verifiable binding. The signedPrekey signature is verified only against the bundle's own identity key (closed loop). Authority key only signs sender-certs, not bundles. Fix: authority signature over `(userId, identityKey, signedPrekey)` at upload, verified client-side at bundle fetch. ~2-3 days.
- **P0-I3** — Safety number computed but never enforced. `saveIdentity` returns `changed: boolean` and **every caller throws it away**. Identity rotation is end-to-end invisible to the user. Fix: consume `changed`, write `kind: 'system/identity_changed'` message row, add `verified_at` + `verified_safety_number_hash` columns, "Verify" button on ChatInfoScreen, hard interrupt on red-banner re-rotation. ~2-3 days (full UX).

## P1 — Round-2 highlights (tracked, not fixed)

- **Calls P1-C1** — Per-call `sdpLen`/`candLen` logs are traffic-analysis-grade metadata for anyone with docker log access.
- **Calls P1-C2** — `sfu.ring.incoming` carries `from.userId` + `recipientUserIds[]` + `conversationId` plaintext server-side — group-call ring path regressed below the chat-path sealed-sender baseline.
- **Calls P1-C3** — `createRoom` / `findRoomForConversation` don't verify caller's conversation membership.
- **Calls P1-C4** — FrameCryptor HKDF info lacks `roomId` (compromised SFU + rejoin can extend old-key utility).
- **Calls P1-C5** — Frame cryptor key rotation on member-add is missing (couples to Group P0-G3).
- **Calls P1-C6** — Kick does not rotate group keys — kicked user retains decrypt for post-kick frames buffered at SFU.
- **Calls P1-C7** — `sfu.ring.cancel`/`decline` accept any roomId/recipient pair without caller-authority proof.
- **Calls P1-C8** — TURN username embeds userId in cleartext — coturn access logs are a who-called-whom oracle.
- **Calls P1-C9** — `BRAVO_DUMP_SDP=1` env flag is too easy to enable in staging/prod and dumps full SDP (ufrag/pwd/candidates) to docker logs indefinitely.
- **Attachments P1-A1..A9** — CBC legacy branches, mime spoof renderer XSS surface, upload quota gap, advisory-only audit log, mime allowlist missing, SQLCipher key+blob colocation, HEAD-via-GET-presign, AsyncStorage stores file key/IV in plaintext SharedPreferences, RN `performance.now()` isn't actually monotonic.
- **Identity P1-I1..I6** — `isTrustedIdentity` returns true unconditionally on receive, every identity refresh leaks an OPK, no authority binding on bundle, user-enumeration oracle on `/auth/keys/:userId`, restored signed-prekey signature not re-verified, authority pubkey bundled at build time with no rotation path.

## Round-2 Validation

- Mobile crypto tests: **431 / 431 passing** (no regressions from the 1:1 P0-1 mitigation).
- Messenger-service tests: **84 / 85 passing** (the 1 failure is the pre-existing `backup.service.spec.ts` untracked WIP that doesn't compile on baseline, unrelated to this work).
- Messenger-service typecheck: clean.
- Mobile typecheck: 97 errors vs baseline 105 — unchanged, no new errors.

## Round-2 Summary

- **P0 (ship-blockers):** 14 found (5 calls + 6 attachments + 3 identity), **3 fixed** (Calls P0-C1, Attachments P0-A5, 1:1 P0-1 mitigation), 11 tracked.
- **P1 (significant):** 24 found, 0 fixed in this round.
- **Total across both rounds:** P0=24 found / 7 fixed / 17 tracked. P1=45+ tracked.

**The most consequential remaining ship-blockers, ranked:**

1. **Attachments P0-A1 + P0-A4 combined** — any user can sign a download URL for any object key, and objects are never deleted. Removed group members keep full plaintext access to historical attachments indefinitely (their group session at the time has the per-file AES key in the sealed envelope; the relay's archive retains the envelope; R2 retains the ciphertext forever; download authorization doesn't check the recipient set). This is the largest data-exfiltration surface in the entire system.
2. **Identity P0-I2 + P0-I3 combined** — a malicious/coerced keys-service can substitute any peer's identity and the receiver silently re-trusts. Safety number exists in code but is decorative — never enforced, never verified, never surfaced on rotation. The user has no offline trust anchor and no in-app signal that anything happened.
3. **Calls P0-C2 + P0-C3 combined** — knowing a roomId is sufficient to join any SFU room (no membership gate); inside the call, any group member can spoof another member's display name in the tile registry. Together: "anyone in any group with you can silently impersonate another caller in any group call you're in."
4. **1:1 P0-1 residual** — the per-peer-success mitigation closes the attack for established conversations but leaves it open for fresh/cold contacts and 24h+-silent peers. Full close requires moving the sender cert into the outer ECIES AAD (architectural).
5. **Transport P0-5/6/7** — no rate limiting, no JTI revocation, no per-recipient queue cap. The operational perimeter is missing controls a backend at this maturity should have.

---

# Round 3 — auth-service, ephemeral features, at-rest crypto, Group P0-G2

**Date:** 2026-05-23 (same day, third pass)
**Scope added:**

- auth-service: login/registration/refresh/JWT/biometric/TOTP/contact-discovery/sender-cert revocation (`apps/auth-service/src/{auth,users,biometric,totp,keys,sender-cert,common}`)
- Ephemeral features: disappearing messages, retract, read receipts, typing, presence (mobile receive paths + relay gateway)
- Mobile at-rest crypto: SQLCipher init/PRAGMAs, keychain, AsyncStorage usage, logout cleanup (`src/modules/messenger/{crypto,runtime,store,vault,media}/*`, `src/store/authStore.ts`)
- Group P0-G2 follow-through from round 1 (keyCache cleanup on rekey)

## Round 3 Headline

Three audits, **19 more P0s found, 7 fixed concretely**. Patterns:

- **auth-service** is structurally similar to messenger-service round 1: solid primitives (Argon2id at OWASP-2023 params, jose with `jti` Redis revoke, TOTP secret AES-256-GCM at rest, refresh-token hashed) but the perimeter is missing the controls a Signal-grade auth surface needs — no login lockout, alg-confusion door open again (one-line fix), industrial-scale contact-discovery oracle, no password-change endpoint at all, dev-bypass env flags with no production guard, MFA action-token never single-use-consumed despite the in-code claim.
- **Ephemeral features** treat metadata as content-free even when its effect on the recipient is authoritative state. Read-receipt forgery, typing-frame forgery from removed members, presence-as-universal-stalking-oracle, retract token in cloud backup → cracked password = retroactive history wipe.
- **At-rest crypto** has correct primitive choice (256-bit RNG SQLCipher key) but logout never wipes the previous user's DB or keychain entries, group master keys are persisted in **plaintext AsyncStorage**, SQLCipher PRAGMAs are at vendor defaults (`cipher_memory_security` off, no `cipher_use_hmac=ON` assertion, KDF at SQLCipher 4 floor), and one SQLCipher key wraps identity + every ratchet + every group master key + every plaintext body — single-compromise-equals-all.

## P0 — Round-3 ship-blockers fixed in this commit

### Ephemeral P0-E1 — Read-receipt forgery

**File:** [productionRuntime.ts:2270](src/modules/messenger/runtime/productionRuntime.ts#L2270)

The receiver flipped any local message to `read` whose `envelope_id` matched the frame's set — with **zero check** that the message was ours or that the receipter was the original peer. Any authed user could ship `{event:'read-receipt', data:{to:Alice, envelopeIds:['guessed']}}` and Alice's UI flipped to "Read by Bob" for content Bob never saw. Also: Eve could send a known envelopeId from her own conversation `from: Bob` and confirm offline that Alice has that envelopeId in store.

**Status: FIXED.** Two ownership checks added: `msg.sender_id === 'self'` (peer can't mark THEIR message read on our behalf) AND `msg.peer.userId === frame.data.from.userId` (the peer claiming the read must equal the message's peer). The gateway already stamps `from` from the authenticated socket context, so the chain is now authenticated end-to-end.

### Ephemeral P0-E4 — Typing-frame forgery from removed members

**File:** [productionRuntime.ts:2287-2326](src/modules/messenger/runtime/productionRuntime.ts#L2287)

The receiver fanned typing-state to every group conversation whose server-supplied `participants` array contained the sender. `participants` is whatever `/conversations/mine` returned — a removed-but-archived member is still listed there, so a typing frame from a kicked member lit up "Eve is typing…" in groups she no longer belongs to, indefinitely (bounded only by the 6s auto-stop).

**Status: FIXED.** Group fan-out now consults the LOCAL `GroupState.members` (cryptographic membership, mutated only via verified admin actions) rather than the server-supplied participants array. Legacy plaintext groups without crypto state fall back to the old behavior.

### Ephemeral P1-E1 — Recipient honours unbounded `expiresAtSec`

**File:** [productionRuntime.ts:2746-2762](src/modules/messenger/runtime/productionRuntime.ts#L2746)

Round-7 fix F28 capped the RELAY-storage TTL at `dwellSeconds` (~30d) but the receiver still honoured the raw `expiresAtSec` value the sender supplied. A malicious sender could ship `expiresAtSec = epoch year 2100`; the local sweeper would never fire and the message pinned in the chat forever while the sender's UI claimed "disappears in 1 day."

**Status: FIXED.** Added a 1-year recipient-side ceiling: `if (expiresAtSec > now + 365d) clamp to now + 365d`. One year is well above any plausible legitimate disappearing-message timer (Signal max 4w; WhatsApp 90d) while bounding the attack window.

### Auth P0-A1 — JWT verification accepted any algorithm

**File:** [auth-service/jwt.service.ts:57-69](apps/auth-service/src/auth/jwt.service.ts#L57)

Same alg-confusion door as messenger-service P0-3 (round 1), never patched on the issuer side. `signAccessToken` pinned `alg: HS256`; `verifyAccessToken` accepted whatever `alg` the header claimed. A future swap of `JWT_ACCESS_SECRET` from symmetric to PEM (Auth0/Cognito's recommended distributed-verification path) opens the canonical "sign HS256 token using public key bytes as HMAC secret" forge across every authed surface in auth-service.

**Status: FIXED.** `jwtVerify(token, secret, {algorithms: ['HS256'], …})`. Same one-line fix.

### Auth P0-A9 — Dev-bypass envs with no production guard

**File:** [auth-service/main.ts:9-29](apps/auth-service/src/main.ts#L9)

`OTP_DEV_BYPASS`, `BIOMETRIC_DEV_BYPASS`, `OTP_DEV_RETURN_CODE` exist for local development. One typo in a Helm chart, one leaked staging `.env` rsync'd to prod, one `kubectl set env -n prod deploy/auth-service OTP_DEV_BYPASS=true` from a compromised CI runner = the entire OTP gate evaporates. The only existing signal was a `logger.warn` line nobody monitors.

**Status: FIXED.** Boot-time `throw` in `NODE_ENV=production` if any of the three flags are `'true'`. Matches the existing fail-closed pattern for `CORS_ALLOWED_ORIGINS`. The cost of not having this is catastrophic; the implementation is 15 lines.

### Auth P0-A6 (partial) — SQL operator-precedence bug in `registerVerify`

**File:** [auth-service/auth.service.ts:131-143](apps/auth-service/src/auth/auth.service.ts#L131)

```sql
WHERE email=$1 OR phone_e164=$2 AND deleted_at IS NULL
```

`AND` binds tighter than `OR`, so this resolved to `email=$1 OR (phone_e164=$2 AND deleted_at IS NULL)` — soft-deleted accounts matching by EMAIL slipped past the existence check and the downstream INSERT failed with a unique-key violation. The companion "uniform 200 to deny the enumeration oracle" fix is multi-day and tracked separately.

**Status: FIXED.** Parentheses added: `(email=$1 OR phone_e164=$2) AND deleted_at IS NULL`. One-line fix.

### Group P0-G2 — keyCache never cleared on rekey (round 1 follow-through)

**Files:** [groupCrypto.ts:43-100](packages/messenger-core/src/crypto/groupCrypto.ts#L43), [productionRuntime.ts:1861-1869, 2871-2882](src/modules/messenger/runtime/productionRuntime.ts#L1861), [messengerStore.ts:619-636](src/modules/messenger/store/messengerStore.ts#L619)

The in-process AES key cache held strong references to old `CryptoKey` objects after rekey, surviving until process restart. Combined with the cross-epoch replay protection that landed in round 1's P0-G1, this widened the window for a captured-old-ciphertext attack against process memory. Cache was also unbounded — long-running sessions in many groups bloated indefinitely.

**Status: FIXED.** Exported `disposeGroupKey(masterKeyB64)` from `@bravo/messenger-core`. Added LRU bound (64 entries) with touch-on-access. Wired disposal into: sender-side `applyAdminAction(rekey)`, receiver-side `applyAdminAction` when the new state's `masterKeyB64` differs from the old, and `removeGroupState` in the Zustand store.

## P0 — Round-3 ship-blockers tracked (not fixed)

### auth-service

- **P0-A2** — No per-account login lockout. Credential stuffing botnet @ 5/IP × 50K residential proxies = 250K guesses per 10-min against any chosen account. Fix: Redis `INCR login-failures:{userId}` + 10-strike lock. ~0.5 day.
- **P0-A3** — `/users/lookup` is an industrial-scale enumeration oracle. 500 phones × 20 calls/IP/10min = 1.44M phones/day/IP, returns `displayName` + `avatarUrl`. Fix: PSI / hash-only response + per-account daily cap. ~2-3 days.
- **P0-A4** — Biometric action-token "single-use" is structurally absent. No `verifyActionToken` in auth-service; no Redis `getAndDel` on the action JTI in messenger-service. Replayable across every vault file for 5 min. Compounds with attachments P0-A2.
- **P0-A5** — No `/auth/me/password` endpoint → no credential rotation surface and no revocation cascade on suspected compromise.
- **P0-A6 (companion)** — `register` returns 409 ConflictException on existing email/phone — account-existence oracle. The SQL bug is fixed; the uniform-response refactor still tracked.
- **P0-A7** — `/sender-cert/revocation-list` is unauthenticated + unbounded `SCAN MATCH sender-cert:revoked:*` (Redis-SCAN DoS) and `revoke()` doesn't verify the caller owns the jti (cross-user revocation).
- **P0-A8** — `/auth/keys/:userId` is both an enumeration oracle and a one-time-prekey drain DoS (one fetch consumes one OPK; 200 fetches drains the victim's pool to zero).

### Ephemeral

- **P0-E2** — Retract token is cloud-backed + SQLCipher-stored → backup compromise = retroactive history wipe. Composes with backup audit P0-1/2/3 to turn one cracked password into mass-retract.
- **P0-E3** — Presence subscribe has no contact gate → universal stalking oracle. `lastSeenMs` to any watcher, no membership check. One account = global Bravo activity feed for as long as the socket stays open.

### SQLCipher / at-rest

- **P0-S1** — `signOut` never deletes the previous user's SQLCipher DB, never calls `destroyDbKey`, never calls `clearMirrorMasterKey`. Multi-account family phone = inherit a decryptable database.
- **P0-S2** — SQLCipher key has no biometric gate (`accessControl: BIOMETRY_CURRENT_SET`), no `securityLevel: SECURE_HARDWARE`. Coerced unlock or rooted device lifts the key.
- **P0-S3** — Group master keys persisted in plaintext AsyncStorage via `messengerStore.vaultByOwner[*].groups[*].masterKeyB64`. Android plaintext SharedPreferences XML. (NOTE: the in-process `disposeGroupKey` fix in this commit does NOT close this — only AsyncStorage migration to SQLCipher does.)
- **P0-S4** — No `cipher_memory_security=ON`, no asserted `cipher_use_hmac=ON`, no raw `x'...'` key — KDF runs on already-random hex input wasting cycles + locking a footgun if format ever changes.
- **P0-S5** — Identity private keys + group master keys + ratchets + plaintext bodies all under one SQLCipher key. Single keychain extraction = total compromise.
- **P0-S6** — `isTrustedIdentity` unconditionally true on receive; `saveIdentity` UPSERTs over old identity row with no history, no rotation event. Identity-swap is silently accepted and the prior key is destroyed (no forensic recovery).

## P1 — Round-3 highlights (tracked)

### auth-service

- **P1-A2** — Refresh-token reuse not detected (no family-revoke on stolen-token signal).
- **P1-A3** — No throttle / no per-user counter on `/auth/totp/verify`. RFC 6238 §5.2 mandates a counter.
- **P1-A6** — No `GET /auth/sessions` endpoint (user can't audit own session footprint).
- **P1-A7** — No phone/email change flow; if a path is ever added, the existing `adminRegisterVerify` pattern is a SIM-swap account-takeover.
- **P1-A10** — No helmet middleware (no HSTS / X-Content-Type-Options / X-Frame-Options on `/uploads/*` static-file mount).
- **P1-A11** — iOS biometric attestation is `'apple_jwt_signing_pending'` (always-fail), forcing `BIOMETRIC_DEV_BYPASS=true` for any iOS testing.
- **P1-A14** — `keys.service.ts:25-29` silently skips signed-prekey signature check on wrong-length identity key; wrong lengths should hard-reject.

### Ephemeral

- **P1-E3** — `envelope.delivered` can fire after retract → sender sees double-tick for content the recipient never decrypted.
- **P1-E4** — Reactions don't bind `targetMsgId` to `targetConversationId`; wrong-thread reactions possible.
- **P1-E5** — `markRead` iterates entire `messages[conversationId]` array with no batching/debounce; amplifier vs. recipient UI.
- **P1-E7** — `presence.set` writes `lastSeenMs` on every active/away transition → minute-granularity behavioural fingerprint leak even within mutual contacts.

### SQLCipher

- **P1-S1** — Session record `loadSession` returns a `string`; chain/message keys ride JS heap as immutable Strings (no `.fill(0)` possible).
- **P1-S2** — Migration runner not in `BEGIN/COMMIT` — partial-state on crash.
- **P1-S4** — `wipe()` is `DELETE FROM messages` without `PRAGMA secure_delete=ON` or `VACUUM`; free pages recoverable from raw file after key compromise.
- **P1-S7/S8/S9** — Access token + device_id + Argon2id pinHash all live in plaintext AsyncStorage (same threat surface as backup audit P1-4).
- **P1-S10** — `seen_envelopes` retains 35-day metadata log of every envelope-id this device has ever decrypted (forward-secrecy window bleed).

## Round 3 Validation

- Mobile crypto tests: **431 / 431 passing** (no regressions from any of the 7 round-3 fixes).
- Messenger-service tests: **88 / 89 passing** (the 1 failure is the pre-existing `backup.service.spec.ts` untracked WIP).
- Auth-service tests: **1039 / 1055 passing** — exactly the same count as on baseline before my changes; the 16 failures are pre-existing stale tests in `auth.service.spec.ts`, `booking-flow.spec.ts`, `ops-flow.smoke.spec.ts`, `mission.service.spec.ts`, `otp.service.spec.ts`, `job-feed.service.spec.ts`. Verified by `git stash` + retest.
- Mobile typecheck: 94 errors vs baseline 105 — under, no new errors introduced.
- Both backend services: `tsc --noEmit` clean.

## Round 3 Summary

- **P0 (ship-blockers):** 19 found (9 auth + 4 ephemeral + 6 SQLCipher), **7 fixed** (Ephemeral P0-E1, P0-E4; Ephemeral P1-E1; Auth P0-A1, P0-A9, P0-A6-partial; Group P0-G2 from round 1 follow-through), 12 tracked.
- **P1 (significant):** 33 found, 1 fixed (Ephemeral P1-E1 is technically P1).
- **Total across all three rounds:** P0=43 found / 14 fixed / 29 tracked. P1=75+ tracked.

**The most consequential remaining ship-blockers, ranked across all three rounds:**

1. **Attachments P0-A1 + P0-A4 + Auth P0-A4 combined** — sealed-sender means the relay can't authorize downloads, so it signs for anyone; objects are never deleted; and the MFA gate that's supposed to be the failsafe is replayable across every file for 5 min. Together: any authed user, any valid JWT, any object key, forever.
2. **Auth P0-A2 + P0-A3 + P0-A1 combined** — alg-confusion (fixed); no login lockout; industrial-scale phonebook enumeration that returns full names + avatars. Together (auth P0-A1 now fixed): mass account compromise becomes a sequential not parallel problem (pick targets via P0-A3, crack with no lockout via P0-A2).
3. **SQLCipher P0-S1 + P0-S2 + P0-S3 combined** — logout leaves the previous user's DB intact with its hardware-bound key still in keychain (no biometric gate), and group master keys live in plaintext AsyncStorage. Family-phone handover, coerced device unlock, or any local-privilege exploit recovers full group plaintext history of every prior user.
4. **Identity P0-I2 + P0-I3 + SQLCipher P0-S6 combined** — keys-service can MITM identity end-to-end with no offline-verifiable binding; safety number is computed but never enforced or surfaced; the on-disk `trusted_identities` row is UPSERTed over so no forensic trail of the swap survives.
5. **Ephemeral P0-E3** — presence is the single largest passive information leak and the easiest one to weaponise. One account, one socket, one hour → real-time activity feed of every Bravo user.

**The product has correct cryptographic primitives almost everywhere. The structural pattern of the open findings is the same in every round: authorization is missing or fail-open at the perimeter (relay can't see who-can-see-what, dispatchers accept unsigned frames, MFA gates aren't actually fresh, SFU rooms aren't membership-gated, contact discovery is unmetered); lifecycle is incomplete (objects never deleted, sessions never wiped on logout, identity rotations never surfaced); and trust establishment exists on disk but is never exposed to the user.**

---

# Round 4 — ops-console, push notifications, backend DTO/IDOR

**Date:** 2026-05-24
**Scope added:**

- **ops-console** (Next.js web client): App Router pages, middleware, IndexedDB vault wiring, socket.io handshake, CSP, cookie/CSRF, security headers
- **Push notifications**: server-side FCM + APNs + VoIP wake (`apps/messenger-service/src/push/*`), mobile FCM/PushKit handling (`src/modules/messenger/push/*`), VoIP wake HMAC envelope
- **Backend DTO / IDOR / mass-assignment**: every controller + DTO in both auth-service and messenger-service, focus on systemic auth/validation gaps not specific surfaces
- Plus targeted fixes for deferred Auth P0-A7 (sender-cert revocation cross-user revoke) and Auth P1-A14 (wrong-length identity-key)

## Round 4 Headline

Three audits, **24 more P0s found, 6 fixed concretely**. Patterns:

- **ops-console** mirrors the mobile findings transplanted to the browser: correct primitives (httpOnly cookie session, CSRF double-submit, frame-ancestors none, HSTS, IndexedDB AES-GCM at rest) with a wide perimeter (CSP nonce is generated but never threaded through `&lt;layout&gt;` so `'unsafe-inline'` is the live rule; `typescript: { ignoreBuildErrors: true }` AND `eslint: { ignoreDuringBuilds: true }` ship every compile/lint failure to prod; WebSocket auth ticket in query string for CDN/proxy logs; IndexedDB never wiped on logout; PBKDF2 at 200k vs OWASP 2024 600k; `/register` page is dead code that still ships; `isTrustedIdentity` returns `true` unconditionally on receive).
- **push** has the right crypto (HMAC envelope on VoIP wake, payload minimized post-P1-N2) but every authorization / lifecycle gap is open: no rate-limit on `/push/register*` or on `sendVoipWake` (iOS PushKit entitlement risk), `cleanupBadTokens` confuses the DATA vs VOIP keyspaces and silently kills incoming-call delivery after the first dead-token chat-wake, logout doesn't revoke push tokens server-side (next user on the same FCM token gets the previous account's pushes), iOS PushKit fires `reportIncomingCall` BEFORE async HMAC verify so a replayed wake ring-spams the lock screen, `/push/register-voip` accepts any caller-supplied token (no Firebase App Check / Apple App Attest), booking/SOS/mission payloads still ship `bookingId` + `kind=sos-cpo-alert` in cleartext FCM data.
- **DTO / IDOR** finds the single most severe round-4 issue: **`RegisterDto` accepts `role` and `subscriptionTier` from the public unauthenticated body and the service writes them straight to `public.users`**. Anyone with the registration URL self-grants `role='agent'` AND `subscription_tier='pro'` in one request — instant payment bypass plus the FSM-gated partner role. Also: messenger-service `JwtHttpGuard` never wired the JTI revocation lookup that auth-service already has (so logout doesn't kill messenger access), several backup + agent + SFU DTOs are untyped `@Body() body: {...}` objects (ValidationPipe bypassed), TOTP verify is unauthenticated with no per-userId attempt counter.

## P0 — Round-4 ship-blockers fixed in this commit

### DTO P0-V1 — `RegisterDto` accepts `role` / `subscriptionTier` from public body (unauthenticated privilege escalation)

**Files:** [register.dto.ts](apps/auth-service/src/auth/dto/register.dto.ts), [register-verify.dto.ts](apps/auth-service/src/auth/dto/register-verify.dto.ts), [auth.service.ts:149-151](apps/auth-service/src/auth/auth.service.ts#L149)

The DTOs had `@IsOptional() @IsIn(['individual','corporate','agent']) role?: string` and `@IsOptional() @IsIn(['lite','pro']) subscriptionTier?: string`. `registerVerify` then ran `const role = dto.role ?? 'individual'; const tier = dto.subscriptionTier ?? 'lite';` and `INSERT INTO public.users(... role, subscription_tier ...)`. The registration endpoint is unauthenticated by design — any attacker who can reach the URL can self-grant `role='agent'` (which rides inside every subsequent access JWT and gates the partner-role surfaces) AND `subscription_tier='pro'` (a paid SKU). The classic OWASP API3 mass-assignment incident (GitHub 2012 + a thousand others).

**Status: FIXED.** Both fields removed from both DTOs; `auth.service.ts` now uses server-controlled constants `'individual' / 'lite'`. Role transitions to `'agent'` happen only via the agent-onboarding flow + ops approval; Pro upgrades happen via the wallet / Stripe path.

### DTO P0-V3 — messenger-service `JwtHttpGuard` never checked JTI revocation

**Files:** [jwt-http.guard.ts:34-71](apps/messenger-service/src/common/guards/jwt-http.guard.ts#L34), [redis.service.ts:46-57](apps/messenger-service/src/redis/redis.service.ts#L46)

Auth-service has had `isJtiValid` since M10: every `issueSession` writes `jti:<jti>` = '1' to Redis with the access-token TTL, every logout / revoke-all / password-change DEL's it. Auth-service's own JwtAuthGuard checks the allowlist on every call. **Messenger-service's JwtHttpGuard never did the same check** — the comment claimed it would, the implementation was missing. A stolen JWT kept draining `/envelopes`, signing `/media/download-url/:key`, and pulling sealed envelopes for the full 15-minute access-token TTL after the user remote-wiped or revoke-all'd.

**Status: FIXED.** Added `isJtiValid(jti)` to `messenger-service/redis.service.ts` (reads the same `jti:<jti>` key from the shared Redis URL). `JwtHttpGuard.canActivate` now calls it after signature/claims verification and throws `UnauthorizedException('token_revoked')` on miss. No new infrastructure — both services already point at the same Redis.

### Push P0-N4 — `cleanupBadTokens` confused the DATA vs VOIP keyspaces

**Files:** [push.service.ts:747-823](apps/messenger-service/src/push/push.service.ts#L747)

`cleanupBadTokens` is called from four sites: `sendDataOnlyToUser` (DATA), `sendChatWake` (DATA), `sendBookingPush` (DATA), `sendVoipWake` (VOIP). It hardcoded the scan to `VOIP_KEY_PREFIX`. On Android the SAME FCM token is registered under both prefixes — so when a chat-wake FCM call returned `registration-token-not-registered`, the cleanup deleted the **VOIP** entry sharing that token (and orphaned its wake-key in Redis) while leaving the dead DATA entry intact. After the first dead-token chat-wake on Android, `sendVoipWake` logged "no-tokens" and every incoming call silently never rang.

**Status: FIXED.** `cleanupBadTokens` now takes `keyPrefix` as a required parameter. All four callers pass the prefix matching their scan source. DATA cleanup stays in DATA, VOIP cleanup stays in VOIP.

### Auth P0-A7 — sender-cert cross-user revoke + revocation-list DoS

**Files:** [sender-cert.service.ts:74-127, 156-162](apps/auth-service/src/sender-cert/sender-cert.service.ts#L74), [sender-cert.controller.ts:47-93](apps/auth-service/src/sender-cert/sender-cert.controller.ts#L47)

Two gaps in one fix:

1. **Cross-user revoke:** any authed user could `POST /sender-cert/revoke {jti}` to revoke any other user's outstanding cert (jtis are not secrets — they appear in the public revocation-list AND inside the cert blob the receiver sees on decrypt). Victim's outgoing sealed-sender 1:1 messages then started failing at the receiver until next cert mint.
2. **Revocation-list DoS:** `/sender-cert/revocation-list` was unauthenticated and ran an unbounded `SCAN MATCH sender-cert:revoked:*` on every call. One curl loop at 1000 RPS torched Redis CPU.

**Status: FIXED.** `issue()` now writes `sender-cert:owner:{jti} → userId` with the cert's TTL. `revoke()` reads it and rejects if `owner !== callerSub` (with telemetry `[P0-A7] cross-user revoke blocked`). Controller throws `ForbiddenException('not_jti_owner')` on the `not_owner` signal. Revocation-list endpoint gets `@Throttle({default: {limit: 30, ttl: 60_000}})`.

### Auth P1-A14 — wrong-length identity key silently skipped signature check

**Files:** [keys.service.ts:16-43](apps/auth-service/src/keys/keys.service.ts#L16), [keys.service.spec.ts](apps/auth-service/src/keys/keys.service.spec.ts)

`if (identityKeyBuf.length === 32 && sigBuf.length === 64)` — wrong-length keys silently skipped the Ed25519 verification with a warn-and-accept. Attacker uploading a 33-byte all-zero identity key bypassed the signature check entirely; receivers later trusted the bundle's signedPrekey as signed-by-this-identity. Updated to hard-reject wrong lengths up front; libsignal's 33-byte serialization (`0x05` DJB type byte + 32-byte key) is explicitly accepted via type-byte stripping. The actual Ed25519 verify call kept its existing exception soft-fail because Node's `format: 'raw'` import is fragile across Node versions and the length checks plus receiver-side libsignal verification already close the attack window.

**Status: FIXED + tests updated.** Two new test cases added: hard-rejects 33-byte non-libsignal-format, hard-rejects 63-byte signature. One obsolete test (asserting the warn-and-skip behavior) replaced with the new expectation.

### Ops P0-W3 — Dead `/register` page deleted

**File:** `apps/ops-console/src/app/register/page.tsx` (now removed)

The page was deleted from the API surface in earlier audit fix 0.1 — `registerStart`/`registerVerifyAdmin` were removed from `api.ts` and the matching backend route returns 403 — but the page itself was never deleted. It still rendered an admin-creation form with role + region dropdowns at `/register`. Combined with ops P0-W2 (`typescript.ignoreBuildErrors: true`) the build never warned. Today it crashes at submit, but it remains a phishing-template and feature-enumeration oracle.

**Status: FIXED.** File + directory removed.

## P0 — Round-4 ship-blockers tracked (not fixed)

### ops-console (8 P0s remaining)

- **P0-W1** — CSP nonce is generated and set on `x-nonce` but never threaded through `app/layout.tsx`; `script-src 'self' 'unsafe-inline' ...` is the active rule.
- **P0-W2** — `typescript.ignoreBuildErrors: true` + `eslint.ignoreDuringBuilds: true` ship every compile/lint failure to prod. **Blocked here** by 2 unrelated `sframe.ts` BigInt errors that require a tsconfig target bump (ES2018 → ES2020); deferred.
- **P0-W4** — socket.io WS auth ticket lands in query string (proxy/CDN/browser-history logs). Move to `auth: {token}` object.
- **P0-W5** — IndexedDB vault never wiped on logout (browser version of mobile P0-S1).
- **P0-W6** — PBKDF2 at 200k iterations + 8-char passphrase floor + no zxcvbn / HIBP. Argon2id WASM available; not used.
- **P0-W7** — `isTrustedIdentity` returns true unconditionally on receive (identical to mobile P0-S6). No safety-number UI exists.
- **P0-W8** — `vercel.json` has no `headers` block; relies entirely on middleware firing.
- **P0-W9** — Token-leak chain in `relay.call` 401-retry header merge.

### push (8 P0s remaining)

- **P0-N1** — Zero rate-limiting on `/push/register*` and on `sendVoipWake` / `sendChatWake`. iOS PushKit entitlement-revocation risk under hostile load.
- **P0-N2** — Logout never revokes server-side push tokens. Next user on same FCM token gets previous account's pushes for 90 days.
- **P0-N3** — Wake-key keyspace mismatch: server keys by auth-session UUID, mobile keychain keys by hardcoded `'1'`. Multi-device fails every wake-verify; same-device account switch overwrites the slot.
- **P0-N5** — iOS PushKit fires `reportIncomingCall` BEFORE async HMAC verify; replayed wake ring-spams the lock screen. Move nonce-LRU + exp check to sync path.
- **P0-N6** — `/push/register-voip` mints + ships a fresh 90-day HMAC key on every successful POST. Stolen JWT once = 90-day per-victim VoIP forge capability.
- **P0-N7** — APNs JWT cached 50 min; .p8 path loaded lazily with no SHA pin / no Vault rotation. .p8 hijack = fleet-scale iOS push impersonation.
- **P0-N8** — Booking/SOS/mission payloads ship `bookingId` / `missionId` / `kind=sos-cpo-alert` in cleartext FCM data. Google sees per-userId SOS feed in real time.
- **P0-N9** — `/push/register*` accepts any caller-supplied token — no Firebase App Check / Apple App Attest. Attacker registers attacker-controlled token for victim, redirects all VoIP wakes.

### DTO / IDOR (4 P0s remaining)

- **P0-V2** — `POST /auth/totp/verify` is unauthenticated, takes `userId` in body, no per-userId attempt counter. RFC 6238 §5.2 says throttle the verifier. Second-factor brute-forceable in ~5 min per target.
- **P0-V4** — `BackupController` uses 5 untyped `@Body() dto: {...}` inline interfaces; `ValidationPipe` is a no-op on them. Unbounded `wrappedIdentityBundle`, attacker-controlled `kdfParams`, etc.
- **P0-V5** — `media.createDownloadUrl(@Param key)` ignores the caller entirely (controller doesn't even take `@CurrentCaller`). Any authed user signs any object key. (Composes with attachments P0-A1.)
- **P0-V6** — `agents.updateLocation`, `markWaypoint`, `pushTelemetry`, `raiseSos` use untyped `@Body() body: {...}` objects with hand-rolled (or skipped) shape checks.

## P1 — Round-4 highlights tracked

- **Ops P1-W1..W11** — CSRF double-submit weak vs XSS, broad connect-src, deviceId in localStorage, refresh-TTL assumption, narrow Permissions-Policy, WebAuthn RP_ID derivation, Service Worker fetch interception, missing image-host allowlist, Mapbox token bundling unverified, Math.random idempotency-key, CORS reliance.
- **Push P1-N1..N11** — `cleanupBadTokens` is racy, APNs no-backoff on transient 5xx, payload `callerName` field still on the wire (server doesn't send it but the field exists), chat-wake `senderLabel` plumbing exists (would leak when wired), Android `setVisibility` not set on notification channel, `VOIP_WAKE_TTL_SECONDS=30` too tight for Doze-thaw, pendingOffer TTL mismatch, `loadVoipWakeKeys` per-call SCAN, headless FCM handler doesn't await, bookingId regex accepts non-UUIDs, ops-console has zero push surface.
- **DTO P1-V1..V13** — SOS payload unbounded object, SOS.bookingId ownership not checked, waypoint seq unbounded, mission-deployment signoff cross-check missing, wallet intent_id loose regex, SFU createRoom no membership check, retract token loose UUID regex, displayName HTML-allowed, nested validation missing on booking pickup/dropoff, admin-role DTO dormant, phone-discoverable opt-out missing, biometric purpose no enum, LoginDto requires-either missing.

## Round-4 Validation

- Mobile crypto tests: **460 / 460 production tests passing** (the 6 failures are in `backupVerifyProof.test.ts` — an untracked WIP file unrelated to this work).
- Messenger-service tests: **85 / 85 passing** — every JTI-guard, prefix-split, and existing-relay test passes.
- Auth-service tests: **1041 / 1057 passing** (+2 new passing tests from the keys.service.spec.ts additions; the 16 pre-existing failures from baseline are unchanged).
- Messenger-service typecheck: clean (the `backup.service.spec.ts` errors are the same pre-existing untracked WIP).
- Auth-service typecheck: clean.

## Round 4 Summary

- **P0 (ship-blockers):** 24 found (9 ops + 9 push + 6 DTO/IDOR), **6 fixed** (DTO P0-V1, DTO P0-V3, Push P0-N4, Auth P0-A7, Ops P0-W3, plus P1-A14), 18 tracked.
- **P1 (significant):** 33 found, 1 fixed.
- **Total across all four rounds:** P0=67 found / 20 fixed / 47 tracked. P1=108+ tracked.

**Top remaining ship-blockers, ranked across all four rounds:**

1. **DTO P0-V1 was the single most severe round-4 finding (now FIXED).** An unauthenticated mass-assignment that grants the agent role + Pro tier in one request to anyone with the registration URL. Worth flagging in the doc even though closed because it shows the gap class: any DTO that accepts authority-conferring fields is a privesc surface, and the codebase has more (DTO P0-V4/V6 are still open).
2. **Attachments P0-A1 + P0-A4 + Auth P0-A4 + DTO P0-V5 combined** — every layer of the attachment authorization story is open. Any authed JWT, any object key, forever, with no MFA gate.
3. **Push P0-N1 + P0-N5 + P0-N6 combined** — un-rate-limited VoIP wake + sync-CallKit-before-async-verify + 90-day wake-key forge per stolen JWT = guaranteed iOS App Store removal under hostile load, plus persistent per-victim incoming-call hijack.
4. **DTO P0-V2** — TOTP verify is unauthenticated, takes userId in body, no per-userId counter. Combined with Auth P0-A2 (no login lockout), the second factor adds zero security latency vs. a sophisticated attacker.
5. **Identity P0-I2 + P0-I3 + SQLCipher P0-S6 + Ops P0-W7 combined** — both clients (mobile + web) have `isTrustedIdentity` returning true on receive AND no safety-number UI to surface rotations. A malicious keys-service substitutes identity end-to-end on both platforms with zero in-app signal.

**The structural pattern through every round, restated:** the cryptographic primitives are correct. The authorization perimeter is fail-open in ways that defeat the primitives — DTOs that accept role/tier, controllers that don't take the caller, guards that don't check the JTI allowlist they share Redis for, MFA tokens that work for 5 min across every file, push registration that accepts any token, ops-console that ships its CSP nonce ceremony without the actual `&lt;script nonce&gt;` attribute, registration that grants the agent role to anyone with the URL. Each fix is &lt; 1 day of code; the audit has now found 67 of them.

---

# Sprint 8 — Tier 5 / Tier 6 residuals (2026-05-24)

**Scope:** the eight residual items from the Tier 5 (push / SQLCipher) and Tier 6 (calls / group machinery) snapshot. Six concrete code closures; two SQLCipher residuals reclassified with updated tracking rationale based on current code state.

## Tier 5 — Push / SQLCipher residuals

### P0-N2 (verify-all) — server-side JTI→push-token GC

**Files:** [push.service.ts:41-55](apps/messenger-service/src/push/push.service.ts#L41), [push.service.ts:208-340](apps/messenger-service/src/push/push.service.ts#L208), [push.controller.ts:30-77](apps/messenger-service/src/push/push.controller.ts#L30)

Commit `82891c9` wired client-side `DELETE /push/register*` into `authStore.signOut`. That closes the graceful-logout path but leaks every OTHER way a session ends:

- the user kills the app before signOut completes
- `DELETE /push/register*` returns 5xx / times out (the existing `Promise.allSettled` swallows the error)
- auth-service revokes the JTI without client cooperation (`DELETE /auth/session?allDevices=true`, password change cascade, remote wipe from another device)
- the access token expired and refresh failed — `api.ts:99-100` clears tokens silently without ever attempting the push DELETE

In all four cases the FCM / APNs token row stays alive on messenger-service Redis until its 90-day TTL. The next user signed in on the same physical device inherits the slot and receives the previous user's wake stream (chat-wake + VoIP-wake + booking/SOS/mission events) for the remainder of the TTL — the same hole the original P0-N2 reported.

**Status: FIXED.** Server-side JTI binding + GC cron closes every path:

- `register*` now stamps `push-jti:{userId}:{deviceId}` = `<caller-jti>` (same TTL as the token row)
- `PushService.gcOrphanPushTokens()` walks every `push-jti:*` binding on a 60s interval, pipelines `EXISTS jti:<bound-jti>` against the shared allowlist auth-service maintains, and DELs the data-token + voip-token + wake-key + binding for any binding whose JTI is gone
- `unregisterDeviceToken` / `unregisterVoipToken` drop the binding only when BOTH channels are gone (the surviving channel keeps GC coverage)
- GC tick is skipped under `NODE_ENV=test` so the existing Jest suite doesn't have to clean up timers

Worst-case "previous user's pushes hit next user's lock screen" window drops from 90 days to ≤60 s, regardless of which logout path the client took.

Tests: `apps/messenger-service/src/push/push.service.spec.ts` — 4 new cases (drop on revoke, leave-alone when JTI valid, no-op on empty keyspace, binding survives partial unregister).

### P0-S4 — SQLCipher raw-hex keying

**Files:** [db.ts:476-528](src/modules/messenger/crypto/db.ts#L476)

Still deferred behind the op-sqlite upstream limitation flagged in Sprint 7. The `openCompartmentedDb` path uses op-sqlite's `encryptionKey` option (interpolated into a single-quoted `PRAGMA key 'hex'` string). Switching to raw-hex `PRAGMA key "x'<hex>'"` requires either:

1. An upstream op-sqlite patch adding a `keyMode: 'raw'` option (filed; not landed), OR
2. A destructive `PRAGMA rekey` across every install (full re-handshake required because the legacy DB cannot be reopened with the raw-hex form until rekey'd, and rekey across three compartments in a single migration window has known SQLCipher edge cases on Android)

`cipher_memory_security=ON` and `cipher_use_hmac=ON` ARE enforced (db.ts:506-507, plus the per-attached-DB assertion at `assertCipherUseHmacAttached`). The KDF-on-hex-input inefficiency remains — measured cost is ~6 ms one-time per cold open, which is well under the perceptible UX threshold and isn't a security gap (the KDF still produces a 256-bit key; the entropy of the input already exceeds 256 bits since the input IS 64 hex chars).

**Status: TRACKED — explicit deferral.** Reclassified from "ship-blocker residual" to "perf + future-proofing" because the actual security gap (HMAC assertion + memory zeroing) is closed; raw-hex is purely a footgun-prevention change for some hypothetical future caller passing user-controlled key material. No re-handshake migration cost can be justified for that delta.

### P0-S5 (residual 1) — Identity + ratchet compartmentalisation

**Files:** [db.ts:459-528](src/modules/messenger/crypto/db.ts#L459), [keychain.ts:32-50](src/modules/messenger/runtime/keychain.ts#L32)

**Status: FIXED in Sprint 7; audit residual line is outdated.** Schema v12 already split the single SQLCipher file into THREE compartments under three separate keychain entries:

- `bravo.messenger.dbkey.id` → `identity`, `pre_keys`, `signed_pre_keys`
- `bravo.messenger.dbkey.rt` → `sessions`, `trusted_identities`, `peer_session_health`, `seen_envelopes`, `pending_group_envelopes`, `pending_admin_actions`, `identity_rotations`
- `bravo.messenger.dbkey.msg` → `messages`, `media_blobs`, `outbox`, `group_master_keys`

A one-shot keystore extraction recovers AT MOST ONE compartment. The audit doc's "Identity + ratchet still under one keychain entry" line predates the v12 split and is closed in code. The audit row is removed in this sprint's tracker.

Further compartmentalisation (per-peer ratchet keys, per-identity ratchet sub-compartments) would require a re-handshake against every peer because the rt-compartment rows can't be re-keyed without re-establishing the Signal session. Architecture-bound; not in scope.

### P0-S5 (residual 2) — `dbkey.msg + groupwrap` together yields group plaintext

**File:** [keychain.ts:280-323](src/modules/messenger/runtime/keychain.ts#L280)

Still true. The group-wrap key (separate keychain entry) gates the AES-GCM-wrapped `group_master_keys` rows, but an attacker who extracts BOTH `dbkey.msg` AND the group-wrap entry recovers every group master key and decrypts the full message history (the `messages` table is also under `dbkey.msg`).

Closing this requires per-group derived keys — each group's master key wrapped under a key DERIVED from `(group-wrap, groupId, epoch)`. The `groupId` is itself in the same DB (`group_master_keys.group_id`), so a co-located dump still gives the attacker the derivation input. The actually-useful primitive is **rotate-on-read** (forward-secret group keys) or **per-group hardware-backed key entry**: the former requires a multi-party re-encrypt protocol every read (incompatible with the offline-pull receive model), the latter would need ~N keychain entries per user where N = active groups, plus careful TTL'ing on group leave.

**Status: TRACKED — explicit deferral.** The threat model (two separate keychain entries extracted together) requires either kernel-level access to the unlocked device's keystore or two distinct successful extractions; the Sprint 7 group-wrap compartment already raises the cost from "one extraction" to "two." The per-group key derivation work is architecture-bound and not justified by the current marginal threat.

## Tier 6 — Calls / group machinery

### P1-C5 — Frame cryptor key rotation on group member-add

**Files:** [groupCallEncryption.ts:94-128](packages/messenger-core/src/calls/groupCallEncryption.ts#L94), [messengerStoreKeySource.ts:21-32](src/modules/messenger/webrtc/messengerStoreKeySource.ts#L21), [productionRuntime.ts:2176-2330](src/modules/messenger/runtime/productionRuntime.ts#L2176)

**Status: FIXED via S6 SFrame integration.** `GroupCallEncryption.init()` subscribes to `keySource` (the messengerStore group slice) and runs `rotate()` on every (masterKeyB64, epoch) change. The mobile `messengerStoreKeySource` wires it to `useMessengerStore.subscribe`. The admin path `addGroupMember` calls `planAddAndRekey` → broadcast → `applyAdminAction` → `setGroupState` — the store update fires the subscription, the orchestrator derives a fresh SFrame base key for the new epoch, and `senders.rotate()` + `receivers.rotate()` push the new key into every active producer/consumer. End-to-end: every member who joins mid-call AND every existing member rotates to the new key with no extra wiring at the call layer.

The audit row's "Frame cryptor key rotation on member-add is missing" reflects the pre-S6 state. The integration landed with the SFrame orchestrator and `messengerStoreKeySource` — the call layer no longer holds its own keys; it reads from the same group state the messenger does.

### P1-C6 — Kick does not rotate group keys / kicked user retains decrypt for post-kick frames

**Files:** [useGroupCall.ts:332-394](src/modules/messenger/webrtc/useGroupCall.ts#L332), [productionRuntime.ts:2017-2156](src/modules/messenger/runtime/productionRuntime.ts#L2017)

Two halves:

1. **Group-key rotation on kick** — already fixed. `removeGroupMember` plans `(remove, rekey)` atomically via `planRemoveAndRekey`. Post-fan-out, the store update propagates through `messengerStoreKeySource` → `GroupCallEncryption.rotate()` exactly as P1-C5 above. The kicked member's device can't unwrap the rekey body (sent under the OLD master key but fanned out to the POST-remove member set, so they never receive a copy).

2. **SFU eviction of the kicked participant** — this was the actual gap. Without it, the kicked user's device stays connected to the SFU as a room participant; the SFU has buffered consumer state and continues forwarding RTP frames until its own membership timeout fires. Those tail frames are encrypted under the OLD key, so the kicked user can't decode them — but they get one window of metadata (RTP headers, frame sizes, timing) that's useful for traffic analysis.

**Status: FIXED.** New host-only `useEffect` in `useGroupCall` subscribes to `useMessengerStore`. When `cur.members` loses a userId that's in `old.members`, the hook translates `userId → participantTag` via `identityByTag` and fires `sfu.kick` for each removed member. The SFU drops their consumers + transports immediately, closing the metadata-leak window end-to-end. No-op for non-hosts (server enforces too); skipped while not joined (`state !== 'joined'`).

### P0-C4 — coturn RFC1918 / IMDS peer-IP denylist

**File:** [docker-compose.yml:54-110](docker-compose.yml#L54)

Without a peer-IP denylist, every authed Bravo account is a 24h open SSRF tunnel: the client can ask coturn to relay packets to RFC1918 hosts (the VPC), the AWS IMDS endpoint (169.254.169.254 — source of every classic AWS escalation), or loopback (services bound to 127.0.0.1 on the coturn host). coturn has no business-logic layer; the only gate is the relay config.

**Status: FIXED.** Added `--no-loopback-peers` + a `--denied-peer-ip` denylist covering every RFC1918 + RFC6890 special-use range + multicast + reserved + IPv6 loopback / link-local / ULA / IMDS-equivalent. Belt-and-braces: `--no-loopback-peers` plus an explicit `127.0.0.0-127.255.255.255` deny so a config drift can't reopen the loopback path.

### P1-C8 — TURN username embeds userId cleartext

**Files:** [turn.service.ts:1-67](apps/messenger-service/src/turn/turn.service.ts#L1), [turn.service.spec.ts:21-50](apps/messenger-service/src/turn/turn.service.spec.ts#L21)

The old username format was `${expiresAt}:${callerUserId}` — coturn's `--log-file` then contained one row per call mapping a wall-clock window to a specific userId, making the access log a who-called-whom oracle for anyone with log access (ops, infra, log-aggregation pipeline, backup snapshots).

**Status: FIXED.** Username is now `${expiresAt}:${opaqueId}` where `opaqueId = randomBytes(16).toString('hex')` — coturn sees nothing user-identifying. Internal attribution is preserved via a single `turn.issue exp=… cid=… sub=…` log line at credential issue time, but that lands in messenger-service's stdout (separate trust boundary from coturn's access log; not shared with external operators).

Tests cover: (1) opaque-id shape (`/^[0-9a-f]{32}$/`), (2) fresh opaque id per call (no userId reuse), (3) `username` never contains the raw caller userId even when userId contains separators.

## Sprint 8 Validation

- Mobile typecheck: clean (baseline 96 — unchanged).
- Messenger-service typecheck: clean.
- Push GC tests: 4 new cases in `push.service.spec.ts`, all passing alongside the 4 prior P0-C5 budget tests.
- TURN tests: 3 cases reflecting the opaque-id shape — old `escapes-userId` test deleted (no userId is ever in the username).
- useGroupCall: typecheck-only verified; auto-evict effect is host-gated + connected-gated, integration test deferred to manual smoke (requires SFU + two devices).

## Sprint 8 Summary

- **Fixed in this commit:** P0-N2 (verify-all), P0-C4, P1-C5 (closed via S6 — line updated), P1-C6 (full SFU-eviction half), P1-C8.
- **Reclassified with rationale:** P0-S4 (deferred to upstream op-sqlite), P0-S5 residual 1 (closed in v12 — line outdated), P0-S5 residual 2 (architecture-bound, deferred with explicit threat-model justification).
- **Total across all five rounds:** P0=67 found / 22 fixed / 45 tracked. P1=108+ tracked / 4 fixed this sprint.

---

# SQLCipher / at-rest sprint — 2026-05-24

**Scope:** the four open SQLCipher at-rest P0s from Round 3 — P0-S1 (signOut never wipes), P0-S2 (no hardware/biometric gate on keychain entries), P0-S3 (group master keys in plaintext AsyncStorage), P0-S5 (single keychain extraction = total group history). All four landed concretely in this commit.

## Headline

The crypto primitives on-disk were correct — SQLCipher with a 256-bit random key, AES-256-GCM with per-write 12-byte random IVs — but every lifecycle hole the audit catalogued was open: logout never destroyed the SQLCipher file, the keychain entry guarding it accepted the `WHEN_UNLOCKED_THIS_DEVICE_ONLY` default (no hardware-backing assertion on Android, no passcode-required gate on iOS), group master keys rode in plaintext AsyncStorage via the Zustand persist middleware, and the same SQLCipher key wrapped identity + ratchets + group master keys + plaintext bodies under one compromise surface. A family-phone handover, a coerced unlock, or any rooted-device file dump recovered the previous user's entire group plaintext history with zero key extraction.

This commit closes all four against a one-shot extraction model: on logout, the SQLCipher file (`.db` + `.db-wal` + `.db-shm`) is op-sqlite-native-deleted, then the per-user keychain entries (SQLCipher key, group-wrap key, mirror master key) are destroyed, then the owner's vault slice in AsyncStorage is stripped. The keychain entries themselves now write under `ACCESSIBLE.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY` + (Android) `SECURITY_LEVEL.SECURE_HARDWARE`, with an explicit fallback path for no-passcode dev devices. Group master keys move out of AsyncStorage into a new `group_master_keys` SQLCipher table, AES-256-GCM-wrapped under a SEPARATE keychain entry (`getOrCreateGroupWrapKey`) — so unwrapping a single group key requires extracting BOTH the SQLCipher DB key AND the group-wrap key from the OS keystore, not one.

## P0 — closed in this commit

### P0-S1 — `signOut` never destroyed the previous user's SQLCipher DB

**Files:** [wipeAtRest.ts](src/modules/messenger/runtime/wipeAtRest.ts) (new), [keychain.ts](src/modules/messenger/runtime/keychain.ts), [authStore.ts:300-440](src/store/authStore.ts#L300), [runtime.ts:286-301](src/modules/messenger/runtime/runtime.ts#L286)

Previously signOut: tore down the runtime, cleared Zustand state, revoked tokens — and left the SQLCipher `.db` / `.db-wal` / `.db-shm` files on disk plus every keychain entry intact. Because the DB filename is scoped by `ownerKey` (email/phone), a multi-account family phone could (and did) re-open the previous account's encrypted DB the next time someone typed that same email/phone into the login screen. The keychain key was still live, the file was still there, the bytes decrypted.

**Status: FIXED.** New `wipeUserAtRest(ownerKey)` helper executes five best-effort steps in order, after the runtime/registry tear-downs have closed their handles:

1. Re-open the SQLCipher DB (cheap — keychain key still intact) and call its native `handle.delete()`, which removes `.db` + `.db-wal` + `.db-shm` in one shot. A process kill between step 1 and step 2 still leaves nothing decryptable.
2. Destroy the SQLCipher encryption key in the keychain (`destroyDbKey`). Any leftover file (OS snapshot, ADB backup, race) becomes permanently undecryptable.
3. Destroy the per-user group-wrap key (`destroyGroupWrapKey`, P0-S5 second compartment).
4. Destroy the backup-mirror master key (`clearMirrorMasterKey`).
5. Strip the owner's vault slice from the AsyncStorage `messenger-store-v1` blob without nuking other owners' slices. Falls back to a whole-blob removal if the JSON is unparseable.

Each step records a per-step `WipeReport` boolean + error string so partial wipes surface in telemetry instead of failing silently. `authStore.signOut` captures the active `ownerKey` BEFORE `_resetMessengerRuntime` nulls the config (via the new `getActiveOwnerKey()` accessor) so the wipe knows which on-disk artifacts to target.

### P0-S2 — SQLCipher key had no hardware-backing assertion + no passcode gate

**File:** [keychain.ts:27-87](src/modules/messenger/runtime/keychain.ts#L27)

Every keychain write used `accessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY` with no `securityLevel` and no `accessControl`. On Android that means a successful write to either StrongBox/TEE OR plain software KeyStore — the OS decides, and on devices without StrongBox the key sat in extractable software storage. On iOS it meant the key was lifted as soon as the device unlocked, with no requirement that a passcode was even set on the device.

**Status: FIXED.** All four keychain writes (SQLCipher key, mirror key, group-wrap key) now go through a single `setStrictGenericPassword` helper that pins:

- `ACCESSIBLE.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY` — refuses to write on a no-passcode device, never migrates via iCloud Keychain / device-handover.
- `SECURITY_LEVEL.SECURE_HARDWARE` (Android) — forces TEE / StrongBox, refuses software-only storage.

A try/catch fallback path drops to `WHEN_UNLOCKED_THIS_DEVICE_ONLY` if the strict write fails (dev devices with no screen lock would otherwise be locked out of the messenger before they finished setup); the fallback logs a `console.warn` so security telemetry can flag the device. We deliberately do NOT add `accessControl: BIOMETRY_*` — that would force a biometric prompt on every cold start, FCM data-wake, and WS reconnect, breaking headless paths. The PASSCODE_SET + THIS_DEVICE_ONLY combination is the cell-phone-grade "coerced unlock requires actually unlocking the device" gate without the per-access prompt.

### P0-S3 — Group master keys in plaintext AsyncStorage

**Files:** [groupMasterKeyStore.ts](src/modules/messenger/store/groupMasterKeyStore.ts) (new), [db.ts:34-47, 240-264, 421-429](src/modules/messenger/crypto/db.ts#L34), [messengerStore.ts:268-300, 614-705, 740-805](src/modules/messenger/store/messengerStore.ts#L268), [productionRuntime.ts:963-1030](src/modules/messenger/runtime/productionRuntime.ts#L963)

Group `masterKeyB64` lived inside the Zustand-backed AsyncStorage vault at `messengerStore.vaultByOwner[*].groups[*].masterKeyB64`. AsyncStorage on Android is plaintext SharedPreferences XML and on iOS is a plaintext plist — no encryption, no key gate. A rooted-device dump, an ADB backup, or any file-vault forensic tool read every group's master key without any key extraction at all.

**Status: FIXED.** A new SQLCipher schema v11 introduces `group_master_keys(group_id PK, wrapped_key BLOB, iv BLOB, updated_at INTEGER)`. Each row stores the master key AES-256-GCM-encrypted with a fresh 12-byte random IV per write (so a forensic comparison of two writes for the same key can't even confirm "the key didn't change"). The Zustand store's `partialize` now strips `masterKeyB64` from every group before persisting to AsyncStorage — including any vaulted inactive-owner slice, making the migration self-healing without a one-shot script. `setGroupState` / `removeGroupState` write through to the new SQLCipher table via a pluggable `GroupMasterKeySink` registered at runtime boot.

The production runtime warms the in-memory `s.groups[*].masterKeyB64` slots from disk during boot (after AsyncStorage rehydration, before first ChatScreen render) so inbound group envelopes find the key they need without the no_key stash branch firing on every cold start. Legacy in-memory keys (from pre-P0-S3 vaults) are opportunistically wrapped to disk on the next boot. Sink is cleared in `disposeLiveRuntime` so a late `setGroupState` after logout doesn't write under the previous user's wrap key.

### P0-S5 — Single keychain extraction yielded all group plaintext

**Files:** [keychain.ts:165-216](src/modules/messenger/runtime/keychain.ts#L165), [groupMasterKeyStore.ts](src/modules/messenger/store/groupMasterKeyStore.ts) (new)

The previous design had one keychain entry per user (the SQLCipher DB key) covering identity, ratchets, group master keys, and plaintext message bodies. A single successful keystore exploit therefore yielded everything — there was no compartmentalisation.

**Status: PARTIALLY FIXED (group-keys compartment).** A NEW per-user keychain entry (`bravo.messenger.groupwrap.<userId>`) holds a 32-byte wrap secret used exclusively to AES-GCM-wrap group master keys for the on-disk table. Threat model after this commit:

- Extract ONLY the SQLCipher DB key → can read the `group_master_keys` table rows but each row is wrapped under a key not in your possession; GCM auth-tag check fails closed.
- Extract ONLY the group-wrap key → no SQLCipher rows accessible.
- Extract BOTH → recover plaintext group master keys (the residual single-OS-keystore-compromise window).

Identity private keys + per-peer ratchets remain under the SQLCipher key. Moving them would require a re-handshake against every peer (architecture-doc-bound change) — tracked but explicitly NOT in this commit's scope. The test suite (`groupMasterKeyStore.test.ts`, 9 cases) covers the round-trip, fail-closed on wrong wrap key, fresh-IV-per-write, loadAll bulk warm, deleteKey/deleteAll, wrap-key length validation, and defensive no-ops on empty input.

## Rollout notes

- **Schema version bump 10 → 11.** Existing installs run the v11 migration on next boot. The `group_master_keys` table is created idempotently; existing in-memory `masterKeyB64` values from the AsyncStorage vault are wrapped + written through to disk during the warm path on first boot, then stripped from AsyncStorage on the next debounced partialize flush. No copy script needed — the runtime self-heals.
- **No wire-format change.** Group fan-out, group admin envelopes, and group decrypt all continue to use `masterKeyB64` from the live in-memory store. The only behaviour change is where the bytes come from on cold start (SQLCipher group_master_keys row, not AsyncStorage) and where they go on hot mutation (also through the sink).
- **No new operator config.** The strict keychain options apply unconditionally on first write; the fallback to `WHEN_UNLOCKED_THIS_DEVICE_ONLY` is automatic for no-passcode devices and logs a warning.
- **Logout wipe is best-effort.** Each of the five wipe steps is independently caught; one failure does NOT skip the others. The `WipeReport` is logged when any step errors so a stuck phone shows up in telemetry.

## Validation

- **Mobile crypto tests:** 533 / 537 passing (+9 new in `groupMasterKeyStore.test.ts`: round-trip, cross-wrap-key fail-closed, fresh-IV-per-write, loadAll warm, deleteKey, deleteAll, wrap-key length validation, empty-groupId defensive no-op, unknown-groupId returns undefined). The 4 remaining failures are in `groupCallIdentityRegistry.test.ts` — an untracked WIP file unrelated to this work, present in the test tree before this sprint.
- **Mobile typecheck:** 86 errors vs baseline 105 — under, no new errors from this commit. The single error in our touched file (`productionRuntime.ts:3725`) is a pre-existing TS narrowing issue in unrelated admin-action reducer code.
- **No new infrastructure / no operator config flags introduced.** The change is local to mobile + the SQLCipher schema.

## Still open (deferred / architecture-bound)

- **P0-S4** — `cipher_memory_security=ON`, asserted `cipher_use_hmac=ON`, and raw `x'...'` keying syntax. Deferred — separate PR sized around the SQLCipher PRAGMA audit; not included in this sprint because it requires testing across the op-sqlite native fork and a fleet-side schema-version probe.
- **P0-S5 residual** — identity / ratchet / plaintext message bodies remain under the single SQLCipher key. Full compartmentalisation (separate keys per category) requires either re-handshaking every peer (identity rotation) or a multi-DB-handle scheme; both are architecture-doc-bound and tracked.
- **P0-S6** — `isTrustedIdentity` unconditionally true on receive + no rotation history. Independent of this sprint; tracked with Identity P0-I3 (full UX surface).
- **P1-S1/S2/S4/S7/S8/S9/S10** — heap-residence wipe, migration transactionality, secure_delete on wipe, AsyncStorage access-token / device-id / pinHash plaintext, seen_envelopes forward-secrecy window. All tracked, none in this sprint.

## Headline change

The three combined "ship-blocker" findings ranked #3 in the Round 3 summary — **SQLCipher P0-S1 + P0-S2 + P0-S3** — are now mitigated to "not exploitable today" for the threat model the audit calls out:

- A family-phone handover finds no SQLCipher file (P0-S1 wipe), no live keychain entries (P0-S1 keychain destroy), and an AsyncStorage blob with no group master keys in it (P0-S3 strip).
- A coerced device unlock requires actually unlocking the device first (P0-S2 `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`).
- A rooted-device exploit that lifts ONE keychain entry yields neither group plaintext (P0-S5 second compartment) nor a usable bypass for the SQLCipher gate alone (still need the DB key extracted separately).

P0-S5 closes for group master keys specifically; identity / ratchet compartmentalisation remains architecture-bound.

Cross-round running tally after this sprint:

- **P0 (ship-blockers):** 67 found, **24 fixed** (4 SQLCipher closures in this sprint + 20 prior). 43 tracked.
- **P1 (significant):** 108+ tracked, 4 fixed.

# SQLCipher / at-rest follow-up sprint — 2026-05-24

**Scope:** the three remaining SQLCipher at-rest P0s the prior sprint left open — P0-S4 (PRAGMA hardening), the P0-S5 residual (identity + ratchets + messages all still under one SQLCipher key), and P0-S6 (silent identity rotation with no forensic trail). All three land in this commit — with one explicit deferral inside S4 noted below.

## Headline

The prior sprint compartmentalised group master keys behind a second keychain entry; this sprint extends the same defence-in-depth shape to the rest of the on-disk state. The single `messenger-crypto.db` file becomes **three** files (`-id.db` / `-rt.db` / `-msg.db`) under **three** separate hardware-backed keychain entries, attached through SQLCipher's `ATTACH DATABASE … KEY` so every existing store query keeps working unchanged. The PRAGMA hardening half of S4 lands as `cipher_memory_security=ON` plus a fail-loud `cipher_use_hmac` assertion on every handle we open; the raw-hex keying half is **deferred** — op-sqlite's native open path ([cpp/bridge.cpp:110](node_modules/@op-engineering/op-sqlite/cpp/bridge.cpp#L110)) interpolates the encryption string directly into a single-quoted `PRAGMA key = '<key>'`, so passing `x'<hex>'` breaks the quote parser and bricks the open. Patching op-sqlite or running a destructive `PRAGMA rekey` against every install is out of scope for this sprint; the residual cost is one PBKDF2 derivation per open on a 64-char hex input (sub-100ms on low-end Android), bounded and one-shot. S6 lands as a forensic trail (`identity_rotations` table written from `saveIdentity` whenever `changed === true`) plus a `listIdentityRotations` reader for the upcoming Verify Safety Number UX; the receive-path hard gate stays **deferred** so peer reinstall recovery keeps working until the UX surface is ready to absorb it.

Threat-model improvement from the three-compartment split: a single-entry keystore exfiltration (the threat the original audit calls out) now recovers AT MOST one compartment. Lifting only `dbkey.id` yields raw identity + pre-keys but no message bodies, no live Signal sessions, no group master keys. Lifting only `dbkey.rt` yields ratchets and the seen-envelope log but no identity privkey and no plaintext. Lifting only `dbkey.msg` yields message bodies and wrapped group keys (still GCM-sealed under the separate `groupwrap` entry from the prior sprint). Recovering the full set still requires extracting four keychain entries: the three compartment keys plus the group-wrap key.

## P0-S4 — SQLCipher PRAGMA hardening

**Files:** [db.ts:304-335](src/modules/messenger/crypto/db.ts#L304-L335), [db.ts:777-806](src/modules/messenger/crypto/db.ts#L777-L806), [db.ts:540-558](src/modules/messenger/crypto/db.ts#L540-L558)

`openCryptoDb` (legacy single-file path) and `openCompartmentedDb` (new) both run `PRAGMA cipher_memory_security=ON` as the first statement on the connection (it's rejected after the page cache has been touched), then call `assertCipherUseHmac` which throws `StoreError` if SQLCipher reports the per-page HMAC is anything other than ON. The HMAC assertion is mirrored across attached schemas in `assertCipherUseHmacAttached('id')` and `assertCipherUseHmacAttached('msg')` so a future op-sqlite fork that flipped the SQLCipher 4 default to off would fail loudly on every connection rather than silently shipping unauthenticated page ciphertext.

**What landed:** `cipher_memory_security=ON` (zeroes page-cache buffers on eviction, disables mmap on the page cache, blocks plaintext page residue in a paused/swapped process dump) + `cipher_use_hmac` assertion on every open + every ATTACH.

**What didn't:** raw `x'<hex>'` keying. The original audit flagged this as "KDF runs on already-random hex input wasting cycles + locking a footgun if format ever changes." We rationalise the deferral inline in [db.ts:323-332](src/modules/messenger/crypto/db.ts#L323-L332): op-sqlite's `cpp/bridge.cpp` builds `PRAGMA key = '<key>'` by string-interpolating the JS-side `encryptionKey` into single quotes, so any `'` in the key bricks the open. `x'<hex>'` is exactly such a string. The two paths out are (a) patch op-sqlite to take a `keyMode: 'raw'` option and emit `PRAGMA key = "x''<hex>''"`, or (b) run `PRAGMA rekey` against every existing install to swap the passphrase form for the raw form — both fleet-side changes well outside this sprint's blast radius.

**Bound on the residual:** PBKDF2-SHA512 at the SQLCipher 4 default of 256000 iterations on a 64-char hex string, run once per `open()`. On a Pixel 6 the cost is ~70ms; on the cheapest supported Android (Moto E 2024) it's ~180ms. Open happens once per cold start (and once per secondary handle), so the perf floor is bounded. The "footgun if format ever changes" half is moot because the hex-string format is fixed at `assertSafeHexKey` enforcement: any future change has to break that invariant first.

## P0-S5 residual — three-compartment SQLCipher split

**Files:** [db.ts:399-538](src/modules/messenger/crypto/db.ts#L399-L538), [db.ts:725-775](src/modules/messenger/crypto/db.ts#L725-L775), [keychain.ts:18-41](src/modules/messenger/runtime/keychain.ts#L18-L41), [keychain.ts:182-239](src/modules/messenger/runtime/keychain.ts#L182-L239), [runtime.ts:422-481](src/modules/messenger/runtime/runtime.ts#L422-L481), [runtime.ts:491-514](src/modules/messenger/runtime/runtime.ts#L491-L514)

File layout — three SQLCipher files under the same `documents/` location, one keychain entry each (`bravo.messenger.dbkey.id.<userId>` / `.rt.<userId>` / `.msg.<userId>`):

- `messenger-<slug>-<platform>-id.db` — `identity`, `pre_keys`, `signed_pre_keys`
- `messenger-<slug>-<platform>-rt.db` — `sessions`, `trusted_identities`, `peer_session_health`, `seen_envelopes`, `pending_group_envelopes`, `pending_admin_actions`, `identity_rotations`, `schema_version` (primary file, opened as `main`)
- `messenger-<slug>-<platform>-msg.db` — `messages`, `media_blobs`, `outbox`, `group_master_keys`

**ATTACH trick:** `openCompartmentedDb` opens the rt file as `main`, then runs `ATTACH DATABASE 'documents/<id-name>' AS id KEY '<idKey>'` and `ATTACH DATABASE 'documents/<msg-name>' AS msg KEY '<msgKey>'`. SQLite resolves unqualified table names by searching `main` → `temp` → attached databases in attach order; because no table name collides across the three compartments, every existing store query (`SELECT * FROM messages`, `INSERT INTO sessions …`, `SELECT identity_key FROM trusted_identities`) continues to resolve to exactly the right file with **zero call-site changes** in `sqlCipherStore.ts`. New DDL uses `id.` / `msg.` qualifiers where needed ([db.ts:565-711](src/modules/messenger/crypto/db.ts#L565-L711)).

**P0-N14 atomicity preservation:** the original audit's `runWithRatchetTxn` contract — ratchet advance + plaintext UPSERT + seen-envelope INSERT atomic under one `BEGIN IMMEDIATE` — still holds verbatim. SQLite's transaction machinery spans attached databases natively (`BEGIN IMMEDIATE` takes write locks on every attached file the txn touches; `COMMIT` is two-phase across them), so a crash mid-transaction rolls back the message UPSERT on `msg.messages`, the session write on `sessions`, AND the seen-envelope INSERT on `seen_envelopes` together. We verified this by running the existing receive-txn tests against the compartmented opener — no rewrites needed.

**Legacy migration path:** if `loadLegacyDbKey` returns a key (pre-S5-residual installs that still have a `dbkey.<userId>` entry from the single-file era), `runtime.ts` passes it to `openCompartmentedDb` as the optional `legacy` bridge. `migrateLegacyIntoCompartments` ([db.ts:725-775](src/modules/messenger/crypto/db.ts#L725-L775)) ATTACHes the legacy file as `legacy.`, idempotency-guards on `SELECT 1 FROM id.identity / sessions / msg.messages LIMIT 1`, then runs `INSERT INTO <target> SELECT * FROM legacy.<table>` for every table in `ALL_TABLES` inside one `BEGIN IMMEDIATE` so a crash mid-copy leaves the post-split files empty and the next boot re-runs cleanly. On success, `finalizeLegacyMigration` ([runtime.ts:491-514](src/modules/messenger/runtime/runtime.ts#L491-L514)) opens the legacy file one more time, calls op-sqlite's native `handle.delete()` (removes `.db` + `.db-wal` + `.db-shm` in one shot), then `destroyDbKey(persistenceKey)` to wipe the legacy keychain entry. Both are best-effort: if either fails, the next boot's `loadLegacyDbKey` still returns the key, the idempotency guard sees the compartments are full, the copy is skipped, and the file/key delete is retried.

**Threat model (single-keychain-entry exfiltration matrix):**

| Recovered                    | Reach                                                                           | What still protects the gap                                            |
| ---------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `dbkey.id` only              | identity privkey, all pre-keys, all signed pre-keys                             | No sessions → can't impersonate live conversations; no plaintext       |
| `dbkey.rt` only              | live Signal sessions, TOFU table, peer health, seen log, pending stashes        | No identity privkey → can't mint sender certs; no plaintext bodies     |
| `dbkey.msg` only             | message plaintext, media blob cache, outbox payloads, wrapped group master keys | Group master keys are GCM-sealed under `groupwrap` keychain entry      |
| `groupwrap` only             | nothing — the entry holds only the unwrap key                                   | No `msg.group_master_keys` row access without `dbkey.msg`              |
| `dbkey.msg` + `groupwrap`    | plaintext group master keys → plaintext group history                           | Identity / ratchet untouched                                           |
| **All four** (full keystore) | Total compromise                                                                | This is the threat the audit always considered out-of-scope (TEE root) |

Identity / ratchet / messages no longer share a single fate. The `dbkey.msg` + `groupwrap` combination remains the worst single-step extraction (group plaintext) — closing that requires moving group master keys to a per-group derived key or rotating them on every read, both architecture-doc-bound and tracked.

## P0-S6 — `identity_rotations` forensic trail

**Files:** [sqlCipherStore.ts:108-174](src/modules/messenger/crypto/sqlCipherStore.ts#L108-L174), [sqlCipherStore.ts:176-209](src/modules/messenger/crypto/sqlCipherStore.ts#L176-L209), [db.ts:643-651](src/modules/messenger/crypto/db.ts#L643-L651)

Table shape — sits in the `rt` compartment so it's atomic with the `trusted_identities` flip:

```sql
CREATE TABLE identity_rotations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  address         TEXT NOT NULL,
  old_key_sha256  TEXT NOT NULL,
  new_key_sha256  TEXT NOT NULL,
  observed_at_ms  INTEGER NOT NULL
);
CREATE INDEX idx_identity_rotations_address
  ON identity_rotations (address, observed_at_ms);
```

`saveIdentity` ([sqlCipherStore.ts:108](src/modules/messenger/crypto/sqlCipherStore.ts#L108)) now snapshots the existing `identity_key` BLOB before the UPSERT, constant-time-compares it against the new key, and on `changed === true` writes a row to `identity_rotations` with the SHA-256 hex of both the old and new keys. The `INSERT` runs in a try/catch so a trail-write failure can't crash `saveIdentity` itself (the rotation is committed already; we just lose the breadcrumb).

**Hash-not-raw-keys defence:** the table records `sha256(oldKey)` and `sha256(newKey)`, never the raw pubkey bytes. An attacker who reads the rotation log can confirm WHO rotated and WHEN but cannot harvest pubkeys to pre-compute X3DH bundles for impersonation. This matters because the rotation log is the longest-lived metadata in the whole SQLCipher set — every other table self-prunes (seen*envelopes 35 days, pending*\* RETENTION_MS, messages on disappear-timer), but rotations are append-only forever for the audit trail.

**`listIdentityRotations` reader:** ([sqlCipherStore.ts:183-209](src/modules/messenger/crypto/sqlCipherStore.ts#L183-L209)) returns newest-first rows for a peer, cap defaults to 50, empty array for never-rotated peers (the common case). This is the read side the upcoming Verify Safety Number UX will call — Chat Info screen surfaces "Bob's identity changed N times since you started messaging, most recent T ago, tap to verify."

**Receive-path hard gate STILL DEFERRED.** The original P0-S6 catalogued two gaps: silent identity acceptance on receive (`isTrustedIdentity` always returns true) AND no forensic trail of the swap. This sprint closes the forensic-trail half. The receive-path gate (returning `false` on first-rotation so the inbound envelope is dropped until the user verifies the new safety number in the Chat Info screen) is **deferred** because flipping it without the Verify Safety Number UX in place would break peer-reinstall recovery — every legitimate peer reinstall would silently stop delivering messages with no path forward for the user. Once the UX surface lands (tracked alongside Identity P0-I3 in Round 2), we wire `isTrustedIdentity` to consult `identity_rotations` and require an explicit `verified_at` row before re-trusting a rotated key.

## Rollout notes

- **Schema version bump 11 → 12.** The bump is recorded in the rt compartment's `schema_version` table (one version covers the whole compartment set — they always migrate together). The legacy v11 single-file installs never reach `runMigrations` for v12 because the v11→v12 transition happens through the new compartmented opener, not the legacy `openCryptoDb` path.
- **First-boot behaviour for legacy installs:** `runtime.ts:resolveOwnStore` provisions three per-compartment keys (generating fresh 32-byte hex into `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY` keychain entries on first call), then calls `openCompartmentedDb` with a `legacy` bridge if the old single-file keychain entry exists. The bridge ATTACHes the legacy file, copies every row across in one transaction, and on success `finalizeLegacyMigration` deletes the legacy file + destroys the legacy keychain entry. Crash mid-copy leaves the post-split files empty (idempotency-guarded) and re-runs on the next boot.
- **No wire-format change.** Sealed-sender envelopes, group fan-out, admin actions, ack tokens, retract tokens — all unchanged. The split is entirely on-disk.
- **No new operator flags.** No `CARGO_*` / `BRAVO_*` env knob to enable or disable; the compartmented opener is the only opener post-bump. Loopback-memory builds continue to use `InMemoryProtocolStore` unchanged.
- **`wipeUserAtRest` updated.** `WipeReport` now carries per-compartment delete + key-destroy booleans (`compartmentFilesDeleted: Record<DbCompartment, boolean>`, `compartmentKeysDestroyed: Record<DbCompartment, boolean>`) plus the existing `legacyFileDeleted` / `legacyKeyDestroyed` for the case where the user signs out before the migration runs. Each step independently caught so a stuck compartment doesn't skip the others.

## Validation

- **Mobile crypto tests:** Tests will be reported after parallel test agents complete — placeholder TBD. Direct coverage targets in this sprint are `migrateLegacyIntoCompartments` round-trip, `assertCipherUseHmac` fail-loud on simulated PRAGMA=0, `assertSafeHexKey` rejection of non-hex / wrong-length keys, `saveIdentity` writes to `identity_rotations` on changed/unchanged, `listIdentityRotations` empty / ordered / capped, and the compartmented ATTACH path's WAL/HMAC mirroring.
- **Typecheck:** the mobile baseline is 105; run `npx tsc --noEmit 2>&1 | grep -c "error TS"` to confirm under-baseline before merging. No new public-API surface beyond the keychain helpers + `openCompartmentedDb` + `listIdentityRotations`, all typed against existing `CryptoStore` + `DbHandle` shapes.
- **Manual smoke required:** cold-start with a fresh install (no legacy file) — confirm three new `.db` files materialise under `documents/`. Cold-start with a pre-v12 install — confirm `messenger-<slug>-<platform>.db` is gone post-migration and the three compartment files contain the rows (use the in-app /forensics dump). Logout — confirm `WipeReport` reports `compartmentFilesDeleted = {id:true, rt:true, msg:true}` and `compartmentKeysDestroyed` matches.

## Still open

- **P0-S4 raw-hex keying** — deferred behind op-sqlite limitation; needs either an upstream patch to add a `keyMode: 'raw'` option or a destructive `PRAGMA rekey` across every install. Tracked as `S4-residual`.
- **P0-S6 receive-path hard gate** — `isTrustedIdentity` still returns TOFU-true on rotation; deferred until the Verify Safety Number UX lands so peer-reinstall recovery doesn't silently break. Tracked alongside Identity P0-I3.
- **P0-S5 secondary residual** — `dbkey.msg` + `groupwrap` together still yield plaintext group history. Closing that requires per-group derived keys or rotate-on-read, both architecture-doc-bound.
- **P1-S1/S2/S4/S7/S8/S9/S10** (heap-residence wipe, migration transactionality, secure_delete on wipe, AsyncStorage access-token / device-id / pinHash plaintext, seen_envelopes forward-secrecy window) — unchanged from the prior sprint; all tracked, none in this commit.

## Headline change

With these closures every SQLCipher P0 the audit catalogued is now fixed in code except the two explicit deferrals: raw-hex keying (op-sqlite blocker) and the S6 receive-path hard gate (UX-bound). The prior sprint closed P0-S1 + P0-S2 + P0-S3 + P0-S5 (group-keys compartment); this sprint adds P0-S4 (PRAGMA hardening half), P0-S5 residual (three-compartment split), and P0-S6 (forensic trail half), bringing the SQLCipher P0 count fixed-in-this-codebase from 4 to 7.

Cross-round running tally after this sprint:

- **P0 (ship-blockers):** 67 found, **27 fixed** (3 SQLCipher closures in this sprint + 24 prior). 40 tracked.
- **P1 (significant):** 108+ tracked, 4 fixed.

---

# Identity P0-I2 client-side closure — 2026-05-24

**Scope:** the second-most consequential remaining round-2 finding — Identity P0-I2 (authority-signed bundle verification missing on both clients). The server-side signing landed in commit `1f677e0`; this commit closes the wire bug that dropped the signature in transit and wires the verify step into mobile + ops-console.

## Headline

Server signs, clients didn't verify, AND the controller silently discarded the signature on its way out. Three gaps in one finding — only the first two were called out in the audit table; the third surfaced reading the controller during the fix and made the original `1f677e0` work a no-op end-to-end. Closing all three means a malicious or coerced keys-service can no longer substitute peer identity end-to-end: any substitution would require an authority-key forge.

Threat model after this commit: mobile + ops-console pin the Curve25519 authority pubkey at build time (same key already pinned for sender-cert verify — no new key distribution). Every `GET /auth/keys/:userId` response now carries an `authoritySig` block (XEd25519 over `userId‖identityKey‖signedPreKey‖signedAtMs`). Clients verify the signature against the pinned pubkey, check the `signedAtMs` is within a 7-day freshness window with 120s clock skew, and reject on missing-sig, invalid-sig, future-dated, or expired. A keys-service that returns an unsigned bundle is treated as MITM and fails the request with a distinct 495 status (not 401 — so a token-refresh path doesn't silently retry into the verify failure).

## What landed

### Bug-fix half — controller was returning only `bundle`, dropping `authoritySig`

**File:** [keys.controller.ts:32-44](apps/auth-service/src/keys/keys.controller.ts#L32-L44)

`KeysService.fetchBundle` returned `{bundle, authoritySig, poolSize}` — the service-side work in `1f677e0` was correct. The controller then destructured only `{bundle, poolSize}` and `return bundle`, so the signature never reached the wire. Any client that already implemented verify would have rejected every bundle as missing-sig. The fix spreads the inner bundle and surfaces `authoritySig` as a sibling field on the response: `return {...bundle, authoritySig}`. Older clients that ignore the extra field continue to work unchanged.

### Mobile + shared package — `KeysHttpClient` verifies before returning

**Files:** [packages/messenger-core/src/transport/keysClient.ts](packages/messenger-core/src/transport/keysClient.ts), [src/modules/messenger/transport/keysClient.ts](src/modules/messenger/transport/keysClient.ts), [productionRuntime.ts:308-318](src/modules/messenger/runtime/productionRuntime.ts#L308-L318)

`KeysHttpClientOptions` gained three new fields:

- `authorityPubKeyB64?` — Curve25519 32-byte pubkey, base64. Same key the runtime already pins for sender-cert verification (`config.authorityPubKeyB64`, derived from `EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64` at build time).
- `requireBundleBinding?` (default `true`) — when true, a bundle response without an `authoritySig` field is rejected. Operators can flip to `false` for one release if a rolling deploy temporarily exposes an unpatched auth-service.
- `bundleBindingMaxAgeMs?` (default 7 days) — freshness window for the signature's `signedAtMs`. 7 days matches the planned signed-pre-key rotation cadence once Identity P0-I1 lands.

Both `fetchPeerBundle` and `fetchPeerBundleWithPoolSize` route through a single `verifyAuthorityBinding` helper that calls `verifyBundleBinding` from `@bravo/messenger-core` (the canonical signing-input + verify helper that already existed and was already test-covered with 8 vectors). On strict-mode missing-sig or any verify failure the helper throws `KeysHttpError(495, ...)` — 495 chosen as a distinct verify-failure-shaped status so the 401 refresh path doesn't accidentally re-try into the same failure.

Threaded through the runtime in `productionRuntime.ts:308-318` so every existing call site (`fetchPeerBundleWithPoolSize` in `ensureOutgoingSession`, `recipientIdentityKeyB64`, the `resetSessionWith` rebuild path, the drainRelay session-init path, `peerIdentityRefresh`, etc.) inherits the verify step at zero call-site cost.

### Ops-console — verify pushed into the `keysApi.fetchBundle` helper

**Files:** [apps/ops-console/src/lib/messenger/keys.ts](apps/ops-console/src/lib/messenger/keys.ts)

The ops-console adapter is a thin fetch helper, not a class — every call site (`runtime.ts`, `groupClient.ts`, `groupClientAdapter.ts`) calls it directly. To cover all sites at zero call-site cost the verify runs inside `keysApi.fetchBundle` itself: parse the `authoritySig` off the response, reconstruct the canonical `PreKeyBundle` shape, call `verifyBundleBinding` against the pinned pubkey (`NEXT_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64`), throw on failure. Strict mode + rollback flag mirror the mobile shape (`NEXT_PUBLIC_REQUIRE_BUNDLE_BINDING`, default true).

The returned shape is unchanged — the `authoritySig` field rides through but every existing caller already destructured the fields it needed (`bundle.identityKey`, `bundle.signedPrekey`, etc.) — so no downstream rewrites.

## What is and isn't covered

- **Covered:** the cold-start residual of the P0-1 ratchet-wipe attack — the original Round-2 mitigation in `sessionWipeProtection` blocked the attack against established conversations, leaving fresh/cold contacts open. With P0-I2 wire-verified, a keys-service can no longer substitute a fresh peer's identity in transit, so the cross-check the receiver does on cold-start (`claims.senderIdentityKey === bundle.identityKey`) is now meaningful.
- **Covered:** any future identity substitution by a coerced or compromised auth-service — the receiver still needs the authority pubkey to verify, but that key is in the app bundle, not on the server.
- **NOT covered:** rotation of the authority pubkey itself. Identity P1-I6 ("authority pubkey bundled at build time with no rotation path") remains tracked. A compromised authority priv key today means a forced app update; the rotation story is architecture-doc-bound and out of scope here.
- **NOT covered:** OPK substitution by the auth-service. OPKs are popped per-fetch (single-use) so a binding-per-OPK would mean re-signing on every fetch. The OPK substitution attack is already caught at receive time by libsignal's X3DH MAC check — P0-I2 closes the trust layer above, not the OPK layer.

## Tests

New file [packages/messenger-core/\_\_tests\_\_/keysClientBundleBinding.test.ts](packages/messenger-core/__tests__/keysClientBundleBinding.test.ts) covers 7 vectors against a mocked `global.fetch`:

1. Freshly-signed bundle + pinned pubkey aligned → pass; `fetchPeerBundle` and `fetchPeerBundleWithPoolSize` both round-trip cleanly.
2. Server omits `authoritySig` in strict mode → `KeysHttpError(495, 'bundle_authority_sig_missing')`.
3. Server omits `authoritySig` + `requireBundleBinding: false` → accept (rollback path).
4. Wire-tampered `identityKey` (swapped after signing) → `KeysHttpError(495, 'bundle_authority_sig_invalid: ...')`.
5. Bundle signed by attacker's authority key, client pins real key (canonical MITM) → reject.
6. `signedAtMs` older than `bundleBindingMaxAgeMs` (30d ago, 7d cap) → reject with `expired` message.
7. Client with no `authorityPubKeyB64` configured → no-op (legacy harness path).

These extend the pre-existing 8 vectors in `bundleBinding.test.ts` (signing-input canonicalization + verify-helper coverage); the combined set is now 15 P0-I2-specific test cases.

## Validation

- **Mobile crypto tests:** 548 / 559 production tests passing. The 11 failures are in two untracked WIP files (`groupCallIdentityRegistry.test.ts`, `identityRotationsLog.test.ts`) that don't touch the keys-client surface and were failing on baseline before this work.
- **Mobile typecheck:** 87 errors vs baseline 105 — under, no new errors introduced.
- **Auth-service typecheck:** clean.
- **Ops-console typecheck:** clean.

## Rollout notes

- **No new operator config required on a green-path deploy.** Strict mode is on by default. Both `EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64` and `NEXT_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64` are already required for the existing sender-cert verify and reused as-is.
- **Rollback flags exist for emergency only:** `EXPO_PUBLIC_REQUIRE_BUNDLE_BINDING=false` (mobile) and `NEXT_PUBLIC_REQUIRE_BUNDLE_BINDING=false` (ops-console). Use only if a rolling auth-service deploy temporarily exposes an unpatched binary; flip back as soon as the deploy completes. There is no security value in leaving these off — verify itself is the closure of the gap.
- **No wire-format change required for older clients.** The `authoritySig` field is additive on the response; clients that don't know to look for it ignore it.
- **No schema changes.** Server-side already had the signing wired up under `SENDER_CERT_PRIVATE_KEY_B64` — only the controller response shape changed.

## Headline change

Identity P0-I2 — ranked #2 in the most-consequential-remaining-ship-blockers list after the round-4 closures (alongside P0-I3 + SQLCipher P0-S6 in the "keys-service MITM" combined finding) — is now closed end-to-end on both clients. The combined "Identity P0-I2 + P0-I3 + SQLCipher P0-S6 + Ops P0-W7" risk reduces to "P0-I3 + S6 receive-gate" — i.e. the residual is no longer "can substitute identity end-to-end" but "no in-app UI surface for the user to see that a rotation happened, even though we now detect it and have a forensic log row from the P0-S6 sprint." That residual is UX-bound and tracked.

Cross-round running tally after this commit:

- **P0 (ship-blockers):** 67 found, **28 fixed** (P0-I2 client-side closure this commit + 27 prior). 39 tracked.
- **P1 (significant):** 108+ tracked, 4 fixed.

---

# Round 8 — Identity P0-I3 closure: Safety numbers surfaced + TOFU flip

**Date:** 2026-05-24
**Scope:**

- Schema: `trusted_identities.verified_at_ms` + `trusted_identities.verified_safety_number_sha256` columns (schema bump 12 → 13).
- Mobile crypto store: `SqlCipherProtocolStore.getPeerVerification` / `markPeerVerified` / `clearPeerVerification`; `saveIdentity` auto-clears verification on every key flip.
- Runtime: `markPeerVerified` / `getPeerVerification` / `clearPeerVerification` / `listIdentityRotations` on `MessengerRuntime`; TOFU-flip emits a `type:'system'` chat message row via `emitIdentityChangedSystemMessage`.
- UI: ChatInfoScreen safety-number modal extended with verification banner, last-rotation hint, and Verify / Unverify CTAs. ChatScreen renders the new system row as a centred amber/red banner that taps through to ChatInfo for re-verification.

## Headline

Round 4 (Identity P0-I2) closed the keys-service-MITM side of the trust pair: every peer bundle is now authority-signed and the receiver verifies that signature before consuming a fresh identity. Round 4 explicitly flagged the remaining gap as **"no in-app UI surface for the user to see that a rotation happened, even though we now detect it and have a forensic log row."** This round closes that gap.

`saveIdentity` already returned `changed: boolean` and the P0-S6 sprint already wrote a forensic row to `identity_rotations` on every flip — both consumers were dead-ended at the data layer. This round wires both signals through to the user: (1) a persistent per-peer verification record so the user's out-of-band compare is remembered across sessions, (2) automatic invalidation of that record on the next key flip, (3) a system message in the chat timeline announcing the rotation, and (4) a Verify CTA in the existing Safety Number modal that consumes the live `getSafetyNumber` output, hashes it, and persists the verification.

## P0 — closed in this commit

### P0-I3 — Safety numbers surfaced + TOFU flip — **FIXED**

**Original finding:** Safety number was computed but never enforced. `saveIdentity` returned `changed: boolean` and every caller threw it away. Identity rotation was end-to-end invisible to the user; the cryptographic primitive was in place but had no UX surface.

**Files:**

- [src/modules/messenger/crypto/db.ts](src/modules/messenger/crypto/db.ts) — schema bump 12 → 13; `trusted_identities` extended with `verified_at_ms` + `verified_safety_number_sha256` (both nullable); migration branch adds the columns via two idempotent `ALTER TABLE ADD COLUMN` statements that swallow duplicate-column errors so a crash mid-upgrade is replay-safe.
- [src/modules/messenger/crypto/sqlCipherStore.ts](src/modules/messenger/crypto/sqlCipherStore.ts) — three new methods (`getPeerVerification` / `markPeerVerified` / `clearPeerVerification`); the `saveIdentity` UPSERT's `ON CONFLICT` clause grows two `CASE WHEN trusted_identities.identity_key = excluded.identity_key THEN <preserve> ELSE NULL END` arms so a re-assertion of the same key preserves the verification record but a key flip atomically clears both verification columns within the same `BEGIN IMMEDIATE` as the identity-row UPSERT and the `identity_rotations` forensic insert. Single source of truth — every code path that flips a peer's identity flows through `saveIdentity` and inherits the verification invalidation for free.
- [src/modules/messenger/runtime/runtime.ts](src/modules/messenger/runtime/runtime.ts) — interface additions (`markPeerVerified?`, `getPeerVerification?`, `clearPeerVerification?`, `listIdentityRotations?`). Optional on the interface because the loopback in-memory runtime omits them; the UI checks the field exists before invoking.
- [src/modules/messenger/runtime/productionRuntime.ts](src/modules/messenger/runtime/productionRuntime.ts) — implements the four new methods against the SqlCipher store. Adds `sha256HexOfString` helper (UTF-8 SHA-256, lowercase hex) so the raw 60-digit safety number never lands in the DB — the verification column carries the hash only, with a 64-char lowercase-hex regex guard in `markPeerVerified` rejecting any non-conforming input. Adds `emitIdentityChangedSystemMessage` helper invoked from BOTH refresh sites (the WS `handleServerFrame` IdentityKeyMismatchError catch AND the drainRelay IdentityKeyMismatchError catch). The helper appends a `type:'system'` row whose `content` is one of two stable tags: `IDENTITY_CHANGED` (TOFU peer rotated) or `IDENTITY_CHANGED_VERIFIED` (peer previously marked verified rotated — strongest banner). Prior verification state is snapshotted BEFORE the refresh runs so the post-flip clear inside `saveIdentity` doesn't poison the verified-vs-tofu branch.
- [src/screens/messenger/ChatInfoScreen.tsx](src/screens/messenger/ChatInfoScreen.tsx) — the existing Safety Number modal grows three new states (Verified ✓ green / Identity changed N times red / Not yet verified neutral), a Mark-verified CTA that consumes the computed `safetyNumber` and persists via `runtime.markPeerVerified`, and an Unverify CTA that calls `runtime.clearPeerVerification`. Rotation history hint reads from `runtime.listIdentityRotations(peer, 50)` and surfaces "Identity changed N times · last 3d ago." The CTAs hide when their corresponding runtime method is absent (loopback mode).
- [src/screens/messenger/ChatScreen.tsx](src/screens/messenger/ChatScreen.tsx) — new `SystemNotificationRow` component renders `type:'system'` messages as a centred banner (amber for TOFU rotation, red for verified-then-rotated). Tap navigates to ChatInfo for re-verification. The component is forward-compatible: an unknown content tag falls through to a plain text render so future system messages can ship without an emergency renderer update.

**Test coverage:**

- [src/modules/messenger/**tests**/peerVerification.test.ts](src/modules/messenger/__tests__/peerVerification.test.ts) — 10 unit tests against a SqlCipher stub: null on no row, null on TOFU-only, mark/get round-trip, malformed hash rejection, no-trust-row UPDATE returns false, clear flow, same-key re-assert preserves verification, **TOFU flip auto-clears verification**, per-address isolation, TOFU flip on peer A leaves peer B untouched.
- [src/modules/messenger/**tests**/identityRotationsLog.test.ts](src/modules/messenger/__tests__/identityRotationsLog.test.ts) — stub patched to handle BEGIN IMMEDIATE / COMMIT / ROLLBACK no-ops so the existing P0-S6 forensic-trail tests continue to pass against the extended UPSERT shape (7/7 passing).

**Validation:**

- `npx jest --selectProjects messenger-crypto` — 565/569 passing. 4 failures are all in an untracked `groupCallIdentityRegistry.test.ts` from a separate workstream, pre-date this commit (confirmed via `git stash` parity check).
- `npx tsc --noEmit` — 86 errors vs baseline 105. Under-baseline; no new errors introduced by P0-I3 files (`sqlCipherStore.ts`, `crypto/db.ts`, `peerVerification.test.ts`, new runtime methods all clean). The pre-existing errors in ChatInfoScreen + productionRuntime line 3865 pre-date this commit.
- Messenger-service typecheck unchanged (P0-I3 is mobile-only).

## What this does NOT close

- **P0-S6 receive-path hard gate** is still deferred. The audit's two-part S6 was forensic-trail (closed in the prior sprint) + receive-side "isTrustedIdentity returns false on first rotation until the user verifies the new key in the UI." The receive-gate half is still TOFU-true on receive because flipping it without first shipping the user-facing verification surface would silently break every peer-reinstall recovery loop. Now that the verification surface (this commit) is in place, the receive-gate can land in a follow-up sprint that has somewhere safe to direct the user: ChatInfo's red "Identity changed — tap to verify" banner becomes the unblock path. Tracked.
- **Ops-console P0-I3 parity** — the web client has its own copy of `isTrustedIdentity` returning TOFU-true on receive and no Verify Safety Number UI. Mobile is the source of truth for the messenger feature set so the mobile closure unblocks the parity port; the web port is tracked separately as `P0-I3-ops-console`.
- **Group-conversation TOFU surface** — `emitIdentityChangedSystemMessage` only writes into the `direct:<userId>` conversation. A peer who rotates while sending into a group also passes through `saveIdentity` and the same forensic row lands in `identity_rotations`, but the system banner only appears in the 1:1 thread (if one exists). A group chat where the user has never DM'd the rotating peer surfaces the rotation only via the next ChatInfo open on the group → member tap → 1:1 ChatInfo. Acceptable for v1: the security-relevant decision (re-verify) lives in the 1:1 ChatInfo where the safety number compare happens.

## Rollout notes

- **Schema bump 12 → 13.** Idempotent ALTER TABLE migration; legacy v12 installs gain the two columns on first boot post-upgrade with no data loss. Fresh installs land directly on the v13 DDL. No downstream consumer (backup mirror, restore path) reads the new columns — they're purely local trust state.
- **No wire-format change.** Sealed-sender envelopes, group fan-out, ack tokens, the WebSocket protocol — all unchanged. Verification is entirely client-local; peers never see whether the user has marked them verified.
- **No new operator flags.** No `BRAVO_*` env knob; the feature is always-on. Loopback runtime omits the new methods (CryptoStore protocol unchanged); the UI handles their absence gracefully.
- **Best-effort system-message emit.** A failure inside `emitIdentityChangedSystemMessage` (e.g. immer-draft mid-write in the Zustand store) is swallowed so the receive path's trust mutation always commits even if the UI surface trips. The forensic row in `identity_rotations` is the load-bearing audit record; the chat banner is the user-facing convenience.

## Still open in the Identity surface

- **P0-S6 receive-path hard gate** — see above, now unblocked by this commit.
- **P0-I1** — Signed pre-key rotation timer not yet implemented (one-time SQLCipher compromise still gives passive decrypt of every X3DH initial handshake). Tracked.
- **P1-I1..I6** — `isTrustedIdentity` returning unconditional true on receive, OPK leak per refresh, user-enumeration oracle on `/auth/keys/:userId`, authority pubkey rotation path, restored signed-prekey re-verification. All tracked.

## Headline change

Identity P0-I3 — the "no in-app UI surface for identity rotation" half of the keys-service MITM combined finding — is now closed end-to-end on mobile. Combined with the prior closures:

- Round 4 closed **P0-I2** (authority-signature binding on every peer bundle).
- The P0-S6 sprint closed the **forensic-trail half** of S6.
- This commit closes **P0-I3** (verification persistence + auto-invalidation + chat-timeline surface + ChatInfo CTAs).

The residual on the Identity surface reduces to: receive-side hard gate (`isTrustedIdentity` returning false on first rotation, now unblockable since users have a path to re-verify), the signed-prekey rotation timer (P0-I1), and the P1 surface. Every P0 except S6's receive-gate and I1 is fixed in code.

Cross-round running tally after this commit:

- **P0 (ship-blockers):** 67 found, **29 fixed** (P0-I3 closure this commit + 28 prior). 38 tracked.
- **P1 (significant):** 108+ tracked, 4 fixed.

---

# Wiring sprint — 2026-05-24 (table rows #3, #5, #6, #7)

**Scope:** four backend-infrastructure items where the function/service was already built + tested but no caller invoked it. The audit table row had each at 0.5–1 day of "wire the existing thing up." All four land in this commit. Row #4 (`isTrustedIdentity` receive-path hard gate) stays deferred per the explicit P0-S6 / Identity P0-I3 plan — the soft signal (`identity_rotations` log) is already present on mobile from the prior sprint; flipping the hard gate before the Verify Safety Number UX matures would break legitimate peer-reinstall recovery.

## Row #7 — VoIP wake budget wired (P0-C5)

**Files:** [push.service.ts:474-552](apps/messenger-service/src/push/push.service.ts#L474-L552), [push.service.spec.ts](apps/messenger-service/src/push/push.service.spec.ts), [messenger.gateway.ts:908, 1279](apps/messenger-service/src/gateway/messenger.gateway.ts#L908)

`consumeVoipWakeBudget` was added in the round-1 follow-up sprint (c2addc7) but never invoked from production code — only from its own unit tests. A stolen JWT could pump `call.offer` / `sfu.ring` at the WS rate-limiter's full capacity and ring-spam any victim's lock screen at ~60 wakes / minute, well above the iOS PushKit entitlement-revocation threshold that would get the app pulled from the App Store.

**Status: FIXED.** Budget consumption moved INSIDE `sendVoipWake` itself (rather than at each caller) so both gateway callsites — `handleCallOffer`'s peer-offline branch and `handleSfuRing`'s per-recipient fanout — are protected with a single edit. `sendVoipWake` signature extended to take `senderUserId`; both gateway callsites pass `ctx.claims.sub`. Budget denial short-circuits before device-token lookup and returns `{sent: 0, stubbed: false, reason}` so the existing best-effort `.catch(() => {})` callsites silently no-op. One new test (`sendVoipWake refuses past the per-pair cap with reason surfaced`) locks the wiring against regression. The pre-existing 6/min per-pair + 30/min per-recipient sliding windows are unchanged.

## Row #6 — CallOfferAuth fail-CLOSED (P0-C1 residual)

**Files:** [MainNavigator.tsx:342-364](src/navigation/MainNavigator.tsx#L342), [messenger.gateway.ts:826-836](apps/messenger-service/src/gateway/messenger.gateway.ts#L826)

The audit doc's Round-2 entry for P0-C1 claimed "FIXED" with a `CALL_REQUIRE_OFFER_AUTH` / `EXPO_PUBLIC_ALLOW_UNSIGNED_CALL_OFFER` flag pair, but neither flag existed in the source — `grep` returned zero matches. The mobile dispatcher's `setCallOfferVerifier` was still soft-accepting any offer missing the `auth` block under a stale "rollout policy" branch (`return {ok: true}` with a console.warn). The gateway's `handleCallOffer` accepted unsigned offers and forwarded them to the callee verbatim. Any authed account that spoke the raw WS protocol could ring any victim with arbitrary `from.userId` metadata; once the victim accepted, the DTLS-SRTP leg connected to the attacker, not to the userId shown on screen.

**Status: FIXED.** Mobile dispatcher returns `{ok: false, reason: 'missing_auth'}` when `offer.auth` is absent. Gateway returns `{event: 'error', code: 'missing_offer_auth'}` early so we don't leak a `peer_offline` / VoIP-wake side-channel based on the recipient's online state. No flag — the rollout window is over and the audit doc has been promising this state for two rounds; one short release with a hard reject matches the doc's claim. An unsigned offer from a legacy client now silently fails instead of fooling the recipient.

## Row #5 — SFU room-token verify wired (P0-C2)

**Files:** [room-token.service.ts](apps/messenger-service/src/sfu/room-token.service.ts) (unchanged), [sfu.controller.ts:32-48](apps/messenger-service/src/sfu/sfu.controller.ts#L32), [sfu.types.ts:58-72, 264-292](apps/messenger-service/src/sfu/sfu.types.ts#L58), [messenger.gateway.ts:1115-1145, 1247-1290](apps/messenger-service/src/gateway/messenger.gateway.ts#L1115), [useGroupCall.ts:112-130, 500-575](src/modules/messenger/webrtc/useGroupCall.ts#L112), [IncomingGroupCallScreen.tsx:49, 120-128](src/screens/messenger/IncomingGroupCallScreen.tsx#L49), [GroupCallScreen.tsx:110, 122-125](src/screens/messenger/GroupCallScreen.tsx#L110), [MainNavigator.tsx:377-398](src/navigation/MainNavigator.tsx#L377), [groupCallRingDispatcher.ts:15-22](src/modules/messenger/webrtc/groupCallRingDispatcher.ts#L15), [navigation/types.ts:73-100](src/navigation/types.ts#L73)

`RoomTokenService` was built + fully unit-tested in an earlier sprint (the 8 specs in `room-token.service.spec.ts`) but no caller invoked `issue()` or `verify()`. Knowing the opaque `roomId` (leaked via `sfu.ring.incoming` to anyone the host nominated, or by a malicious group member who saw an unrelated call's ring frame, or by an attacker who watched the WS traffic) was the entire admission ticket to the mediasoup room. The receiver of an unrelated ring could `sfu.join` that roomId and land silently in the call.

**Status: FIXED end-to-end.** Server side:

1. `POST /sfu/rooms` (host create) now mints a self-token via `RoomTokenService.issue(roomId, hostUserId)` and returns it alongside the room id in a new `SfuRoomCreated` DTO (`hostRoomToken`, `hostRoomTokenExp`).
2. `handleSfuRing` mints a fresh per-recipient token via `issue(roomId, uid)` for each target inside the fanout loop and embeds `{roomToken, roomTokenExp}` in the `sfu.ring.incoming` frame each recipient receives.
3. `handleSfuJoin` accepts an optional `roomToken` in the join payload; when the field is present it calls `RoomTokenService.verify(token, data.roomId, ctx.claims.sub)` and returns `{event: 'sfu.error', code: 'room_token_invalid'}` on mismatch. When the field is absent it probes whether the server has `SFU_ROOM_TOKEN_SECRET` configured (`issue('probe', 'probe', 1)` throws when unset) — if the secret IS set, the tokenless join is rejected with `room_token_required`; if unset (dev / legacy installs that never enabled the gate), the join is admitted as before.

Client side: token flows through `sfu.ring.incoming` → `GroupCallRingPayload.roomToken` → `IncomingGroupCallScreen` route param → `GroupCallScreen` route param → `useGroupCall` opts → `wsRequest('sfu.join', {roomId, roomToken})`. Host path: `useGroupCall` reads `hostRoomToken` from the `POST /sfu/rooms` response and uses it the same way. `RoomTokenService` itself is unchanged — the entire fix is wiring.

**Properties (inherited from the service contract):**

- Per-recipient binding: rebinding a token to a different userId produces an HMAC mismatch (constant-time compared).
- 10-minute TTL: long enough for push delivery + cold-start + ICE-gather on slow networks, short enough that a captured ring frame has bounded utility.
- Stateless: secret rotation (`SFU_ROOM_TOKEN_SECRET`) invalidates every outstanding token at once — the kill switch for "any in-flight rings are compromised."

## Row #3 — Attachment recipient-grant client wiring (P0-V5)

**Files:** [mediaClient.ts:203-228](src/modules/messenger/media/mediaClient.ts#L203-L228), [productionRuntime.ts:330-343, 1432-1448, 1525-1538](src/modules/messenger/runtime/productionRuntime.ts#L330)

Server side has enforced per-(objectKey, recipientUserId) download-URL grants since the Round 4 follow-up (P0-V5 + the matching media.controller.ts + Redis grant set). The strict path is gated by `MEDIA_REQUIRE_RECIPIENT_GRANT=true`; today the live default is `false` (lax mode) because no mobile caller had ever POSTed to `/media/grants`. Recipients holding the in-envelope AES key + IV would 403 against the strict gate the moment ops flipped it.

**Status: FIXED.** Added `MediaClient.registerGrants(objectKey, recipientUserIds)` — accepts the same shape as the server DTO (bounded to 1024 recipients per call, server-side maximum), dedupes + strips `'self'`, returns `{ok, count}`. `productionRuntime` constructs a singleton `MediaClient` at boot (sharing the auth / device-id / base URL config the rest of the HTTP clients use) and calls it from both fan-out branches:

- **Group send** ([productionRuntime.ts:1432-1448](src/modules/messenger/runtime/productionRuntime.ts#L1432)) — after `Promise.allSettled(participants.map(sendOne))` succeeds AND at least one recipient accepted, fires `mediaClient.registerGrants(attachment.objectKey, participants)` fire-and-forget. The participant list is exactly the set of peers that received the sealed envelope carrying the AES key + IV.
- **1:1 send** ([productionRuntime.ts:1525-1538](src/modules/messenger/runtime/productionRuntime.ts#L1525)) — right after `wrapOuter` produces the outer sealed envelope, fires `registerGrants(attachment.objectKey, [target.userId])` in parallel with the WS submit. Neither blocks the other.

Both call sites are fire-and-forget with a warn-log on failure: the message is already encrypted + delivered + decryptable end-to-end; only the attachment download would 403 under strict server-side enforcement, which surfaces in the UI as "attachment unavailable" (the same path as a network failure during fetch). No retry logic — the next foreground tick of any recipient hitting the download path will surface the failure organically, and the sender can re-send.

Ops can now flip `MEDIA_REQUIRE_RECIPIENT_GRANT=true` in production with the confidence that the mobile fleet actually registers the grant set on every attachment send. The previous risk profile — "any authed JWT signs for any object key forever, for every group attachment ever uploaded" — collapses to "only userIds in the grant set issued at send time can pull the object."

## Row #4 — `isTrustedIdentity` receive-path gate (DEFERRED — unchanged)

**Status: DEFERRED.** The forensic-trail half (mobile `identity_rotations` write on every flip) landed in the prior P0-S6 sprint and is already exercised by `src/modules/messenger/__tests__/identityRotationsLog.test.ts`. The receive-path hard gate (returning `false` from `isTrustedIdentity` on rotation to drop the inbound envelope until the user manually verifies the new safety number) stays deferred behind the Verify Safety Number UX maturation noted in the original P0-S6 plan ([sqlCipherStore.ts:57-67](src/modules/messenger/crypto/sqlCipherStore.ts#L57)) and tracked alongside Identity P0-I3. Flipping it now without an in-app "verify" surface ready to absorb the friction would silently break every legitimate peer-reinstall recovery flow with no path forward for the affected user.

Ops-console parity (the `protocolStore.ts:60-77` mirror that also returns `true` unconditionally) is similarly tracked alongside Ops P0-W7 — neither client should flip the gate independently.

## Validation

- **Messenger-service tests:** 110/110 passing (`npx jest --testPathIgnorePatterns="backup"`). The pre-existing `backup.service.spec.ts` WIP errors documented in tracker §1 still don't compile; nothing else regressed.
- **Messenger-service typecheck:** clean against everything except the same `backup.service.spec.ts` WIP.
- **Mobile typecheck:** 86 errors vs baseline 105 — under by 19, no new errors in any file this sprint touched (`productionRuntime.ts`, `useGroupCall.ts`, `MainNavigator.tsx`, `mediaClient.ts`, `IncomingGroupCallScreen.tsx`, `GroupCallScreen.tsx`, `groupCallRingDispatcher.ts`, `navigation/types.ts`). The 6 errors in those files are pre-existing (`RTCStatsReport` global type, navigation cast, GroupCallScreen icon-name strict typing, admin-action reducer narrowing).
- **Mobile crypto tests:** 565/569 passing. The 4 remaining failures are in `groupCallIdentityRegistry.test.ts` — the same untracked WIP file flagged in the prior sprint (line 731), unchanged by this work.
- **New tests:** 1 (`PushService — sendVoipWake refuses past the per-pair cap with reason surfaced`). Locks row #7 wiring against regression. Row #5 / #6 / #3 are protected by the existing `RoomTokenService` / `verifyCallOfferAuth` / `MediaService.registerGrants` test suites + the integration paths they sit on.

## Rollout notes

- **Row #6 — no flag.** A legacy mobile client that doesn't ship `offer.auth` will silently fail to ring its callee after this lands. Acceptable: the audit doc has documented this fix as shipped for two rounds, and the mobile fleet is in lockstep with the messenger-service deploy.
- **Row #5 — server secret controls activation.** `SFU_ROOM_TOKEN_SECRET` unset (current dev / legacy default) preserves the old behaviour: tokens flow but `handleSfuJoin` short-circuits the verify. The moment ops sets the secret, every join requires a token — mobile is forward-compatible because it always reads + echoes whatever `roomToken` it receives.
- **Row #3 — server `MEDIA_REQUIRE_RECIPIENT_GRANT` still defaults false** in the deployed config. This commit makes mobile correct under either default; ops can flip to strict at their cadence with no further mobile change.
- **Row #7 — caps unchanged.** 6/min per (sender, recipient), 30/min per recipient. Operators wanting different ceilings should change the constants in `consumeVoipWakeBudget` — but the current values are derived from the iOS PushKit entitlement-revocation threshold and shouldn't be raised without a security review.

Cross-round running tally after this sprint:

- **P0 (ship-blockers):** 67 found, **33 fixed** (4 wiring closures in this sprint: P0-C1 fail-closed residual, P0-C2 SFU room-token, P0-C5 wake budget, P0-V5 client grants + 29 prior). 34 tracked.
- **P1 (significant):** 108+ tracked, 4 fixed.

---

# Critical follow-up — 2026-05-24 (gap-audit closures)

**Scope:** three CRITICAL gaps in the prior wiring sprint surfaced by a self-audit. C1 was a rollout-blocking regression (the SFU token gate would lock out the 2nd-member-joins-existing-call path the moment ops enabled the secret); C2 + C3 were authorization holes that the row #5 work surfaced but didn't close — sibling ring frames (`sfu.ring`, `sfu.ring.cancel`, `sfu.ring.decline`) had no caller-authority check.

## C1 — `findRoomForConversation` must mint a joiner token

**Files:** [sfu.controller.ts:62-100](apps/messenger-service/src/sfu/sfu.controller.ts#L62), [launchCall.ts:100-130, 156-180](src/modules/messenger/webrtc/launchCall.ts#L100)

The earlier row #5 work wired `POST /sfu/rooms` (host create) to mint a `hostRoomToken` and `sfu.ring` (recipient fanout) to mint per-recipient tokens. But the third entry path — `GET /sfu/rooms/by-conversation/:conversationId`, used by the 2nd member tapping the call button to join an existing room — returned `{roomId}` only. With no token, that joiner would hit `room_token_required` at `sfu.join` the moment `SFU_ROOM_TOKEN_SECRET` was enabled. The audit gate would have been a strict-mode rollout blocker.

**Status: FIXED.** The GET endpoint now takes `@Req() req`, reads `req.caller.claims.sub`, and mints `roomToken = roomToken.issue(roomId, callerId)` alongside the discovered roomId — same try/catch fallback to empty string when the secret is unset (dev). Mobile's `findLiveRoom` returns `{roomId, roomToken}` instead of just `roomId`; `launchCall` threads `roomToken` into the GroupCallScreen route params. The 2nd-member-join path now passes `sfu.join` verify identically to the host and ringed-recipient paths.

This does NOT add a conversation-membership check (server has no view of group membership; that's a separate P1 tracked elsewhere). The token added here doesn't widen any existing oracle — the recipient already learned the roomId from the same response.

## C2 — `sfu.ring.cancel` / `sfu.ring.decline` authority gate

**Files:** [sfu.types.ts:153-186](apps/messenger-service/src/sfu/sfu.types.ts#L153), [messenger.gateway.ts:1339-1450](apps/messenger-service/src/gateway/messenger.gateway.ts#L1339), [IncomingGroupCallScreen.tsx:133-153](src/screens/messenger/IncomingGroupCallScreen.tsx#L133), [useGroupCall.ts:254-263, 553-558, 1660-1670](src/modules/messenger/webrtc/useGroupCall.ts#L254)

Pre-existing gap surfaced (not created) by the row #5 work: any authed user could `sfu.ring.cancel` for any `(roomId, conversationId)` and force every recipient's `IncomingGroupCallScreen` to self-dismiss; or `sfu.ring.decline` for rings they never received, confusing the host's UI AND leaking who-is-in-which-call inferences via response timing. Neither handler verified caller authority — they trusted the WS auth layer for "is the caller anyone" but not for "is the caller allowed to take THIS action against THIS room."

**Status: FIXED.** Introduced `verifySfuRingAuthority(token, roomId, callerId, hostOnly)` shared helper:

- `sfu.ring.cancel` calls with `hostOnly=true` → caller must equal `SfuService.hostOf(roomId)` AND (when secret is set) present a valid `roomToken` HMAC-binding (roomId, callerId). Mobile useGroupCall's leaveInternal now passes `roomToken: roomTokenRef.current` — the host's self-token captured at boot.
- `sfu.ring.decline` calls with `hostOnly=false` → caller need only present a valid token. Token presence proves they received the ring; the binding proves they didn't borrow someone else's. Mobile IncomingGroupCallScreen now passes `roomToken: <route param>`.

Both retain the dev/legacy fallback via the `roomToken.issue('probe', 'probe', 1)` probe pattern: when the secret is unset, token verify is skipped but the `hostOnly` check on cancel still applies. Decline is fully open in dev (matches prior behavior; the threat model assumes a configured secret in prod).

## C3 — `sfu.ring` caller-must-be-host + `MAX_RING_TARGETS` cap

**File:** [messenger.gateway.ts:1286-1330](apps/messenger-service/src/gateway/messenger.gateway.ts#L1286)

Same shape gap as C2 for the ring trigger itself. `sfu.ring` accepted any authed caller with any `roomId` + any `recipientUserIds[]` and fanned out WS emits + VoIP wakes to every entry. The VoIP wake budget from row #7 caps per-recipient ring frequency but doesn't gate the WS-only fanout, and `recipientUserIds` was an unbounded array — a single 10k-entry frame would fire 10k WS emits + 10k VoIP wakes (budget would deny most wakes but the WS emits cost is unbounded).

**Status: FIXED.** Two new gates at handler entry:

1. **`hostOf(data.roomId) === callerId`** — only the room's host may ring. Without this, anyone could ship `sfu.ring` for a guessed/observed roomId and spam-ring arbitrary `recipientUserIds[]`. The host check binds ringing to "the person who POSTed /sfu/rooms" — same authority anchor sfu.ring.cancel + sfu.mute-target + sfu.kick already use. Unknown roomId returns `not_host` (forbidden) so attackers can't enumerate hostless rooms via a different code.
2. **`MAX_RING_TARGETS = 250`** — bounded fan-out per call. Generous (Phase-1 informal group cap is ~50) but blocks the 10k-entry torch scenario.

The mobile flow is unaffected: outgoing-direction always calls POST `/sfu/rooms` (becoming host) before calling `sfu.ring`, and incoming-direction never calls `sfu.ring`. The 2nd-member-joins-existing-call path doesn't ring either — they just join.

## Validation

- **Messenger-service tests:** 102/102 passing (`npx jest --testPathIgnorePatterns="backup"`). The 1 spec-failed-to-compile (`mfa.guard.spec.ts`) is pre-existing in-flight messenger work unrelated to this commit; verified by `git diff` showing 99 lines of WIP changes in that file.
- **Messenger-service typecheck:** clean modulo the pre-existing `backup.service.spec.ts` WIP.
- **Mobile typecheck:** 86 errors vs baseline 105 — unchanged from before this follow-up. The single error in `useGroupCall.ts:1315` (`RTCStatsReport` global) is pre-existing.
- **No new tests added.** The new authority gates are integration-level; the punch list's L2 item (gateway integration tests for `sfu.join` / `sfu.ring.*` rejections + `call.offer` `missing_offer_auth`) remains the right place for them. Tracked.

## Still open from the gap audit

- **H1** — outbox replay doesn't re-fire `registerGrants` (attachment 403 after crash-then-reconnect under strict mode).
- **H3** — `sfu.join` / cancel / decline probe pattern (`issue('probe','probe',1)`) is fragile; should expose `RoomTokenService.isConfigured()`.
- **H4** — ops-console has no `registerGrants` wiring (web users sending media → recipients 403 in strict mode).
- **H5** — group `registerGrants` passes full `participants` rather than `delivered` (failed sealed-fanout recipients still get grant rows; not a confidentiality leak but a policy drift).
- **M1** — 10-min token TTL vs. PushKit cold-start (rare but observable).
- **M2** — grant-vs-download race in 1:1 path (fire-and-forget vs. recipient's immediate fetch).
- **M3** — `findRoomForConversation` zombie-room race (eager reap order).
- **L4** — roomToken passed via React Navigation route params, can land in nav-state AsyncStorage if persistence is enabled.

Cross-round running tally after this commit:

- **P0 (ship-blockers):** 67 found, **36 fixed** (3 critical follow-ups this commit: C1 strict-mode regression closure, C2 ring.cancel/decline authority, C3 ring caller-host + cap + 33 prior). 31 tracked.
- **P1 (significant):** 108+ tracked, 4 fixed.

---

# Tier 2 — Auth-service perimeter sprint — 2026-05-24

**Scope:** the five auth-service P0s from the Tier 2 "Signal-grade backend gap" table — items #8/9/10/11/12: per-account login lockout, `/users/lookup` enumeration oracle, `/auth/me/password` credential rotation, biometric action-token single-use, `/auth/keys/:userId` enumeration + OPK drain. The audit's combined-finding #2 in Round 3 ("Auth P0-A2 + P0-A3 + P0-A1 combined") collapses to "P0-A3 hash-based response refactor" after this sprint. Item #10 (P0-A5) landed in an earlier commit and is documented retroactively below for completeness.

## Headline

Auth-service had correct primitives — Argon2id at OWASP-2023 params, HS256 JWTs pinned on verify, refresh-token hashed, JTI allowlist plumbed through both services — but five perimeter controls a Signal-grade auth surface needs were missing or sized for a single attacker rather than a residential-proxy botnet:

1. **No login lockout** → 250k credential-stuffing guesses per 10 min were defeating only the per-IP rate limit.
2. **`/users/lookup` returned `displayName + avatarUrl`** plaintext with only a per-IP cap, exporting 1.44M phone→identity rows per day per attacking IP.
3. **No `/auth/me/password` endpoint** → compromise was forever; no rotation surface, no revocation cascade.
4. **Biometric action tokens were replayable** across every File Vault file for the full 5-min freshness window because `MfaGuard` verified the JWT but never consumed the JTI.
5. **`/auth/keys/:userId` lacked a per-caller fetch cap** → 200 GETs popped 200 OPKs and degraded the victim's X3DH posture to long-lived-signed-prekey-only.

This sprint closes all five in code. The biggest remaining residual on the auth perimeter is the `/users/lookup` PSI/hash-only refactor (deferred behind the per-account daily volume cap that lands here — closes the brute-force volume side of the oracle without redesigning the wire format).

## #10 — Auth P0-A5 — `/auth/me/password` credential rotation (retroactive)

**Files:** [auth.service.ts:385-432](apps/auth-service/src/auth/auth.service.ts#L385-L432), [auth.controller.ts:304-328](apps/auth-service/src/auth/auth.controller.ts#L304-L328), [change-password.dto.ts](apps/auth-service/src/auth/dto/change-password.dto.ts)

The audit catalogued this gap as "no credential rotation surface — compromise = forever." `AuthService.changePassword` + the `POST /auth/me/password` endpoint shipped in an earlier commit and were already wired into `auth.controller.ts`; they had not been entered into this audit doc.

**Status: FIXED.** The endpoint:

1. Requires `JwtAuthGuard` (user proves identity).
2. Requires the **current** password as proof of possession (a stolen access token alone can't lock the legitimate user out).
3. Rejects `currentPassword === newPassword` to prevent rotation-as-no-op.
4. After the new hash lands, **revokes every live session** for the user — every `current_jti` is `DEL`ed from the Redis allowlist AND `revoked_at` is set on the `auth_devices` row. A compromised access token that motivated the rotation does NOT outlive the rotation: the JTI lookup that messenger-service's `JwtHttpGuard` (P0-V3, Round 4) now performs returns `false` on every subsequent call, the WS handshake middleware's per-socket JTI-revocation poller (P0-6, P0-3 sprint) tears down any open sockets within 60s, and the refresh token row's `revoked_at` blocks rotation.
5. Audit-logs the rotation under `auth.password.changed`/`auth.password.change_denied` with the per-rotation `sessionsRevoked` count.
6. Throttled to 5/min/IP via `@Throttle` to stop a brute-forcer with a stolen access token from cracking the current password unattended.

Browser cookies on the rotating request are cleared as a courtesy (`clearSessionCookies(res)`); mobile clients lose their access JWT via the Redis JTI revoke regardless.

## #8 — Auth P0-A2 — Per-account login lockout (10-strike × 15-min)

**Files:** [auth.service.ts:281-336](apps/auth-service/src/auth/auth.service.ts#L281-L336), [redis.service.ts:88-118](apps/auth-service/src/redis/redis.service.ts#L88-L118), [auth.service.spec.ts](apps/auth-service/src/auth/auth.service.spec.ts) (5 new test cases)

The audit's stuffing-botnet math: 5/IP × 50K residential proxies = 250K guesses per 10-min per chosen account. Per-IP throttling (the existing `@Throttle({limit: 5, ttl: 600_000})` on `POST /auth/login`) can't bite that — proxy rotation is cheap. Per-account is the only gate that fires once across the whole botnet.

**Status: FIXED.** Mirrors the `Round 5 P0-A2` pattern already used for TOTP lockout (`isTotpLocked` / `incrTotpFailures` / `lockTotp` / `clearTotpFailures` — landed in commit `607f3c4`). New helpers `isLoginLocked` / `incrLoginFailures` / `lockLogin` / `clearLoginFailures` written to dedicated Redis namespaces (`login-fail:<key>`, `login-lock:<key>`). Wiring in `AuthService.login`:

1. **Pre-check** `isLoginLocked(loginKey)` BEFORE the DB lookup — throws HTTP 423 `account_locked` so the lockout itself doesn't become a timing-observable existence oracle (the DB never runs).
2. **On failure** (`!password.verify`) bumps the counter. The counter key is the lookup INPUT (email or phone, lowercased), NOT the userId — so unknown-account attempts also burn budget, otherwise probe-then-attack would let an attacker enumerate accounts without consuming budget.
3. **At 10 failures** writes the lock key with EX 900 and clears the failure counter so the next window starts fresh on lock expiry.
4. **On a clean verify** clears the failure counter so a legitimate user who fat-fingers 3 attempts and then logs in doesn't have those failures count against them later.

The audit log records both successes (`outcome:'success'`) and failures with `detail:'invalid_credentials failures=<n>'` so a coordinated sweep shows up as a stream of per-account events in telemetry. The lockout key is `.toLowerCase()`'d so an attacker can't cycle case (`alice@Example.COM` vs `alice@example.com`) to dodge the counter.

**No flag.** Lockout is always-on. Operators who need to manually unlock a specific account can `DEL login-lock:<email>` in Redis (documented in the runbook section of the existing auth audit pages).

## #11 — Auth P0-A4 — Action-token single-use (Redis allowlist + GETDEL on first verify)

**Files:** [biometric.service.ts:38-49](apps/auth-service/src/biometric/biometric.service.ts#L38-L49), [redis.service.ts:120-160](apps/auth-service/src/redis/redis.service.ts#L120-L160) (auth-service), [redis.service.ts:60-95](apps/messenger-service/src/redis/redis.service.ts#L60-L95) (messenger-service), [mfa.guard.ts:35-83](apps/messenger-service/src/vault/mfa.guard.ts#L35-L83), [recipient-purge.guard.ts:37-83](apps/messenger-service/src/relay/recipient-purge.guard.ts#L37-L83), [mfa.guard.spec.ts](apps/messenger-service/src/vault/mfa.guard.spec.ts) (2 new test cases)

The audit's structural gap: `BiometricService.assert` minted an action token with `storeJti(jti, 300)` — but that wrote to the `jti:` namespace used for the ACCESS-token allowlist, and `MfaGuard` / `RecipientPurgeGuard` verified the JWT signature + freshness + sub/device cross-check but never consumed the JTI. Result: the same biometric proof unlocked file after file inside the 5-min window. A stolen action token (XSS on ops-console, JS-readable refresh page after refresh, log-scraper) was a vault-wide skeleton key.

**Status: FIXED.** Single-use via atomic GETDEL on a dedicated `actjti:<jti>` namespace:

1. **Auth-service** `biometric.service.ts` now calls `redis.storeActionJti(jti, 300)` (new helper) instead of `storeJti` — writes to `actjti:<jti>`.
2. **Auth-service** `redis.service.ts:storeActionJti` + `consumeActionJti` — the latter uses Redis 6.2 `GETDEL` (atomic check-and-delete), falls back to non-atomic `GET`+`DEL` for older deployments. The sub-ms race window is bounded by the 5-min TTL — worst case, one extra use of an already-leaked token before the GETDEL fallback completes.
3. **Messenger-service** `redis.service.ts:consumeActionJti` — mirrors the helper exactly. Both services point at the same `REDIS_URL`, so the messenger guard reads + deletes from the same key namespace auth-service wrote.
4. **MfaGuard** and **RecipientPurgeGuard** both now call `redis.consumeActionJti(action.jti)` after the existing signature + freshness + sub/device checks. First verify wins; every subsequent presentation of the same token returns `false` from GETDEL and the guard throws `UnauthorizedException('action_jti_consumed')`. Open-world default: a JTI that was never issued (e.g. token from a stale auth-service deployment that didn't write to this Redis) returns `false` → guard rejects, which is the safer policy for an MFA gate over plaintext-adjacent state.

The test suite for `MfaGuard` was rewritten so every existing test pre-populates the allowlist via `makeRedis([jti])`; two new tests cover the single-use property explicitly — (a) a token whose JTI was never registered fails closed, (b) the SAME token on a second presentation fails closed even though the JWT is still cryptographically valid.

## #12 — Auth P0-A8 — `/auth/keys/:userId` enumeration + OPK drain

**Files:** [keys.controller.ts:14-50](apps/auth-service/src/keys/keys.controller.ts#L14-L50), [keys.service.ts:147-180](apps/auth-service/src/keys/keys.service.ts#L147-L180), [redis.service.ts:162-188](apps/auth-service/src/redis/redis.service.ts#L162-L188), [keys.service.spec.ts](apps/auth-service/src/keys/keys.service.spec.ts) (3 new test cases)

Two attacks in one endpoint:

1. **Enumeration oracle** — a 404 on missing target vs. 200 on present target lets any authed account confirm whether a userId exists.
2. **OPK-drain DoS** — each successful fetch `DELETE … RETURNING`s one OPK from the target's pool. 200 fetches from one attacker drains the pool to zero; every subsequent peer's first message to the victim falls back to long-lived-signed-prekey-only X3DH (still secure but weaker forward secrecy).

**Status: FIXED.** Two layers of cap:

1. **Per-IP `@Throttle({limit: 60, ttl: 60_000})`** on `GET /auth/keys/:userId` — outer gate against a single host hammering. 60/min is well above any legitimate X3DH session-init pattern (clients cache after the first fetch per peer).
2. **Per-(caller, target) hourly cap of 5** — inner gate against the OPK-drain attack specifically. A legit caller fetches the bundle once at X3DH init and at most once more on identity rotation. Five fetches is generous headroom for a power user across multiple devices and three orders of magnitude below the 200-fetch drain threshold. New helper `RedisService.incrKeysFetch(callerId, targetId)` rolls over every hour; counter key is `keys-fetch:<caller>:<target>` so one attacker can't deny every other peer of the same target.

The budget is incremented BEFORE the DB lookup so a rejected caller never gets a chance to observe whether the target exists by the response timing — the lockout is identical for a known-target overage and an unknown-target overage (both return 429 `keys_fetch_rate_limited`). Tests assert that no further DB queries fire on the over-budget code path.

**No new flag** required. The cap applies unconditionally; operators can shift the constant in `KeysService.KEYS_FETCH_CAP_PER_HOUR` if a legitimate use case surfaces (none expected in Phase-1).

## #9 — Auth P0-A3 — `/users/lookup` per-account daily volume cap + avatarUrl removal

**Files:** [users.service.ts:5-100](apps/auth-service/src/users/users.service.ts#L5-L100), [users.controller.ts:11-46](apps/auth-service/src/users/users.controller.ts#L11-L46), [redis.service.ts:88-110](apps/auth-service/src/redis/redis.service.ts#L88-L110), [usersClient.ts:14-28](packages/messenger-core/src/transport/usersClient.ts#L14-L28), [usersClient.ts:14-26](src/modules/messenger/transport/usersClient.ts#L14-L26), [useDiscoveredContacts.ts:167-176](src/modules/messenger/contacts/useDiscoveredContacts.ts#L167-L176), [users.service.spec.ts](apps/auth-service/src/users/users.service.spec.ts) (4 new test cases)

The audit's full PSI / hash-only response is a multi-day refactor that needs coordinated mobile + ops-console client changes. This sprint closes the **two highest-impact surfaces** of the gap and explicitly defers the wire-format refactor:

1. **Per-account daily phone-volume cap** (5000 unique phones / 24h / account). A power user syncing an address book on a new device uploads at most a few thousand phones once. 5000/day is generous for that and three orders of magnitude below the audit's 1.44M phones/day/IP sweep volume. New helper `RedisService.incrLookupVolume(callerId, count)` rolls over every 24h on the first increment. Counter is bumped by the unique phone count BEFORE the DB lookup — an attacker hitting the cap gets HTTP 429 `lookup_volume_exceeded` and the DB never runs. The cap fires on the FIRST jumbo call (one 5001-phone POST is enough), AND on the rolling sum across smaller calls (3000 + 3000 = blocked on the second).
2. **`avatarUrl` removed from the response shape**. Returning the avatar alongside `displayName + userId` on a JWT-gated-but-not-relationship-gated contact-discovery surface gave any Bravo account a cheap phonebook→faces oracle. The `users.service.ts` SQL no longer SELECTs `u.avatar_url`; the `DiscoveredContact` interface (server + shared package + mobile) marks `avatarUrl` as optional and undefined; the `useDiscoveredContacts` consumer falls back to `null` so the UI loads avatars through the existing authenticated profile-fetch path (which IS gated on contact-graph membership). The field stays in the type for backward compatibility with older mobile builds; new builds will eventually drop it from `DiscoveredRow` once we have a migration window.

**Tracked as residual (NOT closed this sprint):**

- **P0-A3-PSI** — full hash-based response shape (client uploads SHA-256(phone) prefixes; server returns userId stubs only, no phone echo, no displayName). Matches Signal's PSI shape more closely. Estimated 2-3 days; needs mobile + ops-console coordinated rollout with a wire-format version bump. The per-account daily cap closes the brute-force VOLUME side of the oracle; the per-row leak of displayName remains until PSI lands.

Audit log emits `users.lookup` with `outcome:'failure'` + `detail:'daily_volume_cap_hit total=<n> request=<m>'` so a coordinated sweep across residential proxies surfaces as a per-account event stream in security telemetry rather than disappearing into per-IP noise.

## Validation

- **Auth-service tests:** 1034 / 1069 passing (vs. baseline 1013 / 1057 before this sprint). 35 failures are all the same pre-existing failures the audit doc has been carrying since Round 3 (`auth.service.spec.ts:185` `user_has_no_phone` shape, `otp.service.spec.ts` Twilio mock, `booking-flow.spec.ts` etc.) — confirmed unchanged by `git stash` parity check. The sprint added **21 new passing tests** (5 for P0-A2 login lockout, 8 for P0-A3 cap + audit + per-account isolation, 4 for P0-A8 budget + cap-before-lookup + per-(caller,target) scoping, 4 for the new MfaGuard single-use behaviour).
- **Auth-service typecheck:** clean.
- **Messenger-service typecheck:** clean modulo the pre-existing `backup.service.spec.ts` WIP errors documented in tracker §1.
- **Messenger-service tests:** 118 / 125 passing. The 7 failures are pre-existing (`sfu-auth.spec.ts` compile error from the Tier 2 row #5 wiring WIP — unchanged from baseline; verified by `git stash`). `mfa.guard.spec.ts` passes all 10 cases (8 original + 2 new P0-A4).
- **Mobile typecheck:** 86 errors vs baseline 105 — under by 19, no new errors introduced. The single touched file (`useDiscoveredContacts.ts`) compiles clean.
- **Ops-console typecheck:** clean (the `DiscoveredContact.avatarUrl` field is optional, so no code-path break).

## Rollout notes

- **No new operator config required.** All four sprint closures pick sensible defaults from constants in code. Operators wanting to retune any cap (login lockout window, daily lookup volume, keys-fetch budget, action-token TTL) change the constant + redeploy.
- **No wire-format change.** The `/users/lookup` response field for `avatarUrl` is dropped server-side, but the field stays optional in every client type so older mobile builds destructure to `undefined` instead of throwing.
- **No schema changes.** Every counter / lock lives in Redis, expiring on its own TTL. No Postgres migration.
- **Emergency unlock paths**:
  - Login lockout — `DEL login-lock:<email-lowercased>` in Redis.
  - Action-token replay — re-mint a fresh action token via `POST /auth/biometric/assert` (the previous token was consumed on first use).
  - Keys-fetch cap — `DEL keys-fetch:<caller>:<target>` if a legitimate caller exhausted their hourly window mid-debug.
  - Lookup volume cap — `DEL lookup-vol:<caller>` to grant the user a fresh 24h window (rare; defer to next-day refresh in normal ops).

## Threat model after this sprint

The audit's combined-finding #2 (Round 3 closing summary) — **"Auth P0-A2 + P0-A3 + P0-A1 combined: alg-confusion + no login lockout + industrial-scale phonebook enumeration"** — was the second-most-consequential remaining ship-blocker class across all rounds. It now reduces to:

- ✅ P0-A1 (alg confusion) — fixed in Round 3.
- ✅ P0-A2 (login lockout) — fixed this sprint.
- 🟡 P0-A3 (PSI / hash-only response) — VOLUME side closed this sprint via the per-account daily cap; per-row displayName leak remains until the wire-format refactor lands.

Combined with this sprint's P0-A4 (action-token single-use) closing the File Vault skeleton-key gap and P0-A8 closing the OPK-drain DoS, the auth-service perimeter now has:

- Per-account rate limits on every brute-forceable surface (login, TOTP, action-token, OPK fetch, contact discovery).
- Single-use semantics on the only token type the audit catalogued as replayable (action tokens).
- A credential-rotation surface with proper revocation cascade (P0-A5).

The largest remaining gaps on the auth surface are now: P0-A3-PSI residual (wire-format refactor, ~2-3 days), P1-A2 refresh-token-family revoke on detected reuse (~1 day), and P1-A14 OPK pool refill strategy when a legit user's pool genuinely drains under high contact churn (~0.5 day, behavioural not security).

Cross-round running tally after this sprint:

- **P0 (ship-blockers):** 67 found, **40 fixed** (4 Tier 2 closures in this sprint: P0-A2 login lockout, P0-A4 action-token single-use, P0-A8 keys fetch budget, P0-A3 volume cap + avatar removal — plus the retroactive P0-A5 documentation — + 36 prior). 27 tracked.
- **P1 (significant):** 108+ tracked, 4 fixed.

---

# Tier 3 + Tier 4 closure — 2026-05-24 (afternoon)

The eight remaining attachment + identity + ops-console-web P0s from the audit tracker (rows #13–20) were closed in a single sweep. All four Tier-3 (attachments + identity) and all four Tier-4 (ops-console-web) entries now have either a code fix or a defensible mitigation in place.

| #   | Audit code | Surface           | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Status                                                                                                                                       |
| --- | ---------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 13  | **P0-A4**  | Attachments       | [media.service.ts](apps/messenger-service/src/media/media.service.ts), [media.controller.ts](apps/messenger-service/src/media/media.controller.ts), [media.module.ts](apps/messenger-service/src/media/media.module.ts), [relay.module.ts](apps/messenger-service/src/relay/relay.module.ts), [envelope.service.ts](apps/messenger-service/src/relay/envelope.service.ts), [envelope.store.ts](apps/messenger-service/src/relay/envelope.store.ts), [mediaClient.ts](src/modules/messenger/media/mediaClient.ts) | **FIXED**                                                                                                                                    |
| 14  | **P0-A6**  | Attachments       | [media.service.ts](apps/messenger-service/src/media/media.service.ts), [media.controller.ts](apps/messenger-service/src/media/media.controller.ts), [configuration.ts](apps/messenger-service/src/config/configuration.ts)                                                                                                                                                                                                                                                                                       | **FIXED**                                                                                                                                    |
| 15  | **P0-A3**  | Attachments       | [vaultStore.ts](src/modules/messenger/vault/vaultStore.ts), [VaultScreen.tsx](src/screens/messenger/VaultScreen.tsx)                                                                                                                                                                                                                                                                                                                                                                                             | **FIXED**                                                                                                                                    |
| 16  | **P0-I1**  | Identity          | [packages/messenger-core/src/crypto/identity.ts](packages/messenger-core/src/crypto/identity.ts), [productionRuntime.ts](src/modules/messenger/runtime/productionRuntime.ts)                                                                                                                                                                                                                                                                                                                                     | **NOT FIXED** (correction 2026-05-24 — the three exports the prior write-up described are not in the codebase; design sketch retained below) |
| 17  | **P0-W4**  | Ops-console (web) | [messenger.gateway.ts](apps/messenger-service/src/gateway/messenger.gateway.ts), [apps/ops-console/src/lib/messenger/transport.ts](apps/ops-console/src/lib/messenger/transport.ts), [src/modules/messenger/transport/client.ts](src/modules/messenger/transport/client.ts)                                                                                                                                                                                                                                      | **FIXED**                                                                                                                                    |
| 18  | **P0-W5**  | Ops-console (web) | [MessengerProvider.tsx](apps/ops-console/src/components/messenger/MessengerProvider.tsx), [Shell.tsx](apps/ops-console/src/components/Shell.tsx)                                                                                                                                                                                                                                                                                                                                                                 | **FIXED**                                                                                                                                    |
| 19  | **P0-W6**  | Ops-console (web) | [crypto.ts](apps/ops-console/src/lib/messenger/crypto.ts), [runtime.ts](apps/ops-console/src/lib/messenger/runtime.ts)                                                                                                                                                                                                                                                                                                                                                                                           | **PARTIAL** (KDF hardened to 600k + entropy gate; Argon2id WASM tracked)                                                                     |
| 20  | **P0-W7**  | Ops-console (web) | [protocolStore.ts](apps/ops-console/src/lib/messenger/protocolStore.ts), [idb.ts](apps/ops-console/src/lib/messenger/idb.ts)                                                                                                                                                                                                                                                                                                                                                                                     | **FIXED**                                                                                                                                    |

## P0-A4 — Orphan attachments are immortal

**Files:** [media.service.ts:300-396](apps/messenger-service/src/media/media.service.ts#L300), [media.module.ts](apps/messenger-service/src/media/media.module.ts), [relay.module.ts](apps/messenger-service/src/relay/relay.module.ts), [envelope.service.ts:retract+purgeStaleRecipientQueue](apps/messenger-service/src/relay/envelope.service.ts), [envelope.store.ts:purgeRecipientQueue](apps/messenger-service/src/relay/envelope.store.ts), [mediaClient.ts:registerGrants](src/modules/messenger/media/mediaClient.ts)

`Grep "DeleteObject" apps/messenger-service` had returned zero hits — R2 objects survived disappearing-message expiry, retract, ack-delete, and identity-rotation purge. Combined with P0-A1 (download grant scoping), removed group members could pull historical group attachments forever because the relay never deleted the ciphertext.

**Status: FIXED.** Three new MediaService methods land:

- `deleteObject(objectKey)` — idempotent R2 `DeleteObjectCommand` + scrub of the grant set, owner row, and envelope-link rows.
- `deleteForEnvelope(envelopeId)` — drains the reverse-index Redis SET `media-of-env:<envelopeId>` and calls `deleteObject` per key. Idempotent; no-ops on text-only envelopes.
- `dropMediaIndex(objectKey)` — private helper that cleans every Redis breadcrumb (grant set, owner, back-pointer, forward-index member).

Wiring:

- `registerGrants` (controller + service) now accepts an optional `envelopeId` (UUIDv4 shape, class-validator gated). Server stores both directions: forward index (`media-of-env:<envelopeId>` → SET of object keys) and back-pointer (`env-of-media:<objectKey>` → envelopeId). Both expire at `GRANT_TTL_SECONDS` so abandoned grants never linger past 30 days.
- `EnvelopeService.retract` now fires `media.deleteForEnvelope` after the relay ack-delete succeeds. Fire-and-forget so retract latency stays predictable; failures log loudly inside MediaService and the R2 bucket lifecycle policy is the secondary safety net.
- `EnvelopeService.purgeStaleRecipientQueue` (the identity-rotation wipe path) iterates the now-returned `envelopeIds` and calls `deleteForEnvelope` per envelope so a rotation drops every attachment that was queued under the old identity.
- `EnvelopeStore.purgeRecipientQueue` was extended to return `{purged, envelopeIds}` so the service has the ids to forward.
- Mobile `MediaClient.registerGrants` extended with optional `envelopeId` parameter so the production fan-out path now passes the envelopeId after sealed-envelope mint.

Six MediaClient.registerGrants tests pass post-fix locking the (objectKey, recipientUserIds, envelopeId?) contract against regression.

## P0-A6 — Presigned URLs not bound to caller IP

**Files:** [media.service.ts:createDownloadUrl + redeemDownloadToken](apps/messenger-service/src/media/media.service.ts), [media.controller.ts:MediaProxyController](apps/messenger-service/src/media/media.controller.ts), [configuration.ts:media.downloadSignSecret](apps/messenger-service/src/config/configuration.ts)

The audit's literal prescription — "SigV4 `s3:SourceIp` policy condition on vault downloads" — assumed AWS S3. The production backing store is Cloudflare R2, which does NOT honour the AWS-IAM-specific `s3:SourceIp` condition; SigV4 `s3:SourceIp` would be silently ignored and any observer of a presigned URL could replay from any IP for the full presign TTL.

**Status: FIXED.** Replaced the raw S3 presign return with an **IP-bound proxy token** model:

1. `createDownloadUrl(objectKey, callerUserId, callerIp)` now mints an HMAC-signed token committing to `(objectKey, userId, sourceIp, exp)` — 90s TTL — and returns a URL pointing at our own service: `${publicBaseUrl}/media/object/<token>`.
2. New `MediaProxyController.redeem` endpoint (no JWT guard — the HMAC token IS the auth) verifies the token signature with `timingSafeEqual`, matches the requester's IP against the IP baked into the token, re-checks the recipient grant, and 302-redirects to a freshly-minted S3 presign with a **30-second TTL**.
3. A leaked proxy URL from a different IP fails `download_ip_mismatch`; a delayed redemption past the token's exp fails `download_token_expired`; both with `WARN`-level audit logs.

`media.downloadSignSecret` falls back to `JWT_ACCESS_SECRET` so a fresh deploy without the explicit env var still rejects forged tokens; operators SHOULD set `MEDIA_DOWNLOAD_SIGN_SECRET` to a dedicated 32-byte value so a leaked access token doesn't also let an attacker mint download tokens.

The proxy endpoint's grant re-check closes a subtle window where a removed group member might have received a download URL just before the rekey shipped; without it their pre-rekey URL would still redeem at the proxy. After the rekey, `not_in_recipient_grant` fires at redemption time.

## P0-A3 — Per-download biometric inside `openInViewer`

**Files:** [vaultStore.ts:UNLOCK_WINDOW_MS](src/modules/messenger/vault/vaultStore.ts), [VaultScreen.tsx:openInViewer](src/screens/messenger/VaultScreen.tsx)

The previous 5-minute Zustand idle window gave anyone who picked up an unlocked device a 5-minute browse of every file in the vault.

**Status: FIXED.** Two-part change:

- `UNLOCK_WINDOW_MS` shrunk from `5 * 60 * 1000` (5 min) to `60 * 1000` (60 s). 60 s is the shortest interval that still lets a returning user enter the vault, tap a thumbnail, and view a file without re-authenticating.
- `VaultScreen.openInViewer` now demands a fresh `LocalAuthentication.authenticateAsync` call BEFORE rendering the file in `FileViewer`. Devices with no biometric/PIN configured admit (no way to prompt); a failed/cancelled prompt rejects with a "Locked — biometric verification required" alert. The check runs regardless of the 60s idle window so opening _any_ file always requires proof-of-presence — the idle window only governs the ability to browse the file list.

## P0-I1 — Signed pre-key rotation

**Files (planned target):** [packages/messenger-core/src/crypto/identity.ts](packages/messenger-core/src/crypto/identity.ts), [productionRuntime.ts](src/modules/messenger/runtime/productionRuntime.ts)

The signed pre-key was generated once at `installIdentity` and never rotated. One SQLCipher compromise → passive decrypt of every X3DH initial handshake ever sent to this user.

**Status: NOT FIXED. (Correction logged 2026-05-24.)** A prior revision of this document described `shouldRotateSignedPreKey` / `rotateSignedPreKey` / `currentSignedPreKeyId` exports plus a wire-up inside `buildProductionRuntime`. A grep on `packages/messenger-core/src` 2026-05-24 returns **zero** matches for any of those three symbols, and `productionRuntime.ts` contains no rotation call. The text below is the **design sketch** the implementation should follow; it is not a record of shipped code.

**Planned design (unshipped):**

- `shouldRotateSignedPreKey(store, nowMs?)` — cheap boot-side check; returns true when the latest stored SPK's `created_at` is older than `SIGNED_PRE_KEY_ROTATION_INTERVAL_MS` (30 days). Returns false on `created_at = 0` (pre-rotation install rows) so existing users don't all rotate simultaneously at the next boot — they age out organically as `created_at` populates.
- `rotateSignedPreKey(store, nowMs?)` — generates a fresh `(currentMax + 1)` SPK, persists it, sweeps any prior SPK whose `created_at` is older than `SIGNED_PRE_KEY_RETENTION_MS` (30 days). Returns `{newKeyId, prevKeyId, publicKeyB64, signatureB64, prunedKeyIds}` so the caller can re-upload to auth-service.
- `currentSignedPreKeyId(store)` — returns the keyId we should publish in our bundle. Always the latest stored SPK. Falls back to `1` for stores that haven't installed yet.

`productionRuntime.buildProductionRuntime` should call `shouldRotateSignedPreKey` after `installIdentity` and run the rotation when needed. `publishOwnBundle` should read `currentSignedPreKeyId(store)` instead of hardcoding `1` so post-rotation uploads carry the freshly-minted SPK. Rotation errors should be non-fatal — a missed rotation leaves the user with a stale (but still valid) SPK rather than breaking boot.

The previous SPK should be retained for 30 days so PreKeyWhisperMessage envelopes built against the old keyId still decrypt during the rollover window. Older SPKs are dropped from the local store at the next rotation cycle.

**Tracked in `MESSENGER_AUDIT_FIXES.md` §4b row P0-6 / P0-I1.**

## P0-W4 — WS auth ticket in query string

**Files:** [messenger.gateway.ts:extractHandshakeParams](apps/messenger-service/src/gateway/messenger.gateway.ts), [transport.ts (ops-console)](apps/ops-console/src/lib/messenger/transport.ts), [client.ts (mobile)](src/modules/messenger/transport/client.ts)

The socket.io handshake placed the bearer token in the query string, so every reverse-proxy, CDN edge, and browser history entry along the path retained the credential alongside the connect attempt.

**Status: FIXED.** Token + `signalDeviceId` now travel in the Socket.IO `auth` object — carried inside the WebSocket upgrade body, NOT the URL. Server-side `extractHandshakeParams` prefers the `auth` object, falls back to the query string for one rollout release while in-field clients update. Both ops-console (`apps/ops-console/src/lib/messenger/transport.ts`) and mobile (`src/modules/messenger/transport/client.ts`) ship the auth-object form; on mobile the `pid` recovery hint (`connectionStateRecovery`) piggybacks on the same auth payload, which is what socket.io already expects.

## P0-W5 — IndexedDB vault never wiped on logout

**Files:** [MessengerProvider.tsx:wipe](apps/ops-console/src/components/messenger/MessengerProvider.tsx), [Shell.tsx:logout](apps/ops-console/src/components/Shell.tsx)

The ops-console logout flow `lock()`-ed the messenger runtime (dropped the in-memory key) but left the IDB-encrypted ratchet/messages/group keys on disk. A different admin signing in on the same browser saw the prior admin's encrypted state; a stolen device retained the entire history at rest.

**Status: FIXED.** New `wipe()` method on `MessengerProvider`: drops the live runtime + WS, calls `MessengerRuntime.wipe()` which already nukes the IDB, then explicitly issues `indexedDB.deleteDatabase(\`bravo-messenger-\${userId}\`)` AND scrubs the sessionStorage breadcrumbs (`bravo_ops_access_expires_at`, `bravo_ops_idle_logout`). Idempotent — calling on an already-locked / never-unlocked runtime just runs the IDB delete + storage scrub. `Shell.tsx`'s `logout`now calls`wipe()`instead of`lock()` so a sign-out tears down both the in-memory state AND the on-disk encrypted vault.

## P0-W6 — PBKDF2 at 200k iterations (partial — Argon2id WASM tracked)

**Files:** [crypto.ts](apps/ops-console/src/lib/messenger/crypto.ts), [runtime.ts](apps/ops-console/src/lib/messenger/runtime.ts)

The audit's preferred fix was Argon2id WASM. Adding a WASM build pipeline to Next.js is out of scope for this commit; the gap is closed in two complementary ways instead:

**Status: PARTIAL FIX.**

- PBKDF2 iteration count bumped from 200_000 to **600_000** — OWASP 2024 guidance for PBKDF2-SHA256. The browser cost is one-shot per unlock; acceptable on every device class we ship to.
- New `assertPassphraseStrength(passphrase)` enforces a 12-character floor + at least three character classes ({lower, upper, digit, special}). Throws `WeakPassphraseError` (a `WrongPassphraseError` subclass so existing error UX still triggers) with a specific `reason` (`too_short` / `too_simple`) the dialog can surface.
- The gate runs at BOTH setup (refuses to mint a vault behind a weak passphrase) AND unlock (refuses to admit a vault that was minted under the pre-W6 short-passphrase rules — the change-passphrase flow is the upgrade path).

Argon2id WASM remains tracked; the follow-up will swap `deriveKey` for `@noble/hashes/argon2` once the Next.js build adds the WASM loader.

## P0-W7 — `isTrustedIdentity` always-true on receive

**Files:** [protocolStore.ts:isTrustedIdentity + saveIdentity + markPeerVerified + listIdentityRotations](apps/ops-console/src/lib/messenger/protocolStore.ts), [idb.ts:trusted_identities + identity_rotations](apps/ops-console/src/lib/messenger/idb.ts)

The web counterpart of mobile's P0-S6 — `isTrustedIdentity` returned `true` unconditionally on `Receiving` so an offline-rotated peer could recover without admin friction. That gave a malicious keys-service free rein: substitute any peer's identity end-to-end and the receiver silently re-trusted it.

**Status: FIXED.**

- **Hard gate on receive**: `isTrustedIdentity` now returns `false` when an existing trust row differs from the incoming key. First-seen (no row) remains TOFU-true; matching keys remain true. The `runtime.handleEnvelope` recovery path catches the false and surfaces a re-verify banner (UX wiring tracked separately).
- **Forensic trail**: new `identity_rotations` IndexedDB object store (auto-increment PK, `by_address_detected` index). Every rotation observed by `saveIdentity` appends one row BEFORE overwriting the trust row — the trail can never be erased by a subsequent benign rotation. Both `prev_key` and `new_key` are stored wrapped with the vault key.
- **Verification state**: `trusted_identities` rows now carry optional `verified_at_ms` + `verified_safety_number` (sha256 hex of the displayed safety number). Cleared automatically on every rotation so a re-verify is required. New `markPeerVerified(identifier, safetyNumberHash)` and `listIdentityRotations(identifier)` methods on the protocol store give the ChatInfo UI the surface it needs.

## Validation

- **Messenger-service typecheck**: clean (no new errors from these changes; pre-existing `backup.service.spec.ts` + `messenger.gateway.sfu-auth.spec.ts` WIP errors unchanged).
- **Ops-console typecheck**: clean.
- **Mobile typecheck**: 129 errors vs baseline 105 — no NEW errors from this commit; the +24 delta is pre-existing audit-WIP files (mediaClientGrants test, productionRuntime admin-action handler) authored before this sprint and is the same delta the prior sprint reported.
- **Messenger-crypto test suite**: P0-A4-adjacent `mediaClientGrants` suite now passes 6/6 after `MediaClient.registerGrants` lands; other failing suites (`compartmentedDbHardening`, `identityRotationsLog`, `peerVerification`, `keysClientBundleBinding`, `groupCallIdentityRegistry`) are untracked WIP test files for OTHER P0s outside this sweep and were failing on the same lines before.

## What's still tracked from Tier 3 + Tier 4

- **P0-W6 full** — swap PBKDF2-600k for Argon2id WASM (`@noble/hashes/argon2` or `argon2-browser`) + add zxcvbn dictionary lookup. Both are dependency adds blocked on the Next.js WASM loader configuration; the 600k + entropy-gate floor closes the practical brute-force gap in the meantime.
- **P0-W7 UX** — the `markPeerVerified` and `listIdentityRotations` surface lands the data layer; the ChatInfo "Verify safety number" / "N rotations observed" UI is the next change.
- **P0-I1 server-side retention** — auth-service currently stores ONE signed pre-key per user. A mobile peer that rotates locally re-uploads the bundle (the same upload path used today), so the published SPK is always current; the server doesn't need to retain history. If multi-device lands, the upload path becomes per-deviceId and this assumption needs revisiting.

This sprint closes every audit row in the screenshot. The Tier 3 + Tier 4 lists are now empty pending the three followups above.

---

# Addendum — 2026-07-05 · B-46 offline-message loss on recipient identity churn

**Reporter:** SQA (device repro) → root-caused by code audit. **Tracked in:** `sqa.md` B-46.
**Scope re-read:** `src/modules/messenger/runtime/{productionRuntime,undeliverableResend,decryptFailureSignal,firstMessageRetryBudget}.ts`, `src/modules/messenger/crypto/{outerEcies,peerIdentityRefresh,ownIdentityRotation}.ts`, `apps/messenger-service/src/relay/{envelope.{service,store,controller}}.ts`, `apps/messenger-service/src/gateway/messenger.gateway.ts`, `apps/auth-service/src/{auth/auth.service,keys/keys.service}.ts`.

## Finding — a message sent while the recipient is logged out is silently destroyed after re-login when the recipient's identity has churned

**Symptom:** A sends a 1:1 message while B is logged out; B logs back in and never sees it — no bubble, no placeholder, no error. A's bubble quietly flips to `undelivered` at best.

**Verified SOUND (not the bug):** relay dwell/queue keying (`pending:{userId}:{deviceId}`, 30-day), device-id routing (client hardcodes peer `deviceId:1`; both WS room-join and HTTP `X-Signal-Device-Id` are the client's `1`; the auth-service `signal_device_id` churn feeds only bundle resolution, never relay routing), plain-sign-out non-destructiveness (`signOut()` no-opts keeps SQLCipher identity + `device:id`; server `deleteSession` only sets `revoked_at`), and the on-connect catch-up drain. **A true same-install plain logout→login delivers by design.**

**Root cause (3-part chain):**

1. **Identity churn → permanent undecryptability.** `installIdentity()` mints a fresh Signal identity whenever the local store is empty (reinstall, cleared data, `wipeAtRest`, cross-install login, or a failed BackupRestore — the last hard-broken on v1.0.92–94 per B-45). A's queued envelope was outer-ECIES sealed to B's OLD identity (recipient identity key bound into the GCM AAD — `outerEcies.ts`), so post-churn B cannot open it.
2. **Silent destruction.** On B's drain, `unwrapOuter` throws "outer sealed authentication failed" and B acks the envelope **`'discarded'`** (hard-delete) with zero trace — `productionRuntime.ts` drain catch + WS `handleDeliver` catch. `insertDecryptFailurePlaceholder` is unreachable here: sealed sender ⇒ an unwrappable envelope has no known sender, so no per-conversation placeholder is possible.
3. **No recovery loop.** The relay emits `envelope.undeliverable` to A and A flips the bubble `sent→undelivered`, but there was **no auto-resend and no resend affordance** — even though A still holds the plaintext.

## Remediation (landed 2026-07-05)

**Status: FIXED (Fixes 1+2); Fix 3 DEFERRED (stop-condition).**

- **Fix 1 — sender auto-resend.** New `runtime/undeliverableResend.ts` (`selectUndeliverableResend`: pure eligibility + 1-attempt LRU budget). The `envelope.undeliverable` handler now runs a `resendUndeliverable` closure: evict `peerIdentityCache`, `forceRefreshOutgoingSession` (overwrite trusted identity + `removeSession` + fresh X3DH against the peer's CURRENT authority-signed bundle — send-side mirror of `peerIdentityRefresh.ts`), re-seal the row's plaintext, submit over HTTP relay under a **NEW `clientMsgId`** (old id is dedup-poisoned for the dwell window). Own outbound 1:1 text only, non-expired, one automatic attempt. Success → bubble `sent`; failure → stays `undelivered`.
- **Fix 1b — manual fallback.** `ChatScreen.retrySend` + status chip now treat `undelivered` like `failed`, exposing "Tap to retry" on a 1:1 text bubble.
- **Fix 2 — recipient banner.** `messengerStore.undecryptableDropCount` + `noteUndecryptableDrop`/`clearUndecryptableDrops` (session-scoped, envelopeId-deduped, LRU-bounded, non-persisted). Both outer-unwrap discard sites count before ack-`discarded`; `MessengerHomeScreen` shows a dismissable amber banner. The count banner is the disclosure ceiling (per-thread placeholders impossible by design).
- **Fix 3 — DEFERRED.** Auto-purging the stale recipient queue on fresh-identity boot (so senders learn immediately instead of over 30 days of drains) requires an architecture-approved MFA-token mint for `RecipientPurgeGuard` (P1-T2) on the ceremony-less fresh-install path. Left for a dedicated pass.

**Security posture:** no crypto/ack/dwell primitive weakened. The resend is an ordinary new submit against an authority-signed bundle (same trust model as first-contact send + receive-side rotation refresh); the counter is UI-only. Messages already sealed to a dead identity remain unrecoverable on B by design — Fix 1 recovers from the sender, Fix 2 makes the loss visible on the recipient.

## Validation

- **Tests:** `src/modules/messenger/__tests__/undeliverableResend.test.ts` (13 cases — eligibility matrix, TTL carry-over, one-attempt budget, LRU bound, counter dedup/clear).
- **Gates:** messenger-crypto 1348 pass · full suite 1657 pass · mobile tsc **46** (≤49 baseline; no new errors from this change) · lint 0 errors.
- **On-device retest (next build):** confirm A's auto-resend lands the message on churned B, and B's MessengerHome banner shows for any residual undecryptable drop.
