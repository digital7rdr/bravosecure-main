/**
 * Client-side pricing preview for Lite bookings.
 *
 * Mirrors the server authority (apps/auth-service/src/booking/pricing.service.ts):
 * base rate EUR 86/hr (1 CPO · 1 Vehicle · 1 Driver), +25% of base per extra
 * CPO/vehicle, 0.65× for driver-only, add-ons summed per hour. BC is 1:1 with
 * EUR in Phase 1, so the rate is shown directly in Bravo Credits.
 *
 * This is a PREVIEW only — the authoritative total is computed server-side at
 * estimate/confirm time. Kept free of RN / zustand imports so it can be unit
 * tested without mounting a screen (mirrors creditMath.ts).
 */

// Authoritative base rate, in BC (== EUR in Phase 1). Matches BASE_RATE_EUR
// on the server. NOTE: 350 is the AED display figure, not the BC base.
export const BASE_RATE_BC = 86;

// Live ops-editable overlays (founder 2026-08-26) — compiled constants above
// stay the fail-open fallbacks; every computation reads at CALL time.
import {priceValue} from './servicePricingOverrides';
export const liveBaseRateBc = () => priceValue('transfer_base_rate_bc', BASE_RATE_BC);
export const liveAedPerBc = () =>
  priceValue('base_rate_aed', 350) / priceValue('transfer_base_rate_bc', BASE_RATE_BC);

/**
 * Canonical AED ⇄ BC ratio — mirrors the server's EUR_TO_AED = 350/86
 * (pricing.service.ts). Used to render legacy AED-denominated figures
 * (e.g. agents.rate_aed_per_hour) in BC without inventing an FX rate.
 */
export const AED_PER_BC = 350 / 86;
export const bcFromAed = (aed: number): number => Math.round(aed / liveAedPerBc());

/** Extra CPO / vehicle surcharge: 25% of base per unit beyond the baseline 1. */
export const EXTRA_UNIT_FACTOR = 0.25;

/** Driver-only (client provides vehicle) multiplier. */
export const DRIVER_ONLY_FACTOR = 0.65;

/** A standard 5-seat vehicle seats CPO + driver + 3 passengers. */
export const PASSENGERS_PER_VEHICLE = 3;

/** Hard ceiling on CPOs per booking (Control Room approval required above 1). */
export const MAX_CPOS = 4;

/**
 * Occupants a single vehicle holds beyond the driver — i.e. passengers + CPOs
 * that must share one car. A 5-seat vehicle: 1 driver + 4 others.
 */
export const SEATS_PER_VEHICLE_EX_DRIVER = 4;

/**
 * Max CPOs that fit in the client's own vehicle alongside the passengers
 * (driver-only mode — Bravo adds no vehicle, so everyone shares the client car).
 * At least 1 (you can always book one CPO), never above the global MAX_CPOS.
 * With Bravo vehicles this limit does NOT apply — CPOs ride in Bravo cars.
 */
export function maxCposForClientVehicle(passengers: number): number {
  const free = SEATS_PER_VEHICLE_EX_DRIVER - Math.max(0, passengers);
  return Math.min(MAX_CPOS, Math.max(1, free));
}

/**
 * Minimum vehicles required to carry `passengers` (1 vehicle per 3 pax).
 * Always at least 1 — the baseline package includes one vehicle.
 */
export function vehiclesForPassengers(passengers: number): number {
  return Math.max(1, Math.ceil(Math.max(0, passengers) / PASSENGERS_PER_VEHICLE));
}

export interface RateInput {
  cpoCount: number;
  vehicleCount: number;
  driverOnly: boolean;
  /** Sum of selected add-on per-hour prices, in BC. */
  addOnsBcPerHour: number;
}

/**
 * Hourly rate in BC for the given team composition. Rounded to a whole credit
 * to match how the rate bar is displayed. (Peak surcharge is server-only and
 * intentionally omitted from this preview.)
 */
export function rateBcPerHour({cpoCount, vehicleCount, driverOnly, addOnsBcPerHour}: RateInput): number {
  // Driver-only (client vehicle): no Bravo vehicle, so no extra-vehicle
  // surcharge — matches the server normalizing vehicle_count to 0.
  const effectiveVehicles = driverOnly ? 0 : vehicleCount;
  const base = liveBaseRateBc();
  const extraFactor = priceValue('transfer_extra_unit_factor', EXTRA_UNIT_FACTOR);
  let rate = base;
  rate += Math.max(0, cpoCount - 1) * base * extraFactor;
  rate += Math.max(0, effectiveVehicles - 1) * base * extraFactor;
  if (driverOnly) {rate *= priceValue('transfer_driver_only_factor', DRIVER_ONLY_FACTOR);}
  rate += addOnsBcPerHour;
  return Math.round(rate);
}
