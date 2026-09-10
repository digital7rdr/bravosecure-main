# GCV-5 - GroupCallScreen page geometry frozen at module load (`SCREEN_W`/`PAGE_W`) — stale grid on any window resize

## Verdict

**CONFIRMED** (drift: only the StyleSheet line moved by ~0; every cited construct exists verbatim).

Evidence from the current tree:

- `src/screens/messenger/GroupCallScreen.tsx:121-123` — module scope, evaluated once per JS-bundle load:
  `const {width: SCREEN_W} = Dimensions.get('window');` / `const PAGE_PADDING_H = 16;` / `const PAGE_W = SCREEN_W - PAGE_PADDING_H * 2;`
- `src/screens/messenger/GroupCallScreen.tsx:2704` — a **StyleSheet-frozen** tile width:
  `gridThreeSlot: {width: Math.floor((PAGE_W - 24) / 3), aspectRatio: 9 / 12},` (its own comment says "Derive the width from the **live** PAGE_W" — it is not live, it is load-time).
- Six more consumers, all stale after a resize: `:712` `resolveTilePositions(layout, slotRectsRef.current, PAGE_W)`, `:823` `toValue: -pageIndex * PAGE_W`, `:853` `const threshold = PAGE_W * 0.18;`, `:1866` `width: PAGE_W * Math.max(1, totalPages)`, `:1879` `{left: 0, width: PAGE_W}`, `:1941` `{left: pageNum * PAGE_W, width: PAGE_W}`.
- No `Dimensions.addEventListener` and no `useWindowDimensions` anywhere in the file — `grep -n "Dimensions" GroupCallScreen.tsx` returns exactly two hits (import line `:48`, read line `:121`). There is no re-read path at all; the value is stale even across screen unmount/remount, because it is bound at module evaluation, not at mount.
- The resolver it feeds already accepts width as a **parameter** — `src/modules/messenger/webrtc/groupCallLayout.ts:517` `export function resolveTilePositions(layout, slotRects, pageW: number)` — so the pure layer is already resize-ready; only the screen freezes it.
- Reachability is real but narrow (hence P3): `android/app/src/main/AndroidManifest.xml:133` sets `android:screenOrientation="portrait"` **and** `android:configChanges="…orientation|screenSize|screenLayout…"`. The orientation lock is ignored by the OS in multi-window/split-screen, and — because the app targets SDK 36 (`AndroidManifest.xml:109` "VERIFIED on targetSdk 36") — is ignored outright on ≥600dp displays (unfolded foldables, tablets, DeX/desktop windowing). `configChanges` means the activity is **not** recreated, so RN just resizes the window and re-renders: precisely the case a module-frozen width cannot see. There is no `ios/` directory (managed prebuild) and `app.json` sets `"supportsTablet": false`, so iPad multitasking is not currently a trigger.

## Mechanism

