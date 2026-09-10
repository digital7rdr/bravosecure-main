/**
 * groupCallLayout — pure layout helpers extracted from GroupCallScreen.
 *
 * Three independent pure functions. None of them touch React, refs,
 * Date.now(), or module-level state. Reference identity stability for
 * RTCView-remount-avoidance is the screen's responsibility (useMemo +
 * a debounce cache) — these helpers only own the math.
 *
 * Behaviour preserved bit-for-bit from GroupCallScreen.tsx pre-extraction:
 *   • mergeAndSortTiles — collapse (audio,video) pairs by tag, attach
 *     audioLevel, sort by audioLevel desc.
 *   • applyHeroHold — hero-pin + silence-pin + speaker-promotion. Returns
 *     a NEW array (input not mutated) and the next hold state. Caller
 *     writes the ref.
 *   • paginateOthers — page 1 = hero + 2 small; page 2+ = chunks of 3.
 *     Self always last.
 *
 * Invariants:
 *   • Functions never mutate inputs — callers can pass cached arrays.
 *   • applyHeroHold returns the SAME `prev` reference for `nextHold`
 *     when the hold is unchanged. This lets the screen short-circuit
 *     a useRef write with `===`.
 *   • `now` is an explicit parameter (tests are deterministic).
 */
import type {RemoteTile, GroupCallState} from './useGroupCall';

/**
 * BS-GC1 — terminal "call is over" states that must auto-pop the
 * GroupCallScreen. 'ended-by-host' (server fired sfu.room.ended) and
 * 'left' (normal hangup / last-out) clear the registry, so the screen
 * would otherwise fall through to the live UI showing "Connecting…"
 * forever with no exit. 'kicked'/'failed'/'full'/'unavailable' have
 * their OWN blocking-state screen with a Close button, so they are NOT
 * auto-popped here. Pure predicate so the decision is unit-testable.
 */
export function isTerminalPopState(state: GroupCallState): boolean {
  return state === 'ended-by-host' || state === 'left';
}

/** Delay before the auto-pop so the user perceives the call ending. */
export const TERMINAL_POP_DELAY_MS = 350;

/**
 * Display mirror of the server's MAX_PARTICIPANTS_PER_ROOM
 * (apps/messenger-service/src/sfu/sfu.service.ts) — keep in sync. The
 * server enforces the cap (room_full); this constant only drives copy
 * like "Call is full (10/10)".
 */
export const GROUP_CALL_MAX_PARTICIPANTS = 10;

/**
 * Offscreen-video policy — which tags should have their video consumer
 * paused because their tile lives on a swipe page that is not on
 * screen. Pure page comparison: unmeasured slots (visible:false) still
 * belong to their page and follow the same rule. The self tile's tag
 * may appear in the result — the hook only acts on remote video
 * consumers, so it is naturally ignored. Fed to
 * useGroupCall.setHiddenVideoTags by the screen.
 */
export function resolveOffscreenVideoTags(
  positions: Readonly<Record<string, TilePosition>>,
  pageIndex: number,
): string[] {
  return Object.keys(positions).filter(tag => positions[tag].page !== pageIndex);
}

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

/**
 * Selfie-mirror truth for a call tile. Mirroring is only correct for the
 * user's OWN front (selfie) lens — a rear-lens preview must render
 * un-mirrored, and a remote participant's frame is never mirrored.
 * CallScreen's 1:1 tiles call this directly (B-454): once the two slots can
 * swap, "mirror follows the stream" has to be one rule, not a per-container
 * literal.
 */
export function shouldMirrorTile(isSelf: boolean, isFrontCamera: boolean): boolean {
  return isSelf && isFrontCamera;
}

/**
 * Apply an authoritative producer pause/resume (server push or
 * reconcile snapshot) to the tile list. Returns the same array
 * reference when nothing changed so setState can skip the render.
 */
export function applyProducerPaused<T extends {producerId: string; paused?: boolean}>(
  tiles: T[],
  producerId: string,
  paused: boolean,
): T[] {
  let changed = false;
  const next = tiles.map(t => {
    if (t.producerId !== producerId || !!t.paused === paused) {return t;}
    changed = true;
    return {...t, paused};
  });
  return changed ? next : tiles;
}

