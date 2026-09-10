/**
 * Founder 2026-08-26 — ops-editable service pricing + the eur_per_bc root.
 * Pins the three properties that make this SAFE to hand to ops:
 *   1. FAIL-OPEN — no db / broken db charges the compiled defaults, never 0.
 *   2. LIVE OVERLAY — a table row changes the charged formula (per-CPO rate,
 *      factors, add-on prices), and the 60 s cache honours a fresh read.
 *   3. THE ROOT — total_bc = total_eur / eur_per_bc; at the shipped 1.0 the
 *      numbers are byte-identical to the historic 1:1 charge.
 */
import {
  PricingService, DEFAULT_SERVICE_PRICING, resolveExecAddOns,
} from './pricing.service';
import type {DatabaseService} from '../database/database.service';

const input = (over: Record<string, unknown> = {}) => ({
  cpoCount: 1, vehicleCount: 1, driverOnly: false, durationHours: 4,
  pickupTime: new Date('2026-08-26T08:00:00Z'), addOns: [], regionCode: 'AE',
  ...over,
}) as never;

describe('service pricing config', () => {
  it('no db at all -> compiled defaults, identical numbers to the old engine', async () => {
    const svc = new PricingService();
    const cfg = await svc.config();
    expect(cfg).toEqual(DEFAULT_SERVICE_PRICING);
    const r = svc.calculate(input(), cfg);
    expect(r.rate_eur_per_hour).toBe(86);
    expect(r.total_eur).toBe(344);
    expect(r.total_bc).toBe(344);           // eur_per_bc 1.0 -> 1:1
  });

  it('a broken table FAILS OPEN to defaults (never a zero charge)', async () => {
    const db = {q: jest.fn().mockRejectedValue(new Error('relation missing'))};
    const svc = new PricingService(db as unknown as DatabaseService);
    const cfg = await svc.config();
    expect(cfg).toEqual(DEFAULT_SERVICE_PRICING);
  });

  it('table rows OVERLAY the formula — per-CPO rate and the exec add-on price', async () => {
    const db = {q: jest.fn().mockResolvedValue([
      {key: 'exec_cpo_rate_bc', value: '100'},
      {key: 'addon_female_cpo_bc', value: '150'},
    ])};
    const svc = new PricingService(db as unknown as DatabaseService);
    const cfg = await svc.config();
    const addOns = resolveExecAddOns(['female_cpo'], cfg)!;
    expect(addOns[0].price_eur_per_hour).toBe(150);
    const r = svc.calculate(input({service: 'executive_protection', cpoCount: 2, vehicleCount: 0, durationHours: 3, addOns}), cfg);
    // 2 x 100 + 150 = 350/hr x 3h
    expect(r.rate_eur_per_hour).toBe(350);
    expect(r.total_eur).toBe(1050);
  });

  it('a nonsense value (0 / NaN) in the table is IGNORED, not charged', async () => {
    const db = {q: jest.fn().mockResolvedValue([
      {key: 'transfer_base_rate_bc', value: '0'},
      {key: 'peak_multiplier', value: 'garbage'},
    ])};
    const svc = new PricingService(db as unknown as DatabaseService);
    const cfg = await svc.config();
    expect(cfg.transfer_base_rate_bc).toBe(86);
    expect(cfg.peak_multiplier).toBe(1.2);
  });

  it('eur_per_bc is THE ROOT: total_bc divides by it, EUR totals untouched', async () => {
    const db = {q: jest.fn().mockResolvedValue([{key: 'eur_per_bc', value: '2'}])};
    const svc = new PricingService(db as unknown as DatabaseService);
    const cfg = await svc.config();
    const r = svc.calculate(input(), cfg);
    expect(r.total_eur).toBe(344);          // EUR stays the source of truth
    expect(r.total_bc).toBe(172);           // 1 BC = 2 EUR -> half the credits
  });

  it('caches for 60s — one query serves a burst of quotes', async () => {
    const db = {q: jest.fn().mockResolvedValue([])};
    const svc = new PricingService(db as unknown as DatabaseService);
    await svc.config();
    await svc.config();
    await svc.config();
    expect(db.q).toHaveBeenCalledTimes(1);
  });

  it('driver-only factor comes from the config (the -35% is not hardcoded)', async () => {
    const db = {q: jest.fn().mockResolvedValue([{key: 'transfer_driver_only_factor', value: '0.5'}])};
    const svc = new PricingService(db as unknown as DatabaseService);
    const cfg = await svc.config();
    const r = svc.calculate(input({driverOnly: true, vehicleCount: 0}), cfg);
    expect(r.rate_eur_per_hour).toBe(43);   // 86 x 0.5
    expect(r.breakdown.some(l => l.label.includes('50%'))).toBe(true);
  });
});
