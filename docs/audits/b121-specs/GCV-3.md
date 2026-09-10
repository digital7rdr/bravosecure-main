# GCV-3 - Android `onDimensionsChange` emits unrotated capture dims (iOS/Android aspect-parity break)

## Verdict

**CONFIRMED-WITH-DRIFT** — the native defect is real and exactly where the audit said, but its
stated _symptom_ ("renders 90°-wrong and crops ~44%") is wrong, and the defect is currently
**latent** (no live consumer path) because of the BS-GC-BLACKVIDEO wrapper pin.

Evidence from the current tree:

1. `node_modules/react-native-webrtc/android/src/main/java/com/oney/WebRTCModule/WebRTCView.java:277-278`
   dispatches the callback arguments **verbatim**:
   ```java
                        params.putInt("width", videoWidth);
                        params.putInt("height", videoHeight);
   ```
   inside `onFrameResolutionChanged(int videoWidth, int videoHeight, int rotation)` (`:249`). The
   `rotation` argument is stored (`:257-260`) and then **never used on the JS dispatch path**.
2. The same file proves those values are unrotated capture-buffer axes — `onLayout` has to correct
   them before it can compute an aspect, `WebRTCView.java:331-332`:
   ```java
                        float frameAspectRatio = (frameRotation % 180 == 0) ? frameWidth / (float) frameHeight
                                                                            : frameHeight / (float) frameWidth;
   ```
   If `frameWidth/frameHeight` were already display-oriented this correction would itself be a bug.
3. The patch file the audit points at, `patches/react-native-webrtc+125.0.12.patch`, contains only
   two hunks — the FrameCryptor accessors in `WebRTCModule.java` and the B-118
   `updateActualSize` try/catch in `CameraCaptureController.java`. **`WebRTCView.java` is not
   patched at all**, so nothing in the app corrects this today.
4. Sole consumer: `src/components/FlexibleVideoTile.tsx:71-77` —
   `const next = w / h; setRatio(...)`, fed straight into
   `{aspectRatio: ratio, minWidth: 1, minHeight: 1}` (`:97`). No other call site
   (`CallScreen.tsx:2199/:2263` and `FloatingCallOverlay.tsx:226/:445` mount `RTCView` **without**
   `onDimensionsChange`, so the native `onDimensionsChangeEnabled` flag stays `false` there —
   `RTCVideoViewManager.java` `@ReactProp(name = "onDimensionsChange")`).

**Drift A — wrong symptom.** The frame _pixels_ are never rendered 90°-wrong. `SurfaceViewRenderer`
applies `frame.getRotation()` itself; only the **aspect number handed to JS** is transposed. The
worst case is a wrong-shaped tile _box_ (and, with `objectFit:'cover'`, extra crop) — never a
sideways image.

**Drift B — currently unreachable.** `GroupCallScreen.tsx` pins the wrapper to the measured slot
rect (`renderPersistentTile`, the `BS-GC-BLACKVIDEO` block):
`...(pos.height > 0 ? {height: pos.height} : null)`, and the inner container is
`heroFlexInner/smallFlexInner: {width: '100%', height: '100%'}`. With both width and height
resolved, Yoga ignores `aspectRatio`. And `resolveTilePositions`
(`src/modules/messenger/webrtc/groupCallLayout.ts:556-594`) now returns a **non-zero** height on
every branch, including the unmeasured fallbacks (`heroFallbackH`, `smallFallbackH`,
`gridFallbackH`) — so `pos.height > 0` always holds and the `aspectRatio` path the audit relies on
("pre-measure window, fallback rects") no longer exists. This is the same inertness GCV-2 reports:
_"`FlexibleVideoTile`'s adaptive-aspect design is inert in every measured slot"_.

Net: a genuine, correctly-located native/parity defect worth a 7-line patch as a trap-remover, but
**P3 in practice today**, and it fixes **zero** of the "dramatic zoom" complaints on its own (that
is GCV-1 + GCV-2).

## Mechanism