/**
 * Apply a server `sfu.producer-paused/-resumed` broadcast to the tile list,
 * matching on producerId FIRST and falling back to (participantTag, kind).
 *
 * Why the fallback: the camera-off→avatar swap hinges on flipping the right
 * tile's `paused` flag. The broadcast's `producerId` is the toggling peer's
 * server producer id; the consuming tile stores the id it consumed. Those are
 * normally equal, but a re-produce / simulcast change / reconnect can leave
 * them out of sync — and a producerId-only match then SILENTLY drops the flip,
 * so the peer's tile keeps trying to render a producer that's sending no frames
 * and FREEZES on its last decoded frame (the "camera off shows a frozen face
 * instead of an avatar" bug). `(participantTag, video)` is unique per
 * participant in this app, so the fallback is exact and drift-proof.
 *
 * Returns the SAME array reference (and matchedBy:'none') when nothing changed
 * so setState can skip the render. `matchedBy` is surfaced for field tracing.
 */
export function applyProducerPausedFrame<
  T extends {producerId: string; participantTag: string; kind: 'audio' | 'video'; paused?: boolean},
>(
  tiles: T[],
  frame: {producerId: string; participantTag?: string; kind?: 'audio' | 'video'},
  paused: boolean,
): {tiles: T[]; matchedBy: 'pid' | 'tag' | 'none'} {
  const byPid = applyProducerPaused(tiles, frame.producerId, paused);
  if (byPid !== tiles) {return {tiles: byPid, matchedBy: 'pid'};}
  if (frame.participantTag && frame.kind) {
    let changed = false;
    const byTag = tiles.map(t => {
      if (t.participantTag === frame.participantTag && t.kind === frame.kind && !!t.paused !== paused) {
        changed = true;
        return {...t, paused};
      }
      return t;
    });
    if (changed) {return {tiles: byTag, matchedBy: 'tag'};}
  }
  return {tiles, matchedBy: 'none'};
}

export interface ReconcileTileRef {
  participantTag: string;
  producerId:     string;
  consumerId:     string;
}

export interface ProducerSnapshotEntry {
  producerId:     string;
  participantTag: string;
}

export interface TilePruneResult {
  /** consumerIds whose tiles should be dropped this tick. */
  pruneConsumerIds:  Set<string>;
  /** producerIds dropped — caller clears these from its consumed-set. */
  prunedProducerIds: Set<string>;
  /** per-producer miss counter to carry into the next reconcile tick. */
  nextMisses:        Map<string, number>;
}

/**
 * B-17 — pure prune decision for the group-call reconcile loop.
 *
 * Given the SFU's authoritative producer snapshot, the per-room
 * tag→userId identity map, and the running per-producer "consecutive
 * misses" counter, decide which tiles to drop:
 *
 *   • IMMEDIATE (supersede): the tile's tag is gone from the snapshot AND
 *     the same userId is live under a DIFFERENT tag. That is positive proof
 *     a reconnect→rejoin replaced the tag (the B-05 WS-churn "zombie tile"):
 *     the old tag lingers blank while the peer is back under a fresh tag.
 *     Drop it THIS tick rather than waiting out the debounce.
 *   • DEBOUNCED: the producer is merely absent from the snapshot with no
 *     rejoin proof — drop only after `threshold` consecutive SUCCESSFUL
 *     snapshots so a one-off partial fetch can't evict a live participant.
 *
 * A tile whose producer is still live (in the snapshot) or in-flight resets
 * its miss counter. Side-effect-free: the caller closes the consumers and
 * updates React/registry state from the returned ids. `now`-free and
 * deterministic so it is unit-testable.
 */
