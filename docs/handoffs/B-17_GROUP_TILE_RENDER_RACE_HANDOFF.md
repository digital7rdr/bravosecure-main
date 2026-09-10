# B-17 — Group Tile Blank / Render Race — Implementation Hand-off Spec

> **Audience:** a fresh Claude/engineer session that will FIX B-17 without re-reading the
> whole codebase. Read this top-to-bottom before opening any file.
> **Author:** SQA investigation session, 2026-06-14 (read-only; no code changed).
> **Repo state when written:** branch `main`, commit `8b9393f`. Today = 2026-06-14.
> **Golden rule for this task:** B-17 is _already heavily fixed in code_. The #1 way to
> "fix one bug and break another" here is to re-implement something that already exists.
> **VERIFY FIRST, then — only if a blank tile actually reproduces — apply a targeted fix
> from §6.** Do not rewrite the render pipeline.

---

## 0. TL;DR (the verdict)

B-17 is **not a clean open bug**. Across 2026-06-08 → 2026-06-14 it was attacked on
_five_ layers, every one of which is present in `main` today and pinned by unit tests:

1. Boot-batch tile flush (host/joiner consume at final count) — `useGroupCall.ts`.
2. Reconcile-on-**tiles** (rebuild an orphaned-but-consumed tile) — `useGroupCall.ts`.
3. Zombie/phantom **prune** (`computeTilePrune`) — `groupCallLayout.ts` + 8 tests.
4. Single-source **render list** (`buildRenderEntries`) — kills "position-but-no-tile".
5. Opacity **latch** fix (`resolveTileOpacityAction`) + non-zero surface fallbacks
   (`resolveTilePositions` BS-GC-0x0 / BS-GC-BLACKVIDEO) — kills "tile stuck invisible /
   0×0 black surface".

The reason the `sqa.md` summary table still shows **B-17 = FAIL** is **not** a known code
defect — it is that **none of the render-path fixes has ever been verified on a live 3+‑person
group VIDEO call** (QA has repeatedly lacked the 3-device resources; see the B-19 note in
`sqa.md`). So:

- **Most likely outcome:** B-17 passes on a real device → close it. **No code change.**
- **If it still reproduces:** the residual is narrow and native/timing-shaped. §5 tells you
  exactly what to capture; §6 maps each possible symptom to one minimal, guard-railed fix.

Do **not** start by writing code. Start with §5.

---

## 1. Disambiguation — there are THREE things called "B-17"

The bug log conflated several symptoms under one number. Know which one you're chasing:

| Facet                                                  | Symptom                                                                                                                                        | Where it came from                                              | Status in `main`                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **B-17a — rotating victim**                            | A non-host **joiner** shows only **2 of 3** tiles; the missing one rotates per call. Audio of the missing peer plays fine.                     | `sqa.md` original B-17 (2026-06-08, line ~1747)                 | Fixed by reconcile-on-tiles (§3.2)                                                         |
| **B-17b — zombie / extra blank cell**                  | An **extra blank** cell next to the real peers after a WS reconnect/room recreate (B-05/B-08 churn).                                           | 2026-06-09 dev fix session (`sqa.md` line ~2499)                | Fixed by `computeTilePrune` (§3.3)                                                         |
| **B-17c — blank cell / stuck-invisible (render race)** | A tile has a slot/position but draws **blank**, or a tile goes invisible and never returns. **This is the facet the tester's note describes.** | Structural render-race in `GroupCallScreen` ↔ `groupCallLayout` | Fixed by `buildRenderEntries` + `resolveTileOpacityAction` + surface fallbacks (§3.4/§3.5) |

The tester's hand-off text ("a group video tile comes up blank due to a render race in tile
layout; source file `groupCallLayout.ts`") is **B-17c**. `groupCallLayout.ts`'s render math is
**correct and unit-tested** — the B-19 fix note in `sqa.md` (2026-06-14) states this
explicitly: _"The pure resolver math (`groupCallLayout.ts`) is correct + unit-tested — NOT the
bug."_ If a blank tile remains, it is in the **wiring/timing/native** layers, not the math.

---

## 2. The render pipeline (understand this before touching anything)