1. Android camera capture on a phone held portrait produces buffers in **sensor orientation** —
   typically 640×480 landscape — plus `rotation = 90` (or 270 on the front sensor with some HALs).
   Remote tracks behave the same whenever CVO (`urn:3gpp:video-orientation`) is negotiated: the
   decoder emits the unrotated buffer and the renderer rotates at draw time.
2. libwebrtc's `SurfaceEglRenderer` calls
   `rendererEvents.onFrameResolutionChanged(bufferWidth, bufferHeight, frame.getRotation())`.
3. `WebRTCView.onFrameResolutionChanged` (`:249`) caches all three under `layoutSyncRoot`, posts a
   relayout, and — when `onDimensionsChangeEnabled` — posts a JS event carrying `videoWidth` and
   `videoHeight` **without** consulting `rotation` (`:272-287`).
4. JS receives `{width: 640, height: 480}` for a stream that displays as 480×640.
   `FlexibleVideoTile` computes `ratio = 640/480 = 1.333` for a source whose true display ratio is
   `0.75`.
5. **Where it would bite:** any container that lets `aspectRatio` govern. The tile box becomes
   landscape; `objectFit:'cover'` then scales the 0.75 frame to fill a 1.333 box, cropping
   `1 - 0.75/1.333 ≈ 43.75%` of the frame height — the audit's "~44%".
6. **Why it does not bite today:** step 5's precondition is dead in `GroupCallScreen` (Drift B).
   It reactivates the moment anyone (a) reverts the wrapper-height pin, (b) reuses
   `FlexibleVideoTile` from a parent that supplies width only, or (c) adopts GCV-2 option (b),
   which puts the tile back on its natural aspect.
7. Cross-platform: iOS routes through `RTCVideoViewDelegate`
   (`node_modules/react-native-webrtc/ios/RCTWebRTC/RTCVideoViewManager.m:301-311`,
   `videoView:didChangeVideoSize:`), whose upstream callers report the **rotation-applied** size.
   So the JS contract _is_ "display dims", and Android is the platform that violates it. (The
   WebRTC ObjC renderer is a prebuilt binary framework — this parity claim is inference from the
   delegate contract, not from in-tree source. It does not change the fix, which is Android-only.)

## Fix

One native hunk. No JS behaviour change, no TS type change, no wire format, no schema, no
migration. **Requires a native rebuild (APK/EAS) — it is not OTA-able.**

### 1. `node_modules/react-native-webrtc/android/src/main/java/com/oney/WebRTCModule/WebRTCView.java`

Anchor (verbatim current code, `WebRTCView.java:271-278`):

```java
            // Call the onDimensionsChange callback if it's enabled
            if (onDimensionsChangeEnabled) {
                post(() -> {
                    try {
                        ReactContext reactContext = (ReactContext) getContext();
                        WritableMap params = Arguments.createMap();
                        params.putInt("width", videoWidth);
                        params.putInt("height", videoHeight);
```

Replacement:

```java
            // Call the onDimensionsChange callback if it's enabled
            if (onDimensionsChangeEnabled) {
                // Bravo patch (GCV-3): videoWidth/videoHeight arrive as the
                // UNROTATED capture-buffer axes — the same fields onLayout
                // below has to transpose on 90/270. JS consumes this event as
                // the DISPLAY aspect (and iOS's didChangeVideoSize already
                // reports rotated size), so transpose here for parity.
                final boolean rotatedAxes = rotation % 180 != 0;
                final int displayWidth = rotatedAxes ? videoHeight : videoWidth;
                final int displayHeight = rotatedAxes ? videoWidth : videoHeight;
                post(() -> {
                    try {
                        ReactContext reactContext = (ReactContext) getContext();
                        WritableMap params = Arguments.createMap();
                        params.putInt("width", displayWidth);
                        params.putInt("height", displayHeight);
```

Notes:

- `rotation % 180 != 0` is the exact idiom already used at `:331` and by libwebrtc's own
  `VideoFrame.getRotatedWidth()`. Do not invent a different one.
- `displayWidth`/`displayHeight` are declared `final` because they are captured by the `post(...)`
  lambda; `rotation` is a never-reassigned parameter so it is effectively final and legal to read
  outside the lambda.
