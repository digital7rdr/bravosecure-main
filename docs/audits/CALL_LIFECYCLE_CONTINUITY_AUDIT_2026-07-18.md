# B-101 — Call continuity across minimize / lock / unlock / app-switch — combined audit (incl. B-100)

**Date:** 2026-07-18 · **Status:** ROOT-CAUSED, fixes NOT applied (audit-only)
**Requirement (WhatsApp parity):** during a live 1:1 or group call the user can minimize the app, lock the screen, unlock, and use other apps — the call keeps running smoothly. Audio never stops; camera pausing while backgrounded is acceptable parity if it resumes on return.
**Method:** 4-lane multi-agent audit (Android native · JS lifecycle · transport-under-background · prior art), every code finding adversarially re-verified by an independent agent reading the cited code. Companion register: [`CALL_DEATH_AUDIT_2026-07-18.md`](CALL_DEATH_AUDIT_2026-07-18.md) (B-100) — this document is the combined picture.

---

## 1. Verdict

**The foundations are genuinely strong — this app already does most of what WhatsApp does.** A typed `phoneCall|microphone|camera` foreground service is held for the full duration of both call kinds, the complete Android 14+ permission set is declared, an ongoing-call notification resumes the call over the keyguard (the B-58 tap-disconnect class is dead), InCallManager holds partial + proximity wakelocks with `MODE_IN_COMMUNICATION`, 1:1 calls are registered with Telecom for their entire lifetime, nothing in the JS layer tears a call down on background/lock, and — the key steady-state fact — **the socket.io pong is message-driven JS, so with the FGS holding the process, the socket survives locking and backgrounding indefinitely** as long as nothing goes wrong.

