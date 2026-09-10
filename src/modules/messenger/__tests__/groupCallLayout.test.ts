/**
 * Unit tests for groupCallLayout — the three pure helpers that own the
 * GroupCallScreen grid math (extracted from inline useMemo blocks).
 *
 * Goal: exercise every branch of the pre-extraction code so a regression
 * during the eventual unified-grid restructure is caught on `npm test`
 * before it reaches a real call.
 */
import {
  mergeAndSortTiles,
  applyHeroHold,
  paginateOthers,
  resolveTilePositions,
  buildRenderEntries,
  resolveTileOpacityAction,
  resolveOffscreenVideoTags,
  resolveGroupCallPageWidth,
  resolveGridSlotWidth,
  GROUP_CALL_PAGE_GAP,
  type MergedTile,
  type SelfTile,
  type HeroHoldOptions,
  type SlotRect,
  type SlotRects,
  type RetainedRemoteLike,
  type TileVisState,
} from '../webrtc/groupCallLayout';
import type {RemoteTile} from '../webrtc/useGroupCall';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

// MediaStream is only used as a type on RemoteTile.stream — at runtime
// the helpers never read it, so we double-cast a stub through unknown
// to avoid pulling react-native-webrtc into the node test environment.
function rTile(tag: string, kind: 'audio' | 'video', extra: Partial<RemoteTile> = {}): RemoteTile {
  return {
    participantTag: tag,
    consumerId:     `c-${tag}-${kind}`,
    producerId:     `p-${tag}-${kind}`,
    kind,
    stream:         {} as unknown as RemoteTile['stream'],
    ...extra,
  };
}

const BASE_HOLD_OPTS: HeroHoldOptions = {holdMs: 3000, threshold: 0.15, now: 1_000_000};

describe('mergeAndSortTiles', () => {
  it('returns empty array for empty inputs', () => {
    expect(mergeAndSortTiles([], {})).toEqual([]);
  });

  it('collapses (audio, video) pairs sharing a participantTag', () => {
    const out = mergeAndSortTiles(
      [rTile('alice', 'audio'), rTile('alice', 'video')],
      {alice: 0.4},
    );
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe('alice');
    expect(out[0].audio).toBeDefined();
    expect(out[0].video).toBeDefined();
    expect(out[0].audioLevel).toBe(0.4);
  });

  it('attaches the latest audioLevel even when only one kind is present', () => {
    const out = mergeAndSortTiles([rTile('bob', 'audio')], {bob: 0.7});
    expect(out[0].audioLevel).toBe(0.7);
    expect(out[0].audio).toBeDefined();
    expect(out[0].video).toBeUndefined();
  });

  it('defaults audioLevel to 0 when the level map has no entry for the tag', () => {
    const out = mergeAndSortTiles([rTile('carol', 'video')], {});
    expect(out[0].audioLevel).toBe(0);
  });

  it('sorts tiles by audioLevel descending', () => {
    const out = mergeAndSortTiles(
      [rTile('quiet', 'audio'), rTile('loud', 'audio'), rTile('mid', 'audio')],
      {quiet: 0.05, loud: 0.9, mid: 0.4},
    );
    expect(out.map(t => t.tag)).toEqual(['loud', 'mid', 'quiet']);
  });

  it('does not mutate the input remoteTiles array', () => {
    const tiles = [rTile('a', 'audio'), rTile('b', 'audio')];
    const snapshot = tiles.slice();
    mergeAndSortTiles(tiles, {a: 0.1, b: 0.9});
    expect(tiles).toEqual(snapshot);
  });

  it('handles audioLevels for tags that are not present in remoteTiles', () => {
    const out = mergeAndSortTiles(
      [rTile('a', 'audio')],
      {a: 0.3, ghost: 0.99},
    );
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe('a');
  });
});

