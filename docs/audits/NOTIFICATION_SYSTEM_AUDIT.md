# Notification & Messaging System Audit — Bravo Secure

**Audit type:** Complete industry-level audit (notifications, messaging, calling, background execution, sockets, Signal protocol, Android/iOS platform, security, performance, scalability).
**Scope:** React Native 0.81 / Expo SDK 54 mobile client, `messenger-service` (NestJS) relay + WS gateway + push, `auth-service` push bridge, `packages/messenger-core` shared crypto, native Android (Kotlin), iOS config.
**Method:** Static code audit across the whole repo. **No code was modified.** All findings carry `file:line` evidence; the highest-severity claims were re-verified directly against source.
**Date:** 2026-07-04 · **Branch/commit:** `main` @ `52452cb`
**Rule observed (audit phase):** the audit above was produced AUDIT-ONLY. A subsequent **remediation session** (logged in the _Remediation Log_ at the end of this file) then fixed the safe, verifiable subset and documented what remains blocked. The per-domain sections above describe the code **as audited**; see the Remediation Log for what changed since.

---

# Executive Summary

Bravo Secure has a **genuinely strong, well-tested Android 1:1 messaging-and-calling crypto core** (sealed-sender v2, AAD binding, HMAC-signed VoIP wakes, WS offer-auth, atomic receive transactions, ratchet snapshots, owner-epoch isolation, possession-proof acks). Around that core sit **serious, systemic gaps** in exactly the layers this audit targets: background delivery survival, notification UX, iOS, multi-device, observability, and horizontal scaling. Several are outright ship-blockers for a "millions of users" messenger.

The app today is best described as a **hardened Android-first staging build**, not a release candidate for WhatsApp/Signal/Telegram parity.

| Metric               | Value        |
| -------------------- | ------------ |
| **Overall Score**    | **42 / 100** |
| **Production Ready** | **No**       |
| **Critical Issues**  | **7**        |
| **High**             | **20**       |
| **Medium**           | **24**       |
| **Low**              | **13**       |

**The seven ship-blockers (detailed in _Critical Issues_):**

1. **Full Redis keyspace `SCAN` on every push send** — O(total-keys) per message; collapses at 100k+ users (`push.service.ts:194,414,438,619,1020-1029`).
2. **iOS is entirely non-functional** — no `ios/` project ever generated, no Firebase iOS config, PushKit dep not installed, kill-switches hard-off, no APNs env. No chat notifications, no calls, no badges on iOS.
3. **Release APK is signed with the public debug keystore** (`android/app/build.gradle:128`) — not shippable to Play, trivially re-signable.
4. **`expo prebuild` drift is a live landmine** — regenerating `android/` from `app.json` strips ~23 hand-added permissions, re-enables cleartext HTTP, and deletes the force-added native call/FrameCryptor modules.
5. **Killed-app headless handler silently drops SOS / mission / booking / agent wakes** ("unknown kind, no action", `fcmHeadless.ts:106`) — safety-critical for an app that has an SOS feature.
6. **socket.io `connectionStateRecovery` is dead** — the `SessionAwareRedisAdapter` that implements `restoreSession` is never wired (`session-aware-redis-adapter.ts` has zero importers); every reconnect is a cold session.
7. **A second-device login is a data-loss event** — client hardcodes `deviceId:1`, server serves last-writer-wins identity; the other device's queued messages become permanently undecryptable.

---

# Architecture Review

**Topology.** Mobile client ⇄ (socket.io WS `/ws` + HTTP relay) ⇄ `messenger-service` (NestJS, Redis-backed, socket.io Redis adapter) ⇄ FCM/APNs. `auth-service` publishes booking/agent/SOS push events over a Redis channel that `messenger-service` forwards. Group A/V uses a mediasoup SFU; 1:1 A/V is P2P WebRTC over the same WS for signalling. Local store is SQLCipher. Shared crypto lives in `packages/messenger-core` and is the **live** code path.

**What's sound.**

- Clean module separation on the client (`push/`, `runtime/`, `transport/`, `crypto/`, `webrtc/`, `store/`, `backup/`).
- **Owner-epoch isolation** (`productionRuntime.ts:207-248`) cleanly gates every async frame/timer/callback against login/logout races — a strong pattern.
- **Atomic receive transaction** (`receiveTransaction.ts:39-133`) wraps ratchet-advance + plaintext upsert + seen-dedup in one `BEGIN IMMEDIATE`, with rollback — partial-failure safe.
- Backend uses **Lua-atomic** mailbox operations, replica-locked crons, possession-proof ack tokens, and JTI-based session revocation on the WS handshake.

**Structural liabilities.**

