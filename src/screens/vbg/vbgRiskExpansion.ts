/**
 * B-410 — which risk categories are expanded in the GeoRisk assessment.
 *
 * This was a single-select accordion (`expandedRisk: string | null`), so
 * opening "Robbery / Theft" silently collapsed "Violent Crime". A risk
 * assessment exists to be compared across categories, so any number of cards
 * may be open at once (founder, 2026-08-09).
 *
 * Pure + immutable so the screen's decision is testable without a render —
 * same pattern as `vbgGeoRiskCoords.ts`.
 */

/** Toggle one category. Returns a NEW set (never mutates `prev`). */
export function toggleExpanded(prev: ReadonlySet<string>, name: string): Set<string> {
  const next = new Set(prev);
  // delete() reports whether it removed anything, so this is one lookup.
  if (!next.delete(name)) {next.add(name);}
  return next;
}

/** Every category collapsed — a fresh analysis is a different area. */
export function collapseAll(): Set<string> {
  return new Set<string>();
}
