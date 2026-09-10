# Call join latency — why "Accept → in the room and talking" is slow, and the fix plan

**Date:** 2026-08-20 · **Status:** AUDIT (no code changed) · **Branch read:** `feat/call-race-hardening-phase-5` @ `ec1a4dd1` · **sqa.md:** B-596..B-602 (see §9)
**Symptom (founder):** _"When we get a call and we accept to join the call or room — 1:1 or group, any kind of call — it takes time to come into the room and then we can communicate. Why is it so slow?"_

> Line numbers were re-grepped today on this branch. They go stale fast in this repo — **re-grep the symbol before acting on any of them.** Every claim below is either a `file:line` read today, a staging relay log line (UTC), or a measured number already in `sqa.md` (B-342). Estimates are marked _(est.)_. Nothing in this document was measured on a device **today** — that is what Step 0 is for.

---

## 0. TL;DR — the one-paragraph diagnosis

There is no single "slow bug". The join is a **long, strictly serial chain** in which almost every step waits for the previous one, and several of the expensive steps that _could_ run while the phone is still ringing run only **after** you tap Accept (TURN credentials, PeerConnection build, camera/mic, mediasoup `Device.load`, the E2EE key wait). On top of that sit three _real defects_ found today: **(1)** the relay **silently bins the caller's first ICE candidates** on every call whose offer arrives in the same TCP read as its candidates or whose block-check misses a 60 s cache — the server awaits a Supabase lookup _before_ it registers the call session, so the trickled host/srflx candidates hit `authorizeCallFrame` with no session and are dropped; the B-273 fix (2026-07-26) only closed the client half of this, and the staging log proves it is still happening (§3.1). The call then connects on later relay candidates — slower, and via TURN. **(2)** The group path awaits the TURN fetch with **no ceiling** (the 6 s cap exists only in `CallScreen`), and walks a **2 + 2N server-imposed round-trip choreography serially** (join → recv-transport connect → per-producer `sfu.consume` _created paused_ → per-producer `sfu.consumer.resume`), so hearing three peers costs ~15 sequential WS acks plus ~10 SDP cycles plus ~29 awaited native FrameCryptor bridge calls before `'joined'`. B-342 already **measured 10.8 s** of exactly this chain on a host. **(3)** The group screen does not start the audio session until `'joined'` **and** the Bluetooth permission prompt has resolved, and `'joined'` itself waits behind an awaited presence fan-out that nothing needs. WhatsApp/Signal's rule is the opposite: **do everything you can while it rings; after Accept, only send the answer.**

**Plain-English analogy:** the kitchen only starts boiling the water when you say "I'll have the pasta", then cooks each of five dishes one at a time, and the waiter throws away the first breadsticks because the table "wasn't in the system yet" when they arrived. The fix is to boil the water while you read the menu, cook the dishes in parallel, and register the table before the breadsticks show up.

---

## 1. What happens today — the four lanes, step by step

Legend: **[S]** serialization that could be parallel/pre-warmed · **[N]** network round trip · **[F]** fixed native cost · **[W]** waits on the user/OS · **⚠** defect.

### 1.1 1:1 — the ANSWERING phone (warm, in-app ring)

| #   | Step                                                                                                                                                   | Where                                                                                                                 | Cost _(est.)_                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| R1  | Ring: `MainNavigator` navigates `CallScreen` with `incomingSdp`; CallScreen fetches TURN creds **per mount, no cache** (6 s ceiling → STUN fallback)   | `src/navigation/MainNavigator.tsx:927`, `src/screens/messenger/CallScreen.tsx:827-907` (race `:860-872`)              | off the tap→talk path on this lane (overlaps the ring) [N]                                                           |
| R2  | `useCall` boot bails until `iceServers` resolve (`'demo'` peer), then builds the controller; caller ICE queues in `pendingIce` (pc is null)            | `CallScreen.tsx:919`, `src/modules/messenger/webrtc/useCall.ts:340,918,936`; `callController.ts:408-442`              | —                                                                                                                    |
| A1  | Tap Accept → `setUserAccepted(true)` → **effect** (state→effect hop) → `liveCall.accept()`                                                             | `CallScreen.tsx:3396, 1273-1294`; `useCall.ts:1216-1255`                                                              | 1-2 frames, or a JS-thread backlog (B-279 class) [S]                                                                 |
| A2  | **`buildPc` — the PeerConnection is built INSIDE accept, not at ring**                                                                                 | `callController.ts:713-714, 1736-1740`; `peerConnection.ts:220-226`                                                   | 10-50 ms [F][S]                                                                                                      |
| A3  | `await setRemoteOffer` → `await drainPendingIce()` (serial `addIce` per queued candidate)                                                              | `callController.ts:722, 736-737, 518-530`                                                                             | 30-300 ms [F]                                                                                                        |
| A4  | **`await attachLocalMedia`** → `getLocalMedia`: `PermissionsAndroid.requestMultiple` (awaited even when granted) → **`getUserMedia`** (15 s cap)       | `callController.ts:745`; `useCall.ts:829`; `peerConnectionFactory.ts:77-152`                                          | 150-600 ms mic; **+0.5-2 s camera**; a permission dialog = unbounded [F][W][S] — **runs AFTER A3, not alongside it** |
| A5  | `createAnswerAndApply` (ICE gathering starts HERE — `iceCandidatePoolSize: 0`) → `sendAnswer` (NOT awaited) → `'connecting'`                           | `callController.ts:748-760`; `peerConnection.ts:224` (comment `:216-218`: "~500 ms extra latency on FIRST candidate") | 30-150 ms [F]; **the answer the caller needs leaves only after A4**                                                  |
| A6  | Relay: `handleCallAnswer` → `await forwardToDevice` (online probe = 1 Redis RTT) → caller `acceptAnswer` + `drainPendingIce` → caller can start checks | `apps/messenger-service/src/gateway/messenger.gateway.ts:1608-1693, 3479-3507`; `callController.ts:845-865`           | 100-400 ms [N]                                                                                                       |
| A7  | ICE checks (+TURN allocate/permission if relay) → `oniceconnectionstatechange 'connected'` → **`setState('connected')`** (UI flips here)               | `callController.ts:1800-1831`                                                                                         | 0.3-1.5 s; relay 0.5-2.5 s [N]                                                                                       |
| A8  | DTLS poll (`verifyDtlsSrtp` every 250 ms × 24, 1 s cap each) → `onSecured`, `playoutDelayHint=0.15`; audio is audible once SRTP keys exist             | `callController.ts:1173-1251`                                                                                         | 50-300 ms after A7; does not gate the UI                                                                             |
| A9  | `InCallManager.start` + FG service fire on `'connecting'` (gated on `permGranted`)                                                                     | `CallScreen.tsx:1465-1587`                                                                                            | overlaps A6/A7                                                                                                       |

**Code-derived floor on this lane _(est.)_:** ~1-2 s voice, ~2-4 s video, on a healthy network — before any of the defects below make it worse. A4→A5 is the structural problem: the answer cannot leave until the camera is open, and nothing the caller's ICE agent can do starts before it has that answer.

### 1.2 1:1 — the ANSWERING phone from a notification (app backgrounded or killed)

Everything in 1.1 **plus**, because `CallScreen` mounts only when you tap Answer:

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                     | Where                                                                                                                                                        | Cost _(est.)_                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | `waitReady(NAV_READY_WAIT_MS)` nav poll (100 ms steps, ≤20 s) before the screen is even navigated                                                                                                                                                                                                                                                                                        | `src/modules/messenger/push/fcmBootstrap.ts:1142-1145, 2286-2297`; `callDeadlines.ts:214`                                                                    | 0 warm; cold start 2-20 s [W]                                                                                                                                                                                               |
| N2  | **TURN fetch on the critical path** (R1 happens at answer time, not ring time): HTTP RTT + server JWT verify + Redis JTI + possibly a 401 refresh; controller cannot exist until it resolves (`autoAccept waiting — controller not ready (B-319)`)                                                                                                                                       | `CallScreen.tsx:860-872, 919, 1290`; `useCall.ts:340`; `apps/messenger-service/src/common/guards/jwt-http.guard.ts:48,65`                                    | 150-800 ms; **6 s worst** [N][S]                                                                                                                                                                                            |
| N3  | Killed app: auth hydrate → `buildProductionRuntime` (SQLCipher open, stores) → `transport.connect` (JWT handshake) → the gateway **replays the pending offer** (45 s TTL) → only now is there an SDP → `incomingSdpKey` → accept                                                                                                                                                         | `productionRuntime.ts` boot; `fcmBootstrap.ts:2335-2348` (hydrates from `incomingCallCache`); gateway `deliverPendingCallOffer`                              | **10-25 s** on low-end (comment `CallScreen.tsx:236`) [F][N]                                                                                                                                                                |
| N4  | Killed app, the reason N3 is on the path at all: the headless **`voip-wake` handler only presents the card** — it never boots the runtime or opens the socket (only `msg-wake` runs the bounded headless drain), so nothing can receive the offer replay until the UI process has booted AFTER the tap. `incomingCallCache` is an in-memory Map, so a reaped process starts with no SDP. | `src/modules/messenger/push/fcmHeadless.ts:108-254` (voip branch) vs `:264-271` (msg-wake drain); `incomingCallCache.ts:67`                                  | the whole N3 cost sits after the tap instead of during the ring [S] — **with the B-331/B-354 hazards** (a headless socket looks online; the offer lands in the headless VM — `cacheUnhandledOffer` exists for exactly this) |
| N5  | Cold Answer route discovery is deferred: `getInitialNotification` routing lives in `installNotifeeHandlers` ← `startFcmBootstrap`, which `MainNavigator` calls inside `InteractionManager.runAfterInteractions` after the ownerKey `AsyncStorage` read; upstream: fonts (`App.tsx` returns null), `permsShown` read, `BiometricGate` keeps children unmounted, optional `/auth/me` ≤ 4 s | `MainNavigator.tsx:505-512, 612, 643`; `fcmBootstrap.ts:327-333, 2405-2418`; `src/navigation/index.tsx:42-46`; `BiometricGate.tsx:25-36`; `authStore.ts:444` | 0.2-1 s of pure ordering before `waitReady` even starts [S]                                                                                                                                                                 |
| N6  | Small awaited bridge calls on the tap path: `await dismissCallNotif` (ringtone stop + cancel) before routing; `await verifyVoipWake` (Keychain read + nonce hydrate) before the card; `await dismissMissedCallNotifs` after the card                                                                                                                                                     | `fcmBootstrap.ts:2135`; `voipWakeVerify.ts:302, 340`; `callNotification.ts:658`                                                                              | 10-200 ms each [F]                                                                                                                                                                                                          |
| N7  | Group cold lane: the replayed `sfu.ring.incoming` (`replayed:true`, B-479) is **buffered behind `depsReady`** on the new socket — only 1:1 `CALL_FRAME_EVENTS` are exempt — so the restore-mode park/ack lane waits behind the SQLCipher hydrate. (Join itself does not need the frame.)                                                                                                 | `productionRuntime.ts:1455`; `src/modules/messenger/runtime/callFrameRouter.ts:19-38`; `MainNavigator.tsx:1227-1299`                                         | the whole hydrate (seconds on a long thread) [S] → **B-602**                                                                                                                                                                |

