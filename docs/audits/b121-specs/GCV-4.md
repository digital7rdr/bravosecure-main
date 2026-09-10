# GCV-4 - Group-call self tile stays mirrored after flipping to the rear camera

## Verdict

**CONFIRMED** (audit line number is exact; mechanism verified end-to-end).

- `src/screens/messenger/GroupCallScreen.tsx:1620` — inside `renderPersistentTile`, the self tile renders
  `mirror={isSelf}` with no facing term:
  ```
  <FlexibleVideoTile
    streamURL={videoUrl}
    mirror={isSelf}
  ```
- The correct pattern already exists in the 1:1 screen — `src/screens/messenger/CallScreen.tsx:2268`
  `mirror={cameraFacing === 'front'}`, derived at `CallScreen.tsx:675`
  `const cameraFacing: 'front' | 'back' = liveCall.facing === 'user' ? 'front' : 'back';`
- The truth signal is **already exposed** by the group hook, so no plumbing is needed:
  `src/modules/messenger/webrtc/useGroupCall.ts:251-252` — `/** True when the local camera is the front (selfie) lens. Flipped by switchCamera. */ isFrontCamera: boolean;`
  and it is in the returned object at `useGroupCall.ts:4192` — `isMuted, isVideoOff, isFrontCamera,`.
- The flip actually mutates it: `useGroupCall.ts:3857` — `setIsFrontCamera(prev => !prev);` inside `switchCamera`.
- The flip is wired to a live control: `GroupCallScreen.tsx:1244-1253` `handleFlipCamera` → `call.switchCamera()`,
  button at `GroupCallScreen.tsx:2041-2044` (`Icon="camera-flip-outline"`).
- `mirror` reaches the native view unconditionally — `src/components/FlexibleVideoTile.tsx:106` `mirror={mirror}` on `RTCView`.

Net: flip to rear lens → `isFrontCamera` goes false → the self tile keeps `mirror=true` → the user sees the
rear-camera scene horizontally flipped (text on signage reads backwards) for the rest of the call. Remote
participants are unaffected (mirror is render-only, never encoded).

## Mechanism

1. User joins/upgrades a group video call. `useGroupCall` acquires `facingMode:'user'` and seeds
   `const [isFrontCamera, setIsFrontCamera] = useState(true);` (`useGroupCall.ts:340`).
2. Self tile renders through `renderPersistentTile` → `FlexibleVideoTile` with `mirror={isSelf}` — i.e.
   hardcoded `true` for the self entry (`entry.kind === 'self'`).
3. User taps Flip. `handleFlipCamera` calls `call.switchCamera()`, which calls the track's non-standard
   `_switchCamera()` in place (same `MediaStreamTrack` identity, so the mediasoup producer + SFrame
   FrameCryptor stay attached — `useGroupCall.ts:3838-3843`) and flips `isFrontCamera` to `false`.
4. GroupCallScreen re-renders (the hook state lives in this component), `renderPersistentTile` runs again,
   but `mirror={isSelf}` is still `true`. `RTCView` keeps `setMirror(true)`.
5. The rear-camera preview is shown mirrored. Selfie-mirroring is only correct for the front lens; for the
   rear lens it is the "wrong-handed world" bug (reversed text, reversed gestures).

Also note the streamURL never changes across a flip (same track/stream id), so nothing else in the tile
re-keys — there is no incidental remount that could mask the bug.

## Fix

Two files. One behavioural line + one 3-line pure helper so the behaviour is unit-testable in the
existing `messenger-crypto` jest project (this exactly mirrors the precedent set by `cameraOn`, the other
self-tile UI decision already extracted from this same screen).

### 1. `src/modules/messenger/webrtc/groupCallLayout.ts`

Anchor (verbatim, currently at ~line 67-76):

```ts
/**
 * Self-camera truth for the preview tile + the VIDEO/FLIP controls.
 * Keys on the LIVE local video track, never on the static callType
 * route param — an audio call upgraded mid-call has a video track
 * while callType stays 'voice', and the old `callType === 'video'`
 * gate hid the user's own preview even though peers received video.
 */
export function cameraOn(isVideoOff: boolean, localVideoTracks: number): boolean {
  return !isVideoOff && localVideoTracks > 0;
}
```

Insert immediately AFTER `cameraOn` (do not modify `cameraOn`):

