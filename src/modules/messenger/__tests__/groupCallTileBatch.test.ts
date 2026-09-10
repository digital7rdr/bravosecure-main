/**
 * Regression — B-13: late-joiner sees fewer tiles than expected.
 *
 * When a device joins a room that already has ≥2 producers, the step=9
 * consume loop is SERIAL and used to call setRemoteTiles per consumer. The
 * first per-consumer re-render landed the instant `recvTx` flipped to
 * 'connected' — with only 1 remote tile present — and GroupCallScreen's
 * retainedRef froze the layout at 2 positions (1 remote + self). Tiles 2..N
 * arrived ~700ms later into a layout with no slots → the joiner permanently
 * saw 2 tiles instead of 3.
 *
 * Fix: batch the initial burst into a SINGLE setRemoteTiles after the loop
 * so the layout computes once at the final count. These tests pin the two
 * pure decisions of the flush: (1) the dedup-by-consumerId merge against any
 * tiles a live new-producer frame already added mid-burst, and (2) that the
 * resulting tile set produces the correct final layout (all participants
 * visible), via the real layout helpers.
 */
import {mergeAndSortTiles, paginateOthers} from '@/modules/messenger/webrtc/groupCallLayout';
import type {RemoteTile} from '@/modules/messenger/webrtc/useGroupCall';

// Mirrors the dedup merge in useGroupCall.ts step=9 flush: append batched
// tiles to the existing list, skipping any consumerId already present.
function flushBatch(prev: RemoteTile[], batch: RemoteTile[]): RemoteTile[] {
  const have = new Set(prev.map(t => t.consumerId));
  return prev.concat(batch.filter(t => !have.has(t.consumerId)));
}

function tile(tag: string, kind: 'audio' | 'video', consumerId: string): RemoteTile {
  return {participantTag: tag, consumerId, producerId: `p-${consumerId}`, kind, stream: null as never};
}

const SELF = {tag: 'self', isSelf: true as const};

describe('B-13 — step=9 tile batch flush', () => {
  it('flushes all 4 producer tiles (2 participants × audio+video) at once', () => {
    const batch = [
      tile('A', 'audio', 'c1'), tile('A', 'video', 'c2'),
      tile('B', 'audio', 'c3'), tile('B', 'video', 'c4'),
    ];
    const next = flushBatch([], batch);
    expect(next).toHaveLength(4);
  });

  it('dedups against a tile a live new-producer frame already added mid-burst', () => {
    // 'c1' landed via the per-tile path while step=9 was still running.
    const prev = [tile('A', 'audio', 'c1')];
    const batch = [
      tile('A', 'audio', 'c1'),   // duplicate — must be dropped
      tile('A', 'video', 'c2'),
      tile('B', 'audio', 'c3'),
    ];
    const next = flushBatch(prev, batch);
    expect(next.map(t => t.consumerId)).toEqual(['c1', 'c2', 'c3']);
  });

  it('the flushed set yields the correct final layout — 2 remotes + self = 3 visible tiles', () => {
    const batch = [
      tile('A', 'audio', 'c1'), tile('A', 'video', 'c2'),
      tile('B', 'audio', 'c3'), tile('B', 'video', 'c4'),
    ];
    const remoteTiles = flushBatch([], batch);
    const merged = mergeAndSortTiles(remoteTiles, {});
    // 4 producer tiles collapse to 2 participants.
    expect(merged).toHaveLength(2);
    const layout = paginateOthers(merged, SELF);
    // hero (1 remote) + others (1 remote + self) = 3 tiles total, never 2.
    const remoteCount = (layout.hero ? 1 : 0) + layout.others.filter(o => o.kind === 'remote').length;
    expect(remoteCount).toBe(2);
    expect(layout.others.some(o => o.kind === 'self')).toBe(true);
  });

  it('the OLD per-tile path with only the first consumer would have shown just 1 remote (the bug)', () => {
    // Demonstrates why the intermediate state was wrong: at the moment
    // recvTx connected, only consumer #1 existed.
    const intermediate = mergeAndSortTiles([tile('A', 'audio', 'c1')], {});
    const layout = paginateOthers(intermediate, SELF);
    const remoteCount = (layout.hero ? 1 : 0) + layout.others.filter(o => o.kind === 'remote').length;
    expect(remoteCount).toBe(1); // ← the frozen-at-2-tiles (1 remote + self) symptom
  });
});
