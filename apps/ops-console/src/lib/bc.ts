/**
 * Canonical AED ⇄ BC conversion — mirrors auth-service pricing.service.ts
 * (BASE_RATE_AED 350 ≡ BASE_RATE_EUR 86, and BC == EUR under the 1:1 peg).
 * Used to render legacy AED-denominated figures (agents.rate_aed_per_hour)
 * in BC without inventing an FX rate.
 */
export const AED_PER_BC = 350 / 86;
export const bcFromAed = (aed: number): number => Math.round(aed / AED_PER_BC);

// Audit PAGE-19 — total BC for an AED/hr rate × hours, rounding ONCE at the
// end. Rounding the per-hour BC rate first (bcFromAed) then multiplying
// compounds the rounding error (~1.7% on typical values).
export const earningsBc = (aedPerHour: number, hours: number): number =>
  Math.round((aedPerHour / AED_PER_BC) * hours);