export function computeTilePrune(args: {
  tiles:               ReadonlyArray<ReconcileTileRef>;
  snapshot:            ReadonlyArray<ProducerSnapshotEntry>;
  inFlightProducerIds: ReadonlySet<string>;
  identities:          Readonly<Record<string, {userId?: string} | undefined>>;
  prevMisses:          ReadonlyMap<string, number>;
  threshold:           number;
}): TilePruneResult {
  const {tiles, snapshot, inFlightProducerIds, identities, prevMisses, threshold} = args;
  const liveProducerIds = new Set(snapshot.map(p => p.producerId));
  const liveTags        = new Set(snapshot.map(p => p.participantTag));
  const liveUserIds     = new Set<string>();
  for (const tag of liveTags) {
    const uid = identities[tag]?.userId;
    if (uid) {liveUserIds.add(uid);}
  }
  const pruneConsumerIds  = new Set<string>();
  const prunedProducerIds = new Set<string>();
  const nextMisses        = new Map<string, number>(prevMisses);
  for (const t of tiles) {
    if (liveProducerIds.has(t.producerId) || inFlightProducerIds.has(t.producerId)) {
      nextMisses.delete(t.producerId);
      continue;
    }
    const tileUid    = identities[t.participantTag]?.userId;
    const superseded = !!tileUid && !liveTags.has(t.participantTag) && liveUserIds.has(tileUid);
    const misses = superseded ? threshold : (nextMisses.get(t.producerId) ?? 0) + 1;
    if (superseded) {nextMisses.delete(t.producerId);}
    else {nextMisses.set(t.producerId, misses);}
    if (misses >= threshold) {
      pruneConsumerIds.add(t.consumerId);
      prunedProducerIds.add(t.producerId);
      nextMisses.delete(t.producerId);
    }
  }
  return {pruneConsumerIds, prunedProducerIds, nextMisses};
}

export interface MergedTile {
  tag:        string;
  audio?:     RemoteTile;
  video?:     RemoteTile;
  audioLevel: number;
}

export interface SelfTile {
  tag:    string;
  isSelf: true;
}

export type PageItem =
  | {kind: 'remote'; tile: MergedTile}
  | {kind: 'self';   tile: SelfTile};

export interface HeroHoldState {
  tag:   string;
  until: number;
}

export interface HeroHoldOptions {
  /** ms a pinned tile stays as hero before natural sort can reclaim it. */
  holdMs:    number;
  /** audioLevel above which we treat someone as "actually speaking". */
  threshold: number;
  /** Date.now() at decision time. Passed in so tests are deterministic. */
  now:       number;
}

/**
 * Collapse RemoteTile audio+video pairs sharing a participantTag into a
 * single MergedTile, attach the latest audioLevel, sort by audioLevel desc.
 *
 * Sort is unstable for tied audioLevels (matches Array.prototype.sort).
 * That's fine — the hero-hold layer pins the visible top tile, so ties
 * downstream can't cause hero RTCView remounts.
 */
export function mergeAndSortTiles(
  remoteTiles: ReadonlyArray<RemoteTile>,
  audioLevels: Readonly<Record<string, number>>,
): MergedTile[] {
  const m = new Map<string, MergedTile>();
  for (const t of remoteTiles) {
    const e = m.get(t.participantTag) ?? {tag: t.participantTag, audioLevel: 0};
    if (t.kind === 'audio') {e.audio = t;} else {e.video = t;}
    e.audioLevel = audioLevels[t.participantTag] ?? 0;
    m.set(t.participantTag, e);
  }
  const arr = Array.from(m.values());
  arr.sort((a, b) => b.audioLevel - a.audioLevel);
  return arr;
}

/**
 * Apply hero-hold + silence-pin rules to a sort-by-loudness result.
 *
 * Four branches (matching the pre-extraction logic):
 *   1. Pin live AND natural !== pinned → splice pinned to index 0.
 *      `nextHold === prev` (no ref write).
 *   2. Pin expired AND someone is speaking (audioLevel >= threshold)
 *      AND we have a natural hero → re-pin to natural.
 *      `nextHold = {tag: natural, until: now + holdMs}`.
 *   3. Pin expired AND silence AND we had a previous pin → splice
 *      previous pin to index 0 (don't extend the timer).
 *      `nextHold === prev` (no ref write).
 *   4. Never pinned AND we have a natural hero → first-ever pin.
 *      `nextHold = {tag: natural, until: now + holdMs}`.
 *
 * The input `arr` is NOT mutated. The returned array is always a fresh
 * shallow copy when reordering occurs; otherwise it's a copy too (always
 * fresh — keeps the contract simple, the screen's debounce cache layer
 * is what stabilises identity over time).
 */