```ts
/**
 * Selfie-mirror truth for a call tile. Mirroring is only correct for the
 * user's OWN front (selfie) lens — a rear-lens preview must render
 * un-mirrored, and a remote participant's frame is never mirrored.
 * Matches CallScreen's `mirror={cameraFacing === 'front'}`.
 */
export function shouldMirrorTile(isSelf: boolean, isFrontCamera: boolean): boolean {
  return isSelf && isFrontCamera;
}
```

### 2. `src/screens/messenger/GroupCallScreen.tsx`

**2a — import.** Anchor (verbatim, ~line 63-71):

```ts
import {
  mergeAndSortTiles, applyHeroHold, paginateOthers, resolveTilePositions,
  buildRenderEntries, resolveTileOpacityAction, resolveMergedCache,
  isTerminalPopState, TERMINAL_POP_DELAY_MS, GROUP_CALL_MAX_PARTICIPANTS, cameraOn,
  resolveOffscreenVideoTags,
```

Replacement (only the `cameraOn,` line grows):

```ts
import {
  mergeAndSortTiles, applyHeroHold, paginateOthers, resolveTilePositions,
  buildRenderEntries, resolveTileOpacityAction, resolveMergedCache,
  isTerminalPopState, TERMINAL_POP_DELAY_MS, GROUP_CALL_MAX_PARTICIPANTS, cameraOn,
  shouldMirrorTile,
  resolveOffscreenVideoTags,
```

**2b — the tile.** Anchor (verbatim, ~line 1617-1622):

```tsx
<FlexibleVideoTile
  streamURL={videoUrl}
  mirror={isSelf}
  zOrder={0}
  containerStyle={isHero ? s.heroFlexInner : s.smallFlexInner}
/>
```

Replacement:

```tsx
<FlexibleVideoTile
  streamURL={videoUrl}
  mirror={shouldMirrorTile(isSelf, call.isFrontCamera)}
  zOrder={0}
  containerStyle={isHero ? s.heroFlexInner : s.smallFlexInner}
/>
```

Notes on why nothing else is required:

- `renderPersistentTile` is a **plain function declared in the component body** (`GroupCallScreen.tsx:1553`),
  not a `useCallback` — there is no dependency array to update.
