/**
 * Founder 2026-08-26 — live service-pricing overrides for the client mirrors.
 *
 * The two pricing mirrors (booking/pricing.ts, executive/executivePricing.ts)
 * are deliberately PURE — no RN, no zustand — so the node Jest project can
 * verify them against the server numbers. This module keeps that purity: it
 * is a plain injectable value the store (servicePricingStore) hydrates from
 * GET /bookings/service-pricing, and every mirror computation reads through
 * `priceValue(key, fallback)` at CALL time.
 *
 * FAIL-OPEN: no hydration (offline, old server, cold boot) means every
 * lookup returns its compiled fallback — the mirrors then produce exactly
 * the numbers they have always produced. Server-side the charge does the
 * same fallback dance (PricingService.config), so display and charge agree
 * in every state.
 */

export type ServicePricingOverrides = Readonly<Record<string, number>>;

let current: ServicePricingOverrides = {};

/** Replace the whole override set (the store owns the lifecycle). */
export function setServicePricingOverrides(v: ServicePricingOverrides | null | undefined): void {
  current = v ?? {};
}

/** The live value for a pricing key, or the compiled fallback. */
export function priceValue(key: string, fallback: number): number {
  const v = current[key];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}
