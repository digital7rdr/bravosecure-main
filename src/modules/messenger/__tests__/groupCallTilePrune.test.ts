/**
 * B-17 — `computeTilePrune` is the pure prune decision behind the
 * group-call reconcile loop. It must:
 *   • drop a zombie tag IMMEDIATELY when the same userId is live under a
 *     different tag (a reconnect→rejoin replaced the tag — the B-05 WS-churn
 *     "2 tiles + 1 blank" symptom),
 *   • drop a plain-absent producer only after a debounce so a partial
 *     snapshot can't evict a live participant,
 *   • never drop a tag that is still live (incl. the audio+video-same-tag
 *     case where one of the two producers stopped).
 */
import {computeTilePrune, type ReconcileTileRef} from '../webrtc/groupCallLayout';

const THRESH = 3;

function tile(o: Partial<ReconcileTileRef> & {producerId: string}): ReconcileTileRef {
  return {
    participantTag: o.participantTag ?? 'tagA',
    producerId:     o.producerId,
    consumerId:     o.consumerId ?? `con-${o.producerId}`,
  };
}

describe('computeTilePrune — B-17 zombie-tag + phantom-tile reconcile', () => {
  test('a live producer is never pruned and its miss counter resets', () => {
    const tiles = [tile({participantTag: 'tagA', producerId: 'pA'})];
    const r = computeTilePrune({
      tiles,
      snapshot: [{producerId: 'pA', participantTag: 'tagA'}],
      inFlightProducerIds: new Set(),
      identities: {tagA: {userId: 'alice'}},
      prevMisses: new Map([['pA', 2]]),  // had prior misses; now back → reset
      threshold: THRESH,
    });
    expect(r.pruneConsumerIds.size).toBe(0);
    expect(r.nextMisses.has('pA')).toBe(false);
  });

  test('a superseded tag (same userId, new live tag) is pruned on the FIRST tick', () => {
    // alice was 'tagOld'; she rejoined as 'tagNew'. tagOld's producer is
    // gone from the snapshot, tagNew's is present — both map to alice.
    const tiles = [tile({participantTag: 'tagOld', producerId: 'pOld'})];
    const r = computeTilePrune({
      tiles,
      snapshot: [{producerId: 'pNew', participantTag: 'tagNew'}],
      inFlightProducerIds: new Set(),
      identities: {tagOld: {userId: 'alice'}, tagNew: {userId: 'alice'}},
      prevMisses: new Map(),
      threshold: THRESH,
    });
    expect(r.pruneConsumerIds.has('con-pOld')).toBe(true);
    expect(r.prunedProducerIds.has('pOld')).toBe(true);
    expect(r.nextMisses.has('pOld')).toBe(false);
  });

  test('a plain-absent producer (no rejoin proof) is debounced, not pruned immediately', () => {
    const tiles = [tile({participantTag: 'tagB', producerId: 'pB'})];
    const args = {
      tiles,
      snapshot: [] as {producerId: string; participantTag: string}[],   // nobody live
      inFlightProducerIds: new Set<string>(),
      identities: {tagB: {userId: 'bob'}},
      threshold: THRESH,
    };
    // tick 1, 2 → accumulating, not pruned
    let misses = new Map<string, number>();
    let r = computeTilePrune({...args, prevMisses: misses});
    expect(r.pruneConsumerIds.size).toBe(0);
    expect(r.nextMisses.get('pB')).toBe(1);
    r = computeTilePrune({...args, prevMisses: r.nextMisses});
    expect(r.pruneConsumerIds.size).toBe(0);
    expect(r.nextMisses.get('pB')).toBe(2);
    // tick 3 → threshold reached → pruned
    r = computeTilePrune({...args, prevMisses: r.nextMisses});
    expect(r.pruneConsumerIds.has('con-pB')).toBe(true);
  });

  test('an absent tag whose userId is NOT live elsewhere is debounced (not superseded)', () => {
    const tiles = [tile({participantTag: 'tagB', producerId: 'pB'})];
    const r = computeTilePrune({
      tiles,
      snapshot: [{producerId: 'pA', participantTag: 'tagA'}],  // alice live, bob just gone
      inFlightProducerIds: new Set(),
      identities: {tagA: {userId: 'alice'}, tagB: {userId: 'bob'}},
      prevMisses: new Map(),
      threshold: THRESH,
    });
    expect(r.pruneConsumerIds.size).toBe(0);  // debounced, bob may just have flickered
    expect(r.nextMisses.get('pB')).toBe(1);
  });

  test('audio+video share a tag: one producer absent but the tag still live → NOT superseded', () => {
    // alice has audio (pAud) + video (pVid) under tagA. Her video stopped, so
    // pVid is gone, but pAud (same tag) is still in the snapshot. The video
    // tile must NOT be treated as a zombie just because alice's userId is
    // "live" — it's the SAME tag, not a rejoin.
    const tiles = [
      tile({participantTag: 'tagA', producerId: 'pAud'}),
      tile({participantTag: 'tagA', producerId: 'pVid'}),
    ];
    const r = computeTilePrune({
      tiles,
      snapshot: [{producerId: 'pAud', participantTag: 'tagA'}],
      inFlightProducerIds: new Set(),
      identities: {tagA: {userId: 'alice'}},
      prevMisses: new Map(),
      threshold: THRESH,
    });
    expect(r.pruneConsumerIds.size).toBe(0);     // pVid debounced, not insta-pruned
    expect(r.nextMisses.get('pVid')).toBe(1);
  });

  test('an in-flight producer is not pruned even when absent from the snapshot', () => {
    const tiles = [tile({participantTag: 'tagA', producerId: 'pA'})];
    const r = computeTilePrune({
      tiles,
      snapshot: [],
      inFlightProducerIds: new Set(['pA']),
      identities: {tagA: {userId: 'alice'}},
      prevMisses: new Map([['pA', 2]]),
      threshold: THRESH,
    });
    expect(r.pruneConsumerIds.size).toBe(0);
    expect(r.nextMisses.has('pA')).toBe(false);  // reset while in flight
  });

  test('both audio+video of a rejoined peer are superseded together', () => {
    const tiles = [
      tile({participantTag: 'tagOld', producerId: 'pOldAud'}),
      tile({participantTag: 'tagOld', producerId: 'pOldVid'}),
    ];
    const r = computeTilePrune({
      tiles,
      snapshot: [{producerId: 'pNew', participantTag: 'tagNew'}],
      inFlightProducerIds: new Set(),
      identities: {tagOld: {userId: 'alice'}, tagNew: {userId: 'alice'}},
      prevMisses: new Map(),
      threshold: THRESH,
    });
    expect(r.pruneConsumerIds.has('con-pOldAud')).toBe(true);
    expect(r.pruneConsumerIds.has('con-pOldVid')).toBe(true);
  });

  test('unknown identity falls back to the debounce (no crash, no instant prune)', () => {
    const tiles = [tile({participantTag: 'tagGhost', producerId: 'pG'})];
    const r = computeTilePrune({
      tiles,
      snapshot: [{producerId: 'pA', participantTag: 'tagA'}],
      inFlightProducerIds: new Set(),
      identities: {},  // no identity learned yet
      prevMisses: new Map(),
      threshold: THRESH,
    });
    expect(r.pruneConsumerIds.size).toBe(0);
    expect(r.nextMisses.get('pG')).toBe(1);
  });
});
