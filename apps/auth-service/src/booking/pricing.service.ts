import {Injectable, Logger, Optional} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {regionUtcOffsetHours} from '../common/regions';

/**
 * Pricing calculator for Lite bookings.
 *
 * Base rate: 1 CPO + 1 Vehicle + 1 Driver = EUR 86/hr (≈ AED 350/hr).
 * Extra CPOs / vehicles above baseline: +25% of base per additional unit.
 * Driver-only (client vehicle): 0.65× base.
 * Add-ons: per-hour EUR from `lite_booking_add_ons` table (sum).
 * Peak-hour multiplier (17:00–20:00 local): 1.2×.
 * EUR → AED: fixed conversion (350 / 86 ≈ 4.07).
 *
 * EUR is source of truth; AED is display only.
 *
 * Founder 2026-08-26 — every number above is now OPS-EDITABLE via the
 * `service_pricing` table ("prices for 1x CPO, vehicle, female, price per
 * hour… everywhere the price applicable"). The compiled values below stay as
 * the FAIL-OPEN defaults: an unreachable table charges exactly what the app
 * charged before this change — never zero, never a surprise. `config()` is
 * read at CHARGE TIME (60 s cache), so an edit applies to the next quote the
 * way the M1A subscription prices already do.
 */

export interface AddOnPricing {
  id: string;
  label: string;
  price_eur_per_hour: number;
}

export interface ServicePricingConfig {
  /** THE ROOT (founder 2026-08-26): 1 BC = eur_per_bc EUR. Booking charges
   *  divide EUR totals by this; at the shipped 1.0 the numbers are
   *  byte-identical to the historic 1:1 behaviour. The WALLET top-up peg
   *  (1 fiat = 1 BC, audit F-01/F-02) is deliberately NOT driven by this
   *  key — changing what a top-up buys is its own decision. */
  eur_per_bc: number;
  transfer_base_rate_bc: number;
  transfer_extra_unit_factor: number;
  transfer_driver_only_factor: number;
  peak_multiplier: number;
  base_rate_aed: number;
  exec_cpo_rate_bc: number;
  exec_vehicle_rate_bc: number;
  exec_driver_only_rate_bc: number;
  addon_female_cpo_bc: number;
  addon_recon_bc: number;
  addon_medical_bc: number;
  addon_comms_bc: number;
}

/** The shipped numbers — seeds of service_pricing and the fail-open floor. */
export const DEFAULT_SERVICE_PRICING: ServicePricingConfig = {
  eur_per_bc: 1.0,
  transfer_base_rate_bc: 86,
  transfer_extra_unit_factor: 0.25,
  transfer_driver_only_factor: 0.65,
  peak_multiplier: 1.2,
  base_rate_aed: 350,
  exec_cpo_rate_bc: 86,
  exec_vehicle_rate_bc: 30,
  exec_driver_only_rate_bc: 20,
  addon_female_cpo_bc: 120,
  addon_recon_bc: 100,
  addon_medical_bc: 90,
  addon_comms_bc: 75,
};

export interface PricingInput {
  cpoCount: number;
  vehicleCount: number;
  driverOnly: boolean;
  durationHours: number;
  pickupTime: Date;
  addOns: AddOnPricing[];
  /** LM-M2 — region the pickup happens in; drives the LOCAL peak-hour window.
   *  Optional so legacy callers keep compiling (missing region = UTC, the old
   *  behaviour). */
  regionCode?: string;
  /** Executive Protection — 'executive_protection' switches to the per-unit fixed-block formula. */
  service?: string;
}

export interface PricingBreakdownLine {
  label: string;
  amount_eur: number;
}

export interface PricingResult {
  /** What escrow actually holds — EUR total / eur_per_bc, rounded. */
  total_bc: number;
  rate_eur_per_hour: number;
  rate_aed_per_hour: number;
  total_eur: number;
  total_aed: number;
  breakdown: PricingBreakdownLine[];
}

const BASE_RATE_EUR = DEFAULT_SERVICE_PRICING.transfer_base_rate_bc;

// ─── Executive Protection (service 'executive_protection') — per-unit fixed-block pricing ───────────────
// rate/hr = cpo_count × CPO_RATE + vehicle_count × VEHICLE_RATE
//           (+ DRIVER_ONLY_RATE when a Bravo driver runs the client's vehicle)
//           + Σ add-ons; total = rate × duration. FLAT — no peak multiplier:
// the quote the client consents to on the review screen is exactly what
// escrow holds (mock: 1 CPO · 3 h = 86 × 3 = 258 BC even at 17:05).
export const EXEC_CPO_RATE_EUR = DEFAULT_SERVICE_PRICING.exec_cpo_rate_bc;
/** Vehicle + dedicated driver. ≈ the vehicle share of the Lite base
 *  (86 − 0.65×86 ≈ 30) so the two products price consistently. */