- The `changed` guard (`:266`) already fires on a **rotation-only** change (`:257-260`), so a
  mid-call device rotation now correctly re-emits transposed dims. That is new, wanted behaviour.

### 2. `patches/react-native-webrtc+125.0.12.patch`

Do **not** hand-write this file. Apply the edit above to `node_modules` and regenerate so the
existing two hunks are preserved:

```
npx patch-package react-native-webrtc
```

(the dependency is aliased — `package.json:131`,
`"react-native-webrtc": "npm:@livekit/react-native-webrtc@125.0.12"` — so the patch filename stays
`react-native-webrtc+125.0.12.patch`; pass the _alias_ name, not `@livekit/...`.)

The regenerated file must gain a third hunk equivalent to:

```diff
diff --git a/node_modules/react-native-webrtc/android/src/main/java/com/oney/WebRTCModule/WebRTCView.java b/node_modules/react-native-webrtc/android/src/main/java/com/oney/WebRTCModule/WebRTCView.java
--- a/node_modules/react-native-webrtc/android/src/main/java/com/oney/WebRTCModule/WebRTCView.java
+++ b/node_modules/react-native-webrtc/android/src/main/java/com/oney/WebRTCModule/WebRTCView.java
@@ -268,14 +268,21 @@
             // surfaceViewRenderer's render Thread.
             post(requestSurfaceViewRendererLayoutRunnable);

             // Call the onDimensionsChange callback if it's enabled
             if (onDimensionsChangeEnabled) {
+                // Bravo patch (GCV-3): videoWidth/videoHeight arrive as the
+                // UNROTATED capture-buffer axes — the same fields onLayout
+                // below has to transpose on 90/270. JS consumes this event as
+                // the DISPLAY aspect (and iOS's didChangeVideoSize already
+                // reports rotated size), so transpose here for parity.
+                final boolean rotatedAxes = rotation % 180 != 0;
+                final int displayWidth = rotatedAxes ? videoHeight : videoWidth;
+                final int displayHeight = rotatedAxes ? videoWidth : videoHeight;
                 post(() -> {
                     try {
                         ReactContext reactContext = (ReactContext) getContext();
                         WritableMap params = Arguments.createMap();
-                        params.putInt("width", videoWidth);
-                        params.putInt("height", videoHeight);
+                        params.putInt("width", displayWidth);
+                        params.putInt("height", displayHeight);

                         // Send the event through React Native's event system
                         reactContext.getJSModule(RCTEventEmitter.class)
```

Then re-run `npm install` (or `npx patch-package`) on a clean `node_modules` to prove the patch
applies with zero fuzz before committing.

### 3. Back-compat

- **No wire field, no persisted field.** In-process native→JS view event only.
- **New native + old JS bundle:** the event payload keys are unchanged (`width`, `height`); only
  their values are corrected. `RTCView.ts:83`'s type
  `onDimensionsChange?: (event: {nativeEvent: {width: number; height: number}}) => void` is
  untouched.
- **Old native (shipped APKs) + new JS:** identical to today's behaviour — unrotated dims, tile
  aspect still overridden by the pinned slot height. No crash, no regression.
- **iOS:** unchanged. This patch touches only the Android view.

### What NOT to do

Do not "make the fix visible" by unpinning `wrapperStyle`'s height in
`GroupCallScreen.renderPersistentTile`, and do not remove the `minWidth: 1, minHeight: 1` floor in
`FlexibleVideoTile`. Those pins are the BS-GC-BLACKVIDEO / BS-GC-0x0 fixes; unpinning re-opens the
black-tile class (`BLASTBufferQueue ... rejecting buffer`) documented in both files. GCV-2 owns the
"should the tile flex at all?" product decision; GCV-3 is only "when it does flex, flex to the
right number."

## Blast radius

- **Edited:** `patches/react-native-webrtc+125.0.12.patch` (+1 hunk) and its generated target
  `node_modules/.../WebRTCView.java` (not repo-tracked).
- **Runtime reach:** `WebRTCView.onFrameResolutionChanged` → `onDimensionsChange` → the _only_
  subscriber `src/components/FlexibleVideoTile.tsx` (`onDims`) → the only mounting screen
  `src/screens/messenger/GroupCallScreen.tsx:1618` (`renderPersistentTile`). `CallScreen`,
  `FloatingCallOverlay`, and every ops-console surface are untouched (they never set the prop, so
  `onDimensionsChangeEnabled` stays `false` and the new code never executes for them).