export function applyHeroHold(
  arr:  ReadonlyArray<MergedTile>,
  prev: HeroHoldState | null,
  opts: HeroHoldOptions,
): {arr: MergedTile[]; nextHold: HeroHoldState | null} {
  const out = arr.slice();
  const naturalHero = out[0]?.tag;
  const naturalHeroLevel = out[0]?.audioLevel ?? 0;
  const pinIsLive = prev !== null && prev.until > opts.now;
  const someoneIsSpeaking = naturalHeroLevel >= opts.threshold;

  if (pinIsLive && prev !== null && naturalHero !== undefined && prev.tag !== naturalHero) {
    // Branch 1 — pin still in-window, splice pinned to top.
    const idx = out.findIndex(t => t.tag === prev.tag);
    if (idx > 0) {
      const [held] = out.splice(idx, 1);
      out.unshift(held);
    }
    return {arr: out, nextHold: prev};
  }
  if (!pinIsLive && someoneIsSpeaking && naturalHero !== undefined) {
    // Branch 2 — pin expired AND speaker exists → re-pin.
    return {arr: out, nextHold: {tag: naturalHero, until: opts.now + opts.holdMs}};
  }
  if (!pinIsLive && !someoneIsSpeaking && prev !== null && naturalHero !== undefined) {
    // Branch 3 — silence + had pin, keep last hero on top, don't extend.
    const idx = out.findIndex(t => t.tag === prev.tag);
    if (idx > 0) {
      const [held] = out.splice(idx, 1);
      out.unshift(held);
    }
    return {arr: out, nextHold: prev};
  }
  if (prev === null && naturalHero !== undefined) {
    // Branch 4 — first-ever pin.
    return {arr: out, nextHold: {tag: naturalHero, until: opts.now + opts.holdMs}};
  }
  // No participants OR pin-live AND naturalHero === pinned.tag (already
  // on top) → leave order alone, don't touch the ref.
  return {arr: out, nextHold: prev};
}

/**
 * Slice a hero-held merged list into render-ready pages.
 *
 *   pages[0] = up to 2 "small" PageItems (siblings of the hero).
 *   pages[1..] = chunks of 3 PageItems each.
 *
 * Self is always appended last to the others list, so on a 1-participant
 * call (just you) `hero === null` and `pages = [[{kind:'self'}]]`.
 *
 * On a 2-participant call hero = remotes[0] and pages = [[{kind:'self'}]].
 */
export function paginateOthers(
  merged:   ReadonlyArray<MergedTile>,
  selfTile: SelfTile,
): {
  hero:   MergedTile | null;
  others: PageItem[];
  pages:  PageItem[][];
} {
  const hero = merged[0] ?? null;
  const others: PageItem[] = [
    ...merged.slice(1).map<PageItem>(t => ({kind: 'remote', tile: t})),
    {kind: 'self', tile: selfTile},
  ];
  const pages: PageItem[][] = [];
  if (others.length <= 2) {
    pages.push(others);
  } else {
    pages.push(others.slice(0, 2));
    for (let i = 2; i < others.length; i += 3) {
      pages.push(others.slice(i, i + 3));
    }
  }
  return {hero, others, pages};
}

// ─── B-17 single-source render list ────────────────────────────────
//
// The tiles layer must iterate a list derived from `layout` on the
// SAME render tick that positions are resolved from `layout`. The old
// code iterated a retention Map mutated in a useEffect (one tick
// behind), so any frame where the two disagreed — e.g. the self tag
// flipping from placeholder to real after sfu.join — produced a slot
// with a position but no rendered tile (blank cell, bug B-17).

/** Snapshot of a retained-for-RTCView-survival remote tile. */
export interface RetainedRemoteLike {
  kind: 'remote';
  tile: MergedTile;
}

/**
 * Build the definitive render list for the tiles layer.
 *
 *   1. Every tag in `layout` (hero + all pages) renders LIVE layout
 *      data — present the same tick the layout changes.
 *   2. Retained tags NOT in `layout` are appended afterwards; they
 *      render hidden (the position resolver gives them visible:false)
 *      purely so a transient absence doesn't tear down the RTCView.
 *
 * Each tag appears at most once; layout always wins over retention.
 */
