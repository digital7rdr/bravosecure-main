/**
 * Pure credit-math helpers for the top-up paywall.
 *
 * Extracted so the logic can be exercised in Jest without mounting the
 * React Native screen. Keep this file free of RN / zustand imports.
 */

export interface PackageDef {
  key: string;
  credits: number;
  label: string;
  sub: string;
  recommended: boolean;
  badge: {label: string; color: string} | null;
  /** USD charged to the card — equals `credits` under the 1:1 peg. */
  priceUsd: number;
}

// Why: product rule (2026-07-05, CREDITS_BC_AUDIT F-02) — 1 unit of fiat
// = 1 BC. Mirrors the server peg in WalletService.computeCreditsForFiat;
// a contract test in __tests__ guards the mirror.
export const BC_PER_USD = 1;

export const bcToUsd = (bc: number): number => bc / BC_PER_USD;

export function shortfallFor(required: number, currentBalance: number): number {
  return Math.max(0, required - currentBalance);
}

export function buildPackages(required: number): PackageDef[] {
  // Under the 1:1 peg the charge always equals the credits — discount tiers
  // were removed (F-08): the server derives credits from the charged amount,
  // so a client-side discount would under-award what the tile promises.
  const base = (credits: number) => ({credits, priceUsd: credits});
  return [
    {key: '500',  ...base(500),  label: '500',   sub: 'Top-up only',   recommended: false, badge: null},
    {key: '1000', ...base(1000), label: '1,000', sub: 'Top-up only',  recommended: false, badge: null},
    {key: '1500', ...base(1500), label: '1,500', sub: `Covers your ${required.toLocaleString()} BC booking`, recommended: true, badge: {label: 'Covers Booking', color: '#22c55e'}},
    {key: '2500', ...base(2500), label: '2,500', sub: 'Best for frequent bookings', recommended: false, badge: {label: 'Best Value', color: '#2563EB'}},
  ];
}

/** Pick the smallest package that lands >= 10% above the shortfall. */
export function recommendPackageKey(packages: PackageDef[], shortfall: number): string {
  const covers = packages.find(p => p.credits >= shortfall * 1.1);
  return (covers ?? packages[packages.length - 1]).key;
}

export function afterBalanceFor(currentBalance: number, pkgCredits: number): number {
  return currentBalance + pkgCredits;
}
