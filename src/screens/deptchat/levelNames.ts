/**
 * PDF §13 checklist line 9 — "Admins can choose the names of levels."
 *
 * ONE function decides what a hierarchy tier is called. It exists because the
 * vocabulary was previously written out in FOUR places that had already drifted
 * from each other:
 *
 *   - `ManageChannelsScreen`  `['Enterprise','Main','Sub','Sub-sub']`
 *   - `ChannelEditorScreen`   the same array, inline, for the "becomes …" hint
 *   - `DepartmentChannelsScreen` `'LEVEL 1 — ENTERPRISE'` … (upper-cased, and
 *     off by one against the other two: its `level` keys are 0-based)
 *   - the `Ln` pill in `ChannelTree`, which says "L2" while the row beside it
 *     said "Main"
 *
 * Four copies of one product decision is this repo's most-shipped defect shape,
 * and here it was already visibly wrong on screen. `levelNameSingleSource`
 * bans a fifth.
 *
 * ── INDEXING: DISPLAY TIER, 1-BASED ──────────────────────────────────────
 *
 * `nameForTier(1)` is what the UI calls L1. That is deliberately NOT the
 * `level` column, which is 0-based AND ambiguous across tenants: a legacy
 * workspace roots at level 1 and a `root: true` organisation at level 0, so the
 * same visual tier has two different stored values (see `buildChannelTree`'s
 * "TIER IS WALK DEPTH" note). Naming must follow what the user SEES, or two
 * organisations side by side would label the same row differently.
 *
 * Callers that only hold a stored `level` use `tierFromLevel` below and are
 * explicitly opting into that approximation.
 */

/** The built-in vocabulary. The fallback whenever an org has chosen nothing. */
export const DEFAULT_LEVEL_NAMES = ['Enterprise', 'Main', 'Sub', 'Sub-sub'] as const;

/** Display tiers are L1..L4, matching `organisationTree`'s MAX_TIER. */
export const MAX_NAMED_TIER = DEFAULT_LEVEL_NAMES.length;

/** Longest an admin-chosen tier name may be. Long enough for "Regional
 *  Operations", short enough that the subtitle it shares with a member count
 *  still fits at 320dp / fontScale 1.3. Enforced on BOTH sides. */
export const MAX_LEVEL_NAME = 24;

/**
 * The name for a display tier, given whatever the org has chosen.
 *
 * `chosen` is `org_workspace_settings.level_names`: empty means "use the
 * built-ins", and a SHORT or SPARSE array fills the remaining tiers from them —
 * so an admin may rename L2 alone. A blank string is treated as unset for the
 * same reason: the editor lets a field be cleared, and a cleared field means
 * "back to the default", not "an unnamed tier".
 *
 * Out-of-range clamps rather than returning undefined. A tier beyond MAX is
 * only reachable through masked ancestry, and an unlabelled row is worse than
 * a slightly-wrong one.
 */
export function nameForTier(tier: number, chosen?: readonly string[] | null): string {
  const clamped = Math.min(Math.max(Math.trunc(tier) || 1, 1), MAX_NAMED_TIER);
  const picked = chosen?.[clamped - 1]?.trim();
  return picked && picked.length > 0 ? picked : DEFAULT_LEVEL_NAMES[clamped - 1];
}

/**
 * A stored `level` read as a display tier.
 *
 * ⚠️ AN APPROXIMATION, and the only honest one available to a caller that has a
 * row but not a walk. `level` is 0-based and its ROOT value differs by tenant
 * (0 for a `root: true` organisation, 1 for every legacy workspace), so this
 * cannot be exact for both at once. It matches the pre-existing behaviour of
 * the screens that used `LEVEL_NOUN[level]` — i.e. it is not a regression — but
 * anything rendering a real tree should pass the walked tier from
 * `buildChannelTree` instead, which IS exact.
 */
export function tierFromLevel(level: number | null | undefined): number {
  return Math.min(Math.max((level ?? 1) + 1, 1), MAX_NAMED_TIER);
}

/**
 * Normalise what an admin typed, for sending to the server.
 *
 * Trims, drops trailing blanks so "renamed L1 only" stores `['Region']` rather
 * than `['Region','','','']`, and caps the length. Returning `[]` for an
 * all-blank input is what lets the editor's "clear everything" mean "go back to
 * the built-ins" without a separate reset action.
 */
export function normaliseLevelNames(input: readonly (string | null | undefined)[]): string[] {
  const trimmed = input
    .slice(0, MAX_NAMED_TIER)
    .map(v => (v ?? '').trim().slice(0, MAX_LEVEL_NAME));
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') {trimmed.pop();}
  return trimmed;
}