**Live evidence (staging, 2026-08-20 11:28 UTC):** offer `aed9debd` → `peer_offline`; the callee's socket opened **52 s later** (`ws open sub=3165d0e1` 11:29:38) — past the 45 s offer TTL; the caller had hung up at 11:29:01. Group equivalent at 14:06:53: two killed invitees' sockets opened **12 s and 16 s after the ring** (`replay pending group-ring` 14:07:05 / 14:07:09). Neither number separates "user reaction" from "boot", which is why Step 0 must bracket them.

### 1.3 1:1 — the CALLING phone + the relay

| #   | Step                                                                                                                                                                                                                                                                          | Where                                                                                                                                       | Cost _(est.)_                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| C1  | `launchCall` navigates; CallScreen mounts; **TURN fetch gates everything** (`callArgs` is `'demo'` until `iceServers`)                                                                                                                                                        | `launchCall.ts:431-461`; `CallScreen.tsx:919`; `useCall.ts:340`                                                                             | 150-800 ms, 6 s worst [N][S]                                                            |
| C2  | `await ensureLocalMedia()` **before** the controller/PC exist (strictly after C1, not alongside)                                                                                                                                                                              | `useCall.ts:584-586`                                                                                                                        | mic 150-600 ms, camera +0.5-2 s [F][S]                                                  |
| C3  | `startOutgoing`: `buildPc` → `attachLocalMedia` → `createOffer` (gathering starts) → **`await buildOfferAuth`** (sender-cert cache; a miss = `POST /sender-cert`, 20 s timeout) → `sendOffer` → **then** the ICE gate opens and flushes every buffered candidate in one burst | `callController.ts:561-613, 1791-1798`; `packages/messenger-core/src/runtime/certCache.ts:57-90`                                            | cert hit: ms; miss: 1 HTTPS RTT [N]                                                     |
| C4  | ⚠ **Relay `handleCallOffer`: `await privacy.isBlockedEither(...)` (Supabase HTTPS, 60 s cache, no timeout) runs BEFORE `trackCallStart`.** Meanwhile `handleCallIce` → `authorizeCallFrame` → no session → `{ignore:true}` → **silent drop, no log**                          | `messenger.gateway.ts:1486 → 1501`; `:3158-3168`; `:1750-1752`; `apps/messenger-service/src/users/user-privacy.service.ts:26,73-93,125-131` | **the first host/srflx candidates are lost** → ICE completes later and via relay [⚠][N] |
| C5  | Relay forwards the offer (`forwardToDevice` online probe = 1 Redis RTT), queues the pending offer, fires the VoIP wake (not awaited)                                                                                                                                          | `messenger.gateway.ts:1510, 1553-1572, 1588`                                                                                                | ~1-2 ms + 1 Supabase RTT on miss [N]                                                    |
| C6  | Answer arrives → `handleAnswer`: `acceptAnswer` + `drainPendingIce` → `'connecting'` (20 s watchdog) → ICE → `'connected'`                                                                                                                                                    | `callController.ts:835-866, 1800-1831`                                                                                                      | as A6-A8                                                                                |

### 1.4 Group — host START and invitee ACCEPT (the same boot chain, `useGroupCall.ts`)

The boot is one IIFE with numbered steps; `(h)` = host-only, `(i)` = invitee-only. **Every row is awaited before the next one starts** unless marked.

| step | What                                                                                                                                                                                                                                                                             | Where (`src/modules/messenger/webrtc/useGroupCall.ts` unless noted)                      | Cost _(est.)_                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| pre  | (h) `launchCall` awaits `Promise.all([findLiveRoom, listMine])` (2 HTTP) **before** navigating to the screen                                                                                                                                                                     | `launchCall.ts:366-392`                                                                  | 1 HTTP RTT before the screen even mounts [N][S]                                                                            |
| pre  | (i) Accept → `navigation.replace('GroupCallScreen')`; notification lanes add the `NAV_READY_WAIT_MS` poll                                                                                                                                                                        | `src/screens/messenger/IncomingGroupCallScreen.tsx:301-369`; `fcmBootstrap.ts:2284-2326` | —                                                                                                                          |
| 0    | `fetchTurnCredentials()` **started** (not yet awaited) — ⚠ **no ceiling**: `fetchWithRefresh` is a bare `fetch`; `TURN_FETCH_CEILING_MS` is applied only in `CallScreen.tsx:868`                                                                                                 | `:1628`, `:5662-5690`; `src/services/api.ts:308-318`                                     | unbounded on a dead socket after background [⚠][N]                                                                         |
| 1    | (h) `await POST /sfu/rooms` (server creates the mediasoup router)                                                                                                                                                                                                                | `:1670-1680`; `apps/messenger-service/src/sfu/sfu.service.ts:243`                        | 200-800 ms [N]                                                                                                             |
| 2    | `await getLocalMedia({video})` — perms + `getUserMedia`; `GroupCallScreen` runs a SECOND `requestMultiple` for the same perms concurrently                                                                                                                                       | `:1913`; `peerConnectionFactory.ts:77-152`; `GroupCallScreen.tsx:225-235`                | 200-1500 ms; 15 s cap [F][S] — nothing in steps 3-7 needs the track                                                        |
| 3    | `await sfu.join` — server creates **two WebRtcTransports sequentially** inside the ack                                                                                                                                                                                           | `:1997`; `sfu.service.ts:481-482`                                                        | 1 WS RTT + 2 IPC [N]                                                                                                       |
| 3a   | (h) **`await rt.ensureCallGroupKey(...)`** = sender-cert (HTTP on miss) + per-member Signal session + `POST /envelopes` fan-out (≤8 parallel)                                                                                                                                    | `:2210-2214`; `productionRuntime.ts:6207-6421, 2788, 2808`                               | 200-1000 ms, more on cache misses [N][S] — only the RING needs to follow the key (pinned `groupCallRingOrder`)             |
| 3b   | (i) **`await waitForGroupCallKey`** if the key envelope has not landed — **25 s ceiling, fail-closed**; the wait sits AHEAD of `device.load`/transports, which do not need the key                                                                                               | `:2256-2315`; `groupCallKeyWait.ts:59-90`                                                | 0 if present; else the envelope's latency (comment `:2256-2262`: 10-20 s seen on cold/cellular) [N][S]                     |
| 3b   | `FrameCryptorOrchestrator.init()` (3 native calls) + SHA-256 diag                                                                                                                                                                                                                | `:2357-2377`                                                                             | 5-40 ms [F]                                                                                                                |
| 3c   | (h) `await wsRequest('sfu.ring')` — the ack gates nothing below                                                                                                                                                                                                                  | `:2455-2461`                                                                             | 1 WS RTT [N][S]                                                                                                            |
| 4    | `await device.load` — mediasoup-client builds **two throwaway PeerConnections** (`getNativeRtpCapabilities` ×2, each `createOffer`)                                                                                                                                              | `:2495-2496`; `node_modules/mediasoup-client/lib/Device.js:216,220`                      | 50-300 ms [F][S] — pre-warmable at ring/boot                                                                               |
| 5    | **`await turnPromise`** (see step 0)                                                                                                                                                                                                                                             | `:2501`                                                                                  | 0 … unbounded [⚠][N]                                                                                                       |
| 6-7  | `createSendTransport` / `createRecvTransport`                                                                                                                                                                                                                                    | `:2519-2551`                                                                             | 5-40 ms                                                                                                                    |
| 8    | `await` **audio** produce (`sfu.transport.connect` ack + `sfu.produce` ack + SDP + 3 cryptor calls) **then** `await` **video** produce (`sfu.produce` ack + SDP + 3 calls)                                                                                                       | `:2906-2916, 2964-2971`                                                                  | 2 + 1 WS RTT + 2 SDP cycles [N][S]                                                                                         |
| 9    | ⚠ **`for (const ep of existingProducers) { await consumeProducer(ep) }` — SERIAL.** Each: `sfu.consume` ack → `recv.consume` (SDP; first one also `sfu.transport.connect` recv) → 4 cryptor calls → **`sfu.consumer.resume` ack** (server creates every consumer `paused: true`) | `:3005-3006, 3176-3300`; `sfu.service.ts:817-821, 871-890`                               | **2 WS RTT + 1 SDP + 4 bridge calls PER PRODUCER, one at a time** [⚠][N][S]. Peer #3's audio waits behind peer #1's video. |
| 9b   | drain early-producer buffer                                                                                                                                                                                                                                                      | `:3057`                                                                                  | —                                                                                                                          |
| 10   | ⚠ **`await rt.broadcastGroupCallPresence(...)`** (per recipient: session ensure/identity fetch → HTTP on miss) — nothing after it depends on it                                                                                                                                  | `:3037-3043`; `productionRuntime.ts:5157-5194`                                           | 20-200 ms warm; HTTP on misses [⚠][N][S]                                                                                   |
| 11   | `setState('joined')`                                                                                                                                                                                                                                                             | `:3772`                                                                                  | —                                                                                                                          |
| 12   | ⚠ `InCallManager.start` only when `state==='joined' && micPermGranted && btPermResolved` — `btPermResolved` waits for the **BLUETOOTH_CONNECT dialog** on API ≥ 31                                                                                                               | `GroupCallScreen.tsx:288-292, 329, 247-262`                                              | 0 if granted; a first-call dialog = unbounded [⚠][W]                                                                       |

