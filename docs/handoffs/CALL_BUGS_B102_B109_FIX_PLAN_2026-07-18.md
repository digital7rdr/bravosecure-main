# B-102 … B-109 — Call-subsystem bug batch: root causes, fix directions, and per-bug fix loops

**Date:** 2026-07-18 · **Status:** ROOT-CAUSE ANALYSIS — NO code changed (founder ask: MD plan only, fixes in a later session)
**Source:** founder report (8 bugs, screenshots) · **Numbering:** continues sqa.md after B-101.
**Prior art that just landed (do not re-fix):** B-100/B-101 (commit `9ac5043`) — in-place WS `auth.refresh`, timer-free reconnect, NetInfo live-call guard, `groupCallRejoinHub`, group ICE wall-clock budget, camera pause on background. Server half is live on Contabo; client half rides the next APK. See `docs/audits/CALL_LIFECYCLE_CONTINUITY_AUDIT_2026-07-18.md`.

---

## Bug index

| #     | Symptom (founder wording, cleaned)                                                                        | Area                              | Severity |
| ----- | --------------------------------------------------------------------------------------------------------- | --------------------------------- | -------- |
| B-102 | Notification Accept opens the incoming-call screen instead of accepting; on-screen buttons then dead      | Android notif → call accept path  | P0       |
| B-103 | End-call screen flashes for ~2 s before the incoming accept/reject screen appears                         | Incoming-call mount/state race    | P1       |
| B-104 | Black hexagon/blob artifact renders below some call-control buttons (video toggle etc.)                   | CallScreen control styling        | P2       |
| B-105 | Remote video off → placeholder avatar shows MY initial ("A") instead of the peer's photo/initial          | CallScreen avatar identity        | P1       |
| B-106 | Audio→video upgrade creates a GROUP; call-groups must also never appear as chat threads (WhatsApp parity) | Call escalation + chat-list       | P0       |
| B-107 | Incoming calls must be blocked while a backup restore is in progress                                      | Restore gate on call entry points | P1       |
| B-108 | Network drop / network switch mid-call must show "Connecting…" (WhatsApp parity) and recover              | Reconnect UX                      | P1       |
| B-109 | iPhone locks screen → call dies (iPhone→Android reported; verify all direction combos)                    | iOS CallKit/background audio      | P0       |

---

## How to use this document (for the fix session)

1. Fix ONE bug at a time, in the order: B-109 → B-102 → B-106 → B-103 → B-105 → B-107 → B-108 → B-104 (P0s first; B-104 last because it is cosmetic).
2. After implementing a fix, DO NOT trust it. Run that bug's **Fix Loop** below to completion. Every loop ends with a device (or emulator) verification and a regression re-check — a loop is only "done" when its exit criteria all hold in the same run.
3. If a loop iteration fails, go back to the loop's **Diagnose** step — do not pile a second speculative change on top of the first.
4. After each bug's loop passes: run the batch-level gates (§ Loop-0) before starting the next bug, log the outcome in sqa.md, commit that bug alone (small, focused diff).
5. Security stop-conditions (CLAUDE.md) are flagged per-bug. Where flagged, verify against the System Architecture Documentation BEFORE writing code.

## Loop-0 — batch-level gate loop (run between bugs and once at the very end)

```
LOOP-0 (repeat until all green in ONE pass):
  1. npm run typecheck            → must stay ≤ 47 baseline (currently 46)
  2. npm run test:crypto          → messenger-crypto project green
  3. cd apps/messenger-service && npm test   (only if server touched)
  4. npm run lint on touched files
  5. Local APK build + install via ADB (LOOP.md: never assume cloud builds)
  6. Boot smoke: send+receive a 1:1 message, then a 1:1 audio call connects
  IF any step red → fix → restart LOOP-0 from step 1.
```

---

## Cross-bug notes (read before starting any loop)

- **Shared hardening:** B-102 fix 3 and B-103 both need the null-controller-safe Accept/Decline — implement once, verify in both loops.
- **Restore module overlap:** B-106 (restore `'Call'`-row filter) and B-107 (restore-mode flag) both touch the backup module — BACKUP_LOOP applies to both; neither may change the write side or Merkle path.
- **B-106's literal trigger is refuted** — its loop starts with a repro-triage step; do not skip it, the fix emphasis depends on which hypothesis reproduces on the founder's device.
- **B-109 is the only bug needing hardware this environment doesn't have** (physical iPhone). Its loop can still run steps 1-3 (plugins/prebuild/static + Android regression) here; the device matrix must be executed by whoever holds the iPhone, and skipped rows must be recorded as skipped in sqa.md, never as passed.
- **Do not touch the 9ac5043 layer** (auth.refresh, timer-free reconnect, rejoin hub) while fixing B-108 — its fix is downstream of that layer (ICE state machine + NetInfo kicker on the media path).
- Every loop ends by updating sqa.md; every bug is its own commit (CLAUDE.md small-focused-diff rule).

---

## B-102 — Notification "Answer" re-shows the ring screen; on-screen Accept/Decline dead 🔴 P0

**Symptom:** incoming-call notification shows `❌ Decline` / `☎️ Answer` (`📹 Answer` for video). Tapping Answer opens the app but shows the Accept/Decline ring screen AGAIN (or hangs on "Answering…"), and at that point the on-screen buttons do nothing.

### Root cause (code-proven — two cooperating defects)

- **A1 · CONFIRMED — the two navigation sources clobber each other's params.** React Navigation 6 `navigate()` REPLACES params (no `merge:true` anywhere). The notifee Answer tap navigates CallScreen with `{autoAccept:true, incomingSdp:undefined}` (`fcmBootstrap.ts:1076-1092` — the notification data never contains the SDP: FCM voip-wake paths don't pass it, `callNotification.ts:364`); the WS offer handler navigates with `{incomingSdp:<sdp>}` and NO `autoAccept` (`MainNavigator.tsx:603-617`). Whichever lands second destroys the other's key field:
  - Killed-app answer (offer replay lands second) → `autoAccept` stripped → `isRinging` gate (`CallScreen.tsx:747`) true → **ring screen shows again after the user already answered**.
  - Warm-background answer (Answer tap lands second) → `incomingSdp` stripped → auto-accept effect bails at `if(!incomingSdpKey) return` (`CallScreen.tsx:762`) while `autoAccept` suppresses ring UI → **stuck "Answering…"**.
  - Note the asymmetry: the Telecom Answer path DOES hydrate the SDP from `incomingCallCache` (`fcmBootstrap.ts:500-568,:557`); the notifee path never consults the cache.
