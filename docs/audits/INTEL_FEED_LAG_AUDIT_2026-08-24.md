# Bravo Feed (Intel) screen lag audit — 2026-08-24

**Screen:** `src/screens/news/IntelFeedScreen.tsx` + `src/modules/news/bravoMapHtml.ts`
**Reported by:** founder, on device, after confirming the B-655 messenger fixes are smooth.
**State in the screenshot:** BRAVO MAP tab, idle, globe WebView with ~30 signal bubbles, bottom drawer open on a Zimbabwe region card.

**Method:** two independent auditors (RN render tree / WebView + data), two adversarial
critics, then an **adjudication round** because the critics reached opposite conclusions.
**No device was attached** (`adb devices` → empty).

---

## 0. The most important finding: this is not new, and the repo already knew

**This screen was NOT touched by the pull that caused the messenger lag.**
`git diff 85955e19..c97faada -- src/screens/news/ src/modules/news/` is empty.

| Element                                          | Landed                           |
| ------------------------------------------------ | -------------------------------- |
| 220-view scanline overlay                        | 2026-04-21 (original Intel ship) |
| Per-marker `radar` animation + `backdrop-filter` | 2026-04-27                       |
| Mapbox GL globe rebuild                          | 2026-07-29                       |
| Last touch of `IntelFeedScreen.tsx`              | 2026-08-09                       |

And `docs/audits/MAPBOX_AUDIT.md` **already documented the cause in July** and it was
never closed:

> `:81` — _"What breaks smoothness is … (b) **infinite CSS pulse/radar animations on every
> marker** (… threat markers `bravoMapHtml.ts`) **burning compositor time continuously**"_
> `:174` — _"continuous CSS pulse/radar animations on all markers … all avoidable GPU/compositor burn"_
> `:176` — _"the intel screen re-renders every second from the clock `setInterval` — **cheap but pointless churn**"_
> `:391` — _"Estimated FPS (map canvas): 45–60 idle pan; **20–40 during update ticks**"_

The founder is reporting a months-old screen now because the messenger fix removed the
louder noise. **Any writeup that frames this as a regression is wrong.**

---

## 1. The disagreement, and how it was settled

The two critics ruled in opposite directions:

- **Critic 1:** the RN-side JS work is the cause; the WebView compositor claims are
  unverifiable from this repo, and CLAUDE.md forbids acting on GPU hypotheses without
  new numbers.
- **Critic 2:** the WebView's per-frame compositing is the cause; the JS work totals
  ~1.4 ms/s — 0.14% of a second — and _"a user cannot feel that."_

### The adjudicator's ruling: CLAUDE.md's stop-condition does NOT bind the diagnosis, but DOES bind most of the remedies

Three grounds, all verified:

1. **Scope.** Every one of CLAUDE.md's eight "MEASURED DEAD ENDS" is an ordinary React
   Native construct, and all three `dumpsys gfxinfo` rows are labelled **ChatScreen**. No
   WebView, no WebGL, no `backdrop-filter`, no `mix-blend-mode`, no CSS animation appears
   anywhere in that section. The warning not to delete "shadows, gradients or blur" is
   about **RN** effects.
2. **The instrument was structurally blind to this class — this is decisive.**
   `dumpsys gfxinfo <package>` reports the app's own `ViewRootImpl` frame timings. Android
   WebView composites in a **separate sandboxed renderer process** and hands the host a
   single draw functor. The app's RenderThread records _one functor invocation_, not the
   ~30 blur render-passes inside it. **The B-279/B-285 GPU numbers could not have contained
   this cost even if they had been taken on this screen.** A prior produced by a detector
   that cannot observe X does not rule out X.
3. **The repo already recorded the mechanism** (MAPBOX_AUDIT above). Critic 2 is not
   re-proposing a dead end; he is re-surfacing a never-closed audit item.