describe('applyHeroHold', () => {
  // Helper to spin a MergedTile array directly (skipping the merge step
  // so each test can pin exact audioLevels and order).
  function mt(tag: string, audioLevel: number, withVideo = false): MergedTile {
    const t: MergedTile = {tag, audioLevel};
    if (withVideo) { t.video = rTile(tag, 'video'); }
    return t;
  }

  it('Branch 4 — first-ever pin writes the hold and leaves order untouched', () => {
    const arr = [mt('alice', 0.6), mt('bob', 0.2)];
    const r = applyHeroHold(arr, null, BASE_HOLD_OPTS);
    expect(r.arr.map(t => t.tag)).toEqual(['alice', 'bob']);
    expect(r.nextHold).toEqual({tag: 'alice', until: 1_000_000 + 3000});
  });

  it('Branch 4 — empty array yields no hold change', () => {
    const r = applyHeroHold([], null, BASE_HOLD_OPTS);
    expect(r.arr).toEqual([]);
    expect(r.nextHold).toBeNull();
  });

  it('Branch 1 — pin live AND natural !== pinned splices pinned to top, returns same prev ref', () => {
    const arr = [mt('loud', 0.8), mt('pinned', 0.1), mt('mid', 0.3)];
    const prev = {tag: 'pinned', until: 1_500_000};
    const r = applyHeroHold(arr, prev, BASE_HOLD_OPTS);
    expect(r.arr.map(t => t.tag)).toEqual(['pinned', 'loud', 'mid']);
    expect(r.nextHold).toBe(prev); // referential equality — caller skips ref write
  });

  it('Branch 1 — pin live AND pinned already on top is a no-op (still returns prev ref)', () => {
    const arr = [mt('pinned', 0.1), mt('loud', 0.8)];
    const prev = {tag: 'pinned', until: 1_500_000};
    const r = applyHeroHold(arr, prev, BASE_HOLD_OPTS);
    expect(r.arr.map(t => t.tag)).toEqual(['pinned', 'loud']);
    expect(r.nextHold).toBe(prev);
  });

  it('Branch 2 — pin expired AND someone speaking re-pins to natural hero', () => {
    const arr = [mt('newSpeaker', 0.9), mt('quiet', 0.0)];
    const prev = {tag: 'oldHero', until: 999_999}; // expired
    const r = applyHeroHold(arr, prev, BASE_HOLD_OPTS);
    expect(r.arr.map(t => t.tag)).toEqual(['newSpeaker', 'quiet']);
    expect(r.nextHold).toEqual({tag: 'newSpeaker', until: 1_000_000 + 3000});
  });

  it('Branch 2 — speaking threshold is inclusive (level === threshold counts as speaking)', () => {
    const arr = [mt('borderline', 0.15)];
    const r = applyHeroHold(arr, null, BASE_HOLD_OPTS);
    expect(r.nextHold).toEqual({tag: 'borderline', until: 1_000_000 + 3000});
  });

  it('Branch 3 — pin expired AND silence keeps previous pin on top, no ref write', () => {
    const arr = [mt('quietA', 0.05), mt('oldHero', 0.0), mt('quietB', 0.02)];
    const prev = {tag: 'oldHero', until: 999_999}; // expired
    const r = applyHeroHold(arr, prev, BASE_HOLD_OPTS);
    expect(r.arr.map(t => t.tag)).toEqual(['oldHero', 'quietA', 'quietB']);
    expect(r.nextHold).toBe(prev);
  });

  it('Branch 3 — silence-pinned tile no longer in the array → order unchanged, ref preserved', () => {
    // Edge case: hero left the call mid-silence-window. The findIndex
    // returns -1, the splice is skipped. Don't pretend the leaver is
    // still there; just leave the natural sort alone.
    const arr = [mt('still', 0.0), mt('here', 0.0)];
    const prev = {tag: 'leftAlready', until: 999_999};
    const r = applyHeroHold(arr, prev, BASE_HOLD_OPTS);
    expect(r.arr.map(t => t.tag)).toEqual(['still', 'here']);
    expect(r.nextHold).toBe(prev);
  });

  it('does not mutate the input array', () => {
    const arr = [mt('a', 0.9), mt('b', 0.1)];
    const snapshot = arr.slice();
    applyHeroHold(arr, {tag: 'b', until: 1_500_000}, BASE_HOLD_OPTS);
    expect(arr).toEqual(snapshot);
    // And specifically the tile objects themselves shouldn't be replaced.
    expect(arr[0]).toBe(snapshot[0]);
    expect(arr[1]).toBe(snapshot[1]);
  });

  it('returned array is always a fresh shallow copy (caller can mutate without affecting input)', () => {
    const arr = [mt('a', 0.9), mt('b', 0.1)];
    const r = applyHeroHold(arr, null, BASE_HOLD_OPTS);
    expect(r.arr).not.toBe(arr);
    r.arr.push(mt('c', 0.0));
    expect(arr).toHaveLength(2);
  });

  it('respects custom holdMs and threshold', () => {
    const r = applyHeroHold(
      [mt('mild', 0.12)],
      null,
      {holdMs: 5000, threshold: 0.10, now: 2_000_000},
    );
    expect(r.nextHold).toEqual({tag: 'mild', until: 2_000_000 + 5000});
  });

  it('treats a tile at exactly until=now as expired (strict > comparison)', () => {
    const arr = [mt('newLoud', 0.5), mt('expiring', 0.0)];
    const prev = {tag: 'expiring', until: 1_000_000}; // until === now → expired
    const r = applyHeroHold(arr, prev, BASE_HOLD_OPTS);
    // Pin treated as expired; speaker exists → re-pin to newLoud.
    expect(r.nextHold).toEqual({tag: 'newLoud', until: 1_000_000 + 3000});
  });
});

