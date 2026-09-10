# Call UI — WhatsApp Parity Plan (+ device-default ringtone)

**Status (2026-07-05):** P1 (device-default ringtone) IMPLEMENTED. G5 partially closed same day: CallScreen already had draggable PiP + tap-to-toggle chrome + auto-hide; added the missing **nearest-corner spring snap** (`webrtc/pipLayout.ts`). Both await APK build + on-device matrix. P2–P4 remain design-blocked (parity = WhatsApp smoothness on the Bravo obsidian theme, per §6). Originally written after the B-48 notification fix session.
**Requested by:** Ranak — "all the calling UI, everything should be WhatsApp, and the ringtone will be the mobile default ringtone."
**Scope:** Android first (iOS calling is PushKit/CallKit-gated and not yet wired). 1:1 voice/video, group calls, incoming-call surfaces, ringtone/vibration.

---

## 1. Why a plan doc first

The incoming-ring path is the most hardening-dense code in the app. It carries fixes for B-21 (killed-app ring), PUSH-B5 (45 s ring auto-timeout + missed-call notif), PUSH-B6 (group decline over `sfu.ring.decline`), P1-N2 (no caller identity in the FCM payload), the notifee/Telecom double-ring dedupe (`markAccepted`), and the B-48 token-lifecycle fixes. A UI rewrite that ignores any of these regresses a shipped bug fix. Every phase below names the invariants it must preserve.

---

## 2. Current state (accurate as of `main` @ 12ef110)

### Ring pipeline (killed/backgrounded app)

1. Server `sendVoipWake` → data-only high-priority FCM `{kind:'voip-wake', callId, nonce, exp, sig}` — **deliberately no caller name / kind / conversationId** (P1-N2 privacy).
2. Bundle-entry `setBackgroundMessageHandler` → HMAC verify (`voipWakeVerify`) → cache payload → **two ringers in parallel**:
   - **notifee** full-screen notification (`callNotification.showIncomingCallNotif`) — channel `bravo-incoming-call`, `category: CALL`, `fullScreenAction` (lock-screen wake), Accept/Decline actions, `loopSound: true`, `timeoutAfter: 45_000`, colorized `#1E88FF`.
   - **Telecom** (`callKitBridge.reportIncomingCall`) — **`selfManaged: true`** ConnectionService; shows system call UI, handles BT-headset routing; de-duped by callId.
3. Caller name/kind arrive later via the WS `call.offer` frame; ring UI shows "Bravo contact" until then.

### The ringtone today — and why it's not the phone ringtone

