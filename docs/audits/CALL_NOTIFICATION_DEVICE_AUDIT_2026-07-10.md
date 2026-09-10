# Call & Notification Device Audit — 2026-07-10 (Pixel 7a, v1.0.104/vc130)

**Trigger:** tester (live device) reported 4 complaints on the v1.0.104 (vc130) remediation build:

1. "Notification does not say what is going on — like Telegram."
2. "The app logo on top of the bar should be the Bravo logo (like WhatsApp's status-bar icon)."
3. "Still, from the notification we didn't receive the call."
4. "The callee cannot end that call — the callee tried to receive via OTP."

**Evidence:**

- Device logcat: `E:\Bravo Secure\bravo_call_log_20260710_112445.txt` (7,728 lines, 11:20:40–11:24:45 local = 05:20:40–05:24:45 UTC; system-priority capture — **JS `[WEBRTC]`/call-state logs absent**, see §8).
- Server: `bravo-staging-msgr` container logs on Contabo `94.136.184.52`, window 05:20–05:33 UTC (pulled live during this audit).
- Code: HEAD `391590d` (v1.0.104/vc130), traced by 3 read-only audit agents.

**Device & identities (server-confirmed via `users` table):**

| Party                                   | userId prefix | Account                         | Device                                             |
| --------------------------------------- | ------------- | ------------------------------- | -------------------------------------------------- |
| Callee (device under test)              | `79d63649`    | Shirajul Islam                  | **Pixel 7a** (`pixel-thermal`, TMD3719 — physical) |
| Caller, call 1 + later successful calls | `3165d0e1`    | **Ranak** (new to identity map) | —                                                  |
| Caller, call 2                          | `fe4ddc14`    | Fahim                           | —                                                  |

**Verdict summary:** the B-53 killed-app wake/ring fixes **work** (verified device + server). What still fails is everything _after_ the ring: the OS denies the full-screen call UI (`FSI_REQUESTED_BUT_DENIED`, unhandled), and the notification-Answer chain **never delivers `call.answer` to the server** — the caller rings out, the server correctly marks the call missed, and the callee is left with a zombie call session + an un-clearable ongoing-call notification and (on cold boot) an OTP/login screen. Two further independent defects: message notifications still show generic text by default, and the status-bar icon is a placeholder Material shield, not Bravo artwork. Plus one new high-risk find from the same log: the ratchet-snapshot uploader hammers `stale_seq` every 4 s forever.

New bugs filed: **B-62..B-67** (see §7 and `sqa.md`).

---

## 1. Reconstructed timeline (device ⇄ server)

### Call 1 — Ranak → Shirajul, `cid=ca21470b` (app backgrounded/frozen) — MISSED

| Time (local / UTC)  | Side          | Event                                                                                                                                                                                                    |
| ------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11:21:19 / 05:21:19 | server        | `[CALL] OFFER from=3165d0e1/1 → 79d63649/1 kind=voice` → `ERR=peer_offline` → `push.voip.delivered sent=1/1` ✅                                                                                          |
| 11:21:21            | device+server | App process **unfrozen** by FCM (`sync unfroze 28658`); WS reopens; server: `replay pending offer cid=ca21470b age=1.9s` ✅                                                                              |
| 11:21:22            | device        | App plays ringtone; `AudioHardening background playback would be muted … USAGE_NOTIFICATION_RINGTONE` (Android 16 audit mode — will be enforced later)                                                   |
| 11:21:26            | device        | ⚠️ `Foreground service started from background can not have location/camera/**microphone** access: .CallForegroundService` (×2) — mic-typed FGS started while app not foreground → **mic access denied** |
| 11:21:27.5          | device        | User taps notification action (`NotificationReceiverActivity` bnds=[540,311][1006,437] = right-half action = **Answer**) → MainActivity to front, keyguard dismissed                                     |
| 11:21:27–11:21:52   | server        | **No `call.answer`, zero ICE from callee — ever**                                                                                                                                                        |
| 11:21:54 / 05:21:54 | server        | Caller gives up: `HANGUP from=3165d0e1 reason=ended` → `push.call-cancel.delivered missed=true sent=1/1`                                                                                                 |
| 11:21:56–11:22:02   | device        | `MODE_IN_COMMUNICATION` for ~6 s, then back to `MODE_NORMAL` — a local call-audio session starts _after_ the cancel and dies                                                                             |
| 11:22:41–42         | device        | Tester moves task back and **swipe-kills the app** (`Killing 28658 … remove task`) — consistent with "cannot end the call" → manual kill as workaround                                                   |