describe('paginateOthers', () => {
  const SELF: SelfTile = {tag: 'self-tag', isSelf: true};

  function mt(tag: string, audioLevel = 0): MergedTile {
    return {tag, audioLevel};
  }

  it('empty merged → hero is null, single page with just self', () => {
    const r = paginateOthers([], SELF);
    expect(r.hero).toBeNull();
    expect(r.others).toEqual([{kind: 'self', tile: SELF}]);
    expect(r.pages).toEqual([[{kind: 'self', tile: SELF}]]);
  });

  it('1 remote → hero is that tile, one page with just self', () => {
    const merged = [mt('alice')];
    const r = paginateOthers(merged, SELF);
    expect(r.hero).toBe(merged[0]);
    expect(r.others).toEqual([{kind: 'self', tile: SELF}]);
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]).toHaveLength(1);
  });

  it('2 remotes → page 1 is [remote1, self]', () => {
    const merged = [mt('a'), mt('b')];
    const r = paginateOthers(merged, SELF);
    expect(r.hero).toBe(merged[0]);
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]).toEqual([
      {kind: 'remote', tile: merged[1]},
      {kind: 'self',   tile: SELF},
    ]);
  });

  it('3 remotes → page 1 = [r1, r2], page 2 = [self]', () => {
    const merged = [mt('hero'), mt('r1'), mt('r2')];
    const r = paginateOthers(merged, SELF);
    expect(r.hero).toBe(merged[0]);
    expect(r.pages).toHaveLength(2);
    expect(r.pages[0]).toEqual([
      {kind: 'remote', tile: merged[1]},
      {kind: 'remote', tile: merged[2]},
    ]);
    expect(r.pages[1]).toEqual([{kind: 'self', tile: SELF}]);
  });

  it('4 remotes → page 1 = [r1, r2], page 2 = [r3, self]', () => {
    const merged = [mt('hero'), mt('r1'), mt('r2'), mt('r3')];
    const r = paginateOthers(merged, SELF);
    expect(r.pages).toHaveLength(2);
    expect(r.pages[0].map(p => (p.kind === 'remote' ? p.tile.tag : 'self'))).toEqual(['r1', 'r2']);
    expect(r.pages[1].map(p => (p.kind === 'remote' ? p.tile.tag : 'self'))).toEqual(['r3', 'self']);
  });

  it('5 remotes → page 1 = 2 remotes, page 2 = [r3, r4, self]', () => {
    const merged = [mt('h'), mt('r1'), mt('r2'), mt('r3'), mt('r4')];
    const r = paginateOthers(merged, SELF);
    expect(r.pages).toHaveLength(2);
    expect(r.pages[1].map(p => (p.kind === 'remote' ? p.tile.tag : 'self'))).toEqual(['r3', 'r4', 'self']);
  });

  it('6 remotes (chunk boundary: 6 PageItems in others) → 3 pages', () => {
    // Tests the "i += 3" loop boundary: with 6 PageItems in `others`
    // (5 remotes + self), pages[0]=[0..1], pages[1]=[2..4], pages[2]=[5].
    const merged = [mt('h'), mt('r1'), mt('r2'), mt('r3'), mt('r4'), mt('r5')];
    const r = paginateOthers(merged, SELF);
    expect(r.pages).toHaveLength(3);
    expect(r.pages[0].map(p => (p.kind === 'remote' ? p.tile.tag : 'self'))).toEqual(['r1', 'r2']);
    expect(r.pages[1].map(p => (p.kind === 'remote' ? p.tile.tag : 'self'))).toEqual(['r3', 'r4', 'r5']);
    expect(r.pages[2].map(p => (p.kind === 'remote' ? p.tile.tag : 'self'))).toEqual(['self']);
  });

  it('9 remotes (full 10-person call incl self, cap = GROUP_CALL_MAX_PARTICIPANTS) → hero + 4 pages', () => {
    // Cap raised 6 → 10 (2026-07): a full room is self + 9 remotes.
    // hero = r0; others = r1..r8 + self = 9 items →
    // pages[0]=[r1,r2], pages[1]=[r3,r4,r5], pages[2]=[r6,r7,r8], pages[3]=[self].
    const merged = Array.from({length: 9}, (_, i) => mt(`r${i}`));
    const r = paginateOthers(merged, SELF);
    expect(r.hero).toBe(merged[0]);
    expect(r.pages).toHaveLength(4);
    expect(r.pages[0].map(p => (p.kind === 'remote' ? p.tile.tag : 'self'))).toEqual(['r1', 'r2']);
    expect(r.pages[1].map(p => (p.kind === 'remote' ? p.tile.tag : 'self'))).toEqual(['r3', 'r4', 'r5']);
    expect(r.pages[2].map(p => (p.kind === 'remote' ? p.tile.tag : 'self'))).toEqual(['r6', 'r7', 'r8']);
    expect(r.pages[3].map(p => (p.kind === 'remote' ? p.tile.tag : 'self'))).toEqual(['self']);
  });

  it('self always appears last in others, regardless of merged length', () => {
    for (let n = 0; n <= 8; n++) {
      const merged = Array.from({length: n}, (_, i) => mt(`r${i}`));
      const r = paginateOthers(merged, SELF);
      const last = r.others[r.others.length - 1];
      expect(last.kind).toBe('self');
    }
  });

  it('does not mutate the merged input', () => {
    const merged = [mt('a'), mt('b'), mt('c'), mt('d'), mt('e')];
    const snapshot = merged.slice();
    paginateOthers(merged, SELF);
    expect(merged).toEqual(snapshot);
  });

  it('hero === null only when merged is empty', () => {
    expect(paginateOthers([], SELF).hero).toBeNull();
    expect(paginateOthers([mt('x')], SELF).hero).not.toBeNull();
  });
});

