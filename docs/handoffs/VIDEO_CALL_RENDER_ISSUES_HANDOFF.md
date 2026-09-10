# Video-Call Render Issues — 1:1 + Group ("we can't see each other's video")

> **Date:** 2026-07-03 · **HEAD:** `b6660c3` (v1.0.89, vc114 — the build the issues were investigated on) · **Status:** ✅ **ALL FIXES IMPLEMENTED 2026-07-03** (same-day follow-up) — shipped in v1.0.90 (vc115). See the implementation addendum at the end of this file.
>
> **Purpose:** self-contained fix spec. A future session should be able to fix everything below **without re-exploring the codebase** — every cause is cited to file:line with the code quoted, ranked by likelihood, with concrete fix steps and tests. Devices used for evidence: Redmi Note 11 (`043dd12e3dad`, USB) ↔ BlueStacks (`127.0.0.1:5555`), group call at 11:06 local on 2026-07-03, roomId `793559a9…`.

---

## 0. TL;DR — what is actually wrong

**Plain English:** the plumbing that moves video between phones is (mostly) fine — in the observed group call the emulator was _receiving and decrypting the phone's video at 10 fps the whole time_. What's broken is the **last inch**: the screen-side bookkeeping that decides which tiles to draw and when. Two render-cache bugs in the group call screen can keep a perfectly-decoding video invisible (especially in exactly the 2-person, quiet-room setup used for testing), and in 1:1 calls a handful of state-tracking holes (a lost "camera on/off" message with no recovery, and React state going stale after minimize/restore) hide live remote video behind placeholders.

| #   | Where                                   | Bug                                                                                                                                                                                                                                | Severity |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| G-A | Group — `GroupCallScreen.tsx:526-546`   | merged-tile cache signature omits `paused` → in a 2-party call a camera-toggle state change is swallowed **forever** (frozen frame, or avatar-forever while video decodes)                                                         | **HIGH** |
| G-B | Group — `GroupCallScreen.tsx:541-543`   | loudest-speaker debounce returns the stale cached array with **no scheduled recompute** → a joiner's video tile can stay unmounted indefinitely in a **silent** call (typical desk test: phone next to emulator, mics muted/quiet) | **HIGH** |
| O-A | 1:1 — media-state signaling             | a lost `call.media-state` frame leaves `remoteVideoOff=true` forever → "Camera off" placeholder hides live remote video; **no recovery path exists**                                                                               | **HIGH** |
| O-B | 1:1 — minimize/restore                  | after restore, a peer-initiated video upgrade updates a **dead** React closure → layout never flips to video, remote video never mounts (heals only on a 2nd minimize/restore)                                                     | **HIGH** |
| O-C | 1:1 — ring-minimize→restore→accept      | the answerer's PC is built by instance-1's frozen factory → `ontrack` feeds dead state → remote stream never reaches the restored UI                                                                                               | MED-HIGH |
| O-D | 1:1 — upgrade watchdog                  | initiator rolls back a slow upgrade at 10 s but never tells the responder → responder shows a **full-screen black** tile bound to a track that will never flow                                                                     | MEDIUM   |
| G-C | Group — stall recovery                  | consumer-rebuild churn has no attempt cap (audit GC-02 still unimplemented) → indefinite blank/blink loop when a sender genuinely stalls                                                                                           | MEDIUM   |
| O-E | 1:1 — `FloatingCallOverlay.tsx:172-198` | the CALL-N2 gate was never applied to the minimized overlay → black card when peer is audio-only/camera-off                                                                                                                        | LOW-MED  |
| O-F | 1:1 — `CallScreen.tsx:1982`             | B-16's "remount on remote track-id change" half was never implemented (key only flips on audio↔video)                                                                                                                              | LOW      |

**Already fixed at HEAD — do NOT re-fix (§5):** CALL-N1, CALL-N2 (main screen), CALL-N3, and the whole GC-01/SFU-01 group video-toggle ack machinery (code + tests + deployed container all verified).

---

## 1. Device evidence (what we know from the 2026-07-03 11:06 group call)

