# B-20 / B-21 — Camera-restore after backgrounding + background incoming-call ring — FIX HANDOFF

> **For the implementing Claude session.** This is a complete, self-contained spec.
> You should not need to re-investigate — every file, line number, and code block below
> was read from the current tree (branch `main`, commit `8b9393f`) on 2026-06-14.
> Read it top to bottom, then implement **§6** exactly. The investigation is done.
>
> **Two bugs, very different states:**
>
> - **B-20** (camera not restored after another app steals it): the **1:1 path is already
>   fixed and shipped in source** (`recoverCamera`). The **group-call path is NOT done** —
>   that is the real code work in this handoff (**§6**).
> - **B-21** (no usable background incoming-call ring): the **root cause is already fixed in
>   source** (B-27 — the `vibrationPattern` validation bug). What remains is **device
>   verification** plus an **optional** investigation of why `react-native-callkeep` `setup()`
>   returns `false` on Android (**§7**). No new ring code is required.
>
> **Scope of the new work (§6):** Android, JS/TS only. Additive — one new exported helper in
> `peerConnectionFactory.ts`, one new `useEffect` + three refs in `useGroupCall.ts`, one new
> Jest test. **No crypto, no SFrame/FrameCryptor changes, no wire/protocol changes, no
> permission changes, no native (Kotlin) changes.** Touch nothing in the §8 "DO NOT CHANGE"
> list. This keeps regression risk near zero.

---

## 1. TL;DR

| Bug              | What it is                                                                                                                                                  | State in source today                                                                                                                                                                                                                                    | Work left                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **B-20 (1:1)**   | In a 1:1 video call, another app (system Camera, WhatsApp video) grabs the camera; on return our tile is magenta/black/frozen and the peer sees dead video. | **FIXED** — `recoverCamera()` + an AppState `active` handler in `useCall.ts`. Tested (`recoverCamera.test.ts`, 4).                                                                                                                                       | **None** (device-verify only). Do not touch.                                                                   |
| **B-20 (group)** | Exact same failure in a **group** video call (`GroupCallScreen` / `useGroupCall`).                                                                          | **NOT FIXED** — `useGroupCall.ts` has **no** camera-recovery handler. The documented follow-up (`sqa.md` 2026-06-09 §"B-20 group path").                                                                                                                 | **§6 — implement it.**                                                                                         |
| **B-21**         | Backgrounded / locked phone never rings for an incoming call.                                                                                               | **FIXED in source** via **B-27** (the `vibrationPattern` leading-`0` bug that made the `bravo-incoming-call` channel fail to create on every boot). Channel is also pre-created at boot. Tested (vibration validity in `groupCallCameraToggle.test.ts`). | **Device-verify** the ring on a physical phone (**§7.1**); **optional** callkeep `setup=false` fix (**§7.2**). |

The single most important implementation rule for §6: **recover the group camera with
`producer.replaceTrack({track})` on the EXISTING mediasoup video producer — never
close-and-recreate the producer.** `replaceTrack` keeps the same `RTCRtpSender`, and the
SFrame FrameCryptor transform is bound to that sender, so recovered frames stay
E2E-encrypted. Close-and-recreate would force a re-attach of the encryptor and risk a
plaintext-video window (a security stop-condition). This mirrors exactly what the shipped
1:1 `recoverCamera` already does.

---

## 2. Bug records (from `sqa.md`)

### B-20 — camera not restored after another app steals it

- **Layer:** Frontend.
- **Source files:** `src/modules/messenger/webrtc/peerConnectionFactory.ts` (the recovery
  helper) + `src/modules/messenger/webrtc/useCall.ts` (1:1 wiring, done) +
  `src/modules/messenger/webrtc/useGroupCall.ts` (group wiring, **to do**).
- **2026-06-09 status:** _"FIXED (1:1) · device-verify. New `recoverCamera()` … Group-call
  self-camera uses mediasoup `producer.replaceTrack` (FrameCryptor-adjacent) — left as a
  documented follow-up."_ (`sqa.md` Developer Fix Session 2026-06-09 table.)
- **Open follow-up #3 (verbatim):** _"B-20 group path: apply the same camera-resume recovery
  to the group-call producer (mediasoup `producer.replaceTrack`) once the 1:1 path is
  device-confirmed."_