describe('integration — full pipeline matches pre-extraction behavior', () => {
  // End-to-end sanity: simulate a 4-participant call (hero + 3 others +
  // self) flowing through merge → hold → paginate, asserting the visible
  // grid layout the user sees.
  it('typical 4-participant call: alice loudest, then bob, then carol, plus self', () => {
    const remoteTiles = [
      // Alice has both tracks; Bob audio-only; Carol video-only.
      rTile('alice', 'audio'), rTile('alice', 'video'),
      rTile('bob',   'audio'),
      rTile('carol', 'video'),
    ];
    const audioLevels = {alice: 0.8, bob: 0.3, carol: 0.0};
    const merged = mergeAndSortTiles(remoteTiles, audioLevels);
    expect(merged.map(t => t.tag)).toEqual(['alice', 'bob', 'carol']);

    const heldOnce = applyHeroHold(merged, null, BASE_HOLD_OPTS);
    expect(heldOnce.arr.map(t => t.tag)).toEqual(['alice', 'bob', 'carol']);
    expect(heldOnce.nextHold).toEqual({tag: 'alice', until: 1_000_000 + 3000});

    const SELF: SelfTile = {tag: 'me', isSelf: true};
    const pag = paginateOthers(heldOnce.arr, SELF);
    expect(pag.hero?.tag).toBe('alice');
    // Page 1: bob + carol (the two small slots)
    expect(pag.pages[0]).toEqual([
      {kind: 'remote', tile: heldOnce.arr[1]},
      {kind: 'remote', tile: heldOnce.arr[2]},
    ]);
    // Page 2: just self
    expect(pag.pages[1]).toEqual([{kind: 'self', tile: SELF}]);
  });

  it('hero stays pinned across a transient louder spike from another peer', () => {
    const merged1 = mergeAndSortTiles(
      [rTile('alice', 'audio'), rTile('bob', 'audio')],
      {alice: 0.6, bob: 0.0},
    );
    const r1 = applyHeroHold(merged1, null, {...BASE_HOLD_OPTS, now: 1_000_000});
    expect(r1.nextHold).toEqual({tag: 'alice', until: 1_003_000});

    // 500ms later, Bob briefly louder (pin still live → 1_000_500 < until).
    const merged2 = mergeAndSortTiles(
      [rTile('alice', 'audio'), rTile('bob', 'audio')],
      {alice: 0.1, bob: 0.7},
    );
    expect(merged2[0].tag).toBe('bob'); // natural sort
    const r2 = applyHeroHold(merged2, r1.nextHold, {...BASE_HOLD_OPTS, now: 1_000_500});
    // Hero-hold pins alice on top despite bob being louder.
    expect(r2.arr.map(t => t.tag)).toEqual(['alice', 'bob']);
    expect(r2.nextHold).toBe(r1.nextHold); // ref preserved
  });

  it('after hold expires, a new sustained speaker takes the hero slot', () => {
    const r1 = applyHeroHold(
      [{tag: 'alice', audioLevel: 0.6}, {tag: 'bob', audioLevel: 0.0}],
      null,
      {...BASE_HOLD_OPTS, now: 1_000_000},
    );
    // 4s later (hold expired), bob is loud now.
    const r2 = applyHeroHold(
      [{tag: 'bob', audioLevel: 0.7}, {tag: 'alice', audioLevel: 0.0}],
      r1.nextHold,
      {...BASE_HOLD_OPTS, now: 1_004_000},
    );
    expect(r2.arr[0].tag).toBe('bob');
    expect(r2.nextHold).toEqual({tag: 'bob', until: 1_004_000 + 3000});
  });
});