Reconstructed from the emulator's logcat (`ReactNativeJS` + `org.webrtc` tags survive in this release build; the phone's main log buffer had rotated — MIUI spam — so the phone side is blind except teardown):

```
11:06:11  [bravo.groupcall.sframe] audio/video producer attached (FrameCryptor)   ← emulator joined FIRST
11:06:11  [bravo.groupcall.boot] step=9 consuming 0 existing producer(s)
11:06:13  [bravo.groupcall.frame] participant.joined tag=09ccf0fc                 ← phone joined
11:06:14  new-producer tag=09ccf0fc kind=audio pid=edf8c0ea → consumer attached (FrameCryptor)
11:06:14  new-producer tag=09ccf0fc kind=video pid=d7c76367 → consumer attached (FrameCryptor)
11:06:15  [bravo.groupcall.decode] frames 09ccf0=0
11:06:18…30  decode counter 30 → 59 → 94 → 131 → 168   (≈10 fps, continuous)
11:06:32  (phone hangs up — its PCs close at 11:06:32.1)
11:06:34  VideoTrackAdapter: Mute event (remote track)                            ← consequence of the hang-up, NOT a defect
11:06:36  [bravo.groupcall.leave] tearing down roomId=793559a9…
```

What this **proves** (see `useGroupCall.ts:2804-2813` — the counter is per-tag `framesDecoded` from `getStats`):

- consume → SFrame `FrameCryptor` attach → `sfu.consumer.resume` all succeeded (a paused consumer ships no RTP; a GCM key mismatch drops frames pre-decoder — either would flatten the counter);
- the phone's video RTP was flowing and **decrypting continuously**;
- EglRenderer stats show an RTCView painting at 10-13.7 fps in the same window, so at least one video plane rendered.

What it **rules out**: native FrameCryptor unavailability (boot would hard-fail), SFrame key/epoch desync (counter rose), missing consumer resume, TURN/ICE media failure.