**Counts for an invitee joining 3 peers (3 audio + 2 video producers) _(derived from the code)_:** **15 sequential WS acks** (join, send-connect, produce ×2, recv-connect, consume+resume ×5), **~10 native SDP cycles**, **29 awaited FrameCryptor bridge calls**, 1-4 HTTP requests — all before `'joined'`, and the audio session starts only after that. The server's own minimum is **2 + 2N round trips** (`sfu.service.ts:552-559` ack carries producer IDs only, never consumers; consumers are created paused; no batch endpoint).

**Measured anchor already in the repo:** B-342 (sqa.md, 2026-07-30) — _"10.8 s between `sfu.join` and `ring.send`: Device.load, both transports, DTLS, producing audio+video, the early-producer drain and an AWAITED presence fan-out"_. The B-342 fix moved the **ring** earlier; **the join chain itself was left intact**, and an invitee walks the same chain.

---

## 2. The defects (what is actually wrong, not just slow)

| id        | Defect                                                                                                                                                                                                                                                                                                                                                          | Evidence                                                                                                                                                                                                                                                                                                                  | Class            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **B-596** | Relay bins the caller's first ICE candidates: `handleCallOffer` awaits `isBlockedEither` (Supabase, 60 s cache, no timeout) **before** `trackCallStart`; `handleCallIce` silently `{ignore}`s frames for an untracked callId. The client's B-273 gate flushes its whole candidate buffer the instant the offer is emitted, so they arrive in the same TCP read. | `messenger.gateway.ts:1486, 1501, 1750-1752, 3158-3168`; **staging log** cid `30538aee` (5 ICE logged at 05:21:56.5814-.5815, OFFER at .58157), cid `e35bd9d0` (3 ICE before OFFER at 05:22:55.8997) — see §3.1. Gate added 2026-07-06 (`dd8c184a`), B-273 fixed 2026-07-26 (`93a793c2`) — **B-273 was only half-fixed**. | P1 server, live  |
| **B-597** | Same class on the group ring: `handleSfuRing` awaits `Promise.all(isBlockedEither ×N)` before the **first** WS ring emit; no deadline.                                                                                                                                                                                                                          | `messenger.gateway.ts:2445`; `user-privacy.service.ts:125-131`                                                                                                                                                                                                                                                            | P2 server        |
| **B-598** | Group TURN fetch has **no ceiling** and is awaited before any transport exists; 1:1 has the 6 s cap, group does not. Neither caches the 24 h credential (`expiresAt` is returned and ignored).                                                                                                                                                                  | `useGroupCall.ts:1628, 2501, 5662-5690`; `CallScreen.tsx:822-826, 868`; `apps/messenger-service/src/turn/turn.controller.ts:20`; `configuration.ts:113` (TTL 86400)                                                                                                                                                       | P1 client        |
| **B-599** | Group join serializes what the protocol allows in parallel: serial consume loop (defeats mediasoup-client's own coalescing in `Transport.js:416-427`), audio-then-video produce, getUserMedia ahead of `sfu.join`, key-wait ahead of `device.load`, awaited ring ack, awaited presence fan-out before `'joined'`.                                               | `useGroupCall.ts:1913→1997, 2210, 2308, 2455, 2495, 2906→2964, 3005-3006, 3037-3043, 3772`                                                                                                                                                                                                                                | P1 client (perf) |
| **B-600** | Group audio session gated on `'joined'` **and** the BLUETOOTH_CONNECT prompt; a first-call user hears nothing until they answer a dialog that has nothing to do with audio.                                                                                                                                                                                     | `GroupCallScreen.tsx:247-262, 288-292, 329`                                                                                                                                                                                                                                                                               | P2 client        |
| **B-601** | 1:1 answerer builds the PeerConnection and applies the remote offer only inside `accept()`, and acquires media strictly after; TURN creds are fetched per `CallScreen` mount (on the critical path for every notification answer) — nothing is pre-warmed during the 45 s ring.                                                                                 | `callController.ts:713-752`; `useCall.ts:340, 583-586, 829`; `CallScreen.tsx:827-907, 919`                                                                                                                                                                                                                                | P1 client (perf) |
| **B-602** | Group ring frames (`sfu.ring.*`) are not in `CALL_FRAME_EVENTS`, so on a cold boot the replayed ring is buffered behind `depsReady` (the SQLCipher hydrate) while 1:1 call frames bypass it — the B-479 restore-mode park/ack lane inherits the whole hydrate.                                                                                                  | `productionRuntime.ts:1455`; `callFrameRouter.ts:19-38`; `MainNavigator.tsx:1227-1299`; `groupCallRingDispatcher.ts:90-95`                                                                                                                                                                                                | P2 client        |

**Observed but unexplained (for Step 0 to chase):** staging cid `548f044f` 2026-08-20 — RE-OFFER from `3165d0e1` at 09:42:25.46, RE-ANSWER from `88d34848` at 09:42:30.46 = **5.0 s** for a re-answer on a device whose camera was already on (`cam=on` at 09:42:22.85). The renegotiation path (`callController.ts:887-1010`, `renegotiationInFlight`) has no release-visible timing.

---

## 3. Evidence

### 3.1 Staging relay log — ICE before OFFER (the B-596 signature)

`docker logs -t bravo-staging-msgr` (UTC). `[CALL] ICE` prints at `messenger.gateway.ts:1749` **before** `authorizeCallFrame`; `[CALL] OFFER from=` prints at `:1494` **after** the privacy await. So "ICE lines above the OFFER line for the same cid" = candidates processed while the session did not exist = dropped.

```
2026-08-19T05:21:56.581498068Z [CALL] ICE from=608290a3/1 → aeb2e71e/1 cid=30538aee mid=0 idx=0 candLen=119
2026-08-19T05:21:56.581539930Z [CALL] ICE ... cid=30538aee candLen=145
2026-08-19T05:21:56.581545619Z [CALL] ICE ... cid=30538aee candLen=203
2026-08-19T05:21:56.581549354Z [CALL] ICE ... cid=30538aee candLen=152
2026-08-19T05:21:56.581552218Z [CALL] ICE ... cid=30538aee candLen=147
2026-08-19T05:21:56.581578168Z [CALL] OFFER from=608290a3/1 → aeb2e71e/1 cid=30538aee kind=video sdpLen=3780
2026-08-19T05:21:56.618782068Z [CALL] ICE ... cid=30538aee candLen=156        ← only this one survived

2026-08-19T05:22:55.899377767Z [CALL] ICE from=608290a3/1 → aeb2e71e/1 cid=e35bd9d0 candLen=119
2026-08-19T05:22:55.899640914Z [CALL] ICE ... cid=e35bd9d0 candLen=145
2026-08-19T05:22:55.899686792Z [CALL] ICE ... cid=e35bd9d0 candLen=151
2026-08-19T05:22:55.899757569Z [CALL] OFFER from=608290a3/1 → aeb2e71e/1 cid=e35bd9d0 kind=voice sdpLen=1322
```

The 80 µs gap shows this burst was a cache **hit** (the await resumed on a microtask) — the candidates still lost because socket.io dispatches every frame in the same TCP read synchronously before the microtask runs. On a cache **miss** the window is the full Supabase RTT. Other calls in the window (`f30568b3`, `a30fe5dc`, `7e052d9a`, `86a11e45`, `548f044f`, `aed9debd`) show OFFER first with ICE 140-180 ms later — the candidates had not been gathered yet at emit time on that device, so they survived. **Whether a given call loses its candidates is a race between the caller's gathering speed and its `buildOfferAuth`+emit time** — exactly the kind of "sometimes slow" the founder reports.

### 3.2 Staging relay log — answer and socket timing

- `a30fe5dc` (video): OFFER 08:35:47.594 → ANSWER 08:35:57.292 (9.7 s incl. ring); answerer ICE 150-400 ms after the answer.
- `548f044f` (voice): OFFER 09:41:59.099 → ANSWER 09:42:03.588 (4.5 s incl. ring); the answerer's 2nd/3rd candidates arrived **3.0 s** after its first (09:42:03.79 → 09:42:06.60) — consistent with a slow TURN allocation or srflx on that device.
- `aed9debd`: OFFER 11:28:46 → `peer_offline`; callee `ws open` 11:29:38 (+52 s) — killed-app lane, missed.
- Group ring `c1c0edcf` 14:06:53.68 → invitee sockets open 14:07:05.82 (+12.1 s) and 14:07:09.49 (+15.8 s), each immediately followed by `replay pending group-ring`; `ring-ack` at 14:07:10.1.
- `[SFU] room.create` / `[SFU] join` lines (WI-7.2) do **not** appear in 30 days of staging logs: the staging container (`Up 3 days`) predates the uncommitted Phase 6/7 tree. Any server-side join timing will need that deploy first.

### 3.3 Already-measured numbers in `sqa.md`

- **B-342** — host boot: 36 s in `getUserMedia` (camera queue), **10.8 s `sfu.join` → ring** through Device.load/transports/DTLS/produce/early-drain/awaited presence.
- **B-340** — invitee never joined: silent camera-permission stall inside `getUserMedia`.
- **B-319** — answer-from-notification stuck: `iceServers` null → no controller → accept parked (now retried; the wait itself is still on the path — §1.2 N2).
- **B-110/F-1** — TURN fetch rode a dead socket for ~35 s; the 6 s ceiling was added to `CallScreen` only.
- **B-273** — ICE before offer, client half fixed 2026-07-26; server half (B-596) open.

---

## 4. What is NOT the problem (checked today — do not re-propose without new numbers)

| Candidate                                           | Finding                                                                                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------ |
| Server-side mutex / room lock on `sfu.join`         | None; `pendingJoins` is a reservation map, not a lock (`sfu.service.ts:1161`). No `setTimeout`/debounce on the join path.                                            |
| Rate limiter dropping ICE or consume bursts         | `call.ice` 40/s burst 200 (`ws-rate-limiter.ts:126`); `sfu.consume/resume/produce/transport.connect` have **no** limit entry and never call `rateGate`.              |
| Mediasoup worker/router creation at join            | Workers pre-spawned at boot (`sfuWorkerPool.ts:44-56`); router created once per room at `POST /sfu/rooms`, never at join.                                            |
| `connected` gated on the DTLS poll                  | No — promoted directly off the ICE event (`callController.ts:1831`); the poll only gates `onSecured`/`playoutDelayHint`.                                             |
| Waiting for ICE gathering `'complete'`              | Nothing awaits it (1:1 or group); trickle is used. `iceCandidatePoolSize: 0` is a deliberate, documented trade (`peerConnection.ts:208-219`) — leave it.             |
| `iceTransportPolicy: 'relay'`                       | Default `'all'` on both paths (`peerConnection.ts:97-101`; `useGroupCall.ts:2522, 2549`).                                                                            |
| Cold Supabase block-check **inside** `sfu.join`     | Not present — the join handler's only awaits are the Redis rate counter and the two transport creates.                                                               |
| A remote-track mute/volume gate after `'connected'` | None found (grep `getAudioTracks                                                                                                                                     | setVolume | remoteStream.\*enabled` in CallScreen/useCall: empty). |
| "The app feels laggy" JS-thread class (B-279/B-285) | Still real and still unmeasured for the call lane; Step 0 records JS-thread drift alongside the call markers so it can be separated, but nothing here depends on it. |

---

## 5. Fix plan — ordered steps, each handed to another session as a prompt

**Ordering rule:** measure → server defect (smallest diff, biggest certainty) → the two client lanes in parallel → notification/killed lanes → pins + device sign-off. Steps 2 and 3 are independent and can run as two parallel sessions on separate branches (different files). Each step **closes only when its Edge-case agent and its Critic both write AGREE** (the same consensus loop that converged Phases 5-7 — see `docs/planning/CALL_RACE_HARDENING_SPEC.md` §18-§20).

| Step | Scope                                                                                                                                                                                | Expected payoff _(est.)_                                                                                | Risk   | Models (Builder / Edge / Critic) |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------ | -------------------------------- |
| 0    | Instrument every lane with release-visible timing markers; capture a 3-device matrix; produce the real budget                                                                        | Turns every _(est.)_ above into a number; ranks the rest                                                | none   | Opus 5 / Opus 5 / Fable 5        |
| 1    | Server: register the call session before any await (B-596); bound the block-check; same for the group ring (B-597); server join-path timing logs                                     | 1:1 connects on the first candidates (host/srflx instead of relay): **−0.5 to −2 s**, better media path | low    | Fable 5 / Opus 5 / Fable 5       |
| 2    | 1:1 client: pre-warm at ring (PC + remote offer + TURN cache), parallelize accept, cache TURN app-wide (B-601)                                                                       | **−0.3 to −1.5 s** warm; **−1 to −6 s** on notification answers (TURN off the path)                     | medium | Fable 5 / Fable 5 / Fable 5      |
| 3a   | Group client, low-risk half: TURN ceiling + cache + STUN-first (B-598), `void` presence, audio session at `'joining'` independent of BT (B-600), media ‖ join, audio ‖ video produce | **−1 to −3 s**; removes two unbounded stalls                                                            | low    | Opus 5 / Opus 5 / Fable 5        |
| 3b   | Group client, consume parallelization + key-wait overlap + `device.load` pre-warm (B-599)                                                                                            | **−1 to −4 s** for a 3-peer room, grows with N                                                          | medium | Fable 5 / Fable 5 / Fable 5      |
| 4    | Group server: batch consume + audio consumers unpaused (video stays paused+keyframe), parallel transport creates, join ack carries what the client needs in one frame                | halves the per-peer round trips: **−0.5 to −2 s** for 3 peers, more on mobile RTT                       | medium | Fable 5 / Opus 5 / Fable 5       |
| 5    | Notification / killed lanes: TURN pre-fetch at the FCM wake, call-lane-first boot ordering, the lean-runtime question from B-352                                                     | the 12-52 s tail; needs Step 0's numbers first                                                          | high   | Fable 5 / Fable 5 / Fable 5      |
| 6    | Pins + A/B device matrix + spec §21 + sqa close-out                                                                                                                                  | makes every gain permanent                                                                              | none   | Opus 5 / Opus 5 / Fable 5        |

---

## 6. Universal preamble — paste at the top of EVERY step prompt

```text
You are implementing ONE step of docs/audits/CALL_JOIN_LATENCY_AUDIT_2026-08-20.md in repo
C:/Users/User/OneDrive/Documents/brave_secure/Bravo_Secure. Read that document FIRST (all of it —
it is short), then LOOP.md, then the CLAUDE.md sections "Messenger regression gate", "The bug-
regression contract", "Two syntax traps", "Change safety rules" (esp. rule 8 self-diff) and
"The call-registry identity rule". Then read docs/planning/CALL_RACE_HARDENING_SPEC.md §3 (hard
constraints), §8 (what NOT to change), §11 (DO-NOT-RE-PROPOSE) and the DO-NOT-RE-ADD tables in
§17-§19. For any file you touch, re-grep every symbol — line numbers in the audit are stamped,
not trusted. Client files are CRLF; apps/messenger-service is LF. Never put a backtick inside a
comment inside a template literal. A source-scan test must strip comments and use \r?\n.

THE CONSENSUS LOOP (mandatory — this step is not done until it converges):
  Roles: BUILDER (you), EDGE-CASE AGENT, CRITIC. Spawn the two reviewers as subagents with the
  models named in the step; give each the full diff, the audit section, and the test list.
  1. BUILDER implements the step with RED-first tests (prove each new pin RED by reverting the
     fix — mutation-prove, print the mutated region to confirm the mutation APPLIED), then runs
     the gates.
  2. EDGE-CASE AGENT: writes a numbered table of edge cases for this change (concurrency, app
     state transitions — foreground/background/killed/Doze, WS reconnect mid-step, permission
     denied/pending, cancel/hangup mid-step, rejoin/restore, multi-device signalDeviceId=1, slow
     network, the reused-group-roomId class from spec §17, the one-shot-spent-against-a-held-claim
     class from spec §18) and for each says HANDLED (file:line) / NOT HANDLED / N-A with reasoning.
     Ends with a verdict: AGREE or OBJECT (with the unhandled rows).
  3. CRITIC: reviews as an adversarial PR reviewer (spec §7 gates, CLAUDE.md identity rule, the
     B-125 "green suite is not evidence for productionRuntime" rule, security stop-conditions,
     the self-diff rule — enumerate consumers of every piece of state you moved/deleted, MESSAGE_LOOP
     §5 caller-completeness for every shared symbol), tries to REFUTE the latency claim (does the
     change actually remove the wait, or move it?), and checks that every new marker is
     console.warn (release-visible) with ids only (logAudit bans plaintext/keys/`signature`).
     Ends with AGREE or OBJECT (numbered findings with file:line).
  4. If either OBJECTs: fix, re-run gates, re-send BOTH reviewers the new diff + your response to
     each numbered finding. Repeat until BOTH write AGREE in the same round. Record the round
     count and each round's findings in the sqa.md entry (the repo's convention, see B-546..B-568).
  Model rule: the CRITIC is always Fable 5. BUILDER/EDGE use the models named in the step
  (Opus 5 for mechanical work, Fable 5 where the reasoning is the work).

GATES (all must be green before you say done; run the crypto project TWICE — one red run is not
evidence, a failure that MOVES is the B-126 flake):
  npx jest --selectProjects messenger-crypto        # twice
  npx jest --selectProjects app --testPathPattern "screens/messenger"
  npm run typecheck                                   # must not exceed .tsc-baseline.json (47)
  (server steps) cd apps/messenger-service && npm test
  npm run lint
DELIVERABLES: the diff; RED-first tests (named after the B-number they pin); sqa.md entry under
the B-number(s) the audit assigned (status, rounds, findings, files, evidence); a §21 row in
docs/planning/CALL_RACE_HARDENING_SPEC.md (outcome table, DO-NOT-RE-ADD additions); the
before/after [CALLDIAG] timing lines from a device if the step says so. Do NOT commit or push
unless the founder says so; say explicitly what is uncommitted.
STOP CONDITIONS: anything in CLAUDE.md "Security constraints" (sealed-sender, sender-cert,
group key distribution, MFA gates, relay dwell, envelope ids) — stop and surface it; do NOT weaken
a verify; do NOT touch iceCandidatePoolSize / iceTransportPolicy / bundlePolicy (measured and
documented in peerConnection.ts); do NOT re-propose anything in audit §4.
```

---

## 7. The step prompts

### Step 0 — Instrument and MEASURE (Builder: Opus 5 · Edge: Opus 5 · Critic: Fable 5)

```text
[paste §6 preamble]

STEP 0 — make the call-join budget measurable on a release build, then measure it.

Context: audit §1 lists the steps; §1.1-§1.4 and the agent traces found that most steps have NO
release-visible marker (console.log is stripped by babel-plugin-transform-remove-console; only
console.warn/error survive). Today the answerer's accept path has five [CALLDIAG] warns
(callController.ts accept:begin / remote-offer-applied / local-media-attached / answer-created /
call.answer delivered) and the ICE state line; the group boot has warns at steps 1,2,3,3b only;
the caller path, the TURN fetch success, controllerReady, getUserMedia duration on success,
device.load, transports, produce, every consume/resume, the presence broadcast, setState('joined'),
InCallManager.start, DTLS verify ok and "first remote audio bytes" have NONE. The server's
[CALL] lines are console.log without their own timestamps (docker -t supplies them) and print the
OFFER line AFTER the privacy await; no sfu.* handler logs a duration.

DO (client):
 1. Add a tiny helper in src/modules/messenger/runtime/callDiag.ts: `logCallLat(lane, step,
    fields)` that emits `console.warn('[CALLLAT] lane=<1to1-in|1to1-out|grp-host|grp-join>
    cid=<8> step=<name> t=<ms since lane start> dt=<ms since previous step> ...ids only')`.
    Lane start = the FIRST marker of that lane (ring received / tap / boot IIFE entry). Use a
    monotonic clock (performance.now() if available, else Date.now()); keep one module-level map
    keyed by cid/roomId with a 5-minute TTL and clear on lane end. Ids only — NEVER an SDP, a
    candidate string, a key, a user name.
 2. Bracket EVERY row of audit §1.1, §1.2 (N1-N3), §1.3 (C1-C6 client side) and §1.4 (pre..12)
    with a [CALLLAT] marker. Minimum set (re-grep each): CallScreen tap/autoAccept entry,
    TURN fetch start + ok/fail (+ms), useCall controllerReady flip, accept:begin (existing), PC
    built, remote-offer-applied (existing), pendingIce drained (count), getUserMedia start/end
    (+video flag, permission-prompt-shown flag), answer-created (existing), call.answer emitted
    (SIG waitOpenThenSend success path — add the marker there, with the wait ms), outbound ICE
    gate opened (+held count), first local candidate, iceConnectionState changes (existing, add
    t/dt), 'connected', dtls-verify-ok, first inbound audio bytes (one-shot from the existing 1 Hz
    stats poller in useCall: the first tick where inbound-rtp audio bytesReceived > 0),
    InCallManager.start. Caller: launch tap, TURN ok, getUserMedia, createOffer done,
    buildOfferAuth done (+cert cache hit/miss), offer emitted, ICE gate open, answer applied,
    connected. Group (useGroupCall.ts): boot entry, turn started/awaited-for-ms/ok-fail, step1
    room created/joined, step2 media (existing + duration), step3 join ack (+existingProducers
    count), 3a key ensured (+ms), 3b key wait (+ms waited), ring ack (+ms), device.load (+ms),
    transports created, audio produce done (+ms), video produce done (+ms), each consume:
    consume-ack / recv.consume done / cryptor attached / resume-ack (+ms each, kind, index),
    presence broadcast done (+ms), setState('joined'), InCallManager.start (+btPermResolved flag,
    +ms since joined), first remote audio bytes (one-shot from stats).
 3. Also emit the JS-thread watchdog drift (src/utils/jsThreadWatchdog.ts) if it exceeds 120 ms
    inside a lane, as `[CALLLAT] ... step=js-stall dt=<ms>` so a B-279-class stall can be told
    apart from a network wait.
DO (server, apps/messenger-service):
 4. In messenger.gateway.ts: move the `[CALL] OFFER from=` log ABOVE the privacy await (or add
    `[CALL] OFFER recv` there) and add `[CALL] ICE ignored cid=<8> reason=no_session|ended` in
    the handleCallIce ignore branch (console.warn, ids only). Add a Nest-logger duration line to
    handleSfuJoin, handleSfuTransportConnect, handleSfuProduce, handleSfuConsume,
    handleSfuConsumerResume: `[SFU] <event> rid= uid= ms=<handler ms>`. Subscribe mediasoup
    transport 'icestatechange' and 'dtlsstatechange' in sfu.service createWebRtcTransport and log
    them with rid/tag/state (ids only). Do not change any behaviour in this step.
 5. Do NOT deploy the server in this step unless the founder authorizes it; say it is owed.
MEASURE (device — founder rule: not "done" until the marker warn is SEEN in a post-install log):
 6. Build the release APK (npm run apk:staging), install on ALL adb devices (memory: both
    BlueStacks on 5555/5556 + the Redmi over wireless adb; run `adb logcat -G 64M` first), and
    capture, per lane, at least 3 runs each of: 1:1 voice + video, answer in-app foreground;
    answer from notification with the app backgrounded; answer from notification with the app
    KILLED; group start as host with 2 invitees; group join as invitee into a room of 3 (two
    cameras on); group join as a killed invitee. Interleave runs (A/B rule from CLAUDE.md:
    device thermal drift lies). Pull logcat for [CALLLAT] + [CALLDIAG] + [CALLSM] and the staging
    relay `docker logs -t` [CALL]/[SFU] lines for the same minute.
 7. Produce docs/audits/CALL_JOIN_LATENCY_MEASURED_<date>.md: one table per lane, columns =
    step | median ms | max ms | n, plus the per-call waterfall for the slowest run of each lane,
    plus a ranked list "where the time actually goes" with the §2 defect ids mapped onto it.
    Explicitly answer: (a) is getUserMedia(video) > 500 ms on these devices? (b) how long is the
    TURN fetch on a warm vs post-background socket? (c) how many [CALL] ICE ignored lines per
    call? (d) the 5.0 s re-answer gap (audit §2 "observed but unexplained") — reproduce a video
    upgrade and read the renegotiation markers you added; (e) killed-lane: ms from FCM wake to
    ws open to SDP available to accept.
TESTS: a source-scan test `callLatMarkers.test.ts` (messenger-crypto project) asserting each of
the markers above exists AT ITS SITE (anchor on the executing line, strip comments, \r?\n), that
every [CALLLAT] call uses console.warn, and that no marker formats an sdp/candidate/key field
(logAudit.test.ts must stay green). Server: a spec that the ICE-ignored warn fires for an
untracked cid.
EDGE-CASE AGENT focus: marker cost on the JS thread (no string building on hot paths like
onicecandidate beyond ids), the TTL map not leaking across rejoins/restores (reused roomId!),
markers firing on a stale controller instance (gen mismatch), markers on the headless VM.
CRITIC focus: are the markers at the DECISION sites (not a line before/after an await that lets
them lie)? Is the "first audio bytes" one-shot correct for a reused controller? Does any marker
print user-identifying data? Is the measured doc honest about n and device?
```

### Step 1 — Server: the session-before-await fix (B-596), the bounded block-check (B-597), join-path timing (Builder: Fable 5 · Edge: Opus 5 · Critic: Fable 5)

```text
[paste §6 preamble]

STEP 1 — close the server half of B-273: register the 1:1 call session BEFORE any await in
handleCallOffer, so trickled ICE that arrives while the offer handler is parked is never
`{ignore}`d; bound the Supabase block-check on both call lanes; keep the M-07 privacy semantics
EXACTLY (no oracle to the caller, no forward, no wake, no queued offer when blocked).

Files: apps/messenger-service/src/gateway/messenger.gateway.ts (handleCallOffer ~L1461-1606,
handleCallIce ~L1734-1777, authorizeCallFrame ~L3158-3177, trackCallStart/trackCallEnd,
handleSfuRing ~L2374-2587 at the Promise.all(isBlockedEither) line);
apps/messenger-service/src/users/user-privacy.service.ts (isBlockedEither/cached/fetchBlockedEither).
Re-grep all of these. Read audit §1.3 C4, §2 B-596/B-597, §3.1.

DESIGN (argue it, then do it):
 A. In handleCallOffer, after the sync guards (ctx, rateGate, missing auth), call
    trackCallStart(...) SYNCHRONOUSLY (before the privacy await). Then `await isBlockedEither`.
    If blocked: trackCallEnd/delete the session WITHOUT any forward/emit/queue/wake (today's
    M-07 behaviour — the session must not linger as a tombstone that could be observed; check
    what trackCallEnd does with tombstones and whether a 60 s tombstone leaks anything to a
    third party — it must not). Any ICE frames that slipped through for that cid during the
    window must have been forwarded to NOBODY: handleCallIce forwards to `data.to` — on a
    blocked pair that would be an oracle. So EITHER (preferred) make handleCallIce hold
    candidates for a session in state 'offer-pending' (a per-session bounded array, cap 64,
    flushed to the callee right after the offer forward succeeds, discarded on blocked/duplicate/
    peer_offline error) — OR keep forwarding immediately but ONLY after the session is marked
    'offer-forwarded'. Write down which you chose and why; the Critic must be able to refute the
    oracle argument. The 'ringing' state today is set by trackCallStart — do not let a held
    candidate reach the callee before the offer frame (ordering on the callee matters: the
    client dispatcher queues pre-registration frames, but the callee's pendingIce cap is 64).
 B. Bound isBlockedEither on the two call lanes only: Promise.race against a deadline
    (start at 250 ms; make it a config value `PRIVACY_CALL_GATE_DEADLINE_MS`), and on deadline
    behave exactly as on error (the service already fails OPEN on error — this is the SAME
    class; state that in a `// Why:` comment). Do NOT change the cache TTL or the messaging
    lanes. Keep the single-flight. If the Critic judges fail-open-on-timeout a security change,
    STOP and surface it to the founder instead of shipping it (CLAUDE.md stop-condition) — ship A
    alone in that case.
 C. handleSfuRing: emit the WS rings FIRST for targets whose block flag is already cached, then
    await the rest — or at minimum apply the same deadline. Keep ringId minting per fan-out
    (B-336) and the per-target Redis MULTI semantics; do NOT touch the push lane.
 D. Keep the Step 0 [CALL] OFFER recv / ICE ignored warns (add them here if Step 0 has not
    shipped — same lines).
TESTS (RED first, messenger-service jest; extend messenger.gateway.calls.spec.ts or add
messenger.gateway.offer-ordering.spec.ts): (1) privacy stub resolves on a later macrotask; call
handleCallOffer (not awaited) then handleCallIce ×3 synchronously; assert the callee receives the
offer THEN all 3 candidates, in order — RED today (they are dropped). (2) blocked pair: no offer,
no ICE, no wake, no queued offer reaches anyone, no error to the caller, and no session/tombstone
is observable via authorizeCallFrame from a third party. (3) deadline: a never-resolving privacy
stub → offer forwards after the deadline. (4) ring: first WS ring emitted before the slowest
block-check resolves. Plus a source-scan pin: in handleCallOffer the trackCallStart call site
precedes the first `await` (strip comments; LF file).
EDGE-CASE AGENT focus: duplicate callId re-offer during the window; caller hangs up inside the
window (hangup arrives before the offer forward — must not forward a stale offer after a
hangup); callee offline (peer_offline) with held candidates (discard, do not queue them into the
pending-offer replay unless you also replay them — decide and pin); multi-replica (the session map
is per replica — a candidate on replica B for a session on replica A was ALREADY dropped today;
do not regress, note it); the held-candidate array lifetime on trackCallEnd; rate-limiter
interplay (a 64-candidate burst on call.ice is within 40/s burst 200 — confirm).
CRITIC focus: refute the oracle argument for A; confirm no behavioural change for blocked pairs;
confirm the [CALL] log order now reads OFFER recv → ICE; confirm the fix is not "move the await
later" but "session exists before the await"; confirm Step 0's ICE-ignored counter goes to zero
in the spec. Device/server evidence: deploy to staging ONLY if the founder authorizes (memory:
tar-over-ssh + docker compose build/up, rsync is broken on the box); otherwise say the deploy is
owed and the before/after `[CALL] ICE ignored` count is the acceptance signal.
```

### Step 2 — 1:1 client: pre-warm at ring, parallelize accept, cache TURN (B-601) (Builder: Fable 5 · Edge: Fable 5 · Critic: Fable 5)

```text
[paste §6 preamble]

STEP 2 — make the 1:1 answerer do during the ring what it does today after Accept, without
lighting the mic/camera or leaking an address before the user taps.

Read audit §1.1, §1.2, §2 B-601, §4. Files: src/modules/messenger/webrtc/callController.ts
(acceptInner ~L700-795, buildPc ~L1736, handleIncomingOffer, pendingIce/drainPendingIce
~L518-530, remoteDescriptionApplied), src/modules/messenger/webrtc/useCall.ts (boot ~L545-1040,
ensureLocalMedia ~L560-586, attachLocalMedia ~L793-916, controllerReady), src/screens/messenger/
CallScreen.tsx (TURN fetch ~L827-907, callArgs gate ~L919, accept effect ~L1273-1321),
src/modules/messenger/webrtc/peerConnection.ts, peerConnectionFactory.ts (getLocalMedia),
src/modules/messenger/push/fcmBootstrap.ts (the answer lanes that navigate CallScreen with
autoAccept ~L1166-1175, 2335-2350). Re-grep everything.

DESIGN — four independent changes; land them as four commits-worth of diff, each with its own
RED test, in this order:
 2.1 TURN credential cache + pre-fetch. New module src/modules/messenger/webrtc/turnCredentials.ts:
     `getIceServers({ceilingMs})` returns cached iceServers while `expiresAt - now > 5 min`
     (the server returns expiresAt; TTL is 24 h), else fetches with the existing
     TURN_FETCH_CEILING_MS race + STUN fallback (move the CallScreen logic here verbatim — same
     X-Signal-Device-Id header, same fetchWithRefresh, same stun unshift), single-flight,
     invalidate on 401/403 and on signOut. `prewarmIceServers()` = fire-and-forget, called from:
     MainNavigator when the production runtime becomes ready, AppState active, the WS offer/ring
     arrival (MainNavigator onIncoming + groupCallRingDispatcher), and the FCM voip-wake handlers
     (fcmBootstrap) BEFORE they navigate. CallScreen and useGroupCall consume it (useGroupCall's
     own fetchTurnCredentials is retired in Step 3a — coordinate: if Step 3a already landed, just
     switch its import). Pin: a source-scan that CallScreen no longer contains a raw
     `webrtc/turn-credentials` fetch, and a unit test for the cache/TTL/single-flight/invalidation.
 2.2 Build the PC and apply the remote offer AT RING TIME. In the controller, when
     handleIncomingOffer runs and iceServers are known, build the PC and `setRemoteOffer`, flip
     remoteDescriptionApplied, and drain pendingIce — all BEFORE the user accepts. Confirm with
     the react-native-webrtc/libwebrtc behaviour that with NO local description the ICE agent
     neither gathers nor sends checks (no address leaks before accept) — cite the mechanism in a
     `// Why:` and pin it in a test that asserts no onicecandidate / no sendIce before accept.
     acceptInner then becomes: (reuse pc) → attachLocalMedia → createAnswer → send. If iceServers
     are NOT known at ring (the notification lanes before 2.1's prewarm lands), keep today's
     build-at-accept path — both paths must exist and be tested. Decline/timeout/cancel must
     close the pre-built PC (enumerate every teardown path: end(), hangup('declined'), ring
     expiry, B-64 zombie end, endActiveCall keyed teardown, the overlay). The CALL_RACE identity
     rule applies: the pre-built PC belongs to {callId, gen}; a second offer for the same callId
     (re-offer, replay) must not leak the first PC. Re-read spec §13 (Phase 1) and §16 (Phase 2
     state machine: the pre-built PC must not move state off 'ringing').
 2.3 Parallelize what is left in accept: if 2.2 did not apply (no PC at ring), run
     setRemoteOffer+drainPendingIce CONCURRENTLY with attachLocalMedia (they are independent;
     addTrack must still happen after setRemoteOffer on the answerer — so await setRemoteOffer
     before addTrack but start getUserMedia at the same time as setRemoteOffer). In getLocalMedia,
     skip `requestMultiple` when `check` already says granted (keep the prompt path + B-340 warns).
     Keep the B-274 guarantee (an accept that cannot answer ends the call as failed).
 2.4 Accept from the press handler: call liveCall.accept() directly in onPress (keeping the
     effect path for autoAccept and as the fallback when controllerReady is false — the B-319
     latch). Do not introduce a second accept path that can double-fire: the one-shot latch
     (autoAcceptedRef) must cover both.
DO NOT: pre-acquire the mic/camera at ring (product/privacy decision — list it in the report as
an option for the founder with Signal/WhatsApp behaviour described; not yours to make); change
iceCandidatePoolSize/iceTransportPolicy/bundlePolicy; touch the answer-send budget constants
(callDeadlines.ts relationships).
TESTS (RED first, messenger-crypto project): controller tests with a fake PC wrapper that
RECORDS the call order — assert the new order (PC built + remote applied before accept; no local
description / no candidate before accept; answer created after media; decline closes the
pre-built PC; re-offer for the same callId closes the old PC; gen mismatch is dropped). TURN cache
unit tests. A CallScreen/useCall seam test for 2.4 (no double accept). Mutation-prove each pin by
reverting the relevant hunk and printing the mutated region.
EDGE-CASE AGENT focus (Fable): the eleven delivery lanes in spec §1.5 — which of them reach
handleIncomingOffer with iceServers null? The B-331 unhandled-offer cache path; the Phase 5
dispatchEpoch/bornEpoch re-check (a pre-built PC for an offer whose verifier completes into a
new session); a ring that ends (cancel/decline/timeout) while setRemoteOffer is mid-flight; the
call-waiting Answer path (callWaiting.ts replaces the screen); minimize/restore remount with a
pre-built PC; Android permission prompt mid-accept; a second device answering first
(answered-elsewhere cancel, B-561) with a pre-built PC.
CRITIC focus (Fable): refute "no leak before accept" with the actual RN-WebRTC behaviour; refute
"this removes the wait" by walking the new accept path's awaits; the identity rule on every new
registry write; the self-diff rule on the moved TURN code (every consumer of iceServers:
CallScreen, useCall opts, FloatingCallOverlay restore, the group path); that the prewarm cannot
produce a refresh storm (single-flight + TTL) or a token refresh loop at boot (B-352 E2 lesson).
Device evidence (owed in this step): before/after [CALLLAT] waterfalls for in-app answer and
notification answer on the Redmi; the "accept:begin → call.answer emitted" delta must shrink
and the notification lane must show "turn ok" BEFORE the tap.
```

### Step 3a — Group client, low-risk half (B-598, B-600, parts of B-599) (Builder: Opus 5 · Edge: Opus 5 · Critic: Fable 5)

```text
[paste §6 preamble]

STEP 3a — remove the unbounded waits and the needless serialization in the group boot that do
NOT change the media/crypto ordering contracts.

Read audit §1.4 rows 0, 2, 5, 8, 10, 12 and §2 B-598/B-600/B-599. File: src/modules/messenger/
webrtc/useGroupCall.ts (boot IIFE ~L1498-3780; fetchTurnCredentials ~L5662; rejoin twin
~L3595-3630), src/screens/messenger/GroupCallScreen.tsx (perm effects ~L225-262, audio session
~L288-335), src/modules/messenger/webrtc/launchCall.ts (group branch ~L366-392). Re-grep.

DO, in this order, each with its own RED test:
 3a.1 TURN ceiling + cache: use the shared module from Step 2.1 if it exists (coordinate by
      checking the tree), else create it here (same spec). useGroupCall awaits it with the 6 s
      ceiling and STUN fallback; rejoin uses the cache (no serial fetch on rejoin unless expired).
      Pin: source scan that useGroupCall has no bare `/webrtc/turn-credentials` fetch and that the
      await at the transport-creation site is the ceiling'd call.
 3a.2 `void` the presence broadcast (step 10): broadcastGroupCallPresence becomes fire-and-forget
      with its existing failure warn; `setState('joined')` no longer waits for it. Pin: source
      scan (the call is not awaited) + a hook test that 'joined' lands before the broadcast
      promise resolves.
 3a.3 Audio session at 'joining': GroupCallScreen starts InCallManager/FGS when
      state==='joining' && micPermGranted (mic permission is necessarily granted after step 2),
      independent of btPermResolved; the BT prompt only affects route selection later. Keep the
      B-309 opening-route settle. Pin: screen test — InCallManager.start called with
      btPermResolved=false once state is 'joining'.
 3a.4 Media in parallel with the room/join: start getLocalMedia at the same time as (host)
      POST /sfu/rooms and (all) sfu.join; await the media promise right before the audio produce
      (step 8). KEEP the B-340/B-342 warns and the 15 s bound; KEEP `step=2 local media OK`
      semantics for the source scans that exist (grep groupCallRingOrder/localMediaTimeout/
      groupCall* tests for anchors and update them deliberately — never delete a pin). The
      second `requestMultiple` in GroupCallScreen must not race the first: dedupe via the
      existing permission state or remove the duplicate with a pin.
 3a.5 Produce audio and video concurrently (Promise.all of the two withTrackBlanked produces);
      keep the cryptor attach per producer; keep blanked-until-attached.
 3a.6 Host: navigate to GroupCallScreen immediately and let the room probe + listMine run in
      the background; the screen shows 'creating'. Check the B-334 host check and the B-320 busy
      gate still run BEFORE navigation (they are sync gates — keep them sync).
 3a.7 `void` the sfu.ring ack wait (keep the ok/failed warns and the ring-cancel-on-boot-failure
      logic from B-342; the still-ringing set must still be computed from the ack when it
      arrives).
TESTS: extend the existing useGroupCall hook harness (find it: grep "useGroupCall" under
src/modules/messenger/__tests__) — fake transport that records wsRequest order and resolves on
demand; assert: media + join overlap; produce a/v overlap; 'joined' before presence resolves;
TURN race resolves STUN at the ceiling; ring not awaited. Mutation-prove each.
EDGE-CASE AGENT focus: getUserMedia rejects AFTER sfu.join succeeded (must leave the room —
today's catch runs sfu.leave? verify and pin); permission dialog pending while the join ack
arrives; B-343 zombie camera (15 s bound still fails the boot visibly); rejoin path parity for
every change; the reused roomId (new ring while an old boot is mid-flight); TURN cache across
signOut/re-login; the 'creating' screen state with a failed room probe.
CRITIC focus: refute each "this is independent" claim by reading the code between the awaits;
confirm no pin was deleted (list every test whose anchor you touched and what it asserts now);
confirm the key-before-ring contract (groupCallRingOrder) is untouched; self-diff: consumers of
the presence broadcast result (none? prove it) and of btPermResolved.
Device evidence owed: before/after [CALLLAT] group waterfall on the Redmi (host + invitee).
```

### Step 3b — Group client: consume in parallel, overlap the key wait, pre-warm Device (B-599) (Builder: Fable 5 · Edge: Fable 5 · Critic: Fable 5)

```text
[paste §6 preamble]

STEP 3b — the group join's remaining serialization, where the ordering contracts are subtle.

Read audit §1.4 rows 3b, 4, 9 and §2 B-599; the group rejoin suites listed in CLAUDE.md
(groupCallAttemptGen, groupCallRejoinRace, groupCallRejoinHub, groupCallRoomScopedTimers) and
spec §14/§15 — the consume dedup (B-470/B-478) and the rebuild mark are the contracts you must
not break. File: src/modules/messenger/webrtc/useGroupCall.ts (consumeProducer/attemptConsume
~L3081-3300, step 9 loop ~L3001-3060, key wait ~L2233-2320, device.load ~L2495), groupCallKeyWait.ts,
frameCryptorOrchestrator.ts, groupCallProducerBuffer.ts. Re-grep.

DO:
 3b.1 Parallel consume of existingProducers: `await Promise.all(existing.map(consumeProducer))`
      — audio producers first (kick them first; do not make video wait for audio, just order the
      starts), relying on the existing in-flight/consumed dedup so the early-producer buffer and
      the 4 s reconcile cannot double-consume. Confirm mediasoup-client coalesces concurrent
      recv.consume calls into one handler.receive (read node_modules/mediasoup-client/lib/
      Transport.js — the awaitQueue) and that the FIRST consume's '@connect' (sfu.transport.connect
      for recv) is awaited once (the transport's connect promise is shared). Resume: if Step 4 has
      shipped the batch/unpaused server change, use it; otherwise send the per-consumer resumes
      concurrently. Keep the per-producer retry (300/600 ms) and the "consume retry/gave-up" warns.
 3b.2 Overlap the key wait: on the joiner path, start device.load + transport creation (they need
      TURN, not the key) while waitForGroupCallKey is pending; gate ONLY enc.init + every cryptor
      attach + produce/consume on the key. Keep fail-closed (25 s → 'failed' + sfu.leave) and the
      S6 "refuse to start unencrypted" guard. The host path: start device.load concurrently with
      ensureCallGroupKey; the RING still waits for the key (groupCallRingOrder pin).
 3b.3 Pre-warm mediasoup Device: a module-level `getLoadedDevice(routerRtpCapabilities)` cache
      keyed by a hash of the router caps (caps are per-router; a fresh room on another worker may
      differ — load per distinct caps, cache by hash, cap 4 entries). Optionally pre-load at
      ring time using the last-seen caps (only a win if the hash matches; must not block join if
      it does not).
TESTS (RED first): hook harness — 5 existing producers: assert consume acks are in flight
concurrently (order of wsRequest starts vs resolves), audio starts before video, dedup holds when
the early buffer delivers one of the same producers mid-burst, a failing consume does not sink
the others; key-wait overlap — device.load called before the key resolves, no cryptor attach /
produce / consume before the key, 25 s timeout still fails closed; Device cache hit/miss by caps
hash. Mutation-prove.
EDGE-CASE AGENT focus (Fable): rejoin during the burst (attempt generation must make the losing
burst a no-op — read groupCallAttemptGen); restore from minimize mid-burst; a producer closed
server-side between consume and resume (producer_not_found race); the probator consumer on the
first video consume; a key that arrives AFTER device.load but with the FrameCryptor unavailable;
reused roomId with a stale Device cache.
CRITIC focus (Fable): prove the dedup covers the new concurrency (enumerate every consume
entry: boot burst, early buffer, new-producer event, 4 s reconcile, resume reconcile, rejoin);
refute "the key gate still covers every media path" by listing every produce/consume/attach
site; the identity rule on every registry write you touch; the self-diff on any state you moved
(e.g. the ring's still-ringing set if Step 3a voided the ring ack).
Device evidence owed: before/after invitee waterfall into a 3-peer room; the "join ack → last
resume ack" delta is the acceptance number.
```

### Step 4 — Group server: halve the round trips (Builder: Fable 5 · Edge: Opus 5 · Critic: Fable 5)

```text
[paste §6 preamble]

STEP 4 — make the SFU's join choreography need fewer round trips, compatibly with OLD clients.

Read audit §1.4 rows 3 and 9, the group-server trace facts in §2/§4, spec §19 (Phase 6 server
outcome: pendingJoins reservations, host handoff, the WS_PAYLOAD_SPECS completeness gate — every
new event needs a payload spec). Files: apps/messenger-service/src/sfu/sfu.service.ts (joinRoom
~L369-560, createWebRtcTransport ~L481-482 + ~L1131-1137, consume ~L800-840, resumeConsumer
~L871-890), sfu.types.ts, gateway/messenger.gateway.ts sfu.* handlers (~L2012-2256),
gateway/ws-payload.guard.ts, gateway/protocol.ts. Re-grep.

DO:
 4.1 Create the two WebRtcTransports with Promise.all inside joinRoom (keep the reservation/
     rollback semantics of B-557 — both must be closed on rollback).
 4.2 Audio consumers created UNPAUSED (no resume round trip needed — audio has no keyframe to
     lose); video consumers stay `paused: true` + resume + requestKeyFrame (mediasoup guidance).
     Return `paused` in the consume ack (already there) so old clients that still call resume are
     harmless (resume on an unpaused consumer is a no-op — verify in mediasoup).
 4.3 New batch request `sfu.consume.batch {producerIds[], rtpCapabilities}` → ack `{consumers:[…
     existing ServerSfuConsumed shape…], failed:[{producerId, code}]}`; partial success allowed;
     add the payload spec + rate-limit entry (burst-size aware) + guard test. Keep `sfu.consume`
     for old clients. Optionally `sfu.consumer.resume.batch {consumerIds[]}`.
 4.4 (Only if the Critic agrees it is safe) the join ack may carry `consumers` pre-created on the
     recv transport for existingProducers when the client sends its rtpCapabilities in the join —
     this removes one more round trip but couples join to consume; decide with the reviewers and
     record the decision in spec §21 either way.
 4.5 Keep the Step 0 duration logs + mediasoup transport state logs.
TESTS (messenger-service jest): join-cap spec still green (parallel creates under the cap +
rollback closes both); consume spec: audio unpaused / video paused; batch spec: mixed success,
unknown producer, cannot-consume, rate limit, payload guard rejection; old-client path unchanged
(spec that `sfu.consume` + `sfu.consumer.resume` still work and resume-on-unpaused is a no-op).
EDGE-CASE AGENT focus: batch of 10 on a 10-cap room; a producer closed mid-batch; replica
failover (in-memory maps); the payload guard's size caps; a client that sends consume.batch
before transport.connect (mediasoup allows consume before connect — confirm); keyframe request
storms on resume.batch.
CRITIC focus: backward compatibility matrix (old client + new server, new client + old server —
the client must feature-detect via the join ack, e.g. `capabilities: {consumeBatch: true}`, and
fall back); the WS_PAYLOAD_SPECS completeness gate; that audio-unpaused does not regress the
B-13 boot-burst React batching on the client (it changes when the first RTP arrives — not a
correctness issue, note it).
Deploy: staging deploy owed (founder authorization) — after deploy, the [SFU] duration lines
from Step 0 are the evidence.
```

### Step 5 — Notification / killed lanes (Builder: Fable 5 · Edge: Fable 5 · Critic: Fable 5)

```text
[paste §6 preamble]

STEP 5 — the long tail: answering from a notification when the app is backgrounded or killed.
PREREQUISITE: Step 0's measured doc — do not start without its lane-N numbers (ms from FCM wake
→ nav ready → runtime ready → ws open → SDP available → accept → connected). The founder's
12-52 s observations in audit §1.2/§3.2 mix user reaction with boot; only the markers separate
them.

Read audit §1.2, docs/audits/NOTIF_TAP_TO_MESSAGE_LATENCY_2026-08-01.md (B-352: what is already
done — un-awaited transport.connect, JWT pre-refresh, optimistic auth — and the OPEN "lean
runtime" P1), docs/handoffs/B-331_CALL_ACCEPT_FROM_NOTIFICATION_2026-07-29.md, spec §17 (Phase
4: the eleven lanes, explicitAcceptIds is a navigation input, the notifee/FCM one-slot handlers).
Files: src/modules/messenger/push/fcmBootstrap.ts, fcmHeadless.ts, callNotification.ts,
callKitBridge.ts, incomingCallCache.ts, src/navigation/MainNavigator.tsx, src/modules/messenger/
runtime/productionRuntime.ts (boot order), src/screens/messenger/CallScreen.tsx (incomingSdpKey
wait). Re-grep.

DO (each item gated on the Step 0 number that justifies it — write the number next to it):
 5.1 Pre-fetch TURN (Step 2.1 module) in the FCM voip-wake handler and the headless slim handler
     BEFORE presenting the ring, so `turn ok` precedes the tap on every lane.
 5.2 Call-lane-first boot: when the process is started by a call answer (Telecom/notifee
     action or getInitialNotification with a call payload), the runtime boot must reach
     transport.connect before the non-call hydration (message hydrate, blocked peers, tombstones,
     backup mirror, presence) — audit which awaited loads precede connect today (B-352 says
     connect is un-awaited, but what is awaited BEFORE the connect call is issued?) and move the
     call-irrelevant ones after it, respecting stashDrainGateParity's `await loadBlockedPeers(`
     literal (that suite pins the drain gate — do not reorder the DRAIN, only what precedes the
     socket open). The killed lane's SDP comes only from the pending-offer replay on socket open
     (B-331: the FCM payload has no SDP): the faster the socket, the faster the SDP.
 5.3 The killed-lane answer should navigate to CallScreen in 'Answering…' IMMEDIATELY (it does)
     and show progress text driven by the [CALLLAT] steps (e.g. "Connecting… / Securing…") so
     the wait is legible — UI only, no logic change; design-system tokens (DESIGN_REVIEW_LOOP.md).
 5.4 Decide, with numbers, whether the B-352 "lean runtime in the headless VM" is worth building
     for calls; if yes write the plan as a new spec section, do not build it in this step.
 5.5 NAV_READY_WAIT_MS polling at 100 ms is fine; do not touch the deadline relationships in
     callDeadlines.ts without re-running callDeadlines.test.ts and re-reading the comments.
 5.6 (the big one — decide with numbers) Pre-boot on voip-wake: today the headless voip-wake
     branch (fcmHeadless.ts voip branch, re-grep) only presents the card; msg-wake runs the
     bounded headless drain (configureRuntimeFromPersisted + getMessengerRuntime, restore/hasDbKey
     gates). If the measured killed lane is dominated by "tap → ws open → SDP", run the SAME
     bounded drain on voip-wake so the socket is up and the offer replay is CACHED
     (callDispatcher cacheUnhandledOffer, B-331) BEFORE the user taps. Known hazards you must
     re-read first: B-331 (a headless socket with no onIncoming handler — the cache branch must
     catch the replay), B-354 (a headless socket must carry the bg:'1' handshake hint and stay out
     of presence), B-352/B-353 (boot order, livePublishOwnBundle), and the identity/epoch rules in
     spec §18 (a runtime built headless that the UI then attaches to). A reaped process loses the
     in-memory cache — accept that; the UI boot path stays as the fallback.
 5.7 Route the initial notification earlier: move the getInitialNotification/Telecom-answer
     route discovery out from behind the messenger configure effect + runAfterInteractions
     (MainNavigator) so the CallScreen is navigated as soon as the navigator is ready; the
     runtime boot continues in parallel. Keep the B-479/B-481 park rules and explicitAcceptIds
     semantics (spec §17).
 5.8 B-602: exempt the group ring events from the depsReady buffer the way 1:1 call frames are
     (callFrameRouter.ts CALL_FRAME_EVENTS → a GROUP_RING_FRAME_EVENTS set or a shared predicate),
     keeping the Phase 5 epoch gate in front of it. Pin with a source scan + a dispatch test (ring
     frame delivered before depsReady flips).
TESTS: notifLatencyBootInvariants-style source scans for the boot ordering; a seam test that the
prewarm is invoked on the wake lanes before navigation; screen test for 5.3; for 5.6 extend
callOfferNoHandlerCache.test.ts (B-331) with the voip-wake pre-boot path; for 5.8 the dispatch test.
EDGE-CASE AGENT focus (Fable): Doze/App Standby; OEM process kill after the wake (MIUI); two
wakes for the same callId (collapse keys); the headless VM vs the UI VM racing the same TURN
prewarm (two processes — the cache is per VM); a token refresh at boot racing the prewarm (B-352
E2 TTL rule); the 45 s offer TTL vs a 20 s nav wait + boot.
CRITIC focus (Fable): refute every reordering with the B-125 lesson (no test imports
productionRuntime.ts — the boot-order scans are the only pins; are they anchored on the executing
lines?); the self-diff rule; that 5.3 does not change accept semantics (explicitAcceptIds,
tombstones).
Device evidence owed: killed-lane waterfall before/after on the Redmi (kill → ring → Answer).
```

### Step 6 — Pins, A/B matrix, spec §21, close-out (Builder: Opus 5 · Edge: Opus 5 · Critic: Fable 5)

```text
[paste §6 preamble]

STEP 6 — make it permanent and prove it on devices.
 6.1 Collect every RED-first test from Steps 1-5 into a row each in CLAUDE.md's bug-regression
     table (B-596..B-601 + any new numbers the steps claimed), same format as the existing rows.
 6.2 Source-scan pins for the ORDERING facts (messenger-crypto project, strip comments, \r?\n,
     anchor on executing lines): offer handler registers the session before its first await;
     useGroupCall consume loop is Promise.all; useGroupCall TURN await is the ceiling'd shared
     call; presence broadcast is not awaited; InCallManager.start is not gated on btPermResolved;
     CallScreen holds no raw TURN fetch; answerer PC is built at handleIncomingOffer when
     iceServers exist.
 6.3 Write docs/planning/CALL_RACE_HARDENING_SPEC.md §21 "Call join latency outcome table" in
     the style of §18-§20: per step what shipped, the RED mutations, the DO-NOT-RE-ADD entries
     (e.g. "do not re-await the presence broadcast", "do not move trackCallStart after an await",
     "do not pre-acquire the mic at ring without the founder's decision"), and the measured
     before/after per lane.
 6.4 Device sign-off: re-run the Step 0 matrix on the final build, INTERLEAVED old/new APKs
     (A/B rule), report medians side by side; the acceptance criteria are (a) 1:1 warm answer
     accept:begin → connected median < 1.5 s voice / < 2.5 s video on the Redmi, (b) no
     `[CALL] ICE ignored` for a healthy call, (c) invitee join ack → last audio consumer live
     < 1.5 s for 3 peers, (d) notification answer shows `turn ok` before the tap. If a criterion
     is not met, say which step's assumption failed — do not soften the criterion.
 6.5 sqa.md: flip B-596..B-601 to FIXED with commit hashes (or state what is still open and why);
     update the "next free number" line. Memory note for the next session.
EDGE/CRITIC: the scans must fail on the ORIGINAL code (check out the audit commit's version of
each file into a scratch dir and run the scan against it — the pin is decorative otherwise).
```

---

## 8. Answers to the likely follow-up questions

- **"Why didn't the call-race hardening (Phases 1-7) fix this?"** It was a correctness campaign (identity, state machine, arbitration, delivery lanes). It added guards and ceilings; it did not remove serialization. The only latency-relevant pieces it touched were deadlines (`callDeadlines.ts`) and the Phase 5 ICE buffer — both about not _losing_ a call, not about connecting faster.
- **"Is it the network / TURN server?"** coturn is healthy (B-273 session checked it); the evidence points at _when_ we start using the network, not at the network itself. B-596 does make calls fall back to relay more often than they should, which is a real quality cost on top of the delay.
- **"Can we just pre-acquire the mic while ringing like WhatsApp?"** Technically trivial (`ensureLocalMedia` at `handleIncomingOffer`), it would cut another ~0.2-0.6 s, but it lights the mic/privacy LED before Accept — a product/privacy decision deliberately NOT taken today (`useCall.ts:551-556`). It is listed in Step 2 as a founder decision, not a default.
- **"Is the staging server running the latest call code?"** No — the container predates the uncommitted Phase 6/7 tree (no `[SFU] join` lines in 30 days). Steps 1 and 4 need a staging deploy to be verifiable server-side; the founder authorizes deploys.

## 9. sqa.md numbers claimed by this audit

B-596 (server ICE-before-session drop, live), B-597 (ring fan-out gated on block-check), B-598 (group TURN fetch unbounded/uncached), B-599 (group join serialization), B-600 (group audio session gated on BT prompt), B-601 (1:1 answerer pre-warm/TURN cache), B-602 (group ring frames buffered behind depsReady on cold boot). Next free: **B-603**. Per the bug-regression contract, each fixing step lands its RED-first pin; B-596 gets a `DOCUMENTS` spec in this session if time allows (see the sqa.md entry for status).