export function buildRenderEntries(
  layout:   {hero: MergedTile | null; pages: PageItem[][]},
  retained: ReadonlyMap<string, RetainedRemoteLike>,
): PageItem[] {
  const seen = new Set<string>();
  const out: PageItem[] = [];
  if (layout.hero) {
    out.push({kind: 'remote', tile: layout.hero});
    seen.add(layout.hero.tag);
  }
  for (const page of layout.pages) {
    for (const item of page) {
      if (!seen.has(item.tile.tag)) {
        out.push(item);
        seen.add(item.tile.tag);
      }
    }
  }
  for (const [tag, entry] of retained) {
    if (!seen.has(tag)) {
      out.push({kind: 'remote', tile: entry.tile});
      seen.add(tag);
    }
  }
  return out;
}

// ─── B-17 tile-opacity transition (pure decision) ──────────────────
//
// The screen drives each tile's Animated opacity from this verdict.
// Extracted because the old inline branching had a one-way latch:
// hidden → setValue(0), but visible-again-with-unchanged-role matched
// no branch, so a tile that was ever hidden while keeping its role
// (self landing in a not-yet-measured slot) stayed invisible all call.

export interface TileVisState {
  role:    TilePosition['role'];
  visible: boolean;
}

export type TileOpacityAction = 'hide' | 'fadeInHero' | 'show' | 'keep';

export function resolveTileOpacityAction(
  prev: TileVisState | undefined,
  next: TileVisState,
): TileOpacityAction {
  if (!next.visible) {return 'hide';}
  if (next.role === 'hero' && prev?.role !== 'hero') {return 'fadeInHero';}
  // Brand-new tile OR returning from hidden → appear instantly.
  if (!prev?.visible) {return 'show';}
  // Visible→visible with no hero promotion (incl. small↔grid swaps):
  // leave the animated value alone.
  return 'keep';
}

// ─── Tile-position resolver (Fix #13 unified-grid restructure) ─────
//
// Maps each visible tile (by tag) to an absolute (x, y, w, h) rect on
// the page-stack canvas. The screen renders ONE persistent <View
// key={tag}> per tile, positioned via this output. Role swaps are now
// CSS-only — the underlying RTCView never unmounts.
//
// This helper is pure: the screen measures slot rects via onLayout
// (slot skeleton flexbox does that) and passes the measurements in.
// Cross-page tiles get x-shifted by `pageW * tilePage` so they're
// mounted but off-screen until their page scrolls into view.

/** Outer rect of a flexbox slot, measured by onLayout. */
export interface SlotRect {
  x:      number;
  y:      number;
  width:  number;
  height: number;
}

/** All slot rects measured by the slot-skeleton layer. */
export interface SlotRects {
  /** Hero slot on page 1. Null until first measurement. */
  hero:    SlotRect | null;
  /** Page-1 small row slots [left, right]. Each null until measured. */
  small1:  SlotRect | null;
  small2:  SlotRect | null;
  /** Page-2+ equal-3 grid slots, indexed by [pageOffset][slot]. */
  grid:    Array<[SlotRect | null, SlotRect | null, SlotRect | null]>;
}

/**
 * Resolved on-canvas position for one tile.
 *   role:   which slot kind the tile currently lives in
 *   x/y:    absolute coords within the page-stack (not within a page)
 *   w/h:    explicit rect — the tile wrapper pins BOTH (BS-GC-BLACKVIDEO)
 *   page:   which logical page this tile belongs to (for translateX swiping)
 *   visible: false when slot rect not yet measured AND no fallback is safe
 */
export interface TilePosition {
  role:    'hero' | 'small' | 'grid';
  x:       number;
  y:       number;
  width:   number;
  height:  number;
  page:    number;
  visible: boolean;
}

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

// ─── B-242 — swipe-pager settle decision (pure) ────────────────────
//
// The group-call tile pager is a PanResponder that translates the whole
// page stack by `swipeX`. On gesture end it decides which page to land on.
// Two bugs this pins:
//   • the founder's "sliding not working" + tiles jammed as slivers at the
//     far LEFT: the old handler only decided on onPanResponderRelease, and a
//     TERMINATED gesture (a child touchable stealing it, an OS cancel, a
//     re-render churn mid-drag) never ran it — so swipeX stayed frozen at its
//     last drag offset and the stack sat shoved left forever. The fix runs
//     THIS decision from BOTH release and terminate, so swipeX always resets.
//   • a normal short flick never crossed the distance-only threshold
//     (pageW*0.18 ≈ 190px), so the page silently sprang back — reads as
//     "sliding not working". A velocity (fling) term fixes that.
//
// Pure + deterministic so the pager decision is unit-testable (the screen
// pulls react-native and cannot run under the node project).

