# Cross-Platform (Android ↔ iPhone) Video Call — Bug Loop (B-99)

**Status: RC-1 FIX LANDED 2026-07-17 (preventive — §5 device diagnosis still owed; see §11 outcome log).**
This is the operating loop for B-99 and for ANY future "video not showing on one
platform" report. Like `LITE_BOOKING_LOOP.md` / `BACKUP_LOOP.md`, it is not just
a fix note: run the §5 diagnosis first, apply exactly one §6 fix, then prove the
§7 watchlist + §8 matrix before calling it done.

**Standing constraint for this bug (from the founder):** do NOT merge any branch
into any other branch. The fix is in shared TypeScript (`src/`), so it lands on
`main` as a normal commit. `origin/ios/build-setup` (the iOS build branch —
unstable, build-plumbing only) picks it up when its owner next updates that
branch; that is their operation, not ours.

---

## 0. When this loop applies (trigger files)

Any change to, or bug report involving, these files/behaviours:

- `src/modules/messenger/webrtc/useCall.ts` (1:1 call hook)
- `src/modules/messenger/webrtc/callController.ts` (call FSM / offer-answer relay)
- `src/modules/messenger/webrtc/peerConnection.ts` (PC wrapper — owns createOffer/createAnswer/`setLocalDescription`, the §6 RC-1 seam)
- `src/modules/messenger/webrtc/peerConnectionFactory.ts` (getUserMedia, camera)
- `src/modules/messenger/webrtc/remoteTileGate.ts` (remote-tile decision)
- `src/screens/messenger/CallScreen.tsx`, `FloatingCallOverlay.tsx`
- `patches/react-native-webrtc+124.0.7.patch` (the Android libwebrtc swap)
- Anything that touches SDP, codecs, media-state advisories, or RTCView keys.

---

## 1. Symptom (B-99, reported 2026-07-17)

1:1 **video** call between an Android phone and an iPhone (iOS app built from
`origin/ios/build-setup`):

| Leg                                | Result                                   |
| ---------------------------------- | ---------------------------------------- |
| Android camera → shown on iPhone   | ✅ works                                 |
| iPhone camera → shown on Android   | ❌ never shows                           |
| Audio both directions              | ✅ works (implied — only video reported) |
| Reproduces regardless of who dials | ✅ yes (A→I and I→A both reported)       |

**What that matrix proves before touching anything:** ICE/DTLS/TURN transport is
healthy (audio + one video direction flow on the same PeerConnection). The
failure is isolated to the **iPhone-video-encode → network → Android-video-decode
→ Android-render** leg. Only four things live on that leg — they are the four
root-cause candidates in §4.

---

## 2. The 1:1 video pipeline in one screen (reference)

```
iPhone (sender)                              Android (receiver)
getLocalMedia()                              pc.ontrack fires
 peerConnectionFactory.ts:65 (constraints     useCall.ts:511-515 — remoteHasVideo
 640x480@30, facingMode user; the             driven off the real track list (B-16)
 PermissionsAndroid block :41 is                   │
 Android-only; iOS relies on Info.plist)          ▼
      │                                      media-state advisory (BS-021)
      ▼                                      useCall.ts:370, 802-820 —
attachLocalMedia — useCall.ts:657            `call.media-state` sets remoteVideoOff
 addTrack(track, stream) both kinds;         (DEFAULT FALSE, useCall.ts:159-161)
 video addTrack failure HARD-FAILS the            │
 call (Fix #21, useCall.ts:700-714);              ▼
 sender caps: 600 kbps / maintain-           remoteTileGate.resolveRemoteTile
 framerate (useCall.ts:731-750 — iOS          1. remoteVideoOff → "camera-off" tile
 setParameters is a partial impl,             2. no live video track → avatar/none
 try-wrapped)                                 3. track + URL → RTCView keyed by
      │                                          track id
      ▼                                           │
video encoder → SRTP → (coturn relay) ────────────┘
```