describe('resolveTilePositions (Fix #13 unified-grid restructure)', () => {
  const SELF: SelfTile = {tag: 'self', isSelf: true};
  const PAGE_W = 360; // typical phone-portrait page width

  // Convenience: build a fully-measured SlotRects for a 1-page (hero + 2 small) layout.
  function rects1Page(): SlotRects {
    return {
      hero:   {x: 0,   y: 0,   width: 360, height: 320},
      small1: {x: 0,   y: 328, width: 176, height: 130},
      small2: {x: 184, y: 328, width: 176, height: 130},
      grid:   [],
    };
  }
  // Build measured rects for N grid pages.
  function rectsWithGrid(gridPages: number): SlotRects {
    const r = rects1Page();
    for (let p = 0; p < gridPages; p++) {
      r.grid.push([
        {x: 0,   y: 0,   width: 116, height: 155},
        {x: 122, y: 0,   width: 116, height: 155},
        {x: 244, y: 0,   width: 116, height: 155},
      ]);
    }
    return r;
  }

  function mt(tag: string, audioLevel = 0): MergedTile {
    return {tag, audioLevel};
  }

  it('hero alone: single hero tile placed at hero rect, page 0', () => {
    const layout = paginateOthers([mt('alice')], SELF);
    const out = resolveTilePositions(layout, rects1Page(), PAGE_W);
    expect(out.alice).toEqual({
      role: 'hero', x: 0, y: 0, width: 360, height: 320, page: 0, visible: true,
    });
    // self goes to small1
    expect(out.self.role).toBe('small');
    expect(out.self.page).toBe(0);
  });

  it('hero + 2 small (3 participants total): all on page 0, no grid pages used', () => {
    const layout = paginateOthers([mt('alice'), mt('bob')], SELF);
    const out = resolveTilePositions(layout, rects1Page(), PAGE_W);
    expect(out.alice.role).toBe('hero');
    expect(out.bob.role).toBe('small');
    expect(out.bob.page).toBe(0);
    expect(out.self.role).toBe('small');
    // Bob takes small1, self takes small2 (others order: bob, self).
    expect(out.bob.x).toBe(0);
    expect(out.self.x).toBe(184);
  });

  it('4 participants — hero + 2 small + 1 grid → grid tile lives on page 1 with x-shift', () => {
    const layout = paginateOthers([mt('a'), mt('b'), mt('c')], SELF);
    // others = [b, c, self]; pages[0] = [b, c]; pages[1] = [self]
    const out = resolveTilePositions(layout, rectsWithGrid(1), PAGE_W);
    expect(out.a.role).toBe('hero');
    expect(out.b.role).toBe('small');
    expect(out.c.role).toBe('small');
    expect(out.self.role).toBe('grid');
    expect(out.self.page).toBe(1);
    // grid slot 0 has x=0 within its page; resolver shifts by 1*PAGE_W to put it on page 1.
    expect(out.self.x).toBe(0 + 1 * PAGE_W);
    expect(out.self.y).toBe(0);
    expect(out.self.width).toBe(116);
  });

  it('6 participants spanning 3 pages: hero+small on p0, grid×3 on p1, grid×1 on p2', () => {
    // remotes count = 5 → others = [r1..r4, self] (5 entries)
    // pages[0] = [r1, r2]; pages[1] = [r3, r4, r5]; pages[2] = [self]
    const layout = paginateOthers(
      [mt('hero'), mt('r1'), mt('r2'), mt('r3'), mt('r4'), mt('r5')],
      SELF,
    );
    const out = resolveTilePositions(layout, rectsWithGrid(2), PAGE_W);
    expect(out.hero.page).toBe(0);
    expect(out.r1.page).toBe(0);
    expect(out.r2.page).toBe(0);
    expect(out.r3.page).toBe(1);
    expect(out.r4.page).toBe(1);
    expect(out.r5.page).toBe(1);
    expect(out.self.page).toBe(2);
    // Page 1 grid uses grid[0]; page 2 grid uses grid[1].
    expect(out.r3.x).toBe(0 + 1 * PAGE_W);
    expect(out.r4.x).toBe(122 + 1 * PAGE_W);
    expect(out.r5.x).toBe(244 + 1 * PAGE_W);
    expect(out.self.x).toBe(0 + 2 * PAGE_W);
  });

  it('10 participants (cap = GROUP_CALL_MAX_PARTICIPANTS) spanning 4 pages: every tile placed, correct page x-shifts', () => {
    // Full room after the 6 → 10 cap raise: self + 9 remotes.
    // pages[0]=[r1,r2]; pages[1]=[r3,r4,r5]; pages[2]=[r6,r7,r8]; pages[3]=[self]
    const layout = paginateOthers(
      Array.from({length: 9}, (_, i) => mt(`r${i}`)),
      SELF,
    );
    const out = resolveTilePositions(layout, rectsWithGrid(3), PAGE_W);
    expect(Object.keys(out)).toHaveLength(10);
    expect(out.r0.role).toBe('hero');
    expect(out.r1.page).toBe(0);
    expect(out.r2.page).toBe(0);
    expect(out.r3.page).toBe(1);
    expect(out.r5.page).toBe(1);
    expect(out.r6.page).toBe(2);
    expect(out.r8.page).toBe(2);
    expect(out.self.page).toBe(3);
    // Page 2 grid uses grid[1]; page 3 uses grid[2].
    expect(out.r6.x).toBe(0 + 2 * PAGE_W);
    expect(out.r8.x).toBe(244 + 2 * PAGE_W);
    expect(out.self.x).toBe(0 + 3 * PAGE_W);
    // Every tile resolved measured → visible with a real footprint.
    for (const pos of Object.values(out)) {
      expect(pos.visible).toBe(true);
      expect(pos.width).toBeGreaterThan(0);
      expect(pos.height).toBeGreaterThan(0);
    }
  });

  it('resolveOffscreenVideoTags: full 10-person layout — only the visible page\'s tags are kept streaming', () => {
    const layout = paginateOthers(
      Array.from({length: 9}, (_, i) => mt(`r${i}`)),
      SELF,
    );
    const positions = resolveTilePositions(layout, rectsWithGrid(3), PAGE_W);
    // Viewing page 0 (hero + r1 + r2): everything on pages 1-3 is offscreen.
    expect(resolveOffscreenVideoTags(positions, 0).sort())
      .toEqual(['r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'self']);
    // Viewing page 2 (r6, r7, r8): hero + page-0 smalls + pages 1/3 are offscreen.
    expect(resolveOffscreenVideoTags(positions, 2).sort())
      .toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'self']);
    // Empty positions → nothing to hide.
    expect(resolveOffscreenVideoTags({}, 0)).toEqual([]);
  });

  it('unmeasured hero rect → tile rendered with visible=false (screen renders hidden, no remount)', () => {
    const layout = paginateOthers([mt('alice')], SELF);
    const noRects: SlotRects = {hero: null, small1: null, small2: null, grid: []};
    const out = resolveTilePositions(layout, noRects, PAGE_W);
    expect(out.alice.visible).toBe(false);
    expect(out.alice.role).toBe('hero');
    expect(out.self.visible).toBe(false);
  });

  it('partially-measured rects: only some slots known → unmeasured ones invisible, measured ones visible', () => {
    const layout = paginateOthers([mt('alice'), mt('bob')], SELF);
    const partial: SlotRects = {
      hero:   {x: 0, y: 0, width: 360, height: 320},
      small1: null,
      small2: {x: 184, y: 328, width: 176, height: 130},
      grid:   [],
    };
    const out = resolveTilePositions(layout, partial, PAGE_W);
    expect(out.alice.visible).toBe(true);
    expect(out.bob.visible).toBe(false); // small1 not measured
    expect(out.self.visible).toBe(true); // small2 measured
  });

  it('BS-GC-0x0: unmeasured slots get a NON-ZERO fallback width (no 0x0 RTCView surface)', () => {
    // Field logcat (TECNO + Pixel) showed live tiles whose slot onLayout
    // hadn't delivered a rect ending up width:0 → RTCView 0x0 → every
    // decoded frame rejected by BLASTBufferQueue for the whole call. The
    // fallback must now carry a real width so the surface is never 0x0.
    const layout = paginateOthers(
      [mt('hero'), mt('s1'), mt('s2'), mt('g1'), mt('g2'), mt('g3')],
      SELF,
    );
    const noRects: SlotRects = {hero: null, small1: null, small2: null, grid: [[null, null, null]]};
    const out = resolveTilePositions(layout, noRects, PAGE_W);
    // Every resolved tile — measured or not — must have width > 0.
    const zeroWidth = Object.entries(out).filter(([, pos]) => !(pos.width > 0));
    expect(zeroWidth.map(([tag, pos]) => `${tag}:${pos.role}`)).toEqual([]);
    // And the two small fallbacks don't both sit at x=0 (they'd overlap).
    const smalls = Object.values(out).filter(p => p.role === 'small');
    if (smalls.length === 2) {
      expect(smalls[0].x).not.toBe(smalls[1].x);
    }
  });

  it('BS-GC-BLACKVIDEO: unmeasured slots get a NON-ZERO fallback HEIGHT too (no 4x2 placeholder surface)', () => {
    // The width-only fallback (BS-GC-0x0) left height:0, so the tile
    // collapsed to FlexibleVideoTile's 1px floor → SurfaceView created at a
    // ~4x2 placeholder → BLASTBufferQueue rejected the decoder's first
    // keyframe → black tile. The fallback must now ALSO carry a real height
    // so the surface is sane-sized from the first frame in every role.
    const layout = paginateOthers(
      [mt('hero'), mt('s1'), mt('s2'), mt('g1'), mt('g2'), mt('g3')],
      SELF,
    );
    const noRects: SlotRects = {hero: null, small1: null, small2: null, grid: [[null, null, null]]};
    const out = resolveTilePositions(layout, noRects, PAGE_W);
    const zeroHeight = Object.entries(out).filter(([, pos]) => !(pos.height > 0));
    expect(zeroHeight.map(([tag, pos]) => `${tag}:${pos.role}`)).toEqual([]);
  });

  it('BS-GC-BLACKVIDEO: MEASURED slot height propagates to every role (hero/small/grid)', () => {
    // The wrapper now pins the surface to pos.height; the resolver must
    // carry the measured r.height through for small + grid tiles, not just
    // hero (previously only the hero case asserted height).
    const layout = paginateOthers(
      [mt('hero'), mt('s1'), mt('s2'), mt('g1'), mt('g2'), mt('g3')],
      SELF,
    );
    const rects: SlotRects = {
      hero:   {x: 0, y: 0, width: 360, height: 320},
      small1: {x: 0, y: 328, width: 176, height: 130},
      small2: {x: 184, y: 328, width: 176, height: 130},
      grid:   [[{x: 0, y: 0, width: 116, height: 155}, {x: 122, y: 0, width: 116, height: 155}, {x: 244, y: 0, width: 116, height: 155}]],
    };
    const out = resolveTilePositions(layout, rects, PAGE_W);
    expect(out.hero.height).toBe(320);
    expect(out.s1.height).toBe(130);
    expect(out.s2.height).toBe(130);
    expect(out.g1.height).toBe(155);
  });

  it('grid pages with unmeasured slots: each slot independently visible/invisible', () => {
    const layout = paginateOthers(
      [mt('hero'), mt('r1'), mt('r2'), mt('r3'), mt('r4')],
      SELF,
    );
    const partial: SlotRects = {
      hero:   {x: 0, y: 0, width: 360, height: 320},
      small1: {x: 0, y: 328, width: 176, height: 130},
      small2: {x: 184, y: 328, width: 176, height: 130},
      grid:   [
        // page 1 = grid[0]: r3, r4, self → only middle slot measured
        [null, {x: 122, y: 0, width: 116, height: 155}, null],
      ],
    };
    const out = resolveTilePositions(layout, partial, PAGE_W);
    expect(out.r3.visible).toBe(false);
    expect(out.r4.visible).toBe(true);
    expect(out.self.visible).toBe(false);
    // The measured one still gets its x-shift to the right page.
    expect(out.r4.x).toBe(122 + 1 * PAGE_W);
  });

  it('empty layout (call just initialised): output is empty record', () => {
    const layout = paginateOthers([], SELF);
    // paginateOthers always emits the self tile, so this isn't truly empty —
    // expect just the self entry, on page 0 in the small slot.
    const out = resolveTilePositions(layout, rects1Page(), PAGE_W);
    expect(Object.keys(out)).toEqual(['self']);
    expect(out.self.role).toBe('small');
    expect(out.self.page).toBe(0);
  });

  it('does not include tags absent from layout', () => {
    // Important: the screen retains a "all tags ever seen" set to keep
    // RTCViews mounted across transient absences. The resolver doesn't
    // know about the retention set — it only positions tags that are
    // currently in the layout. The screen must hide retained-but-absent
    // tags itself.
    const layout = paginateOthers([mt('alice')], SELF);
    const out = resolveTilePositions(layout, rects1Page(), PAGE_W);
    expect(out.ghost).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual(['alice', 'self']);
  });

  it('hero tag uses the same rect identity even when other slots reposition', () => {
    // Property test: alice.x/y match slotRects.hero.x/y exactly.
    const r: SlotRect = {x: 11, y: 17, width: 333, height: 222};
    const layout = paginateOthers([mt('alice'), mt('bob')], SELF);
    const out = resolveTilePositions(
      layout,
      {hero: r, small1: null, small2: null, grid: []},
      PAGE_W,
    );
    expect(out.alice.x).toBe(11);
    expect(out.alice.y).toBe(17);
    expect(out.alice.width).toBe(333);
    expect(out.alice.height).toBe(222);
  });

  it('integration: role swap (alice hero → bob hero) only changes positions, both tags persist', () => {
    // First render: alice hero, bob small.
    const layoutA = paginateOthers([mt('alice', 0.8), mt('bob', 0.1)], SELF);
    const outA = resolveTilePositions(layoutA, rects1Page(), PAGE_W);
    expect(outA.alice.role).toBe('hero');
    expect(outA.bob.role).toBe('small');

    // Hero-hold expired and bob now loudest. Roles swap.
    const layoutB = paginateOthers([mt('bob', 0.9), mt('alice', 0.1)], SELF);
    const outB = resolveTilePositions(layoutB, rects1Page(), PAGE_W);
    expect(outB.bob.role).toBe('hero');
    expect(outB.alice.role).toBe('small');

    // Same tags appear in both outputs (the screen keeps them mounted).
    expect(Object.keys(outA).sort()).toEqual(Object.keys(outB).sort());
  });
});

