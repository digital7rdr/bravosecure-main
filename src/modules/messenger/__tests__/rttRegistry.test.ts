/**
 * WS round-trip-time registry — first direct coverage.
 *
 * Live-wired three ways (productionRuntime publishes each pong,
 * useTransportRtt renders the chip, authStore clears on logout), but
 * nothing pinned the contract: subscribe emits the CURRENT value
 * immediately, age is measured from the last sample, clear resets and
 * notifies, and one throwing listener must not starve the rest.
 */

import {clearRtt, getRtt, onRtt, publishRtt} from '../runtime/rttRegistry';

const unsubs: Array<() => void> = [];
const track = (u: () => void) => { unsubs.push(u); return u; };

afterEach(() => {
  while (unsubs.length) {unsubs.pop()!();}
  clearRtt();
  jest.restoreAllMocks();
});

describe('publish / get', () => {
  it('starts empty', () => {
    expect(getRtt()).toEqual({rttMs: null, ageMs: null});
  });

  it('reports the last sample and its age', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    publishRtt(42);
    now.mockReturnValue(103_500);
    expect(getRtt()).toEqual({rttMs: 42, ageMs: 3_500});
  });

  it('a newer sample replaces the older one', () => {
    publishRtt(42);
    publishRtt(88);
    expect(getRtt().rttMs).toBe(88);
  });
});

describe('onRtt subscription', () => {
  it('emits the current value synchronously on subscribe', () => {
    publishRtt(42);
    const seen: Array<number | null> = [];
    track(onRtt(v => seen.push(v)));
    expect(seen).toEqual([42]);
  });

  it('emits null on subscribe when no sample exists yet', () => {
    const seen: Array<number | null> = [];
    track(onRtt(v => seen.push(v)));
    expect(seen).toEqual([null]);
  });

  it('notifies on every publish until unsubscribed', () => {
    const seen: Array<number | null> = [];
    const unsub = onRtt(v => seen.push(v));
    publishRtt(10);
    publishRtt(20);
    unsub();
    publishRtt(30);
    expect(seen).toEqual([null, 10, 20]);
  });

  it('one throwing listener does not starve the others', () => {
    track(onRtt(() => { throw new Error('bad subscriber'); }));
    const seen: Array<number | null> = [];
    track(onRtt(v => seen.push(v)));
    expect(() => publishRtt(7)).not.toThrow();
    expect(seen).toEqual([null, 7]);
  });
});

describe('clearRtt — logout teardown', () => {
  it('resets the sample and notifies subscribers with null', () => {
    const seen: Array<number | null> = [];
    publishRtt(42);
    track(onRtt(v => seen.push(v)));
    clearRtt();
    expect(seen).toEqual([42, null]);
    expect(getRtt()).toEqual({rttMs: null, ageMs: null});
  });
});