1. Metro evaluates `GroupCallScreen.tsx`. Line 121 reads `Dimensions.get('window').width` once — say 411dp on an unfolded-later foldable in its folded state. `PAGE_W` becomes 379. The `StyleSheet.create` block at the bottom runs in the same evaluation, baking `gridThreeSlot.width = floor((379 - 24) / 3) = 118`.
2. A group call starts. The invisible skeleton layer measures slot rects via `onLayout` → `slotRectsRef` → `bumpSlotRects()` → `tilePositions` (`:709-722`). Everything agrees at 379.
3. The user unfolds the device / drops the call into split-screen / rotates on a large screen. Because `configChanges` covers `orientation|screenSize|screenLayout`, Android does **not** recreate the activity; RN's `Dimensions` module updates from `onConfigurationChanged` and the RN root re-lays-out at, say, 673dp. `GroupCallScreen` re-renders (its parent resizes), but `PAGE_W` is a module const — it is still 379.
4. Divergence, all at once:
   - **`pageWrap`** is `flex: 1` (`:2578`) so the _container_ is now 641 wide, while the inner `Animated.View` stack is pinned to `PAGE_W * totalPages` (`:1866`) = 379×N. Every page is now ~262px narrower than its viewport → a permanent black gutter down the right of the call grid.
   - **Skeleton pages** are positioned at `pageNum * PAGE_W` (`:1941`), so page 2 sits at x=379 while the viewport shows 0..641 → **two pages are visible at once**, overlapping the gutter.
   - **`settledX`** was sprung to `-pageIndex * PAGE_W` (`:823`) and the effect deps are `[pageIndex, settledX]` — width is not a dependency, so a user parked on page 2 stays anchored at -758 in a 641-wide viewport: the visible page is now a half-page seam.
   - **`gridThreeSlot.width` = 118** (`:2704`) against a 641 viewport with `gridThree: {flex:1, flexDirection:'row', flexWrap:'wrap', gap:12}` (`:2698`) → three 118px tiles + 24px gap = 378px in a 641px row: the equal-3 grid collapses to a left-hugging third of the screen. (The inverse — unfold-then-fold, or launching in split-screen and expanding — makes the slots _too wide_, which re-triggers the exact `flexWrap` 2-over-1 breakage B-19 fixed.)
   - **Grid page x-offsets** from the resolver (`groupCallLayout.ts:589` `x: r.x + p * pageW`) are computed from the stale `pageW` while `r.x` comes from a **fresh** `onLayout` — the two are now measured against different viewports, so grid tiles on pages ≥1 land at coordinates that match neither.
   - **Swipe threshold** `PAGE_W * 0.18` (`:853`) additionally lives inside a `useRef(PanResponder.create(...))` closure created once at mount (`:848`), so it is doubly frozen — the same stale-closure class the neighbouring comment (`:1873-1876`) already fixed for `pageIndex` via `pageIndexRef`.
5. Nothing self-heals: `onLayout` refreshes the _rects_ but every consumer that multiplies by page width keeps the load-time number for the rest of the JS VM's life. Leaving and re-entering the call does not fix it; only a full app restart does.

## Fix

Four hunks in one file, plus two small pure helpers in the already-unit-tested layout module (the screen itself is **not** render-testable — see Tests).

### File 1 — `src/modules/messenger/webrtc/groupCallLayout.ts`

Add two pure helpers. Place them immediately **above** `export function resolveTilePositions(` (`:517`) so the width math sits next to its only consumer.

Anchor (verbatim, current tree):

```ts
export function resolveTilePositions(
  layout:    {hero: MergedTile | null; pages: PageItem[][]},
  slotRects: SlotRects,
  pageW:     number,
): Record<string, TilePosition> {
```

Insert before it:

```ts
// GCV-5 — page geometry is derived per render from the LIVE window width
// (rotation on a large screen, foldable unfold, split-screen resize), so it
// must survive a transient/degenerate width without emitting 0-wide slots:
// a 0x0 RTCView surface is the BS-GC-0x0 / BS-GC-BLACKVIDEO failure this
// module already fights (see resolveTilePositions' fallback block).
export const GROUP_CALL_PAGE_GAP = 12;

export function resolveGroupCallPageWidth(windowWidth: number, paddingH: number): number {
  const w = Math.floor(windowWidth - paddingH * 2);
  return w > 0 ? w : 0;
}

export function resolveGridSlotWidth(pageW: number, gap: number = GROUP_CALL_PAGE_GAP): number {
  // B-19 — 3 slots + 2 gaps must fit EXACTLY; floor so a sub-pixel
  // overflow can't re-trigger the flexWrap 2-over-1 collapse.
  const w = Math.floor((pageW - gap * 2) / 3);
  return w > 0 ? w : 0;
}
```

No schema, no migration, no wire field, no persisted state — this is render-only geometry. Old/new clients and the server are unaffected.

### File 2 — `src/screens/messenger/GroupCallScreen.tsx`