describe('buildRenderEntries (B-17 single-source render list)', () => {
  const SELF: SelfTile = {tag: 'self', isSelf: true};

  function mt(tag: string, audioLevel = 0): MergedTile {
    return {tag, audioLevel};
  }

  function retainedOf(...tiles: MergedTile[]): Map<string, RetainedRemoteLike> {
    const m = new Map<string, RetainedRemoteLike>();
    for (const t of tiles) { m.set(t.tag, {kind: 'remote', tile: t}); }
    return m;
  }

  it('B-17 regression: layout tags render even when retention is empty (same-tick)', () => {
    // The exact frame that produced the blank self cell: layout already
    // has the tiles, but the retention effect (one tick behind) hasn't
    // populated the map yet. Every layout tag must still be emitted.
    const layout = paginateOthers([mt('alice'), mt('bob')], SELF);
    const out = buildRenderEntries(layout, new Map());
    expect(out.map(e => e.tile.tag).sort()).toEqual(['alice', 'bob', 'self']);
  });

  it('self is always present exactly once, with kind self', () => {
    const layout = paginateOthers([mt('alice')], SELF);
    const out = buildRenderEntries(layout, new Map());
    const selves = out.filter(e => e.kind === 'self');
    expect(selves).toHaveLength(1);
    expect(selves[0].tile.tag).toBe('self');
  });

  it('layout wins over retention for the same tag (live data, no duplicate)', () => {
    const live  = mt('alice', 0.9);
    const stale = mt('alice', 0.0);
    const layout = paginateOthers([live, mt('bob')], SELF);
    const out = buildRenderEntries(layout, retainedOf(stale));
    const alices = out.filter(e => e.tile.tag === 'alice');
    expect(alices).toHaveLength(1);
    expect((alices[0].tile as MergedTile).audioLevel).toBe(0.9);
  });

  it('retained-but-absent tags are appended after all layout tags', () => {
    const layout = paginateOthers([mt('alice')], SELF);
    const out = buildRenderEntries(layout, retainedOf(mt('ghost')));
    expect(out.map(e => e.tile.tag)).toEqual(['alice', 'self', 'ghost']);
    expect(out[2].kind).toBe('remote');
  });

  it('every emitted layout tag has a position from resolveTilePositions', () => {
    // The blank-cell invariant: render set ⊆ position set for layout tags.
    const layout = paginateOthers([mt('a'), mt('b'), mt('c'), mt('d')], SELF);
    const out = buildRenderEntries(layout, new Map());
    const positions = resolveTilePositions(layout, {hero: null, small1: null, small2: null, grid: []}, 360);
    for (const e of out) {
      expect(positions[e.tile.tag]).toBeDefined();
    }
  });
});

