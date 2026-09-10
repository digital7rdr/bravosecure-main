# Background / Killed-App Reliability Audit — Messages + Calls (WhatsApp parity)

**Date:** 2026-07-10 · **HEAD:** `78edfd4` (branch `main`) · **Auditor:** Claude (6 background-surface deep-trace finders → 3-lens adversarial verifiers for every P0/P1) · **Workflow:** `wf_0b001a78-f0e` (64 agents, ~4.6M tokens, 0 errors)

**Why this audit exists:** the tester reports the app "still isn't smooth like WhatsApp when Android kills the app" — calls and messages don't behave in the background/killed state, and five live-device call bugs (B‑57…B‑61) were logged but not yet root-caused. This pass statically traces **every background/killed-app path end-to-end** — server push decision → FCM wake → headless JS → notification → tap/answer → app resume — for both messaging and calling, root-causes B‑57…B‑61 in code, and rates Bravo against a **49-item WhatsApp-parity checklist**.

**Method:** static deep-trace of real code at HEAD (every finding carries a `file:line` anchor + verbatim excerpt + a concrete failure scenario + a fix). Every P1 ran through three independent adversarial verifiers (refute / reproduce-feasibility / severity-calibrate); kept only on ≥2/3 confirm. No devices were attached — B‑57…B‑61 root causes are code-level; the two medium-confidence ones (B‑60/B‑61) name the exact 2-device ADB check that confirms them. This audit is the companion to [`MESSENGER_AUDIT_2026-07-09.md`](MESSENGER_AUDIT_2026-07-09.md); its **crypto-core / backup / prod-readiness / cross-area** coverage-gap results close that report's §11 and live there, not here.

---

## 1. Executive summary — why it isn't smooth like WhatsApp yet

Bravo's killed-app **plumbing is genuinely good**: data-only high-priority FCM, a bundle-entry headless handler, HMAC-verified VoIP wakes, conversation-keyed de-duplicated banners, typed foreground services for calls, a self-managed Telecom `ConnectionService`, durable Redis-backed envelopes, and correct notification channels created at boot. On the happy path a killed device rings and banners fast. **What breaks is everything _after_ the wake, plus the OEM layer that decides whether the wake arrives at all.** Five clusters explain the "not smooth" feel:

1. **The OEM kill layer is unaddressed (the biggest one).** There is **no battery-optimization exemption prompt, no OEM-autostart deep-link, no `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` permission** anywhere in the app. WhatsApp survives kills because OEMs ship it pre-whitelisted and it prompts users to whitelist it; Bravo is neither. On HiOS (the **TECNO KM5** QA device), MIUI, ColorOS, etc., a swiped-away or overnight-"cleaned" Bravo is force-stopped and Android delivers **zero FCM** — total silent blackout for both messages and calls until the user manually reopens the app. **This is the most likely single cause of the tester's complaint.**

2. **Calls die on the notification/resume path (B‑58) and never show "Connected" (B‑60/B‑61).** Tapping the ongoing-call notification (or just returning to a backgrounded call) makes the client tear down its _healthy_ socket, and the server then hangs up the peer with zero grace — the call drops deterministically after any background stint >8 s. Separately, a hung native `getStats()` inside the DTLS-verify poll can wedge the call at "connecting" forever while audio flows, so the timer never starts and the status never flips.

3. **You can't actually answer/decline a killed-app call from the notification.** Answer launches the full app and dumps you on a second in-app "Accept" button 10–25 s later; Decline launches the app too and **never sends the hangup**, so the caller rings out the full 45 s; group rings can't be answered at all (roomId/roomToken never reach the notification). This is WhatsApp's single most important call behavior and it's missing.

4. **Messages silently vanish in ordinary offline windows.** A device offline >24 h gets **no** message notifications on reconnect (the FCM wake TTL is 24 h but the relay dwells 30 days); a contact whose **1:1 DM is muted** has their **group** messages fully silenced on the killed path; and one transient token-refresh failure on foreground puts the whole transport into a terminal `unauthorized` state — no messages, no call rings — until the app is force-cycled.

5. **Presence and receipts lie after ungraceful death.** A pod that dies without cleanup pins a user "online" for up to 6 h (or forever for daily-active users); read receipts sent to a ≤55 s zombie socket are lost permanently.