**But** the generalisable rule in CLAUDE.md is _"do not pay design cost on an unmeasured
hypothesis"_ — and that binds Critic 2's proposed deletions exactly as hard. He has a
strong mechanism and **zero device numbers**.

**Verdict: Critic 1 is wrong on the law and right on the caution. Critic 2 is right on the
mechanism and wrong to call it settled. The honest answer is undecidable without a device
— and the decisive test is ~10 minutes of work nobody has run.**

---

## 2. Corrections forced on the auditors

| Claim                                                       | Correction                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `geotag()` compiles **486** RegExps per call                | **98**, across 41 rows (counted by script, twice, independently). "29,000 per feed load" → ~5,900 worst case.                                                                                                              |
| The comment at `geotag.ts:87` "lies" about precompilation   | It does not. It is scoped to `COUNTRY_MATCHERS`, which genuinely _is_ precompiled. Misread scope.                                                                                                                          |
| The world sweep drives `geotag()` cost                      | It contributes **zero** calls — every Bravo row carries `geo`, so `toIntelItem`'s `g.geo ?? geotag(...)` short-circuits.                                                                                                   |
| "The static path caps at 30, so 30 is a safe marker budget" | **Category error.** That cap is a **URL byte limit** for the Static Images API (its own comment says so) — and `buildStaticMapUrl` is **dead code** with no consumers.                                                     |
| Marker count is "~55-80"                                    | Paper maximum. `clusterMarkers` buckets by rounded lat/lng, so 106 world rows across 53 countries collapse to ≤53 clusters, heavily overlapping wire items. The only empirical datapoint — the screenshot — shows **~30**. |
| Deleting the scanline overlay is "zero visual cost"         | It is the screen's deliberate CRT/console aesthetic. Deleting it is precisely the "costs the design" move. **Hoisting** is the free version.                                                                               |
| `useMapReload` is at `src/modules/news/`                    | It is at `src/modules/**maps**/useMapReload.ts`.                                                                                                                                                                           |
| "Back-facing globe markers still cost full price"           | **Unverified speculation.** `mapbox-gl` is CDN-loaded and unreadable here.                                                                                                                                                 |
| `mapReady` not reset on remount is a bug                    | **Refuted.** The injected string is `window.updateThreats && …` — a guarded no-op — and the new page's `ready` re-injects.                                                                                                 |
| Drawer swipe re-renders the screen per frame                | **Refuted.** `setDrawerIndex` fires in `onMomentumScrollEnd` (once per settled swipe); `setPagerW` in `onLayout` (once, ever).                                                                                             |

---

## 3. What was SHIPPED — free and correct either way

| #   | Change                                                                                                                                                                                                                                 | Why it is unblocked                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Idle the map when it is not the visible tab.** `window.setMapActive(false)` sets `body.idle`, which pauses every marker's `radar` animation (and `map.stop()`s any in-flight easing). Driven off `activeTab`, re-applied on `ready`. | **Unobservable by construction** — it only applies while the surface is at `opacity: 0`. With the camera at rest that animation is the _only_ frame source in the page, so a hidden map goes to ~zero. Zero design cost, correct whichever critic is right. |
| 2   | **Cap the WebView marker payload at 30**, severity-sorted so CRITICAL survives the cut. Capped at the **`threatsJs` render boundary**, NOT on `clusters`.                                                                              | Bounds a genuinely unbounded cost (marker count grows with news volume, forever). Capping `clusters` itself would resurface the 2026-07-31 "bubble says 2, drawer lists 5" class.                                                                           |
| 3   | **Hoist the 220-view scanline overlay to a module-level constant element.**                                                                                                                                                            | React skips the subtree by reference identity. The repo's own prior audit already called hoisting "free". **Not deleted.**                                                                                                                                  |
| 4   | **Move the 1 Hz clock into `<UtcClock/>`.**                                                                                                                                                                                            | Free, and both critics agreed. See the honesty note below.                                                                                                                                                                                                  |
| 5   | **Wire `mapHealth.onError()`** for pre-load failures only.                                                                                                                                                                             | Correctness, not perf — see §5.                                                                                                                                                                                                                             |