/** Distance a drag must cover (fraction of page width) to change page. */
export const SWIPE_DISTANCE_FRACTION = 0.18;
/** Fling velocity (px/ms) above which a short drag still changes page. */
export const SWIPE_FLING_VELOCITY = 0.3;

export interface SwipeSettleInput {
  /** Total horizontal drag in px (negative = dragged left = wants NEXT). */
  dx:         number;
  /** Release velocity in px/ms (negative = flung left). */
  vx:         number;
  /** Current page width in px (from resolveGroupCallPageWidth). */
  pageW:      number;
  /** Page we started the gesture on. */
  pageIndex:  number;
  /** Number of pages available. */
  totalPages: number;
}

/**
 * Decide the page to settle on after a swipe gesture ends. Advances one page
 * on either enough DISTANCE or a fast enough FLING, clamped to [0,
 * totalPages-1]. A gesture whose distance and velocity disagree (a reversed
 * flick) springs back to the current page. Never returns an out-of-range page.
 */
export function resolveSwipeSettle(input: SwipeSettleInput): number {
  const {dx, vx, pageW, pageIndex, totalPages} = input;
  const last = Math.max(0, totalPages - 1);
  const clamp = (p: number): number => Math.max(0, Math.min(p, last));
  if (pageW <= 0) {return clamp(pageIndex);}
  const distThreshold = pageW * SWIPE_DISTANCE_FRACTION;
  const wantNext = dx < -distThreshold || vx < -SWIPE_FLING_VELOCITY;
  const wantPrev = dx > distThreshold  || vx > SWIPE_FLING_VELOCITY;
  // Conflicting signals (distance one way, fling the other) → spring back.
  if (wantNext && !wantPrev && pageIndex < last) {return clamp(pageIndex + 1);}
  if (wantPrev && !wantNext && pageIndex > 0)    {return clamp(pageIndex - 1);}
  return clamp(pageIndex);
}

export function resolveGridSlotWidth(pageW: number, gap: number = GROUP_CALL_PAGE_GAP): number {
  // B-19 — 3 slots + 2 gaps must fit EXACTLY; floor so a sub-pixel
  // overflow can't re-trigger the flexWrap 2-over-1 collapse.
  const w = Math.floor((pageW - gap * 2) / 3);
  return w > 0 ? w : 0;
}

/**
 * Build the position map for every tile that should currently be on
 * screen (or mounted off-screen on a hidden page).
 *
 * Inputs:
 *   layout    — output of `paginateOthers`. Tells us which tag is in
 *                which slot on which page.
 *   slotRects — measured rects. Hero+small1+small2 are page 1; `grid`
 *                array entry [i] is for logical page (i + 1) (because
 *                grid pages start at page 2).
 *   pageW     — pixel width of one page (for off-screen offset).
 *
 * Output:
 *   positionsByTag — every tile that exists in `layout` gets a
 *                    TilePosition. Tags that have no measured slot
 *                    yet get visible=false (screen renders them with
 *                    opacity 0 — better than removing them, because
 *                    removing would be a remount).
 */