export const EXEC_VEHICLE_RATE_EUR = DEFAULT_SERVICE_PRICING.exec_vehicle_rate_bc;
/** Bravo driver operating the client's own vehicle (driver-only toggle). */
export const EXEC_DRIVER_ONLY_RATE_EUR = DEFAULT_SERVICE_PRICING.exec_driver_only_rate_bc;

/** Executive add-on IDs → their service_pricing key + fixed label. The label
 *  set is the product catalogue; only the NUMBERS are ops-editable. */
const EXEC_ADDON_DEFS: ReadonlyArray<{id: string; label: string; cfgKey: keyof ServicePricingConfig}> = [
  {id: 'female_cpo', label: 'Female CPO Team',               cfgKey: 'addon_female_cpo_bc'},
  {id: 'recon',      label: 'Advance Assessment Team',       cfgKey: 'addon_recon_bc'},
  {id: 'medical',    label: 'Medical Support',               cfgKey: 'addon_medical_bc'},
  {id: 'comms',      label: 'Secure Communications Support', cfgKey: 'addon_comms_bc'},
];

/** executive add-on catalogue — display == charge (client mirrors these). */
export const EXEC_ADDON_PRICING: ReadonlyArray<AddOnPricing> = EXEC_ADDON_DEFS.map(d => ({
  id: d.id, label: d.label, price_eur_per_hour: DEFAULT_SERVICE_PRICING[d.cfgKey],
}));

/** Resolve executive add-on ids against the catalogue at the LIVE prices.
 *  Unknown id = null so the caller can 400 instead of silently underpricing. */
export function resolveExecAddOns(
  ids: string[],
  cfg: ServicePricingConfig = DEFAULT_SERVICE_PRICING,
): AddOnPricing[] | null {
  const out: AddOnPricing[] = [];
  for (const id of ids) {
    const found = EXEC_ADDON_DEFS.find(a => a.id === id);
    if (!found) {return null;}
    out.push({id: found.id, label: found.label, price_eur_per_hour: cfg[found.cfgKey]});
  }
  return out;
}

const CONFIG_TTL_MS = 60_000;

@Injectable()
export class PricingService {
  private readonly log = new Logger(PricingService.name);
  private cfgCache: {at: number; cfg: ServicePricingConfig} | null = null;

  // @Optional: the calculator itself is pure, and a pile of specs construct it
  // bare (`new PricingService()`). No db → compiled defaults, same numbers as
  // before this change.
  constructor(@Optional() private readonly db?: DatabaseService) {}

