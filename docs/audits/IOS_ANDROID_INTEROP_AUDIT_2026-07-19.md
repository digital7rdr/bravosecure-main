# iOS ↔ Android interop audit — messaging (1:1 + group) and video calls (1:1 + group)

**Date:** 2026-07-19 · **Scope:** BOTH directions (iOS→Android and Android→iOS) · **Status:** AUDIT ONLY — no code changed
**Method:** 5-lane parallel code trace (63 agents), every finding re-checked by two independent adversarial verifiers (a "does the code actually say this" lens and a "would QA actually observe this" lens). 27 findings survived, 2 were refuted and are recorded below as disproven so nobody re-chases them.
**Trigger:** QA reports "video problem in group call" and asks whether iOS↔Android messages are flowing.

---

## 0. The one-paragraph answer

**Messaging works. Group calls on iPhone cannot work at all.** The E2EE messaging path is byte-identical across the two platforms and contains zero platform gates — `git diff` between the iPhone's build and current Android over `packages/messenger-core/src`, `src/modules/messenger/crypto` and `.../transport` is **empty**, so both devices speak the same envelope format and messages genuinely deliver and decrypt in both directions. What is broken is that **the iPhone never displays a message notification and never registers for push at all**, so messages only surface when the app is foregrounded — which reads exactly like "messages aren't arriving". Separately, **every group call on QA's iPhone build fails before a single media frame**, because that binary hard-gates the mandatory E2EE frame cipher to Android. That is not a video defect; no group call of any kind — voice or video — can start on it. Both problems are already fixed in `main`; neither fix is in the binary QA is testing.

---

## 1. The context that determines everything: version skew

QA is testing a **mismatched pair**, and most symptoms trace back to this rather than to any cross-platform incompatibility.

|             | Build under test                                                                 | Contains                                          |
| ----------- | -------------------------------------------------------------------------------- | ------------------------------------------------- |
| **iPhone**  | TestFlight build **143 or 144** — v1.0.115/v1.0.116 code, cut ≈ commit `93a9726` | None of the 2026-07-18 night batch                |
| **Android** | v1.0.117 / vc145 (Firebase qa, shipped tonight)                                  | B-102…B-118, the WebRTC stack swap, B-115/116/117 |

**⚠️ We do not know which iOS build QA holds, and the two behave differently on exactly the axis being tested** (IOSBS-4, CONFIRMED). Build 143 is **v1.0.115** code — it predates B-100/B-101, so calls on it die at the 15-minute token wall and the group cap is 6 rather than 10. Commit `8b2d264` states the _intent_ to upload 144, but nothing in the repo records that a 144 upload actually succeeded, and `ios-release.sh` derives the build number from App Store Connect at runtime, so the committed `"buildNumber": "144"` is not evidence either.

> **Action before any further iOS QA:** have the tester read the build number off TestFlight and record it against every test row. Results from an unidentified binary are not interpretable.

---

## 2. Messaging — 1:1 and group, both directions

### 2.1 Verdict: delivery and crypto are HEALTHY

Two independent proofs, both verified:

- **No platform gates exist in the messaging path.** `Platform.OS` / `Platform.select` across `src/modules/messenger` matches only `push/`, `webrtc/`, `callForegroundService`, `batteryOptimization`, `incomingRingtone`, `wipeAtRest`, and the DB filename — **not one match** in `crypto/`, `store/`, `transport/`, or the send/receive halves of `productionRuntime.ts`. `packages/messenger-core/src` (libsignal wrapper, sealed-sender v2, sender cert, protocol, client) contains **no `Platform` reference at all**.
- **The wire format is identical across the skew.** `git diff 93a9726..HEAD` over `packages/messenger-core/src`, `src/modules/messenger/crypto` and `src/modules/messenger/transport` returns **empty**. Tonight's batch changed only receive-side UI attribution, consuming fields the old frames already carry.

iOS-specific build pieces are patched **for** iOS, not against it (op-sqlite podspec forced to SQLCipher, quick-crypto header search path).

### 2.2 What is actually broken — the iPhone can't _tell you_ a message arrived