**Totals: 33 confirmed background-reliability findings — 8 P1, 11 P2, 14 P3 — plus a 49-row parity checklist and root causes for all five tester bugs.** No E2EE, sealed-sender, or key-material violation was found on any background path (the headless handler never decrypts, by design; wakes are HMAC-verified; release builds strip `console.log`).

> The **two coverage-gap P1s** found the same session — the **fail-silent, unresumable backup archive replay** and the **hardcoded `TOTP_ENCRYPTION_KEY` fallback** — are filed in [`MESSENGER_AUDIT_2026-07-09.md` §12](MESSENGER_AUDIT_2026-07-09.md) because they belong to the backup / prod-readiness coverage gaps, not the background surface.

---

## 2. 🧪 Tester field bugs B‑57…B‑61 — root-caused in code

All five are now traced end-to-end. B‑59/B‑60/B‑61 are **one underlying bug**; B‑57 and B‑58 are two distinct notification/resume defects.

### B‑57 · Incoming-call notification tap opens the app first, not the call screen · **HIGH · ROOT-CAUSED (high confidence)**

There is **no lightweight call UI on the killed path — the ring's answer surface is the entire React-Native app.** `fcmHeadless` posts a notifee ring whose `fullScreenAction`/`pressAction`/action buttons all use `launchActivity:'default'` (`callNotification.ts:371-388`), so on a locked/killed device any interaction cold-launches `MainActivity` — the user sees the app boot screen, not a call. The headless path never calls `callKitBridge.reportIncomingCall` (only the warm handler at `fcmBootstrap.ts:1154` does), so no Telecom system-UI covers the boot. The press is processed only _after_ login: `getInitialNotification` → `handle()` waits ≤8 s for the navigator, then navigates `CallScreen` in `ringing` state with no SDP; the Accept/Decline buttons the tester sees "appear only after launch" are `CallScreen.tsx:2166`, and tapping the notification's **Answer never auto-accepts** — a second in-app Accept is required.
**Anchor:** `callNotification.ts:371` (FSI `launchActivity:'default'`) + `fcmBootstrap.ts:837` (accept tap only navigates).
**Fix:** report the incoming call to the self-managed Telecom `ConnectionService` **from the headless handler** so the lock screen shows the system call UI in <1 s; add an `autoAccept` route param so notification-Answer answers once the replayed offer lands; point the FSI at a dedicated lightweight call Activity that renders from notification data while RN hydrates. (See P1‑BR‑2, P1‑BR‑3.)

### B‑58 · Tapping the ongoing-call notification disconnects the call · **HIGH · ROOT-CAUSED (high confidence)**