describe('resolveTileOpacityAction (B-17 visibility latch)', () => {
  const vis = (role: TileVisState['role'], visible: boolean): TileVisState => ({role, visible});

  it('hidden tile → hide, regardless of history', () => {
    expect(resolveTileOpacityAction(undefined, vis('small', false))).toBe('hide');
    expect(resolveTileOpacityAction(vis('hero', true), vis('hero', false))).toBe('hide');
  });

  it('brand-new visible non-hero tile → show', () => {
    expect(resolveTileOpacityAction(undefined, vis('small', true))).toBe('show');
    expect(resolveTileOpacityAction(undefined, vis('grid', true))).toBe('show');
  });

  it('hero promotion (new or from non-hero) → fadeInHero', () => {
    expect(resolveTileOpacityAction(undefined, vis('hero', true))).toBe('fadeInHero');
    expect(resolveTileOpacityAction(vis('small', true), vis('hero', true))).toBe('fadeInHero');
  });

  it('B-17 regression: hidden→visible with UNCHANGED role → show (old code latched at 0)', () => {
    expect(resolveTileOpacityAction(vis('small', false), vis('small', true))).toBe('show');
    expect(resolveTileOpacityAction(vis('grid', false),  vis('grid', true))).toBe('show');
  });

  it('hero returning from hidden → show (not stuck invisible, no re-crossfade)', () => {
    expect(resolveTileOpacityAction(vis('hero', false), vis('hero', true))).toBe('show');
  });

  it('steady visible states → keep (no animated-value churn)', () => {
    expect(resolveTileOpacityAction(vis('hero', true),  vis('hero', true))).toBe('keep');
    expect(resolveTileOpacityAction(vis('small', true), vis('small', true))).toBe('keep');
    expect(resolveTileOpacityAction(vis('small', true), vis('grid', true))).toBe('keep');
    // Hero demotion keeps current opacity (it was already 1).
    expect(resolveTileOpacityAction(vis('hero', true),  vis('small', true))).toBe('keep');
  });
});