- **A2 · CONFIRMED — SDP-late boot bail is permanent → null controller → dead buttons.** `useCall` boot deps are `[peer.userId, callId, transport]` (`useCall.ts:947`) — `incomingSdp` is NOT a dep — but the boot guard returns on `incoming && !incomingSdp` (`useCall.ts:426-428`). On killed/Doze paths the effect runs before the offer replay, bails, and never re-runs. `controllerRef.current` stays null; Accept (`CallScreen.tsx:2551` → `useCall.ts:1052-1054`) and Decline (`CallScreen.tsx:1487-1494` → `:1055-1057`) are optional-chained silent no-ops. Decline is worse: it latches `hangupInFlightRef`+`tearingDown` with NO watchdog (unlike `endCall`'s 800 ms watchdog at `CallScreen.tsx:1481-1485`), so one dead tap swallows all subsequent taps.
- The notification Decline button itself is structurally sound (warm: live-transport hangup `fcmBootstrap.ts:977-992`; killed: HTTP decline + durable pending queue `callNotification.ts:544-561`, `fcmBootstrap.ts:68-136`). The founder's dead Decline is the ON-SCREEN one (A2).

### Files involved

`src/modules/messenger/push/fcmBootstrap.ts` (Answer tap :1054,1076-1092; cold-start :1109-1124; markAccepted dedupe :469-509) · `src/navigation/MainNavigator.tsx:603-617` · `src/screens/messenger/CallScreen.tsx:747,755-784,1487-1494,2536-2556` · `src/modules/messenger/webrtc/useCall.ts:426-428,947,1052-1057` · `src/modules/messenger/push/callNotification.ts:339-457` · `src/modules/messenger/push/incomingCallCache.ts`

### Fix direction (no code here)

1. **Stop the param clobber:** notifee Answer handler hydrates `incomingSdp` from `incomingCallCache` (mirror the Telecom path); MainNavigator's offer navigation preserves an already-latched accept by consulting the existing `acceptedCallIds` latch and passing `autoAccept:true` (latch is more deterministic than `merge:true`).
2. **Make the SDP bail a wait, not a tombstone:** include SDP presence in the `useCall` boot deps (or re-run boot on undefined→present). Safe vs CALL-N1: the adopt branch runs before the SDP guard (`useCall.ts:300-420`), so re-runs adopt instead of double-building.
3. **Never leave silent-dead ring buttons:** give ring-Accept the catch/retry/feedback the autoAccept effect has (B-62 pattern); give `declineCall` the same watchdog `endCall` has (pops the screen + clears latches on null controller).

⚠️ Security: the S7 rule stays intact — the offer must still pass `verifyCallOfferAuth` before any navigation/auto-accept (`callDispatcher.ts:223-241`). Fix lives in navigation/param plumbing, NEVER a verifier bypass.

### FIX LOOP B-102 (repeat until exit criteria hold in ONE pass)

```
LOOP B-102:
  1. IMPLEMENT fixes 1-3. Unit-test first where practical: param-merge outcome for both orderings
     (tap-then-offer, offer-then-tap) and the useCall re-boot on late SDP.
  2. STATIC: npm run test:crypto green · typecheck ≤ baseline · grep proves NO change to
     showIncomingCallNotif display or the voip-wake HMAC gate (B-53 must stay untouched).
  3. DEDUPE AUDIT: trace that Telecom-Answer + notifee-Answer + on-screen Accept on the same call
     still emit exactly ONE call.answer (markAccepted latch) — double-answer = have-local-offer wedge
     (fcmBootstrap.ts:1014-1022).
  4. DEVICE (2 devices/BlueStacks 5555+5556):
       a. WARM: B backgrounded, A calls, B taps Answer → direct to "Answering…"→connected;
          NO second ring screen; logcat shows ONE autoAccept + ONE call.answer.
       b. KILLED: B swiped away, A calls, tap Answer → cold launch → auto-answers on offer replay
          (allow ~20 s WS boot); no ring re-appearance, no dead buttons.
       c. KILLED, BODY TAP: ring screen appears with WORKING Accept; separate run: WORKING Decline
          (A stops ringing "declined", screen pops — even if controller is null).
       d. NOTIF DECLINE: warm → A stops immediately; killed → A stops on B's next app-open (queue drain).
  5. REGRESSION DEVICE: B foreground → ring screen direct, Accept works · video variant (📹 Answer) ·
     group-call Answer unaffected · minimize→restore during ring (CALL-N1 adopt) · B-58 tap-resume.
  6. ANY fail → diagnose with logcat ([bravo.call] lines), back to 1. NEVER "fix" by weakening S7.
  7. EXIT when 2-5 green in one run + sqa.md B-102 updated with evidence.
```

---

## B-103 — End-call-looking screen flashes before the incoming ring screen 🟠 P1

**Symptom:** when a call arrives (app foreground), a screen dominated by the red hangup button shows for ~2 s, then the Accept/Decline ring screen appears.

### Root cause (code-proven)

- **CONFIRMED — the "end-call screen" is the full IN-CALL tray rendering during the boot window, caused by direction being hard-coded `'outgoing'` until the TURN fetch resolves.** At first mount `iceServers` is null (async TURN fetch, `CallScreen.tsx:407-473`) so `callArgs` takes the fallback branch that hard-codes `direction:'outgoing'` (`CallScreen.tsx:500-506`). `useCall` seeds state once: `useState(direction==='incoming' ? 'ringing' : 'idle')` (`useCall.ts:147`) → starts `'idle'`; `isRinging` (`CallScreen.tsx:747`) is false → CallScreen renders the Mute/Speaker/Hold/Camera/Add tray + dominant red `phone-hangup` End button (`CallScreen.tsx:2423-2494`) with status "Answering…" — which reads as "the end-call screen". Window = TURN round-trip (+ possible token refresh) + controller boot = the observed couple of seconds. Then `handleIncomingOffer` sets 'ringing' (`callController.ts:487`) and the ring UI appears.
- **Corroborating side-effect:** the audio-session defer gate only holds while `state==='ringing'` (`CallScreen.tsx:888`) — state 'idle' bypasses it, so `InCallManager.start()` + FGS can start during the pre-ring window (`:906-930`) — the ringtone-through-earpiece class.
- Secondary HYPOTHESIS (low): a stale CallScreen instance on the stack showing 'ended' — rule out on device; no registry-terminal-state path was found in code.

### Files involved

`src/screens/messenger/CallScreen.tsx:484-513,747,866-930,2392-2401,2423-2556` · `src/modules/messenger/webrtc/useCall.ts:147,282,947`

### Fix direction (no code here)

Make the fallback `callArgs` branch pass the route-derived direction (`isIncoming ? 'incoming' : 'outgoing'`) so `useCall` seeds 'ringing' from the first frame (the demo-boot guard at `useCall.ts:282` already prevents signalling side effects); or equivalently treat `isIncoming && state==='idle'` as ringing for render purposes. An Accept tap in the pre-controller window must not be a silent no-op (disable-with-spinner or queue until controller lands — same null-controller hardening as B-102 fix 3). Do NOT touch outgoing 'idle' semantics (CALL-N15 ghost-redial guard + back-handler key off it).

### FIX LOOP B-103 (repeat until exit criteria hold in ONE pass)

```
LOOP B-103:
  1. IMPLEMENT the direction seed fix (+ null-safe Accept during boot window).
  2. STATIC: test:crypto + typecheck; confirm outgoing path unchanged (grep callArgs fallback usage).
  3. DEVICE: B foreground, A calls B → FIRST surface on B is Accept/Decline; NO tray/End-button flash;
     NO "Bravo Secure call" ongoing-notification flash pre-answer; ringtone on RINGER stream (not
     earpiece). Magnifier: throttle B's network so TURN fetch takes ~2 s — pre-fix this shows the
     End screen for the whole fetch; post-fix it must show ring UI.
  4. DEVICE: call A↔B, hang up, immediately call again → no "Ended" flash on the new ring
     (rules out the stale-instance variant — if it DOES appear, that variant is real: diagnose).
  5. REGRESSION: outgoing B→A shows "Calling…" immediately, End works during boot window ·
     video incoming no-flash · autoAccept (B-62) still suppresses ring UI · back-press-declines-ring
     (CALL-07) is null-safe in the boot window · no ringtone double-start (notifee vs in-app,
     keyed by callId).
  6. ANY fail → back to 1.
  7. EXIT when 3-5 green in one run + sqa.md B-103 updated.
```

---

## B-104 — Black hexagon/blob artifact under call-control buttons 🟡 P2

**Symptom (screenshot):** in a video call a dark hexagonal blob renders below/behind some control buttons (worst: the video toggle when camera is off).

### Root cause (code-proven)

- **CONFIRMED — Android `elevation` shadow on a button whose final background is translucent.** Tier-1 buttons render `[styles.ctrlToggle, active && styles.ctrlToggleActive, isOff && styles.ctrlCircleOff]` (`CallScreen.tsx:2278-2283`). `ctrlToggleActive` (`:2838-2841`) carries iOS-only `shadow*` props + `elevation:8` — on Android it reduces to a bare dark elevation shadow. The Video button is the only one with `active` AND `isOff` both true when camera is off (`:2255`), and `ctrlCircleOff` (`:2866`) overrides the background to 18%-alpha red **without resetting elevation** → the full native shadow shows through/under the translucent disc. Android tessellates round outlines into a low-poly hull → the "hexagon" look, spot-shadow biased downward → "below the button".
- Mute/Speaker/Blur in active state keep the opaque white fill → same unintended dark drop shadow, less glaring. Speaker is active by DEFAULT in every video call (`isSpeaker` init `isVideo`, `:653,966-967`) — so two elevated buttons in any video-call screenshot.
- **Full affected list:** Tier-1 Video (worst)/Mute/Speaker/Blur via shared `ctrlToggleActive`. Same class lower visibility: `ctrlTray:2825-2829` + `voiceTray:2958-2962` (elevation 18 on translucent glass → faint halo), `endPill:2849-2853`, `endBtnVoice:2994-3000`, `ringBtn:3011-3016`, `videoAvatar:2755-2760`, `voiceAvatar`, connected-dot `:2386-2391` (opaque — plain dark shadow, intent lost), GroupCallScreen `heroSpeaking:2608`. NOT affected: Flip/Add (`ctrlUtil`), voice-row circles, GroupCallScreen dock. Dead styles: `ctrlCircleVideo`, `ctrlCircleBlue`, `endBtnVideo`.

### Files involved

`src/screens/messenger/CallScreen.tsx` (styles 2825-2886, JSX 2246-2330) · `src/screens/messenger/GroupCallScreen.tsx:2608` (minor)

### Fix direction (no code here)

Remove `elevation` from `ctrlToggleActive` (one edit fixes all four buttons — the white-glow intent never renders on Android anyway); keep/gate iOS `shadow*` behind `Platform.select` or drop for consistency. Belt-and-braces: stamp `elevation:0` in `ctrlCircleOff`. If the tray halo is confirmed on device, same treatment for `ctrlTray`/`voiceTray`. Design-system note (G8): do not compensate with new palette colors.

### FIX LOOP B-104 (repeat until exit criteria hold in ONE pass)

```
LOOP B-104:
  1. IMPLEMENT the elevation removal (smallest diff — style objects only, do NOT reorder the style
     array or touch tearingDown branches).
  2. STATIC: typecheck + lint on CallScreen; visual grep for other `elevation` on translucent
     backgrounds in call screens (list is above — decide each deliberately, log the decision).
  3. DEVICE SWEEP (video call, 2 devices): at rest (Speaker active by default) → no dark shape;
     toggle Video OFF (the screenshot state) → no blob; toggle Mute/Blur on+off → check under each;
     Speaker with/without BT. Repeat in landscape + after minimize→restore.
  4. DEVICE: voice call row (already elevation-free) unchanged; group call dock + speaking-glow
     unchanged.
  5. iOS (when a build exists): active-state buttons still read "on" (solid white fill is the
     main signal) — else note as skipped in sqa.md.
  6. ANY new artifact → back to 1.
  7. EXIT when 3-4 green + screenshots attached to sqa.md B-104.
```

---

## B-105 — Camera-off avatar shows the wrong identity / never the profile photo 🟠 P1

**Symptom (screenshot):** friend turns their video off; the fallback avatar shows MY initial ("A" for Ariful) instead of the friend's photo/initial.

### Root cause (code-proven — two confirmed defects + one gap)

- **CONFIRMED — the local PiP camera-off fallback is hard-wired to the PEER's initials** (`CallScreen.tsx:2193-2211`, renders `{peerInitials}` at `:2201`, with a comment documenting it as deliberate). So on the device whose camera is OFF, a disc with the OTHER party's initial appears — if Ariful calls X and X turns camera off, X's screen shows "A". This is the reported artifact (attribution to the screenshot: medium-high).
- **CONFIRMED — the remote camera-off placeholder shows NO identity at all:** `resolveRemoteTile` returns `camera-off` (`remoteTileGate.ts:36`) and CallScreen renders a generic `account` icon (`:2063-2074`) — never the peer's photo or initial.
- **CONFIRMED — no profile-photo pipeline exists in the call UI at all.** Placeholders derive only from `convo?.name` → `peerInitials` (`CallScreen.tsx:130-132`); the conversation model has no avatar field (`store/types.ts:131-159`); `call.offer` carries no display name/avatar (`signallingClient.ts:207`); yet photos ARE fetchable (`usersClient.ts:23-27,88` `getProfilesByIds` → `{displayName, avatarUrl}`; own photo `authStore.ts:100` `user.avatar_url`).
- **Bonus CONFIRMED:** cold-contact incoming calls stamp the conversation name with a raw userId hex prefix (`MainNavigator.tsx:588` `name: data.from.userId.slice(0,8)`) → garbage initials for unknown callers.
- Negative finding: the remote area can never literally render the local user's initial — Facts 1+2 jointly explain the screenshot.

### Files involved

`src/screens/messenger/CallScreen.tsx:2063-2074,2193-2211` · `src/modules/messenger/webrtc/remoteTileGate.ts` (branch contents only — do NOT change gate decisions) · `src/navigation/MainNavigator.tsx:588` · `src/modules/messenger/store/types.ts` + `messengerStore.ts` (avatar field, photo parity phase) · `src/modules/messenger/transport/usersClient.ts` · `src/modules/messenger/runtime/callRegistry.ts` + `FloatingCallOverlay.tsx` (optional `peerAvatarUrl`)

### Fix direction (no code here — two phases)

**Phase 1 (the reported symptom, CallScreen-only):** (a) PiP fallback → OWN identity (auth-store user initials — screen already subscribes, `:661-666`; fix the misleading comment too); (b) remote `camera-off` branch → peer initials disc (reuse the sibling 'avatar' branch pattern `:2083-2084`).
**Phase 2 (photo parity, contained):** add peer `avatarUrl` to the conversation record (populated by the existing contact-discovery sweep / `getProfilesByIds`), render Image-with-initials-fallback in call placeholders; own photo from `user.avatar_url`; optionally `peerAvatarUrl` on `ActiveCall` for the overlay; fetch profile on cold-contact offer so the ring screen shows a real name (fixes the hex-prefix too).
Watch: BS-CALL-ADHOC group-escalation ring deliberately uses `ownDisplayName` (`:663-666`) — do not "fix" it; preserve `tearingDown` constant-keyed returns (B-37 crash class); `is_custom_name` must keep winning over sweep upserts.

### FIX LOOP B-105 (repeat until exit criteria hold in ONE pass)

```
LOOP B-105:
  1. IMPLEMENT Phase 1 only. STATIC: test:crypto + typecheck + remoteTileGate unit tests untouched.
  2. DEVICE (A="Ariful", B=distinct name + profile photo set):
       a. A→B video; B toggles camera OFF → B's PiP shows B's OWN identity (pre-fix: "A").
       b. Same moment on A: remote area shows B's identity + "Camera off" (pre-fix: grey icon).
       c. Reverse roles and re-check both surfaces.
  3. REGRESSION DEVICE: voice call avatars still show the OTHER party each side · upgrade-declined
     path shows peer avatar · group tiles per-member identity (GroupCallScreen:1635) unchanged ·
     minimize→restore overlay name correct · landscape + background/relock re-render.
  4. ANY fail → back to 1.
  5. EXIT Phase 1 when 2-3 green + sqa.md updated. THEN Phase 2 as a separate commit, re-running
     this loop plus: photo renders on both placeholders when set; initials fallback when not;
     cold-contact call shows fetched real name (no hex); is_custom_name rename survives a sweep.
```

---

## B-106 — Audio→video upgrade "created a group" + call-groups must never appear as chat threads 🔴 P0

**Symptom:** during a 1:1 audio call, pressing the video button appeared to create a group; also, call-groups must never show as a group chat thread in the chat list (WhatsApp parity: a 3-person call shows in CALL history only).

### Root cause (code-proven — the literal report is REFUTED; three real mechanisms found)

- **REFUTED — the video toggle CANNOT create a group on the current tree.** The camera button (`CallScreen.tsx:2474` audio row / `:2255` video layout) → `toggleVideo`/`upgradeToVideo` (`useCall.ts:1133-1135,1235-1400` → `callController.ts:598-816`) is pure addTrack/reoffer renegotiation on the existing PeerConnection. Zero references to GroupCallScreen/SFU/escalation in `useCall.ts`/`callController.ts`; all four `GroupCallScreen` navigation sites enumerated — none hangs off the video toggle.
- **H1 (most likely trigger) — the "Add" flow fired:** "Add" (`account-plus`) sits in the slot IMMEDIATELY NEXT TO the Camera button in the same 5-button tray (`CallScreen.tsx:2474` vs `:2475`). Add → picker (`:1861-1905`) → `escalateToGroupCall` (`:1510-1544`) hangs up the 1:1 leg and replaces the screen with a group/SFU call. (Two-tap flow — requires picking a contact.)
- **H2 — the "1:1 audio call" was actually a 2-person SFU call:** any call launched from a group-classified conversation (`launchCall.ts:101-107,205-250`) boots GroupCallScreen, and the host mints a persistent Signal group named `'Call'` AT JOIN TIME (`useGroupCall.ts:1488-1499` → `productionRuntime.ts:4221,4311-4318`) — a mid-call video press is temporally coincidental.
- **H3 (explains "a group appeared in my chat list") — ghost-row resurrection:** the BS-CALL-GHOST suppression (`productionRuntime.ts:6917-6931`, name-sentinel `'Call'`) only guards NEW upserts. Holes: (a) `upsertKeylessGroupPlaceholder` (`groupConversationUpsert.ts:62-79`) and `appendMessage`'s group shadow-create (`messengerStore.ts:626-648`) create a visible thread for any group-tagged envelope racing its create — neither knows the sentinel; (b) **backup restore re-upserts every mirrored conversation with no `'Call'` filter** (`restoreMessages.ts:239-256`); (c) no cleanup exists for pre-existing ghost rows, and the home-screen prune only removes UUID-shaped ids while ad-hoc groupIds are salt-derived hashes (`MessengerHomeScreen.tsx:218-224`, `groupClient.ts:576-577`).
- **Confirmed hygiene defect:** each escalation mints a FRESH persistent `'Call'` group and never cleans up — the resync branch keys off `groups[direct:<peer>]` (`productionRuntime.ts:4243-4244`) but the mint files under the minted id (`:4337-4338`), so re-escalations never match and accumulate in `s.groups` + SQLCipher `group_master_keys` (`messengerStore.ts:974-982`).
- **Call history today:** a 3-person call DOES reach the Calls tab (`selectCallMessages` walks thread-less slots, `messengerStore.ts:1328-1342`; bubbles written at `useGroupCall.ts:4103-4113,4219-4266`). Parity gaps: `call_meta` has no participants list (log can't render "A, B, C"; joiner rows show truncated-id names, `CallsLogScreen.tsx:94`), and joiner bubbles land under `direct:<peer-as-seen-by-host>` (`CallScreen.tsx:1526`) — invisible slot on the peer's own device, mis-attributed thread-bump on the 3rd device.

### Files involved

`src/screens/messenger/CallScreen.tsx` (tray layout/UX disambiguation) · `src/modules/messenger/runtime/productionRuntime.ts:4221-4380,6864-6931` · `src/modules/messenger/runtime/groupConversationUpsert.ts:26,62-79` · `src/modules/messenger/store/messengerStore.ts:540-648,974-982,1328-1342` · `src/modules/messenger/backup/restoreMessages.ts:239-256` · `src/screens/messenger/{MessengerHomeScreen,CallsLogScreen,IncomingGroupCallScreen}.tsx` · tests: `adhocCallKeyLookup.test.ts:313-345`, `groupConversationUpsert.test.ts`

### Fix direction (no code here)

1. **UX disambiguation (address the founder's actual experience):** the Camera and Add buttons are adjacent and escalation silently drops the 1:1 leg — add a confirm step on Add-picker selection ("Start a group call with X?") and/or separate the buttons; log `[add-call]` breadcrumbs to make future triage instant.
2. **Close the chat-list holes with the EXISTING `'Call'` name-sentinel** (do NOT add a `kind` field to the signed group-create — that touches the security-gated envelope shape): guard `upsertKeylessGroupPlaceholder` + `appendMessage` shadow-create when `groups[gid]?.name === 'Call'` (never bump order/unread); skip `'Call'` rows in the restore conversation loop; one-time hygiene sweep at store hydration removing conversation rows whose id maps to an exact-name `'Call'` group (exact match ONLY — `adhocCallKeyLookup.test.ts:328-329` pins that a user-named "Call + x" group stays visible).
3. **Escalation hygiene:** fix the resync-key mismatch so re-escalating the same 1:1 reuses the already-minted call group instead of minting again (key lookup only — NO change to key distribution/rekey semantics; a long-lived per-pair call group would be arch-gated, avoid).
4. **Call-history parity (separate commit):** stamp participant userIds+names into `call_meta` at write time; write joiner bubbles under `direct:<hostUserId>` (host id already on the ring payload).

⚠️ Security: all recommended directions touch no key distribution, no signed payload shape, no verifier. The rejected variant (signed `kind` field) is flagged — do not implement without architecture approval.

### FIX LOOP B-106 (repeat until exit criteria hold in ONE pass)

```
LOOP B-106:
  1. FIRST, on-device REPRO TRIAGE (before any code): A↔B audio call → press ONLY the Camera
     button → confirm it stays 1:1 (expected per code). Then check the founder's device history:
     was the original call launched from a group-classified convo (H2)? Are there pre-existing
     'Call' ghost rows (H3)? Record which hypothesis reproduces — the fix emphasis depends on it.
  2. IMPLEMENT fixes 2+3 (sentinel guards + restore filter + hygiene sweep + resync-key fix),
     then fix 1 (UX). Unit tests first: sentinel-guarded writers (exact-match pinned),
     restore skips 'Call' rows, hydration sweep removes ghosts but NOT "Call + x".
  3. STATIC: adhocCallKeyLookup + groupConversationUpsert + backup/merkle suites green (restore
     file touched → BACKUP_LOOP §2 invariants check: read-side filter only, NO write-side change);
     test:crypto; typecheck ≤ baseline.
  4. DEVICE (3 devices A/B/C):
       a. A↔B audio → Camera tap → stays 1:1, video works both ways, NO new thread, logcat shows
          upgradeToVideo and zero [add-call] lines.
       b. A↔B audio → Add → confirm dialog → pick C → 3-way call connects; B's leg transitions;
          NO 'Call'/'Group chat' thread on A/B/C chat lists; Calls tab shows a Group row on each.
       c. Restore probe: back up on A, wipe, restore → no 'Call' thread resurrects; named groups
          + Ops Room threads DO appear (regression).
       d. Accumulation probe: escalate twice on the same pair → group_master_keys count grows by
          ≤1 total (resync reuses), not +1 per escalation.
  5. REGRESSION: mission Ops Rooms + named groups still visible in chat list (createGroupChat
     :3489, makeAssignedGroup :3653-3673) · real-group call key slots (B-10/B-13/B-15) untouched ·
     first-contact DM shadow-create still works · P2-BR-7 upgrade FGS re-arm unaffected.
  6. ANY fail → back to 2 (or back to 1 if the repro contradicts the hypothesis ranking).
  7. EXIT when 3-5 green in one run + sqa.md updated (note the REFUTED literal report + which
     hypothesis reproduced). Call-history parity (fix 4) = separate commit, own mini-loop:
     3-way call → each device's Calls tab shows all participants' names, no wrong-thread bump.
```

---

## B-107 — Incoming calls must be blocked while a backup restore is in progress 🟠 P1

**Symptom:** while a user is restoring their messages, incoming calls still ring and the CallScreen mounts on top of the restore screen. During restore no call should be received (WhatsApp parity: caller gets busy).

### Root cause (code-proven)

- **CONFIRMED — no restore-mode flag is observable outside the restore screen, and no call entry point checks anything restore-related.** Restore state is component-local (`busy`/`overlay`, `src/screens/messenger/BackupRestoreScreen.tsx:70,83`); the only durable markers are AsyncStorage resume keys (`src/modules/messenger/backup/restoreResume.ts:34,40,94-140`) that nothing on the call path reads; the only module-level flag is `deferBundlePublish` (`productionRuntime.ts:194-197`), which covers only bundle publish. Grep for `restoreInProgress|isRestoring`: zero hits.
- **CONFIRMED — the WS is fully live during active restore, so every ring surface fires:** `handleRestore` boots the runtime as step 1 (`BackupRestoreScreen.tsx:253` → `transport.connect()` at `productionRuntime.ts:1249`); an inbound `call.offer` flows `handleServerFrame` → `dispatchCallFrame` (`productionRuntime.ts:4948-4950`) → `callDispatcher.ts:213-241` → the global incoming handler (`src/navigation/MainNavigator.tsx:491-618`) which does Telecom `reportIncomingCall` (`:522-526`) and navigates CallScreen over the restore screen (`:603-617`). Group rings ditto (`MainNavigator.tsx:675-679`).
- **Hazards if answered mid-restore** (no decrypt-crash risk — `call.offer` SDP is sender-cert-verified plaintext, `protocol.ts:443-450`): `handleRestore` disposes/rebuilds the runtime mid-flow (`BackupRestoreScreen.tsx:288-301`) which would strand a live call's signalling (B-64 zombie class); an answer would be cert-signed by the throwaway identity restore is about to overwrite.
- **The busy signal already exists:** `call.hangup{reason:'busy'}` is in the protocol (`protocol.ts:215-218,466-469`) and MainNavigator already auto-busies during a group call (`:552`) and on a second 1:1 (`:574`); the caller's ring stops immediately (`callController.ts:330-341`).
- **⚠️ Adjacent P1 finding (log separately at fix time):** a foreground FCM `msg-wake` during the pre-password RESTORE gate boots the runtime (`fcmBootstrap.ts:285-291`) → fresh identity + bundle publish → server rotation detector wipes the OPK pool AND permanently disarms the RESTORE gate (`backupBoot.ts:123-131`). Data-loss class, independent of calls — the same restore-mode flag should no-op these boot sites.

### Files involved

`src/modules/messenger/runtime/productionRuntime.ts` (flag home, next to `deferBundlePublish`) · `src/screens/messenger/BackupRestoreScreen.tsx` (set/clear points) · `src/navigation/MainNavigator.tsx:491-618,675+` (1:1 + group gates) · `src/modules/messenger/push/fcmBootstrap.ts:1277+` (background CALL branch gate; `:285-291` boot landmine) · `src/modules/messenger/backup/backupBoot.ts` (RESTORE-RESUME re-arm)

### Fix direction (no code here)

Add a **module-level in-memory "restore mode" flag with a sync getter** (in-memory on purpose: process restart implicitly clears it; a stuck flag = permanently unreachable user, so clear in `finally` + unmount + wipe). Gate exactly three consumers: (1) `setIncomingCallHandler` first line — if restoring, send `call.hangup{reason:'busy'}` (copy the `MainNavigator.tsx:574` pattern) and return: caller stops ringing, callee never rings; (2) group ring `onIncoming` — decline/ignore; (3) FCM background CALL branch — skip notifee/Telecom ring (same JS VM when app alive; a truly-killed VM can't coincide with an in-progress restore). Do NOT queue offers for later (SDP/ICE would be stale). Rider: no-op the push-layer runtime-boot sites while the RESTORE gate is held (closes the OPK-wipe landmine).

**Security stop-conditions:** none crossed if scoped as above — do not touch `verifyCallOfferAuth` ordering or S7, no server change, no restore write-side/Merkle change (BACKUP_LOOP §2 invariants untouched — the flag only reads restore progress).

### FIX LOOP B-107 (repeat until exit criteria hold in ONE pass)

```
LOOP B-107:
  1. IMPLEMENT flag + 3 gates (+ boot-site rider). Write the failing test FIRST where practical:
     unit test that the incoming handler busies-out when the flag is up, rings when down.
  2. STATIC: npm run test:crypto green; npm run typecheck ≤ baseline; grep proves the flag is
     cleared on EVERY exit path of handleRestore (success/failure/repair-retry/unmount/wipe).
  3. BACKUP REGRESSION (module is under BACKUP_LOOP): run the backup/merkle Jest suites; confirm
     no write-side change; restore round-trip on device still converges (§5 SQL probes).
  4. DEVICE: A restoring (mid "Restoring messages…"), B calls A →
       - B's ring ends ~immediately (busy), A NEVER rings, no CallScreen over restore, restore completes.
       - Repeat with a GROUP call including A → A silent.
       - Kill A mid-restore, relaunch (resume marker) → gate re-arms during resumed restore.
  5. REGRESSION DEVICE: after restore completes → B calls A → NORMAL ring. Non-restore killed-app
     ring still works (B-53 matrix row). Second-call busy + in-group-call busy still work
     (MainNavigator :541-578 untouched).
  6. IF any step fails → diagnose (is the flag stuck? gate too broad?) → back to 1. Do NOT widen
     the gate to fix a symptom.
  7. EXIT when 2-5 green in one run + sqa.md updated (incl. the adjacent OPK-wipe finding logged).
```

---

## B-108 — Network drop / switch mid-call must show "Connecting…" and recover (WhatsApp parity) 🟠 P1

**Symptom:** when the network dies or switches mid-call, the user should see "Connecting…" and the call should recover; today it often shows frozen media then "Call failed".

### Root cause (code-proven)

- **The reconnecting UI ALREADY EXISTS on both screens** — 1:1 `ReconnectingOverlay` on `state==='reconnecting'` (`CallScreen.tsx:2602-2608,2663-2705`), group `GroupReconnectingOverlay` (`GroupCallScreen.tsx:2271-2276`), bubble shows "Connecting…" (`FloatingCallOverlay.tsx:134,261`). The gap is the state machine rarely stays in `'reconnecting'` on a real switch.
- **CONFIRMED (the founder-visible bug) — ICE `'failed'` is an unconditional instant kill, even mid-recovery.** 1:1: `'disconnected'` correctly enters `'reconnecting'` + 30 s budget + ICE-restart retries (`callController.ts:1463-1469,1031-1053,1129-1152`), **but `onIceFailed` → `end('failed')` unconditionally (`callController.ts:1470-1471` → `:1008-1016`)**. On an Android Wi-Fi→mobile switch all candidate pairs can fail before the restart reoffer round-trips (WS is down at the same instant) → "Call failed" instead of "Connecting… → recovered". Group: same class — `txState==='failed'` → instant `setState('failed')` (`useGroupCall.ts:1960-1963`), cutting off the in-flight `restartIce` retry loop (`:1813-1872`).
- **CONFIRMED — zero proactive network-switch detection on the media path:** no NetInfo usage anywhere in `src/modules/messenger/webrtc`; the only listener is transport-level (`productionRuntime.ts:1263-1289`). Between OS switch and the ICE agent noticing, the screen shows "On call" with frozen media.
- **HYPOTHESIS (medium) — callee cannot drive 1:1 recovery:** only the offerer fires ICE restart (`callController.ts:1040-1052,1466-1468`).
- 9ac5043 already fixed the transport layer (timer-free reconnect, rejoin hub, wall-clock budgets) — do NOT redo it.

### Files involved

`src/modules/messenger/webrtc/callController.ts:1008-1016,1428-1473,1129-1206` · `src/modules/messenger/webrtc/useGroupCall.ts:1915-1964,1813-1872,1736-1793` · `src/screens/messenger/CallScreen.tsx`, `GroupCallScreen.tsx`, `FloatingCallOverlay.tsx` (UI polish only) · `productionRuntime.ts:1263-1289` (pattern to mirror)

### Fix direction (no code here)

1. **Stop treating mid-call ICE `'failed'` as terminal.** 1:1: in `onIceFailed`, when the call has previously connected (or is `'reconnecting'`), route into the existing reconnect machinery (enter/stay `'reconnecting'`, ensure the wall-clock budget is armed, force a fresh restart offer by resetting the in-flight gate) — **budget expiry stays the only terminal authority**; keep instant-fail for the never-connected initial-connect case (B-41 class must still fail fast). Group: on `'failed'` keep the budget + retry loop running; remove only the instant `setState('failed')`.
2. **Early detection:** one NetInfo transition listener active only while a call is live (registries expose this) that flips to `'reconnecting'` and kicks the restart immediately. Judge liveness by inbound-signal recency (the 9ac5043 caution), not probe timers; a false 'reconnecting' self-heals on ICE 'connected' which already auto-clears the overlay (`callController.ts:1436-1448`, `useGroupCall.ts:1948-1959`).
3. **Optional polish after 1+2:** demote blocking scrims to a slim top "Connecting…" banner; reconnect tone.

**Security stop-conditions:** none — no signalling-auth/relay changes; do not touch 9ac5043 transport timing.

### FIX LOOP B-108 (repeat until exit criteria hold in ONE pass)

```
LOOP B-108:
  1. IMPLEMENT step 1 (failed→reconnecting) for 1:1 AND group; unit-test the transition table:
     never-connected 'failed' → terminal; connected-then-'failed' → 'reconnecting'; budget expiry → end.
  2. STATIC: npm run test:crypto (incl. socketReauth.test.ts, groupCallRejoinHub.test.ts) green;
     typecheck ≤ baseline.
  3. DEVICE HAPPY PATH: 1:1 voice A↔B on Wi-Fi; kill A's Wi-Fi (mobile data on) →
     "Connecting…" within ~2-3 s on A, recovery ≤30 s, audio resumes, NO "Call failed".
     Repeat: callee-side switch · video call · AP-roam Wi-Fi→Wi-Fi · group call (member returns,
     no black tile).
  4. DEVICE FAILURE BACKSTOP (critical — the loosened 'failed' must never create immortal calls):
     airplane mode 45 s mid-call → call ends 'failed' AT the budget, FGS notification cleared,
     no zombie session (B-64 class). If the call survives past budget → the fix is wrong, go to 1.
  5. DEVICE INITIAL-CONNECT: break TURN (or bad creds) → outgoing call still fails FAST, not 30 s
     of fake "Reconnecting…".
  6. REGRESSION: minimize during a blip → bubble truthful, restore truthful (V2); re-run audit §8
     V1-V4 rows to prove 9ac5043 unchanged; P2-BR-6 background pause still respected.
  7. EXIT when 2-6 green in one run + sqa.md updated. Only then add the step-2 NetInfo kicker and
     re-run 3-6 (two separate commits — detection must not mask a broken transition table).
```

---

## B-109 — iPhone screen-lock kills the live call 🔴 P0

**Symptom:** iPhone→Android call; the moment the iPhone locks its screen the call is cut (Android side sees "call failed" ~12 s later). Also expected on Android→iPhone (answered leg) and iPhone→iPhone.

### Root cause (code-proven, ranked)

- **RC-1 · CONFIRMED — the installed iPhone binary has NO `UIBackgroundModes` and NO entitlements.** `app.json:19-28` declares `voip`/`audio`/`remote-notification` + `aps-environment` correctly, but `ios/` is a gitignored stale scaffold generated BEFORE those keys existed; the repo's own binary inspection proves it (`docs/runbooks/IOS_README.md:183-203`: `PlistBuddy Print :UIBackgroundModes` → empty; the doc says outright "this is why CallKeep and WebRTC won't survive backgrounding"). On lock, iOS suspends the process → WebRTC dies → JS runtime frozen entirely (even the message-driven pong — unlike Android where the FGS keeps JS alive) → server reaps the socket ≤35 s → B-58 12 s grace → peer gets `call.hangup{failed}`. The 9ac5043 Manager-ping re-auth (`packages/messenger-core/src/transport/client.ts:834-858`) is a no-op on a suspended process.
- **RC-2 · CONFIRMED — the founder's build predates the CallKit activation flip.** `IOS_RUNTIME_ENABLED=true` (`src/modules/messenger/push/callKitBridge.ts:66`) and voipPush `RUNTIME_ENABLED=true` (`voipPush.ts:42`) were flipped in commit `3af91a7` on 2026-07-18; the device build is from 2026-07-17 (`docs/runbooks/IOS_README.md:3`), so `isBridgeActive()` was false on iOS (`callKitBridge.ts:74-78`) and every `reportOutgoingCall`/`reportIncomingCall`/`reportConnected` no-opped — CallKit never heard of the call, zero lock protection.
- **RC-3 · HYPOTHESIS (med-high) — incoming call answered in-app is never marked answered/active in CallKit.** The iOS `reportConnected` branch only handles OUTGOING (`callKitBridge.ts:324-326`); no `answerIncomingCall`/`setCurrentCallActive` anywhere. Android→iPhone answered via in-app UI leaves the CXCall ringing forever → no lock protection AND a self-hangup hazard: dismissing the stale CallKit ring fires `endCall` → `fcmBootstrap.ts:388-397` still has the cached payload → sends `call.hangup{declined}` on a LIVE call.
- **RC-4 · HYPOTHESIS (medium) — no CallKit audio-session coordination.** No `didActivateAudioSession`/`didDeactivateAudioSession` listeners exist (subs at `callKitBridge.ts:429-460` cover only answer/end/mute/DTMF); `CallScreen.tsx:929-930` starts InCallManager unconditionally at mount. Under CallKit, the app must let CXProvider activate the session — classic "silence after lock-screen answer / audio dies on lock" class.
- **RC-5 · Context:** there is currently NO buildable path to a binary with the background modes — `expo prebuild` destroys the hand-applied Podfile `USE_FRAMEWORKS` export + xcode.sh fixes (`docs/runbooks/IOS_README.md:132,170-182`, `docs/runbooks/IOS_BUILD.md:36-67`); `plugins/withVoipCallKit.js` covers only the PushKit AppDelegate block. Note: the `aps-environment` signing blocker (`docs/runbooks/IOS_README.md:139-158`) blocks VoIP **push** only — it does NOT block the mid-call lock fix (`UIBackgroundModes audio` needs no push entitlement).

### Files involved

`app.json` · `plugins/withVoipCallKit.js` (+ new plugins for Podfile/xcode.sh fixes) · `src/modules/messenger/push/callKitBridge.ts` · `src/modules/messenger/push/voipPush.ts` · `src/modules/messenger/push/fcmBootstrap.ts:388-397` · `src/modules/messenger/webrtc/useCall.ts:565-566,607-610,884-889` · `src/navigation/MainNavigator.tsx:508-527` · `src/screens/messenger/CallScreen.tsx:929-930` · runbooks: `docs/runbooks/IOS_README.md`, `docs/runbooks/IOS_BUILD.md`, `docs/runbooks/IOS_CALLKIT_VOIP.md`

### Fix direction (ordered — no code here)

1. **Get the background modes into the binary:** convert the three hand-applied `ios/` fixes (Podfile `USE_FRAMEWORKS` export, `react-native-xcode.sh` quoting, `ENABLE_USER_SCRIPT_SANDBOXING=NO`) into config plugins so a clean `expo prebuild -p ios` survives, then rebuild; verify with the `codesign`/`PlistBuddy` probes from `docs/runbooks/IOS_README.md:183-199`. `audio` is the load-bearing mode for mid-call lock survival. Nothing else works until this ships.
2. **Complete CallKit reporting:** fresh build already covers the outgoing leg (flags now true). Close the incoming-answered-in-app hole (mark the CXCall answered/active on in-app accept) and make the `endCall`→hangup handler distinguish "stale ring dismissed after in-app answer" from a genuine decline (`fcmBootstrap.ts:388-397`).
3. **CallKit-gated audio session:** subscribe `didActivateAudioSession`/`didDeactivateAudioSession`; on iOS start InCallManager/audio units from CallKit's activation, not unconditionally at CallScreen mount.
4. **Push half is a separate milestone** (org App ID + `APNS_VOIP_*` env + §5 5-second-contract device test per `IOS_CALLKIT_VOIP.md` — its entitlement-revocation warning is mandatory reading).

⚠️ No iOS device exists in this QA environment and the simulator cannot run the app (`IOS_BUILD.md`). All device rows below need a physical iPhone.

### FIX LOOP B-109 (repeat until exit criteria hold in ONE pass)

```
LOOP B-109:
  1. IMPLEMENT the next unfixed layer (order: plugins/prebuild → CallKit answer/active → audio session).
  2. STATIC CHECK: expo prebuild -p ios on a CLEAN checkout must succeed; grep the generated
     Info.plist for UIBackgroundModes(audio,voip) + entitlements for aps-environment;
     confirm withVoipCallKit regex still matches the regenerated AppDelegate.
  3. ANDROID REGRESSION FIRST (shared bridge!): npm run test:crypto (socketReauth, callHangupWhileRinging),
     then on Android device: outgoing 1:1 call + system-UI decline path still stops the peer ringing
     (the fcmBootstrap onEnd decline is load-bearing on Android).
  4. IPHONE BUILD + INSTALL (physical device): codesign/PlistBuddy probes on the BUILT binary —
     if UIBackgroundModes still empty → back to step 1, do NOT proceed.
  5. DEVICE MATRIX (each row must pass; on any fail → diagnose with device console logs, back to 1):
     M1 iPhone→Android voice, lock iPhone 2 min  → audio continuous, CallKit lock UI shows
     M2 same but video                            → audio continues, camera pauses/resumes
     M3 Android→iPhone, answer IN-APP, lock       → survives; NO stale ringing CXCall; no self-decline
     M5 Android locks instead                     → survives (B-101 regression row)
     M6 iPhone→iPhone, either side locks          → survives
     M7 iPhone app-switch (not lock)              → survives
     M8 iPhone locked >15 min                     → Manager-ping re-auth fires; call alive (B-100 wall)
  6. RE-VERIFY the claim you did NOT test: if any matrix row was skipped (no second iPhone etc.),
     STATE it in sqa.md — do not mark the row passed.
  7. EXIT only when: steps 2-5 all green in the same run + Android V1-V8 audit matrix unaffected
     + sqa.md B-109 entry updated with evidence.
```
