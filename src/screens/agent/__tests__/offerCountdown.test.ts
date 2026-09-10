import {offerRemainingSeconds, offerProgress, offerExpired, OFFER_TTL_SECONDS} from '../offerCountdown';

describe('offerCountdown (Step 20) — bound to server expires_at, never a 0-start timer', () => {
  const NOW = 1_750_000_000_000;
  const iso = (deltaSec: number) => new Date(NOW + deltaSec * 1000).toISOString();

  it('counts whole seconds remaining until expiry', () => {
    expect(offerRemainingSeconds(iso(30), NOW)).toBe(30);
    expect(offerRemainingSeconds(iso(12), NOW)).toBe(12);
    expect(offerRemainingSeconds(iso(0.4), NOW)).toBe(0); // rounds to 0
  });

  it('never goes negative once the deadline has passed', () => {
    expect(offerRemainingSeconds(iso(-5), NOW)).toBe(0);
    expect(offerRemainingSeconds(iso(-9999), NOW)).toBe(0);
  });

  it('is defensive about an unparseable timestamp', () => {
    expect(offerRemainingSeconds('not-a-date', NOW)).toBe(0);
  });

  it('reports the fraction of the window remaining (0..1) for the ring', () => {
    expect(offerProgress(iso(OFFER_TTL_SECONDS), NOW)).toBeCloseTo(1, 5);
    expect(offerProgress(iso(OFFER_TTL_SECONDS / 2), NOW)).toBeCloseTo(0.5, 5);
    expect(offerProgress(iso(0), NOW)).toBe(0);
    expect(offerProgress(iso(-10), NOW)).toBe(0);
  });

  it('flags expiry', () => {
    expect(offerExpired(iso(3), NOW)).toBe(false);
    expect(offerExpired(iso(0), NOW)).toBe(true);
    expect(offerExpired(iso(-1), NOW)).toBe(true);
  });
});
