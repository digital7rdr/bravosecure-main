/**
 * Regression — B-17: rotating-victim missing tile.
 *
 * In a 3-party voice call a NON-HOST joiner intermittently showed only
 * 2 of 3 tiles, and the victim changed per call — yet every consumer
 * attached (audio was fine). Root cause: the step=9 boot batch consumed
 * a producer (consumer attached, audioflowing) but its tile was lost to
 * a flush race, and the reconcile tick only re-consumed producers with
 * NO consumer. A consumed-but-tileless producer was therefore "already
 * consumed" → skipped forever → permanent missing tile.
 *
 * Fix: reconcile on TILES, not consumers. For each server producer with
 * no tile:
 *   • a live consumer exists → REBUILD the tile from it (re-consuming
 *     would throw "consumer already exists"),
 *   • else                   → fresh CONSUME.
 * In-flight consumes and already-tiled producers are left alone.
 *
 * These tests pin the pure partition decision and verify the recovered
 * tile set yields the full layout via the real layout helpers.
 */
import {mergeAndSortTiles, paginateOthers} from '@/modules/messenger/webrtc/groupCallLayout';
import type {RemoteTile} from '@/modules/messenger/webrtc/useGroupCall';

type Producer = {producerId: string; participantTag: string; kind: 'audio' | 'video'};

// Mirrors the B-17 partition in useGroupCall.ts reconcileProducers.
function planReconcile(args: {
  serverProducers:         Producer[];
  tiledProducerIds:        Set<string>; // producerIds that already have a tile
  liveConsumerProducerIds: Set<string>; // producerIds with a live (open) consumer
  inFlight:                Set<string>; // producerIds currently being consumed
}): {rebuild: string[]; consume: string[]} {
  const rebuild: string[] = [];
  const consume: string[] = [];
  for (const p of args.serverProducers) {
    if (args.tiledProducerIds.has(p.producerId)) {continue;}
    if (args.inFlight.has(p.producerId)) {continue;}
    if (args.liveConsumerProducerIds.has(p.producerId)) {rebuild.push(p.producerId);}
    else {consume.push(p.producerId);}
  }
  return {rebuild, consume};
}

// The OLD (buggy) filter: a producer was "missing" only when it had no
// consumer. A consumed-but-tileless producer was never recovered.
function oldMissing(args: {
  serverProducers:    Producer[];
  consumedProducerIds: Set<string>;
  inFlight:            Set<string>;
}): string[] {
  return args.serverProducers
    .filter(p => !args.consumedProducerIds.has(p.producerId) && !args.inFlight.has(p.producerId))
    .map(p => p.producerId);
}

function tile(tag: string, kind: 'audio' | 'video', consumerId: string, producerId: string): RemoteTile {
  return {participantTag: tag, consumerId, producerId, kind, stream: null as never};
}

const SELF = {tag: 'self', isSelf: true as const};

const PRODUCERS: Producer[] = [
  {producerId: 'pA', participantTag: 'A', kind: 'audio'},
  {producerId: 'pB', participantTag: 'B', kind: 'audio'},
];

describe('B-17 — tile-aware reconcile partition', () => {
  it('REBUILDS a consumed-but-tileless producer instead of re-consuming it', () => {
    // pA has a live consumer but lost its tile to the boot-batch race; pB
    // is fine (tiled). pA must be rebuilt, not re-consumed (which would
    // throw "consumer already exists").
    const plan = planReconcile({
      serverProducers:         PRODUCERS,
      tiledProducerIds:        new Set(['pB']),
      liveConsumerProducerIds: new Set(['pA', 'pB']),
      inFlight:                new Set(),
    });
    expect(plan.rebuild).toEqual(['pA']);
    expect(plan.consume).toEqual([]);
  });

  it('CONSUMES a producer with neither tile nor consumer (genuine miss)', () => {
    const plan = planReconcile({
      serverProducers:         PRODUCERS,
      tiledProducerIds:        new Set(['pA']),
      liveConsumerProducerIds: new Set(['pA']), // pB has no consumer
      inFlight:                new Set(),
    });
    expect(plan.consume).toEqual(['pB']);
    expect(plan.rebuild).toEqual([]);
  });

  it('leaves already-tiled producers and in-flight consumes alone', () => {
    const plan = planReconcile({
      serverProducers:         PRODUCERS,
      tiledProducerIds:        new Set(['pA']),    // pA done
      liveConsumerProducerIds: new Set(['pA']),
      inFlight:                new Set(['pB']),    // pB being consumed right now
    });
    expect(plan.rebuild).toEqual([]);
    expect(plan.consume).toEqual([]);
  });

  it('the OLD consumer-only filter SKIPPED a consumed-but-tileless producer (the bug)', () => {
    // pA is consumed (so the old filter says "not missing") but has no
    // tile → the old reconcile recovered nothing and the tile stayed gone.
    const stillMissing = oldMissing({
      serverProducers:    PRODUCERS,
      consumedProducerIds: new Set(['pA', 'pB']), // both "consumed"
      inFlight:            new Set(),
    });
    expect(stillMissing).toEqual([]); // ← old code recovered nothing
    // The new partition DOES recover pA from its live consumer.
    const plan = planReconcile({
      serverProducers:         PRODUCERS,
      tiledProducerIds:        new Set(['pB']),       // pA tile lost
      liveConsumerProducerIds: new Set(['pA', 'pB']),
      inFlight:                new Set(),
    });
    expect(plan.rebuild).toEqual(['pA']);
  });

  it('recovered tile set yields the full 3-tile layout (2 remotes + self)', () => {
    // Before recovery: only B is tiled → 1 remote + self = 2 (the victim).
    const before = paginateOthers(mergeAndSortTiles([tile('B', 'audio', 'cB', 'pB')], {}), SELF);
    const beforeRemotes = (before.hero ? 1 : 0) + before.others.filter(o => o.kind === 'remote').length;
    expect(beforeRemotes).toBe(1);

    // After rebuilding A's tile from its live consumer, both remotes show.
    const after = paginateOthers(
      mergeAndSortTiles([tile('B', 'audio', 'cB', 'pB'), tile('A', 'audio', 'cA', 'pA')], {}),
      SELF,
    );
    const afterRemotes = (after.hero ? 1 : 0) + after.others.filter(o => o.kind === 'remote').length;
    expect(afterRemotes).toBe(2);
    expect(after.others.some(o => o.kind === 'self')).toBe(true);
  });

  it('rebuild dedups by consumerId so a concurrent flush cannot double-add', () => {
    // The reconcile rebuild and a late batch flush both target the same
    // consumer — the setRemoteTiles dedup-by-consumerId keeps it single.
    const prev = [tile('A', 'audio', 'cA', 'pA')];
    const recovered = [tile('A', 'audio', 'cA', 'pA')];
    const have = new Set(prev.map(t => t.consumerId));
    const next = prev.concat(recovered.filter(t => !have.has(t.consumerId)));
    expect(next).toHaveLength(1);
  });
});

