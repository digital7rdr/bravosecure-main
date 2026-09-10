/**
 * B-692 NL-7 — the live-arrival registry behind the bubble entrance animation.
 *
 * A pipeline-delayed message is older than the bubble's 2 s created_at check
 * but still JUST APPEARED in the open chat; ChatScreen's render diff marks it
 * here so it animates in instead of popping. The cap keeps bulk deliveries
 * (drains/backfills) un-animated; the TTL keeps a later re-mount (scroll-back,
 * screen re-open) from re-springing old rows.
 */
import {markLiveArrivals, isLiveArrival, _resetLiveArrivalsForTest} from '../liveArrivals';

describe('B-692 NL-7 — live-arrival registry', () => {
  let nowSpy: jest.SpyInstance<number, []>;
  const T0 = 1_800_000_000_000;

  beforeEach(() => {
    _resetLiveArrivalsForTest();
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('a marked id is live; an unmarked one is not', () => {
    markLiveArrivals(['m-1']);
    expect(isLiveArrival('m-1')).toBe(true);
    expect(isLiveArrival('m-other')).toBe(false);
  });

  it('entries expire after the TTL — a bubble mounting later is scroll-back, not the arrival', () => {
    markLiveArrivals(['m-ttl']);
    nowSpy.mockReturnValue(T0 + 9_999);
    expect(isLiveArrival('m-ttl')).toBe(true);
    nowSpy.mockReturnValue(T0 + 10_000);
    expect(isLiveArrival('m-ttl')).toBe(false);
  });

  it('a bulk commit (more ids than the cap) marks NOTHING — drains/backfills pop in un-animated', () => {
    markLiveArrivals(['b-1', 'b-2', 'b-3', 'b-4']);
    for (const id of ['b-1', 'b-2', 'b-3', 'b-4']) {
      expect(isLiveArrival(id)).toBe(false);
    }
    // At the cap it still marks — a fast three-message burst animates.
    markLiveArrivals(['c-1', 'c-2', 'c-3']);
    for (const id of ['c-1', 'c-2', 'c-3']) {
      expect(isLiveArrival(id)).toBe(true);
    }
  });

  it('an empty commit marks nothing and never throws', () => {
    expect(() => markLiveArrivals([])).not.toThrow();
    expect(isLiveArrival('')).toBe(false);
  });
});