Data flows one direction. Memorise it; every fix decision keys off "which stage is wrong".

```
 useGroupCall.ts  ───────────────────────────────────────────────────────────────
   SFU events → consumeProducer() builds a RemoteTile → setRemoteTiles()
     • step=9 boot burst   (batch=true → ONE flush after loop, at final count)   [§3.1]
     • live sfu.new-producer (batch=false → immediate per-tile)
     • reconcileProducers() every 4 s: rebuild orphaned tile / prune zombie       [§3.2/§3.3]
   exposes:  call.remoteTiles : RemoteTile[]   +   call.identityByTag
 ─────────────────────────────────────────────────────────────────────────────────
                                   │  (call.remoteTiles, call.audioLevels)
                                   ▼
 GroupCallScreen.tsx  ─────────────────────────────────────────────────────────────
   merged   = mergeAndSortTiles + applyHeroHold  (+ Fix#12 stable-ref cache)  [GCS ~498–528]
   layout   = paginateOthers(merged, SELF_TILE)                               [GCS ~526]
   ┌─ tilePositions = resolveTilePositions(layout, slotRectsRef, PAGE_W)      [GCS ~658]
   │     + retained-but-absent tags get {visible:false}
   ├─ renderEntries = buildRenderEntries(layout, retainedRef)                 [GCS ~681]  ← B-17c
   └─ opacity effect = resolveTileOpacityAction(prev, next) per tag           [GCS ~701]  ← B-17c
                                   │
                                   ▼
   renderEntries.map(e => renderPersistentTile(e, tilePositions[e.tile.tag])) [GCS ~1859]
     • ONE persistent <View key={tag}> per tag (Fix#13 — RTCView NEVER unmounts on role swap)
     • wrapperStyle pins MEASURED slot height (BS-GC-BLACKVIDEO)              [GCS ~1492–1499]
     • invisible flexbox "skeleton" measures slot rects via onLayout         [GCS ~1758–1852]
```

`call.remoteTiles` is the single source of truth coming out of the hook. Everything in the
screen is a _pure derivation_ of it (all three derivations recomputed on the **same render
tick** — that co-tick property is the B-17c fix; do not break it).

---

## 3. What is ALREADY fixed — DO NOT re-implement, DO NOT regress

Each item lists the exact location and the test that pins it. Treat these as **guard-rails**:
if your change makes any of these regress, you have re-opened a closed bug.

### 3.1 Boot-batch tile flush (B-13/B-17a) — `useGroupCall.ts`

- step=9 consumes every existing producer with `batch=true`, collecting into
  `pendingTileBatch`, then flushes **once** after the loop (`useGroupCall.ts:1586–1605`). This
  makes `paginateOthers` compute at the FINAL participant count, not "1".
- The live `sfu.new-producer` path and the reconcile tick pass `batch=false` so mid-call tiles
  render immediately (`useGroupCall.ts:1689–1697`). **Do not let `batch` leak to the live
  path** — that is the documented "switch-to-video doesn't show" regression.

### 3.2 Reconcile-on-TILES, not just consumers (B-17a) — `useGroupCall.ts:1947–2011`

- The 4 s `reconcileProducers()` diff is keyed on **`haveTileFor` (producerIds with a tile)**,
  not on "has a consumer". A producer that was consumed (audio flowing) but lost its tile to a
  race is rebuilt from its **existing** consumer (`recovered[]`, lines 1960–2011) — re-consuming
  would throw "consumer already exists".
- This is the direct fix for the original rotating-victim 2/3 symptom.

### 3.3 Zombie + phantom prune (B-17b) — `groupCallLayout.ts:computeTilePrune` (114–150)

- Pure, side-effect-free. Wired in `useGroupCall.ts:2029–2057`.
- **Immediate** prune when a tag is gone from the SFU snapshot AND the same `userId` is live
  under a different tag (reconnect→rejoin / B-05 churn). **Debounced** (3 consecutive successful
  snapshots, `PRUNE_MISS_THRESHOLD`) otherwise, so a partial fetch can't evict a live peer.