export function resolveTilePositions(
  layout:    {hero: MergedTile | null; pages: PageItem[][]},
  slotRects: SlotRects,
  pageW:     number,
): Record<string, TilePosition> {
  const out: Record<string, TilePosition> = {};

  // BS-GC-0x0 — fallback footprint for an as-yet-unmeasured slot. Field
  // logcat (TECNO + Pixel) showed live tiles whose slot onLayout had not
  // delivered a non-zero rect: they ended up width:0 → RTCView 0x0 →
  // `BLASTBufferQueue rejecting buffer:active_size=0x0` for the whole
  // call, so the decoded frames were dropped and the tile stayed blank.
  // Giving the fallback a REAL width (derived from pageW) means a tile
  // renders at a sane size immediately and snaps to the exact measured
  // rect the instant onLayout fires — instead of being a dead 0x0 surface
  // forever if measurement is delayed/missed. BS-GC-BLACKVIDEO: the fallback
  // now also carries a real HEIGHT (below) — shipping height:0 collapsed the
  // tile to FlexibleVideoTile's 1px floor, so the surface was created at a
  // ~4x2 placeholder and BLAST rejected the first keyframe. The wrapper pins
  // the surface to this height, so it must be non-zero in the fallback too.
  const small1Fallback = Math.floor((pageW - 8) / 2); // two small tiles + 8px gap
  const gridFallback   = Math.floor((pageW - 16) / 3); // three grid tiles + gaps
  // BS-GC-BLACKVIDEO — fallback HEIGHTS for the unmeasured window. Shipping
  // height:0 (old behaviour) let the tile collapse to FlexibleVideoTile's
  // 1px minHeight floor, so the RTCView SurfaceView was created at a ~4x2
  // placeholder and BLASTBufferQueue rejected the decoder's first keyframe →
  // black tile. Giving a REAL height derived from each slot's intended aspect
  // (hero block ≈16/11, small + grid slots aspectRatio 9/12 = 0.75) means the
  // surface is sane-sized from the first frame and snaps to the exact measured
  // rect the instant onLayout fires (a single benign resize the native
  // renderer self-heals). Matches the real slot ratios to minimise even that.
  const heroFallbackH  = Math.floor(pageW / (16 / 11));
  const smallFallbackH = Math.floor(small1Fallback / 0.75);
  const gridFallbackH  = Math.floor(gridFallback / 0.75);

  // Hero — page 0.
  if (layout.hero) {
    const r = slotRects.hero;
    out[layout.hero.tag] = r
      ? {role: 'hero', x: r.x, y: r.y, width: r.width, height: r.height, page: 0, visible: true}
      : {role: 'hero', x: 0,   y: 0,   width: pageW,    height: heroFallbackH, page: 0, visible: false};
  }

  // Page 0 — two small slots beneath hero (positions 0 and 1 of pages[0]).
  const page0 = layout.pages[0] ?? [];
  const smallRects = [slotRects.small1, slotRects.small2];
  for (let i = 0; i < Math.min(page0.length, 2); i++) {
    const item = page0[i];
    // Both PageItem arms (remote MergedTile / self SelfTile) expose `tag`.
    const tag = item.tile.tag;
    const r = smallRects[i];
    out[tag] = r
      ? {role: 'small', x: r.x, y: r.y, width: r.width, height: r.height, page: 0, visible: true}
      // Fallback: real width so the RTCView surface is never 0x0; x offset
      // by the slot index so the two small tiles don't stack at x=0.
      : {role: 'small', x: i * (small1Fallback + 8), y: 0, width: small1Fallback, height: smallFallbackH, page: 0, visible: false};
  }

  // Pages 1.. — equal-3 grid slots. Note layout.pages[0] is page-0
  // (hero + small row); pages[1..] are the grid pages, mapping to
  // slotRects.grid[0..].
  for (let p = 1; p < layout.pages.length; p++) {
    const items = layout.pages[p];
    const rectsForPage = slotRects.grid[p - 1] ?? [null, null, null];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // Both PageItem arms expose `tag` — see page-0 loop above.
      const tag = item.tile.tag;
      const r = rectsForPage[i] ?? null;
      out[tag] = r
        // x is shifted by p pages so the tile lives on the correct page
        // of the translateX'd stack. Slot rects are measured WITHIN
        // their page wrapper, so they already start at x≈0 inside the
        // page; we add `p * pageW` to push them onto page p.
        ? {role: 'grid', x: r.x + p * pageW, y: r.y, width: r.width, height: r.height, page: p, visible: true}
        // Fallback: real width + per-index x so an unmeasured grid tile
        // still gets a non-zero RTCView surface instead of a dead 0x0 box.
        : {role: 'grid', x: p * pageW + i * (gridFallback + 8), y: 0, width: gridFallback, height: gridFallbackH, page: p, visible: false};
    }
  }

  return out;
}