**Hunk 2a — imports.** `Dimensions` has exactly two references (`:48`, `:121`); after this change it has none, so swap it out.

Anchor:

```ts
  DeviceEventEmitter, Animated, Easing, PanResponder, Dimensions, BackHandler,
```

Replacement:

```ts
  DeviceEventEmitter, Animated, Easing, PanResponder, useWindowDimensions, BackHandler,
```

Also extend the existing `groupCallLayout` import list (the file already imports `resolveTilePositions`, `buildRenderEntries`, `resolveOffscreenVideoTags`, `paginateOthers`, … from `@/modules/messenger/webrtc/groupCallLayout`) with `resolveGroupCallPageWidth` and `resolveGridSlotWidth`.

**Hunk 2b — kill the module-level width.**

Anchor:

```ts
const {width: SCREEN_W} = Dimensions.get('window');
const PAGE_PADDING_H = 16;
const PAGE_W = SCREEN_W - PAGE_PADDING_H * 2;
```

Replacement (keep `PAGE_PADDING_H` — `s.pageWrap:2578` uses it and it is genuinely constant):

```ts
const PAGE_PADDING_H = 16;
```

**Hunk 2c — derive `pageW` per render, inside the component.** Insert immediately after the `layout` / `pages` / `totalPages` block (`:578-583`), before the Fix-#13 slot-rect state:

Anchor:

```ts
const pages = layout.pages;
const totalPages = pages.length;
```

Replacement:

```ts
const pages = layout.pages;
const totalPages = pages.length;

// GCV-5 — page width is LIVE (rotation on a large screen, foldable
// unfold, split-screen resize). It was a module const, so every
// page offset / slot width stayed at the launch-time viewport for
// the life of the JS VM.
const {width: windowW} = useWindowDimensions();
const lastPageWRef = useRef(0);
const pageW = useMemo(() => {
  const w = resolveGroupCallPageWidth(windowW, PAGE_PADDING_H);
  // Why: Android reports a transient 0-width window mid-resize; a
  // 0-wide page collapses every RTCView surface (BS-GC-0x0).
  if (w > 0) {
    lastPageWRef.current = w;
  }
  return w > 0 ? w : lastPageWRef.current;
}, [windowW]);
const gridSlotW = useMemo(() => resolveGridSlotWidth(pageW), [pageW]);
// PanResponder is created once at mount (useRef below), so it must
// read the width through a ref — same reason pageIndexRef exists.
const pageWRef = useRef(pageW);
useEffect(() => {
  pageWRef.current = pageW;
}, [pageW]);
```

**Hunk 2d — the seven consumers.**

1. `:712` anchor `const positions = resolveTilePositions(layout, slotRectsRef.current, PAGE_W);` → `…, pageW);`
   and the memo deps at `:722` `}, [layout, slotRectsVersion, retentionTick]);` → `}, [layout, slotRectsVersion, retentionTick, pageW]);`

2. `:820-825` — the settle spring must **snap** on a width change, not spring (a spring would slide the whole grid sideways for ~300ms mid-resize).

   Anchor:

   ```ts
   useEffect(() => {
     Animated.spring(settledX, {
       toValue: -pageIndex * PAGE_W,
       useNativeDriver: false,
       friction: 8,
     }).start();
   }, [pageIndex, settledX]);
   ```

   Replacement:

   ```ts
   const settledPageWRef = useRef(pageW);
   useEffect(() => {
     const target = -pageIndex * pageW;
     if (settledPageWRef.current !== pageW) {
       // Why: on a window resize the anchor must re-pin instantly —
       // springing would drag the whole page stack across the screen.
       settledPageWRef.current = pageW;
       settledX.setValue(target);
       return;
     }
     Animated.spring(settledX, {
       toValue: target,
       useNativeDriver: false,
       friction: 8,
     }).start();
   }, [pageIndex, pageW, settledX]);
   ```