- Identity (tag→userId) comes from `getGroupCallIdentities(rid)`, populated by each peer's
  `groupCallPresence` envelope. **Coupling:** if identities are empty, the _superseded_ path
  can't fire and prune degrades to the ~12 s debounce. That's graceful, not a blank-forever.
- Pinned by **`src/modules/messenger/__tests__/groupCallTilePrune.test.ts` (8 tests)**.

### 3.4 Single-source render list (B-17c) — `groupCallLayout.ts:buildRenderEntries` (330–355)

- The tiles layer iterates `renderEntries` (derived from `layout` on the SAME tick positions
  are resolved), **never** the retention ref directly (`GroupCallScreen.tsx:1859`). This is the
  structural fix for "slot has a position but renders no tile" (the old code iterated a
  retention Map mutated in a `useEffect`, one tick behind).
- Invariant: every tag in `renderEntries` has an entry in `tilePositions` (layout tags via
  `resolveTilePositions`; retained-absent tags via the overlay at `GroupCallScreen.tsx:662–668`).
  **Do not** introduce a render entry whose tag has no position — the `if (!pos) return null`
  guard at line 1861 would silently drop it (a blank cell).
- Pinned by `buildRenderEntries` tests in `groupCallLayout.test.ts` (incl. "every emitted
  layout tag has a position from resolveTilePositions").

### 3.5 Opacity latch + non-zero surface (B-17c) — `groupCallLayout.ts`

- `resolveTileOpacityAction` (372–383): removes the one-way `hidden→0` latch — a tile that went
  hidden while keeping its role now returns to opacity 1 (`'show'`). Wired at
  `GroupCallScreen.tsx:701–734`. Pinned by the "visibility latch" tests in `groupCallLayout.test.ts`.
- `resolveTilePositions` fallbacks (453–535): an unmeasured slot gets a **non-zero width AND
  height** derived from `pageW` (BS-GC-0x0 / BS-GC-BLACKVIDEO). Shipping `0×0` made the RTCView a
  dead surface that `BLASTBufferQueue` rejected → permanent black tile. **Never** reintroduce a
  0-width or 0-height fallback. The render wrapper also pins `pos.height` when measured
  (`GroupCallScreen.tsx:1492–1499`).
- `Fix#13`: ONE persistent `<View key={tag}>` per tag; RTCView never unmounts across hero↔small
  swaps or page swipes. **Never key a tile by anything that changes mid-call** (role, page,
  index) — that forces an EGL/decoder teardown and is its own black-tile bug.

---

## 4. Why it still shows FAIL (the honest gap)

- All of §3 is **code-green** (typecheck ≤ baseline; `groupCallLayout.test.ts` and
  `groupCallTilePrune.test.ts` pass) but **the GroupCallScreen render path cannot be exercised
  by Jest** (the screen render test is infra-skipped — see B-33 note in `sqa.md`). Native
  surface/`BLAST`/decoder behaviour is **device-only**.
- No session has had **three devices on one group VIDEO call** to confirm the render fixes on
  hardware. B-19 (the tile-**geometry** sibling) is in the same state: "FIX APPLIED · device-verify
  pending".
- Therefore the correct next step is **device verification (§5)**, which either closes B-17 or
  produces the precise evidence to localise any true residual.

---

## 5. MANDATORY verify-first protocol (do this before any code change)

You need **3 real Android devices** (BlueStacks is NOT sufficient — it fakes 'live' tracks and
can't reproduce the BLAST/decoder path). Accounts from `sqa.md` Device & Identity Reference:
itsirajul / shirajul / fahim. Use a **real synced group** (owner-hosted), e.g. "SQA - ITSirajul"
`4100833dd9da…` — ad-hoc/non-owner-hosted calls drag in B-04/B-13 and muddy the signal.

### 5.1 Build & attach

- Build a debug/staging APK from `main` @ `8b9393f` (see memory `b19-tile-layout-fix` for the
  adb debug-build-over-USB loop; `release-apk.ps1` for staging). Install on all 3.
- `adb -s <serial> logcat -c` on each, then start capturing:
  `adb -s <serial> logcat | grep -E "bravo.groupcall|BLAST|FrameCryptor|ReactNativeJS"`.

### 5.2 Repro matrix (run each twice — the bug is intermittent)

1. **Voice** group call, 3 joiners (host = itsirajul). Confirm each non-host shows **3** avatar
   tiles. (B-17a)
2. **Video** group call, 3 joiners. Confirm each device shows **3** video tiles, none blank,
   none black, name-plates not clipped. (B-17c + B-19)
3. **Mid-call upgrade:** start voice, then each device taps camera on one at a time. Confirm the
   new video tile appears on every other device. (batch-leak regression check)
4. **Churn:** during a 3-way call, kill Wi-Fi on one device ~10 s, restore. Confirm the peer
   returns as **one** tile (no extra blank "zombie" cell, no lost tile). (B-17b)

### 5.3 What to capture for EACH blank/missing tile (this is the localiser)

Record, for the affected device and the victim's participantTag:

- **Does audio play** for the victim? (`consumer attached (FrameCryptor)` present?) → yes means
  consume worked; the fault is render-side (§6 path A/B). No means consume failed (§6 path C).
- The boot lines: `step=9 consuming N existing producer(s)`, each `step=9 consume tag=… kind=…`.
- Reconcile lines over the next ~12 s: `reconcile rebuilding N orphaned tile(s)`,
  `reconcile pruning N stale tile(s)`, `reconcile consuming N missing producer(s)`.
- Any `BLASTBufferQueue rejecting buffer: active_size=…x… vs buffer=…x…` lines (native surface
  sizing — points at §6 path B).
- Whether the victim's tag ever appears in `identityByTag` (presence delivered?).

Attach the three logs + a screenshot of each device's grid to the B-17 entry in `sqa.md`.

---

## 6. IF (and only if) a blank tile reproduces — symptom → fix decision tree

Pick the ONE path that matches your §5.3 evidence. Each fix is minimal and lists what it must
**not** disturb. Write the failing test FIRST where a pure helper is involved.

### Path A — victim's audio plays, reconcile logs `rebuilding … orphaned tile(s)` but the tile still never appears

Root cause is the **orphan-rebuild consumer lookup**. In `reconcileProducers`
(`useGroupCall.ts:1960–1984`) a no-tile-but-consumed producer is rebuilt by scanning
`consumersByPid.current.values()` for one whose **`.producerId`** matches (cast at
lines 1966–1968). **Note the trap:** `consumersByPid` is misleadingly named — it is **keyed by
`consumerId`** (`set(c.id, c)` at 1782), and the match relies on the mediasoup `Consumer` object
exposing a runtime `.producerId`. If that property is absent/renamed, `live` is null → the
producer falls to `toConsume` → `consumeProducer` **early-returns** at line 1709
(`consumedProducerIdsRef.has(producerId)` is true) → **the tile is never rebuilt**.

- **First: instrument, don't patch.** Log `c.producerId` for the consumers in that scan and
  confirm whether the match actually fails. mediasoup-client `Consumer` normally _does_ carry
  `.producerId`, so this may be fine — confirm before editing.
- **If the match genuinely fails:** make the lookup reliable rather than forcing a re-consume.
  Maintain a `producerId → consumerId` index alongside `consumersByPid` (populate at
  `useGroupCall.ts:1782`, delete on teardown at 1803/1874/1914/2049), and use it in the rebuild.
- **Do NOT** "fix" this by deleting `consumedProducerIdsRef` then re-consuming — re-consuming a
  producer that still has a live mediasoup consumer throws "consumer already exists" (the exact
  thing the rebuild path exists to avoid). Keep the existing consumer; only rebuild the React tile.
- Add a unit test for the new index helper (pure map in/out). Guard-rails: don't touch §3.1
  batch semantics, don't touch SFrame/crypto.

### Path B — victim's audio plays, tile is present but **black/blank video**, `BLAST … rejecting buffer` in logcat

Native surface sizing — the slot was unmeasured when the first keyframe landed. The fixes for
this already exist (§3.5: non-zero W+H fallback + pinned measured height). If it still happens:

- Confirm the **skeleton onLayout actually fired** for that slot — add a one-shot log in
  `bumpSlotRects` printing the measured `slotRectsRef` and `PAGE_W`/`Dimensions`
  (`GroupCallScreen.tsx:563–567`, skeleton at 1758–1852). A slot whose `onLayout` never fires
  stays on the fallback forever; that's the real defect to chase (e.g. a `display:none`/0-height
  skeleton ancestor), NOT the resolver math.
- Verify the fallback heights are non-zero for this device's `PAGE_W` (they are derived at
  `groupCallLayout.ts:473–486`). **Never** ship a 0 in either axis.
