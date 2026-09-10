/**
 * GF-6 — per-recipient outbox drain lanes.
 *
 * The drain used to be one flat serial loop, so one black-holing peer's 20s
 * transport timeout stalled every queued message to every OTHER peer. Lanes
 * are keyed `${peerUserId}.${peerDeviceId}` — byte-identical to the
 * SessionManager ratchet-mutex key — so parallel lanes can never contend on
 * the same Double Ratchet chain, and per-peer order is preserved.
 */

import {
  groupRowsByPeer,
  runOutboxLanes,
  outboxLaneKey,
  OUTBOX_DRAIN_LANE_LIMIT,
  type LaneStep,
} from '../runtime/outboxLanes';

interface Row {
  peerUserId: string;
  peerDeviceId: number;
  id: number;
}

const row = (peer: string, id: number, device = 1): Row =>
  ({peerUserId: peer, peerDeviceId: device, id});

describe('outboxLaneKey', () => {
  it('matches the SessionManager per-address mutex key shape', () => {
    expect(outboxLaneKey({peerUserId: 'alice', peerDeviceId: 2})).toBe('alice.2');
  });
});

describe('groupRowsByPeer', () => {
  it('partitions rows for distinct peers into distinct lanes', () => {
    const lanes = groupRowsByPeer([row('a', 1), row('b', 2), row('c', 3), row('a', 4)]);
    expect(lanes).toHaveLength(3);
    for (const lane of lanes) {
      const keys = new Set(lane.map(outboxLaneKey));
      expect(keys.size).toBe(1);
    }
  });

  it('same user, different device => two lanes (the ratchet lock key)', () => {
    const lanes = groupRowsByPeer([row('a', 1, 1), row('a', 2, 2)]);
    expect(lanes).toHaveLength(2);
  });

  it('preserves input order within a lane', () => {
    const lanes = groupRowsByPeer([row('a', 1), row('b', 2), row('a', 3), row('a', 4)]);
    const laneA = lanes.find(l => l[0].peerUserId === 'a');
    expect(laneA?.map(r => r.id)).toEqual([1, 3, 4]);
  });

  it('lane order follows first appearance, oldest row first overall', () => {
    const lanes = groupRowsByPeer([row('b', 1), row('a', 2)]);
    expect(lanes[0][0].id).toBe(1);
  });

  it('empty input => no lanes', () => {
    expect(groupRowsByPeer([])).toEqual([]);
  });
});

describe('runOutboxLanes', () => {
  it('never runs two rows of the same lane concurrently', async () => {
    const lanes = groupRowsByPeer([
      row('a', 1), row('a', 2), row('b', 3), row('b', 4), row('c', 5),
    ]);
    const active = new Map<string, number>();
    let violated = false;
    await runOutboxLanes(lanes, 3, async r => {
      const key = outboxLaneKey(r);
      active.set(key, (active.get(key) ?? 0) + 1);
      if ((active.get(key) ?? 0) > 1) { violated = true; }
      await new Promise(res => setTimeout(res, 5));
      active.set(key, (active.get(key) ?? 0) - 1);
      return 'continue';
    });
    expect(violated).toBe(false);
  });

  it('bounds concurrency at the limit while completing every lane', async () => {
    const lanes = groupRowsByPeer(
      Array.from({length: 10}, (_, i) => row(`p${i}`, i)));
    let running = 0;
    let peak = 0;
    const seen: number[] = [];
    await runOutboxLanes(lanes, OUTBOX_DRAIN_LANE_LIMIT, async r => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise(res => setTimeout(res, 5));
      seen.push(r.id);
      running -= 1;
      return 'continue';
    });
    expect(peak).toBeLessThanOrEqual(OUTBOX_DRAIN_LANE_LIMIT);
    expect(peak).toBeGreaterThan(1);
    expect(seen.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('GF-6 regression — a stalled lane does not block the others', async () => {
    let releaseA!: () => void;
    const gate = new Promise<void>(res => { releaseA = res; });
    const lanes = groupRowsByPeer([
      row('stuck', 1), row('b', 2), row('b', 3), row('c', 4), row('d', 5),
    ]);
    const done: number[] = [];
    const pass = runOutboxLanes(lanes, 4, async r => {
      if (r.peerUserId === 'stuck') { await gate; }
      done.push(r.id);
      return 'continue';
    });
    // Give the healthy lanes time to finish while 'stuck' is still hung.
    await new Promise(res => setTimeout(res, 25));
    expect(done.sort((x, y) => x - y)).toEqual([2, 3, 4, 5]);
    releaseA();
    await pass;
    expect(done).toContain(1);
  });

  it("'stop' from any worker halts every lane and still resolves", async () => {
    const lanes = groupRowsByPeer([
      row('a', 1), row('a', 2), row('b', 3), row('c', 4), row('d', 5), row('e', 6),
    ]);
    const calls: number[] = [];
    await runOutboxLanes(lanes, 1, async r => {
      calls.push(r.id);
      return (r.id === 3 ? 'stop' : 'continue') as LaneStep;
    });
    // width 1 => strictly sequential; nothing after the stop row runs.
    expect(calls).toEqual([1, 2, 3]);
  });

  it('resolves on empty lanes without calling the worker', async () => {
    const worker = jest.fn(async () => 'continue' as LaneStep);
    await runOutboxLanes([], 4, worker);
    expect(worker).not.toHaveBeenCalled();
  });

  it('clamps a zero/oversized limit and still processes every row exactly once', async () => {
    const lanes = groupRowsByPeer([row('a', 1), row('b', 2)]);
    for (const limit of [0, 99]) {
      const calls: number[] = [];
      await runOutboxLanes(lanes, limit, async r => {
        calls.push(r.id);
        return 'continue';
      });
      expect(calls.sort()).toEqual([1, 2]);
    }
  });

  it('a throwing worker neither rejects the pass nor aborts its lane', async () => {
    const lanes = groupRowsByPeer([row('a', 1), row('a', 2)]);
    const calls: number[] = [];
    await expect(runOutboxLanes(lanes, 2, async r => {
      calls.push(r.id);
      if (r.id === 1) { throw new Error('boom'); }
      return 'continue';
    })).resolves.toBeUndefined();
    expect(calls).toEqual([1, 2]);
  });
});