**Parity breaks the moment anything goes wrong while the screen is off.** React Native on Android freezes **JS timers** while the host activity is paused (message-driven JS keeps running; `setTimeout`/`setInterval` do not — proven in-repo by B-58's stale-pong evidence). Every socket **recovery** path is timer-gated: socket.io's own 500 ms retry, the B-14 manual backoff, and the 400 ms sleep inside the token-refresh reopen. So a socket that dies while the phone is locked **cannot reopen until unlock**, and the server's 12 s (1:1 bye) / 10 s (SFU teardown) graces always expire first. Combined with B-100's 15-minute token wall — which guarantees a socket kill on schedule — **every locked-screen call that crosses the wall dies deterministically**, and any network blip while locked kills a call the same way.

## 2. Confirmed findings (all adversarially verified)

### P0

**LC-1 · `bg-refresh-timer-stall` — socket recovery is setTimeout-gated; a locked in-call client cannot reopen before the server graces expire.** After the P0-6 sweep kill (`error{token_revoked}` + `disconnect(true)`), Path A (error frame received) refreshes the token (HTTP — event-driven, completes) but then awaits `setTimeout(400·attempt)` before `open()` (`packages/messenger-core/src/transport/client.ts:462-468`); Path B (frame lost in the emit/close race) relies on `scheduleServerReconnect()` — pure `setTimeout` (`client.ts:801-806`). Neither fires while locked. The 1:1 peer gets `call.hangup{failed}` at +12 s (tombstoned — irreversible; no re-offer machinery); the SFU closes transports at +10 s. **Scenario:** voice call, screen locked at minute 2 → at token-age 15:00–16:00 the sweep kills the socket → 12 s later the peer's phone says "call failed" with both phones in-pocket. **This is the background half of B-100** — and it means B-100's fix-direction D (client resilience) is insufficient unless the reopen path is made timer-free.

### P1

**LC-2 · `bg-socketio-reconnect-frozen` — any mid-call socket drop while locked has no timer-free reconnect.** socket.io auto-reconnect (500 ms delay, `client.ts:561-564`) and B-14 backoff (`client.ts:801-806`) are both frozen timers. The only event-driven rescue is the NetInfo listener (`productionRuntime.ts:1263-1289`) — which fires only on a connectivity-type/reachability _transition_; a same-network blip, a TCP reset, or a **messenger-service redeploy (staging redeploys on every push to main)** produce no transition. Server pings then go unanswered → socket reaped ≤35 s → 12 s/10 s graces → call dead; unlock reconnects into a tombstone.

**LC-3 · `netinfo-no-live-call-guard` — the NetInfo path lacks the B-58 live-call probe and its pong-freshness gate is always stale in background.** The AppState-'active' resume and the send-ack watchdog both guard with `decideResumeAction(pongFresh, hasLiveCall())` (`productionRuntime.ts:1379-1408, 2875-2881`), but the NetInfo handler does not (`productionRuntime.ts:1284-1288`): its only short-circuit is `lastPongAt < 10s`, and since the 4 s heartbeat is frozen in background, `lastPongAt` is _always_ stale during a locked call — so **every connectivity flap (including the captive-portal false alarms the code's own comment complains about) hard-destroys a healthy in-call socket**. For groups that means a 10 s SFU teardown racing a full rejoin; near the token wall it converts a flap into full B-100 death.

**LC-4 · `group-minimized-no-rejoin` — a minimized group call has NO reconnect→rejoin listener; a socket bounce while minimized kills it unrecoverably.** While minimized, no `useGroupCall` hook is mounted (FloatingCallOverlay is a pure registry consumer, `FloatingCallOverlay.tsx:38-46`) and the boot cleanup explicitly drops the `ws.onReconnect` rejoin listener when `keepAlive` is set (`useGroupCall.ts:2706-2710`); the L14 re-arm happens only on restore/adopt (`useGroupCall.ts:898-933`). Socket dies + reopens while minimized → `sfu.join` never re-runs → SFU closed the transports at +10 s → the bubble keeps showing a live call while the user is silent/frozen for everyone; restore adopts dead stash transports and still shows "joined". With B-100 unfixed, **any minimized span crossing the 15-min wall triggers this deterministically.** (PARTIAL verdict nuance: a _second_ socket bounce after restore does recover via L14.)

**LC-5 · `group-ice-budget-flush-on-resume` — the group 30 s ICE-reconnect budget flush-fails the call on unlock.** `useGroupCall.ts:1652-1665` arms a plain 30 s `setTimeout` whose callback is `setState('failed')` — no wall-clock deadline re-check, no background pause, no foreground re-probe, not even a `state==='reconnecting'` guard. The 1:1 path already fixed exactly this as P2-BR-6 (`callController.ts:1129-1206`: wall-clock deadline, pause on background, re-probe live ICE on foreground). **Scenario:** Wi-Fi blips mid group call → 'reconnecting' + budget armed → user locks phone → timer freezes → on unlock it flush-fires immediately → "Call failed" blocker even though ICE had recovered.

### P2

- **LC-6 · `resume-probe-zombie-socket-gate`** — the B-58 foreground probe refuses to rebuild a zombie socket while `transport.state` still reads 'connected'; recovery of a half-dead connection on return is delayed.
- **LC-7 · `csr-dead-no-replay`** — socket.io `connectionStateRecovery` can never replay missed call frames: `WS_SESSION_RECOVERY` is unset everywhere (stock Redis adapter no-op, `redis-io.adapter.ts:71-77`), and the P0-6 `disconnect(true)` is a non-recoverable reason by socket.io design. The client's recovery pid/offset bookkeeping is dead weight.
- **LC-8 · `doze-exemption-optional`** — deep-Doze/OEM-kill survival rests on a dismissible, 7-day-snoozable battery-exemption card on MessengerHomeScreen (`NotificationReliabilityCard.tsx:40`, `batteryOptimization.ts:129`); nothing on the call path checks or re-asks. On aggressive OEMs (TECNO/HiOS QA device, MIUI, ColorOS) a long screen-off call can still be reaped despite the FGS.
- **LC-9 · `rn-timer-freeze-vs-refresh`** — design constraint, recorded as a finding: **any timer-based fix for B-100 (e.g. "refresh at 12 min") will NOT fire during exactly the locked-screen calls that die today.** The proactive refresh must be event-driven — the natural hook is the WS message path (server pings arrive every 25 s and their handlers run while locked).
- **LC-10 · `group-call-no-telecom`** — group calls never register with Telecom (no `startCall`/`setCurrentCallActive`), losing the strongest OS keep-alive signal 1:1 has; a non-Telecom accept of a Telecom-reported group ring leaks a permanently-ringing connection.
- **LC-11 · `minimized-1to1-loses-appstate-protections`** — a minimized 1:1 call loses P2-BR-6 budget pause and B-20 camera recovery (both live inside the unmounted `useCall` screen scope).

### P3

- **LC-12 · `camera-streams-while-locked`** — camera capture is never paused on lock; the CAMERA-typed FGS keeps streaming pocket video (WhatsApp pauses). Privacy + battery + parity gap.
- **LC-13 · `no-producer-pause-on-background`** — no "camera paused" signal to peers on background; peers see a frozen last frame until return (WhatsApp shows the avatar placeholder). The plumbing exists (`sfu.producer.pause`, GC-01).
- **LC-14 · `minimize-resumes-all-consumers`** — the new offscreen-video policy resumes ALL consumers on blur (by design, for the overlay hero tile), then backgrounding keeps every remote stream decoding — combine with LC-13's producer-pause for a proper background media posture.
- **LC-15 · `no-system-pip`** — no `supportsPictureInPicture` on the activity; leaving the app during a video call gives no system PiP window (WhatsApp has one). In-app FloatingCallOverlay only.
- **LC-16 · `keepalive-sticky-after-background`** — registry `keepAlive` is set on every background transition and reset only on remount-adopt; benign today but a latent teardown-skip trap.
- **LC-17 · 1:1 voice→video upgrade FGS camera-type narrow case** — general upgrade path is fixed (P2-BR-7); the surviving sub-case is Android 14+ first-camera-grant-mid-call (effect early-fire + ratchet + swallowed native degrade).

## 3. What is already working (verified — do not re-litigate)

| Mechanism                                                                          | Evidence                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Typed call FGS, full duration, both call kinds, fallback ladder                    | `AndroidManifest.xml:154-157`, `CallForegroundService.kt:64-124`, started `CallScreen.tsx:915-916` / `GroupCallScreen.tsx:247-249`, stopped only on true end (`callRegistry.ts:249-250`, `groupCallRegistry.ts:217-218`) |
| Android 14+ permission set                                                         | FOREGROUND_SERVICE(\_PHONE_CALL/\_MICROPHONE/\_CAMERA), MANAGE_OWN_CALLS, WAKE_LOCK, USE_FULL_SCREEN_INTENT (`AndroidManifest.xml:24-46`)                                                                                |
| Ongoing-call notification; tap resumes over keyguard; Hang-up works with dead JS   | `CallForegroundService.kt:136-168`, `MainActivity.kt:54-102`                                                                                                                                                             |
| Wakelocks: partial + proximity (voice), KEEP_SCREEN_ON re-arm (video)              | `InCallManagerModule.java:554,818-831`; `CallScreen.tsx:929-952`                                                                                                                                                         |
| Telecom self-managed ConnectionService, full 1:1 lifecycle                         | `callKitBridge.ts:223,327`, `useCall.ts:884-885,565-566`, manifest `:172-181`                                                                                                                                            |
| No JS teardown on background/lock; keepAlive stamping; screens stay mounted        | `CallScreen.tsx:186-214,983-1001`, `GroupCallScreen.tsx:272-279,1438-1459`                                                                                                                                               |
| Message-driven pong → socket survives locked steady-state                          | engine.io pong sent from the WS packet handler; corroborated `callResumeGuard.ts:5-8`                                                                                                                                    |
| B-58 probe guard on AppState resume + send-ack watchdog                            | `productionRuntime.ts:1379-1408,2875-2881`, `callResumeGuard.ts:24-59`                                                                                                                                                   |
| Group rejoin machinery when the screen is mounted (B-05/L14 + F7 re-mint)          | `useGroupCall.ts:977-1002,898-933`, `groupCallReconnect.ts:99-137`                                                                                                                                                       |
| Auth-reject single-flight refresh with terminal/transient classification (P1-BR-7) | `client.ts:442-488,658-677,711-721,829-838`                                                                                                                                                                              |
| NetInfo event-driven force-reconnect (the one timer-free rescue)                   | `productionRuntime.ts:1263-1289`, `client.ts:414-433`                                                                                                                                                                    |
| Battery-opt/OEM-autostart/FSI flow exists (coverage caveat LC-8)                   | `BravoBatteryOptimizationModule.kt:42-209`, `NotificationReliabilityCard.tsx`                                                                                                                                            |

## 4. Erratum to B-100 (CALL_DEATH_AUDIT_2026-07-18.md)

B-100's **F-4** cited `src/modules/messenger/transport/client.ts:405-417` ("`io server disconnect` never reconnects"). That file is a **stale unused mirror** — the runtime imports `@bravo/messenger-core` (`tsconfig.json:26`, `babel.config.js:21`, `productionRuntime.ts:48,1012`), whose client **does** have a B-14 reconnect branch (`packages/messenger-core/src/transport/client.ts:769-807`). The _real_ defect in that path is LC-1: the reconnect exists but is `setTimeout`-gated and frozen while locked. B-100's root cause, timeline, and fix directions A–C are unaffected; direction D is superseded by FIX-1 below. (The stale mirror should be deleted or reduced to a re-export to prevent future mis-audits.)

## 5. The combined failure timelines

**T1 — locked phone, the deterministic killer (LC-1 + B-100):** call starts (token age T) → screen locks → at token-age 15:00 the Redis JTI evaporates → ≤60 s later the P0-6 sweep kills the socket → token refresh succeeds but the reopen waits on a frozen timer → +10 s SFU transports closed / +12 s peer receives `call.hangup{failed}` → call dead at **(15 − T) min + ≤60 s**, exactly the reported "10 or 16 minutes". Unlock reconnects into a tombstone.

**T2 — locked phone, any blip (LC-2/LC-3):** TCP reset / AP roam / server redeploy → no NetInfo transition → no reconnect until unlock → same 12 s/10 s death. Or: a NetInfo _false alarm_ fires → healthy in-call socket destroyed (LC-3) → recovery races the same graces.

**T3 — minimized group call (LC-4):** any socket bounce while minimized (wall, blip, redeploy) → transport self-heals but no `sfu.join` re-runs → user silent/frozen for everyone while the bubble shows a live call.

**T4 — unlock after turbulence (LC-5):** group call was 'reconnecting' when the screen locked → frozen 30 s budget flush-fires on unlock → "Call failed" even though ICE recovered.

## 6. Fix plan (ranked; NOT applied; auth pieces architecture-gated per CLAUDE.md security stop-conditions)

1. **FIX-1 (P0, unblocks everything): timer-free socket recovery.** Reopen inline on the first attempt (no 400 ms sleep — `client.ts:462-468`); re-arm retries on _events_ (WS close, NetInfo, AppState, server ping receipt), not bare timers; port the B-58 `hasLiveCall()` probe to the NetInfo path and make its pong-freshness gate background-aware (LC-3).
2. **FIX-2 (P0, = B-100 A/B/C under the LC-9 constraint): kill the token wall event-driven.** In-place WS re-auth frame + refresh scheduled from the message path (e.g. checked in the pong/ping handler — runs while locked), never from a timer; delay `revokeJti(prev)` by a 60–90 s grace; P0-6 sweep defers kills for sockets with an active call.
3. **FIX-3 (P1): minimized-group rejoin.** Register a registry-level `onReconnect` → `attemptSfuRejoin` while minimized (or keep a headless rejoin listener alive across the keepAlive window); validate transport liveness on restore instead of adopting dead stash transports.
4. **FIX-4 (P1): port P2-BR-6 to groups.** Wall-clock deadline + background pause + foreground ICE re-probe for the 30 s budget (`useGroupCall.ts:1652-1665`), mirroring `callController.ts:1129-1206`.
5. **FIX-5 (P2 batch):** restore `WS_HEARTBEAT_GRACE=25000` on the box (B-100 F-2); check/deep-link the Doze exemption once on first call (LC-8); zombie-socket probe rebuild path (LC-6); delete or re-export the stale transport mirror (§4).
6. **FIX-6 (P3 parity batch):** pause camera + send producer-pause on background/lock, resume on return (LC-12/13, plumbing exists); background media posture for consumers (LC-14); system PiP for video calls (LC-15); group Telecom registration (LC-10).

## 7. Prior-art status (so nothing is re-discovered)

- **Fixed + device-verified:** B-48 (killed-app push), B-53 (killed-app 1:1 ring, vc130 PASS), B-54/55/56, B-67.
- **Fix in code, device-verify pending:** B-58 (both halves), B-57 (partial — FSI denial became B-63), B-59/60/61, B-62/63/64/65/66/69/70 (vc131), P1-BR-4/5/6/8, P2-BR-1/6/7/8/9/11.
- **Open / not applied:** B-100 (+F-2 heartbeat override, F-3 TURN re-allocation), B-68 (SIGKILL while holding the call FGS — needs crash capture), Telecom `reportIncomingCall` from headless residual, dead `WS_SESSION_RECOVERY` decision (LC-7), and everything in §2 above.

## 7b. FIXED — 2026-07-18 (same day), server deployed

All P0/P1/P2 findings in §2 are implemented, adversarially re-reviewed (30 agents, 5 lenses), and the server half is live on staging. Commit `9ac5043`.

**What shipped**

| Fix                              | Finding          | Implementation                                                                                                                                                                                                                                                                           |
| -------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-place socket re-auth          | B-100 root cause | New `auth.refresh` WS handler (`messenger.gateway.ts`) re-verifies a fresh token exactly as the handshake does (sig/exp/iss/aud + jti allowlist), **pins identity to the same `sub` AND `deviceId`**, then swaps `ctx.claims` — no disconnect. Failure is non-destructive. Rate-limited. |
| Renewal clock that survives lock | LC-9 constraint  | Renewal hangs off socket.io's **Manager `ping`** — the server's ~25s heartbeat. `onAny` never sees protocol pings, so an idle locked call (1:1 media is P2P → zero socket traffic) would otherwise never renew: the fix would have been a no-op on its own target case.                  |
| Timer-free reconnect             | LC-1, LC-2       | First reopen runs inline from the `disconnect` event (delivered while locked), **gated on a live call** so a redeploy can't stampede the gateway, plus a 2s wall-clock floor so a connect/drop flap can't spin.                                                                          |
| NetInfo live-call guard          | LC-3             | Judges liveness from the transport's **inbound-signal clock** (`msSinceServerSignal`), not a 3s probe timer that is itself frozen in background — the guard now protects healthy sockets _and_ still rebuilds dead ones.                                                                 |
| Minimized-group rejoin           | LC-4             | `groupCallRejoinHub` owns one subscription across minimize, replace-not-stack on restore, with a **shared wall-clock-expiring rejoin slot**.                                                                                                                                             |
| Group ICE budget                 | LC-5             | Wall-clock deadline + re-arm + `transportsHealthy()` re-probe + foreground probe (ports the 1:1 P2-BR-6 fix).                                                                                                                                                                            |
| Background camera parity         | LC-12, LC-13     | Camera pauses + `sfu.producer.pause` on background (peers see the avatar, not a frozen frame), resumes on foreground, released on minimize so it can never strand. `background` only — not iOS `inactive`.                                                                               |
| Heartbeat grace                  | F-2              | Box `WS_HEARTBEAT_GRACE` restored 10000 → 25000 (and `_MS` → 30000), matching the B-05 code default. Applied and verified in the running container.                                                                                                                                      |

**Security posture (verified, not assumed).** Fix directions B (revocation grace) and C (sweep exemption) from B-100 were **rejected** as violations of the documented "instant kill" contract (`MESSENGER_BACKEND.md:204-210`). Only direction A was implemented. Independently confirmed that logout kills the refresh token — `deleteSession` sets `revoked_at` (`auth.service.ts:490,500`) and `refresh()` rejects on it (`:345`) — so a revoked device cannot mint a token, cannot re-auth, and is still disconnected by the 60s sweep. **Not a revocation bypass.** Token TTL unchanged.

**Review-driven corrections** (found by the adversarial pass, all fixed): unbounded connect-loop on the fast path (TR-1); `reauthInFlight` and `rejoinInFlightRef` boolean latches that stick forever when an ack is lost while locked — both replaced with wall-clock guards (F1/F2/TR-3); NetInfo probe deferring to a frozen timer (RT-1); camera stranded paused after minimize (GC-1); hub not retired when a call ends from a restored screen (GC-2/F5); two concurrent rejoins across a restore (GC-4); refusal escalation now reconnects instead of waiting to be killed (SEC-1); raw verifier strings no longer returned (SEC-3); iOS `inactive` no longer treated as background (GC-7).

**Gates:** messenger-crypto 189 suites / 1681 tests; messenger-service 32 suites / 310 tests; mobile tsc 46 ≤ 47 baseline; service tsc clean; eslint 0 errors. New specs: `messenger.gateway.auth-refresh.spec.ts` (6), `socketReauth.test.ts` (13), `groupCallRejoinHub.test.ts` (10).

**Deployed:** messenger-service rebuilt on Contabo — container healthy, `auth.refresh` subscription registered at boot, heartbeat env applied, zero boot errors.

**Not yet delivered / known limits:** the client half rides the **next APK** (server is backward-compatible: old clients simply never send `auth.refresh` and behave exactly as before). While a call is _minimized_, the AppState-driven camera pause and budget re-probe do not run (their listener lives on the call screen) — the rejoin hub deliberately does; the camera can no longer strand. Device verification (§8 matrix) is still owed.

## 8. Verification matrix (for the fix session)

| #   | Scenario                                                              | Pass criterion                                                                                        |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| V1  | 1:1 voice call, lock screen at min 2, stay locked 20 min              | Call alive at min 20; no P0-6 kill of the call socket (or kill + in-place recovery); audio continuous |
| V2  | Group call, minimize, force a socket bounce (toggle Wi-Fi off/on 5 s) | Rejoin ≤5 s; bubble state truthful; restore shows live tiles                                          |
| V3  | 1:1 locked, 10 s airplane-mode blip (no network-type change)          | Reconnect before the 12 s bye; call survives                                                          |
| V4  | Group call 'reconnecting', lock, unlock after 45 s with network fine  | No "Call failed" flush; re-probe promotes to joined                                                   |
| V5  | Video call, lock screen                                               | Camera pauses (peer sees avatar), resumes on unlock ≤2 s                                              |
| V6  | Mid-call token refresh (force via another API 401)                    | Socket re-auths in place; zero disconnect; call unaffected                                            |
| V7  | TECNO/MIUI device, exemption declined, locked 20-min call             | Call survives or the one-time call-path exemption ask was shown                                       |
| V8  | Regression: remote logout from second device during a call            | In-call socket still killed ≤60 s (P0-6 promptness preserved)                                         |