- This is the **B-19 hypothesis-C** territory (PAGE_W as a stale module constant → not
  responsive to rotation/fold/split-screen). If the blank only appears after rotation/multi-window,
  that's B-19 hypothesis C — coordinate with B-19, do not duplicate.

### Path C — victim's audio does NOT play (no `consumer attached`) and tile is absent

Not a render race — it's a **consume/boot** failure (B-06 family). The producer frame was missed
in the join→recvTx window, or consume exhausted retries.

- Confirm `earlyProducerBuffer` drained (`step=9b draining N early producer(s)`,
  `useGroupCall.ts:1613–1616`) and the 4 s reconcile is firing
  (`reconcile consuming N missing producer(s)`).
- If reconcile never fires, the boot closure's `reconcileProducersRef` wasn't set
  (`useGroupCall.ts:2064`) — investigate the boot abort/`cancelled` path, not the layout.
- This overlaps B-06/B-08; if you confirm it, log it as a B-06 recurrence rather than B-17.

### Path D — tile flickers in then vanishes after ~5 s (steady call)

Retention eviction firing on a live tag. This was the **BS-024** bug and is already fixed
(`GroupCallScreen.tsx:588–654`: the eviction timer refreshes `lastSeenMs` from live
`remoteTilesRef`). If it recurs, the regression is there — confirm the live tag is in
`remoteTilesRef.current` at tick time. Do not lengthen `RETENTION_TTL_MS` as a "fix"; that hides
the real eviction bug.