// Mirrors the B-17 PRUNE step in useGroupCall.ts reconcileProducers: a tile
// whose producer is absent from the authoritative snapshot for N consecutive
// successful snapshots is a phantom (extra blank cell) and is pruned. A
// producer still producing is ALWAYS in the snapshot, so this can never drop
// a live tile. `misses` persists across calls (the boot closure).
function planPrune(args: {
  tiles:               {producerId: string; consumerId: string}[];
  snapshotProducerIds: Set<string>;
  inFlight:            Set<string>;
  misses:              Map<string, number>;
  threshold:           number;
}): string[] {
  const prune: string[] = [];
  for (const t of args.tiles) {
    if (args.snapshotProducerIds.has(t.producerId) || args.inFlight.has(t.producerId)) {
      args.misses.delete(t.producerId);
      continue;
    }
    const m = (args.misses.get(t.producerId) ?? 0) + 1;
    args.misses.set(t.producerId, m);
    if (m >= args.threshold) {
      prune.push(t.consumerId);
      args.misses.delete(t.producerId);
    }
  }
  return prune;
}

describe('B-17 — phantom-tile prune', () => {
  const TILES = [
    {producerId: 'pA', consumerId: 'cA'}, // real (in snapshot)
    {producerId: 'pX', consumerId: 'cX'}, // phantom (absent from snapshot)
  ];

  it('NEVER prunes a tile whose producer is in the snapshot, across many ticks', () => {
    const misses = new Map<string, number>();
    const snap = new Set(['pA', 'pX']); // both present
    for (let i = 0; i < 10; i++) {
      const prune = planPrune({tiles: TILES, snapshotProducerIds: snap, inFlight: new Set(), misses, threshold: 3});
      expect(prune).toEqual([]);
    }
  });

  it('prunes a phantom tile ONLY after the threshold of consecutive absences', () => {
    const misses = new Map<string, number>();
    const snap = new Set(['pA']); // pX absent
    // tick 1, 2 — below threshold, no prune yet
    expect(planPrune({tiles: TILES, snapshotProducerIds: snap, inFlight: new Set(), misses, threshold: 3})).toEqual([]);
    expect(planPrune({tiles: TILES, snapshotProducerIds: snap, inFlight: new Set(), misses, threshold: 3})).toEqual([]);
    // tick 3 — threshold reached → prune the phantom (and never the real one)
    expect(planPrune({tiles: TILES, snapshotProducerIds: snap, inFlight: new Set(), misses, threshold: 3})).toEqual(['cX']);
  });

  it('resets the miss counter if the producer reappears before the threshold', () => {
    const misses = new Map<string, number>();
    const absent  = new Set(['pA']);
    const present = new Set(['pA', 'pX']);
    planPrune({tiles: TILES, snapshotProducerIds: absent,  inFlight: new Set(), misses, threshold: 3}); // miss 1
    planPrune({tiles: TILES, snapshotProducerIds: present, inFlight: new Set(), misses, threshold: 3}); // reset
    // Two more absences are still below threshold because the counter reset.
    expect(planPrune({tiles: TILES, snapshotProducerIds: absent, inFlight: new Set(), misses, threshold: 3})).toEqual([]);
    expect(planPrune({tiles: TILES, snapshotProducerIds: absent, inFlight: new Set(), misses, threshold: 3})).toEqual([]);
  });

  it('does not prune a producer that is currently being consumed (in-flight)', () => {
    const misses = new Map<string, number>();
    const snap = new Set(['pA']); // pX absent from snapshot...
    const inFlight = new Set(['pX']); // ...but a consume is in progress
    for (let i = 0; i < 5; i++) {
      expect(planPrune({tiles: TILES, snapshotProducerIds: snap, inFlight, misses, threshold: 3})).toEqual([]);
    }
  });
});