// ─── G-A / G-B (VIDEO_CALL_RENDER_ISSUES_HANDOFF §3) — merged-tile
// reference cache, extracted from GroupCallScreen so it is unit-testable.
//
// The cache's ONLY job is reference stability: return the previous array
// object when nothing the renderer reads has changed, so downstream
// useMemos/RTCViews don't churn on every 250ms audio-level tick. Two bugs
// lived in the inline version:
//   G-A — the signature covered tag order + track PRESENCE only, so a
//         `paused` flip (camera toggle rides producer-pause since GC-01)
//         or a rebuilt consumer produced an identical sig and the stale
//         tile objects were returned forever (2-party order never changes).
//   G-B — the loudest-speaker debounce returned the old array without
//         scheduling any recompute; in a silent call (audioLevels only
//         tick on a >0.04 delta) a joiner's video tile that landed inside
//         the window was swallowed until some unrelated state change.

export interface MergedCacheState {
  arr:          MergedTile[];
  sig:          string;
  loudestTag:   string | null;
  lastUpdateMs: number;
}

export interface MergedCacheDecision {
  arr:       MergedTile[];
  nextCache: MergedCacheState;
  /**
   * Non-null when a CHANGED array was withheld for order stability
   * (loudest-speaker debounce). The caller MUST schedule a recompute at
   * this epoch-ms deadline — a silent call may never produce another
   * state tick on its own (G-B).
   */
  recomputeAtMs: number | null;
}

/**
 * G-A — the signature must cover every tile field the renderer READS,
 * not just structural presence. `paused` drives the avatar↔video swap;
 * `consumerId` changes when a consumer is rebuilt (new track needs a
 * fresh RTCView binding). Any omission here is a data change silently
 * swallowed by the sig-match short-circuit.
 *
 * Split in two so the debounce can distinguish WHAT changed:
 *   order sig — tag sequence only (what the debounce exists to smooth);
 *   data sig  — per-tag content, ORDER-INDEPENDENT (sorted), so a real
 *               data change is never mistaken for sortable churn.
 */
export function mergedTileSignature(arr: MergedTile[]): string {
  return `${mergedOrderSignature(arr)}#${mergedDataSignature(arr)}`;
}

export function mergedOrderSignature(arr: MergedTile[]): string {
  return arr.map(t => t.tag).join('|');
}

export function mergedDataSignature(arr: MergedTile[]): string {
  return arr
    .map(t =>
      `${t.tag}:${t.audio ? 1 : 0}${t.video ? 1 : 0}` +
      `:${t.audio?.paused ? 1 : 0}${t.video?.paused ? 1 : 0}` +
      `:${t.audio?.consumerId ?? ''}.${t.video?.consumerId ?? ''}`,
    )
    .sort()
    .join('|');
}

export function resolveMergedCache(
  cache:      MergedCacheState | null,
  arr:        MergedTile[],
  now:        number,
  debounceMs: number,
): MergedCacheDecision {
  const sig = mergedTileSignature(arr);
  const loudestTag = arr[0]?.tag ?? null;
  if (cache) {
    if (cache.sig === sig) {
      // Identical order AND data — keep the reference; nothing to schedule.
      return {arr: cache.arr, nextCache: cache, recomputeAtMs: null};
    }
    // G-A — a DATA change (camera-pause flip, rebuilt consumer, a tag's
    // track appearing/disappearing) must surface IMMEDIATELY: the
    // debounce exists to smooth loudest-speaker re-ORDERING, never to
    // suppress what a tile shows. Compare the order-independent halves.
    const cacheDataSig = cache.sig.split('#')[1] ?? '';
    const dataSig      = sig.split('#')[1] ?? '';
    const dataChanged  = cacheDataSig !== dataSig;
    const sameLoudest    = cache.loudestTag === loudestTag;
    const withinDebounce = (now - cache.lastUpdateMs) < debounceMs;
    if (!dataChanged && sameLoudest && withinDebounce) {
      // Pure order churn while the audible anchor is unchanged — hold the
      // previous reference for RTCView identity, but hand the caller a
      // deadline so the withheld ordering is re-emitted at debounce
      // expiry even if no further tick ever arrives (G-B).
      return {arr: cache.arr, nextCache: cache, recomputeAtMs: cache.lastUpdateMs + debounceMs};
    }
  }
  const nextCache: MergedCacheState = {arr, sig, loudestTag, lastUpdateMs: now};
  return {arr, nextCache, recomputeAtMs: null};
}