// GCV-5 — page geometry was frozen at module load (`Dimensions.get('window')`
// at the top of GroupCallScreen), so every page offset, the swipe threshold
// and the equal-3 grid slot width stayed at the launch-time viewport for the
// life of the JS VM: a foldable unfold / split-screen resize left a black
// gutter, two half-pages on screen at once, and a left-hugging grid.
describe('GCV-5 — live page geometry', () => {
  const SELF: SelfTile = {tag: 'self', isSelf: true};

  function mt(tag: string, audioLevel = 0): MergedTile {
    return {tag, audioLevel};
  }

  function measuredRects(gridPages: number): SlotRects {
    const r: SlotRects = {
      hero:   {x: 0,   y: 0,   width: 360, height: 320},
      small1: {x: 0,   y: 328, width: 176, height: 130},
      small2: {x: 184, y: 328, width: 176, height: 130},
      grid:   [],
    };
    for (let p = 0; p < gridPages; p++) {
      r.grid.push([
        {x: 0,   y: 0, width: 116, height: 155},
        {x: 122, y: 0, width: 116, height: 155},
        {x: 244, y: 0, width: 116, height: 155},
      ]);
    }
    return r;
  }

  it('B-19 arithmetic is pinned literally — floor((pageW - 24) / 3)', () => {
    expect(resolveGridSlotWidth(360)).toBe(112);
    expect(resolveGridSlotWidth(360)).toBe(Math.floor((360 - 24) / 3));
    expect(GROUP_CALL_PAGE_GAP).toBe(12);
  });

  it('B-19 invariant across a width sweep: 3 slots + 2 gaps always fit', () => {
    for (const pageW of [288, 320, 360, 411, 480, 600, 641, 800, 1024]) {
      const w = resolveGridSlotWidth(pageW);
      expect(3 * w + 2 * GROUP_CALL_PAGE_GAP).toBeLessThanOrEqual(pageW);
    }
    // Unfolded foldable (673dp window - 32dp page padding).
    expect(resolveGridSlotWidth(641)).toBe(205);
  });

  it('page width subtracts both paddings and never goes negative', () => {
    expect(resolveGroupCallPageWidth(411, 16)).toBe(379);
    expect(resolveGroupCallPageWidth(0, 16)).toBe(0);
    expect(resolveGroupCallPageWidth(20, 16)).toBe(0);
    // A degenerate width must not produce negative RN style values.
    expect(resolveGridSlotWidth(0)).toBe(0);
    expect(resolveGridSlotWidth(10)).toBe(0);
  });

  it('grid page offsets track the LIVE page width (page 0 stays put)', () => {
    const layout = paginateOthers(
      [mt('a'), mt('b'), mt('c'), mt('d'), mt('e'), mt('f'), mt('g'), mt('h'), mt('i')],
      SELF,
    );
    const rects  = measuredRects(3);
    const narrow = resolveTilePositions(layout, rects, 379);
    const wide   = resolveTilePositions(layout, rects, 641);

    let sawGrid = false;
    for (const tag of Object.keys(narrow)) {
      const a = narrow[tag];
      const b = wide[tag];
      expect(b.role).toBe(a.role);
      if (a.role === 'grid') {
        sawGrid = true;
        expect(b.x - a.x).toBe((641 - 379) * a.page);
      } else {
        expect(b.x).toBe(a.x);          // page 0 is unaffected by page width
      }
    }
    expect(sawGrid).toBe(true);
  });

  it('GCV-5: GroupCallScreen never binds page width at module load', () => {
    const src = readFileSync(
      join(__dirname, '../../../screens/messenger/GroupCallScreen.tsx'),
      'utf8',
    );
    expect(src).not.toMatch(/Dimensions\.get\(/);
    expect(src).toContain('useWindowDimensions');
    expect(src).not.toMatch(/gridThreeSlot:\s*\{\s*width:/);
  });
});