### Call 2 — Fahim → Shirajul, `cid=29c59534` (app KILLED) — MISSED

| Time (local / UTC)          | Side   | Event                                                                                                                                                                                                    |
| --------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11:22:44 / 05:22:44         | server | `OFFER … ERR=peer_offline` → `push.voip.delivered sent=1/1` ✅                                                                                                                                           |
| 11:22:45.9                  | device | **FCM starts the dead process** (`Start proc 31266 … ReactNativeFirebaseMessagingReceiver`) ✅ B-53                                                                                                      |
| 11:22:52                    | device | Ringtone playing + incoming-call notification posted: channel `bravo-incoming-call-v2`, actions=2, **`FSI_REQUESTED_BUT_DENIED`** ⚠️                                                                     |
| 11:23:06.2                  | device | User taps **Answer** (same bounds) → ring notif removed → MainActivity **cold boot** (splash, RN bundle load)                                                                                            |
| 11:23:09–11 / 05:23:09–11   | server | Callee re-auths + re-registers push tokens; WS `+conn`; TURN creds issued; `replay pending offer cid=29c59534 age=27.5s` ✅                                                                              |
| 11:23:11.6                  | device | RNCallKeep registers Telecom phone account (JS boot ~5.4 s after tap)                                                                                                                                    |
| 11:23:12.5–12.8             | device | InCallManager starts (EARPIECE, proximity on); `MODE_IN_COMMUNICATION`; **CallForegroundService `startForeground ok type=128` (mic)**; FGS notif **id 70242** posted (`bravo-call-foreground`, NO_CLEAR) |
| 11:23:12–11:23:29           | server | **No `call.answer`, zero ICE from callee — ever**                                                                                                                                                        |
| 11:23:18.7                  | device | Audio mode drops to `MODE_NORMAL` — call audio session dead after **~6 s**                                                                                                                               |
| 11:23:29 / 05:23:29         | server | Caller gives up: `HANGUP from=fe4ddc14 reason=ended` → cancel push `missed=true sent=1/1`                                                                                                                |
| 11:23:31                    | device | **Missed-call notification** posts (`bravo-missed-calls`) — the "notification after the call" the tester sees                                                                                            |
| 11:23:13→11:24:45 (log end) | device | FGS notif 70242 **never removed**; `[ratchet-snapshot] upload failed (stale_seq)` repeats **every ~4 s** (§6)                                                                                            |

### Control cases — same device, minutes later (proves what works)

| UTC      | cid        | Path                                                                          | Result                                                                          |
| -------- | ---------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 05:28:22 | `b8985727` | live offer (`OFFER result OK`, app foreground)                                | **ANSWER in 3.0 s** → ICE both ways → media, re-offer to video, clean hangup ✅ |
| 05:30:30 | `4f9b8972` | `peer_offline` → **replayed offer** `age=2.5s`, app warm, answered **in-app** | **ANSWER in 2.6 s** ✅                                                          |
| 05:30:47 | `baf03f22` | live offer                                                                    | ANSWER in 2.2 s ✅                                                              |

**Dichotomy:** offer replay itself is fine, and in-app answering works. Both failures are exactly the **notification-driven answer after a frozen/cold boot**. Server received _nothing_ from the callee on the failed calls (no answer frame, no ICE, no error — window checked for warn/error: clean).

---

## 2. Complaint 3 — "still didn't receive the call from the notification" (B-62 + B-63)

### What now works (positive retest results)

