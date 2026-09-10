# GCV-2 - FlexibleVideoTile's adaptive aspect is 100% dead code; tile crop is an unowned `objectFit` policy

## Verdict

**CONFIRMED** — and _stronger_ than the audit states. The audit says the machinery is inert "in every
**measured** slot"; in the current tree it is inert in **every** slot, measured or not, because the
unmeasured fallback also ships a non-zero height.

1. The tile wrapper pins both axes whenever `pos.height > 0`
   (`src/screens/messenger/GroupCallScreen.tsx:1597-1604`):
   ```ts
   const wrapperStyle = {
     position: 'absolute' as const,
     left: pos.x,
     top: pos.y,
     width: pos.width,
     ...(pos.height > 0 ? {height: pos.height} : null),
     opacity: tileOpacity,
   };
   ```
2. `resolveTilePositions` never returns `height === 0` any more — every branch, including the
   unmeasured fallbacks, carries a real height
   (`src/modules/messenger/webrtc/groupCallLayout.ts:548-550`, used at `:556-557`, `:568-572`,
   `:586-594`):
   ```ts
   const heroFallbackH = Math.floor(pageW / (16 / 11));
   const smallFallbackH = Math.floor(small1Fallback / 0.75);
   const gridFallbackH = Math.floor(gridFallback / 0.75);
   ```
   and `pageW` is `PAGE_W = SCREEN_W - PAGE_PADDING_H * 2` — a module constant off
   `Dimensions.get('window')` (`GroupCallScreen.tsx:121-123`), so it is never 0 on a device.
   ⇒ `pos.height > 0` is always true ⇒ the wrapper **always** has an explicit height.
3. The inner container is `100%`×`100%` (`GroupCallScreen.tsx:2610` `heroFlexInner`, `:2621`
   `smallFlexInner`), and `FlexibleVideoTile` merges its ratio onto exactly that style
   (`src/components/FlexibleVideoTile.tsx:97`):
   ```ts
   () => [containerStyle, {aspectRatio: ratio, minWidth: 1, minHeight: 1}],
   ```
   Yoga ignores `aspectRatio` when both `width` and `height` resolve. So `ratio`, the
   `DEFAULT_RATIO` reset effect (`:68-70`), and `onDims` (`:71-77`) have **no rendered effect
   anywhere**.
4. `FlexibleVideoTile` has exactly one consumer (`GroupCallScreen.tsx:1618-1623`) — `CallScreen.tsx`
   uses `RTCView` directly with `objectFit="cover"` (`:2199-2207`, `:2263-2267`). And it is the only
   `onDimensionsChange` consumer in the whole repo (`grep -rn onDimensionsChange src/ apps/` → only
   `FlexibleVideoTile.tsx`).
5. Net effect: every tile is a fixed rect + `objectFit="cover"` (`FlexibleVideoTile.tsx:105`), i.e.
   the source is centre-cropped to the slot aspect, and the component's own file header
   (`:2-11`, "so we never show black bars or cut frames") is now false.

## Mechanism

1. `renderPersistentTile` builds `wrapperStyle` from the resolver's `TilePosition` and always
   includes `height` (evidence 1+2). The wrapper is a fixed rect — deliberately, per
   BS-GC-BLACKVIDEO: an oscillating surface made `BLASTBufferQueue` reject the first keyframe and
   the tile latched black.
2. `containerStyle` (`heroFlexInner` / `smallFlexInner`) is `{width:'100%', height:'100%'}`, so the
   `FlexibleVideoTile` View inherits a fully-resolved box from the pinned wrapper.
3. Yoga drops `aspectRatio` because width and height are both definite. The `ratio` state churns on
   every `onDimensionsChange` and on every `streamURL` swap, re-creates `mergedStyle`, and changes
   nothing on screen. (It still costs a native→JS bridge post per resolution change, because
   passing the prop flips `onDimensionsChangeEnabled = true` in
   `node_modules/react-native-webrtc/android/.../WebRTCView.java:272`.)