### Path E — tile positioned correctly but stuck at opacity 0

Opacity latch (already fixed via `resolveTileOpacityAction`). If it recurs, add the failing case
to the "visibility latch" describe block in `groupCallLayout.test.ts` first, then adjust the pure
helper — never patch the screen's effect with an ad-hoc branch (that's how the original one-way
latch happened).

---

## 7. Scoping / coupling rules (what NOT to touch — read before editing)

These are the "fix-one-break-another" landmines specific to this area:

- **Crypto / SFrame / FrameCryptor:** OUT OF SCOPE and security-gated (`CLAUDE.md` → Security
  constraints). B-17 is render-only; media already **decrypts** (consumers attach). Never add a
  "skip" branch around any verify/key gate.
- **`keepAlive` / minimize-restore semantics** (`groupCallRegistry`, B-33): the call survives
  `GroupCallScreen` unmount. Don't change the boot-effect cleanup or `leaveInternal` skip — you'll
  reopen B-33.
- **Fix#13 React keys:** every tile is `<View key={tag}>`. Do not add a nested key that changes
  with role/page, and do not key on `consumerId` (it changes on rebuild). That re-mounts RTCView.
- **`batch` flag** (§3.1): boot burst only. Never `true` on live/reconcile paths.
- **`resolveTilePositions` fallbacks:** never 0 in width or height.
- **`computeTilePrune` thresholds / superseded rule:** changing the debounce or the
  superseded test will reopen B-17b or risk evicting live peers. If you must, add tests first.
- **Pure helpers stay pure:** `groupCallLayout.ts` functions must not touch React, refs,
  `Date.now()`, or module state (`now` is always a param). That purity is what makes them testable
  and is enforced by reviewer expectation.
- **Do not "simplify"/refactor the render pipeline.** Minimal diff only — this is a bug fix.

---

## 8. Tests & gates (must pass before declaring done)

- **Write the failing test first** for any pure-helper change (`groupCallLayout.ts`):
  `src/modules/messenger/__tests__/groupCallLayout.test.ts` (render math/opacity/positions) or
  `groupCallTilePrune.test.ts` (prune). Add a new `*.test.ts` for a new pure helper (e.g. a
  producerId→consumerId index).