- `FlexibleVideoTile` is a plain function component (no `React.memo`), so the prop change propagates.
- `mirror` is a settable native prop on `RTCView`; **do not** add it to any React `key`. The outer
  `<Animated.View key={tag}>` identity (Fix #13 / BS-GC-BLACKVIDEO) and the decoder/EGL surface must stay
  intact across a flip — re-keying would tear down the SurfaceView and can re-trigger the black-tile class.
- **No schema change, no migration, no wire-format change.** `isFrontCamera` is local React state; the flip
  is a purely client-side capturer swap ("Nothing crosses the wire" — `useGroupCall.ts:3841`). Old and new
  clients interoperate byte-identically; no server, no `.tsc-baseline.json` movement expected.

## Blast radius

- **Files edited:** `src/modules/messenger/webrtc/groupCallLayout.ts` (add-only), `src/screens/messenger/GroupCallScreen.tsx` (import + 1 prop).
- **Functions touched:** `renderPersistentTile` (GroupCallScreen) only. `switchCamera`, `handleFlipCamera`,
  `cameraOn`, `resolveTilePositions`, `buildRenderEntries` are all untouched.
- **Other `mirror` call sites audited and deliberately NOT changed:**
  - `src/screens/messenger/CallScreen.tsx:2268` — already correct (`cameraFacing === 'front'`).
  - `src/screens/messenger/CallScreen.tsx:2208` — remote video, `mirror={false}`, correct.
  - `src/screens/messenger/FloatingCallOverlay.tsx:231` and `:450` — both render the **remote/active-speaker**
    stream in the PiP card, `mirror={false}`, correct. The overlay never renders self video.
- **Overlap with other batch findings:** none in the fix hunk. GCV-_ / BS-GC-_ work on the same screen
  (tile layout, stall overlay, hero opacity) sits in adjacent lines of `renderPersistentTile` and in
  `groupCallLayout.ts`; if another finding also edits the `<FlexibleVideoTile …>` JSX block or appends to
  `groupCallLayout.ts`, land them in one branch to avoid a textual conflict. No semantic conflict.
- **What could regress:** essentially only the self tile's handedness. The risk of a _visual_ regression is
  a stale `isFrontCamera` (see Risk) making the front lens render un-mirrored — same class of wrongness as
  today's bug, not worse, and today's state is already trusted for camera re-acquisition
  (`useGroupCall.ts:591` and `:3693` both re-acquire with `isFrontCameraRef.current ? 'user' : 'environment'`).
- **Security surface:** none. No crypto, no envelope, no AAD, no cert, no key material, no logging added.

## Tests

Existing layout: pure group-call UI decisions are unit-tested as helper mirrors under
`src/modules/messenger/__tests__/` (jest project **`messenger-crypto`**, node env — see `package.json`
`projects[1].testMatch`). `cameraOn` is already covered there, so extend that file.

**Modify `src/modules/messenger/__tests__/groupCallCameraToggle.test.ts`:**

1. Extend the import (anchor: `import {cameraOn, applyProducerPaused, applyProducerPausedFrame} from '../webrtc/groupCallLayout';`) to also pull `shouldMirrorTile`.
2. Add a describe block:

```ts
describe('GCV-4 — self-tile selfie mirror follows the lens', () => {
  it('mirrors the self tile on the front lens', () => {
    expect(shouldMirrorTile(true, true)).toBe(true);
  });

  it('does NOT mirror the self tile after flipping to the rear lens (the reported bug)', () => {
    // Pre-fix GroupCallScreen used `mirror={isSelf}` — true regardless of lens.
    expect(shouldMirrorTile(true, false)).toBe(false);
  });

  it('never mirrors a remote tile, on either lens', () => {
    expect(shouldMirrorTile(false, true)).toBe(false);
    expect(shouldMirrorTile(false, false)).toBe(false);
  });
});
```

**Commands:**

- Targeted: `npx jest --selectProjects=messenger-crypto -t "GCV-4"`
- Narrow regression: `npx jest --selectProjects=messenger-crypto groupCallCameraToggle groupCallLayout groupCallTileBatch groupCallVideoStall`
- Broad: `npm run test:crypto`, then `npm test`; plus `npm run typecheck` (must not exceed the 47 baseline in `.tsc-baseline.json`).

**Device smoke (cannot be exercised in this environment — native camera/WebRTC required; state it explicitly if not run):**
group video call with ≥2 participants → tap Flip → own tile un-mirrors, text in the rear-camera scene reads
correctly, tile does **not** flash black / does not resize, remote tiles unchanged; flip back → mirrors again;
camera off → flip is a no-op alert ("Camera is off") and no mirror change on re-enable.

## Risk

A reviewer should be suspicious of exactly three things:

1. **`isFrontCamera` can drift from reality.** `switchCamera` calls the fire-and-forget non-standard
   `track._switchCamera()` and optimistically flips state (`useGroupCall.ts:3850-3858`). Unlike CallScreen —
   which re-acquires with an explicit `facingMode` and is therefore authoritative — a device with >2 cameras,
   or a silent native failure, can leave `isFrontCamera` lying. This fix makes that lie _visible_ (wrong
   mirror) where before the mirror was simply always wrong. It is not a new drift source: the same flag
   already drives camera re-acquisition on resume (`useGroupCall.ts:591`, `:3693`), so a drifted flag already
   re-acquires the wrong lens today. Do not "fix" this by switching the group flip to a full
   `getUserMedia` re-acquire — that replaces the track and would detach the mediasoup producer + SFrame
   FrameCryptor. Out of scope for GCV-4; file separately if field logs show drift.
2. **Do not let this change the React key.** The tempting "force a remount so RTCView picks up the new
   mirror" is wrong and dangerous — `mirror` is a live native prop, and re-keying re-opens the
   BS-GC-BLACKVIDEO / Fix #13 surface-identity class.
3. **Scope creep.** The fix must not touch `cameraOn`, the hero/opacity resolver, or the camera-off avatar
   branch (which correctly never mirrors). Any diff larger than import + one prop + one helper + one test
   block is over-reach.

No architecture stop-condition is engaged: no encryption primitive, envelope shape, AAD binding, cert,
token, dwell semantic, group-key/epoch path, or vault MFA gate is read or written by this change, and no
new logging is introduced (`logAudit.test.ts` unaffected).