### Honesty note on #4 — do not oversell this

Extracting the clock removes roughly **1–3 ms of JS per second**. That is 0.1–0.3% of a
second and **the founder will not feel it**. A prior audit graded it "cheap" before this
argument started, and it was right.

What it _does_ fix is a **visible glitch**: the ticker's `Animated.View` receives a fresh
children array every render, and RN's AnimatedProps memo retains arrays **by reference**,
so the composite key never matched — a new `AnimatedProps` node was built every second,
calling `__restoreDefaultValues()` and re-attaching mid-marquee. If the bottom ticker was
visibly hitching once a second, that is why, and this fixes it.

**It is a glitch fix, not the cure.**

---

## 3b. REVISION — the held items shipped too (founder decision)

The §4 table below was written as a HOLD list. The founder was told plainly that
the safe fixes probably would not be felt, that everything with a real chance of
being felt was on the hold list, and that the blocker was one 10-minute
measurement. Their instruction: **"fix both the js and webview side."**

That is the call, so the hold list shipped. **It remains UNMEASURED** — §4 is
kept below as the record of what was traded and on what evidence. If a device
trace later shows these were not the cost, the honest move is to **restore the
design**, not to keep a change that bought nothing.

### WebView side — every one a PER-FRAME cost over a live WebGL canvas