What it **cannot show**: whether the decoded frames were _visible on screen_ (visibility is decided downstream in `GroupCallScreen`'s merged-tile cache — exactly where G-A/G-B live), and everything about the phone side (the phone joined second, so it ran the _existing-producers_ consume path — different from the new-producer path we watched work on the emulator; G-B specifically bites the member that consumes a later joiner).

**To capture both sides next time** (JS logs are enough, no debug build needed):

```powershell
adb -s 043dd12e3dad logcat -c; adb -s 043dd12e3dad logcat -s ReactNativeJS:* *:S > phone.txt
adb -s 127.0.0.1:5555 logcat -c;  adb -s 127.0.0.1:5555  logcat -s ReactNativeJS:* *:S > emu.txt
```

Grep for `bravo.groupcall.decode` (frames decrypting), `bravo.groupcall.frame` (producer events), `producer-paused/resumed`, and on 1:1 `call.media-state` markers.

---

## 2. The remote-video pipelines (map, verified at `b6660c3`)

### 2.1 Group (SFU + SFrame)

- **Server** `apps/messenger-service/src/sfu/sfu.service.ts`: `produce()` `:419-444` fans `sfu.new-producer`; `joinRoom()` `:203-288` returns `existingProducers` (incl. `paused`) via `snapshotProducers()` `:685-708`; `consume()` `:478-482` creates consumers **`paused: true`** (response carries `producerPaused` `:500`); `resumeConsumer()` `:532-551` resumes + `requestKeyFrame()`; `setProducerPaused()` `:513-530` fans `sfu.producer-paused/-resumed`. Gateway handlers `messenger.gateway.ts:1280-1478`; event-less ack helper `sfuError()` `:111-113`.
- **Client** `src/modules/messenger/webrtc/useGroupCall.ts`: frame handler `:1049-1192` (early-producer buffer) → `consumeProducer` `:2038-2072` → `attemptConsume` `:2077-2253` (consume → `attachReceiverCryptor` fail-closed → `sfu.consumer.resume` `:2162-2164` → tile into `remoteTiles`); 4 s `reconcileProducers` backstop `:2270-2421` (incl. GC-01 intended-pause re-assert `:2344-2359`); stats poller `:2736-2888` (decode counter, 3 s stall detect, keyframe re-request, consumer rebuild ≥8 s `:2823-2853` → `rebuildVideoConsumer` `:3053-3080`).
- **Render** `src/screens/messenger/GroupCallScreen.tsx`: `merged` memo `:506-547` (mergeAndSortTiles + hero-hold + **the buggy cache**) → pagination → `renderPersistentTile` `:1517-1690`; the video plane mounts only when `entry.tile.video && !entry.tile.video.paused` (`:1529-1533`).
- **E2EE**: `frameCryptorOrchestrator.ts` → native `BravoFrameCryptorModule.kt` (AES-GCM per `(participantTag, epoch)`; keys HKDF'd from `groups[convoId].masterKeyB64` — `frameCryptorKeys.ts:59-90`).

### 2.2 1:1 (P2P, relay-only TURN)

- `ontrack` is bound in the wrapped PC factory — `src/modules/messenger/webrtc/useCall.ts:468-487`: sets `remoteStream`, `remoteHasVideo` (from real track list), and patches the call registry.
- Render — `src/screens/messenger/CallScreen.tsx:1941-1989`: gate order is `liveMode/isVideoUI` → **`remoteVideoOff` (placeholder)** → `remoteHasVideo` (avatar) → `<RTCView key={remote-video|audio} streamURL … zOrder={0}>`. Local PiP `:2041-2048` (`zOrder={1}`); no local/remote swap path exists.
- Layout flag `isVideoUI` `:527-529` = route `callType` ∨ `peerAddedVideo` ∨ local video tracks.
- Camera/mic advisory: `call.media-state` — sent from `useCall.ts:1018/:1068/:1088/:1116/:1286`, relayed unqueued by the server (`messenger.gateway.ts:1183-1208`), applied at `useCall.ts:770-784` (fresh) / `:347-365` (adopt re-bind).
- Upgrade voice→video: re-offer/re-answer via `callController.ts` (watchdog default 10 s `:672`, rollback `:711-718`); CALL-N3 gate `:766-794` fires `onRemoteRenegotiation` only when the SDP has `m=video`.

---

## 3. GROUP findings — why each happens + how to fix

### G-A (HIGH, NEW) — merged-cache signature omits `paused`: toggle state swallowed forever in 2-party calls

`GroupCallScreen.tsx:526-546`:

```ts
const sig = arr.map(t => `${t.tag}:${t.audio ? 1 : 0}${t.video ? 1 : 0}`).join('|');
...
if (cache) {
  const sigMatches = cache.sig === sig;
  ...
  if (sigMatches) {
    return cache.arr;      // ← OLD MergedTile objects, OLD `paused`, cache never refreshed
  }
```

- The signature encodes tag order + track **presence** only. A `sfu.producer-paused/-resumed` frame updates the hook state correctly (`useGroupCall.ts:1084-1093`), but presence doesn't change → identical sig → the memo returns the **old array with the old `paused` value** — and the sig-match path never updates the cache, so it can never converge.
- In a 2-party call there is exactly one remote entry, so the order can _never_ change → **permanent**.
- `renderPersistentTile` reads `entry.tile.video.paused` (`:1531`) from those stale objects. Two user-visible variants:
  1. peer toggles camera **off** → tile freezes on the last frame (no avatar swap);
  2. tile was consumed while `producerPaused:true` (late join, or joined mid-toggle), peer turns camera **on** → **avatar forever while the decode counter rises** — this is the closest match to "we don't see each other's video" with the observed healthy decode log.
- Why it's new-ish: it became reachable when camera-toggle moved from _close-producer_ (tile removed → sig change) to _pause-producer_ (the GC-01 design — presence unchanged). The minimized `FloatingCallOverlay` reads the live registry, so only the full screen is affected.

**Fix:** include the mutable bits in the signature — e.g. `` `${t.tag}:${a}${v}:${t.video?.paused ? 1 : 0}:${t.video?.consumerId ?? ''}` `` — so data changes mint a fresh array. The cache's job is to stabilize _order_ (hero-hold), never tile _data_. Extract the cache decision into `groupCallLayout.ts` as a pure function so it can be unit-tested (see §6 tests).

### G-B (HIGH, NEW) — loudest-speaker debounce drops a joiner's video tile with no recompute scheduled

`GroupCallScreen.tsx:541-543`:

```ts
if (sameLoudest && withinDebounce) {
  return cache.arr; // ← audio-only cached array; video tile arrived <1500ms later, swallowed
}
```

- A joining peer produces audio then video as two `sfu.new-producer` events consumed a few hundred ms apart. The audio tile writes the cache at t0; the video tile lands within the debounce window → sig differs but `sameLoudest` holds → the **audio-only array is returned and the cache is not updated**.
- The memo re-runs only when `call.remoteTiles` or `call.audioLevels` change identity; `audioLevels` only updates on a >0.04 delta (`useGroupCall.ts:2865-2873`). In a **silent** call (mics muted / two devices on one desk — the exact QA setup) that can be **never** → the remote video tile stays unmounted while consume/resume/decode all succeed.
- Asymmetry: the step-9 boot batch flushes existing producers in one update, so the _later joiner_ is fine; it's the **earlier member consuming a later joiner** that hits this — "A sees B, but B never appears on A".

**Fix:** on the debounce-return path, schedule a recompute at debounce expiry (`setTimeout` → state tick), or delete the branch entirely (hero-hold already stabilizes ordering). Same extraction as G-A makes it testable.

### G-C (MEDIUM) — consumer-rebuild churn has no cap (audit GC-02, still open)

`useGroupCall.ts:2845-2850`: while a tile is unpaused with a flat `framesDecoded`, `rebuildVideoConsumer` fires every ≥8 s per tag **forever** (only `lastRebuildByTag` rate-limits). If the sender genuinely emits nothing while the snapshot says unpaused, the receiver blanks/blinks indefinitely. **Fix:** cap rebuilds per tag (e.g. 3), then show a "camera unavailable" placeholder + slow retry probe.

### Verified healthy at HEAD (do not chase these)

- **GC-01/SFU-01 toggle machinery — FIXED and DEPLOYED.** `sfuError()` returns event-less acks (`messenger.gateway.ts:111-113`, all 15 handlers); client rejects on `r.ok === false` (`packages/messenger-core/src/transport/client.ts:228-233`); toggle retries + intended-state re-assert (`useGroupCall.ts:3258-3281`, `:2344-2359`); `sfu.producer-paused/-resumed` are in `SFU_FRAME_EVENTS` (`sfuDispatcher.ts:138-139`). Deployment: the `bravo-staging-msgr` container was rebuilt from HEAD source on 2026-07-03 (this session), so the fix is in the running image. Re-check anytime: `docker exec bravo-staging-msgr grep -q 'producer.pause' dist/gateway/messenger.gateway.js`.
- Consumers created paused + resume-with-keyframe (`sfu.service.ts:478-482`, `:532-551`; spec `sfu.service.resume-consumer.spec.ts`). Join order covered both directions (existing-producers at join + early-producer buffer + 4 s reconcile). Native FrameCryptor probe hard-fails the call rather than silently degrading. SFrame key desync would flatten the decode counter — ruled out for the observed session.

---

## 4. 1:1 findings — why each happens + how to fix

### O-A (HIGH) — stale `remoteVideoOff=true`: one lost `call.media-state` frame hides live video forever

- Render gate order puts the placeholder FIRST: `CallScreen.tsx:1942` checks `liveCall.remoteVideoOff` before `remoteHasVideo`, so a stale `true` masks a live, flowing video track behind "Camera off".
- The advisory is **fire-and-forget**: `signallingClient.ts:291-298` uses `safeSend` (no `waitOpenThenSend`, no per-callId queue — unlike reoffer/reanswer at `:234-241`); `safeSend` swallows closed-transport throws (`:136-142`). The server is a pure non-queuing relay (`messenger.gateway.ts:1183-1208`). Emitted only on toggles (`useCall.ts:1018/:1068/:1088/:1116/:1286`).
- Nothing ever reconciles: `ontrack` doesn't clear the flag; CALL-N11 _persists_ it across minimize/restore (`useCall.ts:305`, `callRegistry.ts:50`).
- Aggravator: on a voice call, toggling _mute_ emits `cameraOff:true` (no video track ⇒ `useCall.ts:1016` computes cameraOff=true); if the corrective advisory after a video upgrade (`:1286`) is the frame that gets dropped, the receiver keeps the placeholder.

**Fix (3 parts):** (1) route `sendMediaState` through the same `enqueueForCall`/`waitOpenThenSend` queue as reoffer; (2) re-emit current `{cameraOff, micOff}` on transport reconnect and after every completed renegotiation; (3) receiver-side self-heal — while `remoteVideoOff===true`, poll inbound-rtp `framesReceived` via `getStats` and clear the flag when frames flow (mirror the group stall-detector pattern).

### O-B (HIGH) — minimize→restore kills the video-upgrade path (dead `onRemoteRenegotiation` closure)

- The adopt branch re-binds `ontrack` (`useCall.ts:319-336`) and `onMediaState` (`:347-365`) onto the restored instance — but **not** `onRemoteRenegotiation`, which stays a constructor option frozen at instance-1 (`callController.ts:219`, invoked `:790`). After a restore, the peer's video upgrade calls the dead instance's `setPeerAddedVideo(true)` (`useCall.ts:612-618`) — a no-op. `isVideoUI` (`CallScreen.tsx:527-529`) never flips; the remote-video branch is unreachable. A second minimize→restore heals it (the overlay navigates with `callType: active.kind`, `FloatingCallOverlay.tsx:146`).

**Fix:** in the adopt branch, either extend the `onActiveCallChange` mirror (`useCall.ts:377-380`) to `if (st.kind === 'video') setPeerAddedVideo(true)`, or add `CallController.setOnRemoteRenegotiation(cb)` and re-bind it exactly like `ontrack`.

### O-C (MED-HIGH) — minimize during ring → restore → accept: remote stream feeds dead state

- Minimizing while ringing is supported (`CallScreen.tsx:296-316`), but at adopt time the answerer's PC doesn't exist yet (built inside `accept()`, `callController.ts:478`), so the adopt re-bind is silently skipped (`useCall.ts:320-321` — `?.pc?.raw; if (pcRaw) {...}`). When `accept()` later builds the PC it uses instance-1's frozen `wrappedFactory`, whose `ontrack` writes to the dead instance's state. Only the registry patch works, and the adopt mirror doesn't forward `remoteStream` (`:377-380`) → the restored UI keeps the avatar; a video call's full-screen remote never shows.

**Fix:** extend the adopt mirror to forward media: `setRemoteStream(st.remoteStream); setRemoteHasVideo((st.remoteStream?.getVideoTracks?.().length ?? 0) > 0)` — the registry is reliably patched by the factory closure, so mirroring it is sufficient.

### O-D (MEDIUM) — upgrade watchdog rollback never tells the responder → black full-screen tile

- A upgrades voice→video; on a slow path A's 10 s watchdog (`callController.ts:672`) rolls back (`:711-718`) and stops the camera (`useCall.ts:1296`) — but B already applied the offer: B's `ontrack` fired, `peerAddedVideo=true`, video layout mounted for a track that will never carry RTP → full-screen black on B. B's late reanswer is dropped on A (`callController.ts:832-836`), and A's rollback path emits no `sendMediaState` (`useCall.ts:1290-1309`).

**Fix:** emit `sig.sendMediaState(callId, peer, /*cameraOff*/ true, micOff)` in the rollback path (the placeholder then correctly replaces the black tile), and let O-A's frames-received self-heal cover the class generically.

### O-E (LOW-MED) — `FloatingCallOverlay` never got the CALL-N2 gate

`FloatingCallOverlay.tsx:172-198`: `oneToOneRemoteHasVideo` is used only as a **key**; `active.remoteVideoOff` (available in the registry since CALL-N11, `callRegistry.ts:50`) is never consulted → the minimized card is black when the peer is audio-only or camera-off. **Fix:** apply the same placeholder/avatar/RTCView gate as `CallScreen.tsx:1941-1989` (best done by extracting that decision into a shared pure helper).

### O-F (LOW) — B-16's track-id remount half never landed

`CallScreen.tsx:1982`: `key={remote-${remoteHasVideo ? 'video' : 'audio'}}` flips only on the audio↔video boolean. A replaced remote video track with an unchanged stream id keeps the same key → the SurfaceView never rebinds. Low likelihood at HEAD (the duplicate-m-line path is closed), but it's the documented residual of the device-confirmed B-16. **Fix:** include the remote video track id in the key.

### Verified fixed at HEAD (do not re-fix)

- **CALL-N2** main-screen gate (placeholder / avatar / RTCView, `CallScreen.tsx:1933-1971`), **CALL-N3** `m=video` gate on reoffers (`callController.ts:766-794`, regression test `webrtcSignalling.test.ts:361-387`; tiny residual: the gate tests _presence_ not _newly-added_ — after any video era, every ICE restart re-fires `onRemoteRenegotiation`, now only causing a spurious "peer turned on video" alert), **CALL-N1** adopt-before-guard (`useCall.ts:274-282`) — all landed in `fffe40a` (v1.0.87+).

---

## 5. Why this matched the user's test exactly

Two devices, one desk, mics effectively silent, 2-party group call, camera toggles while testing:

- G-B: the earlier member consumes the later joiner's audio-then-video within the debounce and, with no audio-level deltas, never recomputes → **one side never shows the other's tile**.
- G-A: any camera toggle during the call flips `paused` invisibly (2-party order can't change) → **frozen frame or stuck avatar from then on**, even though decode continues (exactly what the 11:06 log shows: decoding fine on the emulator; user still reports "can't see each other").
- 1:1: O-A/O-D produce "Camera off"-placeholder-over-live-video and black-tile-after-failed-upgrade variants; O-B/O-C require a minimize/restore in the flow.

---

## 6. Fix plan (order) + tests

| Wave | Items                                                                                                                                                      | Scope                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1    | G-A + G-B (extract the merged-cache decision into `groupCallLayout.ts` as a pure `(prevCache, arr, now) → {arr, nextCache}`; fix sig + debounce recompute) | client-only, one screen                         |
| 2    | O-A (queued media-state + reconnect re-emit + frames-received self-heal) and O-D (rollback advisory)                                                       | client (+ no server change — relay stays as-is) |
| 3    | O-B + O-C (adopt-mirror forwards `kind` + `remoteStream`)                                                                                                  | client                                          |
| 4    | O-E (shared remote-tile gate helper, applied to overlay), G-C (rebuild cap + placeholder), O-F (track-id in key)                                           | client                                          |

**New tests** (the render-layer bugs survived precisely because nothing tests these seams):

1. `groupCallLayout` cache: (a) `paused` flip with unchanged order returns a NEW array with the flag; (b) consumerId swap invalidates; (c) audio-then-video within the debounce is re-emitted at expiry; (d) order-churn inside the window keeps the stable reference.
2. RN render test: `producer-resumed` after a paused consume swaps avatar → RTCView in a 1-remote call.
3. `webrtcSignalling.test.ts`: watchdog rollback emits corrective `call.media-state{cameraOff:true}`; `sendMediaState` rides the per-callId queue.
4. Adopt-mirror unit: registry `remoteStream`/`kind` changes propagate into a freshly adopted hook instance.
5. Pure remote-tile gate helper: all four states (placeholder / avatar / RTCView / null) — reused by CallScreen + overlay.
6. Frames-received self-heal clears `remoteVideoOff` (mirror `groupCallVideoStall.test.ts`).

Gates per CLAUDE.md: `npm test -- --selectProjects=app` (webrtc suites), `npm run test:crypto` untouched, typecheck ≤ baseline; 2-device manual smoke: 2-party group call with camera toggles both directions **in silence**; 1:1 voice→video upgrade both directions; camera toggle during a WS blip (airplane-mode flick); minimize-during-ring→restore→accept.

## 7. Device verification script (after fixes)

1. Group call phone ↔ emulator, both cameras ON, **mics muted**, join one after the other → both tiles must show video within ~2 s on BOTH devices (kills G-B).
2. In-call: toggle camera off→on on each side twice → the other side must swap avatar↔video every time (kills G-A; watch `producer-paused/resumed` in the JS log).
3. 1:1 video call → mid-call flick airplane mode 3 s on the sender → after reconnect the receiver must NOT be stuck on "Camera off" (kills O-A).
4. 1:1 voice call → minimize → restore → peer turns camera on → layout flips to video and remote video renders (kills O-B).
5. Incoming video call → press back while ringing → restore from the green bar → accept → remote video visible (kills O-C).
6. BlueStacks caveat: no audio hardware and a synthetic 640×480 camera — video assertions are valid, audio-level/EQ assertions are not (see sqa.md "Non-Bugs — Expected on BlueStacks").

## 8. Implementation addendum (2026-07-03, same-day)

Every finding in §0 was fixed, client-only (no server change was needed, as predicted):

- **G-A + G-B** — the merged-tile cache was extracted to pure functions in `groupCallLayout.ts`
  (`resolveMergedCache`, `mergedTileSignature` split into order + data halves). Semantics are now:
  DATA changes (paused flip / rebuilt consumerId / a tag's track appearing) bypass the debounce and
  surface immediately; only pure ORDER churn is debounced, and a withheld ordering returns a
  `recomputeAtMs` deadline that `GroupCallScreen` honours with a one-shot timer (so silent calls
  converge). 15 unit tests in `groupCallMergedCache.test.ts`.
- **O-A** — `sendMediaState` now rides the per-callId queue + wait-open (was a bare `safeSend`);
  the 1s stats poller re-asserts our camera/mic advisory after a transport reconnect AND self-heals a
  stale `remoteVideoOff` when inbound video `framesReceived` advances (≥3 frames/tick). 3 new tests in
  `webrtcSignalling.test.ts` (delivery-after-blip, ordering behind a reoffer, best-effort timeout).
- **O-B + O-C** — the adopt branch's `onActiveCallChange` mirror now forwards `kind` (→
  `setPeerAddedVideo`), `remoteStream` (→ `setRemoteStream`/`remoteHasVideo`), and
  `remoteVideoOff`/`remoteMuted` into the restored hook instance, so registry patches from
  instance-1's frozen closures reach the live screen.
- **O-D** — the `upgradeToVideo` rollback path emits a corrective `cameraOff:true` advisory so the
  responder's black tile becomes the honest placeholder.
- **O-E + O-F** — the remote-tile mount decision was extracted to `webrtc/remoteTileGate.ts`
  (`resolveRemoteTile`: camera-off → avatar → none → video, keyed by the remote video TRACK id) and
  applied to BOTH CallScreen and FloatingCallOverlay (which previously mounted off `streamURL` alone —
  black card for audio-only/camera-off peers). 8 unit tests in `remoteTileGate.test.ts`.
- **G-C** — consumer rebuilds are capped at 3 fast attempts per tag, then slow to one 60s probe
  (the stalled-tag overlay stays up); a recovery resets the budget.

**Gates at ship time:** crypto project 1200/1200 (137 suites), full mobile suite 1505 pass,
tsc 46 vs baseline 49. Shipped in **v1.0.90 (vc115)**.

**Pending device QA:** the §7 verification script (silent 2-party group call, camera toggles both
directions, airplane-mode blip during a 1:1 video call, minimize/restore flows).

## 9. Related documents

- `docs/audits/MESSENGER_FULL_AUDIT_2026-07-02.md` — CALL-N1/N2/N3, GC-01/SFU-01, GC-02 (this doc records which of those are now fixed at HEAD and which residuals remain).
- `sqa.md` — B-16 (original remote-video render race, ~line 2634), B-19 (tile geometry), Device & Identity Reference, "Non-Bugs (Expected on BlueStacks)".
- `docs/handoffs/GROUP_ADD_VISIBILITY_AND_DELIVERY_GAPS_HANDOFF.md` — same-day messaging-layer fixes (unrelated code paths, same build v1.0.89).