- **B-53 (killed-app no-ring): PASS.** Wake push `sent=1/1`, dead process restarted by FCM, ring audible ~7 s after offer, pending-offer replay on reconnect (both 1.9 s and 27.5 s old), cancel/missed push delivered. The whole 2026-07-09/10 server pipeline is live and correct.
- Server-side answer bookkeeping is correct: an answer that registers flips the session `ringing→active` and deletes the missed marker (`messenger.gateway.ts:2346-2356`, `:1255`), so a missed push arriving means **the answer never reached the server** — confirmed in both failed calls.

### Root-cause chain (client-side, code-verified)

1. **Full-screen intent denied and unhandled (B-63).** The ring requests `fullScreenAction` (`src/modules/messenger/push/callNotification.ts:406-409`) and `USE_FULL_SCREEN_INTENT` is declared (`AndroidManifest.xml:40`), but Android 14+ deny-by-default applies — device shows `FSI_REQUESTED_BUT_DENIED`. There is **no** `canUseFullScreenIntent()` check nor an `ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT` deep-link anywhere; the new `NotificationReliabilityCard` covers only battery/autostart. This is the documented-open N-05. Consequence: no full-screen ring UI over the lock screen; the P1-BR-8 `setShowWhenLocked/turnScreenOn` flags in `MainActivity.kt:82-89` never get their intended entry path; answering means tapping a heads-up and **cold-booting the whole RN app**.
2. **Answer routes into a navigator that may not exist yet.** The Answer handler waits ≤20 s for nav readiness then `navigate('Main', …CallScreen{autoAccept})` (`fcmBootstrap.ts:989-1049`) — but the root navigator conditionally mounts `Main` **only when authenticated** (`src/navigation/index.tsx:56-74`). During cold-boot hydration (or if re-auth is required) the navigate is a **silent no-op and the user is parked on the Auth/OTP stack** — the tester's "tried to receive via OTP" (§4).
3. **The killed-path notification carries no SDP** (`fcmBootstrap.ts:1313-1321` caches the wake payload without `incomingSdp`), so CallScreen's auto-accept waits for the WS offer replay (`CallScreen.tsx:754-771`). On call 2 the replay arrived (05:23:11) and a call session visibly started (InCallManager, 11:23:12.7) — **but no `call.answer` and no ICE ever left the device**, meaning `accept()` died _before_ `signalling.sendAnswer` (`callController.ts:477-521`) and before `setLocalDescription` (no candidates gathered).
   - **Leading hypothesis (medium-high):** microphone capture fails on this path — call 1 logs the smoking gun explicitly (`Foreground service started from background can not have location/camera/microphone access: .CallForegroundService`), and a keyguard-occluded, freshly cold-booted activity can lose mic app-ops the same way; `getUserMedia` rejection kills `accept()` pre-answer. The ~6 s `MODE_IN_COMMUNICATION` window on both calls is consistent with audio-session setup → capture failure → teardown. Needs the §8 JS-level log to confirm (accept error is currently swallowed silently).
4. **No `'connecting'` watchdog.** `accept()` cancels the ring timer (`callController.ts:484`); the reconnect budget only arms after a call was `connected`. A post-accept call whose answer is lost sits in `'connecting'` **forever** — no `end('failed')`, no user feedback, no teardown.

### Why the tester sees "notification only after the call"

That notification is the **missed-call cancel push working as designed** (`messenger.gateway.ts:1365-1372` fires `sendCallCancel(missed=true)` when the caller hangs up on a still-`ringing` session). It looks absurd to the tester only because their Answer silently failed upstream.

---

## 3. Complaint 4 — "callee cannot end that call" (B-64)

Code-verified chain, matching the log (FGS notif 70242 alive 90+ s after call death, tester swipe-killing the app on call 1):

