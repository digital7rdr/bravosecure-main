import {useAuthStore} from '@store/authStore';

/**
 * Channels vs2 item 4 — "my shifts" and "my reports" are CROSS-ORG, and say so.
 *
 * ── THE DECISION THIS IMPLEMENTS (founder, 2026-08-12) ───────────────────────
 *
 * Four screens show a person their OWN records: My Attendance, today's shift,
 * My Incidents, and the clock-out button. Every other list in the product is
 * scoped to the organisation being viewed, and so is every write — but these
 * four filter on the person alone, so once somebody belongs to two companies
 * they see both companies' rows under whichever company's branding they happen
 * to be standing in.
 *
 * Scoping them was the tidy answer and it was rejected, for one reason: the
 * workspace context is NOT persisted. It is gone after every restart, every
 * drawer entry, and everywhere in the officer shell (which has no hub at all).
 * A list scoped against a context that is usually absent silently becomes "some
 * of my shifts" — and a missing attendance record is a far worse failure than a
 * confusing extra row.
 *
 * ⚠️ ONE CLAUSE OF THAT PREMISE HAS SINCE CHANGED (vs2 edge A1/A2, 2026-08-13).
 * A notification tap no longer leaves the context null: `adoptOrgContextFromWake`
 * sets it when a wake names an organisation the user belongs to. Two of the four
 * entry paths above are still context-free, so the DECISION stands — but do not
 * quote "every notification tap" as evidence for it again, and note that these
 * four self-reads are precisely the screens that stay unscoped while the writes
 * beside them (clock-in, incident submit) now follow an adopted context.
 *
 * So: keep the data, name the owner. Revisit when the context is persistent and
 * reliable on every entry path, at which point scoping becomes the better end
 * state. Full reasoning and the alternatives considered:
 * `docs/planning/SELF_READ_ORG_SCOPING_BRIEF.md`.
 *
 * ── WHY THIS IS ONE FUNCTION AND NOT FIVE INLINE CHECKS ──────────────────────
 *
 * Five screens render these rows. Five copies of "should I show a company name"
 * is this repo's most common bug shape — one behaviour, N copies, and copy N+1
 * drifts. A unit test cannot see the fifth copy; there is only ever one here.
 */

/**
 * How many organisations this person can hold records in.
 *
 * `workspaces` covers memberships and an owned workspace. `org` covers the
 * agency side, which never appears in `workspaces` — an agency roster is not an
 * enterable workspace tile — and is exactly the other half of the consultant:
 * an officer at an agency who is also an employee of a company.
 */
function orgCount(user: {
  id?: string;
  workspaces?: ReadonlyArray<{org_id: string}>;
  org?: {id: string} | null;
  managed_org?: {id: string} | null;
  owns_agency?: boolean;
} | null | undefined): number {
  if (!user) {return 0;}
  const ids = new Set<string>();
  // Workspace memberships and an owned workspace.
  for (const w of user.workspaces ?? []) {ids.add(w.org_id);}
  // The discriminator's PRIMARY org — one arm of a four-way COALESCE, so it
  // names at most one thing and is often the agency side.
  if (user.org?.id) {ids.add(user.org.id);}
  /**
   * …and the two agency facts `workspaces` structurally cannot carry.
   *
   * `WORKSPACE_AFFILIATIONS_SQL` INNER JOINs `org_workspaces`, so an agency
   * membership is excluded by construction — correct for the hub (an agency
   * roster is not an enterable tile) and wrong for counting. Without these two,
   * a manager of two agencies, or a company agent who joined someone's
   * workspace, both counted as ONE organisation and saw no labels — the B-417
   * mistake of inferring an agency identity from a proxy instead of the fact
   * that exists for it.
   *
   * `owns_agency` means the caller's own user id IS their org, the convention
   * used everywhere in this codebase.
   */
  if (user.owns_agency === true && user.id) {ids.add(user.id);}
  if (user.managed_org?.id) {ids.add(user.managed_org.id);}
  return ids.size;
}

/**
 * Should a cross-org list label its rows?
 *
 * ONLY when the person actually belongs to more than one organisation. For the
 * overwhelming majority — one employer, one company — a repeated company name
 * on every row is pure noise, and noise on a list people read daily is a real
 * cost. The label has to earn its place by disambiguating something.
 */
export function useShowOrgLabels(): boolean {
  return useAuthStore(st => orgCount(st.user) > 1);
}

/**
 * The label for one row, or null when it should not be shown.
 *
 * Null (not an empty string) for the single-org case and for a row an older
 * server sent without a name, so callers render nothing rather than an empty
 * chip with padding around it.
 */
export function orgLabelFor(
  row: {org_name?: string | null} | null | undefined,
  show: boolean,
): string | null {
  if (!show) {return null;}
  const name = row?.org_name?.trim();
  return name ? name : null;
}

/**
 * The clock-out confirmation line — always shown, single-org or not.
 *
 * Deliberately NOT gated on `useShowOrgLabels`. Ending a shift is a state
 * change, and the database permits only ONE open session per person across all
 * organisations, so from inside Acme this button can legitimately close a
 * Meridian shift. One body, one shift — the behaviour is right, but nothing on
 * screen said which shift was ending. Naming it costs a string and removes the
 * whole ambiguity, which is why it is unconditional where the list labels are
 * not.
 */
export function endShiftLabel(shift: {
  org_name?: string | null;
  site_label?: string | null;
} | null | undefined): string {
  const parts = [shift?.org_name?.trim(), shift?.site_label?.trim()].filter(Boolean);
  if (!parts.length) {return 'End shift';}
  /**
   * Bounded. The button is a fixed 56dp row with no `numberOfLines`, and both
   * halves are free text — a workspace name has only a not-blank CHECK and
   * `site_label` is bare TEXT. "End shift — Meridian Protective · Gate B" is
   * already wider than a 360dp screen affords at 16px bold, before font
   * scaling. Truncate here rather than at the one call site, so a second
   * caller cannot reintroduce the overflow.
   */
  const detail = parts.join(' · ');
  const clipped = detail.length > 28 ? `${detail.slice(0, 27).trimEnd()}…` : detail;
  return `End shift — ${clipped}`;
}