| ID                        | Severity    | Affects                   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ----------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **IOSMSG-1**              | **P1**      | both builds               | **Every message-notification path hard-returns on iOS.** `showMessageNotif` is the single funnel for all three feeds (warm FCM, killed-app FCM, store-driven notifier) and its first statement is `if (Platform.OS !== 'android') {return;}` (`callNotification.ts:177`). Both feeders are gated identically (`backgroundMessageNotifier.ts:185`, `callNotification.ts:501`). Verified exhaustively: all four call sites dead-end at the same gate; no alternative iOS banner path exists. |
| **IOSMSG-2**              | **P1**      | both builds               | **iOS never requests notification permission and never registers for remote messages** (`fcmBootstrap.ts:204-208` — _"Skip iOS permission prompt for now"_). No authorization ⇒ iOS would discard a local notification even if one were drawn; no APNs registration ⇒ no token reaches `/push/register`. The background wake path is dead at the root.                                                                                                                                     |
| **IOSMSG-3** (group lane) | P2 (LIKELY) | both builds               | **Server sends iOS chat wakes as `content-available` with `apns-priority: 10`** (`push.service.ts:729-734`). APNs requires background pushes at priority **5**; the combination is answered with `BadPriority` or silently deprioritised, and the token is not reaped, so the failure is invisible apart from one warn line.                                                                                                                                                               |
| **IOSMSG-4** (group lane) | P2          | **new Android code only** | **Regression introduced tonight (B-106).** The ad-hoc-call ghost sweep keys off the literal display name `'Call'`, and `pruneCallGroupGhostRows` runs on **every boot**. A genuine group that anyone named exactly "Call" is deleted from the Android chat list, while the iPhone (pre-B-106) still shows it. `is_custom_name` only protects a _local_ rename, so the creator's name arrives unprotected at every other member.                                                            |
| IOSMSG-5 (1:1 lane)       | P3          | both builds               | Sender-cert MFA action token hardcodes `platform:'android'` (`keysClient.ts:145`); the iPhone's stale-queue purge fails after identity rotation.                                                                                                                                                                                                                                                                                                                                           |
| IOSMSG-6 (group lane)     | P3          | mixed pair                | Group blue-tick semantics diverge: new Android flips only when **all** members have read (B-116), the old iPhone flips on the **first** receipt. Cosmetic, expected, resolves when both sides are on one version.                                                                                                                                                                                                                                                                          |

**Net user-visible effect:** an Android→iPhone message is accepted by the relay, encrypted correctly, and stored — but the iPhone is silent in foreground, background, and killed states. Opening the app reveals every message present and correctly decrypted. **Expect this to be filed as a P0 delivery bug when it is a notification bug.**

**Disproven (do not chase):** the `[crypto/polyfills] XEd25519 verify self-test could not run` warning is **benign** — it gates nothing and is not iOS-specific (`polyfills.ts:360-364`). One residual _hypothesis_ only: the HMAC polyfill has no boot self-test on iOS's crypto backend (IOSMSG-3, 1:1 lane) — unproven, low priority.

---

## 3. Group video calls — the reported complaint

### 3.1 Root cause (P0, CONFIRMED, both directions)

**IOSGV-1 / IOSBS-1 — the S6 frame-cipher gate makes every iOS group call fail before media.**

On the binary QA is testing, `isAvailable()` returns false for any non-Android platform _unconditionally_ — it never even probes for a native module:

```
frameCryptorTransport.ts:64 (at 93a9726)   if (Platform.OS !== 'android') {return false;}
```

`frameCryptorOrchestratorAvailable()` is a bare passthrough of that predicate, and the group-call boot hits the refusal at **step 3 — after `sfu.join` has already succeeded**:

```
useGroupCall.ts:1403-1415 (at 93a9726)
  '[bravo.groupcall.boot] step=3 FrameCryptor unavailable on this build
   — refusing to start unencrypted group call (S6)'
  → setState('failed') → best-effort sfu.leave → return
```

Steps 8 (produce), 9 (consume), 10 (identity) and 11 (ring) are never reached, so the iPhone neither sends nor receives a single frame.

**The gate is correct and must not be relaxed.** The SFU terminates DTLS-SRTP, so running without the frame cipher would hand the server plaintext media — an explicit CLAUDE.md stop-condition. The defect is that the iOS half of the contract did not exist in that binary. **This is not a "video problem": no group call of any kind, voice or video, can start on QA's iPhone build.**

### 3.2 Why it looks like a network fault (P1, CONFIRMED) — and a correction to our own earlier doc

**IOSGV-2 — the refusal is completely invisible to Android peers.** Two separate silences:

- **iPhone as host:** the outgoing `sfu.ring` fan-out is **step 11**, ~770 lines after the step-3 gate. The call dies before any recipient is notified — **the Android phones never light up at all.**
- **iPhone as joiner:** the S6 path calls only `sfu.leave`; it never emits `sfu.ring.decline` (that event is wired exclusively to the user-tapped Decline button, `IncomingGroupCallScreen.tsx:247-256`). The Android host therefore sits on **"Ringing…" for the full 30-second window** and then falls through to no-answer.

> **📌 Correction to `IOS_GROUPCALL_AND_MESSENGER_PARITY_B111_B117_2026-07-18.md`:** that document (and my earlier summary) described this as a "roster ghost" — the iOS user flashing into the participant list and vanishing. **That is wrong.** The server's `sfu.join` handler broadcasts nothing to the room (`messenger.gateway.ts:1600-1618`) and remote identity is announced at step 10, which is never reached — so **no roster tile ever appears on Android**. The real Android-side symptom is silence or an endless ring.

### 3.3 Compounding condition

**IOSGV-3 (P1, environment):** `APNS_VOIP_*` is still unset on staging, so the iPhone receives no group-call ring at all unless the app is already foregrounded with a live WebSocket.

### 3.4 Explicitly disproven — do not chase these

- **IOSGV-5:** tonight's `SFU_ROOM_TOKEN_SECRET` enforcement does **not** break the old iPhone build. Room-token client wiring landed 2026-05-24, long before v1.0.116; the old build echoes tokens on `sfu.join`, ring and decline.
- **IOSGV-6:** SFU codec negotiation and libwebrtc version skew are **not** the group-video defect. The router advertises **both VP8 and H264** (baseline `42e01f`, packetization-mode 1, level-asymmetry-allowed) — correct for iOS/Android interop (`sfuWorkerPool.ts:203-219`).
- **IOSGV-7 (refuted 2/2):** the B-111-A pre-join gate ordering does **not** leak empty SFU rooms — the room-minting branch is unreachable from every entry point the concern named (`useGroupCall.ts:1114-1118` hard-refuses incoming-without-roomId).

### 3.5 Forward-looking risk for the _new_ iOS build (P2, HYPOTHESIS)

**IOSGV-4:** the new iOS FrameCryptor module reaches `WebRTCModule` through the **legacy bridge + KVC** (`native/ios/BravoFrameCryptor.swift:180-196`). That is untested under RN 0.81 bridgeless mode. If `bridge.module(forName:)` returns nil on the Mac build, `isAvailable()` will pass but attach will fail with `WEBRTC_MODULE_MISSING`. **Watch for this specific error during the Mac build** — it is the most likely first failure of B-111-B.

---

## 4. 1:1 video calls

| ID           | Severity | Affects                | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------ | -------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **IOSVID-2** | **P1**   | QA's iPhone build only | **Predates B-110: an outgoing video call can stall ~35 s before any invite is sent.** The whole call boot is gated on TURN credentials (`CallScreen.tsx:501`); without B-110's 6-second ceiling the first fetch after a background window rides a dead socket into a 15 s timeout plus refresh+retry. `git merge-base --is-ancestor 3209d0f 93a9726` → **NO**. The Android side simply never rings; if QA retries, a stale invite can later fire as a ghost ring. |
| IOSVID-4     | P2       | QA's iPhone build only | Predates B-108: a mid-call ICE `failed` is instantly terminal on iOS while the new Android side tries to reconnect — asymmetric call drops.                                                                                                                                                                                                                                                                                                                       |
| IOSVID-5     | P2       | both builds            | **STUN-only fallback cannot carry a cross-NAT call.** When TURN creds fail, the call falls back to one public STUN server (`CallScreen.tsx:484`); iPhone-on-LTE ↔ Android-on-WiFi is exactly the symmetric-NAT case that needs a relay. Degrades **silently** — indistinguishable from any other failure, and same-LAN QA never reproduces it.                                                                                                                    |
| IOSVID-3     | P2       | both builds            | iOS camera denial surfaces a generic "Connection lost" plus **Android-only** Settings instructions.                                                                                                                                                                                                                                                                                                                                                               |
| IOSVID-6     | —        | —                      | **No defect:** Android renders an iOS-originated track correctly (`remoteTileGate.ts:41-49`).                                                                                                                                                                                                                                                                                                                                                                     |

### B-119 re-attributed (refuted 2/2)