- The **only** two FGS/notif teardown paths both require the controller to reach a terminal state or a clean CallScreen unmount: `callRegistry.endActiveCall` (`callRegistry.ts:247-251` — stops InCallManager + FGS + ring notif together) and the CallScreen audio-effect cleanup (`CallScreen.tsx:972-987`, gated on `keepAlive`/registry ownership). With the controller wedged in `'connecting'` (§2.4), **neither ever runs** → notification 70242 (`CallForegroundService.kt:120,134`, `setOngoing(true)`) is un-swipeable and permanent.
- The End button itself is robust **when reachable** (`CallScreen.tsx:1449-1468` hangs up + belt-and-suspenders `endActiveCall` + 800 ms `goBack` watchdog). The failure is **reachability**: if the user is on the Auth/OTP screen the entire `Main` subtree including CallScreen is unmounted (`navigation/index.tsx:56-74`) — there is no End button anywhere.
- The only out-of-screen control, `FloatingCallOverlay` (`App.tsx:78` — mounted outside the auth gate, so it _could_ paint over OTP), renders **only when `active?.isMinimized === true`** (`FloatingCallOverlay.tsx:124`), which is set only by back-press/swipe-away of CallScreen. A zombie auto-accepted call never minimized → overlay never appears.
- The FGS notification offers **no End/Hang-up action** — its tap just relaunches MainActivity (`CallForegroundService.kt:100-123`).

⇒ A session-expired (or wedge-state) callee has **no reachable UI at all** to end the call or clear the notification. The tester's observed workaround — swipe-kill the app — is the only one available.

Also confirmed server-side hardening gap (minor): a late `call.answer` after the caller's hangup is silently ignored (`authorizeCallFrame` → ignore, `messenger.gateway.ts:2327-2332`) — correct not to connect, but nothing tells the callee's UI the call is over (the client `call.missed` handler appends a bubble + notif but does **not** tear down a live controller stuck in `'connecting'`, `callDispatcher.ts:168-186`).

---

## 4. "Tried to receive via OTP" — explained

Swipe-kill does not log the user out, but on cold boot the root navigator shows the **Auth stack while auth state hydrates** (`showAuth = !isAuthenticated || !user?.role`, `navigation/index.tsx:56`), and any re-auth requirement (refresh failure, app-lock) keeps the user there. The Answer deep-link targets `Main`, which **does not exist** in that state → silent no-op. Meanwhile the headless side of the app (push re-register at 05:23:09, WS reconnect, offer replay, even the auto-accept attempt) proceeds independently. Net effect the tester described precisely: _they answered a call and got an OTP/login screen_, while a half-started call session ran (and died) behind it.

---

## 5. Complaints 1 & 2 — notification content (B-65) and status-bar icon (B-66)

### B-65 — "doesn't say what's going on, like Telegram"

The N-10..N-17 machinery from the 2026-07-09 remediation **is implemented** (MessagingStyle, inline Reply/Mark-read, badge, sender-name resolution incl. the killed path via the persisted conversation list — `mutedLookup.ts:97-123`, `fcmHeadless.ts:169-175`, `backgroundMessageNotifier.ts:160-178`). What the tester still sees is the composition **defaults**:

| Path                                          | Title today                | Body today                                                                                                                                                                 |
| --------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Warm/background (store notifier)              | conversation name ✅       | **`'Open Bravo Secure to read it'`** — preview exists but `contentPreviewEnabled` **defaults OFF** (`backgroundMessageNotifier.ts:38`, pref `bravo:notif-content-preview`) |
| Killed, 1:1 (resolvable thread)               | contact name ✅            | generic (headless never has plaintext — needs the Signal-style headless-drain decision)                                                                                    |
| Killed, 1:1 (no local thread) / **any group** | **`'New secure message'`** | `'Open Bravo Secure to read it'` (`callNotification.ts:216-217`; group residual documented at `backgroundMessageNotifier.ts:16-18`)                                        |

So versus Telegram: names mostly ✅, **message preview never shown by default anywhere**, and killed-app group messages are fully generic. Decisions needed (product/privacy, not architecture): flip `contentPreviewEnabled` default ON for the warm path (Telegram/WhatsApp default) + surface the toggle in Settings; resolve group names on the killed path from the persisted store; headless-drain for killed-app previews stays the known L-size decision.

### B-66 — status-bar icon is not the Bravo logo

