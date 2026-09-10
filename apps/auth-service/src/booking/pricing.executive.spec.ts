import {PricingService, resolveExecAddOns, EXEC_ADDON_PRICING} from './pricing.service';

/**
 * Executive Protection — per-unit fixed-block pricing.
 *
 * rate/hr = cpo × 86 + vehicles × 30 (+20 driver-only) + Σ add-ons; total =
 * rate × duration; FLAT (no peak multiplier — the review-screen quote must
 * equal the escrow hold to the credit). Client mirror:
 * src/screens/executive/executivePricing.ts — keep the numbers in lockstep.
 */
describe('PricingService — Executive Protection (service "executive_protection")', () => {
  const svc = new PricingService();

  const baseArgs = {
    service: 'executive_protection',
    cpoCount: 1,
    vehicleCount: 0,
    driverOnly: false,
    durationHours: 3,
    // 17:05 local/UTC — INSIDE the Lite peak window, proving executive is flat.
    pickupTime: new Date('2026-05-20T17:05:00Z'),
    addOns: [],
  };

  it('prices the mock exactly: 1 CPO · 3 h = 86/hr → 258 total, even at peak time', () => {
    const p = svc.calculate(baseArgs);
    expect(p.rate_eur_per_hour).toBe(86);
    expect(p.total_eur).toBe(258);
  });

  it('charges per CPO (not the Lite +25% increments)', () => {
    const p = svc.calculate({...baseArgs, cpoCount: 3});
    expect(p.rate_eur_per_hour).toBe(3 * 86);
  });

  it('charges 30/hr per vehicle & driver', () => {
    const p = svc.calculate({...baseArgs, vehicleCount: 2, durationHours: 6});
    expect(p.rate_eur_per_hour).toBe(86 + 60);
    expect(p.total_eur).toBe((86 + 60) * 6);
  });

  it('driver-only adds the 20/hr Bravo-driver fee and prices no vehicles', () => {
    const p = svc.calculate({...baseArgs, driverOnly: true, vehicleCount: 0});
    expect(p.rate_eur_per_hour).toBe(86 + 20);
  });

  it('driver-only NEVER charges vehicles, even when a raw caller sends both', () => {
    // create() normalizes vehicle_count to 0 under driver-only, but estimate()
    // and direct callers reach the formula unnormalized — the formula itself
    // must enforce it (client mirror executivePricing.ts does the same).
    const p = svc.calculate({...baseArgs, driverOnly: true, vehicleCount: 2});
    expect(p.rate_eur_per_hour).toBe(86 + 20);
    expect(p.breakdown.some(b => b.label.includes('Vehicle'))).toBe(false);
  });

  it('adds the fixed executive add-on rates (display == charge)', () => {
    const addOns = resolveExecAddOns(['female_cpo', 'comms']);
    expect(addOns).not.toBeNull();
    const p = svc.calculate({...baseArgs, addOns: addOns!});
    expect(p.rate_eur_per_hour).toBe(86 + 120 + 75);
  });

  it('the full stack: 2 CPO + 1 vehicle + medical, 12 h', () => {
    const addOns = resolveExecAddOns(['medical'])!;
    const p = svc.calculate({...baseArgs, cpoCount: 2, vehicleCount: 1, durationHours: 12, addOns});
    const rate = 2 * 86 + 30 + 90;
    expect(p.rate_eur_per_hour).toBe(rate);
    expect(p.total_eur).toBe(rate * 12);
  });

  it('emits per-hour breakdown lines with distinct labels (invoice binds on them)', () => {
    const addOns = resolveExecAddOns(['female_cpo', 'recon', 'medical', 'comms'])!;
    const p = svc.calculate({...baseArgs, cpoCount: 2, vehicleCount: 1, driverOnly: false, addOns});
    const labels = p.breakdown.map(b => b.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain('2 × Close Protection Officer');
    expect(labels).toContain('1 × Vehicle & Driver');
  });

  it('never applies the Lite peak surcharge', () => {
    const peak = svc.calculate({...baseArgs, pickupTime: new Date('2026-05-20T18:00:00Z')});
    const offPeak = svc.calculate({...baseArgs, pickupTime: new Date('2026-05-20T09:00:00Z')});
    expect(peak.rate_eur_per_hour).toBe(offPeak.rate_eur_per_hour);
  });

  it('resolveExecAddOns rejects unknown ids (null → 400, never a silent underprice)', () => {
    expect(resolveExecAddOns(['female_cpo', 'jetpack'])).toBeNull();
    expect(resolveExecAddOns([])).toEqual([]);
  });

  it('the catalogue is exactly the four advertised add-ons', () => {
    expect(EXEC_ADDON_PRICING.map(a => [a.id, a.price_eur_per_hour])).toEqual([
      ['female_cpo', 120], ['recon', 100], ['medical', 90], ['comms', 75],
    ]);
  });

  it('does not disturb the Lite formula (same input minus service)', () => {
    const {service: _s, ...liteArgs} = baseArgs;
    const p = svc.calculate({...liteArgs, vehicleCount: 1});
    // Lite at 17:05 = base 86 × 1.2 peak.
    expect(p.rate_eur_per_hour).toBeCloseTo(86 * 1.2, 2);
  });
});