- **Targeted first:** `npm run test:crypto` (covers the messenger-crypto project incl. the
  groupCall layout/prune suites) — fail fast.
- **Broad second:** `npm test` (all 3 Jest projects).
- **Typecheck:** `npm run typecheck` — must NOT exceed `.tsc-baseline.json` (baseline noted as
  49 in recent sessions / 84 historically; do not increase it). `cd apps/ops-console && npm run
typecheck` if you touched anything shared.
- **Device smoke is the real gate** for this bug (§5). Jest cannot prove a render/native fix.
  State explicitly in the PR/commit whether device-verify was done or is still pending.
- **Do not commit on a red gate; do not `--no-verify`.** (`CLAUDE.md` change-safety rules.)

---

## 9. File & line index (snapshot @ `8b9393f` — re-confirm before editing)

| Concern                                        | File                                                                                      | Lines                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Pure prune (zombie/phantom)                    | `src/modules/messenger/webrtc/groupCallLayout.ts`                                         | `computeTilePrune` 114–150                                           |
| Single-source render list                      | same                                                                                      | `buildRenderEntries` 330–355                                         |
| Opacity latch decision                         | same                                                                                      | `resolveTileOpacityAction` 372–383                                   |
| Position resolver + non-zero fallbacks         | same                                                                                      | `resolveTilePositions` 453–535                                       |
| Merge/hero/paginate                            | same                                                                                      | `mergeAndSortTiles` 190 / `applyHeroHold` 226 / `paginateOthers` 279 |
| Boot-batch tile flush                          | `src/modules/messenger/webrtc/useGroupCall.ts`                                            | 1583–1605                                                            |
| `consumeProducer` (+ early-return trap)        | same                                                                                      | 1697–1916 (early-return 1705–1709)                                   |
| Reconcile orphan-rebuild + prune               | same                                                                                      | 1935–2063 (rebuild 1960–2011; prune 2029–2057)                       |
| `consumersByPid` (keyed by **consumerId**)     | same                                                                                      | decl 326; set 1782                                                   |
| RemoteTile state + identityByTag               | same                                                                                      | 292–293; refs `remoteTilesRef` 2445–2446                             |
| merged → layout                                | `src/screens/messenger/GroupCallScreen.tsx`                                               | merged 498–519; layout 526–529                                       |
| tilePositions / renderEntries / opacity effect | same                                                                                      | 658–670 / 681–684 / 701–734                                          |
| renderPersistentTile + wrapper height pin      | same                                                                                      | 1448–1620 (wrapperStyle 1492–1499)                                   |
| Skeleton onLayout (slot measurement)           | same                                                                                      | 1758–1852                                                            |
| Tiles-layer render loop                        | same                                                                                      | 1857–1864                                                            |
| Retention map + BS-024 eviction-refresh        | same                                                                                      | 568–654                                                              |
| Tests (pins)                                   | `src/modules/messenger/__tests__/groupCallLayout.test.ts`, `…/groupCallTilePrune.test.ts` | —                                                                    |

---

## 10. One-paragraph brief for the implementing session

> B-17 (group video tile blank / render race) is already fixed across five layers — boot-batch
> flush, reconcile-on-tiles, `computeTilePrune`, `buildRenderEntries`, and
> `resolveTileOpacityAction` + non-zero surface fallbacks — all in `main` @ `8b9393f` and pinned
> by `groupCallLayout.test.ts` / `groupCallTilePrune.test.ts`. It still shows FAIL only because
> the render path has never been verified on a live 3-device group video call (Jest can't exercise
> the native surface). **Do §5 first: run the 3-device repro matrix and capture the per-victim
> evidence.** If every tile renders, close B-17. If one is blank, match your evidence to ONE path
> in §6 and apply that single guard-railed fix (write the pure-helper test first); obey the §7
> landmines — especially: don't re-key tiles, don't leak `batch` to the live path, don't ship a
> 0-sized fallback, and never touch SFrame/crypto. Run `npm run test:crypto` then `npm test` then
> typecheck, and report device-verify status honestly.
