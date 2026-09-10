/**
 * G-A / G-B (VIDEO_CALL_RENDER_ISSUES_HANDOFF §3) — merged-tile cache.
 *
 * The GroupCallScreen reference cache existed for perf (stable array
 * reference across 250ms audio-level ticks) but swallowed real data:
 *   G-A — its signature covered tag order + track PRESENCE only, so a
 *         `paused` flip (camera toggle rides producer-pause since GC-01)
 *         or a rebuilt consumerId matched the old sig and the stale tile
 *         objects were returned FOREVER in a 2-party call (order can
 *         never change there).
 *   G-B — the loudest-speaker debounce returned the old array without
 *         scheduling any recompute; in a silent call (audioLevels only
 *         tick on a >0.04 delta) a joiner's video tile that landed inside
 *         the window never mounted.
 *
 * Fixed semantics pinned here:
 *   1. DATA changes (paused flip, consumer rebuild, a tag's track
 *      appearing/disappearing) surface IMMEDIATELY — the debounce only
 *      ever smooths loudest-speaker re-ORDERING.
 *   2. A withheld (order-only) hold returns a recompute deadline the
 *      caller must honour, so even a silent call converges.
 *   3. Identical data + order keeps the same array reference (the perf
 *      contract the cache exists for).
 */

import {
  resolveMergedCache,
  mergedTileSignature,
  type MergedTile,
  type MergedCacheState,
} from '../webrtc/groupCallLayout';
import type {RemoteTile} from '../webrtc/useGroupCall';

const DEBOUNCE = 1500;

function remoteTile(overrides: Partial<RemoteTile> = {}): RemoteTile {
  return {
    participantTag: 'tag-a',
    consumerId:     'cons-1',
    producerId:     'prod-1',
    kind:           'video',
    stream:         {} as RemoteTile['stream'],
    ...overrides,
  };
}

function tile(tag: string, overrides: Partial<MergedTile> = {}): MergedTile {
  return {
    tag,
    audio: remoteTile({participantTag: tag, kind: 'audio', consumerId: `a-${tag}`}),
    video: remoteTile({participantTag: tag, kind: 'video', consumerId: `v-${tag}`}),
    audioLevel: 0,
    ...overrides,
  };
}

describe('G-A — data changes surface immediately, even inside the debounce', () => {
  it('a paused flip with UNCHANGED order returns a NEW array carrying the flag', () => {
    const before = [tile('a')];
    const first = resolveMergedCache(null, before, 1000, DEBOUNCE);
    expect(first.arr).toBe(before);

    // Same single participant (2-party call — order can never change),
    // camera toggled off 100ms later → video.paused=true. Must NOT wait.
    const after = [tile('a', {video: remoteTile({participantTag: 'a', consumerId: 'v-a', paused: true})})];
    const second = resolveMergedCache(first.nextCache, after, 1100, DEBOUNCE);

    expect(second.arr).toBe(after);                    // fresh array, no hold
    expect(second.arr[0].video?.paused).toBe(true);    // flag visible to renderer
    expect(second.nextCache.arr).toBe(after);          // cache converged
    expect(second.recomputeAtMs).toBeNull();
  });

  it('a consumer rebuild (new consumerId, same everything else) invalidates immediately', () => {
    const before = [tile('a')];
    const first = resolveMergedCache(null, before, 1000, DEBOUNCE);

    const rebuilt = [tile('a', {video: remoteTile({participantTag: 'a', consumerId: 'v-a-rebuilt'})})];
    const second = resolveMergedCache(first.nextCache, rebuilt, 1050, DEBOUNCE);
    expect(second.arr).toBe(rebuilt);
    expect(second.recomputeAtMs).toBeNull();
  });

  it("G-B core case — a joiner's video tile landing right after their audio mounts immediately", () => {
    // t=1000: joiner's audio tile lands.
    const audioOnly = [tile('b', {video: undefined})];
    const first = resolveMergedCache(null, audioOnly, 1000, DEBOUNCE);

    // t=1300 (<1500ms later): their video tile lands — a DATA change,
    // so the debounce must not swallow it (silent call may never tick again).
    const withVideo = [tile('b')];
    const second = resolveMergedCache(first.nextCache, withVideo, 1300, DEBOUNCE);
    expect(second.arr).toBe(withVideo);
    expect(second.arr[0].video).toBeTruthy();
  });

  it('identical data keeps the SAME reference (the perf contract survives)', () => {
    const arr1 = [tile('a'), tile('b')];
    const first = resolveMergedCache(null, arr1, 1000, DEBOUNCE);
    // New array objects, identical content — e.g. an audio-level tick.
    const arr2 = [tile('a'), tile('b')];
    const second = resolveMergedCache(first.nextCache, arr2, 1100, DEBOUNCE);
    expect(second.arr).toBe(arr1);            // stable reference
    expect(second.recomputeAtMs).toBeNull();  // nothing withheld
  });

  it('signature differs exactly when paused/consumerId/presence differ', () => {
    const base = [tile('a')];
    const paused = [tile('a', {video: remoteTile({participantTag: 'a', consumerId: 'v-a', paused: true})})];
    const noVideo = [tile('a', {video: undefined})];
    expect(mergedTileSignature(base)).not.toBe(mergedTileSignature(paused));
    expect(mergedTileSignature(base)).not.toBe(mergedTileSignature(noVideo));
    expect(mergedTileSignature(base)).toBe(mergedTileSignature([tile('a')]));
  });
});