The open bug B-119 (1:1 video never connecting on the BlueStacks rig) was hypothesised to be the VP8 SDP munge. **Both verifiers refuted it, and the evidence is decisive:** ICE gathering does not begin until `setLocalDescription` resolves, so gathering reaching COMPLETE is affirmative proof the munged description was fully accepted and the ICE agent fully constructed. Moreover **gathering COMPLETE in ~1 s is far too fast for a real TURN allocation** — it indicates a host-only candidate set, and two emulator instances behind the same host NAT can never pair. **B-119 is a rig/TURN artifact, not a product bug.** Confirm with one real-device video call before spending further time.

For the record: the VP8-first munge applies to **1:1 only** (mediasoup builds its own PeerConnections, so group calls never see it), and **both** sides of the current pair munge, so it should help 1:1 interop rather than hurt it — at the cost of software VP8 encoding on iPhone.

---

## 5. The build-pipeline problem that undermines the iOS fixes (P1, LIKELY)

**IOSBS-2 — `scripts/ios-release.sh` never runs `expo prebuild`, so no config-plugin change reaches a TestFlight binary.**

The script archives the existing gitignored `ios/` tree directly with `xcodebuild`; there is no prebuild step in its 245 lines, and its commit message says that is **deliberate** ("both run expo prebuild, which regenerates ios/ and drops the hand-applied fixes"). Consequently every plugin in `app.json` — `withVoipCallKit`, `withIosBuildFixes`, **and the new `withBravoFrameCryptor`** — is **inert for that pipeline**. `app.json`'s `aps-environment` and `UIBackgroundModes` are prebuild-time transforms, and the repo's own binary probe (`docs/runbooks/IOS_README.md:190-199`) shows both absent from the built app.

**Two consequences that must be handled before the next iOS build:**

1. **B-111-B will not ship through `ios-release.sh` as written.** The FrameCryptor Swift module is copied into `ios/` _by the plugin at prebuild_. The Mac runbook (`MAC_BUILD_RUNBOOK_FOR_CLAUDE_2026-07-18.md`) correctly runs `expo prebuild -p ios --clean` first — **that ordering is mandatory**, and the two flows must be reconciled: prebuild once (now safe, thanks to `withIosBuildFixes`), verify the probes, then archive.
2. **Add a guard.** `ios-release.sh` should assert `aps-environment` and `UIBackgroundModes` on the built app and fail in seconds, the same way it already guards CallKit wiring — otherwise a binary missing background modes ships silently, and calls will keep dying on screen-lock (IOSBS-3).

---

## 6. What to do, in order

1. **Tell QA the iPhone build is not a valid test subject for group calls.** Every group-call row against build 143/144 is untestable, not failing. Record the exact build number on every future row.
2. **Ship a new iPhone build from `main` (≥ `76e2702`)** via the Mac runbook — **with `expo prebuild` run first**, and verify the `codesign`/`PlistBuddy` probes before archiving. That single build closes IOSGV-1, IOSVID-2, IOSVID-4 and the background-mode class at once.
3. **Fix the "Call" group deletion (IOSMSG-4)** — a regression from tonight. Tag ad-hoc call groups with a local-only marker at the single mint site (`productionRuntime.ts:4313`) and key the four guards off that marker, keeping the name test only as a one-shot migration.
4. **Decide on iOS notifications (IOSMSG-1 + IOSMSG-2).** These are the reason messaging "looks broken". Widen the three gates to a capability check and request iOS authorization; this must land together with the APNs priority fix (IOSMSG-3: send background wakes at priority 5) or the banner still never fires in the background.
5. **Set `APNS_VOIP_*` and resolve the org App ID** — until then no iOS ring works while backgrounded, for calls of any kind.
6. **Close B-119 properly** with one real-device 1:1 video call; do not touch the VP8 munge until that discriminates rig from product.
7. **Verify TURN/coturn health** (B-41 class) before attributing any cross-NAT call failure to the peer.

---

## 7. Verification note

63 agents, two adversarial verifiers per finding, default posture REFUTED. 27 findings survived; 2 were killed (the VP8/B-119 attribution and the pre-join room-leak) and are recorded above so they are not re-investigated. Where a verifier corrected a detail rather than refuting, the correction is folded into the text above. The safety classifier was unavailable while reviewing 6 of the 63 agents; every claim reproduced in this document was independently re-checked at file:line before being written here.