The disconnect happens on **resume, not on the tap itself.** The runtime's 4 s heartbeat (`productionRuntime.ts:1337`) is frozen while backgrounded, so `lastPongAt` is always >8 s stale even though the call foreground service kept the socket alive. The AppState-`active` handler (`productionRuntime.ts:1294-1302`) therefore calls `transport.forceReconnect()`, which `socket.disconnect()`s the **healthy live socket** (`transport/client.ts:215`); the gateway's `handleDisconnect` finds the still-`active` call session and emits `call.hangup{reason:'failed'}` to the peer, tombstoning it (`messenger.gateway.ts:716-737`). The peer's call ends instantly; the tapper's side dies shortly after (the tombstone drops its recovery frames; the Doze-frozen 30 s reconnect budget flushes on resume and `end('failed')`s). `CallScreen` does **not** remount on the tap (`MainActivity` is `singleTask`; `useCall` has a registry-adopt guard), so remount-teardown is _not_ the mechanism. Deterministic for any background stint >8 s.
**Anchor:** `productionRuntime.ts:1302` (client trigger) + `messenger.gateway.ts:730` (server kill).
**Fix (both sides):** client — in the AppState-`active` handler, **skip `forceReconnect` while a live call exists in `callRegistry`/`groupCallRegistry`**; probe with one ping and rebuild only if no pong in ~3 s. Server — add a **10–15 s grace timer** before the 1:1 disconnect-bye (mirroring the SFU path's existing `SFU_LEAVE_GRACE_MS` at `gateway:697`), cancelled when the same user/device reconnects. Either fix alone stops B‑58; both make calls survive genuine brief WS loss. (P1‑BR‑4, P1‑BR‑5.)

### B‑60 · Call timer never starts after connect (audio works) · **HIGH · ROOT-CAUSED (medium confidence — 2-device confirm named)**

### B‑61 · Call status never flips to Connected/In-Progress · **HIGH · same root as B‑60**

The timer gate (`CallScreen.tsx:1510 if (callState !== 'connected') return`) and the status derivation (`:736-739`, maps every non-terminal state to "connecting") are **correct**; the whole JS promotion chain (native ICE event → `callController` → `useCall.onState` → `connectedAtMs` → CallScreen) was read link-by-link and verified sound. The wedge is the **one un-timeboxed native await**: `onIceConnected()` sets `dtlsPolling=true` then awaits `verifyDtlsSrtp()`, whose first line is `await this.pc.getStats()` (`peerConnection.ts:453`) with **no timeout**. If that native promise never settles (the patched `io.getstream` `stream-webrtc-android 1.3.10` `getStats` bridge is the one link not statically verifiable), the poll hangs mid-iteration forever — the 24×250 ms budget only advances on _rejected_ iterations, so `setState('connected')` (`:906`) is never reached and `end('failed')` (`:926`) never fires (media keeps flowing). Every later ICE `connected`/`completed` event hits `if (this.dtlsPolling) return` (`:861`) and is discarded, so promotion can never retry. Result: controller stuck at "connecting", status stuck on "Calling…/Answering…", timer never arms — **exactly B‑60 + B‑61 with working audio.** The inverse (verify consistently _rejecting_) is refuted as the root because it hard-ends the call at ~6 s, cutting audio, which contradicts minutes of working audio.
**Anchor:** `callController.ts:880` (latch `:861`, budget-only-on-reject `:908-923`, promotion `:906`).
**Fix:** `Promise.race` each `verifyDtlsSrtp()` against a 1 s timeout (a timeout counts as a failed iteration); **and** promote to `connected` directly from the ICE `connected`/`completed` event, running DTLS-SRTP verification as a follow-up gate that `end('failed')`s on genuine failure — verification stays unconditional (security contract intact) but a stats-layer stall can no longer withhold a state the media path already proved. Add a `[WEBRTC] dtls-poll-hung` watchdog log so the **2-device ADB trace** can confirm on the tester's build: grep logcat for `dtls-poll-begin` with no matching `dtls-verify-ok`/`dtls-poll-exhausted`, or for the absence of `iceConnectionState=connected` (which would instead indict the native fork's event delivery). (P1‑BR‑6.)

### B‑59 · Call duration shows "1M, 2M, 3M" not MM:SS · **MEDIUM · EXPLAINED as a perception artifact of B‑60/B‑61**

Exhaustive grep proves **no call surface formats a duration as "NM"**: `CallScreen.formatDuration:1688`, `FloatingCallOverlay:292`, `GroupCallScreen:2410`, `ChatScreen:2467`, `CallsLogScreen.fmtDuration:46` all emit `MM:SS`/`M:SS`. But because B‑60/B‑61 keep `callDuration=0` and `connectedAtMs=null`, `CallScreen`'s unmount classifier (`:1255-1267`) records every call as **missed/declined with duration 0**, so both call-log surfaces _suppress_ the MM:SS slot (`CallsLogScreen` missed-branch `:233-236`; `ChatScreen` `meta.duration > 0 &&` gate `:2530`). The only numbers left on the Calls rows are the right-column **relative ages** `${Math.floor(diff/60_000)}m ago` (`CallsLogScreen.tsx:56`) — three test calls made 1/2/3 min earlier literally read "1m ago / 2m ago / 3m ago" and tick up each minute, which the tester transcribed as "1M, 2M, 3M". **Fixing B‑60/B‑61 dissolves B‑59.** Defence-in-depth: render `—`/`0:00` in the duration slot for answered rows so it can't be confused with the age column. (Ask the tester to confirm the sighting was the Calls-screen right-hand column to close the loop.)

---

## 3. 🟠 P1 register — background reliability (8)

### Calls

**P1‑BR‑1 · Killed/backgrounded group-call ring is non-actionable — roomId/roomToken never reach the notification, Answer creates a wrong room and `sfu.join` is rejected** — `fcmHeadless.ts:128`
`handleSfuRing` emits `sfu.ring.incoming` only to live sockets (no offline queue) and the VoIP wake carries `{callId=roomId, roomToken, fromUserId, callKind}`, but `fcmHeadless` passes `roomId=data.roomId` (undefined) and **drops `roomToken`**. Answer cold-launches → `IncomingGroupCallScreen` with empty roomId/roomToken → `useGroupCall` treats `rid=''` as falsy and POSTs `/sfu/rooms` creating a **new empty room** instead of joining the host's; even with a correct roomId the tokenless `sfu.join` is hard-rejected `room_token_required` in production. The warm shade-answer path loses the token the same way. **Group calls cannot be answered from any notification.** _Fix:_ mirror the warm handler (`isGroupKind ? roomId = data.callId`), thread `roomToken` (+`conversationId`) through `IncomingCallNotifPayload` → accept navigation → `GroupCallScreen` route params; have the server include `conversationId` in the group wake and queue a short-TTL pending `sfu.ring` per offline device (analogous to `pendingOfferKey`).