  /**
   * The live pricing config — service_pricing overlaid on the compiled
   * defaults, cached 60 s, FAIL-OPEN on any error. Read at charge time by
   * booking.service so an ops edit prices the next quote.
   */
  async config(): Promise<ServicePricingConfig> {
    const now = Date.now();
    if (this.cfgCache && now - this.cfgCache.at < CONFIG_TTL_MS) {return this.cfgCache.cfg;}
    const cfg = {...DEFAULT_SERVICE_PRICING};
    if (this.db) {
      try {
        const rows = await this.db.q<{key: string; value: string}>(
          `SELECT key, value FROM service_pricing`,
        );
        for (const r of rows) {
          const v = Number(r.value);
          if (r.key in cfg && Number.isFinite(v) && v > 0) {
            (cfg as unknown as Record<string, number>)[r.key] = v;
          }
        }
      } catch (e) {
        this.log.warn(`service_pricing read failed, using defaults: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.cfgCache = {at: now, cfg};
    return cfg;
  }

  calculate(input: PricingInput, cfg: ServicePricingConfig = DEFAULT_SERVICE_PRICING): PricingResult {
    if (input.service === 'executive_protection') {return this.calculateExecutive(input, cfg);}
    const eurToAed = cfg.base_rate_aed / cfg.transfer_base_rate_bc;
    const breakdown: PricingBreakdownLine[] = [];
    let rate = cfg.transfer_base_rate_bc;
    breakdown.push({label: 'Base rate (1 CPO · 1 Vehicle · 1 Driver)', amount_eur: cfg.transfer_base_rate_bc});

    const extraCpos = Math.max(0, input.cpoCount - 1);
    if (extraCpos > 0) {
      const add = extraCpos * cfg.transfer_base_rate_bc * cfg.transfer_extra_unit_factor;
      rate += add;
      breakdown.push({label: `+${extraCpos} CPO`, amount_eur: +add.toFixed(2)});
    }

    const extraVehicles = Math.max(0, input.vehicleCount - 1);
    if (extraVehicles > 0) {
      const add = extraVehicles * cfg.transfer_base_rate_bc * cfg.transfer_extra_unit_factor;
      rate += add;
      breakdown.push({label: `+${extraVehicles} Vehicle`, amount_eur: +add.toFixed(2)});
    }

    if (input.driverOnly) {
      const before = rate;
      rate *= cfg.transfer_driver_only_factor;
      breakdown.push({
        label: `Driver-only discount (−${Math.round((1 - cfg.transfer_driver_only_factor) * 100)}%)`,
        amount_eur: +(rate - before).toFixed(2),
      });
    }

    for (const a of input.addOns) {
      rate += a.price_eur_per_hour;
      breakdown.push({label: a.label, amount_eur: a.price_eur_per_hour});
    }

    // Peak surcharge — LM-M2: 17:00–20:00 in the REGION's local wall clock (the
    // doc always said "local"; the old getUTCHours() fired the surcharge at the
    // wrong time in every non-UTC region, e.g. 21:00–24:00 Dubai time).
    const hour = (input.pickupTime.getUTCHours() + regionUtcOffsetHours(input.regionCode) + 24) % 24;
    let peakMultiplier = 1;
    if (hour >= 17 && hour < 20) {
      peakMultiplier = cfg.peak_multiplier;
      const surcharge = rate * (cfg.peak_multiplier - 1);
      breakdown.push({label: 'Peak surcharge (17–20)', amount_eur: +surcharge.toFixed(2)});
    }

    const rateEur = +(rate * peakMultiplier).toFixed(2);
    const durationHours = Math.max(1, input.durationHours);
    const totalEur = +(rateEur * durationHours).toFixed(2);

    return {
      total_bc: Math.round(totalEur / cfg.eur_per_bc),
      rate_eur_per_hour: rateEur,
      rate_aed_per_hour: +(rateEur * eurToAed).toFixed(2),
      total_eur: totalEur,
      total_aed: +(totalEur * eurToAed).toFixed(2),
      breakdown,
    };
  }

  /** Executive Protection — per-unit hourly pricing over a fixed 3–24 h block. */
  private calculateExecutive(input: PricingInput, cfg: ServicePricingConfig): PricingResult {
    const eurToAed = cfg.base_rate_aed / cfg.transfer_base_rate_bc;
    const breakdown: PricingBreakdownLine[] = [];

    const cpoAmt = input.cpoCount * cfg.exec_cpo_rate_bc;
    let rate = cpoAmt;
    breakdown.push({
      label: `${input.cpoCount} × Close Protection Officer`,
      amount_eur: +cpoAmt.toFixed(2),
    });

    // Driver-only means the client's own vehicle — never price Bravo vehicles,
    // even if a raw API caller sends both (create() normalizes; estimate()
    // and the client mirror rely on this being enforced HERE too).
    const vehicles = input.driverOnly ? 0 : input.vehicleCount;
    if (vehicles > 0) {
      const vehAmt = vehicles * cfg.exec_vehicle_rate_bc;
      rate += vehAmt;
      breakdown.push({
        label: `${vehicles} × Vehicle & Driver`,
        amount_eur: +vehAmt.toFixed(2),
      });
    }

    if (input.driverOnly) {
      rate += cfg.exec_driver_only_rate_bc;
      breakdown.push({
        label: 'Bravo driver (client vehicle)',
        amount_eur: cfg.exec_driver_only_rate_bc,
      });
    }

    for (const a of input.addOns) {
      rate += a.price_eur_per_hour;
      breakdown.push({label: a.label, amount_eur: a.price_eur_per_hour});
    }

    // Fixed-block product — flat hourly rate, deliberately NO peak multiplier.
    const rateEur = +rate.toFixed(2);
    const durationHours = Math.max(1, input.durationHours);
    const totalEur = +(rateEur * durationHours).toFixed(2);

    return {
      total_bc: Math.round(totalEur / cfg.eur_per_bc),
      rate_eur_per_hour: rateEur,
      rate_aed_per_hour: +(rateEur * eurToAed).toFixed(2),
      total_eur: totalEur,
      total_aed: +(totalEur * eurToAed).toFixed(2),
      breakdown,
    };
  }
}

// Compiled constant kept for legacy importers; identical to the default config.
void BASE_RATE_EUR;