| Change                                                                                                    | Was                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mix-blend-mode: screen` **removed** from `.crosshair`                                                    | A **viewport-sized** blend element forced the compositor to keep the GL canvas readable and blend it every frame. Unlike the marker blurs this was full-screen — the adjudicator's pick for the strongest single item. Grid alphas 0.04 → 0.05 to compensate for the lost screen-blend brightening. |
| `backdrop-filter` **removed** from `.threat .badge`                                                       | One backdrop **readback per marker per frame**, and the region it sampled contained the animating ring above it, so it was forced to re-sample continuously. Now an opaque disc — 24 px over a dark basemap, visually equivalent.                                                                   |
| `backdrop-filter` **removed** from `.hud-corner` + 3× `.zoom-btn`                                         | Four more blur regions, re-sampled whenever the map moved. The glass look is carried by the translucent fill, inset highlight and drop shadow, which are free.                                                                                                                                      |
| `radar` animation is now **opt-in** (`.ring2.pulse`), applied to **CRITICAL/HIGH only**                   | Every marker animated infinitely, so **the compositor could never idle** and the cost grew with news volume. Also better information design: the pulse now _means_ severity instead of being uniform decoration. `will-change` keeps the few that animate on their own layer.                       |
| `renderThreats` now **reconciles** (`markerByKey`) instead of `clearMarkers()` + full `innerHTML` rebuild | Ran at least twice per feed load and on every filter tap, re-creating ~7 DOM nodes and a `mapboxgl.Marker` per bubble — and **restarting every pulse from zero**. Survivors are now patched in place; only departures are removed.                                                                  |
| `map.on('error')` posts **only before `load`**                                                            | Mapbox GL fires `error` for recoverable tile 404s, so this was unbounded bridge traffic during exactly the pan that was already struggling — and the RN side discarded every one of them.                                                                                                           |

### JS side

| Change                                                                                                               | Was                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wire list → **`FlatList`** with `React.memo(WireRow)` and stable `keyExtractor`/`renderItem`/`contentContainerStyle` | A plain `ScrollView` + `.map()` mounting ~60 rows (~10 native views each) **synchronously on the BRAVO FEED tap** — the "stuck for a couple of seconds" tab switch.                                                                                                |
| Ticker rows → `useMemo`                                                                                              | A bare IIFE rebuilding 10 strings, a 20-element array and 80 elements per render — **and it is the `children` of an `Animated.View`**, whose AnimatedProps memo retains arrays by reference, so the live marquee's native animation was torn down and re-attached. |
| Map stat row → one-pass `useMemo`                                                                                    | Two full `items.filter()` scans plus a 4-object literal, inline in the render body.                                                                                                                                                                                |
| `setMapExtras(EMPTY_EXTRAS)`                                                                                         | A fresh `[]` literal invalidated the whole memo chain (`mapItems → mapMarkers → clusters → threatsJs → inject`) on **every** load, so `clusterMarkers` being correctly memoised was true but beside the point — its memo was structurally guaranteed to miss.      |
| `geotag()` → precompiled `GEO_MATCHERS`                                                                              | Up to 98 `new RegExp` per un-geotagged item, inside a synchronous `.map` over the feed. One alternation per row replaces up to 5 constructions + 5 tests with **zero** constructions and one test.                                                                 |
| `renderLoading` hoisted; `React.memo(ShareNewsSheet)` + stable `closeShare` at both hosts                            | Fresh closures per render.                                                                                                                                                                                                                                         |

**A proposal I refused:** the critic suggested `if (!item) return null` at the top
of `ShareNewsSheet`. That is a **crash** — the return sits above six hooks, so the
first time `item` went null → object React would see the hook count jump 0 → 6
and throw _"Rendered more hooks than during the previous render"_. `React.memo`
achieves the same saving with none of that risk.

**Deliberately still NOT changed:** `handleMapMessage` stays a fresh closure. The
critic measured its churn at four `EventEmitter` array ops per second, and the
fresh closure is **load-bearing for correctness** — the `'ready'` branch must
inject the _current_ `threatsJs`. A ref indirection would trade a real staleness
risk for nothing.

---

## 4. The HOLD list as it stood — kept as the evidence record

| Change                                                                                     | What unblocks it                                                                                          |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Remove / rest-pause `animation: radar … infinite` entirely                                 | WebView **renderer-process** CPU ≥ ~15% with the screen idle on BRAVO MAP                                 |
| Remove `backdrop-filter: blur(6px)` from `.threat .badge` (one render surface per marker)  | A DevTools Performance capture showing per-frame time in blur/render-surface passes                       |
| Remove `mix-blend-mode: screen` from `.crosshair` (full-viewport blend over the GL canvas) | Same capture showing a full-screen render surface for the blend                                           |
| Remove `backdrop-filter` from `.hud-corner` + 3× `.zoom-btn`                               | Same. Lower priority — 4 fixed elements, not per-marker                                                   |
| `antialias: false` on the Mapbox map                                                       | GPU/fill-rate evidence. Also a visible edge-quality change on the globe rim                               |
| **Delete** the scanline overlay                                                            | A `gfxinfo` A/B showing the RN-side composite is the binding cost                                         |
| Virtualise the wire list (~600 views mounted on a BRAVO FEED tap)                          | Real, and a genuine tab-switch hitch — but **absent from the reported state**. Worth doing; not this fix. |

### The measurement to run — and the one NOT to run

**Do NOT use `dumpsys gfxinfo <package>`.** Per §1 ground 2 it cannot see inside the
WebView and will hand back another false negative.

1. **10 minutes, decisive:** `adb shell top -o %CPU` (or `dumpsys cpuinfo`) on the WebView
   **renderer** process (`:sandboxed_process*`), screen parked idle on BRAVO MAP with the
   drawer open. Near-0% kills the compositor thesis outright; 20–40% confirms a continuous
   frame source and unblocks the whole table above.
2. **Definitive:** `chrome://inspect` on a debug build → Performance + Rendering → Frame
   Rendering Stats. Gives compositor FPS, layer count and per-pass cost directly.
3. Per CLAUDE.md: **interleave A/B (OLD, NEW, OLD, NEW)** — thermal drift exceeds most of
   these effects.