- **Not touched:** `onLayout` (already rotation-correct), `requestSurfaceViewRendererLayout`,
  `SurfaceViewRenderer` scaling, the FrameCryptor hunk, `CameraCaptureController` (B-118 hunk).
- **Overlapping findings — sequence matters:**
  - **GCV-2** decides whether `FlexibleVideoTile`'s aspect path lives or dies. If GCV-2 picks
    option (a) ("delete the dead adaptive machinery"), this patch becomes correct-but-unused —
    still worth keeping for iOS/Android parity, but land GCV-3 **first** so the deletion decision
    is made against correct numbers. If GCV-2 picks option (b) (`objectFit:'contain'` / natural
    aspect for the self tile), GCV-3 is a **hard prerequisite** — shipping (b) without it makes the
    self tile visibly landscape-boxed on Android.
  - **GCV-1** (pin `LOCAL_VIDEO_CONSTRAINTS` at every re-acquisition site) changes _which_
    capture dims arrive but not their orientation semantics — independent, no textual conflict.
  - **GCV-4** edits `GroupCallScreen.tsx:1620` (`mirror={isSelf}`) — different file, but the same
    APK build. Batch them.
  - Any other finding that regenerates `patches/react-native-webrtc+125.0.12.patch` must
    regenerate **after** this one lands, or the hunks fight. Right now no other finding touches it.
- **Regression risk:** essentially confined to a mis-signed transpose (see Risk). A native rebuild
  is required, so this cannot ship in a JS-only OTA — flag it in the release notes with GCV-1/4.

## Tests

Follow the existing native-source-scanning precedent,
`src/modules/messenger/__tests__/frameCryptorParity.test.ts` (jest project **`messenger-crypto`**,
reads repo files with `fs`/`path` off a `REPO = path.resolve(__dirname, '..','..','..','..')` root).

### New — `src/modules/messenger/__tests__/webrtcViewRotationPatch.test.ts` (project `messenger-crypto`)

Assertions:

1. `patches/react-native-webrtc+125.0.12.patch` contains the WebRTCView hunk:
   - `expect(patch).toContain('WebRTCModule/WebRTCView.java')`
   - `expect(patch).toContain('+                final boolean rotatedAxes = rotation % 180 != 0;')`
   - `expect(patch).toContain('+                        params.putInt("width", displayWidth);')`
   - `expect(patch).toContain('+                        params.putInt("height", displayHeight);')`
   - `expect(patch).toContain('-                        params.putInt("width", videoWidth);')`
2. The pre-existing hunks are still present (regeneration did not drop them):
   - `expect(patch).toContain('getRtpSenderById')`
   - `expect(patch).toContain('updateActualSize')`