describe('G-B — an order-only hold must schedule its own re-emit', () => {
  // Pure order churn: same three tiles, positions 2 and 3 swap while the
  // loudest (position 1) is unchanged — the case the debounce exists for.
  const ordered = () => [tile('a'), tile('b'), tile('c')];
  const swapped = () => [tile('a'), tile('c'), tile('b')];

  it('holds the old reference inside the window AND returns the deadline', () => {
    const first = resolveMergedCache(null, ordered(), 1000, DEBOUNCE);
    const held = resolveMergedCache(first.nextCache, swapped(), 1300, DEBOUNCE);
    expect(held.arr).toBe(first.arr);                 // withheld (stability)
    expect(held.recomputeAtMs).toBe(1000 + DEBOUNCE); // caller must re-run then
  });

  it('accepts the withheld ordering at the deadline with nothing else changing', () => {
    const first = resolveMergedCache(null, ordered(), 1000, DEBOUNCE);
    const held = resolveMergedCache(first.nextCache, swapped(), 1300, DEBOUNCE);
    const final = swapped();
    const atDeadline = resolveMergedCache(held.nextCache, final, 2500, DEBOUNCE);
    expect(atDeadline.arr).toBe(final);
    expect(atDeadline.recomputeAtMs).toBeNull();
  });

  it('an ordering that reverts before the deadline settles back with no deadline', () => {
    const first = resolveMergedCache(null, ordered(), 1000, DEBOUNCE);
    const held = resolveMergedCache(first.nextCache, swapped(), 1300, DEBOUNCE);
    expect(held.recomputeAtMs).not.toBeNull();
    const reverted = resolveMergedCache(held.nextCache, ordered(), 2500, DEBOUNCE);
    expect(reverted.arr).toBe(first.arr);
    expect(reverted.recomputeAtMs).toBeNull();
  });

  it('a loudest-tag flip bypasses the debounce immediately', () => {
    const first = resolveMergedCache(null, ordered(), 1000, DEBOUNCE);
    const flipped = [tile('b'), tile('a'), tile('c')];
    const second = resolveMergedCache(first.nextCache, flipped, 1200, DEBOUNCE);
    expect(second.arr).toBe(flipped); // loudest changed → accept now
  });

  it('order churn OUTSIDE the window is accepted without a deadline', () => {
    const first = resolveMergedCache(null, ordered(), 1000, DEBOUNCE);
    const second = resolveMergedCache(first.nextCache, swapped(), 1000 + DEBOUNCE + 1, DEBOUNCE);
    expect(second.arr).not.toBe(first.arr);
    expect(second.recomputeAtMs).toBeNull();
  });

  it('held decisions do NOT mutate the cache (deadline math stays anchored)', () => {
    const first = resolveMergedCache(null, ordered(), 1000, DEBOUNCE);
    const held1 = resolveMergedCache(first.nextCache, swapped(), 1200, DEBOUNCE);
    const held2 = resolveMergedCache(held1.nextCache, swapped(), 1400, DEBOUNCE);
    // Both holds anchor to the ORIGINAL update time, not each other.
    expect(held1.recomputeAtMs).toBe(2500);
    expect(held2.recomputeAtMs).toBe(2500);
    expect(held2.nextCache).toBe(first.nextCache);
  });
});

describe('cache state transitions', () => {
  it('first call always populates the cache', () => {
    const arr = [tile('a')];
    const d = resolveMergedCache(null, arr, 5, DEBOUNCE);
    const cache: MergedCacheState = d.nextCache;
    expect(cache.arr).toBe(arr);
    expect(cache.loudestTag).toBe('a');
    expect(cache.lastUpdateMs).toBe(5);
  });
});