**P1‑BR‑2 · Notification "Answer" never answers — it only launches the app to a ring screen where the user must Accept again (B‑57 core)** — `fcmBootstrap.ts:837`
Answer → `pressAction launchActivity:'default'` cold-launches MainActivity → after login `getInitialNotification` navigates `CallScreen(isIncoming, incomingSdp:undefined)`; the screen sits in `ringing` until the WS reconnect replays the queued `call.offer` (45 s TTL) and renders its **own** Accept/Decline. The caller hears ringing the whole 10–25 s cold boot; if nav isn't ready within 8 s the route is abandoned but `markAccepted(callId)` stays latched 5 min so a follow-up Telecom answer is dropped. _Fix:_ `autoAccept` param when the pressAction id starts with `accept-`; `CallScreen`/`useCall` auto-accept once the offer SDP arrives while showing "Connecting…"; raise/retry the nav-ready wait; clear `acceptedCallIds` on abandon; long-term report to Telecom from the headless path.

**P1‑BR‑3 · Decline from a killed-app ring launches the full app AND never sends `call.hangup` — caller rings out the full 45 s** — `fcmBootstrap.ts:754`
`launchActivity:'default'` on the decline pressAction cold-launches the app the user just rejected; the decline branch then consults only the in-memory `incomingCallCache` (empty in a fresh process — the headless path never calls `setIncomingCallPayload`) and ignores `data.fromUserId` that _is_ present, so it logs "no payload, dismiss only" and never sends the hangup; even using `data.fromUserId`, `getLiveTransport()` is null this early in cold boot. Group decline is equally dead. _Fix:_ remove `launchActivity` from the decline action (notifee handles `ACTION_PRESS` without launching); handle decline in the slim bundle-entry handler by reading `fromUserId`/`roomToken` from notification data and sending the decline via a lightweight authenticated `POST /calls/:id/decline` (server fans out `call.hangup`/`sfu.ring.declined`) — no runtime/WS boot required; fall back to a pending-decline flushed on first connect.

**P1‑BR‑4 · Resume-after-background `forceReconnect()` tears down a healthy socket → server disconnect-bye kills the live call (B‑58 client half)** — `productionRuntime.ts:1302` — _see B‑58 above._

**P1‑BR‑5 · Server ends ACTIVE 1:1 calls on any WS drop with zero grace (B‑58 server half)** — `messenger.gateway.ts:730`
Mid-call, one side's WS drops briefly (Doze cuts the fd, Wi-Fi↔cellular handover, reconnect churn) while DTLS-SRTP media is fine; `handleDisconnect` immediately tombstones and emits `call.hangup{failed}` to the peer, and the tombstone then makes `authorizeCallFrame` drop the survivor's legitimate reoffer/ICE-restart/hangup frames. The SFU group path holds a `SFU_LEAVE_GRACE_MS` grace for exactly this; the 1:1 path has none. _Fix:_ schedule the 1:1 bye ~10–15 s out keyed by `(callId,userId,deviceId)`, cancelled on same-device reconnect; keep the immediate bye only for `ringing` sessions.

**P1‑BR‑6 · DTLS-verify poll has no per-iteration timeout and its latch swallows later ICE events — a hung `getStats()` wedges the call at "connecting" forever (B‑60/B‑61 root)** — `callController.ts:880` — _see B‑60/B‑61 above._

### Transport / messaging