3. The _applied_ source, when `node_modules` is installed
   (`fs.existsSync(VIEW)` guard so a source-only checkout doesn't fail):
   - `expect(view).toContain('final int displayWidth = rotatedAxes ? videoHeight : videoWidth;')`
   - `expect(view).not.toMatch(/params\.putInt\("width",\s*videoWidth\)/)` — the raw dispatch must
     be gone.
   - `expect(view).toContain('(frameRotation % 180 == 0) ? frameWidth / (float) frameHeight')` —
     the rotation-aware `onLayout` is untouched.

### New — `src/components/__tests__/FlexibleVideoTile.test.tsx` (project `app`, alongside `BravoAlertHost.test.tsx`)

Pins the JS half of the contract ("the event carries **display** dims") so a future native
regression is caught at the seam. Mock `react-native-webrtc`'s `RTCView` to a host string, render
with `react-test-renderer`, then:

1. Default before any event: wrapper style resolves `aspectRatio` to `16 / 9`.
2. Fire `onDimensionsChange({nativeEvent: {width: 480, height: 640}})` → wrapper `aspectRatio` is
   `0.75` (portrait). This is the value the patched native side now delivers for a 640×480@rot90
   capture; pre-patch it would have been `1.333`.
3. Guard rails already in the component, worth pinning while we are here:
   `{width: 0, height: 0}` and `{width: undefined}` leave the ratio unchanged; changing
   `streamURL` resets to `16 / 9`.
4. `minWidth: 1, minHeight: 1` survive in the merged style (BS-GC-0x0 floor).

### Existing suites to re-run (no changes expected)

- `npx jest src/modules/messenger/__tests__/groupCallLayout.test.ts` — `resolveTilePositions`
  heights are the reason this defect is latent; prove they are still non-zero.
- `npx jest src/modules/messenger/__tests__/GroupCallScreen.autopop.test.tsx`
  (it already does `jest.mock('@components/FlexibleVideoTile', () => 'FlexibleVideoTile')`).
- `npm run test:crypto` (messenger-crypto project regression) and `npm run typecheck`
  (baseline 47 — this change adds no TS, so the count must be unchanged).

### Device gate (the only test that actually proves it)

Cannot be verified in this environment — no Android device/emulator attached, and the change is
native. On a real device:

1. `npm run apk:staging`, install, start a **group video call** holding the phone portrait.
2. Temporarily add `Log.d(TAG, "dims " + videoWidth + "x" + videoHeight + " rot=" + rotation)` at
   the top of `onFrameResolutionChanged`, `adb logcat -s WebRTCModule`. Expect
   `dims 640x480 rot=90`. **If it prints `dims 480x640 rot=90`, this whole fix is inverted — stop
   and delete it.** Remove the log before committing (Java is outside `logAudit.test.ts`'s TS
   scan, but it still must not ship).
3. Flip to the rear camera and rotate the device mid-call; confirm the event re-fires with
   transposed dims and no tile flicker.
4. Confirm no black/blank tile regression (BS-GC-BLACKVIDEO watchlist) and no
   `BLASTBufferQueue ... rejecting buffer` in logcat.

## Risk

1. **The transpose could be backwards.** Everything hinges on libwebrtc 125.6422.04's
   `SurfaceEglRenderer` passing `frame.getBuffer().getWidth()` rather than
   `frame.getRotatedWidth()`. The AAR is a binary (`io.github.webrtc-sdk:android:125.6422.04`,
   `node_modules/react-native-webrtc/android/build.gradle:34`) — **no source was read for this
   spec**. The in-tree proof is circumstantial but strong: `onLayout:331-332` transposes the very
   same cached fields, which would be a bug if they were pre-rotated. A reviewer must not accept
   this on inference alone — the §Tests device probe (step 2) is the gate, and it is cheap.
   Double-transposing would turn a latent defect into a live one.
2. **The fix is currently invisible.** Do not let anyone "verify" it by looking at the group-call
   grid — the wrapper pin makes the tile box identical before and after. Anyone who tries to make
   the change visible will be tempted to unpin the height, which re-opens the black-tile class
   (five-times-shipped-bug energy). Verification is the logcat probe + the unit pins, not the eye.
3. **Audit-severity inflation.** GCV-3 is filed P2 with a "~44% crop / 90°-wrong" symptom. Neither
   is reachable in the current tree, and the pixels are never rotated wrong. If someone is
   triaging by symptom they will expect this patch to fix the founder's "dramatic zoom" complaint —
   it will not. That complaint is GCV-1 (capture constraint drift 640×480 → 1280×720) plus GCV-2
   (fixed-rect + `cover`). Ship GCV-3 as hygiene, not as the cure.
4. **patch-package fragility.** A hand-edited `.patch` with a miscounted `@@` header applies with
   fuzz or silently no-ops on some patch-package versions. Regenerate, then wipe `node_modules` and
   reinstall to prove clean application. Also confirm the two existing hunks survived — the
   `CameraCaptureController` hunk carries fake blob hashes (`index 0000000..1111111`), which is
   fine for patch-package but means a naive `git apply` of the file will fail; do not "fix" those
   hashes as a drive-by.
5. **Native rebuild required.** This does not reach users through a JS OTA. If the release lane
   assumes JS-only shipping, the patch sits in the repo doing nothing and a later "why didn't this
   work?" cycle follows.