`ensureIncomingCallChannel` sets `sound: 'default'` on the channel. On Android that resolves to the **default _notification_ sound** (`DEFAULT_NOTIFICATION_URI` — the short chime), _not_ `RingtoneManager.TYPE_RINGTONE`. `loopSound: true` then loops that chime. The in-code comment claiming "OS-default ringtone" is wrong. Additionally, because our Telecom integration is **self-managed**, Android does _not_ play any system ringtone for us — self-managed apps own their own ring audio (this is also true for WhatsApp; WhatsApp _plays the user's default ringtone itself_).

### In-call surfaces today

| Surface                      | File                                      | State                                                                                            |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1:1 voice/video              | `CallScreen.tsx` (~3000 lines)            | Functional: pulse rings, reconnecting overlay, audio→video upgrade, FG service, minimize-to-pill |
| Group call                   | `GroupCallScreen.tsx`                     | Functional: tile grid (B-17/B-19 render fixes), FrameCryptor gating                              |
| Incoming group ring (in-app) | `IncomingGroupCallScreen.tsx`             | Functional ring UI                                                                               |
| Minimized call               | `FloatingCallOverlay.tsx`                 | Pill overlay ("On call / Calling… / Ringing…")                                                   |
| Call history                 | `CallsLogScreen.tsx`                      | Local-only call log (known limitation)                                                           |
| Incoming 1:1 (in-app)        | inside `CallScreen.tsx` (isIncoming mode) | No dedicated full-screen ring screen                                                             |

Design system: obsidian `#07090D` / cobalt `#5B8DEF` (see `design_system_master` — call notification color `#1E88FF` currently deviates).

---

## 3. Gap analysis vs WhatsApp

| #   | WhatsApp behavior                                                                                                | Bravo today                                                                                       | Gap size                     |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------- |
| G1  | Incoming ring plays the **user's phone ringtone**, looping, with call-style vibration                            | Looped default _notification chime_                                                               | **Small — highest value**    |
| G2  | Full-screen incoming UI: avatar hero, caller name, swipe/tap Answer-Decline, works on lock screen                | notifee card + system Telecom UI; app opens to CallScreen; name is "Bravo contact" until WS frame | Medium                       |
| G3  | Caller name+photo visible instantly on the ring                                                                  | Generic until WS `call.offer` lands (P1-N2 privacy — deliberate)                                  | **Decision needed** (see §5) |
| G4  | 1:1 voice in-call: minimal dark screen, centered avatar, status line, bottom button row (speaker/video/mute/end) | Similar but Bravo-styled with pulse rings; layout differs                                         | Medium (pure UI)             |
| G5  | 1:1 video: draggable PiP self-view, tap-to-hide controls, swap tiles on tap                                      | Static self-view, controls always on                                                              | Medium (pure UI)             |
| G6  | Group call: grid + "X joined" toasts + ringing-participants strip                                                | Grid exists; no join toasts/ringing strip                                                         | Medium                       |
| G7  | Ongoing-call notification with hang-up action + tap-to-return                                                    | FG service notification exists (mic/camera type), pill overlay in-app                             | Small                        |
| G8  | Missed-call entry in call log + notification                                                                     | Missed-call notification exists (PUSH-B5); log is local-only                                      | Small                        |
| G9  | Ring stops instantly everywhere when answered/declined on any surface                                            | Works (dedupe by callId) — must not regress                                                       | — (invariant)                |

---

## 4. G1 — Device-default ringtone (do this first)

### Options

- **Option A (RECOMMENDED): app-played real ringtone, silent channel.**
  Small native Kotlin module (`BravoRingtoneModule`, ~50 lines):
  `RingtoneManager.getActualDefaultRingtoneUri(context, TYPE_RINGTONE)` → `Ringtone`/`MediaPlayer` with `AudioAttributes USAGE_NOTIFICATION_RINGTONE`, `isLooping = true`, respect ringer mode (silent/vibrate ⇒ don't play), `start()` / `stop()` methods exposed to JS. Called from `showIncomingCallNotif` (start) and `dismissCallNotif` / timeout / accept / decline / `reportEnded` (stop). Works from headless JS (native modules are available in the headless context).
  Channel change: channels are **immutable after creation** ⇒ new channel `bravo-incoming-call-v2` with `sound: null` (silent) + keep vibration pattern; notifications move to the v2 channel; old channel deleted at bootstrap (`notifee.deleteChannel`).
  ✅ Always tracks the user's _current_ ringtone choice. ✅ Zero payload/protocol change. ✅ WhatsApp-identical behavior.
  ⚠️ Must guarantee stop() on every exit path (answer, decline, remote hangup, 45 s timeout, app-killed-mid-ring → `timeoutAfter` still dismisses the notif; tie stop() to notifee's `onTrimMemory`-independent DELIVERED/DISMISSED events + a hard 45 s JS timer as belt-and-braces).
- **Option B: bake a ringtone URI into the channel `sound`.** Rejected — channel sound is frozen at creation; if the user later changes their phone ringtone, we keep playing the old one (not WhatsApp parity), and `content://` URIs on channels need a grantable permission on some OEMs.
- **Option C: flip Telecom to managed (`selfManaged: false`) so the OS rings.** Rejected — managed connections hand audio focus/routing to the OS dialer model, conflicts with our WebRTC audio session ownership, and regresses the B-21/B-36-adjacent call lifecycle. Self-managed is also what WhatsApp uses.

### Invariants (must not regress)

- PUSH-B5: ring stops at **45 s** and a missed-call notification posts.
- Dedupe: one ring per callId across notifee + Telecom (`markAccepted`, `bravo-call-${callId}` id).
- Killed-app path: everything callable from headless JS, no messenger-runtime boot.
- Ringer mode/DND respected (today the channel does this for us; with app-played audio WE must check `AudioManager.ringerMode` + DND filter).

### Test plan (device, Mac session)

Ring on: killed app, backgrounded app, foreground app, locked device. Change phone ringtone in OS settings → next ring uses the new one. Silent + vibrate-only modes → no sound, vibration only. Answer / decline / remote-hangup / let-it-timeout → sound stops in every case (grep logcat for a `[bravo.ring] stop reason=` line to be added). Regression: PUSH-B5 timeout, group decline (PUSH-B6), missed-call notif.

**Estimated size:** 1 native module + ~60 client lines + channel-v2 migration. One APK cycle.

---

## 5. G3 — Caller identity on the ring (DECISION REQUIRED before UI work)

WhatsApp shows the caller's name/photo the instant the phone rings because the name is in (or resolvable from) the push. Bravo deliberately strips identity from the FCM payload (**audit P1-N2** — Google's FCM infrastructure must not learn who calls whom); the name appears only after the WS `call.offer` frame lands (usually 1–3 s after ring start on a killed app).

Options:

1. **Keep P1-N2 (recommended, Signal-grade):** ring starts generic, name pops in when the WS frame lands. UI should be designed to make this graceful (avatar placeholder → crossfade to real name).
2. **WhatsApp-parity identity in push:** put `callerName`/`fromUserId` back into the FCM payload. This is a **stop-condition change** (sealed-sender/metadata surface) — needs System Architecture Documentation sign-off before any code. Not recommended.

**DECIDED (Ranak, 2026-07-05): option 2 approved — IMPLEMENTED same day.** Shape chosen: the wake carries the **pseudonymous sender UUID + callKind only** (never a cleartext name — FCM sees a UUID); the recipient's device resolves the local contact name for the ring label. Fields ride **unsigned** so the HMAC canonical form is unchanged (old APKs keep verifying); they are display-only — ring admission stays HMAC-gated. Server live on Contabo staging; client label resolution in next APK. P2–P4 note: screens stay as-is (Ranak 2026-07-05) — a padding/professional-polish pass replaces the redesign.

---

## 6. G2/G4/G5/G6 — WhatsApp-style screens (design-first)

**Parity definition (Ranak, 2026-07-05): "the UI should follow our main theme but should be smooth as WhatsApp."** So: visual language stays 100% Bravo obsidian design system (`#07090D`/`#5B8DEF` tokens — fix the `#1E88FF` notification deviation while at it); what we copy from WhatsApp is the _feel_ — instant screen transitions, 60fps spring animations, draggable PiP with fling physics, tap-to-hide controls with smooth fades, zero-jank ring→answer→in-call handoff, and layout ergonomics (button placement, one-hand reach). Not their colors, not their branding.

Per the screen-first workflow, these need designs before implementation:

1. **IncomingCallScreen (new, dedicated)** — full-screen: avatar hero, caller name (placeholder-crossfade per §5), call-kind label, Answer/Decline (tap; swipe optional), E2EE badge line. Launched by the existing `fullScreenAction` instead of generic MainActivity routing.
2. **CallScreen voice layout** — centered avatar, timer/status under name, bottom row: speaker · video-upgrade · mute · end. Keep: reconnecting overlay, FG service, minimize-to-pill.
3. **CallScreen video layout** — full-bleed remote, **draggable** PiP self-view, tap-to-toggle control fade, tile swap on PiP tap. Keep: B-16/B-20 camera lifecycle, audio→video renegotiation.
4. **GroupCallScreen** — grid (keep B-17/B-19 render architecture untouched — layout skin only), "ringing…" participant strip, join/leave toasts.
5. **Ongoing-call notification** — add Hang up action + tap-to-return (G7).

**Rule for implementation:** skin/layout changes only in these passes — no changes to `useCall` / `useGroupCall` state machines, dispatcher, or FrameCryptor gating. Any behavioral change (e.g. swipe-answer) goes through its own tested PR.

---

## 7. Phasing & gates

| Phase | Content                                  | Ships as                   | Gates                                                                                             |
| ----- | ---------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------- |
| P1    | G1 ringtone (Option A) + channel v2      | next APK                   | native module unit-testable surface + on-device matrix (§4); messenger-crypto suite; tsc baseline |
| P2    | IncomingCallScreen + §5 decision         | APK after designs approved | design sign-off; killed/locked-device manual matrix; B-21/PUSH-B5/B6 regression                   |
| P3    | CallScreen voice+video reskin            | APK                        | golden path + error paths (deny cam/mic, bg/fg, reconnect); B-24/B-25 regression                  |
| P4    | Group call reskin + toasts               | APK                        | 3-device BlueStacks session; B-17/B-19 non-regression                                             |
| P5    | G7/G8 polish (ongoing-notif action, log) | rides along                | smoke                                                                                             |

Dependencies: P2–P4 blocked on **screen designs from Ranak**; P1 is unblocked now. §5 decision blocks P2's final copy but not its layout.

## 8. Explicit non-goals

- iOS CallKit/PushKit wiring (separate effort; CallKit gives the system ringtone for free once wired).
- Server/protocol changes of any kind (unless §5 option 2 is approved — currently not).
- Per-contact custom ringtones (post-parity nice-to-have; the native module makes it trivial later).
- Touching relay/ack/sealed-sender/ratchet code paths — this is a UI + local-audio effort only.