3. `:853` anchor `const threshold = PAGE_W * 0.18;` → `const threshold = pageWRef.current * 0.18;`

4. `:1866` anchor `width:     PAGE_W * Math.max(1, totalPages),` → `width:     pageW * Math.max(1, totalPages),`

5. `:1879` anchor `<View style={[s.page, s.skeletonPage, {left: 0, width: PAGE_W}]}>` → `{left: 0, width: pageW}`

6. `:1941` anchor `style={[s.page, s.skeletonPage, {left: pageNum * PAGE_W, width: PAGE_W}]}>` → `{left: pageNum * pageW, width: pageW}`

7. `:1944-1946` — inline the grid slot width.

   Anchor:

   ```ts
                     <View
                       key={slot}
                       style={s.gridThreeSlot}
                       onLayout={e => {
   ```

   Replacement:

   ```ts
                     <View
                       key={slot}
                       style={[s.gridThreeSlot, {width: gridSlotW}]}
                       onLayout={e => {
   ```

**Hunk 2e — de-freeze the StyleSheet entry.**

Anchor:

```ts
  gridThreeSlot: {width: Math.floor((PAGE_W - 24) / 3), aspectRatio: 9 / 12},
```

Replacement (keep the B-19 comment block above it untouched; only the width leaves, and the comment's "derive the width from the live PAGE_W" claim becomes true for the first time):

```ts
  // GCV-5 — width is supplied inline per render (resolveGridSlotWidth);
  // baking it here froze the slot at the launch-time viewport.
  gridThreeSlot: {aspectRatio: 9 / 12},
```

`s.gridThreeSlot` has exactly one usage site (`:1946`), so no other consumer loses its width.

### Explicitly NOT in this fix

- `resolveTilePositions`' unmeasured-slot fallbacks use an **8px** gap (`groupCallLayout.ts:539-540`, `small1Fallback`/`gridFallback`) while the real styles use 12px (`s.smallRow`/`s.gridThree`). That is a pre-existing inconsistency in a cold-start-only path. Do **not** unify it here — it changes the BS-GC-0x0 fallback geometry and belongs to its own change.
- `src/utils/scaling.ts:32` `export const screenWidth = SCREEN_W` is the same module-frozen pattern app-wide, and `useResponsive()` (`:115`) is the reactive alternative. GroupCallScreen only needs `width` and does not use the scale helpers, so `useWindowDimensions` direct (the pattern `src/components/BravoAlertHost.tsx:43` already uses) is the smaller import. Auditing every `screenWidth` consumer is a separate, much larger task.
- `src/screens/messenger/CallScreen.tsx:1865` and `src/screens/messenger/ChatScreen.tsx:3212` have the same freeze. Out of scope for GCV-5; log them if not already covered.

## Blast radius

**Files**

- `src/modules/messenger/webrtc/groupCallLayout.ts` — additive only (two new exported pure functions + one const). No existing export changes signature or behavior. Consumers of the module (`GroupCallScreen.tsx` and the `messenger-crypto` test suite) are unaffected.
- `src/screens/messenger/GroupCallScreen.tsx` — one screen, render path only.

**Functions touched inside the screen:** the `tilePositions` memo, the `settledX` settle effect, the `pan` PanResponder release handler, the `Animated.View` page-stack wrapper, both skeleton-page renderers, `s.gridThreeSlot`.

**Downstream of `tilePositions`** (now recomputes on width change, which is the point, but widens the churn surface): the hero-opacity effect (`:753-843`, keyed on `tilePositions` — a width change produces `action === 'keep'` for every tag because `resolveTileOpacityAction` only reads `{role, visible}`, so **no** spurious 2.5s hero crossfade); `renderPersistentTile` wrapper styles (`:1553`); and the offscreen-video effect (`:1888-1891`) → `call.setHiddenVideoTags`, which the screen's own comment notes "no-ops on an unchanged set", so a resize does not churn SFU consumer pause/resume.

**Persistence / wire:** none. No SQLCipher schema, no outbox row shape, no migration, no relay DTO, no WS frame. Nothing crosses a process or version boundary — old clients, new clients and the deployed `messenger-service` are byte-identical on the wire.

**Overlapping findings**

- **GCV-4** (`mirror={isSelf}` → `mirror={isSelf && call.isFrontCamera}`) edits `GroupCallScreen.tsx:1620`, inside `renderPersistentTile`. Same file, **disjoint hunk** — no textual conflict, but both are queued in Wave 1, so land them in one branch or rebase.
- **GCV-2** (FlexibleVideoTile adaptive aspect is inert; the policy decision is cover-vs-contain) would change `s.gridThreeSlot`'s `aspectRatio` and possibly `renderPersistentTile`'s wrapper height. If GCV-2 lands first, re-check that `gridThreeSlot` still needs an explicit width at all.
- **GCV-1/GCV-3** (capture constraints / rotation-adjusted frame dims) are in the WebRTC layer, not the layout layer. No overlap.

**Regression candidates a reviewer should watch**

- **B-19** (3-across grid wrapping to 2-over-1): the whole reason `gridThreeSlot` had a computed width. `resolveGridSlotWidth` keeps the identical `floor((pageW - 24) / 3)` arithmetic, so on an unresized device the number is bit-identical to today's. Verify that first.
- **B-17 / Fix #13 / BS-GC-BLACKVIDEO**: the persistent-tile React keys are `entry.tile.tag` and are untouched, so no RTCView remount, no decoder/EGL teardown. The 0-width guard exists specifically so a resize transient cannot recreate the 0x0-surface class.
- **Swipe paging** across a resize while parked on page ≥1 — the `setValue` snap path is new logic; confirm it re-anchors rather than gliding.

## Tests

**Do not attempt a render test.** `src/screens/messenger/__tests__/GroupCallScreen.autopop.test.tsx:104-114` documents that mounting the real screen under the `app` project **hangs** ("the screen fires render-time effects … whose async never settles under jsdom without a much larger mock harness than is worth maintaining") and the whole describe is `describe.skip`. Testing the geometry through the pure helpers is the established compensating pattern in this module.

**Existing file to extend:** `src/modules/messenger/__tests__/groupCallLayout.test.ts` (jest project **`messenger-crypto`**, node env — `npm run test:crypto`; note `src/modules/messenger/__tests__/` is explicitly in the `app` project's `testPathIgnorePatterns`, package.json:190).

Add a `describe('GCV-5 — live page geometry')` block:

1. `resolveGridSlotWidth(360)` → `112` — i.e. `Math.floor((360 - 24) / 3)`; assert it equals the pre-fix expression `Math.floor((360 - 24) / 3)` so the B-19 arithmetic is pinned literally.
2. `resolveGridSlotWidth(673 - 32)` (unfolded foldable) → `205`, and assert `3 * w + 2 * GROUP_CALL_PAGE_GAP <= 641` — the B-19 "3 slots + 2 gaps must fit" invariant, asserted as an inequality across a width sweep `[288, 320, 360, 411, 480, 600, 641, 800, 1024]`.
3. `resolveGroupCallPageWidth(411, 16)` → `379`; `resolveGroupCallPageWidth(0, 16)` → `0`; `resolveGroupCallPageWidth(20, 16)` → `0` (never negative). Assert `resolveGridSlotWidth(0)` → `0` (not negative) so a degenerate width cannot produce negative RN style values.
4. **Resize invariant on the existing resolver** (this is the regression that actually mattered): build a 9-remote layout via `paginateOthers`, resolve once with `pageW = 379` and measured `rectsWithGrid(3)`, then resolve again with `pageW = 641` and the same rects; assert every `role === 'grid'` tile's `x` moved by exactly `(641 - 379) * pos.page`, and that page-0 tiles did not move. This encodes "grid page offsets track the live width" and would have failed against the frozen constant only if the screen passed a stale value — so pair it with (5).
5. **Static guard** (cheap, catches the actual defect class): assert the screen source no longer freezes the width. In `src/modules/messenger/__tests__/groupCallLayout.test.ts` (node env, `fs` available — mirrors the repo's existing static-sweep pattern used by the `@utils/alert` and log-audit gates):

   ```ts
   it('GCV-5: GroupCallScreen never binds page width at module load', () => {
     const src = readFileSync(
       join(__dirname, '../../../screens/messenger/GroupCallScreen.tsx'),
       'utf8',
     );
     expect(src).not.toMatch(/Dimensions\.get\(/);
     expect(src).toContain('useWindowDimensions');
     expect(src).not.toMatch(/gridThreeSlot:\s*\{\s*width:/);
   });
   ```

**Gates to run:** `npm run test:crypto` (direct + the whole `groupCallLayout` regression set), then `npm test` (the `app` project must stay green — GroupCallScreen's only `app`-project test is the skipped render suite plus `src/screens/messenger/__tests__/` neighbours), then `npm run typecheck` (must not exceed `.tsc-baseline.json` = 47).

**Device probe (state it if you cannot run it):** the only way to actually see the fix is a real resize. On a foldable or via `adb shell wm size 673x841` mid-call, or Android split-screen — join a 6+ participant group call, swipe to page 2, resize, and confirm (a) no black right-hand gutter, (b) exactly one page visible, (c) 3-across grid still 3-across, (d) tiles still render video (no black tile / `BLASTBufferQueue rejecting buffer` in logcat). If no foldable is available, `adb shell wm size` + `wm density` on any device reproduces the window-resize path because `configChanges` prevents an activity recreate.

## Risk

- **Reviewer suspicion #1 — is this reachable at all?** The manifest says `screenOrientation="portrait"`. On an ordinary portrait phone the defect **never fires**, and the fix is pure dead-weight there. The argument for reachability rests on (a) split-screen ignoring the orientation lock, and (b) targetSdk 36 large-screen orientation/resizability overrides. If the product decision is "we do not support large screens" (`app.json` already sets `"supportsTablet": false`), the honest smallest increment is hunks 2b + 2e + the `gridSlotW` inline (which also removes a load-order footgun in `StyleSheet.create`) and to skip the pan/settle ref plumbing. I recommend doing the whole thing anyway — it is ~30 lines and the partial version leaves a half-live geometry that is harder to reason about than either extreme.
- **Reviewer suspicion #2 — new render churn.** `pageW` now feeds `tilePositions`' deps. On a static device `windowW` never changes, so the memo identity is unchanged and there is zero extra work; verify that by reading the deps, not by trusting this line.
- **Reviewer suspicion #3 — the 0-width guard.** `lastPageWRef` is mutated inside a `useMemo`. That is idempotent and safe here, but it is a pattern a reviewer should flag on sight; if it is objectionable, move the assignment into a `useEffect` and accept one stale frame.
- **Reviewer suspicion #4 — the `setValue` snap.** `settledPageWRef` is initialised to the first `pageW`, so the very first `pageIndex` change after mount takes the spring path (correct). Confirm it does not accidentally swallow a legitimate page-change animation when a resize and a page change land in the same commit — in that case the snap wins, which is the right trade but is a behavior choice worth stating.
- **Reviewer suspicion #5 — arithmetic drift.** `resolveGridSlotWidth` must stay `Math.floor((pageW - 24) / 3)` exactly. A "cleanup" to `(pageW - 2 * gap) / 3` without the floor re-opens B-19.
- **Security:** none. No crypto, no envelope, no AAD, no cert, no key material, no logging of anything (the new helpers take and return numbers). No CLAUDE.md stop condition is touched; `logAudit.test.ts` is unaffected.