**Key platform asymmetry (the only ones in the whole 1:1 stack):**

- `patches/react-native-webrtc+124.0.7.patch` swaps Android's libwebrtc from
  Jitsi's stock 124.x to **`io.getstream:stream-webrtc-android:1.3.10`** (line
  21 of the patch) to get FrameCryptor classes. **iOS runs the stock
  react-native-webrtc 124.0.7 pod** — `origin/ios/build-setup` adds patches for
  op-sqlite/stripe/expo-constants/react-native/argon2/quick-crypto but **none
  for react-native-webrtc iOS**. So the two ends of every cross-platform call
  run **different libwebrtc builds** with potentially different video
  codec/decoder factories. No JS code anywhere selects or filters codecs —
  the only `m=video` reference in the module is a DETECTION regex
  (`callController.ts:804`, checks whether an inbound reoffer carries a video
  m-line for the upgrade path; it reads the SDP, never rewrites it) — so codec
  choice is whatever the two native builds negotiate.
- `Platform.OS` appears exactly twice in the module: the Android permission
  request (`peerConnectionFactory.ts:41`) and the FrameCryptor availability
  check (`frameCryptorTransport.ts:64`).

**Explicitly ruled OUT for 1:1 (verified this session — do not chase these):**

- **FrameCryptor / SFrame** — group-call-only. `useCall.ts` has zero cryptor
  references. On iOS `frameCryptorTransport.isAvailable()` returns `false`
  (`:64`) and `useGroupCall.ts:1319-1320` **refuses the whole group call** —
  that is a different, expected behaviour (see §9), not a one-way-video cause.