Wiring is already correct at HEAD — every notifee call and the FCM fallback meta-data (`AndroidManifest.xml:122`) point at monochrome `ic_stat_bravo`. The problem is the **artwork**: `android/app/src/main/res/drawable/ic_stat_bravo.xml:14` contains the stock **Material "verified_user" shield glyph** as an admitted placeholder — not Bravo brand artwork. Secondary: no `com.google.firebase.messaging.default_notification_color` meta-data and no `color` on message/server-wake banners, so the silhouette tints OS-default grey (only the incoming-call notif tints `#1E88FF`). Fix = one branded 24 dp white-on-transparent vector + accent color; no code changes.

(If any tester device runs a build older than `73ad6f3`, they see the legacy white _blob_ — worth confirming installed versionCode when retesting.)

---

## 6. New independent find — ratchet-snapshot `stale_seq` hammer (B-67)

From cold boot 11:23:13 to log end, this pair repeats **every ~4 s, indefinitely**:

```
W/ReactNativeJS: [ratchet-snapshot] upload failed (stale_seq); not advancing seq, will retry next cycle
W/ReactNativeJS: '[bravo.ratchet-snapshot] capture failed:', 'stale_seq'
```

Code-verified:

- Capture piggy-backs on the 4 s runtime heartbeat (`productionRuntime.ts:1449-1467`); the intended 5-min debounce (`ratchetSnapshotScheduler.ts:114`, checked `:257`) **only advances on success** (`lastCaptureAtMs` written at `:289`, inside the try) → persistent failure = full attempt every 4 s. No backoff, no cap.
- `stale_seq` = server 409 when `existing.seq >= payload.seq` (`backup.service.ts:716-723`). Client `nextSeq = readSeq()+1` and `writeSeq` only on success (`ratchetSnapshotScheduler.ts:277,288`) → same rejected seq every cycle, forever. Trigger: local seq counter reset (fresh keychain/AsyncStorage state or HMAC-verify failure → treated as 0, `:159-167`) while the server holds seq ≥ 1.
- **The B-50 stale_seq adopt-and-retry exists only on the merkle-commit path** (`merkleCommit.ts:247-273`); the snapshot **upload** path discards the server's `currentSeq` (`httpSnapshotTransport.ts:43-47`) — the exact B-50 bug, unfixed on this path.
- Cost: full snapshot (all libsignal sessions, SQLCipher walk + keychain hit + AES-GCM + full HTTP POST) ~15×/min indefinitely — battery/data drain; and **ratchet snapshots stop advancing entirely** → next restore replays a stale ratchet → undecryptable inbound (silent, surfaces only after a future restore).

---

## 7. Bugs filed (details + summary rows appended to `sqa.md`)