---

## 5. Correctness bug found in passing (not lag)

`useMapReload` exports `onError`, documented _"Call on an explicit fatal signal (e.g. a
pre-load `maperror` message)"_ — and **nothing called it**. `IntelFeedScreen` wired
`onReady`, `retry`, `reloadKey` and `status` only. So `post('error', {msg:'gl-unsupported'})`
and a throwing map constructor were both parsed and dropped, and the user stared at a blank
map for the **full 15 s watchdog** before recovery was attempted. On a device without WebGL
that reads as "the map is broken".

Now wired — **pre-load only**. Mapbox GL fires `error` for recoverable tile 404s too, so
escalating post-`ready` errors would reboot a healthy map whenever one tile failed.

---

## 6. Also found, NOT fixed (logged)

- **`setMapExtras([])` passes a fresh array literal on every load**, even when already
  empty. That new reference invalidates the whole memo chain
  (`mapItems → mapMarkers → clusters → threatsJs → injectJavaScript`), so the
  "correctly memoised" clearance on `clusterMarkers` is only half true: the function is
  O(n), but its memo is **structurally guaranteed to miss on every load**. Fix is a
  module-level `EMPTY` const or `setMapExtras(prev => prev.length ? [] : prev)`.
- **`renderThreats` does no diffing** — it `clearMarkers()` then rebuilds every marker via
  `innerHTML`, twice per feed load. Cost lands in the WebView renderer, not the RN thread.
- **`geotag()`'s 98 RegExp constructions per call** — hoist into the same IIFE as
  `COUNTRY_MATCHERS` (~6 lines). A one-shot per-load hitch, not a per-frame cost.
- **`map.on('error')` posts a bridge message per tile 404**; RN now ignores post-`ready`
  ones deliberately, so the send could be dropped.
- **The wire list is unvirtualised** (~600 views on a tab tap).

---

## 7. Gates

| Gate                                                   | Result                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `npx jest --selectProjects app --testPathPattern news` | **124 passed** (baseline 111; +13 from the new pin)                        |
| `intelFeedRenderCost.test.ts` (NEW)                    | 13 pins, **mutation-proved**: 3 independent mutations → exactly 3 failures |
| `npm run typecheck`                                    | **46**, unchanged from baseline (`.tsc-baseline.json` = 47)                |
| `npx eslint` on both changed files                     | clean                                                                      |

**A trap this work hit:** I put backticks inside a comment **inside the HTML template
literal** in `bravoMapHtml.ts`, which terminated the string and produced a baffling
`TS1005 / TS1443`. CLAUDE.md documents this exact trap as having happened twice before.
Now three times. The whole typecheck aborts, so the error count _drops_ — a green-looking
number that is actually a parse failure.

---

## 8. OWED

- **The renderer-process CPU read is STILL the deliverable**, and now for a second
  reason: it is no longer just "what unblocks the fix", it is **the check on whether
  the design cost was worth paying**. Run it A/B (this build vs the previous APK):
  ```
  adb shell top -o %CPU        # watch the :sandboxed_process* renderer
  ```
  Screen parked idle on BRAVO MAP, drawer open. Interleave OLD/NEW/OLD/NEW — thermal
  drift exceeds most of these effects.
- **If the founder reports no improvement, restore the visual effects.** They were
  removed on a mechanism, not a measurement. Keeping a change that costs design and
  buys nothing is precisely the failure CLAUDE.md's lag section documents — and the
  four removed properties are each a one-line revert.
- **The wire-list virtualisation is safe to keep regardless** — it addresses a
  different symptom (the tab-switch mount) with no visual cost.
- **Device pass owed on the design changes themselves**, not just the perf: the
  crosshair grid alphas were nudged 0.04 → 0.05 to compensate for the removed
  screen-blend, and the badge/HUD/zoom fills were raised to near-opaque. Those are
  judgement calls made without seeing them on a phone.