### B-21 — no usable background incoming-call ring

- **Layer:** Frontend.
- **Source files:** `src/modules/messenger/push/callNotification.ts`,
  `src/modules/messenger/push/callVibration.ts` (new, B-27), `push/fcmBootstrap.ts`,
  `push/callKitBridge.ts`.
- **2026-06-09 status:** _"HARDENED · device-verify"_ — ring channel pre-created at boot.
- **2026-06-12 (B-27) status:** _"FIXED"_ — see §5. B-27 is described in `sqa.md` as
  _"likely the real root of B-21"_.

---

## 3. Why the camera dies (the mechanism — same for 1:1 and group)

When the OS hands the camera to another foreground app (the system Camera, an incoming
WhatsApp video call, etc.), our capture `MediaStreamTrack` transitions to `ended` or fires
`mute`. There is **no `onCameraDisconnected` callback** in `react-native-webrtc` to react to.
The encoder keeps "sending" on a dead source — peers see a frozen last frame / black / (on
BlueStacks) a magenta tile. Coming back to the foreground does **not** auto-revive the track.

The fix on both paths: on `AppState → 'active'`, if we're in a video call whose local video
track is dead **and** the user did not intentionally turn the camera off, acquire a fresh
track and `replaceTrack` it onto the existing sender/producer (no SDP renegotiation; the peer
keeps receiving seamlessly). If the other app still holds the camera, acquisition fails and
the handler simply retries on the next foreground (it's a safe no-op when the track is
healthy).

> **BlueStacks cannot reproduce B-20** — its virtual camera reports the "stolen" track as
> `readyState: 'live'` (it just feeds garbage/magenta frames), so the `dead` check never
> trips. **This must be verified on a physical device** (Pixel / Xiaomi / Redmi). The code is
> written to be a safe no-op when the track is healthy, so shipping it carries no risk even
> where it can't be exercised.

---

## 4. The 1:1 fix — already shipped, READ IT, then mirror it (do not change it)

This is the template you are mirroring for groups. Two pieces:

**4.1 The helper — `peerConnectionFactory.ts:157-185` (`recoverCamera`).** Acquires a fresh
track with the current facing, finds the video `RTCRtpSender`, `replaceTrack`s onto it
(keeping SDP/SRTP and any FrameCryptor transform attached to that sender), splices the new
track into the local PiP stream, stops the old track, returns the new track (or `null` when
there's no video sender / acquisition fails).

**4.2 The wiring — `useCall.ts:193-254`.** Refs that the once-bound handler reads
(`facingRef`, `isVideoOffRef`, `recoveringCameraRef` — lines 193-200), then an `AppState`
`change` effect that on `'active'`:

1. bails if `isVideoOffRef.current` (user-intended off),
2. bails if there's no video track (audio-only call),
3. checks `track.readyState === 'ended' || track.muted === true` → only proceeds if `dead`,
4. re-entrancy guard (`recoveringCameraRef`),
5. grabs the raw PC, calls `recoverCamera(...)`, and on success updates `videoTrackRef`,
   rebuilds `localStream` from `audioTrackRef + replaced`, and
   `callRegistry.patchActiveCall({videoTrack, localStream})`.

Read both blocks in full before writing §6 — your group version is the same shape with
mediasoup substituted for the raw PC.

---

## 5. B-21 — what B-27 already fixed (context; do not redo)

**Root cause (B-27, fixed 2026-06-12):** `notifee` rejects any `vibrationPattern` containing a
non-positive value with _"expected an array containing an even number of positive values."_
The Android-conventional leading `0` ("no delay") therefore made `createChannel` **throw on
every boot** — the `bravo-incoming-call` channel never existed on **any** Android device, so a
backgrounded/locked phone could never ring. The display call had the same invalid pattern.

**The fix that is in source now:**

- `src/modules/messenger/push/callVibration.ts` (new): `RING_CHANNEL_VIBRATION = [300, 800,
1200, 800]` and `RING_NOTIF_VIBRATION = [300, 1000, 500, 1000, 500, 1000]` (all strictly
  positive) + `isValidNotifeeVibration()` mirroring notifee's rule.
- `callNotification.ts:86` uses `RING_CHANNEL_VIBRATION` in `ensureIncomingCallChannel()`;
  `callNotification.ts:196` uses `RING_NOTIF_VIBRATION` in `showIncomingCallNotif()`.
- `fcmBootstrap.ts:101-104` pre-creates the channel at boot (`startFcmBootstrap →
ensureIncomingCallChannel`) so a headless background wake can't be dropped for a missing
  channel.
- Regression test: vibration validity (incl. the old leading-`0` patterns) is asserted in
  `groupCallCameraToggle.test.ts`.

So the ring **infrastructure is correct in source**: HIGH-importance channel, `category: CALL`,
`fullScreenAction` (lock-screen wake), `loopSound`, Accept/Decline actions, FCM-data wake →
`showIncomingCallNotif` (`fcmBootstrap.ts:811-818`), notifee fg/bg event handlers
(`fcmBootstrap.ts:604`). **You do not need to write any ring code.** See §7 for what's left.

---

## 6. THE WORK — B-20 group-call camera recovery

### 6.0 The group-call camera model (so the code below makes sense)

`useGroupCall.ts` uses **mediasoup**, not a raw `RTCPeerConnection`. The relevant pieces
(all already present):

- Local video track: `videoTrackRef` (`useGroupCall.ts:321`); audio track: `audioTrackRef`
  (`:320`).
- The mediasoup video **producer** lives in `producersRef` (`:325`); find it by
  `kind === 'video' && !closed` — exactly the lookup `toggleVideo` already uses
  (`useGroupCall.ts:2580-2583`).
- Facing is tracked as a boolean `isFrontCamera` state (`:298`, default `true`); flipped by
  `switchCamera` (`:2684-2704`) which calls the in-place `track._switchCamera()`.
- `isVideoOff` state (`:295`); `isLeavingRef` (`:422`); `mediaDevices` and `MediaStream` are
  already imported (used at `:2612` and `:2665`); `patchActiveGroupCall` is already used in
  the hook (e.g. `:2558`).
- **SFrame:** the video producer's `rtpSender` has the FrameCryptor encrypt transform attached
  (`enc.attachSenderCryptor(rtpSender, ...)` at `:2648`). This is the security-critical part —
  see §6.3.

`useGroupCall.ts` has **no AppState handler at all** — the only AppState code for groups lives
in the **screen** (`GroupCallScreen.tsx:1371-1397`, a render-tick + `keepAlive` stamp) and is
unrelated to camera tracks. You are adding a new, independent handler in the **hook** (mirrors
where the 1:1 handler lives — in `useCall`, not `CallScreen`).

### 6.1 NEW helper — add to `src/modules/messenger/webrtc/peerConnectionFactory.ts`

Add directly **after** `recoverCamera` (after line 185), so the group recovery is a small,
unit-testable pure-ish helper just like the 1:1 one. `mediaDevices` and the WebRTC types are
already imported at the top of this file.

```ts
/**
 * B-20 (group) — re-acquire the camera after another app grabbed it
 * mid group-call. Same intent as `recoverCamera`, but the group path
 * sends through a mediasoup Producer, not a raw RTCRtpSender.
 *
 * `producer.replaceTrack({track})` swaps the source upstream of the
 * encoder while keeping the SAME underlying RTCRtpSender — so the SFrame
 * FrameCryptor transform attached to that sender stays in place and the
 * recovered video remains E2E-encrypted. Do NOT close + recreate the
 * producer here: that path (see useGroupCall.toggleVideo's fresh-camera
 * branch) must re-attach the encryptor and risks a plaintext-video
 * window — a security stop-condition.
 *
 * Returns the new track (caller updates its ref + local PiP stream), or
 * null when there is no producer or acquisition fails (e.g. the other
 * app is still holding the camera — the resume handler simply retries on
 * the next foreground).
 */
export async function recoverGroupCamera(args: {
  producer: {replaceTrack: (a: {track: MediaStreamTrack}) => Promise<void>} | null;
  facing: 'user' | 'environment';
  currentTrack: MediaStreamTrack | null;
}): Promise<MediaStreamTrack | null> {
  if (!args.producer) {
    return null;
  }
  const fresh = await mediaDevices.getUserMedia({audio: false, video: {facingMode: args.facing}});
  const newTrack = fresh.getVideoTracks()[0] ?? null;
  if (!newTrack) {
    return null;
  }
  // Keeps the same RTCRtpSender → same SFrame transform → still encrypted.
  await args.producer.replaceTrack({track: newTrack});
  if (args.currentTrack) {
    try {
      args.currentTrack.stop();
    } catch {
      /* ignore */
    }
  }
  return newTrack;
}
```

### 6.2 NEW wiring — add to `src/modules/messenger/webrtc/useGroupCall.ts`

**(a)** Extend the import at `useGroupCall.ts:89` (currently `import {getLocalMedia} from
'./peerConnectionFactory';`) to also pull the new helper:

```ts
import {getLocalMedia, recoverGroupCamera} from './peerConnectionFactory';
```

**(b)** Add three refs near the other refs (anywhere after the `isFrontCamera`/`isVideoOff`
state declarations around `:295-298` and the existing refs at `:320-325`). These let the
once-bound handler read fresh values without re-subscribing AppState on every toggle —
identical to the 1:1 pattern at `useCall.ts:196-200`:

```ts
// B-20 (group) — mirror facing + user-intended-off into refs so the
// once-bound resume handler reads fresh values without re-subscribing.
const isVideoOffRef = useRef(isVideoOff);
useEffect(() => {
  isVideoOffRef.current = isVideoOff;
}, [isVideoOff]);
const isFrontCameraRef = useRef(isFrontCamera);
useEffect(() => {
  isFrontCameraRef.current = isFrontCamera;
}, [isFrontCamera]);
const recoveringCameraRef = useRef(false);
```

**(c)** Add the AppState recovery effect (place it alongside the other top-level `useEffect`s
in the hook; order doesn't matter since it's self-contained and `[]`-deps). This mirrors
`useCall.ts:213-254`:

```ts
// ── B-20 (group) — camera-loss recovery on resume ──────────────
// Another app grabs the camera mid group-call; our capture track
// ends/mutes and the mediasoup video producer keeps "sending" null
// frames. On foreground, if we're in a video call whose local track
// has died AND the user didn't intentionally turn the camera off,
// acquire a fresh track and replaceTrack it onto the EXISTING video
// producer — keeping the producer's RTPSender + SFrame transform, so
// recovered frames stay encrypted (no SDP reneg; peers keep receiving).
// BlueStacks reports the stolen track as 'live' so this can only be
// verified on a physical device; it is a safe no-op on a healthy track.
useEffect(() => {
  const {AppState} = require('react-native') as typeof import('react-native');
  const sub = AppState.addEventListener('change', (next: string) => {
    if (next !== 'active') {
      return;
    }
    if (isVideoOffRef.current) {
      return;
    } // user-intended off — respect it
    if (isLeavingRef.current) {
      return;
    } // call tearing down
    const track = videoTrackRef.current;
    if (!track) {
      return;
    } // audio-only / camera never on
    const muted = (track as unknown as {muted?: boolean}).muted === true;
    const dead = track.readyState === 'ended' || muted;
    if (!dead) {
      return;
    } // healthy track — nothing to do
    if (recoveringCameraRef.current) {
      return;
    } // re-entrancy guard
    const vp = producersRef.current.find(
      p =>
        (p as unknown as {kind?: string; closed?: boolean}).kind === 'video' &&
        !(p as unknown as {closed?: boolean}).closed,
    );
    if (!vp) {
      return;
    } // no live video producer
    recoveringCameraRef.current = true;
    void (async () => {
      try {
        const replaced = await recoverGroupCamera({
          producer: vp as never,
          facing: isFrontCameraRef.current ? 'user' : 'environment',
          currentTrack: track,
        });
        if (replaced) {
          videoTrackRef.current = replaced;
          const audio = audioTrackRef.current;
          const rebuilt = new MediaStream(audio ? [audio, replaced] : [replaced]);
          setLocalStream(rebuilt);
          try {
            patchActiveGroupCall({localStream: rebuilt, videoTrack: replaced});
          } catch {
            /* best-effort registry refresh */
          }
          console.log('[useGroupCall.recoverCamera] re-acquired camera after resume');
        }
      } catch (e) {
        console.warn(
          '[useGroupCall.recoverCamera] failed (camera may still be held):',
          (e as Error).message,
        );
      } finally {
        recoveringCameraRef.current = false;
      }
    })();
  });
  return () => sub.remove();
}, []);
```

> If `patchActiveGroupCall` is not in lexical scope at the spot you place the effect (it is
> imported/used elsewhere in the hook — confirm it's a module import, not a destructure inside
> another effect), follow the hook's existing convention: `require` the registry at the call
> site, e.g. `const {patchActiveGroupCall} = require('../runtime/groupCallRegistry') as
typeof import('../runtime/groupCallRegistry');`. Check how the hook already references
> `patchActiveGroupCall` (used at `:2558`) and match that exact form to avoid a scope/TDZ
> error.

### 6.3 Security guardrail — DO NOT change the crypto path

This change is deliberately scoped to stay **out** of every security stop-condition in
`CLAUDE.md`:

- It does **not** touch any encryption primitive, key, sealed-sender, sender-cert, group
  master key distribution, or relay semantics.
- `producer.replaceTrack({track})` reuses the **same** `RTCRtpSender`. The SFrame FrameCryptor
  transform is attached to that sender (`useGroupCall.ts:2648`), so it remains attached →
  recovered frames are still encrypted before SRTP. **This is the whole reason to use
  `replaceTrack` and not close+recreate.**
- The "fresh camera" branch of `toggleVideo` (`useGroupCall.ts:2610-2660`) DOES create a new
  producer and re-attaches the encryptor with a hard "refuse + tear down on attach failure"
  contract. **Do not route recovery through that path** and **do not copy its close/recreate
  logic** — recovery must preserve the existing producer.
- Net: no architecture sign-off required, because no documented security behavior changes.
  (If in doubt, re-read `CLAUDE.md` → Security constraints → "WebRTC voice/video" and "Group
  call frames". This change is within the allowed envelope.)

### 6.4 Verify the assumption that matters most (on a real device)

The one thing that cannot be proven from source alone: **does the peer keep decrypting the
recovered video after `replaceTrack`?** It _should_ (same sender → same SFrame transform), but
confirm it on-device (§9, step 4): after recovery, the recovering user's tile must be **live
and not garbled** on the OTHER participants' screens. If peers see scrambled video, the SFrame
transform did not survive `replaceTrack` on this RN-WebRTC build — escalate before shipping
(do **not** "fix" it by recreating the producer without the encryptor).

---

## 7. B-21 — what's actually left

### 7.1 Device-verify the background ring (REQUIRED — this is the bulk of B-21)

No code needed; B-27 already fixed the root cause. Verify on a **physical** Android phone
(BlueStacks can't reproduce the locked/backgrounded ring path reliably):

1. Fresh-install the build, boot once (so `startFcmBootstrap` runs and pre-creates the
   channel). Confirm the channel now exists:
   ```bash
   adb -s <serial> shell dumpsys notification | grep -A8 com.bravosecure.app
   # expect BOTH: bravo-messages AND bravo-incoming-call (HIGH importance)
   ```
2. Boot log must NOT show `channel create failed … 'channel.vibrationPattern'` and should not
   show `[bravo.callnotif] display failed`. (Those were the B-27 symptoms.)
3. Background the app (or lock the phone). Have another device call you (1:1 **and** group).
   **Expected:** full-screen ring on the lock screen, ringtone loops, Accept/Decline visible;
   tapping Answer opens the in-app ring/call screen.
4. Repeat with the app **killed** (swiped from recents) to exercise the headless FCM
   data-wake → `showIncomingCallNotif` path (`fcmBootstrap.ts:811-818`, notifee
   `onBackgroundEvent` at `:604`).

Record the result in `sqa.md` using the existing convention (device model + "device-verified"
or the residual). If the ring works, B-21 flips from "device-verify pending" to FIXED.

### 7.2 OPTIONAL — investigate `[callkit] setup returned false platform=android`

Secondary. With notifee fixed (§5), notifee is the working ringer and callkeep/Telecom is only
an additive layer (Bluetooth routing, "ring alongside WhatsApp"). It is currently dead weight
because `ck.setup(...)` resolves falsey (`callKitBridge.ts:231`, `setupSucceeded = ok !==
false`), so every Telecom method early-returns.

- Where: `setupCallKit()` at `callKitBridge.ts:181-245`; `ck.setup(...)` at `:197-230`.
- Likely causes to check on-device: the self-managed Telecom **phone-account permission** was
  not granted / was revoked (`selfManaged: true`, `:223`); an OEM that strips Telecom; or the
  `foregroundService` channel block (`:224-228`, channel id `bravo-incoming-call`) conflicting
  with the notifee-owned channel of the same id.
- How to triage: `adb logcat | grep -E 'callkit|CallKeep|Telecom'` during boot; check
  `adb shell dumpsys telecom | grep -i bravo` for a registered phone account.
- **Do not** make notifee depend on callkeep, and **do not** remove the notifee ring while
  "fixing" callkeep — notifee is the proven path. If callkeep can't be made to return `true`
  cleanly, leave it inert (current behavior) and just document the finding. This is explicitly
  lower priority than §7.1.

---

## 8. DO NOT CHANGE (guardrails — how we avoid creating another bug)

1. **`useCall.ts` and `peerConnectionFactory.ts:recoverCamera`** — the 1:1 path is done and
   shipped. Add the new `recoverGroupCamera` helper **next to** `recoverCamera`; do not modify
   `recoverCamera`, `flipCamera`, or `getLocalMedia`.
2. **`toggleVideo` / `switchCamera` in `useGroupCall.ts`** (`:2562-2704`) — the pause/resume +
   `sfu.producer.pause/resume` signalling (B-29) and the `_switchCamera` flip are correct.
   Your recovery handler is a **separate** effect; do not reroute toggle/flip through it.
3. **The SFrame attach path** (`enc.attachSenderCryptor`, `groupEncryptionRef`,
   `sframeDetachersRef`) — untouched. Recovery uses `replaceTrack` precisely so this stays
   intact. No close/recreate of the video producer.
4. **`GroupCallScreen.tsx` AppState handler** (`:1371-1397`) and the audio-focus handler
   (`:1337-1361`) — unrelated (render-tick + `keepAlive` + audio route). Leave them. Your code
   goes in the **hook**, not the screen.
5. **The ring stack** — `callNotification.ts`, `callVibration.ts`, `fcmBootstrap.ts` ring wiring
   are already fixed (B-27). Do not re-edit them for B-21 (§7.1 is verification only). The only
   permitted B-21 code change is the optional callkeep investigation in §7.2.
6. **No new runtime permissions, no manifest change, no native/Kotlin change, no
   minSdk/targetSdk/Gradle change.** `getLocalMedia` already requests `CAMERA`/`RECORD_AUDIO`;
   recovery reuses an already-granted camera.
7. **Do not touch unrelated in-flight uncommitted work** (B-30/B-31/B-19/B-33 edits to
   `productionRuntime.ts`, `GroupCallScreen.tsx` group-text/tile code, etc.). Your change is
   disjoint — keep it that way.
8. **iOS:** no-op. The group-call/FrameCryptor stack is Android-only; the AppState handler's
   `dead`-check simply never trips into recovery in a way that matters, but you need not
   special-case iOS.

Correctness invariants the §6 code already satisfies (keep them if you edit the snippets):

- Recovery only fires when `next === 'active'`, the track is genuinely `dead`, the user has
  NOT turned video off (`isVideoOffRef`), the call isn't leaving (`isLeavingRef`), a live
  video producer exists, and no recovery is already in flight (`recoveringCameraRef`).
- Facing is preserved (`isFrontCameraRef`), not reset to front.
- The old (dead) track is stopped; the local PiP stream is rebuilt from `audioTrackRef + new
track`; the registry is refreshed best-effort.

---

## 9. Device verification (the real test — Jest can't cover the native camera-steal)

State clearly in your report whether the fix is **device-verified** or **device-verify
pending** (per the SQA convention used by B-27..B-33). BlueStacks can't reproduce B-20.

1. Build a staging APK (`npm run apk:staging` or the `release-apk.ps1` flow). **Do not**
   `expo prebuild --clean`.
2. **B-20 group golden path:** start a group **video** call with ≥2 devices, all video on.
   On device A, open the system Camera app (or take an incoming WhatsApp video call) for
   ~10–20 s, then return to the Bravo call.
   - **Expected:** device A's self-tile shows live video again within a second or two; the
     OTHER devices see A's tile live (not frozen/black) **and not garbled** (SFrame intact —
     see §6.4).
   - Logcat: `adb -s <serial> logcat | grep -E 'useGroupCall.recoverCamera|bravo.groupcall'`
     → expect `re-acquired camera after resume`.
3. **B-20 error path:** repeat but keep the other camera app in the foreground longer / deny
   on first return — recovery should fail quietly (`failed (camera may still be held)`) and
   then succeed on a subsequent foreground once the camera is free. No crash, no duplicate
   producer (`adb logcat` should not show a second `video producer up`).
4. **B-20 respect user intent:** turn the camera OFF in-call (button), background, foreground —
   recovery must **not** silently turn the camera back on (`isVideoOffRef` guard).
5. **B-20 audio-only group call:** background/foreground — recovery is a no-op (no video
   track), call audio unaffected.
6. **B-20 1:1 regression:** confirm the existing 1:1 recovery still works (you didn't touch it,
   but smoke it).
7. **B-21:** run §7.1 steps 1–4.

---

## 10. Gates (per `CLAUDE.md` change-safety)

- **Direct test (required):** add `src/modules/messenger/__tests__/recoverGroupCamera.test.ts`
  mirroring `recoverCamera.test.ts`. Mock `mediaDevices.getUserMedia` to return a stream with
  one video track; pass a fake `producer` whose `replaceTrack` records its arg. Assert:
  (a) `replaceTrack({track})` is called with the fresh track; (b) the returned value is the
  fresh track; (c) `currentTrack.stop()` is called; (d) `producer: null` → returns `null`
  without calling `getUserMedia`; (e) `getUserMedia` resolving with no video track → returns
  `null`. (Optional nice-to-have: a test that the AppState handler does nothing when the track
  is healthy / `isVideoOff` is true — but the helper-level test is the required one.)
- **Regression:** `npm run test:crypto` (the messenger-crypto project — this is the standard
  signal for any webrtc/call change) and then full `npm test`. Nothing here touches crypto, so
  both should stay green.
- **Typecheck:** `npm run typecheck` must stay ≤ the baseline in `.tsc-baseline.json`. This
  change is small and typed; the count should be **unchanged**. (`cd apps/ops-console && npm
run typecheck` is unaffected — don't bother unless you touched it.)
- **Lint:** `npm run lint` on the two changed files.
- Targeted first (`npm run test:crypto`), broad second (`npm test`). Do not commit on a red
  gate; do not `--no-verify`.

---

## 11. Rollback

Pure addition. To revert B-20-group: delete `recoverGroupCamera` from
`peerConnectionFactory.ts`, remove the import addition, the three refs, and the AppState effect
from `useGroupCall.ts`, and delete the new test. Behavior returns to today's (group camera not
restored after a steal). No other code depends on the new helper. B-21 has no code change to
roll back beyond the optional §7.2.

---

## 12. One-paragraph summary for the commit / PR

> **fix(group-call): restore camera after another app steals it mid-call (B-20 group path).**
> The 1:1 path already recovered a stolen camera on foreground (`recoverCamera` + an AppState
> handler in `useCall`), but the group path had no equivalent — `useGroupCall` never re-acquired
> the camera, so after the system Camera / an incoming WhatsApp video grabbed it, the user's
> group tile stayed frozen/black for every peer. Adds `recoverGroupCamera()` (acquires a fresh
> track and `producer.replaceTrack`s it onto the EXISTING mediasoup video producer — same
> RTCRtpSender, so the SFrame FrameCryptor transform stays attached and recovered frames remain
> E2E-encrypted; never close+recreate) and an AppState `active` handler in `useGroupCall` that
> fires only when the local video track is dead and the user didn't intentionally turn video
> off. No crypto/SFrame/wire/permission/native changes. Device-verified group video survives a
> camera steal (or device-verify pending). B-21's background ring was already fixed in source by
> B-27 (vibrationPattern validation); this branch device-verifies it and notes the inert
> callkeep `setup=false` residual as a separate, optional follow-up.

```

```
