/**
 * Executive Protection — client pricing mirror.
 *
 * Server authority: apps/auth-service/src/booking/pricing.service.ts
 * (calculateExecutive + EXEC_* constants). This file mirrors it for instant UI
 * feedback; the authoritative number is always the /bookings/estimate reply
 * (service: 'executive_protection'). BC ≙ EUR 1:1 in Phase 1.
 *
 * rate/hr = cpo_count × 86  +  vehicle_count × 30
 *           (+ 20 when a Bravo driver runs the client's vehicle)
 *           + Σ selected add-ons          — FLAT, no peak multiplier.
 * total   = rate/hr × duration_hours.
 *
 * Kept free of RN/Expo imports so the node Jest project can verify the mirror
 * against the server numbers (same rule as src/screens/booking/pricing.ts).
 */

export const EXEC_CPO_RATE_BC = 86;

// Live ops-editable overlays (founder 2026-08-26) — see servicePricingOverrides.
import {priceValue} from '@screens/booking/servicePricingOverrides';
const ADDON_KEY: Record<string, string> = {
  female_cpo: 'addon_female_cpo_bc', recon: 'addon_recon_bc',
  medical: 'addon_medical_bc', comms: 'addon_comms_bc',
};
export const liveAddOnBcPerHour = (a: {id: string; bcPerHour: number}): number =>
  priceValue(ADDON_KEY[a.id] ?? a.id, a.bcPerHour);
export const EXEC_VEHICLE_RATE_BC = 30;
export const EXEC_DRIVER_ONLY_RATE_BC = 20;

export interface ExecAddOnDef {
  id: string;
  label: string;
  desc: string;
  icon: string;
  bcPerHour: number;
}

/** Mirrors EXEC_ADDON_PRICING server-side — display == charge. */
export const EXEC_ADDONS: ReadonlyArray<ExecAddOnDef> = [
  {id: 'female_cpo', label: 'Female CPO Team',               desc: 'All-female close-protection detail', icon: 'account-supervisor', bcPerHour: 120},
  {id: 'recon',      label: 'Advance Assessment Team',       desc: 'Site survey ahead of your arrival',  icon: 'radar',              bcPerHour: 100},
  {id: 'medical',    label: 'Medical Support',               desc: 'Trained medic embedded in the team', icon: 'medical-bag',        bcPerHour: 90},
  {id: 'comms',      label: 'Secure Communications Support', desc: 'Encrypted comms net for the detail', icon: 'radio-handheld',     bcPerHour: 75},
];

export function execAddOnsBcPerHour(selectedIds: string[]): number {
  return EXEC_ADDONS.filter(a => selectedIds.includes(a.id))
    .reduce((sum, a) => sum + liveAddOnBcPerHour(a), 0);
}

export interface ExecRateInput {
  cpoCount: number;
  vehicleCount: number;
  driverOnly: boolean;
  addOnsBcPerHour: number;
}

/** Per-hour rate — mirrors PricingService.calculateExecutive exactly. */
export function execRateBcPerHour(input: ExecRateInput): number {
  const cpos = Math.max(1, input.cpoCount);
  const vehicles = input.driverOnly ? 0 : Math.max(0, input.vehicleCount);
  let rate = cpos * priceValue('exec_cpo_rate_bc', EXEC_CPO_RATE_BC)
    + vehicles * priceValue('exec_vehicle_rate_bc', EXEC_VEHICLE_RATE_BC);
  if (input.driverOnly) {rate += priceValue('exec_driver_only_rate_bc', EXEC_DRIVER_ONLY_RATE_BC);}
  return +(rate + input.addOnsBcPerHour).toFixed(2);
}

export function execTotalBc(ratePerHour: number, durationHours: number): number {
  return +(ratePerHour * Math.max(1, durationHours)).toFixed(2);
}