| Bug      | Title                                                                                                                                                                                                                                                                                                                      | Sev           | Layer                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------- |
| **B-62** | Notification-driven answer never sends `call.answer` (accept dies pre-answer, no `'connecting'` watchdog) → caller rings out, callee marked missed despite answering                                                                                                                                                       | HIGH          | Client (call setup)        |
| **B-63** | Full-screen intent denied by Android 14+ and unhandled — no `canUseFullScreenIntent()` check, no Settings deep-link (formalizes open N-05); lock-screen ring is heads-up only                                                                                                                                              | HIGH          | Client (platform)          |
| **B-64** | Zombie call after failed answer: FGS notif 70242 unclearable, no End affordance when CallScreen unreachable (`FloatingCallOverlay` gated on `isMinimized`; FGS notif has no hang-up action)                                                                                                                                | HIGH          | Client (call UI/lifecycle) |
| **B-65** | Message notifications generic by default: preview default-OFF, killed-path 1:1 body generic, killed-path groups fully generic (`'New secure message'`)                                                                                                                                                                     | MED (product) | Client (notifications)     |
| **B-66** | Status-bar small icon is placeholder Material shield, not Bravo logo; no notification accent color                                                                                                                                                                                                                         | LOW-MED       | Assets/config              |
| **B-67** | Ratchet-snapshot upload `stale_seq` infinite 4 s retry — no adopt-self-heal (B-50 fix missing on upload path), debounce defeated on failure; snapshots frozen → restore-staleness risk + battery/data drain                                                                                                                | HIGH          | Client (backup)            |
| **B-68** | App process dies while holding the call FGS mid-video-call (`has died: fg +50 FGS`, 11:30:22) — took the live call down (next offer hit `peer_offline`); crash cause uncaptured (needs `-b crash` buffer)                                                                                                                  | HIGH          | Client (crash)             |
| **B-69** | Camera FGS type thrash during video (`FGS type change 192→128→192` within 1.4 s) — camera-type dropped/re-added mid-call; capture-stall/black-video risk (`CallScreen.tsx:1061-1074` FGS restart keyed on `isCameraOn`)                                                                                                    | MED           | Client (call FGS)          |
| **B-70** | `.CallForegroundService` FGS type omits `phoneCall` (`AndroidManifest.xml:142` = `microphone\|camera` only; CallKeep's service has `phoneCall\|microphone\|camera` at `:162`) — forfeits the Telecom while-in-use exemption; directly explains call 1's background mic denial and feeds the B-62 accept-failure hypothesis | HIGH          | Client (manifest/FGS)      |

**Retest verdicts on prior bugs:** B-53 **PASS** (killed-app wake + ring verified end-to-end) · B-57 **PARTIAL** (FSI flags + autoAccept shipped but ineffective: FSI denied by OS, answer chain fails downstream) · B-59/60/61 **NOT VERIFIABLE** this session (calls never connected; JS logs not captured) · B-58 not exercised.

## 8. Required capture + fix-side notes (for the dev handoff)

- **Definitive B-62 confirmation needs a JS-level capture.** This session's log was system-priority only. Next session run:
  `adb logcat -v time ReactNativeJS:V WebRTCModule:V GetUserMedia:V InCallManager:D *:W`
  and grep for the accept-path error around the Answer tap (`getUserMedia`/`accept failed`/`[WEBRTC]`). The `dtls-poll-hung` watchdog never fires here because the wedge is pre-DTLS.
- Fix loci already identified: `canUseFullScreenIntent()` native check + `ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT` deep-link in `NotificationReliabilityCard` (B-63); post-accept answer-ack/`'connecting'` watchdog → `end('failed')` (B-62); un-gate `FloatingCallOverlay` for any live non-CallScreen call + add Hang-up action to the FGS notification + `call.missed`/cancel teardown of a stuck controller (B-64); mirror `merkleCommit.ts:247-273` adopt-and-retry into `httpSnapshotTransport.ts` + fail-side debounce (B-67); brand vector + `default_notification_color` (B-66); preview default + group-name resolution + Settings toggle (B-65).
- **SQA role: no fixes applied.** All anchors above are file:line at `391590d`.
- **UPDATE (same day, PM):** the user subsequently requested fixes ("fix all"). B-62, B-63, B-64, B-65, B-66, B-67, B-69, B-70 are now IMPLEMENTED in the working tree (+12 tests) — see `docs/planning/BUILD_RUNBOOK.md` § "2026-07-10 (PM) — B-62..B-70 device-audit remediation" and the sqa.md session header. B-68 and the B-59/60/61 recurrence remain open pending the §8 capture. Line anchors in this document describe the PRE-fix code at `391590d`.

---

## 9. Addendum — second capture `bravo_call_fulltest_113449.txt` (11:27–11:36, same device/session)

A second, later capture in the repo root covers the _successful_ calls (§1 control cases) plus the video phase, and adds three findings:

1. **B-68 — process death while holding the call FGS.** `11:30:22.105 Process com.bravosecure.app (pid 31266) has died: fg +50 FGS` (`:2546`) + `Could not find appropriate running FGS for FGS stop` (`:2552`). This is a **crash-class death** (not a user "remove task" kill), ~115 s into the answered video call `b8985727` (Telecom `CommSess … duration=115` cleanup at `:2521`), with the front camera actively tearing down at the exact moment. It is **why the very next offer (`4f9b8972`, 05:30:28) hit `peer_offline`** — the call stack was gone. Matches the tester's "cannot cut the call" pattern if the death was triggered by the End attempt (B-36 was the same class on group calls). The capture lacks the crash buffer — next session add `adb logcat -b crash,main` (and pull Crashlytics for 05:30:22 UTC).
2. **B-69 — camera FGS type thrash.** `FGS type change for .CallForegroundService from 128 to 192` at 11:28:28.6 (`:560`), `192 → 128` at 11:29:34.8 (`:1355`), `128 → 192` at 11:29:36.2 (`:1592`) — the mic+camera FGS type is dropped and re-added within 1.4 s during the video phase (callee video enable ≈ 05:29:29 re-offer, server-confirmed). The FGS restart is keyed on `isCameraOn` with no debounce/foreground guard (`CallScreen.tsx:1061-1074`; native type change `CallForegroundService.kt:44-58`). A camera-typed-FGS drop mid-capture can stall the camera stream (black tile) — prime suspect if audio→video black video is reported; flagging as MED pending a visual repro.
3. **B-67 is chronic.** The `stale_seq` 4 s hammer resumed immediately in the **restarted** process (pid 32666, 42 more failure pairs, 11:32:04→11:36) — it survives restarts and will run indefinitely on this device until the seq desync is healed.

Caveat for report writers: the `"Foreground service started from background can not have … camera access"` lines in THIS capture (`:197`, `:11093`) belong to **WhatsApp** (`com.whatsapp/.messaging.service.GcmFGService`), not Bravo — do not cite them as Bravo evidence. (Bravo's own mic-denial line appears only in the first capture at 11:21:26, where it IS Bravo's `.CallForegroundService`.)

---

## 10. Addendum 2 — cross-check vs the tester's own report (`Bravoo_CALL_TEST_REPORT.html`, 11:38)

The tester also produced their own report (repo root, with a third capture `bravo_call_log_113328.txt`). A code-level cross-check of its claims against HEAD `391590d`:

1. **CONFIRMED + filed as B-70 — ongoing-call FGS omits `phoneCall`.** `AndroidManifest.xml:142` declares `.CallForegroundService` as `microphone|camera` only, while CallKeep's `VoiceConnectionService` correctly has `phoneCall|microphone|camera` (`:162`). `app.json:56` even lists `FOREGROUND_SERVICE_PHONE_CALL` and a self-managed Telecom account is registered. Without the `phoneCall` type the FGS forfeits the Telecom-call while-in-use exemption — which is exactly why call 1 logged Bravo's own `Foreground service started from background can not have … microphone access` (§1). This is the most probable enabler of the B-62 accept failure (mic capture dies pre-answer) and belongs in the same fix wave. Also note `CallForegroundService.kt:82-88`: on any `startForeground` throw the catch posts a **typeless** notification then `stopSelf()` — silently dropping the camera/mic-typed FGS (mechanism behind B-69's thrash consequences).
2. **CORRECTED — "ICE=connected isn't wired to the UI store" (tester's explanation for stuck "Answering…"/no timer) is outdated at HEAD.** The B-60/B-61 fix is present: `callController.ts:1382-1404` promotes to `'connected'` directly off the ICE event, decoupled from the DTLS poll, and `CallScreen.tsx:736-739/1941-1945` derives the label from it. If "Answering… with working audio" still reproduces on vc130 it is a **different** defect — most plausibly the duplicate-controller/accept race the code itself documents (`fcmBootstrap.ts:970-983`: double `call.answer` → caller stuck in `have-local-offer`), or ICE never reporting connected on that controller instance. **Unprovable from the current captures — no app-side JS/WebRTC logs were recorded (0 matches for `[WEBRTC]`/`dtls-poll` in `bravo_call_log_113328.txt`).** Use the §8 capture command; treat B-59/60/61 as **recurrence reported, unverified**.
3. **CORRECTED — the report's "FGS started from background can NOT have camera access" quote is a WhatsApp log line** (`bravo_call_fulltest_113449.txt:197/:11093`, `com.whatsapp/.messaging.service.GcmFGService`), not Bravo evidence (see §9 caveat). Bravo's demonstrated signature is type-thrash (B-69) + death-holding-FGS (B-68), plus the _first_ capture's genuine Bravo mic denial (B-70).
4. **CONFIRMED — status-bar icon**: matches B-66 (placeholder shield at HEAD; the "white blob" generation is pre-`73ad6f3`).
