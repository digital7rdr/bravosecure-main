/**
 * Per-region currency formatting (BUILD_RUNBOOK Step 25). The four launch regions map to
 * distinct currencies — AE→AED, SA→SAR, BD→BDT, GB→GBP — so an amount must render in the
 * right currency for the booking's region, not a single hard-coded one. Uses
 * Intl.NumberFormat (available via Hermes Intl on Expo SDK 54) with a hand-rolled fallback
 * for any runtime missing the currency data.
 */
export type RegionCode = 'AE' | 'SA' | 'BD' | 'GB';

const REGION_CURRENCY: Record<string, {currency: string; locale: string}> = {
  AE: {currency: 'AED', locale: 'en-AE'},
  SA: {currency: 'SAR', locale: 'en-SA'},
  BD: {currency: 'BDT', locale: 'en-BD'},
  GB: {currency: 'GBP', locale: 'en-GB'},
};
const DEFAULT_REGION = REGION_CURRENCY.AE;

/** ISO-4217 code for a region (defaults to AED for an unknown/blank region). */
export function currencyForRegion(region?: string | null): string {
  return (REGION_CURRENCY[(region ?? '').toUpperCase()] ?? DEFAULT_REGION).currency;
}

/**
 * Format an amount in Bravo Credits. The region/locale params are kept for signature
 * compatibility with the old fiat formatter but no longer pick a currency unit.
 */
// Why: 1 fiat unit = 1 BC (Phase-1 peg) — amounts render as Bravo Credits, never regional fiat.
export function formatCurrency(amount: number, _region?: string | null, _localeOverride?: string): string {
  return `${Math.round(amount).toLocaleString('en-US')} BC`;
}
