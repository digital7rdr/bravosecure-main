import {PricingService} from './pricing.service';

describe('PricingService', () => {
  const svc = new PricingService();

  const baseArgs = {
    cpoCount: 1,
    vehicleCount: 1,
    driverOnly: false,
    durationHours: 4,
    // 09:00 UTC — OUTSIDE the 17-20 peak surcharge window.
    pickupTime: new Date('2026-05-01T09:00:00Z'),
    addOns: [],
  };

  it('prices the baseline (1 CPO + 1 Vehicle + 1 Driver) at 86 EUR/hr', () => {
    const p = svc.calculate(baseArgs);
    expect(p.rate_eur_per_hour).toBe(86);
    expect(p.total_eur).toBe(86 * 4);
  });

  it('converts EUR → AED at the fixed rate (350/86 ≈ 4.07)', () => {
    const p = svc.calculate(baseArgs);
    expect(p.rate_aed_per_hour).toBeCloseTo(350, 0);
    expect(p.total_aed).toBeCloseTo(350 * 4, 0);
  });

  it('adds a 25% premium per extra CPO above 1', () => {
    const p = svc.calculate({...baseArgs, cpoCount: 3});
    // base 86 + 2 * (86 * 0.25) = 86 + 43 = 129
    expect(p.rate_eur_per_hour).toBe(129);
  });

  it('adds a 25% premium per extra vehicle above 1', () => {
    const p = svc.calculate({...baseArgs, vehicleCount: 2});
    expect(p.rate_eur_per_hour).toBe(86 + 86 * 0.25);
  });

  it('discounts to 65% of base when driver-only is selected', () => {
    const p = svc.calculate({...baseArgs, driverOnly: true});
    expect(p.rate_eur_per_hour).toBeCloseTo(86 * 0.65, 2);
  });

  it('driver-only (client vehicle) with 0 Bravo vehicles still applies the 35% discount and no vehicle surcharge', () => {
    // booking.service normalizes vehicle_count to 0 for driver-only bookings.
    const p = svc.calculate({...baseArgs, vehicleCount: 0, driverOnly: true});
    expect(p.rate_eur_per_hour).toBeCloseTo(86 * 0.65, 2);
    // No "+N Vehicle" surcharge line (the base-rate line mentions Vehicle, so
    // match the surcharge prefix specifically).
    expect(p.breakdown.some(b => /^\+\d+ Vehicle/.test(b.label))).toBe(false);
  });

  it('sums add-on hourly rates into the total', () => {
    const p = svc.calculate({
      ...baseArgs,
      addOns: [
        {id: 'recon',   label: 'Recon',   price_eur_per_hour: 25},
        {id: 'medical', label: 'Medical', price_eur_per_hour: 22},
      ],
    });
    // Phase 1 bug/quirk: add-ons are priced per-hour but added once to the
    // hourly RATE (then multiplied by duration). 86 + 25 + 22 = 133 /hr.
    expect(p.rate_eur_per_hour).toBe(133);
    expect(p.total_eur).toBe(133 * 4);
  });

  it('applies the 1.2× peak surcharge for 17-20 UTC pickups', () => {
    const peakArgs = {...baseArgs, pickupTime: new Date('2026-05-01T18:00:00Z')};
    const p = svc.calculate(peakArgs);
    // 86 * 1.2 = 103.2
    expect(p.rate_eur_per_hour).toBeCloseTo(86 * 1.2, 2);
  });

  it('produces a breakdown whose base line matches the baseline rate', () => {
    const p = svc.calculate(baseArgs);
    const baseLine = p.breakdown.find(b => b.label.startsWith('Base rate'));
    expect(baseLine?.amount_eur).toBe(86);
  });
});