**P1‑BR‑7 · One transient refresh failure at foreground permanently kills the transport (`unauthorized`, no retry) — receive + ring dead until the app is force-cycled** — `packages/messenger-core/src/transport/client.ts:437`
App backgrounded >15 min → access JWT expires → foreground → `forceReconnect` → handshake rejects `jwt expired` → `handleAuthReject` → `refreshToken()` (axios `POST /auth/refresh`). If that **one** POST fails transiently (radio not yet re-attached after Doze, auth-service mid-redeploy — staging auto-deploys on every push to main, nginx 502, DNS blip) the catch sets `closedByUser=true` + state `unauthorized`, which is **terminal**: `scheduleServerReconnect` no-ops, `notifyNetworkChange` returns (state≠`connected`), the heartbeat bails, `onStateChange` has no `unauthorized` recovery branch. The user sits in a foregrounded app with no `envelope.deliver`, no presence, and no `call.offer` (and the foreground `onMessage` ignores VoIP wakes per N‑01), until the _next_ AppState-`active` transition. _Fix:_ classify refresh failures — 401/refresh-revoked → terminal `signOut`; network/5xx/timeout → stay `reconnecting` and retry via the B‑14 backoff; let network-restore call `forceReconnect` for non-`connected` states.

### Platform

**P1‑BR‑8 · Lock-screen full-screen incoming-call UI is dead code — notifee's FSI launches MainActivity without `EXTRA_CALL_LAUNCH`, so `showWhenLocked`/`turnScreenOn` never apply on the ring path** — `android/app/src/main/java/com/bravosecure/app/MainActivity.kt:52`
`callNotification.ts:371` fires `fullScreenAction{launchActivity:'default'}`; notifee builds the PendingIntent to MainActivity **without** the `com.bravosecure.app.EXTRA_CALL_LAUNCH` extra (the only setter is the _ongoing_-call FGS tap), so `applyCallLaunchFlagsIfNeeded` returns early, the activity has no manifest `showWhenLocked`/`turnScreenOn`, and the keyguard occludes it. The comment calling this "the load-bearing piece for phone rings on lock screen" is false for the ring path: a locked device rings and vibrates but shows **no answer UI over the keyguard** — the user must wake+unlock within 45 s. _Fix:_ detect notifee's launch in `applyCallLaunchFlagsIfNeeded` (its `notification` extras' `data.kind` = call) and apply the flags, or add `android:showWhenLocked`/`turnScreenOn` to a dedicated lightweight incoming-call Activity (keeps the secure-app keyguard posture for the rest of the app).

---

## 4. 🟡 P2 register — background reliability (11)