4. `RTCView objectFit="cover"` → Android `SCALE_ASPECT_FILL` → `surfaceViewRenderer.layout(0,0,w,h)`
   (`WebRTCView.java:313-319`): the surface fills the slot and the renderer crops the source.
5. Slot aspects vs. source aspect are structurally mismatched. On a 360 dp phone
   (`PAGE_W = 328`), with `page {flex:1, gap:12}`, `heroTile {flex:1.6}`, `smallRow {flex:1}`,
   `smallSlot {flex:1}`, `gridThreeSlot {width:(PAGE_W-24)/3, aspectRatio:9/12}`:
   - hero ≈ 328×269 → aspect ≈ **1.22**
   - small ≈ 158×168 → aspect ≈ **0.94**
   - grid ≈ 101×135 → aspect = **0.75**
     A rotated portrait capture is 0.75 (640×480@rot90) or 0.5625 (1280×720@rot90, the GCV-1 drift).
     `cover` crop = `1 - srcAspect/dstAspect` on the cropped axis:
     | slot | src 0.75 | src 0.5625 |
     |---|---|---|
     | hero (1.22) | **38 %** | **54 %** |
     | small (0.94) | **20 %** | **40 %** |
     | grid (0.75) | 0 % | 25 % |
     That is the "hero slots structurally crop 18-39 %" claim, reproduced. The _variance_ between
     devices/paths is GCV-1 (0.75 ↔ 0.5625 capture flip); the _floor_ is GCV-2 (nobody owns the fit
     policy, and the component that was supposed to own it is inert).

## Fix

Two parts. **Part 1** is a pure dead-code + honesty fix with zero visual delta. **Part 2** is one
line and is a visual/product decision. Ship both; Part 2 is trivially revertible on its own.

The wrapper height stays pinned in both parts — nothing here touches `wrapperStyle`,
`resolveTilePositions` heights, or the `minWidth/minHeight` floor.

### Part 1 — `src/components/FlexibleVideoTile.tsx` (full rewrite of the file)

Anchor: the whole file (verbatim current content is the 112-line module beginning
`* FlexibleVideoTile — RTCView wrapper that bends its container to the` and ending
`onDimensionsChange={onDims}`).

Replacement:

```tsx
/**
 * FlexibleVideoTile — RTCView wrapper that guarantees a non-zero render
 * surface and forwards an explicit object-fit policy.
 *
 * The PARENT owns the rect. GroupCallScreen pins every tile wrapper to
 * its measured slot rect (BS-GC-BLACKVIDEO) and the inner container is
 * 100% x 100%, so a self-sizing `aspectRatio` here is dropped by Yoga in
 * every role — it was dead in every slot (GCV-2). Cropping is therefore
 * a decision the caller makes via `objectFit`, not something this
 * component can negotiate from the source dimensions.
 *
 * Why the 1px floor stays (BS-GC-0x0): field logcat (TECNO + Pixel)
 * showed `BLASTBufferQueue ... rejecting buffer:active_size=0x0`
 * repeating forever when a slot momentarily resolved to width 0 — every
 * decoded frame was dropped at the compositor and the tile stayed blank.
 * The floor guarantees a real surface until layout settles.
 *
 * Camera-off / no-video paths must NOT use this component — render the
 * avatar fallback as a fixed-dimension View instead.
 */
import React, {useMemo} from 'react';
import {StyleSheet, View, type StyleProp, type ViewStyle} from 'react-native';
import {RTCView} from 'react-native-webrtc';

interface Props {
  streamURL: string;
  /** Front camera mirror — only set true for the user's own self-tile. */
  mirror?: boolean;
  /** RTCView z-order. Defaults to 0. Set 1 for PiP-on-top. */
  zOrder?: number;
  /**
   * 'cover' (default) fills the slot and centre-crops the source to the
   * slot aspect. 'contain' fits the whole frame inside the slot and lets
   * the parent's background show in the letterbox — use it where seeing
   * the full transmitted frame matters more than filling the rect.
   */
  objectFit?: 'contain' | 'cover';
  /**
   * Container style. The parent supplies the box (width AND height);
   * this component only adds the non-zero-surface floor.
   */
  containerStyle?: StyleProp<ViewStyle>;
}

export default function FlexibleVideoTile({
  streamURL,
  mirror = false,
  zOrder = 0,
  objectFit = 'cover',
  containerStyle,
}: Props): React.ReactElement {
  // Fix #42: memoize the merged style array so RN's StyleSheet diff
  // short-circuits instead of treating the outer View as changed every
  // frame (which cascaded into parent-grid layout recalculation).
  const mergedStyle = useMemo(
    () => [containerStyle, {minWidth: 1, minHeight: 1}],
    [containerStyle],
  );
  return (
    <View style={mergedStyle}>
      <RTCView
        streamURL={streamURL}
        style={StyleSheet.absoluteFill}
        objectFit={objectFit}
        mirror={mirror}
        zOrder={zOrder}
      />
    </View>
  );
}
```