- **Missing iOS permission strings** — `app.json` on `origin/ios/build-setup`
  has `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, and the
  `@config-plugins/react-native-webrtc` plugin with both permission strings.
- **Media-state default** — `remoteVideoOff` defaults to `false`
  (`useCall.ts:159-161`), so a _missing_ advisory cannot hide video. Only a
  _wrong_ advisory can (that's RC-2).
- **Transport** — audio + Android→iPhone video prove ICE/DTLS/coturn fine.

---

## 3. Where is the bug / who is causing it (one paragraph)

The bug lives on the iPhone-to-Android video leg, and the owner is **our own
platform asymmetry**: we replaced Android's libwebrtc with Stream's build (for
group-call E2EE) while iOS ships stock libwebrtc — nobody has ever validated
codec negotiation between those two builds, and no code pins the codec (§4
RC-1, most likely). Two smaller in-house suspects on the same leg: the
`call.media-state` advisory that iOS may emit with a false `cameraOff:true`
during boot timing (RC-2), and the historical "sender encoder never starts
without a stream binding" class re-appearing on the iOS side (RC-3). Nothing in
the backend is involved — signalling only carries the advisory verbatim.

---

## 4. Root-cause candidates, ranked (diagnose FIRST — §5 — then fix ONE)

### RC-1 — Codec/decoder asymmetry between the two libwebrtc builds (PRIMARY)

iOS libwebrtc prefers **hardware H.264**; Android's decoder set now comes from
the swapped Stream build (and on BlueStacks/emulator receivers, H.264 hardware
decode is often broken outright). If negotiation lands the iPhone sender on an
H.264 profile the Android device cannot actually decode, Android mounts the
tile (the track arrives in SDP) but decodes zero frames → **black tile**.
Android sends VP8 (software, present in every build) → iPhone decodes fine.
Fits every observed direction.
**Fingerprint:** Android shows the _video tile but black_; Android
`inbound-rtp(video)` stats show `packetsReceived` growing but
`framesDecoded == 0` (and `pliCount` climbing); codec readout says H264.

### RC-2 — iOS emits a false `cameraOff:true` media-state advisory

The advisory is computed as `cameraOff = !v || v.readyState === 'ended' ||
!v.enabled` (`useCall.ts:1097`, emitted at `:1099`, `:1149`, `:1367`, `:1399`).
If the iOS camera track momentarily reads as not-live at the moment the initial
advisory fires (rn-webrtc iOS track-state timing differs from Android), the
iPhone tells Android "camera off" once; Android sets `remoteVideoOff = true`
(`useCall.ts:370`, `:810-811`) and `resolveRemoteTile` shows the camera-off
placeholder **forever** — decision 1 beats a perfectly healthy video stream
(`remoteTileGate.ts:36`). Re-assert currently happens only on transport
reconnect (`useCall.ts:1036-1039`).
**Fingerprint:** Android shows the **"camera off" placeholder** (not black, not
avatar); logging the inbound `call.media-state` on Android shows
`cameraOff:true` arriving from the iPhone while the iPhone's camera is on.

### RC-3 — iPhone video sender never produces RTP (stream-binding class, iOS edition)

Known class from the Android era: answer SDP looked perfect but the encoder
only starts when the sender has a MediaStream binding — fixed by switching to
`addTrack(track, stream)` (whole story in the comment at `useCall.ts:674-685`).
The same JS now runs on iOS, but the _native_ addTrack/msid path on the stock
iOS pod has never been validated by us.
**Fingerprint:** iPhone `outbound-rtp(video)` shows `framesEncoded == 0` or
`bytesSent ≈ 0`; Android `inbound-rtp(video)` shows `packetsReceived == 0`;
iPhone's answer/offer SDP contains `a=msid:-` on the video m-line.

### RC-4 — iOS runtime camera permission denied (quick pre-check only)

Unlikely to be THE bug — a failed camera hard-fails the entire call (Fix #21,
`useCall.ts:700-714`; no audio-only fallback exists in `ensureLocalMedia`,
`useCall.ts:443-463`) and these calls connect. But it costs 30 seconds: iPhone
Settings → Bravo Secure → Camera ON, and confirm the iPhone shows its **own**
self-preview during the call. If self-preview is black, stop — this is it.

---

## 5. Diagnosis decision tree (run BEFORE any fix — needs one device pair)

1. **RC-4 pre-check** (30s): iPhone camera permission + self-preview. Black
   self-preview → RC-4, done.
2. **Look at the Android remote area during a repro call** — this single
   observation splits the tree:
   - **"Camera off" placeholder** → RC-2. Confirm: temporarily log the inbound
     `call.media-state` payload on Android (`useCall.ts:806-820` handler) and
     the emitted payload on iPhone (`:1099`) — diagnostic logging only, remove
     after. `cameraOff:true` from a camera-on iPhone confirms.
   - **Avatar** → the video never reached React state: inspect the iPhone's
     SDP (RC-3 territory — either no send direction was negotiated, OR the
     video m-line carries `a=msid:-` and Android's `ontrack` skipped the
     stream-less track; see the RC-3 receiver-side detail in §6).
   - **Black video tile** → track arrived, frames don't decode → RC-1 vs RC-3.
3. **Split RC-1 from RC-3 with stats** (temporary 5s `pc.getStats()` dump
   behind `onSecured` in `useCall.ts`, or the platform WebRTC debug overlay —
   remove after diagnosis):
   - iPhone `outbound-rtp` video `framesEncoded` growing? NO → RC-3.
   - YES + Android `inbound-rtp` `packetsReceived` growing but
     `framesDecoded == 0` → **RC-1 confirmed**. Note the negotiated codec +
     `profile-level-id` from the stats/SDP for the fix commit message.
4. Record which RC was confirmed in `sqa.md` under **B-99** before fixing.

---

## 6. The fix, per confirmed candidate (files + exact change — no code here)

### RC-1 fix — pin the cross-platform 1:1 video codec to VP8-first

- **New file** `src/modules/messenger/webrtc/sdpCodecPreference.ts` (sibling of
  `sdpFingerprint.ts`): a **pure** function that takes an SDP string and
  returns it with the `m=video` payload-type list **reordered** so VP8 (and its
  matching rtx) comes first. Reorder ONLY — do not strip H264 (Android↔Android
  hardware paths may still prefer it as fallback), do not touch `ssrc-group`,
  `a=fmtp` contents, or the audio m-line.
- **Wire it at the single seam** in `src/modules/messenger/webrtc/peerConnection.ts`
  where the CallController passes the local description to
  `setLocalDescription` — both the offer and the answer path, so it holds no
  matter who dials. (First check whether rn-webrtc 124 exposes
  `transceiver.setCodecPreferences` on BOTH platforms — if yes, prefer that
  API at the same seam and skip the munge.)
- **Direct test (mandatory):** unit tests for the pure function with two real
  captured SDP fixtures — one Android offer, one iOS offer — asserting VP8
  leads, H264 retained, rtx pairing intact, audio m-line byte-identical.
- Why VP8: it is the mandatory-to-implement software codec present in BOTH
  libwebrtc builds — it removes the decoder asymmetry instead of guessing at
  H264 profile flags.
- **Do NOT** touch `patches/react-native-webrtc+124.0.7.patch` (group-call E2EE
  depends on the Stream build — security stop-condition) and **do NOT** touch
  the group/SFU codec config (`useGroupCall.ts:1849`, sfuWorkerPool) — group
  calls already work Android↔Android.

### RC-2 fix — never emit (or never trust forever) a boot-time false cameraOff

Two halves, both in `src/modules/messenger/webrtc/useCall.ts`:

- **Sender half (iPhone):** guard the initial advisory at `:1094-1099` — if a
  video track exists but isn't live _yet_, defer the advisory until the track
  reports live (or re-emit once it does), instead of stamping `cameraOff:true`
  from boot-timing noise. The toggle path (`:1141-1149`) is user-intent and
  stays as-is.
- **Receiver half (Android, defence-in-depth):** extend the reconnect re-assert
  concept (`:1036-1039`) — when `remoteVideoOff` is true but the remote video
  track is live and delivering (mirror of the group "frames self-heal"), clear
  the stale advisory. Keep `resolveRemoteTile`'s decision order untouched
  (advisory wins is the audited CALL-N2 contract, `remoteTileGate.ts:16`) —
  self-heal the _state_, don't reorder the gate.
- **Direct test:** extend `remoteTileGate`/useCall tests: advisory=off + live
  frames ⇒ recovers to video.

### RC-3 fix — iOS sender stream binding

Verify on-device that the iOS answer/offer SDP carries a real
`a=msid:<stream> <track>` for video (not `-`). If not, the fix is in the
`attachLocalMedia` path (`useCall.ts:657-714`) / rn-webrtc iOS `addTrack`
stream-ids handling — same remedy shape as the documented Android fix
(comment `:674-685`): ensure the stream is passed and reflected natively. If
the stock pod itself drops streamIds, that becomes a `patches/` entry for the
**iOS** side of react-native-webrtc — keep it surgical and Android-untouched.

**Receiver-side detail that makes RC-3 doubly fatal:** Android's `ontrack`
handlers only act when `event.streams[0]` exists (`useCall.ts:330-346` fresh
mount, `:509-517` minimize→restore re-bind) — a track that arrives WITHOUT a
stream binding (`a=msid:-`) is silently ignored by the receiver, so the tile
stays on **avatar** even though RTP video may be flowing. This is why the §5
"avatar" branch must check the SDP msid, not just the negotiated direction.

### RC-4 fix — UX only

Pre-call camera permission check on iOS with a settings deep-link prompt
(mirror of the Android W3 pattern at `peerConnectionFactory.ts:33-55`).

---

## 7. Multi-POV regression watchlist (check EVERY one before sign-off)

The fix touches the shared 1:1 SDP/media path — these are the flows that have
bitten us before and must not regress:

| #   | POV / flow                                            | Why it's at risk                                                                                                                                                                                                             | Proof                                                        |
| --- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| W1  | Android↔Android 1:1 video                             | Same code path; v1.0.90 CALL-N2/O-E/O-F fixes live here                                                                                                                                                                      | Device pair + `remoteTileGate` tests                         |
| W2  | Voice call → mid-call camera upgrade (both platforms) | Renegotiation + media-state at `useCall.ts:1367`/`:1399` (rollback)                                                                                                                                                          | Device: upgrade + decline + rollback                         |
| W3  | Camera flip + B-20 camera recovery                    | `flipCamera`/`recoverCamera` rely on replaceTrack keeping SDP untouched — a codec munge must not force renegotiation                                                                                                         | Device: flip mid-call, steal camera with another app, return |
| W4  | Low-bandwidth caps                                    | `[bravo.callquality]` 600k/maintain-framerate (`useCall.ts:731-750`) must survive any SDP rewrite                                                                                                                            | logcat shows both param logs                                 |
| W5  | Group calls Android↔Android                           | FrameCryptor patch + SFU codec config MUST be untouched                                                                                                                                                                      | `npm run test:crypto` + one group video call                 |
| W6  | Group call on iOS                                     | **Expected: refuses** (`useGroupCall.ts:1319-1320`, S6). Weakening this refusal to "make iOS group calls work" is a CLAUDE.md security stop-condition — the real fix is an iOS FrameCryptor port (arch-gated, separate task) | Boot iOS group call → refusal message, no plaintext call     |
| W7  | Background/resume mid-call (B-24) + CallKeep incoming | ontrack re-bind (`useCall.ts:330-344`) keyed to current handlers                                                                                                                                                             | Device: background 30s, resume                               |
| W8  | Audio-only 1:1 both cross-platform directions         | Must stay pristine — the fix is video-m-line-scoped                                                                                                                                                                          | Device pair                                                  |

**Security stop-conditions (CLAUDE.md):** no plaintext fallback anywhere, no
gate weakened, never log SDP fingerprints alongside key material, patch file
for Android untouched unless the confirmed RC demands it + arch review.

---

## 8. Gates + device matrix (run in this order)

1. `npm run test:crypto` — messenger-crypto project (remoteTileGate, call
   tests, any new sdpCodecPreference tests) — 0 failures.
2. `npm run typecheck` — ≤ 47 baseline (`.tsc-baseline.json`).
3. `npm run lint` — 0 errors on touched files.
4. Device matrix (BlueStacks/Redmi + the iPhone running `ios/build-setup`'s
   build):

| Lane | Call                                              | Expect                                             |
| ---- | ------------------------------------------------- | -------------------------------------------------- |
| M1   | Android → iPhone video                            | Both see both videos ≤3s after connect             |
| M2   | iPhone → Android video                            | Both see both videos ≤3s after connect             |
| M3   | Android → iPhone voice, iPhone upgrades to video  | Android sees iPhone video after accept             |
| M4   | iPhone → Android voice, Android upgrades to video | iPhone sees Android video                          |
| M5   | Android ↔ Android video                           | Unchanged (W1)                                     |
| M6   | Camera flip on iPhone mid-call                    | Android sees the back camera ≤2s                   |
| M7   | iPhone backgrounds 30s, resumes                   | Video resumes both ways                            |
| M8   | Group call attempt on iPhone                      | Clean refusal (W6), Android group calls unaffected |

---

## 9. Known-separate issue logged while investigating (do NOT fold into B-99)

**Group calls cannot work on iOS at all yet** — by design. The E2EE frame
cipher is Android-native only (`BravoFrameCryptorModule.kt` + the Stream
libwebrtc swap); `frameCryptorTransport.isAvailable()` is hard-false on iOS and
the refusal contract forbids plaintext-on-SFU. Shipping iOS group calls needs a
Swift FrameCryptor port against the iOS Stream/LiveKit WebRTC framework —
architecture-gated, its own bug/feature entry when scheduled.

---

## 9b. Companion loop added same day (separate bug, separate loop)

**B-98 — dead/missing back buttons app-wide** (founder screenshot: the agent
onboarding "Coverage & Services" 3/4 back chevron does nothing). Root cause +
full ~110-screen inventory + fix plan live in
[`BACK_NAV_LOOP.md`](BACK_NAV_LOOP.md) — do not fold it into this loop; it
shares no files with the call/video path.

---

## 10. Sign-off criteria (all must hold)

- [ ] §5 diagnosis ran on a real device pair; confirmed RC recorded in `sqa.md` B-99.
- [ ] Exactly one §6 fix applied, with its mandatory direct test added and failing-before/passing-after.
- [ ] All §7 watchlist rows checked, W5/W6 security rows explicitly.
- [ ] §8 gates green; M1–M8 matrix run (or the untestable lane named + why).
- [ ] No branch merged into any other branch; fix committed on `main` only.
- [ ] Diagnostic logging from §5 removed.
- [ ] `sqa.md` B-99 updated to FIXED with evidence, per the SQA logging rule.

---

## 11. Outcome log — 2026-07-17 fix session (no iPhone in the loop)

**Applied: the §6 RC-1 fix (ranked PRIMARY), preventively.** The §5 diagnosis
decision tree requires an Android+iPhone pair; no iOS device is attached to
this QA environment, so the RC could not be device-confirmed first. RC-1 was
chosen because it is (a) the ranked-primary candidate, (b) safe under every
other candidate (a preference reorder cannot regress RC-2/RC-3/RC-4), and
(c) the only candidate fixable without iOS-side observation.

**Landed:**

- NEW `src/modules/messenger/webrtc/sdpCodecPreference.ts` — pure
  `preferVp8OnVideoMLine(sdp)`: reorders the `m=video` payload list so VP8 +
  its rtx lead; H264 retained; attributes/audio byte-identical; returns input
  unchanged on any anomaly (never throws into call setup).
- Wired at all three local-description seams in `peerConnection.ts`
  (`createOffer`, `createRestartOffer`, `createAnswerAndApply` — the legacy
  `acceptOffer` funnels through the latter). Group/SFU path untouched
  (mediasoup does not use this wrapper); the Android FrameCryptor patch
  untouched.
- Tests: `src/modules/messenger/__tests__/sdpCodecPreference.test.ts` (9 —
  H264-first reorder, nothing stripped, rtx pairing + ssrc-group intact,
  audio byte-identical, no-op on VP8-first/no-VP8/audio-only/malformed,
  idempotent, bare-LF tolerated). ⚠ Fixtures are faithful libwebrtc SHAPES,
  not live captures — capture real Android+iOS SDPs when the device pair
  exists and pin them into the fixtures.

**Gates:** messenger-crypto 187 suites / 1653 tests green (W5) · tsc 46 =
baseline · eslint clean on touched files. **Android live smoke:** outgoing
1:1 VIDEO call booted on-device with the munge active — CallScreen reached
CALLING…/DTLS-SRTP (native `setLocalDescription` accepted the reordered
offer; a malformed munge fails the call instantly).

**Owed when an iPhone joins the loop (per §10 sign-off):** the §5 stats
diagnosis to CONFIRM RC-1 was the live candidate (if the symptom persists on
1.0.116+, run the tree — RC-2/RC-3 remain open), the M1–M8 device matrix
(M1/M2/M3/M6/M7 need the pair; M5/M8 Android-only rows re-checkable any
time), and real-capture SDP fixtures. W1 (Android↔Android video pair) was
not re-run on devices this session — one emulator attached; covered by the
no-op fixture test + unchanged crypto suite.