| ID       | Area     | Finding                                                                                                                                                                                                                                                                                                                                             | Anchor                            |
| -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| P2‑BR‑1  | platform | **No battery-optimization exemption / OEM-autostart flow anywhere** — killed-app msgs + calls black out on aggressive OEMs (TECNO KM5/HiOS, MIUI, ColorOS). No `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, no `PowerManager.isIgnoringBatteryOptimizations` check, no OEM deep-link, no prompt. **The most likely single cause of "dies when killed."** | `AndroidManifest.xml:40`          |
| P2‑BR‑2  | platform | `RNCallKeepBackgroundMessagingService` is `exported=true` with its headless task never registered — any co-installed app can `startService(...)` it and NPE/crash Bravo (killing an active call/WS) or boot forced JS-VM contexts                                                                                                                   | `AndroidManifest.xml:133`         |
| P2‑BR‑3  | msg      | Every **non-displayable envelope** (reaction, group-control/rekey, deduped retry, pre-expired send) fires a full "New secure message" HIGH-importance wake — killed devices get phantom sound banners that open to nothing                                                                                                                          | `relay/envelope.controller.ts:94` |
| P2‑BR‑4  | msg      | Chat-wake FCM **ttl is 24 h but relay dwell is 30 days** — a device offline >24 h gets **zero** message notifications on reconnect (no durable server chat inbox to backfill)                                                                                                                                                                       | `push.service.ts:654`             |
| P2‑BR‑5  | msg      | Killed path **silences a contact's GROUP messages when their 1:1 DM is muted** — sealed-sender conv ambiguity feeds the resolved DM id into the mute gate; N‑11/N‑14 only covers the no-DM case                                                                                                                                                     | `fcmHeadless.ts:162`              |
| P2‑BR‑6  | call     | ICE-restart retry + 30 s reconnect budget are **RN timers frozen in background** — a backgrounded caller never recovers from ICE `disconnected`, and the expired budget flushes at the moment of resume, `end('failed')`-ing exactly when the user taps back in (secondary B‑58 contributor)                                                        | `callController.ts:1055`          |
| P2‑BR‑7  | call     | 1:1 **voice→video upgrade never re-foregrounds the FGS with the camera type** — Android 14 revokes camera capture when the app backgrounds mid-upgraded-call (GroupCallScreen has this; CallScreen doesn't)                                                                                                                                         | `CallScreen.tsx:990`              |
| P2‑BR‑8  | call     | Gateway reads `data.callType` but 1:1 `call.offer` carries `kind` — **every 1:1 VoIP wake is labeled "voice"**, so video calls to killed devices ring as voice and Answer mounts CallScreen in voice mode                                                                                                                                           | `messenger.gateway.ts:1099`       |
| P2‑BR‑9  | call     | **Group calls missed while offline leave no trace on reconnect** — no missed-marker analogue to the 1:1 `pendingOffer`/`missedCallMarker` queue                                                                                                                                                                                                     | `messenger.gateway.ts:1669`       |
| P2‑BR‑10 | socket   | **Presence liveness counter leaks +1 on every ungraceful messenger-service death** — daily-active users get pinned "online" up to 6 h / indefinitely; `sweepStale` can never reap them; last-seen freezes (for a security-escort product, ops can believe an agent is reachable when they aren't)                                                   | `presence.service.ts:121`         |
| P2‑BR‑11 | socket   | Read receipts to a **zombie socket** are lost forever — `deviceIsOnline()` counts a dead-TCP socket as online (≤55 s window), skipping the F7 durable queue; the B‑53 zombie class applied to receipts                                                                                                                                              | `messenger.gateway.ts:1948`       |

_(Two further socket P2s — no fast-path reconnect on network-restore (`client.ts:393`, waits out socket.io's up-to-30 s backoff) and destructive receipt-queue drain without delivery confirmation (`envelope.service.ts:394`) — are folded into the socket cluster; anchors retained for remediation.)_

---

## 5. ⚪ P3 register — background reliability (14, selected)

- **Abandoned cold-boot accept latches `acceptedCallIds` for 5 min**, silently dropping any later answer for that callId — `fcmBootstrap.ts:818`.
- **Duplicate dead native module** `CallForegroundModule.kt`/`CallForegroundPackage.kt` (same JS name as the live `Bravo*` pair) — a future prebuild registering both hard-crashes RN at boot — `CallForegroundModule.kt:22` (recommend `git rm -f`).
- **`FloatingCallOverlay` restore** uses root-level `navigate('CallScreen')` and hides the overlay before confirming nav — a failed cross-tab restore strands a live call with no UI — `FloatingCallOverlay.tsx:146`.
- **Sender-keyed killed-app group banner** (`bravo-msg-sender:<uid>`) is never cleared when the group thread is read — `callNotification.ts:234`.
- **Deliberately-suppressed high-priority wakes** (muted chats) erode Android's high-priority FCM quota, risking Doze-delayed rings/banners — `push.service.ts:644`.
- **callkeep FGS resurrects the deleted legacy `bravo-incoming-call` channel**, undoing the v2 channel migration (two "Incoming calls" entries in system settings) — `callKitBridge.ts:225`.
- **`CallForegroundService` uses the full-color launcher icon as the notification small icon** → white blob in the status bar for the whole call (fix already applied to FCM pushes via `ic_stat_bravo`) — `CallForegroundService.kt:119`.
- **`sos-alerts` channel has no `bypassDnd`/distinct sound** despite the comment claiming it does — an SOS panic alert is DND-suppressed like a booking notif (safety-relevant) — `serverWakeNotifications.ts:222`.
- **`connectionStateRecovery` is dead by default** (`WS_SESSION_RECOVERY` unset → stock no-op `restoreSession`) while the client ships a full pid/offset persistence machine that can never fire; the "recovery replays missed frames" comments are false — `redis-io.adapter.ts:71` / `client.ts:472` (decide the feature's fate).
- **4 s WS heartbeat keeps firing while backgrounded** — keeps the cell radio hot; WhatsApp's keepalive is minutes-scale — `productionRuntime.ts:1337`.
- **Merged manifest carries notifee's unused `SCHEDULE_EXACT_ALARM`** — Play-policy declaration risk on targetSdk 33+ (add `tools:node="remove"`) — `AndroidManifest.xml:1`.
- Lock-screen `showWhenLocked`/`turnScreenOn` flags set for the ongoing-call tap are **never cleared after the call** (privacy) — `MainActivity.kt:54`.

---

## 6. WhatsApp-parity checklist (49 items)

Legend: **✅ present** · **🟡 partial** · **❌ missing**. Full per-item gap text is in the workflow journal; this is the scorecard.

### Messaging (killed / backgrounded)

| #   | Behavior                                           | Bravo | Gap headline                                                                                                                                |
| --- | -------------------------------------------------- | :---: | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Killed-app delivery <2 s                           |  🟡   | Banner fast when it fires, but 6 s debounce swallows bursts, >24 h offline drops all wakes, no preview (headless never decrypts, by design) |
| 2   | Sender name + message preview                      |  🟡   | DM name yes; **no preview** on killed path (architecture); group shows generic "New secure message"                                         |
| 3   | Reply from notification works cold/killed          |  ❌   | Reply/Mark-read only on warm banners; a reply pressed after process death is silently dropped (known P1)                                    |
| 4   | No duplicate alerts                                |  🟡   | De-duped for DMs; residual group-from-DM dup (known) + sender-retry re-alert (P2‑BR‑3)                                                      |
| 5   | Messages pre-loaded when opening from notification |  🟡   | Killed path never pre-pulls; user watches messages arrive after open (runtime-build latency)                                                |
| 6   | Notification cleared on read; badge accurate       |  🟡   | Conv-keyed banners cleared; sender-keyed group banners never cleared (P3); badge only from warm notifier                                    |

### Incoming calls (killed / locked)

| #   | Behavior                                        | Bravo | Gap headline                                                                                                                         |
| --- | ----------------------------------------------- | :---: | ------------------------------------------------------------------------------------------------------------------------------------ |
| 7   | Rings <2 s when killed                          |  🟡   | Headless notifee ring works but evaluates the whole JS bundle first; FCM ttl 30 s vs 45 s offer TTL mismatch                         |
| 8   | Full-screen call UI on lock screen              |  🟡   | FSI launches the whole RN app; ring card hidden behind boot screen (B‑57, P1‑BR‑8); no Android-14 `canUseFullScreenIntent()` check   |
| 9   | Answer connects without opening main app UI     |  ❌   | Answer launches app, waits ≤8 s for nav, lands on a second Accept; Telecom `reportIncomingCall` never fired on killed path (P1‑BR‑2) |
| 10  | Decline works headless (caller stops instantly) |  ❌   | Decline launches app and never sends hangup; caller rings out 45 s (P1‑BR‑3)                                                         |
| 11  | Ring stops instantly on remote cancel           |  🟡   | 1:1 has N‑02 cancel push (both paths); group rings have **no** cancel push (known P2)                                                |
| 12  | Telecom/ConnectionService for incoming          |  🟡   | Wired + fires on the **warm** path only; killed/headless is notifee-only                                                             |
| 13  | Video vs voice labeled + answered in right mode |  ❌   | Gateway reads nonexistent `data.callType` → every 1:1 wake "voice" (P2‑BR‑8)                                                         |
| 14  | Group call answerable from killed ring          |  ❌   | roomId/roomToken never reach notification; Answer creates wrong empty room (P1‑BR‑1)                                                 |

### Ongoing calls (backgrounded / process-death)

| #   | Behavior                                          | Bravo | Gap headline                                                                                        |
| --- | ------------------------------------------------- | :---: | --------------------------------------------------------------------------------------------------- |
| 15  | Tap ongoing-call notification returns to the call |  ❌   | Resume `forceReconnect` triggers the server disconnect-bye → call ends (B‑58)                       |
| 16  | Call survives backgrounding indefinitely          |  🟡   | Typed FGS keeps capture/process alive, but the WS plane kills the call (B‑58)                       |
| 17  | Mic keeps working in background (Android 14)      |  ✅   | Typed mic FGS correct; **camera after voice→video upgrade is the exception** (P2‑BR‑7)              |
| 18  | Call survives brief network loss / WS blip        |  ❌   | Server ends the call first with zero grace (P1‑BR‑5); offerer restart timers frozen in bg (P2‑BR‑6) |
| 19  | Peer notified promptly on other device's death    |  ✅   | disconnect-bye handles this well; no stale ongoing notif (START_NOT_STICKY)                         |
| 20  | Ongoing-call notification present/silent/tappable |  ✅   | Silent LOW FGS notif with return tap (lock-screen flags not cleared after — P3)                     |
| 21  | Minimize→overlay→restore                          |  🟡   | Works mainline; restore `navigate` can be unhandled cross-tab after overlay hid (P3)                |

### Socket / presence

| #   | Behavior                                         | Bravo | Gap headline                                                                                                    |
| --- | ------------------------------------------------ | :---: | --------------------------------------------------------------------------------------------------------------- |
| 22  | Presence flips offline within seconds of death   |  🟡   | Swipe-kill prompt (FIN); no-FIN/Doze ≤55 s; **ungraceful pod death pins online ≤6 h/forever** (P2‑BR‑10)        |
| 23  | Messages fall back to push when socket half-dead |  ✅   | Push unconditional on both submit paths; B‑53 zombie class closed for messages                                  |
| 24  | Reconnect + drain <1–3 s on foreground           |  🟡   | Happy path good; transient refresh → terminal `unauthorized` (P1‑BR‑7); network-restore waits out ≤30 s backoff |
| 25  | Calls ring when killed/Dozed                     |  ✅   | N‑01 always queues offer + wake; residual = known decline/hangup Redis bugs                                     |
| 26  | Delivered/read receipts durable across offline   |  🟡   | Delivered always queued; **read receipts lost to zombie socket** (P2‑BR‑11); destructive drain race             |
| 27  | Ephemeral frames survive brief blips             |  ❌   | `connectionStateRecovery` off by default; client pid/offset machinery dead code (P3)                            |
| 28  | Battery-friendly background keepalive            |  🟡   | 4 s ping even backgrounded (P3)                                                                                 |

### Android platform (29–49)

✅ POST_NOTIFICATIONS + runtime prompt · ✅ WAKE_LOCK/VIBRATE · ✅ FCM (google-services + service + killed handler + HMAC-verified VoIP wake) · ✅ token refresh + re-registration · ✅ Telecom ConnectionService declared · ✅ MainActivity `singleTask` · ✅ `allowBackup=false`/no cleartext · ✅ ongoing-call FGS survival · ✅ typed FGS variants (mic/camera/phoneCall) · ✅ channels created at boot with correct importance (two channel P3s).
🟡 USE_FULL_SCREEN_INTENT declared but ring UI stays behind keyguard (P1‑BR‑8) · 🟡 RECEIVE_BOOT_COMPLETED present but no Bravo boot receiver re-arms anything · 🟡 proguard/R8 keeps thin (minify currently OFF) · 🟡 `SCHEDULE_EXACT_ALARM` merged-but-unused (Play risk).
❌ **Battery-optimization exemption / OEM-autostart prompt** (P2‑BR‑1) — the parity gap that most directly explains "dies when killed."

---

## 7. Release-gate ordering (recommended)

1. **Calls — the tester's live pain:** B‑58 (P1‑BR‑4 client + P1‑BR‑5 server) and B‑60/B‑61 (P1‑BR‑6). These make 1:1 calls survive background/resume and actually show "Connected". Ship the `dtls-poll-hung` watchdog log in the same build so the 2-device trace confirms B‑60/B‑61 on the tester's APK.
2. **Killed-app answerability:** P1‑BR‑2 (auto-accept), P1‑BR‑3 (headless decline), P1‑BR‑1 (group ring), plus P1‑BR‑8 (lock-screen FSI). Target: answer/decline a killed-app call from the notification without opening the app.
3. **The OEM layer:** P2‑BR‑1 — add `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` + a Signal-style "having trouble with notifications?" onboarding card that prompts Doze exemption and deep-links OEM autostart on `Build.MANUFACTURER ∈ {tecno,infinix,xiaomi,oppo,vivo,huawei}`. Without this, every other call/message fix is undone on the QA hardware.
4. **Message-loss edges:** P1‑BR‑7 (terminal `unauthorized`), P2‑BR‑4 (24 h TTL → 28 days), P2‑BR‑5 (muted-DM group silence), P2‑BR‑3 (phantom wakes).
5. **Presence/receipt truth:** P2‑BR‑10, P2‑BR‑11.
6. **Harden the platform P2/P3s** (exported service, channel collisions, dead native twin, small icon).
7. **On-device smoke (blocked on a device):** the real "is it smooth" test — killed-app 2-device call + message on a physical TECNO/Xiaomi handset with logcat.

---

_Companion to [`MESSENGER_AUDIT_2026-07-09.md`](MESSENGER_AUDIT_2026-07-09.md) (35 findings + the §12 coverage-gap increment) and [`NOTIFICATION_AUDIT_2026-07-09.md`](NOTIFICATION_AUDIT_2026-07-09.md). Tester bugs tracked as B‑57…B‑61 in `sqa.md`. All anchors verified against HEAD `78edfd4`. P1s adversarially verified (3 lenses, ≥2/3 confirm); B‑60/B‑61 medium-confidence pending the named 2-device ADB trace._