Deleted: `useState`/`useEffect`/`useCallback` imports, `DEFAULT_RATIO`, `ratio` state, the
streamURL reset effect (old Fix #41), `onDims`, the `aspectRatio` entry, and the
`onDimensionsChange` prop. Dropping the prop also flips `onDimensionsChangeEnabled` back to `false`
natively (`WebRTCView.java:155`, `:272`, `:581`) so the per-resolution-change bridge post stops.

No rename: the component keeps its name (CLAUDE.md — no drive-by refactors in a bug fix). The
header now states the real contract.

### Part 2 — `src/screens/messenger/GroupCallScreen.tsx`

Anchor (verbatim, `:1618-1623`):

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
  mirror={isSelf}
  zOrder={0}
  // Why: GCV-2 — the slot rect is pinned (BS-GC-BLACKVIDEO), so
  // 'cover' structurally crops any source whose aspect differs
  // from the slot. Self-preview is the one tile where seeing the
  // exact transmitted frame beats filling the rect.
  objectFit={isSelf ? 'contain' : 'cover'}
  containerStyle={isHero ? s.heroFlexInner : s.smallFlexInner}
/>
```

Why self only, and not hero: `contain` on the hero slot (aspect ≈1.22) with a 0.75 source
pillarboxes ~38 % of the hero width — replacing a crop complaint with a dead-space complaint. That
is a design decision for `DESIGN_REVIEW_LOOP.md`, not a bug fix (see _Follow-up_ below). Self is
always a `small` or `grid` tile — never hero (`paginateOthers` appends self to `others`; only
`merged[0]` becomes hero, `groupCallLayout.ts:351-354`) — so its worst case is ~10 % background bar
per side in the 0.94 small slot, and the bars are the tile's own obsidian surface
(`smallFlexWrap.backgroundColor: C.surf3`, `:2618`), not black.

Native behaviour is verified, not assumed:

- Android `SCALE_ASPECT_FIT` lays the `SurfaceViewRenderer` out at the _fitted, centred_ rect
  (`WebRTCView.java:321-341`), so the letterbox is the parent's background.
- iOS maps `contain` → `UIViewContentModeScaleAspectFit` on the video view
  (`RTCVideoViewManager.m:226-229`, `:343-344`).

### Part 3 — comment accuracy (no behaviour change, but these comments actively mislead)

3a. `src/screens/messenger/GroupCallScreen.tsx` — anchor (`:1577-1580`):

```tsx
// Outer wrapper style: absolute position from resolver, width
// explicit, height undefined so FlexibleVideoTile's aspectRatio
// can drive it (camera-off path adds an explicit fallback ratio
// via the inner avatar wrapper).
```

Replacement:

```tsx
// Outer wrapper style: absolute position + explicit width AND height
// from the resolver (BS-GC-BLACKVIDEO). The camera-off path adds its
// own aspectRatio via the inner avatar wrapper.
```

3b. `src/screens/messenger/GroupCallScreen.tsx` — anchor (`:2604-2610`):

```tsx
  // BS-GC-BLACKVIDEO — height:'100%' so the tile fills the wrapper's now-
  // pinned measured height (see renderPersistentTile). When the wrapper has
  // an explicit height the inner View fills it and FlexibleVideoTile's
  // aspectRatio becomes a no-op fallback; when the wrapper is unmeasured
  // (no height) '100%' resolves to 0 and aspectRatio drives cold-start as
  // before. RTCView (absoluteFill) then fills a stable, non-oscillating box.
  heroFlexInner: {width: '100%', height: '100%'},
```

Replacement:

```tsx
  // BS-GC-BLACKVIDEO — height:'100%' so the tile fills the wrapper's pinned
  // measured height (see renderPersistentTile). GCV-2: the wrapper always
  // ships a non-zero height (resolveTilePositions fallbacks included), so the
  // rect is fully parent-owned and crop policy is FlexibleVideoTile's
  // `objectFit` prop. RTCView (absoluteFill) fills a stable, non-oscillating
  // box. Do NOT unpin this height — it re-opens the black-tile class.
  heroFlexInner: {width: '100%', height: '100%'},
```

3c. `src/modules/messenger/webrtc/groupCallLayout.ts` — anchor (`:484`):

```ts
 *   w:      explicit width (height stays driven by FlexibleVideoTile aspect)
```

Replacement:

```ts
 *   w/h:    explicit rect — the tile wrapper pins BOTH (BS-GC-BLACKVIDEO)
```

### Not needed

No schema/migration (no persistence touched). No wire-format change, no server change, so no
old-client/new-server compatibility question. No security-constraint surface (no crypto, no
envelope, no logging of media/keys — `objectFit` is a layout string).

### Follow-up (product decision, out of scope here)

The hero slot is landscape-ish (≈1.22) only because it must share the page column with the small
row (`heroTile {flex:1.6}` over `smallRow {flex:1}`). Any portrait source in that box must either
crop or letterbox — there is no third option without redesigning page 0 (e.g. WhatsApp's
full-bleed hero with the other tiles as floating overlays). File that as a
`DESIGN_REVIEW_LOOP.md` task; it is not a bug fix and it would collide with GCV-5.

## Blast radius

**Files edited**

- `src/components/FlexibleVideoTile.tsx` — rewritten (Part 1).
- `src/screens/messenger/GroupCallScreen.tsx` — one JSX prop (Part 2) + two comment blocks (3a/3b).
- `src/modules/messenger/webrtc/groupCallLayout.ts` — one doc-comment line (3c).
- `src/components/__tests__/FlexibleVideoTile.test.tsx` — new.

**Call sites / consumers**

- `FlexibleVideoTile` has exactly one import site (`GroupCallScreen.tsx:82`). `CallScreen.tsx` and
  the ops-console are untouched.
- `onDimensionsChange` has no other consumer in the repo, so the native event goes quiet app-wide.

**Overlapping findings**

- **GCV-4** edits the _same JSX element_ (`mirror={isSelf}` → `mirror={isSelf && call.isFrontCamera}`).
  Land GCV-2 and GCV-4 in one edit of `renderPersistentTile` or expect a conflict.
- **GCV-1** (`peerConnectionFactory.ts` capture constraints) is the other half of the visible
  symptom: GCV-1 removes the 0.75↔0.5625 variance, GCV-2 stops pretending the tile adapts. Verify
  them together on device.
- **GCV-3** (patch to emit rotation-adjusted dims from `WebRTCView.java`) is **rendered moot** by
  Part 1: after the `onDimensionsChange` prop is dropped, nothing in the app consumes those dims and
  the native emitter is disabled. Recommend closing GCV-3 as "no consumer" instead of patching the
  fork — re-check that before implementing GCV-3.
- **GCV-5** (`useWindowDimensions()` + per-render `PAGE_W`) edits the same StyleSheet block as 3b
  and the constants at `:121-123`. Comment-only overlap; sequence GCV-5 after GCV-2.

**What could regress**

- The 1px surface floor and the pinned wrapper height are untouched, so the BS-GC-0x0 /
  BS-GC-BLACKVIDEO class is not re-opened by Part 1.
- Part 2 changes the Android native layout path for the self tile from "always fill the container"
  to "0×0 until the first `onFrameResolutionChanged`, then the fitted rect"
  (`WebRTCView.java:325-327`: `if (frameHeight == 0 || frameWidth == 0) { l = t = r = b = 0; }`).
  Self frames are local capture and land immediately, and the outer RN View keeps its pinned
  non-zero rect, so `requestLayout` resolves on the first frame — but this is the one line that
  needs a logcat check (see Risk).
- Removing the `ratio` state removes a per-frame-resolution `setState` on the group-call screen —
  strictly fewer renders, no ordering dependency.

## Tests

Jest project **`app`** (RN preset; `react-native-webrtc` is already globally mocked to
`{RTCView: 'RTCView', ...}` at `jest.setup.app.js:45-48`).

**New — `src/components/__tests__/FlexibleVideoTile.test.tsx`** (sits next to the existing
`src/components/__tests__/BravoAlertHost.test.tsx`; same `render` + RNTL style):

```tsx
import React from 'react';
import {render} from '@testing-library/react-native';
import {StyleSheet} from 'react-native';
import FlexibleVideoTile from '../FlexibleVideoTile';

const flat = (node: {props: {style: unknown}}) =>
  StyleSheet.flatten(node.props.style) as Record<string, unknown>;
```

Assertions:

1. `objectFit` defaults to `'cover'` — render without the prop, `UNSAFE_getByType('RTCView' as never)`
   (or `UNSAFE_getAllByType`) → `props.objectFit === 'cover'`.
2. `objectFit="contain"` is forwarded verbatim to `RTCView`.
3. `streamURL`, `mirror`, `zOrder` are forwarded unchanged (mirror default `false`, zOrder default `0`).
4. **GCV-2 regression pin** — the merged container style contains **no** `aspectRatio` key:
   `expect(flat(container)).not.toHaveProperty('aspectRatio')`, with a `// GCV-2` comment saying the
   parent owns the rect. This is the assertion that stops the dead machinery being reintroduced.
5. **BS-GC-0x0 pin** — merged container style still has `minWidth: 1` and `minHeight: 1`.
6. **GCV-3 pin** — `RTCView` receives no `onDimensionsChange`
   (`expect(rtcView.props.onDimensionsChange).toBeUndefined()`), so the native emitter stays off.
7. The `containerStyle` the caller passes survives the merge (pass `{width: '100%', height: '100%'}`
   and assert both are present after flatten).

**New — `src/screens/messenger/__tests__/GroupCallScreen.tilefit.test.tsx`** (optional but
preferred; copy the mock scaffold verbatim from `GroupCallScreen.autopop.test.tsx:1-60` — same
`useGroupCall` mock shape, same `@modules/observability` / `expo-linear-gradient` /
`groupCallRegistry` stubs). Two changes to that scaffold: keep `FlexibleVideoTile` mocked as the
host string `'FlexibleVideoTile'` so props are inspectable, and mock `safeStreamURL` to return
`'stream://x'` instead of `null`, plus give `mockHandle` a non-empty `remoteTiles` +
`localStream: {}` and `isVideoOff: false`. Assertions:

- exactly one rendered `FlexibleVideoTile` has `objectFit === 'contain'` (the self tile — identified
  by the sibling `YOU` badge / `mirror === true`);
- every other rendered `FlexibleVideoTile` has `objectFit === 'cover'`.

**Regression suites to run** (change-safety gate 2/4):

- `npx jest --selectProjects app --testPathPattern "FlexibleVideoTile|GroupCallScreen"` (targeted first)
- `npm test -- --selectProjects=messenger-crypto -t "BS-GC"` — `src/modules/messenger/__tests__/groupCallLayout.test.ts`
  still owns the BS-GC-0x0 / BS-GC-BLACKVIDEO non-zero-fallback assertions (`:538`, `:559`, `:575`);
  they must stay green untouched.
- `npm run typecheck` (baseline 47, must not increase) and `npm run lint` (the deleted
  `useState`/`useEffect`/`useCallback` imports must go or `no-unused-vars` fires).
- `npm run deadcode` (knip) — `FlexibleVideoTile` still has a consumer, so no new dead export.

**Device probe (cannot be done in Jest — state it in the sign-off):** 3-device group video call.

1. `adb logcat | grep -iE "BLASTBufferQueue|rejecting buffer"` during the first 30 s — must show
   no `rejecting buffer` for the self tile (Part 2's only real risk).
2. Self tile shows the _whole_ frame with thin obsidian side bars, not a zoomed crop.
3. Hero + remote small/grid tiles unchanged vs. the previous build (Part 1 must be a pixel no-op).
4. Camera flip, voice→video upgrade, hero↔small role swap, page swipe: no tile goes black
   (Fix #13 RTCView identity is untouched — no key change in this diff).

## Risk

- **The `contain` letterbox on Android starts at a 0×0 surface.** `WebRTCView.onLayout` with
  `SCALE_ASPECT_FIT` lays the renderer out at `(0,0,0,0)` until `frameWidth/frameHeight` are known
  (`WebRTCView.java:325-327`). It self-heals on the first `onFrameResolutionChanged`
  (`post(requestSurfaceViewRendererLayoutRunnable)`, `:268`) and the outer RN View keeps its pinned
  non-zero rect, but this is exactly the neighbourhood of BS-GC-BLACKVIDEO. It is why Part 2 is
  scoped to the **self** tile (local capture, frames immediate, never the black-tile victim in the
  field logs) and why the logcat probe above is mandatory. If it flakes on any device, revert Part 2
  alone — Part 1 stands on its own.
- **Reviewers will ask whether deleting `aspectRatio` re-opens the 0×0 class.** It does not: in the
  only scenario where `aspectRatio` could have applied (wrapper height absent), the wrapper's
  _width_ is `pos.width` from the same resolver and would be 0 too — `aspectRatio` on a 0-width box
  still yields 0 height. The `minWidth/minHeight: 1` floor, which is what actually saved that case,
  is preserved verbatim.
- **The component name is now a lie** (`FlexibleVideoTile` flexes nothing). Deliberately not renamed
  (CLAUDE.md: no renames during a bug fix); the header comment carries the truth. Flag it for a
  later rename if the file is opened again.
- **Part 2 is a visual policy, not a correctness fix.** The founder complaint ("dramatic zoom on
  some devices, fine on others") is fixed by **GCV-1**, not by this. GCV-2 alone removes the
  _variance-independent_ crop floor on the self view and deletes the machinery that made everyone
  believe the crop was already handled. Do not claim the complaint is closed on GCV-2 alone.
- **The residual hero crop (≈38 %) is untouched and intentional.** Anyone reading only the audit
  bullet may expect hero letterboxing. It is deferred as a design task because `contain` there
  trades a 38 % crop for a 38 % dead band. Say so explicitly in the sign-off rather than silently
  under-delivering.
- **Do not "improve" this by unpinning the wrapper height** (`pos.height > 0 ? {height} : null`) or
  by giving the fallback rects a zero height. That is the BS-GC-BLACKVIDEO / BS-GC-0x0 regression
  and it has shipped before.