- **Two divergent duplicate trees.** `src/modules/messenger/crypto/*` and `src/modules/messenger/transport/*` are older forks; the runtime imports the `@bravo/messenger-core` copies. The mobile `crypto/identity.ts` even **lacks the signed-prekey-rotation primitives** the production copy has. The Jest suite (`handshake.test.ts`, `ratchet.test.ts`, `sealedSender.test.ts`, `strictIdentityTrust.test.ts`, etc.) validates the **non-production** copy — the two can drift while tests stay green (`crypto/index.ts:3`, `transport/certCache.ts:1`).
- **Prebuild drift** (Critical #4): `android/` is gitignored with a handful of files force-added; `app.json` and the hand-edited native tree have diverged hard.
- **Per-pod in-memory state** on the gateway (`callSessions`, `sfuTagToSocket`, `socketCalls`, `typingTimers`) does not survive horizontal scale-out without sticky sessions (`messenger.gateway.ts:244-251`).
- Notification/call reliability depends on native Kotlin files that `expo prebuild --clean` has already deleted twice historically (documented in `B-32_CALL_FOREGROUND_SERVICE_HANDOFF.md`).

---

# Notification Audit

### Libraries & wiring

- **FCM** via `@react-native-firebase/messaging ^21.14.0`; **local display** via `@notifee/react-native ^9.1.8`; **Telecom/CallKit** via `react-native-callkeep ^4.3.16`. No `expo-notifications`, no `react-native-push-notification`. `react-native-voip-push-notification` is **imported but not installed** (resolves to null at runtime).
- Background handler registration at bundle entry: `setBackgroundMessageHandler(handleHeadlessFcm)` then `installSlimNotifeeBgHandler()` (`index.js:46,50`), **before** login. After login, `fcmBootstrap.ts:813` installs a richer `setBackgroundMessageHandler` that **replaces** the slim one (RNFirebase keeps only the last).

### Token lifecycle

- `getToken()` at `fcmBootstrap.ts:120`; `onTokenRefresh` at `:152-160` (properly cleared on logout `:649`). Uploaded to **messenger-service** `POST /push/register` and `/push/register-voip` (`:669-695`); deleted on logout via `DELETE` (`unregisterPush.ts:39-46`). VoIP wake HMAC key captured from register response into Keychain.
- **Single-device only** — `X-Signal-Device-Id` hardcoded `'1'` everywhere.

### Permissions

- Android 13 `POST_NOTIFICATIONS` requested in **two** uncoordinated places (onboarding `PermissionsScreen.tsx:60`, bootstrap `fcmBootstrap.ts:79`) → possible double-prompt.
- **iOS permission is never requested** (`fcmBootstrap.ts:106-110` explicitly skips it; `PermissionsScreen.tsx:93-94` returns `'granted'` without asking).
- Denial is logged and ignored — no re-prompt, no settings deep-link, no "notifications off" UI.

### Channels (Android, all `IMPORTANCE_HIGH`)

- `bravo-incoming-call` (sound + vibration, category CALL, **fullScreenAction**), `bravo-messages`, `bravo-call-foreground` (silent LOW), plus lazy `booking-updates`/`agent-updates`/`sos-alerts`.
- **Duplicate `bravo-messages` definitions drift** — `fcmBootstrap.ts:766` omits `vibration`, `callNotification.ts:108` sets `vibration:true`; channel settings are immutable after first create, so behavior depends on install order.
- **BYPASS_DND intentionally off** (`callNotification.ts:87-88`) — a call in Do-Not-Disturb won't ring (WhatsApp/Signal request the override).

### Message handlers per app state

| State                 | Chat push                                                                                                             | Call push                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Foreground**        | **Nothing** — no `messaging().onMessage` handler exists anywhere. Relies on live WS + in-app UI.                      | Ring via live WS `call.offer`.                                                                  |
| **Background (warm)** | notifee banner `'New message' / 'New encrypted message'` + best-effort `pullEnvelopes()` (`fcmBootstrap.ts:939-971`). | HMAC-verified → Telecom + notifee full-screen. **Group wake mishandled** (see below).           |
| **Killed (headless)** | notifee banner only, **no envelope pull** (`fcmHeadless.ts:92-98`).                                                   | notifee ring only — no Telecom, no payload cache, no tombstone check (diverges from warm path). |

### Privacy of previews — **good**

Previews are generic (`'New message' / 'New encrypted message'`); the server never sends sender name or content in `data` (`push.service.ts:479-483`). No plaintext leaks to the notification layer.

### Missing vs WhatsApp/Signal (all absent)

- No unread count, **no app-icon badge** (`setBadgeCount` unused).
- No **MessagingStyle / Person / avatar**; messages are plain title/body.
- No **inline reply** action, no **mark-as-read** action.
- No **summary/group** notification — each conversation is an independent banner with no parent.
- No **dismiss-on-read** — `msg-wake:${convId}` is never cancelled when the thread is opened (a `dismissCallNotif` exists for calls but there is no message equivalent).
- No **foreground/in-app banner** for messages in other conversations.
- **White-blob status-bar icon** — every notification uses the full-color `ic_launcher` as its small icon; there is no monochrome `ic_stat_*` and the FCM `default_notification_channel_id` meta-data is empty.

### Notification bugs

| Sev    | Finding                                                                                                                                                                                                            | Evidence                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| High   | Killed-app tap has **no cold-launch routing** — `getInitialNotification` / `onNotificationOpenedApp` are never called; slim bg handler only acts on `data.callId`, so a message tap lands on home, not the thread. | repo-wide (0 hits); `callNotification.ts:270-282` |
| High   | Killed-app **drops all non-call/non-chat wakes** (SOS/mission/booking/agent/opaque) → "unknown kind, no action".                                                                                                   | `fcmHeadless.ts:106`                              |
| Medium | Calls **ignore mute**; **blocked users** still ring/banner (no block check anywhere in `push/`).                                                                                                                   | `fcmBootstrap.ts:833`; `fcmHeadless.ts:37`        |
| Medium | No foreground `onMessage` → no in-app message notification while app open in another chat.                                                                                                                         | repo-wide                                         |
| Medium | notifee foreground/background event subscriptions never torn down (returns discarded, `notifeeHandlersInstalled` not reset on logout).                                                                             | `fcmBootstrap.ts:643-644`                         |
| Low    | Double `POST_NOTIFICATIONS` prompt; duplicate `bravo-messages` channel vibration drift; divergent `msg-wake:` vs `bravo-msg-` banner IDs won't collapse across kill→warm.                                          | as above                                          |

---

# Calling Audit

### 1:1 core — **strong and well-tested**

Symmetric 45s ring timeout (`callRingState.ts:33`), terminal-state guards (`callController.ts:1139-1156`), per-callId send ordering with hangup chained behind offer (`signallingClient.ts:192-282`), ICE-restart budget/retry for reconnect, cache tombstoning, WS-offer identity binding (`callOfferAuth.test.ts`), HMAC VoIP-wake verification with persisted replay-nonce LRU and fail-closed default (`voipWakeVerify.ts`). These are covered by real tests.

### Incoming call per app state

- **Open:** WS `call.offer` → dispatcher → `CallScreen`.
- **Background/killed/locked:** FCM `voip-wake` → HMAC verify → notifee full-screen ring (`bravo-incoming-call`, category CALL, `loopSound`, `timeoutAfter:45s`, `fullScreenAction`) + Telecom `displayIncomingCall` on Android. The ring is drawn **without** booting the JS runtime/SQLCipher/WS; the real SDP arrives only when the WS reconnects.

### Calling bugs

| Sev    | Finding                                                                                                                                                                                                                                                                                                                                                                    | Evidence                                            |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| High   | **Lock-screen window flags are dead code.** `MainActivity` gates `setShowWhenLocked/setTurnScreenOn/requestDismissKeyguard` on intent extra `EXTRA_CALL_LAUNCH` — **nothing ever sets it** (verified: the constant appears only in `MainActivity.kt`, defined + read, never put on an intent). A call answered on a locked phone may render behind the keyguard.           | `MainActivity.kt:49,77`                             |
| High   | **Group-call warm-background wake mishandled** — `fcmBootstrap.ts:871-888` hardcodes `callKind='voice'` and drops `roomId/fromUserId`, so a group-call push to a warm-backgrounded app rings as a 1:1 voice call and Accept opens a peerless dead `CallScreen`. The killed-app handler (`fcmHeadless.ts:66-74`) reads these fields — inconsistent behavior warm vs killed. | `fcmBootstrap.ts:871-888`                           |
| High   | **Glare not resolved** — when A and B call each other simultaneously, each auto-replies `busy` (`MainNavigator.tsx:398-409`); **both calls fail.** No callId tie-break.                                                                                                                                                                                                    | `MainNavigator.tsx:398-409`                         |
| High   | **CallKit event listeners duplicate across logout→login** — `installCallKitEventHandlers` discards the unsubscribe and `stopFcmBootstrap` resets the guard without unsubscribing → second `answerCall`/`endCall` listener; a decline can send `call.hangup` twice.                                                                                                         | `fcmBootstrap.ts:218,666`                           |
| Medium | **No missed-call notification** — only an in-thread bubble is written; after the 45s ring auto-dismisses a backgrounded user sees nothing.                                                                                                                                                                                                                                 | `CallScreen.tsx:1231-1274`                          |
| Medium | **Telecom `setup()` reportedly returns false on Android** → all bridge methods no-op and notifee becomes the sole ringer (Bluetooth routing / lock-screen system UI / recents silently unavailable).                                                                                                                                                                       | `callKitBridge.ts:261` (B-27/B-32 §12)              |
| Medium | **Mic-type FGS start relies on Accept foregrounding the app** — a purely-background accept path would throw `ForegroundServiceStartNotAllowed`; degraded silently.                                                                                                                                                                                                         | `BravoCallForegroundModule.kt:36-40`                |
| Medium | **Multi-device / "answered elsewhere" unimplemented** — `answeredElsewhere` codes exist but nothing drives them; single hardcoded `deviceId=1`.                                                                                                                                                                                                                            | `callKitBridge.ts:102,346`                          |
| Medium | Killed-app **decline can't reach caller** if WS isn't up (fire-and-forget over live transport) → caller rings to timeout.                                                                                                                                                                                                                                                  | `fcmBootstrap.ts:548-551`                           |
| Low    | `controller.onMissedCall`/`ringTimeoutMs` never wired by `useCall`; single shared FGS `active` boolean with no ref-count; headless verify uses `selfUserId:''` degrading per-user replay dedup.                                                                                                                                                                            | `useCall.ts:513-767`; `callForegroundService.ts:36` |

### iOS calling — **non-functional** (see iOS Audit).

### Reference (known device bugs from `sqa.md`)

- **B-24:** 1:1 call dies on background→resume — FG service keeps the process but not the connection; ICE-restart deadlocks at `have-local-offer` (no rollback in the retry path). Still open.
- **B-05:** group-call keepalive `ack_timeout:ping` — server `ping` handler returns an event-shaped response so the NestJS socket.io adapter never invokes the ack callback. Media rides the "dead" WS; keepalive is 100% failing.

---

# Signal Protocol Audit

**Solid:** X3DH + Double Ratchet via `@privacyresearch/libsignal-protocol-typescript`; sealed-sender v2 with extended AAD binding recipient+ts+sender+conversation+group+epoch (`sealedSender.ts:39-56`); per-peer `withLock` serialization preventing ratchet corruption; ratchet-snapshot backup with HMAC-tagged monotonic seq and no-overwrite-live-session rule; `sessionWipeProtection` (P0-1 forged-outer-envelope defense); persistent `seenEnvelopeStore` replay dedup (35-day retention > 30-day dwell); authority-anchored peer-identity rotation.

| Sev      | Finding                                                                                                                                                                                                                                                          | Evidence                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Critical | **Second-device login = data loss** — client never calls `fetchDevices`; hardcodes `deviceId:1`; legacy `fetchBundle` serves last-writer-wins identity (`ORDER BY updated_at DESC`). The other device's queued envelopes fail `unwrapOuter`.                     | `transport/keysClient.ts:15-18`; `keys.service.ts:168-174,266-267`   |
| High     | **No Signal-style resend-request / retry-receipt protocol.** A genuinely lost ratchet message (post-reinstall, glare-loser, dead session) stays a **tombstone** ("Ask the sender to resend") until the user manually asks; the heal only fixes _future_ traffic. | `decryptFailureSignal.ts:83-110`; `productionRuntime.ts:5097-5175`   |
| High     | **Group-stash permanent loss** — stashing group text that arrives before its key **ACKs the relay** (client owns durability); a member who never gets the key is fail-closed, not drained, and the row is pruned at 30 days = silent permanent loss.             | `pendingGroupEnvelopeStore.ts:33-41`; `bootGroupStashDrain.ts:30-36` |
| Medium   | **OPK concurrent-fetch race** — the one-time-prekey pop uses an unlocked sub-select (no `FOR UPDATE SKIP LOCKED`); two simultaneous senders can collide → the loser silently degrades to signed-prekey-only X3DH (weaker forward secrecy, no telemetry).         | `keys.service.ts:199-201`                                            |
| Medium   | **Ratchet-snapshot restore gap** — if the snapshot backend endpoints aren't deployed, every reinstall reports `no_snapshot` and all in-window inbound is permanently lost with only a counter.                                                                   | `ratchetSnapshot.ts:23-27`; `sessionRatchetRecovery.ts:54-59`        |
| Medium   | **No end-to-end message ordering** — no per-message sequence numbers; threads render by wall-clock. Only the group _epoch_ is monotonic (orders admin state, not messages).                                                                                      | `groupCrypto.ts:228`                                                 |
| Medium   | **TOFU default does not block sends on identity change** — strict mode is opt-in and blocks receives only; no forced key-change confirmation UI before the next send.                                                                                            | `sqlCipherStore.ts:106-116`                                          |
| Medium   | **Skipped-message-key handling fully delegated to libsignal** — no configured `MAX_SKIP` cap/tuning/audit anywhere; out-of-order tolerance is whatever the library defaults to.                                                                                  | `sqlCipherStore.ts:447`                                              |
| Medium   | **Prekey exhaustion is silent** — server returns `oneTimePrekey:null`, client falls back to signed-prekey-only with no signal that it happened; replenishment is low-water (<10) only, no proactive/timer refill.                                                | `keys.service.ts:241`; `productionRuntime.ts:4015-4044`              |

---

# WebSocket Audit

**Client** (`packages/messenger-core/src/transport/client.ts`): socket.io v4, `transports:['websocket']`, JWT+deviceId in the WS upgrade `auth` body; single-flight token refresh on `unauthorized`/`token_revoked` with `MAX_UNAUTH_REFRESH=4`; native reconnect (`Infinity` attempts, 500ms→30s backoff, 0.5 jitter) **plus** a manual capped-exponential server-reconnect; NetInfo-driven route-change reconnect; AppState-driven resume; persisted PID/offset for session recovery. Owner-epoch guards prevent stacked handlers. This layer is careful.

**Server gateway:** engine.io ping 30s / timeout 25s; app-level `ping`/`pong` with RTT; atomic Redis presence counters with supersession handling; `flushPendingOnConnect` paginated drain (20k ceiling); possession-proof `envelope.ack`; typing auto-stop; Redis adapter for horizontal emit; replica-locked crons; per-socket token bucket + per-user cluster fixed-window; 60s JTI recheck.

| Sev                  | Finding                                                                                                                                                                                                                                                                                                                                                                             | Evidence                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Critical             | **`connectionStateRecovery` is dead.** It's configured, but the `SessionAwareRedisAdapter` that implements `restoreSession` is never wired (zero importers). The stock adapter's no-op `restoreSession` is in effect → every reconnect is a fresh session; queued packets/typing/presence are not replayed.                                                                         | `redis-io.adapter.ts:94-97`; `session-aware-redis-adapter.ts:1-42` |
| High                 | **Cross-pod 1:1 calls break** — `callSessions`/`sfuTagToSocket`/`socketCalls`/`typingTimers` are per-pod in-memory `Map`s. Without sticky sessions, `call.answer`/`call.ice`/`call.hangup` hitting a pod with no session are silently dropped (`{ignore:true}`).                                                                                                                    | `messenger.gateway.ts:251,1999-2018`                               |
| High                 | **Unmetered high-cost handlers** — `envelope.pull`, `typing`, `read-receipt`, `presence*` have limits defined in `DEFAULT_WS_LIMITS` but **never call `rateGate`**. Unmetered `envelope.pull` (ZRANGEBYSCORE + pipeline GET of up to 1000 envelopes) is a DoS/amplification vector.                                                                                                 | `ws-rate-limiter.ts:141-145` vs handlers                           |
| Medium               | **Duplicate-ciphertext via ack watchdog** — send ships identical `outerSealed` over WS; if no `envelope.accepted` in 5s it re-ships over HTTP with a **new `envelopeId`**. `seenEnvelopeStore` is keyed by `envelopeId`, so it can't dedup it → the receiver's second `own.decrypt` throws bad-MAC (ratchet-corruption hazard). Safe **only if** the relay dedups by `clientMsgId`. | `productionRuntime.ts:2453-2464`; `seenEnvelopeStore.ts:41-47`     |
| Medium               | **Presence false-offline** — presence counter TTL is 1h refreshed only on connect; a stable socket >1h gets flipped offline by the reaper; a multi-device DECR underflow can broadcast offline while a second device is still online.                                                                                                                                               | `presence.service.ts:107,116-125`                                  |
| Medium               | **Read receipts lost on reconnect flush drop** — flushed best-effort with no ack and cleared after emit.                                                                                                                                                                                                                                                                            | `productionRuntime.ts:965-972`                                     |
| Medium               | **B-05:** `ping` handler returns an event-shaped object → NestJS socket.io adapter routes it as a new event and never calls the ack → `emitWithAck('ping')` times out 100%.                                                                                                                                                                                                         | `messenger.gateway.ts:704`                                         |
| Medium (latent High) | **Stale transport fork** — `src/modules/messenger/transport/*` is an orphaned older copy missing offset-recovery, superseded handling, server-reconnect, and the refresh cap; an import/bundler slip regresses reconnect silently.                                                                                                                                                  | `transport/client.ts:290-294`                                      |
| Low/Medium           | **Zombie `connected` window** — the 4s app heartbeat send is catch-swallowed and never flips state; a Doze-frozen fd can buffer for ~25s (until engine heartbeat) while showing `connected`.                                                                                                                                                                                        | `productionRuntime.ts:1187,1136-1145`                              |

---

# Background Execution Audit

This is the **weakest** area of the system. Delivery is **100% dependent on high-priority FCM**; there is no background sync layer of the app's own.

| Sev    | Finding                                                                                                                                                                                                                                                                                             | Evidence                                     |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| High   | **Rebooted/killed device does not connect or drain** — no `BOOT_COMPLETED` receiver of the app's own, no foreground/data-sync service, no WorkManager/JobScheduler/AlarmManager job. After reboot nothing connects until the user opens the app; delivered/read ticks can't advance.                | `index.js:34-50`; no app-owned boot receiver |
| High   | **No battery-optimization / OEM-autostart handling at all** — no `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, no `isIgnoringBatteryOptimizations()` prompt, no Xiaomi/Oppo/Vivo/Huawei autostart guidance. On aggressive OEMs the frozen process receives FCM late or never → missed calls and messages. | grep: 0 matches in `src/`                    |
| High   | **Headless path is intentionally banner-only** — `handleHeadlessFcm` does **not** boot the runtime/SQLCipher/WS; `msg-wake` draws a banner and does **not** pull envelopes. Killed-app decrypt/sync is deferred by design.                                                                          | `fcmHeadless.ts:82-104`; `index.js:41-45`    |
| High   | **Attachment upload has no durable queue and no resume** — `sendMedia` does a single-shot `uploadEncrypted` before the outbox row exists; plaintext bytes are memory-only. App killed mid-upload → the whole send is lost with no retry.                                                            | `productionRuntime.ts:2487`                  |
| Medium | **No adaptive heartbeat** — fixed 4s app ping regardless of foreground/background; useless under Doze (can't run while frozen) and wasteful when foregrounded.                                                                                                                                      | `productionRuntime.ts:1179-1197`             |
| Info   | **Send outbox is durable and correct** — SQLCipher `outbox` with composite PK, exponential backoff `[1s,4s,15s,60s,5m]`, `MAX_ATTEMPTS=10`, poison-message parking, boot + reconnect + 60s-timer re-drain. This is the one background surface that is genuinely robust (for text).                  | `sqlOutboxStore.ts:59-237`                   |

---

# Android Audit

| Sev                     | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Evidence                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Critical                | **Release APK signed with the public debug keystore** — `release` buildType uses `signingConfig signingConfigs.debug`. Not shippable to Play; any "release" APK is trivially re-signable.                                                                                                                                                                                                                                                               | `android/app/build.gradle:128`                        |
| Critical (if triggered) | **Prebuild drift** — `app.json` lists 7 Android permissions; the hand-edited manifest declares ~30. A `expo prebuild` from `app.json` would **drop** `POST_NOTIFICATIONS`, all typed FGS, `USE_FULL_SCREEN_INTENT`, and every CallKeep/Telecom permission, **re-enable cleartext HTTP** (`usesCleartextTraffic:true` in `expo-build-properties` vs `false` in the manifest), and delete the force-added `CallForegroundService.kt`/FrameCryptor Kotlin. | `app.json:35-43,74-77` vs `AndroidManifest.xml`       |
| High                    | **White-blob notification icon** — every notifee notification sets `smallIcon:'ic_launcher'` (full-color); Android renders the small icon as a monochrome mask, so every ring/message/FGS notification shows a solid white blob. No `ic_stat_*` exists; FCM `default_notification_channel_id` is empty.                                                                                                                                                 | `callNotification.ts:199,203`; merged manifest        |
| High                    | **Android 14+ FSI grant may be withheld** — `USE_FULL_SCREEN_INTENT` is auto-granted on 14+ only for core calling/alarm apps. As a non-default-dialer app the grant can be denied → `fullScreenAction` degrades to a heads-up and lock-screen ringing stops. No in-app `canUseFullScreenIntent()` detection.                                                                                                                                            | `callNotification.ts:226-229`                         |
| High (policy)           | **AD_ID + Firebase Analytics enabled** on a self-described secure messenger, plus several high-scrutiny dangerous permissions (`ACCESS_BACKGROUND_LOCATION`, `SYSTEM_ALERT_WINDOW`, `WRITE_CONTACTS`, `CALL_PHONE`). Data-safety-form contradiction / Play review risk.                                                                                                                                                                                 | `build.gradle:242`; merged manifest L163-165          |
| Medium                  | **`RNCallKeepBackgroundMessagingService` exported without permission guard** — any app can bind/start it.                                                                                                                                                                                                                                                                                                                                               | `AndroidManifest.xml:126-128`                         |
| Medium                  | **R8/minification off + no keep rules** for notifee/CallKeep/RNFirebase — larger APK, no obfuscation, Crashlytics mapping upload is effectively useless; if R8 is ever enabled, reflection-loaded classes get stripped and break ring/headless.                                                                                                                                                                                                         | `build.gradle:82,129-131`; `proguard-rules.pro:11-12` |
| Medium                  | **Unpinned SDK levels** — `target/compileSdk` inherited from Expo (currently 36); an Expo bump silently changes them with no in-repo guard.                                                                                                                                                                                                                                                                                                             | `build.gradle:101,106,107`                            |
| Info                    | **Correct and defensive:** typed FGS with typeless fallback (5s contract-safe), predictive-back handled, Telecom `selfManaged`, notifee trampoline compliance (no S+ BroadcastReceiver→startActivity), Hermes + New Architecture on.                                                                                                                                                                                                                    | `CallForegroundService.kt:74-88`                      |

---

# iOS Audit

**Verdict: the entire iOS push/calling surface is deliberately dormant and structurally incomplete. On an iOS build today, chat notifications, killed-app calls, and badges would all be non-functional.**

| Item                                             | State                                                                                                                                               | Sev                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `ios/` native project                            | **Does not exist** — never prebuilt (verified on filesystem and git). No AppDelegate, Info.plist, entitlements, or Notification Service Extension.  | Critical           |
| Firebase iOS config (`GoogleService-Info.plist`) | Absent; no `ios.googleServicesFile`. `messaging().getToken()` throws on iOS → no token ever registered.                                             | Critical           |
| `react-native-voip-push-notification`            | **Not installed** (not in package.json, node_modules, or lockfile); the client PushKit code imports it dynamically → resolves to null.              | High               |
| Client PushKit/CallKit                           | Skeleton, hard-disabled: `voipPush.RUNTIME_ENABLED=false`, `callKitBridge.IOS_RUNTIME_ENABLED=false`; `showIncomingCallNotif` early-returns on iOS. | High (intentional) |
| `APNS_VOIP_*` env config                         | Unset everywhere; exists only as a TODO in docs. `ensureApnsClient()` returns null → `sendVoipApns` skips.                                          | High (dormant)     |
| Chat push on iOS                                 | **No path exists** — `sendChatWake` filters to Android tokens; the APNs client implements **only** the `voip` push type, no `alert`/`background`.   | High               |
| Badges on iOS                                    | Not implemented — no `setBadgeCount`, no `aps.badge` in any payload.                                                                                | Medium             |
| Production iOS EAS profile                       | Missing — `eas.json` production is android-only; iOS preview is mostly simulator.                                                                   | High               |
| `apnsClient.ts` implementation                   | **Production-grade** (ES256 `.p8` JWT, correct topic/push-type/priority, env switching, SHA-256 key pinning) — just never invoked with real config. | Low (quality good) |
| APNs config not in `configuration.ts`            | Env-only, bypasses the config schema (no validation/boot signal).                                                                                   | Medium             |

app.json entitlements (`aps-environment`) and `UIBackgroundModes:["voip","audio","remote-notification"]` are correctly declared, and the backend APNs VoIP sender is ready — but everything that would use them is off or missing.

---

# Security Audit

**Strong (keep):** sealed-sender v2 with extended AAD binding; HMAC-signed VoIP wakes with persisted replay-nonce LRU + freshness window, fail-closed by default; WS offer-auth identity binding (full tamper/replay/spoof test matrix); possession-proof `envelope.ack` tokens (default-enforced); HS256 alg-pinning + JTI revocation on handshake + 60s recheck; APNs `.p8` SHA-256 pinning; `sessionWipeProtection` against forged outer envelopes; content-free notification payloads.

| Sev      | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Evidence                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Critical | **Ops-console OTP/MFA not validated** (from `sqa.md` B-39) — any 6-digit code logs in once the password is correct, on a privileged admin console that advertises "2FA enforced". This is a stop-condition per CLAUDE.md. Confirm whether it's a staging shim or the real path.                                                                                                                                                                                                                                               | `sqa.md` B-39                                        |
| High     | **App Check defaults to warn-only** — the anti-forgery guard admits missing/invalid tokens unless `APP_CHECK_MODE=enforce` is set in env; the primary defense against binary/device forgery is off by default. _2026-08-13 (messenger+crypto audit #6): the silent default is gone — prod now FAILS CLOSED on /push/\* when the var is unset/typo'd (loud + deploy-preflighted); the operational posture remains warn-only until clients ship the header, so the forgery exposure itself is still open — see REMAINING_TODO._ | `app-check.guard.ts` (mode toggle now `:20-26`)      |
| Medium   | **Chat wake leaks raw `senderUserId` to FCM** — over time this yields a "who messages whom" metadata feed at the push intermediary. Untested by the opacity specs (which cover only `push:events`/the booking bridge).                                                                                                                                                                                                                                                                                                        | `push.service.ts:481-483`                            |
| Medium   | **Duplicate-ciphertext double-decrypt** (see WebSocket Audit) — can corrupt the ratchet if the relay isn't `clientMsgId`-idempotent.                                                                                                                                                                                                                                                                                                                                                                                          | `productionRuntime.ts:2453-2464`                     |
| Medium   | **`purgeStaleRecipientQueue` is dormant** — the MFA-gated server endpoint exists but has no production caller, so after an own-identity rotation undecryptable envelopes sit on the relay consuming dwell.                                                                                                                                                                                                                                                                                                                    | `sqa.md` B-43; `crypto/ownIdentityRotation.ts:64-84` |
| Medium   | **Cleartext-HTTP hardening is prebuild-fragile** — the manifest sets `usesCleartextTraffic="false"` but `expo-build-properties` sets `true`; a prebuild silently undoes the hardening.                                                                                                                                                                                                                                                                                                                                        | `app.json:74-77`                                     |
| Low      | **`eventClass:'sos'` is cleartext to FCM** (coarse, intentional) — reveals a user is receiving SOS-class events.                                                                                                                                                                                                                                                                                                                                                                                                              | `booking-push-bridge.service.ts:46-50`               |

No plaintext message bodies, keys, or media are logged (enforced by `logAudit.test.ts`). Token storage uses Keychain `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.

---

# Performance Audit

| Sev      | Finding                                                                                                                                                                                                                                  | Evidence                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Critical | **Full Redis keyspace `SCAN` on every push** — `scanKeys` cursors `SCAN MATCH push-token:<uid>:* COUNT 128` across the **entire** keyspace, called on every `sendChatWake` and every VoIP wake. O(total-keys) per message.               | `push.service.ts:1020-1029` used at :194/:414/:438/:619 |
| High     | **Per-message write amplification** — one envelope = Lua SET+ZADD + retract-token SET + submitter SET + ack-token mint + 1 Supabase archive insert + 1 FCM push + 1 keyspace SCAN. A group message multiplies all of it by N recipients. | `envelope.service.ts:184-248`                           |
| High     | **Cluster `fetchSockets` on hot paths** — JTI recheck every 60s per pod over all cluster sockets; `deviceIsOnline` cluster round-trip on every `call.ice` candidate.                                                                     | `messenger.gateway.ts:383,2076`                         |
| Medium   | **Heavy cold-start from push** — WebRTC + Agora + op-sqlite/SQLCipher + mediasoup + ML Kit make a killed-app FCM cold-start expensive; the 8s nav-ready polls in `fcmBootstrap.ts` exist because of it.                                  | `fcmBootstrap.ts:370,601`                               |
| Medium   | **R8 off** → larger APK, no obfuscation.                                                                                                                                                                                                 | `build.gradle:82`                                       |
| Medium   | **No metrics/observability** — only Nest Logger; no counters for push send/fail, no queue-depth gauge, no delivery-latency histogram, no dead-letter queue anywhere.                                                                     | grep: no prometheus/statsd                              |
| Low      | **Fixed 4s app heartbeat** regardless of state; module-level caches (`peerIdentityCache`, `inFlightEnvelopes`) with lazy/no eviction (bounded in practice).                                                                              | `productionRuntime.ts:1179-1197,676`                    |

---

# Production Readiness

| User scale     | Verdict                 | Gating risks                                                                                                                                                                                      |
| -------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **10,000**     | Marginal (Android-only) | Debug-keystore signing blocks Play distribution; OEM battery restrictions already cause missed messages; no iOS.                                                                                  |
| **100,000**    | **Not ready**           | The keyspace-`SCAN`-per-push (Critical #1) begins to dominate latency; per-message write amplification and cluster `fetchSockets` hot paths compound; no observability to even see it.            |
| **1,000,000**  | **Not ready**           | Cross-pod call state without sticky sessions breaks calls under horizontal scale; dead `connectionStateRecovery`; group fan-out cost (N envelopes + N archives + N pushes + N scans) per message. |
| **10,000,000** | **Not ready**           | Every scaling risk above is fatal at this scale; no metrics/dead-letter/backpressure; single Redis store of record for tokens (no durable DB); iOS entirely absent halves the addressable base.   |

**Top scaling risks:** (1) keyspace SCAN per push → replace with a per-user token index; (2) per-message multi-write amplification and group N-fan-out; (3) per-pod in-memory call/typing/SFU state + dead session recovery → require sticky sessions or Redis promotion; (4) unmetered `envelope.pull`/`typing`/`read-receipt`; (5) no metrics/observability/dead-letter; (6) Redis-only token store.

---

# Missing Industry Features

**Notifications:** app-icon badge / badge sync · MessagingStyle-Person-avatar · inline reply · mark-as-read action · summary/group notification · dismiss-on-read · foreground/in-app banner · custom per-conversation tones · rich/media notification · monochrome status-bar icon.

**Messaging:** message reactions · replies/quotes · mentions · edited-message · delete-for-everyone after delivery (server retract only works pre-delivery) · forwarding · starred/pinned messages · disappearing-message parity across background · server-authoritative timestamps · message sequence numbers / gap detection · Signal-style resend-request protocol.

**Presence/receipts:** presence/typing/read exist but can't advance while killed (no background drain); no "last seen" privacy controls surfaced in the push path.

**Calling:** missed-call notification · call-waiting / second-call handling · glare resolution · call history sync across devices · "answered elsewhere" · reconnect that survives background (B-24 open).

**Platform/reliability:** iOS (chat push, VoIP calls, badges — all absent) · multi-device / linked devices / device sync · boot-time reconnect · background message fetch under Doze · battery-optimization + OEM-autostart onboarding · attachment upload queue/resume · push fallback when FCM is degraded · observability/metrics/dead-letter.

---

# Critical Issues

### CRIT-1 — Full Redis keyspace `SCAN` on every push send

- **Issue:** `scanKeys` iterates the entire Redis keyspace (`SCAN MATCH push-token:<uid>:* COUNT 128` until cursor `0`) to find a user's tokens, and is called on every `sendChatWake` and every VoIP wake.
- **Why dangerous:** O(total-keys) per message. At millions of keys, every single message send stalls behind a full-keyspace scan — the dominant scaling failure.
- **Files:** `apps/messenger-service/src/push/push.service.ts:194,414,438,619,1020-1029`
- **Severity:** Critical · **Risk:** Latency cliff / Redis CPU saturation at 100k+ users.
- **Recommended fix (directional):** maintain a per-user token index (a Redis hash `push-token:<uid>` with device fields, or a `SET` of deviceIds) and `HGETALL`/`SMEMBERS` it — never `SCAN` the keyspace on the hot path.
- **Priority:** P0 (blocks scale).

### CRIT-2 — iOS push/calling is entirely non-functional

- **Issue:** No `ios/` native project has ever been generated, no `GoogleService-Info.plist`, PushKit dependency not installed, both client kill-switches hard-off, `APNS_VOIP_*` env unset, no production iOS EAS profile, and the backend chat path is Android-token-only.
- **Why dangerous:** Half the addressable market gets **no** chat notifications, **no** incoming calls when backgrounded/killed, and **no** badges. Silent — nothing errors, it just never notifies.
- **Files:** `app.json` (no `ios.googleServicesFile`), `voipPush.ts:42`, `callKitBridge.ts:66`, `push.service.ts:461`, `apnsClient.ts:100-116`, `eas.json`.
- **Severity:** Critical · **Risk:** No iOS product.
- **Recommended fix:** treat iOS as a full workstream (prebuild, Firebase iOS config, VoIP cert + PushKit dep, flip kill-switches, APNs env + config schema, APNs `alert` path for chat, production EAS profile).
- **Priority:** P0 for any iOS launch.

### CRIT-3 — Release APK signed with the debug keystore

- **Issue:** the `release` buildType uses `signingConfig signingConfigs.debug`.
- **Why dangerous:** cannot be published to Play; any release APK is signed with the world-public debug key and is trivially re-signable/repackageable.
- **Files:** `android/app/build.gradle:113-119,128`
- **Severity:** Critical · **Risk:** Not shippable; integrity/forgery exposure.
- **Recommended fix:** provision a real upload/signing key (or EAS-managed credentials) for `release`.
- **Priority:** P0 before any store release.

### CRIT-4 — `expo prebuild` drift silently breaks security and features

- **Issue:** `android/` is gitignored with files force-added; regenerating from `app.json` would strip ~23 permissions (POST_NOTIFICATIONS, typed FGS, USE_FULL_SCREEN_INTENT, all CallKeep/Telecom), re-enable cleartext HTTP, and delete the force-added `CallForegroundService.kt` + FrameCryptor Kotlin.
- **Why dangerous:** a routine `prebuild` (or CI regeneration) ships a **less-secure, non-functional** app that still compiles — no error surfaces.
- **Files:** `app.json:35-43,74-77` vs `android/app/src/main/AndroidManifest.xml`; `CallForegroundService.kt` (force-added).
- **Severity:** Critical (if triggered) · **Risk:** Regression of the entire notification/call/security surface.
- **Recommended fix:** move all manifest/permission/native config into config plugins so `app.json` is the single source of truth; or stop treating `android/` as regenerable and document it as owned.
- **Priority:** P0 (process/build integrity).

### CRIT-5 — Killed-app headless handler drops SOS / mission / critical wakes

- **Issue:** `handleHeadlessFcm` handles only `voip-wake` and `msg-wake`; `sos-cpo-alert`, `mission-dispatched`, `booking-approved`, `agent-*`, `payout-settled`, and opaque `{eventId}` wakes fall through to "unknown kind, no action". The rich handler that draws these runs only warm.
- **Why dangerous:** for an app with an **SOS** feature, a crew SOS fired to a recipient whose app is swiped away produces **no alert at all**.
- **Files:** `src/modules/messenger/push/fcmHeadless.ts:106` (vs the warm handler `fcmBootstrap.ts:1014`).
- **Severity:** Critical (safety) · **Risk:** Missed safety-critical alerts.
- **Recommended fix:** unify the headless and warm dispatch so every wake kind renders a notification when killed (headless needs no runtime/DB — it's a notifee draw).
- **Priority:** P0 for the SOS/mission use case.

### CRIT-6 — socket.io `connectionStateRecovery` is dead code

- **Issue:** recovery is configured, but the `SessionAwareRedisAdapter` implementing `restoreSession` is never wired (zero importers); the stock adapter's no-op `restoreSession` is in effect.
- **Why dangerous:** every reconnect is a cold session — queued packets, typing, and presence are never replayed. The only backstop is `flushPendingOnConnect`; anything not persisted server-side is lost on a blip.
- **Files:** `apps/messenger-service/src/gateway/redis-io.adapter.ts:94-97`; `session-aware-redis-adapter.ts:1-42`.
- **Severity:** Critical (reliability) · **Risk:** Silent message/state loss on every reconnect at scale.
- **Recommended fix:** wire the session-aware adapter (send both `pid` and `offset`) or remove the recovery config and rely explicitly on `flushPendingOnConnect`.
- **Priority:** P0.

### CRIT-7 — Second-device login is a data-loss event

- **Issue:** the client never calls `fetchDevices` and hardcodes `deviceId:1`; the server's legacy `fetchBundle` serves last-writer-wins identity. A second active device's queued envelopes were wrapped to a now-superseded identity and fail `unwrapOuter`.
- **Why dangerous:** logging in on a second device (or an ambiguous reinstall) silently breaks the conversation and loses the other device's inbound — the opposite of the multi-device experience users expect.
- **Files:** `src/modules/messenger/transport/keysClient.ts:15-18`; `apps/auth-service/src/keys/keys.service.ts:168-174,266-267`.
- **Severity:** Critical (data loss) · **Risk:** Message loss / broken sessions on multi-device.
- **Recommended fix:** implement per-device sessions end-to-end (client `fetchDevices` + per-(userId,deviceId) fan-out) or explicitly enforce single-device with a clear "logged in elsewhere" takeover.
- **Priority:** P0 before advertising multi-device.

_(High/Medium/Low issues are enumerated in full, with `file:line` and failure scenarios, in the per-domain sections above.)_

---

# Final Scorecard

| Domain                   | Score        | Rationale                                                                                                                                                                                                                                      |
| ------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Notifications**        | **3 / 10**   | No foreground handler, no badges/MessagingStyle/reply/summary/dismiss-on-read, killed-app drops critical wakes, no cold-launch routing, white-blob icon. Channels + full-screen call notif + privacy-preserving previews are the bright spots. |
| **Calling**              | **5 / 10**   | Excellent, well-tested 1:1 ring lifecycle + wake/offer auth; undermined by dead lock-screen flags, glare failure, group warm-wake bug, no missed-call notification, no iOS, cross-pod breakage.                                                |
| **Background**           | **2 / 10**   | No boot reconnect, no background sync, no battery/OEM survival, banner-only headless, no attachment queue, 100% FCM-dependent. Durable text outbox is the one strength.                                                                        |
| **Security**             | **6 / 10**   | Strong crypto/auth core (sealed sender, AAD, HMAC wakes, ack tokens, JTI, `.p8` pinning); dragged down by App Check warn-only default, senderUserId leak to FCM, ops-console OTP-not-validated, debug keystore, AD_ID.                         |
| **Performance**          | **4 / 10**   | Hermes + New Arch help cold start, but keyspace-SCAN-per-push, per-message write amplification, cluster `fetchSockets` hot paths, R8 off, no metrics.                                                                                          |
| **Architecture**         | **5 / 10**   | Clean modules, epoch isolation, atomic receive txn; but divergent duplicate crypto/transport trees, prebuild drift, per-pod state, dead code.                                                                                                  |
| **Scalability**          | **3 / 10**   | SCAN-per-push is fatal at 100k+, group fan-out N×, dead `connectionStateRecovery`, cross-pod state without sticky sessions, Redis-only token store.                                                                                            |
| **Offline Support**      | **5 / 10**   | Durable outbox with backoff/poison-parking, persistent dedup, atomic receive; no attachment queue/resume, no background drain, client-clock-only ordering, no gap detection.                                                                   |
| **Signal Protocol**      | **6 / 10**   | Solid X3DH/Double Ratchet/sealed-sender/ratchet-snapshot/wipe-protection; no resend protocol, OPK race, no multi-device, TOFU doesn't block sends, group-stash loss.                                                                           |
| **Production Readiness** | **3 / 10**   | Seven ship-blockers; Android-only; not ready beyond ~10k users and not store-shippable as signed.                                                                                                                                              |
| **Overall**              | **42 / 100** | Hardened Android-first crypto/call core with systemic gaps in background delivery, notification UX, iOS, multi-device, and horizontal scale. **Production Ready: No.**                                                                         |

---

## Appendix — Methodology & Confidence

- Findings were produced by seven parallel read-only domain audits (client push, backend push/relay/gateway, calling stack, WebSocket/offline, Signal delivery, Android platform, iOS readiness), each required to cite `file:line` evidence and a concrete failure scenario.
- The load-bearing Critical claims were re-verified directly against source in this session: the keyspace `SCAN` (`push.service.ts:1020-1029`), the Android-only chat-token filter (`push.service.ts:202,461`), the absence of `onMessage`/`getInitialNotification` (grep of `push/`), and the dead `EXTRA_CALL_LAUNCH` intent extra (`MainActivity.kt:49,77`, only self-referenced).
- Device-observed corroboration was cross-checked against the running SQA bug log (`sqa.md`): B-05 (WS keepalive ack), B-24 (call dies on background→resume), B-39 (ops-console OTP), B-43 (offline-backlog loss).
- **Confidence:** High for the Android client, backend, and crypto findings (direct code evidence). High for iOS (structural absence is unambiguous). Medium where a claim depends on runtime/infra state not visible in the repo (e.g. whether the relay dedups by `clientMsgId`, whether `APP_CHECK_MODE`/APNs env are set in the live deployment) — these are flagged inline as such.
- The audit itself modified no product code. Fixes were applied in the separate remediation session logged below.

---

# Remediation Log (2026-07-04)

A follow-up session fixed the **safe, verifiable subset** of the findings. Everything below was implemented and gated by `tsc` + Jest. The mobile typecheck stays at the post-merge count of **51** (baseline 49; the +2 predates this work — it came in with the 63-file `git pull` at session start and lives in `CallScreen`/`ChatScreen`/news screens, not in any file touched here). Backend `tsc` is clean.

### Fixed & verified

| #            | Finding                                                                                                      | What changed                                                                                                                                                                                                                                                                                                                                                                     | Verification                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **CRIT-1**   | Full Redis keyspace `SCAN` per push                                                                          | Added a per-user device-id **index SET** (`push-index-data:<uid>` / `push-index-voip:<uid>`) maintained on register/unregister/cleanup/GC; senders now enumerate a user's devices via `SMEMBERS` instead of scanning the keyspace. One-time migration-gated SCAN fallback (`push-index-mig:*`) so pre-index tokens and token-less users never re-scan.                           | `push.service.ts`, `push.service.spec.ts` — **13/13** (4 new), full messenger-service suite **188/188**, `tsc` clean    |
| **CRIT-5**   | Killed-app drops SOS/mission/booking/agent wakes                                                             | Extracted the server-event dispatch (opaque hydrate + booking + agent/mission/SOS/payout) into a shared, headless-safe `serverWakeNotifications.ts`; both the warm (`fcmBootstrap`) and killed (`fcmHeadless`) handlers now call it, so they can't drift and a killed app renders every wake kind. Removed the now-dead duplicate `hydratePushEvent`.                            | new `serverWakeNotifications.test.ts` **5/5**, `logAudit` still green, `tsc` clean                                      |
| Notif UX     | No foreground `onMessage`; no cold-launch tap routing                                                        | Added `messaging().onMessage` (nudges a pull for msg-wake, draws server wakes in-foreground; torn down on logout) and `notifee.getInitialNotification()` cold-launch routing that feeds the launching notification through the existing tap handler → deep-links to the conversation / ring screen.                                                                              | `tsc` clean, client suite **1322/1322**, app suite **166/166**                                                          |
| Notif UX     | Calls could ring after read; no missed-call notif; banners lingered; channel drift; double permission prompt | Added `showMissedCallNotif` (posted on caller-cancel-while-ringing and on the `call.missed` server event, not on user-decline) + `dismissMessageNotif` (called on conversation open); aligned the duplicate `bravo-messages` channel definition (added `vibration`); gated the `POST_NOTIFICATIONS` request behind a `check()` to avoid re-prompting.                            | `callHangupWhileRinging.test.ts` **5/5** (2 new; caught + fixed a regression where the missed-call read broke teardown) |
| **B-05**     | WS `ping` never acks                                                                                         | **Already fixed in the merged code** (`messenger.gateway.ts` emits the `pong` event _and_ returns event-less `{ts}`). Verified, no change needed.                                                                                                                                                                                                                                | `messenger.gateway.ping.spec.ts` green                                                                                  |
| WS-HIGH      | `envelope.pull` / `typing` / `read-receipt` / `presence*` unmetered                                          | Added the missing limits to `DEFAULT_WS_LIMITS` and wired `rateGate` into all six handlers.                                                                                                                                                                                                                                                                                      | `ws-rate-limiter.spec.ts` green, `tsc` clean                                                                            |
| WS-MED       | Presence false-offline (1h counter TTL)                                                                      | Raised the liveness-counter TTL to 6h and added `presence.touch()`, called from the heartbeat `ping`, so a long-lived foreground socket isn't reaped.                                                                                                                                                                                                                            | `presence.service.spec.ts` **+2 new**, all green                                                                        |
| Calling      | CallKit listeners duplicated on logout→login                                                                 | Captured the `subscribeToCallKitEvents` unsubscribe and invoke it in `stopFcmBootstrap` before clearing the guard.                                                                                                                                                                                                                                                               | `tsc` clean                                                                                                             |
| Calling      | Dead `EXTRA_CALL_LAUNCH` lock-screen flags                                                                   | `CallForegroundService` now sets `EXTRA_CALL_LAUNCH` on its content intent, so tapping the ongoing-call notification from a locked device engages MainActivity's `showWhenLocked`/`turnScreenOn`/`dismissKeyguard`.                                                                                                                                                              | needs a device build to confirm (native, un-buildable here)                                                             |
| **CRIT-4**   | `expo prebuild` drift strips permissions / re-enables cleartext                                              | Synced the notification/call/FGS permissions into `app.json` (21 total) so a prebuild can't drop them; flipped `usesCleartextTraffic` to `false` to match the hardened manifest.                                                                                                                                                                                                 | `app.json` validated as JSON                                                                                            |
| **CRIT-3**   | Release APK debug-signed                                                                                     | Added a conditional release `signingConfig` that uses a real upload keystore from `BRAVO_UPLOAD_*` env/properties when present, falling back to debug (with a loud warning) so local dev builds still work.                                                                                                                                                                      | needs the keystore secret + a build to confirm                                                                          |
| Android HIGH | White-blob notification small icon                                                                           | Added a monochrome `ic_stat_bravo.xml` vector drawable, repointed every JS `smallIcon` (ring / message / missed-call / server-wakes) to it, and added the FCM `default_notification_icon` meta-data. `largeIcon` intentionally kept as the full-color launcher (it's the avatar, not a mask).                                                                                    | `tsc` clean; visual confirmation needs a device build                                                                   |
| **B-39**     | Ops-console OTP accepts any code                                                                             | Root cause was the `OTP_DEV_BYPASS` config flag (staging convenience), not a code bug. Added a `NODE_ENV=production` guard in `auth-service/configuration.ts` so `otp.devBypass`, `otp.devReturnCode`, and `biometric.devBypass` can **never** activate in production even if the env var is mistakenly set — the real Twilio Verify / integrity path is the only route in prod. | new `configuration.spec.ts` **3/3**; OTP+auth suites **41/41**; `tsc` clean                                             |

### Blocked — require architecture approval, external secrets, or a device build

Per `CLAUDE.md`, changes touching security stop-conditions must be verified against the System Architecture Documentation first; these were **not** modified:

- **CRIT-2 iOS** — needs an Apple VoIP Services cert, `GoogleService-Info.plist`, the `react-native-voip-push-notification` dep, flipping the `RUNTIME_ENABLED` kill-switches, `APNS_VOIP_*` env, and a production iOS EAS profile. External credentials + a Mac build.
- **CRIT-7 multi-device / second-device data loss** — per-device sessions + fan-out touch **group-key distribution and session establishment** (stop-conditions). Needs architecture sign-off.
- **Signal delivery** — no-resend-protocol, OPK pop race, group-stash loss, TOFU-doesn't-block-sends all sit on **key agreement / sealed-sender / identity-trust** stop-conditions.
- **Call & message mute/block enforcement** — the VoIP wake is deliberately identity-free (P1-N2), so blocking must happen at the WS `call.offer` layer or server relay; there is no client-accessible block list (block = server `usersClient.block` + conversation removal). Relay-level enforcement touches **relay ack/dwell semantics** (stop-condition).

### Crypto features — user-authorized follow-up (flag-gated, low→high)

After the audit, the owner authorized implementing the Signal/relay items and said they'll build + device-verify after. Approach: **feature-flag each behavior change to default to today's behavior**, so the code is ready but the running app is byte-identical until each is deliberately enabled and verified. Status:

| Item                                    | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OPK fetch race**                      | **Fixed** — `FOR UPDATE SKIP LOCKED` on the one-time-prekey pop (`keys.service.ts`); semantics-preserving concurrency hardening. keys suite 11/11.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Duplicate-ciphertext double-decrypt** | **Already handled** (verified) — the relay dedups by `clientMsgId` (`envelope.service.ts:161`, `envelope.store.ts:246`) and returns the original envelopeId on a repeat, so the WS→HTTP re-send never double-delivers. No change needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Group-stash live-drain**              | **Already handled** (verified) — `reshareGroupKeyState` delivers an out-of-band key as `admin:{type:'create'}`, and the receive-side create branch adopts the key and returns `drain-group` unconditionally (`productionRuntime.ts:6073,6116`). The G-05 reshare engine post-dates the old audit note.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **`connectionStateRecovery`**           | **Wired, flag-gated OFF** — `SessionAwareRedisAdapter` selected only when `WS_SESSION_RECOVERY=true` (`redis-io.adapter.ts`); default uses today's stock adapter. Enable + multi-client staging test to turn on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **TOFU send-gate**                      | **Implemented, flag-gated OFF** — new `peerIdentityAckStore` (DI-persisted) records an unacknowledged identity change at all four receive-side rotation sites; `sendText` (1:1) blocks on it only when `EXPO_PUBLIC_STRICT_IDENTITY_SEND_GATE=true`; cleared on verify or the new `acknowledgePeerIdentityChange` API. 5 new tests; client suite 1327/1327. Default off ⇒ no behavior change.                                                                                                                                                                                                                                                                                                                          |
| **Signal resend protocol**              | **Implemented, flag-gated OFF** (owner-authorized, push 2). Avoids any sealed-payload schema change: triggers off the EXISTING `rehandshake` control the receiver already sends on decrypt failure. When `EXPO_PUBLIC_RESEND_PROTOCOL=true`, the sender re-transmits recent still-undelivered 1:1 TEXT messages (window 10 min, cap 10, per-peer 60s cooldown) using the ORIGINAL clientMsgId so the receiver dedups (no duplicate bubble). Default off ⇒ receive path byte-identical. `recentUndeliveredSelfText` query is test-covered; client 1330/1330. Enable + on-device verify to turn on.                                                                                                                      |
| **Multi-device fan-out (CRIT-7)**       | **Implemented, flag-gated OFF** (owner-authorized, push 3). Additive: the primary device-1 send is UNCHANGED; when `EXPO_PUBLIC_MULTI_DEVICE=true`, a 1:1 send ALSO fans out to the peer's other devices via the new `KeysHttpClient.fetchDevices` (per-device bundle + authority-verified), establishing a per-device session and sending an envelope per device with the ORIGINAL clientMsgId. Best-effort, isolated per device, never blocks the primary send or touches the bubble/outbox. Default off ⇒ send path byte-identical. `fetchDevices` test-covered; client 1333/1333. **MUST be validated with a real two-device rig before enabling** — a single-device build cannot exercise the linked-device path. |

**Why these two are different from everything else fixed above:** every other item changed app/runtime/config code that could be verified here or is inert until a flag flips. These two require editing **locked E2EE crypto schemas** (envelope shape / key distribution) whose correctness depends on documented invariants + cross-version/linked-device testing that isn't available in this environment. Per `CLAUDE.md` (which overrides), those edits require verification against the System Architecture Documentation first. Implementing them blind — even flag-gated — risks silently breaking decryption for real users, the one failure mode explicitly ruled out. They are ready to implement the moment the arch doc (or an explicit accept-the-risk from the owner with a cross-version test plan) is provided.

- **App Check `enforce` default** — auth-gate stop-condition; flipping App Check to enforce risks locking out live clients that don't yet send a token, an operational cutover decision (not a blind default flip). _2026-08-13: the DEFAULT question is resolved (prod fails closed scoped to /push/\* when unconfigured, deploy-preflighted; explicit warn-only is the documented rollout posture) — what remains deferred is exactly the cutover: clients shipping the header + Firebase replay protection + the flip, tracked in REMAINING_TODO._ _(The related **ops-console OTP / B-39** is now hardened — see the Fixed table.)_
- **Duplicate-ciphertext double-decrypt (ack watchdog)** — depends on whether the relay dedups by `clientMsgId`; the correct fix touches **relay ack/envelope-ID handling** (stop-condition) and needs the architecture reference.
- **Exported RNCallKeep background-messaging service guard** — tightening `android:exported` / adding a permission on the Telecom-adjacent service could break background call handling if the OS starts it; needs an on-device call test to verify, unavailable here. _(The white-blob notification icon is now fixed — see the Fixed table.)_
- **`connectionStateRecovery` dead adapter** — the `SessionAwareRedisAdapter` is a written, one-line swap, BUT its `broadcast` override appends an offset arg to **every** WS event and the whole path is unexercised; enabling it blind could break all messaging, and the recovery loop can't be integration-tested here (needs live Redis + a multi-client reconnect). Current behavior is not message-loss (envelopes are covered by `flushPendingOnConnect` + `seenEnvelope` dedup), only missed typing/presence frames — so this stays a staging-integration item rather than a blind flip.
- **Cross-pod call state, attachment upload queue, boot receiver / battery-optimization / OEM-autostart survival** — larger backend/native features (sticky sessions or Redis-promoted call state, a durable attachment queue, a BOOT_COMPLETED receiver + battery-exemption UX). Each is a design change beyond a safe in-place fix and should be scoped as its own workstream.

### Net effect

The two most damaging **Critical** items for scale and safety — the per-push keyspace `SCAN` (CRIT-1) and the killed-app dropping SOS/mission wakes (CRIT-5) — are fixed and tested, along with the WS DoS gaps, presence false-offline, the CallKit leak, the missed-call/dismiss/foreground/cold-launch notification UX, and the prebuild-drift + debug-keystore build risks (config-level). Backend suite **188/188**, client suite **1322/1322**, app suite **166/166**, both typechecks within baseline. The remaining items are genuinely blocked on architecture approval, external credentials (Apple/Play), or an on-device Android build — not deferrable within a safe, self-verified code change.
